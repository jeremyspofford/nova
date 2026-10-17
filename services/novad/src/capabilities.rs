//! Capability document (docs/23 §3, contracts/schemas/device-capability.json).
//! Default: declare everything detectable; the Hub or the user may override later.

use serde::Serialize;
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
}
