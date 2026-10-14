#[cfg(feature = "demo-runtime")]
use crate::demo_runtime::DemoRuntimeEvent;
use crate::{
    core::threads::commands::{create_message, delete_message, list_messages, modify_message},
    runtime::{RuntimeEvent, RuntimeEventEnvelope},
};
use serde::Serialize;
#[cfg(feature = "demo-runtime")]
use serde_json::json;
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, MutexGuard},
};
use tauri::{AppHandle, Emitter, State};

pub const CONVERSATION_EVENT: &str = "conversation-event";

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(tag = "type", rename_all_fields = "camelCase")]
pub enum ConversationEvent {
    #[serde(rename = "conversation.selected")]
    Selected {
        cursor: u64,
        origin_window: String,
        session_id: Option<String>,
        target_id: Option<String>,
    },
    #[serde(rename = "conversation.draft_changed")]
    DraftChanged {
        cursor: u64,
        origin_window: String,
        session_id: String,
        draft: String,
        target_id: Option<String>,
    },
    #[serde(rename = "conversation.message_created")]
    MessageCreated {
        cursor: u64,
        origin_window: String,
        message: Value,
    },
    #[serde(rename = "conversation.message_updated")]
    MessageUpdated {
        cursor: u64,
        origin_window: String,
        message: Value,
    },
    #[serde(rename = "conversation.message_deleted")]
    MessageDeleted {
        cursor: u64,
        origin_window: String,
        session_id: String,
        message_id: String,
    },
    #[serde(rename = "runtime.event")]
    Runtime {
        cursor: u64,
        origin_window: String,
        event: RuntimeEventEnvelope,
    },
}

impl ConversationEvent {
    pub const fn cursor(&self) -> u64 {
        match self {
            Self::Selected { cursor, .. }
            | Self::DraftChanged { cursor, .. }
            | Self::MessageCreated { cursor, .. }
            | Self::MessageUpdated { cursor, .. }
            | Self::MessageDeleted { cursor, .. }
            | Self::Runtime { cursor, .. } => *cursor,
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeProjectionStatus {
    Running,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ActiveRuntimeProjection {
    pub run_id: String,
    pub session_id: String,
    pub last_sequence: u64,
    pub content: String,
    pub status: RuntimeProjectionStatus,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSnapshot {
    pub cursor: u64,
    pub target_id: Option<String>,
    pub selected_session_id: Option<String>,
    pub drafts: HashMap<String, String>,
    pub messages: Vec<Value>,
    pub active_run: Option<ActiveRuntimeProjection>,
}

#[derive(Debug, Default)]
struct ConversationState {
    cursor: u64,
    selections: HashMap<String, WindowSelection>,
    drafts: HashMap<(Option<String>, String), String>,
    active_runs: HashMap<String, ActiveRuntimeProjection>,
    run_origins: HashMap<String, String>,
}

/// 每个窗口各自记住自己选中的会话。
#[derive(Clone, Debug, Default)]
struct WindowSelection {
    target_id: Option<String>,
    session_id: Option<String>,
}

/// 浮窗单独一份选中，其余窗口（主窗口与托盘弹窗）共用一份。
///
/// 浮窗是主窗口之上的临时插曲：它在自己那份会话里换会话，不应该把主窗口
/// 拽到别的页面上；托盘弹窗本来就是主窗口的迷你视图，跟随主窗口更合理。
fn selection_key(window: &str) -> &str {
    if window == "voice-overlay" {
        window
    } else {
        "main"
    }
}

#[derive(Debug, Default)]
pub struct ConversationCoordinator {
    state: Mutex<ConversationState>,
}

impl ConversationCoordinator {
    fn lock_state(&self) -> MutexGuard<'_, ConversationState> {
        self.state
            .lock()
            .expect("conversation coordinator mutex poisoned")
    }

    fn advance_cursor(state: &mut ConversationState) -> u64 {
        state.cursor = state
            .cursor
            .checked_add(1)
            .expect("conversation cursor exhausted");
        state.cursor
    }

    pub fn record_run_origin(&self, run_id: impl Into<String>, origin_window: impl Into<String>) {
        let mut state = self.lock_state();
        state.run_origins.insert(run_id.into(), origin_window.into());
    }

    pub fn run_origin(&self, run_id: Option<&str>) -> Option<String> {
        let state = self.lock_state();
        run_id.and_then(|id| state.run_origins.get(id).cloned())
    }

    pub fn select_session(
        &self,
        origin_window: impl Into<String>,
        session_id: Option<String>,
    ) -> ConversationEvent {
        self.select_session_for(origin_window, session_id, None)
    }

    pub fn select_session_for(
        &self,
        origin_window: impl Into<String>,
        session_id: Option<String>,
        target_id: Option<String>,
    ) -> ConversationEvent {
        let origin_window = origin_window.into();
        let mut state = self.lock_state();
        state.selections.insert(
            selection_key(&origin_window).to_owned(),
            WindowSelection {
                target_id: target_id.clone(),
                session_id: session_id.clone(),
            },
        );
        let cursor = Self::advance_cursor(&mut state);
        ConversationEvent::Selected {
            cursor,
            origin_window,
            session_id,
            target_id,
        }
    }

    pub fn update_draft(
        &self,
        origin_window: impl Into<String>,
        session_id: impl Into<String>,
        draft: String,
    ) -> ConversationEvent {
        self.update_draft_for(origin_window, session_id, draft, None)
    }

    pub fn update_draft_for(
        &self,
        origin_window: impl Into<String>,
        session_id: impl Into<String>,
        draft: String,
        target_id: Option<String>,
    ) -> ConversationEvent {
        let mut state = self.lock_state();
        let session_id = session_id.into();
        state
            .drafts
            .insert((target_id.clone(), session_id.clone()), draft.clone());
        let cursor = Self::advance_cursor(&mut state);
        ConversationEvent::DraftChanged {
            cursor,
            origin_window: origin_window.into(),
            session_id,
            draft,
            target_id,
        }
    }

    pub fn message_created(
        &self,
        origin_window: impl Into<String>,
        message: Value,
    ) -> ConversationEvent {
        let mut state = self.lock_state();
        let cursor = Self::advance_cursor(&mut state);
        ConversationEvent::MessageCreated {
            cursor,
            origin_window: origin_window.into(),
            message,
        }
    }

    pub fn message_updated(
        &self,
        origin_window: impl Into<String>,
        message: Value,
    ) -> ConversationEvent {
        let mut state = self.lock_state();
        let cursor = Self::advance_cursor(&mut state);
        ConversationEvent::MessageUpdated {
            cursor,
            origin_window: origin_window.into(),
            message,
        }
    }

    pub fn message_deleted(
        &self,
        origin_window: impl Into<String>,
        session_id: String,
        message_id: String,
    ) -> ConversationEvent {
        let mut state = self.lock_state();
        let cursor = Self::advance_cursor(&mut state);
        ConversationEvent::MessageDeleted {
            cursor,
            origin_window: origin_window.into(),
            session_id,
            message_id,
        }
    }

    pub fn apply_runtime_envelope(
        &self,
        origin_window: impl Into<String>,
        event: RuntimeEventEnvelope,
    ) -> Option<ConversationEvent> {
        let mut state = self.lock_state();
        let session_id = event.session_id.clone();
        let run_id = event.run_id.clone();
        let sequence = event.sequence;
        let accepted = match (&event.event, run_id.as_deref()) {
            (RuntimeEvent::RunStarted { .. }, Some(run_id)) if sequence == 0 => {
                let duplicate = state
                    .active_runs
                    .get(&session_id)
                    .is_some_and(|active| active.run_id == run_id);
                if duplicate {
                    false
                } else {
                    state.active_runs.insert(
                        session_id.clone(),
                        ActiveRuntimeProjection {
                            run_id: run_id.to_owned(),
                            session_id: session_id.clone(),
                            last_sequence: sequence,
                            content: String::new(),
                            status: RuntimeProjectionStatus::Running,
                        },
                    );
                    true
                }
            }
            (RuntimeEvent::TextDelta { delta, .. }, Some(run_id)) => state
                .active_runs
                .get_mut(&session_id)
                .is_some_and(|active| {
                    if active.run_id == run_id && sequence == active.last_sequence.saturating_add(1)
                    {
                        active.last_sequence = sequence;
                        active.content.push_str(delta);
                        true
                    } else {
                        false
                    }
                }),
            (event, Some(run_id)) if event.is_terminal() => {
                let terminal_matches = state.active_runs.get(&session_id).is_some_and(|active| {
                    active.run_id == run_id && sequence == active.last_sequence.saturating_add(1)
                });
                if terminal_matches {
                    state.active_runs.remove(&session_id);
                    state.run_origins.remove(run_id);
                }
                terminal_matches
            }
            (_, Some(run_id)) => state
                .active_runs
                .get_mut(&session_id)
                .is_some_and(|active| {
                    if active.run_id == run_id && sequence == active.last_sequence.saturating_add(1)
                    {
                        active.last_sequence = sequence;
                        true
                    } else {
                        false
                    }
                }),
            _ => false,
        };

        if !accepted {
            return None;
        }
        let cursor = Self::advance_cursor(&mut state);
        Some(ConversationEvent::Runtime {
            cursor,
            origin_window: origin_window.into(),
            event,
        })
    }

    #[cfg(feature = "demo-runtime")]
    pub fn apply_runtime_event(
        &self,
        origin_window: impl Into<String>,
        event: DemoRuntimeEvent,
    ) -> Option<ConversationEvent> {
        let envelope = demo_runtime_envelope(event);
        self.apply_runtime_envelope(origin_window, envelope)
    }

    pub fn active_run_id(&self, session_id: &str) -> Option<String> {
        self.lock_state()
            .active_runs
            .get(session_id)
            .map(|active| active.run_id.clone())
    }

    pub fn state_snapshot(&self) -> ConversationSnapshot {
        self.state_snapshot_for_window("main", None, None)
    }

    pub fn state_snapshot_for_window(
        &self,
        window: &str,
        session_id: Option<&str>,
        target_id: Option<&str>,
    ) -> ConversationSnapshot {
        let state = self.lock_state();
        let selection = state
            .selections
            .get(selection_key(window))
            .cloned()
            .unwrap_or_default();
        let target_id = target_id
            .map(str::to_owned)
            .or_else(|| selection.target_id.clone());
        let selected_session_id =
            if target_id.as_deref() == selection.target_id.as_deref() {
                selection.session_id.clone()
            } else {
                None
            };
        let target_session_id = session_id.or(selected_session_id.as_deref());
        let drafts = state
            .drafts
            .iter()
            .filter(|((draft_target, _), _)| draft_target.as_deref() == target_id.as_deref())
            .map(|((_, session_id), draft)| (session_id.clone(), draft.clone()))
            .collect();
        let active_run = target_session_id
            .and_then(|target| state.active_runs.get(target))
            .cloned();
        ConversationSnapshot {
            cursor: state.cursor,
            target_id,
            selected_session_id,
            drafts,
            messages: Vec::new(),
            active_run,
        }
    }
}

#[cfg(feature = "demo-runtime")]
fn demo_runtime_envelope(event: DemoRuntimeEvent) -> RuntimeEventEnvelope {
    let (run_id, session_id, sequence, runtime_event) = match event {
        DemoRuntimeEvent::RunStarted {
            run_id,
            session_id,
            sequence,
        } => (
            run_id,
            session_id,
            sequence,
            RuntimeEvent::RunStarted {
                user_message_id: "demo".into(),
            },
        ),
        DemoRuntimeEvent::MessageDelta {
            run_id,
            session_id,
            sequence,
            delta,
        } => (
            run_id,
            session_id,
            sequence,
            RuntimeEvent::TextDelta {
                message_id: "demo-assistant".into(),
                delta,
            },
        ),
        DemoRuntimeEvent::MessageCompleted {
            run_id,
            session_id,
            sequence,
            ..
        } => (
            run_id,
            session_id,
            sequence,
            RuntimeEvent::RunCompleted {
                stop_reason: Some("demo".into()),
            },
        ),
        DemoRuntimeEvent::RunCancelled {
            run_id,
            session_id,
            sequence,
        } => (
            run_id,
            session_id,
            sequence,
            RuntimeEvent::RunCancelled {
                reason: Some("demo".into()),
            },
        ),
        DemoRuntimeEvent::RunFailed {
            run_id,
            session_id,
            sequence,
            message,
        } => (
            run_id,
            session_id,
            sequence,
            RuntimeEvent::RunFailed {
                error: crate::runtime::RuntimeError::new(
                    crate::runtime::RuntimeErrorCode::RunFailed,
                    message,
                ),
            },
        ),
    };
    RuntimeEventEnvelope::new_run("demo", session_id, run_id, sequence, runtime_event)
}

#[cfg(feature = "demo-runtime")]
pub fn demo_assistant_message(
    session_id: &str,
    run_id: &str,
    user_message_id: &str,
    content: &str,
    timestamp: u64,
) -> Value {
    json!({
        "id": run_id,
        "object": "thread.message",
        "thread_id": session_id,
        "role": "assistant",
        "content": [{
            "type": "text",
            "text": {
                "value": content,
                "annotations": []
            }
        }],
        "status": "ready",
        "created_at": timestamp,
        "completed_at": timestamp,
        "metadata": {
            "parentId": user_message_id,
            "runtime": "demo"
        },
        "type": "text"
    })
}

fn emit_event(app: &AppHandle, event: &ConversationEvent) -> Result<(), String> {
    app.emit(CONVERSATION_EVENT, event)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn conversation_snapshot(
    app: AppHandle,
    coordinator: State<'_, ConversationCoordinator>,
    session_id: Option<String>,
    manager: State<'_, Arc<crate::runtime::manager::RuntimeManager>>,
    expected_target_id: Option<String>,
    origin_window: Option<String>,
) -> Result<ConversationSnapshot, String> {
    // 每个窗口拿到的是自己那一份选中：浮窗换会话不会改变主窗口的投影。
    let window = origin_window.unwrap_or_else(|| "main".to_owned());
    if let Some(target) = expected_target_id {
        let gateway = manager
            .active_gateway()
            .await
            .map_err(|error| error.message)?;
        if gateway.target_id() != target {
            return Err("Runtime 目标已改变".into());
        }
        return Ok(coordinator.state_snapshot_for_window(
            &window,
            session_id.as_deref(),
            Some(&target),
        ));
    }
    let mut snapshot = coordinator.state_snapshot_for_window(&window, session_id.as_deref(), None);
    if snapshot.target_id.is_some() {
        snapshot.selected_session_id = None;
        snapshot.active_run = None;
    }
    let target_session_id = session_id.or_else(|| snapshot.selected_session_id.clone());
    if let Some(target_session_id) = target_session_id {
        snapshot.messages = list_messages(app, target_session_id).await?;
    }
    Ok(snapshot)
}

#[tauri::command]
pub async fn conversation_select_session(
    app: AppHandle,
    coordinator: State<'_, ConversationCoordinator>,
    origin_window: String,
    session_id: Option<String>,
    manager: State<'_, Arc<crate::runtime::manager::RuntimeManager>>,
    expected_target_id: Option<String>,
) -> Result<(), String> {
    if let Some(target) = expected_target_id.as_deref() {
        let gateway = manager
            .active_gateway()
            .await
            .map_err(|error| error.message)?;
        if gateway.target_id() != target {
            return Err("Runtime 目标已改变".into());
        }
    }
    let event = coordinator.select_session_for(origin_window, session_id, expected_target_id);
    emit_event(&app, &event)
}

#[tauri::command]
pub async fn conversation_update_draft(
    app: AppHandle,
    coordinator: State<'_, ConversationCoordinator>,
    origin_window: String,
    session_id: String,
    draft: String,
    manager: State<'_, Arc<crate::runtime::manager::RuntimeManager>>,
    expected_target_id: Option<String>,
) -> Result<(), String> {
    if let Some(target) = expected_target_id.as_deref() {
        let gateway = manager
            .active_gateway()
            .await
            .map_err(|error| error.message)?;
        if gateway.target_id() != target {
            return Err("Runtime 目标已改变".into());
        }
    }
    let event = coordinator.update_draft_for(origin_window, session_id, draft, expected_target_id);
    emit_event(&app, &event)
}

#[tauri::command]
pub async fn conversation_create_message(
    app: AppHandle,
    coordinator: State<'_, ConversationCoordinator>,
    origin_window: String,
    message: Value,
) -> Result<Value, String> {
    let message = create_message(app.clone(), message).await?;
    let event = coordinator.message_created(origin_window, message.clone());
    emit_event(&app, &event)?;
    Ok(message)
}

#[tauri::command]
pub async fn conversation_modify_message(
    app: AppHandle,
    coordinator: State<'_, ConversationCoordinator>,
    origin_window: String,
    message: Value,
) -> Result<Value, String> {
    let message = modify_message(app.clone(), message).await?;
    let event = coordinator.message_updated(origin_window, message.clone());
    emit_event(&app, &event)?;
    Ok(message)
}

#[tauri::command]
pub async fn conversation_delete_message(
    app: AppHandle,
    coordinator: State<'_, ConversationCoordinator>,
    origin_window: String,
    session_id: String,
    message_id: String,
) -> Result<(), String> {
    delete_message(app.clone(), session_id.clone(), message_id.clone()).await?;
    let event = coordinator.message_deleted(origin_window, session_id, message_id);
    emit_event(&app, &event)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(feature = "demo-runtime")]
    use crate::demo_runtime::DemoRuntimeEvent;

    #[test]
    fn session_selection_keeps_runtime_target_identity() {
        let coordinator = ConversationCoordinator::default();
        let event =
            coordinator.select_session_for("main", Some("same-id".into()), Some("target-a".into()));
        assert_eq!(serde_json::to_value(event).unwrap()["targetId"], "target-a");
        let snapshot = coordinator.state_snapshot();
        assert_eq!(snapshot.target_id.as_deref(), Some("target-a"));
        coordinator.select_session_for("main", Some("same-id".into()), Some("target-b".into()));
        assert_eq!(
            coordinator.state_snapshot().target_id.as_deref(),
            Some("target-b")
        );
        coordinator.select_session("main", Some("hermes-id".into()));
        assert!(coordinator.state_snapshot().target_id.is_none());
    }

    #[test]
    fn coordinator_cursor_is_monotonic_and_drafts_are_per_session() {
        let coordinator = ConversationCoordinator::default();
        let first = coordinator.select_session("main", Some("thread-1".into()));
        let second = coordinator.update_draft("status-popup", "thread-1", "草稿".into());

        assert!(second.cursor() > first.cursor());
        let snapshot = coordinator.state_snapshot();
        assert_eq!(snapshot.selected_session_id.as_deref(), Some("thread-1"));
        assert_eq!(
            snapshot.drafts.get("thread-1").map(String::as_str),
            Some("草稿")
        );
    }

    #[test]
    fn runtime_drafts_are_isolated_by_target() {
        let coordinator = ConversationCoordinator::default();
        coordinator.select_session_for("main", Some("same-id".into()), Some("target-a".into()));
        coordinator.update_draft_for(
            "voice-overlay",
            "same-id",
            "目标 A".into(),
            Some("target-a".into()),
        );
        coordinator.update_draft_for(
            "voice-overlay",
            "same-id",
            "目标 B".into(),
            Some("target-b".into()),
        );

        let target_a =
            coordinator.state_snapshot_for_window("main", Some("same-id"), Some("target-a"));
        let target_b =
            coordinator.state_snapshot_for_window("main", Some("same-id"), Some("target-b"));
        assert_eq!(target_a.selected_session_id.as_deref(), Some("same-id"));
        assert_eq!(
            target_a.drafts.get("same-id").map(String::as_str),
            Some("目标 A")
        );
        assert!(target_b.selected_session_id.is_none());
        assert_eq!(
            target_b.drafts.get("same-id").map(String::as_str),
            Some("目标 B")
        );
    }

    #[test]
    fn overlay_selection_does_not_move_the_main_window() {
        let coordinator = ConversationCoordinator::default();
        coordinator.select_session("main", Some("main-thread".into()));
        coordinator.select_session_for(
            "voice-overlay",
            Some("voice-thread".into()),
            Some("target-a".into()),
        );

        let main = coordinator.state_snapshot_for_window("main", None, None);
        assert_eq!(main.selected_session_id.as_deref(), Some("main-thread"));
        assert!(main.target_id.is_none());

        let overlay = coordinator.state_snapshot_for_window("voice-overlay", None, None);
        assert_eq!(
            overlay.selected_session_id.as_deref(),
            Some("voice-thread")
        );
        assert_eq!(overlay.target_id.as_deref(), Some("target-a"));

        // 托盘弹窗是主窗口的迷你视图，仍然跟随主窗口那一份选中。
        let popup = coordinator.state_snapshot_for_window("status-popup", None, None);
        assert_eq!(popup.selected_session_id.as_deref(), Some("main-thread"));
    }

    #[cfg(feature = "demo-runtime")]
    #[test]
    fn demo_assistant_message_uses_run_id_and_user_parent() {
        let message = demo_assistant_message("thread-1", "run-1", "user-1", "完成", 123);

        assert_eq!(message["id"], "run-1");
        assert_eq!(message["thread_id"], "thread-1");
        assert_eq!(message["metadata"]["parentId"], "user-1");
    }

    #[test]
    fn conversation_events_serialize_camel_case_fields() {
        let coordinator = ConversationCoordinator::default();
        let event = coordinator.select_session("status-popup", Some("thread-1".into()));
        let value = serde_json::to_value(event).unwrap();

        assert_eq!(value["type"], "conversation.selected");
        assert_eq!(value["originWindow"], "status-popup");
        assert_eq!(value["sessionId"], "thread-1");
        assert!(value.get("origin_window").is_none());
    }

    #[cfg(feature = "demo-runtime")]
    #[test]
    fn runtime_projection_accepts_ordered_events_and_drops_terminal_state() {
        let coordinator = ConversationCoordinator::default();
        let started = DemoRuntimeEvent::RunStarted {
            run_id: "run-1".into(),
            session_id: "thread-1".into(),
            sequence: 0,
        };
        let delta = DemoRuntimeEvent::MessageDelta {
            run_id: "run-1".into(),
            session_id: "thread-1".into(),
            sequence: 1,
            delta: "你好".into(),
        };

        assert!(coordinator.apply_runtime_event("main", started).is_some());
        assert!(coordinator
            .apply_runtime_event("main", delta.clone())
            .is_some());
        assert!(coordinator.apply_runtime_event("main", delta).is_none());

        let active = coordinator
            .state_snapshot_for_window("main", Some("thread-1"), None)
            .active_run
            .unwrap();
        assert_eq!(active.content, "你好");
        assert_eq!(active.last_sequence, 1);
        assert_eq!(
            coordinator.active_run_id("thread-1").as_deref(),
            Some("run-1")
        );

        let completed = DemoRuntimeEvent::MessageCompleted {
            run_id: "run-1".into(),
            session_id: "thread-1".into(),
            sequence: 2,
            content: "你好".into(),
        };
        assert!(coordinator
            .apply_runtime_event("main", completed.clone())
            .is_some());
        assert!(coordinator.apply_runtime_event("main", completed).is_none());
        assert!(coordinator
            .state_snapshot_for_window("main", Some("thread-1"), None)
            .active_run
            .is_none());
    }
}
