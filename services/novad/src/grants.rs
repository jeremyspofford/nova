//! Folder and MCP grants per grantee (FR-210, docs/23 §4.1). A Hub session, run, agent or the
//! signed-in user reaches a device's files only inside folders granted to it. A request for a new
//! folder is approved on the device (`novad access approve`) or on the Hub (the Hub forwards the
//! decision); device-side decisions are reported to the Hub with the next heartbeat.

use crate::paths;
use crate::util::{OpError, OpResult, new_id, now_iso, read_json_or, write_json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

pub const GRANTEE_KINDS: &[&str] = &["user", "agent", "session", "run", "thread"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Grantee {
    pub kind: String,
    pub id: String,
}

impl Grantee {
    pub fn parse(v: &Value) -> OpResult<Self> {
        let kind = v["kind"].as_str().unwrap_or_default();
        let id = v["id"].as_str().unwrap_or_default();
        if !GRANTEE_KINDS.contains(&kind) {
            return Err(OpError::validation(format!("grantee.kind must be one of {}", GRANTEE_KINDS.join(", "))));
        }
        if id.is_empty() || id.len() > 200 || id.chars().any(char::is_control) {
            return Err(OpError::validation("grantee.id must be 1-200 printable characters"));
        }
        Ok(Grantee { kind: kind.into(), id: id.into() })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Grant {
    pub id: String,
    pub grantee: Grantee,
    /// `folder` or `mcp`.
    pub kind: String,
    /// A canonical folder path, or an MCP server name.
    pub target: String,
    /// `read` or `write` for folders; `call` for MCP servers.
    pub access: String,
    /// `device` or `hub`.
    pub granted_by: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AccessRequest {
    pub id: String,
    pub grantee: Grantee,
    pub kind: String,
    pub target: String,
    pub access: String,
    #[serde(default)]
    pub reason: Option<String>,
    /// `pending`, `granted` or `denied`.
    pub status: String,
    pub created_at: String,
    #[serde(default)]
    pub decided_at: Option<String>,
    #[serde(default)]
    pub decided_by: Option<String>,
    #[serde(default)]
    pub grant_id: Option<String>,
    /// A device-side decision the Hub has acknowledged.
    #[serde(default)]
    pub reported: bool,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct GrantsFile {
    #[serde(default)]
    pub grants: Vec<Grant>,
    #[serde(default)]
    pub requests: Vec<AccessRequest>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Need {
    Read,
    Write,
}

/// A path resolved inside a grant.
#[derive(Debug, Clone, PartialEq)]
pub struct Resolved {
    pub path: PathBuf,
    pub root: PathBuf,
    pub writable: bool,
}

/// The grants file, shared by the storage module and the `novad access` command. A lock file
/// serializes read-modify-write cycles across the two processes.
pub struct GrantStore {
    path: PathBuf,
    /// novad's data directory: never reachable through a grant.
    data_dir: PathBuf,
}

const MAX_PENDING: usize = 200;
const MAX_DECIDED_KEPT: usize = 500;

impl GrantStore {
    pub fn new(path: PathBuf, data_dir: PathBuf) -> Self {
        GrantStore { path, data_dir }
    }

    pub fn load(&self) -> OpResult<GrantsFile> {
        read_json_or(&self.path, GrantsFile::default()).map_err(|e| OpError::internal(e.to_string()))
    }

    fn update<T>(&self, f: impl FnOnce(&mut GrantsFile) -> OpResult<T>) -> OpResult<T> {
        let _lock = FileLock::acquire(&self.path.with_extension("lock"))?;
        let mut file = self.load()?;
        let out = f(&mut file)?;
        write_json(&self.path, &file, true).map_err(|e| OpError::internal(e.to_string()))?;
        Ok(out)
    }

    /// Resolve `raw` for `grantee` with the access `need` (FR-190 protected paths first).
    pub fn resolve(&self, grantee: &Grantee, raw: &str, need: Need) -> OpResult<Resolved> {
        let path = paths::canonical(raw)
            .ok_or_else(|| OpError::validation("the path must be absolute, with no . or .. segments"))?;
        let data = std::fs::canonicalize(&self.data_dir).unwrap_or_else(|_| self.data_dir.clone());
        if let Some(reason) = paths::protected_reason(&path, Some(&data)) {
            return Err(OpError::denied("protected_path", reason).with(json!({ "reason": "protected_path", "path": path })));
        }
        let file = self.load()?;
        let mut best: Option<(PathBuf, bool)> = None;
        for g in file.grants.iter().filter(|g| g.kind == "folder" && &g.grantee == grantee) {
            let root = PathBuf::from(&g.target);
            if !paths::within(&root, &path) {
                continue;
            }
            let writable = g.access == "write";
            let better = match &best {
                None => true,
                Some((b, w)) => root.as_os_str().len() > b.as_os_str().len() || (root == *b && writable && !w),
            };
            if better {
                best = Some((root, writable));
            }
        }
        let Some((root, writable)) = best else {
            return Err(access_required(&path, need));
        };
        if need == Need::Write {
            if !writable {
                return Err(access_required(&path, need));
            }
            if let Some(reason) = paths::read_only_reason(&root, &path) {
                return Err(OpError::denied("protected_path", reason).with(json!({ "reason": "protected_path", "path": path })));
            }
        }
        Ok(Resolved { path, root, writable })
    }

    /// The folder roots granted to `grantee` with their access.
    pub fn roots(&self, grantee: &Grantee) -> OpResult<Vec<(PathBuf, bool)>> {
        Ok(self
            .load()?
            .grants
            .into_iter()
            .filter(|g| g.kind == "folder" && &g.grantee == grantee)
            .map(|g| (PathBuf::from(g.target), g.access == "write"))
            .collect())
    }

    /// Ask for a folder (or an MCP server). An existing grant that covers it is returned as
    /// granted; an identical pending request is returned as is.
    pub fn request(&self, grantee: &Grantee, kind: &str, target: &str, access: &str, reason: Option<String>) -> OpResult<AccessRequest> {
        let (target, access) = match kind {
            "folder" => {
                if access != "read" && access != "write" {
                    return Err(OpError::validation("access must be read or write"));
                }
                let p = paths::canonical(target)
                    .ok_or_else(|| OpError::validation("the folder must be an absolute path with no . or .. segments"))?;
                let data = std::fs::canonicalize(&self.data_dir).unwrap_or_else(|_| self.data_dir.clone());
                if let Some(r) = paths::protected_reason(&p, Some(&data)) {
                    return Err(OpError::denied("protected_path", r).with(json!({ "reason": "protected_path", "path": p })));
                }
                if !p.is_dir() {
                    return Err(OpError::not_found("the folder does not exist on this device"));
                }
                (p.to_string_lossy().to_string(), access.to_string())
            }
            "mcp" => (target.to_string(), "call".to_string()),
            _ => return Err(OpError::validation("kind must be folder or mcp")),
        };
        let reason = reason.map(|r| r.chars().take(500).collect::<String>());
        self.update(|f| {
            let covered = f.grants.iter().find(|g| {
                g.kind == kind
                    && &g.grantee == grantee
                    && if kind == "folder" {
                        paths::within(Path::new(&g.target), Path::new(&target)) && (g.access == "write" || access == "read")
                    } else {
                        g.target == target
                    }
            });
            if let Some(g) = covered {
                return Ok(AccessRequest {
                    id: format!("covered-{}", g.id),
                    grantee: grantee.clone(),
                    kind: kind.into(),
                    target: target.clone(),
                    access: access.clone(),
                    reason: reason.clone(),
                    status: "granted".into(),
                    created_at: g.created_at.clone(),
                    decided_at: Some(g.created_at.clone()),
                    decided_by: Some(g.granted_by.clone()),
                    grant_id: Some(g.id.clone()),
                    reported: true,
                });
            }
            if let Some(r) = f.requests.iter().find(|r| {
                r.status == "pending" && &r.grantee == grantee && r.kind == kind && r.target == target && r.access == access
            }) {
                return Ok(r.clone());
            }
            if f.requests.iter().filter(|r| r.status == "pending").count() >= MAX_PENDING {
                return Err(OpError::new(429, "rate_limited", "too many pending access requests on this device"));
            }
            let r = AccessRequest {
                id: new_id(),
                grantee: grantee.clone(),
                kind: kind.into(),
                target: target.clone(),
                access: access.clone(),
                reason: reason.clone(),
                status: "pending".into(),
                created_at: now_iso(),
                decided_at: None,
                decided_by: None,
                grant_id: None,
                reported: false,
            };
            f.requests.push(r.clone());
            Ok(r)
        })
    }

    /// Grant or deny a pending request. `by` is `device` or `hub`. Deciding an already decided
    /// request with the same outcome returns it unchanged; the opposite outcome is a conflict.
    pub fn decide(&self, request_id: &str, grant: bool, by: &str) -> OpResult<AccessRequest> {
        let status = if grant { "granted" } else { "denied" };
        self.update(|f| {
            let idx = f
                .requests
                .iter()
                .position(|r| r.id == request_id)
                .ok_or_else(|| OpError::not_found("no such access request"))?;
            if f.requests[idx].status != "pending" {
                return if f.requests[idx].status == status {
                    Ok(f.requests[idx].clone())
                } else {
                    Err(OpError::conflict("the request was already decided").with(json!({ "request": f.requests[idx] })))
                };
            }
            let now = now_iso();
            let mut grant_id = None;
            if grant {
                let r = f.requests[idx].clone();
                // Upgrade an existing read grant of the same folder instead of adding a second one.
                if let Some(g) = f.grants.iter_mut().find(|g| g.kind == r.kind && g.grantee == r.grantee && g.target == r.target) {
                    if r.access == "write" {
                        g.access = "write".into();
                    }
                    grant_id = Some(g.id.clone());
                } else {
                    let g = Grant {
                        id: new_id(),
                        grantee: r.grantee.clone(),
                        kind: r.kind.clone(),
                        target: r.target.clone(),
                        access: r.access.clone(),
                        granted_by: by.into(),
                        created_at: now.clone(),
                    };
                    grant_id = Some(g.id.clone());
                    f.grants.push(g);
                }
            }
            let r = &mut f.requests[idx];
            r.status = status.into();
            r.decided_at = Some(now);
            r.decided_by = Some(by.into());
            r.grant_id = grant_id;
            // A decision the Hub made needs no report back.
            r.reported = by == "hub";
            let out = r.clone();
            prune(f);
            Ok(out)
        })
    }

    /// Remove a grant (revocable at any moment, FR-081, FR-210).
    pub fn revoke(&self, grant_id: &str) -> OpResult<bool> {
        self.update(|f| {
            let before = f.grants.len();
            f.grants.retain(|g| g.id != grant_id);
            Ok(f.grants.len() != before)
        })
    }

    /// Remove every grant of a grantee (an agent's connection was revoked).
    pub fn revoke_grantee(&self, grantee: &Grantee) -> OpResult<usize> {
        self.update(|f| {
            let before = f.grants.len();
            f.grants.retain(|g| &g.grantee != grantee);
            for r in f.requests.iter_mut().filter(|r| &r.grantee == grantee && r.status == "pending") {
                r.status = "denied".into();
                r.decided_at = Some(now_iso());
                r.decided_by = Some("device".into());
                r.reported = true;
            }
            Ok(before - f.grants.len())
        })
    }

    /// Grant directly (the device owner's own command, or a Hub decision on a known path).
    pub fn grant(&self, grantee: &Grantee, kind: &str, target: &str, access: &str, by: &str) -> OpResult<AccessRequest> {
        let r = self.request(grantee, kind, target, access, None)?;
        if r.status == "granted" { Ok(r) } else { self.decide(&r.id, true, by) }
    }

    /// Device-side decisions not yet acknowledged by the Hub.
    pub fn unreported(&self) -> OpResult<Vec<AccessRequest>> {
        Ok(self.load()?.requests.into_iter().filter(|r| r.status != "pending" && !r.reported).collect())
    }

    pub fn mark_reported(&self, ids: &[String]) -> OpResult<()> {
        if ids.is_empty() {
            return Ok(());
        }
        self.update(|f| {
            for r in f.requests.iter_mut().filter(|r| ids.contains(&r.id)) {
                r.reported = true;
            }
            Ok(())
        })
    }

    pub fn mcp_allowed(&self, grantee: &Grantee, server: &str) -> OpResult<bool> {
        Ok(self.load()?.grants.iter().any(|g| g.kind == "mcp" && &g.grantee == grantee && g.target == server))
    }
}

/// Keep every pending request and the newest decided ones.
fn prune(f: &mut GrantsFile) {
    let decided = f.requests.iter().filter(|r| r.status != "pending").count();
    if decided <= MAX_DECIDED_KEPT {
        return;
    }
    let mut drop = decided - MAX_DECIDED_KEPT;
    f.requests.retain(|r| {
        if drop > 0 && r.status != "pending" && r.reported {
            drop -= 1;
            false
        } else {
            true
        }
    });
}

/// The refusal for a path outside the grantee's folders; the caller may file a request for it.
fn access_required(path: &Path, need: Need) -> OpError {
    let access = if need == Need::Write { "write" } else { "read" };
    OpError::denied("folder_access_required", format!("{} is outside the folders granted to this session", path.display()))
        .with(json!({ "reason": "folder_access_required", "path": path, "access": access }))
}

/// The folder to ask for when `path` is outside every grant: its nearest existing directory
/// (the path itself when it is a directory).
pub fn folder_for(path: &Path) -> Option<PathBuf> {
    let mut cur = path.to_path_buf();
    if cur.is_dir() {
        return Some(cur);
    }
    while cur.pop() {
        if cur.is_dir() {
            return Some(cur);
        }
    }
    None
}

/// A lock file created exclusively; stale locks (over 10 s) are broken.
struct FileLock(PathBuf);

impl FileLock {
    fn acquire(path: &Path) -> OpResult<FileLock> {
        let start = std::time::Instant::now();
        loop {
            match std::fs::OpenOptions::new().write(true).create_new(true).open(path) {
                Ok(_) => return Ok(FileLock(path.to_path_buf())),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    let stale = std::fs::metadata(path)
                        .and_then(|m| m.modified())
                        .ok()
                        .and_then(|t| t.elapsed().ok())
                        .is_some_and(|age| age.as_secs() > 10);
                    if stale {
                        let _ = std::fs::remove_file(path);
                        continue;
                    }
                    if start.elapsed().as_secs() > 5 {
                        return Err(OpError::internal("the grants file is locked"));
                    }
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
                Err(e) => {
                    if let Some(dir) = path.parent() {
                        if !dir.exists() {
                            std::fs::create_dir_all(dir).map_err(OpError::from)?;
                            continue;
                        }
                    }
                    return Err(e.into());
                }
            }
        }
    }
}

impl Drop for FileLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;

    pub fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("novad-{name}-{}-{}", std::process::id(), new_id()));
        std::fs::create_dir_all(&d).unwrap();
        std::fs::canonicalize(&d).unwrap()
    }

    fn agent() -> Grantee {
        Grantee { kind: "agent".into(), id: "a1".into() }
    }

    #[test]
    fn parses_grantees() {
        assert!(Grantee::parse(&json!({"kind": "agent", "id": "x"})).is_ok());
        assert!(Grantee::parse(&json!({"kind": "root", "id": "x"})).is_err());
        assert!(Grantee::parse(&json!({"kind": "agent", "id": ""})).is_err());
    }

    #[test]
    fn requests_then_grants_and_resolves() {
        let base = tmp("grants");
        let data = base.join("data");
        let proj = base.join("proj");
        std::fs::create_dir_all(proj.join(".git")).unwrap();
        let store = GrantStore::new(data.join("grants.json"), data.clone());
        let a = agent();
        let err = store.resolve(&a, proj.join("x.txt").to_str().unwrap(), Need::Read).unwrap_err();
        assert_eq!(err.details.as_ref().unwrap()["reason"], "folder_access_required");

        let r = store.request(&a, "folder", proj.to_str().unwrap(), "read", Some("look".into())).unwrap();
        assert_eq!(r.status, "pending");
        // Same request again: the same pending entry.
        assert_eq!(store.request(&a, "folder", proj.to_str().unwrap(), "read", None).unwrap().id, r.id);
        let d = store.decide(&r.id, true, "device").unwrap();
        assert_eq!(d.status, "granted");
        assert!(!d.reported);
        assert_eq!(store.unreported().unwrap().len(), 1);
        store.mark_reported(&[r.id.clone()]).unwrap();
        assert!(store.unreported().unwrap().is_empty());

        let res = store.resolve(&a, proj.join("x.txt").to_str().unwrap(), Need::Read).unwrap();
        assert_eq!(res.root, proj);
        // Read grant only: writing needs a write grant.
        let w = store.resolve(&a, proj.join("x.txt").to_str().unwrap(), Need::Write).unwrap_err();
        assert_eq!(w.details.as_ref().unwrap()["access"], "write");
        let up = store.request(&a, "folder", proj.to_str().unwrap(), "write", None).unwrap();
        store.decide(&up.id, true, "hub").unwrap();
        assert_eq!(store.load().unwrap().grants.len(), 1, "the read grant was upgraded");
        assert!(store.resolve(&a, proj.join("x.txt").to_str().unwrap(), Need::Write).unwrap().writable);
        // .git stays read-only inside a writable grant.
        let git = store.resolve(&a, proj.join(".git/config").to_str().unwrap(), Need::Write).unwrap_err();
        assert_eq!(git.details.as_ref().unwrap()["reason"], "protected_path");
        // Another grantee has nothing.
        let other = Grantee { kind: "session".into(), id: "s".into() };
        assert!(store.resolve(&other, proj.join("x.txt").to_str().unwrap(), Need::Read).is_err());
        // A covered request is answered as granted.
        assert_eq!(store.request(&a, "folder", proj.to_str().unwrap(), "read", None).unwrap().status, "granted");
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn refuses_protected_and_conflicting_decisions() {
        let base = tmp("grants2");
        let data = base.join("data");
        std::fs::create_dir_all(base.join("home/.ssh")).unwrap();
        std::fs::create_dir_all(&data).unwrap();
        let store = GrantStore::new(data.join("grants.json"), data.clone());
        let a = agent();
        let e = store.request(&a, "folder", base.join("home/.ssh").to_str().unwrap(), "read", None).unwrap_err();
        assert_eq!(e.code, "policy_denied");
        let e = store.request(&a, "folder", data.to_str().unwrap(), "read", None).unwrap_err();
        assert_eq!(e.code, "policy_denied");
        assert_eq!(store.request(&a, "folder", base.join("nope").to_str().unwrap(), "read", None).unwrap_err().code, "not_found");
        // A whole-home grant still keeps .ssh denied.
        let r = store.request(&a, "folder", base.join("home").to_str().unwrap(), "write", None).unwrap();
        store.decide(&r.id, false, "hub").unwrap();
        assert_eq!(store.decide(&r.id, true, "hub").unwrap_err().code, "conflict");
        assert_eq!(store.decide(&r.id, false, "hub").unwrap().status, "denied");
        let g = store.grant(&a, "folder", base.join("home").to_str().unwrap(), "write", "device").unwrap();
        assert_eq!(g.status, "granted");
        assert_eq!(store.resolve(&a, base.join("home/.ssh/id").to_str().unwrap(), Need::Read).unwrap_err().code, "policy_denied");
        assert!(store.revoke(g.grant_id.as_deref().unwrap()).unwrap());
        assert!(store.resolve(&a, base.join("home/f").to_str().unwrap(), Need::Read).is_err());
        assert_eq!(store.decide("missing", true, "hub").unwrap_err().code, "not_found");
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn mcp_grants_and_grantee_revocation() {
        let base = tmp("grants3");
        let store = GrantStore::new(base.join("grants.json"), base.join("data"));
        let a = agent();
        assert!(!store.mcp_allowed(&a, "notes").unwrap());
        store.grant(&a, "mcp", "notes", "call", "hub").unwrap();
        assert!(store.mcp_allowed(&a, "notes").unwrap());
        assert_eq!(store.revoke_grantee(&a).unwrap(), 1);
        assert!(!store.mcp_allowed(&a, "notes").unwrap());
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn folder_for_finds_the_nearest_existing_directory() {
        let base = tmp("grants4");
        assert_eq!(folder_for(&base.join("a/b/c.txt")).unwrap(), base);
        assert_eq!(folder_for(&base).unwrap(), base);
        std::fs::remove_dir_all(&base).unwrap();
    }
}
