//! novad: the Nova device agent (docs/23). A small supervisor that enrolls with the Hub, reports
//! a signed capability document, serves the management channel and runs signed, sandboxed modules
//! as separate processes (FR-141, FR-142, FR-144, FR-145, FR-148, FR-150, FR-210).

mod agent;
mod capabilities;
mod cli;
mod crypto;
mod diff;
mod exec;
mod fsops;
mod grants;
mod hardening;
mod http;
mod mcp;
mod module;
mod paths;
mod power;
mod procs;
mod state;
mod supervisor;
mod update;
mod util;

use cli::Command;
use serde_json::json;
use std::path::PathBuf;
use std::process::ExitCode;

const VERSION: &str = env!("CARGO_PKG_VERSION");

const HELP: &str = "novad — Nova device agent

USAGE:
  novad version
  novad capabilities [--device-id ID] [--role ROLE]... [--data-dir DIR] [--sign]
  novad enroll --hub http://HUB:PORT --token nvd_… [--name NAME] [--role ROLE]...
               [--listen HOST:PORT] [--endpoint http://HOST:PORT] [--channel stable|beta|nightly]
               [--update-key KEY] [--data-dir DIR]
  novad run [--data-dir DIR]
  novad access list | approve ID | deny ID [--data-dir DIR]
  novad wol status | plan | enable [--apply] [--data-dir DIR]
  novad install --hub URL --code CODE [--role client|compute|wake-helper] [--dry-run]
  novad service-unit [--exec PATH] [--platform linux|macos|windows] [--data-dir DIR]
";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match cli::parse(&args) {
        Ok(cmd) => run(cmd),
        Err(e) => {
            eprintln!("novad: {e}\n\n{HELP}");
            ExitCode::from(2)
        }
    }
}

fn exe() -> PathBuf {
    std::env::current_exe().unwrap_or_else(|_| PathBuf::from("/usr/local/bin/novad"))
}

fn print_json(v: &serde_json::Value) -> ExitCode {
    match serde_json::to_string_pretty(v) {
        Ok(s) => {
            println!("{s}");
            ExitCode::SUCCESS
        }
        Err(e) => fail(e),
    }
}

fn fail(e: impl std::fmt::Display) -> ExitCode {
    eprintln!("novad: {e}");
    ExitCode::FAILURE
}

fn run(cmd: Command) -> ExitCode {
    match cmd {
        Command::Help => {
            print!("{HELP}");
            ExitCode::SUCCESS
        }
        Command::Version => {
            println!("novad {VERSION}");
            ExitCode::SUCCESS
        }
        Command::Capabilities { device_id, roles, data_dir, sign } => {
            let roles_ref: Vec<&str> = roles.iter().map(String::as_str).collect();
            let doc = capabilities::detect(&device_id, &roles_ref, &capabilities::Probe::current());
            let Some(dir) = data_dir.filter(|_| sign) else {
                return print_json(&serde_json::to_value(&doc).unwrap_or_default());
            };
            let data = state::DataDir(PathBuf::from(dir));
            if let Err(e) = data.ensure() {
                return fail(e);
            }
            let local = data.config().map(|c| c.capability_overrides).unwrap_or_else(|_| json!({}));
            let extras = capabilities::Extras {
                modules: supervisor::Manifest::default_for(&roles).modules.into_iter().map(|m| m.name).collect(),
                power: None,
                update_channel: "stable",
                fs_scopes: vec![],
                models_dir: Some(data.path().join("models").to_string_lossy().to_string()),
            };
            let full = capabilities::build(&doc, &extras, &local, &json!({}));
            match (data.key(), data.public_key()) {
                (Ok(key), Ok(pk)) => print_json(&json!({ "capability": full, "signature": capabilities::sign_document(&full, &key), "publicKey": pk })),
                (Err(e), _) | (_, Err(e)) => fail(e),
            }
        }
        Command::ServiceUnit { exec, platform, data_dir } => {
            let text = match platform.as_str() {
                "macos" => cli::launchd_plist(&exec, &data_dir),
                "windows" => cli::windows_service(&exec, &data_dir),
                _ => cli::systemd_unit(&exec, &data_dir),
            };
            print!("{text}");
            ExitCode::SUCCESS
        }
        Command::Install { hub, role, dry_run, .. } => {
            // Signed download, Hub pinning and pairing arrive in M6.5 (FR-132, FR-133); M6 uses
            // `novad enroll` with a one-use token.
            if dry_run {
                println!("would register with {hub} as {role} and install the service unit");
                ExitCode::SUCCESS
            } else {
                eprintln!("novad: install arrives with M6.5; use `novad enroll` with a token from Settings → Devices");
                ExitCode::from(3)
            }
        }
        Command::Enroll(a) => match agent::enroll(&a, exe()) {
            Ok(v) => print_json(&v),
            Err(e) => fail(e),
        },
        Command::Run { data_dir } => match agent::run(&data_dir, exe()) {
            Ok(code) => ExitCode::from(code as u8),
            Err(e) => fail(e),
        },
        Command::Module { name, data_dir } => ExitCode::from(module::main_loop(&name, &PathBuf::from(data_dir)) as u8),
        Command::Access { action, id, data_dir } => {
            let data = PathBuf::from(&data_dir);
            let store = grants::GrantStore::new(data.join("storage/grants.json"), data.clone());
            let r = match (action.as_str(), id) {
                ("list", _) => store.load().map(|f| json!({ "grants": f.grants, "requests": f.requests })),
                // The device owner's decision; the next heartbeat reports it to the Hub.
                ("approve", Some(id)) => store.decide(&id, true, "device").map(|r| json!({ "request": r })),
                ("deny", Some(id)) => store.decide(&id, false, "device").map(|r| json!({ "request": r })),
                _ => Err(util::OpError::validation("unknown access action")),
            };
            match r {
                Ok(v) => print_json(&v),
                Err(e) => fail(e),
            }
        }
        Command::Wol { action, apply, data_dir } => {
            let cfg = state::DataDir(PathBuf::from(data_dir)).config().unwrap_or_default();
            let p = power::Power::system(cfg.power.allow_changes || apply, cfg.power.allow_actions);
            let r = match action.as_str() {
                "plan" => Ok(json!({ "plan": p.wol_plan(), "needsElevation": true })),
                "enable" => p.wol_enable(apply),
                _ => Ok(p.status()),
            };
            match r {
                Ok(v) => print_json(&v),
                Err(e) => fail(format!("{e} {}", e.details.as_ref().map(|d| d.to_string()).unwrap_or_default())),
            }
        }
    }
}
