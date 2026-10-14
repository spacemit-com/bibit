pub mod contract;
pub mod feed;

use contract::{parse_error, RuntimeStatusView};

use self::feed::FeedHub;
use super::driver::{
    DriverEvent, DriverLifecycleEvent, DriverPermissionRequest, DriverPromptRequest, DriverStart,
    RuntimeDriver,
};
use super::{
    PermissionDecision, RuntimeCapabilities, RuntimeConnectionStatus, RuntimeError,
    RuntimeErrorCode, RuntimeMessage, RuntimeSession,
};
use async_trait::async_trait;
use reqwest::header::{HeaderValue, CONNECTION};
use reqwest::{Client, RequestBuilder, StatusCode, Url};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{broadcast, mpsc, Mutex};
use tokio::time::Duration;

const DEFAULT_BASE_URL: &str = "http://127.0.0.1:9899/api/v1";
/// 判断 reqwest 错误是否属于"瞬态 stale keep-alive 连接"失败。
///
/// 特征：请求阶段失败（`is_request()`）。stale 连接复用后，服务端已拆除 idle
/// 连接，`send()` 在发送阶段收到 `connection closed before message completed`，
/// 其 `is_timeout()` 与 `is_connect()` 均为 false。对这类错误，用 `Connection: close`
/// 强制新建连接重试一次即可自愈（见实验：瞬态失败 10/10 重试成功）。
///
/// 不重试超时（`is_timeout()`）与连接被拒/持续不可达（`is_connect()`），避免对
/// 持久性问题做无意义重试。
fn is_transient_transport_failure(error: &reqwest::Error) -> bool {
    error.is_request() && !error.is_timeout() && !error.is_connect()
}

fn attachment_mime(path: &std::path::Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "txt" => Some("text/plain"),
        "md" => Some("text/markdown"),
        "csv" => Some("text/csv"),
        "json" => Some("application/json"),
        "yaml" | "yml" => Some("application/yaml"),
        "toml" => Some("application/toml"),
        "xml" => Some("application/xml"),
        "pdf" => Some("application/pdf"),
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "wav" => Some("audio/wav"),
        "mp3" => Some("audio/mpeg"),
        "mp4" => Some("video/mp4"),
        _ => None,
    }
}

fn session_attachment_refs(attachments: &[super::SessionAttachmentRef]) -> Vec<Value> {
    attachments
        .iter()
        .map(|attachment| json!({"resource_id": attachment.resource_id}))
        .collect()
}

pub struct BianbuHttpDriver {
    feed: feed::FeedHub,
    feed_tasks: Mutex<Vec<tokio::task::JoinHandle<()>>>,
    client: Client,
    base_url: Arc<Url>,
    runs: Arc<Mutex<HashMap<String, (String, String)>>>,
    approvals: Arc<Mutex<HashMap<String, (String, String)>>>,
    lifecycle: Mutex<Option<mpsc::UnboundedSender<DriverLifecycleEvent>>>,
}

impl BianbuHttpDriver {
    pub fn from_env() -> Result<Self, RuntimeError> {
        let raw =
            std::env::var("BIBIT_BIANBU_RUNTIME_URL").unwrap_or_else(|_| DEFAULT_BASE_URL.into());
        Self::new(&raw)
    }

    pub fn new(raw: &str) -> Result<Self, RuntimeError> {
        let base_url = Url::parse(&format!("{}/", raw.trim_end_matches('/')))
            .map_err(|error| runtime_error(format!("Bianbu Runtime 地址无效: {error}")))?;
        let client = Client::builder()
            .no_proxy()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|error| runtime_error(format!("创建 HTTP 客户端失败: {error}")))?;
        let base_url = Arc::new(base_url);
        let mut identity_url = (*base_url).clone();
        let _ = identity_url.set_username("");
        let _ = identity_url.set_password(None);
        identity_url.set_query(None);
        identity_url.set_fragment(None);
        let config_id =
            std::env::var("BIBIT_BIANBU_CONFIG_ID").unwrap_or_else(|_| "default".into());
        use sha2::{Digest, Sha256};
        let target = format!(
            "bianbu:{:x}",
            Sha256::digest(format!("{}|{}", identity_url, config_id).as_bytes())
        );
        Ok(Self {
            feed: feed::FeedHub::new(client.clone(), base_url.clone(), target),
            feed_tasks: Mutex::new(Vec::new()),
            client,
            base_url,
            runs: Arc::new(Mutex::new(HashMap::new())),
            approvals: Arc::new(Mutex::new(HashMap::new())),
            lifecycle: Mutex::new(None),
        })
    }

    /// 发送请求并对"瞬态 stale keep-alive 连接"失败自动重试一次。
    ///
    /// `build` 是请求构造器：首次发送与重试都会调用它。重试时会在其返回的
    /// `RequestBuilder` 上追加 `Connection: close` 头，强制 reqwest 新建一条连接，
    /// 避免再次复用到连接池里的 stale 连接（见 `is_transient_transport_failure`）。
    ///
    /// `build` 不应捕获 `&self`，而是捕获已克隆的 `self.client` 与 owned 的
    /// `Url`/`Value`，以免闭包借用 `&self` 跨 `await`。
    async fn send_retrying<F>(
        &self,
        build: F,
        fail_label: &str,
    ) -> Result<reqwest::Response, RuntimeError>
    where
        F: Fn() -> Result<RequestBuilder, RuntimeError>,
    {
        let request = build()?;
        match request.send().await {
            Ok(response) => Ok(response),
            Err(first_error) if is_transient_transport_failure(&first_error) => {
                // 瞬态 stale：新建连接重试一次（加 Connection: close 强制不复用池内连接）
                let retry = build()?.header(CONNECTION, HeaderValue::from_static("close"));
                match retry.send().await {
                    Ok(response) => Ok(response),
                    // 重试仍失败：返回原始错误，且不设置 details，
                    // 保持"传输层失败不应伪装成确定的 HTTP 拒绝"的既有契约。
                    Err(retry_error) => Err(runtime_error(format!("{fail_label}: {retry_error}"))),
                }
            }
            // 非瞬态（如超时 / 连接被拒）：不重试，同样不设置 details。
            Err(first_error) => Err(runtime_error(format!("{fail_label}: {first_error}"))),
        }
    }

    fn endpoint(&self, path: &str) -> Result<Url, RuntimeError> {
        self.base_url
            .join(path)
            .map_err(|error| runtime_error(format!("Bianbu Runtime 地址拼接失败: {error}")))
    }

    fn session_endpoint(&self, session_id: &str, suffix: &[&str]) -> Result<Url, RuntimeError> {
        let mut url = self.endpoint("sessions")?;
        let mut segments = url
            .path_segments_mut()
            .map_err(|_| runtime_error("Bianbu Runtime 地址不能承载路径"))?;
        segments.push(session_id);
        segments.extend(suffix.iter().copied());
        drop(segments);
        Ok(url)
    }

    async fn backend_session_and_run(
        &self,
        run_id: &str,
    ) -> Result<(String, String), RuntimeError> {
        self.runs
            .lock()
            .await
            .get(run_id)
            .cloned()
            .ok_or_else(|| runtime_error("Bianbu Run 不存在"))
    }

    async fn fetch_session_events(&self, session_id: &str) -> Result<Vec<Value>, RuntimeError> {
        let mut before_seq: Option<u64> = None;
        let mut events = Vec::new();
        loop {
            let url = self.session_endpoint(session_id, &["events"])?;
            let client = self.client.clone();
            let before = before_seq;
            let response = self
                .send_retrying(
                    || {
                        let mut request = client.get(url.clone()).query(&[("max_messages", 50)]);
                        if let Some(b) = before {
                            request = request.query(&[("before_seq", b), ("max_messages", 50)]);
                        }
                        Ok(request)
                    },
                    "读取 Bianbu 会话事件",
                )
                .await?;
            let status = response.status();
            let body: Value = response
                .json()
                .await
                .map_err(|error| runtime_error(format!("Bianbu Runtime 事件响应无效: {error}")))?;
            if !status.is_success() {
                return Err(runtime_error(api_error(&body, "读取 Bianbu 会话事件失败")));
            }
            let items = body
                .get("data")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            events.extend(items);
            if !body
                .get("has_more")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                break;
            }
            let Some(base) = body.get("base_seq").and_then(Value::as_u64) else {
                break;
            };
            if base == 0 {
                break;
            }
            before_seq = Some(base);
        }
        events.sort_by_key(|item| item.get("seq").and_then(Value::as_u64).unwrap_or(0));
        Ok(events)
    }

    async fn get_created(
        &self,
        path: &str,
        requested_id: &str,
        label: &str,
    ) -> Result<Option<(StatusCode, Value)>, RuntimeError> {
        let mut url = self.endpoint(path)?;
        url.path_segments_mut()
            .map_err(|_| runtime_error("Bianbu Runtime 地址不能承载路径"))?
            .push(requested_id);
        let client = self.client.clone();
        let recover_url = url;
        let response = self
            .send_retrying(
                || Ok(client.get(recover_url.clone())),
                &format!("确认{label}结果"),
            )
            .await?;
        let status = response.status();
        if status == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        let body = response
            .json()
            .await
            .map_err(|error| runtime_error(format!("Bianbu Runtime 响应无效: {error}")))?;
        if !status.is_success() {
            return Err(http_error(status, &body, &format!("确认{label}结果失败")));
        }
        Ok(Some((status, body)))
    }

    /// Run 创建前的会话水位，返回「下一条要读的 seq」。
    ///
    /// 老 Runtime 不认 `tail_only`，回的是消息窗口；两者都按信封里的 `last_seq`
    /// 与页内最大 `seq` 起步，所以这条路径对两代 Runtime 都成立。请求失败返回 0
    /// （少跳过一些历史，但不会漏事件）。
    async fn session_event_tail(&self, session_id: &str) -> u64 {
        let Ok(url) = self.session_endpoint(session_id, &["events"]) else {
            return 0;
        };
        match self
            .client
            .get(url)
            .query(&[("tail_only", "true")])
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => response
                .json::<Value>()
                .await
                .map(|body| next_event_seq_after(&body))
                .unwrap_or(0),
            _ => 0,
        }
    }

    /// 读一次最新可见窗口的事件，不向前翻页。
    ///
    /// 接管进行中的 Run 时用它把该 Run 已经产出的事件补投出去：会话历史里没有
    /// 进行中回答那一行，读者只能从这里重建它。失败返回空，由调用方从 0 起流兜底。
    async fn session_window_events(&self, session_id: &str) -> Vec<Value> {
        let Ok(url) = self.session_endpoint(session_id, &["events"]) else {
            return Vec::new();
        };
        match self
            .client
            .get(url)
            .query(&[("max_messages", "50")])
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => response
                .json::<Value>()
                .await
                .ok()
                .and_then(|body| body.get("data").and_then(Value::as_array).cloned())
                .unwrap_or_default(),
            _ => Vec::new(),
        }
    }

    async fn post_json(
        &self,
        path: &str,
        payload: &Value,
        label: &str,
    ) -> Result<(StatusCode, Value), RuntimeError> {
        let response = self
            .client
            .post(self.endpoint(path)?)
            .json(payload)
            .send()
            .await
            .map_err(|error| runtime_error(format!("无法{label}: {error}")))?;
        let status = response.status();
        let body = response
            .json()
            .await
            .map_err(|error| runtime_error(format!("Bianbu Runtime 响应无效: {error}")))?;
        Ok((status, body))
    }

    async fn patch_json(
        &self,
        path: &str,
        payload: &Value,
        label: &str,
    ) -> Result<(StatusCode, Value), RuntimeError> {
        let response = self
            .client
            .patch(self.endpoint(path)?)
            .json(payload)
            .send()
            .await
            .map_err(|error| runtime_error(format!("无法{label}: {error}")))?;
        let status = response.status();
        let body = response
            .json()
            .await
            .map_err(|error| runtime_error(format!("Bianbu Runtime 响应无效: {error}")))?;
        Ok((status, body))
    }

    /// 订阅一个 Run 的实时事件。
    ///
    /// `from_seq` 是「下一条要读的 seq」，`prime` 是订阅建立前先补投的事件（接管进行中的
    /// Run 时用）。事件取自 driver 已经建立的 mux 连接（`FeedHub`）：那里每来一条
    /// `session/event` 就会广播一次，包括补洞读回来的历史页，所以订阅既不必自己发 HTTP
    /// 快照请求，也不会因为另一条 HTTP 读把连接占住而错过数据。
    async fn subscribe_session(
        &self,
        session_id: String,
        backend_run_id: String,
        run_id: String,
        from_seq: u64,
        prime: Vec<Value>,
    ) -> Result<mpsc::UnboundedReceiver<DriverEvent>, RuntimeError> {
        let mut live = self.feed.live();
        let hub = self.feed.clone();
        let approvals = Arc::clone(&self.approvals);
        let (events, receiver) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            // 补投的事件早于起始游标（它们是订阅建立前就有的历史），游标从补投里最小的
            // seq 起步，投完正好落回 `from_seq`：既不把补投过滤掉，也不倒退。
            let cursor = prime
                .iter()
                .filter_map(|item| item.get("seq").and_then(Value::as_u64))
                .min()
                .map_or(from_seq, |first| first.min(from_seq));
            let mut feed = SessionEventFeed {
                events: &events,
                approvals: &approvals,
                session_id: &session_id,
                run_id: &run_id,
                backend_run_id: &backend_run_id,
                cursor,
                stop: false,
                connected_reported: false,
                reconnecting: false,
            };
            for item in prime {
                feed.deliver(&item).await;
                if feed.stop {
                    return;
                }
            }
            loop {
                match live.recv().await {
                    Ok((session, batch)) => {
                        if session != session_id {
                            continue;
                        }
                        for item in &batch {
                            // 广播只保证「尽力」，丢帧必须能被发现：先按自己的游标补读。
                            // 补不齐也**不**把这条 Run 判死——那会把真实错误（例如
                            // skill_unavailable）换成一句通用失败，用户看到的反而更差；
                            // 这里显式报「正在重连」，内容仍按序投递，权威内容由会话窗口兜底。
                            let gapped = if item["seq"]
                                .as_u64()
                                .is_some_and(|next| next > feed.cursor)
                            {
                                if let Err(error) = feed.catch_up(&hub).await {
                                    feed.report_reconnecting(format!(
                                        "Run 事件补读失败，将按会话窗口校准：{}",
                                        error.message
                                    ));
                                }
                                if feed.stop {
                                    return;
                                }
                                let missing =
                                    item["seq"].as_u64().is_some_and(|next| next > feed.cursor);
                                if missing {
                                    feed.report_reconnecting(format!(
                                        "Run 事件存在缺口（下一帧 seq={}，当前游标 {}），已按会话窗口校准",
                                        item["seq"].as_u64().unwrap_or_default(),
                                        feed.cursor
                                    ));
                                }
                                missing
                            } else {
                                false
                            };
                            if !gapped {
                                feed.report_connected();
                            }
                            feed.deliver(item).await;
                            if feed.stop {
                                return;
                            }
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        feed.report_reconnecting("Bianbu Runtime 实时帧积压".into());
                        if let Err(error) = feed.catch_up(&hub).await {
                            // 补读失败只降级成「正在重连」：这条流仍然继续，之后的每一帧
                            // 都会再触发一次按游标补读，终态以会话窗口 + 重启后的对账为准。
                            feed.report_reconnecting(format!(
                                "Run 事件补读失败，将按会话窗口校准：{}",
                                error.message
                            ));
                        }
                        if feed.stop {
                            return;
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => return,
                }
            }
        });
        Ok(receiver)
    }
}

#[async_trait]
impl RuntimeDriver for BianbuHttpDriver {
    fn runtime_id(&self) -> &'static str {
        "bianbu"
    }

    fn capabilities(&self) -> RuntimeCapabilities {
        RuntimeCapabilities {
            session_events: true,
            session_inbox: true,
            durable_sessions: true,
            detached_runs: true,
            replayable_events: true,
            runtime_owned_approvals: true,
            agent_selection: true,
            session_management: true,
            context_clear: true,
            title_generation: true,
            // Runtime 只接受 prompt 里的 attachments 元数据，没有附件上传/删除端点
            // （POST /sessions/{id}/attachments 返回 404）。等 Runtime 实现后再打开。
            session_attachments: false,
            skill_selection: true,
            // Runtime 提供 GET /sessions/search（跨会话正文检索）。旧 Runtime 返回 404 时
            // 界面只保留标题结果，不把失败包装成"搜不到"。
            session_search: true,
            // Runtime 只有 GET /sessions/{id}/history（折叠读模型），写路径没有实现，
            // POST 同一个路径返回 405。等 Runtime 补上写接口后再打开。
            history_operations: false,
        }
    }

    async fn list_skills(&self) -> Result<Vec<Value>, RuntimeError> {
        let client = self.client.clone();
        let url = self.endpoint("capabilities/skill")?;
        let response = self
            .send_retrying(|| Ok(client.get(url.clone())), "读取技能")
            .await?;
        parse_data_response(response, "读取技能失败").await
    }
    fn target_id(&self) -> String {
        self.feed.target_id()
    }
    async fn session_feed(
        &self,
        session: &str,
        before: Option<u64>,
        view: super::SessionFeedView,
    ) -> Result<super::SessionFeed, RuntimeError> {
        self.feed.initial(session, before, view).await
    }
    async fn session_downlink(
        &self,
    ) -> Result<mpsc::Receiver<super::SessionFeedEvent>, RuntimeError> {
        let mut tasks = self.feed_tasks.lock().await;
        for task in tasks.drain(..) {
            task.abort();
        }
        let (tx, rx) = mpsc::channel(128);
        *tasks = self.feed.spawn(tx);
        Ok(rx)
    }
    async fn session_history(
        &self,
        request: super::SessionHistoryRequest,
    ) -> Result<super::SessionHistoryResult, RuntimeError> {
        request.validate()?;
        let client = self.client.clone();
        let url = self.session_endpoint(&request.session_id, &["history"])?;
        let payload = json!({"operation_id": request.operation_id, "expected_seq": request.expected_seq,
            "action": request.action, "message_id": request.message_id, "content": request.content});
        let response = self
            .send_retrying(|| Ok(client.post(url.clone()).json(&payload)), "历史操作")
            .await?;
        let result: super::SessionHistoryResult =
            parse_data_response(response, "历史操作失败").await?;
        if result.operation_id != request.operation_id {
            return Err(RuntimeError::new(
                RuntimeErrorCode::SessionConflict,
                "历史操作回执不匹配",
            ));
        }
        Ok(result)
    }
    async fn search_sessions(
        &self,
        query: &str,
        limit: u32,
    ) -> Result<Vec<super::RuntimeSearchHit>, RuntimeError> {
        let client = self.client.clone();
        let url = self.endpoint("sessions/search")?;
        let limit = limit.to_string();
        let response = self
            .send_retrying(
                || {
                    Ok(client
                        .get(url.clone())
                        .query(&[("q", query), ("limit", limit.as_str())]))
                },
                "检索会话正文",
            )
            .await?;
        let hits: Vec<Value> = parse_data_response(response, "检索会话正文失败").await?;
        hits.into_iter()
            .map(|hit| {
                serde_json::from_value::<super::RuntimeSearchHit>(hit)
                    .map_err(|error| runtime_error(format!("Bianbu Runtime 检索结果无效: {error}")))
            })
            .collect()
    }
    async fn session_submit(
        &self,
        request: super::SessionSubmitRequest,
    ) -> Result<super::SessionSubmitResult, RuntimeError> {
        request.validate()?;
        let client = self.client.clone();
        let url = self.session_endpoint(&request.session_id, &["prompt"])?;
        let attachments = session_attachment_refs(&request.attachments);
        let payload = json!({"message_id": request.message_id, "content": request.content, "skill_ids": request.skill_ids, "attachments": attachments});
        let response = self
            .send_retrying(|| Ok(client.post(url.clone()).json(&payload)), "发送")
            .await?;
        let mut result: super::SessionSubmitResult =
            parse_data_response(response, "发送失败").await?;
        result.staged = result.status == "staged";
        result.claimed = result.status == "claimed";
        Ok(result)
    }
    async fn session_attachment_upload(
        &self,
        session: &str,
        source: &std::path::Path,
        source_name: &str,
    ) -> Result<super::SessionAttachment, RuntimeError> {
        let metadata = tokio::fs::metadata(source)
            .await
            .map_err(|e| runtime_error(format!("读取附件失败: {e}")))?;
        if !metadata.is_file() || metadata.len() == 0 || metadata.len() > 25 * 1024 * 1024 {
            return Err(runtime_error("附件必须是 1 byte 到 25 MiB 的普通文件"));
        }
        // Prefer the original source file name for the multipart filename and
        // MIME detection. The staged file is copied to a generic `input.bin`,
        // which would otherwise lose the real extension (e.g. `.png`).
        let display_name = if source_name.is_empty() {
            source.file_name().and_then(|v| v.to_str())
        } else {
            Some(source_name)
        };
        let name = display_name
            .filter(|v| !v.is_empty())
            .ok_or_else(|| runtime_error("附件文件名无效"))?
            .to_owned();
        let mime = attachment_mime(std::path::Path::new(&name))
            .or_else(|| attachment_mime(source))
            .ok_or_else(|| runtime_error("不支持的附件类型"))?;
        let payload = tokio::fs::read(source)
            .await
            .map_err(|e| runtime_error(format!("读取附件失败: {e}")))?;
        let mime_owned = mime.to_owned();
        let name_owned = name.clone();
        let client = self.client.clone();
        let url = self.session_endpoint(session, &["attachments"])?;
        let response = self
            .send_retrying(
                || {
                    let part = reqwest::multipart::Part::bytes(payload.clone())
                        .file_name(name_owned.clone())
                        .mime_str(&mime_owned)
                        .map_err(|e| runtime_error(format!("附件 MIME 无效: {e}")))?;
                    Ok(client
                        .post(url.clone())
                        .multipart(reqwest::multipart::Form::new().part("file", part)))
                },
                "上传附件",
            )
            .await?;
        parse_data_response(response, "上传附件失败").await
    }
    async fn session_attachment_delete(
        &self,
        session: &str,
        resource_id: &str,
    ) -> Result<(), RuntimeError> {
        let client = self.client.clone();
        let url = self.session_endpoint(session, &["attachments", resource_id])?;
        let response = self
            .send_retrying(|| Ok(client.delete(url.clone())), "删除附件")
            .await?;
        if response.status().is_success() {
            Ok(())
        } else {
            Err(runtime_error(format!(
                "删除附件失败: HTTP {}",
                response.status()
            )))
        }
    }
    async fn session_cancel(&self, session: &str, run: &str) -> Result<(), RuntimeError> {
        let current = self.get_session(session).await?;
        if current.active_run_id.as_deref() != Some(run) {
            return Err(RuntimeError::new(
                RuntimeErrorCode::RunConflict,
                "当前执行已改变，请刷新后重试",
            ));
        }
        let client = self.client.clone();
        let url = self.session_endpoint(session, &["cancel"])?;
        let response = self
            .send_retrying(|| Ok(client.post(url.clone())), "停止")
            .await?;
        let _: Value = parse_data_response(response, "停止失败，请刷新状态").await?;
        Ok(())
    }
    async fn session_approval(
        &self,
        session: &str,
        approval: &str,
        decision: PermissionDecision,
    ) -> Result<(), RuntimeError> {
        let current = self.get_session(session).await?;
        let mut request_data = None;
        if current.waiting {
            let mut before = None;
            let mut visited = 0usize;
            loop {
                let page = self
                    .feed
                    .page(session, before, super::SessionFeedView::Events)
                    .await?;
                visited += serde_json::to_vec(&page.events)
                    .map_err(|e| runtime_error(e.to_string()))?
                    .len();
                if visited > 16 * 1024 * 1024 {
                    return Err(runtime_error(
                        "审批恢复超过窗口限制，请在 Runtime 原生界面确认",
                    ));
                }
                let latest = page.events.iter().rev().find(|event| {
                    event["run_id"].as_str() == current.active_run_id.as_deref()
                        && event["data"]["approval_id"].as_str() == Some(approval)
                        && matches!(
                            event["type"].as_str(),
                            Some("approval/requested" | "approval/resolved")
                        )
                });
                if let Some(event) = latest {
                    if event["type"] == "approval/requested" {
                        request_data = Some(event["data"].clone());
                    }
                    break;
                }
                if !page.has_more || page.base_seq == Some(0) {
                    break;
                }
                if page.base_seq.is_none()
                    || before.is_some_and(|prior| page.base_seq.is_some_and(|base| base >= prior))
                {
                    return Err(runtime_error("审批历史分页没有推进"));
                }
                before = page.base_seq;
            }
        }
        let Some(data) = request_data else {
            return Err(RuntimeError::new(
                RuntimeErrorCode::PermissionExpired,
                "审批已处理或失效，请刷新会话",
            ));
        };
        let action_decision = if decision == PermissionDecision::AllowOnce {
            "approve"
        } else {
            "reject"
        };
        if !data
            .get("actions")
            .and_then(Value::as_array)
            .is_some_and(|actions| {
                !actions.is_empty()
                    && actions.iter().all(|action| {
                        action["allowed_decisions"]
                            .as_array()
                            .is_some_and(|choices| {
                                choices
                                    .iter()
                                    .any(|choice| choice.as_str() == Some(action_decision))
                            })
                    })
            })
        {
            return Err(RuntimeError::new(
                RuntimeErrorCode::SecurityDenied,
                "审批动作不支持此决定",
            ));
        }
        if let Some(choices) = data
            .get("supported_decisions")
            .or_else(|| data.get("supportedDecisions"))
            .and_then(Value::as_array)
        {
            let supported = choices
                .iter()
                .filter_map(Value::as_str)
                .any(|choice| match decision {
                    PermissionDecision::AllowOnce => matches!(choice, "approve" | "allow_once"),
                    PermissionDecision::Deny => matches!(choice, "reject" | "deny"),
                });
            if !supported {
                return Err(RuntimeError::new(
                    RuntimeErrorCode::SecurityDenied,
                    "Runtime 不支持此审批决定",
                ));
            }
        }
        let client = self.client.clone();
        let url = self.session_endpoint(session, &["approvals", approval])?;
        let payload = json!({"decision": if decision == PermissionDecision::AllowOnce { "approve" } else { "reject" }, "reason": ""});
        let response = self
            .send_retrying(|| Ok(client.post(url.clone()).json(&payload)), "提交审批")
            .await?;
        let _: Value = parse_data_response(response, "审批已失效或提交失败").await?;
        Ok(())
    }

    async fn check(&self) -> Result<(), RuntimeError> {
        let client = self.client.clone();
        let url = self.endpoint("runtime/status")?;
        let response = self
            .send_retrying(|| Ok(client.get(url.clone())), "连接 Bianbu Runtime")
            .await?;
        let status: RuntimeStatusView =
            parse_data_response(response, "读取 Bianbu Runtime 状态失败").await?;
        if status.ready() {
            Ok(())
        } else {
            Err(runtime_error(format!(
                "Bianbu Runtime 尚未就绪: {}",
                status.status
            )))
        }
    }

    async fn start(&self) -> Result<DriverStart, RuntimeError> {
        let (sender, receiver) = mpsc::unbounded_channel();
        *self.lifecycle.lock().await = Some(sender);
        Ok(DriverStart {
            lifecycle_events: receiver,
        })
    }

    async fn stop(&self) -> Result<(), RuntimeError> {
        for task in self.feed_tasks.lock().await.drain(..) {
            task.abort();
        }
        self.runs.lock().await.clear();
        self.approvals.lock().await.clear();
        self.lifecycle.lock().await.take();
        Ok(())
    }

    async fn create_session(
        &self,
        session_id: &str,
        title: Option<&str>,
        _cwd: PathBuf,
    ) -> Result<String, RuntimeError> {
        self.create_session_for_agent(session_id, title, None, _cwd)
            .await
    }

    async fn create_session_for_agent(
        &self,
        session_id: &str,
        title: Option<&str>,
        agent_id: Option<&str>,
        _cwd: PathBuf,
    ) -> Result<String, RuntimeError> {
        let agent_id = agent_id.filter(|id| !id.trim().is_empty()).ok_or_else(|| {
            RuntimeError::new(
                RuntimeErrorCode::SessionCreateFailed,
                "请选择可用 Agent 后创建会话",
            )
        })?;
        let payload = json!({"id": session_id, "agent_id": agent_id,
            "title": title.unwrap_or_default(), "metadata": {"bibit_session_id": session_id}});
        let (status, body) = match self
            .post_json("sessions", &payload, "创建 Bianbu Session")
            .await
        {
            Ok(result) => result,
            Err(first_error) => match self
                .get_created("sessions", session_id, "创建 Bianbu Session")
                .await?
            {
                Some(result) => result,
                None => self
                    .post_json("sessions", &payload, "重试创建 Bianbu Session")
                    .await
                    .map_err(|_| first_error)?,
            },
        };
        if !status.is_success() {
            return Err(http_error(status, &body, "创建 Bianbu Session 失败"));
        }
        let session: RuntimeSession = serde_json::from_value(body["data"].clone())
            .map_err(|error| runtime_error(format!("Session 响应无效: {error}")))?;
        if session.agent_id != agent_id {
            return Err(runtime_error("Runtime 返回了不同的 Agent 绑定"));
        }
        Ok(session.id)
    }

    async fn list_agents(&self) -> Result<Vec<super::RuntimeAgent>, RuntimeError> {
        let client = self.client.clone();
        let url = self.endpoint("agents")?;
        let response = self
            .send_retrying(|| Ok(client.get(url.clone())), "读取 Agent 失败")
            .await?;
        parse_data_response(response, "读取 Agent 失败").await
    }

    async fn delete_session(&self, session_id: &str) -> Result<(), RuntimeError> {
        let client = self.client.clone();
        let url = self.session_endpoint(session_id, &[])?;
        let response = self
            .send_retrying(|| Ok(client.delete(url.clone())), "删除会话")
            .await?;
        let status = response.status();
        if status.is_success() {
            return Ok(());
        }
        let body = response.json().await.unwrap_or(Value::Null);
        Err(http_error(status, &body, "删除会话失败"))
    }

    async fn clear_context(&self, session_id: &str) -> Result<RuntimeSession, RuntimeError> {
        let client = self.client.clone();
        let url = self.session_endpoint(session_id, &["clear-context"])?;
        let response = self
            .send_retrying(|| Ok(client.post(url.clone())), "清空上下文")
            .await?;
        parse_data_response(response, "清空上下文失败").await
    }

    async fn generate_title(
        &self,
        session_id: &str,
        message_id: &str,
        content: &str,
    ) -> Result<super::SessionTitleResult, RuntimeError> {
        let client = self.client.clone();
        let url = self.session_endpoint(session_id, &["generate-title"])?;
        let payload = json!({"message_id": message_id, "content": content});
        let response = self
            .send_retrying(|| Ok(client.post(url.clone()).json(&payload)), "生成标题")
            .await?;
        parse_data_response(response, "生成标题失败").await
    }

    async fn rename_session(&self, session_id: &str, title: &str) -> Result<(), RuntimeError> {
        let path = format!("sessions/{session_id}");
        let (status, body) = self
            .patch_json(&path, &json!({ "title": title }), "重命名 Bianbu Session")
            .await?;
        if !status.is_success() {
            return Err(http_error(status, &body, "重命名 Bianbu Session 失败"));
        }
        Ok(())
    }

    async fn list_sessions(&self) -> Result<Vec<RuntimeSession>, RuntimeError> {
        let mut page = 1u64;
        let mut sessions = Vec::new();
        let client = self.client.clone();
        loop {
            let url = self.endpoint("sessions")?;
            let current_page = page;
            let response = self
                .send_retrying(
                    || {
                        Ok(client
                            .get(url.clone())
                            .query(&[("page", current_page), ("page_size", 100)]))
                    },
                    "读取 Bianbu Sessions",
                )
                .await?;
            let status = response.status();
            let body: Value = response
                .json()
                .await
                .map_err(|error| runtime_error(format!("Bianbu Runtime 响应无效: {error}")))?;
            if !status.is_success() {
                return Err(http_error(status, &body, "读取 Bianbu Sessions 失败"));
            }
            let items = body
                .get("data")
                .cloned()
                .ok_or_else(|| runtime_error("Bianbu Runtime 未返回 Sessions"))?;
            sessions.extend(
                serde_json::from_value::<Vec<RuntimeSession>>(items)
                    .map_err(|error| runtime_error(format!("Bianbu Sessions 响应无效: {error}")))?,
            );
            if !body
                .pointer("/page/has_more")
                .and_then(Value::as_bool)
                .ok_or_else(|| runtime_error("Bianbu Sessions 缺少分页状态，无法确认历史完整性"))?
            {
                return Ok(sessions);
            }
            page += 1;
        }
    }

    async fn get_session(&self, session_id: &str) -> Result<RuntimeSession, RuntimeError> {
        let mut url = self.endpoint("sessions")?;
        url.path_segments_mut()
            .map_err(|_| runtime_error("Bianbu Runtime 地址不能承载路径"))?
            .push(session_id);
        let client = self.client.clone();
        let page_url = url.clone();
        let response = self
            .send_retrying(|| Ok(client.get(page_url.clone())), "读取 Bianbu Session")
            .await?;
        parse_data_response(response, "读取 Bianbu Session 失败").await
    }

    async fn list_messages(&self, session_id: &str) -> Result<Vec<RuntimeMessage>, RuntimeError> {
        let events = self.fetch_session_events(session_id).await?;
        parse_session_messages(session_id, events)
    }

    async fn prompt(
        &self,
        request: DriverPromptRequest,
    ) -> Result<mpsc::UnboundedReceiver<DriverEvent>, RuntimeError> {
        // 游标取在 Run 创建之前：首批 `text.delta` 可能在 POST 返回前就已落库，
        // 从水位之后读才不会漏掉回答的开头。
        let from_seq = self.session_event_tail(&request.session_id).await;
        let path = format!("sessions/{}/prompt", request.session_id);
        let payload = json!({
            "message_id": request.run_id,
            "content": request.prompt,
            "attachments": [],
            "skill_ids": [],
        });
        let (status, body) = self.post_json(&path, &payload, "创建 Bianbu Run").await?;
        if !status.is_success() {
            return Err(runtime_error(api_error(&body, "创建 Bianbu Run 失败")));
        }
        let backend_run_id = body
            .pointer("/data/run_id")
            .and_then(Value::as_str)
            .ok_or_else(|| runtime_error("Bianbu Runtime 未返回 Run 标识"))?
            .to_owned();
        self.runs.lock().await.insert(
            request.run_id.clone(),
            (request.session_id.clone(), backend_run_id.clone()),
        );
        self.subscribe_session(
            request.session_id,
            backend_run_id,
            request.run_id,
            from_seq,
            Vec::new(),
        )
        .await
    }

    async fn attach_run(
        &self,
        run_id: &str,
        cursor: u64,
    ) -> Result<mpsc::UnboundedReceiver<DriverEvent>, RuntimeError> {
        let (session_id, backend_run_id) = self.backend_session_and_run(run_id).await?;
        if cursor > 0 {
            // 调用方自带游标：直接从它继续。
            return self
                .subscribe_session(
                    session_id,
                    backend_run_id,
                    run_id.to_owned(),
                    cursor,
                    Vec::new(),
                )
                .await;
        }
        // 接管进行中的 Run：先用一次最新可见窗口把它已经产出的事件补投出去
        // （会话历史里没有进行中回答那一行），再从最后一条补投事件的下一个 seq 接着流。
        let prime = self.session_window_events(&session_id).await;
        let from_seq = if prime.is_empty() {
            // 窗口没读到内容（空会话，或这次读失败）：退回水位。宁可不补投，
            // 也不能从 seq 0 起跳，那会让 Runtime 重放整段会话。
            self.session_event_tail(&session_id).await
        } else {
            prime
                .iter()
                .filter_map(|item| item.get("seq").and_then(Value::as_u64))
                .max()
                .map_or(0, |seq| seq + 1)
        };
        self.subscribe_session(
            session_id,
            backend_run_id,
            run_id.to_owned(),
            from_seq,
            prime,
        )
        .await
    }

    async fn cancel(&self, _session_id: &str, run_id: &str) -> Result<(), RuntimeError> {
        let (session_id, _) = self.backend_session_and_run(run_id).await?;
        let client = self.client.clone();
        let url = self.session_endpoint(&session_id, &["cancel"])?;
        let response = self
            .send_retrying(|| Ok(client.post(url.clone())), "取消 Bianbu Run")
            .await?;
        let status = response.status();
        let body = response.json::<Value>().await.unwrap_or_else(|_| json!({}));
        if status.is_success() {
            Ok(())
        } else {
            Err(runtime_error(api_error(
                &body,
                "Bianbu Runtime 拒绝取消 Run",
            )))
        }
    }

    async fn resolve_permission(
        &self,
        request_id: &str,
        decision: PermissionDecision,
    ) -> Result<(), RuntimeError> {
        let (session_id, approval_id) = self
            .approvals
            .lock()
            .await
            .get(request_id)
            .cloned()
            .ok_or_else(|| runtime_error("Bianbu 审批请求不存在"))?;
        let path = format!("sessions/{session_id}/approvals/{approval_id}");
        let payload = json!({
            "decision": match decision {
                PermissionDecision::AllowOnce => "approve",
                PermissionDecision::Deny => "reject",
            },
            "reason": "",
        });
        let (status, body) = self.post_json(&path, &payload, "提交 Bianbu 审批").await?;
        if status.is_success() {
            self.approvals.lock().await.remove(request_id);
            Ok(())
        } else {
            Err(runtime_error(api_error(
                &body,
                "Bianbu Runtime 拒绝审批决定",
            )))
        }
    }

    async fn cancel_permission(&self, request_id: &str) -> Result<(), RuntimeError> {
        if self.approvals.lock().await.contains_key(request_id) {
            self.resolve_permission(request_id, PermissionDecision::Deny)
                .await
        } else {
            Ok(())
        }
    }
}

async fn parse_data_response<T: serde::de::DeserializeOwned>(
    response: reqwest::Response,
    fallback: &str,
) -> Result<T, RuntimeError> {
    let status = response.status();
    let body: Value = response
        .json()
        .await
        .map_err(|error| runtime_error(format!("Bianbu Runtime 响应无效: {error}")))?;
    if !status.is_success() {
        return Err(http_error(status, &body, fallback));
    }
    serde_json::from_value(
        body.get("data")
            .cloned()
            .ok_or_else(|| runtime_error("Bianbu Runtime 未返回 data"))?,
    )
    .map_err(|error| runtime_error(format!("Bianbu Runtime data 响应无效: {error}")))
}

/// 单个 Run 的事件订阅上下文：把 Runtime 事件映射成 `DriverEvent` 转发给 gateway，
/// 同时维护游标与断线状态。`cursor` 是「下一条要读的 seq」。
struct SessionEventFeed<'a> {
    events: &'a mpsc::UnboundedSender<DriverEvent>,
    approvals: &'a Arc<Mutex<HashMap<String, (String, String)>>>,
    session_id: &'a str,
    run_id: &'a str,
    backend_run_id: &'a str,
    cursor: u64,
    /// 订阅结束：接收端已关闭，或 Run 已终止。
    stop: bool,
    connected_reported: bool,
    reconnecting: bool,
}

impl SessionEventFeed<'_> {
    async fn catch_up(&mut self, hub: &FeedHub) -> Result<(), RuntimeError> {
        tokio::time::timeout(Duration::from_secs(60), async {
            loop {
                let page = hub.replay(self.session_id, self.cursor).await?;
                if page.is_empty() {
                    return Ok(());
                }
                for item in page {
                    self.deliver(&item).await;
                    if self.stop {
                        return Ok(());
                    }
                }
            }
        })
        .await
        .map_err(|_| runtime_error("Run 事件补读超时，请重新加载会话"))?
    }

    /// 转发一条 Runtime 事件。早于游标的事件（该 Run 之外的补投、重复投递）直接丢弃，
    /// 但游标仍随之推进，重连时不必再读一遍。
    async fn deliver(&mut self, item: &Value) {
        let Some(seq) = item.get("seq").and_then(Value::as_u64) else {
            return;
        };
        if seq < self.cursor {
            return;
        }
        self.cursor = seq + 1;
        let event_run_id = item
            .get("run_id")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if event_run_id != self.backend_run_id {
            return;
        }
        let Some(event) = map_session_event(self.run_id, item) else {
            return;
        };
        match &event {
            DriverEvent::PermissionRequested { request, .. } => {
                let approval_id = item
                    .get("data")
                    .and_then(|data| data.get("approval_id"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                self.approvals.lock().await.insert(
                    request.request_id.clone(),
                    (self.session_id.to_owned(), approval_id),
                );
            }
            DriverEvent::PermissionResolved { request_id, .. } => {
                self.approvals.lock().await.remove(request_id);
            }
            _ => {}
        }
        let terminal = matches!(
            event,
            DriverEvent::Completed { .. }
                | DriverEvent::Cancelled { .. }
                | DriverEvent::Failed { .. }
        );
        if self.events.send(event).is_err() || terminal {
            self.stop = true;
        }
    }

    fn report_connected(&mut self) {
        if self.reconnecting || !self.connected_reported {
            let _ = self.events.send(DriverEvent::ConnectionStatusChanged {
                run_id: self.run_id.into(),
                status: RuntimeConnectionStatus::Connected,
                message: None,
            });
            self.connected_reported = true;
            self.reconnecting = false;
        }
    }

    fn report_reconnecting(&mut self, message: String) {
        if !self.reconnecting {
            let _ = self.events.send(DriverEvent::ConnectionStatusChanged {
                run_id: self.run_id.into(),
                status: RuntimeConnectionStatus::Reconnecting,
                message: Some(message),
            });
            self.reconnecting = true;
        }
    }
}

/// 事件信封里的「下一条要读的 seq」：取 `last_seq` 与页内最大 `seq` 的较大者。
fn next_event_seq_after(envelope: &Value) -> u64 {
    let last = envelope.get("last_seq").and_then(Value::as_u64);
    let page_max = envelope
        .get("data")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("seq").and_then(Value::as_u64))
                .max()
        })
        .flatten();
    match [last, page_max].into_iter().flatten().max() {
        Some(seq) => seq + 1,
        None => 0,
    }
}

fn map_session_event(run_id: &str, item: &Value) -> Option<DriverEvent> {
    let event_type = item.get("type")?.as_str()?;
    let data = item.get("data").unwrap_or(&Value::Null);
    let event = match event_type {
        "assistant/text.delta" => DriverEvent::TextDelta {
            run_id: run_id.into(),
            message_id: "assistant".into(),
            delta: data.get("text")?.as_str()?.into(),
        },
        "assistant/reasoning.delta" => DriverEvent::ReasoningDelta {
            run_id: run_id.into(),
            message_id: "assistant".into(),
            delta: data.get("text")?.as_str()?.into(),
        },
        "tool/call.started" => DriverEvent::ToolStarted {
            run_id: run_id.into(),
            tool_call_id: tool_call_id(data)?.into(),
            name: data.get("name")?.as_str()?.into(),
            input: Some(data.get("arguments").cloned().unwrap_or_else(|| json!({}))),
        },
        "tool/call.progress" => DriverEvent::ToolUpdated {
            run_id: run_id.into(),
            tool_call_id: tool_call_id(data)?.into(),
            update: json!({ "content": data.get("content").and_then(Value::as_str).unwrap_or_default() }),
        },
        "tool/call.completed" => {
            let failed = !matches!(
                data.get("status").and_then(Value::as_str),
                None | Some("success") | Some("completed")
            );
            DriverEvent::ToolCompleted {
                run_id: run_id.into(),
                tool_call_id: tool_call_id(data)?.into(),
                result: Some(data.get("result").cloned().unwrap_or(Value::Null)),
                error: failed.then(|| "Bianbu 工具执行失败".into()),
            }
        }
        "tool/call.rejected" => DriverEvent::ToolCompleted {
            run_id: run_id.into(),
            tool_call_id: tool_call_id(data)?.into(),
            result: None,
            error: Some(
                data.get("reason")
                    .and_then(Value::as_str)
                    .unwrap_or("Bianbu 工具调用被拒绝")
                    .into(),
            ),
        },
        "approval/requested" => {
            let approval_id = data.get("approval_id")?.as_str()?.to_owned();
            let request_id = format!("{run_id}:{approval_id}");
            let actions = data
                .get("actions")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let first = actions.first();
            let tool_call_id = first
                .and_then(tool_call_id)
                .unwrap_or(&approval_id)
                .to_owned();
            let tool_name = if actions.len() == 1 {
                first
                    .and_then(|action| action.get("name"))
                    .and_then(Value::as_str)
                    .unwrap_or("bianbu_action")
                    .to_owned()
            } else {
                "bianbu_batch_actions".into()
            };
            DriverEvent::PermissionRequested {
                run_id: run_id.into(),
                request: DriverPermissionRequest {
                    request_id,
                    tool_call_id,
                    title: if actions.len() > 1 {
                        format!("批准 {} 个操作", actions.len())
                    } else {
                        format!("批准 {tool_name}")
                    },
                    description: "Bianbu Runtime 请求执行以下操作".into(),
                    tool_name,
                    input_summary: Some(Value::Array(actions)),
                    can_allow_once: true,
                    can_deny: true,
                    unsupported_decisions: unsupported_decisions(data),
                    allow_once_option_id: None,
                    reject_once_option_id: None,
                },
            }
        }
        "approval/resolved" => {
            let approval_id = data.get("approval_id")?.as_str()?;
            let decision = match data.get("decision").and_then(Value::as_str) {
                Some("approve") | Some("approved") => PermissionDecision::AllowOnce,
                _ => PermissionDecision::Deny,
            };
            DriverEvent::PermissionResolved {
                run_id: run_id.into(),
                request_id: format!("{run_id}:{approval_id}"),
                decision,
            }
        }
        "run/completed" => DriverEvent::Completed {
            run_id: run_id.into(),
            stop_reason: "stop".into(),
        },
        "run/cancelled" => DriverEvent::Cancelled {
            run_id: run_id.into(),
            reason: data
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("cancelled")
                .into(),
        },
        "run/failed" => {
            let error = data
                .get("error")
                .filter(|value| value.is_object())
                .cloned()
                .unwrap_or_else(|| json!({}));
            failed(run_id, &error)
        }
        _ => return None,
    };
    Some(event)
}

fn parse_session_messages(
    session_id: &str,
    events: Vec<Value>,
) -> Result<Vec<RuntimeMessage>, RuntimeError> {
    let mut events = events;
    events.sort_by_key(|item| item.get("seq").and_then(Value::as_u64).unwrap_or(0));
    let mut messages: Vec<RuntimeMessage> = Vec::new();
    let mut assistant_by_run: HashMap<String, usize> = HashMap::new();
    for item in events {
        let Some(event_type) = item.get("type").and_then(Value::as_str) else {
            continue;
        };
        let seq = item.get("seq").and_then(Value::as_u64);
        let run_id = item
            .get("run_id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let data = item.get("data").unwrap_or(&Value::Null);
        match event_type {
            "user/message" => messages.push(RuntimeMessage {
                id: format!("{session_id}:message:{}", seq.unwrap_or(0)),
                role: "user".into(),
                content: data
                    .get("content")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                request_id: Some(run_id),
                created_at: None,
                seq,
                extra: BTreeMap::new(),
            }),
            "assistant/text.delta" => {
                let text = data.get("text").and_then(Value::as_str).unwrap_or_default();
                let index = if let Some(&index) = assistant_by_run.get(&run_id) {
                    index
                } else {
                    let index = messages.len();
                    messages.push(RuntimeMessage {
                        id: format!("{session_id}:message:{}", seq.unwrap_or(0)),
                        role: "assistant".into(),
                        content: String::new(),
                        request_id: Some(run_id.clone()),
                        created_at: None,
                        seq,
                        extra: BTreeMap::new(),
                    });
                    assistant_by_run.insert(run_id, index);
                    index
                };
                messages[index].content.push_str(text);
            }
            "run/completed" => {
                let content = data
                    .get("content")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if let Some(&index) = assistant_by_run.get(&run_id) {
                    if !content.is_empty() {
                        messages[index].content = content.to_owned();
                    }
                } else if !content.is_empty() {
                    messages.push(RuntimeMessage {
                        id: format!("{session_id}:message:{}", seq.unwrap_or(0)),
                        role: "assistant".into(),
                        content: content.to_owned(),
                        request_id: Some(run_id),
                        created_at: None,
                        seq,
                        extra: BTreeMap::new(),
                    });
                }
            }
            _ => {}
        }
    }
    Ok(messages)
}

fn tool_call_id(value: &Value) -> Option<&str> {
    value
        .get("tool_call_id")
        .or_else(|| value.get("call_id"))
        .and_then(Value::as_str)
}

fn api_error(value: &Value, fallback: &str) -> String {
    parse_error(value, fallback)
}

fn failed(run_id: &str, value: &Value) -> DriverEvent {
    let code = match value.get("code").and_then(Value::as_str) {
        Some("run_incomplete") => RuntimeErrorCode::RunIncomplete,
        Some("run_interrupted") => RuntimeErrorCode::RunInterrupted,
        Some("skill_unavailable") => RuntimeErrorCode::SkillUnavailable,
        Some("security_denied") => RuntimeErrorCode::SecurityDenied,
        Some("security_unavailable") => RuntimeErrorCode::SecurityUnavailable,
        Some("network_policy_blocked") => RuntimeErrorCode::NetworkPolicyBlocked,
        Some("provider_timeout") => RuntimeErrorCode::ProviderTimeout,
        Some("provider_connection_failed") => RuntimeErrorCode::ProviderConnectionFailed,
        Some("TOKEN_BUDGET_EXCEEDED") => RuntimeErrorCode::TokenBudgetExceeded,
        Some("worker_rpc_error") => RuntimeErrorCode::WorkerRpcError,
        _ => RuntimeErrorCode::RunFailed,
    };
    let mut error = RuntimeError::new(
        code,
        value
            .get("message")
            .and_then(Value::as_str)
            .filter(|message| !message.trim().is_empty())
            .unwrap_or("Bianbu Runtime 运行失败"),
    );
    // Runtime 是「能不能重试」的唯一权威。以前这里按 code 猜（只认 security_denied /
    // skill_unavailable），Runtime 每加一个错误码两边就漂移一次。旧 Runtime 不带
    // 这个字段时才退回按 code 推断。
    error.recoverable = value
        .get("retryable")
        .and_then(Value::as_bool)
        .unwrap_or_else(|| {
            !matches!(
                code,
                RuntimeErrorCode::SecurityDenied | RuntimeErrorCode::SkillUnavailable
            )
        });
    error.details = value
        .get("details")
        .filter(|value| value.is_object())
        .cloned();
    DriverEvent::Failed {
        run_id: run_id.into(),
        error,
    }
}

fn runtime_error(message: impl Into<String>) -> RuntimeError {
    RuntimeError::new(RuntimeErrorCode::RunFailed, message)
}

fn unsupported_decisions(value: &Value) -> Vec<String> {
    value
        .get("supported_decisions")
        .or_else(|| value.get("supportedDecisions"))
        .or_else(|| value.get("decisions"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|decision| !matches!(*decision, "allow_once" | "deny" | "approve" | "reject"))
        .map(str::to_owned)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn session_attachment_refs_use_the_runtime_wire_contract() {
        let attachments = [super::super::SessionAttachmentRef {
            resource_id: "resource-1".into(),
        }];

        assert_eq!(
            session_attachment_refs(&attachments),
            vec![json!({"resource_id": "resource-1"})]
        );
    }

    #[tokio::test]
    async fn session_history_posts_identity_and_decodes_receipt() {
        use http_body_util::{BodyExt, Full};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            hyper::server::conn::http1::Builder::new()
                .serve_connection(hyper_util::rt::TokioIo::new(socket), hyper::service::service_fn(|request: hyper::Request<hyper::body::Incoming>| async move {
                    assert_eq!(request.method(), hyper::Method::POST);
                    assert_eq!(request.uri().path(), "/api/v1/sessions/session-1/history");
                    let body = request.into_body().collect().await.unwrap().to_bytes();
                    let value: Value = serde_json::from_slice(&body).unwrap();
                    assert_eq!(value, json!({"operation_id":"op-1", "expected_seq":12,
                        "action":"continue", "message_id":"run:3", "content":null}));
                    Ok::<_, std::convert::Infallible>(hyper::Response::builder()
                        .header("connection", "close")
                        .body(Full::new(hyper::body::Bytes::from_static(
                            br#"{"data":{"accepted":true,"operation_id":"op-1","seq":13,"run_id":"next"}}"#))).unwrap())
                })).await.unwrap();
        });
        let driver = BianbuHttpDriver::new(&format!("http://{address}/api/v1")).unwrap();
        let result = driver
            .session_history(super::super::SessionHistoryRequest {
                target_id: driver.target_id(),
                session_id: "session-1".into(),
                operation_id: "op-1".into(),
                expected_seq: 12,
                action: "continue".into(),
                message_id: "run:3".into(),
                content: None,
            })
            .await
            .unwrap();
        assert!(result.accepted);
        assert_eq!(result.run_id.as_deref(), Some("next"));
        server.await.unwrap();
    }

    fn driver() -> BianbuHttpDriver {
        BianbuHttpDriver::new("http://127.0.0.1:9899/api/v1").unwrap()
    }

    #[test]
    fn bianbu_declares_durable_detached_replay_capabilities() {
        let capabilities = driver().capabilities();
        assert!(capabilities.durable_sessions);
        assert!(capabilities.detached_runs);
        assert!(capabilities.replayable_events);
        assert!(capabilities.skill_selection);
    }

    #[test]
    fn maps_session_text_and_tool_events() {
        let text = map_session_event(
            "run-1",
            &json!({"type":"assistant/text.delta","data":{"text":"ok"}}),
        )
        .unwrap();
        assert!(matches!(
            text,
            DriverEvent::TextDelta { run_id, delta, .. } if run_id == "run-1" && delta == "ok"
        ));

        let reasoning = map_session_event(
            "run-1",
            &json!({"type":"assistant/reasoning.delta","data":{"text":"分析"}}),
        )
        .unwrap();
        assert!(matches!(
            reasoning,
            DriverEvent::ReasoningDelta { delta, .. } if delta == "分析"
        ));

        let tool = map_session_event(
            "run-1",
            &json!({"type":"tool/call.started","data":{"call_id":"call-1","name":"terminal","arguments":{"command":"pwd"}}}),
        )
        .unwrap();
        assert!(matches!(
            tool,
            DriverEvent::ToolStarted { tool_call_id, name, .. }
                if tool_call_id == "call-1" && name == "terminal"
        ));

        let completed = map_session_event(
            "run-1",
            &json!({"type":"tool/call.completed","data":{"call_id":"call-1","name":"terminal","result":"ok","status":"success"}}),
        )
        .unwrap();
        assert!(matches!(
            completed,
            DriverEvent::ToolCompleted { tool_call_id, error: None, .. }
                if tool_call_id == "call-1"
        ));
    }

    #[test]
    fn maps_session_approval_events() {
        let requested = map_session_event(
            "run-1",
            &json!({"type":"approval/requested","data":{"approval_id":"approval-1","actions":[{"name":"terminal"},{"name":"write_file"}]}}),
        )
        .unwrap();
        let DriverEvent::PermissionRequested { request, .. } = requested else {
            panic!("expected permission request");
        };
        assert_eq!(request.request_id, "run-1:approval-1");
        assert_eq!(request.tool_name, "bianbu_batch_actions");

        let resolved = map_session_event(
            "run-1",
            &json!({"type":"approval/resolved","data":{"approval_id":"approval-1","decision":"approve"}}),
        )
        .unwrap();
        assert!(matches!(
            resolved,
            DriverEvent::PermissionResolved { request_id, decision, .. }
                if request_id == "run-1:approval-1" && decision == PermissionDecision::AllowOnce
        ));
    }

    #[test]
    fn maps_session_terminal_events() {
        let completed = map_session_event(
            "run-1",
            &json!({"type":"run/completed","data":{"status":"completed","content":"ok"}}),
        )
        .unwrap();
        assert!(matches!(completed, DriverEvent::Completed { run_id, .. } if run_id == "run-1"));

        let failed = map_session_event(
            "run-1",
            &json!({"type":"run/failed","data":{"status":"failed","error":{"code":"security_denied","message":"capability denied","details":{"capability":"terminal.execute"}}}}),
        )
        .unwrap();
        let DriverEvent::Failed { error, .. } = failed else {
            panic!("expected failure");
        };
        assert_eq!(error.code, RuntimeErrorCode::SecurityDenied);
        assert_eq!(
            error.details,
            Some(json!({"capability": "terminal.execute"}))
        );
    }

    #[test]
    fn parses_session_messages_from_event_log() {
        let messages = parse_session_messages(
            "session-1",
            vec![
                json!({"seq":1,"type":"user/message","run_id":"run-1","data":{"content":"hello"}}),
                json!({"seq":2,"type":"assistant/text.delta","run_id":"run-1","data":{"text":"world"}}),
                json!({"seq":3,"type":"run/completed","run_id":"run-1","data":{"status":"completed","content":"world"}}),
            ],
        )
        .unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[0].content, "hello");
        assert_eq!(messages[1].role, "assistant");
        assert_eq!(messages[1].content, "world");
    }

    #[tokio::test]
    async fn resolves_approval_against_session_endpoint() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            loop {
                let mut chunk = [0; 1024];
                let read = socket.read(&mut chunk).await.unwrap();
                assert_ne!(read, 0);
                request.extend_from_slice(&chunk[..read]);
                let Some(header_end) = request.windows(4).position(|part| part == b"\r\n\r\n")
                else {
                    continue;
                };
                let headers = String::from_utf8_lossy(&request[..header_end]);
                let content_length = headers
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or_default();
                if request.len() >= header_end + 4 + content_length {
                    break;
                }
            }
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")
                .await
                .unwrap();
            String::from_utf8(request).unwrap()
        });

        let driver = BianbuHttpDriver::new(&format!("http://{address}/api/v1")).unwrap();
        driver.approvals.lock().await.insert(
            "local-run:approval-1".into(),
            ("session-local".into(), "approval-1".into()),
        );

        driver
            .resolve_permission("local-run:approval-1", PermissionDecision::AllowOnce)
            .await
            .unwrap();
        let request = server.await.unwrap();

        assert!(request
            .starts_with("POST /api/v1/sessions/session-local/approvals/approval-1 HTTP/1.1"));
        assert!(request.contains(r#""decision":"approve""#));
    }
}

fn http_error(status: StatusCode, body: &Value, fallback: &str) -> RuntimeError {
    let detail = body
        .get("error")
        .or_else(|| body.get("detail"))
        .unwrap_or(body);
    let backend_code = detail.get("code").and_then(Value::as_str);
    let mut error = RuntimeError::new(
        match (status, backend_code) {
            (StatusCode::CONFLICT, _) => RuntimeErrorCode::SessionConflict,
            (_, Some("skill_unavailable")) => RuntimeErrorCode::SkillUnavailable,
            _ => RuntimeErrorCode::RunFailed,
        },
        detail
            .get("message")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| api_error(body, fallback)),
    );
    error.recoverable =
        status.is_server_error() && error.code != RuntimeErrorCode::SkillUnavailable;
    error.details = Some(
        json!({"backendCode": detail.get("code"), "httpStatus": status.as_u16(), "backendDetails": detail.get("details")}),
    );
    error
}
