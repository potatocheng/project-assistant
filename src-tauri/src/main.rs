// Use the GUI subsystem in debug builds too, so double-clicking never opens a console.
#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

mod runtime;

use project_assistant_core::{AppError, Engine, Request};
use serde_json::{json, Value};
use std::path::{Component, Path, PathBuf};
use tauri::{Emitter, Manager, State};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;

struct DesktopState {
    engine: Engine,
    root: PathBuf,
}

fn app_error(code: &str, message: impl Into<String>) -> AppError {
    AppError {
        code: code.to_string(),
        message: message.into(),
    }
}

#[tauri::command]
async fn execute(request: Request, state: State<'_, DesktopState>) -> Result<Value, AppError> {
    if !matches!(
        request.command.as_str(),
        "get_state"
            | "ask_conversation"
            | "list_conversations"
            | "create_conversation"
            | "get_conversation"
            | "favorite_answer"
            | "search_workspace"
            | "get_credential_protection"
            | "enable_credential_protection"
            | "get_desktop_settings"
            | "save_desktop_settings"
            | "get_backup_policy"
            | "save_backup_policy"
            | "run_automatic_backup"
            | "get_workspace_revision"
            | "get_draft"
            | "save_draft"
            | "delete_draft"
            | "get_retention_reviews"
            | "review_retention"
            | "lifecycle_impact"
            | "set_lifecycle"
            | "create_project"
            | "import_text"
            | "import_file"
            | "get_source"
            | "create_proposal"
            | "confirm_proposal"
            | "reject_proposal"
            | "get_memory"
            | "revise_memory"
            | "create_backup"
            | "inspect_backup"
            | "restore_backup"
            | "get_ai_settings"
            | "save_ai_settings"
            | "test_ai_connection"
            | "start_extraction"
            | "retry_extraction"
            | "cancel_extraction"
            | "update_proposal"
            | "batch_schedule_tasks"
            | "create_task"
            | "update_task"
            | "get_task"
            | "get_daily_list"
            | "get_daily_planning"
            | "preview_task_relation"
            | "save_daily_capacity"
            | "save_task_estimate"
            | "remove_task_relation"
            | "analyze_task_workload"
            | "generate_daily_plan"
            | "confirm_planning_draft"
            | "dismiss_planning_draft"
            | "update_task_proposal"
            | "confirm_task_proposal"
            | "reject_task_proposal"
            | "generate_daily_report"
            | "get_daily_report"
            | "save_daily_report"
            | "ask_project"
            | "ask_project_question"
            | "ask_assistant"
            | "generate_today_brief"
            | "generate_task_coaching"
            | "get_assistant_preferences"
            | "save_assistant_preferences"
            | "clear_assistant_preferences"
            | "get_project_brief"
            | "generate_project_brief"
            | "get_memory_quality"
            | "check_memory_quality"
            | "assess_extraction"
            | "get_management_attention"
            | "get_governance_workspace"
            | "get_governance_item"
            | "save_governance_item"
            | "record_governance_progress"
            | "get_change_acceptance"
            | "save_change_request"
            | "transition_change_request"
            | "save_deliverable"
            | "review_deliverable"
            | "delete_change_request"
            | "delete_deliverable"
            | "coordination_list"
            | "coordination_generate_report"
            | "coordination_get_report"
            | "coordination_save_report"
            | "coordination_save_meeting"
            | "coordination_prepare_meeting"
            | "coordination_get_meeting"
            | "coordination_save_action"
            | "coordination_confirm_action"
            | "get_delivery_overview"
            | "save_project_profile"
            | "save_milestone"
            | "get_follow_up_center"
            | "get_proactive_center"
            | "run_proactive_scan"
            | "save_proactive_settings"
            | "update_proactive_action"
            | "record_follow_up"
            | "snooze_follow_up"
            | "get_feishu_status"
            | "save_feishu_settings"
            | "begin_feishu_authorization"
            | "begin_feishu_connection"
            | "disconnect_feishu"
            | "poll_feishu_now"
            | "list_feishu_chats"
            | "list_feishu_private_chats"
            | "get_feishu_sources"
            | "save_feishu_sources"
            | "sync_feishu_sources"
            | "get_memory_maintenance"
            | "save_memory_maintenance"
            | "resolve_memory_review"
            | "recompare_memory_review"
            | "retry_memory_maintenance"
            | "run_memory_maintenance"
            | "memory_activity"
    ) {
        return Err(app_error("INVALID_COMMAND", "不支持这项操作。"));
    }
    let engine = state.engine.clone();
    tauri::async_runtime::spawn_blocking(move || engine.execute(request))
        .await
        .map_err(|e| app_error("EXECUTION_FAILED", format!("本地操作未完成：{e}")))?
}

#[tauri::command]
async fn export_backup(
    backup_id: String,
    password: Option<String>,
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: State<'_, DesktopState>,
) -> Result<Value, AppError> {
    let engine = state.engine.clone();
    let root = state.root.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let snapshot = engine.execute(Request {
            command: "get_state".into(),
            payload: json!({}),
        })?;
        let record = snapshot["backups"]
            .as_array()
            .and_then(|items| {
                items
                    .iter()
                    .find(|item| item["id"].as_str() == Some(&backup_id))
            })
            .ok_or_else(|| app_error("NOT_FOUND", "找不到这份备份，请刷新后重试。"))?;
        let filename = record["filename"]
            .as_str()
            .ok_or_else(|| app_error("INVALID_BACKUP", "备份文件信息不完整。"))?;
        let mut components = Path::new(filename).components();
        if !matches!(components.next(), Some(Component::Normal(_))) || components.next().is_some() {
            return Err(app_error("INVALID_BACKUP", "备份文件名无效。"));
        }
        let backup_dir = root
            .join("backups")
            .canonicalize()
            .map_err(|e| app_error("IO_ERROR", format!("无法读取备份目录：{e}")))?;
        let source = backup_dir
            .join(filename)
            .canonicalize()
            .map_err(|e| app_error("IO_ERROR", format!("无法读取备份文件：{e}")))?;
        if !source.starts_with(&backup_dir) || !source.is_file() {
            return Err(app_error("INVALID_BACKUP", "备份文件不在工作空间内。"));
        }
        let encrypted = password
            .as_deref()
            .map(|p| project_assistant_core::encrypt_backup_bytes(&std::fs::read(&source)?, p))
            .transpose()?;
        let export_name = if encrypted.is_some() {
            filename.replace(".zip", ".pabackup")
        } else {
            filename.to_owned()
        };
        let chosen = app
            .dialog()
            .file()
            .set_parent(&window)
            .set_file_name(&export_name)
            .blocking_save_file();
        let Some(chosen) = chosen else {
            return Ok(json!({ "cancelled": true }));
        };
        let target = chosen
            .into_path()
            .map_err(|_| app_error("INVALID_PATH", "请选择本地保存位置。"))?;
        if encrypted.is_some() && target == source {
            return Err(app_error(
                "INVALID_PATH",
                "加密导出请选择新位置，不能覆盖原备份",
            ));
        }
        if let Some(bytes) = encrypted {
            std::fs::write(&target, bytes)
                .map_err(|e| app_error("IO_ERROR", format!("导出失败：{e}")))?;
        } else if target != source {
            std::fs::copy(&source, &target)
                .map_err(|e| app_error("IO_ERROR", format!("导出失败：{e}")))?;
        }
        Ok(json!({ "cancelled": false, "path": target.to_string_lossy() }))
    })
    .await
    .map_err(|e| app_error("EXECUTION_FAILED", format!("导出未完成：{e}")))?
}

#[tauri::command]
async fn export_report(
    report_id: String,
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: State<'_, DesktopState>,
) -> Result<Value, AppError> {
    let engine = state.engine.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let report = engine.execute(Request {
            command: "get_daily_report".into(),
            payload: json!({"reportId": report_id}),
        })?;
        let content = report["content"]
            .as_str()
            .ok_or_else(|| app_error("INVALID_REPORT", "日报内容无效。"))?;
        let date = report["date"].as_str().unwrap_or("report");
        if date.len() != 10 || !date.chars().all(|c| c.is_ascii_digit() || c == '-') {
            return Err(app_error("INVALID_REPORT", "日报日期无效。"));
        }
        let version = report["version"].as_i64().unwrap_or(1);
        let filename = format!("日报-{date}-v{version}.md");
        let chosen = app
            .dialog()
            .file()
            .set_parent(&window)
            .add_filter("Markdown", &["md"])
            .set_file_name(&filename)
            .blocking_save_file();
        let Some(chosen) = chosen else {
            return Ok(json!({"cancelled":true}));
        };
        let target = chosen
            .into_path()
            .map_err(|_| app_error("INVALID_PATH", "请选择本地保存位置。"))?;
        std::fs::write(&target, content)
            .map_err(|e| app_error("IO_ERROR", format!("导出失败：{e}")))?;
        Ok(json!({"cancelled":false,"path":target.to_string_lossy()}))
    })
    .await
    .map_err(|e| app_error("EXECUTION_FAILED", format!("导出未完成：{e}")))?
}

#[tauri::command]
async fn copy_report(
    report_id: String,
    app: tauri::AppHandle,
    state: State<'_, DesktopState>,
) -> Result<Value, AppError> {
    let engine = state.engine.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let report = engine.execute(Request {
            command: "get_daily_report".into(),
            payload: json!({"reportId":report_id}),
        })?;
        let content = report["content"]
            .as_str()
            .ok_or_else(|| app_error("INVALID_REPORT", "日报内容无效。"))?;
        app.clipboard()
            .write_text(content.to_string())
            .map_err(|_| app_error("CLIPBOARD", "复制未完成，请导出 Markdown 文件。"))?;
        Ok(json!({"copied":true}))
    })
    .await
    .map_err(|e| app_error("EXECUTION_FAILED", format!("复制未完成：{e}")))?
}

#[tauri::command]
async fn export_coordination_report(
    report_id: String,
    version: i64,
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: State<'_, DesktopState>,
) -> Result<Value, AppError> {
    let engine = state.engine.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let report = engine.execute(Request {
            command: "coordination_get_report".into(),
            payload: json!({"reportId":report_id,"version":version}),
        })?;
        let content = report["content"]
            .as_str()
            .ok_or_else(|| app_error("INVALID_REPORT", "周报内容无效。"))?;
        let filename = format!("项目周报-v{}.md", report["version"].as_i64().unwrap_or(1));
        let chosen = app
            .dialog()
            .file()
            .set_parent(&window)
            .add_filter("Markdown", &["md"])
            .set_file_name(&filename)
            .blocking_save_file();
        let Some(chosen) = chosen else {
            return Ok(json!({"cancelled":true}));
        };
        let target = chosen
            .into_path()
            .map_err(|_| app_error("INVALID_PATH", "请选择本地保存位置。"))?;
        std::fs::write(&target, content)
            .map_err(|e| app_error("IO_ERROR", format!("导出失败：{e}")))?;
        Ok(json!({"cancelled":false,"path":target.to_string_lossy()}))
    })
    .await
    .map_err(|e| app_error("EXECUTION_FAILED", format!("导出未完成：{e}")))?
}

#[tauri::command]
async fn copy_coordination_report(
    report_id: String,
    version: i64,
    app: tauri::AppHandle,
    state: State<'_, DesktopState>,
) -> Result<Value, AppError> {
    let engine = state.engine.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let report = engine.execute(Request {
            command: "coordination_get_report".into(),
            payload: json!({"reportId":report_id,"version":version}),
        })?;
        let content = report["content"]
            .as_str()
            .ok_or_else(|| app_error("INVALID_REPORT", "周报内容无效。"))?;
        app.clipboard()
            .write_text(content.to_string())
            .map_err(|_| app_error("CLIPBOARD", "复制未完成，请导出 Markdown 文件。"))?;
        Ok(json!({"copied":true}))
    })
    .await
    .map_err(|e| app_error("EXECUTION_FAILED", format!("复制未完成：{e}")))?
}

#[tauri::command]
async fn open_feishu_authorization(url: String) -> Result<(), AppError> {
    let parsed = tauri::Url::parse(&url)
        .map_err(|_| app_error("INVALID_AUTHORIZATION_URL", "飞书授权地址无效。"))?;
    if parsed.scheme() != "https"
        || parsed.host_str() != Some("accounts.feishu.cn")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.port().is_some()
    {
        return Err(app_error(
            "INVALID_AUTHORIZATION_URL",
            "仅允许打开飞书官方授权地址。",
        ));
    }
    let target = parsed.as_str();
    #[cfg(target_os = "windows")]
    let mut command = {
        use std::os::windows::process::CommandExt;
        let mut command = std::process::Command::new("rundll32.exe");
        command.args(["url.dll,FileProtocolHandler", target]);
        command.creation_flags(0x08000000);
        command
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = std::process::Command::new("open");
        command.arg(target);
        command
    };
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let mut command = {
        let mut command = std::process::Command::new("xdg-open");
        command.arg(target);
        command
    };
    command.spawn().map_err(|_| {
        app_error(
            "OPEN_BROWSER_FAILED",
            "无法打开浏览器，请复制授权链接后手动打开。",
        )
    })?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let root = match std::env::var_os("PROJECT_ASSISTANT_DATA_DIR") {
                Some(path) => PathBuf::from(path),
                None => app.path().app_data_dir()?.join("workspace"),
            };
            let engine = match Engine::open(&root) {
                Ok(engine) => engine,
                Err(error) => {
                    app.dialog()
                        .message(format!(
                            "{}\n\n工作区位置：{}",
                            error.message,
                            root.display()
                        ))
                        .title("无法打开项目工作区")
                        .blocking_show();
                    return Err(std::io::Error::other(error.message).into());
                }
            };
            runtime::setup(app, engine.clone())?;
            app.manage(DesktopState { engine, root });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if let Some(state) = window.app_handle().try_state::<DesktopState>() {
                    if state
                        .engine
                        .execute(Request {
                            command: "get_desktop_settings".into(),
                            payload: json!({}),
                        })
                        .is_ok_and(|v| v["background"] == true)
                    {
                        api.prevent_close();
                        let _ = window.hide();
                    } else {
                        api.prevent_close();
                        let _ = window.emit("request-quit", ());
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            runtime::desktop_runtime_status,
            runtime::save_runtime_settings,
            runtime::finish_quit,
            runtime::update_application,
            execute,
            export_backup,
            export_report,
            copy_report,
            export_coordination_report,
            copy_coordination_report,
            open_feishu_authorization
        ])
        .run(tauri::generate_context!())
        .expect("无法启动项目助理");
}
