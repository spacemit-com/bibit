use crate::core::native_text;
use crate::status_popup::controller::StatusPopupController;
use ksni::{menu::StandardItem, MenuItem, TrayMethods};
use std::sync::OnceLock;
use tauri::Manager;
use tokio::sync::mpsc::{self, UnboundedSender};
use tokio::time::{timeout, Duration};

pub const FALLBACK_TRAY_ID: &str = "bibit-fallback-tray";

/// SNI 注册走 D-Bus：会话 bus 卡住时 `spawn()` 不会返回，托盘永远不出现，
/// 动作通道也没人消费。等待给预算，注册本身不取消——晚到的成功会自己
/// 撤掉兜底入口。
const SNI_REGISTER_TIMEOUT: Duration = Duration::from_secs(10);
const SNI_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);

/// Kept so a language change can push a fresh menu into the running SNI service.
static TRAY: OnceLock<ksni::Handle<BibitTray>> = OnceLock::new();

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TrayAction {
    OpenOverlay,
    ToggleVoiceBall,
    OpenMain,
    Quit,
    WatcherOnline,
    WatcherOffline,
}

pub struct BibitTray {
    tx: UnboundedSender<TrayAction>,
    icons: Vec<ksni::Icon>,
}

impl BibitTray {
    pub fn new(tx: UnboundedSender<TrayAction>) -> Self {
        Self {
            tx,
            icons: Vec::new(),
        }
    }

    pub fn with_icons(tx: UnboundedSender<TrayAction>, icons: Vec<ksni::Icon>) -> Self {
        Self { tx, icons }
    }

    fn send(&self, action: TrayAction) {
        let _ = self.tx.send(action);
    }
}

impl ksni::Tray for BibitTray {
    fn id(&self) -> String {
        "bibit".to_owned()
    }

    fn title(&self) -> String {
        "BiBit".to_owned()
    }

    fn icon_name(&self) -> String {
        "bibit-status".to_owned()
    }

    fn icon_pixmap(&self) -> Vec<ksni::Icon> {
        self.icons.clone()
    }

    fn activate(&mut self, _x: i32, _y: i32) {
        self.send(TrayAction::OpenOverlay);
    }

    fn secondary_activate(&mut self, _x: i32, _y: i32) {
        self.send(TrayAction::OpenOverlay);
    }

    fn watcher_online(&self) {
        self.send(TrayAction::WatcherOnline);
    }

    fn watcher_offline(&self, _reason: ksni::OfflineReason) -> bool {
        self.send(TrayAction::WatcherOffline);
        true
    }

    fn menu(&self) -> Vec<MenuItem<Self>> {
        let labels = native_text::current();
        vec![
            StandardItem {
                label: labels.toggle_voice_ball.to_owned(),
                activate: Box::new(|tray: &mut Self| tray.send(TrayAction::ToggleVoiceBall)),
                ..Default::default()
            }
            .into(),
            StandardItem {
                label: labels.open_main.to_owned(),
                activate: Box::new(|tray: &mut Self| tray.send(TrayAction::OpenMain)),
                ..Default::default()
            }
            .into(),
            MenuItem::Separator,
            StandardItem {
                label: labels.quit.to_owned(),
                icon_name: "application-exit".to_owned(),
                activate: Box::new(|tray: &mut Self| tray.send(TrayAction::Quit)),
                ..Default::default()
            }
            .into(),
        ]
    }
}

pub fn setup_linux_status_notifier(app: tauri::AppHandle) {
    let (tx, rx) = mpsc::unbounded_channel();
    let icons = embedded_icons();
    let tray = BibitTray::with_icons(tx, icons);
    let action_app = app.clone();

    tauri::async_runtime::spawn(async move {
        let handle = run_tray_actions(
            async move {
                let handle = tray.assume_sni_available(true).spawn().await?;
                let _ = TRAY.set(handle.clone());
                Ok(handle)
            },
            rx,
            SNI_REGISTER_TIMEOUT,
            move |action| dispatch_action(&action_app, action),
        )
        .await;

        if let Some(handle) = handle {
            if timeout(SNI_SHUTDOWN_TIMEOUT, handle.shutdown()).await.is_err() {
                log::warn!("sni.shutdown_timeout");
            }
        }
    });
}

async fn run_tray_actions<Handle: Send + 'static>(
    registration: impl std::future::Future<Output = Result<Handle, ksni::Error>> + Send + 'static,
    mut rx: mpsc::UnboundedReceiver<TrayAction>,
    register_budget: Duration,
    mut dispatch: impl FnMut(TrayAction),
) -> Option<Handle> {
    let mut registration = tokio::spawn(registration);
    let deadline = tokio::time::sleep(register_budget);
    tokio::pin!(deadline);
    let mut handle = None;
    let mut registering = true;
    let mut timed_out = false;
    let mut actions_open = true;
    let mut watcher_online = true;
    while registering || actions_open {
        tokio::select! {
            biased;
            action = rx.recv(), if actions_open => {
                if let Some(action) = action {
                    match action {
                        TrayAction::WatcherOnline => watcher_online = true,
                        TrayAction::WatcherOffline => watcher_online = false,
                        _ => {}
                    }
                    if action != TrayAction::WatcherOnline || handle.is_some() {
                        dispatch(action);
                    }
                } else {
                    actions_open = false;
                }
            }
            result = &mut registration, if registering => {
                registering = false;
                match result {
                    Ok(Ok(registered)) => {
                        log::info!("sni.registered");
                        handle = Some(registered);
                        while let Ok(action) = rx.try_recv() {
                            match action {
                                TrayAction::WatcherOnline => watcher_online = true,
                                TrayAction::WatcherOffline => watcher_online = false,
                                _ => {}
                            }
                            dispatch(action);
                        }
                        dispatch(if watcher_online {
                            TrayAction::WatcherOnline
                        } else {
                            TrayAction::WatcherOffline
                        });
                    }
                    Ok(Err(error)) => {
                        log::warn!("sni.registration_failed error={error}");
                        dispatch(TrayAction::WatcherOffline);
                    }
                    Err(join_error) => {
                        log::error!("sni.registration_task_failed error={join_error}");
                        dispatch(TrayAction::WatcherOffline);
                    }
                }
            }
            _ = &mut deadline, if registering && !timed_out => {
                timed_out = true;
                log::warn!("sni.registration_timeout");
                dispatch(TrayAction::WatcherOffline);
            }
        }
    }
    handle
}

/// Re-read `Tray::menu` and publish it; called after the webview pushes a language.
pub fn refresh_menu() {
    let Some(handle) = TRAY.get() else {
        return;
    };
    let handle = handle.clone();
    tauri::async_runtime::spawn(async move {
        let _ = handle.update(|_| {}).await;
    });
}

fn dispatch_action(app: &tauri::AppHandle, action: TrayAction) {
    match action {
        TrayAction::OpenOverlay => {
            if let Err(error) = crate::voice_overlay::open_from_tray(app) {
                log::error!("voice_overlay.tray_activation_failed error={error}");
            }
        }
        TrayAction::ToggleVoiceBall => {
            let callback_app = app.clone();
            if let Err(error) = app.run_on_main_thread(move || {
                if let Err(error) = crate::voice_overlay::toggle_ball(&callback_app) {
                    log::error!("voice_ball.toggle_failed error={error}");
                }
            }) {
                log::error!("voice_ball.toggle_schedule_failed error={error}");
            }
        }
        TrayAction::OpenMain => {
            let callback_app = app.clone();
            if let Err(error) = app.run_on_main_thread(move || {
                let controller = callback_app.state::<StatusPopupController>();
                let _ = controller.hide(&callback_app, false);
                if let Err(error) = StatusPopupController::open_main(&callback_app) {
                    log::error!("popup.open_main_failed error={error}");
                }
            }) {
                log::error!("popup.open_main_schedule_failed error={error}");
            }
        }
        TrayAction::Quit => app.exit(0),
        TrayAction::WatcherOnline => {
            log::info!("sni.watcher_online");
            let callback_app = app.clone();
            let _ = app.run_on_main_thread(move || hide_fallback_tray(&callback_app));
        }
        TrayAction::WatcherOffline => {
            log::warn!("sni.watcher_offline");
            let callback_app = app.clone();
            let _ = app.run_on_main_thread(move || show_fallback_tray(&callback_app));
        }
    }
}

fn show_fallback_tray(app: &tauri::AppHandle) {
    if app.tray_by_id(FALLBACK_TRAY_ID).is_some() {
        return;
    }
    if let Err(error) = crate::core::setup::setup_tauri_tray(app, FALLBACK_TRAY_ID) {
        log::error!("sni.fallback_tray_failed error={error}");
    }
}

fn hide_fallback_tray(app: &tauri::AppHandle) {
    let _ = app.remove_tray_by_id(FALLBACK_TRAY_ID);
}

fn embedded_icons() -> Vec<ksni::Icon> {
    let image = crate::core::setup::tray_icon();
    let mut data = image.rgba().to_vec();
    for pixel in data.chunks_exact_mut(4) {
        pixel.rotate_right(1);
    }
    vec![ksni::Icon {
        width: image.width() as i32,
        height: image.height() as i32,
        data,
    }]
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn next_action(rx: &mut mpsc::UnboundedReceiver<TrayAction>) -> TrayAction {
        timeout(Duration::from_secs(1), rx.recv())
            .await
            .expect("托盘动作必须有界响应")
            .expect("托盘动作通道不可提前关闭")
    }

    #[tokio::test]
    async fn late_offline_registration_keeps_fallback_and_actions_responsive() {
        let (tx, rx) = mpsc::unbounded_channel();
        let controls = tx.clone();
        let (registered, registration_rx) = tokio::sync::oneshot::channel();
        let (actions, mut dispatched) = mpsc::unbounded_channel();
        let worker = tokio::spawn(run_tray_actions(
            async move {
                let tray = BibitTray::new(tx);
                assert!(ksni::Tray::watcher_offline(&tray, ksni::OfflineReason::No));
                registration_rx.await.unwrap();
                Ok(())
            },
            rx,
            Duration::from_millis(10),
            move |action| {
                let _ = actions.send(action);
            },
        ));
        assert_eq!(
            next_action(&mut dispatched).await,
            TrayAction::WatcherOffline
        );
        controls.send(TrayAction::OpenMain).unwrap();
        let mut saw_open_main = false;
        let mut saw_timeout = false;
        while !saw_open_main || !saw_timeout {
            match next_action(&mut dispatched).await {
                TrayAction::OpenMain => saw_open_main = true,
                TrayAction::WatcherOffline => saw_timeout = true,
                action => panic!("注册完成前发生意外托盘动作: {action:?}"),
            }
        }
        drop(controls);
        registered.send(()).unwrap();
        let handle = timeout(Duration::from_secs(1), worker)
            .await
            .unwrap()
            .unwrap();
        let mut remaining = Vec::new();
        while let Some(action) = dispatched.recv().await {
            remaining.push(action);
        }
        assert!(
            !remaining.contains(&TrayAction::WatcherOnline),
            "离线回调之后的注册成功不得隐藏兜底入口"
        );
        assert!(handle.is_some(), "超时后成功的注册仍须接管 handle");
    }

    #[tokio::test]
    async fn initial_online_registration_hides_fallback_without_online_callback() {
        let (tx, rx) = mpsc::unbounded_channel();
        let mut actions = Vec::new();
        let handle = timeout(
            Duration::from_secs(1),
            run_tray_actions(
                async move {
                    let _tray = BibitTray::new(tx);
                    Ok(())
                },
                rx,
                Duration::from_millis(10),
                |action| actions.push(action),
            ),
        )
        .await
        .unwrap();
        assert!(handle.is_some());
        assert_eq!(actions, vec![TrayAction::WatcherOnline]);
    }

    #[tokio::test]
    async fn initial_offline_registration_never_hides_fallback() {
        let (tx, rx) = mpsc::unbounded_channel();
        let mut actions = Vec::new();
        let handle = timeout(
            Duration::from_secs(1),
            run_tray_actions(
                async move {
                    let tray = BibitTray::new(tx);
                    assert!(ksni::Tray::watcher_offline(&tray, ksni::OfflineReason::No));
                    Ok(())
                },
                rx,
                Duration::from_millis(10),
                |action| actions.push(action),
            ),
        )
        .await
        .unwrap();
        assert!(handle.is_some());
        assert!(!actions.is_empty());
        assert!(actions
            .iter()
            .all(|action| *action == TrayAction::WatcherOffline));
    }

    #[tokio::test]
    async fn late_online_registration_takes_over_and_tracks_watcher_changes() {
        let (tx, rx) = mpsc::unbounded_channel();
        let (registered, registration_rx) = tokio::sync::oneshot::channel();
        let (actions, mut dispatched) = mpsc::unbounded_channel();
        let tray = BibitTray::new(tx);
        let worker = tokio::spawn(run_tray_actions(
            async move {
                registration_rx.await.unwrap();
                Ok(())
            },
            rx,
            Duration::from_millis(10),
            move |action| {
                let _ = actions.send(action);
            },
        ));
        assert_eq!(
            next_action(&mut dispatched).await,
            TrayAction::WatcherOffline
        );
        registered.send(()).unwrap();
        assert_eq!(
            next_action(&mut dispatched).await,
            TrayAction::WatcherOnline
        );
        assert!(ksni::Tray::watcher_offline(&tray, ksni::OfflineReason::No));
        assert_eq!(
            next_action(&mut dispatched).await,
            TrayAction::WatcherOffline
        );
        ksni::Tray::watcher_online(&tray);
        assert_eq!(
            next_action(&mut dispatched).await,
            TrayAction::WatcherOnline
        );
        drop(tray);
        assert!(timeout(Duration::from_secs(1), worker)
            .await
            .unwrap()
            .unwrap()
            .is_some());
    }

    #[tokio::test]
    async fn failed_registration_keeps_fallback_and_handles_actions() {
        let (tx, rx) = mpsc::unbounded_channel();
        tx.send(TrayAction::OpenMain).unwrap();
        let mut actions = Vec::new();
        let handle = timeout(
            Duration::from_secs(1),
            run_tray_actions(
                async move {
                    drop(tx);
                    Err::<(), _>(ksni::Error::WontShow)
                },
                rx,
                Duration::from_millis(10),
                |action| actions.push(action),
            ),
        )
        .await
        .unwrap();
        assert!(handle.is_none());
        assert_eq!(
            actions,
            vec![TrayAction::OpenMain, TrayAction::WatcherOffline]
        );
    }

    fn menu_labels(tray: &BibitTray) -> Vec<String> {
        ksni::Tray::menu(tray)
            .into_iter()
            .filter_map(|item| match item {
                MenuItem::Standard(item) => Some(item.label),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn embedded_tray_icon_is_decodable() {
        let icons = embedded_icons();
        assert_eq!(icons.len(), 1);
        assert_eq!((icons[0].width, icons[0].height), (64, 64));
        assert_eq!(icons[0].data.len(), 64 * 64 * 4);
    }

    #[tokio::test]
    async fn activate_opens_shared_overlay() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let mut tray = BibitTray::new(tx);
        ksni::Tray::activate(&mut tray, 2500, -3);
        assert_eq!(rx.recv().await, Some(TrayAction::OpenOverlay));
        ksni::Tray::secondary_activate(&mut tray, 0, 0);
        assert_eq!(rx.recv().await, Some(TrayAction::OpenOverlay));
    }

    #[tokio::test]
    async fn menu_only_exposes_ball_main_and_quit() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let mut tray = BibitTray::new(tx);
        let menu = ksni::Tray::menu(&tray);
        let items: Vec<_> = menu
            .into_iter()
            .filter_map(|item| match item {
                MenuItem::Standard(item) => Some(item),
                _ => None,
            })
            .collect();
        assert_eq!(
            items
                .iter()
                .map(|item| item.label.as_str())
                .collect::<Vec<_>>(),
            vec!["显示/隐藏悬浮球", "打开主窗口", "退出 BiBit"]
        );
        crate::core::native_text::set_language("en");
        assert_eq!(
            menu_labels(&tray),
            vec!["Show / Hide Floating Ball", "Open Main Window", "Quit BiBit"]
                .into_iter()
                .map(String::from)
                .collect::<Vec<_>>()
        );
        crate::core::native_text::set_language("zh-CN");
        for (item, expected) in items.into_iter().zip([
            TrayAction::ToggleVoiceBall,
            TrayAction::OpenMain,
            TrayAction::Quit,
        ]) {
            (item.activate)(&mut tray);
            assert_eq!(rx.recv().await, Some(expected));
        }
    }
}
