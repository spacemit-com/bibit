use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

pub const SCHEMA_VERSION: &str = "2.0";
pub const RUNTIME_ID: &str = "hermes";
pub const RUNTIME_SESSION_ID: &str = "__runtime__";
pub const MAX_EVENT_BYTES: usize = 256 * 1024;
pub const MAX_TOOL_VALUE_BYTES: usize = 64 * 1024;
pub const PERMISSION_TIMEOUT_SECS: u64 = 60;

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeStatus {
    Stopped,
    Checking,
    Starting,
    Ready,
    Stopping,
    Failed,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct RuntimeCapabilities {
    pub session_events: bool,
    pub session_inbox: bool,
    pub durable_sessions: bool,
    pub detached_runs: bool,
    pub replayable_events: bool,
    pub runtime_owned_approvals: bool,
    pub agent_selection: bool,
    pub session_management: bool,
    pub context_clear: bool,
    pub title_generation: bool,
    pub session_attachments: bool,
    pub skill_selection: bool,
    /// Runtime 是否支持按正文检索会话（GET /sessions/search）。默认关闭：只检索标题
    /// 是本地能力，正文检索必须由 Runtime 回答，否则界面会给出一搜就空的入口。
    pub session_search: bool,
    /// Runtime 是否接受历史写操作（POST /sessions/{id}/history）。默认关闭：
    /// 只有真的实现了 Driver::session_history 的驱动才配打开，否则界面会给出必然失败的入口。
    pub history_operations: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeConnectionStatus {
    Connected,
    Reconnecting,
    Disconnected,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PermissionDecision {
    AllowOnce,
    Deny,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PermissionActionKind {
    Tool,
    Filesystem,
    Network,
    System,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PermissionAction {
    pub kind: PermissionActionKind,
    pub name: String,
    pub summary: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PermissionDenyReason {
    UserDenied,
    Cancelled,
    TimedOut,
    PresenterFailed,
    RuntimeClosed,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeErrorCode {
    HermesNotFound,
    HermesCheckFailed,
    HermesStartFailed,
    AcpInitializeFailed,
    AcpProtocolError,
    AcpCapabilityMissing,
    SessionCreateFailed,
    SessionConflict,
    RunConflict,
    RunFailed,
    SkillUnavailable,
    RunIncomplete,
    RunInterrupted,
    SecurityDenied,
    SecurityUnavailable,
    /// Runtime 的网络策略拦下了到模型服务的连接（处置是改配置，不是重试）。
    NetworkPolicyBlocked,
    /// 模型服务收下请求但没在超时时间内回包。
    ProviderTimeout,
    /// 连不上模型服务，且没有证据说明是策略拦下的。
    ProviderConnectionFailed,
    /// 会话配额用尽。线上 code 是 Runtime 定义的大写形式。
    #[serde(rename = "TOKEN_BUDGET_EXCEEDED")]
    TokenBudgetExceeded,
    /// Control 面与 Worker 之间的 RPC 失败。
    WorkerRpcError,
    PermissionExpired,
    CancelTimeout,
    ReadTimeout,
    ControllerBusy,
    ControllerRequired,
    ProcessExited,
    InternalError,
}

impl RuntimeErrorCode {
    pub const fn code_as_str(self) -> &'static str {
        match self {
            Self::HermesNotFound => "hermes_not_found",
            Self::HermesCheckFailed => "hermes_check_failed",
            Self::HermesStartFailed => "hermes_start_failed",
            Self::AcpInitializeFailed => "acp_initialize_failed",
            Self::AcpProtocolError => "acp_protocol_error",
            Self::AcpCapabilityMissing => "acp_capability_missing",
            Self::SessionCreateFailed => "session_create_failed",
            Self::SessionConflict => "session_conflict",
            Self::RunConflict => "run_conflict",
            Self::RunFailed => "run_failed",
            Self::SkillUnavailable => "skill_unavailable",
            Self::RunIncomplete => "run_incomplete",
            Self::RunInterrupted => "run_interrupted",
            Self::SecurityDenied => "security_denied",
            Self::SecurityUnavailable => "security_unavailable",
            Self::NetworkPolicyBlocked => "network_policy_blocked",
            Self::ProviderTimeout => "provider_timeout",
            Self::ProviderConnectionFailed => "provider_connection_failed",
            Self::TokenBudgetExceeded => "TOKEN_BUDGET_EXCEEDED",
            Self::WorkerRpcError => "worker_rpc_error",
            Self::PermissionExpired => "permission_expired",
            Self::CancelTimeout => "cancel_timeout",
            Self::ReadTimeout => "read_timeout",
            Self::ControllerBusy => "controller_busy",
            Self::ControllerRequired => "controller_required",
            Self::ProcessExited => "process_exited",
            Self::InternalError => "internal_error",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeError {
    pub code: RuntimeErrorCode,
    pub message: String,
    pub recoverable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

impl RuntimeError {
    pub fn new(code: RuntimeErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            recoverable: true,
            details: None,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequest {
    pub request_id: String,
    pub tool_call_id: String,
    pub title: String,
    pub description: String,
    pub tool_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_summary: Option<Value>,
    pub can_allow_once: bool,
    pub can_deny: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actions: Option<Vec<PermissionAction>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action_set_digest: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub has_unsupported_decision: bool,
    pub expires_at: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticLevel {
    Info,
    Warning,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum RuntimeEvent {
    RuntimeStatusChanged {
        status: RuntimeStatus,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    ConnectionStatusChanged {
        status: RuntimeConnectionStatus,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    RunStarted {
        user_message_id: String,
    },
    TextDelta {
        message_id: String,
        delta: String,
    },
    ReasoningDelta {
        message_id: String,
        delta: String,
    },
    ToolStarted {
        tool_call_id: String,
        name: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        input: Option<Value>,
    },
    ToolUpdated {
        tool_call_id: String,
        update: Value,
    },
    ToolCompleted {
        tool_call_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        result: Option<Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    PermissionRequested {
        request: PermissionRequest,
    },
    PermissionResolved {
        request_id: String,
        decision: PermissionDecision,
    },
    PermissionAudit {
        request_id: String,
        decision: PermissionDecision,
        status: PermissionResolveStatus,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<PermissionDenyReason>,
        #[serde(skip_serializing_if = "Option::is_none")]
        action_set_digest: Option<String>,
    },
    DiagnosticNotice {
        level: DiagnosticLevel,
        message: String,
    },
    RunCompleted {
        #[serde(skip_serializing_if = "Option::is_none")]
        stop_reason: Option<String>,
    },
    RunCancelled {
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    RunFailed {
        error: RuntimeError,
    },
}

impl RuntimeEvent {
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            Self::RunCompleted { .. } | Self::RunCancelled { .. } | Self::RunFailed { .. }
        )
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEventEnvelope {
    pub schema_version: String,
    pub event_id: String,
    pub runtime_id: String,
    pub runtime_epoch: String,
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    pub sequence: u64,
    pub timestamp: String,
    pub event: RuntimeEvent,
}

impl RuntimeEventEnvelope {
    pub fn new_runtime_for(
        runtime_id: impl Into<String>,
        runtime_epoch: impl Into<String>,
        sequence: u64,
        event: RuntimeEvent,
    ) -> Self {
        Self::new(
            runtime_id.into(),
            runtime_epoch.into(),
            RUNTIME_SESSION_ID.to_owned(),
            None,
            sequence,
            event,
        )
    }

    pub fn new_runtime(
        runtime_epoch: impl Into<String>,
        sequence: u64,
        event: RuntimeEvent,
    ) -> Self {
        Self::new_runtime_for(RUNTIME_ID, runtime_epoch, sequence, event)
    }

    pub fn new_run_for(
        runtime_id: impl Into<String>,
        runtime_epoch: impl Into<String>,
        session_id: impl Into<String>,
        run_id: impl Into<String>,
        sequence: u64,
        event: RuntimeEvent,
    ) -> Self {
        Self::new(
            runtime_id.into(),
            runtime_epoch.into(),
            session_id.into(),
            Some(run_id.into()),
            sequence,
            event,
        )
    }

    pub fn new_run(
        runtime_epoch: impl Into<String>,
        session_id: impl Into<String>,
        run_id: impl Into<String>,
        sequence: u64,
        event: RuntimeEvent,
    ) -> Self {
        Self::new_run_for(
            RUNTIME_ID,
            runtime_epoch,
            session_id,
            run_id,
            sequence,
            event,
        )
    }

    fn new(
        runtime_id: String,
        runtime_epoch: String,
        session_id: String,
        run_id: Option<String>,
        sequence: u64,
        event: RuntimeEvent,
    ) -> Self {
        Self {
            schema_version: SCHEMA_VERSION.to_owned(),
            event_id: uuid::Uuid::new_v4().to_string(),
            runtime_id,
            runtime_epoch,
            session_id,
            run_id,
            sequence,
            timestamp: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            event,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSnapshot {
    pub runtime_id: String,
    pub status: RuntimeStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_epoch: Option<String>,
    pub sequence: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeRunSnapshot {
    pub id: String,
    #[serde(alias = "session_id")]
    pub session_id: String,
    #[serde(alias = "agent_id")]
    pub agent_id: String,
    pub status: String,
    pub content: String,
    #[serde(default)]
    pub usage: Option<Value>,
    #[serde(default)]
    pub error: Option<Value>,
    #[serde(default, alias = "pending_actions")]
    pub pending_actions: Vec<Value>,
    #[serde(alias = "event_cursor")]
    pub event_cursor: u64,
    #[serde(alias = "created_at")]
    pub created_at: f64,
    #[serde(alias = "updated_at")]
    pub updated_at: f64,
}

impl RuntimeRunSnapshot {
    pub fn is_terminal(&self) -> bool {
        matches!(self.status.as_str(), "completed" | "failed" | "cancelled")
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSession {
    #[serde(default)]
    pub running: bool,
    #[serde(default)]
    pub waiting: bool,
    #[serde(default)]
    pub failed: bool,
    #[serde(default, alias = "completed_unread")]
    pub completed_unread: bool,
    #[serde(default, alias = "active_run_id")]
    pub active_run_id: Option<String>,
    #[serde(default, alias = "pending_interaction")]
    pub pending_interaction: Option<String>,
    pub id: String,
    pub title: String,
    #[serde(alias = "agent_id")]
    pub agent_id: String,
    #[serde(default)]
    pub metadata: BTreeMap<String, Value>,
    #[serde(alias = "created_at")]
    pub created_at: f64,
    #[serde(alias = "updated_at")]
    pub updated_at: f64,
    #[serde(default, alias = "latest_run", skip_serializing_if = "Option::is_none")]
    pub latest_run: Option<RuntimeRunSnapshot>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeMessage {
    pub id: String,
    pub role: String,
    #[serde(default)]
    pub content: String,
    #[serde(default, alias = "request_id")]
    pub request_id: Option<String>,
    #[serde(default, alias = "created_at")]
    pub created_at: Option<f64>,
    #[serde(default)]
    pub seq: Option<u64>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

/// 一条正文命中。`seq` 是 Runtime 折叠后的消息锚点，`end_seq` 是这条消息覆盖到的
/// 最后一条分片；界面按 `end_seq` 把整条消息读回窗口并定位。
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSearchHit {
    #[serde(alias = "session_id")]
    pub session_id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default, alias = "updated_at")]
    pub updated_at: f64,
    #[serde(default, alias = "run_id")]
    pub run_id: Option<String>,
    pub seq: u64,
    #[serde(alias = "end_seq")]
    pub end_seq: u64,
    pub role: String,
    #[serde(default)]
    pub snippet: String,
    #[serde(default, alias = "match_start")]
    pub match_start: usize,
    #[serde(default, alias = "match_length")]
    pub match_length: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionCreateRequest {
    #[serde(default)]
    pub agent_id: Option<String>,
    pub session_id: String,
    #[serde(default)]
    pub title: Option<String>,
}

impl SessionCreateRequest {
    pub fn validate(&self) -> Result<(), RuntimeError> {
        if let Some(agent_id) = self.agent_id.as_deref() {
            validate_non_empty(agent_id, RuntimeErrorCode::SessionCreateFailed, "agentId")?;
        }
        validate_session_id(&self.session_id)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionCreateResult {
    pub session_id: String,
    pub runtime_session_id: String,
    pub runtime_epoch: String,
    pub reused: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunStartRequest {
    pub session_id: String,
    pub user_message_id: String,
    pub prompt: String,
}

impl RunStartRequest {
    pub fn validate(&self) -> Result<(), RuntimeError> {
        validate_session_id(&self.session_id)?;
        validate_non_empty(
            &self.user_message_id,
            RuntimeErrorCode::RunFailed,
            "userMessageId",
        )?;
        validate_non_empty(&self.prompt, RuntimeErrorCode::RunFailed, "prompt")
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RunStartResult {
    pub run_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunCancelRequest {
    pub session_id: String,
    pub run_id: String,
}

impl RunCancelRequest {
    pub fn validate(&self) -> Result<(), RuntimeError> {
        validate_session_id(&self.session_id)?;
        validate_non_empty(&self.run_id, RuntimeErrorCode::RunConflict, "runId")
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PermissionResolveRequest {
    pub runtime_instance_id: String,
    pub runtime_id: String,
    pub runtime_epoch: String,
    pub session_id: String,
    pub thread_id: String,
    pub run_id: String,
    pub request_id: String,
    pub tool_call_id: String,
    pub decision: PermissionDecision,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<PermissionDenyReason>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action_set_digest: Option<String>,
}

impl PermissionResolveRequest {
    pub fn validate(&self) -> Result<(), RuntimeError> {
        for (value, field) in [
            (&self.runtime_instance_id, "runtimeInstanceId"),
            (&self.runtime_id, "runtimeId"),
            (&self.runtime_epoch, "runtimeEpoch"),
            (&self.session_id, "sessionId"),
            (&self.thread_id, "threadId"),
            (&self.run_id, "runId"),
            (&self.request_id, "requestId"),
            (&self.tool_call_id, "toolCallId"),
        ] {
            validate_non_empty(value, RuntimeErrorCode::PermissionExpired, field)?;
        }
        match self.decision {
            PermissionDecision::Deny if self.reason.is_none() => {
                return Err(RuntimeError::new(
                    RuntimeErrorCode::InternalError,
                    "deny permission resolution requires a reason",
                ));
            }
            PermissionDecision::AllowOnce if self.reason.is_some() => {
                return Err(RuntimeError::new(
                    RuntimeErrorCode::InternalError,
                    "allow permission resolution must not include a reason",
                ));
            }
            _ => {}
        }
        if let Some(digest) = &self.action_set_digest {
            if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return Err(RuntimeError::new(
                    RuntimeErrorCode::InternalError,
                    "actionSetDigest must be a 64-character SHA-256 hex digest",
                ));
            }
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PermissionResolveStatus {
    Accepted,
    Duplicate,
    Stale,
    Expired,
    Rejected,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PermissionDecisionReceipt {
    pub version: u8,
    pub runtime_instance_id: String,
    pub runtime_id: String,
    pub runtime_epoch: String,
    pub session_id: String,
    pub thread_id: String,
    pub run_id: String,
    pub request_id: String,
    pub tool_call_id: String,
    pub decision: PermissionDecision,
    pub status: PermissionResolveStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<PermissionDenyReason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action_set_digest: Option<String>,
}

impl PermissionResolveRequest {
    pub fn receipt(&self, status: PermissionResolveStatus) -> PermissionDecisionReceipt {
        PermissionDecisionReceipt {
            version: 1,
            runtime_instance_id: self.runtime_instance_id.clone(),
            runtime_id: self.runtime_id.clone(),
            runtime_epoch: self.runtime_epoch.clone(),
            session_id: self.session_id.clone(),
            thread_id: self.thread_id.clone(),
            run_id: self.run_id.clone(),
            request_id: self.request_id.clone(),
            tool_call_id: self.tool_call_id.clone(),
            decision: self.decision,
            status,
            reason: self.reason,
            action_set_digest: self.action_set_digest.clone(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommandAck {
    pub accepted: bool,
    pub duplicate: bool,
}

pub(crate) fn validate_session_id(session_id: &str) -> Result<(), RuntimeError> {
    validate_non_empty(session_id, RuntimeErrorCode::SessionConflict, "sessionId")?;
    if session_id == RUNTIME_SESSION_ID {
        return Err(RuntimeError::new(
            RuntimeErrorCode::SessionConflict,
            "sessionId is reserved for runtime events",
        ));
    }
    Ok(())
}

fn validate_non_empty(
    value: &str,
    code: RuntimeErrorCode,
    field: &str,
) -> Result<(), RuntimeError> {
    if value.trim().is_empty() {
        return Err(RuntimeError::new(
            code,
            format!("{field} must not be empty"),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("../../../tests/fixtures/runtime-contract-v1.json");

    #[test]
    fn shared_fixture_round_trips_without_shape_drift() {
        let expected: serde_json::Value = serde_json::from_str(FIXTURE).unwrap();
        let events: Vec<RuntimeEventEnvelope> = serde_json::from_str(FIXTURE).unwrap();
        assert_eq!(serde_json::to_value(events).unwrap(), expected);
    }

    #[test]
    fn terminal_event_classification_is_exclusive() {
        let completed = RuntimeEvent::RunCompleted {
            stop_reason: Some("end_turn".into()),
        };
        let cancelled = RuntimeEvent::RunCancelled {
            reason: Some("user".into()),
        };
        let failed = RuntimeEvent::RunFailed {
            error: RuntimeError::new(RuntimeErrorCode::RunFailed, "failed"),
        };
        assert!(completed.is_terminal());
        assert!(cancelled.is_terminal());
        assert!(failed.is_terminal());
        assert!(!RuntimeEvent::TextDelta {
            message_id: "m1".into(),
            delta: "x".into(),
        }
        .is_terminal());
    }

    #[test]
    fn reserved_runtime_session_cannot_start_a_run() {
        let request = RunStartRequest {
            session_id: RUNTIME_SESSION_ID.into(),
            user_message_id: "user-1".into(),
            prompt: "hello".into(),
        };
        assert_eq!(
            request.validate().unwrap_err().code,
            RuntimeErrorCode::SessionConflict
        );
    }

    #[test]
    fn webview_request_rejects_unknown_cwd() {
        let value = serde_json::json!({
            "sessionId": "thread-1",
            "cwd": "/tmp/untrusted"
        });

        assert!(serde_json::from_value::<SessionCreateRequest>(value).is_err());
    }

    #[test]
    fn command_requests_reject_empty_identifiers_and_prompt() {
        assert!(SessionCreateRequest {
            agent_id: None,
            session_id: String::new(),
            title: None,
        }
        .validate()
        .is_err());
        assert!(RunStartRequest {
            session_id: "thread-1".into(),
            user_message_id: String::new(),
            prompt: "hello".into(),
        }
        .validate()
        .is_err());
        assert!(RunStartRequest {
            session_id: "thread-1".into(),
            user_message_id: "user-1".into(),
            prompt: String::new(),
        }
        .validate()
        .is_err());
        assert!(RunCancelRequest {
            session_id: String::new(),
            run_id: "run-1".into(),
        }
        .validate()
        .is_err());
        assert!(RunCancelRequest {
            session_id: "thread-1".into(),
            run_id: String::new(),
        }
        .validate()
        .is_err());
        assert!(PermissionResolveRequest {
            runtime_instance_id: "hermes:epoch-1".into(),
            runtime_id: RUNTIME_ID.into(),
            runtime_epoch: "epoch-1".into(),
            session_id: "thread-1".into(),
            thread_id: "thread-1".into(),
            run_id: "run-1".into(),
            request_id: String::new(),
            tool_call_id: "tool-1".into(),
            decision: PermissionDecision::Deny,
            reason: None,
            action_set_digest: None,
        }
        .validate()
        .is_err());

        let valid_identity = PermissionResolveRequest {
            runtime_instance_id: "hermes:epoch-1".into(),
            runtime_id: RUNTIME_ID.into(),
            runtime_epoch: "epoch-1".into(),
            session_id: "thread-1".into(),
            thread_id: "thread-1".into(),
            run_id: "run-1".into(),
            request_id: "permission-1".into(),
            tool_call_id: "tool-1".into(),
            decision: PermissionDecision::Deny,
            reason: None,
            action_set_digest: None,
        };
        assert!(valid_identity.validate().is_err());
        assert!(PermissionResolveRequest {
            reason: Some(PermissionDenyReason::UserDenied),
            action_set_digest: Some("not-a-digest".into()),
            ..valid_identity
        }
        .validate()
        .is_err());
    }

    #[test]
    fn permission_receipt_serializes_complete_identity_and_status() {
        let receipt = PermissionDecisionReceipt {
            version: 1,
            runtime_instance_id: "hermes:epoch-1".into(),
            runtime_id: RUNTIME_ID.into(),
            runtime_epoch: "epoch-1".into(),
            session_id: "thread-1".into(),
            thread_id: "thread-1".into(),
            run_id: "run-1".into(),
            request_id: "permission-1".into(),
            tool_call_id: "tool-1".into(),
            decision: PermissionDecision::AllowOnce,
            status: PermissionResolveStatus::Accepted,
            reason: None,
            action_set_digest: None,
        };

        assert_eq!(
            serde_json::to_value(receipt).unwrap(),
            serde_json::json!({
                "version": 1,
                "runtimeInstanceId": "hermes:epoch-1",
                "runtimeId": "hermes",
                "runtimeEpoch": "epoch-1",
                "sessionId": "thread-1",
                "threadId": "thread-1",
                "runId": "run-1",
                "requestId": "permission-1",
                "toolCallId": "tool-1",
                "decision": "allow_once",
                "status": "accepted"
            })
        );
    }

    #[test]
    fn envelope_constructors_assign_contract_metadata() {
        let runtime = RuntimeEventEnvelope::new_runtime(
            "epoch-1",
            3,
            RuntimeEvent::RuntimeStatusChanged {
                status: RuntimeStatus::Ready,
                message: None,
            },
        );
        assert_eq!(runtime.schema_version, SCHEMA_VERSION);
        assert_eq!(runtime.runtime_id, RUNTIME_ID);
        assert_eq!(runtime.session_id, RUNTIME_SESSION_ID);
        assert_eq!(runtime.run_id, None);
        assert_eq!(runtime.sequence, 3);

        let run = RuntimeEventEnvelope::new_run(
            "epoch-1",
            "thread-1",
            "run-1",
            4,
            RuntimeEvent::RunCompleted { stop_reason: None },
        );
        assert_eq!(run.schema_version, SCHEMA_VERSION);
        assert_eq!(run.runtime_id, RUNTIME_ID);
        assert_eq!(run.session_id, "thread-1");
        assert_eq!(run.run_id.as_deref(), Some("run-1"));
        assert_eq!(run.sequence, 4);

        assert!(uuid::Uuid::parse_str(&runtime.event_id).is_ok());
        assert!(uuid::Uuid::parse_str(&run.event_id).is_ok());
        assert!(chrono::DateTime::parse_from_rfc3339(&runtime.timestamp).is_ok());
        assert!(chrono::DateTime::parse_from_rfc3339(&run.timestamp).is_ok());
    }

    #[test]
    fn runtime_error_is_recoverable_by_default() {
        let error = RuntimeError::new(RuntimeErrorCode::InternalError, "failed");
        assert!(error.recoverable);
    }

    #[test]
    fn runtime_history_reads_http_snake_case_and_writes_tauri_camel_case() {
        let session: RuntimeSession = serde_json::from_value(serde_json::json!({
            "id": "session-1",
            "title": "Session",
            "agent_id": "agent-1",
            "metadata": {},
            "created_at": 1.0,
            "updated_at": 2.0,
            "latest_run": {
                "id": "run-1",
                "session_id": "session-1",
                "agent_id": "agent-1",
                "status": "running",
                "content": "",
                "pending_actions": [],
                "event_cursor": 3,
                "created_at": 1.0,
                "updated_at": 2.0
            }
        }))
        .unwrap();
        let value = serde_json::to_value(session).unwrap();

        assert_eq!(value["agentId"], "agent-1");
        assert_eq!(value["latestRun"]["sessionId"], "session-1");
        assert_eq!(value["latestRun"]["eventCursor"], 3);
        assert!(value.get("agent_id").is_none());

        let message: RuntimeMessage = serde_json::from_value(serde_json::json!({
            "id": "message-1",
            "role": "assistant",
            "content": "done",
            "request_id": "request-1",
            "created_at": 2.0,
            "seq": 4
        }))
        .unwrap();
        let value = serde_json::to_value(message).unwrap();
        assert_eq!(value["requestId"], "request-1");
        assert_eq!(value["createdAt"], 2.0);
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeAgent {
    pub id: String,
    pub name: String,
    #[serde(default, alias = "zh_name")]
    pub zh_name: String,
    /// `system` 表示随 Runtime 发布的内置助手，`user` 表示用户自建。
    #[serde(default)]
    pub origin: String,
    #[serde(default)]
    pub model: Option<Value>,
    pub available: bool,
    #[serde(default, alias = "unavailable_reason")]
    pub unavailable_reason: String,
    /// The agent's own skill selectors: the chat hides them from the temporary
    /// skill picker because the expert already runs with them.
    #[serde(default)]
    pub skills: Vec<String>,
    /// The agent's Tool selectors: naming a Plugin member materializes its
    /// owning Plugin, which brings that Plugin's Skills along.
    #[serde(default)]
    pub tools: Vec<String>,
    /// The agent's Plugins. A selected Plugin brings its own Skills into the
    /// session, so the temporary skill picker hides those too.
    #[serde(default)]
    pub plugins: Vec<String>,
    /// The agent's MCP servers. Naming one materializes its owning Plugin, which
    /// brings that Plugin's Skills along, so the picker needs them as well.
    #[serde(default)]
    pub mcps: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionTitleResult {
    pub title: String,
    #[serde(alias = "run_id")]
    pub run_id: Option<String>,
    pub status: String,
}

#[cfg(test)]
mod session_management_tests {
    use super::*;
    #[test]
    fn new_capabilities_default_off_and_agent_request_is_explicit() {
        let capabilities: RuntimeCapabilities =
            serde_json::from_value(serde_json::json!({})).unwrap();
        assert!(
            !capabilities.agent_selection
                && !capabilities.session_management
                && !capabilities.context_clear
                && !capabilities.title_generation
        );
        let request: SessionCreateRequest =
            serde_json::from_value(serde_json::json!({"sessionId":"s1", "agentId":"a1"})).unwrap();
        assert_eq!(request.agent_id.as_deref(), Some("a1"));
        assert!(SessionCreateRequest {
            session_id: "s1".into(),
            agent_id: Some(" ".into()),
            title: None
        }
        .validate()
        .is_err());
    }

    #[test]
    fn runtime_agent_origin_is_optional_and_preserved() {
        let builtin: RuntimeAgent = serde_json::from_value(serde_json::json!({
            "id": "com.bianbu.fd7564b8714f",
            "origin": "system",
            "name": "BibitEdgeAssistant",
            "zh_name": "Bibit端侧智能助手",
            "available": true
        }))
        .unwrap();
        assert_eq!(builtin.origin, "system");
        assert_eq!(builtin.zh_name, "Bibit端侧智能助手");

        // 旧后端不返回 origin 时仍可解析，来源按未知处理。
        let legacy: RuntimeAgent = serde_json::from_value(serde_json::json!({
            "id": "agent-a",
            "name": "Agent A",
            "available": false,
            "unavailableReason": "agent_model_required"
        }))
        .unwrap();
        assert!(legacy.origin.is_empty());
        assert_eq!(legacy.unavailable_reason, "agent_model_required");

        let user: RuntimeAgent = serde_json::from_value(serde_json::json!({
            "id": "agent-b",
            "origin": "user",
            "name": "Agent B",
            "available": true
        }))
        .unwrap();
        assert_eq!(user.origin, "user");
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionHistoryRequest {
    pub target_id: String,
    pub session_id: String,
    pub operation_id: String,
    pub expected_seq: u64,
    pub action: String,
    pub message_id: String,
    pub content: Option<String>,
}
impl SessionHistoryRequest {
    pub fn validate(&self) -> Result<(), RuntimeError> {
        validate_session_id(&self.session_id)?;
        for (name, value) in [
            ("targetId", &self.target_id),
            ("operationId", &self.operation_id),
            ("messageId", &self.message_id),
        ] {
            validate_non_empty(value, RuntimeErrorCode::SessionConflict, name)?;
            if name != "targetId" && value.chars().count() > 256 {
                return Err(RuntimeError::new(
                    RuntimeErrorCode::SessionConflict,
                    "历史操作标识超出限制",
                ));
            }
        }
        let valid_content = match (&*self.action, &self.content) {
            ("edit", Some(content)) => {
                !content.trim().is_empty() && content.chars().count() <= 16_000
            }
            ("delete" | "regenerate" | "continue" | "switch_version", None) => true,
            _ => false,
        };
        if !valid_content {
            return Err(RuntimeError::new(
                RuntimeErrorCode::SessionConflict,
                "无效的历史操作或内容",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionHistoryResult {
    pub accepted: bool,
    #[serde(alias = "operation_id")]
    pub operation_id: String,
    pub seq: u64,
    #[serde(alias = "run_id")]
    pub run_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionSubmitRequest {
    pub target_id: String,
    pub session_id: String,
    pub message_id: String,
    pub content: String,
    #[serde(default)]
    pub skill_ids: Vec<String>,
    #[serde(default)]
    pub attachments: Vec<SessionAttachmentRef>,
}
impl SessionSubmitRequest {
    pub fn validate(&self) -> Result<(), RuntimeError> {
        validate_session_id(&self.session_id)?;
        validate_non_empty(&self.message_id, RuntimeErrorCode::RunFailed, "messageId")?;
        validate_non_empty(&self.content, RuntimeErrorCode::RunFailed, "content")?;
        if self.content.len() > MAX_EVENT_BYTES
            || self.skill_ids.len() > 100
            || self.attachments.len() > 20
        {
            return Err(RuntimeError::new(
                RuntimeErrorCode::RunFailed,
                "输入超出限制",
            ));
        }
        for id in &self.skill_ids {
            validate_non_empty(id, RuntimeErrorCode::RunFailed, "skillId")?;
        }
        for attachment in &self.attachments {
            validate_non_empty(
                &attachment.resource_id,
                RuntimeErrorCode::RunFailed,
                "resourceId",
            )?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionAttachmentRef {
    pub resource_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionAttachment {
    #[serde(alias = "resource_id")]
    pub resource_id: String,
    pub name: String,
    pub size: u64,
    #[serde(alias = "mime_type")]
    pub mime_type: String,
    pub url: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSubmitResult {
    pub accepted: bool,
    #[serde(alias = "message_id")]
    pub message_id: String,
    pub status: String,
    #[serde(alias = "run_id")]
    pub run_id: Option<String>,
    #[serde(default)]
    pub staged: bool,
    #[serde(default)]
    pub claimed: bool,
}
/// Which server view a Session window is read from.
///
/// `Events` is the raw, `seq`-contiguous log the realtime stream and gap
/// recovery depend on. `History` is the same window with adjacent token
/// deltas folded, which is what a 50-message page of a real session makes
/// affordable to load.
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SessionFeedView {
    #[default]
    Events,
    History,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionFeed {
    pub resource_base_url: String,
    pub target_id: String,
    pub runtime_epoch: String,
    pub session_id: String,
    pub events: Vec<Value>,
    pub hidden_run_ids: Vec<String>,
    pub base_seq: Option<u64>,
    pub last_seq: Option<u64>,
    pub has_more: bool,
    pub connection_status: String,
    #[serde(default)]
    pub persistence: Option<Value>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionFeedEvent {
    pub target_id: String,
    pub runtime_epoch: String,
    pub session_id: String,
    pub kind: String,
    pub events: Vec<Value>,
    pub hidden_run_ids: Vec<String>,
    pub summary: Option<Value>,
    pub connection_status: String,
    pub message: Option<String>,
}

#[cfg(test)]
mod history_request_tests {
    use super::*;

    #[test]
    fn history_request_validates_actions_and_result_aliases() {
        let value = serde_json::json!({"targetId":"bianbu", "sessionId":"s", "operationId":"op",
            "expectedSeq":12, "action":"edit", "messageId":"r:1", "content":"修改后的回答"});
        let request: SessionHistoryRequest = serde_json::from_value(value.clone()).unwrap();
        assert!(request.validate().is_ok());
        for (key, invalid) in [
            ("expectedSeq", serde_json::json!(true)),
            ("injected", serde_json::json!("thread")),
        ] {
            let mut input = value.clone();
            input[key] = invalid;
            assert!(serde_json::from_value::<SessionHistoryRequest>(input).is_err());
        }
        for action in [
            "delete",
            "regenerate",
            "continue",
            "switch_version",
            "unknown",
        ] {
            let mut request = request.clone();
            request.action = action.into();
            assert!(request.validate().is_err());
            request.content = None;
            assert_eq!(request.validate().is_ok(), action != "unknown");
        }
        let result: SessionHistoryResult = serde_json::from_value(serde_json::json!({
            "accepted":true,"operation_id":"op","seq":13,"run_id":"run"}))
        .unwrap();
        assert_eq!(result.operation_id, "op");
        assert_eq!(result.run_id.as_deref(), Some("run"));
    }
}
