use super::{controller::StatusPopupController, placement::Point};
use tauri::Manager;

#[tauri::command]
pub fn show_status_popup(
    app: tauri::AppHandle,
    controller: tauri::State<'_, StatusPopupController>,
) -> Result<(), String> {
    controller.dispatch_activation(app, None)
}

#[tauri::command]
pub fn hide_status_popup(
    app: tauri::AppHandle,
    controller: tauri::State<'_, StatusPopupController>,
) -> Result<(), String> {
    controller.hide(&app, false)
}

#[tauri::command]
pub fn minimize_status_popup(
    app: tauri::AppHandle,
    controller: tauri::State<'_, StatusPopupController>,
) -> Result<(), String> {
    controller.minimize(&app)
}

#[tauri::command]
pub fn open_main_window(app: tauri::AppHandle) -> Result<(), String> {
    let controller = app.state::<StatusPopupController>();
    controller.hide(&app, false)?;
    StatusPopupController::open_main(&app)
}

pub fn dispatch_tray_activation(app: tauri::AppHandle, ref_pos: Option<Point>) {
    let controller = app.state::<StatusPopupController>();
    if let Err(error) = controller.dispatch_activation(app.clone(), ref_pos) {
        log::error!("popup.tray_activation_failed error={error}");
    }
}
