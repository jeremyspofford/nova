//! Uninstall and decommission (docs/23 §11, D9 of ADR-096).
//!
//! - `novad uninstall [--purge]` (as root when a service is installed): stops and removes the
//!   service (which stops novad and every module with it), removes the installed binary, the
//!   dedicated browser users and, as each user, the bridge's host manifests and token in the homes
//!   of the users in `localRuntime.users`, and wipes what lets this device act as itself: the
//!   device key, its credentials and management token (`device.json`), the device certificate, the
//!   Hub trust and the Hub key, the granted scopes and policy and the local runtime's token and
//!   socket (the authorization replay store stays until the folder goes, so a spent authorization
//!   stays spent). `--purge` also deletes the data folder: only one with novad's marker
//!   (`.novad-data`, written when the folder is made; or novad's own key, device and module files),
//!   and never `/`, a folder right under it, a system folder or a home folder.
//! - `POST /agent/v1/decommission {purge?, authorization}` (the Hub's decommission, D9): the
//!   authorization must be a Hub-signed `device.decommission` for exactly this body (src/authz.rs,
//!   D2; over mutual TLS when the device holds a certificate, D1). novad then closes the browser
//!   sessions, stops every module, forgets its credentials at once (later calls are 401), wipes the
//!   same files and answers. Half a second later it deletes the data folder when `purge` and the
//!   users' bridge files, then hands the rest to a transient unit outside its own sandbox (the
//!   service cannot write /etc or /usr under ProtectSystem=full, and stopping it ends novad): a
//!   few seconds later that unit disables the service, removes the unit file and the binary,
//!   reloads systemd, removes the browser users and only then stops novad. A novad that runs
//!   without a service exits at its next heartbeat. BIOS management credentials: novad installs
//!   none (the Hub keeps the admin password in its vault, D4), so there is nothing to clear.

use crate::install::ServiceSetup;
use crate::state::DataDir;
use crate::user_socket::Users;
use crate::util::{OpError, OpResult};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// What `wipe` removes, relative to the data folder.
pub const WIPED: &[&str] = &[
    "key.seed",
    "device.json",
    crate::tls::DEVICE_CERT_FILE,
    crate::tls::TRUST_FILE,
    crate::authz::KEY_FILE,
    "scopes.json",
    "policy.json",
    "local-runtime/token",
    "local-runtime/runtime.sock",
];

/// Remove the device's identity and credentials; the names of what was there.
pub fn wipe(data: &DataDir) -> Vec<String> {
    let mut gone = vec![];
    for name in WIPED {
        let p = data.path().join(name);
        let Ok(m) = std::fs::symlink_metadata(&p) else { continue };
        // The key is overwritten before it is unlinked (best effort: a copy-on-write or flash
        // file system may keep the old blocks).
        if *name == "key.seed" && m.file_type().is_file() {
            let _ = crate::util::write_atomic(&p, &[0u8; 32], true);
        }
        if std::fs::remove_file(&p).is_ok() {
            gone.push(name.to_string());
        }
    }
    gone
}

/// Folders a purge never deletes, whatever is in them: `/`, every folder right under it, the
/// usual system folders and home folders.
fn protected(dir: &Path) -> bool {
    const SYSTEM: &[&str] = &["/var/lib", "/var/tmp", "/var/log", "/var/cache", "/usr/local", "/usr/lib", "/private/var", "/Library/Application Support", "/System/Library"];
    let canon = dir.canonicalize().unwrap_or_else(|_| dir.to_path_buf());
    let home = std::env::var_os("HOME").map(PathBuf::from).and_then(|h| h.canonicalize().ok());
    match canon.parent() {
        None => true,
        Some(p) if p == Path::new("/") => true,
        Some(p) if p == Path::new("/home") || p == Path::new("/Users") => true,
        _ => SYSTEM.iter().any(|s| canon == Path::new(s)) || home.as_deref() == Some(canon.as_path()),
    }
}

/// Whether a folder may be deleted as novad's data folder: absolute, not protected, and marked
/// as novad's (the marker file, or novad's own key, device and module files together).
pub fn looks_like_data_dir(dir: &Path) -> bool {
    if !dir.is_absolute() || protected(dir) || std::fs::symlink_metadata(dir).map(|m| !m.file_type().is_dir()).unwrap_or(true) {
        return false;
    }
    let marked = std::fs::symlink_metadata(dir.join(crate::state::DATA_MARKER)).is_ok_and(|m| m.file_type().is_file());
    marked || ["device.json", "key.seed", "modules.json"].iter().all(|f| dir.join(f).is_file())
}

/// The bridge's files in each local user's home (their host manifests and token), removed as
/// that user; what was removed, per user.
fn remove_bridge_files(data: &DataDir, users: &dyn Users) -> Vec<Value> {
    let names = data.config().map(|c| c.local_runtime.users).unwrap_or_default();
    let mut out = vec![];
    for name in names.iter().filter(|n| crate::local_runtime::valid_user(n)) {
        let Some(a) = users.lookup(name) else { continue };
        let mut paths: Vec<PathBuf> = crate::bridge::browser_dirs(&a.home, None, cfg!(target_os = "macos")).into_iter().map(|d| d.join("NativeMessagingHosts").join(format!("{}.json", crate::bridge::HOST_NAME))).collect();
        paths.push(crate::bridge::token_path(&a.home));
        match crate::user_socket::remove_as(&a, &paths) {
            Ok(n) if n > 0 => out.push(json!({ "user": name, "removed": n })),
            Ok(_) => {}
            Err(e) => eprintln!("novad: the bridge files of user {name} were not removed: {}", e.message),
        }
    }
    out
}

/// Stop and remove the service (the `novad uninstall` command, outside the service); the
/// commands that ran. Nothing when no service is installed.
fn remove_service(svc: &ServiceSetup) -> Result<Vec<String>, String> {
    let unit = svc.unit_path.to_string_lossy().to_string();
    let name = svc.unit_path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "novad.service".into());
    let (before, after): (Vec<Vec<String>>, Vec<Vec<String>>) = match svc.platform {
        "windows" => (vec![vec!["sc.exe".into(), "stop".into(), "novad".into()], vec!["sc.exe".into(), "delete".into(), "novad".into()]], vec![]),
        _ if !svc.unit_path.exists() => return Ok(vec![]),
        "macos" => (vec![vec!["launchctl".into(), "unload".into(), "-w".into(), unit]], vec![]),
        _ => (vec![vec!["systemctl".into(), "disable".into(), "--now".into(), name]], vec![vec!["systemctl".into(), "daemon-reload".into()]]),
    };
    let mut ran = vec![];
    for argv in before {
        // A service that is already stopped or gone is fine; the file goes either way.
        let _ = svc.runner.run(&argv).map_err(|e| format!("{}: {e}", argv[0]))?;
        ran.push(argv.join(" "));
    }
    if svc.platform != "windows" {
        std::fs::remove_file(&svc.unit_path).map_err(|e| format!("cannot remove {}: {e}", svc.unit_path.display()))?;
        ran.push(format!("rm {}", svc.unit_path.display()));
    }
    for argv in after {
        let _ = svc.runner.run(&argv).map_err(|e| format!("{}: {e}", argv[0]))?;
        ran.push(argv.join(" "));
    }
    Ok(ran)
}

/// A path for the transient unit's shell line, single-quoted; None for one that cannot be.
fn quoted(p: &Path) -> Option<String> {
    let s = p.to_str()?;
    (!s.is_empty() && !s.contains('\'') && !s.bytes().any(|b| b < 0x20)).then(|| format!("'{s}'"))
}

/// The decommission's service removal, from inside the service: everything that writes /etc or
/// /usr, or stops novad, runs in a transient unit a few seconds later, files first and the stop
/// last. The commands that were handed over.
fn schedule_service_removal(svc: &ServiceSetup, browser_users: &[String]) -> Result<Vec<String>, String> {
    let run = |argv: Vec<String>| -> Result<String, String> {
        let (code, _, err) = svc.runner.run(&argv).map_err(|e| format!("{}: {e}", argv[0]))?;
        if code != 0 {
            return Err(format!("{} failed: {}", argv[0], err.trim()));
        }
        Ok(argv.join(" "))
    };
    match svc.platform {
        "windows" => Ok(vec![run(vec!["sc.exe".into(), "delete".into(), "novad".into()])?, run(vec!["sc.exe".into(), "stop".into(), "novad".into()])?]),
        "macos" => {
            // launchd does not sandbox novad: the files go first, then the job (which ends novad).
            let mut ran = vec![];
            for p in [&svc.unit_path, &svc.bin_path] {
                if std::fs::remove_file(p).is_ok() {
                    ran.push(format!("rm {}", p.display()));
                }
            }
            ran.push(run(vec!["launchctl".into(), "bootout".into(), "system/ai.nova.novad".into()])?);
            Ok(ran)
        }
        _ => {
            let has_unit = svc.unit_path.exists();
            if !has_unit && browser_users.is_empty() {
                return Ok(vec![]);
            }
            let name = svc.unit_path.file_name().and_then(|n| n.to_str()).filter(|n| n.ends_with(".service") && !n.contains('\'')).unwrap_or("novad.service").to_string();
            let mut steps = vec![];
            if has_unit {
                let (unit, bin) = (quoted(&svc.unit_path).ok_or("the unit path cannot be passed on")?, quoted(&svc.bin_path).ok_or("the binary path cannot be passed on")?);
                steps.push(format!("systemctl disable '{name}'"));
                steps.push(format!("rm -f -- {unit} {bin}"));
                steps.push("systemctl daemon-reload".to_string());
            }
            for u in browser_users.iter().filter(|u| crate::local_runtime::valid_user(u)) {
                steps.push(format!("userdel '{u}'"));
            }
            if has_unit {
                steps.push(format!("systemctl stop '{name}'"));
            }
            let script = steps.join("; ");
            run(vec![
                "systemd-run".into(),
                "--unit=novad-decommission".into(),
                "--description=Remove the Nova device agent".into(),
                "--on-active=3".into(),
                "--collect".into(),
                "/bin/sh".into(),
                "-c".into(),
                script.clone(),
            ])?;
            Ok(steps)
        }
    }
}

/// `novad uninstall [--purge]`.
pub fn run(data: &DataDir, purge: bool, svc: &ServiceSetup, elevated: bool, users: &dyn Users) -> Result<Value, String> {
    let installed = svc.platform == "windows" || svc.unit_path.exists() || svc.bin_path.exists();
    if installed && !elevated {
        return Err("novad is installed as a service; run `sudo novad uninstall` (removing it needs root)".into());
    }
    let purgeable = purge && looks_like_data_dir(data.path());
    if purge && !purgeable && data.path().exists() {
        return Err(format!("{} is not marked as novad's data folder (or is a system or home folder); nothing was removed", data.path().display()));
    }
    let service = remove_service(svc)?;
    let mut removed = vec![];
    if svc.bin_path.is_file() {
        std::fs::remove_file(&svc.bin_path).map_err(|e| format!("cannot remove {}: {e}", svc.bin_path.display()))?;
        removed.push(svc.bin_path.display().to_string());
    }
    let bridge = remove_bridge_files(data, users);
    let browser_users = if elevated { crate::browser::remove_users(&*svc.runner, users) } else { vec![] };
    let wiped = wipe(data);
    if purgeable {
        std::fs::remove_dir_all(data.path()).map_err(|e| format!("cannot delete {}: {e}", data.path().display()))?;
    }
    Ok(json!({ "uninstalled": true, "service": service, "removed": removed, "bridgeFiles": bridge, "browserUsers": browser_users, "wiped": wiped, "purged": purgeable }))
}

/// `POST /agent/v1/decommission` on the system's service.
pub fn decommission(agent: &crate::agent::Agent, body: &Value, transport: crate::authz::Transport) -> OpResult<Value> {
    decommission_with(agent, body, transport, ServiceSetup::system(), Box::new(crate::user_socket::SystemUsers), Duration::from_millis(500))
}

/// The decommission with its service setup, its user lookup and the delay before the folder and
/// the service go.
pub fn decommission_with(agent: &crate::agent::Agent, body: &Value, transport: crate::authz::Transport, svc: ServiceSetup, users: Box<dyn Users>, delay: Duration) -> OpResult<Value> {
    let purge = match &body["purge"] {
        Value::Null => false,
        Value::Bool(b) => *b,
        _ => return Err(OpError::validation("purge must be true or false")),
    };
    if let Some(bad) = body.as_object().and_then(|o| o.keys().find(|k| !matches!(k.as_str(), "purge" | "authorization"))) {
        return Err(OpError::validation(format!("unknown field {bad}")));
    }
    let a = crate::authz::authorize(&agent.data, "device.decommission", body, transport)?;
    let dir = agent.data.path().to_path_buf();
    // Judged before the wipe removes the files that make it recognizable.
    let purgeable = purge && looks_like_data_dir(&dir);
    eprintln!("novad: decommissioned by the Hub (change {}, approval {}); stopping modules and wiping credentials", a.change_id, a.approval_id);
    // Browser sessions close first so their profiles are deleted, not left for a next start.
    if agent.sup.spec(crate::browser::MODULE).is_some() {
        let _ = agent.sup.call(crate::browser::MODULE, "browser.closeAll", json!({}), Duration::from_secs(15));
    }
    agent.sup.stop_all();
    {
        let mut d = agent.state.lock().unwrap_or_else(|p| p.into_inner());
        d.credential = None;
        d.management_token = None;
        d.revoked = true;
    }
    let wiped = wipe(&agent.data);
    let service = svc.platform == "windows" || svc.unit_path.exists();
    let data = agent.data.clone();
    std::thread::spawn(move || {
        // Let the answer leave first: removing the service ends this process.
        std::thread::sleep(delay);
        remove_bridge_files(&data, &*users);
        if purgeable && let Err(e) = std::fs::remove_dir_all(&dir) {
            eprintln!("novad: cannot delete {}: {e}", dir.display());
        }
        let browser_users: Vec<String> = crate::browser::BROWSER_USERS.iter().filter(|n| users.lookup(n).is_some()).map(|n| n.to_string()).collect();
        if let Err(e) = schedule_service_removal(&svc, &browser_users) {
            eprintln!("novad: the service removal could not be scheduled ({e}); stopping only");
            let _ = remove_service(&svc);
        }
    });
    Ok(json!({ "decommissioned": true, "purge": purgeable, "wiped": wiped, "service": if service { "removing" } else { "none" } }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::authz::Transport;
    use crate::authz::tests::{enrolled, signed};
    use crate::crypto::SigningKey;
    use crate::power::tests::FakeRunner;
    use crate::tls::tests::HUB_SEED;
    use crate::user_socket::Account;
    use std::os::unix::fs::MetadataExt;

    /// Users for the tests: `alice` is this test's own account with `home`; the browser users
    /// exist when asked.
    struct U {
        home: PathBuf,
        browser_users: bool,
    }

    impl Users for U {
        fn lookup(&self, name: &str) -> Option<Account> {
            let m = std::fs::metadata(&self.home).ok()?;
            match name {
                "alice" => Some(Account { uid: m.uid(), gid: m.gid(), home: self.home.clone() }),
                "nova-browser1" | "nova-browser2" if self.browser_users => Some(Account { uid: 990, gid: 990, home: "/nonexistent".into() }),
                _ => None,
            }
        }
    }

    /// A home with the bridge's manifest and token, and an unrelated file next to them.
    fn home_with_bridge(home: &Path) -> Vec<PathBuf> {
        let nmh = home.join(".config/chromium/NativeMessagingHosts");
        std::fs::create_dir_all(&nmh).unwrap();
        std::fs::write(nmh.join("ai.nova.bridge.json"), "{}").unwrap();
        std::fs::write(nmh.join("other.app.json"), "{}").unwrap();
        std::fs::create_dir_all(home.join(".config/nova")).unwrap();
        std::fs::write(home.join(".config/nova/bridge-token"), "nvbr_x").unwrap();
        vec![nmh.join("ai.nova.bridge.json"), home.join(".config/nova/bridge-token")]
    }

    fn setup(root: &Path, runner: FakeRunner) -> ServiceSetup {
        ServiceSetup { platform: "linux", bin_path: root.join("usr/local/bin/novad"), unit_path: root.join("etc/systemd/system/novad.service"), runner: Box::new(runner) }
    }

    fn installed(root: &Path) {
        std::fs::create_dir_all(root.join("usr/local/bin")).unwrap();
        std::fs::write(root.join("usr/local/bin/novad"), "bin").unwrap();
        std::fs::create_dir_all(root.join("etc/systemd/system")).unwrap();
        std::fs::write(root.join("etc/systemd/system/novad.service"), "[Unit]\n").unwrap();
    }

    fn data_with_identity(dir: &Path) -> DataDir {
        let data = DataDir(dir.to_path_buf());
        data.ensure().unwrap();
        data.key().unwrap();
        for f in ["device.json", "device-cert.pem", "hub-trust.json", "scopes.json", "policy.json", "config.json", "modules.json"] {
            std::fs::write(dir.join(f), "{}").unwrap();
        }
        std::fs::create_dir_all(dir.join("local-runtime")).unwrap();
        std::fs::write(dir.join("local-runtime/token"), "nvlr_x").unwrap();
        data
    }

    #[test]
    fn uninstall_removes_the_service_and_wipes_the_identity() {
        let base = crate::grants::tests::tmp("uninst");
        let root = base.join("root");
        installed(&root);
        let data = data_with_identity(&base.join("data"));
        let home = base.join("home");
        let bridge_files = home_with_bridge(&home);
        let mut cfg = data.config().unwrap_or_default();
        cfg.local_runtime.users = vec!["alice".into()];
        crate::util::write_json(&data.config_path(), &cfg, false).unwrap();
        let users = U { home: home.clone(), browser_users: true };
        let runner = FakeRunner::default();
        let calls = runner.calls.clone();
        let svc = setup(&root, runner);
        // Without root a service cannot be removed.
        assert!(run(&data, false, &svc, false, &users).unwrap_err().contains("sudo"));
        let r = run(&data, false, &svc, true, &users).unwrap();
        assert_eq!(
            *calls.lock().unwrap(),
            vec![
                vec!["systemctl".to_string(), "disable".into(), "--now".into(), "novad.service".into()],
                vec!["systemctl".into(), "daemon-reload".into()],
                vec!["userdel".into(), "nova-browser1".into()],
                vec!["userdel".into(), "nova-browser2".into()],
            ]
        );
        assert_eq!(r["browserUsers"], json!(["nova-browser1", "nova-browser2"]));
        // The user's bridge manifest and token went (as the user); nothing else in their home.
        assert_eq!(r["bridgeFiles"], json!([{ "user": "alice", "removed": 2 }]));
        assert!(bridge_files.iter().all(|f| !f.exists()));
        assert!(home.join(".config/chromium/NativeMessagingHosts/other.app.json").exists());
        assert!(!root.join("etc/systemd/system/novad.service").exists() && !root.join("usr/local/bin/novad").exists());
        let wiped: Vec<String> = serde_json::from_value(r["wiped"].clone()).unwrap();
        for f in ["key.seed", "device.json", "device-cert.pem", "hub-trust.json", "scopes.json", "policy.json", "local-runtime/token"] {
            assert!(wiped.contains(&f.to_string()), "{f}");
            assert!(!data.path().join(f).exists(), "{f}");
        }
        // The owner's settings stay without --purge.
        assert!(data.path().join("config.json").exists());
        assert_eq!(r["purged"], false);
        // Again, with --purge: nothing left to stop, the folder goes.
        let r = run(&data, true, &svc, false, &users).unwrap();
        assert_eq!((r["purged"].as_bool(), r["service"].as_array().map(Vec::len)), (Some(true), Some(0)));
        assert!(!data.path().exists());
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn schedules_files_before_the_stop_on_every_platform() {
        let base = crate::grants::tests::tmp("sched");
        installed(&base);
        let runner = FakeRunner::default();
        let calls = runner.calls.clone();
        let mac = ServiceSetup { platform: "macos", bin_path: base.join("usr/local/bin/novad"), unit_path: base.join("etc/systemd/system/novad.service"), runner: Box::new(runner.clone()) };
        let ran = schedule_service_removal(&mac, &[]).unwrap();
        assert_eq!(ran.last().unwrap(), "launchctl bootout system/ai.nova.novad");
        assert!(ran[0].starts_with("rm ") && !mac.unit_path.exists() && !mac.bin_path.exists(), "the files go first: {ran:?}");
        let win = ServiceSetup { platform: "windows", bin_path: PathBuf::new(), unit_path: PathBuf::new(), runner: Box::new(runner.clone()) };
        assert_eq!(schedule_service_removal(&win, &[]).unwrap(), vec!["sc.exe delete novad".to_string(), "sc.exe stop novad".into()]);
        // Nothing installed: nothing to schedule. A path that cannot be quoted is refused.
        let none = setup(&base.join("none"), runner.clone());
        assert!(schedule_service_removal(&none, &[]).unwrap().is_empty());
        installed(&base);
        let odd = ServiceSetup { platform: "linux", bin_path: PathBuf::from("/x'y"), unit_path: base.join("etc/systemd/system/novad.service"), runner: Box::new(runner.clone()) };
        assert!(schedule_service_removal(&odd, &[]).is_err());
        assert_eq!(calls.lock().unwrap().len(), 3);
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn purges_only_a_folder_marked_as_novads() {
        let base = crate::grants::tests::tmp("purge-guard");
        let none = setup(&base.join("none"), FakeRunner::default());
        let users = U { home: base.clone(), browser_users: false };
        // Generic files someone else could have are not enough.
        let other = base.join("project");
        std::fs::create_dir_all(&other).unwrap();
        for f in ["config.json", "modules.json", "notes.txt"] {
            std::fs::write(other.join(f), "x").unwrap();
        }
        let e = run(&DataDir(other.clone()), true, &none, false, &users).unwrap_err();
        assert!(e.contains("not marked"), "{e}");
        assert!(other.join("notes.txt").exists());
        // The marker (written when the folder is made) or novad's own trio makes it novad's.
        let made = DataDir(base.join("made"));
        made.ensure().unwrap();
        assert!(looks_like_data_dir(made.path()));
        let legacy = base.join("legacy");
        std::fs::create_dir_all(&legacy).unwrap();
        for f in ["device.json", "key.seed", "modules.json"] {
            std::fs::write(legacy.join(f), "x").unwrap();
        }
        assert!(looks_like_data_dir(&legacy));
        // A marker that is a link does not count.
        let fake = base.join("fake");
        std::fs::create_dir_all(&fake).unwrap();
        std::os::unix::fs::symlink(made.path().join(crate::state::DATA_MARKER), fake.join(crate::state::DATA_MARKER)).unwrap();
        assert!(!looks_like_data_dir(&fake));
        // `/`, folders right under it, system and home folders: never, marker or not.
        for p in ["/", "/tmp", "/var", "/var/lib", "/home", "/usr/local", "/etc"] {
            assert!(!looks_like_data_dir(Path::new(p)), "{p}");
        }
        assert!(protected(Path::new("/home/alice")) && protected(Path::new("/Users/bob")));
        if let Some(h) = std::env::var_os("HOME") {
            assert!(protected(Path::new(&h)));
        }
        assert!(!looks_like_data_dir(Path::new("relative")));
        std::fs::remove_dir_all(&base).unwrap();
    }

    fn agent_for(data: &DataDir) -> crate::agent::Agent {
        let d = data.device().unwrap().unwrap();
        let pong = crate::supervisor::ModuleSpec { exec: Some(vec!["/bin/sh".into(), "-c".into(), crate::supervisor::tests::PONG.into()]), ..crate::supervisor::ModuleSpec::builtin("storage", true) };
        let a = crate::agent::Agent::new(data.clone(), PathBuf::from("/bin/false"), d, crate::supervisor::Manifest { modules: vec![pong] });
        a.sup.start_all();
        a
    }

    #[test]
    fn decommission_needs_a_signed_authorization_for_this_body() {
        let (base, data) = enrolled("decom-refuse");
        data.key().unwrap();
        let a = agent_for(&data);
        let svc = || setup(&base.join("root"), FakeRunner::default());
        let users = || Box::new(U { home: base.clone(), browser_users: false });
        let go = |body: &Value, t: Transport| decommission_with(&a, body, t, svc(), users(), Duration::from_millis(10));
        let reason = |e: OpError| (e.status, e.details.and_then(|d| d["reason"].as_str().map(str::to_string)).unwrap_or(e.code));
        assert_eq!(reason(go(&json!({ "purge": false }), Transport::Plain).unwrap_err()), (403, "authorization_invalid".into()));
        assert_eq!(go(&json!({ "purge": "yes" }), Transport::Plain).unwrap_err().code, "validation");
        assert_eq!(go(&json!({ "purge": false, "extra": 1 }), Transport::Plain).unwrap_err().code, "validation");
        let now = crate::util::now_ms();
        // Another kind, another body, another signer, an expired one.
        let wrong_kind = signed(&HUB_SEED, "boot.revert", &json!({ "purge": false }), now);
        assert_eq!(reason(go(&wrong_kind, Transport::Plain).unwrap_err()), (403, "authorization_mismatch".into()));
        let mut other_body = signed(&HUB_SEED, "device.decommission", &json!({ "purge": false }), now);
        other_body["purge"] = json!(true);
        assert_eq!(reason(go(&other_body, Transport::Plain).unwrap_err()), (403, "authorization_mismatch".into()));
        let forged = signed(&[42u8; 32], "device.decommission", &json!({}), now);
        assert_eq!(reason(go(&forged, Transport::Plain).unwrap_err()), (403, "authorization_invalid".into()));
        let old = signed(&HUB_SEED, "device.decommission", &json!({}), now - 3_600_000);
        assert_eq!(reason(go(&old, Transport::Plain).unwrap_err()), (403, "authorization_expired".into()));
        // A device with a certificate takes it only over mutual TLS (D1).
        std::fs::write(data.path().join(crate::tls::DEVICE_CERT_FILE), "-----BEGIN CERTIFICATE-----\n").unwrap();
        let ok = signed(&HUB_SEED, "device.decommission", &json!({}), now);
        assert_eq!(reason(go(&ok, Transport::Plain).unwrap_err()), (403, "tls_required".into()));
        // Nothing was wiped by any refusal.
        assert!(data.path().join("key.seed").exists() && data.path().join("device.json").exists());
        assert_eq!(a.device().management_token.as_deref(), Some("nvdm_test"));
        a.sup.stop_all();
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn decommission_wipes_answers_then_purges_and_removes_the_service() {
        let (base, data) = enrolled("decom-ok");
        data.key().unwrap();
        std::fs::write(data.path().join("scopes.json"), "{}").unwrap();
        let a = agent_for(&data);
        let root = base.join("root");
        installed(&root);
        let home = base.join("home");
        let bridge_files = home_with_bridge(&home);
        let mut cfg = data.config().unwrap_or_default();
        cfg.local_runtime.users = vec!["alice".into()];
        crate::util::write_json(&data.config_path(), &cfg, false).unwrap();
        let runner = FakeRunner::default();
        let calls = runner.calls.clone();
        let body = signed(&HUB_SEED, "device.decommission", &json!({ "purge": true }), crate::util::now_ms());
        let r = decommission_with(&a, &body, Transport::Plain, setup(&root, runner), Box::new(U { home: home.clone(), browser_users: true }), Duration::from_millis(50)).unwrap();
        assert_eq!((r["decommissioned"].as_bool(), r["purge"].as_bool(), r["service"].as_str()), (Some(true), Some(true), Some("removing")));
        // At once: modules stopped, credentials forgotten, the identity wiped.
        assert!(a.sup.statuses().iter().all(|m| m["state"] == "stopped"));
        let d = a.device();
        assert!(d.revoked && d.credential.is_none() && d.management_token.is_none());
        let wiped: Vec<String> = serde_json::from_value(r["wiped"].clone()).unwrap();
        assert!(wiped.contains(&"key.seed".into()) && wiped.contains(&"device.json".into()) && wiped.contains(&crate::authz::KEY_FILE.into()));
        // The management token is gone: the next call is refused.
        let req = crate::http::Request { method: "POST".into(), path: "/agent/v1/status".into(), query: String::new(), headers: vec![("authorization".into(), "Bearer nvdm_test".into())], body: b"{}".to_vec(), peer: None };
        assert_eq!(a.handle(req).status, 401);
        // Then the folder and the users' bridge files; the service goes to a transient unit.
        let t0 = std::time::Instant::now();
        while (data.path().exists() || calls.lock().unwrap().is_empty()) && t0.elapsed() < Duration::from_secs(5) {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(!data.path().exists());
        assert!(bridge_files.iter().all(|f| !f.exists()));
        let calls = calls.lock().unwrap().clone();
        assert_eq!(calls.len(), 1, "novad itself stops nothing: {calls:?}");
        let c = &calls[0];
        assert_eq!(&c[..2], &["systemd-run".to_string(), "--unit=novad-decommission".into()]);
        assert!(c.contains(&"--on-active=3".to_string()) && c.contains(&"--collect".to_string()));
        assert_eq!(&c[c.len() - 3..c.len() - 1], &["/bin/sh".to_string(), "-c".into()]);
        // Files first, the stop last.
        let unit = root.join("etc/systemd/system/novad.service");
        let bin = root.join("usr/local/bin/novad");
        let steps: Vec<String> = c.last().unwrap().split("; ").map(str::to_string).collect();
        assert_eq!(
            steps,
            vec![
                "systemctl disable 'novad.service'".to_string(),
                format!("rm -f -- '{}' '{}'", unit.display(), bin.display()),
                "systemctl daemon-reload".into(),
                "userdel 'nova-browser1'".into(),
                "userdel 'nova-browser2'".into(),
                "systemctl stop 'novad.service'".into(),
            ]
        );
        // The same authorization cannot be spent twice: the replay store outlives the wipe.
        let (base2, data2) = enrolled("decom-replay");
        let a2 = agent_for(&data2);
        let body = signed(&HUB_SEED, "device.decommission", &json!({}), crate::util::now_ms());
        decommission_with(&a2, &body, Transport::Plain, setup(&base2.join("root"), FakeRunner::default()), Box::new(U { home: base2.clone(), browser_users: false }), Duration::from_millis(10)).unwrap();
        // Enrolled again with the same Hub (the wipe took the pin and the key).
        crate::tls::HubTrust::pinned(&crate::tls::tests::hub_pin()).save(&data2.path().join(crate::tls::TRUST_FILE)).unwrap();
        crate::authz::save_hub_key(&data2, &crate::crypto::b64url_encode(&SigningKey::from_seed(&HUB_SEED).public_key())).unwrap();
        let mut d2 = data2.new_device("box", vec![]).unwrap();
        d2.device_id = Some("dev-1".into());
        data2.save_device(&d2).unwrap();
        let again = decommission_with(&a2, &body, Transport::Plain, setup(&base2.join("root"), FakeRunner::default()), Box::new(U { home: base2.clone(), browser_users: false }), Duration::from_millis(10)).unwrap_err();
        assert_eq!((again.status, again.details.unwrap()["reason"].as_str()), (409, Some("replayed")));
        a.sup.stop_all();
        a2.sup.stop_all();
        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::remove_dir_all(&base2);
    }
}
