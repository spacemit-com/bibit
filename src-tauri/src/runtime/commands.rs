use super::{
    controller::ControllerLeaseManager, gateway::RuntimeEventSink, manager::RuntimeManager,
    registry::RuntimeDescriptor, CommandAck, PermissionDecisionReceipt, PermissionResolveRequest,
    RunCancelRequest, RunStartRequest, RunStartResult, RuntimeCapabilities, RuntimeError,
    RuntimeErrorCode, RuntimeEventEnvelope, RuntimeMessage, RuntimeSession, RuntimeSnapshot,
    SessionCreateRequest, SessionCreateResult, MAX_EVENT_BYTES,
};
use crate::core::app::commands::get_jan_data_folder_path;
use crate::feature_file_grants::{
    FeatureFileGrantService, FileGrantDirection, FileGrantError, FileGrantOwner, PublicFileGrant,
};
use crate::status_popup::conversation::{ConversationCoordinator, CONVERSATION_EVENT};
use rfd::AsyncFileDialog;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, Runtime, State, WebviewWindow};

pub use super::cwd::resolve_runtime_cwd;

pub const RUNTIME_EVENT_NAME: &str = "runtime-event";
const RUNTIME_ATTACHMENT_SERVICE_ID: &str = "runtime";
const RUNTIME_ATTACHMENT_OPERATION_ID: &str = "session.attachment.upload.v1";
const RUNTIME_ATTACHMENT_MAX_BYTES: u64 = 25 * 1024 * 1024;

fn ensure_controller_held(controller: &ControllerLeaseManager) -> Result<(), RuntimeError> {
    controller.ensure_held()
}

/// 用户在窗口里直接操作 Runtime 的动作面：审批决定与会话附件都由这里发起。
/// 主窗口和语音浮窗都是用户亲自操作的独立输入面（浮窗有自己的会话、能建 Run、能取消 Run）；
/// 其他窗口面（如只读的快速弹窗）不接受。
fn ensure_interactive_window_surface(label: &str) -> Result<(), RuntimeError> {
    if matches!(label, "main" | "voice-overlay") {
        Ok(())
    } else {
        Err(RuntimeError::new(
            RuntimeErrorCode::InternalError,
            "Runtime actions are only accepted from the main window or the voice overlay",
        ))
    }
}

fn runtime_attachment_owner(label: &str, target_id: &str, session_id: &str) -> FileGrantOwner {
    FileGrantOwner {
        feature_id: "runtime".into(),
        feature_instance_id: format!("{label}:{target_id}:{session_id}"),
    }
}

fn runtime_attachment_grant_error(error: FileGrantError) -> RuntimeError {
    let (code, message) = match error {
        FileGrantError::FileSizeLimit => (
            RuntimeErrorCode::RunFailed,
            "附件必须是 1 byte 到 25 MiB 的普通文件",
        ),
        FileGrantError::Unauthorized | FileGrantError::GrantMismatch => {
            (RuntimeErrorCode::SecurityDenied, "附件授权与当前会话不匹配")
        }
        FileGrantError::NotFound | FileGrantError::Expired | FileGrantError::AlreadyConsumed => (
            RuntimeErrorCode::SessionConflict,
            "附件授权已失效，请重新选择文件",
        ),
        FileGrantError::InvalidSelection | FileGrantError::InvalidRequest => (
            RuntimeErrorCode::RunFailed,
            "所选附件已变更或不可读取，请重新选择文件",
        ),
        FileGrantError::ActiveGrantLimit => (
            RuntimeErrorCode::RunFailed,
            "待上传附件过多，请完成或移除现有附件后重试",
        ),
        FileGrantError::StagingBytesLimit | FileGrantError::IntegrityMismatch => (
            RuntimeErrorCode::RunFailed,
            "附件暂存校验失败，请重新选择文件",
        ),
        FileGrantError::StorageUnavailable => {
            (RuntimeErrorCode::InternalError, "附件暂存目录不可用")
        }
    };
    RuntimeError::new(code, message)
}

pub struct TauriRuntimeEventSink<R: Runtime = tauri::Wry> {
    app: AppHandle<R>,
}

impl<R: Runtime> TauriRuntimeEventSink<R> {
    pub fn new(app: AppHandle<R>) -> Self {
        Self { app }
    }
}

impl<R: Runtime> RuntimeEventSink for TauriRuntimeEventSink<R> {
    fn emit_session(&self, event: &super::SessionFeedEvent) -> Result<(), RuntimeError> {
        if event.events.iter().any(|item| {
            matches!(
                item["type"].as_str(),
                Some("user/message" | "agent/inbox/spliced")
            )
        }) {
            if let Err(error) = super::session_pending::confirm_events(
                &get_jan_data_folder_path(self.app.clone()).join("runtime/session-pending"),
                &event.target_id,
                &event.session_id,
                &event.events,
            ) {
                log::warn!("已接收输入的本地记录清理失败: {}", error.code.code_as_str());
            }
        }
        self.app
            .emit("runtime-session-event", event)
            .map_err(|e| RuntimeError::new(RuntimeErrorCode::InternalError, e.to_string()))
    }

    fn emit(&self, event: &RuntimeEventEnvelope) -> Result<(), RuntimeError> {
        validate_event_size(event)?;
        self.app
            .emit_to("main", RUNTIME_EVENT_NAME, event)
            .map_err(|_| {
                RuntimeError::new(
                    RuntimeErrorCode::InternalError,
                    "Failed to emit runtime event",
                )
            })?;

        let terminal = match &event.event {
            super::RuntimeEvent::RunCompleted { .. } => Some("completed"),
            super::RuntimeEvent::RunCancelled { .. } => Some("cancelled"),
            super::RuntimeEvent::RunFailed { .. } => Some("failed"),
            _ => None,
        };
        if let Some(status) = terminal {
            log::info!(
                "Runtime terminal: runtime={} session={} run={} status={}",
                event.runtime_id,
                event.session_id,
                event.run_id.as_deref().unwrap_or(""),
                status
            );
        }

        if event.session_id != crate::runtime::RUNTIME_SESSION_ID {
            let coordinator = self.app.state::<ConversationCoordinator>();
            if let Some(conversation_event) =
                coordinator.apply_runtime_envelope("runtime", conversation_projection(event))
            {
                if self
                    .app
                    .emit(CONVERSATION_EVENT, &conversation_event)
                    .is_err()
                {
                    log::warn!("Failed to emit conversation runtime projection");
                }
            }
        }
        Ok(())
    }
}

fn conversation_projection(event: &RuntimeEventEnvelope) -> RuntimeEventEnvelope {
    let mut projected = event.clone();
    if let super::RuntimeEvent::PermissionRequested { request } = &mut projected.event {
        request.input_summary = None;
    }
    projected
}

pub fn validate_event_size(event: &RuntimeEventEnvelope) -> Result<(), RuntimeError> {
    let serialized = serde_json::to_vec(event).map_err(|_| {
        RuntimeError::new(
            RuntimeErrorCode::InternalError,
            "Runtime event could not be serialized",
        )
    })?;
    if serialized.len() > MAX_EVENT_BYTES {
        return Err(RuntimeError::new(
            RuntimeErrorCode::InternalError,
            "Runtime event exceeds the size limit",
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn runtime_start(
    manager: State<'_, Arc<RuntimeManager>>,
) -> Result<RuntimeSnapshot, RuntimeError> {
    let gateway = manager.active_gateway().await?;
    gateway.start().await
}

#[tauri::command]
pub async fn runtime_stop(
    manager: State<'_, Arc<RuntimeManager>>,
    controller: State<'_, ControllerLeaseManager>,
) -> Result<CommandAck, RuntimeError> {
    ensure_controller_held(&controller)?;
    let gateway = manager.active_gateway().await?;
    gateway.stop().await
}

#[tauri::command]
pub async fn runtime_controller_acquire(
    window: WebviewWindow,
    app: AppHandle,
    controller: State<'_, ControllerLeaseManager>,
) -> Result<CommandAck, RuntimeError> {
    let acquired = controller.acquire_for(&get_jan_data_folder_path(app), window.label())?;
    Ok(CommandAck {
        accepted: true,
        duplicate: !acquired,
    })
}

#[tauri::command]
pub async fn runtime_controller_release(
    window: WebviewWindow,
    controller: State<'_, ControllerLeaseManager>,
) -> Result<CommandAck, RuntimeError> {
    let released = controller.release_for(window.label())?;
    Ok(CommandAck {
        accepted: true,
        duplicate: !released,
    })
}

#[tauri::command]
pub async fn runtime_controller_status(
    controller: State<'_, ControllerLeaseManager>,
) -> Result<bool, RuntimeError> {
    Ok(controller.is_held())
}

#[tauri::command]
pub async fn runtime_capabilities(
    manager: State<'_, Arc<RuntimeManager>>,
) -> Result<RuntimeCapabilities, RuntimeError> {
    let gateway = manager.active_gateway().await?;
    Ok(gateway.capabilities())
}

#[tauri::command]
pub async fn runtime_sessions_list(
    manager: State<'_, Arc<RuntimeManager>>,
) -> Result<Vec<RuntimeSession>, RuntimeError> {
    let gateway = manager.active_gateway().await?;
    gateway.list_sessions().await
}

#[tauri::command]
pub async fn runtime_session_restore(
    manager: State<'_, Arc<RuntimeManager>>,
    session_id: String,
) -> Result<RuntimeSession, RuntimeError> {
    let gateway = manager.active_gateway().await?;
    gateway.restore_session(&session_id).await
}

#[tauri::command]
pub async fn runtime_messages_list(
    manager: State<'_, Arc<RuntimeManager>>,
    session_id: String,
) -> Result<Vec<RuntimeMessage>, RuntimeError> {
    let gateway = manager.active_gateway().await?;
    gateway.list_messages(&session_id).await
}

#[tauri::command]
pub async fn runtime_session_attach(
    manager: State<'_, Arc<RuntimeManager>>,
    session_id: String,
) -> Result<RuntimeSession, RuntimeError> {
    let gateway = manager.active_gateway().await?;
    gateway.attach_session(&session_id).await
}

#[tauri::command]
pub async fn runtime_session_detach(
    manager: State<'_, Arc<RuntimeManager>>,
    session_id: String,
) -> Result<CommandAck, RuntimeError> {
    let gateway = manager.active_gateway().await?;
    gateway.detach_session(&session_id).await
}

#[tauri::command]
pub async fn runtime_session_rename(
    manager: State<'_, Arc<RuntimeManager>>,
    controller: State<'_, ControllerLeaseManager>,
    session_id: String,
    title: String,
    expected_target_id: Option<String>,
) -> Result<CommandAck, RuntimeError> {
    ensure_controller_held(&controller)?;
    let gateway = checked_gateway(&manager, expected_target_id.as_deref()).await?;
    gateway.rename_session(&session_id, &title).await
}

#[tauri::command]
pub async fn runtime_session_create(
    app: AppHandle,
    manager: State<'_, Arc<RuntimeManager>>,
    controller: State<'_, ControllerLeaseManager>,
    request: SessionCreateRequest,
    expected_target_id: Option<String>,
) -> Result<SessionCreateResult, RuntimeError> {
    ensure_controller_held(&controller)?;
    let data_root = get_jan_data_folder_path(app);
    let cwd = resolve_runtime_cwd(&data_root)?;
    let gateway = checked_gateway(&manager, expected_target_id.as_deref()).await?;
    gateway.create_session(request, cwd).await
}

#[tauri::command]
pub async fn runtime_run_start(
    manager: State<'_, Arc<RuntimeManager>>,
    controller: State<'_, ControllerLeaseManager>,
    request: RunStartRequest,
) -> Result<RunStartResult, RuntimeError> {
    ensure_controller_held(&controller)?;
    let gateway = manager.active_gateway().await?;
    gateway.start_run(request).await
}

#[tauri::command]
pub async fn runtime_run_cancel(
    manager: State<'_, Arc<RuntimeManager>>,
    controller: State<'_, ControllerLeaseManager>,
    request: RunCancelRequest,
) -> Result<CommandAck, RuntimeError> {
    ensure_controller_held(&controller)?;
    let gateway = manager.active_gateway().await?;
    gateway.cancel_run(request).await
}

#[tauri::command]
pub async fn conversation_cancel_runtime_run(
    manager: State<'_, Arc<RuntimeManager>>,
    controller: State<'_, ControllerLeaseManager>,
    session_id: String,
) -> Result<CommandAck, RuntimeError> {
    log::info!("Runtime cancel requested: session={session_id}");
    ensure_controller_held(&controller)?;
    let gateway = manager.active_gateway().await?;
    let result = gateway.cancel_session_run(&session_id).await;
    log::info!(
        "Runtime cancel returned: session={} result={:?}",
        session_id,
        result
    );
    result
}

#[tauri::command]
pub async fn runtime_permission_resolve<R: Runtime>(
    window: WebviewWindow<R>,
    manager: State<'_, Arc<RuntimeManager>>,
    controller: State<'_, ControllerLeaseManager>,
    request: PermissionResolveRequest,
) -> Result<PermissionDecisionReceipt, RuntimeError> {
    ensure_interactive_window_surface(window.label())?;
    ensure_controller_held(&controller)?;
    let gateway = manager.active_gateway().await?;
    gateway.resolve_permission(request).await
}

#[tauri::command]
pub async fn runtime_discover(
    manager: State<'_, Arc<RuntimeManager>>,
) -> Result<Vec<RuntimeDescriptor>, RuntimeError> {
    Ok(manager.discover().await)
}

#[tauri::command]
pub async fn runtime_switch(
    manager: State<'_, Arc<RuntimeManager>>,
    controller: State<'_, ControllerLeaseManager>,
    id: String,
) -> Result<RuntimeSnapshot, RuntimeError> {
    ensure_controller_held(&controller)?;
    manager.switch(&id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::{RuntimeErrorCode, RuntimeEvent, RuntimeStatus, RUNTIME_SESSION_ID};

    #[test]
    fn default_runtime_cwd_is_an_absolute_child_of_data_root() {
        let temp = tempfile::tempdir().unwrap();
        let cwd = resolve_runtime_cwd(temp.path()).unwrap();
        let root = temp.path().canonicalize().unwrap();

        assert!(cwd.is_absolute());
        assert!(cwd.starts_with(root));
        assert!(cwd.ends_with("runtime/hermes"));
    }

    #[test]
    fn session_request_rejects_webview_cwd() {
        let value = serde_json::json!({
            "sessionId": "thread-1",
            "cwd": "/tmp/outside"
        });

        assert!(serde_json::from_value::<SessionCreateRequest>(value).is_err());
    }

    #[test]
    fn reserved_runtime_session_is_rejected_at_the_command_boundary() {
        let error = SessionCreateRequest {
            agent_id: None,
            session_id: RUNTIME_SESSION_ID.into(),
            title: None,
        }
        .validate()
        .unwrap_err();

        assert_eq!(error.code, RuntimeErrorCode::SessionConflict);
    }

    #[test]
    fn runtime_sink_rejects_oversized_events_before_emitting() {
        let event = RuntimeEventEnvelope::new_runtime(
            "epoch-1",
            0,
            RuntimeEvent::DiagnosticNotice {
                level: crate::runtime::DiagnosticLevel::Warning,
                message: "x".repeat(MAX_EVENT_BYTES),
            },
        );

        let error = validate_event_size(&event).unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::InternalError);
        assert_eq!(error.message, "Runtime event exceeds the size limit");
    }

    #[test]
    fn runtime_command_errors_keep_structured_code_and_message() {
        let error = RuntimeError::new(RuntimeErrorCode::HermesNotFound, "Hermes is not installed");
        let json = serde_json::to_value(&error).unwrap();

        assert_eq!(json["code"], "hermes_not_found");
        assert_eq!(json["message"], "Hermes is not installed");
        assert_eq!(json["recoverable"], true);
    }

    #[tokio::test]
    async fn session_read_deadline_maps_to_a_recoverable_timeout() {
        let timeout = read_with_deadline("测试读", Duration::from_millis(1), async {
            std::future::pending::<Result<u32, RuntimeError>>().await
        })
        .await
        .unwrap_err();
        assert_eq!(timeout.code, RuntimeErrorCode::ReadTimeout);
        assert_eq!(timeout.code.code_as_str(), "read_timeout");
        assert!(timeout.recoverable);

        let value = read_with_deadline("测试读", Duration::from_millis(50), async { Ok(7) })
            .await
            .unwrap();
        assert_eq!(value, 7);
    }

    #[test]
    fn runtime_status_and_ack_remain_serializable_for_tauri_commands() {
        let snapshot = RuntimeSnapshot {
            runtime_id: "hermes".into(),
            status: RuntimeStatus::Ready,
            runtime_epoch: Some("epoch-1".into()),
            sequence: 2,
            message: Some("Hermes ready".into()),
        };
        let ack = CommandAck {
            accepted: true,
            duplicate: false,
        };

        assert!(serde_json::to_value(snapshot).is_ok());
        assert!(serde_json::to_value(ack).is_ok());
    }

    #[test]
    fn runtime_actions_are_accepted_from_the_main_window_and_voice_overlay() {
        for label in ["main", "voice-overlay"] {
            assert!(ensure_interactive_window_surface(label).is_ok());
        }
        for label in ["status-popup", "voice-ball", "unknown", ""] {
            let error = ensure_interactive_window_surface(label).unwrap_err();
            assert_eq!(error.code, RuntimeErrorCode::InternalError);
        }
    }

    #[test]
    fn runtime_attachment_grant_is_bound_to_window_target_and_session() {
        let owner = runtime_attachment_owner("main", "target-a", "session-a");
        assert_ne!(
            owner,
            runtime_attachment_owner("status-popup", "target-a", "session-a")
        );
        assert_ne!(
            owner,
            runtime_attachment_owner("main", "target-b", "session-a")
        );
        assert_ne!(
            owner,
            runtime_attachment_owner("main", "target-a", "session-b")
        );
    }

    #[test]
    fn mutation_boundary_requires_controller_lease() {
        let controller = ControllerLeaseManager::default();
        let error = ensure_controller_held(&controller).unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::ControllerRequired);
    }

    #[test]
    fn conversation_projection_removes_permission_input() {
        let event = RuntimeEventEnvelope::new_run(
            "epoch-1",
            "thread-1",
            "run-1",
            1,
            RuntimeEvent::PermissionRequested {
                request: crate::runtime::PermissionRequest {
                    request_id: "permission-1".into(),
                    tool_call_id: "tool-1".into(),
                    title: "Run tool".into(),
                    description: "Hermes requests a tool".into(),
                    tool_name: "terminal".into(),
                    input_summary: Some(serde_json::json!({"authorization": "secret"})),
                    can_allow_once: true,
                    can_deny: true,
                    actions: None,
                    action_set_digest: None,
                    has_unsupported_decision: false,
                    expires_at: "2099-01-01T00:00:00Z".into(),
                },
            },
        );

        let projected = conversation_projection(&event);
        let RuntimeEvent::PermissionRequested { request } = projected.event else {
            panic!("expected permission request");
        };
        assert!(request.input_summary.is_none());
    }
}

#[tauri::command]
pub async fn runtime_agents_list(
    manager: State<'_, Arc<RuntimeManager>>,
) -> Result<Vec<super::RuntimeAgent>, RuntimeError> {
    manager.active_gateway().await?.list_agents().await
}
#[tauri::command]
pub async fn runtime_session_delete(
    manager: State<'_, Arc<RuntimeManager>>,
    controller: State<'_, ControllerLeaseManager>,
    session_id: String,
    expected_target_id: Option<String>,
) -> Result<CommandAck, RuntimeError> {
    ensure_controller_held(&controller)?;
    checked_gateway(&manager, expected_target_id.as_deref())
        .await?
        .delete_session(&session_id)
        .await
}
#[tauri::command]
pub async fn runtime_session_clear_context(
    manager: State<'_, Arc<RuntimeManager>>,
    controller: State<'_, ControllerLeaseManager>,
    session_id: String,
    expected_target_id: Option<String>,
) -> Result<RuntimeSession, RuntimeError> {
    ensure_controller_held(&controller)?;
    checked_gateway(&manager, expected_target_id.as_deref())
        .await?
        .clear_context(&session_id)
        .await
}
#[tauri::command]
pub async fn runtime_session_generate_title(
    manager: State<'_, Arc<RuntimeManager>>,
    controller: State<'_, ControllerLeaseManager>,
    session_id: String,
    message_id: String,
    content: String,
    expected_target_id: Option<String>,
) -> Result<super::SessionTitleResult, RuntimeError> {
    ensure_controller_held(&controller)?;
    checked_gateway(&manager, expected_target_id.as_deref())
        .await?
        .generate_title(&session_id, &message_id, &content)
        .await
}

#[tauri::command]
pub async fn runtime_target_identity(
    manager: State<'_, Arc<RuntimeManager>>,
) -> Result<serde_json::Value, RuntimeError> {
    let gateway = manager.active_gateway().await?;
    Ok(serde_json::json!({
        "targetId": gateway.target_id(),
        "runtimeEpoch": gateway.snapshot().await.runtime_epoch,
    }))
}

/// 读到的窗口里出现过「已接收输入」，就清掉它的本地待确认记录。
///
/// 展示读与实时帧是两条独立的到达路径，两边都要清：只靠实时帧的话，帧丢过一次
/// （应用关过、连接重建期）这条记录就再也没人清理，UI 会一直显示幽灵输入。
fn confirm_reader_pending(app: &AppHandle, feed: &super::SessionFeed) {
    if let Err(error) = super::session_pending::confirm_events(
        &get_jan_data_folder_path(app.clone()).join("runtime/session-pending"),
        &feed.target_id,
        &feed.session_id,
        &feed.events,
    ) {
        log::warn!("已接收输入的本地记录清理失败: {}", error.code.code_as_str());
    }
}
/// 首屏 / 翻页读的硬超时：Runtime 侧窗口读在并发下会排队（实测被拖到 10–15s），
/// 客户端没有截止时间只能无限等；到点返回可重试的明确错误，让前端能收敛到停止态。
const SESSION_READ_TIMEOUT: Duration = Duration::from_secs(15);
/// 一次检索默认返回多少条命中。上限由 Runtime 侧钉在 50。
const DEFAULT_SEARCH_LIMIT: u32 = 20;
/// 超过这个耗时就留一条日志，便于区分「慢」和「卡」。
const SESSION_READ_SLOW: Duration = Duration::from_secs(3);

async fn read_with_deadline<F, T>(
    label: &str,
    budget: Duration,
    future: F,
) -> Result<T, RuntimeError>
where
    F: std::future::Future<Output = Result<T, RuntimeError>>,
{
    let started = std::time::Instant::now();
    match tokio::time::timeout(budget, future).await {
        Ok(result) => {
            let elapsed = started.elapsed();
            if elapsed >= SESSION_READ_SLOW {
                log::warn!("{label} 耗时 {:.1}s", elapsed.as_secs_f32());
            }
            result
        }
        Err(_) => {
            // 区分「本机状态锁排队」与「Runtime 侧慢」：前者重试就好，后者要用户知道是服务端。
            let message = if crate::runtime::gateway::state_lock_pressure() {
                "读取会话超时：本机处理繁忙（状态锁排队），请重试"
            } else {
                "读取会话超时，请重试"
            };
            // 归因结论写进日志：真机排查时只看 app.log 就能判断是不是本机排队。
            log::warn!(
                "{label} 超时（{}s），放弃本次读取：{message}",
                budget.as_secs()
            );
            Err(RuntimeError::new(RuntimeErrorCode::ReadTimeout, message))
        }
    }
}

#[tauri::command]
pub async fn runtime_session_feed(
    app: AppHandle,
    manager: State<'_, Arc<RuntimeManager>>,
    session_id: String,
    before_seq: Option<u64>,
) -> Result<super::SessionFeed, RuntimeError> {
    let feed = read_with_deadline("读取会话事件窗口", SESSION_READ_TIMEOUT, async {
        manager
            .active_gateway()
            .await?
            .session_feed(&session_id, before_seq, super::SessionFeedView::Events)
            .await
    })
    .await?;
    confirm_reader_pending(&app, &feed);
    Ok(feed)
}
#[tauri::command]
pub async fn runtime_session_history_window(
    app: AppHandle,
    manager: State<'_, Arc<RuntimeManager>>,
    session_id: String,
    before_seq: Option<u64>,
) -> Result<super::SessionFeed, RuntimeError> {
    let feed = read_with_deadline("读取会话窗口", SESSION_READ_TIMEOUT, async {
        manager
            .active_gateway()
            .await?
            .session_feed(&session_id, before_seq, super::SessionFeedView::History)
            .await
    })
    .await?;
    confirm_reader_pending(&app, &feed);
    Ok(feed)
}
#[tauri::command]
pub async fn runtime_session_history(
    manager: State<'_, Arc<RuntimeManager>>,
    controller: State<'_, ControllerLeaseManager>,
    request: super::SessionHistoryRequest,
) -> Result<super::SessionHistoryResult, RuntimeError> {
    ensure_controller_held(&controller)?;
    checked_gateway(&manager, Some(&request.target_id))
        .await?
        .session_history(request)
        .await
}

#[tauri::command]
pub async fn runtime_sessions_search(
    manager: State<'_, Arc<RuntimeManager>>,
    query: String,
    limit: Option<u32>,
) -> Result<Vec<super::RuntimeSearchHit>, RuntimeError> {
    // 检索是读操作：和窗口读取一样不占控制租约，也不改变任何会话状态。
    let gateway = manager.active_gateway().await?;
    read_with_deadline("检索会话正文", SESSION_READ_TIMEOUT, async {
        gateway
            .search_sessions(&query, limit.unwrap_or(DEFAULT_SEARCH_LIMIT))
            .await
    })
    .await
}

#[tauri::command]
pub async fn runtime_session_submit(
    app: AppHandle,
    manager: State<'_, Arc<RuntimeManager>>,
    controller: State<'_, ControllerLeaseManager>,
    request: super::SessionSubmitRequest,
) -> Result<super::SessionSubmitResult, RuntimeError> {
    // 仅标注提交前的失败；进入 Driver 后即使不可重试也不能推断未接收。
    let not_sent = |mut error: RuntimeError| {
        let mut details = error
            .details
            .take()
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default();
        details.insert("submissionState".into(), serde_json::json!("not_sent"));
        error.details = Some(details.into());
        error
    };
    ensure_controller_held(&controller).map_err(&not_sent)?;
    request.validate().map_err(&not_sent)?;
    let gateway = manager.active_gateway().await.map_err(&not_sent)?;
    let root = get_jan_data_folder_path(app).join("runtime/session-pending");
    let target = gateway.target_id();
    if request.target_id != target {
        return Err(RuntimeError::new(
            RuntimeErrorCode::SessionConflict,
            "Runtime 目标已改变，请重新加载会话",
        ));
    }
    let record = super::session_pending::PendingInput {
        target_id: target.clone(),
        session_id: request.session_id.clone(),
        message_id: request.message_id.clone(),
        content: request.content.clone(),
        skill_ids: request.skill_ids.clone(),
        attachments: request.attachments.clone(),
    };
    super::session_pending::persist(&root, &record).map_err(&not_sent)?;
    let result = match gateway.session_submit(request).await {
        Ok(result) => result,
        Err(error) => {
            let status = error
                .details
                .as_ref()
                .and_then(|details| details.get("httpStatus"))
                .and_then(serde_json::Value::as_u64);
            // 明确拒绝无需在重启后恢复为未知；超时及服务端错误仍保留原 ID。
            if status.is_some_and(|status| (400..500).contains(&status) && status != 408) {
                super::session_pending::remove(
                    &root,
                    &target,
                    &record.session_id,
                    &record.message_id,
                )?;
            }
            return Err(error);
        }
    };
    if result.accepted {
        if let Err(error) =
            super::session_pending::remove(&root, &target, &record.session_id, &record.message_id)
        {
            log::warn!("已接收输入的本地记录清理失败: {}", error.code.code_as_str());
        }
    }
    Ok(result)
}

#[tauri::command]
pub async fn runtime_session_attachment_select<R: Runtime>(
    window: WebviewWindow<R>,
    manager: State<'_, Arc<RuntimeManager>>,
    file_grants: State<'_, Arc<FeatureFileGrantService>>,
    session_id: String,
    expected_target_id: String,
) -> Result<Option<PublicFileGrant>, RuntimeError> {
    ensure_interactive_window_surface(window.label())?;
    checked_gateway(&manager, Some(expected_target_id.as_str())).await?;
    let Some(selected) = AsyncFileDialog::new().pick_file().await else {
        return Ok(None);
    };
    file_grants
        .register_selected_path_with_limit(
            runtime_attachment_owner(window.label(), &expected_target_id, &session_id),
            RUNTIME_ATTACHMENT_SERVICE_ID,
            RUNTIME_ATTACHMENT_OPERATION_ID,
            FileGrantDirection::Upload,
            selected.path().to_path_buf(),
            Some(RUNTIME_ATTACHMENT_MAX_BYTES),
        )
        .map(Some)
        .map_err(runtime_attachment_grant_error)
}

#[tauri::command]
pub async fn runtime_session_attachment_upload<R: Runtime>(
    window: WebviewWindow<R>,
    manager: State<'_, Arc<RuntimeManager>>,
    controller: State<'_, ControllerLeaseManager>,
    file_grants: State<'_, Arc<FeatureFileGrantService>>,
    session_id: String,
    grant_id: String,
    expected_target_id: String,
) -> Result<super::SessionAttachment, RuntimeError> {
    ensure_interactive_window_surface(window.label())?;
    ensure_controller_held(&controller)?;
    let gateway = checked_gateway(&manager, Some(expected_target_id.as_str())).await?;
    let staged = file_grants
        .consume_upload(
            &grant_id,
            &runtime_attachment_owner(window.label(), &expected_target_id, &session_id),
            RUNTIME_ATTACHMENT_SERVICE_ID,
            RUNTIME_ATTACHMENT_OPERATION_ID,
        )
        .map_err(runtime_attachment_grant_error)?;
    let result = gateway
        .session_attachment_upload(&session_id, &staged.absolute_path, &staged.source_name)
        .await;
    file_grants.cleanup_grant(&grant_id);
    result
}

#[tauri::command]
pub async fn runtime_session_attachment_discard<R: Runtime>(
    window: WebviewWindow<R>,
    manager: State<'_, Arc<RuntimeManager>>,
    file_grants: State<'_, Arc<FeatureFileGrantService>>,
    session_id: String,
    grant_id: String,
    expected_target_id: String,
) -> Result<CommandAck, RuntimeError> {
    ensure_interactive_window_surface(window.label())?;
    checked_gateway(&manager, Some(expected_target_id.as_str())).await?;
    let owner = runtime_attachment_owner(window.label(), &expected_target_id, &session_id);
    file_grants
        .grant_direction(
            &grant_id,
            &owner,
            RUNTIME_ATTACHMENT_SERVICE_ID,
            RUNTIME_ATTACHMENT_OPERATION_ID,
        )
        .map_err(runtime_attachment_grant_error)?;
    file_grants.cleanup_grant(&grant_id);
    Ok(CommandAck {
        accepted: true,
        duplicate: false,
    })
}

#[tauri::command]
pub async fn runtime_session_attachment_delete(
    manager: State<'_, Arc<RuntimeManager>>,
    controller: State<'_, ControllerLeaseManager>,
    session_id: String,
    resource_id: String,
    expected_target_id: String,
) -> Result<CommandAck, RuntimeError> {
    ensure_controller_held(&controller)?;
    checked_gateway(&manager, Some(expected_target_id.as_str()))
        .await?
        .session_attachment_delete(&session_id, &resource_id)
        .await?;
    Ok(CommandAck {
        accepted: true,
        duplicate: false,
    })
}
#[tauri::command]
pub async fn runtime_session_pending(
    app: AppHandle,
    manager: State<'_, Arc<RuntimeManager>>,
    session_id: String,
    expected_target_id: String,
) -> Result<Vec<super::session_pending::PendingInput>, RuntimeError> {
    let gateway = checked_gateway(&manager, Some(expected_target_id.as_str())).await?;
    super::session_pending::list(
        &get_jan_data_folder_path(app).join("runtime/session-pending"),
        &gateway.target_id(),
        &session_id,
    )
}
#[tauri::command]
pub async fn runtime_session_cancel(
    manager: State<'_, Arc<RuntimeManager>>,
    controller: State<'_, ControllerLeaseManager>,
    session_id: String,
    run_id: String,
    expected_target_id: String,
) -> Result<CommandAck, RuntimeError> {
    ensure_controller_held(&controller)?;
    checked_gateway(&manager, Some(expected_target_id.as_str()))
        .await?
        .session_cancel(&session_id, &run_id)
        .await
}
#[tauri::command]
pub async fn runtime_session_approval<R: Runtime>(
    window: WebviewWindow<R>,
    manager: State<'_, Arc<RuntimeManager>>,
    controller: State<'_, ControllerLeaseManager>,
    session_id: String,
    approval_id: String,
    decision: super::PermissionDecision,
    expected_target_id: String,
) -> Result<CommandAck, RuntimeError> {
    ensure_interactive_window_surface(window.label())?;
    ensure_controller_held(&controller)?;
    checked_gateway(&manager, Some(expected_target_id.as_str()))
        .await?
        .session_approval(&session_id, &approval_id, decision)
        .await
}

#[tauri::command]
pub async fn runtime_skills_list(
    manager: State<'_, Arc<RuntimeManager>>,
) -> Result<Vec<serde_json::Value>, RuntimeError> {
    manager.active_gateway().await?.list_skills().await
}

async fn checked_gateway(
    manager: &Arc<RuntimeManager>,
    expected: Option<&str>,
) -> Result<Arc<super::gateway::MinimalRuntimeGateway>, RuntimeError> {
    let gateway = manager.active_gateway().await?;
    if expected.is_some_and(|id| id != gateway.target_id()) {
        return Err(RuntimeError::new(
            RuntimeErrorCode::SessionConflict,
            "Runtime 目标已改变，请重新加载会话",
        ));
    }
    Ok(gateway)
}
