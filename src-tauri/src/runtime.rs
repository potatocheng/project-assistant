use crate::{app_error, DesktopState};
use project_assistant_core::{AppError, Engine, Request};
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::Duration,
};
use tauri::{Emitter, Manager, State};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::UpdaterExt;
pub struct RuntimeStatus(pub Mutex<Option<String>>);
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
    }
}
pub fn setup(app: &mut tauri::App, engine: Engine) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::{
        menu::{Menu, MenuItem},
        tray::TrayIconBuilder,
    };
    app.manage(RuntimeStatus(Mutex::new(None)));
    let open = MenuItem::with_id(app, "open", "打开项目助理", true, None::<&str>)?;
    let inbox = MenuItem::with_id(app, "inbox", "查看待处理", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &inbox, &quit])?;
    let mut tray = TrayIconBuilder::new()
        .tooltip("项目助理")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show(app),
            "inbox" => {
                show(app);
                let _ = app.emit("open-inbox", ());
            }
            "quit" => {
                show(app);
                let _ = app.emit("request-quit", ());
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
        .spawn(move || loop {
            let mut errors = Vec::new();
            // Restoration pauses startup preferences as well as notifications.
            // Only remove a stale OS registration; enabling still requires the settings action.
            if call(&engine, "get_desktop_settings", json!({}))
                .is_ok_and(|v| v["autostart"] == false)
                && handle.autolaunch().is_enabled().unwrap_or(false)
            {
                if let Err(e) = handle.autolaunch().disable() {
                    errors.push(format!("无法暂停系统自启动：{e}"));
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
                        .title(digest["title"].as_str().unwrap_or("项目助理"))
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
                        Err(e) => errors.push(format!("系统通知失败：{e}")),
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
        .map_err(|e| app_error("AUTOSTART", e.to_string()))?);
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
                .map_err(|e| app_error("NOTIFICATIONS", e.to_string()))?;
        }
        let saved = call(&engine, "save_desktop_settings", settings.clone())?;
        let result = if settings["autostart"] == true {
            app.autolaunch().enable()
        } else {
            app.autolaunch().disable()
        };
        if let Err(e) = result {
            let _ = call(&engine, "save_desktop_settings", previous);
            return Err(app_error("AUTOSTART", format!("系统未接受自启动设置：{e}")));
        }
        Ok(saved)
    })
    .await
    .map_err(|_| app_error("RUNTIME", "保存桌面设置失败"))?
}
#[tauri::command]
pub fn finish_quit(app: tauri::AppHandle) {
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
        .map_err(|e| app_error("UPDATE", e.to_string()))?
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| app_error("UPDATE", e.to_string()))?;
    let Some(update) = updater
        .check()
        .await
        .map_err(|e| app_error("UPDATE", e.to_string()))?
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
            .map_err(|e| app_error("UPDATE", e.to_string()))?;
        return Ok(json!({"installed":true,"backupId":backup["id"],"restartRequired":true}));
    }
    Ok(json!({"available":true,"version":update.version,"notes":update.body}))
}
