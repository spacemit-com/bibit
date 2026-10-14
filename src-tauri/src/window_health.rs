//! 主窗口渲染健康的证据记录与自愈。
//!
//! 主窗口是 `transparent: true` 的无装饰窗口：它自身不产生任何像素，可见性全部
//! 依赖 WebKit 的合成输出，而 GTK 窗口的输入区域默认覆盖整个 surface。两者相乘，
//! 后果是任何一次渲染失败都会退化成「完全透明但仍然吃点击」的空壳：没有崩溃、
//! 没有报错窗口，肉眼和常规日志都看不出原因。
//!
//! 所以这里只做两件必要的事，且不改变任何视觉行为：
//!
//! 1. 把失败现场记成**跨重启保留**的证据。`app.log` 每次启动都会重建，现场会跟着
//!    丢，排查只能靠 `render-health.log`。
//! 2. 在已经确证的失败形态上自愈：web 进程终止后 WebKit 不会自己把它拉起来，窗口
//!    会永久停留在终止前的那一帧——看起来正常，其实 UI 已经是死的。实测在本板
//!    `kill -9` 掉主窗口的全部 `WebKitWebProcess` 之后，窗口仍显示旧内容且不再恢复。

use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};

use tauri::{AppHandle, Manager, Runtime};
use webkit2gtk::WebViewExt;

/// 自愈重载上限：web 进程反复崩溃时不要把它刷成无限重载循环。
const MAX_AUTO_RELOADS: u32 = 3;

static AUTO_RELOADS: AtomicU32 = AtomicU32::new(0);

const STARTUP_ENV_KEYS: [&str; 8] = [
    "GDK_GL",
    "GSK_RENDERER",
    "GSK_GPU_DISABLE",
    "XDG_SESSION_TYPE",
    "WAYLAND_DISPLAY",
    "BIBIT_RUNTIME_PROFILE",
    "WEBKIT_DISABLE_DMABUF_RENDERER",
    "WEBKIT_DISABLE_COMPOSITING_MODE",
];

fn evidence_path<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
    crate::core::app::commands::get_jan_data_folder_path(app.clone())
        .join("logs")
        .join("render-health.log")
}

/// 追加一条证据：常规日志留一份，再往跨重启保留的文件追加一份。
pub fn record<R: Runtime>(app: &AppHandle<R>, line: &str) {
    log::info!("render_health {line}");
    let path = evidence_path(app);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    else {
        return;
    };
    let stamp = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S%.3f%:z");
    let _ = writeln!(file, "[{stamp}] pid={} {line}", std::process::id());
}

/// 启动快照：把「这次是哪套 GL 栈、哪个会话、窗口初始什么状态」钉进证据里。
pub fn record_startup_snapshot<R: Runtime>(app: &AppHandle<R>) {
    let envs: Vec<String> = STARTUP_ENV_KEYS
        .iter()
        .map(|key| {
            format!(
                "{key}={}",
                std::env::var(key).unwrap_or_else(|_| "<unset>".to_owned())
            )
        })
        .collect();
    let background = std::env::args_os().any(|arg| arg == "--background");
    record(
        app,
        &format!("event=startup background={background} {}", envs.join(" ")),
    );
    record(
        app,
        &format!("event=startup gl_drivers={}", loaded_gl_drivers()),
    );
    if let Some(window) = app.get_webview_window("main") {
        let visible = window.is_visible().unwrap_or(false);
        let (width, height) = window
            .inner_size()
            .map(|size| (size.width, size.height))
            .unwrap_or((0, 0));
        record(
            app,
            &format!("event=startup main_window visible={visible} size={width}x{height}"),
        );
    }
}

/// 本进程实际加载了哪套 GL 驱动——PVR 还是软件回退，是失败现场最关键的一条线索。
fn loaded_gl_drivers() -> String {
    let Ok(maps) = std::fs::read_to_string("/proc/self/maps") else {
        return "<unavailable>".to_owned();
    };
    let mut found: Vec<&str> = maps
        .lines()
        .filter_map(|line| line.split_whitespace().nth(5))
        .filter_map(|path| path.rsplit('/').next())
        .filter(|name| {
            name.starts_with("libEGL")
                || name.starts_with("libGLES")
                || name.starts_with("libGL.")
                || name.contains("pvr")
                || name.contains("llvmpipe")
                || name.starts_with("swrast")
        })
        .collect();
    found.sort_unstable();
    found.dedup();
    if found.is_empty() {
        "<none>".to_owned()
    } else {
        found.join(",")
    }
}

/// web 进程终止时主动重载，把死掉的 UI 拉回来。
pub fn watch_main_render_process<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let handle = app.clone();
    let result = window.with_webview(move |webview| {
        webview
            .inner()
            .connect_web_process_terminated(move |view, reason| {
                record(
                    &handle,
                    &format!("event=web_process_terminated reason={reason:?}"),
                );
                let attempt = AUTO_RELOADS.fetch_add(1, Ordering::SeqCst) + 1;
                if attempt > MAX_AUTO_RELOADS {
                    record(
                        &handle,
                        "action=auto_reload_skipped reason=budget_exhausted",
                    );
                    return;
                }
                record(&handle, &format!("action=auto_reload attempt={attempt}"));
                view.reload();
            });
    });
    if let Err(error) = result {
        record(app, &format!("action=watch_setup_failed error={error}"));
    }
}

/// 唤起主窗口之后补一次强制重绘。
///
/// 目标形态是「窗口在未映射状态下创建、之后才 show，WebKit 不再产出新帧」——这正是
/// 自启 `--background` 之后从桌面图标唤起的路径。`queue_resize` / `queue_draw` 都不改变
/// 实际尺寸，不会闪。这是防御性动作：触发点尚未定位，它不保证命中。
pub fn nudge_repaint<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let handle = app.clone();
    let result = window.with_webview(move |webview| {
        use gtk::prelude::*;
        let view = webview.inner();
        view.queue_resize();
        view.queue_draw();
        record(&handle, "action=repaint_nudge");
    });
    if let Err(error) = result {
        record(app, &format!("action=repaint_nudge_failed error={error}"));
    }
}
