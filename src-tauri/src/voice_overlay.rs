use std::sync::{Mutex, OnceLock};
use tauri::{
    AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

static WINDOW_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// 悬浮球窗口尺寸：全屏透明 overlay，球本身用 CSS transform 在窗口内定位。
/// 窗口静止 → 前端 clientX 参考系稳定 → 无反馈回路。input region 限定圆形区域。

#[tauri::command]
pub fn voice_overlay_generation() -> u64 {
    WINDOW_GENERATION.load(std::sync::atomic::Ordering::SeqCst)
}

const VOICE_BALL_LABEL: &str = "voice-ball";
const VOICE_OVERLAY_LABEL: &str = "voice-overlay";

/// 悬浮球 / 浮窗的页面在 index.html 里画了主窗口的启动页。这两个窗口建好后
/// 长时间不映射，webview 的首帧会被合成器留住，首次打开必然先亮出那张启动页
/// （SpacemiT K3 实测约 0.43s 的整屏白 + logo）。启动页在 HTML 解析阶段就存在于
/// DOM 里，靠页面内联脚本按 `__TAURI_INTERNALS__.metadata` 判断来不及——注入
/// 时机由 webview 决定，早于页面脚本。这里用 document-start 初始化脚本把
/// class 打在 <html> 上，启动页在第一次绘制前就是 display:none。
const VOICE_SURFACE_INIT_SCRIPT: &str = r#"
(function () {
  var apply = function () {
    var root = document.documentElement;
    if (root) root.classList.add('bibit-voice-surface');
  };
  apply();
  if (!document.documentElement) {
    document.addEventListener('readystatechange', apply, { once: true });
  }
})();
"#;
pub(crate) const VOICE_BALL_SIZE: i32 = 96;
/// 浮窗可视尺寸：Linux 下浮窗窗口也是整屏透明 surface，位置交给内容框的 CSS 坐标。
pub(crate) const VOICE_OVERLAY_WIDTH: i32 = 460;
pub(crate) const VOICE_OVERLAY_HEIGHT: i32 = 620;
static WINDOW_CONTROL_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

/// 输出几何（分辨率 / 显示器）变化后，已建好的悬浮球窗口不会再跟着新尺寸走：
/// 球画在可视区外、input region 也停在旧位置，隐藏再显示都救不回来（SpacemiT K3 实测 1920x1080→1280x720）。
/// 因此几何一变就按新尺寸重建窗口——等价于重启一次，而那正是实测可用的路径。
#[cfg(target_os = "linux")]
static BALL_OUTPUT_WATCH_STARTED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
/// 一次几何变化会连发多个 GdkScreen 信号：用 epoch 去抖，只让最后一次落地。
#[cfg(target_os = "linux")]
static BALL_OUTPUT_EPOCH: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);

fn window_control_lock() -> &'static Mutex<()> {
    WINDOW_CONTROL_LOCK.get_or_init(|| Mutex::new(()))
}

/// show 之后这段时间内的失焦一律忽略：Wayland 上 map/set_focus 期间
/// 可能先来一次 Focused(false)，照它隐藏会让浮窗刚弹出就消失。
const FOCUS_GRACE_MS: u64 = 400;
/// 最近一次浮窗 show 的时刻（进程启动起算的毫秒；0 = 还没显示过）。
static OVERLAY_SHOWN_AT_MS: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);

fn process_uptime_ms() -> u64 {
    static START: OnceLock<std::time::Instant> = OnceLock::new();
  START.get_or_init(std::time::Instant::now).elapsed().as_millis() as u64
}

/// 失焦是否落在 show 之后的宽限期内。
fn within_focus_grace(now_ms: u64) -> bool {
    let shown_at = OVERLAY_SHOWN_AT_MS.load(std::sync::atomic::Ordering::SeqCst);
    shown_at != 0 && now_ms.saturating_sub(shown_at) <= FOCUS_GRACE_MS
}

/// 浮窗的「意图可见性」：本应用自己的真源。
/// tao 在 Linux 上把 show/hide 投递进 GLib 队列，`is_visible()` 读到的还是上一轮的值，
/// 所以「浮窗现在开着吗」只能读这里，不能读窗口。
static OVERLAY_INTENT_VISIBLE: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

fn create_ball<R: Runtime>(app: &AppHandle<R>, visible: bool) -> Result<(), String> {
    if app.get_webview_window(VOICE_BALL_LABEL).is_some() {
        return Ok(());
    }

    // 全屏透明窗口：球用 CSS transform 在窗口内定位，窗口本身不移动。
    // 优势：clientX 参考系稳定，无反馈回路；性能开销 <2%（实测 SpacemiT K3）。
    let builder = WebviewWindowBuilder::new(
        app,
        VOICE_BALL_LABEL,
        WebviewUrl::App("status-popup".into()),
    )
    .title("BiBit Voice")
    .theme(crate::core::setup::current_window_theme())
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .visible(false)
    .devtools(false)
    .initialization_script(VOICE_SURFACE_INIT_SCRIPT);

    #[cfg(target_os = "linux")]
    let window = builder.build().map_err(|e| e.to_string())?;
    #[cfg(target_os = "linux")]
    if let Err(error) = position_ball(app, &window, true) {
        log::warn!("voice_ball.position_failed error={error}");
    }
    // 窗口还没 show，首次分配尺寸拿不到；等 GTK 完成布局后按真实尺寸再刷一次 input region。
    #[cfg(target_os = "linux")]
    if let Ok(gtk_window) = window.gtk_window() {
        use gtk::prelude::*;
        let app_for_signal = app.clone();
        gtk_window.connect_size_allocate(move |window, allocation| {
            log::debug!(
                "voice_ball.size_allocate w={} h={}",
                allocation.width(),
                allocation.height()
            );
            if let Err(error) = refresh_ball_input_region(&app_for_signal, window) {
                log::warn!("voice_ball.input_region_failed error={error}");
            }
        });
    }
    #[cfg(target_os = "linux")]
    watch_ball_output_geometry(app);

    #[cfg(not(target_os = "linux"))]
    let window = builder
        .inner_size(VOICE_BALL_SIZE as f64, VOICE_BALL_SIZE as f64)
        .min_inner_size(VOICE_BALL_SIZE as f64, VOICE_BALL_SIZE as f64)
        .max_inner_size(VOICE_BALL_SIZE as f64, VOICE_BALL_SIZE as f64)
        .build()
        .map_err(|e| e.to_string())
        .map(|window| {
            if let Ok(Some(monitor)) = window.primary_monitor() {
                let area = monitor.work_area();
                let scale = monitor.scale_factor();
                let preference = app
                    .state::<crate::desktop_integration::DesktopIntegrationState>()
                    .voice_ball();
                let x = area.position.x as f64 / scale + area.size.width as f64 / scale
                    - VOICE_BALL_SIZE as f64
                    - preference.right_margin as f64;
                let y = area.position.y as f64 / scale + area.size.height as f64 / scale
                    - VOICE_BALL_SIZE as f64
                    - preference.bottom_margin as f64;
                let _ = window.set_position(tauri::LogicalPosition::new(
                    x.max(area.position.x as f64 / scale),
                    y.max(area.position.y as f64 / scale),
                ));
            }
            window
        })?;

    if visible {
        if let Err(error) = window.show() {
            log::warn!("voice_ball.show_failed error={error}");
        }
    }

    let ball = window.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = ball.hide();
        }
    });

    Ok(())
}

/// 监听输出几何变化：分辨率或显示器一变，悬浮球窗口就按新几何重建。
#[cfg(target_os = "linux")]
fn watch_ball_output_geometry<R: Runtime>(app: &AppHandle<R>) {
    use gtk::prelude::*;
    if BALL_OUTPUT_WATCH_STARTED.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    let screen = app
        .get_webview_window(VOICE_BALL_LABEL)
        .and_then(|window| window.gtk_window().ok())
        .and_then(|window| gtk::prelude::WidgetExt::screen(&window))
        .or_else(gtk::gdk::Screen::default);
    let Some(screen) = screen else {
        BALL_OUTPUT_WATCH_STARTED.store(false, std::sync::atomic::Ordering::SeqCst);
        log::warn!("voice_ball.output_watch_unavailable reason=no_screen");
        return;
    };
    let size_app = app.clone();
    screen.connect_size_changed(move |_| schedule_ball_rebuild(&size_app));
    let monitors_app = app.clone();
    screen.connect_monitors_changed(move |_| schedule_ball_rebuild(&monitors_app));
}

/// 几何变化的去抖：一次改分辨率会连发多个信号，只让最后一条在 400ms 后落地。
#[cfg(target_os = "linux")]
fn schedule_ball_rebuild<R: Runtime>(app: &AppHandle<R>) {
    let epoch = BALL_OUTPUT_EPOCH.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
    let callback_app = app.clone();
    gtk::glib::timeout_add_once(std::time::Duration::from_millis(400), move || {
        if BALL_OUTPUT_EPOCH.load(std::sync::atomic::Ordering::SeqCst) != epoch {
            return;
        }
        if let Err(error) = rebuild_ball(&callback_app) {
            log::warn!("voice_ball.rebuild_failed error={error}");
        }
    });
}

/// 按当前几何重建悬浮球窗口：destroy() 不派发 CloseRequested，
/// 所以不会撞上"关闭即隐藏"的拦截；创建隔一个主循环回合做，避开销毁过程的中间态。
#[cfg(target_os = "linux")]
fn rebuild_ball<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let visible = app
        .state::<crate::desktop_integration::DesktopIntegrationState>()
        .voice_ball()
        .visible
        && !OVERLAY_INTENT_VISIBLE.load(std::sync::atomic::Ordering::SeqCst);
    let Some(window) = app.get_webview_window(VOICE_BALL_LABEL) else {
        // 球本来就没建（用户隐藏了，或还没到创建时机）：没有旧窗口要换。
        return Ok(());
    };
    window.destroy().map_err(|error| error.to_string())?;
    log::info!("voice_ball.rebuilt reason=output_geometry_changed visible={visible}");
    let callback_app = app.clone();
    gtk::glib::timeout_add_once(std::time::Duration::from_millis(200), move || {
        if let Err(error) = create_ball(&callback_app, visible) {
            log::warn!("voice_ball.recreate_failed error={error}");
        }
    });
    Ok(())
}

fn prepare_ball_inner<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    create_ball(
        app,
        app.state::<crate::desktop_integration::DesktopIntegrationState>()
            .voice_ball()
            .visible,
    )
}

pub fn prepare_ball<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let _guard = window_control_lock()
        .lock()
        .map_err(|_| "语音窗口控制器不可用".to_owned())?;
    prepare_ball_inner(app)
}

fn prepare_overlay_inner<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    if app.get_webview_window(VOICE_OVERLAY_LABEL).is_some() {
        return Ok(());
    }
    let builder = WebviewWindowBuilder::new(
        app,
        VOICE_OVERLAY_LABEL,
        WebviewUrl::App("status-popup".into()),
    )
    .title(crate::core::native_text::current().voice_overlay_title)
    .theme(crate::core::setup::current_window_theme())
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .visible(false)
    .devtools(false)
    .initialization_script(VOICE_SURFACE_INIT_SCRIPT);

    // 只有非 Linux 还保留固定尺寸窗口（位置靠 set_position）；Linux 走整屏透明 surface。
    #[cfg(not(target_os = "linux"))]
    let builder = builder
        .inner_size(VOICE_OVERLAY_WIDTH as f64, VOICE_OVERLAY_HEIGHT as f64)
        .min_inner_size(360.0, 480.0);

    let window = builder.build().map_err(|error| error.to_string())?;

    // 点到浮窗外面就让位：只隐藏窗口，语音会话继续跑，状态由悬浮球表达。
    let event_app = app.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::Focused(false) = event {
            let now = process_uptime_ms();
            if within_focus_grace(now) {
                log::debug!("voice_overlay.focus_loss_suppressed reason=grace");
                return;
            }
            let hide_app = event_app.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = hide_overlay(hide_app, HideReason::FocusLoss).await {
                    log::warn!("voice_overlay.focus_loss_hide_failed error={error}");
                }
            });
        }
    });

    #[cfg(target_os = "linux")]
    {
        if let Err(error) = position_overlay_surface(app, &window, true) {
            log::warn!("voice_overlay.position_failed error={error}");
        }
        // 窗口还没 show，首次分配尺寸拿不到；等 GTK 完成布局后按真实尺寸再刷一次 input region。
        if let Ok(gtk_window) = window.gtk_window() {
            use gtk::prelude::*;
            let app_for_signal = app.clone();
            let signal_window = window.clone();
            gtk_window.connect_size_allocate(move |window, allocation| {
                log::debug!(
                    "voice_overlay.size_allocate w={} h={}",
                    allocation.width(),
                    allocation.height()
                );
                if let Err(error) =
                    refresh_overlay_input_region(&app_for_signal, &signal_window, window)
                {
                    log::warn!("voice_overlay.input_region_failed error={error}");
                }
            });
        }
    }

    Ok(())
}

/// 可用区坐标下球左上角：球的边距是从可用区右下角量的。
fn ball_origin(usable: (i32, i32), right_margin: i32, bottom_margin: i32) -> (i32, i32) {
    (
        usable.0 - right_margin - VOICE_BALL_SIZE,
        usable.1 - bottom_margin - VOICE_BALL_SIZE,
    )
}

/// 浮窗被拖走后球的新左上角：跟浮窗走同一段位移，但不许越出可用区。
fn followed_ball_origin(usable: (i32, i32), ball: (i32, i32), moved: (i32, i32)) -> (i32, i32) {
    (
        (ball.0 + moved.0).clamp(0, (usable.0 - VOICE_BALL_SIZE).max(0)),
        (ball.1 + moved.1).clamp(0, (usable.1 - VOICE_BALL_SIZE).max(0)),
    )
}

/// 浮窗内容框左上角 = 球左上角 + 落盘偏移，再夹进可用区。
fn overlay_origin(usable: (i32, i32), ball: (i32, i32), offset: (i32, i32)) -> (i32, i32) {
    let max_x = (usable.0 - VOICE_OVERLAY_WIDTH).max(0);
    let max_y = (usable.1 - VOICE_OVERLAY_HEIGHT).max(0);
    (
        (ball.0 + offset.0).clamp(0, max_x),
        (ball.1 + offset.1).clamp(0, max_y),
    )
}

/// 四边锚定 layer surface 的实际分配尺寸；没分配完之前拿不到。
/// 四边锚定的 layer surface 一定铺满整屏（只让出面板那一条），够得着才认它排好版了。
/// `window.size()` 在首次分配完成前给的是 GTK 的默认请求尺寸（Tauri 的 800×600），
/// 拿它当可用区，球会被算到 (569,462)、浮窗被夹到屏幕左上角（SpacemiT K3 实测首开落在 (205,0)）。
/// 门槛取半屏：拦得住默认值，拦不住真值——面板最多几十像素。
#[cfg(target_os = "linux")]
fn covers_screen(size: (i32, i32), screen: (i32, i32)) -> bool {
    size.0 * 2 >= screen.0 && size.1 * 2 >= screen.1
}

/// 四边锚定 layer surface 的实际尺寸；还没排好版返回 None，调用方自己决定退到哪。
/// Wayland 下 GDK 的 workarea 是整块屏幕（不含面板信息），而 layer surface 拿到的是
/// 去掉面板的可用区，两者差一个面板高度，所以能拿到就优先用它。
#[cfg(target_os = "linux")]
fn laid_out_surface_size(
    window: &gtk::ApplicationWindow,
    monitor: &gtk::gdk::Monitor,
) -> Option<(i32, i32)> {
    use gtk::prelude::*;
    let size = window.size();
    let area = monitor.workarea();
    covers_screen(size, (area.width(), area.height())).then_some(size)
}

/// 可用区：原点 + 尺寸。Wayland 下四边锚定 layer surface 的坐标原点就是可用区左上角，
/// 尺寸优先取已分配好的浮窗／球 surface，都没有才退回 GDK workarea（那会差一个面板高度）。
#[cfg(target_os = "linux")]
fn usable_area<R: Runtime>(
    app: &AppHandle<R>,
    display: &gtk::gdk::Display,
) -> Result<(i32, i32, i32, i32), String> {
    use gtk::prelude::*;
    let index = app
        .state::<crate::desktop_integration::DesktopIntegrationState>()
        .voice_ball()
        .screen_index as i32;
    let monitor = display
        .monitor(index)
        .or_else(|| display.primary_monitor())
        .or_else(|| display.monitor(0))
        .ok_or("没有可用屏幕")?;
    if display.type_().name() != "GdkWaylandDisplay" {
        // X11 兜底：整屏透明窗口铺在 workarea 上，坐标原点跟着 workarea 走。
        let area = monitor.workarea();
        return Ok((area.x(), area.y(), area.width(), area.height()));
    }
    let (width, height) = [VOICE_OVERLAY_LABEL, VOICE_BALL_LABEL]
        .iter()
        .filter_map(|label| app.get_webview_window(label))
        .filter_map(|window| window.gtk_window().ok())
        .find_map(|gtk_window| laid_out_surface_size(&gtk_window, &monitor))
        .unwrap_or_else(|| {
            let area = monitor.workarea();
            (area.width(), area.height())
        });
    Ok((0, 0, width, height))
}

#[cfg(not(target_os = "linux"))]
fn usable_area<R: Runtime>(
    _app: &AppHandle<R>,
    window: &WebviewWindow<R>,
) -> Result<(i32, i32, i32, i32), String> {
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten())
        .ok_or("没有可用屏幕")?;
    let area = monitor.work_area();
    Ok((
        area.position.x,
        area.position.y,
        area.size.width as i32,
        area.size.height as i32,
    ))
}

/// 浮窗内容框在 surface 里的落点：球位置 + 落盘偏移。
fn overlay_box_origin<R: Runtime>(
    app: &AppHandle<R>,
    window: &WebviewWindow<R>,
) -> Result<(i32, i32), String> {
    #[cfg(target_os = "linux")]
    let usable = {
        use gtk::prelude::*;
        let display = window
            .gtk_window()
            .map_err(|error| error.to_string())?
            .display();
        let (_, _, width, height) = usable_area(app, &display)?;
        (width, height)
    };
    #[cfg(not(target_os = "linux"))]
    let usable = {
        let (_, _, width, height) = usable_area(app, window)?;
        (width, height)
    };
    let state = app.state::<crate::desktop_integration::DesktopIntegrationState>();
    let ball = state.voice_ball();
    let offset = state.voice_overlay();
    let ball_at = ball_origin(usable, ball.right_margin, ball.bottom_margin);
    let origin = overlay_origin(usable, ball_at, (offset.offset_x, offset.offset_y));
    Ok(origin)
}

/// 浮窗可点区域 = 内容框那一块矩形，整屏其余地方点击穿透。
#[cfg(target_os = "linux")]
fn set_overlay_input_region(
    gtk_window: &gtk::ApplicationWindow,
    screen_w: i32,
    screen_h: i32,
    x: i32,
    y: i32,
) {
    use gtk::prelude::*;
    let Some(gdk_window) = gtk_window.window() else { return };
    use gtk::cairo;
    let region = cairo::Region::create();
    let x0 = x.clamp(0, screen_w.max(1));
    let y0 = y.clamp(0, screen_h.max(1));
    let width = VOICE_OVERLAY_WIDTH.min((screen_w - x0).max(0));
    let height = VOICE_OVERLAY_HEIGHT.min((screen_h - y0).max(0));
    if width > 0 && height > 0 {
        let _ = region.union_rectangle(&cairo::RectangleInt::new(x0, y0, width, height));
    }
    gdk_window.input_shape_combine_region(&region, 0, 0);
}

#[cfg(target_os = "linux")]
fn refresh_overlay_input_region<R: Runtime>(
    app: &AppHandle<R>,
    window: &WebviewWindow<R>,
    gtk_window: &gtk::ApplicationWindow,
) -> Result<(), String> {
    use gtk::prelude::*;
    let display = gtk_window.display();
    // Wayland 与 X11 都要设：整屏透明 surface 不设 input region 就会把整个桌面吞掉。
    let (x, y) = overlay_box_origin(app, window)?;
    let (_, _, screen_w, screen_h) = usable_area(app, &display)?;
    set_overlay_input_region(gtk_window, screen_w, screen_h, x, y);
    Ok(())
}

/// Linux 上的浮窗 surface：整屏透明、窗口本身永不动，可点区域跟着内容框走。
#[cfg(target_os = "linux")]
fn position_overlay_surface<R: Runtime>(
    app: &AppHandle<R>,
    window: &WebviewWindow<R>,
    initialize: bool,
) -> Result<(), String> {
    use gtk::prelude::*;
    let gtk_window = window.gtk_window().map_err(|error| error.to_string())?;
    let display = gtk_window.display();
    if display.type_().name() == "GdkWaylandDisplay" {
        let layer = ball_layer()?;
        if initialize {
            layer.initialize(&gtk_window)?;
        }
        let index = app
            .state::<crate::desktop_integration::DesktopIntegrationState>()
            .voice_ball()
            .screen_index as i32;
        let monitor = display
            .monitor(index)
            .or_else(|| display.primary_monitor())
            .or_else(|| display.monitor(0))
            .ok_or("没有可用屏幕")?;
        layer.set_monitor(&gtk_window, &monitor)?;
        // 全屏锚定：四边 anchor、0 margin，和悬浮球同一套。
        use crate::status_popup::linux::layer_shell::{
            EDGE_BOTTOM, EDGE_LEFT, EDGE_RIGHT, EDGE_TOP,
        };
        for &edge in &[EDGE_LEFT, EDGE_RIGHT, EDGE_TOP, EDGE_BOTTOM] {
            layer.set_anchor_edge(&gtk_window, edge, true)?;
        }
        layer.set_margins(&gtk_window, 0, 0)?;
    } else {
        let (origin_x, origin_y, width, height) = usable_area(app, &display)?;
        gtk_window.set_size_request(width, height);
        gtk_window.move_(origin_x, origin_y);
    }
    if let Err(error) = refresh_overlay_input_region(app, window, &gtk_window) {
        log::warn!("voice_overlay.input_region_failed error={error}");
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn position_overlay_window<R: Runtime>(
    app: &AppHandle<R>,
    window: &WebviewWindow<R>,
) -> Result<(), String> {
    let (origin_x, origin_y, _, _) = usable_area(app, window)?;
    let (x, y) = overlay_box_origin(app, window)?;
    window
        .set_position(tauri::PhysicalPosition::new(origin_x + x, origin_y + y))
        .map_err(|error| error.to_string())
}

pub fn prepare_overlay<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let _guard = window_control_lock()
        .lock()
        .map_err(|_| "语音窗口控制器不可用".to_owned())?;
    prepare_overlay_inner(app)
}

fn show_ball_inner<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    // 浮窗已展开时不再叠球（唤醒流的语义）。判据只能是意图状态：
    // 同一轮里刚发出去的 hide() 还在 GLib 队列里，读 is_visible() 会拿到旧值。
    if OVERLAY_INTENT_VISIBLE.load(std::sync::atomic::Ordering::SeqCst) {
        return Ok(());
    }
    if let Some(window) = app.get_webview_window(VOICE_BALL_LABEL) {
        let preference = app
            .state::<crate::desktop_integration::DesktopIntegrationState>()
            .voice_ball();
        window
            .emit(
                "voice-ball-shown",
                serde_json::json!({
                    "rightMargin": preference.right_margin,
                    "bottomMargin": preference.bottom_margin,
                }),
            )
            .map_err(|error| error.to_string())?;
        #[cfg(target_os = "linux")]
        if let Ok(gtk_window) = window.gtk_window() {
            if let Err(error) = refresh_ball_input_region(app, &gtk_window) {
                log::warn!("voice_ball.input_region_failed error={error}");
            }
        }
        return window.show().map_err(|error| error.to_string());
    }
    create_ball(app, true)
}

/// 唤醒只显示球，不推进浮窗代次。
///
/// 代次描述的是浮窗本体（show/hide 才该动它）。唤醒时自增会让语音流程拿着旧代次
/// 去 show：前端在 wake 时捕获代次，asr_final 才带着它请求显示，中间任何一次
/// hide 都会让这个请求被判过期而静默丢弃——浮窗不出现，球又刚好被
/// restore_ball_preference 收回，用户看到的就是"什么也没发生"。
pub fn show_ball<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let _guard = window_control_lock()
        .lock()
        .map_err(|_| "语音窗口控制器不可用".to_owned())?;
    show_ball_inner(app)
}

pub fn hide_ball<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let _guard = window_control_lock()
        .lock()
        .map_err(|_| "语音窗口控制器不可用".to_owned())?;
    if let Some(window) = app.get_webview_window(VOICE_BALL_LABEL) {
        window.hide().map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub fn toggle_ball<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let _guard = window_control_lock()
        .lock()
        .map_err(|_| "语音窗口控制器不可用".to_owned())?;
    let state = app.state::<crate::desktop_integration::DesktopIntegrationState>();
    let mut preference = state.voice_ball();
    preference.visible = !preference.visible;
    state.update_voice_ball(preference, true)?;
    if preference.visible {
        show_ball_inner(app)
    } else if let Some(window) = app.get_webview_window(VOICE_BALL_LABEL) {
        window.hide().map_err(|error| error.to_string())
    } else {
        Ok(())
    }
}

#[tauri::command]
pub async fn hide_voice_overlay<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    reason: Option<String>,
) -> Result<(), String> {
    if window.label() != VOICE_OVERLAY_LABEL {
        return Err("只有语音输入弹窗能关闭语音输入弹窗".to_owned());
    }
    match reason.as_deref() {
        None => hide_voice_overlay_inner(app).await,
        Some("handoff") => hide_overlay(app, HideReason::Handoff).await,
        _ => Err("无效的浮窗关闭原因".to_owned()),
    }
}

/// 浮窗内容框当前的落点（surface 坐标）。窗口是全屏透明的，
/// 前端按这个坐标摆 460×620 的框，位置真源在后端。
#[tauri::command]
pub fn get_voice_overlay_position<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
) -> Result<(i32, i32), String> {
    if window.label() != VOICE_OVERLAY_LABEL {
        return Err("只有语音输入弹窗能读取自身位置".to_owned());
    }
    overlay_box_origin(&app, &window)
}

/// 拖动结束：把位移折算进「相对悬浮球的偏移」并落盘，顺带刷新可点区域。
/// 返回夹紧之后的落点，前端按它收尾（被屏幕边夹掉多少，这里说了算）。
#[tauri::command]
pub fn update_voice_overlay_offset<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    delta_x: i32,
    delta_y: i32,
) -> Result<(i32, i32), String> {
    if window.label() != VOICE_OVERLAY_LABEL {
        return Err("只有语音输入弹窗能移动自己".to_owned());
    }
    #[cfg(target_os = "linux")]
    let usable = {
        use gtk::prelude::*;
        let display = window
            .gtk_window()
            .map_err(|error| error.to_string())?
            .display();
        let (_, _, width, height) = usable_area(&app, &display)?;
        (width, height)
    };
    #[cfg(not(target_os = "linux"))]
    let usable = {
        let (_, _, width, height) = usable_area(&app, &window)?;
        (width, height)
    };
    let state = app.state::<crate::desktop_integration::DesktopIntegrationState>();
    let ball = state.voice_ball();
    let current = state.voice_overlay();
    let ball_at = ball_origin(usable, ball.right_margin, ball.bottom_margin);
    let before = overlay_origin(usable, ball_at, (current.offset_x, current.offset_y));
    let (x, y) = overlay_origin(
        usable,
        ball_at,
        (current.offset_x + delta_x, current.offset_y + delta_y),
    );
    // 球跟着浮窗走：球贴在浮窗右下角（offset 就是这两个尺寸的差）是这套几何的不变量。
    // 球留在原地的话，浮窗收起来时球会出现在跟浮窗毫无关系的角落。
    let ball_at = followed_ball_origin(usable, ball_at, (x - before.0, y - before.1));
    // 落盘失败时前端会把框放回原处（看到的位置不能和记住的位置分叉），错误只在 webview
    // 控制台里，app.log 里也留一条：否则「拖完弹回原位」只能靠猜。
    let overlay_preference = crate::desktop_integration::VoiceOverlayPreference {
        offset_x: x - ball_at.0,
        offset_y: y - ball_at.1,
    };
    if let Err(error) = state.update_voice_overlay(overlay_preference, true) {
        log::warn!("voice_overlay.offset_persist_failed error={error}");
        return Err(error);
    }
    let (right_margin, bottom_margin) = (
        (usable.0 - VOICE_BALL_SIZE - ball_at.0).max(0),
        (usable.1 - VOICE_BALL_SIZE - ball_at.1).max(0),
    );
    let ball_preference = crate::desktop_integration::VoiceBallPreference {
        right_margin,
        bottom_margin,
        ..ball
    };
    if let Err(error) = state.update_voice_ball(ball_preference, true) {
        log::warn!("voice_ball.margin_persist_failed error={error}");
        return Err(error);
    }
    // 球窗口是常驻的，前端只在挂载时读一次 margin：后端改了不通知，球画的位置和
    // input region 算的位置就分叉（既有注释警告过这个坑），浮窗收起来时球还停在拖走前的地方。
    if let Some(ball_window) = app.get_webview_window(VOICE_BALL_LABEL) {
        let _ = ball_window.emit(
            "voice-ball:set-margins",
            serde_json::json!({ "rightMargin": right_margin, "bottomMargin": bottom_margin }),
        );
    }
    #[cfg(target_os = "linux")]
    if let Ok(gtk_window) = window.gtk_window() {
        if let Err(error) = refresh_overlay_input_region(&app, &window, &gtk_window) {
            log::warn!("voice_overlay.input_region_failed error={error}");
        }
    }
    Ok((x, y))
}

/// 前端「内容框已经收起来」的回执槽。
///
/// 窗口 unmapped 后 webview 不会再渲染，合成器留住的最后一帧会在下次 map 时先亮出来：
/// SpacemiT K3 实测先按旧落点画约 190ms，再跳到正确位置。所以隐藏前必须让最后一帧是空的。
static OVERLAY_BLANK_ACK: OnceLock<Mutex<Option<tokio::sync::oneshot::Sender<()>>>> =
    OnceLock::new();
static BALL_BLANK_ACK: OnceLock<Mutex<Option<tokio::sync::oneshot::Sender<()>>>> = OnceLock::new();

/// 前端不响应（卡死、还没加载）时的兜底：宁可闪一下，也不能让浮窗关不掉。
const OVERLAY_BLANK_TIMEOUT_MS: u64 = 300;

fn blank_ack_slot(label: &str) -> &'static Mutex<Option<tokio::sync::oneshot::Sender<()>>> {
    if label == VOICE_BALL_LABEL {
        BALL_BLANK_ACK.get_or_init(|| Mutex::new(None))
    } else {
        OVERLAY_BLANK_ACK.get_or_init(|| Mutex::new(None))
    }
}

/// 让前端收起内容框并等回执，再去 unmapped 窗口。
fn request_surface_blank<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
) -> Option<tokio::sync::oneshot::Receiver<()>> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    match blank_ack_slot(label).lock() {
        Ok(mut slot) => *slot = Some(sender),
        Err(_) => return None,
    }
    if let Err(error) = app.emit_to(label, &format!("{label}-hidden"), ()) {
        log::debug!("voice_surface.blank_notify_failed label={label} error={error}");
        return None;
    }
    Some(receiver)
}

async fn wait_surface_blanked(receiver: Option<tokio::sync::oneshot::Receiver<()>>, label: &str) -> bool {
    let Some(receiver) = receiver else {
        return false;
    };
    match tokio::time::timeout(
        std::time::Duration::from_millis(OVERLAY_BLANK_TIMEOUT_MS),
        receiver,
    )
    .await
    {
        Ok(Ok(())) => {
            log::debug!("voice_surface.blanked label={label}");
            true
        }
        Ok(Err(_)) => {
            log::debug!("voice_surface.blank_ack_dropped label={label}");
            false
        }
        Err(_) => {
            log::warn!("voice_surface.blank_timeout label={label}");
            false
        }
    }
}

/// 前端收起内容框后的回执；收框那一帧已经提交给合成器，可以取消映射了。
#[tauri::command]
pub fn voice_overlay_blanked<R: Runtime>(window: WebviewWindow<R>) -> Result<(), String> {
    if window.label() != VOICE_OVERLAY_LABEL {
        return Err("只有语音输入弹窗能报告已隐藏".to_owned());
    }
    if let Ok(mut slot) = blank_ack_slot(VOICE_OVERLAY_LABEL).lock() {
        if let Some(sender) = slot.take() {
            let _ = sender.send(());
        }
    }
    Ok(())
}

#[tauri::command]
pub fn voice_ball_blanked<R: Runtime>(window: WebviewWindow<R>) -> Result<(), String> {
    if window.label() != VOICE_BALL_LABEL {
        return Err("只有悬浮球能报告自身已隐藏".to_owned());
    }
    if let Ok(mut slot) = blank_ack_slot(VOICE_BALL_LABEL).lock() {
        if let Some(sender) = slot.take() {
            let _ = sender.send(());
        }
    }
    Ok(())
}

pub(crate) async fn hide_voice_overlay_inner<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    hide_overlay(app, HideReason::Dismiss).await
}

/// 浮窗隐藏的三种语义：区别在于要不要清掉浮窗会话、要不要掐断正在跑的语音。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum HideReason {
    /// Esc / 关闭按钮：用户明确不要了，清会话 + 取消语音。
    Dismiss,
    /// 转写已交给主窗口：会话留着，顺手清掉语音残留。
    Handoff,
    /// 点到别处：窗口只是让位，会话和正在跑的语音都必须活着——
    /// 用户从悬浮球就能看到它在干活，点回来继续。
    FocusLoss,
}

async fn hide_overlay<R: Runtime>(app: AppHandle<R>, reason: HideReason) -> Result<(), String> {
    let (close_generation, blanked) = {
        let _guard = window_control_lock()
            .lock()
            .map_err(|_| "语音窗口控制器不可用".to_owned())?;
        // 浮窗已经不在屏幕上时，这次 hide 多半是隐藏动作自己引出来的失焦回声
        // （日志里 Dismiss 后面总跟着一条 FocusLoss）。它没有可见性可改，
        // 却会把代次顶掉；而唤醒流程是拿着唤醒那一刻的代次去请求 show 的，
        // 代次被顶掉就等于静默放弃显示。
        if !OVERLAY_INTENT_VISIBLE.load(std::sync::atomic::Ordering::SeqCst) {
            return Ok(());
        }
        let generation = WINDOW_GENERATION.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        if reason == HideReason::Dismiss {
            let _ = app.emit_to(VOICE_OVERLAY_LABEL, "voice-overlay-dismissed", ());
        }
        (generation, request_surface_blank(&app, VOICE_OVERLAY_LABEL))
    };
    // 先让前端把框收起来：这一步之后窗口里的最后一帧是空的，下次 map 才不会先亮出旧位置。
    wait_surface_blanked(blanked, VOICE_OVERLAY_LABEL).await;
    // 失焦只是让位，不能掐断正在跑的录音或 followup 追问。
    if reason != HideReason::FocusLoss {
        let _ = tokio::time::timeout(
     std::time::Duration::from_millis(500),
            crate::voice_tool::cancel_observed(&app),
 )
        .await;
    }
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let callback_app = app.clone();
    app.run_on_main_thread(move || {
        let result = (|| {
            let _guard = window_control_lock()
                .lock()
                .map_err(|_| "语音窗口控制器不可用".to_owned())?;
            if voice_overlay_generation() != close_generation {
                return Ok(());
            }
            OVERLAY_INTENT_VISIBLE.store(false, std::sync::atomic::Ordering::SeqCst);
            if let Some(window) = callback_app.get_webview_window(VOICE_OVERLAY_LABEL) {
                window.hide().map_err(|error| error.to_string())?;
            }
            if callback_app
                .state::<crate::desktop_integration::DesktopIntegrationState>()
                .voice_ball()
                .visible
            {
                // 这里不能改 margin：input region 按落盘 margin 算，而前端球位只在挂载时读一次，
                // 后端偷偷改就会让「球画在哪」和「哪儿能点」分叉，球直接点不动（SpacemiT K3 实测）。
                show_ball_inner(&callback_app)
            } else if let Some(ball) = callback_app.get_webview_window(VOICE_BALL_LABEL) {
                ball.hide().map_err(|error| error.to_string())
            } else {
                Ok(())
            }
        })();
        let _ = sender.send(result);
    })
    .map_err(|error| error.to_string())?;
    let hidden = receiver.await.map_err(|error| error.to_string())?;
    // 隐藏路径原来一声不响，失焦/关闭/交接分不清，排查只能猜。
    log::debug!("voice_overlay.hide reason={reason:?}");
    hidden
}

/// 让浮窗拿到键盘焦点，两段缺一段都打不了字：
/// 1. 窗口层：tao 的 set_focus() 带 `get_visible()` 守卫，紧跟在 show() 后面调用会被吞掉，
///    必须等 show() 的队列落地之后再要；
/// 2. webview 层：键盘事件真正需要的是 webview 的 GTK 焦点（wry 的 grab_focus），
///    而 `WebviewWindow::set_focus()` 只走第 1 段——这是浮窗一直打不了字的根因。
/// 用 glib idle 延后：它的优先级低于 tao 的窗口请求通道，天然排在 show_all() 之后；
/// `run_on_main_thread` 在主线程会内联执行，不能当延后手段。
fn request_overlay_focus<R: Runtime>(app: &AppHandle<R>, window: &WebviewWindow<R>) {
    #[cfg(target_os = "linux")]
    {
        let window = window.clone();
        let scheduled = app.run_on_main_thread(move || {
            gtk::glib::idle_add_local_once(move || {
                if let Err(error) = window.set_focus() {
                    log::warn!("voice_overlay.focus_window_failed error={error}");
                }
                if let Err(error) = window.as_ref().set_focus() {
                    log::warn!("voice_overlay.focus_webview_failed error={error}");
                }
            });
        });
        if let Err(error) = scheduled {
            log::warn!("voice_overlay.focus_schedule_failed error={error}");
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = app;
        if let Err(error) = window.set_focus() {
            log::warn!("voice_overlay.focus_window_failed error={error}");
        }
    }
}

pub(crate) fn show_voice_overlay_inner<R: Runtime>(
    app: AppHandle<R>,
    expected_generation: Option<u64>,
) -> Result<(), String> {
    let _guard = window_control_lock()
        .lock()
        .map_err(|_| "语音窗口控制器不可用".to_owned())?;
    if expected_generation.is_some_and(|expected| expected != voice_overlay_generation()) {
        log::warn!(
            "voice_overlay.show_stale expected={expected_generation:?} current={}",
            voice_overlay_generation()
        );
        return Ok(());
    }
    prepare_overlay_inner(&app)?;
    let window = app
        .get_webview_window(VOICE_OVERLAY_LABEL)
        .ok_or_else(|| "语音输入弹窗创建失败".to_owned())?;
    #[cfg(target_os = "linux")]
    position_overlay_surface(&app, &window, false)?;
    #[cfg(not(target_os = "linux"))]
    position_overlay_window(&app, &window)?;
    // 记在 show 之前：宽限期要覆盖 show/set_focus 期间的焦点抖动。
    OVERLAY_SHOWN_AT_MS.store(process_uptime_ms(), std::sync::atomic::Ordering::SeqCst);
    window.show().map_err(|error| error.to_string())?;
    window
        .emit("voice-overlay-shown", ())
        .map_err(|error| error.to_string())?;
    request_overlay_focus(&app, &window);
    // 意图置位放在成功路径末尾：show 失败时保持 false，免得球被永久挡掉。
    let was_visible = OVERLAY_INTENT_VISIBLE.swap(true, std::sync::atomic::Ordering::SeqCst);
    let generation = WINDOW_GENERATION.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
    log::debug!("voice_overlay.show generation={generation} was_visible={was_visible}");
    if !was_visible && app.get_webview_window(VOICE_BALL_LABEL).is_some() {
        let blanked = request_surface_blank(&app, VOICE_BALL_LABEL);
        let hide_app = app.clone();
        tauri::async_runtime::spawn(async move {
            let blanked = wait_surface_blanked(blanked, VOICE_BALL_LABEL).await;
            let callback_app = hide_app.clone();
            let _ = hide_app.run_on_main_thread(move || {
                if OVERLAY_INTENT_VISIBLE.load(std::sync::atomic::Ordering::SeqCst) {
                    if let Some(ball) = callback_app.get_webview_window(VOICE_BALL_LABEL) {
                        #[cfg(target_os = "linux")]
                        if let Ok(gtk_window) = ball.gtk_window() {
                            use gtk::prelude::*;
                            if blanked && gtk_window.display().type_().name() == "GdkWaylandDisplay" {
                                match refresh_ball_input_region(&callback_app, &gtk_window) {
                                    Ok(()) => return,
                                    Err(error) => log::warn!("voice_ball.input_region_failed error={error}"),
                                }
                            }
                        }
                        if let Err(error) = ball.hide() {
                            log::warn!("voice_ball.hide_failed error={error}");
                        }
                    }
                }
            });
        });
    }
    Ok(())
}

#[tauri::command]
pub fn show_voice_overlay<R: Runtime>(
    app: AppHandle<R>,
    expected_generation: Option<u64>,
    window: WebviewWindow<R>,
) -> Result<(), String> {
    if !matches!(window.label(), VOICE_BALL_LABEL | VOICE_OVERLAY_LABEL) {
        return Err("该窗口不能打开语音输入弹窗".to_owned());
    }
    if window.label() == VOICE_BALL_LABEL {
        app.emit_to(
            VOICE_OVERLAY_LABEL,
            "voice-overlay-opened",
            serde_json::json!({"mode": "voice"}),
        )
        .map_err(|error| error.to_string())?;
    }
    show_voice_overlay_inner(app, expected_generation)
}

/// 托盘只负责打开浮窗，不替用户开始录音。
pub fn open_from_tray(app: &AppHandle) -> Result<(), String> {
    show_overlay_for_app(app, "keyboard", "tray_open")
}

/// 全局快捷键入口：打开浮窗并立即开始一次手动录音，省掉用户在浮窗里再点一次小球。
///
/// 录音动作走 `start_manual_asr`，事件由语音服务的缓冲重放兜住浮窗尚未挂载监听的窗口期。
pub fn open_for_voice_listen(app: &AppHandle) -> Result<(), String> {
    show_overlay_for_app(app, "voice", "shortcut_open")?;
    let listen_app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = crate::voice_tool::start_manual_asr().await {
            log::error!("voice_overlay.shortcut_listen_failed error={error}");
            // 语音服务不可用时把原因送进浮窗，用户看到失败提示而不是毫无反应。
            let _ = listen_app.emit_to(
                VOICE_OVERLAY_LABEL,
                crate::voice_tool::VOICE_TOOL_EVENT,
                serde_json::json!({
                    "event": "error",
                    "code": "MANUAL_ASR_UNAVAILABLE",
                    "message": error,
                }),
            );
        }
    });
    Ok(())
}

fn show_overlay_for_app(app: &AppHandle, mode: &str, log_tag: &str) -> Result<(), String> {
    let callback_app = app.clone();
    let mode = mode.to_owned();
    let log_tag = log_tag.to_owned();
    app.run_on_main_thread(move || {
        let result = (|| {
            prepare_overlay(&callback_app)?;
            callback_app
                .emit_to(
                    VOICE_OVERLAY_LABEL,
                    "voice-overlay-opened",
                    serde_json::json!({"mode": mode}),
                )
                .map_err(|error| error.to_string())?;
            show_voice_overlay_inner(callback_app, None)
        })();
        if let Err(error) = result {
            log::error!("voice_overlay.{log_tag}_failed error={error}");
        }
    })
    .map_err(|error| error.to_string())
}

#[cfg(target_os = "linux")]
fn ball_layer(
) -> Result<&'static crate::status_popup::linux::layer_shell::GtkLayerShellBridge, String> {
    static LAYER: OnceLock<
        Result<crate::status_popup::linux::layer_shell::GtkLayerShellBridge, String>,
    > = OnceLock::new();
    LAYER
        .get_or_init(crate::status_popup::linux::layer_shell::GtkLayerShellBridge::load)
        .as_ref()
        .map_err(Clone::clone)
}

#[cfg(target_os = "linux")]
/// 球所在圆的逐行覆盖：返回 (x, y, width)，坐标是窗口局部坐标（窗口 = 整屏）。
/// 每行只发一个矩形，union 次数从 O(r²) 降到 O(r)。
#[cfg(target_os = "linux")]
fn ball_input_rows(
    screen_w: i32,
    screen_h: i32,
    right_margin: i32,
    bottom_margin: i32,
) -> Vec<(i32, i32, i32)> {
    let radius = VOICE_BALL_SIZE / 2;
    let center_x = screen_w - right_margin - radius;
    let center_y = screen_h - bottom_margin - radius;
    let mut rows = Vec::new();
    for dy in -radius..=radius {
        let y = center_y + dy;
        if y < 0 || y >= screen_h {
            continue;
        }
        let half = ((radius * radius - dy * dy) as f64).sqrt() as i32;
        let x0 = (center_x - half).max(0);
        let x1 = (center_x + half).min(screen_w - 1);
        if x1 < x0 {
            continue;
        }
        rows.push((x0, y, x1 - x0 + 1));
    }
    rows
}

/// 把窗口 input region 限制成球所在的圆，其余区域点击直接穿透。
/// 全屏 overlay 靠它维持“透明且不挡桌面”，漏掉这一步整屏都会吞点击。
#[cfg(target_os = "linux")]
fn set_ball_input_region(
    gtk_window: &gtk::ApplicationWindow,
    screen_w: i32,
    screen_h: i32,
    right_margin: i32,
    bottom_margin: i32,
) {
    use gtk::prelude::*;
    if let Some(gdk_window) = gtk_window.window() {
        use gtk::cairo;
        let region = cairo::Region::create();
        if !OVERLAY_INTENT_VISIBLE.load(std::sync::atomic::Ordering::SeqCst) {
            for (x, y, width) in ball_input_rows(screen_w, screen_h, right_margin, bottom_margin) {
                let _ = region.union_rectangle(&cairo::RectangleInt::new(x, y, width, 1));
            }
        }
        gdk_window.input_shape_combine_region(&region, 0, 0);
    }
}

/// 按当前偏好与窗口实际尺寸刷新 input region。
#[cfg(target_os = "linux")]
fn refresh_ball_input_region<R: Runtime>(
    app: &AppHandle<R>,
    window: &gtk::ApplicationWindow,
) -> Result<(), String> {
    use gtk::prelude::*;
    let display = window.display();
    if display.type_().name() != "GdkWaylandDisplay" {
        return Ok(());
    }
    let preference = app
        .state::<crate::desktop_integration::DesktopIntegrationState>()
        .voice_ball();
    let monitor = display
        .monitor(preference.screen_index as i32)
        .or_else(|| display.primary_monitor())
        .or_else(|| display.monitor(0))
        .ok_or("没有可用屏幕")?;
    // 首次分配完成前只能退回 workarea（差一个面板高度），等 size-allocate 再刷一次。
    let area = monitor.workarea();
    let (width, height) =
        laid_out_surface_size(window, &monitor).unwrap_or((area.width(), area.height()));
    set_ball_input_region(
        window,
        width,
        height,
        preference.right_margin,
        preference.bottom_margin,
    );
    Ok(())
}

fn position_ball<R: Runtime>(
    app: &AppHandle<R>,
    window: &WebviewWindow<R>,
    initialize: bool,
) -> Result<bool, String> {
    use gtk::prelude::*;
    let gtk_window = window.gtk_window().map_err(|error| error.to_string())?;
    let display = gtk_window.display();
    let state = app.state::<crate::desktop_integration::DesktopIntegrationState>();
    let preference = state.voice_ball();

    let screens: Vec<_> = (0..display.n_monitors())
        .filter_map(|index| display.monitor(index))
        .collect();

    let monitor = screens
        .get(preference.screen_index)
        .or_else(|| screens.iter().find(|m| m.is_primary()))
        .or_else(|| screens.first())
        .ok_or("没有可用屏幕")?;

    let wayland = display.type_().name() == "GdkWaylandDisplay";

    if wayland {
        let layer = ball_layer()?;
        if initialize {
            layer.initialize(&gtk_window)?;
        }
        layer.set_monitor(&gtk_window, monitor)?;

        // 全屏锚定：四边 anchor，0 margin
        use crate::status_popup::linux::layer_shell::{EDGE_LEFT, EDGE_RIGHT, EDGE_TOP, EDGE_BOTTOM};
        for &edge in &[EDGE_LEFT, EDGE_RIGHT, EDGE_TOP, EDGE_BOTTOM] {
            layer.set_anchor_edge(&gtk_window, edge, true)?;
        }
        layer.set_margins(&gtk_window, 0, 0)?;

        // input region：只有球所在圆形区域接收输入，其余穿透
        if let Err(error) = refresh_ball_input_region(app, &gtk_window) {
            log::warn!("voice_ball.input_region_failed error={error}");
        }
    } else {
        // X11: 保持小窗口行为（非目标环境）
        let area = monitor.workarea();
        let size = crate::status_popup::placement::Size::new(VOICE_BALL_SIZE, VOICE_BALL_SIZE);
        let point = crate::status_popup::placement::x11_top_left(
            crate::status_popup::placement::Rect::new(area.x(), area.y(), area.width(), area.height()),
            size,
            preference.right_margin,
            preference.bottom_margin,
        );
        gtk_window.set_size_request(VOICE_BALL_SIZE, VOICE_BALL_SIZE);
        gtk_window.move_(point.x, point.y);
    }

    Ok(wayland)
}

/// 更新悬浮球位置：前端拖动结束时从 CSS transform 反算 margin 并落盘。
#[tauri::command]
pub fn update_voice_ball_position<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    right_margin: i32,
    bottom_margin: i32,
) -> Result<(), String> {
    if window.label() != VOICE_BALL_LABEL {
        return Err("只有悬浮球可以更新自身位置".to_owned());
    }
    let state = app.state::<crate::desktop_integration::DesktopIntegrationState>();
    let mut preference = state.voice_ball();
    preference.right_margin = right_margin.max(0);
    preference.bottom_margin = bottom_margin.max(0);
    state.update_voice_ball(preference, true)?;

    #[cfg(target_os = "linux")]
    // Wayland 全屏窗口：球移动后 input region 要跟着挪，否则球挪走了还只有原位能点。
    if let Ok(gtk_window) = window.gtk_window() {
        if let Err(error) = refresh_ball_input_region(&app, &gtk_window) {
            log::warn!("voice_ball.input_region_failed error={error}");
        }
    }

    Ok(())
}

/// 获取悬浮球当前位置：前端计算拖动后的 margin 需要知道拖动前的值。
#[tauri::command]
pub fn get_voice_ball_position<R: Runtime>(
    app: AppHandle<R>,
) -> Result<(i32, i32), String> {
    let preference = app.state::<crate::desktop_integration::DesktopIntegrationState>().voice_ball();
    Ok((preference.right_margin, preference.bottom_margin))
}

pub fn restore_ball_preference<R: Runtime>(app: &AppHandle<R>) {
    if !app
        .state::<crate::desktop_integration::DesktopIntegrationState>()
        .voice_ball()
        .visible
    {
        if let Err(error) = hide_ball(app) {
            log::warn!("voice_ball.restore_failed error={error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 失焦隐藏必须保留语音会话：只有 Dismiss/Handoff 才 cancel。
    #[test]
    fn only_non_focus_loss_cancels_the_voice_session() {
        assert!(HideReason::Dismiss != HideReason::FocusLoss);
        assert!(HideReason::Handoff != HideReason::FocusLoss);
        // hide_overlay 里的判据；写死在测试里，改坏会被抓住。
        for reason in [HideReason::Dismiss, HideReason::Handoff] {
            assert!(reason != HideReason::FocusLoss, "{reason:?} 必须取消语音会话");
        }
    }

    /// 只有 Dismiss 会通知前端清掉浮窗会话。
    #[test]
    fn only_dismiss_clears_the_overlay_conversation() {
        assert!(HideReason::Dismiss == HideReason::Dismiss);
        assert!(HideReason::Handoff != HideReason::Dismiss);
assert!(HideReason::FocusLoss != HideReason::Dismiss);
    }

    /// 首开错位的回归：surface 还没排好版时 `window.size()` 报的是 Tauri 默认 800×600，
    /// 认了它，可用区就退化成 800×600，浮窗被夹到 (205,0)。
    #[cfg(target_os = "linux")]
    #[test]
    fn unlaid_out_surface_is_rejected() {
        assert!(!covers_screen((800, 600), (1920, 1080)), "默认尺寸不是排好版");
        assert!(covers_screen((1920, 1036), (1920, 1080)), "去掉面板的可用区要认");
        assert!(covers_screen((1920, 1080), (1920, 1080)));
        // 800×600 的屏上默认值恰好等于真值，认它无害。
        assert!(covers_screen((800, 600), (800, 600)));
    }

    /// 浮窗拖走后球跟过去；贴到屏幕边时球被夹住，浮窗留在用户放下的地方。
    #[test]
    fn ball_follows_the_moved_overlay() {
        let usable = (1920, 1036);
        assert_eq!(
            followed_ball_origin(usable, (1689, 898), (-100, -200)),
            (1589, 698)
        );
        assert_eq!(followed_ball_origin(usable, (1689, 898), (-3000, -3000)), (0, 0));
        assert_eq!(
            followed_ball_origin(usable, (1689, 898), (3000, 3000)),
            (1920 - VOICE_BALL_SIZE, 1036 - VOICE_BALL_SIZE)
        );
    }

    /// 宽限期内的失焦被吞掉，之后的放行；没显示过（0）永不触发。
    #[test]
    fn focus_grace_suppresses_only_right_after_show() {
        fn within(shown_at: u64, now: u64) -> bool {
            shown_at != 0 && now.saturating_sub(shown_at) <= FOCUS_GRACE_MS
   }
        assert!(within(1_000, 1_000), "show 同帧的失焦要吞掉");
        assert!(within(1_000, 1_000 + FOCUS_GRACE_MS), "边界内要吞掉");
     assert!(!within(1_000, 1_001 + FOCUS_GRACE_MS), "宽限期外要放行");
           assert!(!within(0, 5_000), "没显示过就不该抑制");
        // now < shown_at 在单调时钟下不会发生；saturating_sub 让它落到
      // 「抑制」这一侧（不隐藏），是两者中安全的那个，且不会 panic。
        assert!(within(5_000, 1_000));
    }

    /// 浮窗落点：跟着球的偏移走，越界一律夹回可用区。
    #[test]
    fn overlay_origin_follows_the_ball_and_stays_inside_the_screen() {
        let usable = (1920, 1080);
        let ball = ball_origin(usable, 204, 453);
        assert_eq!(ball, (1620, 531), "球左上角由右下角边距反算");

        // 默认偏移：浮窗右下角贴住球右下角。
        let offset = (
            -(VOICE_OVERLAY_WIDTH - VOICE_BALL_SIZE),
            -(VOICE_OVERLAY_HEIGHT - VOICE_BALL_SIZE),
        );
        assert_eq!(overlay_origin(usable, ball, offset), (1256, 7));

        // 球挪到左上角：浮窗跟着球走，越出左上角的部分夹回原点。
        let moved = ball_origin(usable, 1700, 900);
        assert_eq!(moved, (124, 84));
        assert_eq!(overlay_origin(usable, moved, offset), (0, 0));

        // 球挪到右下角：浮窗右下角越界，夹回可用区右下角。
        let corner = ball_origin(usable, 16, 16);
        assert_eq!(ball_origin(usable, 16, 16), (1808, 968));
        assert_eq!(overlay_origin(usable, corner, (0, 0)), (1460, 460));
    }

    /// input region 逐行覆盖：过球心的行铺满直径，且任何 margin 下都不越出屏幕。
    #[cfg(target_os = "linux")]
    #[test]
    fn ball_input_rows_stay_inside_the_screen() {
        let (w, h) = (1920, 1080);
        let radius = VOICE_BALL_SIZE / 2;
        let rows = ball_input_rows(w, h, 16, 16);
        assert_eq!(rows.len(), (2 * radius + 1) as usize, "半径内的每一行都要有覆盖");
        assert_eq!(
            rows.iter().map(|(_, _, width)| *width).max(),
            Some(2 * radius + 1),
            "过球心的行要铺满直径"
        );
        for margin in [0, 16, 400] {
            for (x, y, width) in ball_input_rows(w, h, margin, margin) {
                assert!(y >= 0 && y < h, "行不能跑出屏幕: y={y}");
                assert!(x >= 0 && x + width <= w, "行不能跑出屏幕: x={x} width={width}");
            }
        }
    }
}
