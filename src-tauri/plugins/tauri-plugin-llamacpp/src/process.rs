pub async fn graceful_terminate_process(child: &mut tokio::process::Child) {
    use nix::sys::signal::{kill, Signal};
    use nix::unistd::Pid;
    use std::time::Duration;
    use tokio::time::timeout;

    if let Some(raw_pid) = child.id() {
        let raw_pid = raw_pid as i32;
        log::info!("Sending SIGTERM to PID {}", raw_pid);
        let _ = kill(Pid::from_raw(raw_pid), Signal::SIGTERM);

        match timeout(Duration::from_secs(5), child.wait()).await {
            Ok(Ok(status)) => log::info!("Process exited gracefully: {}", status),
            Ok(Err(e)) => log::error!("Error waiting after SIGTERM: {}", e),
            Err(_) => {
                log::warn!("SIGTERM timed out; sending SIGKILL to PID {}", raw_pid);
                let _ = kill(Pid::from_raw(raw_pid), Signal::SIGKILL);
                match child.wait().await {
                    Ok(s) => log::info!("Force-killed process exited: {}", s),
                    Err(e) => log::error!("Error waiting after SIGKILL: {}", e),
                }
            }
        }
    }
}
