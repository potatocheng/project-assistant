mod ai;
mod aliases;
mod answer_contract;
mod answer_repair;
mod assistance;
mod assistance_audit;
mod assistance_limits;
mod assistance_review;
#[cfg(test)]
mod assistance_tests;
mod assistant_qa;
mod backup;
mod change_control;
mod conversations;
mod coordination;
mod daily_use;
mod db;
mod delivery;
mod docx_export;
mod evidence_pack;
mod extraction_context;
mod extraction_store;
mod feishu;
mod governance;
mod habits;
mod maintenance;
mod management;
mod memory;
mod memory_audit;
#[cfg(test)]
mod memory_evaluation;
mod memory_facts;
mod memory_links;
mod memory_query;
mod memory_workbench;
mod orchestration;
mod parse;
mod planning;
mod proactive;
mod protection;
mod qa;
mod question_flow;
mod question_plan;
mod question_target;
mod retention;
mod search;
mod semantic;
mod settings;
mod source_passages;
mod tasks;
mod workspace_policy;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fmt,
    fs::{self, File, OpenOptions},
    path::Path,
    sync::{mpsc, Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Request {
    pub command: String,
    #[serde(default = "empty_payload")]
    pub payload: Value,
}
fn empty_payload() -> Value {
    json!({})
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppError {
    pub code: String,
    pub message: String,
}
impl AppError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}
impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for AppError {}
impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        if let rusqlite::Error::SqliteFailure(err, Some(ref msg)) = e {
            if err.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_TRIGGER {
                return Self::new("DATABASE", msg.clone());
            }
        }
        let message = match &e {
            rusqlite::Error::SqliteFailure(err, _) => match err.code {
                rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked => {
                    "本机工作区正忙，请稍后重试"
                }
                rusqlite::ErrorCode::ConstraintViolation => "数据存在重复或冲突，请刷新后重试",
                rusqlite::ErrorCode::ReadOnly => "当前工作区只读，无法写入数据",
                rusqlite::ErrorCode::DiskFull => "磁盘空间不足，无法写入本机数据",
                _ => "本机数据读写出错，请稍后重试",
            },
            _ => "本机数据读写出错，请稍后重试",
        };
        Self::new("DATABASE", message)
    }
}
impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        let message = match e.kind() {
            std::io::ErrorKind::PermissionDenied => {
                "没有该位置的读写权限，请换一个目录或检查系统权限"
            }
            std::io::ErrorKind::NotFound => "找不到目标文件或目录",
            std::io::ErrorKind::AlreadyExists => "目标文件已存在，请更换名称或位置",
            _ => "本地文件读写失败，请检查文件是否被占用或磁盘空间是否充足",
        };
        Self::new("IO", message)
    }
}
impl From<zip::result::ZipError> for AppError {
    fn from(_: zip::result::ZipError) -> Self {
        Self::new("ARCHIVE", "压缩包或办公文档结构损坏，无法读取")
    }
}
pub fn encrypt_backup_bytes(
    bytes: &[u8],
    password: &str,
) -> std::result::Result<Vec<u8>, AppError> {
    protection::encrypt_backup(bytes, password)
}
pub fn markdown_to_docx_bytes(
    title: &str,
    markdown: &str,
) -> std::result::Result<Vec<u8>, AppError> {
    docx_export::markdown_to_docx_bytes(title, markdown)
}
pub fn decode_base64_bytes(encoded: &str) -> std::result::Result<Vec<u8>, AppError> {
    use base64::Engine as _;
    let raw = encoded.split(',').next_back().unwrap_or(encoded).trim();
    base64::engine::general_purpose::STANDARD
        .decode(raw)
        .map_err(|_| AppError::new("VALIDATION", "导出内容编码无效"))
}

pub(crate) type Result<T> = std::result::Result<T, AppError>;
pub(crate) fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
pub(crate) fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
pub(crate) fn hash(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}
/// Unix supports syncing directory entries. Windows does not expose directory
/// FlushFileBuffers through a normal File handle; each written file is synced
/// separately before its rename on that platform.
pub(crate) fn sync_directory(path: &Path) -> Result<()> {
    #[cfg(unix)]
    File::open(path)?.sync_all()?;
    #[cfg(not(unix))]
    if !fs::metadata(path)?.is_dir() {
        return Err(AppError::new("IO", "持久化目录无效"));
    }
    Ok(())
}
pub(crate) fn sync_file(path: &Path) -> Result<()> {
    // FlushFileBuffers on Windows requires a writable handle.
    OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)?
        .sync_all()?;
    Ok(())
}
pub(crate) fn field_label(key: &str) -> &str {
    match key {
        "title" => "标题",
        "content" => "内容",
        "note" => "说明",
        "reason" => "原因",
        "projectId" => "所属项目",
        "sourceId" => "所属资料",
        "taskId" => "任务",
        "workDate" | "date" => "日期",
        "proposalId" => "候选项",
        "memoryId" => "记忆",
        "question" => "问题",
        "name" => "名称",
        "provider" => "模型服务类型",
        "baseUrl" => "模型服务地址",
        "model" => "模型名称",
        "outputFormat" => "输出格式",
        "reportId" => "报告",
        "draftId" => "草案",
        "relationId" => "关系记录",
        "clientRequestId" => "请求标识",
        "id" => "记录标识",
        _ => key,
    }
}
pub(crate) fn required<'a>(p: &'a Value, key: &str) -> Result<&'a str> {
    p.get(key)
        .and_then(Value::as_str)
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| AppError::new("VALIDATION", format!("缺少有效{}", field_label(key))))
}

enum Message {
    Execute(Request, mpsc::Sender<Result<Value>>),
    Claim(String, u64, mpsc::Sender<Result<Option<db::ParseTask>>>),
    Complete(String, u64, i64, Result<Vec<parse::ParsedSegment>>),
    ClaimExtract(String, u64, mpsc::Sender<Result<Option<db::AiTask>>>),
    ProgressExtract(String, u64, i64, usize, usize, mpsc::Sender<bool>),
    CompleteExtract(String, u64, i64, Result<ai::ExtractionResult>),
    CheckpointExtract(
        String,
        u64,
        i64,
        ai::ExtractionCheckpoint,
        mpsc::Sender<bool>,
    ),
    ClaimMaintenance(mpsc::Sender<Result<Option<memory::Task>>>),
    CompleteMaintenance(String, Value, memory::Output, Arc<maintenance::Worker>, u64),
    Shutdown,
}

/// Cloneable handle. Only the dedicated actor thread owns the SQLite connection.
#[derive(Clone)]
pub struct Engine {
    inner: Arc<Inner>,
}
struct Inner {
    sender: mpsc::SyncSender<Message>,
    notify: mpsc::SyncSender<()>,
    ai_notify: mpsc::SyncSender<()>,
    root: std::path::PathBuf,
    actor: Mutex<Option<thread::JoinHandle<()>>>,
    connector: feishu::Connector,
    maintenance: Arc<maintenance::Worker>,
    assistance_cache: Mutex<assistance::Cache>,
    _lock: File,
}
impl Drop for Inner {
    fn drop(&mut self) {
        self.connector.shutdown();
        self.maintenance.stop();
        let _ = self.sender.send(Message::Shutdown);
        if let Ok(handle) = self.actor.get_mut() {
            if let Some(handle) = handle.take() {
                let _ = handle.join();
            }
        }
    }
}
impl Engine {
    pub fn open(root: impl AsRef<Path>) -> Result<Self> {
        let root = root.as_ref().to_path_buf();
        fs::create_dir_all(&root)?;
        let root = fs::canonicalize(root)?;
        let workspace_lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(root.join("workspace.lock"))?;
        workspace_lock.try_lock().map_err(|_| {
            AppError::new(
                "WORKSPACE_LOCKED",
                "工作区已由另一个进程打开，请先关闭该实例",
            )
        })?;
        let (sender, receiver) = mpsc::sync_channel(64);
        let (ai_notify, ai_notified) = mpsc::sync_channel(1);
        let actor_ai_notify = ai_notify.clone();
        let engine_root = root.clone();
        let (ready_tx, ready_rx) = mpsc::channel();
        let actor = thread::Builder::new()
            .name("project-database".into())
            .spawn(move || {
                let mut db = match db::Database::open(root) {
                    Ok(mut db) => {
                        scan_proactive(&mut db);
                        let _ = ready_tx.send(Ok(()));
                        db
                    }
                    Err(error) => {
                        let _ = ready_tx.send(Err(error));
                        return;
                    }
                };
                let mut next_scan = Instant::now() + Duration::from_secs(60);
                loop {
                    let message = match receiver
                        .recv_timeout(next_scan.saturating_duration_since(Instant::now()))
                    {
                        Ok(message) => message,
                        Err(mpsc::RecvTimeoutError::Timeout) => {
                            scan_proactive(&mut db);
                            next_scan = Instant::now() + Duration::from_secs(60);
                            continue;
                        }
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    };
                    match message {
                        Message::Execute(request, reply) => {
                            let rescan = affects_proactive_actions(&request.command);
                            let result = db.execute(request);
                            if rescan && result.is_ok() {
                                scan_proactive(&mut db);
                            }
                            let _ = reply.send(result);
                        }
                        Message::Claim(job, epoch, reply) => {
                            let _ = reply.send(db.claim(&job, epoch));
                        }
                        Message::Complete(job, epoch, generation, result) => {
                            if let Err(error) = db.complete(&job, epoch, generation, result) {
                                eprintln!("import persistence: {error}");
                            }
                            let _ = actor_ai_notify.try_send(());
                            scan_proactive(&mut db);
                        }
                        Message::ClaimExtract(job, epoch, reply) => {
                            let _ = reply.send(db.claim_extract(&job, epoch));
                        }
                        Message::ProgressExtract(job, epoch, generation, done, total, reply) => {
                            let alive = db
                                .progress_extract(&job, epoch, generation, done, total)
                                .unwrap_or(false);
                            let _ = reply.send(alive);
                        }
                        Message::CheckpointExtract(job, epoch, generation, checkpoint, reply) => {
                            let saved = crate::extraction_store::persist(
                                &mut db,
                                &job,
                                epoch,
                                generation,
                                &checkpoint,
                            )
                            .unwrap_or(false);
                            let _ = reply.send(saved);
                        }
                        Message::CompleteExtract(job, epoch, generation, result) => {
                            if let Err(error) = db.complete_extract(&job, epoch, generation, result)
                            {
                                eprintln!("AI persistence: {}", error.code);
                            }
                            scan_proactive(&mut db);
                        }
                        Message::ClaimMaintenance(reply) => {
                            let _ = reply.send(db.claim_maintenance());
                        }
                        Message::CompleteMaintenance(run, guard, output, activity, generation) => {
                            if !activity.is_current(generation) {
                                let job = match &output {
                                    memory::Output::Extract(job, ..) => Some(job.as_str()),
                                    _ => None,
                                };
                                let _ = db.cancel_memory_run(&run, job);
                                continue;
                            }
                            if let Err(e) = db.finish_maintenance(&run, &guard, output) {
                                eprintln!("memory persistence: {}", e.code);
                            }
                            scan_proactive(&mut db);
                        }
                        Message::Shutdown => break,
                    }
                    // Keep a fixed deadline even when polling or business writes
                    // keep the actor busy; recv_timeout alone would reset it.
                    if Instant::now() >= next_scan {
                        scan_proactive(&mut db);
                        next_scan = Instant::now() + Duration::from_secs(60);
                    }
                }
            })?;
        ready_rx
            .recv()
            .map_err(|_| AppError::new("WORKER", "数据库线程启动失败"))??;
        let (notify, notified) = mpsc::sync_channel(1);
        let worker_sender = sender.clone();
        thread::Builder::new()
            .name("document-parser".into())
            .spawn(move || {
                while notified.recv().is_ok() {
                    loop {
                        let pending = match actor_call(
                            &worker_sender,
                            Request {
                                command: "_pending".into(),
                                payload: json!({}),
                            },
                        ) {
                            Ok(value) => value,
                            Err(_) => return,
                        };
                        let Some(item) = pending.as_array().and_then(|items| items.first()) else {
                            break;
                        };
                        let job = item["id"].as_str().unwrap_or_default().to_owned();
                        let epoch = item["epoch"].as_u64().unwrap_or_default();
                        let (tx, rx) = mpsc::channel();
                        if worker_sender
                            .send(Message::Claim(job.clone(), epoch, tx))
                            .is_err()
                        {
                            return;
                        }
                        match rx.recv() {
                            Ok(Ok(Some(task))) => {
                                let result = std::panic::catch_unwind(|| {
                                    parse::parse_file(&task.path, &task.kind)
                                })
                                .unwrap_or_else(|_| {
                                    Err(AppError::new(
                                        "PARSER",
                                        "资料解析失败，请尝试其他文件或粘贴文本",
                                    ))
                                });
                                if worker_sender
                                    .send(Message::Complete(job, epoch, task.generation, result))
                                    .is_err()
                                {
                                    return;
                                }
                            }
                            Ok(Ok(None)) => continue,
                            Ok(Err(error)) => {
                                eprintln!("import claim: {error}");
                                break;
                            }
                            Err(_) => return,
                        }
                    }
                }
            })?;
        let ai_sender = sender.clone();
        thread::Builder::new()
            .name("ai-extractor".into())
            .spawn(move || {
                while ai_notified.recv().is_ok() {
                    loop {
                        let pending = match actor_call(
                            &ai_sender,
                            Request {
                                command: "_pending_extract".into(),
                                payload: json!({}),
                            },
                        ) {
                            Ok(value) => value,
                            Err(_) => return,
                        };
                        let Some(item) = pending.as_array().and_then(|items| items.first()) else {
                            break;
                        };
                        let job = item["id"].as_str().unwrap_or_default().to_owned();
                        let epoch = item["epoch"].as_u64().unwrap_or_default();
                        let (tx, rx) = mpsc::channel();
                        if ai_sender
                            .send(Message::ClaimExtract(job.clone(), epoch, tx))
                            .is_err()
                        {
                            return;
                        }
                        match rx.recv() {
                            Ok(Ok(Some(task))) => {
                                let progress = |done, total| {
                                    let (tx, rx) = mpsc::channel();
                                    if ai_sender
                                        .send(Message::ProgressExtract(
                                            job.clone(),
                                            epoch,
                                            task.generation,
                                            done,
                                            total,
                                            tx,
                                        ))
                                        .is_err()
                                    {
                                        return false;
                                    }
                                    rx.recv().unwrap_or(false)
                                };
                                let result =
                                    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                                        ai::extract_with_context(
                                            &task.settings.config(),
                                            task.settings.api_key.as_deref(),
                                            &task.segments,
                                            &task.checkpoints,
                                            &task.project_context,
                                            progress,
                                            |checkpoint| {
                                                let (tx, rx) = mpsc::channel();
                                                if ai_sender
                                                    .send(Message::CheckpointExtract(
                                                        job.clone(),
                                                        epoch,
                                                        task.generation,
                                                        checkpoint.clone(),
                                                        tx,
                                                    ))
                                                    .is_err()
                                                {
                                                    return false;
                                                }
                                                rx.recv().unwrap_or(false)
                                            },
                                        )
                                    }))
                                    .unwrap_or_else(|_| {
                                        Err(AppError::new("AI_WORKER", "AI 提取异常，可重试"))
                                    });
                                if ai_sender
                                    .send(Message::CompleteExtract(
                                        job,
                                        epoch,
                                        task.generation,
                                        result,
                                    ))
                                    .is_err()
                                {
                                    return;
                                }
                            }
                            Ok(Ok(None)) => continue,
                            Ok(Err(error)) => {
                                eprintln!("AI claim: {}", error.code);
                                break;
                            }
                            Err(_) => return,
                        }
                    }
                }
            })?;
        let question_sender = sender.clone();
        let question_root = engine_root.clone();
        let validation_sender = sender.clone();
        let connector = match feishu::Connector::open(
            engine_root.clone(),
            Arc::new(move |project, question| {
                assistant_qa::ask_project_question(
                    &question_sender,
                    &question_root,
                    &json!({"projectId":project,"question":question}),
                )
            }),
            Arc::new(move |context| {
                actor_call(
                    &validation_sender,
                    Request {
                        command: "_validate_assistant_context".into(),
                        payload: context.clone(),
                    },
                )
                .map(|_| ())
            }),
        ) {
            Ok(connector) => connector,
            Err(error) => {
                let _ = sender.send(Message::Shutdown);
                let _ = actor.join();
                return Err(error);
            }
        };
        let maintenance = maintenance::Worker::start(sender.clone(), engine_root.clone())?;
        let ingest_sender = sender.clone();
        let ingest_notify = notify.clone();
        connector.set_ingest(Arc::new(move |payload| {
            let result = actor_call(
                &ingest_sender,
                Request {
                    command: "_ingest_remote".into(),
                    payload: payload.clone(),
                },
            )?;
            let _ = ingest_notify.try_send(());
            Ok(result)
        }))?;
        let engine = Self {
            inner: Arc::new(Inner {
                sender,
                notify,
                ai_notify,
                root: engine_root,
                actor: Mutex::new(Some(actor)),
                connector,
                maintenance,
                assistance_cache: Mutex::new(assistance::Cache::new()),
                _lock: workspace_lock,
            }),
        };
        engine.schedule();
        Ok(engine)
    }
    pub fn execute(&self, request: Request) -> Result<Value> {
        if request.command.starts_with('_') {
            return Err(AppError::new("UNKNOWN_COMMAND", "未知操作"));
        }
        if request.command == "memory_activity" {
            self.inner.maintenance.touch();
            return Ok(json!({"ok":true}));
        }
        if request.command == "run_memory_maintenance" {
            self.inner.maintenance.run_now();
            return Ok(json!({"queued":true}));
        }
        if !matches!(
            request.command.as_str(),
            "get_state"
                | "get_usage_summary"
                | "get_diagnostics"
                | "get_desktop_settings"
                | "get_notification_digest"
                | "ack_notification"
                | "get_backup_policy"
                | "run_automatic_backup"
                | "get_workspace_revision"
                | "get_draft"
                | "save_draft"
                | "delete_draft"
                | "get_retention_reviews"
                | "lifecycle_impact"
                | "get_memory_maintenance"
                | "get_project_brief"
                | "get_assistant_preferences"
                | "get_memory_quality"
                | "get_feishu_status"
                | "get_feishu_sources"
                | "check_feishu_permissions"
                | "dismiss_feishu_notification"
                | "get_daily_planning"
                | "get_delivery_overview"
                | "get_follow_up_center"
                | "get_proactive_center"
                | "get_assistant_work"
                | "get_action_proposal"
                | "get_assistance_runs"
                | "get_management_attention"
                | "get_governance_workspace"
                | "get_governance_item"
                | "get_change_acceptance"
                | "coordination_list"
                | "coordination_get_report"
                | "coordination_get_meeting"
                | "get_source"
                | "get_memory"
                | "list_entity_aliases"
                | "search_verified_memories"
                | "get_semantic_search_status"
                | "get_habits_center"
                | "get_memory_audits"
        ) {
            self.inner.maintenance.touch();
        }
        if request.command == "save_feishu_sources" {
            self.call(Request {
                command: "_validate_feishu_bindings".into(),
                payload: json!({"bindings":request.payload["sources"]}),
            })?;
        }
        if request.command == "get_credential_protection" {
            return Ok(
                json!({"enabled":protection::enabled(&self.inner.root),"supported":cfg!(any(target_os="windows",target_os="macos"))}),
            );
        }
        if request.command == "enable_credential_protection" {
            self.inner.connector.pause()?;
            protection::enable(&self.inner.root)?;
            return Ok(json!({"enabled":true}));
        }
        if request.command == "test_ai_connection" {
            let settings = settings::preview_for_test(&self.inner.root, &request.payload)?;
            settings.validate_credentials()?;
            return ai::test_connection(&settings.config(), settings.api_key.as_deref());
        }
        if request.command == "rank_copilot_habits" {
            return semantic::rank_copilot_habits(&self.inner.root, &request.payload);
        }
        if request.command == "copilot_agent_turn" {
            let settings = settings::load(&self.inner.root)?;
            settings.validate_material_access()?;
            return ai::complete_agent_turn(
                &settings.config(),
                settings.api_key.as_deref(),
                request.payload["messages"].clone(),
                request.payload["tools"].clone(),
            );
        }
        if request.command == "polish_report" {
            let settings = settings::load(&self.inner.root)?;
            settings.validate_material_access()?;
            let preferences = self
                .call(Request {
                    command: "get_assistant_preferences".into(),
                    payload: json!({}),
                })
                .ok();
            let writing_habits = self
                .call(Request {
                    command: "_writing_habits".into(),
                    payload: json!({
                        "projectId": request.payload.get("projectId").cloned().unwrap_or(Value::Null),
                        "context": format!(
                            "{} {} {}",
                            request.payload["reportType"].as_str().unwrap_or(""),
                            request.payload["style"].as_str().unwrap_or(""),
                            request.payload["projectName"].as_str().unwrap_or("")
                        ),
                    }),
                })
                .ok()
                .and_then(|v| v["habits"].as_array().cloned())
                .unwrap_or_default();
            return ai::polish_report(
                &settings.config(),
                settings.api_key.as_deref(),
                required(&request.payload, "content")?,
                required(&request.payload, "reportType")?,
                required(&request.payload, "style")?,
                request.payload["projectName"]
                    .as_str()
                    .unwrap_or("全部项目"),
                request.payload["dateLabel"].as_str().unwrap_or(""),
                preferences.as_ref(),
                &writing_habits,
            );
        }
        if request.command == "get_semantic_search_status" {
            let active = self
                .call(Request {
                    command: "_semantic_active_memories".into(),
                    payload: request.payload.clone(),
                })
                .ok()
                .and_then(|v| v["count"].as_i64());
            return semantic::status(&self.inner.root, active);
        }
        if request.command == "save_semantic_search_settings" {
            return semantic::save_settings(&self.inner.root, &request.payload);
        }
        if request.command == "test_embedding_connection" {
            return semantic::test_connection(&self.inner.root);
        }
        if request.command == "rebuild_semantic_index" {
            let active = self.call(Request {
                command: "_semantic_active_memories".into(),
                payload: request.payload.clone(),
            })?;
            let inputs = semantic::ActiveMemoryInput::from_values(
                active["memories"]
                    .as_array()
                    .map(Vec::as_slice)
                    .unwrap_or(&[]),
            );
            return semantic::rebuild_index(
                &self.inner.root,
                semantic::project_scope(&request.payload),
                &inputs,
            );
        }
        if request.command == "search_verified_memories" {
            let enriched =
                enrich_payload_with_semantic(&self.inner.sender, &self.inner.root, request.payload);
            return self.call(Request {
                command: "_search_verified_memories".into(),
                payload: enriched,
            });
        }
        if request.command == "ask_project" {
            return ask_project(&self.inner.sender, &self.inner.root, &request.payload);
        }
        if request.command == "ask_project_question" {
            return assistant_qa::ask_project_question(
                &self.inner.sender,
                &self.inner.root,
                &request.payload,
            );
        }
        if request.command == "ask_conversation" {
            return conversations::ask(self, &request.payload);
        }
        if request.command == "ask_assistant" {
            return assistant_qa::ask(self, &request.payload);
        }
        if matches!(
            request.command.as_str(),
            "generate_today_brief" | "generate_task_coaching"
        ) {
            return assistance::run(self, &request.command, &request.payload);
        }
        if request.command == "analyze_task_workload" {
            let configuration = settings::load(&self.inner.root)?;
            let snapshot = self.call(Request {
                command: "_planning_snapshot".into(),
                payload: request.payload.clone(),
            })?;
            if snapshot["modelRevision"] != configuration.revision {
                return Err(AppError::new(
                    "PLANNING_STALE",
                    "模型配置已变化，请重新整理",
                ));
            }
            let result = planning::analyze(
                &configuration,
                &snapshot,
                request.payload["useModel"].as_bool().unwrap_or(true),
            )?;
            return self.call(Request {
                command: "_save_planning_draft".into(),
                payload: json!({"kind":"analysis","snapshot":snapshot,"result":result}),
            });
        }
        if request.command == "save_feishu_settings" {
            // A chat may only be bound to an existing project in this workspace.
            self.call(Request {
                command: "_validate_feishu_bindings".into(),
                payload: request.payload.clone(),
            })?;
        }
        if request.command == "restore_backup" {
            // Restore pauses delivery until the user reviews the restored projects.
            self.inner.connector.pause()?;
        }
        if request.command == "save_ai_settings" {
            self.inner.connector.invalidate()?;
        }
        if request.command == "get_notification_digest" {
            let mut payload = request.payload.clone();
            if let Some((title, body, signature)) = self.inner.connector.pending_notification() {
                if !payload.is_object() {
                    payload = json!({});
                }
                payload["feishuNotification"] =
                    json!({"title": title, "body": body, "signature": signature});
            }
            return self.call(Request {
                command: request.command,
                payload,
            });
        }
        if let Some(result) = self
            .inner
            .connector
            .handle(&request.command, &request.payload)
        {
            return result;
        }
        let schedule = matches!(
            request.command.as_str(),
            "import_text"
                | "import_file"
                | "restore_backup"
                | "start_extraction"
                | "retry_extraction"
                | "save_ai_settings"
        );
        let result = self.call(request)?;
        if schedule {
            self.schedule();
        }
        Ok(result)
    }
    fn call(&self, request: Request) -> Result<Value> {
        actor_call(&self.inner.sender, request)
    }
    fn schedule(&self) {
        let _ = self.inner.notify.try_send(());
        let _ = self.inner.ai_notify.try_send(());
    }
}
fn scan_proactive(db: &mut db::Database) {
    if let Err(error) = db.execute(Request {
        command: "_proactive_tick".into(),
        payload: json!({}),
    }) {
        // A scan must not turn a successfully recorded user action into an
        // apparent failure. The proactive module persists its own diagnostics.
        eprintln!("proactive scan: {}", error.code);
    }
    if let Err(error) = db.execute(Request {
        command: "_assistant_work_tick".into(),
        payload: json!({}),
    }) {
        eprintln!("assistant work scan: {}", error.code);
    }
}

fn affects_proactive_actions(command: &str) -> bool {
    matches!(
        command,
        "restore_backup"
            | "_ingest_remote"
            | "set_lifecycle"
            | "decide_action_proposal"
            | "pause_assistant_work"
            | "resolve_memory_review"
            | "recompare_memory_review"
    ) || [
        "create_",
        "save_",
        "update_",
        "confirm_",
        "reject_",
        "revise_",
        "record_",
        "remove_",
        "reopen_",
        "restore_",
        "transition_",
        "review_",
        "delete_",
        "coordination_save_",
        "coordination_confirm_",
    ]
    .iter()
    .any(|prefix| command.starts_with(prefix))
}

pub fn is_public_command(command: &str) -> bool {
    matches!(
        command,
        "get_state"
            | "get_usage_summary"
            | "get_diagnostics"
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
            | "reopen_proposal"
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
            | "review_extraction_draft"
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
            | "restore_task_relation"
            | "analyze_task_workload"
            | "generate_daily_plan"
            | "confirm_planning_draft"
            | "dismiss_planning_draft"
            | "reopen_planning_draft"
            | "update_task_proposal"
            | "confirm_task_proposal"
            | "reject_task_proposal"
            | "reopen_task_proposal"
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
            | "get_assistant_work"
            | "get_action_proposal"
            | "decide_action_proposal"
            | "pause_assistant_work"
            | "save_assistant_work_settings"
            | "run_assistant_work"
            | "get_assistance_runs"
            | "run_proactive_scan"
            | "save_proactive_settings"
            | "update_proactive_action"
            | "record_follow_up"
            | "snooze_follow_up"
            | "get_feishu_status"
            | "save_feishu_settings"
            | "begin_feishu_authorization"
            | "begin_feishu_connection"
            | "check_feishu_permissions"
            | "dismiss_feishu_notification"
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
            | "copilot_agent_turn"
            | "rank_copilot_habits"
            | "polish_report"
            | "list_entity_aliases"
            | "save_entity_alias"
            | "delete_entity_alias"
            | "get_habits_center"
            | "resolve_habit_proposal"
            | "save_user_habit"
            | "update_habit_status"
            | "delete_user_habit"
            | "record_copilot_feedback"
            | "record_habit_outcome"
            | "get_memory_audits"
            | "run_memory_audit"
            | "resolve_memory_audit"
            | "get_semantic_search_status"
            | "save_semantic_search_settings"
            | "test_embedding_connection"
            | "rebuild_semantic_index"
            | "search_verified_memories"
    )
}

pub(crate) fn enrich_payload_with_semantic(
    sender: &mpsc::SyncSender<Message>,
    root: &Path,
    mut payload: Value,
) -> Value {
    let Ok(config) = semantic::load_settings(root) else {
        return payload;
    };
    if !config.enabled {
        return payload;
    }
    let query_text = payload["question"]
        .as_str()
        .or_else(|| payload["query"].as_str())
        .unwrap_or("")
        .trim()
        .to_owned();
    if query_text.is_empty() {
        return payload;
    }
    let scope = semantic::project_scope(&payload);
    let scope_payload = json!({"projectId": scope});
    let Ok(active) = actor_call(
        sender,
        Request {
            command: "_semantic_active_memories".into(),
            payload: scope_payload,
        },
    ) else {
        return payload;
    };
    let inputs = semantic::ActiveMemoryInput::from_values(
        active["memories"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or(&[]),
    );
    let outcome = semantic::query_hits(root, scope, &query_text, &inputs, 64);
    if let Some(obj) = payload.as_object_mut() {
        obj.insert(
            "_semanticHits".into(),
            json!(outcome
                .hits
                .into_iter()
                .map(|(id, dist)| json!([id, dist]))
                .collect::<Vec<_>>()),
        );
        obj.insert("_semanticTrace".into(), outcome.trace);
    }
    payload
}

fn ask_project(sender: &mpsc::SyncSender<Message>, root: &Path, payload: &Value) -> Result<Value> {
    // Take a project-scoped snapshot on the database actor; network I/O stays outside it.
    let configuration = settings::load(root)?;
    question_flow::run(
        &configuration,
        payload,
        false,
        |payload| {
            let enriched = enrich_payload_with_semantic(sender, root, payload);
            actor_call(
                sender,
                Request {
                    command: "_retrieve_qa_context".into(),
                    payload: enriched,
                },
            )
        },
        |context| {
            actor_call(
                sender,
                Request {
                    command: "_validate_qa_context".into(),
                    payload: context.clone(),
                },
            )
            .map(|_| ())
        },
    )
}
fn actor_call(sender: &mpsc::SyncSender<Message>, request: Request) -> Result<Value> {
    let (tx, rx) = mpsc::channel();
    sender
        .send(Message::Execute(request, tx))
        .map_err(|_| AppError::new("WORKER", "数据库线程已关闭"))?;
    rx.recv()
        .map_err(|_| AppError::new("WORKER", "数据库线程未返回结果"))?
}
