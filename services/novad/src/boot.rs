//! Low-level boot (FR-143, docs/23 §5.2, D5 of ADR-096): a ONE-SHOT next boot into a bootloader
//! entry with a watchdog, made the default only when the owner commits it. A machine that never
//! comes up returns to its default entry on the next power cycle by itself, because the one-shot
//! is consumed by the boot that tried it.
//!
//! Bootloaders sit behind [`Bootloader`]: systemd-boot (`bootctl`), GRUB (`grub-reboot`,
//! `grub-set-default`, entries read from `grub.cfg`), UEFI boot entries (`efibootmgr`) and a fake
//! (a JSON file, selected only by the owner's `config.json`). Every command runs through the
//! hardened child-process helper (`exec::run_command`: cleared environment, no new privileges, a
//! wall clock) with its arguments as an argument vector, never through a shell.
//!
//! `boot/set` needs the Hub's `lowLevelBoot` policy (`policy.json`) and a Hub-signed
//! authorization (`authz.rs`); so does `boot/commit`. `boot/revert` needs only the authorization,
//! and the watchdog's own revert needs nothing: undoing is always allowed.
//!
//! Watchdog: `boot/set` writes `boot/pending.json` with a deadline and this boot's id
//! (`/proc/sys/kernel/random/boot_id`). After the machine restarts, the marker is armed; the first
//! heartbeat the Hub accepts before the deadline, on the pending entry, reports `boot.watchdog.ok`
//! (the Hub then offers "make default"). Booted into another entry: the one-shot is cleared and
//! `boot.watchdog.reverted` reported. The deadline passing first: the one-shot is cleared,
//! `boot.watchdog.reverted` reported and novad reboots once into the default (never twice for one
//! marker). A machine that was never restarted by the deadline gets the one-shot cleared, without
//! a reboot. Events wait in a file outbox until a heartbeat carries them.
//!
//! This file also holds what the firmware module (`firmware.rs`) shares: the tool runner, the
//! watchdog marker, the outbox and the reboot request.

use crate::authz::{self, Transport};
use crate::exec::{ExecSpec, run_command};
use crate::state::DataDir;
use crate::util::{OpError, OpResult, iso, now_ms, read_json_or, write_json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const WATCHDOG_DEFAULT_S: u64 = 600;
pub const WATCHDOG_MIN_S: u64 = 120;
pub const WATCHDOG_MAX_S: u64 = 3600;
const TOOL_TIMEOUT_MS: u64 = 10_000;
/// Let the answer to the Hub leave before the machine goes down.
pub const REBOOT_DELAY: Duration = Duration::from_millis(1500);
pub const BOOT_ID: &str = "/proc/sys/kernel/random/boot_id";

/// The owner's boot settings in `config.json` (`boot`). The Hub cannot change them.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct BootConfig {
    /// `auto` (default: systemd-boot, then GRUB, then UEFI), `systemd-boot`, `grub`, `uefi`,
    /// `none`, or `fake` (with `fakePath`; tests and the E2E fake device).
    pub backend: Option<String>,
    pub fake_path: Option<String>,
    /// `grub.cfg` when it is not at /boot/grub/grub.cfg or /boot/grub2/grub.cfg; `grubenv` sits
    /// beside it.
    pub grub_cfg: Option<String>,
    /// Where `/sys/firmware/efi` is (tests).
    pub efi_dir: Option<String>,
}

// ---------------------------------------------------------------------------------------------
// Tools: OS commands through the hardened helper
// ---------------------------------------------------------------------------------------------

/// Where OS tools are looked up (absolute folders only; tests point it at fake commands).
#[derive(Debug, Clone)]
pub struct Tools {
    pub dirs: Vec<PathBuf>,
}

impl Default for Tools {
    fn default() -> Self {
        Tools { dirs: ["/usr/sbin", "/usr/bin", "/sbin", "/bin", "/usr/local/sbin", "/usr/local/bin"].iter().map(PathBuf::from).collect() }
    }
}

/// What a command printed.
#[derive(Debug, Clone, PartialEq)]
pub struct Output {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

impl Output {
    pub fn ok(&self) -> bool {
        self.code == Some(0)
    }
}

impl Tools {
    /// The first of `names` found as a file in the tool folders.
    pub fn find(&self, names: &[&str]) -> Option<PathBuf> {
        names.iter().flat_map(|n| self.dirs.iter().map(move |d| d.join(n))).find(|p| p.is_file())
    }

    /// Run the first of `names` with `args` (an argument vector, no shell), within `timeout_ms`.
    pub fn run(&self, names: &[&str], args: &[&str], timeout_ms: u64) -> OpResult<Output> {
        let prog = self.find(names).ok_or_else(|| OpError::new(409, "capability_missing", format!("{} is not installed", names[0])).with(json!({ "reason": "tool_missing", "tool": names[0] })))?;
        let spec = ExecSpec { cmd: prog.to_string_lossy().to_string(), args: args.iter().map(|a| a.to_string()).collect(), cwd: None, env: vec![], timeout_ms, stdin: None };
        let mut tries = 0;
        let r = loop {
            let mut cmd = std::process::Command::new(&prog);
            cmd.args(args).current_dir("/");
            match run_command(cmd, &spec) {
                // A program just written can be busy for a moment while another thread forks.
                Err(e) if e.message.contains("os error 26") && tries < 5 => {
                    tries += 1;
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(e) => return Err(OpError::internal(format!("{} could not run: {}", names[0], e.message))),
                Ok(r) => break r,
            }
        };
        if r["timedOut"].as_bool() == Some(true) {
            return Err(OpError::internal(format!("{} did not finish within {} s", names[0], timeout_ms / 1000)).with(json!({ "reason": "tool_timeout" })));
        }
        Ok(Output { code: r["exitCode"].as_i64().map(|c| c as i32), stdout: r["stdout"].as_str().unwrap_or_default().into(), stderr: r["stderr"].as_str().unwrap_or_default().into() })
    }

    /// `run` that turns a non-zero exit into an error naming the command.
    pub fn run_ok(&self, names: &[&str], args: &[&str]) -> OpResult<String> {
        let out = self.run(names, args, TOOL_TIMEOUT_MS)?;
        if !out.ok() {
            let why: String = out.stderr.trim().chars().take(300).collect();
            return Err(OpError::internal(format!("{} {} failed: {why}", names[0], args.join(" "))).with(json!({ "reason": "tool_failed", "tool": names[0] })));
        }
        Ok(out.stdout)
    }
}

// ---------------------------------------------------------------------------------------------
// Reboot, watchdog marker, event outbox (shared with firmware.rs)
// ---------------------------------------------------------------------------------------------

/// Asks the machine to restart.
pub trait Rebooter: Send + Sync {
    /// Whether a restart would be carried out (checked before anything is changed).
    fn check(&self) -> OpResult<()>;
    fn reboot(&self) -> OpResult<()>;
}

/// The restart of the management module's power actions (FR-144): it needs the owner's
/// `power.allowActions`, like every restart novad makes.
pub struct PowerReboot(pub crate::supervisor::Supervisor);

impl Rebooter for PowerReboot {
    fn check(&self) -> OpResult<()> {
        let s = self.0.call("management", "power.status", json!({}), Duration::from_secs(5))?;
        if s["actionsAllowed"].as_bool() != Some(true) {
            return Err(OpError::conflict("restarting needs power actions on in this device's novad config (power.allowActions)").with(json!({ "reason": "reboot_unavailable" })));
        }
        Ok(())
    }

    fn reboot(&self) -> OpResult<()> {
        self.0.call("management", "power.action", json!({ "action": "restart" }), Duration::from_secs(30)).map(|_| ())
    }
}

/// Restart after `delay` on its own thread. A refused restart leaves the watchdog marker of this
/// boot in place: at its deadline the change is reverted without a restart (`not_restarted`).
pub fn schedule_reboot(rebooter: Arc<dyn Rebooter>, delay: Duration) {
    std::thread::spawn(move || {
        std::thread::sleep(delay);
        if let Err(e) = rebooter.reboot() {
            eprintln!("novad: the restart was refused: {e}");
        }
    });
}

/// This boot's id, so a marker can tell a machine restart from a novad restart.
pub fn boot_id(path: &Path) -> Option<String> {
    std::fs::read_to_string(path).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// A watchdog marker (`firmware/pending.json`, `boot/pending.json`).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Pending {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entry_id: Option<String>,
    /// The authorization's change id (a boot profile is reused, a change never is).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub change_id: Option<String>,
    pub deadline: String,
    pub deadline_ms: u64,
    /// The boot the change was made in; None where the OS has no boot id.
    pub boot_id: Option<String>,
    pub reboot: bool,
    pub at: String,
}

impl Pending {
    pub fn id(&self) -> String {
        self.snapshot_id.clone().or_else(|| self.change_id.clone()).or_else(|| self.profile_id.clone()).unwrap_or_default()
    }
}

/// The marker on disk, and whether it was armed at start (the machine restarted since).
pub struct Watch {
    pub dir: PathBuf,
    pub boot_id_path: PathBuf,
    armed: Mutex<Option<Pending>>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Done {
    ids: Vec<String>,
}

impl Watch {
    pub fn new(dir: PathBuf) -> Watch {
        Watch { dir, boot_id_path: PathBuf::from(BOOT_ID), armed: Mutex::new(None) }
    }

    fn path(&self) -> PathBuf {
        self.dir.join("pending.json")
    }

    pub fn pending(&self) -> Option<Pending> {
        read_json_or::<Option<Pending>>(&self.path(), None).ok().flatten()
    }

    pub fn current_boot(&self) -> Option<String> {
        boot_id(&self.boot_id_path)
    }

    /// A new marker, unless the watchdog already reverted this id once (never loops).
    pub fn write(&self, p: &Pending) -> OpResult<bool> {
        if self.was_done(&p.id()) {
            return Ok(false);
        }
        std::fs::create_dir_all(&self.dir)?;
        write_json(&self.path(), p, true)?;
        Ok(true)
    }

    pub fn clear(&self) {
        let _ = std::fs::remove_file(self.path());
        *self.armed.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }

    /// At start: a marker from an earlier boot is armed; one from this boot (only novad
    /// restarted) waits, and one the watchdog already handled is dropped.
    pub fn on_start(&self) {
        let Some(p) = self.pending() else { return };
        if self.was_done(&p.id()) {
            self.clear();
            return;
        }
        let same_boot = p.boot_id.is_some() && p.boot_id == self.current_boot();
        if !same_boot {
            *self.armed.lock().unwrap_or_else(|e| e.into_inner()) = Some(p);
        }
    }

    pub fn armed(&self) -> Option<Pending> {
        self.armed.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    /// The marker of this boot past its deadline: the restart it guarded never happened.
    pub fn stale(&self, now: u64) -> Option<Pending> {
        if self.armed().is_some() {
            return None;
        }
        self.pending().filter(|p| now > p.deadline_ms && p.boot_id.is_some() && p.boot_id == self.current_boot())
    }

    fn done_path(&self) -> PathBuf {
        self.dir.join("watchdog-done.json")
    }

    pub fn was_done(&self, id: &str) -> bool {
        read_json_or::<Done>(&self.done_path(), Done::default()).map(|d| d.ids.iter().any(|x| x == id)).unwrap_or(false)
    }

    pub fn mark_done(&self, id: &str) {
        let mut d = read_json_or::<Done>(&self.done_path(), Done::default()).unwrap_or_default();
        d.ids.push(id.to_string());
        let n = d.ids.len().saturating_sub(50);
        d.ids.drain(..n);
        let _ = write_json(&self.done_path(), &d, true);
    }
}

/// Events for the Hub that must survive a restart (`<dir>/events.json`): taken into a heartbeat
/// and removed once the Hub accepted it.
pub struct Outbox {
    pub path: PathBuf,
    lock: Mutex<()>,
}

impl Outbox {
    pub fn new(path: PathBuf) -> Outbox {
        Outbox { path, lock: Mutex::new(()) }
    }

    pub fn push(&self, event: Value) {
        let _g = self.lock.lock().unwrap_or_else(|p| p.into_inner());
        let mut all: Vec<Value> = read_json_or(&self.path, vec![]).unwrap_or_default();
        all.push(event);
        let n = all.len().saturating_sub(100);
        all.drain(..n);
        if let Some(dir) = self.path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Err(e) = write_json(&self.path, &all, true) {
            eprintln!("novad: cannot keep an event for the Hub: {e}");
        }
    }

    pub fn pending(&self) -> Vec<Value> {
        let _g = self.lock.lock().unwrap_or_else(|p| p.into_inner());
        read_json_or(&self.path, vec![]).unwrap_or_default()
    }

    /// Drop the events a heartbeat delivered.
    pub fn ack(&self, sent: &[Value]) {
        let _g = self.lock.lock().unwrap_or_else(|p| p.into_inner());
        let mut all: Vec<Value> = read_json_or(&self.path, vec![]).unwrap_or_default();
        all.retain(|e| !sent.contains(e));
        let _ = write_json(&self.path, &all, true);
    }
}

/// `watchdogSeconds` from a body: 600 when absent, else 120-3600.
pub fn watchdog_seconds(body: &Value) -> OpResult<u64> {
    match &body["watchdogSeconds"] {
        Value::Null => Ok(WATCHDOG_DEFAULT_S),
        v => v.as_u64().filter(|s| (WATCHDOG_MIN_S..=WATCHDOG_MAX_S).contains(s)).ok_or_else(|| OpError::validation("watchdogSeconds must be 120 to 3600")),
    }
}

/// Hardware or a system novad does not manage: 409 `conflict` `{reason: unsupported_hardware,
/// detail}` (the read routes answer `{supported: false, reason: detail}`).
pub fn unsupported(detail: &str, message: &str) -> OpError {
    OpError::conflict(message).with(json!({ "reason": "unsupported_hardware", "detail": detail }))
}

/// The `detail` of an `unsupported` refusal.
pub fn unsupported_detail(e: &OpError) -> &str {
    e.details.as_ref().and_then(|d| d["detail"].as_str()).unwrap_or("unsupported")
}

// ---------------------------------------------------------------------------------------------
// Bootloaders
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub title: String,
    pub is_default: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct State {
    pub entries: Vec<Entry>,
    /// The entry this boot started from, where the bootloader tells (GRUB does not).
    pub booted: Option<String>,
}

pub trait Bootloader: Send + Sync {
    fn name(&self) -> &'static str;
    fn state(&self) -> OpResult<State>;
    fn set_oneshot(&self, id: &str) -> OpResult<()>;
    fn clear_oneshot(&self) -> OpResult<()>;
    fn set_default(&self, id: &str) -> OpResult<()>;
    /// For a bootloader that cannot name the booted entry: whether this boot was the one-shot
    /// into `entry` (Some(false): it was not), None when it cannot tell.
    fn verify(&self, _entry: &str) -> Option<bool> {
        None
    }
    /// Whether `set_default` would take effect; Err says why not.
    fn check_commit(&self) -> OpResult<()> {
        Ok(())
    }
}

/// systemd-boot through `bootctl`.
pub struct SystemdBoot(pub Tools);

const BOOTCTL: &[&str] = &["bootctl"];

impl Bootloader for SystemdBoot {
    fn name(&self) -> &'static str {
        "systemd-boot"
    }
    fn state(&self) -> OpResult<State> {
        let out = self.0.run_ok(BOOTCTL, &["--no-pager", "list", "--json=short"])?;
        parse_bootctl(&out)
    }
    fn set_oneshot(&self, id: &str) -> OpResult<()> {
        self.0.run_ok(BOOTCTL, &["set-oneshot", id]).map(|_| ())
    }
    fn clear_oneshot(&self) -> OpResult<()> {
        self.0.run_ok(BOOTCTL, &["set-oneshot", ""]).map(|_| ())
    }
    fn set_default(&self, id: &str) -> OpResult<()> {
        self.0.run_ok(BOOTCTL, &["set-default", id]).map(|_| ())
    }
}

/// `bootctl list --json=short`: entries with `id`, `title`/`showTitle`, `isDefault`, `isSelected`
/// (the entry this boot started from).
pub fn parse_bootctl(text: &str) -> OpResult<State> {
    let v: Value = serde_json::from_str(text.trim()).map_err(|e| OpError::internal(format!("bootctl answered something unexpected: {e}")))?;
    let list = v.as_array().ok_or_else(|| OpError::internal("bootctl answered something unexpected"))?;
    let mut entries = vec![];
    let mut booted = None;
    for e in list {
        let Some(id) = e["id"].as_str().filter(|s| !s.is_empty()) else { continue };
        let title = e["showTitle"].as_str().or(e["title"].as_str()).unwrap_or(id).to_string();
        if e["isSelected"].as_bool() == Some(true) {
            booted = Some(id.to_string());
        }
        entries.push(Entry { id: id.to_string(), title, is_default: e["isDefault"].as_bool() == Some(true) });
    }
    Ok(State { entries, booted })
}

/// GRUB through `grub-reboot`, `grub-set-default` and `grub-editenv` (or their `grub2-` names);
/// entries from `grub.cfg`, the default from `grubenv`.
pub struct Grub {
    pub tools: Tools,
    pub cfg: PathBuf,
    /// The kernel command line of this boot (`/proc/cmdline`): `BOOT_IMAGE=` names the kernel.
    pub cmdline: PathBuf,
}

/// How grub.cfg picks its default: `saved_entry` (GRUB_DEFAULT=saved) or a fixed entry.
#[derive(Debug, Clone, PartialEq)]
pub enum GrubDefault {
    Saved,
    Fixed(String),
}

/// The `set default=` of a generated grub.cfg (the one-shot's `${next_entry}` aside); `0` when
/// none is set, as GRUB does.
pub fn grub_default(cfg: &str) -> GrubDefault {
    let mut found = None;
    for line in cfg.lines() {
        let Some(v) = line.trim().strip_prefix("set default=") else { continue };
        let v = v.trim().trim_matches('"').trim_matches('\'');
        if v.contains("${next_entry}") {
            continue;
        }
        found = Some(if v.contains("${saved_entry}") { GrubDefault::Saved } else { GrubDefault::Fixed(v.to_string()) });
    }
    found.unwrap_or(GrubDefault::Fixed("0".into()))
}

/// The kernel file a command line booted (`BOOT_IMAGE=(hd0,gpt2)/vmlinuz-6.8.0` gives
/// `vmlinuz-6.8.0`).
fn boot_image(cmdline: &str) -> Option<String> {
    let v = cmdline.split_whitespace().find_map(|w| w.strip_prefix("BOOT_IMAGE="))?;
    v.rsplit('/').next().filter(|f| !f.is_empty()).map(str::to_string)
}

const GRUB_REBOOT: &[&str] = &["grub-reboot", "grub2-reboot"];
const GRUB_SET_DEFAULT: &[&str] = &["grub-set-default", "grub2-set-default"];
const GRUB_EDITENV: &[&str] = &["grub-editenv", "grub2-editenv"];

impl Grub {
    fn env_path(&self) -> PathBuf {
        self.cfg.with_file_name("grubenv")
    }
}

impl Bootloader for Grub {
    fn name(&self) -> &'static str {
        "grub"
    }
    fn state(&self) -> OpResult<State> {
        let text = std::fs::read_to_string(&self.cfg).map_err(|e| OpError::internal(format!("cannot read {}: {e}", self.cfg.display())))?;
        let env = std::fs::read_to_string(self.env_path()).unwrap_or_default();
        let saved = parse_grubenv(&env).into_iter().find(|(k, _)| k == "saved_entry").map(|(_, v)| v);
        let mut entries = parse_grub_cfg(&text);
        // What GRUB will boot by default: `saved_entry` only when grub.cfg uses it.
        let default = match grub_default(&text) {
            GrubDefault::Saved => saved.unwrap_or_default(),
            GrubDefault::Fixed(v) => v,
        };
        let at_index = |n: usize| entries.iter().position(|e| e.index == Some(n));
        let default_at = match default.as_str() {
            "" => at_index(0),
            s if s.bytes().all(|b| b.is_ascii_digit()) => s.parse::<usize>().ok().and_then(at_index),
            s => entries.iter().position(|e| e.entry.id == s || e.entry.title == s || e.title_path == s),
        };
        if let Some(i) = default_at
            && let Some(e) = entries.get_mut(i)
        {
            e.entry.is_default = true;
        }
        Ok(State { entries: entries.into_iter().map(|e| e.entry).collect(), booted: None })
    }
    fn verify(&self, entry: &str) -> Option<bool> {
        // GRUB clears `next_entry` when it boots the one-shot; still set, it never did.
        let env = std::fs::read_to_string(self.env_path()).ok()?;
        if parse_grubenv(&env).iter().any(|(k, v)| k == "next_entry" && !v.is_empty()) {
            return Some(false);
        }
        // Consumed: the kernel this boot started must be the entry's, when both are known.
        let kernel = std::fs::read_to_string(&self.cfg).ok().and_then(|t| parse_grub_cfg(&t).into_iter().find(|e| e.entry.id == entry)).and_then(|e| e.kernel);
        let booted = std::fs::read_to_string(&self.cmdline).ok().and_then(|c| boot_image(&c));
        match (kernel.as_deref().and_then(|k| k.rsplit('/').next()), booted) {
            (Some(k), Some(b)) => Some(k == b),
            _ => Some(true),
        }
    }
    fn check_commit(&self) -> OpResult<()> {
        let text = std::fs::read_to_string(&self.cfg).map_err(|e| OpError::internal(format!("cannot read {}: {e}", self.cfg.display())))?;
        if grub_default(&text) != GrubDefault::Saved {
            return Err(OpError::conflict("GRUB boots a fixed default on this machine, so grub-set-default would change nothing: set GRUB_DEFAULT=saved in /etc/default/grub and run update-grub (or grub2-mkconfig) first").with(json!({ "reason": "grub_default_not_saved" })));
        }
        Ok(())
    }
    fn set_oneshot(&self, id: &str) -> OpResult<()> {
        self.tools.run_ok(GRUB_REBOOT, &[id]).map(|_| ())
    }
    fn clear_oneshot(&self) -> OpResult<()> {
        let env = self.env_path().to_string_lossy().to_string();
        self.tools.run_ok(GRUB_EDITENV, &[&env, "unset", "next_entry"]).map(|_| ())
    }
    fn set_default(&self, id: &str) -> OpResult<()> {
        self.tools.run_ok(GRUB_SET_DEFAULT, &[id]).map(|_| ())
    }
}

/// `key=value` lines of a GRUB environment block.
pub fn parse_grubenv(text: &str) -> Vec<(String, String)> {
    text.lines().filter(|l| !l.starts_with('#')).filter_map(|l| l.split_once('=')).map(|(k, v)| (k.to_string(), v.to_string())).collect()
}

/// Shell-like words of a grub.cfg line: quotes ('…', "…") and backslash escapes, as grub-mkconfig
/// writes them (a quote inside a title is `'\''`).
fn words(line: &str) -> Vec<String> {
    let mut out = vec![];
    let mut cur = String::new();
    let mut has = false;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\'' => {
                has = true;
                for d in chars.by_ref() {
                    if d == '\'' {
                        break;
                    }
                    cur.push(d);
                }
            }
            '"' => {
                has = true;
                while let Some(d) = chars.next() {
                    match d {
                        '"' => break,
                        '\\' => {
                            if let Some(e) = chars.next() {
                                cur.push(e);
                            }
                        }
                        _ => cur.push(d),
                    }
                }
            }
            '\\' => {
                has = true;
                if let Some(e) = chars.next() {
                    cur.push(e);
                }
            }
            c if c.is_whitespace() => {
                if has {
                    out.push(std::mem::take(&mut cur));
                    has = false;
                }
            }
            c => {
                has = true;
                cur.push(c);
            }
        }
    }
    if has {
        out.push(cur);
    }
    out
}

/// A menu entry of grub.cfg.
#[derive(Debug, Clone, PartialEq)]
pub struct GrubEntry {
    /// The id is the path `grub-reboot` takes (`submenu>entry`, by ids where the config gives
    /// them).
    pub entry: Entry,
    /// The same path by titles.
    pub title_path: String,
    /// A top-level entry's menu index (submenus count, as in GRUB's numbering).
    pub index: Option<usize>,
    /// The kernel its `linux` line loads.
    pub kernel: Option<String>,
}

/// The menu entries of a generated grub.cfg. Blocks open with a header line ending in `{` and
/// close with a line holding only `}`, as grub-mkconfig writes them.
pub fn parse_grub_cfg(text: &str) -> Vec<GrubEntry> {
    // (kind, id path part, title path part) per open block.
    let mut stack: Vec<(&str, String, String)> = vec![];
    let mut out: Vec<GrubEntry> = vec![];
    // The entry whose block is open, for its `linux` line.
    let mut open: Option<usize> = None;
    let mut top = 0usize;
    for line in text.lines() {
        let t = line.trim();
        if t == "}" {
            if stack.pop().is_some_and(|s| s.0 == "menuentry") {
                open = None;
            }
            continue;
        }
        if !t.ends_with('{') {
            let w = words(t);
            if let (Some(i), Some("linux" | "linuxefi" | "linux16")) = (open, w.first().map(String::as_str))
                && out[i].kernel.is_none()
            {
                out[i].kernel = w.get(1).cloned();
            }
            continue;
        }
        let w = words(t);
        let kind = match w.first().map(String::as_str) {
            Some("menuentry") => "menuentry",
            Some("submenu") => "submenu",
            _ => {
                stack.push(("other", String::new(), String::new()));
                continue;
            }
        };
        let title = w.get(1).cloned().unwrap_or_default();
        let id = w
            .iter()
            .position(|x| x == "$menuentry_id_option" || x == "--id")
            .and_then(|i| w.get(i + 1).cloned())
            .or_else(|| w.iter().find_map(|x| x.strip_prefix("--id=").map(str::to_string)))
            .unwrap_or_else(|| title.clone());
        let parents: Vec<&(&str, String, String)> = stack.iter().filter(|s| s.0 == "submenu").collect();
        let inside_entry = stack.iter().any(|s| s.0 == "menuentry");
        let top_level = stack.iter().all(|s| s.0 == "other");
        let index = top_level.then(|| {
            top += 1;
            top - 1
        });
        if kind == "menuentry" && !inside_entry && !title.is_empty() {
            let id_path: Vec<String> = parents.iter().map(|s| s.1.clone()).chain(std::iter::once(id.clone())).collect();
            let title_path: Vec<String> = parents.iter().map(|s| s.2.clone()).chain(std::iter::once(title.clone())).collect();
            out.push(GrubEntry { entry: Entry { id: id_path.join(">"), title: title_path.join(" > "), is_default: false }, title_path: title_path.join(">"), index, kernel: None });
            open = Some(out.len() - 1);
        }
        stack.push((kind, id, title));
    }
    out
}

/// UEFI boot entries through `efibootmgr`: a one-shot is `BootNext`, the default the head of
/// `BootOrder`.
pub struct Uefi(pub Tools);

pub const EFIBOOTMGR: &[&str] = &["efibootmgr"];

/// What `efibootmgr [-v]` prints: `BootCurrent`, `BootNext`, `BootOrder` and the entries.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct EfiBoot {
    pub current: Option<String>,
    pub next: Option<String>,
    pub order: Vec<String>,
    pub entries: Vec<(String, String)>,
}

pub fn parse_efibootmgr(text: &str) -> EfiBoot {
    let mut b = EfiBoot::default();
    for line in text.lines() {
        if let Some(v) = line.strip_prefix("BootCurrent:") {
            b.current = Some(v.trim().to_ascii_uppercase());
        } else if let Some(v) = line.strip_prefix("BootNext:") {
            b.next = Some(v.trim().to_ascii_uppercase());
        } else if let Some(v) = line.strip_prefix("BootOrder:") {
            b.order = v.split(',').map(|s| s.trim().to_ascii_uppercase()).filter(|s| is_boot_num(s)).collect();
        } else if let Some(rest) = line.strip_prefix("Boot") {
            let (num, tail) = rest.split_at(rest.len().min(4));
            if !is_boot_num(num) {
                continue;
            }
            let tail = tail.strip_prefix('*').unwrap_or(tail);
            let title = tail.split('\t').next().unwrap_or_default().trim().to_string();
            b.entries.push((num.to_ascii_uppercase(), title));
        }
    }
    b
}

pub fn is_boot_num(s: &str) -> bool {
    s.len() == 4 && s.bytes().all(|c| c.is_ascii_hexdigit())
}

impl Uefi {
    fn read(&self) -> OpResult<EfiBoot> {
        Ok(parse_efibootmgr(&self.0.run_ok(EFIBOOTMGR, &["-v"])?))
    }
}

impl Bootloader for Uefi {
    fn name(&self) -> &'static str {
        "uefi"
    }
    fn state(&self) -> OpResult<State> {
        let b = self.read()?;
        let head = b.order.first().cloned();
        let entries = b.entries.iter().map(|(id, title)| Entry { id: id.clone(), title: title.clone(), is_default: Some(id) == head.as_ref() }).collect();
        Ok(State { entries, booted: b.current })
    }
    fn set_oneshot(&self, id: &str) -> OpResult<()> {
        self.0.run_ok(EFIBOOTMGR, &["--bootnext", id]).map(|_| ())
    }
    fn clear_oneshot(&self) -> OpResult<()> {
        if self.read()?.next.is_none() {
            return Ok(());
        }
        self.0.run_ok(EFIBOOTMGR, &["--delete-bootnext"]).map(|_| ())
    }
    fn set_default(&self, id: &str) -> OpResult<()> {
        let b = self.read()?;
        let order: Vec<String> = std::iter::once(id.to_ascii_uppercase()).chain(b.order.into_iter().filter(|x| !x.eq_ignore_ascii_case(id))).collect();
        self.0.run_ok(EFIBOOTMGR, &["--bootorder", &order.join(",")]).map(|_| ())
    }
}

/// The fake bootloader: a JSON file `{entries: [{id, title}], default, booted, oneshot,
/// failSet?}`; `booted` is what a test sets to play a restart.
pub struct FakeBoot(pub PathBuf);

impl FakeBoot {
    fn load(&self) -> OpResult<Value> {
        read_json_or(&self.0, Value::Null).map_err(|e| OpError::internal(e.to_string())).and_then(|v| if v.is_object() { Ok(v) } else { Err(OpError::internal("the fake bootloader file is missing")) })
    }
    fn save(&self, v: &Value) -> OpResult<()> {
        write_json(&self.0, v, false).map_err(OpError::from)
    }
    fn update(&self, f: impl FnOnce(&mut Value) -> OpResult<()>) -> OpResult<()> {
        let mut v = self.load()?;
        f(&mut v)?;
        self.save(&v)
    }
}

impl Bootloader for FakeBoot {
    fn name(&self) -> &'static str {
        "fake"
    }
    fn state(&self) -> OpResult<State> {
        let v = self.load()?;
        let entries = v["entries"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|e| {
                let id = e["id"].as_str()?.to_string();
                Some(Entry { title: e["title"].as_str().unwrap_or(&id).to_string(), is_default: v["default"].as_str() == Some(id.as_str()), id })
            })
            .collect();
        Ok(State { entries, booted: v["booted"].as_str().map(str::to_string) })
    }
    fn set_oneshot(&self, id: &str) -> OpResult<()> {
        self.update(|v| {
            if v["failSet"].as_bool() == Some(true) {
                return Err(OpError::internal("the fake bootloader refused"));
            }
            v["oneshot"] = json!(id);
            Ok(())
        })
    }
    fn clear_oneshot(&self) -> OpResult<()> {
        self.update(|v| {
            v["oneshot"] = Value::Null;
            Ok(())
        })
    }
    fn set_default(&self, id: &str) -> OpResult<()> {
        self.update(|v| {
            v["default"] = json!(id);
            Ok(())
        })
    }
}

// ---------------------------------------------------------------------------------------------
// The boot area
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Last {
    pub profile_id: String,
    pub entry_id: String,
    /// `ok`, `reverted` or `failed`.
    pub result: String,
    pub at: String,
    /// For `ok`: whether the boot was seen to be the one-shot (GRUB can only infer it).
    pub verified: Option<bool>,
}

pub struct Boot {
    pub data: DataDir,
    pub tools: Tools,
    pub rebooter: Arc<dyn Rebooter>,
    pub watch: Watch,
    pub outbox: Outbox,
    pub reboot_delay: Duration,
    /// Low-level boot is built for Linux only.
    pub os_supported: bool,
    /// `/proc/cmdline` (tests point it elsewhere).
    pub cmdline: PathBuf,
    /// One change at a time.
    lock: Mutex<()>,
}

impl Boot {
    pub fn new(data: DataDir, rebooter: Arc<dyn Rebooter>) -> Boot {
        let dir = data.path().join("boot");
        Boot {
            watch: Watch::new(dir.clone()),
            outbox: Outbox::new(dir.join("events.json")),
            data,
            tools: Tools::default(),
            rebooter,
            reboot_delay: REBOOT_DELAY,
            os_supported: cfg!(target_os = "linux"),
            cmdline: PathBuf::from("/proc/cmdline"),
            lock: Mutex::new(()),
        }
    }

    fn dir(&self) -> PathBuf {
        self.data.path().join("boot")
    }

    /// The bootloader of this machine, or why there is none to manage.
    pub fn loader(&self) -> Result<Box<dyn Bootloader>, OpError> {
        if !self.os_supported {
            return Err(unsupported("os_not_supported", "low-level boot is built for Linux only"));
        }
        let cfg = self.data.config()?.boot;
        let efi = PathBuf::from(cfg.efi_dir.clone().unwrap_or_else(|| "/sys/firmware/efi".into()));
        let grub_cfg = || -> Option<PathBuf> {
            match &cfg.grub_cfg {
                Some(p) => Some(PathBuf::from(p)),
                None => ["/boot/grub/grub.cfg", "/boot/grub2/grub.cfg"].iter().map(PathBuf::from).find(|p| p.is_file()),
            }
        };
        let systemd = || self.tools.run(BOOTCTL, &["--no-pager", "is-installed"], TOOL_TIMEOUT_MS).is_ok_and(|o| o.ok());
        let grub = || grub_cfg().filter(|p| p.is_file() && self.tools.find(GRUB_REBOOT).is_some()).map(|cfg| Grub { tools: self.tools.clone(), cfg, cmdline: self.cmdline.clone() });
        let uefi = || efi.is_dir() && self.tools.find(EFIBOOTMGR).is_some();
        let none = || unsupported("no_bootloader", "no bootloader novad can manage was found (systemd-boot, GRUB or UEFI boot entries)");
        match cfg.backend.as_deref().unwrap_or("auto") {
            "fake" => {
                let path = cfg.fake_path.clone().ok_or_else(|| OpError::internal("boot.backend is fake but boot.fakePath is not set"))?;
                Ok(Box::new(FakeBoot(PathBuf::from(path))))
            }
            "none" => Err(unsupported("disabled_by_owner", "the device owner turned boot management off in novad's config")),
            "systemd-boot" if systemd() => Ok(Box::new(SystemdBoot(self.tools.clone()))),
            "grub" => grub().map(|g| Box::new(g) as Box<dyn Bootloader>).ok_or_else(none),
            "uefi" if uefi() => Ok(Box::new(Uefi(self.tools.clone()))),
            "auto" => {
                if systemd() {
                    Ok(Box::new(SystemdBoot(self.tools.clone())))
                } else if let Some(g) = grub() {
                    Ok(Box::new(g))
                } else if uefi() {
                    Ok(Box::new(Uefi(self.tools.clone())))
                } else {
                    Err(none())
                }
            }
            _ => Err(none()),
        }
    }

    fn last(&self) -> Option<Last> {
        read_json_or::<Option<Last>>(&self.dir().join("last.json"), None).ok().flatten()
    }

    fn set_last(&self, profile_id: &str, entry_id: &str, result: &str, now: u64, verified: Option<bool>) {
        let _ = std::fs::create_dir_all(self.dir());
        let _ = write_json(&self.dir().join("last.json"), &Last { profile_id: profile_id.into(), entry_id: entry_id.into(), result: result.into(), at: iso(now), verified }, true);
    }

    fn pending_json(&self) -> Value {
        match self.watch.pending() {
            Some(p) => json!({ "profileId": p.profile_id, "entryId": p.entry_id, "deadline": p.deadline }),
            None => Value::Null,
        }
    }

    fn last_json(&self) -> Value {
        self.last().map(|l| json!({ "profileId": l.profile_id, "entryId": l.entry_id, "result": l.result, "at": l.at, "verified": l.verified })).unwrap_or(Value::Null)
    }

    /// `boot/status`: readable whatever the policy.
    pub fn status(&self) -> OpResult<Value> {
        let (pending, last) = (self.pending_json(), self.last_json());
        match self.loader() {
            Ok(l) => {
                let s = l.state()?;
                Ok(json!({ "supported": true, "bootloader": l.name(), "entries": s.entries, "booted": s.booted, "pending": pending, "last": last }))
            }
            Err(e) => Ok(json!({
                "supported": false,
                "reason": unsupported_detail(&e),
                "bootloader": "none", "entries": [], "booted": null, "pending": pending, "last": last,
            })),
        }
    }

    /// One management route under `/agent/v1/boot/`.
    pub fn route(&self, op: &str, body: &Value, transport: Transport) -> OpResult<Value> {
        match op {
            "status" => self.status(),
            "set" => self.set(body, transport, now_ms()),
            "commit" => self.commit(body, transport),
            "revert" => self.revert(body, transport, now_ms()),
            _ => Err(OpError::not_found("unknown boot route")),
        }
    }

    fn require_low_level(&self) -> OpResult<()> {
        if !self.data.privileged_policy().low_level_boot {
            return Err(OpError::denied("low_level_boot_off", "low-level boot is off on the Hub (devices.boot.allowLowLevel)"));
        }
        Ok(())
    }

    fn entry(state: &State, body: &Value) -> OpResult<String> {
        let id = body["entryId"].as_str().filter(|s| !s.is_empty() && s.len() <= 300).ok_or_else(|| OpError::validation("entryId is required"))?;
        if !state.entries.iter().any(|e| e.id == id) {
            return Err(OpError::validation(format!("no boot entry {id} on this device")).with(json!({ "reason": "unknown_entry" })));
        }
        Ok(id.to_string())
    }

    fn profile(body: &Value) -> OpResult<String> {
        body["profileId"].as_str().filter(|s| !s.is_empty() && s.len() <= 200).map(str::to_string).ok_or_else(|| OpError::validation("profileId is required"))
    }

    /// `boot/set`: a one-shot next boot with a watchdog.
    pub fn set(&self, body: &Value, transport: Transport, now: u64) -> OpResult<Value> {
        let loader = self.loader()?;
        self.require_low_level()?;
        let auth = authz::authorize_at(&self.data, "boot.set", body, transport, now)?;
        let _g = self.lock.lock().unwrap_or_else(|p| p.into_inner());
        let profile = Self::profile(body)?;
        let seconds = watchdog_seconds(body)?;
        let reboot = match &body["reboot"] {
            Value::Bool(b) => *b,
            Value::Null => false,
            _ => return Err(OpError::validation("reboot must be true or false")),
        };
        let entry = Self::entry(&loader.state()?, body)?;
        if self.watch.pending().is_some() {
            return Err(OpError::conflict("a boot change is already pending; revert it first").with(json!({ "reason": "boot_pending" })));
        }
        if reboot {
            self.rebooter.check()?;
        }
        // The marker first: a one-shot is never set without its watchdog.
        let deadline_ms = now + seconds * 1000;
        let p = Pending { profile_id: Some(profile), entry_id: Some(entry.clone()), change_id: Some(auth.change_id), deadline: iso(deadline_ms), deadline_ms, boot_id: self.watch.current_boot(), reboot, at: iso(now), ..Default::default() };
        self.watch.write(&p)?;
        if let Err(e) = loader.set_oneshot(&entry) {
            self.watch.clear();
            return Err(e);
        }
        if reboot {
            schedule_reboot(self.rebooter.clone(), self.reboot_delay);
        }
        Ok(json!({ "pending": { "profileId": p.profile_id, "entryId": p.entry_id, "deadline": p.deadline } }))
    }

    /// `boot/commit`: make an entry the default.
    pub fn commit(&self, body: &Value, transport: Transport) -> OpResult<Value> {
        let loader = self.loader()?;
        self.require_low_level()?;
        loader.check_commit()?;
        authz::authorize(&self.data, "boot.commit", body, transport)?;
        let _g = self.lock.lock().unwrap_or_else(|p| p.into_inner());
        let profile = Self::profile(body)?;
        let entry = Self::entry(&loader.state()?, body)?;
        loader.set_default(&entry)?;
        Ok(json!({ "committed": { "profileId": profile, "entryId": entry }, "entries": loader.state()?.entries }))
    }

    /// `boot/revert`: clear a pending one-shot. Needs the authorization, never the policy.
    pub fn revert(&self, body: &Value, transport: Transport, now: u64) -> OpResult<Value> {
        let loader = self.loader()?;
        authz::authorize_at(&self.data, "boot.revert", body, transport, now)?;
        let _g = self.lock.lock().unwrap_or_else(|p| p.into_inner());
        loader.clear_oneshot()?;
        let pending = self.watch.pending();
        self.watch.clear();
        if let Some(p) = &pending {
            self.set_last(&p.profile_id.clone().unwrap_or_default(), &p.entry_id.clone().unwrap_or_default(), "reverted", now, None);
        }
        Ok(json!({ "reverted": pending.is_some(), "pending": null }))
    }

    pub fn on_start(&self) {
        self.watch.on_start();
    }

    fn event(&self, kind: &str, p: &Pending, now: u64, detail: Value) {
        self.outbox.push(json!({ "kind": kind, "profileId": p.profile_id, "entryId": p.entry_id, "changeId": p.change_id, "at": iso(now), "detail": detail }));
    }

    /// The Hub accepted a heartbeat: an armed marker on its entry before the deadline is ok.
    pub fn on_beat(&self, now: u64) {
        let Some(p) = self.watch.armed() else { return };
        if now > p.deadline_ms {
            return self.tick(now);
        }
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let entry = p.entry_id.clone().unwrap_or_default();
        let (booted, on_entry) = self.on_entry(&entry);
        match (&booted, on_entry) {
            (Some(b), Some(false)) => {
                // The one-shot did not take: the machine is on another entry already.
                let cleared = self.loader().and_then(|l| l.clear_oneshot());
                self.watch.clear();
                self.watch.mark_done(&p.id());
                self.set_last(p.profile_id.as_deref().unwrap_or_default(), &entry, "failed", now, Some(false));
                self.event("boot.watchdog.reverted", &p, now, json!({ "reason": "not_booted", "booted": b, "rebooted": false, "error": cleared.err().map(|e| e.message) }));
            }
            _ => {
                // Up and heard from. `verified: false` when the bootloader cannot show the boot
                // was the one-shot (GRUB with `next_entry` still set, or another kernel).
                let verified = on_entry == Some(true);
                self.watch.clear();
                self.set_last(p.profile_id.as_deref().unwrap_or_default(), &entry, "ok", now, Some(verified));
                self.event("boot.watchdog.ok", &p, now, json!({ "booted": booted, "verified": verified }));
            }
        }
    }

    /// The entry this boot started from, and whether it is `entry` (None: cannot tell).
    fn on_entry(&self, entry: &str) -> (Option<String>, Option<bool>) {
        let Ok(loader) = self.loader() else { return (None, None) };
        let booted = loader.state().ok().and_then(|s| s.booted);
        let on = match &booted {
            Some(b) => Some(b == entry),
            None => loader.verify(entry),
        };
        (booted, on)
    }

    /// Called often while novad runs: a deadline that passed without a confirmed boot reverts.
    pub fn tick(&self, now: u64) {
        let (p, restarted) = match (self.watch.armed(), self.watch.stale(now)) {
            (Some(p), _) if now > p.deadline_ms => (p, true),
            (None, Some(p)) => (p, false),
            _ => return,
        };
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        // Restart only a machine that is on the pending entry (or cannot tell): one already back
        // on another entry is left running.
        let (booted, on_entry) = self.on_entry(p.entry_id.as_deref().unwrap_or_default());
        let restart = restarted && on_entry != Some(false);
        let cleared = self.loader().and_then(|l| l.clear_oneshot());
        self.watch.clear();
        self.watch.mark_done(&p.id());
        self.set_last(p.profile_id.as_deref().unwrap_or_default(), p.entry_id.as_deref().unwrap_or_default(), "reverted", now, None);
        let reason = if restarted { "deadline" } else { "not_restarted" };
        self.event("boot.watchdog.reverted", &p, now, json!({ "reason": reason, "booted": booted, "rebooted": restart, "error": cleared.as_ref().err().map(|e| e.message.clone()) }));
        if restart {
            // Once, into the default; the marker is gone, so this never repeats.
            if let Err(e) = self.rebooter.reboot() {
                eprintln!("novad: the boot watchdog could not restart the machine: {e}");
            }
        }
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::authz::tests::{NOW, enrolled, signed};
    use crate::grants::tests::tmp;
    use crate::tls::tests::HUB_SEED;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::time::Instant;

    /// A restart that is counted, not made.
    #[derive(Default)]
    pub struct FakeReboot {
        pub refuse: AtomicBool,
        pub calls: AtomicUsize,
    }

    impl Rebooter for FakeReboot {
        fn check(&self) -> OpResult<()> {
            if self.refuse.load(Ordering::SeqCst) {
                return Err(OpError::conflict("power actions are off").with(json!({ "reason": "reboot_unavailable" })));
            }
            Ok(())
        }
        fn reboot(&self) -> OpResult<()> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.check()
        }
    }

    /// A fake command `name` in `dir`: appends its arguments to `<dir>/calls.log` and runs `body`.
    pub fn fake_tool(dir: &Path, name: &str, body: &str) {
        std::fs::create_dir_all(dir).unwrap();
        let log = dir.join("calls.log");
        let script = format!("#!/bin/sh\necho \"{name} $*\" >> '{}'\n{body}\n", log.display());
        let path = dir.join(name);
        std::fs::write(&path, script).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    pub fn calls(dir: &Path) -> Vec<String> {
        std::fs::read_to_string(dir.join("calls.log")).unwrap_or_default().lines().map(str::to_string).collect()
    }

    pub fn wait_for(f: impl Fn() -> bool) -> bool {
        for _ in 0..100 {
            if f() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }

    fn set_config(data: &DataDir, boot: Value) {
        let mut cfg = serde_json::to_value(data.config().unwrap()).unwrap();
        cfg["boot"] = boot;
        crate::util::write_json(&data.config_path(), &cfg, false).unwrap();
    }

    fn allow(data: &DataDir, on: bool) {
        data.save_privileged_policy(&json!({ "firmwareChanges": false, "lowLevelBoot": on })).unwrap();
    }

    /// A boot area on the fake bootloader with a fake boot id file.
    fn fake(name: &str) -> (PathBuf, Boot, Arc<FakeReboot>, PathBuf) {
        let (base, data) = enrolled(name);
        let file = base.join("bootloader.json");
        write_json(&file, &json!({ "entries": [{ "id": "debian.conf", "title": "Debian" }, { "id": "nova.conf", "title": "Nova image" }], "default": "debian.conf", "booted": "debian.conf", "oneshot": null }), false).unwrap();
        set_config(&data, json!({ "backend": "fake", "fakePath": file }));
        let reboot = Arc::new(FakeReboot::default());
        let mut b = Boot::new(data, reboot.clone());
        b.reboot_delay = Duration::from_millis(10);
        b.watch.boot_id_path = base.join("boot_id");
        std::fs::write(&b.watch.boot_id_path, "boot-1\n").unwrap();
        (base, b, reboot, file)
    }

    fn fake_file(file: &Path) -> Value {
        read_json_or(file, Value::Null).unwrap()
    }

    fn reason(e: &OpError) -> String {
        e.details.as_ref().and_then(|d| d["reason"].as_str()).unwrap_or(&e.code).to_string()
    }

    fn set_body(entry: &str, reboot: bool) -> Value {
        signed(&HUB_SEED, "boot.set", &json!({ "profileId": "lab", "entryId": entry, "watchdogSeconds": 600, "reboot": reboot }), NOW)
    }

    #[test]
    fn sets_a_one_shot_that_the_watchdog_confirms() {
        let (base, b, reboot, file) = fake("boot-ok");
        let st = b.status().unwrap();
        assert_eq!((st["supported"].as_bool(), st["bootloader"].as_str(), st["booted"].as_str()), (Some(true), Some("fake"), Some("debian.conf")));
        assert_eq!(st["entries"][0]["isDefault"], true);
        // Off on the Hub: refused even with a valid authorization (and the id is not spent).
        allow(&b.data, false);
        let body = set_body("nova.conf", true);
        assert_eq!(reason(&b.set(&body, Transport::Plain, NOW).unwrap_err()), "low_level_boot_off");
        allow(&b.data, true);
        let r = b.set(&body, Transport::Plain, NOW).unwrap();
        assert_eq!(r["pending"]["entryId"], "nova.conf");
        assert_eq!(r["pending"]["deadline"], iso(NOW + 600_000));
        assert_eq!(fake_file(&file)["oneshot"], "nova.conf");
        assert_eq!(fake_file(&file)["default"], "debian.conf", "a one-shot, never the default");
        assert!(wait_for(|| reboot.calls.load(Ordering::SeqCst) == 1), "one restart requested");
        // The same authorization again is a replay; a second change while one is pending is refused.
        assert_eq!(reason(&b.set(&body, Transport::Plain, NOW).unwrap_err()), "replayed");
        assert_eq!(reason(&b.set(&set_body("debian.conf", false), Transport::Plain, NOW).unwrap_err()), "boot_pending");
        // The machine restarts into the entry: armed at start, ok on the first accepted beat.
        std::fs::write(&b.watch.boot_id_path, "boot-2\n").unwrap();
        let mut f = fake_file(&file);
        f["booted"] = json!("nova.conf");
        f["oneshot"] = Value::Null;
        write_json(&file, &f, false).unwrap();
        b.on_start();
        assert!(b.watch.armed().is_some());
        b.on_beat(NOW + 120_000);
        assert!(b.watch.pending().is_none());
        let ev = b.outbox.pending();
        assert_eq!((ev[0]["kind"].as_str(), ev[0]["profileId"].as_str(), ev[0]["entryId"].as_str()), (Some("boot.watchdog.ok"), Some("lab"), Some("nova.conf")));
        assert_eq!((ev[0]["detail"]["verified"].as_bool(), ev[0]["changeId"].clone()), (Some(true), body["authorization"]["payload"]["changeId"].clone()));
        assert_eq!(b.status().unwrap()["last"]["result"], "ok");
        b.outbox.ack(&ev);
        assert!(b.outbox.pending().is_empty());
        // Commit makes it the default.
        let c = b.commit(&signed(&HUB_SEED, "boot.commit", &json!({ "profileId": "lab", "entryId": "nova.conf" }), now_ms()), Transport::Plain).unwrap();
        assert_eq!(c["committed"]["entryId"], "nova.conf");
        assert_eq!(fake_file(&file)["default"], "nova.conf");
        assert_eq!(reboot.calls.load(Ordering::SeqCst), 1);
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn reverts_when_no_heartbeat_comes_by_the_deadline_and_restarts_once() {
        let (base, b, reboot, file) = fake("boot-revert");
        allow(&b.data, true);
        b.set(&set_body("nova.conf", false), Transport::Plain, NOW).unwrap();
        assert_eq!(reboot.calls.load(Ordering::SeqCst), 0, "reboot: false restarts nothing");
        // Restarted (by the owner) into the entry, but the Hub never answers.
        std::fs::write(&b.watch.boot_id_path, "boot-2\n").unwrap();
        let mut f = fake_file(&file);
        f["booted"] = json!("nova.conf");
        write_json(&file, &f, false).unwrap();
        b.on_start();
        b.tick(NOW + 599_000);
        assert!(b.watch.pending().is_some(), "not yet");
        b.tick(NOW + 601_000);
        assert!(b.watch.pending().is_none());
        assert_eq!(fake_file(&file)["oneshot"], Value::Null, "the one-shot is cleared");
        assert_eq!(reboot.calls.load(Ordering::SeqCst), 1, "one restart into the default");
        let ev = b.outbox.pending();
        assert_eq!((ev[0]["kind"].as_str(), ev[0]["detail"]["reason"].as_str()), (Some("boot.watchdog.reverted"), Some("deadline")));
        assert_eq!(b.status().unwrap()["last"]["result"], "reverted");
        // Never twice: the next start finds nothing, ticks do nothing, and a late beat is no-op.
        b.on_start();
        b.tick(NOW + 700_000);
        b.on_beat(NOW + 700_000);
        assert_eq!(reboot.calls.load(Ordering::SeqCst), 1);
        assert_eq!(b.outbox.pending().len(), 1);
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn the_deadline_does_not_restart_a_machine_already_back_on_another_entry() {
        let (base, b, reboot, _file) = fake("boot-back");
        allow(&b.data, true);
        b.set(&set_body("nova.conf", false), Transport::Plain, NOW).unwrap();
        // Restarted, but on the default entry (the one-shot did not take), and the Hub is away.
        std::fs::write(&b.watch.boot_id_path, "boot-2\n").unwrap();
        b.on_start();
        b.tick(NOW + 601_000);
        let ev = b.outbox.pending();
        assert_eq!((ev[0]["kind"].as_str(), ev[0]["detail"]["booted"].as_str(), ev[0]["detail"]["rebooted"].as_bool()), (Some("boot.watchdog.reverted"), Some("debian.conf"), Some(false)));
        assert_eq!(ev[0]["changeId"].as_str().map(str::len), Some(36), "K matches events on the change id");
        assert_eq!(reboot.calls.load(Ordering::SeqCst), 0);
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn a_boot_into_another_entry_or_no_restart_at_all_reverts_without_restarting() {
        let (base, b, reboot, file) = fake("boot-other");
        allow(&b.data, true);
        b.set(&set_body("nova.conf", false), Transport::Plain, NOW).unwrap();
        // Only novad restarted: same boot id, not armed; a beat is not a confirmation.
        b.on_start();
        assert!(b.watch.armed().is_none());
        b.on_beat(NOW + 1000);
        assert!(b.watch.pending().is_some());
        // Never restarted by the deadline: the one-shot is cleared, no restart.
        b.tick(NOW + 601_000);
        assert!(b.watch.pending().is_none());
        assert_eq!(fake_file(&file)["oneshot"], Value::Null);
        assert_eq!(b.outbox.pending()[0]["detail"]["reason"], "not_restarted");
        assert_eq!(reboot.calls.load(Ordering::SeqCst), 0);
        // A restart that came back on the default entry: failed, cleared, no restart.
        let later = signed(&HUB_SEED, "boot.set", &json!({ "profileId": "lab", "entryId": "nova.conf", "reboot": false }), NOW + 700_000);
        b.set(&later, Transport::Plain, NOW + 700_000).unwrap();
        std::fs::write(&b.watch.boot_id_path, "boot-3\n").unwrap();
        b.on_start();
        b.on_beat(NOW + 710_000);
        let ev = b.outbox.pending();
        assert_eq!((ev[1]["kind"].as_str(), ev[1]["detail"]["reason"].as_str(), ev[1]["detail"]["booted"].as_str()), (Some("boot.watchdog.reverted"), Some("not_booted"), Some("debian.conf")));
        assert_eq!(b.status().unwrap()["last"]["result"], "failed");
        assert_eq!(reboot.calls.load(Ordering::SeqCst), 0);
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn revert_needs_the_authorization_but_not_the_policy() {
        let (base, b, reboot, file) = fake("boot-rv");
        allow(&b.data, true);
        b.set(&set_body("nova.conf", false), Transport::Plain, NOW).unwrap();
        allow(&b.data, false);
        assert_eq!(reason(&b.revert(&json!({}), Transport::Plain, NOW).unwrap_err()), "authorization_invalid");
        // A set authorization does not revert.
        assert_eq!(reason(&b.revert(&set_body("nova.conf", false), Transport::Plain, NOW).unwrap_err()), "authorization_mismatch");
        let r = b.revert(&signed(&HUB_SEED, "boot.revert", &json!({}), NOW), Transport::Plain, NOW).unwrap();
        assert_eq!(r["reverted"], true);
        assert_eq!(fake_file(&file)["oneshot"], Value::Null);
        assert_eq!(b.status().unwrap()["pending"], Value::Null);
        // Commit needs the policy.
        assert_eq!(reason(&b.commit(&signed(&HUB_SEED, "boot.commit", &json!({ "profileId": "lab", "entryId": "nova.conf" }), now_ms()), Transport::Plain).unwrap_err()), "low_level_boot_off");
        assert_eq!(reboot.calls.load(Ordering::SeqCst), 0);
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn refuses_bad_requests_and_unsupported_machines() {
        let (base, mut b, reboot, file) = fake("boot-bad");
        allow(&b.data, true);
        let body = signed(&HUB_SEED, "boot.set", &json!({ "profileId": "lab", "entryId": "nope.conf", "reboot": false }), NOW);
        assert_eq!(reason(&b.set(&body, Transport::Plain, NOW).unwrap_err()), "unknown_entry");
        let body = signed(&HUB_SEED, "boot.set", &json!({ "profileId": "lab", "entryId": "nova.conf", "watchdogSeconds": 30 }), NOW);
        assert_eq!(b.set(&body, Transport::Plain, NOW).unwrap_err().code, "validation");
        // Restarts off on the device: refused before anything changed.
        reboot.refuse.store(true, Ordering::SeqCst);
        assert_eq!(reason(&b.set(&set_body("nova.conf", true), Transport::Plain, NOW).unwrap_err()), "reboot_unavailable");
        assert_eq!(fake_file(&file)["oneshot"], Value::Null);
        // A bootloader that fails leaves no marker.
        reboot.refuse.store(false, Ordering::SeqCst);
        let mut f = fake_file(&file);
        f["failSet"] = json!(true);
        write_json(&file, &f, false).unwrap();
        assert!(b.set(&set_body("nova.conf", false), Transport::Plain, NOW).is_err());
        assert!(b.watch.pending().is_none());
        // A certificate on the device: plain HTTP is refused.
        std::fs::write(b.data.path().join(crate::tls::DEVICE_CERT_FILE), "x").unwrap();
        assert_eq!(reason(&b.set(&set_body("nova.conf", false), Transport::Plain, NOW).unwrap_err()), "tls_required");
        assert!(b.route("nope", &json!({}), Transport::Plain).is_err());
        // Nothing to manage, and other systems.
        set_config(&b.data, json!({ "backend": "none" }));
        let st = b.status().unwrap();
        assert_eq!((st["supported"].as_bool(), st["reason"].as_str()), (Some(false), Some("disabled_by_owner")));
        let e = b.set(&set_body("nova.conf", false), Transport::MutualTls, NOW).unwrap_err();
        assert_eq!((e.status, e.code.as_str(), reason(&e).as_str(), unsupported_detail(&e)), (409, "conflict", "unsupported_hardware", "disabled_by_owner"));
        b.os_supported = false;
        assert_eq!(b.status().unwrap()["reason"], "os_not_supported");
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn drives_systemd_boot_through_bootctl() {
        let base = tmp("bootctl");
        let bin = base.join("bin");
        let list = r#"[{"type":"type1","id":"debian.conf","title":"Debian","showTitle":"Debian GNU/Linux","isDefault":true,"isSelected":true},{"id":"nova.conf","title":"Nova image","isDefault":false,"isSelected":false},{"id":"auto-reboot-to-firmware-setup","title":"Reboot Into Firmware Interface"}]"#;
        fake_tool(&bin, "bootctl", &format!("case \"$*\" in *is-installed*) echo yes;; *list*) echo '{list}';; esac"));
        let tools = Tools { dirs: vec![bin.clone()] };
        let l = SystemdBoot(tools.clone());
        let s = l.state().unwrap();
        assert_eq!(s.booted.as_deref(), Some("debian.conf"));
        assert_eq!((s.entries[0].title.as_str(), s.entries[0].is_default, s.entries.len()), ("Debian GNU/Linux", true, 3));
        l.set_oneshot("nova.conf").unwrap();
        l.clear_oneshot().unwrap();
        l.set_default("nova.conf").unwrap();
        let c = calls(&bin);
        assert_eq!(&c[1..], &["bootctl set-oneshot nova.conf", "bootctl set-oneshot ", "bootctl set-default nova.conf"]);
        // Detection picks it first in auto mode.
        let (b2, data) = enrolled("bootctl-auto");
        let mut boot = Boot::new(data, Arc::new(FakeReboot::default()));
        boot.tools = tools;
        assert_eq!(boot.loader().unwrap().name(), "systemd-boot");
        // A tool that fails is an error naming it; one that hangs is cut off.
        fake_tool(&bin, "bootctl", "echo 'Failed to update EFI variable' >&2; exit 1");
        assert!(l.set_oneshot("x").unwrap_err().message.contains("Failed to update EFI variable"));
        fake_tool(&bin, "bootctl", "sleep 5");
        let t = Instant::now();
        assert_eq!(reason(&Tools { dirs: vec![bin.clone()] }.run(BOOTCTL, &["list"], 200).unwrap_err()), "tool_timeout");
        assert!(t.elapsed() < Duration::from_secs(3));
        assert_eq!(reason(&Tools { dirs: vec![base.join("none")] }.run(BOOTCTL, &[], 200).unwrap_err()), "tool_missing");
        assert!(parse_bootctl("not json").is_err());
        std::fs::remove_dir_all(&base).unwrap();
        std::fs::remove_dir_all(&b2).unwrap();
    }

    const GRUB_CFG: &str = r#"
function load_video {
  if [ x$feature_all_video_module = xy ]; then
    insmod all_video
  fi
}
set default="${saved_entry}"
menuentry 'Ubuntu' --class ubuntu --class gnu-linux $menuentry_id_option 'gnulinux-simple-1234' {
	linux /boot/vmlinuz root=UUID=1234 ro ${vt_handoff}
}
submenu 'Advanced options for Ubuntu' $menuentry_id_option 'gnulinux-advanced-1234' {
	menuentry 'Ubuntu, with Linux 6.8.0-45-generic' --class ubuntu $menuentry_id_option 'gnulinux-6.8.0-45-generic-advanced-1234' {
		linux /boot/vmlinuz-6.8.0-45-generic root=UUID=1234 ro
	}
	menuentry 'It'\''s a test' {
		true
	}
}
menuentry "Nova lab image" --id nova-lab {
	chainloader /EFI/nova/grubx64.efi
}
"#;

    #[test]
    fn reads_grub_menus_and_drives_grub_tools() {
        let e = parse_grub_cfg(GRUB_CFG);
        let ids: Vec<&str> = e.iter().map(|x| x.entry.id.as_str()).collect();
        assert_eq!(ids, vec!["gnulinux-simple-1234", "gnulinux-advanced-1234>gnulinux-6.8.0-45-generic-advanced-1234", "gnulinux-advanced-1234>It's a test", "nova-lab"]);
        assert_eq!(e[1].entry.title, "Advanced options for Ubuntu > Ubuntu, with Linux 6.8.0-45-generic");
        assert_eq!((e[0].kernel.as_deref(), e[1].kernel.as_deref(), e[3].kernel.as_deref()), (Some("/boot/vmlinuz"), Some("/boot/vmlinuz-6.8.0-45-generic"), None));
        let base = tmp("grub");
        let bin = base.join("bin");
        let cfg = base.join("grub/grub.cfg");
        std::fs::create_dir_all(cfg.parent().unwrap()).unwrap();
        std::fs::write(&cfg, GRUB_CFG).unwrap();
        std::fs::write(base.join("grub/grubenv"), "# GRUB Environment Block\nsaved_entry=nova-lab\n#########\n").unwrap();
        for t in ["grub-reboot", "grub-set-default", "grub-editenv"] {
            fake_tool(&bin, t, "exit 0");
        }
        let g = Grub { tools: Tools { dirs: vec![bin.clone()] }, cfg: cfg.clone(), cmdline: base.join("none") };
        let s = g.state().unwrap();
        assert_eq!(s.booted, None, "GRUB does not say which entry booted");
        assert_eq!(s.entries.iter().find(|e| e.is_default).map(|e| e.id.as_str()), Some("nova-lab"));
        std::fs::write(base.join("grub/grubenv"), "saved_entry=2\n").unwrap();
        assert_eq!(g.state().unwrap().entries.iter().find(|e| e.is_default).map(|e| e.id.as_str()), Some("nova-lab"), "an index counts top-level items, submenus too");
        std::fs::write(base.join("grub/grubenv"), "saved_entry=1\n").unwrap();
        assert!(g.state().unwrap().entries.iter().all(|e| !e.is_default), "a submenu is no entry");
        std::fs::write(base.join("grub/grubenv"), "").unwrap();
        assert!(g.state().unwrap().entries[0].is_default);
        g.set_oneshot("gnulinux-advanced-1234>gnulinux-6.8.0-45-generic-advanced-1234").unwrap();
        g.clear_oneshot().unwrap();
        g.set_default("nova-lab").unwrap();
        let env = base.join("grub/grubenv").display().to_string();
        assert_eq!(calls(&bin), vec!["grub-reboot gnulinux-advanced-1234>gnulinux-6.8.0-45-generic-advanced-1234".to_string(), format!("grub-editenv {env} unset next_entry"), "grub-set-default nova-lab".into()]);
        // Did the one-shot take? `next_entry` still set: no. Consumed: the kernel decides.
        let advanced = "gnulinux-advanced-1234>gnulinux-6.8.0-45-generic-advanced-1234";
        let g = Grub { cmdline: base.join("cmdline"), ..g };
        std::fs::write(base.join("grub/grubenv"), format!("saved_entry=nova-lab\nnext_entry={advanced}\n")).unwrap();
        assert_eq!(g.verify(advanced), Some(false));
        std::fs::write(base.join("grub/grubenv"), "saved_entry=nova-lab\nnext_entry=\n").unwrap();
        std::fs::write(base.join("cmdline"), "BOOT_IMAGE=(hd0,gpt2)/boot/vmlinuz-6.8.0-45-generic root=UUID=1234 ro\n").unwrap();
        assert_eq!(g.verify(advanced), Some(true));
        std::fs::write(base.join("cmdline"), "BOOT_IMAGE=/boot/vmlinuz root=UUID=1234 ro\n").unwrap();
        assert_eq!(g.verify(advanced), Some(false), "another kernel booted");
        assert_eq!(g.verify("nova-lab"), Some(true), "no kernel to compare: consumed is all GRUB tells");
        // Commit needs GRUB_DEFAULT=saved; with a fixed default, saved_entry is not the default.
        assert!(g.check_commit().is_ok());
        let fixed = GRUB_CFG.replace("set default=\"${saved_entry}\"", "set default=\"0\"");
        std::fs::write(&cfg, &fixed).unwrap();
        assert_eq!(grub_default(&fixed), GrubDefault::Fixed("0".into()));
        let e = g.check_commit().unwrap_err();
        assert_eq!((e.code.as_str(), reason(&e).as_str()), ("conflict", "grub_default_not_saved"));
        assert_eq!(g.state().unwrap().entries.iter().find(|e| e.is_default).map(|e| e.id.as_str()), Some("gnulinux-simple-1234"), "GRUB boots entry 0, whatever saved_entry says");
        assert_eq!(grub_default("menuentry 'x' {\n}\n"), GrubDefault::Fixed("0".into()));
        std::fs::write(&cfg, GRUB_CFG).unwrap();
        // Detection with the owner's grub.cfg path.
        let (b2, data) = enrolled("grub-auto");
        set_config(&data, json!({ "backend": "grub", "grubCfg": cfg }));
        let mut boot = Boot::new(data, Arc::new(FakeReboot::default()));
        boot.tools = Tools { dirs: vec![bin.clone()] };
        assert_eq!(boot.loader().unwrap().name(), "grub");
        std::fs::remove_dir_all(&base).unwrap();
        std::fs::remove_dir_all(&b2).unwrap();
    }

    const EFI: &str = "BootCurrent: 0001\nTimeout: 1 seconds\nBootOrder: 0001,0000,0003\nBoot0000* Windows Boot Manager\tHD(1,GPT,abcd)/File(\\EFI\\Microsoft\\Boot\\bootmgfw.efi)\nBoot0001* debian\tHD(1,GPT,abcd)/File(\\EFI\\debian\\shimx64.efi)\nBoot0003  UEFI PXEv4 (MAC:001122334455)\tPciRoot(0x0)\n";

    #[test]
    fn drives_uefi_boot_entries_through_efibootmgr() {
        let p = parse_efibootmgr(EFI);
        assert_eq!((p.current.as_deref(), p.next.as_deref()), (Some("0001"), None));
        assert_eq!(p.order, vec!["0001", "0000", "0003"]);
        assert_eq!(p.entries[0], ("0000".to_string(), "Windows Boot Manager".to_string()));
        assert_eq!(p.entries[2].1, "UEFI PXEv4 (MAC:001122334455)");
        let base = tmp("efi");
        let bin = base.join("bin");
        let out = base.join("efi.txt");
        std::fs::write(&out, EFI).unwrap();
        fake_tool(&bin, "efibootmgr", &format!("cat '{}'", out.display()));
        let u = Uefi(Tools { dirs: vec![bin.clone()] });
        let s = u.state().unwrap();
        assert_eq!(s.booted.as_deref(), Some("0001"));
        assert!(s.entries.iter().find(|e| e.id == "0001").unwrap().is_default);
        u.set_oneshot("0003").unwrap();
        u.clear_oneshot().unwrap();
        std::fs::write(&out, format!("BootNext: 0003\n{EFI}")).unwrap();
        u.clear_oneshot().unwrap();
        u.set_default("0003").unwrap();
        let c: Vec<String> = calls(&bin).into_iter().filter(|c| c != "efibootmgr -v").collect();
        assert_eq!(c, vec!["efibootmgr --bootnext 0003", "efibootmgr --delete-bootnext", "efibootmgr --bootorder 0003,0001,0000"]);
        assert!(!is_boot_num("00G1") && is_boot_num("00ab"));
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn keeps_markers_and_events_across_restarts() {
        let base = tmp("watch");
        let w = Watch { dir: base.join("w"), boot_id_path: base.join("boot_id"), armed: Mutex::new(None) };
        std::fs::write(&w.boot_id_path, "a").unwrap();
        let p = Pending { snapshot_id: Some("s1".into()), deadline: iso(NOW), deadline_ms: NOW, boot_id: w.current_boot(), at: iso(NOW), ..Default::default() };
        assert!(w.write(&p).unwrap());
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(w.dir.join("pending.json")).unwrap().permissions().mode() & 0o777, 0o600);
        w.mark_done("s1");
        w.on_start();
        assert!(w.pending().is_none(), "a marker the watchdog handled is dropped at start");
        assert!(!w.write(&p).unwrap(), "and never written again");
        // No boot id on this OS: a marker found at start is armed.
        let w2 = Watch { dir: base.join("w2"), boot_id_path: base.join("missing"), armed: Mutex::new(None) };
        w2.write(&Pending { boot_id: None, ..p.clone() }).unwrap();
        w2.on_start();
        assert!(w2.armed().is_some());
        let o = Outbox::new(base.join("o/events.json"));
        o.push(json!({ "kind": "a" }));
        o.push(json!({ "kind": "b" }));
        let sent = o.pending();
        o.push(json!({ "kind": "c" }));
        o.ack(&sent);
        assert_eq!(o.pending(), vec![json!({ "kind": "c" })]);
        assert_eq!(watchdog_seconds(&json!({})).unwrap(), 600);
        assert!(watchdog_seconds(&json!({ "watchdogSeconds": 4000 })).is_err());
        std::fs::remove_dir_all(&base).unwrap();
    }
}
