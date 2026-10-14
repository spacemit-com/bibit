use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager, Runtime, State};

use super::{
    constants::{CONFIGURATION_FILE_NAME, TAURI_BUNDLE_IDENTIFIER},
    models::AppConfiguration,
};
use crate::core::state::AppState;

/// Canonical BiBit app support directory (`%APPDATA%/BiBit` on Windows).
fn resolve_human_readable_app_data_dir() -> Option<PathBuf> {
    dirs::data_dir().map(|d| d.join(env!("CARGO_PKG_NAME")))
}

/// Tauri bundle-id app support directory (e.g. `%APPDATA%/com.dc.bibit.gui` on Windows).
fn resolve_bundle_app_data_dir() -> Option<PathBuf> {
    dirs::data_dir().map(|d| d.join(TAURI_BUNDLE_IDENTIFIER))
}

/// Keep `%APPDATA%/BiBit/settings.json` as canonical, but recover from alternate
/// alternate locations if users removed one directory (#7898).
fn migrate_legacy_app_configuration(app_data_dir: &Path) -> std::io::Result<()> {
    fs::create_dir_all(app_data_dir)?;
    let canonical = app_data_dir.join(CONFIGURATION_FILE_NAME);
    if canonical.exists() {
        return Ok(());
    }

    migrate_from_candidates(&canonical, legacy_app_config_candidate_paths(app_data_dir))
}

fn migrate_from_candidates(canonical: &Path, candidates: Vec<PathBuf>) -> std::io::Result<()> {
    if let Some(parent) = canonical.parent() {
        fs::create_dir_all(parent)?;
    }

    for legacy in candidates {
        if legacy.is_file() {
            log::info!(
                "Recovering app configuration from {} to {}",
                legacy.display(),
                canonical.display()
            );
            fs::copy(&legacy, canonical)?;
            // Remove the stale copy in the bundle-id folder so the canonical
            // product-name location is the single source of truth (#7898).
            if let Err(err) = fs::remove_file(&legacy) {
                log::warn!("Failed to remove legacy config {}: {err}", legacy.display());
            }
            return Ok(());
        }
    }
    Ok(())
}

fn legacy_app_config_candidate_paths(app_data_dir: &Path) -> Vec<PathBuf> {
    let mut paths = Vec::new();

    if let Some(bundle_dir) = resolve_bundle_app_data_dir() {
        paths.push(bundle_dir.join(CONFIGURATION_FILE_NAME));
    }

    #[cfg(target_os = "linux")]
    {
        let package_name = env!("CARGO_PKG_NAME");
        if let Some(config_dir) = dirs::config_dir() {
            let legacy = config_dir.join(package_name).join(CONFIGURATION_FILE_NAME);
            if legacy != app_data_dir.join(CONFIGURATION_FILE_NAME) {
                paths.push(legacy);
            }
        }
    }

    paths
}

fn app_data_dir_with_fallback<R: Runtime>(app_handle: &tauri::AppHandle<R>) -> PathBuf {
    let package_name = env!("CARGO_PKG_NAME");
    app_handle
        .path()
        .data_dir()
        .unwrap_or_else(|err| {
            log::error!("Failed to get data directory: {err}. Using home directory instead.");

            let home_dir = std::env::var("HOME").expect("Failed to determine the home directory");

            PathBuf::from(home_dir)
        })
        .join(package_name)
}

/// Resolve the BiBit config file path without an AppHandle (for CLI use).
/// Canonical location is `%APPDATA%/BiBit/settings.json` (or OS equivalent),
/// with fallback recovery from bundle-id location when needed.
pub fn resolve_config_file_path() -> PathBuf {
    let app_data = resolve_human_readable_app_data_dir().unwrap_or_else(|| {
        let package_name = env!("CARGO_PKG_NAME");
        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .unwrap_or_default();
        PathBuf::from(home).join(package_name)
    });

    if let Err(err) = migrate_legacy_app_configuration(&app_data) {
        log::warn!("Legacy app config migration (CLI) skipped: {err}");
    }

    app_data.join(CONFIGURATION_FILE_NAME)
}

/// Resolve the Jan data folder path without an AppHandle (for CLI use).
/// Reads AppConfiguration from the config file; falls back to the default location.
pub fn resolve_jan_data_folder() -> PathBuf {
    // Explicit override wins on every platform. `dirs::data_dir()` reads
    // XDG_DATA_HOME only on Linux, so tests/headless consumers need a portable
    // way to redirect the data folder without relying on OS-specific env.
    if let Ok(folder) = std::env::var("JAN_DATA_FOLDER") {
        if !folder.is_empty() {
            return PathBuf::from(folder);
        }
    }

    let config_file = resolve_config_file_path();

    if config_file.exists() {
        if let Ok(content) = fs::read_to_string(&config_file) {
            if let Ok(config) = serde_json::from_str::<AppConfiguration>(&content) {
                return PathBuf::from(config.data_folder);
            }
        }
    }

    // Default: data_dir/BiBit/data  (mirrors default_data_folder_path)
    let app_name = std::env::var("APP_NAME").unwrap_or_else(|_| "BiBit".to_string());
    if let Some(data_dir) = dirs::data_dir() {
        return data_dir.join(&app_name).join("data");
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default();
    PathBuf::from(home).join(&app_name).join("data")
}

#[tauri::command]
pub fn get_app_configurations<R: Runtime>(app_handle: tauri::AppHandle<R>) -> AppConfiguration {
    let mut app_default_configuration = AppConfiguration::default();

    if std::env::var("CI").unwrap_or_default() == "e2e" {
        return app_default_configuration;
    }

    let app_path = app_data_dir_with_fallback(&app_handle);
    if let Err(err) = migrate_legacy_app_configuration(&app_path) {
        log::warn!("Legacy app config migration skipped: {err}");
    }

    let configuration_file = app_path.join(CONFIGURATION_FILE_NAME);

    let default_data_folder = default_data_folder_path(app_handle.clone());

    if !configuration_file.exists() {
        log::info!("App config not found, creating default config at {configuration_file:?}");

        app_default_configuration.data_folder = default_data_folder;

        if let Err(err) = fs::write(
            &configuration_file,
            serde_json::to_string(&app_default_configuration).unwrap(),
        ) {
            log::error!("Failed to create default config: {err}");
        }

        return app_default_configuration;
    }

    match fs::read_to_string(&configuration_file) {
        Ok(content) => {
            match serde_json::from_str::<AppConfiguration>(&content) {
                Ok(app_configurations) => app_configurations,
                Err(err) => {
                    log::error!("Failed to parse app config, returning default config instead. Error: {err}");
                    // Use the proper default data folder path, not the relative "./data"
                    app_default_configuration.data_folder = default_data_folder;
                    app_default_configuration
                }
            }
        }
        Err(err) => {
            log::error!(
                "Failed to read app config, returning default config instead. Error: {err}"
            );
            // Use the proper default data folder path, not the relative "./data"
            app_default_configuration.data_folder = default_data_folder;
            app_default_configuration
        }
    }
}

#[tauri::command]
pub fn update_app_configuration<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    configuration: AppConfiguration,
) -> Result<(), String> {
    let configuration_file = get_configuration_file_path(app_handle);
    log::info!("update_app_configuration, configuration_file: {configuration_file:?}");

    fs::write(
        configuration_file,
        serde_json::to_string(&configuration).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_jan_data_folder_path<R: Runtime>(app_handle: tauri::AppHandle<R>) -> PathBuf {
    if cfg!(test) {
        use std::cell::RefCell;
        thread_local! {
            static TEST_DATA_DIR: RefCell<Option<PathBuf>> = const { RefCell::new(None) };
        }

        return TEST_DATA_DIR.with(|dir| {
            let mut dir = dir.borrow_mut();
            if dir.is_none() {
                let unique_id = std::thread::current().id();
                let timestamp = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0);
                let path = std::env::current_dir()
                    .unwrap_or_else(|_| PathBuf::from("."))
                    .join(format!("test-data-{unique_id:?}-{timestamp}"));
                let _ = fs::create_dir_all(&path);
                *dir = Some(path);
            }
            dir.clone().unwrap()
        });
    }

    let app_configurations = get_app_configurations(app_handle);
    PathBuf::from(app_configurations.data_folder)
}

#[tauri::command]
pub fn get_configuration_file_path<R: Runtime>(app_handle: tauri::AppHandle<R>) -> PathBuf {
    let app_path = app_data_dir_with_fallback(&app_handle);
    if let Err(err) = migrate_legacy_app_configuration(&app_path) {
        log::warn!("Legacy app config migration skipped: {err}");
    }
    app_path.join(CONFIGURATION_FILE_NAME)
}

#[tauri::command]
pub fn default_data_folder_path<R: Runtime>(app_handle: tauri::AppHandle<R>) -> String {
    let mut path = app_handle.path().data_dir().unwrap_or_else(|err| {
        log::error!("Failed to get data directory: {err}. Falling back to home directory.");
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
        PathBuf::from(home)
    });

    let app_name = std::env::var("APP_NAME")
        .unwrap_or_else(|_| app_handle.config().product_name.clone().unwrap());
    path.push(app_name);
    path.push("data");

    let mut path_str = path.to_string_lossy().into_owned();

    if let Some(stripped) = path_str.strip_suffix(".ai.app") {
        path_str = stripped.to_string();
    }

    path_str
}



#[tauri::command]
pub fn app_token(state: State<'_, AppState>) -> Option<String> {
    state.app_token.clone()
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseDocument {
    name: &'static str,
    content: &'static str,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryInformation {
    product_version: String,
    build_version: &'static str,
    notice: &'static str,
    licenses: Vec<LicenseDocument>,
    third_party_manifest: &'static str,
}

fn embedded_delivery_information(product_version: String) -> DeliveryInformation {
    DeliveryInformation {
        product_version: product_version.replace("1.0.0-beta.1", "1.0Beta1"),
        build_version: option_env!("BIBIT_BUILD_VERSION")
            .filter(|value| !value.is_empty())
            .unwrap_or("development"),
        notice: include_str!("../../../resources/NOTICE"),
        licenses: vec![
            LicenseDocument {
                name: "Apache-2.0",
                content: include_str!("../../../resources/LICENSE"),
            },
            LicenseDocument {
                name: "MIT",
                content: include_str!("../../../resources/LICENSES/MIT.txt"),
            },
            LicenseDocument {
                name: "AGPL-3.0",
                content: include_str!("../../../resources/LICENSES/AGPL-3.0.txt"),
            },
        ],
        third_party_manifest: include_str!("../../../../LICENSES/THIRD-PARTY.json"),
    }
}

#[tauri::command]
pub fn get_delivery_information<R: Runtime>(app: AppHandle<R>) -> DeliveryInformation {
    embedded_delivery_information(app.package_info().version.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use tempfile::tempdir;

    #[test]
    fn delivery_information_uses_public_beta_label() {
        let information = embedded_delivery_information("1.0.0-beta.1".to_string());
        assert_eq!(information.product_version, "1.0Beta1");
    }

    #[test]
    fn delivery_information_embeds_distributed_license_material() {
        let information = embedded_delivery_information("0.1.3".to_string());
        let manifest: Value = serde_json::from_str(information.third_party_manifest)
            .expect("third-party manifest is valid JSON");

        assert_eq!(information.product_version, "0.1.3");
        assert!(!information.build_version.is_empty());
        assert!(information.notice.contains("BiBit GUI"));
        assert_eq!(information.licenses.len(), 3);
        assert!(manifest["javascript"]
            .as_array()
            .is_some_and(|items| !items.is_empty()));
        assert!(manifest["rust"]
            .as_array()
            .is_some_and(|items| !items.is_empty()));
    }

    #[test]
    fn migration_recovers_legacy_then_removes_stale_copy() {
        let tmp = tempdir().expect("temp dir");
        let canonical_dir = tmp.path().join("Jan");
        let canonical = canonical_dir.join(CONFIGURATION_FILE_NAME);
        let legacy = tmp.path().join("jan.ai.app").join(CONFIGURATION_FILE_NAME);

        fs::create_dir_all(legacy.parent().unwrap()).expect("create legacy dir");
        fs::write(&legacy, r#"{"data_folder":"D:\\jan.ai"}"#).expect("write legacy config");

        migrate_from_candidates(&canonical, vec![legacy.clone()]).expect("migration succeeds");

        let recovered = fs::read_to_string(&canonical).expect("read canonical");
        assert!(
            recovered.contains(r#""data_folder":"D:\\jan.ai""#),
            "settings must be preserved in the canonical location"
        );
        assert!(
            !legacy.exists(),
            "stale legacy copy must be removed after recovery"
        );
    }

    #[test]
    fn migration_skips_when_canonical_exists() {
        let tmp = tempdir().expect("temp dir");
        let canonical_dir = tmp.path().join("Jan");
        let canonical = canonical_dir.join(CONFIGURATION_FILE_NAME);
        let legacy = tmp.path().join("jan.ai.app").join(CONFIGURATION_FILE_NAME);

        fs::create_dir_all(canonical.parent().unwrap()).expect("create canonical dir");
        fs::create_dir_all(legacy.parent().unwrap()).expect("create legacy dir");
        fs::write(&canonical, r#"{"data_folder":"D:\\kept"}"#).expect("write canonical config");
        fs::write(&legacy, r#"{"data_folder":"D:\\legacy"}"#).expect("write legacy config");

        migrate_legacy_app_configuration(&canonical_dir).expect("migration succeeds");

        let current = fs::read_to_string(&canonical).expect("read canonical");
        assert!(current.contains(r#""data_folder":"D:\\kept""#));
    }

    #[test]
    fn migration_handles_missing_legacy_files() {
        let tmp = tempdir().expect("temp dir");
        let canonical = tmp.path().join("Jan").join(CONFIGURATION_FILE_NAME);
        let missing = tmp.path().join("missing").join(CONFIGURATION_FILE_NAME);

        migrate_from_candidates(&canonical, vec![missing]).expect("migration succeeds");
        assert!(!canonical.exists(), "canonical should remain absent");
    }

    #[test]
    fn product_identity_matches_bibit_configuration() {
        let conf_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tauri.conf.json");
        let content = fs::read_to_string(conf_path).expect("read tauri.conf.json");
        let json: Value = serde_json::from_str(&content).expect("parse tauri.conf.json");
        let product_name = json
            .get("productName")
            .and_then(|v| v.as_str())
            .expect("productName field exists");
        let identifier = json
            .get("identifier")
            .and_then(|v| v.as_str())
            .expect("identifier field exists");

        assert_eq!(product_name, "BiBit");
        assert_eq!(env!("CARGO_PKG_NAME"), "BiBit");
        assert_eq!(
            identifier, TAURI_BUNDLE_IDENTIFIER,
            "TAURI_BUNDLE_IDENTIFIER must stay synced with tauri.conf.json"
        );
    }
}
