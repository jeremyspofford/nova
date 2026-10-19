//! Long-running commands for Code sessions on a device (FR-062, FR-078): a process belongs to
//! novad, not to the Hub's connection, so it keeps running and buffering output when the
//! connection drops, and a later read continues from any offset. Each one runs in the same
//! sandbox as `exec` (grant folders bound with their credential locations hidden and `.git` and
//! friends read-only, no network, cleared environment); output (stdout and stderr interleaved)
//! keeps the newest 1 MiB.

use crate::exec::{ExecSpec, grantee_bwrap_args, kill_group};
use crate::grants::{GrantStore, Grantee, Need};
use crate::hardening::{Limits, harden_command};
use crate::util::{OpError, OpResult, iso, new_id, now_ms};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

const KEEP_BYTES: usize = 1024 * 1024;
const MAX_PER_GRANTEE: usize = 32;
const KEEP_EXITED_MS: u64 = 10 * 60_000;
const MAX_WAIT_MS: u64 = 30_000;

struct Output {
    /// Bytes dropped from the front (the buffer starts at this offset).
    start: u64,
    buf: Vec<u8>,
    running: bool,
    exit_code: Option<i32>,
    exited_ms: Option<u64>,
}

struct Proc {
    id: String,
    grantee: Grantee,
    cmd: String,
    cwd: String,
    tag: Option<String>,
    started_ms: u64,
    pid: u32,
    stdin: Mutex<Option<ChildStdin>>,
    out: Mutex<Output>,
    changed: Condvar,
}

#[derive(Default, Clone)]
pub struct Procs {
    table: Arc<Mutex<HashMap<String, Arc<Proc>>>>,
}

fn append(p: &Proc, data: &[u8]) {
    let mut o = p.out.lock().unwrap_or_else(|e| e.into_inner());
    o.buf.extend_from_slice(data);
    if o.buf.len() > KEEP_BYTES {
        let cut = o.buf.len() - KEEP_BYTES;
        o.buf.drain(..cut);
        o.start += cut as u64;
    }
    p.changed.notify_all();
}

impl Procs {
    fn prune(&self) {
        let now = now_ms();
        let mut t = self.table.lock().unwrap_or_else(|e| e.into_inner());
        t.retain(|_, p| {
            let o = p.out.lock().unwrap_or_else(|e| e.into_inner());
            o.running || o.exited_ms.is_none_or(|at| now.saturating_sub(at) < KEEP_EXITED_MS)
        });
    }

    fn get(&self, grantee: &Grantee, id: &str) -> OpResult<Arc<Proc>> {
        let t = self.table.lock().unwrap_or_else(|e| e.into_inner());
        t.get(id).filter(|p| &p.grantee == grantee).cloned().ok_or_else(|| OpError::not_found("no such process"))
    }

    /// Start `sh -c <cmd>` in the sandbox for `grantee`, with its working folder in a grant.
    pub fn spawn(&self, grants: &GrantStore, grantee: &Grantee, args: &Value, bwrap: Option<&Path>) -> OpResult<Value> {
        self.prune();
        let cmd = args["cmd"].as_str().filter(|c| !c.is_empty() && c.len() <= 100_000).ok_or_else(|| OpError::validation("cmd is required"))?;
        let cwd_raw = args["cwd"].as_str().ok_or_else(|| OpError::validation("cwd is required"))?;
        let cwd = grants.resolve(grantee, cwd_raw, Need::Read)?;
        if !cwd.path.is_dir() {
            return Err(OpError::validation("cwd is not a directory"));
        }
        let spec = ExecSpec::parse(&json!({ "cmd": "/bin/sh", "args": ["-c", cmd], "cwd": cwd_raw, "env": args["env"] }))?;
        let bwrap = bwrap.ok_or_else(|| OpError::new(409, "sandbox_unavailable", "no sandbox on this device; commands are refused (FR-107)"))?;
        {
            let t = self.table.lock().unwrap_or_else(|e| e.into_inner());
            if t.values().filter(|p| &p.grantee == grantee).count() >= MAX_PER_GRANTEE {
                return Err(OpError::new(429, "rate_limited", "too many processes for this session on the device"));
            }
        }
        let mut command = Command::new(bwrap);
        command.args(grantee_bwrap_args(grants, grantee, &cwd.path, &spec)?);
        Ok(json!({ "id": self.start(command, grantee, cmd, cwd_raw, args["tag"].as_str())? }))
    }

    /// Start an already prepared command (tests use it without a sandbox).
    pub fn start(&self, mut command: Command, grantee: &Grantee, cmd: &str, cwd: &str, tag: Option<&str>) -> OpResult<String> {
        harden_command(&mut command, &[], Limits::default());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        // On novad's spawner thread: the request's thread ends long before the process does.
        let mut child: Child = crate::hardening::spawn_kept(command).map_err(|e| OpError::new(409, "sandbox_unavailable", format!("the sandbox could not start: {e}")))?;
        let id = new_id();
        let p = Arc::new(Proc {
            id: id.clone(),
            grantee: grantee.clone(),
            cmd: cmd.chars().take(500).collect(),
            cwd: cwd.into(),
            tag: tag.map(|t| t.chars().take(200).collect()),
            started_ms: now_ms(),
            pid: child.id(),
            stdin: Mutex::new(child.stdin.take()),
            out: Mutex::new(Output { start: 0, buf: vec![], running: true, exit_code: None, exited_ms: None }),
            changed: Condvar::new(),
        });
        let readers: Vec<_> = [child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>), child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>)]
            .into_iter()
            .flatten()
            .map(|mut r| {
                let p = p.clone();
                std::thread::spawn(move || {
                    let mut chunk = [0u8; 8192];
                    while let Ok(n) = r.read(&mut chunk) {
                        if n == 0 {
                            break;
                        }
                        append(&p, &chunk[..n]);
                    }
                })
            })
            .collect();
        let waiter = p.clone();
        std::thread::spawn(move || {
            for r in readers {
                let _ = r.join();
            }
            let status = child.wait().ok();
            let mut o = waiter.out.lock().unwrap_or_else(|e| e.into_inner());
            o.running = false;
            o.exit_code = status.and_then(|s| s.code());
            o.exited_ms = Some(now_ms());
            waiter.changed.notify_all();
        });
        self.table.lock().unwrap_or_else(|e| e.into_inner()).insert(id.clone(), p);
        Ok(id)
    }

    /// Output from `offset`, waiting up to `wait_ms` for more while the process runs.
    pub fn read(&self, grantee: &Grantee, id: &str, offset: u64, wait_ms: u64) -> OpResult<Value> {
        let p = self.get(grantee, id)?;
        let deadline = Instant::now() + Duration::from_millis(wait_ms.min(MAX_WAIT_MS));
        let mut o = p.out.lock().unwrap_or_else(|e| e.into_inner());
        while o.running && o.start + o.buf.len() as u64 <= offset {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            o = p.changed.wait_timeout(o, left).map(|(g, _)| g).unwrap_or_else(|e| e.into_inner().0);
        }
        let end = o.start + o.buf.len() as u64;
        let from = offset.clamp(o.start, end);
        let dropped = o.start.saturating_sub(offset);
        let data = String::from_utf8_lossy(&o.buf[(from - o.start) as usize..]).to_string();
        Ok(json!({ "data": data, "offset": end, "dropped": dropped, "running": o.running, "exitCode": o.exit_code }))
    }

    pub fn write(&self, grantee: &Grantee, id: &str, args: &Value) -> OpResult<Value> {
        let p = self.get(grantee, id)?;
        if let Some(text) = args["text"].as_str() {
            let mut g = p.stdin.lock().unwrap_or_else(|e| e.into_inner());
            let s = g.as_mut().ok_or_else(|| OpError::conflict("stdin is closed"))?;
            s.write_all(text.as_bytes()).and_then(|_| s.flush()).map_err(|e| OpError::conflict(format!("the process does not read: {e}")))?;
        }
        if args["closeStdin"].as_bool() == Some(true) {
            p.stdin.lock().unwrap_or_else(|e| e.into_inner()).take();
        }
        match args["signal"].as_str() {
            Some("interrupt") => signal_group(p.pid, 2),
            Some("terminate") => kill_group(p.pid),
            Some(_) => return Err(OpError::validation("signal must be interrupt or terminate")),
            None => {}
        }
        Ok(json!({ "ok": true }))
    }

    pub fn list(&self, grantee: &Grantee) -> Value {
        self.prune();
        let t = self.table.lock().unwrap_or_else(|e| e.into_inner());
        let mut items: Vec<Value> = t
            .values()
            .filter(|p| &p.grantee == grantee)
            .map(|p| {
                let o = p.out.lock().unwrap_or_else(|e| e.into_inner());
                json!({
                    "id": p.id, "cmd": p.cmd, "cwd": p.cwd, "tag": p.tag, "running": o.running,
                    "exitCode": o.exit_code, "outputBytes": o.start + o.buf.len() as u64,
                    "startedAt": iso(p.started_ms),
                })
            })
            .collect();
        items.sort_by(|a, b| a["startedAt"].as_str().cmp(&b["startedAt"].as_str()));
        json!({ "processes": items })
    }
}

#[cfg(unix)]
unsafe extern "C" {
    fn kill(pid: i32, sig: i32) -> i32;
}

fn signal_group(pid: u32, sig: i32) {
    #[cfg(unix)]
    // SAFETY: a plain syscall wrapper; a negative pid names the group.
    unsafe {
        kill(-(pid as i32), sig);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::grants::tests::tmp;

    fn g() -> Grantee {
        Grantee { kind: "user".into(), id: "u".into() }
    }

    fn sh(p: &Procs, script: &str) -> String {
        let mut c = Command::new("/bin/sh");
        c.args(["-c", script]);
        p.start(c, &g(), script, "/", Some("t1")).unwrap()
    }

    #[test]
    fn buffers_output_and_reads_from_offsets() {
        let p = Procs::default();
        let id = sh(&p, "echo one; sleep 0.2; echo two >&2");
        let r = p.read(&g(), &id, 0, 2_000).unwrap();
        assert_eq!(r["data"], "one\n");
        let off = r["offset"].as_u64().unwrap();
        // Waits for more, then sees the exit.
        let mut r2 = p.read(&g(), &id, off, 2_000).unwrap();
        assert_eq!(r2["data"], "two\n");
        for _ in 0..50 {
            if r2["running"] == false {
                break;
            }
            r2 = p.read(&g(), &id, r2["offset"].as_u64().unwrap(), 100).unwrap();
        }
        assert_eq!(r2["running"], false);
        assert_eq!(r2["exitCode"], 0);
        // Reading again from 0 shows everything (a reconnect).
        assert_eq!(p.read(&g(), &id, 0, 0).unwrap()["data"], "one\ntwo\n");
        let l = p.list(&g());
        assert_eq!(l["processes"][0]["tag"], "t1");
        assert_eq!(l["processes"][0]["outputBytes"], 8);
        // Another grantee sees nothing.
        let other = Grantee { kind: "session".into(), id: "s".into() };
        assert_eq!(p.read(&other, &id, 0, 0).unwrap_err().code, "not_found");
        assert_eq!(p.list(&other)["processes"], json!([]));
    }

    #[test]
    fn stdin_signals_and_dropped_bytes() {
        let p = Procs::default();
        let id = sh(&p, "read l; echo got $l; sleep 30");
        p.write(&g(), &id, &json!({ "text": "hi\n" })).unwrap();
        let mut r = p.read(&g(), &id, 0, 2_000).unwrap();
        for _ in 0..20 {
            if r["data"].as_str().unwrap().contains("got") {
                break;
            }
            r = p.read(&g(), &id, 0, 100).unwrap();
        }
        assert_eq!(r["data"], "got hi\n");
        p.write(&g(), &id, &json!({ "signal": "terminate" })).unwrap();
        let mut done = p.read(&g(), &id, 0, 0).unwrap();
        for _ in 0..50 {
            if done["running"] == false {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
            done = p.read(&g(), &id, 0, 0).unwrap();
        }
        assert_eq!(done["running"], false);
        assert!(p.write(&g(), &id, &json!({ "signal": "hup" })).is_err());
        // More than the kept output: the front is dropped and reported.
        let big = sh(&p, "head -c 1100000 /dev/zero | tr '\\0' a");
        let mut last = p.read(&g(), &big, 0, 2_000).unwrap();
        for _ in 0..100 {
            if last["running"] == false {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
            last = p.read(&g(), &big, 0, 0).unwrap();
        }
        assert!(last["dropped"].as_u64().unwrap() >= 1_100_000 - KEEP_BYTES as u64);
        assert_eq!(last["data"].as_str().unwrap().len(), KEEP_BYTES);
    }

    /// Regression: a process started on a request's thread kept running after that thread ended
    /// only by luck; the parent-death signal follows the forking thread, so it was killed.
    #[test]
    fn processes_outlive_the_request_thread_that_started_them() {
        let p = Procs::default();
        let p2 = p.clone();
        let id = std::thread::spawn(move || sh(&p2, "echo started; sleep 1; echo later")).join().unwrap();
        std::thread::sleep(Duration::from_millis(300));
        let r = p.read(&g(), &id, 0, 2_000).unwrap();
        assert_eq!((r["running"].as_bool(), r["data"].as_str()), (Some(true), Some("started\n")), "{r}");
        let mut r = p.read(&g(), &id, r["offset"].as_u64().unwrap(), 3_000).unwrap();
        for _ in 0..100 {
            if r["running"] == false {
                break;
            }
            std::thread::sleep(Duration::from_millis(30));
            r = p.read(&g(), &id, 0, 0).unwrap();
        }
        assert_eq!((r["running"].as_bool(), r["exitCode"].as_i64()), (Some(false), Some(0)), "it ran to the end: {r}");
        assert!(p.read(&g(), &id, 0, 0).unwrap()["data"].as_str().unwrap().contains("later"));
    }

    #[test]
    fn spawn_needs_a_grant_and_a_sandbox() {
        let base = tmp("procs");
        let store = GrantStore::new(base.join("grants.json"), base.join("data"));
        let p = Procs::default();
        let args = json!({ "cmd": "ls", "cwd": base });
        assert_eq!(p.spawn(&store, &g(), &args, None).unwrap_err().details.unwrap()["reason"], "folder_access_required");
        store.grant(&g(), "folder", base.to_str().unwrap(), "read", "hub").unwrap();
        assert_eq!(p.spawn(&store, &g(), &args, None).unwrap_err().code, "sandbox_unavailable");
        assert!(p.spawn(&store, &g(), &json!({ "cwd": base }), None).is_err());
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn spawned_processes_get_the_protected_sandbox() {
        let Some(bwrap) = crate::exec::working_bwrap() else {
            eprintln!("skipped: bubblewrap cannot make namespaces here");
            return;
        };
        let base = tmp("procs-real");
        let proj = base.join("proj");
        std::fs::create_dir_all(proj.join(".SSH")).unwrap();
        std::fs::create_dir_all(proj.join(".git")).unwrap();
        std::fs::write(proj.join(".SSH/id_x"), "SECRET-ssh").unwrap();
        std::fs::write(proj.join(".git/config"), "[core]\n").unwrap();
        let store = GrantStore::new(base.join("data/grants.json"), base.join("data"));
        store.grant(&g(), "folder", proj.to_str().unwrap(), "write", "hub").unwrap();
        let p = Procs::default();
        let script = "cat .SSH/id_x; echo x >> .git/config || echo READ-ONLY; echo done";
        let id = p.spawn(&store, &g(), &json!({ "cmd": script, "cwd": proj }), Some(&bwrap)).unwrap()["id"].as_str().unwrap().to_string();
        let mut r = p.read(&g(), &id, 0, 2_000).unwrap();
        for _ in 0..250 {
            if r["running"] == false {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
            r = p.read(&g(), &id, 0, 0).unwrap();
        }
        assert_eq!(r["running"], false);
        let out = r["data"].as_str().unwrap();
        assert!(!out.contains("SECRET"), "{out}");
        assert!(out.contains("READ-ONLY") && out.contains("done"), "{out}");
        assert_eq!(std::fs::read_to_string(proj.join(".git/config")).unwrap(), "[core]\n");
        std::fs::remove_dir_all(&base).unwrap();
    }
}
