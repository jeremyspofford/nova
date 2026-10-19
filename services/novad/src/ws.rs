//! The server side of a WebSocket (RFC 6455), as small as the DevTools relay needs (FR-209): the
//! Hub's DevTools client connects to `GET /agent/v1/browser/cdp/<sessionId>`, novad answers the
//! handshake and relays each text message to the session's browser, which speaks DevTools over a
//! pipe (`--remote-debugging-pipe`: NUL-terminated JSON), and each of the browser's messages back
//! as a text frame. So the browser opens no TCP port at all.
//!
//! - The handshake: `Sec-WebSocket-Accept` = base64(SHA-1(key + RFC GUID)); no extension or
//!   subprotocol is agreed (frames are never compressed).
//! - Client frames must be masked; reserved bits must be clear; control frames must be final and
//!   at most 125 bytes; text messages may be fragmented and must be UTF-8 without NUL (NUL ends a
//!   message on the browser's pipe; 1007); binary messages are refused (1003); a message over
//!   64 MiB closes the connection (1009); ping is answered with pong; close is answered with close.
//! - Bounded: client bytes are decoded one read at a time, and the decoder never holds more than
//!   one message plus one read (1009 past that).
//! - Server frames are unmasked, final, one per message.

use crate::http::Timed;
use std::io::{self, Read, Write};
use std::os::unix::net::UnixStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

/// The largest message either way (a full-page screenshot is a few MiB of base64).
pub const MAX_MESSAGE: usize = 64 * 1024 * 1024;
/// One read from the client.
const CHUNK: usize = 64 * 1024;
const GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

pub const OP_CONT: u8 = 0;
pub const OP_TEXT: u8 = 1;
pub const OP_BINARY: u8 = 2;
pub const OP_CLOSE: u8 = 8;
pub const OP_PING: u8 = 9;
pub const OP_PONG: u8 = 10;

/// Close codes (RFC 6455 §7.4.1).
pub const NORMAL: u16 = 1000;
pub const GOING_AWAY: u16 = 1001;
pub const PROTOCOL_ERROR: u16 = 1002;
pub const UNSUPPORTED: u16 = 1003;
pub const INVALID_DATA: u16 = 1007;
pub const TOO_BIG: u16 = 1009;
pub const INTERNAL: u16 = 1011;

/// `Sec-WebSocket-Accept` for a client's key.
pub fn accept_key(key: &str) -> String {
    let d = ring::digest::digest(&ring::digest::SHA1_FOR_LEGACY_USE_ONLY, format!("{key}{GUID}").as_bytes());
    crate::crypto::b64_encode(d.as_ref())
}

/// A server frame: final, unmasked.
pub fn frame(opcode: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + 10);
    out.push(0x80 | opcode);
    match payload.len() {
        n if n < 126 => out.push(n as u8),
        n if n <= 0xffff => {
            out.push(126);
            out.extend_from_slice(&(n as u16).to_be_bytes());
        }
        n => {
            out.push(127);
            out.extend_from_slice(&(n as u64).to_be_bytes());
        }
    }
    out.extend_from_slice(payload);
    out
}

pub fn close_frame(code: u16) -> Vec<u8> {
    frame(OP_CLOSE, &code.to_be_bytes())
}

/// What the client sent, one complete thing at a time.
#[derive(Debug, PartialEq)]
pub enum Event {
    Message(String),
    Ping(Vec<u8>),
    Pong,
    /// The client closes (its code, when it gave one).
    Close(Option<u16>),
}

/// Client frames in, events out. `Err(code)` is a violation; the connection closes with it.
pub struct Decoder {
    buf: Vec<u8>,
    /// A fragmented message being put together.
    partial: Option<(u8, Vec<u8>)>,
    max: usize,
}

impl Decoder {
    pub fn new(max: usize) -> Decoder {
        Decoder { buf: Vec::new(), partial: None, max }
    }

    /// Add what the client sent; refused (1009) when it would hold more than a message, its frame
    /// headers and one read.
    pub fn push(&mut self, data: &[u8]) -> Result<(), u16> {
        let held = self.buf.len() + self.partial.as_ref().map_or(0, |p| p.1.len());
        if held + data.len() > self.max + CHUNK + 14 {
            return Err(TOO_BIG);
        }
        self.buf.extend_from_slice(data);
        Ok(())
    }

    /// The next complete event, None until more bytes arrive.
    pub fn next(&mut self) -> Result<Option<Event>, u16> {
        loop {
            let b = &self.buf;
            if b.len() < 2 {
                return Ok(None);
            }
            let (fin, rsv, opcode) = (b[0] & 0x80 != 0, b[0] & 0x70, b[0] & 0x0f);
            let (masked, len7) = (b[1] & 0x80 != 0, (b[1] & 0x7f) as usize);
            if rsv != 0 || !masked || !matches!(opcode, OP_CONT | OP_TEXT | OP_BINARY | OP_CLOSE | OP_PING | OP_PONG) {
                return Err(PROTOCOL_ERROR);
            }
            let control = opcode >= OP_CLOSE;
            if control && (!fin || len7 > 125) {
                return Err(PROTOCOL_ERROR);
            }
            let (len, at) = match len7 {
                126 if b.len() < 4 => return Ok(None),
                126 => (u16::from_be_bytes([b[2], b[3]]) as u64, 4),
                127 if b.len() < 10 => return Ok(None),
                127 => (u64::from_be_bytes(b[2..10].try_into().unwrap_or_default()), 10),
                n => (n as u64, 2),
            };
            let so_far = self.partial.as_ref().map_or(0, |p| p.1.len()) as u64;
            // Refused on the declared length, before the bytes are buffered.
            if !control && len.saturating_add(so_far) > self.max as u64 {
                return Err(TOO_BIG);
            }
            let len = len as usize;
            if b.len() < at + 4 + len {
                return Ok(None);
            }
            let mask = [b[at], b[at + 1], b[at + 2], b[at + 3]];
            let mut payload: Vec<u8> = b[at + 4..at + 4 + len].to_vec();
            for (i, x) in payload.iter_mut().enumerate() {
                *x ^= mask[i % 4];
            }
            self.buf.drain(..at + 4 + len);
            match opcode {
                OP_PING => return Ok(Some(Event::Ping(payload))),
                OP_PONG => return Ok(Some(Event::Pong)),
                OP_CLOSE => {
                    if payload.len() == 1 {
                        return Err(PROTOCOL_ERROR);
                    }
                    return Ok(Some(Event::Close((payload.len() >= 2).then(|| u16::from_be_bytes([payload[0], payload[1]])))));
                }
                OP_CONT => {
                    let Some((op, mut acc)) = self.partial.take() else { return Err(PROTOCOL_ERROR) };
                    acc.extend_from_slice(&payload);
                    if !fin {
                        self.partial = Some((op, acc));
                        continue;
                    }
                    return complete(op, acc);
                }
                op => {
                    if self.partial.is_some() {
                        return Err(PROTOCOL_ERROR);
                    }
                    if !fin {
                        self.partial = Some((op, payload));
                        continue;
                    }
                    return complete(op, payload);
                }
            }
        }
    }
}

fn complete(op: u8, data: Vec<u8>) -> Result<Option<Event>, u16> {
    if op != OP_TEXT {
        return Err(UNSUPPORTED);
    }
    // A NUL would end the message early on the browser's pipe and start another.
    if data.contains(&0) {
        return Err(INVALID_DATA);
    }
    String::from_utf8(data).map(|s| Some(Event::Message(s))).map_err(|_| INVALID_DATA)
}

/// Relay between the WebSocket client and the browser's pipe (through the browser module's
/// socket: NUL-terminated messages both ways) until either ends or `stop` is set. One thread:
/// `poll(2)` on both, then drain what is readable (a TLS stream may hold decrypted bytes).
pub fn relay(mut client: Box<dyn Timed + Send>, rest: Vec<u8>, mut browser: UnixStream, stop: &AtomicBool) {
    use std::os::fd::AsRawFd;
    let short = Some(Duration::from_millis(1));
    let long = Some(Duration::from_secs(30));
    let _ = client.tcp().set_read_timeout(short);
    let _ = client.tcp().set_write_timeout(long);
    let _ = client.tcp().set_nodelay(true);
    let _ = browser.set_read_timeout(short);
    let _ = browser.set_write_timeout(long);
    let mut dec = Decoder::new(MAX_MESSAGE);
    let mut pending: Vec<u8> = Vec::new();
    let mut buf = vec![0u8; CHUNK];
    let mut first = Some(rest);
    // The first round also handles bytes already read or held decrypted.
    let mut client_ready = true;
    let mut browser_ready = false;
    let close = loop {
        if stop.load(Ordering::SeqCst) {
            break Some(GOING_AWAY);
        }
        if client_ready {
            match client_round(&mut *client, &mut browser, &mut dec, &mut buf, first.take()) {
                Ok(true) => {}
                Ok(false) => break None,
                Err(code) => break code,
            }
        }
        if browser_ready {
            let open = match drain(&mut browser, &mut buf, |d| pending.extend_from_slice(d)) {
                Ok(open) => open,
                Err(_) => false,
            };
            let mut end = None;
            while let Some(i) = pending.iter().position(|&b| b == 0) {
                let msg: Vec<u8> = pending.drain(..=i).collect();
                let text = &msg[..msg.len() - 1];
                if std::str::from_utf8(text).is_err() {
                    end = Some(Some(INTERNAL));
                    break;
                }
                if client.write_all(&frame(OP_TEXT, text)).and_then(|_| client.flush()).is_err() {
                    end = Some(None);
                    break;
                }
            }
            if let Some(e) = end {
                break e;
            }
            if pending.len() > MAX_MESSAGE {
                break Some(TOO_BIG);
            }
            if !open {
                // The browser closed (the session ended, or another connection took over).
                break Some(GOING_AWAY);
            }
        }
        let mut fds = [
            libc::pollfd { fd: client.tcp().as_raw_fd(), events: libc::POLLIN, revents: 0 },
            libc::pollfd { fd: browser.as_raw_fd(), events: libc::POLLIN, revents: 0 },
        ];
        let n = unsafe { libc::poll(fds.as_mut_ptr(), 2, 250) };
        if n < 0 && io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
            break None;
        }
        client_ready = n > 0 && fds[0].revents != 0;
        browser_ready = n > 0 && fds[1].revents != 0;
    };
    if let Some(code) = close {
        let _ = client.write_all(&close_frame(code)).and_then(|_| client.flush());
    }
    let _ = browser.shutdown(std::net::Shutdown::Both);
    let _ = client.tcp().shutdown(std::net::Shutdown::Both);
}

/// Read the client one chunk at a time (decoding each before the next read, so the decoder stays
/// bounded) until it would block, acting on each event. Ok(false) when the client is gone;
/// Err(Some(code)) to close with `code`, Err(None) to end without a close frame.
fn client_round(client: &mut (dyn Timed + Send), browser: &mut UnixStream, dec: &mut Decoder, buf: &mut [u8], first: Option<Vec<u8>>) -> Result<bool, Option<u16>> {
    let mut act = |dec: &mut Decoder, client: &mut (dyn Timed + Send)| -> Result<(), Option<u16>> {
        loop {
            match dec.next() {
                Ok(None) => return Ok(()),
                Ok(Some(Event::Message(m))) => {
                    let mut msg = m.into_bytes();
                    msg.push(0);
                    browser.write_all(&msg).map_err(|_| Some(GOING_AWAY))?;
                }
                Ok(Some(Event::Ping(p))) => client.write_all(&frame(OP_PONG, &p)).and_then(|_| client.flush()).map_err(|_| None)?,
                Ok(Some(Event::Pong)) => {}
                Ok(Some(Event::Close(code))) => return Err(Some(code.filter(|c| (1000..5000).contains(c) && !matches!(c, 1005 | 1006 | 1015)).unwrap_or(NORMAL))),
                Err(code) => return Err(Some(code)),
            }
        }
    };
    if let Some(rest) = first.filter(|r| !r.is_empty()) {
        dec.push(&rest).map_err(Some)?;
        act(dec, client)?;
    }
    loop {
        match client.read(buf) {
            Ok(0) => return Ok(false),
            Ok(n) => {
                dec.push(&buf[..n]).map_err(Some)?;
                act(dec, client)?;
            }
            Err(e) if matches!(e.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut) => return Ok(true),
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(_) => return Ok(false),
        }
    }
}

/// Read what `from` has now into `sink`; Ok(false) at its end.
fn drain<R: Read + ?Sized>(from: &mut R, buf: &mut [u8], mut sink: impl FnMut(&[u8])) -> io::Result<bool> {
    loop {
        match from.read(buf) {
            Ok(0) => return Ok(false),
            Ok(n) => sink(&buf[..n]),
            Err(e) if matches!(e.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut) => return Ok(true),
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// A client frame: masked with a fixed key.
    pub fn client_frame(fin: bool, opcode: u8, payload: &[u8]) -> Vec<u8> {
        let mask = [0x12u8, 0x34, 0x56, 0x78];
        let mut out = vec![if fin { 0x80 } else { 0 } | opcode];
        match payload.len() {
            n if n < 126 => out.push(0x80 | n as u8),
            n if n <= 0xffff => {
                out.push(0x80 | 126);
                out.extend_from_slice(&(n as u16).to_be_bytes());
            }
            n => {
                out.push(0x80 | 127);
                out.extend_from_slice(&(n as u64).to_be_bytes());
            }
        }
        out.extend_from_slice(&mask);
        out.extend(payload.iter().enumerate().map(|(i, b)| b ^ mask[i % 4]));
        out
    }

    /// Read one server frame: (opcode, payload).
    pub fn read_frame(r: &mut impl Read) -> io::Result<(u8, Vec<u8>)> {
        let mut h = [0u8; 2];
        r.read_exact(&mut h)?;
        assert_eq!(h[0] & 0x80, 0x80, "server frames are final");
        assert_eq!(h[1] & 0x80, 0, "server frames are not masked");
        let len = match h[1] & 0x7f {
            126 => {
                let mut l = [0u8; 2];
                r.read_exact(&mut l)?;
                u16::from_be_bytes(l) as usize
            }
            127 => {
                let mut l = [0u8; 8];
                r.read_exact(&mut l)?;
                u64::from_be_bytes(l) as usize
            }
            n => n as usize,
        };
        let mut p = vec![0u8; len];
        r.read_exact(&mut p)?;
        Ok((h[0] & 0x0f, p))
    }

    #[test]
    fn accepts_the_rfc_example_key() {
        assert_eq!(accept_key("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
    }

    #[test]
    fn decodes_masked_fragmented_and_control_frames() {
        let mut d = Decoder::new(1024);
        // Byte by byte: nothing until the frame is whole.
        for b in client_frame(true, OP_TEXT, b"{\"id\":1}") {
            assert_eq!(d.next(), Ok(None));
            d.push(&[b]).unwrap();
        }
        assert_eq!(d.next(), Ok(Some(Event::Message("{\"id\":1}".into()))));
        // Fragmented, with a ping in the middle; 126-length frames.
        let long = "x".repeat(300);
        d.push(&client_frame(false, OP_TEXT, b"ab")).unwrap();
        d.push(&client_frame(true, OP_PING, b"p")).unwrap();
        d.push(&client_frame(false, OP_CONT, long.as_bytes())).unwrap();
        d.push(&client_frame(true, OP_CONT, "\u{e9}".as_bytes())).unwrap();
        assert_eq!(d.next(), Ok(Some(Event::Ping(b"p".to_vec()))));
        assert_eq!(d.next(), Ok(Some(Event::Message(format!("ab{long}\u{e9}")))));
        d.push(&client_frame(true, OP_PONG, b"")).unwrap();
        d.push(&client_frame(true, OP_CLOSE, &1000u16.to_be_bytes())).unwrap();
        assert_eq!(d.next(), Ok(Some(Event::Pong)));
        assert_eq!(d.next(), Ok(Some(Event::Close(Some(1000)))));
        d.push(&client_frame(true, OP_CLOSE, b"")).unwrap();
        assert_eq!(d.next(), Ok(Some(Event::Close(None))));
    }

    #[test]
    fn refuses_what_the_protocol_forbids() {
        let bad = |bytes: Vec<u8>| {
            let mut d = Decoder::new(1024);
            d.push(&bytes)?;
            d.next()
        };
        // Unmasked, reserved bits, unknown opcode, a long or fragmented control frame.
        assert_eq!(bad(vec![0x81, 0x01, b'x']), Err(PROTOCOL_ERROR));
        let mut rsv = client_frame(true, OP_TEXT, b"x");
        rsv[0] |= 0x40;
        assert_eq!(bad(rsv), Err(PROTOCOL_ERROR));
        assert_eq!(bad(client_frame(true, 3, b"x")), Err(PROTOCOL_ERROR));
        assert_eq!(bad(client_frame(true, OP_PING, &[0u8; 126])), Err(PROTOCOL_ERROR));
        assert_eq!(bad(client_frame(false, OP_PING, b"x")), Err(PROTOCOL_ERROR));
        // A continuation without a start, a new message inside a fragmented one.
        assert_eq!(bad(client_frame(true, OP_CONT, b"x")), Err(PROTOCOL_ERROR));
        let mut two = client_frame(false, OP_TEXT, b"a");
        two.extend(client_frame(true, OP_TEXT, b"b"));
        assert_eq!(bad(two), Err(PROTOCOL_ERROR));
        // Binary, text that is not UTF-8, a one-byte close.
        assert_eq!(bad(client_frame(true, OP_BINARY, b"x")), Err(UNSUPPORTED));
        assert_eq!(bad(client_frame(true, OP_TEXT, &[0xff, 0xfe])), Err(INVALID_DATA));
        assert_eq!(bad(client_frame(true, OP_CLOSE, &[3])), Err(PROTOCOL_ERROR));
        // Over the size cap: refused on the declared length, also across fragments.
        assert_eq!(bad(client_frame(true, OP_TEXT, &[b'a'; 1025])), Err(TOO_BIG));
        let mut d = Decoder::new(1024);
        d.push(&client_frame(false, OP_TEXT, &[b'a'; 1000])).unwrap();
        d.push(&client_frame(true, OP_CONT, &[b'a'; 100])).unwrap();
        assert_eq!(d.next(), Err(TOO_BIG));
        // A NUL inside a text message would split it on the browser's pipe.
        assert_eq!(bad(client_frame(true, OP_TEXT, b"{\"a\":\"\0\"}")), Err(INVALID_DATA));
        // The decoder holds at most a message, its headers and one read.
        let mut d = Decoder::new(16);
        assert_eq!(d.push(&vec![0u8; 16 + CHUNK + 15]), Err(TOO_BIG));
        assert!(d.push(&vec![0u8; 16 + CHUNK]).is_ok());
        let mut huge = vec![0x81, 0x80 | 127];
        huge.extend_from_slice(&(u64::MAX).to_be_bytes());
        assert_eq!(bad(huge), Err(TOO_BIG));
    }

    #[test]
    fn encodes_server_frames() {
        assert_eq!(frame(OP_TEXT, b"hi"), vec![0x81, 2, b'h', b'i']);
        let f = frame(OP_TEXT, &[b'a'; 300]);
        assert_eq!(&f[..4], &[0x81, 126, 1, 44]);
        let f = frame(OP_TEXT, &vec![b'a'; 70_000]);
        assert_eq!(&f[..2], &[0x81, 127]);
        assert_eq!(u64::from_be_bytes(f[2..10].try_into().unwrap()), 70_000);
        assert_eq!(close_frame(1009), vec![0x88, 2, 0x03, 0xf1]);
        let (op, p) = read_frame(&mut &frame(OP_PONG, b"x")[..]).unwrap();
        assert_eq!((op, p), (OP_PONG, b"x".to_vec()));
    }
}
