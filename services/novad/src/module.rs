//! A module process (`novad module <name>`, docs/23 §4). It hardens itself, then answers the
//! supervisor's requests on stdin with one JSON line each on stdout, and exits when stdin closes
//! (the supervisor stopped it or died). Each request runs on its own thread, so a long command
//! does not hold up a file listing.
//!
//! - storage: device file operations, folder grants, sandboxed commands, local MCP pass-through
//!   (FR-210, FR-081).
//! - management: power, Wake-on-LAN and systemd services (FR-144, FR-145).
//! - local-runtime: proxies the device's local model server to authenticated local clients once
//!   the Hub granted the scope (FR-128, src/local_runtime.rs).
//! - browser: the local browser fallback's sessions on Chromium and the extension bridge (FR-209,
//!   FR-096, src/browser.rs).
//! - compute, screen, capture: answer `ping` and `status`; their work arrives with their areas
//!   (inference supervision, FR-207 computer use, FR-228 capture).

use crate::exec::{ExecSpec, find_bwrap};
use crate::fsops::Storage;
use crate::grants::Grantee;
use crate::hardening::harden_self;
use crate::power::{Power, Runner, SystemRunner};
use crate::state::DataDir;
use crate::util::{OpError, OpResult};
use serde_json::{Value, json};
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

const MAX_IN_FLIGHT: usize = 16;

pub struct Context {
    pub name: String,
    pub data: DataDir,
    pub storage: Storage,
    pub procs: crate::procs::Procs,
    pub bwrap: Option<PathBuf>,
    pub power: Option<Power>,
    pub runner: Box<dyn Runner>,
    /// The local runtime (only in the `local-runtime` module), or why it could not start.
    pub runtime: Option<Result<Arc<crate::local_runtime::Runtime>, OpError>>,
    /// The browser sessions and the extension bridge (only in the `browser` module, FR-209, FR-096).
    pub browser: Option<Arc<crate::browser::Module>>,
}

impl Context {
    pub fn new(name: &str, data_dir: &Path) -> Self {
        let data = DataDir(data_dir.to_path_buf());
        let runtime = (name == crate::local_runtime::MODULE).then(|| crate::local_runtime::Runtime::new(&data).map(Arc::new));
        let browser = (name == crate::browser::MODULE).then(|| Arc::new(crate::browser::Module::new(&data.config().unwrap_or_default(), data_dir)));
        let power = (name == "management").then(|| {
            let cfg = data.config().unwrap_or_default();
            let mut p = Power::system(cfg.power.allow_changes, cfg.power.allow_actions);
            // Power-on-after-power-loss from the BIOS backend, read-only (FR-144, FR-146).
            let d = data.clone();
            p.after_power_loss = Some(Box::new(move || crate::firmware::Firmware::reader(d.clone()).after_power_loss()));
            p
        });
        Context {
            name: name.into(),
            storage: Storage::new(data_dir),
            procs: crate::procs::Procs::default(),
            data,
            bwrap: find_bwrap(),
            power,
            runner: Box::new(SystemRunner),
            runtime,
            browser,
        }
    }
}

fn grantee(args: &Value) -> OpResult<Grantee> {
    Grantee::parse(&args["grantee"])
}

fn s<'a>(args: &'a Value, key: &str) -> OpResult<&'a str> {
    args[key].as_str().ok_or_else(|| OpError::validation(format!("{key} is required")))
}

/// Handle one operation.
pub fn handle(ctx: &Context, op: &str, args: &Value) -> OpResult<Value> {
    if op == "ping" {
        return Ok(json!({ "pong": true, "module": ctx.name, "version": env!("CARGO_PKG_VERSION"), "pid": std::process::id() }));
    }
    match ctx.name.as_str() {
        "storage" => storage_op(ctx, op, args),
        "management" => management_op(ctx, op, args),
        crate::browser::MODULE => match &ctx.browser {
            Some(b) => crate::browser::op(b, op, args),
            None => Err(OpError::internal("the browser module is not set up")),
        },
        crate::local_runtime::MODULE => match &ctx.runtime {
            Some(Ok(rt)) => rt.op(op, args),
            Some(Err(e)) if op == "status" => Ok(json!({ "module": ctx.name, "ready": false, "error": e.message })),
            Some(Err(e)) => Err(e.clone()),
            None => Err(OpError::internal("the local runtime is not set up")),
        },
        _ if op == "status" => Ok(json!({ "module": ctx.name, "ready": true })),
        _ => Err(OpError::not_found(format!("the {} module has no operation {op}", ctx.name))),
    }
}

fn storage_op(ctx: &Context, op: &str, args: &Value) -> OpResult<Value> {
    let st = &ctx.storage;
    match op {
        "fs.list" => st.list(&grantee(args)?, s(args, "path")?),
        "fs.stat" => st.stat(&grantee(args)?, s(args, "path")?),
        "fs.read" => st.read(&grantee(args)?, s(args, "path")?, args["maxBytes"].as_u64()),
        "fs.stage" => st.stage(
            &grantee(args)?,
            s(args, "path")?,
            args["baseSha256"].as_str(),
            s(args, "contentBase64")?,
            args["createDirs"].as_bool().unwrap_or(false),
            args["sessionRef"].as_str(),
        ),
        "fs.commit" => st.commit(&grantee(args)?, s(args, "stagedId")?),
        "fs.discard" => st.discard(&grantee(args)?, s(args, "stagedId")?),
        "fs.delete" => st.delete(&grantee(args)?, s(args, "path")?),
        "fs.move" => st.move_path(&grantee(args)?, s(args, "from")?, s(args, "to")?),
        "fs.requestAccess" => {
            let kind = args["kind"].as_str().unwrap_or("folder");
            let target = args["path"].as_str().or(args["target"].as_str()).ok_or_else(|| OpError::validation("path is required"))?;
            let r = st.grants.request(&grantee(args)?, kind, target, args["access"].as_str().unwrap_or("read"), args["reason"].as_str().map(str::to_string))?;
            Ok(json!({ "request": r }))
        }
        "fs.grant" => {
            let r = st.grants.grant(&grantee(args)?, args["kind"].as_str().unwrap_or("folder"), s(args, "target")?, args["access"].as_str().unwrap_or("read"), "hub")?;
            Ok(json!({ "request": r }))
        }
        "fs.decide" => {
            let grant = match s(args, "decision")? {
                "grant" => true,
                "deny" => false,
                _ => return Err(OpError::validation("decision must be grant or deny")),
            };
            // Decisions over the management channel are the Hub's; device-side ones use the
            // `novad access` command.
            Ok(json!({ "request": st.grants.decide(s(args, "requestId")?, grant, "hub")? }))
        }
        "fs.grants" => {
            let f = st.grants.load()?;
            let g = args.get("grantee").filter(|v| !v.is_null()).map(Grantee::parse).transpose()?;
            let keep = |x: &Grantee| g.as_ref().is_none_or(|g| g == x);
            Ok(json!({
                "grants": f.grants.iter().filter(|x| keep(&x.grantee)).collect::<Vec<_>>(),
                "requests": f.requests.iter().filter(|x| keep(&x.grantee)).collect::<Vec<_>>(),
            }))
        }
        "fs.revoke" => {
            if let Some(id) = args["grantId"].as_str() {
                Ok(json!({ "revoked": st.grants.revoke(id)? }))
            } else {
                Ok(json!({ "revoked": st.grants.revoke_grantee(&grantee(args)?)? > 0 }))
            }
        }
        "fs.unreported" => Ok(json!({ "decisions": st.grants.unreported()? })),
        "fs.markReported" => {
            let ids: Vec<String> = args["ids"].as_array().into_iter().flatten().filter_map(|v| v.as_str().map(str::to_string)).collect();
            st.grants.mark_reported(&ids)?;
            Ok(json!({ "ok": true }))
        }
        "fs.sweep" => Ok(json!({ "discarded": st.sweep() })),
        "exec" => crate::exec::run(&st.grants, &grantee(args)?, &ExecSpec::parse(args)?, ctx.bwrap.as_deref()),
        "proc.spawn" => ctx.procs.spawn(&st.grants, &grantee(args)?, args, ctx.bwrap.as_deref()),
        "proc.read" => ctx.procs.read(
            &grantee(args)?,
            s(args, "id")?,
            args["offset"].as_u64().unwrap_or(0),
            args["waitMs"].as_u64().unwrap_or(0),
        ),
        "proc.write" => ctx.procs.write(&grantee(args)?, s(args, "id")?, args),
        "proc.list" => Ok(ctx.procs.list(&grantee(args)?)),
        "mcp.list" => crate::mcp::list(&ctx.data.config()?.mcp_servers, &st.grants, &grantee(args)?),
        "mcp.call" => crate::mcp::call(
            &ctx.data.config()?.mcp_servers,
            &st.grants,
            &grantee(args)?,
            s(args, "server")?,
            s(args, "tool")?,
            args.get("arguments").cloned().unwrap_or(json!({})),
        ),
        _ => Err(OpError::not_found(format!("the storage module has no operation {op}"))),
    }
}

fn management_op(ctx: &Context, op: &str, args: &Value) -> OpResult<Value> {
    let power = ctx.power.as_ref().ok_or_else(|| OpError::internal("power is not set up"))?;
    match op {
        "power.status" => Ok(power.status()),
        "power.wolPlan" => Ok(json!({ "plan": power.wol_plan(), "needsElevation": true })),
        "power.wolEnable" => power.wol_enable(args["apply"].as_bool().unwrap_or(false)),
        "power.action" => power.action(s(args, "action")?),
        "service.systemd" => {
            let unit = s(args, "unit")?;
            let action = s(args, "action")?;
            if !matches!(action, "start" | "stop" | "restart" | "is-active") {
                return Err(OpError::validation("action must be start, stop, restart or is-active"));
            }
            if unit.is_empty() || unit.starts_with('-') || unit.contains('/') {
                return Err(OpError::validation("invalid unit name"));
            }
            let (code, out, err) = ctx
                .runner
                .run(&["systemctl".into(), action.into(), unit.into()])
                .map_err(|e| OpError::internal(e.to_string()))?;
            if action == "is-active" {
                return Ok(json!({ "unit": unit, "state": out.trim() }));
            }
            if code != 0 {
                return Err(OpError::internal(format!("systemctl {action} {unit} failed: {}", err.trim())));
            }
            Ok(json!({ "unit": unit, "ok": true }))
        }
        _ => Err(OpError::not_found(format!("the management module has no operation {op}"))),
    }
}

/// The module's main loop.
pub fn main_loop(name: &str, data_dir: &Path) -> i32 {
    harden_self();
    let ctx = Arc::new(Context::new(name, data_dir));
    if name == "storage" {
        ctx.storage.sweep();
    }
    if let Some(b) = &ctx.browser {
        // Leftover profiles go (FR-209: every session starts clean); the bridge sockets (FR-096).
        b.start();
    }
    match &ctx.runtime {
        Some(Ok(rt)) => {
            if let Err(e) = rt.start() {
                eprintln!("novad local-runtime: {e}");
            }
        }
        Some(Err(e)) => eprintln!("novad local-runtime: {e}"),
        None => {}
    }
    let out = Arc::new(Mutex::new(std::io::stdout()));
    let in_flight = Arc::new(AtomicUsize::new(0));
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let Ok(req) = serde_json::from_str::<Value>(&line) else { continue };
        let Some(id) = req["id"].as_u64() else { continue };
        let op = req["op"].as_str().unwrap_or_default().to_string();
        let args = req.get("args").cloned().unwrap_or(json!({}));
        if in_flight.load(Ordering::SeqCst) >= MAX_IN_FLIGHT {
            respond(&out, id, Err(OpError::new(429, "rate_limited", "too many requests in flight")));
            continue;
        }
        in_flight.fetch_add(1, Ordering::SeqCst);
        let (ctx, out, in_flight) = (ctx.clone(), out.clone(), in_flight.clone());
        std::thread::spawn(move || {
            let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| handle(&ctx, &op, &args)))
                .unwrap_or_else(|_| Err(OpError::internal("the operation failed")));
            respond(&out, id, r);
            in_flight.fetch_sub(1, Ordering::SeqCst);
        });
    }
    0
}

fn respond(out: &Mutex<std::io::Stdout>, id: u64, r: OpResult<Value>) {
    let msg = match r {
        Ok(v) => json!({ "id": id, "ok": true, "result": v }),
        Err(e) => json!({ "id": id, "ok": false, "status": e.status, "error": e.to_json() }),
    };
    if let Ok(mut o) = out.lock() {
        let _ = writeln!(o, "{msg}");
        let _ = o.flush();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::b64_encode;
    use crate::grants::tests::tmp;
    use crate::power::tests::FakeRunner;
    use std::time::Duration;

    fn ctx(name: &str, data: &Path) -> Context {
        let mut c = Context::new(name, data);
        c.runner = Box::new(FakeRunner::default());
        c
    }

    #[test]
    fn storage_operations_through_the_dispatcher() {
        let base = tmp("module");
        let data = base.join("data");
        std::fs::create_dir_all(&data).unwrap();
        let proj = base.join("p");
        std::fs::create_dir_all(&proj).unwrap();
        let c = ctx("storage", &data);
        let g = json!({ "kind": "agent", "id": "a" });
        assert_eq!(handle(&c, "ping", &json!({})).unwrap()["module"], "storage");
        let r = handle(&c, "fs.requestAccess", &json!({ "grantee": g, "path": proj, "access": "write" })).unwrap();
        let rid = r["request"]["id"].as_str().unwrap();
        handle(&c, "fs.decide", &json!({ "requestId": rid, "decision": "grant" })).unwrap();
        let st = handle(&c, "fs.stage", &json!({ "grantee": g, "path": proj.join("f.txt"), "contentBase64": b64_encode(b"hi\n") })).unwrap();
        let id = st["staged"]["id"].as_str().unwrap();
        handle(&c, "fs.commit", &json!({ "grantee": g, "stagedId": id })).unwrap();
        assert_eq!(std::fs::read_to_string(proj.join("f.txt")).unwrap(), "hi\n");
        let l = handle(&c, "fs.list", &json!({ "grantee": g, "path": proj })).unwrap();
        assert_eq!(l["entries"][0]["name"], "f.txt");
        let gr = handle(&c, "fs.grants", &json!({ "grantee": g })).unwrap();
        assert_eq!(gr["grants"].as_array().unwrap().len(), 1);
        assert_eq!(handle(&c, "fs.decide", &json!({ "requestId": rid, "decision": "maybe" })).unwrap_err().code, "validation");
        assert_eq!(handle(&c, "fs.list", &json!({ "path": "/" })).unwrap_err().code, "validation");
        assert_eq!(handle(&c, "nope", &json!({})).unwrap_err().code, "not_found");
        let rv = handle(&c, "fs.revoke", &json!({ "grantee": g })).unwrap();
        assert_eq!(rv["revoked"], true);
        std::fs::remove_dir_all(&base).unwrap();
    }

    /// Regression: `proc.spawn` through the module's handler on a thread that then ends (as each
    /// request does); the process is still alive and readable through `proc.read`.
    #[test]
    fn spawned_processes_survive_their_request() {
        let base = tmp("module-proc");
        // The real sandbox where it works; else a stand-in that runs what follows `--` (this test
        // is about the process's lifetime, not its sandbox).
        let bwrap = crate::exec::working_bwrap().unwrap_or_else(|| {
            let fake = base.join("fake-bwrap");
            std::fs::write(&fake, "#!/bin/sh\nwhile [ \"$1\" != -- ]; do shift; done\nshift\nexec \"$@\"\n").unwrap();
            std::fs::set_permissions(&fake, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
            fake
        });
        let data = base.join("data");
        let proj = base.join("p");
        std::fs::create_dir_all(&proj).unwrap();
        let mut c = ctx("storage", &data);
        c.bwrap = Some(bwrap);
        let c = Arc::new(c);
        let g = json!({ "kind": "agent", "id": "a" });
        handle(&c, "fs.grant", &json!({ "grantee": g, "target": proj, "access": "read" })).unwrap();
        let (c2, g2, p2) = (c.clone(), g.clone(), proj.clone());
        let id = std::thread::spawn(move || handle(&c2, "proc.spawn", &json!({ "grantee": g2, "cmd": "echo up; sleep 1; echo still", "cwd": p2 })).unwrap()["id"].as_str().unwrap().to_string())
            .join()
            .unwrap();
        std::thread::sleep(Duration::from_millis(400));
        let r = handle(&c, "proc.read", &json!({ "grantee": g, "id": id, "waitMs": 2000 })).unwrap();
        assert_eq!((r["running"].as_bool(), r["data"].as_str()), (Some(true), Some("up\n")), "{r}");
        let mut r = r;
        for _ in 0..100 {
            if r["running"] == false {
                break;
            }
            std::thread::sleep(Duration::from_millis(30));
            r = handle(&c, "proc.read", &json!({ "grantee": g, "id": id })).unwrap();
        }
        assert_eq!(r["exitCode"], 0, "{r}");
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn management_and_placeholder_modules() {
        let base = tmp("module2");
        let m = ctx("management", &base);
        assert!(handle(&m, "power.status", &json!({})).unwrap().get("wakeable").is_some());
        assert_eq!(handle(&m, "service.systemd", &json!({ "unit": "ollama.service", "action": "restart" })).unwrap()["ok"], true);
        assert!(handle(&m, "service.systemd", &json!({ "unit": "-x", "action": "restart" })).is_err());
        assert!(handle(&m, "service.systemd", &json!({ "unit": "a", "action": "mask" })).is_err());
        let c = ctx("compute", &base);
        assert_eq!(handle(&c, "status", &json!({})).unwrap()["ready"], true);
        assert!(handle(&c, "fs.list", &json!({})).is_err());
        std::fs::remove_dir_all(&base).unwrap();
    }
}
