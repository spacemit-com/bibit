use super::{
    placement::{restore_popup_placement, x11_top_left, Point, Rect, ScreenGeometry, Size},
    state::{PopupDecision, PopupLifecycle, PopupState},
};
use crate::desktop_integration::{
    DesktopIntegrationState, PopupGeometryPreference, SingleInstanceAction, POPUP_MAX_HEIGHT,
    POPUP_MAX_WIDTH, POPUP_MIN_HEIGHT, POPUP_MIN_WIDTH,
};
use std::{sync::Mutex, time::Instant};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

#[cfg(target_os = "linux")]
use super::linux::layer_shell::GtkLayerShellBridge;
#[cfg(target_os = "linux")]
use gtk::prelude::*;

pub const STATUS_POPUP_LABEL: &str = "status-popup";
pub const POPUP_VISIBILITY_EVENT: &str = "popup_visibility_changed";

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PopupWindowSpec {
    pub width: f64,
    pub height: f64,
    pub min_width: f64,
    pub min_height: f64,
    pub visible: bool,
    pub resizable: bool,
    pub skip_taskbar: bool,
    pub always_on_top: bool,
}

impl Default for PopupWindowSpec {
    fn default() -> Self {
        Self {
            width: 420.0,
            height: 600.0,
            min_width: POPUP_MIN_WIDTH.into(),
            min_height: POPUP_MIN_HEIGHT.into(),
            visible: false,
            resizable: true,
            skip_taskbar: true,
            always_on_top: false,
        }
    }
}

impl PopupWindowSpec {
    fn from_geometry(geometry: PopupGeometryPreference) -> Self {
        Self {
            width: geometry.width.into(),
            height: geometry.height.into(),
            ..Self::default()
        }
    }
}

pub struct StatusPopupController {
    state: Mutex<PopupState>,
    started_at: Instant,
    #[cfg(target_os = "linux")]
    layer_shell: Option<GtkLayerShellBridge>,
}

impl Default for StatusPopupController {
    fn default() -> Self {
        #[cfg(target_os = "linux")]
        let layer_shell = match GtkLayerShellBridge::load() {
            Ok(bridge) => Some(bridge),
            Err(error) => {
                log::warn!("popup.layer_shell_unavailable error={error}");
                None
            }
        };

        Self {
            state: Mutex::new(PopupState::default()),
            started_at: Instant::now(),
            #[cfg(target_os = "linux")]
            layer_shell,
        }
    }
}

impl StatusPopupController {
    pub fn dispatch_activation(
        &self,
        app: tauri::AppHandle,
        ref_pos: Option<Point>,
    ) -> Result<(), String> {
        self.dispatch_activation_at(app, ref_pos, Instant::now())
    }

    /// 统一入口：调度到主线程执行单实例激活动作（`StartVoiceListen` / `OpenMainWindow`）。
    /// `Ignore`（后台启动）不做任何 UI 动作。
    pub(crate) fn activate(&self, app: tauri::AppHandle, action: SingleInstanceAction) {
        match action {
            SingleInstanceAction::Ignore => {}
            SingleInstanceAction::StartVoiceListen => {
                if let Err(error) = crate::voice_overlay::open_for_voice_listen(&app) {
                    log::error!("single_instance.voice_listen_failed error={error}");
                }
            }
            SingleInstanceAction::OpenMainWindow => {
                let callback_app = app.clone();
                if let Err(error) = app.run_on_main_thread(move || {
                    if let Err(error) = Self::open_main(&callback_app) {
                        log::error!("single_instance.main_window_activation_failed error={error}");
                    }
                }) {
                    log::error!(
                        "single_instance.main_window_activation_schedule_failed error={error}"
                    );
                }
            }
        }
    }

    pub(crate) fn dispatch_activation_at(
        &self,
        app: tauri::AppHandle,
        ref_pos: Option<Point>,
        received_at: Instant,
    ) -> Result<(), String> {
        let callback_app = app.clone();
        app.run_on_main_thread(move || {
            let controller = callback_app.state::<StatusPopupController>();
            if let Err(error) =
                controller.handle_activation_on_main(&callback_app, ref_pos, received_at)
            {
                log::error!("popup.activation_failed error={error}");
            }
        })
        .map_err(|error| error.to_string())
    }

    pub fn hide(&self, app: &tauri::AppHandle, focus_loss: bool) -> Result<(), String> {
        let received_at = Instant::now();
        let callback_app = app.clone();
        app.run_on_main_thread(move || {
            let controller = callback_app.state::<StatusPopupController>();
            if let Err(error) = controller.hide_on_main(&callback_app, focus_loss, received_at) {
                log::error!("popup.hide_failed error={error}");
            }
        })
        .map_err(|error| error.to_string())
    }

    pub fn minimize(&self, app: &tauri::AppHandle) -> Result<(), String> {
        let callback_app = app.clone();
        app.run_on_main_thread(move || {
            let controller = callback_app.state::<StatusPopupController>();
            if let Err(error) = controller.minimize_on_main(&callback_app) {
                log::error!("popup.minimize_failed error={error}");
            }
        })
        .map_err(|error| error.to_string())
    }

    pub fn open_main(app: &tauri::AppHandle) -> Result<(), String> {
        let window = app
            .get_webview_window("main")
            .ok_or_else(|| "主窗口不存在".to_owned())?;
        window.show().map_err(|error| error.to_string())?;
        window.unminimize().map_err(|error| error.to_string())?;
        #[cfg(target_os = "linux")]
        {
            let gtk_window = window.gtk_window().map_err(|error| error.to_string())?;
            gtk_window.present();
            crate::window_health::record(app, "event=main_window_shown reason=open_main");
            crate::window_health::nudge_repaint(app);
            if gtk_window.display().type_().name() == "GdkWaylandDisplay" {
                // ponytail: wlroots fallback; replace with xdg-activation when
                // non-wlroots Wayland desktops become a supported target.
                std::thread::spawn(|| {
                    for _ in 0..5 {
                        std::thread::sleep(std::time::Duration::from_millis(50));
                        if std::process::Command::new("wlrctl")
                            .args(["toplevel", "focus", "app_id:bibit-gui", "title:BiBit"])
                            .status()
                            .is_ok_and(|status| status.success())
                        {
                            return;
                        }
                    }
                    log::debug!("main_window.wlrctl_focus_failed_after_retry");
                });
            }
        }
        window.set_focus().map_err(|error| error.to_string())
    }

    fn elapsed_ms_at(&self, received_at: Instant) -> u64 {
        received_at
            .checked_duration_since(self.started_at)
            .unwrap_or_default()
            .as_millis()
            .min(u128::from(u64::MAX)) as u64
    }

    fn handle_activation_on_main(
        &self,
        app: &tauri::AppHandle,
        ref_pos: Option<Point>,
        received_at: Instant,
    ) -> Result<(), String> {
        let decision = self.commit_activation_decision_at(ref_pos, received_at)?;

        match decision {
            PopupDecision::CreateAndShow | PopupDecision::Show => self.show_on_main(app),
            PopupDecision::Hide => self.hide_on_main(app, false, received_at),
            PopupDecision::Ignore => {
                log::debug!("popup.focus_loss_suppressed");
                Ok(())
            }
        }
    }

    fn commit_activation_decision_at(
        &self,
        ref_pos: Option<Point>,
        received_at: Instant,
    ) -> Result<PopupDecision, String> {
        let received_at_ms = self.elapsed_ms_at(received_at);
        Ok(self
            .state
            .lock()
            .map_err(|_| "状态弹窗状态锁已损坏".to_owned())?
            .activate(received_at_ms, ref_pos))
    }

    fn show_on_main(&self, app: &tauri::AppHandle) -> Result<(), String> {
        let geometry = app.state::<DesktopIntegrationState>().popup_geometry();
        let spec = PopupWindowSpec::from_geometry(geometry);
        let (window, created) = match app.get_webview_window(STATUS_POPUP_LABEL) {
            Some(window) => (window, false),
            None => (self.create_window(app, spec)?, true),
        };

        if !created {
            window
                .set_size(tauri::LogicalSize::new(spec.width, spec.height))
                .map_err(|error| error.to_string())?;
        }

        let mut degraded = matches!(
            self.state
                .lock()
                .map_err(|_| "状态弹窗状态锁已损坏".to_owned())?
                .lifecycle(),
            PopupLifecycle::DegradedHidden | PopupLifecycle::DegradedVisible
        );

        #[cfg(target_os = "linux")]
        {
            degraded = self.prepare_linux_window(&window, created, geometry)?;
        }

        window.show().map_err(|error| error.to_string())?;
        window.unminimize().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        self.state
            .lock()
            .map_err(|_| "状态弹窗状态锁已损坏".to_owned())?
            .mark_shown(degraded);
        let _ = app.emit(POPUP_VISIBILITY_EVENT, true);
        log::info!("popup.shown");
        Ok(())
    }

    fn hide_on_main(
        &self,
        app: &tauri::AppHandle,
        focus_loss: bool,
        received_at: Instant,
    ) -> Result<(), String> {
        if self.commit_hide_decision_at(focus_loss, received_at)? == PopupDecision::Ignore {
            return Ok(());
        }

        if let Some(window) = app.get_webview_window(STATUS_POPUP_LABEL) {
            window.hide().map_err(|error| error.to_string())?;
        }
        let _ = app.emit(POPUP_VISIBILITY_EVENT, false);
        log::info!("popup.hidden focus_loss={focus_loss}");
        Ok(())
    }

    fn minimize_on_main(&self, app: &tauri::AppHandle) -> Result<(), String> {
        if let Some(window) = app.get_webview_window(STATUS_POPUP_LABEL) {
            #[cfg(target_os = "linux")]
            if window
                .gtk_window()
                .map_err(|error| error.to_string())?
                .display()
                .type_()
                .name()
                == "GdkWaylandDisplay"
            {
                // Layer Shell has no minimize request; hiding is the compositor-safe
                // minimized state for this taskbar-free popup.
                window.hide().map_err(|error| error.to_string())?;
            } else {
                window.minimize().map_err(|error| error.to_string())?;
            }
            #[cfg(not(target_os = "linux"))]
            window.minimize().map_err(|error| error.to_string())?;
        }
        self.state
            .lock()
            .map_err(|_| "状态弹窗状态锁已损坏".to_owned())?
            .mark_hidden();
        let _ = app.emit(POPUP_VISIBILITY_EVENT, false);
        log::info!("popup.minimized");
        Ok(())
    }

    fn commit_hide_decision_at(
        &self,
        focus_loss: bool,
        received_at: Instant,
    ) -> Result<PopupDecision, String> {
        let received_at_ms = self.elapsed_ms_at(received_at);
        let mut state = self
            .state
            .lock()
            .map_err(|_| "状态弹窗状态锁已损坏".to_owned())?;
        if focus_loss {
            Ok(state.focus_lost(received_at_ms))
        } else {
            state.mark_hidden();
            Ok(PopupDecision::Hide)
        }
    }

    fn create_window(
        &self,
        app: &tauri::AppHandle,
        spec: PopupWindowSpec,
    ) -> Result<WebviewWindow, String> {
        let window = WebviewWindowBuilder::new(
            app,
            STATUS_POPUP_LABEL,
            WebviewUrl::App("status-popup".into()),
        )
        .title(crate::core::native_text::current().quick_chat_title)
        // The popup is created hidden and mapped later; binding the authority's
        // resolved theme here keeps its first frame out of light mode.
        .theme(crate::core::setup::current_window_theme())
        .inner_size(spec.width, spec.height)
        .min_inner_size(spec.min_width, spec.min_height)
        .max_inner_size(POPUP_MAX_WIDTH as f64, POPUP_MAX_HEIGHT as f64)
        .visible(spec.visible)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(spec.resizable)
        .skip_taskbar(spec.skip_taskbar)
        .always_on_top(spec.always_on_top)
        .devtools(false)
        .build()
        .map_err(|error| error.to_string())?;

        let event_app = app.clone();
        window.on_window_event(move |event| match event {
            WindowEvent::Focused(false) => {
                let controller = event_app.state::<StatusPopupController>();
                if let Err(error) = controller.hide(&event_app, true) {
                    log::warn!("popup.focus_loss_hide_failed error={error}");
                }
            }
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let controller = event_app.state::<StatusPopupController>();
                if let Err(error) = controller.hide(&event_app, false) {
                    log::warn!("popup.close_hide_failed error={error}");
                }
            }
            WindowEvent::Resized(size) => {
                if let Some(window) = event_app.get_webview_window(STATUS_POPUP_LABEL) {
                    let scale = window.scale_factor().unwrap_or(1.0);
                    let logical = size.to_logical::<i32>(scale);
                    let state = event_app.state::<DesktopIntegrationState>();
                    if let Err(error) = state.update_popup_size(logical.width, logical.height) {
                        log::debug!("popup.size_persist_skipped error={error}");
                    }
                }
            }
            WindowEvent::Moved(position) => {
                if should_persist_native_move(&event_app) {
                    if let Err(error) = persist_window_position(&event_app, *position) {
                        log::debug!("popup.position_persist_skipped error={error}");
                    }
                }
            }
            _ => {}
        });

        #[cfg(target_os = "linux")]
        {
            let resize_app = app.clone();
            let gtk_window = window.gtk_window().map_err(|error| error.to_string())?;
            gtk_window.connect_size_allocate(move |_, allocation| {
                let controller = resize_app.state::<StatusPopupController>();
                if let Err(error) =
                    controller.reapply_wayland_margin(&resize_app, allocation.width())
                {
                    log::debug!("popup.margin_reapply_skipped error={error}");
                }
            });
        }

        log::info!("popup.created");
        Ok(window)
    }

    #[cfg(target_os = "linux")]
    fn prepare_linux_window(
        &self,
        window: &WebviewWindow,
        created: bool,
        geometry: PopupGeometryPreference,
    ) -> Result<bool, String> {
        let gtk_window = window.gtk_window().map_err(|error| error.to_string())?;
        let is_wayland = gtk_window.display().type_().name() == "GdkWaylandDisplay";

        if is_wayland {
            let Some(layer_shell) = &self.layer_shell else {
                log::warn!("popup.positioning_degraded reason=layer_shell_unavailable");
                return Ok(true);
            };
            if created {
                if let Err(error) = layer_shell.initialize(&gtk_window) {
                    log::warn!("popup.layer_shell_init_failed error={error}");
                    return Ok(true);
                }
            }
            self.apply_wayland_geometry(&gtk_window, geometry)?;
            return Ok(false);
        }

        self.apply_x11_position(&gtk_window, geometry)?;
        Ok(false)
    }

    #[cfg(target_os = "linux")]
    fn reapply_wayland_margin(
        &self,
        app: &tauri::AppHandle,
        popup_width: i32,
    ) -> Result<(), String> {
        if !matches!(
            self.state
                .lock()
                .map_err(|_| "状态弹窗状态锁已损坏".to_owned())?
                .lifecycle(),
            PopupLifecycle::Visible | PopupLifecycle::DegradedVisible
        ) {
            return Ok(());
        }
        let window = app
            .get_webview_window(STATUS_POPUP_LABEL)
            .ok_or_else(|| "状态弹窗不存在".to_owned())?;
        let gtk_window = window.gtk_window().map_err(|error| error.to_string())?;
        if gtk_window.display().type_().name() != "GdkWaylandDisplay" {
            return Ok(());
        }
        let mut geometry = app.state::<DesktopIntegrationState>().popup_geometry();
        geometry.width = popup_width.clamp(POPUP_MIN_WIDTH, POPUP_MAX_WIDTH);
        self.apply_wayland_geometry(&gtk_window, geometry)
    }

    #[cfg(target_os = "linux")]
    fn apply_wayland_geometry(
        &self,
        gtk_window: &gtk::ApplicationWindow,
        geometry: PopupGeometryPreference,
    ) -> Result<(), String> {
        let layer_shell = self
            .layer_shell
            .as_ref()
            .ok_or_else(|| "GTK Layer Shell 不可用".to_owned())?;
        let screens = collect_screens(&gtk_window.display());
        let placement = restore_popup_placement(
            &screens,
            geometry.screen_index,
            Size::new(geometry.width, geometry.height),
            geometry.right_margin,
            geometry.bottom_margin,
        )
        .ok_or_else(|| "没有可用屏幕".to_owned())?;
        let monitor = gtk_window
            .display()
            .monitor(placement.screen_index as i32)
            .ok_or_else(|| "目标屏幕不存在".to_owned())?;
        layer_shell.set_monitor(gtk_window, &monitor)?;
        layer_shell.set_margins(gtk_window, placement.right_margin, placement.bottom_margin)?;
        log::debug!(
            "popup.placement_applied screen={} right={} bottom={}",
            placement.screen_index,
            placement.right_margin,
            placement.bottom_margin
        );
        Ok(())
    }

    #[cfg(target_os = "linux")]
    fn apply_x11_position(
        &self,
        gtk_window: &gtk::ApplicationWindow,
        geometry: PopupGeometryPreference,
    ) -> Result<(), String> {
        let display = gtk_window.display();
        let screens = collect_screens(&display);
        let popup_size = Size::new(geometry.width, geometry.height);
        let placement = restore_popup_placement(
            &screens,
            geometry.screen_index,
            popup_size,
            geometry.right_margin,
            geometry.bottom_margin,
        )
        .ok_or_else(|| "没有可用屏幕".to_owned())?;
        let monitor = display
            .monitor(placement.screen_index as i32)
            .ok_or_else(|| "目标屏幕不存在".to_owned())?;
        let work_area = monitor.workarea();
        let point = x11_top_left(
            Rect::new(
                work_area.x(),
                work_area.y(),
                work_area.width(),
                work_area.height(),
            ),
            popup_size,
            placement.right_margin,
            placement.bottom_margin,
        );
        gtk_window.move_(point.x, point.y);
        Ok(())
    }

    pub fn apply_saved_geometry(&self, app: &tauri::AppHandle) -> Result<(), String> {
        let Some(window) = app.get_webview_window(STATUS_POPUP_LABEL) else {
            return Ok(());
        };
        let geometry = app.state::<DesktopIntegrationState>().popup_geometry();
        let spec = PopupWindowSpec::from_geometry(geometry);
        window
            .set_size(tauri::LogicalSize::new(spec.width, spec.height))
            .map_err(|error| error.to_string())?;
        #[cfg(target_os = "linux")]
        self.prepare_linux_window(&window, false, geometry)?;
        Ok(())
    }
}

fn should_persist_native_move(app: &tauri::AppHandle) -> bool {
    #[cfg(target_os = "linux")]
    if let Some(window) = app.get_webview_window(STATUS_POPUP_LABEL) {
        if let Ok(gtk_window) = window.gtk_window() {
            return gtk_window.display().type_().name() != "GdkWaylandDisplay";
        }
    }
    true
}

fn persist_window_position(
    app: &tauri::AppHandle,
    position: tauri::PhysicalPosition<i32>,
) -> Result<(), String> {
    let window = app
        .get_webview_window(STATUS_POPUP_LABEL)
        .ok_or_else(|| "状态弹窗不存在".to_owned())?;
    let size = window.inner_size().map_err(|error| error.to_string())?;
    let monitors = window
        .available_monitors()
        .map_err(|error| error.to_string())?;
    let center_x = i64::from(position.x) + i64::from(size.width) / 2;
    let center_y = i64::from(position.y) + i64::from(size.height) / 2;
    let (screen_index, monitor) = monitors
        .iter()
        .enumerate()
        .find(|(_, monitor)| {
            let origin = monitor.position();
            let extent = monitor.size();
            center_x >= i64::from(origin.x)
                && center_x < i64::from(origin.x) + i64::from(extent.width)
                && center_y >= i64::from(origin.y)
                && center_y < i64::from(origin.y) + i64::from(extent.height)
        })
        .ok_or_else(|| "移动后的浮窗不在可用屏幕内".to_owned())?;
    let origin = monitor.position();
    let extent = monitor.size();
    let scale = monitor.scale_factor();
    let right_margin = ((i64::from(origin.x) + i64::from(extent.width)
        - i64::from(position.x)
        - i64::from(size.width)) as f64
        / scale)
        .round() as i32;
    let bottom_margin = ((i64::from(origin.y) + i64::from(extent.height)
        - i64::from(position.y)
        - i64::from(size.height)) as f64
        / scale)
        .round() as i32;
    app.state::<DesktopIntegrationState>()
        .update_popup_position(screen_index, right_margin, bottom_margin)
}

#[cfg(target_os = "linux")]
fn collect_screens(display: &gtk::gdk::Display) -> Vec<ScreenGeometry> {
    let primary = display.primary_monitor();
    (0..display.n_monitors())
        .filter_map(|index| {
            let monitor = display.monitor(index)?;
            let geometry = monitor.geometry();
            Some(ScreenGeometry {
                x: geometry.x(),
                y: geometry.y(),
                width: geometry.width(),
                height: geometry.height(),
                primary: primary.as_ref().is_some_and(|value| value == &monitor),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn popup_window_spec_is_hidden_compact_and_not_in_taskbar() {
        let spec = PopupWindowSpec::default();
        assert_eq!((spec.width, spec.height), (420.0, 600.0));
        assert_eq!((spec.min_width, spec.min_height), (300.0, 400.0));
        assert!(!spec.visible);
        assert!(spec.resizable);
        assert!(spec.skip_taskbar);
        assert!(!spec.always_on_top);
    }

    #[test]
    fn delayed_main_thread_dispatch_preserves_source_event_time() {
        let controller = StatusPopupController::default();
        controller.state.lock().unwrap().mark_shown(false);
        let focus_lost_at = controller.started_at + std::time::Duration::from_millis(1_000);
        let activation_received_at = focus_lost_at + std::time::Duration::from_millis(100);

        assert_eq!(
            controller
                .commit_hide_decision_at(true, focus_lost_at)
                .unwrap(),
            PopupDecision::Hide
        );
        assert_eq!(
            controller
                .commit_activation_decision_at(None, activation_received_at)
                .unwrap(),
            PopupDecision::Ignore
        );
    }

    #[test]
    fn status_popup_capability_allows_runtime_ipc_without_privileged_plugins() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../../capabilities/status-popup.json")).unwrap();
        let permissions = capability["permissions"]
            .as_array()
            .expect("status-popup permissions must be an array");
        let permission_names = permissions
            .iter()
            .filter_map(serde_json::Value::as_str)
            .collect::<Vec<_>>();

        assert!(permission_names.contains(&"core:default"));
        for privileged in [
            "shell:allow-spawn",
            "updater:default",
            "opener:default",
            "fs:default",
        ] {
            assert!(!permission_names.contains(&privileged));
        }
    }

    #[test]
    fn status_popup_capability_is_enabled_in_tauri_config() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
        let capabilities = config["app"]["security"]["capabilities"]
            .as_array()
            .expect("tauri app capabilities must be an array");

        assert!(capabilities.iter().any(|value| value == "status-popup"));
    }
}
