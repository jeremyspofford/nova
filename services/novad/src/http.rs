//! Minimal HTTP/1.1 for novad's management channel (contracts/hub-api.md §3): a threaded server
//! for JSON requests and a client for http:// URLs and, with a `TlsContext` (src/tls.rs: the
//! pinned Hub identity, its CA and the device certificate), https:// ones (R-023, FR-126).
#![allow(dead_code)]

use serde_json::{Value, json};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{
    IpAddr, Ipv4Addr, Ipv6Addr, Shutdown, SocketAddr, TcpListener, TcpStream, ToSocketAddrs,
};
use std::panic::{self, AssertUnwindSafe};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

/// Request head limits; past either the server answers 431.
const MAX_HEADERS: usize = 64;
const MAX_HEAD_BYTES: usize = 16 * 1024;
/// A stalled peer gives its thread back after this long without a byte.
const READ_TIMEOUT: Duration = Duration::from_secs(30);
/// Bounds on what the client accepts from a server.
const MAX_RESPONSE_BODY: usize = 16 * 1024 * 1024;
const MAX_RESPONSE_HEAD_BYTES: usize = 64 * 1024;
const MAX_RESPONSE_HEADERS: usize = 128;
/// A chunk-size line is a few hex digits; anything long is garbage.
const MAX_CHUNK_LINE: usize = 1024;
/// Thread-per-connection needs a ceiling so a flood cannot exhaust threads; extra
/// connections are closed at accept.
const MAX_CONNECTIONS: usize = 256;
/// After replying, swallow up to this much unread request so closing the socket does not
/// reset the connection before the peer has read the reply.
const DRAIN_BYTES: usize = 256 * 1024;
const DRAIN_TIMEOUT: Duration = Duration::from_secs(2);

/// One parsed HTTP request.
#[derive(Debug, Clone)]
pub struct Request {
    /// The method as received (methods are case-sensitive; the standard ones are uppercase).
    pub method: String,
    /// The path without the query string; percent-decoding is not applied.
    pub path: String,
    /// The text after `?`, empty when there is none.
    pub query: String,
    /// Header names lowercased, values trimmed, in arrival order.
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    pub peer: Option<SocketAddr>,
}

impl Request {
    /// The first header with this name, compared case-insensitively.
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(n, _)| n.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    /// The token of `Authorization: Bearer <token>`, trimmed; None otherwise.
    pub fn bearer(&self) -> Option<&str> {
        let value = self.header("authorization")?.trim();
        let (scheme, token) = value.split_once([' ', '\t'])?;
        if !scheme.eq_ignore_ascii_case("bearer") {
            return None;
        }
        let token = token.trim();
        (!token.is_empty()).then_some(token)
    }

    /// The body as JSON; an empty body reads as an empty object so body-less POSTs work.
    pub fn json(&self) -> Result<Value, String> {
        if self.body.is_empty() {
            return Ok(Value::Object(serde_json::Map::new()));
        }
        serde_json::from_slice(&self.body).map_err(|e| format!("invalid JSON body: {e}"))
    }
}

/// A response to write; framing headers (`Content-Length`, `Connection`) are added on write.
#[derive(Debug, Clone)]
pub struct Response {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Response {
    pub fn json(status: u16, value: &Value) -> Self {
        // Serializing a Value cannot fail: its map keys are always strings.
        let body = serde_json::to_vec(value).unwrap_or_default();
        Self {
            status,
            headers: vec![("content-type".into(), "application/json".into())],
            body,
        }
    }

    /// `{"error":{"code":code,"message":message}}` plus `details` when Some.
    pub fn error(status: u16, code: &str, message: &str, details: Option<Value>) -> Self {
        let mut error = json!({ "code": code, "message": message });
        if let Some(details) = details {
            error["details"] = details;
        }
        Self::json(status, &json!({ "error": error }))
    }
}

pub type Handler = Arc<dyn Fn(Request) -> Response + Send + Sync>;

/// A running server. Dropping it without `stop` leaves the server running.
pub struct ServerHandle {
    addr: SocketAddr,
    stopping: Arc<AtomicBool>,
    accept: JoinHandle<()>,
}

impl ServerHandle {
    pub fn local_addr(&self) -> SocketAddr {
        self.addr
    }

    /// Stop accepting, then join the accept thread. In-flight requests may finish.
    pub fn stop(self) {
        self.stopping.store(true, Ordering::SeqCst);
        // The accept thread is blocked in accept(); a throwaway connection wakes it so it
        // sees the flag and drops the listener.
        let mut wake = self.addr;
        if wake.ip().is_unspecified() {
            wake.set_ip(match wake.ip() {
                IpAddr::V4(_) => IpAddr::V4(Ipv4Addr::LOCALHOST),
                IpAddr::V6(_) => IpAddr::V6(Ipv6Addr::LOCALHOST),
            });
        }
        if TcpStream::connect_timeout(&wake, Duration::from_secs(2)).is_ok() {
            let _ = self.accept.join();
        }
        // Otherwise joining could hang; the thread exits at the next connection it accepts.
    }
}

/// Serve on an already-bound listener: one thread per connection, one request per connection
/// (always replies with `Connection: close`), a 30 s read timeout, request bodies by
/// Content-Length or chunked transfer encoding, at most `max_body` bytes (413 JSON error
/// otherwise), at most 64 headers / 16 KiB of head (431 otherwise); malformed requests get a 400
/// JSON error. A panicking handler yields a 500 JSON error and does not kill the server.
pub fn serve(listener: TcpListener, max_body: usize, handler: Handler) -> ServerHandle {
    let addr = listener
        .local_addr()
        .unwrap_or_else(|_| SocketAddr::from((Ipv4Addr::LOCALHOST, 0)));
    // accept() must block: a non-blocking listener would spin this thread.
    let _ = listener.set_nonblocking(false);
    let stopping = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&stopping);
    let active = Arc::new(AtomicUsize::new(0));
    let accept = thread::Builder::new()
        .name("novad-http-accept".into())
        .spawn(move || {
            for conn in listener.incoming() {
                if flag.load(Ordering::SeqCst) {
                    break;
                }
                let Ok(stream) = conn else {
                    // Typically out of descriptors: back off instead of spinning.
                    thread::sleep(Duration::from_millis(20));
                    continue;
                };
                if active.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
                    active.fetch_sub(1, Ordering::SeqCst);
                    continue;
                }
                let slot = Slot(Arc::clone(&active));
                let handler = Arc::clone(&handler);
                // If the spawn fails the closure is dropped, which closes the stream and
                // frees the slot.
                let _ = thread::Builder::new()
                    .name("novad-http-conn".into())
                    .spawn(move || {
                        let _slot = slot;
                        handle_connection(stream, max_body, &handler);
                    });
            }
        })
        .expect("spawn the HTTP accept thread");
    ServerHandle {
        addr,
        stopping,
        accept,
    }
}

/// Counts a live connection until dropped.
struct Slot(Arc<AtomicUsize>);

impl Drop for Slot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

#[derive(Debug)]
enum ReadError {
    /// The peer closed before sending anything (a probe, or the stop wake-up).
    Closed,
    Io(io::Error),
    Malformed(String),
    HeadTooLarge,
    BodyTooLarge,
}

impl From<io::Error> for ReadError {
    fn from(e: io::Error) -> Self {
        ReadError::Io(e)
    }
}

fn malformed(message: &str) -> ReadError {
    ReadError::Malformed(message.to_string())
}

fn handle_connection(stream: TcpStream, max_body: usize, handler: &Handler) {
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(READ_TIMEOUT));
    let _ = stream.set_write_timeout(Some(READ_TIMEOUT));
    let peer = stream.peer_addr().ok();
    let mut reader = BufReader::new(&stream);
    let mut writer = &stream;
    let (response, head_only) = match read_request(&mut reader, &mut writer, max_body, peer) {
        Ok(request) => {
            let head_only = request.method == "HEAD";
            (call_handler(handler, request), head_only)
        }
        Err(err) => match error_response(&err, max_body) {
            Some(response) => (response, false),
            None => return,
        },
    };
    if write_response(&mut writer, &response, head_only).is_ok() {
        linger_close(&mut reader, &stream);
    }
}

/// One request from a reader (no 100 Continue: the client sends its body after a short wait).
pub(crate) fn read_one_request<R: BufRead>(r: &mut R, max_body: usize) -> Result<Request, String> {
    read_request(r, &mut io::sink(), max_body, None).map_err(|e| match e {
        ReadError::Closed => "closed".to_string(),
        ReadError::Io(e) => e.to_string(),
        ReadError::Malformed(m) => m,
        ReadError::HeadTooLarge => "the request head is too large".into(),
        ReadError::BodyTooLarge => "the request body is too large".into(),
    })
}

/// Write one response; `keep_alive` answers `Connection: keep-alive` instead of `close`.
pub(crate) fn write_one_response<W: Write>(w: &mut W, response: &Response, keep_alive: bool) -> io::Result<()> {
    write_response_with(w, response, false, keep_alive)
}

fn call_handler(handler: &Handler, request: Request) -> Response {
    // Only catches with panic = "unwind"; a binary built with panic = "abort" exits instead.
    match panic::catch_unwind(AssertUnwindSafe(|| handler(request))) {
        Ok(response) => response,
        Err(_) => Response::error(500, "server_error", "the request handler failed", None),
    }
}

fn error_response(err: &ReadError, max_body: usize) -> Option<Response> {
    Some(match err {
        ReadError::Closed => return None,
        ReadError::Io(e) if is_timeout(e) => Response::error(
            400,
            "validation",
            &format!(
                "the request did not arrive within {} s",
                READ_TIMEOUT.as_secs()
            ),
            None,
        ),
        // The peer is gone; there is nobody to answer.
        ReadError::Io(_) => return None,
        ReadError::Malformed(message) => Response::error(400, "validation", message, None),
        ReadError::HeadTooLarge => Response::error(
            431,
            "headers_too_large",
            &format!(
                "the request head exceeds {MAX_HEADERS} headers or {MAX_HEAD_BYTES} bytes"
            ),
            Some(json!({ "maxHeaders": MAX_HEADERS, "maxHeadBytes": MAX_HEAD_BYTES })),
        ),
        ReadError::BodyTooLarge => Response::error(
            413,
            "payload_too_large",
            &format!("the request body exceeds {max_body} bytes"),
            Some(json!({ "maxBytes": max_body })),
        ),
    })
}

/// Half-close, then read and discard what the peer still sends (bounded in bytes and time).
fn linger_close(reader: &mut impl Read, stream: &TcpStream) {
    let _ = stream.shutdown(Shutdown::Write);
    let deadline = Instant::now() + DRAIN_TIMEOUT;
    let mut left = DRAIN_BYTES;
    let mut buf = [0u8; 8192];
    while left > 0 {
        let Some(wait) = time_left(deadline) else {
            break;
        };
        if stream.set_read_timeout(Some(wait)).is_err() {
            break;
        }
        match reader.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => left = left.saturating_sub(n),
        }
    }
}

fn read_request<R: BufRead, W: Write>(
    r: &mut R,
    w: &mut W,
    max_body: usize,
    peer: Option<SocketAddr>,
) -> Result<Request, ReadError> {
    let mut budget = MAX_HEAD_BYTES;
    // Stray blank lines before the request line are tolerated (RFC 9112 §2.2).
    let line = loop {
        match read_line(r, &mut budget)? {
            None => return Err(ReadError::Closed),
            Some(line) if line.is_empty() => continue,
            Some(line) => break line,
        }
    };
    let (method, target, version) = parse_request_line(&line)?;
    let headers = read_headers(r, &mut budget, MAX_HEADERS)?;
    let (path, query) = split_target(&method, &target)?;
    let framing = body_framing(&headers, true)?;
    if let Framing::Length(n) = framing
        && n > max_body
    {
        return Err(ReadError::BodyTooLarge);
    }
    let has_body = matches!(framing, Framing::Chunked | Framing::Length(1..));
    // HTTP/1.0 clients cannot ask for 100 Continue (RFC 9110 §10.1.1).
    let wants_continue = version == "HTTP/1.1"
        && headers
            .iter()
            .any(|(n, v)| n == "expect" && v.eq_ignore_ascii_case("100-continue"));
    if has_body && wants_continue {
        w.write_all(b"HTTP/1.1 100 Continue\r\n\r\n")?;
        w.flush()?;
    }
    let body = match framing {
        // A request without framing headers has no body.
        Framing::Unframed => Vec::new(),
        Framing::Length(n) => read_exact_body(r, n)?,
        Framing::Chunked => read_chunked(r, max_body)?,
    };
    Ok(Request {
        method,
        path,
        query,
        headers,
        body,
        peer,
    })
}

fn parse_request_line(line: &[u8]) -> Result<(String, String, String), ReadError> {
    let text = std::str::from_utf8(line).map_err(|_| malformed("the request line is not ASCII"))?;
    let mut parts = text.split(' ');
    let (Some(method), Some(target), Some(version), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(malformed("malformed request line"));
    };
    if method.is_empty() || !method.bytes().all(is_tchar) {
        return Err(malformed("invalid request method"));
    }
    if target.is_empty() || target.bytes().any(|b| b <= b' ' || b >= 0x7f) {
        return Err(malformed("invalid request target"));
    }
    if version != "HTTP/1.1" && version != "HTTP/1.0" {
        return Err(malformed("unsupported HTTP version"));
    }
    Ok((method.into(), target.into(), version.into()))
}

/// Split the request target into path and query; an absolute-form target keeps only its
/// path and query.
fn split_target(method: &str, target: &str) -> Result<(String, String), ReadError> {
    let origin = if target.starts_with('/') || (target == "*" && method == "OPTIONS") {
        target.to_string()
    } else if let Some(after) =
        strip_prefix_ci(target, "http://").or_else(|| strip_prefix_ci(target, "https://"))
    {
        let rest = &after[after.find(['/', '?']).unwrap_or(after.len())..];
        if rest.starts_with('/') {
            rest.to_string()
        } else {
            format!("/{rest}")
        }
    } else {
        return Err(malformed("the request target must be an absolute path"));
    };
    let origin = origin.split('#').next().unwrap_or_default();
    Ok(match origin.split_once('?') {
        Some((path, query)) => (path.into(), query.into()),
        None => (origin.into(), String::new()),
    })
}

fn read_headers<R: BufRead>(
    r: &mut R,
    budget: &mut usize,
    max_count: usize,
) -> Result<Vec<(String, String)>, ReadError> {
    let mut headers = Vec::new();
    loop {
        let line = read_line(r, budget)?
            .ok_or_else(|| malformed("the connection closed inside the header section"))?;
        if line.is_empty() {
            return Ok(headers);
        }
        if matches!(line[0], b' ' | b'\t') {
            return Err(malformed("folded header lines are not supported"));
        }
        if headers.len() == max_count {
            return Err(ReadError::HeadTooLarge);
        }
        let colon = line
            .iter()
            .position(|&b| b == b':')
            .ok_or_else(|| malformed("a header line has no colon"))?;
        let (name, value) = (&line[..colon], &line[colon + 1..]);
        if name.is_empty() || !name.iter().copied().all(is_tchar) {
            return Err(malformed("invalid header name"));
        }
        // Bare CR or other controls in a value are how header injection starts.
        if value.iter().copied().any(is_forbidden_value_byte) {
            return Err(malformed("a header value contains control characters"));
        }
        let value = String::from_utf8_lossy(value);
        headers.push((
            String::from_utf8_lossy(name).to_ascii_lowercase(),
            value.trim_matches([' ', '\t']).to_string(),
        ));
    }
}

/// Read one line ending in LF (CR before it is dropped), charging its bytes to `budget`.
/// None at a clean end of stream.
fn read_line<R: BufRead>(r: &mut R, budget: &mut usize) -> Result<Option<Vec<u8>>, ReadError> {
    let mut line = Vec::new();
    loop {
        let buf = match r.fill_buf() {
            Ok(buf) => buf,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(ReadError::Io(e)),
        };
        if buf.is_empty() {
            return if line.is_empty() {
                Ok(None)
            } else {
                Err(malformed("the connection closed in the middle of a line"))
            };
        }
        let (take, done) = match buf.iter().position(|&b| b == b'\n') {
            Some(i) => (i + 1, true),
            None => (buf.len(), false),
        };
        if take > *budget {
            return Err(ReadError::HeadTooLarge);
        }
        *budget -= take;
        line.extend_from_slice(&buf[..take]);
        r.consume(take);
        if done {
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            return Ok(Some(line));
        }
    }
}

enum Framing {
    /// No framing header: an empty request body, or a response body that runs to close.
    Unframed,
    Length(usize),
    Chunked,
}

/// Body framing from the headers. `strict` (requests) refuses Transfer-Encoding together with
/// Content-Length, the classic smuggling shape; a response with both follows the coding.
fn body_framing(headers: &[(String, String)], strict: bool) -> Result<Framing, ReadError> {
    let codings: Vec<&str> = header_list(headers, "transfer-encoding")
        .into_iter()
        .filter(|c| !c.is_empty())
        .collect();
    let lengths = header_list(headers, "content-length");
    if !codings.is_empty() {
        if strict && !lengths.is_empty() {
            return Err(malformed(
                "both Transfer-Encoding and Content-Length are present",
            ));
        }
        return if codings.len() == 1 && codings[0].eq_ignore_ascii_case("chunked") {
            Ok(Framing::Chunked)
        } else {
            Err(ReadError::Malformed(format!(
                "unsupported transfer coding: {}",
                codings.join(", ")
            )))
        };
    }
    let Some(&first) = lengths.first() else {
        return Ok(Framing::Unframed);
    };
    if lengths.iter().any(|v| *v != first) {
        return Err(malformed("conflicting Content-Length values"));
    }
    if first.is_empty() || !first.bytes().all(|b| b.is_ascii_digit()) {
        return Err(malformed("invalid Content-Length"));
    }
    // Digits only, so parsing fails only on overflow: a length past every limit.
    Ok(Framing::Length(first.parse().unwrap_or(usize::MAX)))
}

/// Every comma-separated element of every header with this (lowercase) name.
fn header_list<'a>(headers: &'a [(String, String)], name: &str) -> Vec<&'a str> {
    headers
        .iter()
        .filter(|(n, _)| n == name)
        .flat_map(|(_, v)| v.split(','))
        .map(str::trim)
        .collect()
}

fn read_exact_body<R: Read>(r: &mut R, len: usize) -> Result<Vec<u8>, ReadError> {
    // Grow as bytes arrive rather than trusting the declared length up front.
    let mut body = Vec::with_capacity(len.min(64 * 1024));
    r.by_ref().take(len as u64).read_to_end(&mut body)?;
    if body.len() < len {
        return Err(malformed(
            "the connection closed before the whole body arrived",
        ));
    }
    Ok(body)
}

fn read_to_close<R: Read>(r: &mut R, max: usize) -> Result<Vec<u8>, ReadError> {
    let mut body = Vec::new();
    r.by_ref().take(max as u64 + 1).read_to_end(&mut body)?;
    if body.len() > max {
        return Err(ReadError::BodyTooLarge);
    }
    Ok(body)
}

fn read_chunked<R: BufRead>(r: &mut R, max: usize) -> Result<Vec<u8>, ReadError> {
    let mut body = Vec::new();
    loop {
        let mut budget = MAX_CHUNK_LINE;
        let line = match read_line(r, &mut budget) {
            Ok(Some(line)) => line,
            Ok(None) => return Err(malformed("the connection closed inside a chunked body")),
            Err(ReadError::HeadTooLarge) => return Err(malformed("a chunk-size line is too long")),
            Err(e) => return Err(e),
        };
        // Chunk extensions after ';' carry nothing we use.
        let size = line.split(|&b| b == b';').next().unwrap_or_default();
        let size = String::from_utf8_lossy(size);
        let size = size.trim_matches([' ', '\t']);
        if size.is_empty() || !size.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(malformed("invalid chunk size"));
        }
        // Hex digits only, so parsing fails only on overflow: a size past every limit.
        let size = usize::from_str_radix(size, 16).map_err(|_| ReadError::BodyTooLarge)?;
        if size == 0 {
            // Trailer fields are read for framing and dropped.
            let mut trailer_budget = MAX_HEAD_BYTES;
            read_headers(r, &mut trailer_budget, MAX_HEADERS)?;
            return Ok(body);
        }
        let start = body.len();
        let end = start
            .checked_add(size)
            .filter(|&end| end <= max)
            .ok_or(ReadError::BodyTooLarge)?;
        body.resize(end, 0);
        r.read_exact(&mut body[start..]).map_err(|e| {
            if e.kind() == io::ErrorKind::UnexpectedEof {
                malformed("the connection closed inside a chunk")
            } else {
                ReadError::Io(e)
            }
        })?;
        let mut crlf_budget = 2;
        match read_line(r, &mut crlf_budget) {
            Ok(Some(rest)) if rest.is_empty() => {}
            Err(ReadError::Io(e)) => return Err(ReadError::Io(e)),
            _ => return Err(malformed("chunk data is not followed by CRLF")),
        }
    }
}

fn write_response<W: Write>(w: &mut W, response: &Response, head_only: bool) -> io::Result<()> {
    write_response_with(w, response, head_only, false)
}

fn write_response_with<W: Write>(w: &mut W, response: &Response, head_only: bool, keep_alive: bool) -> io::Result<()> {
    // Interim and out-of-range codes are not valid final responses.
    let status = if (200..=999).contains(&response.status) {
        response.status
    } else {
        500
    };
    let bodyless = status == 204 || status == 304;
    let mut head = format!("HTTP/1.1 {status} {}\r\n", reason(status));
    for (name, value) in &response.headers {
        // Framing is ours to set, and a CR or LF in a header would split the response.
        let framing = ["content-length", "transfer-encoding", "connection"]
            .iter()
            .any(|h| name.eq_ignore_ascii_case(h));
        if framing
            || name.is_empty()
            || !name.bytes().all(is_tchar)
            || value.bytes().any(is_forbidden_value_byte)
        {
            continue;
        }
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    if !bodyless {
        head.push_str(&format!("Content-Length: {}\r\n", response.body.len()));
    }
    head.push_str(if keep_alive { "Connection: keep-alive\r\n\r\n" } else { "Connection: close\r\n\r\n" });
    let mut out = head.into_bytes();
    if !bodyless && !head_only {
        out.extend_from_slice(&response.body);
    }
    w.write_all(&out)?;
    w.flush()
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        413 => "Content Too Large",
        422 => "Unprocessable Content",
        431 => "Request Header Fields Too Large",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => "Status",
    }
}

fn is_tchar(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b)
}

fn is_forbidden_value_byte(b: u8) -> bool {
    (b < 0x20 && b != b'\t') || b == 0x7f
}

fn is_timeout(e: &io::Error) -> bool {
    matches!(
        e.kind(),
        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
    )
}

pub(crate) fn time_left(deadline: Instant) -> Option<Duration> {
    let left = deadline.saturating_duration_since(Instant::now());
    (!left.is_zero()).then_some(left)
}

fn strip_prefix_ci<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
    let head = s.get(..prefix.len())?;
    head.eq_ignore_ascii_case(prefix)
        .then(|| &s[prefix.len()..])
}

// ---------------------------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------------------------

/// What an https:// URL gets without a TLS context: novad trusts a Hub's certificate only through
/// the fingerprint pinned at Add Device (src/tls.rs).
pub const HTTPS_NEEDS_PIN: &str = "an https:// Hub needs its pinned fingerprint (--pin), which this command does not have";

/// POST a JSON body to an http:// URL (https:// -> Err(HTTPS_NEEDS_PIN); see `post_json_with`).
/// Sends Content-Length, `Connection: close`, `Authorization: Bearer` when given, and the Host
/// header with the port. Reads a Content-Length, chunked or read-to-EOF response body (max 16 MiB).
/// Returns the status and the parsed JSON body (Value::Null when the body is empty; Err when the
/// body is not JSON). Connection and read errors are Err(message). Times out after `timeout`.
pub fn post_json(
    url: &str,
    bearer: Option<&str>,
    body: &Value,
    timeout: Duration,
) -> Result<(u16, Value), String> {
    let payload =
        serde_json::to_vec(body).map_err(|e| format!("cannot encode the request body: {e}"))?;
    exchange("POST", url, bearer, Some(&payload), timeout)
}

/// Same as post_json with method GET and no body.
pub fn get_json(
    url: &str,
    bearer: Option<&str>,
    timeout: Duration,
) -> Result<(u16, Value), String> {
    exchange("GET", url, bearer, None, timeout)
}

/// `post_json` that can reach an https:// Hub through `tls` (the pinned identity, its CA and the
/// device certificate).
pub fn post_json_with(
    url: &str,
    bearer: Option<&str>,
    body: &Value,
    timeout: Duration,
    tls: Option<&crate::tls::TlsContext>,
) -> Result<(u16, Value), String> {
    let payload =
        serde_json::to_vec(body).map_err(|e| format!("cannot encode the request body: {e}"))?;
    exchange_with("POST", url, bearer, Some(&payload), timeout, tls)
}

/// `get_json` that can reach an https:// Hub through `tls`.
pub fn get_json_with(
    url: &str,
    bearer: Option<&str>,
    timeout: Duration,
    tls: Option<&crate::tls::TlsContext>,
) -> Result<(u16, Value), String> {
    exchange_with("GET", url, bearer, None, timeout, tls)
}

/// A parsed http:// or https:// URL.
#[derive(Debug, PartialEq, Eq)]
struct Target {
    /// https: the connection goes through a `TlsContext`.
    tls: bool,
    /// Name or address to connect to; an IPv6 literal without brackets.
    host: String,
    port: u16,
    /// `host:port` as sent in the Host header, brackets restored for IPv6.
    authority: String,
    /// Path plus `?query`, at least "/".
    path: String,
}

fn parse_url(url: &str) -> Result<Target, String> {
    let (tls, rest) = match (strip_prefix_ci(url, "https://"), strip_prefix_ci(url, "http://")) {
        (Some(rest), _) => (true, rest),
        (None, Some(rest)) => (false, rest),
        _ => return Err("unsupported URL: only http:// and https:// are understood".into()),
    };
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(end);
    // Credentials in a URL leak into logs; tokens travel in the Authorization header.
    if authority.contains('@') {
        return Err("credentials in the URL (user@host) are not supported".into());
    }
    let (host, port) = split_host_port(authority, if tls { 443 } else { 80 })?;
    let tail = tail.split('#').next().unwrap_or_default();
    let path = if tail.starts_with('/') {
        tail.to_string()
    } else {
        format!("/{tail}")
    };
    if path.bytes().any(|b| b <= b' ' || b == 0x7f) {
        return Err("the URL path contains spaces or control characters".into());
    }
    let authority = if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    };
    Ok(Target {
        tls,
        host,
        port,
        authority,
        path,
    })
}

/// Whether a URL is https:// (the client then needs a `TlsContext`).
pub fn is_https(url: &str) -> bool {
    strip_prefix_ci(url, "https://").is_some()
}

/// The host and port of an http(s):// URL (Err for anything the client would refuse).
pub fn host_port(url: &str) -> Result<(String, u16), String> {
    parse_url(url).map(|t| (t.host, t.port))
}

fn split_host_port(authority: &str, default_port: u16) -> Result<(String, u16), String> {
    let (host, port) = if let Some(inner) = authority.strip_prefix('[') {
        let (ip, after) = inner
            .split_once(']')
            .ok_or("the URL has an unclosed '[' in its host")?;
        ip.parse::<Ipv6Addr>()
            .map_err(|_| "the URL has an invalid IPv6 address")?;
        let port = match after {
            "" => None,
            other => Some(
                other
                    .strip_prefix(':')
                    .ok_or("unexpected text after the IPv6 address in the URL")?,
            ),
        };
        (ip, port)
    } else {
        match authority.split_once(':') {
            Some((_, port)) if port.contains(':') => {
                return Err("an IPv6 address in a URL must be in brackets".into());
            }
            Some((host, port)) => (host, Some(port)),
            None => (authority, None),
        }
    };
    if host.is_empty() {
        return Err("the URL has no host".into());
    }
    if !host.contains(':')
        && !host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_'))
    {
        return Err("the URL has an invalid host".into());
    }
    let port = match port {
        None | Some("") => default_port,
        Some(p) if p.bytes().all(|b| b.is_ascii_digit()) => p
            .parse::<u16>()
            .ok()
            .filter(|&p| p != 0)
            .ok_or("the URL has an invalid port")?,
        Some(_) => return Err("the URL has an invalid port".into()),
    };
    Ok((host.to_string(), port))
}

fn exchange(
    method: &str,
    url: &str,
    bearer: Option<&str>,
    body: Option<&[u8]>,
    timeout: Duration,
) -> Result<(u16, Value), String> {
    exchange_with(method, url, bearer, body, timeout, None)
}

fn exchange_with(
    method: &str,
    url: &str,
    bearer: Option<&str>,
    body: Option<&[u8]>,
    timeout: Duration,
    tls: Option<&crate::tls::TlsContext>,
) -> Result<(u16, Value), String> {
    let mut headers = Vec::new();
    let auth;
    if let Some(token) = bearer {
        if token.is_empty() || token.bytes().any(|b| b <= b' ' || b == 0x7f) {
            return Err("the bearer token is empty or contains spaces or control characters".into());
        }
        auth = format!("Bearer {token}");
        headers.push(("Authorization", auth.as_str()));
    }
    let r = request_with(method, url, &headers, body, timeout, tls)?;
    decode_json(r.status, &r.body)
}

/// A response as received: status, headers (names lowercased) and the raw body.
#[derive(Debug, Clone)]
pub struct RawResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl RawResponse {
    /// The first header with this name, compared case-insensitively.
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(n, _)| n.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    /// The body as JSON (Value::Null when empty; Err when it is not JSON).
    pub fn json(&self) -> Result<Value, String> {
        decode_json(self.status, &self.body).map(|(_, v)| v)
    }
}

/// One request to an http:// URL with extra headers (signed status polls, FR-132) and the raw
/// response (signed manifests are verified over their exact bytes, FR-133). A JSON body gets
/// its Content-Type; header names and values with control characters are refused.
pub fn request(
    method: &str,
    url: &str,
    headers: &[(&str, &str)],
    body: Option<&[u8]>,
    timeout: Duration,
) -> Result<RawResponse, String> {
    request_with(method, url, headers, body, timeout, None)
}

/// `request` that reaches an https:// URL through `tls`: the connection is trusted (and the
/// device certificate presented) before anything is sent on it.
pub fn request_with(
    method: &str,
    url: &str,
    headers: &[(&str, &str)],
    body: Option<&[u8]>,
    timeout: Duration,
    tls: Option<&crate::tls::TlsContext>,
) -> Result<RawResponse, String> {
    let target = parse_url(url)?;
    for (name, value) in headers {
        if name.is_empty()
            || !name.bytes().all(is_tchar)
            || value.bytes().any(|b| b < b' ' || b == 0x7f)
        {
            return Err(format!("the request header {name:?} is not valid"));
        }
    }
    let deadline = Instant::now()
        .checked_add(timeout)
        .unwrap_or_else(|| Instant::now() + Duration::from_secs(365 * 24 * 3600));
    let dial = || {
        let stream = connect(&target, deadline, timeout)?;
        let _ = stream.set_nodelay(true);
        Ok(stream)
    };
    if target.tls {
        let ctx = tls.ok_or(HTTPS_NEEDS_PIN)?;
        let mut stream = ctx.connect(&dial, &target.host, &target.authority, deadline)?;
        return exchange_on(&mut stream, method, &target.authority, &target.path, headers, body, false, deadline)
            .map_err(|e| if e == TIMED_OUT { timed_out(timeout) } else { e });
    }
    let mut stream = dial()?;
    exchange_on(&mut stream, method, &target.authority, &target.path, headers, body, false, deadline)
        .map_err(|e| if e == TIMED_OUT { timed_out(timeout) } else { e })
}

/// A stream whose socket timeouts can be set: plain TCP or TLS over TCP.
pub trait Timed: Read + Write {
    fn tcp(&self) -> &TcpStream;
}

impl Timed for TcpStream {
    fn tcp(&self) -> &TcpStream {
        self
    }
}

impl Timed for crate::tls::TlsStream {
    fn tcp(&self) -> &TcpStream {
        &self.sock
    }
}

const TIMED_OUT: &str = "timed out";

/// Send one request on an open connection and read its response. `keep_alive` asks the server to
/// keep the connection for another request (the identity statement before the real request,
/// docs/22 §5); then nothing may follow the response on the wire.
#[allow(clippy::too_many_arguments)]
pub(crate) fn exchange_on<S: Timed>(
    stream: &mut S,
    method: &str,
    authority: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: Option<&[u8]>,
    keep_alive: bool,
    deadline: Instant,
) -> Result<RawResponse, String> {
    let mut head = format!(
        "{method} {path} HTTP/1.1\r\nHost: {authority}\r\nUser-Agent: novad\r\nAccept: application/json\r\n"
    );
    for (name, value) in headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    if let Some(body) = body {
        head.push_str(&format!(
            "Content-Type: application/json\r\nContent-Length: {}\r\n",
            body.len()
        ));
    }
    head.push_str(if keep_alive { "Connection: keep-alive\r\n\r\n" } else { "Connection: close\r\n\r\n" });
    let mut message = head.into_bytes();
    if let Some(body) = body {
        message.extend_from_slice(body);
    }

    let mut io = Deadlined { stream, deadline };
    // A server may answer early (413) and stop reading; its reply is still worth reading.
    let sent = io.write_all(&message).and_then(|()| io.flush());
    if let Err(e) = &sent
        && is_timeout(e)
    {
        return Err(TIMED_OUT.into());
    }
    let mut reader = BufReader::new(io);
    let received = read_response_head(&mut reader).and_then(|(status, headers)| {
        read_response_body(&mut reader, status, &headers).map(|body| (status, headers, body))
    });
    if keep_alive && !reader.buffer().is_empty() {
        return Err("the server sent more than one response".into());
    }
    match (received, sent) {
        (Ok((status, headers, body)), _) => Ok(RawResponse {
            status,
            headers,
            body,
        }),
        (Err(_), Err(e)) => Err(match crate::tls::explain(&e) {
            Some(why) => why,
            None => format!("sending the request failed: {e}"),
        }),
        (Err(ReadError::Io(e)), Ok(())) if is_timeout(&e) => Err(TIMED_OUT.into()),
        (Err(e), Ok(())) => Err(describe(e, Duration::ZERO)),
    }
}

fn connect(target: &Target, deadline: Instant, timeout: Duration) -> Result<TcpStream, String> {
    let addrs: Vec<SocketAddr> = (target.host.as_str(), target.port)
        .to_socket_addrs()
        .map_err(|e| format!("cannot resolve {}: {e}", target.host))?
        .collect();
    if addrs.is_empty() {
        return Err(format!("{} resolved to no addresses", target.host));
    }
    let mut last_error = None;
    for addr in addrs {
        let Some(left) = time_left(deadline) else {
            return Err(timed_out(timeout));
        };
        match TcpStream::connect_timeout(&addr, left) {
            Ok(stream) => return Ok(stream),
            Err(e) => last_error = Some(e),
        }
    }
    Err(match last_error {
        Some(e) if is_timeout(&e) => timed_out(timeout),
        Some(e) => format!("cannot connect to {}: {e}", target.authority),
        None => timed_out(timeout),
    })
}

/// Socket I/O bounded by one overall deadline rather than a per-call timeout.
struct Deadlined<'a, S: Timed> {
    stream: &'a mut S,
    deadline: Instant,
}

impl<S: Timed> Deadlined<'_, S> {
    fn left(&self) -> io::Result<Duration> {
        time_left(self.deadline).ok_or_else(|| io::Error::from(io::ErrorKind::TimedOut))
    }
}

impl<S: Timed> Read for Deadlined<'_, S> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let left = self.left()?;
        self.stream.tcp().set_read_timeout(Some(left))?;
        self.stream.read(buf)
    }
}

impl<S: Timed> Write for Deadlined<'_, S> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let left = self.left()?;
        self.stream.tcp().set_write_timeout(Some(left))?;
        self.stream.write(buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        // TLS buffers records until flushed; TCP has nothing to flush.
        let left = self.left()?;
        self.stream.tcp().set_write_timeout(Some(left))?;
        self.stream.flush()
    }
}

fn read_response_head<R: BufRead>(r: &mut R) -> Result<(u16, Vec<(String, String)>), ReadError> {
    loop {
        let mut budget = MAX_RESPONSE_HEAD_BYTES;
        let line = read_line(r, &mut budget)?.ok_or(ReadError::Closed)?;
        let status = parse_status_line(&line)?;
        let headers = read_headers(r, &mut budget, MAX_RESPONSE_HEADERS)?;
        match status {
            101 => return Err(malformed("the server switched protocols")),
            // Interim responses (100 Continue, 103) precede the real one.
            100..=199 => continue,
            _ => return Ok((status, headers)),
        }
    }
}

fn parse_status_line(line: &[u8]) -> Result<u16, ReadError> {
    let ok = line.len() >= 12
        && line.starts_with(b"HTTP/1.")
        && line[7].is_ascii_digit()
        && line[8] == b' '
        && line[9..12].iter().all(u8::is_ascii_digit)
        && (line.len() == 12 || line[12] == b' ');
    let status = if ok {
        line[9..12]
            .iter()
            .fold(0u16, |n, &d| n * 10 + u16::from(d - b'0'))
    } else {
        0
    };
    if status < 100 {
        return Err(malformed("invalid status line"));
    }
    Ok(status)
}

fn read_response_body<R: BufRead>(
    r: &mut R,
    status: u16,
    headers: &[(String, String)],
) -> Result<Vec<u8>, ReadError> {
    if status == 204 || status == 304 {
        return Ok(Vec::new());
    }
    match body_framing(headers, false)? {
        Framing::Chunked => read_chunked(r, MAX_RESPONSE_BODY),
        Framing::Length(n) if n > MAX_RESPONSE_BODY => Err(ReadError::BodyTooLarge),
        Framing::Length(n) => read_exact_body(r, n),
        Framing::Unframed => read_to_close(r, MAX_RESPONSE_BODY),
    }
}

fn decode_json(status: u16, body: &[u8]) -> Result<(u16, Value), String> {
    if body.iter().all(u8::is_ascii_whitespace) {
        return Ok((status, Value::Null));
    }
    serde_json::from_slice(body)
        .map(|value| (status, value))
        .map_err(|e| {
            let preview: String = String::from_utf8_lossy(&body[..body.len().min(80)])
                .chars()
                .map(|c| if c.is_control() { ' ' } else { c })
                .collect();
            format!("the response (status {status}) is not JSON: {e}; it starts with {preview:?}")
        })
}

fn describe(err: ReadError, timeout: Duration) -> String {
    match err {
        ReadError::Io(e) if is_timeout(&e) => timed_out(timeout),
        ReadError::Io(e) => match crate::tls::explain(&e) {
            Some(why) => why,
            None => format!("reading the response failed: {e}"),
        },
        ReadError::Closed => "the server closed the connection without a response".into(),
        ReadError::Malformed(message) => format!("malformed response: {message}"),
        ReadError::HeadTooLarge => "the response head is too large".into(),
        ReadError::BodyTooLarge => {
            format!("the response body exceeds {MAX_RESPONSE_BODY} bytes")
        }
    }
}

/// Unix seconds from an HTTP date in the IMF-fixdate form servers send
/// (`Sun, 06 Nov 1994 08:49:37 GMT`, RFC 9110 §5.6.7); None for anything else.
pub fn parse_http_date(s: &str) -> Option<u64> {
    let parts: Vec<&str> = s.split_whitespace().collect();
    let [_, day, month, year, time, "GMT"] = parts.as_slice() else {
        return None;
    };
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let m = MONTHS.iter().position(|x| x == month)? as i64 + 1;
    let d: i64 = day.parse().ok().filter(|d| (1..=31).contains(d))?;
    let y: i64 = year.parse().ok().filter(|y| (1970..=9999).contains(y))?;
    let hms: Vec<i64> = time
        .split(':')
        .map(|p| p.parse().ok())
        .collect::<Option<Vec<i64>>>()?;
    let [h, mi, se] = hms.as_slice() else {
        return None;
    };
    if !(0..24).contains(h) || !(0..60).contains(mi) || !(0..61).contains(se) {
        return None;
    }
    u64::try_from(crate::util::days_from_civil(y, m, d) * 86_400 + h * 3600 + mi * 60 + se).ok()
}

fn timed_out(timeout: Duration) -> String {
    format!("timed out after {} ms", timeout.as_millis())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    const WAIT: Duration = Duration::from_secs(5);

    fn start<F>(max_body: usize, handler: F) -> ServerHandle
    where
        F: Fn(Request) -> Response + Send + Sync + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        serve(listener, max_body, Arc::new(handler))
    }

    fn echo(req: Request) -> Response {
        let body = match req.json() {
            Ok(body) => body,
            Err(e) => return Response::error(400, "validation", &e, None),
        };
        Response::json(
            200,
            &json!({
                "method": req.method,
                "path": req.path,
                "query": req.query,
                "bearer": req.bearer(),
                "body": body,
            }),
        )
    }

    fn url(server: &ServerHandle, path: &str) -> String {
        format!("http://{}{path}", server.local_addr())
    }

    /// Send raw bytes, then read until the server closes.
    fn raw(addr: SocketAddr, request: &[u8]) -> String {
        let mut stream = TcpStream::connect(addr).unwrap();
        stream.set_read_timeout(Some(WAIT)).unwrap();
        let _ = stream.write_all(request);
        let mut out = Vec::new();
        let _ = stream.read_to_end(&mut out);
        String::from_utf8_lossy(&out).into_owned()
    }

    fn json_body(response: &str) -> Value {
        let (_, body) = response.split_once("\r\n\r\n").expect("a response head");
        serde_json::from_str(body).expect("a JSON body")
    }

    fn request_with(headers: &[(&str, &str)], body: &[u8]) -> Request {
        Request {
            method: "POST".into(),
            path: "/".into(),
            query: String::new(),
            headers: headers
                .iter()
                .map(|(n, v)| (n.to_string(), v.to_string()))
                .collect(),
            body: body.to_vec(),
            peer: None,
        }
    }

    /// A one-connection server that sends `reply` after the request head, then keeps the
    /// connection open until the returned sender fires.
    fn one_shot(reply: &'static [u8]) -> (SocketAddr, mpsc::Sender<()>, JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let (release, released) = mpsc::channel::<()>();
        let thread = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            loop {
                line.clear();
                if reader.read_line(&mut line).unwrap() == 0 || line == "\r\n" {
                    break;
                }
            }
            stream.write_all(reply).unwrap();
            let _ = released.recv_timeout(WAIT);
        });
        (addr, release, thread)
    }

    #[test]
    fn get_and_post_round_trip_json() {
        let server = start(1 << 20, echo);
        let (status, value) = get_json(&url(&server, "/agent/v1/ping?x=1"), None, WAIT).unwrap();
        assert_eq!(status, 200);
        assert_eq!(value["method"], "GET");
        assert_eq!(value["path"], "/agent/v1/ping");
        assert_eq!(value["query"], "x=1");
        assert_eq!(value["bearer"], Value::Null);
        assert_eq!(value["body"], json!({}));

        let sent = json!({ "n": 1, "text": "caf\u{e9}", "list": [true, null] });
        let (status, value) =
            post_json(&url(&server, "/agent/v1/heartbeat"), Some("tok-1"), &sent, WAIT).unwrap();
        assert_eq!(status, 200);
        assert_eq!(value["method"], "POST");
        assert_eq!(value["bearer"], "tok-1");
        assert_eq!(value["body"], sent);

        // Stopping joins the accept thread. (Connecting afterwards is not asserted: a parallel
        // test may already have bound the freed port.)
        server.stop();
    }

    #[test]
    fn client_maps_empty_and_non_json_bodies() {
        let server = start(1024, |req: Request| match req.path.as_str() {
            "/empty" => Response {
                status: 204,
                headers: Vec::new(),
                body: Vec::new(),
            },
            "/teapot" => Response {
                status: 418,
                headers: Vec::new(),
                body: b"not json".to_vec(),
            },
            _ => Response::error(404, "not_found", "no route", Some(json!({ "path": req.path }))),
        });
        assert_eq!(
            get_json(&url(&server, "/empty"), None, WAIT).unwrap(),
            (204, Value::Null)
        );
        let err = get_json(&url(&server, "/teapot"), None, WAIT).unwrap_err();
        assert!(err.contains("not JSON"), "{err}");
        let (status, value) = get_json(&url(&server, "/nope"), None, WAIT).unwrap();
        assert_eq!(status, 404);
        assert_eq!(
            value,
            json!({
                "error": {
                    "code": "not_found",
                    "message": "no route",
                    "details": { "path": "/nope" },
                }
            })
        );
        let head = raw(server.local_addr(), b"GET /teapot HTTP/1.1\r\nHost: t\r\n\r\n");
        assert!(head.starts_with("HTTP/1.1 418 Status\r\n"), "{head}");
        server.stop();
    }

    #[test]
    fn request_helpers_parse_bearer_header_and_json() {
        let req = request_with(&[("authorization", "Bearer  abc.def ")], b"");
        assert_eq!(req.bearer(), Some("abc.def"));
        assert_eq!(req.header("Authorization"), Some("Bearer  abc.def "));
        assert_eq!(req.json().unwrap(), json!({}));
        assert_eq!(
            request_with(&[("authorization", "bearer xyz")], b"").bearer(),
            Some("xyz")
        );
        assert_eq!(
            request_with(&[("authorization", "Basic dXNlcjpwdw==")], b"").bearer(),
            None
        );
        assert_eq!(request_with(&[("authorization", "Bearer")], b"").bearer(), None);
        assert_eq!(request_with(&[("authorization", "Bearer   ")], b"").bearer(), None);
        assert_eq!(request_with(&[], b"").bearer(), None);
        assert_eq!(
            request_with(&[], br#"{"a":[1]}"#).json().unwrap(),
            json!({ "a": [1] })
        );
        assert!(request_with(&[], b"{bad").json().is_err());
    }

    #[test]
    fn query_is_split_from_the_path_without_decoding() {
        let server = start(1024, echo);
        let reply = raw(
            server.local_addr(),
            b"GET /a/b%20c?x=1&y=%20 HTTP/1.1\r\nHost: t\r\n\r\n",
        );
        let value = json_body(&reply);
        assert_eq!(value["path"], "/a/b%20c");
        assert_eq!(value["query"], "x=1&y=%20");

        let value = json_body(&raw(server.local_addr(), b"GET /plain HTTP/1.1\r\nHost: t\r\n\r\n"));
        assert_eq!(value["path"], "/plain");
        assert_eq!(value["query"], "");

        let value = json_body(&raw(
            server.local_addr(),
            b"GET http://t:1/abs?q=2 HTTP/1.1\r\nHost: t\r\n\r\n",
        ));
        assert_eq!(value["path"], "/abs");
        assert_eq!(value["query"], "q=2");
        server.stop();
    }

    #[test]
    fn chunked_request_body_is_decoded() {
        let server = start(1024, echo);
        let reply = raw(
            server.local_addr(),
            b"POST /c HTTP/1.1\r\nHost: t\r\nTransfer-Encoding: chunked\r\n\r\n\
              4\r\n{\"a\"\r\n3;ext=1\r\n:1}\r\n0\r\nX-Trailer: yes\r\n\r\n",
        );
        assert!(reply.starts_with("HTTP/1.1 200 OK\r\n"), "{reply}");
        assert_eq!(json_body(&reply)["body"], json!({ "a": 1 }));

        let bad = raw(
            server.local_addr(),
            b"POST /c HTTP/1.1\r\nHost: t\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n",
        );
        assert!(bad.starts_with("HTTP/1.1 400 Bad Request\r\n"), "{bad}");
        server.stop();
    }

    #[test]
    fn expect_continue_gets_an_interim_reply_before_the_body() {
        let server = start(1024, echo);
        let body = br#"{"k":"v"}"#;
        let mut stream = TcpStream::connect(server.local_addr()).unwrap();
        stream.set_read_timeout(Some(WAIT)).unwrap();
        let head = format!(
            "POST /e HTTP/1.1\r\nHost: t\r\nConnection: keep-alive\r\nExpect: 100-continue\r\n\
             Content-Type: application/json\r\nContent-Length: {}\r\n\r\n",
            body.len()
        );
        stream.write_all(head.as_bytes()).unwrap();
        let mut interim = [0u8; 25];
        stream.read_exact(&mut interim).unwrap();
        assert_eq!(&interim, b"HTTP/1.1 100 Continue\r\n\r\n");
        stream.write_all(body).unwrap();
        // read_to_end returning at all shows the server closed despite keep-alive.
        let mut rest = String::new();
        stream.read_to_string(&mut rest).unwrap();
        assert!(rest.starts_with("HTTP/1.1 200 OK\r\n"), "{rest}");
        assert!(rest.contains("Connection: close\r\n"), "{rest}");
        assert_eq!(json_body(&rest)["body"], json!({ "k": "v" }));
        server.stop();
    }

    #[test]
    fn oversized_body_gets_413() {
        let server = start(16, echo);
        let big = json!({ "data": "x".repeat(100) });
        let (status, value) = post_json(&url(&server, "/big"), None, &big, WAIT).unwrap();
        assert_eq!(status, 413);
        assert_eq!(value["error"]["code"], "payload_too_large");
        assert_eq!(value["error"]["details"]["maxBytes"], 16);

        let mut chunked =
            b"POST /big HTTP/1.1\r\nHost: t\r\nTransfer-Encoding: chunked\r\n\r\n20\r\n".to_vec();
        chunked.extend_from_slice(&[b'a'; 32]);
        chunked.extend_from_slice(b"\r\n0\r\n\r\n");
        let reply = raw(server.local_addr(), &chunked);
        assert!(reply.starts_with("HTTP/1.1 413 Content Too Large\r\n"), "{reply}");

        // At the limit is fine.
        let (status, _) = post_json(&url(&server, "/ok"), None, &json!("0123456789abcd"), WAIT)
            .unwrap();
        assert_eq!(status, 200);
        server.stop();
    }

    #[test]
    fn too_many_headers_or_too_big_a_head_gets_431() {
        let server = start(1024, echo);
        let request = |extra: usize| {
            let mut req = String::from("GET /h HTTP/1.1\r\nHost: t\r\n");
            for i in 0..extra {
                req.push_str(&format!("X-H{i}: v\r\n"));
            }
            req.push_str("\r\n");
            req
        };
        // Host plus 63 others is exactly the limit.
        let reply = raw(server.local_addr(), request(63).as_bytes());
        assert!(reply.starts_with("HTTP/1.1 200 OK\r\n"), "{reply}");
        let reply = raw(server.local_addr(), request(64).as_bytes());
        assert!(
            reply.starts_with("HTTP/1.1 431 Request Header Fields Too Large\r\n"),
            "{reply}"
        );
        assert_eq!(json_body(&reply)["error"]["code"], "headers_too_large");

        let long = format!("GET /h HTTP/1.1\r\nHost: t\r\nX-Long: {}\r\n\r\n", "a".repeat(17_000));
        let reply = raw(server.local_addr(), long.as_bytes());
        assert!(reply.starts_with("HTTP/1.1 431 "), "{reply}");
        server.stop();
    }

    #[test]
    fn malformed_requests_get_400() {
        let server = start(1024, echo);
        for bad in [
            &b"GARBAGE\r\n\r\n"[..],
            b"GET / HTTP/9.9\r\n\r\n",
            b"GET nopath HTTP/1.1\r\n\r\n",
            b"GET / HTTP/1.1\r\nno colon here\r\n\r\n",
            b"POST / HTTP/1.1\r\nContent-Length: 5\r\nTransfer-Encoding: chunked\r\n\r\n",
            b"POST / HTTP/1.1\r\nContent-Length: nope\r\n\r\n",
        ] {
            let reply = raw(server.local_addr(), bad);
            assert!(reply.starts_with("HTTP/1.1 400 Bad Request\r\n"), "{reply}");
            assert_eq!(json_body(&reply)["error"]["code"], "validation");
        }
        // A connection that closes without a byte gets no reply and does no harm.
        drop(TcpStream::connect(server.local_addr()).unwrap());
        assert_eq!(get_json(&url(&server, "/"), None, WAIT).unwrap().0, 200);
        server.stop();
    }

    #[test]
    fn handler_panic_is_a_500_and_the_server_keeps_serving() {
        let server = start(1024, |req: Request| {
            if req.path == "/boom" {
                panic!("handler failure (expected by this test)");
            }
            Response::json(200, &json!({ "ok": true }))
        });
        let (status, value) = get_json(&url(&server, "/boom"), None, WAIT).unwrap();
        assert_eq!(status, 500);
        assert_eq!(value["error"]["code"], "server_error");
        let (status, value) = get_json(&url(&server, "/fine"), None, WAIT).unwrap();
        assert_eq!(status, 200);
        assert_eq!(value["ok"], true);
        server.stop();
    }

    #[test]
    fn https_urls_need_a_tls_context() {
        let err = get_json("https://127.0.0.1:1/x", None, WAIT).unwrap_err();
        assert_eq!(err, HTTPS_NEEDS_PIN);
        let err = post_json("HTTPS://hub.local/x", None, &json!({}), WAIT).unwrap_err();
        assert_eq!(err, HTTPS_NEEDS_PIN);
        assert!(is_https("HTTPS://hub.local") && !is_https("http://hub.local"));
        assert_eq!(host_port("https://hub.local/x").unwrap(), ("hub.local".to_string(), 443));
    }

    #[test]
    fn raw_requests_carry_extra_headers_and_return_exact_bytes() {
        let server = start(1024, |req: Request| Response {
            status: 200,
            headers: vec![
                ("content-type".into(), "application/octet-stream".into()),
                ("date".into(), "Sat, 17 Oct 2026 15:20:00 GMT".into()),
                ("x-seen".into(), req.header("x-nova-device-time").unwrap_or("-").into()),
            ],
            body: b"{ \"exact\": 1 }\n".to_vec(),
        });
        let r = request("GET", &url(&server, "/m"), &[("x-nova-device-time", "123")], None, WAIT).unwrap();
        assert_eq!(r.status, 200);
        assert_eq!(r.body, b"{ \"exact\": 1 }\n");
        assert_eq!(r.header("X-Seen"), Some("123"));
        assert_eq!(r.json().unwrap()["exact"], 1);
        assert_eq!(r.header("date").and_then(parse_http_date), Some(1_792_250_400));
        // Header injection is refused before anything is sent.
        let err = request("GET", &url(&server, "/m"), &[("x-a", "1\r\nx-b: 2")], None, WAIT).unwrap_err();
        assert!(err.contains("not valid"), "{err}");
        assert!(request("GET", &url(&server, "/m"), &[("bad name", "1")], None, WAIT).is_err());
        server.stop();
    }

    #[test]
    fn http_dates_parse_only_the_fixed_form() {
        assert_eq!(parse_http_date("Thu, 01 Jan 1970 00:00:00 GMT"), Some(0));
        assert_eq!(parse_http_date("Sun, 06 Nov 1994 08:49:37 GMT"), Some(784_111_777));
        assert_eq!(parse_http_date("Tue, 29 Feb 2028 23:59:59 GMT"), Some(1_835_481_599));
        assert_eq!(parse_http_date("Sunday, 06-Nov-94 08:49:37 GMT"), None);
        assert_eq!(parse_http_date("Sun, 06 Nov 1994 08:49:37 PST"), None);
        assert_eq!(parse_http_date("Sun, 06 Foo 1994 08:49:37 GMT"), None);
        assert_eq!(parse_http_date("Sun, 06 Nov 1994 25:49:37 GMT"), None);
        assert_eq!(parse_http_date(""), None);
    }

    #[test]
    fn urls_with_userinfo_are_refused() {
        for url in ["http://user:pw@127.0.0.1:1/", "http://user@hub.local/x"] {
            let err = get_json(url, None, WAIT).unwrap_err();
            assert!(err.contains("credentials"), "{err}");
        }
    }

    #[test]
    fn urls_parse_hosts_ports_and_paths() {
        let t = parse_url("http://[::1]:8080/a/b?c=d#frag").unwrap();
        assert_eq!(
            t,
            Target {
                tls: false,
                host: "::1".into(),
                port: 8080,
                authority: "[::1]:8080".into(),
                path: "/a/b?c=d".into(),
            }
        );
        let t = parse_url("http://hub.local").unwrap();
        assert_eq!((t.port, t.authority.as_str(), t.path.as_str()), (80, "hub.local:80", "/"));
        let t = parse_url("http://10.0.0.2?x=1").unwrap();
        assert_eq!((t.host.as_str(), t.path.as_str()), ("10.0.0.2", "/?x=1"));
        assert_eq!(parse_url("http://[::1]/").unwrap().authority, "[::1]:80");
        for bad in [
            "ftp://x/",
            "http://",
            "http://::1/",
            "http://h:0/",
            "http://h:99999/",
            "http://h:8a/",
            "http://[::1/",
            "http://bad host/",
        ] {
            assert!(parse_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn client_times_out_when_the_server_never_answers() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let (release, released) = mpsc::channel::<()>();
        let holder = thread::spawn(move || {
            let (_stream, _) = listener.accept().unwrap();
            let _ = released.recv_timeout(WAIT);
        });
        let started = Instant::now();
        let err = post_json(
            &format!("http://{addr}/x"),
            Some("t"),
            &json!({}),
            Duration::from_millis(300),
        )
        .unwrap_err();
        let elapsed = started.elapsed();
        assert!(err.contains("timed out"), "{err}");
        assert!(
            elapsed >= Duration::from_millis(250) && elapsed < Duration::from_millis(1500),
            "{elapsed:?}"
        );
        release.send(()).unwrap();
        holder.join().unwrap();
    }

    #[test]
    fn client_reads_a_chunked_response() {
        // The connection stays open after the last chunk, so only chunked framing can end
        // the body in time.
        let (addr, release, server) = one_shot(
            b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\
              Transfer-Encoding: chunked\r\n\r\n\
              7\r\n{\"ok\":t\r\n4\r\nrue}\r\n0\r\n\r\n",
        );
        let reply = get_json(&format!("http://{addr}/"), None, WAIT).unwrap();
        assert_eq!(reply, (200, json!({ "ok": true })));
        release.send(()).unwrap();
        server.join().unwrap();
    }

    #[test]
    fn client_reads_a_body_that_runs_to_close() {
        let (addr, release, server) = one_shot(b"HTTP/1.0 201 Created\r\n\r\n{\"eof\":true}");
        // Close right away so the body ends.
        release.send(()).unwrap();
        let reply = get_json(&format!("http://{addr}/"), None, WAIT).unwrap();
        assert_eq!(reply, (201, json!({ "eof": true })));
        server.join().unwrap();
    }
}
