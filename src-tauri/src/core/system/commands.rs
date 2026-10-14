use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Runtime};

use crate::core::app::commands::get_jan_data_folder_path;

#[tauri::command]
pub fn relaunch<R: Runtime>(app: AppHandle<R>) {
    app.restart()
}

#[tauri::command]
pub fn open_app_directory<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let app_path = get_jan_data_folder_path(app.clone());
    let program = "xdg-open";
    std::process::Command::new(program)
        .arg(app_path)
        .status()
        .map_err(|e| format!("Failed to open app directory: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn open_file_explorer(path: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    let (program, arg): (&str, std::ffi::OsString) = ("xdg-open", path.into());
    std::process::Command::new(program)
        .arg(arg)
        .status()
        .map_err(|e| format!("Failed to open file explorer: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn read_logs<R: Runtime>(app: AppHandle<R>) -> Result<String, String> {
    let log_path = get_jan_data_folder_path(app).join("logs").join("app.log");
    if log_path.exists() {
        let content = fs::read_to_string(log_path).map_err(|e| e.to_string())?;
        Ok(content)
    } else {
        Err("Log file not found".to_string())
    }
}

// check if a system library is available
#[tauri::command]
pub fn is_library_available(library: &str) -> bool {
    match unsafe { libloading::Library::new(library) } {
        Ok(_) => true,
        Err(e) => {
            log::info!("Library {library} is not available: {e}");
            false
        }
    }
}
