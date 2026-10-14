use app_lib::runtime::driver::{
    DriverEvent, DriverLifecycleEvent, DriverPromptRequest, RuntimeDriver,
};
use app_lib::runtime::hermes_acp::{HermesAcpDriver, HermesProcessSpec};
use app_lib::runtime::{PermissionDecision, RuntimeErrorCode};
use std::path::PathBuf;
use tempfile::tempdir;
use tokio::time::{timeout, Duration};

fn test_driver(scenario: &str) -> HermesAcpDriver {
    HermesAcpDriver::new(HermesProcessSpec::for_test(scenario))
}

fn test_driver_with_runtime_cwd(scenario: &str, cwd: PathBuf) -> HermesAcpDriver {
    HermesAcpDriver::new_with_runtime_cwd(HermesProcessSpec::for_test(scenario), cwd)
}

async fn collect_until_terminal(
    events: &mut tokio::sync::mpsc::UnboundedReceiver<DriverEvent>,
) -> Vec<DriverEvent> {
    let mut collected = Vec::new();
    timeout(Duration::from_secs(5), async {
        while let Some(event) = events.recv().await {
            let terminal = matches!(
                event,
                DriverEvent::Completed { .. }
                    | DriverEvent::Cancelled { .. }
                    | DriverEvent::Failed { .. }
            );
            collected.push(event);
            if terminal {
                break;
            }
        }
    })
    .await
    .expect("driver event stream should terminate");
    collected
}

async fn collect_terminal_with_grace(
    events: &mut tokio::sync::mpsc::UnboundedReceiver<DriverEvent>,
) -> Vec<DriverEvent> {
    let mut collected = Vec::new();
    while let Some(event) = timeout(Duration::from_secs(5), events.recv())
        .await
        .expect("driver event stream should produce a terminal event")
    {
        let terminal = matches!(
            event,
            DriverEvent::Completed { .. }
                | DriverEvent::Cancelled { .. }
                | DriverEvent::Failed { .. }
        );
        collected.push(event);
        if terminal {
            break;
        }
    }
    while let Ok(Some(event)) = timeout(Duration::from_millis(250), events.recv()).await {
        collected.push(event);
    }
    collected
}

#[tokio::test]
async fn maps_happy_acp_turn_to_protocol_neutral_events() {
    let driver = test_driver("happy");
    driver.check().await.unwrap();
    driver.start().await.unwrap();
    let session = driver
        .create_session(
            "test-session",
            None,
            tempdir().unwrap().path().to_path_buf(),
        )
        .await
        .unwrap();
    let mut events = driver
        .prompt(DriverPromptRequest {
            run_id: "run-1".into(),
            session_id: session,
            prompt: "你好".into(),
        })
        .await
        .unwrap();
    let collected = collect_until_terminal(&mut events).await;
    assert!(collected
        .iter()
        .any(|event| matches!(event, DriverEvent::ReasoningDelta { .. })));
    assert!(collected.iter().any(
        |event| matches!(event, DriverEvent::TextDelta { delta, .. } if delta.contains('你'))
    ));
    assert!(collected
        .iter()
        .any(|event| matches!(event, DriverEvent::ToolStarted { .. })));
    assert!(matches!(
        collected.last(),
        Some(DriverEvent::Completed { .. })
    ));
}

#[tokio::test]
async fn child_process_uses_the_runtime_working_directory() {
    let runtime_dir = tempdir().unwrap();
    let cwd = runtime_dir.path().canonicalize().unwrap();
    let driver = test_driver_with_runtime_cwd("process_context", cwd.clone());

    driver.check().await.unwrap();
    driver.start().await.unwrap();
    driver
        .create_session("test-session", None, cwd)
        .await
        .unwrap();
    driver.stop().await.unwrap();
}

#[tokio::test]
async fn initialize_failure_is_classified_and_driver_stays_stopped() {
    let driver = test_driver("initialize_failed");
    let error = driver.start().await.unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::AcpInitializeFailed);
    assert!(driver
        .prompt(DriverPromptRequest {
            run_id: "r".into(),
            session_id: "s".into(),
            prompt: "x".into()
        })
        .await
        .is_err());
}

#[tokio::test]
async fn session_creation_timeout_is_bounded_and_driver_can_stop() {
    let runtime_dir = tempdir().unwrap();
    let driver = test_driver_with_runtime_cwd(
        "session_new_hang",
        runtime_dir.path().canonicalize().unwrap(),
    );
    driver.start().await.unwrap();
    let result = timeout(
        Duration::from_secs(2),
        driver.create_session("test-session", None, runtime_dir.path().to_path_buf()),
    )
    .await
    .expect("session creation must be bounded")
    .unwrap_err();
    assert_eq!(result.code, RuntimeErrorCode::SessionCreateFailed);
    let session_entries = std::fs::read_dir(runtime_dir.path().join("sessions"))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert!(
        session_entries.is_empty(),
        "failed ACP sessions must be cleaned up"
    );
    driver.stop().await.unwrap();
}

#[tokio::test]
async fn permission_waits_and_resolves_allow_and_deny() {
    for decision in [PermissionDecision::AllowOnce, PermissionDecision::Deny] {
        let driver = test_driver("permission");
        driver.start().await.unwrap();
        let session = driver
            .create_session(
                "test-session",
                None,
                tempdir().unwrap().path().to_path_buf(),
            )
            .await
            .unwrap();
        let mut events = driver
            .prompt(DriverPromptRequest {
                run_id: "run-permission".into(),
                session_id: session,
                prompt: "x".into(),
            })
            .await
            .unwrap();
        let request_id = loop {
            let event = timeout(Duration::from_secs(2), events.recv())
                .await
                .unwrap()
                .unwrap();
            if let DriverEvent::PermissionRequested { request, .. } = event {
                break request.request_id;
            }
        };
        driver
            .resolve_permission(&request_id, decision)
            .await
            .unwrap();
        assert_eq!(
            driver
                .resolve_permission(&request_id, decision)
                .await
                .unwrap_err()
                .code,
            RuntimeErrorCode::PermissionExpired
        );
        let events = collect_until_terminal(&mut events).await;
        assert!(events.iter().any(|event| matches!(event, DriverEvent::Completed { stop_reason, .. } if stop_reason == "end_turn")));
        driver.stop().await.unwrap();
    }
}

#[tokio::test]
async fn cancel_maps_to_cancelled_and_stop_is_idempotent() {
    let driver = test_driver("cancel");
    driver.start().await.unwrap();
    let session = driver
        .create_session(
            "test-session",
            None,
            tempdir().unwrap().path().to_path_buf(),
        )
        .await
        .unwrap();
    let mut events = driver
        .prompt(DriverPromptRequest {
            run_id: "run-cancel".into(),
            session_id: session.clone(),
            prompt: "x".into(),
        })
        .await
        .unwrap();
    driver.cancel(&session, "run-cancel").await.unwrap();
    let events = collect_until_terminal(&mut events).await;
    assert!(events
        .iter()
        .any(|event| matches!(event, DriverEvent::Cancelled { .. })));
    driver.stop().await.unwrap();
    driver.stop().await.unwrap();
    assert!(driver
        .prompt(DriverPromptRequest {
            run_id: "r".into(),
            session_id: session,
            prompt: "x".into()
        })
        .await
        .is_err());
}

#[tokio::test]
async fn protocol_and_process_failures_are_safe() {
    let driver = test_driver("polluted_stdout");
    driver.start().await.unwrap();
    let session = driver
        .create_session(
            "test-session",
            None,
            tempdir().unwrap().path().to_path_buf(),
        )
        .await
        .unwrap();
    let mut events = driver
        .prompt(DriverPromptRequest {
            run_id: "run-polluted".into(),
            session_id: session,
            prompt: "x".into(),
        })
        .await
        .unwrap();
    let events = collect_until_terminal(&mut events).await;
    assert!(events.iter().any(|event| matches!(event, DriverEvent::Failed { error, .. } if error.code == RuntimeErrorCode::AcpProtocolError)));

    let driver = test_driver("stderr_exit");
    let error = driver.start().await.unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::ProcessExited);
    assert!(!error.message.contains("fake ACP agent startup failure"));

    let driver = test_driver("exit_mid_prompt");
    let mut lifecycle = driver.start().await.unwrap().lifecycle_events;
    let session = driver
        .create_session(
            "test-session",
            None,
            tempdir().unwrap().path().to_path_buf(),
        )
        .await
        .unwrap();
    let mut events = driver
        .prompt(DriverPromptRequest {
            run_id: "run-exit".into(),
            session_id: session,
            prompt: "x".into(),
        })
        .await
        .unwrap();
    let events = collect_terminal_with_grace(&mut events).await;
    assert!(events.iter().any(|event| matches!(event, DriverEvent::Failed { error, .. } if error.code == RuntimeErrorCode::ProcessExited && !error.message.contains("fake"))));
    assert_eq!(
        events
            .iter()
            .filter(|event| {
                matches!(
                    event,
                    DriverEvent::Completed { .. }
                        | DriverEvent::Cancelled { .. }
                        | DriverEvent::Failed { .. }
                )
            })
            .count(),
        1
    );
    let lifecycle_event = timeout(Duration::from_secs(2), lifecycle.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(
        matches!(lifecycle_event, app_lib::runtime::driver::DriverLifecycleEvent::ProcessExited(error) if error.code == RuntimeErrorCode::ProcessExited)
    );
}

#[tokio::test]
async fn invalid_typed_update_is_protocol_error_with_one_terminal_event() {
    let driver = test_driver("invalid_update");
    driver.start().await.unwrap();
    let session = driver
        .create_session(
            "test-session",
            None,
            tempdir().unwrap().path().to_path_buf(),
        )
        .await
        .unwrap();
    let mut events = driver
        .prompt(DriverPromptRequest {
            run_id: "run-invalid-update".into(),
            session_id: session,
            prompt: "x".into(),
        })
        .await
        .unwrap();
    let events = collect_terminal_with_grace(&mut events).await;
    let terminal_events = events
        .iter()
        .filter(|event| {
            matches!(
                event,
                DriverEvent::Completed { .. }
                    | DriverEvent::Cancelled { .. }
                    | DriverEvent::Failed { .. }
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(terminal_events.len(), 1);
    assert!(matches!(
        terminal_events[0],
        DriverEvent::Failed { error, .. }
            if error.code == RuntimeErrorCode::AcpProtocolError
    ));
}

#[tokio::test]
async fn invalid_typed_update_does_not_poison_the_next_prompt() {
    let driver = test_driver("invalid_update");
    driver.start().await.unwrap();
    let session = driver
        .create_session(
            "test-session",
            None,
            tempdir().unwrap().path().to_path_buf(),
        )
        .await
        .unwrap();

    for run_id in ["run-invalid-first", "run-invalid-second"] {
        let mut events = driver
            .prompt(DriverPromptRequest {
                run_id: run_id.into(),
                session_id: session.clone(),
                prompt: "x".into(),
            })
            .await
            .unwrap();
        let events = collect_terminal_with_grace(&mut events).await;
        assert!(matches!(
            events.last(),
            Some(DriverEvent::Failed { error, .. })
                if error.code == RuntimeErrorCode::AcpProtocolError
        ));
    }
}

#[tokio::test]
async fn invalid_update_without_terminal_stops_the_driver_after_drain_timeout() {
    let driver = test_driver("invalid_update_no_terminal");
    let mut lifecycle = driver.start().await.unwrap().lifecycle_events;
    let session = driver
        .create_session(
            "test-session",
            None,
            tempdir().unwrap().path().to_path_buf(),
        )
        .await
        .unwrap();
    let mut events = driver
        .prompt(DriverPromptRequest {
            run_id: "run-invalid-no-terminal".into(),
            session_id: session,
            prompt: "x".into(),
        })
        .await
        .unwrap();
    let events = collect_until_terminal(&mut events).await;
    assert!(events.iter().any(|event| matches!(
        event,
        DriverEvent::Failed { error, .. }
            if error.code == RuntimeErrorCode::AcpProtocolError
    )));
    assert!(matches!(
        timeout(Duration::from_secs(2), lifecycle.recv()).await,
        Ok(Some(DriverLifecycleEvent::ProcessExited(_)))
    ));
}

#[tokio::test]
async fn json_object_stdout_is_classified_as_protocol_pollution() {
    let driver = test_driver("json_object_stdout");
    driver.start().await.unwrap();
    let session = driver
        .create_session(
            "test-session",
            None,
            tempdir().unwrap().path().to_path_buf(),
        )
        .await
        .unwrap();
    let mut events = driver
        .prompt(DriverPromptRequest {
            run_id: "run-json-pollution".into(),
            session_id: session,
            prompt: "x".into(),
        })
        .await
        .unwrap();
    let events = collect_terminal_with_grace(&mut events).await;
    assert!(events.iter().any(|event| matches!(
        event,
        DriverEvent::Failed { error, .. }
            if error.code == RuntimeErrorCode::AcpProtocolError
    )));
}

#[tokio::test]
async fn process_exit_never_emits_updates_after_the_terminal_event() {
    let driver = test_driver("queued_updates_then_exit");
    let mut lifecycle = driver.start().await.unwrap().lifecycle_events;
    let session = driver
        .create_session(
            "test-session",
            None,
            tempdir().unwrap().path().to_path_buf(),
        )
        .await
        .unwrap();
    let mut events = driver
        .prompt(DriverPromptRequest {
            run_id: "run-queued-exit".into(),
            session_id: session,
            prompt: "x".into(),
        })
        .await
        .unwrap();
    let events = collect_terminal_with_grace(&mut events).await;
    let terminal_index = events
        .iter()
        .position(|event| {
            matches!(
                event,
                DriverEvent::Completed { .. }
                    | DriverEvent::Cancelled { .. }
                    | DriverEvent::Failed { .. }
            )
        })
        .expect("process exit must emit a terminal event");
    assert_eq!(terminal_index + 1, events.len());
    assert!(matches!(
        timeout(Duration::from_secs(2), lifecycle.recv()).await,
        Ok(Some(DriverLifecycleEvent::ProcessExited(_)))
    ));
}

#[tokio::test]
async fn unknown_non_extension_notification_is_diagnostic() {
    let driver = test_driver("unknown_method");
    driver.start().await.unwrap();
    let session = driver
        .create_session(
            "test-session",
            None,
            tempdir().unwrap().path().to_path_buf(),
        )
        .await
        .unwrap();
    let mut events = driver
        .prompt(DriverPromptRequest {
            run_id: "run-unknown-method".into(),
            session_id: session,
            prompt: "x".into(),
        })
        .await
        .unwrap();
    let events = collect_until_terminal(&mut events).await;
    assert!(events
        .iter()
        .any(|event| matches!(event, DriverEvent::DiagnosticNotice { .. })));
    assert!(matches!(events.last(), Some(DriverEvent::Completed { .. })));
}

#[tokio::test]
async fn long_utf8_results_are_bounded_and_unknown_updates_are_diagnostic() {
    let driver = test_driver("long_utf8_tool_result");
    driver.start().await.unwrap();
    let session = driver
        .create_session(
            "test-session",
            None,
            tempdir().unwrap().path().to_path_buf(),
        )
        .await
        .unwrap();
    let mut events = driver
        .prompt(DriverPromptRequest {
            run_id: "run-long".into(),
            session_id: session,
            prompt: "x".into(),
        })
        .await
        .unwrap();
    let events = collect_until_terminal(&mut events).await;
    let result = events
        .iter()
        .find_map(|event| match event {
            DriverEvent::ToolCompleted { result, .. } => result.as_ref(),
            _ => None,
        })
        .expect("long tool result should be emitted");
    assert!(serde_json::to_vec(result).unwrap().len() <= 64 * 1024);

    let driver = test_driver("unknown_notification");
    driver.start().await.unwrap();
    let session = driver
        .create_session("test-session", None, PathBuf::from("/tmp"))
        .await
        .unwrap();
    let mut events = driver
        .prompt(DriverPromptRequest {
            run_id: "run-unknown".into(),
            session_id: session,
            prompt: "x".into(),
        })
        .await
        .unwrap();
    let events = collect_until_terminal(&mut events).await;
    assert!(events
        .iter()
        .any(|event| matches!(event, DriverEvent::DiagnosticNotice { .. })));
    assert!(!events
        .iter()
        .any(|event| matches!(event, DriverEvent::Failed { .. })));
    assert!(matches!(events.last(), Some(DriverEvent::Completed { .. })));
}

#[tokio::test]
async fn failed_tool_update_is_terminal_for_the_tool_not_the_run() {
    let driver = test_driver("tool_failed");
    driver.start().await.unwrap();
    let session = driver
        .create_session("test-session", None, PathBuf::from("/tmp"))
        .await
        .unwrap();
    let mut events = driver
        .prompt(DriverPromptRequest {
            run_id: "run-tool-failed".into(),
            session_id: session,
            prompt: "x".into(),
        })
        .await
        .unwrap();
    let events = collect_until_terminal(&mut events).await;
    assert!(events
        .iter()
        .any(|event| matches!(event, DriverEvent::ToolCompleted { error: Some(_), .. })));
    assert!(matches!(events.last(), Some(DriverEvent::Completed { .. })));
}

#[tokio::test]
async fn preflight_classifies_missing_and_nonzero_commands() {
    let missing = HermesAcpDriver::new(HermesProcessSpec {
        command: PathBuf::from("/definitely/missing/bibit-hermes"),
        check_args: vec![],
        run_args: vec![],
        process_launcher: None,
    });
    assert_eq!(
        missing.check().await.unwrap_err().code,
        RuntimeErrorCode::HermesNotFound
    );
    for _ in 0..20 {
        assert_eq!(
            missing.start().await.unwrap_err().code,
            RuntimeErrorCode::HermesStartFailed
        );
    }

    #[cfg(unix)]
    {
        let failing = HermesAcpDriver::new(HermesProcessSpec {
            command: PathBuf::from("sh"),
            check_args: vec!["-c".into(), "exit 7".into()],
            run_args: vec![],
            process_launcher: None,
        });
        assert_eq!(
            failing.check().await.unwrap_err().code,
            RuntimeErrorCode::HermesCheckFailed
        );
    }
}
