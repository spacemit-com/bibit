use std::path::Path;

/// Returns true when the current process is running inside a Flatpak sandbox
pub fn is_flatpak() -> bool {
    Path::new("/.flatpak-info").exists()
}

/// Checks if npx can be overridden with bun binary
pub fn can_override_npx(bun_path: String) -> bool {
    // Check if bun_path exists
    if !std::path::Path::new(bun_path.as_str()).exists() {
        #[cfg(feature = "logging")]
        log::warn!(
            "bun binary not found at '{}', default npx binary will be used",
            bun_path
        );
        return false;
    }
    true // by default, we can override npx with bun binary
}

/// Checks if uv_path exists and determines if uvx can be overridden with the uv binary
pub fn can_override_uvx(uv_path: String) -> bool {
    if !std::path::Path::new(uv_path.as_str()).exists() {
        #[cfg(feature = "logging")]
        log::warn!(
            "uv binary not found at '{}', default uvx binary will be used",
            uv_path
        );
        return false;
    }
    true // by default, we can override uvx with uv binary
}

#[derive(Default)]
pub struct CudaPaths {
    pub lib_paths: Vec<String>,
    pub bin_paths: Vec<String>,
}

impl CudaPaths {
    /// Folds another set of GPU runtime paths in, de-duplicating. Used to merge
    /// CUDA + ROCm discovery into one `setup_library_path` call.
    pub fn merged(mut self, other: CudaPaths) -> CudaPaths {
        for p in other.lib_paths {
            if !self.lib_paths.contains(&p) {
                self.lib_paths.push(p);
            }
        }
        for p in other.bin_paths {
            if !self.bin_paths.contains(&p) {
                self.bin_paths.push(p);
            }
        }
        self
    }
}

/// Merges binary lib dir + CUDA paths into a single `command.env()` call per variable.
pub fn setup_library_path(
    library_path: Option<&Path>,
    cuda: &CudaPaths,
    command: &mut tokio::process::Command,
) {
    {
        let mut all_lib_dirs: Vec<String> = Vec::new();
        if let Some(lib_path) = library_path {
            all_lib_dirs.push(lib_path.to_string_lossy().to_string());
        }
        all_lib_dirs.extend(cuda.lib_paths.iter().cloned());

        if !all_lib_dirs.is_empty() {
            let current = std::env::var("LD_LIBRARY_PATH").unwrap_or_default();
            let current = current.trim_end_matches(':');
            let new_val = if current.is_empty() {
                all_lib_dirs.join(":")
            } else {
                format!("{}:{}", all_lib_dirs.join(":"), current)
            };
            command.env("LD_LIBRARY_PATH", &new_val);

            #[cfg(feature = "logging")]
            log::info!("LD_LIBRARY_PATH set to: {}", new_val);
        }

        if !cuda.bin_paths.is_empty() {
            let current = std::env::var("PATH").unwrap_or_default();
            let current = current.trim_end_matches(':');
            let new_val = if current.is_empty() {
                cuda.bin_paths.join(":")
            } else {
                format!("{}:{}", cuda.bin_paths.join(":"), current)
            };
            command.env("PATH", &new_val);

            #[cfg(feature = "logging")]
            log::info!("PATH set to: {}", new_val);
        }
    }
}

pub fn binary_requires_cuda(_bin_path: &Path) -> bool {
    binary_requires_cuda_linux(_bin_path)
}

fn binary_requires_cuda_linux(bin_path: &Path) -> bool {
    if let Ok(output) = std::process::Command::new("ldd").arg(bin_path).output() {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            return stdout.contains("libcudart")
                || stdout.contains("libcublas")
                || stdout.contains("libcufft")
                || stdout.contains("libcurand")
                || stdout.contains("libcusparse")
                || stdout.contains("libcusolver")
                || stdout.contains("libcudnn");
        }
    }

    // Fallback: string search if ldd fails
    if let Ok(contents) = std::fs::read(bin_path) {
        let contents_str = String::from_utf8_lossy(&contents);
        return contents_str.contains("libcudart")
            || contents_str.contains("libcublas")
            || contents_str.contains("libcufft");
    }

    false
}

pub fn find_cuda_paths() -> CudaPaths {
    find_cuda_paths_linux()
}

/// Locates ROCm/HIP runtime directories. Mirrors `find_cuda_paths`: ROCm ships
/// in versioned roots (e.g. `/opt/rocm-7.2.0/lib`) that aren't on the default
/// loader path, so they must be discovered and added explicitly.
pub fn find_rocm_paths() -> CudaPaths {
    find_rocm_paths_linux()
}

fn add_rocm_root(
    root: &std::path::Path,
    lib_paths: &mut std::collections::HashSet<String>,
    bin_paths: &mut std::collections::HashSet<String>,
) {
    for sub in ["lib", "lib64"] {
        let p = root.join(sub);
        if p.exists() {
            lib_paths.insert(p.to_string_lossy().to_string());
        }
    }
    let bin = root.join("bin");
    if bin.exists() {
        bin_paths.insert(bin.to_string_lossy().to_string());
    }
}

fn find_rocm_paths_linux() -> CudaPaths {
    use std::collections::HashSet;
    use std::path::Path;

    let mut lib_paths: HashSet<String> = HashSet::new();
    let mut bin_paths: HashSet<String> = HashSet::new();

    for var in ["ROCM_PATH", "ROCM_HOME", "HIP_PATH"] {
        if let Ok(root) = std::env::var(var) {
            add_rocm_root(Path::new(&root), &mut lib_paths, &mut bin_paths);
        }
    }

    // Canonical unversioned symlink.
    add_rocm_root(Path::new("/opt/rocm"), &mut lib_paths, &mut bin_paths);

    // Versioned installs: /opt/rocm-7.2.0, /opt/rocm-6.4.1, ...
    if let Ok(entries) = std::fs::read_dir("/opt") {
        for entry in entries.flatten() {
            if let Some(name) = entry.file_name().to_str() {
                if name.starts_with("rocm-") {
                    add_rocm_root(&entry.path(), &mut lib_paths, &mut bin_paths);
                }
            }
        }
    }

    let mut libs: Vec<_> = lib_paths.into_iter().collect();
    libs.sort();
    let mut bins: Vec<_> = bin_paths.into_iter().collect();
    bins.sort();

    #[cfg(feature = "logging")]
    if libs.is_empty() && bins.is_empty() {
        log::debug!("ROCm not found on Linux system");
    } else if !libs.is_empty() {
        log::info!("Found ROCm lib paths: {}", libs.join(", "));
    }

    CudaPaths {
        lib_paths: libs,
        bin_paths: bins,
    }
}

/// True when the binary links the HIP/ROCm runtime (libamdhip64 / rocblas /
/// hipblas). Used to warn when a HIP backend is run without ROCm present.
pub fn binary_requires_rocm(_bin_path: &Path) -> bool {
    if let Ok(output) = std::process::Command::new("ldd").arg(_bin_path).output() {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            return stdout.contains("libamdhip64")
                || stdout.contains("librocblas")
                || stdout.contains("libhipblas");
        }
    }
    false
}

/// Backward-compat wrapper. Prefer `find_cuda_paths()` + `setup_library_path()`.
pub fn add_cuda_paths(command: &mut tokio::process::Command) -> bool {
    let cuda = find_cuda_paths();
    let found = !cuda.lib_paths.is_empty() || !cuda.bin_paths.is_empty();
    setup_library_path(None, &cuda, command);
    found
}

fn find_cuda_paths_linux() -> CudaPaths {
    use std::collections::HashSet;
    use std::path::Path;

    let mut cuda_lib_paths = HashSet::new();
    let mut cuda_bin_paths = HashSet::new();

    if let Ok(cuda_path) = std::env::var("CUDA_HOME").or_else(|_| std::env::var("CUDA_PATH")) {
        let lib64_path = format!("{}/lib64", cuda_path);
        let lib_path = format!("{}/lib", cuda_path);
        let bin_path = format!("{}/bin", cuda_path);

        if Path::new(&lib64_path).exists() {
            cuda_lib_paths.insert(lib64_path);
        }
        if Path::new(&lib_path).exists() {
            cuda_lib_paths.insert(lib_path);
        }
        if Path::new(&bin_path).exists() {
            cuda_bin_paths.insert(bin_path);
        }
    }

    let common_paths = [
        "/usr/local/cuda/lib64",
        "/usr/local/cuda/lib",
        "/usr/lib/cuda/lib64",
        "/usr/lib/cuda/lib",
        "/opt/cuda/lib64",
        "/opt/cuda/lib",
        "/usr/lib/x86_64-linux-gnu",
        "/usr/lib/x86_64-linux-gnu/nvidia",
    ];

    for path in &common_paths {
        if Path::new(path).exists() {
            cuda_lib_paths.insert(path.to_string());
        }
    }

    if is_flatpak() {
        collect_flatpak_gl_paths(&mut cuda_lib_paths);
    }

    if let Ok(entries) = std::fs::read_dir("/usr/local") {
        for entry in entries.flatten() {
            if let Some(name) = entry.file_name().to_str() {
                if name.starts_with("cuda-") {
                    let base = entry.path();
                    for sub in ["lib64", "lib", "bin"] {
                        let sub_path = base.join(sub);
                        if sub_path.exists() {
                            let s = sub_path.to_string_lossy().to_string();
                            if sub == "bin" {
                                cuda_bin_paths.insert(s);
                            } else {
                                cuda_lib_paths.insert(s);
                            }
                        }
                    }
                }
            }
        }
    }

    let mut libs: Vec<_> = cuda_lib_paths.into_iter().collect();
    libs.sort();
    let mut bins: Vec<_> = cuda_bin_paths.into_iter().collect();
    bins.sort();

    if libs.is_empty() && bins.is_empty() {
        #[cfg(feature = "logging")]
        log::debug!("CUDA not found on Linux system");
    } else {
        #[cfg(feature = "logging")]
        {
            if !libs.is_empty() {
                log::info!("Found CUDA lib paths: {}", libs.join(", "));
            }
            if !bins.is_empty() {
                log::info!("Found CUDA bin paths: {}", bins.join(", "));
            }
        }
    }

    CudaPaths {
        lib_paths: libs,
        bin_paths: bins,
    }
}

fn collect_flatpak_gl_paths(cuda_lib_paths: &mut std::collections::HashSet<String>) {
    let flatpak_gl_paths = [
        "/usr/lib/extensions/vulkan/nvidia/lib",
        "/usr/lib/extensions/cuda/lib",
        "/usr/lib/GL/lib",
        "/usr/lib/GL",
        "/app/lib/GL",
    ];

    for path in &flatpak_gl_paths {
        if Path::new(path).exists() {
            cuda_lib_paths.insert(path.to_string());
        }
    }

    for base_dir in ["/usr/lib/extensions", "/usr/lib/GL/lib"] {
        if let Ok(entries) = std::fs::read_dir(base_dir) {
            for entry in entries.flatten() {
                let entry_path = entry.path();
                if !entry_path.is_dir() {
                    continue;
                }

                let lib_sub = entry_path.join("lib");
                if lib_sub.exists() {
                    cuda_lib_paths.insert(lib_sub.to_string_lossy().to_string());
                } else {
                    cuda_lib_paths.insert(entry_path.to_string_lossy().to_string());
                }
            }
        }
    }

    #[cfg(feature = "logging")]
    log::info!("Searched Flatpak GL extension paths for NVIDIA libraries");
}

#[cfg(test)]
mod tests {
    use super::*;

    // Spawns a child to read env vars since Command doesn't expose a getter.
    async fn read_env_from_child(command: &mut tokio::process::Command, var: &str) -> String {
        use std::process::Stdio;
        command.args(["-c", &format!("printenv {} || true", var)]);

        let output = command
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output()
            .await
            .expect("failed to spawn helper process");
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    fn new_shell_command() -> tokio::process::Command {
        tokio::process::Command::new("sh")
    }

    #[test]
    fn cuda_paths_default_is_empty() {
        let cp = CudaPaths::default();
        assert!(cp.lib_paths.is_empty());
        assert!(cp.bin_paths.is_empty());
    }

    #[tokio::test]
    async fn setup_library_path_merges_binary_dir_and_cuda_libs() {
        let cuda = CudaPaths {
            lib_paths: vec!["/fake/cuda/lib64".into()],
            bin_paths: vec!["/fake/cuda/bin".into()],
        };
        let bin_dir = Path::new("/fake/bin_dir");

        let mut cmd = new_shell_command();
        setup_library_path(Some(bin_dir), &cuda, &mut cmd);

        let ld = read_env_from_child(&mut cmd, "LD_LIBRARY_PATH").await;
        assert!(
            ld.contains("/fake/bin_dir"),
            "LD_LIBRARY_PATH should contain binary dir, got: {}",
            ld
        );
        assert!(
            ld.contains("/fake/cuda/lib64"),
            "LD_LIBRARY_PATH should contain CUDA lib dir, got: {}",
            ld
        );

        let mut cmd2 = new_shell_command();
        setup_library_path(Some(bin_dir), &cuda, &mut cmd2);
        let path = read_env_from_child(&mut cmd2, "PATH").await;
        assert!(
            path.contains("/fake/cuda/bin"),
            "PATH should contain CUDA bin dir, got: {}",
            path
        );
    }

    #[tokio::test]
    async fn setup_library_path_no_cuda_still_sets_binary_dir() {
        let cuda = CudaPaths::default();
        let bin_dir = Path::new("/fake/bin_dir");

        let mut cmd = new_shell_command();
        setup_library_path(Some(bin_dir), &cuda, &mut cmd);

        let ld = read_env_from_child(&mut cmd, "LD_LIBRARY_PATH").await;
        assert!(
            ld.contains("/fake/bin_dir"),
            "LD_LIBRARY_PATH should contain binary dir even without CUDA, got: {}",
            ld
        );
    }

    #[tokio::test]
    async fn setup_library_path_no_binary_dir_still_sets_cuda() {
        let cuda = CudaPaths {
            lib_paths: vec!["/fake/cuda/lib64".into()],
            bin_paths: vec![],
        };

        let mut cmd = new_shell_command();
        setup_library_path(None, &cuda, &mut cmd);

        let ld = read_env_from_child(&mut cmd, "LD_LIBRARY_PATH").await;
        assert!(
            ld.contains("/fake/cuda/lib64"),
            "LD_LIBRARY_PATH should contain CUDA lib dir, got: {}",
            ld
        );
    }

    #[tokio::test]
    async fn setup_library_path_empty_inputs_does_not_set_env() {
        let cuda = CudaPaths::default();
        let mut cmd = new_shell_command();

        cmd.env_remove("LD_LIBRARY_PATH");
        setup_library_path(None, &cuda, &mut cmd);

        let ld = read_env_from_child(&mut cmd, "LD_LIBRARY_PATH").await;
        assert!(
            ld.is_empty(),
            "LD_LIBRARY_PATH should not be set when both inputs are empty, got: {}",
            ld
        );
    }

    #[test]
    fn binary_requires_cuda_returns_false_for_nonexistent_file() {
        assert!(!binary_requires_cuda(Path::new("/nonexistent/binary")));
    }

    #[test]
    fn binary_requires_cuda_returns_false_for_non_cuda_binary() {
        assert!(!binary_requires_cuda(Path::new("/bin/sh")));
    }

    #[test]
    fn find_cuda_paths_returns_valid_struct() {
        let cp = find_cuda_paths();
        for p in &cp.lib_paths {
            assert!(
                Path::new(p).exists(),
                "Returned lib path should exist: {}",
                p
            );
        }
        for p in &cp.bin_paths {
            assert!(
                Path::new(p).exists(),
                "Returned bin path should exist: {}",
                p
            );
        }
    }

    #[test]
    fn find_rocm_paths_returns_existing_dirs() {
        let rp = find_rocm_paths();
        for p in rp.lib_paths.iter().chain(rp.bin_paths.iter()) {
            assert!(Path::new(p).exists(), "Returned ROCm path should exist: {}", p);
        }
    }

    #[test]
    fn binary_requires_rocm_returns_false_for_nonexistent_file() {
        assert!(!binary_requires_rocm(Path::new("/nonexistent/binary")));
    }

    #[test]
    fn merged_dedups_and_unions_paths() {
        let a = CudaPaths {
            lib_paths: vec!["/x".into(), "/y".into()],
            bin_paths: vec!["/b".into()],
        };
        let b = CudaPaths {
            lib_paths: vec!["/y".into(), "/z".into()],
            bin_paths: vec!["/b".into(), "/c".into()],
        };
        let m = a.merged(b);
        assert_eq!(m.lib_paths, vec!["/x", "/y", "/z"]);
        assert_eq!(m.bin_paths, vec!["/b", "/c"]);
    }

    #[tokio::test]
    async fn add_cuda_paths_compat_wrapper_does_not_panic() {
        let mut cmd = new_shell_command();
        let _found = add_cuda_paths(&mut cmd);
    }

    #[test]
    fn is_flatpak_returns_bool() {
        let result = is_flatpak();
        if Path::new("/.flatpak-info").exists() {
            assert!(result);
        } else {
            assert!(!result);
        }
    }
}
