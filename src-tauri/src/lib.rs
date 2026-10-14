pub mod core;
#[cfg(feature = "demo-runtime")]
pub mod demo_runtime;
#[cfg(feature = "desktop")]
pub mod desktop_integration;
pub mod external_services;
#[cfg(feature = "desktop")]
pub mod knowledge;
pub mod feature_capabilities;
pub mod feature_file_grants;
pub mod feature_service_jobs;
pub mod startup_trace;
#[cfg(feature = "desktop")]
pub mod runtime;
#[cfg(feature = "desktop")]
pub mod status_popup;
pub mod trusted_plugins;
#[cfg(feature = "desktop")]
pub mod voice_overlay;
#[cfg(feature = "desktop")]
pub mod voice_tool;

pub mod window_health;

use core::{
    app::commands::get_jan_data_folder_path,
    downloads::models::DownloadManagerState,
    mcp::models::McpSettings,
    setup::{self, setup_mcp},
    state::AppState,
};
use jan_utils::generate_app_token;
use std::{
    collections::HashMap,
    sync::Arc,
};
use tauri::{Emitter, Manager, RunEvent};
use tauri_plugin_store::StoreExt;
use tokio::sync::Mutex;

macro_rules! invoke_commands_with_extras {
    ($( $(#[$attr:meta])* $extra:path),* $(,)?) => {
        tauri::generate_handler![
        // FS commands - Deperecate soon
        core::filesystem::commands::join_path,
        core::filesystem::commands::mkdir,
        core::filesystem::commands::exists_sync,
        core::filesystem::commands::readdir_sync,
        core::filesystem::commands::read_file_sync,
        core::filesystem::commands::rm,
        core::filesystem::commands::mv,
        core::filesystem::commands::file_stat,
        core::filesystem::commands::write_file_sync,
        core::filesystem::commands::write_yaml,
        core::filesystem::commands::read_yaml,
        core::filesystem::commands::decompress,
        core::filesystem::commands::open_dialog,
        core::filesystem::commands::save_dialog,
        // App configuration commands
        core::app::commands::get_app_configurations,
        core::app::commands::update_app_configuration,
        core::app::commands::get_jan_data_folder_path,
        core::app::commands::get_configuration_file_path,
        core::app::commands::default_data_folder_path,
        core::app::commands::app_token,
        core::app::commands::get_delivery_information,
        // Backend-owned settings store (webview zustand persistence)
        core::app::settings_store::settings_get,
        core::app::settings_store::settings_set,
        core::app::settings_store::settings_remove,
        core::server::provider_secrets::set_secret,
        core::server::provider_secrets::get_secret,
        // System commands
        core::system::commands::relaunch,
        core::system::commands::open_app_directory,
        core::system::commands::open_file_explorer,
        core::system::commands::read_logs,
        core::system::commands::is_library_available,
        // Server commands
        core::server::commands::start_server,
        core::server::commands::stop_server,
        core::server::commands::get_server_status,
        // Remote provider commands
        core::server::remote_provider_commands::register_provider_config,
        core::server::remote_provider_commands::unregister_provider_config,
        core::server::remote_provider_commands::delete_provider_keys,
        core::server::remote_provider_commands::get_provider_config,
        core::server::remote_provider_commands::get_provider_keys,
        core::server::remote_provider_commands::list_provider_configs,
        // MCP commands
        core::mcp::commands::get_tools,
        core::mcp::commands::get_tools_for_servers,
        core::mcp::commands::get_server_summaries,
        core::mcp::commands::call_tool,
        core::mcp::commands::cancel_tool_call,
        core::mcp::commands::restart_mcp_servers,
        core::mcp::commands::get_connected_servers,
        core::mcp::commands::save_mcp_configs,
        core::mcp::commands::get_mcp_configs,
        core::mcp::commands::activate_mcp_server,
        core::mcp::commands::deactivate_mcp_server,
        // Threads
        core::threads::commands::list_threads,
        core::threads::commands::create_thread,
        core::threads::commands::modify_thread,
        core::threads::commands::delete_thread,
        core::threads::commands::list_messages,
        core::threads::commands::create_message,
        core::threads::commands::modify_message,
        core::threads::commands::delete_message,
        core::threads::commands::get_thread_assistant,
        core::threads::commands::create_thread_assistant,
        core::threads::commands::modify_thread_assistant,
        // Download
        core::downloads::commands::download_files,
        core::downloads::commands::cancel_download_task,
        core::downloads::commands::pause_download_task,
        // App lifecycle
        confirm_exit,
        // Theme
        core::setup::get_system_theme,
        core::setup::set_app_theme,
        core::setup::get_app_theme,
        core::setup::set_gtk_prefer_dark,
        // Native (non-webview) text language
        #[cfg(feature = "desktop")]
        core::setup::set_tray_language,
        core::setup::get_titlebar_layout,
        $(
            $(#[$attr])*
            $extra,
        )*
    ]
    };
}

static SHUTTING_DOWN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static GRACEFUL_IN_PROGRESS: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
static BUSY_MODELS: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

#[tauri::command]
async fn confirm_exit<R: tauri::Runtime>(app_handle: tauri::AppHandle<R>) {
    SHUTTING_DOWN.store(true, std::sync::atomic::Ordering::SeqCst);
    #[cfg(feature = "desktop")]
    stop_runtime_on_exit(&app_handle).await;
    tokio::spawn(async {
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        std::process::exit(0);
    });
}

#[cfg(feature = "desktop")]
async fn stop_runtime_on_exit<R: tauri::Runtime>(app_handle: &tauri::AppHandle<R>) {
    use tauri::Manager;
    let Some(manager) = app_handle.try_state::<std::sync::Arc<runtime::manager::RuntimeManager>>()
    else {
        return;
    };
    let cleanup = async {
        let gateway = manager.active_gateway().await?;
        if gateway.capabilities().detached_runs {
            gateway.detach_all_sessions().await
        } else {
            gateway.stop().await
        }
    };
    match tokio::time::timeout(std::time::Duration::from_secs(3), cleanup).await {
        Ok(Ok(_)) => log::info!("Agent runtime client released"),
        Ok(Err(error)) => log::warn!("Agent runtime cleanup failed: {}", error.message),
        Err(_) => log::warn!("Agent runtime cleanup timed out"),
    }
}

fn is_llamacpp_router_running<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> bool {
    use tauri::Manager;
    app.try_state::<std::sync::Arc<tauri_plugin_llamacpp::LlamacppState>>()
        .map(|s| s.router_pid.load(std::sync::atomic::Ordering::SeqCst) != 0)
        .unwrap_or(false)
}

fn reemit_busy_if_any<R: tauri::Runtime>(app_handle: &tauri::AppHandle<R>) {
    let busy = BUSY_MODELS.lock().map(|g| g.clone()).unwrap_or_default();
    if !busy.is_empty() {
        let _ = app_handle.emit("llamacpp-busy-on-exit", &busy);
    }
}

async fn handle_graceful_exit<R: tauri::Runtime>(
    app_handle: tauri::AppHandle<R>,
    source: &'static str,
    exit_code: i32,
) {
    use std::sync::atomic::Ordering;
    let mut emitted = false;
    loop {
        if SHUTTING_DOWN.load(Ordering::SeqCst) {
            return;
        }
        match tauri_plugin_llamacpp::try_graceful_stop_router(app_handle.clone(), 1).await {
            Ok(None) => {
                if let Ok(mut g) = BUSY_MODELS.lock() {
                    g.clear();
                }
                SHUTTING_DOWN.store(true, Ordering::SeqCst);
                app_handle.exit(exit_code);
                return;
            }
            Ok(Some(busy)) => {
                if let Ok(mut g) = BUSY_MODELS.lock() {
                    *g = busy.clone();
                }
                if !emitted {
                    log::warn!("{}: {} model(s) busy: {:?}", source, busy.len(), busy);
                    if let Err(e) = app_handle.emit("llamacpp-busy-on-exit", &busy) {
                        log::warn!("emit llamacpp-busy-on-exit failed: {}", e);
                        SHUTTING_DOWN.store(true, Ordering::SeqCst);
                        app_handle.exit(exit_code);
                        return;
                    }
                    emitted = true;
                }
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            }
            Err(e) => {
                log::warn!("{}: try_graceful_stop_router failed: {}", source, e);
                SHUTTING_DOWN.store(true, Ordering::SeqCst);
                app_handle.exit(exit_code);
                return;
            }
        }
    }
}

pub fn run() {
    startup_trace::mark("run_enter");
    // 观测：webview 何时真正开始加载文档。前端 timeOrigin 大约落在这个点，
    // 有了它才能把「进程启动 → 文档开始」那一段和页面内的耗时分开。
    let mut builder = tauri::Builder::default().on_page_load(|webview, payload| {
        if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
            startup_trace::mark(&format!("page_load_started label={}", webview.label()));
        }
    });
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let action = desktop_integration::single_instance_request(&argv);
            let controller = app.state::<status_popup::StatusPopupController>();
            controller.activate(app.clone(), action);
        }));
    }

    let mut app_builder = builder
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_llamacpp::init())
        .plugin(tauri_plugin_vector_db::init())
        .plugin(tauri_plugin_rag::init())
        .plugin(tauri_plugin_websearch::init());

    #[cfg(feature = "deep-link")]
    {
        app_builder = app_builder.plugin(tauri_plugin_deep_link::init());
    }

    app_builder = app_builder.plugin(tauri_plugin_hardware::init());

    // Include desktop commands
    let app_builder = app_builder.invoke_handler(invoke_commands_with_extras![
        status_popup::commands::show_status_popup,
        status_popup::commands::hide_status_popup,
        status_popup::commands::minimize_status_popup,
        status_popup::commands::open_main_window,
        desktop_integration::desktop_integration_status,
        desktop_integration::desktop_integration_set_resident,
        desktop_integration::desktop_integration_set_autostart,
        desktop_integration::desktop_integration_set_global_shortcut,
        desktop_integration::desktop_integration_set_popup_geometry,
        voice_overlay::show_voice_overlay,
        voice_overlay::update_voice_ball_position,
        voice_overlay::get_voice_ball_position,
        voice_overlay::voice_overlay_generation,
        voice_overlay::hide_voice_overlay,
        voice_overlay::get_voice_overlay_position,
        voice_overlay::update_voice_overlay_offset,
        voice_overlay::voice_overlay_blanked,
        voice_overlay::voice_ball_blanked,
        voice_tool::voice_tool_start_manual_asr,
        voice_tool::voice_tool_cancel,
        voice_tool::voice_tool_cancel_current,
        voice_tool::voice_tool_replay_events,
        voice_tool::voice_tool_get_status,
        voice_tool::voice_tool_set_switches,
        voice_tool::voice_tool_set_asr_model,
        status_popup::conversation::conversation_snapshot,
        status_popup::conversation::conversation_select_session,
        status_popup::conversation::conversation_update_draft,
        status_popup::conversation::conversation_create_message,
        status_popup::conversation::conversation_modify_message,
        status_popup::conversation::conversation_delete_message,
        knowledge::commands::knowledge_retrieve,
        runtime::commands::runtime_start,
        runtime::commands::runtime_stop,
        runtime::commands::runtime_controller_acquire,
        runtime::commands::runtime_controller_release,
        runtime::commands::runtime_controller_status,
        runtime::commands::runtime_capabilities,
        runtime::commands::runtime_sessions_list,
        runtime::commands::runtime_agents_list,
        runtime::commands::runtime_session_delete,
        runtime::commands::runtime_session_clear_context,
        runtime::commands::runtime_session_generate_title,
        runtime::commands::runtime_skills_list,
        runtime::commands::runtime_session_feed,
        runtime::commands::runtime_session_history_window,
        runtime::commands::runtime_target_identity,
        runtime::cli::runtime_cli_handoff,
        runtime::commands::runtime_session_submit,
        runtime::commands::runtime_session_attachment_select,
        runtime::commands::runtime_session_attachment_upload,
        runtime::commands::runtime_session_attachment_discard,
        runtime::commands::runtime_session_attachment_delete,
        runtime::commands::runtime_session_history,
        runtime::commands::runtime_session_pending,
        runtime::commands::runtime_session_cancel,
        runtime::commands::runtime_session_approval,
        runtime::commands::runtime_session_restore,
        runtime::commands::runtime_messages_list,
        runtime::commands::runtime_sessions_search,
        runtime::commands::runtime_session_attach,
        runtime::commands::runtime_session_detach,
        runtime::commands::runtime_session_rename,
        runtime::commands::runtime_session_create,
        runtime::commands::runtime_run_start,
        runtime::commands::runtime_run_cancel,
        runtime::commands::conversation_cancel_runtime_run,
        runtime::commands::runtime_permission_resolve,
        runtime::commands::runtime_discover,
        runtime::commands::runtime_switch,
        external_services::external_service_request,
        external_services::external_service_cancel,
        feature_capabilities::feature_capability_grants_list,
        feature_file_grants::feature_file_grant_select,
        feature_file_grants::feature_file_grant_publish,
        feature_service_jobs::feature_service_job_start,
        feature_service_jobs::feature_service_job_availability,
        feature_service_jobs::feature_service_job_get,
        feature_service_jobs::feature_service_job_list,
        feature_service_jobs::feature_service_job_events,
        feature_service_jobs::feature_service_job_cancel,
        trusted_plugins::trusted_plugin_install,
        trusted_plugins::trusted_plugin_activate,
        trusted_plugins::trusted_plugin_rollback,
        trusted_plugins::trusted_plugin_deactivate,
        trusted_plugins::trusted_plugin_uninstall,
        trusted_plugins::trusted_plugin_list_active,
        trusted_plugins::trusted_plugin_prepare_active,
        trusted_plugins::trusted_plugin_bootstrap,
        trusted_plugins::static_feature_bootstrap,
        #[cfg(feature = "demo-runtime")]
        demo_runtime::commands::start_demo_runtime,
        #[cfg(feature = "demo-runtime")]
        demo_runtime::commands::cancel_demo_runtime,
        #[cfg(feature = "demo-runtime")]
        demo_runtime::commands::start_demo_conversation,
        #[cfg(feature = "demo-runtime")]
        demo_runtime::commands::conversation_cancel_session_run,
    ]);

    #[cfg(feature = "desktop")]
    let app_builder = app_builder
        .manage(status_popup::StatusPopupController::default())
        .manage(status_popup::conversation::ConversationCoordinator::default())
        .manage(runtime::controller::ControllerLeaseManager::default())
        .manage(voice_tool::VoiceEventBuffer::default())
        .manage(voice_tool::VoiceSessionState::default())
        .manage(voice_tool::VoiceBridgeTask::default());

    #[cfg(feature = "demo-runtime")]
    let app_builder = app_builder.manage(demo_runtime::DemoRuntimeService::default());

    let app = app_builder
        .manage(AppState {
            app_token: Some(generate_app_token()),
            mcp_servers: Arc::new(Mutex::new(HashMap::new())),
            download_manager: Arc::new(Mutex::new(DownloadManagerState::default())),
            mcp_active_servers: Arc::new(Mutex::new(HashMap::new())),
            server_handle: Arc::new(Mutex::new(None)),
            tool_call_cancellations: Arc::new(Mutex::new(HashMap::new())),
            mcp_settings: Arc::new(Mutex::new(McpSettings::default())),
            mcp_shutdown_in_progress: Arc::new(Mutex::new(false)),
            mcp_monitoring_tasks: Arc::new(Mutex::new(HashMap::new())),
            mcp_starting: Arc::new(Mutex::new(HashMap::new())),
            background_cleanup_handle: Arc::new(Mutex::new(None)),
            mcp_server_pids: Arc::new(Mutex::new(HashMap::new())),
            provider_configs: Arc::new(Mutex::new(HashMap::new())),
            mcp_reconnect_notify: Arc::new(tokio::sync::Notify::new()),
            mcp_last_known_tools: Arc::new(Mutex::new(HashMap::new())),
        })
        .setup(|app| {
            startup_trace::mark("setup_enter");
            startup_trace::init(app.handle());
            let data_root = get_jan_data_folder_path(app.handle().clone());
            let file_grants = Arc::new(
                feature_file_grants::FeatureFileGrantService::new(data_root.clone())
                    .map_err(|error| std::io::Error::other(error.to_string()))?,
            );
            app.manage(Arc::clone(&file_grants));
            app.manage(Arc::new(
                feature_service_jobs::FeatureServiceJobRegistry::new(file_grants),
            ));
            #[cfg(feature = "desktop")]
            {
                let integration = desktop_integration::DesktopIntegrationState::load(&data_root)
                    .map_err(std::io::Error::other)?;
                let resident_enabled = integration.resident_enabled();
                app.manage(integration);
                let sink = runtime::commands::TauriRuntimeEventSink::new(app.handle().clone());
                let runtime_cwd = runtime::commands::resolve_runtime_cwd(&data_root)
                    .map_err(|error| std::io::Error::other(error.message))?;
                let manager = runtime::manager::RuntimeManager::new(Arc::new(sink), runtime_cwd)
                    .map_err(|error| std::io::Error::other(error.message))?;
                app.manage(manager);
                if resident_enabled {
                    start_resident_components(app.handle());
                }
                let start_voice_listen = desktop_integration::started_for_voice_listen();
                if desktop_integration::started_in_background() || start_voice_listen {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.hide();
                    }
                }
                if resident_enabled && start_voice_listen {
                    let callback_app = app.handle().clone();
                    tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                        let main_thread_app = callback_app.clone();
                        let _ = callback_app.run_on_main_thread(move || {
                            if let Err(error) =
                                voice_overlay::open_for_voice_listen(&main_thread_app)
                            {
                                log::error!(
                                    "voice_listen.global_shortcut_startup_failed error={error}"
                                );
                            }
                        });
                    });
                }
            }

            window_health::record_startup_snapshot(app.handle());
            window_health::watch_main_render_process(app.handle());

            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(log::LevelFilter::Debug)
                    .targets([
                        tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                        tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Webview),
                        tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Folder {
                            path: get_jan_data_folder_path(app.handle().clone()).join("logs"),
                            file_name: Some("app".to_string()),
                        }),
                    ])
                    .build(),
            )?;
            // Start migration
            let mut store_path = get_jan_data_folder_path(app.handle().clone());
            store_path.push("store.json");
            let store = app
                .handle()
                .store(store_path)
                .expect("Store not initialized");
            let stored_version = store
                .get("version")
                .and_then(|v| v.as_str().map(String::from))
                .unwrap_or_default();
            let app_version = app.config().version.clone().unwrap_or_default();

            // Migrate MCP servers
            if let Err(e) = setup::migrate_mcp_servers(app.handle().clone(), store.clone()) {
                log::error!("Failed to migrate MCP servers: {e}");
            }

            // Store the new app version
            store.set("version", serde_json::json!(app_version));
            store.save().expect("Failed to save store");
            // Migration completed

            #[cfg(feature = "deep-link")]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                app.deep_link().register_all()?;
            }

            setup_mcp(app);
            startup_trace::mark("setup_exit");
            #[cfg(desktop)]
            setup::setup_theme_listener(app)?;
            Ok(())
        })
        .build({
            // 观测：`generate_context!`（配置解析 + 内嵌图标解码）跑在建窗之前，
            // 单独记一笔才能把它和插件注册、建窗的耗时分开。
            let context = tauri::generate_context!();
            startup_trace::mark("context_built");
            context
        })
        .expect("error while running tauri application");
    startup_trace::mark("build_exit");
    // Handle app lifecycle events
    app.run(|app, event| {
        use std::sync::atomic::Ordering;
        if let RunEvent::Ready = &event {
            startup_trace::mark("event_loop_ready");
        }
        if let RunEvent::WindowEvent {
            event: tauri::WindowEvent::CloseRequested { api, .. },
            label,
            ..
        } = &event
        {
            #[cfg(feature = "desktop")]
            if label == status_popup::STATUS_POPUP_LABEL {
                api.prevent_close();
                let controller = app.state::<status_popup::StatusPopupController>();
                if let Err(error) = controller.hide(app, false) {
                    log::warn!("popup.close_hide_failed error={error}");
                }
                return;
            }
            #[cfg(feature = "desktop")]
            if label == "voice-overlay" {
                api.prevent_close();
                let app_handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = voice_overlay::hide_voice_overlay_inner(app_handle).await {
                        log::warn!("voice_overlay.close_hide_failed error={error}");
                    }
                });
                return;
            }
            if label == "main" && !SHUTTING_DOWN.load(Ordering::SeqCst) {
                if app
                    .state::<desktop_integration::DesktopIntegrationState>()
                    .resident_enabled()
                {
                    api.prevent_close();
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.hide();
                    }
                    window_health::record(app, "event=main_window_hidden reason=close");
                    return;
                }
            }
        }
        if let RunEvent::ExitRequested { api, code, .. } = &event {
            if SHUTTING_DOWN.load(Ordering::SeqCst) || !is_llamacpp_router_running(app) {
                return;
            }
            api.prevent_exit();
            let _ = app.emit("llamacpp-close-attempt", ());
            if GRACEFUL_IN_PROGRESS.swap(true, Ordering::SeqCst) {
                reemit_busy_if_any(app);
                return;
            }
            let app_handle = app.clone();
            let exit_code = code.unwrap_or(0);
            tauri::async_runtime::spawn(async move {
                handle_graceful_exit(app_handle, "ExitRequested", exit_code).await;
                GRACEFUL_IN_PROGRESS.store(false, Ordering::SeqCst);
            });
            return;
        }
        if let RunEvent::Exit = event {
            let app_handle = app.clone();

            #[cfg(feature = "desktop")]
            voice_tool::stop_bridge(&app_handle);

            core::app::settings_store::flush_settings();

            {
                if let Some(window) = app_handle.get_webview_window("main") {
                    let _ = window.emit("app-shutting-down", ());
                    let _ = window.hide();
                }
            }

            let state = app_handle.state::<AppState>();

            // Check if cleanup already ran
            let cleanup_already_running = tokio::task::block_in_place(|| {
                tauri::async_runtime::block_on(async {
                    let handle = state.background_cleanup_handle.lock().await;
                    handle.is_some()
                })
            });

            if cleanup_already_running {
                return;
            }

            // Run cleanup synchronously and WAIT for it to complete
            tokio::task::block_in_place(|| {
                tauri::async_runtime::block_on(async {
                    use crate::core::mcp::helpers::background_cleanup_mcp_servers;
                    use tauri_plugin_llamacpp::cleanup_llama_processes;

                    #[cfg(feature = "desktop")]
                    stop_runtime_on_exit(&app_handle).await;

                    external_services::shutdown_managed_providers().await;

                    let state = app_handle.state::<AppState>();

                    // Increase timeout to 10 seconds and log if it times out
                    let cleanup_future = background_cleanup_mcp_servers(&app_handle, &state);
                    match tokio::time::timeout(tokio::time::Duration::from_secs(10), cleanup_future)
                        .await
                    {
                        Ok(_) => log::info!("MCP cleanup completed successfully"),
                        Err(_) => log::warn!("MCP cleanup timed out after 10 seconds"),
                    }

                    if let Err(e) = cleanup_llama_processes(app_handle.clone()).await {
                        log::warn!("Failed to shut down llama-server router: {}", e);
                    } else {
                        log::info!("Llama-server router shut down successfully");
                    }

                    log::info!("App cleanup completed");
                });
            });
        }
    });
}

#[cfg(feature = "desktop")]
pub(crate) fn start_resident_components(app: &tauri::AppHandle) {
    #[cfg(target_os = "linux")]
    desktop_integration::start_voice_listen_shortcut_listener(app.clone());
    if let Err(error) = voice_overlay::prepare_ball(app) {
        log::warn!("voice ball unavailable: {error}");
    }
    // 浮窗开的是 visible(false) 的预热窗：每个显示入口（show_overlay_for_app）
    // 本来就会先 prepare_overlay，所以在首帧之前建它换不到任何东西，反过来让两个
    // webview 同时建窗、同时解析同一份 dist，把主窗口首帧顶后约 0.3-0.4s。
    // 与 MCP 同一条路子：等 app-ready 再预热。提前唤醒的场景由 show 路径按需建窗。
    {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            setup::wait_for_app_ready(&app, std::time::Duration::from_secs(30)).await;
            let overlay_app = app.clone();
            if let Err(error) = app.run_on_main_thread(move || {
                if let Err(error) = voice_overlay::prepare_overlay(&overlay_app) {
                    log::warn!("voice overlay unavailable: {error}");
                }
                crate::startup_trace::mark("overlay_ready");
            }) {
                log::warn!("voice overlay warmup schedule failed: {error}");
            }
        });
    }
    voice_tool::start_bridge(app.clone());
    voice_tool::start_voice_selftest(app.clone());
    if option_env!("ENABLE_SYSTEM_TRAY_ICON").unwrap_or("true") == "true" {
        log::info!("Enabling system tray icon");
        status_popup::linux::tray::setup_linux_status_notifier(app.clone());
    }
}
