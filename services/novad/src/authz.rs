//! Hub-signed authorizations for privileged device actions (D2 of ADR-096; FR-143, FR-146,
//! R-022). Firmware apply and rollback, boot set, commit and revert, and decommission are refused
//! without one, whatever the management token says: a stolen token cannot change firmware.
//!
//! The authorization travels in the request body as `authorization: {payload, signature}`.
//! `payload` is `{v: 1, kind, deviceId, changeId, bodySha256, approvalId, issuedAt, expiresAt}`;
//! the signature is Ed25519 by the Hub identity key over `"nova-device-authz-v1\n"` followed by the
//! payload's canonical JSON (keys sorted, no whitespace), base64url. `bodySha256` is the hex
//! SHA-256 of the canonical JSON of the body without `authorization` (a body hashed also without
//! its short-lived `adminPassword` is accepted too, so a hash never has to cover a secret). The
//! key is the one the pinned fingerprint names (`hub-trust.json`): it is read once from the Hub's
//! hello and kept in `hub-key.json` only when it hashes to the pin, so no network answer can
//! substitute another key. A used `changeId` is kept for 24 h (`authz-replay.json`, 0600).
//!
//! The downgrade check of D1 runs first: a device that holds a certificate refuses these
//! requests over plain HTTP (`tls_required`).

use crate::capabilities::canonical_json;
use crate::crypto::{b64url_decode, b64url_encode, hex, sha256, verify};
use crate::state::DataDir;
use crate::util::{OpError, OpResult, now_ms, parse_iso, read_json_or, write_json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::Mutex;
use std::time::Duration;

pub const TAG: &str = "nova-device-authz-v1\n";
/// The kinds a Hub may sign (D2).
pub const KINDS: &[&str] = &["firmware.apply", "firmware.rollback", "boot.set", "boot.commit", "boot.revert", "device.decommission"];
/// An authorization lives at most this long (`expiresAt - issuedAt`).
pub const MAX_LIFETIME_MS: u64 = 10 * 60_000;
/// Clock skew allowed between the Hub and the device.
pub const SKEW_MS: u64 = 120_000;
/// How long a used change id is remembered.
pub const REPLAY_KEEP_MS: u64 = 24 * 3_600_000;
/// The replay store's bound. Entries older than an authorization can live are dropped first.
pub const MAX_REPLAY: usize = 4096;
pub const KEY_FILE: &str = "hub-key.json";
pub const REPLAY_FILE: &str = "authz-replay.json";
const HELLO_TIMEOUT: Duration = Duration::from_secs(10);

/// One process-wide lock: every privileged route, R2's decommission included, shares the store.
static REPLAY_LOCK: Mutex<()> = Mutex::new(());

/// How a management request arrived (D1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Transport {
    Plain,
    MutualTls,
}

/// A verified authorization.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Authorization {
    pub kind: String,
    pub device_id: String,
    pub change_id: String,
    pub approval_id: String,
    pub issued_at_ms: u64,
    pub expires_at_ms: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct HubKey {
    public_key: String,
    fingerprint: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Used {
    change_id: String,
    at_ms: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct ReplayFile {
    used: Vec<Used>,
}

fn invalid(message: impl Into<String>) -> OpError {
    OpError::denied("authorization_invalid", message)
}

fn mismatch(message: impl Into<String>) -> OpError {
    OpError::denied("authorization_mismatch", message)
}

fn expired(message: impl Into<String>) -> OpError {
    OpError::denied("authorization_expired", message)
}

/// Whether this device holds a certificate, so its management channel is mutual TLS (D1). The
/// file's presence is what counts: a damaged certificate still refuses plain HTTP.
pub fn has_certificate(data: &DataDir) -> bool {
    data.path().join(crate::tls::DEVICE_CERT_FILE).exists()
}

/// The hex SHA-256 of a body's canonical JSON without `authorization` (and the fields in
/// `also_without`).
pub fn body_sha256(body: &Value, also_without: &[&str]) -> String {
    let mut b = body.clone();
    if let Some(o) = b.as_object_mut() {
        o.remove("authorization");
        for k in also_without {
            o.remove(*k);
        }
    }
    hex(&sha256(canonical_json(&b).as_bytes()))
}

/// The exact bytes the Hub signs.
pub fn signed_bytes(payload: &Value) -> String {
    format!("{TAG}{}", canonical_json(payload))
}

/// Milliseconds from an ISO timestamp (`toISOString`) or an integer of epoch milliseconds.
fn time_ms(v: &Value) -> Option<u64> {
    if let Some(n) = v.as_u64() {
        return Some(n);
    }
    let s = v.as_str()?;
    let secs = parse_iso(s)?;
    let frac = s.get(19..s.len() - 1).and_then(|f| f.strip_prefix('.')).unwrap_or("");
    let ms: u64 = format!("{:0<3}", frac.get(..frac.len().min(3)).unwrap_or("")).parse().unwrap_or(0);
    Some(secs * 1000 + ms)
}

/// A UUIDv7 (`xxxxxxxx-xxxx-7xxx-[89ab]xxx-xxxxxxxxxxxx`).
pub fn is_uuid_v7(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| if [8, 13, 18, 23].contains(&i) { *c == b'-' } else { c.is_ascii_hexdigit() })
        && b[14] == b'7'
        && matches!(b[19].to_ascii_lowercase(), b'8' | b'9' | b'a' | b'b')
}

/// The Hub key the pin names: the cached one when it still hashes to the pin, else read from the
/// Hub's hello (only accepted when it hashes to the pin). None without a pin.
pub fn hub_key(data: &DataDir) -> OpResult<[u8; 32]> {
    let pin = crate::tls::HubTrust::load(&data.path().join(crate::tls::TRUST_FILE))
        .and_then(|t| t.pin)
        .ok_or_else(|| invalid("this device has no pinned Hub identity to check authorizations with; add it again"))?;
    let path = data.path().join(KEY_FILE);
    let pinned = |text: &str| -> Option<[u8; 32]> {
        let key: [u8; 32] = b64url_decode(text)?.try_into().ok()?;
        (crate::install::fingerprint(&key) == pin).then_some(key)
    };
    if let Some(key) = read_json_or::<Option<HubKey>>(&path, None).ok().flatten().and_then(|k| pinned(&k.public_key)) {
        return Ok(key);
    }
    let hub = data.device()?.and_then(|d| d.hub_url).ok_or_else(|| invalid("this device has no Hub"))?;
    let tls = crate::tls::TlsContext::for_data(data);
    let (status, hello) = crate::http::get_json_with(&format!("{hub}/api/v1/hello"), None, HELLO_TIMEOUT, tls.as_ref())
        .map_err(|e| OpError::unavailable(format!("the Hub's identity key could not be read to check the authorization: {e}")))?;
    let key = hello["hubPublicKey"]
        .as_str()
        .filter(|_| status == 200)
        .and_then(pinned)
        .ok_or_else(|| invalid("the Hub's identity key does not match the pinned fingerprint"))?;
    save_hub_key(data, &b64url_encode(&key))?;
    Ok(key)
}

/// Keep the Hub key (base64url raw Ed25519); `hub_key` uses it only while it hashes to the pin.
pub fn save_hub_key(data: &DataDir, public_key: &str) -> OpResult<()> {
    let fingerprint = b64url_decode(public_key)
        .and_then(|b| <[u8; 32]>::try_from(b).ok())
        .map(|k| crate::install::fingerprint(&k))
        .ok_or_else(|| OpError::validation("not a raw Ed25519 key"))?;
    write_json(&data.path().join(KEY_FILE), &HubKey { public_key: public_key.to_string(), fingerprint }, true).map_err(OpError::from)
}

/// D1 + D2 for one privileged request of `kind`: refuse plain HTTP on a device with a certificate,
/// then verify the authorization in `body` and spend its change id.
pub fn authorize(data: &DataDir, kind: &str, body: &Value, transport: Transport) -> OpResult<Authorization> {
    authorize_at(data, kind, body, transport, now_ms())
}

pub fn authorize_at(data: &DataDir, kind: &str, body: &Value, transport: Transport, now: u64) -> OpResult<Authorization> {
    if transport == Transport::Plain && has_certificate(data) {
        return Err(OpError::denied("tls_required", "this device takes privileged requests only over mutual TLS"));
    }
    let a = body.get("authorization").filter(|v| v.is_object()).ok_or_else(|| invalid("a Hub-signed authorization is required"))?;
    let (payload, signature) = (&a["payload"], a["signature"].as_str().unwrap_or_default());
    if !payload.is_object() {
        return Err(invalid("the authorization has no payload"));
    }
    let key = hub_key(data)?;
    let sig: [u8; 64] = b64url_decode(signature).and_then(|b| b.try_into().ok()).ok_or_else(|| invalid("the authorization signature is malformed"))?;
    if !verify(&key, signed_bytes(payload).as_bytes(), &sig) {
        return Err(invalid("the authorization is not signed by this device's Hub"));
    }
    let auth = check(payload, kind, &own_device_id(data)?, body, now)?;
    spend(data, &auth.change_id, now)?;
    Ok(auth)
}

fn own_device_id(data: &DataDir) -> OpResult<String> {
    Ok(data.device()?.and_then(|d| d.device_id).unwrap_or_default())
}

/// The payload's fields, after its signature verified.
pub fn check(p: &Value, kind: &str, device_id: &str, body: &Value, now: u64) -> OpResult<Authorization> {
    let s = |k: &str| p[k].as_str().filter(|v| !v.is_empty() && v.len() <= 200).map(str::to_string);
    if p["v"].as_u64() != Some(1) {
        return Err(invalid("unknown authorization version"));
    }
    let signed_kind = s("kind").filter(|k| KINDS.contains(&k.as_str())).ok_or_else(|| invalid("unknown authorization kind"))?;
    let change_id = s("changeId").filter(|c| is_uuid_v7(c)).ok_or_else(|| invalid("changeId must be a UUIDv7"))?.to_ascii_lowercase();
    let approval_id = s("approvalId").ok_or_else(|| invalid("approvalId is required"))?;
    let signed_device = s("deviceId").ok_or_else(|| invalid("deviceId is required"))?;
    let hash = s("bodySha256").filter(|h| h.len() == 64 && h.bytes().all(|c| c.is_ascii_hexdigit())).ok_or_else(|| invalid("bodySha256 must be a SHA-256 in hex"))?;
    let (issued, expires) = match (time_ms(&p["issuedAt"]), time_ms(&p["expiresAt"])) {
        (Some(i), Some(e)) => (i, e),
        _ => return Err(invalid("issuedAt and expiresAt must be timestamps")),
    };
    if expires <= issued || expires - issued > MAX_LIFETIME_MS {
        return Err(invalid("an authorization lives at most 10 minutes"));
    }
    if device_id.is_empty() || signed_device != device_id {
        return Err(mismatch("the authorization is for another device"));
    }
    if signed_kind != kind {
        return Err(mismatch(format!("the authorization is for {signed_kind}, not {kind}")));
    }
    let hash = hash.to_ascii_lowercase();
    if hash != body_sha256(body, &[]) && hash != body_sha256(body, &["adminPassword"]) {
        return Err(mismatch("the authorization is for another request body"));
    }
    if now > expires.saturating_add(SKEW_MS) {
        return Err(expired("the authorization expired"));
    }
    if now.saturating_add(SKEW_MS) < issued {
        return Err(expired("the authorization is not valid yet; check the device clock"));
    }
    Ok(Authorization { kind: signed_kind, device_id: signed_device, change_id, approval_id, issued_at_ms: issued, expires_at_ms: expires })
}

/// Spend a change id: refused when seen in the last 24 h (409 `replayed`).
fn spend(data: &DataDir, change_id: &str, now: u64) -> OpResult<()> {
    let _guard = REPLAY_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let path = data.path().join(REPLAY_FILE);
    // A store that cannot be read fails closed: an empty one would accept a replay.
    let mut f: ReplayFile = read_json_or(&path, ReplayFile::default()).map_err(|e| {
        OpError::internal(format!("the authorization replay store cannot be read ({e}); privileged requests are refused until it is fixed or removed by the device owner")).with(json!({ "reason": "replay_store_unreadable" }))
    })?;
    // A clock that went back keeps its entries (at_ms in the future) rather than forgetting them.
    f.used.retain(|u| u.at_ms > now || now - u.at_ms < REPLAY_KEEP_MS);
    if f.used.iter().any(|u| u.change_id == change_id) {
        return Err(OpError::conflict("this authorization was already used").with(json!({ "reason": "replayed" })));
    }
    if f.used.len() >= MAX_REPLAY {
        // Past its lifetime and the skew an authorization can no longer verify, so its id is
        // safe to forget.
        let window = MAX_LIFETIME_MS + 2 * SKEW_MS;
        f.used.retain(|u| u.at_ms > now || now - u.at_ms < window);
        if f.used.len() >= MAX_REPLAY {
            return Err(OpError::new(429, "rate_limited", "too many privileged requests; try again later"));
        }
    }
    f.used.push(Used { change_id: change_id.to_string(), at_ms: now });
    write_json(&path, &f, true).map_err(OpError::from)
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::crypto::SigningKey;
    use crate::grants::tests::tmp;
    use crate::tls::HubTrust;
    use crate::tls::tests::{HUB_SEED, hub_pin};

    pub const NOW: u64 = 1_792_000_000_000;
    /// K's vectors (packages/core/test/fixtures/device-authz-vectors.json), copied into the crate
    /// because the containerized cargo sees only services/novad.
    const VECTORS: &str = include_str!("../tests/fixtures/device-authz-vectors.json");

    /// A data folder enrolled as `dev-1` with the test Hub pinned and its key cached.
    pub fn enrolled(name: &str) -> (std::path::PathBuf, DataDir) {
        let base = tmp(name);
        let data = DataDir(base.join("data"));
        data.ensure().unwrap();
        let mut d = data.new_device("box", vec!["client".into()]).unwrap();
        d.device_id = Some("dev-1".into());
        d.management_token = Some("nvdm_test".into());
        data.save_device(&d).unwrap();
        HubTrust::pinned(&hub_pin()).save(&data.path().join(crate::tls::TRUST_FILE)).unwrap();
        save_hub_key(&data, &b64url_encode(&SigningKey::from_seed(&HUB_SEED).public_key())).unwrap();
        (base, data)
    }

    /// A new UUIDv7-shaped change id.
    pub fn change_id() -> String {
        let h = crate::util::new_id();
        format!("{}-{}-7{}-8{}-{}", &h[..8], &h[8..12], &h[13..16], &h[17..20], &h[20..32])
    }

    /// `body` with an authorization of `kind` for `dev-1`, signed by `seed`, issued at `at`.
    pub fn signed(seed: &[u8; 32], kind: &str, body: &Value, at: u64) -> Value {
        signed_with(seed, json!({ "kind": kind, "deviceId": "dev-1", "issuedAt": crate::util::iso(at), "expiresAt": crate::util::iso(at + 5 * 60_000) }), body)
    }

    /// `body` with an authorization whose payload has `fields` over the defaults.
    pub fn signed_with(seed: &[u8; 32], fields: Value, body: &Value) -> Value {
        let mut payload = json!({ "v": 1, "changeId": change_id(), "approvalId": "appr-1", "bodySha256": body_sha256(body, &[]) });
        for (k, v) in fields.as_object().unwrap() {
            payload[k] = v.clone();
        }
        let sig = SigningKey::from_seed(seed).sign(signed_bytes(&payload).as_bytes());
        let mut out = body.clone();
        out["authorization"] = json!({ "payload": payload, "signature": b64url_encode(&sig) });
        out
    }

    fn reason(e: &OpError) -> (u16, String) {
        (e.status, e.details.as_ref().and_then(|d| d["reason"].as_str()).unwrap_or_default().to_string())
    }

    #[test]
    fn the_vectors_copy_matches_the_hubs() {
        // Where the whole repository is visible (CI's native cargo), the copy must not drift.
        let hub = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/core/test/fixtures/device-authz-vectors.json");
        if let Ok(text) = std::fs::read_to_string(&hub) {
            assert_eq!(text, VECTORS, "copy packages/core/test/fixtures/device-authz-vectors.json to services/novad/tests/fixtures/");
        }
    }

    #[test]
    fn verifies_the_shared_vectors() {
        let v: Value = serde_json::from_str(VECTORS).unwrap();
        assert_eq!(v["tag"].as_str(), Some(TAG));
        let seed: [u8; 32] = crate::crypto::hex_decode(v["seedHex"].as_str().unwrap()).unwrap().try_into().unwrap();
        let key = SigningKey::from_seed(&seed);
        assert_eq!(b64url_encode(&key.public_key()), v["publicKey"].as_str().unwrap());
        let pk: [u8; 32] = b64url_decode(v["publicKey"].as_str().unwrap()).unwrap().try_into().unwrap();
        for c in v["vectors"].as_array().unwrap() {
            let name = c["name"].as_str().unwrap();
            assert_eq!(canonical_json(&c["payload"]), c["canonical"].as_str().unwrap(), "{name}: canonical JSON");
            assert_eq!(body_sha256(&c["body"], &[]), c["bodySha256"].as_str().unwrap(), "{name}: body hash");
            assert_eq!(c["payload"]["bodySha256"], c["bodySha256"]);
            let sig: [u8; 64] = b64url_decode(c["signature"].as_str().unwrap()).unwrap().try_into().unwrap();
            assert!(verify(&pk, signed_bytes(&c["payload"]).as_bytes(), &sig), "{name}: signature");
            if let Some(h) = c["signedBytesHex"].as_str() {
                assert_eq!(hex(signed_bytes(&c["payload"]).as_bytes()), h, "{name}: signed bytes");
            }
            // Ed25519 is deterministic: this side signs the same bytes to the same signature.
            assert_eq!(b64url_encode(&key.sign(signed_bytes(&c["payload"]).as_bytes())), c["signature"].as_str().unwrap(), "{name}");
            let now = time_ms(&c["now"]).unwrap_or_else(|| time_ms(&c["payload"]["issuedAt"]).unwrap() + 1000);
            let kind = c["payload"]["kind"].as_str().unwrap();
            let mut body = c["body"].clone();
            body["authorization"] = json!({ "payload": c["payload"], "signature": c["signature"] });
            let a = check(&c["payload"], kind, v["deviceId"].as_str().unwrap_or("dev-1"), &body, now).unwrap();
            assert_eq!(a.approval_id, c["payload"]["approvalId"].as_str().unwrap());
            // A tampered payload no longer verifies.
            let mut p = c["payload"].clone();
            p["deviceId"] = json!("dev-2");
            assert!(!verify(&pk, signed_bytes(&p).as_bytes(), &sig));
        }
    }

    #[test]
    fn accepts_a_valid_authorization_once() {
        let (base, data) = enrolled("authz-ok");
        let body = signed(&HUB_SEED, "firmware.apply", &json!({ "planId": "p", "changes": [{ "key": "wol", "value": "LanOnly" }] }), NOW);
        let a = authorize_at(&data, "firmware.apply", &body, Transport::Plain, NOW + 1000).unwrap();
        assert_eq!((a.kind.as_str(), a.device_id.as_str(), a.approval_id.as_str()), ("firmware.apply", "dev-1", "appr-1"));
        assert_eq!(a.expires_at_ms - a.issued_at_ms, 5 * 60_000);
        // The same change id again: replayed, even inside its window.
        let e = authorize_at(&data, "firmware.apply", &body, Transport::Plain, NOW + 2000).unwrap_err();
        assert_eq!(reason(&e), (409, "replayed".into()));
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(data.path().join(REPLAY_FILE)).unwrap().permissions().mode() & 0o777, 0o600);
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn refuses_every_bad_authorization() {
        let (base, data) = enrolled("authz-bad");
        let body = json!({ "profileId": "lab", "entryId": "nova.conf", "reboot": false });
        let refused = |b: &Value, kind: &str, now: u64| reason(&authorize_at(&data, kind, b, Transport::Plain, now).unwrap_err());
        let invalid = (403, "authorization_invalid".to_string());
        let mismatch = (403, "authorization_mismatch".to_string());
        let expired = (403, "authorization_expired".to_string());
        assert_eq!(refused(&body, "boot.set", NOW), invalid, "missing");
        assert_eq!(refused(&signed(&[99u8; 32], "boot.set", &body, NOW), "boot.set", NOW), invalid, "another key");
        let mut tampered = signed(&HUB_SEED, "boot.set", &body, NOW);
        tampered["authorization"]["payload"]["approvalId"] = json!("appr-2");
        assert_eq!(refused(&tampered, "boot.set", NOW), invalid, "tampered payload");
        let mut bad_sig = signed(&HUB_SEED, "boot.set", &body, NOW);
        bad_sig["authorization"]["signature"] = json!("not-base64!");
        assert_eq!(refused(&bad_sig, "boot.set", NOW), invalid);
        assert_eq!(refused(&signed(&HUB_SEED, "boot.set", &body, NOW), "boot.commit", NOW), mismatch, "wrong kind");
        assert_eq!(refused(&signed_with(&HUB_SEED, json!({ "kind": "boot.set", "deviceId": "dev-2", "issuedAt": crate::util::iso(NOW), "expiresAt": crate::util::iso(NOW + 60_000) }), &body), "boot.set", NOW), mismatch, "wrong device");
        let mut other_body = signed(&HUB_SEED, "boot.set", &body, NOW);
        other_body["entryId"] = json!("evil.conf");
        assert_eq!(refused(&other_body, "boot.set", NOW), mismatch, "body changed after signing");
        let at = NOW - 10 * 60_000;
        assert_eq!(refused(&signed(&HUB_SEED, "boot.set", &body, at), "boot.set", NOW), expired, "expired 5 minutes ago");
        // Within the skew it still passes; past the skew it is expired, both ways.
        assert!(authorize_at(&data, "boot.set", &signed(&HUB_SEED, "boot.set", &body, NOW - 6 * 60_000), Transport::Plain, NOW).is_ok());
        assert_eq!(refused(&signed(&HUB_SEED, "boot.set", &body, NOW + 3 * 60_000), "boot.set", NOW), expired, "issued in the future");
        assert!(authorize_at(&data, "boot.set", &signed(&HUB_SEED, "boot.set", &body, NOW + 60_000), Transport::Plain, NOW).is_ok());
        let long = json!({ "kind": "boot.set", "deviceId": "dev-1", "issuedAt": crate::util::iso(NOW), "expiresAt": crate::util::iso(NOW + 11 * 60_000) });
        assert_eq!(refused(&signed_with(&HUB_SEED, long, &body), "boot.set", NOW), invalid, "longer than 10 minutes");
        for (field, value) in [("v", json!(2)), ("kind", json!("firmware.flash")), ("changeId", json!("not-a-uuid")), ("changeId", json!("0192a3b4-c5d6-4e8f-9a0b-1c2d3e4f5a6b")), ("bodySha256", json!("abc")), ("approvalId", json!(""))] {
            let f = json!({ "kind": "boot.set", "deviceId": "dev-1", "issuedAt": crate::util::iso(NOW), "expiresAt": crate::util::iso(NOW + 60_000), field: value });
            assert_eq!(refused(&signed_with(&HUB_SEED, f, &body), "boot.set", NOW), invalid, "{field}");
        }
        // An invalid authorization does not spend its change id.
        let ok = signed(&HUB_SEED, "boot.set", &body, NOW);
        assert_eq!(refused(&ok, "boot.revert", NOW), mismatch);
        assert!(authorize_at(&data, "boot.set", &ok, Transport::Plain, NOW).is_ok());
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn refuses_plain_http_once_the_device_holds_a_certificate() {
        let (base, data) = enrolled("authz-tls");
        let body = signed(&HUB_SEED, "boot.revert", &json!({}), NOW);
        std::fs::write(data.path().join(crate::tls::DEVICE_CERT_FILE), "-----BEGIN CERTIFICATE-----\n").unwrap();
        assert!(has_certificate(&data));
        assert_eq!(reason(&authorize_at(&data, "boot.revert", &body, Transport::Plain, NOW).unwrap_err()), (403, "tls_required".into()));
        assert!(authorize_at(&data, "boot.revert", &body, Transport::MutualTls, NOW).is_ok());
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn hashes_without_the_admin_password_too() {
        let (base, data) = enrolled("authz-pw");
        let plain = json!({ "snapshotId": "s1" });
        let mut body = signed(&HUB_SEED, "firmware.rollback", &plain, NOW);
        body["adminPassword"] = json!("hunter2");
        assert!(authorize_at(&data, "firmware.rollback", &body, Transport::Plain, NOW).is_ok());
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn reads_the_hub_key_only_when_it_hashes_to_the_pin() {
        let (base, data) = enrolled("authz-key");
        let pk = b64url_encode(&SigningKey::from_seed(&HUB_SEED).public_key());
        let other = b64url_encode(&SigningKey::from_seed(&[5u8; 32]).public_key());
        let served = std::sync::Arc::new(Mutex::new(other.clone()));
        let s = served.clone();
        let server = crate::http::serve(
            std::net::TcpListener::bind("127.0.0.1:0").unwrap(),
            1 << 16,
            std::sync::Arc::new(move |_: crate::http::Request| crate::http::Response::json(200, &json!({ "name": "nova-hub", "hubPublicKey": s.lock().unwrap().clone() }))),
        );
        let mut d = data.device().unwrap().unwrap();
        d.hub_url = Some(format!("http://{}", server.local_addr()));
        data.save_device(&d).unwrap();
        std::fs::remove_file(data.path().join(KEY_FILE)).unwrap();
        // The Hub's hello offers a key that is not the pinned one: refused, nothing cached.
        assert_eq!(reason(&hub_key(&data).unwrap_err()), (403, "authorization_invalid".into()));
        assert!(!data.path().join(KEY_FILE).exists());
        *served.lock().unwrap() = pk.clone();
        assert_eq!(b64url_encode(&hub_key(&data).unwrap()), pk);
        server.stop();
        // Cached now: no Hub needed; a cache that no longer matches the pin is ignored.
        assert_eq!(b64url_encode(&hub_key(&data).unwrap()), pk);
        save_hub_key(&data, &other).unwrap();
        assert!(hub_key(&data).is_err());
        // No pin at all: nothing can verify.
        std::fs::remove_file(data.path().join(crate::tls::TRUST_FILE)).unwrap();
        assert_eq!(reason(&hub_key(&data).unwrap_err()), (403, "authorization_invalid".into()));
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn bounds_the_replay_store() {
        let (base, data) = enrolled("authz-replay");
        let old: Vec<Used> = (0..MAX_REPLAY).map(|i| Used { change_id: format!("c{i}"), at_ms: NOW - 20 * 60_000 }).collect();
        write_json(&data.path().join(REPLAY_FILE), &ReplayFile { used: old }, true).unwrap();
        spend(&data, "fresh", NOW).unwrap();
        let f: ReplayFile = read_json_or(&data.path().join(REPLAY_FILE), ReplayFile::default()).unwrap();
        assert_eq!(f.used.len(), 1, "ids past every possible window are dropped first");
        let recent: Vec<Used> = (0..MAX_REPLAY).map(|i| Used { change_id: format!("r{i}"), at_ms: NOW - 1000 }).collect();
        write_json(&data.path().join(REPLAY_FILE), &ReplayFile { used: recent }, true).unwrap();
        assert_eq!(spend(&data, "one-more", NOW).unwrap_err().status, 429);
        // 24 h later they are forgotten.
        spend(&data, "r1", NOW + REPLAY_KEEP_MS + 1).unwrap();
        // A damaged store refuses everything rather than forgetting what was spent.
        std::fs::write(data.path().join(REPLAY_FILE), "{ not json").unwrap();
        let e = spend(&data, "r2", NOW).unwrap_err();
        assert_eq!((e.status, e.details.unwrap()["reason"].as_str()), (500, Some("replay_store_unreadable")));
        use std::os::unix::fs::PermissionsExt;
        std::fs::write(data.path().join(REPLAY_FILE), "{\"used\":[]}").unwrap();
        std::fs::set_permissions(data.path().join(REPLAY_FILE), std::fs::Permissions::from_mode(0o000)).unwrap();
        if !crate::hardening::is_root() {
            assert_eq!(spend(&data, "r3", NOW).unwrap_err().status, 500, "unreadable");
        }
        std::fs::set_permissions(data.path().join(REPLAY_FILE), std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(is_uuid_v7(&change_id()) && !is_uuid_v7("0192a3b4-c5d6-7e8f-1a0b-1c2d3e4f5a6b"));
        assert_eq!(time_ms(&json!("2026-10-14T17:46:40.5Z")), Some(1_792_000_000_500));
        assert_eq!(time_ms(&json!(5)), Some(5));
        assert_eq!(time_ms(&json!("yesterday")), None);
        std::fs::remove_dir_all(&base).unwrap();
    }
}
