use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::OnceLock;

const SYSTEM_GRANTS_DIR: &str = "/etc/bibit/feature-capability-grants.d";
const COMPILED_GRANTS: &[u8] = include_bytes!("../../config/feature-capability-grants.json");
static RUNTIME_GRANTS: OnceLock<FeatureCapabilityGrants> = OnceLock::new();

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct FeatureCapabilityGrants {
    pub version: u8,
    pub features: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    pub service_operations: BTreeMap<String, BTreeMap<String, Vec<String>>>,
}

pub(crate) fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.as_bytes()[0].is_ascii_lowercase()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        && !value.ends_with('-')
        && !value.contains("--")
}

pub(crate) fn valid_operation(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        && value.contains('.')
}

/// Business operation names may carry a trailing `.v<digits>` release suffix.
/// The suffix is an alias only: it selects the same implementation, so grants
/// are stored canonically while every existing spelling keeps working.
///
/// Mirror: `canonicalOperationId` in `packages/feature-contracts/src/operation-id.ts`.
/// Both sides are pinned by `tests/fixtures/operation-alias-conformance/cases.json`.
pub(crate) fn canonical_operation(operation_id: &str) -> &str {
    let Some((head, suffix)) = operation_id.rsplit_once('.') else {
        return operation_id;
    };
    let digits = suffix.strip_prefix('v').unwrap_or_default();
    if !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit()) {
        head
    } else {
        operation_id
    }
}

fn capability_service_id(capability: &str) -> Option<&str> {
    capability.strip_prefix("service:")
}

pub(crate) fn legacy_service_capability(service_id: &str) -> Option<&'static str> {
    match service_id {
        "store" => Some("external-service:store"),
        "memory" => Some("external-service:memory"),
        "security" => Some("external-service:security"),
        _ => None,
    }
}

pub(crate) fn valid_capability(value: &str) -> bool {
    capability_service_id(value).is_some_and(valid_id)
        || matches!(
            value,
            "external-service:store"
                | "external-service:memory"
                | "external-service:security"
                | "runtime:permission"
                | "file:transfer"
                | "job:manage"
                | "host:actions"
        )
}

fn parse_grants(source: &[u8]) -> Result<FeatureCapabilityGrants, String> {
    let grants: FeatureCapabilityGrants = serde_json::from_slice(source)
        .map_err(|_| "Invalid feature capability grants".to_string())?;
    if grants.version != 1 {
        return Err("Unsupported feature capability grants version".into());
    }
    for (feature_id, capabilities) in &grants.features {
        if !valid_id(feature_id)
            || capabilities.iter().any(|value| !valid_capability(value))
            || capabilities.iter().collect::<BTreeSet<_>>().len() != capabilities.len()
        {
            return Err("Invalid feature capability grant".into());
        }
    }
    for (feature_id, services) in &grants.service_operations {
        let capabilities = grants
            .features
            .get(feature_id)
            .ok_or_else(|| "Service operations require feature capabilities".to_string())?;
        for (service_id, operations) in services {
            if !valid_id(feature_id)
                || !valid_id(service_id)
                || !capabilities
                    .iter()
                    .any(|capability| capability == &format!("service:{service_id}"))
                || operations.iter().any(|value| !valid_operation(value))
                || operations.iter().collect::<BTreeSet<_>>().len() != operations.len()
            {
                return Err("Invalid feature service operation grant".into());
            }
        }
    }
    Ok(grants)
}

fn merge(target: &mut FeatureCapabilityGrants, source: FeatureCapabilityGrants) {
    for (feature_id, capabilities) in source.features {
        let target_capabilities = target.features.entry(feature_id).or_default();
        target_capabilities.extend(capabilities);
        target_capabilities.sort();
        target_capabilities.dedup();
    }
    for (feature_id, services) in source.service_operations {
        let target_services = target.service_operations.entry(feature_id).or_default();
        for (service_id, operations) in services {
            let target_operations = target_services.entry(service_id).or_default();
            target_operations.extend(operations);
            target_operations.sort();
            target_operations.dedup();
        }
    }
}

fn load_grants(directory: &Path) -> FeatureCapabilityGrants {
    let mut merged = FeatureCapabilityGrants {
        version: 1,
        ..Default::default()
    };
    let Ok(entries) = std::fs::read_dir(directory) else {
        return merged;
    };
    let mut paths = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "json")
        })
        .collect::<Vec<_>>();
    paths.sort();
    for path in paths {
        match std::fs::read(&path)
            .map_err(|_| "Unable to read feature capability grants".to_string())
            .and_then(|source| parse_grants(&source))
        {
            Ok(grants) => merge(&mut merged, grants),
            Err(error) => log::warn!(
                "feature_capabilities.grants_invalid path={} error={error}",
                path.display()
            ),
        }
    }
    merged
}

fn grants_directory() -> std::path::PathBuf {
    #[cfg(debug_assertions)]
    let directory = std::env::var_os("BIBIT_FEATURE_CAPABILITY_GRANTS_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| SYSTEM_GRANTS_DIR.into());
    #[cfg(not(debug_assertions))]
    let directory = std::path::PathBuf::from(SYSTEM_GRANTS_DIR);
    directory
}

fn load_runtime_grants() -> FeatureCapabilityGrants {
    let mut grants = parse_grants(COMPILED_GRANTS).unwrap_or_else(|error| {
        log::error!("feature_capabilities.compiled_grants_invalid error={error}");
        FeatureCapabilityGrants {
            version: 1,
            ..Default::default()
        }
    });
    merge(&mut grants, load_grants(&grants_directory()));
    grants
}

pub(crate) fn runtime_grants() -> &'static FeatureCapabilityGrants {
    RUNTIME_GRANTS.get_or_init(load_runtime_grants)
}

pub(crate) fn grants_allow(
    grants: &FeatureCapabilityGrants,
    feature_id: &str,
    service_id: &str,
    operation_id: &str,
    required_capability: &str,
) -> bool {
    let Some(capabilities) = grants.features.get(feature_id) else {
        return false;
    };
    capabilities
        .iter()
        .any(|value| value == required_capability)
        && capabilities
            .iter()
            .any(|value| value == &format!("service:{service_id}"))
        && grants
            .service_operations
            .get(feature_id)
            .and_then(|services| services.get(service_id))
            .is_some_and(|operations| {
                operations.iter().any(|value| {
                    canonical_operation(value) == canonical_operation(operation_id)
                })
            })
}

pub(crate) fn runtime_grants_allow(
    feature_id: &str,
    service_id: &str,
    operation_id: &str,
    required_capability: &str,
) -> bool {
    grants_allow(
        runtime_grants(),
        feature_id,
        service_id,
        operation_id,
        required_capability,
    )
}

pub(crate) fn runtime_service_capabilities_allow(
    feature_id: &str,
    service_id: &str,
    required_capability: &str,
) -> bool {
    let grants = runtime_grants();
    grants.features.get(feature_id).is_some_and(|capabilities| {
        capabilities
            .iter()
            .any(|value| value == required_capability)
            && capabilities
                .iter()
                .any(|value| value == &format!("service:{service_id}"))
    })
}

pub(crate) fn runtime_service_operations(
    feature_id: &str,
    service_id: &str,
) -> Option<&'static [String]> {
    runtime_grants()
        .service_operations
        .get(feature_id)
        .and_then(|services| services.get(service_id))
        .map(Vec::as_slice)
}

#[tauri::command]
pub fn feature_capability_grants_list() -> FeatureCapabilityGrants {
    runtime_grants().clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    // The TypeScript mirror reads the same file, so a rule that lands on only one
    // side fails there instead of silently diverging in production.
    const OPERATION_ALIAS_CASES: &str =
        include_str!("../../tests/fixtures/operation-alias-conformance/cases.json");

    #[test]
    fn operation_alias_matches_the_shared_conformance_cases() {
        let cases: serde_json::Value =
            serde_json::from_str(OPERATION_ALIAS_CASES).expect("operation alias cases parse");
        let cases = cases["cases"].as_array().expect("cases array");
        assert!(
            cases.len() >= 10,
            "expected the shared operation alias case set"
        );
        for case in cases {
            let operation = case["operation"].as_str().unwrap_or_default();
            let canonical = case["canonical"].as_str().unwrap_or_default();
            assert_eq!(
                canonical_operation(operation),
                canonical,
                "conformance case {operation}"
            );
        }
    }

    #[test]
    fn grants_allow_either_spelling_of_an_operation() {
        let grants = parse_grants(
            br#"{"version":1,"features":{"agent-hub":["service:store"]},"serviceOperations":{"agent-hub":{"store":["agents.list.v1"]}}}"#,
        )
        .unwrap();

        assert!(grants_allow(
            &grants,
            "agent-hub",
            "store",
            "agents.list.v1",
            "service:store"
        ));
        assert!(grants_allow(
            &grants,
            "agent-hub",
            "store",
            "agents.list",
            "service:store"
        ));
        assert!(!grants_allow(
            &grants,
            "agent-hub",
            "store",
            "agents.get",
            "service:store"
        ));
    }

    #[test]
    fn accepts_file_transfer_and_job_capabilities() {
        let grants = parse_grants(
            br#"{"version":1,"features":{"agent-hub":["service:store","file:transfer","job:manage"]},"serviceOperations":{"agent-hub":{"store":["agents.upload.v1","agents.download.v1"]}}}"#,
        )
        .unwrap();

        assert_eq!(
            grants.features["agent-hub"],
            ["service:store", "file:transfer", "job:manage"]
        );
        assert!(grants_allow(
            &grants,
            "agent-hub",
            "store",
            "agents.upload.v1",
            "file:transfer"
        ));
        assert!(!grants_allow(
            &grants,
            "agent-hub",
            "store",
            "agents.upload.v1",
            "runtime:permission"
        ));
    }

    #[test]
    fn compiled_grants_are_native_authorization_inputs() {
        let grants = parse_grants(COMPILED_GRANTS).unwrap();

        assert!(grants_allow(
            &grants,
            "agent-hub",
            "store",
            "agents.list.v1",
            "service:store"
        ));
        assert!(!grants_allow(
            &grants,
            "agent-hub",
            "store",
            "agents.delete.v1",
            "service:store"
        ));
    }

    #[test]
    fn runtime_grants_are_cached_for_the_process() {
        assert!(std::ptr::eq(runtime_grants(), runtime_grants()));
    }

    #[test]
    fn merges_valid_drop_ins_and_isolates_invalid_files() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(
            directory.path().join("10-agent-hub.json"),
            r#"{"version":1,"features":{"agent-hub":["service:store"]},"serviceOperations":{"agent-hub":{"store":["agents.list.v1"]}}}"#,
        )
        .unwrap();
        std::fs::write(
            directory.path().join("20-agent-hub.json"),
            r#"{"version":1,"features":{"agent-hub":["service:store"]},"serviceOperations":{"agent-hub":{"store":["settings.get.v1"]}}}"#,
        )
        .unwrap();
        std::fs::write(directory.path().join("broken.json"), b"not-json").unwrap();

        let grants = load_grants(directory.path());

        assert_eq!(grants.features["agent-hub"], ["service:store"]);
        assert_eq!(
            grants.service_operations["agent-hub"]["store"],
            ["agents.list.v1", "settings.get.v1"]
        );
    }
}
