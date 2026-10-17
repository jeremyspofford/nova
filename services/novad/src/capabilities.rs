//! Capability document (docs/23 §3, contracts/schemas/device-capability.json; FR-142).
//! Default: declare everything detectable, with defaults for the compute policy. Advanced: the
//! device owner (novad's config) and the Hub (pushed overrides) may override model storage paths,
//! GPU sharing, VRAM reserve, concurrency, quiet hours, routing weight and egress limits. The
//! final document is signed with the device key over its canonical JSON, as compute nodes sign
//! theirs (contracts/hub-api.md §2, ADR-089).

use crate::crypto::{SigningKey, b64url_encode};
use crate::util::{OpError, OpResult};
use serde::Serialize;
use serde_json::{Map, Value, json};
use std::path::Path;

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityDocument {
    pub schema_version: u32,
    pub device_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub roles: Vec<String>,
    pub modules: Vec<String>,
    pub hardware: Hardware,
    pub os: Os,
    pub locale: Locale,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Hardware {
    pub arch: String,
    pub cores: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ram_bytes: Option<u64>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Os {
    pub family: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub init: Option<String>,
    pub sandbox: std::collections::BTreeMap<String, bool>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Locale {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timezone: Option<String>,
}

/// Inputs that differ between machines, gathered once so detection is testable.
pub struct Probe<'a> {
    pub arch: &'a str,
    pub family: &'a str,
    pub cores: u32,
    pub meminfo: Option<String>,
    pub os_release: Option<String>,
    pub hostname: Option<String>,
    pub has_systemd: bool,
    pub has_bwrap: bool,
    pub timezone: Option<String>,
}

impl Probe<'static> {
    pub fn current() -> Self {
        let read = |p: &str| std::fs::read_to_string(p).ok();
        Probe {
            arch: std::env::consts::ARCH,
            family: std::env::consts::OS,
            cores: std::thread::available_parallelism().map(|n| n.get() as u32).unwrap_or(1),
            meminfo: read("/proc/meminfo"),
            os_release: read("/etc/os-release"),
            hostname: read("/etc/hostname").map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
            has_systemd: Path::new("/run/systemd/system").exists(),
            has_bwrap: which("bwrap"),
            timezone: std::env::var("TZ").ok().or_else(|| {
                std::fs::read_link("/etc/localtime")
                    .ok()
                    .and_then(|p| p.to_str().and_then(|s| s.split("zoneinfo/").nth(1).map(str::to_string)))
            }),
        }
    }
}

fn which(bin: &str) -> bool {
    std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).any(|dir| dir.join(bin).is_file()))
        .unwrap_or(false)
}

/// Parse `MemTotal:  16314204 kB` from /proc/meminfo.
pub fn mem_total_bytes(meminfo: &str) -> Option<u64> {
    meminfo
        .lines()
        .find(|l| l.starts_with("MemTotal:"))
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|kb| kb.parse::<u64>().ok())
        .map(|kb| kb * 1024)
}

/// `PRETTY_NAME` (or `VERSION_ID`) from /etc/os-release.
pub fn os_version(os_release: &str) -> Option<String> {
    let field = |key: &str| {
        os_release
            .lines()
            .find_map(|l| l.strip_prefix(key))
            .map(|v| v.trim_matches('"').to_string())
    };
    field("PRETTY_NAME=").or_else(|| field("VERSION_ID="))
}

pub fn detect(device_id: &str, roles: &[&str], probe: &Probe) -> CapabilityDocument {
    let mut sandbox = std::collections::BTreeMap::new();
    if probe.family == "linux" {
        sandbox.insert("bubblewrap".to_string(), probe.has_bwrap);
    }
    CapabilityDocument {
        schema_version: 1,
        device_id: device_id.to_string(),
        name: probe.hostname.clone(),
        roles: roles.iter().map(|r| r.to_string()).collect(),
        modules: vec!["management".to_string()],
        hardware: Hardware {
            arch: probe.arch.to_string(),
            cores: probe.cores.max(1),
            ram_bytes: probe.meminfo.as_deref().and_then(mem_total_bytes),
        },
        os: Os {
            family: probe.family.to_string(),
            version: probe.os_release.as_deref().and_then(os_version),
            init: probe.has_systemd.then(|| "systemd".to_string()),
            sandbox,
        },
        locale: Locale { timezone: probe.timezone.clone() },
    }
}

/// JSON with keys sorted at every level and no whitespace: the bytes the signature covers. It
/// matches the Hub's `canonicalJson` (packages/core/src/nodes/crypto.ts); whole-number floats are
/// written as integers, as JavaScript does.
pub fn canonical_json(v: &Value) -> String {
    let mut out = String::new();
    write_canonical(v, &mut out);
    out
}

fn write_canonical(v: &Value, out: &mut String) {
    match v {
        Value::Object(m) => {
            let mut keys: Vec<&String> = m.keys().collect();
            keys.sort();
            out.push('{');
            for (i, k) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(k).unwrap_or_default());
                out.push(':');
                write_canonical(&m[k.as_str()], out);
            }
            out.push('}');
        }
        Value::Array(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_canonical(x, out);
            }
            out.push(']');
        }
        Value::Number(n) => match n.as_f64() {
            Some(f) if !n.is_i64() && !n.is_u64() && f.fract() == 0.0 && f.abs() < 9_007_199_254_740_992.0 => {
                out.push_str(&format!("{}", f as i64));
            }
            _ => out.push_str(&n.to_string()),
        },
        other => out.push_str(&other.to_string()),
    }
}

/// The Ed25519 signature (base64url) over the document's canonical JSON.
pub fn sign_document(doc: &Value, key: &SigningKey) -> String {
    b64url_encode(&key.sign(canonical_json(doc).as_bytes()))
}

/// The Advanced overrides a device owner or the Hub may set (FR-142), as `section.field` paths.
pub const OVERRIDE_FIELDS: &[&str] = &[
    "models.storagePaths",
    "models.cacheQuotaBytes",
    "computePolicy.gpuSharing",
    "computePolicy.vramReserveBytes",
    "computePolicy.maxConcurrentJobs",
    "computePolicy.maxJobDurationSec",
    "scheduling.quietHours",
    "scheduling.routingWeight",
    "scheduling.energyPriceTier",
    "limits.maxEgressMbps",
    "power.policy",
    "power.thermalLimitC",
    "locale.locale",
];

fn is_quiet_range(s: &str) -> bool {
    let ok = |t: &str| {
        let b = t.as_bytes();
        b.len() == 5 && b[2] == b':' && t[..2].parse::<u8>().is_ok_and(|h| h < 24) && t[3..].parse::<u8>().is_ok_and(|m| m < 60)
    };
    s.split_once('-').is_some_and(|(a, b)| ok(a) && ok(b))
}

/// Check an overrides object: only the fields above, with values of the right shape.
pub fn validate_overrides(v: &Value) -> OpResult<()> {
    let Some(sections) = v.as_object() else { return Err(OpError::validation("overrides must be an object")) };
    for (section, fields) in sections {
        let Some(fields) = fields.as_object() else {
            return Err(OpError::validation(format!("overrides.{section} must be an object")));
        };
        for (field, value) in fields {
            let path = format!("{section}.{field}");
            if !OVERRIDE_FIELDS.contains(&path.as_str()) {
                return Err(OpError::validation(format!("{path} cannot be overridden")));
            }
            let int = |min: u64| value.as_u64().is_some_and(|n| n >= min);
            let ok = match path.as_str() {
                "models.storagePaths" => value.as_array().is_some_and(|a| {
                    a.len() <= 20 && a.iter().all(|p| p.as_str().is_some_and(|s| crate::paths::lexical(s).is_some()))
                }),
                "models.cacheQuotaBytes" | "computePolicy.vramReserveBytes" | "computePolicy.maxConcurrentJobs" => int(0),
                "computePolicy.maxJobDurationSec" => int(1),
                "computePolicy.gpuSharing" => matches!(value.as_str(), Some("exclusive" | "shared")),
                "scheduling.quietHours" => value.as_array().is_some_and(|a| a.len() <= 10 && a.iter().all(|x| x.as_str().is_some_and(is_quiet_range))),
                "scheduling.routingWeight" => value.as_f64().is_some_and(|w| (0.0..=1000.0).contains(&w)),
                "limits.maxEgressMbps" => value.as_f64().is_some_and(|w| (0.0..=100_000.0).contains(&w)),
                "power.thermalLimitC" => value.as_i64().is_some_and(|t| (30..=120).contains(&t)),
                _ => value.as_str().is_some_and(|s| !s.is_empty() && s.len() <= 100),
            };
            if !ok {
                return Err(OpError::validation(format!("{path} has an invalid value")));
            }
        }
    }
    Ok(())
}

/// Merge overrides into the document (section by section, field by field).
pub fn apply_overrides(doc: &mut Value, overrides: &Value) {
    let Some(sections) = overrides.as_object() else { return };
    for (section, fields) in sections {
        let Some(fields) = fields.as_object() else { continue };
        if !doc[section].is_object() {
            doc[section] = Value::Object(Map::new());
        }
        for (field, value) in fields {
            doc[section][field] = value.clone();
        }
    }
}

/// What the rest of the document is built from at runtime.
pub struct Extras<'a> {
    pub modules: Vec<String>,
    /// From the power module: `wakeable`, `macs`, `ac`.
    pub power: Option<&'a Value>,
    pub update_channel: &'a str,
    pub fs_scopes: Vec<String>,
    pub models_dir: Option<String>,
}

/// The full document: detected facts, defaults, then the owner's and the Hub's overrides.
pub fn build(base: &CapabilityDocument, extras: &Extras, local: &Value, hub: &Value) -> Value {
    let mut doc = serde_json::to_value(base).unwrap_or_else(|_| json!({}));
    let mut modules = extras.modules.clone();
    modules.sort();
    modules.dedup();
    doc["modules"] = json!(modules);
    if let Some(p) = extras.power {
        doc["hardware"]["nic"] = json!({ "wol": p["wakeable"].as_bool().unwrap_or(false), "macs": p["macs"].clone() });
        let mut power = json!({ "wakeable": p["wakeable"].as_bool().unwrap_or(false) });
        if let Some(ac) = p["ac"].as_bool() {
            power["ac"] = json!(ac);
        }
        doc["power"] = power;
    }
    doc["data"] = json!({ "updateChannel": extras.update_channel, "telemetryAllowed": false });
    doc["access"] = json!({ "fsScopes": extras.fs_scopes });
    if base.roles.iter().any(|r| r == "compute") {
        if let Some(dir) = &extras.models_dir {
            doc["models"] = json!({ "storagePaths": [dir] });
        }
        doc["computePolicy"] = json!({ "gpuSharing": "shared", "vramReserveBytes": 1_073_741_824u64, "maxConcurrentJobs": 1, "maxJobDurationSec": 3600 });
        doc["scheduling"] = json!({ "quietHours": [], "routingWeight": 1 });
    }
    apply_overrides(&mut doc, local);
    apply_overrides(&mut doc, hub);
    doc
}

#[cfg(test)]
mod tests {
    use super::*;

    fn probe() -> Probe<'static> {
        Probe {
            arch: "x86_64",
            family: "linux",
            cores: 8,
            meminfo: Some("MemTotal:       16314204 kB\nMemFree: 1 kB\n".into()),
            os_release: Some("NAME=\"Ubuntu\"\nPRETTY_NAME=\"Ubuntu 24.04 LTS\"\n".into()),
            hostname: Some("mini".into()),
            has_systemd: true,
            has_bwrap: true,
            timezone: Some("America/Los_Angeles".into()),
        }
    }

    #[test]
    fn parses_meminfo_and_os_release() {
        assert_eq!(mem_total_bytes("MemTotal: 2 kB"), Some(2048));
        assert_eq!(mem_total_bytes("nothing"), None);
        assert_eq!(os_version("VERSION_ID=\"12\""), Some("12".into()));
        assert_eq!(os_version("ID=x"), None);
    }

    #[test]
    fn builds_a_document_with_camel_case_fields() {
        let doc = detect("dev-1", &["client", "compute"], &probe());
        let json = serde_json::to_value(&doc).unwrap();
        assert_eq!(json["schemaVersion"], 1);
        assert_eq!(json["deviceId"], "dev-1");
        assert_eq!(json["roles"], serde_json::json!(["client", "compute"]));
        assert_eq!(json["hardware"]["ramBytes"], 16314204u64 * 1024);
        assert_eq!(json["os"]["init"], "systemd");
        assert_eq!(json["os"]["sandbox"]["bubblewrap"], true);
        assert_eq!(json["locale"]["timezone"], "America/Los_Angeles");
    }

    #[test]
    fn omits_unknown_fields_instead_of_guessing() {
        let p = Probe { meminfo: None, os_release: None, hostname: None, has_systemd: false, timezone: None, family: "macos", cores: 0, ..probe() };
        let json = serde_json::to_value(detect("d", &["client"], &p)).unwrap();
        assert!(json["hardware"].get("ramBytes").is_none());
        assert!(json["os"].get("init").is_none());
        assert!(json.get("name").is_none());
        assert_eq!(json["hardware"]["cores"], 1);
        assert!(json["os"]["sandbox"].as_object().unwrap().is_empty());
    }

    #[test]
    fn canonical_json_sorts_keys_and_writes_integers() {
        let v = json!({"b": [1, {"z": 1, "a": 2.0}], "a": "x\n\"y\"", "c": null, "d": 0.5});
        assert_eq!(canonical_json(&v), r#"{"a":"x\n\"y\"","b":[1,{"a":2,"z":1}],"c":null,"d":0.5}"#);
    }

    #[test]
    fn signs_documents_verifiably() {
        let key = SigningKey::from_seed(&[7u8; 32]);
        let doc = json!({"schemaVersion": 1, "deviceId": "d"});
        let sig = sign_document(&doc, &key);
        let raw = crate::crypto::b64url_decode(&sig).unwrap();
        let sig: [u8; 64] = raw.try_into().unwrap();
        assert!(crate::crypto::verify(&key.public_key(), canonical_json(&doc).as_bytes(), &sig));
    }

    #[test]
    fn validates_and_applies_overrides() {
        let ok = json!({"computePolicy": {"vramReserveBytes": 2048, "gpuSharing": "exclusive"}, "scheduling": {"quietHours": ["22:00-07:00"], "routingWeight": 2.5}, "limits": {"maxEgressMbps": 50}, "models": {"storagePaths": ["/mnt/models"]}});
        validate_overrides(&ok).unwrap();
        assert!(validate_overrides(&json!({"hardware": {"cores": 64}})).is_err(), "detected facts cannot be overridden");
        assert!(validate_overrides(&json!({"scheduling": {"quietHours": ["25:00-07:00"]}})).is_err());
        assert!(validate_overrides(&json!({"computePolicy": {"gpuSharing": "all"}})).is_err());
        assert!(validate_overrides(&json!({"models": {"storagePaths": ["rel"]}})).is_err());
        let base = detect("dev", &["client", "compute"], &probe());
        let power = json!({"wakeable": true, "macs": ["aa:bb:cc:dd:ee:ff"], "ac": true});
        let extras = Extras { modules: vec!["storage".into(), "management".into(), "compute".into()], power: Some(&power), update_channel: "beta", fs_scopes: vec!["/p".into()], models_dir: Some("/var/lib/nova/models".into()) };
        let doc = build(&base, &extras, &json!({"computePolicy": {"maxConcurrentJobs": 3}}), &ok);
        assert_eq!(doc["modules"], json!(["compute", "management", "storage"]));
        assert_eq!(doc["hardware"]["nic"]["wol"], true);
        assert_eq!(doc["power"]["wakeable"], true);
        assert_eq!(doc["data"]["updateChannel"], "beta");
        assert_eq!(doc["computePolicy"]["maxConcurrentJobs"], 3, "the owner's override");
        assert_eq!(doc["computePolicy"]["vramReserveBytes"], 2048, "the Hub's override");
        assert_eq!(doc["computePolicy"]["maxJobDurationSec"], 3600, "a default");
        assert_eq!(doc["scheduling"]["quietHours"], json!(["22:00-07:00"]));
        assert_eq!(doc["models"]["storagePaths"], json!(["/mnt/models"]));
        assert_eq!(doc["access"]["fsScopes"], json!(["/p"]));
        // A client without the compute role gets no compute policy.
        let client = build(&detect("d", &["client"], &probe()), &extras, &json!({}), &json!({}));
        assert!(client.get("computePolicy").is_none());
    }
}
