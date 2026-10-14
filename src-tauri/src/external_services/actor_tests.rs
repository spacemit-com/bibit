use super::*;
use tokio::time::{timeout, Instant};

struct Fixture {
    root: tempfile::TempDir,
    config: ProviderConfig,
    service_id: String,
    jobs: Arc<crate::feature_service_jobs::FeatureServiceJobRegistry>,
}

impl Fixture {
    fn new(mode: &str, version: u8) -> Self {
        let root = tempfile::tempdir().unwrap();
        let script = root.path().join("provider.py");
        std::fs::write(&script, include_str!("fault_provider.py")).unwrap();
        let service_id = format!("actor-{}", uuid::Uuid::new_v4());
        let config = ProviderConfig {
            executable: PathBuf::from("/usr/bin/python3"),
            args: vec![
                "-u".into(),
                script.to_string_lossy().into_owned(),
                mode.into(),
                version.to_string(),
                root.path().to_string_lossy().into_owned(),
            ],
            data_dir: root.path().join("providers").join(&service_id),
            protocol_versions: if version == 1 { vec![1] } else { vec![1, 2] },
        };
        let grants = Arc::new(
            crate::feature_file_grants::FeatureFileGrantService::new(root.path().into()).unwrap(),
        );
        let jobs = Arc::new(crate::feature_service_jobs::FeatureServiceJobRegistry::new(
            grants,
        ));
        Self {
            root,
            config,
            service_id,
            jobs,
        }
    }

    async fn provider(&self) -> Arc<ManagedProvider> {
        let deadline = Instant::now() + Duration::from_secs(3);
        let cancellation = CancellationToken::new();
        let provider = managed_provider(
            self.config.clone(),
            &self.service_id,
            "init",
            deadline,
            &cancellation,
            Some(Arc::clone(&self.jobs)),
        )
        .await;
        provider
            .transport
            .session(deadline, &cancellation)
            .await
            .unwrap();
        provider
    }

    async fn marker(&self, name: &str) {
        timeout(Duration::from_secs(3), async {
            while !self.root.path().join(name).exists() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
    }

    fn pid(&self) -> u32 {
        std::fs::read_to_string(self.root.path().join("launches"))
            .unwrap()
            .lines()
            .last()
            .unwrap()
            .parse()
            .unwrap()
    }

    async fn stop(&self, provider: &ManagedProvider) {
        terminate_managed_service(&self.service_id).await;
        timeout(Duration::from_secs(1), provider.transport.done.cancelled())
            .await
            .unwrap();
        #[cfg(target_os = "linux")]
        assert!(!Path::new(&format!("/proc/{}", self.pid())).exists());
    }
}

async fn invoke(
    provider: &ManagedProvider,
    request_id: &str,
    params: Value,
    deadline: Instant,
    cancellation: &CancellationToken,
) -> Result<JsonRpcResponse, String> {
    provider.transport.request(request_id.into(), "bibit.invoke", serde_json::json!({
        "serviceId": "fixture", "operationId": "test.invoke.v1", "params": params, "timeoutMs": 30000,
    }), deadline, cancellation).await
}

#[tokio::test]
async fn initialization_without_stdin_reads_can_be_stopped() {
    let fixture = Fixture::new("no_read", 1);
    let cancellation = CancellationToken::new();
    let deadline = Instant::now() + Duration::from_secs(30);
    let provider = managed_provider(
        fixture.config.clone(),
        &fixture.service_id,
        "init",
        deadline,
        &cancellation,
        Some(Arc::clone(&fixture.jobs)),
    )
    .await;
    fixture.marker("launches").await;
    timeout(Duration::from_secs(1), fixture.stop(&provider))
        .await
        .unwrap();
    assert!(provider
        .transport
        .session(deadline, &cancellation)
        .await
        .is_err());
}

#[tokio::test]
async fn partial_write_deadline_reaps_the_generation_for_both_protocols() {
    for version in [1, 2] {
        let fixture = Fixture::new("partial", version);
        let provider = fixture.provider().await;
        let started = Instant::now();
        let result = timeout(
            Duration::from_secs(2),
            invoke(
                &provider,
                "partial",
                serde_json::json!({
                    "payload": "x".repeat(900_000),
                }),
                started + Duration::from_millis(250),
                &CancellationToken::new(),
            ),
        )
        .await
        .unwrap();
        assert_eq!(result.err().as_deref(), Some("timeout"));
        fixture.marker("fragment").await;
        let fragment = std::fs::read(fixture.root.path().join("fragment")).unwrap();
        assert!(!fragment.is_empty());
        assert!(!fragment.contains(&b'\n'));
        assert!(!provider.transport.healthy());
        let old_pid = fixture.pid();
        let replacement = fixture.provider().await;
        assert_ne!(old_pid, fixture.pid());
        #[cfg(target_os = "linux")]
        assert!(!Path::new(&format!("/proc/{old_pid}")).exists());
        fixture.stop(&replacement).await;
    }
}

#[tokio::test]
async fn cancellation_and_stop_interrupt_write_backpressure() {
    for version in [1, 2] {
        for cancel_request in [true, false] {
            let fixture = Fixture::new("partial", version);
            let provider = fixture.provider().await;
            let cancellation = CancellationToken::new();
            let requester = Arc::clone(&provider);
            let request_cancellation = cancellation.clone();
            let request = tokio::spawn(async move {
                invoke(
                    &requester,
                    "blocked",
                    serde_json::json!({"payload": "x".repeat(900_000)}),
                    Instant::now() + Duration::from_secs(30),
                    &request_cancellation,
                )
                .await
            });
            fixture.marker("fragment").await;
            if cancel_request {
                cancellation.cancel();
            } else {
                fixture.stop(&provider).await;
            }
            let result = timeout(Duration::from_secs(2), request)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(
                result.err().as_deref(),
                Some(if cancel_request {
                    "cancelled"
                } else {
                    "provider_crashed"
                })
            );
            fixture.stop(&provider).await;
        }
    }
}

#[tokio::test]
async fn v1_serializes_requests_and_expires_queued_work_without_sending_it() {
    let fixture = Fixture::new("echo", 1);
    let provider = fixture.provider().await;
    let first_provider = Arc::clone(&provider);
    let first = tokio::spawn(async move {
        invoke(
            &first_provider,
            "first",
            serde_json::json!({"hold": true}),
            Instant::now() + Duration::from_secs(3),
            &CancellationToken::new(),
        )
        .await
    });
    fixture.marker("held").await;
    let result = invoke(
        &provider,
        "expired",
        serde_json::json!({"value": "never"}),
        Instant::now() + Duration::from_millis(40),
        &CancellationToken::new(),
    )
    .await;
    assert_eq!(result.err().as_deref(), Some("timeout"));
    let result = invoke(
        &provider,
        "second",
        serde_json::json!({"value": "second"}),
        Instant::now() + Duration::from_secs(3),
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    first.await.unwrap().unwrap();
    assert_eq!(result.result.unwrap()["value"], "second");
    assert!(!fixture.root.path().join("overlap").exists());
    assert!(
        !std::fs::read_to_string(fixture.root.path().join("requests"))
            .unwrap()
            .contains("never")
    );
    fixture.stop(&provider).await;
}

#[tokio::test]
async fn v2_late_response_cannot_complete_or_isolate_a_reused_request_id() {
    let fixture = Fixture::new("echo", 2);
    let provider = fixture.provider().await;
    let old = invoke(
        &provider,
        "reused",
        serde_json::json!({"hold": true, "value": "old"}),
        Instant::now() + Duration::from_millis(150),
        &CancellationToken::new(),
    )
    .await;
    assert_eq!(old.err().as_deref(), Some("timeout"));
    fixture.marker("cancel").await;
    let original_pid = fixture.pid();
    let replacement = Arc::clone(&provider);
    let current = tokio::spawn(async move {
        invoke(
            &replacement,
            "reused",
            serde_json::json!({"hold": true, "value": "new"}),
            Instant::now() + Duration::from_secs(3),
            &CancellationToken::new(),
        )
        .await
    });
    let fast = invoke(
        &provider,
        "fast",
        serde_json::json!({"value": "parallel"}),
        Instant::now() + Duration::from_secs(1),
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(fast.result.unwrap()["value"], "parallel");
    std::fs::write(fixture.root.path().join("release"), b"release").unwrap();
    fixture.marker("late_sent").await;
    assert!(!current.is_finished());
    std::fs::write(fixture.root.path().join("release_new"), b"release").unwrap();
    assert_eq!(
        current.await.unwrap().unwrap().result.unwrap()["value"],
        "new"
    );
    let after = invoke(
        &provider,
        "after",
        serde_json::json!({"value": "after"}),
        Instant::now() + Duration::from_secs(1),
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(
        after.result.unwrap()["pid"].as_u64(),
        Some(u64::from(original_pid))
    );
    fixture.stop(&provider).await;
}

#[tokio::test]
async fn dropped_request_is_cancelled_without_poisoning_v2() {
    let fixture = Fixture::new("echo", 2);
    let provider = fixture.provider().await;
    let caller = Arc::clone(&provider);
    let request = tokio::spawn(async move {
        invoke(
            &caller,
            "dropped",
            serde_json::json!({"hold": true}),
            Instant::now() + Duration::from_secs(30),
            &CancellationToken::new(),
        )
        .await
    });
    fixture.marker("held").await;
    request.abort();
    let _ = request.await;
    fixture.marker("cancel").await;
    assert!(provider.transport.healthy());
    fixture.stop(&provider).await;
}

#[tokio::test]
async fn job_cancel_has_its_own_budget_while_an_invoke_write_is_blocked() {
    let fixture = Fixture::new("partial", 2);
    let provider = fixture.provider().await;
    let caller = Arc::clone(&provider);
    let request = tokio::spawn(async move {
        invoke(
            &caller,
            "blocked",
            serde_json::json!({"payload": "x".repeat(900_000)}),
            Instant::now() + Duration::from_secs(30),
            &CancellationToken::new(),
        )
        .await
    });
    fixture.marker("fragment").await;
    let result = timeout(
        Duration::from_secs(3),
        cancel_service_job(&fixture.service_id, "cancel-job"),
    )
    .await
    .unwrap();
    assert_eq!(result, Err("timeout"));
    assert!(timeout(Duration::from_secs(1), request)
        .await
        .unwrap()
        .unwrap()
        .is_err());
    fixture.stop(&provider).await;
}

#[tokio::test]
async fn handshake_and_response_share_one_gateway_deadline() {
    for version in [1, 2] {
        let fixture = Fixture::new("slow_initialize", version);
        let request = ExternalServiceGatewayRequest {
            protocol_version: 1,
            request_id: "one-budget".into(),
            service_id: fixture.service_id.clone(),
            operation_id: "test.invoke.v1".into(),
            params: serde_json::json!({}),
            timeout_ms: 400,
        };
        let deadline = Instant::now() + Duration::from_millis(400);
        let response = forward_stdio_managed(
            fixture.root.path(),
            &fixture.config.executable,
            &fixture.config.args,
            &fixture.config.protocol_versions,
            400,
            deadline,
            &request,
            &CancellationToken::new(),
            Some(Arc::clone(&fixture.jobs)),
        )
        .await;
        assert_eq!(response.error.unwrap().code, "timeout");
        terminate_managed_service(&fixture.service_id).await;
    }
}

#[tokio::test]
async fn bounded_admission_keeps_stop_available_and_completes_all_pending() {
    let fixture = Fixture::new("blocked", 2);
    let provider = fixture.provider().await;
    let mut requests = Vec::new();
    for index in 0..MAX_PENDING_V2_REQUESTS + 1 {
        let caller = Arc::clone(&provider);
        requests.push(tokio::spawn(async move {
            invoke(
                &caller,
                &format!("pending-{index}"),
                serde_json::json!({}),
                Instant::now() + Duration::from_secs(30),
                &CancellationToken::new(),
            )
            .await
        }));
    }
    timeout(Duration::from_secs(3), async {
        while !requests.iter().any(tokio::task::JoinHandle::is_finished) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    timeout(Duration::from_secs(1), fixture.stop(&provider))
        .await
        .unwrap();
    let mut exhausted = 0;
    for request in requests {
        let code = timeout(Duration::from_secs(1), request)
            .await
            .unwrap()
            .unwrap()
            .err()
            .unwrap();
        assert!(matches!(
            code.as_str(),
            "provider_crashed" | "resource_exhausted"
        ));
        exhausted += usize::from(code == "resource_exhausted");
    }
    assert!(exhausted >= 1);
}
