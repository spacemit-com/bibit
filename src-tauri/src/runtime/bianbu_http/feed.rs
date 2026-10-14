use super::*;
use crate::runtime::{SessionFeed, SessionFeedEvent, SessionFeedView};
use futures_util::StreamExt;
use std::collections::HashSet;
use std::sync::Mutex as StdMutex;
use tokio::sync::{broadcast, oneshot};
use tokio::task::JoinHandle;
use tokio::time::Instant;

mod actor;
use actor::{Command, FeedActor};

const CONTROL_TIMEOUT: Duration = Duration::from_secs(2);
const RECOVERY_TIMEOUT: Duration = Duration::from_secs(60);

struct ActorLifecycle {
    inbox: Option<mpsc::Receiver<Command>>,
    task: Option<JoinHandle<()>>,
}

struct ActorOwner {
    commands: mpsc::Sender<Command>,
    lifecycle: StdMutex<ActorLifecycle>,
}

impl Drop for ActorOwner {
    fn drop(&mut self) {
        if let Some(task) = self
            .lifecycle
            .get_mut()
            .unwrap_or_else(|error| error.into_inner())
            .task
            .take()
        {
            task.abort();
        }
    }
}

#[derive(Clone)]
pub(super) struct FeedHub {
    reader: PageReader,
    owner: Arc<ActorOwner>,
    live: broadcast::Sender<(String, Vec<Value>)>,
}

#[derive(Clone)]
struct PageReader {
    client: Client,
    base: Arc<Url>,
    target: String,
    cursor_reads: Arc<std::sync::atomic::AtomicBool>,
}

impl FeedHub {
    pub fn new(client: Client, base: Arc<Url>, target: String) -> Self {
        let (commands, inbox) = mpsc::channel(64);
        Self {
            reader: PageReader {
                client,
                base,
                target,
                cursor_reads: Arc::new(std::sync::atomic::AtomicBool::new(true)),
            },
            owner: Arc::new(ActorOwner {
                commands,
                lifecycle: StdMutex::new(ActorLifecycle {
                    inbox: Some(inbox),
                    task: None,
                }),
            }),
            live: broadcast::channel(4096).0,
        }
    }

    fn ensure_actor(&self) {
        let mut lifecycle = self
            .owner
            .lifecycle
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some(inbox) = lifecycle.inbox.take() {
            let actor = FeedActor::new(self.reader.clone(), self.live.clone());
            lifecycle.task = Some(tokio::spawn(actor.run(inbox)));
        }
    }

    async fn command<T>(
        &self,
        create: impl FnOnce(oneshot::Sender<T>) -> Command,
    ) -> Result<T, RuntimeError> {
        self.ensure_actor();
        let deadline = Instant::now() + CONTROL_TIMEOUT;
        let (reply, result) = oneshot::channel();
        tokio::time::timeout_at(deadline, async {
            self.owner
                .commands
                .send(create(reply))
                .await
                .map_err(|_| runtime_error("事件管理任务已关闭"))?;
            result
                .await
                .map_err(|_| runtime_error("事件管理任务已关闭"))
        })
        .await
        .map_err(|_| runtime_error("事件管理命令超时"))?
    }

    pub fn live(&self) -> broadcast::Receiver<(String, Vec<Value>)> {
        self.live.subscribe()
    }

    pub fn target_id(&self) -> String {
        self.reader.target.clone()
    }

    pub async fn initial(
        &self,
        session: &str,
        before: Option<u64>,
        view: SessionFeedView,
    ) -> Result<SessionFeed, RuntimeError> {
        let ticket = self
            .command(|reply| Command::Inspect {
                session: session.into(),
                reply,
            })
            .await?;
        let mut page = self.reader.page(session, before, view).await?;
        let end = page.events.last().and_then(watermark);
        page.connection_status = self
            .command(|reply| Command::Initial {
                session: session.into(),
                ticket,
                end,
                latest: before.is_none(),
                reply,
            })
            .await??;
        Ok(page)
    }

    pub async fn page(
        &self,
        session: &str,
        before: Option<u64>,
        view: SessionFeedView,
    ) -> Result<SessionFeed, RuntimeError> {
        self.reader.page(session, before, view).await
    }

    pub fn spawn(&self, output: mpsc::Sender<SessionFeedEvent>) -> Vec<JoinHandle<()>> {
        let hub = self.clone();
        vec![tokio::spawn(async move {
            let cancel = tokio_util::sync::CancellationToken::new();
            let _guard = cancel.clone().drop_guard();
            if hub
                .command(|reply| Command::Start {
                    output: output.clone(),
                    cancel: cancel.clone(),
                    reply,
                })
                .await
                .is_err()
            {
                return;
            }
            tokio::select! {
                _ = output.closed() => {}
                _ = cancel.cancelled() => {}
            }
        })]
    }

    pub async fn replay(&self, session: &str, from_seq: u64) -> Result<Vec<Value>, RuntimeError> {
        self.reader
            .read_page(
                session,
                SessionFeedView::Events,
                PageRead::After { from_seq },
            )
            .await
            .map(|page| page.events)
    }
}

#[derive(Clone, Copy)]
enum PageRead {
    Window { before: Option<u64> },
    After { from_seq: u64 },
}

impl PageRead {
    fn apply(&self, request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        match *self {
            PageRead::Window { before } => {
                let request = request.query(&[("max_messages", 50)]);
                match before {
                    Some(before) => request.query(&[("before_seq", before)]),
                    None => request,
                }
            }
            PageRead::After { from_seq } => request.query(&[("from_seq", from_seq)]),
        }
    }
    /// 游标读消费的是一条没被折叠的原始流：页面必须正好从请求的位置开始、且内部连续。
    /// 两者都能坏：忽略 from_seq 的服务端会把窗口当成游标页返回，数据缺口则说明事件真的丢了。
    /// 窗口快照仍按原规则校验：Events 要求窗口内连续，History 只要求递增。
    fn validate(&self, view: SessionFeedView, events: &[Value]) -> Result<(), RuntimeError> {
        match (self, view) {
            (PageRead::After { from_seq }, _) => validate_cursor_page(events, *from_seq),
            (_, SessionFeedView::Events) => validate_sequence(events),
            (_, SessionFeedView::History) => validate_advancing(events),
        }
    }
}

impl PageReader {
    fn event(&self, session: &str, kind: &str) -> SessionFeedEvent {
        SessionFeedEvent {
            target_id: self.target.clone(),
            runtime_epoch: String::new(),
            session_id: session.into(),
            kind: kind.into(),
            events: vec![],
            hidden_run_ids: vec![],
            summary: None,
            connection_status: "connected".into(),
            message: None,
        }
    }
    pub async fn page(
        &self,
        session: &str,
        before: Option<u64>,
        view: SessionFeedView,
    ) -> Result<SessionFeed, RuntimeError> {
        self.read_page(session, view, PageRead::Window { before })
            .await
    }
    async fn read_page(
        &self,
        session: &str,
        view: SessionFeedView,
        read: PageRead,
    ) -> Result<SessionFeed, RuntimeError> {
        let mut url = self
            .base
            .join("sessions")
            .map_err(|e| runtime_error(e.to_string()))?;
        url.path_segments_mut()
            .map_err(|_| runtime_error("无效的 Session URL"))?
            .push(session)
            .push(match view {
                SessionFeedView::Events => "events",
                SessionFeedView::History => "history",
            });
        let request = read.apply(self.client.get(url).timeout(Duration::from_secs(15)));
        let response = request
            .send()
            .await
            .map_err(|e| runtime_error(e.to_string()))?;
        let status = response.status();
        let mut bytes = Vec::new();
        let mut chunks = response.bytes_stream();
        while let Some(chunk) = chunks.next().await {
            let chunk = chunk.map_err(|e| runtime_error(e.to_string()))?;
            if bytes.len() + chunk.len() > 32 * 1024 * 1024 {
                return Err(protocol_error(
                    "事件页超过 32 MiB，无法安全恢复；请缩小服务端消息输出后重新加载",
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        let body: Value =
            serde_json::from_slice(&bytes).map_err(|_| protocol_error("事件页 JSON 协议无效"))?;
        if !status.is_success() {
            return Err(http_error(status, &body, "读取事件失败"));
        }
        let events = body["data"]
            .as_array()
            .cloned()
            .ok_or_else(|| protocol_error("事件页缺少 data"))?;
        read.validate(view, &events)?;
        let events = events
            .into_iter()
            .map(bound_event)
            .collect::<Result<Vec<_>, _>>()?;
        let mut public_url = (*self.base).clone();
        let _ = public_url.set_username("");
        let _ = public_url.set_password(None);
        public_url.set_query(None);
        public_url.set_fragment(None);
        Ok(SessionFeed {
            resource_base_url: public_url.to_string(),
            target_id: self.target.clone(),
            runtime_epoch: String::new(),
            session_id: session.into(),
            base_seq: events.first().and_then(seq),
            last_seq: body["last_seq"].as_u64(),
            events,
            hidden_run_ids: serde_json::from_value(body["hidden_run_ids"].clone())
                .unwrap_or_default(),
            has_more: body["has_more"].as_bool().unwrap_or(false),
            connection_status: "connected".into(),
            persistence: body.get("persistence").cloned(),
        })
    }
    async fn recover(
        &self,
        session: &str,
        cursor: Option<u64>,
        tx: &mpsc::Sender<SessionFeedEvent>,
    ) -> Result<Option<u64>, RuntimeError> {
        // 有游标就按游标增量补洞：只读缺的那一段，代价与缺失量成正比。
        if let Some(cursor) = cursor {
            match self.recover_after(session, cursor, tx).await {
                Ok(Some(end)) => return Ok(Some(end)),
                Ok(None) => {}
                Err(error) => return Err(error),
            }
        }
        // 没有游标、或 Runtime 不认 from_seq 时退回窗口快照：重叠判定依赖未打断的 seq
        // 游标，折叠会破坏它，所以这里必须读原始事件流；代价与整段会话成正比。
        let mut page = match self.page(session, None, SessionFeedView::Events).await {
            Ok(page) => page,
            Err(error) => return Err(error),
        };
        // 服务端尾部比我们记住的位置短，只可能是它重启后从最后一个完整批次恢复：
        // 内存优先语义下这是正常情况，按服务端尾部重载窗口并让订阅方替换自己的
        // 窗口，不能当成协议错误把会话挂成「已暂停，请重新加载」。
        let cursor = match cursor {
            Some(cursor) if page.last_seq.is_some_and(|tail| tail < cursor) => {
                tx.send(self.event(session, "reset"))
                    .await
                    .map_err(|_| runtime_error("订阅已关闭"))?;
                None
            }
            other => other,
        };
        let mut pages = vec![];
        let mut bytes = 0;
        loop {
            bytes += serde_json::to_vec(&page.events)
                .map_err(|e| runtime_error(e.to_string()))?
                .len();
            if bytes > 16 * 1024 * 1024 {
                return Err(protocol_error("恢复窗口超过 16 MiB，请重新加载会话历史"));
            }
            let overlap = cursor.map_or(true, |c| {
                page.base_seq
                    .map_or(true, |base| base <= c.saturating_add(1))
            });
            let before = page.base_seq;
            pages.push(page);
            if overlap {
                break;
            }
            // 已知边界无法再向前推进（起点已被达成/未知）时必须以重新加载会话为准；
            // 但 has_more 为 false 不足以据此报错：_history_page 的可见消息边界可能从
            // base_seq>0 开始（会剔除 agent/inbox/spliced(seq=0)/claimed(seq=1)），此时
            // before_seq=base_seq 仍能取回更早的不可见事件。故不能因 !more 提前终止，
            // 而应继续按 before_seq=base_seq 向前翻页，直到 base_seq 到达 0 或未推进。
            if before == Some(0) || before.is_none() {
                return Err(protocol_error("历史未覆盖已知边界，必须重新加载会话"));
            }
            page = self.page(session, before, SessionFeedView::Events).await?;
            if page.base_seq >= before {
                return Err(protocol_error("历史分页没有向前推进"));
            }
        }
        let mut end = cursor;
        let mut hidden = HashSet::new();
        for page in pages.into_iter().rev() {
            hidden.extend(page.hidden_run_ids);
            let mut event = self.event(session, "events");
            event.hidden_run_ids = hidden.iter().cloned().collect();
            let mut window_next: Option<u64> = None;
            for item in page.events {
                let n = seq(&item).ok_or_else(|| protocol_error("事件缺少 seq"))?;
                if end.is_some_and(|end| n <= end) {
                    continue;
                }
                // 仅要求同一窗口内连续（validate_sequence 已保证；此处防御性校验）。
                // 跨窗口边界允许跳跃：HTTP 权威窗口由 _history_page 从第一个可见消息
                // 边界开始，会剔除 agent/inbox/spliced(seq=0)/agent/inbox/claimed(seq=1)，
                // 因此窗口首项与上一窗口尾部/end 之间天然不连续，不能按全局 n==end+1 判错。
                if window_next.is_some_and(|want| n != want) {
                    return Err(protocol_error("恢复事件仍有缺口"));
                }
                window_next = Some(n + 1);
                end = Some(n);
                event.events.push(item);
            }
            tx.send(event)
                .await
                .map_err(|_| runtime_error("订阅已关闭"))?;
        }
        Ok(end)
    }

    async fn recover_after(
        &self,
        session: &str,
        cursor: u64,
        tx: &mpsc::Sender<SessionFeedEvent>,
    ) -> Result<Option<u64>, RuntimeError> {
        if !self.cursor_reads.load(std::sync::atomic::Ordering::SeqCst) {
            return Ok(None);
        }
        let mut end = cursor;
        loop {
            let page = match self
                .read_page(
                    session,
                    SessionFeedView::Events,
                    PageRead::After { from_seq: end + 1 },
                )
                .await
            {
                Ok(page) => page,
                Err(error) if unsupported_cursor_read(&error) => {
                    self.cursor_reads
                        .store(false, std::sync::atomic::Ordering::SeqCst);
                    return Ok(None);
                }
                Err(error) => return Err(error),
            };
            let mut event = self.event(session, "events");
            for item in page.events {
                let n = seq(&item).ok_or_else(|| protocol_error("事件缺少 seq"))?;
                if n <= end {
                    continue;
                }
                end = n;
                event.events.push(item);
            }
            let advanced = !event.events.is_empty();
            if advanced {
                tx.send(event)
                    .await
                    .map_err(|_| runtime_error("订阅已关闭"))?;
            }
            // 没推进就不能再要下一页：宁可交出游标，让下一次真事件再触发一次补洞。
            if !page.has_more || !advanced {
                // 游标之后的位点在服务端已经不存在（尾部回退了），交还 None 让上层
                // 按服务端尾部重载窗口，而不是抱着一个不存在的位点继续等。
                if !advanced && page.last_seq.is_some_and(|tail| tail < end) {
                    return Ok(None);
                }
                return Ok(Some(end));
            }
        }
    }
}

// 保留 seq/类型/审批身份及终态；仅裁剪展示正文，实时和 HTTP 使用同一规则。
fn bound_event(mut event: Value) -> Result<Value, RuntimeError> {
    let bytes = serde_json::to_vec(&event)
        .map_err(|_| protocol_error("事件无法编码"))?
        .len();
    if bytes <= crate::runtime::MAX_EVENT_BYTES {
        return Ok(event);
    }
    if event["type"]
        .as_str()
        .is_some_and(|kind| kind.starts_with("approval/"))
    {
        return Err(protocol_error(
            "审批详情超过安全显示上限，无法展示完整动作；请在 Runtime 原生界面处理",
        ));
    }
    fn trim(value: &mut Value, depth: usize) {
        match value {
            Value::String(text) if text.len() > 16 * 1024 => {
                let mut end = 16 * 1024;
                while !text.is_char_boundary(end) {
                    end -= 1;
                }
                text.truncate(end);
                text.push_str("\n[显示正文已截断，原始内容保留在 Runtime]");
            }
            Value::Object(fields) if depth < 16 => {
                for value in fields.values_mut() {
                    trim(value, depth + 1);
                }
            }
            Value::Array(items) if depth < 16 => {
                for value in items {
                    trim(value, depth + 1);
                }
            }
            _ => {}
        }
    }
    if let Some(data) = event.get_mut("data") {
        trim(data, 0);
        if let Some(fields) = data.as_object_mut() {
            fields.insert("_display_truncated".into(), Value::Bool(true));
            fields.insert("_original_bytes".into(), json!(bytes));
        }
    }
    if serde_json::to_vec(&event)
        .map_err(|_| protocol_error("事件无法编码"))?
        .len()
        > crate::runtime::MAX_EVENT_BYTES
    {
        return Err(protocol_error(
            "事件元数据超出安全窗口，审批或终态未丢弃；请在 Runtime 原生界面处理后重新加载",
        ));
    }
    Ok(event)
}

pub(super) fn protocol_error(message: &str) -> RuntimeError {
    let mut error = runtime_error(message);
    error.recoverable = false;
    error
}
fn seq(value: &Value) -> Option<u64> {
    value["seq"].as_u64()
}
/// 一条事件覆盖到的最新 seq：折叠组记在 `data.seq_range` 末尾，其余就是它自己。
fn watermark(event: &Value) -> Option<u64> {
    event["data"]["seq_range"]
        .as_array()
        .and_then(|span| span.get(1))
        .and_then(Value::as_u64)
        .or_else(|| seq(event))
}
/// Runtime 是否拒绝了这个查询参数：旧 Runtime 用 4xx 回应不认识的 `from_seq`。
///
/// 只认参数校验类错误。404 是「会话不存在」，退回快照后由原逻辑清理游标，不能据此把整台
/// Runtime 的游标读能力关掉。
fn session_not_found(error: &RuntimeError) -> bool {
    error
        .details
        .as_ref()
        .and_then(|details| details["httpStatus"].as_u64())
        == Some(404)
}

fn unsupported_cursor_read(error: &RuntimeError) -> bool {
    matches!(
        error
            .details
            .as_ref()
            .and_then(|details| details["httpStatus"].as_u64()),
        Some(400 | 422)
    )
}

// 游标页必须正好从请求的位置开始：比请求早说明服务端忽略了 from_seq，比请求晚说明中间少了事件。
fn validate_cursor_page(events: &[Value], from_seq: u64) -> Result<(), RuntimeError> {
    if events
        .first()
        .and_then(seq)
        .is_some_and(|first| first != from_seq)
    {
        return Err(protocol_error("游标页没有从请求的位置开始"));
    }
    validate_sequence(events)
}

pub fn validate_sequence(events: &[Value]) -> Result<(), RuntimeError> {
    let mut previous = None;
    for event in events {
        let n = seq(event).ok_or_else(|| protocol_error("事件缺少 seq"))?;
        if previous.is_some_and(|p| n != p + 1) {
            return Err(protocol_error("事件页有序号缺口"));
        }
        previous = Some(n);
    }
    Ok(())
}
// 折叠页只保证 seq 严格递增；乱序或重复都说明折叠把顺序弄坏了。
pub fn validate_advancing(events: &[Value]) -> Result<(), RuntimeError> {
    let mut previous = None;
    for event in events {
        let n = seq(event).ok_or_else(|| protocol_error("事件缺少 seq"))?;
        if previous.is_some_and(|p| n <= p) {
            return Err(protocol_error("事件页有序号回溯"));
        }
        previous = Some(n);
    }
    Ok(())
}

#[cfg(test)]
mod tests;
