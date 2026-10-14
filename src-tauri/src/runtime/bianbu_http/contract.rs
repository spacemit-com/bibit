//! 与当前 `bianbu-agent-runtime` HTTP 契约对齐的类型。
//!
//! 字段名以 `bianbu_agent/api/contracts.py` 为准；Run 视图复用现有
//! `RuntimeRunSnapshot`（其字段与 `RunView` 已对齐），避免重复建模。

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::super::contract::RuntimeRunSnapshot;

/// `/api/v1/runs` 的 Run 状态（`contracts.py::RunView.status`）。
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BianbuRunStatus {
    Queued,
    Running,
    Waiting,
    Completed,
    Failed,
    Cancelled,
}

impl BianbuRunStatus {
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }
}

/// `POST /api/v1/runs` 请求体（`contracts.py::RunCreateRequest`）。
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct RunCreateRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub session_id: String,
    pub prompt: String,
    pub idempotency_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub attachments: Vec<Value>,
    #[serde(default)]
    pub metadata: Value,
}

/// `RunEnvelope.data`：复用 `RuntimeRunSnapshot`（对应 `contracts.py::RunView`）。
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct RunEnvelope {
    pub data: RuntimeRunSnapshot,
}

/// `/api/v1/runtime/status` 视图（`contracts.py::RuntimeStatusView`）。
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct RuntimeStatusView {
    pub status: String,
    pub role: String,
    pub control_ready: bool,
    pub agent_ready: bool,
    #[serde(default)]
    pub instance_id: Option<String>,
    #[serde(default)]
    pub pid: Option<i64>,
    #[serde(default)]
    pub effective_mode: Option<String>,
    #[serde(default)]
    pub backend: Option<String>,
    #[serde(default)]
    pub sandboxed: bool,
    #[serde(default)]
    pub policy_digest: Option<String>,
    #[serde(default)]
    pub generation_id: Option<i64>,
    #[serde(default)]
    pub worker_state: String,
}

impl RuntimeStatusView {
    pub fn ready(&self) -> bool {
        self.control_ready && self.agent_ready
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct RuntimeStatusEnvelope {
    pub data: RuntimeStatusView,
}

/// `POST /runs/{id}/cancel` 响应（`contracts.py::RunControlEnvelope`）。
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct RunControlView {
    pub accepted: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct RunControlEnvelope {
    pub data: RunControlView,
}

/// 统一错误信封（`contracts.py::ErrorEnvelope`）。
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct ErrorView {
    pub code: String,
    pub message: String,
    #[serde(default)]
    pub details: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct ErrorEnvelope {
    pub error: ErrorView,
}

/// `GET /runs/{id}/events` 的 cursor 查询参数（`contracts.py::EventCursorQuery`）。
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct EventCursorQuery {
    pub cursor: u64,
}

impl Default for EventCursorQuery {
    fn default() -> Self {
        Self { cursor: 0 }
    }
}

/// 生成满足 `RunCreateRequest.idempotency_key` 约束的稳定幂等键。
///
/// 约束为长度 16-128 且匹配 `^[A-Za-z0-9._:-]+$`。以 run_id 的 SHA-256
/// 十六进制为指纹，同一 run_id 重试生成相同键，实现幂等提交。
pub fn idempotency_key(run_id: &str) -> String {
    let digest = Sha256::digest(run_id.as_bytes());
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("run:{hex}")
}

/// 从失败响应体提取可读错误信息。
///
/// 支持业务错误 `{"error":{"message":...}}` 与 FastAPI 校验错误
/// `{"detail":[{...}]}` 两种形状。
pub fn parse_error(value: &Value, fallback: &str) -> String {
    if let Some(message) = value.pointer("/error/message").and_then(Value::as_str) {
        return message.to_owned();
    }
    if let Some(details) = value.get("detail") {
        let detail = match details {
            Value::Array(items) => items
                .iter()
                .filter_map(|item| item.get("msg").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("; "),
            Value::String(text) => text.clone(),
            _ => details.to_string(),
        };
        if !detail.is_empty() {
            return detail;
        }
    }
    fallback.to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn run_envelope_parses_run_view_fields() {
        let body = json!({
            "data": {
                "id": "run-1",
                "session_id": "sess-1",
                "agent_id": "agent-1",
                "status": "running",
                "content": "hello",
                "event_cursor": 3,
                "created_at": 1.0,
                "updated_at": 2.0
            }
        });
        let envelope: RunEnvelope = serde_json::from_value(body).unwrap();
        assert_eq!(envelope.data.id, "run-1");
        assert_eq!(envelope.data.session_id, "sess-1");
        assert_eq!(envelope.data.event_cursor, 3);
    }

    #[test]
    fn run_status_terminal_set_is_correct() {
        assert!(BianbuRunStatus::Completed.is_terminal());
        assert!(BianbuRunStatus::Failed.is_terminal());
        assert!(BianbuRunStatus::Cancelled.is_terminal());
        assert!(!BianbuRunStatus::Queued.is_terminal());
        assert!(!BianbuRunStatus::Running.is_terminal());
        assert!(!BianbuRunStatus::Waiting.is_terminal());
    }

    #[test]
    fn status_envelope_reads_control_and_agent_readiness() {
        let body = json!({"data": {
            "status": "AGENT_READY",
            "role": "control",
            "control_ready": true,
            "agent_ready": true,
            "worker_state": "running"
        }});
        let envelope: RuntimeStatusEnvelope = serde_json::from_value(body).unwrap();
        assert!(envelope.data.ready());
    }

    #[test]
    fn idempotency_key_satisfies_runtime_constraints() {
        let key = idempotency_key("abc123");
        assert!(key.len() >= 16);
        assert!(key.len() <= 128);
        assert!(key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._:-".contains(c)));
        assert_eq!(key, idempotency_key("abc123"));
        assert_ne!(key, idempotency_key("abc124"));
    }

    #[test]
    fn parse_error_reads_business_and_validation_shapes() {
        let business = json!({"error": {"code": "x", "message": "boom"}});
        assert_eq!(parse_error(&business, "fb"), "boom");

        let validation = json!({"detail": [{"msg": "a"}, {"msg": "b"}]});
        assert_eq!(parse_error(&validation, "fb"), "a; b");

        assert_eq!(parse_error(&json!({}), "fallback"), "fallback");
    }
}
