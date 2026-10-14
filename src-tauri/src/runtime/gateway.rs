use super::bianbu_http::BianbuHttpDriver;
use super::driver::{
    DriverEvent, DriverLifecycleEvent, DriverPermissionRequest, DriverPromptRequest, RuntimeDriver,
};
use super::hermes_acp::HermesAcpDriver;
use super::{
    CommandAck, PermissionDecision, PermissionDecisionReceipt, PermissionDenyReason,
    PermissionRequest, PermissionResolveRequest, PermissionResolveStatus, RunCancelRequest,
    RunStartRequest, RunStartResult, RuntimeCapabilities, RuntimeError, RuntimeErrorCode,
    RuntimeEvent, RuntimeEventEnvelope, RuntimeMessage, RuntimeSession, RuntimeSnapshot,
    RuntimeStatus, SessionCreateRequest, SessionCreateResult, MAX_EVENT_BYTES,
    MAX_TOOL_VALUE_BYTES, PERMISSION_TIMEOUT_SECS, RUNTIME_ID,
};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::ops::{Deref, DerefMut};
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex, MutexGuard as StdMutexGuard, OnceLock};
use std::time::Instant;
use tokio::sync::{oneshot, Mutex};
use tokio::time::{sleep, Duration};

// 突发事件共用一次IPC；控制帧/目标边界不合并，最多16个已限长事件（4MiB）。
async fn next_session_batch(
    events: &mut tokio::sync::mpsc::Receiver<super::SessionFeedEvent>,
    pending: &mut Option<super::SessionFeedEvent>,
) -> Option<super::SessionFeedEvent> {
    let mut event = match pending.take() {
        Some(event) => event,
        None => events.recv().await?,
    };
    if event.kind != "events" || event.events.len() >= 16 {
        return Some(event);
    }
    sleep(Duration::from_millis(8)).await;
    for _ in 0..15 {
        if event.events.len() >= 16 {
            break;
        }
        let Ok(next) = events.try_recv() else { break };
        if next.kind != "events"
            || next.target_id != event.target_id
            || next.session_id != event.session_id
            || next.runtime_epoch != event.runtime_epoch
            || next.connection_status != event.connection_status
            || next.message != event.message
            || event.events.len() + next.events.len() > 16
        {
            *pending = Some(next);
            break;
        }
        event.events.extend(next.events);
        for id in next.hidden_run_ids {
            if !event.hidden_run_ids.contains(&id) {
                event.hidden_run_ids.push(id);
            }
        }
    }
    Some(event)
}

const CANCEL_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_PERMISSION_RECEIPTS: usize = 4_096;

/// 状态锁的观测包装。两件事：
///   1. `lock()` 是 `async fn`，但内部是同步互斥——守卫不是 `Send`，所以编译器不允许
///      「持状态锁跨 await」。P3 那条硬不变量（临界区里不许有 await / I-O / IPC）由编译器兜底，
///      不靠人记得。
///   2. 记录等待时长与持有时长并超阈值报错。下一次「读取会话超时」要能直接指出是谁占着锁，
///      而不是像 2026-09-16 那次只能靠 socket 队列反推。
struct ObservedMutex<T> {
    inner: StdMutex<T>,
}

/// 超过这个量级就不是抖动。读会话的硬超时是 15s，2s 足够早报警。
const SLOW_LOCK_WAIT: Duration = Duration::from_secs(2);
const SLOW_LOCK_HOLD: Duration = Duration::from_secs(2);
/// 压力信号的有效期：这段时间内出现过慢等待/慢持锁，就把读超时归因到本机排队。
const LOCK_PRESSURE_TTL: Duration = Duration::from_secs(30);
/// 进程内只有一个 gateway，压力信号用静态量即可，不必把 gateway 传到错误构造点。
static LOCK_PRESSURE_AT_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn note_lock_pressure() {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis() as u64)
        .unwrap_or(0);
    LOCK_PRESSURE_AT_MS.store(now_ms, std::sync::atomic::Ordering::Relaxed);
}

/// 最近是否出现过状态锁排队。读超时时用它区分「本机拥塞」与「Runtime 慢」。
pub fn state_lock_pressure() -> bool {
    let last = LOCK_PRESSURE_AT_MS.load(std::sync::atomic::Ordering::Relaxed);
    if last == 0 {
        return false;
    }
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis() as u64)
        .unwrap_or(0);
    now_ms.saturating_sub(last) <= LOCK_PRESSURE_TTL.as_millis() as u64
}

impl<T> ObservedMutex<T> {
    fn new(value: T) -> Self {
        Self {
            inner: StdMutex::new(value),
        }
    }

    /// 调用点写法保持 `self.state.lock().await`，但拿到的守卫不能跨 await。
    async fn lock(&self) -> ObservedGuard<'_, T> {
        let waiting = Instant::now();
        let inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        // 持有时长从「拿到锁」起算，注入的停顿也算在内——它本来就是持着锁睡的，
        // 不计进去会让 state_lock_hold 永远测不到真正的长持有。
        let since = Instant::now();
        let waited = waiting.elapsed();
        if waited >= SLOW_LOCK_WAIT {
            note_lock_pressure();
            log::error!(
                "gateway 状态锁等待 {}ms code=state_lock_wait",
                waited.as_millis()
            );
        }
        if let Some(hold) = fault_inject("state_hold_ms") {
            log::warn!(
                "gateway 故障注入：持状态锁 {}ms code=fault_inject_state_hold",
                hold.as_millis()
            );
            std::thread::sleep(hold);
        }
        ObservedGuard { inner, since }
    }

    fn try_lock(&self) -> Option<ObservedGuard<'_, T>> {
        self.inner.try_lock().ok().map(|inner| ObservedGuard {
            inner,
            since: Instant::now(),
        })
    }
}

struct ObservedGuard<'a, T> {
    inner: StdMutexGuard<'a, T>,
    since: Instant,
}

impl<T> Drop for ObservedGuard<'_, T> {
    fn drop(&mut self) {
        let held = self.since.elapsed();
        if held >= SLOW_LOCK_HOLD {
            note_lock_pressure();
            log::error!(
                "gateway 状态锁持有 {}ms code=state_lock_hold",
                held.as_millis()
            );
        }
    }
}

impl<T> Deref for ObservedGuard<'_, T> {
    type Target = T;
    fn deref(&self) -> &T {
        &self.inner
    }
}

impl<T> DerefMut for ObservedGuard<'_, T> {
    fn deref_mut(&mut self) -> &mut T {
        &mut self.inner
    }
}

/// `BIBIT_FAULT_INJECT=state_hold_ms=60000`：在持状态锁期间注入停顿，用来在真机上复现
/// 「全局锁被长期占用 → 所有读排队 → 15s 超时」。未设置时只是一次 HashMap 查找。
fn fault_inject(name: &str) -> Option<Duration> {
    static CONFIG: OnceLock<HashMap<String, u64>> = OnceLock::new();
    CONFIG
        .get_or_init(|| {
            std::env::var("BIBIT_FAULT_INJECT")
                .ok()
                .map(|raw| {
                    raw.split(',')
                        .filter_map(|entry| {
                            let (key, value) = entry.split_once('=')?;
                            Some((key.trim().to_owned(), value.trim().parse().ok()?))
                        })
                        .collect()
                })
                .unwrap_or_default()
        })
        .get(name)
        .map(|millis| Duration::from_millis(*millis))
}

fn runtime_name(runtime_id: &str) -> &str {
    if runtime_id == "bianbu" {
        "Bianbu Runtime"
    } else {
        "Hermes"
    }
}

pub trait RuntimeEventSink: Send + Sync {
    fn emit_session(&self, _event: &super::SessionFeedEvent) -> Result<(), RuntimeError> {
        Ok(())
    }
    fn emit(&self, event: &RuntimeEventEnvelope) -> Result<(), RuntimeError>;
}

/// 控制面身份快照。存在理由：读路径（读会话窗口、翻页）只需要 epoch，
/// 却因为 epoch 住在 `GatewayState` 里而被绑上全局状态锁——2026-09-16 的
/// 「读取会话 15s 超时」就是这条耦合。现在 epoch 有唯一写入口 `set_runtime_epoch`，
/// 读路径只读这份快照，永远不进状态锁的等待队列。
#[derive(Clone, Default)]
struct RuntimeIdentity {
    epoch: Option<String>,
}

struct GatewayState {
    runtime_id: String,
    status: RuntimeStatus,
    runtime_epoch: Option<String>,
    runtime_sequence: u64,
    last_error: Option<RuntimeError>,
    cleanup_pending: bool,
    stop_driver_completed: bool,
    reset_unpublished_runs_on_start: bool,
    sessions: HashMap<String, String>,
    runs: HashMap<String, RunRecord>,
    active_by_session: HashMap<String, String>,
    permissions: HashMap<String, PermissionRecord>,
    receipts: HashMap<String, PermissionDecisionReceipt>,
    receipt_order: VecDeque<String>,
}

impl Default for GatewayState {
    fn default() -> Self {
        Self {
            runtime_id: RUNTIME_ID.into(),
            status: RuntimeStatus::Stopped,
            runtime_epoch: None,
            runtime_sequence: 0,
            last_error: None,
            cleanup_pending: false,
            stop_driver_completed: false,
            reset_unpublished_runs_on_start: false,
            sessions: HashMap::new(),
            runs: HashMap::new(),
            active_by_session: HashMap::new(),
            permissions: HashMap::new(),
            receipts: HashMap::new(),
            receipt_order: VecDeque::new(),
        }
    }
}

struct RunRecord {
    session_id: String,
    driver_session_id: String,
    next_sequence: u64,
    terminal: bool,
    awaiting_driver_terminal: bool,
    cancel_sent: bool,
    detach: Option<oneshot::Sender<()>>,
}

struct PermissionRecord {
    runtime_instance_id: String,
    runtime_id: String,
    runtime_epoch: String,
    session_id: String,
    thread_id: String,
    run_id: String,
    tool_call_id: String,
    expires_at: String,
    resolved_decision: Option<PermissionDecision>,
    can_allow_once: bool,
    action_set_digest: Option<String>,
}

enum RunEnvelopeBuild {
    Missing,
    Terminal,
    Candidate {
        envelope: RuntimeEventEnvelope,
        synthesized_terminal: bool,
    },
}

enum RunPublishOutcome {
    Missing,
    IgnoredAfterTerminal,
    Duplicate,
    Published {
        terminal: bool,
        synthesized_terminal: bool,
        driver_session_id: String,
    },
}

struct RunPublishResult {
    outcome: RunPublishOutcome,
}

pub struct MinimalRuntimeGateway {
    driver: Arc<dyn RuntimeDriver>,
    sink: Arc<dyn RuntimeEventSink>,
    state: ObservedMutex<GatewayState>,
    /// 与 `GatewayState::runtime_epoch` 同步的只读快照。写入口只有 `set_runtime_epoch`。
    identity: std::sync::RwLock<RuntimeIdentity>,
    publish_lock: Mutex<()>,
    start_lock: Mutex<()>,
    session_lock: Mutex<()>,
    cancel_lock: Mutex<()>,
    permission_lock: Mutex<()>,
    receipt_path: Option<PathBuf>,
}

impl MinimalRuntimeGateway {
    pub fn production(runtime_cwd: PathBuf, sink: Arc<dyn RuntimeEventSink>) -> Arc<Self> {
        Arc::new(Self::new(
            Arc::new(HermesAcpDriver::production(runtime_cwd)),
            sink,
        ))
    }

    pub fn production_default(
        runtime_cwd: PathBuf,
        sink: Arc<dyn RuntimeEventSink>,
    ) -> Result<Arc<Self>, RuntimeError> {
        Ok(Arc::new(
            Self::new(Arc::new(BianbuHttpDriver::from_env()?), sink)
                .with_receipt_store(runtime_cwd.join("permission-receipts.json")),
        ))
    }

    pub fn new(driver: Arc<dyn RuntimeDriver>, sink: Arc<dyn RuntimeEventSink>) -> Self {
        let mut state = GatewayState::default();
        state.runtime_id = driver.runtime_id().into();
        Self {
            driver,
            sink,
            state: ObservedMutex::new(state),
            identity: std::sync::RwLock::new(RuntimeIdentity::default()),
            publish_lock: Mutex::new(()),
            start_lock: Mutex::new(()),
            session_lock: Mutex::new(()),
            cancel_lock: Mutex::new(()),
            permission_lock: Mutex::new(()),
            receipt_path: None,
        }
    }

    pub fn with_receipt_store(mut self, path: PathBuf) -> Self {
        if let Ok(source) = fs::read(&path) {
            if let Ok(receipts) = serde_json::from_slice::<Vec<PermissionDecisionReceipt>>(&source)
            {
                if let Some(mut state) = self.state.try_lock() {
                    for receipt in receipts.into_iter().rev() {
                        let key = receipt_key(&receipt);
                        if state.receipts.contains_key(&key) {
                            continue;
                        }
                        state.receipts.insert(key.clone(), receipt);
                        state.receipt_order.push_front(key);
                        if state.receipt_order.len() == MAX_PERMISSION_RECEIPTS {
                            break;
                        }
                    }
                }
            }
        }
        self.receipt_path = Some(path);
        self
    }

    async fn persist_receipt(
        &self,
        receipt: PermissionDecisionReceipt,
    ) -> PermissionDecisionReceipt {
        let (path, receipts) = {
            let mut state = self.state.lock().await;
            let key = receipt_key(&receipt);
            if state.receipts.contains_key(&key) {
                state.receipt_order.retain(|existing| existing != &key);
            }
            state.receipt_order.push_back(key.clone());
            state.receipts.insert(key, receipt.clone());
            while state.receipt_order.len() > MAX_PERMISSION_RECEIPTS {
                if let Some(oldest) = state.receipt_order.pop_front() {
                    state.receipts.remove(&oldest);
                }
            }
            let path = self.receipt_path.clone();
            let receipts = path
                .as_ref()
                .map(|_| {
                    state
                        .receipt_order
                        .iter()
                        .filter_map(|key| state.receipts.get(key).cloned())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            (path, receipts)
        };
        if let Some(path) = path {
            if let Some(parent) = path.parent() {
                if fs::create_dir_all(parent).is_err() {
                    log::warn!(
                        "permission receipt store directory is not writable code=receipt_store_directory"
                    );
                    return receipt;
                }
            }
            let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
            if let Ok(bytes) = serde_json::to_vec_pretty(&receipts) {
                if fs::write(&temporary, bytes).is_err() {
                    log::warn!("permission receipt store is not writable code=receipt_store_write");
                    let _ = fs::remove_file(&temporary);
                } else if fs::rename(&temporary, &path).is_err() {
                    log::warn!(
                        "permission receipt store atomic replace failed code=receipt_store_rename"
                    );
                    let _ = fs::remove_file(&temporary);
                }
            } else {
                log::warn!("permission receipt serialization failed code=receipt_store_serialize");
                let _ = fs::remove_file(&temporary);
            }
        }
        receipt
    }

    pub async fn snapshot(&self) -> RuntimeSnapshot {
        let state = self.state.lock().await;
        snapshot(&state)
    }

    /// 读 epoch：只碰快照，不碰状态锁。
    fn runtime_epoch(&self) -> String {
        self.identity_snapshot().epoch.unwrap_or_default()
    }

    fn identity_snapshot(&self) -> RuntimeIdentity {
        self.identity
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// epoch 的唯一写入口：`state` 与快照在同一次临界区更新。
    /// 调用点都已在状态锁内，`identity` 是叶子锁（读它的人不再拿别的锁），不会形成环。
    fn set_runtime_epoch(&self, state: &mut GatewayState, epoch: Option<String>) {
        state.runtime_epoch = epoch;
        let epoch = state.runtime_epoch.clone();
        let mut identity = self
            .identity
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        identity.epoch = epoch;
    }

    /// 锁外投递 runtime 信封：序号在锁内按当下值定下，投递成功后再回锁里推进。
    /// 调用方全程持有 `publish_lock`，所以锁外这段时间没有别的发布者能插队。
    async fn emit_runtime_envelope(
        &self,
        envelope: &RuntimeEventEnvelope,
    ) -> Result<(), RuntimeError> {
        self.sink.emit(envelope)?;
        self.state.lock().await.runtime_sequence += 1;
        Ok(())
    }

    pub async fn list_skills(&self) -> Result<Vec<serde_json::Value>, RuntimeError> {
        self.driver.list_skills().await
    }
    pub fn target_id(&self) -> String {
        self.driver.target_id()
    }
    pub async fn session_feed(
        &self,
        session: &str,
        before: Option<u64>,
        view: super::SessionFeedView,
    ) -> Result<super::SessionFeed, RuntimeError> {
        let mut page = self.driver.session_feed(session, before, view).await?;
        page.runtime_epoch = self.runtime_epoch();
        Ok(page)
    }
    pub async fn session_history(
        &self,
        request: super::SessionHistoryRequest,
    ) -> Result<super::SessionHistoryResult, RuntimeError> {
        request.validate()?;
        if request.target_id != self.target_id() {
            return Err(RuntimeError::new(
                RuntimeErrorCode::SessionConflict,
                "Runtime 目标已改变，请重新加载会话",
            ));
        }
        self.driver.session_history(request).await
    }
    /// 跨会话正文检索。空查询直接返回空结果：Runtime 的 `q` 是 1–200 字符，
    /// 拿空串去换一个 422 没有任何信息量。
    pub async fn search_sessions(
        &self,
        query: &str,
        limit: u32,
    ) -> Result<Vec<super::RuntimeSearchHit>, RuntimeError> {
        let query = query.trim();
        if query.is_empty() {
            return Ok(Vec::new());
        }
        self.driver
            .search_sessions(query, limit.clamp(1, 50))
            .await
    }
    pub async fn session_submit(
        &self,
        request: super::SessionSubmitRequest,
    ) -> Result<super::SessionSubmitResult, RuntimeError> {
        request.validate()?;
        self.driver.session_submit(request).await
    }
    pub async fn session_attachment_upload(
        &self,
        session: &str,
        source: &std::path::Path,
        source_name: &str,
    ) -> Result<super::SessionAttachment, RuntimeError> {
        self.require_ready().await?;
        self.driver
            .session_attachment_upload(session, source, source_name)
            .await
    }
    pub async fn session_attachment_delete(
        &self,
        session: &str,
        resource_id: &str,
    ) -> Result<(), RuntimeError> {
        self.require_ready().await?;
        self.driver
            .session_attachment_delete(session, resource_id)
            .await
    }
    pub async fn session_cancel(
        &self,
        session: &str,
        run: &str,
    ) -> Result<CommandAck, RuntimeError> {
        self.driver.session_cancel(session, run).await?;
        Ok(CommandAck {
            accepted: true,
            duplicate: false,
        })
    }
    pub async fn session_approval(
        &self,
        session: &str,
        approval: &str,
        decision: PermissionDecision,
    ) -> Result<CommandAck, RuntimeError> {
        self.driver
            .session_approval(session, approval, decision)
            .await?;
        Ok(CommandAck {
            accepted: true,
            duplicate: false,
        })
    }

    pub fn capabilities(&self) -> RuntimeCapabilities {
        self.driver.capabilities()
    }

    pub fn runtime_id(&self) -> &'static str {
        self.driver.runtime_id()
    }

    pub async fn list_sessions(&self) -> Result<Vec<RuntimeSession>, RuntimeError> {
        self.require_ready().await?;
        self.driver.list_sessions().await
    }

    pub async fn restore_session(&self, session_id: &str) -> Result<RuntimeSession, RuntimeError> {
        self.require_ready().await?;
        let session = self.driver.get_session(session_id).await?;
        if session.id != session_id {
            return Err(RuntimeError::new(
                RuntimeErrorCode::SessionConflict,
                "Runtime returned a different Session id",
            ));
        }
        self.state
            .lock()
            .await
            .sessions
            .insert(session_id.to_owned(), session.id.clone());
        Ok(session)
    }

    pub async fn list_messages(
        &self,
        session_id: &str,
    ) -> Result<Vec<RuntimeMessage>, RuntimeError> {
        self.require_ready().await?;
        self.driver.list_messages(session_id).await
    }

    async fn require_ready(&self) -> Result<(), RuntimeError> {
        if self.state.lock().await.status == RuntimeStatus::Ready {
            Ok(())
        } else {
            Err(RuntimeError::new(
                RuntimeErrorCode::RunFailed,
                "Agent runtime is not ready",
            ))
        }
    }

    pub async fn start(self: &Arc<Self>) -> Result<RuntimeSnapshot, RuntimeError> {
        let _lifecycle_guard = self.start_lock.lock().await;
        let retry_stopped_publish = {
            let state = self.state.lock().await;
            state.status == RuntimeStatus::Stopping && state.stop_driver_completed
        };
        if retry_stopped_publish {
            self.publish_stopped_and_commit().await?;
        }
        let cleanup_failed_driver = {
            let state = self.state.lock().await;
            if state.status == RuntimeStatus::Ready {
                return Ok(snapshot(&state));
            }
            let cleanup = state.status == RuntimeStatus::Failed && state.cleanup_pending;
            cleanup
        };
        if cleanup_failed_driver {
            self.driver.stop().await?;
            self.state.lock().await.cleanup_pending = false;
        }
        {
            let state = self.state.lock().await;
            if state.status == RuntimeStatus::Failed
                && !state.active_by_session.is_empty()
                && !state.reset_unpublished_runs_on_start
            {
                return Err(state.last_error.clone().unwrap_or_else(|| {
                    RuntimeError::new(
                        RuntimeErrorCode::InternalError,
                        "Runtime has unpublished terminal events",
                    )
                }));
            }
        }

        let checking_result = {
            let _publish_guard = self.publish_lock.lock().await;
            let envelope = {
                let mut state = self.state.lock().await;
                state.status = RuntimeStatus::Checking;
                let epoch = Some(uuid::Uuid::new_v4().to_string());
                self.set_runtime_epoch(&mut state, epoch);
                state.runtime_sequence = 0;
                state.last_error = None;
                state.cleanup_pending = false;
                state.stop_driver_completed = false;
                state.reset_unpublished_runs_on_start = false;
                state.sessions.clear();
                state.runs.clear();
                state.active_by_session.clear();
                state.permissions.clear();
                let message = format!("Checking {}", runtime_name(&state.runtime_id));
                build_runtime_envelope(
                    &state,
                    RuntimeEvent::RuntimeStatusChanged {
                        status: RuntimeStatus::Checking,
                        message: Some(message),
                    },
                )
            };
            self.emit_runtime_envelope(&envelope).await
        };
        if let Err(error) = checking_result {
            self.fail_runtime(error.clone()).await;
            return Err(error);
        }

        if let Err(error) = self.driver.check().await {
            self.fail_runtime(error.clone()).await;
            return Err(error);
        }

        let starting_result = {
            let _publish_guard = self.publish_lock.lock().await;
            let envelope = {
                let mut state = self.state.lock().await;
                state.status = RuntimeStatus::Starting;
                let message = format!("Starting {}", runtime_name(&state.runtime_id));
                build_runtime_envelope(
                    &state,
                    RuntimeEvent::RuntimeStatusChanged {
                        status: RuntimeStatus::Starting,
                        message: Some(message),
                    },
                )
            };
            self.emit_runtime_envelope(&envelope).await
        };
        if let Err(error) = starting_result {
            self.fail_runtime(error.clone()).await;
            return Err(error);
        }

        let mut lifecycle_events = match self.driver.start().await {
            Ok(started) => started.lifecycle_events,
            Err(error) => {
                self.fail_runtime(error.clone()).await;
                return Err(error);
            }
        };

        let lifecycle_epoch = self
            .state
            .lock()
            .await
            .runtime_epoch
            .clone()
            .unwrap_or_default();
        if self.capabilities().session_events {
            let mut events = self.driver.session_downlink().await?;
            let gateway = self.clone();
            let epoch = lifecycle_epoch.clone();
            tokio::spawn(async move {
                let mut pending = None;
                while let Some(mut event) = next_session_batch(&mut events, &mut pending).await {
                    // 活跃性检查在锁内，投递在锁外。`emit_session` 会写进有界事件通道，
                    // 通道一满就会停在这里：持着状态锁停 = 把所有读会话一起拖死（2026-09-16).
                    let live = {
                        let state = gateway.state.lock().await;
                        state.runtime_epoch.as_deref() == Some(epoch.as_str())
                            && !matches!(
                                state.status,
                                RuntimeStatus::Stopped | RuntimeStatus::Stopping
                            )
                    };
                    if !live {
                        break;
                    }
                    event.runtime_epoch = epoch.clone();
                    if let Err(error) = gateway.sink.emit_session(&event) {
                        log::warn!("Session 广播失败: {}", error.message);
                    }
                }
            });
        }
        let gateway = self.clone();
        tokio::spawn(async move {
            if let Some(DriverLifecycleEvent::ProcessExited(error)) = lifecycle_events.recv().await
            {
                gateway.handle_process_exit(&lifecycle_epoch, error).await;
            }
        });

        tokio::task::yield_now().await;
        let ready_result = {
            let _publish_guard = self.publish_lock.lock().await;
            let outcome = {
                let mut state = self.state.lock().await;
                if state.status != RuntimeStatus::Starting {
                    let error = state.last_error.clone().unwrap_or_else(|| {
                        RuntimeError::new(
                            RuntimeErrorCode::ProcessExited,
                            "Agent runtime exited while starting",
                        )
                    });
                    Err((error, state.cleanup_pending))
                } else {
                    state.status = RuntimeStatus::Ready;
                    let message = format!("{} ready", runtime_name(&state.runtime_id));
                    Ok(build_runtime_envelope(
                        &state,
                        RuntimeEvent::RuntimeStatusChanged {
                            status: RuntimeStatus::Ready,
                            message: Some(message),
                        },
                    ))
                }
            };
            let envelope = match outcome {
                Ok(envelope) => envelope,
                Err((error, cleanup)) => {
                    drop(_publish_guard);
                    if cleanup {
                        self.stop_driver_for_cleanup().await;
                    }
                    return Err(error);
                }
            };
            self.emit_runtime_envelope(&envelope).await
        };
        if let Err(error) = ready_result {
            self.fail_runtime(error.clone()).await;
            self.stop_driver_for_cleanup().await;
            let mut state = self.state.lock().await;
            state.last_error = Some(error.clone());
            state.sessions.clear();
            state.runs.clear();
            state.active_by_session.clear();
            state.permissions.clear();
            return Err(error);
        }

        Ok(self.snapshot().await)
    }

    pub async fn create_session(
        &self,
        request: SessionCreateRequest,
        cwd: PathBuf,
    ) -> Result<SessionCreateResult, RuntimeError> {
        request.validate()?;
        if !cwd.is_absolute() {
            return Err(RuntimeError::new(
                RuntimeErrorCode::SessionCreateFailed,
                "Runtime working directory must be absolute",
            ));
        }
        let canonical_cwd = std::fs::canonicalize(&cwd).map_err(|_| {
            RuntimeError::new(
                RuntimeErrorCode::SessionCreateFailed,
                "Runtime working directory does not exist",
            )
        })?;
        if canonical_cwd != cwd {
            return Err(RuntimeError::new(
                RuntimeErrorCode::SessionCreateFailed,
                "Runtime working directory must be canonical",
            ));
        }

        let _session_guard = self.session_lock.lock().await;

        // 只做纯内存判断，driver 调用一律放到锁外：mux 背压时 driver 调用会停很久，
        // 持着状态锁等它 = 整机的读会话一起排队（2026-09-16 的原始形态）。
        let (existing_session, epoch) = {
            let state = self.state.lock().await;
            if state.status != RuntimeStatus::Ready {
                return Err(RuntimeError::new(
                    RuntimeErrorCode::SessionCreateFailed,
                    "Agent runtime is not ready",
                ));
            }
            (
                state.sessions.get(&request.session_id).cloned(),
                state.runtime_epoch.clone().unwrap_or_default(),
            )
        };
        if let Some(driver_session_id) = existing_session {
            if let Some(agent_id) = request.agent_id.as_deref() {
                let session = self.driver.get_session(&driver_session_id).await?;
                if session.agent_id != agent_id {
                    return Err(RuntimeError::new(
                        RuntimeErrorCode::SessionConflict,
                        "已有会话不能切换 Agent",
                    ));
                }
            }
            return Ok(SessionCreateResult {
                session_id: request.session_id,
                runtime_session_id: driver_session_id,
                runtime_epoch: epoch,
                reused: true,
            });
        }

        let driver_session_id = self
            .driver
            .create_session_for_agent(
                &request.session_id,
                request.title.as_deref(),
                request.agent_id.as_deref(),
                cwd,
            )
            .await?;
        let mut state = self.state.lock().await;
        if state.status != RuntimeStatus::Ready || state.runtime_epoch.as_deref() != Some(&epoch) {
            return Err(RuntimeError::new(
                RuntimeErrorCode::SessionCreateFailed,
                "Agent runtime changed while creating the session",
            ));
        }
        state
            .sessions
            .insert(request.session_id.clone(), driver_session_id.clone());
        Ok(SessionCreateResult {
            session_id: request.session_id,
            runtime_session_id: driver_session_id,
            runtime_epoch: epoch,
            reused: false,
        })
    }

    pub async fn list_agents(&self) -> Result<Vec<super::RuntimeAgent>, RuntimeError> {
        self.driver.list_agents().await
    }
    async fn managed_session_id(&self, session_id: &str) -> String {
        self.state
            .lock()
            .await
            .sessions
            .get(session_id)
            .cloned()
            .unwrap_or_else(|| session_id.to_owned())
    }
    pub async fn delete_session(&self, session_id: &str) -> Result<CommandAck, RuntimeError> {
        let id = self.managed_session_id(session_id).await;
        self.driver.delete_session(&id).await?;
        self.state.lock().await.sessions.remove(session_id);
        Ok(CommandAck {
            accepted: true,
            duplicate: false,
        })
    }
    pub async fn clear_context(&self, session_id: &str) -> Result<RuntimeSession, RuntimeError> {
        self.driver
            .clear_context(&self.managed_session_id(session_id).await)
            .await
    }
    pub async fn generate_title(
        &self,
        session_id: &str,
        message_id: &str,
        content: &str,
    ) -> Result<super::SessionTitleResult, RuntimeError> {
        self.driver
            .generate_title(
                &self.managed_session_id(session_id).await,
                message_id,
                content,
            )
            .await
    }

    pub async fn rename_session(
        &self,
        session_id: &str,
        title: &str,
    ) -> Result<CommandAck, RuntimeError> {
        let driver_session_id = self.managed_session_id(session_id).await;
        self.driver
            .rename_session(&driver_session_id, title)
            .await?;
        Ok(CommandAck {
            accepted: true,
            duplicate: false,
        })
    }

    pub async fn stop(&self) -> Result<CommandAck, RuntimeError> {
        if self.capabilities().session_events {
            let _guard = self.start_lock.lock().await;
            self.driver.stop().await?;
            let envelope = {
                let mut state = self.state.lock().await;
                state.status = RuntimeStatus::Stopped;
                state.sessions.clear();
                state.active_by_session.clear();
                state.runs.clear();
                state.permissions.clear();
                build_runtime_envelope(
                    &state,
                    RuntimeEvent::RuntimeStatusChanged {
                        status: RuntimeStatus::Stopped,
                        message: Some("已断开，服务端执行仍在后台继续".into()),
                    },
                )
            };
            self.emit_runtime_envelope(&envelope).await?;
            return Ok(CommandAck {
                accepted: true,
                duplicate: false,
            });
        }
        let _lifecycle_guard = self.start_lock.lock().await;
        let retry_stopped_publish = {
            let state = self.state.lock().await;
            if state.status == RuntimeStatus::Stopped {
                return Ok(CommandAck {
                    accepted: true,
                    duplicate: true,
                });
            }
            state.status == RuntimeStatus::Stopping && state.stop_driver_completed
        };
        if retry_stopped_publish {
            self.publish_stopped_and_commit().await?;
            return Ok(CommandAck {
                accepted: true,
                duplicate: false,
            });
        }

        let _permission_guard = self.permission_lock.lock().await;
        let publish_guard = self.publish_lock.lock().await;
        let (stopping_envelope, active_run_ids) = {
            let mut state = self.state.lock().await;
            state.status = RuntimeStatus::Stopping;
            state.reset_unpublished_runs_on_start = false;
            let message = format!("Stopping {}", runtime_name(&state.runtime_id));
            let envelope = build_runtime_envelope(
                &state,
                RuntimeEvent::RuntimeStatusChanged {
                    status: RuntimeStatus::Stopping,
                    message: Some(message),
                },
            );
            let active_run_ids = state
                .active_by_session
                .values()
                .cloned()
                .collect::<Vec<_>>();
            (envelope, active_run_ids)
        };
        let stopping_result = self.emit_runtime_envelope(&stopping_envelope).await;
        let mut sink_error = stopping_result.err();
        let mut pending_permissions = Vec::new();
        let mut event_pump_detaches = Vec::new();
        let mut unpublished_run_terminal = false;
        // 锁内只按当下序号构造信封并摘出要清理的东西；投递与提交都在锁外。
        // 一个被下游卡住的 emit 不应该让整机的读会话排队。
        let (cancel_candidates, unresolved_permissions) = {
            let mut state = self.state.lock().await;
            let mut candidates = Vec::new();
            for run_id in active_run_ids {
                if let RunEnvelopeBuild::Candidate { envelope, .. } = build_run_envelope(
                    &state,
                    &run_id,
                    RuntimeEvent::RunCancelled {
                        reason: Some("runtime_stopped".into()),
                    },
                ) {
                    candidates.push((run_id, envelope));
                }
            }
            let unresolved = state
                .permissions
                .iter()
                .filter(|(_, permission)| permission.resolved_decision.is_none())
                .map(|(request_id, _)| request_id.clone())
                .collect::<Vec<_>>();
            event_pump_detaches.extend(state.runs.values_mut().filter_map(|run| run.detach.take()));
            state.permissions.clear();
            (candidates, unresolved)
        };
        pending_permissions.extend(unresolved_permissions);
        let mut committed_cancels = Vec::new();
        for (run_id, envelope) in cancel_candidates {
            match self.sink.emit(&envelope) {
                Ok(()) => committed_cancels.push((run_id, envelope)),
                Err(error) => {
                    if sink_error.is_none() {
                        sink_error = Some(error.clone());
                    }
                    if self.sink.emit(&envelope).is_ok() {
                        committed_cancels.push((run_id, envelope));
                    } else {
                        unpublished_run_terminal = true;
                    }
                }
            }
        }
        if !committed_cancels.is_empty() {
            let mut state = self.state.lock().await;
            for (run_id, envelope) in &committed_cancels {
                let (_, permissions) = commit_run_envelope(&mut state, run_id, envelope);
                pending_permissions.extend(permissions);
            }
        }
        drop(publish_guard);
        for detach in event_pump_detaches {
            let _ = detach.send(());
        }
        for request_id in pending_permissions {
            let _ = self.driver.cancel_permission(&request_id).await;
        }

        if let Err(error) = self.driver.stop().await {
            {
                let mut state = self.state.lock().await;
                state.cleanup_pending = true;
                state.stop_driver_completed = false;
            }
            self.fail_runtime(error.clone()).await;
            return Err(error);
        }
        self.state.lock().await.stop_driver_completed = true;

        if unpublished_run_terminal {
            let error = sink_error.clone().unwrap_or_else(|| {
                RuntimeError::new(
                    RuntimeErrorCode::InternalError,
                    "Run terminal event could not be published",
                )
            });
            let _publish_guard = self.publish_lock.lock().await;
            let envelope = {
                let mut state = self.state.lock().await;
                state.status = RuntimeStatus::Failed;
                state.last_error = Some(error.clone());
                state.cleanup_pending = false;
                state.stop_driver_completed = false;
                state.sessions.clear();
                build_runtime_envelope(
                    &state,
                    RuntimeEvent::RuntimeStatusChanged {
                        status: RuntimeStatus::Failed,
                        message: Some(error.message.clone()),
                    },
                )
            };
            let _ = self.emit_runtime_envelope(&envelope).await;
            return Err(error);
        }

        let stopped_result = self.publish_stopped_and_commit().await;
        if let Err(error) = stopped_result {
            if sink_error.is_none() {
                sink_error = Some(error);
            }
        }
        if let Some(error) = sink_error {
            return Err(error);
        }
        Ok(CommandAck {
            accepted: true,
            duplicate: false,
        })
    }

    async fn publish_stopped_and_commit(&self) -> Result<(), RuntimeError> {
        let _publish_guard = self.publish_lock.lock().await;
        let envelope = {
            let state = self.state.lock().await;
            if state.status != RuntimeStatus::Stopping || !state.stop_driver_completed {
                return Err(RuntimeError::new(
                    RuntimeErrorCode::InternalError,
                    "Runtime stop transaction is not ready to finish",
                ));
            }
            build_runtime_envelope(
                &state,
                RuntimeEvent::RuntimeStatusChanged {
                    status: RuntimeStatus::Stopped,
                    message: Some("Hermes stopped".into()),
                },
            )
        };
        self.emit_runtime_envelope(&envelope).await?;
        let mut state = self.state.lock().await;
        state.status = RuntimeStatus::Stopped;
        state.last_error = None;
        state.cleanup_pending = false;
        state.stop_driver_completed = false;
        state.sessions.clear();
        state.runs.clear();
        state.active_by_session.clear();
        state.permissions.clear();
        Ok(())
    }

    pub async fn start_run(
        self: &Arc<Self>,
        request: RunStartRequest,
    ) -> Result<RunStartResult, RuntimeError> {
        request.validate()?;
        let run_id = uuid::Uuid::new_v4().to_string();
        let publish_guard = self.publish_lock.lock().await;
        let (driver_session_id, started, synthesized_terminal) = {
            let mut state = self.state.lock().await;
            if state.status != RuntimeStatus::Ready {
                return Err(RuntimeError::new(
                    RuntimeErrorCode::RunFailed,
                    "Hermes runtime is not ready",
                ));
            }
            if state.active_by_session.contains_key(&request.session_id) {
                return Err(RuntimeError::new(
                    RuntimeErrorCode::RunConflict,
                    "Session already has an active run",
                ));
            }
            let driver_session_id = state
                .sessions
                .get(&request.session_id)
                .cloned()
                .ok_or_else(|| {
                    RuntimeError::new(
                        RuntimeErrorCode::SessionCreateFailed,
                        "Runtime session does not exist",
                    )
                })?;
            state
                .active_by_session
                .insert(request.session_id.clone(), run_id.clone());
            state.runs.insert(
                run_id.clone(),
                RunRecord {
                    session_id: request.session_id.clone(),
                    driver_session_id: driver_session_id.clone(),
                    next_sequence: 0,
                    terminal: false,
                    awaiting_driver_terminal: false,
                    cancel_sent: false,
                    detach: None,
                },
            );
            let (started, synthesized_terminal) = match build_run_envelope(
                &state,
                &run_id,
                RuntimeEvent::RunStarted {
                    user_message_id: request.user_message_id.clone(),
                },
            ) {
                RunEnvelopeBuild::Candidate {
                    envelope,
                    synthesized_terminal,
                } => (envelope, synthesized_terminal),
                RunEnvelopeBuild::Missing | RunEnvelopeBuild::Terminal => {
                    unreachable!("new run must accept run_started")
                }
            };
            (driver_session_id, started, synthesized_terminal)
        };
        // 投递与失败回滚都在锁外。`publish_lock` 仍由本函数持有，序号不会被插队。
        if let Err(error) = self.sink.emit(&started) {
            let mut state = self.state.lock().await;
            state.runs.remove(&run_id);
            state.active_by_session.remove(&request.session_id);
            drop(state);
            return Err(error);
        }
        {
            let mut state = self.state.lock().await;
            commit_run_envelope(&mut state, &run_id, &started);
        }
        drop(publish_guard);
        if synthesized_terminal {
            let RuntimeEvent::RunFailed { error } = &started.event else {
                unreachable!("oversized run_started must synthesize run_failed")
            };
            return Err(error.clone());
        }

        let prompt = DriverPromptRequest {
            run_id: run_id.clone(),
            session_id: driver_session_id,
            prompt: request.prompt,
        };
        let events = match self.driver.prompt(prompt).await {
            Ok(events) => events,
            Err(error) => {
                if let Err(publish_error) = self
                    .publish_run_event(
                        &run_id,
                        RuntimeEvent::RunFailed {
                            error: error.clone(),
                        },
                    )
                    .await
                {
                    self.fail_runtime_and_stop(publish_error).await;
                }
                return Err(error);
            }
        };

        let (detach, detached) = oneshot::channel();
        if let Some(record) = self.state.lock().await.runs.get_mut(&run_id) {
            record.detach = Some(detach);
        }
        self.spawn_event_pump(run_id.clone(), events, detached);

        Ok(RunStartResult { run_id })
    }

    pub async fn attach_session(
        self: &Arc<Self>,
        session_id: &str,
    ) -> Result<RuntimeSession, RuntimeError> {
        if !self.driver.capabilities().detached_runs {
            return Err(RuntimeError::new(
                RuntimeErrorCode::AcpCapabilityMissing,
                "This Runtime cannot attach detached Runs",
            ));
        }
        let session = self.restore_session(session_id).await?;
        let Some(run) = session.latest_run.as_ref().filter(|run| !run.is_terminal()) else {
            return Ok(session);
        };
        {
            let mut state = self.state.lock().await;
            if let Some(active) = state.active_by_session.get(session_id) {
                if active == &run.id {
                    return Ok(session);
                }
                return Err(RuntimeError::new(
                    RuntimeErrorCode::RunConflict,
                    "Session already has a different active Run",
                ));
            }
            state
                .active_by_session
                .insert(session_id.to_owned(), run.id.clone());
            state.runs.insert(
                run.id.clone(),
                RunRecord {
                    session_id: session_id.to_owned(),
                    driver_session_id: session_id.to_owned(),
                    next_sequence: 0,
                    terminal: false,
                    awaiting_driver_terminal: false,
                    cancel_sent: false,
                    detach: None,
                },
            );
        }
        // The snapshot carries answer text and pending approvals, but not the
        // full reasoning/tool projection. Active history omits its Assistant
        // row, so replaying from zero reconstructs one complete live turn.
        let events = match self.driver.attach_run(&run.id, 0).await {
            Ok(events) => events,
            Err(error) => {
                let mut state = self.state.lock().await;
                state.active_by_session.remove(session_id);
                state.runs.remove(&run.id);
                return Err(error);
            }
        };
        let (detach, detached) = oneshot::channel();
        if let Some(record) = self.state.lock().await.runs.get_mut(&run.id) {
            record.detach = Some(detach);
        }
        self.spawn_event_pump(run.id.clone(), events, detached);
        Ok(session)
    }

    pub async fn detach_session(&self, session_id: &str) -> Result<CommandAck, RuntimeError> {
        if !self.driver.capabilities().detached_runs {
            return Err(RuntimeError::new(
                RuntimeErrorCode::AcpCapabilityMissing,
                "This Runtime cannot detach active Runs",
            ));
        }
        let detach = {
            let mut state = self.state.lock().await;
            let run_id = state.active_by_session.remove(session_id);
            state.sessions.remove(session_id);
            let detach = run_id
                .as_ref()
                .and_then(|run_id| state.runs.remove(run_id))
                .and_then(|mut run| run.detach.take());
            if let Some(run_id) = run_id {
                state
                    .permissions
                    .retain(|_, permission| permission.run_id != run_id);
            }
            detach
        };
        let changed = detach.is_some();
        if let Some(detach) = detach {
            let _ = detach.send(());
        }
        Ok(CommandAck {
            accepted: true,
            duplicate: !changed,
        })
    }

    pub async fn detach_all_sessions(&self) -> Result<CommandAck, RuntimeError> {
        if !self.driver.capabilities().detached_runs {
            return Err(RuntimeError::new(
                RuntimeErrorCode::AcpCapabilityMissing,
                "This Runtime cannot detach active Runs",
            ));
        }
        let (changed, detaches) = {
            let mut state = self.state.lock().await;
            let changed = !state.sessions.is_empty()
                || !state.runs.is_empty()
                || !state.permissions.is_empty();
            let detaches = state
                .runs
                .values_mut()
                .filter_map(|run| run.detach.take())
                .collect::<Vec<_>>();
            state.active_by_session.clear();
            state.sessions.clear();
            state.runs.clear();
            state.permissions.clear();
            (changed, detaches)
        };
        for detach in detaches {
            let _ = detach.send(());
        }
        Ok(CommandAck {
            accepted: true,
            duplicate: !changed,
        })
    }

    fn spawn_event_pump(
        self: &Arc<Self>,
        run_id: String,
        mut events: tokio::sync::mpsc::UnboundedReceiver<DriverEvent>,
        mut detached: oneshot::Receiver<()>,
    ) {
        let gateway = self.clone();
        tokio::spawn(async move {
            let mut run_terminal = false;
            let mut detach_open = true;
            loop {
                let event = if detach_open {
                    tokio::select! {
                        result = &mut detached => {
                            if result.is_ok() {
                                return;
                            }
                            detach_open = false;
                            continue;
                        },
                        event = events.recv() => event,
                    }
                } else {
                    events.recv().await
                };
                let Some(event) = event else { break };
                let event = match event {
                    DriverEvent::PermissionExpired { request_id, .. } => {
                        if let Err(error) = gateway
                            .handle_permission_expired(&run_id, &request_id)
                            .await
                        {
                            gateway.fail_runtime_and_stop(error).await;
                            return;
                        }
                        continue;
                    }
                    event => event,
                };
                let terminal = matches!(
                    event,
                    DriverEvent::Completed { .. }
                        | DriverEvent::Cancelled { .. }
                        | DriverEvent::Failed { .. }
                );
                if terminal && gateway.confirm_synthesized_terminal(&run_id).await {
                    run_terminal = true;
                    continue;
                }
                let published = gateway
                    .publish_run_event(
                        &run_id,
                        bound_runtime_event(map_driver_event(
                            event,
                            gateway.driver.capabilities().runtime_owned_approvals,
                        )),
                    )
                    .await;
                match published {
                    Err(error) => {
                        gateway.fail_runtime_and_stop(error).await;
                        return;
                    }
                    Ok(RunPublishResult {
                        outcome:
                            RunPublishOutcome::Published {
                                terminal: true,
                                synthesized_terminal: true,
                                driver_session_id,
                            },
                    }) => {
                        if gateway
                            .driver
                            .cancel(&driver_session_id, &run_id)
                            .await
                            .is_err()
                        {
                            gateway
                                .fail_runtime_and_stop(RuntimeError::new(
                                    RuntimeErrorCode::RunFailed,
                                    "Runtime could not cancel an oversized run event",
                                ))
                                .await;
                            return;
                        }
                        gateway.spawn_synthesized_cancel_timeout(run_id.clone());
                        run_terminal = true;
                    }
                    Ok(RunPublishResult {
                        outcome: RunPublishOutcome::Published { terminal: true, .. },
                    }) => run_terminal = true,
                    Ok(_) => {}
                }
                if terminal {
                    run_terminal = true;
                }
            }
            if !run_terminal {
                if let Err(error) = gateway
                    .publish_run_event(
                        &run_id,
                        RuntimeEvent::RunFailed {
                            error: RuntimeError::new(
                                RuntimeErrorCode::RunFailed,
                                "Runtime event stream ended unexpectedly",
                            ),
                        },
                    )
                    .await
                {
                    gateway.fail_runtime_and_stop(error).await;
                }
            }
        });
    }

    pub async fn cancel_run(
        self: &Arc<Self>,
        request: RunCancelRequest,
    ) -> Result<CommandAck, RuntimeError> {
        request.validate()?;
        let _cancel_guard = self.cancel_lock.lock().await;
        self.cancel_run_under_lock(request).await
    }

    pub async fn cancel_session_run(
        self: &Arc<Self>,
        session_id: &str,
    ) -> Result<CommandAck, RuntimeError> {
        SessionCreateRequest {
            agent_id: None,
            session_id: session_id.to_owned(),
            title: None,
        }
        .validate()?;
        let _cancel_guard = self.cancel_lock.lock().await;
        let run_id = self
            .state
            .lock()
            .await
            .active_by_session
            .get(session_id)
            .cloned();
        let Some(run_id) = run_id else {
            return Ok(CommandAck {
                accepted: true,
                duplicate: true,
            });
        };
        self.cancel_run_under_lock(RunCancelRequest {
            session_id: session_id.to_owned(),
            run_id,
        })
        .await
    }

    async fn cancel_run_under_lock(
        self: &Arc<Self>,
        request: RunCancelRequest,
    ) -> Result<CommandAck, RuntimeError> {
        let driver_session_id = {
            let mut state = self.state.lock().await;
            let run = state.runs.get_mut(&request.run_id).ok_or_else(|| {
                RuntimeError::new(RuntimeErrorCode::RunConflict, "Run does not exist")
            })?;
            if run.session_id != request.session_id {
                return Err(RuntimeError::new(
                    RuntimeErrorCode::RunConflict,
                    "Run does not belong to the session",
                ));
            }
            if run.terminal || run.cancel_sent {
                return Ok(CommandAck {
                    accepted: true,
                    duplicate: true,
                });
            }
            let driver_session_id = {
                run.cancel_sent = true;
                run.driver_session_id.clone()
            };
            driver_session_id
        };

        if let Err(error) = self
            .driver
            .cancel(&driver_session_id, &request.run_id)
            .await
        {
            if let Some(run) = self.state.lock().await.runs.get_mut(&request.run_id) {
                run.cancel_sent = false;
            }
            return Err(error);
        }

        let gateway = self.clone();
        let run_id = request.run_id;
        tokio::spawn(async move {
            sleep(CANCEL_TIMEOUT).await;
            let _lifecycle_guard = gateway.start_lock.lock().await;
            let timeout_error = RuntimeError::new(
                RuntimeErrorCode::CancelTimeout,
                "Hermes did not cancel the run in time",
            );
            if gateway
                .transition_runtime_failed(
                    None,
                    Some((&run_id, timeout_error.clone())),
                    RuntimeError::new(
                        RuntimeErrorCode::ProcessExited,
                        "Hermes stopped after another run failed to cancel",
                    ),
                    timeout_error,
                )
                .await
            {
                gateway.stop_driver_for_cleanup().await;
            }
        });

        Ok(CommandAck {
            accepted: true,
            duplicate: false,
        })
    }

    pub async fn resolve_permission(
        &self,
        request: PermissionResolveRequest,
    ) -> Result<PermissionDecisionReceipt, RuntimeError> {
        request.validate()?;
        let permission_guard = self.permission_lock.lock().await;
        let (preflight, audit_run_id) = {
            let state = self.state.lock().await;
            let audit_run_id = state
                .permissions
                .get(&request.request_id)
                .map(|permission| permission.run_id.clone());
            let preflight = match state.permissions.get(&request.request_id) {
                None => Err(PermissionResolveStatus::Expired),
                Some(permission) => {
                    let identity_matches = permission.runtime_instance_id
                        == request.runtime_instance_id
                        && permission.runtime_id == request.runtime_id
                        && permission.runtime_epoch == request.runtime_epoch
                        && permission.session_id == request.session_id
                        && permission.thread_id == request.thread_id
                        && permission.run_id == request.run_id
                        && permission.tool_call_id == request.tool_call_id;
                    if !identity_matches {
                        Err(PermissionResolveStatus::Stale)
                    } else {
                        let not_expired =
                            chrono::DateTime::parse_from_rfc3339(&permission.expires_at)
                                .is_ok_and(|expires_at| expires_at > chrono::Utc::now());
                        if !not_expired {
                            Err(PermissionResolveStatus::Expired)
                        } else if let Some(resolved_decision) = permission.resolved_decision {
                            Err(if resolved_decision == request.decision {
                                PermissionResolveStatus::Duplicate
                            } else {
                                PermissionResolveStatus::Rejected
                            })
                        } else if request.decision == PermissionDecision::AllowOnce
                            && !permission.can_allow_once
                        {
                            Err(PermissionResolveStatus::Rejected)
                        } else if !state
                            .runs
                            .get(&permission.run_id)
                            .is_some_and(|run| !run.terminal)
                        {
                            Err(PermissionResolveStatus::Stale)
                        } else if permission.action_set_digest != request.action_set_digest {
                            Err(PermissionResolveStatus::Stale)
                        } else {
                            Ok(permission.run_id.clone())
                        }
                    }
                }
            };
            (preflight, audit_run_id)
        };
        let run_id = match preflight {
            Ok(run_id) => run_id,
            Err(status) => {
                if let Some(run_id) = audit_run_id {
                    let _ = self
                        .publish_run_event_under_permission_lock(
                            &run_id,
                            RuntimeEvent::PermissionAudit {
                                request_id: request.request_id.clone(),
                                decision: request.decision,
                                status,
                                reason: request.reason,
                                action_set_digest: request.action_set_digest.clone(),
                            },
                        )
                        .await;
                }
                return Ok(self.persist_receipt(request.receipt(status)).await);
            }
        };
        if let Err(error) = self
            .driver
            .resolve_permission(&request.request_id, request.decision)
            .await
        {
            if error.code == RuntimeErrorCode::PermissionExpired {
                if let Err(publish_error) = self
                    .publish_run_event_under_permission_lock(
                        &run_id,
                        RuntimeEvent::PermissionResolved {
                            request_id: request.request_id.clone(),
                            decision: PermissionDecision::Deny,
                        },
                    )
                    .await
                    .and_then(|result| {
                        require_non_terminal_publish(
                            result,
                            "Permission resolution was not published",
                        )
                    })
                {
                    drop(permission_guard);
                    self.fail_runtime_and_stop(publish_error.clone()).await;
                    return Err(publish_error);
                }
                self.state
                    .lock()
                    .await
                    .permissions
                    .remove(&request.request_id);
                let _ = self
                    .publish_run_event_under_permission_lock(
                        &run_id,
                        RuntimeEvent::PermissionAudit {
                            request_id: request.request_id.clone(),
                            decision: PermissionDecision::Deny,
                            status: PermissionResolveStatus::Expired,
                            reason: Some(PermissionDenyReason::TimedOut),
                            action_set_digest: request.action_set_digest.clone(),
                        },
                    )
                    .await;
                if let Err(publish_error) = self
                    .publish_run_event_under_permission_lock(
                        &run_id,
                        RuntimeEvent::DiagnosticNotice {
                            level: super::DiagnosticLevel::Warning,
                            message: "Hermes permission request expired".into(),
                        },
                    )
                    .await
                    .and_then(|result| {
                        require_non_terminal_publish(
                            result,
                            "Permission expiration diagnostic was not published",
                        )
                    })
                {
                    drop(permission_guard);
                    self.fail_runtime_and_stop(publish_error.clone()).await;
                    return Err(publish_error);
                }
            }
            if error.code == RuntimeErrorCode::PermissionExpired {
                return Ok(self
                    .persist_receipt(request.receipt(PermissionResolveStatus::Expired))
                    .await);
            }
            return Err(error);
        }
        if let Err(error) = self
            .publish_run_event_under_permission_lock(
                &run_id,
                RuntimeEvent::PermissionResolved {
                    request_id: request.request_id.clone(),
                    decision: request.decision,
                },
            )
            .await
            .and_then(|result| {
                require_non_terminal_publish(result, "Permission resolution was not published")
            })
        {
            drop(permission_guard);
            self.fail_runtime_and_stop(error.clone()).await;
            return Err(error);
        }
        if let Err(error) = self
            .publish_run_event_under_permission_lock(
                &run_id,
                RuntimeEvent::PermissionAudit {
                    request_id: request.request_id.clone(),
                    decision: request.decision,
                    status: PermissionResolveStatus::Accepted,
                    reason: request.reason,
                    action_set_digest: request.action_set_digest.clone(),
                },
            )
            .await
            .and_then(|result| {
                require_non_terminal_publish(result, "Permission audit was not published")
            })
        {
            drop(permission_guard);
            self.fail_runtime_and_stop(error.clone()).await;
            return Err(error);
        }
        Ok(self
            .persist_receipt(request.receipt(PermissionResolveStatus::Accepted))
            .await)
    }

    async fn publish_run_event(
        &self,
        run_id: &str,
        event: RuntimeEvent,
    ) -> Result<RunPublishResult, RuntimeError> {
        let _permission_guard = self.permission_lock.lock().await;
        self.publish_run_event_under_permission_lock(run_id, event)
            .await
    }

    async fn publish_run_event_under_permission_lock(
        &self,
        run_id: &str,
        event: RuntimeEvent,
    ) -> Result<RunPublishResult, RuntimeError> {
        let publish_guard = self.publish_lock.lock().await;
        let duplicate = {
            let state = self.state.lock().await;
            if let RuntimeEvent::PermissionResolved {
                request_id,
                decision,
            } = &event
            {
                state.permissions.get(request_id).is_some_and(|permission| {
                    permission.run_id == run_id && permission.resolved_decision == Some(*decision)
                })
            } else {
                false
            }
        };
        if duplicate {
            return Ok(RunPublishResult {
                outcome: RunPublishOutcome::Duplicate,
            });
        }
        let late_non_terminal = !event.is_terminal();
        // 锁内只构造信封；诊断投递、正式投递与提交都在锁外。
        let (envelope, synthesized_terminal, diagnostic, skipped) = {
            let state = self.state.lock().await;
            match build_run_envelope(&state, run_id, event) {
                RunEnvelopeBuild::Candidate {
                    envelope,
                    synthesized_terminal,
                } => (Some(envelope), synthesized_terminal, None, None),
                RunEnvelopeBuild::Missing => (
                    None,
                    false,
                    late_non_terminal.then(|| {
                        build_runtime_envelope(
                            &state,
                            RuntimeEvent::DiagnosticNotice {
                                level: super::DiagnosticLevel::Warning,
                                message: "Ignored a late Hermes event for an unavailable run"
                                    .into(),
                            },
                        )
                    }),
                    Some(RunPublishOutcome::Missing),
                ),
                RunEnvelopeBuild::Terminal => (
                    None,
                    false,
                    late_non_terminal.then(|| {
                        build_runtime_envelope(
                            &state,
                            RuntimeEvent::DiagnosticNotice {
                                level: super::DiagnosticLevel::Warning,
                                message: "Ignored a late Hermes event after run termination".into(),
                            },
                        )
                    }),
                    Some(RunPublishOutcome::IgnoredAfterTerminal),
                ),
            }
        };
        if let Some(diagnostic) = diagnostic {
            self.emit_runtime_envelope(&diagnostic).await?;
        }
        let Some(envelope) = envelope else {
            return Ok(RunPublishResult {
                outcome: skipped.expect("skipped publish always carries an outcome"),
            });
        };
        self.sink.emit(&envelope)?;
        let terminal = envelope.event.is_terminal();
        let (driver_session_id, pending_permissions) = {
            let mut state = self.state.lock().await;
            let (driver_session_id, pending_permissions) =
                commit_run_envelope(&mut state, run_id, &envelope);
            if synthesized_terminal {
                let session_id = {
                    let run = state
                        .runs
                        .get_mut(run_id)
                        .expect("published run must still exist");
                    run.awaiting_driver_terminal = true;
                    run.cancel_sent = true;
                    run.session_id.clone()
                };
                state
                    .active_by_session
                    .insert(session_id, run_id.to_owned());
            }
            (driver_session_id, pending_permissions)
        };
        drop(publish_guard);
        for request_id in &pending_permissions {
            let _ = self
                .driver
                .resolve_permission(request_id, PermissionDecision::Deny)
                .await;
        }
        Ok(RunPublishResult {
            outcome: RunPublishOutcome::Published {
                terminal,
                synthesized_terminal,
                driver_session_id,
            },
        })
    }

    async fn confirm_synthesized_terminal(&self, run_id: &str) -> bool {
        let mut state = self.state.lock().await;
        let Some(run) = state.runs.get_mut(run_id) else {
            return false;
        };
        if !run.awaiting_driver_terminal {
            return false;
        }
        run.awaiting_driver_terminal = false;
        let session_id = run.session_id.clone();
        if state.active_by_session.get(&session_id).map(String::as_str) == Some(run_id) {
            state.active_by_session.remove(&session_id);
        }
        true
    }

    fn spawn_synthesized_cancel_timeout(self: &Arc<Self>, run_id: String) {
        let gateway = self.clone();
        tokio::spawn(async move {
            sleep(CANCEL_TIMEOUT).await;
            let _lifecycle_guard = gateway.start_lock.lock().await;
            let timeout_error = RuntimeError::new(
                RuntimeErrorCode::CancelTimeout,
                "Hermes did not end the oversized run in time",
            );
            if gateway
                .transition_runtime_failed(
                    None,
                    Some((&run_id, timeout_error.clone())),
                    RuntimeError::new(
                        RuntimeErrorCode::ProcessExited,
                        "Hermes stopped after an oversized run failed to end",
                    ),
                    timeout_error,
                )
                .await
            {
                gateway.stop_driver_for_cleanup().await;
            }
        });
    }

    async fn handle_permission_expired(
        &self,
        run_id: &str,
        request_id: &str,
    ) -> Result<(), RuntimeError> {
        let _permission_guard = self.permission_lock.lock().await;
        let pending = {
            let state = self.state.lock().await;
            state.permissions.get(request_id).is_some_and(|permission| {
                permission.run_id == run_id
                    && permission.resolved_decision.is_none()
                    && state.runs.get(run_id).is_some_and(|run| !run.terminal)
            })
        };
        if !pending {
            return Ok(());
        }
        require_non_terminal_publish(
            self.publish_run_event_under_permission_lock(
                run_id,
                RuntimeEvent::PermissionResolved {
                    request_id: request_id.to_owned(),
                    decision: PermissionDecision::Deny,
                },
            )
            .await?,
            "Expired permission resolution was not published",
        )?;
        self.state.lock().await.permissions.remove(request_id);
        require_non_terminal_publish(
            self.publish_run_event_under_permission_lock(
                run_id,
                RuntimeEvent::DiagnosticNotice {
                    level: super::DiagnosticLevel::Warning,
                    message: "Hermes permission request expired and was denied".into(),
                },
            )
            .await?,
            "Permission expiration diagnostic was not published",
        )?;
        Ok(())
    }

    async fn fail_runtime_and_stop(&self, error: RuntimeError) {
        let _lifecycle_guard = self.start_lock.lock().await;
        if self
            .transition_runtime_failed(None, None, error.clone(), error)
            .await
        {
            self.stop_driver_for_cleanup().await;
        }
    }

    async fn stop_driver_for_cleanup(&self) {
        let cleanup_failed = self.driver.stop().await.is_err();
        self.state.lock().await.cleanup_pending = cleanup_failed;
    }

    async fn transition_runtime_failed(
        &self,
        expected_epoch: Option<&str>,
        primary_run: Option<(&str, RuntimeError)>,
        other_run_error: RuntimeError,
        runtime_error: RuntimeError,
    ) -> bool {
        let _permission_guard = self.permission_lock.lock().await;
        let publish_guard = self.publish_lock.lock().await;
        let (candidates, runtime_event) = {
            let mut state = self.state.lock().await;
            if expected_epoch.is_some_and(|epoch| state.runtime_epoch.as_deref() != Some(epoch))
                || matches!(
                    state.status,
                    RuntimeStatus::Stopped | RuntimeStatus::Stopping | RuntimeStatus::Failed
                )
                || primary_run.as_ref().is_some_and(|(run_id, _)| {
                    !state
                        .runs
                        .get(*run_id)
                        .is_some_and(|run| !run.terminal || run.awaiting_driver_terminal)
                })
            {
                return false;
            }
            let mut run_ids = state
                .active_by_session
                .values()
                .cloned()
                .collect::<Vec<_>>();
            run_ids.sort();
            let mut candidates = Vec::new();
            for run_id in &run_ids {
                let run_error = primary_run
                    .as_ref()
                    .filter(|(primary_run_id, _)| *primary_run_id == run_id)
                    .map(|(_, error)| error.clone())
                    .unwrap_or_else(|| other_run_error.clone());
                match build_run_envelope(
                    &state,
                    run_id,
                    RuntimeEvent::RunFailed { error: run_error },
                ) {
                    RunEnvelopeBuild::Candidate { envelope, .. } => {
                        candidates.push((run_id.clone(), envelope))
                    }
                    RunEnvelopeBuild::Terminal => {
                        let session_id = state.runs.get(run_id).map(|run| run.session_id.clone());
                        if let Some(run) = state.runs.get_mut(run_id) {
                            run.awaiting_driver_terminal = false;
                        }
                        if let Some(session_id) = session_id {
                            if state
                                .active_by_session
                                .get(&session_id)
                                .is_some_and(|active_run_id| active_run_id == run_id)
                            {
                                state.active_by_session.remove(&session_id);
                            }
                        }
                        continue;
                    }
                    RunEnvelopeBuild::Missing => continue,
                };
            }
            state.status = RuntimeStatus::Failed;
            state.last_error = Some(runtime_error.clone());
            state.cleanup_pending = true;
            state.reset_unpublished_runs_on_start = false;
            state.sessions.clear();
            let runtime_event = build_runtime_envelope(
                &state,
                RuntimeEvent::RuntimeStatusChanged {
                    status: RuntimeStatus::Failed,
                    message: Some(runtime_error.message),
                },
            );
            (candidates, runtime_event)
        };
        // 投递在锁外：只有投递成功的信封才回锁里提交，被下游卡住的 emit 不再占着状态锁。
        let mut committed = Vec::new();
        for (run_id, envelope) in candidates {
            if self.sink.emit(&envelope).is_ok() || self.sink.emit(&envelope).is_ok() {
                committed.push((run_id, envelope));
            }
        }
        let pending_permissions = {
            let mut state = self.state.lock().await;
            let mut emitted_permissions = Vec::new();
            for (run_id, envelope) in &committed {
                let (_, pending_permissions) = commit_run_envelope(&mut state, run_id, envelope);
                emitted_permissions.extend(pending_permissions);
            }
            state
                .permissions
                .iter()
                .filter(|(_, permission)| permission.resolved_decision.is_none())
                .map(|(request_id, _)| request_id.clone())
                .chain(emitted_permissions)
                .collect::<Vec<_>>()
        };
        let _ = self.emit_runtime_envelope(&runtime_event).await;
        drop(publish_guard);
        for request_id in pending_permissions {
            let _ = self
                .driver
                .resolve_permission(&request_id, PermissionDecision::Deny)
                .await;
        }
        true
    }

    async fn fail_runtime(&self, error: RuntimeError) {
        let _publish_guard = self.publish_lock.lock().await;
        let envelope = {
            let mut state = self.state.lock().await;
            state.status = RuntimeStatus::Failed;
            state.last_error = Some(error.clone());
            state.reset_unpublished_runs_on_start = false;
            build_runtime_envelope(
                &state,
                RuntimeEvent::RuntimeStatusChanged {
                    status: RuntimeStatus::Failed,
                    message: Some(error.message),
                },
            )
        };
        let _ = self.emit_runtime_envelope(&envelope).await;
    }

    async fn handle_process_exit(&self, expected_epoch: &str, error: RuntimeError) {
        if self
            .transition_runtime_failed(Some(expected_epoch), None, error.clone(), error)
            .await
        {
            let _lifecycle_guard = self.start_lock.lock().await;
            let should_stop = {
                let state = self.state.lock().await;
                state.runtime_epoch.as_deref() == Some(expected_epoch)
                    && state.status == RuntimeStatus::Failed
                    && state.cleanup_pending
            };
            if should_stop {
                let cleanup_failed = self.driver.stop().await.is_err();
                let mut state = self.state.lock().await;
                if state.runtime_epoch.as_deref() == Some(expected_epoch)
                    && state.status == RuntimeStatus::Failed
                {
                    state.cleanup_pending = cleanup_failed;
                    if state.active_by_session.is_empty() {
                        state.runs.clear();
                        state.permissions.clear();
                    } else {
                        state.reset_unpublished_runs_on_start = true;
                    }
                }
            }
        }
    }
}

fn require_non_terminal_publish(
    result: RunPublishResult,
    message: &'static str,
) -> Result<(), RuntimeError> {
    if matches!(
        result.outcome,
        RunPublishOutcome::Published {
            terminal: false,
            ..
        } | RunPublishOutcome::Duplicate
    ) {
        Ok(())
    } else {
        Err(RuntimeError::new(RuntimeErrorCode::InternalError, message))
    }
}

fn snapshot(state: &GatewayState) -> RuntimeSnapshot {
    RuntimeSnapshot {
        runtime_id: state.runtime_id.clone(),
        status: state.status,
        runtime_epoch: state.runtime_epoch.clone(),
        sequence: state.runtime_sequence.saturating_sub(1),
        message: None,
    }
}

fn build_runtime_envelope(state: &GatewayState, event: RuntimeEvent) -> RuntimeEventEnvelope {
    let candidate = RuntimeEventEnvelope::new_runtime_for(
        state.runtime_id.clone(),
        state.runtime_epoch.clone().unwrap_or_default(),
        state.runtime_sequence,
        event,
    );
    match serde_json::to_vec(&candidate) {
        Ok(serialized) if serialized.len() <= MAX_EVENT_BYTES => candidate,
        _ => RuntimeEventEnvelope::new_runtime_for(
            state.runtime_id.clone(),
            state.runtime_epoch.clone().unwrap_or_default(),
            state.runtime_sequence,
            RuntimeEvent::DiagnosticNotice {
                level: super::DiagnosticLevel::Warning,
                message: "Runtime event exceeded the size limit".into(),
            },
        ),
    }
}

fn build_run_envelope(state: &GatewayState, run_id: &str, event: RuntimeEvent) -> RunEnvelopeBuild {
    let Some(runtime_epoch) = state.runtime_epoch.clone() else {
        return RunEnvelopeBuild::Missing;
    };
    let Some(run) = state.runs.get(run_id) else {
        return RunEnvelopeBuild::Missing;
    };
    if run.terminal {
        return RunEnvelopeBuild::Terminal;
    }
    let duplicate_permission_id = matches!(
        &event,
        RuntimeEvent::PermissionRequested { request }
            if state.permissions.contains_key(&request.request_id)
    );
    let event = if duplicate_permission_id {
        RuntimeEvent::RunFailed {
            error: RuntimeError::new(
                RuntimeErrorCode::RunFailed,
                "Hermes reused an active permission request id",
            ),
        }
    } else {
        event
    };
    let session_id = run.session_id.clone();
    let sequence = run.next_sequence;
    let candidate = RuntimeEventEnvelope::new_run_for(
        state.runtime_id.clone(),
        runtime_epoch.clone(),
        session_id.clone(),
        run_id,
        sequence,
        event,
    );
    let (envelope, synthesized_terminal) = match serde_json::to_vec(&candidate) {
        Ok(serialized) if serialized.len() <= MAX_EVENT_BYTES => {
            (candidate, duplicate_permission_id)
        }
        _ => (
            RuntimeEventEnvelope::new_run_for(
                state.runtime_id.clone(),
                runtime_epoch,
                session_id,
                run_id,
                sequence,
                RuntimeEvent::RunFailed {
                    error: RuntimeError::new(
                        RuntimeErrorCode::InternalError,
                        "Runtime event exceeded the size limit",
                    ),
                },
            ),
            true,
        ),
    };
    RunEnvelopeBuild::Candidate {
        envelope,
        synthesized_terminal,
    }
}

fn commit_run_envelope(
    state: &mut GatewayState,
    run_id: &str,
    envelope: &RuntimeEventEnvelope,
) -> (String, Vec<String>) {
    let run = state
        .runs
        .get_mut(run_id)
        .expect("published run must still exist");
    assert_eq!(run.next_sequence, envelope.sequence);
    assert!(!run.terminal);
    let session_id = run.session_id.clone();
    let driver_session_id = run.driver_session_id.clone();
    run.next_sequence += 1;
    if let RuntimeEvent::PermissionRequested { request } = &envelope.event {
        state.permissions.insert(
            request.request_id.clone(),
            PermissionRecord {
                runtime_instance_id: format!("{}:{}", envelope.runtime_id, envelope.runtime_epoch),
                runtime_id: envelope.runtime_id.clone(),
                runtime_epoch: envelope.runtime_epoch.clone(),
                session_id: envelope.session_id.clone(),
                thread_id: envelope.session_id.clone(),
                run_id: run_id.to_owned(),
                tool_call_id: request.tool_call_id.clone(),
                expires_at: request.expires_at.clone(),
                resolved_decision: None,
                can_allow_once: request.can_allow_once,
                action_set_digest: match &envelope.event {
                    RuntimeEvent::PermissionRequested { request } => {
                        request.action_set_digest.clone()
                    }
                    _ => None,
                },
            },
        );
    }
    if let RuntimeEvent::PermissionResolved {
        request_id,
        decision,
    } = &envelope.event
    {
        if let Some(permission) = state.permissions.get_mut(request_id) {
            permission.resolved_decision = Some(*decision);
        }
    }
    let pending_permissions = if envelope.event.is_terminal() {
        let run = state
            .runs
            .get_mut(run_id)
            .expect("published run must still exist");
        run.terminal = true;
        state.active_by_session.remove(&session_id);
        let pending = state
            .permissions
            .iter()
            .filter(|(_, permission)| {
                permission.run_id == run_id && permission.resolved_decision.is_none()
            })
            .map(|(request_id, _)| request_id.clone())
            .collect::<Vec<_>>();
        state
            .permissions
            .retain(|_, permission| permission.run_id != run_id);
        pending
    } else {
        Vec::new()
    };
    (driver_session_id, pending_permissions)
}

fn map_driver_event(event: DriverEvent, runtime_owned_approvals: bool) -> RuntimeEvent {
    match event {
        DriverEvent::TextDelta {
            message_id, delta, ..
        } => RuntimeEvent::TextDelta { message_id, delta },
        DriverEvent::ReasoningDelta {
            message_id, delta, ..
        } => RuntimeEvent::ReasoningDelta { message_id, delta },
        DriverEvent::ToolStarted {
            tool_call_id,
            name,
            input,
            ..
        } => RuntimeEvent::ToolStarted {
            tool_call_id,
            name,
            input,
        },
        DriverEvent::ToolUpdated {
            tool_call_id,
            update,
            ..
        } => RuntimeEvent::ToolUpdated {
            tool_call_id,
            update,
        },
        DriverEvent::ToolCompleted {
            tool_call_id,
            result,
            error,
            ..
        } => RuntimeEvent::ToolCompleted {
            tool_call_id,
            result,
            error,
        },
        DriverEvent::PermissionRequested { request, .. } => {
            let actions = permission_actions_from_driver(&request);
            let action_set_digest = action_set_digest(&actions);
            let has_unsupported_decision = !request.unsupported_decisions.is_empty();
            RuntimeEvent::PermissionRequested {
                request: PermissionRequest {
                    request_id: request.request_id,
                    tool_call_id: request.tool_call_id,
                    title: request.title,
                    description: request.description,
                    tool_name: request.tool_name,
                    input_summary: request.input_summary,
                    can_allow_once: request.can_allow_once,
                    can_deny: request.can_deny,
                    actions: Some(actions),
                    action_set_digest: Some(action_set_digest),
                    has_unsupported_decision,
                    // ponytail: the public contract still requires a timestamp; this
                    // maximum value leaves Bianbu approval lifetime owned by Runtime.
                    expires_at: if runtime_owned_approvals {
                        "9999-12-31T23:59:59.999Z".into()
                    } else {
                        (chrono::Utc::now()
                            + chrono::Duration::seconds(PERMISSION_TIMEOUT_SECS as i64))
                        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
                    },
                },
            }
        }
        DriverEvent::PermissionExpired { .. } => {
            unreachable!("permission expiration is handled before event mapping")
        }
        DriverEvent::PermissionResolved {
            request_id,
            decision,
            ..
        } => RuntimeEvent::PermissionResolved {
            request_id,
            decision,
        },
        DriverEvent::ConnectionStatusChanged {
            status, message, ..
        } => RuntimeEvent::ConnectionStatusChanged { status, message },
        DriverEvent::DiagnosticNotice { level, message, .. } => {
            RuntimeEvent::DiagnosticNotice { level, message }
        }
        DriverEvent::Completed { stop_reason, .. } => RuntimeEvent::RunCompleted {
            stop_reason: Some(stop_reason),
        },
        DriverEvent::Cancelled { reason, .. } => RuntimeEvent::RunCancelled {
            reason: Some(reason),
        },
        DriverEvent::Failed { error, .. } => RuntimeEvent::RunFailed { error },
    }
}

fn action_set_digest(actions: &[super::PermissionAction]) -> String {
    let bytes = serde_json::to_vec(actions).unwrap_or_default();
    hex::encode(Sha256::digest(bytes))
}

fn receipt_key(receipt: &PermissionDecisionReceipt) -> String {
    format!(
        "{}\u{0}{}\u{0}{}",
        receipt.runtime_instance_id, receipt.run_id, receipt.request_id
    )
}

fn permission_actions_from_driver(
    request: &DriverPermissionRequest,
) -> Vec<super::PermissionAction> {
    if let Some(items) = request
        .input_summary
        .as_ref()
        .and_then(serde_json::Value::as_array)
    {
        let actions = items
            .iter()
            .filter_map(|item| {
                let name = item
                    .get("name")
                    .or_else(|| item.get("tool"))
                    .and_then(serde_json::Value::as_str)?;
                Some(super::PermissionAction {
                    kind: super::PermissionActionKind::Tool,
                    name: name.to_owned(),
                    summary: item
                        .get("summary")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or(&request.description)
                        .to_owned(),
                })
            })
            .collect::<Vec<_>>();
        if !actions.is_empty() {
            return actions;
        }
    }
    vec![super::PermissionAction {
        kind: super::PermissionActionKind::Tool,
        name: request.tool_name.clone(),
        summary: request.description.clone(),
    }]
}

fn bound_runtime_event(event: RuntimeEvent) -> RuntimeEvent {
    match event {
        RuntimeEvent::ToolStarted {
            tool_call_id,
            name,
            input,
        } => RuntimeEvent::ToolStarted {
            tool_call_id,
            name,
            input: input.map(bound_value),
        },
        RuntimeEvent::ToolUpdated {
            tool_call_id,
            update,
        } => RuntimeEvent::ToolUpdated {
            tool_call_id,
            update: bound_value(update),
        },
        RuntimeEvent::ToolCompleted {
            tool_call_id,
            result,
            error,
        } => RuntimeEvent::ToolCompleted {
            tool_call_id,
            result: result.map(bound_value),
            error: error.map(bound_text),
        },
        RuntimeEvent::PermissionRequested { mut request } => {
            request.input_summary = request.input_summary.map(bound_value);
            RuntimeEvent::PermissionRequested { request }
        }
        RuntimeEvent::DiagnosticNotice { level, message } => RuntimeEvent::DiagnosticNotice {
            level,
            message: bound_text(message),
        },
        event => event,
    }
}

fn bound_value(value: serde_json::Value) -> serde_json::Value {
    let Ok(serialized) = serde_json::to_vec(&value) else {
        return serde_json::json!({"truncated": true});
    };
    if serialized.len() <= MAX_TOOL_VALUE_BYTES {
        return value;
    }
    let text = String::from_utf8_lossy(&serialized);
    serde_json::json!({
        "truncated": true,
        "preview": utf8_prefix(&text, MAX_TOOL_VALUE_BYTES / 4),
    })
}

fn bound_text(text: String) -> String {
    if text.len() <= MAX_TOOL_VALUE_BYTES {
        text
    } else {
        utf8_prefix(&text, MAX_TOOL_VALUE_BYTES).to_owned()
    }
}

fn utf8_prefix(text: &str, max_bytes: usize) -> &str {
    let mut end = text.len().min(max_bytes);
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn session_batches_preserve_control_identity_order_and_bounds() {
        let frame = |session: &str, kind: &str, seq: u64| super::super::SessionFeedEvent {
            target_id: "target".into(),
            runtime_epoch: "epoch".into(),
            session_id: session.into(),
            kind: kind.into(),
            events: vec![serde_json::json!({"seq": seq})],
            hidden_run_ids: vec![format!("hidden-{seq}")],
            summary: None,
            connection_status: "connected".into(),
            message: None,
        };
        let (tx, mut rx) = tokio::sync::mpsc::channel(32);
        for seq in 0..18 {
            tx.send(frame("a", "events", seq)).await.unwrap();
        }
        tx.send(frame("a", "connection", 18)).await.unwrap();
        tx.send(frame("b", "events", 19)).await.unwrap();
        tx.send(frame("a", "events", 20)).await.unwrap();
        let mut other_target = frame("a", "events", 21);
        other_target.target_id = "other".into();
        tx.send(other_target).await.unwrap();
        drop(tx);
        let mut pending = None;
        let mut batches = Vec::new();
        while let Some(batch) = super::next_session_batch(&mut rx, &mut pending).await {
            batches.push(batch);
        }
        assert_eq!(
            batches.iter().map(|b| b.events.len()).collect::<Vec<_>>(),
            vec![16, 2, 1, 1, 1, 1]
        );
        assert_eq!(batches[0].hidden_run_ids.len(), 16);
        assert_eq!(batches[2].kind, "connection");
        assert_eq!(batches[3].session_id, "b");
        assert_eq!(batches[5].target_id, "other");
        assert_eq!(
            batches
                .iter()
                .flat_map(|b| &b.events)
                .map(|e| e["seq"].as_u64().unwrap())
                .collect::<Vec<_>>(),
            (0..22).collect::<Vec<_>>()
        );
    }

    use super::*;
    use crate::runtime::driver::{DriverLifecycleEvent, DriverPermissionRequest, DriverStart};
    use crate::runtime::{
        CommandAck, PermissionDecision, PermissionResolveRequest, RunCancelRequest,
    };
    use async_trait::async_trait;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Mutex as StdMutex;
    use tempfile::TempDir;
    use tokio::sync::{mpsc, Notify};

    #[derive(Default)]
    struct FakeDriver {
        prompt_senders: Mutex<HashMap<String, mpsc::UnboundedSender<DriverEvent>>>,
        check_calls: AtomicUsize,
        start_calls: AtomicUsize,
        control_present: AtomicBool,
        exit_during_start: AtomicBool,
        stop_calls: AtomicUsize,
        stop_error: Mutex<Option<RuntimeError>>,
        block_stop: AtomicBool,
        stop_started: Notify,
        release_stop: Notify,
        session_calls: AtomicUsize,
        block_first_session: AtomicBool,
        first_session_started: Notify,
        release_first_session: Notify,
        cancel_calls: AtomicUsize,
        block_cancel: AtomicBool,
        cancel_started: Notify,
        release_cancel: Notify,
        permission_calls: AtomicUsize,
        permission_cancel_calls: AtomicUsize,
        block_permission: AtomicBool,
        permission_started: Notify,
        release_permission: Notify,
        lifecycle_senders: Mutex<Vec<mpsc::UnboundedSender<DriverLifecycleEvent>>>,
        permission_error: Mutex<Option<RuntimeError>>,
        check_error: Mutex<Option<RuntimeError>>,
        prompt_error: Mutex<Option<RuntimeError>>,
        prompt_calls: AtomicUsize,
        durable: AtomicBool,
        restored_session: Mutex<Option<RuntimeSession>>,
        attach_calls: AtomicUsize,
        downlink: StdMutex<Option<mpsc::Receiver<super::super::SessionFeedEvent>>>,
    }

    impl FakeDriver {
        async fn complete(&self, run_id: &str, stop_reason: &str) {
            let sender = self
                .prompt_senders
                .lock()
                .await
                .get(run_id)
                .cloned()
                .unwrap();
            sender
                .send(DriverEvent::Completed {
                    run_id: run_id.to_owned(),
                    stop_reason: stop_reason.to_owned(),
                })
                .unwrap();
        }

        async fn send(&self, run_id: &str, event: DriverEvent) {
            self.prompt_senders
                .lock()
                .await
                .get(run_id)
                .cloned()
                .unwrap()
                .send(event)
                .unwrap();
        }

        async fn process_exit(&self, error: RuntimeError) {
            let sender = self.lifecycle_senders.lock().await.last().cloned().unwrap();
            sender
                .send(DriverLifecycleEvent::ProcessExited(error))
                .unwrap();
        }

        async fn process_exit_at(&self, index: usize, error: RuntimeError) {
            let sender = self.lifecycle_senders.lock().await[index].clone();
            sender
                .send(DriverLifecycleEvent::ProcessExited(error))
                .unwrap();
        }

        async fn close_stream(&self, run_id: &str) {
            self.prompt_senders.lock().await.remove(run_id);
        }
    }

    #[async_trait]
    impl RuntimeDriver for FakeDriver {
        fn capabilities(&self) -> RuntimeCapabilities {
            RuntimeCapabilities {
                durable_sessions: self.durable.load(Ordering::SeqCst),
                detached_runs: self.durable.load(Ordering::SeqCst),
                replayable_events: self.durable.load(Ordering::SeqCst),
                runtime_owned_approvals: self.durable.load(Ordering::SeqCst),
                session_events: self.downlink.lock().unwrap().is_some(),
                ..RuntimeCapabilities::default()
            }
        }

        async fn session_downlink(
            &self,
        ) -> Result<mpsc::Receiver<super::super::SessionFeedEvent>, RuntimeError> {
            match self.downlink.lock().unwrap().take() {
                Some(receiver) => Ok(receiver),
                None => Err(RuntimeError::new(
                    RuntimeErrorCode::InternalError,
                    "Session downlink is not wired in this fake driver",
                )),
            }
        }

        async fn check(&self) -> Result<(), RuntimeError> {
            self.check_calls.fetch_add(1, Ordering::SeqCst);
            if let Some(error) = self.check_error.lock().await.clone() {
                return Err(error);
            }
            Ok(())
        }

        async fn start(&self) -> Result<DriverStart, RuntimeError> {
            self.start_calls.fetch_add(1, Ordering::SeqCst);
            if self.control_present.swap(true, Ordering::SeqCst) {
                return Err(RuntimeError::new(
                    RuntimeErrorCode::HermesStartFailed,
                    "Hermes is already started",
                ));
            }
            let (sender, receiver) = mpsc::unbounded_channel::<DriverLifecycleEvent>();
            if self.exit_during_start.load(Ordering::SeqCst) {
                sender
                    .send(DriverLifecycleEvent::ProcessExited(RuntimeError::new(
                        RuntimeErrorCode::ProcessExited,
                        "Hermes exited during startup",
                    )))
                    .unwrap();
            }
            self.lifecycle_senders.lock().await.push(sender);
            Ok(DriverStart {
                lifecycle_events: receiver,
            })
        }

        async fn stop(&self) -> Result<(), RuntimeError> {
            self.stop_calls.fetch_add(1, Ordering::SeqCst);
            if self.block_stop.load(Ordering::SeqCst) {
                self.stop_started.notify_one();
                self.release_stop.notified().await;
            }
            if let Some(error) = self.stop_error.lock().await.clone() {
                return Err(error);
            }
            self.control_present.store(false, Ordering::SeqCst);
            Ok(())
        }

        async fn create_session(
            &self,
            _session_id: &str,
            _title: Option<&str>,
            _cwd: PathBuf,
        ) -> Result<String, RuntimeError> {
            let index = self.session_calls.fetch_add(1, Ordering::SeqCst) + 1;
            if index == 1 && self.block_first_session.load(Ordering::SeqCst) {
                self.first_session_started.notify_one();
                self.release_first_session.notified().await;
            }
            Ok(format!("driver-session-{index}"))
        }

        async fn prompt(
            &self,
            request: DriverPromptRequest,
        ) -> Result<mpsc::UnboundedReceiver<DriverEvent>, RuntimeError> {
            self.prompt_calls.fetch_add(1, Ordering::SeqCst);
            if let Some(error) = self.prompt_error.lock().await.clone() {
                return Err(error);
            }
            let (sender, receiver) = mpsc::unbounded_channel();
            self.prompt_senders
                .lock()
                .await
                .insert(request.run_id, sender);
            Ok(receiver)
        }

        async fn get_session(&self, session_id: &str) -> Result<RuntimeSession, RuntimeError> {
            self.restored_session
                .lock()
                .await
                .clone()
                .filter(|session| session.id == session_id)
                .ok_or_else(|| {
                    RuntimeError::new(RuntimeErrorCode::SessionCreateFailed, "Session not found")
                })
        }

        async fn attach_run(
            &self,
            run_id: &str,
            _cursor: u64,
        ) -> Result<mpsc::UnboundedReceiver<DriverEvent>, RuntimeError> {
            self.attach_calls.fetch_add(1, Ordering::SeqCst);
            let (sender, receiver) = mpsc::unbounded_channel();
            self.prompt_senders
                .lock()
                .await
                .insert(run_id.to_owned(), sender);
            Ok(receiver)
        }

        async fn cancel(&self, _session_id: &str, _run_id: &str) -> Result<(), RuntimeError> {
            self.cancel_calls.fetch_add(1, Ordering::SeqCst);
            if self.block_cancel.load(Ordering::SeqCst) {
                self.cancel_started.notify_one();
                self.release_cancel.notified().await;
            }
            Ok(())
        }

        async fn resolve_permission(
            &self,
            _request_id: &str,
            _decision: super::super::PermissionDecision,
        ) -> Result<(), RuntimeError> {
            self.permission_calls.fetch_add(1, Ordering::SeqCst);
            if self.block_permission.load(Ordering::SeqCst) {
                self.permission_started.notify_one();
                self.release_permission.notified().await;
            }
            if let Some(error) = self.permission_error.lock().await.clone() {
                return Err(error);
            }
            Ok(())
        }

        async fn cancel_permission(&self, _request_id: &str) -> Result<(), RuntimeError> {
            self.permission_cancel_calls.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    /// 「事件通道满」的形状：`emit_session` 同步阻塞在这里，直到测试放行。
    /// 2026-09-16 现场里 mux 任务的 `tx.send().await` 就是这个姿势。
    #[derive(Default)]
    struct StalledSessionSink {
        entered: AtomicBool,
        released: AtomicBool,
        delivered: StdMutex<Vec<String>>,
    }

    impl RuntimeEventSink for StalledSessionSink {
        fn emit(&self, _event: &RuntimeEventEnvelope) -> Result<(), RuntimeError> {
            Ok(())
        }

        fn emit_session(&self, event: &super::super::SessionFeedEvent) -> Result<(), RuntimeError> {
            self.entered.store(true, Ordering::SeqCst);
            while !self.released.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(5));
            }
            self.delivered
                .lock()
                .unwrap()
                .push(event.session_id.clone());
            Ok(())
        }
    }

    /// 回归：事件广播被下游卡住时，读路径必须照常返回。
    /// 修复前广播是在状态锁里投递的，卡住 = 状态锁不释放 = 每次读会话撞 15s 超时；
    /// 现在是「锁内只做活跃性判断，投递在锁外」，卡住的广播最多让这一条流降级。
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_stalled_session_broadcast_never_holds_the_state_lock() {
        let (sender, receiver) = mpsc::channel::<super::super::SessionFeedEvent>(4);
        let driver = Arc::new(FakeDriver::default());
        *driver.downlink.lock().unwrap() = Some(receiver);
        let sink = Arc::new(StalledSessionSink::default());
        let gateway = Arc::new(MinimalRuntimeGateway::new(driver.clone(), sink.clone()));
        gateway.start().await.expect("fake runtime starts");

        sender
            .send(super::super::SessionFeedEvent {
                target_id: "target".into(),
                runtime_epoch: String::new(),
                session_id: "s1".into(),
                kind: "connection".into(),
                events: Vec::new(),
                hidden_run_ids: Vec::new(),
                summary: None,
                connection_status: "connected".into(),
                message: None,
            })
            .await
            .unwrap();

        let deadline = Instant::now() + Duration::from_secs(5);
        while !sink.entered.load(Ordering::SeqCst) && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(
            sink.entered.load(Ordering::SeqCst),
            "广播没有进入被卡住的状态，测试前提不成立"
        );

        // 直接探锁：同步互斥的等待没法被 tokio timeout 抢占，所以断言放在独立线程里。
        let probe = gateway.clone();
        let (probe_tx, probe_rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(1);
            let free = loop {
                if probe.state.try_lock().is_some() {
                    break true;
                }
                if Instant::now() >= deadline {
                    break false;
                }
                std::thread::sleep(Duration::from_millis(5));
            };
            let _ = probe_tx.send(free);
        });
        let lock_was_free = probe_rx
            .recv_timeout(Duration::from_secs(3))
            .unwrap_or(false);
        // 先放行广播再断言：否则卡住的 sink 会让测试运行时收不了工，失败信息反而看不出来。
        sink.released.store(true, Ordering::SeqCst);
        assert!(
            lock_was_free,
            "广播卡住期间状态锁被占住：session 投递又回到状态锁里了"
        );

        let snapshot = gateway.snapshot().await;
        assert_eq!(snapshot.status, RuntimeStatus::Ready);

        let delivered_deadline = Instant::now() + Duration::from_secs(2);
        while sink.delivered.lock().unwrap().is_empty() && Instant::now() < delivered_deadline {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(sink.delivered.lock().unwrap().as_slice(), ["s1"]);
    }

    #[derive(Default)]
    struct RecordingEventSink {
        events: StdMutex<Vec<RuntimeEventEnvelope>>,
    }

    impl RuntimeEventSink for RecordingEventSink {
        fn emit(&self, event: &RuntimeEventEnvelope) -> Result<(), RuntimeError> {
            self.events.lock().unwrap().push(event.clone());
            Ok(())
        }
    }

    struct FailingEventSink {
        events: StdMutex<Vec<RuntimeEventEnvelope>>,
        fail_on_call: usize,
        calls: AtomicUsize,
    }

    #[derive(Default)]
    struct RejectingRunTerminalSink {
        events: StdMutex<Vec<RuntimeEventEnvelope>>,
        terminal_calls: AtomicUsize,
    }

    impl RuntimeEventSink for RejectingRunTerminalSink {
        fn emit(&self, event: &RuntimeEventEnvelope) -> Result<(), RuntimeError> {
            if event.run_id.is_some() && event.event.is_terminal() {
                self.terminal_calls.fetch_add(1, Ordering::SeqCst);
                return Err(RuntimeError::new(
                    RuntimeErrorCode::InternalError,
                    "run terminal sink failed",
                ));
            }
            self.events.lock().unwrap().push(event.clone());
            Ok(())
        }
    }

    impl FailingEventSink {
        fn new(fail_on_call: usize) -> Self {
            Self {
                events: StdMutex::new(Vec::new()),
                fail_on_call,
                calls: AtomicUsize::new(0),
            }
        }
    }

    impl RuntimeEventSink for FailingEventSink {
        fn emit(&self, event: &RuntimeEventEnvelope) -> Result<(), RuntimeError> {
            let call = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
            if call == self.fail_on_call {
                return Err(RuntimeError::new(
                    RuntimeErrorCode::InternalError,
                    "event sink failed",
                ));
            }
            self.events.lock().unwrap().push(event.clone());
            Ok(())
        }
    }

    struct OrderingEventSink {
        events: StdMutex<Vec<RuntimeEventEnvelope>>,
        delayed_first_run_event: AtomicBool,
        first_run_event_started: Notify,
        terminal_event_started: Notify,
    }

    impl Default for OrderingEventSink {
        fn default() -> Self {
            Self {
                events: StdMutex::new(Vec::new()),
                delayed_first_run_event: AtomicBool::new(false),
                first_run_event_started: Notify::new(),
                terminal_event_started: Notify::new(),
            }
        }
    }

    impl RuntimeEventSink for OrderingEventSink {
        fn emit(&self, event: &RuntimeEventEnvelope) -> Result<(), RuntimeError> {
            if event.run_id.is_some() && !self.delayed_first_run_event.swap(true, Ordering::SeqCst)
            {
                self.first_run_event_started.notify_one();
                std::thread::sleep(Duration::from_millis(50));
            }
            if event.run_id.is_some() && event.event.is_terminal() {
                self.terminal_event_started.notify_one();
            }
            self.events.lock().unwrap().push(event.clone());
            Ok(())
        }
    }

    fn harness() -> (
        Arc<MinimalRuntimeGateway>,
        Arc<FakeDriver>,
        Arc<RecordingEventSink>,
        TempDir,
    ) {
        let driver = Arc::new(FakeDriver::default());
        let events = Arc::new(RecordingEventSink::default());
        let cwd = tempfile::tempdir().unwrap();
        let gateway = Arc::new(MinimalRuntimeGateway::new(driver.clone(), events.clone()));
        (gateway, driver, events, cwd)
    }

    async fn permission_resolve_request(
        gateway: &MinimalRuntimeGateway,
        request_id: &str,
        decision: PermissionDecision,
    ) -> PermissionResolveRequest {
        let state = gateway.state.lock().await;
        let Some(permission) = state.permissions.get(request_id) else {
            return PermissionResolveRequest {
                runtime_instance_id: format!(
                    "{}:{}",
                    RUNTIME_ID,
                    state.runtime_epoch.as_deref().unwrap_or("expired")
                ),
                runtime_id: RUNTIME_ID.into(),
                runtime_epoch: state
                    .runtime_epoch
                    .clone()
                    .unwrap_or_else(|| "expired".into()),
                session_id: "thread-1".into(),
                thread_id: "thread-1".into(),
                run_id: "expired".into(),
                request_id: request_id.into(),
                tool_call_id: "expired".into(),
                decision,
                reason: (decision == PermissionDecision::Deny)
                    .then_some(PermissionDenyReason::UserDenied),
                action_set_digest: None,
            };
        };
        PermissionResolveRequest {
            runtime_instance_id: permission.runtime_instance_id.clone(),
            runtime_id: permission.runtime_id.clone(),
            runtime_epoch: permission.runtime_epoch.clone(),
            session_id: permission.session_id.clone(),
            thread_id: permission.thread_id.clone(),
            run_id: permission.run_id.clone(),
            request_id: request_id.into(),
            tool_call_id: permission.tool_call_id.clone(),
            decision,
            reason: (decision == PermissionDecision::Deny)
                .then_some(PermissionDenyReason::UserDenied),
            action_set_digest: permission.action_set_digest.clone(),
        }
    }

    fn permission_receipt(
        request: &PermissionResolveRequest,
        status: PermissionResolveStatus,
    ) -> PermissionDecisionReceipt {
        PermissionDecisionReceipt {
            version: 1,
            runtime_instance_id: request.runtime_instance_id.clone(),
            runtime_id: request.runtime_id.clone(),
            runtime_epoch: request.runtime_epoch.clone(),
            session_id: request.session_id.clone(),
            thread_id: request.thread_id.clone(),
            run_id: request.run_id.clone(),
            request_id: request.request_id.clone(),
            tool_call_id: request.tool_call_id.clone(),
            decision: request.decision,
            status,
            reason: request.reason,
            action_set_digest: request.action_set_digest.clone(),
        }
    }

    #[test]
    fn action_digest_is_stable_for_identical_projection() {
        let actions = vec![crate::runtime::PermissionAction {
            kind: crate::runtime::PermissionActionKind::Tool,
            name: "terminal".into(),
            summary: "执行命令".into(),
        }];
        assert_eq!(action_set_digest(&actions), action_set_digest(&actions));
        assert_eq!(action_set_digest(&actions).len(), 64);
    }

    #[test]
    fn shared_permission_fixture_uses_the_same_action_digest() {
        let fixture: Vec<RuntimeEventEnvelope> = serde_json::from_str(include_str!(
            "../../../tests/fixtures/runtime-contract-v1.json"
        ))
        .unwrap();
        let request = fixture
            .into_iter()
            .find_map(|envelope| match envelope.event {
                RuntimeEvent::PermissionRequested { request } => Some(request),
                _ => None,
            })
            .expect("shared fixture must contain a permission request");
        let actions = request.actions.expect("fixture must contain actions");
        let expected_digest = action_set_digest(&actions);
        assert_eq!(
            request.action_set_digest.as_deref(),
            Some(expected_digest.as_str())
        );
    }

    #[test]
    fn permission_projection_preserves_unknown_driver_decisions_as_fail_closed() {
        let event = map_driver_event(
            DriverEvent::PermissionRequested {
                run_id: "run-1".into(),
                request: DriverPermissionRequest {
                    request_id: "permission-unknown".into(),
                    tool_call_id: "tool-1".into(),
                    title: "Run tool".into(),
                    description: "Requires approval".into(),
                    tool_name: "terminal".into(),
                    input_summary: None,
                    can_allow_once: true,
                    can_deny: true,
                    unsupported_decisions: vec!["always_allow".into()],
                    allow_once_option_id: Some("allow-once".into()),
                    reject_once_option_id: Some("reject-once".into()),
                },
            },
            false,
        );
        let RuntimeEvent::PermissionRequested { request } = event else {
            panic!("expected permission request");
        };
        assert!(request.has_unsupported_decision);
        assert!(request.can_allow_once);
    }

    #[test]
    fn receipt_store_loads_durable_identity() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("permission-receipts.json");
        let receipt = PermissionDecisionReceipt {
            version: 1,
            runtime_instance_id: "hermes:epoch-1".into(),
            runtime_id: "hermes".into(),
            runtime_epoch: "epoch-1".into(),
            session_id: "thread-1".into(),
            thread_id: "thread-1".into(),
            run_id: "run-1".into(),
            request_id: "request-1".into(),
            tool_call_id: "tool-1".into(),
            decision: PermissionDecision::Deny,
            status: PermissionResolveStatus::Accepted,
            reason: Some(PermissionDenyReason::UserDenied),
            action_set_digest: Some("a".repeat(64)),
        };
        std::fs::write(&path, serde_json::to_vec(&vec![receipt.clone()]).unwrap()).unwrap();
        let driver = Arc::new(FakeDriver::default());
        let sink = Arc::new(RecordingEventSink::default());
        let gateway = MinimalRuntimeGateway::new(driver, sink).with_receipt_store(path);
        assert_eq!(gateway.state.try_lock().unwrap().receipts.len(), 1);
    }

    #[tokio::test]
    async fn receipt_store_retains_only_the_newest_bounded_identities() {
        let driver = Arc::new(FakeDriver::default());
        let sink = Arc::new(RecordingEventSink::default());
        let gateway = MinimalRuntimeGateway::new(driver, sink);
        let limit = MAX_PERMISSION_RECEIPTS;

        for index in 0..=limit {
            let receipt = PermissionDecisionReceipt {
                version: 1,
                runtime_instance_id: "hermes:epoch-1".into(),
                runtime_id: "hermes".into(),
                runtime_epoch: "epoch-1".into(),
                session_id: "thread-1".into(),
                thread_id: "thread-1".into(),
                run_id: "run-1".into(),
                request_id: format!("request-{index}"),
                tool_call_id: "tool-1".into(),
                decision: PermissionDecision::Deny,
                status: PermissionResolveStatus::Rejected,
                reason: Some(PermissionDenyReason::PresenterFailed),
                action_set_digest: None,
            };
            gateway.persist_receipt(receipt).await;
        }

        let state = gateway.state.lock().await;
        assert_eq!(state.receipts.len(), limit);
        assert!(!state
            .receipts
            .contains_key("hermes:epoch-1\0run-1\0request-0"));
        assert!(state
            .receipts
            .contains_key(&format!("hermes:epoch-1\0run-1\0request-{limit}")));
    }

    #[tokio::test]
    async fn receipt_copy_does_not_reauthorize_after_gateway_rebuild() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("permission-receipts.json");
        let stored = PermissionDecisionReceipt {
            version: 1,
            runtime_instance_id: "hermes:epoch-1".into(),
            runtime_id: "hermes".into(),
            runtime_epoch: "epoch-1".into(),
            session_id: "thread-1".into(),
            thread_id: "thread-1".into(),
            run_id: "run-1".into(),
            request_id: "request-1".into(),
            tool_call_id: "tool-1".into(),
            decision: PermissionDecision::Deny,
            status: PermissionResolveStatus::Accepted,
            reason: Some(PermissionDenyReason::UserDenied),
            action_set_digest: Some("a".repeat(64)),
        };
        fs::write(&path, serde_json::to_vec(&vec![stored]).unwrap()).unwrap();
        let driver = Arc::new(FakeDriver::default());
        let sink = Arc::new(RecordingEventSink::default());
        let gateway = MinimalRuntimeGateway::new(driver.clone(), sink).with_receipt_store(path);
        let request = PermissionResolveRequest {
            runtime_instance_id: "hermes:epoch-1".into(),
            runtime_id: "hermes".into(),
            runtime_epoch: "epoch-1".into(),
            session_id: "thread-1".into(),
            thread_id: "thread-1".into(),
            run_id: "run-1".into(),
            request_id: "request-1".into(),
            tool_call_id: "tool-1".into(),
            decision: PermissionDecision::Deny,
            reason: Some(PermissionDenyReason::UserDenied),
            action_set_digest: Some("a".repeat(64)),
        };

        let result = gateway.resolve_permission(request).await.unwrap();

        assert_eq!(result.status, PermissionResolveStatus::Expired);
        assert_eq!(driver.permission_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn receipt_store_persists_stale_and_rejected_attempts_atomically() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("nested/permission-receipts.json");
        let driver = Arc::new(FakeDriver::default());
        let sink = Arc::new(RecordingEventSink::default());
        let gateway = MinimalRuntimeGateway::new(driver, sink).with_receipt_store(path.clone());
        let request = PermissionResolveRequest {
            runtime_instance_id: "hermes:epoch-1".into(),
            runtime_id: "hermes".into(),
            runtime_epoch: "epoch-1".into(),
            session_id: "thread-1".into(),
            thread_id: "thread-1".into(),
            run_id: "run-1".into(),
            request_id: "request-1".into(),
            tool_call_id: "tool-1".into(),
            decision: PermissionDecision::Deny,
            reason: Some(PermissionDenyReason::PresenterFailed),
            action_set_digest: Some("b".repeat(64)),
        };
        gateway
            .persist_receipt(request.receipt(PermissionResolveStatus::Stale))
            .await;
        gateway
            .persist_receipt(request.receipt(PermissionResolveStatus::Rejected))
            .await;
        let persisted: Vec<PermissionDecisionReceipt> =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(persisted.len(), 1);
        assert_eq!(persisted[0].status, PermissionResolveStatus::Rejected);
        assert!(std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .flatten()
            .all(|entry| !entry.file_name().to_string_lossy().contains(".tmp")));
    }

    #[tokio::test]
    async fn receipt_store_failure_keeps_authoritative_in_memory_receipt_and_cleans_temp_file() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("receipt-target");
        std::fs::create_dir_all(&path).unwrap();
        let driver = Arc::new(FakeDriver::default());
        let sink = Arc::new(RecordingEventSink::default());
        let gateway = MinimalRuntimeGateway::new(driver, sink).with_receipt_store(path.clone());
        let receipt = PermissionDecisionReceipt {
            version: 1,
            runtime_instance_id: "hermes:epoch-1".into(),
            runtime_id: "hermes".into(),
            runtime_epoch: "epoch-1".into(),
            session_id: "thread-1".into(),
            thread_id: "thread-1".into(),
            run_id: "run-1".into(),
            request_id: "request-1".into(),
            tool_call_id: "tool-1".into(),
            decision: PermissionDecision::Deny,
            status: PermissionResolveStatus::Rejected,
            reason: Some(PermissionDenyReason::PresenterFailed),
            action_set_digest: None,
        };

        let returned = gateway.persist_receipt(receipt.clone()).await;

        assert_eq!(returned, receipt);
        assert_eq!(gateway.state.lock().await.receipts.len(), 1);
        assert!(std::fs::read_dir(root.path())
            .unwrap()
            .flatten()
            .all(|entry| !entry.file_name().to_string_lossy().contains(".tmp")));
    }

    #[tokio::test]
    async fn receipt_store_failure_does_not_change_resolve_or_duplicate_semantics() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("receipt-target");
        std::fs::create_dir_all(&path).unwrap();
        let driver = Arc::new(FakeDriver::default());
        let sink = Arc::new(RecordingEventSink::default());
        let gateway = MinimalRuntimeGateway::new(driver.clone(), sink).with_receipt_store(path);
        {
            let mut state = gateway.state.lock().await;
            state.runtime_epoch = Some("epoch-1".into());
            state.runs.insert(
                "run-1".into(),
                RunRecord {
                    session_id: "thread-1".into(),
                    driver_session_id: "driver-thread-1".into(),
                    next_sequence: 0,
                    terminal: false,
                    awaiting_driver_terminal: false,
                    cancel_sent: false,
                    detach: None,
                },
            );
            state.permissions.insert(
                "request-1".into(),
                PermissionRecord {
                    runtime_instance_id: "hermes:epoch-1".into(),
                    runtime_id: "hermes".into(),
                    runtime_epoch: "epoch-1".into(),
                    session_id: "thread-1".into(),
                    thread_id: "thread-1".into(),
                    run_id: "run-1".into(),
                    tool_call_id: "tool-1".into(),
                    expires_at: "2099-01-01T00:00:00Z".into(),
                    resolved_decision: None,
                    can_allow_once: true,
                    action_set_digest: None,
                },
            );
        }
        let request = PermissionResolveRequest {
            runtime_instance_id: "hermes:epoch-1".into(),
            runtime_id: "hermes".into(),
            runtime_epoch: "epoch-1".into(),
            session_id: "thread-1".into(),
            thread_id: "thread-1".into(),
            run_id: "run-1".into(),
            request_id: "request-1".into(),
            tool_call_id: "tool-1".into(),
            decision: PermissionDecision::AllowOnce,
            reason: None,
            action_set_digest: None,
        };

        assert_eq!(
            gateway
                .resolve_permission(request.clone())
                .await
                .unwrap()
                .status,
            PermissionResolveStatus::Accepted
        );
        assert_eq!(
            gateway.resolve_permission(request).await.unwrap().status,
            PermissionResolveStatus::Duplicate
        );
        assert_eq!(driver.permission_calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn one_session_reuses_mapping_and_rejects_parallel_run() {
        let (gateway, driver, events, cwd) = harness();
        gateway.start().await.unwrap();
        let request = SessionCreateRequest {
            agent_id: None,
            session_id: "thread-1".into(),
            title: None,
        };
        let first = gateway
            .create_session(request.clone(), cwd.path().to_path_buf())
            .await
            .unwrap();
        let second = gateway
            .create_session(request, cwd.path().to_path_buf())
            .await
            .unwrap();
        assert_eq!(first.runtime_session_id, second.runtime_session_id);
        assert!(second.reused);

        let run = gateway
            .start_run(RunStartRequest {
                session_id: "thread-1".into(),
                user_message_id: "user-1".into(),
                prompt: "first".into(),
            })
            .await
            .unwrap();
        let conflict = gateway
            .start_run(RunStartRequest {
                session_id: "thread-1".into(),
                user_message_id: "user-2".into(),
                prompt: "second".into(),
            })
            .await
            .unwrap_err();
        assert_eq!(conflict.code, RuntimeErrorCode::RunConflict);

        driver.complete(&run.run_id, "end_turn").await;
        tokio::task::yield_now().await;
        let terminal_count = events
            .events
            .lock()
            .unwrap()
            .iter()
            .filter(|event| {
                event.run_id.as_deref() == Some(&run.run_id) && event.event.is_terminal()
            })
            .count();
        assert_eq!(terminal_count, 1);
    }

    #[tokio::test]
    async fn attach_replays_and_detach_does_not_cancel_or_fail_the_run() {
        let (gateway, driver, events, _) = harness();
        driver.durable.store(true, Ordering::SeqCst);
        *driver.restored_session.lock().await = Some(RuntimeSession {
            running: false,
            waiting: false,
            failed: false,
            completed_unread: false,
            active_run_id: None,
            pending_interaction: None,
            id: "thread-restored".into(),
            title: "Restored".into(),
            agent_id: "default".into(),
            metadata: Default::default(),
            created_at: 1.0,
            updated_at: 2.0,
            latest_run: Some(super::super::RuntimeRunSnapshot {
                id: "run-restored".into(),
                session_id: "thread-restored".into(),
                agent_id: "default".into(),
                status: "running".into(),
                content: "partial".into(),
                usage: None,
                error: None,
                pending_actions: vec![],
                event_cursor: 1,
                created_at: 1.0,
                updated_at: 2.0,
            }),
        });
        gateway.start().await.unwrap();

        gateway.attach_session("thread-restored").await.unwrap();
        driver
            .send(
                "run-restored",
                DriverEvent::TextDelta {
                    run_id: "run-restored".into(),
                    message_id: "assistant".into(),
                    delta: "replayed".into(),
                },
            )
            .await;
        tokio::task::yield_now().await;
        let detached = gateway.detach_session("thread-restored").await.unwrap();
        tokio::task::yield_now().await;

        assert!(!detached.duplicate);
        assert_eq!(driver.attach_calls.load(Ordering::SeqCst), 1);
        assert_eq!(driver.cancel_calls.load(Ordering::SeqCst), 0);
        assert_eq!(driver.stop_calls.load(Ordering::SeqCst), 0);
        assert!(events.events.lock().unwrap().iter().any(|event| {
            matches!(
                &event.event,
                RuntimeEvent::TextDelta { delta, .. } if delta == "replayed"
            )
        }));
        assert!(!events
            .events
            .lock()
            .unwrap()
            .iter()
            .any(|event| event.run_id.as_deref() == Some("run-restored")
                && event.event.is_terminal()));
    }

    #[tokio::test]
    async fn non_durable_runtime_rejects_detach() {
        let (gateway, _, _, _) = harness();
        gateway.start().await.unwrap();

        let error = gateway.detach_session("thread-1").await.unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::AcpCapabilityMissing);
    }

    #[tokio::test]
    async fn concurrent_session_creation_uses_one_driver_session() {
        let (gateway, driver, _events, cwd) = harness();
        gateway.start().await.unwrap();
        driver.block_first_session.store(true, Ordering::SeqCst);
        let request = SessionCreateRequest {
            agent_id: None,
            session_id: "thread-1".into(),
            title: None,
        };

        let first_gateway = gateway.clone();
        let first_request = request.clone();
        let first_cwd = cwd.path().to_path_buf();
        let first =
            tokio::spawn(
                async move { first_gateway.create_session(first_request, first_cwd).await },
            );
        driver.first_session_started.notified().await;

        let second_gateway = gateway.clone();
        let second_cwd = cwd.path().to_path_buf();
        let second =
            tokio::spawn(async move { second_gateway.create_session(request, second_cwd).await });
        tokio::task::yield_now().await;
        driver.release_first_session.notify_one();

        let first = first.await.unwrap().unwrap();
        let second = second.await.unwrap().unwrap();
        assert_eq!(driver.session_calls.load(Ordering::SeqCst), 1);
        assert_eq!(first.runtime_session_id, second.runtime_session_id);
        assert!(!first.reused);
        assert!(second.reused);
    }

    #[tokio::test]
    async fn ready_sink_failure_stops_started_driver_and_marks_runtime_failed() {
        let driver = Arc::new(FakeDriver::default());
        let sink = Arc::new(FailingEventSink::new(3));
        let gateway = Arc::new(MinimalRuntimeGateway::new(driver.clone(), sink.clone()));

        let error = gateway.start().await.unwrap_err();

        assert_eq!(error.code, RuntimeErrorCode::InternalError);
        assert_eq!(gateway.snapshot().await.status, RuntimeStatus::Failed);
        assert_eq!(driver.stop_calls.load(Ordering::SeqCst), 1);
        assert!(sink.events.lock().unwrap().iter().any(|event| matches!(
            event.event,
            RuntimeEvent::RuntimeStatusChanged {
                status: RuntimeStatus::Failed,
                ..
            }
        )));
    }

    #[tokio::test]
    async fn runtime_sink_failure_does_not_commit_or_skip_runtime_sequence() {
        let driver = Arc::new(FakeDriver::default());
        let sink = Arc::new(FailingEventSink::new(1));
        let gateway = Arc::new(MinimalRuntimeGateway::new(driver, sink.clone()));

        gateway.start().await.unwrap_err();

        let recorded = sink.events.lock().unwrap();
        assert_eq!(recorded.len(), 1);
        assert_eq!(recorded[0].sequence, 0);
        assert!(matches!(
            recorded[0].event,
            RuntimeEvent::RuntimeStatusChanged {
                status: RuntimeStatus::Failed,
                ..
            }
        ));
        drop(recorded);
        assert_eq!(gateway.snapshot().await.sequence, 0);
    }

    #[tokio::test]
    async fn stopping_sink_failure_does_not_skip_driver_cleanup() {
        let driver = Arc::new(FakeDriver::default());
        let sink = Arc::new(FailingEventSink::new(4));
        let gateway = Arc::new(MinimalRuntimeGateway::new(driver.clone(), sink));
        gateway.start().await.unwrap();

        let error = gateway.stop().await.unwrap_err();

        assert_eq!(error.code, RuntimeErrorCode::InternalError);
        assert_eq!(driver.stop_calls.load(Ordering::SeqCst), 1);
        assert_eq!(gateway.snapshot().await.status, RuntimeStatus::Stopped);
        assert_eq!(
            gateway.stop().await.unwrap(),
            CommandAck {
                accepted: true,
                duplicate: true,
            }
        );
    }

    #[tokio::test]
    async fn failed_driver_stop_is_retried_before_restart() {
        let (gateway, driver, _events, _cwd) = harness();
        gateway.start().await.unwrap();
        *driver.stop_error.lock().await = Some(RuntimeError::new(
            RuntimeErrorCode::ProcessExited,
            "stop failed",
        ));

        assert_eq!(
            gateway.stop().await.unwrap_err().code,
            RuntimeErrorCode::ProcessExited
        );
        assert_eq!(gateway.snapshot().await.status, RuntimeStatus::Failed);
        *driver.stop_error.lock().await = None;

        assert_eq!(gateway.start().await.unwrap().status, RuntimeStatus::Ready);
        assert_eq!(driver.stop_calls.load(Ordering::SeqCst), 2);
        assert_eq!(driver.start_calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn restart_retries_cleanup_before_rejecting_an_unpublished_run() {
        let driver = Arc::new(FakeDriver::default());
        let sink = Arc::new(RejectingRunTerminalSink::default());
        let gateway = Arc::new(MinimalRuntimeGateway::new(driver.clone(), sink));
        let cwd = tempfile::tempdir().unwrap();
        gateway.start().await.unwrap();
        gateway
            .create_session(
                SessionCreateRequest {
                    agent_id: None,
                    session_id: "thread-1".into(),
                    title: None,
                },
                cwd.path().to_path_buf(),
            )
            .await
            .unwrap();
        let run = gateway
            .start_run(RunStartRequest {
                session_id: "thread-1".into(),
                user_message_id: "user-1".into(),
                prompt: "hello".into(),
            })
            .await
            .unwrap();
        *driver.stop_error.lock().await = Some(RuntimeError::new(
            RuntimeErrorCode::ProcessExited,
            "stop failed",
        ));

        gateway.stop().await.unwrap_err();
        *driver.stop_error.lock().await = None;

        assert_eq!(
            gateway.start().await.unwrap_err().code,
            RuntimeErrorCode::ProcessExited
        );
        assert_eq!(driver.stop_calls.load(Ordering::SeqCst), 2);
        assert_eq!(driver.start_calls.load(Ordering::SeqCst), 1);
        let state = gateway.state.lock().await;
        assert!(!state.cleanup_pending);
        assert!(!state.runs.get(&run.run_id).unwrap().terminal);
        assert_eq!(state.active_by_session.get("thread-1"), Some(&run.run_id));
    }

    #[tokio::test]
    async fn stop_run_sink_failure_retries_the_same_cancelled_terminal_before_cleanup() {
        let driver = Arc::new(FakeDriver::default());
        let sink = Arc::new(FailingEventSink::new(6));
        let gateway = Arc::new(MinimalRuntimeGateway::new(driver.clone(), sink.clone()));
        let cwd = tempfile::tempdir().unwrap();
        gateway.start().await.unwrap();
        gateway
            .create_session(
                SessionCreateRequest {
                    agent_id: None,
                    session_id: "thread-1".into(),
                    title: None,
                },
                cwd.path().to_path_buf(),
            )
            .await
            .unwrap();
        let run = gateway
            .start_run(RunStartRequest {
                session_id: "thread-1".into(),
                user_message_id: "user-1".into(),
                prompt: "hello".into(),
            })
            .await
            .unwrap();
        driver.block_stop.store(true, Ordering::SeqCst);

        let stop_gateway = gateway.clone();
        let stop = tokio::spawn(async move { stop_gateway.stop().await });
        driver.stop_started.notified().await;
        {
            let state = gateway.state.lock().await;
            let record = state.runs.get(&run.run_id).unwrap();
            assert!(record.terminal);
            assert_eq!(record.next_sequence, 2);
        }
        let terminals = sink
            .events
            .lock()
            .unwrap()
            .iter()
            .filter(|event| {
                event.run_id.as_deref() == Some(&run.run_id) && event.event.is_terminal()
            })
            .cloned()
            .collect::<Vec<_>>();
        assert_eq!(terminals.len(), 1);
        assert_eq!(terminals[0].sequence, 1);
        assert!(matches!(
            terminals[0].event,
            RuntimeEvent::RunCancelled {
                reason: Some(ref reason),
            } if reason == "runtime_stopped"
        ));
        driver.release_stop.notify_one();
        assert_eq!(
            stop.await.unwrap().unwrap_err().code,
            RuntimeErrorCode::InternalError
        );
    }

    #[tokio::test]
    async fn stopped_sink_failure_is_retryable_without_stopping_driver_twice() {
        let driver = Arc::new(FakeDriver::default());
        let sink = Arc::new(FailingEventSink::new(5));
        let gateway = Arc::new(MinimalRuntimeGateway::new(driver.clone(), sink.clone()));

        gateway.start().await.unwrap();

        assert_eq!(
            gateway.stop().await.unwrap_err().code,
            RuntimeErrorCode::InternalError
        );
        assert_eq!(gateway.snapshot().await.status, RuntimeStatus::Stopping);
        assert_eq!(driver.stop_calls.load(Ordering::SeqCst), 1);

        assert_eq!(
            gateway.stop().await.unwrap(),
            CommandAck {
                accepted: true,
                duplicate: false,
            }
        );
        assert_eq!(driver.stop_calls.load(Ordering::SeqCst), 1);
        assert_eq!(gateway.snapshot().await.status, RuntimeStatus::Stopped);
        let stopped = sink
            .events
            .lock()
            .unwrap()
            .iter()
            .filter(|event| {
                matches!(
                    event.event,
                    RuntimeEvent::RuntimeStatusChanged {
                        status: RuntimeStatus::Stopped,
                        ..
                    }
                )
            })
            .cloned()
            .collect::<Vec<_>>();
        assert_eq!(stopped.len(), 1);
        assert_eq!(stopped[0].sequence, 4);

        assert!(gateway.stop().await.unwrap().duplicate);
        assert_eq!(driver.stop_calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn start_publishes_pending_stopped_before_creating_a_new_epoch() {
        let driver = Arc::new(FakeDriver::default());
        let sink = Arc::new(FailingEventSink::new(5));
        let gateway = Arc::new(MinimalRuntimeGateway::new(driver.clone(), sink.clone()));

        let first = gateway.start().await.unwrap();
        gateway.stop().await.unwrap_err();
        assert_eq!(gateway.snapshot().await.status, RuntimeStatus::Stopping);

        let restarted = gateway.start().await.unwrap();

        assert_ne!(first.runtime_epoch, restarted.runtime_epoch);
        assert_eq!(driver.stop_calls.load(Ordering::SeqCst), 1);
        assert_eq!(driver.start_calls.load(Ordering::SeqCst), 2);
        let events = sink.events.lock().unwrap();
        let stopped_index = events
            .iter()
            .position(|event| {
                event.runtime_epoch == first.runtime_epoch.clone().unwrap()
                    && matches!(
                        event.event,
                        RuntimeEvent::RuntimeStatusChanged {
                            status: RuntimeStatus::Stopped,
                            ..
                        }
                    )
            })
            .expect("the old epoch must publish stopped before restart");
        let checking_index = events
            .iter()
            .position(|event| {
                event.runtime_epoch == restarted.runtime_epoch.clone().unwrap()
                    && matches!(
                        event.event,
                        RuntimeEvent::RuntimeStatusChanged {
                            status: RuntimeStatus::Checking,
                            ..
                        }
                    )
            })
            .expect("the new epoch must publish checking");
        assert!(stopped_index < checking_index);
    }

    #[tokio::test]
    async fn persistent_stop_terminal_sink_failure_preserves_uncommitted_run() {
        let driver = Arc::new(FakeDriver::default());
        let sink = Arc::new(RejectingRunTerminalSink::default());
        let gateway = Arc::new(MinimalRuntimeGateway::new(driver.clone(), sink.clone()));
        let cwd = tempfile::tempdir().unwrap();
        gateway.start().await.unwrap();
        gateway
            .create_session(
                SessionCreateRequest {
                    agent_id: None,
                    session_id: "thread-1".into(),
                    title: None,
                },
                cwd.path().to_path_buf(),
            )
            .await
            .unwrap();
        let run = gateway
            .start_run(RunStartRequest {
                session_id: "thread-1".into(),
                user_message_id: "user-1".into(),
                prompt: "hello".into(),
            })
            .await
            .unwrap();

        gateway.stop().await.unwrap_err();

        assert_eq!(driver.stop_calls.load(Ordering::SeqCst), 1);
        assert_eq!(gateway.snapshot().await.status, RuntimeStatus::Failed);
        {
            let state = gateway.state.lock().await;
            assert!(!state.runs.get(&run.run_id).unwrap().terminal);
            assert_eq!(state.active_by_session.get("thread-1"), Some(&run.run_id));
        }
        assert!(gateway.start().await.is_err());
        assert!(gateway.state.lock().await.runs.contains_key(&run.run_id));
        assert!(!sink.events.lock().unwrap().iter().any(|event| {
            event.run_id.as_deref() == Some(&run.run_id) && event.event.is_terminal()
        }));
    }

    #[tokio::test]
    async fn run_started_sink_failure_releases_session_without_prompting_driver() {
        let driver = Arc::new(FakeDriver::default());
        let sink = Arc::new(FailingEventSink::new(4));
        let gateway = Arc::new(MinimalRuntimeGateway::new(driver.clone(), sink.clone()));
        let cwd = tempfile::tempdir().unwrap();
        gateway.start().await.unwrap();
        gateway
            .create_session(
                SessionCreateRequest {
                    agent_id: None,
                    session_id: "thread-1".into(),
                    title: None,
                },
                cwd.path().to_path_buf(),
            )
            .await
            .unwrap();

        let error = gateway
            .start_run(RunStartRequest {
                session_id: "thread-1".into(),
                user_message_id: "user-1".into(),
                prompt: "first".into(),
            })
            .await
            .unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::InternalError);
        assert_eq!(driver.prompt_calls.load(Ordering::SeqCst), 0);

        let run = gateway
            .start_run(RunStartRequest {
                session_id: "thread-1".into(),
                user_message_id: "user-2".into(),
                prompt: "second".into(),
            })
            .await
            .unwrap();
        assert_eq!(driver.prompt_calls.load(Ordering::SeqCst), 1);
        let run_events = sink
            .events
            .lock()
            .unwrap()
            .iter()
            .filter(|event| event.run_id.is_some())
            .cloned()
            .collect::<Vec<_>>();
        assert_eq!(run_events.len(), 1);
        assert_eq!(run_events[0].run_id.as_deref(), Some(run.run_id.as_str()));
        assert_eq!(run_events[0].sequence, 0);
        assert!(matches!(
            run_events[0].event,
            RuntimeEvent::RunStarted { .. }
        ));
    }

    #[tokio::test]
    async fn concurrent_publishers_broadcast_run_events_in_sequence_order() {
        let driver = Arc::new(FakeDriver::default());
        let sink = Arc::new(OrderingEventSink::default());
        let gateway = Arc::new(MinimalRuntimeGateway::new(driver.clone(), sink.clone()));
        let cwd = tempfile::tempdir().unwrap();
        gateway.start().await.unwrap();
        gateway
            .create_session(
                SessionCreateRequest {
                    agent_id: None,
                    session_id: "thread-1".into(),
                    title: None,
                },
                cwd.path().to_path_buf(),
            )
            .await
            .unwrap();

        let start_gateway = gateway.clone();
        let runtime_handle = tokio::runtime::Handle::current();
        let start = tokio::task::spawn_blocking(move || {
            runtime_handle.block_on(start_gateway.start_run(RunStartRequest {
                session_id: "thread-1".into(),
                user_message_id: "user-1".into(),
                prompt: "hello".into(),
            }))
        });
        sink.first_run_event_started.notified().await;
        driver
            .process_exit(RuntimeError::new(
                RuntimeErrorCode::ProcessExited,
                "Hermes exited",
            ))
            .await;
        sink.terminal_event_started.notified().await;
        let run = start.await.unwrap().unwrap();
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if sink.events.lock().unwrap().iter().any(|event| {
                    event.run_id.as_deref() == Some(&run.run_id) && event.event.is_terminal()
                }) {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let sequences = sink
            .events
            .lock()
            .unwrap()
            .iter()
            .filter(|event| event.run_id.as_deref() == Some(&run.run_id))
            .map(|event| event.sequence)
            .collect::<Vec<_>>();
        assert_eq!(sequences, vec![0, 1]);
    }

    #[tokio::test]
    async fn run_event_sink_failure_fails_runtime_and_stops_driver() {
        let driver = Arc::new(FakeDriver::default());
        let sink = Arc::new(FailingEventSink::new(5));
        let gateway = Arc::new(MinimalRuntimeGateway::new(driver.clone(), sink.clone()));
        let cwd = tempfile::tempdir().unwrap();
        gateway.start().await.unwrap();
        gateway
            .create_session(
                SessionCreateRequest {
                    agent_id: None,
                    session_id: "thread-1".into(),
                    title: None,
                },
                cwd.path().to_path_buf(),
            )
            .await
            .unwrap();
        let run = gateway
            .start_run(RunStartRequest {
                session_id: "thread-1".into(),
                user_message_id: "user-1".into(),
                prompt: "hello".into(),
            })
            .await
            .unwrap();

        driver
            .send(
                &run.run_id,
                DriverEvent::TextDelta {
                    run_id: run.run_id.clone(),
                    message_id: "assistant-1".into(),
                    delta: "lost".into(),
                },
            )
            .await;
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if gateway.snapshot().await.status == RuntimeStatus::Failed
                    && driver.stop_calls.load(Ordering::SeqCst) == 1
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();

        assert!(sink.events.lock().unwrap().iter().any(|event| matches!(
            event.event,
            RuntimeEvent::RuntimeStatusChanged {
                status: RuntimeStatus::Failed,
                ..
            }
        )));
        assert!(sink.events.lock().unwrap().iter().any(|event| {
            event.run_id.as_deref() == Some(&run.run_id)
                && matches!(event.event, RuntimeEvent::RunFailed { .. })
        }));
    }

    #[tokio::test]
    async fn prompt_failure_terminal_sink_error_fails_runtime_and_stops_driver() {
        let driver = Arc::new(FakeDriver::default());
        let sink = Arc::new(FailingEventSink::new(5));
        let gateway = Arc::new(MinimalRuntimeGateway::new(driver.clone(), sink));
        let cwd = tempfile::tempdir().unwrap();
        gateway.start().await.unwrap();
        gateway
            .create_session(
                SessionCreateRequest {
                    agent_id: None,
                    session_id: "thread-1".into(),
                    title: None,
                },
                cwd.path().to_path_buf(),
            )
            .await
            .unwrap();
        *driver.prompt_error.lock().await = Some(RuntimeError::new(
            RuntimeErrorCode::RunFailed,
            "prompt failed",
        ));

        gateway
            .start_run(RunStartRequest {
                session_id: "thread-1".into(),
                user_message_id: "user-1".into(),
                prompt: "hello".into(),
            })
            .await
            .unwrap_err();

        assert_eq!(gateway.snapshot().await.status, RuntimeStatus::Failed);
        assert_eq!(driver.stop_calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn stream_close_terminal_sink_error_fails_runtime_and_stops_driver() {
        let driver = Arc::new(FakeDriver::default());
        let sink = Arc::new(FailingEventSink::new(5));
        let gateway = Arc::new(MinimalRuntimeGateway::new(driver.clone(), sink));
        let cwd = tempfile::tempdir().unwrap();
        gateway.start().await.unwrap();
        gateway
            .create_session(
                SessionCreateRequest {
                    agent_id: None,
                    session_id: "thread-1".into(),
                    title: None,
                },
                cwd.path().to_path_buf(),
            )
            .await
            .unwrap();
        let run = gateway
            .start_run(RunStartRequest {
                session_id: "thread-1".into(),
                user_message_id: "user-1".into(),
                prompt: "hello".into(),
            })
            .await
            .unwrap();

        driver.close_stream(&run.run_id).await;
        tokio::time::timeout(Duration::from_secs(1), async {
            while gateway.snapshot().await.status != RuntimeStatus::Failed {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(driver.stop_calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn start_is_idempotent_and_snapshot_reports_last_runtime_sequence() {
        let (gateway, driver, events, _cwd) = harness();
        let first = gateway.start().await.unwrap();
        let second = gateway.start().await.unwrap();

        assert_eq!(driver.check_calls.load(Ordering::SeqCst), 1);
        assert_eq!(driver.start_calls.load(Ordering::SeqCst), 1);
        assert_eq!(first.runtime_epoch, second.runtime_epoch);
        assert_eq!(first.sequence, 2);
        assert_eq!(second.sequence, 2);
        let runtime_sequences = events
            .events
            .lock()
            .unwrap()
            .iter()
            .filter(|event| event.run_id.is_none())
            .map(|event| event.sequence)
            .collect::<Vec<_>>();
        assert_eq!(runtime_sequences, vec![0, 1, 2]);
    }

    #[tokio::test]
    async fn process_exit_during_start_never_publishes_ready() {
        let (gateway, driver, events, _cwd) = harness();
        driver.exit_during_start.store(true, Ordering::SeqCst);

        let error = gateway.start().await.unwrap_err();

        assert_eq!(error.code, RuntimeErrorCode::ProcessExited);
        assert_eq!(gateway.snapshot().await.status, RuntimeStatus::Failed);
        assert!(!events.events.lock().unwrap().iter().any(|event| matches!(
            event.event,
            RuntimeEvent::RuntimeStatusChanged {
                status: RuntimeStatus::Ready,
                ..
            }
        )));
        assert_eq!(driver.stop_calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn stop_is_idempotent_ends_runs_and_restart_changes_epoch() {
        let (gateway, driver, events, cwd) = harness();
        let first_epoch = gateway.start().await.unwrap().runtime_epoch.unwrap();
        gateway
            .create_session(
                SessionCreateRequest {
                    agent_id: None,
                    session_id: "thread-1".into(),
                    title: None,
                },
                cwd.path().to_path_buf(),
            )
            .await
            .unwrap();
        let run = gateway
            .start_run(RunStartRequest {
                session_id: "thread-1".into(),
                user_message_id: "user-1".into(),
                prompt: "hello".into(),
            })
            .await
            .unwrap();

        assert_eq!(
            gateway.stop().await.unwrap(),
            CommandAck {
                accepted: true,
                duplicate: false,
            }
        );
        assert_eq!(
            gateway.stop().await.unwrap(),
            CommandAck {
                accepted: true,
                duplicate: true,
            }
        );
        assert_eq!(driver.stop_calls.load(Ordering::SeqCst), 1);
        let run_events = events
            .events
            .lock()
            .unwrap()
            .iter()
            .filter(|event| event.run_id.as_deref() == Some(&run.run_id))
            .cloned()
            .collect::<Vec<_>>();
        assert!(matches!(
            run_events.last().map(|event| &event.event),
            Some(RuntimeEvent::RunCancelled { reason: Some(reason) })
                if reason == "runtime_stopped"
        ));

        let second_epoch = gateway.start().await.unwrap().runtime_epoch.unwrap();
        assert_ne!(first_epoch, second_epoch);
        assert_eq!(driver.start_calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn stop_closes_active_driver_event_streams() {
        let (gateway, driver, _events, cwd) = harness();
        gateway.start().await.unwrap();
        gateway
            .create_session(
                SessionCreateRequest {
                    agent_id: None,
                    session_id: "thread-1".into(),
                    title: None,
                },
                cwd.path().to_path_buf(),
            )
            .await
            .unwrap();
        let run = gateway
            .start_run(RunStartRequest {
                session_id: "thread-1".into(),
                user_message_id: "user-1".into(),
                prompt: "hello".into(),
            })
            .await
            .unwrap();
        let sender = driver
            .prompt_senders
            .lock()
            .await
            .get(&run.run_id)
            .cloned()
            .unwrap();

        gateway.stop().await.unwrap();

        tokio::time::timeout(Duration::from_secs(1), sender.closed())
            .await
            .expect("driver event stream stayed open after Runtime stop");
    }

    #[tokio::test]
    async fn detach_all_preserves_remote_runs_and_pending_approvals() {
        let (gateway, driver, events, cwd) = harness();
        driver.durable.store(true, Ordering::SeqCst);
        gateway.start().await.unwrap();
        gateway
            .create_session(
                SessionCreateRequest {
                    agent_id: None,
                    session_id: "thread-1".into(),
                    title: None,
                },
                cwd.path().to_path_buf(),
            )
            .await
            .unwrap();
        let run = gateway
            .start_run(RunStartRequest {
                session_id: "thread-1".into(),
                user_message_id: "user-1".into(),
                prompt: "hello".into(),
            })
            .await
            .unwrap();
        driver
            .send(
                &run.run_id,
                DriverEvent::PermissionRequested {
                    run_id: run.run_id.clone(),
                    request: DriverPermissionRequest {
                        request_id: "permission-1".into(),
                        tool_call_id: "tool-1".into(),
                        title: "Run tool".into(),
                        description: "Runtime requests a tool".into(),
                        tool_name: "terminal".into(),
                        input_summary: None,
                        can_allow_once: true,
                        can_deny: true,
                        unsupported_decisions: Vec::new(),
                        allow_once_option_id: Some("allow-once".into()),
                        reject_once_option_id: Some("reject-once".into()),
                    },
                },
            )
            .await;
        tokio::task::yield_now().await;
        let sender = driver
            .prompt_senders
            .lock()
            .await
            .get(&run.run_id)
            .cloned()
            .unwrap();

        gateway.detach_all_sessions().await.unwrap();

        tokio::time::timeout(Duration::from_secs(1), sender.closed())
            .await
            .expect("driver event stream stayed open after detach-all");
        assert_eq!(driver.cancel_calls.load(Ordering::SeqCst), 0);
        assert_eq!(driver.permission_cancel_calls.load(Ordering::SeqCst), 0);
        assert!(!events.events.lock().unwrap().iter().any(|event| {
            event.run_id.as_deref() == Some(&run.run_id) && event.event.is_terminal()
        }));
    }

    #[tokio::test]
    async fn cancel_is_idempotent_and_waits_for_driver_terminal() {
        let (gateway, driver, events, cwd) = harness();
        gateway.start().await.unwrap();
        gateway
            .create_session(
                SessionCreateRequest {
                    agent_id: None,
                    session_id: "thread-1".into(),
                    title: None,
                },
                cwd.path().to_path_buf(),
            )
            .await
            .unwrap();
        let run = gateway
            .start_run(RunStartRequest {
                session_id: "thread-1".into(),
                user_message_id: "user-1".into(),
                prompt: "hello".into(),
            })
            .await
            .unwrap();
        let request = RunCancelRequest {
            session_id: "thread-1".into(),
            run_id: run.run_id.clone(),
        };

        assert_eq!(
            gateway.cancel_run(request.clone()).await.unwrap(),
            CommandAck {
                accepted: true,
                duplicate: false,
            }
        );
        assert_eq!(
            gateway.cancel_run(request).await.unwrap(),
            CommandAck {
                accepted: true,
                duplicate: true,
            }
        );
        assert_eq!(driver.cancel_calls.load(Ordering::SeqCst), 1);
        assert!(
            !events
                .events
                .lock()
                .unwrap()
                .iter()
                .any(|event| event.run_id.as_deref() == Some(&run.run_id)
                    && event.event.is_terminal())
        );

        driver
            .send(
                &run.run_id,
                DriverEvent::Cancelled {
                    run_id: run.run_id.clone(),
                    reason: "user".into(),
                },
            )
            .await;
        tokio::task::yield_now().await;
        assert!(matches!(
            events
                .events
                .lock()
                .unwrap()
                .iter()
                .find(|event| {
                    event.run_id.as_deref() == Some(&run.run_id) && event.event.is_terminal()
                })
                .map(|event| &event.event),
            Some(RuntimeEvent::RunCancelled { .. })
        ));
    }
    #[tokio::test]
    async fn session_history_rejects_changed_target_before_driver() {
        let (gateway, _driver, _events, _cwd) = harness();
        let error = gateway
            .session_history(super::super::SessionHistoryRequest {
                target_id: "another-target".into(),
                session_id: "thread-1".into(),
                operation_id: "op".into(),
                expected_seq: 1,
                action: "delete".into(),
                message_id: "m".into(),
                content: None,
            })
            .await
            .unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::SessionConflict);
    }

    #[tokio::test]
    async fn session_cancel_uses_gateway_active_run_and_is_idempotent() {
        let (gateway, driver, _events, cwd) = harness();
        gateway.start().await.unwrap();
        gateway
            .create_session(
                SessionCreateRequest {
                    agent_id: None,
                    session_id: "thread-1".into(),
                    title: None,
                },
                cwd.path().to_path_buf(),
            )
            .await
            .unwrap();
        let run = gateway
            .start_run(RunStartRequest {
                session_id: "thread-1".into(),
                user_message_id: "user-1".into(),
                prompt: "hello".into(),
            })
            .await
            .unwrap();

        assert_eq!(
            gateway.cancel_session_run("thread-1").await.unwrap(),
            CommandAck {
                accepted: true,
                duplicate: false,
            }
        );
        assert_eq!(
            gateway.cancel_session_run("thread-1").await.unwrap(),
            CommandAck {
                accepted: true,
                duplicate: true,
            }
        );
        assert_eq!(driver.cancel_calls.load(Ordering::SeqCst), 1);

        driver
            .send(
                &run.run_id,
                DriverEvent::Cancelled {
                    run_id: run.run_id.clone(),
                    reason: "user".into(),
                },
            )
            .await;
        tokio::task::yield_now().await;

        assert_eq!(
            gateway.cancel_session_run("thread-1").await.unwrap(),
            CommandAck {
                accepted: true,
                duplicate: true,
            }
        );
        assert_eq!(driver.cancel_calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn concurrent_cancel_waits_for_the_first_driver_call() {
        let (gateway, driver, _events, cwd) = harness();
        gateway.start().await.unwrap();
        gateway
            .create_session(
                SessionCreateRequest {
                    agent_id: None,
                    session_id: "thread-1".into(),
                    title: None,
                },
                cwd.path().to_path_buf(),
            )
            .await
            .unwrap();
        let run = gateway
            .start_run(RunStartRequest {
                session_id: "thread-1".into(),
                user_message_id: "user-1".into(),
                prompt: "hello".into(),
            })
            .await
            .unwrap();
        driver.block_cancel.store(true, Ordering::SeqCst);
        let request = RunCancelRequest {
            session_id: "thread-1".into(),
            run_id: run.run_id,
        };

        let first_gateway = gateway.clone();
        let first_request = request.clone();
        let first = tokio::spawn(async move { first_gateway.cancel_run(first_request).await });
        driver.cancel_started.notified().await;
        let second_gateway = gateway.clone();
        let second = tokio::spawn(async move { second_gateway.cancel_run(request).await });
        tokio::task::yield_now().await;

        assert!(!second.is_finished());
        driver.release_cancel.notify_one();
        assert_eq!(
            first.await.unwrap().unwrap(),
            CommandAck {
                accepted: true,
                duplicate: false,
            }
        );
        assert_eq!(
            second.await.unwrap().unwrap(),
            CommandAck {
                accepted: true,
                duplicate: true,
            }
        );
        assert_eq!(driver.cancel_calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn permission_resolve_is_bound_to_the_run_and_idempotent() {
        let (gateway, driver, events, cwd) = harness();
        gateway.start().await.unwrap();
        gateway
            .create_session(
                SessionCreateRequest {
                    agent_id: None,
                    session_id: "thread-1".into(),
                    title: None,
                },
                cwd.path().to_path_buf(),
            )
            .await
            .unwrap();
        let run = gateway
            .start_run(RunStartRequest {
                session_id: "thread-1".into(),
                user_message_id: "user-1".into(),
                prompt: "hello".into(),
            })
            .await
            .unwrap();
        driver
            .send(
                &run.run_id,
                DriverEvent::PermissionRequested {
                    run_id: run.run_id.clone(),
                    request: DriverPermissionRequest {
                        request_id: "permission-1".into(),
                        tool_call_id: "tool-1".into(),
                        title: "Run tool".into(),
                        description: "Hermes requests a tool".into(),
                        tool_name: "terminal".into(),
                        input_summary: Some(serde_json::json!({"command": "pwd"})),
                        can_allow_once: true,
                        can_deny: true,
                        unsupported_decisions: Vec::new(),
                        allow_once_option_id: Some("allow-once".into()),
                        reject_once_option_id: Some("reject-once".into()),
                    },
                },
            )
            .await;
        tokio::task::yield_now().await;

        let request =
            permission_resolve_request(&gateway, "permission-1", PermissionDecision::AllowOnce)
                .await;
        for stale in [
            PermissionResolveRequest {
                runtime_instance_id: "other-instance".into(),
                ..request.clone()
            },
            PermissionResolveRequest {
                runtime_id: "other-runtime".into(),
                ..request.clone()
            },
            PermissionResolveRequest {
                runtime_epoch: "stale-epoch".into(),
                ..request.clone()
            },
            PermissionResolveRequest {
                session_id: "other-thread".into(),
                ..request.clone()
            },
            PermissionResolveRequest {
                thread_id: "other-thread".into(),
                ..request.clone()
            },
            PermissionResolveRequest {
                run_id: "other-run".into(),
                ..request.clone()
            },
            PermissionResolveRequest {
                tool_call_id: "other-tool".into(),
                ..request.clone()
            },
            PermissionResolveRequest {
                action_set_digest: Some("f".repeat(64)),
                ..request.clone()
            },
        ] {
            assert_eq!(
                gateway.resolve_permission(stale.clone()).await.unwrap(),
                permission_receipt(&stale, PermissionResolveStatus::Stale)
            );
        }
        assert_eq!(driver.permission_calls.load(Ordering::SeqCst), 0);
        gateway
            .state
            .lock()
            .await
            .permissions
            .get_mut("permission-1")
            .unwrap()
            .expires_at = "2020-01-01T00:00:00Z".into();
        assert_eq!(
            gateway.resolve_permission(request.clone()).await.unwrap(),
            permission_receipt(&request, PermissionResolveStatus::Expired)
        );
        gateway
            .state
            .lock()
            .await
            .permissions
            .get_mut("permission-1")
            .unwrap()
            .expires_at = "2099-01-01T00:00:00Z".into();
        assert_eq!(driver.permission_calls.load(Ordering::SeqCst), 0);
        assert_eq!(
            gateway.resolve_permission(request.clone()).await.unwrap(),
            permission_receipt(&request, PermissionResolveStatus::Accepted)
        );
        assert_eq!(
            gateway.resolve_permission(request.clone()).await.unwrap(),
            permission_receipt(&request, PermissionResolveStatus::Duplicate)
        );
        let conflicting = PermissionResolveRequest {
            decision: PermissionDecision::Deny,
            reason: Some(PermissionDenyReason::UserDenied),
            ..request.clone()
        };
        assert_eq!(
            gateway
                .resolve_permission(conflicting.clone())
                .await
                .unwrap(),
            permission_receipt(&conflicting, PermissionResolveStatus::Rejected)
        );
        assert_eq!(driver.permission_calls.load(Ordering::SeqCst), 1);
        driver
            .send(
                &run.run_id,
                DriverEvent::PermissionResolved {
                    run_id: run.run_id.clone(),
                    request_id: "permission-1".into(),
                    decision: PermissionDecision::AllowOnce,
                },
            )
            .await;
        tokio::task::yield_now().await;
        assert_eq!(
            events
                .events
                .lock()
                .unwrap()
                .iter()
                .filter(|event| matches!(
                    event.event,
                    RuntimeEvent::PermissionAudit { ref request_id, .. }
                        if request_id == "permission-1"
                ))
                .count(),
            12
        );
        assert_eq!(
            events
                .events
                .lock()
                .unwrap()
                .iter()
                .filter(|event| matches!(
                    event.event,
                    RuntimeEvent::PermissionResolved { ref request_id, .. }
                        if request_id == "permission-1"
                ))
                .count(),
            1
        );
    }

    #[test]
    fn duplicate_permission_id_fails_the_second_run_without_overwriting_the_first() {
        let mut state = GatewayState {
            runtime_epoch: Some("epoch-1".into()),
            ..GatewayState::default()
        };
        for (run_id, session_id) in [("run-1", "thread-1"), ("run-2", "thread-2")] {
            state.runs.insert(
                run_id.into(),
                RunRecord {
                    session_id: session_id.into(),
                    driver_session_id: format!("driver-{session_id}"),
                    next_sequence: 0,
                    terminal: false,
                    awaiting_driver_terminal: false,
                    cancel_sent: false,
                    detach: None,
                },
            );
            state
                .active_by_session
                .insert(session_id.into(), run_id.into());
        }
        state.permissions.insert(
            "permission-shared".into(),
            PermissionRecord {
                runtime_instance_id: "hermes:epoch-1".into(),
                runtime_id: "hermes".into(),
                runtime_epoch: "epoch-1".into(),
                session_id: "thread-1".into(),
                thread_id: "thread-1".into(),
                run_id: "run-1".into(),
                tool_call_id: "tool-1".into(),
                expires_at: "2099-01-01T00:00:00Z".into(),
                resolved_decision: None,
                can_allow_once: true,
                action_set_digest: None,
            },
        );

        let result = build_run_envelope(
            &state,
            "run-2",
            RuntimeEvent::PermissionRequested {
                request: PermissionRequest {
                    request_id: "permission-shared".into(),
                    tool_call_id: "tool-2".into(),
                    title: "Run tool".into(),
                    description: "Hermes requests a tool".into(),
                    tool_name: "terminal".into(),
                    input_summary: None,
                    can_allow_once: true,
                    can_deny: true,
                    actions: None,
                    action_set_digest: None,
                    has_unsupported_decision: false,
                    expires_at: "2099-01-01T00:00:00Z".into(),
                },
            },
        );
        let RunEnvelopeBuild::Candidate {
            envelope,
            synthesized_terminal,
        } = result
        else {
            panic!("duplicate permission id must synthesize a terminal event")
        };
        assert!(synthesized_terminal);
        assert!(matches!(envelope.event, RuntimeEvent::RunFailed { .. }));

        commit_run_envelope(&mut state, "run-2", &envelope);
        assert_eq!(
            state
                .permissions
                .get("permission-shared")
                .map(|permission| permission.run_id.as_str()),
            Some("run-1")
        );
        assert!(state.runs.get("run-2").is_some_and(|run| run.terminal));
    }

    #[tokio::test]
    async fn unavailable_allow_once_is_rejected_without_consuming_permission() {
        let (gateway, driver, events, cwd) = harness();
        gateway.start().await.unwrap();
        gateway
            .create_session(
                SessionCreateRequest {
                    agent_id: None,
                    session_id: "thread-1".into(),
                    title: None,
                },
                cwd.path().to_path_buf(),
            )
            .await
            .unwrap();
        let run = gateway
            .start_run(RunStartRequest {
                session_id: "thread-1".into(),
                user_message_id: "user-1".into(),
                prompt: "hello".into(),
            })
            .await
            .unwrap();
        driver
            .send(
                &run.run_id,
                DriverEvent::PermissionRequested {
                    run_id: run.run_id.clone(),
                    request: DriverPermissionRequest {
                        request_id: "permission-deny-only".into(),
                        tool_call_id: "tool-1".into(),
                        title: "Run tool".into(),
                        description: "Hermes requests a tool".into(),
                        tool_name: "terminal".into(),
                        input_summary: None,
                        can_allow_once: false,
                        can_deny: true,
                        unsupported_decisions: Vec::new(),
                        allow_once_option_id: None,
                        reject_once_option_id: Some("reject-once".into()),
                    },
                },
            )
            .await;
        tokio::task::yield_now().await;

        let rejected = permission_resolve_request(
            &gateway,
            "permission-deny-only",
            PermissionDecision::AllowOnce,
        )
        .await;
        assert_eq!(
            gateway.resolve_permission(rejected.clone()).await.unwrap(),
            permission_receipt(&rejected, PermissionResolveStatus::Rejected)
        );
        assert_eq!(driver.permission_calls.load(Ordering::SeqCst), 0);
        assert!(!events.events.lock().unwrap().iter().any(|event| matches!(
            event.event,
            RuntimeEvent::PermissionResolved {
                ref request_id,
                decision: PermissionDecision::AllowOnce,
            } if request_id == "permission-deny-only"
        )));

        let deny =
            permission_resolve_request(&gateway, "permission-deny-only", PermissionDecision::Deny)
                .await;
        assert_eq!(
            gateway.resolve_permission(deny.clone()).await.unwrap(),
            permission_receipt(&deny, PermissionResolveStatus::Accepted)
        );
        assert_eq!(driver.permission_calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn concurrent_permission_resolve_waits_for_the_first_driver_call() {
        let (gateway, driver, _events, cwd) = harness();
        gateway.start().await.unwrap();
        gateway
            .create_session(
                SessionCreateRequest {
                    agent_id: None,
                    session_id: "thread-1".into(),
                    title: None,
                },
                cwd.path().to_path_buf(),
            )
            .await
            .unwrap();
        let run = gateway
            .start_run(RunStartRequest {
                session_id: "thread-1".into(),
                user_message_id: "user-1".into(),
                prompt: "hello".into(),
            })
            .await
            .unwrap();
        driver
            .send(
                &run.run_id,
                DriverEvent::PermissionRequested {
                    run_id: run.run_id.clone(),
                    request: DriverPermissionRequest {
                        request_id: "permission-concurrent".into(),
                        tool_call_id: "tool-1".into(),
                        title: "Run tool".into(),
                        description: "Hermes requests a tool".into(),
                        tool_name: "terminal".into(),
                        input_summary: None,
                        can_allow_once: true,
                        can_deny: true,
                        unsupported_decisions: Vec::new(),
                        allow_once_option_id: Some("allow-once".into()),
                        reject_once_option_id: Some("reject-once".into()),
                    },
                },
            )
            .await;
        tokio::task::yield_now().await;
        driver.block_permission.store(true, Ordering::SeqCst);
        let request = permission_resolve_request(
            &gateway,
            "permission-concurrent",
            PermissionDecision::AllowOnce,
        )
        .await;
        let expected = request.clone();

        let first_gateway = gateway.clone();
        let first_request = request.clone();
        let first =
            tokio::spawn(async move { first_gateway.resolve_permission(first_request).await });
        driver.permission_started.notified().await;
        let second_gateway = gateway.clone();
        let second = tokio::spawn(async move { second_gateway.resolve_permission(request).await });
        tokio::task::yield_now().await;

        assert!(!second.is_finished());
        driver.release_permission.notify_one();
        assert_eq!(
            first.await.unwrap().unwrap(),
            permission_receipt(&expected, PermissionResolveStatus::Accepted)
        );
        assert_eq!(
            second.await.unwrap().unwrap(),
            permission_receipt(&expected, PermissionResolveStatus::Duplicate)
        );
        assert_eq!(driver.permission_calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn run_terminal_waits_for_in_flight_permission_resolution() {
        let (gateway, driver, events, cwd) = harness();
        gateway.start().await.unwrap();
        gateway
            .create_session(
                SessionCreateRequest {
                    agent_id: None,
                    session_id: "thread-1".into(),
                    title: None,
                },
                cwd.path().to_path_buf(),
            )
            .await
            .unwrap();
        let run = gateway
            .start_run(RunStartRequest {
                session_id: "thread-1".into(),
                user_message_id: "user-1".into(),
                prompt: "hello".into(),
            })
            .await
            .unwrap();
        driver
            .send(
                &run.run_id,
                DriverEvent::PermissionRequested {
                    run_id: run.run_id.clone(),
                    request: DriverPermissionRequest {
                        request_id: "permission-terminal-race".into(),
                        tool_call_id: "tool-1".into(),
                        title: "Run tool".into(),
                        description: "Hermes requests a tool".into(),
                        tool_name: "terminal".into(),
                        input_summary: None,
                        can_allow_once: true,
                        can_deny: true,
                        unsupported_decisions: Vec::new(),
                        allow_once_option_id: Some("allow-once".into()),
                        reject_once_option_id: Some("reject-once".into()),
                    },
                },
            )
            .await;
        tokio::time::timeout(Duration::from_secs(1), async {
            while !gateway
                .state
                .lock()
                .await
                .permissions
                .contains_key("permission-terminal-race")
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();

        driver.block_permission.store(true, Ordering::SeqCst);
        let resolve_gateway = gateway.clone();
        let resolve = tokio::spawn(async move {
            resolve_gateway
                .resolve_permission(
                    permission_resolve_request(
                        &gateway,
                        "permission-terminal-race",
                        PermissionDecision::AllowOnce,
                    )
                    .await,
                )
                .await
        });
        driver.permission_started.notified().await;
        driver.complete(&run.run_id, "end_turn").await;
        tokio::task::yield_now().await;

        assert!(!events.events.lock().unwrap().iter().any(|event| {
            event.run_id.as_deref() == Some(&run.run_id) && event.event.is_terminal()
        }));

        driver.release_permission.notify_one();
        assert_eq!(
            resolve.await.unwrap().unwrap().status,
            PermissionResolveStatus::Accepted
        );
        tokio::time::timeout(Duration::from_secs(1), async {
            while !events.events.lock().unwrap().iter().any(|event| {
                event.run_id.as_deref() == Some(&run.run_id) && event.event.is_terminal()
            }) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let run_events = events
            .events
            .lock()
            .unwrap()
            .iter()
            .filter(|event| event.run_id.as_deref() == Some(&run.run_id))
            .cloned()
            .collect::<Vec<_>>();
        let resolved_index = run_events
            .iter()
            .position(|event| matches!(event.event, RuntimeEvent::PermissionResolved { .. }))
            .unwrap();
        let terminal_index = run_events
            .iter()
            .position(|event| event.event.is_terminal())
            .unwrap();
        assert!(resolved_index < terminal_index);
    }

    #[tokio::test]
    async fn stop_waits_for_in_flight_permission_resolution() {
        let (gateway, driver, events, cwd) = harness();
        gateway.start().await.unwrap();
        gateway
            .create_session(
                SessionCreateRequest {
                    agent_id: None,
                    session_id: "thread-1".into(),
                    title: None,
                },
                cwd.path().to_path_buf(),
            )
            .await
            .unwrap();
        let run = gateway
            .start_run(RunStartRequest {
                session_id: "thread-1".into(),
                user_message_id: "user-1".into(),
                prompt: "hello".into(),
            })
            .await
            .unwrap();
        driver
            .send(
                &run.run_id,
                DriverEvent::PermissionRequested {
                    run_id: run.run_id.clone(),
                    request: DriverPermissionRequest {
                        request_id: "permission-stop-race".into(),
                        tool_call_id: "tool-1".into(),
                        title: "Run tool".into(),
                        description: "Hermes requests a tool".into(),
                        tool_name: "terminal".into(),
                        input_summary: None,
                        can_allow_once: true,
                        can_deny: true,
                        unsupported_decisions: Vec::new(),
                        allow_once_option_id: Some("allow-once".into()),
                        reject_once_option_id: Some("reject-once".into()),
                    },
                },
            )
            .await;
        tokio::time::timeout(Duration::from_secs(1), async {
            while !gateway
                .state
                .lock()
                .await
                .permissions
                .contains_key("permission-stop-race")
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();

        driver.block_permission.store(true, Ordering::SeqCst);
        let resolve_request = permission_resolve_request(
            &gateway,
            "permission-stop-race",
            PermissionDecision::AllowOnce,
        )
        .await;
        let resolve_gateway = gateway.clone();
        let resolve =
            tokio::spawn(async move { resolve_gateway.resolve_permission(resolve_request).await });
        driver.permission_started.notified().await;
        let stop_gateway = gateway.clone();
        let stop = tokio::spawn(async move { stop_gateway.stop().await });
        tokio::task::yield_now().await;

        assert!(!stop.is_finished());
        assert_eq!(driver.stop_calls.load(Ordering::SeqCst), 0);
        driver.release_permission.notify_one();
        assert_eq!(
            resolve.await.unwrap().unwrap().status,
            PermissionResolveStatus::Accepted
        );
        assert_eq!(
            stop.await.unwrap().unwrap(),
            CommandAck {
                accepted: true,
                duplicate: false,
            }
        );
        let run_events = events
            .events
            .lock()
            .unwrap()
            .iter()
            .filter(|event| event.run_id.as_deref() == Some(&run.run_id))
            .cloned()
            .collect::<Vec<_>>();
        let resolved_index = run_events
            .iter()
            .position(|event| matches!(event.event, RuntimeEvent::PermissionResolved { .. }))
            .unwrap();
        let terminal_index = run_events
            .iter()
            .position(|event| event.event.is_terminal())
            .unwrap();
        assert!(resolved_index < terminal_index);
    }

    #[tokio::test]
    async fn permission_sink_failure_fails_runtime_without_false_duplicate() {
        let driver = Arc::new(FakeDriver::default());
        let sink = Arc::new(FailingEventSink::new(6));
        let gateway = Arc::new(MinimalRuntimeGateway::new(driver.clone(), sink.clone()));
        let cwd = tempfile::tempdir().unwrap();
        gateway.start().await.unwrap();
        gateway
            .create_session(
                SessionCreateRequest {
                    agent_id: None,
                    session_id: "thread-1".into(),
                    title: None,
                },
                cwd.path().to_path_buf(),
            )
            .await
            .unwrap();
        let run = gateway
            .start_run(RunStartRequest {
                session_id: "thread-1".into(),
                user_message_id: "user-1".into(),
                prompt: "hello".into(),
            })
            .await
            .unwrap();
        driver
            .send(
                &run.run_id,
                DriverEvent::PermissionRequested {
                    run_id: run.run_id.clone(),
                    request: DriverPermissionRequest {
                        request_id: "permission-sink".into(),
                        tool_call_id: "tool-1".into(),
                        title: "Run tool".into(),
                        description: "Hermes requests a tool".into(),
                        tool_name: "terminal".into(),
                        input_summary: None,
                        can_allow_once: true,
                        can_deny: true,
                        unsupported_decisions: Vec::new(),
                        allow_once_option_id: Some("allow-once".into()),
                        reject_once_option_id: Some("reject-once".into()),
                    },
                },
            )
            .await;
        tokio::time::timeout(Duration::from_secs(1), async {
            while !sink.events.lock().unwrap().iter().any(|event| {
                matches!(
                    event.event,
                    RuntimeEvent::PermissionRequested { ref request }
                        if request.request_id == "permission-sink"
                )
            }) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();

        gateway
            .resolve_permission(
                permission_resolve_request(
                    &gateway,
                    "permission-sink",
                    PermissionDecision::AllowOnce,
                )
                .await,
            )
            .await
            .unwrap_err();

        assert_eq!(gateway.snapshot().await.status, RuntimeStatus::Failed);
        assert_eq!(driver.stop_calls.load(Ordering::SeqCst), 1);
        let missing =
            permission_resolve_request(&gateway, "permission-sink", PermissionDecision::Deny).await;
        assert_eq!(
            gateway.resolve_permission(missing).await.unwrap().status,
            PermissionResolveStatus::Expired
        );
    }

    #[tokio::test]
    async fn run_terminal_denies_and_removes_pending_permissions() {
        let (gateway, driver, _events, cwd) = harness();
        gateway.start().await.unwrap();
        gateway
            .create_session(
                SessionCreateRequest {
                    agent_id: None,
                    session_id: "thread-1".into(),
                    title: None,
                },
                cwd.path().to_path_buf(),
            )
            .await
            .unwrap();
        let run = gateway
            .start_run(RunStartRequest {
                session_id: "thread-1".into(),
                user_message_id: "user-1".into(),
                prompt: "hello".into(),
            })
            .await
            .unwrap();
        driver
            .send(
                &run.run_id,
                DriverEvent::PermissionRequested {
                    run_id: run.run_id.clone(),
                    request: DriverPermissionRequest {
                        request_id: "permission-pending".into(),
                        tool_call_id: "tool-1".into(),
                        title: "Run tool".into(),
                        description: "Hermes requests a tool".into(),
                        tool_name: "terminal".into(),
                        input_summary: None,
                        can_allow_once: true,
                        can_deny: true,
                        unsupported_decisions: Vec::new(),
                        allow_once_option_id: Some("allow-once".into()),
                        reject_once_option_id: Some("reject-once".into()),
                    },
                },
            )
            .await;
        tokio::task::yield_now().await;
        driver.complete(&run.run_id, "end_turn").await;
        tokio::time::timeout(Duration::from_secs(1), async {
            while driver.permission_calls.load(Ordering::SeqCst) == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("terminal must deny pending permission");

        let receipt = gateway
            .resolve_permission(
                permission_resolve_request(
                    &gateway,
                    "permission-pending",
                    PermissionDecision::AllowOnce,
                )
                .await,
            )
            .await
            .unwrap();
        assert_eq!(receipt.status, PermissionResolveStatus::Expired);
        assert_eq!(driver.permission_calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn stop_abandons_pending_permission_without_selecting_deny() {
        let (gateway, driver, _events, cwd) = harness();
        gateway.start().await.unwrap();
        gateway
            .create_session(
                SessionCreateRequest {
                    agent_id: None,
                    session_id: "thread-1".into(),
                    title: None,
                },
                cwd.path().to_path_buf(),
            )
            .await
            .unwrap();
        let run = gateway
            .start_run(RunStartRequest {
                session_id: "thread-1".into(),
                user_message_id: "user-1".into(),
                prompt: "hello".into(),
            })
            .await
            .unwrap();
        driver
            .send(
                &run.run_id,
                DriverEvent::PermissionRequested {
                    run_id: run.run_id.clone(),
                    request: DriverPermissionRequest {
                        request_id: "permission-stop".into(),
                        tool_call_id: "tool-1".into(),
                        title: "Run tool".into(),
                        description: "Hermes requests a tool".into(),
                        tool_name: "terminal".into(),
                        input_summary: None,
                        can_allow_once: true,
                        can_deny: true,
                        unsupported_decisions: Vec::new(),
                        allow_once_option_id: Some("allow-once".into()),
                        reject_once_option_id: Some("reject-once".into()),
                    },
                },
            )
            .await;
        tokio::task::yield_now().await;

        gateway.stop().await.unwrap();

        assert_eq!(driver.permission_calls.load(Ordering::SeqCst), 0);
        assert_eq!(driver.permission_cancel_calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn oversized_event_becomes_short_terminal_at_the_same_sequence() {
        let (gateway, driver, events, cwd) = harness();
        gateway.start().await.unwrap();
        gateway
            .create_session(
                SessionCreateRequest {
                    agent_id: None,
                    session_id: "thread-1".into(),
                    title: None,
                },
                cwd.path().to_path_buf(),
            )
            .await
            .unwrap();
        let run = gateway
            .start_run(RunStartRequest {
                session_id: "thread-1".into(),
                user_message_id: "user-1".into(),
                prompt: "hello".into(),
            })
            .await
            .unwrap();
        driver
            .send(
                &run.run_id,
                DriverEvent::TextDelta {
                    run_id: run.run_id.clone(),
                    message_id: "assistant-1".into(),
                    delta: "x".repeat(super::super::MAX_EVENT_BYTES),
                },
            )
            .await;
        driver
            .send(
                &run.run_id,
                DriverEvent::TextDelta {
                    run_id: run.run_id.clone(),
                    message_id: "assistant-1".into(),
                    delta: "late".into(),
                },
            )
            .await;
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if events.events.lock().unwrap().iter().any(|event| {
                    event.run_id.as_deref() == Some(&run.run_id) && event.event.is_terminal()
                }) {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();

        let run_events = events
            .events
            .lock()
            .unwrap()
            .iter()
            .filter(|event| event.run_id.as_deref() == Some(&run.run_id))
            .cloned()
            .collect::<Vec<_>>();
        assert_eq!(run_events.len(), 2);
        assert_eq!(run_events[0].sequence, 0);
        assert_eq!(run_events[1].sequence, 1);
        assert!(serde_json::to_vec(&run_events[1]).unwrap().len() <= super::super::MAX_EVENT_BYTES);
        assert!(matches!(
            run_events[1].event,
            RuntimeEvent::RunFailed { ref error }
                if error.code == RuntimeErrorCode::InternalError
        ));
        assert_eq!(driver.cancel_calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn oversized_event_holds_session_until_driver_confirms_cancel() {
        let (gateway, driver, _events, cwd) = harness();
        gateway.start().await.unwrap();
        gateway
            .create_session(
                SessionCreateRequest {
                    agent_id: None,
                    session_id: "thread-1".into(),
                    title: None,
                },
                cwd.path().to_path_buf(),
            )
            .await
            .unwrap();
        let run = gateway
            .start_run(RunStartRequest {
                session_id: "thread-1".into(),
                user_message_id: "user-1".into(),
                prompt: "hello".into(),
            })
            .await
            .unwrap();
        driver
            .send(
                &run.run_id,
                DriverEvent::TextDelta {
                    run_id: run.run_id.clone(),
                    message_id: "assistant-1".into(),
                    delta: "x".repeat(super::super::MAX_EVENT_BYTES),
                },
            )
            .await;
        tokio::time::timeout(Duration::from_secs(1), async {
            while driver.cancel_calls.load(Ordering::SeqCst) == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();

        assert_eq!(
            gateway
                .start_run(RunStartRequest {
                    session_id: "thread-1".into(),
                    user_message_id: "user-2".into(),
                    prompt: "second".into(),
                })
                .await
                .unwrap_err()
                .code,
            RuntimeErrorCode::RunConflict
        );
        driver
            .send(
                &run.run_id,
                DriverEvent::Cancelled {
                    run_id: run.run_id.clone(),
                    reason: "oversized_event".into(),
                },
            )
            .await;
        tokio::task::yield_now().await;
        assert!(gateway
            .start_run(RunStartRequest {
                session_id: "thread-1".into(),
                user_message_id: "user-2".into(),
                prompt: "second".into(),
            })
            .await
            .is_ok());
        assert_eq!(driver.stop_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn oversized_event_cancel_timeout_stops_runtime_without_second_terminal() {
        let (gateway, driver, events, cwd) = harness();
        gateway.start().await.unwrap();
        gateway
            .create_session(
                SessionCreateRequest {
                    agent_id: None,
                    session_id: "thread-1".into(),
                    title: None,
                },
                cwd.path().to_path_buf(),
            )
            .await
            .unwrap();
        let run = gateway
            .start_run(RunStartRequest {
                session_id: "thread-1".into(),
                user_message_id: "user-1".into(),
                prompt: "hello".into(),
            })
            .await
            .unwrap();
        driver
            .send(
                &run.run_id,
                DriverEvent::TextDelta {
                    run_id: run.run_id.clone(),
                    message_id: "assistant-1".into(),
                    delta: "x".repeat(super::super::MAX_EVENT_BYTES),
                },
            )
            .await;

        tokio::time::sleep(CANCEL_TIMEOUT + Duration::from_millis(100)).await;

        assert_eq!(gateway.snapshot().await.status, RuntimeStatus::Failed);
        assert_eq!(driver.stop_calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            events
                .events
                .lock()
                .unwrap()
                .iter()
                .filter(|event| {
                    event.run_id.as_deref() == Some(&run.run_id) && event.event.is_terminal()
                })
                .count(),
            1
        );
        assert_eq!(gateway.start().await.unwrap().status, RuntimeStatus::Ready);
    }

    #[tokio::test]
    async fn oversized_event_stream_close_does_not_confirm_driver_cancel() {
        let (gateway, driver, _events, cwd) = harness();
        gateway.start().await.unwrap();
        gateway
            .create_session(
                SessionCreateRequest {
                    agent_id: None,
                    session_id: "thread-1".into(),
                    title: None,
                },
                cwd.path().to_path_buf(),
            )
            .await
            .unwrap();
        let run = gateway
            .start_run(RunStartRequest {
                session_id: "thread-1".into(),
                user_message_id: "user-1".into(),
                prompt: "hello".into(),
            })
            .await
            .unwrap();
        driver
            .send(
                &run.run_id,
                DriverEvent::TextDelta {
                    run_id: run.run_id.clone(),
                    message_id: "assistant-1".into(),
                    delta: "x".repeat(super::super::MAX_EVENT_BYTES),
                },
            )
            .await;
        tokio::time::timeout(Duration::from_secs(1), async {
            while driver.cancel_calls.load(Ordering::SeqCst) == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        driver.close_stream(&run.run_id).await;

        tokio::time::sleep(CANCEL_TIMEOUT + Duration::from_millis(100)).await;

        assert_eq!(gateway.snapshot().await.status, RuntimeStatus::Failed);
        assert_eq!(driver.stop_calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn late_delta_after_terminal_emits_runtime_warning_without_run_sequence() {
        let (gateway, driver, events, cwd) = harness();
        gateway.start().await.unwrap();
        gateway
            .create_session(
                SessionCreateRequest {
                    agent_id: None,
                    session_id: "thread-1".into(),
                    title: None,
                },
                cwd.path().to_path_buf(),
            )
            .await
            .unwrap();
        let run = gateway
            .start_run(RunStartRequest {
                session_id: "thread-1".into(),
                user_message_id: "user-1".into(),
                prompt: "hello".into(),
            })
            .await
            .unwrap();

        driver.complete(&run.run_id, "end_turn").await;
        tokio::time::timeout(Duration::from_secs(1), async {
            while !events.events.lock().unwrap().iter().any(|event| {
                event.run_id.as_deref() == Some(&run.run_id) && event.event.is_terminal()
            }) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        driver
            .send(
                &run.run_id,
                DriverEvent::TextDelta {
                    run_id: run.run_id.clone(),
                    message_id: "assistant-1".into(),
                    delta: "late".into(),
                },
            )
            .await;
        tokio::time::timeout(Duration::from_secs(1), async {
            while !events.events.lock().unwrap().iter().any(|event| {
                event.session_id == super::super::RUNTIME_SESSION_ID
                    && matches!(
                        event.event,
                        RuntimeEvent::DiagnosticNotice {
                            level: super::super::DiagnosticLevel::Warning,
                            ..
                        }
                    )
            }) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();

        assert_eq!(
            events
                .events
                .lock()
                .unwrap()
                .iter()
                .filter(|event| event.run_id.as_deref() == Some(&run.run_id))
                .map(|event| event.sequence)
                .collect::<Vec<_>>(),
            vec![0, 1]
        );
    }

    #[tokio::test]
    async fn stopped_run_cannot_deliver_a_late_delta_into_the_restarted_epoch() {
        let (gateway, driver, events, cwd) = harness();
        gateway.start().await.unwrap();
        gateway
            .create_session(
                SessionCreateRequest {
                    agent_id: None,
                    session_id: "thread-1".into(),
                    title: None,
                },
                cwd.path().to_path_buf(),
            )
            .await
            .unwrap();
        let run = gateway
            .start_run(RunStartRequest {
                session_id: "thread-1".into(),
                user_message_id: "user-1".into(),
                prompt: "hello".into(),
            })
            .await
            .unwrap();
        let stale_sender = driver
            .prompt_senders
            .lock()
            .await
            .get(&run.run_id)
            .cloned()
            .unwrap();
        gateway.stop().await.unwrap();
        let restarted_epoch = gateway.start().await.unwrap().runtime_epoch.unwrap();

        assert!(stale_sender
            .send(DriverEvent::TextDelta {
                run_id: run.run_id.clone(),
                message_id: "assistant-1".into(),
                delta: "late".into(),
            })
            .is_err());
        assert!(!events.events.lock().unwrap().iter().any(|event| {
            event.runtime_epoch == restarted_epoch
                && event.session_id == super::super::RUNTIME_SESSION_ID
                && matches!(event.event, RuntimeEvent::DiagnosticNotice { .. })
        }));
        assert_eq!(
            events
                .events
                .lock()
                .unwrap()
                .iter()
                .filter(|event| event.run_id.as_deref() == Some(&run.run_id))
                .map(|event| event.sequence)
                .collect::<Vec<_>>(),
            vec![0, 1]
        );
    }

    #[tokio::test]
    async fn gateway_bounds_large_tool_values_independently_of_the_driver() {
        let (gateway, driver, events, cwd) = harness();
        gateway.start().await.unwrap();
        gateway
            .create_session(
                SessionCreateRequest {
                    agent_id: None,
                    session_id: "thread-1".into(),
                    title: None,
                },
                cwd.path().to_path_buf(),
            )
            .await
            .unwrap();
        let run = gateway
            .start_run(RunStartRequest {
                session_id: "thread-1".into(),
                user_message_id: "user-1".into(),
                prompt: "hello".into(),
            })
            .await
            .unwrap();
        driver
            .send(
                &run.run_id,
                DriverEvent::ToolStarted {
                    run_id: run.run_id.clone(),
                    tool_call_id: "tool-1".into(),
                    name: "search".into(),
                    input: Some(serde_json::json!({"query": "界".repeat(30_000)})),
                },
            )
            .await;
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if events.events.lock().unwrap().iter().any(|event| {
                    event.run_id.as_deref() == Some(&run.run_id)
                        && matches!(event.event, RuntimeEvent::ToolStarted { .. })
                }) {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();

        let input = events
            .events
            .lock()
            .unwrap()
            .iter()
            .find_map(|event| match &event.event {
                RuntimeEvent::ToolStarted { input, .. }
                    if event.run_id.as_deref() == Some(&run.run_id) =>
                {
                    input.clone()
                }
                _ => None,
            })
            .unwrap();
        assert_eq!(
            input.get("truncated").and_then(serde_json::Value::as_bool),
            Some(true)
        );
        assert!(serde_json::to_vec(&input).unwrap().len() <= super::super::MAX_TOOL_VALUE_BYTES);
        assert!(input
            .get("preview")
            .and_then(serde_json::Value::as_str)
            .unwrap()
            .is_char_boundary(
                input
                    .get("preview")
                    .and_then(serde_json::Value::as_str)
                    .unwrap()
                    .len()
            ));
    }

    #[tokio::test]
    async fn concurrent_runs_are_isolated_sequenced_and_uniquely_identified() {
        let (gateway, driver, events, cwd) = harness();
        gateway.start().await.unwrap();
        for session_id in ["thread-1", "thread-2"] {
            gateway
                .create_session(
                    SessionCreateRequest {
                        agent_id: None,
                        session_id: session_id.into(),
                        title: None,
                    },
                    cwd.path().to_path_buf(),
                )
                .await
                .unwrap();
        }
        let first = gateway
            .start_run(RunStartRequest {
                session_id: "thread-1".into(),
                user_message_id: "user-1".into(),
                prompt: "first".into(),
            })
            .await
            .unwrap();
        let second = gateway
            .start_run(RunStartRequest {
                session_id: "thread-2".into(),
                user_message_id: "user-2".into(),
                prompt: "second".into(),
            })
            .await
            .unwrap();
        driver
            .send(
                &first.run_id,
                DriverEvent::TextDelta {
                    run_id: first.run_id.clone(),
                    message_id: "assistant-1".into(),
                    delta: "first".into(),
                },
            )
            .await;
        driver
            .send(
                &second.run_id,
                DriverEvent::TextDelta {
                    run_id: second.run_id.clone(),
                    message_id: "assistant-2".into(),
                    delta: "second".into(),
                },
            )
            .await;
        driver.complete(&first.run_id, "end_turn").await;
        driver.complete(&second.run_id, "end_turn").await;
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let terminal_count = events
                    .events
                    .lock()
                    .unwrap()
                    .iter()
                    .filter(|event| event.run_id.is_some() && event.event.is_terminal())
                    .count();
                if terminal_count == 2 {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();

        let recorded = events.events.lock().unwrap();
        for (run, expected_delta) in [(&first, "first"), (&second, "second")] {
            let run_events = recorded
                .iter()
                .filter(|event| event.run_id.as_deref() == Some(&run.run_id))
                .collect::<Vec<_>>();
            assert_eq!(
                run_events
                    .iter()
                    .map(|event| event.sequence)
                    .collect::<Vec<_>>(),
                vec![0, 1, 2]
            );
            assert!(run_events.iter().any(|event| matches!(
                &event.event,
                RuntimeEvent::TextDelta { delta, .. } if delta == expected_delta
            )));
        }
        let event_ids = recorded
            .iter()
            .map(|event| event.event_id.as_str())
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(event_ids.len(), recorded.len());
    }

    #[tokio::test]
    async fn process_exit_fails_runs_clears_sessions_and_allows_new_epoch() {
        let (gateway, driver, events, cwd) = harness();
        let first_epoch = gateway.start().await.unwrap().runtime_epoch.unwrap();
        for session_id in ["thread-1", "thread-2"] {
            gateway
                .create_session(
                    SessionCreateRequest {
                        agent_id: None,
                        session_id: session_id.into(),
                        title: None,
                    },
                    cwd.path().to_path_buf(),
                )
                .await
                .unwrap();
            gateway
                .start_run(RunStartRequest {
                    session_id: session_id.into(),
                    user_message_id: format!("user-{session_id}"),
                    prompt: "hello".into(),
                })
                .await
                .unwrap();
        }
        driver
            .process_exit(RuntimeError::new(
                RuntimeErrorCode::ProcessExited,
                "Hermes exited",
            ))
            .await;
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let recorded = events.events.lock().unwrap();
                let failed_runs = recorded
                    .iter()
                    .filter(|event| {
                        matches!(
                            event.event,
                            RuntimeEvent::RunFailed { ref error }
                                if error.code == RuntimeErrorCode::ProcessExited
                        )
                    })
                    .count();
                let runtime_failed = recorded.iter().any(|event| {
                    matches!(
                        event.event,
                        RuntimeEvent::RuntimeStatusChanged {
                            status: RuntimeStatus::Failed,
                            ..
                        }
                    )
                });
                if failed_runs == 2 && runtime_failed {
                    break;
                }
                drop(recorded);
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();

        assert_eq!(gateway.snapshot().await.status, RuntimeStatus::Failed);
        assert!(gateway.state.lock().await.runs.is_empty());
        assert!(gateway
            .create_session(
                SessionCreateRequest {
                    agent_id: None,
                    session_id: "thread-1".into(),
                    title: None,
                },
                cwd.path().to_path_buf(),
            )
            .await
            .is_err());
        let second_epoch = gateway.start().await.unwrap().runtime_epoch.unwrap();
        assert_ne!(first_epoch, second_epoch);
    }

    #[tokio::test]
    async fn process_exit_retries_failed_terminal_emit_before_committing_run() {
        let driver = Arc::new(FakeDriver::default());
        let sink = Arc::new(FailingEventSink::new(5));
        let gateway = Arc::new(MinimalRuntimeGateway::new(driver.clone(), sink.clone()));
        let cwd = tempfile::tempdir().unwrap();
        gateway.start().await.unwrap();
        gateway
            .create_session(
                SessionCreateRequest {
                    agent_id: None,
                    session_id: "thread-1".into(),
                    title: None,
                },
                cwd.path().to_path_buf(),
            )
            .await
            .unwrap();
        let run = gateway
            .start_run(RunStartRequest {
                session_id: "thread-1".into(),
                user_message_id: "user-1".into(),
                prompt: "hello".into(),
            })
            .await
            .unwrap();

        driver
            .process_exit(RuntimeError::new(
                RuntimeErrorCode::ProcessExited,
                "Hermes exited",
            ))
            .await;
        tokio::time::timeout(Duration::from_secs(1), async {
            while gateway.snapshot().await.status != RuntimeStatus::Failed {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();

        let terminals = sink
            .events
            .lock()
            .unwrap()
            .iter()
            .filter(|event| {
                event.run_id.as_deref() == Some(&run.run_id) && event.event.is_terminal()
            })
            .cloned()
            .collect::<Vec<_>>();
        assert_eq!(terminals.len(), 1);
        assert_eq!(terminals[0].sequence, 1);
        assert_eq!(driver.stop_calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn process_exit_preserves_unpublished_run_until_next_epoch_reset() {
        let driver = Arc::new(FakeDriver::default());
        let sink = Arc::new(RejectingRunTerminalSink::default());
        let gateway = Arc::new(MinimalRuntimeGateway::new(driver.clone(), sink.clone()));
        let cwd = tempfile::tempdir().unwrap();
        let first_epoch = gateway.start().await.unwrap().runtime_epoch.unwrap();
        gateway
            .create_session(
                SessionCreateRequest {
                    agent_id: None,
                    session_id: "thread-1".into(),
                    title: None,
                },
                cwd.path().to_path_buf(),
            )
            .await
            .unwrap();
        let run = gateway
            .start_run(RunStartRequest {
                session_id: "thread-1".into(),
                user_message_id: "user-1".into(),
                prompt: "hello".into(),
            })
            .await
            .unwrap();
        driver
            .send(
                &run.run_id,
                DriverEvent::PermissionRequested {
                    run_id: run.run_id.clone(),
                    request: DriverPermissionRequest {
                        request_id: "permission-process-exit".into(),
                        tool_call_id: "tool-1".into(),
                        title: "Run tool".into(),
                        description: "Hermes requests a tool".into(),
                        tool_name: "terminal".into(),
                        input_summary: None,
                        can_allow_once: true,
                        can_deny: true,
                        unsupported_decisions: Vec::new(),
                        allow_once_option_id: Some("allow-once".into()),
                        reject_once_option_id: Some("reject-once".into()),
                    },
                },
            )
            .await;
        tokio::time::timeout(Duration::from_secs(1), async {
            while !gateway
                .state
                .lock()
                .await
                .permissions
                .contains_key("permission-process-exit")
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();

        driver
            .process_exit(RuntimeError::new(
                RuntimeErrorCode::ProcessExited,
                "Hermes exited",
            ))
            .await;
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let state = gateway.state.lock().await;
                if state.status == RuntimeStatus::Failed
                    && !state.cleanup_pending
                    && driver.stop_calls.load(Ordering::SeqCst) == 1
                {
                    break;
                }
                drop(state);
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();

        {
            let state = gateway.state.lock().await;
            assert!(!state.runs.get(&run.run_id).unwrap().terminal);
            assert_eq!(state.active_by_session.get("thread-1"), Some(&run.run_id));
            assert!(state.permissions.contains_key("permission-process-exit"));
        }
        assert!(!sink.events.lock().unwrap().iter().any(|event| {
            event.run_id.as_deref() == Some(&run.run_id) && event.event.is_terminal()
        }));
        assert_eq!(sink.terminal_calls.load(Ordering::SeqCst), 2);

        let second_epoch = gateway.start().await.unwrap().runtime_epoch.unwrap();
        assert_ne!(first_epoch, second_epoch);
        let state = gateway.state.lock().await;
        assert!(state.runs.is_empty());
        assert!(state.active_by_session.is_empty());
        assert!(state.permissions.is_empty());
    }

    #[tokio::test]
    async fn stale_process_exit_does_not_fail_a_new_runtime_epoch() {
        let (gateway, driver, events, _cwd) = harness();
        let first_epoch = gateway.start().await.unwrap().runtime_epoch.unwrap();
        gateway.stop().await.unwrap();
        let second_epoch = gateway.start().await.unwrap().runtime_epoch.unwrap();
        assert_ne!(first_epoch, second_epoch);

        driver
            .process_exit_at(
                0,
                RuntimeError::new(RuntimeErrorCode::ProcessExited, "old Hermes exited"),
            )
            .await;
        tokio::time::sleep(Duration::from_millis(20)).await;

        assert_eq!(gateway.snapshot().await.status, RuntimeStatus::Ready);
        assert!(!events.events.lock().unwrap().iter().any(|event| {
            event.runtime_epoch == second_epoch
                && matches!(
                    event.event,
                    RuntimeEvent::RuntimeStatusChanged {
                        status: RuntimeStatus::Failed,
                        ..
                    }
                )
        }));
    }

    #[tokio::test]
    async fn session_cwd_must_be_canonical_and_absolute() {
        let (gateway, driver, _events, cwd) = harness();
        gateway.start().await.unwrap();
        std::fs::create_dir(cwd.path().join("child")).unwrap();
        let error = gateway
            .create_session(
                SessionCreateRequest {
                    agent_id: None,
                    session_id: "thread-1".into(),
                    title: None,
                },
                cwd.path().join("child").join(".."),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::SessionCreateFailed);
        assert_eq!(driver.session_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn event_stream_close_without_terminal_fails_the_run() {
        let (gateway, driver, events, cwd) = harness();
        gateway.start().await.unwrap();
        gateway
            .create_session(
                SessionCreateRequest {
                    agent_id: None,
                    session_id: "thread-1".into(),
                    title: None,
                },
                cwd.path().to_path_buf(),
            )
            .await
            .unwrap();
        let run = gateway
            .start_run(RunStartRequest {
                session_id: "thread-1".into(),
                user_message_id: "user-1".into(),
                prompt: "hello".into(),
            })
            .await
            .unwrap();
        driver.close_stream(&run.run_id).await;
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if events.events.lock().unwrap().iter().any(|event| {
                    matches!(
                        event.event,
                        RuntimeEvent::RunFailed { ref error }
                            if event.run_id.as_deref() == Some(&run.run_id)
                                && error.code == RuntimeErrorCode::RunFailed
                    )
                }) {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn cancel_timeout_fails_once_and_stops_the_driver() {
        let (gateway, driver, events, cwd) = harness();
        gateway.start().await.unwrap();
        gateway
            .create_session(
                SessionCreateRequest {
                    agent_id: None,
                    session_id: "thread-1".into(),
                    title: None,
                },
                cwd.path().to_path_buf(),
            )
            .await
            .unwrap();
        let run = gateway
            .start_run(RunStartRequest {
                session_id: "thread-1".into(),
                user_message_id: "user-1".into(),
                prompt: "hello".into(),
            })
            .await
            .unwrap();
        driver
            .send(
                &run.run_id,
                DriverEvent::PermissionRequested {
                    run_id: run.run_id.clone(),
                    request: DriverPermissionRequest {
                        request_id: "permission-cancel-timeout".into(),
                        tool_call_id: "tool-1".into(),
                        title: "Run tool".into(),
                        description: "Hermes requests a tool".into(),
                        tool_name: "terminal".into(),
                        input_summary: None,
                        can_allow_once: true,
                        can_deny: true,
                        unsupported_decisions: Vec::new(),
                        allow_once_option_id: Some("allow-once".into()),
                        reject_once_option_id: Some("reject-once".into()),
                    },
                },
            )
            .await;
        tokio::task::yield_now().await;
        gateway
            .cancel_run(RunCancelRequest {
                session_id: "thread-1".into(),
                run_id: run.run_id.clone(),
            })
            .await
            .unwrap();
        tokio::time::sleep(CANCEL_TIMEOUT + Duration::from_millis(100)).await;

        assert_eq!(driver.stop_calls.load(Ordering::SeqCst), 1);
        assert_eq!(driver.permission_calls.load(Ordering::SeqCst), 1);
        assert_eq!(gateway.snapshot().await.status, RuntimeStatus::Failed);
        let permission_receipt = gateway
            .resolve_permission(
                permission_resolve_request(
                    &gateway,
                    "permission-cancel-timeout",
                    PermissionDecision::AllowOnce,
                )
                .await,
            )
            .await
            .unwrap();
        assert_eq!(permission_receipt.status, PermissionResolveStatus::Expired);
        let terminal_events = events
            .events
            .lock()
            .unwrap()
            .iter()
            .filter(|event| {
                event.run_id.as_deref() == Some(&run.run_id) && event.event.is_terminal()
            })
            .cloned()
            .collect::<Vec<_>>();
        assert_eq!(terminal_events.len(), 1);
        assert!(matches!(
            terminal_events[0].event,
            RuntimeEvent::RunFailed { ref error }
                if error.code == RuntimeErrorCode::CancelTimeout
        ));

        driver
            .send(
                &run.run_id,
                DriverEvent::Cancelled {
                    run_id: run.run_id.clone(),
                    reason: "late".into(),
                },
            )
            .await;
        tokio::task::yield_now().await;
        assert_eq!(
            events
                .events
                .lock()
                .unwrap()
                .iter()
                .filter(|event| {
                    event.run_id.as_deref() == Some(&run.run_id) && event.event.is_terminal()
                })
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn restart_waits_for_cancel_timeout_driver_cleanup() {
        let (gateway, driver, _events, cwd) = harness();
        gateway.start().await.unwrap();
        gateway
            .create_session(
                SessionCreateRequest {
                    agent_id: None,
                    session_id: "thread-1".into(),
                    title: None,
                },
                cwd.path().to_path_buf(),
            )
            .await
            .unwrap();
        let run = gateway
            .start_run(RunStartRequest {
                session_id: "thread-1".into(),
                user_message_id: "user-1".into(),
                prompt: "hello".into(),
            })
            .await
            .unwrap();
        driver.block_stop.store(true, Ordering::SeqCst);
        gateway
            .cancel_run(RunCancelRequest {
                session_id: "thread-1".into(),
                run_id: run.run_id,
            })
            .await
            .unwrap();
        driver.stop_started.notified().await;

        let restart_gateway = gateway.clone();
        let restart = tokio::spawn(async move { restart_gateway.start().await });
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(!restart.is_finished());
        assert_eq!(driver.start_calls.load(Ordering::SeqCst), 1);

        driver.release_stop.notify_one();
        let restarted = restart.await.unwrap().unwrap();
        assert_eq!(restarted.status, RuntimeStatus::Ready);
        assert_eq!(driver.start_calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn cancel_timeout_terminates_all_active_runs_before_stopping_driver() {
        let (gateway, driver, events, cwd) = harness();
        gateway.start().await.unwrap();
        for session_id in ["thread-1", "thread-2"] {
            gateway
                .create_session(
                    SessionCreateRequest {
                        agent_id: None,
                        session_id: session_id.into(),
                        title: None,
                    },
                    cwd.path().to_path_buf(),
                )
                .await
                .unwrap();
        }
        let first = gateway
            .start_run(RunStartRequest {
                session_id: "thread-1".into(),
                user_message_id: "user-1".into(),
                prompt: "first".into(),
            })
            .await
            .unwrap();
        let second = gateway
            .start_run(RunStartRequest {
                session_id: "thread-2".into(),
                user_message_id: "user-2".into(),
                prompt: "second".into(),
            })
            .await
            .unwrap();

        gateway
            .cancel_run(RunCancelRequest {
                session_id: "thread-1".into(),
                run_id: first.run_id.clone(),
            })
            .await
            .unwrap();
        tokio::time::sleep(CANCEL_TIMEOUT + Duration::from_millis(100)).await;

        assert_eq!(gateway.snapshot().await.status, RuntimeStatus::Failed);
        assert_eq!(driver.stop_calls.load(Ordering::SeqCst), 1);
        for run_id in [&first.run_id, &second.run_id] {
            let terminal_events = events
                .events
                .lock()
                .unwrap()
                .iter()
                .filter(|event| {
                    event.run_id.as_deref() == Some(run_id) && event.event.is_terminal()
                })
                .cloned()
                .collect::<Vec<_>>();
            assert_eq!(terminal_events.len(), 1);
        }
        let first_terminal = events
            .events
            .lock()
            .unwrap()
            .iter()
            .find(|event| {
                event.run_id.as_deref() == Some(&first.run_id) && event.event.is_terminal()
            })
            .cloned()
            .unwrap();
        assert!(matches!(
            first_terminal.event,
            RuntimeEvent::RunFailed { ref error }
                if error.code == RuntimeErrorCode::CancelTimeout
        ));
        let second_terminal = events
            .events
            .lock()
            .unwrap()
            .iter()
            .find(|event| {
                event.run_id.as_deref() == Some(&second.run_id) && event.event.is_terminal()
            })
            .cloned()
            .unwrap();
        assert!(matches!(
            second_terminal.event,
            RuntimeEvent::RunFailed { ref error }
                if error.code == RuntimeErrorCode::ProcessExited
        ));
    }

    #[tokio::test]
    async fn expired_permission_is_diagnostic_and_does_not_block_run_terminal() {
        let (gateway, driver, events, cwd) = harness();
        gateway.start().await.unwrap();
        gateway
            .create_session(
                SessionCreateRequest {
                    agent_id: None,
                    session_id: "thread-1".into(),
                    title: None,
                },
                cwd.path().to_path_buf(),
            )
            .await
            .unwrap();
        let run = gateway
            .start_run(RunStartRequest {
                session_id: "thread-1".into(),
                user_message_id: "user-1".into(),
                prompt: "hello".into(),
            })
            .await
            .unwrap();
        driver
            .send(
                &run.run_id,
                DriverEvent::PermissionRequested {
                    run_id: run.run_id.clone(),
                    request: DriverPermissionRequest {
                        request_id: "permission-expired".into(),
                        tool_call_id: "tool-1".into(),
                        title: "Run tool".into(),
                        description: "Hermes requests a tool".into(),
                        tool_name: "terminal".into(),
                        input_summary: None,
                        can_allow_once: true,
                        can_deny: true,
                        unsupported_decisions: Vec::new(),
                        allow_once_option_id: Some("allow-once".into()),
                        reject_once_option_id: Some("reject-once".into()),
                    },
                },
            )
            .await;
        tokio::task::yield_now().await;
        *driver.permission_error.lock().await = Some(RuntimeError::new(
            RuntimeErrorCode::PermissionExpired,
            "expired",
        ));
        let receipt = gateway
            .resolve_permission(
                permission_resolve_request(
                    &gateway,
                    "permission-expired",
                    PermissionDecision::AllowOnce,
                )
                .await,
            )
            .await
            .unwrap();
        assert_eq!(receipt.status, PermissionResolveStatus::Expired);
        assert!(events.events.lock().unwrap().iter().any(|event| matches!(
            event.event,
            RuntimeEvent::PermissionResolved {
                ref request_id,
                decision: PermissionDecision::Deny,
            } if request_id == "permission-expired"
        )));
        driver.complete(&run.run_id, "end_turn").await;
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let recorded = events.events.lock().unwrap();
                let diagnostic = recorded.iter().any(|event| {
                    matches!(
                        event.event,
                        RuntimeEvent::DiagnosticNotice { .. }
                            if event.run_id.as_deref() == Some(&run.run_id)
                    )
                });
                let terminal = recorded.iter().any(|event| {
                    event.run_id.as_deref() == Some(&run.run_id) && event.event.is_terminal()
                });
                if diagnostic && terminal {
                    break;
                }
                drop(recorded);
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn driver_permission_timeout_denies_and_closes_the_pending_request() {
        let (gateway, driver, events, cwd) = harness();
        gateway.start().await.unwrap();
        gateway
            .create_session(
                SessionCreateRequest {
                    agent_id: None,
                    session_id: "thread-1".into(),
                    title: None,
                },
                cwd.path().to_path_buf(),
            )
            .await
            .unwrap();
        let run = gateway
            .start_run(RunStartRequest {
                session_id: "thread-1".into(),
                user_message_id: "user-1".into(),
                prompt: "hello".into(),
            })
            .await
            .unwrap();
        driver
            .send(
                &run.run_id,
                DriverEvent::PermissionRequested {
                    run_id: run.run_id.clone(),
                    request: DriverPermissionRequest {
                        request_id: "permission-timeout".into(),
                        tool_call_id: "tool-1".into(),
                        title: "Run tool".into(),
                        description: "Hermes requests a tool".into(),
                        tool_name: "terminal".into(),
                        input_summary: None,
                        can_allow_once: true,
                        can_deny: true,
                        unsupported_decisions: Vec::new(),
                        allow_once_option_id: Some("allow-once".into()),
                        reject_once_option_id: Some("reject-once".into()),
                    },
                },
            )
            .await;
        tokio::task::yield_now().await;
        driver
            .send(
                &run.run_id,
                DriverEvent::PermissionExpired {
                    run_id: run.run_id.clone(),
                    request_id: "permission-timeout".into(),
                },
            )
            .await;

        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let recorded = events.events.lock().unwrap();
                let resolved = recorded.iter().any(|event| {
                    matches!(
                        event.event,
                        RuntimeEvent::PermissionResolved {
                            ref request_id,
                            decision: PermissionDecision::Deny,
                        } if request_id == "permission-timeout"
                    )
                });
                let warning = recorded.iter().any(|event| {
                    matches!(
                        event.event,
                        RuntimeEvent::DiagnosticNotice {
                            level: super::super::DiagnosticLevel::Warning,
                            ..
                        }
                    ) && event.run_id.as_deref() == Some(&run.run_id)
                });
                if resolved && warning {
                    break;
                }
                drop(recorded);
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let expired = permission_resolve_request(
            &gateway,
            "permission-timeout",
            PermissionDecision::AllowOnce,
        )
        .await;
        assert_eq!(
            gateway.resolve_permission(expired).await.unwrap().status,
            PermissionResolveStatus::Expired
        );
        driver.complete(&run.run_id, "end_turn").await;
    }

    #[tokio::test]
    async fn oversized_runtime_error_is_replaced_by_a_short_diagnostic() {
        let (gateway, driver, events, _cwd) = harness();
        *driver.check_error.lock().await = Some(RuntimeError::new(
            RuntimeErrorCode::HermesCheckFailed,
            "x".repeat(super::super::MAX_EVENT_BYTES),
        ));

        let error = gateway.start().await.unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::HermesCheckFailed);
        assert_eq!(gateway.snapshot().await.status, RuntimeStatus::Failed);
        let recorded = events.events.lock().unwrap();
        assert!(
            recorded
                .iter()
                .all(|event| serde_json::to_vec(event).unwrap().len()
                    <= super::super::MAX_EVENT_BYTES)
        );
        assert!(matches!(
            recorded.last().map(|event| &event.event),
            Some(RuntimeEvent::DiagnosticNotice {
                level: super::super::DiagnosticLevel::Warning,
                ..
            })
        ));
    }

    #[tokio::test]
    async fn oversized_run_started_fails_without_calling_driver_prompt() {
        let (gateway, driver, events, cwd) = harness();
        gateway.start().await.unwrap();
        gateway
            .create_session(
                SessionCreateRequest {
                    agent_id: None,
                    session_id: "thread-1".into(),
                    title: None,
                },
                cwd.path().to_path_buf(),
            )
            .await
            .unwrap();

        let error = gateway
            .start_run(RunStartRequest {
                session_id: "thread-1".into(),
                user_message_id: "x".repeat(super::super::MAX_EVENT_BYTES),
                prompt: "hello".into(),
            })
            .await
            .unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::InternalError);
        assert_eq!(driver.prompt_calls.load(Ordering::SeqCst), 0);
        assert!(events.events.lock().unwrap().iter().any(|event| matches!(
            event.event,
            RuntimeEvent::RunFailed { ref error }
                if error.code == RuntimeErrorCode::InternalError
        )));
    }

    #[tokio::test]
    async fn prompt_failure_emits_terminal_and_releases_session_occupancy() {
        let (gateway, driver, events, cwd) = harness();
        gateway.start().await.unwrap();
        gateway
            .create_session(
                SessionCreateRequest {
                    agent_id: None,
                    session_id: "thread-1".into(),
                    title: None,
                },
                cwd.path().to_path_buf(),
            )
            .await
            .unwrap();
        *driver.prompt_error.lock().await = Some(RuntimeError::new(
            RuntimeErrorCode::RunFailed,
            "prompt failed",
        ));

        let error = gateway
            .start_run(RunStartRequest {
                session_id: "thread-1".into(),
                user_message_id: "user-1".into(),
                prompt: "first".into(),
            })
            .await
            .unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::RunFailed);
        let failed_run_id = events
            .events
            .lock()
            .unwrap()
            .iter()
            .find_map(|event| match event.event {
                RuntimeEvent::RunFailed { .. } => event.run_id.clone(),
                _ => None,
            })
            .unwrap();
        assert_eq!(
            events
                .events
                .lock()
                .unwrap()
                .iter()
                .filter(|event| event.run_id.as_deref() == Some(&failed_run_id))
                .map(|event| event.sequence)
                .collect::<Vec<_>>(),
            vec![0, 1]
        );

        *driver.prompt_error.lock().await = None;
        assert!(gateway
            .start_run(RunStartRequest {
                session_id: "thread-1".into(),
                user_message_id: "user-2".into(),
                prompt: "second".into(),
            })
            .await
            .is_ok());
    }
}
