use app_lib::runtime::gateway::RuntimeEventSink;
use app_lib::runtime::manager::RuntimeManager;
use app_lib::runtime::{
    RunStartRequest, RuntimeError, RuntimeEvent, RuntimeEventEnvelope, RuntimeStatus,
    SessionCreateRequest,
};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::time::sleep;

#[derive(Clone)]
struct RecordingSink {
    events: Arc<Mutex<Vec<RuntimeEventEnvelope>>>,
}

impl RecordingSink {
    fn new() -> Self {
        Self {
            events: Arc::new(Mutex::new(Vec::new())),
        }
    }

    fn all(&self) -> Vec<RuntimeEventEnvelope> {
        self.events.lock().unwrap().clone()
    }
}

impl RuntimeEventSink for RecordingSink {
    fn emit(&self, event: &RuntimeEventEnvelope) -> Result<(), RuntimeError> {
        self.events.lock().unwrap().push(event.clone());
        Ok(())
    }
}

#[tokio::test]
#[ignore = "requires a live bianbu-agent-runtime reachable through BIBIT_BIANBU_RUNTIME_URL"]
async fn live_bianbu_runtime_discover_switch_run_events_and_history() {
    let cwd = tempfile::tempdir().unwrap();
    let runtime_cwd = cwd.path().canonicalize().unwrap();
    let sink = RecordingSink::new();
    let manager = RuntimeManager::new(Arc::new(sink.clone()), runtime_cwd.clone()).unwrap();

    let descriptors = manager.discover().await;
    let bianbu = descriptors
        .iter()
        .find(|descriptor| descriptor.id == "bianbu")
        .expect("bianbu descriptor should be registered");
    assert!(bianbu.available, "bianbu check failed: {:?}", bianbu.error);

    let snapshot = tokio::time::timeout(Duration::from_secs(30), manager.switch("bianbu"))
        .await
        .expect("switch to bianbu should finish before the timeout")
        .expect("switch to bianbu should succeed");
    assert_eq!(snapshot.runtime_id, "bianbu");
    assert_eq!(snapshot.status, RuntimeStatus::Ready);

    let gateway = manager.active_gateway().await.unwrap();
    let agent = gateway
        .list_agents()
        .await
        .unwrap()
        .into_iter()
        .find(|agent| agent.available)
        .expect("live verification requires an available Agent");
    let session_id = format!("bibit-live-{}", uuid::Uuid::new_v4());
    let session = gateway
        .create_session(
            SessionCreateRequest {
                agent_id: Some(agent.id),
                session_id: session_id.clone(),
                title: None,
            },
            runtime_cwd.clone(),
        )
        .await
        .unwrap();
    assert_eq!(session.runtime_session_id, session_id);

    let run_id = gateway
        .start_run(RunStartRequest {
            session_id: session_id.clone(),
            user_message_id: uuid::Uuid::new_v4().to_string(),
            prompt: "请只回复：P3OK".to_owned(),
        })
        .await
        .unwrap()
        .run_id;

    let deadline = Instant::now() + Duration::from_secs(90);
    let terminal = loop {
        let terminal = sink
            .all()
            .iter()
            .find(|envelope| {
                envelope.run_id.as_deref() == Some(run_id.as_str()) && envelope.event.is_terminal()
            })
            .cloned();
        if terminal.is_some() {
            break terminal.unwrap();
        }
        assert!(
            Instant::now() < deadline,
            "timed out waiting for run {run_id} terminal event; events: {:?}",
            sink.all()
        );
        sleep(Duration::from_millis(250)).await;
    };
    assert!(
        matches!(
            terminal.event,
            RuntimeEvent::RunCompleted { .. } | RuntimeEvent::RunCancelled { .. }
        ),
        "expected a successful terminal event, got {:?}",
        terminal.event
    );

    let messages = gateway.list_messages(&session_id).await.unwrap();
    assert!(
        !messages.is_empty(),
        "history should contain the completed run messages"
    );
    let sessions = gateway.list_sessions().await.unwrap();
    assert!(
        sessions.iter().any(|item| item.id == session_id),
        "history should list the created session"
    );
}
