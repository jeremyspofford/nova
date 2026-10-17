//! Command-line parsing without dependencies (docs/23 §2).
//!   novad version
//!   novad capabilities [--device-id ID] [--role R]...
//!   novad install --hub URL --code CODE [--role client|compute|wake] [--dry-run]
//!   novad service-unit [--exec PATH]
//!   novad run

#[derive(Debug, PartialEq)]
pub enum Command {
    Version,
    Capabilities { device_id: String, roles: Vec<String> },
    Install { hub: String, code: String, role: String, dry_run: bool },
    ServiceUnit { exec: String },
    Run,
    Help,
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
            Ok(Command::Install { hub, code, role, dry_run: rest.iter().any(|a| *a == "--dry-run") })
        }
        "service-unit" => Ok(Command::ServiceUnit {
            exec: value("--exec").unwrap_or_else(|| "/usr/local/bin/novad".to_string()),
        }),
        "run" => Ok(Command::Run),
        other => Err(format!("unknown command: {other}")),
    }
}

/// systemd unit for the supervisor (docs/23 §5.1: Restart=always), hardened by default.
pub fn systemd_unit(exec: &str) -> String {
    format!(
        "[Unit]\n\
Description=Nova device agent\n\
After=network-online.target\n\
Wants=network-online.target\n\
\n\
[Service]\n\
ExecStart={exec} run\n\
Restart=always\n\
RestartSec=5\n\
StateDirectory=nova\n\
NoNewPrivileges=yes\n\
ProtectSystem=strict\n\
ProtectHome=read-only\n\
PrivateTmp=yes\n\
LimitCORE=0\n\
\n\
[Install]\n\
WantedBy=multi-user.target\n"
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
        assert_eq!(parse(&args(&["run"])).unwrap(), Command::Run);
        assert_eq!(
            parse(&args(&["capabilities", "--role", "compute", "--role=client", "--device-id", "d1"])).unwrap(),
            Command::Capabilities { device_id: "d1".into(), roles: vec!["compute".into(), "client".into()] }
        );
        assert_eq!(
            parse(&args(&["service-unit", "--exec=/opt/novad"])).unwrap(),
            Command::ServiceUnit { exec: "/opt/novad".into() }
        );
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
    fn unit_restarts_and_is_hardened() {
        let unit = systemd_unit("/usr/local/bin/novad");
        assert!(unit.contains("ExecStart=/usr/local/bin/novad run"));
        assert!(unit.contains("Restart=always"));
        assert!(unit.contains("NoNewPrivileges=yes"));
        assert!(unit.contains("LimitCORE=0"));
    }
}
