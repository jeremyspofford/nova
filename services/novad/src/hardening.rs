//! Process hardening (FR-141, docs/23 §9): no core dumps, not debuggable, and loader variables
//! stripped before any child starts. Uses the C library std already links, so no extra crates.

use std::process::Command;

#[cfg(unix)]
#[repr(C)]
struct Rlimit {
    cur: u64,
    max: u64,
}

#[cfg(unix)]
unsafe extern "C" {
    fn setrlimit(resource: i32, rlim: *const Rlimit) -> i32;
    fn getrlimit(resource: i32, rlim: *mut Rlimit) -> i32;
    fn geteuid() -> u32;
}

#[cfg(target_os = "linux")]
unsafe extern "C" {
    fn prctl(option: i32, arg2: u64, arg3: u64, arg4: u64, arg5: u64) -> i32;
}

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn ptrace(request: i32, pid: i32, addr: *mut u8, data: i32) -> i32;
}

#[cfg(unix)]
const RLIMIT_CORE: i32 = 4;
#[cfg(target_os = "linux")]
const RLIMIT_CPU: i32 = 0;
#[cfg(target_os = "linux")]
const RLIMIT_AS: i32 = 9;
#[cfg(target_os = "linux")]
const RLIMIT_NOFILE: i32 = 7;
#[cfg(target_os = "linux")]
const PR_SET_PDEATHSIG: i32 = 1;
#[cfg(target_os = "linux")]
const PR_GET_DUMPABLE: i32 = 3;
#[cfg(target_os = "linux")]
const PR_SET_DUMPABLE: i32 = 4;
#[cfg(target_os = "linux")]
const PR_SET_NO_NEW_PRIVS: i32 = 38;
#[cfg(target_os = "linux")]
const SIGKILL: u64 = 9;

/// Variables a child may inherit. Everything else (notably `LD_*` and `DYLD_*`) is dropped.
const ENV_ALLOW: &[&str] = &["PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "USER", "LOGNAME", "TMPDIR"];

/// Harden the current process: core dumps off and not dumpable (so not attachable by a
/// debugger of the same user) on Linux; debugger attachment denied on macOS.
pub fn harden_self() {
    #[cfg(unix)]
    unsafe {
        let zero = Rlimit { cur: 0, max: 0 };
        setrlimit(RLIMIT_CORE, &zero);
    }
    #[cfg(target_os = "linux")]
    unsafe {
        prctl(PR_SET_DUMPABLE, 0, 0, 0, 0);
    }
    #[cfg(target_os = "macos")]
    unsafe {
        // PT_DENY_ATTACH
        ptrace(31, 0, std::ptr::null_mut(), 0);
    }
}

/// Whether the current process is marked not dumpable (Linux); true elsewhere.
pub fn is_hardened() -> bool {
    #[cfg(target_os = "linux")]
    unsafe {
        let mut r = Rlimit { cur: 1, max: 1 };
        getrlimit(RLIMIT_CORE, &mut r);
        prctl(PR_GET_DUMPABLE, 0, 0, 0, 0) == 0 && r.cur == 0
    }
    #[cfg(not(target_os = "linux"))]
    {
        true
    }
}

pub fn is_root() -> bool {
    #[cfg(unix)]
    unsafe {
        geteuid() == 0
    }
    #[cfg(not(unix))]
    {
        false
    }
}

/// Environment for a child: the allowlist from the current environment plus `extra`. Loader
/// variables never pass, even when `extra` names them.
pub fn child_env(extra: &[(String, String)]) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = ENV_ALLOW
        .iter()
        .filter_map(|k| std::env::var(k).ok().map(|v| (k.to_string(), v)))
        .collect();
    for (k, v) in extra {
        if is_loader_var(k) {
            continue;
        }
        out.retain(|(x, _)| x != k);
        out.push((k.clone(), v.clone()));
    }
    out
}

pub fn is_loader_var(k: &str) -> bool {
    k.starts_with("LD_") || k.starts_with("DYLD_")
}

/// Resource caps for a child (FR-150 per-device caps, docs/23 §4 per-module policy).
#[derive(Debug, Clone, Copy, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cpu_seconds: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open_files: Option<u64>,
}

impl Limits {
    /// The tighter of two caps for each resource.
    pub fn min(self, other: Limits) -> Limits {
        let pick = |a: Option<u64>, b: Option<u64>| match (a, b) {
            (Some(x), Some(y)) => Some(x.min(y)),
            (x, None) => x,
            (None, y) => y,
        };
        Limits {
            memory_bytes: pick(self.memory_bytes, other.memory_bytes),
            cpu_seconds: pick(self.cpu_seconds, other.cpu_seconds),
            open_files: pick(self.open_files, other.open_files),
        }
    }
}

/// Start a child that must outlive the request that asked for it (a module, a Code process, a
/// browser). Every hardened child gets the kernel's parent-death signal, and Linux sends it when
/// the *thread* that forked the child exits, not the process: a child spawned on a request's
/// thread would be killed as soon as that request returned. So these are spawned on one thread
/// that lives as long as novad. A program written a moment ago can still be open for writing in a
/// process forked meanwhile (ETXTBSY); that clears within milliseconds, so it is retried.
pub fn spawn_kept(cmd: Command) -> std::io::Result<std::process::Child> {
    use std::sync::{Mutex, OnceLock, mpsc};
    type Job = (Command, mpsc::Sender<std::io::Result<std::process::Child>>);
    static TX: OnceLock<Mutex<mpsc::Sender<Job>>> = OnceLock::new();
    let tx = TX.get_or_init(|| {
        let (tx, rx) = mpsc::channel::<Job>();
        let _ = std::thread::Builder::new().name("novad-spawner".into()).spawn(move || {
            for (mut cmd, back) in rx {
                let mut tries = 0;
                let r = loop {
                    match cmd.spawn() {
                        Err(e) if e.raw_os_error() == Some(26) && tries < 10 => {
                            tries += 1;
                            std::thread::sleep(std::time::Duration::from_millis(20));
                        }
                        r => break r,
                    }
                };
                let _ = back.send(r);
            }
        });
        Mutex::new(tx)
    });
    let (back, answer) = mpsc::channel();
    tx.lock().unwrap_or_else(|p| p.into_inner()).send((cmd, back)).map_err(|_| std::io::Error::other("the spawner thread is gone"))?;
    answer.recv().map_err(|_| std::io::Error::other("the spawner thread is gone"))?
}

/// Prepare a command for a hardened child: cleared environment (allowlist plus `extra`), and on
/// Linux, in the child before exec: core dumps off, no new privileges, killed when novad dies,
/// and the resource caps.
pub fn harden_command(cmd: &mut Command, extra_env: &[(String, String)], limits: Limits) {
    cmd.env_clear();
    for (k, v) in child_env(extra_env) {
        cmd.env(k, v);
    }
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: only async-signal-safe calls (setrlimit, prctl) run between fork and exec.
        unsafe {
            cmd.pre_exec(move || {
                let zero = Rlimit { cur: 0, max: 0 };
                setrlimit(RLIMIT_CORE, &zero);
                prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0);
                prctl(PR_SET_PDEATHSIG, SIGKILL, 0, 0, 0);
                if let Some(m) = limits.memory_bytes {
                    setrlimit(RLIMIT_AS, &Rlimit { cur: m, max: m });
                }
                if let Some(c) = limits.cpu_seconds {
                    setrlimit(RLIMIT_CPU, &Rlimit { cur: c, max: c });
                }
                if let Some(n) = limits.open_files {
                    setrlimit(RLIMIT_NOFILE, &Rlimit { cur: n, max: n });
                }
                Ok(())
            });
        }
    }
    #[cfg(all(unix, not(target_os = "linux")))]
    {
        use std::os::unix::process::CommandExt;
        let _ = limits;
        // SAFETY: setrlimit is async-signal-safe.
        unsafe {
            cmd.pre_exec(|| {
                let zero = Rlimit { cur: 0, max: 0 };
                setrlimit(RLIMIT_CORE, &zero);
                Ok(())
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hardens_the_current_process() {
        harden_self();
        assert!(is_hardened());
    }

    #[test]
    fn strips_loader_variables_from_children() {
        let mut cmd = Command::new("/usr/bin/env");
        harden_command(
            &mut cmd,
            &[("LD_PRELOAD".into(), "/evil.so".into()), ("NOVA_X".into(), "1".into()), ("DYLD_INSERT_LIBRARIES".into(), "x".into())],
            Limits::default(),
        );
        let out = String::from_utf8(cmd.output().unwrap().stdout).unwrap();
        assert!(out.contains("NOVA_X=1"));
        assert!(!out.contains("LD_PRELOAD"));
        assert!(!out.contains("DYLD_"));
    }

    #[test]
    fn children_get_no_core_dumps_and_caps() {
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", "ulimit -c; ulimit -n"]);
        harden_command(&mut cmd, &[], Limits { open_files: Some(64), ..Default::default() });
        let out = String::from_utf8(cmd.output().unwrap().stdout).unwrap();
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines, vec!["0", "64"]);
    }

    /// The parent-death signal follows the thread that forked: a child spawned through
    /// `spawn_kept` from a thread that then ends keeps running.
    #[test]
    fn kept_children_outlive_the_thread_that_asked() {
        let kept = std::thread::spawn(|| {
            let mut cmd = Command::new("/bin/sh");
            cmd.args(["-c", "sleep 30"]);
            harden_command(&mut cmd, &[], Limits::default());
            spawn_kept(cmd).unwrap()
        })
        .join()
        .unwrap();
        #[cfg(target_os = "linux")]
        let direct = std::thread::spawn(|| {
            let mut cmd = Command::new("/bin/sh");
            cmd.args(["-c", "sleep 30"]);
            harden_command(&mut cmd, &[], Limits::default());
            cmd.spawn().unwrap()
        })
        .join()
        .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(300));
        let mut kept = kept;
        assert!(kept.try_wait().unwrap().is_none(), "still running");
        #[cfg(target_os = "linux")]
        {
            // What the bug looked like: spawned on a thread that ended, killed with it.
            let mut direct = direct;
            let t0 = std::time::Instant::now();
            let mut st = direct.try_wait().unwrap();
            while st.is_none() && t0.elapsed() < std::time::Duration::from_secs(3) {
                std::thread::sleep(std::time::Duration::from_millis(20));
                st = direct.try_wait().unwrap();
            }
            use std::os::unix::process::ExitStatusExt;
            assert_eq!(st.and_then(|s| s.signal()), Some(9));
        }
        kept.kill().unwrap();
        kept.wait().unwrap();
    }

    #[test]
    fn limits_take_the_tighter_cap() {
        let a = Limits { memory_bytes: Some(100), cpu_seconds: None, open_files: Some(10) };
        let b = Limits { memory_bytes: Some(50), cpu_seconds: Some(5), open_files: None };
        assert_eq!(a.min(b), Limits { memory_bytes: Some(50), cpu_seconds: Some(5), open_files: Some(10) });
    }
}
