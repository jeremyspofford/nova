//! Path rules for device file operations (FR-190, FR-210, docs/12 §7.2, docs/23 §4.1). The same
//! protected locations the Hub's policy engine uses (packages/policy/src/paths.ts): credential
//! locations are never reachable, and inside a writable grant the read-only locations stay
//! read-only. Checks run on canonical paths (symlinks resolved), so a link cannot leave a grant.

use std::path::{Component, Path, PathBuf};

/// Inside a writable grant these stay read-only (relative to the grant, at any depth).
pub const READ_ONLY_LOCATIONS: &[&[&str]] = &[
    &[".git"],
    &[".nova"],
    &[".agents"],
    &[".bashrc"],
    &[".bash_profile"],
    &[".bash_login"],
    &[".bash_logout"],
    &[".profile"],
    &[".zshrc"],
    &[".zshenv"],
    &[".zprofile"],
    &[".zlogin"],
    &[".zlogout"],
    &[".kshrc"],
    &[".cshrc"],
    &[".tcshrc"],
    &[".config", "fish"],
    &["microsoft.powershell_profile.ps1"],
    &["profile.ps1"],
    &["documents", "powershell"],
    &["documents", "windowspowershell"],
];

/// Credential locations: denied wherever they appear in a path. `*` ends a prefix segment.
pub const CREDENTIAL_LOCATIONS: &[&[&str]] = &[
    &[".ssh"],
    &[".gnupg"],
    &[".git-credentials"],
    &[".netrc"],
    &["_netrc"],
    &[".aws"],
    &[".azure"],
    &[".config", "gcloud"],
    &[".config", "gh"],
    &[".kube"],
    &[".npmrc"],
    &[".pypirc"],
    &[".cargo", "credentials*"],
    &[".docker", "config.json"],
    &[".password-store"],
    &[".local", "share", "keyrings"],
    &["library", "keychains"],
    &[".mozilla"],
    &[".config", "google-chrome"],
    &[".config", "chromium"],
    &[".config", "bravesoftware"],
    &["library", "application support", "google", "chrome"],
    &["library", "application support", "firefox"],
    &["library", "safari"],
    &["appdata", "local", "google", "chrome", "user data"],
    &["appdata", "roaming", "mozilla"],
    &["appdata", "local", "microsoft", "credentials"],
    &["appdata", "roaming", "microsoft", "credentials"],
    &["appdata", "roaming", "microsoft", "protect"],
];

/// Fold a segment the way protection compares it: lowercase, no stream suffix, no trailing dots
/// or spaces (so `.GIT`, `.git.` and `.git::$DATA` are all `.git`).
fn fold(seg: &str) -> String {
    let lower = seg.to_lowercase();
    let no_stream = match lower.find(':') {
        Some(i) => lower[..i].to_string(),
        None => lower,
    };
    let trimmed = no_stream.trim_end_matches(['.', ' ']);
    if trimmed.is_empty() { no_stream } else { trimmed.to_string() }
}

fn seg_match(want: &str, seg: &str) -> bool {
    match want.strip_suffix('*') {
        Some(prefix) => seg.starts_with(prefix),
        None => seg == want,
    }
}

/// A file name on disk matches one location segment: folded (case-insensitive), `*` ending a
/// prefix. The sandbox uses it to find protected locations inside granted folders.
pub fn name_matches(want: &str, name: &str) -> bool {
    seg_match(want, &fold(name))
}

/// Which location (joined with `/`) starts at any position of `segs`, if one does.
pub fn matches_location(segs: &[String], locations: &[&[&str]]) -> Option<String> {
    for i in 0..segs.len() {
        for loc in locations {
            if loc.iter().enumerate().all(|(j, want)| segs.get(i + j).is_some_and(|s| seg_match(want, s))) {
                return Some(loc.join("/"));
            }
        }
    }
    None
}

/// The normal segments of an absolute path, as strings.
pub fn segments(p: &Path) -> Vec<String> {
    p.components()
        .filter_map(|c| match c {
            Component::Normal(s) => Some(s.to_string_lossy().to_string()),
            _ => None,
        })
        .collect()
}

/// An absolute path without `.`/`..` segments or NUL bytes, lexically normalized; None otherwise.
/// Nothing on disk is consulted here.
pub fn lexical(p: &str) -> Option<PathBuf> {
    if p.is_empty() || p.contains('\0') {
        return None;
    }
    let path = Path::new(p);
    if !path.is_absolute() {
        return None;
    }
    // `components()` drops `.` segments silently; refuse them on the raw text instead.
    if p.split(['/', '\\']).any(|seg| seg == "." || seg == "..") {
        return None;
    }
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::RootDir | Component::Prefix(_) => out.push(c.as_os_str()),
            Component::Normal(s) => out.push(s),
            Component::CurDir | Component::ParentDir => return None,
        }
    }
    Some(out)
}

/// The canonical form on disk: the deepest existing ancestor resolved through symlinks, with the
/// missing tail appended (a new file's parent must exist for it to be useful). None when the path
/// is not lexically valid or nothing of it exists.
pub fn canonical(p: &str) -> Option<PathBuf> {
    let lex = lexical(p)?;
    if let Ok(c) = std::fs::canonicalize(&lex) {
        return Some(c);
    }
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    let mut cur = lex.clone();
    loop {
        let name = cur.file_name()?.to_os_string();
        tail.push(name);
        if !cur.pop() {
            return None;
        }
        if let Ok(base) = std::fs::canonicalize(&cur) {
            let mut out = base;
            for seg in tail.iter().rev() {
                out.push(seg);
            }
            return Some(out);
        }
    }
}

/// `child` is `parent` or inside it (both canonical).
pub fn within(parent: &Path, child: &Path) -> bool {
    child.starts_with(parent)
}

/// Why a path can never be reached through novad, or None. Credential locations anywhere, and
/// novad's own data directory.
pub fn protected_reason(p: &Path, data_dir: Option<&Path>) -> Option<String> {
    if let Some(d) = data_dir {
        if within(d, p) {
            return Some("novad's data folder is never available".into());
        }
    }
    let folded: Vec<String> = segments(p).iter().map(|s| fold(s)).collect();
    matches_location(&folded, CREDENTIAL_LOCATIONS)
        .map(|loc| format!("credential locations ({loc}) are never available"))
}

/// Deleting or moving `p` would remove novad's data folder, a credential location under it or a
/// whole grant root (docs/12 §7.2: an ancestor of a protected path cannot be swapped out).
pub fn is_protected_ancestor(p: &Path, data_dir: Option<&Path>, roots: &[PathBuf]) -> bool {
    if data_dir.is_some_and(|d| within(p, d)) || roots.iter().any(|r| within(p, r)) {
        return true;
    }
    // A folder whose subtree holds a credential location by name.
    let folded: Vec<String> = segments(p).iter().map(|s| fold(s)).collect();
    CREDENTIAL_LOCATIONS.iter().any(|loc| {
        let first = loc[0];
        folded.last().is_some_and(|last| seg_match(first, last))
    }) || dir_holds_credentials(p)
}

fn dir_holds_credentials(p: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(p) else { return false };
    entries.flatten().any(|e| {
        let name = fold(&e.file_name().to_string_lossy());
        CREDENTIAL_LOCATIONS.iter().any(|loc| seg_match(loc[0], &name))
    })
}

/// Inside a writable grant rooted at `root`, the read-only location `p` falls in, if any.
pub fn read_only_reason(root: &Path, p: &Path) -> Option<String> {
    let rel = p.strip_prefix(root).ok()?;
    let folded: Vec<String> = segments(rel).iter().map(|s| fold(s)).collect();
    matches_location(&folded, READ_ONLY_LOCATIONS).map(|loc| format!("{loc} stays read-only"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folds_variants() {
        assert_eq!(fold(".GIT"), ".git");
        assert_eq!(fold(".git."), ".git");
        assert_eq!(fold(".git::$DATA"), ".git");
        assert_eq!(fold("..."), "...");
    }

    #[test]
    fn lexical_rejects_relative_and_dots() {
        assert!(lexical("rel/a").is_none());
        assert!(lexical("/a/../b").is_none());
        assert!(lexical("/a/./b").is_none());
        assert!(lexical("").is_none());
        assert!(lexical("/a\0b").is_none());
        assert_eq!(lexical("/a//b/").unwrap(), PathBuf::from("/a/b"));
    }

    #[test]
    fn credential_locations_are_protected_anywhere() {
        assert!(protected_reason(Path::new("/home/u/.ssh/id_ed25519"), None).unwrap().contains(".ssh"));
        assert!(protected_reason(Path::new("/home/u/.config/gh/hosts.yml"), None).is_some());
        assert!(protected_reason(Path::new("/home/u/.cargo/credentials.toml"), None).is_some());
        assert!(protected_reason(Path::new("/home/u/.SSH"), None).is_some());
        assert!(protected_reason(Path::new("/home/u/projects/app/src/main.rs"), None).is_none());
        assert!(protected_reason(Path::new("/var/lib/nova/key.seed"), Some(Path::new("/var/lib/nova"))).is_some());
        // A parent of the data dir may be granted; the data dir inside it stays denied.
        assert!(protected_reason(Path::new("/var/lib"), Some(Path::new("/var/lib/nova"))).is_none());
        assert!(is_protected_ancestor(Path::new("/var/lib"), Some(Path::new("/var/lib/nova")), &[]));
    }

    #[test]
    fn credential_matching_is_case_insensitive_with_prefixes_at_any_depth() {
        for p in [
            "/g/proj/a/b/.ssh/id_x",
            "/g/proj/.Ssh",
            "/g/proj/x/.CARGO/Credentials",
            "/g/proj/x/.cargo/credentials.toml",
            "/g/proj/.config/GH/hosts.yml",
            "/g/proj/deep/.Docker/CONFIG.JSON",
            "/g/proj/.netrc.",
            "/g/proj/AppData/Roaming/Microsoft/Protect/k",
        ] {
            assert!(protected_reason(Path::new(p), None).is_some(), "{p}");
        }
        for p in ["/g/proj/.cargo/config.toml", "/g/proj/.docker/daemon.json", "/g/proj/.config/fish", "/g/proj/ssh"] {
            assert!(protected_reason(Path::new(p), None).is_none(), "{p}");
        }
        assert!(name_matches("credentials*", "Credentials.TOML"));
        assert!(name_matches(".ssh", ".SSH"));
        assert!(!name_matches(".ssh", ".ssh2"));
        assert!(!name_matches("credentials*", "creds"));
    }

    #[test]
    fn read_only_inside_writable_roots() {
        let root = Path::new("/home/u/p");
        assert!(read_only_reason(root, Path::new("/home/u/p/.git/config")).is_some());
        assert!(read_only_reason(root, Path::new("/home/u/p/sub/.git/HEAD")).is_some());
        assert!(read_only_reason(root, Path::new("/home/u/p/.zshrc")).is_some());
        assert!(read_only_reason(root, Path::new("/home/u/p/src/lib.rs")).is_none());
        assert!(read_only_reason(root, Path::new("/elsewhere")).is_none());
    }

    #[test]
    fn canonical_resolves_symlinks_and_missing_tails() {
        let dir = std::env::temp_dir().join(format!("novad-paths-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("real")).unwrap();
        std::os::unix::fs::symlink(dir.join("real"), dir.join("link")).unwrap();
        let c = canonical(dir.join("link/new.txt").to_str().unwrap()).unwrap();
        assert_eq!(c, std::fs::canonicalize(dir.join("real")).unwrap().join("new.txt"));
        assert!(canonical("relative").is_none());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
