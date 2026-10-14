use super::socket::{command_at, read_events, EventReader, Reply};
use super::{run_bridge_reader, validated_socket_path, VoiceSessionState, MAX_EVENT_LINE_BYTES};
use serde_json::{json, Value};
use std::future::Future;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{mpsc, oneshot};
use tokio::time::{sleep, timeout, Duration, Instant};

fn listener() -> (tempfile::TempDir, PathBuf, UnixListener) {
    let directory = tempfile::tempdir().unwrap();
    std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let path = directory.path().join("tool.sock");
    let listener = UnixListener::bind(&path).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(validated_socket_path(directory.path()).unwrap(), path);
    (directory, path, listener)
}

async fn bounded<T>(future: impl Future<Output = T>) -> T {
    timeout(Duration::from_secs(5), future)
        .await
        .expect("操作未在测试预算内结束")
}

async fn read_command(stream: &mut UnixStream) -> Value {
    bounded(EventReader::new(BufReader::new(stream)).next())
        .await
        .unwrap()
        .unwrap()
}

#[tokio::test]
async fn delayed_cancel_cannot_clear_new_session_or_reused_id() {
    for replacement in 0..3 {
        let (_directory, path, listener) = listener();
        let sessions = VoiceSessionState::default();
        let bridge = sessions.reset_bridge();
        let generation = sessions.begin_connection(bridge).unwrap();
        sessions.observe(
            generation,
            &json!({"event":"wake_triggered","session_id":7}),
        );
        let snapshot = sessions.snapshot().unwrap();
        let (received, request) = oneshot::channel();
        let (release, delayed_reply) = oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            assert_eq!(
                read_command(&mut stream).await,
                json!({"cmd":"cancel","session_id":7})
            );
            received.send(()).unwrap();
            delayed_reply.await.unwrap();
            stream
                .write_all(b"{\"event\":\"session_cancelled\",\"session_id\":7}\n")
                .await
                .unwrap();
        });
        let cancelling = sessions.clone();
        let cancel = tokio::spawn(async move {
            cancelling
                .cancel_snapshot_at(snapshot, &path, Instant::now() + Duration::from_secs(2))
                .await
        });
        bounded(request).await.unwrap();
        let next_generation = if replacement == 2 {
            sessions.disconnect(generation);
            sessions.begin_connection(bridge).unwrap()
        } else {
            generation
        };
        let next_id = if replacement == 0 { 8 } else { 7 };
        sessions.observe(
            next_generation,
            &json!({"event":"wake_triggered","session_id":next_id}),
        );
        let current = sessions.snapshot();
        assert_ne!(current, Some(snapshot));
        release.send(()).unwrap();
        bounded(cancel).await.unwrap().unwrap();
        bounded(server).await.unwrap();
        assert_eq!(sessions.snapshot(), current);
    }
}

#[tokio::test]
async fn stale_cancel_is_rejected_before_writing() {
    let (_directory, path, listener) = listener();
    let sessions = VoiceSessionState::default();
    sessions.observe(0, &json!({"event":"wake_triggered","session_id":7}));
    let snapshot = sessions.snapshot().unwrap();
    sessions.observe(0, &json!({"event":"wake_triggered","session_id":8}));
    assert_eq!(
        sessions
            .cancel_snapshot_at(snapshot, &path, Instant::now() + Duration::from_secs(1))
            .await
            .unwrap_err(),
        "语音会话已过期"
    );
    assert!(timeout(Duration::from_millis(20), listener.accept())
        .await
        .is_err());
    assert_eq!(sessions.snapshot().unwrap().session_id, 8);
}

#[tokio::test]
async fn cancelled_session_is_committed_only_after_matching_confirmation() {
    let (_directory, path, listener) = listener();
    let sessions = VoiceSessionState::default();
    sessions.observe(0, &json!({"event":"wake_triggered","session_id":7}));
    let snapshot = sessions.snapshot().unwrap();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        read_command(&mut stream).await;
        stream
            .write_all(b"{\"event\":\"session_cancelled\",\"session_id\":8}\n")
            .await
            .unwrap();
        stream
            .write_all(b"{\"event\":\"session_cancelled\",\"session_id\":7}\n")
            .await
            .unwrap();
    });
    bounded(sessions.cancel_snapshot_at(snapshot, &path, Instant::now() + Duration::from_secs(1)))
        .await
        .unwrap();
    assert_eq!(sessions.snapshot(), None);
    bounded(server).await.unwrap();
}

#[tokio::test]
async fn silent_cancel_times_out_without_blocking_session_observation() {
    let (_directory, path, listener) = listener();
    let sessions = VoiceSessionState::default();
    sessions.observe(0, &json!({"event":"wake_triggered","session_id":7}));
    let snapshot = sessions.snapshot().unwrap();
    let (received, request) = oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        read_command(&mut stream).await;
        received.send(()).unwrap();
        let mut bytes = Vec::new();
        bounded(stream.read_to_end(&mut bytes)).await.unwrap();
        assert!(bytes.is_empty());
    });
    let cancelling = sessions.clone();
    let cancel = tokio::spawn(async move {
        cancelling
            .cancel_snapshot_at(snapshot, &path, Instant::now() + Duration::from_millis(150))
            .await
    });
    bounded(request).await.unwrap();
    sessions.observe(0, &json!({"event":"wake_triggered","session_id":8}));
    assert_eq!(sessions.snapshot().unwrap().session_id, 8);
    assert!(bounded(cancel).await.unwrap().unwrap_err().contains("超时"));
    assert_eq!(sessions.snapshot().unwrap().session_id, 8);
    bounded(server).await.unwrap();
}

#[tokio::test]
async fn status_response_has_one_deadline_even_with_unrelated_events() {
    let (_directory, path, listener) = listener();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        assert_eq!(read_command(&mut stream).await, json!({"cmd":"get_status"}));
        loop {
            if stream
                .write_all(b"{\"event\":\"vad_monitor\"}\n")
                .await
                .is_err()
            {
                break;
            }
            sleep(Duration::from_millis(10)).await;
        }
    });
    let result = bounded(command_at(
        &path,
        b"{\"cmd\":\"get_status\"}\n",
        Reply::Status,
        Instant::now() + Duration::from_millis(100),
        || true,
    ))
    .await;
    assert!(result.unwrap_err().contains("超时"));
    bounded(server).await.unwrap();
}

#[tokio::test]
async fn blocked_write_expires_and_discards_the_partial_connection() {
    let (_directory, path, listener) = listener();
    let (release, start_reading) = oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        start_reading.await.unwrap();
        let mut partial = Vec::new();
        bounded(stream.read_to_end(&mut partial)).await.unwrap();
        assert!(!partial.is_empty());
        assert!(!partial.contains(&b'\n'));
        let (mut fresh, _) = listener.accept().await.unwrap();
        assert_eq!(
            read_command(&mut fresh).await,
            json!({"cmd":"start_manual_asr"})
        );
    });
    let mut payload = vec![b' '; 8 * 1024 * 1024];
    payload.push(b'\n');
    let result = bounded(command_at(
        &path,
        &payload,
        Reply::Sent,
        Instant::now() + Duration::from_millis(100),
        || true,
    ))
    .await;
    assert!(result.unwrap_err().contains("超时"));
    release.send(()).unwrap();
    bounded(command_at(
        &path,
        b"{\"cmd\":\"start_manual_asr\"}\n",
        Reply::Sent,
        Instant::now() + Duration::from_secs(1),
        || true,
    ))
    .await
    .unwrap();
    bounded(server).await.unwrap();
}

#[tokio::test]
async fn idle_reader_uses_heartbeat_without_losing_partial_events() {
    let (_directory, path, listener) = listener();
    let (probes_done, probes_ready) = oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        for probe in 0..10 {
            assert_eq!(read_command(&mut stream).await, json!({"cmd":"get_status"}));
            if probe == 1 {
                stream
                    .write_all(b"triggered\",\"session_id\":7}\n")
                    .await
                    .unwrap();
            }
            stream
                .write_all(b"{\"event\":\"status\",\"mode\":\"idle\"}\n")
                .await
                .unwrap();
            if probe == 0 {
                stream.write_all(b"{\"event\":\"wake_").await.unwrap();
            }
        }
        probes_done.send(()).unwrap();
        let mut bytes = Vec::new();
        bounded(stream.read_to_end(&mut bytes)).await.unwrap();
    });
    let (events, mut received) = mpsc::unbounded_channel();
    let reader = tokio::spawn(async move {
        read_events(
            &path,
            Duration::from_millis(20),
            Duration::from_millis(150),
            |event| {
                events.send(event).unwrap();
            },
        )
        .await
    });
    bounded(probes_ready).await.unwrap();
    let mut wake_seen = false;
    for _ in 0..11 {
        let event = bounded(received.recv()).await.unwrap();
        wake_seen |= event == json!({"event":"wake_triggered","session_id":7});
    }
    assert!(wake_seen);
    assert!(!reader.is_finished());
    reader.abort();
    assert!(bounded(reader).await.unwrap_err().is_cancelled());
    bounded(server).await.unwrap();
}

#[tokio::test]
async fn reader_heartbeat_requires_status_and_releases_silent_socket() {
    let (_directory, path, listener) = listener();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        read_command(&mut stream).await;
        stream
            .write_all(b"{\"event\":\"vad_monitor\"}\n")
            .await
            .unwrap();
        let mut bytes = Vec::new();
        bounded(stream.read_to_end(&mut bytes)).await.unwrap();
    });
    let result = bounded(read_events(
        &path,
        Duration::from_millis(20),
        Duration::from_millis(100),
        |_| {},
    ))
    .await;
    assert!(result.unwrap_err().contains("心跳超时"));
    bounded(server).await.unwrap();
}

#[tokio::test]
async fn reader_tolerates_a_missed_probe_before_declaring_a_timeout() {
    let (_directory, path, listener) = listener();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        read_command(&mut stream).await;
        // 第一次探针故意不回执：模拟服务端正在执行一条慢命令。窗口取在重试预算
        // （3 × command_timeout）之内，验证的是「漏一次不判死」而不是超时路径。
        sleep(Duration::from_millis(90)).await;
        stream
            .write_all(b"{\"event\":\"status\",\"wake\":true}\n")
            .await
            .unwrap();
        let mut bytes = Vec::new();
        bounded(stream.read_to_end(&mut bytes)).await.unwrap();
    });
    let (events, mut received) = mpsc::unbounded_channel();
    // read_events 借用路径，spawn 又要求 'static：把 PathBuf 与通道一起移进 async 块。
    let reader = tokio::spawn(async move {
        let _ = read_events(
            &path,
            Duration::from_millis(20),
            Duration::from_millis(50),
            move |event| {
                let _ = events.send(event);
            },
        )
        .await;
    });

    // 重试窗口内到达的状态说明空闲一次探针不会把连接判死。
    let event = bounded(received.recv()).await.unwrap();
    assert_eq!(event.get("event").and_then(Value::as_str), Some("status"));
    reader.abort();
    server.abort();
}

#[tokio::test]
async fn bridge_reconnects_and_abort_reclaims_reader_and_followup_cancel() {
    let (_directory, path, listener) = listener();
    let sessions = VoiceSessionState::default();
    let bridge = sessions.reset_bridge();
    let observing = sessions.clone();
    let (events, mut received) = mpsc::unbounded_channel();
    let reader = tokio::spawn(async move {
        run_bridge_reader(
            observing,
            bridge,
            || Ok(path.clone()),
            |_, event| {
                events.send(event).unwrap();
            },
        )
        .await;
    });
    let (mut first, _) = bounded(listener.accept()).await.unwrap();
    read_command(&mut first).await;
    first
        .write_all(b"{\"event\":\"status\",\"mode\":\"listening\",\"session_id\":7}\n")
        .await
        .unwrap();
    bounded(received.recv()).await.unwrap();
    let old = sessions.snapshot().unwrap();
    drop(first);
    let (mut second, _) = bounded(listener.accept()).await.unwrap();
    read_command(&mut second).await;
    second
        .write_all(b"{\"event\":\"status\",\"mode\":\"listening\",\"session_id\":7}\n")
        .await
        .unwrap();
    bounded(received.recv()).await.unwrap();
    let current = sessions.snapshot().unwrap();
    assert_ne!(old.connection_generation, current.connection_generation);
    assert!(!sessions.observe(
        old.connection_generation,
        &json!({"event":"session_cancelled","session_id":7})
    ));
    sessions.disconnect(old.connection_generation);
    assert_eq!(sessions.snapshot(), Some(current));
    second.write_all(b"{\"event\":\"asr_state\",\"state\":\"started\",\"reason\":\"followup\",\"session_id\":7}\n").await.unwrap();
    bounded(received.recv()).await.unwrap();
    let (mut cancellation, _) = bounded(listener.accept()).await.unwrap();
    assert_eq!(
        read_command(&mut cancellation).await,
        json!({"cmd":"cancel","session_id":7})
    );
    second
        .write_all(b"{\"event\":\"wake_triggered\",\"session_id\":8}\n")
        .await
        .unwrap();
    bounded(received.recv()).await.unwrap();
    assert_eq!(sessions.snapshot().unwrap().session_id, 8);
    reader.abort();
    assert!(bounded(reader).await.unwrap_err().is_cancelled());
    assert_eq!(sessions.snapshot(), None);
    for mut stream in [second, cancellation] {
        let mut bytes = Vec::new();
        bounded(stream.read_to_end(&mut bytes)).await.unwrap();
        assert!(bytes.is_empty());
    }
}

#[tokio::test]
async fn reader_rejects_oversized_unterminated_and_invalid_utf8_lines() {
    for payload in [
        vec![b'x'; MAX_EVENT_LINE_BYTES + 1],
        b"{\"event\":\"status\"}".to_vec(),
        vec![0xff, b'\n'],
    ] {
        let (mut sender, receiver) = UnixStream::pair().unwrap();
        let writer = tokio::spawn(async move {
            let _ = sender.write_all(&payload).await;
        });
        let mut reader = EventReader::new(BufReader::new(receiver));
        assert!(bounded(reader.next()).await.is_err());
        drop(reader);
        bounded(writer).await.unwrap();
    }
}

#[tokio::test]
async fn slow_status_succeeds_and_service_errors_are_reported() {
    for response in [
        json!({"event":"status","mode":"idle","session_id":7}),
        json!({"event":"error","code":"SERVICE_OFFLINE"}),
    ] {
        let (_directory, path, listener) = listener();
        let expected = response.clone();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            assert_eq!(read_command(&mut stream).await, json!({"cmd":"get_status"}));
            stream
                .write_all(b"{\"event\":\"parameters\"}\n")
                .await
                .unwrap();
            sleep(Duration::from_millis(20)).await;
            let payload = format!("{response}\n");
            for chunk in payload.as_bytes().chunks(7) {
                stream.write_all(chunk).await.unwrap();
                tokio::task::yield_now().await;
            }
        });
        let result = bounded(command_at(
            &path,
            b"{\"cmd\":\"get_status\"}\n",
            Reply::Status,
            Instant::now() + Duration::from_secs(1),
            || true,
        ))
        .await;
        if expected["event"] == "status" {
            assert_eq!(result.unwrap(), Some(expected));
        } else {
            assert!(result.unwrap_err().contains("SERVICE_OFFLINE"));
        }
        bounded(server).await.unwrap();
    }
}

#[tokio::test]
async fn session_mismatch_and_timeout_do_not_clear_current_session() {
    for mismatch in [false, true] {
        let (_directory, path, listener) = listener();
        let sessions = VoiceSessionState::default();
        sessions.observe(0, &json!({"event":"wake_triggered","session_id":7}));
        let snapshot = sessions.snapshot().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            read_command(&mut stream).await;
            if mismatch {
                stream
                    .write_all(
                        b"{\"event\":\"error\",\"code\":\"SESSION_MISMATCH\",\"session_id\":7}\n",
                    )
                    .await
                    .unwrap();
            }
            let mut bytes = Vec::new();
            bounded(stream.read_to_end(&mut bytes)).await.unwrap();
        });
        let result = bounded(sessions.cancel_snapshot_at(
            snapshot,
            &path,
            Instant::now() + Duration::from_millis(150),
        ))
        .await;
        assert!(result.unwrap_err().contains(if mismatch {
            "SESSION_MISMATCH"
        } else {
            "超时"
        }));
        assert_eq!(sessions.snapshot(), Some(snapshot));
        bounded(server).await.unwrap();
    }
}

#[tokio::test]
async fn heartbeat_failure_reconnects_and_replaced_bridge_cannot_restart() {
    let (_directory, path, listener) = listener();
    let sessions = VoiceSessionState::default();
    let bridge = sessions.reset_bridge();
    let observing = sessions.clone();
    let reader = tokio::spawn(async move {
        run_bridge_reader(observing, bridge, || Ok(path.clone()), |_, _| {}).await;
    });
    let (mut silent, _) = bounded(listener.accept()).await.unwrap();
    read_command(&mut silent).await;
    let mut bytes = Vec::new();
    // 心跳失败现在要经过重试窗口（HEARTBEAT_PROBE_ATTEMPTS × COMMAND_TIMEOUT = 6s），
    // 比通用测试预算长，这里单独放宽。
    timeout(Duration::from_secs(15), silent.read_to_end(&mut bytes))
        .await
        .expect("心跳重试窗口内未结束")
        .unwrap();
    // 放弃之前 reader 会补发探针：这是重试窗口的可见证据，最终连接仍被释放。
    assert!(
        String::from_utf8_lossy(&bytes).contains("get_status"),
        "重试窗口内应补发状态探针"
    );
    let (mut reconnected, _) = bounded(listener.accept()).await.unwrap();
    read_command(&mut reconnected).await;
    let replacement_bridge = sessions.reset_bridge();
    let replacement_connection = sessions.begin_connection(replacement_bridge).unwrap();
    sessions.observe(
        replacement_connection,
        &json!({"event":"wake_triggered","session_id":8}),
    );
    let current = sessions.snapshot();
    drop(reconnected);
    bounded(reader).await.unwrap();
    assert_eq!(sessions.snapshot(), current);
    assert!(sessions.begin_connection(bridge).is_none());
}

#[tokio::test]
async fn expired_command_never_connects() {
    let (_directory, path, listener) = listener();
    assert!(command_at(
        &path,
        b"{\"cmd\":\"start_manual_asr\"}\n",
        Reply::Sent,
        Instant::now(),
        || true
    )
    .await
    .unwrap_err()
    .contains("超时"));
    assert!(timeout(Duration::from_millis(20), listener.accept())
        .await
        .is_err());
}
