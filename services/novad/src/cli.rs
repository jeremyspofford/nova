//! Command-line parsing without dependencies (docs/23 §2).
//!   novad version
//!   novad capabilities [--device-id ID] [--role R]... [--data-dir D] [--sign]
//!   novad install --hub URL --code CODE [--role client|compute|wake] [--dry-run]
//!   novad enroll --hub URL --token TOKEN [--name N] [--role R]... [--listen ADDR] [--endpoint URL]
//!                [--channel C] [--update-key KEY] [--data-dir D]
//!   novad run [--data-dir D]
//!   novad module NAME [--data-dir D]
//!   novad access list|approve ID|deny ID [--data-dir D]
//!   novad wol status|plan|enable [--apply] [--data-dir D]
//!   novad service-unit [--exec PATH] [--platform linux|macos|windows] [--data-dir D]

pub const DEFAULT_DATA_DIR: &str = "/var/lib/nova";
pub const DEFAULT_LISTEN: &str = "0.0.0.0:7420";

#[derive(Debug, PartialEq)]
pub enum Command {
    Version,
    Capabilities { device_id: String, roles: Vec<String>, data_dir: Option<String>, sign: bool },
    Install { hub: String, code: String, role: String, dry_run: bool },
    Enroll(EnrollArgs),
    Run { data_dir: String },
    Module { name: String, data_dir: String },
    Access { action: String, id: Option<String>, data_dir: String },
    Wol { action: String, apply: bool, data_dir: String },
    ServiceUnit { exec: String, platform: String, data_dir: String },
    Help,
}

#[derive(Debug, PartialEq, Clone)]
pub struct EnrollArgs {
    pub hub: String,
    pub token: String,
    pub name: Option<String>,
    pub roles: Vec<String>,
    pub listen: String,
    pub endpoint: String,
    pub channel: String,
    pub update_key: Option<String>,
    pub data_dir: String,
}

pub const ROLES: [&str; 4] = ["client", "compute", "wake-helper", "hub"];

pub fn parse(args: &[String]) -> Result<Command, String> {
    let mut it = args.iter();
    let Some(cmd) = it.next() else { return Ok(Command::Help) };
    let rest: Vec<&String> = it.collect();
    let value = |name: &str| -> Option<String> {
        rest.iter()
            .position(|a| *a == name)
            .and_then(|i| rest.get(i + 1))
            .map(|s| s.to_string())
            .or_else(|| rest.iter().find_map(|a| a.strip_prefix(&format!("{name}=")).map(str::to_string)))
    };
    let all = |name: &str| -> Vec<String> {
        let mut out = Vec::new();
        for (i, a) in rest.iter().enumerate() {
            if *a == name {
                if let Some(v) = rest.get(i + 1) {
                    out.push(v.to_string());
                }
            } else if let Some(v) = a.strip_prefix(&format!("{name}=")) {
                out.push(v.to_string());
            }
        }
        out
    };
    let flag = |name: &str| rest.iter().any(|a| *a == name);
    // The first argument that is not a flag or a flag's value.
    let positional = |n: usize| -> Option<String> {
        let mut skip = false;
        let mut seen = 0;
        for a in &rest {
            if skip {
                skip = false;
                continue;
            }
            if a.starts_with("--") {
                skip = !a.contains('=') && !matches!(a.as_str(), "--apply" | "--sign" | "--dry-run");
                continue;
            }
            if seen == n {
                return Some(a.to_string());
            }
            seen += 1;
        }
        None
    };
    let data_dir = || value("--data-dir").unwrap_or_else(|| DEFAULT_DATA_DIR.to_string());
    let check_role = |r: &str| {
        if ROLES.contains(&r) { Ok(()) } else { Err(format!("unknown role: {r}")) }
    };
    match cmd.as_str() {
        "version" | "--version" | "-V" => Ok(Command::Version),
        "help" | "--help" | "-h" => Ok(Command::Help),
        "capabilities" => {
            let roles = all("--role");
            for r in &roles {
                check_role(r)?;
            }
            Ok(Command::Capabilities {
                device_id: value("--device-id").unwrap_or_else(|| "unregistered".to_string()),
                roles: if roles.is_empty() { vec!["client".to_string()] } else { roles },
                data_dir: value("--data-dir"),
                sign: flag("--sign"),
            })
        }
        "install" => {
            let hub = value("--hub").ok_or("--hub is required")?;
            if !(hub.starts_with("https://") || hub.starts_with("http://127.0.0.1") || hub.starts_with("http://localhost")) {
                return Err("--hub must be https:// (plain http is allowed only for localhost)".into());
            }
            let code = value("--code").ok_or("--code is required")?;
            if code.len() < 6 {
                return Err("--code looks too short".into());
            }
            let role = value("--role").unwrap_or_else(|| "client".to_string());
            check_role(&role)?;
            Ok(Command::Install { hub, code, role, dry_run: flag("--dry-run") })
        }
        "enroll" => {
            // Until certificates arrive (M6.5), devices enroll over LAN HTTP with a one-use token,
            // like compute nodes (ADR-089).
            let hub = value("--hub").ok_or("--hub is required")?;
            if !hub.starts_with("http://") {
                return Err("--hub must be an http:// LAN address until the M6.5 transports (https and mTLS) arrive".into());
            }
            let token = value("--token").ok_or("--token is required")?;
            if !token.starts_with("nvd_") || token.len() < 20 {
                return Err("--token must be a device enrollment token (nvd_…) from Settings → Devices".into());
            }
            let roles = all("--role");
            for r in &roles {
                check_role(r)?;
            }
            let listen = value("--listen").unwrap_or_else(|| DEFAULT_LISTEN.to_string());
            if listen.parse::<std::net::SocketAddr>().is_err() {
                return Err("--listen must be HOST:PORT".into());
            }
            let endpoint = match value("--endpoint") {
                Some(e) => e,
                None if !listen.starts_with("0.0.0.0") && !listen.starts_with("[::]") => format!("http://{listen}"),
                None => return Err("--endpoint is required when --listen is a wildcard address".into()),
            };
            if !endpoint.starts_with("http://") {
                return Err("--endpoint must be an http:// URL the Hub can reach".into());
            }
            let channel = value("--channel").unwrap_or_else(|| "stable".to_string());
            if !crate::state::CHANNELS.contains(&channel.as_str()) {
                return Err("--channel must be stable, beta or nightly".into());
            }
            Ok(Command::Enroll(EnrollArgs {
                hub,
                token,
                name: value("--name"),
                roles: if roles.is_empty() { vec!["client".to_string()] } else { roles },
                listen,
                endpoint,
                channel,
                update_key: value("--update-key"),
                data_dir: data_dir(),
            }))
        }
        "run" => Ok(Command::Run { data_dir: data_dir() }),
        "module" => {
            let name = positional(0).ok_or("module needs a name")?;
            if !crate::supervisor::MODULES.contains(&name.as_str()) {
                return Err(format!("unknown module: {name}"));
            }
            Ok(Command::Module { name, data_dir: data_dir() })
        }
        "access" => {
            let action = positional(0).ok_or("access needs list, approve ID or deny ID")?;
            match action.as_str() {
                "list" => Ok(Command::Access { action, id: None, data_dir: data_dir() }),
                "approve" | "deny" => {
                    let id = positional(1).ok_or("access approve|deny needs a request id")?;
                    Ok(Command::Access { action, id: Some(id), data_dir: data_dir() })
                }
                other => Err(format!("unknown access action: {other}")),
            }
        }
        "wol" => {
            let action = positional(0).unwrap_or_else(|| "status".into());
            if !matches!(action.as_str(), "status" | "plan" | "enable") {
                return Err(format!("unknown wol action: {action}"));
            }
            Ok(Command::Wol { action, apply: flag("--apply"), data_dir: data_dir() })
        }
        "service-unit" => {
            let platform = value("--platform").unwrap_or_else(|| "linux".to_string());
            if !matches!(platform.as_str(), "linux" | "macos" | "windows") {
                return Err("--platform must be linux, macos or windows".into());
            }
            Ok(Command::ServiceUnit {
                exec: value("--exec").unwrap_or_else(|| "/usr/local/bin/novad".to_string()),
                platform,
                data_dir: data_dir(),
            })
        }
        other => Err(format!("unknown command: {other}")),
    }
}

/// systemd unit for the supervisor (docs/23 §5.1: Restart=always), hardened. Home folders stay
/// writable for the storage module's committed writes (FR-210); credential locations are refused
/// by novad itself.
pub fn systemd_unit(exec: &str, data_dir: &str) -> String {
    format!(
        "[Unit]\n\
Description=Nova device agent\n\
After=network-online.target\n\
Wants=network-online.target\n\
\n\
[Service]\n\
ExecStart={exec} run --data-dir {data_dir}\n\
Restart=always\n\
RestartSec=5\n\
StateDirectory=nova\n\
StateDirectoryMode=0700\n\
NoNewPrivileges=yes\n\
ProtectSystem=full\n\
PrivateTmp=yes\n\
LimitCORE=0\n\
UMask=0077\n\
\n\
[Install]\n\
WantedBy=multi-user.target\n"
    )
}

/// launchd daemon definition for macOS (docs/23 §5.1).
pub fn launchd_plist(exec: &str, data_dir: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>ai.nova.novad</string>
  <key>ProgramArguments</key>
  <array><string>{exec}</string><string>run</string><string>--data-dir</string><string>{data_dir}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>Umask</key><integer>63</integer>
  <key>HardResourceLimits</key><dict><key>Core</key><integer>0</integer></dict>
  <key>SoftResourceLimits</key><dict><key>Core</key><integer>0</integer></dict>
</dict>
</plist>
"#
    )
}

/// Windows service definition: the `sc.exe` commands that create it with restart-on-failure.
pub fn windows_service(exec: &str, data_dir: &str) -> String {
    format!(
        "sc.exe create novad binPath= \"\\\"{exec}\\\" run --data-dir \\\"{data_dir}\\\"\" start= auto DisplayName= \"Nova device agent\"\r\n\
sc.exe failure novad reset= 86400 actions= restart/5000/restart/5000/restart/60000\r\n\
sc.exe description novad \"Nova device agent (supervisor for signed, sandboxed modules)\"\r\n"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(s: &[&str]) -> Vec<String> {
        s.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn parses_commands() {
        assert_eq!(parse(&args(&[])).unwrap(), Command::Help);
        assert_eq!(parse(&args(&["--version"])).unwrap(), Command::Version);
        assert_eq!(parse(&args(&["run"])).unwrap(), Command::Run { data_dir: DEFAULT_DATA_DIR.into() });
        assert_eq!(
            parse(&args(&["capabilities", "--role", "compute", "--role=client", "--device-id", "d1"])).unwrap(),
            Command::Capabilities { device_id: "d1".into(), roles: vec!["compute".into(), "client".into()], data_dir: None, sign: false }
        );
        assert_eq!(
            parse(&args(&["service-unit", "--exec=/opt/novad"])).unwrap(),
            Command::ServiceUnit { exec: "/opt/novad".into(), platform: "linux".into(), data_dir: DEFAULT_DATA_DIR.into() }
        );
        assert_eq!(parse(&args(&["module", "--data-dir", "/d", "storage"])).unwrap(), Command::Module { name: "storage".into(), data_dir: "/d".into() });
        assert!(parse(&args(&["module", "kernel"])).is_err());
        assert_eq!(
            parse(&args(&["access", "approve", "abc", "--data-dir=/d"])).unwrap(),
            Command::Access { action: "approve".into(), id: Some("abc".into()), data_dir: "/d".into() }
        );
        assert!(parse(&args(&["access", "approve"])).is_err());
        assert_eq!(parse(&args(&["wol", "enable", "--apply"])).unwrap(), Command::Wol { action: "enable".into(), apply: true, data_dir: DEFAULT_DATA_DIR.into() });
        assert!(parse(&args(&["wol", "reboot"])).is_err());
    }

    #[test]
    fn validates_install() {
        let ok = parse(&args(&["install", "--hub", "https://hub.lan", "--code", "ABC-123", "--dry-run"])).unwrap();
        assert_eq!(ok, Command::Install { hub: "https://hub.lan".into(), code: "ABC-123".into(), role: "client".into(), dry_run: true });
        assert!(parse(&args(&["install", "--code", "ABC-123"])).unwrap_err().contains("--hub"));
        assert!(parse(&args(&["install", "--hub", "http://hub.lan", "--code", "ABC-123"])).unwrap_err().contains("https"));
        assert!(parse(&args(&["install", "--hub", "http://localhost:7419", "--code", "ABC-123"])).is_ok());
        assert!(parse(&args(&["install", "--hub", "https://h", "--code", "1"])).unwrap_err().contains("short"));
        assert!(parse(&args(&["install", "--hub", "https://h", "--code", "ABC-123", "--role", "root"])).unwrap_err().contains("role"));
        assert!(parse(&args(&["capabilities", "--role", "x"])).is_err());
        assert!(parse(&args(&["frobnicate"])).unwrap_err().contains("unknown command"));
    }

    #[test]
    fn validates_enroll() {
        let token = "nvd_0123456789abcdefghij";
        let ok = parse(&args(&["enroll", "--hub", "http://hub.lan:7419", "--token", token, "--listen", "127.0.0.1:7420", "--role", "compute"])).unwrap();
        let Command::Enroll(e) = ok else { panic!("enroll") };
        assert_eq!(e.endpoint, "http://127.0.0.1:7420");
        assert_eq!(e.roles, vec!["compute".to_string()]);
        assert_eq!(e.channel, "stable");
        assert!(parse(&args(&["enroll", "--hub", "http://h", "--token", token])).unwrap_err().contains("--endpoint"));
        assert!(parse(&args(&["enroll", "--hub", "https://h", "--token", token])).unwrap_err().contains("http://"));
        assert!(parse(&args(&["enroll", "--hub", "http://h", "--token", "nve_compute_token_xx"])).unwrap_err().contains("nvd_"));
        assert!(parse(&args(&["enroll", "--hub", "http://h", "--token", token, "--listen", "nope"])).is_err());
        assert!(parse(&args(&["enroll", "--hub", "http://h", "--token", token, "--listen", "127.0.0.1:1", "--channel", "edge"])).is_err());
    }

    #[test]
    fn units_restart_and_are_hardened() {
        let unit = systemd_unit("/usr/local/bin/novad", "/var/lib/nova");
        assert!(unit.contains("ExecStart=/usr/local/bin/novad run --data-dir /var/lib/nova"));
        assert!(unit.contains("Restart=always"));
        assert!(unit.contains("NoNewPrivileges=yes"));
        assert!(unit.contains("LimitCORE=0"));
        let plist = launchd_plist("/usr/local/bin/novad", "/var/lib/nova");
        assert!(plist.contains("<key>KeepAlive</key><true/>"));
        assert!(plist.contains("<string>run</string>"));
        let win = windows_service("C:\\Nova\\novad.exe", "C:\\ProgramData\\Nova");
        assert!(win.contains("sc.exe create novad"));
        assert!(win.contains("actions= restart/5000"));
    }
}
