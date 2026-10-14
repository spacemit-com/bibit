use std::{
    future::Future,
    io,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};

use futures_util::StreamExt;
use rmcp::{
    model::{
        CallToolRequest, CallToolRequestParam, CallToolResult, ClientJsonRpcMessage, ClientRequest,
        GetExtensions, JsonRpcMessage, ListToolsRequest, PaginatedRequestParam,
        ServerJsonRpcMessage, ServerResult, Tool,
    },
    service::{Peer, PeerRequestOptions, RequestHandle, RunningService},
    transport::{
        common::client_side_sse::BoxedSseResponse,
        streamable_http_client::{
            StreamableHttpClient, StreamableHttpError, StreamableHttpPostResponse,
        },
        Transport,
    },
    RoleClient, Service, ServiceError,
};
use tokio::{
    sync::{OwnedSemaphorePermit, Semaphore},
    time::{timeout, timeout_at, Instant},
};
use tokio_util::sync::CancellationToken;

use crate::core::state::SharedMcpServers;

const CLEANUP_BUDGET: Duration = Duration::from_millis(500);
const MAX_IN_FLIGHT: usize = 32;
const MAX_QUEUED: usize = 64;
static NEXT_GENERATION: AtomicU64 = AtomicU64::new(1);

#[derive(Clone)]
pub struct McpGeneration {
    pub id: u64,
    pub stop: CancellationToken,
}

impl Default for McpGeneration {
    fn default() -> Self {
        Self {
            id: NEXT_GENERATION.fetch_add(1, Ordering::Relaxed),
            stop: CancellationToken::new(),
        }
    }
}

#[derive(Clone)]
pub struct McpServerHandle {
    pub generation: u64,
    pub pid: Option<u32>,
    peer: Peer<RoleClient>,
    stop: CancellationToken,
    closed: CancellationToken,
    admission: Arc<Semaphore>,
    queue: Arc<Semaphore>,
}

impl McpServerHandle {
    pub fn new<S: Service<RoleClient>>(
        service: RunningService<RoleClient, S>,
        stop: CancellationToken,
        pid: Option<u32>,
    ) -> Self {
        let handle = Self {
            generation: NEXT_GENERATION.fetch_add(1, Ordering::Relaxed),
            pid,
            peer: service.peer().clone(),
            stop: stop.clone(),
            closed: CancellationToken::new(),
            admission: Arc::new(Semaphore::new(MAX_IN_FLIGHT)),
            queue: Arc::new(Semaphore::new(MAX_QUEUED)),
        };
        let closed = handle.closed.clone();
        let service_cancel = service.cancellation_token();
        tokio::spawn(async move {
            let child = McpChildGuard(pid);
            let waiting = service.waiting();
            tokio::pin!(waiting);
            tokio::select! {
                _ = &mut waiting => {}
                _ = stop.cancelled() => {
                    service_cancel.cancel();
                    let _ = waiting.await;
                }
            }
            stop.cancel();
            drop(child);
            closed.cancel();
        });
        handle
    }

    pub fn stop(&self) {
        self.stop.cancel();
    }

    pub fn is_closed(&self) -> bool {
        self.stop.is_cancelled() || self.peer.is_transport_closed()
    }

    pub async fn stopped(&self) {
        self.closed.cancelled().await;
    }

    async fn request(
        &self,
        mut request: ClientRequest,
        deadline: Instant,
        cancel: &CancellationToken,
    ) -> Result<ServerResult, ServiceError> {
        let queued = self
            .queue
            .try_acquire()
            .map_err(|_| ServiceError::Cancelled {
                reason: Some("MCP server request queue is full".into()),
            })?;
        let permit = self
            .wait(deadline, cancel, async {
                self.admission
                    .clone()
                    .acquire_owned()
                    .await
                    .map_err(|_| ServiceError::TransportClosed)
            })
            .await?;
        drop(queued);
        let request_cancel = cancel.child_token();
        let cancel_on_drop = request_cancel.clone().drop_guard();
        request.extensions_mut().insert(McpRequestDeadline {
            deadline,
            cancel: request_cancel.clone(),
        });
        let request = self
            .wait(
                deadline,
                cancel,
                self.peer
                    .send_cancellable_request(request, PeerRequestOptions::no_options()),
            )
            .await?;
        let mut pending = PendingRequest {
            request: Some(request),
            stop: self.stop.clone(),
            cancel: request_cancel,
            permit: Some(permit),
        };
        cancel_on_drop.disarm();
        let response = self
            .wait(deadline, cancel, async {
                (&mut pending.request.as_mut().unwrap().rx)
                    .await
                    .map_err(|_| ServiceError::TransportClosed)?
            })
            .await;
        if !matches!(
            response,
            Err(ServiceError::Timeout { .. } | ServiceError::Cancelled { .. })
        ) {
            pending.request.take();
        }
        if matches!(
            response,
            Err(ServiceError::TransportClosed | ServiceError::TransportSend(_))
        ) {
            self.stop();
        }
        response
    }

    async fn wait<T>(
        &self,
        deadline: Instant,
        cancel: &CancellationToken,
        future: impl Future<Output = Result<T, ServiceError>>,
    ) -> Result<T, ServiceError> {
        let budget = deadline.saturating_duration_since(Instant::now());
        tokio::select! {
            biased;
            _ = self.stop.cancelled() => Err(ServiceError::TransportClosed),
            _ = cancel.cancelled() => Err(ServiceError::Cancelled { reason: Some("request cancelled".into()) }),
            _ = tokio::time::sleep_until(deadline) => Err(ServiceError::Timeout { timeout: budget }),
            result = future => result,
        }
    }

    pub async fn list_all_tools(
        &self,
        deadline: Instant,
        cancel: &CancellationToken,
    ) -> Result<Vec<Tool>, ServiceError> {
        let mut tools = Vec::new();
        let mut cursor = None;
        loop {
            let response = self
                .request(
                    ClientRequest::ListToolsRequest(ListToolsRequest {
                        method: Default::default(),
                        params: cursor.map(|cursor| PaginatedRequestParam {
                            cursor: Some(cursor),
                        }),
                        extensions: Default::default(),
                    }),
                    deadline,
                    cancel,
                )
                .await?;
            let ServerResult::ListToolsResult(result) = response else {
                return Err(ServiceError::UnexpectedResponse);
            };
            tools.extend(result.tools);
            cursor = result.next_cursor;
            if cursor.is_none() {
                return Ok(tools);
            }
        }
    }

    pub async fn call_tool(
        &self,
        params: CallToolRequestParam,
        deadline: Instant,
        cancel: &CancellationToken,
    ) -> Result<CallToolResult, ServiceError> {
        match self
            .request(
                ClientRequest::CallToolRequest(CallToolRequest {
                    method: Default::default(),
                    params,
                    extensions: Default::default(),
                }),
                deadline,
                cancel,
            )
            .await?
        {
            ServerResult::CallToolResult(result) => Ok(result),
            _ => Err(ServiceError::UnexpectedResponse),
        }
    }
}

struct PendingRequest {
    request: Option<RequestHandle<RoleClient>>,
    stop: CancellationToken,
    cancel: CancellationToken,
    permit: Option<OwnedSemaphorePermit>,
}

impl Drop for PendingRequest {
    fn drop(&mut self) {
        if let Some(request) = self.request.take() {
            self.cancel.cancel();
            let stop = self.stop.clone();
            let permit = self.permit.take();
            tokio::spawn(async move {
                let _permit = permit;
                tokio::select! {
                    biased;
                    _ = stop.cancelled() => {}
                    result = timeout(CLEANUP_BUDGET, request.cancel(Some("request cancelled or expired".into()))) => {
                        if !matches!(result, Ok(Ok(()))) {
                            stop.cancel();
                        }
                    }
                }
            });
        }
    }
}

pub async fn remove_generation(
    servers: &SharedMcpServers,
    name: &str,
    generation: u64,
) -> Option<McpServerHandle> {
    let removed = {
        let mut servers = servers.lock().await;
        if servers
            .get(name)
            .is_some_and(|service| service.generation == generation)
        {
            servers.remove(name)
        } else {
            None
        }
    };
    if let Some(service) = &removed {
        service.stop();
    }
    removed
}

#[derive(Clone)]
struct McpRequestDeadline {
    deadline: Instant,
    cancel: CancellationToken,
}

#[derive(Clone)]
pub(super) struct McpHttpClient {
    client: reqwest::Client,
    stop: CancellationToken,
}

impl McpHttpClient {
    pub fn new(client: reqwest::Client, stop: CancellationToken) -> Self {
        Self { client, stop }
    }
}

impl StreamableHttpClient for McpHttpClient {
    type Error = reqwest::Error;

    async fn post_message(
        &self,
        uri: Arc<str>,
        message: ClientJsonRpcMessage,
        session_id: Option<Arc<str>>,
        auth_header: Option<String>,
    ) -> Result<StreamableHttpPostResponse, StreamableHttpError<Self::Error>> {
        let scope = match &message {
            JsonRpcMessage::Request(request) => request
                .request
                .extensions()
                .get::<McpRequestDeadline>()
                .cloned(),
            _ => None,
        };
        let expired = async {
            if let Some(scope) = scope {
                tokio::select! {
                    _ = tokio::time::sleep_until(scope.deadline) => {}
                    _ = scope.cancel.cancelled() => {}
                }
            } else {
                std::future::pending::<()>().await;
            }
        };
        let response = tokio::select! {
            biased;
            _ = self.stop.cancelled() => return Err(StreamableHttpError::TransportChannelClosed),
            _ = expired => {
                self.stop.cancel();
                return Err(StreamableHttpError::TransportChannelClosed);
            }
            response = self.client.post_message(uri, message, session_id, auth_header) => response.map_err(|error| {
                self.stop.cancel();
                error
            })?,
        };
        Ok(match response {
            StreamableHttpPostResponse::Sse(stream, session_id) => StreamableHttpPostResponse::Sse(
                stream
                    .take_until(self.stop.clone().cancelled_owned())
                    .boxed(),
                session_id,
            ),
            response => response,
        })
    }

    async fn delete_session(
        &self,
        uri: Arc<str>,
        session_id: Arc<str>,
        auth_header: Option<String>,
    ) -> Result<(), StreamableHttpError<Self::Error>> {
        timeout(
            CLEANUP_BUDGET,
            self.client.delete_session(uri, session_id, auth_header),
        )
        .await
        .map_err(|error| StreamableHttpError::Io(io::Error::other(error)))?
    }

    async fn get_stream(
        &self,
        uri: Arc<str>,
        session_id: Arc<str>,
        last_event_id: Option<String>,
        auth_header: Option<String>,
    ) -> Result<BoxedSseResponse, StreamableHttpError<Self::Error>> {
        let stream = tokio::select! {
            biased;
            _ = self.stop.cancelled() => return Err(StreamableHttpError::TransportChannelClosed),
            stream = self.client.get_stream(uri, session_id, last_event_id, auth_header) => stream?,
        };
        Ok(stream
            .take_until(self.stop.clone().cancelled_owned())
            .boxed())
    }
}

pub struct McpTransport<T> {
    inner: T,
    stop: CancellationToken,
}

pub(super) struct McpChildGuard(pub Option<u32>);

impl Drop for McpChildGuard {
    fn drop(&mut self) {
        #[cfg(unix)]
        if let Some(pid) = self.0.filter(|pid| *pid > 1) {
            let _ = nix::sys::signal::killpg(
                nix::unistd::Pid::from_raw(pid as i32),
                nix::sys::signal::Signal::SIGKILL,
            );
        }
    }
}

impl<T> McpTransport<T> {
    pub fn new(inner: T, stop: CancellationToken) -> Self {
        Self { inner, stop }
    }
}

impl<T: Transport<RoleClient>> Transport<RoleClient> for McpTransport<T> {
    type Error = io::Error;

    fn send(
        &mut self,
        message: ClientJsonRpcMessage,
    ) -> impl Future<Output = io::Result<()>> + Send + 'static {
        let scope = match &message {
            JsonRpcMessage::Request(request) => request
                .request
                .extensions()
                .get::<McpRequestDeadline>()
                .cloned(),
            _ => None,
        };
        let send = self.inner.send(message);
        let stop = self.stop.clone();
        async move {
            let interrupted = async {
                if let Some(scope) = scope {
                    tokio::select! {
                        _ = tokio::time::sleep_until(scope.deadline) => {}
                        _ = scope.cancel.cancelled() => {}
                    }
                } else {
                    std::future::pending::<()>().await;
                }
            };
            let result = tokio::select! {
                biased;
                _ = stop.cancelled() => Err(io::Error::new(io::ErrorKind::Interrupted, "MCP transport stopped")),
                _ = interrupted => Err(io::Error::new(io::ErrorKind::TimedOut, "MCP write cancelled or expired")),
                result = send => result.map_err(io::Error::other),
            };
            if result.is_err() {
                stop.cancel();
            }
            result
        }
    }

    async fn receive(&mut self) -> Option<ServerJsonRpcMessage> {
        tokio::select! {
            biased;
            _ = self.stop.cancelled() => None,
            result = self.inner.receive() => result,
        }
    }

    async fn close(&mut self) -> io::Result<()> {
        self.stop.cancel();
        timeout_at(Instant::now() + CLEANUP_BUDGET, self.inner.close())
            .await
            .map_err(io::Error::other)?
            .map_err(io::Error::other)
    }
}
