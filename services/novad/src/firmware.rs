//! BIOS/firmware settings (FR-146, docs/23 §6, D4 of ADR-096). Off by default and never proactive:
//! reading changes nothing and is allowed whenever the `firmware` module is allowed for the device;
//! writing needs the Hub's `firmwareChanges` policy (`policy.json`, D3) AND a Hub-signed
//! authorization for exactly this request (`authz.rs`, D2), which the Hub issues only after the
//! owner approved the diff.
//!
//! Only the canonical settings of BM2 exist here (`wol`, `powerOnAfterPowerLoss`, `bootOrder`,
//! `virtualization`, `secureBoot`, `tpm`, `fanProfile`); everything else a BIOS has is invisible.
//! Backends sit behind [`FirmwareBackend`]:
//! - `SysfsFirmwareAttributes`: the Linux kernel's firmware-attributes class
//!   (`/sys/class/firmware-attributes/<driver>/attributes/<name>/{current_value, possible_values,
//!   type, display_name}`), with the drivers dell-wmi-sysman (Dell), thinklmi (Lenovo) and
//!   hp-bioscfg (HP). Writes go to `current_value`; with a BIOS admin password, the password is
//!   written to `authentication/Admin/current_password` first and cleared after.
//! - `EfiBootOrder`: generic UEFI, the boot order only, through `efibootmgr`.
//! - `FakeFirmware`: a JSON file, chosen only by the owner's `config.json` (tests, the E2E device).
//!
//! The platform comes from `/sys/class/dmi/id` (no dmidecode needed); ASUS and Supermicro boards,
//! other vendors without UEFI and other operating systems are refused with a reason, never guessed.
//! `fwupdmgr get-updates --json` (when installed, 10 s) lists firmware updates, read-only.
//!
//! Safety (docs/23 §6.3): a plan is a dry run with a diff and a snapshot of every allowlisted value
//! (`firmware/snapshots/<id>.json`, 0600, the last 20); apply writes only when the current values
//! still equal the snapshot, refuses security-degrading values (Secure Boot or TPM off) unless the
//! approved body says `allowSecurityDegrading: true`, and restores the snapshot at once when a
//! write fails midway. With `reboot: true` a watchdog marker (`firmware/pending.json`) guards the
//! restart: the first heartbeat the Hub accepts after the restart, before the deadline, reports
//! `firmware.watchdog.ok`; otherwise the snapshot is restored, `firmware.watchdog.reverted`
//! reported and the machine restarted once (never twice for one snapshot).

use crate::authz::{self, Transport};
use crate::boot::{EFIBOOTMGR, Outbox, Pending, REBOOT_DELAY, Rebooter, Tools, Watch, parse_efibootmgr, schedule_reboot, unsupported, unsupported_detail, watchdog_seconds};
use crate::capabilities::canonical_json;
use crate::crypto::{hex, sha256};
use crate::state::DataDir;
use crate::util::{OpError, OpResult, iso, new_id, now_iso, now_ms, read_json_or, write_json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// The settings in scope (BM2), by their canonical names.
pub const CANONICAL: &[&str] = &["wol", "powerOnAfterPowerLoss", "bootOrder", "virtualization", "secureBoot", "tpm", "fanProfile"];
/// Settings whose "off" values degrade security (docs/23 §6.3 item 5).
pub const SECURITY_KEYS: &[&str] = &["secureBoot", "tpm"];
const KEEP_SNAPSHOTS: usize = 20;
const FWUPD_TIMEOUT_MS: u64 = 10_000;
const MAX_CHANGES: usize = 16;

/// The owner's firmware settings in `config.json` (`firmware`). The Hub cannot change them.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct FirmwareConfig {
    /// `auto` (default), `none`, or `fake` (with `fakePath`).
    pub backend: Option<String>,
    pub fake_path: Option<String>,
    /// Test roots for `/sys/class/firmware-attributes`, `/sys/class/dmi/id`, `/sys/firmware/efi`.
    pub sysfs_root: Option<String>,
    pub dmi_root: Option<String>,
    pub efi_dir: Option<String>,
}

/// A vendor the firmware-attributes class supports, and its names for the canonical settings
/// (the first name present wins). The Hub mirrors this as the hardware support matrix.
pub struct Vendor {
    pub name: &'static str,
    pub driver: &'static str,
    pub keys: &'static [(&'static str, &'static [&'static str])],
    /// How a boot order list is written in a string or enumeration attribute.
    pub order_separator: char,
    /// Why the vendor's names look as they do (documentation; the Hub's matrix has its own notes).
    #[allow(dead_code)]
    pub notes: &'static str,
}

pub const DELL: Vendor = Vendor {
    name: "Dell",
    driver: "dell-wmi-sysman",
    keys: &[
        ("wol", &["WakeOnLan"]),
        ("powerOnAfterPowerLoss", &["AcPwrRcvry"]),
        ("virtualization", &["Virtualization"]),
        ("secureBoot", &["SecureBoot"]),
        ("tpm", &["TpmSecurity"]),
        ("fanProfile", &["ThermalManagement"]),
    ],
    order_separator: ',',
    notes: "Linux kernel firmware-attributes (dell-wmi-sysman); the boot sequence is not exposed there",
};

pub const LENOVO: Vendor = Vendor {
    name: "Lenovo",
    driver: "thinklmi",
    keys: &[
        ("wol", &["WakeOnLAN", "Wake On LAN"]),
        ("powerOnAfterPowerLoss", &["AfterPowerLoss", "After Power Loss"]),
        ("bootOrder", &["BootOrder"]),
        ("virtualization", &["VirtualizationTechnology", "Virtualization Technology"]),
        ("secureBoot", &["SecureBoot", "Secure Boot"]),
        ("tpm", &["SecurityChip", "Security Chip"]),
        ("fanProfile", &["AdaptiveThermalManagementAC"]),
    ],
    order_separator: ':',
    notes: "Linux kernel firmware-attributes (think-lmi); BootOrder is a colon-separated list",
};

pub const HP: Vendor = Vendor {
    name: "HP",
    driver: "hp-bioscfg",
    keys: &[
        ("wol", &["Wake On LAN"]),
        ("powerOnAfterPowerLoss", &["After Power Loss"]),
        ("bootOrder", &["UEFI Boot Order"]),
        ("virtualization", &["Virtualization Technology (VTx)", "Virtualization Technology (VT-x)"]),
        ("secureBoot", &["Secure Boot"]),
        ("tpm", &["TPM State", "TPM Device"]),
    ],
    order_separator: ',',
    notes: "Linux kernel firmware-attributes (hp-bioscfg); no fan profile setting",
};

#[allow(dead_code)]
pub const VENDORS: &[&Vendor] = &[&DELL, &LENOVO, &HP];

/// The hardware support matrix (docs/23 §6, BM1): per vendor id, the method, the driver folder,
/// whether it is supported and the first name of each canonical key. The Hub mirrors it in
/// packages/shared/src/m75/firmware.ts (`FIRMWARE_SUPPORT_MATRIX`); both are pinned by
/// tests/fixtures/firmware-support-matrix.json (this crate's test and the shared package's).
#[allow(dead_code)]
pub fn support_matrix() -> Value {
    let mut rows: Vec<Value> = VENDORS
        .iter()
        .map(|v| json!({ "vendor": v.name.to_ascii_lowercase(), "method": "firmware-attributes", "driver": v.driver, "supported": true, "keys": v.keys.iter().map(|(k, names)| (k.to_string(), json!(names[0]))).collect::<serde_json::Map<_, _>>() }))
        .collect();
    rows.push(json!({ "vendor": "asus", "method": null, "driver": null, "supported": false, "keys": {} }));
    rows.push(json!({ "vendor": "supermicro", "method": null, "driver": null, "supported": false, "keys": {} }));
    rows.push(json!({ "vendor": "generic-uefi", "method": "efibootmgr", "driver": null, "supported": true, "keys": { "bootOrder": "BootOrder" } }));
    json!(rows)
}

enum Kind {
    Known(&'static Vendor),
    Asus,
    Supermicro,
    Other,
}

fn vendor_of(sys_vendor: &str) -> Kind {
    let l = sys_vendor.trim().to_ascii_lowercase();
    if l.contains("dell") {
        Kind::Known(&DELL)
    } else if l.contains("lenovo") {
        Kind::Known(&LENOVO)
    } else if l == "hp" || l.starts_with("hp ") || l.contains("hewlett") {
        Kind::Known(&HP)
    } else if l.contains("asus") {
        Kind::Asus
    } else if l.contains("supermicro") {
        Kind::Supermicro
    } else {
        Kind::Other
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Platform {
    pub vendor: String,
    pub product: String,
    pub bios_vendor: String,
    pub bios_version: String,
    pub bios_date: String,
    pub uefi: bool,
}

fn read_trim(p: &Path) -> Option<String> {
    std::fs::read_to_string(p).ok().map(|s| s.trim().to_string())
}

pub fn platform(dmi: &Path, efi: &Path) -> Platform {
    let f = |n: &str| read_trim(&dmi.join(n)).unwrap_or_default();
    Platform { vendor: f("sys_vendor"), product: f("product_name"), bios_vendor: f("bios_vendor"), bios_version: f("bios_version"), bios_date: f("bios_date"), uefi: efi.is_dir() }
}

/// One allowlisted setting as the backend reads it.
#[derive(Debug, Clone, PartialEq)]
pub struct Setting {
    pub key: String,
    pub vendor_key: String,
    pub value: String,
    /// `enum`, `order`, `string` or `int`.
    pub kind: &'static str,
    pub allowed: Option<Vec<String>>,
    pub read_only: bool,
    pub min: Option<i64>,
    pub max: Option<i64>,
    pub separator: char,
}

impl Setting {
    pub fn to_json(&self) -> Value {
        let degrading: Vec<&String> = self.allowed.iter().flatten().filter(|v| degrading_value(&self.key, v)).collect();
        json!({ "key": self.key, "vendorKey": self.vendor_key, "value": self.value, "type": self.kind, "allowed": self.allowed, "readOnly": self.read_only, "securityDegrading": degrading })
    }

    fn items(&self, v: &str) -> Vec<String> {
        v.split(self.separator).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect()
    }

    /// A requested value as this setting writes it; Err is the refusal reason.
    fn normalize(&self, v: &Value) -> Result<String, &'static str> {
        match v {
            Value::String(s) => Ok(s.clone()),
            Value::Number(n) if self.kind == "int" => n.as_i64().map(|n| n.to_string()).ok_or("not_allowed_value"),
            Value::Array(a) if self.kind == "order" => a.iter().map(|x| x.as_str().map(str::to_string)).collect::<Option<Vec<_>>>().map(|v| v.join(&self.separator.to_string())).ok_or("not_allowed_value"),
            _ => Err("not_allowed_value"),
        }
    }

    /// Whether `value` may be written here; Err is the refusal reason.
    fn check(&self, value: &str) -> Result<(), &'static str> {
        if self.read_only {
            return Err("read_only");
        }
        if value.len() > 1024 || value.chars().any(char::is_control) {
            return Err("not_allowed_value");
        }
        let ok = match self.kind {
            "enum" => self.allowed.as_ref().is_some_and(|a| a.iter().any(|x| x == value)),
            "order" => {
                // A boot order is reordered, never shortened or extended: an entry dropped from
                // the order could leave the machine without its system.
                let (mut want, mut have) = (self.items(value), self.items(&self.value));
                let unique = want.len() == want.iter().collect::<std::collections::HashSet<_>>().len();
                let known = self.allowed.as_ref().is_none_or(|a| want.iter().all(|x| a.contains(x)));
                want.sort();
                have.sort();
                unique && known && !want.is_empty() && want == have
            }
            "int" => value.parse::<i64>().is_ok_and(|n| self.min.is_none_or(|m| n >= m) && self.max.is_none_or(|m| n <= m)),
            _ => value.len() <= 256,
        };
        if ok { Ok(()) } else { Err("not_allowed_value") }
    }
}

fn is_enabling(v: &str) -> bool {
    let l = v.trim().to_ascii_lowercase();
    matches!(l.as_str(), "on" | "active" | "activated" | "true" | "1") || l.starts_with("enable")
}

/// A value that turns a security setting off (Secure Boot or TPM disabled, inactive, hidden).
pub fn degrading_value(key: &str, v: &str) -> bool {
    SECURITY_KEYS.contains(&key) && !is_enabling(v)
}

fn degrading_change(key: &str, from: &str, to: &str) -> bool {
    degrading_value(key, to) && !degrading_value(key, from)
}

/// `on`, `off`, `last` or `unknown` from a vendor's power-loss value (power status, FR-144).
pub fn after_loss_word(v: &str) -> &'static str {
    let l = v.to_ascii_lowercase();
    if l.contains("last") || l.contains("previous") {
        "last"
    } else if l.contains("off") {
        "off"
    } else if l.contains("on") {
        "on"
    } else {
        "unknown"
    }
}

pub trait FirmwareBackend: Send + Sync {
    /// `firmware-attributes`, `efibootmgr` or `fake`.
    fn method(&self) -> &'static str;
    /// The allowlisted settings this machine has.
    fn settings(&self) -> OpResult<Vec<Setting>>;
    fn write(&self, s: &Setting, value: &str, admin_password: Option<&str>) -> OpResult<()>;
    fn admin_password_set(&self) -> bool;
    /// Whether written values take effect only at the next boot.
    fn requires_reboot(&self) -> bool;
}

/// The Linux kernel firmware-attributes class for one driver.
pub struct SysfsFirmwareAttributes {
    pub dir: PathBuf,
    pub vendor: &'static Vendor,
}

impl SysfsFirmwareAttributes {
    fn attr(&self, key: &str, name: &str) -> Option<Setting> {
        let d = self.dir.join("attributes").join(name);
        let value = read_trim(&d.join("current_value"))?;
        let ty = read_trim(&d.join("type")).unwrap_or_default();
        let list = |f: &str| read_trim(&d.join(f)).map(|s| s.split(';').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect::<Vec<_>>());
        let num = |f: &str| read_trim(&d.join(f)).and_then(|s| s.parse::<i64>().ok());
        let (kind, separator) = match (key, ty.as_str()) {
            (_, "ordered-list") => ("order", ','),
            ("bootOrder", _) => ("order", self.vendor.order_separator),
            (_, "enumeration") => ("enum", ','),
            (_, "integer") => ("int", ','),
            _ => ("string", ','),
        };
        let allowed = match kind {
            "enum" => list("possible_values"),
            "order" => list("elements").or_else(|| list("possible_values")),
            _ => None,
        };
        // hp-bioscfg says so in `is_readonly`; a value file without write bits is read-only too.
        let read_only = read_trim(&d.join("is_readonly")).as_deref() == Some("1") || std::fs::metadata(d.join("current_value")).is_ok_and(|m| m.permissions().readonly());
        Some(Setting { key: key.into(), vendor_key: name.into(), value, kind, allowed, read_only, min: num("min_value"), max: num("max_value"), separator })
    }

    fn admin(&self) -> PathBuf {
        self.dir.join("authentication").join("Admin")
    }
}

fn sysfs_write(path: &Path, value: &str) -> std::io::Result<()> {
    let mut f = std::fs::OpenOptions::new().write(true).truncate(true).open(path)?;
    f.write_all(value.as_bytes())
}

impl FirmwareBackend for SysfsFirmwareAttributes {
    fn method(&self) -> &'static str {
        "firmware-attributes"
    }
    fn settings(&self) -> OpResult<Vec<Setting>> {
        Ok(self.vendor.keys.iter().filter_map(|(key, names)| names.iter().find_map(|n| self.attr(key, n))).collect())
    }
    fn write(&self, s: &Setting, value: &str, admin_password: Option<&str>) -> OpResult<()> {
        let auth = self.admin().join("current_password");
        if let Some(pw) = admin_password {
            sysfs_write(&auth, pw).map_err(|e| OpError::internal(format!("the BIOS admin password could not be given: {e}")))?;
        }
        let r = sysfs_write(&self.dir.join("attributes").join(&s.vendor_key).join("current_value"), value);
        if admin_password.is_some() {
            // The driver keeps the password until it is overwritten.
            let _ = sysfs_write(&auth, "");
        }
        r.map_err(|e| OpError::internal(format!("writing {} failed: {e}", s.vendor_key)))
    }
    fn admin_password_set(&self) -> bool {
        read_trim(&self.admin().join("is_enabled")).as_deref() == Some("1")
    }
    fn requires_reboot(&self) -> bool {
        true
    }
}

/// Generic UEFI: the boot order through `efibootmgr`.
pub struct EfiBootOrder(pub Tools);

impl FirmwareBackend for EfiBootOrder {
    fn method(&self) -> &'static str {
        "efibootmgr"
    }
    fn settings(&self) -> OpResult<Vec<Setting>> {
        let b = parse_efibootmgr(&self.0.run_ok(EFIBOOTMGR, &[])?);
        let allowed = b.entries.iter().map(|e| e.0.clone()).collect();
        Ok(vec![Setting { key: "bootOrder".into(), vendor_key: "BootOrder".into(), value: b.order.join(","), kind: "order", allowed: Some(allowed), read_only: false, min: None, max: None, separator: ',' }])
    }
    fn write(&self, s: &Setting, value: &str, _: Option<&str>) -> OpResult<()> {
        if s.key != "bootOrder" {
            return Err(OpError::internal("efibootmgr changes the boot order only"));
        }
        self.0.run_ok(EFIBOOTMGR, &["--bootorder", value]).map(|_| ())
    }
    fn admin_password_set(&self) -> bool {
        false
    }
    fn requires_reboot(&self) -> bool {
        false
    }
}

/// The fake: `{platform, adminPasswordSet, adminPassword?, requiresReboot, settings: {<key>:
/// {vendorKey, value, type, allowed, readOnly}}, failWrites: [key]}`.
pub struct FakeFirmware {
    pub path: PathBuf,
    lock: Mutex<()>,
}

impl FakeFirmware {
    pub fn new(path: PathBuf) -> FakeFirmware {
        FakeFirmware { path, lock: Mutex::new(()) }
    }
    fn load(&self) -> OpResult<Value> {
        read_json_or(&self.path, Value::Null).map_err(|e| OpError::internal(e.to_string())).and_then(|v| if v.is_object() { Ok(v) } else { Err(OpError::internal("the fake firmware file is missing")) })
    }
    pub fn platform(&self) -> Platform {
        self.load().ok().and_then(|v| serde_json::from_value(v["platform"].clone()).ok()).unwrap_or_default()
    }
}

impl FirmwareBackend for FakeFirmware {
    fn method(&self) -> &'static str {
        "fake"
    }
    fn settings(&self) -> OpResult<Vec<Setting>> {
        let v = self.load()?;
        let mut out = vec![];
        for key in CANONICAL {
            let s = &v["settings"][*key];
            let Some(value) = s["value"].as_str() else { continue };
            let kind = match s["type"].as_str() {
                Some("enum") => "enum",
                Some("order") => "order",
                Some("int") => "int",
                _ => "string",
            };
            let allowed = s["allowed"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect());
            out.push(Setting { key: key.to_string(), vendor_key: s["vendorKey"].as_str().unwrap_or(key).into(), value: value.into(), kind, allowed, read_only: s["readOnly"].as_bool() == Some(true), min: None, max: None, separator: ',' });
        }
        Ok(out)
    }
    fn write(&self, s: &Setting, value: &str, admin_password: Option<&str>) -> OpResult<()> {
        let _g = self.lock.lock().unwrap_or_else(|p| p.into_inner());
        let mut v = self.load()?;
        if v["failWrites"].as_array().is_some_and(|a| a.iter().any(|k| k == s.key.as_str())) {
            return Err(OpError::internal(format!("writing {} failed (fake)", s.vendor_key)));
        }
        if v["adminPasswordSet"].as_bool() == Some(true) && v["adminPassword"].as_str().is_some_and(|p| Some(p) != admin_password) {
            return Err(OpError::internal("the BIOS refused the admin password (fake)"));
        }
        v["settings"][&s.key]["value"] = json!(value);
        write_json(&self.path, &v, false).map_err(OpError::from)
    }
    fn admin_password_set(&self) -> bool {
        self.load().is_ok_and(|v| v["adminPasswordSet"].as_bool() == Some(true))
    }
    fn requires_reboot(&self) -> bool {
        self.load().map(|v| v["requiresReboot"].as_bool().unwrap_or(true)).unwrap_or(true)
    }
}

/// What this machine offers: a backend, or the reason it has none.
pub struct Hardware {
    pub platform: Platform,
    pub backend: Result<Box<dyn FirmwareBackend>, OpError>,
}

/// A snapshot of every allowlisted value, taken by each plan.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Snapshot {
    pub id: String,
    pub taken_at: String,
    pub values: BTreeMap<String, String>,
    pub sha256: String,
    pub plan_id: Option<String>,
    pub method: String,
}

pub fn values_sha256(values: &BTreeMap<String, String>) -> String {
    hex(&sha256(canonical_json(&json!(values)).as_bytes()))
}

/// Ids novad makes (`new_id`): 32 lowercase hex characters, safe as a file name.
fn is_id(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

/// Restarts are refused: the reader in the management module only reads.
struct NoReboot;

impl Rebooter for NoReboot {
    fn check(&self) -> OpResult<()> {
        Err(OpError::conflict("no restarts from here").with(json!({ "reason": "reboot_unavailable" })))
    }
    fn reboot(&self) -> OpResult<()> {
        self.check()
    }
}

pub struct Firmware {
    pub data: DataDir,
    pub tools: Tools,
    pub rebooter: Arc<dyn Rebooter>,
    pub watch: Watch,
    pub outbox: Outbox,
    pub reboot_delay: Duration,
    /// BIOS settings are built for Linux only (D10: no vendor tools on Windows or macOS).
    pub os_supported: bool,
    lock: Mutex<()>,
}

type Change = (Setting, String, String);

impl Firmware {
    pub fn new(data: DataDir, rebooter: Arc<dyn Rebooter>) -> Firmware {
        let dir = data.path().join("firmware");
        Firmware {
            watch: Watch::new(dir.clone()),
            outbox: Outbox::new(dir.join("events.json")),
            data,
            tools: Tools::default(),
            rebooter,
            reboot_delay: REBOOT_DELAY,
            os_supported: cfg!(target_os = "linux"),
            lock: Mutex::new(()),
        }
    }

    /// A reader that never changes anything (the power status, FR-144).
    pub fn reader(data: DataDir) -> Firmware {
        Firmware::new(data, Arc::new(NoReboot))
    }

    fn dir(&self) -> PathBuf {
        self.data.path().join("firmware")
    }

    pub fn detect(&self) -> OpResult<Hardware> {
        let cfg = self.data.config()?.firmware;
        let efi = PathBuf::from(cfg.efi_dir.clone().unwrap_or_else(|| "/sys/firmware/efi".into()));
        let dmi = PathBuf::from(cfg.dmi_root.clone().unwrap_or_else(|| "/sys/class/dmi/id".into()));
        let root = PathBuf::from(cfg.sysfs_root.clone().unwrap_or_else(|| "/sys/class/firmware-attributes".into()));
        if !self.os_supported {
            return Ok(Hardware { platform: Platform::default(), backend: Err(unsupported("os_not_supported", "BIOS settings are built for Linux only; vendor tools on Windows and macOS are not used")) });
        }
        match cfg.backend.as_deref().unwrap_or("auto") {
            "fake" => {
                let path = cfg.fake_path.clone().ok_or_else(|| OpError::internal("firmware.backend is fake but firmware.fakePath is not set"))?;
                let f = FakeFirmware::new(PathBuf::from(path));
                return Ok(Hardware { platform: f.platform(), backend: Ok(Box::new(f)) });
            }
            "none" => return Ok(Hardware { platform: platform(&dmi, &efi), backend: Err(unsupported("disabled_by_owner", "the device owner turned BIOS settings off in novad's config")) }),
            _ => {}
        }
        let p = platform(&dmi, &efi);
        let backend: Result<Box<dyn FirmwareBackend>, OpError> = match vendor_of(&p.vendor) {
            Kind::Known(v) if root.join(v.driver).join("attributes").is_dir() => Ok(Box::new(SysfsFirmwareAttributes { dir: root.join(v.driver), vendor: v })),
            Kind::Known(v) => Err(unsupported("driver_missing", &format!("the {} kernel driver is not loaded, so this {} machine's BIOS settings cannot be read", v.driver, v.name))),
            Kind::Asus => Err(unsupported("vendor_not_supported", "ASUS boards expose no BIOS settings interface to Linux")),
            Kind::Supermicro => Err(unsupported("vendor_not_supported", "Supermicro boards are managed out of band (Redfish or IPMI, FR-147)")),
            Kind::Other if p.uefi && self.tools.find(EFIBOOTMGR).is_some() => Ok(Box::new(EfiBootOrder(self.tools.clone()))),
            Kind::Other if p.uefi => Err(unsupported("tool_missing", "this UEFI machine's boot order needs efibootmgr, which is not installed")),
            Kind::Other => Err(unsupported("vendor_not_supported", "this machine is not in the hardware support matrix")),
        };
        Ok(Hardware { platform: p, backend })
    }

    fn backend(&self) -> OpResult<Box<dyn FirmwareBackend>> {
        self.detect()?.backend
    }

    /// Whether BIOS settings can be read here (the capability document lists `firmware` then).
    pub fn supported(&self) -> bool {
        self.detect().is_ok_and(|h| h.backend.is_ok())
    }

    /// Power-on-after-power-loss as the power status reports it, when a BIOS backend reads it.
    pub fn after_power_loss(&self) -> Option<&'static str> {
        let b = self.backend().ok().filter(|b| b.method() != "efibootmgr")?;
        let s = b.settings().ok()?.into_iter().find(|s| s.key == "powerOnAfterPowerLoss")?;
        Some(after_loss_word(&s.value))
    }

    fn require_module(&self) -> OpResult<()> {
        let allowed = self.data.hub_config()?.policy.allowed_modules;
        if allowed.is_some_and(|l| !l.iter().any(|m| m == "firmware")) {
            return Err(OpError::denied("module_not_allowed", "the firmware module is not allowed on this device"));
        }
        Ok(())
    }

    fn require_changes(&self) -> OpResult<()> {
        if !self.data.privileged_policy().firmware_changes {
            return Err(OpError::new(403, "firmware_disabled", "BIOS/firmware changes are off on the Hub (devices.firmware.allowChanges, FR-146)"));
        }
        Ok(())
    }

    /// One management route under `/agent/v1/firmware/`.
    pub fn route(&self, op: &str, body: &Value, transport: Transport) -> OpResult<Value> {
        match op {
            "read" => self.read(),
            "plan" => self.plan(body),
            "apply" => self.apply(body, transport, now_ms()),
            "rollback" => self.rollback(body, transport, now_ms()),
            _ => Err(OpError::not_found("unknown firmware route")),
        }
    }

    /// `firmware/read`: allowed whatever the policy (reading changes nothing).
    pub fn read(&self) -> OpResult<Value> {
        self.require_module()?;
        let hw = self.detect()?;
        let updates = fwupd_updates(&self.tools);
        Ok(match hw.backend {
            Ok(b) => json!({
                "supported": true, "platform": hw.platform, "method": b.method(), "adminPasswordSet": b.admin_password_set(),
                "settings": b.settings()?.iter().map(Setting::to_json).collect::<Vec<_>>(), "updates": updates,
            }),
            Err(e) => json!({
                "supported": false, "reason": unsupported_detail(&e),
                "platform": hw.platform, "method": null, "adminPasswordSet": false, "settings": [], "updates": updates,
            }),
        })
    }

    fn snapshots(&self) -> PathBuf {
        self.dir().join("snapshots")
    }

    fn private_dir(path: &Path) -> OpResult<()> {
        std::fs::create_dir_all(path)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
        }
        Ok(())
    }

    fn take_snapshot(&self, settings: &[Setting], plan_id: &str, method: &str) -> OpResult<Snapshot> {
        let values: BTreeMap<String, String> = settings.iter().map(|s| (s.key.clone(), s.value.clone())).collect();
        let s = Snapshot { id: new_id(), taken_at: now_iso(), sha256: values_sha256(&values), values, plan_id: Some(plan_id.into()), method: method.into() };
        Self::private_dir(&self.dir())?;
        Self::private_dir(&self.snapshots())?;
        write_json(&self.snapshots().join(format!("{}.json", s.id)), &s, true)?;
        self.prune();
        Ok(s)
    }

    /// Keep the newest 20 snapshots, and always the one a watchdog marker names.
    fn prune(&self) {
        let keep = self.watch.pending().and_then(|p| p.snapshot_id);
        let Ok(dir) = std::fs::read_dir(self.snapshots()) else { return };
        let mut all: Vec<(String, PathBuf, String)> = dir
            .flatten()
            .filter_map(|e| {
                let s: Snapshot = read_json_or(&e.path(), Snapshot::default()).ok()?;
                Some((s.taken_at, e.path(), s.id))
            })
            .collect();
        all.sort();
        let n = all.len().saturating_sub(KEEP_SNAPSHOTS);
        for (_, path, id) in all.into_iter().take(n) {
            if Some(&id) != keep.as_ref() {
                let _ = std::fs::remove_file(path);
            }
        }
    }

    pub fn load_snapshot(&self, id: &str) -> OpResult<Option<Snapshot>> {
        if !is_id(id) {
            return Err(OpError::validation("snapshotId is not a snapshot id"));
        }
        read_json_or::<Option<Snapshot>>(&self.snapshots().join(format!("{id}.json")), None).map_err(|e| OpError::internal(e.to_string()))
    }

    /// `firmware/plan`: a dry run. Takes a snapshot, changes nothing.
    pub fn plan(&self, body: &Value) -> OpResult<Value> {
        self.require_module()?;
        let b = self.backend()?;
        let changes = parse_changes(body)?;
        let settings = b.settings()?;
        let plan_id = new_id();
        let snap = self.take_snapshot(&settings, &plan_id, b.method())?;
        let (mut diff, mut refused) = (vec![], vec![]);
        for (key, value) in &changes {
            match resolve(&settings, key, value) {
                Err(reason) => refused.push(json!({ "key": key, "reason": reason })),
                Ok(None) => {}
                Ok(Some((s, from, to))) => diff.push(json!({ "key": key, "vendorKey": s.vendor_key, "from": from, "to": to, "securityDegrading": degrading_change(key, &from, &to) })),
            }
        }
        let requires_reboot = b.requires_reboot() && !diff.is_empty();
        Ok(json!({ "planId": plan_id, "snapshot": { "id": snap.id, "takenAt": snap.taken_at, "values": snap.values, "sha256": snap.sha256 }, "diff": diff, "refused": refused, "requiresReboot": requires_reboot }))
    }

    /// `firmware/apply`: the approved change, when nothing moved since the plan.
    pub fn apply(&self, body: &Value, transport: Transport, now: u64) -> OpResult<Value> {
        refuse_plain_password(body, transport)?;
        self.require_module()?;
        let b = self.backend()?;
        self.require_changes()?;
        let auth = authz::authorize_at(&self.data, "firmware.apply", body, transport, now)?;
        let _g = self.lock.lock().unwrap_or_else(|p| p.into_inner());
        let plan_id = body["planId"].as_str().ok_or_else(|| OpError::validation("planId is required"))?;
        let snapshot_id = body["snapshotId"].as_str().ok_or_else(|| OpError::validation("snapshotId is required"))?;
        let changes = parse_changes(body)?;
        let reboot = flag(body, "reboot")?;
        let seconds = watchdog_seconds(body)?;
        let snap = self.load_snapshot(snapshot_id)?.ok_or_else(|| OpError::not_found("no such snapshot on this device; plan again").with(json!({ "reason": "snapshot_missing" })))?;
        if snap.plan_id.as_deref() != Some(plan_id) {
            return Err(OpError::conflict("the snapshot belongs to another plan").with(json!({ "reason": "plan_mismatch" })));
        }
        let settings = b.settings()?;
        // Nothing is written unless the machine still has the values the owner approved against.
        let moved: Vec<&String> = snap.values.iter().filter(|(k, v)| settings.iter().find(|s| &&s.key == k).map(|s| &s.value) != Some(v)).map(|(k, _)| k).collect();
        if !moved.is_empty() {
            return Err(OpError::conflict("the BIOS settings changed since the plan; plan again").with(json!({ "reason": "base_mismatch", "keys": moved })));
        }
        let mut todo: Vec<Change> = vec![];
        for (key, value) in &changes {
            match resolve(&settings, key, value) {
                Err(reason) => return Err(OpError::validation(format!("{key} cannot be set to that value")).with(json!({ "reason": reason, "key": key }))),
                Ok(None) => {}
                Ok(Some(c)) => todo.push(c),
            }
        }
        self.guard_writes(b.as_ref(), &todo, body)?;
        if reboot {
            // One guarded restart at a time: a second marker would leave the first change unguarded.
            if self.watch.pending().is_some() {
                return Err(OpError::conflict("a firmware change is already waiting for its restart").with(json!({ "reason": "watchdog_pending" })));
            }
            if self.watch.was_done(&snap.id) {
                return Err(OpError::conflict("the watchdog already reverted this snapshot once; plan again").with(json!({ "reason": "watchdog_already_used" })));
            }
            self.rebooter.check()?;
        }
        // The marker goes first: a change is never on the machine without its watchdog.
        let mut watchdog = Value::Null;
        if reboot {
            let deadline_ms = now + seconds * 1000;
            let p = Pending { snapshot_id: Some(snap.id.clone()), change_id: Some(auth.change_id), deadline: iso(deadline_ms), deadline_ms, boot_id: self.watch.current_boot(), reboot: true, at: iso(now), ..Default::default() };
            if !self.watch.write(&p)? {
                return Err(OpError::conflict("the watchdog already reverted this snapshot once; plan again").with(json!({ "reason": "watchdog_already_used" })));
            }
            watchdog = json!({ "deadline": p.deadline });
        }
        if let Err(e) = write_all(b.as_ref(), &todo, body["adminPassword"].as_str(), "apply_failed") {
            if reboot {
                self.watch.clear();
            }
            return Err(e);
        }
        if reboot {
            schedule_reboot(self.rebooter.clone(), self.reboot_delay);
        }
        let applied: Vec<Value> = todo.iter().map(|(s, from, to)| json!({ "key": s.key, "from": from, "to": to })).collect();
        Ok(json!({ "applied": applied, "pendingReboot": b.requires_reboot() && !todo.is_empty(), "watchdog": watchdog }))
    }

    /// Refusals before anything is written: security-degrading values without the approved
    /// override, and a BIOS admin password the body does not carry.
    fn guard_writes(&self, b: &dyn FirmwareBackend, todo: &[Change], body: &Value) -> OpResult<()> {
        let degrading: Vec<&String> = todo.iter().filter(|(s, from, to)| degrading_change(&s.key, from, to)).map(|(s, _, _)| &s.key).collect();
        if !degrading.is_empty() && body["allowSecurityDegrading"].as_bool() != Some(true) {
            return Err(OpError::denied("security_degrading", "turning Secure Boot or the TPM off needs the separate override (devices.firmware.allowSecurityDegrading)").with(json!({ "reason": "security_degrading", "keys": degrading })));
        }
        if !todo.is_empty() && b.admin_password_set() && body["adminPassword"].as_str().is_none_or(str::is_empty) {
            return Err(OpError::denied("admin_password_required", "this BIOS has an admin password; the Hub must send it from the vault (secret://devices/<id>/bios-admin)"));
        }
        Ok(())
    }

    /// `firmware/rollback`: back to a snapshot (the device copy, or the Hub's when it is gone).
    pub fn rollback(&self, body: &Value, transport: Transport, now: u64) -> OpResult<Value> {
        refuse_plain_password(body, transport)?;
        self.require_module()?;
        let b = self.backend()?;
        self.require_changes()?;
        authz::authorize_at(&self.data, "firmware.rollback", body, transport, now)?;
        let _g = self.lock.lock().unwrap_or_else(|p| p.into_inner());
        let id = body["snapshotId"].as_str().ok_or_else(|| OpError::validation("snapshotId is required"))?;
        let snap = match self.load_snapshot(id)? {
            Some(s) => s,
            None => hub_copy(id, &body["snapshot"])?,
        };
        let settings = b.settings()?;
        let mut todo: Vec<Change> = vec![];
        for (key, value) in &snap.values {
            match restore_change(&settings, key, value) {
                Ok(Some(c)) => todo.push(c),
                Ok(None) => {}
                Err(why) => return Err(OpError::conflict(format!("{key} cannot be restored to its snapshot value")).with(json!({ "reason": "snapshot_not_applicable", "key": key, "why": why }))),
            }
        }
        self.guard_writes(b.as_ref(), &todo, body)?;
        write_all(b.as_ref(), &todo, body["adminPassword"].as_str(), "rollback_failed")?;
        if self.watch.pending().and_then(|p| p.snapshot_id).as_deref() == Some(id) {
            self.watch.clear();
        }
        Ok(json!({ "restored": todo.iter().map(|(s, from, to)| json!({ "key": s.key, "from": from, "to": to })).collect::<Vec<_>>() }))
    }

    /// The watchdog's revert: every key it can put back, each on its own. A key that fails stays
    /// as it is and is reported, and the ones restored stay restored (never undone to the new
    /// values). Gives (restored, failed).
    fn revert(&self, b: &dyn FirmwareBackend, values: &BTreeMap<String, String>) -> OpResult<(Vec<Value>, Vec<Value>)> {
        let settings = b.settings()?;
        let (mut restored, mut failed) = (vec![], vec![]);
        // novad never keeps the BIOS admin password, so a protected BIOS cannot be written here.
        let locked = b.admin_password_set();
        for (key, value) in values {
            let c = match restore_change(&settings, key, value) {
                Ok(Some(c)) => c,
                Ok(None) => continue,
                Err(why) => {
                    let from = settings.iter().find(|s| &s.key == key).map(|s| s.value.clone());
                    failed.push(json!({ "key": key, "from": from, "to": value, "error": "snapshot_not_applicable", "why": why }));
                    continue;
                }
            };
            let (s, from, to) = c;
            if locked {
                failed.push(json!({ "key": key, "from": from, "to": to, "error": "admin_password_required" }));
                continue;
            }
            match b.write(&s, &to, None) {
                Ok(()) => restored.push(json!({ "key": key, "from": from, "to": to })),
                Err(e) => failed.push(json!({ "key": key, "from": from, "to": to, "error": "write_failed", "message": e.message })),
            }
        }
        Ok((restored, failed))
    }

    pub fn on_start(&self) {
        self.watch.on_start();
    }

    fn event(&self, kind: &str, p: &Pending, now: u64, detail: Value) {
        self.outbox.push(json!({ "kind": kind, "snapshotId": p.snapshot_id, "changeId": p.change_id, "at": iso(now), "detail": detail }));
    }

    /// The Hub accepted a heartbeat: an armed marker before its deadline is ok.
    pub fn on_beat(&self, now: u64) {
        let Some(p) = self.watch.armed() else { return };
        if now > p.deadline_ms {
            return self.tick(now);
        }
        self.watch.clear();
        self.event("firmware.watchdog.ok", &p, now, json!({}));
    }

    /// Called often while novad runs: a deadline that passed without a confirmed restart restores
    /// the snapshot (and restarts once when the machine had restarted into the change).
    pub fn tick(&self, now: u64) {
        let (p, restarted) = match (self.watch.armed(), self.watch.stale(now)) {
            (Some(p), _) if now > p.deadline_ms => (p, true),
            (None, Some(p)) => (p, false),
            _ => return,
        };
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let id = p.snapshot_id.clone().unwrap_or_default();
        let result = self.backend().and_then(|b| {
            let snap = self.load_snapshot(&id)?.ok_or_else(|| OpError::not_found("the snapshot is gone"))?;
            self.revert(b.as_ref(), &snap.values)
        });
        self.watch.clear();
        self.watch.mark_done(&id);
        let reason = if restarted { "deadline" } else { "not_restarted" };
        // `complete: false` is a revert that failed (the Hub records `revert_failed`): the machine
        // keeps the keys in `failed`. Only a complete revert restarts, so a machine left half way
        // stays reachable.
        let (detail, rebooted) = match result {
            Ok((restored, failed)) => {
                let rebooted = restarted && failed.is_empty() && !restored.is_empty();
                (json!({ "reason": reason, "complete": failed.is_empty(), "restored": restored, "failed": failed, "rebooted": rebooted }), rebooted)
            }
            Err(e) => {
                let code = e.details.as_ref().and_then(|d| d["reason"].as_str()).unwrap_or(&e.code).to_string();
                (json!({ "reason": reason, "complete": false, "restored": [], "failed": [], "rebooted": false, "error": e.message, "errorCode": code }), false)
            }
        };
        self.event("firmware.watchdog.reverted", &p, now, detail);
        if rebooted && let Err(e) = self.rebooter.reboot() {
            eprintln!("novad: the firmware watchdog could not restart the machine: {e}");
        }
    }
}

/// The BIOS admin password never crosses plain HTTP: refused before anything else is read.
fn refuse_plain_password(body: &Value, transport: Transport) -> OpResult<()> {
    if transport == Transport::Plain && body.get("adminPassword").is_some_and(|v| !v.is_null()) {
        return Err(OpError::denied("tls_required", "the BIOS admin password is taken only over mutual TLS"));
    }
    Ok(())
}

/// A snapshot value to put back: Ok(None) when the key is gone, read-only or already there;
/// Err(reason) when the value no longer fits the setting.
fn restore_change(settings: &[Setting], key: &str, value: &str) -> Result<Option<Change>, &'static str> {
    let Some(s) = settings.iter().find(|s| s.key == key) else { return Ok(None) };
    if s.read_only || s.value == value {
        return Ok(None);
    }
    s.check(value)?;
    Ok(Some((s.clone(), s.value.clone(), value.to_string())))
}

fn flag(body: &Value, key: &str) -> OpResult<bool> {
    match &body[key] {
        Value::Bool(b) => Ok(*b),
        Value::Null => Ok(false),
        _ => Err(OpError::validation(format!("{key} must be true or false"))),
    }
}

/// `changes: [{key, value}]`, 1 to 16, each key once.
fn parse_changes(body: &Value) -> OpResult<Vec<(String, Value)>> {
    let list = body["changes"].as_array().filter(|a| !a.is_empty() && a.len() <= MAX_CHANGES).ok_or_else(|| OpError::validation("changes must list 1 to 16 {key, value}"))?;
    let mut out: Vec<(String, Value)> = vec![];
    for c in list {
        let key = c["key"].as_str().filter(|k| !k.is_empty() && k.len() <= 100).ok_or_else(|| OpError::validation("every change needs a key"))?;
        if c.get("value").is_none_or(Value::is_null) {
            return Err(OpError::validation(format!("{key} needs a value")));
        }
        if out.iter().any(|(k, _)| k == key) {
            return Err(OpError::validation(format!("{key} is listed twice")));
        }
        out.push((key.to_string(), c["value"].clone()));
    }
    Ok(out)
}

/// A requested change against this machine's settings: Ok(None) when it changes nothing,
/// Err(reason) when it is refused.
fn resolve(settings: &[Setting], key: &str, value: &Value) -> Result<Option<Change>, &'static str> {
    if !CANONICAL.contains(&key) {
        return Err("unknown_key");
    }
    let s = settings.iter().find(|s| s.key == key).ok_or("unsupported")?;
    let to = s.normalize(value)?;
    if to == s.value {
        return Ok(None);
    }
    s.check(&to)?;
    Ok(Some((s.clone(), s.value.clone(), to)))
}

/// Write each change; on a failure restore what was already written (newest first) and answer
/// 500 `{reason, restored, key}`.
fn write_all(b: &dyn FirmwareBackend, todo: &[Change], password: Option<&str>, reason: &str) -> OpResult<()> {
    for (i, (s, _, to)) in todo.iter().enumerate() {
        if let Err(e) = b.write(s, to, password) {
            let restored = todo[..i].iter().rev().all(|(d, from, _)| b.write(d, from, password).is_ok());
            let what = if restored { "the earlier values were restored" } else { "restoring the earlier values failed too" };
            return Err(OpError::internal(format!("{}; {what}", e.message)).with(json!({ "reason": reason, "restored": restored, "key": s.key })));
        }
    }
    Ok(())
}

/// The Hub's copy of a snapshot the device lost: its values must hash to its sha256.
fn hub_copy(id: &str, v: &Value) -> OpResult<Snapshot> {
    let values: BTreeMap<String, String> = v["values"]
        .as_object()
        .map(|o| o.iter().map(|(k, x)| Some((k.clone(), x.as_str()?.to_string()))).collect::<Option<BTreeMap<_, _>>>())
        .unwrap_or(None)
        .ok_or_else(|| OpError::not_found("no such snapshot on this device, and no copy in the request").with(json!({ "reason": "snapshot_missing" })))?;
    if let Some(bad) = values.keys().find(|k| !CANONICAL.contains(&k.as_str())) {
        return Err(OpError::validation(format!("the snapshot names {bad}, which is not an allowlisted setting")));
    }
    if v["sha256"].as_str() != Some(values_sha256(&values).as_str()) {
        return Err(OpError::conflict("the snapshot copy does not match its hash").with(json!({ "reason": "snapshot_mismatch" })));
    }
    Ok(Snapshot { id: id.into(), values, sha256: v["sha256"].as_str().unwrap_or_default().into(), ..Default::default() })
}

/// Firmware updates fwupd offers (read-only; installing them is not built): `[{device, version,
/// summary}]`, [] without fwupdmgr.
pub fn fwupd_updates(tools: &Tools) -> Vec<Value> {
    if tools.find(&["fwupdmgr"]).is_none() {
        return vec![];
    }
    // fwupdmgr exits non-zero when there is nothing to update; the JSON still says so.
    tools.run(&["fwupdmgr"], &["get-updates", "--json"], FWUPD_TIMEOUT_MS).map(|o| parse_fwupd(&o.stdout)).unwrap_or_default()
}

pub fn parse_fwupd(text: &str) -> Vec<Value> {
    let Ok(v) = serde_json::from_str::<Value>(text.trim()) else { return vec![] };
    v["Devices"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|d| {
            let r = d["Releases"].as_array()?.first()?;
            Some(json!({ "device": d["Name"].as_str().unwrap_or("device"), "version": r["Version"].as_str().unwrap_or_default(), "summary": r["Summary"].as_str().unwrap_or_default() }))
        })
        .take(50)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::authz::tests::{NOW, enrolled, signed};
    use crate::boot::tests::{FakeReboot, fake_tool, wait_for};
    use crate::tls::tests::HUB_SEED;
    use std::sync::atomic::Ordering;

    fn attr(root: &Path, name: &str, ty: &str, value: &str, possible: &[&str]) {
        let d = root.join("attributes").join(name);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("type"), format!("{ty}\n")).unwrap();
        std::fs::write(d.join("current_value"), format!("{value}\n")).unwrap();
        std::fs::write(d.join("display_name"), format!("{name}\n")).unwrap();
        if !possible.is_empty() {
            std::fs::write(d.join(if ty == "ordered-list" { "elements" } else { "possible_values" }), possible.join(";")).unwrap();
        }
    }

    fn dmi(base: &Path, vendor: &str, product: &str) {
        let d = base.join("dmi");
        std::fs::create_dir_all(&d).unwrap();
        for (f, v) in [("sys_vendor", vendor), ("product_name", product), ("bios_vendor", vendor), ("bios_version", "1.2.3"), ("bios_date", "03/14/2026")] {
            std::fs::write(d.join(f), format!("{v}\n")).unwrap();
        }
        std::fs::create_dir_all(base.join("efi")).unwrap();
    }

    fn value(base: &Path, driver: &str, name: &str) -> String {
        std::fs::read_to_string(base.join("fwattr").join(driver).join("attributes").join(name).join("current_value")).unwrap().trim().to_string()
    }

    /// A firmware area over fake sysfs trees in `base`.
    fn area(name: &str) -> (PathBuf, Firmware, Arc<FakeReboot>) {
        let (base, data) = enrolled(name);
        let mut cfg = serde_json::to_value(data.config().unwrap()).unwrap();
        cfg["firmware"] = json!({ "sysfsRoot": base.join("fwattr"), "dmiRoot": base.join("dmi"), "efiDir": base.join("efi") });
        write_json(&data.config_path(), &cfg, false).unwrap();
        let reboot = Arc::new(FakeReboot::default());
        let mut f = Firmware::new(data, reboot.clone());
        f.tools = Tools { dirs: vec![base.join("bin")] };
        f.reboot_delay = Duration::from_millis(10);
        f.watch.boot_id_path = base.join("boot_id");
        std::fs::write(&f.watch.boot_id_path, "boot-1").unwrap();
        (base, f, reboot)
    }

    fn dell(base: &Path) {
        dmi(base, "Dell Inc.", "OptiPlex 7010");
        let r = base.join("fwattr/dell-wmi-sysman");
        attr(&r, "WakeOnLan", "enumeration", "Disabled", &["Disabled", "LanOnly", "LanWlan"]);
        attr(&r, "AcPwrRcvry", "enumeration", "Last", &["Off", "On", "Last"]);
        attr(&r, "Virtualization", "enumeration", "Enabled", &["Disabled", "Enabled"]);
        attr(&r, "SecureBoot", "enumeration", "Enabled", &["Disabled", "Enabled"]);
        attr(&r, "TpmSecurity", "enumeration", "Enabled", &["Disabled", "Enabled"]);
        attr(&r, "ThermalManagement", "enumeration", "Optimized", &["Optimized", "Cool", "Quiet", "UltraPerformance"]);
        // Not in the allowlist: never shown, never written.
        attr(&r, "UefiNwStack", "enumeration", "Enabled", &["Disabled", "Enabled"]);
        std::fs::create_dir_all(r.join("authentication/Admin")).unwrap();
        std::fs::write(r.join("authentication/Admin/is_enabled"), "0\n").unwrap();
        std::fs::write(r.join("authentication/Admin/current_password"), "").unwrap();
    }

    fn allow(f: &Firmware, on: bool) {
        f.data.save_privileged_policy(&json!({ "firmwareChanges": on, "lowLevelBoot": false })).unwrap();
    }

    fn reason(e: &OpError) -> String {
        e.details.as_ref().and_then(|d| d["reason"].as_str()).unwrap_or(&e.code).to_string()
    }

    fn apply_body(plan: &Value, changes: Value, extra: Value) -> Value {
        let mut b = json!({ "planId": plan["planId"], "snapshotId": plan["snapshot"]["id"], "changes": changes, "reboot": false });
        for (k, v) in extra.as_object().unwrap() {
            b[k] = v.clone();
        }
        signed(&HUB_SEED, "firmware.apply", &b, NOW)
    }

    #[test]
    fn reads_a_dell_through_the_firmware_attributes_class() {
        let (base, f, _) = area("fw-dell");
        dell(&base);
        let r = f.read().unwrap();
        assert_eq!((r["supported"].as_bool(), r["method"].as_str(), r["adminPasswordSet"].as_bool()), (Some(true), Some("firmware-attributes"), Some(false)));
        assert_eq!((r["platform"]["vendor"].as_str(), r["platform"]["product"].as_str(), r["platform"]["uefi"].as_bool()), (Some("Dell Inc."), Some("OptiPlex 7010"), Some(true)));
        let keys: Vec<&str> = r["settings"].as_array().unwrap().iter().map(|s| s["key"].as_str().unwrap()).collect();
        assert_eq!(keys, vec!["wol", "powerOnAfterPowerLoss", "virtualization", "secureBoot", "tpm", "fanProfile"]);
        let sb = &r["settings"][3];
        assert_eq!((sb["vendorKey"].as_str(), sb["type"].as_str(), sb["securityDegrading"].clone()), (Some("SecureBoot"), Some("enum"), json!(["Disabled"])));
        assert_eq!(r["settings"][0]["securityDegrading"], json!([]));
        assert_eq!(r["updates"], json!([]), "no fwupdmgr here");
        assert_eq!(f.after_power_loss(), Some("last"));
        assert!(f.supported());
        // Not allowed for this device: nothing is read.
        f.data.save_hub_config(&crate::state::HubConfig { policy: crate::state::DevicePolicy { allowed_modules: Some(vec!["storage".into()]), ..Default::default() }, ..Default::default() }).unwrap();
        assert_eq!(reason(&f.read().unwrap_err()), "module_not_allowed");
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn plans_applies_and_rolls_back_on_a_dell() {
        let (base, f, reboot) = area("fw-apply");
        dell(&base);
        let plan = f.plan(&json!({ "changes": [
            { "key": "wol", "value": "LanOnly" }, { "key": "powerOnAfterPowerLoss", "value": "On" },
            { "key": "virtualization", "value": "Enabled" }, { "key": "bootOrder", "value": "x" },
            { "key": "UefiNwStack", "value": "Disabled" }, { "key": "fanProfile", "value": "Turbo" },
        ] })).unwrap();
        assert_eq!(plan["diff"], json!([
            { "key": "wol", "vendorKey": "WakeOnLan", "from": "Disabled", "to": "LanOnly", "securityDegrading": false },
            { "key": "powerOnAfterPowerLoss", "vendorKey": "AcPwrRcvry", "from": "Last", "to": "On", "securityDegrading": false },
        ]));
        assert_eq!(plan["refused"], json!([{ "key": "bootOrder", "reason": "unsupported" }, { "key": "UefiNwStack", "reason": "unknown_key" }, { "key": "fanProfile", "reason": "not_allowed_value" }]));
        assert_eq!(plan["requiresReboot"], true);
        assert_eq!(plan["snapshot"]["values"]["wol"], "Disabled");
        let snap_file = f.snapshots().join(format!("{}.json", plan["snapshot"]["id"].as_str().unwrap()));
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&snap_file).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(value(&base, "dell-wmi-sysman", "WakeOnLan"), "Disabled", "a plan changes nothing");
        let changes = json!([{ "key": "wol", "value": "LanOnly" }, { "key": "powerOnAfterPowerLoss", "value": "On" }]);
        // Impossible until the Hub turns changes on, even with a valid authorization.
        let body = apply_body(&plan, changes.clone(), json!({}));
        assert_eq!(f.apply(&body, Transport::Plain, NOW).unwrap_err().code, "firmware_disabled");
        allow(&f, true);
        let r = f.apply(&body, Transport::Plain, NOW).unwrap();
        assert_eq!(r["applied"], json!([{ "key": "wol", "from": "Disabled", "to": "LanOnly" }, { "key": "powerOnAfterPowerLoss", "from": "Last", "to": "On" }]));
        assert_eq!((r["pendingReboot"].as_bool(), r["watchdog"].clone()), (Some(true), Value::Null));
        assert_eq!(value(&base, "dell-wmi-sysman", "WakeOnLan"), "LanOnly");
        assert_eq!(f.after_power_loss(), Some("on"));
        assert_eq!(reboot.calls.load(Ordering::SeqCst), 0, "reboot: false restarts nothing");
        // The same request again: a replay. A new authorization: the values moved since the plan.
        assert_eq!(reason(&f.apply(&body, Transport::Plain, NOW).unwrap_err()), "replayed");
        assert_eq!(reason(&f.apply(&apply_body(&plan, changes.clone(), json!({})), Transport::Plain, NOW).unwrap_err()), "base_mismatch");
        // Rollback to the snapshot.
        let rb = signed(&HUB_SEED, "firmware.rollback", &json!({ "snapshotId": plan["snapshot"]["id"] }), NOW);
        let r = f.rollback(&rb, Transport::Plain, NOW).unwrap();
        assert_eq!(r["restored"].as_array().unwrap().len(), 2);
        assert_eq!(value(&base, "dell-wmi-sysman", "WakeOnLan"), "Disabled");
        assert_eq!(value(&base, "dell-wmi-sysman", "AcPwrRcvry"), "Last");
        // Another plan id with this snapshot: refused.
        let wrong = apply_body(&json!({ "planId": "p-other", "snapshot": plan["snapshot"] }), changes, json!({}));
        assert_eq!(reason(&f.apply(&wrong, Transport::Plain, NOW).unwrap_err()), "plan_mismatch");
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn security_degrading_changes_need_the_separate_override() {
        let (base, f, _) = area("fw-degrade");
        dell(&base);
        allow(&f, true);
        let plan = f.plan(&json!({ "changes": [{ "key": "secureBoot", "value": "Disabled" }, { "key": "tpm", "value": "Disabled" }] })).unwrap();
        assert_eq!(plan["diff"][0]["securityDegrading"], true);
        let changes = plan["diff"].as_array().unwrap().iter().map(|d| json!({ "key": d["key"], "value": d["to"] })).collect::<Vec<_>>();
        let e = f.apply(&apply_body(&plan, json!(changes), json!({})), Transport::Plain, NOW).unwrap_err();
        assert_eq!((reason(&e).as_str(), e.status), ("security_degrading", 403));
        assert_eq!(value(&base, "dell-wmi-sysman", "SecureBoot"), "Enabled");
        // The override travels in the body, so the signature covers it.
        let r = f.apply(&apply_body(&plan, json!(changes), json!({ "allowSecurityDegrading": true })), Transport::Plain, NOW).unwrap();
        assert_eq!(r["applied"].as_array().unwrap().len(), 2);
        assert_eq!(value(&base, "dell-wmi-sysman", "SecureBoot"), "Disabled");
        // Rolling back turns them on again: not degrading, no override needed.
        let rb = signed(&HUB_SEED, "firmware.rollback", &json!({ "snapshotId": plan["snapshot"]["id"] }), NOW);
        f.rollback(&rb, Transport::Plain, NOW).unwrap();
        assert_eq!(value(&base, "dell-wmi-sysman", "SecureBoot"), "Enabled");
        // A device with a certificate takes none of this over plain HTTP.
        std::fs::write(f.data.path().join(crate::tls::DEVICE_CERT_FILE), "x").unwrap();
        let again = f.plan(&json!({ "changes": [{ "key": "wol", "value": "LanOnly" }] })).unwrap();
        let body = apply_body(&again, json!([{ "key": "wol", "value": "LanOnly" }]), json!({}));
        assert_eq!(reason(&f.apply(&body, Transport::Plain, NOW).unwrap_err()), "tls_required");
        assert!(f.apply(&body, Transport::MutualTls, NOW).is_ok());
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn handles_lenovo_boot_orders() {
        let (base, f, _) = area("fw-lenovo");
        dmi(&base, "LENOVO", "ThinkCentre M90q");
        let r = base.join("fwattr/thinklmi");
        attr(&r, "WakeOnLAN", "enumeration", "ACOnly", &["Disable", "ACOnly", "ACandBattery", "Enable"]);
        attr(&r, "After Power Loss", "enumeration", "Power Off", &["Power Off", "Power On", "Last State"]);
        attr(&r, "BootOrder", "enumeration", "NVMe0:USBHDD:PXEBOOT", &["NVMe0", "USBHDD", "PXEBOOT", "USBCD"]);
        attr(&r, "SecurityChip", "enumeration", "Active", &["Active", "Inactive", "Disable"]);
        allow(&f, true);
        let read = f.read().unwrap();
        let tpm = read["settings"].as_array().unwrap().iter().find(|s| s["key"] == "tpm").unwrap().clone();
        assert_eq!(tpm["securityDegrading"], json!(["Inactive", "Disable"]));
        assert_eq!(f.after_power_loss(), Some("off"));
        let plan = f.plan(&json!({ "changes": [{ "key": "bootOrder", "value": ["PXEBOOT", "NVMe0", "USBHDD"] }] })).unwrap();
        assert_eq!(plan["diff"][0]["to"], "PXEBOOT:NVMe0:USBHDD");
        // Dropping or adding an entry is refused: a boot order is only reordered.
        for bad in [json!("PXEBOOT:NVMe0"), json!("PXEBOOT:NVMe0:USBHDD:USBCD"), json!("NVMe0:NVMe0:USBHDD"), json!(7)] {
            let p = f.plan(&json!({ "changes": [{ "key": "bootOrder", "value": bad }] })).unwrap();
            assert_eq!(p["refused"][0]["reason"], "not_allowed_value", "{bad}");
        }
        let body = apply_body(&plan, json!([{ "key": "bootOrder", "value": ["PXEBOOT", "NVMe0", "USBHDD"] }]), json!({}));
        f.apply(&body, Transport::Plain, NOW).unwrap();
        assert_eq!(value(&base, "thinklmi", "BootOrder"), "PXEBOOT:NVMe0:USBHDD");
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn handles_hp_admin_passwords_and_read_only_settings() {
        let (base, f, _) = area("fw-hp");
        dmi(&base, "HP", "EliteDesk 800 G6");
        let r = base.join("fwattr/hp-bioscfg");
        attr(&r, "Wake On LAN", "enumeration", "Disable", &["Disable", "Boot to Network", "Follow Boot Order"]);
        attr(&r, "UEFI Boot Order", "ordered-list", "HDD:M.2:1,NETWORK IPV4:EMBEDDED:1", &["HDD:M.2:1", "NETWORK IPV4:EMBEDDED:1"]);
        attr(&r, "Secure Boot", "enumeration", "Enable", &["Disable", "Enable"]);
        std::fs::write(r.join("attributes/Secure Boot/is_readonly"), "1\n").unwrap();
        std::fs::create_dir_all(r.join("authentication/Admin")).unwrap();
        std::fs::write(r.join("authentication/Admin/is_enabled"), "1\n").unwrap();
        std::fs::write(r.join("authentication/Admin/current_password"), "").unwrap();
        allow(&f, true);
        let read = f.read().unwrap();
        assert_eq!(read["adminPasswordSet"], true);
        let order = read["settings"].as_array().unwrap().iter().find(|s| s["key"] == "bootOrder").unwrap().clone();
        assert_eq!((order["type"].as_str(), order["allowed"].clone()), (Some("order"), json!(["HDD:M.2:1", "NETWORK IPV4:EMBEDDED:1"])));
        let plan = f.plan(&json!({ "changes": [{ "key": "wol", "value": "Boot to Network" }, { "key": "secureBoot", "value": "Disable" }, { "key": "fanProfile", "value": "Quiet" }] })).unwrap();
        assert_eq!(plan["refused"], json!([{ "key": "secureBoot", "reason": "read_only" }, { "key": "fanProfile", "reason": "unsupported" }]));
        let changes = json!([{ "key": "wol", "value": "Boot to Network" }]);
        assert_eq!(reason(&f.apply(&apply_body(&plan, changes.clone(), json!({})), Transport::Plain, NOW).unwrap_err()), "admin_password_required");
        // The password is part of the request, not of what the Hub hashed: the signature still holds.
        let mut body = apply_body(&plan, changes, json!({}));
        body["adminPassword"] = json!("bios-secret");
        // Never over plain HTTP, whether or not the device holds a certificate.
        assert_eq!(reason(&f.apply(&body, Transport::Plain, NOW).unwrap_err()), "tls_required");
        f.apply(&body, Transport::MutualTls, NOW).unwrap();
        assert_eq!(value(&base, "hp-bioscfg", "Wake On LAN"), "Boot to Network");
        assert_eq!(std::fs::read_to_string(r.join("authentication/Admin/current_password")).unwrap(), "", "given, then cleared");
        std::fs::remove_dir_all(&base).unwrap();
    }

    fn fake_area(name: &str) -> (PathBuf, Firmware, Arc<FakeReboot>, PathBuf) {
        let (base, f, reboot) = area(name);
        let file = base.join("firmware.json");
        write_json(&file, &json!({
            "platform": { "vendor": "Nova Labs", "product": "Fake PC", "biosVendor": "Nova", "biosVersion": "0.1", "biosDate": "2026-10-01", "uefi": true },
            "adminPasswordSet": false, "requiresReboot": true,
            "settings": {
                "wol": { "vendorKey": "WakeOnLan", "value": "Disabled", "type": "enum", "allowed": ["Disabled", "Enabled"] },
                "powerOnAfterPowerLoss": { "vendorKey": "AcPower", "value": "Off", "type": "enum", "allowed": ["Off", "On", "Last"] },
                "virtualization": { "vendorKey": "Vt", "value": "Enabled", "type": "enum", "allowed": ["Disabled", "Enabled"] },
            },
            "failWrites": [],
        }), false).unwrap();
        let mut cfg = serde_json::to_value(f.data.config().unwrap()).unwrap();
        cfg["firmware"] = json!({ "backend": "fake", "fakePath": file });
        write_json(&f.data.config_path(), &cfg, false).unwrap();
        allow(&f, true);
        (base, f, reboot, file)
    }

    fn fake_value(file: &Path, key: &str) -> String {
        read_json_or::<Value>(file, Value::Null).unwrap()["settings"][key]["value"].as_str().unwrap().to_string()
    }

    #[test]
    fn a_failed_write_midway_restores_the_snapshot() {
        let (base, f, _, file) = fake_area("fw-fail");
        let plan = f.plan(&json!({ "changes": [{ "key": "wol", "value": "Enabled" }, { "key": "powerOnAfterPowerLoss", "value": "On" }, { "key": "virtualization", "value": "Disabled" }] })).unwrap();
        let mut v: Value = read_json_or(&file, Value::Null).unwrap();
        v["failWrites"] = json!(["virtualization"]);
        write_json(&file, &v, false).unwrap();
        let changes = json!([{ "key": "wol", "value": "Enabled" }, { "key": "powerOnAfterPowerLoss", "value": "On" }, { "key": "virtualization", "value": "Disabled" }]);
        let e = f.apply(&apply_body(&plan, changes, json!({})), Transport::Plain, NOW).unwrap_err();
        assert_eq!(e.status, 500);
        assert_eq!(e.details.clone().unwrap(), json!({ "reason": "apply_failed", "restored": true, "key": "virtualization" }));
        assert_eq!((fake_value(&file, "wol"), fake_value(&file, "powerOnAfterPowerLoss"), fake_value(&file, "virtualization")), ("Disabled".into(), "Off".into(), "Enabled".into()));
        std::fs::remove_dir_all(&base).unwrap();
    }

    fn apply_with_reboot(f: &Firmware) -> Value {
        let plan = f.plan(&json!({ "changes": [{ "key": "wol", "value": "Enabled" }] })).unwrap();
        let body = apply_body(&plan, json!([{ "key": "wol", "value": "Enabled" }]), json!({ "reboot": true, "watchdogSeconds": 300 }));
        let r = f.apply(&body, Transport::Plain, NOW).unwrap();
        assert_eq!(r["watchdog"]["deadline"], iso(NOW + 300_000));
        plan
    }

    #[test]
    fn the_watchdog_restores_and_restarts_once_without_a_heartbeat() {
        let (base, f, reboot, file) = fake_area("fw-wd");
        let plan = apply_with_reboot(&f);
        assert!(wait_for(|| reboot.calls.load(Ordering::SeqCst) == 1), "the restart the owner approved");
        assert_eq!(fake_value(&file, "wol"), "Enabled");
        // The machine restarted; the Hub never answers.
        std::fs::write(&f.watch.boot_id_path, "boot-2").unwrap();
        f.on_start();
        f.tick(NOW + 299_000);
        assert_eq!(fake_value(&file, "wol"), "Enabled", "not yet");
        f.tick(NOW + 301_000);
        assert_eq!(fake_value(&file, "wol"), "Disabled", "the snapshot is back");
        assert_eq!(reboot.calls.load(Ordering::SeqCst), 2, "one restart into the restored settings");
        let ev = f.outbox.pending();
        assert_eq!(ev.len(), 1);
        assert_eq!((ev[0]["kind"].as_str(), ev[0]["snapshotId"].clone(), ev[0]["detail"]["reason"].as_str()), (Some("firmware.watchdog.reverted"), plan["snapshot"]["id"].clone(), Some("deadline")));
        assert_eq!(ev[0]["detail"]["restored"], json!([{ "key": "wol", "from": "Enabled", "to": "Disabled" }]));
        // Never loops: no marker at the next start, and this snapshot gets no second watchdog.
        assert!(f.watch.pending().is_none());
        f.on_start();
        f.tick(NOW + 400_000);
        assert_eq!(reboot.calls.load(Ordering::SeqCst), 2);
        let body = apply_body(&plan, json!([{ "key": "wol", "value": "Enabled" }]), json!({ "reboot": true }));
        assert_eq!(reason(&f.apply(&body, Transport::Plain, NOW).unwrap_err()), "watchdog_already_used");
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn a_revert_that_fails_part_way_keeps_what_it_restored_and_says_so() {
        let (base, f, reboot, file) = fake_area("fw-wd-partial");
        let plan = f.plan(&json!({ "changes": [{ "key": "wol", "value": "Enabled" }, { "key": "virtualization", "value": "Disabled" }] })).unwrap();
        let body = apply_body(&plan, json!([{ "key": "wol", "value": "Enabled" }, { "key": "virtualization", "value": "Disabled" }]), json!({ "reboot": true, "watchdogSeconds": 300 }));
        f.apply(&body, Transport::Plain, NOW).unwrap();
        assert!(wait_for(|| reboot.calls.load(Ordering::SeqCst) == 1));
        let mut v: Value = read_json_or(&file, Value::Null).unwrap();
        v["failWrites"] = json!(["virtualization"]);
        write_json(&file, &v, false).unwrap();
        std::fs::write(&f.watch.boot_id_path, "boot-2").unwrap();
        f.on_start();
        f.tick(NOW + 301_000);
        assert_eq!((fake_value(&file, "wol"), fake_value(&file, "virtualization")), ("Disabled".into(), "Disabled".into()), "wol restored and kept; virtualization could not be");
        let d = f.outbox.pending()[0]["detail"].clone();
        assert_eq!((d["complete"].as_bool(), d["rebooted"].as_bool()), (Some(false), Some(false)));
        assert_eq!(d["restored"], json!([{ "key": "wol", "from": "Enabled", "to": "Disabled" }]));
        assert_eq!((d["failed"][0]["key"].as_str(), d["failed"][0]["error"].as_str(), d["failed"][0]["to"].as_str()), (Some("virtualization"), Some("write_failed"), Some("Enabled")));
        assert_eq!(reboot.calls.load(Ordering::SeqCst), 1, "a machine left half way is not restarted");
        assert_eq!(f.outbox.pending()[0]["changeId"].as_str().map(str::len), Some(36));
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn a_protected_bios_cannot_be_reverted_and_says_which_keys() {
        let (base, f, reboot, file) = fake_area("fw-wd-locked");
        let mut v: Value = read_json_or(&file, Value::Null).unwrap();
        v["adminPasswordSet"] = json!(true);
        v["adminPassword"] = json!("pw");
        write_json(&file, &v, false).unwrap();
        let plan = f.plan(&json!({ "changes": [{ "key": "wol", "value": "Enabled" }] })).unwrap();
        let mut body = apply_body(&plan, json!([{ "key": "wol", "value": "Enabled" }]), json!({ "reboot": true }));
        body["adminPassword"] = json!("pw");
        f.apply(&body, Transport::MutualTls, NOW).unwrap();
        std::fs::write(&f.watch.boot_id_path, "boot-2").unwrap();
        f.on_start();
        f.tick(NOW + 601_000);
        assert_eq!(fake_value(&file, "wol"), "Enabled");
        let d = f.outbox.pending()[0]["detail"].clone();
        assert_eq!((d["complete"].as_bool(), d["failed"][0]["error"].as_str(), d["restored"].clone()), (Some(false), Some("admin_password_required"), json!([])));
        assert!(wait_for(|| reboot.calls.load(Ordering::SeqCst) == 1));
        std::thread::sleep(Duration::from_millis(30));
        assert_eq!(reboot.calls.load(Ordering::SeqCst), 1);
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn the_marker_is_written_before_the_change_and_removed_when_it_fails() {
        let (base, f, reboot, file) = fake_area("fw-marker");
        let plan = f.plan(&json!({ "changes": [{ "key": "wol", "value": "Enabled" }, { "key": "virtualization", "value": "Disabled" }] })).unwrap();
        let changes = json!([{ "key": "wol", "value": "Enabled" }, { "key": "virtualization", "value": "Disabled" }]);
        // The marker cannot be written: nothing is changed.
        std::fs::create_dir_all(f.watch.dir.clone()).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&f.watch.dir, std::fs::Permissions::from_mode(0o500)).unwrap();
        let blocked = f.apply(&apply_body(&plan, changes.clone(), json!({ "reboot": true })), Transport::Plain, NOW);
        std::fs::set_permissions(&f.watch.dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        match blocked {
            Err(_) => assert_eq!(fake_value(&file, "wol"), "Disabled", "no marker, no change"),
            // Root ignores the folder's mode: the marker was written and the change made.
            Ok(_) => {
                assert!(crate::hardening::is_root());
                f.watch.clear();
                let mut v: Value = read_json_or(&file, Value::Null).unwrap();
                v["settings"]["wol"]["value"] = json!("Disabled");
                v["settings"]["virtualization"]["value"] = json!("Enabled");
                write_json(&file, &v, false).unwrap();
                assert!(wait_for(|| reboot.calls.load(Ordering::SeqCst) == 1));
                reboot.calls.store(0, Ordering::SeqCst);
            }
        }
        // The change fails: its marker goes with it, and nothing restarts.
        let mut v: Value = read_json_or(&file, Value::Null).unwrap();
        v["failWrites"] = json!(["virtualization"]);
        write_json(&file, &v, false).unwrap();
        let plan = f.plan(&json!({ "changes": [{ "key": "wol", "value": "Enabled" }, { "key": "virtualization", "value": "Disabled" }] })).unwrap();
        assert_eq!(reason(&f.apply(&apply_body(&plan, changes, json!({ "reboot": true })), Transport::Plain, NOW).unwrap_err()), "apply_failed");
        assert!(f.watch.pending().is_none());
        std::thread::sleep(Duration::from_millis(50));
        assert_eq!(reboot.calls.load(Ordering::SeqCst), 0);
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn the_first_heartbeat_after_the_restart_confirms_the_change() {
        let (base, f, reboot, file) = fake_area("fw-wd-ok");
        let plan = apply_with_reboot(&f);
        assert!(wait_for(|| reboot.calls.load(Ordering::SeqCst) == 1));
        // One guarded restart at a time.
        let next = f.plan(&json!({ "changes": [{ "key": "powerOnAfterPowerLoss", "value": "On" }] })).unwrap();
        let second = apply_body(&next, json!([{ "key": "powerOnAfterPowerLoss", "value": "On" }]), json!({ "reboot": true }));
        assert_eq!(reason(&f.apply(&second, Transport::Plain, NOW).unwrap_err()), "watchdog_pending");
        // Only novad restarted (same boot): a beat confirms nothing yet.
        f.on_start();
        f.on_beat(NOW + 1000);
        assert!(f.watch.pending().is_some());
        std::fs::write(&f.watch.boot_id_path, "boot-2").unwrap();
        f.on_start();
        f.on_beat(NOW + 60_000);
        assert!(f.watch.pending().is_none());
        let ev = f.outbox.pending();
        assert_eq!((ev[0]["kind"].as_str(), ev[0]["snapshotId"].clone()), (Some("firmware.watchdog.ok"), plan["snapshot"]["id"].clone()));
        f.tick(NOW + 900_000);
        assert_eq!(fake_value(&file, "wol"), "Enabled", "kept");
        assert_eq!(reboot.calls.load(Ordering::SeqCst), 1);
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn a_restart_that_never_happens_reverts_without_restarting() {
        let (base, f, reboot, file) = fake_area("fw-wd-none");
        reboot.refuse.store(true, Ordering::SeqCst);
        let plan = f.plan(&json!({ "changes": [{ "key": "wol", "value": "Enabled" }] })).unwrap();
        let body = apply_body(&plan, json!([{ "key": "wol", "value": "Enabled" }]), json!({ "reboot": true }));
        assert_eq!(reason(&f.apply(&body, Transport::Plain, NOW).unwrap_err()), "reboot_unavailable");
        assert_eq!(fake_value(&file, "wol"), "Disabled", "refused before anything was written");
        // Allowed when checked, refused when the time came: the marker of this boot runs out.
        reboot.refuse.store(false, Ordering::SeqCst);
        apply_with_reboot(&f);
        f.tick(NOW + 301_000);
        assert_eq!(fake_value(&file, "wol"), "Disabled");
        assert_eq!(f.outbox.pending()[0]["detail"]["reason"], "not_restarted");
        assert!(wait_for(|| reboot.calls.load(Ordering::SeqCst) == 1));
        std::thread::sleep(Duration::from_millis(50));
        assert_eq!(reboot.calls.load(Ordering::SeqCst), 1, "the watchdog itself does not restart a machine that never restarted");
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn rolls_back_from_the_hubs_copy() {
        let (base, f, _, file) = fake_area("fw-hubcopy");
        let plan = f.plan(&json!({ "changes": [{ "key": "wol", "value": "Enabled" }] })).unwrap();
        f.apply(&apply_body(&plan, json!([{ "key": "wol", "value": "Enabled" }]), json!({})), Transport::Plain, NOW).unwrap();
        let id = plan["snapshot"]["id"].as_str().unwrap();
        std::fs::remove_file(f.snapshots().join(format!("{id}.json"))).unwrap();
        let missing = signed(&HUB_SEED, "firmware.rollback", &json!({ "snapshotId": id }), NOW);
        assert_eq!(reason(&f.rollback(&missing, Transport::Plain, NOW).unwrap_err()), "snapshot_missing");
        let mut tampered = plan["snapshot"].clone();
        tampered["values"]["wol"] = json!("Enabled");
        let bad = signed(&HUB_SEED, "firmware.rollback", &json!({ "snapshotId": id, "snapshot": { "values": tampered["values"], "sha256": tampered["sha256"] } }), NOW);
        assert_eq!(reason(&f.rollback(&bad, Transport::Plain, NOW).unwrap_err()), "snapshot_mismatch");
        let good = signed(&HUB_SEED, "firmware.rollback", &json!({ "snapshotId": id, "snapshot": { "values": plan["snapshot"]["values"], "sha256": plan["snapshot"]["sha256"] } }), NOW);
        assert_eq!(f.rollback(&good, Transport::Plain, NOW).unwrap()["restored"], json!([{ "key": "wol", "from": "Enabled", "to": "Disabled" }]));
        assert_eq!(fake_value(&file, "wol"), "Disabled");
        assert_eq!(reason(&f.rollback(&signed(&HUB_SEED, "firmware.rollback", &json!({ "snapshotId": "../../etc/passwd" }), NOW), Transport::Plain, NOW).unwrap_err()), "validation");
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn keeps_twenty_snapshots() {
        let (base, f, _, _) = fake_area("fw-prune");
        for _ in 0..23 {
            f.plan(&json!({ "changes": [{ "key": "wol", "value": "Enabled" }] })).unwrap();
            std::thread::sleep(Duration::from_millis(2));
        }
        assert_eq!(std::fs::read_dir(f.snapshots()).unwrap().count(), 20);
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn refuses_unsupported_hardware_clearly() {
        let (base, mut f, _) = area("fw-unsupported");
        allow(&f, true);
        let check = |f: &Firmware, want: &str| {
            let r = f.read().unwrap();
            assert_eq!((r["supported"].as_bool(), r["reason"].as_str(), r["settings"].clone()), (Some(false), Some(want), json!([])));
            let e = f.plan(&json!({ "changes": [{ "key": "wol", "value": "x" }] })).unwrap_err();
            assert_eq!((e.status, e.code.as_str(), reason(&e).as_str(), unsupported_detail(&e)), (409, "conflict", "unsupported_hardware", want));
            let e = f.apply(&signed(&HUB_SEED, "firmware.apply", &json!({}), NOW), Transport::Plain, NOW).unwrap_err();
            assert_eq!((e.code.as_str(), reason(&e).as_str(), unsupported_detail(&e)), ("conflict", "unsupported_hardware", want));
            assert_eq!(f.after_power_loss(), None);
        };
        dmi(&base, "ASUSTeK COMPUTER INC.", "PRIME B550");
        check(&f, "vendor_not_supported");
        dmi(&base, "Supermicro", "X12");
        check(&f, "vendor_not_supported");
        dmi(&base, "Dell Inc.", "OptiPlex");
        check(&f, "driver_missing");
        dmi(&base, "Framework", "Laptop 13");
        check(&f, "tool_missing");
        std::fs::remove_dir_all(base.join("efi")).unwrap();
        check(&f, "vendor_not_supported");
        f.os_supported = false;
        check(&f, "os_not_supported");
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn generic_uefi_changes_the_boot_order_through_efibootmgr() {
        let (base, f, _) = area("fw-uefi");
        dmi(&base, "Framework", "Laptop 13");
        let out = base.join("efi.txt");
        std::fs::write(&out, "BootCurrent: 0001\nBootOrder: 0001,0000\nBoot0000* Windows Boot Manager\nBoot0001* debian\n").unwrap();
        fake_tool(&base.join("bin"), "efibootmgr", &format!("cat '{}'", out.display()));
        allow(&f, true);
        let r = f.read().unwrap();
        assert_eq!((r["method"].as_str(), r["settings"][0]["key"].as_str(), r["settings"][0]["value"].as_str()), (Some("efibootmgr"), Some("bootOrder"), Some("0001,0000")));
        assert_eq!(f.after_power_loss(), None);
        let plan = f.plan(&json!({ "changes": [{ "key": "bootOrder", "value": "0000,0001" }, { "key": "wol", "value": "on" }] })).unwrap();
        assert_eq!((plan["requiresReboot"].as_bool(), plan["refused"][0]["reason"].as_str()), (Some(false), Some("unsupported")));
        f.apply(&apply_body(&plan, json!([{ "key": "bootOrder", "value": "0000,0001" }]), json!({})), Transport::Plain, NOW).unwrap();
        assert!(crate::boot::tests::calls(&base.join("bin")).contains(&"efibootmgr --bootorder 0000,0001".to_string()));
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn lists_fwupd_updates_read_only() {
        let (base, f, _) = area("fw-fwupd");
        dell(&base);
        let json = r#"{"Devices":[{"Name":"System Firmware","Version":"1.2.3","Releases":[{"Version":"1.3.0","Summary":"BIOS update"}]},{"Name":"Webcam","Releases":[]}]}"#;
        fake_tool(&base.join("bin"), "fwupdmgr", &format!("echo '{json}'; exit 2"));
        assert_eq!(f.read().unwrap()["updates"], json!([{ "device": "System Firmware", "version": "1.3.0", "summary": "BIOS update" }]));
        assert_eq!(parse_fwupd("No updatable devices"), Vec::<Value>::new());
        assert_eq!(after_loss_word("Previous State"), "last");
        assert_eq!(after_loss_word("Power On"), "on");
        assert_eq!(after_loss_word("Stay Off"), "off");
        assert_eq!(after_loss_word("whatever"), "unknown");
        assert_eq!(support_matrix().as_array().unwrap().len(), 6);
        assert_eq!(support_matrix()[1]["keys"]["powerOnAfterPowerLoss"], "AfterPowerLoss");
        std::fs::remove_dir_all(&base).unwrap();
    }

    /// The Hub's matrix (packages/shared/src/m75/firmware.ts) is checked against the same fixture
    /// by packages/shared/test/firmware-matrix.test.ts, so a change here that is not made there
    /// fails one of the two.
    #[test]
    fn support_matrix_matches_the_shared_fixture() {
        const FIXTURE: &str = include_str!("../tests/fixtures/firmware-support-matrix.json");
        let want: Value = serde_json::from_str(FIXTURE).unwrap();
        let got = support_matrix();
        assert_eq!(
            got,
            want,
            "update tests/fixtures/firmware-support-matrix.json and packages/shared/src/m75/firmware.ts to:\n{}",
            serde_json::to_string_pretty(&got).unwrap()
        );
    }
}
