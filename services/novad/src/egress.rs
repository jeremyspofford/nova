//! The egress filter of a local browser session (FR-209, docs/11 §4.6): one HTTP proxy on loopback
//! per session, the only way that session's Chromium reaches the network (`--proxy-server`).
//!
//! - CONNECT `host:port` and absolute-URI `http://` requests only; anything else is 400. Only
//!   ports 80 and 443 (a site's web ports; the filter is for a browser on web pages).
//! - Only hosts on the session's allowlist: exact names, and `*.name` for the names under it (not
//!   `name` itself), as the Hub's egress policy matches them. IP literals are refused whatever the
//!   list says, and a name is refused before it is looked up.
//! - novad resolves the name itself and refuses it when any address it gets is private, loopback,
//!   link-local, multicast, unspecified, carrier-grade NAT, unique-local or reserved; IPv4-mapped,
//!   NAT64 and 6to4 addresses are judged by the IPv4 address they carry. So a page cannot reach
//!   this device's LAN through a public name (the device's LAN is not the site). It connects to
//!   the address it checked, never to a second lookup.
//! - No TLS inspection: a CONNECT tunnel carries the browser's TLS untouched.
//! - Bounded: at most 64 connections at a time, 30 s for a request head, and a connection with no
//!   bytes either way for 5 minutes is closed. Stopping the filter closes every connection.
//! - It logs the host and the decision (each refusal, the first allow per host), never a URL, and
//!   counts what it allowed and refused; the counts go back to the Hub when the session closes.
//!
//! The listener is reachable by every local process, like any loopback port, and has no token:
//! Chromium cannot present proxy credentials without a prompt. It grants nothing a local process
//! does not already have (it only reaches public addresses of the listed hosts), so it is a
//! narrowing of the device's own network access, not an authority.

use crate::util::{OpError, OpResult};
use std::collections::{HashMap, HashSet};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{IpAddr, Ipv4Addr, Shutdown, SocketAddr, TcpListener, TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const MAX_HEAD: u64 = 16 * 1024;
const MAX_HEADERS: usize = 64;
/// At most this many allowlist entries per session.
pub const MAX_HOSTS: usize = 200;

/// Name resolution (tests map names to fixed addresses; never the real DNS in tests).
pub type Resolve = Arc<dyn Fn(&str, u16) -> io::Result<Vec<SocketAddr>> + Send + Sync>;
/// Opening the upstream connection (tests send a checked public address to a loopback server).
pub type Dial = Arc<dyn Fn(SocketAddr, Duration) -> io::Result<TcpStream> + Send + Sync>;

#[derive(Clone)]
pub struct Options {
    pub resolve: Resolve,
    pub dial: Dial,
    pub max_connections: usize,
    pub head_timeout: Duration,
    pub idle_timeout: Duration,
    pub connect_timeout: Duration,
}

impl Default for Options {
    fn default() -> Self {
        Options {
            resolve: Arc::new(|host: &str, port: u16| (host, port).to_socket_addrs().map(|a| a.collect())),
            dial: Arc::new(|addr: SocketAddr, t: Duration| TcpStream::connect_timeout(&addr, t)),
            max_connections: 64,
            head_timeout: Duration::from_secs(30),
            idle_timeout: Duration::from_secs(300),
            connect_timeout: Duration::from_secs(10),
        }
    }
}

/// What the filter decided, by count.
#[derive(Debug, Default)]
pub struct Counts {
    pub allowed: AtomicU64,
    pub refused: AtomicU64,
}

/// One running filter.
pub struct Filter {
    addr: SocketAddr,
    stop: Arc<AtomicBool>,
    counts: Arc<Counts>,
    open: Arc<Mutex<HashMap<u64, Vec<TcpStream>>>>,
}

struct Ctx {
    allow: Vec<String>,
    label: String,
    opts: Options,
    counts: Arc<Counts>,
    logged: Mutex<HashSet<String>>,
}

/// A host pattern for the allowlist, normalized (lower case, no trailing dot), or why not: a DNS
/// name or `*.name` with at least two labels after the star; never `*`, an IP literal or a name
/// whose last label has no letter (numeric hosts are how IP literals hide).
pub fn check_pattern(p: &str) -> Result<String, String> {
    let n = p.trim().to_ascii_lowercase();
    let n = n.strip_suffix('.').unwrap_or(&n).to_string();
    if n == "*" {
        return Err("a bare * is not allowed: name the hosts".into());
    }
    let (wild, name) = match n.strip_prefix("*.") {
        Some(rest) => (true, rest),
        None => (false, n.as_str()),
    };
    if wild && name.split('.').count() < 2 {
        return Err(format!("a wildcard cannot cover a whole top-level domain: {p}"));
    }
    if !valid_name(name) {
        return Err(format!("not a host name: {p}"));
    }
    Ok(n)
}

/// A DNS name a request may name: letters, digits, `-` and `_` in labels of 1 to 63, at most 253
/// in all, and a last label with a letter in it.
pub fn valid_name(h: &str) -> bool {
    if h.is_empty() || h.len() > 253 {
        return false;
    }
    let labels: Vec<&str> = h.split('.').collect();
    let ok = labels.iter().all(|l| !l.is_empty() && l.len() <= 63 && !l.starts_with('-') && !l.ends_with('-') && l.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'));
    ok && labels.last().is_some_and(|l| l.bytes().any(|b| b.is_ascii_alphabetic()))
}

/// Whether `host` (normalized) is on the list: an exact entry, or under a `*.name` entry.
pub fn allowed(patterns: &[String], host: &str) -> bool {
    patterns.iter().any(|p| match p.strip_prefix("*.") {
        Some(d) => host.len() > d.len() + 1 && host.ends_with(d) && host.as_bytes()[host.len() - d.len() - 1] == b'.',
        None => p == host,
    })
}

/// The class of an address: `public`, or why it is not a site on the internet.
pub fn classify(ip: IpAddr) -> &'static str {
    match ip {
        IpAddr::V4(v4) => classify_v4(v4),
        IpAddr::V6(v6) => {
            let g = v6.segments();
            let embedded = |hi: u16, lo: u16| Ipv4Addr::new((hi >> 8) as u8, hi as u8, (lo >> 8) as u8, lo as u8);
            if g == [0; 8] {
                "unspecified"
            } else if g[..7] == [0; 7] && g[7] == 1 {
                "loopback"
            } else if g[..5] == [0; 5] && g[5] == 0xffff {
                // IPv4-mapped (::ffff:a.b.c.d).
                classify_v4(embedded(g[6], g[7]))
            } else if g[..6] == [0; 6] {
                // IPv4-compatible (deprecated) and other low addresses.
                "reserved"
            } else if g[0] == 0x64 && g[1] == 0xff9b && g[2..6] == [0; 4] {
                // NAT64 (64:ff9b::a.b.c.d) reaches the IPv4 address it carries.
                classify_v4(embedded(g[6], g[7]))
            } else if g[0] == 0x2002 {
                // 6to4 (2002:aabb:ccdd::) carries an IPv4 address in its next 32 bits.
                classify_v4(embedded(g[1], g[2]))
            } else if (g[0] == 0x2001 && g[1] == 0) || (g[0] == 0x2001 && g[1] == 0x0db8) || (g[0] == 0x64 && g[1] == 0xff9b) {
                // Teredo, documentation, local-use NAT64.
                "reserved"
            } else if (g[0] & 0xfe00) == 0xfc00 {
                "unique_local"
            } else if (g[0] & 0xffc0) == 0xfe80 {
                "link_local"
            } else if (g[0] & 0xffc0) == 0xfec0 {
                "private"
            } else if (g[0] & 0xff00) == 0xff00 {
                "multicast"
            } else if (g[0] & 0xe000) != 0x2000 {
                // Only 2000::/3 is global unicast.
                "reserved"
            } else {
                "public"
            }
        }
    }
}

fn classify_v4(ip: Ipv4Addr) -> &'static str {
    let [a, b, c, _] = ip.octets();
    match (a, b, c) {
        (0, _, _) => "unspecified",
        (10, _, _) => "private",
        (127, _, _) => "loopback",
        (169, 254, _) => "link_local",
        (172, 16..=31, _) => "private",
        (192, 168, _) => "private",
        (100, 64..=127, _) => "cgnat",
        (224..=239, _, _) => "multicast",
        (240..=255, _, _) => "reserved",
        // Protocol assignments, documentation, benchmarking and the 6to4 relay: never a site.
        (192, 0, 0) | (192, 0, 2) | (192, 88, 99) | (198, 51, 100) | (203, 0, 113) | (198, 18..=19, _) => "reserved",
        _ => "public",
    }
}

impl Filter {
    /// Listen on 127.0.0.1 (a free port) for one session. `label` names the session in the log.
    pub fn start(allow: Vec<String>, label: &str, opts: Options) -> OpResult<Filter> {
        let mut list = Vec::new();
        for p in &allow {
            list.push(check_pattern(p).map_err(OpError::validation)?);
        }
        if list.len() > MAX_HOSTS {
            return Err(OpError::validation(format!("at most {MAX_HOSTS} hosts per session")));
        }
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let addr = listener.local_addr()?;
        listener.set_nonblocking(true)?;
        let stop = Arc::new(AtomicBool::new(false));
        let counts = Arc::new(Counts::default());
        let open: Arc<Mutex<HashMap<u64, Vec<TcpStream>>>> = Arc::new(Mutex::new(HashMap::new()));
        let ctx = Arc::new(Ctx { allow: list, label: label.to_string(), opts, counts: counts.clone(), logged: Mutex::new(HashSet::new()) });
        let (flag, reg) = (stop.clone(), open.clone());
        let active = Arc::new(AtomicUsize::new(0));
        let next = AtomicU64::new(1);
        std::thread::Builder::new()
            .name("novad-egress".into())
            .spawn(move || {
                while !flag.load(Ordering::SeqCst) {
                    let conn = match listener.accept() {
                        Ok((c, _)) => c,
                        Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                            std::thread::sleep(Duration::from_millis(20));
                            continue;
                        }
                        Err(_) => {
                            std::thread::sleep(Duration::from_millis(20));
                            continue;
                        }
                    };
                    let _ = conn.set_nonblocking(false);
                    if active.fetch_add(1, Ordering::SeqCst) >= ctx.opts.max_connections {
                        active.fetch_sub(1, Ordering::SeqCst);
                        ctx.counts.refused.fetch_add(1, Ordering::SeqCst);
                        let mut c = conn;
                        let _ = c.set_write_timeout(Some(Duration::from_secs(2)));
                        let _ = respond(&mut c, 503, "too many connections through this session's filter");
                        continue;
                    }
                    let id = next.fetch_add(1, Ordering::SeqCst);
                    if let (Ok(c), Ok(mut r)) = (conn.try_clone(), reg.lock()) {
                        r.insert(id, vec![c]);
                    }
                    let (ctx, reg, active, flag) = (ctx.clone(), reg.clone(), active.clone(), flag.clone());
                    std::thread::spawn(move || {
                        if !flag.load(Ordering::SeqCst) {
                            serve(conn, &ctx, id, &reg);
                        }
                        if let Ok(mut r) = reg.lock() {
                            r.remove(&id);
                        }
                        active.fetch_sub(1, Ordering::SeqCst);
                    });
                }
            })
            .map_err(|e| OpError::internal(format!("the egress filter did not start: {e}")))?;
        Ok(Filter { addr, stop, counts, open })
    }

    pub fn port(&self) -> u16 {
        self.addr.port()
    }

    /// (allowed, refused) so far.
    pub fn counts(&self) -> (u64, u64) {
        (self.counts.allowed.load(Ordering::SeqCst), self.counts.refused.load(Ordering::SeqCst))
    }

    /// Stop listening and close every connection; the final counts.
    pub fn stop(&self) -> (u64, u64) {
        self.stop.store(true, Ordering::SeqCst);
        if let Ok(mut r) = self.open.lock() {
            for (_, streams) in r.drain() {
                for s in streams {
                    let _ = s.shutdown(Shutdown::Both);
                }
            }
        }
        self.counts()
    }
}

impl Drop for Filter {
    fn drop(&mut self) {
        self.stop();
    }
}

/// A request head as received.
struct Head {
    method: String,
    target: String,
    headers: Vec<(String, String)>,
}

fn read_head<R: BufRead>(r: &mut R) -> Result<Option<Head>, String> {
    let mut limited = r.take(MAX_HEAD);
    let mut line = Vec::new();
    let mut lines: Vec<String> = Vec::new();
    loop {
        line.clear();
        let n = limited.read_until(b'\n', &mut line).map_err(|e| e.to_string())?;
        if n == 0 {
            if lines.is_empty() {
                return Ok(None);
            }
            return Err("the request head is incomplete or too large".into());
        }
        if line.last() != Some(&b'\n') {
            return Err("the request head is too large".into());
        }
        let text = String::from_utf8(line.clone()).map_err(|_| "the request head is not text".to_string())?;
        let text = text.trim_end_matches(['\r', '\n']).to_string();
        if text.is_empty() {
            if lines.is_empty() {
                continue;
            }
            break;
        }
        if text.bytes().any(|b| (b < 0x20 && b != b'\t') || b == 0x7f) {
            return Err("control characters in the request head".into());
        }
        lines.push(text);
        if lines.len() > MAX_HEADERS + 1 {
            return Err("too many headers".into());
        }
    }
    let mut parts = lines[0].split(' ');
    let (Some(method), Some(target), Some(version), None) = (parts.next(), parts.next(), parts.next(), parts.next()) else {
        return Err("malformed request line".into());
    };
    if method.is_empty() || !method.bytes().all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b)) || !matches!(version, "HTTP/1.1" | "HTTP/1.0") {
        return Err("malformed request line".into());
    }
    let mut headers = Vec::new();
    for l in &lines[1..] {
        let (n, v) = l.split_once(':').ok_or("a header line has no colon")?;
        if n.is_empty() || n.bytes().any(|b| b == b' ' || b == b'\t') {
            return Err("invalid header name".into());
        }
        headers.push((n.to_ascii_lowercase(), v.trim().to_string()));
    }
    Ok(Some(Head { method: method.to_string(), target: target.to_string(), headers }))
}

/// Where a request goes: host (normalized), port, and for an absolute-URI request the path.
struct Target {
    host: String,
    port: u16,
    path: Option<String>,
}

fn split_authority(auth: &str, default_port: Option<u16>) -> Result<(String, u16), String> {
    if auth.is_empty() || auth.contains('@') {
        return Err("invalid authority".into());
    }
    let (host, port) = if let Some(inner) = auth.strip_prefix('[') {
        let (h, rest) = inner.split_once(']').ok_or("unclosed [ in the authority")?;
        (h.to_string(), rest.strip_prefix(':').map(str::to_string))
    } else {
        match auth.rsplit_once(':') {
            Some((h, p)) if !h.contains(':') => (h.to_string(), Some(p.to_string())),
            Some(_) => (auth.to_string(), None),
            None => (auth.to_string(), None),
        }
    };
    let port = match (port, default_port) {
        (Some(p), _) => p.parse::<u16>().ok().filter(|p| *p != 0).ok_or("invalid port")?,
        (None, Some(d)) => d,
        (None, None) => return Err("CONNECT needs host:port".into()),
    };
    let host = host.to_ascii_lowercase();
    let host = host.strip_suffix('.').unwrap_or(&host).to_string();
    Ok((host, port))
}

fn parse_target(h: &Head) -> Result<Target, String> {
    if h.method == "CONNECT" {
        let (host, port) = split_authority(&h.target, None)?;
        return Ok(Target { host, port, path: None });
    }
    let lower = h.target.get(..7).map(|s| s.to_ascii_lowercase());
    if lower.as_deref() != Some("http://") {
        return Err("only CONNECT and absolute http:// requests pass this proxy".into());
    }
    let rest = &h.target[7..];
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (auth, tail) = rest.split_at(end);
    let (host, port) = split_authority(auth, Some(80))?;
    let tail = tail.split('#').next().unwrap_or_default();
    let path = if tail.starts_with('/') { tail.to_string() } else { format!("/{tail}") };
    Ok(Target { host, port, path: Some(path) })
}

/// The ports a session's browser may reach.
pub const PORTS: [u16; 2] = [80, 443];

/// The policy decision: the checked addresses, or the reason for refusing.
fn decide(ctx: &Ctx, host: &str, port: u16) -> Result<Vec<SocketAddr>, &'static str> {
    if !PORTS.contains(&port) {
        return Err("port_not_allowed");
    }
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    if bare.parse::<IpAddr>().is_ok() {
        return Err("ip_literal");
    }
    if !valid_name(bare) {
        return Err("invalid_host");
    }
    if !allowed(&ctx.allow, bare) {
        return Err("not_allowed");
    }
    let addrs = (ctx.opts.resolve)(bare, port).map_err(|_| "dns_failed")?;
    if addrs.is_empty() {
        return Err("dns_failed");
    }
    // Any address that is not public blocks the name (a rebinding answer cannot slip through).
    if addrs.iter().any(|a| classify(a.ip()) != "public") {
        return Err("private_address");
    }
    Ok(addrs)
}

fn respond(w: &mut impl Write, status: u16, msg: &str) -> io::Result<()> {
    let reason = match status {
        400 => "Bad Request",
        403 => "Forbidden",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        _ => "Error",
    };
    let body = format!("Nova egress filter: {msg}\n");
    write!(w, "HTTP/1.1 {status} {reason}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())?;
    w.flush()
}

fn refuse_text(reason: &str, host: &str) -> String {
    match reason {
        "ip_literal" => "addresses are not allowed, only the session's host names".into(),
        "not_allowed" => format!("{host} is not on this session's list"),
        "private_address" => format!("{host} resolves to a private or local address"),
        "dns_failed" => format!("{host} did not resolve"),
        "port_not_allowed" => "only ports 80 and 443 are allowed".into(),
        _ => format!("{host} is not a valid host name"),
    }
}

fn serve(client: TcpStream, ctx: &Ctx, id: u64, reg: &Mutex<HashMap<u64, Vec<TcpStream>>>) {
    let _ = client.set_read_timeout(Some(ctx.opts.head_timeout));
    let _ = client.set_write_timeout(Some(Duration::from_secs(30)));
    let Ok(read_half) = client.try_clone() else { return };
    let mut reader = BufReader::with_capacity(MAX_HEAD as usize, read_half);
    let mut out = &client;
    let head = match read_head(&mut reader) {
        Ok(Some(h)) => h,
        Ok(None) => return,
        Err(e) => {
            ctx.counts.refused.fetch_add(1, Ordering::SeqCst);
            let _ = respond(&mut out, 400, &e);
            return;
        }
    };
    let target = match parse_target(&head) {
        Ok(t) => t,
        Err(e) => {
            ctx.counts.refused.fetch_add(1, Ordering::SeqCst);
            let _ = respond(&mut out, 400, &e);
            return;
        }
    };
    let addrs = match decide(ctx, &target.host, target.port) {
        Ok(a) => a,
        Err(reason) => {
            ctx.counts.refused.fetch_add(1, Ordering::SeqCst);
            eprintln!("novad browser {}: egress {} refused ({reason})", ctx.label, target.host);
            let status = if reason == "dns_failed" { 502 } else { 403 };
            let _ = respond(&mut out, status, &refuse_text(reason, &target.host));
            return;
        }
    };
    ctx.counts.allowed.fetch_add(1, Ordering::SeqCst);
    if ctx.logged.lock().map(|mut l| l.insert(target.host.clone())).unwrap_or(false) {
        eprintln!("novad browser {}: egress {} allowed", ctx.label, target.host);
    }
    let Some(upstream) = addrs.iter().find_map(|a| (ctx.opts.dial)(*a, ctx.opts.connect_timeout).ok()) else {
        let _ = respond(&mut out, 502, &format!("{} did not answer", target.host));
        return;
    };
    if let (Ok(c), Ok(mut r)) = (upstream.try_clone(), reg.lock()) {
        r.entry(id).or_default().push(c);
    }
    let mut up = &upstream;
    let sent = match &target.path {
        None => out.write_all(b"HTTP/1.1 200 Connection established\r\n\r\n").and_then(|_| out.flush()),
        Some(path) => up.write_all(forward_head(&head, &target, path).as_bytes()),
    };
    // Bytes the client sent after the head belong to the upstream (a body, an early TLS hello).
    let rest = reader.buffer().to_vec();
    if sent.is_err() || (!rest.is_empty() && up.write_all(&rest).is_err()) {
        let _ = upstream.shutdown(Shutdown::Both);
        return;
    }
    drop(reader);
    tunnel(client, upstream, ctx.opts.idle_timeout);
}

/// The head an absolute-URI request goes upstream with: origin-form, the URI's authority as Host,
/// no hop-by-hop or proxy headers, one request per connection.
fn forward_head(h: &Head, t: &Target, path: &str) -> String {
    let hop: Vec<String> = h.headers.iter().filter(|(n, _)| n == "connection").flat_map(|(_, v)| v.split(',').map(|s| s.trim().to_ascii_lowercase())).collect();
    let mut out = format!("{} {path} HTTP/1.1\r\n", h.method);
    let authority = if t.host.contains(':') { format!("[{}]", t.host) } else { t.host.clone() };
    out.push_str(&if t.port == 80 { format!("Host: {authority}\r\n") } else { format!("Host: {authority}:{}\r\n", t.port) });
    for (n, v) in &h.headers {
        let skip = matches!(n.as_str(), "host" | "connection" | "keep-alive" | "proxy-connection" | "proxy-authorization" | "proxy-authenticate" | "te" | "trailer" | "upgrade") || hop.contains(n);
        if !skip {
            out.push_str(&format!("{n}: {v}\r\n"));
        }
    }
    out.push_str("Connection: close\r\n\r\n");
    out
}

/// Copy both ways until either side closes, or nothing moved for `idle`.
fn tunnel(a: TcpStream, b: TcpStream, idle: Duration) {
    let tick = idle.min(Duration::from_secs(1)).max(Duration::from_millis(10));
    let _ = a.set_read_timeout(Some(tick));
    let _ = b.set_read_timeout(Some(tick));
    let start = Instant::now();
    let last = Arc::new(AtomicU64::new(0));
    let (Ok(a2), Ok(b2)) = (a.try_clone(), b.try_clone()) else { return };
    let l2 = last.clone();
    let t = std::thread::spawn(move || copy(a2, b2, &l2, start, idle));
    copy(b, a, &last, start, idle);
    let _ = t.join();
}

fn copy(mut from: TcpStream, mut to: TcpStream, last: &AtomicU64, start: Instant, idle: Duration) {
    let mut buf = vec![0u8; 32 * 1024];
    loop {
        match from.read(&mut buf) {
            Ok(0) => {
                // Half-close: the other side sees the end and may still answer.
                let _ = to.shutdown(Shutdown::Write);
                return;
            }
            Ok(n) => {
                last.store(start.elapsed().as_millis() as u64, Ordering::SeqCst);
                if to.write_all(&buf[..n]).is_err() {
                    break;
                }
            }
            Err(e) if matches!(e.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut) => {
                let quiet = (start.elapsed().as_millis() as u64).saturating_sub(last.load(Ordering::SeqCst));
                if quiet >= idle.as_millis() as u64 {
                    break;
                }
            }
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(_) => break,
        }
    }
    let _ = from.shutdown(Shutdown::Both);
    let _ = to.shutdown(Shutdown::Both);
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::net::SocketAddrV4;

    /// A public documentation-free address the tests' resolver hands out (never dialed: the
    /// test dialer sends it to a loopback server).
    pub const PUBLIC: Ipv4Addr = Ipv4Addr::new(93, 184, 216, 34);

    /// A loopback server that answers each connection with what it received first (up to the
    /// end of a request head) and then echoes everything else.
    pub fn echo_server() -> SocketAddr {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        std::thread::spawn(move || {
            for c in l.incoming().flatten() {
                std::thread::spawn(move || {
                    let mut c = c;
                    let mut buf = [0u8; 8192];
                    loop {
                        match c.read(&mut buf) {
                            Ok(0) | Err(_) => break,
                            Ok(n) => {
                                if c.write_all(&buf[..n]).is_err() {
                                    break;
                                }
                            }
                        }
                    }
                });
            }
        });
        addr
    }

    /// Options whose resolver knows a few names and whose dialer sends the public address to
    /// `upstream`; `lookups` counts resolver calls.
    pub fn fake(upstream: SocketAddr, lookups: Arc<AtomicUsize>) -> Options {
        Options {
            resolve: Arc::new(move |host: &str, port: u16| {
                lookups.fetch_add(1, Ordering::SeqCst);
                let v4 = |ip: Ipv4Addr| SocketAddr::V4(SocketAddrV4::new(ip, port));
                Ok(match host {
                    "allowed.test" | "a.wild.test" | "deep.a.wild.test" => vec![v4(PUBLIC)],
                    "lan.test" => vec![v4(Ipv4Addr::new(192, 168, 1, 10))],
                    "mixed.test" => vec![v4(PUBLIC), v4(Ipv4Addr::new(10, 0, 0, 1))],
                    "mapped.test" => vec![SocketAddr::new("::ffff:127.0.0.1".parse().unwrap(), port)],
                    _ => return Err(io::Error::new(io::ErrorKind::NotFound, "no such host")),
                })
            }),
            dial: Arc::new(move |addr: SocketAddr, t: Duration| {
                assert_eq!(addr.ip(), IpAddr::V4(PUBLIC), "only checked public addresses are dialed");
                TcpStream::connect_timeout(&upstream, t)
            }),
            max_connections: 64,
            head_timeout: Duration::from_secs(5),
            idle_timeout: Duration::from_secs(5),
            connect_timeout: Duration::from_secs(5),
        }
    }

    fn list() -> Vec<String> {
        vec!["allowed.test".into(), "*.wild.test".into(), "lan.test".into(), "mixed.test".into(), "mapped.test".into(), "gone.test".into()]
    }

    fn send(port: u16, raw: &str) -> TcpStream {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        s.write_all(raw.as_bytes()).unwrap();
        s
    }

    fn head_of(s: &mut TcpStream) -> String {
        let mut out = Vec::new();
        let mut b = [0u8; 1];
        while !out.ends_with(b"\r\n\r\n") {
            match s.read(&mut b) {
                Ok(1) => out.push(b[0]),
                _ => break,
            }
        }
        String::from_utf8_lossy(&out).to_string()
    }

    fn all_of(mut s: TcpStream) -> String {
        let mut out = String::new();
        let _ = s.read_to_string(&mut out);
        out
    }

    #[test]
    fn tunnels_to_an_allowed_host_only() {
        let up = echo_server();
        let lookups = Arc::new(AtomicUsize::new(0));
        let f = Filter::start(list(), "t1", fake(up, lookups.clone())).unwrap();
        let p = f.port();
        // CONNECT to a listed host: 200, then bytes pass both ways untouched (no inspection).
        let mut s = send(p, "CONNECT allowed.test:443 HTTP/1.1\r\nHost: allowed.test:443\r\n\r\n");
        assert!(head_of(&mut s).starts_with("HTTP/1.1 200"));
        s.write_all(b"\x16\x03\x01hello").unwrap();
        let mut got = [0u8; 8];
        s.read_exact(&mut got).unwrap();
        assert_eq!(&got, b"\x16\x03\x01hello");
        drop(s);
        // A name under a wildcard passes; the wildcard's own name does not.
        let mut s = send(p, "CONNECT deep.a.wild.test:443 HTTP/1.1\r\n\r\n");
        assert!(head_of(&mut s).starts_with("HTTP/1.1 200"));
        drop(s);
        let before = lookups.load(Ordering::SeqCst);
        let r = all_of(send(p, "CONNECT wild.test:443 HTTP/1.1\r\n\r\n"));
        assert!(r.starts_with("HTTP/1.1 403") && r.contains("not on this session's list"), "{r}");
        // Unlisted: refused before any lookup.
        let r = all_of(send(p, "CONNECT unlisted.test:443 HTTP/1.1\r\n\r\n"));
        assert!(r.starts_with("HTTP/1.1 403"), "{r}");
        assert_eq!(lookups.load(Ordering::SeqCst), before, "a refused name is never looked up");
        // IP literals, whatever the list says.
        for t in ["93.184.216.34:443", "[::1]:443", "127.0.0.1:80", "[::ffff:10.0.0.1]:443"] {
            let r = all_of(send(p, &format!("CONNECT {t} HTTP/1.1\r\n\r\n")));
            assert!(r.starts_with("HTTP/1.1 403") && r.contains("addresses are not allowed"), "{t}: {r}");
        }
        // Numeric names are refused as hosts.
        assert!(all_of(send(p, "CONNECT 2130706433:80 HTTP/1.1\r\n\r\n")).starts_with("HTTP/1.1 403"));
        // A listed name that resolves to the LAN, to a mix, or to a mapped loopback address.
        for h in ["lan.test", "mixed.test", "mapped.test"] {
            let r = all_of(send(p, &format!("CONNECT {h}:443 HTTP/1.1\r\n\r\n")));
            assert!(r.starts_with("HTTP/1.1 403") && r.contains("private or local"), "{h}: {r}");
        }
        // A listed name that does not resolve.
        assert!(all_of(send(p, "CONNECT gone.test:443 HTTP/1.1\r\n\r\n")).starts_with("HTTP/1.1 502"));
        let (allowed, refused) = f.stop();
        assert_eq!((allowed, refused), (2, 11));
    }

    #[test]
    fn forwards_absolute_http_requests_in_origin_form() {
        let up = echo_server();
        let f = Filter::start(list(), "t2", fake(up, Arc::new(AtomicUsize::new(0)))).unwrap();
        // The echo server sends back the request the filter forwarded.
        let mut s = send(
            f.port(),
            "GET http://allowed.test/a/b?c=1 HTTP/1.1\r\nHost: evil.test\r\nProxy-Connection: keep-alive\r\nProxy-Authorization: Basic eA==\r\nConnection: keep-alive, X-Drop\r\nX-Drop: 1\r\nAccept: */*\r\n\r\n",
        );
        let fwd = head_of(&mut s);
        assert!(fwd.starts_with("GET /a/b?c=1 HTTP/1.1\r\nHost: allowed.test\r\n"), "{fwd}");
        assert!(fwd.contains("accept: */*\r\n") && fwd.ends_with("Connection: close\r\n\r\n"), "{fwd}");
        assert!(!fwd.contains("evil.test") && !fwd.to_ascii_lowercase().contains("proxy-") && !fwd.contains("x-drop"), "{fwd}");
        drop(s);
        // Port 443 stays in the Host header; other ports are refused.
        let mut s = send(f.port(), "POST http://allowed.test:443/x HTTP/1.1\r\nContent-Length: 2\r\n\r\nhi");
        let fwd = head_of(&mut s);
        assert!(fwd.starts_with("POST /x HTTP/1.1\r\nHost: allowed.test:443\r\n"), "{fwd}");
        let mut body = [0u8; 2];
        s.read_exact(&mut body).unwrap();
        assert_eq!(&body, b"hi", "the body follows the head");
        drop(s);
        // Anything but CONNECT and absolute http:// is refused.
        for raw in ["GET / HTTP/1.1\r\nHost: allowed.test\r\n\r\n", "GET https://allowed.test/ HTTP/1.1\r\n\r\n", "GET http://user@allowed.test/ HTTP/1.1\r\n\r\n", "BAD\r\n\r\n", "CONNECT allowed.test HTTP/1.1\r\n\r\n"] {
            let r = all_of(send(f.port(), raw));
            assert!(r.starts_with("HTTP/1.1 400"), "{raw:?}: {r}");
        }
        assert!(all_of(send(f.port(), "GET http://lan.test/ HTTP/1.1\r\n\r\n")).starts_with("HTTP/1.1 403"));
        for raw in ["GET http://allowed.test:8080/ HTTP/1.1\r\n\r\n", "CONNECT allowed.test:22 HTTP/1.1\r\n\r\n", "CONNECT allowed.test:8443 HTTP/1.1\r\n\r\n"] {
            let r = all_of(send(f.port(), raw));
            assert!(r.starts_with("HTTP/1.1 403") && r.contains("ports 80 and 443"), "{raw:?}: {r}");
        }
        assert_eq!(f.stop(), (2, 9));
    }

    #[test]
    fn bounds_connections_idle_tunnels_and_stops() {
        let up = echo_server();
        let mut o = fake(up, Arc::new(AtomicUsize::new(0)));
        o.max_connections = 2;
        o.idle_timeout = Duration::from_millis(300);
        o.head_timeout = Duration::from_millis(300);
        let f = Filter::start(list(), "t3", o).unwrap();
        // Two silent connections hold the slots; the third is turned away.
        let a = TcpStream::connect(("127.0.0.1", f.port())).unwrap();
        let b = TcpStream::connect(("127.0.0.1", f.port())).unwrap();
        std::thread::sleep(Duration::from_millis(100));
        let r = all_of(send(f.port(), "CONNECT allowed.test:443 HTTP/1.1\r\n\r\n"));
        assert!(r.starts_with("HTTP/1.1 503"), "{r}");
        // A head that never arrives loses its slot after the head timeout.
        drop((a, b));
        std::thread::sleep(Duration::from_millis(500));
        // An idle tunnel is closed.
        let mut s = send(f.port(), "CONNECT allowed.test:443 HTTP/1.1\r\n\r\n");
        assert!(head_of(&mut s).starts_with("HTTP/1.1 200"));
        let t0 = Instant::now();
        let mut buf = [0u8; 1];
        assert!(matches!(s.read(&mut buf), Ok(0) | Err(_)));
        assert!(t0.elapsed() < Duration::from_secs(4), "closed after the idle timeout");
        // Stopping closes open tunnels at once.
        let mut o = fake(up, Arc::new(AtomicUsize::new(0)));
        o.idle_timeout = Duration::from_secs(30);
        let g = Filter::start(list(), "t4", o).unwrap();
        let mut s = send(g.port(), "CONNECT allowed.test:443 HTTP/1.1\r\n\r\n");
        assert!(head_of(&mut s).starts_with("HTTP/1.1 200"));
        let t0 = Instant::now();
        g.stop();
        assert!(matches!(s.read(&mut buf), Ok(0) | Err(_)));
        assert!(t0.elapsed() < Duration::from_secs(4));
        assert!(TcpStream::connect(("127.0.0.1", g.port())).and_then(|mut c| {
            c.set_read_timeout(Some(Duration::from_secs(2)))?;
            c.write_all(b"CONNECT allowed.test:443 HTTP/1.1\r\n\r\n")?;
            let mut r = [0u8; 12];
            c.read_exact(&mut r)
        })
        .is_err(), "a stopped filter serves nothing");
    }

    #[test]
    fn classifies_addresses() {
        let c = |s: &str| classify(s.parse().unwrap());
        for (ip, want) in [
            ("8.8.8.8", "public"),
            ("93.184.216.34", "public"),
            ("10.1.2.3", "private"),
            ("172.31.0.1", "private"),
            ("172.32.0.1", "public"),
            ("192.168.0.1", "private"),
            ("127.0.0.53", "loopback"),
            ("169.254.169.254", "link_local"),
            ("100.64.0.1", "cgnat"),
            ("224.0.0.1", "multicast"),
            ("255.255.255.255", "reserved"),
            ("0.0.0.0", "unspecified"),
            ("192.0.2.1", "reserved"),
            ("198.18.0.1", "reserved"),
            ("::", "unspecified"),
            ("::1", "loopback"),
            ("::ffff:127.0.0.1", "loopback"),
            ("::ffff:192.168.1.1", "private"),
            ("::ffff:8.8.8.8", "public"),
            ("::1.2.3.4", "reserved"),
            ("64:ff9b::a00:1", "private"),
            ("64:ff9b::808:808", "public"),
            ("64:ff9b:1::1", "reserved"),
            ("2002:c0a8:101::1", "private"),
            ("2002:808:808::1", "public"),
            ("2001::1", "reserved"),
            ("2001:db8::1", "reserved"),
            ("fd00::1", "unique_local"),
            ("fe80::1", "link_local"),
            ("fec0::1", "private"),
            ("ff02::1", "multicast"),
            ("4000::1", "reserved"),
            ("2606:4700::1111", "public"),
        ] {
            assert_eq!(c(ip), want, "{ip}");
        }
    }

    #[test]
    fn checks_patterns_and_matches_hosts() {
        assert_eq!(check_pattern("Example.COM.").unwrap(), "example.com");
        assert_eq!(check_pattern("*.example.com").unwrap(), "*.example.com");
        for bad in ["*", "*.com", "a.*.com", "ex ample.com", "1.2.3.4", "[::1]", "", "-a.com", "a..com", "123"] {
            assert!(check_pattern(bad).is_err(), "{bad}");
        }
        let l = vec!["example.com".to_string(), "*.wild.org".to_string()];
        assert!(allowed(&l, "example.com"));
        assert!(!allowed(&l, "www.example.com"));
        assert!(allowed(&l, "a.wild.org") && allowed(&l, "b.a.wild.org"));
        assert!(!allowed(&l, "wild.org") && !allowed(&l, "notwild.org") && !allowed(&l, "xwild.org"));
        assert!(Filter::start(vec!["*".into()], "x", Options::default()).is_err());
    }
}
