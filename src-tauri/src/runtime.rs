use crate::{app_error, DesktopState};
use project_assistant_core::{AppError, Engine, Request};
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex,
    },
    time::Duration,
};
use tauri::{Emitter, Manager, State};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::UpdaterExt;
pub struct RuntimeStatus(pub Mutex<Option<String>>);
static BACKGROUND_MODE: AtomicBool = AtomicBool::new(false);
static QUIT_ALLOWED: AtomicBool = AtomicBool::new(false);

pub fn background_mode() -> bool {
    BACKGROUND_MODE.load(Ordering::Acquire)
}

pub fn set_background_mode(enabled: bool) {
    BACKGROUND_MODE.store(enabled, Ordering::Release);
}

pub fn is_quit_allowed() -> bool {
    QUIT_ALLOWED.load(Ordering::Acquire)
}
fn call(engine: &Engine, command: &str, payload: Value) -> Result<Value, AppError> {
    engine.execute(Request {
        command: command.into(),
        payload,
    })
}
fn show(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        crate::ensure_normal_window_z_order(&window);
    }
}
pub fn setup(app: &mut tauri::App, engine: Engine) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::{
        menu::{Menu, MenuItem},
        tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    };
    app.manage(RuntimeStatus(Mutex::new(None)));
    set_background_mode(
        call(&engine, "get_desktop_settings", json!({})).is_ok_and(|v| v["background"] == true),
    );
    let open = MenuItem::with_id(app, "open", "打开循序", true, None::<&str>)?;
    let inbox = MenuItem::with_id(app, "inbox", "查看待处理", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &inbox, &quit])?;
    let mut tray = TrayIconBuilder::new()
        .tooltip("循序 · Cadence")
        .menu(&menu)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show(tray.app_handle());
            }
        })
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show(app),
            "inbox" => {
                show(app);
                let _ = app.emit("open-inbox", ());
            }
            "quit" => {
                request_quit(app);
            }
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    let handle = app.handle().clone();
    std::thread::Builder::new()
        .name("desktop-maintenance".into())
        .spawn(move || {
            // Let the UI finish opening before background maintenance runs or notifies.
            std::thread::sleep(Duration::from_secs(15));
            loop {
                let mut errors = Vec::new();
                // Restoration pauses startup preferences as well as notifications.
                // Only remove a stale OS registration; enabling still requires the settings action.
                if call(&engine, "get_desktop_settings", json!({}))
                    .is_ok_and(|v| v["autostart"] == false)
                    && handle.autolaunch().is_enabled().unwrap_or(false)
                {
                    if let Err(_) = handle.autolaunch().disable() {
                        errors.push("无法调整系统开机自启状态".to_string());
                    }
                }
                if let Err(e) = call(&engine, "run_automatic_backup", json!({})) {
                    errors.push(e.message);
                }
                match call(&engine, "get_notification_digest", json!({})) {
                    Ok(digest) if !digest.is_null() => {
                        let result = handle
                            .notification()
                            .builder()
                            .title(digest["title"].as_str().unwrap_or("循序"))
                            .body(digest["body"].as_str().unwrap_or("有事项需要查看"))
                            .show();
                        match result {
                            Ok(()) => {
                                if let Err(e) = call(
                                    &engine,
                                    "ack_notification",
                                    json!({"signature":digest["signature"]}),
                                ) {
                                    errors.push(e.message);
                                }
                            }
                            Err(_) => errors
                                .push("系统通知未能弹出，请在系统设置中检查通知权限".to_string()),
                        }
                    }
                    Err(e) => errors.push(e.message),
                    _ => {}
                }
                if let Ok(mut status) = handle.state::<RuntimeStatus>().0.lock() {
                    *status = if errors.is_empty() {
                        None
                    } else {
                        Some(errors.join("；"))
                    };
                }
                std::thread::sleep(Duration::from_secs(60));
            }
        })?;
    Ok(())
}
#[tauri::command]
pub async fn desktop_runtime_status(
    app: tauri::AppHandle,
    state: State<'_, DesktopState>,
) -> Result<Value, AppError> {
    let engine = state.engine.clone();
    let mut value = tauri::async_runtime::spawn_blocking(move || {
        call(&engine, "get_desktop_settings", json!({}))
    })
    .await
    .map_err(|_| app_error("RUNTIME", "无法读取桌面设置"))??;
    value["autostartActual"] = json!(app
        .autolaunch()
        .is_enabled()
        .map_err(|_| app_error("AUTOSTART", "无法检查系统开机自启状态"))?);
    value["lastError"] = json!(app
        .state::<RuntimeStatus>()
        .0
        .lock()
        .ok()
        .and_then(|s| s.clone()));
    value["updatesConfigured"] = json!(
        option_env!("PROJECT_ASSISTANT_UPDATE_URL").is_some()
            && option_env!("PROJECT_ASSISTANT_UPDATE_PUBKEY").is_some()
    );
    Ok(value)
}
#[tauri::command]
pub async fn save_runtime_settings(
    settings: Value,
    app: tauri::AppHandle,
    state: State<'_, DesktopState>,
) -> Result<Value, AppError> {
    let engine = state.engine.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let previous = call(&engine, "get_desktop_settings", json!({}))?;
        // Validate and persist first. Roll back if the OS rejects autostart.
        if settings["notifications"] == true {
            app.notification()
                .request_permission()
                .map_err(|_| app_error("NOTIFICATIONS", "请在系统设置中允许循序发送通知"))?;
        }
        let saved = call(&engine, "save_desktop_settings", settings.clone())?;
        set_background_mode(saved["background"] == true);
        let result = if settings["autostart"] == true {
            app.autolaunch().enable()
        } else {
            app.autolaunch().disable()
        };
        if result.is_err() {
            let _ = call(&engine, "save_desktop_settings", previous.clone());
            set_background_mode(previous["background"] == true);
            return Err(app_error(
                "AUTOSTART",
                "系统未接受开机自启设置，请检查系统权限",
            ));
        }
        Ok(saved)
    })
    .await
    .map_err(|_| app_error("RUNTIME", "保存桌面设置失败"))?
}
static QUIT_SEQ: AtomicU64 = AtomicU64::new(0);
static QUIT_PENDING: AtomicBool = AtomicBool::new(false);

pub fn request_quit(app: &tauri::AppHandle) {
    // If a previous quit request was never acknowledged by the webview (e.g. blank/crashed page),
    // a second close/quit action exits immediately instead of deadlocking the window.
    if QUIT_PENDING.swap(true, Ordering::AcqRel) {
        QUIT_PENDING.store(false, Ordering::Release);
        QUIT_SEQ.fetch_add(1, Ordering::AcqRel);
        QUIT_ALLOWED.store(true, Ordering::Release);
        app.exit(0);
        return;
    }
    let seq = QUIT_SEQ.fetch_add(1, Ordering::AcqRel).wrapping_add(1);
    let emitted = app
        .get_webview_window("main")
        .map(|window| window.emit("request-quit", ()))
        .unwrap_or_else(|| app.emit("request-quit", ()));
    if emitted.is_err() {
        QUIT_PENDING.store(false, Ordering::Release);
        QUIT_ALLOWED.store(true, Ordering::Release);
        app.exit(0);
        return;
    }
    let handle = app.clone();
    let _ = std::thread::Builder::new()
        .name("quit-fallback".into())
        .spawn(move || {
            std::thread::sleep(Duration::from_millis(1500));
            if QUIT_PENDING.load(Ordering::Acquire) && QUIT_SEQ.load(Ordering::Acquire) == seq {
                QUIT_PENDING.store(false, Ordering::Release);
                QUIT_ALLOWED.store(true, Ordering::Release);
                handle.exit(0);
            }
        });
}

#[tauri::command]
pub fn ack_quit_request() {
    QUIT_PENDING.store(false, Ordering::Release);
    QUIT_SEQ.fetch_add(1, Ordering::AcqRel);
}

#[tauri::command]
pub fn finish_quit(app: tauri::AppHandle) {
    QUIT_PENDING.store(false, Ordering::Release);
    QUIT_SEQ.fetch_add(1, Ordering::AcqRel);
    QUIT_ALLOWED.store(true, Ordering::Release);
    app.exit(0);
}
static UPDATING: AtomicBool = AtomicBool::new(false);
struct Updating;
impl Drop for Updating {
    fn drop(&mut self) {
        UPDATING.store(false, Ordering::Release);
    }
}
#[tauri::command]
pub async fn update_application(
    install_version: Option<String>,
    app: tauri::AppHandle,
    state: State<'_, DesktopState>,
) -> Result<Value, AppError> {
    if UPDATING.swap(true, Ordering::AcqRel) {
        return Err(app_error("UPDATE_BUSY", "更新检查正在进行"));
    }
    let _guard = Updating;
    let endpoint = option_env!("PROJECT_ASSISTANT_UPDATE_URL")
        .ok_or_else(|| app_error("UPDATES_UNCONFIGURED", "此构建尚未配置签名更新源"))?;
    let key = option_env!("PROJECT_ASSISTANT_UPDATE_PUBKEY")
        .ok_or_else(|| app_error("UPDATES_UNCONFIGURED", "此构建尚未配置更新签名公钥"))?;
    let endpoint =
        tauri::Url::parse(endpoint).map_err(|_| app_error("UPDATE_URL", "更新源无效"))?;
    if endpoint.scheme() != "https" {
        return Err(app_error("UPDATE_URL", "更新源必须使用HTTPS"));
    }
    let updater = app
        .updater_builder()
        .pubkey(key)
        .endpoints(vec![endpoint])
        .map_err(|_| app_error("UPDATE", "更新配置初始化失败"))?
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|_| app_error("UPDATE", "更新组件初始化失败"))?;
    let Some(update) = updater
        .check()
        .await
        .map_err(|_| app_error("UPDATE", "检查更新失败，请检查网络连接后重试"))?
    else {
        return Ok(json!({"available":false}));
    };
    if let Some(version) = install_version {
        if version != update.version {
            return Err(app_error(
                "UPDATE_CHANGED",
                "可用版本已改变，请重新检查后确认",
            ));
        }
        let engine = state.engine.clone();
        let backup =
            tauri::async_runtime::spawn_blocking(move || call(&engine, "create_backup", json!({})))
                .await
                .map_err(|_| app_error("BACKUP", "升级前安全备份失败"))??;
        update
            .download_and_install(|_, _| {}, || {})
            .await
            .map_err(|_| app_error("UPDATE", "下载或安装更新失败，请稍后重试"))?;
        return Ok(json!({"installed":true,"backupId":backup["id"],"restartRequired":true}));
    }
    Ok(json!({"available":true,"version":update.version,"notes":update.body}))
}
