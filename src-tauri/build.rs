mod linux_window_controls_build {
    include!("build_support/linux_window_controls.rs");
}

fn verify_linux_window_controls() {
    println!("cargo:rerun-if-env-changed=PROFILE");

    let target_os = std::env::var("CARGO_CFG_TARGET_OS").ok();
    let profile = std::env::var("PROFILE").ok();
    if !linux_window_controls_build::should_verify(target_os.as_deref(), profile.as_deref()) {
        return;
    }

    let manifest_dir = std::path::PathBuf::from(
        std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set by Cargo"),
    );
    let project_dir = manifest_dir
        .parent()
        .expect("src-tauri has a project parent directory");
    let verifier = project_dir.join("scripts/verify-linux-window-controls.mjs");
    let dist = project_dir.join("web-app/dist");

    println!("cargo:rerun-if-changed={}", verifier.display());
    println!("cargo:rerun-if-changed={}", dist.display());

    let output = std::process::Command::new("node")
        .arg(&verifier)
        .arg(&dist)
        .output()
        .unwrap_or_else(|error| {
            panic!(
                "failed to run Linux window controls verifier {}: {error}",
                verifier.display()
            )
        });

    if !output.status.success() {
        panic!(
            "Linux window controls verification failed:\n{}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
}

fn main() {
    verify_linux_window_controls();
    tauri_build::build();
}
