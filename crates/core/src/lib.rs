mod ai;
mod backup;
mod db;
mod parse;
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
    _lock: File,
}
impl Drop for Inner {
    fn drop(&mut self) {
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
                    Ok(db) => {
                        let _ = ready_tx.send(Ok(()));
                        db
                    }
                    Err(error) => {
                        let _ = ready_tx.send(Err(error));
                        return;
                    }
                };
                for message in receiver {
                    match message {
                        Message::Execute(request, reply) => {
                            let _ = reply.send(db.execute(request));
                        }
                        Message::Claim(job, epoch, reply) => {
                            let _ = reply.send(db.claim(&job, epoch));
                        }
                        Message::Complete(job, epoch, generation, result) => {
                            if let Err(error) = db.complete(&job, epoch, generation, result) {
                                eprintln!("import persistence: {error}");
                            }
                            let _ = actor_ai_notify.try_send(());
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
                        }
                        Message::Shutdown => break,
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
        let engine = Self {
            inner: Arc::new(Inner {
                sender,
                notify,
                ai_notify,
                root: engine_root,
                actor: Mutex::new(Some(actor)),
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
        if request.command == "test_ai_connection" {
            let settings = settings::load(&self.inner.root)?;
            settings.validate_credentials()?;
            return ai::test_connection(&settings.config(), settings.api_key.as_deref());
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
fn actor_call(sender: &mpsc::SyncSender<Message>, request: Request) -> Result<Value> {
    let (tx, rx) = mpsc::channel();
    sender
        .send(Message::Execute(request, tx))
        .map_err(|_| AppError::new("WORKER", "数据库线程已关闭"))?;
    rx.recv()
        .map_err(|_| AppError::new("WORKER", "数据库线程未返回结果"))?
}
