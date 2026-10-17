//! Signed updates (FR-148, docs/23 §8). A bundle is a manifest (target, version, channel, payload
//! SHA-256 and size), an Ed25519 signature over the manifest's canonical JSON by the pinned trust
//! key, and the payload. Flow: verify -> stage -> swap -> health check -> commit, or roll back to
//! the previous version when the health check fails. Modules update one at a time while the
//! supervisor keeps running; the supervisor updates itself last: the new binary replaces the old
//! one with the old kept as a fallback, and a watchdog restores the fallback when the new binary
//! does not come up healthy within a few starts.

use crate::capabilities::canonical_json;
use crate::crypto::{b64_decode, b64url_decode, hex, sha256, verify};
use crate::state::{CHANNELS, DataDir};
use crate::supervisor::{ModuleSpec, PreviousVersion, Supervisor};
use crate::util::{OpError, OpResult, now_iso, read_json_or, version_cmp, write_atomic, write_json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::cmp::Ordering;
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const MAX_PAYLOAD: usize = 64 * 1024 * 1024;
/// Starts a new supervisor binary gets before the watchdog restores the previous one.
pub const MAX_SELF_ATTEMPTS: u32 = 3;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BundleManifest {
    /// A module name, or `novad` for the supervisor itself.
    pub target: String,
    pub version: String,
    pub channel: String,
    pub sha256: String,
    pub size: u64,
}

fn rank(channel: &str) -> Option<usize> {
    CHANNELS.iter().position(|c| *c == channel)
}

/// Check a bundle against the pinned key, the device's channel and the installed version.
/// Returns the manifest and the payload.
pub fn verify_bundle(bundle: &Value, trust_key: Option<&str>, device_channel: &str, current: Option<&str>) -> OpResult<(BundleManifest, Vec<u8>)> {
    let key = trust_key.ok_or_else(|| OpError::denied("no_trust_key", "this device has no pinned update key"))?;
    let key: [u8; 32] = b64url_decode(key).and_then(|k| k.try_into().ok()).ok_or_else(|| OpError::internal("the pinned update key is damaged"))?;
    let manifest_v = bundle.get("manifest").filter(|m| m.is_object()).ok_or_else(|| OpError::validation("bundle.manifest is required"))?;
    let sig: [u8; 64] = bundle["signature"]
        .as_str()
        .and_then(b64url_decode)
        .and_then(|s| s.try_into().ok())
        .ok_or_else(|| OpError::validation("bundle.signature must be a base64url Ed25519 signature"))?;
    if !verify(&key, canonical_json(manifest_v).as_bytes(), &sig) {
        return Err(OpError::denied("bad_signature", "the update bundle is not signed by the pinned key"));
    }
    let m: BundleManifest = serde_json::from_value(manifest_v.clone()).map_err(|e| OpError::validation(format!("bundle.manifest: {e}")))?;
    if m.target != "novad" && !crate::supervisor::MODULES.contains(&m.target.as_str()) {
        return Err(OpError::validation(format!("unknown update target {}", m.target)));
    }
    let (Some(want), Some(have)) = (rank(&m.channel), rank(device_channel)) else {
        return Err(OpError::validation("unknown update channel"));
    };
    // A device takes its own channel and the more stable ones: nightly takes everything.
    if want > have {
        return Err(OpError::denied("channel_mismatch", format!("this device follows the {device_channel} channel")));
    }
    if let Some(cur) = current {
        if version_cmp(&m.version, cur) != Ordering::Greater {
            return Err(OpError::conflict(format!("{} {} is not newer than the installed {cur}", m.target, m.version)).with(json!({ "reason": "not_newer" })));
        }
    }
    let payload = bundle["payload"].as_str().and_then(b64_decode).ok_or_else(|| OpError::validation("bundle.payload must be base64"))?;
    if payload.len() > MAX_PAYLOAD || payload.len() as u64 != m.size || hex(&sha256(&payload)) != m.sha256 {
        return Err(OpError::denied("checksum_mismatch", "the payload does not match the signed manifest"));
    }
    Ok((m, payload))
}

fn stage_file(dir: &Path, name: &str, payload: &[u8]) -> OpResult<PathBuf> {
    let path = dir.join(name);
    write_atomic(&path, payload, false)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))?;
    }
    Ok(path)
}

/// Update one module: stage, swap, restart, health check; roll back on failure.
pub fn apply_module(sup: &Supervisor, data: &DataDir, m: &BundleManifest, payload: &[u8], health: Duration, settle: Duration) -> OpResult<Value> {
    let old = sup.spec(&m.target);
    let staged = stage_file(&data.path().join("modules").join(&m.target).join(&m.version), &m.target, payload)?;
    let mut new = ModuleSpec {
        name: m.target.clone(),
        version: m.version.clone(),
        exec: Some(vec![staged.to_string_lossy().to_string(), "module".into(), m.target.clone(), "--data-dir".into(), data.path().to_string_lossy().to_string()]),
        sha256: Some(m.sha256.clone()),
        autostart: true,
        limits: old.as_ref().map(|o| o.limits).unwrap_or_default(),
        previous: old.as_ref().map(|o| PreviousVersion { version: o.version.clone(), exec: o.exec.clone(), sha256: o.sha256.clone() }),
    };
    let from = old.as_ref().map(|o| o.version.clone());
    sup.replace_spec(new.clone());
    let started = sup.restart(&m.target);
    if started.is_ok() && sup.wait_healthy(&m.target, health, settle) {
        return Ok(json!({ "status": "applied", "target": m.target, "from": from, "to": m.version, "at": now_iso() }));
    }
    // Roll back to what ran before (or stop a module the update tried to install).
    match old {
        Some(o) => {
            sup.replace_spec(ModuleSpec { autostart: true, ..o });
            let _ = sup.restart(&m.target);
        }
        None => {
            let _ = sup.stop(&m.target);
            new.autostart = false;
            sup.replace_spec(new);
        }
    }
    let _ = std::fs::remove_dir_all(data.path().join("modules").join(&m.target).join(&m.version));
    Ok(json!({ "status": "rolled_back", "reason": "health_check_failed", "target": m.target, "from": from, "to": m.version, "at": now_iso() }))
}

/// Go back to the version an update replaced.
pub fn rollback_module(sup: &Supervisor, name: &str) -> OpResult<Value> {
    let cur = sup.spec(name).ok_or_else(|| OpError::not_found(format!("the {name} module is not installed")))?;
    let prev = cur.previous.clone().ok_or_else(|| OpError::conflict("there is no previous version to roll back to"))?;
    sup.replace_spec(ModuleSpec { version: prev.version.clone(), exec: prev.exec, sha256: prev.sha256, previous: None, ..cur.clone() });
    sup.restart(name)?;
    Ok(json!({ "status": "rolled_back", "target": name, "from": cur.version, "to": prev.version, "at": now_iso() }))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SelfPending {
    pub from: String,
    pub to: String,
    pub exe: PathBuf,
    pub fallback: PathBuf,
    pub attempts: u32,
    pub staged_at: String,
}

fn pending_path(data: &DataDir) -> PathBuf {
    data.path().join("update-pending.json")
}

/// Stage a new supervisor binary over `exe`, keeping the current one as the fallback. The caller
/// restarts novad (the service manager starts the new binary).
pub fn stage_self(data: &DataDir, exe: &Path, m: &BundleManifest, payload: &[u8]) -> OpResult<Value> {
    let bin = data.path().join("bin");
    let fallback = bin.join("novad-previous");
    std::fs::create_dir_all(&bin)?;
    std::fs::copy(exe, &fallback)?;
    let dir = exe.parent().ok_or_else(|| OpError::internal("the novad binary has no folder"))?;
    let name = exe.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "novad".into());
    // Same folder, then rename: the swap is atomic.
    let tmp = stage_file(dir, &format!(".{name}.new"), payload).map_err(|e| OpError::denied("elevation_required", format!("cannot write the novad binary: {e}")))?;
    std::fs::rename(&tmp, exe)?;
    let p = SelfPending { from: env!("CARGO_PKG_VERSION").into(), to: m.version.clone(), exe: exe.to_path_buf(), fallback, attempts: 0, staged_at: now_iso() };
    write_json(&pending_path(data), &p, false)?;
    Ok(json!({ "status": "staged", "target": "novad", "from": p.from, "to": p.to, "restart": true }))
}

/// At start: count an attempt of a pending self-update, and restore the fallback binary after too
/// many starts without a healthy check-in. Returns what happened, if anything.
pub fn watchdog_on_start(data: &DataDir) -> OpResult<Option<Value>> {
    let path = pending_path(data);
    let Some(mut p) = read_json_or::<Option<SelfPending>>(&path, None).map_err(|e| OpError::internal(e.to_string()))? else {
        return Ok(None);
    };
    p.attempts += 1;
    if p.attempts > MAX_SELF_ATTEMPTS {
        let dir = p.exe.parent().ok_or_else(|| OpError::internal("the novad binary has no folder"))?;
        let tmp = dir.join(".novad.restore");
        std::fs::copy(&p.fallback, &tmp)?;
        std::fs::rename(&tmp, &p.exe)?;
        let _ = std::fs::remove_file(&path);
        return Ok(Some(json!({ "status": "rolled_back", "target": "novad", "from": p.to, "to": p.from, "reason": "health_check_failed" })));
    }
    write_json(&path, &p, false)?;
    Ok(Some(json!({ "status": "pending", "target": "novad", "to": p.to, "attempts": p.attempts })))
}

/// The new supervisor checked in with the Hub: the update is committed.
pub fn commit_self(data: &DataDir) -> Option<Value> {
    let path = pending_path(data);
    let p: SelfPending = read_json_or::<Option<SelfPending>>(&path, None).ok().flatten()?;
    let _ = std::fs::remove_file(&path);
    Some(json!({ "status": "applied", "target": "novad", "from": p.from, "to": p.to, "at": now_iso() }))
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::crypto::{SigningKey, b64_encode, b64url_encode};
    use crate::grants::tests::tmp;
    use crate::supervisor::tests::{PONG, opts};
    use crate::supervisor::{Manifest, ModuleSpec};

    pub fn bundle(key: &SigningKey, target: &str, version: &str, channel: &str, payload: &[u8]) -> Value {
        let manifest = json!({ "target": target, "version": version, "channel": channel, "sha256": hex(&sha256(payload)), "size": payload.len() });
        let sig = b64url_encode(&key.sign(canonical_json(&manifest).as_bytes()));
        json!({ "manifest": manifest, "signature": sig, "payload": b64_encode(payload) })
    }

    fn key() -> (SigningKey, String) {
        let k = SigningKey::from_seed(&[3u8; 32]);
        let pubk = b64url_encode(&k.public_key());
        (k, pubk)
    }

    #[test]
    fn verifies_signature_channel_version_and_checksum() {
        let (k, pubk) = key();
        let b = bundle(&k, "storage", "0.7.0", "stable", b"bin");
        assert!(verify_bundle(&b, Some(&pubk), "stable", Some("0.6.0")).is_ok());
        assert_eq!(verify_bundle(&b, None, "stable", None).unwrap_err().details.unwrap()["reason"], "no_trust_key");
        let other = b64url_encode(&SigningKey::from_seed(&[4u8; 32]).public_key());
        assert_eq!(verify_bundle(&b, Some(&other), "stable", None).unwrap_err().details.unwrap()["reason"], "bad_signature");
        let mut tampered = b.clone();
        tampered["manifest"]["version"] = json!("9.9.9");
        assert_eq!(verify_bundle(&tampered, Some(&pubk), "stable", None).unwrap_err().details.unwrap()["reason"], "bad_signature");
        let mut swapped = b.clone();
        swapped["payload"] = json!(b64_encode(b"evil"));
        assert_eq!(verify_bundle(&swapped, Some(&pubk), "stable", None).unwrap_err().details.unwrap()["reason"], "checksum_mismatch");
        assert_eq!(verify_bundle(&b, Some(&pubk), "stable", Some("0.7.0")).unwrap_err().code, "conflict");
        let nightly = bundle(&k, "storage", "0.8.0", "nightly", b"bin");
        assert_eq!(verify_bundle(&nightly, Some(&pubk), "stable", None).unwrap_err().details.unwrap()["reason"], "channel_mismatch");
        assert!(verify_bundle(&b, Some(&pubk), "nightly", None).is_ok(), "nightly devices take stable bundles");
        assert!(verify_bundle(&bundle(&k, "kernel", "1.0.0", "stable", b"x"), Some(&pubk), "stable", None).is_err());
    }

    #[test]
    fn applies_a_healthy_module_update_and_rolls_back_a_broken_one() {
        let dir = tmp("update");
        let data = DataDir(dir.clone());
        let old = ModuleSpec { exec: Some(vec!["/bin/sh".into(), "-c".into(), PONG.into()]), version: "0.6.0".into(), ..ModuleSpec::builtin("storage", true) };
        let sup = Supervisor::new(opts(&dir), Manifest { modules: vec![old] });
        sup.start_all();
        let (k, pubk) = key();
        // A good module: a script that answers pings.
        let good = format!("#!/bin/sh\n{PONG}\n");
        let (m, payload) = verify_bundle(&bundle(&k, "storage", "0.7.0", "stable", good.as_bytes()), Some(&pubk), "stable", Some("0.6.0")).unwrap();
        let r = apply_module(&sup, &data, &m, &payload, Duration::from_secs(3), Duration::from_millis(100)).unwrap();
        assert_eq!(r["status"], "applied");
        let st = sup.status("storage").unwrap();
        assert_eq!((st["version"].as_str(), st["state"].as_str(), st["previousVersion"].as_str()), (Some("0.7.0"), Some("running"), Some("0.6.0")));
        // A broken module: exits at once. The health check fails and 0.7.0 comes back.
        let bad = b"#!/bin/sh\nexit 1\n";
        let (m2, p2) = verify_bundle(&bundle(&k, "storage", "0.8.0", "stable", bad), Some(&pubk), "stable", Some("0.7.0")).unwrap();
        let r2 = apply_module(&sup, &data, &m2, &p2, Duration::from_millis(600), Duration::from_millis(100)).unwrap();
        assert_eq!(r2["status"], "rolled_back");
        let st = sup.status("storage").unwrap();
        assert_eq!(st["version"], "0.7.0");
        assert!(sup.wait_healthy("storage", Duration::from_secs(3), Duration::from_millis(50)));
        // Manual rollback to the version before.
        let rb = rollback_module(&sup, "storage").unwrap();
        assert_eq!(rb["to"], "0.6.0");
        assert_eq!(rollback_module(&sup, "storage").unwrap_err().code, "conflict");
        sup.stop_all();
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn self_update_stages_with_a_fallback_and_the_watchdog_restores_it() {
        let dir = tmp("selfupdate");
        let data = DataDir(dir.join("data"));
        data.ensure().unwrap();
        let exe = dir.join("bin/novad");
        std::fs::create_dir_all(exe.parent().unwrap()).unwrap();
        std::fs::write(&exe, b"old binary").unwrap();
        let m = BundleManifest { target: "novad".into(), version: "9.0.0".into(), channel: "stable".into(), sha256: hex(&sha256(b"new binary")), size: 10 };
        let r = stage_self(&data, &exe, &m, b"new binary").unwrap();
        assert_eq!(r["status"], "staged");
        assert_eq!(std::fs::read(&exe).unwrap(), b"new binary");
        // Starts without a healthy check-in count up; past the limit the old binary returns.
        for i in 1..=MAX_SELF_ATTEMPTS {
            assert_eq!(watchdog_on_start(&data).unwrap().unwrap()["attempts"], i);
        }
        let w = watchdog_on_start(&data).unwrap().unwrap();
        assert_eq!(w["status"], "rolled_back");
        assert_eq!(std::fs::read(&exe).unwrap(), b"old binary");
        assert!(watchdog_on_start(&data).unwrap().is_none());
        // A healthy start commits instead.
        stage_self(&data, &exe, &m, b"new binary").unwrap();
        watchdog_on_start(&data).unwrap();
        assert_eq!(commit_self(&data).unwrap()["status"], "applied");
        assert!(commit_self(&data).is_none());
        assert_eq!(std::fs::read(&exe).unwrap(), b"new binary");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
