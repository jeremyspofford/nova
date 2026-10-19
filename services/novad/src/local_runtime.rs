//! The local runtime module (FR-128 groundwork, docs/21 §9, docs/22 §4.2): `novad module
//! local-runtime` proxies an OpenAI-compatible model server on this device (the owner's
//! `config.json` `localRuntime.upstream`, default http://127.0.0.1:11434/v1) to local clients
//! (the desktop shell, later the web app) so they can keep working with local models when the
//! Hub is unreachable.
//!
//! - Only authenticated local clients (FR-192): a Unix socket of mode 0600 in a 0700 folder
//!   (`<data>/local-runtime/runtime.sock`), and, when the owner sets `localRuntime.listen`, a
//!   loopback address that needs the bearer token in `<data>/local-runtime/token` (0600). A
//!   request on the loopback address must name a loopback Host (no DNS rebinding) and carries no
//!   Origin unless the owner allowed it (`localRuntime.allowedOrigins`). Loopback is never
//!   authorization on its own.
//! - Only with the Hub's grant: every request is refused (403 `scope_missing`) unless the last
//!   heartbeat answer granted `local-runtime` (`scopes.json`); the grant survives a restart, so
//!   the runtime keeps working while the Hub is down. No answer yet means no grant.
//! - Only the model routes: `GET /v1/models`, `POST /v1/chat/completions`, `/v1/completions`,
//!   `/v1/embeddings`. Responses stream through as the server sends them (server-sent events).
//! - The module reports the server's models to the supervisor (`models`), which puts them in the
//!   capability document.
//! - novad runs as root, so its own socket is out of reach of a user's desktop shell: for each user
//!   in `localRuntime.users` (`novad install|enroll --user`) the module also binds a socket in that
//!   user's runtime folder, owned by the user (src/user_socket.rs), with the same admission.

use crate::crypto::constant_time_eq;
use crate::http::{Request, Response};
use crate::state::DataDir;
use crate::util::{OpError, OpResult};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::io::{BufReader, Read, Write};
use std::net::{IpAddr, SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

pub const MODULE: &str = "local-runtime";
/// The scope the Hub grants at Add Device or on the device page (docs/22 §4.2).
pub const SCOPE: &str = "local-runtime";
pub const DEFAULT_UPSTREAM: &str = "http://127.0.0.1:11434/v1";
pub const TOKEN_PREFIX: &str = "nvlr_";
const MAX_BODY: usize = 16 * 1024 * 1024;
/// A response larger than this is cut off (a model's answer is far smaller).
const MAX_RESPONSE: u64 = 256 * 1024 * 1024;
/// Model servers may think for a while before the first token.
const UPSTREAM_IDLE: Duration = Duration::from_secs(300);
const MAX_CONNECTIONS: usize = 32;
/// A local client must send its request within this long between bytes.
const CLIENT_READ_TIMEOUT: Duration = Duration::from_secs(30);
/// And keep reading the answer.
const CLIENT_WRITE_TIMEOUT: Duration = Duration::from_secs(60);
const ROUTES: &[(&str, &str)] = &[("GET", "/v1/models"), ("POST", "/v1/chat/completions"), ("POST", "/v1/completions"), ("POST", "/v1/embeddings")];

/// The owner's settings for the runtime (`config.json` `localRuntime`).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct LocalRuntimeConfig {
    /// The model server's OpenAI-compatible base URL (http:// only); None uses the default.
    pub upstream: Option<String>,
    /// A loopback HOST:PORT to also listen on (token required); None: the Unix socket only.
    pub listen: Option<String>,
    /// Origins allowed to call the loopback address (a browser page); none by default.
    pub allowed_origins: Vec<String>,
    /// Users who get a socket of their own in their runtime folder (`--user`, src/user_socket.rs).
    pub users: Vec<String>,
}

/// A user name novad accepts: letters, digits, `_`, `.` and `-`, not starting with `-` or `.`.
pub fn valid_user(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && !name.starts_with(['-', '.'])
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
}

/// How a request arrived.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Via {
    /// The 0600 Unix socket: the file mode is the authentication.
    Socket,
    /// The loopback address on this port: the token is.
    Loopback(u16),
}

pub struct Runtime {
    data: DataDir,
    upstream: String,
    allowed_origins: Vec<String>,
    listen: Option<SocketAddr>,
    token: String,
    active: Arc<AtomicUsize>,
    /// How long a client may stay silent while sending its request (shorter in tests).
    client_timeout: Duration,
    users: Vec<String>,
    #[cfg(unix)]
    user_sockets: std::sync::Mutex<Option<Arc<crate::user_socket::UserSockets>>>,
}

/// Where the runtime listens once started.
#[derive(Debug, Clone)]
pub struct Listening {
    pub socket: Option<PathBuf>,
    pub loopback: Option<SocketAddr>,
}

fn dir(data: &DataDir) -> PathBuf {
    data.path().join("local-runtime")
}

pub fn socket_path(data: &DataDir) -> PathBuf {
    dir(data).join("runtime.sock")
}

pub fn token_path(data: &DataDir) -> PathBuf {
    dir(data).join("token")
}

impl Runtime {
    /// Read the owner's settings and the token (created on first use), checking the upstream is
    /// http:// and the listen address is loopback.
    pub fn new(data: &DataDir) -> OpResult<Runtime> {
        let cfg = data.config()?.local_runtime;
        let upstream = cfg.upstream.unwrap_or_else(|| DEFAULT_UPSTREAM.to_string()).trim_end_matches('/').to_string();
        if !upstream.starts_with("http://") {
            return Err(OpError::validation("localRuntime.upstream must be an http:// URL of a model server on this device or LAN"));
        }
        crate::http::host_port(&upstream).map_err(|e| OpError::validation(format!("localRuntime.upstream: {e}")))?;
        let listen = match cfg.listen {
            None => None,
            Some(l) => {
                let addr: SocketAddr = l.parse().map_err(|_| OpError::validation("localRuntime.listen must be HOST:PORT"))?;
                // Never on the network: other machines reach models through the Hub.
                if !addr.ip().is_loopback() {
                    return Err(OpError::validation("localRuntime.listen must be a loopback address (127.0.0.1 or [::1])"));
                }
                Some(addr)
            }
        };
        let d = dir(data);
        std::fs::create_dir_all(&d)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&d, std::fs::Permissions::from_mode(0o700))?;
        }
        let token = match std::fs::read_to_string(token_path(data)) {
            Ok(t) if t.trim().starts_with(TOKEN_PREFIX) => t.trim().to_string(),
            _ => {
                let t = crate::util::new_token(TOKEN_PREFIX).map_err(OpError::internal)?;
                crate::util::write_atomic(&token_path(data), t.as_bytes(), true)?;
                t
            }
        };
        let users: Vec<String> = cfg.users.into_iter().filter(|u| valid_user(u)).collect();
        Ok(Runtime {
            data: data.clone(),
            upstream,
            allowed_origins: cfg.allowed_origins,
            listen,
            token,
            active: Arc::new(AtomicUsize::new(0)),
            client_timeout: CLIENT_READ_TIMEOUT,
            users,
            #[cfg(unix)]
            user_sockets: std::sync::Mutex::new(None),
        })
    }

    /// Whether the Hub granted this device the local runtime (fail closed before any answer).
    pub fn granted(&self) -> bool {
        self.data.granted_scopes().iter().any(|s| s == SCOPE)
    }

    /// Listen on the Unix socket (unix) and the loopback address, if configured.
    pub fn start(self: &Arc<Self>) -> OpResult<Listening> {
        let mut out = Listening { socket: None, loopback: None };
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            use std::os::unix::net::UnixListener;
            let path = socket_path(&self.data);
            // A socket left by an earlier run; a live one would still be bound by its process.
            let _ = std::fs::remove_file(&path);
            let listener = UnixListener::bind(&path).map_err(|e| OpError::internal(format!("cannot listen on {}: {e}", path.display())))?;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
            let rt = self.clone();
            std::thread::spawn(move || {
                for conn in listener.incoming().flatten() {
                    rt.accept_socket(conn);
                }
            });
            out.socket = Some(path);
            if !self.users.is_empty() {
                let us = self.user_sockets(crate::user_socket::UserSockets::system(self.users.clone(), self.socket_server()));
                us.watch(crate::user_socket::RECHECK);
            }
        }
        if let Some(addr) = self.listen {
            let listener = TcpListener::bind(addr).map_err(|e| OpError::internal(format!("cannot listen on {addr}: {e}")))?;
            let bound = listener.local_addr()?;
            let rt = self.clone();
            std::thread::spawn(move || {
                for conn in listener.incoming().flatten() {
                    let Some(slot) = rt.slot() else { continue };
                    let _ = conn.set_read_timeout(Some(rt.client_timeout));
                    let _ = conn.set_write_timeout(Some(CLIENT_WRITE_TIMEOUT));
                    let rt = rt.clone();
                    std::thread::spawn(move || {
                        let _slot = slot;
                        if let Ok(reader) = conn.try_clone() {
                            rt.serve(Box::new(reader), Box::new(conn), Via::Loopback(bound.port()));
                        }
                    });
                }
            });
            out.loopback = Some(bound);
        }
        Ok(out)
    }

    /// What serves one connection on a user's socket: the same admission as the root socket.
    #[cfg(unix)]
    fn socket_server(self: &Arc<Self>) -> Arc<dyn Fn(std::os::unix::net::UnixStream) + Send + Sync> {
        let rt = self.clone();
        Arc::new(move |conn: std::os::unix::net::UnixStream| rt.accept_socket(conn))
    }

    /// One connection on a Unix socket (root's or a user's): a slot is taken before any thread
    /// starts (none free: the connection is closed), and a client that stops sending or reading
    /// loses it after the timeouts, so a local user cannot hold every slot.
    #[cfg(unix)]
    fn accept_socket(self: &Arc<Self>, conn: std::os::unix::net::UnixStream) {
        let Some(slot) = self.slot() else { return };
        let _ = conn.set_read_timeout(Some(self.client_timeout));
        let _ = conn.set_write_timeout(Some(CLIENT_WRITE_TIMEOUT));
        let rt = self.clone();
        std::thread::spawn(move || {
            let _slot = slot;
            if let Ok(reader) = conn.try_clone() {
                rt.serve(Box::new(reader), Box::new(conn), Via::Socket);
            }
        });
    }

    /// Keep the per-user sockets (for `status`).
    #[cfg(unix)]
    fn user_sockets(&self, us: crate::user_socket::UserSockets) -> Arc<crate::user_socket::UserSockets> {
        let us = Arc::new(us);
        *self.user_sockets.lock().unwrap_or_else(|p| p.into_inner()) = Some(us.clone());
        us
    }

    fn slot(&self) -> Option<Slot> {
        if self.active.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
            self.active.fetch_sub(1, Ordering::SeqCst);
            return None;
        }
        Some(Slot(self.active.clone()))
    }

    /// The module's operations for the supervisor: `status` and `models`.
    pub fn op(&self, op: &str, _args: &Value) -> OpResult<Value> {
        match op {
            "status" => Ok(json!({
                "module": MODULE,
                "ready": true,
                "granted": self.granted(),
                "upstream": self.upstream,
                "socket": cfg!(unix).then(|| socket_path(&self.data)),
                "listen": self.listen.map(|a| a.to_string()),
                "users": self.users_status(),
            })),
            "models" => self.models().map(|m| json!({ "models": m })),
            _ => Err(OpError::not_found(format!("the {MODULE} module has no operation {op}"))),
        }
    }

    fn users_status(&self) -> Value {
        #[cfg(unix)]
        if let Some(us) = self.user_sockets.lock().unwrap_or_else(|p| p.into_inner()).as_ref() {
            return us.status();
        }
        json!([])
    }

    /// The model ids the server lists (`GET <upstream>/models`, OpenAI `data[].id`).
    pub fn models(&self) -> OpResult<Vec<String>> {
        let (status, v) = crate::http::get_json(&format!("{}/models", self.upstream), None, Duration::from_secs(5)).map_err(|e| OpError::unavailable(format!("the local model server at {} did not answer: {e}", self.upstream)))?;
        if status != 200 {
            return Err(OpError::unavailable(format!("the local model server answered {status}")));
        }
        let mut ids: Vec<String> = v["data"].as_array().or(v["models"].as_array()).into_iter().flatten().filter_map(|m| m["id"].as_str().or(m["name"].as_str()).map(str::to_string)).collect();
        ids.sort();
        ids.dedup();
        Ok(ids)
    }

    /// Check one request; Err is the response to send instead of proxying.
    pub fn admit(&self, req: &Request, via: Via) -> Result<(), Response> {
        if let Via::Loopback(port) = via {
            // DNS rebinding: a page that resolves its own name to 127.0.0.1 sends its own Host.
            let host = req.header("host").unwrap_or_default().to_ascii_lowercase();
            if ![format!("127.0.0.1:{port}"), format!("localhost:{port}"), format!("[::1]:{port}")].contains(&host) {
                return Err(Response::error(403, "policy_denied", "the Host must be this device's loopback address", Some(json!({ "reason": "host_not_allowed" }))));
            }
            if let Some(origin) = req.header("origin")
                && !self.allowed_origins.iter().any(|o| o == origin)
            {
                return Err(Response::error(403, "policy_denied", "this origin may not use the local runtime", Some(json!({ "reason": "origin_not_allowed" }))));
            }
            let ok = req.bearer().is_some_and(|b| constant_time_eq(b.as_bytes(), self.token.as_bytes()));
            if !ok {
                return Err(Response::error(401, "token_required", "the local runtime token is required", None));
            }
        }
        if !self.granted() {
            return Err(Response::error(
                403,
                "policy_denied",
                "the Hub has not granted this device the local runtime",
                Some(json!({ "reason": "scope_missing", "scope": SCOPE, "action": "Turn on Local models for this device on the Hub" })),
            ));
        }
        if !ROUTES.iter().any(|(m, p)| *m == req.method && *p == req.path) {
            return Err(Response::error(404, "not_found", "the local runtime serves /v1/models, /v1/chat/completions, /v1/completions and /v1/embeddings", None));
        }
        Ok(())
    }

    /// One connection: read the request, admit it, then pass it to the model server and its
    /// answer back as it arrives.
    pub fn serve(&self, read: Box<dyn Read + Send>, mut write: Box<dyn Write + Send>, via: Via) {
        let mut reader = BufReader::new(read);
        let req = match crate::http::read_one_request(&mut reader, MAX_BODY) {
            Ok(r) => r,
            Err(e) if e == "closed" => return,
            Err(e) => {
                let _ = crate::http::write_one_response(&mut write, &Response::error(400, "validation", &e, None), false);
                return;
            }
        };
        if let Err(r) = self.admit(&req, via) {
            let _ = crate::http::write_one_response(&mut write, &r, false);
            return;
        }
        if let Err(e) = self.forward(&req, &mut write) {
            let _ = crate::http::write_one_response(&mut write, &Response::error(502, "node_unavailable", &e, None), false);
        }
    }

    fn forward(&self, req: &Request, client: &mut dyn Write) -> Result<(), String> {
        let (host, port) = crate::http::host_port(&self.upstream)?;
        let base = self.upstream.split_once("://").map(|(_, r)| r).unwrap_or_default();
        let base_path = base.find('/').map(|i| &base[i..]).unwrap_or("");
        // /v1/chat/completions -> <upstream>/chat/completions (the upstream names its /v1).
        let path = format!("{base_path}{}", req.path.trim_start_matches("/v1"));
        let addr = (host.as_str(), port).to_socket_addrs_first().ok_or_else(|| format!("cannot resolve {host}"))?;
        let mut up = TcpStream::connect_timeout(&addr, Duration::from_secs(5)).map_err(|e| format!("the local model server at {} did not answer: {e}", self.upstream))?;
        let _ = up.set_read_timeout(Some(UPSTREAM_IDLE));
        let _ = up.set_write_timeout(Some(Duration::from_secs(30)));
        let authority = if host.contains(':') { format!("[{host}]:{port}") } else { format!("{host}:{port}") };
        let mut head = format!("{} {path} HTTP/1.1\r\nHost: {authority}\r\nUser-Agent: novad-local-runtime\r\n", req.method);
        for name in ["content-type", "accept"] {
            if let Some(v) = req.header(name).filter(|v| !v.bytes().any(|b| b < b' ' || b == 0x7f)) {
                head.push_str(&format!("{name}: {v}\r\n"));
            }
        }
        if req.method == "POST" {
            head.push_str(&format!("Content-Length: {}\r\n", req.body.len()));
        }
        head.push_str("Connection: close\r\n\r\n");
        let mut msg = head.into_bytes();
        msg.extend_from_slice(&req.body);
        up.write_all(&msg).map_err(|e| format!("sending to the local model server failed: {e}"))?;
        // The answer passes through byte for byte as it arrives (chunked server-sent events stay
        // a stream); both sides close afterwards.
        let mut buf = [0u8; 16 * 1024];
        let mut total: u64 = 0;
        let mut first = true;
        loop {
            let n = match up.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => n,
                Err(e) if first => return Err(format!("the local model server did not answer: {e}")),
                Err(_) => break,
            };
            first = false;
            total += n as u64;
            if total > MAX_RESPONSE || client.write_all(&buf[..n]).is_err() || client.flush().is_err() {
                break;
            }
        }
        if first {
            return Err("the local model server closed the connection without answering".into());
        }
        Ok(())
    }
}

trait FirstAddr {
    fn to_socket_addrs_first(&self) -> Option<SocketAddr>;
}

impl FirstAddr for (&str, u16) {
    fn to_socket_addrs_first(&self) -> Option<SocketAddr> {
        if let Ok(ip) = self.0.parse::<IpAddr>() {
            return Some(SocketAddr::new(ip, self.1));
        }
        std::net::ToSocketAddrs::to_socket_addrs(self).ok()?.next()
    }
}

struct Slot(Arc<AtomicUsize>);

impl Drop for Slot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::grants::tests::tmp;
    use std::io::BufRead;
    use std::sync::mpsc;

    /// A fake OpenAI-compatible server: models, and a chat stream that waits for `go` between
    /// its first and second event.
    fn fake_model_server(go: mpsc::Receiver<()>) -> SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let go = std::sync::Mutex::new(go);
        std::thread::spawn(move || {
            for conn in listener.incoming().flatten() {
                let mut reader = BufReader::new(conn.try_clone().unwrap());
                let Ok(req) = crate::http::read_one_request(&mut reader, 1 << 20) else { continue };
                let mut out = conn;
                if req.path == "/v1/models" {
                    let body = r#"{"object":"list","data":[{"id":"qwen3:8b"},{"id":"llama3.2"}]}"#;
                    let _ = write!(out, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                    continue;
                }
                assert_eq!(req.path, "/v1/chat/completions");
                assert!(String::from_utf8_lossy(&req.body).contains("\"stream\":true"));
                let _ = out.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n");
                let ev = |s: &str| format!("{:x}\r\n{s}\r\n", s.len());
                let _ = out.write_all(ev("data: {\"choices\":[{\"delta\":{\"content\":\"he\"}}]}\n\n").as_bytes());
                let _ = out.flush();
                let _ = go.lock().unwrap().recv_timeout(Duration::from_secs(5));
                let _ = out.write_all(ev("data: {\"choices\":[{\"delta\":{\"content\":\"llo\"}}]}\n\ndata: [DONE]\n\n").as_bytes());
                let _ = out.write_all(b"0\r\n\r\n");
            }
        });
        addr
    }

    fn runtime(upstream: &str, listen: bool) -> (Arc<Runtime>, Listening, PathBuf) {
        let base = tmp("lr");
        let data = DataDir(base.join("d"));
        data.ensure().unwrap();
        let mut cfg = data.config().unwrap();
        cfg.local_runtime = LocalRuntimeConfig { upstream: Some(upstream.into()), listen: listen.then(|| "127.0.0.1:0".to_string()), allowed_origins: vec!["app://nova".into()], users: vec![] };
        crate::util::write_json(&data.config_path(), &cfg, false).unwrap();
        let rt = Arc::new(Runtime::new(&data).unwrap());
        let on = rt.start().unwrap();
        (rt, on, base)
    }

    fn send(addr: SocketAddr, raw: &str) -> String {
        let mut s = TcpStream::connect(addr).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        s.write_all(raw.as_bytes()).unwrap();
        let mut out = String::new();
        let _ = s.read_to_string(&mut out);
        out
    }

    fn get(port: u16, extra: &str) -> String {
        format!("GET /v1/models HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{extra}Connection: close\r\n\r\n")
    }

    #[test]
    fn needs_the_token_a_loopback_host_and_the_hubs_grant() {
        let (_go_tx, go) = mpsc::channel();
        let up = fake_model_server(go);
        let (rt, on, base) = runtime(&format!("http://{up}/v1"), true);
        let addr = on.loopback.unwrap();
        let port = addr.port();
        let token = std::fs::read_to_string(token_path(&rt.data)).unwrap();
        assert!(token.starts_with(TOKEN_PREFIX));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(token_path(&rt.data)).unwrap().permissions().mode() & 0o777, 0o600);
        }
        assert!(send(addr, &get(port, "")).starts_with("HTTP/1.1 401"), "no token");
        assert!(send(addr, &get(port, "Authorization: Bearer nvlr_wrong\r\n")).starts_with("HTTP/1.1 401"));
        let auth = format!("Authorization: Bearer {token}\r\n");
        // A rebinding page names its own host; a browser page sends an Origin.
        let rebound = format!("GET /v1/models HTTP/1.1\r\nHost: evil.example:{port}\r\n{auth}Connection: close\r\n\r\n");
        assert!(send(addr, &rebound).contains("host_not_allowed"));
        assert!(send(addr, &get(port, &format!("{auth}Origin: https://evil.example\r\n"))).contains("origin_not_allowed"));
        // A valid caller is still refused until the Hub grants the scope (fail closed).
        let refused = send(addr, &get(port, &auth));
        assert!(refused.starts_with("HTTP/1.1 403") && refused.contains("scope_missing"), "{refused}");
        rt.data.save_granted_scopes(&[SCOPE.into()]).unwrap();
        let ok = send(addr, &get(port, &format!("{auth}Origin: app://nova\r\n")));
        assert!(ok.starts_with("HTTP/1.1 200") && ok.contains("qwen3:8b"), "{ok}");
        assert!(send(addr, &format!("GET /api/v1/hello HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{auth}\r\n")).starts_with("HTTP/1.1 404"));
        // The Hub takes the grant back: refused again.
        rt.data.save_granted_scopes(&[]).unwrap();
        assert!(send(addr, &get(port, &auth)).contains("scope_missing"));
        assert_eq!(rt.op("models", &json!({})).unwrap()["models"], json!(["llama3.2", "qwen3:8b"]));
        assert_eq!(rt.op("status", &json!({})).unwrap()["granted"], false);
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn streams_the_model_servers_answer_as_it_arrives() {
        let (go_tx, go) = mpsc::channel();
        let up = fake_model_server(go);
        let (rt, on, base) = runtime(&format!("http://{up}/v1"), false);
        rt.data.save_granted_scopes(&[SCOPE.into()]).unwrap();
        // The Unix socket: mode 0600, in a 0700 folder; the file mode is the authentication.
        let path = on.socket.clone().unwrap();
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(std::fs::metadata(path.parent().unwrap()).unwrap().permissions().mode() & 0o777, 0o700);
        let mut s = std::os::unix::net::UnixStream::connect(&path).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let body = r#"{"model":"qwen3:8b","stream":true,"messages":[{"role":"user","content":"hi"}]}"#;
        write!(s, "POST /v1/chat/completions HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len()).unwrap();
        let mut reader = BufReader::new(s.try_clone().unwrap());
        let mut seen = String::new();
        // The first event arrives while the server is still holding back the second.
        while !seen.contains("\"he\"") {
            let mut line = String::new();
            assert!(reader.read_line(&mut line).unwrap() > 0, "closed early: {seen}");
            seen.push_str(&line);
        }
        assert!(seen.starts_with("HTTP/1.1 200") && seen.contains("text/event-stream"), "{seen}");
        assert!(!seen.contains("llo"));
        go_tx.send(()).unwrap();
        let mut rest = String::new();
        reader.read_to_string(&mut rest).unwrap();
        assert!(rest.contains("\"llo\"") && rest.contains("[DONE]"), "{rest}");
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn a_silent_client_loses_its_connection_slot() {
        let (_go_tx, go) = mpsc::channel();
        let up = fake_model_server(go);
        let base = tmp("lr-slow");
        let data = DataDir(base.join("d"));
        data.ensure().unwrap();
        let mut cfg = data.config().unwrap();
        cfg.local_runtime.upstream = Some(format!("http://{up}/v1"));
        crate::util::write_json(&data.config_path(), &cfg, false).unwrap();
        let mut rt = Runtime::new(&data).unwrap();
        rt.client_timeout = Duration::from_millis(200);
        let rt = Arc::new(rt);
        let on = rt.start().unwrap();
        // Connections that never send a request: each holds a slot until the timeout.
        let idle: Vec<_> = (0..3).map(|_| std::os::unix::net::UnixStream::connect(on.socket.as_ref().unwrap()).unwrap()).collect();
        let t0 = std::time::Instant::now();
        while rt.active.load(Ordering::SeqCst) < 3 && t0.elapsed() < Duration::from_secs(2) {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(rt.active.load(Ordering::SeqCst), 3);
        for mut c in idle {
            c.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut buf = Vec::new();
            let _ = c.read_to_end(&mut buf); // closed by the runtime, not by the client
        }
        assert!(t0.elapsed() < Duration::from_secs(4));
        let t1 = std::time::Instant::now();
        while rt.active.load(Ordering::SeqCst) > 0 && t1.elapsed() < Duration::from_secs(2) {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(rt.active.load(Ordering::SeqCst), 0, "every slot is back");
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn a_users_own_socket_has_the_same_admission() {
        use crate::user_socket::{Account, UserSockets, Users, layout};
        use std::os::unix::fs::MetadataExt;
        struct Me(Account);
        impl Users for Me {
            fn lookup(&self, name: &str) -> Option<Account> {
                (name == "alice").then(|| self.0.clone())
            }
        }
        let (_go_tx, go) = mpsc::channel();
        let up = fake_model_server(go);
        let (rt, _on, base) = runtime(&format!("http://{up}/v1"), false);
        let m = std::fs::metadata(&base).unwrap();
        let me = Account { uid: m.uid(), gid: m.gid(), home: base.join("home") };
        let run_root = base.join("run-user");
        let l = layout(&me, &run_root, false);
        std::fs::create_dir_all(&l.anchor).unwrap();
        let us = rt.user_sockets(UserSockets::new(vec!["alice".into()], Box::new(Me(me)), run_root, false, rt.socket_server()));
        us.recheck();
        assert_eq!(rt.op("status", &json!({})).unwrap()["users"][0]["socket"], json!(l.socket));
        let ask = || {
            let mut s = std::os::unix::net::UnixStream::connect(&l.socket).unwrap();
            s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            s.write_all(b"GET /v1/models HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n").unwrap();
            let mut out = String::new();
            let _ = s.read_to_string(&mut out);
            out
        };
        // No token on a user's socket (its mode is the authentication), the Hub's grant still.
        assert!(ask().contains("scope_missing"));
        rt.data.save_granted_scopes(&[SCOPE.into()]).unwrap();
        let ok = ask();
        assert!(ok.starts_with("HTTP/1.1 200") && ok.contains("qwen3:8b"), "{ok}");
        us.stop();
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn refuses_bad_settings_and_reports_a_server_that_is_down() {
        let base = tmp("lr-bad");
        let data = DataDir(base.join("d"));
        data.ensure().unwrap();
        let set = |c: LocalRuntimeConfig| {
            let mut cfg = data.config().unwrap();
            cfg.local_runtime = c;
            crate::util::write_json(&data.config_path(), &cfg, false).unwrap();
        };
        set(LocalRuntimeConfig { upstream: Some("https://models.example/v1".into()), ..Default::default() });
        assert!(Runtime::new(&data).err().unwrap().message.contains("http://"));
        set(LocalRuntimeConfig { listen: Some("0.0.0.0:7421".into()), ..Default::default() });
        assert!(Runtime::new(&data).err().unwrap().message.contains("loopback"));
        set(LocalRuntimeConfig::default());
        assert_eq!(Runtime::new(&data).unwrap().upstream, DEFAULT_UPSTREAM);
        // Nothing listens on port 1: models and requests say the server is down.
        let (rt, on, base2) = runtime("http://127.0.0.1:1/v1", true);
        assert_eq!(rt.op("models", &json!({})).unwrap_err().code, "node_unavailable");
        rt.data.save_granted_scopes(&[SCOPE.into()]).unwrap();
        let token = std::fs::read_to_string(token_path(&rt.data)).unwrap();
        let r = send(on.loopback.unwrap(), &get(on.loopback.unwrap().port(), &format!("Authorization: Bearer {token}\r\n")));
        assert!(r.starts_with("HTTP/1.1 502"), "{r}");
        assert_eq!(rt.op("nope", &json!({})).unwrap_err().code, "not_found");
        std::fs::remove_dir_all(&base).unwrap();
        std::fs::remove_dir_all(&base2).unwrap();
    }
}
