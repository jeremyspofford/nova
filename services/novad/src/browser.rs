//! The browser module (FR-209, docs/11 §4.6, docs/23 §4): a clean Chromium on this device for an
//! agent whose own browser a site blocked, after the user consented on the Hub for that site. The
//! Hub drives it over the DevTools protocol through novad's management channel.
//!
//! - `novad module browser` keeps the sessions: at most 2 at a time, each a Chromium (config
//!   `browser.executablePath`, else the usual install paths; none: 409 `capability_missing`
//!   `{reason: no_browser}`) with a fresh temporary profile that is deleted when the session
//!   closes (and, for leftovers of a crash, when the module starts), DevTools over a pipe and no
//!   port at all (`--remote-debugging-pipe`: novad writes to the browser's fd 3 and reads its fd
//!   4, NUL-terminated JSON), and every request through the session's own egress filter
//!   (src/egress.rs, `--proxy-server`), loopback included (`<-loopback>`), WebRTC kept off UDP.
//!   A session is ready once the browser answered novad's own `Browser.getVersion`.
//! - Who it runs as: a novad that is not root runs Chromium as itself. Chromium never runs as root,
//!   as `nobody` or as a user whose primary group is root: a root novad runs each session as its
//!   own dedicated unprivileged user (`nova-browser1`, `nova-browser2`, made by `novad install`
//!   and `novad enroll` as root and removed by `novad uninstall`; `browser.runAs` may name others),
//!   so no other process shares the browser's uid and its DevTools pipe. Without one free, a root
//!   novad refuses the launch (409 `{reason: no_browser_user}`). Profiles go in novad's own 0711
//!   folder `nova-browser-<data folder hash>` under `browser.profileRoot` (default `<tmp>`,
//!   private to the service under systemd's PrivateTmp); novad never changes or cleans the
//!   configured folder itself.
//! - A session with no DevTools client for 10 minutes is closed, and every session after 4 hours.
//! - The supervisor (src/agent.rs) serves `GET /agent/v1/browser/cdp/<sessionId>`: after the
//!   management token, the Origin refusal and the WebSocket headers it connects to the module's
//!   DevTools socket (`<data>/browser/cdp.sock`, 0600 in a 0700 folder of novad's user), names
//!   the session, answers the WebSocket handshake itself and relays text messages to the pipe and
//!   the browser's messages back as text frames (src/ws.rs). One connection per session: a newer
//!   one replaces the older, which is closed (1001). The module passes whole messages only, so a
//!   connection that ends mid-message never leaves half of one for the next.
//! - Chromium is spawned from one long-lived thread: the kernel's parent-death signal (set for
//!   every hardened child) follows the spawning thread, not the process.

use crate::egress;
use crate::grants::Grantee;
use crate::http::{Request, Response, Timed};
use crate::util::{OpError, OpResult, new_id, now_iso};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::fs::File;
use std::io::{self, Read, Write};
use std::net::Shutdown;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};

pub const MODULE: &str = "browser";
pub const MAX_SESSIONS: usize = 2;
pub const CDP_PREFIX: &str = "/agent/v1/browser/cdp/";
/// The id of novad's own readiness question to the browser (the Hub's client counts from 1).
const READY_ID: i64 = 2_147_483_647;
const START_TIMEOUT: Duration = Duration::from_secs(20);
const IDLE_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const MAX_LIFETIME: Duration = Duration::from_secs(4 * 3600);
const STDERR_KEEP: usize = 4096;

/// Chromium-family browsers looked for when `browser.executablePath` is not set (integration
/// targets: each speaks the DevTools protocol and takes the same switches).
const LINUX_PATHS: &[&str] = &[
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
    "/usr/lib/chromium/chromium",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/opt/google/chrome/chrome",
    "/usr/bin/microsoft-edge",
    "/usr/bin/brave-browser",
];
const MACOS_PATHS: &[&str] = &[
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
];

/// The owner's settings (`config.json` `browser`).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct BrowserConfig {
    /// The Chromium to run; None looks in the usual places.
    pub executable_path: Option<String>,
    /// The users Chromium runs as when novad runs as root, one per session (default
    /// `nova-browser1`, `nova-browser2`; never root, `nobody` or a user of group root). A name or a
    /// list.
    pub run_as: Option<RunAs>,
    /// The folder novad's own profile folder goes in (default the temporary folder).
    pub profile_root: Option<String>,
}

/// `browser.runAs`: one user or a list.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum RunAs {
    One(String),
    Many(Vec<String>),
}

/// The dedicated browser users novad makes when it is installed as root (one per session).
pub const BROWSER_USERS: [&str; MAX_SESSIONS] = ["nova-browser1", "nova-browser2"];

impl BrowserConfig {
    pub fn run_as_names(&self) -> Vec<String> {
        match &self.run_as {
            None => BROWSER_USERS.iter().map(|s| s.to_string()).collect(),
            Some(RunAs::One(n)) => vec![n.clone()],
            Some(RunAs::Many(v)) => v.clone(),
        }
    }
}

/// The owner's extension bridge setting (`config.json` `bridge`, FR-096, src/bridge.rs).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct BridgeConfig {
    /// The id of Nova's extension, the only one the host manifest allows; no id, no bridge.
    pub extension_id: Option<String>,
}

fn no_browser(why: impl Into<String>) -> OpError {
    OpError::new(409, "capability_missing", why).with(json!({ "reason": "no_browser" }))
}

/// The browser to run: the configured one (an absolute path to an executable file), else the
/// first of `candidates` that exists.
pub fn find_browser(cfg: &BrowserConfig, candidates: &[&str]) -> OpResult<PathBuf> {
    let executable = |p: &Path| {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::metadata(p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        }
        #[cfg(not(unix))]
        {
            p.is_file()
        }
    };
    if let Some(p) = &cfg.executable_path {
        let p = PathBuf::from(p);
        if !p.is_absolute() || !executable(&p) {
            return Err(no_browser(format!("browser.executablePath {} is not an executable file", p.display())));
        }
        return Ok(p);
    }
    candidates
        .iter()
        .map(PathBuf::from)
        .find(|p| executable(p))
        .ok_or_else(|| no_browser("no Chromium-family browser is installed on this device; install Chromium or set browser.executablePath"))
}

pub fn default_candidates() -> &'static [&'static str] {
    if cfg!(target_os = "macos") { MACOS_PATHS } else { LINUX_PATHS }
}

/// A session id the Hub chose: 1 to 64 letters, digits, `-` and `_`.
pub fn valid_session_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Whether an account may run the browser: a dedicated user, not root, not `nobody` (shared by
/// other daemons), not of group root.
#[cfg(unix)]
pub fn safe_browser_user(name: &str, a: &crate::user_socket::Account) -> bool {
    a.uid != 0 && a.gid != 0 && name != "nobody" && a.uid != 65534 && a.gid != 65534
}

/// The accounts Chromium may run as: None (novad's own user) unless novad is root; then the
/// dedicated users that exist (one per session). An unsafe user named in the config is refused
/// (403 `unsafe_browser_user`); none at all fails closed (409 `no_browser_user`).
#[cfg(unix)]
pub fn run_as_for(cfg: &BrowserConfig, root: bool, users: &dyn crate::user_socket::Users) -> OpResult<Option<Vec<crate::user_socket::Account>>> {
    if !root {
        return Ok(None);
    }
    let names = cfg.run_as_names();
    let mut out = vec![];
    for name in &names {
        if name == "nobody" {
            return Err(OpError::denied("unsafe_browser_user", "browser.runAs must not be nobody: other daemons share that user"));
        }
        let Some(a) = users.lookup(name) else { continue };
        if !safe_browser_user(name, &a) {
            return Err(OpError::denied("unsafe_browser_user", format!("browser.runAs {name} is root, nobody or of group root; the browser runs only as a dedicated user")));
        }
        out.push(a);
    }
    if out.is_empty() {
        return Err(OpError::new(409, "capability_missing", format!("no dedicated browser user exists ({}); run `sudo novad install`, or create them and set browser.runAs", names.join(", "))).with(json!({ "reason": "no_browser_user" })));
    }
    Ok(Some(out))
}

/// Make the dedicated browser users that do not exist yet (Linux, as root: `useradd --system`,
/// each with its own group, no home, no login). Returns the users it made.
pub fn ensure_users(runner: &dyn crate::power::Runner, users: &dyn crate::user_socket::Users) -> Result<Vec<String>, String> {
    if !cfg!(target_os = "linux") {
        return Err("making the browser users is built for Linux only; create two unprivileged users and set browser.runAs".into());
    }
    let shell = ["/usr/sbin/nologin", "/sbin/nologin"].into_iter().find(|p| Path::new(p).exists()).unwrap_or("/bin/false");
    let mut made = vec![];
    for name in BROWSER_USERS {
        if let Some(a) = users.lookup(name) {
            if !safe_browser_user(name, &a) {
                return Err(format!("the user {name} exists but is not a dedicated unprivileged user"));
            }
            continue;
        }
        let argv: Vec<String> = ["useradd", "--system", "--user-group", "--no-create-home", "--home-dir", "/nonexistent", "--shell", shell, "--comment", "Nova browser sessions", name].iter().map(|s| s.to_string()).collect();
        let (code, _, err) = runner.run(&argv).map_err(|e| format!("useradd: {e}"))?;
        if code != 0 {
            return Err(format!("useradd {name} failed: {}", err.trim()));
        }
        made.push(name.to_string());
    }
    Ok(made)
}

/// Remove the dedicated browser users (uninstall); the users removed.
pub fn remove_users(runner: &dyn crate::power::Runner, users: &dyn crate::user_socket::Users) -> Vec<String> {
    BROWSER_USERS
        .iter()
        .filter(|n| users.lookup(n).is_some())
        .filter(|n| runner.run(&["userdel".to_string(), n.to_string()]).is_ok_and(|(code, _, _)| code == 0))
        .map(|n| n.to_string())
        .collect()
}

/// novad's own profile folder (inside the configured or temporary folder, which it never
/// changes): a real folder of novad's user (made 0711 when missing), not writable by others, so
/// another user cannot plant anything where profiles go.
#[cfg(unix)]
pub fn prepare_root(root: &Path) -> OpResult<()> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
    match std::fs::symlink_metadata(root) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            // Only the last folder: the folder it goes in must already be there.
            std::fs::DirBuilder::new().mode(0o711).create(root).map_err(|e| OpError::validation(format!("cannot make {} ({e}); check browser.profileRoot", root.display())))?;
        }
        Err(e) => return Err(e.into()),
        Ok(_) => {}
    }
    let m = std::fs::symlink_metadata(root)?;
    let me = unsafe { libc::geteuid() };
    if !m.file_type().is_dir() || m.uid() != me || m.mode() & 0o022 != 0 {
        return Err(OpError::denied("unsafe_path", format!("{} is not a private folder of novad's user; no profile was made there", root.display())));
    }
    std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o711))?;
    Ok(())
}

/// Remove what an earlier run left in the profile root (a crash, a killed module): the session
/// profiles (`s-…`). Links are removed, never followed.
pub fn clean_root(root: &Path) -> usize {
    let Ok(entries) = std::fs::read_dir(root) else { return 0 };
    let mut n = 0;
    for e in entries.flatten() {
        if !e.file_name().to_string_lossy().starts_with("s-") {
            continue;
        }
        let p = e.path();
        let gone = match std::fs::symlink_metadata(&p) {
            Ok(m) if m.file_type().is_dir() => std::fs::remove_dir_all(&p).is_ok(),
            Ok(_) => std::fs::remove_file(&p).is_ok(),
            Err(_) => false,
        };
        n += gone as usize;
    }
    n
}

/// The switches every session gets.
pub fn chromium_args(profile: &Path, proxy_port: u16, headless: bool) -> Vec<String> {
    let mut a = vec![
        format!("--user-data-dir={}", profile.display()),
        // DevTools over fds 3 and 4: no port another local user could attach to.
        "--remote-debugging-pipe".into(),
        format!("--proxy-server=http://127.0.0.1:{proxy_port}"),
        // Loopback goes through the filter too (it refuses it): Chromium bypasses it by default.
        "--proxy-bypass-list=<-loopback>".into(),
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp".into(),
        "--webrtc-ip-handling-policy=disable_non_proxied_udp".into(),
        "--no-first-run".into(),
        "--no-default-browser-check".into(),
        "--disable-sync".into(),
        "--disable-background-networking".into(),
        "--disable-component-update".into(),
        "--disable-default-apps".into(),
        "--disable-domain-reliability".into(),
        "--disable-breakpad".into(),
        "--no-pings".into(),
        "--password-store=basic".into(),
        "--use-mock-keychain".into(),
    ];
    if headless {
        a.push("--headless=new".into());
    }
    a.push("about:blank".into());
    a
}

/// A pipe whose two ends close on exec: (read end, write end).
fn cloexec_pipe() -> io::Result<(File, File)> {
    use std::os::fd::FromRawFd;
    let mut fds = [0 as libc::c_int; 2];
    #[cfg(target_os = "linux")]
    let r = unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) };
    #[cfg(not(target_os = "linux"))]
    let r = unsafe {
        let r = libc::pipe(fds.as_mut_ptr());
        if r == 0 {
            libc::fcntl(fds[0], libc::F_SETFD, libc::FD_CLOEXEC);
            libc::fcntl(fds[1], libc::F_SETFD, libc::FD_CLOEXEC);
        }
        r
    };
    if r != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { (File::from_raw_fd(fds[0]), File::from_raw_fd(fds[1])) })
}

/// One session's DevTools channel in the module: the pipe into the browser, and the supervisor's
/// current connection (one at a time) that the browser's messages go to.
struct Link {
    to_browser: Mutex<File>,
    client: Mutex<Option<(u64, UnixStream)>>,
    next: AtomicU64,
    /// Since when no DevTools client is connected (None while one is).
    idle_since: Mutex<Option<Instant>>,
}

impl Link {
    /// One message (without its NUL) to the browser, whole.
    fn send(&self, msg: &[u8]) -> io::Result<()> {
        let mut w = self.to_browser.lock().unwrap_or_else(|p| p.into_inner());
        w.write_all(msg)?;
        w.write_all(&[0])
    }

    /// A new connection replaces the current one, which is closed.
    fn attach(&self, s: UnixStream) -> u64 {
        let id = self.next.fetch_add(1, Ordering::SeqCst) + 1;
        let mut c = self.client.lock().unwrap_or_else(|p| p.into_inner());
        if let Some((_, old)) = c.replace((id, s)) {
            let _ = old.shutdown(Shutdown::Both);
        }
        *self.idle_since.lock().unwrap_or_else(|p| p.into_inner()) = None;
        id
    }

    fn detach(&self, id: u64) {
        let mut c = self.client.lock().unwrap_or_else(|p| p.into_inner());
        if c.as_ref().is_some_and(|(i, _)| *i == id) {
            if let Some((_, s)) = c.take() {
                let _ = s.shutdown(Shutdown::Both);
            }
            *self.idle_since.lock().unwrap_or_else(|p| p.into_inner()) = Some(Instant::now());
        }
    }

    fn close_client(&self) {
        if let Some((_, s)) = self.client.lock().unwrap_or_else(|p| p.into_inner()).take() {
            let _ = s.shutdown(Shutdown::Both);
            *self.idle_since.lock().unwrap_or_else(|p| p.into_inner()) = Some(Instant::now());
        }
    }

    fn idle_for(&self) -> Option<Duration> {
        self.idle_since.lock().unwrap_or_else(|p| p.into_inner()).map(|t| t.elapsed())
    }

    /// One of the browser's messages (without its NUL) to the connection, if there is one.
    fn forward(&self, msg: &[u8]) {
        let mut c = self.client.lock().unwrap_or_else(|p| p.into_inner());
        if let Some((_, s)) = c.as_mut()
            && s.write_all(msg).and_then(|_| s.write_all(&[0])).is_err()
        {
            if let Some((_, s)) = c.take() {
                let _ = s.shutdown(Shutdown::Both);
            }
            *self.idle_since.lock().unwrap_or_else(|p| p.into_inner()) = Some(Instant::now());
        }
    }
}

/// Split NUL-terminated messages out of a byte stream, whole messages only: a message over
/// `max` is dropped up to its NUL (and `over` is told).
struct Splitter {
    acc: Vec<u8>,
    skipping: bool,
    max: usize,
}

impl Splitter {
    fn new(max: usize) -> Splitter {
        Splitter { acc: Vec::new(), skipping: false, max }
    }

    fn push(&mut self, mut data: &[u8], mut each: impl FnMut(&[u8]), mut over: impl FnMut()) {
        while !data.is_empty() {
            match data.iter().position(|&b| b == 0) {
                Some(i) => {
                    if self.skipping {
                        self.skipping = false;
                    } else {
                        self.acc.extend_from_slice(&data[..i]);
                        each(&self.acc);
                    }
                    self.acc.clear();
                    data = &data[i + 1..];
                }
                None => {
                    if !self.skipping {
                        self.acc.extend_from_slice(data);
                        if self.acc.len() > self.max {
                            self.acc.clear();
                            self.skipping = true;
                            over();
                        }
                    }
                    data = &[];
                }
            }
        }
    }
}

/// The browser's side of the pipe: its answer to novad's readiness question goes to `ready`,
/// everything else to the current connection. When the browser ends, so does the connection.
fn read_browser(mut from: File, link: Arc<Link>, ready: mpsc::Sender<String>) {
    let mut buf = vec![0u8; 64 * 1024];
    let mut split = Splitter::new(crate::ws::MAX_MESSAGE);
    let mut waiting = true;
    loop {
        let n = match from.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        split.push(
            &buf[..n],
            |msg| {
                if waiting && msg.len() < 4096 {
                    let v: Value = serde_json::from_slice(msg).unwrap_or(Value::Null);
                    if v["id"].as_i64() == Some(READY_ID) {
                        waiting = false;
                        let _ = ready.send(v["result"]["product"].as_str().unwrap_or("unknown").chars().take(100).collect());
                        return;
                    }
                }
                link.forward(msg);
            },
            // Too big to pass on: the connection waiting for it is closed rather than left hanging.
            || link.close_client(),
        );
    }
    link.close_client();
}

/// The tail of what the browser wrote to stderr, as one printable line.
fn tail(buf: &Mutex<Vec<u8>>) -> String {
    let b = buf.lock().unwrap_or_else(|p| p.into_inner());
    let s: String = String::from_utf8_lossy(&b).chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    let s = s.trim();
    let start = s.char_indices().rev().nth(499).map(|(i, _)| i).unwrap_or(0);
    s[start..].to_string()
}

/// Whether the browser's main process has exited, without reaping it: while it is a zombie its
/// pid, which is also its process group's id, cannot be given to another process.
fn has_exited(child: &Child) -> bool {
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    let r = unsafe { libc::waitid(libc::P_PID, child.id() as libc::id_t, &mut info, libc::WEXITED | libc::WNOWAIT | libc::WNOHANG) };
    #[cfg(target_os = "linux")]
    let pid = unsafe { info.si_pid() };
    #[cfg(not(target_os = "linux"))]
    let pid = info.si_pid;
    r == 0 && pid != 0
}

/// Stop the browser and every helper in its process group, then reap it. The group gets SIGKILL
/// before the leader is reaped, so the group id cannot belong to someone else by then.
fn kill_group(child: &mut Child) -> String {
    let pid = child.id() as libc::pid_t;
    unsafe { libc::kill(-pid, libc::SIGTERM) };
    let deadline = Instant::now() + Duration::from_secs(3);
    while !has_exited(child) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    unsafe { libc::kill(-pid, libc::SIGKILL) };
    match child.wait() {
        Ok(status) => status.to_string(),
        Err(e) => e.to_string(),
    }
}

struct Session {
    grantee: Grantee,
    headless: bool,
    allow: Vec<String>,
    child: Child,
    profile: PathBuf,
    link: Arc<Link>,
    product: String,
    filter: egress::Filter,
    started_at: String,
    started: Instant,
    /// The uid it runs as (a root novad: one dedicated user per session).
    uid: Option<u32>,
}

/// The sessions of one browser module.
pub struct Browsers {
    pub cfg: BrowserConfig,
    pub candidates: Vec<String>,
    pub root: PathBuf,
    /// novad's data folder: the module's DevTools socket is `<data>/browser/cdp.sock`.
    pub data_dir: PathBuf,
    pub egress: egress::Options,
    pub start_timeout: Duration,
    /// Who Chromium runs as (decided per launch; tests set it).
    #[cfg(unix)]
    pub run_as: Box<dyn Fn(&BrowserConfig) -> OpResult<Option<Vec<crate::user_socket::Account>>> + Send + Sync>,
    /// A session with no DevTools client this long is closed (10 minutes).
    pub idle_timeout: Duration,
    /// Every session is closed after this long (4 hours).
    pub max_lifetime: Duration,
    sessions: Mutex<HashMap<String, Session>>,
    launching: Mutex<()>,
}

impl Browsers {
    /// The profile root defaults to `<tmp>/nova-browser-<12 hex of the data folder's SHA-256>`, so
    /// two novads on one machine (tests, a user's own) never clean each other's profiles.
    pub fn new(cfg: BrowserConfig, data_dir: &Path) -> Browsers {
        let tag = crate::crypto::hex(&crate::crypto::sha256(data_dir.to_string_lossy().as_bytes()));
        let parent = cfg.profile_root.clone().map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
        let root = parent.join(format!("nova-browser-{}", &tag[..12]));
        Browsers {
            cfg,
            candidates: default_candidates().iter().map(|s| s.to_string()).collect(),
            root,
            data_dir: data_dir.to_path_buf(),
            egress: egress::Options::default(),
            start_timeout: START_TIMEOUT,
            #[cfg(unix)]
            run_as: Box::new(|cfg: &BrowserConfig| run_as_for(cfg, crate::hardening::is_root(), &crate::user_socket::SystemUsers)),
            idle_timeout: IDLE_TIMEOUT,
            max_lifetime: MAX_LIFETIME,
            sessions: Mutex::new(HashMap::new()),
            launching: Mutex::new(()),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Session>> {
        self.sessions.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// `browser.launch {sessionId, grantee, allowHosts, headless?}` -> `{sessionId, cdpPath}`.
    pub fn launch(&self, args: &Value) -> OpResult<Value> {
        let id = args["sessionId"].as_str().filter(|s| valid_session_id(s)).ok_or_else(|| OpError::validation("sessionId must be 1-64 letters, digits, - or _"))?.to_string();
        let grantee = Grantee::parse(&args["grantee"])?;
        let headless = match &args["headless"] {
            Value::Null => true,
            Value::Bool(b) => *b,
            _ => return Err(OpError::validation("headless must be true or false")),
        };
        let hosts = args["allowHosts"].as_array().ok_or_else(|| OpError::validation("allowHosts must list the hosts the session may reach"))?;
        if hosts.is_empty() || hosts.len() > egress::MAX_HOSTS {
            return Err(OpError::validation(format!("allowHosts must list 1 to {} hosts", egress::MAX_HOSTS)));
        }
        // An entry novad cannot use is skipped and reported; the launch fails only with none left.
        let mut allow: Vec<String> = Vec::new();
        let mut skipped = Vec::new();
        for h in hosts {
            match h.as_str().map(egress::check_pattern) {
                Some(Ok(p)) if !allow.contains(&p) => allow.push(p),
                Some(Ok(_)) => {}
                Some(Err(why)) => skipped.push(json!({ "host": h, "reason": why })),
                None => skipped.push(json!({ "host": h, "reason": "not a string" })),
            }
        }
        if allow.is_empty() {
            return Err(OpError::validation("allowHosts has no host novad can use").with(json!({ "skippedHosts": skipped })));
        }
        #[cfg(target_os = "linux")]
        if !headless && std::env::var_os("DISPLAY").is_none() && std::env::var_os("WAYLAND_DISPLAY").is_none() {
            return Err(OpError::new(409, "capability_missing", "a visible browser needs a display, and novad has none").with(json!({ "reason": "no_display" })));
        }
        let _one_at_a_time = self.launching.lock().unwrap_or_else(|p| p.into_inner());
        {
            let s = self.lock();
            if s.contains_key(&id) {
                return Err(OpError::conflict(format!("a browser session {id} is already open")).with(json!({ "reason": "session_exists" })));
            }
            if s.len() >= MAX_SESSIONS {
                return Err(OpError::conflict(format!("at most {MAX_SESSIONS} browser sessions run at a time on a device")).with(json!({ "reason": "session_limit", "max": MAX_SESSIONS })));
            }
        }
        let candidates: Vec<&str> = self.candidates.iter().map(String::as_str).collect();
        let exe = find_browser(&self.cfg, &candidates)?;
        // A root novad: a dedicated user no live session runs as.
        let run_as = match (self.run_as)(&self.cfg)? {
            None => None,
            Some(pool) => {
                let busy: Vec<u32> = self.lock().values().filter_map(|x| x.uid).collect();
                let free = pool.into_iter().find(|a| !busy.contains(&a.uid));
                Some(free.ok_or_else(|| OpError::conflict("every dedicated browser user runs a session").with(json!({ "reason": "no_free_browser_user" })))?)
            }
        };
        prepare_root(&self.root)?;
        if run_as.is_some() {
            use std::os::unix::fs::PermissionsExt;
            // The browser's user must be able to pass through the folder novad's folder is in.
            let parent = self.root.parent().unwrap_or(Path::new("/"));
            if std::fs::metadata(parent).map(|m| m.permissions().mode() & 0o001 == 0).unwrap_or(true) {
                return Err(OpError::validation(format!("{} must be passable by the browser's user (mode o+x); check browser.profileRoot", parent.display())));
            }
        }
        let profile = self.root.join(format!("s-{}", new_id()));
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            std::fs::DirBuilder::new().mode(0o700).create(&profile)?;
            if let Some(a) = &run_as {
                std::os::unix::fs::chown(&profile, Some(a.uid), Some(a.gid))?;
            }
        }
        #[cfg(not(unix))]
        std::fs::create_dir(&profile)?;
        let cleanup = |filter: Option<&egress::Filter>| {
            if let Some(f) = filter {
                f.stop();
            }
            let _ = std::fs::remove_dir_all(&profile);
        };
        let filter = match egress::Filter::start(allow.clone(), &id, self.egress.clone()) {
            Ok(f) => f,
            Err(e) => {
                cleanup(None);
                return Err(e);
            }
        };
        // The DevTools pipe: the browser reads fd 3 and writes fd 4.
        let pipes = cloexec_pipe().and_then(|a| cloexec_pipe().map(|b| (a, b)));
        let ((browser_in, to_browser), (from_browser, browser_out)) = match pipes {
            Ok(p) => p,
            Err(e) => {
                cleanup(Some(&filter));
                return Err(e.into());
            }
        };
        let mut cmd = Command::new(&exe);
        cmd.args(chromium_args(&profile, filter.port(), headless));
        let home = profile.to_string_lossy().to_string();
        let mut env = vec![("HOME".to_string(), home.clone()), ("XDG_CONFIG_HOME".to_string(), format!("{home}/.config")), ("XDG_CACHE_HOME".to_string(), format!("{home}/.cache"))];
        if !headless {
            for k in ["DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR"] {
                if let Ok(v) = std::env::var(k) {
                    env.push((k.to_string(), v));
                }
            }
        }
        crate::hardening::harden_command(&mut cmd, &env, crate::hardening::Limits::default());
        cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
        {
            use std::os::fd::AsRawFd;
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
            if let Some(a) = &run_as {
                cmd.uid(a.uid).gid(a.gid);
            }
            let (r, w) = (browser_in.as_raw_fd(), browser_out.as_raw_fd());
            // SAFETY: only fcntl and dup2 run between fork and exec. The ends are first copied
            // above 10 so that placing them on 3 and 4 cannot overwrite each other; dup2 leaves 3
            // and 4 open across exec, every other descriptor of ours closes.
            unsafe {
                cmd.pre_exec(move || {
                    let a = libc::fcntl(r, libc::F_DUPFD_CLOEXEC, 10);
                    let b = libc::fcntl(w, libc::F_DUPFD_CLOEXEC, 10);
                    if a < 0 || b < 0 || libc::dup2(a, 3) < 0 || libc::dup2(b, 4) < 0 {
                        return Err(io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
        }
        let spawned = crate::hardening::spawn_kept(cmd);
        // The browser's ends belong to it now.
        drop((browser_in, browser_out));
        let mut child = match spawned {
            Ok(c) => c,
            Err(e) => {
                cleanup(Some(&filter));
                return Err(OpError::unavailable(format!("the browser did not start: {e}")).with(json!({ "reason": "browser_start_failed" })));
            }
        };
        let stderr = Arc::new(Mutex::new(Vec::new()));
        if let Some(mut err) = child.stderr.take() {
            let keep = stderr.clone();
            std::thread::spawn(move || {
                let mut buf = [0u8; 4096];
                while let Ok(n) = err.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                    let mut k = keep.lock().unwrap_or_else(|p| p.into_inner());
                    k.extend_from_slice(&buf[..n]);
                    let over = k.len().saturating_sub(STDERR_KEEP);
                    k.drain(..over);
                }
            });
        }
        let link = Arc::new(Link { to_browser: Mutex::new(to_browser), client: Mutex::new(None), next: AtomicU64::new(0), idle_since: Mutex::new(Some(Instant::now())) });
        let (ready_tx, ready) = mpsc::channel();
        let reader = link.clone();
        std::thread::spawn(move || read_browser(from_browser, reader, ready_tx));
        // Ready once it answers; a browser that died first makes this write fail, which the wait
        // below reports.
        let _ = link.send(format!("{{\"id\":{READY_ID},\"method\":\"Browser.getVersion\"}}").as_bytes());
        let deadline = Instant::now() + self.start_timeout;
        let product = loop {
            if let Ok(p) = ready.recv_timeout(Duration::from_millis(50)) {
                break p;
            }
            let failed = if has_exited(&child) {
                Some(format!("the browser exited at start ({})", kill_group(&mut child)))
            } else if Instant::now() >= deadline {
                kill_group(&mut child);
                Some(format!("the browser did not answer on its DevTools pipe within {} s", self.start_timeout.as_secs()))
            } else {
                None
            };
            if let Some(why) = failed {
                cleanup(Some(&filter));
                let t = tail(&stderr);
                let msg = if t.is_empty() { why } else { format!("{why}: {t}") };
                return Err(OpError::unavailable(msg).with(json!({ "reason": "browser_start_failed" })));
            }
        };
        eprintln!("novad browser {id}: started {product} ({}, {} allowed hosts)", if headless { "headless" } else { "visible" }, allow.len());
        let uid = run_as.as_ref().map(|a| a.uid);
        self.lock().insert(id.clone(), Session { grantee, headless, allow, child, profile, link, product, filter, started_at: now_iso(), started: Instant::now(), uid });
        let mut out = json!({ "sessionId": id, "cdpPath": format!("{CDP_PREFIX}{id}") });
        if !skipped.is_empty() {
            out["skippedHosts"] = json!(skipped);
        }
        Ok(out)
    }

    /// `browser.close {sessionId}` -> `{closed: true, egress: {allowed, refused}}`: the browser and
    /// its helpers are stopped, the filter's connections closed and the profile deleted.
    pub fn close(&self, args: &Value) -> OpResult<Value> {
        let id = args["sessionId"].as_str().filter(|s| valid_session_id(s)).ok_or_else(|| OpError::validation("sessionId is required"))?;
        let mut s = self.lock().remove(id).ok_or_else(|| OpError::not_found(format!("no browser session {id}")))?;
        kill_group(&mut s.child);
        s.link.close_client();
        let (allowed, refused) = s.filter.stop();
        let _ = std::fs::remove_dir_all(&s.profile);
        eprintln!("novad browser {id}: closed (egress allowed {allowed}, refused {refused})");
        Ok(json!({ "closed": true, "egress": { "allowed": allowed, "refused": refused } }))
    }

    /// Close every session (the module stops, the device is decommissioned).
    pub fn close_all(&self) -> usize {
        let ids: Vec<String> = self.lock().keys().cloned().collect();
        ids.iter().filter(|id| self.close(&json!({ "sessionId": id })).is_ok()).count()
    }

    /// `browser.list {}` -> `{sessions: [...]}`, a session that died on its own is closed first.
    pub fn list(&self) -> Value {
        let dead: Vec<String> = self.lock().iter().filter_map(|(id, s)| has_exited(&s.child).then(|| id.clone())).collect();
        for id in dead {
            let _ = self.close(&json!({ "sessionId": id }));
        }
        let s = self.lock();
        let mut out: Vec<Value> = s
            .iter()
            .map(|(id, x)| {
                let (allowed, refused) = x.filter.counts();
                json!({
                    "sessionId": id,
                    "grantee": x.grantee,
                    "headless": x.headless,
                    "browser": x.product,
                    "allowHosts": x.allow,
                    "startedAt": x.started_at,
                    "egress": { "allowed": allowed, "refused": refused },
                })
            })
            .collect();
        out.sort_by(|a, b| a["sessionId"].as_str().cmp(&b["sessionId"].as_str()));
        json!({ "sessions": out, "max": MAX_SESSIONS })
    }

    /// Close sessions nobody drives: no DevTools client for `idle_timeout`, or older than
    /// `max_lifetime` (a Hub that crashed, or a close that never reached the device, would
    /// otherwise leave the browser and its filter running and the session slots taken).
    pub fn reap(&self) -> Vec<String> {
        let due: Vec<(String, &'static str)> = self
            .lock()
            .iter()
            .filter_map(|(id, x)| {
                if x.started.elapsed() >= self.max_lifetime {
                    Some((id.clone(), "lifetime"))
                } else if x.link.idle_for().is_some_and(|d| d >= self.idle_timeout) {
                    Some((id.clone(), "idle"))
                } else {
                    None
                }
            })
            .collect();
        due.into_iter()
            .filter(|(id, why)| {
                eprintln!("novad browser {id}: closing ({})", if *why == "idle" { "no DevTools client for a while" } else { "the session reached its lifetime" });
                self.close(&json!({ "sessionId": id })).is_ok()
            })
            .map(|(id, _)| id)
            .collect()
    }

    /// Reap every 30 s (or more often for short limits).
    pub fn start_reaper(self: &Arc<Self>) {
        let every = (self.idle_timeout.min(self.max_lifetime) / 4).clamp(Duration::from_millis(20), Duration::from_secs(30));
        let me = Arc::downgrade(self);
        std::thread::spawn(move || {
            while let Some(b) = me.upgrade() {
                b.reap();
                drop(b);
                std::thread::sleep(every);
            }
        });
    }

    /// Listen on `<data>/browser/cdp.sock` (0600 in a 0700 folder) for the supervisor's DevTools
    /// connections: the first line names the session (`ok` or `error not_found` back), then
    /// NUL-terminated messages both ways.
    pub fn serve_cdp(self: &Arc<Self>) -> OpResult<PathBuf> {
        use std::os::unix::fs::PermissionsExt;
        let path = cdp_socket(&self.data_dir);
        let dir = path.parent().unwrap_or(&self.data_dir);
        std::fs::create_dir_all(dir)?;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
        // A socket left by an earlier run; a live one would still be bound by its process.
        let _ = std::fs::remove_file(&path);
        let listener = UnixListener::bind(&path).map_err(|e| OpError::internal(format!("cannot listen on {}: {e}", path.display())))?;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
        let me = self.clone();
        std::thread::spawn(move || {
            for conn in listener.incoming().flatten() {
                let me = me.clone();
                std::thread::spawn(move || me.cdp_conn(conn));
            }
        });
        Ok(path)
    }

    fn cdp_conn(&self, mut conn: UnixStream) {
        let _ = conn.set_read_timeout(Some(Duration::from_secs(5)));
        let _ = conn.set_write_timeout(Some(Duration::from_secs(30)));
        let Some(id) = read_line(&mut conn) else { return };
        let Some(link) = self.lock().get(&id).map(|s| s.link.clone()) else {
            let _ = conn.write_all(b"error not_found\n");
            return;
        };
        let Ok(out) = conn.try_clone() else { return };
        if conn.write_all(b"ok\n").is_err() {
            return;
        }
        let me = link.attach(out);
        let _ = conn.set_read_timeout(None);
        let mut split = Splitter::new(crate::ws::MAX_MESSAGE);
        let mut buf = vec![0u8; 64 * 1024];
        let open = std::cell::Cell::new(true);
        while open.get() {
            let n = match conn.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            // A message over the cap ends the connection (the client gets nothing half-sent).
            split.push(&buf[..n], |msg| open.set(open.get() && link.send(msg).is_ok()), || open.set(false));
        }
        link.detach(me);
    }
}

/// The module's DevTools socket in novad's data folder.
pub fn cdp_socket(data_dir: &Path) -> PathBuf {
    data_dir.join("browser").join("cdp.sock")
}

/// A short line ending in `\n` (at most 100 bytes), read a byte at a time so nothing after it is
/// taken.
fn read_line(s: &mut UnixStream) -> Option<String> {
    let mut line = Vec::new();
    let mut b = [0u8; 1];
    while line.len() <= 100 {
        match s.read(&mut b) {
            Ok(1) if b[0] == b'\n' => return String::from_utf8(line).ok(),
            Ok(1) => line.push(b[0]),
            _ => return None,
        }
    }
    None
}

/// What the browser module process holds: the sessions and the extension bridge.
pub struct Module {
    pub sessions: Arc<Browsers>,
    #[cfg(unix)]
    pub bridge: Arc<crate::bridge::Bridge>,
}

impl Module {
    pub fn new(cfg: &crate::state::Config, data_dir: &Path) -> Module {
        Module {
            sessions: Arc::new(Browsers::new(cfg.browser.clone(), data_dir)),
            #[cfg(unix)]
            bridge: Arc::new(crate::bridge::Bridge::from_config(cfg)),
        }
    }

    /// At module start: profiles a crash left behind go, the DevTools socket and the bridge
    /// sockets are bound.
    pub fn start(&self) {
        let n = clean_root(&self.sessions.root);
        if n > 0 {
            eprintln!("novad browser: removed {n} profile(s) left from an earlier run");
        }
        if let Err(e) = self.sessions.serve_cdp() {
            eprintln!("novad browser: {e}");
        }
        self.sessions.start_reaper();
        #[cfg(unix)]
        self.bridge.start();
    }
}

/// The module's operations.
pub fn op(m: &Module, op: &str, args: &Value) -> OpResult<Value> {
    #[cfg(unix)]
    if op.starts_with("bridge.") {
        return m.bridge.op(op, args);
    }
    let b = &m.sessions;
    match op {
        "status" => {
            #[cfg(unix)]
            let bridge = m.bridge.status();
            #[cfg(not(unix))]
            let bridge = Value::Null;
            Ok(json!({ "module": MODULE, "ready": true, "sessions": b.lock().len(), "max": MAX_SESSIONS, "bridge": bridge }))
        }
        "browser.launch" => b.launch(args),
        "browser.close" => b.close(args),
        "browser.list" => Ok(b.list()),
        "browser.closeAll" => Ok(json!({ "closed": b.close_all() })),
        _ => Err(OpError::not_found(format!("the {MODULE} module has no operation {op}"))),
    }
}

// ---- The supervisor's side: routes and the DevTools pipe ------------------------------------------

const LAUNCH_TIMEOUT: Duration = Duration::from_secs(45);
const CALL_TIMEOUT: Duration = Duration::from_secs(30);

/// `/agent/v1/browser/{launch,close,list}` through the browser module; closing also ends the
/// session's DevTools pipes.
pub fn route(sup: &crate::supervisor::Supervisor, pipes: &CdpPipes, action: &str, body: &Value) -> OpResult<Value> {
    match action {
        "launch" => sup.call(MODULE, "browser.launch", body.clone(), LAUNCH_TIMEOUT),
        "close" => {
            let r = sup.call(MODULE, "browser.close", body.clone(), CALL_TIMEOUT)?;
            pipes.close_session(body["sessionId"].as_str().unwrap_or_default());
            Ok(r)
        }
        "list" => sup.call(MODULE, "browser.list", json!({}), CALL_TIMEOUT),
        _ => Err(OpError::not_found("unknown browser route")),
    }
}

/// The supervisor's connection to a session's browser: the module's DevTools socket, which
/// answers `ok` for a session it has (404 otherwise; 503 when the module is not running).
pub fn connect_cdp(data_dir: &Path, id: &str) -> OpResult<UnixStream> {
    let mut s = UnixStream::connect(cdp_socket(data_dir)).map_err(|e| OpError::unavailable(format!("the browser module is not running ({e})")).with(json!({ "reason": "module_unavailable", "module": MODULE })))?;
    s.set_read_timeout(Some(Duration::from_secs(5)))?;
    s.set_write_timeout(Some(Duration::from_secs(5)))?;
    s.write_all(format!("{id}\n").as_bytes())?;
    match read_line(&mut s).as_deref() {
        Some("ok") => Ok(s),
        Some("error not_found") => Err(OpError::not_found(format!("no browser session {id}"))),
        _ => Err(OpError::unavailable("the browser module did not answer").with(json!({ "reason": "module_unavailable", "module": MODULE }))),
    }
}

/// The DevTools connection of each session (one at a time), so closing a session ends it.
#[derive(Default)]
pub struct CdpPipes {
    open: Mutex<HashMap<String, (u64, Arc<AtomicBool>, UnixStream)>>,
    next: AtomicU64,
}

impl CdpPipes {
    /// A new connection for `session`; one that was open is ended first.
    fn add(&self, session: &str, stop: Arc<AtomicBool>, browser: &UnixStream) -> io::Result<u64> {
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        let old = self.open.lock().unwrap_or_else(|p| p.into_inner()).insert(session.to_string(), (id, stop, browser.try_clone()?));
        if let Some((_, stop, s)) = old {
            stop.store(true, Ordering::SeqCst);
            let _ = s.shutdown(Shutdown::Both);
        }
        Ok(id)
    }

    fn remove(&self, session: &str, id: u64) {
        let mut o = self.open.lock().unwrap_or_else(|p| p.into_inner());
        if o.get(session).is_some_and(|(i, _, _)| *i == id) {
            o.remove(session);
        }
    }

    /// End the session's connection (it closed).
    pub fn close_session(&self, session: &str) -> usize {
        let gone = self.open.lock().unwrap_or_else(|p| p.into_inner()).remove(session);
        let n = gone.is_some() as usize;
        if let Some((_, stop, s)) = gone {
            stop.store(true, Ordering::SeqCst);
            let _ = s.shutdown(Shutdown::Both);
        }
        n
    }

    #[cfg(test)]
    pub fn count(&self, session: &str) -> usize {
        self.open.lock().unwrap_or_else(|p| p.into_inner()).contains_key(session) as usize
    }
}

/// `GET /agent/v1/browser/cdp/<sessionId>` (the management token was checked): a WebSocket that
/// novad answers itself and relays to the session's browser. `connect` reaches the module.
pub fn cdp_upgrade(req: &Request, pipes: &Arc<CdpPipes>, connect: &dyn Fn(&str) -> OpResult<UnixStream>) -> Response {
    let err = |e: OpError| Response::error(e.status, &e.code, &e.message, e.details);
    let id = req.path.strip_prefix(CDP_PREFIX).unwrap_or_default();
    if !valid_session_id(id) {
        return err(OpError::not_found("no such browser session"));
    }
    // A page in a browser sends an Origin; the Hub's client does not (FR-192).
    if req.header("origin").is_some() {
        return Response::error(403, "origin_rejected", "this endpoint takes no browser Origin", None);
    }
    let has = |name: &str, token: &str| req.header(name).is_some_and(|v| v.split(',').any(|p| p.trim().eq_ignore_ascii_case(token)));
    if !has("upgrade", "websocket") || !has("connection", "upgrade") || req.header("sec-websocket-version") != Some("13") {
        return err(OpError::validation("a WebSocket upgrade (version 13) is required"));
    }
    let Some(key) = req.header("sec-websocket-key").filter(|k| crate::crypto::b64_decode(k).is_some_and(|b| b.len() == 16)) else {
        return err(OpError::validation("Sec-WebSocket-Key is missing or malformed"));
    };
    let accept = crate::ws::accept_key(key);
    let browser = match connect(id) {
        Ok(s) => s,
        Err(e) => return err(e),
    };
    let stop = Arc::new(AtomicBool::new(false));
    let pipe_id = match pipes.add(id, stop.clone(), &browser) {
        Ok(i) => i,
        Err(e) => return err(e.into()),
    };
    let (pipes, session) = (pipes.clone(), id.to_string());
    crate::http::take_over(Box::new(move |mut client: Box<dyn Timed + Send>, rest: Vec<u8>| {
        let head = format!("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n");
        if client.write_all(head.as_bytes()).and_then(|_| client.flush()).is_ok() {
            crate::ws::relay(client, rest, browser, &stop);
        }
        pipes.remove(&session, pipe_id);
    }));
    Response::json(101, &json!({}))
}

#[cfg(all(test, unix))]
pub mod tests {
    use super::*;
    use crate::egress::tests::{echo_server, fake};
    use crate::grants::tests::tmp;
    use crate::user_socket::{Account, Users};
    use crate::ws::tests::{client_frame, read_frame};
    use crate::ws::{OP_CLOSE, OP_PING, OP_PONG, OP_TEXT};
    use std::net::{TcpListener, TcpStream};
    use std::os::fd::FromRawFd;
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    use std::sync::atomic::AtomicUsize;

    /// The fake Chromium: this test binary, run through a script that passes the profile folder.
    /// It speaks DevTools over fds 3 and 4 (NUL-terminated JSON) and opens no port: it answers
    /// `Browser.getVersion`, sends an event before answering `Test.event`, and echoes every other
    /// method; each method it got goes to `<profile>/methods.txt`, its arguments to `args.txt`.
    #[test]
    #[ignore = "the fake Chromium the launch tests start as a child process"]
    fn fake_chromium() {
        let Ok(dir) = std::env::var("NOVA_FAKE_CHROMIUM") else { return };
        let dir = PathBuf::from(dir);
        if std::fs::read_to_string(dir.join("args.txt")).unwrap_or_default().contains("--fail-at-start") {
            eprintln!("fake chromium: failing at start as asked");
            std::process::exit(3);
        }
        let mut input = unsafe { File::from_raw_fd(3) };
        let mut output = unsafe { File::from_raw_fd(4) };
        let mut methods = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("methods.txt")).unwrap();
        let mut split = Splitter::new(1 << 26);
        let mut buf = vec![0u8; 65536];
        loop {
            let n = match input.read(&mut buf) {
                Ok(0) | Err(_) => std::process::exit(0),
                Ok(n) => n,
            };
            let mut replies: Vec<String> = vec![];
            split.push(
                &buf[..n],
                |msg| {
                    let v: Value = serde_json::from_slice(msg).unwrap_or(Value::Null);
                    let m = v["method"].as_str().unwrap_or("?").to_string();
                    writeln!(methods, "{m}").unwrap();
                    match m.as_str() {
                        "Browser.getVersion" => replies.push(json!({ "id": v["id"], "result": { "product": "FakeChromium/1.0" } }).to_string()),
                        "Test.event" => {
                            replies.push(json!({ "method": "Test.happened", "params": {} }).to_string());
                            replies.push(json!({ "id": v["id"], "result": {} }).to_string());
                        }
                        _ => replies.push(json!({ "id": v["id"], "result": { "echo": m, "size": msg.len() } }).to_string()),
                    }
                },
                || {},
            );
            for r in replies {
                output.write_all(r.as_bytes()).unwrap();
                output.write_all(&[0]).unwrap();
            }
        }
    }

    /// A script that runs this test binary as the fake Chromium.
    pub fn fake_chromium_script(dir: &Path) -> PathBuf {
        let exe = std::env::current_exe().unwrap();
        let script = dir.join("fake-chromium");
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\ndir=\nfor a in \"$@\"; do case \"$a\" in --user-data-dir=*) dir=\"${{a#--user-data-dir=}}\";; esac; done\nprintf '%s\\n' \"$@\" > \"$dir/args.txt\"\nNOVA_FAKE_CHROMIUM=\"$dir\" exec '{}' --exact browser::tests::fake_chromium --ignored --nocapture --test-threads=1 >/dev/null\n",
                exe.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        script
    }

    pub fn browsers(base: &Path) -> Browsers {
        let mut b = Browsers::new(BrowserConfig { executable_path: Some(fake_chromium_script(base).to_string_lossy().to_string()), ..Default::default() }, &base.join("data"));
        b.root = base.join("profiles");
        b.egress = fake(echo_server(), Arc::new(AtomicUsize::new(0)));
        b.run_as = Box::new(|_| Ok(None));
        b
    }

    fn launch_args(id: &str) -> Value {
        json!({ "sessionId": id, "grantee": { "kind": "agent", "id": "a1" }, "allowHosts": ["allowed.test", "*.wild.test"], "headless": true })
    }

    /// The TCP ports `pid` listens on (Linux: its socket descriptors matched against
    /// /proc/net/tcp and tcp6 in the LISTEN state).
    fn listening_tcp(pid: u32) -> Vec<String> {
        let inodes: Vec<String> = std::fs::read_dir(format!("/proc/{pid}/fd"))
            .map(|d| d.flatten().filter_map(|e| std::fs::read_link(e.path()).ok()).filter_map(|l| l.to_string_lossy().strip_prefix("socket:[").map(|s| s.trim_end_matches(']').to_string())).collect())
            .unwrap_or_default();
        let mut out = vec![];
        for table in ["/proc/net/tcp", "/proc/net/tcp6"] {
            for line in std::fs::read_to_string(table).unwrap_or_default().lines().skip(1) {
                let f: Vec<&str> = line.split_whitespace().collect();
                if f.len() > 9 && f[3] == "0A" && inodes.iter().any(|i| i == f[9]) {
                    out.push(f[1].to_string());
                }
            }
        }
        out
    }

    #[test]
    fn launches_a_clean_profile_behind_the_filter_and_cleans_up() {
        let base = tmp("brw");
        let b = browsers(&base);
        let r = b.launch(&launch_args("s1")).unwrap();
        assert_eq!(r, json!({ "sessionId": "s1", "cdpPath": "/agent/v1/browser/cdp/s1" }));
        let profiles: Vec<PathBuf> = std::fs::read_dir(&b.root).unwrap().flatten().map(|e| e.path()).collect();
        assert_eq!(profiles.len(), 1);
        let profile = profiles[0].clone();
        assert_eq!(std::fs::metadata(&profile).unwrap().mode() & 0o777, 0o700);
        assert_eq!(std::fs::metadata(&b.root).unwrap().mode() & 0o777, 0o711);
        let args = std::fs::read_to_string(profile.join("args.txt")).unwrap();
        let proxy: u16 = args.lines().find_map(|l| l.strip_prefix("--proxy-server=http://127.0.0.1:")).unwrap().parse().unwrap();
        for want in ["--remote-debugging-pipe", "--proxy-bypass-list=<-loopback>", "--headless=new", "--no-first-run", &format!("--user-data-dir={}", profile.display())] {
            assert!(args.lines().any(|l| l == want), "{want} in {args}");
        }
        // DevTools over the pipe only: no port asked for, and the browser listens on none.
        assert!(!args.contains("--remote-debugging-port") && !args.contains("--remote-debugging-address"), "{args}");
        let pid = b.lock()["s1"].child.id();
        assert_eq!(listening_tcp(pid), Vec::<String>::new());
        // It answered novad's readiness question, which never reaches a client.
        assert_eq!(std::fs::read_to_string(profile.join("methods.txt")).unwrap(), "Browser.getVersion\n");
        assert_eq!(b.list()["sessions"][0]["browser"], "FakeChromium/1.0");
        // The session's filter is the proxy Chromium got: the allowlist applies.
        let mut s = TcpStream::connect(("127.0.0.1", proxy)).unwrap();
        s.write_all(b"CONNECT allowed.test:443 HTTP/1.1\r\n\r\n").unwrap();
        let mut ok = [0u8; 12];
        s.read_exact(&mut ok).unwrap();
        assert_eq!(&ok, b"HTTP/1.1 200");
        drop(s);
        let mut s = TcpStream::connect(("127.0.0.1", proxy)).unwrap();
        s.write_all(b"CONNECT elsewhere.test:443 HTTP/1.1\r\n\r\n").unwrap();
        s.read_exact(&mut ok).unwrap();
        assert_eq!(&ok, b"HTTP/1.1 403");
        drop(s);
        let listed = b.list();
        assert_eq!(listed["sessions"][0]["grantee"], json!({ "kind": "agent", "id": "a1" }));
        assert_eq!(listed["sessions"][0]["allowHosts"], json!(["allowed.test", "*.wild.test"]));
        // Same id again: refused; a second session is fine; a third is over the limit.
        assert_eq!(b.launch(&launch_args("s1")).unwrap_err().details.unwrap()["reason"], "session_exists");
        b.launch(&launch_args("s2")).unwrap();
        let e = b.launch(&launch_args("s3")).unwrap_err();
        assert_eq!((e.status, e.details.unwrap()["reason"].as_str()), (409, Some("session_limit")));
        // Close: the browser is gone, the profile deleted, the filter's counts reported.
        let c = b.close(&json!({ "sessionId": "s1" })).unwrap();
        assert_eq!(c, json!({ "closed": true, "egress": { "allowed": 1, "refused": 1 } }));
        assert!(!profile.exists());
        assert_eq!(b.close(&json!({ "sessionId": "s1" })).unwrap_err().code, "not_found");
        assert_eq!(b.close_all(), 1);
        assert!(std::fs::read_dir(&b.root).unwrap().next().is_none(), "no profile left");
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn refuses_bad_launches_and_reports_a_browser_that_fails() {
        let base = tmp("brw-bad");
        let mut b = browsers(&base);
        let bad = |b: &Browsers, v: Value| b.launch(&v).unwrap_err();
        let mut a = launch_args("x");
        a["sessionId"] = json!("a/b");
        assert_eq!(bad(&b, a).code, "validation");
        let mut a = launch_args("x");
        a["allowHosts"] = json!([]);
        assert_eq!(bad(&b, a).code, "validation");
        let mut a = launch_args("x");
        a["allowHosts"] = json!(["*"]);
        assert_eq!(bad(&b, a).code, "validation");
        let mut a = launch_args("x");
        a["grantee"] = json!({ "kind": "root", "id": "x" });
        assert_eq!(bad(&b, a).code, "validation");
        let mut a = launch_args("x");
        a["headless"] = json!("yes");
        assert_eq!(bad(&b, a).code, "validation");
        // A browser that exits at start: the error says so with its output; nothing is left.
        let mut a = launch_args("x");
        a["allowHosts"] = json!(["allowed.test"]);
        let script = base.join("fake-chromium");
        let text = std::fs::read_to_string(&script).unwrap().replace("printf '%s\\n' \"$@\"", "printf '%s\\n' \"$@\" --fail-at-start");
        std::fs::write(&script, text).unwrap();
        let e = bad(&b, a.clone());
        assert_eq!((e.status, e.details.unwrap()["reason"].as_str()), (503, Some("browser_start_failed")));
        assert!(e.message.contains("exited at start") && e.message.contains("failing at start"), "{}", e.message);
        assert!(std::fs::read_dir(&b.root).unwrap().next().is_none());
        // A browser that never answers on its pipe times out.
        std::fs::write(&script, "#!/bin/sh\nexec sleep 30\n").unwrap();
        b.start_timeout = Duration::from_millis(300);
        let e = bad(&b, a.clone());
        assert!(e.message.contains("did not answer on its DevTools pipe"), "{}", e.message);
        // No browser at all.
        b.cfg.executable_path = Some(base.join("missing").to_string_lossy().to_string());
        let e = bad(&b, a.clone());
        assert_eq!((e.status, e.code.as_str(), e.details.unwrap()["reason"].as_str()), (409, "capability_missing", Some("no_browser")));
        b.cfg.executable_path = None;
        b.candidates = vec![base.join("nope").to_string_lossy().to_string()];
        assert_eq!(bad(&b, a.clone()).details.unwrap()["reason"], "no_browser");
        assert_eq!(find_browser(&b.cfg, &[script.to_str().unwrap()]).unwrap(), script);
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn the_module_answers_its_operations() {
        let base = tmp("brw-op");
        let mut m = Module::new(&crate::state::Config::default(), &base.join("data"));
        m.sessions = Arc::new(browsers(&base));
        assert_eq!(op(&m, "status", &json!({})).unwrap()["sessions"], 0);
        op(&m, "browser.launch", &launch_args("o1")).unwrap();
        assert_eq!(op(&m, "browser.list", &json!({})).unwrap()["sessions"].as_array().unwrap().len(), 1);
        assert_eq!(op(&m, "browser.closeAll", &json!({})).unwrap()["closed"], 1);
        assert_eq!(op(&m, "bridge.status", &json!({})).unwrap()["connected"], false);
        assert_eq!(op(&m, "bridge.call", &json!({ "method": "tabs.list" })).unwrap_err().code, "bridge_offline");
        assert_eq!(op(&m, "nope", &json!({})).unwrap_err().code, "not_found");
        // A profile left by a crash goes when the module starts; the DevTools socket is private.
        std::fs::create_dir_all(m.sessions.root.join("s-crashed")).unwrap();
        m.start();
        assert!(!m.sessions.root.join("s-crashed").exists());
        let sock = cdp_socket(&base.join("data"));
        assert_eq!(std::fs::metadata(&sock).unwrap().mode() & 0o777, 0o600);
        assert_eq!(std::fs::metadata(sock.parent().unwrap()).unwrap().mode() & 0o777, 0o700);
        assert_eq!(connect_cdp(&base.join("data"), "nope").unwrap_err().code, "not_found");
        assert_eq!(connect_cdp(&base.join("elsewhere"), "o1").unwrap_err().details.unwrap()["reason"], "module_unavailable");
        std::fs::remove_dir_all(&base).unwrap();
    }

    struct T;
    impl Users for T {
        fn lookup(&self, name: &str) -> Option<Account> {
            let a = |uid, gid| Some(Account { uid, gid, home: "/nonexistent".into() });
            match name {
                "nova-browser1" => a(990, 990),
                "nova-browser2" => a(991, 991),
                "nobody" => a(65534, 65534),
                "toor" => a(0, 0),
                "wheelish" => a(3000, 0),
                "shared" => a(3001, 65534),
                _ => None,
            }
        }
    }

    #[test]
    fn runs_each_session_as_its_own_dedicated_user() {
        let cfg = BrowserConfig::default();
        assert_eq!(run_as_for(&cfg, false, &T).unwrap(), None, "a novad that is not root runs it as itself");
        let pool = run_as_for(&cfg, true, &T).unwrap().unwrap();
        assert_eq!(pool.iter().map(|a| a.uid).collect::<Vec<_>>(), vec![990, 991], "root: the dedicated users");
        // Root, nobody and users of group root (or of nobody's group) are refused, by name or list.
        for bad in [RunAs::One("toor".into()), RunAs::One("nobody".into()), RunAs::Many(vec!["nova-browser1".into(), "wheelish".into()]), RunAs::One("shared".into())] {
            let c = BrowserConfig { run_as: Some(bad.clone()), ..Default::default() };
            assert_eq!(run_as_for(&c, true, &T).unwrap_err().details.unwrap()["reason"], "unsafe_browser_user", "{bad:?}");
        }
        // No such user: a root novad fails closed.
        let missing = BrowserConfig { run_as: Some(RunAs::One("ghost".into())), ..Default::default() };
        let e = run_as_for(&missing, true, &T).unwrap_err();
        assert_eq!((e.status, e.details.unwrap()["reason"].as_str()), (409, Some("no_browser_user")));
        struct None_;
        impl Users for None_ {
            fn lookup(&self, _: &str) -> Option<Account> {
                None
            }
        }
        assert_eq!(run_as_for(&cfg, true, &None_).unwrap_err().details.unwrap()["reason"], "no_browser_user");
        // `runAs` reads as one name or a list.
        let c: BrowserConfig = serde_json::from_value(json!({ "runAs": "nova-browser2" })).unwrap();
        assert_eq!(c.run_as_names(), vec!["nova-browser2".to_string()]);
        let c: BrowserConfig = serde_json::from_value(json!({ "runAs": ["a", "b"] })).unwrap();
        assert_eq!(c.run_as_names(), vec!["a".to_string(), "b".to_string()]);
        // Making and removing the users (fake useradd/userdel).
        let runner = crate::power::tests::FakeRunner::default();
        struct Some1;
        impl Users for Some1 {
            fn lookup(&self, name: &str) -> Option<Account> {
                (name == "nova-browser1").then(|| Account { uid: 990, gid: 990, home: "/nonexistent".into() })
            }
        }
        if cfg!(target_os = "linux") {
            assert_eq!(ensure_users(&runner, &Some1).unwrap(), vec!["nova-browser2".to_string()]);
            let calls = runner.calls.lock().unwrap().clone();
            assert_eq!(calls.len(), 1);
            assert_eq!((calls[0][0].as_str(), calls[0].last().map(String::as_str)), ("useradd", Some("nova-browser2")));
            assert!(calls[0].contains(&"--system".to_string()) && calls[0].contains(&"--user-group".to_string()) && calls[0].contains(&"--no-create-home".to_string()));
            struct Bad;
            impl Users for Bad {
                fn lookup(&self, _: &str) -> Option<Account> {
                    Some(Account { uid: 5, gid: 0, home: "/".into() })
                }
            }
            assert!(ensure_users(&runner, &Bad).unwrap_err().contains("not a dedicated"));
        }
        assert_eq!(remove_users(&runner, &Some1), vec!["nova-browser1".to_string()]);
        assert_eq!(runner.calls.lock().unwrap().last().unwrap(), &vec!["userdel".to_string(), "nova-browser1".into()]);
    }

    #[test]
    fn a_root_novad_never_shares_a_browser_user_between_sessions() {
        let base = tmp("brw-uid");
        let mut b = browsers(&base);
        // This test's own account stands in for a dedicated user (switching to it needs no root).
        let m = std::fs::metadata(&base).unwrap();
        let me = Account { uid: m.uid(), gid: m.gid(), home: base.clone() };
        b.run_as = Box::new(move |_| Ok(Some(vec![me.clone()])));
        b.launch(&launch_args("u1")).unwrap();
        let profile = std::fs::read_dir(&b.root).unwrap().flatten().next().unwrap().path();
        assert_eq!(std::fs::metadata(&profile).unwrap().uid(), m.uid());
        let e = b.launch(&launch_args("u2")).unwrap_err();
        assert_eq!((e.status, e.details.unwrap()["reason"].as_str()), (409, Some("no_free_browser_user")));
        b.close(&json!({ "sessionId": "u1" })).unwrap();
        b.launch(&launch_args("u2")).unwrap();
        b.close_all();
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn skips_hosts_it_cannot_use_and_reports_them() {
        let base = tmp("brw-skip");
        let b = browsers(&base);
        let mut a = launch_args("k1");
        a["allowHosts"] = json!(["allowed.test", "*.dev", "intranet", "*.intranet", 7, "allowed.test"]);
        let r = b.launch(&a).unwrap();
        let skipped: Vec<&str> = r["skippedHosts"].as_array().unwrap().iter().map(|x| x["host"].as_str().unwrap_or("7")).collect();
        assert_eq!(skipped, vec!["*.dev", "*.intranet", "7"]);
        assert_eq!(b.list()["sessions"][0]["allowHosts"], json!(["allowed.test", "intranet"]));
        let mut none = launch_args("k2");
        none["allowHosts"] = json!(["*.dev", "1.2.3.4"]);
        let e = b.launch(&none).unwrap_err();
        assert_eq!((e.code.as_str(), e.details.unwrap()["skippedHosts"].as_array().unwrap().len()), ("validation", 2));
        b.close_all();
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn closes_sessions_nobody_drives() {
        let base = tmp("brw-reap");
        let mut b = browsers(&base);
        b.idle_timeout = Duration::from_millis(300);
        b.max_lifetime = Duration::from_secs(60);
        let b = Arc::new(b);
        b.serve_cdp().unwrap();
        b.launch(&launch_args("r1")).unwrap();
        b.launch(&launch_args("r2")).unwrap();
        // r2 has a DevTools client; r1 none.
        let client = connect_cdp(&base.join("data"), "r2").unwrap();
        std::thread::sleep(Duration::from_millis(400));
        assert_eq!(b.reap(), vec!["r1".to_string()]);
        assert_eq!(b.list()["sessions"].as_array().unwrap().len(), 1);
        // The client leaves: idle from then on.
        drop(client);
        std::thread::sleep(Duration::from_millis(100));
        assert!(b.reap().is_empty(), "not idle long enough yet");
        std::thread::sleep(Duration::from_millis(350));
        assert_eq!(b.reap(), vec!["r2".to_string()]);
        // The lifetime cap closes a session even with a client.
        let mut c = browsers(&base);
        c.max_lifetime = Duration::from_millis(200);
        let c = Arc::new(c);
        c.launch(&launch_args("r3")).unwrap();
        c.start_reaper();
        let t0 = Instant::now();
        while !c.list()["sessions"].as_array().unwrap().is_empty() && t0.elapsed() < Duration::from_secs(5) {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(c.list()["sessions"].as_array().unwrap().is_empty());
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn kill_group_reaps_the_browser_after_its_helpers() {
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", "sleep 30 & sleep 30"]);
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        let mut child = cmd.spawn().unwrap();
        let pid = child.id() as libc::pid_t;
        std::thread::sleep(Duration::from_millis(100));
        assert!(!has_exited(&child));
        let st = kill_group(&mut child);
        assert!(st.contains("signal"), "{st}");
        // The whole group is gone, the background sleep too (zombies waiting for their reaper do
        // not count).
        let live_in_group = || {
            std::fs::read_dir("/proc")
                .unwrap()
                .flatten()
                .filter_map(|e| std::fs::read_to_string(e.path().join("stat")).ok())
                .filter(|st| {
                    // pid (comm) state ppid pgrp ...
                    let rest = st.rsplit_once(')').map(|x| x.1).unwrap_or_default();
                    let f: Vec<&str> = rest.split_whitespace().collect();
                    f.len() > 2 && f[2] == pid.to_string() && f[0] != "Z"
                })
                .count()
        };
        let t0 = Instant::now();
        while live_in_group() > 0 && t0.elapsed() < Duration::from_secs(3) {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(live_in_group(), 0);
    }

    #[test]
    fn never_changes_or_cleans_the_folder_the_owner_configured() {
        use std::os::unix::fs::PermissionsExt as _;
        let base = tmp("brw-own");
        let configured = base.join("owner");
        std::fs::create_dir(&configured).unwrap();
        std::fs::set_permissions(&configured, std::fs::Permissions::from_mode(0o750)).unwrap();
        std::fs::create_dir(configured.join("s-mine")).unwrap();
        let b = Browsers::new(BrowserConfig { profile_root: Some(configured.to_string_lossy().to_string()), ..Default::default() }, &base.join("data"));
        assert_eq!(b.root.parent(), Some(configured.as_path()));
        assert!(b.root.file_name().unwrap().to_string_lossy().starts_with("nova-browser-"));
        prepare_root(&b.root).unwrap();
        clean_root(&b.root);
        assert_eq!(std::fs::metadata(&configured).unwrap().permissions().mode() & 0o777, 0o750, "untouched");
        assert!(configured.join("s-mine").exists(), "the owner's folder is never cleaned");
        // A configured folder that does not exist is not made (only novad's own folder is).
        let gone = Browsers::new(BrowserConfig { profile_root: Some(base.join("missing").to_string_lossy().to_string()), ..Default::default() }, &base.join("data"));
        assert_eq!(prepare_root(&gone.root).unwrap_err().code, "validation");
        assert!(!base.join("missing").exists());
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn keeps_the_profile_root_private_and_cleans_leftovers() {
        let base = tmp("brw-root");
        let root = base.join("r");
        prepare_root(&root).unwrap();
        assert_eq!(std::fs::metadata(&root).unwrap().mode() & 0o777, 0o711);
        std::fs::create_dir_all(root.join("s-old/Default")).unwrap();
        std::fs::write(root.join("stray"), "x").unwrap();
        let outside = base.join("outside");
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(outside.join("keep"), "x").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("s-link")).unwrap();
        assert_eq!(clean_root(&root), 2);
        assert!(outside.join("keep").exists(), "a link is removed, never followed");
        assert!(root.join("stray").exists(), "only session profiles are removed");
        assert_ne!(Browsers::new(BrowserConfig::default(), Path::new("/a")).root, Browsers::new(BrowserConfig::default(), Path::new("/b")).root);
        // A root others can write to, or a link, is refused.
        let open = base.join("open");
        std::fs::create_dir(&open).unwrap();
        std::fs::set_permissions(&open, std::fs::Permissions::from_mode(0o777)).unwrap();
        assert_eq!(prepare_root(&open).unwrap_err().details.unwrap()["reason"], "unsafe_path");
        let link = base.join("link");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        assert!(prepare_root(&link).is_err());
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn splits_whole_messages_and_drops_oversized_ones() {
        let mut s = Splitter::new(8);
        let (mut got, mut over) = (vec![], 0);
        for chunk in [&b"ab"[..], b"c\0de\0", b"0123456789", b"xyz\0ok\0"] {
            s.push(chunk, |m| got.push(String::from_utf8(m.to_vec()).unwrap()), || over += 1);
        }
        assert_eq!(got, vec!["abc", "de", "ok"]);
        assert_eq!(over, 1, "the 13-byte message was dropped up to its end");
    }

    /// A module side (the sessions and their DevTools socket) and a supervisor side (a server
    /// whose handler is the CDP upgrade), as in novad.
    struct Rig {
        base: PathBuf,
        b: Arc<Browsers>,
        pipes: Arc<CdpPipes>,
        handler: crate::http::Handler,
    }

    fn rig(name: &str) -> Rig {
        let base = tmp(name);
        let b = Arc::new(browsers(&base));
        b.serve_cdp().unwrap();
        let pipes = Arc::new(CdpPipes::default());
        let (p2, data) = (pipes.clone(), base.join("data"));
        let handler: crate::http::Handler = Arc::new(move |req: Request| cdp_upgrade(&req, &p2, &|id| connect_cdp(&data, id)));
        Rig { base, b, pipes, handler }
    }

    fn upgrade(path: &str, extra: &str) -> String {
        format!("GET {path} HTTP/1.1\r\nHost: device.lan:7420\r\nAuthorization: Bearer nvdm_test\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n{extra}\r\n")
    }

    fn head_of(c: &mut impl Read) -> String {
        let mut head = Vec::new();
        let mut one = [0u8; 1];
        while !head.ends_with(b"\r\n\r\n") {
            c.read_exact(&mut one).unwrap();
            head.push(one[0]);
        }
        String::from_utf8(head).unwrap()
    }

    /// Ask the browser `method` with `id` and read frames until its answer.
    fn ask(c: &mut (impl Read + Write), id: u64, method: &str) -> Value {
        c.write_all(&client_frame(true, OP_TEXT, json!({ "id": id, "method": method }).to_string().as_bytes())).unwrap();
        c.flush().unwrap();
        loop {
            let (op, p) = read_frame(c).unwrap();
            assert_eq!(op, OP_TEXT);
            let v: Value = serde_json::from_slice(&p).unwrap();
            if v["id"] == id {
                return v;
            }
        }
    }

    #[test]
    fn answers_the_websocket_itself_and_relays_to_the_pipe() {
        let r = rig("brw-ws");
        r.b.launch(&launch_args("s1")).unwrap();
        let server = crate::http::serve(TcpListener::bind("127.0.0.1:0").unwrap(), 1 << 20, r.handler.clone());
        let addr = server.local_addr();
        let open = || {
            let mut c = TcpStream::connect(addr).unwrap();
            c.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            c.write_all(upgrade("/agent/v1/browser/cdp/s1", "").as_bytes()).unwrap();
            let head = head_of(&mut c);
            (c, head)
        };
        let (mut c, head) = open();
        assert!(head.starts_with("HTTP/1.1 101") && head.contains("Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n"), "{head}");
        assert!(!head.to_ascii_lowercase().contains("sec-websocket-extensions"), "nothing is negotiated");
        // A message and its answer; the readiness answer never reached us.
        assert_eq!(ask(&mut c, 1, "Page.navigate")["result"]["echo"], "Page.navigate");
        // An event before an answer, both as text frames.
        c.write_all(&client_frame(true, OP_TEXT, br#"{"id":2,"method":"Test.event"}"#)).unwrap();
        let (_, ev) = read_frame(&mut c).unwrap();
        assert_eq!(serde_json::from_slice::<Value>(&ev).unwrap()["method"], "Test.happened");
        let (_, ans) = read_frame(&mut c).unwrap();
        assert_eq!(serde_json::from_slice::<Value>(&ans).unwrap()["id"], 2);
        // A fragmented message with a ping in between: the pong comes first, then the answer.
        c.write_all(&client_frame(false, OP_TEXT, br#"{"id":3,"#)).unwrap();
        c.write_all(&client_frame(true, OP_PING, b"hb")).unwrap();
        c.write_all(&client_frame(true, crate::ws::OP_CONT, br#""method":"Frag.ment"}"#)).unwrap();
        assert_eq!(read_frame(&mut c).unwrap(), (OP_PONG, b"hb".to_vec()));
        assert_eq!(serde_json::from_slice::<Value>(&read_frame(&mut c).unwrap().1).unwrap()["result"]["echo"], "Frag.ment");
        // A large message passes whole (126- and 127-length frames both ways).
        let big = json!({ "id": 4, "method": "Big", "params": { "data": "x".repeat(100_000) } }).to_string();
        c.write_all(&client_frame(true, OP_TEXT, big.as_bytes())).unwrap();
        assert_eq!(serde_json::from_slice::<Value>(&read_frame(&mut c).unwrap().1).unwrap()["result"]["size"], big.len());
        let profile = std::fs::read_dir(&r.b.root).unwrap().flatten().next().unwrap().path();
        assert_eq!(std::fs::read_to_string(profile.join("methods.txt")).unwrap(), "Browser.getVersion\nPage.navigate\nTest.event\nFrag.ment\nBig\n");
        // A second connection replaces the first, which is closed with 1001.
        let (mut c2, _) = open();
        assert_eq!(read_frame(&mut c).unwrap(), (OP_CLOSE, 1001u16.to_be_bytes().to_vec()));
        assert_eq!(ask(&mut c2, 5, "After.reconnect")["result"]["echo"], "After.reconnect");
        // A binary frame is refused with 1003 and the connection ends.
        c2.write_all(&client_frame(true, crate::ws::OP_BINARY, b"x")).unwrap();
        assert_eq!(read_frame(&mut c2).unwrap(), (OP_CLOSE, 1003u16.to_be_bytes().to_vec()));
        // The client closes: the close is answered.
        let (mut c3, _) = open();
        c3.write_all(&client_frame(true, OP_CLOSE, &1000u16.to_be_bytes())).unwrap();
        assert_eq!(read_frame(&mut c3).unwrap(), (OP_CLOSE, 1000u16.to_be_bytes().to_vec()));
        // Closing the session ends the connection with 1001.
        let (mut c4, _) = open();
        assert_eq!(ask(&mut c4, 6, "Still.there")["id"], 6);
        r.b.close(&json!({ "sessionId": "s1" })).unwrap();
        r.pipes.close_session("s1");
        assert_eq!(read_frame(&mut c4).unwrap(), (OP_CLOSE, 1001u16.to_be_bytes().to_vec()));
        // Refusals: an unknown session, an Origin, no upgrade, a malformed key.
        let refuse = |raw: String| {
            let mut c = TcpStream::connect(addr).unwrap();
            c.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            c.write_all(raw.as_bytes()).unwrap();
            let mut out = String::new();
            let _ = c.read_to_string(&mut out);
            out
        };
        assert!(refuse(upgrade("/agent/v1/browser/cdp/s1", "")).starts_with("HTTP/1.1 404"));
        assert!(refuse(upgrade("/agent/v1/browser/cdp/..%2f", "")).starts_with("HTTP/1.1 404"));
        r.b.launch(&launch_args("s2")).unwrap();
        assert!(refuse(upgrade("/agent/v1/browser/cdp/s2", "Origin: https://evil.example\r\n")).contains("origin_rejected"));
        assert!(refuse("GET /agent/v1/browser/cdp/s2 HTTP/1.1\r\nHost: x\r\n\r\n".into()).starts_with("HTTP/1.1 400"));
        assert!(refuse(upgrade("/agent/v1/browser/cdp/s2", "").replace("dGhlIHNhbXBsZSBub25jZQ==", "short")).starts_with("HTTP/1.1 400"));
        r.b.close_all();
        server.stop();
        std::fs::remove_dir_all(&r.base).unwrap();
    }

    /// The Hub's side of a TLS connection for the test: it presents `client` and takes any server
    /// certificate (the device check is the management client's, tested with the TLS server).
    fn tls_client(port: u16, client: (Vec<u8>, Vec<u8>)) -> rustls::StreamOwned<rustls::ClientConnection, TcpStream> {
        use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
        use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, ServerName, UnixTime};
        #[derive(Debug)]
        struct Any(Arc<rustls::crypto::CryptoProvider>);
        impl ServerCertVerifier for Any {
            fn verify_server_cert(&self, _: &CertificateDer<'_>, _: &[CertificateDer<'_>], _: &ServerName<'_>, _: &[u8], _: UnixTime) -> Result<ServerCertVerified, rustls::Error> {
                Ok(ServerCertVerified::assertion())
            }
            fn verify_tls12_signature(&self, m: &[u8], c: &CertificateDer<'_>, d: &rustls::DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
                rustls::crypto::verify_tls12_signature(m, c, d, &self.0.signature_verification_algorithms)
            }
            fn verify_tls13_signature(&self, m: &[u8], c: &CertificateDer<'_>, d: &rustls::DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
                rustls::crypto::verify_tls13_signature(m, c, d, &self.0.signature_verification_algorithms)
            }
            fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
                self.0.signature_verification_algorithms.supported_schemes()
            }
        }
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let config = rustls::ClientConfig::builder_with_provider(provider.clone())
            .with_protocol_versions(&[&rustls::version::TLS13])
            .unwrap()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(Any(provider)))
            .with_client_auth_cert(vec![CertificateDer::from(client.0)], PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(client.1)))
            .unwrap();
        let tcp = TcpStream::connect(("127.0.0.1", port)).unwrap();
        tcp.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let conn = rustls::ClientConnection::new(Arc::new(config), ServerName::try_from("10.0.0.9").unwrap()).unwrap();
        rustls::StreamOwned::new(conn, tcp)
    }

    #[test]
    fn relays_the_websocket_over_mutual_tls() {
        use crate::mgmt_tls::tests::{device_with_certificate, hub_client};
        let r = rig("brw-tls");
        r.b.launch(&launch_args("t1")).unwrap();
        let (base2, data, pki) = device_with_certificate("brw-tls-dev");
        let server = crate::mgmt_tls::serve(TcpListener::bind("127.0.0.1:0").unwrap(), 1 << 20, data, r.handler.clone());
        let mut c = tls_client(server.local_addr().port(), hub_client(&pki));
        c.write_all(upgrade("/agent/v1/browser/cdp/t1", "").as_bytes()).unwrap();
        c.flush().unwrap();
        assert!(head_of(&mut c).starts_with("HTTP/1.1 101"));
        // Many round trips through the TLS stream, small and large.
        for i in 1..=20u64 {
            assert_eq!(ask(&mut c, i, &format!("M.m{i}"))["result"]["echo"], format!("M.m{i}"));
        }
        let big = json!({ "id": 99, "method": "Big", "params": { "data": "y".repeat(200_000) } }).to_string();
        c.write_all(&client_frame(true, OP_TEXT, big.as_bytes())).unwrap();
        c.flush().unwrap();
        assert_eq!(serde_json::from_slice::<Value>(&read_frame(&mut c).unwrap().1).unwrap()["result"]["size"], big.len());
        assert_eq!(r.pipes.count("t1"), 1);
        r.b.close_all();
        r.pipes.close_session("t1");
        server.stop();
        std::fs::remove_dir_all(&r.base).unwrap();
        std::fs::remove_dir_all(&base2).unwrap();
    }
}
