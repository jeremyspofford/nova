//! The extension bridge (FR-096, docs/11 §4.3, docs/12 §15): the user's own Chromium-family
//! browser, through Nova's extension, reaches the Hub only through this device's novad, with no
//! third-party relay.
//!
//! ```text
//! extension --native messaging--> novad bridge-host --bridge.sock + token--> novad (browser module)
//!                                   (the user's process)                      |
//!                         Hub <--/agent/v1/bridge/events (device credential)--+
//!                         Hub --/agent/v1/bridge/call (management token)-----> novad --> extension
//! ```
//!
//! - Registration is the user's own act: `novad bridge enable`, run as that user (never root, never
//!   by the installer), writes a token to `~/.config/nova/bridge-token` (0600 in a 0700 folder) and
//!   the native-messaging host manifest `ai.nova.bridge.json` into the `NativeMessagingHosts`
//!   folder of each Chromium-family browser whose own config folder exists in the user's home,
//!   allowing only the extension id the device owner set (`config.json` `bridge.extensionId`,
//!   required; read from novad over the bridge socket when its config is not readable).
//!   `novad bridge disable` removes those manifests and the token. Nova writes nothing else into
//!   any browser's configuration.
//! - `novad bridge-host` (what the manifest starts; the browser passes the extension's origin)
//!   speaks native messaging on stdin and stdout (a 4-byte native-endian length, then JSON, at most
//!   1 MiB each way) and relays to the user's bridge socket with the same framing. It forwards only
//!   `call` frames to the extension and only `result`, `error` and `event` frames to novad.
//! - The browser module binds `bridge.sock` next to the local runtime's socket for each user in
//!   `localRuntime.users` (src/user_socket.rs: bound as the user, folder 0700, socket 0600, links
//!   refused). A connection must come from that user's uid (the kernel's peer credentials) and say
//!   `hello` with the token in that user's token file, which novad reads as the user (a forked
//!   child; root never follows anything in the user's home). A host must also name the configured
//!   extension's origin. One host is connected at a time; a newer one replaces it.
//! - Calls (`tabs.list`, `tabs.open`, `tab.attach`, `tab.detach`, `cdp.send`, `history.search`)
//!   wait for the extension's answer up to `timeoutMs` (default 30 s, 1 to 120 s); without a
//!   connected host they are 409 `bridge_offline`. Events from the extension (`tab.shared`,
//!   `tab.unshared`, `tab.closed`, `host.granted`, `host.revoked`) and novad's own `connected` and
//!   `disconnected` are queued (500 at most, oldest dropped) and the supervisor posts them to the
//!   Hub's `/agent/v1/bridge/events` with the device credential, like heartbeats.

use crate::crypto::constant_time_eq;
use crate::user_socket::{Account, UserSockets, Users};
use crate::util::{OpError, OpResult, now_iso};
use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};
use std::io::{self, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, mpsc};
use std::time::{Duration, Instant};

pub const MAX_FRAME: usize = 1024 * 1024;
pub const HOST_NAME: &str = "ai.nova.bridge";
pub const SOCKET_FILE: &str = "bridge.sock";
pub const TOKEN_PREFIX: &str = "nvbr_";
pub const METHODS: &[&str] = &["tabs.list", "tabs.open", "tab.attach", "tab.detach", "cdp.send", "history.search"];
pub const EXTENSION_EVENTS: &[&str] = &["tab.shared", "tab.unshared", "tab.closed", "host.granted", "host.revoked"];
pub const DEFAULT_CALL_MS: u64 = 30_000;
pub const MAX_CALL_MS: u64 = 120_000;
const MAX_EVENTS: usize = 500;
const MAX_EVENT_BYTES: usize = 16 * 1024;
/// Events per post to the Hub.
const EVENTS_PER_POST: usize = 100;
/// A post's body stays under the Hub's 1 MiB limit.
const MAX_POST_BYTES: usize = 900 * 1024;
const MAX_CONNECTIONS: usize = 8;
const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_WAIT_MS: u64 = 25_000;

// ---- Framing ---------------------------------------------------------------------------------

/// One native-messaging frame; None at a clean end of the stream.
pub fn read_frame<R: Read + ?Sized>(r: &mut R) -> io::Result<Option<Value>> {
    let mut len = [0u8; 4];
    let mut got = 0;
    while got < 4 {
        match r.read(&mut len[got..]) {
            Ok(0) if got == 0 => return Ok(None),
            Ok(0) => return Err(io::ErrorKind::UnexpectedEof.into()),
            Ok(n) => got += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    let n = u32::from_ne_bytes(len) as usize;
    if n > MAX_FRAME {
        return Err(io::Error::new(io::ErrorKind::InvalidData, format!("a message of {n} bytes is over the 1 MiB limit")));
    }
    let mut body = vec![0u8; n];
    r.read_exact(&mut body)?;
    serde_json::from_slice(&body).map(Some).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, format!("a message is not JSON: {e}")))
}

/// Write one frame (refused over 1 MiB, nothing written).
pub fn write_frame<W: Write + ?Sized>(w: &mut W, v: &Value) -> io::Result<()> {
    let body = serde_json::to_vec(v).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    if body.len() > MAX_FRAME {
        return Err(io::Error::new(io::ErrorKind::InvalidData, format!("a message of {} bytes is over the 1 MiB limit", body.len())));
    }
    let mut out = Vec::with_capacity(body.len() + 4);
    out.extend_from_slice(&(body.len() as u32).to_ne_bytes());
    out.extend_from_slice(&body);
    w.write_all(&out)?;
    w.flush()
}

// ---- Where things are ------------------------------------------------------------------------

/// A Chromium extension id: 32 letters a to p.
pub fn valid_extension_id(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|b| (b'a'..=b'p').contains(&b))
}

pub fn origin_of(extension_id: &str) -> String {
    format!("chrome-extension://{extension_id}/")
}

/// `~/.config/nova/bridge-token`.
pub fn token_path(home: &Path) -> PathBuf {
    home.join(".config").join("nova").join("bridge-token")
}

/// The user's bridge socket: `/run/user/<uid>/nova/bridge.sock`, or on macOS in Application Support.
pub fn socket_path(uid: u32, home: &Path, macos: bool) -> PathBuf {
    crate::user_socket::layout_for(&Account { uid, gid: 0, home: home.to_path_buf() }, Path::new("/run/user"), macos, SOCKET_FILE).socket
}

/// Each Chromium-family browser's own config folder in the user's home (integration targets);
/// the manifest goes in its `NativeMessagingHosts` folder, and only when the browser's folder
/// exists (Nova creates no browser's configuration).
pub fn browser_dirs(home: &Path, xdg_config: Option<&Path>, macos: bool) -> Vec<PathBuf> {
    if macos {
        let base = home.join("Library").join("Application Support");
        ["Chromium", "Google/Chrome", "Google/Chrome Beta", "Microsoft Edge", "BraveSoftware/Brave-Browser", "Vivaldi"].iter().map(|d| base.join(d)).collect()
    } else {
        let base = xdg_config.map(Path::to_path_buf).unwrap_or_else(|| home.join(".config"));
        ["chromium", "google-chrome", "google-chrome-beta", "google-chrome-unstable", "microsoft-edge", "microsoft-edge-beta", "BraveSoftware/Brave-Browser", "vivaldi"].iter().map(|d| base.join(d)).collect()
    }
}

/// The host manifest for one extension.
pub fn manifest(exe: &Path, extension_id: &str) -> Value {
    json!({
        "name": HOST_NAME,
        "description": "Nova extension bridge: relays to this device's novad",
        "path": exe,
        "type": "stdio",
        "allowed_origins": [origin_of(extension_id)],
    })
}

// ---- The user's side: enable, disable, the host ------------------------------------------------

/// The user's bridge token, made when missing (`nvbr_` + 256 random bits, 0600 in a 0700 folder).
pub fn ensure_token(home: &Path) -> OpResult<String> {
    let path = token_path(home);
    if let Ok(t) = std::fs::read_to_string(&path)
        && t.trim().starts_with(TOKEN_PREFIX)
        && t.trim().len() > 20
    {
        return Ok(t.trim().to_string());
    }
    let dir = path.parent().unwrap_or(home);
    std::fs::create_dir_all(dir)?;
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    let t = crate::util::new_token(TOKEN_PREFIX).map_err(OpError::internal)?;
    crate::util::write_atomic(&path, t.as_bytes(), true)?;
    Ok(t)
}

/// `novad bridge enable`: the token, then a manifest for each browser installed for this user.
pub fn enable(home: &Path, xdg_config: Option<&Path>, macos: bool, exe: &Path, extension_id: &str) -> OpResult<Value> {
    if !valid_extension_id(extension_id) {
        return Err(OpError::validation("bridge.extensionId is not a Chromium extension id (32 letters a-p)"));
    }
    let token = token_path(home);
    ensure_token(home)?;
    let text = serde_json::to_vec_pretty(&manifest(exe, extension_id)).map_err(|e| OpError::internal(e.to_string()))?;
    let mut written = vec![];
    let dirs = browser_dirs(home, xdg_config, macos);
    for d in dirs.iter().filter(|d| d.is_dir()) {
        let nmh = d.join("NativeMessagingHosts");
        std::fs::create_dir_all(&nmh)?;
        let p = nmh.join(format!("{HOST_NAME}.json"));
        crate::util::write_atomic(&p, &text, false)?;
        written.push(p);
    }
    if written.is_empty() {
        return Err(OpError::not_found(format!(
            "no Chromium-family browser folder was found for this user (looked in {}); start the browser once, then run this again",
            dirs.iter().map(|d| d.display().to_string()).collect::<Vec<_>>().join(", ")
        )));
    }
    Ok(json!({ "enabled": true, "extensionId": extension_id, "manifests": written, "token": token }))
}

/// `novad bridge disable`: every manifest and the token go.
pub fn disable(home: &Path, xdg_config: Option<&Path>, macos: bool) -> OpResult<Value> {
    let mut removed = vec![];
    for d in browser_dirs(home, xdg_config, macos) {
        let p = d.join("NativeMessagingHosts").join(format!("{HOST_NAME}.json"));
        if std::fs::symlink_metadata(&p).is_ok() && std::fs::remove_file(&p).is_ok() {
            removed.push(p);
        }
    }
    let token = token_path(home);
    if std::fs::symlink_metadata(&token).is_ok() && std::fs::remove_file(&token).is_ok() {
        removed.push(token);
    }
    Ok(json!({ "enabled": false, "removed": removed }))
}

/// Ask novad for the configured extension id over the user's bridge socket.
pub fn query_extension_id(sock: &Path, token: &str) -> OpResult<String> {
    let mut s = UnixStream::connect(sock).map_err(|e| OpError::unavailable(format!("novad's bridge socket {} did not answer ({e}); is novad running with you in localRuntime.users?", sock.display())))?;
    s.set_read_timeout(Some(HELLO_TIMEOUT))?;
    write_frame(&mut s, &json!({ "type": "hello", "role": "cli", "token": token }))?;
    let hello = read_frame(&mut s)?.unwrap_or(Value::Null);
    if hello["type"] != "welcome" {
        return Err(OpError::denied(hello["error"]["code"].as_str().unwrap_or("token_required"), hello["error"]["message"].as_str().unwrap_or("novad refused the bridge connection").to_string()));
    }
    write_frame(&mut s, &json!({ "type": "config" }))?;
    let c = read_frame(&mut s)?.unwrap_or(Value::Null);
    c["extensionId"].as_str().filter(|id| valid_extension_id(id)).map(str::to_string).ok_or_else(|| OpError::validation("bridge.extensionId is not set in novad's config; the device owner sets it first"))
}

/// The command line's `novad bridge enable|disable` (run as the user).
pub fn cli(action: &str, data_dir: &str, exe: &Path) -> Result<Value, String> {
    if crate::hardening::is_root() {
        return Err("run `novad bridge` as the user who uses the browser, not as root: the bridge is that user's choice".into());
    }
    let home = std::env::var_os("HOME").map(PathBuf::from).filter(|h| h.is_absolute()).ok_or("HOME is not set")?;
    let xdg = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).filter(|p| p.is_absolute());
    let macos = cfg!(target_os = "macos");
    match action {
        "enable" => {
            let token = ensure_token(&home).map_err(|e| e.to_string())?;
            // The owner's setting: from novad's config when this user can read it, else from novad.
            let configured = crate::state::DataDir(PathBuf::from(data_dir)).config().ok().and_then(|c| c.bridge.extension_id);
            let id = match configured {
                Some(id) => id,
                None => query_extension_id(&socket_path(unsafe { libc::getuid() }, &home, macos), &token).map_err(|e| e.to_string())?,
            };
            enable(&home, xdg.as_deref(), macos, exe, &id).map_err(|e| e.to_string())
        }
        "disable" => disable(&home, xdg.as_deref(), macos).map_err(|e| e.to_string()),
        other => Err(format!("unknown bridge action: {other}")),
    }
}

/// `novad bridge-host`: what the browser starts for the extension.
pub fn host_main(origin: Option<String>) -> i32 {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    let token = std::fs::read_to_string(token_path(&home)).ok().map(|t| t.trim().to_string());
    let sock = socket_path(unsafe { libc::getuid() }, &home, cfg!(target_os = "macos"));
    run_host(std::io::stdin(), std::io::stdout(), &sock, token, origin.as_deref().unwrap_or_default())
}

/// Relay between the extension (`ext_in`, `ext_out`) and novad's socket until either ends.
pub fn run_host<R: Read + Send + 'static, W: Write + Send + 'static>(ext_in: R, ext_out: W, sock: &Path, token: Option<String>, origin: &str) -> i32 {
    let out = Arc::new(Mutex::new(ext_out));
    let status = |connected: bool, reason: Option<&str>| {
        let _ = write_frame(&mut *out.lock().unwrap_or_else(|p| p.into_inner()), &json!({ "type": "status", "connected": connected, "reason": reason }));
    };
    let Some(token) = token.filter(|t| t.starts_with(TOKEN_PREFIX)) else {
        status(false, Some("not_enabled"));
        return 1;
    };
    let Ok(mut s) = UnixStream::connect(sock) else {
        status(false, Some("novad_unreachable"));
        return 1;
    };
    let _ = s.set_read_timeout(Some(HELLO_TIMEOUT));
    let _ = s.set_write_timeout(Some(Duration::from_secs(10)));
    if write_frame(&mut s, &json!({ "type": "hello", "role": "host", "token": token, "origin": origin, "version": env!("CARGO_PKG_VERSION") })).is_err() {
        status(false, Some("novad_unreachable"));
        return 1;
    }
    match read_frame(&mut s) {
        Ok(Some(v)) if v["type"] == "welcome" => {}
        Ok(Some(v)) => {
            status(false, Some(v["error"]["code"].as_str().unwrap_or("refused")));
            return 1;
        }
        _ => {
            status(false, Some("novad_unreachable"));
            return 1;
        }
    }
    let _ = s.set_read_timeout(None);
    status(true, None);
    let Ok(mut to_novad) = s.try_clone() else { return 1 };
    std::thread::spawn(move || {
        let mut ext_in = ext_in;
        while let Ok(Some(v)) = read_frame(&mut ext_in) {
            if matches!(v["type"].as_str(), Some("result" | "error" | "event")) && write_frame(&mut to_novad, &v).is_err() {
                break;
            }
        }
        // The extension went away: novad sees the socket close.
        let _ = to_novad.shutdown(std::net::Shutdown::Both);
    });
    while let Ok(Some(v)) = read_frame(&mut s) {
        if v["type"] == "call" && write_frame(&mut *out.lock().unwrap_or_else(|p| p.into_inner()), &v).is_err() {
            break;
        }
    }
    let _ = s.shutdown(std::net::Shutdown::Both);
    0
}

// ---- novad's side: the listener, calls and events ----------------------------------------------

struct Host {
    generation: u64,
    user: String,
    since: String,
    writer: Arc<Mutex<UnixStream>>,
}

/// The bridge in the browser module.
pub struct Bridge {
    extension_id: Option<String>,
    names: Vec<String>,
    users: Box<dyn Users>,
    /// The user's token file, read as the user (tests substitute it).
    token_of: Box<dyn Fn(&Account) -> OpResult<Option<Vec<u8>>> + Send + Sync>,
    host: Mutex<Option<Host>>,
    generation: AtomicU64,
    pending: Mutex<HashMap<u64, mpsc::Sender<Value>>>,
    next_id: AtomicU64,
    events: Mutex<VecDeque<Value>>,
    ready: Condvar,
    active: AtomicUsize,
    sockets: Mutex<Option<Arc<UserSockets>>>,
}

fn offline() -> OpError {
    OpError::new(409, "bridge_offline", "no browser extension is connected to this device's bridge")
}

impl Bridge {
    pub fn new(extension_id: Option<String>, names: Vec<String>, users: Box<dyn Users>) -> Bridge {
        Bridge {
            extension_id: extension_id.filter(|id| valid_extension_id(id)),
            names,
            users,
            token_of: Box::new(|a: &Account| crate::user_socket::read_as(a, &token_path(&a.home), 256)),
            host: Mutex::new(None),
            generation: AtomicU64::new(0),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            events: Mutex::new(VecDeque::new()),
            ready: Condvar::new(),
            active: AtomicUsize::new(0),
            sockets: Mutex::new(None),
        }
    }

    /// From the owner's config: the extension id, and the users of the local runtime's sockets.
    pub fn from_config(cfg: &crate::state::Config) -> Bridge {
        Bridge::new(cfg.bridge.extension_id.clone(), cfg.local_runtime.users.iter().filter(|u| crate::local_runtime::valid_user(u)).cloned().collect(), Box::new(crate::user_socket::SystemUsers))
    }

    /// Bind each user's `bridge.sock` (re-checked every 30 s, like the local runtime's).
    pub fn start(self: &Arc<Self>) {
        if self.names.is_empty() {
            return;
        }
        let me = self.clone();
        let us = Arc::new(UserSockets::system(self.names.clone(), Arc::new(move |c: UnixStream| me.accept(c))).named(SOCKET_FILE, "bridge"));
        us.watch(crate::user_socket::RECHECK);
        *self.sockets.lock().unwrap_or_else(|p| p.into_inner()) = Some(us);
    }

    /// One connection on a user's socket: a slot first (8 at most), then its own thread.
    pub fn accept(self: &Arc<Self>, conn: UnixStream) {
        if self.active.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
            self.active.fetch_sub(1, Ordering::SeqCst);
            return;
        }
        let me = self.clone();
        std::thread::spawn(move || {
            me.serve(conn);
            me.active.fetch_sub(1, Ordering::SeqCst);
        });
    }

    fn serve(&self, conn: UnixStream) {
        let _ = conn.set_read_timeout(Some(HELLO_TIMEOUT));
        let _ = conn.set_write_timeout(Some(Duration::from_secs(10)));
        let mut c = &conn;
        let refuse = |c: &mut &UnixStream, code: &str, message: &str| {
            let _ = write_frame(c, &json!({ "type": "error", "error": { "code": code, "message": message } }));
        };
        let uid = crate::user_socket::peer_uid(&conn);
        let Some((user, account)) = self.names.iter().find_map(|n| self.users.lookup(n).filter(|a| Some(a.uid) == uid).map(|a| (n.clone(), a))) else {
            return refuse(&mut c, "token_required", "this connection is not from a user novad serves");
        };
        let Ok(Some(hello)) = read_frame(&mut c) else { return };
        if hello["type"] != "hello" {
            return refuse(&mut c, "validation", "say hello first");
        }
        let presented = hello["token"].as_str().unwrap_or_default();
        let expected = match (self.token_of)(&account) {
            Ok(Some(b)) => String::from_utf8_lossy(&b).trim().to_string(),
            Ok(None) => String::new(),
            Err(e) => {
                eprintln!("novad bridge: user {user}: the bridge token cannot be read: {}", e.message);
                String::new()
            }
        };
        if !expected.starts_with(TOKEN_PREFIX) || !constant_time_eq(presented.as_bytes(), expected.as_bytes()) {
            return refuse(&mut c, "token_required", "the bridge token is missing or wrong; run `novad bridge enable`");
        }
        match hello["role"].as_str() {
            Some("cli") => {
                let _ = write_frame(&mut c, &json!({ "type": "welcome" }));
                while let Ok(Some(f)) = read_frame(&mut c) {
                    if f["type"] != "config" || write_frame(&mut c, &json!({ "type": "config", "extensionId": self.extension_id })).is_err() {
                        break;
                    }
                }
            }
            Some("host") => {
                let Some(id) = &self.extension_id else {
                    return refuse(&mut c, "bridge_not_configured", "the device owner has not set bridge.extensionId");
                };
                if hello["origin"].as_str() != Some(origin_of(id).as_str()) {
                    return refuse(&mut c, "origin_not_allowed", "this extension is not the one the device owner allowed");
                }
                self.run_host(conn, user);
            }
            _ => refuse(&mut c, "validation", "role must be host or cli"),
        }
    }

    /// A host is connected: it replaces any earlier one, then its frames are read until it ends.
    fn run_host(&self, conn: UnixStream, user: String) {
        let Ok(w) = conn.try_clone() else { return };
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let writer = Arc::new(Mutex::new(w));
        let old = {
            let mut h = self.host.lock().unwrap_or_else(|p| p.into_inner());
            // Another OS user's browser never takes over a connected one (its tabs and the agent
            // calls waiting on them are that user's), until that host disconnects.
            if let Some(other) = h.as_ref().filter(|x| x.user != user) {
                let msg = format!("the browser of user {} is connected to this device's bridge", other.user);
                drop(h);
                let mut c = &conn;
                let _ = write_frame(&mut c, &json!({ "type": "error", "error": { "code": "bridge_busy", "message": msg } }));
                return;
            }
            h.replace(Host { generation, user: user.clone(), since: now_iso(), writer: writer.clone() })
        };
        if let Some(o) = old {
            // The same user's newer host: the older one is gone, and the Hub hears so first.
            let _ = o.writer.lock().unwrap_or_else(|p| p.into_inner()).shutdown(std::net::Shutdown::Both);
            self.fail_pending();
            self.push_event(json!({ "kind": "disconnected", "user": o.user }));
        }
        if write_frame(&mut *writer.lock().unwrap_or_else(|p| p.into_inner()), &json!({ "type": "welcome" })).is_err() {
            return self.end_host(generation);
        }
        eprintln!("novad bridge: the extension of user {user} connected");
        self.push_event(json!({ "kind": "connected", "user": user }));
        let _ = conn.set_read_timeout(None);
        let mut r = &conn;
        while let Ok(Some(f)) = read_frame(&mut r) {
            self.on_frame(f);
        }
        self.end_host(generation);
    }

    fn end_host(&self, generation: u64) {
        let mut h = self.host.lock().unwrap_or_else(|p| p.into_inner());
        if h.as_ref().map(|x| x.generation) != Some(generation) {
            return;
        }
        let user = h.take().map(|x| x.user).unwrap_or_default();
        drop(h);
        self.fail_pending();
        eprintln!("novad bridge: the extension of user {user} disconnected");
        self.push_event(json!({ "kind": "disconnected", "user": user }));
    }

    /// Calls waiting on a host that went away get `bridge_offline` (their senders drop).
    fn fail_pending(&self) {
        self.pending.lock().unwrap_or_else(|p| p.into_inner()).clear();
    }

    fn on_frame(&self, f: Value) {
        match f["type"].as_str() {
            Some("result" | "error") => {
                let Some(id) = f["id"].as_u64() else { return };
                if let Some(tx) = self.pending.lock().unwrap_or_else(|p| p.into_inner()).remove(&id) {
                    let _ = tx.send(f);
                }
            }
            Some("event") => {
                let e = &f["event"];
                let ok = e.is_object() && e["kind"].as_str().is_some_and(|k| EXTENSION_EVENTS.contains(&k)) && serde_json::to_vec(e).map(|b| b.len()).unwrap_or(usize::MAX) <= MAX_EVENT_BYTES;
                if ok {
                    self.push_event(e.clone());
                }
            }
            _ => {}
        }
    }

    fn push_event(&self, mut e: Value) {
        e["at"] = json!(now_iso());
        let mut q = self.events.lock().unwrap_or_else(|p| p.into_inner());
        q.push_back(e);
        while q.len() > MAX_EVENTS {
            q.pop_front();
        }
        self.ready.notify_all();
    }

    /// `bridge.call {method, params?, timeoutMs?}` -> `{result}` or `{error: {code, message}}`.
    pub fn call(&self, args: &Value) -> OpResult<Value> {
        let method = args["method"].as_str().filter(|m| METHODS.contains(m)).ok_or_else(|| OpError::validation(format!("method must be one of {}", METHODS.join(", "))))?;
        let params = match &args["params"] {
            Value::Null => json!({}),
            v @ Value::Object(_) => v.clone(),
            _ => return Err(OpError::validation("params must be an object")),
        };
        let timeout = match &args["timeoutMs"] {
            Value::Null => DEFAULT_CALL_MS,
            v => v.as_u64().filter(|t| (1_000..=MAX_CALL_MS).contains(t)).ok_or_else(|| OpError::validation("timeoutMs must be 1000 to 120000"))?,
        };
        let writer = self.host.lock().unwrap_or_else(|p| p.into_inner()).as_ref().map(|h| h.writer.clone()).ok_or_else(offline)?;
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let frame = json!({ "type": "call", "id": id, "method": method, "params": params });
        if serde_json::to_vec(&frame).map(|b| b.len()).unwrap_or(usize::MAX) > MAX_FRAME {
            return Err(OpError::validation("the call is over the 1 MiB message limit"));
        }
        let (tx, rx) = mpsc::channel();
        self.pending.lock().unwrap_or_else(|p| p.into_inner()).insert(id, tx);
        if write_frame(&mut *writer.lock().unwrap_or_else(|p| p.into_inner()), &frame).is_err() {
            self.pending.lock().unwrap_or_else(|p| p.into_inner()).remove(&id);
            return Err(offline());
        }
        match rx.recv_timeout(Duration::from_millis(timeout)) {
            Ok(v) if v["type"] == "result" => Ok(json!({ "result": v.get("result").cloned().unwrap_or(Value::Null) })),
            Ok(v) => {
                let code = v["error"]["code"].as_str().filter(|c| !c.is_empty() && c.len() <= 64 && c.bytes().all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))).unwrap_or("extension_error");
                let message: String = v["error"]["message"].as_str().unwrap_or("the extension refused the call").chars().take(1000).collect();
                Ok(json!({ "error": { "code": code, "message": message } }))
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                self.pending.lock().unwrap_or_else(|p| p.into_inner()).remove(&id);
                Err(OpError::new(504, "server_error", format!("the extension did not answer within {timeout} ms")).with(json!({ "reason": "bridge_timeout" })))
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(offline()),
        }
    }

    /// `bridge.events {waitMs?}` -> `{events}`: what is queued, waiting up to 25 s for something.
    pub fn events(&self, args: &Value) -> Value {
        let wait = Duration::from_millis(args["waitMs"].as_u64().unwrap_or(0).min(MAX_WAIT_MS));
        let deadline = Instant::now() + wait;
        let mut q = self.events.lock().unwrap_or_else(|p| p.into_inner());
        while q.is_empty() {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            q = self.ready.wait_timeout(q, left).unwrap_or_else(|p| p.into_inner()).0;
        }
        json!({ "events": q.drain(..).collect::<Vec<_>>() })
    }

    /// `bridge.status {}`.
    pub fn status(&self) -> Value {
        let h = self.host.lock().unwrap_or_else(|p| p.into_inner());
        let users = self.sockets.lock().unwrap_or_else(|p| p.into_inner()).as_ref().map(|s| s.status()).unwrap_or(json!([]));
        json!({
            "configured": self.extension_id.is_some(),
            "connected": h.is_some(),
            "user": h.as_ref().map(|x| x.user.clone()),
            "since": h.as_ref().map(|x| x.since.clone()),
            "users": users,
        })
    }

    pub fn op(&self, op: &str, args: &Value) -> OpResult<Value> {
        match op {
            "bridge.call" => self.call(args),
            "bridge.events" => Ok(self.events(args)),
            "bridge.status" => Ok(self.status()),
            _ => Err(OpError::not_found(format!("the bridge has no operation {op}"))),
        }
    }
}

// ---- The supervisor's side: routes and the event pump ------------------------------------------

/// `/agent/v1/bridge/call` and `/agent/v1/bridge/status` through the browser module. A device
/// whose browser module is not installed or not running has no bridge: 409 `bridge_offline`.
pub fn route(sup: &crate::supervisor::Supervisor, action: &str, body: &Value) -> OpResult<Value> {
    let missing = |e: &OpError| e.status == 404 || e.details.as_ref().is_some_and(|d| d["reason"] == "module_unavailable");
    match action {
        "call" => {
            let t = body["timeoutMs"].as_u64().unwrap_or(DEFAULT_CALL_MS).min(MAX_CALL_MS);
            sup.call(crate::browser::MODULE, "bridge.call", body.clone(), Duration::from_millis(t) + Duration::from_secs(5)).map_err(|e| if missing(&e) { offline() } else { e })
        }
        "status" => match sup.call(crate::browser::MODULE, "bridge.status", json!({}), Duration::from_secs(5)) {
            Err(e) if missing(&e) => Ok(json!({ "configured": false, "connected": false, "user": null, "since": null, "users": [] })),
            r => r,
        },
        _ => Err(OpError::not_found("unknown bridge route")),
    }
}

/// How many of the oldest events fit one post: at most 100 and under 900 KiB (at least one).
fn batch_len(pending: &[Value]) -> usize {
    let mut bytes = 16;
    let mut n = 0;
    for e in pending.iter().take(EVENTS_PER_POST) {
        bytes += serde_json::to_vec(e).map(|b| b.len()).unwrap_or(MAX_POST_BYTES) + 1;
        if n > 0 && bytes > MAX_POST_BYTES {
            break;
        }
        n += 1;
    }
    n
}

/// Take the module's queued events and post the oldest to the Hub; true when the Hub took them.
/// Events stay in `pending` (500 at most) while the Hub is away or answers 5xx, 408 or 429. A 413
/// halves the batch until it fits, and drops a single event that still does not; any other 4xx
/// drops the batch with a log line (it would be refused again forever).
pub fn pump_once(agent: &crate::agent::Agent, pending: &mut Vec<Value>, wait: Duration) -> bool {
    if agent.sup.spec(crate::browser::MODULE).is_none() {
        return false;
    }
    if let Ok(v) = agent.sup.call(crate::browser::MODULE, "bridge.events", json!({ "waitMs": wait.as_millis() as u64 }), wait + Duration::from_secs(5)) {
        pending.extend(v["events"].as_array().cloned().unwrap_or_default());
    }
    if pending.len() > MAX_EVENTS {
        let n = pending.len() - MAX_EVENTS;
        pending.drain(..n);
    }
    if pending.is_empty() {
        return false;
    }
    let d = agent.device();
    let (Some(hub), Some(cred)) = (d.hub_url, d.credential) else { return false };
    let tls = agent.tls();
    let mut n = batch_len(pending);
    loop {
        match crate::http::post_json_with(&format!("{hub}/agent/v1/bridge/events"), Some(&cred), &json!({ "events": &pending[..n] }), Duration::from_secs(15), tls.as_deref()) {
            Ok((200, _)) => {
                pending.drain(..n);
                return true;
            }
            Ok((413, _)) if n > 1 => n /= 2,
            Ok((status, _)) if (400..500).contains(&status) && status != 408 && status != 429 => {
                eprintln!("novad bridge: the Hub refused {n} bridge event(s) with {status}; they are dropped");
                pending.drain(..n);
                return false;
            }
            Ok((status, _)) => {
                eprintln!("novad bridge: the Hub answered {status} to the bridge events; trying again later");
                return false;
            }
            Err(e) => {
                eprintln!("novad bridge: the bridge events did not reach the Hub: {e}");
                return false;
            }
        }
    }
}

/// Post bridge events while the device is enrolled.
pub fn spawn_pump(agent: Arc<crate::agent::Agent>) {
    std::thread::spawn(move || {
        let mut pending = vec![];
        while !agent.device().revoked {
            if agent.sup.spec(crate::browser::MODULE).is_none() {
                std::thread::sleep(Duration::from_secs(30));
                continue;
            }
            let had = pending.len();
            if !pump_once(&agent, &mut pending, Duration::from_secs(20)) && (had > 0 || !pending.is_empty()) {
                // The Hub or the module is away: try again a little later.
                std::thread::sleep(Duration::from_secs(5));
            }
        }
    });
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::grants::tests::tmp;
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    pub const EXT: &str = "abcdefghijklmnopabcdefghijklmnop";

    struct Me(Account);

    impl Users for Me {
        fn lookup(&self, name: &str) -> Option<Account> {
            (name == "alice").then(|| self.0.clone())
        }
    }

    fn me(base: &Path) -> Account {
        let m = std::fs::metadata(base).unwrap();
        Account { uid: m.uid(), gid: m.gid(), home: base.join("home") }
    }

    /// A bridge for the test user whose token file is `token` (or none).
    fn bridge(base: &Path, ext: Option<&str>, token: Option<&'static str>) -> Arc<Bridge> {
        let mut b = Bridge::new(ext.map(str::to_string), vec!["alice".into()], Box::new(Me(me(base))));
        b.token_of = Box::new(move |_| Ok(token.map(|t| t.as_bytes().to_vec())));
        Arc::new(b)
    }

    /// A connected pair: the bridge serves one end, the test holds the other.
    fn connect(b: &Arc<Bridge>) -> UnixStream {
        let (ours, theirs) = UnixStream::pair().unwrap();
        b.accept(theirs);
        ours.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        ours
    }

    fn hello(s: &mut UnixStream, role: &str, token: &str, origin: &str) -> Value {
        write_frame(s, &json!({ "type": "hello", "role": role, "token": token, "origin": origin })).unwrap();
        read_frame(s).unwrap().unwrap_or(Value::Null)
    }

    fn wait_for(f: impl Fn() -> bool) {
        let t0 = Instant::now();
        while !f() && t0.elapsed() < Duration::from_secs(5) {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(f());
    }

    const TOKEN: &str = "nvbr_0123456789abcdefghijklmnopqrstuvwxyz";

    #[test]
    fn frames_round_trip_and_refuse_oversize() {
        let v = json!({ "type": "call", "id": 7, "params": { "text": "h\u{e9}llo" } });
        let mut buf = Vec::new();
        write_frame(&mut buf, &v).unwrap();
        assert_eq!(&buf[..4], &((buf.len() - 4) as u32).to_ne_bytes());
        let mut r = &buf[..];
        assert_eq!(read_frame(&mut r).unwrap(), Some(v));
        assert_eq!(read_frame(&mut r).unwrap(), None, "a clean end");
        // Exactly 1 MiB passes; one byte more is refused both ways.
        let big = json!("x".repeat(MAX_FRAME - 2));
        let mut b = Vec::new();
        write_frame(&mut b, &big).unwrap();
        assert_eq!(b.len(), MAX_FRAME + 4);
        assert_eq!(read_frame(&mut &b[..]).unwrap(), Some(big));
        assert_eq!(write_frame(&mut Vec::new(), &json!("x".repeat(MAX_FRAME - 1))).unwrap_err().kind(), io::ErrorKind::InvalidData);
        let mut huge = ((MAX_FRAME + 1) as u32).to_ne_bytes().to_vec();
        huge.extend_from_slice(b"{}");
        assert_eq!(read_frame(&mut &huge[..]).unwrap_err().kind(), io::ErrorKind::InvalidData);
        // A cut frame and a frame that is not JSON.
        assert!(read_frame(&mut &[5u8, 0][..]).is_err());
        let mut bad = 3u32.to_ne_bytes().to_vec();
        bad.extend_from_slice(b"{x}");
        assert_eq!(read_frame(&mut &bad[..]).unwrap_err().kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn calls_wait_for_a_connected_host() {
        let base = tmp("bridge-call");
        let b = bridge(&base, Some(EXT), Some(TOKEN));
        // No host: offline.
        let e = b.call(&json!({ "method": "tabs.list" })).unwrap_err();
        assert_eq!((e.status, e.code.as_str()), (409, "bridge_offline"));
        // A host with a wrong token, a wrong origin, or before hello: refused.
        let mut s = connect(&b);
        assert_eq!(hello(&mut s, "host", "nvbr_wrong", &origin_of(EXT))["error"]["code"], "token_required");
        let mut s = connect(&b);
        assert_eq!(hello(&mut s, "host", TOKEN, "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba/")["error"]["code"], "origin_not_allowed");
        let mut s = connect(&b);
        write_frame(&mut s, &json!({ "type": "event" })).unwrap();
        assert_eq!(read_frame(&mut s).unwrap().unwrap()["error"]["code"], "validation");
        assert!(!b.status()["connected"].as_bool().unwrap());
        // The fake host: answers calls, sends an event.
        let mut host = connect(&b);
        assert_eq!(hello(&mut host, "host", TOKEN, &origin_of(EXT))["type"], "welcome");
        wait_for(|| b.status()["connected"] == true);
        let b2 = b.clone();
        let caller = std::thread::spawn(move || b2.call(&json!({ "method": "cdp.send", "params": { "tabId": 4, "method": "Page.navigate" }, "timeoutMs": 5000 })));
        let call = read_frame(&mut host).unwrap().unwrap();
        assert_eq!((call["type"].as_str(), call["method"].as_str(), call["params"]["tabId"].as_u64()), (Some("call"), Some("cdp.send"), Some(4)));
        write_frame(&mut host, &json!({ "type": "result", "id": call["id"], "result": { "frameId": "f1" } })).unwrap();
        assert_eq!(caller.join().unwrap().unwrap(), json!({ "result": { "frameId": "f1" } }));
        // An error answer passes as {error}, cleaned.
        let b2 = b.clone();
        let caller = std::thread::spawn(move || b2.call(&json!({ "method": "history.search", "params": { "text": "x" } })));
        let call = read_frame(&mut host).unwrap().unwrap();
        write_frame(&mut host, &json!({ "type": "error", "id": call["id"], "error": { "code": "user denied\n", "message": "no" } })).unwrap();
        assert_eq!(caller.join().unwrap().unwrap(), json!({ "error": { "code": "extension_error", "message": "no" } }));
        // A call nobody answers times out.
        let e = b.call(&json!({ "method": "tabs.list", "timeoutMs": 1000 })).unwrap_err();
        assert_eq!(e.details.unwrap()["reason"], "bridge_timeout");
        let _ = read_frame(&mut host).unwrap();
        // Bad calls.
        assert_eq!(b.call(&json!({ "method": "cookies.getAll" })).unwrap_err().code, "validation");
        assert_eq!(b.call(&json!({ "method": "tabs.list", "params": [] })).unwrap_err().code, "validation");
        assert_eq!(b.call(&json!({ "method": "tabs.list", "timeoutMs": 999_999 })).unwrap_err().code, "validation");
        // Events: the extension's own kinds only; novad adds connected and disconnected.
        write_frame(&mut host, &json!({ "type": "event", "event": { "kind": "tab.shared", "tabId": 4, "host": "github.com" } })).unwrap();
        write_frame(&mut host, &json!({ "type": "event", "event": { "kind": "connected" } })).unwrap();
        write_frame(&mut host, &json!({ "type": "event", "event": { "kind": "tab.closed", "tabId": 4 } })).unwrap();
        wait_for(|| b.events.lock().unwrap().len() >= 3);
        let ev = b.events(&json!({}));
        let kinds: Vec<&str> = ev["events"].as_array().unwrap().iter().map(|e| e["kind"].as_str().unwrap()).collect();
        assert_eq!(kinds, vec!["connected", "tab.shared", "tab.closed"]);
        assert!(ev["events"][1]["at"].is_string());
        // A call in flight when the host goes away: offline; then a disconnected event.
        let b2 = b.clone();
        let caller = std::thread::spawn(move || b2.call(&json!({ "method": "tabs.list" })));
        let _ = read_frame(&mut host).unwrap();
        drop(host);
        assert_eq!(caller.join().unwrap().unwrap_err().code, "bridge_offline");
        let ev = b.events(&json!({ "waitMs": 3000 }));
        assert_eq!(ev["events"][0]["kind"], "disconnected");
        assert_eq!(b.call(&json!({ "method": "tabs.list" })).unwrap_err().code, "bridge_offline");
        // Waiting for events ends after the wait.
        let t0 = Instant::now();
        assert_eq!(b.events(&json!({ "waitMs": 200 }))["events"], json!([]));
        assert!(t0.elapsed() >= Duration::from_millis(150));
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn a_newer_host_replaces_the_older_and_the_owner_must_configure_it() {
        let base = tmp("bridge-two");
        let b = bridge(&base, Some(EXT), Some(TOKEN));
        let mut one = connect(&b);
        assert_eq!(hello(&mut one, "host", TOKEN, &origin_of(EXT))["type"], "welcome");
        let mut two = connect(&b);
        assert_eq!(hello(&mut two, "host", TOKEN, &origin_of(EXT))["type"], "welcome");
        assert!(matches!(read_frame(&mut one), Ok(None) | Err(_)), "the older host is closed");
        wait_for(|| b.status()["connected"] == true);
        // The replaced host is reported gone before the new one is connected.
        let ev = b.events(&json!({}));
        let kinds: Vec<(&str, &str)> = ev["events"].as_array().unwrap().iter().map(|e| (e["kind"].as_str().unwrap(), e["user"].as_str().unwrap())).collect();
        assert_eq!(kinds, vec![("connected", "alice"), ("disconnected", "alice"), ("connected", "alice")]);
        // A host of another OS user is refused while this one is connected.
        let (mut theirs, ours) = UnixStream::pair().unwrap();
        theirs.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let b2 = b.clone();
        std::thread::spawn(move || b2.run_host(ours, "bob".into())).join().unwrap();
        assert_eq!(read_frame(&mut theirs).unwrap().unwrap()["error"]["code"], "bridge_busy");
        assert_eq!(b.status()["user"], "alice");
        assert_eq!(b.events(&json!({}))["events"], json!([]), "nothing changed");
        // Once alice's host is gone, bob's may connect.
        drop(two);
        wait_for(|| b.status()["connected"] == false);
        let (mut theirs, ours) = UnixStream::pair().unwrap();
        theirs.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let b2 = b.clone();
        std::thread::spawn(move || b2.run_host(ours, "bob".into()));
        assert_eq!(read_frame(&mut theirs).unwrap().unwrap()["type"], "welcome");
        wait_for(|| b.status()["user"] == "bob");
        drop(theirs);
        // The cli role asks for the extension id.
        let mut cli = connect(&b);
        assert_eq!(hello(&mut cli, "cli", TOKEN, "")["type"], "welcome");
        write_frame(&mut cli, &json!({ "type": "config" })).unwrap();
        assert_eq!(read_frame(&mut cli).unwrap().unwrap()["extensionId"], EXT);
        // Not configured: hosts are refused; no token file: everyone is refused.
        let n = bridge(&base, None, Some(TOKEN));
        let mut s = connect(&n);
        assert_eq!(hello(&mut s, "host", TOKEN, &origin_of(EXT))["error"]["code"], "bridge_not_configured");
        let none = bridge(&base, Some(EXT), None);
        let mut s = connect(&none);
        assert_eq!(hello(&mut s, "cli", TOKEN, "")["error"]["code"], "token_required");
        // A connection from a uid novad does not serve.
        let other = Bridge::new(Some(EXT.into()), vec!["bob".into()], Box::new(Me(me(&base))));
        let other = Arc::new(other);
        let mut s = connect(&other);
        assert_eq!(read_frame(&mut s).unwrap().unwrap()["error"]["code"], "token_required");
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn the_host_relays_between_the_extension_and_the_socket() {
        let base = tmp("bridge-host");
        let b = bridge(&base, Some(EXT), Some(TOKEN));
        // A real socket for the host to dial.
        let sock = base.join("b.sock");
        let listener = std::os::unix::net::UnixListener::bind(&sock).unwrap();
        let b2 = b.clone();
        std::thread::spawn(move || {
            for c in listener.incoming().flatten() {
                b2.accept(c);
            }
        });
        // The extension's side: frames in through a pipe, frames out into a buffer.
        let (ext_r, mut ext_w) = UnixStream::pair().unwrap();
        let (out_r, out_w) = UnixStream::pair().unwrap();
        out_r.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let s2 = sock.clone();
        let host = std::thread::spawn(move || run_host(ext_r, out_w, &s2, Some(TOKEN.into()), &origin_of(EXT)));
        let mut out_r = out_r;
        assert_eq!(read_frame(&mut out_r).unwrap().unwrap(), json!({ "type": "status", "connected": true, "reason": null }));
        wait_for(|| b.status()["connected"] == true);
        let b3 = b.clone();
        let caller = std::thread::spawn(move || b3.call(&json!({ "method": "tabs.open", "params": { "url": "https://github.com/" } })));
        let call = read_frame(&mut out_r).unwrap().unwrap();
        assert_eq!(call["method"], "tabs.open");
        // A stray hello from the extension is not passed on; its result is.
        write_frame(&mut ext_w, &json!({ "type": "hello", "role": "cli", "token": "x" })).unwrap();
        write_frame(&mut ext_w, &json!({ "type": "result", "id": call["id"], "result": { "tabId": 9 } })).unwrap();
        assert_eq!(caller.join().unwrap().unwrap()["result"]["tabId"], 9);
        // The extension goes away: the host ends, novad sees it disconnect.
        drop(ext_w);
        assert_eq!(host.join().unwrap(), 0);
        wait_for(|| b.status()["connected"] == false);
        // Without a token, or with novad away, the host says so and stops.
        let (r, _w) = UnixStream::pair().unwrap();
        let (o_r, o_w) = UnixStream::pair().unwrap();
        assert_eq!(run_host(r, o_w, &sock, None, &origin_of(EXT)), 1);
        let mut o_r = o_r;
        assert_eq!(read_frame(&mut o_r).unwrap().unwrap()["reason"], "not_enabled");
        let (r, _w) = UnixStream::pair().unwrap();
        let (o_r, o_w) = UnixStream::pair().unwrap();
        assert_eq!(run_host(r, o_w, &base.join("none.sock"), Some(TOKEN.into()), &origin_of(EXT)), 1);
        let mut o_r = o_r;
        assert_eq!(read_frame(&mut o_r).unwrap().unwrap()["reason"], "novad_unreachable");
        let (r, _w) = UnixStream::pair().unwrap();
        let (o_r, o_w) = UnixStream::pair().unwrap();
        // secret-scan: fake
        assert_eq!(run_host(r, o_w, &sock, Some("nvbr_other_token_value_xx".into()), &origin_of(EXT)), 1);
        let mut o_r = o_r;
        assert_eq!(read_frame(&mut o_r).unwrap().unwrap()["reason"], "token_required");
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn enable_writes_only_its_own_manifest_for_installed_browsers() {
        let base = tmp("bridge-enable");
        let home = base.join("home");
        std::fs::create_dir_all(home.join(".config/chromium")).unwrap();
        std::fs::create_dir_all(home.join(".config/BraveSoftware/Brave-Browser")).unwrap();
        let exe = PathBuf::from("/usr/local/bin/novad");
        assert_eq!(enable(&home, None, false, &exe, "not-an-id").unwrap_err().code, "validation");
        let r = enable(&home, None, false, &exe, EXT).unwrap();
        let written: Vec<PathBuf> = serde_json::from_value(r["manifests"].clone()).unwrap();
        assert_eq!(written, vec![home.join(".config/chromium/NativeMessagingHosts/ai.nova.bridge.json"), home.join(".config/BraveSoftware/Brave-Browser/NativeMessagingHosts/ai.nova.bridge.json")]);
        let m: Value = serde_json::from_slice(&std::fs::read(&written[0]).unwrap()).unwrap();
        assert_eq!(m, manifest(&exe, EXT));
        assert_eq!(m["allowed_origins"], json!([format!("chrome-extension://{EXT}/")]));
        assert!(!home.join(".config/google-chrome").exists(), "no folder made for a browser that is not there");
        // The token: 0600 in a 0700 folder, kept across enables.
        let t = std::fs::read_to_string(token_path(&home)).unwrap();
        assert!(t.starts_with(TOKEN_PREFIX));
        assert_eq!(std::fs::metadata(token_path(&home)).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(std::fs::metadata(home.join(".config/nova")).unwrap().permissions().mode() & 0o777, 0o700);
        enable(&home, None, false, &exe, EXT).unwrap();
        assert_eq!(std::fs::read_to_string(token_path(&home)).unwrap(), t);
        // XDG_CONFIG_HOME moves the browsers' folders; macOS has its own.
        assert_eq!(browser_dirs(&home, Some(Path::new("/x")), false)[0], PathBuf::from("/x/chromium"));
        assert_eq!(browser_dirs(&home, None, true)[1], home.join("Library/Application Support/Google/Chrome"));
        // Disable removes the manifests and the token, nothing else.
        let d = disable(&home, None, false).unwrap();
        assert_eq!(d["removed"].as_array().unwrap().len(), 3);
        assert!(!written[0].exists() && !token_path(&home).exists());
        assert!(home.join(".config/chromium").is_dir());
        // No browser at all: nothing written, and the reason says where it looked.
        let empty = base.join("empty");
        std::fs::create_dir_all(&empty).unwrap();
        assert!(enable(&empty, None, false, &exe, EXT).unwrap_err().message.contains("chromium"));
        std::fs::remove_dir_all(&base).unwrap();
    }

    /// An enrolled agent whose `browser` module (when `events` is Some) answers every request with
    /// those bridge events.
    fn agent_with(base: &Path, events: Option<&str>) -> crate::agent::Agent {
        let data = crate::state::DataDir(base.join("data"));
        data.ensure().unwrap();
        let mut st = data.new_device("box", vec!["client".into()]).unwrap();
        st.management_token = Some("nvdm_test".into());
        st.credential = Some("nvc_test".into());
        let sh = |name: &str, script: String| crate::supervisor::ModuleSpec { exec: Some(vec!["/bin/sh".into(), "-c".into(), script]), ..crate::supervisor::ModuleSpec::builtin(name, true) };
        let mut modules = vec![sh("storage", crate::supervisor::tests::PONG.into())];
        if let Some(ev) = events {
            modules.push(sh(
                "browser",
                format!(r#"while IFS= read -r l; do id=$(printf '%s' "$l" | sed 's/.*"id":\([0-9]*\).*/\1/'); printf '{{"id":%s,"ok":true,"result":{{"events":{ev}}}}}\n' "$id"; done"#),
            ));
        }
        let a = crate::agent::Agent::new(data, PathBuf::from("/bin/false"), st, crate::supervisor::Manifest { modules });
        a.sup.start_all();
        a
    }

    #[test]
    fn the_supervisor_posts_bridge_events_with_the_device_credential() {
        let base = tmp("bridge-pump");
        let a = agent_with(&base, Some(r#"[{"kind":"tab.shared","tabId":1}]"#));
        let seen = Arc::new(Mutex::new(Vec::<(String, Option<String>, Value)>::new()));
        let answer = Arc::new(AtomicUsize::new(200));
        let (s2, a2) = (seen.clone(), answer.clone());
        let hub = crate::http::serve(
            std::net::TcpListener::bind("127.0.0.1:0").unwrap(),
            1 << 20,
            Arc::new(move |req: crate::http::Request| {
                s2.lock().unwrap().push((req.path.clone(), req.bearer().map(str::to_string), req.json().unwrap()));
                crate::http::Response::json(a2.load(Ordering::SeqCst) as u16, &json!({ "ok": true }))
            }),
        );
        a.state.lock().unwrap().hub_url = Some(format!("http://{}", hub.local_addr()));
        let mut pending = vec![];
        assert!(pump_once(&a, &mut pending, Duration::from_millis(100)));
        assert!(pending.is_empty());
        {
            let s = seen.lock().unwrap();
            assert_eq!((s[0].0.as_str(), s[0].1.as_deref()), ("/agent/v1/bridge/events", Some("nvc_test")));
            assert_eq!(s[0].2["events"][0]["kind"], "tab.shared");
        }
        // The Hub refuses: the events wait for the next round, at most 500.
        answer.store(500, Ordering::SeqCst);
        assert!(!pump_once(&a, &mut pending, Duration::from_millis(100)));
        assert!(!pump_once(&a, &mut pending, Duration::from_millis(100)));
        assert_eq!(pending.len(), 2);
        pending.extend(std::iter::repeat_n(json!({ "kind": "tab.closed" }), 600));
        assert!(!pump_once(&a, &mut pending, Duration::from_millis(100)));
        assert_eq!(pending.len(), MAX_EVENTS);
        answer.store(200, Ordering::SeqCst);
        assert!(pump_once(&a, &mut pending, Duration::from_millis(100)));
        assert_eq!(seen.lock().unwrap().last().unwrap().2["events"].as_array().unwrap().len(), EVENTS_PER_POST, "at most 100 a post");
        assert_eq!(pending.len(), MAX_EVENTS - EVENTS_PER_POST);
        // A post stays under the Hub's 1 MiB body limit whatever the events weigh.
        let heavy: Vec<Value> = (0..100).map(|i| json!({ "kind": "tab.shared", "tabId": i, "title": "t".repeat(15_000) })).collect();
        let n = batch_len(&heavy);
        assert!(n < 100 && serde_json::to_vec(&json!({ "events": &heavy[..n] })).unwrap().len() < 1024 * 1024, "{n}");
        // 413: halved until it fits.
        seen.lock().unwrap().clear();
        answer.store(413, Ordering::SeqCst);
        let mut big = vec![json!({ "kind": "tab.closed" }); 8];
        assert!(!pump_once(&a, &mut big, Duration::from_millis(10)));
        let sizes: Vec<usize> = seen.lock().unwrap().iter().map(|x| x.2["events"].as_array().unwrap().len()).collect();
        assert_eq!(&sizes[..4], &[9, 4, 2, 1], "halved down to one, which is then dropped");
        assert_eq!(big.len(), 8, "the one event that never fits is dropped");
        // Another 4xx drops the batch instead of retrying it forever; 429 keeps it.
        answer.store(400, Ordering::SeqCst);
        let mut bad = vec![json!({ "kind": "tab.closed" }); 3];
        assert!(!pump_once(&a, &mut bad, Duration::from_millis(10)));
        assert!(bad.is_empty(), "dropped with a log line");
        answer.store(429, Ordering::SeqCst);
        let mut later = vec![json!({ "kind": "tab.closed" }); 3];
        assert!(!pump_once(&a, &mut later, Duration::from_millis(10)));
        assert_eq!(later.len(), 4, "kept (plus the module's new one) for the next round");
        hub.stop();
        a.sup.stop_all();
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn without_the_browser_module_the_bridge_is_offline() {
        let base = tmp("bridge-none");
        let a = agent_with(&base, None);
        let mut pending = vec![];
        assert!(!pump_once(&a, &mut pending, Duration::from_millis(10)));
        let req = |path: &str, body: Value| crate::http::Request {
            method: "POST".into(),
            path: path.into(),
            query: String::new(),
            headers: vec![("authorization".into(), "Bearer nvdm_test".into())],
            body: serde_json::to_vec(&body).unwrap(),
            peer: None,
        };
        let r = a.handle(req("/agent/v1/bridge/call", json!({ "method": "tabs.list" })));
        assert_eq!(r.status, 409);
        assert_eq!(serde_json::from_slice::<Value>(&r.body).unwrap()["error"]["code"], "bridge_offline");
        let r = a.handle(req("/agent/v1/bridge/status", json!({})));
        assert_eq!(serde_json::from_slice::<Value>(&r.body).unwrap()["connected"], false);
        // The browser routes say the module is not installed; the DevTools socket needs the
        // token, and without the module there is no socket (503 module_unavailable).
        assert_eq!(a.handle(req("/agent/v1/browser/launch", json!({}))).status, 404);
        let mut get = req("/agent/v1/browser/cdp/s1", json!({}));
        get.method = "GET".into();
        get.headers.clear();
        assert_eq!(a.handle(get.clone()).status, 401);
        get.headers = vec![("authorization".into(), "Bearer nvdm_test".into()), ("upgrade".into(), "websocket".into()), ("connection".into(), "Upgrade".into()), ("sec-websocket-version".into(), "13".into()), ("sec-websocket-key".into(), "dGhlIHNhbXBsZSBub25jZQ==".into())];
        let r = a.handle(get);
        assert_eq!((r.status, serde_json::from_slice::<Value>(&r.body).unwrap()["error"]["details"]["reason"].as_str()), (503, Some("module_unavailable")));
        assert!(crate::http::claim_takeover().is_none(), "no takeover without a session");
        a.sup.stop_all();
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn the_cli_asks_novad_for_the_extension_id_over_the_socket() {
        let base = tmp("bridge-q");
        let b = bridge(&base, Some(EXT), Some(TOKEN));
        let sock = base.join("q.sock");
        let listener = std::os::unix::net::UnixListener::bind(&sock).unwrap();
        let b2 = b.clone();
        std::thread::spawn(move || {
            for c in listener.incoming().flatten() {
                b2.accept(c);
            }
        });
        assert_eq!(query_extension_id(&sock, TOKEN).unwrap(), EXT);
        assert_eq!(query_extension_id(&sock, "nvbr_wrong").unwrap_err().details.unwrap()["reason"], "token_required");
        assert_eq!(query_extension_id(&base.join("none"), TOKEN).unwrap_err().code, "node_unavailable");
        std::fs::remove_dir_all(&base).unwrap();
    }
}
