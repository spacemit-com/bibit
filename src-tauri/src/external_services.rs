use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tauri::WebviewWindow;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{oneshot, Mutex};
use tokio_util::sync::CancellationToken;
use url::Url;

mod actor;
use actor::{ProviderConfig, ProviderHandle};

#[cfg(all(test, unix))]
mod actor_tests;

const PROTOCOL_VERSION: u8 = 1;
const PROVIDER_PROTOCOL_V2: u8 = 2;
const JOB_CANCEL_TIMEOUT: Duration = Duration::from_secs(2);
const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const MAX_TIMEOUT_MS: u64 = 300_000;
const MAX_REQUEST_BYTES: usize = 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const MAX_PENDING_V2_REQUESTS: usize = 128;
const REGISTRY_FILE: &str = "external-service-connections.json";
const SYSTEM_REGISTRY_DIR: &str = "/etc/bibit/external-services.d";
const PROVIDER_PROTOCOL_NAME: &str = "bibit-provider";

static HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
static ACTIVE_REQUESTS: OnceLock<Mutex<BTreeMap<ActiveRequestKey, ActiveServiceRequest>>> =
    OnceLock::new();
static MANAGED_PROVIDERS: OnceLock<Mutex<BTreeMap<String, Arc<ManagedProvider>>>> = OnceLock::new();

fn active_requests() -> &'static Mutex<BTreeMap<ActiveRequestKey, ActiveServiceRequest>> {
    ACTIVE_REQUESTS.get_or_init(|| Mutex::new(BTreeMap::new()))
}

fn managed_providers() -> &'static Mutex<BTreeMap<String, Arc<ManagedProvider>>> {
    MANAGED_PROVIDERS.get_or_init(|| Mutex::new(BTreeMap::new()))
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalServiceGatewayRequest {
    pub protocol_version: u8,
    pub request_id: String,
    pub service_id: String,
    pub operation_id: String,
    pub params: Value,
    pub timeout_ms: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FeatureServiceCommandRequest {
    feature_id: String,
    plugin_version: String,
    feature_instance_token: String,
    protocol_version: u8,
    request_id: String,
    service_id: String,
    operation_id: String,
    params: Value,
    timeout_ms: u64,
}

impl FeatureServiceCommandRequest {
    fn owner(&self) -> ServiceRequestOwner {
        ServiceRequestOwner {
            feature_id: self.feature_id.clone(),
            plugin_version: self.plugin_version.clone(),
            feature_instance_token: self.feature_instance_token.clone(),
        }
    }

    fn gateway_request(&self) -> ExternalServiceGatewayRequest {
        ExternalServiceGatewayRequest {
            protocol_version: self.protocol_version,
            request_id: self.request_id.clone(),
            service_id: self.service_id.clone(),
            operation_id: self.operation_id.clone(),
            params: self.params.clone(),
            timeout_ms: self.timeout_ms,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FeatureServiceCancelCommandRequest {
    feature_id: String,
    plugin_version: String,
    feature_instance_token: String,
    service_id: String,
    operation_id: String,
    request_id: String,
}

impl FeatureServiceCancelCommandRequest {
    fn owner(&self) -> ServiceRequestOwner {
        ServiceRequestOwner {
            feature_id: self.feature_id.clone(),
            plugin_version: self.plugin_version.clone(),
            feature_instance_token: self.feature_instance_token.clone(),
        }
    }
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct ServiceRequestOwner {
    feature_id: String,
    plugin_version: String,
    feature_instance_token: String,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct ActiveRequestKey {
    owner: ServiceRequestOwner,
    request_id: String,
}

#[derive(Clone)]
struct ActiveServiceRequest {
    service_id: String,
    operation_id: String,
    cancellation: CancellationToken,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalServiceGatewayError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalServiceGatewayResponse {
    pub protocol_version: u8,
    pub request_id: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ExternalServiceGatewayError>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawConnectionRegistry {
    version: u8,
    services: BTreeMap<String, RawConnection>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawConnection {
    /// Top-level business credential strings, scoped to an operation.
    #[serde(default)]
    credential_parameters: BTreeMap<String, Vec<String>>,
    /// Exact JSON Pointer paths for quota objects, scoped to an operation.
    #[serde(default)]
    business_object_parameters: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    transport: Option<String>,
    #[serde(default)]
    base_url: Option<String>,
    #[serde(default)]
    executable: Option<PathBuf>,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    lifecycle: Option<String>,
    #[serde(default)]
    protocol_versions: Vec<u8>,
    #[serde(default)]
    auth_ref: Option<String>,
    #[serde(default)]
    request_timeout_ms: Option<u64>,
}

#[derive(Debug)]
struct ConnectionRegistry {
    services: BTreeMap<String, Connection>,
}

#[derive(Debug)]
struct Connection {
    transport: ProviderTransport,
    request_timeout_ms: u64,
    credential_parameters: BTreeMap<String, Vec<String>>,
    business_object_parameters: BTreeMap<String, Vec<String>>,
}

#[derive(Clone, Debug)]
enum ProviderTransport {
    Http {
        base_url: Url,
        auth_ref: Option<String>,
    },
    Stdio {
        executable: PathBuf,
        args: Vec<String>,
        lifecycle: StdioLifecycle,
        protocol_versions: Vec<u8>,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum StdioLifecycle {
    OneShot,
    Managed,
}

struct ManagedProvider {
    config: ProviderConfig,
    transport: ProviderHandle,
    driver: Option<Arc<ManagedV2Driver>>,
}

#[derive(Clone)]
struct ManagedSessionV2 {
    driver: Arc<ManagedV2Driver>,
    operations: Vec<String>,
    deadline: tokio::time::Instant,
}

struct ManagedV2Driver {
    service_id: String,
    transport: ProviderHandle,
    active_jobs: Mutex<BTreeSet<String>>,
    provider_sequences: Mutex<BTreeMap<String, u64>>,
    cancel_waiters: Mutex<BTreeMap<String, oneshot::Sender<()>>>,
    jobs: Arc<crate::feature_service_jobs::FeatureServiceJobRegistry>,
}

#[derive(Serialize)]
struct JsonRpcRequest<T> {
    jsonrpc: &'static str,
    id: String,
    method: &'static str,
    params: T,
}

#[derive(Deserialize)]
struct JsonRpcResponse {
    jsonrpc: String,
    id: Value,
    #[serde(default)]
    result: Option<Value>,
    #[serde(default)]
    error: Option<JsonRpcError>,
}

#[derive(Deserialize)]
struct JsonRpcError {
    #[allow(dead_code)]
    code: i64,
    #[allow(dead_code)]
    message: String,
    #[serde(default)]
    data: Option<ProviderErrorData>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderErrorData {
    #[serde(default)]
    code: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderInitializeResult {
    protocol_version: u8,
    provider_version: String,
    capabilities: ProviderCapabilities,
    operations: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderCapabilities {
    invoke: bool,
    #[serde(default)]
    jobs: bool,
    #[serde(default)]
    cancellation: bool,
    #[serde(default)]
    max_concurrent_jobs: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProviderJobEventParams {
    service_id: String,
    job_id: String,
    provider_sequence: u64,
    kind: ProviderJobEventKind,
    #[serde(default)]
    progress: Option<ProviderJobProgress>,
    #[serde(default)]
    result: Option<Value>,
    #[serde(default)]
    error: Option<ProviderJobFailure>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
enum ProviderJobEventKind {
    Progress,
    ResultReady,
    Cancelled,
    Failed,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProviderJobProgress {
    completed_bytes: u64,
    #[serde(default)]
    total_bytes: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProviderJobFailure {
    code: String,
    message: String,
    #[serde(default)]
    retryable: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProviderDownloadResource {
    resource_path: String,
    byte_length: u64,
    sha256: String,
}

fn valid_service_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.as_bytes()[0].is_ascii_lowercase()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-'))
        && !value.ends_with('-')
        && !value.contains("--")
}

fn valid_operation_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        && value.bytes().any(|byte| byte == b'.')
}

fn forbidden_transport_key(key: &str) -> bool {
    let normalized = key.to_ascii_lowercase().replace(['-', '_'], "");
    matches!(
        normalized.as_str(),
        "authorization"
            | "header"
            | "headers"
            | "token"
            | "tokens"
            | "apikey"
            | "cookie"
            | "cookies"
            | "credential"
            | "credentials"
            | "secret"
            | "secrets"
            | "password"
            | "url"
    )
}

fn validate_and_encode_request(
    request: &ExternalServiceGatewayRequest,
) -> Result<Vec<u8>, &'static str> {
    if request.protocol_version != PROTOCOL_VERSION
        || request.request_id.is_empty()
        || request.request_id.len() > 128
        || !valid_service_id(&request.service_id)
        || !valid_operation_id(&request.operation_id)
        || !request.params.is_object()
        || request.timeout_ms == 0
        || request.timeout_ms > MAX_TIMEOUT_MS
    {
        return Err("incompatible");
    }
    let bytes = serde_json::to_vec(request).map_err(|_| "incompatible")?;
    if bytes.len() > MAX_REQUEST_BYTES {
        return Err("incompatible");
    }
    Ok(bytes)
}

fn validate_business_parameters(
    request: &ExternalServiceGatewayRequest,
    connection: &Connection,
) -> bool {
    fn visit(value: &Value, path: &str, credentials: &[String], objects: &[String]) -> bool {
        match value {
            Value::Array(values) => values.iter().enumerate().all(|(index, nested)| {
                visit(nested, &format!("{path}/{index}"), credentials, objects)
            }),
            Value::Object(values) => values.iter().all(|(key, nested)| {
                if path.is_empty() && credentials.contains(key) {
                    return nested.is_string();
                }
                // JSON Pointer escaping prevents a key containing '/' from
                // impersonating a sequence of nested policy path components.
                let component = key.replace('~', "~0").replace('/', "~1");
                let nested_path = format!("{path}/{component}");
                let business_object = objects.contains(&nested_path);
                if business_object && !nested.is_object() {
                    return false;
                }
                (!forbidden_transport_key(key) || business_object)
                    && visit(nested, &nested_path, credentials, objects)
            }),
            _ => true,
        }
    }
    request.params.is_object()
        && visit(
            &request.params,
            "",
            operation_policy(&connection.credential_parameters, &request.operation_id),
            operation_policy(
                &connection.business_object_parameters,
                &request.operation_id,
            ),
        )
}

/// Connection policy is keyed by operation name. An exact key wins, otherwise the
/// first key naming the same operation is used, so policy declared as
/// `agents.create.v1` still covers a request for `agents.create` and vice versa.
fn operation_policy<'a>(
    policy: &'a BTreeMap<String, Vec<String>>,
    operation_id: &str,
) -> &'a [String] {
    if let Some(values) = policy.get(operation_id) {
        return values;
    }
    policy
        .iter()
        .find(|(declared, _)| {
            crate::feature_capabilities::canonical_operation(declared)
                == crate::feature_capabilities::canonical_operation(operation_id)
        })
        .map(|(_, values)| values.as_slice())
        .unwrap_or(&[])
}

fn valid_business_object_path(path: &str) -> bool {
    // Only plural tokens is ambiguous between credentials and quota objects.
    // Transport headers and singular credential fields cannot be exempted.
    path.len() <= 512
        && path.starts_with('/')
        && path.ends_with("/tokens")
        && path[1..].split('/').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        })
}

fn parse_registry(source: &[u8]) -> Result<ConnectionRegistry, String> {
    let raw: RawConnectionRegistry = serde_json::from_slice(source)
        .map_err(|_| "Invalid external service registry".to_string())?;
    if !matches!(raw.version, 1 | 2) {
        return Err("Unsupported external service registry version".into());
    }
    let mut services = BTreeMap::new();
    for (service_id, raw_connection) in raw.services {
        if !valid_service_id(&service_id) {
            return Err("Invalid external service id".into());
        }
        for (operation, fields) in &raw_connection.credential_parameters {
            if !valid_operation_id(operation)
                || fields.iter().any(|field| {
                    !matches!(
                        field.as_str(),
                        "api_key" | "apiKey" | "token" | "password" | "secret"
                    )
                })
            {
                return Err("Invalid business credential parameter policy".into());
            }
        }
        for (operation, paths) in &raw_connection.business_object_parameters {
            if !valid_operation_id(operation)
                || paths.iter().any(|path| !valid_business_object_path(path))
            {
                return Err("Invalid business object parameter policy".into());
            }
        }
        let request_timeout_ms = raw_connection
            .request_timeout_ms
            .unwrap_or(DEFAULT_TIMEOUT_MS);
        if request_timeout_ms == 0 || request_timeout_ms > MAX_TIMEOUT_MS {
            return Err("Invalid external service timeout".into());
        }
        if raw_connection
            .auth_ref
            .as_ref()
            .is_some_and(|value| value.is_empty() || value.len() > 128)
        {
            return Err("Invalid external service auth reference".into());
        }
        let transport_name = raw_connection.transport.as_deref().unwrap_or("http");
        let transport = match transport_name {
            "http" => {
                let base_url = raw_connection
                    .base_url
                    .as_deref()
                    .ok_or_else(|| "Missing external service URL".to_string())
                    .and_then(|value| {
                        Url::parse(value).map_err(|_| "Invalid external service URL".to_string())
                    })?;
                if !matches!(base_url.scheme(), "http" | "https")
                    || !base_url.username().is_empty()
                    || base_url.password().is_some()
                    || base_url.query().is_some()
                    || base_url.fragment().is_some()
                    || raw_connection.executable.is_some()
                    || !raw_connection.args.is_empty()
                    || raw_connection.lifecycle.is_some()
                    || !raw_connection.protocol_versions.is_empty()
                {
                    return Err("Invalid HTTP provider configuration".into());
                }
                ProviderTransport::Http {
                    base_url,
                    auth_ref: raw_connection.auth_ref,
                }
            }
            "stdio" if raw.version == 2 => {
                let executable = raw_connection
                    .executable
                    .ok_or_else(|| "Missing stdio provider executable".to_string())?;
                let lifecycle = match raw_connection.lifecycle.as_deref().unwrap_or("oneShot") {
                    "oneShot" => StdioLifecycle::OneShot,
                    "managed" => StdioLifecycle::Managed,
                    _ => return Err("Invalid stdio provider lifecycle".into()),
                };
                let valid_protocols = raw_connection.protocol_versions == [PROTOCOL_VERSION]
                    || (lifecycle == StdioLifecycle::Managed
                        && raw_connection.protocol_versions
                            == [PROTOCOL_VERSION, PROVIDER_PROTOCOL_V2]);
                if !executable.is_absolute()
                    || raw_connection.base_url.is_some()
                    || raw_connection.auth_ref.is_some()
                    || !valid_protocols
                    || raw_connection.args.len() > 32
                    || raw_connection
                        .args
                        .iter()
                        .any(|arg| arg.is_empty() || arg.len() > 512 || arg.contains('\0'))
                {
                    return Err("Invalid stdio provider configuration".into());
                }
                ProviderTransport::Stdio {
                    executable,
                    args: raw_connection.args,
                    lifecycle,
                    protocol_versions: raw_connection.protocol_versions,
                }
            }
            _ => return Err("Unsupported provider transport".into()),
        };
        services.insert(
            service_id,
            Connection {
                transport,
                request_timeout_ms,
                credential_parameters: raw_connection.credential_parameters,
                business_object_parameters: raw_connection.business_object_parameters,
            },
        );
    }
    Ok(ConnectionRegistry { services })
}

fn merge_registry_file(path: &Path, services: &mut BTreeMap<String, Connection>) {
    let source = match std::fs::read(path) {
        Ok(source) => source,
        Err(error) => {
            if error.kind() != std::io::ErrorKind::NotFound {
                log::warn!(
                    "external_service.registry_read_failed path={} error={error}",
                    path.display()
                );
            }
            return;
        }
    };
    let registry = match parse_registry(&source) {
        Ok(registry) => registry,
        Err(error) => {
            log::warn!(
                "external_service.registry_invalid path={} error={error}",
                path.display()
            );
            return;
        }
    };
    services.extend(registry.services);
}

fn load_registry_from_sources(
    system_dir: &Path,
    user_registry: &Path,
    debug_override: Option<&Path>,
) -> Result<ConnectionRegistry, String> {
    let mut services = BTreeMap::new();
    match std::fs::read_dir(system_dir) {
        Ok(entries) => {
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
                merge_registry_file(&path, &mut services);
            }
        }
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
            log::warn!(
                "external_service.registry_dir_read_failed path={} error={error}",
                system_dir.display()
            );
        }
        Err(_) => {}
    }
    merge_registry_file(user_registry, &mut services);
    if let Some(path) = debug_override {
        merge_registry_file(path, &mut services);
    }
    if services.is_empty() {
        return Err("External service registry is unavailable".to_string());
    }
    Ok(ConnectionRegistry { services })
}

// Synchronous tests can supply isolated registry sources without changing
// process-wide environment variables or reading installed host providers.
#[cfg(test)]
thread_local! {
    static TEST_SYSTEM_REGISTRY: std::cell::RefCell<Option<PathBuf>> = const {
        std::cell::RefCell::new(None)
    };
}

#[cfg(test)]
pub(crate) struct TestRegistryScope(Option<PathBuf>);

#[cfg(test)]
impl Drop for TestRegistryScope {
    fn drop(&mut self) {
        TEST_SYSTEM_REGISTRY.with(|path| *path.borrow_mut() = self.0.take());
    }
}

#[cfg(test)]
pub(crate) fn isolated_registry_for_test(system_dir: &Path) -> TestRegistryScope {
    TestRegistryScope(TEST_SYSTEM_REGISTRY.with(|path| path.replace(Some(system_dir.to_owned()))))
}

fn load_registry(data_root: &Path) -> Result<ConnectionRegistry, String> {
    #[cfg(test)]
    if let Some(system_dir) = TEST_SYSTEM_REGISTRY.with(|path| path.borrow().clone()) {
        return load_registry_from_sources(&system_dir, &data_root.join(REGISTRY_FILE), None);
    }
    #[cfg(debug_assertions)]
    let debug_override = std::env::var_os("BIBIT_EXTERNAL_SERVICE_CONFIG").map(PathBuf::from);
    #[cfg(not(debug_assertions))]
    let debug_override: Option<PathBuf> = None;
    load_registry_from_sources(
        Path::new(SYSTEM_REGISTRY_DIR),
        &data_root.join(REGISTRY_FILE),
        debug_override.as_deref(),
    )
}

pub(crate) fn service_registry_contains(data_root: &Path, service_id: &str) -> bool {
    load_registry(data_root)
        .ok()
        .is_some_and(|registry| registry.services.contains_key(service_id))
}

fn error_message(code: &str) -> &'static str {
    match code {
        "cancelled" => "The service request was cancelled",
        "offline" => "The service is offline",
        "timeout" => "The service request timed out",
        "unauthorized" => "The service rejected authorization",
        "incompatible" => "The service request is incompatible",
        "unavailable" => "The service is unavailable",
        "provider_crashed" => "The service provider stopped unexpectedly",
        "resource_exhausted" => "The service request exceeded a resource limit",
        _ => "The service request failed",
    }
}

fn gateway_error(request_id: &str, code: &str) -> ExternalServiceGatewayResponse {
    ExternalServiceGatewayResponse {
        protocol_version: PROTOCOL_VERSION,
        request_id: request_id.to_string(),
        ok: false,
        result: None,
        error: Some(ExternalServiceGatewayError {
            code: code.to_string(),
            message: error_message(code).to_string(),
            retryable: matches!(
                code,
                "offline" | "timeout" | "unavailable" | "provider_crashed"
            ),
        }),
    }
}

fn map_status(status: reqwest::StatusCode) -> &'static str {
    match status.as_u16() {
        401 | 403 => "unauthorized",
        408 | 504 => "timeout",
        426 => "incompatible",
        502 | 503 => "unavailable",
        _ => "unknown",
    }
}

fn map_transport_error(error: &reqwest::Error) -> &'static str {
    if error.is_timeout() {
        "timeout"
    } else if error.is_connect() {
        "offline"
    } else {
        "unavailable"
    }
}

fn valid_response(response: &ExternalServiceGatewayResponse, request_id: &str) -> bool {
    response.protocol_version == PROTOCOL_VERSION
        && response.request_id == request_id
        && response.ok != response.error.is_some()
        && response.ok == response.result.is_some()
}

fn sanitize_provider_error(error: &JsonRpcError) -> &'static str {
    match error.data.as_ref().and_then(|data| data.code.as_deref()) {
        Some("cancelled") => "cancelled",
        Some("offline") => "offline",
        Some("timeout") => "timeout",
        Some("unauthorized") => "unauthorized",
        Some("incompatible") => "incompatible",
        Some("unavailable") => "unavailable",
        Some("provider_crashed") => "provider_crashed",
        Some("resource_exhausted") => "resource_exhausted",
        _ => "unknown",
    }
}

async fn forward_http(
    base_url: &Url,
    auth_ref: Option<&String>,
    timeout_ms: u64,
    request: &ExternalServiceGatewayRequest,
    request_bytes: Vec<u8>,
    cancellation: &CancellationToken,
) -> ExternalServiceGatewayResponse {
    let endpoint = match Url::parse(&format!(
        "{}/bibit/v1/invoke",
        base_url.as_str().trim_end_matches('/')
    )) {
        Ok(endpoint) => endpoint,
        Err(_) => return gateway_error(&request.request_id, "incompatible"),
    };
    let client = HTTP_CLIENT.get_or_init(reqwest::Client::new);
    let mut outgoing = client
        .post(endpoint)
        .timeout(Duration::from_millis(timeout_ms))
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(request_bytes);
    if let Some(auth_ref) = auth_ref {
        let auth_ref = auth_ref.clone();
        let token = tauri::async_runtime::spawn_blocking(move || {
            crate::core::server::provider_secrets::load_provider_keys(&auth_ref)
                .into_iter()
                .next()
        })
        .await
        .ok()
        .flatten();
        let Some(token) = token else {
            return gateway_error(&request.request_id, "unauthorized");
        };
        outgoing = outgoing.bearer_auth(token);
    }
    let response = match tokio::select! {
        _ = cancellation.cancelled() => return gateway_error(&request.request_id, "cancelled"),
        response = outgoing.send() => response,
    } {
        Ok(response) => response,
        Err(error) => return gateway_error(&request.request_id, map_transport_error(&error)),
    };
    if !response.status().is_success() {
        return gateway_error(&request.request_id, map_status(response.status()));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return gateway_error(&request.request_id, "resource_exhausted");
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    loop {
        let next = tokio::select! {
            _ = cancellation.cancelled() => return gateway_error(&request.request_id, "cancelled"),
            next = stream.next() => next,
        };
        let Some(chunk) = next else { break };
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(error) => {
                return gateway_error(&request.request_id, map_transport_error(&error));
            }
        };
        if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return gateway_error(&request.request_id, "resource_exhausted");
        }
        bytes.extend_from_slice(&chunk);
    }
    let parsed: ExternalServiceGatewayResponse = match serde_json::from_slice(&bytes) {
        Ok(parsed) => parsed,
        Err(_) => return gateway_error(&request.request_id, "incompatible"),
    };
    if !valid_response(&parsed, &request.request_id) {
        return gateway_error(&request.request_id, "incompatible");
    }
    if parsed.ok {
        parsed
    } else {
        let code = parsed
            .error
            .as_ref()
            .map(|error| error.code.as_str())
            .filter(|code| {
                matches!(
                    *code,
                    "cancelled"
                        | "offline"
                        | "timeout"
                        | "unauthorized"
                        | "incompatible"
                        | "unavailable"
                        | "provider_crashed"
                        | "resource_exhausted"
                        | "unknown"
                )
            })
            .unwrap_or("unknown");
        gateway_error(&request.request_id, code)
    }
}

async fn forward_stdio_one_shot(
    data_root: &Path,
    executable: &Path,
    args: &[String],
    timeout_ms: u64,
    request: &ExternalServiceGatewayRequest,
    cancellation: &CancellationToken,
) -> ExternalServiceGatewayResponse {
    let initialize_id = format!("{}:initialize", request.request_id);
    let initialize = JsonRpcRequest {
        jsonrpc: "2.0",
        id: initialize_id.clone(),
        method: "bibit.initialize",
        params: serde_json::json!({
            "protocolName": PROVIDER_PROTOCOL_NAME,
            "supportedProtocolVersions": [PROTOCOL_VERSION],
            "serviceId": request.service_id,
            "client": { "name": "Bibit" }
        }),
    };
    let invoke = JsonRpcRequest {
        jsonrpc: "2.0",
        id: request.request_id.clone(),
        method: "bibit.invoke",
        params: serde_json::json!({
            "serviceId": request.service_id,
            "operationId": request.operation_id,
            "params": request.params,
            "timeoutMs": timeout_ms
        }),
    };
    let mut input = match serde_json::to_vec(&initialize) {
        Ok(value) => value,
        Err(_) => return gateway_error(&request.request_id, "incompatible"),
    };
    input.push(b'\n');
    match serde_json::to_vec(&invoke) {
        Ok(value) => input.extend(value),
        Err(_) => return gateway_error(&request.request_id, "incompatible"),
    }
    input.push(b'\n');

    let provider_data_dir = data_root.join("providers").join(&request.service_id);
    if std::fs::create_dir_all(&provider_data_dir).is_err() {
        return gateway_error(&request.request_id, "unavailable");
    }
    let mut child = match Command::new(executable)
        .args(args)
        .env_clear()
        .env("LANG", "C.UTF-8")
        .env("BIBIT_PROVIDER_PROTOCOL", PROTOCOL_VERSION.to_string())
        .env("BIBIT_PROVIDER_DATA_DIR", provider_data_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
    {
        Ok(child) => child,
        Err(_) => return gateway_error(&request.request_id, "offline"),
    };
    let Some(mut stdin) = child.stdin.take() else {
        return gateway_error(&request.request_id, "unavailable");
    };
    let Some(stdout) = child.stdout.take() else {
        return gateway_error(&request.request_id, "unavailable");
    };
    let run = async {
        stdin.write_all(&input).await?;
        stdin.shutdown().await?;
        let mut bytes = Vec::new();
        let mut limited_stdout = stdout.take((MAX_RESPONSE_BYTES + 1) as u64);
        let read = limited_stdout.read_to_end(&mut bytes);
        let (read_result, status_result) = tokio::join!(read, child.wait());
        read_result?;
        Ok::<_, std::io::Error>((bytes, status_result?))
    };
    let outcome = tokio::select! {
        _ = cancellation.cancelled() => return gateway_error(&request.request_id, "cancelled"),
        outcome = tokio::time::timeout(Duration::from_millis(timeout_ms), run) => outcome,
    };
    let (bytes, status) = match outcome {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => return gateway_error(&request.request_id, "unavailable"),
        Err(_) => return gateway_error(&request.request_id, "timeout"),
    };
    if !status.success() {
        return gateway_error(&request.request_id, "provider_crashed");
    }
    if bytes.len() > MAX_RESPONSE_BYTES {
        return gateway_error(&request.request_id, "resource_exhausted");
    }
    let responses = bytes
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
        .map(serde_json::from_slice::<JsonRpcResponse>)
        .collect::<Result<Vec<_>, _>>();
    let Ok(responses) = responses else {
        return gateway_error(&request.request_id, "incompatible");
    };
    if responses.len() != 2 {
        return gateway_error(&request.request_id, "incompatible");
    }
    let initialize_response = &responses[0];
    if initialize_response.jsonrpc != "2.0"
        || initialize_response.id != Value::String(initialize_id)
        || initialize_response.error.is_some()
    {
        return gateway_error(&request.request_id, "incompatible");
    }
    let Some(initialize_result) = initialize_response.result.clone() else {
        return gateway_error(&request.request_id, "incompatible");
    };
    let Ok(initialize_result) =
        serde_json::from_value::<ProviderInitializeResult>(initialize_result)
    else {
        return gateway_error(&request.request_id, "incompatible");
    };
    if initialize_result.protocol_version != PROTOCOL_VERSION
        || initialize_result.provider_version.is_empty()
        || !initialize_result.capabilities.invoke
        || !initialize_result
            .operations
            .iter()
            .any(|operation| operation == &request.operation_id)
    {
        return gateway_error(&request.request_id, "incompatible");
    }
    let invoke_response = &responses[1];
    if invoke_response.jsonrpc != "2.0"
        || invoke_response.id != Value::String(request.request_id.clone())
        || (invoke_response.result.is_some() == invoke_response.error.is_some())
    {
        return gateway_error(&request.request_id, "incompatible");
    }
    if let Some(error) = invoke_response.error.as_ref() {
        return gateway_error(&request.request_id, sanitize_provider_error(error));
    }
    ExternalServiceGatewayResponse {
        protocol_version: PROTOCOL_VERSION,
        request_id: request.request_id.clone(),
        ok: true,
        result: invoke_response.result.clone(),
        error: None,
    }
}

async fn read_rpc_value(stdout: &mut BufReader<ChildStdout>) -> Result<Value, &'static str> {
    let mut bytes = Vec::new();
    let read = (&mut *stdout)
        .take((MAX_RESPONSE_BYTES + 1) as u64)
        .read_until(b'\n', &mut bytes)
        .await
        .map_err(|_| "unavailable")?;
    if read == 0 {
        return Err("provider_crashed");
    }
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err("resource_exhausted");
    }
    if bytes.last() != Some(&b'\n') {
        return Err("incompatible");
    }
    bytes.pop();
    serde_json::from_slice(&bytes).map_err(|_| "incompatible")
}

fn safe_provider_resource_path(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 512
        && !value.contains('\\')
        && value.split('/').all(|segment| {
            !segment.is_empty()
                && segment != "."
                && segment != ".."
                && segment
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        })
}

fn provider_job_error_code(
    value: &str,
) -> Option<crate::feature_service_jobs::FeatureServiceErrorCode> {
    use crate::feature_service_jobs::FeatureServiceErrorCode as Code;
    Some(match value {
        "cancelled" => Code::Cancelled,
        "offline" => Code::Offline,
        "timeout" => Code::Timeout,
        "unauthorized" => Code::Unauthorized,
        "incompatible" => Code::Incompatible,
        "unavailable" => Code::Unavailable,
        "provider_crashed" => Code::ProviderCrashed,
        "resource_exhausted" => Code::ResourceExhausted,
        "unknown" => Code::Unknown,
        _ => return None,
    })
}

pub(crate) fn provider_error_code(
    value: &str,
) -> crate::feature_service_jobs::FeatureServiceErrorCode {
    provider_job_error_code(value)
        .unwrap_or(crate::feature_service_jobs::FeatureServiceErrorCode::Unavailable)
}

fn provider_job_error_message(
    code: crate::feature_service_jobs::FeatureServiceErrorCode,
) -> &'static str {
    use crate::feature_service_jobs::FeatureServiceErrorCode as Code;
    match code {
        Code::Cancelled => "The job was cancelled",
        Code::Offline => "The Provider is offline",
        Code::Timeout => "The Provider timed out",
        Code::Unauthorized => "The Provider rejected the operation",
        Code::Incompatible => "The Provider response is incompatible",
        Code::Unavailable => "The Provider is unavailable",
        Code::ProviderCrashed => "The Provider stopped unexpectedly",
        Code::ResourceExhausted => "The Provider resource limit was reached",
        Code::Unknown => "The Provider job failed",
    }
}

fn finalize_provider_result(
    jobs: Arc<crate::feature_service_jobs::FeatureServiceJobRegistry>,
    job_id: String,
    result: Value,
) {
    use crate::feature_file_grants::FileGrantDirection;
    use crate::feature_service_jobs::{FeatureServiceErrorCode as Code, JobError};

    if let Err(error) = jobs.propose_result(&job_id) {
        if error == JobError::CancelRequested {
            let _ = jobs.provider_cancelled(&job_id);
        }
        return;
    }
    let Ok((direction, staged)) = jobs.transfer(&job_id) else {
        let _ = jobs.fail(
            &job_id,
            Code::Unavailable,
            "The Host lost the job transfer state",
            true,
        );
        return;
    };
    let Some(object) = result.as_object() else {
        let _ = jobs.fail(
            &job_id,
            Code::Incompatible,
            "The Provider returned an invalid job result",
            false,
        );
        return;
    };
    let Some(output) = object.get("output").cloned() else {
        let _ = jobs.fail(
            &job_id,
            Code::Incompatible,
            "The Provider returned an invalid job result",
            false,
        );
        return;
    };
    match direction {
        FileGrantDirection::Upload => {
            let _ = jobs.complete_finalizing(&job_id, None, output);
        }
        FileGrantDirection::Download => {
            let resource = object
                .get("resource")
                .cloned()
                .and_then(|value| serde_json::from_value::<ProviderDownloadResource>(value).ok());
            let Some(resource) = resource.filter(|resource| {
                safe_provider_resource_path(&resource.resource_path)
                    && resource.resource_path == staged.resource_path
                    && resource.sha256.len() == 64
                    && resource.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
            }) else {
                let _ = jobs.fail(
                    &job_id,
                    Code::Incompatible,
                    "The Provider returned an invalid file resource",
                    false,
                );
                return;
            };
            match jobs.file_grants().prepare_download(
                &staged.grant_id,
                resource.byte_length,
                &resource.sha256,
            ) {
                Ok(prepared) => {
                    let _ = jobs.complete_finalizing(&job_id, Some(prepared), output);
                }
                Err(_) => {
                    let _ = jobs.fail(&job_id, Code::Unknown, "Download finalization failed", true);
                }
            }
        }
    }
}

impl ManagedV2Driver {
    async fn invoke(
        self: &Arc<Self>,
        request: &ExternalServiceGatewayRequest,
        timeout_ms: u64,
        deadline: tokio::time::Instant,
        cancellation: &CancellationToken,
    ) -> Result<Option<Value>, &'static str> {
        let response = self
            .transport
            .request(
                request.request_id.clone(),
                "bibit.invoke",
                serde_json::json!({
                    "serviceId": request.service_id,
                    "operationId": request.operation_id,
                    "params": request.params,
                    "timeoutMs": timeout_ms
                }),
                deadline,
                cancellation,
            )
            .await
            .map_err(|code| match code.as_str() {
                "cancelled" => "cancelled",
                "timeout" => "timeout",
                "resource_exhausted" => "resource_exhausted",
                _ => "provider_crashed",
            })?;
        if let Some(error) = response.error {
            return Err(sanitize_provider_error(&error));
        }
        Ok(response.result)
    }

    async fn start_job(
        self: &Arc<Self>,
        snapshot: &crate::feature_service_jobs::JobSnapshot,
        input: Value,
        staged: &crate::feature_file_grants::StagedFile,
        deadline: tokio::time::Instant,
    ) -> Result<(), &'static str> {
        {
            let mut active = self.active_jobs.lock().await;
            if !active.is_empty() {
                return Err("resource_exhausted");
            }
            active.insert(snapshot.job_id.clone());
        }
        self.provider_sequences
            .lock()
            .await
            .insert(snapshot.job_id.clone(), 0);
        if self.jobs.mark_running(&snapshot.job_id).is_err() {
            self.active_jobs.lock().await.remove(&snapshot.job_id);
            self.provider_sequences
                .lock()
                .await
                .remove(&snapshot.job_id);
            return Err("incompatible");
        }
        let cancellation = CancellationToken::new();
        let response = self
            .transport
            .request(
                format!("job:start:{}", snapshot.job_id),
                "bibit.job.start",
                serde_json::json!({
                    "serviceId": snapshot.service_id,
                    "jobId": snapshot.job_id,
                    "operationId": snapshot.operation_id,
                    "input": input,
                    "resources": [{
                        "resourcePath": staged.resource_path,
                        "byteLength": staged.byte_length,
                        "sha256": (!staged.sha256.is_empty()).then_some(&staged.sha256)
                    }]
                }),
                deadline,
                &cancellation,
            )
            .await;
        let accepted = response
            .ok()
            .and_then(|response| response.result)
            .is_some_and(|result| {
                result.get("jobId").and_then(Value::as_str) == Some(snapshot.job_id.as_str())
                    && result.get("accepted").and_then(Value::as_bool) == Some(true)
            });
        if !accepted {
            self.active_jobs.lock().await.remove(&snapshot.job_id);
            self.provider_sequences
                .lock()
                .await
                .remove(&snapshot.job_id);
            return Err("incompatible");
        }
        Ok(())
    }

    async fn cancel_job(
        self: &Arc<Self>,
        job_id: &str,
        deadline: tokio::time::Instant,
    ) -> Result<(), &'static str> {
        let (sender, receiver) = oneshot::channel();
        {
            let mut waiters = self.cancel_waiters.lock().await;
            if waiters.contains_key(job_id) {
                return Err("incompatible");
            }
            if waiters.len() >= 16 {
                return Err("resource_exhausted");
            }
            waiters.insert(job_id.into(), sender);
        }
        self.active_jobs.lock().await.insert(job_id.to_owned());
        let cancellation = CancellationToken::new();
        let response = self
            .transport
            .request(
                format!("job:cancel:{job_id}:{}", uuid::Uuid::new_v4()),
                "bibit.job.cancel",
                serde_json::json!({ "serviceId": self.service_id, "jobId": job_id }),
                deadline,
                &cancellation,
            )
            .await;
        let accepted = response
            .as_ref()
            .ok()
            .and_then(|response| response.result.as_ref())
            .is_some_and(|result| {
                result.get("jobId").and_then(Value::as_str) == Some(job_id)
                    && result.get("accepted").and_then(Value::as_bool) == Some(true)
            });
        if !accepted {
            self.cancel_waiters.lock().await.remove(job_id);
            let code = match response.as_ref().err().map(String::as_str) {
                Some("timeout") => "timeout",
                Some("resource_exhausted") => "resource_exhausted",
                Some(_) => "provider_crashed",
                None => "incompatible",
            };
            self.isolate(code).await;
            return Err(code);
        }
        let terminal = tokio::select! {
            biased;
            _ = self.transport.done.cancelled() => false,
            terminal = tokio::time::timeout_at(deadline, receiver) => matches!(terminal, Ok(Ok(()))),
        };
        if !terminal {
            self.cancel_waiters.lock().await.remove(job_id);
            self.isolate("timeout").await;
            return Err("timeout");
        }
        Ok(())
    }

    async fn signal_job_terminal(&self, job_id: &str) {
        if let Some(waiter) = self.cancel_waiters.lock().await.remove(job_id) {
            let _ = waiter.send(());
        }
    }

    async fn handle_job_event(
        self: &Arc<Self>,
        event: ProviderJobEventParams,
    ) -> Result<(), &'static str> {
        if event.service_id != self.service_id || event.provider_sequence == 0 {
            return Err("incompatible");
        }
        if !self.active_jobs.lock().await.contains(&event.job_id) {
            return Err("incompatible");
        }
        {
            let mut sequences = self.provider_sequences.lock().await;
            let previous = sequences.entry(event.job_id.clone()).or_default();
            if event.provider_sequence <= *previous {
                return Err("incompatible");
            }
            *previous = event.provider_sequence;
        }
        match event.kind {
            ProviderJobEventKind::Progress => {
                if event.result.is_some() || event.error.is_some() {
                    return Err("incompatible");
                }
                let progress = event.progress.ok_or("incompatible")?;
                if event.provider_sequence == 1 {
                    log::info!(
                        "external_service.job_event service={} job={} sequence={} kind=progress completed_bytes={} total_bytes={:?}",
                        event.service_id,
                        event.job_id,
                        event.provider_sequence,
                        progress.completed_bytes,
                        progress.total_bytes
                    );
                }
                match self.jobs.record_progress_at(
                    &event.job_id,
                    progress.completed_bytes,
                    progress.total_bytes,
                    std::time::Instant::now(),
                ) {
                    Ok(_) | Err(crate::feature_service_jobs::JobError::CancelRequested) => Ok(()),
                    Err(_) => Err("incompatible"),
                }
            }
            ProviderJobEventKind::ResultReady => {
                if event.progress.is_some() || event.error.is_some() {
                    return Err("incompatible");
                }
                let result = event.result.ok_or("incompatible")?;
                log::info!(
                    "external_service.job_event service={} job={} sequence={} kind=result_ready",
                    event.service_id,
                    event.job_id,
                    event.provider_sequence
                );
                self.active_jobs.lock().await.remove(&event.job_id);
                self.provider_sequences.lock().await.remove(&event.job_id);
                let jobs = Arc::clone(&self.jobs);
                let job_id = event.job_id.clone();
                tokio::task::spawn_blocking(move || finalize_provider_result(jobs, job_id, result));
                self.signal_job_terminal(&event.job_id).await;
                Ok(())
            }
            ProviderJobEventKind::Cancelled => {
                if event.progress.is_some() || event.result.is_some() || event.error.is_some() {
                    return Err("incompatible");
                }
                log::info!(
                    "external_service.job_event service={} job={} sequence={} kind=cancelled",
                    event.service_id,
                    event.job_id,
                    event.provider_sequence
                );
                let jobs = Arc::clone(&self.jobs);
                let job_id = event.job_id.clone();
                tokio::task::spawn_blocking(move || jobs.provider_cancelled(&job_id))
                    .await
                    .map_err(|_| "unavailable")?
                    .map_err(|_| "incompatible")?;
                self.active_jobs.lock().await.remove(&event.job_id);
                self.provider_sequences.lock().await.remove(&event.job_id);
                self.signal_job_terminal(&event.job_id).await;
                Ok(())
            }
            ProviderJobEventKind::Failed => {
                if event.progress.is_some() || event.result.is_some() {
                    return Err("incompatible");
                }
                let failure = event.error.ok_or("incompatible")?;
                if failure.message.len() > 512 {
                    return Err("incompatible");
                }
                let code = provider_job_error_code(&failure.code).ok_or("incompatible")?;
                log::info!(
                    "external_service.job_event service={} job={} sequence={} kind=failed code={}",
                    event.service_id,
                    event.job_id,
                    event.provider_sequence,
                    failure.code
                );
                let jobs = Arc::clone(&self.jobs);
                let job_id = event.job_id.clone();
                tokio::task::spawn_blocking(move || {
                    jobs.fail(
                        &job_id,
                        code,
                        provider_job_error_message(code),
                        failure.retryable,
                    )
                })
                .await
                .map_err(|_| "unavailable")?
                .map_err(|_| "incompatible")?;
                self.active_jobs.lock().await.remove(&event.job_id);
                self.provider_sequences.lock().await.remove(&event.job_id);
                self.signal_job_terminal(&event.job_id).await;
                Ok(())
            }
        }
    }

    async fn isolate(&self, code: &'static str) {
        self.transport.request_stop(code);
        self.transport.stopped().await;
    }

    async fn fail_jobs(&self, code: &'static str) {
        let active = std::mem::take(&mut *self.active_jobs.lock().await);
        self.provider_sequences.lock().await.clear();
        self.cancel_waiters.lock().await.clear();
        let jobs = Arc::clone(&self.jobs);
        tokio::task::spawn_blocking(move || {
            let error_code = provider_error_code(code);
            for job_id in active {
                let _ = jobs.fail(
                    &job_id,
                    error_code,
                    provider_job_error_message(error_code),
                    true,
                );
            }
        });
    }
}

fn spawn_managed_process(
    executable: &Path,
    args: &[String],
    data_dir: &Path,
    protocol_version: u8,
) -> Result<(Child, ChildStdin, BufReader<ChildStdout>), &'static str> {
    std::fs::create_dir_all(data_dir).map_err(|_| "unavailable")?;
    let mut child = Command::new(executable)
        .args(args)
        .env_clear()
        .env("LANG", "C.UTF-8")
        .env("BIBIT_PROVIDER_PROTOCOL", protocol_version.to_string())
        .env("BIBIT_PROVIDER_DATA_DIR", data_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| "offline")?;
    let stdin = child.stdin.take().ok_or("unavailable")?;
    let stdout = child.stdout.take().ok_or("unavailable")?;
    Ok((child, stdin, BufReader::new(stdout)))
}

async fn managed_provider(
    config: ProviderConfig,
    service_id: &str,
    request_id: &str,
    deadline: tokio::time::Instant,
    cancellation: &CancellationToken,
    jobs: Option<Arc<crate::feature_service_jobs::FeatureServiceJobRegistry>>,
) -> Arc<ManagedProvider> {
    let mut providers = managed_providers().lock().await;
    if let Some(provider) = providers.get(service_id) {
        if provider.config == config && provider.transport.healthy() {
            return Arc::clone(provider);
        }
    }
    let predecessor = providers.get(service_id).map(|provider| {
        provider.transport.request_stop("provider_crashed");
        provider.transport.done.clone()
    });
    let (transport, driver) = ProviderHandle::spawn(
        config.clone(),
        service_id.into(),
        request_id,
        deadline,
        cancellation.clone(),
        jobs,
        predecessor,
    );
    let provider = Arc::new(ManagedProvider {
        config,
        transport,
        driver,
    });
    providers.insert(service_id.into(), Arc::clone(&provider));
    provider
}

pub async fn shutdown_managed_providers() {
    let providers = {
        let providers = managed_providers().lock().await;
        for provider in providers.values() {
            provider.transport.request_stop("provider_crashed");
        }
        providers.clone()
    };
    futures_util::future::join_all(
        providers
            .values()
            .map(|provider| provider.transport.stopped()),
    )
    .await;
    let mut current = managed_providers().lock().await;
    for (service_id, provider) in providers {
        if current
            .get(&service_id)
            .is_some_and(|entry| Arc::ptr_eq(entry, &provider))
        {
            current.remove(&service_id);
        }
    }
}

async fn forward_stdio_managed(
    data_root: &Path,
    executable: &Path,
    args: &[String],
    protocol_versions: &[u8],
    timeout_ms: u64,
    deadline: tokio::time::Instant,
    request: &ExternalServiceGatewayRequest,
    cancellation: &CancellationToken,
    jobs: Option<Arc<crate::feature_service_jobs::FeatureServiceJobRegistry>>,
) -> ExternalServiceGatewayResponse {
    let provider = managed_provider(
        ProviderConfig {
            executable: executable.to_path_buf(),
            args: args.to_vec(),
            data_dir: data_root.join("providers").join(&request.service_id),
            protocol_versions: protocol_versions.to_vec(),
        },
        &request.service_id,
        &request.request_id,
        deadline,
        cancellation,
        jobs,
    )
    .await;
    let session = match provider.transport.session(deadline, cancellation).await {
        Ok(session) => session,
        Err(code) => return gateway_error(&request.request_id, code),
    };
    // Managed providers are initialized before the invoke is written, so the
    // host can adopt the provider's own spelling: a provider that declares
    // `agents.list.v1` keeps receiving that name while the caller may ask for
    // either spelling. One-shot providers answer the invoke in the same write as
    // the initialize, so they cannot be adapted this way and stay exact.
    let Some(declared_operation) = session
        .operations
        .iter()
        .find(|operation| {
            crate::feature_capabilities::canonical_operation(operation)
                == crate::feature_capabilities::canonical_operation(&request.operation_id)
        })
        .cloned()
    else {
        return gateway_error(&request.request_id, "incompatible");
    };
    let forwarded = ExternalServiceGatewayRequest {
        operation_id: declared_operation,
        ..(*request).clone()
    };
    let request = &forwarded;
    if session.protocol_version == PROVIDER_PROTOCOL_V2 {
        let Some(driver) = provider.driver.as_ref() else {
            return gateway_error(&request.request_id, "incompatible");
        };
        return match driver
            .invoke(request, timeout_ms, deadline, cancellation)
            .await
        {
            Ok(result) => ExternalServiceGatewayResponse {
                protocol_version: PROTOCOL_VERSION,
                request_id: request.request_id.clone(),
                ok: true,
                result,
                error: None,
            },
            Err(code) => gateway_error(&request.request_id, code),
        };
    }
    let response = provider
        .transport
        .request(
            request.request_id.clone(),
            "bibit.invoke",
            serde_json::json!({
                "serviceId": request.service_id,
                "operationId": request.operation_id,
                "params": request.params,
                "timeoutMs": timeout_ms
            }),
            deadline,
            cancellation,
        )
        .await;
    let response = match response {
        Ok(response) => response,
        Err(code) => return gateway_error(&request.request_id, &code),
    };
    if let Some(error) = response.error {
        return gateway_error(&request.request_id, sanitize_provider_error(&error));
    }
    ExternalServiceGatewayResponse {
        protocol_version: PROTOCOL_VERSION,
        request_id: request.request_id.clone(),
        ok: true,
        result: response.result,
        error: None,
    }
}

async fn managed_v2_for_service(
    data_root: &Path,
    service_id: &str,
    jobs: Arc<crate::feature_service_jobs::FeatureServiceJobRegistry>,
) -> Result<ManagedSessionV2, &'static str> {
    let started = tokio::time::Instant::now();
    let registry_root = data_root.to_path_buf();
    let registry = tokio::time::timeout_at(
        started + Duration::from_millis(DEFAULT_TIMEOUT_MS),
        tauri::async_runtime::spawn_blocking(move || load_registry(&registry_root)),
    )
    .await
    .map_err(|_| "timeout")?
    .map_err(|_| "unavailable")?
    .map_err(|_| "unavailable")?;
    let Some(connection) = registry.services.get(service_id) else {
        return Err("unavailable");
    };
    let ProviderTransport::Stdio {
        executable,
        args,
        lifecycle: StdioLifecycle::Managed,
        protocol_versions,
    } = &connection.transport
    else {
        return Err("incompatible");
    };
    if !protocol_versions.contains(&PROVIDER_PROTOCOL_V2) {
        return Err("incompatible");
    }
    let deadline =
        started + Duration::from_millis(connection.request_timeout_ms.min(DEFAULT_TIMEOUT_MS));
    let cancellation = CancellationToken::new();
    let provider = managed_provider(
        ProviderConfig {
            executable: executable.clone(),
            args: args.clone(),
            data_dir: data_root.join("providers").join(service_id),
            protocol_versions: protocol_versions.clone(),
        },
        service_id,
        &format!("job-session:{}", uuid::Uuid::new_v4()),
        deadline,
        &cancellation,
        Some(jobs),
    )
    .await;
    let session = provider.transport.session(deadline, &cancellation).await?;
    if session.protocol_version != PROVIDER_PROTOCOL_V2 {
        return Err("incompatible");
    }
    Ok(ManagedSessionV2 {
        driver: provider.driver.clone().ok_or("incompatible")?,
        operations: session.operations,
        deadline,
    })
}

fn dispatch_failure_code(code: &str) -> crate::feature_service_jobs::FeatureServiceErrorCode {
    provider_job_error_code(code)
        .unwrap_or(crate::feature_service_jobs::FeatureServiceErrorCode::Unavailable)
}

pub(crate) async fn start_service_job(
    data_root: &Path,
    jobs: Arc<crate::feature_service_jobs::FeatureServiceJobRegistry>,
    request: crate::feature_service_jobs::StartJobRequest,
) -> Result<crate::feature_service_jobs::JobSnapshot, crate::feature_service_jobs::JobError> {
    let owner = request.owner.clone();
    let feature_id = request.owner.feature_id.clone();
    let grant_id = request.grant_id.clone();
    let input = request.input.clone();
    let outcome = jobs.start(request)?;
    if !outcome.created {
        return Ok(outcome.snapshot);
    }
    let staged = outcome
        .staged
        .ok_or(crate::feature_service_jobs::JobError::Unavailable)?;
    let session =
        managed_v2_for_service(data_root, &outcome.snapshot.service_id, Arc::clone(&jobs)).await;
    let dispatch = match session {
        Ok(session)
            if session
                .operations
                .iter()
                .any(|operation| operation == &outcome.snapshot.operation_id) =>
        {
            session
                .driver
                .start_job(&outcome.snapshot, input, &staged, session.deadline)
                .await
        }
        Ok(_) => Err("incompatible"),
        Err(code) => Err(code),
    };
    if let Err(code) = dispatch {
        return jobs.fail(
            &outcome.snapshot.job_id,
            dispatch_failure_code(code),
            provider_job_error_message(dispatch_failure_code(code)),
            true,
        );
    }
    log::info!(
        "external_service.job_started feature={} service={} operation={} grant={} job={} bytes={}",
        feature_id,
        outcome.snapshot.service_id,
        outcome.snapshot.operation_id,
        grant_id,
        outcome.snapshot.job_id,
        staged.byte_length
    );
    jobs.snapshot(&owner, &outcome.snapshot.job_id)
}

pub(crate) async fn ensure_service_jobs_available(
    data_root: &Path,
    service_id: &str,
    jobs: Arc<crate::feature_service_jobs::FeatureServiceJobRegistry>,
) -> Result<(), &'static str> {
    managed_v2_for_service(data_root, service_id, jobs)
        .await
        .map(|_| ())
}

pub(crate) async fn cancel_service_job(service_id: &str, job_id: &str) -> Result<(), &'static str> {
    let deadline = tokio::time::Instant::now() + JOB_CANCEL_TIMEOUT;
    let provider = managed_providers().lock().await.get(service_id).cloned();
    let Some(provider) = provider else {
        return Err("unavailable");
    };
    let cancellation = CancellationToken::new();
    let session = provider.transport.session(deadline, &cancellation).await?;
    if session.protocol_version != PROVIDER_PROTOCOL_V2 {
        return Err("incompatible");
    }
    provider
        .driver
        .as_ref()
        .ok_or("incompatible")?
        .cancel_job(job_id, deadline)
        .await
}

pub(crate) async fn cancel_service_job_with_reconnect(
    data_root: &Path,
    jobs: Arc<crate::feature_service_jobs::FeatureServiceJobRegistry>,
    service_id: &str,
    job_id: &str,
) -> Result<(), &'static str> {
    if cancel_service_job(service_id, job_id).await.is_ok() {
        return Ok(());
    }
    ensure_service_jobs_available(data_root, service_id, jobs).await?;
    cancel_service_job(service_id, job_id).await
}

pub(crate) async fn terminate_managed_service(service_id: &str) {
    let provider = {
        let providers = managed_providers().lock().await;
        let provider = providers.get(service_id).cloned();
        if let Some(provider) = provider.as_ref() {
            provider.transport.request_stop("provider_crashed");
        }
        provider
    };
    if let Some(provider) = provider {
        provider.transport.stopped().await;
        let mut providers = managed_providers().lock().await;
        if providers
            .get(service_id)
            .is_some_and(|current| Arc::ptr_eq(current, &provider))
        {
            providers.remove(service_id);
        }
    }
}

async fn forward_request_inner(
    data_root: &Path,
    request: ExternalServiceGatewayRequest,
    cancellation: &CancellationToken,
    jobs: Option<Arc<crate::feature_service_jobs::FeatureServiceJobRegistry>>,
) -> ExternalServiceGatewayResponse {
    let started = tokio::time::Instant::now();
    let request_bytes = match validate_and_encode_request(&request) {
        Ok(bytes) => bytes,
        Err(code) => return gateway_error(&request.request_id, code),
    };
    let registry_root = data_root.to_path_buf();
    let registry = tokio::select! {
        biased;
        _ = cancellation.cancelled() => return gateway_error(&request.request_id, "cancelled"),
        result = tokio::time::timeout_at(
            started + Duration::from_millis(request.timeout_ms),
            tauri::async_runtime::spawn_blocking(move || load_registry(&registry_root)),
        ) => match result {
            Ok(Ok(Ok(registry))) => registry,
            Err(_) => return gateway_error(&request.request_id, "timeout"),
            _ => return gateway_error(&request.request_id, "unavailable"),
        },
    };
    let Some(connection) = registry.services.get(&request.service_id) else {
        return gateway_error(&request.request_id, "unavailable");
    };
    if !validate_business_parameters(&request, connection) {
        return gateway_error(&request.request_id, "incompatible");
    }
    let timeout_ms = request.timeout_ms.min(connection.request_timeout_ms);
    match &connection.transport {
        ProviderTransport::Http { base_url, auth_ref } => {
            forward_http(
                base_url,
                auth_ref.as_ref(),
                timeout_ms,
                &request,
                request_bytes,
                cancellation,
            )
            .await
        }
        ProviderTransport::Stdio {
            executable,
            args,
            lifecycle,
            protocol_versions,
        } => match lifecycle {
            StdioLifecycle::OneShot => {
                forward_stdio_one_shot(
                    data_root,
                    executable,
                    args,
                    timeout_ms,
                    &request,
                    cancellation,
                )
                .await
            }
            StdioLifecycle::Managed => {
                forward_stdio_managed(
                    data_root,
                    executable,
                    args,
                    protocol_versions,
                    timeout_ms,
                    started + Duration::from_millis(timeout_ms),
                    &request,
                    cancellation,
                    jobs,
                )
                .await
            }
        },
    }
}

fn service_operation_authorized(
    feature_id: &str,
    plugin_version: &str,
    feature_instance_token: &str,
    service_id: &str,
    operation_id: &str,
    grants: &crate::feature_capabilities::FeatureCapabilityGrants,
) -> bool {
    let canonical = format!("service:{service_id}");
    std::iter::once(canonical.as_str())
        .chain(crate::feature_capabilities::legacy_service_capability(
            service_id,
        ))
        .any(|capability| {
            crate::trusted_plugins::validate_feature_instance_version_capability(
                feature_id,
                plugin_version,
                feature_instance_token,
                capability,
            ) && crate::feature_capabilities::grants_allow(
                grants,
                feature_id,
                service_id,
                operation_id,
                capability,
            )
        })
}

fn service_request_authorized_with_grants(
    request: &FeatureServiceCommandRequest,
    grants: &crate::feature_capabilities::FeatureCapabilityGrants,
) -> bool {
    service_operation_authorized(
        &request.feature_id,
        &request.plugin_version,
        &request.feature_instance_token,
        &request.service_id,
        &request.operation_id,
        grants,
    )
}

async fn register_active_request(
    owner: &ServiceRequestOwner,
    request_id: &str,
    service_id: &str,
    operation_id: &str,
    cancellation: CancellationToken,
) -> bool {
    let key = ActiveRequestKey {
        owner: owner.clone(),
        request_id: request_id.into(),
    };
    let mut requests = active_requests().lock().await;
    match requests.entry(key) {
        std::collections::btree_map::Entry::Vacant(entry) => {
            entry.insert(ActiveServiceRequest {
                service_id: service_id.into(),
                operation_id: operation_id.into(),
                cancellation,
            });
            true
        }
        std::collections::btree_map::Entry::Occupied(_) => false,
    }
}

async fn remove_active_request(owner: &ServiceRequestOwner, request_id: &str) {
    active_requests().lock().await.remove(&ActiveRequestKey {
        owner: owner.clone(),
        request_id: request_id.into(),
    });
}

async fn forward_request_with_jobs(
    data_root: &Path,
    owner: ServiceRequestOwner,
    request: ExternalServiceGatewayRequest,
    jobs: Option<Arc<crate::feature_service_jobs::FeatureServiceJobRegistry>>,
) -> ExternalServiceGatewayResponse {
    let cancellation = CancellationToken::new();
    if !register_active_request(
        &owner,
        &request.request_id,
        &request.service_id,
        &request.operation_id,
        cancellation.clone(),
    )
    .await
    {
        return gateway_error(&request.request_id, "incompatible");
    }
    let response = forward_request_inner(data_root, request.clone(), &cancellation, jobs).await;
    remove_active_request(&owner, &request.request_id).await;
    response
}

async fn cancel_request(
    owner: &ServiceRequestOwner,
    service_id: &str,
    operation_id: &str,
    request_id: &str,
) -> bool {
    let request = active_requests()
        .lock()
        .await
        .get(&ActiveRequestKey {
            owner: owner.clone(),
            request_id: request_id.into(),
        })
        .filter(|request| request.service_id == service_id && request.operation_id == operation_id)
        .cloned();
    if let Some(request) = request {
        request.cancellation.cancel();
        true
    } else {
        false
    }
}

pub(crate) async fn cancel_feature_requests(owner: &crate::feature_file_grants::FileGrantOwner) {
    let cancellations = active_requests()
        .lock()
        .await
        .iter()
        .filter(|(key, _)| {
            key.owner.feature_id == owner.feature_id
                && key.owner.feature_instance_token == owner.feature_instance_id
        })
        .map(|(_, request)| request.cancellation.clone())
        .collect::<Vec<_>>();
    for cancellation in cancellations {
        cancellation.cancel();
    }
}

async fn dispatch_service_request_with_grants(
    data_root: &Path,
    jobs: Option<Arc<crate::feature_service_jobs::FeatureServiceJobRegistry>>,
    request: FeatureServiceCommandRequest,
    grants: &crate::feature_capabilities::FeatureCapabilityGrants,
) -> ExternalServiceGatewayResponse {
    if !service_request_authorized_with_grants(&request, grants) {
        log::warn!(
            "external_service.request_unauthorized feature={} version={} service={} operation={} request={}",
            request.feature_id,
            request.plugin_version,
            request.service_id,
            request.operation_id,
            request.request_id,
        );
        return gateway_error(&request.request_id, "unauthorized");
    }
    let owner = request.owner();
    let gateway_request = request.gateway_request();
    forward_request_with_jobs(data_root, owner, gateway_request, jobs).await
}

#[cfg(test)]
fn test_request_owner() -> ServiceRequestOwner {
    ServiceRequestOwner {
        feature_id: "test-feature".into(),
        plugin_version: "1.0.0".into(),
        feature_instance_token: "test-instance".into(),
    }
}

#[cfg(test)]
async fn forward_request(
    data_root: &Path,
    request: ExternalServiceGatewayRequest,
) -> ExternalServiceGatewayResponse {
    forward_request_with_jobs(data_root, test_request_owner(), request, None).await
}

#[tauri::command]
pub async fn external_service_request<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    window: WebviewWindow<R>,
    jobs: tauri::State<'_, Arc<crate::feature_service_jobs::FeatureServiceJobRegistry>>,
    request: FeatureServiceCommandRequest,
) -> Result<ExternalServiceGatewayResponse, String> {
    if window.label() != "main" {
        return Err("External service access is only available from the main window".into());
    }
    let data_root = crate::core::app::commands::get_jan_data_folder_path(app);
    let grants = crate::feature_capabilities::runtime_grants();
    Ok(
        dispatch_service_request_with_grants(&data_root, Some(Arc::clone(&jobs)), request, grants)
            .await,
    )
}

#[tauri::command]
pub async fn external_service_cancel<R: tauri::Runtime>(
    window: WebviewWindow<R>,
    request: FeatureServiceCancelCommandRequest,
) -> Result<bool, String> {
    if window.label() != "main" {
        return Err("External service access is only available from the main window".into());
    }
    if request.request_id.is_empty() || request.request_id.len() > 128 {
        return Err("Invalid external service request id".into());
    }
    if !service_operation_authorized(
        &request.feature_id,
        &request.plugin_version,
        &request.feature_instance_token,
        &request.service_id,
        &request.operation_id,
        crate::feature_capabilities::runtime_grants(),
    ) {
        return Err("unauthorized".into());
    }
    Ok(cancel_request(
        &request.owner(),
        &request.service_id,
        &request.operation_id,
        &request.request_id,
    )
    .await)
}

#[cfg(test)]
mod tests {
    #[test]
    fn connection_policy_matches_operation_aliases() {
        let mut policy = BTreeMap::new();
        policy.insert(
            "agents.create.v1".to_string(),
            vec!["/permissions/resource_limits/tokens".to_string()],
        );

        assert_eq!(
            operation_policy(&policy, "agents.create"),
            ["/permissions/resource_limits/tokens"]
        );
        assert_eq!(
            operation_policy(&policy, "agents.create.v1"),
            ["/permissions/resource_limits/tokens"]
        );
        assert!(operation_policy(&policy, "agents.delete").is_empty());
    }

    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn registry_accepts_format_valid_service_ids_and_safe_urls() {
        let registry = parse_registry(
            br#"{
              "version": 1,
              "services": {
                "store": {
                  "baseUrl": "https://store.example.test/api",
                  "requestTimeoutMs": 15000
                }
              }
            }"#,
        )
        .unwrap();
        let store = registry.services.get("store").unwrap();
        let ProviderTransport::Http { base_url, .. } = &store.transport else {
            panic!("expected HTTP transport");
        };
        assert_eq!(base_url.as_str(), "https://store.example.test/api");

        assert!(parse_registry(
            br#"{"version":1,"services":{"knowledge-index":{"baseUrl":"https://example.test"}}}"#
        )
        .is_ok());
        assert!(parse_registry(
            br#"{"version":1,"services":{"Knowledge/Index":{"baseUrl":"https://example.test"}}}"#
        )
        .is_err());
        assert!(parse_registry(
            br#"{"version":1,"services":{"store":{"baseUrl":"file:///tmp/service"}}}"#
        )
        .is_err());
        assert!(parse_registry(
            br#"{"version":1,"services":{"store":{"baseUrl":"https://user:secret@example.test"}}}"#
        )
        .is_err());
    }

    #[test]
    fn registry_accepts_a_fixed_stdio_provider_only_in_v2() {
        let registry = parse_registry(
            br#"{
              "version": 2,
              "services": {
                "store": {
                  "transport": "stdio",
                  "executable": "/usr/libexec/bibit/bibit-agenthub",
                  "args": ["provider"],
                  "lifecycle": "oneShot",
                  "protocolVersions": [1]
                }
              }
            }"#,
        )
        .unwrap();
        assert!(matches!(
            registry.services["store"].transport,
            ProviderTransport::Stdio { .. }
        ));
        assert!(parse_registry(
            br#"{"version":2,"services":{"store":{"transport":"stdio","executable":"agenthub","protocolVersions":[1]}}}"#
        )
        .is_err());
        let managed = parse_registry(
            br#"{"version":2,"services":{"store":{"transport":"stdio","executable":"/usr/bin/agenthub","lifecycle":"managed","protocolVersions":[1]}}}"#
        )
        .unwrap();
        assert!(matches!(
            managed.services["store"].transport,
            ProviderTransport::Stdio {
                lifecycle: StdioLifecycle::Managed,
                ..
            }
        ));
        assert!(parse_registry(
            br#"{"version":2,"services":{"store":{"transport":"stdio","executable":"/usr/bin/agenthub","lifecycle":"daemon","protocolVersions":[1]}}}"#
        )
        .is_err());
    }

    #[test]
    fn request_validation_rejects_transport_data_and_invalid_operations() {
        let valid = ExternalServiceGatewayRequest {
            protocol_version: 1,
            request_id: "request-1".into(),
            service_id: "store".into(),
            operation_id: "agents.list.v1".into(),
            params: serde_json::json!({"limit": 20}),
            timeout_ms: 1_000,
        };
        assert!(validate_and_encode_request(&valid).is_ok());

        let mut invalid = valid.clone();
        invalid.params = serde_json::json!({"headers": {"Authorization": "secret"}});
        let registry = parse_registry(
            br#"{"version":1,"services":{"store":{"baseUrl":"http://127.0.0.1:5186"}}}"#,
        )
        .unwrap();
        assert!(!validate_business_parameters(
            &invalid,
            &registry.services["store"]
        ));

        invalid = valid.clone();
        invalid.operation_id = "../arbitrary".into();
        assert!(validate_and_encode_request(&invalid).is_err());

        invalid = valid;
        invalid.timeout_ms = 300_001;
        assert!(validate_and_encode_request(&invalid).is_err());
    }

    #[test]
    fn request_envelope_defers_quota_policy_to_registered_connection() {
        let request = ExternalServiceGatewayRequest {
            protocol_version: 1,
            request_id: "expert-profile".into(),
            service_id: "runtime".into(),
            operation_id: "agents.create.v1".into(),
            params: serde_json::json!({"permissions":{"resource_limits":{"tokens":{"per_session":20000,"per_day":100000,"on_exceeded":"pause_and_notify"}}}}),
            timeout_ms: 1_000,
        };
        assert!(validate_and_encode_request(&request).is_ok());
    }

    #[test]
    fn business_credentials_require_an_explicit_operation_policy() {
        let registry = parse_registry(br#"{"version":1,"services":{"runtime":{"baseUrl":"http://127.0.0.1:5186","credentialParameters":{"providers.create.v1":["api_key"]}}}}"#).unwrap();
        let connection = &registry.services["runtime"];
        let mut request = ExternalServiceGatewayRequest {
            protocol_version: 1,
            request_id: "business-params".into(),
            service_id: "runtime".into(),
            operation_id: "providers.create.v1".into(),
            params: serde_json::json!({"base_url":"https://example.test/v1","api_key":"user-entered-key"}),
            timeout_ms: 1_000,
        };
        assert!(validate_business_parameters(&request, connection));
        request.operation_id = "providers.update.v1".into();
        assert!(!validate_business_parameters(&request, connection));
        request.operation_id = "providers.create.v1".into();
        request.params = serde_json::json!({"api_key":{"headers":{"Authorization":"injected"}}});
        assert!(!validate_business_parameters(&request, connection));
        request.params = serde_json::json!({"headers":{"Authorization":"injected"}});
        assert!(!validate_business_parameters(&request, connection));
        request.params = serde_json::json!({"nested":{"api_key":"not-top-level"}});
        assert!(!validate_business_parameters(&request, connection));
        request.params = serde_json::json!({"password":"undeclared"});
        assert!(!validate_business_parameters(&request, connection));
        request.params = serde_json::json!({"nested":{"password":"undeclared"}});
        assert!(!validate_business_parameters(&request, connection));
        request.params = serde_json::json!({"runtime":{"agent_max_context_tokens":32000}});
        assert!(validate_business_parameters(&request, connection));
        assert!(parse_registry(br#"{"version":1,"services":{"runtime":{"baseUrl":"http://127.0.0.1:5186","credentialParameters":{"providers.create.v1":["headers"]}}}}"#).is_err());
    }

    #[test]
    fn business_quota_objects_require_exact_operation_paths_and_keep_nested_checks() {
        let registry = parse_registry(
            br#"{"version":1,"services":{
            "runtime":{"baseUrl":"http://127.0.0.1:5186","businessObjectParameters":{
                "agents.create.v1":["/permissions/resource_limits/tokens"],
                "agents.update.v1":["/permissions/resource_limits/tokens"]}},
            "other":{"baseUrl":"http://127.0.0.1:5187"}
        }}"#,
        )
        .unwrap();
        let connection = &registry.services["runtime"];
        let mut request = ExternalServiceGatewayRequest {
            protocol_version: 1,
            request_id: "expert-profile".into(),
            service_id: "runtime".into(),
            operation_id: "agents.create.v1".into(),
            timeout_ms: 1_000,
            params: serde_json::json!({"name":"ResearchAssistant", "model":{"provider":"main","name":"model"},
            "permissions":{
                "capabilities":[{"capability":"file.read","scope":"/data","risk_level":"L2"}],
                "resource_limits":{"tokens":{"per_session":20000,"per_day":100000,"on_exceeded":"pause_and_notify"}},
                "network":{"mode":"allowlist","domains":[]},
                "data_protection":{"personal_data":[{"type":"secret","risk":"L4","action":"mask"},{"type":"api_key","risk":"L4","action":"mask"}]}
            }}),
        };
        let valid = request.params.clone();
        assert!(validate_business_parameters(&request, connection));
        request.operation_id = "agents.update.v1".into();
        assert!(validate_business_parameters(&request, connection));
        assert!(!validate_business_parameters(
            &request,
            &registry.services["other"]
        ));
        request.operation_id = "settings.update.v1".into();
        assert!(!validate_business_parameters(&request, connection));
        request.operation_id = "agents.create.v1".into();
        for invalid in [
            serde_json::json!("credential-token"),
            serde_json::json!(["credential-token"]),
            serde_json::json!(1000),
            serde_json::json!({"api_key":"secret"}),
            serde_json::json!({"password":"secret"}),
            serde_json::json!({"headers":{"Authorization":"secret"}}),
            serde_json::json!({"nested":[{"token":"secret"}]}),
            serde_json::json!({"tokens":{"per_day":1000}}),
        ] {
            request.params = valid.clone();
            request.params["permissions"]["resource_limits"]["tokens"] = invalid;
            assert!(!validate_business_parameters(&request, connection));
        }
        for invalid in [
            serde_json::json!({"tokens":{"per_day":1000}}),
            serde_json::json!({"permissions/resource_limits":{"tokens":{"per_day":1000}}}),
            serde_json::json!({"permissions":{"resource_limits/tokens":{"api_key":"secret"}}}),
            serde_json::json!({"permissions":{"resource_limits":{"tokens":{"per_day":1000}},"password":"secret"}}),
        ] {
            request.params = invalid;
            assert!(!validate_business_parameters(&request, connection));
        }
        for path in [
            "/permissions/headers",
            "/permissions/token",
            "/permissions/api_key",
            "/permissions//tokens",
            "permissions/tokens",
            "/permissions/../tokens",
        ] {
            let source = serde_json::to_vec(&serde_json::json!({"version":1,"services":{"runtime":{
                "baseUrl":"http://127.0.0.1:5186", "businessObjectParameters":{"agents.create.v1":[path]}
            }}})).unwrap();
            assert!(parse_registry(&source).is_err());
        }
    }

    #[test]
    fn managed_v2_connections_preserve_scoped_business_policy() {
        let registry = parse_registry(
            br#"{"version":2,"services":{"runtime":{
            "transport":"stdio","executable":"/usr/libexec/bibit-runtime-provider",
            "lifecycle":"managed","protocolVersions":[1,2],
            "businessObjectParameters":{"agents.create.v1":["/permissions/resource_limits/tokens"]}
        }}}"#,
        )
        .unwrap();
        let connection = &registry.services["runtime"];
        assert!(matches!(&connection.transport, ProviderTransport::Stdio {
            lifecycle: StdioLifecycle::Managed, protocol_versions, ..
        } if protocol_versions == &[1, 2]));
        let mut request = ExternalServiceGatewayRequest {
            protocol_version: 1,
            request_id: "expert-v2".into(),
            service_id: "runtime".into(),
            operation_id: "agents.create.v1".into(),
            timeout_ms: 1_000,
            params: serde_json::json!({"permissions":{"resource_limits":{"tokens":{"per_session":20000}}}}),
        };
        assert!(validate_business_parameters(&request, connection));
        request.operation_id = "agents.update.v1".into();
        assert!(!validate_business_parameters(&request, connection));
    }

    #[test]
    fn gateway_errors_are_sanitized_and_correlated() {
        let response = gateway_error("request-1", "unavailable");
        assert_eq!(response.protocol_version, 1);
        assert_eq!(response.request_id, "request-1");
        assert!(!response.ok);
        assert_eq!(response.error.unwrap().code, "unavailable");
    }

    fn feature_service_request(
        feature_id: &str,
        plugin_version: &str,
        feature_instance_token: &str,
        service_id: &str,
        operation_id: &str,
        request_id: &str,
    ) -> FeatureServiceCommandRequest {
        FeatureServiceCommandRequest {
            feature_id: feature_id.into(),
            plugin_version: plugin_version.into(),
            feature_instance_token: feature_instance_token.into(),
            protocol_version: 1,
            request_id: request_id.into(),
            service_id: service_id.into(),
            operation_id: operation_id.into(),
            params: serde_json::json!({}),
            timeout_ms: 1_000,
        }
    }

    fn feature_service_grants(
        feature_id: &str,
        capabilities: &[&str],
        service_id: &str,
        operations: &[&str],
    ) -> crate::feature_capabilities::FeatureCapabilityGrants {
        crate::feature_capabilities::FeatureCapabilityGrants {
            version: 1,
            features: BTreeMap::from([(
                feature_id.into(),
                capabilities
                    .iter()
                    .map(|capability| (*capability).to_owned())
                    .collect(),
            )]),
            service_operations: BTreeMap::from([(
                feature_id.into(),
                BTreeMap::from([(
                    service_id.into(),
                    operations
                        .iter()
                        .map(|operation| (*operation).to_owned())
                        .collect(),
                )]),
            )]),
        }
    }

    #[tokio::test]
    async fn rejects_a_direct_native_request_without_an_authorized_feature_instance() {
        let root = tempfile::TempDir::new().unwrap();
        let response = dispatch_service_request_with_grants(
            root.path(),
            None,
            feature_service_request(
                "unregistered-feature",
                "1.0.0",
                "forged-token",
                "store",
                "agents.list.v1",
                "unauthorized-request",
            ),
            &feature_service_grants(
                "unregistered-feature",
                &["service:store"],
                "store",
                &["agents.list.v1"],
            ),
        )
        .await;

        assert_eq!(response.error.unwrap().code, "unauthorized");
    }

    #[tokio::test]
    async fn authorized_feature_request_reaches_provider_without_identity_secrets() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let feature_id = format!("provider-auth-{}", uuid::Uuid::new_v4());
        let token = crate::trusted_plugins::register_test_feature_instance(
            &feature_id,
            "1.0.0",
            &["service:store"],
        );
        let expected_feature_id = feature_id.clone();
        let expected_token = token.clone();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = vec![0_u8; 16 * 1024];
            let count = socket.read(&mut bytes).await.unwrap();
            let source = String::from_utf8_lossy(&bytes[..count]);
            assert!(!source.contains(&expected_feature_id));
            assert!(!source.contains(&expected_token));
            let body = source.split("\r\n\r\n").nth(1).unwrap();
            let request: ExternalServiceGatewayRequest = serde_json::from_str(body).unwrap();
            let payload = serde_json::to_vec(&ExternalServiceGatewayResponse {
                protocol_version: 1,
                request_id: request.request_id,
                ok: true,
                result: Some(serde_json::json!({"items": ["agent-1"]})),
                error: None,
            })
            .unwrap();
            socket
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        payload.len()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            socket.write_all(&payload).await.unwrap();
        });
        let root = tempfile::TempDir::new().unwrap();
        std::fs::write(
            root.path().join(REGISTRY_FILE),
            format!(
                "{{\"version\":1,\"services\":{{\"store\":{{\"baseUrl\":\"http://{address}\"}}}}}}"
            ),
        )
        .unwrap();

        let response = dispatch_service_request_with_grants(
            root.path(),
            None,
            feature_service_request(
                &feature_id,
                "1.0.0",
                &token,
                "store",
                "agents.list.v1",
                "authorized-provider-request",
            ),
            &feature_service_grants(
                &feature_id,
                &["service:store"],
                "store",
                &["agents.list.v1"],
            ),
        )
        .await;

        if !response.ok {
            server.abort();
        }
        assert!(response.ok);
        assert_eq!(response.result.unwrap()["items"][0], "agent-1");
        server.await.unwrap();
        crate::trusted_plugins::unregister_test_feature_instance(&feature_id);
    }

    #[test]
    fn requires_manifest_capability_runtime_grant_exact_operation_token_and_version() {
        let suffix = uuid::Uuid::new_v4();
        let feature_id = format!("service-auth-{suffix}");
        let token = crate::trusted_plugins::register_test_feature_instance(
            &feature_id,
            "1.0.0",
            &["service:store"],
        );
        let grants = feature_service_grants(
            &feature_id,
            &["service:store"],
            "store",
            &["agents.list.v1"],
        );
        let authorized = feature_service_request(
            &feature_id,
            "1.0.0",
            &token,
            "store",
            "agents.list.v1",
            "authorized",
        );
        assert!(service_request_authorized_with_grants(&authorized, &grants));

        let wrong_token = feature_service_request(
            &feature_id,
            "1.0.0",
            "other-token",
            "store",
            "agents.list.v1",
            "wrong-token",
        );
        assert!(!service_request_authorized_with_grants(
            &wrong_token,
            &grants
        ));
        let wrong_version = feature_service_request(
            &feature_id,
            "2.0.0",
            &token,
            "store",
            "agents.list.v1",
            "wrong-version",
        );
        assert!(!service_request_authorized_with_grants(
            &wrong_version,
            &grants
        ));
        let wrong_operation = feature_service_request(
            &feature_id,
            "1.0.0",
            &token,
            "store",
            "agents.delete.v1",
            "wrong-operation",
        );
        assert!(!service_request_authorized_with_grants(
            &wrong_operation,
            &grants
        ));
        assert!(!service_request_authorized_with_grants(
            &authorized,
            &feature_service_grants(&feature_id, &["service:store"], "store", &[],)
        ));

        let undeclared_id = format!("undeclared-{suffix}");
        let undeclared_token =
            crate::trusted_plugins::register_test_feature_instance(&undeclared_id, "1.0.0", &[]);
        assert!(!service_request_authorized_with_grants(
            &feature_service_request(
                &undeclared_id,
                "1.0.0",
                &undeclared_token,
                "store",
                "agents.list.v1",
                "undeclared",
            ),
            &feature_service_grants(
                &undeclared_id,
                &["service:store"],
                "store",
                &["agents.list.v1"],
            )
        ));

        crate::trusted_plugins::unregister_test_feature_instance(&feature_id);
        crate::trusted_plugins::unregister_test_feature_instance(&undeclared_id);
    }

    #[test]
    fn legacy_service_alias_uses_the_same_native_operation_grant() {
        let feature_id = format!("legacy-auth-{}", uuid::Uuid::new_v4());
        let token = crate::trusted_plugins::register_test_feature_instance(
            &feature_id,
            "1.0.0",
            &["external-service:security"],
        );
        let request = feature_service_request(
            &feature_id,
            "1.0.0",
            &token,
            "security",
            "audit.query.v1",
            "legacy-authorized",
        );
        assert!(service_request_authorized_with_grants(
            &request,
            &feature_service_grants(
                &feature_id,
                &["service:security", "external-service:security"],
                "security",
                &["audit.query.v1"],
            )
        ));
        assert!(!service_request_authorized_with_grants(
            &request,
            &feature_service_grants(
                &feature_id,
                &["service:security", "external-service:security"],
                "security",
                &["audit.verify.v1"],
            )
        ));

        crate::trusted_plugins::unregister_test_feature_instance(&feature_id);
    }

    #[tokio::test]
    async fn scopes_duplicate_request_ids_and_cancellation_to_the_owner() {
        let request_id = format!("shared-{}", uuid::Uuid::new_v4());
        let owner_a = ServiceRequestOwner {
            feature_id: "feature-a".into(),
            plugin_version: "1.0.0".into(),
            feature_instance_token: "instance-a".into(),
        };
        let owner_b = ServiceRequestOwner {
            feature_id: "feature-b".into(),
            plugin_version: "1.0.0".into(),
            feature_instance_token: "instance-b".into(),
        };
        let cancellation_a = CancellationToken::new();
        let cancellation_b = CancellationToken::new();

        assert!(
            register_active_request(
                &owner_a,
                &request_id,
                "store",
                "agents.list.v1",
                cancellation_a.clone(),
            )
            .await
        );
        assert!(
            !register_active_request(
                &owner_a,
                &request_id,
                "store",
                "agents.list.v1",
                CancellationToken::new(),
            )
            .await
        );
        assert!(!cancel_request(&owner_b, "store", "agents.list.v1", &request_id,).await);
        assert!(!cancel_request(&owner_a, "store", "agents.delete.v1", &request_id,).await);
        assert!(!cancellation_a.is_cancelled());
        assert!(
            register_active_request(
                &owner_b,
                &request_id,
                "store",
                "agents.list.v1",
                cancellation_b.clone(),
            )
            .await
        );

        assert!(cancel_request(&owner_b, "store", "agents.list.v1", &request_id,).await);
        assert!(cancellation_b.is_cancelled());
        assert!(!cancellation_a.is_cancelled());

        cancel_feature_requests(&crate::feature_file_grants::FileGrantOwner {
            feature_id: owner_a.feature_id.clone(),
            feature_instance_id: owner_a.feature_instance_token.clone(),
        })
        .await;
        assert!(cancellation_a.is_cancelled());

        remove_active_request(&owner_a, &request_id).await;
        remove_active_request(&owner_b, &request_id).await;
    }

    #[test]
    fn provider_resource_paths_remain_safe_and_relative() {
        assert!(safe_provider_resource_path(
            "transfers/agent-hub/job-1/output.bin"
        ));
        for invalid in [
            "/tmp/output.bin",
            "../output.bin",
            "transfers/../output.bin",
            "C:\\temp\\output.bin",
            "transfers//output.bin",
        ] {
            assert!(!safe_provider_resource_path(invalid), "{invalid}");
        }
    }

    #[test]
    fn system_drop_ins_are_merged_and_user_registry_wins() {
        let root = tempfile::TempDir::new().unwrap();
        let system_dir = root.path().join("system");
        std::fs::create_dir(&system_dir).unwrap();
        std::fs::write(
            system_dir.join("security.json"),
            br#"{"version":1,"services":{"security":{"baseUrl":"http://127.0.0.1:5185"}}}"#,
        )
        .unwrap();
        std::fs::write(
            system_dir.join("store.json"),
            br#"{"version":1,"services":{"store":{"baseUrl":"http://127.0.0.1:5186"}}}"#,
        )
        .unwrap();
        let user_registry = root.path().join(REGISTRY_FILE);
        std::fs::write(
            &user_registry,
            br#"{"version":1,"services":{"security":{"baseUrl":"http://127.0.0.1:6185"}}}"#,
        )
        .unwrap();

        let registry = load_registry_from_sources(&system_dir, &user_registry, None).unwrap();

        let ProviderTransport::Http { base_url, .. } = &registry.services["security"].transport
        else {
            panic!("expected HTTP transport");
        };
        assert_eq!(base_url.as_str(), "http://127.0.0.1:6185/");
        let ProviderTransport::Http { base_url, .. } = &registry.services["store"].transport else {
            panic!("expected HTTP transport");
        };
        assert_eq!(base_url.as_str(), "http://127.0.0.1:5186/");
    }

    #[test]
    fn invalid_drop_in_does_not_hide_valid_services() {
        let root = tempfile::TempDir::new().unwrap();
        let system_dir = root.path().join("system");
        std::fs::create_dir(&system_dir).unwrap();
        std::fs::write(system_dir.join("broken.json"), b"not-json").unwrap();
        std::fs::write(
            system_dir.join("security.json"),
            br#"{"version":1,"services":{"security":{"baseUrl":"http://127.0.0.1:5185"}}}"#,
        )
        .unwrap();

        let registry =
            load_registry_from_sources(&system_dir, &root.path().join(REGISTRY_FILE), None)
                .unwrap();

        assert!(registry.services.contains_key("security"));
    }

    #[test]
    fn debug_registry_overrides_user_registry() {
        let root = tempfile::TempDir::new().unwrap();
        let user_registry = root.path().join(REGISTRY_FILE);
        let debug_registry = root.path().join("debug.json");
        std::fs::write(
            &user_registry,
            br#"{"version":1,"services":{"security":{"baseUrl":"http://127.0.0.1:5185"}}}"#,
        )
        .unwrap();
        std::fs::write(
            &debug_registry,
            br#"{"version":1,"services":{"security":{"baseUrl":"http://127.0.0.1:6185"}}}"#,
        )
        .unwrap();

        let registry = load_registry_from_sources(
            &root.path().join("system"),
            &user_registry,
            Some(&debug_registry),
        )
        .unwrap();

        let ProviderTransport::Http { base_url, .. } = &registry.services["security"].transport
        else {
            panic!("expected HTTP transport");
        };
        assert_eq!(base_url.as_str(), "http://127.0.0.1:6185/");
    }

    #[test]
    fn missing_every_registry_is_unavailable() {
        let root = tempfile::TempDir::new().unwrap();
        assert!(load_registry_from_sources(
            &root.path().join("system"),
            &root.path().join(REGISTRY_FILE),
            None,
        )
        .is_err());
    }

    #[test]
    fn response_validation_rejects_mixed_success_and_error_payloads() {
        let mut response = gateway_error("request-1", "unavailable");
        assert!(valid_response(&response, "request-1"));
        response.result = Some(serde_json::json!({"unexpected": true}));
        assert!(!valid_response(&response, "request-1"));
    }

    #[tokio::test]
    async fn forwards_a_versioned_request_to_a_registered_service() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = vec![0_u8; 16 * 1024];
            let count = socket.read(&mut bytes).await.unwrap();
            let source = String::from_utf8_lossy(&bytes[..count]);
            let body = source.split("\r\n\r\n").nth(1).unwrap();
            let request: ExternalServiceGatewayRequest = serde_json::from_str(body).unwrap();
            let payload = serde_json::to_vec(&ExternalServiceGatewayResponse {
                protocol_version: 1,
                request_id: request.request_id,
                ok: true,
                result: Some(serde_json::json!({"items": ["agent-1"]})),
                error: None,
            })
            .unwrap();
            let headers = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                payload.len()
            );
            socket.write_all(headers.as_bytes()).await.unwrap();
            socket.write_all(&payload).await.unwrap();
        });
        let root = tempfile::TempDir::new().unwrap();
        std::fs::write(
            root.path().join(REGISTRY_FILE),
            format!(
                "{{\"version\":1,\"services\":{{\"store\":{{\"baseUrl\":\"http://{address}\"}}}}}}"
            ),
        )
        .unwrap();

        let response = forward_request(
            root.path(),
            ExternalServiceGatewayRequest {
                protocol_version: 1,
                request_id: "request-1".into(),
                service_id: "store".into(),
                operation_id: "agents.list.v1".into(),
                params: serde_json::json!({}),
                timeout_ms: 1_000,
            },
        )
        .await;
        server.await.unwrap();

        assert!(response.ok);
        assert_eq!(
            response.result,
            Some(serde_json::json!({"items": ["agent-1"]}))
        );
    }

    #[tokio::test]
    async fn cancels_an_active_http_request() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (accepted_tx, accepted_rx) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 4096];
            socket.read(&mut request).await.unwrap();
            let _ = accepted_tx.send(());
            let mut closed = [0_u8; 1];
            let _ = socket.read(&mut closed).await;
        });
        let root = tempfile::TempDir::new().unwrap();
        std::fs::write(
            root.path().join(REGISTRY_FILE),
            format!(
                "{{\"version\":1,\"services\":{{\"security\":{{\"baseUrl\":\"http://{address}\"}}}}}}"
            ),
        )
        .unwrap();
        let data_root = root.path().to_path_buf();
        let request = tokio::spawn(async move {
            forward_request(
                &data_root,
                ExternalServiceGatewayRequest {
                    protocol_version: 1,
                    request_id: "request-cancel".into(),
                    service_id: "security".into(),
                    operation_id: "approval.wait.v1".into(),
                    params: serde_json::json!({}),
                    timeout_ms: 10_000,
                },
            )
            .await
        });
        accepted_rx.await.unwrap();

        assert!(
            cancel_request(
                &test_request_owner(),
                "security",
                "approval.wait.v1",
                "request-cancel",
            )
            .await
        );
        let response = request.await.unwrap();
        server.await.unwrap();
        assert_eq!(response.error.unwrap().code, "cancelled");
        assert!(
            !cancel_request(
                &test_request_owner(),
                "security",
                "approval.wait.v1",
                "request-cancel",
            )
            .await
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn negotiates_and_invokes_a_stdio_provider() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::TempDir::new().unwrap();
        let provider = root.path().join("agenthub-provider");
        std::fs::write(
            &provider,
            r#"#!/bin/sh
read initialize
read invoke
printf '%s\n' '{"jsonrpc":"2.0","id":"request-stdio:initialize","result":{"protocolVersion":1,"providerVersion":"test-1","capabilities":{"invoke":true},"operations":["agents.list.v1"]}}'
printf '%s\n' '{"jsonrpc":"2.0","id":"request-stdio","result":{"items":["agent-stdio"]}}'
"#,
        )
        .unwrap();
        let mut permissions = std::fs::metadata(&provider).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&provider, permissions).unwrap();
        std::fs::write(
            root.path().join(REGISTRY_FILE),
            format!(
                "{{\"version\":2,\"services\":{{\"store\":{{\"transport\":\"stdio\",\"executable\":{},\"lifecycle\":\"oneShot\",\"protocolVersions\":[1]}}}}}}",
                serde_json::to_string(&provider).unwrap()
            ),
        )
        .unwrap();

        let response = forward_request(
            root.path(),
            ExternalServiceGatewayRequest {
                protocol_version: 1,
                request_id: "request-stdio".into(),
                service_id: "store".into(),
                operation_id: "agents.list.v1".into(),
                params: serde_json::json!({}),
                timeout_ms: 1_000,
            },
        )
        .await;

        assert!(response.ok);
        assert_eq!(
            response.result,
            Some(serde_json::json!({"items": ["agent-stdio"]}))
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn reuses_a_managed_stdio_provider_across_requests() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::TempDir::new().unwrap();
        let provider = root.path().join("managed-agenthub-provider");
        let launches = root.path().join("launches");
        std::fs::write(
            &provider,
            r#"#!/bin/sh
printf '%s\n' "$$" >> "$1"
read initialize
printf '%s\n' '{"jsonrpc":"2.0","id":"request-managed-1:initialize","result":{"protocolVersion":1,"providerVersion":"test-1","capabilities":{"invoke":true},"operations":["agents.list.v1"]}}'
read invoke
printf '%s\n' '{"jsonrpc":"2.0","id":"request-managed-1","result":{"items":["first"]}}'
read invoke
printf '%s\n' '{"jsonrpc":"2.0","id":"request-managed-2","result":{"items":["second"]}}'
read shutdown
"#,
        )
        .unwrap();
        let mut permissions = std::fs::metadata(&provider).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&provider, permissions).unwrap();
        std::fs::write(
            root.path().join(REGISTRY_FILE),
            format!(
                "{{\"version\":2,\"services\":{{\"managed-test\":{{\"transport\":\"stdio\",\"executable\":{},\"args\":[{}],\"lifecycle\":\"managed\",\"protocolVersions\":[1]}}}}}}",
                serde_json::to_string(&provider).unwrap(),
                serde_json::to_string(&launches).unwrap()
            ),
        )
        .unwrap();

        for (request_id, expected) in [
            ("request-managed-1", "first"),
            ("request-managed-2", "second"),
        ] {
            let response = forward_request(
                root.path(),
                ExternalServiceGatewayRequest {
                    protocol_version: 1,
                    request_id: request_id.into(),
                    service_id: "managed-test".into(),
                    operation_id: "agents.list.v1".into(),
                    params: serde_json::json!({}),
                    timeout_ms: 1_000,
                },
            )
            .await;
            assert!(response.ok);
            assert_eq!(response.result.unwrap()["items"][0], expected);
        }
        assert_eq!(
            std::fs::read_to_string(launches).unwrap().lines().count(),
            1
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn notifies_and_reaps_a_cancelled_managed_provider() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::TempDir::new().unwrap();
        let provider = root.path().join("managed-cancel-provider");
        let marker = root.path().join("invoke-received");
        let cancellation = root.path().join("cancellation");
        std::fs::write(
            &provider,
            r#"#!/bin/sh
read initialize
printf '%s\n' '{"jsonrpc":"2.0","id":"request-managed-cancel:initialize","result":{"protocolVersion":1,"providerVersion":"test-1","capabilities":{"invoke":true},"operations":["jobs.wait.v1"]}}'
read invoke
printf '%s' 'ready' > "$1"
read cancel
printf '%s' "$cancel" > "$2"
"#,
        )
        .unwrap();
        let mut permissions = std::fs::metadata(&provider).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&provider, permissions).unwrap();
        std::fs::write(
            root.path().join(REGISTRY_FILE),
            format!(
                "{{\"version\":2,\"services\":{{\"managed-cancel\":{{\"transport\":\"stdio\",\"executable\":{},\"args\":[{},{}],\"lifecycle\":\"managed\",\"protocolVersions\":[1]}}}}}}",
                serde_json::to_string(&provider).unwrap(),
                serde_json::to_string(&marker).unwrap(),
                serde_json::to_string(&cancellation).unwrap()
            ),
        )
        .unwrap();
        let data_root = root.path().to_path_buf();
        let request = tokio::spawn(async move {
            forward_request(
                &data_root,
                ExternalServiceGatewayRequest {
                    protocol_version: 1,
                    request_id: "request-managed-cancel".into(),
                    service_id: "managed-cancel".into(),
                    operation_id: "jobs.wait.v1".into(),
                    params: serde_json::json!({}),
                    timeout_ms: 10_000,
                },
            )
            .await
        });
        for _ in 0..100 {
            if marker.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(marker.exists());
        assert!(
            cancel_request(
                &test_request_owner(),
                "managed-cancel",
                "jobs.wait.v1",
                "request-managed-cancel",
            )
            .await
        );

        let response = request.await.unwrap();
        assert_eq!(response.error.unwrap().code, "cancelled");
        let notification = std::fs::read_to_string(cancellation).unwrap();
        assert!(notification.contains("\"method\":\"bibit.cancel\""));
        assert!(notification.contains("request-managed-cancel"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn multiplexes_v2_jobs_and_invoke_until_host_finalization() {
        use crate::feature_file_grants::{
            FeatureFileGrantService, FileGrantDirection, FileGrantOwner,
        };
        use crate::feature_service_jobs::{FeatureServiceJobRegistry, JobStatus, StartJobRequest};
        use std::{os::unix::fs::PermissionsExt, sync::Arc};

        let root = tempfile::TempDir::new().unwrap();
        let provider = root.path().join("managed-v2-provider.py");
        std::fs::write(
            &provider,
            r#"#!/usr/bin/python3
import json, sys
for line in sys.stdin:
    message = json.loads(line)
    method = message.get("method")
    request_id = message.get("id")
    if method == "bibit.initialize":
        result = {"protocolVersion": 2, "providerVersion": "test-2", "capabilities": {"invoke": True, "jobs": True, "cancellation": True, "maxConcurrentJobs": 1}, "operations": ["agents.list.v1", "agents.upload.v1"]}
        print(json.dumps({"jsonrpc": "2.0", "id": request_id, "result": result}), flush=True)
    elif method == "bibit.invoke":
        print(json.dumps({"jsonrpc": "2.0", "id": request_id, "result": {"items": ["demo-agent"]}}), flush=True)
    elif method == "bibit.job.start":
        params = message["params"]
        job_id = params["jobId"]
        size = params["resources"][0]["byteLength"]
        print(json.dumps({"jsonrpc": "2.0", "id": request_id, "result": {"jobId": job_id, "accepted": True}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "bibit.jobEvent", "params": {"serviceId": "agenthub-test-v2", "jobId": job_id, "providerSequence": 1, "kind": "progress", "progress": {"completedBytes": size, "totalBytes": size}}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "bibit.jobEvent", "params": {"serviceId": "agenthub-test-v2", "jobId": job_id, "providerSequence": 2, "kind": "result_ready", "result": {"output": {"agentId": "demo-agent"}}}}), flush=True)
    elif method == "bibit.shutdown":
        break
"#,
        )
        .unwrap();
        let mut permissions = std::fs::metadata(&provider).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&provider, permissions).unwrap();
        std::fs::write(
            root.path().join(REGISTRY_FILE),
            format!(
                "{{\"version\":2,\"services\":{{\"agenthub-test-v2\":{{\"transport\":\"stdio\",\"executable\":{},\"lifecycle\":\"managed\",\"protocolVersions\":[1,2]}}}}}}",
                serde_json::to_string(&provider).unwrap()
            ),
        )
        .unwrap();

        let source = root.path().join("sample.demo-agent");
        std::fs::write(&source, b"opaque demo package").unwrap();
        let owner = FileGrantOwner {
            feature_id: "agenthub-test".into(),
            feature_instance_id: "instance-test".into(),
        };
        let grants = Arc::new(FeatureFileGrantService::new(root.path().into()).unwrap());
        let grant = grants
            .register_selected_path(
                owner.clone(),
                "agenthub-test-v2",
                "agents.upload.v1",
                FileGrantDirection::Upload,
                source,
            )
            .unwrap();
        let jobs = Arc::new(FeatureServiceJobRegistry::new(grants));
        let snapshot = start_service_job(
            root.path(),
            Arc::clone(&jobs),
            StartJobRequest {
                owner: owner.clone(),
                service_id: "agenthub-test-v2".into(),
                operation_id: "agents.upload.v1".into(),
                idempotency_key: "upload-test".into(),
                grant_id: grant.grant_id,
                direction: FileGrantDirection::Upload,
                input: serde_json::json!({"displayName": "demo-agent"}),
            },
        )
        .await
        .unwrap();

        let response = forward_request_with_jobs(
            root.path(),
            test_request_owner(),
            ExternalServiceGatewayRequest {
                protocol_version: 1,
                request_id: "list-during-v2-job".into(),
                service_id: "agenthub-test-v2".into(),
                operation_id: "agents.list.v1".into(),
                params: serde_json::json!({}),
                timeout_ms: 1_000,
            },
            Some(Arc::clone(&jobs)),
        )
        .await;
        assert!(response.ok);
        assert_eq!(response.result.unwrap()["items"][0], "demo-agent");

        for _ in 0..100 {
            if jobs.snapshot(&owner, &snapshot.job_id).unwrap().status == JobStatus::Succeeded {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let terminal = jobs.snapshot(&owner, &snapshot.job_id).unwrap();
        assert_eq!(terminal.status, JobStatus::Succeeded);
        assert_eq!(terminal.result.unwrap()["agentId"], "demo-agent");
        terminate_managed_service("agenthub-test-v2").await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancels_a_v2_job_and_reuses_the_session_for_settings() {
        use crate::feature_file_grants::{
            FeatureFileGrantService, FileGrantDirection, FileGrantOwner,
        };
        use crate::feature_service_jobs::{FeatureServiceJobRegistry, JobStatus, StartJobRequest};
        use std::{os::unix::fs::PermissionsExt, sync::Arc};

        let root = tempfile::TempDir::new().unwrap();
        let provider = root.path().join("managed-v2-cancel.py");
        std::fs::write(
            &provider,
            r#"#!/usr/bin/python3
import json, sys
for line in sys.stdin:
    message = json.loads(line)
    method = message.get("method")
    request_id = message.get("id")
    if method == "bibit.initialize":
        result = {"protocolVersion": 2, "providerVersion": "test-2", "capabilities": {"invoke": True, "jobs": True, "cancellation": True, "maxConcurrentJobs": 1}, "operations": ["agents.upload.v1", "settings.get.v1"]}
        print(json.dumps({"jsonrpc": "2.0", "id": request_id, "result": result}), flush=True)
    elif method == "bibit.job.start":
        job_id = message["params"]["jobId"]
        print(json.dumps({"jsonrpc": "2.0", "id": request_id, "result": {"jobId": job_id, "accepted": True}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "bibit.jobEvent", "params": {"serviceId": "agenthub-cancel-v2", "jobId": job_id, "providerSequence": 1, "kind": "progress", "progress": {"completedBytes": 1}}}), flush=True)
    elif method == "bibit.job.cancel":
        job_id = message["params"]["jobId"]
        print(json.dumps({"jsonrpc": "2.0", "id": request_id, "result": {"jobId": job_id, "accepted": True}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "bibit.jobEvent", "params": {"serviceId": "agenthub-cancel-v2", "jobId": job_id, "providerSequence": 2, "kind": "cancelled"}}), flush=True)
    elif method == "bibit.invoke":
        print(json.dumps({"jsonrpc": "2.0", "id": request_id, "result": {"refreshMinutes": 15}}), flush=True)
    elif method == "bibit.shutdown":
        break
"#,
        )
        .unwrap();
        let mut permissions = std::fs::metadata(&provider).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&provider, permissions).unwrap();
        std::fs::write(
            root.path().join(REGISTRY_FILE),
            format!(
                "{{\"version\":2,\"services\":{{\"agenthub-cancel-v2\":{{\"transport\":\"stdio\",\"executable\":{},\"lifecycle\":\"managed\",\"protocolVersions\":[1,2]}}}}}}",
                serde_json::to_string(&provider).unwrap()
            ),
        )
        .unwrap();
        let source = root.path().join("sample.bin");
        std::fs::write(&source, b"cancel me").unwrap();
        let owner = FileGrantOwner {
            feature_id: "agenthub-cancel".into(),
            feature_instance_id: "instance-cancel".into(),
        };
        let grants = Arc::new(FeatureFileGrantService::new(root.path().into()).unwrap());
        let grant = grants
            .register_selected_path(
                owner.clone(),
                "agenthub-cancel-v2",
                "agents.upload.v1",
                FileGrantDirection::Upload,
                source,
            )
            .unwrap();
        let jobs = Arc::new(FeatureServiceJobRegistry::new(grants));
        let started = start_service_job(
            root.path(),
            Arc::clone(&jobs),
            StartJobRequest {
                owner: owner.clone(),
                service_id: "agenthub-cancel-v2".into(),
                operation_id: "agents.upload.v1".into(),
                idempotency_key: "cancel-test".into(),
                grant_id: grant.grant_id,
                direction: FileGrantDirection::Upload,
                input: serde_json::json!({}),
            },
        )
        .await
        .unwrap();
        assert_eq!(started.status, JobStatus::Running);
        assert!(
            jobs.cancel(&owner, &started.job_id)
                .unwrap()
                .provider_cancel_required
        );
        cancel_service_job("agenthub-cancel-v2", &started.job_id)
            .await
            .unwrap();
        assert_eq!(
            jobs.snapshot(&owner, &started.job_id).unwrap().status,
            JobStatus::Cancelled
        );

        let response = forward_request_with_jobs(
            root.path(),
            test_request_owner(),
            ExternalServiceGatewayRequest {
                protocol_version: 1,
                request_id: "settings-after-cancel".into(),
                service_id: "agenthub-cancel-v2".into(),
                operation_id: "settings.get.v1".into(),
                params: serde_json::json!({}),
                timeout_ms: 1_000,
            },
            Some(jobs),
        )
        .await;
        assert!(response.ok);
        assert_eq!(response.result.unwrap()["refreshMinutes"], 15);
        terminate_managed_service("agenthub-cancel-v2").await;
    }

    #[tokio::test]
    async fn rejects_an_oversized_response_before_buffering_it() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 4096];
            socket.read(&mut request).await.unwrap();
            socket
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        MAX_RESPONSE_BYTES + 1
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        });
        let root = tempfile::TempDir::new().unwrap();
        std::fs::write(
            root.path().join(REGISTRY_FILE),
            format!(
                "{{\"version\":1,\"services\":{{\"store\":{{\"baseUrl\":\"http://{address}\"}}}}}}"
            ),
        )
        .unwrap();

        let response = forward_request(
            root.path(),
            ExternalServiceGatewayRequest {
                protocol_version: 1,
                request_id: "request-large".into(),
                service_id: "store".into(),
                operation_id: "agents.list.v1".into(),
                params: serde_json::json!({}),
                timeout_ms: 1_000,
            },
        )
        .await;
        server.await.unwrap();

        assert!(!response.ok);
        assert_eq!(response.error.unwrap().code, "resource_exhausted");
    }
}
