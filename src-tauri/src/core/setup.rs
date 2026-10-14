use std::{
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::{App, AppHandle, Emitter, Listener, Manager, Runtime, WindowEvent, Wry};

#[cfg(feature = "desktop")]
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
};
use tauri_plugin_store::Store;

use crate::core::app::commands::get_jan_data_folder_path;
use crate::core::mcp::constants::DEFAULT_MCP_CONFIG;
use crate::core::mcp::helpers::add_server_config;

use super::{mcp::helpers::run_mcp_commands, state::AppState};

static APP_READY: AtomicBool = AtomicBool::new(false);

// Migrate MCP servers configuration
pub fn migrate_mcp_servers(
    app_handle: tauri::AppHandle,
    store: Arc<Store<Wry>>,
) -> Result<(), String> {
    let mcp_version = store
        .get("mcp_version")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    if mcp_version < 1 {
        log::info!("Migrating MCP schema version 1");
        let result = add_server_config(
            app_handle.clone(),
            "exa".to_string(),
            serde_json::json!({
                  "command": "npx",
                  "args": ["-y", "exa-mcp-server"],
                  "env": { "EXA_API_KEY": "YOUR_EXA_API_KEY_HERE" },
                  "active": false
            }),
        );
        if let Err(e) = result {
            log::error!("Failed to add server config: {e}");
        }
    }
    // Schema version 2 seeded the Jan Browser MCP server; that feature is gone,
    // so the version number is retired rather than reused.
    if mcp_version < 3 {
        log::info!("Migrating MCP schema version 3: Updating Exa to streamable HTTP");
        if let Err(e) = migrate_exa_to_http(app_handle.clone()) {
            log::error!("Failed to migrate Exa to HTTP: {e}");
        }
    }
    if mcp_version < 4 {
        log::info!(
            "Migrating MCP schema version 4: Removing default Exa MCP (native web search cutover)"
        );
        if let Err(e) = remove_exa_server(app_handle) {
            log::error!("Failed to remove Exa MCP server: {e}");
        }
    }
    store.set("mcp_version", 4);
    store.save().expect("Failed to save store");
    Ok(())
}

fn migrate_exa_to_http(app_handle: tauri::AppHandle) -> Result<(), String> {
    let config_path = get_jan_data_folder_path(app_handle).join("mcp_config.json");

    let config_str =
        fs::read_to_string(&config_path).map_err(|e| format!("Failed to read MCP config: {e}"))?;

    let mut config: serde_json::Value = serde_json::from_str(&config_str)
        .map_err(|e| format!("Failed to parse MCP config: {e}"))?;

    if let Some(servers) = config.get_mut("mcpServers").and_then(|s| s.as_object_mut()) {
        servers.insert(
            "exa".to_string(),
            serde_json::json!({
                "type": "http",
                "url": "https://mcp.exa.ai/mcp".to_string(),
                "command": "",
                "args": [],
                "env": {},
                "active": true
            }),
        );
    }

    fs::write(
        &config_path,
        serde_json::to_string_pretty(&config)
            .map_err(|e| format!("Failed to serialize MCP config: {e}"))?,
    )
    .map_err(|e| format!("Failed to write MCP config: {e}"))?;

    Ok(())
}

/// One-time cutover to native web search: drop the default Exa MCP server so the
/// built-in web_search/web_fetch tools own web search. Only removes the entry if
/// it is still the inactive default (hosted HTTP endpoint, no API key); a user who
/// activated it or supplied their own key keeps their configuration.
fn remove_exa_server(app_handle: tauri::AppHandle) -> Result<(), String> {
    let config_path = get_jan_data_folder_path(app_handle).join("mcp_config.json");
    if !config_path.exists() {
        return Ok(());
    }
    let config_str =
        fs::read_to_string(&config_path).map_err(|e| format!("Failed to read MCP config: {e}"))?;
    let mut config: serde_json::Value = serde_json::from_str(&config_str)
        .map_err(|e| format!("Failed to parse MCP config: {e}"))?;

    let Some(servers) = config.get_mut("mcpServers").and_then(|s| s.as_object_mut()) else {
        return Ok(());
    };

    let is_default_exa = servers
        .get("exa")
        .and_then(|exa| exa.as_object())
        .map(|exa| {
            let inactive = exa.get("active").and_then(|v| v.as_bool()) != Some(true);
            let no_key = exa
                .get("env")
                .and_then(|env| env.as_object())
                .map(|env| env.is_empty())
                .unwrap_or(true);
            inactive && no_key
        })
        .unwrap_or(false);

    if is_default_exa {
        servers.remove("exa");
        fs::write(
            &config_path,
            serde_json::to_string_pretty(&config)
                .map_err(|e| format!("Failed to serialize MCP config: {e}"))?,
        )
        .map_err(|e| format!("Failed to write MCP config: {e}"))?;
    }
    Ok(())
}

/// Resolve when the frontend emits `app-ready`, or after `timeout` (so a window
/// that never signals still proceeds).
pub(crate) async fn wait_for_app_ready<R: Runtime>(app: &AppHandle<R>, timeout: Duration) {
    // 首帧信号一辈子只发一次。运行时才打开常驻的路径（设置页开关）早就过了首帧，
    // 那时再监听只会白等满超时，还打出一条会误导排查的日志。
    if APP_READY.load(Ordering::SeqCst) {
        return;
    }
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    let handler = app.once_any("app-ready", move |_| {
        APP_READY.store(true, Ordering::SeqCst);
        let _ = tx.send(());
    });
    if tokio::time::timeout(timeout, rx).await.is_err() {
        log::info!("app-ready not received within {timeout:?}; starting MCP servers anyway");
        app.unlisten(handler);
    }
}

pub fn setup_mcp<R: Runtime>(app: &App<R>) {
    let state = app.state::<AppState>();
    let servers = state.mcp_servers.clone();
    let app_handle = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        use crate::core::mcp::lockfile::cleanup_all_stale_locks;

        // Defer past first paint so npx/uvx spawns don't starve cold start.
        wait_for_app_ready(&app_handle, Duration::from_secs(30)).await;

        // Create default mcp_config.json if it doesn't exist
        let config_path = get_jan_data_folder_path(app_handle.clone()).join("mcp_config.json");
        if !config_path.exists() {
            log::info!("mcp_config.json not found, creating default config");
            if let Err(e) = fs::write(&config_path, DEFAULT_MCP_CONFIG) {
                log::error!("Failed to create default MCP config: {e}");
            }
        }

        if let Err(e) = cleanup_all_stale_locks(&app_handle).await {
            log::debug!("Lock file cleanup error: {}", e);
        }

        if let Err(e) = run_mcp_commands(&app_handle, servers).await {
            log::error!("Failed to run mcp commands: {e}");
        }
        if let Err(e) = app_handle.emit("mcp-update", "MCP servers updated") {
            log::warn!("Failed to emit mcp-update event: {e}");
        }
    });
}

#[cfg(feature = "desktop")]
pub fn tray_icon() -> tauri::image::Image<'static> {
    tauri::image::Image::new(include_bytes!("../../static/tray-icon.rgba"), 64, 64)
}

#[cfg(feature = "desktop")]
pub fn tray_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let labels = crate::core::native_text::current();
    let toggle_voice_ball_i = MenuItem::with_id(
        app,
        "toggle_voice_ball",
        labels.toggle_voice_ball,
        true,
        None::<&str>,
    )?;
    let show_i = MenuItem::with_id(app, "open", labels.open_main, true, None::<&str>)?;
    let quit_i = MenuItem::with_id(app, "quit", labels.quit, true, None::<&str>)?;
    let separator_i = PredefinedMenuItem::separator(app)?;
    Menu::with_items(app, &[&toggle_voice_ball_i, &show_i, &separator_i, &quit_i])
}

#[cfg(feature = "desktop")]
pub fn setup_tauri_tray(app: &AppHandle, tray_id: &str) -> tauri::Result<TrayIcon> {
    let menu = tray_menu(app)?;
    TrayIconBuilder::with_id(tray_id.to_owned())
        .icon(tray_icon())
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| match event {
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } => {
                let app = tray.app_handle();
                if let Err(error) = crate::voice_overlay::open_from_tray(app) {
                    log::error!("voice_overlay.fallback_activation_failed error={error}");
                }
            }
            _ => {
                log::debug!("unhandled event {event:?}");
            }
        })
        .on_menu_event(|app, event| match event.id.as_ref() {
            "toggle_voice_ball" => {
                if let Err(error) = crate::voice_overlay::toggle_ball(app) {
                    log::error!("voice_ball.fallback_toggle_failed error={error}");
                }
            }
            "open" => {
                let controller = app.state::<crate::status_popup::StatusPopupController>();
                let _ = controller.hide(app, false);
                if let Err(error) = crate::status_popup::StatusPopupController::open_main(app) {
                    log::error!("popup.fallback_open_main_failed error={error}");
                }
            }
            "quit" => {
                app.exit(0);
            }
            other => {
                println!("menu item {other} not handled");
            }
        })
        .build(app)
}

pub fn setup_theme_listener<R: Runtime>(app: &App<R>) -> tauri::Result<()> {
    // Setup GTK window theme listener for main window
    if let Some(window) = app.get_webview_window("main") {
        setup_window_theme_listener(app.handle().clone(), window);
    }

    // Resolve the persisted user choice before any window paints, so every
    // surface starts from the authority instead of waiting for a webview to
    // report its own idea of the theme. An explicit choice is known
    // synchronously; `auto` needs the portal read, which is async.
    let theme_app = app.handle().clone();
    let stored_mode = persisted_theme_mode();
    if stored_mode == "auto" {
        tauri::async_runtime::spawn(async move {
            let resolved = resolve_theme(&theme_app, "auto").await;
            let payload = commit_theme(&theme_app, "auto", resolved);
            log::info!(
                "app theme: mode={} resolved={} revision={} (startup)",
                payload.mode,
                payload.resolved,
                payload.revision
            );
        });
    } else {
        let resolved = if stored_mode == "dark" { "dark" } else { "light" };
        let payload = commit_theme(&theme_app, &stored_mode, resolved);
        log::info!(
            "app theme: mode={} resolved={} revision={} (startup)",
            payload.mode,
            payload.resolved,
            payload.revision
        );
    }

    // On Linux, also listen to XDG Desktop Portal color-scheme changes via D-Bus.
    // This is needed because KDE Plasma and some other desktop environments
    // don't always update GTK settings when the system theme changes,
    // which means the GTK WindowEvent::ThemeChanged may never fire.
    #[cfg(target_os = "linux")]
    {
        let app_handle = app.handle().clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = setup_xdg_portal_theme_listener(app_handle).await {
                log::warn!("Failed to setup XDG Desktop Portal theme listener: {e}");
                log::warn!("System theme changes from KDE/non-GNOME DEs may not be detected");
            }
        });
    }

    Ok(())
}

/// Read the current XDG Desktop Portal `org.freedesktop.appearance/color-scheme`
/// setting. Returns "dark", "light", or `None` if the portal reports no preference
/// or is unavailable.
#[cfg(target_os = "linux")]
async fn read_xdg_portal_color_scheme(
) -> Result<Option<&'static str>, Box<dyn std::error::Error + Send + Sync>> {
    use zbus::Connection;

    let connection = Connection::session().await?;
    let proxy: zbus::Proxy<'_> = zbus::proxy::Builder::new(&connection)
        .destination("org.freedesktop.portal.Desktop")?
        .path("/org/freedesktop/portal/desktop")?
        .interface("org.freedesktop.portal.Settings")?
        .build()
        .await?;

    let reply: zbus::zvariant::OwnedValue = proxy
        .call("Read", &("org.freedesktop.appearance", "color-scheme"))
        .await?;

    let inner: zbus::zvariant::OwnedValue = match reply.downcast_ref::<zbus::zvariant::Value>() {
        Ok(v) => v.try_to_owned()?,
        Err(_) => reply,
    };
    let color_scheme = u32::try_from(inner).unwrap_or(0);
    // GNOME emits 0 ("no preference") for light, 1 for dark, 2 for explicit
    // light (rare). Treat 0 and 2 as light so light↔dark toggles work on both
    // GNOME and KDE/freedesktop-compliant DEs.
    Ok(match color_scheme {
        1 => Some("dark"),
        _ => Some("light"),
    })
}

/// Window-control placement split by side. Values are `"minimize"`,
/// `"maximize"`, `"close"`; the borderless frontend renders its own buttons in
/// this order so they match the desktop's configured layout.
#[derive(serde::Serialize)]
pub struct TitlebarLayout {
    pub left: Vec<String>,
    pub right: Vec<String>,
}

impl Default for TitlebarLayout {
    fn default() -> Self {
        TitlebarLayout {
            left: vec![],
            right: vec![
                "minimize".to_string(),
                "maximize".to_string(),
                "close".to_string(),
            ],
        }
    }
}

/// Which desktop owns the window-button layout. Only that desktop's own
/// setting may be applied to the borderless titlebar.
#[cfg(target_os = "linux")]
#[derive(Debug, PartialEq, Eq)]
enum ButtonLayoutSource {
    Kde,
    Gnome,
    Default,
}

#[cfg(target_os = "linux")]
fn button_layout_source(desktop: &str) -> ButtonLayoutSource {
    let is = |name: &str| desktop.split(':').any(|d| d.eq_ignore_ascii_case(name));
    if is("KDE") {
        ButtonLayoutSource::Kde
    } else if is("GNOME") {
        ButtonLayoutSource::Gnome
    } else {
        ButtonLayoutSource::Default
    }
}

/// Read the desktop's window-button layout so the borderless titlebar can place
/// min/max/close on the side the user configured (KDE `kwinrc`, GNOME gsettings).
/// Falls back to all-on-the-right on non-Linux or when the config is unreadable.
#[tauri::command]
pub fn get_titlebar_layout() -> TitlebarLayout {
    #[cfg(target_os = "linux")]
    {
        let desktop = std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default();
        // Reading a desktop's config on a session it does not own leaks that
        // desktop's defaults into the titlebar: on Bianbu (`LXQt:labwc:wlroots`)
        // GNOME's `appmenu:close` dropped minimize/maximize entirely.
        // ponytail: no labwc reader yet; LXQt/labwc sessions keep the default
        // layout. Add one reading rc.xml `<theme><titleLayout>` if users ask.
        let layout = match button_layout_source(&desktop) {
            ButtonLayoutSource::Kde => read_kde_button_layout(),
            ButtonLayoutSource::Gnome => read_gnome_button_layout(),
            ButtonLayoutSource::Default => None,
        };
        if let Some(layout) = layout {
            return layout;
        }
    }
    TitlebarLayout::default()
}

/// Parse `~/.config/kwinrc` `[org.kde.kdecoration2]` button codes
/// (`I`=minimize, `A`=maximize, `X`=close; others ignored). Defaults match
/// KDE's own (`MS` left / `IAX` right) when the keys are absent.
#[cfg(target_os = "linux")]
fn read_kde_button_layout() -> Option<TitlebarLayout> {
    let home = std::env::var("HOME").ok()?;
    let content =
        fs::read_to_string(PathBuf::from(home).join(".config/kwinrc")).unwrap_or_default();

    let mut left = "MS".to_string();
    let mut right = "IAX".to_string();
    let mut in_section = false;
    for line in content.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_section = line == "[org.kde.kdecoration2]";
        } else if in_section {
            if let Some(v) = line.strip_prefix("ButtonsOnLeft=") {
                left = v.trim().to_string();
            } else if let Some(v) = line.strip_prefix("ButtonsOnRight=") {
                right = v.trim().to_string();
            }
        }
    }

    let codes = |s: &str| -> Vec<String> {
        s.chars()
            .filter_map(|c| match c {
                'I' => Some("minimize".to_string()),
                'A' => Some("maximize".to_string()),
                'X' => Some("close".to_string()),
                _ => None,
            })
            .collect()
    };
    Some(TitlebarLayout {
        left: codes(&left),
        right: codes(&right),
    })
}

/// Read GNOME's `button-layout` (`"appmenu:minimize,maximize,close"`); the side
/// before `:` is the left cluster. Unknown tokens (appmenu/icon/spacer) ignored.
#[cfg(target_os = "linux")]
fn read_gnome_button_layout() -> Option<TitlebarLayout> {
    let output = std::process::Command::new("gsettings")
        .args(["get", "org.gnome.desktop.wm.preferences", "button-layout"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let raw = String::from_utf8_lossy(&output.stdout);
    let raw = raw.trim().trim_matches('\'');
    let (left, right) = raw.split_once(':').unwrap_or(("", raw));

    let tokens = |s: &str| -> Vec<String> {
        s.split(',')
            .filter_map(|t| match t.trim() {
                "minimize" => Some("minimize".to_string()),
                "maximize" => Some("maximize".to_string()),
                "close" => Some("close".to_string()),
                _ => None,
            })
            .collect()
    };
    Some(TitlebarLayout {
        left: tokens(left),
        right: tokens(right),
    })
}

/// The app's effective theme. `mode` is the user's choice
/// (`auto` | `light` | `dark`), `resolved` is what every surface paints, and
/// `revision` advances only when the effective theme really changes so
/// subscribers can drop stale or non-authoritative broadcasts.
#[derive(Clone, serde::Serialize)]
pub struct AppTheme {
    pub mode: String,
    pub resolved: String,
    pub revision: u64,
}

/// Single source of truth for theming. Webviews, GTK surfaces, window themes
/// and the persisted settings blob all derive from this; nothing else decides
/// what the app theme is.
#[derive(Clone)]
struct ThemeAuthority {
    mode: String,
    resolved: String,
    revision: u64,
    /// Set while our own GTK/window writes are settling. GTK reports those
    /// writes back as `WindowEvent::ThemeChanged`, and they must not be taken
    /// for a desktop theme change (that would re-resolve in a loop).
    suppress_system_events_until: Option<std::time::Instant>,
}

/// Settings key holding the persisted user choice. The blob keeps the shape the
/// webview stores used: `{"state":{"activeTheme":…,"isDark":…},"version":0}`.
pub const THEME_SETTINGS_KEY: &str = "theme";
/// Broadcast of the authoritative theme to every window.
pub const APP_THEME_EVENT: &str = "app-theme-changed";
/// How long our own theme writes suppress system-event re-resolution.
const THEME_SELF_TRIGGER_WINDOW: Duration = Duration::from_millis(600);

static APP_THEME: std::sync::OnceLock<std::sync::Mutex<ThemeAuthority>> =
    std::sync::OnceLock::new();

fn theme_authority() -> &'static std::sync::Mutex<ThemeAuthority> {
    APP_THEME.get_or_init(|| {
        std::sync::Mutex::new(ThemeAuthority {
            mode: "auto".to_string(),
            resolved: "light".to_string(),
            revision: 0,
            suppress_system_events_until: None,
        })
    })
}

fn theme_snapshot() -> AppTheme {
    match theme_authority().lock() {
        Ok(authority) => AppTheme {
            mode: authority.mode.clone(),
            resolved: authority.resolved.clone(),
            revision: authority.revision,
        },
        Err(_) => AppTheme {
            mode: "auto".to_string(),
            resolved: "light".to_string(),
            revision: 0,
        },
    }
}

fn theme_mode() -> String {
    theme_snapshot().mode
}

fn theme_resolved() -> String {
    theme_snapshot().resolved
}

/// Theme every window created from now on must start with: windows are painted
/// from the same resolved value instead of guessing from the desktop.
pub fn current_window_theme() -> Option<tauri::Theme> {
    Some(match theme_resolved().as_str() {
        "dark" => tauri::Theme::Dark,
        _ => tauri::Theme::Light,
    })
}

fn suppress_system_theme_events() {
    if let Ok(mut authority) = theme_authority().lock() {
        authority.suppress_system_events_until =
            Some(std::time::Instant::now() + THEME_SELF_TRIGGER_WINDOW);
    }
}

fn system_theme_events_suppressed() -> bool {
    match theme_authority().lock() {
        Ok(authority) => authority
            .suppress_system_events_until
            .is_some_and(|until| std::time::Instant::now() < until),
        Err(_) => false,
    }
}

fn normalize_theme_mode(mode: &str) -> String {
    match mode {
        "light" | "dark" => mode.to_string(),
        _ => "auto".to_string(),
    }
}

/// The user's persisted choice, read from the backend settings store. Only
/// [`persist_theme_mode`] writes that key, so a webview that never hydrated
/// cannot hand its default back to disk.
fn persisted_theme_mode() -> String {
    parse_persisted_theme_mode(crate::core::app::settings_store::settings_get(
        THEME_SETTINGS_KEY.to_string(),
    ))
}

/// Read the user's choice out of the persisted store blob. Unknown or missing
/// values mean `auto`, which keeps first launch and legacy blobs working.
fn parse_persisted_theme_mode(blob: Option<String>) -> String {
    blob.and_then(|blob| serde_json::from_str::<serde_json::Value>(&blob).ok())
        .and_then(|value| {
            value
                .get("state")
                .and_then(|state| state.get("activeTheme"))
                .and_then(|mode| mode.as_str())
                .map(normalize_theme_mode)
        })
        .unwrap_or_else(|| "auto".to_string())
}

/// Serialize the persisted choice in the blob shape the webview stores read.
fn theme_settings_blob(mode: &str, resolved: &str) -> String {
    serde_json::json!({
        "state": { "activeTheme": mode, "isDark": resolved == "dark" },
        "version": 0,
    })
    .to_string()
}

fn persist_theme_mode(mode: &str, resolved: &str) -> Result<(), String> {
    crate::core::app::settings_store::settings_set(
        THEME_SETTINGS_KEY.to_string(),
        theme_settings_blob(mode, resolved),
    )
}

/// The desktop's own theme name, captured before BiBit first overrode it, so
/// `auto` can hand the user's desktop choice back.
#[cfg(target_os = "linux")]
static GTK_SYSTEM_THEME_NAME: std::sync::OnceLock<std::sync::Mutex<Option<String>>> =
    std::sync::OnceLock::new();

/// True when the theme has a `-dark` sibling that GTK can actually load.
/// Pointing `gtk-theme-name` at a missing theme silently falls back to a
/// default theme, so in that case we only flip the prefer-dark flag.
#[cfg(target_os = "linux")]
fn gtk_dark_variant_exists(base: &str) -> bool {
    let mut candidates = vec![
        format!("/usr/share/themes/{base}-dark/gtk-3.0/gtk.css"),
        format!("/usr/local/share/themes/{base}-dark/gtk-3.0/gtk.css"),
    ];
    if let Ok(home) = std::env::var("HOME") {
        candidates.push(format!("{home}/.themes/{base}-dark/gtk-3.0/gtk.css"));
        candidates.push(format!("{home}/.local/share/themes/{base}-dark/gtk-3.0/gtk.css"));
    }
    candidates
        .iter()
        .any(|candidate| std::path::Path::new(candidate).is_file())
}

/// Drive the surfaces page CSS cannot reach: GTK's own widgets (native
/// `<select>` popups, file choosers) and the overlay scrollbars WebKitGTK
/// paints from the GTK theme. GTK objects are not `Send`, so this bounces onto
/// the GTK main thread.
#[cfg(target_os = "linux")]
fn apply_gtk_theme(dark: bool, explicit: bool) {
    use gtk::prelude::*;

    gtk::glib::MainContext::default().invoke(move || {
        let Some(settings) = gtk::Settings::default() else {
            return;
        };

        let slot = GTK_SYSTEM_THEME_NAME.get_or_init(|| std::sync::Mutex::new(None));
        let system_name = {
            let mut stored = match slot.lock() {
                Ok(stored) => stored,
                Err(_) => return,
            };
            let current = settings
                .gtk_theme_name()
                .map(|name| name.to_string())
                .unwrap_or_default();
            if stored.is_none() && !current.is_empty() {
                *stored = Some(current);
            }
            stored.clone().unwrap_or_default()
        };

        settings.set_gtk_application_prefer_dark_theme(dark);

        if !explicit {
            // `auto`: hand the theme name back to the desktop; the flag above
            // already mirrors the system preference.
            if !system_name.is_empty() {
                settings.set_gtk_theme_name(Some(&system_name));
            }
            return;
        }

        let base = match system_name.strip_suffix("-dark") {
            Some(base) if !base.is_empty() => base.to_string(),
            _ if system_name.is_empty() => "Adwaita".to_string(),
            _ => system_name.clone(),
        };

        let target = if dark {
            let dark_name = format!("{base}-dark");
            if !gtk_dark_variant_exists(&base) && !system_name.eq_ignore_ascii_case(&dark_name) {
                log::warn!(
                    "app theme: GTK theme '{base}' has no -dark variant; native popups keep the desktop theme"
                );
                return;
            }
            dark_name
        } else {
            base
        };

        settings.set_gtk_theme_name(Some(&target));
    });
}

#[cfg(not(target_os = "linux"))]
fn apply_gtk_theme(_dark: bool, _explicit: bool) {}

/// Resolve `auto` against the desktop; explicit choices pass through.
async fn resolve_theme<R: Runtime>(app: &tauri::AppHandle<R>, mode: &str) -> &'static str {
    match mode {
        "dark" => return "dark",
        "light" => return "light",
        _ => {}
    }

    #[cfg(target_os = "linux")]
    {
        match read_xdg_portal_color_scheme().await {
            Ok(Some(theme)) => return if theme == "dark" { "dark" } else { "light" },
            Ok(None) => {}
            Err(e) => log::warn!("app theme: portal read failed: {e}"),
        }
    }

    if let Some(window) = app.get_webview_window("main") {
        if let Ok(theme) = window.theme() {
            return match theme {
                tauri::Theme::Dark => "dark",
                _ => "light",
            };
        }
    }
    "light"
}

/// Paint every window that is already open from the resolved theme. New windows
/// get the same value from [`current_window_theme`] at creation time.
fn apply_window_theme<R: Runtime>(app: &tauri::AppHandle<R>, resolved: &str) {
    let theme = if resolved == "dark" {
        tauri::Theme::Dark
    } else {
        tauri::Theme::Light
    };
    for (label, window) in app.webview_windows() {
        if let Err(error) = window.set_theme(Some(theme)) {
            log::warn!("app theme: window theme failed for {label}: {error}");
        }
    }
}

/// Install a new effective theme: GTK surfaces, every open window, then one
/// authoritative broadcast. A repeat of the same `(mode, resolved)` pair is a
/// no-op — no repaint, no revision bump, no event — so the loop "GTK write →
/// ThemeChanged → re-resolve" cannot sustain itself.
fn commit_theme<R: Runtime>(
    app: &tauri::AppHandle<R>,
    mode: &str,
    resolved: &str,
) -> AppTheme {
    let (payload, changed) = {
        let mut authority = match theme_authority().lock() {
            Ok(authority) => authority,
            Err(_) => return theme_snapshot(),
        };
        if authority.mode == mode && authority.resolved == resolved {
            (
                AppTheme {
                    mode: authority.mode.clone(),
                    resolved: authority.resolved.clone(),
                    revision: authority.revision,
                },
                false,
            )
        } else {
            authority.mode = mode.to_string();
            authority.resolved = resolved.to_string();
            authority.revision += 1;
            (
                AppTheme {
                    mode: authority.mode.clone(),
                    resolved: authority.resolved.clone(),
                    revision: authority.revision,
                },
                true,
            )
        }
    };

    if changed {
        apply_gtk_theme(resolved == "dark", mode != "auto");
        suppress_system_theme_events();
        apply_window_theme(app, resolved);
        let _ = app.emit(APP_THEME_EVENT, payload.clone());
    }
    payload
}

/// Re-resolve after a desktop theme change. Only `auto` follows the desktop,
/// and it goes through the same commit path as an explicit choice so GTK and
/// every window stay in sync.
async fn reapply_app_theme_if_auto<R: Runtime>(app: &tauri::AppHandle<R>) {
    if theme_mode() != "auto" {
        return;
    }
    if system_theme_events_suppressed() {
        log::debug!("app theme: desktop event ignored while applying our own theme");
        return;
    }
    let resolved = resolve_theme(app, "auto").await;
    if resolved == theme_resolved() {
        return;
    }
    let payload = commit_theme(app, "auto", resolved);
    log::info!(
        "app theme: mode={} resolved={} revision={} (desktop)",
        payload.mode,
        payload.resolved,
        payload.revision
    );
}

/// Read the authoritative theme without changing anything. Windows call this
/// while hydrating, so no window has to guess from `matchMedia` or localStorage.
#[tauri::command]
pub fn get_app_theme() -> AppTheme {
    theme_snapshot()
}

/// Single entry point for theming. The frontend reports the user's choice; Rust
/// resolves it, drives GTK (native popups, file dialogs, overlay scrollbars),
/// binds every window, persists the choice and broadcasts the result.
#[tauri::command]
pub async fn set_app_theme<R: Runtime>(
    app: tauri::AppHandle<R>,
    mode: String,
) -> Result<AppTheme, String> {
    let mode = normalize_theme_mode(&mode);
    let resolved = resolve_theme(&app, &mode).await;
    let payload = commit_theme(&app, &mode, resolved);
    if let Err(error) = persist_theme_mode(&payload.mode, &payload.resolved) {
        log::warn!("app theme: persisting the user choice failed: {error}");
    }
    log::info!(
        "app theme: mode={} resolved={} revision={}",
        payload.mode,
        payload.resolved,
        payload.revision
    );
    Ok(payload)
}

/// Legacy entry point kept for compatibility: it only flips GTK's prefer-dark
/// flag and bypasses the authority. New callers must use [`set_app_theme`].
#[tauri::command]
pub fn set_gtk_prefer_dark(dark: bool) {
    log::warn!("app theme: set_gtk_prefer_dark is deprecated; use set_app_theme");
    apply_gtk_theme(dark, false);
}

/// Repoint native (non-webview) text at the language the webview resolved:
/// tray menu items and the popup window titles created afterwards.
#[cfg(feature = "desktop")]
#[tauri::command]
pub fn set_tray_language(app: AppHandle, language: String) {
    crate::core::native_text::set_language(&language);

    #[cfg(target_os = "linux")]
    {
        if let Some(tray) = app.tray_by_id(crate::status_popup::linux::tray::FALLBACK_TRAY_ID) {
            match tray_menu(&app) {
                Ok(menu) => {
                    if let Err(error) = tray.set_menu(Some(menu)) {
                        log::warn!("tray.menu_relabel_failed error={error}");
                    }
                }
                Err(error) => log::warn!("tray.menu_rebuild_failed error={error}"),
            }
        }
        crate::status_popup::linux::tray::refresh_menu();
    }

    #[cfg(not(target_os = "linux"))]
    let _ = app;
}

#[tauri::command]
pub async fn get_system_theme<R: Runtime>(app: tauri::AppHandle<R>) -> Result<String, String> {
    #[cfg(target_os = "linux")]
    {
        match read_xdg_portal_color_scheme().await {
            Ok(Some(theme)) => return Ok(theme.to_string()),
            Ok(None) => {}
            Err(e) => log::warn!("get_system_theme: portal read failed: {e}"),
        }
    }

    if let Some(window) = app.get_webview_window("main") {
        if let Ok(theme) = window.theme() {
            return Ok(match theme {
                tauri::Theme::Dark => "dark".to_string(),
                _ => "light".to_string(),
            });
        }
    }
    Ok("light".to_string())
}

/// Listen to the XDG Desktop Portal `org.freedesktop.appearance` `color-scheme`
/// setting via D-Bus. This fires reliably on KDE Plasma, GNOME, and other
/// freedesktop-compliant desktop environments.
#[cfg(target_os = "linux")]
async fn setup_xdg_portal_theme_listener<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    use futures_util::StreamExt;
    use zbus::Connection;

    let connection = Connection::session().await?;

    // Build a proxy for the XDG Desktop Portal Settings interface
    let proxy: zbus::Proxy<'_> = zbus::proxy::Builder::new(&connection)
        .destination("org.freedesktop.portal.Desktop")?
        .path("/org/freedesktop/portal/desktop")?
        .interface("org.freedesktop.portal.Settings")?
        .build()
        .await?;

    // Listen for all SettingChanged signals and filter for color-scheme
    let mut signal_stream = proxy.receive_signal("SettingChanged").await?;

    log::info!("XDG Desktop Portal theme listener active");

    // Emit the current value so the frontend doesn't have to wait for the first
    // SettingChanged signal to learn the system color-scheme on startup.
    match read_xdg_portal_color_scheme().await {
        Ok(Some(theme_str)) => {
            log::info!("XDG Portal: initial system color-scheme: {theme_str}");
            let _ = app_handle.emit("theme-changed", theme_str);
            reapply_app_theme_if_auto(&app_handle).await;
        }
        Ok(None) => log::info!("XDG Portal: initial color-scheme is 'no preference'"),
        Err(e) => log::warn!("XDG Portal: initial Read failed: {e}"),
    }

    while let Some(signal) = signal_stream.next().await {
        let body = signal.body();
        if let Ok((namespace, key, value)) =
            body.deserialize::<(String, String, zbus::zvariant::OwnedValue)>()
        {
            if namespace == "org.freedesktop.appearance" && key == "color-scheme" {
                // color-scheme values: 0 = no preference, 1 = prefer dark, 2 = prefer light
                let color_scheme = u32::try_from(value).unwrap_or(0);
                let theme_str = match color_scheme {
                    1 => "dark",
                    _ => "light",
                };
                log::info!(
                    "XDG Portal: system color-scheme changed to: {theme_str} (raw value: {color_scheme})"
                );
                let _ = app_handle.emit("theme-changed", theme_str);
                reapply_app_theme_if_auto(&app_handle).await;
            }
        }
    }

    Ok(())
}

fn setup_window_theme_listener<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    window: tauri::WebviewWindow<R>,
) {
    let window_label = window.label().to_string();
    let app_handle_clone = app_handle.clone();

    window.on_window_event(move |event| {
        if let WindowEvent::ThemeChanged(theme) = event {
            let theme_str = match theme {
                tauri::Theme::Light => "light",
                tauri::Theme::Dark => "dark",
                _ => "auto",
            };
            log::info!("System theme changed to: {theme_str} for window: {window_label}");
            let _ = app_handle_clone.emit("theme-changed", theme_str);
            let app = app_handle_clone.clone();
            tauri::async_runtime::spawn(async move {
                reapply_app_theme_if_auto(&app).await;
            });
        }
    });
}

#[cfg(all(test, target_os = "linux"))]
mod titlebar_layout_tests {
    use super::{button_layout_source, ButtonLayoutSource, TitlebarLayout};

    #[test]
    fn only_the_owning_desktop_supplies_the_button_layout() {
        assert_eq!(button_layout_source("KDE"), ButtonLayoutSource::Kde);
        assert_eq!(
            button_layout_source("ubuntu:GNOME"),
            ButtonLayoutSource::Gnome
        );
        // Bianbu runs LXQt on labwc; GNOME's `appmenu:close` default must not
        // reach it, or the titlebar renders the close button alone.
        assert_eq!(
            button_layout_source("LXQt:labwc:wlroots"),
            ButtonLayoutSource::Default
        );
        assert_eq!(button_layout_source(""), ButtonLayoutSource::Default);
    }

    #[test]
    fn default_layout_keeps_minimize_and_maximize() {
        let layout = TitlebarLayout::default();
        assert!(layout.left.is_empty());
        assert_eq!(layout.right, ["minimize", "maximize", "close"]);
    }
}

#[cfg(test)]
mod theme_authority_tests {
    use super::{
        normalize_theme_mode, parse_persisted_theme_mode, theme_settings_blob, AppTheme,
    };

    #[test]
    fn only_the_three_user_modes_survive_normalization() {
        assert_eq!(normalize_theme_mode("dark"), "dark");
        assert_eq!(normalize_theme_mode("light"), "light");
        assert_eq!(normalize_theme_mode("auto"), "auto");
        assert_eq!(normalize_theme_mode("system"), "auto");
        assert_eq!(normalize_theme_mode(""), "auto");
    }

    #[test]
    fn persisted_mode_is_read_from_the_store_blob() {
        let blob = Some(theme_settings_blob("dark", "dark"));
        assert_eq!(parse_persisted_theme_mode(blob), "dark");

        let auto = Some(theme_settings_blob("auto", "light"));
        assert_eq!(parse_persisted_theme_mode(auto), "auto");
    }

    #[test]
    fn missing_or_malformed_blobs_fall_back_to_auto() {
        assert_eq!(parse_persisted_theme_mode(None), "auto");
        assert_eq!(parse_persisted_theme_mode(Some("{".to_string())), "auto");
        assert_eq!(
            parse_persisted_theme_mode(Some("{\"state\":{}}".to_string())),
            "auto"
        );
        assert_eq!(
            parse_persisted_theme_mode(Some(
                "{\"state\":{\"activeTheme\":\"neon\"},\"version\":0}".to_string()
            )),
            "auto"
        );
    }

    #[test]
    fn persisted_blob_keeps_the_webview_store_shape() {
        let blob = theme_settings_blob("dark", "dark");
        assert_eq!(
            blob,
            "{\"state\":{\"activeTheme\":\"dark\",\"isDark\":true},\"version\":0}"
        );
        let light = theme_settings_blob("auto", "light");
        assert_eq!(
            light,
            "{\"state\":{\"activeTheme\":\"auto\",\"isDark\":false},\"version\":0}"
        );
    }

    #[test]
    fn app_theme_payload_serializes_revision_for_subscribers() {
        let payload = AppTheme {
            mode: "dark".to_string(),
            resolved: "dark".to_string(),
            revision: 7,
        };
        let json = serde_json::to_string(&payload).expect("payload serializes");
        assert!(json.contains("\"revision\":7"));
        assert!(json.contains("\"resolved\":\"dark\""));
    }
}
