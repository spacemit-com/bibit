use super::{RuntimeError, RuntimeErrorCode};
#[cfg(unix)]
use nix::fcntl::{Flock, FlockArg};
use std::collections::BTreeSet;
#[cfg(unix)]
use std::fs::{File, OpenOptions};
#[cfg(unix)]
use std::io::{Seek, SeekFrom, Write};
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const CONTROLLER_LOCK_PATH: &str = "bibit/runtime/controller.lock";

pub struct ControllerLease {
    path: PathBuf,
    owners: BTreeSet<String>,
    #[cfg(unix)]
    _lock: Flock<File>,
}

impl ControllerLease {
    #[cfg(unix)]
    pub fn acquire(_data_root: &Path) -> Result<Self, RuntimeError> {
        Self::acquire_at(&controller_lock_path(), "cli")
    }

    #[cfg(unix)]
    fn acquire_at(path: &Path, client: &str) -> Result<Self, RuntimeError> {
        let parent = path.parent().ok_or_else(|| {
            RuntimeError::new(
                RuntimeErrorCode::InternalError,
                "Controller lock path has no parent",
            )
        })?;
        std::fs::create_dir_all(parent).map_err(controller_io_error)?;
        std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))
            .map_err(controller_io_error)?;
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .mode(0o600)
            .custom_flags(nix::libc::O_NOFOLLOW)
            .open(path)
            .map_err(controller_io_error)?;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(controller_io_error)?;
        let mut lock =
            Flock::lock(file, FlockArg::LockExclusiveNonblock).map_err(|(_, error)| {
                let (code, message) = if error == nix::errno::Errno::EWOULDBLOCK {
                    (
                        RuntimeErrorCode::ControllerBusy,
                        controller_busy_message(path),
                    )
                } else {
                    (
                        RuntimeErrorCode::InternalError,
                        format!("Could not lock Agent workbench controller: {error}"),
                    )
                };
                RuntimeError::new(code, message)
            })?;
        lock.set_len(0).map_err(controller_io_error)?;
        lock.seek(SeekFrom::Start(0)).map_err(controller_io_error)?;
        writeln!(lock, "pid={}\nclient={}", std::process::id(), client)
            .map_err(controller_io_error)?;
        lock.sync_data().map_err(controller_io_error)?;
        Ok(Self {
            path: path.to_path_buf(),
            owners: BTreeSet::new(),
            _lock: lock,
        })
    }

    #[cfg(not(unix))]
    pub fn acquire(_data_root: &Path) -> Result<Self, RuntimeError> {
        Err(RuntimeError::new(
            RuntimeErrorCode::InternalError,
            "Agent workbench controller is currently supported on Unix only",
        ))
    }

    #[cfg(not(unix))]
    fn acquire_at(path: &Path, _client: &str) -> Result<Self, RuntimeError> {
        Self::acquire(path)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

#[cfg(all(unix, target_os = "linux"))]
fn controller_lock_path() -> PathBuf {
    PathBuf::from("/run/user")
        .join(nix::unistd::geteuid().as_raw().to_string())
        .join(CONTROLLER_LOCK_PATH)
}

#[cfg(all(unix, not(target_os = "linux")))]
fn controller_lock_path() -> PathBuf {
    PathBuf::from("/tmp")
        .join(format!("bibit-{}", nix::unistd::geteuid().as_raw()))
        .join("runtime/controller.lock")
}

#[cfg(not(unix))]
fn controller_lock_path() -> PathBuf {
    PathBuf::new()
}

#[cfg(unix)]
fn controller_io_error(error: std::io::Error) -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::InternalError,
        format!("Could not prepare Agent workbench controller: {error}"),
    )
}

/// 锁被别的客户端持有时，说清是谁占用、怎么让出来。
///
/// 提示里不出现 pid：用户需要的是"去哪儿结束它"；排查信息留在锁文件本身。
fn controller_busy_message(path: &Path) -> String {
    let holder = std::fs::read_to_string(path).unwrap_or_default();
    let client = holder
        .lines()
        .find_map(|line| line.strip_prefix("client="))
        .map(str::trim);
    match client {
        Some("cli") => {
            "Bibit 命令行正在使用工作台。在它的终端窗口里按 Ctrl-D（或输入 /exit）结束后即可继续。"
                .to_owned()
        }
        Some("window") => {
            "另一个 Bibit 窗口正在使用工作台。切回那个窗口继续操作，或先把它关掉。".to_owned()
        }
        _ => "工作台正被另一个 Bibit 客户端占用，请先在那里结束操作。".to_owned(),
    }
}

#[derive(Default)]
pub struct ControllerLeaseManager {
    lease: Mutex<Option<ControllerLease>>,
}

impl ControllerLeaseManager {
    pub fn acquire(&self, data_root: &Path) -> Result<bool, RuntimeError> {
        self.acquire_for(data_root, "__legacy__")
    }

    pub fn acquire_for(&self, data_root: &Path, owner: &str) -> Result<bool, RuntimeError> {
        let _ = data_root;
        self.acquire_at_for(&controller_lock_path(), owner)
    }

    fn acquire_at(&self, path: &Path) -> Result<bool, RuntimeError> {
        self.acquire_at_for(path, "__legacy__")
    }

    fn acquire_at_for(&self, path: &Path, owner: &str) -> Result<bool, RuntimeError> {
        let mut lease = self.lease.lock().map_err(|_| {
            RuntimeError::new(
                RuntimeErrorCode::InternalError,
                "Controller lease lock poisoned",
            )
        })?;
        if lease.is_none() {
            *lease = Some(ControllerLease::acquire_at(path, "window")?);
        }
        Ok(lease
            .as_mut()
            .expect("lease acquired")
            .owners
            .insert(owner.to_owned()))
    }

    pub fn release(&self) -> Result<bool, RuntimeError> {
        self.release_for("__legacy__")
    }

    pub fn release_for(&self, owner: &str) -> Result<bool, RuntimeError> {
        let mut lease = self.lease.lock().map_err(|_| {
            RuntimeError::new(
                RuntimeErrorCode::InternalError,
                "Controller lease lock poisoned",
            )
        })?;
        let Some(current) = lease.as_mut() else {
            return Ok(false);
        };
        let released = current.owners.remove(owner);
        if current.owners.is_empty() {
            lease.take();
        }
        Ok(released)
    }

    pub fn release_all(&self) -> Result<bool, RuntimeError> {
        let mut lease = self.lease.lock().map_err(|_| {
            RuntimeError::new(
                RuntimeErrorCode::InternalError,
                "Controller lease lock poisoned",
            )
        })?;
        Ok(lease.take().is_some())
    }

    pub fn ensure_held(&self) -> Result<(), RuntimeError> {
        let held = self
            .lease
            .lock()
            .map_err(|_| {
                RuntimeError::new(
                    RuntimeErrorCode::InternalError,
                    "Controller lease lock poisoned",
                )
            })?
            .is_some();
        if held {
            Ok(())
        } else {
            Err(RuntimeError::new(
                RuntimeErrorCode::ControllerRequired,
                "Agent workbench controller lease is required",
            ))
        }
    }

    pub fn is_held(&self) -> bool {
        self.lease.lock().is_ok_and(|lease| lease.is_some())
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::process::Command;
    use std::time::Duration;

    const CHILD_ROOT_ENV: &str = "BIBIT_TEST_CONTROLLER_CHILD_ROOT";

    #[test]
    fn window_release_does_not_drop_another_windows_lease() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join(CONTROLLER_LOCK_PATH);
        let manager = ControllerLeaseManager::default();
        let other = ControllerLeaseManager::default();
        assert!(manager.acquire_at_for(&path, "main").unwrap());
        assert!(manager.acquire_at_for(&path, "status-popup").unwrap());
        assert!(!manager.acquire_at_for(&path, "status-popup").unwrap());
        assert!(!manager.release_for("unrelated").unwrap());
        assert!(manager.release_for("main").unwrap());
        assert!(manager.is_held());
        assert_eq!(
            other.acquire_at(&path).unwrap_err().code,
            RuntimeErrorCode::ControllerBusy
        );
        assert!(manager.release_for("status-popup").unwrap());
        assert!(other.acquire_at(&path).unwrap());
    }

    #[test]
    fn cli_handoff_releases_every_gui_owner() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join(CONTROLLER_LOCK_PATH);
        let manager = ControllerLeaseManager::default();
        let cli = ControllerLeaseManager::default();
        manager.acquire_at_for(&path, "main").unwrap();
        manager.acquire_at_for(&path, "status-popup").unwrap();

        assert!(manager.release_all().unwrap());
        assert!(cli.acquire_at(&path).unwrap());
    }

    #[test]
    fn controller_crash_helper() {
        let Ok(root) = std::env::var(CHILD_ROOT_ENV) else {
            return;
        };
        let root = PathBuf::from(root);
        let _lease = ControllerLease::acquire_at(&root.join(CONTROLLER_LOCK_PATH), "test").unwrap();
        std::fs::write(root.join("ready"), b"ready").unwrap();
        loop {
            std::thread::sleep(Duration::from_secs(1));
        }
    }

    #[test]
    fn only_one_manager_can_hold_the_user_lease() {
        let root = tempfile::tempdir().unwrap();
        let first = ControllerLeaseManager::default();
        let second = ControllerLeaseManager::default();

        let path = root.path().join(CONTROLLER_LOCK_PATH);
        assert_eq!(first.acquire_at(&path).unwrap(), true);
        let error = second.acquire_at(&path).unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::ControllerBusy);
        assert!(
            error.message.contains("工作台"),
            "busy message should explain the holder: {}",
            error.message
        );
        assert!(first.is_held());
        assert!(!second.is_held());
    }

    #[test]
    fn different_data_roots_share_the_same_user_lease() {
        let first_root = tempfile::tempdir().unwrap();
        let second_root = tempfile::tempdir().unwrap();
        let first = ControllerLeaseManager::default();
        let second = ControllerLeaseManager::default();

        assert!(first.acquire(first_root.path()).unwrap());
        assert_eq!(
            second.acquire(second_root.path()).unwrap_err().code,
            RuntimeErrorCode::ControllerBusy
        );
    }

    #[test]
    fn release_and_drop_make_the_lease_available_again() {
        let root = tempfile::tempdir().unwrap();
        let first = ControllerLeaseManager::default();
        let second = ControllerLeaseManager::default();

        let path = root.path().join(CONTROLLER_LOCK_PATH);
        assert_eq!(first.acquire_at(&path).unwrap(), true);
        assert_eq!(first.acquire_at(&path).unwrap(), false);
        assert_eq!(first.release().unwrap(), true);
        assert_eq!(second.acquire_at(&path).unwrap(), true);
        assert_eq!(second.release().unwrap(), true);
        assert_eq!(second.release().unwrap(), false);
    }

    #[test]
    fn mutations_require_a_held_lease() {
        let root = tempfile::tempdir().unwrap();
        let manager = ControllerLeaseManager::default();

        let error = manager.ensure_held().unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::ControllerRequired);
        manager
            .acquire_at(&root.path().join(CONTROLLER_LOCK_PATH))
            .unwrap();
        assert!(manager.ensure_held().is_ok());
        assert_eq!(
            manager.lease.lock().unwrap().as_ref().unwrap().path(),
            root.path().join(CONTROLLER_LOCK_PATH)
        );
    }

    #[test]
    fn killed_process_releases_the_kernel_lease() {
        let root = tempfile::tempdir().unwrap();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "runtime::controller::tests::controller_crash_helper",
                "--nocapture",
            ])
            .env(CHILD_ROOT_ENV, root.path())
            .spawn()
            .unwrap();
        for _ in 0..100 {
            if root.path().join("ready").exists() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(root.path().join("ready").exists());
        child.kill().unwrap();
        child.wait().unwrap();

        assert!(ControllerLease::acquire_at(&root.path().join(CONTROLLER_LOCK_PATH), "test").is_ok());
    }
}
