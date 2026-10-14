use super::MAX_EVENT_LINE_BYTES;
use serde_json::Value;
use std::path::Path;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::time::{sleep_until, timeout_at, Duration, Instant};

pub(super) const COMMAND_TIMEOUT: Duration = Duration::from_secs(2);
pub(super) const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);
/// 探针未回执时的容忍次数。一次漏答说明服务端可能正在执行一条慢命令，把它当成
/// 掉线会让界面显示一个假的「未连接」；连续多次无响应才按不可用处理。
const HEARTBEAT_PROBE_ATTEMPTS: usize = 3;
const STATUS_COMMAND: &[u8] = b"{\"cmd\":\"get_status\"}\n";

#[derive(Clone, Copy)]
pub(super) enum Reply {
    Sent,
    Status,
    Cancelled(u64),
}

pub(super) struct EventReader<R> {
    reader: R,
    partial: Vec<u8>,
}

impl<R: AsyncBufRead + Unpin> EventReader<R> {
    pub(super) fn new(reader: R) -> Self {
        Self {
            reader,
            partial: Vec::new(),
        }
    }

    pub(super) async fn next(&mut self) -> Result<Option<Value>, String> {
        loop {
            let chunk = self
                .reader
                .fill_buf()
                .await
                .map_err(|error| error.to_string())?;
            if chunk.is_empty() {
                return if self.partial.is_empty() {
                    Ok(None)
                } else {
                    Err("语音事件缺少换行符".to_owned())
                };
            }
            let newline = chunk.iter().position(|byte| *byte == b'\n');
            let take = newline.unwrap_or(chunk.len());
            if self.partial.len() + take > MAX_EVENT_LINE_BYTES {
                return Err("语音事件超过长度限制".to_owned());
            }
            self.partial.extend_from_slice(&chunk[..take]);
            self.reader.consume(take + usize::from(newline.is_some()));
            if newline.is_some() {
                std::str::from_utf8(&self.partial).map_err(|error| error.to_string())?;
                let parsed = serde_json::from_slice(&self.partial);
                self.partial.clear();
                if let Ok(event) = parsed {
                    return Ok(Some(event));
                }
            }
        }
    }
}

async fn write_until<W: AsyncWrite + Unpin>(
    writer: &mut W,
    payload: &[u8],
    deadline: Instant,
) -> Result<(), String> {
    if Instant::now() >= deadline {
        return Err("语音命令超时".to_owned());
    }
    timeout_at(deadline, writer.write_all(payload))
        .await
        .map_err(|_| "语音命令超时".to_owned())?
        .map_err(|error| format!("无法写入语音命令: {error}"))
}

async fn connect_until(path: &Path, deadline: Instant) -> Result<UnixStream, String> {
    timeout_at(deadline, UnixStream::connect(path))
        .await
        .map_err(|_| "语音命令超时".to_owned())?
        .map_err(|error| format!("Voice Tool 未连接: {error}"))
}

pub(super) async fn command_at(
    path: &Path,
    payload: &[u8],
    reply: Reply,
    deadline: Instant,
    still_current: impl Fn() -> bool,
) -> Result<Option<Value>, String> {
    if Instant::now() >= deadline {
        return Err("语音命令超时".to_owned());
    }
    if !still_current() {
        return Err("语音会话已过期".to_owned());
    }
    timeout_at(deadline, async {
        let mut stream = connect_until(path, deadline).await?;
        if !still_current() {
            return Err("语音会话已过期".to_owned());
        }
        write_until(&mut stream, payload, deadline).await?;
        if matches!(reply, Reply::Sent) {
            return Ok(None);
        }
        let mut reader = EventReader::new(BufReader::new(stream));
        while let Some(event) = reader.next().await? {
            let kind = event.get("event").and_then(Value::as_str);
            let session_id = event.get("session_id").and_then(Value::as_u64);
            if kind == Some("error") {
                let code = event.get("code").and_then(Value::as_str).unwrap_or("UNKNOWN");
                if matches!(code, "SERVICE_OFFLINE" | "SERVICE_DISCONNECTED")
                    || matches!(reply, Reply::Cancelled(expected) if code == "SESSION_MISMATCH" && session_id == Some(expected))
                {
                    return Err(format!("语音命令失败: {code}"));
                }
            }
            let accepted = match reply {
                Reply::Sent => false,
                Reply::Status => kind == Some("status"),
                Reply::Cancelled(expected) => session_id == Some(expected)
                    && (matches!(kind, Some("session_cancelled" | "session_exit"))
                        || (kind == Some("status")
                            && event.get("mode").and_then(Value::as_str) == Some("idle"))),
            };
            if accepted {
                return Ok(Some(event));
            }
        }
        Err("语音服务连接中断".to_owned())
    })
    .await
    .map_err(|_| "语音命令超时".to_owned())?
}

pub(super) async fn read_events(
    path: &Path,
    heartbeat_interval: Duration,
    command_timeout: Duration,
    mut on_event: impl FnMut(Value),
) -> Result<(), String> {
    let deadline = Instant::now() + command_timeout;
    let stream = connect_until(path, deadline).await?;
    let (read_half, mut write_half) = stream.into_split();
    let mut reader = EventReader::new(BufReader::new(read_half));
    write_until(&mut write_half, STATUS_COMMAND, deadline).await?;
    let mut probe_deadline = Some(deadline);
    let mut next_probe = deadline;
    let mut probe_attempts = 0usize;
    loop {
        tokio::select! {
            biased;
            _ = sleep_until(probe_deadline.unwrap_or(next_probe)) => {
                if probe_deadline.is_some() {
                    probe_attempts += 1;
                    if probe_attempts >= HEARTBEAT_PROBE_ATTEMPTS {
                        return Err("语音状态心跳超时".to_owned());
                    }
                    let retry_deadline = Instant::now() + command_timeout;
                    write_until(&mut write_half, STATUS_COMMAND, retry_deadline).await?;
                    probe_deadline = Some(retry_deadline);
                    continue;
                }
                probe_attempts = 0;
                let deadline = Instant::now() + command_timeout;
                write_until(&mut write_half, STATUS_COMMAND, deadline).await?;
                probe_deadline = Some(deadline);
            }
            event = reader.next() => {
                let event = event?.ok_or_else(|| "语音服务连接中断".to_owned())?;
                if event.get("event").and_then(Value::as_str) == Some("status") {
                    probe_deadline = None;
                    probe_attempts = 0;
                    next_probe = Instant::now() + heartbeat_interval;
                }
                let disconnected = event.get("event").and_then(Value::as_str) == Some("error")
                    && matches!(event.get("code").and_then(Value::as_str), Some("SERVICE_OFFLINE" | "SERVICE_DISCONNECTED"));
                on_event(event);
                if disconnected {
                    return Err("语音服务连接中断".to_owned());
                }
            }
        }
    }
}
