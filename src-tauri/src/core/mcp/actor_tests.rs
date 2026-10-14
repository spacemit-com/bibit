use std::time::Duration;

use rmcp::{
    model::{
        CallToolRequestParam, CallToolResult, Content, ListToolsResult, PaginatedRequestParam,
        ServerCapabilities, ServerInfo,
    },
    service::{RequestContext, RunningService},
    transport::async_rw::AsyncRwTransport,
    ErrorData, RoleServer, ServerHandler, ServiceExt,
};
use tauri::{test::mock_app, Manager};
use tokio::{
    sync::mpsc,
    time::{timeout, Instant},
};
use tokio_util::sync::CancellationToken;

use super::{
    commands,
    service::{remove_generation, McpServerHandle, McpTransport},
};
use crate::core::state::{AppState, SharedMcpServers};

const TEST_BOUND: Duration = Duration::from_secs(3);

pub(crate) struct DuplexServer {
    pub handle: McpServerHandle,
    pub events: mpsc::Receiver<&'static str>,
    server: RunningService<RoleServer, SlowServer>,
}

impl DuplexServer {
    pub async fn event(&mut self, expected: &str) {
        assert_eq!(
            timeout(TEST_BOUND, self.events.recv()).await.unwrap(),
            Some(expected)
        );
    }

    pub async fn close(self) {
        self.handle.stop();
        timeout(TEST_BOUND, self.handle.stopped()).await.unwrap();
        timeout(TEST_BOUND, self.server.cancel())
            .await
            .unwrap()
            .unwrap();
    }
}

struct SlowServer {
    slow_list: bool,
    slow_call: bool,
    list_delay: Duration,
    events: mpsc::Sender<&'static str>,
}

impl ServerHandler for SlowServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo {
            capabilities: ServerCapabilities::builder().enable_tools().build(),
            ..Default::default()
        }
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParam>,
        context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        let _ = self.events.send("list").await;
        tokio::time::sleep(self.list_delay).await;
        if self.slow_list {
            context.ct.cancelled().await;
            let _ = self.events.send("list_cancelled").await;
        }
        Ok(serde_json::from_value(serde_json::json!({
            "tools": [{"name": "echo", "inputSchema": {"type": "object"}}]
        }))
        .unwrap())
    }

    async fn call_tool(
        &self,
        _request: CallToolRequestParam,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let _ = self.events.send("call").await;
        if self.slow_call {
            context.ct.cancelled().await;
            let _ = self.events.send("call_cancelled").await;
        }
        Ok(CallToolResult::success(vec![Content::text("echo result")]))
    }
}

pub(crate) async fn duplex_server(slow_list: bool, slow_call: bool) -> DuplexServer {
    duplex_server_with_delay(slow_list, slow_call, Duration::ZERO).await
}

async fn duplex_server_with_delay(
    slow_list: bool,
    slow_call: bool,
    list_delay: Duration,
) -> DuplexServer {
    let (client_io, server_io) = tokio::io::duplex(4096);
    let (events, receiver) = mpsc::channel(128);
    let stop = CancellationToken::new();
    let (client_read, client_write) = tokio::io::split(client_io);
    let transport = McpTransport::new(
        AsyncRwTransport::new_client(client_read, client_write),
        stop.clone(),
    );
    let (server, client) = tokio::join!(
        SlowServer {
            slow_list,
            slow_call,
            list_delay,
            events
        }
        .serve(server_io),
        ().serve_with_ct(transport, stop.clone()),
    );
    DuplexServer {
        handle: McpServerHandle::new(client.unwrap(), stop, None),
        events: receiver,
        server: server.unwrap(),
    }
}

async fn register(
    app: &tauri::AppHandle<tauri::test::MockRuntime>,
    name: &str,
    service: &DuplexServer,
) {
    let state = app.state::<AppState>();
    state
        .mcp_servers
        .lock()
        .await
        .insert(name.into(), service.handle.clone());
    state
        .mcp_active_servers
        .lock()
        .await
        .insert(name.into(), serde_json::json!({}));
}

fn echo() -> CallToolRequestParam {
    CallToolRequestParam {
        name: "echo".into(),
        arguments: None,
    }
}

#[tokio::test]
async fn slow_listing_does_not_block_other_server_or_registry() {
    let app = mock_app();
    app.manage(AppState::default());
    let mut slow = duplex_server(true, false).await;
    let fast = duplex_server(false, false).await;
    register(app.handle(), "slow", &slow).await;
    register(app.handle(), "fast", &fast).await;
    let app_handle = app.handle().clone();
    let listing = tokio::spawn(async move {
        commands::get_tools_for_servers(app_handle.clone(), app_handle.state(), vec!["slow".into()])
            .await
    });
    slow.event("list").await;
    let names = timeout(
        TEST_BOUND,
        commands::get_connected_servers(app.handle().clone(), app.state()),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(names.len(), 2);
    let result = timeout(
        TEST_BOUND,
        commands::call_tool(app.state(), "echo".into(), Some("fast".into()), None, None),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(result.content[0].as_text().unwrap().text, "echo result");
    timeout(
        TEST_BOUND,
        commands::deactivate_mcp_server(app.handle().clone(), app.state(), "slow".into()),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(timeout(TEST_BOUND, listing)
        .await
        .unwrap()
        .unwrap()
        .unwrap()
        .is_empty());
    slow.close().await;
    fast.close().await;
}

#[tokio::test]
async fn tool_cancellation_interrupts_discovery_and_reaches_rmcp_server() {
    let app = mock_app();
    app.manage(AppState::default());
    let mut server = duplex_server(true, false).await;
    register(app.handle(), "slow", &server).await;
    let app_handle = app.handle().clone();
    let calling = tokio::spawn(async move {
        commands::call_tool(
            app_handle.state(),
            "echo".into(),
            Some("slow".into()),
            None,
            Some("cancel-list".into()),
        )
        .await
    });
    server.event("list").await;
    commands::cancel_tool_call(app.state(), "cancel-list".into())
        .await
        .unwrap();
    let result = timeout(TEST_BOUND, calling).await.unwrap().unwrap();
    assert!(result.unwrap_err().contains("cancelled"));
    server.event("list_cancelled").await;
    assert!(app
        .state::<AppState>()
        .tool_call_cancellations
        .lock()
        .await
        .is_empty());
    server.close().await;
}

#[tokio::test]
async fn stop_interrupts_in_flight_tool_call() {
    let mut server = duplex_server(false, true).await;
    let handle = server.handle.clone();
    let calling = tokio::spawn(async move {
        handle
            .call_tool(
                echo(),
                Instant::now() + Duration::from_secs(60),
                &CancellationToken::new(),
            )
            .await
    });
    server.event("call").await;
    server.handle.stop();
    assert!(timeout(TEST_BOUND, calling)
        .await
        .unwrap()
        .unwrap()
        .is_err());
    server.close().await;
}

#[tokio::test]
async fn discovery_and_tool_call_share_one_deadline() {
    let app = mock_app();
    let state = AppState::default();
    state.mcp_settings.lock().await.tool_call_timeout_seconds = 1;
    app.manage(state);
    let mut server = duplex_server_with_delay(false, true, Duration::from_millis(700)).await;
    register(app.handle(), "slow", &server).await;
    let app_handle = app.handle().clone();
    let calling = tokio::spawn(async move {
        commands::call_tool(
            app_handle.state(),
            "echo".into(),
            Some("slow".into()),
            None,
            None,
        )
        .await
    });
    server.event("list").await;
    server.event("call").await;
    assert!(timeout(Duration::from_millis(600), calling)
        .await
        .unwrap()
        .unwrap()
        .is_err());
    server.event("call_cancelled").await;
    server.close().await;
}

#[tokio::test]
async fn queued_request_deadline_and_cancellation_do_not_reach_server() {
    let mut server = duplex_server(false, true).await;
    let mut requests = Vec::new();
    for _index in 0..32 {
        let handle = server.handle.clone();
        requests.push(tokio::spawn(async move {
            handle
                .call_tool(
                    echo(),
                    Instant::now() + Duration::from_secs(60),
                    &CancellationToken::new(),
                )
                .await
        }));
    }
    for _index in 0..32 {
        server.event("call").await;
    }
    let mut queued_requests = Vec::new();
    for _index in 0..64 {
        let handle = server.handle.clone();
        queued_requests.push(Box::pin(async move {
            handle
                .call_tool(
                    echo(),
                    Instant::now() + Duration::from_secs(60),
                    &CancellationToken::new(),
                )
                .await
        }));
    }
    for queued in &mut queued_requests {
        assert!(futures_util::poll!(queued.as_mut()).is_pending());
    }
    let overloaded = server
        .handle
        .call_tool(
            echo(),
            Instant::now() + TEST_BOUND,
            &CancellationToken::new(),
        )
        .await;
    assert!(overloaded
        .unwrap_err()
        .to_string()
        .contains("queue is full"));
    drop(queued_requests);
    let result = timeout(
        TEST_BOUND,
        server.handle.call_tool(
            echo(),
            Instant::now() + Duration::from_millis(40),
            &CancellationToken::new(),
        ),
    )
    .await
    .unwrap();
    assert!(matches!(result, Err(rmcp::ServiceError::Timeout { .. })));
    let cancel = CancellationToken::new();
    let handle = server.handle.clone();
    let request_cancel = cancel.clone();
    let queued = tokio::spawn(async move {
        handle
            .call_tool(
                echo(),
                Instant::now() + Duration::from_secs(60),
                &request_cancel,
            )
            .await
    });
    tokio::task::yield_now().await;
    cancel.cancel();
    assert!(matches!(
        timeout(TEST_BOUND, queued).await.unwrap().unwrap(),
        Err(rmcp::ServiceError::Cancelled { .. })
    ));
    assert!(server.events.try_recv().is_err());
    server.handle.stop();
    for request in requests {
        assert!(timeout(TEST_BOUND, request)
            .await
            .unwrap()
            .unwrap()
            .is_err());
    }
    server.close().await;
}

#[tokio::test]
async fn old_failure_cannot_remove_replacement_connection() {
    let old = duplex_server(false, false).await;
    let replacement = duplex_server(false, false).await;
    let servers: SharedMcpServers = Default::default();
    servers
        .lock()
        .await
        .insert("same".into(), replacement.handle.clone());
    assert!(remove_generation(&servers, "same", old.handle.generation)
        .await
        .is_none());
    let current = servers.lock().await.get("same").unwrap().clone();
    assert_eq!(current.generation, replacement.handle.generation);
    assert!(current
        .call_tool(
            echo(),
            Instant::now() + TEST_BOUND,
            &CancellationToken::new()
        )
        .await
        .is_ok());
    old.close().await;
    replacement.close().await;
}

#[tokio::test]
async fn old_health_probe_cannot_remove_replacement_connection() {
    use super::{helpers::monitor_mcp_server_handle, service::McpGeneration};
    let app = mock_app();
    app.manage(AppState::default());
    let mut old = duplex_server(true, false).await;
    let replacement = duplex_server(false, false).await;
    register(app.handle(), "same", &old).await;
    let state = app.state::<AppState>();
    let generation = McpGeneration::default();
    state
        .mcp_starting
        .lock()
        .await
        .insert("same".into(), generation.clone());
    let app_handle = app.handle().clone();
    let servers = state.mcp_servers.clone();
    let notify = state.mcp_reconnect_notify.clone();
    let monitor_generation = generation.clone();
    let monitor = tokio::spawn(async move {
        monitor_mcp_server_handle(
            app_handle,
            servers,
            "same".into(),
            serde_json::json!({}),
            monitor_generation,
            notify,
        )
        .await
    });
    state.mcp_reconnect_notify.notify_one();
    old.event("list").await;
    state
        .mcp_servers
        .lock()
        .await
        .insert("same".into(), replacement.handle.clone());
    old.handle.stop();
    timeout(TEST_BOUND, old.handle.stopped()).await.unwrap();
    tokio::task::yield_now().await;
    let current = state.mcp_servers.lock().await.get("same").unwrap().clone();
    assert_eq!(current.generation, replacement.handle.generation);
    assert!(current
        .list_all_tools(Instant::now() + TEST_BOUND, &CancellationToken::new())
        .await
        .is_ok());
    generation.stop.cancel();
    timeout(TEST_BOUND, monitor).await.unwrap().unwrap();
    old.close().await;
    replacement.close().await;
}

#[tokio::test]
async fn deadline_covers_registry_admission() {
    let app = mock_app();
    let state = AppState::default();
    state.mcp_settings.lock().await.tool_call_timeout_seconds = 1;
    app.manage(state);
    let state = app.state::<AppState>();
    let registry = state.mcp_servers.lock().await;
    let app_handle = app.handle().clone();
    let calling = tokio::spawn(async move {
        commands::call_tool(app_handle.state(), "echo".into(), None, None, None).await
    });
    let result = timeout(TEST_BOUND, calling).await.unwrap().unwrap();
    assert!(result.unwrap_err().contains("timed out"));
    drop(registry);
}

#[tokio::test]
async fn cancellation_interrupts_registry_admission() {
    let app = mock_app();
    app.manage(AppState::default());
    let state = app.state::<AppState>();
    let registry = state.mcp_servers.lock().await;
    let app_handle = app.handle().clone();
    let calling = tokio::spawn(async move {
        commands::call_tool(
            app_handle.state(),
            "echo".into(),
            None,
            None,
            Some("queued".into()),
        )
        .await
    });
    timeout(TEST_BOUND, async {
        while !state
            .tool_call_cancellations
            .lock()
            .await
            .contains_key("queued")
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    commands::cancel_tool_call(app.state(), "queued".into())
        .await
        .unwrap();
    assert!(timeout(TEST_BOUND, calling)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err()
        .contains("cancelled"));
    drop(registry);
}

#[tokio::test]
async fn partial_write_timeout_discards_transport_and_stops_owner() {
    let (client_io, server_io) = tokio::io::duplex(64);
    let stop = CancellationToken::new();
    let (client_read, client_write) = tokio::io::split(client_io);
    let service = rmcp::service::serve_directly(
        (),
        McpTransport::new(
            AsyncRwTransport::new_client(client_read, client_write),
            stop.clone(),
        ),
        None,
    );
    let handle = McpServerHandle::new(service, stop, None);
    let result = handle
        .call_tool(
            CallToolRequestParam {
                name: "echo".into(),
                arguments: Some(
                    serde_json::json!({"payload": "x".repeat(16384)})
                        .as_object()
                        .unwrap()
                        .clone(),
                ),
            },
            Instant::now() + Duration::from_millis(40),
            &CancellationToken::new(),
        )
        .await;
    assert!(result.is_err());
    timeout(TEST_BOUND, handle.stopped()).await.unwrap();
    assert!(handle.is_closed());
    assert!(handle
        .call_tool(
            echo(),
            Instant::now() + TEST_BOUND,
            &CancellationToken::new()
        )
        .await
        .is_err());
    drop(server_io);
}

#[tokio::test]
async fn dropped_request_notifies_server_without_stopping_connection() {
    let mut server = duplex_server(true, false).await;
    let handle = server.handle.clone();
    let listing = tokio::spawn(async move {
        handle
            .list_all_tools(
                Instant::now() + Duration::from_secs(60),
                &CancellationToken::new(),
            )
            .await
    });
    server.event("list").await;
    listing.abort();
    assert!(listing.await.unwrap_err().is_cancelled());
    server.event("list_cancelled").await;
    assert!(!server.handle.is_closed());
    assert!(server
        .handle
        .call_tool(
            echo(),
            Instant::now() + TEST_BOUND,
            &CancellationToken::new()
        )
        .await
        .is_ok());
    server.close().await;
}

#[tokio::test]
async fn stop_interrupts_initial_handshake() {
    use super::helpers::start_mcp_server;
    let app = mock_app();
    app.manage(AppState::default());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/mcp", listener.local_addr().unwrap());
    let app_handle = app.handle().clone();
    let servers = app.state::<AppState>().mcp_servers.clone();
    let handshake = tokio::spawn(async move {
        start_mcp_server(
            app_handle,
            servers,
            "starting".into(),
            serde_json::json!({
                "command": "unused", "args": [], "type": "http", "url": url,
            }),
        )
        .await
    });
    let (mut silent_peer, _) = timeout(TEST_BOUND, listener.accept())
        .await
        .unwrap()
        .unwrap();
    commands::deactivate_mcp_server(app.handle().clone(), app.state(), "starting".into())
        .await
        .unwrap();
    assert!(timeout(TEST_BOUND, handshake)
        .await
        .unwrap()
        .unwrap()
        .is_err());
    assert!(app.state::<AppState>().mcp_starting.lock().await.is_empty());
    assert!(app.state::<AppState>().mcp_servers.lock().await.is_empty());
    let mut request_bytes = Vec::new();
    timeout(
        TEST_BOUND,
        tokio::io::AsyncReadExt::read_to_end(&mut silent_peer, &mut request_bytes),
    )
    .await
    .unwrap()
    .unwrap();
}

#[tokio::test]
async fn stop_reclaims_http_worker_waiting_for_post_response() {
    use super::service::McpHttpClient;
    use rmcp::transport::{
        streamable_http_client::StreamableHttpClientTransportConfig, StreamableHttpClientTransport,
    };
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/mcp", listener.local_addr().unwrap());
    let (entered, received) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let mut socket = BufReader::new(socket);
        for index in 0..3 {
            let mut length = 0;
            loop {
                let mut line = String::new();
                assert_ne!(socket.read_line(&mut line).await.unwrap(), 0);
                if line == "\r\n" {
                    break;
                }
                if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    length = value.trim().parse::<usize>().unwrap();
                }
            }
            let mut body = vec![0; length];
            socket.read_exact(&mut body).await.unwrap();
            let request: serde_json::Value = serde_json::from_slice(&body).unwrap();
            if index == 2 {
                assert_eq!(request["method"], "tools/call");
                break;
            }
            let response = if index == 0 {
                let body = serde_json::json!({"jsonrpc": "2.0", "id": request["id"], "result": ServerInfo::default()}).to_string();
                format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len())
            } else {
                "HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\n\r\n".into()
            };
            socket
                .get_mut()
                .write_all(response.as_bytes())
                .await
                .unwrap();
        }
        entered.send(()).unwrap();
        let mut remainder = Vec::new();
        socket.read_to_end(&mut remainder).await.unwrap();
    });
    let stop = CancellationToken::new();
    let transport = StreamableHttpClientTransport::with_client(
        McpHttpClient::new(reqwest::Client::new(), stop.clone()),
        StreamableHttpClientTransportConfig {
            uri: url.into(),
            ..Default::default()
        },
    );
    let client = timeout(
        TEST_BOUND,
        ().serve_with_ct(McpTransport::new(transport, stop.clone()), stop.clone()),
    )
    .await
    .unwrap()
    .unwrap();
    let handle = McpServerHandle::new(client, stop, None);
    let request_handle = handle.clone();
    let request = tokio::spawn(async move {
        request_handle
            .call_tool(
                echo(),
                Instant::now() + Duration::from_secs(60),
                &CancellationToken::new(),
            )
            .await
    });
    timeout(TEST_BOUND, received).await.unwrap().unwrap();
    handle.stop();
    timeout(TEST_BOUND, handle.stopped()).await.unwrap();
    assert!(timeout(TEST_BOUND, request)
        .await
        .unwrap()
        .unwrap()
        .is_err());
    timeout(TEST_BOUND, server).await.unwrap().unwrap();
}
