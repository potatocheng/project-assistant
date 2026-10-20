mod ai;
mod assistant_qa;
mod backup;
mod change_control;
mod coordination;
mod db;
mod delivery;
mod feishu;
mod governance;
mod maintenance;
mod management;
mod memory;
mod parse;
mod planning;
mod proactive;
mod qa;
mod settings;
mod tasks;

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
        Self::new("DATABASE", e.to_string())
    }
}
impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        Self::new("IO", e.to_string())
    }
}
impl From<zip::result::ZipError> for AppError {
    fn from(e: zip::result::ZipError) -> Self {
        Self::new("ARCHIVE", e.to_string())
    }
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
pub(crate) fn required<'a>(p: &'a Value, key: &str) -> Result<&'a str> {
    p.get(key)
        .and_then(Value::as_str)
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| AppError::new("VALIDATION", format!("缺少有效字段：{key}")))
}

enum Message {
    Execute(Request, mpsc::Sender<Result<Value>>),
    Claim(String, u64, mpsc::Sender<Result<Option<db::ParseTask>>>),
    Complete(String, u64, i64, Result<Vec<parse::ParsedSegment>>),
    ClaimExtract(String, u64, mpsc::Sender<Result<Option<db::AiTask>>>),
    ProgressExtract(String, u64, i64, usize, usize, mpsc::Sender<bool>),
    CompleteExtract(String, u64, i64, Result<ai::ExtractionResult>),
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
                                        ai::extract(
                                            &task.settings.config(),
                                            task.settings.api_key.as_deref(),
                                            &task.segments,
                                            progress,
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
                ask_project(
                    &question_sender,
                    &question_root,
                    &json!({"projectId":project,"question":question}),
                )
            }),
            Arc::new(move |context| {
                actor_call(
                    &validation_sender,
                    Request {
                        command: "_validate_qa_context".into(),
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
                | "get_memory_maintenance"
                | "get_feishu_status"
                | "get_feishu_sources"
                | "get_daily_planning"
                | "get_delivery_overview"
                | "get_follow_up_center"
                | "get_proactive_center"
                | "get_management_attention"
                | "get_governance_workspace"
                | "get_governance_item"
                | "get_change_acceptance"
                | "coordination_list"
                | "coordination_get_report"
                | "coordination_get_meeting"
                | "get_source"
                | "get_memory"
        ) {
            self.inner.maintenance.touch();
        }
        if request.command == "save_feishu_sources" {
            self.call(Request {
                command: "_validate_feishu_bindings".into(),
                payload: json!({"bindings":request.payload["sources"]}),
            })?;
        }
        if request.command == "test_ai_connection" {
            let settings = settings::load(&self.inner.root)?;
            settings.validate_credentials()?;
            return ai::test_connection(&settings.config(), settings.api_key.as_deref());
        }
        if request.command == "ask_project" {
            return ask_project(&self.inner.sender, &self.inner.root, &request.payload);
        }
        if request.command == "ask_assistant" {
            return assistant_qa::ask(self, &request.payload);
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
}

fn affects_proactive_actions(command: &str) -> bool {
    matches!(command, "restore_backup" | "_ingest_remote")
        || [
            "create_",
            "save_",
            "update_",
            "confirm_",
            "reject_",
            "revise_",
            "record_",
            "remove_",
            "transition_",
            "review_",
            "delete_",
            "coordination_save_",
            "coordination_confirm_",
        ]
        .iter()
        .any(|prefix| command.starts_with(prefix))
}

fn ask_project(sender: &mpsc::SyncSender<Message>, root: &Path, payload: &Value) -> Result<Value> {
    // Take a project-scoped snapshot on the database actor; network I/O stays outside it.
    let configuration = settings::load(root)?;
    let mut context = actor_call(
        sender,
        Request {
            command: "_retrieve_qa_context".into(),
            payload: payload.clone(),
        },
    )?;
    context["modelRevision"] = json!(configuration.revision);
    let answer = qa::answer(&configuration, &context)?;
    actor_call(
        sender,
        Request {
            command: "_validate_qa_context".into(),
            payload: context,
        },
    )?;
    Ok(answer)
}
fn actor_call(sender: &mpsc::SyncSender<Message>, request: Request) -> Result<Value> {
    let (tx, rx) = mpsc::channel();
    sender
        .send(Message::Execute(request, tx))
        .map_err(|_| AppError::new("WORKER", "数据库线程已关闭"))?;
    rx.recv()
        .map_err(|_| AppError::new("WORKER", "数据库线程未返回结果"))?
}
