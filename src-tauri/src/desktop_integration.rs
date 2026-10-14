use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::Mutex,
    time::Duration,
};
use tauri::{AppHandle, Manager};

#[cfg(target_os = "linux")]
use std::{
    io::{Read, Write},
    os::unix::{
        fs::PermissionsExt,
        net::{UnixListener, UnixStream},
    },
    sync::atomic::{AtomicBool, Ordering},
};

const CONFIG_VERSION: u8 = 3;
const CONFIG_FILE: &str = "desktop-integration.json";
const AUTOSTART_FILE: &str = "BiBit.desktop";
const DEFAULT_GLOBAL_SHORTCUT: &str = "Super+B";
const SHORTCUT_BLOCK_START: &str = "<!-- bibit-global-shortcut:start -->";
const SHORTCUT_BLOCK_END: &str = "<!-- bibit-global-shortcut:end -->";
/// 全局快捷键拉起进程时携带的参数：直接开始一次语音录音。
const VOICE_LISTEN_ARG: &str = "--start-voice-listen";
#[cfg(target_os = "linux")]
const VOICE_LISTEN_SOCKET: &str = "bibit-voice-listen.sock";
#[cfg(target_os = "linux")]
static VOICE_LISTEN_LISTENER_STARTED: AtomicBool = AtomicBool::new(false);

pub const POPUP_MIN_WIDTH: i32 = 300;
pub const POPUP_MAX_WIDTH: i32 = 600;
pub const POPUP_MIN_HEIGHT: i32 = 400;
pub const POPUP_MAX_HEIGHT: i32 = 800;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PopupGeometryPreference {
    pub screen_index: usize,
    pub width: i32,
    pub height: i32,
    pub right_margin: i32,
    pub bottom_margin: i32,
}

impl Default for PopupGeometryPreference {
    fn default() -> Self {
        Self {
            screen_index: 0,
            width: 420,
            height: 600,
            right_margin: 16,
            bottom_margin: 8,
        }
    }
}

impl PopupGeometryPreference {
    fn validate(self) -> Result<Self, String> {
        if !(POPUP_MIN_WIDTH..=POPUP_MAX_WIDTH).contains(&self.width)
            || !(POPUP_MIN_HEIGHT..=POPUP_MAX_HEIGHT).contains(&self.height)
        {
            return Err(format!(
                "快速对话尺寸必须在 {POPUP_MIN_WIDTH}×{POPUP_MIN_HEIGHT} 到 {POPUP_MAX_WIDTH}×{POPUP_MAX_HEIGHT} 之间"
            ));
        }
        if self.right_margin < 0 || self.bottom_margin < 0 {
            return Err("快速对话位置不能为负数".to_owned());
        }
        Ok(self)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct VoiceBallPreference {
    pub screen_index: usize,
    pub right_margin: i32,
    pub bottom_margin: i32,
    pub visible: bool,
}

impl Default for VoiceBallPreference {
    fn default() -> Self {
        Self { screen_index: 0, right_margin: 16, bottom_margin: 16, visible: true }
    }
}

/// 浮窗相对悬浮球的偏移：球动，浮窗跟着动；球和浮窗不会同时显示，
/// 所以不需要同步事件——每次显示时按球的当前位置重算落点即可。
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct VoiceOverlayPreference {
    pub offset_x: i32,
    pub offset_y: i32,
}

impl Default for VoiceOverlayPreference {
    fn default() -> Self {
        // 默认：浮窗右下角贴住悬浮球右下角。
        Self {
            offset_x: -(crate::voice_overlay::VOICE_OVERLAY_WIDTH - crate::voice_overlay::VOICE_BALL_SIZE),
            offset_y: -(crate::voice_overlay::VOICE_OVERLAY_HEIGHT - crate::voice_overlay::VOICE_BALL_SIZE),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default)]
struct DesktopIntegrationConfig {
    version: u8,
    resident_enabled: bool,
    autostart_enabled: bool,
    global_shortcut: String,
    popup_geometry: PopupGeometryPreference,
    voice_ball: VoiceBallPreference,
    voice_overlay: VoiceOverlayPreference,
}

impl Default for DesktopIntegrationConfig {
    fn default() -> Self {
        Self {
            version: CONFIG_VERSION,
            resident_enabled: true,
            autostart_enabled: true,
            global_shortcut: DEFAULT_GLOBAL_SHORTCUT.to_owned(),
            popup_geometry: PopupGeometryPreference::default(),
            voice_ball: VoiceBallPreference::default(),
            voice_overlay: VoiceOverlayPreference::default(),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopIntegrationStatus {
    resident_enabled: bool,
    autostart_enabled: bool,
    autostart_registered: bool,
    global_shortcut: String,
    global_shortcut_registered: bool,
    popup_geometry: PopupGeometryPreference,
}

pub struct DesktopIntegrationState {
    config_path: PathBuf,
    autostart_path: PathBuf,
    labwc_config_path: PathBuf,
    executable: PathBuf,
    runtime_profile: Option<String>,
    config: Mutex<DesktopIntegrationConfig>,
}

impl DesktopIntegrationState {
    pub fn load(data_root: &Path) -> Result<Self, String> {
        let config_path = data_root.join(CONFIG_FILE);
        let mut config = match fs::read(&config_path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|error| format!("无法读取桌面集成设置：{error}"))?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                DesktopIntegrationConfig::default()
            }
            Err(error) => return Err(format!("无法读取桌面集成设置：{error}")),
        };
        config.version = CONFIG_VERSION;
        config.popup_geometry = config.popup_geometry.validate().unwrap_or_default();

        let config_home = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(dirs::config_dir)
            .ok_or_else(|| "无法确定用户配置目录".to_owned())?;
        let state = Self {
            config_path,
            autostart_path: config_home.join("autostart").join(AUTOSTART_FILE),
            labwc_config_path: config_home.join("labwc").join("rc.xml"),
            executable: std::env::current_exe()
                .map_err(|error| format!("无法确定 Bibit 程序路径：{error}"))?,
            runtime_profile: std::env::var("BIBIT_RUNTIME_PROFILE").ok(),
            config: Mutex::new(config),
        };

        if let Err(error) = state.reconcile_autostart() {
            log::warn!("desktop.autostart_reconcile_failed error={error}");
            state.config.lock().map_err(lock_error)?.autostart_enabled = false;
            state.remove_autostart()?;
        }
        if let Err(error) = state.reconcile_shortcut() {
            log::warn!("desktop.global_shortcut_reconcile_failed error={error}");
        }
        state.save()?;
        Ok(state)
    }

    pub fn resident_enabled(&self) -> bool {
        self.config
            .lock()
            .map(|config| config.resident_enabled)
            .unwrap_or(false)
    }

    pub fn voice_ball(&self) -> VoiceBallPreference {
        self.config.lock().map(|config| config.voice_ball).unwrap_or_default()
    }

    pub fn voice_overlay(&self) -> VoiceOverlayPreference {
        self.config.lock().map(|config| config.voice_overlay).unwrap_or_default()
    }

    pub fn update_voice_overlay(
        &self,
        preference: VoiceOverlayPreference,
        persist: bool,
    ) -> Result<(), String> {
        let old = self.voice_overlay();
        self.config.lock().map_err(lock_error)?.voice_overlay = preference;
        if persist {
            if let Err(error) = self.save() {
                self.config.lock().map_err(lock_error)?.voice_overlay = old;
                return Err(error);
            }
        }
        Ok(())
    }

    pub fn update_voice_ball(&self, preference: VoiceBallPreference, persist: bool) -> Result<(), String> {
        let old = self.voice_ball();
        self.config.lock().map_err(lock_error)?.voice_ball = preference;
        if persist {
            if let Err(error) = self.save() {
                self.config.lock().map_err(lock_error)?.voice_ball = old;
                return Err(error);
            }
        }
        Ok(())
    }

    pub fn popup_geometry(&self) -> PopupGeometryPreference {
        self.config
            .lock()
            .map(|config| config.popup_geometry)
            .unwrap_or_default()
    }

    pub fn update_popup_size(&self, width: i32, height: i32) -> Result<(), String> {
        let current = self.popup_geometry();
        let next = PopupGeometryPreference {
            width,
            height,
            ..current
        }
        .validate()?;
        if next == current {
            return Ok(());
        }
        self.replace_popup_geometry(next).map(|_| ())
    }

    pub fn update_popup_position(
        &self,
        screen_index: usize,
        right_margin: i32,
        bottom_margin: i32,
    ) -> Result<(), String> {
        let current = self.popup_geometry();
        let next = PopupGeometryPreference {
            screen_index,
            right_margin: right_margin.max(0),
            bottom_margin: bottom_margin.max(0),
            ..current
        };
        if next == current {
            return Ok(());
        }
        self.replace_popup_geometry(next).map(|_| ())
    }

    fn replace_popup_geometry(
        &self,
        geometry: PopupGeometryPreference,
    ) -> Result<PopupGeometryPreference, String> {
        let geometry = geometry.validate()?;
        let old = self.popup_geometry();
        self.config.lock().map_err(lock_error)?.popup_geometry = geometry;
        if let Err(error) = self.save() {
            self.config.lock().map_err(lock_error)?.popup_geometry = old;
            return Err(error);
        }
        Ok(old)
    }

    fn status(&self) -> Result<DesktopIntegrationStatus, String> {
        let config = self.config.lock().map_err(lock_error)?;
        Ok(DesktopIntegrationStatus {
            resident_enabled: config.resident_enabled,
            autostart_enabled: config.autostart_enabled,
            autostart_registered: self.autostart_path.is_file(),
            global_shortcut: config.global_shortcut.clone(),
            global_shortcut_registered: self.shortcut_registered(&config.global_shortcut),
            popup_geometry: config.popup_geometry,
        })
    }

    fn save(&self) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(&*self.config.lock().map_err(lock_error)?)
            .map_err(|error| format!("无法保存桌面集成设置：{error}"))?;
        atomic_write(&self.config_path, &bytes)
            .map_err(|error| format!("无法保存桌面集成设置：{error}"))
    }

    fn reconcile_autostart(&self) -> Result<(), String> {
        let config = self.config.lock().map_err(lock_error)?;
        if config.resident_enabled && config.autostart_enabled {
            self.write_autostart()
        } else {
            self.remove_autostart()
        }
    }

    fn write_autostart(&self) -> Result<(), String> {
        let exec = desktop_exec(&self.executable, self.runtime_profile.as_deref());
        let entry = format!(
            "[Desktop Entry]\nType=Application\nName=BiBit\nComment=BiBit desktop assistant\nExec={exec} --background\nTerminal=false\nX-GNOME-Autostart-enabled=true\nOnlyShowIn=LXQt;\n"
        );
        atomic_write(&self.autostart_path, entry.as_bytes())
            .map_err(|error| format!("无法登记开机自启动：{error}"))
    }

    fn remove_autostart(&self) -> Result<(), String> {
        match fs::remove_file(&self.autostart_path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("无法撤销开机自启动：{error}")),
        }
    }

    fn reconcile_shortcut(&self) -> Result<(), String> {
        let config = self.config.lock().map_err(lock_error)?.clone();
        if config.resident_enabled {
            self.apply_shortcut(&config.global_shortcut)
        } else {
            self.remove_shortcut()
        }
    }

    fn apply_shortcut(&self, shortcut: &str) -> Result<(), String> {
        let labwc_key = parse_shortcut(shortcut)?.labwc_key;
        let original = fs::read(&self.labwc_config_path)
            .map_err(|error| format!("无法读取 labwc 快捷键配置：{error}"))?;
        let source = String::from_utf8(original.clone())
            .map_err(|error| format!("labwc 快捷键配置不是有效 UTF-8：{error}"))?;
        let unmanaged = remove_managed_shortcut(&source)?;
        if find_keybinds(&unmanaged)
            .iter()
            .any(|existing| existing.eq_ignore_ascii_case(&labwc_key))
        {
            return Err(format!("快捷键 {shortcut} 已被系统占用"));
        }
        let updated = insert_managed_shortcut(
            &unmanaged,
            &labwc_key,
            &desktop_exec(&self.executable, self.runtime_profile.as_deref()),
        )?;
        self.write_and_reload_shortcut(&original, updated.as_bytes())
    }

    fn remove_shortcut(&self) -> Result<(), String> {
        let original = match fs::read(&self.labwc_config_path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(format!("无法读取 labwc 快捷键配置：{error}")),
        };
        let source = String::from_utf8(original.clone())
            .map_err(|error| format!("labwc 快捷键配置不是有效 UTF-8：{error}"))?;
        let updated = remove_managed_shortcut(&source)?;
        self.write_and_reload_shortcut(&original, updated.as_bytes())
    }

    fn write_and_reload_shortcut(&self, original: &[u8], updated: &[u8]) -> Result<(), String> {
        if original == updated {
            return Ok(());
        }
        atomic_write(&self.labwc_config_path, updated)
            .map_err(|error| format!("无法写入 labwc 快捷键配置：{error}"))?;
        if let Err(error) = reload_labwc() {
            let rollback = atomic_write(&self.labwc_config_path, original)
                .map_err(|rollback| format!("{error}；恢复旧配置失败：{rollback}"))
                .and_then(|_| {
                    reload_labwc()
                        .map_err(|rollback| format!("{error}；恢复旧快捷键后重载失败：{rollback}"))
                });
            return Err(rollback.err().unwrap_or(error));
        }
        Ok(())
    }

    fn shortcut_registered(&self, shortcut: &str) -> bool {
        let Ok(parsed) = parse_shortcut(shortcut) else {
            return false;
        };
        fs::read_to_string(&self.labwc_config_path)
            .ok()
            .is_some_and(|source| {
                managed_shortcut_block(&source).is_ok_and(|block| {
                    block.is_some_and(|block| {
                        find_keybinds(block)
                            .iter()
                            .any(|key| key.eq_ignore_ascii_case(&parsed.labwc_key))
                    })
                })
            })
    }
}

#[tauri::command]
pub fn desktop_integration_status(
    state: tauri::State<'_, DesktopIntegrationState>,
) -> Result<DesktopIntegrationStatus, String> {
    state.status()
}

#[tauri::command]
pub fn desktop_integration_set_autostart(
    enabled: bool,
    state: tauri::State<'_, DesktopIntegrationState>,
) -> Result<DesktopIntegrationStatus, String> {
    let old = state.config.lock().map_err(lock_error)?.clone();
    if enabled && !old.resident_enabled {
        return Err("请先启用 Bibit 驻留".to_owned());
    }

    if enabled {
        state.write_autostart()?;
    } else {
        state.remove_autostart()?;
    }
    state.config.lock().map_err(lock_error)?.autostart_enabled = enabled;
    if let Err(error) = state.save() {
        *state.config.lock().map_err(lock_error)? = old;
        let _ = state.reconcile_autostart();
        return Err(error);
    }
    state.status()
}

#[tauri::command]
pub fn desktop_integration_set_resident(
    enabled: bool,
    app: AppHandle,
    state: tauri::State<'_, DesktopIntegrationState>,
) -> Result<DesktopIntegrationStatus, String> {
    let old = state.config.lock().map_err(lock_error)?.clone();
    {
        let mut config = state.config.lock().map_err(lock_error)?;
        config.resident_enabled = enabled;
        if !enabled {
            config.autostart_enabled = false;
        }
    }
    if let Err(error) = state
        .reconcile_shortcut()
        .and_then(|_| state.reconcile_autostart())
        .and_then(|_| state.save())
    {
        *state.config.lock().map_err(lock_error)? = old;
        let _ = state.reconcile_shortcut();
        let _ = state.reconcile_autostart();
        return Err(error);
    }

    let status = state.status()?;
    if enabled && !old.resident_enabled {
        crate::start_resident_components(&app);
    } else if !enabled && old.resident_enabled {
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            app.exit(0);
        });
    }
    Ok(status)
}

#[tauri::command]
pub fn desktop_integration_set_global_shortcut(
    shortcut: String,
    state: tauri::State<'_, DesktopIntegrationState>,
) -> Result<DesktopIntegrationStatus, String> {
    let shortcut = parse_shortcut(&shortcut)?.display;
    let old = state.config.lock().map_err(lock_error)?.clone();
    if old.resident_enabled {
        state.apply_shortcut(&shortcut)?;
    }
    state.config.lock().map_err(lock_error)?.global_shortcut = shortcut;
    if let Err(error) = state.save() {
        *state.config.lock().map_err(lock_error)? = old;
        let _ = state.reconcile_shortcut();
        return Err(error);
    }
    state.status()
}

#[tauri::command]
pub fn desktop_integration_set_popup_geometry(
    screen_index: usize,
    width: i32,
    height: i32,
    right_margin: i32,
    bottom_margin: i32,
    app: AppHandle,
    state: tauri::State<'_, DesktopIntegrationState>,
) -> Result<DesktopIntegrationStatus, String> {
    let geometry = PopupGeometryPreference {
        screen_index,
        width,
        height,
        right_margin,
        bottom_margin,
    };
    let old = state.replace_popup_geometry(geometry)?;
    let controller = app.state::<crate::status_popup::StatusPopupController>();
    if let Err(error) = controller.apply_saved_geometry(&app) {
        let _ = state.replace_popup_geometry(old);
        let _ = controller.apply_saved_geometry(&app);
        return Err(error);
    }
    state.status()
}

pub fn started_in_background() -> bool {
    std::env::args_os().any(|arg| arg == "--background")
}

/// 本次进程是否由全局快捷键拉起（冷启动路径）。
pub fn started_for_voice_listen() -> bool {
    std::env::args_os().any(|arg| arg == VOICE_LISTEN_ARG)
}

/// 二次实例转发的 `argv` 里是否带全局快捷键参数。
pub fn requests_voice_listen(args: &[String]) -> bool {
    args.iter().any(|arg| arg == VOICE_LISTEN_ARG)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SingleInstanceAction {
    /// Background startup must never surface UI.
    Ignore,
    OpenMainWindow,
    /// 全局快捷键：打开语音浮窗并立即开始一次录音。
    StartVoiceListen,
}

/// 解析"二次实例启动"的命令行参数，决定应执行的单实例激活动作。
///
/// 入参是 single-instance 插件转发来的二次实例 `argv`，而非当前进程的启动参数，
/// 与 `started_in_background`/`started_for_voice_listen`（基于当前进程 `args_os`）用途不同。
pub(crate) fn single_instance_request(args: &[String]) -> SingleInstanceAction {
    // Background startup must never surface UI, even if extra flags are forwarded.
    if args.iter().any(|arg| arg == "--background") {
        return SingleInstanceAction::Ignore;
    }
    if requests_voice_listen(args) {
        return SingleInstanceAction::StartVoiceListen;
    }
    SingleInstanceAction::OpenMainWindow
}

#[cfg(target_os = "linux")]
fn voice_listen_socket_path() -> Option<PathBuf> {
    std::env::var_os("XDG_RUNTIME_DIR")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .map(|root| root.join(VOICE_LISTEN_SOCKET))
}

#[cfg(target_os = "linux")]
fn send_shortcut_request(path: &Path, payload: &[u8]) -> bool {
    UnixStream::connect(path)
        .and_then(|mut stream| stream.write_all(payload))
        .is_ok()
}

#[cfg(target_os = "linux")]
pub fn forward_voice_listen_to_running_instance() -> bool {
    started_for_voice_listen()
        && voice_listen_socket_path().is_some_and(|path| send_shortcut_request(&path, b"listen\n"))
}

#[cfg(target_os = "linux")]
pub fn start_voice_listen_shortcut_listener(app: AppHandle) {
    if VOICE_LISTEN_LISTENER_STARTED.swap(true, Ordering::AcqRel) {
        return;
    }
    let Some(path) = voice_listen_socket_path() else {
        VOICE_LISTEN_LISTENER_STARTED.store(false, Ordering::Release);
        log::warn!("voice_listen.ipc_unavailable reason=missing_xdg_runtime_dir");
        return;
    };
    // 探测只发 `probe`：别人已经在听时，这里不能顺手触发一次录音。
    if send_shortcut_request(&path, b"probe\n") {
        VOICE_LISTEN_LISTENER_STARTED.store(false, Ordering::Release);
        log::warn!("voice_listen.ipc_unavailable reason=listener_already_running");
        return;
    }
    if let Err(error) = fs::remove_file(&path) {
        if error.kind() != std::io::ErrorKind::NotFound {
            VOICE_LISTEN_LISTENER_STARTED.store(false, Ordering::Release);
            log::warn!("voice_listen.ipc_cleanup_failed error={error}");
            return;
        }
    }
    let listener = match UnixListener::bind(&path) {
        Ok(listener) => listener,
        Err(error) => {
            VOICE_LISTEN_LISTENER_STARTED.store(false, Ordering::Release);
            log::warn!("voice_listen.ipc_bind_failed error={error}");
            return;
        }
    };
    if let Err(error) = fs::set_permissions(&path, fs::Permissions::from_mode(0o600)) {
        log::warn!("voice_listen.ipc_permissions_failed error={error}");
    }
    std::thread::spawn(move || {
        log::info!("voice_listen.ipc_ready path={}", path.display());
        for connection in listener.incoming() {
            let Ok(mut stream) = connection else {
                break;
            };
            let mut request = [0_u8; 16];
            if stream
                .read(&mut request)
                .is_ok_and(|size| request[..size].starts_with(b"listen"))
            {
                if let Err(error) = crate::voice_overlay::open_for_voice_listen(&app) {
                    log::error!("voice_listen.ipc_activation_failed error={error}");
                }
            }
        }
        VOICE_LISTEN_LISTENER_STARTED.store(false, Ordering::Release);
        let _ = fs::remove_file(path);
    });
}

#[derive(Debug, PartialEq, Eq)]
struct ParsedShortcut {
    display: String,
    labwc_key: String,
}

fn parse_shortcut(value: &str) -> Result<ParsedShortcut, String> {
    let parts: Vec<_> = value
        .split('+')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect();
    if parts.len() < 2 {
        return Err("全局快捷键必须包含修饰键和一个按键".to_owned());
    }

    let mut modifiers = [false; 4];
    let mut key = None;
    for part in parts {
        let modifier = match part.to_ascii_lowercase().as_str() {
            "super" | "meta" | "win" => Some(0),
            "ctrl" | "control" => Some(1),
            "alt" => Some(2),
            "shift" => Some(3),
            _ => None,
        };
        if let Some(index) = modifier {
            if modifiers[index] {
                return Err(format!("快捷键包含重复修饰键：{part}"));
            }
            modifiers[index] = true;
        } else if key.replace(part).is_some() {
            return Err("全局快捷键只能包含一个普通按键".to_owned());
        }
    }
    let key = key.ok_or_else(|| "全局快捷键缺少普通按键".to_owned())?;
    let (display_key, labwc_key) = normalize_key(key)?;
    let names = ["Super", "Ctrl", "Alt", "Shift"];
    let codes = ["W", "C", "A", "S"];
    let mut display = Vec::new();
    let mut labwc = Vec::new();
    for index in 0..modifiers.len() {
        if modifiers[index] {
            display.push(names[index].to_owned());
            labwc.push(codes[index].to_owned());
        }
    }
    display.push(display_key);
    labwc.push(labwc_key);
    Ok(ParsedShortcut {
        display: display.join("+"),
        labwc_key: labwc.join("-"),
    })
}

fn normalize_key(key: &str) -> Result<(String, String), String> {
    if key.len() == 1 && key.as_bytes()[0].is_ascii_alphanumeric() {
        let upper = key.to_ascii_uppercase();
        return Ok((upper.clone(), upper.to_ascii_lowercase()));
    }
    let lower = key.to_ascii_lowercase();
    if let Some(number) = lower
        .strip_prefix('f')
        .and_then(|value| value.parse::<u8>().ok())
    {
        if (1..=12).contains(&number) {
            let name = format!("F{number}");
            return Ok((name.clone(), name));
        }
    }
    let normalized = match lower.as_str() {
        "space" => ("Space", "space"),
        "enter" | "return" => ("Enter", "Return"),
        "escape" | "esc" => ("Escape", "Escape"),
        "tab" => ("Tab", "Tab"),
        "left" => ("Left", "Left"),
        "right" => ("Right", "Right"),
        "up" => ("Up", "Up"),
        "down" => ("Down", "Down"),
        "home" => ("Home", "Home"),
        "end" => ("End", "End"),
        "pageup" => ("PageUp", "Page_Up"),
        "pagedown" => ("PageDown", "Page_Down"),
        "insert" => ("Insert", "Insert"),
        "delete" => ("Delete", "Delete"),
        "print" => ("Print", "Print"),
        _ => return Err(format!("不支持的快捷键按键：{key}")),
    };
    Ok((normalized.0.to_owned(), normalized.1.to_owned()))
}

fn managed_shortcut_block(source: &str) -> Result<Option<&str>, String> {
    let starts: Vec<_> = source.match_indices(SHORTCUT_BLOCK_START).collect();
    let ends: Vec<_> = source.match_indices(SHORTCUT_BLOCK_END).collect();
    match (starts.as_slice(), ends.as_slice()) {
        ([], []) => Ok(None),
        ([(start, _)], [(end, _)]) if start < end => {
            Ok(Some(&source[*start..*end + SHORTCUT_BLOCK_END.len()]))
        }
        _ => Err("labwc 配置中的 Bibit 快捷键标记不完整或重复".to_owned()),
    }
}

fn remove_managed_shortcut(source: &str) -> Result<String, String> {
    let Some(block) = managed_shortcut_block(source)? else {
        return Ok(source.to_owned());
    };
    let block_start = block.as_ptr() as usize - source.as_ptr() as usize;
    let line_start = source[..block_start]
        .rfind('\n')
        .map_or(0, |index| index + 1);
    let marker_end = block_start + block.len();
    let line_end = source[marker_end..]
        .find('\n')
        .map_or(source.len(), |index| marker_end + index + 1);
    let mut result = source.to_owned();
    result.replace_range(line_start..line_end, "");
    Ok(result)
}

fn insert_managed_shortcut(source: &str, labwc_key: &str, exec: &str) -> Result<String, String> {
    let closing_tag = source
        .rfind("</keyboard>")
        .ok_or_else(|| "labwc 配置缺少 </keyboard>".to_owned())?;
    let insert_at = source[..closing_tag]
        .rfind('\n')
        .map_or(closing_tag, |index| index + 1);
    let command = xml_text(&format!("{exec} {VOICE_LISTEN_ARG}"));
    let block = format!(
        "    {SHORTCUT_BLOCK_START}\n    <keybind key=\"{labwc_key}\">\n      <action name=\"Execute\">\n        <command>{command}</command>\n      </action>\n    </keybind>\n    {SHORTCUT_BLOCK_END}\n"
    );
    let mut updated = source.to_owned();
    updated.insert_str(insert_at, &block);
    Ok(updated)
}

fn find_keybinds(source: &str) -> Vec<String> {
    let without_comments = strip_xml_comments(source);
    let mut keys = Vec::new();
    let mut remaining = without_comments.as_str();
    while let Some(start) = remaining.find("<keybind") {
        remaining = &remaining[start + "<keybind".len()..];
        let Some(end) = remaining.find('>') else {
            break;
        };
        let tag = &remaining[..end];
        if let Some(value) = xml_attribute(tag, "key") {
            keys.push(value.to_owned());
        }
        remaining = &remaining[end + 1..];
    }
    keys
}

fn strip_xml_comments(source: &str) -> String {
    let mut result = String::new();
    let mut remaining = source;
    while let Some(start) = remaining.find("<!--") {
        result.push_str(&remaining[..start]);
        let Some(end) = remaining[start + 4..].find("-->") else {
            return result;
        };
        remaining = &remaining[start + 4 + end + 3..];
    }
    result.push_str(remaining);
    result
}

fn xml_attribute<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let start = tag.find(&format!("{name}="))? + name.len() + 1;
    let quote = tag.as_bytes().get(start).copied()?;
    if quote != b'\'' && quote != b'"' {
        return None;
    }
    let value = &tag[start + 1..];
    let end = value.as_bytes().iter().position(|byte| *byte == quote)?;
    Some(&value[..end])
}

fn xml_text(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn reload_labwc() -> Result<(), String> {
    let output = Command::new("labwc")
        .arg("-r")
        .output()
        .map_err(|error| format!("无法重载 labwc 快捷键：{error}"))?;
    if output.status.success() {
        return Ok(());
    }
    let detail = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    Err(if detail.is_empty() {
        format!("labwc 快捷键重载失败：{}", output.status)
    } else {
        format!("labwc 快捷键重载失败：{detail}")
    })
}

fn desktop_exec(executable: &Path, runtime_profile: Option<&str>) -> String {
    let executable = quote_desktop_arg(&executable.to_string_lossy());
    match runtime_profile {
        Some(profile) => format!(
            "env BIBIT_RUNTIME_PROFILE={} {executable}",
            quote_desktop_arg(profile)
        ),
        None => executable,
    }
}

fn quote_desktop_arg(value: &str) -> String {
    format!(
        "\"{}\"",
        value
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('`', "\\`")
            .replace('$', "\\$")
            .replace('%', "%%")
    )
}

fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| std::io::Error::other("目标文件缺少父目录"))?;
    fs::create_dir_all(parent)?;
    let temporary = path.with_extension("tmp");
    fs::write(&temporary, bytes)?;
    fs::rename(temporary, path)
}

fn lock_error<T>(_: std::sync::PoisonError<T>) -> String {
    "桌面集成状态锁已损坏".to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_enable_resident_and_autostart() {
        let config = DesktopIntegrationConfig::default();
        assert!(config.voice_ball.visible);
        assert_eq!((config.voice_ball.right_margin, config.voice_ball.bottom_margin), (16, 16));
        let old: DesktopIntegrationConfig = serde_json::from_str("{}").unwrap();
        assert!(old.voice_ball.visible);
        assert!(config.resident_enabled);
        assert!(config.autostart_enabled);
        assert_eq!(config.popup_geometry, PopupGeometryPreference::default());
    }

    #[test]
    fn desktop_exec_preserves_profile_and_escapes_fields() {
        let exec = desktop_exec(Path::new("/opt/Bi Bit/bibit-gui"), Some("bianbu"));
        assert_eq!(
            exec,
            "env BIBIT_RUNTIME_PROFILE=\"bianbu\" \"/opt/Bi Bit/bibit-gui\""
        );
        assert_eq!(quote_desktop_arg("a%b$c"), "\"a%%b\\$c\"");
    }

    #[test]
    fn atomic_write_replaces_existing_content() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("nested/settings.json");
        atomic_write(&path, b"first").unwrap();
        atomic_write(&path, b"second").unwrap();
        assert_eq!(fs::read(path).unwrap(), b"second");
    }

    #[test]
    fn autostart_registration_matches_saved_defaults() {
        let root = tempfile::tempdir().unwrap();
        let state = DesktopIntegrationState {
            config_path: root.path().join(CONFIG_FILE),
            autostart_path: root.path().join("autostart").join(AUTOSTART_FILE),
            labwc_config_path: root.path().join("labwc/rc.xml"),
            executable: PathBuf::from("/opt/bibit/bin/bibit-gui"),
            runtime_profile: Some("bianbu".to_owned()),
            config: Mutex::new(DesktopIntegrationConfig::default()),
        };

        state.reconcile_autostart().unwrap();
        state.save().unwrap();
        let status = state.status().unwrap();
        assert!(status.resident_enabled);
        assert!(status.autostart_enabled);
        assert!(status.autostart_registered);
        assert!(fs::read_to_string(state.autostart_path)
            .unwrap()
            .contains("BIBIT_RUNTIME_PROFILE=\"bianbu\""));
    }

    #[test]
    fn shortcut_parser_normalizes_supported_combinations() {
        assert_eq!(
            parse_shortcut(" shift + win + b ").unwrap(),
            ParsedShortcut {
                display: "Super+Shift+B".to_owned(),
                labwc_key: "W-S-b".to_owned(),
            }
        );
        assert_eq!(parse_shortcut("Ctrl+Alt+F4").unwrap().labwc_key, "C-A-F4");
        assert!(parse_shortcut("B").is_err());
        assert!(parse_shortcut("Super+B+C").is_err());
        assert!(parse_shortcut("Super+WheelUp").is_err());
    }

    #[test]
    fn managed_shortcut_replaces_only_bibit_block() {
        let source = "<labwc_config>\n  <keyboard>\n    <keybind key=\"W-p\"><action name=\"Execute\"/></keybind>\n  </keyboard>\n</labwc_config>\n";
        let with_bibit = insert_managed_shortcut(source, "W-b", "\"/opt/BiBit\"").unwrap();
        assert!(with_bibit.contains(SHORTCUT_BLOCK_START));
        assert!(with_bibit.contains("<keybind key=\"W-b\">"));
        assert!(with_bibit.contains(&format!(
            "<command>\"/opt/BiBit\" {VOICE_LISTEN_ARG}</command>"
        )));
        assert_eq!(find_keybinds(&with_bibit), vec!["W-p", "W-b"]);
        assert_eq!(remove_managed_shortcut(&with_bibit).unwrap(), source);
    }

    #[test]
    fn conflict_scan_ignores_comments_and_managed_binding() {
        let source = format!(
            "<keyboard>\n<!-- <keybind key=\"W-b\"/> -->\n{SHORTCUT_BLOCK_START}\n<keybind key='W-b'/>\n{SHORTCUT_BLOCK_END}\n<keybind key=\"W-p\"/>\n</keyboard>"
        );
        let unmanaged = remove_managed_shortcut(&source).unwrap();
        assert_eq!(find_keybinds(&unmanaged), vec!["W-p"]);
    }

    #[test]
    fn voice_listen_argument_is_detected_without_matching_other_flags() {
        assert!(requests_voice_listen(&[
            "/opt/bibit-gui".to_owned(),
            VOICE_LISTEN_ARG.to_owned(),
        ]));
        assert!(!requests_voice_listen(&[
            "/opt/bibit-gui".to_owned(),
            "--background".to_owned(),
        ]));
    }

    #[test]
    fn secondary_instance_requests_follow_launch_mode() {
        let executable = "/opt/bibit-gui".to_owned();
        assert_eq!(
            single_instance_request(std::slice::from_ref(&executable)),
            SingleInstanceAction::OpenMainWindow
        );
        assert_eq!(
            single_instance_request(&[executable.clone(), "--background".to_owned()]),
            SingleInstanceAction::Ignore
        );
        assert_eq!(
            single_instance_request(&[
                executable.clone(),
                "--background".to_owned(),
                VOICE_LISTEN_ARG.to_owned()
            ]),
            SingleInstanceAction::Ignore
        );
        assert_eq!(
            single_instance_request(&[executable.clone(), VOICE_LISTEN_ARG.to_owned()]),
            SingleInstanceAction::StartVoiceListen
        );
        // 未知 flag 时回退为打开主窗口。
        assert_eq!(
            single_instance_request(&[executable, "--unexpected".to_owned()]),
            SingleInstanceAction::OpenMainWindow
        );
    }

    #[test]
    fn popup_geometry_rejects_values_outside_product_bounds() {
        let default = PopupGeometryPreference::default();
        assert!(PopupGeometryPreference {
            width: 299,
            ..default
        }
        .validate()
        .is_err());
        assert!(PopupGeometryPreference {
            height: 801,
            ..default
        }
        .validate()
        .is_err());
        assert!(PopupGeometryPreference {
            right_margin: -1,
            ..default
        }
        .validate()
        .is_err());
        assert!(PopupGeometryPreference {
            width: 600,
            height: 800,
            ..default
        }
        .validate()
        .is_ok());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn shortcut_request_distinguishes_listen_from_probe() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join(VOICE_LISTEN_SOCKET);
        let listener = UnixListener::bind(&path).unwrap();
        let receiver = std::thread::spawn(move || {
            let mut payloads = Vec::new();
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = String::new();
                stream.read_to_string(&mut request).unwrap();
                payloads.push(request);
            }
            payloads
        });
        assert!(send_shortcut_request(&path, b"probe\n"));
        assert!(send_shortcut_request(&path, b"listen\n"));
        assert_eq!(receiver.join().unwrap(), vec!["probe\n", "listen\n"]);
    }
}
