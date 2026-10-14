// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(feature = "runtime-test-agent")]
#[path = "runtime/fake_acp_agent.rs"]
mod bibit_fake_acp_agent;

/// `fix_path_env` re-derives PATH by running the user's login shell. On the
/// target board that shell sources profile.d plus bashrc and spawns ~130
/// processes (~260 ms) before the window is even built, and the PATH it reports
/// there is a *subset* of the one the desktop session already exports (session:
/// `~/.local/bin:...:/snap/bin`; shell: `~/.local/bin:...:/sbin:/bin`). Only pay
/// for it when PATH carries no user-level directory at all, which is the
/// stripped-GUI-launch case the probe exists for.
// ponytail: correlation gate, not a proof; if an MCP command ever needs a dir
// the session does not export, overlay PATH at the spawn site instead.
fn path_needs_shell_probe() -> bool {
    let home = std::env::var("HOME").unwrap_or_default();
    let Ok(path) = std::env::var("PATH") else {
        return true;
    };
    home.is_empty() || !path.split(':').any(|dir| dir.starts_with(&home))
}

fn main() {
    app_lib::startup_trace::start();
    #[cfg(feature = "desktop")]
    if std::env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new("--cli"))
        || std::env::var_os(app_lib::runtime::cli::CLI_HANDOFF_ENV).is_some()
    {
        std::process::exit(app_lib::runtime::cli::run_cli_from_env());
    }

    #[cfg(feature = "desktop")]
    if app_lib::runtime::hermes_acp::is_process_launcher_arg(std::env::args_os().nth(1).as_deref())
    {
        std::process::exit(app_lib::runtime::hermes_acp::run_process_launcher(
            std::env::args_os().skip(2),
        ));
    }

    #[cfg(feature = "runtime-test-agent")]
    if std::env::args().nth(1).as_deref() == Some("--runtime-test-agent") {
        bibit_fake_acp_agent::run(std::env::args().skip(2));
        return;
    }

    #[cfg(all(feature = "desktop", target_os = "linux"))]
    if app_lib::desktop_integration::forward_voice_listen_to_running_instance() {
        return;
    }

    // Fix PATH before anything that may spawn subprocesses, so the lddtree
    // helper (and any other child) inherits directories added by fix_path_env.
    if path_needs_shell_probe() {
        let _ = fix_path_env::fix();
    }

    // Exits early if invoked as the out-of-process lddtree helper.
    tauri_plugin_llamacpp::deps_analyzer::run_deps_analyzer_if_requested();

    app_lib::run();
}
