use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use flate2::read::GzDecoder;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
};
use tauri::{Manager, WebviewWindow};

const PLUGIN_SCHEMA_VERSION: u8 = 1;
const REGISTRY_VERSION: u8 = 2;
const MAX_ARCHIVE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_FILE_COUNT: usize = 1024;
const SYSTEM_PLUGIN_DIR: &str = "/usr/lib/bibit/plugins";

#[derive(Debug, thiserror::Error)]
pub enum TrustedPluginError {
    #[error("plugin access is restricted to the main window")]
    WrongSurface,
    #[error("plugin bundle is invalid: {0}")]
    InvalidBundle(String),
    #[error("plugin signature is not trusted: {0}")]
    Untrusted(String),
    #[error("plugin is not installed: {0}@{1}")]
    NotInstalled(String, String),
    #[error("plugin version is already installed: {0}@{1}")]
    AlreadyInstalled(String, String),
    #[error("plugin storage failed: {0}")]
    Storage(String),
    #[error("feature instance is unavailable: {0}@{1}")]
    InstanceUnavailable(String, String),
    #[error("feature instance bootstrap was already consumed: {0}@{1}")]
    InstanceAlreadyBootstrapped(String, String),
}

impl Serialize for TrustedPluginError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BundleManifest {
    plugin_schema_version: u8,
    feature_manifest: Value,
    entry: String,
    styles: Vec<String>,
    files: BTreeMap<String, String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BundleSignature {
    key_id: String,
    signature: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TrustedKey {
    key_id: String,
    public_key: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct TrustStore {
    version: u8,
    keys: Vec<TrustedKey>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CleanupLedgerEntry {
    feature_id: String,
    feature_instance_id: String,
    service_id: String,
    job_id: String,
    #[serde(default)]
    staging_path: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PluginRegistry {
    version: u8,
    #[serde(default)]
    active: BTreeMap<String, String>,
    #[serde(default)]
    desired: BTreeMap<String, String>,
    #[serde(default)]
    current: BTreeMap<String, String>,
    #[serde(default)]
    previous: BTreeMap<String, String>,
    #[serde(default)]
    disabled: BTreeSet<String>,
}

impl PluginRegistry {
    fn empty() -> Self {
        Self {
            version: REGISTRY_VERSION,
            active: BTreeMap::new(),
            desired: BTreeMap::new(),
            current: BTreeMap::new(),
            previous: BTreeMap::new(),
            disabled: BTreeSet::new(),
        }
    }

    fn normalize_legacy(&mut self) -> Result<(), TrustedPluginError> {
        if self.version != 1 && self.version != REGISTRY_VERSION {
            return Err(TrustedPluginError::Storage(
                "unsupported plugin registry version".into(),
            ));
        }
        if self.current.is_empty() {
            self.current = self.active.clone();
        }
        if self.active.is_empty() {
            self.active = self.current.clone();
        }
        if self.desired.is_empty() && self.disabled.is_empty() {
            self.desired = self.current.clone();
        }
        self.version = REGISTRY_VERSION;
        Ok(())
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveTrustedPlugin {
    pub id: String,
    pub version: String,
    pub feature_manifest: Value,
    pub entry_source: String,
    pub styles: Vec<String>,
}

/// 启动路径只需要「有哪些插件、各自的 manifest」；源码和样式要等前端真正
/// `load()` 某个插件模块时才用得上。1.6MB(4 个系统插件)的源码如果跟着启动 IPC
/// 一起过去，序列化+传输+JSON.parse 全压在首屏上(实测这一段约 380ms)，所以在
/// 这里先只给元数据，源码由 `trusted_plugin_list_active` 按需取。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveTrustedPluginMetadata {
    pub id: String,
    pub version: String,
    pub feature_manifest: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveTrustedPluginMetadataList {
    pub plugins: Vec<ActiveTrustedPluginMetadata>,
    pub rejected: Vec<RejectedTrustedPlugin>,
    pub lifecycle: Vec<TrustedPluginLifecycle>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum FeatureInstanceSource {
    Builtin,
    TrustedPlugin,
}

#[derive(Clone)]
struct FeatureInstanceBinding {
    version: String,
    token: String,
    capabilities: BTreeSet<String>,
    source: FeatureInstanceSource,
    bootstrap_delivered: bool,
}

struct StaticFeatureManifest {
    id: &'static str,
    version: &'static str,
    capabilities: &'static [&'static str],
}

// ponytail: keep the allowlist manual while the production Registry is empty.
const STATIC_FEATURE_MANIFESTS: &[StaticFeatureManifest] = &[];

static FEATURE_INSTANCES: OnceLock<Mutex<BTreeMap<String, FeatureInstanceBinding>>> =
    OnceLock::new();
static REGISTRY_WRITE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn registry_write_lock() -> &'static Mutex<()> {
    REGISTRY_WRITE_LOCK.get_or_init(|| Mutex::new(()))
}

fn feature_instances() -> &'static Mutex<BTreeMap<String, FeatureInstanceBinding>> {
    FEATURE_INSTANCES.get_or_init(|| Mutex::new(BTreeMap::new()))
}

fn feature_instance_binding(feature_id: &str) -> Option<FeatureInstanceBinding> {
    feature_instances()
        .lock()
        .ok()
        .and_then(|instances| instances.get(feature_id).cloned())
}

fn register_feature_instance(
    feature_id: &str,
    version: &str,
    capabilities: BTreeSet<String>,
    source: FeatureInstanceSource,
    force_rotate: bool,
) -> Result<Option<String>, TrustedPluginError> {
    let mut instances = feature_instances()
        .lock()
        .map_err(|_| TrustedPluginError::Storage("feature instance registry unavailable".into()))?;
    let previous = instances.get(feature_id).cloned();
    if !force_rotate
        && previous
            .as_ref()
            .is_some_and(|binding| binding.version == version && binding.source == source)
    {
        return Ok(None);
    }
    if previous
        .as_ref()
        .is_some_and(|binding| binding.source != source)
    {
        return Err(TrustedPluginError::InstanceUnavailable(
            feature_id.into(),
            version.into(),
        ));
    }
    let binding = FeatureInstanceBinding {
        version: version.into(),
        token: uuid::Uuid::new_v4().to_string(),
        capabilities,
        source,
        bootstrap_delivered: false,
    };
    instances.insert(feature_id.into(), binding);
    Ok(previous.map(|binding| binding.token))
}

fn attach_feature_instance(
    plugin: &ActiveTrustedPlugin,
    force_rotate: bool,
) -> Result<Option<String>, TrustedPluginError> {
    register_feature_instance(
        &plugin.id,
        &plugin.version,
        plugin
            .feature_manifest
            .get("requiredHostCapabilities")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect(),
        FeatureInstanceSource::TrustedPlugin,
        force_rotate,
    )
}

fn attach_static_feature_instance_from(
    manifests: &[StaticFeatureManifest],
    feature_id: &str,
    version: &str,
) -> Result<Option<String>, TrustedPluginError> {
    let manifest = manifests
        .iter()
        .find(|manifest| manifest.id == feature_id && manifest.version == version)
        .ok_or_else(|| {
            TrustedPluginError::InstanceUnavailable(feature_id.into(), version.into())
        })?;
    register_feature_instance(
        feature_id,
        version,
        manifest
            .capabilities
            .iter()
            .map(|capability| (*capability).to_owned())
            .collect(),
        FeatureInstanceSource::Builtin,
        false,
    )
}

fn take_feature_instance_token(
    feature_id: &str,
    version: &str,
    source: FeatureInstanceSource,
) -> Result<String, TrustedPluginError> {
    let mut instances = feature_instances()
        .lock()
        .map_err(|_| TrustedPluginError::Storage("feature instance registry unavailable".into()))?;
    let binding = instances.get_mut(feature_id).ok_or_else(|| {
        TrustedPluginError::InstanceUnavailable(feature_id.into(), version.into())
    })?;
    if binding.version != version || binding.source != source {
        return Err(TrustedPluginError::InstanceUnavailable(
            feature_id.into(),
            version.into(),
        ));
    }
    if binding.bootstrap_delivered {
        return Err(TrustedPluginError::InstanceAlreadyBootstrapped(
            feature_id.into(),
            version.into(),
        ));
    }
    binding.bootstrap_delivered = true;
    Ok(binding.token.clone())
}

pub(crate) fn validate_feature_instance(feature_id: &str, token: &str) -> bool {
    feature_instances()
        .lock()
        .ok()
        .and_then(|instances| instances.get(feature_id).cloned())
        .is_some_and(|binding| binding.token == token)
}

pub(crate) fn validate_feature_instance_capability(
    feature_id: &str,
    token: &str,
    capability: &str,
) -> bool {
    feature_instances()
        .lock()
        .ok()
        .and_then(|instances| instances.get(feature_id).cloned())
        .is_some_and(|binding| binding.token == token && binding.capabilities.contains(capability))
}

pub(crate) fn validate_feature_instance_version_capability(
    feature_id: &str,
    version: &str,
    token: &str,
    capability: &str,
) -> bool {
    feature_instances()
        .lock()
        .ok()
        .and_then(|instances| instances.get(feature_id).cloned())
        .is_some_and(|binding| {
            binding.version == version
                && binding.token == token
                && binding.capabilities.contains(capability)
        })
}

fn invalidate_feature_instance(feature_id: &str) -> Option<String> {
    feature_instances()
        .lock()
        .ok()
        .and_then(|mut instances| instances.remove(feature_id))
        .map(|binding| binding.token)
}

#[cfg(test)]
pub(crate) fn register_test_feature_instance(
    feature_id: &str,
    version: &str,
    capabilities: &[&str],
) -> String {
    register_feature_instance(
        feature_id,
        version,
        capabilities
            .iter()
            .map(|capability| (*capability).to_owned())
            .collect(),
        FeatureInstanceSource::TrustedPlugin,
        true,
    )
    .unwrap();
    feature_instance_binding(feature_id).unwrap().token
}

#[cfg(test)]
pub(crate) fn unregister_test_feature_instance(feature_id: &str) {
    invalidate_feature_instance(feature_id);
}

async fn stop_feature_instance_jobs(
    data_root: &Path,
    jobs: &Arc<crate::feature_service_jobs::FeatureServiceJobRegistry>,
    owner: &crate::feature_file_grants::FileGrantOwner,
) {
    crate::external_services::cancel_feature_requests(owner).await;
    let mut cancelled = Vec::new();
    for (service_id, job_id, staging_path) in jobs.active_jobs_with_staging(owner) {
        if record_cleanup_ledger_entry(
            data_root,
            &owner.feature_id,
            &owner.feature_instance_id,
            &service_id,
            &job_id,
            &staging_path,
        )
        .is_err()
        {
            log::error!("feature cleanup ledger write failed; retaining job={job_id}");
            continue;
        }
        let decision = jobs.cancel(owner, &job_id);
        let provider_cancelled = match decision {
            Ok(decision) if decision.provider_cancel_required => {
                crate::external_services::cancel_service_job_with_reconnect(
                    data_root,
                    Arc::clone(jobs),
                    &service_id,
                    &job_id,
                )
                .await
                .is_ok()
            }
            Ok(_) => true,
            Err(_) => false,
        };
        if provider_cancelled {
            let _ = jobs.provider_cancelled(&job_id);
            cancelled.push((job_id, service_id, staging_path));
        }
    }
    // Keep unresolved jobs and grants until the Provider confirms cancellation.
    for (job_id, service_id, staging_path) in cancelled {
        let entry = CleanupLedgerEntry {
            feature_id: owner.feature_id.clone(),
            feature_instance_id: owner.feature_instance_id.clone(),
            service_id,
            job_id: job_id.clone(),
            staging_path: Some(staging_path),
        };
        if cleanup_ledger_staging_path(data_root, &entry).is_ok() {
            let _ = remove_cleanup_ledger_entry(data_root, &owner.feature_id, &job_id);
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RejectedTrustedPlugin {
    pub id: String,
    pub version: String,
    pub code: String,
    pub reason: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustedPluginLifecycle {
    pub id: String,
    pub version: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

fn plugin_error_diagnostic(error: &TrustedPluginError) -> (String, String) {
    match error {
        TrustedPluginError::WrongSurface => {
            ("wrong_surface".into(), "此操作只能从主窗口执行".into())
        }
        TrustedPluginError::InvalidBundle(_) => {
            ("invalid_bundle".into(), "插件包格式或内容无效".into())
        }
        TrustedPluginError::Untrusted(_) => {
            ("untrusted_bundle".into(), "插件签名或信任状态无效".into())
        }
        TrustedPluginError::NotInstalled(_, _) => ("not_installed".into(), "插件版本未安装".into()),
        TrustedPluginError::AlreadyInstalled(_, _) => {
            ("already_installed".into(), "插件版本已经安装".into())
        }
        TrustedPluginError::Storage(_) => (
            "storage_error".into(),
            "插件状态暂时不可用，请稍后重试".into(),
        ),
        TrustedPluginError::InstanceUnavailable(_, _) => {
            ("instance_unavailable".into(), "插件实例不可用".into())
        }
        TrustedPluginError::InstanceAlreadyBootstrapped(_, _) => (
            "instance_bootstrapped".into(),
            "插件实例已经完成初始化".into(),
        ),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveTrustedPluginList {
    pub plugins: Vec<ActiveTrustedPlugin>,
    pub rejected: Vec<RejectedTrustedPlugin>,
    pub lifecycle: Vec<TrustedPluginLifecycle>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FeatureInstanceBootstrapRequest {
    feature_id: String,
    plugin_version: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeatureInstanceBootstrap {
    feature_id: String,
    plugin_version: String,
    feature_instance_token: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FeatureManifest {
    manifest_schema_version: u8,
    sdk_api_version: u8,
    id: String,
    version: String,
    owner: String,
    display: FeatureDisplay,
    targets: Vec<String>,
    required_host_capabilities: Vec<String>,
    contributions: FeatureContributions,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FeatureDisplay {
    title_key: String,
    fallback_title: String,
    icon_key: String,
    description_key: Option<String>,
    fallback_description: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct FeatureContributions {
    pages: Vec<RoutedContribution>,
    settings: Vec<RoutedContribution>,
    conversation: Vec<ConversationContribution>,
    locales: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RoutedContribution {
    id: String,
    path: String,
    surfaces: Vec<String>,
    navigation: Option<Navigation>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ConversationContribution {
    id: String,
    kind: String,
    surfaces: Vec<String>,
    order: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Navigation {
    group: String,
    order: Option<i64>,
    title_key: Option<String>,
    fallback_title: Option<String>,
    icon_key: Option<String>,
    section: Option<SettingsNavigationSection>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SettingsNavigationSection {
    id: String,
    title_key: Option<String>,
    fallback_title: String,
}

fn safe_relative_path(value: &str) -> Result<PathBuf, TrustedPluginError> {
    let path = Path::new(value);
    if value.is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(TrustedPluginError::InvalidBundle(format!(
            "unsafe path: {value}"
        )));
    }
    Ok(path.to_path_buf())
}

fn safe_identifier(value: &str, label: &str) -> Result<(), TrustedPluginError> {
    if !(2..=64).contains(&value.len())
        || !value.starts_with(|character: char| character.is_ascii_lowercase())
        || value.split('-').any(|segment| {
            segment.is_empty()
                || !segment
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        })
    {
        return Err(TrustedPluginError::InvalidBundle(format!(
            "invalid {label}: {value}"
        )));
    }
    Ok(())
}

fn safe_version(value: &str) -> Result<(), TrustedPluginError> {
    if value.len() > 128 || semver::Version::parse(value).is_err() {
        return Err(TrustedPluginError::InvalidBundle(format!(
            "invalid version: {value}"
        )));
    }
    Ok(())
}

fn invalid_manifest(message: impl Into<String>) -> TrustedPluginError {
    TrustedPluginError::InvalidBundle(format!("invalid Feature Manifest: {}", message.into()))
}

fn valid_slug(value: &str) -> bool {
    !value.is_empty()
        && value.starts_with(|character: char| character.is_ascii_lowercase())
        && value.split('-').all(|segment| {
            !segment.is_empty()
                && segment
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        })
}

fn valid_route_path(value: &str) -> bool {
    value.is_empty() || value.split('/').all(valid_slug)
}

fn valid_locale(value: &str) -> bool {
    let bytes = value.as_bytes();
    (bytes.len() == 2 && bytes.iter().all(u8::is_ascii_lowercase))
        || (bytes.len() == 5
            && bytes[0..2].iter().all(u8::is_ascii_lowercase)
            && bytes[2] == b'-'
            && bytes[3..5].iter().all(u8::is_ascii_uppercase))
}

fn unique_allowed(values: &[String], allowed: &[&str], nonempty: bool) -> bool {
    (!nonempty || !values.is_empty())
        && values.iter().all(|value| allowed.contains(&value.as_str()))
        && values.iter().collect::<BTreeSet<_>>().len() == values.len()
}

fn validate_surface(values: &[String]) -> bool {
    unique_allowed(values, &["main"], true)
}

fn validate_order(order: Option<i64>) -> bool {
    order.is_none_or(|value| (-10_000..=10_000).contains(&value))
}

/// Declared icon and navigation-group values are tokens this host may not know
/// yet. They stay bounded and slug-shaped, but are deliberately not closed enums:
/// an unknown value must degrade in the UI instead of rejecting a signed plugin.
/// Keep this in step with `#/$defs/declaredToken` in the Manifest schema.
fn valid_declared_token(value: &str) -> bool {
    value.len() <= 64 && valid_slug(value)
}

fn validate_feature_manifest(value: &Value) -> Result<(String, String), TrustedPluginError> {
    let manifest: FeatureManifest = serde_json::from_value(value.clone())
        .map_err(|error| invalid_manifest(error.to_string()))?;
    if manifest.manifest_schema_version != 1 || manifest.sdk_api_version != 1 {
        return Err(invalid_manifest("unsupported contract version"));
    }
    safe_identifier(&manifest.id, "Feature id")?;
    safe_version(&manifest.version)?;
    if !(2..=128).contains(&manifest.owner.chars().count())
        || manifest.display.title_key.is_empty()
        || manifest.display.fallback_title.is_empty()
        || !valid_declared_token(&manifest.display.icon_key)
        || manifest.display.description_key.is_some()
            != manifest.display.fallback_description.is_some()
        || manifest
            .display
            .description_key
            .as_ref()
            .is_some_and(String::is_empty)
        || manifest
            .display
            .fallback_description
            .as_ref()
            .is_some_and(String::is_empty)
    {
        return Err(invalid_manifest("invalid owner or display metadata"));
    }
    if !unique_allowed(&manifest.targets, &["desktop"], true)
        || manifest
            .required_host_capabilities
            .iter()
            .any(|value| !crate::feature_capabilities::valid_capability(value))
        || manifest
            .required_host_capabilities
            .iter()
            .collect::<BTreeSet<_>>()
            .len()
            != manifest.required_host_capabilities.len()
    {
        return Err(invalid_manifest("invalid targets or Host capabilities"));
    }

    let mut contribution_ids = BTreeSet::new();
    for (kind, contributions) in [
        ("page", manifest.contributions.pages.as_slice()),
        ("settings", manifest.contributions.settings.as_slice()),
    ] {
        for contribution in contributions {
            safe_identifier(&contribution.id, "contribution id")?;
            if !contribution_ids.insert(&contribution.id)
                || !valid_route_path(&contribution.path)
                || !validate_surface(&contribution.surfaces)
                || !validate_order(contribution.navigation.as_ref().and_then(|item| item.order))
            {
                return Err(invalid_manifest(format!("invalid {kind} contribution")));
            }
            if let Some(navigation) = &contribution.navigation {
                let settings_metadata_valid = kind == "settings"
                    || (navigation.title_key.is_none()
                        && navigation.fallback_title.is_none()
                        && navigation.icon_key.is_none()
                        && navigation.section.is_none());
                let text_valid = navigation
                    .title_key
                    .as_ref()
                    .map_or(true, |value| !value.is_empty())
                    && navigation
                        .fallback_title
                        .as_ref()
                        .map_or(true, |value| !value.is_empty());
                let icon_valid = navigation
                    .icon_key
                    .as_ref()
                    .map_or(true, |value| valid_declared_token(value));
                let section_valid = navigation.section.as_ref().map_or(true, |section| {
                    kind == "settings"
                        && safe_identifier(&section.id, "settings navigation section id").is_ok()
                        && !section.fallback_title.is_empty()
                        && section
                            .title_key
                            .as_ref()
                            .map_or(true, |value| !value.is_empty())
                });
                if !valid_declared_token(&navigation.group)
                    || !settings_metadata_valid
                    || !text_valid
                    || !icon_valid
                    || !section_valid
                {
                    return Err(invalid_manifest(format!("invalid {kind} navigation")));
                }
            }
        }
        for (index, left) in contributions.iter().enumerate() {
            for right in contributions.iter().skip(index + 1) {
                let overlap = left.path == right.path
                    || left.path.is_empty()
                    || right.path.is_empty()
                    || left.path.starts_with(&format!("{}/", right.path))
                    || right.path.starts_with(&format!("{}/", left.path));
                if overlap {
                    return Err(invalid_manifest(format!(
                        "overlapping {kind} contribution paths"
                    )));
                }
            }
        }
    }
    for contribution in &manifest.contributions.conversation {
        safe_identifier(&contribution.id, "contribution id")?;
        if !contribution_ids.insert(&contribution.id)
            || contribution.kind != "permission-presenter"
            || !validate_surface(&contribution.surfaces)
            || !validate_order(contribution.order)
        {
            return Err(invalid_manifest("invalid conversation contribution"));
        }
    }
    if manifest.contributions.locales.is_empty()
        || !manifest
            .contributions
            .locales
            .iter()
            .any(|locale| locale == "en")
        || !manifest
            .contributions
            .locales
            .iter()
            .all(|locale| valid_locale(locale))
        || manifest
            .contributions
            .locales
            .iter()
            .collect::<BTreeSet<_>>()
            .len()
            != manifest.contributions.locales.len()
    {
        return Err(invalid_manifest("invalid locales"));
    }
    Ok((manifest.id, manifest.version))
}

fn feature_identity(manifest: &BundleManifest) -> Result<(String, String), TrustedPluginError> {
    if manifest.plugin_schema_version != PLUGIN_SCHEMA_VERSION {
        return Err(TrustedPluginError::InvalidBundle(
            "unsupported pluginSchemaVersion".into(),
        ));
    }
    let (id, version) = validate_feature_manifest(&manifest.feature_manifest)?;
    safe_relative_path(&manifest.entry)?;
    if !manifest.files.contains_key(&manifest.entry) {
        return Err(TrustedPluginError::InvalidBundle(
            "entry is not covered by files".into(),
        ));
    }
    for style in &manifest.styles {
        safe_relative_path(style)?;
        if !manifest.files.contains_key(style) {
            return Err(TrustedPluginError::InvalidBundle(format!(
                "style is not covered by files: {style}"
            )));
        }
    }
    Ok((id, version))
}

fn read_archive(path: &Path) -> Result<BTreeMap<String, Vec<u8>>, TrustedPluginError> {
    read_archive_with_limits(path, MAX_ARCHIVE_BYTES, MAX_FILE_COUNT)
}

fn read_archive_with_limits(
    path: &Path,
    max_bytes: u64,
    max_entries: usize,
) -> Result<BTreeMap<String, Vec<u8>>, TrustedPluginError> {
    let archive_size = fs::metadata(path)
        .map_err(|error| TrustedPluginError::Storage(error.to_string()))?
        .len();
    if archive_size > max_bytes {
        return Err(TrustedPluginError::InvalidBundle(
            "archive is too large".into(),
        ));
    }
    let file =
        fs::File::open(path).map_err(|error| TrustedPluginError::Storage(error.to_string()))?;
    let mut archive = tar::Archive::new(GzDecoder::new(file));
    let mut files = BTreeMap::new();
    let mut total = 0_u64;
    let mut entry_count = 0_usize;
    let entries = archive
        .entries()
        .map_err(|error| TrustedPluginError::InvalidBundle(error.to_string()))?;
    for entry in entries {
        let entry = entry.map_err(|error| TrustedPluginError::InvalidBundle(error.to_string()))?;
        entry_count += 1;
        if entry_count > max_entries {
            return Err(TrustedPluginError::InvalidBundle(
                "expanded archive exceeds limits".into(),
            ));
        }
        if entry.header().entry_type().is_dir() {
            continue;
        }
        if !entry.header().entry_type().is_file() {
            return Err(TrustedPluginError::InvalidBundle(
                "only regular files are allowed".into(),
            ));
        }
        let path = entry
            .path()
            .map_err(|error| TrustedPluginError::InvalidBundle(error.to_string()))?;
        let name = path
            .to_str()
            .ok_or_else(|| TrustedPluginError::InvalidBundle("non-UTF-8 path".into()))?
            .replace('\\', "/");
        safe_relative_path(&name)?;
        let remaining = max_bytes.saturating_sub(total);
        if entry.size() > remaining {
            return Err(TrustedPluginError::InvalidBundle(
                "expanded archive exceeds limits".into(),
            ));
        }
        let mut bytes = Vec::new();
        entry
            .take(remaining.saturating_add(1))
            .read_to_end(&mut bytes)
            .map_err(|error| TrustedPluginError::InvalidBundle(error.to_string()))?;
        if bytes.len() as u64 > remaining {
            return Err(TrustedPluginError::InvalidBundle(
                "expanded archive exceeds limits".into(),
            ));
        }
        total = total.saturating_add(bytes.len() as u64);
        if files.insert(name.clone(), bytes).is_some() {
            return Err(TrustedPluginError::InvalidBundle(format!(
                "duplicate archive path: {name}"
            )));
        }
    }
    Ok(files)
}

fn verify_disabled() -> bool {
    #[cfg(feature = "allow-unsigned-plugins")]
    {
        true
    }
    #[cfg(all(not(feature = "allow-unsigned-plugins"), debug_assertions))]
    {
        matches!(
            std::env::var_os("BIBIT_PLUGIN_SKIP_VERIFY"),
            Some(value) if value == "1"
        )
    }
    #[cfg(all(not(feature = "allow-unsigned-plugins"), not(debug_assertions)))]
    {
        false
    }
}

fn parse_trust_store(path: &Path) -> Result<BTreeMap<String, VerifyingKey>, TrustedPluginError> {
    if verify_disabled() {
        return Ok(BTreeMap::new());
    }
    let source = fs::read(path).map_err(|error| TrustedPluginError::Storage(error.to_string()))?;
    let store: TrustStore = serde_json::from_slice(&source)
        .map_err(|error| TrustedPluginError::Storage(error.to_string()))?;
    if store.version != 1 {
        return Err(TrustedPluginError::Storage(
            "unsupported trust store version".into(),
        ));
    }
    store
        .keys
        .into_iter()
        .map(|key| {
            let bytes = BASE64
                .decode(&key.public_key)
                .map_err(|_| TrustedPluginError::Storage("invalid trusted public key".into()))?;
            let bytes: [u8; 32] = bytes.try_into().map_err(|_| {
                TrustedPluginError::Storage("invalid trusted public key length".into())
            })?;
            let verifying_key = VerifyingKey::from_bytes(&bytes)
                .map_err(|_| TrustedPluginError::Storage("invalid trusted public key".into()))?;
            Ok((key.key_id, verifying_key))
        })
        .collect()
}

fn verify_bundle(
    files: &BTreeMap<String, Vec<u8>>,
    trusted_keys: &BTreeMap<String, VerifyingKey>,
) -> Result<(BundleManifest, String, String), TrustedPluginError> {
    let manifest_bytes = files
        .get("plugin.json")
        .ok_or_else(|| TrustedPluginError::InvalidBundle("missing plugin.json".into()))?;
    if !verify_disabled() {
        let signature: BundleSignature = serde_json::from_slice(
            files
                .get("plugin.sig")
                .ok_or_else(|| TrustedPluginError::InvalidBundle("missing plugin.sig".into()))?,
        )
        .map_err(|error| TrustedPluginError::InvalidBundle(error.to_string()))?;
        let verifying_key = trusted_keys
            .get(&signature.key_id)
            .ok_or_else(|| TrustedPluginError::Untrusted(signature.key_id.clone()))?;
        let signature_bytes = BASE64
            .decode(&signature.signature)
            .map_err(|_| TrustedPluginError::Untrusted("invalid signature encoding".into()))?;
        let signature = Signature::from_slice(&signature_bytes)
            .map_err(|_| TrustedPluginError::Untrusted("invalid signature length".into()))?;
        verifying_key
            .verify(manifest_bytes, &signature)
            .map_err(|_| TrustedPluginError::Untrusted("signature verification failed".into()))?;
    }
    let manifest: BundleManifest = serde_json::from_slice(manifest_bytes)
        .map_err(|error| TrustedPluginError::InvalidBundle(error.to_string()))?;
    let (id, version) = feature_identity(&manifest)?;
    if !verify_disabled() {
        let expected: BTreeSet<_> = manifest
            .files
            .keys()
            .cloned()
            .chain(["plugin.json".into(), "plugin.sig".into()])
            .collect();
        let actual: BTreeSet<_> = files.keys().cloned().collect();
        if actual != expected {
            return Err(TrustedPluginError::InvalidBundle(
                "archive files do not match the signed manifest".into(),
            ));
        }
        for (name, expected_hash) in &manifest.files {
            if expected_hash.len() != 64
                || !expected_hash.bytes().all(|byte| byte.is_ascii_hexdigit())
            {
                return Err(TrustedPluginError::InvalidBundle(format!(
                    "invalid SHA-256 for {name}"
                )));
            }
            let actual_hash = hex::encode(Sha256::digest(&files[name]));
            if !actual_hash.eq_ignore_ascii_case(expected_hash) {
                return Err(TrustedPluginError::InvalidBundle(format!(
                    "SHA-256 mismatch for {name}"
                )));
            }
        }
    }
    if verify_disabled() {
        for name in std::iter::once(&manifest.entry).chain(manifest.styles.iter()) {
            if !files.contains_key(name) {
                return Err(TrustedPluginError::InvalidBundle(format!(
                    "missing file: {name}"
                )));
            }
        }
    }
    Ok((manifest, id, version))
}

fn plugins_root(data_root: &Path) -> PathBuf {
    data_root.join("plugins")
}

fn registry_path(data_root: &Path) -> PathBuf {
    plugins_root(data_root).join("registry.json")
}

fn installed_root(data_root: &Path, id: &str, version: &str) -> PathBuf {
    plugins_root(data_root)
        .join("installed")
        .join(id)
        .join(version)
}

fn read_registry(data_root: &Path) -> Result<PluginRegistry, TrustedPluginError> {
    let path = registry_path(data_root);
    let source = match fs::read(path) {
        Ok(source) => source,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(PluginRegistry::empty());
        }
        Err(error) => return Err(TrustedPluginError::Storage(error.to_string())),
    };
    let mut registry: PluginRegistry = serde_json::from_slice(&source)
        .map_err(|error| TrustedPluginError::Storage(error.to_string()))?;
    registry.normalize_legacy()?;
    Ok(registry)
}

fn write_registry(data_root: &Path, registry: &PluginRegistry) -> Result<(), TrustedPluginError> {
    let path = registry_path(data_root);
    fs::create_dir_all(path.parent().expect("registry has parent"))
        .map_err(|error| TrustedPluginError::Storage(error.to_string()))?;
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    fs::write(
        &temporary,
        serde_json::to_vec_pretty(registry)
            .map_err(|error| TrustedPluginError::Storage(error.to_string()))?,
    )
    .map_err(|error| TrustedPluginError::Storage(error.to_string()))?;
    fs::rename(&temporary, &path).map_err(|error| TrustedPluginError::Storage(error.to_string()))
}

fn cleanup_ledger_path(data_root: &Path) -> PathBuf {
    plugins_root(data_root).join("cleanup-ledger.json")
}

fn write_cleanup_ledger(
    data_root: &Path,
    entries: &[CleanupLedgerEntry],
) -> Result<(), TrustedPluginError> {
    let path = cleanup_ledger_path(data_root);
    fs::create_dir_all(path.parent().expect("cleanup ledger has parent"))
        .map_err(|error| TrustedPluginError::Storage(error.to_string()))?;
    if entries.is_empty() {
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(TrustedPluginError::Storage(error.to_string())),
        }
        return Ok(());
    }
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    fs::write(
        &temporary,
        serde_json::to_vec_pretty(entries)
            .map_err(|error| TrustedPluginError::Storage(error.to_string()))?,
    )
    .map_err(|error| TrustedPluginError::Storage(error.to_string()))?;
    fs::rename(&temporary, &path).map_err(|error| TrustedPluginError::Storage(error.to_string()))
}

fn read_cleanup_ledger(data_root: &Path) -> Result<Vec<CleanupLedgerEntry>, TrustedPluginError> {
    let path = cleanup_ledger_path(data_root);
    let source = match fs::read(path) {
        Ok(source) => source,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(TrustedPluginError::Storage(error.to_string())),
    };
    match serde_json::from_slice::<Vec<CleanupLedgerEntry>>(&source) {
        Ok(entries) => Ok(entries),
        Err(_) => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct VersionedLedger {
                #[serde(default)]
                version: u8,
                entries: Vec<CleanupLedgerEntry>,
            }
            let legacy: VersionedLedger = serde_json::from_slice(&source)
                .map_err(|error| TrustedPluginError::Storage(error.to_string()))?;
            if legacy.version == 0 || legacy.version == 1 {
                Ok(legacy.entries)
            } else {
                Err(TrustedPluginError::Storage(
                    "unsupported cleanup ledger version".into(),
                ))
            }
        }
    }
}

fn cleanup_ledger_key_matches(entry: &CleanupLedgerEntry, feature_id: &str, job_id: &str) -> bool {
    entry.feature_id == feature_id && entry.job_id == job_id
}

pub(crate) fn record_cleanup_ledger_entry(
    data_root: &Path,
    feature_id: &str,
    feature_instance_id: &str,
    service_id: &str,
    job_id: &str,
    staging_path: &str,
) -> Result<(), TrustedPluginError> {
    crate::feature_capabilities::valid_id(feature_id)
        .then_some(())
        .ok_or_else(|| TrustedPluginError::Storage("invalid cleanup ledger Feature id".into()))?;
    crate::feature_capabilities::valid_id(service_id)
        .then_some(())
        .ok_or_else(|| TrustedPluginError::Storage("invalid cleanup ledger service id".into()))?;
    if feature_instance_id.is_empty() || job_id.is_empty() {
        return Err(TrustedPluginError::Storage(
            "invalid cleanup ledger owner".into(),
        ));
    }
    let staging = safe_relative_path(staging_path)?;
    if staging.components().count() < 2 {
        return Err(TrustedPluginError::Storage(
            "invalid cleanup ledger staging path".into(),
        ));
    }
    if staging
        .components()
        .next()
        .and_then(|component| component.as_os_str().to_str())
        != Some(feature_id)
    {
        return Err(TrustedPluginError::Storage(
            "cleanup ledger staging path does not match Feature owner".into(),
        ));
    }
    let mut entries = read_cleanup_ledger(data_root)?;
    if !entries.iter().any(|entry| {
        cleanup_ledger_key_matches(entry, feature_id, job_id)
            && entry.feature_instance_id == feature_instance_id
            && entry.service_id == service_id
    }) {
        entries.push(CleanupLedgerEntry {
            feature_id: feature_id.into(),
            feature_instance_id: feature_instance_id.into(),
            service_id: service_id.into(),
            job_id: job_id.into(),
            staging_path: Some(staging.to_string_lossy().replace('\\', "/")),
        });
        write_cleanup_ledger(data_root, &entries)?;
    }
    Ok(())
}

pub(crate) fn remove_cleanup_ledger_entry(
    data_root: &Path,
    feature_id: &str,
    job_id: &str,
) -> Result<(), TrustedPluginError> {
    let mut entries = read_cleanup_ledger(data_root)?;
    let before = entries.len();
    entries.retain(|entry| !cleanup_ledger_key_matches(entry, feature_id, job_id));
    if entries.len() != before {
        write_cleanup_ledger(data_root, &entries)?;
    }
    Ok(())
}

fn cleanup_ledger_staging_path(
    data_root: &Path,
    entry: &CleanupLedgerEntry,
) -> Result<(), TrustedPluginError> {
    let Some(staging_path) = &entry.staging_path else {
        return Err(TrustedPluginError::Storage(
            "cleanup ledger entry has no staging handle".into(),
        ));
    };
    let relative = safe_relative_path(staging_path)?;
    if relative
        .components()
        .next()
        .and_then(|component| component.as_os_str().to_str())
        != Some(entry.feature_id.as_str())
    {
        return Err(TrustedPluginError::Storage(
            "cleanup ledger staging path does not match Feature owner".into(),
        ));
    }
    let path = data_root
        .join("providers")
        .join(&entry.service_id)
        .join("transfers")
        .join(relative);
    let transfers_root = data_root
        .join("providers")
        .join(&entry.service_id)
        .join("transfers");
    if !path.starts_with(&transfers_root) {
        return Err(TrustedPluginError::Storage(
            "cleanup ledger staging path escapes provider transfers".into(),
        ));
    }
    if let Ok(metadata) = fs::symlink_metadata(&path) {
        if metadata.file_type().is_symlink() {
            return Err(TrustedPluginError::Storage(
                "cleanup ledger staging path is a symlink".into(),
            ));
        }
        if metadata.file_type().is_dir() {
            fs::remove_dir_all(path)
                .map_err(|error| TrustedPluginError::Storage(error.to_string()))?;
        } else {
            fs::remove_file(path)
                .map_err(|error| TrustedPluginError::Storage(error.to_string()))?;
        }
    }
    Ok(())
}

#[derive(Default)]
struct CleanupRecoveryReport {
    recovered: Vec<CleanupLedgerEntry>,
    pending: Vec<CleanupLedgerEntry>,
}

/// Lifecycle rows for one cleanup pass. Entries the pass could not finish are
/// reported as `pending-cleanup` so the extension list shows an operator
/// visible state instead of counting them as rejections.
fn cleanup_lifecycle_entries(report: &CleanupRecoveryReport) -> Vec<TrustedPluginLifecycle> {
    report
        .recovered
        .iter()
        .map(|entry| TrustedPluginLifecycle {
            id: entry.feature_id.clone(),
            version: "unknown".into(),
            status: "recovered".into(),
            code: Some("cleanup_recovered".into()),
            previous_version: None,
            reason: Some(format!("cleaned Provider job {} and staging", entry.job_id)),
        })
        .chain(report.pending.iter().map(|entry| TrustedPluginLifecycle {
            id: entry.feature_id.clone(),
            version: "unknown".into(),
            status: "pending-cleanup".into(),
            code: Some("cleanup_pending".into()),
            previous_version: None,
            reason: Some(format!("cleanup pending for Provider job {}", entry.job_id)),
        }))
        .collect()
}

async fn recover_cleanup_ledger(
    data_root: &Path,
    jobs: Arc<crate::feature_service_jobs::FeatureServiceJobRegistry>,
) -> Result<CleanupRecoveryReport, TrustedPluginError> {
    let entries = read_cleanup_ledger(data_root)?;
    cleanup_unowned_staging(data_root, &entries)?;
    if entries.is_empty() {
        return Ok(CleanupRecoveryReport::default());
    }
    let mut remaining = Vec::new();
    let mut recovered = Vec::new();
    for entry in &entries {
        let provider_cancelled = crate::external_services::cancel_service_job_with_reconnect(
            data_root,
            Arc::clone(&jobs),
            &entry.service_id,
            &entry.job_id,
        )
        .await
        .is_ok();
        let staging_cleaned = cleanup_ledger_staging_path(data_root, entry).is_ok();
        if provider_cancelled && staging_cleaned {
            recovered.push(entry.clone());
        } else {
            remaining.push(entry.clone());
        }
    }
    write_cleanup_ledger(data_root, &remaining)?;
    Ok(CleanupRecoveryReport {
        recovered,
        pending: remaining,
    })
}

fn cleanup_unowned_staging(
    data_root: &Path,
    ledger: &[CleanupLedgerEntry],
) -> Result<(), TrustedPluginError> {
    let mut owned_paths_by_service: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for item in ledger {
        let owned_path = match item.staging_path.as_deref() {
            Some(staging_path) => {
                let relative = safe_relative_path(staging_path)?;
                if relative.components().count() < 2
                    || relative
                        .components()
                        .next()
                        .and_then(|component| component.as_os_str().to_str())
                        != Some(item.feature_id.as_str())
                {
                    return Err(TrustedPluginError::Storage(
                        "cleanup ledger staging path does not match Feature owner".into(),
                    ));
                }
                relative.to_string_lossy().replace('\\', "/")
            }
            None => {
                // A legacy entry without a staging handle is not safe to clean up
                // selectively. Preserve the complete Feature subtree until it is
                // reconciled or explicitly rejected.
                safe_identifier(&item.feature_id, "Feature id")?;
                item.feature_id.clone()
            }
        };
        owned_paths_by_service
            .entry(item.service_id.clone())
            .or_default()
            .push(owned_path);
    }

    let providers = data_root.join("providers");
    let Ok(services) = fs::read_dir(&providers) else {
        return Ok(());
    };
    for service in services.filter_map(Result::ok) {
        let service_metadata = match fs::symlink_metadata(service.path()) {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        if service_metadata.file_type().is_symlink() || !service_metadata.file_type().is_dir() {
            continue;
        }
        let service_id = service.file_name().to_string_lossy().into_owned();
        let transfers = service.path().join("transfers");
        let transfers_metadata = match fs::symlink_metadata(&transfers) {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        if transfers_metadata.file_type().is_symlink() || !transfers_metadata.file_type().is_dir() {
            continue;
        }
        cleanup_staging_tree(
            &transfers,
            Path::new(""),
            owned_paths_by_service
                .get(&service_id)
                .map(Vec::as_slice)
                .unwrap_or(&[]),
        )?;
    }
    Ok(())
}

fn cleanup_staging_tree(
    root: &Path,
    relative_root: &Path,
    owned_paths: &[String],
) -> Result<(), TrustedPluginError> {
    let Ok(entries) = fs::read_dir(root) else {
        return Ok(());
    };
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        if metadata.file_type().is_symlink() {
            continue;
        }
        let relative = relative_root.join(entry.file_name());
        let relative_text = relative.to_string_lossy().replace('\\', "/");
        let owned_exact = owned_paths.iter().any(|owned| owned == &relative_text);
        if owned_exact {
            // The ledger owns the complete job tree until Provider cancellation is confirmed.
            continue;
        }
        if !metadata.file_type().is_dir() {
            fs::remove_file(&path)
                .map_err(|error| TrustedPluginError::Storage(error.to_string()))?;
            continue;
        }
        let has_owned_descendant = owned_paths.iter().any(|owned| {
            owned
                .strip_prefix(&relative_text)
                .is_some_and(|suffix| suffix.starts_with('/'))
        });
        if !has_owned_descendant {
            fs::remove_dir_all(&path)
                .map_err(|error| TrustedPluginError::Storage(error.to_string()))?;
            continue;
        }
        cleanup_staging_tree(&path, &relative, owned_paths)?;
    }
    Ok(())
}

fn descriptor(
    manifest: &BundleManifest,
    id: String,
    version: String,
    files: &BTreeMap<String, Vec<u8>>,
) -> Result<ActiveTrustedPlugin, TrustedPluginError> {
    let utf8 = |name: &str| {
        String::from_utf8(files[name].clone()).map_err(|_| {
            TrustedPluginError::InvalidBundle(format!("plugin asset is not UTF-8: {name}"))
        })
    };
    Ok(ActiveTrustedPlugin {
        id,
        version,
        feature_manifest: manifest.feature_manifest.clone(),
        entry_source: utf8(&manifest.entry)?,
        styles: manifest
            .styles
            .iter()
            .map(|path| utf8(path))
            .collect::<Result<_, _>>()?,
    })
}

fn read_installed_descriptor(
    data_root: &Path,
    id: &str,
    version: &str,
    trusted_keys: &BTreeMap<String, VerifyingKey>,
) -> Result<ActiveTrustedPlugin, TrustedPluginError> {
    let root = installed_root(data_root, id, version);
    let read_regular = |name: &str| -> Result<Vec<u8>, TrustedPluginError> {
        let path = root.join(safe_relative_path(name)?);
        let metadata = fs::symlink_metadata(&path)
            .map_err(|_| TrustedPluginError::NotInstalled(id.into(), version.into()))?;
        if !metadata.file_type().is_file() {
            return Err(TrustedPluginError::Untrusted(format!(
                "installed path is not a regular file: {name}"
            )));
        }
        fs::read(path).map_err(|error| TrustedPluginError::Storage(error.to_string()))
    };
    let manifest_bytes = read_regular("plugin.json")?;
    let manifest: BundleManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|error| TrustedPluginError::Storage(error.to_string()))?;
    let mut files = BTreeMap::from([("plugin.json".into(), manifest_bytes)]);
    if !verify_disabled() {
        files.insert("plugin.sig".into(), read_regular("plugin.sig")?);
    }
    for name in manifest.files.keys() {
        files.insert(name.clone(), read_regular(name)?);
    }
    let (manifest, manifest_id, manifest_version) = verify_bundle(&files, trusted_keys)?;
    if manifest_id != id || manifest_version != version {
        return Err(TrustedPluginError::Storage(
            "installed plugin identity mismatch".into(),
        ));
    }
    descriptor(&manifest, manifest_id, manifest_version, &files)
}

pub fn install_bundle(
    data_root: &Path,
    bundle_path: &Path,
    trust_store_path: &Path,
) -> Result<ActiveTrustedPlugin, TrustedPluginError> {
    let files = read_archive(bundle_path)?;
    let trusted_keys = parse_trust_store(trust_store_path)?;
    let (manifest, id, version) = verify_bundle(&files, &trusted_keys)?;
    let target = installed_root(data_root, &id, &version);
    let staging = plugins_root(data_root).join(format!(".install-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        for (name, bytes) in &files {
            let path = staging.join(safe_relative_path(name)?);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)
                    .map_err(|error| TrustedPluginError::Storage(error.to_string()))?;
            }
            fs::write(path, bytes)
                .map_err(|error| TrustedPluginError::Storage(error.to_string()))?;
        }
        fs::create_dir_all(target.parent().expect("installed target has parent"))
            .map_err(|error| TrustedPluginError::Storage(error.to_string()))?;
        // 同版本强制替换:先尝试直接 rename;若 target 是已存在的"非空目录"(同版本覆盖)
        // 则删除旧目录后重试。
        match fs::rename(&staging, &target) {
            Ok(()) => {}
            Err(_) => {
                fs::remove_dir_all(&target)
                    .map_err(|error| TrustedPluginError::Storage(error.to_string()))?;
                fs::rename(&staging, &target)
                    .map_err(|error| TrustedPluginError::Storage(error.to_string()))?;
            }
        }
        descriptor(&manifest, id, version, &files)
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    result
}

fn install_and_maybe_activate(
    data_root: &Path,
    bundle_path: &Path,
    trust_store_path: &Path,
    activate: bool,
) -> Result<ActiveTrustedPlugin, TrustedPluginError> {
    match install_bundle(data_root, bundle_path, trust_store_path) {
        Ok(installed) => {
            if activate {
                set_active_version(data_root, &installed.id, &installed.version)?;
            }
            Ok(installed)
        }
        Err(TrustedPluginError::AlreadyInstalled(id, version)) if activate => {
            activate_plugin(data_root, trust_store_path, &id, &version)
        }
        Err(error) => Err(error),
    }
}

pub fn activate_plugin(
    data_root: &Path,
    trust_store_path: &Path,
    id: &str,
    version: &str,
) -> Result<ActiveTrustedPlugin, TrustedPluginError> {
    safe_identifier(id, "Feature id")?;
    safe_version(version)?;
    let descriptor = read_installed_descriptor(
        data_root,
        id,
        version,
        &parse_trust_store(trust_store_path)?,
    )?;
    set_active_version(data_root, id, version)?;
    Ok(descriptor)
}

fn set_active_version(data_root: &Path, id: &str, version: &str) -> Result<(), TrustedPluginError> {
    let _guard = registry_write_lock()
        .lock()
        .map_err(|_| TrustedPluginError::Storage("plugin registry is busy".into()))?;
    let mut registry = read_registry(data_root)?;
    let previous = registry.current.insert(id.into(), version.into());
    registry.active = registry.current.clone();
    registry.desired = registry.current.clone();
    registry.disabled.remove(id);
    if let Some(previous) = previous.filter(|previous| previous != version) {
        registry.previous.insert(id.into(), previous);
    }
    write_registry(data_root, &registry)
}

fn set_desired_version(
    data_root: &Path,
    id: &str,
    version: &str,
) -> Result<(), TrustedPluginError> {
    let _guard = registry_write_lock()
        .lock()
        .map_err(|_| TrustedPluginError::Storage("plugin registry is busy".into()))?;
    let mut registry = read_registry(data_root)?;
    registry.desired.insert(id.into(), version.into());
    registry.disabled.remove(id);
    write_registry(data_root, &registry)
}

fn ensure_system_version(
    data_root: &Path,
    id: &str,
    version: &str,
) -> Result<(), TrustedPluginError> {
    let _guard = registry_write_lock()
        .lock()
        .map_err(|_| TrustedPluginError::Storage("plugin registry is busy".into()))?;
    let mut registry = read_registry(data_root)?;
    if registry.disabled.contains(id) {
        return Ok(());
    }
    match registry.current.get(id) {
        // 指针已经指向系统包版本,没有要修的。
        Some(current) if current == version => return Ok(()),
        // 指针还停在别的版本上:内容没变的系统包走的是缓存快路径,不会经过安装分支的
        // 推进逻辑,只在首次见到这个包时记指针,0.1.17 那批「包已经解到 0.1.5、指针
        // 还停在 0.1.4」的设备就再也回不来了。这里补上落后的一格。
        Some(current) => {
            // 只补「系统包更新」这一种:指针本就更靠前(手动激活过高版本,或系统包回退)
            // 时不动,免得把用户选定的版本拽回去。版本串不可比时同样不动。
            let system_is_newer = matches!(
                (semver::Version::parse(version), semver::Version::parse(current)),
                (Ok(system), Ok(active)) if system > active
            );
            // previous 里正记着这个版本,说明它就是用户主动回滚掉的那一个,回滚优先。
            let rolled_back_from_it = registry
                .previous
                .get(id)
                .is_some_and(|previous| previous.as_str() == version);
            if !system_is_newer || rolled_back_from_it {
                return Ok(());
            }
        }
        // 首次见到这个系统包:用户显式指定过期望版本时不抢。
        None if registry.desired.contains_key(id) => return Ok(()),
        None => {}
    }
    registry.current.insert(id.into(), version.into());
    registry.active = registry.current.clone();
    registry.desired = registry.current.clone();
    write_registry(data_root, &registry)
}

fn clear_desired_version(data_root: &Path, id: &str) -> Result<(), TrustedPluginError> {
    let _guard = registry_write_lock()
        .lock()
        .map_err(|_| TrustedPluginError::Storage("plugin registry is busy".into()))?;
    let mut registry = read_registry(data_root)?;
    registry.desired.remove(id);
    registry.disabled.insert(id.into());
    write_registry(data_root, &registry)
}

fn reconcile_registry(data_root: &Path, trust_store_path: &Path) -> Result<(), TrustedPluginError> {
    let _guard = registry_write_lock()
        .lock()
        .map_err(|_| TrustedPluginError::Storage("plugin registry is busy".into()))?;
    let trusted_keys = parse_trust_store(trust_store_path)?;
    let mut registry = read_registry(data_root)?;
    let desired = registry.desired.clone();
    let mut next_current = registry.current.clone();
    for (id, version) in desired {
        if registry.disabled.contains(&id) {
            continue;
        }
        if read_installed_descriptor(data_root, &id, &version, &trusted_keys).is_ok()
            && next_current.get(&id) != Some(&version)
        {
            if let Some(previous) = next_current.insert(id.clone(), version) {
                registry.previous.insert(id, previous);
            }
        }
    }
    for (id, version) in next_current
        .iter()
        .filter(|(id, _)| !registry.desired.contains_key(*id) || registry.disabled.contains(*id))
    {
        registry.previous.insert(id.clone(), version.clone());
    }
    next_current
        .retain(|id, _| registry.desired.contains_key(id) && !registry.disabled.contains(id));
    registry.current = next_current;
    registry.active = registry.current.clone();
    write_registry(data_root, &registry)
}

fn request_activation(
    data_root: &Path,
    trust_store_path: &Path,
    id: &str,
    version: &str,
) -> Result<ActiveTrustedPlugin, TrustedPluginError> {
    safe_identifier(id, "Feature id")?;
    safe_version(version)?;
    let descriptor = read_installed_descriptor(
        data_root,
        id,
        version,
        &parse_trust_store(trust_store_path)?,
    )?;
    set_desired_version(data_root, id, version)?;
    Ok(descriptor)
}

fn request_rollback(
    data_root: &Path,
    trust_store_path: &Path,
    id: &str,
) -> Result<ActiveTrustedPlugin, TrustedPluginError> {
    safe_identifier(id, "Feature id")?;
    let registry = read_registry(data_root)?;
    let version = registry
        .previous
        .get(id)
        .cloned()
        .ok_or_else(|| TrustedPluginError::NotInstalled(id.into(), "previous".into()))?;
    let descriptor = read_installed_descriptor(
        data_root,
        id,
        &version,
        &parse_trust_store(trust_store_path)?,
    )?;
    validate_rollback_compatibility(data_root, &descriptor)?;
    set_desired_version(data_root, id, &version)?;
    Ok(descriptor)
}

fn validate_rollback_compatibility(
    data_root: &Path,
    descriptor: &ActiveTrustedPlugin,
) -> Result<(), TrustedPluginError> {
    let manifest: FeatureManifest = serde_json::from_value(descriptor.feature_manifest.clone())
        .map_err(|error| TrustedPluginError::InvalidBundle(error.to_string()))?;
    for capability in manifest.required_host_capabilities {
        let allowed = if let Some(service_id) = capability.strip_prefix("service:") {
            let capability_allowed =
                crate::feature_capabilities::runtime_service_capabilities_allow(
                    &manifest.id,
                    service_id,
                    &capability,
                );
            let operations_allowed =
                crate::feature_capabilities::runtime_service_operations(&manifest.id, service_id)
                    .is_some_and(|operations| !operations.is_empty());
            capability_allowed
                && operations_allowed
                && crate::external_services::service_registry_contains(data_root, service_id)
        } else if let Some(service_id) = capability.strip_prefix("external-service:") {
            let capability_allowed =
                crate::feature_capabilities::runtime_service_capabilities_allow(
                    &manifest.id,
                    service_id,
                    &format!("service:{service_id}"),
                );
            let operations_allowed =
                crate::feature_capabilities::runtime_service_operations(&manifest.id, service_id)
                    .is_some_and(|operations| !operations.is_empty());
            capability_allowed
                && operations_allowed
                && crate::external_services::service_registry_contains(data_root, service_id)
        } else {
            crate::feature_capabilities::runtime_grants()
                .features
                .get(&manifest.id)
                .is_some_and(|capabilities| capabilities.iter().any(|value| value == &capability))
        };
        if !allowed {
            return Err(TrustedPluginError::InvalidBundle(format!(
                "previous plugin is incompatible with current capability grants: {capability}"
            )));
        }
    }
    Ok(())
}

fn request_deactivation(data_root: &Path, id: &str) -> Result<(), TrustedPluginError> {
    safe_identifier(id, "Feature id")?;
    clear_desired_version(data_root, id)
}

pub fn rollback_plugin(
    data_root: &Path,
    trust_store_path: &Path,
    id: &str,
) -> Result<ActiveTrustedPlugin, TrustedPluginError> {
    safe_identifier(id, "Feature id")?;
    let registry = read_registry(data_root)?;
    let version = registry
        .previous
        .get(id)
        .cloned()
        .ok_or_else(|| TrustedPluginError::NotInstalled(id.into(), "previous".into()))?;
    let descriptor = read_installed_descriptor(
        data_root,
        id,
        &version,
        &parse_trust_store(trust_store_path)?,
    )?;
    validate_rollback_compatibility(data_root, &descriptor)?;
    set_active_version(data_root, id, &version)?;
    Ok(descriptor)
}

pub fn deactivate_plugin(data_root: &Path, id: &str) -> Result<(), TrustedPluginError> {
    safe_identifier(id, "Feature id")?;
    let _guard = registry_write_lock()
        .lock()
        .map_err(|_| TrustedPluginError::Storage("plugin registry is busy".into()))?;
    let mut registry = read_registry(data_root)?;
    let removed = registry
        .current
        .remove(id)
        .or_else(|| registry.active.remove(id));
    registry.active = registry.current.clone();
    registry.desired.remove(id);
    registry.disabled.insert(id.into());
    if removed.is_some() {
        write_registry(data_root, &registry)
    } else {
        Ok(())
    }
}

/// Removes an installed plugin completely: Feature instance, installed files and
/// every registry pointer. The id is recorded as disabled so the system plugin
/// directory does not silently reinstall it on the next start; an explicit
/// install clears that flag again. Deactivation alone keeps files on disk, which
/// left rejected bundles consuming space and re-failing verification on every
/// boot with no way to remove them.
pub async fn uninstall_plugin(
    data_root: &Path,
    jobs: &Arc<crate::feature_service_jobs::FeatureServiceJobRegistry>,
    id: &str,
) -> Result<(), TrustedPluginError> {
    safe_identifier(id, "Feature id")?;
    if let Some(instance) = feature_instance_binding(id) {
        stop_feature_instance_jobs(
            data_root,
            jobs,
            &crate::feature_file_grants::FileGrantOwner {
                feature_id: id.to_owned(),
                feature_instance_id: instance.token,
            },
        )
        .await;
    }
    let _guard = registry_write_lock()
        .lock()
        .map_err(|_| TrustedPluginError::Storage("plugin registry is busy".into()))?;
    let mut registry = read_registry(data_root)?;
    let known = registry.current.contains_key(id)
        || registry.desired.contains_key(id)
        || registry.previous.contains_key(id)
        || registry.disabled.contains(id);
    // Every installed version lives under installed/<id>/, so removing the
    // directory does not need the registry to still carry version pointers.
    let installed = plugins_root(data_root).join("installed").join(id);
    if installed.is_dir() {
        fs::remove_dir_all(&installed)
            .map_err(|error| TrustedPluginError::Storage(error.to_string()))?;
    } else if !known {
        return Err(TrustedPluginError::NotInstalled(id.into(), "*".into()));
    }
    registry.current.remove(id);
    registry.desired.remove(id);
    registry.previous.remove(id);
    registry.active = registry.current.clone();
    registry.disabled.insert(id.into());
    write_registry(data_root, &registry)?;
    invalidate_feature_instance(id);
    Ok(())
}

pub fn list_active_plugins(
    data_root: &Path,
    trust_store_path: &Path,
) -> Result<ActiveTrustedPluginList, TrustedPluginError> {
    let trusted_keys = parse_trust_store(trust_store_path)?;
    let mut plugins = Vec::new();
    let mut rejected = Vec::new();
    let registry = read_registry(data_root)?;
    let mut lifecycle = Vec::new();
    for (id, version) in &registry.current {
        let previous_version = registry.previous.get(id).cloned();
        match read_installed_descriptor(data_root, id, version, &trusted_keys) {
            Ok(plugin) => {
                lifecycle.push(TrustedPluginLifecycle {
                    id: id.clone(),
                    version: version.clone(),
                    status: if previous_version.is_some() {
                        "rollback-available".into()
                    } else {
                        "active".into()
                    },
                    code: None,
                    previous_version,
                    reason: None,
                });
                plugins.push(plugin);
            }
            Err(error) => {
                let (code, reason) = plugin_error_diagnostic(&error);
                lifecycle.push(TrustedPluginLifecycle {
                    id: id.clone(),
                    version: version.clone(),
                    status: "rejected".into(),
                    code: Some(code.clone()),
                    previous_version,
                    reason: Some(reason.clone()),
                });
                rejected.push(RejectedTrustedPlugin {
                    id: id.clone(),
                    version: version.clone(),
                    code,
                    reason,
                });
            }
        }
    }
    for (id, desired) in &registry.desired {
        if registry.current.get(id) != Some(desired) {
            let (code, reason) =
                match read_installed_descriptor(data_root, id, desired, &trusted_keys) {
                    Ok(_) => (
                        "pending_restart".into(),
                        "目标版本将在受控重启后激活".into(),
                    ),
                    Err(error) => plugin_error_diagnostic(&error),
                };
            let rejected_target = code != "pending_restart";
            lifecycle.push(TrustedPluginLifecycle {
                id: id.clone(),
                version: desired.clone(),
                status: if rejected_target {
                    "rejected"
                } else {
                    "pending-restart"
                }
                .into(),
                code: Some(code.clone()),
                previous_version: registry.previous.get(id).cloned(),
                reason: Some(reason.clone()),
            });
            if rejected_target {
                rejected.push(RejectedTrustedPlugin {
                    id: id.clone(),
                    version: desired.clone(),
                    code,
                    reason,
                });
            }
        }
    }
    for id in &registry.disabled {
        if let Some(version) = registry.previous.get(id) {
            lifecycle.push(TrustedPluginLifecycle {
                id: id.clone(),
                version: version.clone(),
                status: "disabled".into(),
                code: None,
                previous_version: None,
                reason: None,
            });
        }
    }
    Ok(ActiveTrustedPluginList {
        plugins,
        rejected,
        lifecycle,
    })
}

fn system_plugin_dir() -> PathBuf {
    std::env::var_os("BIBIT_SYSTEM_PLUGIN_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(SYSTEM_PLUGIN_DIR))
}

/// 系统插件安装缓存：`<data>/plugins/system-installed.json`。
///
/// 启动时 `sync_system_plugins` 会把系统目录里每个 `.bibit-plugin.tgz` 都解包、验签、
/// 逐文件写盘再覆盖 rename 一次。实测 4 个包 396ms，且这段窗口只发出 89 笔系统调用、
/// 合计 2.8ms I/O——成本全在用户态的解包/验签/写盘路径上。系统包的内容随发行包固定，
/// 所以按**文件内容哈希**记住「这个 tgz 装成了哪个 id@version」，哈希没变且安装目录还在
/// 就直接认账，不再重装一遍。
#[derive(Clone, Debug, Deserialize, Serialize)]
struct SystemPluginCacheEntry {
    id: String,
    version: String,
    sha256: String,
}

fn system_plugin_cache_path(data_root: &Path) -> PathBuf {
    plugins_root(data_root).join("system-installed.json")
}

fn file_sha256(path: &Path) -> Option<String> {
    fs::read(path)
        .ok()
        .map(|bytes| hex::encode(Sha256::digest(&bytes)))
}

/// 读不到或读坏了都当空缓存：最坏退回「每次启动重装一遍」，不阻断启动。
fn read_system_plugin_cache(data_root: &Path) -> BTreeMap<String, SystemPluginCacheEntry> {
    fs::read(system_plugin_cache_path(data_root))
        .ok()
        .and_then(|source| serde_json::from_slice(&source).ok())
        .unwrap_or_default()
}

fn write_system_plugin_cache(data_root: &Path, cache: &BTreeMap<String, SystemPluginCacheEntry>) {
    let path = system_plugin_cache_path(data_root);
    let Some(parent) = path.parent() else { return };
    let Ok(bytes) = serde_json::to_vec_pretty(cache) else {
        return;
    };
    if fs::create_dir_all(parent).is_err() {
        return;
    }
    let temporary = path.with_extension("json.tmp");
    if fs::write(&temporary, bytes).is_ok() {
        let _ = fs::rename(&temporary, &path);
    }
}

fn sync_system_plugins(
    data_root: &Path,
    trust_store_path: &Path,
    system_dir: &Path,
) -> Vec<RejectedTrustedPlugin> {
    let entries = match fs::read_dir(system_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
        Err(_error) => {
            return vec![RejectedTrustedPlugin {
                id: "system-plugin-directory".into(),
                version: "unknown".into(),
                code: "system_plugin_directory".into(),
                reason: "系统插件目录不可用".into(),
            }]
        }
    };
    let mut bundles = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            (name.ends_with(".bibit-plugin.tgz")
                && entry.file_type().is_ok_and(|kind| kind.is_file()))
            .then(|| entry.path())
        })
        .collect::<Vec<_>>();
    bundles.sort();
    // A user who removed a plugin from this directory expects it to stay
    // removed: re-verifying and re-extracting it on every boot brings back a
    // bundle they rejected and consumes the space they just freed. Only an
    // explicit install clears the disabled flag, so the peek below never hides
    // a plugin the user asked for.
    let disabled = read_registry(data_root)
        .map(|registry| registry.disabled)
        .unwrap_or_default();
    let trusted_keys = parse_trust_store(trust_store_path).ok();
    let mut cache = read_system_plugin_cache(data_root);
    let mut cache_dirty = false;
    // 一次同步里同一个插件可能同时存在多个版本的包。装完就把它们留在原地不管,
    // 重启后 current 会指回最早处理的那一个;因此这里先收集「本轮的版本」,
    // 全部处理完后统一按版本号最大的推进。
    let mut synced: BTreeMap<String, String> = BTreeMap::new();
    let mut rejected: Vec<RejectedTrustedPlugin> = bundles
        .into_iter()
        .filter_map(|bundle| {
            let name = bundle
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default();
            let sha256 = file_sha256(&bundle).unwrap_or_default();
            // 同样的内容、安装目录还在 → 直接认账。安装副本被动过也不会漏过去:
            // list_active_plugins 仍会按 plugin.json / plugin.sig / 逐文件哈希验签,
            // 发现问题记 rejected, 而不是在启动路径上重装一遍。
            let cached = cache
                .get(&name)
                .filter(|entry| !sha256.is_empty() && entry.sha256 == sha256)
                .cloned();
            if let Some(entry) = cached.as_ref() {
                if disabled.contains(&entry.id) {
                    return None;
                }
                if installed_root(data_root, &entry.id, &entry.version).is_dir() {
                    if let Err(error) = ensure_system_version(data_root, &entry.id, &entry.version)
                    {
                        let (code, reason) = plugin_error_diagnostic(&error);
                        return Some(RejectedTrustedPlugin {
                            id: entry.id.clone(),
                            version: entry.version.clone(),
                            code,
                            reason,
                        });
                    }
                    return None;
                }
            }
            if cached.is_none() && !disabled.is_empty() {
                if let Some(id) = trusted_keys.as_ref().and_then(|keys| {
                    read_archive(&bundle)
                        .and_then(|files| verify_bundle(&files, keys))
                        .ok()
                        .map(|(_, id, _)| id)
                }) {
                    if disabled.contains(&id) {
                        return None;
                    }
                }
            }
            let installed = match install_bundle(data_root, &bundle, trust_store_path) {
                Ok(plugin) => plugin,
                Err(TrustedPluginError::AlreadyInstalled(id, version)) => {
                    match read_installed_descriptor(
                        data_root,
                        &id,
                        &version,
                        &parse_trust_store(trust_store_path).ok()?,
                    ) {
                        Ok(plugin) => plugin,
                        Err(error) => {
                            let (code, reason) = plugin_error_diagnostic(&error);
                            return Some(RejectedTrustedPlugin {
                                id,
                                version,
                                code,
                                reason,
                            });
                        }
                    }
                }
                Err(error) => {
                    let (code, reason) = plugin_error_diagnostic(&error);
                    return Some(RejectedTrustedPlugin {
                        id: bundle
                            .file_name()
                            .unwrap_or_default()
                            .to_string_lossy()
                            .into_owned(),
                        version: "unknown".into(),
                        code,
                        reason,
                    });
                }
            };
            let best = synced
                .entry(installed.id.clone())
                .or_insert_with(|| installed.version.clone());
            if semver::Version::parse(&installed.version).ok()
                > semver::Version::parse(best).ok()
            {
                *best = installed.version.clone();
            }
            if !sha256.is_empty() {
                cache.insert(
                    name,
                    SystemPluginCacheEntry {
                        id: installed.id.clone(),
                        version: installed.version.clone(),
                        sha256,
                    },
                );
                cache_dirty = true;
            }
            None
        })
        .collect();
    // 系统目录里出现的新内容要成为当前版本:同版本覆盖目录内容即可,但版本号
    // 变化时 current 必须一起走,否则重启后仍指向上一个版本的安装目录。
    for (id, version) in synced {
        // 卸载过的插件不能被同步复活:用户移除后,目录里那份包只当作已拒绝的物料。
        if matches!(read_registry(data_root), Ok(registry) if registry.disabled.contains(&id)) {
            continue;
        }
        if let Err(error) = set_active_version(data_root, &id, &version) {
            let (code, reason) = plugin_error_diagnostic(&error);
            rejected.push(RejectedTrustedPlugin {
                id,
                version,
                code,
                reason,
            });
        }
    }
    if cache_dirty {
        write_system_plugin_cache(data_root, &cache);
    }
    rejected
}

fn ensure_main_surface(label: &str) -> Result<(), TrustedPluginError> {
    if label == "main" {
        Ok(())
    } else {
        Err(TrustedPluginError::WrongSurface)
    }
}

fn trust_store_path<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<PathBuf, TrustedPluginError> {
    #[cfg(debug_assertions)]
    if let Some(path) = std::env::var_os("BIBIT_PLUGIN_TRUST_STORE") {
        return Ok(PathBuf::from(path));
    }
    app.path()
        .resource_dir()
        .map(|path| path.join("resources/plugin-trusted-keys.json"))
        .map_err(|error| TrustedPluginError::Storage(error.to_string()))
}

#[tauri::command]
pub async fn trusted_plugin_install<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    window: WebviewWindow<R>,
    bundle_path: String,
    activate: Option<bool>,
) -> Result<ActiveTrustedPlugin, TrustedPluginError> {
    ensure_main_surface(window.label())?;
    let data_root = crate::core::app::commands::get_jan_data_folder_path(app.clone());
    let trust_store = trust_store_path(&app)?;
    let should_activate = activate.unwrap_or(false);
    let install_root = data_root.clone();
    let plugin = tauri::async_runtime::spawn_blocking(move || {
        match install_bundle(&install_root, Path::new(&bundle_path), &trust_store) {
            Ok(installed) if should_activate => request_activation(
                &install_root,
                &trust_store,
                &installed.id,
                &installed.version,
            ),
            Ok(installed) => Ok(installed),
            Err(TrustedPluginError::AlreadyInstalled(id, version)) if should_activate => {
                request_activation(&install_root, &trust_store, &id, &version)
            }
            Err(error) => Err(error),
        }
    })
    .await
    .map_err(|error| TrustedPluginError::Storage(error.to_string()))??;
    Ok(plugin)
}

#[tauri::command]
pub async fn trusted_plugin_activate<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    window: WebviewWindow<R>,
    id: String,
    version: String,
) -> Result<ActiveTrustedPlugin, TrustedPluginError> {
    ensure_main_surface(window.label())?;
    let trust_store = trust_store_path(&app)?;
    let data_root = crate::core::app::commands::get_jan_data_folder_path(app);
    let activation_root = data_root.clone();
    let plugin = tauri::async_runtime::spawn_blocking(move || {
        request_activation(&activation_root, &trust_store, &id, &version)
    })
    .await
    .map_err(|error| TrustedPluginError::Storage(error.to_string()))??;
    Ok(plugin)
}

#[tauri::command]
pub async fn trusted_plugin_rollback<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    window: WebviewWindow<R>,
    id: String,
) -> Result<ActiveTrustedPlugin, TrustedPluginError> {
    ensure_main_surface(window.label())?;
    let trust_store = trust_store_path(&app)?;
    let data_root = crate::core::app::commands::get_jan_data_folder_path(app);
    let rollback_root = data_root.clone();
    let plugin = tauri::async_runtime::spawn_blocking(move || {
        request_rollback(&rollback_root, &trust_store, &id)
    })
    .await
    .map_err(|error| TrustedPluginError::Storage(error.to_string()))??;
    Ok(plugin)
}

#[tauri::command]
pub async fn trusted_plugin_deactivate<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    window: WebviewWindow<R>,
    id: String,
) -> Result<(), TrustedPluginError> {
    ensure_main_surface(window.label())?;
    let data_root = crate::core::app::commands::get_jan_data_folder_path(app.clone());
    request_deactivation(&data_root, &id)?;
    Ok(())
}

#[tauri::command]
pub async fn trusted_plugin_uninstall<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    window: WebviewWindow<R>,
    id: String,
    jobs: tauri::State<'_, Arc<crate::feature_service_jobs::FeatureServiceJobRegistry>>,
) -> Result<(), TrustedPluginError> {
    ensure_main_surface(window.label())?;
    let data_root = crate::core::app::commands::get_jan_data_folder_path(app);
    uninstall_plugin(&data_root, jobs.inner(), &id).await
}

#[tauri::command]
pub async fn trusted_plugin_list_active<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<ActiveTrustedPluginList, TrustedPluginError> {
    let trust_store = trust_store_path(&app)?;
    let data_root = crate::core::app::commands::get_jan_data_folder_path(app);
    tauri::async_runtime::spawn_blocking(move || list_active_plugins(&data_root, &trust_store))
        .await
        .map_err(|error| TrustedPluginError::Storage(error.to_string()))?
}

#[tauri::command]
pub async fn trusted_plugin_prepare_active<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    window: WebviewWindow<R>,
    jobs: tauri::State<'_, Arc<crate::feature_service_jobs::FeatureServiceJobRegistry>>,
) -> Result<ActiveTrustedPluginMetadataList, TrustedPluginError> {
    ensure_main_surface(window.label())?;
    let trust_store = trust_store_path(&app)?;
    let data_root = crate::core::app::commands::get_jan_data_folder_path(app);
    let cleanup_report = recover_cleanup_ledger(&data_root, Arc::clone(&jobs)).await?;
    let before_reconcile = read_registry(&data_root)?;
    let system_dir = system_plugin_dir();
    let list_root = data_root.clone();
    let active = tauri::async_runtime::spawn_blocking(move || {
        crate::startup_trace::mark("system_plugins_begin");
        let system_rejected = sync_system_plugins(&list_root, &trust_store, &system_dir);
        crate::startup_trace::mark("system_plugins_end");
        reconcile_registry(&list_root, &trust_store)?;
        let mut active = list_active_plugins(&list_root, &trust_store)?;
        crate::startup_trace::mark("plugin_list_end");
        active.rejected.extend(system_rejected);
        active
            .lifecycle
            .extend(cleanup_lifecycle_entries(&cleanup_report));
        Ok(active)
    })
    .await
    .map_err(|error| TrustedPluginError::Storage(error.to_string()))??;
    for (id, old_version) in before_reconcile.current {
        let still_current = active
            .plugins
            .iter()
            .any(|plugin| plugin.id == id && plugin.version == old_version);
        if !still_current {
            if let Some(previous) =
                feature_instance_binding(&id).filter(|binding| binding.version == old_version)
            {
                stop_feature_instance_jobs(
                    &data_root,
                    &jobs,
                    &crate::feature_file_grants::FileGrantOwner {
                        feature_id: id.clone(),
                        feature_instance_id: previous.token,
                    },
                )
                .await;
                invalidate_feature_instance(&id);
            }
        }
    }
    for plugin in &active.plugins {
        if let Some(previous) = feature_instance_binding(&plugin.id) {
            stop_feature_instance_jobs(
                &data_root,
                &jobs,
                &crate::feature_file_grants::FileGrantOwner {
                    feature_id: plugin.id.clone(),
                    feature_instance_id: previous.token,
                },
            )
            .await;
        }
        attach_feature_instance(plugin, true)?;
    }
    Ok(ActiveTrustedPluginMetadataList {
        plugins: active
            .plugins
            .into_iter()
            .map(|plugin| ActiveTrustedPluginMetadata {
                id: plugin.id,
                version: plugin.version,
                feature_manifest: plugin.feature_manifest,
            })
            .collect(),
        rejected: active.rejected,
        lifecycle: active.lifecycle,
    })
}

#[tauri::command]
pub fn trusted_plugin_bootstrap<R: tauri::Runtime>(
    window: WebviewWindow<R>,
    request: FeatureInstanceBootstrapRequest,
) -> Result<FeatureInstanceBootstrap, TrustedPluginError> {
    ensure_main_surface(window.label())?;
    let feature_instance_token = take_feature_instance_token(
        &request.feature_id,
        &request.plugin_version,
        FeatureInstanceSource::TrustedPlugin,
    )?;
    Ok(FeatureInstanceBootstrap {
        feature_id: request.feature_id,
        plugin_version: request.plugin_version,
        feature_instance_token,
    })
}

#[tauri::command]
pub fn static_feature_bootstrap<R: tauri::Runtime>(
    window: WebviewWindow<R>,
    request: FeatureInstanceBootstrapRequest,
) -> Result<FeatureInstanceBootstrap, TrustedPluginError> {
    ensure_main_surface(window.label())?;
    attach_static_feature_instance_from(
        STATIC_FEATURE_MANIFESTS,
        &request.feature_id,
        &request.plugin_version,
    )?;
    let feature_instance_token = take_feature_instance_token(
        &request.feature_id,
        &request.plugin_version,
        FeatureInstanceSource::Builtin,
    )?;
    Ok(FeatureInstanceBootstrap {
        feature_id: request.feature_id,
        plugin_version: request.plugin_version,
        feature_instance_token,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use flate2::{write::GzEncoder, Compression};
    use rand::rngs::OsRng;
    use std::io::Write;
    use tempfile::TempDir;

    fn manifest_conformance_cases() -> Vec<(String, serde_json::Value)> {
        let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../tests/fixtures/manifest-conformance/cases");
        let entries = std::fs::read_dir(&directory)
            .unwrap_or_else(|error| panic!("read {}: {error}", directory.display()));
        let mut cases = entries
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| {
                path.extension()
                    .is_some_and(|extension| extension == "json")
            })
            .map(|path| {
                let source = std::fs::read(&path)
                    .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
                let case: serde_json::Value = serde_json::from_slice(&source)
                    .unwrap_or_else(|error| panic!("parse {}: {error}", path.display()));
                (
                    path.file_name().unwrap().to_string_lossy().into_owned(),
                    case,
                )
            })
            .collect::<Vec<_>>();
        cases.sort_by(|left, right| left.0.cmp(&right.0));
        cases
    }

    /// The bundled trust store is a release input: a malformed key or a stale
    /// key id silently rejects every correctly signed plugin, so validate its
    /// shape here rather than discovering it on a device.
    #[test]
    fn bundled_trust_store_parses_and_carries_plugin_keys() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources/plugin-trusted-keys.json");
        let store: TrustStore = serde_json::from_slice(
            &std::fs::read(&path)
                .unwrap_or_else(|error| panic!("read {}: {error}", path.display())),
        )
        .expect("bundled trust store must parse");
        assert_eq!(store.version, 1);
        assert!(
            !store.keys.is_empty(),
            "bundled trust store must carry keys"
        );
        for key in &store.keys {
            let bytes = BASE64
                .decode(&key.public_key)
                .unwrap_or_else(|_| panic!("invalid public key: {}", key.key_id));
            assert_eq!(
                bytes.len(),
                32,
                "public key {} must be 32 bytes",
                key.key_id
            );
        }
    }

    /// Both validators must agree with the shared case set. The frontend package
    /// runs the same files through the JSON Schema and its semantic checks, so a
    /// rule added on one side only shows up here instead of in production.
    #[test]
    fn conformance_cases_match_the_shared_expectations() {
        let cases = manifest_conformance_cases();
        assert!(
            cases.len() >= 10,
            "expected the shared manifest conformance case set"
        );
        for (name, case) in cases {
            let expected = case["expect"].as_str().unwrap_or_default();
            let accepted = validate_feature_manifest(&case["manifest"]).is_ok();
            assert_eq!(
                accepted,
                expected == "accept",
                "conformance case {name}: expected {expected}"
            );
        }
    }

    #[test]
    fn accepts_icon_and_navigation_group_tokens_this_build_does_not_know() {
        let mut unknown_display_key = valid_feature_manifest("unknown-icon");
        unknown_display_key["display"]["iconKey"] = serde_json::json!("rocket");
        assert!(validate_feature_manifest(&unknown_display_key).is_ok());

        let mut unknown_settings_group = valid_feature_manifest("unknown-settings-group");
        unknown_settings_group["contributions"]["settings"] = serde_json::json!([{
            "id": "diagnostics",
            "path": "diagnostics",
            "surfaces": ["main"],
            "navigation": {"group": "troubleshooting", "order": 100, "iconKey": "rocket"}
        }]);
        assert!(validate_feature_manifest(&unknown_settings_group).is_ok());

        let mut unknown_page_group = valid_feature_manifest("unknown-page-group");
        unknown_page_group["contributions"]["pages"] = serde_json::json!([{
            "id": "future",
            "path": "future",
            "surfaces": ["main"],
            "navigation": {"group": "future-surface"}
        }]);
        assert!(validate_feature_manifest(&unknown_page_group).is_ok());
    }

    #[test]
    fn rejects_malformed_icon_and_navigation_group_tokens() {
        for token in ["Rocket", "rocket_icon", "-rocket", "", "rocket--icon"] {
            let mut icon = valid_feature_manifest("bad-icon");
            icon["display"]["iconKey"] = serde_json::json!(token);
            assert!(
                validate_feature_manifest(&icon).is_err(),
                "iconKey {token:?} must be rejected"
            );

            let mut group = valid_feature_manifest("bad-group");
            group["contributions"]["pages"] = serde_json::json!([{
                "id": "page",
                "path": "page",
                "surfaces": ["main"],
                "navigation": {"group": token}
            }]);
            assert!(
                validate_feature_manifest(&group).is_err(),
                "navigation group {token:?} must be rejected"
            );
        }

        let mut oversized_icon = valid_feature_manifest("long-icon");
        oversized_icon["display"]["iconKey"] = serde_json::json!("a".repeat(65));
        assert!(validate_feature_manifest(&oversized_icon).is_err());
    }

    #[test]
    fn reuses_an_active_feature_instance_and_rotates_it_on_reactivation() {
        let plugin = ActiveTrustedPlugin {
            id: "instance-token-test".into(),
            version: "0.1.0".into(),
            feature_manifest: serde_json::json!({}),
            entry_source: String::new(),
            styles: Vec::new(),
        };

        assert_eq!(attach_feature_instance(&plugin, false).unwrap(), None);
        let first = feature_instance_binding(&plugin.id).unwrap().token;
        assert!(validate_feature_instance(&plugin.id, &first));
        assert_eq!(
            take_feature_instance_token(
                &plugin.id,
                &plugin.version,
                FeatureInstanceSource::TrustedPlugin,
            )
            .unwrap(),
            first
        );
        assert!(matches!(
            take_feature_instance_token(
                &plugin.id,
                &plugin.version,
                FeatureInstanceSource::TrustedPlugin,
            ),
            Err(TrustedPluginError::InstanceAlreadyBootstrapped(_, _))
        ));
        assert_eq!(attach_feature_instance(&plugin, false).unwrap(), None);
        assert_eq!(feature_instance_binding(&plugin.id).unwrap().token, first);

        assert_eq!(
            attach_feature_instance(&plugin, true).unwrap(),
            Some(first.clone())
        );
        let second = feature_instance_binding(&plugin.id).unwrap().token;
        assert_ne!(first, second);
        assert_eq!(
            take_feature_instance_token(
                &plugin.id,
                &plugin.version,
                FeatureInstanceSource::TrustedPlugin,
            )
            .unwrap(),
            second
        );
        assert!(!validate_feature_instance(&plugin.id, &first));
        assert!(validate_feature_instance(&plugin.id, &second));
        assert_eq!(invalidate_feature_instance(&plugin.id), Some(second));
    }

    #[test]
    fn active_plugin_descriptors_never_serialize_instance_tokens() {
        let plugin = ActiveTrustedPlugin {
            id: "descriptor-token-test".into(),
            version: "0.1.0".into(),
            feature_manifest: serde_json::json!({}),
            entry_source: String::new(),
            styles: Vec::new(),
        };

        attach_feature_instance(&plugin, false).unwrap();

        let serialized = serde_json::to_value(&plugin).unwrap();
        assert!(serialized.get("featureInstanceToken").is_none());
        invalidate_feature_instance(&plugin.id);
    }

    #[test]
    fn bootstraps_static_instances_only_from_the_native_allowlist_once() {
        const MANIFESTS: &[StaticFeatureManifest] = &[StaticFeatureManifest {
            id: "builtin-store",
            version: "1.0.0",
            capabilities: &["service:store"],
        }];

        attach_static_feature_instance_from(MANIFESTS, "builtin-store", "1.0.0").unwrap();
        let token =
            take_feature_instance_token("builtin-store", "1.0.0", FeatureInstanceSource::Builtin)
                .unwrap();
        assert!(validate_feature_instance_version_capability(
            "builtin-store",
            "1.0.0",
            &token,
            "service:store"
        ));
        assert!(!validate_feature_instance_version_capability(
            "builtin-store",
            "0.9.0",
            &token,
            "service:store"
        ));
        assert!(matches!(
            take_feature_instance_token("builtin-store", "1.0.0", FeatureInstanceSource::Builtin,),
            Err(TrustedPluginError::InstanceAlreadyBootstrapped(_, _))
        ));
        assert!(matches!(
            attach_static_feature_instance_from(MANIFESTS, "unlisted", "1.0.0"),
            Err(TrustedPluginError::InstanceUnavailable(_, _))
        ));
        invalidate_feature_instance("builtin-store");
    }

    fn valid_feature_manifest(id: &str) -> Value {
        serde_json::json!({
            "manifestSchemaVersion": 1,
            "sdkApiVersion": 1,
            "id": id,
            "version": "0.1.0",
            "owner": "agent-hub-team",
            "display": {"titleKey":"agent-hub:title","fallbackTitle":"Agent Hub","iconKey":"store"},
            "targets": ["desktop"],
            "requiredHostCapabilities": [],
            "contributions": {"pages":[],"settings":[],"conversation":[],"locales":["en"]}
        })
    }

    fn write_fixture(
        root: &TempDir,
        signing_key: &SigningKey,
        signature_valid: bool,
    ) -> (PathBuf, PathBuf) {
        write_fixture_with_manifest(
            root,
            signing_key,
            signature_valid,
            valid_feature_manifest("agent-hub"),
        )
    }

    fn write_fixture_with_manifest(
        root: &TempDir,
        signing_key: &SigningKey,
        signature_valid: bool,
        feature_manifest: Value,
    ) -> (PathBuf, PathBuf) {
        let plugin_js = b"globalThis.pluginLoaded = true;";
        let plugin_hash = hex::encode(Sha256::digest(plugin_js));
        let id = feature_manifest["id"]
            .as_str()
            .unwrap_or("invalid")
            .to_string();
        let manifest = serde_json::json!({
            "pluginSchemaVersion": 1,
            "featureManifest": feature_manifest,
            "entry": "dist/plugin.js",
            "styles": [],
            "files": {"dist/plugin.js": plugin_hash}
        });
        let manifest_bytes =
            format!("{}\n", serde_json::to_string_pretty(&manifest).unwrap()).into_bytes();
        let signed_bytes = if signature_valid {
            manifest_bytes.as_slice()
        } else {
            b"tampered"
        };
        let signature = signing_key.sign(signed_bytes);
        let signature_bytes = serde_json::to_vec_pretty(&serde_json::json!({
            "keyId": "development",
            "signature": BASE64.encode(signature.to_bytes())
        }))
        .unwrap();

        let bundle_path = root.path().join(format!("{id}.bibit-plugin.tgz"));
        let file = fs::File::create(&bundle_path).unwrap();
        let encoder = GzEncoder::new(file, Compression::default());
        let mut archive = tar::Builder::new(encoder);
        for (name, bytes) in [
            ("plugin.json", manifest_bytes.as_slice()),
            ("plugin.sig", signature_bytes.as_slice()),
            ("dist/plugin.js", plugin_js.as_slice()),
        ] {
            let mut header = tar::Header::new_gnu();
            header.set_size(bytes.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            archive.append_data(&mut header, name, bytes).unwrap();
        }
        archive
            .into_inner()
            .unwrap()
            .finish()
            .unwrap()
            .flush()
            .unwrap();

        let trust_path = root.path().join("trusted-keys.json");
        fs::write(
            &trust_path,
            serde_json::to_vec_pretty(&serde_json::json!({
                "version": 1,
                "keys": [{
                    "keyId": "development",
                    "publicKey": BASE64.encode(signing_key.verifying_key().to_bytes())
                }]
            }))
            .unwrap(),
        )
        .unwrap();
        (bundle_path, trust_path)
    }

    fn write_fixture_with_entry(
        root: &TempDir,
        signing_key: &SigningKey,
        feature_manifest: Value,
        plugin_js: &[u8],
    ) -> (PathBuf, PathBuf) {
        let plugin_hash = hex::encode(Sha256::digest(plugin_js));
        let id = feature_manifest["id"]
            .as_str()
            .unwrap_or("invalid")
            .to_string();
        let manifest = serde_json::json!({
            "pluginSchemaVersion": 1,
            "featureManifest": feature_manifest,
            "entry": "dist/plugin.js",
            "styles": [],
            "files": {"dist/plugin.js": plugin_hash}
        });
        let manifest_bytes =
            format!("{}\n", serde_json::to_string_pretty(&manifest).unwrap()).into_bytes();
        let signature_bytes = serde_json::to_vec_pretty(&serde_json::json!({
            "keyId": "development",
            "signature": BASE64.encode(signing_key.sign(&manifest_bytes).to_bytes())
        }))
        .unwrap();

        let bundle_path = root.path().join(format!("{id}.bibit-plugin.tgz"));
        let file = fs::File::create(&bundle_path).unwrap();
        let encoder = GzEncoder::new(file, Compression::default());
        let mut archive = tar::Builder::new(encoder);
        for (name, bytes) in [
            ("plugin.json", manifest_bytes.as_slice()),
            ("plugin.sig", signature_bytes.as_slice()),
            ("dist/plugin.js", plugin_js),
        ] {
            let mut header = tar::Header::new_gnu();
            header.set_size(bytes.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            archive.append_data(&mut header, name, bytes).unwrap();
        }
        archive
            .into_inner()
            .unwrap()
            .finish()
            .unwrap()
            .flush()
            .unwrap();

        let trust_path = root.path().join("trusted-keys.json");
        fs::write(
            &trust_path,
            serde_json::to_vec_pretty(&serde_json::json!({
                "version": 1,
                "keys": [{
                    "keyId": "development",
                    "publicKey": BASE64.encode(signing_key.verifying_key().to_bytes())
                }]
            }))
            .unwrap(),
        )
        .unwrap();
        (bundle_path, trust_path)
    }

    #[test]
    fn installs_activates_and_lists_a_verified_plugin() {
        let root = TempDir::new().unwrap();
        let signing_key = SigningKey::generate(&mut OsRng);
        let (bundle, trust_store) = write_fixture(&root, &signing_key, true);

        let installed = install_bundle(root.path(), &bundle, &trust_store).unwrap();
        assert_eq!(installed.id, "agent-hub");
        assert_eq!(installed.entry_source, "globalThis.pluginLoaded = true;");
        activate_plugin(root.path(), &trust_store, "agent-hub", "0.1.0").unwrap();
        reconcile_registry(root.path(), &trust_store).unwrap();
        let active = list_active_plugins(root.path(), &trust_store).unwrap();
        assert_eq!(active.plugins.len(), 1);
        assert!(active.rejected.is_empty());
        assert_eq!(active.plugins[0].version, "0.1.0");
        deactivate_plugin(root.path(), "agent-hub").unwrap();
        assert!(list_active_plugins(root.path(), &trust_store)
            .unwrap()
            .plugins
            .is_empty());
    }

    #[test]
    fn uninstall_removes_files_registry_pointers_and_blocks_reinstall() {
        let root = TempDir::new().unwrap();
        let signing_key = SigningKey::generate(&mut OsRng);
        let (bundle, trust_store) = write_fixture(&root, &signing_key, true);
        let plugin = install_bundle(root.path(), &bundle, &trust_store).unwrap();
        activate_plugin(root.path(), &trust_store, "agent-hub", "0.1.0").unwrap();
        attach_feature_instance(&plugin, false).unwrap();
        let installed = installed_root(root.path(), "agent-hub", "0.1.0");
        assert!(installed.is_dir());
        assert!(feature_instance_binding("agent-hub").is_some());

        let grants = Arc::new(
            crate::feature_file_grants::FeatureFileGrantService::new(root.path().to_path_buf())
                .unwrap(),
        );
        let jobs = Arc::new(crate::feature_service_jobs::FeatureServiceJobRegistry::new(
            grants,
        ));
        tauri::async_runtime::block_on(uninstall_plugin(root.path(), &jobs, "agent-hub")).unwrap();

        assert!(
            !installed.exists(),
            "uninstall must delete the installed bundle"
        );
        assert!(!plugins_root(root.path())
            .join("installed/agent-hub")
            .exists());
        let registry = read_registry(root.path()).unwrap();
        assert!(!registry.current.contains_key("agent-hub"));
        assert!(!registry.desired.contains_key("agent-hub"));
        assert!(!registry.previous.contains_key("agent-hub"));
        assert!(feature_instance_binding("agent-hub").is_none());

        // The system plugin directory must not silently reinstall what the user
        // just removed; only an explicit install clears the flag again.
        ensure_system_version(root.path(), "agent-hub", "0.1.0").unwrap();
        assert!(!read_registry(root.path())
            .unwrap()
            .current
            .contains_key("agent-hub"));
        set_desired_version(root.path(), "agent-hub", "0.1.0").unwrap();
        assert!(!read_registry(root.path())
            .unwrap()
            .disabled
            .contains("agent-hub"));

        assert!(matches!(
            tauri::async_runtime::block_on(uninstall_plugin(root.path(), &jobs, "unknown-plugin")),
            Err(TrustedPluginError::NotInstalled(_, _))
        ));
    }

    #[test]
    fn sync_system_plugins_leaves_a_removed_plugin_removed() {
        let data_root = TempDir::new().unwrap();
        let system_dir = TempDir::new().unwrap();
        let signing_key = SigningKey::generate(&mut OsRng);
        let (_, trust_store) = write_fixture(&system_dir, &signing_key, true);
        let grants = Arc::new(
            crate::feature_file_grants::FeatureFileGrantService::new(
                data_root.path().to_path_buf(),
            )
            .unwrap(),
        );
        let jobs = Arc::new(crate::feature_service_jobs::FeatureServiceJobRegistry::new(
            grants,
        ));

        assert!(sync_system_plugins(data_root.path(), &trust_store, system_dir.path()).is_empty());
        tauri::async_runtime::block_on(uninstall_plugin(data_root.path(), &jobs, "agent-hub"))
            .unwrap();

        assert!(sync_system_plugins(data_root.path(), &trust_store, system_dir.path()).is_empty());
        assert!(!plugins_root(data_root.path())
            .join("installed/agent-hub")
            .exists());
        assert!(!read_registry(data_root.path())
            .unwrap()
            .current
            .contains_key("agent-hub"));
    }

    #[test]
    fn sync_system_plugins_skips_reinstalling_an_unchanged_bundle() {
        let data_root = TempDir::new().unwrap();
        let system_dir = TempDir::new().unwrap();
        let signing_key = SigningKey::generate(&mut OsRng);
        let (_bundle, trust_store) = write_fixture(&system_dir, &signing_key, true);

        assert!(sync_system_plugins(data_root.path(), &trust_store, system_dir.path()).is_empty());
        assert!(system_plugin_cache_path(data_root.path()).is_file());

        // 包内容没变 → 第二次同步不再解包重装:先留下的标记必须原样还在。
        let installed_entry =
            installed_root(data_root.path(), "agent-hub", "0.1.0").join("dist/plugin.js");
        fs::write(&installed_entry, b"marker").unwrap();
        assert!(sync_system_plugins(data_root.path(), &trust_store, system_dir.path()).is_empty());
        assert_eq!(fs::read(&installed_entry).unwrap(), b"marker");

        // 安装目录被清掉(手动清或上次装了一半) → 缓存不掩盖,照旧重装回签名内容。
        fs::remove_dir_all(installed_root(data_root.path(), "agent-hub", "0.1.0")).unwrap();
        assert!(sync_system_plugins(data_root.path(), &trust_store, system_dir.path()).is_empty());
        assert_eq!(
            fs::read(&installed_entry).unwrap(),
            b"globalThis.pluginLoaded = true;"
        );
    }

    #[test]
    fn installs_a_signed_plugin_with_a_dynamic_service_capability() {
        let root = TempDir::new().unwrap();
        let signing_key = SigningKey::generate(&mut OsRng);
        let mut manifest = valid_feature_manifest("agent-hub");
        manifest["requiredHostCapabilities"] = serde_json::json!(["service:store"]);
        let (bundle, trust_store) =
            write_fixture_with_manifest(&root, &signing_key, true, manifest);

        let installed = install_bundle(root.path(), &bundle, &trust_store).unwrap();

        assert_eq!(installed.id, "agent-hub");
    }

    #[test]
    fn installs_a_signed_plugin_with_core_settings_navigation_metadata() {
        let root = TempDir::new().unwrap();
        let signing_key = SigningKey::generate(&mut OsRng);
        let mut manifest = valid_feature_manifest("agent-hub");
        manifest["contributions"]["settings"] = serde_json::json!([{
            "id": "runtime-status",
            "path": "runtime-status",
            "surfaces": ["main"],
            "navigation": {
                "group": "core",
                "order": 110,
                "titleKey": "runtime:settings.runtimeStatus",
                "fallbackTitle": "Runtime Status",
                "iconKey": "settings",
                "section": {
                    "id": "runtime-monitoring",
                    "titleKey": "runtime:settings.monitoring",
                    "fallbackTitle": "监控"
                }
            }
        }]);
        let (bundle, trust_store) =
            write_fixture_with_manifest(&root, &signing_key, true, manifest);

        install_bundle(root.path(), &bundle, &trust_store).unwrap();
    }

    #[test]
    fn rejects_a_signed_plugin_with_an_invalid_dynamic_service_capability() {
        let root = TempDir::new().unwrap();
        let signing_key = SigningKey::generate(&mut OsRng);
        let mut manifest = valid_feature_manifest("agent-hub");
        manifest["requiredHostCapabilities"] = serde_json::json!(["service:Store"]);
        let (bundle, trust_store) =
            write_fixture_with_manifest(&root, &signing_key, true, manifest);

        assert!(matches!(
            install_bundle(root.path(), &bundle, &trust_store),
            Err(TrustedPluginError::InvalidBundle(_))
        ));
    }

    #[test]
    fn rejects_a_bundle_with_an_invalid_signature() {
        let root = TempDir::new().unwrap();
        let signing_key = SigningKey::generate(&mut OsRng);
        let (bundle, trust_store) = write_fixture(&root, &signing_key, false);

        assert!(matches!(
            install_bundle(root.path(), &bundle, &trust_store),
            Err(TrustedPluginError::Untrusted(_))
        ));
    }

    #[test]
    fn rejects_an_installed_plugin_modified_after_verification() {
        let root = TempDir::new().unwrap();
        let signing_key = SigningKey::generate(&mut OsRng);
        let (bundle, trust_store) = write_fixture(&root, &signing_key, true);
        install_bundle(root.path(), &bundle, &trust_store).unwrap();
        fs::write(
            installed_root(root.path(), "agent-hub", "0.1.0").join("dist/plugin.js"),
            b"globalThis.pluginLoaded = 'tampered';",
        )
        .unwrap();

        assert!(matches!(
            activate_plugin(root.path(), &trust_store, "agent-hub", "0.1.0"),
            Err(TrustedPluginError::InvalidBundle(_))
        ));
    }

    #[test]
    fn rejects_a_signed_incomplete_feature_manifest() {
        let root = TempDir::new().unwrap();
        let signing_key = SigningKey::generate(&mut OsRng);
        let mut manifest = valid_feature_manifest("agent-hub");
        manifest.as_object_mut().unwrap().remove("contributions");
        let (bundle, trust_store) =
            write_fixture_with_manifest(&root, &signing_key, true, manifest);

        assert!(matches!(
            install_bundle(root.path(), &bundle, &trust_store),
            Err(TrustedPluginError::InvalidBundle(_))
        ));
    }

    #[test]
    fn isolates_a_rejected_active_plugin() {
        let root = TempDir::new().unwrap();
        let signing_key = SigningKey::generate(&mut OsRng);
        let (agent_bundle, trust_store) = write_fixture(&root, &signing_key, true);
        let (security_bundle, _) = write_fixture_with_manifest(
            &root,
            &signing_key,
            true,
            valid_feature_manifest("security"),
        );
        install_and_maybe_activate(root.path(), &agent_bundle, &trust_store, true).unwrap();
        install_and_maybe_activate(root.path(), &security_bundle, &trust_store, true).unwrap();
        fs::write(
            installed_root(root.path(), "security", "0.1.0").join("dist/plugin.js"),
            b"tampered",
        )
        .unwrap();

        reconcile_registry(root.path(), &trust_store).unwrap();
        let active = list_active_plugins(root.path(), &trust_store).unwrap();
        assert_eq!(active.plugins.len(), 1);
        assert_eq!(active.plugins[0].id, "agent-hub");
        assert_eq!(active.rejected.len(), 1);
        assert_eq!(active.rejected[0].id, "security");
    }

    #[test]
    fn reactivates_an_already_installed_verified_bundle() {
        let root = TempDir::new().unwrap();
        let signing_key = SigningKey::generate(&mut OsRng);
        let (bundle, trust_store) = write_fixture(&root, &signing_key, true);
        install_bundle(root.path(), &bundle, &trust_store).unwrap();

        install_and_maybe_activate(root.path(), &bundle, &trust_store, true).unwrap();
        assert_eq!(
            list_active_plugins(root.path(), &trust_store)
                .unwrap()
                .plugins
                .len(),
            1
        );
    }

    #[test]
    fn activation_keeps_current_previous_and_rollback_pointers() {
        let root = TempDir::new().unwrap();
        let signing_key = SigningKey::generate(&mut OsRng);
        let (bundle, trust_store) = write_fixture(&root, &signing_key, true);
        install_bundle(root.path(), &bundle, &trust_store).unwrap();
        activate_plugin(root.path(), &trust_store, "agent-hub", "0.1.0").unwrap();

        let mut manifest = valid_feature_manifest("agent-hub");
        manifest["version"] = serde_json::json!("0.2.0");
        let (bundle_v2, _) = write_fixture_with_manifest(&root, &signing_key, true, manifest);
        install_bundle(root.path(), &bundle_v2, &trust_store).unwrap();
        activate_plugin(root.path(), &trust_store, "agent-hub", "0.2.0").unwrap();

        let registry: Value =
            serde_json::from_slice(&fs::read(registry_path(root.path())).unwrap()).unwrap();
        assert_eq!(registry["current"]["agent-hub"], "0.2.0");
        assert_eq!(registry["desired"]["agent-hub"], "0.2.0");
        assert_eq!(registry["active"]["agent-hub"], "0.2.0");
        assert_eq!(registry["previous"]["agent-hub"], "0.1.0");

        rollback_plugin(root.path(), &trust_store, "agent-hub").unwrap();
        let rolled_back = list_active_plugins(root.path(), &trust_store).unwrap();
        assert_eq!(rolled_back.plugins[0].version, "0.1.0");
        let registry: Value =
            serde_json::from_slice(&fs::read(registry_path(root.path())).unwrap()).unwrap();
        assert_eq!(registry["current"]["agent-hub"], "0.1.0");
        assert_eq!(registry["previous"]["agent-hub"], "0.2.0");
    }

    #[test]
    fn rollback_rejects_previous_version_when_capability_grant_is_missing() {
        let root = TempDir::new().unwrap();
        let signing_key = SigningKey::generate(&mut OsRng);
        let mut incompatible = valid_feature_manifest("agent-hub");
        incompatible["requiredHostCapabilities"] = serde_json::json!(["service:memory"]);
        let (old_bundle, trust_store) =
            write_fixture_with_manifest(&root, &signing_key, true, incompatible);
        install_bundle(root.path(), &old_bundle, &trust_store).unwrap();
        activate_plugin(root.path(), &trust_store, "agent-hub", "0.1.0").unwrap();

        let mut current = valid_feature_manifest("agent-hub");
        current["version"] = serde_json::json!("0.2.0");
        let (current_bundle, _) = write_fixture_with_manifest(&root, &signing_key, true, current);
        install_bundle(root.path(), &current_bundle, &trust_store).unwrap();
        activate_plugin(root.path(), &trust_store, "agent-hub", "0.2.0").unwrap();

        assert!(matches!(
            rollback_plugin(root.path(), &trust_store, "agent-hub"),
            Err(TrustedPluginError::InvalidBundle(reason))
                if reason.contains("incompatible with current capability grants")
        ));
        assert_eq!(
            read_registry(root.path()).unwrap().current["agent-hub"],
            "0.2.0"
        );
    }

    #[test]
    fn rollback_rejects_service_feature_without_provider_registry() {
        let root = TempDir::new().unwrap();
        let system_registry = TempDir::new().unwrap();
        let _registry_scope =
            crate::external_services::isolated_registry_for_test(system_registry.path());
        assert!(!crate::external_services::service_registry_contains(
            root.path(),
            "store"
        ));
        let signing_key = SigningKey::generate(&mut OsRng);
        let mut old_manifest = valid_feature_manifest("agent-hub");
        old_manifest["requiredHostCapabilities"] = serde_json::json!(["service:store"]);
        let (old_bundle, trust_store) =
            write_fixture_with_manifest(&root, &signing_key, true, old_manifest);
        install_bundle(root.path(), &old_bundle, &trust_store).unwrap();
        activate_plugin(root.path(), &trust_store, "agent-hub", "0.1.0").unwrap();

        let mut current = valid_feature_manifest("agent-hub");
        current["version"] = serde_json::json!("0.2.0");
        let (current_bundle, _) = write_fixture_with_manifest(&root, &signing_key, true, current);
        install_bundle(root.path(), &current_bundle, &trust_store).unwrap();
        activate_plugin(root.path(), &trust_store, "agent-hub", "0.2.0").unwrap();

        assert!(matches!(
            rollback_plugin(root.path(), &trust_store, "agent-hub"),
            Err(TrustedPluginError::InvalidBundle(reason))
                if reason.contains("capability grants")
        ));
    }

    #[test]
    fn rollback_accepts_service_feature_only_when_registry_is_configured() {
        let root = TempDir::new().unwrap();
        let system_registry = TempDir::new().unwrap();
        let _registry_scope =
            crate::external_services::isolated_registry_for_test(system_registry.path());
        assert!(!crate::external_services::service_registry_contains(
            root.path(),
            "store"
        ));
        let signing_key = SigningKey::generate(&mut OsRng);
        let mut old_manifest = valid_feature_manifest("agent-hub");
        old_manifest["requiredHostCapabilities"] = serde_json::json!(["service:store"]);
        let (old_bundle, trust_store) =
            write_fixture_with_manifest(&root, &signing_key, true, old_manifest);
        install_bundle(root.path(), &old_bundle, &trust_store).unwrap();
        activate_plugin(root.path(), &trust_store, "agent-hub", "0.1.0").unwrap();

        let mut current = valid_feature_manifest("agent-hub");
        current["version"] = serde_json::json!("0.2.0");
        let (current_bundle, _) = write_fixture_with_manifest(&root, &signing_key, true, current);
        install_bundle(root.path(), &current_bundle, &trust_store).unwrap();
        activate_plugin(root.path(), &trust_store, "agent-hub", "0.2.0").unwrap();

        fs::write(
            root.path().join("external-service-connections.json"),
            br#"{"version":2,"services":{"store":{"transport":"stdio","executable":"/bin/true","lifecycle":"managed","protocolVersions":[1,2]}}}"#,
        )
        .unwrap();
        rollback_plugin(root.path(), &trust_store, "agent-hub").unwrap();
        assert_eq!(
            read_registry(root.path()).unwrap().current["agent-hub"],
            "0.1.0"
        );
    }

    #[test]
    fn failed_activation_does_not_change_the_current_pointer() {
        let root = TempDir::new().unwrap();
        let signing_key = SigningKey::generate(&mut OsRng);
        let (bundle, trust_store) = write_fixture(&root, &signing_key, true);
        install_and_maybe_activate(root.path(), &bundle, &trust_store, true).unwrap();

        assert!(activate_plugin(root.path(), &trust_store, "agent-hub", "9.9.9").is_err());
        let registry = read_registry(root.path()).unwrap();
        assert_eq!(registry.current.get("agent-hub"), Some(&"0.1.0".into()));
        assert_eq!(registry.desired.get("agent-hub"), Some(&"0.1.0".into()));
    }

    #[test]
    fn requested_activation_is_pending_until_registry_reconciliation() {
        let root = TempDir::new().unwrap();
        let signing_key = SigningKey::generate(&mut OsRng);
        let (bundle, trust_store) = write_fixture(&root, &signing_key, true);
        install_bundle(root.path(), &bundle, &trust_store).unwrap();

        request_activation(root.path(), &trust_store, "agent-hub", "0.1.0").unwrap();
        let registry = read_registry(root.path()).unwrap();
        assert!(registry.current.is_empty());
        assert_eq!(registry.desired.get("agent-hub"), Some(&"0.1.0".into()));

        reconcile_registry(root.path(), &trust_store).unwrap();
        let active = list_active_plugins(root.path(), &trust_store).unwrap();
        assert_eq!(active.plugins[0].version, "0.1.0");
        assert_eq!(
            read_registry(root.path()).unwrap().current["agent-hub"],
            "0.1.0"
        );
    }

    #[test]
    fn requested_deactivation_retires_current_on_next_reconciliation() {
        let root = TempDir::new().unwrap();
        let signing_key = SigningKey::generate(&mut OsRng);
        let (bundle, trust_store) = write_fixture(&root, &signing_key, true);
        install_and_maybe_activate(root.path(), &bundle, &trust_store, true).unwrap();

        request_deactivation(root.path(), "agent-hub").unwrap();
        let before = read_registry(root.path()).unwrap();
        assert!(before.current.contains_key("agent-hub"));
        assert!(!before.desired.contains_key("agent-hub"));

        reconcile_registry(root.path(), &trust_store).unwrap();
        let active = list_active_plugins(root.path(), &trust_store).unwrap();
        assert!(active.plugins.is_empty());
        assert!(!read_registry(root.path())
            .unwrap()
            .current
            .contains_key("agent-hub"));
        assert_eq!(
            read_registry(root.path())
                .unwrap()
                .previous
                .get("agent-hub"),
            Some(&"0.1.0".into())
        );
        assert!(active.lifecycle.iter().any(|item| {
            item.id == "agent-hub" && item.version == "0.1.0" && item.status == "disabled"
        }));
    }

    #[test]
    fn rejected_desired_version_keeps_current_and_reports_the_failed_target() {
        let root = TempDir::new().unwrap();
        let signing_key = SigningKey::generate(&mut OsRng);
        let (current_bundle, trust_store) = write_fixture(&root, &signing_key, true);
        install_bundle(root.path(), &current_bundle, &trust_store).unwrap();
        activate_plugin(root.path(), &trust_store, "agent-hub", "0.1.0").unwrap();

        let mut desired = valid_feature_manifest("agent-hub");
        desired["version"] = serde_json::json!("0.2.0");
        let (desired_bundle, _) = write_fixture_with_manifest(&root, &signing_key, true, desired);
        install_bundle(root.path(), &desired_bundle, &trust_store).unwrap();
        request_activation(root.path(), &trust_store, "agent-hub", "0.2.0").unwrap();
        fs::write(
            installed_root(root.path(), "agent-hub", "0.2.0").join("dist/plugin.js"),
            b"tampered",
        )
        .unwrap();

        reconcile_registry(root.path(), &trust_store).unwrap();
        let active = list_active_plugins(root.path(), &trust_store).unwrap();

        assert_eq!(active.plugins[0].version, "0.1.0");
        assert!(active
            .rejected
            .iter()
            .any(|item| { item.id == "agent-hub" && item.version == "0.2.0" }));
        assert!(active.lifecycle.iter().any(|item| {
            item.id == "agent-hub" && item.version == "0.2.0" && item.status == "rejected"
        }));
    }

    #[test]
    fn migrates_the_legacy_active_registry_without_losing_activation() {
        let root = TempDir::new().unwrap();
        fs::create_dir_all(plugins_root(root.path())).unwrap();
        fs::write(
            registry_path(root.path()),
            br#"{"version":1,"active":{"agent-hub":"0.1.0"}}"#,
        )
        .unwrap();

        let registry = read_registry(root.path()).unwrap();
        assert_eq!(registry.version, REGISTRY_VERSION);
        assert_eq!(registry.current.get("agent-hub"), Some(&"0.1.0".into()));
        assert_eq!(registry.desired.get("agent-hub"), Some(&"0.1.0".into()));
    }

    #[test]
    fn cleanup_pending_maps_to_a_pending_cleanup_lifecycle_status() {
        let root = TempDir::new().unwrap();
        let staging = root
            .path()
            .join("providers/store/transfers/agent-hub/job-1");
        fs::create_dir_all(&staging).unwrap();
        record_cleanup_ledger_entry(
            root.path(),
            "agent-hub",
            "instance-1",
            "store",
            "job-1",
            "agent-hub/job-1",
        )
        .unwrap();

        let grants = Arc::new(
            crate::feature_file_grants::FeatureFileGrantService::new(root.path().to_path_buf())
                .unwrap(),
        );
        let jobs = Arc::new(crate::feature_service_jobs::FeatureServiceJobRegistry::new(
            grants,
        ));
        let report =
            tauri::async_runtime::block_on(recover_cleanup_ledger(root.path(), jobs)).unwrap();
        assert_eq!(
            report.pending.len(),
            1,
            "provider is unavailable in this test"
        );

        let lifecycle = cleanup_lifecycle_entries(&report);
        assert_eq!(lifecycle.len(), 1);
        assert_eq!(lifecycle[0].id, "agent-hub");
        assert_eq!(lifecycle[0].status, "pending-cleanup");
        assert_eq!(lifecycle[0].code.as_deref(), Some("cleanup_pending"));
        assert!(lifecycle[0]
            .reason
            .as_deref()
            .unwrap_or_default()
            .contains("job-1"));
    }

    #[test]
    fn cleanup_ledger_keeps_failed_provider_cancel_and_removes_staging() {
        let root = TempDir::new().unwrap();
        let staging = root
            .path()
            .join("providers/store/transfers/agent-hub/job-1");
        fs::create_dir_all(&staging).unwrap();
        fs::write(staging.join("input.bin"), b"payload").unwrap();

        record_cleanup_ledger_entry(
            root.path(),
            "agent-hub",
            "instance-1",
            "store",
            "job-1",
            "agent-hub/job-1",
        )
        .unwrap();

        let grants = Arc::new(
            crate::feature_file_grants::FeatureFileGrantService::new(root.path().to_path_buf())
                .unwrap(),
        );
        let jobs = Arc::new(crate::feature_service_jobs::FeatureServiceJobRegistry::new(
            grants,
        ));
        let report =
            tauri::async_runtime::block_on(recover_cleanup_ledger(root.path(), jobs)).unwrap();
        assert!(
            report.recovered.is_empty(),
            "provider is unavailable in this test"
        );
        assert_eq!(report.pending.len(), 1);
        assert!(
            !staging.exists(),
            "recovery must always clean local staging"
        );
        assert_eq!(read_cleanup_ledger(root.path()).unwrap().len(), 1);

        remove_cleanup_ledger_entry(root.path(), "agent-hub", "job-1").unwrap();
        assert!(read_cleanup_ledger(root.path()).unwrap().is_empty());
    }

    #[test]
    fn cleanup_ledger_rejects_paths_outside_provider_transfers() {
        let root = TempDir::new().unwrap();
        assert!(record_cleanup_ledger_entry(
            root.path(),
            "agent-hub",
            "instance-1",
            "store",
            "job-1",
            "../../outside",
        )
        .is_err());
    }

    #[test]
    fn startup_cleanup_removes_only_unowned_staging() {
        let root = TempDir::new().unwrap();
        let owned = root
            .path()
            .join("providers/store/transfers/agent-hub/job-1");
        let orphan = root.path().join("providers/store/transfers/security/job-2");
        fs::create_dir_all(&owned).unwrap();
        fs::create_dir_all(&orphan).unwrap();
        record_cleanup_ledger_entry(
            root.path(),
            "agent-hub",
            "instance-1",
            "store",
            "job-1",
            "agent-hub/job-1",
        )
        .unwrap();

        let entries = read_cleanup_ledger(root.path()).unwrap();
        assert_eq!(entries[0].staging_path.as_deref(), Some("agent-hub/job-1"));
        cleanup_unowned_staging(root.path(), &entries).unwrap();
        assert!(owned.exists());
        assert!(!orphan.exists());
    }

    #[test]
    fn startup_cleanup_removes_orphan_jobs_inside_an_owned_feature_directory() {
        let root = TempDir::new().unwrap();
        let owned = root
            .path()
            .join("providers/store/transfers/agent-hub/job-1");
        let orphan = root
            .path()
            .join("providers/store/transfers/agent-hub/job-2");
        fs::create_dir_all(&owned).unwrap();
        fs::create_dir_all(&orphan).unwrap();
        fs::write(owned.join("input.bin"), b"keep").unwrap();
        fs::write(orphan.join("input.bin"), b"remove").unwrap();
        record_cleanup_ledger_entry(
            root.path(),
            "agent-hub",
            "instance-1",
            "store",
            "job-1",
            "agent-hub/job-1",
        )
        .unwrap();

        let entries = read_cleanup_ledger(root.path()).unwrap();
        cleanup_unowned_staging(root.path(), &entries).unwrap();

        assert_eq!(fs::read(owned.join("input.bin")).unwrap(), b"keep");
        assert!(!orphan.exists());
    }

    #[test]
    fn startup_cleanup_preserves_feature_tree_when_legacy_ledger_has_no_staging_path() {
        let root = TempDir::new().unwrap();
        let owned = root
            .path()
            .join("providers/store/transfers/agent-hub/job-1");
        let orphan = root
            .path()
            .join("providers/store/transfers/agent-hub/job-2");
        fs::create_dir_all(&owned).unwrap();
        fs::create_dir_all(&orphan).unwrap();
        let ledger = CleanupLedgerEntry {
            feature_id: "agent-hub".into(),
            feature_instance_id: "instance-1".into(),
            service_id: "store".into(),
            job_id: "job-1".into(),
            staging_path: None,
        };

        cleanup_unowned_staging(root.path(), &[ledger]).unwrap();

        assert!(owned.exists());
        assert!(orphan.exists());
    }

    #[test]
    fn startup_cleanup_removes_orphan_files_at_transfers_root() {
        let root = TempDir::new().unwrap();
        let transfers = root.path().join("providers/store/transfers");
        fs::create_dir_all(&transfers).unwrap();
        let orphan = transfers.join("orphan.bin");
        fs::write(&orphan, b"orphan").unwrap();

        cleanup_unowned_staging(root.path(), &[]).unwrap();

        assert!(!orphan.exists());
    }

    #[cfg(unix)]
    #[test]
    fn startup_cleanup_does_not_follow_a_transfers_symlink() {
        use std::os::unix::fs::symlink;

        let root = TempDir::new().unwrap();
        let outside = root.path().join("outside");
        fs::create_dir_all(outside.join("agent-hub/job-1")).unwrap();
        let transfers = root.path().join("providers/store/transfers");
        fs::create_dir_all(transfers.parent().unwrap()).unwrap();
        symlink(&outside, &transfers).unwrap();

        cleanup_unowned_staging(root.path(), &[]).unwrap();

        assert!(outside.join("agent-hub/job-1").exists());
    }

    #[cfg(unix)]
    #[test]
    fn startup_cleanup_does_not_follow_a_provider_service_symlink() {
        use std::os::unix::fs::symlink;

        let root = TempDir::new().unwrap();
        let outside = root.path().join("outside");
        fs::create_dir_all(outside.join("transfers/agent-hub/job-1")).unwrap();
        let provider = root.path().join("providers/store");
        fs::create_dir_all(provider.parent().unwrap()).unwrap();
        symlink(&outside, &provider).unwrap();

        cleanup_unowned_staging(root.path(), &[]).unwrap();

        assert!(outside.join("transfers/agent-hub/job-1").exists());
    }

    #[cfg(unix)]
    #[test]
    fn startup_cleanup_does_not_follow_a_job_directory_symlink() {
        use std::os::unix::fs::symlink;

        let root = TempDir::new().unwrap();
        let outside = root.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        let transfers = root.path().join("providers/store/transfers/agent-hub");
        fs::create_dir_all(&transfers).unwrap();
        symlink(&outside, transfers.join("job-1")).unwrap();

        cleanup_unowned_staging(root.path(), &[]).unwrap();

        assert!(outside.exists());
    }

    #[test]
    fn automatically_activates_valid_system_plugins_and_isolates_bad_bundles() {
        let root = TempDir::new().unwrap();
        let data_root = root.path().join("data");
        let system_dir = root.path().join("system-plugins");
        fs::create_dir_all(&system_dir).unwrap();
        let signing_key = SigningKey::generate(&mut OsRng);
        let (bundle, trust_store) = write_fixture(&root, &signing_key, true);
        fs::copy(bundle, system_dir.join("agent-hub.bibit-plugin.tgz")).unwrap();
        fs::write(system_dir.join("broken.bibit-plugin.tgz"), b"not a bundle").unwrap();

        let rejected = sync_system_plugins(&data_root, &trust_store, &system_dir);

        assert_eq!(rejected.len(), 1);
        let active = list_active_plugins(&data_root, &trust_store).unwrap();
        assert_eq!(active.plugins.len(), 1);
        assert_eq!(active.plugins[0].id, "agent-hub");
    }

    #[test]
    fn bounds_expanded_bytes_and_all_archive_entries() {
        let root = TempDir::new().unwrap();
        let bundle_path = root.path().join("limits.tgz");
        let file = fs::File::create(&bundle_path).unwrap();
        let encoder = GzEncoder::new(file, Compression::best());
        let mut archive = tar::Builder::new(encoder);
        let bytes = vec![0_u8; 1025];
        let mut header = tar::Header::new_gnu();
        header.set_size(bytes.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        archive
            .append_data(&mut header, "large", bytes.as_slice())
            .unwrap();
        archive.into_inner().unwrap().finish().unwrap();
        assert!(read_archive_with_limits(&bundle_path, 1024, 10).is_err());

        let directory_bundle = root.path().join("directories.tgz");
        let file = fs::File::create(&directory_bundle).unwrap();
        let encoder = GzEncoder::new(file, Compression::best());
        let mut archive = tar::Builder::new(encoder);
        for name in ["one/", "two/", "three/"] {
            let mut header = tar::Header::new_gnu();
            header.set_entry_type(tar::EntryType::Directory);
            header.set_size(0);
            header.set_mode(0o755);
            header.set_cksum();
            archive.append_data(&mut header, name, &[][..]).unwrap();
        }
        archive.into_inner().unwrap().finish().unwrap();
        assert!(read_archive_with_limits(&directory_bundle, 1024, 2).is_err());
    }

    #[test]
    fn installs_sdk_generated_bundle() {
        let (Ok(bundle), Ok(trust_store)) = (
            std::env::var("BIBIT_PLUGIN_INTEROP_BUNDLE"),
            std::env::var("BIBIT_PLUGIN_INTEROP_TRUST_STORE"),
        ) else {
            return;
        };
        let root = TempDir::new().unwrap();

        let installed =
            install_bundle(root.path(), Path::new(&bundle), Path::new(&trust_store)).unwrap();
        let expected_id =
            std::env::var("BIBIT_PLUGIN_INTEROP_ID").unwrap_or_else(|_| "interop-plugin".into());
        assert_eq!(installed.id, expected_id);
        assert!(!installed.entry_source.is_empty());

        if let Ok(second_bundle) = std::env::var("BIBIT_PLUGIN_INTEROP_BUNDLE_2") {
            let second = install_bundle(
                root.path(),
                Path::new(&second_bundle),
                Path::new(&trust_store),
            )
            .unwrap();
            let expected_second_id = std::env::var("BIBIT_PLUGIN_INTEROP_ID_2")
                .unwrap_or_else(|_| "second-interop-plugin".into());
            assert_eq!(second.id, expected_second_id);
            assert!(!second.entry_source.is_empty());
        }
    }

    #[test]
    fn feature_identity_matches_the_public_manifest_constraints() {
        for id in ["1agent", "agent--hub", "Agent-hub"] {
            assert!(safe_identifier(id, "Feature id").is_err());
        }
        for version in ["1", "01.0.0", "latest"] {
            assert!(safe_version(version).is_err());
        }
        safe_identifier("agent-hub", "Feature id").unwrap();
        safe_version("1.2.3-beta.1+build.4").unwrap();
    }

    #[test]
    fn rejects_plugin_management_from_other_windows() {
        assert!(ensure_main_surface("main").is_ok());
        assert!(matches!(
            ensure_main_surface("status-popup"),
            Err(TrustedPluginError::WrongSurface)
        ));
    }

    #[test]
    fn same_version_install_overwrites_content() {
        let root = TempDir::new().unwrap();
        let signing_key = SigningKey::generate(&mut OsRng);

        // 第一次安装:版本 0.1.0,内容 A
        let (bundle_a, trust_store) = write_fixture_with_entry(
            &root,
            &signing_key,
            valid_feature_manifest("agent-hub"),
            b"globalThis.pluginLoaded = true;",
        );
        let installed_a = install_bundle(root.path(), &bundle_a, &trust_store).unwrap();
        assert_eq!(installed_a.entry_source, "globalThis.pluginLoaded = true;");

        // 第二次安装:同版本 0.1.0,但内容 B(不同 plugin.js)
        let (bundle_b, _) = write_fixture_with_entry(
            &root,
            &signing_key,
            valid_feature_manifest("agent-hub"),
            b"globalThis.pluginLoaded = 'updated';",
        );
        let installed_b = install_bundle(root.path(), &bundle_b, &trust_store).unwrap();
        // 关键断言:第二次不再返回 AlreadyInstalled,且 entry_source 是新的
        assert_eq!(installed_b.entry_source, "globalThis.pluginLoaded = 'updated';");

        // 重新从磁盘读取,确认覆盖生效
        let descriptor = read_installed_descriptor(
            root.path(),
            "agent-hub",
            "0.1.0",
            &parse_trust_store(&trust_store).unwrap(),
        )
        .unwrap();
        assert_eq!(descriptor.entry_source, "globalThis.pluginLoaded = 'updated';");
    }

    #[test]
    fn version_upgrade_still_keeps_rollback_pointer() {
        let root = TempDir::new().unwrap();
        let signing_key = SigningKey::generate(&mut OsRng);

        // v0.1.0 安装并激活
        let (bundle_v1, trust_store) = write_fixture(&root, &signing_key, true);
        install_bundle(root.path(), &bundle_v1, &trust_store).unwrap();
        activate_plugin(root.path(), &trust_store, "agent-hub", "0.1.0").unwrap();

        // v0.2.0 安装并激活(版本升级)
        let mut manifest_v2 = valid_feature_manifest("agent-hub");
        manifest_v2["version"] = serde_json::json!("0.2.0");
        let (bundle_v2, _) =
            write_fixture_with_manifest(&root, &signing_key, true, manifest_v2);
        install_bundle(root.path(), &bundle_v2, &trust_store).unwrap();
        activate_plugin(root.path(), &trust_store, "agent-hub", "0.2.0").unwrap();

        let registry: Value =
            serde_json::from_slice(&fs::read(registry_path(root.path())).unwrap()).unwrap();
        assert_eq!(registry["current"]["agent-hub"], "0.2.0");
        assert_eq!(registry["previous"]["agent-hub"], "0.1.0");
    }

    #[test]
    fn system_plugin_same_version_overwrite_reads_new_content() {
        let root = TempDir::new().unwrap();
        let data_root = root.path().join("data");
        let system_dir = root.path().join("system-plugins");
        fs::create_dir_all(&system_dir).unwrap();
        let signing_key = SigningKey::generate(&mut OsRng);

        // 第一次:系统目录放内容 A
        let (bundle_a, trust_store) = write_fixture_with_entry(
            &root,
            &signing_key,
            valid_feature_manifest("agent-hub"),
            b"globalThis.pluginLoaded = true;",
        );
        fs::copy(&bundle_a, system_dir.join("agent-hub.bibit-plugin.tgz")).unwrap();
        sync_system_plugins(&data_root, &trust_store, &system_dir);
        let active = list_active_plugins(&data_root, &trust_store).unwrap();
        assert_eq!(active.plugins[0].entry_source, "globalThis.pluginLoaded = true;");

        // 第二次:系统目录覆盖为内容 B(同版本)
        let (bundle_b, _) = write_fixture_with_entry(
            &root,
            &signing_key,
            valid_feature_manifest("agent-hub"),
            b"globalThis.pluginLoaded = 'system-updated';",
        );
        fs::copy(&bundle_b, system_dir.join("agent-hub.bibit-plugin.tgz")).unwrap();
        sync_system_plugins(&data_root, &trust_store, &system_dir);
        let active = list_active_plugins(&data_root, &trust_store).unwrap();
        assert_eq!(
            active.plugins[0].entry_source,
            "globalThis.pluginLoaded = 'system-updated';"
        );
    }

    #[test]
    fn system_plugin_version_change_advances_active_version() {
        let root = TempDir::new().unwrap();
        let data_root = root.path().join("data");
        let system_dir = root.path().join("system-plugins");
        fs::create_dir_all(&system_dir).unwrap();
        let signing_key = SigningKey::generate(&mut OsRng);

        // 第一轮:系统目录里是 0.1.0
        let (bundle_v1, trust_store) = write_fixture(&root, &signing_key, true);
        fs::copy(&bundle_v1, system_dir.join("agent-hub.bibit-plugin.tgz")).unwrap();
        assert!(sync_system_plugins(&data_root, &trust_store, &system_dir).is_empty());
        let registry: Value =
            serde_json::from_slice(&fs::read(registry_path(&data_root)).unwrap()).unwrap();
        assert_eq!(registry["current"]["agent-hub"], "0.1.0");

        // 第二轮:同一个包名被换成 0.2.0(内容变、版本号也变)
        let mut manifest_v2 = valid_feature_manifest("agent-hub");
        manifest_v2["version"] = serde_json::json!("0.2.0");
        let (bundle_v2, _) = write_fixture_with_manifest(&root, &signing_key, true, manifest_v2);
        fs::copy(&bundle_v2, system_dir.join("agent-hub.bibit-plugin.tgz")).unwrap();
        assert!(sync_system_plugins(&data_root, &trust_store, &system_dir).is_empty());

        // 当前版本必须跟着走,否则重启后加载的还是 0.1.0
        let registry: Value =
            serde_json::from_slice(&fs::read(registry_path(&data_root)).unwrap()).unwrap();
        assert_eq!(registry["current"]["agent-hub"], "0.2.0");
        assert_eq!(registry["desired"]["agent-hub"], "0.2.0");
        assert_eq!(registry["previous"]["agent-hub"], "0.1.0");

        // 重启时 reconcile 不得把版本退回去
        reconcile_registry(&data_root, &trust_store).unwrap();
        let active = list_active_plugins(&data_root, &trust_store).unwrap();
        assert_eq!(active.plugins.len(), 1);
        assert_eq!(active.plugins[0].version, "0.2.0");
    }

    #[test]
    fn system_plugin_new_content_does_not_resurrect_a_disabled_plugin() {
        let root = TempDir::new().unwrap();
        let data_root = root.path().join("data");
        let system_dir = root.path().join("system-plugins");
        fs::create_dir_all(&system_dir).unwrap();
        let signing_key = SigningKey::generate(&mut OsRng);

        let (bundle_v1, trust_store) = write_fixture(&root, &signing_key, true);
        fs::copy(&bundle_v1, system_dir.join("agent-hub.bibit-plugin.tgz")).unwrap();
        assert!(sync_system_plugins(&data_root, &trust_store, &system_dir).is_empty());
        request_deactivation(&data_root, "agent-hub").unwrap();

        // 停用之后系统目录里换了新版本内容:同步必须尊重停用,不能把插件装回来。
        let mut manifest_v2 = valid_feature_manifest("agent-hub");
        manifest_v2["version"] = serde_json::json!("0.2.0");
        let (bundle_v2, _) = write_fixture_with_manifest(&root, &signing_key, true, manifest_v2);
        fs::copy(&bundle_v2, system_dir.join("agent-hub.bibit-plugin.tgz")).unwrap();
        assert!(sync_system_plugins(&data_root, &trust_store, &system_dir).is_empty());
        reconcile_registry(&data_root, &trust_store).unwrap();

        let registry: Value =
            serde_json::from_slice(&fs::read(registry_path(&data_root)).unwrap()).unwrap();
        assert!(registry["disabled"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry == "agent-hub"));
        assert!(registry["current"].get("agent-hub").is_none());
        assert!(list_active_plugins(&data_root, &trust_store)
            .unwrap()
            .plugins
            .is_empty());
    }

    #[test]
    fn system_plugin_multiple_versions_activate_the_newest() {
        let root = TempDir::new().unwrap();
        let data_root = root.path().join("data");
        let system_dir = root.path().join("system-plugins");
        fs::create_dir_all(&system_dir).unwrap();
        let signing_key = SigningKey::generate(&mut OsRng);

        let mut trust_store = PathBuf::new();
        for (version, file_name) in [
            ("0.9.0", "agent-hub-0.9.0.bibit-plugin.tgz"),
            ("0.10.0", "agent-hub-0.10.0.bibit-plugin.tgz"),
        ] {
            let mut manifest = valid_feature_manifest("agent-hub");
            manifest["version"] = serde_json::json!(version);
            let (bundle, store) = write_fixture_with_manifest(&root, &signing_key, true, manifest);
            trust_store = store;
            fs::copy(&bundle, system_dir.join(file_name)).unwrap();
            assert!(sync_system_plugins(&data_root, &trust_store, &system_dir).is_empty());
        }

        // 文件名排序会把 0.10.0 排在 0.9.0 前面,最终版本得按版本号取而不是按处理顺序取
        let registry: Value =
            serde_json::from_slice(&fs::read(registry_path(&data_root)).unwrap()).unwrap();
        assert_eq!(registry["current"]["agent-hub"], "0.10.0");
        let active = list_active_plugins(&data_root, &trust_store).unwrap();
        assert_eq!(active.plugins[0].version, "0.10.0");
    }

    #[test]
    fn system_plugin_cache_hit_repairs_a_stale_registry_pointer() {
        let root = TempDir::new().unwrap();
        let data_root = root.path().join("data");
        let system_dir = root.path().join("system-plugins");
        fs::create_dir_all(&system_dir).unwrap();
        let signing_key = SigningKey::generate(&mut OsRng);

        // 第一轮:系统目录里是 0.1.0,指针正常落在 0.1.0
        let (bundle_v1, trust_store) = write_fixture(&root, &signing_key, true);
        let bundle_path = system_dir.join("agent-hub.bibit-plugin.tgz");
        fs::copy(&bundle_v1, &bundle_path).unwrap();
        assert!(sync_system_plugins(&data_root, &trust_store, &system_dir).is_empty());

        // 第二轮:deb 换成 0.2.0。旧版本只把安装目录和缓存写出来,没动指针。
        let mut manifest_v2 = valid_feature_manifest("agent-hub");
        manifest_v2["version"] = serde_json::json!("0.2.0");
        let (bundle_v2, _) = write_fixture_with_manifest(&root, &signing_key, true, manifest_v2);
        fs::copy(&bundle_v2, &bundle_path).unwrap();
        install_bundle(&data_root, &bundle_path, &trust_store).unwrap();
        let mut cache = read_system_plugin_cache(&data_root);
        cache.insert(
            "agent-hub.bibit-plugin.tgz".into(),
            SystemPluginCacheEntry {
                id: "agent-hub".into(),
                version: "0.2.0".into(),
                sha256: file_sha256(&bundle_path).unwrap(),
            },
        );
        write_system_plugin_cache(&data_root, &cache);
        assert_eq!(
            read_registry(&data_root).unwrap().current["agent-hub"],
            "0.1.0"
        );

        // 重启:包内容哈希没变,走的是缓存快路径,也必须把指针补到系统包版本。
        assert!(sync_system_plugins(&data_root, &trust_store, &system_dir).is_empty());
        reconcile_registry(&data_root, &trust_store).unwrap();
        let registry: Value =
            serde_json::from_slice(&fs::read(registry_path(&data_root)).unwrap()).unwrap();
        assert_eq!(registry["current"]["agent-hub"], "0.2.0");
        assert_eq!(registry["desired"]["agent-hub"], "0.2.0");
        let active = list_active_plugins(&data_root, &trust_store).unwrap();
        assert_eq!(active.plugins.len(), 1);
        assert_eq!(active.plugins[0].version, "0.2.0");
    }

    #[test]
    fn system_plugin_cache_hit_keeps_a_user_rollback() {
        let root = TempDir::new().unwrap();
        let data_root = root.path().join("data");
        let system_dir = root.path().join("system-plugins");
        fs::create_dir_all(&system_dir).unwrap();
        let signing_key = SigningKey::generate(&mut OsRng);

        // 系统包从 0.1.0 换到 0.2.0,按内容变更路径正常推进
        let (bundle_v1, trust_store) = write_fixture(&root, &signing_key, true);
        fs::copy(&bundle_v1, system_dir.join("agent-hub.bibit-plugin.tgz")).unwrap();
        assert!(sync_system_plugins(&data_root, &trust_store, &system_dir).is_empty());
        let mut manifest_v2 = valid_feature_manifest("agent-hub");
        manifest_v2["version"] = serde_json::json!("0.2.0");
        let (bundle_v2, _) = write_fixture_with_manifest(&root, &signing_key, true, manifest_v2);
        fs::copy(&bundle_v2, system_dir.join("agent-hub.bibit-plugin.tgz")).unwrap();
        assert!(sync_system_plugins(&data_root, &trust_store, &system_dir).is_empty());
        reconcile_registry(&data_root, &trust_store).unwrap();
        assert_eq!(
            read_registry(&data_root).unwrap().current["agent-hub"],
            "0.2.0"
        );

        // 用户主动回滚到 0.1.0
        request_rollback(&data_root, &trust_store, "agent-hub").unwrap();
        reconcile_registry(&data_root, &trust_store).unwrap();
        assert_eq!(
            read_registry(&data_root).unwrap().current["agent-hub"],
            "0.1.0"
        );

        // 重启:缓存命中的 0.2.0 正是用户回滚掉的那个版本,不能自己装回来
        assert!(sync_system_plugins(&data_root, &trust_store, &system_dir).is_empty());
        reconcile_registry(&data_root, &trust_store).unwrap();
        let registry: Value =
            serde_json::from_slice(&fs::read(registry_path(&data_root)).unwrap()).unwrap();
        assert_eq!(registry["current"]["agent-hub"], "0.1.0");
        let active = list_active_plugins(&data_root, &trust_store).unwrap();
        assert_eq!(active.plugins[0].version, "0.1.0");
    }
}
