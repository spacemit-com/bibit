use app_lib::runtime::bianbu_http::BianbuHttpDriver;
use app_lib::runtime::driver::{DriverEvent, DriverPromptRequest, RuntimeDriver};
use app_lib::runtime::RuntimeConnectionStatus;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;
use tokio::net::{TcpListener, TcpStream};
use tokio::time::{sleep, timeout, Duration};

#[tokio::test]
async fn lost_submit_receipt_returns_an_unknown_error_instead_of_hanging() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let (_, body) = read_request(&mut stream).await;
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap()["message_id"],
            "stable"
        );
        tokio::time::sleep(Duration::from_secs(40)).await;
        drop(stream);
    });
    let driver = BianbuHttpDriver::new(&format!("http://{address}/api/v1")).unwrap();
    let error = timeout(
        Duration::from_secs(35),
        driver.session_submit(app_lib::runtime::SessionSubmitRequest {
            target_id: driver.target_id(),
            session_id: "s".into(),
            message_id: "stable".into(),
            content: "hello".into(),
            skill_ids: vec![],
            attachments: vec![],
        }),
    )
    .await
    .expect("HTTP deadline must finish the submit")
    .unwrap_err();
    assert!(error.message.contains("timed out") || error.message.contains("error sending request"));
    assert!(
        error.details.is_none(),
        "transport failure must not look like a definite HTTP rejection"
    );
    server.abort();
}

#[tokio::test]
async fn submit_skill_unavailable_preserves_backend_code_and_skill_ids() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let (request_line, body) = read_request(&mut stream).await;
        assert!(request_line.starts_with("POST /api/v1/sessions/session-1/prompt "));
        let payload: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            payload["skill_ids"],
            serde_json::json!(["vendor.review/code-review"])
        );
        respond_status(
            &mut stream,
            "422 Unprocessable Entity",
            "application/json",
            r#"{"error":{"code":"skill_unavailable","message":"Skill is unavailable","details":{"skill_ids":["vendor.review/code-review"]}}}"#,
        )
        .await;
    });

    let driver = BianbuHttpDriver::new(&format!("http://{address}/api/v1")).unwrap();
    let error = driver
        .session_submit(app_lib::runtime::SessionSubmitRequest {
            target_id: driver.target_id(),
            session_id: "session-1".into(),
            message_id: "message-1".into(),
            content: "hello".into(),
            skill_ids: vec!["vendor.review/code-review".into()],
            attachments: vec![],
        })
        .await
        .unwrap_err();
    assert_eq!(error.code, app_lib::runtime::RuntimeErrorCode::SkillUnavailable);
    assert!(!error.recoverable);
    assert_eq!(
        error.details.as_ref().unwrap()["backendCode"],
        "skill_unavailable"
    );
    assert_eq!(
        error.details.as_ref().unwrap()["backendDetails"]["skill_ids"],
        serde_json::json!(["vendor.review/code-review"])
    );
    server.await.unwrap();
}

#[tokio::test]
async fn run_failed_skill_unavailable_preserves_backend_details() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let mux_ready = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let ready = Arc::clone(&mux_ready);
    let (frames, mux_frames) = mpsc::channel::<Value>(4);
    let server = tokio::spawn(async move {
        let mut pump = Some(mux_frames);
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            if let Some(path) = ws_request_path(&mut stream).await {
                if path.contains("/events/mux") {
                    ready.store(true, std::sync::atomic::Ordering::SeqCst);
                    pump_mux(stream, pump.take().expect("mux 只应连接一次"));
                } else {
                    hold_ws(stream);
                }
                continue;
            }
            let (request_line, _) = read_request(&mut stream).await;
            if request_line.contains("tail_only=true") {
                respond(
                    &mut stream,
                    "application/json",
                    r#"{"data":[],"base_seq":0,"last_seq":null,"has_more":false}"#,
                )
                .await;
            } else if request_line.starts_with("POST ")
                && request_line.contains("/prompt ")
            {
                respond(
                    &mut stream,
                    "application/json",
                    r#"{"data":{"run_id":"backend-run-1"}}"#,
                )
                .await;
            } else if request_line.contains("/events") {
                respond(
                    &mut stream,
                    "application/json",
                    r#"{"data":[],"base_seq":0,"last_seq":0,"has_more":false}"#,
                )
                .await;
            } else {
                panic!("unexpected request: {request_line}");
            }
        }
    });

    let driver = BianbuHttpDriver::new(&format!("http://{address}/api/v1")).unwrap();
    // 真实运行时里这条 mux 由 gateway 启动时建立，Run 的事件只从它来。
    let _downlink = driver.session_downlink().await.unwrap();
    wait_for_mux(&mux_ready).await;
    let mut events = driver
        .prompt(DriverPromptRequest {
            run_id: "run-1".into(),
            session_id: "session-1".into(),
            prompt: "hello".into(),
        })
        .await
        .unwrap();
    frames
        .send(json!({"type":"session/event","session_id":"session-1","event":{"seq":1,"type":"run/failed","run_id":"backend-run-1","data":{"error":{"code":"skill_unavailable","message":"Skill is unavailable","details":{"skill_ids":["vendor.review/code-review"]}}}}}))
        .await
        .unwrap();
    let mut failure = None;
    for _ in 0..4 {
        let event = timeout(Duration::from_secs(5), events.recv())
            .await
            .unwrap()
            .unwrap();
        if let DriverEvent::Failed { error, .. } = event {
            failure = Some(error);
            break;
        }
    }
    let Some(error) = failure else {
        panic!("expected skill unavailable failure");
    };
    assert_eq!(error.code, app_lib::runtime::RuntimeErrorCode::SkillUnavailable);
    assert!(!error.recoverable);
    assert_eq!(
        error.details.unwrap()["skill_ids"],
        serde_json::json!(["vendor.review/code-review"])
    );
    server.abort();
}

#[tokio::test]
async fn attachment_upload_and_delete_use_session_owned_routes() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut upload, _) = listener.accept().await.unwrap();
        let (request_line, body) = read_request(&mut upload).await;
        assert!(request_line.starts_with("POST /api/v1/sessions/session-a/attachments "));
        let multipart = String::from_utf8_lossy(&body);
        assert!(multipart.contains("filename=\"brief.txt\""));
        assert!(multipart.contains("ATTACHMENT_DRIVER_OK"));
        respond(
            &mut upload,
            "application/json",
            r#"{"data":{"resource_id":"resource-a","name":"brief.txt","size":20,"mime_type":"text/plain","url":"/api/v1/sessions/session-a/attachments/resource-a"}}"#,
        )
        .await;

        let (mut delete, _) = listener.accept().await.unwrap();
        let (request_line, _) = read_request(&mut delete).await;
        assert!(
            request_line.starts_with("DELETE /api/v1/sessions/session-a/attachments/resource-a ")
        );
        respond_status(&mut delete, "204 No Content", "text/plain", "").await;
    });
    let directory = std::env::temp_dir().join(format!("bibit-attachment-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir(&directory).await.unwrap();
    let source = directory.join("brief.txt");
    tokio::fs::write(&source, b"ATTACHMENT_DRIVER_OK")
        .await
        .unwrap();
    let driver = BianbuHttpDriver::new(&format!("http://{address}/api/v1")).unwrap();

    let uploaded = driver
        .session_attachment_upload("session-a", &source, "brief.txt")
        .await
        .unwrap();
    assert_eq!(uploaded.resource_id, "resource-a");
    driver
        .session_attachment_delete("session-a", &uploaded.resource_id)
        .await
        .unwrap();

    tokio::fs::remove_dir_all(directory).await.unwrap();
    server.await.unwrap();
}

async fn read_request(stream: &mut TcpStream) -> (String, Vec<u8>) {
    let mut bytes = Vec::new();
    let header_end = loop {
        let mut chunk = [0u8; 4096];
        let read = stream.read(&mut chunk).await.unwrap();
        assert!(read > 0);
        bytes.extend_from_slice(&chunk[..read]);
        if let Some(index) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            break index + 4;
        }
    };
    let headers = String::from_utf8(bytes[..header_end].to_vec()).unwrap();
    let content_length = headers
        .lines()
        .find_map(|line| {
            line.to_ascii_lowercase()
                .strip_prefix("content-length:")
                .map(str::trim)
                .and_then(|value| value.parse::<usize>().ok())
        })
        .unwrap_or_default();
    while bytes.len() < header_end + content_length {
        let mut chunk = vec![0u8; header_end + content_length - bytes.len()];
        let read = stream.read(&mut chunk).await.unwrap();
        assert!(read > 0);
        bytes.extend_from_slice(&chunk[..read]);
    }
    (
        headers.lines().next().unwrap().to_owned(),
        bytes[header_end..header_end + content_length].to_vec(),
    )
}

/// 这条已接受的连接如果是 WebSocket 升级请求，返回它的请求目标。
async fn ws_request_path(stream: &mut TcpStream) -> Option<String> {
    let mut head = [0u8; 4096];
    let count = stream.peek(&mut head).await.unwrap();
    let head = String::from_utf8_lossy(&head[..count]).to_lowercase();
    let websocket = head.contains("upgrade: websocket");
    let line = head.lines().next()?.to_owned();
    websocket.then_some(line)
}

/// 握手并保持 host 下联：driver 启动时会同时建立它，本用例只关心 mux。
fn hold_ws(stream: TcpStream) {
    tokio::spawn(async move {
        let Ok(_socket) = tokio_tungstenite::accept_async(stream).await else {
            return;
        };
        std::future::pending::<()>().await;
    });
}

/// 把 `frames` 里的帧推给一条已握手的 mux 连接；发送端 drop 后结束。
fn pump_mux(stream: TcpStream, mut frames: mpsc::Receiver<Value>) {
    use futures_util::SinkExt;
    tokio::spawn(async move {
        let Ok(mut socket) = tokio_tungstenite::accept_async(stream).await else {
            return;
        };
        while let Some(value) = frames.recv().await {
            let message = tokio_tungstenite::tungstenite::Message::Text(value.to_string().into());
            if socket.send(message).await.is_err() {
                break;
            }
        }
    });
}

/// 等 mux 握手完成：事件由它推送，订阅建立前推的帧不会被重放。
async fn wait_for_mux(ready: &std::sync::atomic::AtomicBool) {
    for _ in 0..200 {
        if ready.load(std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        sleep(Duration::from_millis(10)).await;
    }
    panic!("mux 未在 2 秒内建立");
}

async fn respond(stream: &mut TcpStream, content_type: &str, body: &str) {
    respond_status(stream, "200 OK", content_type, body).await;
}

async fn respond_status(stream: &mut TcpStream, status: &str, content_type: &str, body: &str) {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(response.as_bytes()).await.unwrap();
}

#[tokio::test]
async fn stable_ids_and_prompt_events_preserve_the_remote_run() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let mux_ready = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let ready = Arc::clone(&mux_ready);
    let (frames, mux_frames) = mpsc::channel::<Value>(8);
    let seen: Arc<std::sync::Mutex<Vec<String>>> = Arc::new(std::sync::Mutex::new(Vec::new()));
    let recorded = Arc::clone(&seen);
    let server = tokio::spawn(async move {
        let mut pump = Some(mux_frames);
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            if let Some(path) = ws_request_path(&mut stream).await {
                if path.contains("/events/mux") {
                    ready.store(true, std::sync::atomic::Ordering::SeqCst);
                    pump_mux(stream, pump.take().expect("mux 只应连接一次"));
                } else {
                    hold_ws(stream);
                }
                continue;
            }
            let (request_line, body) = read_request(&mut stream).await;
            recorded.lock().unwrap().push(request_line.clone());
            if request_line.starts_with("POST /api/v1/sessions ") {
                let payload: Value = serde_json::from_slice(&body).unwrap();
                assert_eq!(payload["id"], "session-1");
                assert_eq!(payload["title"], "First title");
                assert_eq!(payload["agent_id"], "default");
                assert_eq!(payload["metadata"]["bibit_session_id"], "session-1");
                respond(
                    &mut stream,
                    "application/json",
                    r#"{"data":{"id":"session-1","title":"","agent_id":"default","metadata":{"bibit_session_id":"session-1"},"created_at":1.0,"updated_at":1.0}}"#,
                )
                .await;
            } else if request_line.contains("tail_only=true") {
                // 订阅游标取在 Run 创建之前，从水位之后读。
                assert!(request_line.contains("/sessions/session-1/events?"));
                respond(
                    &mut stream,
                    "application/json",
                    r#"{"data":[],"base_seq":0,"last_seq":7,"has_more":false}"#,
                )
                .await;
            } else if request_line.starts_with("POST /api/v1/sessions/session-1/prompt ") {
                let payload: Value = serde_json::from_slice(&body).unwrap();
                assert_eq!(payload["message_id"], "run-1");
                assert_eq!(payload["content"], "hello");
                respond(
                    &mut stream,
                    "application/json",
                    r#"{"data":{"run_id":"backend-run-1"}}"#,
                )
                .await;
            } else if request_line.contains("/events?max_messages=50") {
                // 打开会话窗口：游标落在窗口末尾，之后的实时帧可以逐条直推。
                respond(
                    &mut stream,
                    "application/json",
                    r#"{"data":[{"seq":7,"type":"assistant/message.end","run_id":"backend-run-0","data":{}}],"base_seq":7,"last_seq":7,"has_more":false}"#,
                )
                .await;
            } else {
                panic!("unexpected request: {request_line}");
            }
        }
    });

    let driver = BianbuHttpDriver::new(&format!("http://{address}/api/v1")).unwrap();
    let _downlink = driver.session_downlink().await.unwrap();
    wait_for_mux(&mux_ready).await;
    let runtime_session_id = driver
        .create_session_for_agent(
            "session-1",
            Some("First title"),
            Some("default"),
            tempfile::tempdir().unwrap().path().to_path_buf(),
        )
        .await
        .unwrap();
    assert_eq!(runtime_session_id, "session-1");
    driver
        .session_feed(&runtime_session_id, None, app_lib::runtime::SessionFeedView::Events)
        .await
        .unwrap();
    let mut events = driver
        .prompt(DriverPromptRequest {
            run_id: "run-1".into(),
            session_id: runtime_session_id,
            prompt: "hello".into(),
        })
        .await
        .unwrap();
    frames
        .send(json!({"type":"session/event","session_id":"session-1","event":{"seq":8,"type":"assistant/text.delta","run_id":"backend-run-1","data":{"text":"hello"}}}))
        .await
        .unwrap();
    frames
        .send(json!({"type":"session/event","session_id":"session-1","event":{"seq":9,"type":"run/completed","run_id":"backend-run-1","data":{"status":"completed","content":"hello"}}}))
        .await
        .unwrap();
    let mut observed = Vec::new();
    loop {
        let event = timeout(Duration::from_secs(5), events.recv())
            .await
            .unwrap()
            .unwrap();
        let terminal = matches!(event, DriverEvent::Completed { .. });
        observed.push(event);
        if terminal {
            break;
        }
    }

    assert!(observed.iter().any(|event| matches!(
        event,
        DriverEvent::TextDelta { run_id, delta, .. }
            if run_id == "run-1" && delta == "hello"
    )));
    assert!(observed.iter().any(|event| matches!(
        event,
        DriverEvent::ConnectionStatusChanged {
            status: RuntimeConnectionStatus::Connected,
            ..
        }
    )));
    assert!(observed
        .iter()
        .any(|event| matches!(event, DriverEvent::Completed { .. })));
    assert!(!observed
        .iter()
        .any(|event| matches!(event, DriverEvent::Failed { .. })));
    // 事件只走 mux：prompt 之后不该再出现事件流或增量轮询请求。
    let requests = seen.lock().unwrap().clone();
    assert!(
        requests
            .iter()
            .all(|line| !line.contains("/events/stream") && !line.contains("from_seq")),
        "run events must not need another HTTP read: {requests:?}"
    );
    server.abort();
}

#[tokio::test]
async fn lost_create_response_is_recovered_from_the_stable_id() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut create, _) = listener.accept().await.unwrap();
        let (request_line, body) = read_request(&mut create).await;
        assert!(request_line.starts_with("POST /api/v1/sessions "));
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap()["id"],
            "session-1"
        );
        drop(create);

        let (mut recover, _) = listener.accept().await.unwrap();
        let (request_line, _) = read_request(&mut recover).await;
        assert!(request_line.starts_with("GET /api/v1/sessions/session-1 "));
        respond(
            &mut recover,
            "application/json",
            r#"{"data":{"id":"session-1","title":"","agent_id":"default","metadata":{},"created_at":1.0,"updated_at":1.0}}"#,
        )
        .await;
    });

    let driver = BianbuHttpDriver::new(&format!("http://{address}/api/v1")).unwrap();
    let session_id = driver
        .create_session_for_agent(
            "session-1",
            None,
            Some("default"),
            tempfile::tempdir().unwrap().path().to_path_buf(),
        )
        .await
        .unwrap();
    assert_eq!(session_id, "session-1");
    server.await.unwrap();
}

#[tokio::test]
async fn unapplied_create_is_retried_with_the_same_stable_id() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        for index in 0..3 {
            let (mut stream, _) = listener.accept().await.unwrap();
            let (request_line, body) = read_request(&mut stream).await;
            match index {
                0 => {
                    assert!(request_line.starts_with("POST /api/v1/sessions "));
                    assert_eq!(
                        serde_json::from_slice::<Value>(&body).unwrap()["id"],
                        "session-1"
                    );
                }
                1 => {
                    assert!(request_line.starts_with("GET /api/v1/sessions/session-1 "));
                    respond_status(
                        &mut stream,
                        "404 Not Found",
                        "application/json",
                        r#"{"error":{"message":"not found"}}"#,
                    )
                    .await;
                }
                2 => {
                    assert!(request_line.starts_with("POST /api/v1/sessions "));
                    assert_eq!(
                        serde_json::from_slice::<Value>(&body).unwrap()["id"],
                        "session-1"
                    );
                    respond(
                        &mut stream,
                        "application/json",
                        r#"{"data":{"id":"session-1","title":"","agent_id":"default","metadata":{},"created_at":1.0,"updated_at":1.0}}"#,
                    )
                    .await;
                }
                _ => unreachable!(),
            }
        }
    });

    let driver = BianbuHttpDriver::new(&format!("http://{address}/api/v1")).unwrap();
    let session_id = driver
        .create_session_for_agent(
            "session-1",
            None,
            Some("default"),
            tempfile::tempdir().unwrap().path().to_path_buf(),
        )
        .await
        .unwrap();
    assert_eq!(session_id, "session-1");
    server.await.unwrap();
}

#[tokio::test]
async fn incompatible_runtime_preserves_validation_error_without_legacy_retry() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut first, _) = listener.accept().await.unwrap();
        let (_, body) = read_request(&mut first).await;
        let payload: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(payload["agent_id"], "default");
        respond_status(&mut first, "422 Unprocessable Entity", "application/json",
            r#"{"error":{"code":"validation_error","message":"Request validation failed.","details":{}}}"#).await;
        assert!(timeout(Duration::from_millis(250), listener.accept())
            .await
            .is_err());
    });
    let driver = BianbuHttpDriver::new(&format!("http://{address}/api/v1")).unwrap();
    let error = driver
        .create_session_for_agent("session-1", None, Some("default"), std::env::temp_dir())
        .await
        .unwrap_err();
    assert!(!error.recoverable);
    assert_eq!(
        error.details.as_ref().unwrap()["backendCode"],
        "validation_error"
    );
    assert_eq!(error.details.as_ref().unwrap()["httpStatus"], 422);
    server.await.unwrap();
}

#[tokio::test]
async fn missing_agent_does_not_issue_a_create_request() {
    let driver = BianbuHttpDriver::new("http://127.0.0.1:1/api/v1").unwrap();
    for agent in [None, Some(""), Some("  ")] {
        let error = driver
            .create_session_for_agent("session-1", None, agent, std::env::temp_dir())
            .await
            .unwrap_err();
        assert_eq!(
            error.code,
            app_lib::runtime::RuntimeErrorCode::SessionCreateFailed
        );
    }
}

#[tokio::test]
async fn session_view_recovers_latest_run_from_payload() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let (request_line, _) = read_request(&mut stream).await;
        assert!(request_line.starts_with("GET /api/v1/sessions/session-legacy "));
        respond(
            &mut stream,
            "application/json",
            r#"{"data":{"id":"session-legacy","title":"Legacy","agent_id":"default","metadata":{},"created_at":1.0,"updated_at":2.0,"latest_run":{"id":"run-active","session_id":"session-legacy","agent_id":"default","status":"waiting","content":"","usage":null,"error":null,"pending_actions":[{"type":"approval_required","approval_id":"approval-1","actions":[]}],"event_cursor":0,"created_at":1.0,"updated_at":2.0}}}"#,
        )
        .await;
    });

    let driver = BianbuHttpDriver::new(&format!("http://{address}/api/v1")).unwrap();
    let session = driver.get_session("session-legacy").await.unwrap();
    let run = session.latest_run.unwrap();
    assert_eq!(run.id, "run-active");
    assert_eq!(run.status, "waiting");
    assert_eq!(run.event_cursor, 0);
    assert_eq!(run.pending_actions.len(), 1);
    server.await.unwrap();
}

#[tokio::test]
async fn rename_session_patches_the_bianbu_title() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let (request_line, body) = read_request(&mut stream).await;
        assert!(request_line.starts_with("PATCH /api/v1/sessions/session-1 "));
        let payload: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(payload["title"], "新标题");
        respond(
            &mut stream,
            "application/json",
            r#"{"data":{"id":"session-1","title":"新标题"}}"#,
        )
        .await;
    });

    let driver = BianbuHttpDriver::new(&format!("http://{address}/api/v1")).unwrap();
    driver.rename_session("session-1", "新标题").await.unwrap();
    server.await.unwrap();
}

#[tokio::test]
async fn session_management_uses_current_http_contract() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        for index in 0..6 {
            let (mut stream, _) = listener.accept().await.unwrap();
            let (line, body) = read_request(&mut stream).await;
            match index {
                0 => {
                    assert!(line.starts_with("GET /api/v1/agents "));
                    respond(&mut stream, "application/json", r#"{"data":[]}"#).await;
                }
                1 | 2 => {
                    assert!(line.contains(&format!("page={}", index)));
                    respond(&mut stream, "application/json", &format!(r#"{{"data":[{{"id":"s{index}","title":"","agent_id":"a1","created_at":1,"updated_at":2,"running":false,"waiting":true,"failed":false,"completed_unread":false,"active_run_id":"r1","pending_interaction":"approval"}}],"page":{{"has_more":{}}}}}"#, index == 1)).await;
                }
                3 => {
                    assert!(line.starts_with("POST /api/v1/sessions/s1/generate-title "));
                    assert_eq!(
                        serde_json::from_slice::<Value>(&body).unwrap(),
                        serde_json::json!({"message_id":"m1","content":"hello"})
                    );
                    respond(
                        &mut stream,
                        "application/json",
                        r#"{"data":{"title":"hello","run_id":null,"status":"queued"}}"#,
                    )
                    .await;
                }
                4 => {
                    assert!(line.starts_with("DELETE /api/v1/sessions/s1 "));
                    respond_status(&mut stream, "204 No Content", "application/json", "").await;
                }
                5 => {
                    assert!(line.starts_with("POST /api/v1/sessions/s2/clear-context "));
                    respond_status(&mut stream, "409 Conflict", "application/json", r#"{"error":{"code":"session_busy","message":"active execution","details":{"active_run_id":"r1"}}}"#).await;
                }
                _ => unreachable!(),
            }
        }
    });
    let driver = BianbuHttpDriver::new(&format!("http://{address}/api/v1")).unwrap();
    assert!(driver.list_agents().await.unwrap().is_empty());
    let sessions = driver.list_sessions().await.unwrap();
    assert_eq!(sessions.len(), 2);
    assert!(sessions[0].waiting);
    assert_eq!(sessions[0].active_run_id.as_deref(), Some("r1"));
    assert!(sessions[0].latest_run.is_none());
    assert!(driver
        .generate_title("s1", "m1", "hello")
        .await
        .unwrap()
        .run_id
        .is_none());
    driver.delete_session("s1").await.unwrap();
    let error = driver.clear_context("s2").await.unwrap_err();
    assert_eq!(
        error.code,
        app_lib::runtime::RuntimeErrorCode::SessionConflict
    );
    assert!(!error.recoverable);
    assert_eq!(error.details.unwrap()["backendCode"], "session_busy");
    server.await.unwrap();
}

/// 接管进行中的 Run：先用一次可见窗口补投该 Run 已有的事件，再从窗口之后继续流。
#[tokio::test]
async fn attach_replays_the_visible_window_then_streams_from_it() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let mux_ready = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let ready = Arc::clone(&mux_ready);
    let (frames, mux_frames) = mpsc::channel::<Value>(8);
    let server = tokio::spawn(async move {
        let mut pump = Some(mux_frames);
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            if let Some(path) = ws_request_path(&mut stream).await {
                if path.contains("/events/mux") {
                    ready.store(true, std::sync::atomic::Ordering::SeqCst);
                    pump_mux(stream, pump.take().expect("mux 只应连接一次"));
                } else {
                    hold_ws(stream);
                }
                continue;
            }
            let (request_line, _) = read_request(&mut stream).await;
            if request_line.contains("tail_only=true") {
                respond(
                    &mut stream,
                    "application/json",
                    r#"{"data":[],"base_seq":0,"last_seq":null,"has_more":false}"#,
                )
                .await;
            } else if request_line.starts_with("POST ") && request_line.contains("/prompt ") {
                respond(
                    &mut stream,
                    "application/json",
                    r#"{"data":{"run_id":"backend-run-1"}}"#,
                )
                .await;
            } else if request_line.contains("/events?max_messages=50") {
                respond(
                    &mut stream,
                    "application/json",
                    r#"{"data":[{"seq":1,"type":"assistant/text.delta","run_id":"backend-run-1","data":{"text":"窗口补投"}}],"base_seq":1,"last_seq":1,"has_more":false}"#,
                )
                .await;
            } else {
                panic!("unexpected request: {request_line}");
            }
        }
    });

    let driver = BianbuHttpDriver::new(&format!("http://{address}/api/v1")).unwrap();
    let _downlink = driver.session_downlink().await.unwrap();
    wait_for_mux(&mux_ready).await;
    let _prompted = driver
        .prompt(DriverPromptRequest {
            run_id: "run-1".into(),
            session_id: "session-1".into(),
            prompt: "hello".into(),
        })
        .await
        .unwrap();
    let mut attached = driver.attach_run("run-1", 0).await.unwrap();
    let event = timeout(Duration::from_secs(5), attached.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(
        matches!(event, DriverEvent::TextDelta { ref delta, .. } if delta == "窗口补投"),
        "the in-flight answer must be rebuilt from the window"
    );

    // 补投之后继续推进的事件由 mux 推送，不再新开一条 HTTP 订阅。
    frames
        .send(json!({"type":"session/event","session_id":"session-1","event":{"seq":2,"type":"assistant/text.delta","run_id":"backend-run-1","data":{"text":"实时续流"}}}))
        .await
        .unwrap();
    let mut continued = false;
    for _ in 0..4 {
        let event = timeout(Duration::from_secs(5), attached.recv())
            .await
            .unwrap()
            .unwrap();
        if matches!(event, DriverEvent::TextDelta { ref delta, .. } if delta == "实时续流") {
            continued = true;
            break;
        }
    }
    assert!(continued, "the stream must continue after the replayed window");
    server.abort();
}

/// 返回 `Connection: keep-alive` 的响应（默认 `respond_status` 用 `close`）。
/// 用于模拟 reqwest 把连接放入 keep-alive 池中、供后续复用。
async fn respond_keep_alive(stream: &mut TcpStream, content_type: &str, body: &str) {
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: keep-alive\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(response.as_bytes()).await.unwrap();
}

/// 验证 stale keep-alive 连接被 reqwest 复用到之后失败，`send_retrying` 会
/// 自动用 `Connection: close` 新建连接重试并恢复（见根因文档 §6.3）。
#[tokio::test]
async fn stale_keepalive_connection_is_retried_and_recovers() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let (request_line, _) = read_request(&mut stream).await;
        assert!(request_line.starts_with("GET /api/v1/agents "));
        // 返回 keep-alive 响应，把连接放回 reqwest 连接池；随后服务端拆除此连接。
        respond_keep_alive(&mut stream, "application/json", "{\"data\":[]}").await;
        drop(stream);
        tokio::time::sleep(Duration::from_millis(100)).await;
        // 重试：reqwest 新建连接再来。
        let (mut stream2, _) = listener.accept().await.unwrap();
        let (request_line2, _) = read_request(&mut stream2).await;
        assert!(request_line2.starts_with("GET /api/v1/agents "));
        respond_keep_alive(&mut stream2, "application/json", "{\"data\":[]}").await;
    });
    let driver = BianbuHttpDriver::new(&format!("http://{address}/api/v1")).unwrap();
    // 第一次请求：连接池为空，reqwest 新建连接（keep-alive）入池。
    assert!(driver.list_agents().await.unwrap().is_empty());
    // 等待服务端拆除 idle 连接（发送 FIN），使池中的连接变成 stale。
    tokio::time::sleep(Duration::from_millis(250)).await;
    // 第二次请求复用池中的 stale 连接应失败，但 send_retrying 会重试并恢复。
    assert!(driver.list_agents().await.unwrap().is_empty());
    server.await.unwrap();
}

/// 验证持久性 HTTP 失败（如 4xx/5xx）不会被 `send_retrying` 吞掉而重试成
/// 成功；仍按 HTTP 语义返回对应错误。
#[tokio::test]
async fn http_status_error_is_preserved_not_retried() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let (_, _) = read_request(&mut stream).await;
        respond_status(
            &mut stream,
            "404 Not Found",
            "application/json",
            r#"{"error":{"code":"not_found","message":"boom"}}"#,
        )
        .await;
    });
    let driver = BianbuHttpDriver::new(&format!("http://{address}/api/v1")).unwrap();
    let error = driver.list_agents().await.unwrap_err();
    assert!(
        !error.message.contains("发送请求失败") || !error.message.contains("error sending request"),
        "HTTP status 错误不应被当作传输层错误重试"
    );
    server.await.unwrap();
}

// ---------------------------------------------------------------------------
// mux 读循环活性：对账读持锁期间，读循环必须继续 poll socket
// ---------------------------------------------------------------------------

/// 复现「mux 断线不重连」：会话 `s` 先拿到游标，mux 重连时 preamble 会对 `s` 启动一次
/// recovery；服务端紧接着推 `session/subscribed`。返回两次 ping 的结果：订阅帧之前的基线、
/// 以及订阅帧之后（各等 1.5 秒）。基线不通过说明是编排/判定问题，不是待验证的停摆。
///
/// 读循环处理帧时内联 await `FeedHub::frame()`，而 `session/subscribed` 分支会先拿该会话的
/// cursor 锁、再做一次对账读。这把锁若被**同一条任务**里正在飞的 recovery future 持有，循环
/// 就停在锁上不再 poll socket；而那个 future 也因循环停摆永不再被 poll，锁永不释放。生产
/// 表现：GUI 既收不到实时事件、也不回 pong，服务端 ping 超时后单方面关闭，客户端连 FIN 都
/// 读不到 —— fd 一直握着、也不重连，直到用户手动切会话（走 REST）才像是"好了"。
///
/// 上面这段描述的是改造前的形状（游标由共享锁保护、读循环内联 await）。改造后游标只由
/// reducer 独占、根本没有锁，但对账读仍然可能与订阅帧交错，所以这个用例保留为回归基线：
/// 只要对账读在飞时客户端仍能按 pong，就说明读循环没有被对账拖住。
///
/// `recovery_delay` 是唯一变量：对账读的响应延迟。
async fn pong_while_recovery_in_flight(recovery_delay: Duration) -> (bool, bool) {
    use futures_util::SinkExt;
    use tokio_tungstenite::tungstenite::Message;

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let recovery_seen = Arc::new(tokio::sync::Notify::new());
    let (pong_tx, mut pong_rx) = mpsc::channel::<(bool, bool)>(1);

    let seen = Arc::clone(&recovery_seen);
    let _server = tokio::spawn(async move {
        let mut mux_connections = 0usize;
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                return;
            };
            let Some(path) = ws_request_path(&mut stream).await else {
                let seen = Arc::clone(&seen);
                tokio::spawn(async move {
                    let (request_line, _) = read_request(&mut stream).await;
                    if !request_line.contains("/sessions/s/") {
                        respond(
                            &mut stream,
                            "application/json",
                            r#"{"data":[],"base_seq":0,"last_seq":null,"has_more":false,"hidden_run_ids":[]}"#,
                        )
                        .await;
                        return;
                    }
                    seen.notify_one();
                    // 唯一的变量：对账读多久才返回。recovery 在这段时间里一直持有 cursor 锁。
                    sleep(recovery_delay).await;
                    respond(
                        &mut stream,
                        "application/json",
                        r#"{"data":[],"base_seq":1,"last_seq":1,"has_more":false,"hidden_run_ids":[]}"#,
                    )
                    .await;
                });
                continue;
            };
            if !path.contains("/events/mux") {
                hold_ws(stream);
                continue;
            }
            mux_connections += 1;
            if mux_connections == 1 {
                tokio::spawn(async move {
                    let Ok(mut socket) = tokio_tungstenite::accept_async(stream).await else {
                        return;
                    };
                    // 未注册会话的实时帧会补建游标；随后服务端关闭，逼客户端重连。
                    let anchor = json!({"type":"session/event","session_id":"s","event":{"seq":1,"type":"assistant/text.delta","run_id":"r","data":{"text":"锚点"}}});
                    let _ = socket.send(Message::Text(anchor.to_string().into())).await;
                    sleep(Duration::from_millis(300)).await;
                    let _ = socket.send(Message::Close(None)).await;
                    sleep(Duration::from_millis(100)).await;
                });
                continue;
            }
            let seen = Arc::clone(&seen);
            let pong_tx = pong_tx.clone();
            tokio::spawn(async move {
                let Ok(mut socket) = tokio_tungstenite::accept_async(stream).await else {
                    return;
                };
                let ping = |payload: &[u8]| Message::Ping(payload.to_vec().into());
                // 基线：订阅帧之前读循环必须回 pong。基线不通过说明是编排/判定问题，而不是停摆。
                if socket.send(ping(b"baseline")).await.is_err() {
                    return;
                }
                let baseline = wait_pong(&mut socket, Duration::from_millis(1500)).await;
                // 等对账读真的在飞（recovery 已持锁），再推订阅帧。
                seen.notified().await;
                // 这 300ms 是让对照组确定：对账读若已立即返回，客户端会先消费掉响应、释放锁，
                // 于是订阅帧走的是正常路径；延迟/不返回的变体则必然撞在锁上。
                sleep(Duration::from_millis(300)).await;
                let subscribed = json!({"type":"session/subscribed","session_id":"s"});
                if socket
                    .send(Message::Text(subscribed.to_string().into()))
                    .await
                    .is_err()
                {
                    return;
                }
                sleep(Duration::from_millis(200)).await;
                if socket.send(ping(b"probe")).await.is_err() {
                    return;
                }
                let after_subscribed = wait_pong(&mut socket, Duration::from_secs(6)).await;
                let _ = pong_tx.send((baseline, after_subscribed)).await;
            });
        }
    });

    let driver = BianbuHttpDriver::new(&format!("http://{address}/api/v1")).unwrap();
    // downlink 接收端必须活着：drop 它会让 feed 的 tx.send 失败并退出读循环。
    let _downlink = driver.session_downlink().await.unwrap();
    timeout(Duration::from_secs(10), pong_rx.recv())
        .await
        .expect("场景未在 10 秒内跑完（mux 未重连或对账读没发生）")
        .expect("场景任务未回报 ping 结果")
}

/// 服务端发一个带标记的 ping，等 `wait` 看客户端是否回 pong。
async fn wait_pong(
    socket: &mut tokio_tungstenite::WebSocketStream<TcpStream>,
    wait: Duration,
) -> bool {
    use futures_util::StreamExt;
    use tokio_tungstenite::tungstenite::Message;
    timeout(wait, async {
        loop {
            match socket.next().await {
                Some(Ok(Message::Pong(_))) => break true,
                Some(Ok(_)) => continue,
                _ => break false,
            }
        }
    })
    .await
    .unwrap_or(false)
}

/// 服务端关闭后重连的 mux，必须在对账读持锁期间继续被 poll —— 否则服务端 ping 超时会单方面
/// 断开，而客户端读不到任何关闭信号，于是既不显示断开、也不重连（线上"断线不重连"）。
#[tokio::test]
async fn mux_answers_ping_while_a_slow_recovery_holds_the_cursor_lock() {
    let (baseline, after_subscribed) = pong_while_recovery_in_flight(Duration::from_secs(30)).await;
    assert!(
        baseline,
        "基线不通过：订阅帧之前读循环就已经不回 pong，说明编排/判定有问题"
    );
    assert!(
        after_subscribed,
        "读循环停在对账读持有的 cursor 锁上：socket 不再被 poll，不回 pong，也不会重连"
    );
}

/// 对照组：对账读立即返回，其余编排完全一致。它证明 ping/pong 判定本身可用，差异只来自
/// recovery 是否还在飞行中。
#[tokio::test]
async fn mux_answers_ping_when_the_recovery_returns_promptly() {
    let (baseline, after_subscribed) = pong_while_recovery_in_flight(Duration::ZERO).await;
    assert!(
        baseline && after_subscribed,
        "对照组失败说明 ping/pong 判定或场景编排有问题，而不是待验证的停摆（基线={baseline}）"
    );
}

/// 区分「永久死锁」和「只是多等一次慢 HTTP」：对账读 2 秒后返回。若读循环只是被那次读挡住，
/// 响应回来后它会继续跑、pong 应该在 6 秒内到；pong 仍然不到，就说明持锁的 recovery future
/// 因为循环停摆再也拿不到 poll，锁永不释放 —— 这正是线上那条连接能僵 20 小时的原因。
#[tokio::test]
async fn mux_resumes_after_a_delayed_recovery_response_returns() {
    let (baseline, after_subscribed) = pong_while_recovery_in_flight(Duration::from_secs(2)).await;
    assert!(baseline, "基线不通过：订阅帧之前读循环就已经不回 pong");
    assert!(
        after_subscribed,
        "对账读的响应 2 秒后已经回来，读循环却没有恢复：持锁的 recovery future 永不再被 poll"
    );
}
