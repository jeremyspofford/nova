//! The module supervisor (FR-141, docs/23 §1, §4, §10). Modules are declared in a manifest and run
//! as separate, hardened processes that the supervisor starts, stops, restarts and updates one by
//! one. A module talks to the supervisor over its stdin/stdout with one JSON object per line. A
//! crash stays inside the module's process: its in-flight calls fail with `node_unavailable`, the
//! supervisor restarts it with exponential backoff, and repeated crashes disable it. Every state
//! change is queued as an event the heartbeat reports to the Hub.

use crate::crypto::{Sha256, hex};
use crate::hardening::{Limits, harden_command};
use crate::util::{OpError, OpResult, iso, now_ms, read_json_or, write_json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};

pub const MODULES: &[&str] = &["management", "compute", "browser", "screen", "storage", "capture"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PreviousVersion {
    pub version: String,
    #[serde(default)]
    pub exec: Option<Vec<String>>,
    #[serde(default)]
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModuleSpec {
    pub name: String,
    pub version: String,
    /// Program and arguments; None runs this binary as `novad module <name>`.
    #[serde(default)]
    pub exec: Option<Vec<String>>,
    /// SHA-256 of the program, from the signed bundle that installed it; checked at every start.
    #[serde(default)]
    pub sha256: Option<String>,
    /// Start with the supervisor (and keep running).
    #[serde(default)]
    pub autostart: bool,
    #[serde(default)]
    pub limits: Limits,
    /// The version an update replaced, kept for rollback (FR-148).
    #[serde(default)]
    pub previous: Option<PreviousVersion>,
}

impl ModuleSpec {
    pub fn builtin(name: &str, autostart: bool) -> Self {
        ModuleSpec { name: name.into(), version: env!("CARGO_PKG_VERSION").into(), exec: None, sha256: None, autostart, limits: Limits::default(), previous: None }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Manifest {
    pub modules: Vec<ModuleSpec>,
}

impl Manifest {
    /// What a device installs by role (docs/23 §4): management and storage everywhere, compute on
    /// compute nodes. Browser, screen and capture are installed only when asked for.
    pub fn default_for(roles: &[String]) -> Self {
        let mut modules = vec![ModuleSpec::builtin("management", true), ModuleSpec::builtin("storage", true)];
        if roles.iter().any(|r| r == "compute") {
            modules.push(ModuleSpec::builtin("compute", true));
        }
        Manifest { modules }
    }

    pub fn load_or(path: &Path, default: Manifest) -> OpResult<Manifest> {
        let m: Manifest = read_json_or(path, default).map_err(|e| OpError::internal(e.to_string()))?;
        for spec in &m.modules {
            if !MODULES.contains(&spec.name.as_str()) {
                return Err(OpError::validation(format!("unknown module in the manifest: {}", spec.name)));
            }
        }
        Ok(m)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModState {
    Stopped,
    Running,
    Backoff,
    Disabled,
}

impl ModState {
    fn as_str(self) -> &'static str {
        match self {
            ModState::Stopped => "stopped",
            ModState::Running => "running",
            ModState::Backoff => "backoff",
            ModState::Disabled => "disabled",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Options {
    pub self_exe: PathBuf,
    pub data_dir: PathBuf,
    /// Where the manifest is saved after start/stop/update; None keeps it in memory (tests).
    pub manifest_path: Option<PathBuf>,
    pub backoff_base_ms: u64,
    pub backoff_max_ms: u64,
    pub crash_window_ms: u64,
    pub max_crashes: usize,
    pub stop_grace: Duration,
}

impl Options {
    pub fn new(self_exe: PathBuf, data_dir: PathBuf) -> Self {
        Options {
            self_exe,
            manifest_path: Some(data_dir.join("modules.json")),
            data_dir,
            backoff_base_ms: 1_000,
            backoff_max_ms: 60_000,
            crash_window_ms: 10 * 60_000,
            max_crashes: 5,
            stop_grace: Duration::from_secs(2),
        }
    }
}

/// The pipe to one running module.
struct Conn {
    stdin: Mutex<Option<ChildStdin>>,
    pending: Mutex<HashMap<u64, mpsc::Sender<Value>>>,
    next_id: AtomicU64,
    closed: AtomicBool,
}

impl Conn {
    fn call(&self, module: &str, op: &str, args: Value, timeout: Duration) -> OpResult<Value> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel();
        self.pending.lock().map_err(|_| OpError::internal("poisoned"))?.insert(id, tx);
        let line = format!("{}\n", json!({ "id": id, "op": op, "args": args }));
        let sent = {
            let mut guard = self.stdin.lock().map_err(|_| OpError::internal("poisoned"))?;
            match guard.as_mut() {
                Some(s) => s.write_all(line.as_bytes()).and_then(|_| s.flush()).is_ok(),
                None => false,
            }
        };
        if !sent || self.closed.load(Ordering::SeqCst) {
            self.forget(id);
            return Err(crashed(module));
        }
        match rx.recv_timeout(timeout) {
            Ok(resp) => {
                if resp["ok"].as_bool() == Some(true) {
                    Ok(resp.get("result").cloned().unwrap_or(Value::Null))
                } else {
                    let status = resp["status"].as_u64().unwrap_or(500) as u16;
                    Err(OpError::from_json(status, &resp["error"]))
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                self.forget(id);
                Err(OpError::new(504, "server_error", format!("the {module} module did not answer in time")))
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(crashed(module)),
        }
    }

    fn forget(&self, id: u64) {
        if let Ok(mut p) = self.pending.lock() {
            p.remove(&id);
        }
    }

    fn close(&self) {
        if let Ok(mut s) = self.stdin.lock() {
            s.take();
        }
    }
}

fn crashed(module: &str) -> OpError {
    OpError::unavailable(format!("the {module} module stopped while handling the request")).with(json!({ "reason": "module_crashed", "module": module }))
}

struct Slot {
    spec: ModuleSpec,
    child: Option<Child>,
    conn: Option<Arc<Conn>>,
    state: ModState,
    desired: bool,
    restarts: u32,
    crashes: VecDeque<u64>,
    next_start_ms: u64,
    last_exit: Option<String>,
    disabled_reason: Option<String>,
    started_ms: Option<u64>,
}

struct Inner {
    slots: Vec<Slot>,
    allowed: Option<Vec<String>>,
    caps: Limits,
    events: Vec<Value>,
}

#[derive(Clone)]
pub struct Supervisor {
    opts: Arc<Options>,
    inner: Arc<Mutex<Inner>>,
}

fn describe(status: std::process::ExitStatus) -> String {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(sig) = status.signal() {
            return format!("killed by signal {sig}");
        }
    }
    match status.code() {
        Some(c) => format!("exited with code {c}"),
        None => "exited".into(),
    }
}

/// SHA-256 of a file, hex.
pub fn file_sha256(path: &Path) -> std::io::Result<String> {
    let mut f = std::fs::File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(hex(&h.finalize()))
}

impl Supervisor {
    pub fn new(opts: Options, manifest: Manifest) -> Self {
        let slots = manifest
            .modules
            .into_iter()
            .map(|spec| Slot {
                desired: spec.autostart,
                spec,
                child: None,
                conn: None,
                state: ModState::Stopped,
                restarts: 0,
                crashes: VecDeque::new(),
                next_start_ms: 0,
                last_exit: None,
                disabled_reason: None,
                started_ms: None,
            })
            .collect();
        Supervisor { opts: Arc::new(opts), inner: Arc::new(Mutex::new(Inner { slots, allowed: None, caps: Limits::default(), events: vec![] })) }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        // A panic while holding the lock must not take the supervisor down with it.
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn manifest(&self) -> Manifest {
        Manifest { modules: self.lock().slots.iter().map(|s| s.spec.clone()).collect() }
    }

    fn save(&self) {
        if let Some(p) = &self.opts.manifest_path {
            let _ = write_json(p, &self.manifest(), false);
        }
    }

    /// Start every module marked autostart.
    pub fn start_all(&self) {
        let now = now_ms();
        let mut inner = self.lock();
        let Inner { slots, allowed, caps, events } = &mut *inner;
        for slot in slots.iter_mut().filter(|s| s.desired && s.child.is_none()) {
            if let Err(e) = spawn(&self.opts, slot, allowed.as_deref(), *caps, now) {
                start_failed(&self.opts, slot, &e, now, events);
            }
        }
    }

    /// Start (or re-enable) a module; it also starts with the supervisor from now on.
    pub fn start(&self, name: &str) -> OpResult<Value> {
        let now = now_ms();
        {
            let mut inner = self.lock();
            let Inner { slots, allowed, caps, events } = &mut *inner;
            let slot = slots.iter_mut().find(|s| s.spec.name == name).ok_or_else(|| not_installed(name))?;
            if let Some(list) = allowed.as_ref() {
                if !list.iter().any(|m| m == name) {
                    return Err(OpError::denied("module_not_allowed", format!("the {name} module is not allowed on this device")));
                }
            }
            slot.desired = true;
            slot.spec.autostart = true;
            slot.disabled_reason = None;
            slot.crashes.clear();
            if slot.child.is_none() {
                spawn(&self.opts, slot, allowed.as_deref(), *caps, now)?;
                events.push(json!({ "module": name, "kind": "started", "at": iso(now) }));
            }
        }
        self.save();
        self.status(name)
    }

    /// Stop a module: close its input so it exits, kill it after the grace period.
    pub fn stop(&self, name: &str) -> OpResult<Value> {
        let taken = {
            let mut inner = self.lock();
            let Inner { slots, events, .. } = &mut *inner;
            let slot = slots.iter_mut().find(|s| s.spec.name == name).ok_or_else(|| not_installed(name))?;
            slot.desired = false;
            slot.spec.autostart = false;
            if slot.state != ModState::Disabled {
                slot.state = ModState::Stopped;
            }
            events.push(json!({ "module": name, "kind": "stopped", "at": iso(now_ms()) }));
            (slot.child.take(), slot.conn.take())
        };
        terminate(taken, self.opts.stop_grace);
        self.save();
        self.status(name)
    }

    pub fn restart(&self, name: &str) -> OpResult<Value> {
        self.stop(name)?;
        self.start(name)
    }

    /// Reap exited modules and restart the ones that should run, with backoff.
    pub fn tick(&self) {
        self.tick_at(now_ms());
    }

    pub fn tick_at(&self, now: u64) {
        let mut inner = self.lock();
        let Inner { slots, allowed, caps, events } = &mut *inner;
        for slot in slots.iter_mut() {
            if let Some(child) = slot.child.as_mut() {
                if let Ok(Some(status)) = child.try_wait() {
                    slot.child = None;
                    if let Some(c) = slot.conn.take() {
                        c.closed.store(true, Ordering::SeqCst);
                        c.close();
                    }
                    let what = describe(status);
                    if slot.desired {
                        record_failure(&self.opts, slot, &what, now, events);
                    } else {
                        slot.last_exit = Some(what);
                        slot.state = ModState::Stopped;
                    }
                }
            }
            if slot.state == ModState::Backoff && slot.desired && slot.child.is_none() && now >= slot.next_start_ms {
                match spawn(&self.opts, slot, allowed.as_deref(), *caps, now) {
                    Ok(()) => {
                        slot.restarts += 1;
                        events.push(json!({ "module": slot.spec.name, "kind": "restarted", "at": iso(now), "restarts": slot.restarts }));
                    }
                    Err(e) => start_failed(&self.opts, slot, &e, now, events),
                }
            }
        }
    }

    /// Call an operation on a running module.
    pub fn call(&self, name: &str, op: &str, args: Value, timeout: Duration) -> OpResult<Value> {
        let conn = {
            let inner = self.lock();
            let slot = inner.slots.iter().find(|s| s.spec.name == name).ok_or_else(|| not_installed(name))?;
            match (&slot.conn, slot.state) {
                (Some(c), ModState::Running) => c.clone(),
                _ => {
                    return Err(OpError::unavailable(format!("the {name} module is not running")).with(json!({
                        "reason": "module_unavailable", "module": name, "state": slot.state.as_str()
                    })));
                }
            }
        };
        conn.call(name, op, args, timeout)
    }

    pub fn status(&self, name: &str) -> OpResult<Value> {
        let inner = self.lock();
        let slot = inner.slots.iter().find(|s| s.spec.name == name).ok_or_else(|| not_installed(name))?;
        Ok(slot_status(slot))
    }

    pub fn statuses(&self) -> Vec<Value> {
        self.lock().slots.iter().map(slot_status).collect()
    }

    pub fn names(&self) -> Vec<String> {
        self.lock().slots.iter().map(|s| s.spec.name.clone()).collect()
    }

    /// Events since the last drain (the heartbeat reports them).
    pub fn drain_events(&self) -> Vec<Value> {
        std::mem::take(&mut self.lock().events)
    }

    /// Per-device policy from the Hub (FR-150): modules outside `allowed` are stopped and refused;
    /// `caps` apply from each module's next start.
    pub fn set_policy(&self, allowed: Option<Vec<String>>, caps: Limits) {
        let (to_stop, to_start): (Vec<String>, Vec<String>) = {
            let mut inner = self.lock();
            inner.caps = caps;
            inner.allowed = allowed.clone();
            let ok = |n: &str| allowed.as_ref().is_none_or(|l| l.iter().any(|m| m == n));
            (
                inner.slots.iter().filter(|s| !ok(&s.spec.name) && (s.child.is_some() || s.desired)).map(|s| s.spec.name.clone()).collect(),
                inner
                    .slots
                    .iter()
                    .filter(|s| ok(&s.spec.name) && s.child.is_none() && s.disabled_reason.as_deref() == Some("not_allowed"))
                    .map(|s| s.spec.name.clone())
                    .collect(),
            )
        };
        for name in to_stop {
            let _ = self.stop(&name);
            let mut inner = self.lock();
            if let Some(s) = inner.slots.iter_mut().find(|s| s.spec.name == name) {
                // Not allowed is not the owner's choice: it starts again once allowed.
                s.spec.autostart = true;
                s.disabled_reason = Some("not_allowed".into());
            }
        }
        for name in to_start {
            let _ = self.start(&name);
        }
        self.save();
    }

    /// Install or replace a module's spec (an update); returns the previous spec.
    pub fn replace_spec(&self, spec: ModuleSpec) -> Option<ModuleSpec> {
        let prev = {
            let mut inner = self.lock();
            match inner.slots.iter_mut().find(|s| s.spec.name == spec.name) {
                Some(slot) => Some(std::mem::replace(&mut slot.spec, spec)),
                None => {
                    inner.slots.push(Slot {
                        desired: false,
                        spec,
                        child: None,
                        conn: None,
                        state: ModState::Stopped,
                        restarts: 0,
                        crashes: VecDeque::new(),
                        next_start_ms: 0,
                        last_exit: None,
                        disabled_reason: None,
                        started_ms: None,
                    });
                    None
                }
            }
        };
        self.save();
        prev
    }

    pub fn spec(&self, name: &str) -> Option<ModuleSpec> {
        self.lock().slots.iter().find(|s| s.spec.name == name).map(|s| s.spec.clone())
    }

    /// Healthy: running, answers `ping`, and still running after `settle`.
    pub fn wait_healthy(&self, name: &str, timeout: Duration, settle: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            self.tick();
            if self.call(name, "ping", json!({}), Duration::from_millis(500)).is_ok() {
                std::thread::sleep(settle);
                self.tick();
                let running = self.status(name).ok().and_then(|s| s["state"].as_str().map(|x| x == "running")).unwrap_or(false);
                return running && self.call(name, "ping", json!({}), Duration::from_millis(500)).is_ok();
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        false
    }

    /// Stop every module (shutdown, or the device was revoked).
    pub fn stop_all(&self) {
        let taken: Vec<_> = {
            let mut inner = self.lock();
            inner
                .slots
                .iter_mut()
                .map(|s| {
                    s.desired = false;
                    if s.state != ModState::Disabled {
                        s.state = ModState::Stopped;
                    }
                    (s.child.take(), s.conn.take())
                })
                .collect()
        };
        for t in taken {
            terminate(t, self.opts.stop_grace);
        }
    }

    /// Run `tick` every `every` on a background thread until the supervisor is dropped by all users.
    pub fn spawn_monitor(&self, every: Duration) -> std::thread::JoinHandle<()> {
        let weak = Arc::downgrade(&self.inner);
        let opts = self.opts.clone();
        std::thread::spawn(move || {
            while let Some(inner) = weak.upgrade() {
                Supervisor { opts: opts.clone(), inner }.tick();
                std::thread::sleep(every);
            }
        })
    }
}

fn not_installed(name: &str) -> OpError {
    OpError::not_found(format!("the {name} module is not installed on this device"))
}

fn slot_status(slot: &Slot) -> Value {
    json!({
        "name": slot.spec.name,
        "version": slot.spec.version,
        "state": slot.state.as_str(),
        "desired": slot.desired,
        "pid": slot.child.as_ref().map(Child::id),
        "restarts": slot.restarts,
        "lastExit": slot.last_exit,
        "disabledReason": slot.disabled_reason,
        "startedAt": slot.started_ms.map(iso),
        "previousVersion": slot.spec.previous.as_ref().map(|p| p.version.clone()),
    })
}

/// A start that failed: a refusal (not allowed, checksum mismatch) is final until the Hub or the
/// owner acts; anything else counts as a crash.
fn start_failed(opts: &Options, slot: &mut Slot, e: &OpError, now: u64, events: &mut Vec<Value>) {
    let reason = e.details.as_ref().and_then(|d| d["reason"].as_str()).unwrap_or_default();
    if matches!(reason, "module_not_allowed" | "checksum_mismatch") {
        slot.last_exit = Some(e.message.clone());
        events.push(json!({ "module": slot.spec.name, "kind": "refused", "at": iso(now), "reason": reason }));
        return;
    }
    record_failure(opts, slot, &e.message, now, events);
}

/// A crash (or a failed start): back off, or disable after too many in the window.
fn record_failure(opts: &Options, slot: &mut Slot, what: &str, now: u64, events: &mut Vec<Value>) {
    slot.last_exit = Some(what.to_string());
    slot.crashes.push_back(now);
    while slot.crashes.front().is_some_and(|t| now.saturating_sub(*t) > opts.crash_window_ms) {
        slot.crashes.pop_front();
    }
    events.push(json!({ "module": slot.spec.name, "kind": "crashed", "at": iso(now), "exit": what }));
    if slot.crashes.len() >= opts.max_crashes {
        slot.state = ModState::Disabled;
        slot.desired = false;
        slot.disabled_reason = Some("crash_loop".into());
        events.push(json!({ "module": slot.spec.name, "kind": "disabled", "at": iso(now), "reason": "crash_loop" }));
    } else {
        let n = slot.crashes.len().saturating_sub(1).min(16) as u32;
        let delay = opts.backoff_base_ms.saturating_mul(1u64 << n).min(opts.backoff_max_ms);
        slot.state = ModState::Backoff;
        slot.next_start_ms = now + delay;
    }
}

fn spawn(opts: &Options, slot: &mut Slot, allowed: Option<&[String]>, caps: Limits, now: u64) -> OpResult<()> {
    let name = slot.spec.name.clone();
    if let Some(list) = allowed {
        if !list.iter().any(|m| m == &name) {
            slot.state = ModState::Stopped;
            slot.disabled_reason = Some("not_allowed".into());
            return Err(OpError::denied("module_not_allowed", format!("the {name} module is not allowed on this device")));
        }
    }
    let argv = slot.spec.exec.clone().unwrap_or_else(|| {
        vec![opts.self_exe.to_string_lossy().to_string(), "module".into(), name.clone(), "--data-dir".into(), opts.data_dir.to_string_lossy().to_string()]
    });
    let (prog, args) = argv.split_first().ok_or_else(|| OpError::validation("empty module command"))?;
    if let Some(want) = &slot.spec.sha256 {
        let got = file_sha256(Path::new(prog)).map_err(|e| OpError::internal(format!("cannot hash the {name} module: {e}")))?;
        if &got != want {
            slot.state = ModState::Disabled;
            slot.desired = false;
            slot.disabled_reason = Some("checksum_mismatch".into());
            return Err(OpError::denied("checksum_mismatch", format!("the {name} module does not match its signed checksum")));
        }
    }
    let mut cmd = Command::new(prog);
    cmd.args(args);
    harden_command(&mut cmd, &[("NOVAD_MODULE".into(), name.clone())], slot.spec.limits.min(caps));
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit());
    // A program written a moment ago can still be open for writing in a process forked
    // meanwhile (ETXTBSY); that clears within milliseconds.
    let mut tries = 0;
    let mut child = loop {
        match cmd.spawn() {
            Ok(c) => break c,
            Err(e) if e.raw_os_error() == Some(26) && tries < 10 => {
                tries += 1;
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(e) => return Err(OpError::internal(format!("the {name} module did not start: {e}"))),
        }
    };
    let stdin = child.stdin.take();
    let stdout = child.stdout.take().ok_or_else(|| OpError::internal("no module stdout"))?;
    let conn = Arc::new(Conn { stdin: Mutex::new(stdin), pending: Mutex::new(HashMap::new()), next_id: AtomicU64::new(1), closed: AtomicBool::new(false) });
    let reader = conn.clone();
    std::thread::spawn(move || {
        let mut r = BufReader::new(stdout);
        loop {
            let mut line = String::new();
            match r.by_ref().take(64 * 1024 * 1024).read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let Ok(v) = serde_json::from_str::<Value>(line.trim()) else { continue };
                    let Some(id) = v["id"].as_u64() else { continue };
                    let tx = reader.pending.lock().ok().and_then(|mut p| p.remove(&id));
                    if let Some(tx) = tx {
                        let _ = tx.send(v);
                    }
                }
            }
        }
        // Wake every waiting caller: their senders drop here.
        reader.closed.store(true, Ordering::SeqCst);
        if let Ok(mut p) = reader.pending.lock() {
            p.clear();
        }
    });
    slot.child = Some(child);
    slot.conn = Some(conn);
    slot.state = ModState::Running;
    slot.started_ms = Some(now);
    slot.disabled_reason = None;
    Ok(())
}

fn terminate(taken: (Option<Child>, Option<Arc<Conn>>), grace: Duration) {
    let (child, conn) = taken;
    if let Some(c) = conn {
        c.close();
    }
    let Some(mut child) = child else { return };
    let deadline = Instant::now() + grace;
    while Instant::now() < deadline {
        if let Ok(Some(_)) = child.try_wait() {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::grants::tests::tmp;

    /// A module in POSIX sh that answers every request with `{"pong":true}`.
    pub const PONG: &str = r#"while IFS= read -r l; do id=$(printf '%s' "$l" | sed 's/.*"id":\([0-9]*\).*/\1/'); printf '{"id":%s,"ok":true,"result":{"pong":true}}\n' "$id"; done"#;

    fn sh(name: &str, script: &str) -> ModuleSpec {
        ModuleSpec { exec: Some(vec!["/bin/sh".into(), "-c".into(), script.into()]), ..ModuleSpec::builtin(name, true) }
    }

    pub fn opts(dir: &Path) -> Options {
        Options {
            self_exe: PathBuf::from("/bin/false"),
            data_dir: dir.to_path_buf(),
            manifest_path: None,
            backoff_base_ms: 20,
            backoff_max_ms: 80,
            crash_window_ms: 60_000,
            max_crashes: 3,
            stop_grace: Duration::from_millis(500),
        }
    }

    fn wait_for(f: impl Fn() -> bool) -> bool {
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if f() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        false
    }

    #[test]
    fn default_manifest_follows_roles() {
        let m = Manifest::default_for(&["client".into()]);
        assert_eq!(m.modules.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), vec!["management", "storage"]);
        let m = Manifest::default_for(&["compute".into()]);
        assert!(m.modules.iter().any(|s| s.name == "compute"));
    }

    #[test]
    fn runs_and_calls_modules_as_separate_processes() {
        let dir = tmp("sup1");
        let sup = Supervisor::new(opts(&dir), Manifest { modules: vec![sh("storage", PONG), sh("compute", PONG)] });
        sup.start_all();
        let r = sup.call("storage", "ping", json!({}), Duration::from_secs(2)).unwrap();
        assert_eq!(r["pong"], true);
        let a = sup.status("storage").unwrap()["pid"].as_u64().unwrap();
        let b = sup.status("compute").unwrap()["pid"].as_u64().unwrap();
        assert_ne!(a, b, "each module is its own process");
        // Stopping one leaves the other running.
        sup.stop("compute").unwrap();
        assert_eq!(sup.status("compute").unwrap()["state"], "stopped");
        assert!(sup.call("compute", "ping", json!({}), Duration::from_secs(1)).unwrap_err().details.unwrap()["reason"] == "module_unavailable");
        assert!(sup.call("storage", "ping", json!({}), Duration::from_secs(2)).is_ok());
        sup.start("compute").unwrap();
        assert!(sup.call("compute", "ping", json!({}), Duration::from_secs(2)).is_ok());
        assert_eq!(sup.call("browser", "ping", json!({}), Duration::from_secs(1)).unwrap_err().code, "not_found");
        sup.stop_all();
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_crash_is_contained_restarted_and_then_disabled() {
        let dir = tmp("sup2");
        // Answers nothing; exits after reading one line.
        let sup = Supervisor::new(opts(&dir), Manifest { modules: vec![sh("storage", "read l; exit 3"), sh("management", PONG)] });
        sup.start_all();
        let e = sup.call("storage", "ping", json!({}), Duration::from_secs(2)).unwrap_err();
        assert_eq!(e.details.unwrap()["reason"], "module_crashed");
        // The other module is unaffected.
        assert!(sup.call("management", "ping", json!({}), Duration::from_secs(2)).is_ok());
        assert!(wait_for(|| {
            sup.tick();
            sup.status("storage").unwrap()["state"] == "backoff"
        }));
        assert_eq!(sup.status("storage").unwrap()["lastExit"], "exited with code 3");
        // Backoff elapses and it restarts; two more crashes disable it.
        for _ in 0..2 {
            assert!(wait_for(|| {
                sup.tick();
                sup.status("storage").unwrap()["state"] == "running"
            }));
            let _ = sup.call("storage", "ping", json!({}), Duration::from_secs(2));
            assert!(wait_for(|| {
                sup.tick();
                sup.status("storage").unwrap()["state"] != "running"
            }));
        }
        let st = sup.status("storage").unwrap();
        assert_eq!(st["state"], "disabled");
        assert_eq!(st["disabledReason"], "crash_loop");
        assert!(st["restarts"].as_u64().unwrap() >= 2);
        let kinds: Vec<String> = sup.drain_events().iter().map(|e| e["kind"].as_str().unwrap().to_string()).collect();
        assert!(kinds.contains(&"crashed".to_string()) && kinds.contains(&"restarted".to_string()) && kinds.contains(&"disabled".to_string()));
        // An explicit start re-enables it.
        let sup2 = sup.clone();
        std::thread::sleep(Duration::from_millis(20));
        assert_eq!(sup2.start("storage").unwrap()["state"], "running");
        sup.stop_all();
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_killed_module_restarts() {
        let dir = tmp("sup3");
        let sup = Supervisor::new(opts(&dir), Manifest { modules: vec![sh("storage", PONG)] });
        sup.start_all();
        let pid = sup.status("storage").unwrap()["pid"].as_u64().unwrap();
        std::process::Command::new("/bin/sh").args(["-c", &format!("kill -9 {pid}")]).status().unwrap();
        assert!(wait_for(|| {
            sup.tick();
            let s = sup.status("storage").unwrap();
            s["state"] == "running" && s["pid"].as_u64() != Some(pid)
        }));
        assert!(sup.call("storage", "ping", json!({}), Duration::from_secs(2)).is_ok());
        assert_eq!(sup.status("storage").unwrap()["lastExit"], "killed by signal 9");
        sup.stop_all();
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn policy_stops_and_refuses_disallowed_modules() {
        let dir = tmp("sup4");
        let sup = Supervisor::new(opts(&dir), Manifest { modules: vec![sh("storage", PONG), sh("compute", PONG)] });
        sup.start_all();
        sup.set_policy(Some(vec!["storage".into()]), Limits::default());
        assert_eq!(sup.status("compute").unwrap()["state"], "stopped");
        assert_eq!(sup.status("compute").unwrap()["disabledReason"], "not_allowed");
        assert_eq!(sup.start("compute").unwrap_err().details.unwrap()["reason"], "module_not_allowed");
        sup.set_policy(None, Limits::default());
        assert_eq!(sup.start("compute").unwrap()["state"], "running");
        sup.stop_all();
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn checks_the_signed_checksum_before_starting() {
        let dir = tmp("sup5");
        let mut spec = sh("storage", PONG);
        spec.sha256 = Some("00".repeat(32));
        let sup = Supervisor::new(opts(&dir), Manifest { modules: vec![spec] });
        sup.start_all();
        let st = sup.status("storage").unwrap();
        assert_eq!(st["state"], "disabled");
        assert_eq!(st["disabledReason"], "checksum_mismatch");
        let mut ok = sh("storage", PONG);
        ok.sha256 = Some(file_sha256(Path::new("/bin/sh")).unwrap());
        sup.replace_spec(ok);
        assert_eq!(sup.start("storage").unwrap()["state"], "running");
        assert!(sup.wait_healthy("storage", Duration::from_secs(2), Duration::from_millis(50)));
        sup.stop_all();
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_hung_module_times_out_without_blocking_the_supervisor() {
        let dir = tmp("sup6");
        let sup = Supervisor::new(opts(&dir), Manifest { modules: vec![sh("storage", "while read l; do :; done")] });
        sup.start_all();
        let e = sup.call("storage", "ping", json!({}), Duration::from_millis(200)).unwrap_err();
        assert_eq!(e.status, 504);
        assert!(sup.status("storage").is_ok());
        sup.stop_all();
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
