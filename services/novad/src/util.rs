//! Small shared pieces: the operation error (mapped to the Hub's error codes, contracts/README.md
//! "Errors"), timestamps, ids and atomic file writes.

use serde_json::{Value, json};
use std::io::Write;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

/// An operation failure. `code` is one of the Hub's error codes so the Hub can pass it through.
#[derive(Debug, Clone, PartialEq)]
pub struct OpError {
    pub status: u16,
    pub code: String,
    pub message: String,
    pub details: Option<Value>,
}

impl OpError {
    pub fn new(status: u16, code: &str, message: impl Into<String>) -> Self {
        OpError { status, code: code.to_string(), message: message.into(), details: None }
    }
    pub fn with(mut self, details: Value) -> Self {
        self.details = Some(details);
        self
    }
    pub fn validation(message: impl Into<String>) -> Self {
        Self::new(400, "validation", message)
    }
    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(404, "not_found", message)
    }
    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(409, "conflict", message)
    }
    /// A policy refusal; `reason` goes into `details.reason` for the Hub and the UI.
    pub fn denied(reason: &str, message: impl Into<String>) -> Self {
        Self::new(403, "policy_denied", message).with(json!({ "reason": reason }))
    }
    pub fn unavailable(message: impl Into<String>) -> Self {
        Self::new(503, "node_unavailable", message)
    }
    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(500, "server_error", message)
    }
    pub fn to_json(&self) -> Value {
        let mut v = json!({ "code": self.code, "message": self.message });
        if let Some(d) = &self.details {
            v["details"] = d.clone();
        }
        v
    }
    pub fn from_json(status: u16, v: &Value) -> Self {
        OpError {
            status,
            code: v["code"].as_str().unwrap_or("server_error").to_string(),
            message: v["message"].as_str().unwrap_or("unknown error").to_string(),
            details: v.get("details").cloned(),
        }
    }
}

impl std::fmt::Display for OpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl From<std::io::Error> for OpError {
    fn from(e: std::io::Error) -> Self {
        match e.kind() {
            std::io::ErrorKind::NotFound => OpError::not_found(e.to_string()),
            std::io::ErrorKind::PermissionDenied => OpError::denied("os_permission", e.to_string()),
            _ => OpError::internal(e.to_string()),
        }
    }
}

pub type OpResult<T> = Result<T, OpError>;

/// Milliseconds since the Unix epoch.
pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// RFC 3339 UTC timestamp with milliseconds, like JavaScript's `toISOString`.
pub fn iso(ms: u64) -> String {
    let secs = (ms / 1000) as i64;
    let millis = ms % 1000;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// Days since 1970-01-01 for a civil date (Howard Hinnant's days_from_civil).
pub fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Unix seconds from an RFC 3339 UTC timestamp like `toISOString` writes
/// (`2026-10-17T15:20:00.000Z`, fraction optional); None for anything else.
pub fn parse_iso(s: &str) -> Option<u64> {
    let b = s.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' || *b.last()? != b'Z' {
        return None;
    }
    let num = |r: std::ops::Range<usize>| -> Option<i64> { s.get(r).filter(|t| t.bytes().all(|c| c.is_ascii_digit()))?.parse().ok() };
    let (y, mo, d, h, mi, se) = (num(0..4)?, num(5..7)?, num(8..10)?, num(11..13)?, num(14..16)?, num(17..19)?);
    let frac = &s[19..s.len() - 1];
    if !(frac.is_empty() || (frac.starts_with('.') && frac.len() > 1 && frac[1..].bytes().all(|c| c.is_ascii_digit()))) {
        return None;
    }
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || se > 60 {
        return None;
    }
    u64::try_from(days_from_civil(y, mo, d) * 86_400 + h * 3600 + mi * 60 + se).ok()
}

pub fn now_iso() -> String {
    iso(now_ms())
}

/// A random id: 16 bytes as lowercase hex.
pub fn new_id() -> String {
    let mut b = [0u8; 16];
    if crate::crypto::random_bytes(&mut b).is_err() {
        // Ids are not secrets; fall back to time and pid rather than failing the operation.
        let t = now_ms().to_le_bytes();
        b[..8].copy_from_slice(&t);
        b[8..12].copy_from_slice(&std::process::id().to_le_bytes());
    }
    crate::crypto::hex(&b)
}

/// A random bearer token with a prefix, e.g. `nvdm_…` (32 random bytes, base64url).
pub fn new_token(prefix: &str) -> Result<String, String> {
    let mut b = [0u8; 32];
    crate::crypto::random_bytes(&mut b)?;
    Ok(format!("{prefix}{}", crate::crypto::b64url_encode(&b)))
}

/// Write a file atomically: a temporary file in the same folder, fsync, rename. `private` makes
/// it mode 0600 (keys, tokens).
pub fn write_atomic(path: &Path, data: &[u8], private: bool) -> std::io::Result<()> {
    let dir = path.parent().unwrap_or(Path::new("."));
    std::fs::create_dir_all(dir)?;
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let tmp = dir.join(format!(".{name}.{}.tmp", new_id()));
    {
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(if private { 0o600 } else { 0o644 });
        }
        let mut f = opts.open(&tmp)?;
        f.write_all(data)?;
        f.sync_all()?;
    }
    match std::fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(e)
        }
    }
}

/// Read a JSON file, or `default` when it does not exist.
pub fn read_json_or<T: serde::de::DeserializeOwned>(path: &Path, default: T) -> std::io::Result<T> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, format!("{}: {e}", path.display()))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(default),
        Err(e) => Err(e),
    }
}

pub fn write_json<T: serde::Serialize>(path: &Path, value: &T, private: bool) -> std::io::Result<()> {
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string()))?;
    write_atomic(path, &bytes, private)
}

/// Compare dotted versions numerically (`0.10.0` > `0.9.3`); missing parts count as 0 and a
/// pre-release suffix (`-beta.1`) sorts before the release.
pub fn version_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let split = |v: &str| -> (Vec<u64>, Option<String>) {
        let (core, pre) = match v.split_once('-') {
            Some((c, p)) => (c, Some(p.to_string())),
            None => (v, None),
        };
        (core.split('.').map(|p| p.parse::<u64>().unwrap_or(0)).collect(), pre)
    };
    let (ca, pa) = split(a);
    let (cb, pb) = split(b);
    for i in 0..ca.len().max(cb.len()) {
        let (x, y) = (ca.get(i).copied().unwrap_or(0), cb.get(i).copied().unwrap_or(0));
        if x != y {
            return x.cmp(&y);
        }
    }
    match (pa, pb) {
        (None, None) => std::cmp::Ordering::Equal,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (Some(_), None) => std::cmp::Ordering::Less,
        (Some(x), Some(y)) => x.cmp(&y),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cmp::Ordering;

    #[test]
    fn formats_iso_timestamps() {
        assert_eq!(iso(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso(951_782_400_123), "2000-02-29T00:00:00.123Z");
        assert_eq!(iso(1_792_000_000_000), "2026-10-14T17:46:40.000Z");
    }

    #[test]
    fn parses_iso_timestamps() {
        assert_eq!(parse_iso("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(parse_iso("2026-10-14T17:46:40.000Z"), Some(1_792_000_000));
        assert_eq!(parse_iso("2000-02-29T00:00:00Z"), Some(951_782_400));
        assert_eq!(parse_iso(&iso(1_835_481_599_000)), Some(1_835_481_599));
        for bad in ["", "2026-10-14 17:46:40Z", "2026-10-14T17:46:40+02:00", "2026-13-14T17:46:40Z", "2026-10-14T17:46:40.Z", "2026-1a-14T17:46:40Z", "2026-10-14T17:46:4\u{e9}Z"] {
            assert_eq!(parse_iso(bad), None, "{bad}");
        }
    }

    #[test]
    fn compares_versions() {
        assert_eq!(version_cmp("0.10.0", "0.9.3"), Ordering::Greater);
        assert_eq!(version_cmp("0.6", "0.6.0"), Ordering::Equal);
        assert_eq!(version_cmp("0.6.0-beta.1", "0.6.0"), Ordering::Less);
        assert_eq!(version_cmp("1.0.0", "0.99.99"), Ordering::Greater);
    }

    #[test]
    fn writes_atomically_with_private_mode() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("novad-util-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let p = dir.join("secret.json");
        write_json(&p, &json!({"a": 1}), true).unwrap();
        assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o600);
        let v: Value = read_json_or(&p, Value::Null).unwrap();
        assert_eq!(v["a"], 1);
        let missing: Value = read_json_or(&dir.join("none.json"), json!({"d": true})).unwrap();
        assert_eq!(missing["d"], true);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1, "no temporary file is left");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn maps_io_errors() {
        let e: OpError = std::io::Error::from(std::io::ErrorKind::NotFound).into();
        assert_eq!((e.status, e.code.as_str()), (404, "not_found"));
        let d = OpError::denied("protected_path", "no");
        assert_eq!(d.to_json()["details"]["reason"], "protected_path");
        assert_eq!(OpError::from_json(409, &d.to_json()).code, "policy_denied");
    }
}
