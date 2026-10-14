use clap::ValueEnum;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use thiserror::Error;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

#[cfg(feature = "demo-runtime")]
pub mod cli;
#[cfg(feature = "demo-runtime")]
pub mod commands;

const RESPONSE_SUFFIX: &str = "这是 BiBit 演示 Runtime 的模拟回复，当前未连接正式 Agent Runtime。";
const STREAM_CHUNK_CHARACTERS: usize = 6;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, ValueEnum)]
#[serde(rename_all = "snake_case")]
pub enum DemoRuntimeMode {
    Fixed,
    Streaming,
}

impl Default for DemoRuntimeMode {
    fn default() -> Self {
        Self::Streaming
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DemoRuntimeRequest {
    pub session_id: String,
    pub prompt: String,
    pub mode: DemoRuntimeMode,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum DemoRuntimeEvent {
    RunStarted {
        run_id: String,
        session_id: String,
        sequence: u64,
    },
    MessageDelta {
        run_id: String,
        session_id: String,
        sequence: u64,
        delta: String,
    },
    MessageCompleted {
        run_id: String,
        session_id: String,
        sequence: u64,
        content: String,
    },
    RunCancelled {
        run_id: String,
        session_id: String,
        sequence: u64,
    },
    RunFailed {
        run_id: String,
        session_id: String,
        sequence: u64,
        message: String,
    },
}

impl DemoRuntimeEvent {
    pub fn sequence(&self) -> u64 {
        match self {
            Self::RunStarted { sequence, .. }
            | Self::MessageDelta { sequence, .. }
            | Self::MessageCompleted { sequence, .. }
            | Self::RunCancelled { sequence, .. }
            | Self::RunFailed { sequence, .. } => *sequence,
        }
    }

    pub fn run_id(&self) -> &str {
        match self {
            Self::RunStarted { run_id, .. }
            | Self::MessageDelta { run_id, .. }
            | Self::MessageCompleted { run_id, .. }
            | Self::RunCancelled { run_id, .. }
            | Self::RunFailed { run_id, .. } => run_id,
        }
    }

    pub fn session_id(&self) -> &str {
        match self {
            Self::RunStarted { session_id, .. }
            | Self::MessageDelta { session_id, .. }
            | Self::MessageCompleted { session_id, .. }
            | Self::RunCancelled { session_id, .. }
            | Self::RunFailed { session_id, .. } => session_id,
        }
    }

    pub fn delta(&self) -> Option<&str> {
        match self {
            Self::MessageDelta { delta, .. } => Some(delta),
            _ => None,
        }
    }

    pub fn completed_content(&self) -> Option<&str> {
        match self {
            Self::MessageCompleted { content, .. } => Some(content),
            _ => None,
        }
    }

    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            Self::MessageCompleted { .. } | Self::RunCancelled { .. } | Self::RunFailed { .. }
        )
    }

    pub fn is_completed(&self) -> bool {
        matches!(self, Self::MessageCompleted { .. })
    }

    pub fn is_cancelled(&self) -> bool {
        matches!(self, Self::RunCancelled { .. })
    }
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum DemoRuntimeError {
    #[error("消息不能为空")]
    EmptyPrompt,
}

pub fn normalize_prompt(prompt: &str) -> Result<&str, DemoRuntimeError> {
    let normalized = prompt.trim();
    if normalized.is_empty() {
        Err(DemoRuntimeError::EmptyPrompt)
    } else {
        Ok(normalized)
    }
}

pub fn render_response(prompt: &str) -> Result<String, DemoRuntimeError> {
    let prompt = normalize_prompt(prompt)?;
    Ok(format!("已收到你的消息：“{prompt}”\n\n{RESPONSE_SUFFIX}"))
}

fn split_response(response: &str) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut current = String::new();

    for character in response.chars() {
        current.push(character);
        if current.chars().count() == STREAM_CHUNK_CHARACTERS {
            chunks.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

pub fn event_plan(request: DemoRuntimeRequest) -> Result<Vec<DemoRuntimeEvent>, DemoRuntimeError> {
    let content = render_response(&request.prompt)?;
    let run_id = uuid::Uuid::new_v4().to_string();
    let session_id = request.session_id;
    let mut sequence = 0_u64;
    let mut events = vec![DemoRuntimeEvent::RunStarted {
        run_id: run_id.clone(),
        session_id: session_id.clone(),
        sequence,
    }];

    if request.mode == DemoRuntimeMode::Streaming {
        for delta in split_response(&content) {
            sequence += 1;
            events.push(DemoRuntimeEvent::MessageDelta {
                run_id: run_id.clone(),
                session_id: session_id.clone(),
                sequence,
                delta,
            });
        }
    }

    sequence += 1;
    events.push(DemoRuntimeEvent::MessageCompleted {
        run_id,
        session_id,
        sequence,
        content,
    });
    Ok(events)
}

pub struct DemoRuntimeReceiver {
    pub run_id: String,
    pub events: mpsc::UnboundedReceiver<DemoRuntimeEvent>,
}

#[derive(Clone)]
pub struct DemoRuntimeService {
    active_runs: Arc<Mutex<HashMap<String, CancellationToken>>>,
    chunk_delay: Duration,
}

impl Default for DemoRuntimeService {
    fn default() -> Self {
        Self::new(Duration::from_millis(35))
    }
}

impl DemoRuntimeService {
    pub fn new(chunk_delay: Duration) -> Self {
        Self {
            active_runs: Arc::new(Mutex::new(HashMap::new())),
            chunk_delay,
        }
    }

    pub fn start(
        &self,
        request: DemoRuntimeRequest,
    ) -> Result<DemoRuntimeReceiver, DemoRuntimeError> {
        let mode = request.mode;
        let events = event_plan(request)?;
        let run_id = events[0].run_id().to_owned();
        let session_id = events[0].session_id().to_owned();
        let cancellation = CancellationToken::new();
        self.active_runs
            .lock()
            .expect("demo runtime active-runs mutex poisoned")
            .insert(run_id.clone(), cancellation.clone());

        let active_runs = Arc::clone(&self.active_runs);
        let tracked_run_id = run_id.clone();
        let chunk_delay = self.chunk_delay;
        let (sender, receiver) = mpsc::unbounded_channel();

        tokio::spawn(async move {
            let mut last_sequence = 0_u64;
            for (index, event) in events.into_iter().enumerate() {
                if index > 0 && mode == DemoRuntimeMode::Streaming {
                    tokio::select! {
                        _ = cancellation.cancelled() => {
                            let _ = sender.send(DemoRuntimeEvent::RunCancelled {
                                run_id: tracked_run_id.clone(),
                                session_id: session_id.clone(),
                                sequence: last_sequence + 1,
                            });
                            break;
                        }
                        _ = tokio::time::sleep(chunk_delay) => {}
                    }
                }

                if cancellation.is_cancelled() {
                    let _ = sender.send(DemoRuntimeEvent::RunCancelled {
                        run_id: tracked_run_id.clone(),
                        session_id: session_id.clone(),
                        sequence: last_sequence + 1,
                    });
                    break;
                }

                last_sequence = event.sequence();
                let terminal = event.is_terminal();
                if sender.send(event).is_err() || terminal {
                    break;
                }
            }

            active_runs
                .lock()
                .expect("demo runtime active-runs mutex poisoned")
                .remove(&tracked_run_id);
        });

        Ok(DemoRuntimeReceiver {
            run_id,
            events: receiver,
        })
    }

    pub fn cancel(&self, run_id: &str) -> bool {
        let cancellation = self
            .active_runs
            .lock()
            .expect("demo runtime active-runs mutex poisoned")
            .get(run_id)
            .cloned();
        if let Some(cancellation) = cancellation {
            cancellation.cancel();
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn request(prompt: &str, mode: DemoRuntimeMode) -> DemoRuntimeRequest {
        DemoRuntimeRequest {
            session_id: "session-1".to_owned(),
            prompt: prompt.to_owned(),
            mode,
        }
    }

    #[test]
    fn fixed_mode_emits_started_then_completed() {
        let events = event_plan(request(" 你好 ", DemoRuntimeMode::Fixed)).unwrap();

        assert!(matches!(
            events[0],
            DemoRuntimeEvent::RunStarted { sequence: 0, .. }
        ));
        assert!(matches!(
            events[1],
            DemoRuntimeEvent::MessageCompleted { sequence: 1, .. }
        ));
        assert_eq!(events.len(), 2);
    }

    #[test]
    fn streaming_deltas_equal_completed_content_and_sequences_are_contiguous() {
        let events = event_plan(request("你好", DemoRuntimeMode::Streaming)).unwrap();
        let deltas = events
            .iter()
            .filter_map(DemoRuntimeEvent::delta)
            .collect::<String>();

        assert_eq!(
            deltas,
            events
                .last()
                .and_then(DemoRuntimeEvent::completed_content)
                .unwrap()
        );
        assert!(events
            .iter()
            .enumerate()
            .all(|(index, event)| event.sequence() == index as u64));
        assert!(events.len() > 2);
    }

    #[test]
    fn blank_prompt_is_rejected() {
        assert_eq!(
            event_plan(request("  \n ", DemoRuntimeMode::Fixed)).unwrap_err(),
            DemoRuntimeError::EmptyPrompt
        );
    }

    #[test]
    fn response_uses_normalized_prompt() {
        let events = event_plan(request("  你好 BiBit  ", DemoRuntimeMode::Fixed)).unwrap();
        assert_eq!(
            events.last().and_then(DemoRuntimeEvent::completed_content),
            Some(
                "已收到你的消息：“你好 BiBit”\n\n这是 BiBit 演示 Runtime 的模拟回复，当前未连接正式 Agent Runtime。"
            )
        );
    }

    async fn collect(mut receiver: DemoRuntimeReceiver) -> Vec<DemoRuntimeEvent> {
        let mut events = Vec::new();
        while let Some(event) = receiver.events.recv().await {
            events.push(event);
        }
        events
    }

    #[tokio::test]
    async fn cancellation_is_idempotent_and_stops_completion() {
        let service = DemoRuntimeService::new(Duration::from_millis(10));
        let mut receiver = service
            .start(request("需要流式取消", DemoRuntimeMode::Streaming))
            .unwrap();
        let started = receiver.events.recv().await.unwrap();
        let run_id = started.run_id().to_owned();

        assert!(service.cancel(&run_id));
        assert!(service.cancel(&run_id));
        let rest = collect(receiver).await;

        assert_eq!(rest.iter().filter(|event| event.is_terminal()).count(), 1);
        assert!(rest.iter().any(DemoRuntimeEvent::is_cancelled));
        assert!(!rest.iter().any(DemoRuntimeEvent::is_completed));
    }

    #[tokio::test]
    async fn completed_run_is_removed_from_active_runs() {
        let service = DemoRuntimeService::new(Duration::ZERO);
        let receiver = service
            .start(request("固定回复", DemoRuntimeMode::Fixed))
            .unwrap();
        let run_id = receiver.run_id.clone();

        let events = collect(receiver).await;

        assert!(events.last().unwrap().is_completed());
        assert!(!service.cancel(&run_id));
    }
}
