//! Sandboxed commands on the device for Hub sessions and connected agents (FR-081, FR-107,
//! docs/11 §2.3). On Linux every command runs under bubblewrap: new namespaces (no network), the
//! system read-only, only the grantee's folders bound (read-only or read-write by grant), the
//! protected locations inside them masked or read-only, a cleared environment, a wall-clock limit
//! and capped output. Without a sandbox the command is refused (fail closed); network modes other
//! than `off` are refused until the device has an egress proxy (FR-193).

use crate::grants::{GrantStore, Grantee, Need};
use crate::hardening::{Limits, harden_command, is_loader_var};
use crate::paths::{CREDENTIAL_LOCATIONS, READ_ONLY_LOCATIONS};
use crate::util::{OpError, OpResult};
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub const DEFAULT_TIMEOUT_MS: u64 = 60_000;
pub const MAX_TIMEOUT_MS: u64 = 30 * 60_000;
pub const MAX_OUTPUT: usize = 1024 * 1024;

#[derive(Debug, Clone, PartialEq)]
pub struct ExecSpec {
    pub cmd: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub env: Vec<(String, String)>,
    pub timeout_ms: u64,
    pub stdin: Option<String>,
}

impl ExecSpec {
    pub fn parse(v: &Value) -> OpResult<Self> {
        let cmd = v["cmd"].as_str().filter(|c| !c.is_empty() && c.len() <= 1000).ok_or_else(|| OpError::validation("cmd is required"))?;
        let args = match &v["args"] {
            Value::Null => vec![],
            Value::Array(a) if a.len() <= 1000 => a
                .iter()
                .map(|x| x.as_str().map(str::to_string).ok_or_else(|| OpError::validation("args must be strings")))
                .collect::<OpResult<Vec<_>>>()?,
            _ => return Err(OpError::validation("args must be an array of strings")),
        };
        let mut env = vec![];
        if let Some(o) = v["env"].as_object() {
            for (k, val) in o {
                let s = val.as_str().ok_or_else(|| OpError::validation("env values must be strings"))?;
                if k.is_empty() || k.contains('=') || k.contains('\0') || is_loader_var(k) {
                    return Err(OpError::validation(format!("env {k} is not allowed")));
                }
                env.push((k.clone(), s.to_string()));
            }
        }
        let network = v["network"].as_str().unwrap_or("off");
        if network != "off" {
            return Err(OpError::denied("egress_unavailable", "commands on a device run without network until the device has an egress proxy"));
        }
        Ok(ExecSpec {
            cmd: cmd.to_string(),
            args,
            cwd: v["cwd"].as_str().map(str::to_string),
            env,
            timeout_ms: v["timeoutMs"].as_u64().unwrap_or(DEFAULT_TIMEOUT_MS).clamp(100, MAX_TIMEOUT_MS),
            stdin: v["stdin"].as_str().map(str::to_string),
        })
    }
}

/// Where the sandbox program is, if this device has one.
pub fn find_bwrap() -> Option<PathBuf> {
    ["/usr/bin/bwrap", "/bin/bwrap", "/usr/local/bin/bwrap"].iter().map(PathBuf::from).find(|p| p.is_file())
}

/// The bubblewrap arguments for a command: system read-only, grants bound, protected locations
/// masked (credentials) or read-only (`.git` and friends) inside writable roots.
pub fn bwrap_args(roots: &[(PathBuf, bool)], cwd: &Path, spec: &ExecSpec) -> Vec<String> {
    let mut a: Vec<String> = vec![
        "--unshare-all".into(),
        "--die-with-parent".into(),
        "--new-session".into(),
        "--cap-drop".into(),
        "ALL".into(),
    ];
    for sys in ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/lib32", "/etc/alternatives", "/etc/ssl", "/etc/ca-certificates", "/etc/ld.so.cache", "/etc/localtime"] {
        a.extend(["--ro-bind-try".into(), sys.into(), sys.into()]);
    }
    a.extend(["--proc".into(), "/proc".into(), "--dev".into(), "/dev".into(), "--tmpfs".into(), "/tmp".into()]);
    for (root, writable) in roots {
        let r = root.to_string_lossy().to_string();
        a.extend([if *writable { "--bind" } else { "--ro-bind" }.into(), r.clone(), r.clone()]);
        if *writable {
            for loc in READ_ONLY_LOCATIONS {
                let p = format!("{r}/{}", loc.join("/"));
                a.extend(["--ro-bind-try".into(), p.clone(), p]);
            }
        }
        // Credential locations directly under a root are hidden behind an empty tmpfs.
        for loc in CREDENTIAL_LOCATIONS.iter().filter(|l| !l.iter().any(|s| s.contains('*'))) {
            let p = root.join(loc.join("/"));
            if p.is_dir() {
                a.extend(["--tmpfs".into(), p.to_string_lossy().to_string()]);
            } else if p.exists() {
                a.extend(["--ro-bind".into(), "/dev/null".into(), p.to_string_lossy().to_string()]);
            }
        }
    }
    a.extend(["--chdir".into(), cwd.to_string_lossy().to_string(), "--clearenv".into()]);
    a.extend(["--setenv".into(), "PATH".into(), "/usr/local/bin:/usr/bin:/bin".into()]);
    a.extend(["--setenv".into(), "HOME".into(), "/tmp".into()]);
    for (k, v) in &spec.env {
        a.extend(["--setenv".into(), k.clone(), v.clone()]);
    }
    a.push("--".into());
    a.push(spec.cmd.clone());
    a.extend(spec.args.iter().cloned());
    a
}

/// Run a command for `grantee` with its working folder inside a grant.
pub fn run(grants: &GrantStore, grantee: &Grantee, spec: &ExecSpec, bwrap: Option<&Path>) -> OpResult<Value> {
    let cwd_raw = spec.cwd.clone().ok_or_else(|| OpError::validation("cwd is required on a device"))?;
    let cwd = grants.resolve(grantee, &cwd_raw, Need::Read)?;
    if !cwd.path.is_dir() {
        return Err(OpError::validation("cwd is not a directory"));
    }
    let Some(bwrap) = bwrap else {
        return Err(OpError::new(409, "sandbox_unavailable", "no sandbox on this device; commands are refused (FR-107)"));
    };
    let roots = grants.roots(grantee)?;
    let mut cmd = Command::new(bwrap);
    cmd.args(bwrap_args(&roots, &cwd.path, spec));
    run_command(cmd, spec)
}

/// Spawn, feed stdin, enforce the wall clock and cap the output.
pub fn run_command(mut cmd: Command, spec: &ExecSpec) -> OpResult<Value> {
    harden_command(&mut cmd, &[], Limits::default());
    // Its own process group, so a timeout kills the whole tree and the output pipes close.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    cmd.stdin(if spec.stdin.is_some() { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| OpError::new(409, "sandbox_unavailable", format!("the sandbox could not start: {e}")))?;
    if let (Some(input), Some(mut sin)) = (spec.stdin.clone(), child.stdin.take()) {
        std::thread::spawn(move || {
            let _ = sin.write_all(input.as_bytes());
        });
    }
    let capture = |r: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut out = Vec::new();
            if let Some(mut r) = r {
                let mut buf = [0u8; 8192];
                while let Ok(n) = r.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                    if out.len() < MAX_OUTPUT {
                        let room = MAX_OUTPUT - out.len();
                        out.extend_from_slice(&buf[..n.min(room)]);
                    }
                }
            }
            out
        })
    };
    let out = capture(child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>));
    let err = capture(child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>));
    let deadline = Instant::now() + Duration::from_millis(spec.timeout_ms);
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Some(s),
            Ok(None) if Instant::now() >= deadline => {
                timed_out = true;
                kill_group(child.id());
                let _ = child.kill();
                break child.wait().ok();
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
            Err(e) => return Err(OpError::internal(e.to_string())),
        }
    };
    let stdout = out.join().unwrap_or_default();
    let stderr = err.join().unwrap_or_default();
    Ok(json!({
        "exitCode": if timed_out { None } else { status.and_then(|s| s.code()) },
        "stdout": String::from_utf8_lossy(&stdout),
        "stderr": String::from_utf8_lossy(&stderr),
        "timedOut": timed_out,
    }))
}

#[cfg(unix)]
unsafe extern "C" {
    fn kill(pid: i32, sig: i32) -> i32;
}

/// SIGKILL a process group led by `pid`.
pub fn kill_group(pid: u32) {
    #[cfg(unix)]
    // SAFETY: a plain syscall wrapper; a negative pid names the group.
    unsafe {
        kill(-(pid as i32), 9);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::grants::tests::tmp;

    fn spec(cmd: &str, args: &[&str]) -> ExecSpec {
        ExecSpec { cmd: cmd.into(), args: args.iter().map(|s| s.to_string()).collect(), cwd: Some("/".into()), env: vec![], timeout_ms: 5_000, stdin: None }
    }

    #[test]
    fn parses_specs_and_refuses_network_and_loader_vars() {
        let s = ExecSpec::parse(&json!({"cmd": "ls", "args": ["-l"], "cwd": "/p", "env": {"A": "1"}, "timeoutMs": 10})).unwrap();
        assert_eq!(s.timeout_ms, 100);
        assert_eq!(s.env, vec![("A".to_string(), "1".to_string())]);
        assert_eq!(ExecSpec::parse(&json!({"cmd": "ls", "network": "limited"})).unwrap_err().details.unwrap()["reason"], "egress_unavailable");
        assert!(ExecSpec::parse(&json!({"cmd": "ls", "env": {"LD_PRELOAD": "x"}})).is_err());
        assert!(ExecSpec::parse(&json!({"args": []})).is_err());
    }

    #[test]
    fn builds_sandbox_arguments_from_grants() {
        let base = tmp("exec-args");
        let rw = base.join("rw");
        std::fs::create_dir_all(rw.join(".ssh")).unwrap();
        let ro = base.join("ro");
        let a = bwrap_args(&[(rw.clone(), true), (ro.clone(), false)], &rw, &spec("make", &["test"]));
        let s = a.join(" ");
        assert!(s.starts_with("--unshare-all --die-with-parent"));
        assert!(s.contains(&format!("--bind {} {}", rw.display(), rw.display())));
        assert!(s.contains(&format!("--ro-bind {} {}", ro.display(), ro.display())));
        assert!(s.contains(&format!("--ro-bind-try {}/.git", rw.display())));
        assert!(s.contains(&format!("--tmpfs {}/.ssh", rw.display())));
        assert!(s.contains("--clearenv"));
        assert!(s.ends_with("-- make test"));
        assert!(!s.contains("--share-net"));
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn refuses_without_a_sandbox_and_outside_grants() {
        let base = tmp("exec-run");
        let store = GrantStore::new(base.join("grants.json"), base.join("data"));
        let g = Grantee { kind: "agent".into(), id: "a".into() };
        let mut s = spec("true", &[]);
        s.cwd = Some(base.to_string_lossy().to_string());
        assert_eq!(run(&store, &g, &s, None).unwrap_err().details.unwrap()["reason"], "folder_access_required");
        store.grant(&g, "folder", base.to_str().unwrap(), "read", "device").unwrap();
        assert_eq!(run(&store, &g, &s, None).unwrap_err().code, "sandbox_unavailable");
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn runs_commands_with_timeouts_and_stdin() {
        let mut s = spec("/bin/sh", &["-c", "cat; echo err >&2; exit 4"]);
        s.stdin = Some("hello".into());
        let mut cmd = Command::new(&s.cmd);
        cmd.args(&s.args);
        let r = run_command(cmd, &s).unwrap();
        assert_eq!(r["stdout"], "hello");
        assert_eq!(r["stderr"], "err\n");
        assert_eq!(r["exitCode"], 4);
        let mut t = spec("/bin/sh", &["-c", "sleep 5"]);
        t.timeout_ms = 200;
        let mut cmd = Command::new(&t.cmd);
        cmd.args(&t.args);
        let started = Instant::now();
        let r = run_command(cmd, &t).unwrap();
        assert!(started.elapsed() < Duration::from_secs(3), "the whole tree is killed");
        assert_eq!(r["timedOut"], true);
        assert_eq!(r["exitCode"], Value::Null);
    }
}
