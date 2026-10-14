use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chrono::{DateTime, Utc};
use rfd::AsyncFileDialog;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{File, Metadata, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime},
};
use tauri::WebviewWindow;

const DEFAULT_GRANT_TTL: Duration = Duration::from_secs(10 * 60);
const DEFAULT_MAX_ACTIVE_GRANTS: usize = 4;
const DEFAULT_MAX_FILE_BYTES: u64 = 256 * 1024 * 1024;
const DEFAULT_MAX_STAGING_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct FileGrantOwner {
    pub feature_id: String,
    pub feature_instance_id: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FileGrantDirection {
    Upload,
    Download,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct FileGrantLimits {
    max_active_per_feature_service: usize,
    max_file_bytes: u64,
    max_staging_bytes_per_feature_service: u64,
}

impl Default for FileGrantLimits {
    fn default() -> Self {
        Self {
            max_active_per_feature_service: DEFAULT_MAX_ACTIVE_GRANTS,
            max_file_bytes: DEFAULT_MAX_FILE_BYTES,
            max_staging_bytes_per_feature_service: DEFAULT_MAX_STAGING_BYTES,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicFileGrant {
    pub version: u8,
    pub grant_id: String,
    pub direction: FileGrantDirection,
    pub display_name: String,
    pub expires_at: DateTime<Utc>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub byte_length: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileGrantSelectionRequest {
    feature_id: String,
    plugin_version: String,
    feature_instance_token: String,
    service_id: String,
    operation_id: String,
    direction: FileGrantDirection,
    #[serde(default)]
    suggested_name: Option<String>,
    #[serde(default)]
    max_bytes: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileGrantPublishRequest {
    feature_id: String,
    plugin_version: String,
    feature_instance_token: String,
    grant_id: String,
    service_id: String,
    operation_id: String,
    content_base64: String,
    byte_length: u64,
    sha256: String,
}

#[derive(Clone, Debug)]
pub(crate) struct StagedFile {
    pub grant_id: String,
    pub resource_path: String,
    pub absolute_path: PathBuf,
    pub byte_length: u64,
    pub sha256: String,
    /// Original source file name (e.g. "photo.png") so consumers that need the
    /// real extension (MIME detection, upload filename) can use it instead of the
    /// generic staging name `input.bin`.
    pub source_name: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum FileGrantError {
    #[error("invalid_selection")]
    InvalidSelection,
    #[error("invalid_request")]
    InvalidRequest,
    #[error("unauthorized")]
    Unauthorized,
    #[error("grant_not_found")]
    NotFound,
    #[error("grant_mismatch")]
    GrantMismatch,
    #[error("grant_expired")]
    Expired,
    #[error("grant_already_consumed")]
    AlreadyConsumed,
    #[error("active_grant_limit")]
    ActiveGrantLimit,
    #[error("file_size_limit")]
    FileSizeLimit,
    #[error("staging_bytes_limit")]
    StagingBytesLimit,
    #[error("integrity_mismatch")]
    IntegrityMismatch,
    #[error("storage_unavailable")]
    StorageUnavailable,
}

impl Serialize for FileGrantError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.collect_str(self)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct FileIdentity {
    len: u64,
    modified: Option<SystemTime>,
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
}

impl FileIdentity {
    fn from(metadata: &Metadata) -> Self {
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;

        Self {
            len: metadata.len(),
            modified: metadata.modified().ok(),
            #[cfg(unix)]
            device: metadata.dev(),
            #[cfg(unix)]
            inode: metadata.ino(),
        }
    }

    fn same_object(&self, other: &Self) -> bool {
        #[cfg(unix)]
        return self.device == other.device && self.inode == other.inode;
        #[cfg(not(unix))]
        return self == other;
    }
}

#[derive(Debug)]
struct FileGrantEntry {
    public: PublicFileGrant,
    owner: FileGrantOwner,
    service_id: String,
    operation_id: String,
    selected_path: PathBuf,
    selected_identity: Option<FileIdentity>,
    parent_identity: Option<FileIdentity>,
    max_bytes: u64,
    consumed: bool,
    staging_dir: Option<PathBuf>,
}

pub struct FeatureFileGrantService {
    data_root: PathBuf,
    limits: FileGrantLimits,
    ttl: Duration,
    grants: Mutex<BTreeMap<String, FileGrantEntry>>,
}

#[cfg(unix)]
fn make_private(path: &Path, directory: bool) -> Result<(), FileGrantError> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(
        path,
        std::fs::Permissions::from_mode(if directory { 0o700 } else { 0o600 }),
    )
    .map_err(|_| FileGrantError::StorageUnavailable)
}

#[cfg(not(unix))]
fn make_private(_path: &Path, _directory: bool) -> Result<(), FileGrantError> {
    Ok(())
}

fn create_private_relative(base: &Path, relative: &Path) -> Result<PathBuf, FileGrantError> {
    let base_metadata =
        std::fs::symlink_metadata(base).map_err(|_| FileGrantError::StorageUnavailable)?;
    if !base_metadata.file_type().is_dir() || base_metadata.file_type().is_symlink() {
        return Err(FileGrantError::StorageUnavailable);
    }
    let mut current = base.to_path_buf();
    for component in relative.components() {
        let std::path::Component::Normal(component) = component else {
            return Err(FileGrantError::StorageUnavailable);
        };
        current.push(component);
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_dir() && !metadata.file_type().is_symlink() => {
            }
            Ok(_) => return Err(FileGrantError::StorageUnavailable),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                std::fs::create_dir(&current).map_err(|_| FileGrantError::StorageUnavailable)?;
            }
            Err(_) => return Err(FileGrantError::StorageUnavailable),
        }
        make_private(&current, true)?;
    }
    Ok(current)
}

fn create_private_file(path: &Path) -> Result<File, FileGrantError> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let file = options
        .open(path)
        .map_err(|_| FileGrantError::StorageUnavailable)?;
    make_private(path, false)?;
    Ok(file)
}

fn open_regular_file(path: &Path) -> Result<(File, FileIdentity), FileGrantError> {
    let before = std::fs::symlink_metadata(path).map_err(|_| FileGrantError::InvalidSelection)?;
    if !before.file_type().is_file() || before.file_type().is_symlink() {
        return Err(FileGrantError::InvalidSelection);
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options
        .open(path)
        .map_err(|_| FileGrantError::InvalidSelection)?;
    let identity = FileIdentity::from(
        &file
            .metadata()
            .map_err(|_| FileGrantError::InvalidSelection)?,
    );
    if identity != FileIdentity::from(&before) {
        return Err(FileGrantError::InvalidSelection);
    }
    Ok((file, identity))
}

#[cfg(unix)]
fn c_string(value: &std::ffi::OsStr) -> Result<std::ffi::CString, FileGrantError> {
    use std::os::unix::ffi::OsStrExt;
    std::ffi::CString::new(value.as_bytes()).map_err(|_| FileGrantError::InvalidSelection)
}

#[cfg(unix)]
fn open_directory(path: &Path) -> Result<File, FileGrantError> {
    use std::os::fd::FromRawFd;
    let path = c_string(path.as_os_str())?;
    // SAFETY: path is a valid NUL-terminated string; the returned fd is immediately owned by File.
    let fd = unsafe {
        libc::open(
            path.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(FileGrantError::InvalidSelection);
    }
    // SAFETY: open returned a new owned descriptor.
    Ok(unsafe { File::from_raw_fd(fd) })
}

#[cfg(unix)]
fn open_child_identity(
    directory: &File,
    name: &std::ffi::CString,
) -> Result<Option<FileIdentity>, FileGrantError> {
    use std::os::fd::{AsRawFd, FromRawFd};
    // SAFETY: directory is live and name is NUL-terminated; a successful fd is immediately owned.
    let fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return match std::io::Error::last_os_error().raw_os_error() {
            Some(libc::ENOENT) => Ok(None),
            _ => Err(FileGrantError::InvalidSelection),
        };
    }
    // SAFETY: openat returned a new owned descriptor.
    let file = unsafe { File::from_raw_fd(fd) };
    let metadata = file
        .metadata()
        .map_err(|_| FileGrantError::InvalidSelection)?;
    if !metadata.file_type().is_file() {
        return Err(FileGrantError::InvalidSelection);
    }
    Ok(Some(FileIdentity::from(&metadata)))
}

struct AtomicTargetFile {
    file: Option<File>,
    #[cfg(unix)]
    directory: File,
    #[cfg(unix)]
    temporary_name: std::ffi::CString,
    #[cfg(unix)]
    target_name: std::ffi::CString,
    #[cfg(unix)]
    expected_target: Option<FileIdentity>,
    #[cfg(not(unix))]
    temporary_path: PathBuf,
    #[cfg(not(unix))]
    target_path: PathBuf,
    committed: bool,
}

pub(crate) struct PreparedDownload {
    target: Option<AtomicTargetFile>,
    staging_dir: PathBuf,
}

impl PreparedDownload {
    pub(crate) fn commit(mut self) -> Result<(), FileGrantError> {
        self.target
            .take()
            .ok_or(FileGrantError::StorageUnavailable)?
            .commit()?;
        remove_path(&self.staging_dir);
        Ok(())
    }
}

impl Drop for PreparedDownload {
    fn drop(&mut self) {
        remove_path(&self.staging_dir);
    }
}

impl AtomicTargetFile {
    fn new(
        target: &Path,
        expected_parent: &FileIdentity,
        expected_target: &Option<FileIdentity>,
    ) -> Result<Self, FileGrantError> {
        let parent = target.parent().ok_or(FileGrantError::InvalidSelection)?;

        #[cfg(unix)]
        {
            use std::os::fd::{AsRawFd, FromRawFd};
            let directory = open_directory(parent)?;
            if !FileIdentity::from(
                &directory
                    .metadata()
                    .map_err(|_| FileGrantError::InvalidSelection)?,
            )
            .same_object(expected_parent)
            {
                return Err(FileGrantError::InvalidSelection);
            }
            let target_name =
                c_string(target.file_name().ok_or(FileGrantError::InvalidSelection)?)?;
            if open_child_identity(&directory, &target_name)? != *expected_target {
                return Err(FileGrantError::InvalidSelection);
            }
            let temporary_name =
                std::ffi::CString::new(format!(".bibit-{}.tmp", uuid::Uuid::new_v4()))
                    .expect("UUID filename has no NUL");
            // SAFETY: directory is live and name is NUL-terminated; a successful fd is immediately owned.
            let fd = unsafe {
                libc::openat(
                    directory.as_raw_fd(),
                    temporary_name.as_ptr(),
                    libc::O_WRONLY
                        | libc::O_CREAT
                        | libc::O_EXCL
                        | libc::O_NOFOLLOW
                        | libc::O_CLOEXEC,
                    0o600,
                )
            };
            if fd < 0 {
                return Err(FileGrantError::StorageUnavailable);
            }
            // SAFETY: openat returned a new owned descriptor.
            let file = unsafe { File::from_raw_fd(fd) };
            return Ok(Self {
                file: Some(file),
                directory,
                temporary_name,
                target_name,
                expected_target: expected_target.clone(),
                committed: false,
            });
        }

        #[cfg(not(unix))]
        {
            let current_parent =
                std::fs::symlink_metadata(parent).map_err(|_| FileGrantError::InvalidSelection)?;
            if FileIdentity::from(&current_parent) != *expected_parent {
                return Err(FileGrantError::InvalidSelection);
            }
            let current_target = match std::fs::symlink_metadata(target) {
                Ok(metadata)
                    if metadata.file_type().is_file() && !metadata.file_type().is_symlink() =>
                {
                    Some(FileIdentity::from(&metadata))
                }
                Ok(_) => return Err(FileGrantError::InvalidSelection),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(_) => return Err(FileGrantError::InvalidSelection),
            };
            if current_target != *expected_target {
                return Err(FileGrantError::InvalidSelection);
            }
            let temporary_path = parent.join(format!(".bibit-{}.tmp", uuid::Uuid::new_v4()));
            let file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary_path)
                .map_err(|_| FileGrantError::StorageUnavailable)?;
            make_private(&temporary_path, false)?;
            Ok(Self {
                file: Some(file),
                temporary_path,
                target_path: target.to_path_buf(),
                committed: false,
            })
        }
    }

    fn writer(&mut self) -> &mut File {
        self.file.as_mut().expect("temporary file is open")
    }

    fn commit(mut self) -> Result<(), FileGrantError> {
        drop(self.file.take());
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            if open_child_identity(&self.directory, &self.target_name)? != self.expected_target {
                return Err(FileGrantError::InvalidSelection);
            }
            // SAFETY: both names are relative to the same live directory descriptor.
            if unsafe {
                libc::renameat(
                    self.directory.as_raw_fd(),
                    self.temporary_name.as_ptr(),
                    self.directory.as_raw_fd(),
                    self.target_name.as_ptr(),
                )
            } != 0
            {
                return Err(FileGrantError::StorageUnavailable);
            }
        }
        #[cfg(not(unix))]
        std::fs::rename(&self.temporary_path, &self.target_path)
            .map_err(|_| FileGrantError::StorageUnavailable)?;
        self.committed = true;
        Ok(())
    }
}

impl Drop for AtomicTargetFile {
    fn drop(&mut self) {
        if self.committed {
            return;
        }
        drop(self.file.take());
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            // SAFETY: name is relative to the live directory descriptor; failure only leaves cleanup work.
            let _ = unsafe {
                libc::unlinkat(self.directory.as_raw_fd(), self.temporary_name.as_ptr(), 0)
            };
        }
        #[cfg(not(unix))]
        remove_path(&self.temporary_path);
    }
}

fn remove_path(path: &Path) {
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return;
    };
    if metadata.file_type().is_dir() && !metadata.file_type().is_symlink() {
        let _ = std::fs::remove_dir_all(path);
    } else {
        let _ = std::fs::remove_file(path);
    }
}

fn directory_bytes(path: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };
    entries
        .filter_map(Result::ok)
        .map(|entry| {
            let path = entry.path();
            match std::fs::symlink_metadata(&path) {
                Ok(metadata) if metadata.file_type().is_file() => metadata.len(),
                Ok(metadata) if metadata.file_type().is_dir() => directory_bytes(&path),
                _ => 0,
            }
        })
        .sum()
}

fn copy_and_hash(
    input: &mut File,
    output: &mut File,
    max_bytes: u64,
) -> Result<(u64, String), FileGrantError> {
    let mut bytes = 0_u64;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = input
            .read(&mut buffer)
            .map_err(|_| FileGrantError::StorageUnavailable)?;
        if read == 0 {
            break;
        }
        bytes = bytes
            .checked_add(read as u64)
            .ok_or(FileGrantError::FileSizeLimit)?;
        if bytes > max_bytes {
            return Err(FileGrantError::FileSizeLimit);
        }
        output
            .write_all(&buffer[..read])
            .map_err(|_| FileGrantError::StorageUnavailable)?;
        digest.update(&buffer[..read]);
    }
    output
        .sync_all()
        .map_err(|_| FileGrantError::StorageUnavailable)?;
    Ok((bytes, format!("{:x}", digest.finalize())))
}

impl FeatureFileGrantService {
    pub(crate) fn new(data_root: PathBuf) -> Result<Self, FileGrantError> {
        Self::new_with_limits(data_root, FileGrantLimits::default(), DEFAULT_GRANT_TTL)
    }

    fn new_with_limits(
        data_root: PathBuf,
        limits: FileGrantLimits,
        ttl: Duration,
    ) -> Result<Self, FileGrantError> {
        create_private_relative(&data_root, Path::new("providers"))?;
        Ok(Self {
            data_root,
            limits,
            ttl,
            grants: Mutex::new(BTreeMap::new()),
        })
    }

    pub(crate) fn cleanup_unowned_staging(&self) {
        let providers = self.data_root.join("providers");
        if let Ok(entries) = std::fs::read_dir(providers) {
            for service in entries.filter_map(Result::ok) {
                if service
                    .file_type()
                    .is_ok_and(|kind| kind.is_dir() && !kind.is_symlink())
                {
                    remove_path(&service.path().join("transfers"));
                }
            }
        }
    }

    fn service_staging_root(&self, service_id: &str) -> PathBuf {
        self.data_root
            .join("providers")
            .join(service_id)
            .join("transfers")
    }

    pub(crate) fn data_root(&self) -> &Path {
        &self.data_root
    }

    fn feature_staging_root(&self, service_id: &str, feature_id: &str) -> PathBuf {
        self.service_staging_root(service_id).join(feature_id)
    }

    fn take_expired_paths(grants: &mut BTreeMap<String, FileGrantEntry>) -> Vec<PathBuf> {
        let now = Utc::now();
        let mut paths = Vec::new();
        grants.retain(|_, entry| {
            if entry.public.expires_at <= now {
                paths.extend(entry.staging_dir.take());
                false
            } else {
                true
            }
        });
        paths
    }

    pub(crate) fn register_selected_path(
        &self,
        owner: FileGrantOwner,
        service_id: &str,
        operation_id: &str,
        direction: FileGrantDirection,
        selected_path: PathBuf,
    ) -> Result<PublicFileGrant, FileGrantError> {
        self.register_selected_path_with_limit(
            owner,
            service_id,
            operation_id,
            direction,
            selected_path,
            None,
        )
    }

    pub(crate) fn register_selected_path_with_limit(
        &self,
        owner: FileGrantOwner,
        service_id: &str,
        operation_id: &str,
        direction: FileGrantDirection,
        selected_path: PathBuf,
        requested_max_bytes: Option<u64>,
    ) -> Result<PublicFileGrant, FileGrantError> {
        if !crate::feature_capabilities::valid_id(&owner.feature_id)
            || owner.feature_instance_id.is_empty()
            || !crate::feature_capabilities::valid_id(service_id)
            || !crate::feature_capabilities::valid_operation(operation_id)
            || requested_max_bytes == Some(0)
        {
            return Err(FileGrantError::InvalidRequest);
        }
        let max_bytes = requested_max_bytes
            .unwrap_or(self.limits.max_file_bytes)
            .min(self.limits.max_file_bytes);

        let (display_name, byte_length, selected_identity, parent_identity) = match direction {
            FileGrantDirection::Upload => {
                let (_, identity) = open_regular_file(&selected_path)?;
                if identity.len > max_bytes {
                    return Err(FileGrantError::FileSizeLimit);
                }
                (
                    selected_path
                        .file_name()
                        .and_then(|name| name.to_str())
                        .filter(|name| !name.is_empty())
                        .unwrap_or("Selected file")
                        .to_owned(),
                    Some(identity.len),
                    Some(identity),
                    None,
                )
            }
            FileGrantDirection::Download => {
                let parent = selected_path
                    .parent()
                    .ok_or(FileGrantError::InvalidSelection)?;
                let parent_metadata = std::fs::symlink_metadata(parent)
                    .map_err(|_| FileGrantError::InvalidSelection)?;
                if !parent_metadata.file_type().is_dir() || parent_metadata.file_type().is_symlink()
                {
                    return Err(FileGrantError::InvalidSelection);
                }
                let existing = match std::fs::symlink_metadata(&selected_path) {
                    Ok(metadata)
                        if metadata.file_type().is_file() && !metadata.file_type().is_symlink() =>
                    {
                        Some(FileIdentity::from(&metadata))
                    }
                    Ok(_) => return Err(FileGrantError::InvalidSelection),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                    Err(_) => return Err(FileGrantError::InvalidSelection),
                };
                (
                    selected_path
                        .file_name()
                        .and_then(|name| name.to_str())
                        .filter(|name| !name.is_empty())
                        .unwrap_or("Download")
                        .to_owned(),
                    None,
                    existing,
                    Some(FileIdentity::from(&parent_metadata)),
                )
            }
        };

        let mut grants = self
            .grants
            .lock()
            .map_err(|_| FileGrantError::StorageUnavailable)?;
        let expired_paths = Self::take_expired_paths(&mut grants);
        let active = grants
            .values()
            .filter(|entry| entry.owner == owner && entry.service_id == service_id)
            .count();
        if active >= self.limits.max_active_per_feature_service {
            drop(grants);
            for path in expired_paths {
                remove_path(&path);
            }
            return Err(FileGrantError::ActiveGrantLimit);
        }

        let grant_id = uuid::Uuid::new_v4().to_string();
        let public = PublicFileGrant {
            version: 1,
            grant_id: grant_id.clone(),
            direction,
            display_name,
            expires_at: DateTime::<Utc>::from(SystemTime::now() + self.ttl),
            byte_length,
        };
        grants.insert(
            grant_id,
            FileGrantEntry {
                public: public.clone(),
                owner,
                service_id: service_id.into(),
                operation_id: operation_id.into(),
                selected_path,
                selected_identity,
                parent_identity,
                max_bytes,
                consumed: false,
                staging_dir: None,
            },
        );
        drop(grants);
        for path in expired_paths {
            remove_path(&path);
        }
        Ok(public)
    }

    fn register_selection(
        &self,
        owner: FileGrantOwner,
        service_id: &str,
        operation_id: &str,
        direction: FileGrantDirection,
        selected_path: Option<PathBuf>,
        max_bytes: Option<u64>,
    ) -> Result<Option<PublicFileGrant>, FileGrantError> {
        selected_path
            .map(|path| {
                self.register_selected_path_with_limit(
                    owner,
                    service_id,
                    operation_id,
                    direction,
                    path,
                    max_bytes,
                )
            })
            .transpose()
    }

    pub(crate) fn grant_direction(
        &self,
        grant_id: &str,
        owner: &FileGrantOwner,
        service_id: &str,
        operation_id: &str,
    ) -> Result<FileGrantDirection, FileGrantError> {
        let grants = self
            .grants
            .lock()
            .map_err(|_| FileGrantError::StorageUnavailable)?;
        let entry = grants.get(grant_id).ok_or(FileGrantError::NotFound)?;
        if entry.public.expires_at <= Utc::now() {
            return Err(FileGrantError::Expired);
        }
        if entry.owner != *owner
            || entry.service_id != service_id
            || entry.operation_id != operation_id
        {
            return Err(FileGrantError::GrantMismatch);
        }
        if entry.consumed {
            return Err(FileGrantError::AlreadyConsumed);
        }
        Ok(entry.public.direction)
    }

    fn consume(
        &self,
        grant_id: &str,
        owner: &FileGrantOwner,
        service_id: &str,
        operation_id: &str,
        expected_direction: FileGrantDirection,
    ) -> Result<(PathBuf, PathBuf, Option<FileIdentity>, u64), FileGrantError> {
        let mut grants = self
            .grants
            .lock()
            .map_err(|_| FileGrantError::StorageUnavailable)?;
        if grants
            .get(grant_id)
            .is_some_and(|entry| entry.public.expires_at <= Utc::now())
        {
            let staging_dir = grants
                .remove(grant_id)
                .and_then(|mut entry| entry.staging_dir.take());
            drop(grants);
            if let Some(path) = staging_dir {
                remove_path(&path);
            }
            return Err(FileGrantError::Expired);
        }
        let entry = grants.get_mut(grant_id).ok_or(FileGrantError::NotFound)?;
        if entry.owner != *owner
            || entry.service_id != service_id
            || entry.operation_id != operation_id
            || entry.public.direction != expected_direction
        {
            return Err(FileGrantError::GrantMismatch);
        }
        if entry.consumed {
            return Err(FileGrantError::AlreadyConsumed);
        }
        let job_dir = create_private_relative(
            &self.data_root,
            &Path::new("providers")
                .join(service_id)
                .join("transfers")
                .join(&owner.feature_id)
                .join(uuid::Uuid::new_v4().to_string()),
        )?;
        entry.consumed = true;
        entry.staging_dir = Some(job_dir.clone());
        Ok((
            entry.selected_path.clone(),
            job_dir,
            entry.selected_identity.clone(),
            entry.max_bytes,
        ))
    }

    fn rollback_consume(&self, grant_id: &str, job_dir: &Path) {
        if let Ok(mut grants) = self.grants.lock() {
            if let Some(entry) = grants.get_mut(grant_id) {
                if entry.staging_dir.as_deref() == Some(job_dir) {
                    entry.consumed = false;
                    entry.staging_dir = None;
                }
            }
        }
        remove_path(job_dir);
    }

    pub(crate) fn consume_upload(
        &self,
        grant_id: &str,
        owner: &FileGrantOwner,
        service_id: &str,
        operation_id: &str,
    ) -> Result<StagedFile, FileGrantError> {
        let (source_path, job_dir, expected_identity, max_bytes) = self.consume(
            grant_id,
            owner,
            service_id,
            operation_id,
            FileGrantDirection::Upload,
        )?;
        let source_name = source_path
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .unwrap_or("input.bin")
            .to_owned();
        let output_path = job_dir.join("input.bin");
        let result = (|| {
            let (mut input, identity) = open_regular_file(&source_path)?;
            let expected_identity = expected_identity.ok_or(FileGrantError::InvalidSelection)?;
            if identity != expected_identity {
                return Err(FileGrantError::InvalidSelection);
            }
            let current_bytes =
                directory_bytes(&self.feature_staging_root(service_id, &owner.feature_id));
            if current_bytes
                .checked_add(identity.len)
                .is_none_or(|bytes| bytes > self.limits.max_staging_bytes_per_feature_service)
            {
                return Err(FileGrantError::StagingBytesLimit);
            }
            let mut output = create_private_file(&output_path)?;
            let (byte_length, sha256) = copy_and_hash(&mut input, &mut output, max_bytes)?;
            let (_, after) = open_regular_file(&source_path)?;
            if after != expected_identity {
                return Err(FileGrantError::InvalidSelection);
            }
            let feature_relative = output_path
                .strip_prefix(self.data_root.join("providers").join(service_id))
                .map_err(|_| FileGrantError::StorageUnavailable)?;
            Ok(StagedFile {
                grant_id: grant_id.into(),
                resource_path: feature_relative.to_string_lossy().replace('\\', "/"),
                absolute_path: output_path.clone(),
                byte_length,
                sha256,
                source_name,
            })
        })();
        if result.is_err() {
            self.rollback_consume(grant_id, &job_dir);
        }
        result
    }

    pub(crate) fn consume_download(
        &self,
        grant_id: &str,
        owner: &FileGrantOwner,
        service_id: &str,
        operation_id: &str,
    ) -> Result<StagedFile, FileGrantError> {
        let (_, job_dir, _, _) = self.consume(
            grant_id,
            owner,
            service_id,
            operation_id,
            FileGrantDirection::Download,
        )?;
        let output_path = job_dir.join("output.bin");
        let output = match create_private_file(&output_path) {
            Ok(output) => output,
            Err(error) => {
                self.rollback_consume(grant_id, &job_dir);
                return Err(error);
            }
        };
        drop(output);
        let resource_path =
            match output_path.strip_prefix(self.data_root.join("providers").join(service_id)) {
                Ok(path) => path,
                Err(_) => {
                    self.rollback_consume(grant_id, &job_dir);
                    return Err(FileGrantError::StorageUnavailable);
                }
            }
            .to_string_lossy()
            .replace('\\', "/");
        Ok(StagedFile {
            grant_id: grant_id.into(),
            resource_path,
            absolute_path: output_path,
            byte_length: 0,
            sha256: String::new(),
            source_name: String::new(),
        })
    }

    pub(crate) fn validate_download_growth(&self, grant_id: &str) -> Result<u64, FileGrantError> {
        let grants = self
            .grants
            .lock()
            .map_err(|_| FileGrantError::StorageUnavailable)?;
        let entry = grants.get(grant_id).ok_or(FileGrantError::NotFound)?;
        let staging_dir = entry
            .staging_dir
            .clone()
            .ok_or(FileGrantError::AlreadyConsumed)?;
        let service_id = entry.service_id.clone();
        let feature_id = entry.owner.feature_id.clone();
        let max_bytes = entry.max_bytes;
        drop(grants);
        let output = staging_dir.join("output.bin");
        let metadata =
            std::fs::symlink_metadata(&output).map_err(|_| FileGrantError::StorageUnavailable)?;
        let bytes = metadata.len();
        if !metadata.file_type().is_file() || metadata.file_type().is_symlink() || bytes > max_bytes
        {
            remove_path(&staging_dir);
            return Err(FileGrantError::FileSizeLimit);
        }
        let feature_bytes = directory_bytes(&self.feature_staging_root(&service_id, &feature_id));
        if feature_bytes > self.limits.max_staging_bytes_per_feature_service {
            remove_path(&staging_dir);
            return Err(FileGrantError::StagingBytesLimit);
        }
        Ok(bytes)
    }

    pub(crate) fn prepare_download(
        &self,
        grant_id: &str,
        expected_bytes: u64,
        expected_sha256: &str,
    ) -> Result<PreparedDownload, FileGrantError> {
        let (target, selected_identity, parent_identity, staging_dir, max_bytes) = {
            let grants = self
                .grants
                .lock()
                .map_err(|_| FileGrantError::StorageUnavailable)?;
            let entry = grants.get(grant_id).ok_or(FileGrantError::NotFound)?;
            if entry.public.direction != FileGrantDirection::Download || !entry.consumed {
                return Err(FileGrantError::GrantMismatch);
            }
            (
                entry.selected_path.clone(),
                entry.selected_identity.clone(),
                entry.parent_identity.clone(),
                entry
                    .staging_dir
                    .clone()
                    .ok_or(FileGrantError::StorageUnavailable)?,
                entry.max_bytes,
            )
        };
        let result = (|| {
            self.validate_download_growth(grant_id)?;
            let staged_path = staging_dir.join("output.bin");
            let (mut staged, identity) = open_regular_file(&staged_path)?;
            if identity.len != expected_bytes {
                return Err(FileGrantError::IntegrityMismatch);
            }
            let mut temporary = AtomicTargetFile::new(
                &target,
                parent_identity
                    .as_ref()
                    .ok_or(FileGrantError::InvalidSelection)?,
                &selected_identity,
            )?;
            let (bytes, sha256) = copy_and_hash(&mut staged, temporary.writer(), max_bytes)?;
            if bytes != expected_bytes || sha256 != expected_sha256 {
                return Err(FileGrantError::IntegrityMismatch);
            }
            Ok(PreparedDownload {
                target: Some(temporary),
                staging_dir: staging_dir.clone(),
            })
        })();
        if result.is_err() {
            remove_path(&staging_dir);
        }
        result
    }

    pub(crate) fn publish_download(
        &self,
        grant_id: &str,
        expected_bytes: u64,
        expected_sha256: &str,
    ) -> Result<(), FileGrantError> {
        self.prepare_download(grant_id, expected_bytes, expected_sha256)?
            .commit()
    }

    /// Writes Feature-supplied bytes to the download location the user selected
    /// for `grant_id`, reusing the staged-then-atomic publish path Provider
    /// downloads use. The Grant is consumed by this call.
    pub(crate) fn publish_feature_bytes(
        &self,
        grant_id: &str,
        owner: &FileGrantOwner,
        service_id: &str,
        operation_id: &str,
        bytes: &[u8],
        expected_bytes: u64,
        expected_sha256: &str,
    ) -> Result<(), FileGrantError> {
        if bytes.len() as u64 != expected_bytes {
            return Err(FileGrantError::IntegrityMismatch);
        }
        if expected_bytes > self.limits.max_file_bytes {
            return Err(FileGrantError::FileSizeLimit);
        }
        let staged = self.consume_download(grant_id, owner, service_id, operation_id)?;
        let write = (|| -> Result<(), FileGrantError> {
            let mut options = OpenOptions::new();
            options.write(true).truncate(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.custom_flags(libc::O_NOFOLLOW);
            }
            let mut staged_file = options
                .open(&staged.absolute_path)
                .map_err(|_| FileGrantError::StorageUnavailable)?;
            staged_file
                .write_all(bytes)
                .map_err(|_| FileGrantError::StorageUnavailable)?;
            staged_file
                .sync_all()
                .map_err(|_| FileGrantError::StorageUnavailable)?;
            Ok(())
        })();
        if write.is_err() {
            self.cleanup_grant(&staged.grant_id);
            return write;
        }
        self.publish_download(&staged.grant_id, expected_bytes, expected_sha256)
    }

    pub(crate) fn cleanup_grant(&self, grant_id: &str) {
        let path = self
            .grants
            .lock()
            .ok()
            .and_then(|mut grants| grants.remove(grant_id))
            .and_then(|mut entry| entry.staging_dir.take());
        if let Some(path) = path {
            remove_path(&path);
        }
    }

    pub(crate) fn cleanup_owner_instance(&self, feature_id: &str, instance_id: &str) {
        let paths = self
            .grants
            .lock()
            .map(|mut grants| {
                let ids = grants
                    .iter()
                    .filter_map(|(id, entry)| {
                        (entry.owner.feature_id == feature_id
                            && entry.owner.feature_instance_id == instance_id)
                            .then(|| id.clone())
                    })
                    .collect::<Vec<_>>();
                ids.into_iter()
                    .filter_map(|id| grants.remove(&id)?.staging_dir)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for path in paths {
            remove_path(&path);
        }
    }

    #[cfg(test)]
    fn active_grant_count(&self) -> usize {
        self.grants
            .lock()
            .map(|grants| grants.values().filter(|entry| !entry.consumed).count())
            .unwrap_or_default()
    }
}

fn safe_suggested_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value != "."
        && value != ".."
        && !value.contains('/')
        && !value.contains('\\')
        && !value.contains('\0')
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn credentials_authorized(
    feature_id: &str,
    plugin_version: &str,
    feature_instance_token: &str,
    service_id: &str,
    operation_id: &str,
) -> bool {
    crate::trusted_plugins::validate_feature_instance_version_capability(
        feature_id,
        plugin_version,
        feature_instance_token,
        "file:transfer",
    ) && crate::trusted_plugins::validate_feature_instance_version_capability(
        feature_id,
        plugin_version,
        feature_instance_token,
        &format!("service:{service_id}"),
    ) && crate::feature_capabilities::runtime_grants_allow(
        feature_id,
        service_id,
        operation_id,
        "file:transfer",
    )
}

fn request_authorized(request: &FileGrantSelectionRequest) -> bool {
    credentials_authorized(
        &request.feature_id,
        &request.plugin_version,
        &request.feature_instance_token,
        &request.service_id,
        &request.operation_id,
    )
}

fn publish_authorized(request: &FileGrantPublishRequest) -> bool {
    credentials_authorized(
        &request.feature_id,
        &request.plugin_version,
        &request.feature_instance_token,
        &request.service_id,
        &request.operation_id,
    )
}

#[tauri::command]
pub async fn feature_file_grant_select<R: tauri::Runtime>(
    window: WebviewWindow<R>,
    file_grants: tauri::State<'_, Arc<FeatureFileGrantService>>,
    request: FileGrantSelectionRequest,
) -> Result<Option<PublicFileGrant>, FileGrantError> {
    if window.label() != "main" || !request_authorized(&request) {
        return Err(FileGrantError::Unauthorized);
    }
    if request
        .suggested_name
        .as_deref()
        .is_some_and(|name| !safe_suggested_name(name))
    {
        return Err(FileGrantError::InvalidRequest);
    }
    if request.max_bytes == Some(0) {
        return Err(FileGrantError::InvalidRequest);
    }

    let mut dialog = AsyncFileDialog::new();
    if let Some(name) = request.suggested_name.as_deref() {
        dialog = dialog.set_file_name(name);
    }
    let selected = match request.direction {
        FileGrantDirection::Upload => dialog.pick_file().await,
        FileGrantDirection::Download => dialog.save_file().await,
    };
    let Some(selected) = selected else {
        return Ok(None);
    };
    if !request_authorized(&request) {
        return Err(FileGrantError::Unauthorized);
    }
    file_grants.register_selection(
        FileGrantOwner {
            feature_id: request.feature_id,
            feature_instance_id: request.feature_instance_token,
        },
        &request.service_id,
        &request.operation_id,
        request.direction,
        Some(selected.path().to_path_buf()),
        request.max_bytes,
    )
}

#[tauri::command]
pub async fn feature_file_grant_publish<R: tauri::Runtime>(
    window: WebviewWindow<R>,
    file_grants: tauri::State<'_, Arc<FeatureFileGrantService>>,
    request: FileGrantPublishRequest,
) -> Result<(), FileGrantError> {
    if window.label() != "main" || !publish_authorized(&request) {
        return Err(FileGrantError::Unauthorized);
    }
    if !is_sha256_hex(&request.sha256) {
        return Err(FileGrantError::InvalidRequest);
    }
    let content = BASE64
        .decode(request.content_base64.as_bytes())
        .map_err(|_| FileGrantError::InvalidRequest)?;
    let grants = file_grants.inner().clone();
    let owner = FileGrantOwner {
        feature_id: request.feature_id,
        feature_instance_id: request.feature_instance_token,
    };
    let grant_id = request.grant_id;
    let service_id = request.service_id;
    let operation_id = request.operation_id;
    let expected_bytes = request.byte_length;
    let expected_sha256 = request.sha256;
    tauri::async_runtime::spawn_blocking(move || {
        grants.publish_feature_bytes(
            &grant_id,
            &owner,
            &service_id,
            &operation_id,
            &content,
            expected_bytes,
            &expected_sha256,
        )
    })
    .await
    .map_err(|_| FileGrantError::StorageUnavailable)?
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    fn owner(instance: &str) -> FileGrantOwner {
        FileGrantOwner {
            feature_id: "agent-hub".into(),
            feature_instance_id: instance.into(),
        }
    }

    fn service(root: &std::path::Path) -> FeatureFileGrantService {
        FeatureFileGrantService::new_with_limits(
            root.to_path_buf(),
            FileGrantLimits {
                max_active_per_feature_service: 4,
                max_file_bytes: 32,
                max_staging_bytes_per_feature_service: 64,
            },
            std::time::Duration::from_secs(60),
        )
        .unwrap()
    }

    #[test]
    fn consumes_an_upload_once_without_exposing_the_source_path() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("selected.agent");
        std::fs::write(&source, b"agent-package").unwrap();
        let file_grants = service(root.path());
        let grant = file_grants
            .register_selected_path(
                owner("instance-1"),
                "store",
                "agents.upload.v1",
                FileGrantDirection::Upload,
                source.clone(),
            )
            .unwrap();

        let staged = file_grants
            .consume_upload(
                &grant.grant_id,
                &owner("instance-1"),
                "store",
                "agents.upload.v1",
            )
            .unwrap();

        assert_eq!(
            std::fs::read(&staged.absolute_path).unwrap(),
            b"agent-package"
        );
        assert_eq!(
            staged.sha256,
            format!("{:x}", Sha256::digest(b"agent-package"))
        );
        assert!(!serde_json::to_string(&grant)
            .unwrap()
            .contains(source.to_string_lossy().as_ref()));
        assert_eq!(
            file_grants
                .consume_upload(
                    &grant.grant_id,
                    &owner("instance-1"),
                    "store",
                    "agents.upload.v1",
                )
                .unwrap_err(),
            FileGrantError::AlreadyConsumed
        );
    }

    #[test]
    fn cancelled_selection_does_not_create_a_grant() {
        let root = tempfile::tempdir().unwrap();
        let file_grants = service(root.path());

        assert!(file_grants
            .register_selection(
                owner("instance-1"),
                "store",
                "agents.upload.v1",
                FileGrantDirection::Upload,
                None,
                None,
            )
            .unwrap()
            .is_none());
        assert_eq!(file_grants.active_grant_count(), 0);
    }

    #[test]
    fn rejects_owner_service_operation_and_direction_mismatches_without_paths() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("secret.agent");
        std::fs::write(&source, b"agent").unwrap();
        let file_grants = service(root.path());
        let grant = file_grants
            .register_selected_path(
                owner("instance-1"),
                "store",
                "agents.upload.v1",
                FileGrantDirection::Upload,
                source.clone(),
            )
            .unwrap();

        for (actual_owner, actual_service, actual_operation) in [
            (owner("instance-2"), "store", "agents.upload.v1"),
            (owner("instance-1"), "other", "agents.upload.v1"),
            (owner("instance-1"), "store", "agents.download.v1"),
        ] {
            let error = file_grants
                .consume_upload(
                    &grant.grant_id,
                    &actual_owner,
                    actual_service,
                    actual_operation,
                )
                .unwrap_err();
            assert_eq!(error, FileGrantError::GrantMismatch);
            assert!(!error
                .to_string()
                .contains(source.to_string_lossy().as_ref()));
        }
    }

    #[cfg(unix)]
    #[test]
    fn rejects_directories_and_symbolic_links() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source.agent");
        let link = root.path().join("link.agent");
        std::fs::write(&source, b"agent").unwrap();
        symlink(&source, &link).unwrap();
        let service = service(root.path());

        for path in [root.path().to_path_buf(), link] {
            assert_eq!(
                service
                    .register_selected_path(
                        owner("instance-1"),
                        "store",
                        "agents.upload.v1",
                        FileGrantDirection::Upload,
                        path,
                    )
                    .unwrap_err(),
                FileGrantError::InvalidSelection
            );
        }
    }

    #[test]
    fn rejects_a_source_replaced_after_selection_and_removes_staging() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("selected.agent");
        std::fs::write(&source, b"original").unwrap();
        let file_grants = service(root.path());
        let grant = file_grants
            .register_selected_path(
                owner("instance-1"),
                "store",
                "agents.upload.v1",
                FileGrantDirection::Upload,
                source.clone(),
            )
            .unwrap();
        std::fs::remove_file(&source).unwrap();
        std::fs::write(&source, b"replacement").unwrap();

        assert_eq!(
            file_grants
                .consume_upload(
                    &grant.grant_id,
                    &owner("instance-1"),
                    "store",
                    "agents.upload.v1",
                )
                .unwrap_err(),
            FileGrantError::InvalidSelection
        );
        assert_eq!(
            file_grants
                .consume_upload(
                    &grant.grant_id,
                    &owner("instance-1"),
                    "store",
                    "agents.upload.v1",
                )
                .unwrap_err(),
            FileGrantError::InvalidSelection
        );
        assert_eq!(
            directory_bytes(&root.path().join("providers/store/transfers")),
            0
        );
    }

    #[test]
    fn enforces_active_grant_and_file_size_limits() {
        let root = tempfile::tempdir().unwrap();
        let service = service(root.path());
        for index in 0..4 {
            let source = root.path().join(format!("agent-{index}"));
            std::fs::write(&source, b"agent").unwrap();
            service
                .register_selected_path(
                    owner("instance-1"),
                    "store",
                    "agents.upload.v1",
                    FileGrantDirection::Upload,
                    source,
                )
                .unwrap();
        }
        let extra = root.path().join("extra");
        std::fs::write(&extra, b"agent").unwrap();
        assert_eq!(
            service
                .register_selected_path(
                    owner("instance-1"),
                    "store",
                    "agents.upload.v1",
                    FileGrantDirection::Upload,
                    extra,
                )
                .unwrap_err(),
            FileGrantError::ActiveGrantLimit
        );

        let other_service = root.path().join("too-large");
        std::fs::write(&other_service, vec![0; 33]).unwrap();
        assert_eq!(
            service
                .register_selected_path(
                    owner("instance-1"),
                    "other",
                    "agents.upload.v1",
                    FileGrantDirection::Upload,
                    other_service,
                )
                .unwrap_err(),
            FileGrantError::FileSizeLimit
        );

        let requested_limit = root.path().join("requested-limit");
        std::fs::write(&requested_limit, b"agent").unwrap();
        assert_eq!(
            service
                .register_selected_path_with_limit(
                    owner("instance-1"),
                    "limited",
                    "agents.upload.v1",
                    FileGrantDirection::Upload,
                    requested_limit,
                    Some(4),
                )
                .unwrap_err(),
            FileGrantError::FileSizeLimit
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_service_staging_symlink() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("providers")).unwrap();
        symlink(outside.path(), root.path().join("providers/store")).unwrap();
        let source = root.path().join("selected.agent");
        std::fs::write(&source, b"agent").unwrap();
        let file_grants = service(root.path());
        let grant = file_grants
            .register_selected_path(
                owner("instance-1"),
                "store",
                "agents.upload.v1",
                FileGrantDirection::Upload,
                source,
            )
            .unwrap();

        assert_eq!(
            file_grants
                .consume_upload(
                    &grant.grant_id,
                    &owner("instance-1"),
                    "store",
                    "agents.upload.v1",
                )
                .unwrap_err(),
            FileGrantError::StorageUnavailable
        );
        assert_eq!(std::fs::read_dir(outside.path()).unwrap().count(), 0);
    }

    #[test]
    fn accepts_the_staging_boundary_and_rejects_growth_beyond_it() {
        let root = tempfile::tempdir().unwrap();
        let file_grants = service(root.path());
        for index in 0..2 {
            let source = root.path().join(format!("boundary-{index}"));
            std::fs::write(&source, vec![index as u8; 32]).unwrap();
            let grant = file_grants
                .register_selected_path(
                    owner("instance-1"),
                    "store",
                    "agents.upload.v1",
                    FileGrantDirection::Upload,
                    source,
                )
                .unwrap();
            file_grants
                .consume_upload(
                    &grant.grant_id,
                    &owner("instance-1"),
                    "store",
                    "agents.upload.v1",
                )
                .unwrap();
        }
        assert_eq!(
            directory_bytes(&root.path().join("providers/store/transfers")),
            64
        );

        let source = root.path().join("over-boundary");
        std::fs::write(&source, b"x").unwrap();
        let grant = file_grants
            .register_selected_path(
                owner("instance-1"),
                "store",
                "agents.upload.v1",
                FileGrantDirection::Upload,
                source,
            )
            .unwrap();
        assert_eq!(
            file_grants
                .consume_upload(
                    &grant.grant_id,
                    &owner("instance-1"),
                    "store",
                    "agents.upload.v1",
                )
                .unwrap_err(),
            FileGrantError::StagingBytesLimit
        );
        assert_eq!(
            directory_bytes(&root.path().join("providers/store/transfers")),
            64
        );
    }

    #[test]
    fn expires_grants_and_cleans_instance_resources() {
        let root = tempfile::tempdir().unwrap();
        let file_grants = FeatureFileGrantService::new_with_limits(
            root.path().to_path_buf(),
            FileGrantLimits {
                max_active_per_feature_service: 4,
                max_file_bytes: 32,
                max_staging_bytes_per_feature_service: 64,
            },
            std::time::Duration::from_millis(20),
        )
        .unwrap();
        let target = root.path().join("target.agent");
        let grant = file_grants
            .register_selected_path(
                owner("instance-1"),
                "store",
                "agents.download.v1",
                FileGrantDirection::Download,
                target,
            )
            .unwrap();
        let staged = file_grants
            .consume_download(
                &grant.grant_id,
                &owner("instance-1"),
                "store",
                "agents.download.v1",
            )
            .unwrap();
        assert!(staged.absolute_path.exists());

        file_grants.cleanup_owner_instance("agent-hub", "instance-1");
        assert!(!staged.absolute_path.exists());

        let expiring_target = root.path().join("expiring.agent");
        let expiring = file_grants
            .register_selected_path(
                owner("instance-2"),
                "store",
                "agents.download.v1",
                FileGrantDirection::Download,
                expiring_target,
            )
            .unwrap();
        let expiring_staged = file_grants
            .consume_download(
                &expiring.grant_id,
                &owner("instance-2"),
                "store",
                "agents.download.v1",
            )
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(25));

        let source = root.path().join("fresh.agent");
        std::fs::write(&source, b"agent").unwrap();
        file_grants
            .register_selected_path(
                owner("instance-2"),
                "store",
                "agents.upload.v1",
                FileGrantDirection::Upload,
                source,
            )
            .unwrap();
        assert!(!expiring_staged.absolute_path.exists());
        assert_eq!(file_grants.active_grant_count(), 1);
    }

    #[test]
    fn publishes_download_atomically_and_preserves_an_existing_target_on_failure() {
        let root = tempfile::tempdir().unwrap();
        let target_root = tempfile::tempdir().unwrap();
        let target = target_root.path().join("download.agent");
        std::fs::write(&target, b"old").unwrap();
        let file_grants = service(root.path());
        let grant = file_grants
            .register_selected_path(
                owner("instance-1"),
                "store",
                "agents.download.v1",
                FileGrantDirection::Download,
                target.clone(),
            )
            .unwrap();
        let staged = file_grants
            .consume_download(
                &grant.grant_id,
                &owner("instance-1"),
                "store",
                "agents.download.v1",
            )
            .unwrap();
        std::fs::write(&staged.absolute_path, b"new-agent").unwrap();

        assert_eq!(
            file_grants
                .publish_download(&grant.grant_id, 9, "wrong-sha")
                .unwrap_err(),
            FileGrantError::IntegrityMismatch
        );
        assert_eq!(std::fs::read(&target).unwrap(), b"old");

        let grant = file_grants
            .register_selected_path(
                owner("instance-1"),
                "store",
                "agents.download.v1",
                FileGrantDirection::Download,
                target.clone(),
            )
            .unwrap();
        let staged = file_grants
            .consume_download(
                &grant.grant_id,
                &owner("instance-1"),
                "store",
                "agents.download.v1",
            )
            .unwrap();
        std::fs::write(&staged.absolute_path, b"new-agent").unwrap();
        let sha256 = format!("{:x}", Sha256::digest(b"new-agent"));
        file_grants
            .publish_download(&grant.grant_id, 9, &sha256)
            .unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"new-agent");
        assert!(std::fs::read_dir(target_root.path())
            .unwrap()
            .all(|entry| !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".bibit-")));
    }

    #[test]
    fn detects_download_growth_and_cleans_stale_staging_on_restart() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("target.agent");
        let file_grants = service(root.path());
        let grant = file_grants
            .register_selected_path(
                owner("instance-1"),
                "store",
                "agents.download.v1",
                FileGrantDirection::Download,
                target,
            )
            .unwrap();
        let staged = file_grants
            .consume_download(
                &grant.grant_id,
                &owner("instance-1"),
                "store",
                "agents.download.v1",
            )
            .unwrap();
        std::fs::write(&staged.absolute_path, vec![0; 33]).unwrap();
        assert_eq!(
            file_grants
                .validate_download_growth(&grant.grant_id)
                .unwrap_err(),
            FileGrantError::FileSizeLimit
        );
        drop(file_grants);

        let restarted = service(root.path());
        restarted.cleanup_unowned_staging();
        assert!(!staged.absolute_path.exists());
        assert_eq!(restarted.active_grant_count(), 0);
    }

    fn memory_owner(instance: &str) -> FileGrantOwner {
        FileGrantOwner {
            feature_id: "memory".into(),
            feature_instance_id: instance.into(),
        }
    }

    fn memory_grant(
        file_grants: &FeatureFileGrantService,
        target: &std::path::Path,
    ) -> PublicFileGrant {
        file_grants
            .register_selected_path(
                memory_owner("instance-1"),
                "memory",
                "privacy.export_data",
                FileGrantDirection::Download,
                target.to_path_buf(),
            )
            .unwrap()
    }

    #[test]
    fn publishes_feature_bytes_to_the_selected_target_once() {
        let root = tempfile::tempdir().unwrap();
        let target_root = tempfile::tempdir().unwrap();
        let target = target_root.path().join("export.json");
        let file_grants = service(root.path());
        let grant = memory_grant(&file_grants, &target);
        let bytes = br#"{"memory":"ok"}"#;
        let sha256 = format!("{:x}", Sha256::digest(bytes));

        file_grants
            .publish_feature_bytes(
                &grant.grant_id,
                &memory_owner("instance-1"),
                "memory",
                "privacy.export_data",
                bytes,
                bytes.len() as u64,
                &sha256,
            )
            .unwrap();

        assert_eq!(std::fs::read(&target).unwrap(), bytes);
        assert!(std::fs::read_dir(target_root.path())
            .unwrap()
            .all(|entry| !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".bibit-")));
        assert_eq!(
            file_grants
                .publish_feature_bytes(
                    &grant.grant_id,
                    &memory_owner("instance-1"),
                    "memory",
                    "privacy.export_data",
                    bytes,
                    bytes.len() as u64,
                    &sha256,
                )
                .unwrap_err(),
            FileGrantError::AlreadyConsumed
        );
        assert_eq!(std::fs::read(&target).unwrap(), bytes);
    }

    #[test]
    fn rejects_feature_bytes_from_a_mismatched_owner() {
        let root = tempfile::tempdir().unwrap();
        let target_root = tempfile::tempdir().unwrap();
        let target = target_root.path().join("export.json");
        let file_grants = service(root.path());
        let grant = memory_grant(&file_grants, &target);
        let bytes = b"memory-export";
        let sha256 = format!("{:x}", Sha256::digest(bytes));

        for (actual_owner, actual_service, actual_operation) in [
            (memory_owner("instance-2"), "memory", "privacy.export_data"),
            (memory_owner("instance-1"), "store", "privacy.export_data"),
            (memory_owner("instance-1"), "memory", "privacy.clear_all"),
        ] {
            assert_eq!(
                file_grants
                    .publish_feature_bytes(
                        &grant.grant_id,
                        &actual_owner,
                        actual_service,
                        actual_operation,
                        bytes,
                        bytes.len() as u64,
                        &sha256,
                    )
                    .unwrap_err(),
                FileGrantError::GrantMismatch
            );
        }
        assert!(!target.exists());
        assert_eq!(
            directory_bytes(&file_grants.feature_staging_root("memory", "memory")),
            0
        );
    }

    #[test]
    fn rejects_feature_bytes_that_do_not_match_the_declared_length_or_digest() {
        let root = tempfile::tempdir().unwrap();
        let target_root = tempfile::tempdir().unwrap();
        let target = target_root.path().join("export.json");
        let file_grants = service(root.path());
        let grant = memory_grant(&file_grants, &target);
        let bytes = b"memory-export";
        let sha256 = format!("{:x}", Sha256::digest(bytes));
        let wrong_sha256 = "0".repeat(64);

        assert_eq!(
            file_grants
                .publish_feature_bytes(
                    &grant.grant_id,
                    &memory_owner("instance-1"),
                    "memory",
                    "privacy.export_data",
                    bytes,
                    bytes.len() as u64 + 1,
                    &sha256,
                )
                .unwrap_err(),
            FileGrantError::IntegrityMismatch
        );
        assert!(!target.exists());
        assert_eq!(
            directory_bytes(&file_grants.feature_staging_root("memory", "memory")),
            0
        );

        assert_eq!(
            file_grants
                .publish_feature_bytes(
                    &grant.grant_id,
                    &memory_owner("instance-1"),
                    "memory",
                    "privacy.export_data",
                    bytes,
                    bytes.len() as u64,
                    &wrong_sha256,
                )
                .unwrap_err(),
            FileGrantError::IntegrityMismatch
        );
        assert!(!target.exists());
        assert_eq!(
            directory_bytes(&file_grants.feature_staging_root("memory", "memory")),
            0
        );

        let grant = memory_grant(&file_grants, &target);
        file_grants
            .publish_feature_bytes(
                &grant.grant_id,
                &memory_owner("instance-1"),
                "memory",
                "privacy.export_data",
                bytes,
                bytes.len() as u64,
                &sha256,
            )
            .unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), bytes);
    }

    #[test]
    fn rejects_feature_bytes_beyond_the_file_size_limit_before_consuming_the_grant() {
        let root = tempfile::tempdir().unwrap();
        let target_root = tempfile::tempdir().unwrap();
        let target = target_root.path().join("export.json");
        let file_grants = service(root.path());
        let grant = memory_grant(&file_grants, &target);
        let oversized = vec![b'x'; 33];
        let oversized_sha256 = format!("{:x}", Sha256::digest(&oversized));

        assert_eq!(
            file_grants
                .publish_feature_bytes(
                    &grant.grant_id,
                    &memory_owner("instance-1"),
                    "memory",
                    "privacy.export_data",
                    &oversized,
                    oversized.len() as u64,
                    &oversized_sha256,
                )
                .unwrap_err(),
            FileGrantError::FileSizeLimit
        );
        assert!(!target.exists());

        let bytes = b"memory-export";
        let sha256 = format!("{:x}", Sha256::digest(bytes));
        file_grants
            .publish_feature_bytes(
                &grant.grant_id,
                &memory_owner("instance-1"),
                "memory",
                "privacy.export_data",
                bytes,
                bytes.len() as u64,
                &sha256,
            )
            .unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), bytes);
    }

    #[test]
    fn rejects_feature_bytes_when_the_selected_parent_is_replaced() {
        let root = tempfile::tempdir().unwrap();
        let target_root = tempfile::tempdir().unwrap();
        let parent = target_root.path().join("chosen");
        std::fs::create_dir(&parent).unwrap();
        let target = parent.join("export.json");
        let file_grants = service(root.path());
        let grant = memory_grant(&file_grants, &target);
        std::fs::remove_dir(&parent).unwrap();
        std::fs::write(&parent, b"not-a-directory").unwrap();
        let bytes = b"memory-export";
        let sha256 = format!("{:x}", Sha256::digest(bytes));

        assert!(matches!(
            file_grants
                .publish_feature_bytes(
                    &grant.grant_id,
                    &memory_owner("instance-1"),
                    "memory",
                    "privacy.export_data",
                    bytes,
                    bytes.len() as u64,
                    &sha256,
                )
                .unwrap_err(),
            FileGrantError::StorageUnavailable | FileGrantError::InvalidSelection
        ));
        assert_eq!(std::fs::read(&parent).unwrap(), b"not-a-directory");
        assert_eq!(
            directory_bytes(&file_grants.feature_staging_root("memory", "memory")),
            0
        );
    }

    #[test]
    fn accepts_only_sha256_shaped_digests() {
        assert!(is_sha256_hex(&format!("{:x}", Sha256::digest(b"memory"))));
        assert!(!is_sha256_hex(""));
        assert!(!is_sha256_hex(&"0".repeat(63)));
        assert!(!is_sha256_hex(&"0".repeat(65)));
        assert!(!is_sha256_hex(&"g".repeat(64)));
    }
}
