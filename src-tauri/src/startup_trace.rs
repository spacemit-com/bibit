//! 主窗口启动耗时的按阶段证据（默认关闭，`BIBIT_STARTUP_TRACE=1` 打开）。
//!
//! 首屏等待由几段拼成：进程启动 → 事件循环起（此前 IPC 一律不响应）→ WebKit 加载
//! dist → 前端 boot 链 → 扩展注册完成。只从一端看不出来时间花在哪一段，所以这里
//! 只做一件事：把每个边界的**绝对 epoch 毫秒**追加到 `<data>/logs/startup-trace.log`。
//! 前端那条 `[startup]` 汇总行带 `timeOrigin`，与这里同一口钟，可直接相减。

use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Listener, Manager, Runtime};

static ENABLED: OnceLock<bool> = OnceLock::new();
static TRACE_FILE: OnceLock<PathBuf> = OnceLock::new();
static PROCESS_START: OnceLock<(Instant, u128)> = OnceLock::new();
static WRITE_LOCK: Mutex<()> = Mutex::new(());
static PENDING: Mutex<Vec<String>> = Mutex::new(Vec::new());

pub fn enabled() -> bool {
    *ENABLED.get_or_init(|| {
        std::env::var("BIBIT_STARTUP_TRACE")
            .map(|value| value == "1")
            .unwrap_or(false)
    })
}

fn epoch_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or(0)
}

/// 进程起点：必须在 main 的第一行调用，否则 t_ms 会从更晚的地方起算。
pub fn start() {
    if !enabled() {
        return;
    }
    let _ = PROCESS_START.set((Instant::now(), epoch_ms()));
    mark("main_enter");
}

/// 记一个阶段边界。t_ms 从进程启动起算，epoch_ms 是绝对时间（与前端 timeOrigin 同钟）。
pub fn mark(name: &str) {
    if !enabled() {
        return;
    }
    let (started, start_epoch) = *PROCESS_START.get_or_init(|| (Instant::now(), epoch_ms()));
    let t_ms = started.elapsed().as_millis() as u128;
    let line = format!("t_ms={t_ms} epoch_ms={} event={name}", start_epoch + t_ms);
    log::info!("startup_trace {line}");

    let _guard = WRITE_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    match TRACE_FILE.get() {
        Some(path) => append(path, &line),
        // 文件位置要等 AppHandle（data 目录），在那之前的几笔先攒着。
        None => PENDING
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .push(line),
    }
}

fn append(path: &PathBuf, line: &str) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = writeln!(file, "{line}");
    }
}

/// 绑定落盘位置、补写开头的几笔，并挂上「前端首帧就绪」的观测点。
/// 在 setup 闭包早期调用一次。
pub fn init<R: Runtime>(app: &AppHandle<R>) {
    if !enabled() {
        return;
    }
    let path = crate::core::app::commands::get_jan_data_folder_path(app.clone())
        .join("logs")
        .join("startup-trace.log");
    let _ = TRACE_FILE.set(path.clone());
    append(&path, &format!("trace_init pid={}", std::process::id()));
    {
        let mut pending = PENDING.lock().unwrap_or_else(|error| error.into_inner());
        let buffered = std::mem::take(&mut *pending);
        for line in buffered {
            append(&path, &line);
        }
    }
    // 前端 ExtensionProvider 在首帧可交互时 emit，这是「窗口可见可用」的最后一个边界。
    app.listen_any("app-ready", |_| mark("app_ready"));

    match app.get_webview_window("main") {
        Some(window) => {
            let visible = window.is_visible().unwrap_or(false);
            mark(&format!("main_window_present visible={visible}"));
        }
        None => mark("main_window_missing"),
    }
}
