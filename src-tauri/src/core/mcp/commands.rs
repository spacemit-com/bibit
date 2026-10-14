use futures_util::{stream::FuturesUnordered, StreamExt};
use rmcp::model::{CallToolRequestParam, CallToolResult};
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tokio::sync::oneshot;
use tokio::time::{timeout_at, Instant};
use tokio_util::sync::CancellationToken;

use super::{
    constants::DEFAULT_MCP_CONFIG,
    helpers::{restart_active_mcp_servers, start_mcp_server, terminate_browser_mcp},
    service::{remove_generation, McpServerHandle},
};
use crate::core::{
    app::commands::get_jan_data_folder_path,
    mcp::models::{McpSettings, ServerSummary},
    state::AppState,
};
use crate::core::{mcp::models::ToolWithServer, state::SharedMcpServers};
use std::{collections::HashSet, fs, time::Duration};

async fn tool_call_timeout(state: &AppState) -> Duration {
    state.mcp_settings.lock().await.tool_call_timeout_duration()
}

/// Shared implementation for listing MCP tools.
///
/// - `server_filter: None` — every enabled server (same behavior as `get_tools`).
/// - `server_filter: Some(names)` — only enabled servers in that set; unknown names
///   are skipped (logged).
///
/// A server counts as "enabled" if it's in `mcp_active_servers`, regardless of
/// whether it's currently connected — a transiently disconnected server still
/// contributes its last successfully listed tools (`mcp_last_known_tools`), so
/// the tool schema Jan sends stays present and stable across reconnects instead
/// of shrinking/growing and invalidating the downstream KV-cache prefix.
/// `mcp_last_known_tools` is only cleared by explicit user deactivation
/// (`deactivate_mcp_server`), never by a transient list-tools failure here.
async fn collect_mcp_tools<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppState,
    server_filter: Option<HashSet<String>>,
) -> Result<Vec<ToolWithServer>, String> {
    let started = Instant::now();
    let timeout_duration = tool_call_timeout(state).await;
    let deadline = started + timeout_duration;
    let cancel = CancellationToken::new();
    let _cancel_on_drop = cancel.clone().drop_guard();
    let mut all_tools: Vec<ToolWithServer> = Vec::new();
    let mut removed_any = false;

    let server_names: Vec<String> = {
        let active_servers = state.mcp_active_servers.lock().await;
        match &server_filter {
            None => active_servers.keys().cloned().collect(),
            Some(filter) => {
                for name in filter {
                    if !active_servers.contains_key(name) {
                        log::debug!(
                            "collect_mcp_tools: requested server {name:?} is not enabled; skipping"
                        );
                    }
                }
                filter
                    .iter()
                    .filter(|n| active_servers.contains_key(*n))
                    .cloned()
                    .collect()
            }
        }
    };

    let servers = timeout_at(deadline, async { state.mcp_servers.lock().await.clone() })
        .await
        .map_err(|_| "MCP tools admission timed out".to_string())?;
    let mut listings: FuturesUnordered<_> = server_names
        .into_iter()
        .map(|server_name| {
            let service = servers.get(&server_name).cloned();
            let cancel = cancel.clone();
            async move {
                let result = match &service {
                    Some(service) => Some(service.list_all_tools(deadline, &cancel).await),
                    None => None,
                };
                (server_name, service, result)
            }
        })
        .collect();

    while let Some((server_name, service, maybe_list_result)) = listings.next().await {
        let fresh_tools = match maybe_list_result {
            Some(Ok(tools)) => {
                let mapped: Vec<ToolWithServer> = tools
                    .into_iter()
                    .map(|tool| ToolWithServer {
                        name: tool.name.to_string(),
                        description: tool.description.as_ref().map(|d| d.to_string()),
                        input_schema: serde_json::Value::Object((*tool.input_schema).clone()),
                        server: server_name.clone(),
                    })
                    .collect();
                let active = state.mcp_active_servers.lock().await;
                let mut last_known = state.mcp_last_known_tools.lock().await;
                let live = state.mcp_servers.lock().await;
                if active.contains_key(&server_name)
                    && live
                        .get(&server_name)
                        .zip(service.as_ref())
                        .is_some_and(|(current, listed)| current.generation == listed.generation)
                {
                    last_known.insert(server_name.clone(), mapped.clone());
                    Some(mapped)
                } else {
                    None
                }
            }
            Some(Err(e)) => {
                let err_str = e.to_string();
                log::warn!("MCP server {server_name} failed to list tools: {err_str}");
                if service.as_ref().is_some_and(McpServerHandle::is_closed)
                    || is_transport_error(&err_str)
                {
                    if remove_generation(
                        &state.mcp_servers,
                        &server_name,
                        service.as_ref().unwrap().generation,
                    )
                    .await
                    .is_some()
                    {
                        removed_any = true;
                    }
                    state.mcp_reconnect_notify.notify_waiters();
                }
                None
            }
            None => {
                log::debug!(
                    "collect_mcp_tools: server {server_name:?} not connected; using last-known tools if any"
                );
                None
            }
        };

        let tools = match fresh_tools {
            Some(tools) => tools,
            None => {
                let last_known = state.mcp_last_known_tools.lock().await;
                last_known.get(&server_name).cloned().unwrap_or_default()
            }
        };
        if state
            .mcp_active_servers
            .lock()
            .await
            .contains_key(&server_name)
        {
            all_tools.extend(tools);
        }
    }

    if removed_any {
        if let Err(e) = app.emit("mcp-update", json!({ "server": "tools-refresh" })) {
            log::error!("Failed to emit mcp-update event: {e}");
        }
    }

    Ok(all_tools)
}

fn is_transport_error(error: &str) -> bool {
    let lower = error.to_lowercase();
    lower.contains("transport closed")
        || lower.contains("broken pipe")
        || lower.contains("connection reset")
        || lower.contains("channel closed")
        || lower.contains("transport error")
}

struct ToolCancellationRegistration {
    receiver: oneshot::Receiver<()>,
    token: Option<String>,
    cancellations:
        std::sync::Arc<tokio::sync::Mutex<std::collections::HashMap<String, oneshot::Sender<()>>>>,
}

impl Drop for ToolCancellationRegistration {
    fn drop(&mut self) {
        self.receiver.close();
        if let Some(token) = self.token.take() {
            let cancellations = self.cancellations.clone();
            tokio::spawn(async move {
                let mut cancellations = cancellations.lock().await;
                if cancellations
                    .get(&token)
                    .is_some_and(oneshot::Sender::is_closed)
                {
                    cancellations.remove(&token);
                }
            });
        }
    }
}

#[tauri::command]
pub async fn activate_mcp_server<R: Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, AppState>,
    name: String,
    config: Value,
) -> Result<(), String> {
    let servers: SharedMcpServers = state.mcp_servers.clone();

    // Use the modified start_mcp_server that returns first attempt result
    start_mcp_server(app, servers, name, config).await
}

#[tauri::command]
pub async fn deactivate_mcp_server<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    name: String,
) -> Result<(), String> {
    log::info!("Deactivating MCP server: {name}");

    let stopping = super::service::McpGeneration::default();
    stopping.stop.cancel();
    let (service, child_pid, bridge_port) = {
        let mut starts = state.mcp_starting.lock().await;
        if starts
            .get(&name)
            .is_some_and(|current| current.stop.is_cancelled())
        {
            return Err(format!("MCP server {name} is already stopping"));
        }
        if let Some(previous) = starts.insert(name.clone(), stopping.clone()) {
            previous.stop.cancel();
        }
        let config = state.mcp_active_servers.lock().await.remove(&name);
        let port = if name == "Jan Browser MCP" {
            config
                .as_ref()
                .and_then(|config| config.get("env"))
                .and_then(|env| env.get("BRIDGE_PORT"))
                .and_then(Value::as_str)
                .and_then(|port| port.parse::<u16>().ok())
        } else {
            None
        };
        if let Some(monitor) = state.mcp_monitoring_tasks.lock().await.remove(&name) {
            monitor.abort();
        }
        let service = state.mcp_servers.lock().await.remove(&name);
        if let Some(service) = &service {
            service.stop();
        }
        let pid = state.mcp_server_pids.lock().await.remove(&name);
        state.mcp_last_known_tools.lock().await.remove(&name);
        (service, pid, port)
    };
    let mut finish_stop = super::helpers::McpStartGuard {
        starts: state.mcp_starting.clone(),
        name: name.clone(),
        generation: stopping,
        armed: true,
    };
    if let Some(service) = service {
        service.stopped().await;
    }
    // Reap the process group and confirm the port is released, then drop the lock.
    if name == "Jan Browser MCP" {
        if let Some(port) = bridge_port {
            use crate::core::mcp::lockfile::delete_lock_file;

            terminate_browser_mcp(child_pid, port).await;

            if let Err(e) = delete_lock_file(&app, port) {
                log::warn!("Failed to delete lock file for port {}: {}", port, e);
            }
        }
    }
    {
        let mut starts = state.mcp_starting.lock().await;
        if starts
            .get(&name)
            .is_some_and(|current| current.id == finish_stop.generation.id)
        {
            starts.remove(&name);
        }
    }
    finish_stop.armed = false;

    log::info!("Server {name} stopped successfully and marked as deactivated.");

    // Emit mcp-update event so frontend can refresh tools list
    if let Err(e) = app.emit(
        "mcp-update",
        serde_json::json!({
            "server": name
        }),
    ) {
        log::error!("Failed to emit mcp-update event: {e}");
    }

    Ok(())
}

#[tauri::command]
pub async fn restart_mcp_servers<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    use super::helpers::{stop_mcp_servers_with_context, ShutdownContext};

    let servers = state.mcp_servers.clone();

    stop_mcp_servers_with_context(&app, &state, ShutdownContext::ManualRestart).await?;

    // Restart only previously active servers (like cortex)
    restart_active_mcp_servers(&app, servers).await?;

    app.emit("mcp-update", "MCP servers updated")
        .map_err(|e| format!("Failed to emit event: {e}"))?;

    Ok(())
}

#[tauri::command]
pub async fn get_connected_servers(
    _app: AppHandle<impl Runtime>,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let servers = state.mcp_servers.clone();
    let servers_map = servers.lock().await;
    Ok(servers_map.keys().cloned().collect())
}

/// Retrieves all available tools from all MCP servers with server information
///
/// # Arguments
/// * `state` - Application state containing MCP server connections
///
/// # Returns
/// * `Result<Vec<Tool>, String>` - A vector of all tools if successful, or an error message if failed
///
/// This function:
/// 1. Locks the MCP servers mutex to access server connections
/// 2. Iterates through all connected servers
/// 3. Gets the list of tools from each server
/// 4. Associates each tool with its parent server name
/// 5. Combines all tools into a single vector
/// 6. Returns the combined list of all available tools with server information
#[tauri::command]
pub async fn get_tools<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
) -> Result<Vec<ToolWithServer>, String> {
    collect_mcp_tools(&app, &state, None).await
}

/// Retrieves tools from a specific subset of MCP servers by name.
/// Unknown or disconnected names are ignored; transport failures match `get_tools` cleanup.
#[tauri::command]
pub async fn get_tools_for_servers<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    server_names: Vec<String>,
) -> Result<Vec<ToolWithServer>, String> {
    let mut seen = HashSet::new();
    let mut unique: Vec<String> = Vec::new();
    for n in server_names {
        if seen.insert(n.clone()) {
            unique.push(n);
        }
    }
    let filter: HashSet<String> = unique.into_iter().collect();
    if filter.is_empty() {
        return Ok(Vec::new());
    }
    collect_mcp_tools(&app, &state, Some(filter)).await
}

/// Returns name, capability tags, and description for all enabled MCP servers
/// (regardless of live connection state — see `collect_mcp_tools`).
#[tauri::command]
pub async fn get_server_summaries(
    state: State<'_, AppState>,
) -> Result<Vec<ServerSummary>, String> {
    let active_servers = state.mcp_active_servers.lock().await;
    let mut summaries = Vec::new();

    for name in active_servers.keys() {
        let config = active_servers.get(name);

        let capabilities: Vec<String> = config
            .and_then(|c| c.get("capabilities"))
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();

        let description: String = config
            .and_then(|c| c.get("description"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        summaries.push(ServerSummary {
            name: name.clone(),
            capabilities,
            description,
        });
    }

    Ok(summaries)
}

/// Calls a tool on an MCP server by name with optional arguments
///
/// # Arguments
/// * `state` - Application state containing MCP server connections
/// * `tool_name` - Name of the tool to call
/// * `server_name` - Optional name of the server to call the tool from (for disambiguation)
/// * `arguments` - Optional map of argument names to values
/// * `cancellation_token` - Optional token to allow cancellation from JS side
///
/// # Returns
/// * `Result<CallToolResult, String>` - Result of the tool call if successful, or error message if failed
///
/// This function:
/// 1. Locks the MCP servers mutex to access server connections
/// 2. If server_name is provided, looks for the tool in that specific server
/// 3. Otherwise, searches through all servers for one containing the named tool
/// 4. When found, calls the tool on that server with the provided arguments
/// 5. Supports cancellation via cancellation_token
/// 6. Returns error if no server has the requested tool or if specified server not found
#[tauri::command]
pub async fn call_tool(
    state: State<'_, AppState>,
    tool_name: String,
    server_name: Option<String>,
    arguments: Option<Map<String, Value>>,
    cancellation_token: Option<String>,
) -> Result<CallToolResult, String> {
    let started = Instant::now();
    let timeout_duration = tool_call_timeout(&state).await;
    let deadline = started + timeout_duration;
    let cancel = CancellationToken::new();
    let _cancel_on_drop = cancel.clone().drop_guard();
    // Set up cancellation if token is provided
    let (cancel_tx, cancel_rx) = oneshot::channel::<()>();

    if let Some(token) = &cancellation_token {
        let mut cancellations = state.tool_call_cancellations.lock().await;
        if cancellations
            .get(token)
            .is_some_and(|sender| !sender.is_closed())
        {
            return Err(format!("Cancellation token {token} is already in use"));
        }
        cancellations.insert(token.clone(), cancel_tx);
    }
    let mut registration = ToolCancellationRegistration {
        receiver: cancel_rx,
        token: cancellation_token.clone(),
        cancellations: state.tool_call_cancellations.clone(),
    };

    let operation = async {
        let servers: Vec<_> = state
            .mcp_servers
            .lock()
            .await
            .iter()
            .filter(|(name, _)| server_name.as_ref().is_none_or(|server| *name == server))
            .map(|(name, service)| (name.clone(), service.clone()))
            .collect();
        if servers.is_empty() {
            return Err(match &server_name {
                Some(server) => format!("Server '{server}' not found"),
                None => format!("Tool {tool_name} not found — no MCP servers connected"),
            });
        }
        let mut listings: FuturesUnordered<_> = servers
            .into_iter()
            .map(|(name, service)| {
                let cancel = cancel.clone();
                async move {
                    let tools = service.list_all_tools(deadline, &cancel).await;
                    (name, service, tools)
                }
            })
            .collect();
        let mut failures = Vec::new();
        while let Some((name, service, tools)) = listings.next().await {
            match tools {
                Ok(tools) if tools.iter().any(|tool| tool.name == tool_name) => {
                    drop(listings);
                    return service
                        .call_tool(
                            CallToolRequestParam {
                                name: tool_name.clone().into(),
                                arguments,
                            },
                            deadline,
                            &cancel,
                        )
                        .await
                        .map_err(|error| error.to_string());
                }
                Ok(_) => {}
                Err(error) => {
                    if service.is_closed() {
                        remove_generation(&state.mcp_servers, &name, service.generation).await;
                        state.mcp_reconnect_notify.notify_waiters();
                    }
                    failures.push(format!("{name}: {error}"));
                }
            }
        }
        if failures.is_empty() {
            Err(format!("Tool {tool_name} not found"))
        } else {
            Err(format!(
                "MCP tool discovery failed: {}",
                failures.join(", ")
            ))
        }
    };
    let result = tokio::select! {
        biased;
        _ = &mut registration.receiver, if cancellation_token.is_some() => Err(format!("Tool call '{tool_name}' was cancelled")),
        result = timeout_at(deadline, operation) => result.unwrap_or_else(|_| Err(format!(
            "Tool call '{tool_name}' timed out after {} seconds", timeout_duration.as_secs()
        ))),
    };
    cancel.cancel();
    if result
        .as_ref()
        .err()
        .is_some_and(|error| is_transport_error(error))
    {
        state.mcp_reconnect_notify.notify_waiters();
    }
    result
}

/// Cancels a running tool call by its cancellation token
///
/// # Arguments
/// * `state` - Application state containing cancellation tokens
/// * `cancellation_token` - Token identifying the tool call to cancel
///
/// # Returns
/// * `Result<(), String>` - Success if token found and cancelled, error otherwise
#[tauri::command]
pub async fn cancel_tool_call(
    state: State<'_, AppState>,
    cancellation_token: String,
) -> Result<(), String> {
    let mut cancellations = state.tool_call_cancellations.lock().await;

    if let Some(cancel_tx) = cancellations.remove(&cancellation_token) {
        // Send cancellation signal - ignore if receiver is already dropped
        let _ = cancel_tx.send(());
        println!("Tool call with token {cancellation_token} cancelled");
        Ok(())
    } else {
        Err(format!("Cancellation token {cancellation_token} not found"))
    }
}

fn parse_mcp_settings(value: Option<&Value>) -> McpSettings {
    value
        .and_then(|v| serde_json::from_value::<McpSettings>(v.clone()).ok())
        .unwrap_or_default()
}

#[tauri::command]
pub async fn get_mcp_configs<R: Runtime>(app: AppHandle<R>) -> Result<String, String> {
    let mut path = get_jan_data_folder_path(app.clone());
    path.push("mcp_config.json");

    // Create default empty config if file doesn't exist
    if !path.exists() {
        log::info!("mcp_config.json not found, creating default empty config");
        fs::write(&path, DEFAULT_MCP_CONFIG)
            .map_err(|e| format!("Failed to create default MCP config: {e}"))?;
    }

    let config_string = fs::read_to_string(&path).map_err(|e| e.to_string())?;

    let mut config_value: Value = if config_string.trim().is_empty() {
        json!({})
    } else {
        serde_json::from_str(&config_string).unwrap_or_else(|error| {
            log::error!("Failed to parse existing MCP config, regenerating defaults: {error}");
            json!({})
        })
    };

    if !config_value.is_object() {
        config_value = json!({});
    }

    let mut mutated = false;
    let config_object = config_value.as_object_mut().unwrap();

    let settings = parse_mcp_settings(config_object.get("mcpSettings"));
    if !config_object.contains_key("mcpSettings") {
        config_object.insert(
            "mcpSettings".to_string(),
            serde_json::to_value(&settings)
                .map_err(|e| format!("Failed to serialize MCP settings: {e}"))?,
        );
        mutated = true;
    }

    if !config_object.contains_key("mcpServers") {
        config_object.insert("mcpServers".to_string(), json!({}));
        mutated = true;
    }

    // Persist any mutations back to disk
    if mutated {
        fs::write(
            &path,
            serde_json::to_string_pretty(&config_value)
                .map_err(|e| format!("Failed to serialize MCP config: {e}"))?,
        )
        .map_err(|e| format!("Failed to write MCP config: {e}"))?;
    }

    // Update in-memory state with latest settings
    {
        let state = app.state::<AppState>();
        let mut settings_guard = state.mcp_settings.lock().await;
        *settings_guard = settings.clone();
    }

    serde_json::to_string_pretty(&config_value)
        .map_err(|e| format!("Failed to serialize MCP config: {e}"))
}

#[tauri::command]
pub async fn save_mcp_configs<R: Runtime>(
    app: AppHandle<R>,
    configs: String,
) -> Result<(), String> {
    let mut path = get_jan_data_folder_path(app.clone());
    path.push("mcp_config.json");
    log::info!("save mcp configs, path: {path:?}");

    let mut config_value: Value =
        serde_json::from_str(&configs).map_err(|e| format!("Invalid MCP config payload: {e}"))?;

    if !config_value.is_object() {
        return Err("MCP config must be a JSON object".to_string());
    }

    let config_object = config_value.as_object_mut().unwrap();
    let settings = parse_mcp_settings(config_object.get("mcpSettings"));

    if !config_object.contains_key("mcpSettings") {
        config_object.insert(
            "mcpSettings".to_string(),
            serde_json::to_value(&settings).expect("Failed to serialize MCP settings"),
        );
    }

    if !config_object.contains_key("mcpServers") {
        config_object.insert("mcpServers".to_string(), json!({}));
    }

    fs::write(
        &path,
        serde_json::to_string_pretty(&config_value)
            .map_err(|e| format!("Failed to serialize MCP config: {e}"))?,
    )
    .map_err(|e| e.to_string())?;

    {
        let state = app.state::<AppState>();
        let mut settings_guard = state.mcp_settings.lock().await;
        *settings_guard = settings;
    }

    Ok(())
}
