//! Device file operations for Hub sessions (FR-210, docs/23 §4.1): list and read inside granted
//! folders, and two-phase writes. A write is staged (content kept in novad's staging area with the
//! SHA-256 of the current file and of the new content) and the diff returned; commit replaces the
//! file atomically only when it still has the staged base hash, otherwise it is a conflict and
//! nothing is written. Abandoned stages are discarded after 24 h. A write outside the granted
//! folders files a folder-access request and is refused until it is granted.

use crate::crypto::{Sha256, b64_decode, b64_encode, hex, sha256};
use crate::diff::unified_diff;
use crate::grants::{GrantStore, Grantee, Need, folder_for};
use crate::paths;
use crate::util::{OpError, OpResult, new_id, now_iso, now_ms, read_json_or, write_atomic, write_json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::io::Read;
use std::path::{Path, PathBuf};

pub const DEFAULT_READ_BYTES: u64 = 1024 * 1024;
pub const MAX_READ_BYTES: u64 = 8 * 1024 * 1024;
pub const MAX_STAGE_BYTES: usize = 10 * 1024 * 1024;
pub const STAGE_TTL_MS: u64 = 24 * 60 * 60 * 1000;
const MAX_LIST: usize = 5_000;
const MAX_DIFF_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedMeta {
    pub id: String,
    pub grantee: Grantee,
    pub path: String,
    pub base_sha256: Option<String>,
    pub new_sha256: String,
    pub size: u64,
    pub create_dirs: bool,
    #[serde(default)]
    pub session_ref: Option<String>,
    pub created_at: String,
    pub created_ms: u64,
}

pub struct Storage {
    pub dir: PathBuf,
    pub grants: GrantStore,
    pub data_dir: PathBuf,
}

impl Storage {
    /// Storage state under `<data>/storage`.
    pub fn new(data_dir: &Path) -> Self {
        let dir = data_dir.join("storage");
        Storage { grants: GrantStore::new(dir.join("grants.json"), data_dir.to_path_buf()), dir, data_dir: data_dir.to_path_buf() }
    }

    fn staged_dir(&self) -> PathBuf {
        self.dir.join("staged")
    }

    fn data_canonical(&self) -> PathBuf {
        std::fs::canonicalize(&self.data_dir).unwrap_or_else(|_| self.data_dir.clone())
    }

    pub fn list(&self, grantee: &Grantee, path: &str) -> OpResult<Value> {
        let r = self.grants.resolve(grantee, path, Need::Read)?;
        let meta = std::fs::metadata(&r.path)?;
        if !meta.is_dir() {
            return Err(OpError::validation("not a directory"));
        }
        let data = self.data_canonical();
        let mut entries = Vec::new();
        let mut truncated = false;
        for e in std::fs::read_dir(&r.path)?.flatten() {
            let child = r.path.join(e.file_name());
            // Protected entries (credential locations, novad's data) are not even listed.
            if paths::protected_reason(&child, Some(&data)).is_some() {
                continue;
            }
            if entries.len() >= MAX_LIST {
                truncated = true;
                break;
            }
            let md = std::fs::symlink_metadata(&child).ok();
            let kind = match &md {
                Some(m) if m.file_type().is_symlink() => "symlink",
                Some(m) if m.is_dir() => "dir",
                Some(m) if m.is_file() => "file",
                _ => "other",
            };
            let size = md.as_ref().filter(|m| m.is_file()).map(|m| m.len());
            entries.push(json!({ "name": e.file_name().to_string_lossy(), "kind": kind, "size": size }));
        }
        entries.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
        Ok(json!({ "path": r.path, "entries": entries, "truncated": truncated }))
    }

    pub fn stat(&self, grantee: &Grantee, path: &str) -> OpResult<Value> {
        let r = self.grants.resolve(grantee, path, Need::Read)?;
        let m = std::fs::metadata(&r.path)?;
        let kind = if m.is_dir() { "dir" } else if m.is_file() { "file" } else { "other" };
        let mtime = m
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        Ok(json!({ "path": r.path, "kind": kind, "size": m.len(), "mtimeMs": mtime }))
    }

    pub fn read(&self, grantee: &Grantee, path: &str, max_bytes: Option<u64>) -> OpResult<Value> {
        let r = self.grants.resolve(grantee, path, Need::Read)?;
        let max = max_bytes.unwrap_or(DEFAULT_READ_BYTES).clamp(1, MAX_READ_BYTES);
        let m = std::fs::metadata(&r.path)?;
        if !m.is_file() {
            return Err(OpError::validation("not a file"));
        }
        let mut f = std::fs::File::open(&r.path)?;
        let mut hasher = Sha256::new();
        let mut content = Vec::new();
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let n = f.read(&mut buf)?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
            let room = (max as usize).saturating_sub(content.len());
            content.extend_from_slice(&buf[..n.min(room)]);
        }
        let truncated = (content.len() as u64) < m.len();
        Ok(json!({
            "path": r.path,
            "contentBase64": b64_encode(&content),
            "size": m.len(),
            "sha256": hex(&hasher.finalize()),
            "truncated": truncated,
        }))
    }

    /// Stage a write. Outside the grants it files a folder-access request for the nearest existing
    /// folder and returns `policy_denied` with `reason: folder_access_required` and the request.
    pub fn stage(
        &self,
        grantee: &Grantee,
        path: &str,
        base_sha256: Option<&str>,
        content_b64: &str,
        create_dirs: bool,
        session_ref: Option<&str>,
    ) -> OpResult<Value> {
        let content = b64_decode(content_b64).ok_or_else(|| OpError::validation("contentBase64 is not valid base64"))?;
        if content.len() > MAX_STAGE_BYTES {
            return Err(OpError::validation(format!("a staged write is at most {MAX_STAGE_BYTES} bytes")));
        }
        let r = match self.grants.resolve(grantee, path, Need::Write) {
            Ok(r) => r,
            Err(e) => return Err(self.with_access_request(grantee, path, e)),
        };
        if r.path.is_dir() {
            return Err(OpError::validation("the target is a directory"));
        }
        let parent = r.path.parent().ok_or_else(|| OpError::validation("the target has no parent folder"))?;
        if !parent.is_dir() && !create_dirs {
            return Err(OpError::not_found("the parent folder does not exist (set createDirs)"));
        }
        let old = match std::fs::read(&r.path) {
            Ok(b) => Some(b),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(e.into()),
        };
        let current = old.as_deref().map(|b| hex(&sha256(b)));
        if let Some(base) = base_sha256 {
            if current.as_deref() != Some(base) {
                return Err(OpError::conflict("the file changed since it was read").with(json!({
                    "reason": "base_mismatch", "currentSha256": current
                })));
            }
        }
        self.sweep();
        let id = new_id();
        let new_sha = hex(&sha256(&content));
        let label = r.path.to_string_lossy().to_string();
        let (diff, additions, deletions, binary, truncated) = match (old.as_deref().map(std::str::from_utf8), std::str::from_utf8(&content)) {
            (Some(Ok(o)), Ok(n)) if !o.contains('\0') && !n.contains('\0') => {
                let d = unified_diff(o, n, &format!("a{label}"), &format!("b{label}"), 3, MAX_DIFF_BYTES);
                (d.unified, d.additions, d.deletions, false, d.truncated)
            }
            (None, Ok(n)) if !n.contains('\0') => {
                let d = unified_diff("", n, "/dev/null", &format!("b{label}"), 3, MAX_DIFF_BYTES);
                (d.unified, d.additions, d.deletions, false, d.truncated)
            }
            _ => (
                format!(
                    "Binary file {label} {} ({} -> {} bytes)\n",
                    if old.is_some() { "changed" } else { "added" },
                    old.as_ref().map_or(0, Vec::len),
                    content.len()
                ),
                0,
                0,
                true,
                false,
            ),
        };
        let meta = StagedMeta {
            id: id.clone(),
            grantee: grantee.clone(),
            path: label.clone(),
            base_sha256: current.clone(),
            new_sha256: new_sha.clone(),
            size: content.len() as u64,
            create_dirs,
            session_ref: session_ref.map(str::to_string),
            created_at: now_iso(),
            created_ms: now_ms(),
        };
        let dir = self.staged_dir();
        write_atomic(&dir.join(format!("{id}.data")), &content, true)?;
        write_json(&dir.join(format!("{id}.json")), &meta, true)?;
        Ok(json!({
            "staged": {
                "id": id,
                "path": label,
                "baseSha256": current,
                "newSha256": new_sha,
                "size": content.len(),
                "diff": diff,
                "additions": additions,
                "deletions": deletions,
                "binary": binary,
                "diffTruncated": truncated,
                "createdAt": meta.created_at,
            }
        }))
    }

    /// Attach a folder-access request to a `folder_access_required` refusal.
    fn with_access_request(&self, grantee: &Grantee, path: &str, e: OpError) -> OpError {
        let reason = e.details.as_ref().and_then(|d| d["reason"].as_str()).unwrap_or_default().to_string();
        if reason != "folder_access_required" {
            return e;
        }
        let access = e.details.as_ref().and_then(|d| d["access"].as_str()).unwrap_or("write").to_string();
        let Some(folder) = paths::canonical(path).and_then(|p| folder_for(&p)) else { return e };
        match self.grants.request(grantee, "folder", &folder.to_string_lossy(), &access, Some("a write outside the granted folders".into())) {
            Ok(req) => {
                let mut d = e.details.clone().unwrap_or_else(|| json!({}));
                d["request"] = serde_json::to_value(&req).unwrap_or(Value::Null);
                OpError { details: Some(d), ..e }
            }
            Err(_) => e,
        }
    }

    fn load_stage(&self, grantee: &Grantee, id: &str) -> OpResult<StagedMeta> {
        if id.is_empty() || !id.chars().all(|c| c.is_ascii_hexdigit()) || id.len() > 64 {
            return Err(OpError::validation("invalid staged write id"));
        }
        let p = self.staged_dir().join(format!("{id}.json"));
        if !p.exists() {
            return Err(OpError::not_found("no such staged write (committed, discarded or expired)"));
        }
        let meta: StagedMeta = read_json_or(&p, None)
            .map_err(|e| OpError::internal(e.to_string()))?
            .ok_or_else(|| OpError::not_found("no such staged write"))?;
        // A stage belongs to the grantee that made it.
        if &meta.grantee != grantee {
            return Err(OpError::not_found("no such staged write"));
        }
        Ok(meta)
    }

    fn remove_stage(&self, id: &str) {
        let dir = self.staged_dir();
        let _ = std::fs::remove_file(dir.join(format!("{id}.data")));
        let _ = std::fs::remove_file(dir.join(format!("{id}.json")));
    }

    /// Commit a staged write: the grant is checked again, the staged content must still match its
    /// hash, and the target must still have the base hash; then an atomic replace.
    pub fn commit(&self, grantee: &Grantee, id: &str) -> OpResult<Value> {
        let meta = self.load_stage(grantee, id)?;
        let r = self.grants.resolve(grantee, &meta.path, Need::Write)?;
        let content = std::fs::read(self.staged_dir().join(format!("{id}.data")))?;
        if hex(&sha256(&content)) != meta.new_sha256 {
            self.remove_stage(id);
            return Err(OpError::conflict("the staged content was altered").with(json!({ "reason": "staged_tampered" })));
        }
        let current = match std::fs::read(&r.path) {
            Ok(b) => Some(hex(&sha256(&b))),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(e.into()),
        };
        if current != meta.base_sha256 {
            self.remove_stage(id);
            return Err(OpError::conflict("the file changed since the write was staged; nothing was written").with(json!({
                "reason": "base_mismatch", "baseSha256": meta.base_sha256, "currentSha256": current
            })));
        }
        if let Some(parent) = r.path.parent() {
            if !parent.is_dir() {
                if !meta.create_dirs {
                    return Err(OpError::not_found("the parent folder no longer exists"));
                }
                std::fs::create_dir_all(parent)?;
            }
        }
        let mode = std::fs::metadata(&r.path).ok().map(|m| m.permissions());
        write_atomic(&r.path, &content, false)?;
        if let Some(perm) = mode {
            let _ = std::fs::set_permissions(&r.path, perm);
        }
        self.remove_stage(id);
        Ok(json!({ "path": r.path, "sha256": meta.new_sha256, "size": content.len(), "committedAt": now_iso() }))
    }

    pub fn discard(&self, grantee: &Grantee, id: &str) -> OpResult<Value> {
        self.load_stage(grantee, id)?;
        self.remove_stage(id);
        Ok(json!({ "ok": true }))
    }

    /// Discard stages older than the TTL; returns how many went.
    pub fn sweep(&self) -> usize {
        self.sweep_at(now_ms())
    }

    pub fn sweep_at(&self, now: u64) -> usize {
        let Ok(entries) = std::fs::read_dir(self.staged_dir()) else { return 0 };
        let mut n = 0;
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) != Some("json") {
                continue;
            }
            let meta: Option<StagedMeta> = read_json_or(&p, None).ok().flatten();
            let expired = meta.as_ref().is_none_or(|m| now.saturating_sub(m.created_ms) > STAGE_TTL_MS);
            if expired {
                if let Some(stem) = p.file_stem().and_then(|s| s.to_str()) {
                    self.remove_stage(stem);
                    n += 1;
                }
            }
        }
        n
    }

    /// Delete a file or an empty folder inside a write grant; never a grant root or an ancestor of
    /// a protected location.
    pub fn delete(&self, grantee: &Grantee, path: &str) -> OpResult<Value> {
        let r = self.grants.resolve(grantee, path, Need::Write)?;
        let roots: Vec<PathBuf> = self.grants.roots(grantee)?.into_iter().map(|(p, _)| p).collect();
        if paths::is_protected_ancestor(&r.path, Some(&self.data_canonical()), &roots) {
            return Err(OpError::denied("protected_path", "this folder holds a protected location or is a granted root"));
        }
        let m = std::fs::symlink_metadata(&r.path)?;
        if m.is_dir() {
            std::fs::remove_dir(&r.path).map_err(|e| {
                if e.kind() == std::io::ErrorKind::DirectoryNotEmpty {
                    OpError::validation("the folder is not empty").with(json!({ "reason": "directory_not_empty" }))
                } else {
                    e.into()
                }
            })?;
        } else {
            std::fs::remove_file(&r.path)?;
        }
        Ok(json!({ "ok": true }))
    }

    pub fn move_path(&self, grantee: &Grantee, from: &str, to: &str) -> OpResult<Value> {
        let a = self.grants.resolve(grantee, from, Need::Write)?;
        let b = self.grants.resolve(grantee, to, Need::Write)?;
        let roots: Vec<PathBuf> = self.grants.roots(grantee)?.into_iter().map(|(p, _)| p).collect();
        if paths::is_protected_ancestor(&a.path, Some(&self.data_canonical()), &roots) {
            return Err(OpError::denied("protected_path", "this folder holds a protected location or is a granted root"));
        }
        if std::fs::symlink_metadata(&b.path).is_ok() {
            return Err(OpError::conflict("the destination exists"));
        }
        std::fs::rename(&a.path, &b.path)?;
        Ok(json!({ "ok": true, "path": b.path }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::grants::tests::tmp;

    fn setup() -> (PathBuf, Storage, Grantee, PathBuf) {
        let base = tmp("fsops");
        let data = base.join("data");
        std::fs::create_dir_all(&data).unwrap();
        let proj = base.join("proj");
        std::fs::create_dir_all(proj.join("src")).unwrap();
        std::fs::write(proj.join("src/a.txt"), "one\ntwo\nthree\n").unwrap();
        let s = Storage::new(&data);
        let g = Grantee { kind: "agent".into(), id: "a1".into() };
        s.grants.grant(&g, "folder", proj.to_str().unwrap(), "write", "device").unwrap();
        (base, s, g, proj)
    }

    #[test]
    fn lists_reads_and_stats_inside_grants() {
        let (base, s, g, proj) = setup();
        std::fs::create_dir_all(proj.join(".ssh")).unwrap();
        let l = s.list(&g, proj.to_str().unwrap()).unwrap();
        let names: Vec<&str> = l["entries"].as_array().unwrap().iter().map(|e| e["name"].as_str().unwrap()).collect();
        assert_eq!(names, vec!["src"], ".ssh is never listed");
        let r = s.read(&g, proj.join("src/a.txt").to_str().unwrap(), Some(3)).unwrap();
        assert_eq!(b64_decode(r["contentBase64"].as_str().unwrap()).unwrap(), b"one");
        assert_eq!(r["truncated"], true);
        assert_eq!(r["sha256"], hex(&sha256(b"one\ntwo\nthree\n")));
        assert_eq!(s.stat(&g, proj.join("src").to_str().unwrap()).unwrap()["kind"], "dir");
        assert_eq!(s.list(&g, "/etc").unwrap_err().details.unwrap()["reason"], "folder_access_required");
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn stages_diffs_and_commits_atomically() {
        let (base, s, g, proj) = setup();
        let target = proj.join("src/a.txt");
        let st = s.stage(&g, target.to_str().unwrap(), None, &b64_encode(b"one\n2\nthree\n"), false, Some("thread:t1")).unwrap();
        let staged = &st["staged"];
        assert_eq!(staged["additions"], 1);
        assert_eq!(staged["deletions"], 1);
        assert!(staged["diff"].as_str().unwrap().contains("-two\n+2\n"));
        // Nothing is written until commit.
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "one\ntwo\nthree\n");
        let id = staged["id"].as_str().unwrap();
        // Another grantee cannot commit it.
        let other = Grantee { kind: "session".into(), id: "s".into() };
        assert_eq!(s.commit(&other, id).unwrap_err().code, "not_found");
        let c = s.commit(&g, id).unwrap();
        assert_eq!(c["sha256"], hex(&sha256(b"one\n2\nthree\n")));
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "one\n2\nthree\n");
        assert_eq!(s.commit(&g, id).unwrap_err().code, "not_found", "a stage commits once");
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn a_changed_target_is_a_conflict_and_nothing_is_written() {
        let (base, s, g, proj) = setup();
        let target = proj.join("src/a.txt");
        let st = s.stage(&g, target.to_str().unwrap(), None, &b64_encode(b"mine\n"), false, None).unwrap();
        std::fs::write(&target, "theirs\n").unwrap();
        let e = s.commit(&g, st["staged"]["id"].as_str().unwrap()).unwrap_err();
        assert_eq!(e.code, "conflict");
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "theirs\n");
        // A stale base hash is refused at staging time too.
        let e = s.stage(&g, target.to_str().unwrap(), Some("00"), &b64_encode(b"x"), false, None).unwrap_err();
        assert_eq!(e.details.unwrap()["reason"], "base_mismatch");
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn new_files_discard_and_sweep() {
        let (base, s, g, proj) = setup();
        let st = s.stage(&g, proj.join("new/b.txt").to_str().unwrap(), None, &b64_encode(b"hi\n"), true, None).unwrap();
        assert_eq!(st["staged"]["baseSha256"], Value::Null);
        assert!(st["staged"]["diff"].as_str().unwrap().contains("+hi"));
        s.commit(&g, st["staged"]["id"].as_str().unwrap()).unwrap();
        assert_eq!(std::fs::read_to_string(proj.join("new/b.txt")).unwrap(), "hi\n");
        // Missing parent without createDirs.
        assert_eq!(s.stage(&g, proj.join("x/y.txt").to_str().unwrap(), None, &b64_encode(b"1"), false, None).unwrap_err().code, "not_found");
        let d = s.stage(&g, proj.join("c.bin").to_str().unwrap(), None, &b64_encode(&[0, 1, 2]), false, None).unwrap();
        assert_eq!(d["staged"]["binary"], true);
        let id = d["staged"]["id"].as_str().unwrap().to_string();
        s.discard(&g, &id).unwrap();
        assert!(!proj.join("c.bin").exists());
        let old = s.stage(&g, proj.join("d.txt").to_str().unwrap(), None, &b64_encode(b"1"), false, None).unwrap();
        assert_eq!(s.sweep_at(now_ms() + STAGE_TTL_MS + 1), 1);
        assert_eq!(s.commit(&g, old["staged"]["id"].as_str().unwrap()).unwrap_err().code, "not_found");
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn a_write_outside_the_grants_files_a_folder_request() {
        let (base, s, g, _proj) = setup();
        let outside = base.join("other");
        std::fs::create_dir_all(&outside).unwrap();
        let e = s.stage(&g, outside.join("f.txt").to_str().unwrap(), None, &b64_encode(b"x"), false, None).unwrap_err();
        let d = e.details.unwrap();
        assert_eq!(d["reason"], "folder_access_required");
        assert_eq!(d["request"]["status"], "pending");
        assert_eq!(d["request"]["target"], outside.to_str().unwrap());
        assert_eq!(d["request"]["access"], "write");
        let id = d["request"]["id"].as_str().unwrap();
        s.grants.decide(id, true, "hub").unwrap();
        assert!(s.stage(&g, outside.join("f.txt").to_str().unwrap(), None, &b64_encode(b"x"), false, None).is_ok());
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn protected_paths_are_never_staged_and_roots_are_not_deleted() {
        let (base, s, g, proj) = setup();
        std::fs::create_dir_all(proj.join(".git")).unwrap();
        let e = s.stage(&g, proj.join(".git/config").to_str().unwrap(), None, &b64_encode(b"x"), false, None).unwrap_err();
        assert_eq!(e.details.unwrap()["reason"], "protected_path");
        let e = s.stage(&g, proj.join(".ssh/authorized_keys").to_str().unwrap(), None, &b64_encode(b"x"), true, None).unwrap_err();
        assert_eq!(e.code, "policy_denied");
        assert_eq!(s.delete(&g, proj.to_str().unwrap()).unwrap_err().code, "policy_denied");
        assert_eq!(s.delete(&g, proj.join("src").to_str().unwrap()).unwrap_err().details.unwrap()["reason"], "directory_not_empty");
        s.delete(&g, proj.join("src/a.txt").to_str().unwrap()).unwrap();
        assert!(!proj.join("src/a.txt").exists());
        s.move_path(&g, proj.join("src").to_str().unwrap(), proj.join("lib").to_str().unwrap()).unwrap();
        assert!(proj.join("lib").is_dir());
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn symlinks_cannot_leave_a_grant() {
        let (base, s, g, proj) = setup();
        let outside = base.join("secret");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("s.txt"), "s").unwrap();
        std::os::unix::fs::symlink(&outside, proj.join("link")).unwrap();
        let e = s.read(&g, proj.join("link/s.txt").to_str().unwrap(), None).unwrap_err();
        assert_eq!(e.details.unwrap()["reason"], "folder_access_required");
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn credential_locations_are_refused_at_any_depth_inside_a_grant() {
        let (base, s, g, proj) = setup();
        for d in ["a/b/.ssh", "a/.Aws", "a/b/.cargo", "a/.config/gh"] {
            std::fs::create_dir_all(proj.join(d)).unwrap();
        }
        for f in ["a/b/.ssh/id_x", "a/.Aws/credentials", "a/b/.cargo/credentials.toml", "a/.config/gh/hosts.yml"] {
            std::fs::write(proj.join(f), "SECRET").unwrap();
        }
        std::fs::write(proj.join("a/b/.cargo/config.toml"), "ok").unwrap();
        std::os::unix::fs::symlink(proj.join("a/b/.ssh"), proj.join("a/keys")).unwrap();
        let p = |rel: &str| proj.join(rel).to_string_lossy().to_string();
        let denied = |r: OpResult<Value>, what: &str| {
            let e = r.expect_err(what);
            let details = e.details.clone().unwrap_or_default();
            assert_eq!((e.code.as_str(), details["reason"].as_str()), ("policy_denied", Some("protected_path")), "{what}");
        };
        // Case variants, trailing dots, `credentials*` prefixes and links into a credential folder.
        for f in ["a/b/.ssh/id_x", "a/.Aws/credentials", "a/b/.cargo/credentials.toml", "a/.config/gh/hosts.yml", "a/b/.SSH./id_x", "a/keys/id_x"] {
            denied(s.read(&g, &p(f), None), &format!("read {f}"));
            denied(s.stat(&g, &p(f)), &format!("stat {f}"));
            denied(s.stage(&g, &p(f), None, &b64_encode(b"x"), true, None), &format!("stage {f}"));
            denied(s.delete(&g, &p(f)), &format!("delete {f}"));
            denied(s.move_path(&g, &p(f), &p("a/stolen.txt")), &format!("move from {f}"));
        }
        for d in ["a/b/.ssh", "a/.aws", "a/.config/gh", "a/keys"] {
            denied(s.list(&g, &p(d)), &format!("list {d}"));
            denied(s.move_path(&g, &p("src/a.txt"), &p(&format!("{d}/planted"))), &format!("move into {d}"));
        }
        // A folder holding a credential location cannot be deleted or moved away.
        denied(s.delete(&g, &p("a/b/.ssh")), "delete .ssh");
        denied(s.move_path(&g, &p("a/b"), &p("moved")), "move the parent of .ssh");
        // Listings leave credential locations out; neighbours stay reachable.
        let names = |dir: &str| -> Vec<String> {
            s.list(&g, &p(dir)).unwrap()["entries"].as_array().unwrap().iter().map(|e| e["name"].as_str().unwrap().to_string()).collect()
        };
        assert_eq!(names("a/b"), vec![".cargo"]);
        assert_eq!(names("a/b/.cargo"), vec!["config.toml"]);
        assert_eq!(names("a/.config"), Vec::<String>::new());
        assert!(s.read(&g, &p("a/b/.cargo/config.toml"), None).is_ok());
        // A staged write whose folder became a link into a credential location is refused at commit.
        let st = s.stage(&g, &p("src/k.txt"), None, &b64_encode(b"planted"), false, None).unwrap();
        std::fs::rename(proj.join("src"), proj.join("src-old")).unwrap();
        std::os::unix::fs::symlink(proj.join("a/b/.ssh"), proj.join("src")).unwrap();
        denied(s.commit(&g, st["staged"]["id"].as_str().unwrap()), "commit through a link");
        assert!(!proj.join("a/b/.ssh/k.txt").exists());
        std::fs::remove_dir_all(&base).unwrap();
    }
}
