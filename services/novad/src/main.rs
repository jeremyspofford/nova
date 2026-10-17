//! novad: the Nova device agent supervisor (docs/23). M0 skeleton.

mod capabilities;
mod cli;

use cli::Command;
use std::process::ExitCode;

const VERSION: &str = env!("CARGO_PKG_VERSION");

const HELP: &str = "novad — Nova device agent

USAGE:
  novad version
  novad capabilities [--device-id ID] [--role ROLE]...
  novad install --hub URL --code CODE [--role client|compute|wake-helper] [--dry-run]
  novad service-unit [--exec PATH]
  novad run
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
        Command::Capabilities { device_id, roles } => {
            let roles: Vec<&str> = roles.iter().map(String::as_str).collect();
            let doc = capabilities::detect(&device_id, &roles, &capabilities::Probe::current());
            match serde_json::to_string_pretty(&doc) {
                Ok(json) => {
                    println!("{json}");
                    ExitCode::SUCCESS
                }
                Err(e) => {
                    eprintln!("novad: {e}");
                    ExitCode::FAILURE
                }
            }
        }
        Command::ServiceUnit { exec } => {
            print!("{}", cli::systemd_unit(&exec));
            ExitCode::SUCCESS
        }
        Command::Install { hub, role, dry_run, .. } => {
            // Registration (signed download, Hub pinning, pairing) arrives in M6.5 (FR-132, FR-133).
            if dry_run {
                println!("would register with {hub} as {role} and install the service unit");
                ExitCode::SUCCESS
            } else {
                eprintln!("novad: install is not available in this build yet; use --dry-run");
                ExitCode::from(3)
            }
        }
        Command::Run => {
            eprintln!("novad {VERSION}: supervisor started (no modules configured)");
            // The module supervisor arrives in M6 (FR-141). Exit cleanly so service managers
            // do not restart-loop a skeleton build.
            ExitCode::SUCCESS
        }
    }
}
