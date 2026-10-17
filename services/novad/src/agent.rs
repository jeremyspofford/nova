//! The running device agent: enrollment with the Hub, the management channel the Hub calls
//! (contracts/hub-api.md §3), and the heartbeat that reports modules, events and device-side
//! access decisions. Until certificates arrive (M6.5) both directions use bearer tokens over LAN
//! HTTP, like compute nodes (ADR-089): the Hub presents the management token novad generated at
//! enrollment; novad presents the device credential the Hub issued.

use crate::capabilities::{self, Extras, Probe, sign_document};
use crate::crypto::constant_time_eq;
use crate::grants::GrantStore;
use crate::hardening::{harden_self, is_hardened};
use crate::http::{self, Request, Response};
use crate::state::{DataDir, DeviceState, HubConfig};
use crate::supervisor::{Manifest, Options, Supervisor};
use crate::update;
use crate::util::{OpError, OpResult, new_token, now_iso, now_ms};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const PROTOCOL_VERSIONS: &[u64] = &[1];
/// The management token novad generates at enrollment starts with this, its own prefix, so it is
/// never mistaken for Nova's MCP client tokens (`nvm_`); the Hub checks it on registration. A
/// stored token without it (from before the prefix changed) is refused: add the device again.
pub const MANAGEMENT_TOKEN_PREFIX: &str = "nvdm_";
const MAX_BODY: usize = 96 * 1024 * 1024;
const CALL_TIMEOUT: Duration = Duration::from_secs(30);
const HUB_TIMEOUT: Duration = Duration::from_secs(15);

pub struct Agent {
    pub data: DataDir,
    pub sup: Supervisor,
    pub exe: PathBuf,
    pub state: Mutex<DeviceState>,
    pub started_ms: u64,
    /// Set after a self-update was staged: the main loop exits so the service manager restarts.
    pub restart: AtomicBool,
    /// Module health-check timing for updates (shorter in tests).
    pub health: (Duration, Duration),
    /// Wake-on-LAN for other devices when this one has the wake-helper role (FR-138).
    pub wake: crate::power::WakeHelper,
}

impl Agent {
    pub fn new(data: DataDir, exe: PathBuf, state: DeviceState, manifest: Manifest) -> Self {
        let sup = Supervisor::new(Options::new(exe.clone(), data.path().to_path_buf()), manifest);
        Agent {
            data,
            sup,
            exe,
            state: Mutex::new(state),
            started_ms: now_ms(),
            restart: AtomicBool::new(false),
            health: (Duration::from_secs(10), Duration::from_secs(2)),
            wake: crate::power::WakeHelper::system(),
        }
    }

    fn device(&self) -> DeviceState {
        self.state.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    /// Apply the Hub's per-device policy to the supervisor (FR-150).
    pub fn apply_policy(&self, hub: &HubConfig) {
        self.sup.set_policy(hub.policy.allowed_modules.clone(), hub.policy.resource_caps);
    }

    pub fn channel(&self) -> String {
        let hub = self.data.hub_config().unwrap_or_default();
        hub.update_channel.unwrap_or_else(|| self.device().channel)
    }

    /// The signed capability document (FR-142).
    pub fn capability(&self) -> OpResult<(Value, String)> {
        let d = self.device();
        let roles: Vec<&str> = d.roles.iter().map(String::as_str).collect();
        let base = capabilities::detect(&d.local_device_id, &roles, &Probe::current());
        let power = self.sup.call("management", "power.status", json!({}), Duration::from_secs(5)).ok();
        let grants = GrantStore::new(self.data.path().join("storage/grants.json"), self.data.path().to_path_buf());
        let mut scopes: Vec<String> = grants.load().map(|f| f.grants.into_iter().filter(|g| g.kind == "folder").map(|g| g.target).collect()).unwrap_or_default();
        scopes.sort();
        scopes.dedup();
        let channel = self.channel();
        let extras = Extras {
            modules: self.sup.names(),
            power: power.as_ref(),
            update_channel: &channel,
            fs_scopes: scopes,
            models_dir: Some(self.data.path().join("models").to_string_lossy().to_string()),
        };
        let local = self.data.config()?.capability_overrides;
        let hub = self.data.hub_config()?.capability_overrides;
        let doc = capabilities::build(&base, &extras, &local, &hub);
        let sig = sign_document(&doc, &self.data.key()?);
        Ok((doc, sig))
    }

    fn status(&self) -> Value {
        let d = self.device();
        json!({
            "novadVersion": VERSION,
            "deviceId": d.device_id,
            "localDeviceId": d.local_device_id,
            "channel": self.channel(),
            "modules": self.sup.statuses(),
            "uptimeMs": now_ms().saturating_sub(self.started_ms),
            "sandbox": crate::exec::find_bwrap().is_some(),
            "hardened": is_hardened(),
        })
    }

    /// One management request from the Hub.
    pub fn handle(&self, req: Request) -> Response {
        let token = self.device().management_token;
        let ok = match (token.as_deref().filter(|t| t.starts_with(MANAGEMENT_TOKEN_PREFIX)), req.bearer()) {
            (Some(t), Some(b)) => constant_time_eq(t.as_bytes(), b.as_bytes()),
            _ => false,
        };
        if !ok {
            return Response::error(401, "token_required", "a valid management token is required", None);
        }
        if req.method != "POST" {
            return Response::error(405, "validation", "use POST", None);
        }
        let body = match req.json() {
            Ok(v) if v.is_object() => v,
            _ => return Response::error(400, "validation", "the body must be a JSON object", None),
        };
        match self.route(&req.path, &body) {
            Ok(v) => Response::json(200, &v),
            Err(e) => Response::error(e.status, &e.code, &e.message, e.details),
        }
    }

    fn storage(&self, op: &str, body: &Value, timeout: Duration) -> OpResult<Value> {
        self.sup.call("storage", op, body.clone(), timeout)
    }

    fn route(&self, path: &str, body: &Value) -> OpResult<Value> {
        let parts: Vec<&str> = path.trim_start_matches("/agent/v1/").split('/').collect();
        match parts.as_slice() {
            ["status"] => Ok(self.status()),
            ["capabilities"] => {
                let (capability, signature) = self.capability()?;
                Ok(json!({ "capability": capability, "signature": signature, "novadVersion": VERSION }))
            }
            ["modules", name, action] => match *action {
                "start" => self.sup.start(name).map(|m| json!({ "module": m })),
                "stop" => self.sup.stop(name).map(|m| json!({ "module": m })),
                "restart" => self.sup.restart(name).map(|m| json!({ "module": m })),
                "rollback" => update::rollback_module(&self.sup, name),
                _ => Err(OpError::not_found("unknown module action")),
            },
            ["services", name, action] => self.service(name, action),
            ["power"] => self.power(body),
            ["power", "wake-other"] => self.wake_other(body),
            ["update"] => self.update(body),
            ["config"] => self.config(body),
            ["fs", op] => {
                let op = match *op {
                    "list" => "fs.list",
                    "read" => "fs.read",
                    "stat" => "fs.stat",
                    "request-access" => "fs.requestAccess",
                    "decide" => "fs.decide",
                    "grant" => "fs.grant",
                    "grants" => "fs.grants",
                    "revoke" => "fs.revoke",
                    "stage" => "fs.stage",
                    "commit" => "fs.commit",
                    "discard" => "fs.discard",
                    "delete" => "fs.delete",
                    "move" => "fs.move",
                    _ => return Err(OpError::not_found("unknown file operation")),
                };
                self.storage(op, body, CALL_TIMEOUT)
            }
            ["exec"] => {
                let t = body["timeoutMs"].as_u64().unwrap_or(crate::exec::DEFAULT_TIMEOUT_MS).min(crate::exec::MAX_TIMEOUT_MS);
                self.storage("exec", body, Duration::from_millis(t) + Duration::from_secs(10))
            }
            ["proc", op @ ("spawn" | "read" | "write" | "list")] => {
                let wait = body["waitMs"].as_u64().unwrap_or(0).min(30_000);
                self.storage(&format!("proc.{op}"), body, Duration::from_millis(wait) + CALL_TIMEOUT)
            }
            ["mcp", "list"] => self.storage("mcp.list", body, Duration::from_secs(120)),
            ["mcp", "call"] => self.storage("mcp.call", body, Duration::from_secs(60)),
            ["firmware", ..] => Err(OpError::new(403, "firmware_disabled", "firmware changes are off (FR-146)")),
            ["oob", ..] => Err(OpError::new(403, "oob_disabled", "out-of-band management is off (FR-147)")),
            ["boot", ..] => Err(OpError::new(400, "capability_missing", "low-level boot is not available in this version (FR-143)")),
            _ => Err(OpError::not_found("unknown management route")),
        }
    }

    /// Managed services (FR-145): module services through the supervisor, systemd units through
    /// the management module.
    fn service(&self, name: &str, action: &str) -> OpResult<Value> {
        let cfg = self.data.config()?;
        let svc = cfg.services.iter().find(|s| s.name == name).ok_or_else(|| OpError::not_found(format!("no managed service named {name}")))?;
        match svc.kind.as_str() {
            "module" => {
                let module = svc.module.clone().unwrap_or_else(|| name.to_string());
                let m = match action {
                    "start" => self.sup.start(&module)?,
                    "stop" => self.sup.stop(&module)?,
                    "restart" => self.sup.restart(&module)?,
                    "status" => self.sup.status(&module)?,
                    _ => return Err(OpError::validation("action must be start, stop, restart or status")),
                };
                Ok(json!({ "service": { "name": name, "kind": "module", "state": m["state"], "module": m } }))
            }
            "systemd" => {
                let unit = svc.unit.clone().ok_or_else(|| OpError::internal("the service has no unit"))?;
                let a = if action == "status" { "is-active" } else { action };
                let r = self.sup.call("management", "service.systemd", json!({ "unit": unit, "action": a }), CALL_TIMEOUT)?;
                let state = if action == "status" { r["state"].clone() } else { json!(if action == "stop" { "stopped" } else { "running" }) };
                Ok(json!({ "service": { "name": name, "kind": "systemd", "unit": unit, "state": state } }))
            }
            _ => Err(OpError::internal("unknown service kind")),
        }
    }

    fn power(&self, body: &Value) -> OpResult<Value> {
        let call = |op: &str, args: Value| self.sup.call("management", op, args, CALL_TIMEOUT);
        match body["action"].as_str().unwrap_or("status") {
            "status" => call("power.status", json!({})),
            "wol-plan" => call("power.wolPlan", json!({})),
            "wol-enable" => call("power.wolEnable", json!({ "apply": body["apply"].as_bool().unwrap_or(false) })),
            a @ ("sleep" | "restart" | "shutdown") => call("power.action", json!({ "action": a })),
            _ => Err(OpError::validation("unknown power action")),
        }
    }

    /// Wake another device on this LAN (FR-138, docs/22 §7): only with the wake-helper role,
    /// which the owner grants at Add Device. Validation, the LAN check and the local rate limit
    /// are the helper's.
    fn wake_other(&self, body: &Value) -> OpResult<Value> {
        if !self.device().roles.iter().any(|r| r == "wake-helper") {
            return Err(OpError::denied("not_wake_helper", "this device does not have the wake-helper role"));
        }
        self.wake.wake(body)
    }

    fn update(&self, body: &Value) -> OpResult<Value> {
        let bundle = body.get("bundle").ok_or_else(|| OpError::validation("bundle is required"))?;
        let d = self.device();
        let target = bundle["manifest"]["target"].as_str().unwrap_or_default().to_string();
        let current = if target == "novad" { Some(VERSION.to_string()) } else { self.sup.spec(&target).map(|s| s.version) };
        let (m, payload) = update::verify_bundle(bundle, d.update_trust_key.as_deref(), &self.channel(), current.as_deref())?;
        if m.target == "novad" {
            let r = update::stage_self(&self.data, &self.exe, &m, &payload)?;
            self.restart.store(true, Ordering::SeqCst);
            return Ok(r);
        }
        update::apply_module(&self.sup, &self.data, &m, &payload, self.health.0, self.health.1)
    }

    /// The Hub's overrides and policy (FR-142, FR-150): saved, applied, and answered with the
    /// re-signed capability document.
    fn config(&self, body: &Value) -> OpResult<Value> {
        let mut hub = self.data.hub_config()?;
        if let Some(o) = body.get("capabilityOverrides").filter(|v| !v.is_null()) {
            capabilities::validate_overrides(o)?;
            hub.capability_overrides = o.clone();
        }
        if let Some(p) = body.get("policy").filter(|v| !v.is_null()) {
            hub.policy = serde_json::from_value(p.clone()).map_err(|e| OpError::validation(format!("policy: {e}")))?;
            if let Some(list) = &hub.policy.allowed_modules {
                if let Some(bad) = list.iter().find(|m| !crate::supervisor::MODULES.contains(&m.as_str())) {
                    return Err(OpError::validation(format!("unknown module {bad}")));
                }
            }
        }
        if let Some(c) = body.get("updateChannel").filter(|v| !v.is_null()) {
            let c = c.as_str().filter(|c| crate::state::CHANNELS.contains(c)).ok_or_else(|| OpError::validation("updateChannel must be stable, beta or nightly"))?;
            hub.update_channel = Some(c.to_string());
        }
        hub.revision = body["revision"].as_u64().unwrap_or(hub.revision + 1);
        self.data.save_hub_config(&hub)?;
        self.apply_policy(&hub);
        let (capability, signature) = self.capability()?;
        Ok(json!({ "capability": capability, "signature": signature, "revision": hub.revision, "modules": self.sup.statuses() }))
    }

    /// One heartbeat. Returns false when the Hub revoked this device.
    pub fn heartbeat(&self, pending_events: &mut Vec<Value>, beat: u64) -> bool {
        let d = self.device();
        let (Some(hub), Some(cred)) = (d.hub_url.clone(), d.credential.clone()) else { return false };
        pending_events.extend(self.sup.drain_events());
        if pending_events.len() > 500 {
            let n = pending_events.len() - 500;
            pending_events.drain(..n);
        }
        let decisions = self.sup.call("storage", "fs.unreported", json!({}), Duration::from_secs(5)).map(|v| v["decisions"].clone()).unwrap_or(json!([]));
        let mut body = json!({
            "novadVersion": VERSION,
            "modules": self.sup.statuses(),
            "events": pending_events.clone(),
            "accessDecisions": decisions,
        });
        if beat % 6 == 0 {
            if let Ok(p) = self.sup.call("management", "power.status", json!({}), Duration::from_secs(5)) {
                body["power"] = p;
            }
        }
        match http::post_json(&format!("{hub}/agent/v1/heartbeat"), Some(&cred), &body, HUB_TIMEOUT) {
            Ok((200, resp)) => {
                pending_events.clear();
                let ids: Vec<String> = decisions.as_array().into_iter().flatten().filter_map(|r| r["id"].as_str().map(str::to_string)).collect();
                if !ids.is_empty() {
                    let _ = self.sup.call("storage", "fs.markReported", json!({ "ids": ids }), Duration::from_secs(5));
                }
                if let Some(ms) = resp["heartbeatIntervalMs"].as_u64() {
                    self.state.lock().unwrap_or_else(|p| p.into_inner()).heartbeat_interval_ms = ms.clamp(1_000, 300_000);
                }
                if resp["capabilityRequested"].as_bool() == Some(true) || beat % 30 == 0 {
                    self.send_capability();
                }
                if let Some(done) = update::commit_self(&self.data) {
                    pending_events.push(json!({ "kind": "update", "at": now_iso(), "update": done }));
                }
                true
            }
            Ok((401, _)) => {
                self.revoked();
                false
            }
            Ok((status, _)) => {
                eprintln!("novad: heartbeat refused with {status}");
                true
            }
            Err(e) => {
                eprintln!("novad: heartbeat failed: {e}");
                true
            }
        }
    }

    fn send_capability(&self) {
        let d = self.device();
        let (Some(hub), Some(cred)) = (d.hub_url, d.credential) else { return };
        if let Ok((capability, signature)) = self.capability() {
            let body = json!({ "capability": capability, "signature": signature, "novadVersion": VERSION });
            if let Err(e) = http::post_json(&format!("{hub}/agent/v1/capabilities"), Some(&cred), &body, HUB_TIMEOUT) {
                eprintln!("novad: capability update failed: {e}");
            }
        }
    }

    /// The Hub revoked this device (docs/23 §10): stop modules, wipe credentials, wait to be
    /// added again.
    fn revoked(&self) {
        eprintln!("novad: this device was revoked by the Hub; modules stopped and credentials wiped");
        self.sup.stop_all();
        let mut d = self.state.lock().unwrap_or_else(|p| p.into_inner());
        d.credential = None;
        d.management_token = None;
        d.revoked = true;
        let _ = self.data.save_device(&d);
    }
}

/// Enroll with the Hub: create the key, sign the capability document and register.
pub fn enroll(a: &crate::cli::EnrollArgs, exe: PathBuf) -> Result<Value, String> {
    let data = DataDir(PathBuf::from(&a.data_dir));
    data.ensure().map_err(|e| e.to_string())?;
    // Every enrollment is a new identity: the Hub pins the key once and keeps a revoked key
    // burned, so re-adding a device (docs/23 §10) needs a fresh one.
    match std::fs::remove_file(data.seed_path()) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("cannot rotate the device key: {e}")),
    }
    register(&data, a, exe)
}

/// Register with the Hub (`POST /agent/v1/register`) with the device key already in `data`
/// (created when missing): `novad install` registers with the key the Hub approved (FR-132).
pub fn register(data: &DataDir, a: &crate::cli::EnrollArgs, exe: PathBuf) -> Result<Value, String> {
    let name = a.name.clone().unwrap_or_else(|| Probe::current().hostname.unwrap_or_else(|| "device".into()));
    let mut state = data.new_device(&name, a.roles.clone()).map_err(|e| e.to_string())?;
    let previous = data.device().map_err(|e| e.to_string())?;
    let mgmt = new_token(MANAGEMENT_TOKEN_PREFIX)?;
    state.management_token = Some(mgmt.clone());
    state.listen = Some(a.listen.clone());
    state.endpoint = Some(a.endpoint.clone());
    state.channel = a.channel.clone();
    // The update key is pinned once; a later enrollment cannot replace it.
    state.update_trust_key = previous.as_ref().and_then(|p| p.update_trust_key.clone()).or_else(|| a.update_key.clone());
    let manifest_path = data.manifest_path();
    let manifest = Manifest::load_or(&manifest_path, Manifest::default_for(&a.roles)).map_err(|e| e.to_string())?;
    crate::util::write_json(&manifest_path, &manifest, false).map_err(|e| e.to_string())?;
    let agent = Agent::new(data.clone(), exe, state.clone(), manifest);
    let (capability, signature) = agent.capability().map_err(|e| e.to_string())?;
    let body = json!({
        "enrollToken": a.token,
        "name": name,
        "endpoint": a.endpoint,
        "publicKey": data.public_key().map_err(|e| e.to_string())?,
        "capability": capability,
        "signature": signature,
        "managementToken": mgmt,
        "novadVersion": VERSION,
        "protocolVersions": PROTOCOL_VERSIONS,
    });
    let (status, resp) = http::post_json(&format!("{}/agent/v1/register", a.hub.trim_end_matches('/')), None, &body, HUB_TIMEOUT)?;
    if status != 201 {
        return Err(format!("the Hub refused the enrollment ({status}): {}", resp["error"]["message"].as_str().unwrap_or("unknown error")));
    }
    state.hub_url = Some(a.hub.trim_end_matches('/').to_string());
    state.device_id = resp["deviceId"].as_str().map(str::to_string);
    state.credential = resp["credential"].as_str().map(str::to_string);
    if let Some(ms) = resp["heartbeatIntervalMs"].as_u64() {
        state.heartbeat_interval_ms = ms.clamp(1_000, 300_000);
    }
    if state.update_trust_key.is_none() {
        state.update_trust_key = resp["updateKey"].as_str().map(str::to_string);
    }
    state.enrolled_at = Some(now_iso());
    state.revoked = false;
    if state.device_id.is_none() || state.credential.is_none() {
        return Err("the Hub's answer had no device id or credential".into());
    }
    data.save_device(&state).map_err(|e| e.to_string())?;
    Ok(json!({ "deviceId": state.device_id, "name": name, "endpoint": a.endpoint }))
}

/// `novad run`: the supervisor, the management channel and the heartbeat, until revoked or a
/// self-update asks for a restart. Returns the process exit code.
pub fn run(data_dir: &str, exe: PathBuf) -> Result<i32, String> {
    harden_self();
    let data = DataDir(PathBuf::from(data_dir));
    match update::watchdog_on_start(&data).map_err(|e| e.to_string())? {
        Some(w) if w["status"] == "rolled_back" => {
            eprintln!("novad: the new version did not come up; restored the previous binary");
            return Ok(75);
        }
        _ => {}
    }
    let state = data.device().map_err(|e| e.to_string())?.ok_or("this device is not enrolled; run `novad install` or `novad enroll` first")?;
    if state.revoked || state.credential.is_none() {
        return Err("this device was revoked; enroll it again".into());
    }
    let listen = state.listen.clone().ok_or("no listen address; enroll again")?;
    let manifest = Manifest::load_or(&data.manifest_path(), Manifest::default_for(&state.roles)).map_err(|e| e.to_string())?;
    let agent = Arc::new(Agent::new(data.clone(), exe, state, manifest));
    agent.apply_policy(&data.hub_config().unwrap_or_default());
    agent.sup.start_all();
    let _monitor = agent.sup.spawn_monitor(Duration::from_millis(200));
    let listener = std::net::TcpListener::bind(&listen).map_err(|e| format!("cannot listen on {listen}: {e}"))?;
    let handler_agent = agent.clone();
    let server = http::serve(listener, MAX_BODY, Arc::new(move |req| handler_agent.handle(req)));
    eprintln!("novad {VERSION}: supervisor running; management channel on {}", server.local_addr());
    let mut events = vec![];
    let mut beat: u64 = 0;
    agent.send_capability();
    loop {
        if !agent.heartbeat(&mut events, beat) && agent.device().revoked {
            server.stop();
            return Ok(0);
        }
        beat += 1;
        let interval = agent.device().heartbeat_interval_ms;
        let deadline = now_ms() + interval;
        while now_ms() < deadline {
            if agent.restart.load(Ordering::SeqCst) {
                // Let the response to the update call leave first.
                std::thread::sleep(Duration::from_millis(300));
                agent.sup.stop_all();
                server.stop();
                return Ok(75);
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::{SigningKey, b64url_encode};
    use crate::grants::tests::tmp;
    use crate::supervisor::ModuleSpec;
    use crate::supervisor::tests::PONG;

    fn agent(dir: &std::path::Path) -> Agent {
        let data = DataDir(dir.join("data"));
        data.ensure().unwrap();
        let mut st = data.new_device("box", vec!["client".into()]).unwrap();
        st.management_token = Some("nvdm_test".into());
        st.update_trust_key = Some(b64url_encode(&SigningKey::from_seed(&[3u8; 32]).public_key()));
        let pong = |n: &str| ModuleSpec { exec: Some(vec!["/bin/sh".into(), "-c".into(), PONG.into()]), ..ModuleSpec::builtin(n, true) };
        let mut a = Agent::new(data, PathBuf::from("/bin/false"), st, Manifest { modules: vec![pong("storage"), pong("compute")] });
        a.health = (Duration::from_secs(3), Duration::from_millis(100));
        a.sup.start_all();
        a
    }

    fn req(path: &str, token: Option<&str>, body: Value) -> Request {
        let mut headers = vec![("content-type".to_string(), "application/json".to_string())];
        if let Some(t) = token {
            headers.push(("authorization".into(), format!("Bearer {t}")));
        }
        Request { method: "POST".into(), path: path.into(), query: String::new(), headers, body: serde_json::to_vec(&body).unwrap(), peer: None }
    }

    fn body(r: &Response) -> Value {
        serde_json::from_slice(&r.body).unwrap()
    }

    #[test]
    fn requires_the_management_token() {
        let dir = tmp("agent1");
        let a = agent(&dir);
        assert_eq!(a.handle(req("/agent/v1/status", None, json!({}))).status, 401);
        assert_eq!(a.handle(req("/agent/v1/status", Some("nvdm_wrong"), json!({}))).status, 401);
        let ok = a.handle(req("/agent/v1/status", Some("nvdm_test"), json!({})));
        assert_eq!(ok.status, 200);
        assert_eq!(body(&ok)["novadVersion"], VERSION);
        assert_eq!(a.handle(req("/agent/v1/firmware/apply", Some("nvdm_test"), json!({}))).status, 403);
        assert_eq!(a.handle(req("/agent/v1/nope", Some("nvdm_test"), json!({}))).status, 404);
        // The device's own prefix, distinct from Nova's MCP client tokens; a stored token from
        // before the prefix changed is refused even when presented exactly.
        let fresh = new_token(MANAGEMENT_TOKEN_PREFIX).unwrap();
        assert!(fresh.starts_with("nvdm_") && fresh.len() == 5 + 43, "{fresh}");
        a.state.lock().unwrap().management_token = Some("nvm_test".into());
        assert_eq!(a.handle(req("/agent/v1/status", Some("nvm_test"), json!({}))).status, 401);
        a.sup.stop_all();
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn wakes_other_devices_only_as_a_wake_helper() {
        let dir = tmp("agent-wake");
        let mut a = agent(&dir);
        let sender = crate::power::tests::FakeSender::default();
        a.wake = crate::power::tests::helper(sender.clone());
        let wake = json!({ "mac": "aa:bb:cc:dd:ee:01", "broadcast": "192.168.1.255" });
        // The management token is required like for every other call.
        assert_eq!(a.handle(req("/agent/v1/power/wake-other", None, wake.clone())).status, 401);
        let r = a.handle(req("/agent/v1/power/wake-other", Some("nvdm_test"), wake.clone()));
        assert_eq!(r.status, 403);
        assert_eq!(body(&r)["error"]["details"]["reason"], "not_wake_helper");
        a.state.lock().unwrap().roles.push("wake-helper".into());
        let r = a.handle(req("/agent/v1/power/wake-other", Some("nvdm_test"), wake.clone()));
        assert_eq!(r.status, 200, "{}", String::from_utf8_lossy(&r.body));
        assert_eq!(body(&r)["targets"][0]["interface"], "eth0");
        assert_eq!(sender.0.lock().unwrap().len(), 1);
        let bad = a.handle(req("/agent/v1/power/wake-other", Some("nvdm_test"), json!({ "mac": "ff:ff:ff:ff:ff:ff" })));
        assert_eq!((bad.status, body(&bad)["error"]["code"].as_str()), (400, Some("validation")));
        for _ in 0..9 {
            assert_eq!(a.handle(req("/agent/v1/power/wake-other", Some("nvdm_test"), wake.clone())).status, 200);
        }
        let limited = a.handle(req("/agent/v1/power/wake-other", Some("nvdm_test"), wake));
        assert_eq!((limited.status, body(&limited)["error"]["code"].as_str()), (429, Some("rate_limited")));
        a.sup.stop_all();
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn manages_modules_and_services() {
        let dir = tmp("agent2");
        let a = agent(&dir);
        let r = a.handle(req("/agent/v1/services/compute/stop", Some("nvdm_test"), json!({})));
        assert_eq!(body(&r)["service"]["state"], "stopped");
        let r = a.handle(req("/agent/v1/services/compute/start", Some("nvdm_test"), json!({})));
        assert_eq!(body(&r)["service"]["state"], "running");
        let r = a.handle(req("/agent/v1/modules/storage/restart", Some("nvdm_test"), json!({})));
        assert_eq!(body(&r)["module"]["state"], "running");
        assert_eq!(a.handle(req("/agent/v1/services/nope/start", Some("nvdm_test"), json!({}))).status, 404);
        // The management module is not installed here: power calls say so.
        let p = a.handle(req("/agent/v1/power", Some("nvdm_test"), json!({ "action": "status" })));
        assert_eq!(p.status, 404);
        a.sup.stop_all();
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn config_applies_policy_and_resigns_the_document() {
        let dir = tmp("agent3");
        let a = agent(&dir);
        let r = a.handle(req(
            "/agent/v1/config",
            Some("nvdm_test"),
            json!({ "capabilityOverrides": { "scheduling": { "routingWeight": 5 } }, "policy": { "allowedModules": ["storage"] }, "updateChannel": "beta", "revision": 4 }),
        ));
        assert_eq!(r.status, 200, "{}", String::from_utf8_lossy(&r.body));
        let b = body(&r);
        assert_eq!(b["capability"]["scheduling"]["routingWeight"], 5);
        assert_eq!(b["capability"]["data"]["updateChannel"], "beta");
        assert_eq!(b["revision"], 4);
        let key: [u8; 32] = crate::crypto::b64url_decode(&a.data.public_key().unwrap()).unwrap().try_into().unwrap();
        let sig: [u8; 64] = crate::crypto::b64url_decode(b["signature"].as_str().unwrap()).unwrap().try_into().unwrap();
        assert!(crate::crypto::verify(&key, capabilities::canonical_json(&b["capability"]).as_bytes(), &sig));
        assert_eq!(a.sup.status("compute").unwrap()["state"], "stopped");
        let bad = a.handle(req("/agent/v1/config", Some("nvdm_test"), json!({ "capabilityOverrides": { "hardware": { "cores": 1 } } })));
        assert_eq!(bad.status, 400);
        a.sup.stop_all();
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn updates_modules_through_the_channel() {
        let dir = tmp("agent4");
        let a = agent(&dir);
        let k = SigningKey::from_seed(&[3u8; 32]);
        let good = format!("#!/bin/sh\n{PONG}\n");
        let b = crate::update::tests::bundle(&k, "compute", "9.1.0", "stable", good.as_bytes());
        let r = a.handle(req("/agent/v1/update", Some("nvdm_test"), json!({ "bundle": b })));
        assert_eq!(body(&r)["status"], "applied", "{}", String::from_utf8_lossy(&r.body));
        let wrong = crate::update::tests::bundle(&SigningKey::from_seed(&[9u8; 32]), "compute", "9.2.0", "stable", good.as_bytes());
        let r = a.handle(req("/agent/v1/update", Some("nvdm_test"), json!({ "bundle": wrong })));
        assert_eq!(r.status, 403);
        a.sup.stop_all();
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
