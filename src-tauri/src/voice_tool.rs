use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration as StdDuration, Instant};
use tauri::{AppHandle, Emitter, Manager, Runtime, State, WebviewWindow};
use tokio::time::{sleep, Duration, Instant as TokioInstant};

mod socket;
use socket::{command_at, Reply, COMMAND_TIMEOUT, HEARTBEAT_INTERVAL};

pub(crate) const VOICE_TOOL_EVENT: &str = "voice-tool-event";
const VOICE_BALL_LABEL: &str = "voice-ball";
const MAX_EVENT_LINE_BYTES: usize = 64 * 1024;
const EVENT_BUFFER_LIMIT: usize = 32;
const EVENT_BUFFER_TTL: StdDuration = StdDuration::from_secs(5);

/// 唤醒流程只驱动"球在听"这一件事。
///
/// "球在想"统一由浮窗里的 VoiceBallBusyBridge 按会话忙碌态下发——它有完整的
/// 转写/交接/跑回答三段信息。两边都写会互相覆盖：这里设了 thinking=true 之后，
/// 浮窗那边如果判定没有边沿变化就不会再发，球就永远转下去。
fn set_ball_listening<R: Runtime>(app: &AppHandle<R>, listening: bool) {
    let _ = app.emit_to(
        VOICE_BALL_LABEL,
        "voice-ball:set-listening",
        json!({"listening": listening}),
    );
}

fn is_session_start(event: &Value) -> bool {
    match event.get("event").and_then(Value::as_str) {
        Some("wake_triggered") => true,
        Some("asr_state") => {
            event.get("state").and_then(Value::as_str) == Some("started")
                && event.get("reason").and_then(Value::as_str) == Some("manual")
        }
        _ => false,
    }
}

fn is_replayable_event(event: &Value) -> bool {
    matches!(
        event.get("event").and_then(Value::as_str),
        Some(
            "wake_triggered"
                | "asr_state"
                | "listening"
                | "speech_started"
                | "recognizing"
                | "asr_final"
                | "error"
                | "session_cancelled"
                | "session_exit"
        )
    )
}

#[derive(Clone, Default)]
pub struct VoiceEventBuffer(Arc<Mutex<VoiceEventBufferInner>>);

#[derive(Default)]
struct VoiceEventBufferInner {
    next_sequence: u64,
    events: Vec<(u64, Instant, Value)>,
    consumer_cursors: HashMap<String, u64>,
}

impl VoiceEventBuffer {
    fn push(&self, event: Value) {
        if !is_replayable_event(&event) {
            return;
        }
        let Ok(mut buffer) = self.0.lock() else {
            return;
        };
        buffer.next_sequence = buffer.next_sequence.wrapping_add(1);
        let sequence = buffer.next_sequence;
        buffer.events.push((sequence, Instant::now(), event));
        if buffer.events.len() > EVENT_BUFFER_LIMIT {
            let drop_count = buffer.events.len() - EVENT_BUFFER_LIMIT;
            buffer.events.drain(..drop_count);
        }
    }

    fn replay_latest_wake(&self, consumer_id: &str) -> Vec<Value> {
        let Ok(mut buffer) = self.0.lock() else {
            return Vec::new();
        };
        buffer
            .events
            .retain(|(_, created_at, _)| created_at.elapsed() <= EVENT_BUFFER_TTL);
        let latest_sequence = buffer
            .events
            .last()
            .map(|(sequence, _, _)| *sequence)
            .unwrap_or(0);
        let acknowledged = *buffer
            .consumer_cursors
            .entry(consumer_id.to_owned())
            .or_insert(0);
        let start = buffer
            .events
            .iter()
            .rposition(|(sequence, _, event)| *sequence > acknowledged && is_session_start(event))
            .unwrap_or(buffer.events.len());
        let replay = buffer.events[start..]
            .iter()
            .filter(|(sequence, _, _)| *sequence > acknowledged)
            .map(|(_, _, event)| event.clone())
            .collect();
        buffer
            .consumer_cursors
            .insert(consumer_id.to_owned(), latest_sequence);
        replay
    }
}

#[derive(Clone, Default)]
pub struct VoiceSessionState(Arc<Mutex<VoiceSessionInner>>);

#[derive(Default)]
struct VoiceSessionInner {
    active: Option<u64>,
    generation: u64,
    bridge_generation: u64,
    connection_generation: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct VoiceSessionSnapshot {
    session_id: u64,
    generation: u64,
    connection_generation: u64,
}

impl VoiceSessionInner {
    fn snapshot(&self) -> Option<VoiceSessionSnapshot> {
        self.active.map(|session_id| VoiceSessionSnapshot {
            session_id,
            generation: self.generation,
            connection_generation: self.connection_generation,
        })
    }
}

impl VoiceSessionState {
    fn reset_bridge(&self) -> u64 {
        let mut state = self.0.lock().unwrap_or_else(|error| error.into_inner());
        state.bridge_generation = state.bridge_generation.wrapping_add(1);
        state.connection_generation = state.connection_generation.wrapping_add(1);
        state.active = None;
        state.bridge_generation
    }

    fn begin_connection(&self, bridge_generation: u64) -> Option<u64> {
        let mut state = self.0.lock().ok()?;
        if state.bridge_generation != bridge_generation {
            return None;
        }
        state.connection_generation = state.connection_generation.wrapping_add(1);
        state.active = None;
        Some(state.connection_generation)
    }

    fn disconnect(&self, connection_generation: u64) {
        if let Ok(mut state) = self.0.lock() {
            if state.connection_generation == connection_generation {
                state.connection_generation = state.connection_generation.wrapping_add(1);
                state.active = None;
            }
        }
    }

    fn observe(&self, connection_generation: u64, event: &Value) -> bool {
        let Ok(mut state) = self.0.lock() else {
            return false;
        };
        if state.connection_generation != connection_generation {
            return false;
        }
        let kind = event.get("event").and_then(Value::as_str);
        let session_id = event
            .get("session_id")
            .and_then(Value::as_u64)
            .filter(|id| *id != 0);
        match kind {
            Some(_)
                if is_session_start(event)
                    || (kind == Some("asr_state")
                        && event.get("state").and_then(Value::as_str) == Some("started")) =>
            {
                state.generation = state.generation.wrapping_add(1);
                state.active = session_id;
            }
            Some("listening") => {
                if state.active != session_id {
                    state.generation = state.generation.wrapping_add(1);
                    state.active = session_id;
                }
            }
            Some("status") => {
                let active = match event.get("mode").and_then(Value::as_str) {
                    Some("idle") => None,
                    Some("listening" | "recognizing") => session_id,
                    _ => return true,
                };
                if state.active != active {
                    state.generation = state.generation.wrapping_add(1);
                    state.active = active;
                }
            }
            Some("session_cancelled" | "session_exit") => {
                if session_id.is_some() && state.active == session_id {
                    state.active = None;
                }
            }
            _ => {}
        }
        true
    }

    fn snapshot(&self) -> Option<VoiceSessionSnapshot> {
        self.0.lock().ok().and_then(|state| state.snapshot())
    }

    fn is_connection_current(&self, generation: u64) -> bool {
        self.0
            .lock()
            .map(|state| state.connection_generation == generation)
            .unwrap_or(false)
    }

    fn is_current(&self, snapshot: VoiceSessionSnapshot) -> bool {
        self.snapshot() == Some(snapshot)
    }

    fn commit_cancel(&self, snapshot: VoiceSessionSnapshot) {
        if let Ok(mut state) = self.0.lock() {
            if state.snapshot() == Some(snapshot) {
                state.active = None;
            }
        }
    }

    pub async fn cancel_current(&self) -> Result<(), String> {
        let deadline = TokioInstant::now() + COMMAND_TIMEOUT;
        let Some(snapshot) = self.snapshot() else {
            return Ok(());
        };
        self.cancel_snapshot_at(snapshot, &socket_path()?, deadline)
            .await
    }

    async fn cancel_session(&self, expected_session_id: u64) -> Result<(), String> {
        let deadline = TokioInstant::now() + COMMAND_TIMEOUT;
        let Some(snapshot) = self.snapshot() else {
            return Ok(());
        };
        if expected_session_id != snapshot.session_id {
            return Err("语音会话已过期".to_owned());
        }
        self.cancel_snapshot_at(snapshot, &socket_path()?, deadline)
            .await
    }

    async fn cancel_snapshot_at(
        &self,
        snapshot: VoiceSessionSnapshot,
        path: &std::path::Path,
        deadline: TokioInstant,
    ) -> Result<(), String> {
        command_at(
            path,
            cancel_command(snapshot.session_id).as_bytes(),
            Reply::Cancelled(snapshot.session_id),
            deadline,
            || self.is_current(snapshot),
        )
        .await?;
        self.commit_cancel(snapshot);
        Ok(())
    }
}

pub struct VoiceBridgeTask(Arc<Mutex<Option<tauri::async_runtime::JoinHandle<()>>>>);

impl Default for VoiceBridgeTask {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(None)))
    }
}

fn cancel_command(session_id: u64) -> String {
    let mut command = json!({ "cmd": "cancel", "session_id": session_id }).to_string();
    command.push('\n');
    command
}

pub async fn cancel_current<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let state = app
        .try_state::<VoiceSessionState>()
        .ok_or_else(|| "语音会话状态不可用".to_owned())?;
    state.cancel_current().await
}

pub async fn cancel_observed<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let state = app
        .try_state::<VoiceSessionState>()
        .ok_or("语音会话状态不可用")?;
    state.cancel_current().await
}

async fn send_command(payload: &[u8], reply: Reply) -> Result<Option<Value>, String> {
    let deadline = TokioInstant::now() + COMMAND_TIMEOUT;
    command_at(&socket_path()?, payload, reply, deadline, || true).await
}

/// 语音 Socket 目录候选：优先本会话的 `$XDG_RUNTIME_DIR/bibit`（会话级改造后的
/// 路径），`/run/bibit` 是改造前的整机级路径，仅保留作升级过渡回退。
// ponytail: 过渡回退，一个发布周期后删除，届时只留 XDG_RUNTIME_DIR。
fn socket_dir_candidates() -> Vec<PathBuf> {
    socket_dirs_for(std::env::var_os("XDG_RUNTIME_DIR").as_deref())
}

fn socket_dirs_for(runtime_dir: Option<&std::ffi::OsStr>) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(base) = runtime_dir {
        if !base.is_empty() {
            dirs.push(PathBuf::from(base).join("bibit"));
        }
    }
    dirs.push(PathBuf::from("/run/bibit"));
    dirs
}

fn socket_path() -> Result<PathBuf, String> {
    let mut first_error: Option<String> = None;
    for socket_dir in socket_dir_candidates() {
        match validated_socket_path(&socket_dir) {
            Ok(path) => return Ok(path),
            Err(error) => first_error = first_error.or(Some(error)),
        }
    }
    Err(first_error.unwrap_or_else(|| "语音 Socket 目录不可用".to_owned()))
}

/// 目录必须存在、属于本进程用户、且不含 group/other 权限位；socket 文件存在时
/// 同样校验类型、属主与权限。
fn validated_socket_path(socket_dir: &std::path::Path) -> Result<PathBuf, String> {
    let dir_metadata = std::fs::symlink_metadata(socket_dir)
        .map_err(|error| format!("语音 Socket 目录不可用: {error}"))?;
    if !dir_metadata.is_dir() {
        return Err("语音 Socket 目录不是目录".to_owned());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if dir_metadata.uid() != unsafe { libc::geteuid() } || dir_metadata.mode() & 0o077 != 0 {
            return Err("语音 Socket 目录权限或所有者不安全".to_owned());
        }
    }
    let socket = socket_dir.join("tool.sock");
    if let Ok(metadata) = std::fs::symlink_metadata(&socket) {
        #[cfg(unix)]
        use std::os::unix::fs::FileTypeExt;
        #[cfg(unix)]
        if !metadata.file_type().is_socket() {
            return Err("语音 Socket 路径不是 Unix Socket".to_owned());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 {
                return Err("语音 Socket 权限或所有者不安全".to_owned());
            }
        }
    }
    Ok(socket)
}

pub fn start_bridge<R: Runtime>(app: AppHandle<R>) {
    let buffer = app.state::<VoiceEventBuffer>().inner().clone();
    let sessions = app.state::<VoiceSessionState>().inner().clone();
    let bridge_app = app.clone();
    let bridge = app.state::<VoiceBridgeTask>();
    let Ok(mut slot) = bridge.0.lock() else {
        return;
    };
    if let Some(previous) = slot.take() {
        previous.abort();
    }
    let generation = sessions.reset_bridge();
    let event_sessions = sessions.clone();
    let task = tauri::async_runtime::spawn(async move {
        let mut wake_ball_active = false;
        run_bridge_reader(
            sessions,
            generation,
            socket_path,
            move |connection_generation, event| {
                if let Some(event_name) = event.get("event").and_then(Value::as_str) {
                    let schedule_app = bridge_app.clone();
                    let callback_sessions = event_sessions.clone();
                    match event_name {
                        // 首次唤醒显示小球；已展开的聊天浮窗继续承载语音输入。
                        "wake_triggered" => {
                            wake_ball_active = true;
                            let callback_app = bridge_app.clone();
                            if let Err(error) = schedule_app.run_on_main_thread(move || {
                                if !callback_sessions.is_connection_current(connection_generation) {
                                    return;
                                }
                                if let Err(error) = crate::voice_overlay::show_ball(&callback_app) {
                                    log::error!(
                                        "voice_overlay.wake_show_ball_failed error={error}"
                                    );
                                }
                                set_ball_listening(&callback_app, true);
                            }) {
                                log::error!("voice_overlay.wake_schedule_failed error={error}");
                            }
                        }
                        // 讲话完毕：球离开聆听态。思考态由浮窗按 phase/handingOff
                        // 接手，与后面的会话忙碌态无缝衔接。
                        "recognizing" => {
                            let callback_app = bridge_app.clone();
                            if let Err(error) = schedule_app.run_on_main_thread(move || {
                                if !callback_sessions.is_connection_current(connection_generation) {
                                    return;
                                }
                                set_ball_listening(&callback_app, false);
                            }) {
                                log::error!("voice_overlay.wake_schedule_failed error={error}");
                            }
                        }
                        // 最终文本由浮窗发送到 Agent；结束倾听并展开同一聊天浮窗。
                        // 保留 followup 取消，让下一次唤醒立即可用。
                        "asr_final" => {
                            wake_ball_active = false;
                            // 空转写不会提交、也不会有浮窗接管，球该回到偏好状态；
                            // 有文本则留着，等浮窗真正显示时由 show_voice_overlay_inner 收球——
                            // 先收球再显示，一旦显示没成，场上就什么都不剩了。
                            let submitted = event
                                .get("text")
                                .and_then(Value::as_str)
                                .is_some_and(|text| !text.trim().is_empty());
                            let callback_app = bridge_app.clone();
                            if let Err(error) = schedule_app.run_on_main_thread(move || {
                                if !callback_sessions.is_connection_current(connection_generation) {
                                    return;
                                }
                                set_ball_listening(&callback_app, false);
                                if !submitted {
                                    crate::voice_overlay::restore_ball_preference(&callback_app);
                                }
                            }) {
                                log::error!("voice_overlay.wake_schedule_failed error={error}");
                            }
                        }
                        // 语音收尾只恢复小球动画，保留入口及已展开的聊天浮窗。
                        "session_exit" | "session_cancelled" | "error" => {
                            if std::mem::take(&mut wake_ball_active) {
                                let callback_app = bridge_app.clone();
                                if let Err(error) = schedule_app.run_on_main_thread(move || {
                                    if !callback_sessions
                                        .is_connection_current(connection_generation)
                                    {
                                        return;
                                    }
                                    set_ball_listening(&callback_app, false);
                                    crate::voice_overlay::restore_ball_preference(&callback_app);
                                }) {
                                    log::error!("voice_overlay.wake_schedule_failed error={error}");
                                }
                            }
                        }
                        _ => {}
                    }
                    buffer.push(event.clone());
                    let _ = bridge_app.emit(VOICE_TOOL_EVENT, event);
                }
            },
        )
        .await;
    });
    *slot = Some(task);
}

struct VoiceConnectionLease {
    sessions: VoiceSessionState,
    generation: u64,
}

impl Drop for VoiceConnectionLease {
    fn drop(&mut self) {
        self.sessions.disconnect(self.generation);
    }
}

async fn run_bridge_reader(
    sessions: VoiceSessionState,
    bridge_generation: u64,
    resolve_path: impl Fn() -> Result<PathBuf, String>,
    mut on_event: impl FnMut(u64, Value),
) {
    while let Some(generation) = sessions.begin_connection(bridge_generation) {
        let connection = VoiceConnectionLease {
            sessions: sessions.clone(),
            generation,
        };
        let mut cancellations = tokio::task::JoinSet::new();
        let result = match resolve_path() {
            Ok(path) => {
                socket::read_events(&path, HEARTBEAT_INTERVAL, COMMAND_TIMEOUT, |event| {
                    if !sessions.observe(generation, &event) {
                        return;
                    }
                    if event.get("event").and_then(Value::as_str) == Some("asr_state")
                        && event.get("state").and_then(Value::as_str) == Some("started")
                        && event.get("reason").and_then(Value::as_str) == Some("followup")
                    {
                        if let Some(snapshot) = sessions.snapshot().filter(|snapshot| {
                            event.get("session_id").and_then(Value::as_u64)
                                == Some(snapshot.session_id)
                        }) {
                            cancellations = tokio::task::JoinSet::new();
                            let sessions = sessions.clone();
                            let path = path.clone();
                            let deadline = TokioInstant::now() + COMMAND_TIMEOUT;
                            cancellations.spawn(async move {
                                if let Err(error) =
                                    sessions.cancel_snapshot_at(snapshot, &path, deadline).await
                                {
                                    log::warn!("voice followup cancel failed: {error}");
                                }
                            });
                        }
                    }
                    on_event(generation, event);
                })
                .await
            }
            Err(error) => Err(error),
        };
        drop(cancellations);
        drop(connection);
        if let Err(error) = result {
            log::debug!("voice-tool reader disconnected: {error}");
        }
        sleep(Duration::from_secs(1)).await;
    }
}

pub fn stop_bridge<R: Runtime>(app: &AppHandle<R>) {
    if let Some(state) = app.try_state::<VoiceBridgeTask>() {
        if let Ok(mut slot) = state.0.lock() {
            if let Some(sessions) = app.try_state::<VoiceSessionState>() {
                sessions.reset_bridge();
            }
            if let Some(task) = slot.take() {
                task.abort();
            }
        }
    }
}

/// Debug-only synthetic event stream. Gated by `BIBIT_VOICE_SELFTEST=1`, it
/// shows the voice overlay and drives the frontend state machine through
/// wake -> listening -> recognizing -> asr_final without a microphone, so the
/// overlay UI can be visually verified on a headless/manual-less device.
pub fn start_voice_selftest<R: Runtime>(app: AppHandle<R>) {
    if std::env::var_os("BIBIT_VOICE_SELFTEST").as_deref() != Some(std::ffi::OsStr::new("1")) {
        return;
    }
    log::info!("voice overlay selftest enabled");
    let buffer = app.state::<VoiceEventBuffer>().inner().clone();
    let sessions = app.state::<VoiceSessionState>().inner().clone();
    let _task = tauri::async_runtime::spawn(async move {
        // Let every webview finish booting before we show the overlay.
        sleep(Duration::from_secs(12)).await;

        let show_app = app.clone();
        let overlay_app = show_app.clone();
        if let Err(error) = show_app.run_on_main_thread(move || {
            if let Err(error) = crate::voice_overlay::show_voice_overlay_inner(overlay_app, None) {
                log::error!("voice selftest show failed: {error}");
            }
        }) {
            log::error!("voice selftest schedule failed: {error}");
        }

        // Give the overlay webview a moment to mount its listener before the
        // first event; buffered events are also replayed on mount as fallback.
        sleep(Duration::from_secs(3)).await;

        let sequence = [
            json!({"event":"wake_triggered","session_id":9001}),
            json!({"event":"listening","session_id":9001}),
            json!({"event":"recognizing","session_id":9001,"text":"你好"}),
            json!({"event":"recognizing","session_id":9001,"text":"你好，我是语音自测"}),
            json!({"event":"asr_final","session_id":9001,"text":"你好，我是语音自测"}),
        ];
        for event in sequence {
            let generation = sessions
                .0
                .lock()
                .map(|state| state.connection_generation)
                .unwrap_or(0);
            sessions.observe(generation, &event);
            buffer.push(event.clone());
            let _ = app.emit(VOICE_TOOL_EVENT, event);
            sleep(Duration::from_secs(3)).await;
        }
    });
}

#[tauri::command]
pub fn voice_tool_replay_events<R: Runtime>(
    window: WebviewWindow<R>,
    state: State<'_, VoiceEventBuffer>,
) -> Result<Vec<Value>, String> {
    if window.label() != "voice-overlay" {
        return Err("只有语音输入弹窗能读取语音事件".to_owned());
    }
    Ok(state.replay_latest_wake(window.label()))
}

#[tauri::command]
pub async fn voice_tool_get_status() -> Result<Value, String> {
    send_command(b"{\"cmd\":\"get_status\"}\n", Reply::Status)
        .await?
        .ok_or_else(|| "语音状态响应为空".to_owned())
}

/// 把外部输入转义成 JSON 字符串内容。控制字符必须转义，否则换行会把一条命令拆成
/// 两行、破坏 audio.sock 的 JSONL 分帧。
fn escape_json_string(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '"' => escaped.push_str("\\\""),
            '\\' => escaped.push_str("\\\\"),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            c if (c as u32) < 0x20 => escaped.push_str(&format!("\\u{:04x}", c as u32)),
            c => escaped.push(c),
        }
    }
    escaped
}

#[tauri::command]
pub async fn voice_tool_set_switches(
    wake: Option<bool>,
    asr: Option<bool>,
    request_id: Option<String>,
) -> Result<(), String> {
    // 字段级意图：只把调用方给出的字段发给语音服务，未给出的字段由服务端沿用
    // 当前生效值。用本地快照拼装全量请求会把另一个开关带回旧值。
    if wake.is_none() && asr.is_none() {
        return Err("至少需要给出 wake 或 asr 之一".to_owned());
    }
    let mut payload = String::from("{\"cmd\":\"set_switches\"");
    if let Some(wake) = wake {
        payload.push_str(&format!(",\"wake\":{wake}"));
    }
    if let Some(asr) = asr {
        payload.push_str(&format!(",\"asr\":{asr}"));
    }
    if let Some(request_id) = request_id.filter(|value| !value.is_empty()) {
        payload.push_str(&format!(
            ",\"request_id\":\"{}\"",
            escape_json_string(&request_id)
        ));
    }
    payload.push_str("}\n");
    send_command(payload.as_bytes(), Reply::Sent)
        .await
        .map(|_| ())
}

#[tauri::command]
pub async fn voice_tool_set_asr_model(model: String) -> Result<(), String> {
    if !matches!(model.as_str(), "sensevoice" | "qwen3_asr_0.6b") {
        return Err("未知的 ASR 模型".to_owned());
    }
    let payload = format!("{{\"cmd\":\"set_asr_model\",\"model\":\"{model}\"}}\n");
    send_command(payload.as_bytes(), Reply::Sent)
        .await
        .map(|_| ())
}

#[tauri::command]
pub async fn voice_tool_start_manual_asr<R: Runtime>(
    window: WebviewWindow<R>,
) -> Result<(), String> {
    if !matches!(window.label(), "voice-ball" | "voice-overlay") {
        return Err("该窗口不能启动语音识别".to_owned());
    }
    start_manual_asr().await
}

/// 原生入口（全局快捷键）启动一次手动录音，不经过 webview。
pub async fn start_manual_asr() -> Result<(), String> {
    send_command(b"{\"cmd\":\"start_manual_asr\"}\n", Reply::Sent)
        .await
        .map(|_| ())
}

#[tauri::command]
pub async fn voice_tool_cancel_current<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
) -> Result<(), String> {
    if window.label() != "voice-overlay" {
        return Err("该窗口不能取消语音识别".to_owned());
    }
    cancel_current(&app).await
}

#[tauri::command]
pub async fn voice_tool_cancel<R: Runtime>(
    window: WebviewWindow<R>,
    session_id: u64,
    state: State<'_, VoiceSessionState>,
) -> Result<(), String> {
    if window.label() != "voice-overlay" {
        return Err("该窗口不能取消语音识别".to_owned());
    }
    state.cancel_session(session_id).await
}

#[cfg(test)]
mod socket_tests;

#[cfg(test)]
mod tests {
    use super::{
        cancel_command, escape_json_string, socket_dirs_for, VoiceEventBuffer, VoiceSessionState,
    };
    use serde_json::json;

    #[test]
    fn escape_json_string_keeps_frames_intact() {
        assert_eq!(escape_json_string("plain"), "plain");
        assert_eq!(escape_json_string("a\"b"), "a\\\"b");
        assert_eq!(escape_json_string("a\\b"), "a\\\\b");
        assert_eq!(escape_json_string("a\nb"), "a\\nb");
        assert_eq!(escape_json_string("a\u{1}b"), "a\\u0001b");
        // 转义结果必须能被 JSON 解析回原值，否则分帧与回执都会错。
        let raw = "line\nbreak\"quote\"\\tail\u{2}";
        let decoded: String =
            serde_json::from_str(&format!("\"{}\"", escape_json_string(raw))).unwrap();
        assert_eq!(decoded, raw);
    }

    #[test]
    fn socket_dirs_prefer_session_path_then_legacy_fallback() {
        assert_eq!(
            socket_dirs_for(Some(std::ffi::OsStr::new("/run/user/4242"))),
            vec![
                std::path::PathBuf::from("/run/user/4242/bibit"),
                std::path::PathBuf::from("/run/bibit"),
            ]
        );
        assert_eq!(
            socket_dirs_for(None),
            vec![std::path::PathBuf::from("/run/bibit")]
        );
        assert_eq!(
            socket_dirs_for(Some(std::ffi::OsStr::new(""))),
            socket_dirs_for(None)
        );
    }

    #[test]
    fn cancel_command_keeps_numeric_session_id_and_jsonl_terminator() {
        assert_eq!(cancel_command(7), "{\"cmd\":\"cancel\",\"session_id\":7}\n");
    }

    #[test]
    fn replay_returns_only_the_latest_wake_sequence_once_per_consumer() {
        let buffer = VoiceEventBuffer::default();
        buffer.push(json!({"event":"wake_triggered","session_id":1}));
        buffer.push(json!({"event":"asr_final","session_id":1,"text":"旧"}));
        buffer.push(json!({"event":"wake_triggered","session_id":2}));
        buffer.push(json!({"event":"asr_final","session_id":2,"text":"新"}));

        assert_eq!(
            buffer.replay_latest_wake("voice-overlay"),
            vec![
                json!({"event":"wake_triggered","session_id":2}),
                json!({"event":"asr_final","session_id":2,"text":"新"}),
            ]
        );
        assert!(buffer.replay_latest_wake("voice-overlay").is_empty());
    }

    #[test]
    fn manual_start_is_replayed_and_tracks_the_cancellable_session() {
        let buffer = VoiceEventBuffer::default();
        let state = VoiceSessionState::default();
        let manual =
            json!({"event":"asr_state","state":"started","reason":"manual","session_id":4});
        for event in [
            json!({"event":"wake_triggered","session_id":3}),
            json!({"event":"listening","session_id":4}),
            manual.clone(),
        ] {
            buffer.push(event.clone());
            state.observe(0, &event);
        }
        assert_eq!(state.snapshot().unwrap().session_id, 4);
        assert_eq!(buffer.replay_latest_wake("voice-overlay"), vec![manual]);
        assert!(buffer.replay_latest_wake("voice-overlay").is_empty());

        state.observe(
            0,
            &json!({"event":"asr_state","state":"started","reason":"followup","session_id":5}),
        );
        state.observe(0, &json!({"event":"session_cancelled","session_id":3}));
        assert_eq!(state.snapshot().unwrap().session_id, 5);
        state.observe(0, &json!({"event":"session_cancelled","session_id":4}));
        state.observe(0, &json!({"event":"session_exit"}));
        assert_eq!(state.snapshot().unwrap().session_id, 5);
        state.observe(0, &json!({"event":"session_cancelled","session_id":5}));
        assert_eq!(state.snapshot(), None);
    }

    #[test]
    fn replay_cursors_are_independent_for_multiple_consumers() {
        let buffer = VoiceEventBuffer::default();
        buffer.push(json!({"event":"wake_triggered","session_id":3}));
        buffer.push(json!({"event":"asr_final","session_id":3,"text":"保留"}));

        assert_eq!(buffer.replay_latest_wake("first").len(), 2);
        assert_eq!(buffer.replay_latest_wake("first").len(), 0);
        assert_eq!(buffer.replay_latest_wake("second").len(), 2);
    }
}
