//! Per-user sockets for the local runtime (FR-128, FR-192; contracts/hub-api.md §4). novad runs as
//! root, so its own socket (`<data>/local-runtime/runtime.sock`, 0600 root) is out of reach of the
//! desktop shell in the user's session. For each user the owner named (`config.json`
//! `localRuntime.users`, set by `novad install|enroll --user`), the local-runtime module binds a
//! socket only that user can open, in the user's own runtime folder:
//!
//! - Linux: `/run/user/<uid>/nova/runtime.sock` (the shell looks in `$XDG_RUNTIME_DIR/nova/`).
//!   logind makes `/run/user/<uid>` at login and removes it at logout, so the module checks every
//!   30 s: it binds once the folder exists and stops serving once the socket is gone.
//! - macOS: `/Users/<name>/Library/Application Support/Nova/run/runtime.sock`.
//!
//! The folder is 0700 and the socket 0600, both owned by the user; the file mode is the
//! authentication, as for the root socket, and every request passes the same admission (the
//! Hub's grant, the model routes). Root never creates, changes or follows anything in a folder the
//! user controls: a forked child switches to the user's ids (setgroups, setgid, setuid), makes the
//! folders and binds with umask 077, and hands the listening descriptor back over a socket pair
//! (SCM_RIGHTS). The user's folder must be a real directory owned by that uid, novad's folder in
//! it a real directory of the user, the socket path empty or a stale socket of the user; a link or
//! any other file there is refused. Root then only re-reads the metadata (a socket of the user,
//! 0600, one link, the inode the child reported).

use crate::local_runtime::valid_user;
use crate::util::{OpError, OpResult};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::Read;
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// How often user folders are checked for logins and logouts.
pub const RECHECK: Duration = Duration::from_secs(30);

/// A user account: ids, and the home folder (macOS).
#[derive(Debug, Clone, PartialEq)]
pub struct Account {
    pub uid: u32,
    pub gid: u32,
    pub home: PathBuf,
}

/// Looks users up by name (tests use a fixed table).
pub trait Users: Send + Sync {
    fn lookup(&self, name: &str) -> Option<Account>;
}

/// The system's users, through `id` (it asks NSS, so directory users resolve too).
pub struct SystemUsers;

impl Users for SystemUsers {
    fn lookup(&self, name: &str) -> Option<Account> {
        if !valid_user(name) {
            return None;
        }
        let id = |flag: &str| -> Option<u32> {
            let out = std::process::Command::new("id").args([flag, "--", name]).output().ok()?;
            if !out.status.success() {
                return None;
            }
            String::from_utf8(out.stdout).ok()?.trim().parse().ok()
        };
        // The home folder from the user database (directory users too), else the usual place.
        let home = if cfg!(target_os = "macos") {
            PathBuf::from("/Users").join(name)
        } else {
            std::process::Command::new("getent")
                .args(["passwd", "--", name])
                .output()
                .ok()
                .filter(|o| o.status.success())
                .and_then(|o| String::from_utf8(o.stdout).ok())
                .and_then(|l| l.trim().split(':').nth(5).filter(|h| h.starts_with('/')).map(PathBuf::from))
                .unwrap_or_else(|| PathBuf::from("/home").join(name))
        };
        Some(Account { uid: id("-u")?, gid: id("-g")?, home })
    }
}

/// Where a user's socket goes: the folder that must already exist and belong to the user, the
/// folders novad makes in it, and the socket.
#[derive(Debug, Clone, PartialEq)]
pub struct Layout {
    pub anchor: PathBuf,
    pub dirs: Vec<PathBuf>,
    pub socket: PathBuf,
}

/// Linux: under `run_root/<uid>` (`/run/user`); macOS: in the user's Application Support.
#[cfg(test)]
pub fn layout(a: &Account, run_root: &Path, macos: bool) -> Layout {
    layout_for(a, run_root, macos, "runtime.sock")
}

/// The same folders with another socket file (`bridge.sock`, the extension bridge of FR-096).
pub fn layout_for(a: &Account, run_root: &Path, macos: bool, file: &str) -> Layout {
    if macos {
        let anchor = a.home.join("Library").join("Application Support");
        let nova = anchor.join("Nova");
        let run = nova.join("run");
        Layout { socket: run.join(file), dirs: vec![nova, run], anchor }
    } else {
        let anchor = run_root.join(a.uid.to_string());
        let nova = anchor.join("nova");
        Layout { socket: nova.join(file), dirs: vec![nova], anchor }
    }
}

/// The child's report, sent with the listening descriptor (SCM_RIGHTS) when `code` is 0.
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct Report {
    code: u32,
    errno: i32,
    dev: u64,
    ino: u64,
}

const OK: u32 = 0;
const E_IDS: u32 = 1;
const E_ANCHOR: u32 = 2;
const E_DIR: u32 = 3;
const E_MKDIR: u32 = 4;
const E_OCCUPIED: u32 = 5;
const E_UNLINK: u32 = 6;
const E_BIND: u32 = 7;
const E_CHMOD: u32 = 8;
const E_STAT: u32 = 9;

fn errno() -> i32 {
    std::io::Error::last_os_error().raw_os_error().unwrap_or(0)
}

fn cpath(p: &Path) -> OpResult<std::ffi::CString> {
    use std::os::unix::ffi::OsStrExt;
    std::ffi::CString::new(p.as_os_str().as_bytes()).map_err(|_| OpError::validation(format!("{} has a NUL byte", p.display())))
}

/// lstat into a zeroed buffer (async-signal-safe: no allocation).
unsafe fn lstat(path: &std::ffi::CStr, st: &mut libc::stat) -> bool {
    unsafe { libc::lstat(path.as_ptr(), st) == 0 }
}

fn is(st: &libc::stat, kind: libc::mode_t) -> bool {
    (st.st_mode & libc::S_IFMT) == kind
}

/// The child, after fork: become the user, then make the folders and bind, all as the user, so
/// root never creates, changes or follows anything in the user's folder. Only async-signal-safe
/// calls on memory prepared before the fork; ends with `_exit`.
unsafe fn child(chan: libc::c_int, uid: u32, gid: u32, anchor: &std::ffi::CStr, dirs: &[std::ffi::CString], sock: &std::ffi::CStr, addr: &libc::sockaddr_un) -> ! {
    let mut r = Report::default();
    let fail = |r: &mut Report, code: u32| -> ! {
        r.code = code;
        r.errno = errno();
        unsafe { send_report(chan, r, -1) };
        unsafe { libc::_exit(code as libc::c_int) }
    };
    unsafe {
        if libc::getuid() == 0 && libc::setgroups(0, std::ptr::null()) != 0 {
            fail(&mut r, E_IDS);
        }
        if libc::setgid(gid as libc::gid_t) != 0 || libc::setuid(uid as libc::uid_t) != 0 || libc::geteuid() != uid || libc::getegid() != gid {
            fail(&mut r, E_IDS);
        }
        // Folders 0700 and the socket 0600 from the start.
        libc::umask(0o077);
        let mut st: libc::stat = std::mem::zeroed();
        if !lstat(anchor, &mut st) || !is(&st, libc::S_IFDIR) || st.st_uid != uid {
            fail(&mut r, E_ANCHOR);
        }
        for d in dirs {
            if libc::mkdir(d.as_ptr(), 0o700) != 0 {
                if errno() != libc::EEXIST {
                    fail(&mut r, E_MKDIR);
                }
                // Already there: it must be a real folder of this user (never a link).
                let mut st: libc::stat = std::mem::zeroed();
                if !lstat(d, &mut st) || !is(&st, libc::S_IFDIR) || st.st_uid != uid {
                    fail(&mut r, E_DIR);
                }
                if (st.st_mode & 0o777) != 0o700 && libc::chmod(d.as_ptr(), 0o700) != 0 {
                    fail(&mut r, E_CHMOD);
                }
            }
        }
        let mut st: libc::stat = std::mem::zeroed();
        if lstat(sock, &mut st) {
            // A stale socket of this user is replaced; anything else (a link, a file) is refused.
            if !is(&st, libc::S_IFSOCK) || st.st_uid != uid {
                fail(&mut r, E_OCCUPIED);
            }
            if libc::unlink(sock.as_ptr()) != 0 {
                fail(&mut r, E_UNLINK);
            }
        }
        let fd = libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0);
        if fd < 0
            || libc::bind(fd, addr as *const libc::sockaddr_un as *const libc::sockaddr, std::mem::size_of::<libc::sockaddr_un>() as libc::socklen_t) != 0
            || libc::listen(fd, 128) != 0
        {
            fail(&mut r, E_BIND);
        }
        if libc::chmod(sock.as_ptr(), 0o600) != 0 {
            fail(&mut r, E_CHMOD);
        }
        let mut st: libc::stat = std::mem::zeroed();
        if !lstat(sock, &mut st) || !is(&st, libc::S_IFSOCK) {
            fail(&mut r, E_STAT);
        }
        r.code = OK;
        r.dev = st.st_dev as u64;
        r.ino = st.st_ino as u64;
        send_report(chan, &r, fd);
        libc::_exit(0)
    }
}

/// One message: the report, and the descriptor when there is one (SCM_RIGHTS).
unsafe fn send_report(chan: libc::c_int, r: &Report, fd: libc::c_int) {
    unsafe {
        let mut iov = libc::iovec { iov_base: r as *const Report as *mut libc::c_void, iov_len: std::mem::size_of::<Report>() };
        // An aligned buffer on the stack: no allocation after fork.
        let mut cbuf = [0u64; 8];
        let mut msg: libc::msghdr = std::mem::zeroed();
        msg.msg_iov = &mut iov;
        msg.msg_iovlen = 1;
        if fd >= 0 {
            let space = libc::CMSG_SPACE(std::mem::size_of::<libc::c_int>() as u32) as usize;
            msg.msg_control = cbuf.as_mut_ptr() as *mut libc::c_void;
            msg.msg_controllen = space as _;
            let cmsg = libc::CMSG_FIRSTHDR(&msg);
            (*cmsg).cmsg_level = libc::SOL_SOCKET;
            (*cmsg).cmsg_type = libc::SCM_RIGHTS;
            (*cmsg).cmsg_len = libc::CMSG_LEN(std::mem::size_of::<libc::c_int>() as u32) as _;
            std::ptr::write_unaligned(libc::CMSG_DATA(cmsg) as *mut libc::c_int, fd);
        }
        libc::sendmsg(chan, &msg, 0);
    }
}

/// The report and the descriptor (or -1) the child sent.
fn receive_report(chan: &std::os::unix::net::UnixStream) -> std::io::Result<(Report, libc::c_int)> {
    use std::os::fd::AsRawFd;
    let mut r = Report::default();
    let mut iov = libc::iovec { iov_base: &mut r as *mut Report as *mut libc::c_void, iov_len: std::mem::size_of::<Report>() };
    let mut cbuf = [0u64; 8];
    let mut msg: libc::msghdr = unsafe { std::mem::zeroed() };
    msg.msg_iov = &mut iov;
    msg.msg_iovlen = 1;
    msg.msg_control = cbuf.as_mut_ptr() as *mut libc::c_void;
    msg.msg_controllen = std::mem::size_of_val(&cbuf) as _;
    let n = unsafe { libc::recvmsg(chan.as_raw_fd(), &mut msg, 0) };
    if n < 0 {
        return Err(std::io::Error::last_os_error());
    }
    if n as usize != std::mem::size_of::<Report>() {
        return Err(std::io::Error::other("the socket helper sent no report"));
    }
    let mut fd = -1;
    unsafe {
        let mut cmsg = libc::CMSG_FIRSTHDR(&msg);
        while !cmsg.is_null() {
            if (*cmsg).cmsg_level == libc::SOL_SOCKET && (*cmsg).cmsg_type == libc::SCM_RIGHTS {
                fd = std::ptr::read_unaligned(libc::CMSG_DATA(cmsg) as *const libc::c_int);
            }
            cmsg = libc::CMSG_NXTHDR(&msg, cmsg);
        }
    }
    Ok((r, fd))
}

/// Make the folders and bind the socket as the user (a forked child that switched to the user's
/// ids), and take the listening descriptor back over a socket pair: root never creates, changes
/// or follows anything inside the user's folder; it only reads metadata there. Ok(None) when the
/// user's folder does not exist yet (not logged in). Ok gives the listener and the socket's inode.
pub fn bind(a: &Account, l: &Layout) -> OpResult<Option<(UnixListener, u64)>> {
    use std::os::fd::{AsRawFd, FromRawFd};
    let anchor = match std::fs::symlink_metadata(&l.anchor) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    if !anchor.file_type().is_dir() || anchor.uid() != a.uid {
        return Err(refuse(&l.anchor, "is not a folder owned by the user"));
    }
    // Everything the child needs is prepared here: it may not allocate after the fork.
    let anchor_c = cpath(&l.anchor)?;
    let dirs_c = l.dirs.iter().map(|d| cpath(d)).collect::<OpResult<Vec<_>>>()?;
    let sock_c = cpath(&l.socket)?;
    let mut addr: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    addr.sun_family = libc::AF_UNIX as libc::sa_family_t;
    let bytes = sock_c.as_bytes();
    if bytes.len() >= addr.sun_path.len() {
        return Err(OpError::validation(format!("{} is too long for a socket path", l.socket.display())));
    }
    for (i, b) in bytes.iter().enumerate() {
        addr.sun_path[i] = *b as libc::c_char;
    }
    #[cfg(any(target_os = "macos", target_os = "freebsd"))]
    {
        addr.sun_len = std::mem::size_of::<libc::sockaddr_un>() as u8;
    }
    let (parent, kid) = std::os::unix::net::UnixStream::pair()?;
    parent.set_read_timeout(Some(Duration::from_secs(10)))?;
    let pid = unsafe { libc::fork() };
    if pid < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    if pid == 0 {
        unsafe { child(kid.as_raw_fd(), a.uid, a.gid, &anchor_c, &dirs_c, &sock_c, &addr) }
    }
    drop(kid);
    let received = receive_report(&parent);
    let mut status = 0;
    unsafe { libc::waitpid(pid, &mut status, 0) };
    let (r, fd) = received.map_err(|e| OpError::internal(format!("the socket helper failed: {e}")))?;
    if r.code != OK || fd < 0 {
        if fd >= 0 {
            unsafe { libc::close(fd) };
        }
        let os = std::io::Error::from_raw_os_error(r.errno);
        return Err(match r.code {
            E_IDS => OpError::denied("os_permission", format!("cannot switch to user {} ({os})", a.uid)),
            E_ANCHOR => refuse(&l.anchor, "is not a folder owned by the user"),
            E_DIR => refuse(l.socket.parent().unwrap_or(&l.anchor), "or a folder above it is not a folder of the user (a link or another file)"),
            E_OCCUPIED => refuse(&l.socket, "exists and is not a socket of the user (a link or another file)"),
            _ => OpError::internal(format!("cannot make the socket {} ({os})", l.socket.display())),
        });
    }
    let listener = unsafe { UnixListener::from_raw_fd(fd) };
    unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) };
    // Read-only re-check: the file there is the socket the child made, owned by the user, 0600,
    // with one link.
    let m = std::fs::symlink_metadata(&l.socket)?;
    if !m.file_type().is_socket() || m.uid() != a.uid || m.ino() != r.ino || m.dev() != r.dev || m.nlink() != 1 || m.mode() & 0o777 != 0o600 {
        return Err(refuse(&l.socket, "changed while it was being made"));
    }
    Ok(Some((listener, r.ino)))
}

fn refuse(path: &Path, why: &str) -> OpError {
    OpError::denied("unsafe_path", format!("{} {why}; no socket was made there", path.display()))
}

/// The uid of the process at the other end of a Unix socket connection.
pub fn peer_uid(s: &std::os::unix::net::UnixStream) -> Option<u32> {
    use std::os::fd::AsRawFd;
    #[cfg(target_os = "linux")]
    {
        let mut cred: libc::ucred = unsafe { std::mem::zeroed() };
        let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
        let r = unsafe { libc::getsockopt(s.as_raw_fd(), libc::SOL_SOCKET, libc::SO_PEERCRED, &mut cred as *mut libc::ucred as *mut libc::c_void, &mut len) };
        (r == 0).then_some(cred.uid)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let (mut uid, mut gid): (libc::uid_t, libc::gid_t) = (0, 0);
        (unsafe { libc::getpeereid(s.as_raw_fd(), &mut uid, &mut gid) } == 0).then_some(uid)
    }
}

/// What the reading child reports before the bytes.
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct ReadReport {
    code: u32,
    errno: i32,
    len: u64,
}

const E_OPEN: u32 = 10;
const E_NOT_PRIVATE: u32 = 11;
const E_READ: u32 = 12;

/// Read a small private file of the user's (a token in their home folder) as that user: a forked
/// child switches to the user's ids and opens it without following a link, so root never follows
/// anything the user controls. The file must be a regular file of the user, mode 0600 or
/// stricter, at most `max` bytes. Ok(None) when it does not exist.
pub fn read_as(a: &Account, path: &Path, max: usize) -> OpResult<Option<Vec<u8>>> {
    use std::os::fd::AsRawFd;
    let path_c = cpath(path)?;
    // Allocated before the fork: the child may not allocate.
    let mut buf = vec![0u8; max];
    let (parent, kid) = std::os::unix::net::UnixStream::pair()?;
    parent.set_read_timeout(Some(Duration::from_secs(10)))?;
    let pid = unsafe { libc::fork() };
    if pid < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    if pid == 0 {
        unsafe {
            let chan = kid.as_raw_fd();
            let mut r = ReadReport::default();
            let send = |r: &ReadReport, data: &[u8]| {
                libc::write(chan, r as *const ReadReport as *const libc::c_void, std::mem::size_of::<ReadReport>());
                if !data.is_empty() {
                    libc::write(chan, data.as_ptr() as *const libc::c_void, data.len());
                }
            };
            let fail = |r: &mut ReadReport, code: u32| -> ! {
                r.code = code;
                r.errno = errno();
                send(r, &[]);
                libc::_exit(code as libc::c_int)
            };
            if libc::getuid() == 0 && libc::setgroups(0, std::ptr::null()) != 0 {
                fail(&mut r, E_IDS);
            }
            if libc::setgid(a.gid as libc::gid_t) != 0 || libc::setuid(a.uid as libc::uid_t) != 0 || libc::geteuid() != a.uid {
                fail(&mut r, E_IDS);
            }
            let fd = libc::open(path_c.as_ptr(), libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NOCTTY | libc::O_NONBLOCK);
            if fd < 0 {
                fail(&mut r, E_OPEN);
            }
            let mut st: libc::stat = std::mem::zeroed();
            if libc::fstat(fd, &mut st) != 0 || !is(&st, libc::S_IFREG) || st.st_uid != a.uid || (st.st_mode & 0o077) != 0 || st.st_size as u64 > buf.len() as u64 {
                fail(&mut r, E_NOT_PRIVATE);
            }
            let mut n = 0usize;
            while n < buf.len() {
                let got = libc::read(fd, buf.as_mut_ptr().add(n) as *mut libc::c_void, buf.len() - n);
                if got < 0 {
                    fail(&mut r, E_READ);
                }
                if got == 0 {
                    break;
                }
                n += got as usize;
            }
            r.code = OK;
            r.len = n as u64;
            send(&r, &buf[..n]);
            libc::_exit(0)
        }
    }
    drop(kid);
    let mut head = [0u8; std::mem::size_of::<ReadReport>()];
    let got = (&parent).read_exact(&mut head);
    let mut status = 0;
    let r: ReadReport = unsafe { std::ptr::read_unaligned(head.as_ptr() as *const ReadReport) };
    let data = if got.is_ok() && r.code == OK && r.len as usize <= max {
        let mut d = vec![0u8; r.len as usize];
        (&parent).read_exact(&mut d).map(|_| d).ok()
    } else {
        None
    };
    unsafe { libc::waitpid(pid, &mut status, 0) };
    got.map_err(|e| OpError::internal(format!("the file helper failed: {e}")))?;
    match r.code {
        OK => data.map(Some).ok_or_else(|| OpError::internal("the file helper sent too little")),
        E_OPEN if r.errno == libc::ENOENT || r.errno == libc::ENOTDIR => Ok(None),
        E_IDS => Err(OpError::denied("os_permission", format!("cannot switch to user {}", a.uid))),
        E_NOT_PRIVATE => Err(OpError::denied("unsafe_path", format!("{} is not a private file of the user (mode 0600, at most {max} bytes)", path.display()))),
        E_OPEN if r.errno == libc::ELOOP => Err(OpError::denied("unsafe_path", format!("{} is a link; it was not followed", path.display()))),
        _ => Err(OpError::internal(format!("cannot read {} ({})", path.display(), std::io::Error::from_raw_os_error(r.errno)))),
    }
}

/// Remove files of a user's (Nova's own manifests and token in their home) as that user: a
/// forked child switches to the user's ids and unlinks each path (a link is removed, never
/// followed), so root changes nothing in a folder the user controls. The number removed.
pub fn remove_as(a: &Account, paths: &[PathBuf]) -> OpResult<usize> {
    use std::os::fd::AsRawFd;
    let cs = paths.iter().map(|p| cpath(p)).collect::<OpResult<Vec<_>>>()?;
    let (parent, kid) = std::os::unix::net::UnixStream::pair()?;
    parent.set_read_timeout(Some(Duration::from_secs(10)))?;
    let pid = unsafe { libc::fork() };
    if pid < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    if pid == 0 {
        unsafe {
            let chan = kid.as_raw_fd();
            let mut out: [u32; 2] = [OK, 0];
            if (libc::getuid() == 0 && libc::setgroups(0, std::ptr::null()) != 0) || libc::setgid(a.gid as libc::gid_t) != 0 || libc::setuid(a.uid as libc::uid_t) != 0 || libc::geteuid() != a.uid {
                out[0] = E_IDS;
            } else {
                for c in &cs {
                    if libc::unlink(c.as_ptr()) == 0 {
                        out[1] += 1;
                    }
                }
            }
            libc::write(chan, out.as_ptr() as *const libc::c_void, std::mem::size_of_val(&out));
            libc::_exit(0)
        }
    }
    drop(kid);
    let mut buf = [0u8; 8];
    let got = (&parent).read_exact(&mut buf);
    let mut status = 0;
    unsafe { libc::waitpid(pid, &mut status, 0) };
    got.map_err(|e| OpError::internal(format!("the file helper failed: {e}")))?;
    let code = u32::from_ne_bytes([buf[0], buf[1], buf[2], buf[3]]);
    if code != OK {
        return Err(OpError::denied("os_permission", format!("cannot switch to user {}", a.uid)));
    }
    Ok(u32::from_ne_bytes([buf[4], buf[5], buf[6], buf[7]]) as usize)
}

struct Bound {
    socket: PathBuf,
    /// The socket file's identity, so a replaced or removed file is noticed.
    ino: u64,
    stop: Arc<AtomicBool>,
}

/// The per-user sockets of one listener kind: the local runtime's (`runtime.sock`) or the
/// extension bridge's (`bridge.sock`), each with its own admission in `serve`.
pub struct UserSockets {
    names: Vec<String>,
    file: String,
    label: String,
    users: Box<dyn Users>,
    run_root: PathBuf,
    macos: bool,
    serve: Arc<dyn Fn(std::os::unix::net::UnixStream) + Send + Sync>,
    bound: Mutex<HashMap<String, Bound>>,
    problems: Mutex<HashMap<String, String>>,
}

impl UserSockets {
    /// `serve` handles one accepted connection (the runtime's socket admission).
    pub fn new(names: Vec<String>, users: Box<dyn Users>, run_root: PathBuf, macos: bool, serve: Arc<dyn Fn(std::os::unix::net::UnixStream) + Send + Sync>) -> UserSockets {
        UserSockets { names, file: "runtime.sock".into(), label: "local-runtime".into(), users, run_root, macos, serve, bound: Mutex::new(HashMap::new()), problems: Mutex::new(HashMap::new()) }
    }

    /// Another listener kind in the same folders: its socket file and its name in the log.
    pub fn named(mut self, file: &str, label: &str) -> UserSockets {
        self.file = file.into();
        self.label = label.into();
        self
    }

    /// The system's layout: `/run/user` on Linux, the home folder on macOS.
    pub fn system(names: Vec<String>, serve: Arc<dyn Fn(std::os::unix::net::UnixStream) + Send + Sync>) -> UserSockets {
        UserSockets::new(names, Box::new(SystemUsers), PathBuf::from("/run/user"), cfg!(target_os = "macos"), serve)
    }

    /// Bind for users who logged in, stop serving those whose socket is gone (logged out).
    pub fn recheck(&self) {
        for name in &self.names {
            let r = self.check(name);
            let mut p = self.problems.lock().unwrap_or_else(|e| e.into_inner());
            match r {
                Ok(()) => {
                    p.remove(name);
                }
                Err(e) => {
                    if p.get(name) != Some(&e.message) {
                        eprintln!("novad {}: user {name}: {}", self.label, e.message);
                    }
                    p.insert(name.clone(), e.message);
                }
            }
        }
    }

    fn check(&self, name: &str) -> OpResult<()> {
        let mut bound = self.bound.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(b) = bound.get(name) {
            let same = std::fs::symlink_metadata(&b.socket).is_ok_and(|m| m.file_type().is_socket() && m.ino() == b.ino);
            if same {
                return Ok(());
            }
            // Logged out (the runtime folder went away) or the file was replaced.
            b.stop.store(true, Ordering::SeqCst);
            bound.remove(name);
        }
        if !valid_user(name) {
            return Err(OpError::validation(format!("{name:?} is not a valid user name")));
        }
        let a = self.users.lookup(name).ok_or_else(|| OpError::not_found(format!("no user named {name}")))?;
        let l = layout_for(&a, &self.run_root, self.macos, &self.file);
        let Some((listener, ino)) = bind(&a, &l)? else { return Ok(()) };
        let stop = Arc::new(AtomicBool::new(false));
        listener.set_nonblocking(true)?;
        let (serve, flag) = (self.serve.clone(), stop.clone());
        std::thread::spawn(move || {
            while !flag.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((conn, _)) => {
                        let _ = conn.set_nonblocking(false);
                        // The server takes a connection slot before any thread starts.
                        serve(conn);
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(100)),
                    Err(_) => std::thread::sleep(Duration::from_millis(100)),
                }
            }
        });
        bound.insert(name.to_string(), Bound { socket: l.socket, ino, stop });
        Ok(())
    }

    /// Check now, then every `every` on a thread of its own.
    pub fn watch(self: &Arc<Self>, every: Duration) {
        self.recheck();
        let me = self.clone();
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(every);
                me.recheck();
            }
        });
    }

    /// For the module's `status`: each user's socket, or why there is none.
    pub fn status(&self) -> Value {
        let bound = self.bound.lock().unwrap_or_else(|e| e.into_inner());
        let problems = self.problems.lock().unwrap_or_else(|e| e.into_inner());
        json!(self
            .names
            .iter()
            .map(|n| json!({
                "user": n,
                "socket": bound.get(n).map(|b| b.socket.clone()),
                "problem": problems.get(n),
            }))
            .collect::<Vec<_>>())
    }

    /// Stop serving every socket (tests; the module exits with the supervisor otherwise).
    #[cfg(test)]
    pub fn stop(&self) {
        for (_, b) in self.bound.lock().unwrap_or_else(|e| e.into_inner()).drain() {
            b.stop.store(true, Ordering::SeqCst);
            let _ = std::fs::remove_file(&b.socket);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::grants::tests::tmp;
    use std::io::{Read, Write};
    use std::os::unix::fs::PermissionsExt;

    /// The test process's own ids: chown to them works without privileges.
    fn me(dir: &Path) -> Account {
        let m = std::fs::metadata(dir).unwrap();
        Account { uid: m.uid(), gid: m.gid(), home: dir.join("home") }
    }

    struct Table(HashMap<String, Account>);

    impl Users for Table {
        fn lookup(&self, name: &str) -> Option<Account> {
            self.0.get(name).cloned()
        }
    }

    fn echo() -> Arc<dyn Fn(std::os::unix::net::UnixStream) + Send + Sync> {
        Arc::new(|mut s: std::os::unix::net::UnixStream| {
            let _ = s.write_all(b"hello");
        })
    }

    fn read_from(path: &Path) -> String {
        let mut s = std::os::unix::net::UnixStream::connect(path).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).unwrap();
        out
    }

    #[test]
    fn binds_in_the_users_runtime_folder_with_private_modes() {
        let base = tmp("usock");
        let a = me(&base);
        let root = base.join("run-user");
        std::fs::create_dir_all(&root).unwrap();
        let l = layout(&a, &root, false);
        assert_eq!(l.socket, root.join(a.uid.to_string()).join("nova").join("runtime.sock"));
        // Not logged in: nothing to do yet.
        assert!(bind(&a, &l).unwrap().is_none());
        std::fs::create_dir(&l.anchor).unwrap();
        let (listener, ino) = bind(&a, &l).unwrap().unwrap();
        assert_eq!(std::fs::symlink_metadata(&l.socket).unwrap().ino(), ino);
        // The descriptor that came back is the listening socket at that path.
        listener.set_nonblocking(false).unwrap();
        let path = l.socket.clone();
        let t = std::thread::spawn(move || std::os::unix::net::UnixStream::connect(&path).unwrap().write_all(b"x").unwrap());
        let mut got = [0u8; 1];
        listener.accept().unwrap().0.read_exact(&mut got).unwrap();
        t.join().unwrap();
        assert_eq!(&got, b"x");
        let dir = std::fs::metadata(&l.dirs[0]).unwrap();
        let sock = std::fs::symlink_metadata(&l.socket).unwrap();
        assert_eq!((dir.permissions().mode() & 0o777, dir.uid(), dir.gid()), (0o700, a.uid, a.gid));
        assert_eq!((sock.permissions().mode() & 0o777, sock.uid(), sock.gid()), (0o600, a.uid, a.gid));
        assert!(sock.file_type().is_socket());
        drop(listener);
        // A stale socket from an earlier run is replaced.
        assert!(bind(&a, &l).unwrap().is_some());
        // macOS keeps it under Application Support (a short home: socket paths are short).
        let home = std::env::temp_dir().join(format!("nvm{}", std::process::id()));
        let mac_user = Account { home: home.clone(), ..a.clone() };
        let mac = layout(&mac_user, &root, true);
        assert_eq!(mac.socket, home.join("Library/Application Support/Nova/run/runtime.sock"));
        assert_eq!(mac.dirs.len(), 2);
        std::fs::create_dir_all(&mac.anchor).unwrap();
        assert!(bind(&mac_user, &mac).unwrap().is_some());
        for dir in &mac.dirs {
            assert_eq!(std::fs::metadata(dir).unwrap().permissions().mode() & 0o777, 0o700);
        }
        std::fs::remove_dir_all(&home).unwrap();
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn refuses_links_foreign_folders_and_other_files() {
        let base = tmp("usock-bad");
        let a = me(&base);
        let root = base.join("run-user");
        let l = layout(&a, &root, false);
        std::fs::create_dir_all(&l.anchor).unwrap();
        // The user's folder belongs to someone else (another uid than the account's).
        let other = Account { uid: a.uid.wrapping_add(1), ..a.clone() };
        let lo = Layout { anchor: l.anchor.clone(), ..layout(&other, &root, false) };
        assert_eq!(bind(&other, &lo).unwrap_err().details.unwrap()["reason"], "unsafe_path");
        // novad's folder is a link somewhere else: never followed.
        let elsewhere = base.join("elsewhere");
        std::fs::create_dir(&elsewhere).unwrap();
        std::os::unix::fs::symlink(&elsewhere, &l.dirs[0]).unwrap();
        assert!(bind(&a, &l).unwrap_err().message.contains("link"));
        assert!(std::fs::read_dir(&elsewhere).unwrap().next().is_none(), "nothing made through the link");
        std::fs::remove_file(&l.dirs[0]).unwrap();
        // A regular file where the socket goes is left alone.
        std::fs::create_dir(&l.dirs[0]).unwrap();
        std::fs::write(&l.socket, b"keep me").unwrap();
        assert!(bind(&a, &l).unwrap_err().message.contains("not a socket"));
        assert_eq!(std::fs::read(&l.socket).unwrap(), b"keep me");
        std::fs::remove_file(&l.socket).unwrap();
        // A hard link to another file planted where the socket goes: refused, and the file's mode,
        // owner and content stay as they were (nothing is changed through it).
        let victim = base.join("victim");
        std::fs::write(&victim, b"precious").unwrap();
        std::fs::set_permissions(&victim, std::fs::Permissions::from_mode(0o644)).unwrap();
        std::fs::hard_link(&victim, &l.socket).unwrap();
        assert!(bind(&a, &l).unwrap_err().message.contains("not a socket"));
        let v = std::fs::metadata(&victim).unwrap();
        assert_eq!((v.permissions().mode() & 0o777, v.nlink()), (0o644, 2));
        assert_eq!(std::fs::read(&victim).unwrap(), b"precious");
        // A link where the socket goes is refused too.
        std::fs::remove_file(&l.socket).unwrap();
        std::os::unix::fs::symlink(base.join("target"), &l.socket).unwrap();
        assert!(bind(&a, &l).unwrap_err().message.contains("not a socket"));
        assert!(!base.join("target").exists());
        // A link to an existing file: refused, the file untouched.
        std::fs::remove_file(&l.socket).unwrap();
        std::os::unix::fs::symlink(&victim, &l.socket).unwrap();
        assert!(bind(&a, &l).is_err());
        assert_eq!(std::fs::metadata(&victim).unwrap().permissions().mode() & 0o777, 0o644);
        // The anchor itself as a link is not a folder of the user's.
        let link_root = base.join("link-root");
        std::fs::create_dir(&link_root).unwrap();
        std::os::unix::fs::symlink(&l.anchor, link_root.join(a.uid.to_string())).unwrap();
        assert!(bind(&a, &layout(&a, &link_root, false)).is_err());
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn hands_the_descriptor_back_with_its_report() {
        use std::os::fd::{AsRawFd, FromRawFd};
        let (a, b) = std::os::unix::net::UnixStream::pair().unwrap();
        let (x, mut y) = std::os::unix::net::UnixStream::pair().unwrap();
        let r = Report { code: OK, errno: 0, dev: 7, ino: 42 };
        unsafe { send_report(a.as_raw_fd(), &r, x.as_raw_fd()) };
        let (got, fd) = receive_report(&b).unwrap();
        assert_eq!((got.code, got.dev, got.ino), (OK, 7, 42));
        assert!(fd >= 0 && fd != x.as_raw_fd(), "a new descriptor for the same socket");
        let mut passed = unsafe { std::os::unix::net::UnixStream::from_raw_fd(fd) };
        passed.write_all(b"z").unwrap();
        let mut c = [0u8; 1];
        y.read_exact(&mut c).unwrap();
        assert_eq!(&c, b"z");
        // A failure report carries no descriptor.
        unsafe { send_report(a.as_raw_fd(), &Report { code: E_OCCUPIED, ..Report::default() }, -1) };
        assert_eq!(receive_report(&b).unwrap().1, -1);
        drop(a);
        assert!(receive_report(&b).is_err(), "a helper that died sends nothing");
    }

    #[test]
    fn serves_after_login_and_stops_after_logout() {
        let base = tmp("usock-watch");
        let a = me(&base);
        let root = base.join("run-user");
        std::fs::create_dir_all(&root).unwrap();
        let users = Table(HashMap::from([("alice".to_string(), a.clone())]));
        let s = UserSockets::new(vec!["alice".into(), "bob".into(), "-bad".into()], Box::new(users), root.clone(), false, echo());
        s.recheck();
        let st = s.status();
        assert_eq!(st[0]["socket"], Value::Null, "alice is not logged in yet");
        assert!(st[1]["problem"].as_str().unwrap().contains("no user named bob"));
        assert!(st[2]["problem"].as_str().unwrap().contains("not a valid user name"));
        // Login: logind makes the folder; the next check binds.
        let l = layout(&a, &root, false);
        std::fs::create_dir(&l.anchor).unwrap();
        s.recheck();
        assert_eq!(s.status()[0]["socket"], json!(l.socket));
        assert_eq!(read_from(&l.socket), "hello");
        s.recheck();
        assert_eq!(read_from(&l.socket), "hello", "still the same socket");
        // Logout: the folder goes; the next check stops serving.
        std::fs::remove_dir_all(&l.anchor).unwrap();
        s.recheck();
        assert_eq!(s.status()[0]["socket"], Value::Null);
        // Login again: a new socket.
        std::fs::create_dir(&l.anchor).unwrap();
        s.recheck();
        assert_eq!(read_from(&l.socket), "hello");
        s.stop();
        assert!(!l.socket.exists());
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn reads_a_private_file_as_the_user_without_following_links() {
        let base = tmp("usock-read");
        let a = me(&base);
        let f = base.join("token");
        std::fs::write(&f, b"nvbr_secret").unwrap();
        std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(read_as(&a, &f, 256).unwrap().as_deref(), Some(&b"nvbr_secret"[..]));
        assert_eq!(read_as(&a, &base.join("none"), 256).unwrap(), None);
        assert_eq!(read_as(&a, &base.join("none/deeper"), 256).unwrap(), None);
        // Too big, readable by others, a link, a folder: refused.
        assert_eq!(read_as(&a, &f, 4).unwrap_err().details.unwrap()["reason"], "unsafe_path");
        std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(read_as(&a, &f, 256).unwrap_err().details.unwrap()["reason"], "unsafe_path");
        std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o600)).unwrap();
        let link = base.join("link");
        std::os::unix::fs::symlink(&f, &link).unwrap();
        let e = read_as(&a, &link, 256).unwrap_err();
        assert!(e.message.contains("link"), "{}", e.message);
        assert!(read_as(&a, &base, 256).is_err());
        // Another user's ids: only root may switch to them.
        if unsafe { libc::geteuid() } != 0 {
            let other = Account { uid: a.uid + 1, ..a.clone() };
            assert_eq!(read_as(&other, &f, 256).unwrap_err().details.unwrap()["reason"], "os_permission");
        }
        // The connecting process's uid comes from the kernel.
        let (x, _y) = std::os::unix::net::UnixStream::pair().unwrap();
        assert_eq!(peer_uid(&x), Some(unsafe { libc::geteuid() }));
        // Other socket files go in the same folders.
        let l = layout_for(&a, Path::new("/run/user"), false, "bridge.sock");
        assert_eq!(l.socket, PathBuf::from(format!("/run/user/{}/nova/bridge.sock", a.uid)));
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn removes_a_users_files_as_the_user() {
        let base = tmp("usock-rm");
        let a = me(&base);
        let f1 = base.join("one.json");
        let f2 = base.join("two");
        std::fs::write(&f1, "x").unwrap();
        // A link is removed itself; its target stays.
        let target = base.join("target");
        std::fs::write(&target, "keep").unwrap();
        std::os::unix::fs::symlink(&target, &f2).unwrap();
        assert_eq!(remove_as(&a, &[f1.clone(), f2.clone(), base.join("missing")]).unwrap(), 2);
        assert!(!f1.exists() && std::fs::symlink_metadata(&f2).is_err() && target.exists());
        if unsafe { libc::geteuid() } != 0 {
            let other = Account { uid: a.uid + 1, ..a.clone() };
            assert_eq!(remove_as(&other, &[target.clone()]).unwrap_err().details.unwrap()["reason"], "os_permission");
            assert!(target.exists());
        }
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn looks_users_up_with_id() {
        // root is in every passwd (the test may run as a uid without a name of its own).
        let root = SystemUsers.lookup("root").unwrap();
        assert_eq!((root.uid, root.gid), (0, 0));
        assert!(SystemUsers.lookup("no-such-user-nova-test").is_none());
        assert!(SystemUsers.lookup("--help").is_none());
        assert!(valid_user("alice") && valid_user("a.b-c_1") && !valid_user("") && !valid_user("-x") && !valid_user(".x") && !valid_user("a b") && !valid_user("a/b"));
    }
}
