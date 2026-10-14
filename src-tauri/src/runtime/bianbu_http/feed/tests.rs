use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
fn requested_from_seq(request: &[u8]) -> Option<u64> {
    let request = String::from_utf8_lossy(request);
    let start = request.find("from_seq=")? + "from_seq=".len();
    request[start..]
        .chars()
        .take_while(|digit| digit.is_ascii_digit())
        .collect::<String>()
        .parse()
        .ok()
}

#[tokio::test]
async fn session_errors_keep_mux_alive_and_reload_preserves_gap_recovery() {
    use futures_util::SinkExt;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = Arc::new(
        Url::parse(&format!(
            "http://{}/api/v1/",
            listener.local_addr().unwrap()
        ))
        .unwrap(),
    );
    let bad_page = Arc::new(AtomicBool::new(false));
    let last_a = Arc::new(AtomicU64::new(0));
    let (frames, frames_rx) = mpsc::channel::<Value>(8);
    let server_bad = bad_page.clone();
    let server_last = last_a.clone();
    let fail_once = Arc::new(AtomicBool::new(false));
    let server_fail_once = fail_once.clone();
    let server = tokio::spawn(async move {
        let mut sender = Some(frames_rx);
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            let count = stream.peek(&mut request).await.unwrap();
            if String::from_utf8_lossy(&request[..count]).contains("/events/host") {
                tokio::spawn(async move {
                    let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
                    ws.send(tokio_tungstenite::tungstenite::Message::Text(
                        json!({"type":"host/sessions","sessions":[]})
                            .to_string()
                            .into(),
                    ))
                    .await
                    .unwrap();
                    while ws.next().await.is_some() {}
                });
                continue;
            }
            if String::from_utf8_lossy(&request[..count]).contains("/events/mux") {
                let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
                let mut input = sender.take().expect("不得因单会话失败重连 mux");
                tokio::spawn(async move {
                    while let Some(value) = input.recv().await {
                        if ws
                            .send(tokio_tungstenite::tungstenite::Message::Text(
                                value.to_string().into(),
                            ))
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                });
                continue;
            }
            let count = stream.read(&mut request).await.unwrap();
            let is_a = String::from_utf8_lossy(&request[..count]).contains("/sessions/a/");
            let unavailable = is_a && server_fail_once.swap(false, Ordering::SeqCst);
            let status = if unavailable {
                "503 Service Unavailable"
            } else {
                "200 OK"
            };
            let body = if unavailable {
                    json!({"error":{"message":"临时不可用"}})
                } else if is_a && server_bad.load(Ordering::SeqCst) {
                    json!({"data": [{"seq":0}, {"seq":2}], "has_more":false})
                } else {
                    let last = if is_a { server_last.load(Ordering::SeqCst) } else { 0 };
                    let from = requested_from_seq(&request).unwrap_or(0);
                    json!({"data":(from..=last).map(|seq| json!({"seq":seq,"type":"assistant/text.delta","data":{"text":"ok"}})).collect::<Vec<_>>(),"base_seq":from,"last_seq":last,"has_more":false})
                }.to_string();
            stream
                .write_all(
                    format!(
                        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        }
    });
    let hub = FeedHub::new(Client::new(), base, "target".into());
    hub.initial("a", None, SessionFeedView::Events)
        .await
        .unwrap();
    hub.initial("b", None, SessionFeedView::Events)
        .await
        .unwrap();
    bad_page.store(true, Ordering::SeqCst);
    let (tx, mut rx) = mpsc::channel(32);
    let task = hub.spawn(tx).pop().unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let event = rx.recv().await.unwrap();
            if event.session_id == "a" && event.connection_status == "disconnected" {
                break;
            }
        }
    })
    .await
    .unwrap();
    assert!(snapshot(&hub).await["a"].1);
    frames
        .send(json!({"type":"session/event","session_id":"b","event":{"seq":1}}))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let event = rx.recv().await.unwrap();
            if event.session_id == "b" && !event.events.is_empty() {
                assert_eq!(event.events[0]["seq"], 1);
                break;
            }
        }
    })
    .await
    .unwrap();
    assert!(hub
        .initial("a", None, SessionFeedView::Events)
        .await
        .is_err());
    assert!(snapshot(&hub).await["a"].1);
    bad_page.store(false, Ordering::SeqCst);
    last_a.store(1, Ordering::SeqCst);
    hub.initial("a", None, SessionFeedView::Events)
        .await
        .unwrap();
    assert!(!snapshot(&hub).await["a"].1);
    assert_eq!(snapshot(&hub).await["a"].0, Some(0));
    last_a.store(3, Ordering::SeqCst);
    frames
        .send(json!({"type":"session/event","session_id":"a","event":{"seq":3}}))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let event = rx.recv().await.unwrap();
            if event.session_id == "a" && !event.events.is_empty() {
                assert_eq!(
                    event
                        .events
                        .iter()
                        .map(|item| seq(item).unwrap())
                        .collect::<Vec<_>>(),
                    vec![1, 2, 3]
                );
                break;
            }
        }
    })
    .await
    .unwrap();
    frames.send(json!({"type":"session/event","session_id":"a","event":{"seq":4,"type":"approval/requested","data":{"actions":"中".repeat(200000)}}})).await.unwrap();
    frames
        .send(json!({"type":"session/event","session_id":"b","event":{"seq":2}}))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        let mut isolated = false;
        loop {
            let event = rx.recv().await.unwrap();
            if event.session_id == "a" && event.connection_status == "disconnected" {
                isolated = true;
            }
            if event.session_id == "b" && !event.events.is_empty() {
                assert!(isolated);
                assert_eq!(event.events[0]["seq"], 2);
                break;
            }
        }
    })
    .await
    .unwrap();
    assert!(!task.is_finished());
    hub.initial("a", None, SessionFeedView::Events)
        .await
        .unwrap();
    fail_once.store(true, Ordering::SeqCst);
    last_a.store(4, Ordering::SeqCst);
    frames
        .send(json!({"type":"session/subscribed","session_id":"a"}))
        .await
        .unwrap();
    frames
        .send(json!({"type":"session/event","session_id":"b","event":{"seq":3}}))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(8), async {
        let mut saw_retry = false;
        let mut saw_b = false;
        loop {
            let event = rx.recv().await.unwrap();
            if event.session_id == "a"
                && event
                    .message
                    .as_deref()
                    .is_some_and(|message| message.contains("正在重试"))
            {
                saw_retry = true;
            }
            if event.session_id == "b" && !event.events.is_empty() {
                saw_b = true;
            }
            if event.session_id == "a" && !event.events.is_empty() {
                assert!(saw_retry && saw_b);
                assert_eq!(event.events[0]["seq"], 4);
                break;
            }
        }
    })
    .await
    .unwrap();
    assert!(!snapshot(&hub).await["a"].1);
    frames
        .send(json!({"type":"unknown/protocol"}))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let event = rx.recv().await.unwrap();
            if event.session_id.is_empty() && event.connection_status == "disconnected" {
                break;
            }
        }
    })
    .await
    .unwrap();
    drop(rx);
    tokio::time::timeout(Duration::from_secs(2), task)
        .await
        .unwrap()
        .unwrap();
    server.abort();
}

async fn snapshot(hub: &FeedHub) -> HashMap<String, (Option<u64>, bool)> {
    hub.command(|reply| Command::Snapshot { reply })
        .await
        .unwrap()
}

#[tokio::test]
async fn history_window_seeds_the_cursor_from_the_window_end_not_the_server_tail() {
    // 折叠窗口只包含 seq 跳变的事件：尾项 seq=21 只是最后一个折叠组的起点，
    // 该组覆盖到 seq=29；而服务端 tail=30 是折叠之后才查的，窗口并不包含它。
    // 用尾项的 seq 会让 seq=22 的实时事件被误判成缺口，用 tail 会直接丢掉 seq=30
    // 这个事件（后续 seq 与游标连续，recover() 也不会补洞）。
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = Arc::new(
        Url::parse(&format!(
            "http://{}/api/v1/",
            listener.local_addr().unwrap()
        ))
        .unwrap(),
    );
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut buf = vec![0; 8192];
        let count = stream.read(&mut buf).await.unwrap();
        let request = String::from_utf8_lossy(&buf[..count]);
        assert!(
            request.starts_with("GET /api/v1/sessions/s/history?"),
            "历史窗口必须读 /history：{request}"
        );
        let body = json!({
                "data": [
                    {"seq":3, "type":"assistant/reasoning.delta", "data":{"text":"想","seq_range":[3,20]}},
                    {"seq":21, "type":"assistant/text.delta", "data":{"text":"答案","seq_range":[21,29]}}
                ],
                "base_seq": 3, "last_seq": 30, "has_more": false, "hidden_run_ids": []
            })
            .to_string();
        stream
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(), body
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
    });
    let hub = FeedHub::new(Client::new(), base, "target".into());
    let page = hub
        .initial("s", None, SessionFeedView::History)
        .await
        .unwrap();
    assert_eq!(
        page.events
            .iter()
            .filter_map(|event| seq(event))
            .collect::<Vec<_>>(),
        vec![3, 21]
    );
    assert_eq!(
        snapshot(&hub).await["s"].0,
        Some(29),
        "History 读必须用窗口覆盖水位（折叠组 seq_range 末尾）落地游标"
    );
    server.await.unwrap();
}

#[tokio::test]
async fn events_window_keeps_reading_the_raw_endpoint() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = Arc::new(
        Url::parse(&format!(
            "http://{}/api/v1/",
            listener.local_addr().unwrap()
        ))
        .unwrap(),
    );
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut buf = vec![0; 8192];
        let count = stream.read(&mut buf).await.unwrap();
        let request = String::from_utf8_lossy(&buf[..count]);
        assert!(
            request.starts_with("GET /api/v1/sessions/s/events?"),
            "实时与补洞必须读原始事件：{request}"
        );
        let body = json!({
            "data": [{"seq":1, "type":"run/completed", "data":{}}],
            "base_seq": 1, "last_seq": 1, "has_more": false, "hidden_run_ids": []
        })
        .to_string();
        stream
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(), body
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
    });
    let hub = FeedHub::new(Client::new(), base, "target".into());
    let page = hub
        .initial("s", None, SessionFeedView::Events)
        .await
        .unwrap();
    assert_eq!(page.events.len(), 1);
    assert_eq!(snapshot(&hub).await["s"].0, Some(1));
    server.await.unwrap();
}

#[test]
fn zero_and_hidden_events_count_but_duplicates_and_gaps_fail() {
    assert!(
        validate_sequence(&[json!({"seq":0,"type":"internal/title"}), json!({"seq":1})]).is_ok()
    );
    assert!(validate_sequence(&[json!({"seq":0}), json!({"seq":2})]).is_err());
    assert!(validate_sequence(&[json!({"seq":0}), json!({"seq":0})]).is_err());
}

#[tokio::test]
async fn cursor_rejection_falls_back_to_the_window_and_is_remembered() {
    // 旧 Runtime（0.1.23）对不认识的 from_seq 回 422。补洞必须退回窗口快照，并且
    // 记住这台 Runtime 不认游标——否则每次补洞都白跑一次 422。
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = Arc::new(
        Url::parse(&format!(
            "http://{}/api/v1/",
            listener.local_addr().unwrap()
        ))
        .unwrap(),
    );
    let requests = Arc::new(std::sync::Mutex::new(Vec::new()));
    let seen = requests.clone();
    let server = tokio::spawn(async move {
        // 第一次补洞两跳：试探 from_seq(422) → 退回窗口；第二次补洞只剩窗口一跳。
        for _ in 0..3 {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut buf = vec![0; 8192];
            let count = stream.read(&mut buf).await.unwrap();
            let request = String::from_utf8_lossy(&buf[..count]).to_string();
            seen.lock().unwrap().push(request.clone());
            let (status, body) = if request.contains("from_seq=") {
                (
                    "422 Unprocessable Content",
                    json!({"error":{"code":"validation_error"}}),
                )
            } else {
                (
                    "200 OK",
                    json!({
                        "data": [{"seq":5, "type":"run/completed", "data":{}}],
                        "base_seq": 5, "last_seq": 5, "has_more": false
                    }),
                )
            };
            stream.write_all(format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.to_string().len(), body).as_bytes()).await.unwrap();
        }
    });
    let hub = FeedHub::new(Client::new(), base, "target".into());
    let (tx, mut rx) = mpsc::channel(16);
    assert_eq!(
        hub.reader.recover("s", Some(4), &tx).await.unwrap(),
        Some(5)
    );
    let frame = rx.recv().await.unwrap();
    assert_eq!(
        frame
            .events
            .iter()
            .map(|e| seq(e).unwrap())
            .collect::<Vec<_>>(),
        vec![5],
        "422 之后必须由窗口快照补出事件"
    );
    // 第二次补洞不再试探 from_seq：这台 Runtime 的游标能力已被永久关掉。
    assert_eq!(
        hub.reader.recover("s", Some(4), &tx).await.unwrap(),
        Some(5)
    );
    let frame = rx.recv().await.unwrap();
    assert_eq!(
        frame
            .events
            .iter()
            .map(|e| seq(e).unwrap())
            .collect::<Vec<_>>(),
        vec![5]
    );
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 3, "第一次两跳、第二次一跳: {requests:?}");
    assert!(
        requests[0].contains("from_seq=5"),
        "第一次必须试探游标: {}",
        requests[0]
    );
    assert!(
        requests[1].contains("max_messages=50") && !requests[1].contains("from_seq="),
        "被拒后当次即退回窗口: {}",
        requests[1]
    );
    assert!(
        requests[2].contains("max_messages=50") && !requests[2].contains("from_seq="),
        "降级后不得再发游标读: {}",
        requests[2]
    );
    drop(requests);
    server.await.unwrap();
}

#[tokio::test]
async fn recovery_walks_multiple_pages_and_does_not_consume_tail() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = Arc::new(
        Url::parse(&format!(
            "http://{}/api/v1/",
            listener.local_addr().unwrap()
        ))
        .unwrap(),
    );
    let server = tokio::spawn(async move {
        for (from, first, last, more) in [(1u64, 1u64, 199u64, true), (200, 200, 250, false)] {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut buf = vec![0; 8192];
            let count = stream.read(&mut buf).await.unwrap();
            let request = String::from_utf8_lossy(&buf[..count]);
            assert!(request.contains(&format!("from_seq={from}")));
            assert!(!request.contains("before_seq="), "游标补洞不得再向前翻窗口");
            let body = json!({"data": (first..=last).map(|seq| json!({"seq":seq,"type":"internal/title"})).collect::<Vec<_>>(), "base_seq": first,"last_seq":250,"has_more":more}).to_string();
            stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).as_bytes()).await.unwrap();
        }
    });
    let hub = FeedHub::new(Client::new(), base, "target".into());
    let (tx, mut rx) = mpsc::channel(16);
    let end = hub.reader.recover("s", Some(0), &tx).await.unwrap();
    assert_eq!(end, Some(250));
    drop(tx);
    let mut seqs = vec![];
    while let Some(frame) = rx.recv().await {
        seqs.extend(frame.events.iter().map(|e| seq(e).unwrap()));
    }
    assert_eq!(seqs, (1..=250).collect::<Vec<_>>());
    server.await.unwrap();
}

#[tokio::test]
async fn cursor_read_returns_invisible_boundary_events_without_backward_paging() {
    // 深修：_history_page 从第一个可见消息边界（如 user/message）开始返回即时窗口，会剔除
    // agent/inbox/spliced(seq=0)/agent/inbox/claimed(seq=1)。旧实现只能靠 before_seq 向前翻页
    // 把它们捞回来，翻到 has_more=false 之前还会误判「历史未覆盖已知边界」暂停会话。
    // 游标读返回的是未折叠的原始流，这些边界事件本来就在 (游标, 尾部] 里：一次读就够。
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = Arc::new(
        Url::parse(&format!(
            "http://{}/api/v1/",
            listener.local_addr().unwrap()
        ))
        .unwrap(),
    );
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut buf = vec![0; 8192];
        let count = stream.read(&mut buf).await.unwrap();
        let request = String::from_utf8_lossy(&buf[..count]);
        assert!(request.contains("from_seq=1"));
        assert!(
            !request.contains("before_seq="),
            "原始流里已经有边界事件，不需要向前翻页"
        );
        let body = json!({
            "data": [
                {"seq":1, "type":"agent/inbox/claimed", "data":{"message_ids":["m0"]}},
                {"seq":2, "type":"user/message", "data":{"message_id":"m0","content":"hello"}},
                {"seq":3, "type":"request/context", "data":{}},
                {"seq":4, "type":"run/event", "data":{}},
                {"seq":5, "type":"run/failed", "data":{}}
            ],
            "base_seq": 1,
            "last_seq": 5,
            "has_more": false
        })
        .to_string();
        stream
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(), body
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
    });
    let hub = FeedHub::new(Client::new(), base, "target".into());
    let (tx, mut rx) = mpsc::channel(16);
    // 游标停在 seq=0：已收到 spliced，但 claimed(seq=1) 尚未到达即触发补洞。
    let end = hub.reader.recover("s", Some(0), &tx).await.unwrap();
    assert_eq!(end, Some(5));
    drop(tx);
    let mut seqs = vec![];
    while let Some(frame) = rx.recv().await {
        seqs.extend(frame.events.iter().map(|e| seq(e).unwrap()));
    }
    assert_eq!(seqs, vec![1, 2, 3, 4, 5], "补洞须带回被窗口剔除的边界事件");
    server.await.unwrap();
}
#[test]
fn oversized_body_preserves_utf8_but_never_truncates_approval_actions() {
    let approval = bound_event(json!({"seq":0,"type":"approval/requested","run_id":"r", "data":{"approval_id":"a", "actions":[{"name":"write","arguments":{"content":"中".repeat(200000)},"allowed_decisions":["approve","reject"]}]}})).unwrap_err();
    assert!(!approval.recoverable);
    let event = bound_event(json!({"seq":0,"type":"assistant/text.delta","run_id":"r", "data":{"text":"中".repeat(200000)}})).unwrap();
    assert_eq!(event["seq"], 0);
    assert_eq!(event["data"]["_display_truncated"], true);
    assert!(serde_json::to_vec(&event).unwrap().len() < crate::runtime::MAX_EVENT_BYTES);
}

/// 线上真实故障的回归：下游（GUI 投递通道）被拖满时，读循环**不能**再停摆。
///
/// Bianbu Runtime 用 `websockets` 服务端，默认每 20 秒 ping 一次、20 秒内收不到 pong 就
/// 单方面断开；旧实现把帧直接 `send().await` 到有界通道，通道一满，socket 任务就再也不被
/// poll，既回不了 pong 也读不到 FIN——表现就是「对话内容停在某一刻，既不恢复也不显示断线」。
/// 现在读循环只用 `try_send`：满了就丢帧并标记会话待恢复，连接健康时绝不重建。
#[tokio::test]
async fn saturated_downlink_keeps_answering_heartbeats_and_recovers_without_reconnecting() {
    use futures_util::SinkExt;
    use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
    use tokio_tungstenite::tungstenite::Message;

    const EVENTS: u64 = 120;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = Arc::new(
        Url::parse(&format!(
            "http://{}/api/v1/",
            listener.local_addr().unwrap()
        ))
        .unwrap(),
    );
    let pongs = Arc::new(AtomicUsize::new(0));
    let missed = Arc::new(AtomicUsize::new(0));
    let connections = Arc::new(AtomicUsize::new(0));
    let server_pongs = pongs.clone();
    let server_missed = missed.clone();
    let server_connections = connections.clone();
    let server = tokio::spawn(async move {
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut head = [0u8; 2048];
            let read = stream.peek(&mut head).await.unwrap();
            let head = String::from_utf8_lossy(&head[..read]).to_string();
            if head.contains("/events/host") {
                tokio::spawn(async move {
                    if let Ok(mut socket) = tokio_tungstenite::accept_async(stream).await {
                        let _ = socket
                            .send(Message::Text(
                                json!({"type":"host/sessions","sessions":[]})
                                    .to_string()
                                    .into(),
                            ))
                            .await;
                        while let Some(Ok(frame)) = socket.next().await {
                            if frame.is_ping() {
                                let _ = socket.flush().await;
                            }
                        }
                    }
                });
                continue;
            }
            if head.contains("/events/mux") {
                let pongs = server_pongs.clone();
                let missed = server_missed.clone();
                let connections = server_connections.clone();
                tokio::spawn(async move {
                    connections.fetch_add(1, AtomicOrdering::SeqCst);
                    let Ok(mut socket) = tokio_tungstenite::accept_async(stream).await else {
                        return;
                    };
                    for sequence in 0..EVENTS {
                        let frame = json!({"type":"session/event","session_id":"s","event":{"seq":sequence,"type":"assistant/text.delta","data":{"text":"x"}}});
                        if socket
                            .send(Message::Text(frame.to_string().into()))
                            .await
                            .is_err()
                        {
                            return;
                        }
                        if sequence % 20 != 0 {
                            continue;
                        }
                        if socket.send(Message::Ping(Vec::new().into())).await.is_err() {
                            return;
                        }
                        let deadline = tokio::time::Instant::now() + Duration::from_millis(500);
                        loop {
                            match tokio::time::timeout_at(deadline, socket.next()).await {
                                Ok(Some(Ok(Message::Pong(_)))) => {
                                    pongs.fetch_add(1, AtomicOrdering::SeqCst);
                                    break;
                                }
                                Ok(Some(Ok(_))) => continue,
                                _ => {
                                    missed.fetch_add(1, AtomicOrdering::SeqCst);
                                    return;
                                }
                            }
                        }
                    }
                    // 发完之后继续读：真实 Runtime 的 websockets 服务端会自动回 pong，
                    // 假服务端停在 pending() 会被客户端的心跳探测判成失联（那是另一个用例）。
                    while let Some(Ok(frame)) = socket.next().await {
                        if frame.is_ping() {
                            let _ = socket.flush().await;
                        }
                    }
                });
                continue;
            }
            let mut request = vec![0; 8192];
            let count = stream.read(&mut request).await.unwrap();
            let request = String::from_utf8_lossy(&request[..count]).to_string();
            let from = requested_from_seq(request.as_bytes()).unwrap_or(0);
            let body = json!({
                    "data": (from..EVENTS).map(|sequence| json!({"seq":sequence,"type":"assistant/text.delta","data":{"text":"x"}})).collect::<Vec<_>>(),
                    "last_seq": EVENTS - 1,
                    "has_more": false
                })
                .to_string();
            stream
                    .write_all(
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                            body.len(),
                            body
                        )
                        .as_bytes(),
                    )
                    .await
                    .unwrap();
        }
    });

    let hub = FeedHub::new(Client::new(), base, "target".into());
    let (tx, mut rx) = mpsc::channel(4);
    let _tasks = hub.spawn(tx);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    let mut seen = vec![];
    while (seen.len() as u64) < EVENTS {
        // 通道永远有货时 `timeout_at` 会一直返回数据，所以截止时间必须显式判断。
        if tokio::time::Instant::now() >= deadline {
            break;
        }
        let Ok(Some(event)) = tokio::time::timeout_at(deadline, rx.recv()).await else {
            break;
        };
        seen.extend(event.events.iter().filter_map(seq));
        tokio::time::sleep(Duration::from_millis(15)).await;
    }
    let diagnostics = hub
        .command(|reply| Command::Diagnostics { reply })
        .await
        .unwrap();
    assert!(
        diagnostics["counters"]["shed"].as_u64().unwrap_or(0) > 0,
        "下游容量只有 4，必须真的触发过丢帧恢复才对得上线上场景：{diagnostics}"
    );
    assert_eq!(
        missed.load(AtomicOrdering::SeqCst),
        0,
        "读循环停摆过：服务端的 ping 没有及时拿到 pong"
    );
    assert_eq!(
        connections.load(AtomicOrdering::SeqCst),
        1,
        "连接是健康的，丢帧恢复不得重连 mux"
    );
    assert_eq!(
        seen,
        (0..EVENTS).collect::<Vec<_>>(),
        "丢帧后必须从已确认游标补读，事件不能丢也不能重复：{diagnostics}"
    );
    server.abort();
}

/// 读窗口失败（Runtime 不可达、会话不存在等）不能占用会话槽位：早期实现先登记游标再读页面，
/// 256 个失败读就能把表撑满，之后所有会话都会以「超过 256 个」被拒。
#[tokio::test]
async fn a_failed_window_read_leaves_the_session_table_untouched() {
    let hub = FeedHub::new(
        Client::new(),
        Arc::new(Url::parse("http://127.0.0.1:9/api/v1/").unwrap()),
        "target".into(),
    );
    let count = |diagnostics: Value| {
        diagnostics["sessions"]
            .as_object()
            .map_or(0, |sessions| sessions.len())
    };
    let before = hub
        .command(|reply| Command::Diagnostics { reply })
        .await
        .unwrap();
    assert!(hub
        .initial("unreachable", None, SessionFeedView::Events)
        .await
        .is_err());
    let after = hub
        .command(|reply| Command::Diagnostics { reply })
        .await
        .unwrap();
    assert_eq!(count(before), 0);
    assert_eq!(count(after), 0, "失败的窗口读不得占用会话槽位");
}
