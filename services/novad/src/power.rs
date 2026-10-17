//! Power and Wake-on-LAN (FR-144, docs/23 §5.3). novad reports whether the device can be woken
//! (a physical NIC that supports and has magic-packet wake enabled), plans the commands that would
//! enable it, and applies them only behind an explicit flag with elevation. Sleep, restart and
//! shutdown run only when the device owner turned power actions on in the local config.
//! Power-on-after-power-loss is a firmware setting: it is reported as unknown until the firmware
//! module (FR-146) can read it.
//!
//! The Wake Helper role (FR-138, docs/22 §7): a device whose roles include `wake-helper` sends
//! Wake-on-LAN magic packets for other devices on its own LAN when the Hub asks
//! (`POST /agent/v1/power/wake-other`), only to its directly attached subnets, at most 10 per
//! minute.

use crate::util::{OpError, OpResult};
use serde_json::{Value, json};
use std::collections::VecDeque;
use std::net::{Ipv4Addr, SocketAddrV4, UdpSocket};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

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
    /// The kernel's IPv4 routing table (`/proc/net/route`): where the LAN subnets come from.
    pub proc_route: PathBuf,
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
            proc_route: "/proc/net/route".into(),
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
            // The physical LAN subnets, so the Hub can pick a Wake Helper on a target's subnet
            // (FR-138); reported with the heartbeat's power status.
            "lan": lan_subnets(&self.proc_route, &self.sys_net).iter().map(Subnet::to_json).collect::<Vec<_>>(),
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

// ---------------------------------------------------------------------------------------------
// Wake Helper (FR-138)
// ---------------------------------------------------------------------------------------------

/// An IPv4 subnet directly attached to one of this device's interfaces.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Subnet {
    pub interface: String,
    pub network: Ipv4Addr,
    pub prefix: u8,
}

impl Subnet {
    fn mask(&self) -> u32 {
        if self.prefix == 0 { 0 } else { u32::MAX << (32 - u32::from(self.prefix)) }
    }
    pub fn contains(&self, ip: Ipv4Addr) -> bool {
        u32::from(ip) & self.mask() == u32::from(self.network) & self.mask()
    }
    /// The directed broadcast address (all host bits set).
    pub fn broadcast(&self) -> Ipv4Addr {
        Ipv4Addr::from(u32::from(self.network) | !self.mask())
    }
    pub fn to_json(&self) -> Value {
        json!({ "interface": self.interface, "network": format!("{}/{}", self.network, self.prefix), "broadcast": self.broadcast().to_string() })
    }
}

/// Directly attached subnets from `/proc/net/route` text: routes that are up, have no gateway
/// and a contiguous mask of /1 to /30 (a /31 or /32 has no broadcast address), on interfaces
/// `keep` accepts. The kernel prints addresses as the raw in-memory u32, hence native endian.
pub fn parse_proc_route(text: &str, keep: impl Fn(&str) -> bool) -> Vec<Subnet> {
    const RTF_UP: u32 = 0x1;
    const RTF_GATEWAY: u32 = 0x2;
    let hex = |s: &str| u32::from_str_radix(s, 16).ok();
    let mut out: Vec<Subnet> = vec![];
    for line in text.lines().skip(1) {
        let f: Vec<&str> = line.split_whitespace().collect();
        let (Some(iface), Some(dest), Some(gw), Some(flags), Some(mask)) =
            (f.first(), f.get(1).and_then(|s| hex(s)), f.get(2).and_then(|s| hex(s)), f.get(3).and_then(|s| hex(s)), f.get(7).and_then(|s| hex(s)))
        else {
            continue;
        };
        let mask = u32::from_be_bytes(mask.to_ne_bytes());
        let network = u32::from_be_bytes(dest.to_ne_bytes());
        let prefix = mask.count_ones();
        // All the set bits lead: 255.255.0.255 is not a netmask.
        let contiguous = mask.leading_ones() == prefix;
        if flags & RTF_UP == 0 || flags & RTF_GATEWAY != 0 || gw != 0 || !contiguous || !(1..=30).contains(&prefix) || network & !mask != 0 || !keep(iface) {
            continue;
        }
        let s = Subnet { interface: (*iface).to_string(), network: Ipv4Addr::from(network), prefix: prefix as u8 };
        if !out.contains(&s) {
            out.push(s);
        }
    }
    out
}

/// The physical interfaces' subnets: an interface counts when it has a `device` link under
/// `sys_net`, as for WoL detection (bridges, tunnels and container interfaces have none).
pub fn lan_subnets(proc_route: &Path, sys_net: &Path) -> Vec<Subnet> {
    let Ok(text) = std::fs::read_to_string(proc_route) else { return vec![] };
    parse_proc_route(&text, |iface| !iface.contains('/') && iface != "." && iface != ".." && sys_net.join(iface).join("device").exists())
}

/// A unicast MAC as `aa:bb:cc:dd:ee:ff` or `aa-bb-cc-dd-ee-ff`.
pub fn parse_mac(s: &str) -> OpResult<[u8; 6]> {
    let bad = || OpError::validation("mac must be a unicast MAC address like aa:bb:cc:dd:ee:ff");
    let sep = s.as_bytes().get(2).copied().filter(|c| *c == b':' || *c == b'-').ok_or_else(bad)?;
    let parts: Vec<&str> = s.split(sep as char).collect();
    if s.len() != 17 || parts.len() != 6 {
        return Err(bad());
    }
    let mut mac = [0u8; 6];
    for (i, p) in parts.iter().enumerate() {
        // from_str_radix alone would take a sign ("+a").
        if p.len() != 2 || !p.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(bad());
        }
        mac[i] = u8::from_str_radix(p, 16).map_err(|_| bad())?;
    }
    // A multicast or broadcast address (low bit of the first octet) is never a NIC; all zeros
    // is no address at all.
    if mac[0] & 1 == 1 || mac == [0; 6] {
        return Err(bad());
    }
    Ok(mac)
}

/// The magic packet: six 0xff bytes, then the MAC sixteen times (102 bytes).
pub fn magic_packet(mac: &[u8; 6]) -> Vec<u8> {
    let mut p = vec![0xffu8; 6];
    for _ in 0..16 {
        p.extend_from_slice(mac);
    }
    p
}

/// Sends one UDP datagram. Tests substitute it or bind to loopback.
pub trait PacketSender: Send + Sync {
    fn send(&self, packet: &[u8], to: SocketAddrV4) -> std::io::Result<()>;
}

pub struct UdpSender;

impl PacketSender for UdpSender {
    fn send(&self, packet: &[u8], to: SocketAddrV4) -> std::io::Result<()> {
        let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))?;
        socket.set_broadcast(true)?;
        socket.send_to(packet, to)?;
        Ok(())
    }
}

/// Ports a magic packet may go to: the discard (9) and echo (7) ports WoL uses.
pub const WAKE_PORTS: [u16; 2] = [9, 7];
pub const WAKE_LIMIT: usize = 10;
pub const WAKE_WINDOW: Duration = Duration::from_secs(60);

/// The Wake Helper: validates a request, keeps the local rate limit and sends the packet. It
/// lives in the supervisor, so the limit survives module restarts.
pub struct WakeHelper {
    pub subnets: Box<dyn Fn() -> Vec<Subnet> + Send + Sync>,
    pub sender: Box<dyn PacketSender>,
    pub limit: usize,
    pub window: Duration,
    sent: Mutex<VecDeque<Instant>>,
}

impl WakeHelper {
    pub fn new(subnets: Box<dyn Fn() -> Vec<Subnet> + Send + Sync>, sender: Box<dyn PacketSender>) -> Self {
        WakeHelper { subnets, sender, limit: WAKE_LIMIT, window: WAKE_WINDOW, sent: Mutex::new(VecDeque::new()) }
    }

    pub fn system() -> Self {
        Self::new(Box::new(|| lan_subnets(Path::new("/proc/net/route"), Path::new("/sys/class/net"))), Box::new(UdpSender))
    }

    /// `{mac, broadcast?, port?}`: the packet goes to `broadcast` (an address on one of this
    /// device's subnets) or, without one, to the broadcast address of every physical subnet.
    pub fn wake(&self, body: &Value) -> OpResult<Value> {
        let obj = body.as_object().ok_or_else(|| OpError::validation("the body must be a JSON object"))?;
        if let Some(k) = obj.keys().find(|k| !matches!(k.as_str(), "mac" | "broadcast" | "port")) {
            return Err(OpError::validation(format!("unknown field {k}")));
        }
        let mac_text = body["mac"].as_str().ok_or_else(|| OpError::validation("mac is required"))?;
        let mac = parse_mac(mac_text)?;
        let port = match body.get("port").filter(|v| !v.is_null()) {
            None => WAKE_PORTS[0],
            Some(v) => v.as_u64().and_then(|p| u16::try_from(p).ok()).filter(|p| WAKE_PORTS.contains(p)).ok_or_else(|| OpError::validation("port must be 9 or 7"))?,
        };
        let subnets = (self.subnets)();
        if subnets.is_empty() {
            return Err(OpError::conflict("this device has no LAN interface to send a wake packet on").with(json!({ "reason": "no_lan" })));
        }
        let targets: Vec<(Ipv4Addr, &Subnet)> = match body.get("broadcast").filter(|v| !v.is_null()) {
            Some(v) => {
                let ip: Ipv4Addr = v.as_str().and_then(|s| s.parse().ok()).ok_or_else(|| OpError::validation("broadcast must be an IPv4 address"))?;
                let subnet = subnets.iter().find(|s| s.contains(ip)).ok_or_else(|| {
                    OpError::denied("not_on_lan", format!("{ip} is not on one of this device's subnets")).with(json!({ "reason": "not_on_lan", "lan": subnets.iter().map(Subnet::to_json).collect::<Vec<_>>() }))
                })?;
                vec![(ip, subnet)]
            }
            None => subnets.iter().map(|s| (s.broadcast(), s)).collect(),
        };
        self.take()?;
        let packet = magic_packet(&mac);
        let mut sent = vec![];
        let mut errors = vec![];
        for (ip, subnet) in targets {
            match self.sender.send(&packet, SocketAddrV4::new(ip, port)) {
                Ok(()) => sent.push(json!({ "broadcast": ip.to_string(), "interface": subnet.interface })),
                Err(e) => errors.push(format!("{ip}: {e}")),
            }
        }
        if sent.is_empty() {
            return Err(OpError::internal(format!("the wake packet could not be sent: {}", errors.join("; "))));
        }
        eprintln!("novad: sent a wake packet for {mac_text} on port {port}");
        Ok(json!({ "sent": true, "mac": mac_text.to_ascii_lowercase(), "port": port, "targets": sent }))
    }

    /// One slot of the local rate limit (sliding window), or 429.
    fn take(&self) -> OpResult<()> {
        let now = Instant::now();
        let mut sent = self.sent.lock().unwrap_or_else(|p| p.into_inner());
        while sent.front().is_some_and(|t| now.duration_since(*t) >= self.window) {
            sent.pop_front();
        }
        if sent.len() >= self.limit {
            let retry = sent.front().map(|t| self.window.saturating_sub(now.duration_since(*t))).unwrap_or(self.window);
            return Err(OpError::new(429, "rate_limited", format!("at most {} wake packets per minute", self.limit)).with(json!({ "retryAfterMs": retry.as_millis() as u64 })));
        }
        sent.push_back(now);
        Ok(())
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
            proc_route: base.join("route"),
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

    // /proc/net/route as an x86 (little-endian) kernel prints it: eth0 on 192.168.1.0/24 with a
    // default route, wlan0 on 10.0.0.0/8, a container bridge, a host route and a gateway route.
    const ROUTE: &str = "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT
eth0\t00000000\t0101A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0
eth0\t0001A8C0\t00000000\t0001\t0\t0\t100\t00FFFFFF\t0\t0\t0
wlan0\t0000000A\t00000000\t0001\t0\t0\t600\t000000FF\t0\t0\t0
docker0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0
eth0\t0A01A8C0\t00000000\t0005\t0\t0\t0\tFFFFFFFF\t0\t0\t0
eth0\t0002A8C0\t0101A8C0\t0003\t0\t0\t0\t00FFFFFF\t0\t0\t0
eth0\t0003A8C0\t00000000\t0000\t0\t0\t0\t00FFFFFF\t0\t0\t0
eth0\t0004A8C0\t00000000\t0001\t0\t0\t0\tFF00FFFF\t0\t0\t0
garbage
";

    fn route_le(text: &str) -> String {
        // The fixture is little-endian; on a big-endian host the kernel would print the bytes
        // the other way round, so convert to keep the test meaningful everywhere.
        if cfg!(target_endian = "little") {
            return text.to_string();
        }
        text.lines()
            .map(|l| l.split('\t').enumerate().map(|(i, f)| if matches!(i, 1 | 2 | 7) && f.len() == 8 { u32::from_str_radix(f, 16).map(|v| format!("{:08X}", v.swap_bytes())).unwrap_or(f.to_string()) } else { f.to_string() }).collect::<Vec<_>>().join("\t"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn finds_directly_attached_subnets() {
        let all = parse_proc_route(&route_le(ROUTE), |_| true);
        let names: Vec<String> = all.iter().map(|s| format!("{} {}/{}", s.interface, s.network, s.prefix)).collect();
        assert_eq!(names, vec!["eth0 192.168.1.0/24", "wlan0 10.0.0.0/8", "docker0 172.17.0.0/16"]);
        assert_eq!(all[0].broadcast(), Ipv4Addr::new(192, 168, 1, 255));
        assert_eq!(all[1].broadcast(), Ipv4Addr::new(10, 255, 255, 255));
        assert!(all[0].contains(Ipv4Addr::new(192, 168, 1, 77)));
        assert!(!all[0].contains(Ipv4Addr::new(192, 168, 2, 77)));
        assert_eq!(all[0].to_json(), json!({ "interface": "eth0", "network": "192.168.1.0/24", "broadcast": "192.168.1.255" }));
        // Only physical interfaces count for the LAN: docker0 has no device link here.
        let base = tmp("route");
        sysfs(&base);
        std::fs::create_dir_all(base.join("net/wlan0/device")).unwrap();
        std::fs::create_dir_all(base.join("net/docker0")).unwrap();
        std::fs::write(base.join("route"), route_le(ROUTE)).unwrap();
        let lan = lan_subnets(&base.join("route"), &base.join("net"));
        assert_eq!(lan.iter().map(|s| s.interface.as_str()).collect::<Vec<_>>(), vec!["eth0", "wlan0"]);
        let p = power(&base, FakeRunner::default(), false, false);
        assert_eq!(p.status()["lan"][0]["broadcast"], "192.168.1.255");
        assert!(lan_subnets(&base.join("missing"), &base.join("net")).is_empty());
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn validates_macs_and_builds_the_magic_packet() {
        assert_eq!(parse_mac("aa:bb:cc:dd:ee:0f").unwrap(), [0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0x0f]);
        assert_eq!(parse_mac("AA-BB-CC-DD-EE-0F").unwrap(), [0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0x0f]);
        for bad in ["", "aa:bb:cc:dd:ee", "aa:bb:cc:dd:ee:ff:00", "aa:bb-cc:dd:ee:ff", "aabb.ccdd.eeff", "gg:bb:cc:dd:ee:ff", "ff:ff:ff:ff:ff:ff", "01:00:5e:00:00:01", "00:00:00:00:00:00", "a:bbb:cc:dd:ee:ff", "+a:bb:cc:dd:ee:ff"] {
            assert_eq!(parse_mac(bad).unwrap_err().code, "validation", "{bad}");
        }
        let p = magic_packet(&[1, 2, 3, 4, 5, 6]);
        assert_eq!(p.len(), 102);
        assert_eq!(&p[..6], &[0xff; 6]);
        for i in 0..16 {
            assert_eq!(&p[6 + i * 6..12 + i * 6], &[1, 2, 3, 4, 5, 6]);
        }
    }

    #[derive(Clone, Default)]
    pub struct FakeSender(pub Arc<Mutex<Vec<(Vec<u8>, SocketAddrV4)>>>);

    impl PacketSender for FakeSender {
        fn send(&self, packet: &[u8], to: SocketAddrV4) -> std::io::Result<()> {
            if to.ip().is_unspecified() {
                return Err(std::io::Error::other("unreachable"));
            }
            self.0.lock().unwrap().push((packet.to_vec(), to));
            Ok(())
        }
    }

    pub fn helper(sender: FakeSender) -> WakeHelper {
        WakeHelper::new(Box::new(|| parse_proc_route(&route_le(ROUTE), |i| i != "docker0")), Box::new(sender))
    }

    #[test]
    fn wake_helper_validates_and_sends() {
        let sender = FakeSender::default();
        let h = helper(sender.clone());
        let r = h.wake(&json!({ "mac": "AA:BB:CC:DD:EE:01", "broadcast": "192.168.1.255" })).unwrap();
        assert_eq!(r["targets"], json!([{ "broadcast": "192.168.1.255", "interface": "eth0" }]));
        assert_eq!(r["port"], 9);
        assert_eq!(r["mac"], "aa:bb:cc:dd:ee:01");
        let (packet, to) = sender.0.lock().unwrap()[0].clone();
        assert_eq!(packet, magic_packet(&[0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0x01]));
        assert_eq!(to, "192.168.1.255:9".parse().unwrap());
        // No broadcast: every physical subnet's broadcast address; port 7 is allowed.
        let r = h.wake(&json!({ "mac": "aa:bb:cc:dd:ee:02", "port": 7 })).unwrap();
        assert_eq!(r["targets"].as_array().unwrap().len(), 2);
        assert_eq!(sender.0.lock().unwrap()[2].1, "10.255.255.255:7".parse().unwrap());
        // A unicast address on the LAN is allowed; anything off it is refused.
        h.wake(&json!({ "mac": "aa:bb:cc:dd:ee:03", "broadcast": "10.1.2.3" })).unwrap();
        let off = h.wake(&json!({ "mac": "aa:bb:cc:dd:ee:03", "broadcast": "8.8.8.8" })).unwrap_err();
        assert_eq!((off.status, off.details.unwrap()["reason"].as_str()), (403, Some("not_on_lan")));
        let docker = h.wake(&json!({ "mac": "aa:bb:cc:dd:ee:03", "broadcast": "172.17.255.255" })).unwrap_err();
        assert_eq!(docker.status, 403, "container bridges are not the LAN");
        for bad in [json!({}), json!({ "mac": "nope" }), json!({ "mac": "aa:bb:cc:dd:ee:03", "port": 22 }), json!({ "mac": "aa:bb:cc:dd:ee:03", "port": "9" }), json!({ "mac": "aa:bb:cc:dd:ee:03", "broadcast": "::1" }), json!({ "mac": "aa:bb:cc:dd:ee:03", "extra": 1 }), json!([1])] {
            assert_eq!(h.wake(&bad).unwrap_err().code, "validation", "{bad}");
        }
        assert_eq!(sender.0.lock().unwrap().len(), 4, "refusals send nothing");
        // No LAN at all.
        let none = WakeHelper::new(Box::new(Vec::new), Box::new(FakeSender::default()));
        assert_eq!(none.wake(&json!({ "mac": "aa:bb:cc:dd:ee:03" })).unwrap_err().details.unwrap()["reason"], "no_lan");
    }

    #[test]
    fn wake_helper_rate_limits_to_ten_a_minute() {
        let sender = FakeSender::default();
        let h = helper(sender.clone());
        for _ in 0..10 {
            h.wake(&json!({ "mac": "aa:bb:cc:dd:ee:01", "broadcast": "192.168.1.255" })).unwrap();
        }
        let e = h.wake(&json!({ "mac": "aa:bb:cc:dd:ee:01", "broadcast": "192.168.1.255" })).unwrap_err();
        assert_eq!((e.status, e.code.as_str()), (429, "rate_limited"));
        assert!(e.details.unwrap()["retryAfterMs"].as_u64().unwrap() <= 60_000);
        assert_eq!(sender.0.lock().unwrap().len(), 10);
        // The window slides.
        let mut short = helper(sender.clone());
        short.window = Duration::from_millis(50);
        short.limit = 1;
        short.wake(&json!({ "mac": "aa:bb:cc:dd:ee:01" })).unwrap();
        assert_eq!(short.wake(&json!({ "mac": "aa:bb:cc:dd:ee:01" })).unwrap_err().status, 429);
        std::thread::sleep(Duration::from_millis(80));
        short.wake(&json!({ "mac": "aa:bb:cc:dd:ee:01" })).unwrap();
    }

    #[test]
    fn udp_sender_puts_the_packet_on_the_wire() {
        // Loopback only: nothing reaches the LAN.
        let rx = UdpSocket::bind("127.0.0.1:0").unwrap();
        rx.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let to = match rx.local_addr().unwrap() {
            std::net::SocketAddr::V4(a) => a,
            _ => unreachable!(),
        };
        let packet = magic_packet(&[0x02, 0, 0, 0, 0, 0x01]);
        UdpSender.send(&packet, to).unwrap();
        let mut buf = [0u8; 200];
        let (n, _) = rx.recv_from(&mut buf).unwrap();
        assert_eq!(&buf[..n], packet.as_slice());
    }
}
