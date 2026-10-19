//! `novad install` (FR-133, FR-132; docs/22 §4.3, docs/23 §2): join a Hub with an Add Device
//! code. It verifies before it writes anything: the Hub's identity against the pinned
//! fingerprint (`GET /api/v1/hello`'s `hubPublicKey` must hash to it), the build manifest's
//! signature by that key, and this binary's SHA-256 in the manifest (over bytes read once and
//! kept: those same bytes are what gets installed). Then it runs Add Device v2 as `kind: novad`
//! with a fresh Ed25519 key held in memory: `complete` with a commitment to a secret nonce,
//! `reveal` of the nonce, the Hub's signed confirmation checked against the pinned key and this
//! device's own computation before the code is shown, then signed status polls. It registers
//! with the granted `nvd_` token and the same key, and installs and starts the service unless
//! `--no-service`. An https:// Hub is trusted through the pin (src/tls.rs: the Hub's signed
//! identity statement on the connection itself, R-023), and the device certificate the owner's
//! approval grants is presented from registration on (FR-126). Over http:// the pin, the signed
//! manifest and the signed confirmation carry the integrity (ADR-094), and the Hub local CA is
//! learned from the signed statement for later HTTPS.

use crate::cli::{EnrollArgs, InstallArgs};
use crate::crypto::{self, Sha256, SigningKey, b64_decode, b64url_decode, b64url_encode, hex, sha256};
use crate::http;
use crate::power::{Runner, SystemRunner};
use crate::state::DataDir;
use crate::tls::{HubTrust, TlsContext};
use crate::util::{now_ms, parse_iso};
use serde::Deserialize;
use serde_json::{Value, json};
use std::io::Read;
use std::net::{IpAddr, SocketAddr, ToSocketAddrs, UdpSocket};
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const MANIFEST: &str = "novad-manifest.json";
pub const SIGNATURE: &str = "novad-manifest.sig";
/// The manifest signature covers this tag followed by the exact manifest bytes, so a signature by
/// the Hub identity over anything else (an Add Device answer, an identity statement) can never
/// pass as a manifest signature.
pub const MANIFEST_SIGNATURE_TAG: &[u8] = b"nova-novad-manifest-v1\n";
const TIMEOUT: Duration = Duration::from_secs(15);
/// How long to wait for approval when the Hub does not say when the request expires.
const DEFAULT_WAIT_SECS: i64 = 10 * 60;

/// One build in the manifest (`novad-<os>-<arch>[.exe]`).
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct DistFile {
    pub name: String,
    pub os: String,
    pub arch: String,
    pub sha256: String,
    pub size: u64,
}

/// `novad-manifest.json`, signed by the Hub identity over its exact bytes.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DistManifest {
    #[serde(default)]
    pub version: Option<String>,
    pub files: Vec<DistFile>,
    #[serde(default)]
    pub hub_fingerprint: Option<String>,
    #[serde(default)]
    pub signed_at: Option<String>,
}

/// The Hub's verified identity key, and its clock minus ours (from its `Date` header) so the
/// signed status polls carry a time the Hub accepts even when this machine's clock is off.
#[derive(Debug, Clone, PartialEq)]
pub struct HubIdentity {
    pub public_key: [u8; 32],
    pub clock_offset: i64,
}

/// This build's names in the manifest: os linux|darwin|windows, arch amd64|arm64.
pub fn this_platform() -> (&'static str, &'static str) {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "amd64",
        "aarch64" => "arm64",
        other => other,
    };
    (os, arch)
}

/// base64url(SHA-256(raw public key)): the Hub fingerprint a device pins (FR-134).
pub fn fingerprint(public_key: &[u8; 32]) -> String {
    b64url_encode(&sha256(public_key))
}

fn decode_b64_any(s: &str) -> Option<Vec<u8>> {
    let t = s.trim();
    b64url_decode(t).or_else(|| b64_decode(t))
}

fn now_secs() -> i64 {
    (now_ms() / 1000) as i64
}

/// A Hub id (pairing or request): letters, digits, `-` and `_`, at most 100.
pub fn valid_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 100 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// `ABCDEFGH` → `ABCD-EFGH`, the form the Hub shows.
pub fn display_code(code: &str) -> String {
    if code.len() == 8 && code.is_ascii() { format!("{}-{}", &code[..4], &code[4..]) } else { code.to_string() }
}

/// The commitment `complete` carries (Add Device v2): base64url(SHA-256(
/// `nova-add-device-commit-v1|<public key>|<device nonce>`)). The nonce stays on the device
/// until `reveal`, after the Hub has fixed its own nonce.
pub fn commitment(public_key: &str, device_nonce: &str) -> String {
    b64url_encode(&sha256(format!("nova-add-device-commit-v1|{public_key}|{device_nonce}").as_bytes()))
}

/// The 6-digit confirmation both the device and the Hub show (FR-132, Add Device v2): SHA-256
/// over `nova-add-device-v2|<hub fingerprint>|<pairing id>|<device public key>|<CODE>|<device
/// nonce>|<hub nonce>` read as a big-endian number, mod 10^6, zero-padded. Each side committed
/// before it saw the other's nonce, so a key swapped in the middle gets one guess in a million.
pub fn confirmation(hub_fingerprint: &str, pairing_id: &str, public_key: &str, code: &str, device_nonce: &str, hub_nonce: &str) -> String {
    let digest = sha256(format!("nova-add-device-v2|{hub_fingerprint}|{pairing_id}|{public_key}|{code}|{device_nonce}|{hub_nonce}").as_bytes());
    let n = digest.iter().fold(0u64, |acc, b| (acc * 256 + u64::from(*b)) % 1_000_000);
    format!("{n:06}")
}

/// What the Hub identity signs in the reveal answer.
pub fn reveal_statement(request_id: &str, pairing_id: &str, public_key: &str, confirmation: &str) -> String {
    format!("nova-add-device-reveal-v1|{request_id}|{pairing_id}|{public_key}|{confirmation}")
}

/// Step 1: the Hub's public key must hash to the pin.
pub fn verify_hub(hub: &str, pin: &str, tls: &TlsContext) -> Result<HubIdentity, String> {
    let r = http::request_with("GET", &format!("{hub}/api/v1/hello"), &[], None, TIMEOUT, Some(tls)).map_err(|e| format!("cannot reach the Hub at {hub}: {e}"))?;
    if r.status != 200 {
        return Err(format!("the Hub answered {} to /api/v1/hello", r.status));
    }
    let hello = r.json()?;
    let key_text = hello["hubPublicKey"].as_str().ok_or("the Hub does not publish its identity key (hubPublicKey); it needs a newer version")?;
    let key: [u8; 32] = decode_b64_any(key_text).and_then(|b| b.try_into().ok()).ok_or("the Hub's identity key is not a 32-byte Ed25519 key")?;
    let found = fingerprint(&key);
    if found != pin {
        return Err(format!("the Hub's identity does not match the pinned fingerprint (expected {pin}, the Hub has {found}); nothing was changed"));
    }
    if let Some(claimed) = hello["hubFingerprint"].as_str().filter(|c| *c != pin) {
        return Err(format!("the Hub claims fingerprint {claimed} but its key hashes to {pin}; nothing was changed"));
    }
    let clock_offset = r.header("date").and_then(http::parse_http_date).map(|t| t as i64 - now_secs()).unwrap_or(0);
    Ok(HubIdentity { public_key: key, clock_offset })
}

/// Step 2: the signature (base64 or base64url Ed25519 over the tag and the exact manifest
/// bytes) by the pinned key, and the manifest names this Hub.
pub fn verify_manifest(bytes: &[u8], signature: &str, key: &[u8; 32], pin: &str) -> Result<DistManifest, String> {
    let sig: [u8; 64] = decode_b64_any(signature).and_then(|b| b.try_into().ok()).ok_or("the manifest signature is not a 64-byte Ed25519 signature; nothing was changed")?;
    let mut signed = MANIFEST_SIGNATURE_TAG.to_vec();
    signed.extend_from_slice(bytes);
    if !crypto::verify(key, &signed, &sig) {
        return Err("the build manifest's signature does not verify with the Hub's key; nothing was changed".into());
    }
    let m: DistManifest = serde_json::from_slice(bytes).map_err(|e| format!("the build manifest is not valid: {e}"))?;
    if m.hub_fingerprint.as_deref() != Some(pin) {
        return Err("the build manifest names another Hub; nothing was changed".into());
    }
    Ok(m)
}

pub fn fetch_manifest(hub: &str, id: &HubIdentity, pin: &str, tls: &TlsContext) -> Result<DistManifest, String> {
    let get = |name: &str| -> Result<Vec<u8>, String> {
        let r = http::request_with("GET", &format!("{hub}/api/v1/agent/dist/{name}"), &[], None, TIMEOUT, Some(tls))?;
        if r.status != 200 {
            return Err(format!("the Hub answered {} for {name}: it serves no signed builds", r.status));
        }
        Ok(r.body)
    };
    let bytes = get(MANIFEST)?;
    let sig = String::from_utf8(get(SIGNATURE)?).map_err(|_| "the manifest signature is not text".to_string())?;
    verify_manifest(&bytes, &sig, &id.public_key, pin)
}

/// Largest binary install reads into memory (a novad build is a few megabytes).
const MAX_BINARY_BYTES: u64 = 512 * 1024 * 1024;

/// The running binary's bytes, read once: they are hashed against the manifest and they are
/// what the service installs, so nothing can swap the file in between (review finding 12).
pub fn read_binary(path: &Path) -> Result<Vec<u8>, String> {
    let f = std::fs::File::open(path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    let mut bytes = Vec::new();
    f.take(MAX_BINARY_BYTES + 1).read_to_end(&mut bytes).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    if bytes.len() as u64 > MAX_BINARY_BYTES {
        return Err(format!("{} is too large to be a novad build", path.display()));
    }
    Ok(bytes)
}

/// SHA-256 in lowercase hex.
pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    hex(&h.finalize())
}

/// Step 3: these bytes (the running binary) are the Hub's signed build for this platform.
pub fn check_binary(m: &DistManifest, binary: &[u8], exe: &Path, os: &str, arch: &str) -> Result<DistFile, String> {
    let entry = m.files.iter().find(|f| f.os == os && f.arch == arch).ok_or_else(|| format!("the Hub's signed manifest has no build for {os}-{arch}; nothing was changed"))?;
    let found = sha256_hex(binary);
    if !found.eq_ignore_ascii_case(&entry.sha256) {
        return Err(format!(
            "this binary ({}) is not the Hub's signed build {} (SHA-256 {} expected, {found} found); nothing was changed",
            exe.display(),
            entry.name,
            entry.sha256
        ));
    }
    Ok(entry.clone())
}

/// The address the Hub reaches this device on: --endpoint, else the listen address, else the
/// local address of the route toward the Hub (a connected UDP socket sends nothing).
pub fn resolve_endpoint(a: &InstallArgs) -> Result<String, String> {
    if let Some(e) = &a.endpoint {
        return Ok(e.trim_end_matches('/').to_string());
    }
    let listen: SocketAddr = a.listen.parse().map_err(|_| "--listen must be HOST:PORT".to_string())?;
    if !listen.ip().is_unspecified() {
        return Ok(format!("http://{listen}"));
    }
    let (host, port) = http::host_port(&a.hub)?;
    let ip = local_ip_toward(&host, port).ok_or("cannot tell which address the Hub reaches this device on; pass --endpoint http://<this-device>:<port>")?;
    Ok(match ip {
        IpAddr::V4(v4) => format!("http://{v4}:{}", listen.port()),
        IpAddr::V6(v6) => format!("http://[{v6}]:{}", listen.port()),
    })
}

fn local_ip_toward(host: &str, port: u16) -> Option<IpAddr> {
    let addr = (host, port).to_socket_addrs().ok()?.next()?;
    let socket = UdpSocket::bind(if addr.is_ipv4() { "0.0.0.0:0" } else { "[::]:0" }).ok()?;
    socket.connect(addr).ok()?;
    socket.local_addr().ok().map(|a| a.ip()).filter(|ip| !ip.is_unspecified())
}

/// The Hub's answer to `complete` (Add Device v2): the request is committed, not yet shown to
/// the owner.
#[derive(Debug, Clone, PartialEq)]
pub struct Committed {
    pub request_id: String,
    pub pairing_id: String,
    /// The Hub's nonce, base64url of 32 bytes.
    pub hub_nonce: String,
    /// Hub time (Unix seconds) after which the request cannot be approved.
    pub expires_at: Option<i64>,
}

/// A fresh nonce: 32 random bytes, base64url.
pub fn new_nonce() -> Result<String, String> {
    let mut b = [0u8; 32];
    crypto::random_bytes(&mut b)?;
    Ok(b64url_encode(&b))
}

/// Step 4: send the code, this device's public key and a commitment to `device_nonce`
/// (`POST /api/v1/devices/add/complete`). Without --pairing the Hub finds the pairing by the
/// code and names it in its answer.
pub fn complete(a: &InstallArgs, key: &SigningKey, device_nonce: &str, name: &str, platform: &str, tls: &TlsContext) -> Result<Committed, String> {
    let public_key = b64url_encode(&key.public_key());
    let mut body = json!({
        "code": display_code(&a.code),
        "publicKey": public_key,
        "name": name,
        "platform": platform,
        "kind": "novad",
        "commitment": commitment(&public_key, device_nonce),
    });
    if let Some(p) = &a.pairing {
        body["pairingId"] = json!(p);
    }
    let (status, resp) = http::post_json_with(&format!("{}/api/v1/devices/add/complete", a.hub), None, &body, TIMEOUT, Some(tls)).map_err(|e| format!("cannot reach the Hub: {e}"))?;
    let message = resp["error"]["message"].as_str().unwrap_or("unknown error").to_string();
    match status {
        200..=299 => {}
        410 => return Err("the Add Device code expired or was already used; create a new one on the Hub".into()),
        429 => return Err("too many attempts with this code; create a new one on the Hub".into()),
        _ => return Err(format!("the Hub refused the code ({status}): {message}")),
    }
    let request_id = resp["requestId"].as_str().filter(|id| valid_id(id)).ok_or("the Hub's answer has no valid requestId")?.to_string();
    let answered = resp["pairingId"].as_str().filter(|id| valid_id(id));
    let pairing_id = match (a.pairing.as_deref(), answered) {
        (Some(mine), Some(theirs)) if mine != theirs => return Err(format!("the Hub answered for pairing {theirs}, not {mine}; stopping")),
        (Some(p), _) | (None, Some(p)) => p.to_string(),
        (None, None) => return Err("the Hub did not say which pairing the code belongs to; pass --pairing".into()),
    };
    let hub_nonce = resp["hubNonce"]
        .as_str()
        .filter(|n| b64url_decode(n).is_some_and(|b| b.len() == 32))
        .ok_or("the Hub's answer has no valid hubNonce (it needs Add Device v2); stopping")?
        .to_string();
    Ok(Committed { request_id, pairing_id, hub_nonce, expires_at: resp["expiresAt"].as_str().and_then(parse_iso).map(|t| t as i64) })
}

/// Step 5: reveal the nonce (`POST /api/v1/devices/add/reveal`, signed by the device key), then
/// check the answer before anything is shown: the Hub's confirmation must equal this device's
/// own computation, and `hubSignature` must verify with the pinned Hub key over the request,
/// pairing, this device's key and that confirmation. Returns the confirmation and the Hub time
/// the reveal was signed at (status polls must be newer).
pub fn reveal(a: &InstallArgs, c: &Committed, key: &SigningKey, device_nonce: &str, id: &HubIdentity, tls: &TlsContext) -> Result<(String, i64), String> {
    let public_key = b64url_encode(&key.public_key());
    let time = now_secs() + id.clock_offset;
    let signature = b64url_encode(&key.sign(format!("nova-add-device-reveal-v1.{}.{time}", c.request_id).as_bytes()));
    let body = serde_json::to_vec(&json!({ "requestId": c.request_id, "nonce": device_nonce })).map_err(|e| e.to_string())?;
    let r = http::request_with(
        "POST",
        &format!("{}/api/v1/devices/add/reveal", a.hub),
        &[("x-nova-device-time", &time.to_string()), ("x-nova-device-signature", &signature)],
        Some(&body),
        TIMEOUT,
        Some(tls),
    )
    .map_err(|e| format!("cannot reach the Hub: {e}"))?;
    let resp = r.json().unwrap_or(Value::Null);
    if r.status != 200 {
        let reason = resp["error"]["details"]["reason"].as_str().map(|r| format!(" ({r})")).unwrap_or_default();
        let message = resp["error"]["message"].as_str().unwrap_or("unknown error");
        return Err(format!("the Hub refused the reveal ({}{reason}): {message}; create a new code on the Hub", r.status));
    }
    if resp["requestId"].as_str().is_some_and(|rid| rid != c.request_id) {
        return Err("the Hub's reveal answer is for another request; stopping".into());
    }
    let mine = confirmation(&a.pin, &c.pairing_id, &public_key, &a.code, device_nonce, &c.hub_nonce);
    let literal = resp["confirmation"].as_str().unwrap_or_default();
    let theirs: String = literal.chars().filter(char::is_ascii_digit).collect();
    if theirs != mine {
        return Err(format!(
            "the Hub's confirmation code ({theirs}) differs from this device's ({mine}): something between this device and the Hub changed the request; stopping"
        ));
    }
    let not_your_hub = "This is not your Hub: its answer is not signed by the pinned Hub key; stopping";
    let sig: [u8; 64] = resp["hubSignature"].as_str().and_then(b64url_decode).and_then(|b| b.try_into().ok()).ok_or(not_your_hub)?;
    // The Hub signs the confirmation as it sent it; the six digits are what matter.
    let signed_by_hub = [literal, mine.as_str()].iter().any(|conf| {
        crypto::verify(&id.public_key, reveal_statement(&c.request_id, &c.pairing_id, &public_key, conf).as_bytes(), &sig)
    });
    if !signed_by_hub {
        return Err(not_your_hub.into());
    }
    Ok((mine, time))
}

/// Polling cadence for status: starts at `start`, grows by half each time, up to `max`.
#[derive(Debug, Clone, Copy)]
pub struct Poll {
    pub start: Duration,
    pub max: Duration,
}

/// What the owner's approval grants a novad device.
#[derive(Debug, Clone, PartialEq)]
pub struct Grant {
    pub enroll_token: String,
    pub certificate_pem: Option<String>,
}

fn parse_grant(g: &Value) -> Result<Grant, String> {
    if g["type"] != "novad" {
        return Err(format!("the Hub granted {} instead of a novad enrollment", g["type"]));
    }
    let token = g["enrollToken"]
        .as_str()
        .filter(|t| t.starts_with("nvd_") && t.len() >= 20 && t.len() <= 200 && t.bytes().all(|b| b.is_ascii_graphic()))
        .ok_or("the grant has no valid enrollment token")?;
    let pem = g["certificatePem"].as_str().filter(|p| p.starts_with("-----BEGIN CERTIFICATE-----") && p.len() <= 16 * 1024).map(str::to_string);
    Ok(Grant { enroll_token: token.to_string(), certificate_pem: pem })
}

/// Step 6: poll `GET /api/v1/devices/add/status/:id`, signed with the device key, until the
/// owner decides or the request expires. Network errors, 429 and 5xx are retried with backoff.
/// `after` is the Hub time of the last signed request (the reveal); every poll is newer.
#[allow(clippy::too_many_arguments)]
/// How long to wait for the owner: the commit's `expiresAt` is only the reveal deadline (2 minutes);
/// once revealed, the Hub keeps the request pending for 10 minutes (and answers `expired` after).
pub fn approval_deadline(commit_expires_at: Option<i64>, revealed_at: i64) -> i64 {
    commit_expires_at.unwrap_or(0).max(revealed_at + DEFAULT_WAIT_SECS)
}

pub fn wait_for_approval(hub: &str, request_id: &str, key: &SigningKey, id: &HubIdentity, after: i64, deadline: i64, poll: Poll, sleep: &dyn Fn(Duration), tls: &TlsContext) -> Result<Grant, String> {
    let url = format!("{hub}/api/v1/devices/add/status/{request_id}");
    let mut wait = poll.start;
    let mut last = after;
    loop {
        let now = now_secs() + id.clock_offset;
        if now >= deadline {
            return Err("the request was not approved in time; create a new code on the Hub".into());
        }
        // The Hub accepts only a poll newer than the last one (a captured poll cannot be
        // replayed), at a resolution of one second.
        if now <= last {
            sleep(Duration::from_millis(200));
            continue;
        }
        last = now;
        let time = now.to_string();
        let signature = b64url_encode(&key.sign(format!("nova-add-device-status-v1.{request_id}.{time}").as_bytes()));
        match http::request_with("GET", &url, &[("x-nova-device-time", &time), ("x-nova-device-signature", &signature)], None, TIMEOUT, Some(tls)) {
            Ok(r) if r.status == 200 => {
                let v = r.json()?;
                match v["status"].as_str() {
                    Some("pending") => {}
                    Some("approved") => {
                        let g = v.get("grant").filter(|g| g.is_object()).ok_or("the Hub approved this device but sent no grant (it is delivered once); add the device again")?;
                        return parse_grant(g);
                    }
                    Some("denied") => return Err("the owner denied this device on the Hub".into()),
                    Some("expired") => return Err("the request expired before it was approved; create a new code on the Hub".into()),
                    other => return Err(format!("the Hub answered an unknown status {other:?}")),
                }
            }
            Ok(r) if r.status == 410 => return Err("the request expired before it was approved; create a new code on the Hub".into()),
            Ok(r) if r.status == 429 || r.status >= 500 => {}
            Ok(r) => {
                let msg = r.json().ok().and_then(|v| v["error"]["message"].as_str().map(str::to_string)).unwrap_or_default();
                return Err(format!("the Hub refused the status check ({}): {msg}", r.status));
            }
            Err(e) => eprintln!("novad: status check failed, retrying: {e}"),
        }
        sleep(wait);
        wait = (wait * 3 / 2).min(poll.max);
    }
}

/// Copies the binary to its permanent place and installs and starts the service (systemd unit,
/// launchd daemon or Windows service) with the unit text `novad service-unit` prints.
pub struct ServiceSetup {
    /// `linux`, `macos` or `windows`.
    pub platform: &'static str,
    pub bin_path: PathBuf,
    /// The unit or plist file (unused on Windows).
    pub unit_path: PathBuf,
    pub runner: Box<dyn Runner>,
}

impl ServiceSetup {
    pub fn system() -> Self {
        if cfg!(target_os = "macos") {
            ServiceSetup { platform: "macos", bin_path: "/usr/local/bin/novad".into(), unit_path: "/Library/LaunchDaemons/ai.nova.novad.plist".into(), runner: Box::new(SystemRunner) }
        } else if cfg!(windows) {
            let pf = std::env::var("ProgramFiles").unwrap_or_else(|_| "C:\\Program Files".into());
            ServiceSetup { platform: "windows", bin_path: PathBuf::from(pf).join("Nova").join("novad.exe"), unit_path: PathBuf::new(), runner: Box::new(SystemRunner) }
        } else {
            ServiceSetup { platform: "linux", bin_path: "/usr/local/bin/novad".into(), unit_path: "/etc/systemd/system/novad.service".into(), runner: Box::new(SystemRunner) }
        }
    }

    /// Writes `binary` (the bytes that were checked against the manifest) to `bin_path`, checks
    /// the installed copy, then installs and starts the service. Returns the commands it ran.
    pub fn install(&self, binary: &[u8], expected_sha256: &str, data_dir: &str) -> Result<Vec<String>, String> {
        install_binary(binary, expected_sha256, &self.bin_path)?;
        let bin = self.bin_path.to_string_lossy().to_string();
        let unit = self.unit_path.to_string_lossy().to_string();
        let steps: Vec<Vec<String>> = match self.platform {
            "macos" => {
                write_unit(&self.unit_path, &crate::cli::launchd_plist(&bin, data_dir))?;
                vec![vec!["launchctl".into(), "load".into(), "-w".into(), unit]]
            }
            "windows" => vec![
                vec!["sc.exe".into(), "create".into(), "novad".into(), "binPath=".into(), format!("\"{bin}\" run --data-dir \"{data_dir}\""), "start=".into(), "auto".into(), "DisplayName=".into(), "Nova device agent".into()],
                vec!["sc.exe".into(), "failure".into(), "novad".into(), "reset=".into(), "86400".into(), "actions=".into(), "restart/5000/restart/5000/restart/60000".into()],
                vec!["sc.exe".into(), "start".into(), "novad".into()],
            ],
            _ => {
                write_unit(&self.unit_path, &crate::cli::systemd_unit(&bin, data_dir))?;
                let name = self.unit_path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "novad.service".into());
                vec![vec!["systemctl".into(), "daemon-reload".into()], vec!["systemctl".into(), "enable".into(), "--now".into(), name]]
            }
        };
        let mut ran = vec![];
        for argv in steps {
            let (code, _, err) = self.runner.run(&argv).map_err(|e| format!("{}: {e}", argv[0]))?;
            if code != 0 {
                return Err(format!("{} failed: {}", argv.join(" "), err.trim()));
            }
            ran.push(argv.join(" "));
        }
        Ok(ran)
    }
}

fn write_unit(path: &Path, text: &str) -> Result<(), String> {
    crate::util::write_atomic(path, text.as_bytes(), false).map_err(|e| format!("cannot write {}: {e}", path.display()))
}

/// Write the checked bytes where the service runs them (the bootstrap command's download folder
/// is deleted afterwards and belongs to the user who ran it, so it is never read again), mode
/// 0755, then hash the installed copy before the service is enabled.
fn install_binary(bytes: &[u8], expected_sha256: &str, to: &Path) -> Result<(), String> {
    if !sha256_hex(bytes).eq_ignore_ascii_case(expected_sha256) {
        return Err("the binary to install is not the signed build".into());
    }
    crate::util::write_atomic(to, bytes, false).map_err(|e| format!("cannot install {}: {e}", to.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(to, std::fs::Permissions::from_mode(0o755)).map_err(|e| format!("cannot make {} executable: {e}", to.display()))?;
    }
    let installed = read_binary(to)?;
    if !sha256_hex(&installed).eq_ignore_ascii_case(expected_sha256) {
        return Err(format!("{} changed after it was written; the service was not enabled", to.display()));
    }
    Ok(())
}

/// What install needs from the machine; tests substitute it.
pub struct Env {
    /// The running binary, hashed against the manifest and copied for the service.
    pub exe: PathBuf,
    pub os: &'static str,
    pub arch: &'static str,
    pub poll: Poll,
    pub sleep: Box<dyn Fn(Duration)>,
    pub service: ServiceSetup,
    /// Root (installing the service needs it).
    pub elevated: bool,
    pub hostname: Option<String>,
}

impl Env {
    pub fn system(exe: PathBuf) -> Self {
        let (os, arch) = this_platform();
        Env {
            exe,
            os,
            arch,
            poll: Poll { start: Duration::from_secs(1), max: Duration::from_secs(5) },
            sleep: Box::new(std::thread::sleep),
            service: ServiceSetup::system(),
            elevated: crate::hardening::is_root(),
            hostname: crate::capabilities::Probe::current().hostname,
        }
    }
}

/// `novad install`. Every check that can fail runs before anything is written; the device key
/// stays in memory until the owner approves.
pub fn run(a: &InstallArgs, env: &Env) -> Result<Value, String> {
    if !a.no_service && !a.dry_run && cfg!(unix) && !env.elevated {
        return Err("installing the service needs root: run it with sudo, or pass --no-service and start `novad run` yourself".into());
    }
    let data = DataDir(PathBuf::from(&a.data_dir));
    if let Some(d) = data.device().map_err(|e| e.to_string())?.filter(|d| d.credential.is_some() && !d.revoked) {
        return Err(format!(
            "this device is already enrolled with {} (device {}); remove {} to add it again, or use another --data-dir",
            d.hub_url.unwrap_or_default(),
            d.device_id.unwrap_or_default(),
            data.device_path().display()
        ));
    }
    // Over https:// the first connection checks the Hub's signed statement against the pin
    // before anything is sent; later ones trust what it vouched for (src/tls.rs).
    let tls = TlsContext::new(HubTrust::pinned(&a.pin));
    let id = verify_hub(&a.hub, &a.pin, &tls)?;
    println!("Hub identity verified: {}", a.pin);
    let manifest = fetch_manifest(&a.hub, &id, &a.pin, &tls)?;
    println!("Signed build manifest verified (novad {}, {} builds)", manifest.version.as_deref().unwrap_or("unknown"), manifest.files.len());
    let binary = read_binary(&env.exe)?;
    let build = check_binary(&manifest, &binary, &env.exe, env.os, env.arch)?;
    println!("This binary is the Hub's signed {} (SHA-256 {})", build.name, build.sha256);
    let endpoint = resolve_endpoint(a)?;
    // The Hub takes names of 1 to 100 characters; a long host name is cut.
    let name: String = a.name.clone().or_else(|| env.hostname.clone()).filter(|n| !n.trim().is_empty()).unwrap_or_else(|| "device".into()).chars().filter(|c| !c.is_control()).take(100).collect();
    if a.dry_run {
        println!("Dry run: would join {} as {name} ({}) reachable at {endpoint}", a.hub, a.roles.join(", "));
        return Ok(json!({ "dryRun": true, "hub": a.hub, "build": build.name, "endpoint": endpoint, "name": name }));
    }

    let mut seed = [0u8; 32];
    crypto::random_bytes(&mut seed)?;
    let key = SigningKey::from_seed(&seed);
    let approved = (|| {
        let device_nonce = new_nonce()?;
        let committed = complete(a, &key, &device_nonce, &name, env.os, &tls)?;
        // Every check on the answer passes before the code is shown (a mismatch is a hard stop).
        let (confirmation, revealed_at) = reveal(a, &committed, &key, &device_nonce, &id, &tls)?;
        println!("Confirm this code on the Hub: {} {}", &confirmation[..3], &confirmation[3..]);
        println!("Waiting for the owner to approve this device on the Hub...");
        let deadline = approval_deadline(committed.expires_at, revealed_at);
        wait_for_approval(&a.hub, &committed.request_id, &key, &id, revealed_at, deadline, env.poll, env.sleep.as_ref(), &tls)
    })();
    let grant = match approved {
        Ok(g) => g,
        Err(e) => {
            seed.fill(0);
            return Err(e);
        }
    };
    println!("Approved. Registering...");

    data.ensure().map_err(|e| e.to_string())?;
    let saved = data.save_seed(&seed);
    seed.fill(0);
    std::hint::black_box(&seed);
    saved.map_err(|e| e.to_string())?;
    let enroll = EnrollArgs {
        hub: a.hub.clone(),
        token: grant.enroll_token,
        name: Some(name.clone()),
        roles: a.roles.clone(),
        listen: a.listen.clone(),
        endpoint: endpoint.clone(),
        channel: "stable".into(),
        update_key: None,
        pin: Some(a.pin.clone()),
        users: a.users.clone(),
        data_dir: a.data_dir.clone(),
    };
    // The certificate the approval granted (local-CA mode) is presented from registration on
    // (mutual TLS, FR-126); the pin and what the statement vouched for are kept for HTTPS.
    if let Some(pem) = &grant.certificate_pem {
        crate::util::write_atomic(&data.path().join(crate::tls::DEVICE_CERT_FILE), pem.as_bytes(), false).map_err(|e| e.to_string())?;
    }
    tls.trust().save(&data.path().join(crate::tls::TRUST_FILE)).map_err(|e| e.to_string())?;
    let registered = crate::agent::register(&data, &enroll, env.exe.clone())?;
    println!("Registered as device {} ({endpoint})", registered["deviceId"].as_str().unwrap_or("?"));
    let mut out = json!({ "deviceId": registered["deviceId"], "name": name, "endpoint": endpoint, "service": Value::Null });
    if !a.no_service {
        let ran = env.service.install(&binary, &build.sha256, &a.data_dir).map_err(|e| format!("registered, but the service could not be installed: {e}; start it with `novad run --data-dir {}`", a.data_dir))?;
        println!("Service installed and started");
        out["service"] = json!({ "binary": env.service.bin_path, "ran": ran });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::grants::tests::tmp;
    use crate::http::{Request, Response, ServerHandle, serve};
    use crate::power::tests::FakeRunner;
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    const CODE: &str = "ABCDEFGH";
    const PAIRING: &str = "pair-1";
    const BINARY: &[u8] = b"pretend this is the novad binary";

    struct HubState {
        hub_seed: [u8; 32],
        /// What hello publishes as the key (None: the real one).
        hello_key: Option<String>,
        manifest: Vec<u8>,
        sig: String,
        /// Polls answered `pending` before the decision.
        pending_polls: u32,
        decision: &'static str,
        polls: u32,
        grant_sent: bool,
        device_key: Option<String>,
        commitment: Option<String>,
        hub_nonce: String,
        revealed: bool,
        /// The last signed time accepted (reveal or poll): a request must be newer.
        last_time: i64,
        /// Answer this confirmation instead of the right one (signed all the same).
        confirmation: Option<String>,
        /// Sign the reveal answer with another key, or over another device key, or not at all.
        sign_seed: Option<[u8; 32]>,
        signed_device_key: Option<String>,
        no_signature: bool,
        /// Overwrite this file at the first status poll (someone swapping the download).
        swap_exe: Option<(PathBuf, Vec<u8>)>,
        registered: Option<Value>,
        bad_signatures: u32,
    }

    struct FakeHub {
        server: Option<ServerHandle>,
        url: String,
        state: Arc<Mutex<HubState>>,
    }

    impl Drop for FakeHub {
        fn drop(&mut self) {
            if let Some(s) = self.server.take() {
                s.stop();
            }
        }
    }

    fn hub_key(st: &HubState) -> SigningKey {
        SigningKey::from_seed(&st.hub_seed)
    }

    fn manifest_for(fp: &str, sha: &str) -> Vec<u8> {
        let (os, arch) = this_platform();
        serde_json::to_vec_pretty(&json!({
            "version": "0.6.0",
            "files": [
                { "name": format!("novad-{os}-{arch}"), "os": os, "arch": arch, "sha256": sha, "size": BINARY.len() },
                { "name": "novad-windows-arm64.exe", "os": "windows", "arch": "arm64", "sha256": "00", "size": 1 },
            ],
            "hubFingerprint": fp,
            "signedAt": "2026-10-17T15:00:00.000Z",
        }))
        .unwrap()
    }

    fn handle(state: &Arc<Mutex<HubState>>, req: Request) -> Response {
        let mut st = state.lock().unwrap();
        let key = hub_key(&st);
        let fp = fingerprint(&key.public_key());
        match (req.method.as_str(), req.path.as_str()) {
            ("GET", "/api/v1/hello") => {
                let mut r = Response::json(200, &json!({ "name": "nova-hub", "hubFingerprint": fp, "hubPublicKey": st.hello_key.clone().unwrap_or_else(|| b64url_encode(&key.public_key())) }));
                // The Hub's clock is two minutes ahead of ours: polls must use its time.
                r.headers.push(("date".into(), httpdate(now_secs() + 120)));
                r
            }
            ("GET", "/api/v1/agent/dist/novad-manifest.json") => Response { status: 200, headers: vec![], body: st.manifest.clone() },
            ("GET", "/api/v1/agent/dist/novad-manifest.sig") => Response { status: 200, headers: vec![], body: st.sig.clone().into_bytes() },
            ("POST", "/api/v1/devices/add/complete") => {
                let b = req.json().unwrap();
                // Without a pairing id the Hub finds the pairing by its code.
                if (!b["pairingId"].is_null() && b["pairingId"] != PAIRING) || b["code"] != "ABCD-EFGH" || b["kind"] != "novad" {
                    return Response::error(400, "validation", "wrong code", None);
                }
                // v2: a commitment, never the nonce itself.
                if b.get("nonce").is_some() || b["commitment"].as_str().is_none_or(|c| c.len() != 43) {
                    return Response::error(400, "validation", "a commitment is required", None);
                }
                st.device_key = Some(b["publicKey"].as_str().unwrap().to_string());
                st.commitment = b["commitment"].as_str().map(str::to_string);
                st.revealed = false;
                st.last_time = 0;
                Response::json(202, &json!({ "requestId": "req-1", "pairingId": PAIRING, "hubNonce": st.hub_nonce, "status": "committed", "expiresAt": crate::util::iso(((now_secs() + 120 + 300) * 1000) as u64) }))
            }
            ("POST", "/api/v1/devices/add/reveal") => {
                let pk = st.device_key.clone().unwrap();
                if !signed_now(&mut st, &req, &pk, "nova-add-device-reveal-v1.req-1") {
                    return Response::error(401, "token_required", "bad device signature", None);
                }
                let b = req.json().unwrap();
                let nonce = b["nonce"].as_str().unwrap_or_default().to_string();
                if b["requestId"] != "req-1" || Some(commitment(&pk, &nonce)) != st.commitment {
                    return Response::error(403, "policy_denied", "the nonce does not open the commitment", Some(json!({ "reason": "bad_reveal" })));
                }
                if st.revealed {
                    return Response::error(409, "conflict", "already revealed", Some(json!({ "reason": "already_revealed" })));
                }
                st.revealed = true;
                let c = st.confirmation.clone().unwrap_or_else(|| confirmation(&fp, PAIRING, &pk, CODE, &nonce, &st.hub_nonce));
                let signer = st.sign_seed.map(|seed| SigningKey::from_seed(&seed)).unwrap_or_else(|| hub_key(&st));
                let signed_key = st.signed_device_key.clone().unwrap_or(pk);
                let sig = (!st.no_signature).then(|| b64url_encode(&signer.sign(reveal_statement("req-1", PAIRING, &signed_key, &c).as_bytes())));
                Response::json(200, &json!({ "requestId": "req-1", "confirmation": c, "status": "pending", "hubSignature": sig }))
            }
            ("GET", "/api/v1/devices/add/status/req-1") => {
                let pk = st.device_key.clone().unwrap();
                if !st.revealed || !signed_now(&mut st, &req, &pk, "nova-add-device-status-v1.req-1") {
                    return Response::error(401, "token_required", "bad device signature", None);
                }
                if let Some((path, bytes)) = st.swap_exe.take() {
                    std::fs::write(path, bytes).unwrap();
                }
                st.polls += 1;
                if st.polls <= st.pending_polls {
                    return Response::json(200, &json!({ "status": "pending" }));
                }
                if st.decision == "approved" && !st.grant_sent {
                    st.grant_sent = true;
                    return Response::json(200, &json!({ "status": "approved", "grant": { "type": "novad", "enrollToken": "nvd_granted_token_0123456789", "certificatePem": "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n" } }));
                }
                if st.decision == "busy" {
                    return Response::error(503, "server_error", "busy", None);
                }
                Response::json(200, &json!({ "status": st.decision }))
            }
            ("POST", "/agent/v1/register") => {
                let b = req.json().unwrap();
                if b["enrollToken"] != "nvd_granted_token_0123456789" || b["publicKey"].as_str() != st.device_key.as_deref() {
                    return Response::error(401, "auth_missing", "token not bound to this key", None);
                }
                st.registered = Some(b);
                Response::json(201, &json!({ "deviceId": "dev-1", "credential": "nvc_cred", "heartbeatIntervalMs": 5000 }))
            }
            _ => Response::error(404, "not_found", "no route", None),
        }
    }

    /// The signed-request check the Hub makes: the device key over `<prefix>.<time>`, the time
    /// within 60 s of the Hub's clock and newer than the last signed request.
    fn signed_now(st: &mut HubState, req: &Request, device_key: &str, prefix: &str) -> bool {
        let pk: [u8; 32] = b64url_decode(device_key).unwrap().try_into().unwrap();
        let time = req.header("x-nova-device-time").unwrap_or_default().to_string();
        let sig: Option<[u8; 64]> = b64url_decode(req.header("x-nova-device-signature").unwrap_or_default()).and_then(|b| b.try_into().ok());
        let t = time.parse::<i64>().unwrap_or(0);
        let fresh = (t - (now_secs() + 120)).abs() <= 60 && t > st.last_time;
        let ok = sig.is_some_and(|s| crypto::verify(&pk, format!("{prefix}.{time}").as_bytes(), &s));
        if !ok || !fresh {
            st.bad_signatures += 1;
            return false;
        }
        st.last_time = t;
        true
    }

    fn httpdate(secs: i64) -> String {
        // RFC 9110 IMF-fixdate from Unix seconds, for the fake Hub's Date header.
        let iso = crate::util::iso((secs * 1000) as u64);
        let (y, mo, d) = (&iso[0..4], &iso[5..7], &iso[8..10]);
        const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        format!("Mon, {d} {} {y} {} GMT", MONTHS[mo.parse::<usize>().unwrap() - 1], &iso[11..19])
    }

    fn fake_hub(exe_sha: &str) -> FakeHub {
        let hub_seed = [42u8; 32];
        let key = SigningKey::from_seed(&hub_seed);
        let fp = fingerprint(&key.public_key());
        let manifest = manifest_for(&fp, exe_sha);
        let sig = crypto::b64_encode(&key.sign(&tagged(&manifest)));
        let state = Arc::new(Mutex::new(HubState {
            hub_seed,
            hello_key: None,
            manifest,
            sig,
            pending_polls: 1,
            decision: "approved",
            polls: 0,
            grant_sent: false,
            device_key: None,
            commitment: None,
            hub_nonce: b64url_encode(&[9u8; 32]),
            revealed: false,
            last_time: 0,
            confirmation: None,
            sign_seed: None,
            signed_device_key: None,
            no_signature: false,
            swap_exe: None,
            registered: None,
            bad_signatures: 0,
        }));
        let s2 = state.clone();
        let server = serve(TcpListener::bind("127.0.0.1:0").unwrap(), 1 << 20, Arc::new(move |req| handle(&s2, req)));
        let url = format!("http://{}", server.local_addr());
        FakeHub { server: Some(server), url, state }
    }

    fn tagged(manifest: &[u8]) -> Vec<u8> {
        [MANIFEST_SIGNATURE_TAG, manifest].concat()
    }

    fn st_reset(hub: &FakeHub) {
        let mut st = hub.state.lock().unwrap();
        st.polls = 0;
        st.grant_sent = false;
    }

    fn pin() -> String {
        fingerprint(&SigningKey::from_seed(&[42u8; 32]).public_key())
    }

    /// Over http:// the context is not used; the TLS install path is tested in src/tls.rs and
    /// with the real Hub (apps/hub/test/m7-novad-tls.test.ts).
    fn tls() -> TlsContext {
        TlsContext::new(HubTrust::pinned(&pin()))
    }

    fn args(hub: &FakeHub, data: &Path) -> InstallArgs {
        InstallArgs {
            hub: hub.url.clone(),
            code: CODE.into(),
            pairing: Some(PAIRING.into()),
            pin: pin(),
            roles: vec!["compute".into(), "wake-helper".into()],
            name: Some("box".into()),
            listen: "127.0.0.1:7499".into(),
            endpoint: None,
            no_service: true,
            dry_run: false,
            users: vec!["alice".into()],
            data_dir: data.to_string_lossy().to_string(),
        }
    }

    fn env(base: &Path, exe_bytes: &[u8], runner: FakeRunner) -> Env {
        let exe = base.join("novad-download");
        std::fs::write(&exe, exe_bytes).unwrap();
        let (os, arch) = this_platform();
        Env {
            exe,
            os,
            arch,
            poll: Poll { start: Duration::from_millis(1), max: Duration::from_millis(5) },
            sleep: Box::new(std::thread::sleep),
            service: ServiceSetup { platform: "linux", bin_path: base.join("bin/novad"), unit_path: base.join("units/novad.service"), runner: Box::new(runner) },
            elevated: false,
            hostname: Some("host".into()),
        }
    }

    fn sha(bytes: &[u8]) -> String {
        hex(&sha256(bytes))
    }

    #[test]
    fn installs_through_add_device() {
        let base = tmp("install");
        let hub = fake_hub(&sha(BINARY));
        let data = base.join("data");
        // A grant left by an earlier enrollment in this folder does not carry over.
        DataDir(data.clone()).ensure().unwrap();
        DataDir(data.clone()).save_granted_scopes(&["local-runtime".into()]).unwrap();
        let out = run(&args(&hub, &data), &env(&base, BINARY, FakeRunner::default())).unwrap();
        assert!(DataDir(data.clone()).granted_scopes().is_empty());
        assert!(!data.join("scopes.json").exists());
        assert_eq!(out["deviceId"], "dev-1");
        assert_eq!(out["endpoint"], "http://127.0.0.1:7499");
        let st = hub.state.lock().unwrap();
        assert_eq!(st.polls, 2, "a pending poll, then the approval");
        assert_eq!(st.bad_signatures, 0, "the reveal and every poll were signed with the device key at the Hub's time, each newer");
        assert!(st.revealed);
        // Registered with the key the Hub approved, which is the one stored.
        let reg = st.registered.clone().unwrap();
        assert_eq!(reg["publicKey"].as_str(), st.device_key.as_deref());
        assert_eq!(reg["name"], "box");
        assert_eq!(reg["endpoint"], "http://127.0.0.1:7499");
        let d = DataDir(data.clone());
        assert_eq!(d.public_key().unwrap(), st.device_key.clone().unwrap());
        let dev = d.device().unwrap().unwrap();
        assert_eq!((dev.device_id.as_deref(), dev.credential.as_deref()), (Some("dev-1"), Some("nvc_cred")));
        // The user named with --user (or sudo's) gets a local runtime socket of their own.
        assert_eq!(d.config().unwrap().local_runtime.users, vec!["alice".to_string()]);
        assert_eq!(dev.roles, vec!["compute".to_string(), "wake-helper".to_string()]);
        assert!(std::fs::read_to_string(data.join("device-cert.pem")).unwrap().starts_with("-----BEGIN CERTIFICATE-----"));
        drop(st);
        // Without --pairing: the Hub names the pairing and the confirmation still matches.
        let data2 = base.join("data2");
        let mut a2 = args(&hub, &data2);
        a2.pairing = None;
        st_reset(&hub);
        assert_eq!(run(&a2, &env(&base, BINARY, FakeRunner::default())).unwrap()["deviceId"], "dev-1");
        let mut a3 = args(&hub, &base.join("data3"));
        a3.pairing = Some("pair-2".into());
        assert!(run(&a3, &env(&base, BINARY, FakeRunner::default())).unwrap_err().contains("wrong code"));
        // A second install into the same folder is refused before the network.
        let again = run(&args(&hub, &data), &env(&base, BINARY, FakeRunner::default())).unwrap_err();
        assert!(again.contains("already enrolled"), "{again}");
        std::fs::remove_dir_all(&base).unwrap();
    }

    fn fails_without_writing(hub: &FakeHub, exe_bytes: &[u8], expect: &str) {
        let base = tmp("install-fail");
        let data = base.join("data");
        let err = run(&args(hub, &data), &env(&base, exe_bytes, FakeRunner::default())).unwrap_err();
        assert!(err.contains(expect), "{err}");
        assert!(!data.exists(), "nothing is written on a refusal: {err}");
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn checks_the_pin() {
        let hub = fake_hub(&sha(BINARY));
        // Another key in hello: its fingerprint is not the pin.
        hub.state.lock().unwrap().hello_key = Some(b64url_encode(&SigningKey::from_seed(&[7u8; 32]).public_key()));
        fails_without_writing(&hub, BINARY, "does not match the pinned fingerprint");
        hub.state.lock().unwrap().hello_key = Some("not-a-key".into());
        fails_without_writing(&hub, BINARY, "not a 32-byte");
        // The right key passes.
        hub.state.lock().unwrap().hello_key = None;
        let id = verify_hub(&hub.url, &pin(), &tls()).unwrap();
        assert_eq!(id.public_key, SigningKey::from_seed(&[42u8; 32]).public_key());
        assert!((id.clock_offset - 120).abs() <= 2, "{}", id.clock_offset);
        assert!(verify_hub(&hub.url, &fingerprint(&[1u8; 32]), &tls()).unwrap_err().contains("pinned"));
        assert!(verify_hub("http://127.0.0.1:1", &pin(), &tls()).unwrap_err().contains("cannot reach"));
    }

    #[test]
    fn checks_the_manifest_signature() {
        let key = SigningKey::from_seed(&[42u8; 32]);
        let fp = fingerprint(&key.public_key());
        let m = manifest_for(&fp, &sha(BINARY));
        let sig = crypto::b64_encode(&key.sign(&tagged(&m)));
        let pk = key.public_key();
        assert_eq!(verify_manifest(&m, &sig, &pk, &fp).unwrap().files.len(), 2);
        assert!(verify_manifest(&m, &format!("{sig}\n"), &pk, &fp).is_ok(), "a trailing newline is fine");
        assert!(verify_manifest(&m, &b64url_encode(&key.sign(&tagged(&m))), &pk, &fp).is_ok(), "base64url too");
        // The domain tag: the Hub key's signature over the bare bytes is not a manifest signature.
        assert!(verify_manifest(&m, &crypto::b64_encode(&key.sign(&m)), &pk, &fp).unwrap_err().contains("does not verify"));
        // Tampered manifest, tampered signature, another signer, another Hub, garbage.
        let mut tampered = m.clone();
        let i = tampered.iter().position(|b| *b == b'0').unwrap();
        tampered[i] = b'1';
        assert!(verify_manifest(&tampered, &sig, &pk, &fp).unwrap_err().contains("does not verify"));
        let mut bad_sig = key.sign(&tagged(&m));
        bad_sig[10] ^= 1;
        assert!(verify_manifest(&m, &crypto::b64_encode(&bad_sig), &pk, &fp).unwrap_err().contains("does not verify"));
        let other = SigningKey::from_seed(&[8u8; 32]);
        assert!(verify_manifest(&m, &crypto::b64_encode(&other.sign(&tagged(&m))), &pk, &fp).unwrap_err().contains("does not verify"));
        let elsewhere = manifest_for(&fingerprint(&[1u8; 32]), &sha(BINARY));
        assert!(verify_manifest(&elsewhere, &crypto::b64_encode(&key.sign(&tagged(&elsewhere))), &pk, &fp).unwrap_err().contains("another Hub"));
        assert!(verify_manifest(&m, "abc", &pk, &fp).unwrap_err().contains("64-byte"));
        let junk = b"not json".to_vec();
        assert!(verify_manifest(&junk, &crypto::b64_encode(&key.sign(&tagged(&junk))), &pk, &fp).unwrap_err().contains("not valid"));

        // Over the wire: a manifest changed after signing stops the install.
        let hub = fake_hub(&sha(BINARY));
        hub.state.lock().unwrap().manifest.push(b' ');
        fails_without_writing(&hub, BINARY, "does not verify");
    }

    #[test]
    fn checks_its_own_binary() {
        // The manifest lists another hash for this platform.
        let hub = fake_hub(&sha(b"the real build"));
        fails_without_writing(&hub, BINARY, "is not the Hub's signed build");
        let base = tmp("selfhash");
        let exe = base.join("x");
        std::fs::write(&exe, BINARY).unwrap();
        let m = DistManifest { version: None, files: vec![], hub_fingerprint: None, signed_at: None };
        assert!(check_binary(&m, BINARY, &exe, "linux", "amd64").unwrap_err().contains("no build for linux-amd64"));
        let ok = DistManifest { files: vec![DistFile { name: "novad-linux-amd64".into(), os: "linux".into(), arch: "amd64".into(), sha256: sha(BINARY).to_uppercase(), size: 1 }], ..m };
        assert_eq!(check_binary(&ok, &read_binary(&exe).unwrap(), &exe, "linux", "amd64").unwrap().name, "novad-linux-amd64");
        assert!(read_binary(&base.join("missing")).unwrap_err().contains("cannot read"));
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn stops_when_denied_expired_or_tampered() {
        let hub = fake_hub(&sha(BINARY));
        hub.state.lock().unwrap().decision = "denied";
        fails_without_writing(&hub, BINARY, "denied");
        let hub = fake_hub(&sha(BINARY));
        hub.state.lock().unwrap().decision = "expired";
        fails_without_writing(&hub, BINARY, "expired");
        // An approval whose grant was already delivered.
        let hub = fake_hub(&sha(BINARY));
        {
            let mut st = hub.state.lock().unwrap();
            st.grant_sent = true;
        }
        fails_without_writing(&hub, BINARY, "sent no grant");
        // A confirmation computed over something else: a key swapped in the middle.
        let hub = fake_hub(&sha(BINARY));
        hub.state.lock().unwrap().confirmation = Some("000001".into());
        fails_without_writing(&hub, BINARY, "differs from this device's");
    }

    /// Review finding 1: whatever sits between the device and the Hub, the confirmation is shown
    /// only when the pinned Hub key signed it over this device's own key.
    #[test]
    fn shows_the_code_only_when_the_pinned_hub_signed_it_for_this_key() {
        let attacker = b64url_encode(&SigningKey::from_seed(&[66u8; 32]).public_key());
        let bad: [(&str, Box<dyn Fn(&mut HubState)>); 3] = [
            // Signed by the Hub with the right digits, but over another device key (the Hub was
            // talking to an attacker's key): the signature names the wrong key.
            ("another device key", Box::new(move |st| st.signed_device_key = Some(attacker.clone()))),
            // Signed by a key that is not the pinned one (an impostor relaying the hello).
            ("another signer", Box::new(|st| st.sign_seed = Some([7u8; 32]))),
            ("no signature", Box::new(|st| st.no_signature = true)),
        ];
        for (what, change) in bad {
            let hub = fake_hub(&sha(BINARY));
            change(&mut hub.state.lock().unwrap());
            fails_without_writing(&hub, BINARY, "This is not your Hub");
            // Stopped at the reveal: the code was never shown and the device never polled.
            assert_eq!(hub.state.lock().unwrap().polls, 0, "{what}");
        }
    }

    #[test]
    fn commits_before_it_reveals() {
        let hub = fake_hub(&sha(BINARY));
        let id = verify_hub(&hub.url, &pin(), &tls()).unwrap();
        let key = SigningKey::from_seed(&[5u8; 32]);
        let a = args(&hub, Path::new("/nonexistent"));
        let nonce = new_nonce().unwrap();
        assert_ne!(nonce, new_nonce().unwrap());
        let c = complete(&a, &key, &nonce, "box", "linux", &tls()).unwrap();
        assert_eq!((c.request_id.as_str(), c.pairing_id.as_str()), ("req-1", PAIRING));
        // The Hub has only the commitment; the nonce leaves the device after the Hub's is fixed.
        let pk = b64url_encode(&key.public_key());
        assert_eq!(hub.state.lock().unwrap().commitment.as_deref(), Some(commitment(&pk, &nonce).as_str()));
        // Revealing another nonce is refused by the Hub (it burns the request).
        let err = reveal(&a, &c, &key, &new_nonce().unwrap(), &id, &tls()).unwrap_err();
        assert!(err.contains("bad_reveal"), "{err}");
        let c = complete(&a, &key, &nonce, "box", "linux", &tls()).unwrap();
        let (conf, at) = reveal(&a, &c, &key, &nonce, &id, &tls()).unwrap();
        assert_eq!(conf, confirmation(&pin(), PAIRING, &pk, CODE, &nonce, &c.hub_nonce));
        assert!((at - (now_secs() + 120)).abs() <= 2, "signed at the Hub's time");
        std::thread::sleep(Duration::from_millis(1100));
        let err = reveal(&a, &c, &key, &nonce, &id, &tls()).unwrap_err();
        assert!(err.contains("already_revealed"), "{err}");
        // A Hub that does not speak v2 (no nonce in its answer) is refused.
        hub.state.lock().unwrap().hub_nonce = "short".into();
        assert!(complete(&a, &key, &nonce, "box", "linux", &tls()).unwrap_err().contains("hubNonce"));
    }

    #[test]
    fn waits_the_pending_window_not_the_reveal_deadline() {
        // The commit answer's expiry is the 2-minute reveal window; approval may take 10 minutes.
        let revealed = 1_000_000;
        assert_eq!(approval_deadline(Some(revealed + 120), revealed), revealed + DEFAULT_WAIT_SECS);
        assert_eq!(approval_deadline(None, revealed), revealed + DEFAULT_WAIT_SECS);
        // A Hub that says it waits longer is believed.
        assert_eq!(approval_deadline(Some(revealed + 3_600), revealed), revealed + 3_600);
    }

    #[test]
    fn gives_up_at_the_deadline_and_retries_server_errors() {
        let hub = fake_hub(&sha(BINARY));
        hub.state.lock().unwrap().decision = "busy";
        let id = verify_hub(&hub.url, &pin(), &tls()).unwrap();
        let key = SigningKey::from_seed(&[5u8; 32]);
        hub.state.lock().unwrap().device_key = Some(b64url_encode(&key.public_key()));
        {
            let mut st = hub.state.lock().unwrap();
            st.revealed = true;
        }
        let deadline = now_secs() + id.clock_offset + 3;
        let t0 = std::time::Instant::now();
        let err = wait_for_approval(&hub.url, "req-1", &key, &id, 0, deadline, Poll { start: Duration::from_millis(20), max: Duration::from_millis(50) }, &std::thread::sleep, &tls()).unwrap_err();
        assert!(err.contains("not approved in time"), "{err}");
        assert!(t0.elapsed() < Duration::from_secs(5));
        assert!(hub.state.lock().unwrap().polls >= 3, "503s are retried, one poll per second at most");
        // A refused signature is not retried.
        let wrong = SigningKey::from_seed(&[6u8; 32]);
        let err = wait_for_approval(&hub.url, "req-1", &wrong, &id, 0, deadline + 60, Poll { start: Duration::from_millis(1), max: Duration::from_millis(1) }, &|_| {}, &tls()).unwrap_err();
        assert!(err.contains("refused the status check (401)"), "{err}");
    }

    #[test]
    fn preflight_refusals_and_dry_run() {
        let hub = fake_hub(&sha(BINARY));
        let base = tmp("preflight");
        let data = base.join("data");
        let mut a = args(&hub, &data);
        a.no_service = false;
        let err = run(&a, &env(&base, BINARY, FakeRunner::default())).unwrap_err();
        assert!(err.contains("needs root"), "{err}");
        a.dry_run = true;
        let out = run(&a, &env(&base, BINARY, FakeRunner::default())).unwrap();
        assert_eq!(out["dryRun"], true);
        assert!(!data.exists());
        assert_eq!(hub.state.lock().unwrap().device_key, None, "a dry run never sends the code");
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn installs_the_service_when_asked() {
        let base = tmp("service");
        let hub = fake_hub(&sha(BINARY));
        let data = base.join("data");
        let mut a = args(&hub, &data);
        a.no_service = false;
        let runner = FakeRunner::default();
        let mut e = env(&base, BINARY, runner.clone());
        e.elevated = true;
        let out = run(&a, &e).unwrap();
        assert_eq!(out["service"]["ran"], json!(["systemctl daemon-reload", "systemctl enable --now novad.service"]));
        let bin = base.join("bin/novad");
        assert_eq!(std::fs::read(&bin).unwrap(), BINARY);
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&bin).unwrap().permissions().mode() & 0o777, 0o755);
        let unit = std::fs::read_to_string(base.join("units/novad.service")).unwrap();
        assert!(unit.contains(&format!("ExecStart={} run --data-dir {}", bin.display(), data.display())), "{unit}");
        assert_eq!(runner.calls.lock().unwrap().len(), 2);
        // macOS and Windows commands; bytes that are not the signed build are never installed.
        let mac = ServiceSetup { platform: "macos", bin_path: bin.clone(), unit_path: base.join("units/ai.nova.novad.plist"), runner: Box::new(runner.clone()) };
        assert_eq!(mac.install(BINARY, &sha(BINARY), "/d").unwrap(), vec![format!("launchctl load -w {}", base.join("units/ai.nova.novad.plist").display())]);
        assert!(mac.install(b"other", &sha(BINARY), "/d").unwrap_err().contains("not the signed build"));
        assert_eq!(runner.calls.lock().unwrap().len(), 3, "nothing ran for the refused bytes");
        let win = ServiceSetup { platform: "windows", bin_path: base.join("win/novad.exe"), unit_path: PathBuf::new(), runner: Box::new(runner.clone()) };
        let ran = win.install(BINARY, &sha(BINARY), "C:\\ProgramData\\Nova").unwrap();
        assert!(ran[0].starts_with("sc.exe create novad binPath= "), "{}", ran[0]);
        assert_eq!(ran[2], "sc.exe start novad");
        std::fs::remove_dir_all(&base).unwrap();
    }

    /// Review finding 12: the bytes that were hashed are the bytes installed, whatever happens
    /// to the downloaded file while the owner decides.
    #[test]
    fn installs_the_bytes_it_checked() {
        let base = tmp("swap");
        let hub = fake_hub(&sha(BINARY));
        let data = base.join("data");
        let mut a = args(&hub, &data);
        a.no_service = false;
        let mut e = env(&base, BINARY, FakeRunner::default());
        e.elevated = true;
        hub.state.lock().unwrap().swap_exe = Some((e.exe.clone(), b"#!/bin/sh\necho swapped\n".to_vec()));
        run(&a, &e).unwrap();
        assert_eq!(std::fs::read(&e.exe).unwrap(), b"#!/bin/sh\necho swapped\n", "the download was swapped while waiting");
        assert_eq!(std::fs::read(base.join("bin/novad")).unwrap(), BINARY, "the checked bytes were installed");
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn confirmation_and_endpoint_helpers() {
        let c = confirmation("fp", "p", "k", "ABCDEFGH", "dn", "hn");
        assert_eq!(c.len(), 6);
        assert!(c.chars().all(|ch| ch.is_ascii_digit()));
        // Fixed vectors (Python hashlib): SHA-256("nova-add-device-v2|fp|p|k|ABCDEFGH|dn|hn") as
        // a big-endian integer mod 10^6, and the commitment for key k and nonce dn.
        assert_eq!(c, "197214");
        assert_eq!(commitment("k", "dn"), "WHPQg2Je6114JjfXnxMiCurMmvtdz25l6AUiqqOmSwE");
        for (i, other) in [("fp2", "p", "k", "dn", "hn"), ("fp", "p2", "k", "dn", "hn"), ("fp", "p", "k2", "dn", "hn"), ("fp", "p", "k", "dn2", "hn"), ("fp", "p", "k", "dn", "hn2")].iter().enumerate() {
            assert_ne!(c, confirmation(other.0, other.1, other.2, "ABCDEFGH", other.3, other.4), "input {i} counts");
        }
        assert_eq!(reveal_statement("r", "p", "k", "123456"), "nova-add-device-reveal-v1|r|p|k|123456");
        assert_eq!(display_code("ABCDEFGH"), "ABCD-EFGH");
        let hub = fake_hub(&sha(BINARY));
        let mut a = args(&hub, Path::new("/nonexistent"));
        assert_eq!(resolve_endpoint(&a).unwrap(), "http://127.0.0.1:7499");
        a.listen = "0.0.0.0:7420".into();
        assert_eq!(resolve_endpoint(&a).unwrap(), "http://127.0.0.1:7420", "the address toward the Hub");
        a.endpoint = Some("http://10.0.0.9:7420/".into());
        assert_eq!(resolve_endpoint(&a).unwrap(), "http://10.0.0.9:7420");
        let (os, arch) = this_platform();
        assert!(matches!(os, "linux" | "darwin" | "windows"), "{os}");
        assert!(matches!(arch, "amd64" | "arm64"), "{arch}");
        assert!(parse_grant(&json!({ "type": "compute", "enrollToken": "nve_x" })).is_err());
        assert!(parse_grant(&json!({ "type": "novad", "enrollToken": "nvd_short" })).is_err());
        let g = parse_grant(&json!({ "type": "novad", "enrollToken": "nvd_0123456789abcdefgh", "certificatePem": "junk" })).unwrap();
        assert_eq!(g.certificate_pem, None);
    }
}
