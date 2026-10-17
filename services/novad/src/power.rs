//! Power and Wake-on-LAN (FR-144, docs/23 §5.3). novad reports whether the device can be woken
//! (a physical NIC that supports and has magic-packet wake enabled), plans the commands that would
//! enable it, and applies them only behind an explicit flag with elevation. Sleep, restart and
//! shutdown run only when the device owner turned power actions on in the local config.
//! Power-on-after-power-loss is a firmware setting: it is reported as unknown until the firmware
//! module (FR-146) can read it.

use crate::util::{OpError, OpResult};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

/// Runs a program and returns (exit code, stdout, stderr). Tests substitute it.
pub trait Runner: Send + Sync {
    fn run(&self, argv: &[String]) -> std::io::Result<(i32, String, String)>;
}

pub struct SystemRunner;

impl Runner for SystemRunner {
    fn run(&self, argv: &[String]) -> std::io::Result<(i32, String, String)> {
        let (prog, args) = argv.split_first().ok_or_else(|| std::io::Error::other("empty command"))?;
        let mut cmd = std::process::Command::new(prog);
        cmd.args(args);
        crate::hardening::harden_command(&mut cmd, &[], crate::hardening::Limits::default());
        let out = cmd.output()?;
        Ok((out.status.code().unwrap_or(-1), String::from_utf8_lossy(&out.stdout).into(), String::from_utf8_lossy(&out.stderr).into()))
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Nic {
    pub name: String,
    pub mac: String,
    /// Wake-on modes the NIC supports (ethtool letters, e.g. `pumbg`); None when unknown.
    pub supports: Option<String>,
    /// Current wake-on modes (`g` = magic packet, `d` = disabled); None when unknown.
    pub wake_on: Option<String>,
    /// The kernel's wakeup flag for the device (`enabled`/`disabled`).
    pub wakeup: Option<String>,
}

impl Nic {
    pub fn magic_supported(&self) -> bool {
        self.supports.as_deref().is_some_and(|s| s.contains('g'))
    }
    pub fn magic_enabled(&self) -> bool {
        self.wake_on.as_deref().is_some_and(|s| s.contains('g'))
    }
}

/// Parse `ethtool <if>` output for the wake-on lines.
pub fn parse_ethtool(out: &str) -> (Option<String>, Option<String>) {
    let mut supports = None;
    let mut wake_on = None;
    for line in out.lines() {
        let l = line.trim();
        if let Some(v) = l.strip_prefix("Supports Wake-on:") {
            supports = Some(v.trim().to_string());
        } else if let Some(v) = l.strip_prefix("Wake-on:") {
            wake_on = Some(v.trim().to_string());
        }
    }
    (supports, wake_on)
}

fn read_trim(p: &Path) -> Option<String> {
    std::fs::read_to_string(p).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// Physical NICs under `sys_net` (`/sys/class/net`): a `device` link marks real hardware;
/// loopback, bridges and virtual interfaces have none.
pub fn detect_nics(sys_net: &Path, runner: &dyn Runner) -> Vec<Nic> {
    let Ok(entries) = std::fs::read_dir(sys_net) else { return vec![] };
    let mut nics: Vec<Nic> = entries
        .flatten()
        .filter_map(|e| {
            let dir = e.path();
            let name = e.file_name().to_string_lossy().to_string();
            if name == "lo" || !dir.join("device").exists() {
                return None;
            }
            let mac = read_trim(&dir.join("address")).filter(|m| m != "00:00:00:00:00:00")?;
            let (supports, wake_on) = match runner.run(&["ethtool".into(), name.clone()]) {
                Ok((0, out, _)) => parse_ethtool(&out),
                _ => (None, None),
            };
            Some(Nic { name, mac, supports, wake_on, wakeup: read_trim(&dir.join("device/power/wakeup")) })
        })
        .collect();
    nics.sort_by(|a, b| a.name.cmp(&b.name));
    nics
}

/// On AC power: any `Mains` supply online. None when the device reports no supplies.
pub fn on_ac(sys_power: &Path) -> Option<bool> {
    let entries = std::fs::read_dir(sys_power).ok()?;
    let mut seen = false;
    for e in entries.flatten() {
        if read_trim(&e.path().join("type")).as_deref() == Some("Mains") {
            seen = true;
            if read_trim(&e.path().join("online")).as_deref() == Some("1") {
                return Some(true);
            }
        }
    }
    if seen { Some(false) } else { None }
}

pub struct Power {
    pub sys_net: PathBuf,
    pub sys_power: PathBuf,
    /// Where persistent link settings go (systemd-networkd `.link` files).
    pub link_dir: PathBuf,
    pub runner: Box<dyn Runner>,
    /// Local config: WoL changes may be applied (still needs elevation and `apply`).
    pub allow_changes: bool,
    /// Local config: sleep, restart and shutdown may run.
    pub allow_actions: bool,
    pub elevated: bool,
}

impl Power {
    pub fn system(allow_changes: bool, allow_actions: bool) -> Self {
        Power {
            sys_net: "/sys/class/net".into(),
            sys_power: "/sys/class/power_supply".into(),
            link_dir: "/etc/systemd/network".into(),
            runner: Box::new(SystemRunner),
            allow_changes,
            allow_actions,
            elevated: crate::hardening::is_root(),
        }
    }

    pub fn status(&self) -> Value {
        let nics = detect_nics(&self.sys_net, self.runner.as_ref());
        let wakeable = nics.iter().any(|n| n.magic_supported() && n.magic_enabled());
        json!({
            "wakeable": wakeable,
            "wol": nics.iter().map(|n| json!({
                "interface": n.name, "mac": n.mac, "supports": n.supports, "wakeOn": n.wake_on,
                "wakeup": n.wakeup, "magicSupported": n.magic_supported(), "magicEnabled": n.magic_enabled(),
            })).collect::<Vec<_>>(),
            "macs": nics.iter().map(|n| n.mac.clone()).collect::<Vec<_>>(),
            "ac": on_ac(&self.sys_power),
            // Needs the firmware module (FR-146, M7.5).
            "afterPowerLoss": "unknown",
            "changesAllowed": self.allow_changes,
            "actionsAllowed": self.allow_actions,
            "elevated": self.elevated,
        })
    }

    /// The steps that would enable magic-packet wake on every capable NIC where it is off: the
    /// immediate ethtool change and a `.link` file so it survives a reboot.
    pub fn wol_plan(&self) -> Vec<Value> {
        detect_nics(&self.sys_net, self.runner.as_ref())
            .into_iter()
            .filter(|n| n.magic_supported() && !n.magic_enabled())
            .flat_map(|n| {
                let file = self.link_dir.join(format!("50-nova-wol-{}.link", n.name));
                vec![
                    json!({ "kind": "command", "argv": ["ethtool", "-s", n.name, "wol", "g"] }),
                    json!({ "kind": "file", "path": file, "content": format!("[Match]\nMACAddress={}\n\n[Link]\nWakeOnLan=magic\n", n.mac) }),
                ]
            })
            .collect()
    }

    /// Enable WoL. Without `apply`, or without the local flag or elevation, nothing changes and
    /// the plan comes back with the reason.
    pub fn wol_enable(&self, apply: bool) -> OpResult<Value> {
        let plan = self.wol_plan();
        if plan.is_empty() {
            return Ok(json!({ "applied": false, "plan": [], "status": self.status() }));
        }
        if !apply {
            return Ok(json!({ "applied": false, "plan": plan }));
        }
        if !self.allow_changes {
            return Err(OpError::denied("power_changes_disabled", "WoL changes are off in this device's novad config").with(json!({ "reason": "power_changes_disabled", "plan": plan })));
        }
        if !self.elevated {
            return Err(OpError::denied("elevation_required", "enabling WoL needs novad to run with elevation").with(json!({ "reason": "elevation_required", "plan": plan })));
        }
        for step in &plan {
            match step["kind"].as_str() {
                Some("command") => {
                    let argv: Vec<String> = step["argv"].as_array().into_iter().flatten().filter_map(|v| v.as_str().map(str::to_string)).collect();
                    let (code, _, err) = self.runner.run(&argv).map_err(|e| OpError::internal(e.to_string()))?;
                    if code != 0 {
                        return Err(OpError::internal(format!("{} failed: {}", argv.join(" "), err.trim())));
                    }
                }
                Some("file") => {
                    let path = PathBuf::from(step["path"].as_str().unwrap_or_default());
                    crate::util::write_atomic(&path, step["content"].as_str().unwrap_or_default().as_bytes(), false)?;
                }
                _ => {}
            }
        }
        Ok(json!({ "applied": true, "plan": plan, "status": self.status() }))
    }

    /// Sleep, restart or shutdown.
    pub fn action(&self, action: &str) -> OpResult<Value> {
        let argv: Vec<String> = match action {
            "sleep" => vec!["systemctl".into(), "suspend".into()],
            "restart" => vec!["systemctl".into(), "reboot".into()],
            "shutdown" => vec!["systemctl".into(), "poweroff".into()],
            _ => return Err(OpError::validation("action must be sleep, restart or shutdown")),
        };
        if !self.allow_actions {
            return Err(OpError::denied("power_actions_disabled", "power actions are off in this device's novad config").with(json!({ "reason": "power_actions_disabled", "plan": [argv] })));
        }
        let (code, _, err) = self.runner.run(&argv).map_err(|e| OpError::internal(e.to_string()))?;
        if code != 0 {
            return Err(OpError::internal(format!("{} failed: {}", argv.join(" "), err.trim())));
        }
        Ok(json!({ "ok": true, "action": action }))
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::grants::tests::tmp;
    use std::sync::{Arc, Mutex};

    #[derive(Clone, Default)]
    pub struct FakeRunner {
        pub calls: Arc<Mutex<Vec<Vec<String>>>>,
        pub ethtool: Arc<Mutex<String>>,
    }

    impl Runner for FakeRunner {
        fn run(&self, argv: &[String]) -> std::io::Result<(i32, String, String)> {
            self.calls.lock().unwrap().push(argv.to_vec());
            if argv[0] == "ethtool" && argv.len() == 2 {
                return Ok((0, self.ethtool.lock().unwrap().clone(), String::new()));
            }
            Ok((0, String::new(), String::new()))
        }
    }

    fn sysfs(base: &Path) {
        let eth = base.join("net/eth0");
        std::fs::create_dir_all(eth.join("device/power")).unwrap();
        std::fs::write(eth.join("address"), "aa:bb:cc:dd:ee:ff\n").unwrap();
        std::fs::write(eth.join("device/power/wakeup"), "enabled\n").unwrap();
        // A virtual interface (no device link) and loopback are ignored.
        std::fs::create_dir_all(base.join("net/veth1")).unwrap();
        std::fs::write(base.join("net/veth1/address"), "11:22:33:44:55:66\n").unwrap();
        std::fs::create_dir_all(base.join("net/lo/device")).unwrap();
        std::fs::create_dir_all(base.join("power/AC")).unwrap();
        std::fs::write(base.join("power/AC/type"), "Mains\n").unwrap();
        std::fs::write(base.join("power/AC/online"), "1\n").unwrap();
    }

    fn power(base: &Path, runner: FakeRunner, allow: bool, elevated: bool) -> Power {
        Power {
            sys_net: base.join("net"),
            sys_power: base.join("power"),
            link_dir: base.join("links"),
            runner: Box::new(runner),
            allow_changes: allow,
            allow_actions: allow,
            elevated,
        }
    }

    #[test]
    fn parses_ethtool() {
        let (s, w) = parse_ethtool("Settings for eth0:\n\tSupports Wake-on: pumbg\n\tWake-on: d\n");
        assert_eq!((s.as_deref(), w.as_deref()), (Some("pumbg"), Some("d")));
        assert_eq!(parse_ethtool("nothing"), (None, None));
    }

    #[test]
    fn reports_wakeability_and_plans_enabling() {
        let base = tmp("power");
        sysfs(&base);
        let r = FakeRunner::default();
        *r.ethtool.lock().unwrap() = "Supports Wake-on: pumbg\nWake-on: d\n".into();
        let p = power(&base, r.clone(), false, false);
        let s = p.status();
        assert_eq!(s["wakeable"], false);
        assert_eq!(s["macs"], json!(["aa:bb:cc:dd:ee:ff"]));
        assert_eq!(s["ac"], true);
        assert_eq!(s["afterPowerLoss"], "unknown");
        let plan = p.wol_plan();
        assert_eq!(plan[0]["argv"], json!(["ethtool", "-s", "eth0", "wol", "g"]));
        assert!(plan[1]["content"].as_str().unwrap().contains("MACAddress=aa:bb:cc:dd:ee:ff"));
        // Without apply: the plan only. With apply but no flag: refused. No elevation: refused.
        assert_eq!(p.wol_enable(false).unwrap()["applied"], false);
        assert_eq!(p.wol_enable(true).unwrap_err().details.unwrap()["reason"], "power_changes_disabled");
        let p2 = power(&base, r.clone(), true, false);
        assert_eq!(p2.wol_enable(true).unwrap_err().details.unwrap()["reason"], "elevation_required");
        assert!(!r.calls.lock().unwrap().iter().any(|c| c.contains(&"-s".to_string())), "nothing was changed");
        let p3 = power(&base, r.clone(), true, true);
        assert_eq!(p3.wol_enable(true).unwrap()["applied"], true);
        assert!(r.calls.lock().unwrap().iter().any(|c| c == &vec!["ethtool", "-s", "eth0", "wol", "g"]));
        assert!(base.join("links/50-nova-wol-eth0.link").exists());
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn enabled_wol_is_wakeable_and_actions_are_gated() {
        let base = tmp("power2");
        sysfs(&base);
        let r = FakeRunner::default();
        *r.ethtool.lock().unwrap() = "Supports Wake-on: g\nWake-on: g\n".into();
        let p = power(&base, r.clone(), false, false);
        assert_eq!(p.status()["wakeable"], true);
        assert!(p.wol_plan().is_empty());
        assert_eq!(p.action("restart").unwrap_err().details.unwrap()["reason"], "power_actions_disabled");
        assert!(p.action("dance").is_err());
        let p2 = power(&base, r.clone(), true, true);
        p2.action("sleep").unwrap();
        assert!(r.calls.lock().unwrap().iter().any(|c| c == &vec!["systemctl", "suspend"]));
        std::fs::remove_dir_all(&base).unwrap();
    }
}
