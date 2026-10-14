#[cfg(feature = "desktop")]
use super::{DemoRuntimeEvent, DemoRuntimeMode};
use super::{DemoRuntimeRequest, DemoRuntimeService};
#[cfg(feature = "desktop")]
use crate::{
    core::threads::commands::create_message,
    status_popup::conversation::{
        demo_assistant_message, ConversationCoordinator, CONVERSATION_EVENT,
    },
};
#[cfg(feature = "desktop")]
use serde::Deserialize;
#[cfg(feature = "desktop")]
use serde_json::Value;
#[cfg(feature = "desktop")]
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Emitter;
#[cfg(feature = "desktop")]
use tauri::Manager;

pub const DEMO_RUNTIME_EVENT: &str = "demo-runtime-event";

#[cfg(feature = "desktop")]
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DemoConversationRequest {
    pub session_id: String,
    pub user_message_id: String,
    pub prompt: String,
    pub mode: DemoRuntimeMode,
}

#[cfg(feature = "desktop")]
impl DemoConversationRequest {
    fn runtime_request(&self) -> DemoRuntimeRequest {
        DemoRuntimeRequest {
            session_id: self.session_id.clone(),
            prompt: self.prompt.clone(),
            mode: self.mode,
        }
    }
}

#[cfg(feature = "desktop")]
fn terminal_assistant_message(
    request: &DemoConversationRequest,
    event: &DemoRuntimeEvent,
    timestamp: u64,
) -> Option<Value> {
    match event {
        DemoRuntimeEvent::MessageCompleted {
            run_id,
            session_id,
            content,
            ..
        } if session_id == &request.session_id => Some(demo_assistant_message(
            session_id,
            run_id,
            &request.user_message_id,
            content,
            timestamp,
        )),
        _ => None,
    }
}

#[cfg(feature = "desktop")]
fn current_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or_default()
}

#[tauri::command]
pub async fn start_demo_runtime(
    app: tauri::AppHandle,
    service: tauri::State<'_, DemoRuntimeService>,
    request: DemoRuntimeRequest,
) -> Result<String, String> {
    let mut receiver = service.start(request).map_err(|error| error.to_string())?;
    let run_id = receiver.run_id.clone();

    tauri::async_runtime::spawn(async move {
        while let Some(event) = receiver.events.recv().await {
            let terminal = event.is_terminal();
            if app.emit(DEMO_RUNTIME_EVENT, &event).is_err() || terminal {
                break;
            }
        }
    });

    Ok(run_id)
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn start_demo_conversation(
    app: tauri::AppHandle,
    service: tauri::State<'_, DemoRuntimeService>,
    _coordinator: tauri::State<'_, ConversationCoordinator>,
    request: DemoConversationRequest,
    origin_window: String,
) -> Result<String, String> {
    let mut receiver = service
        .start(request.runtime_request())
        .map_err(|error| error.to_string())?;
    let run_id = receiver.run_id.clone();

    tauri::async_runtime::spawn(async move {
        while let Some(event) = receiver.events.recv().await {
            let wrapped_event = app
                .state::<ConversationCoordinator>()
                .apply_runtime_event(origin_window.clone(), event.clone());

            if let Some(wrapped_event) = wrapped_event.as_ref() {
                if let Err(error) = app.emit(CONVERSATION_EVENT, wrapped_event) {
                    log::warn!("conversation.runtime_emit_failed error={error}");
                }
            }
            if let Err(error) = app.emit(DEMO_RUNTIME_EVENT, &event) {
                log::warn!("demo_runtime.source_emit_failed error={error}");
            }

            if wrapped_event.is_some() {
                if let Some(message) =
                    terminal_assistant_message(&request, &event, current_timestamp_ms())
                {
                    match create_message(app.clone(), message).await {
                        Ok(message) => {
                            let message_event = app
                                .state::<ConversationCoordinator>()
                                .message_created(origin_window.clone(), message);
                            if let Err(error) = app.emit(CONVERSATION_EVENT, &message_event) {
                                log::warn!("conversation.message_emit_failed error={error}");
                            }
                        }
                        Err(error) => {
                            log::error!("conversation.demo_message_persist_failed error={error}");
                        }
                    }
                }
            }

            if event.is_terminal() {
                break;
            }
        }
    });

    Ok(run_id)
}

#[tauri::command]
pub fn cancel_demo_runtime(service: tauri::State<'_, DemoRuntimeService>, run_id: String) -> bool {
    service.cancel(&run_id)
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn conversation_cancel_session_run(
    service: tauri::State<'_, DemoRuntimeService>,
    coordinator: tauri::State<'_, ConversationCoordinator>,
    session_id: String,
) -> bool {
    coordinator
        .active_run_id(&session_id)
        .is_some_and(|run_id| service.cancel(&run_id))
}

#[cfg(all(test, feature = "desktop"))]
mod tests {
    use super::*;
    use crate::demo_runtime::{DemoRuntimeEvent, DemoRuntimeMode};

    fn request() -> DemoConversationRequest {
        DemoConversationRequest {
            session_id: "thread-1".into(),
            user_message_id: "user-1".into(),
            prompt: "你好".into(),
            mode: DemoRuntimeMode::Streaming,
        }
    }

    #[test]
    fn conversation_request_preserves_runtime_input_and_user_parent() {
        let request = request();
        let runtime_request = request.runtime_request();

        assert_eq!(runtime_request.session_id, "thread-1");
        assert_eq!(runtime_request.prompt, "你好");
        assert_eq!(runtime_request.mode, DemoRuntimeMode::Streaming);
        assert_eq!(request.user_message_id, "user-1");
    }

    #[test]
    fn only_a_matching_completed_event_builds_the_terminal_message() {
        let request = request();
        let completed = DemoRuntimeEvent::MessageCompleted {
            run_id: "run-1".into(),
            session_id: "thread-1".into(),
            sequence: 2,
            content: "完成".into(),
        };
        let cancelled = DemoRuntimeEvent::RunCancelled {
            run_id: "run-1".into(),
            session_id: "thread-1".into(),
            sequence: 2,
        };

        let message = terminal_assistant_message(&request, &completed, 123).unwrap();
        assert_eq!(message["id"], "run-1");
        assert_eq!(message["metadata"]["parentId"], "user-1");
        assert!(terminal_assistant_message(&request, &cancelled, 123).is_none());

        let other_session = DemoRuntimeEvent::MessageCompleted {
            run_id: "run-2".into(),
            session_id: "thread-2".into(),
            sequence: 1,
            content: "错误会话".into(),
        };
        assert!(terminal_assistant_message(&request, &other_session, 123).is_none());
    }
}
