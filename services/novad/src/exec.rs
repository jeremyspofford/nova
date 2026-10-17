//! Sandboxed commands on the device for Hub sessions and connected agents (FR-081, FR-107,
//! docs/11 §2.3). On Linux every command runs under bubblewrap: new namespaces (no network), the
//! system read-only, only the grantee's folders bound (read-only or read-write by grant), the
//! protected locations inside them hidden or read-only, a cleared environment, a wall-clock limit
//! and capped output. Without a sandbox the command is refused (fail closed); network modes other
//! than `off` are refused until the device has an egress proxy (FR-193).
//!
//! Protected locations (FR-190, FR-210, docs/12 §7.2) follow the Hub's own sandbox
//! (packages/core/src/tools/sandbox-protect.ts). In every granted folder, and in each folder from
//! it down to the command's working folder, the credential locations of `paths.rs` (matched
//! case-insensitively, `credentials*` as a prefix) are hidden: an empty tmpfs for a folder,
//! /dev/null for a file. novad's data folder is hidden wherever a grant holds it. Inside write
//! grants `.git`, `.nova`, `.agents` and the shell startup files are bound read-only, and a `.git`
//! file (a linked worktree or submodule) is followed to its Git directory and common directory.
//! A protected path that is a link is resolved and its target protected when the target is in a
//! grant. Mounts go parents first. A location that does not exist when the command starts is not
//! covered (a mount point would have to be created on the device); mount points cannot be renamed
//! or deleted from inside, so a protected folder cannot be swapped out.

use crate::grants::{GrantStore, Grantee, Need};
use crate::hardening::{Limits, harden_command, is_loader_var};
use crate::paths::{CREDENTIAL_LOCATIONS, READ_ONLY_LOCATIONS, name_matches};
use crate::util::{OpError, OpResult};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::ffi::OsString;
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

/// A bubblewrap that can make namespaces here; the tests that run the real sandbox skip without.
#[cfg(test)]
pub fn working_bwrap() -> Option<PathBuf> {
    let b = find_bwrap()?;
    Command::new(&b)
        .args(["--unshare-all", "--ro-bind", "/", "/", "true"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
        .then_some(b)
}

/// One mount of a command's sandbox after the system folders, in the order bubblewrap applies it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Mount {
    /// A granted folder at its own path.
    Root { path: PathBuf, writable: bool },
    /// A protected location inside a write grant (`.git` and friends), bound read-only.
    ReadOnly(PathBuf),
    /// A credential folder, or novad's data folder, hidden behind an empty tmpfs.
    HideDir(PathBuf),
    /// A credential file, hidden behind /dev/null.
    HideFile(PathBuf),
}

impl Mount {
    pub fn path(&self) -> &Path {
        match self {
            Mount::Root { path, .. } => path,
            Mount::ReadOnly(p) | Mount::HideDir(p) | Mount::HideFile(p) => p,
        }
    }

    /// The bubblewrap arguments for this mount.
    pub fn args(&self) -> Vec<String> {
        let p = self.path().to_string_lossy().to_string();
        match self {
            Mount::Root { writable: true, .. } => vec!["--bind".into(), p.clone(), p],
            Mount::Root { writable: false, .. } | Mount::ReadOnly(_) => vec!["--ro-bind".into(), p.clone(), p],
            Mount::HideDir(_) => vec!["--tmpfs".into(), p],
            Mount::HideFile(_) => vec!["--ro-bind".into(), "/dev/null".into(), p],
        }
    }
}

/// Folder listings, each folder read once per command.
#[derive(Default)]
struct Lister(HashMap<PathBuf, Vec<OsString>>);

impl Lister {
    /// Entries of `dir` whose name matches one location segment (folded, `*` ends a prefix).
    fn matching(&mut self, dir: &Path, want: &str) -> Vec<PathBuf> {
        let names = self.0.entry(dir.to_path_buf()).or_insert_with(|| {
            std::fs::read_dir(dir).map(|it| it.flatten().map(|e| e.file_name()).collect()).unwrap_or_default()
        });
        names.iter().filter(|n| name_matches(want, &n.to_string_lossy())).map(|n| dir.join(n)).collect()
    }

    /// Paths under `dir` that match a location (several on a case-sensitive filesystem).
    fn locate(&mut self, dir: &Path, loc: &[&str]) -> Vec<PathBuf> {
        let mut found = vec![dir.to_path_buf()];
        for want in loc {
            found = found.iter().flat_map(|d| self.matching(d, want)).collect();
        }
        found
    }
}

/// The folders checked in a root: the root and each folder from it down to the working folder.
fn chain(root: &Path, cwd: &Path) -> Vec<PathBuf> {
    let mut out = vec![root.to_path_buf()];
    if let Ok(rest) = cwd.strip_prefix(root) {
        let mut cur = root.to_path_buf();
        for c in rest.components() {
            cur.push(c);
            out.push(cur.clone());
        }
    }
    out
}

/// Where `p` really is (links resolved) and whether it is a folder, when that is inside a mounted
/// root; a link to anywhere else points at nothing inside the sandbox.
fn target(p: &Path, roots: &[PathBuf]) -> Option<(PathBuf, bool)> {
    let real = std::fs::canonicalize(p).ok()?;
    if !roots.iter().any(|r| real.starts_with(r)) {
        return None;
    }
    let dir = std::fs::metadata(&real).ok()?.is_dir();
    Some((real, dir))
}

/// The Git directory a `.git` file (a linked worktree or submodule) names.
fn gitdir_of(file: &Path) -> Option<PathBuf> {
    let mut text = String::new();
    std::fs::File::open(file).ok()?.take(4096).read_to_string(&mut text).ok()?;
    let named = text.lines().find_map(|l| l.strip_prefix("gitdir:"))?.trim();
    if named.is_empty() {
        return None;
    }
    let p = Path::new(named);
    Some(if p.is_absolute() { p.to_path_buf() } else { file.parent()?.join(p) })
}

fn add(list: &mut Vec<PathBuf>, p: PathBuf) {
    if !list.contains(&p) {
        list.push(p);
    }
}

fn hide(hidden: &mut Vec<(PathBuf, bool)>, (p, dir): (PathBuf, bool)) {
    if !hidden.iter().any(|(h, _)| *h == p) {
        hidden.push((p, dir));
    }
}

/// The mounts for one command in `cwd`, parents before children: the granted folders (`roots`,
/// with write access or not), then the protected locations in them (docs/12 §7.2). `denied` are
/// folders hidden wherever a root holds them (novad's data folder). A grant of `/` is not mounted,
/// as on the Hub.
pub fn sandbox_mounts(roots: &[(PathBuf, bool)], cwd: &Path, denied: &[PathBuf]) -> Vec<Mount> {
    let roots: Vec<(PathBuf, bool)> = roots
        .iter()
        .map(|(p, w)| (std::fs::canonicalize(p).unwrap_or_else(|_| p.clone()), *w))
        .filter(|(p, _)| p.is_absolute() && p.parent().is_some())
        .collect();
    let all: Vec<PathBuf> = roots.iter().map(|(p, _)| p.clone()).collect();
    let writable: Vec<PathBuf> = roots.iter().filter(|(_, w)| *w).map(|(p, _)| p.clone()).collect();
    let cwd = std::fs::canonicalize(cwd).unwrap_or_else(|_| cwd.to_path_buf());
    // Hidden paths with whether each is a folder, and the read-only ones.
    let mut hidden: Vec<(PathBuf, bool)> = vec![];
    let mut read_only: Vec<PathBuf> = vec![];
    let mut list = Lister::default();
    // No Git invocation of novad's own needs `.git` writable, so a Git directory in a write grant
    // is read-only as a whole.
    let protect_git_dir = |git_dir: PathBuf, read_only: &mut Vec<PathBuf>| {
        if writable.iter().any(|r| git_dir.starts_with(r)) {
            add(read_only, git_dir);
        }
    };

    for (root, root_writable) in &roots {
        for dir in chain(root, &cwd) {
            for loc in CREDENTIAL_LOCATIONS {
                for p in list.locate(&dir, loc) {
                    if let Some(t) = target(&p, &all) {
                        hide(&mut hidden, t);
                    }
                }
            }
            if !root_writable {
                continue;
            }
            for loc in READ_ONLY_LOCATIONS {
                for p in list.locate(&dir, loc) {
                    let Some((path, is_dir)) = target(&p, &all) else { continue };
                    if loc.len() != 1 || loc[0] != ".git" {
                        add(&mut read_only, path);
                    } else if is_dir {
                        protect_git_dir(path, &mut read_only);
                    } else {
                        // A `.git` file: the file, the Git directory it names and that directory's
                        // common directory (where a linked worktree's config and hooks live).
                        add(&mut read_only, path.clone());
                        let Some((git_dir, true)) = gitdir_of(&path).and_then(|g| target(&g, &all)) else { continue };
                        protect_git_dir(git_dir.clone(), &mut read_only);
                        if let Ok(common) = std::fs::read_to_string(git_dir.join("commondir")) {
                            let c = Path::new(common.trim());
                            let c = if c.is_absolute() { c.to_path_buf() } else { git_dir.join(c) };
                            if let Some((c, true)) = target(&c, &all) {
                                protect_git_dir(c, &mut read_only);
                            }
                        }
                    }
                }
            }
        }
    }
    for d in denied {
        if let Some(t) = target(d, &all) {
            hide(&mut hidden, t);
        }
    }

    let mut mounts: Vec<Mount> = roots.into_iter().map(|(path, writable)| Mount::Root { path, writable }).collect();
    // Nothing is bound again inside a hidden folder: that would show what it hides.
    let inside_hidden = |p: &Path| hidden.iter().any(|(h, dir)| *dir && p != h && p.starts_with(h));
    for p in read_only {
        if !hidden.iter().any(|(h, _)| *h == p) && !inside_hidden(&p) {
            mounts.push(Mount::ReadOnly(p));
        }
    }
    for (p, dir) in &hidden {
        if !inside_hidden(p) {
            mounts.push(if *dir { Mount::HideDir(p.clone()) } else { Mount::HideFile(p.clone()) });
        }
    }
    // Parents first; at equal depth, roots before the protections on them (the sort is stable).
    mounts.sort_by_key(|m| m.path().components().count());
    mounts
}

/// The bubblewrap arguments for `grantee`'s command in `cwd`: its granted folders with their
/// protected locations, novad's data folder hidden.
pub fn grantee_bwrap_args(grants: &GrantStore, grantee: &Grantee, cwd: &Path, spec: &ExecSpec) -> OpResult<Vec<String>> {
    let roots = grants.roots(grantee)?;
    Ok(bwrap_args(&sandbox_mounts(&roots, cwd, &[grants.data_dir()]), cwd, spec))
}

/// The bubblewrap arguments for a command: system read-only, then `mounts` (see
/// [`sandbox_mounts`]), a cleared environment and the working folder.
pub fn bwrap_args(mounts: &[Mount], cwd: &Path, spec: &ExecSpec) -> Vec<String> {
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
    for m in mounts {
        a.extend(m.args());
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
    let mut cmd = Command::new(bwrap);
    cmd.args(grantee_bwrap_args(grants, grantee, &cwd.path, spec)?);
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
    fn builds_sandbox_arguments_from_mounts_in_order() {
        let m = vec![
            Mount::Root { path: "/g/rw".into(), writable: true },
            Mount::Root { path: "/g/ro".into(), writable: false },
            Mount::ReadOnly("/g/rw/.git".into()),
            Mount::HideDir("/g/rw/.ssh".into()),
            Mount::HideFile("/g/rw/.netrc".into()),
        ];
        let s = bwrap_args(&m, Path::new("/g/rw"), &spec("make", &["test"])).join(" ");
        assert!(s.starts_with("--unshare-all --die-with-parent"));
        assert!(s.contains(
            "--tmpfs /tmp --bind /g/rw /g/rw --ro-bind /g/ro /g/ro --ro-bind /g/rw/.git /g/rw/.git --tmpfs /g/rw/.ssh \
             --ro-bind /dev/null /g/rw/.netrc --chdir /g/rw --clearenv"
        ));
        assert!(s.ends_with("-- make test"));
        assert!(!s.contains("--share-net"));
    }

    fn mkdirs(base: &Path, dirs: &[&str]) {
        for d in dirs {
            std::fs::create_dir_all(base.join(d)).unwrap();
        }
    }

    fn touch(base: &Path, files: &[&str]) {
        for f in files {
            std::fs::write(base.join(f), "x").unwrap();
        }
    }

    #[test]
    fn hides_credentials_in_every_root_and_each_folder_down_to_the_working_folder() {
        let base = tmp("exec-mounts");
        let (rw, ro) = (base.join("rw"), base.join("ro"));
        mkdirs(&rw, &[".ssh", ".Cargo", ".config/gh", ".config/fish", ".git", "sub/.AWS", "sub/deeper/.gnupg", "sub/deeper/.git", "src"]);
        touch(&rw, &[".netrc", ".Cargo/Credentials.toml", ".Cargo/config.toml", ".zshrc", "src/main.rs"]);
        mkdirs(&ro, &[".ssh", ".git"]);
        let cwd = rw.join("sub/deeper");
        let m = sandbox_mounts(&[(rw.clone(), true), (ro.clone(), false)], &cwd, &[]);
        for want in [
            Mount::Root { path: rw.clone(), writable: true },
            Mount::Root { path: ro.clone(), writable: false },
            Mount::HideDir(rw.join(".ssh")),
            Mount::HideFile(rw.join(".netrc")),
            Mount::HideFile(rw.join(".Cargo/Credentials.toml")),
            Mount::HideDir(rw.join(".config/gh")),
            Mount::HideDir(rw.join("sub/.AWS")),
            Mount::HideDir(rw.join("sub/deeper/.gnupg")),
            Mount::HideDir(ro.join(".ssh")),
            Mount::ReadOnly(rw.join(".git")),
            Mount::ReadOnly(rw.join("sub/deeper/.git")),
            Mount::ReadOnly(rw.join(".config/fish")),
            Mount::ReadOnly(rw.join(".zshrc")),
        ] {
            assert!(m.contains(&want), "missing {want:?} in {m:#?}");
        }
        // Read-only locations matter only in write grants; ordinary files are left alone.
        assert!(!m.contains(&Mount::ReadOnly(ro.join(".git"))));
        assert!(!m.iter().any(|x| x.path() == rw.join(".Cargo/config.toml") || x.path() == rw.join("src")));
        assert_eq!(m.len(), 13);
        // Parents before children; roots before the protections at their depth.
        let depths: Vec<usize> = m.iter().map(|x| x.path().components().count()).collect();
        assert!(depths.windows(2).all(|w| w[0] <= w[1]), "{m:#?}");
        assert!(matches!(m[0], Mount::Root { .. }) && matches!(m[1], Mount::Root { .. }));
        // Locations that do not exist are not mounted.
        let empty = base.join("empty");
        mkdirs(&empty, &["a"]);
        assert_eq!(sandbox_mounts(&[(empty.clone(), true)], &empty.join("a"), &[]), vec![Mount::Root { path: empty, writable: true }]);
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn follows_links_and_linked_worktrees_and_hides_the_data_folder() {
        let base = tmp("exec-links");
        let rw = base.join("rw");
        mkdirs(&rw, &["keys", "main/.git/worktrees/wt", "main/.git/hooks", "wt"]);
        mkdirs(&base, &["outside/aws", "data/storage"]);
        std::os::unix::fs::symlink(rw.join("keys"), rw.join(".ssh")).unwrap();
        std::os::unix::fs::symlink(base.join("outside/aws"), rw.join(".aws")).unwrap();
        std::fs::write(rw.join("wt/.git"), format!("gitdir: {}\n", rw.join("main/.git/worktrees/wt").display())).unwrap();
        std::fs::write(rw.join("main/.git/worktrees/wt/commondir"), "../..\n").unwrap();
        let m = sandbox_mounts(&[(rw.clone(), true)], &rw.join("wt"), &[base.join("data")]);
        // A credential link inside the grant: its target is hidden. One to outside every grant
        // points at nothing in the sandbox.
        assert!(m.contains(&Mount::HideDir(rw.join("keys"))), "{m:#?}");
        assert!(!m.iter().any(|x| x.path().starts_with(base.join("outside"))));
        // A linked worktree: the `.git` file, its Git directory and the common directory.
        for p in [rw.join("wt/.git"), rw.join("main/.git/worktrees/wt"), rw.join("main/.git")] {
            assert!(m.contains(&Mount::ReadOnly(p.clone())), "missing {p:?} in {m:#?}");
        }
        // novad's data folder is hidden only when a grant holds it.
        assert!(!m.iter().any(|x| x.path().starts_with(base.join("data"))));
        let whole = sandbox_mounts(&[(base.clone(), false)], &base, &[base.join("data")]);
        assert!(whole.contains(&Mount::HideDir(base.join("data"))), "{whole:#?}");
        // A grant of the whole filesystem is not mounted (as on the Hub).
        assert!(sandbox_mounts(&[(PathBuf::from("/"), false)], Path::new("/"), &[]).is_empty());
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn nothing_is_bound_again_inside_a_hidden_folder() {
        let base = tmp("exec-nested");
        let (a, b) = (base.join("a"), base.join("b"));
        mkdirs(&base, &["a", "b/.git"]);
        // `.ssh` in one grant links to another whole grant: that grant is hidden, and its `.git`
        // is not bound read-only on top of the empty folder.
        std::os::unix::fs::symlink(&b, a.join(".ssh")).unwrap();
        let m = sandbox_mounts(&[(a.clone(), true), (b.clone(), true)], &a, &[]);
        assert!(m.contains(&Mount::HideDir(b.clone())), "{m:#?}");
        let hide_at = m.iter().position(|x| *x == Mount::HideDir(b.clone())).unwrap();
        let root_at = m.iter().position(|x| *x == Mount::Root { path: b.clone(), writable: true }).unwrap();
        assert!(root_at < hide_at);
        assert!(!m.iter().any(|x| x.path().starts_with(b.join(".git"))), "{m:#?}");
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn the_real_sandbox_hides_credentials_and_keeps_git_read_only() {
        let Some(bwrap) = working_bwrap() else {
            eprintln!("skipped: bubblewrap cannot make namespaces here");
            return;
        };
        let base = tmp("exec-real");
        let (proj, data) = (base.join("proj"), base.join("data"));
        mkdirs(&proj, &[".ssh", ".git", ".cargo", "sub/.AWS", "sub/deeper"]);
        mkdirs(&base, &["data"]);
        std::fs::write(proj.join(".ssh/id_x"), "SECRET-ssh").unwrap();
        std::fs::write(proj.join(".netrc"), "SECRET-netrc").unwrap();
        std::fs::write(proj.join(".cargo/credentials.toml"), "SECRET-cargo").unwrap();
        std::fs::write(proj.join("sub/.AWS/credentials"), "SECRET-aws").unwrap();
        std::fs::write(proj.join(".git/config"), "[core]\n").unwrap();
        std::fs::write(proj.join("readme.txt"), "visible").unwrap();
        std::fs::write(data.join("key.seed"), "SECRET-novad").unwrap();
        let store = GrantStore::new(data.join("grants.json"), data.clone());
        let g = Grantee { kind: "session".into(), id: "s1".into() };
        store.grant(&g, "folder", proj.to_str().unwrap(), "write", "hub").unwrap();
        let sh = |g: &Grantee, cwd: &Path, script: &str| {
            let mut s = spec("/bin/sh", &["-c", script]);
            s.cwd = Some(cwd.to_string_lossy().to_string());
            let r = run(&store, g, &s, Some(&bwrap)).unwrap();
            (r["stdout"].as_str().unwrap().to_string(), r["stderr"].as_str().unwrap().to_string())
        };

        let (out, err) = sh(
            &g,
            &proj,
            "cat .ssh/id_x; ls -A .ssh; cat .netrc .cargo/credentials.toml; cat readme.txt; echo; \
             echo '[x]' >> .git/config && echo GIT-WRITTEN; echo made > new.txt",
        );
        assert!(!out.contains("SECRET") && !out.contains("id_x"), "{out}");
        assert!(out.contains("visible"), "the rest of the grant is there: {out} {err}");
        assert!(!out.contains("GIT-WRITTEN") && err.contains("Read-only file system"), "{out} {err}");
        assert_eq!(std::fs::read_to_string(proj.join(".git/config")).unwrap(), "[core]\n");
        assert_eq!(std::fs::read_to_string(proj.join("new.txt")).unwrap(), "made\n", "the grant is writable");
        assert_eq!(std::fs::read_to_string(proj.join(".ssh/id_x")).unwrap(), "SECRET-ssh", "the host is untouched");

        // Every folder from the grant down to the working folder is covered.
        let (out, _) = sh(&g, &proj.join("sub/deeper"), "cat ../.AWS/credentials ../../.ssh/id_x; echo end");
        assert_eq!(out, "end\n");

        // novad's data folder is hidden inside a grant that holds it.
        let g2 = Grantee { kind: "agent".into(), id: "a2".into() };
        store.grant(&g2, "folder", base.to_str().unwrap(), "read", "device").unwrap();
        let (out, _) = sh(&g2, &base, "ls -A data; cat data/key.seed; echo end");
        assert_eq!(out, "end\n");
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
