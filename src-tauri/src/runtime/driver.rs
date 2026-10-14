use super::{
    DiagnosticLevel, PermissionDecision, RuntimeCapabilities, RuntimeConnectionStatus,
    RuntimeError, RuntimeErrorCode, RuntimeMessage, RuntimeSession,
};
use async_trait::async_trait;
use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;
use tokio::sync::mpsc;

pub type DriverSessionId = String;

#[derive(Clone, Debug)]
pub struct DriverPromptRequest {
    pub run_id: String,
    pub session_id: DriverSessionId,
    pub prompt: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriverPermissionRequest {
    pub request_id: String,
    pub tool_call_id: String,
    pub title: String,
    pub description: String,
    pub tool_name: String,
    pub input_summary: Option<Value>,
    pub can_allow_once: bool,
    pub can_deny: bool,
    /// Runtime decisions that the Host does not understand and must never expose as Allow.
    pub unsupported_decisions: Vec<String>,
    #[serde(skip)]
    pub(crate) allow_once_option_id: Option<String>,
    #[serde(skip)]
    pub(crate) reject_once_option_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum DriverEvent {
    TextDelta {
        run_id: String,
        message_id: String,
        delta: String,
    },
    ReasoningDelta {
        run_id: String,
        message_id: String,
        delta: String,
    },
    ToolStarted {
        run_id: String,
        tool_call_id: String,
        name: String,
        input: Option<Value>,
    },
    ToolUpdated {
        run_id: String,
        tool_call_id: String,
        update: Value,
    },
    ToolCompleted {
        run_id: String,
        tool_call_id: String,
        result: Option<Value>,
        error: Option<String>,
    },
    PermissionRequested {
        run_id: String,
        request: DriverPermissionRequest,
    },
    PermissionExpired {
        run_id: String,
        request_id: String,
    },
    PermissionResolved {
        run_id: String,
        request_id: String,
        decision: PermissionDecision,
    },
    ConnectionStatusChanged {
        run_id: String,
        status: RuntimeConnectionStatus,
        message: Option<String>,
    },
    DiagnosticNotice {
        run_id: String,
        level: DiagnosticLevel,
        message: String,
    },
    Completed {
        run_id: String,
        stop_reason: String,
    },
    Cancelled {
        run_id: String,
        reason: String,
    },
    Failed {
        run_id: String,
        error: RuntimeError,
    },
}

#[derive(Clone, Debug)]
pub enum DriverLifecycleEvent {
    ProcessExited(RuntimeError),
}

#[derive(Debug)]
pub struct DriverStart {
    pub lifecycle_events: mpsc::UnboundedReceiver<DriverLifecycleEvent>,
}

#[async_trait]
pub trait RuntimeDriver: Send + Sync {
    fn runtime_id(&self) -> &'static str {
        "hermes"
    }

    fn capabilities(&self) -> RuntimeCapabilities {
        RuntimeCapabilities::default()
    }

    async fn list_skills(&self) -> Result<Vec<Value>, RuntimeError> {
        Err(unsupported("Skill catalog"))
    }
    fn target_id(&self) -> String {
        self.runtime_id().into()
    }
    async fn session_feed(
        &self,
        _session_id: &str,
        _before_seq: Option<u64>,
        _view: super::SessionFeedView,
    ) -> Result<super::SessionFeed, RuntimeError> {
        Err(unsupported("Session events"))
    }
    async fn session_history(
        &self,
        _request: super::SessionHistoryRequest,
    ) -> Result<super::SessionHistoryResult, RuntimeError> {
        Err(unsupported("Session history changes"))
    }
    async fn search_sessions(
        &self,
        _query: &str,
        _limit: u32,
    ) -> Result<Vec<super::RuntimeSearchHit>, RuntimeError> {
        Err(unsupported("Session search"))
    }
    async fn session_submit(
        &self,
        _request: super::SessionSubmitRequest,
    ) -> Result<super::SessionSubmitResult, RuntimeError> {
        Err(unsupported("Session inbox"))
    }
    async fn session_attachment_upload(
        &self,
        _session_id: &str,
        _source: &std::path::Path,
        _source_name: &str,
    ) -> Result<super::SessionAttachment, RuntimeError> {
        Err(unsupported("Session attachments"))
    }
    async fn session_attachment_delete(
        &self,
        _session_id: &str,
        _resource_id: &str,
    ) -> Result<(), RuntimeError> {
        Err(unsupported("Session attachments"))
    }
    async fn session_downlink(
        &self,
    ) -> Result<mpsc::Receiver<super::SessionFeedEvent>, RuntimeError> {
        Err(unsupported("Session downlink"))
    }
    async fn session_cancel(&self, _session_id: &str, _run_id: &str) -> Result<(), RuntimeError> {
        Err(unsupported("Session cancel"))
    }
    async fn session_approval(
        &self,
        _session_id: &str,
        _approval_id: &str,
        _decision: PermissionDecision,
    ) -> Result<(), RuntimeError> {
        Err(unsupported("Session approval"))
    }

    async fn check(&self) -> Result<(), RuntimeError>;
    async fn start(&self) -> Result<DriverStart, RuntimeError>;
    async fn stop(&self) -> Result<(), RuntimeError>;
    async fn create_session(
        &self,
        session_id: &str,
        title: Option<&str>,
        cwd: PathBuf,
    ) -> Result<DriverSessionId, RuntimeError>;
    async fn create_session_for_agent(
        &self,
        session_id: &str,
        title: Option<&str>,
        agent_id: Option<&str>,
        cwd: PathBuf,
    ) -> Result<DriverSessionId, RuntimeError> {
        if agent_id.is_some() {
            return Err(unsupported("Agent selection"));
        }
        self.create_session(session_id, title, cwd).await
    }
    async fn list_agents(&self) -> Result<Vec<super::RuntimeAgent>, RuntimeError> {
        Err(unsupported("Agent listing"))
    }
    async fn delete_session(&self, _session_id: &str) -> Result<(), RuntimeError> {
        Err(unsupported("Session deletion"))
    }
    async fn clear_context(&self, _session_id: &str) -> Result<RuntimeSession, RuntimeError> {
        Err(unsupported("Context clearing"))
    }
    async fn generate_title(
        &self,
        _session_id: &str,
        _message_id: &str,
        _content: &str,
    ) -> Result<super::SessionTitleResult, RuntimeError> {
        Err(unsupported("Title generation"))
    }
    async fn rename_session(&self, _session_id: &str, _title: &str) -> Result<(), RuntimeError> {
        Err(unsupported("Session rename"))
    }
    async fn list_sessions(&self) -> Result<Vec<RuntimeSession>, RuntimeError> {
        Err(unsupported("Session listing"))
    }
    async fn get_session(&self, _session_id: &str) -> Result<RuntimeSession, RuntimeError> {
        Err(unsupported("Session restore"))
    }
    async fn list_messages(&self, _session_id: &str) -> Result<Vec<RuntimeMessage>, RuntimeError> {
        Err(unsupported("Message history"))
    }
    async fn attach_run(
        &self,
        _run_id: &str,
        _cursor: u64,
    ) -> Result<mpsc::UnboundedReceiver<DriverEvent>, RuntimeError> {
        Err(unsupported("Run attach"))
    }
    async fn prompt(
        &self,
        request: DriverPromptRequest,
    ) -> Result<mpsc::UnboundedReceiver<DriverEvent>, RuntimeError>;
    async fn subscribe_session_run(
        &self,
        _run_id: String,
        _session_id: String,
        _backend_run_id: String,
    ) -> Result<mpsc::UnboundedReceiver<DriverEvent>, RuntimeError> {
        Err(unsupported("Session event stream"))
    }
    async fn cancel(&self, session_id: &str, run_id: &str) -> Result<(), RuntimeError>;
    async fn resolve_permission(
        &self,
        request_id: &str,
        decision: PermissionDecision,
    ) -> Result<(), RuntimeError>;
    async fn cancel_permission(&self, request_id: &str) -> Result<(), RuntimeError>;
}

fn unsupported(capability: &str) -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::AcpCapabilityMissing,
        format!("{capability} is not supported by this Runtime"),
    )
}
