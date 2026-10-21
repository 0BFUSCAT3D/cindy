mod capture;
mod capture_protocol;
mod cursor;
mod naming;
mod pipe;
mod security;
mod service;
mod staging;
mod win;
use naming::Installation;
use sha2::{Digest, Sha256};
use win::*;

/// The service name used before the executable moved into a protected
/// directory: a hash of this bundled helper's own path. Removal still looks
/// for it, so a machine that enabled the feature under an older build is not
/// left with a stale registration no one deletes.
fn legacy_service_name() -> Result<String> {
    let path = std::env::current_exe()?
        .canonicalize()?
        .to_string_lossy()
        .to_lowercase();
    Ok(format!("CindyRemoteDesktop-{:x}", Sha256::digest(path.as_bytes()))[..35].to_string())
}

/// This executable's own installation, for the modes that run from inside one.
fn bundled() -> Staged<Installation> {
    Installation::of_bundled(&std::env::current_exe().stage(Step::ProtectedOpen)?)
}

fn run() -> Staged<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("--service") => service::run().stage(Step::Service),
        Some("--worker") if args.len() == 2 => service::worker(&args[1]).stage(Step::Worker),
        Some("--install") if args.len() == 2 || args.len() == 3 => {
            let pid = args[1]
                .parse::<u32>()
                .map_err(|_| Failure::new(Step::Args, 0))?;
            let development = args.get(2).is_some_and(|arg| arg == "--development");
            if args.len() == 3 && !development {
                return refuse(Step::Args);
            }
            let installation = if development {
                bundled()?.for_development()
            } else {
                bundled()?
            };
            // Stop first: setup also runs for an upgrade, and the staged files
            // cannot be replaced while the service it starts still holds them.
            service::uninstall(&installation.service())?;
            service::install(&installation)?;
            service::authorize(&installation, pid)
        }
        Some("--uninstall") => {
            let installation = bundled()?;
            service::uninstall(&installation.service())?;
            if let Ok(legacy) = legacy_service_name() {
                service::uninstall(&legacy)?;
            }
            staging::unstage(&installation)
        }
        Some("--elevate-install") if args.len() == 2 || args.len() == 3 => {
            let pid = args[1]
                .parse::<u32>()
                .map_err(|_| Failure::new(Step::Args, 0))?;
            let development = args.get(2).is_some_and(|arg| arg == "--development");
            if args.len() == 3 && !development {
                return refuse(Step::Args);
            }
            let installation = if development {
                bundled()?.for_development()
            } else {
                bundled()?
            };
            let (_main, _) = security::authorize_client(pid, &installation.install, development)
                .stage(Step::ClientIdentity)?;
            let command = if development {
                format!("--install {pid} --development")
            } else {
                format!("--install {pid}")
            };
            service::elevate(&command)
        }
        Some("--elevate-uninstall") => service::elevate("--uninstall"),
        Some("--status") => {
            let status = match bundled() {
                Ok(installation) if service::pid(&installation.service()).is_ok() => {
                    "ready".to_string()
                }
                Ok(_) => "missing".to_string(),
                // Setup cannot run at all on this machine. Name the step, so
                // the settings page does not have to guess behind a bare word.
                Err(failure) => format!("installRequired {}", failure.detail()),
            };
            println!("{status}");
            Ok(())
        }
        _ => refuse(Step::Args),
    }
}
fn main() {
    if let Err(failure) = run() {
        // One line for the Desktop log, and an exit code the unelevated parent
        // can decode when this process is the hidden elevated child.
        println!("{}", failure.line());
        std::process::exit(failure.step.exit() as i32);
    }
}
