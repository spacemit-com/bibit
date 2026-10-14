use super::{RuntimeError, RuntimeErrorCode};
use std::path::{Path, PathBuf};

pub fn resolve_runtime_cwd(data_root: &Path) -> Result<PathBuf, RuntimeError> {
    let runtime_cwd = data_root.join("runtime").join("hermes");
    std::fs::create_dir_all(&runtime_cwd).map_err(|_| {
        RuntimeError::new(
            RuntimeErrorCode::SessionCreateFailed,
            "Runtime working directory could not be created",
        )
    })?;
    let canonical_root = std::fs::canonicalize(data_root).map_err(|_| {
        RuntimeError::new(
            RuntimeErrorCode::SessionCreateFailed,
            "BiBit data directory could not be resolved",
        )
    })?;
    let canonical_cwd = std::fs::canonicalize(&runtime_cwd).map_err(|_| {
        RuntimeError::new(
            RuntimeErrorCode::SessionCreateFailed,
            "Runtime working directory could not be resolved",
        )
    })?;
    if !canonical_cwd.starts_with(&canonical_root) {
        return Err(RuntimeError::new(
            RuntimeErrorCode::SessionCreateFailed,
            "Runtime working directory is outside the BiBit data directory",
        ));
    }
    Ok(canonical_cwd)
}
