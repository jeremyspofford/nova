//! The running device agent: enrollment with the Hub, the management channel the Hub calls
//! (contracts/hub-api.md §3), and the heartbeat that reports modules, events and device-side
//! access decisions. The Hub presents the management token novad generated at enrollment; novad
//! presents the device credential the Hub issued (ADR-089) and, when the Hub serves HTTPS, reaches
//! it over TLS trusted through the pinned Hub identity, presenting its device certificate (mutual
//! TLS, FR-126, R-022, R-023; src/tls.rs). A device that enrolled over http:// moves to https://
//! on its own once the Hub serves it, never back. Heartbeat answers carry the scopes the Hub
//! granted (docs/22 §4.2), kept in `scopes.json` for the local runtime (FR-128).

use crate::authz::Transport;
use crate::capabilities::{self, Extras, Probe, sign_document};
use crate::crypto::constant_time_eq;
use crate::grants::GrantStore;
use crate::hardening::{harden_self, is_hardened};
use crate::http::{self, Request, Response};
use crate::state::{DataDir, DeviceState, HubConfig};
use crate::supervisor::{Manifest, Options, Supervisor};
use crate::tls::{HubTrust, TlsContext};
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
    /// How the Hub is reached over HTTPS (None: no pin, so http:// only).
    pub tls: Mutex<Option<Arc<TlsContext>>>,
    /// When an http:// Hub was last tried at https:// (at most once a minute).
    upgrade_tried_ms: Mutex<u64>,
    /// The open DevTools pipes of browser sessions (FR-209), ended when a session closes.
    pub cdp: Arc<crate::browser::CdpPipes>,
    /// BIOS/firmware settings and their watchdog (FR-146, src/firmware.rs).
    pub firmware: crate::firmware::Firmware,
    /// Low-level boot and its watchdog (FR-143, src/boot.rs).
    pub boot: crate::boot::Boot,
}

impl Agent {
    pub fn new(data: DataDir, exe: PathBuf, state: DeviceState, manifest: Manifest) -> Self {
        let sup = Supervisor::new(Options::new(exe.clone(), data.path().to_path_buf()), manifest);
        // Restarts for firmware and boot changes go through the power module (FR-144).
        let reboot: Arc<dyn crate::boot::Rebooter> = Arc::new(crate::boot::PowerReboot(sup.clone()));
        Agent {
            firmware: crate::firmware::Firmware::new(data.clone(), reboot.clone()),
            boot: crate::boot::Boot::new(data.clone(), reboot),
            sup,
            exe,
            state: Mutex::new(state),
            started_ms: now_ms(),
            restart: AtomicBool::new(false),
            health: (Duration::from_secs(10), Duration::from_secs(2)),
            wake: crate::power::WakeHelper::system(),
            tls: Mutex::new(TlsContext::for_data(&data).map(Arc::new)),
            upgrade_tried_ms: Mutex::new(0),
            cdp: Arc::new(crate::browser::CdpPipes::default()),
            data,
        }
    }

    pub(crate) fn tls(&self) -> Option<Arc<TlsContext>> {
        self.tls.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    /// The Hub stopped answering at its http:// address: if it now serves HTTPS on the same
    /// address and the pinned identity vouches for it, use https:// from now on (R-023). Never
    /// the other way: a device on https:// does not fall back to plain HTTP.
    fn try_https(&self, hub: &str) -> bool {
        let (Some(rest), Some(tls)) = (hub.strip_prefix("http://"), self.tls()) else { return false };
        {
            let mut last = self.upgrade_tried_ms.lock().unwrap_or_else(|p| p.into_inner());
            if now_ms().saturating_sub(*last) < 60_000 {
                return false;
            }
            *last = now_ms();
        }
        let https = format!("https://{rest}");
        match http::get_json_with(&format!("{https}/api/v1/hello"), None, HUB_TIMEOUT, Some(&tls)) {
            Ok((200, _)) => {
                let mut d = self.state.lock().unwrap_or_else(|p| p.into_inner());
                d.hub_url = Some(https.clone());
                let _ = self.data.save_device(&d);
                eprintln!("novad: the Hub now serves HTTPS; using {https}");
                true
            }
            Ok(_) | Err(_) => false,
        }
    }

    pub(crate) fn device(&self) -> DeviceState {
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
        // The local runtime's models (FR-128), when the module runs and its server answers.
        let local_models = self.sup.spec("local-runtime").and_then(|_| self.sup.call("local-runtime", "models", json!({}), Duration::from_secs(5)).ok()).map(|v| {
            v["models"].as_array().into_iter().flatten().filter_map(|m| m.as_str().map(str::to_string)).collect::<Vec<_>>()
        });
        let extras = Extras {
            modules: self.sup.names().into_iter().chain(self.firmware.supported().then(|| "firmware".to_string())).collect(),
            power: power.as_ref(),
            update_channel: &channel,
            fs_scopes: scopes,
            models_dir: Some(self.data.path().join("models").to_string_lossy().to_string()),
            local_models,
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

    /// One management request from the Hub over plain HTTP.
    pub fn handle(&self, req: Request) -> Response {
        self.handle_on(req, Transport::Plain)
    }

    /// One management request from the Hub; `transport` says whether it came over mutual TLS
    /// (src/mgmt_tls.rs), which privileged requests need once the device holds a certificate (D1).
    pub fn handle_on(&self, req: Request, transport: Transport) -> Response {
        let token = self.device().management_token;
        let ok = match (token.as_deref().filter(|t| t.starts_with(MANAGEMENT_TOKEN_PREFIX)), req.bearer()) {
            (Some(t), Some(b)) => constant_time_eq(t.as_bytes(), b.as_bytes()),
            _ => false,
        };
        if !ok {
            return Response::error(401, "token_required", "a valid management token is required", None);
        }
        // The DevTools WebSocket of a browser session (FR-209): the connection is handed over.
        if req.method == "GET" && req.path.starts_with(crate::browser::CDP_PREFIX) {
            return crate::browser::cdp_upgrade(&req, &self.cdp, &|id| crate::browser::connect_cdp(self.data.path(), id));
        }
        if req.method != "POST" {
            return Response::error(405, "validation", "use POST", None);
        }
        let body = match req.json() {
            Ok(v) if v.is_object() => v,
            _ => return Response::error(400, "validation", "the body must be a JSON object", None),
        };
        let result = match self.privileged(&req.path, &body, transport) {
            Some(r) => r,
            None => self.route(&req.path, &body),
        };
        match result {
            Ok(v) => Response::json(200, &v),
            Err(e) => Response::error(e.status, &e.code, &e.message, e.details),
        }
    }

    fn storage(&self, op: &str, body: &Value, timeout: Duration) -> OpResult<Value> {
        self.sup.call("storage", op, body.clone(), timeout)
    }

    /// The routes whose writes need a Hub-signed authorization (D2), with the transport: firmware
    /// (FR-146), boot (FR-143) and decommission (D9). Their writes refuse plain HTTP on a device
    /// that holds a certificate before anything else is looked at (D1).
    fn privileged(&self, path: &str, body: &Value, transport: Transport) -> Option<OpResult<Value>> {
        let parts: Vec<&str> = path.trim_start_matches("/agent/v1/").split('/').collect();
        let writes = matches!(parts.as_slice(), ["firmware", "apply" | "rollback"] | ["boot", "set" | "commit" | "revert"] | ["decommission"]);
        if writes && transport == Transport::Plain && crate::authz::has_certificate(&self.data) {
            return Some(Err(OpError::denied("tls_required", "this device takes privileged requests only over mutual TLS")));
        }
        match parts.as_slice() {
            ["firmware", op] => Some(self.firmware.route(op, body, transport)),
            ["boot", op] => Some(self.boot.route(op, body, transport)),
            ["decommission"] => Some(crate::uninstall::decommission(self, body, transport)),
            ["firmware" | "boot", ..] => Some(Err(OpError::not_found("unknown management route"))),
            _ => None,
        }
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
            ["services"] => self.services(),
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
            // Resources and prompts of the same servers (M8).
            ["mcp", "request"] => self.storage("mcp.request", body, Duration::from_secs(60)),
            ["browser", action @ ("launch" | "close" | "list")] => crate::browser::route(&self.sup, &self.cdp, action, body),
            #[cfg(unix)]
            ["bridge", action @ ("call" | "status")] => crate::bridge::route(&self.sup, action, body),
            // Out-of-band management is the Hub's own (D6): never through novad.
            ["oob", ..] => Err(OpError::new(403, "oob_disabled", "out-of-band management is off (FR-147)")),
            _ => Err(OpError::not_found("unknown management route")),
        }
    }

    /// Managed services (FR-145): module services through the supervisor, systemd units through
    /// the management module.
    /// Every service the device owner declared (FR-145) with its state now, for the Hub's list. A
    /// service whose status cannot be read is listed with state `unknown` and the reason.
    fn services(&self) -> OpResult<Value> {
        let cfg = self.data.config()?;
        let list: Vec<Value> = cfg
            .services
            .iter()
            .map(|svc| match self.service(&svc.name, "status") {
                Ok(v) => v["service"].clone(),
                Err(e) => json!({ "name": svc.name, "kind": svc.kind, "state": "unknown", "error": e.message }),
            })
            .collect();
        Ok(json!({ "services": list }))
    }

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
        // The Hub's firmware and boot toggles (D3) ride in `policy` beside the per-device policy
        // (FR-150), so a toggle the owner just turned on holds before the next heartbeat. Sent
        // alone they merge into `policy.json` and leave the rest of the policy as it is.
        let mut toggles = None;
        if let Some(p) = body.get("policy").filter(|v| !v.is_null()) {
            let obj = p.as_object().ok_or_else(|| OpError::validation("policy must be an object"))?;
            let (t, rest): (serde_json::Map<String, Value>, serde_json::Map<String, Value>) = obj.clone().into_iter().partition(|(k, _)| k == "firmwareChanges" || k == "lowLevelBoot");
            if !rest.is_empty() || t.is_empty() {
                hub.policy = serde_json::from_value(Value::Object(rest)).map_err(|e| OpError::validation(format!("policy: {e}")))?;
            }
            if !t.is_empty() {
                toggles = Some(Value::Object(t));
            }
            if let Some(list) = &hub.policy.allowed_modules {
                // `firmware` is a module of the capability document, run by the supervisor itself.
                if let Some(bad) = list.iter().find(|m| !capabilities::DOCUMENT_MODULES.contains(&m.as_str())) {
                    return Err(OpError::validation(format!("unknown module {bad}")));
                }
            }
        }
        if let Some(c) = body.get("updateChannel").filter(|v| !v.is_null()) {
            let c = c.as_str().filter(|c| crate::state::CHANNELS.contains(c)).ok_or_else(|| OpError::validation("updateChannel must be stable, beta or nightly"))?;
            hub.update_channel = Some(c.to_string());
        }
        hub.revision = body["revision"].as_u64().unwrap_or(hub.revision + 1);
        let privileged = match &toggles {
            Some(t) => self.data.merge_privileged_policy(t)?,
            None => self.data.privileged_policy(),
        };
        self.data.save_hub_config(&hub)?;
        self.apply_policy(&hub);
        let (capability, signature) = self.capability()?;
        Ok(json!({
            "capability": capability, "signature": signature, "revision": hub.revision, "modules": self.sup.statuses(),
            // The toggles in effect, for the Hub to confirm.
            "policy": { "firmwareChanges": privileged.firmware_changes, "lowLevelBoot": privileged.low_level_boot },
        }))
    }

    /// One heartbeat. Returns false when the Hub revoked this device.
    pub fn heartbeat(&self, pending_events: &mut Vec<Value>, beat: u64) -> bool {
        let d = self.device();
        let (Some(hub), Some(cred)) = (d.hub_url.clone(), d.credential.clone()) else { return false };
        pending_events.extend(self.sup.drain_events());
        // Watchdog results wait in files until a heartbeat carries them (they survive restarts).
        let kept: Vec<Value> = self.firmware.outbox.pending().into_iter().chain(self.boot.outbox.pending()).collect();
        let room = 500usize.saturating_sub(kept.len());
        if pending_events.len() > room {
            let n = pending_events.len() - room;
            pending_events.drain(..n);
        }
        let decisions = self.sup.call("storage", "fs.unreported", json!({}), Duration::from_secs(5)).map(|v| v["decisions"].clone()).unwrap_or(json!([]));
        let mut body = json!({
            "novadVersion": VERSION,
            "modules": self.sup.statuses(),
            "events": pending_events.iter().chain(kept.iter()).cloned().collect::<Vec<_>>(),
            "accessDecisions": decisions,
        });
        // The address the Hub calls, https:// once the device holds a certificate (D1).
        if let Some(e) = &d.endpoint {
            body["endpoint"] = json!(crate::mgmt_tls::advertised_endpoint(&self.data, e));
        }
        if beat % 6 == 0 {
            if let Ok(p) = self.sup.call("management", "power.status", json!({}), Duration::from_secs(5)) {
                body["power"] = p;
            }
        }
        let tls = self.tls();
        match http::post_json_with(&format!("{hub}/agent/v1/heartbeat"), Some(&cred), &body, HUB_TIMEOUT, tls.as_deref()) {
            Ok((200, resp)) => {
                pending_events.clear();
                self.firmware.outbox.ack(&kept);
                self.boot.outbox.ack(&kept);
                // The Hub's toggles for firmware changes and low-level boot (D3).
                if let Some(p) = resp.get("policy").filter(|p| p.is_object())
                    && let Err(e) = self.data.save_privileged_policy(p)
                {
                    eprintln!("novad: cannot save the Hub's policy: {e}");
                }
                // A change waiting for this restart to be confirmed is confirmed now.
                self.firmware.on_beat(now_ms());
                self.boot.on_beat(now_ms());
                // The pinned Hub key that checks authorizations (D2), read once while the Hub answers.
                if !self.data.path().join(crate::authz::KEY_FILE).exists() && TlsContext::for_data(&self.data).is_some() {
                    let _ = crate::authz::hub_key(&self.data);
                }
                // A renewed device certificate (one without serverAuth, or a third of its life
                // left): checked, swapped in; the management server reads it per connection and
                // the calls to the Hub present it from the next request.
                if let Some(pem) = resp["certificate"]["pem"].as_str() {
                    match crate::mgmt_tls::renew(&self.data, pem, now_ms() / 1000) {
                        Ok(true) => {
                            *self.tls.lock().unwrap_or_else(|p| p.into_inner()) = TlsContext::for_data(&self.data).map(Arc::new);
                            eprintln!("novad: the device certificate was renewed");
                        }
                        Ok(false) => {}
                        Err(why) => eprintln!("novad: the renewed device certificate was refused ({why}); keeping the current one"),
                    }
                }
                // What the Hub grants this device (docs/22 §4.2): the local runtime refuses
                // without `local-runtime` (FR-128).
                if let Some(list) = resp["scopes"].as_array() {
                    let scopes: Vec<String> = list.iter().filter_map(|v| v.as_str().map(str::to_string)).collect();
                    if let Err(e) = self.data.save_granted_scopes(&scopes) {
                        eprintln!("novad: cannot save the granted scopes: {e}");
                    }
                }
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
            Ok((403, resp)) if resp["error"]["details"]["reason"].as_str().is_some_and(|r| r.starts_with("certificate_")) => {
                // Mutual TLS (FR-126): the Hub wants this device's certificate, or refused it.
                eprintln!(
                    "novad: the Hub refused this device over HTTPS ({}): {}",
                    resp["error"]["details"]["reason"].as_str().unwrap_or_default(),
                    resp["error"]["message"].as_str().unwrap_or("add the device again")
                );
                true
            }
            Ok((status, _)) => {
                eprintln!("novad: heartbeat refused with {status}");
                true
            }
            Err(e) => {
                eprintln!("novad: heartbeat failed: {e}");
                self.try_https(&hub);
                true
            }
        }
    }

    fn send_capability(&self) {
        let d = self.device();
        let (Some(hub), Some(cred)) = (d.hub_url, d.credential) else { return };
        if let Ok((capability, signature)) = self.capability() {
            let body = json!({ "capability": capability, "signature": signature, "novadVersion": VERSION });
            if let Err(e) = http::post_json_with(&format!("{hub}/agent/v1/capabilities"), Some(&cred), &body, HUB_TIMEOUT, self.tls().as_deref()) {
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
    // A certificate or Hub trust from an earlier enrollment belongs to that key and Hub.
    for path in [data.seed_path(), data.path().join(crate::tls::DEVICE_CERT_FILE), data.path().join(crate::tls::TRUST_FILE)] {
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("cannot rotate the device key ({}): {e}", path.display())),
        }
    }
    let mut out = register(&data, a, exe)?;
    // A client's local browser runs as dedicated users, never root or nobody (FR-209).
    if crate::hardening::is_root() && a.roles.iter().any(|r| r == "client") {
        match crate::browser::ensure_users(&crate::power::SystemRunner, &crate::user_socket::SystemUsers) {
            Ok(made) => out["browserUsers"] = json!(made),
            Err(e) => eprintln!("novad: the local browser stays off until its users exist: {e}"),
        }
    }
    Ok(out)
}

/// The Hub trust for registering (FR-134): the pin is kept in `hub-trust.json` with what the
/// install's verified connections vouched for; over http:// the Hub local CA is learned from the
/// Hub's signed identity statement, so the device can use HTTPS once the Hub serves it. Without
/// a pin there is no TLS context (http:// only).
fn prepare_trust(data: &DataDir, a: &crate::cli::EnrollArgs) -> Result<Option<TlsContext>, String> {
    let path = data.path().join(crate::tls::TRUST_FILE);
    if let Some(pin) = &a.pin {
        let kept = HubTrust::load(&path).filter(|t| t.pin.as_deref() == Some(pin.as_str()));
        kept.unwrap_or_else(|| HubTrust::pinned(pin)).save(&path).map_err(|e| format!("cannot save {}: {e}", path.display()))?;
    }
    let Some(ctx) = TlsContext::for_data(data) else { return Ok(None) };
    if !http::is_https(&a.hub) {
        match crate::tls::learn_ca_over_http(a.hub.trim_end_matches('/'), &ctx, HUB_TIMEOUT) {
            Ok(true) => eprintln!("novad: learned the Hub local CA from its signed identity"),
            Ok(false) => {}
            // Not fatal over http://: the pin still protects a later move to HTTPS.
            Err(e) => eprintln!("novad: the Hub local CA was not learned: {e}"),
        }
    }
    Ok(Some(ctx))
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
    // With a device certificate the management channel is mutual TLS, so the endpoint is https (D1).
    let endpoint = crate::mgmt_tls::advertised_endpoint(data, &a.endpoint);
    state.endpoint = Some(endpoint.clone());
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
        "endpoint": endpoint,
        "publicKey": data.public_key().map_err(|e| e.to_string())?,
        "capability": capability,
        "signature": signature,
        "managementToken": mgmt,
        "novadVersion": VERSION,
        "protocolVersions": PROTOCOL_VERSIONS,
    });
    // A new enrollment starts with no grant: the old scopes (`local-runtime`) belong to the device
    // the Hub knew before; the first heartbeat answer brings this one's.
    match std::fs::remove_file(data.scopes_path()) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("cannot clear the old scopes: {e}")),
    }
    // The same for the Hub's firmware and boot toggles (D3): off until this device's first answer.
    match std::fs::remove_file(data.policy_path()) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("cannot clear the old policy: {e}")),
    }
    // Users who get their own local runtime socket (FR-128): the owner's setting, kept on re-enroll
    // unless --user names others.
    if !a.users.is_empty() {
        let mut cfg = data.config().map_err(|e| e.to_string())?;
        cfg.local_runtime.users = a.users.clone();
        crate::util::write_json(&data.config_path(), &cfg, false).map_err(|e| e.to_string())?;
    }
    let tls = prepare_trust(data, a)?;
    let (status, resp) = http::post_json_with(&format!("{}/agent/v1/register", a.hub.trim_end_matches('/')), None, &body, HUB_TIMEOUT, tls.as_ref())?;
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
    Ok(json!({ "deviceId": state.device_id, "name": name, "endpoint": endpoint }))
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
    // A firmware or boot change made before a restart is now waiting for its confirmation.
    agent.firmware.on_start();
    agent.boot.on_start();
    agent.apply_policy(&data.hub_config().unwrap_or_default());
    agent.sup.start_all();
    let _monitor = agent.sup.spawn_monitor(Duration::from_millis(200));
    let listener = std::net::TcpListener::bind(&listen).map_err(|e| format!("cannot listen on {listen}: {e}"))?;
    let handler_agent = agent.clone();
    // A device with a certificate serves mutual TLS only (D1); never plain HTTP as a fallback.
    let tls = crate::authz::has_certificate(&data);
    let server = if tls {
        crate::mgmt_tls::serve(listener, MAX_BODY, data.clone(), Arc::new(move |req| handler_agent.handle_on(req, Transport::MutualTls)))
    } else {
        http::serve(listener, MAX_BODY, Arc::new(move |req| handler_agent.handle(req)))
    };
    eprintln!("novad {VERSION}: supervisor running; management channel on {}{}", server.local_addr(), if tls { " (mutual TLS)" } else { "" });
    let mut events = vec![];
    let mut beat: u64 = 0;
    agent.send_capability();
    // Extension bridge events go to the Hub as they come (FR-096).
    #[cfg(unix)]
    crate::bridge::spawn_pump(agent.clone());
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
            // The firmware and boot watchdogs (FR-143, FR-146), about once a second.
            if now_ms() % 1000 < 100 {
                agent.firmware.tick(now_ms());
                agent.boot.tick(now_ms());
            }
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
        assert_eq!(a.handle(req("/agent/v1/oob/power", Some("nvdm_test"), json!({}))).status, 403);
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

    /// An agent enrolled as `dev-1` with the test Hub pinned, fake firmware and a fake bootloader.
    fn device_ops_agent(dir: &std::path::Path) -> Agent {
        use crate::tls::tests::{HUB_SEED, hub_pin};
        let a = agent(dir);
        let mut d = a.device();
        d.device_id = Some("dev-1".into());
        d.endpoint = Some("http://10.0.0.9:7420".into());
        a.data.save_device(&d).unwrap();
        *a.state.lock().unwrap() = d;
        HubTrust::pinned(&hub_pin()).save(&a.data.path().join(crate::tls::TRUST_FILE)).unwrap();
        crate::authz::save_hub_key(&a.data, &b64url_encode(&SigningKey::from_seed(&HUB_SEED).public_key())).unwrap();
        let fw = dir.join("firmware.json");
        crate::util::write_json(&fw, &json!({ "platform": { "vendor": "Nova Labs", "uefi": true }, "settings": { "wol": { "vendorKey": "WakeOnLan", "value": "Disabled", "type": "enum", "allowed": ["Disabled", "Enabled"] } } }), false).unwrap();
        let bl = dir.join("bootloader.json");
        crate::util::write_json(&bl, &json!({ "entries": [{ "id": "a.conf" }, { "id": "b.conf" }], "default": "a.conf", "booted": "a.conf" }), false).unwrap();
        let mut cfg = serde_json::to_value(a.data.config().unwrap()).unwrap();
        cfg["firmware"] = json!({ "backend": "fake", "fakePath": fw });
        cfg["boot"] = json!({ "backend": "fake", "fakePath": bl });
        crate::util::write_json(&a.data.config_path(), &cfg, false).unwrap();
        a
    }

    #[test]
    fn routes_firmware_and_boot_with_the_transport() {
        use crate::authz::tests::signed;
        use crate::tls::tests::HUB_SEED;
        let dir = tmp("agent-ops");
        let a = device_ops_agent(&dir);
        let call = |path: &str, b: Value, t: Transport| {
            let r = a.handle_on(req(path, Some("nvdm_test"), b), t);
            (r.status, body(&r))
        };
        let (status, read) = call("/agent/v1/firmware/read", json!({}), Transport::Plain);
        assert_eq!((status, read["method"].as_str()), (200, Some("fake")));
        assert_eq!(a.handle(req("/agent/v1/firmware/read", None, json!({}))).status, 401, "the token is still required");
        let (_, plan) = call("/agent/v1/firmware/plan", json!({ "changes": [{ "key": "wol", "value": "Enabled" }] }), Transport::Plain);
        let apply = json!({ "planId": plan["planId"], "snapshotId": plan["snapshot"]["id"], "changes": [{ "key": "wol", "value": "Enabled" }], "reboot": false });
        let (status, off) = call("/agent/v1/firmware/apply", signed(&HUB_SEED, "firmware.apply", &apply, now_ms()), Transport::Plain);
        assert_eq!((status, off["error"]["code"].as_str()), (403, Some("firmware_disabled")));
        a.data.save_privileged_policy(&json!({ "firmwareChanges": true, "lowLevelBoot": true })).unwrap();
        // With a certificate on the device, plain HTTP is refused before anything else.
        std::fs::write(a.data.path().join(crate::tls::DEVICE_CERT_FILE), "x").unwrap();
        let approved = signed(&HUB_SEED, "firmware.apply", &apply, now_ms());
        let (status, plain) = call("/agent/v1/firmware/apply", approved.clone(), Transport::Plain);
        assert_eq!((status, plain["error"]["details"]["reason"].as_str()), (403, Some("tls_required")));
        let (status, done) = call("/agent/v1/firmware/apply", approved, Transport::MutualTls);
        assert_eq!((status, done["applied"][0]["to"].as_str()), (200, Some("Enabled")), "{done}");
        let (status, boot) = call("/agent/v1/boot/status", json!({}), Transport::Plain);
        assert_eq!((status, boot["bootloader"].as_str()), (200, Some("fake")));
        let set = signed(&HUB_SEED, "boot.set", &json!({ "profileId": "lab", "entryId": "b.conf", "reboot": false }), now_ms());
        assert_eq!(call("/agent/v1/boot/set", set.clone(), Transport::Plain).0, 403);
        let (status, set) = call("/agent/v1/boot/set", set, Transport::MutualTls);
        assert_eq!((status, set["pending"]["entryId"].as_str()), (200, Some("b.conf")));
        assert_eq!(call("/agent/v1/boot/nope", json!({}), Transport::MutualTls).0, 404);
        assert_eq!(call("/agent/v1/firmware", json!({}), Transport::MutualTls).0, 404);
        // The Hub may allow the firmware module by name; the document then lists it.
        let (status, cfg) = call("/agent/v1/config", json!({ "policy": { "allowedModules": ["storage", "compute", "firmware"] } }), Transport::MutualTls);
        assert_eq!(status, 200, "{cfg}");
        assert!(cfg["capability"]["modules"].as_array().unwrap().contains(&json!("firmware")));
        a.sup.stop_all();
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn config_pushes_the_privileged_toggles_at_once() {
        use crate::authz::tests::signed;
        use crate::tls::tests::HUB_SEED;
        let dir = tmp("agent-config-toggles");
        let a = device_ops_agent(&dir);
        let config = |b: Value| {
            let r = a.handle(req("/agent/v1/config", Some("nvdm_test"), b));
            assert_eq!(r.status, 200, "{}", String::from_utf8_lossy(&r.body));
            body(&r)["policy"].clone()
        };
        assert_eq!(config(json!({ "policy": { "allowedModules": ["storage", "compute", "firmware"] } })), json!({ "firmwareChanges": false, "lowLevelBoot": false }));
        // Turned on by the owner: pushed at once, merged, the rest of the policy kept.
        assert_eq!(config(json!({ "policy": { "firmwareChanges": true }, "revision": 7 })), json!({ "firmwareChanges": true, "lowLevelBoot": false }));
        assert_eq!(a.data.hub_config().unwrap().policy.allowed_modules, Some(vec!["storage".to_string(), "compute".into(), "firmware".into()]));
        assert_eq!(a.data.hub_config().unwrap().revision, 7);
        // A privileged action right after is no longer refused for the toggle.
        let (plan_status, plan) = {
            let r = a.handle(req("/agent/v1/firmware/plan", Some("nvdm_test"), json!({ "changes": [{ "key": "wol", "value": "Enabled" }] })));
            (r.status, body(&r))
        };
        assert_eq!(plan_status, 200);
        let apply = json!({ "planId": plan["planId"], "snapshotId": plan["snapshot"]["id"], "changes": [{ "key": "wol", "value": "Enabled" }] });
        let r = a.handle(req("/agent/v1/firmware/apply", Some("nvdm_test"), signed(&HUB_SEED, "firmware.apply", &apply, now_ms())));
        assert_eq!(r.status, 200, "{}", String::from_utf8_lossy(&r.body));
        // Both with the full policy; only `true` counts; an absent toggle keeps its value.
        assert_eq!(config(json!({ "policy": { "allowedModules": ["storage", "compute", "firmware"], "lowLevelBoot": true } })), json!({ "firmwareChanges": true, "lowLevelBoot": true }));
        assert_eq!(config(json!({ "policy": { "firmwareChanges": "yes" } })), json!({ "firmwareChanges": false, "lowLevelBoot": true }));
        assert_eq!(config(json!({ "updateChannel": "beta" })), json!({ "firmwareChanges": false, "lowLevelBoot": true }), "no policy: answered as is");
        let p = a.data.privileged_policy();
        assert_eq!((p.firmware_changes, p.low_level_boot), (false, true));
        // A policy that is not an object is refused, nothing changed.
        assert_eq!(a.handle(req("/agent/v1/config", Some("nvdm_test"), json!({ "policy": [true] }))).status, 400);
        // An empty policy still resets the per-device policy, as before.
        config(json!({ "policy": {} }));
        assert_eq!(a.data.hub_config().unwrap().policy.allowed_modules, None);
        a.sup.stop_all();
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn heartbeats_carry_watchdog_events_the_policy_and_the_https_endpoint() {
        let dir = tmp("agent-hb-ops");
        let a = device_ops_agent(&dir);
        a.state.lock().unwrap().credential = Some("nvc_test".into());
        let seen: Arc<Mutex<Vec<Value>>> = Arc::default();
        let s = seen.clone();
        let server = http::serve(
            std::net::TcpListener::bind("127.0.0.1:0").unwrap(),
            1 << 20,
            Arc::new(move |req: Request| {
                s.lock().unwrap().push(req.json().unwrap());
                Response::json(200, &json!({ "ok": true, "heartbeatIntervalMs": 10_000, "scopes": [], "policy": { "firmwareChanges": true, "lowLevelBoot": false } }))
            }),
        );
        a.state.lock().unwrap().hub_url = Some(format!("http://{}", server.local_addr()));
        a.firmware.outbox.push(json!({ "kind": "firmware.watchdog.reverted", "snapshotId": "s1", "at": now_iso(), "detail": {} }));
        assert!(!a.data.privileged_policy().firmware_changes);
        assert!(a.heartbeat(&mut vec![json!({ "module": "storage", "kind": "started" })], 1));
        let sent = seen.lock().unwrap()[0].clone();
        assert_eq!(sent["endpoint"], "http://10.0.0.9:7420", "no certificate: plain");
        assert_eq!(sent["events"].as_array().unwrap().iter().map(|e| e["kind"].as_str().unwrap()).collect::<Vec<_>>(), vec!["started", "firmware.watchdog.reverted"]);
        assert!(a.firmware.outbox.pending().is_empty(), "delivered, so dropped");
        let p = a.data.privileged_policy();
        assert_eq!((p.firmware_changes, p.low_level_boot), (true, false));
        std::fs::write(a.data.path().join(crate::tls::DEVICE_CERT_FILE), "x").unwrap();
        assert!(a.heartbeat(&mut vec![], 2));
        assert_eq!(seen.lock().unwrap()[1]["endpoint"], "https://10.0.0.9:7420");
        server.stop();
        a.sup.stop_all();
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn heartbeats_swap_in_a_renewed_certificate() {
        use crate::mgmt_tls::tests::{device_with_certificate, issue};
        use rcgen::{ExtendedKeyUsagePurpose, KeyPair};
        let dir = tmp("agent-renew");
        let a = agent(&dir);
        // The device folder of a certificate holder, under this agent.
        let (base, data, pki) = device_with_certificate("agent-renew-data");
        for f in ["key.seed", "device-cert.pem", crate::tls::TRUST_FILE, "device.json"] {
            std::fs::copy(data.path().join(f), a.data.path().join(f)).unwrap();
        }
        *a.tls.lock().unwrap() = TlsContext::for_data(&a.data).map(Arc::new);
        let before = a.tls().unwrap();
        let key = KeyPair::try_from(crate::tls::ed25519_pkcs8(&crate::tls::tests::DEVICE_SEED).as_slice()).unwrap();
        let renewed = issue(&pki, &key, &["urn:nova:device:dev-1"], vec![ExtendedKeyUsagePurpose::ClientAuth, ExtendedKeyUsagePurpose::ServerAuth]);
        let wrong = issue(&pki, &KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).unwrap(), &["urn:nova:device:dev-1"], vec![ExtendedKeyUsagePurpose::ClientAuth, ExtendedKeyUsagePurpose::ServerAuth]);
        let offer = Arc::new(Mutex::new(crate::tls::pem_certificate(&wrong)));
        let o = offer.clone();
        let server = http::serve(
            std::net::TcpListener::bind("127.0.0.1:0").unwrap(),
            1 << 20,
            Arc::new(move |_: Request| Response::json(200, &json!({ "ok": true, "heartbeatIntervalMs": 10_000, "scopes": [], "certificate": { "pem": o.lock().unwrap().clone(), "notAfter": "2036-01-01T00:00:00.000Z" } }))),
        );
        let mut d = a.device();
        d.hub_url = Some(format!("http://{}", server.local_addr()));
        d.credential = Some("nvc_test".into());
        *a.state.lock().unwrap() = d;
        let held = || crate::tls::pem_certificates(&std::fs::read_to_string(a.data.path().join(crate::tls::DEVICE_CERT_FILE)).unwrap());
        let old = held();
        assert!(a.heartbeat(&mut vec![], 1));
        assert_eq!(held(), old, "a certificate for another key is refused");
        assert!(Arc::ptr_eq(&before, &a.tls().unwrap()));
        *offer.lock().unwrap() = crate::tls::pem_certificate(&renewed);
        assert!(a.heartbeat(&mut vec![], 2));
        assert_eq!(held(), vec![renewed]);
        assert!(!Arc::ptr_eq(&before, &a.tls().unwrap()), "the next call to the Hub presents the new one");
        server.stop();
        a.sup.stop_all();
        std::fs::remove_dir_all(&dir).unwrap();
        std::fs::remove_dir_all(&base).unwrap();
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
        let list = body(&a.handle(req("/agent/v1/services", Some("nvdm_test"), json!({}))));
        assert_eq!(list["services"][0]["name"], "compute");
        assert_eq!(list["services"][0]["kind"], "module");
        assert_eq!(list["services"][0]["state"], "running");
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
    fn heartbeats_keep_the_granted_scopes_and_move_to_https() {
        use crate::tls::tests::{Pki, hello, hub_pin, statement, test_hub, HUB_SEED};
        let dir = tmp("agent-hb");
        let a = agent(&dir);
        a.state.lock().unwrap().credential = Some("nvc_test".into());
        let server = http::serve(
            std::net::TcpListener::bind("127.0.0.1:0").unwrap(),
            1 << 20,
            Arc::new(|req: Request| {
                assert_eq!(req.bearer(), Some("nvc_test"));
                Response::json(200, &json!({ "ok": true, "heartbeatIntervalMs": 10_000, "capabilityRequested": false, "scopes": ["local-runtime", "files"] }))
            }),
        );
        a.state.lock().unwrap().hub_url = Some(format!("http://{}", server.local_addr()));
        assert!(a.heartbeat(&mut vec![], 1));
        assert_eq!(a.data.granted_scopes(), vec!["files".to_string(), "local-runtime".to_string()]);
        server.stop();
        // The Hub restarted with HTTPS on its address: the plain heartbeat fails, the pinned
        // identity vouches for the certificate, and the device uses https:// from then on.
        let pki = Pki::new("Nova Hub CA");
        let (leaf, key) = pki.leaf(&["127.0.0.1"]);
        let (ca, l) = (pki.ca_der.clone(), leaf.clone());
        let tls_hub = test_hub(vec![leaf, pki.ca_der.clone()], key, None, Arc::new(move |n| statement(&HUB_SEED, n, &[("ca", &ca), ("leaf", &l)])), Arc::new(hello));
        a.state.lock().unwrap().hub_url = Some(format!("http://127.0.0.1:{}", tls_hub.port));
        assert!(a.heartbeat(&mut vec![], 1), "no 401: still enrolled");
        assert_eq!(a.device().hub_url, Some(format!("http://127.0.0.1:{}", tls_hub.port)), "no pin, no move");
        *a.tls.lock().unwrap() = Some(Arc::new(TlsContext::new(HubTrust::pinned(&hub_pin()))));
        assert!(a.heartbeat(&mut vec![], 1));
        assert_eq!(a.device().hub_url, Some(format!("https://127.0.0.1:{}", tls_hub.port)));
        assert_eq!(a.data.device().unwrap().unwrap().hub_url, a.device().hub_url, "saved");
        // At most one attempt a minute.
        a.state.lock().unwrap().hub_url = Some(format!("http://127.0.0.1:{}", tls_hub.port));
        assert!(!a.try_https(&format!("http://127.0.0.1:{}", tls_hub.port)));
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
