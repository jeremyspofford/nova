//! Command-line parsing without dependencies (docs/23 §2).
//!   novad version
//!   novad capabilities [--device-id ID] [--role R]... [--data-dir D] [--sign]
//!   novad install --hub URL --code CODE --pin FINGERPRINT [--pairing ID] [--role R]... [--name N]
//!                 [--listen ADDR] [--endpoint URL] [--user NAME]... [--no-service] [--dry-run]
//!                 [--data-dir D]
//!   novad enroll --hub URL --token TOKEN [--pin FINGERPRINT] [--name N] [--role R]... [--listen ADDR]
//!                [--endpoint URL] [--user NAME]... [--channel C] [--update-key KEY] [--data-dir D]
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
    Install(InstallArgs),
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
    /// The Hub fingerprint (FR-134): required for an https:// Hub; over http:// it lets novad
    /// learn the Hub local CA from the signed identity statement for later HTTPS.
    pub pin: Option<String>,
    /// Users who get their own local runtime socket (`config.json` `localRuntime.users`).
    pub users: Vec<String>,
    pub data_dir: String,
}

/// `novad install` (FR-133, docs/22 §4.3): join a Hub with an Add Device code.
#[derive(Debug, PartialEq, Clone)]
pub struct InstallArgs {
    /// The Hub's http:// or https:// address, without a trailing slash.
    pub hub: String,
    /// The Add Device code, normalized to its 8 characters (`ABCDEFGH`).
    pub code: String,
    /// The pairing the code belongs to (the `p=` of the Add Device link); without it the Hub finds
    /// the pairing by the code and says which it was.
    pub pairing: Option<String>,
    /// The Hub identity fingerprint to pin: base64url(SHA-256(raw Ed25519 public key)).
    pub pin: String,
    pub roles: Vec<String>,
    pub name: Option<String>,
    pub listen: String,
    /// None: the address this device uses to reach the Hub, with the listen port.
    pub endpoint: Option<String>,
    pub no_service: bool,
    pub dry_run: bool,
    /// Users who get their own local runtime socket; `$SUDO_USER` by default.
    pub users: Vec<String>,
    pub data_dir: String,
}

pub const ROLES: [&str; 4] = ["client", "compute", "wake-helper", "hub"];

/// Add Device codes: Crockford base32 without I, L, O and U (docs/22 §4.1).
pub const CODE_ALPHABET: &str = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// The canonical code, as the Hub computes it: upper case, without spaces or hyphens, with
/// Crockford's reading of the look-alikes (O → 0, I and L → 1); None unless that leaves 8
/// characters of the alphabet.
pub fn normalize_code(s: &str) -> Option<String> {
    let c: String = s
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .map(|c| match c.to_ascii_uppercase() {
            'O' => '0',
            'I' | 'L' => '1',
            u => u,
        })
        .collect();
    (c.len() == 8 && c.chars().all(|ch| CODE_ALPHABET.contains(ch))).then_some(c)
}

/// A pin is a SHA-256 fingerprint in base64url: 43 characters that decode to 32 bytes.
pub fn valid_pin(s: &str) -> bool {
    s.len() == 43 && crate::crypto::b64url_decode(s).is_some_and(|b| b.len() == 32)
}

/// Where `novad install` takes the Add Device code from when `--code` is not on the command
/// line, so the code stays out of the process list (other users can read argv; the environment
/// and standard input are private to the process).
pub const CODE_ENV: &str = "NOVA_ADD_CODE";

pub fn parse(args: &[String]) -> Result<Command, String> {
    parse_with(args, &|k| std::env::var(k).ok(), &|| {
        let mut line = String::new();
        std::io::stdin().read_line(&mut line).ok().map(|_| line)
    })
}

/// `parse` with the environment and standard input given (tests).
pub fn parse_with(args: &[String], env: &dyn Fn(&str) -> Option<String>, stdin_line: &dyn Fn() -> Option<String>) -> Result<Command, String> {
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
                skip = !a.contains('=') && !matches!(a.as_str(), "--apply" | "--sign" | "--dry-run" | "--no-service");
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
    // The local runtime's per-user sockets (FR-128): `--user`, else the user who ran sudo.
    let users = || -> Result<Vec<String>, String> {
        let mut list = all("--user");
        if list.is_empty() {
            list.extend(env("SUDO_USER").filter(|u| u != "root" && crate::local_runtime::valid_user(u)));
        }
        if let Some(bad) = list.iter().find(|u| !crate::local_runtime::valid_user(u)) {
            return Err(format!("--user: {bad:?} is not a user name"));
        }
        list.dedup();
        Ok(list)
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
            // An https:// Hub is trusted through the pin (src/tls.rs, R-023); over http:// the pin,
            // the signed manifest and the signed confirmation protect the install (FR-133).
            let hub = value("--hub").ok_or("--hub is required")?.trim_end_matches('/').to_string();
            crate::http::host_port(&hub).map_err(|e| format!("--hub: {e}"))?;
            // `--code -` reads it from standard input (the bootstrap command pipes it in, which
            // survives sudo); without --code it comes from NOVA_ADD_CODE.
            let code = match value("--code").as_deref() {
                Some("-") => stdin_line().filter(|l| !l.trim().is_empty()).ok_or("--code -: no code on standard input")?,
                Some(c) => c.to_string(),
                None => env(CODE_ENV).ok_or("--code is required (or --code - with the code on standard input, or NOVA_ADD_CODE)")?,
            };
            let code = normalize_code(&code).ok_or("--code must be the 8-character Add Device code shown on the Hub (ABCD-EFGH)")?;
            let pairing = value("--pairing");
            if pairing.as_ref().is_some_and(|p| !crate::install::valid_id(p)) {
                return Err("--pairing must be the pairing id from the Hub".into());
            }
            let pin = value("--pin").ok_or("--pin is required (the Hub fingerprint shown with the code)")?;
            if !valid_pin(&pin) {
                return Err("--pin must be the Hub's 43-character fingerprint".into());
            }
            let mut roles = all("--role");
            for r in &roles {
                check_role(r)?;
            }
            roles.dedup();
            let name = value("--name");
            if name.as_ref().is_some_and(|n| n.trim().is_empty() || n.chars().count() > 100 || n.chars().any(char::is_control)) {
                return Err("--name must be 1 to 100 printable characters".into());
            }
            let listen = value("--listen").unwrap_or_else(|| DEFAULT_LISTEN.to_string());
            if listen.parse::<std::net::SocketAddr>().is_err() {
                return Err("--listen must be HOST:PORT".into());
            }
            let endpoint = value("--endpoint");
            if endpoint.as_ref().is_some_and(|e| !e.starts_with("http://")) {
                return Err("--endpoint must be an http:// URL the Hub can reach".into());
            }
            Ok(Command::Install(InstallArgs {
                hub,
                code,
                pairing,
                pin,
                roles: if roles.is_empty() { vec!["client".to_string()] } else { roles },
                name,
                listen,
                endpoint,
                no_service: flag("--no-service"),
                dry_run: flag("--dry-run"),
                users: users()?,
                data_dir: data_dir(),
            }))
        }
        "enroll" => {
            // A one-use token, like compute nodes (ADR-089); an https:// Hub needs its pin (R-023).
            let hub = value("--hub").ok_or("--hub is required")?.trim_end_matches('/').to_string();
            crate::http::host_port(&hub).map_err(|e| format!("--hub: {e}"))?;
            let pin = value("--pin");
            if pin.as_ref().is_some_and(|p| !valid_pin(p)) {
                return Err("--pin must be the Hub's 43-character fingerprint".into());
            }
            if crate::http::is_https(&hub) && pin.is_none() {
                return Err("--pin is required for an https:// Hub (the Hub fingerprint shown in Settings → Devices)".into());
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
                pin,
                users: users()?,
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

    const PIN: &str = "LXEWQrcmsEQBYnyp-6wy9chTD7GQPMTbAiWHF5IaSIE";

    fn install(extra: &[&str]) -> Result<Command, String> {
        let mut a = vec!["install", "--hub", "http://hub.lan:7419/", "--code", "abcd-efgh", "--pairing", "0192abcd-0000-7000-8000-000000000001", "--pin", PIN];
        a.extend_from_slice(extra);
        parse_with(&args(&a), &|_| None, &|| None)
    }

    #[test]
    fn validates_install() {
        let Command::Install(i) = install(&["--role", "compute", "--role", "wake-helper", "--no-service", "--data-dir", "/d"]).unwrap() else { panic!("install") };
        assert_eq!(i.hub, "http://hub.lan:7419");
        assert_eq!(i.code, "ABCDEFGH");
        assert_eq!(i.pin, PIN);
        assert_eq!(i.roles, vec!["compute".to_string(), "wake-helper".to_string()]);
        assert_eq!((i.listen.as_str(), i.endpoint.as_deref()), (DEFAULT_LISTEN, None));
        assert!(i.no_service && !i.dry_run);
        assert_eq!(i.data_dir, "/d");
        let Command::Install(d) = install(&["--dry-run", "--name", "box", "--listen", "127.0.0.1:7421", "--endpoint", "http://10.0.0.5:7421"]).unwrap() else { panic!("install") };
        assert_eq!(d.roles, vec!["client".to_string()]);
        assert_eq!((d.name.as_deref(), d.endpoint.as_deref(), d.dry_run), (Some("box"), Some("http://10.0.0.5:7421"), true));
        assert_eq!(normalize_code("ABCD EFGH").as_deref(), Some("ABCDEFGH"));
        assert_eq!(normalize_code(" 0123-4567 ").as_deref(), Some("01234567"));
        assert_eq!(normalize_code("abcd-oil0").as_deref(), Some("ABCD0110"), "look-alikes read as digits");
        for bad in ["ABCD-EFG", "ABCD-EFGHJ", "ABCD_EFGH", "ABCDEFGU", "ABC\u{e9}EFGH", "$(id)-xx"] {
            assert_eq!(normalize_code(bad), None, "{bad}");
        }
        let err = |a: &[&str]| parse_with(&args(a), &|_| None, &|| None).unwrap_err();
        assert!(err(&["install", "--code", "ABCD-EFGH"]).contains("--hub"));
        // An https:// Hub is trusted through the pin (R-023).
        let Command::Install(tls) = parse(&args(&["install", "--hub", "https://hub.lan:7419/", "--code", "ABCD-EFGH", "--pin", PIN])).unwrap() else { panic!("install") };
        assert_eq!(tls.hub, "https://hub.lan:7419");
        assert!(err(&["install", "--hub", "http://user@hub.lan", "--code", "ABCD-EFGH"]).contains("--hub"));
        assert!(err(&["install", "--hub", "http://hub.lan"]).contains("--code"));
        assert!(err(&["install", "--hub", "http://hub.lan", "--code", "1"]).contains("8-character"));
        let Command::Install(np) = parse(&args(&["install", "--hub", "http://hub.lan", "--code", "ABCD-EFGH", "--pin", PIN])).unwrap() else { panic!("install") };
        assert_eq!(np.pairing, None, "the Hub finds the pairing by its code");
        assert!(err(&["install", "--hub", "http://hub.lan", "--code", "ABCD-EFGH", "--pairing", "a/b", "--pin", PIN]).contains("--pairing"));
        assert!(err(&["install", "--hub", "http://hub.lan", "--code", "ABCD-EFGH", "--pairing", "p1"]).contains("--pin"));
        let Command::Install(p) = install(&[]).unwrap() else { panic!("install") };
        assert_eq!(p.pairing.as_deref(), Some("0192abcd-0000-7000-8000-000000000001"));
        assert!(install(&[]).is_ok());
        assert!(parse(&args(&["install", "--hub", "http://hub.lan", "--code", "ABCD-EFGH", "--pairing", "p1", "--pin", "short"])).unwrap_err().contains("fingerprint"));
        assert!(install(&["--role", "root"]).unwrap_err().contains("role"));
        assert!(install(&["--listen", "nope"]).unwrap_err().contains("--listen"));
        assert!(install(&["--endpoint", "https://x"]).unwrap_err().contains("--endpoint"));
        assert!(install(&["--name", "a\nb"]).unwrap_err().contains("--name"));
        assert!(parse(&args(&["capabilities", "--role", "x"])).is_err());
        assert!(parse(&args(&["frobnicate"])).unwrap_err().contains("unknown command"));
    }

    #[test]
    fn takes_local_runtime_users_or_the_sudo_user() {
        let with_env = |extra: &[&str], sudo: Option<&str>| {
            let mut a = vec!["install", "--hub", "http://hub.lan", "--code", "ABCD-EFGH", "--pin", PIN];
            a.extend_from_slice(extra);
            let sudo = sudo.map(str::to_string);
            parse_with(&args(&a), &|k| if k == "SUDO_USER" { sudo.clone() } else { None }, &|| None).map(|c| match c {
                Command::Install(i) => i.users,
                _ => vec![],
            })
        };
        assert_eq!(with_env(&[], None).unwrap(), Vec::<String>::new());
        assert_eq!(with_env(&[], Some("alice")).unwrap(), vec!["alice".to_string()]);
        assert_eq!(with_env(&[], Some("root")).unwrap(), Vec::<String>::new(), "sudo from root names nobody");
        assert_eq!(with_env(&["--user", "bob", "--user=carol"], Some("alice")).unwrap(), vec!["bob".to_string(), "carol".to_string()]);
        assert!(with_env(&["--user", "../etc"], None).unwrap_err().contains("--user"));
        let token = "nvd_0123456789abcdefghij";
        let Command::Enroll(e) = parse_with(&args(&["enroll", "--hub", "http://h", "--token", token, "--endpoint", "http://d:1", "--user", "dana"]), &|_| None, &|| None).unwrap() else { panic!("enroll") };
        assert_eq!(e.users, vec!["dana".to_string()]);
    }

    /// The code can stay off argv: from standard input (`--code -`) or NOVA_ADD_CODE.
    #[test]
    fn takes_the_code_off_the_command_line() {
        let base = ["install", "--hub", "http://hub.lan", "--pin", PIN];
        let code_of = |extra: &[&str], env: Option<&str>, stdin: Option<&str>| -> Result<String, String> {
            let mut a = base.to_vec();
            a.extend_from_slice(extra);
            let env = env.map(str::to_string);
            let stdin = stdin.map(str::to_string);
            match parse_with(&args(&a), &|k| if k == CODE_ENV { env.clone() } else { None }, &|| stdin.clone())? {
                Command::Install(i) => Ok(i.code),
                _ => Err("not install".into()),
            }
        };
        assert_eq!(code_of(&["--code", "-"], None, Some("abcd-efgh\n")).unwrap(), "ABCDEFGH");
        assert_eq!(code_of(&[], Some("WXYZ-0123"), None).unwrap(), "WXYZ0123");
        // An explicit --code wins over the environment; stdin is read only for `--code -`.
        assert_eq!(code_of(&["--code", "ABCD-EFGH"], Some("WXYZ-0123"), Some("JJJJJJJJ")).unwrap(), "ABCDEFGH");
        assert!(code_of(&["--code", "-"], None, Some("\n")).unwrap_err().contains("standard input"));
        assert!(code_of(&["--code", "-"], None, None).unwrap_err().contains("standard input"));
        assert!(code_of(&[], None, None).unwrap_err().contains("NOVA_ADD_CODE"));
        assert!(code_of(&[], Some("$(id)"), None).unwrap_err().contains("8-character"));
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
        assert!(parse(&args(&["enroll", "--hub", "https://h", "--token", token, "--endpoint", "http://d:1"])).unwrap_err().contains("--pin"));
        let Command::Enroll(t) = parse(&args(&["enroll", "--hub", "https://h:7419/", "--token", token, "--endpoint", "http://d:1", "--pin", PIN])).unwrap() else { panic!("enroll") };
        assert_eq!((t.hub.as_str(), t.pin.as_deref()), ("https://h:7419", Some(PIN)));
        assert!(parse(&args(&["enroll", "--hub", "http://h", "--token", token, "--endpoint", "http://d:1", "--pin", "bad"])).unwrap_err().contains("fingerprint"));
        assert!(parse(&args(&["enroll", "--hub", "ftp://h", "--token", token, "--endpoint", "http://d:1"])).unwrap_err().contains("--hub"));
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
