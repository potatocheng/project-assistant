//! Personal-account Feishu connector. No tenant/bot token is ever requested.
//!
//! Protocol references (checked 2026-10-19):
//! - open.feishu.cn/document/authentication-management/access-token/obtain-oauth-code.md
//!   currently directs PKCE authorization-code clients to the v2 token endpoint.
//! - .../get-user-access-token.md and .../refresh-user-access-token-v3.md
//! - github.com/larksuite/cli/shortcuts/im/{im_messages_search,helpers,
//!   im_messages_reply,im_chat_search}.go (MIT): wire formats, not a CLI dependency.
use crate::{id, now, AppError, Result};
mod knowledge;
use base64::Engine as _;
use reqwest::{blocking::Client, Method, Url};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex, MutexGuard, Weak,
    },
    thread,
    time::{Duration, Instant},
};

pub(crate) type Ask = Arc<dyn Fn(&str, &str) -> Result<Value> + Send + Sync>;
pub(crate) type Validate = Arc<dyn Fn(&Value) -> Result<()> + Send + Sync>;
const REDIRECT_URI: &str = "http://127.0.0.1:17179/feishu/callback";
const API_BASE: &str = "https://open.feishu.cn";
const SCOPES: &str = "offline_access search:message im:message.p2p_msg:get_as_user im:message.group_msg:get_as_user im:message im:message.send_as_user im:chat:read docx:document:readonly wiki:wiki:readonly";
const RESPONSE_LIMIT: u64 = 4 * 1024 * 1024;
const OVERLAP_SECONDS: i64 = 900;

fn error(code: &str, message: &str) -> AppError {
    AppError::new(code, message)
}
fn timestamp() -> i64 {
    chrono::Utc::now().timestamp()
}
fn iso(seconds: i64) -> String {
    chrono::DateTime::from_timestamp(seconds, 0)
        .unwrap_or_default()
        .to_rfc3339()
}
fn lock<T>(mutex: &Mutex<T>) -> Result<MutexGuard<'_, T>> {
    mutex
        .lock()
        .map_err(|_| error("FEISHU_INTERNAL", "飞书连接器状态不可用，请重启应用"))
}
fn valid_id(value: &str, prefix: &str) -> bool {
    value.starts_with(prefix)
        && value.len() > prefix.len()
        && value.len() <= 160
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

#[derive(Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum ChatType {
    #[default]
    Group,
    P2p,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Binding {
    chat_id: String,
    project_id: String,
    enabled: bool,
    #[serde(default)]
    chat_type: ChatType,
    #[serde(default)]
    peer_id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    since: i64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct User {
    open_id: String,
    name: String,
}
// Secrets intentionally do not implement Debug and are never exposed via public status.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Session {
    access_token: String,
    refresh_token: String,
    expires_at: i64,
    refresh_expires_at: i64,
    scope: String,
    user: User,
    #[serde(default)]
    invalid: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Saved {
    app_id: String,
    app_secret: Option<String>,
    enabled: bool,
    poll_interval_seconds: u64,
    reply_prefix: String,
    bindings: Vec<Binding>,
    session: Option<Session>,
    generation: String,
    active_since: i64,
    knowledge: knowledge::Config,
}
impl Default for Saved {
    fn default() -> Self {
        Self {
            app_id: String::new(),
            app_secret: None,
            enabled: false,
            poll_interval_seconds: 60,
            reply_prefix: "个人助理代答：\n".into(),
            bindings: vec![],
            session: None,
            generation: id(),
            active_since: timestamp(),
            knowledge: knowledge::Config::default(),
        }
    }
}
#[derive(Clone)]
struct PendingAuthorization {
    state: String,
    verifier: String,
    url: String,
    expires_at: i64,
    generation: String,
    expected_user: Option<String>,
}
struct State {
    saved: Saved,
    authorization: Option<PendingAuthorization>,
    polling: bool,
    last_poll_at: Option<String>,
    last_error: Option<String>,
}

struct Api {
    client: Client,
    // Only test constructors may change these fixed destinations.
    base: String,
    exchange: String,
    refresh: String,
    last_request: Mutex<Option<Instant>>,
}
impl Api {
    fn production() -> Result<Self> {
        let client = Client::builder()
            .timeout(Duration::from_secs(25))
            .connect_timeout(Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| error("FEISHU_HTTP", "无法初始化飞书网络连接"))?;
        Ok(Self {
            client,
            base: API_BASE.into(),
            exchange: format!("{API_BASE}/open-apis/authen/v2/oauth/token"),
            refresh: "https://accounts.feishu.cn/oauth/v3/token".into(),
            last_request: Mutex::new(None),
        })
    }
    fn json(
        &self,
        method: Method,
        path: &str,
        query: &[(String, String)],
        token: Option<&str>,
        body: Option<&Value>,
    ) -> Result<Value> {
        let mut url = Url::parse(&format!("{}{path}", self.base))
            .map_err(|_| error("FEISHU_HTTP", "飞书请求地址无效"))?;
        if !query.is_empty() {
            url.query_pairs_mut()
                .extend_pairs(query.iter().map(|(k, v)| (k, v)));
        }
        let read_only = method == Method::GET
            || [
                "/open-apis/im/v1/messages/search",
                "/open-apis/im/v2/chats/search",
                "/open-apis/im/v1/chats/batch_query",
            ]
            .contains(&path);
        // Only reads may retry transient transport errors. Token rotations and
        // message sends are deliberately never retried by the HTTP layer.
        for attempt in 0..3 {
            match self.perform_request(method.clone(), url.clone(), token, body) {
                Ok(value) => return Ok(value.get("data").cloned().unwrap_or(value)),
                Err(e) if read_only && attempt < 2 && e.code == "FEISHU_NETWORK" => {
                    thread::sleep(Duration::from_millis(50))
                }
                Err(e) => return Err(e),
            }
        }
        unreachable!()
    }
    fn token(&self, refresh: bool, body: &Value) -> Result<Value> {
        // JSON is explicitly supported by both Feishu token endpoint versions.
        let url = Url::parse(if refresh {
            &self.refresh
        } else {
            &self.exchange
        })
        .map_err(|_| error("FEISHU_HTTP", "飞书授权地址无效"))?;
        self.perform_request(Method::POST, url, None, Some(body))
    }
    fn perform_request(
        &self,
        method: Method,
        url: Url,
        token: Option<&str>,
        body: Option<&Value>,
    ) -> Result<Value> {
        if url.host_str() == Some("open.feishu.cn") {
            let mut last = lock(&self.last_request)?;
            if let Some(at) = *last {
                if let Some(delay) = Duration::from_millis(250).checked_sub(at.elapsed()) {
                    thread::sleep(delay);
                }
            }
            *last = Some(Instant::now());
        }
        let mut request = self.client.request(method, url);
        if let Some(token) = token {
            request = request.bearer_auth(token);
        }
        if let Some(body) = body {
            request = request.json(body);
        }
        self.response(request.send())
    }
    fn response(
        &self,
        response: std::result::Result<reqwest::blocking::Response, reqwest::Error>,
    ) -> Result<Value> {
        let response = response.map_err(|_| {
            error(
                "FEISHU_NETWORK",
                "飞书请求失败或超时，请检查网络；发送结果不确定时不会自动重发",
            )
        })?;
        let status = response.status();
        if response
            .content_length()
            .is_some_and(|n| n > RESPONSE_LIMIT)
        {
            return Err(error("FEISHU_RESPONSE", "飞书响应超过大小限制"));
        }
        let mut bytes = Vec::new();
        response
            .take(RESPONSE_LIMIT + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| {
                error(
                    "FEISHU_NETWORK",
                    "读取飞书响应失败；发送结果不确定时不会自动重发",
                )
            })?;
        if bytes.len() as u64 > RESPONSE_LIMIT {
            return Err(error("FEISHU_RESPONSE", "飞书响应超过大小限制"));
        }
        let value: Value = serde_json::from_slice(&bytes)
            .map_err(|_| error("FEISHU_RESPONSE", "飞书返回了无效响应"))?;
        self.checked(status, value)
    }
    fn checked(&self, status: reqwest::StatusCode, value: Value) -> Result<Value> {
        let code = value["code"].as_i64().unwrap_or(0);
        if !status.is_success() || code != 0 || value.get("error").is_some() {
            if status.as_u16() == 401
                || [
                    20003, 20004, 20005, 20021, 20022, 20023, 20024, 20026, 20037, 20064, 20065,
                    20073, 99991661, 99991663, 99991664, 99991668, 99991669, 99991671,
                ]
                .contains(&code)
            {
                return Err(error(
                    "FEISHU_AUTH_EXPIRED",
                    "飞书个人授权已失效，请重新授权",
                ));
            }
            if status.as_u16() == 403 || [20010, 20027, 20068, 99991672, 99991679].contains(&code) {
                return Err(error(
                    "FEISHU_PERMISSION",
                    "飞书权限不足，请检查应用权限、发布状态及个人授权",
                ));
            }
            // Do not copy server messages: they may contain credentials or chat content.
            return Err(AppError::new(
                "FEISHU_API",
                format!(
                    "飞书接口请求失败（HTTP {}，错误码 {}），请检查应用配置和权限",
                    status.as_u16(),
                    code
                ),
            ));
        }
        Ok(value)
    }
}

pub(crate) struct Connector {
    inner: Arc<Inner>,
}
struct Inner {
    root: PathBuf,
    state: Mutex<State>,
    receipts: Mutex<Connection>,
    // Mutations and final send share a gate. A send already on the wire finishes
    // before a disabling mutation returns and its result remains in the journal.
    send_gate: Mutex<()>,
    credential_gate: Mutex<()>,
    api: Api,
    ask: Ask,
    validate: Validate,
    wake: mpsc::SyncSender<()>,
    stopped: AtomicBool,
    listener_active: AtomicBool,
    ingest: Mutex<Option<knowledge::Ingest>>,
    syncing: AtomicBool,
}
impl Connector {
    pub(crate) fn open(root: PathBuf, ask: Ask, validate: Validate) -> Result<Self> {
        Self::create(root, ask, validate, Api::production()?, true)
    }
    fn create(
        root: PathBuf,
        ask: Ask,
        validate: Validate,
        api: Api,
        background: bool,
    ) -> Result<Self> {
        let saved = load_saved(&root)?;
        let path = root.join("feishu-runtime.sqlite");
        reject_symlink(&path)?;
        let db = Connection::open(path)?;
        db.busy_timeout(Duration::from_secs(5))?;
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS receipts (
              id TEXT PRIMARY KEY, account TEXT NOT NULL, message_id TEXT NOT NULL,
              chat_id TEXT NOT NULL, project_id TEXT NOT NULL, question TEXT NOT NULL,
              answer TEXT, status TEXT NOT NULL, error TEXT, generation TEXT NOT NULL,
              uuid TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
              reply_id TEXT, UNIQUE(account,message_id));
            UPDATE receipts SET status='unknown', error='应用在发送期间退出，结果未知，不会自动重发', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE status='sending';
            UPDATE receipts SET status='pending' WHERE status='generating';")?;
        let columns: HashSet<String> = db
            .prepare("PRAGMA table_info(receipts)")?
            .query_map([], |row| row.get(1))?
            .collect::<std::result::Result<_, _>>()?;
        for (column, definition) in [
            ("chat_type", "TEXT NOT NULL DEFAULT 'group'"),
            ("peer_id", "TEXT NOT NULL DEFAULT ''"),
            ("peer_name", "TEXT NOT NULL DEFAULT ''"),
        ] {
            if !columns.contains(column) {
                db.execute_batch(&format!(
                    "ALTER TABLE receipts ADD COLUMN {column} {definition}"
                ))?;
            }
        }
        let (wake, receiver) = mpsc::sync_channel(1);
        let inner = Arc::new(Inner {
            root,
            state: Mutex::new(State {
                saved,
                authorization: None,
                polling: false,
                last_poll_at: None,
                last_error: None,
            }),
            receipts: Mutex::new(db),
            send_gate: Mutex::new(()),
            credential_gate: Mutex::new(()),
            api,
            ask,
            validate,
            wake,
            stopped: AtomicBool::new(false),
            listener_active: AtomicBool::new(false),
            ingest: Mutex::new(None),
            syncing: AtomicBool::new(false),
        });
        if background {
            let weak = Arc::downgrade(&inner);
            thread::Builder::new()
                .name("feishu-personal-connector".into())
                .spawn(move || worker(weak, receiver))?;
            let knowledge_weak = Arc::downgrade(&inner);
            thread::Builder::new()
                .name("feishu-knowledge-ingestion".into())
                .spawn(move || loop {
                    thread::sleep(Duration::from_secs(2));
                    let Some(inner) = knowledge_weak.upgrade() else {
                        return;
                    };
                    if inner.stopped.load(Ordering::SeqCst) {
                        return;
                    }
                    if let Err(e) = inner.sync_knowledge_if_due() {
                        if e.code != "FEISHU_CANCELLED" && e.code != "FEISHU_SYNC_BUSY" {
                            inner.record_error(&e);
                        }
                    }
                })?;
        }
        Ok(Self { inner })
    }
    pub(crate) fn handle(&self, command: &str, p: &Value) -> Option<Result<Value>> {
        Some(match command {
            "get_feishu_status" => self.inner.status(),
            "save_feishu_settings" => self.inner.save_settings(p),
            "begin_feishu_authorization" => self.inner.begin_authorization(),
            "disconnect_feishu" => self.inner.disconnect(),
            "poll_feishu_now" => self.inner.trigger(),
            "list_feishu_chats" => self.inner.list_chats(),
            "list_feishu_private_chats" => self.inner.list_private_chats(),
            "get_feishu_sources" => self.inner.knowledge_status(),
            "save_feishu_sources" => self.inner.save_knowledge(p),
            "sync_feishu_sources" => self.inner.trigger_knowledge(),
            _ => return None,
        })
    }
    pub(crate) fn invalidate(&self) -> Result<()> {
        self.inner.invalidate(false)
    }
    pub(crate) fn set_ingest(&self, ingest: knowledge::Ingest) -> Result<()> {
        *lock(&self.inner.ingest)? = Some(ingest);
        let _ = self.inner.wake.try_send(());
        Ok(())
    }
    pub(crate) fn pause(&self) -> Result<()> {
        self.inner.invalidate(true)
    }
    pub(crate) fn shutdown(&self) {
        self.inner.stopped.store(true, Ordering::SeqCst);
        let _ = self.inner.wake.try_send(());
    }
}
impl Drop for Connector {
    fn drop(&mut self) {
        self.shutdown();
    }
}

impl Inner {
    fn status(&self) -> Result<Value> {
        let state = lock(&self.state)?;
        let s = &state.saved;
        let auth = if state
            .authorization
            .as_ref()
            .is_some_and(|p| p.expires_at > timestamp())
        {
            "authorizing"
        } else if s.session.as_ref().is_some_and(|s| {
            s.invalid || (s.expires_at <= timestamp() && s.refresh_expires_at <= timestamp())
        }) {
            "expired"
        } else if s.session.is_some() {
            "connected"
        } else {
            "disconnected"
        };
        let settings = public_settings(s);
        let mut authorization = json!({"status":auth,"user":s.session.as_ref().map(|s| &s.user)});
        if auth == "authorizing" {
            authorization["authorizationUrl"] = json!(state.authorization.as_ref().map(|p| &p.url));
        }
        let runtime = json!({"polling":state.polling,"lastPollAt":state.last_poll_at,"lastError":state.last_error});
        drop(state);
        let db = lock(&self.receipts)?;
        let mut statement = db.prepare("SELECT id,message_id,chat_id,project_id,question,answer,status,error,created_at,updated_at,chat_type,peer_id,peer_name FROM receipts ORDER BY rowid DESC LIMIT 50")?;
        let recent = statement.query_map([], |r| Ok(json!({"id":r.get::<_,String>(0)?,"messageId":r.get::<_,String>(1)?,"chatId":r.get::<_,String>(2)?,"projectId":r.get::<_,String>(3)?,"question":r.get::<_,String>(4)?,"answer":r.get::<_,Option<String>>(5)?,"status":r.get::<_,String>(6)?,"error":r.get::<_,Option<String>>(7)?,"createdAt":r.get::<_,String>(8)?,"updatedAt":r.get::<_,String>(9)?,"chatType":r.get::<_,String>(10)?,"peerId":r.get::<_,String>(11)?,"peerName":r.get::<_,String>(12)?})))?.collect::<std::result::Result<Vec<_>,_>>()?;
        Ok(
            json!({"settings":settings,"authorization":authorization,"runtime":runtime,"recentMessages":recent}),
        )
    }
    fn persist(&self, saved: &Saved) -> Result<()> {
        save_private(&self.root, saved)
    }
    fn cancel_pending(&self, reason: &str) -> Result<()> {
        lock(&self.receipts)?.execute("UPDATE receipts SET status='cancelled',error=?1,updated_at=?2 WHERE status IN ('pending','generating')", params![reason,now()])?;
        Ok(())
    }
    fn invalidate(&self, disable: bool) -> Result<()> {
        let _gate = lock(&self.send_gate)?;
        let mut state = lock(&self.state)?;
        let mut next = state.saved.clone();
        next.generation = id();
        if disable {
            next.enabled = false;
            next.knowledge.enabled = false;
            lock(&self.receipts)?
                .execute("DELETE FROM metadata WHERE key LIKE 'knowledge%'", [])?;
        }
        self.persist(&next)?;
        state.saved = next;
        state.authorization = None;
        drop(state);
        self.cancel_pending("配置或工作区已更新，本次回复取消")
    }
    fn save_settings(&self, p: &Value) -> Result<Value> {
        let _gate = lock(&self.send_gate)?;
        let mut state = lock(&self.state)?;
        let next = parse_settings(&state.saved, p)?;
        self.persist(&next)?;
        state.saved = next;
        state.authorization = None;
        drop(state);
        self.cancel_pending("飞书设置已更新，本次回复取消")?;
        let _ = self.wake.try_send(());
        drop(_gate);
        self.status()
    }
    fn disconnect(&self) -> Result<Value> {
        let _gate = lock(&self.send_gate)?;
        let mut state = lock(&self.state)?;
        let mut next = state.saved.clone();
        next.session = None;
        next.enabled = false;
        next.generation = id();
        self.persist(&next)?;
        state.saved = next;
        state.authorization = None;
        state.last_error = None;
        drop(state);
        self.cancel_pending("个人账号已断开，本次回复取消")?;
        drop(_gate);
        self.status()
    }
    fn trigger(&self) -> Result<Value> {
        let state = lock(&self.state)?;
        if !state.saved.enabled {
            return Err(error("FEISHU_DISABLED", "请先启用飞书自动回复"));
        }
        if state.saved.session.is_none() {
            return Err(error("FEISHU_NOT_CONNECTED", "请先授权飞书个人账号"));
        }
        drop(state);
        let _ = self.wake.try_send(());
        Ok(json!({"queued":true}))
    }
    fn begin_authorization(self: &Arc<Self>) -> Result<Value> {
        let _gate = lock(&self.send_gate)?;
        let mut state = lock(&self.state)?;
        if let Some(p) = state
            .authorization
            .as_ref()
            .filter(|p| p.expires_at > timestamp())
        {
            return Ok(
                json!({"authorizationUrl":p.url,"redirectUri":REDIRECT_URI,"expiresAt":iso(p.expires_at)}),
            );
        }
        let saved = &state.saved;
        if saved.app_id.is_empty() || saved.app_secret.is_none() {
            return Err(error("FEISHU_CONFIG", "请先保存飞书 App ID 和 App Secret"));
        }
        if self.listener_active.load(Ordering::SeqCst) {
            return Err(error(
                "FEISHU_AUTH_BUSY",
                "上一次授权正在结束，请稍后重新点击授权",
            ));
        }
        let listener = TcpListener::bind("127.0.0.1:17179").map_err(|_| {
            error(
                "FEISHU_CALLBACK",
                "无法监听本地授权回调端口 17179，请检查端口是否被占用",
            )
        })?;
        listener.set_nonblocking(true)?;
        let pending = new_authorization(saved)?;
        let output = json!({"authorizationUrl":pending.url,"redirectUri":REDIRECT_URI,"expiresAt":iso(pending.expires_at)});
        state.authorization = Some(pending);
        self.listener_active.store(true, Ordering::SeqCst);
        let weak = Arc::downgrade(self);
        if let Err(e) = thread::Builder::new()
            .name("feishu-oauth-callback".into())
            .spawn(move || callback_listener(weak, listener))
        {
            self.listener_active.store(false, Ordering::SeqCst);
            state.authorization = None;
            return Err(e.into());
        }
        Ok(output)
    }
    fn finish_authorization(&self, target: &str) -> Result<()> {
        let pending = lock(&self.state)?
            .authorization
            .clone()
            .ok_or_else(|| error("FEISHU_OAUTH_STATE", "授权请求已取消或过期"))?;
        let code = match callback_code(target, &pending) {
            Ok(code) => code,
            Err(e) => {
                if e.code == "FEISHU_OAUTH_DENIED" {
                    let mut state = lock(&self.state)?;
                    if state
                        .authorization
                        .as_ref()
                        .is_some_and(|p| p.state == pending.state)
                    {
                        state.authorization = None;
                    }
                }
                return Err(e);
            }
        };
        // Consume a validated state exactly once, before the network call.
        let saved = {
            let _gate = lock(&self.send_gate)?;
            let mut state = lock(&self.state)?;
            if state.saved.generation != pending.generation
                || state
                    .authorization
                    .as_ref()
                    .is_none_or(|p| p.state != pending.state)
            {
                return Err(error("FEISHU_OAUTH_STATE", "授权请求已取消或配置发生变化"));
            }
            state.authorization = None;
            state.saved.clone()
        };
        let token = self.api.token(false, &json!({"grant_type":"authorization_code","client_id":saved.app_id,
            "client_secret":saved.app_secret,"code":code,"redirect_uri":REDIRECT_URI,"code_verifier":pending.verifier}))?;
        let user = self.user_info(token["access_token"].as_str().unwrap_or(""))?;
        if pending
            .expected_user
            .as_ref()
            .is_some_and(|id| id != &user.open_id)
        {
            return Err(error(
                "FEISHU_ACCOUNT_MISMATCH",
                "此次授权账号与已连接账号不同，请先断开原账号再连接新账号",
            ));
        }
        let session = session_from_token(&token, user)?;
        let _gate = lock(&self.send_gate)?;
        let mut state = lock(&self.state)?;
        if self.stopped.load(Ordering::SeqCst) || state.saved.generation != pending.generation {
            return Err(error("FEISHU_CANCELLED", "授权期间设置已变化，请重新授权"));
        }
        let mut next = state.saved.clone();
        next.session = Some(session);
        next.generation = id();
        next.active_since = timestamp();
        self.persist(&next)?;
        state.saved = next;
        state.last_error = None;
        drop(state);
        self.cancel_pending("个人账号重新授权，本次回复取消")?;
        let _ = self.wake.try_send(());
        Ok(())
    }
    fn user_info(&self, token: &str) -> Result<User> {
        if token.is_empty() {
            return Err(error("FEISHU_TOKEN", "飞书未返回有效个人访问凭证"));
        }
        let data = self.api.json(
            Method::GET,
            "/open-apis/authen/v1/user_info",
            &[],
            Some(token),
            None,
        )?;
        let open_id = data["open_id"]
            .as_str()
            .filter(|s| valid_id(s, "ou_") || valid_id(s, "ou-"))
            .ok_or_else(|| error("FEISHU_IDENTITY", "飞书未返回有效个人账号身份"))?;
        Ok(User {
            open_id: open_id.into(),
            name: data["name"]
                .as_str()
                .unwrap_or("飞书用户")
                .chars()
                .take(100)
                .collect(),
        })
    }
    fn valid_session(&self) -> Result<(Saved, Session)> {
        let _credential = lock(&self.credential_gate)?;
        let saved = lock(&self.state)?.saved.clone();
        let mut session = saved
            .session
            .clone()
            .filter(|s| !s.invalid)
            .ok_or_else(|| error("FEISHU_NOT_CONNECTED", "请先重新授权飞书个人账号"))?;
        if session.expires_at <= timestamp() + 60 {
            if session.refresh_token.is_empty() || session.refresh_expires_at <= timestamp() {
                return Err(error(
                    "FEISHU_AUTH_EXPIRED",
                    "飞书个人授权已过期，请重新授权",
                ));
            }
            let original_refresh = session.refresh_token.clone();
            let token = self
                .api
                .token(
                    true,
                    &json!({"grant_type":"refresh_token","client_id":saved.app_id,
                "client_secret":saved.app_secret,"refresh_token":session.refresh_token}),
                )
                .inspect_err(|e| {
                    self.invalidate_session(&saved.generation, &session.access_token, e)
                })?;
            session = session_from_token(&token, session.user.clone())?;
            // Persist the rotated refresh token before any further network call.
            let _gate = lock(&self.send_gate)?;
            let mut state = lock(&self.state)?;
            // A configuration change may cancel business work while a single-use
            // refresh token is on the wire. Preserve the rotation if the same
            // credentials/account still own the original token, even when the
            // generation has changed; never overwrite a later authorization.
            let same_credentials =
                state.saved.app_id == saved.app_id && state.saved.app_secret == saved.app_secret;
            let same_token = state.saved.session.as_ref().is_some_and(|s| {
                s.user.open_id == session.user.open_id && s.refresh_token == original_refresh
            });
            if !same_credentials || !same_token {
                return Err(error(
                    "FEISHU_CANCELLED",
                    "刷新授权期间个人账号或应用凭证已变化，本次操作取消",
                ));
            }
            session.invalid = state.saved.session.as_ref().is_some_and(|s| s.invalid);
            let mut next = state.saved.clone();
            next.session = Some(session.clone());
            self.persist(&next)?;
            state.saved = next;
            if state.saved.generation != saved.generation || self.stopped.load(Ordering::SeqCst) {
                return Err(error(
                    "FEISHU_CANCELLED",
                    "刷新授权期间设置已变化，本次操作取消；已保存更新后的个人凭证",
                ));
            }
        }
        let current = self.user_info(&session.access_token).inspect_err(|e| {
            self.invalidate_session(&saved.generation, &session.access_token, e)
        })?;
        if current.open_id != session.user.open_id {
            let e = error(
                "FEISHU_ACCOUNT_MISMATCH",
                "飞书访问凭证身份与已授权本人不一致，已停止自动回复",
            );
            self.invalidate_session(&saved.generation, &session.access_token, &e);
            return Err(e);
        }
        Ok((saved, session))
    }
    fn invalidate_session(&self, generation: &str, token: &str, e: &AppError) {
        if !["FEISHU_AUTH_EXPIRED", "FEISHU_ACCOUNT_MISMATCH"].contains(&e.code.as_str()) {
            return;
        }
        let Ok(_gate) = self.send_gate.lock() else {
            return;
        };
        if let Ok(mut state) = self.state.lock() {
            if state.saved.generation != generation
                || state
                    .saved
                    .session
                    .as_ref()
                    .is_none_or(|s| s.access_token != token)
            {
                return;
            }
            if let Some(session) = state.saved.session.as_mut() {
                session.invalid = true;
            }
            state.saved.generation = id();
            let _ = self.persist(&state.saved);
        }
    }
    fn record_error(&self, e: &AppError) {
        if let Ok(mut state) = self.state.lock() {
            // Deliberately keep only connector-generated messages, never model/network body text.
            state.last_error = Some(format!("{}: {}", e.code, e.message));
        }
    }
    fn list_chats(&self) -> Result<Value> {
        let (saved, session) = self.valid_session().inspect_err(|e| self.record_error(e))?;
        let mut chats = Vec::new();
        let mut page = String::new();
        let mut seen = HashSet::new();
        for _ in 0..40 {
            self.check_generation(&saved.generation, false)?;
            let mut query = vec![("page_size".into(), "100".into())];
            if !page.is_empty() {
                query.push(("page_token".into(), page.clone()));
            }
            let data = self.api.json(Method::POST,"/open-apis/im/v2/chats/search",&query,Some(&session.access_token),
                Some(&json!({"filter":{"member_ids":[session.user.open_id],"search_types":["private","external","public_joined"]}})))?;
            for item in required_items(&data)? {
                let meta = &item["meta_data"];
                if let Some(chat_id) = meta["chat_id"].as_str().filter(|s| valid_id(s, "oc_")) {
                    if seen.insert(chat_id.to_owned()) {
                        chats.push(json!({"chatId":chat_id,"name":meta["name"].as_str().unwrap_or(chat_id)}));
                    }
                }
            }
            if !has_more(&data)? {
                return Ok(json!({"chats":chats}));
            }
            page = next_page(&data)?;
        }
        Err(error(
            "FEISHU_PAGINATION",
            "可访问的群聊过多，请手动填写群 ID",
        ))
    }
    fn chat_contexts(
        &self,
        saved: &Saved,
        session: &Session,
        ids: &[String],
    ) -> Result<HashMap<String, Value>> {
        let mut contexts = HashMap::new();
        for batch in ids.chunks(50) {
            self.check_generation(&saved.generation, false)?;
            let data = self.api.json(
                Method::POST,
                "/open-apis/im/v1/chats/batch_query",
                &[("user_id_type".into(), "open_id".into())],
                Some(&session.access_token),
                Some(&json!({"chat_ids":batch})),
            )?;
            for chat in required_items(&data)? {
                if let Some(id) = chat["chat_id"]
                    .as_str()
                    .filter(|id| batch.iter().any(|s| s == id))
                {
                    contexts.insert(id.into(), chat.clone());
                }
            }
        }
        self.check_generation(&saved.generation, false)?;
        Ok(contexts)
    }
    fn verify_private_bindings(&self, saved: &Saved, session: &Session) -> Result<()> {
        let bindings: Vec<_> = saved
            .bindings
            .iter()
            .filter(|b| b.enabled && b.chat_type == ChatType::P2p)
            .collect();
        let ids = bindings
            .iter()
            .map(|b| b.chat_id.clone())
            .collect::<Vec<_>>();
        let contexts = self.chat_contexts(saved, session, &ids)?;
        for b in bindings {
            let valid = contexts.get(&b.chat_id).is_some_and(|c| {
                c["chat_mode"].as_str() == Some("p2p")
                    && c["p2p_target_id"].as_str() == Some(&b.peer_id)
                    && b.peer_id != session.user.open_id
            });
            if !valid {
                return Err(error(
                    "FEISHU_PRIVATE_CHAT",
                    "无法核对私聊与同事身份，请重新读取最近私聊并检查绑定；本轮未发送回复",
                ));
            }
        }
        Ok(())
    }
    fn list_private_chats(&self) -> Result<Value> {
        let (saved, mut session) = self.valid_session().inspect_err(|e| self.record_error(e))?;
        let end = timestamp();
        let body = json!({"query":"","filter":{"chat_type":"p2p","from_types":["user"],
            "time_range":{"start_time":iso(end - 30 * 86400),"end_time":iso(end)}}});
        let mut page = String::new();
        let mut pages = HashSet::new();
        let mut messages = Vec::new();
        let mut more = false;
        // Bounded discovery for the settings picker; never queues historical replies.
        for _ in 0..10 {
            self.check_generation(&saved.generation, false)?;
            if session.expires_at <= timestamp() + 60 {
                session = self.valid_session()?.1;
            }
            let mut query = vec![("page_size".into(), "50".into())];
            if !page.is_empty() {
                query.push(("page_token".into(), page.clone()));
            }
            let data = self.api.json(
                Method::POST,
                "/open-apis/im/v1/messages/search",
                &query,
                Some(&session.access_token),
                Some(&body),
            )?;
            let ids = search_ids(&data)?;
            if !ids.is_empty() {
                let mut query: Vec<_> = ids
                    .iter()
                    .map(|id| ("message_ids".into(), id.clone()))
                    .collect();
                query.push(("with_sender_name".into(), "true".into()));
                let details = self.api.json(
                    Method::GET,
                    "/open-apis/im/v1/messages/mget",
                    &query,
                    Some(&session.access_token),
                    None,
                )?;
                let items = required_items(&details)?;
                if ids
                    .iter()
                    .any(|id| !items.iter().any(|m| m["message_id"].as_str() == Some(id)))
                {
                    return Err(error("FEISHU_RESPONSE", "部分私聊消息未能读取，请稍后重试"));
                }
                messages.extend(
                    items
                        .iter()
                        .filter(|m| ids.iter().any(|id| m["message_id"].as_str() == Some(id)))
                        .cloned(),
                );
            }
            more = has_more(&data)?;
            if !more {
                break;
            }
            page = next_page(&data)?;
            if !pages.insert(page.clone()) {
                return Err(error(
                    "FEISHU_PAGINATION",
                    "飞书返回重复分页游标，请稍后重试",
                ));
            }
        }
        let ids: HashSet<_> = messages
            .iter()
            .filter_map(|m| m["chat_id"].as_str())
            .filter(|id| valid_id(id, "oc_"))
            .map(str::to_owned)
            .collect();
        let contexts =
            self.chat_contexts(&saved, &session, &ids.into_iter().collect::<Vec<_>>())?;
        let mut chats = Vec::new();
        for (chat_id, context) in contexts {
            let Some(peer) = context["p2p_target_id"].as_str().filter(|id| {
                (valid_id(id, "ou_") || valid_id(id, "ou-")) && *id != session.user.open_id
            }) else {
                continue;
            };
            if context["chat_mode"].as_str() != Some("p2p") {
                continue;
            }
            let name = messages
                .iter()
                .filter(|m| {
                    m["chat_id"].as_str() == Some(&chat_id)
                        && m["sender"]["id"].as_str() == Some(peer)
                })
                .find_map(|m| {
                    m["sender"]["sender_name"]
                        .as_str()
                        .or_else(|| m["sender"]["name"].as_str())
                        .filter(|s| !s.is_empty() && s.len() <= 400)
                })
                .unwrap_or(peer);
            chats.push(json!({"chatId":chat_id,"peerId":peer,"name":name}));
        }
        chats.sort_by(|a, b| {
            a["name"]
                .as_str()
                .cmp(&b["name"].as_str())
                .then_with(|| a["chatId"].as_str().cmp(&b["chatId"].as_str()))
        });
        Ok(json!({"chats":chats,"hasMore":more}))
    }
    fn check_generation(&self, generation: &str, enabled: bool) -> Result<()> {
        let state = lock(&self.state)?;
        if self.stopped.load(Ordering::SeqCst)
            || state.saved.generation != generation
            || (enabled && !state.saved.enabled)
        {
            return Err(error(
                "FEISHU_CANCELLED",
                "设置或工作区已更新，本次操作取消",
            ));
        }
        Ok(())
    }
    fn poll(&self) -> Result<()> {
        let (saved, session) = self.valid_session()?;
        self.check_generation(&saved.generation, true)?;
        if !saved.bindings.iter().any(|b| b.enabled) {
            return Ok(());
        }
        let account = format!("{}:{}", saved.app_id, session.user.open_id);
        self.verify_private_bindings(&saved, &session)?;
        self.process_pending(&saved, &session, &account)?;
        // A slow answer can rotate the token. Do not keep using the original
        // poll snapshot after pending work finishes.
        let (_, mut session) = self.valid_session()?;
        self.check_generation(&saved.generation, true)?;
        let key = format!("watermark:{account}");
        let watermark: i64 = lock(&self.receipts)?
            .query_row("SELECT value FROM metadata WHERE key=?1", [&key], |r| {
                r.get::<_, String>(0)
            })
            .optional()?
            .and_then(|s| s.parse().ok())
            .unwrap_or(saved.active_since);
        let end = timestamp();
        let start = (watermark - OVERLAP_SECONDS).max(saved.active_since);
        for chat_type in [ChatType::Group, ChatType::P2p] {
            let chats: Vec<_> = saved
                .bindings
                .iter()
                .filter(|b| b.enabled && b.chat_type == chat_type)
                .map(|b| &b.chat_id)
                .collect();
            if chats.is_empty() {
                continue;
            }
            let mut body = json!({"query":"","filter":{"chat_ids":chats,"from_types":["user"],
                "chat_type":chat_type,"time_range":{"start_time":iso(start),"end_time":iso(end)}}});
            if chat_type == ChatType::Group {
                body["filter"]["is_at_me"] = json!(true);
            }
            self.search_poll(&saved, &mut session, &account, &body, chat_type)?;
        }
        self.check_generation(&saved.generation, true)?;
        lock(&self.receipts)?.execute("INSERT INTO metadata(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![key,end.to_string()])?;
        self.process_pending(&saved, &session, &account)
    }
    fn search_poll(
        &self,
        saved: &Saved,
        session: &mut Session,
        account: &str,
        body: &Value,
        chat_type: ChatType,
    ) -> Result<()> {
        let mut page = String::new();
        let mut pages = HashSet::new();
        for _ in 0..100 {
            self.check_generation(&saved.generation, true)?;
            if session.expires_at <= timestamp() + 60 {
                *session = self.valid_session()?.1;
                self.check_generation(&saved.generation, true)?;
            }
            let mut query = vec![("page_size".into(), "50".into())];
            if !page.is_empty() {
                query.push(("page_token".into(), page.clone()));
            }
            let data = self.api.json(
                Method::POST,
                "/open-apis/im/v1/messages/search",
                &query,
                Some(&session.access_token),
                Some(body),
            )?;
            let ids = search_ids(&data)?;
            if !ids.is_empty() {
                let query: Vec<_> = ids
                    .iter()
                    .map(|id| ("message_ids".into(), id.clone()))
                    .collect();
                let details = self.api.json(
                    Method::GET,
                    "/open-apis/im/v1/messages/mget",
                    &query,
                    Some(&session.access_token),
                    None,
                )?;
                let items = required_items(&details)?;
                // Incomplete mget must not silently discard a discovered message.
                for message_id in &ids {
                    if !items
                        .iter()
                        .any(|m| m["message_id"].as_str() == Some(message_id))
                    {
                        return Err(error(
                            "FEISHU_RESPONSE",
                            "部分飞书消息未能读取，未推进轮询进度",
                        ));
                    }
                }
                self.check_generation(&saved.generation, true)?;
                for message in items {
                    // Only accept details requested in this search and in this channel.
                    if ids
                        .iter()
                        .any(|id| message["message_id"].as_str() == Some(id))
                        && saved.bindings.iter().any(|b| {
                            b.chat_type == chat_type
                                && message["chat_id"].as_str() == Some(&b.chat_id)
                        })
                    {
                        self.discover(saved, session, account, message)?;
                    }
                }
            }
            if !has_more(&data)? {
                self.check_generation(&saved.generation, true)?;
                return Ok(());
            }
            page = next_page(&data)?;
            if !pages.insert(page.clone()) {
                return Err(error(
                    "FEISHU_PAGINATION",
                    "飞书返回重复分页游标，未推进轮询进度",
                ));
            }
        }
        Err(error(
            "FEISHU_PAGINATION",
            "本轮飞书消息分页未完成，未推进轮询进度，下轮继续检索",
        ))
    }
    fn discover(
        &self,
        saved: &Saved,
        session: &Session,
        account: &str,
        message: &Value,
    ) -> Result<()> {
        let Some(candidate) = candidate(saved, &session.user.open_id, message) else {
            return Ok(());
        };
        let created = now();
        let binding = candidate.binding;
        let kind = if binding.chat_type == ChatType::P2p {
            "p2p"
        } else {
            "group"
        };
        lock(&self.receipts)?.execute("INSERT OR IGNORE INTO receipts(id,account,message_id,chat_id,project_id,question,status,generation,uuid,created_at,updated_at,chat_type,peer_id,peer_name) VALUES(?1,?2,?3,?4,?5,?6,'pending',?7,?8,?9,?9,?10,?11,?12)",
            params![id(),account,candidate.message_id,candidate.chat_id,candidate.project_id,candidate.question,saved.generation,id(),created,kind,binding.peer_id,binding.name])?;
        Ok(())
    }
    fn process_pending(&self, saved: &Saved, session: &Session, account: &str) -> Result<()> {
        let rows = {
            let db = lock(&self.receipts)?;
            let mut stmt = db.prepare("SELECT id,message_id,chat_id,project_id,question,uuid,generation FROM receipts WHERE account=?1 AND status='pending' ORDER BY rowid LIMIT 100")?;
            let result = stmt
                .query_map([account], |r| {
                    Ok(Receipt {
                        id: r.get(0)?,
                        message_id: r.get(1)?,
                        chat_id: r.get(2)?,
                        project_id: r.get(3)?,
                        question: r.get(4)?,
                        uuid: r.get(5)?,
                        generation: r.get(6)?,
                    })
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            result
        };
        for row in rows {
            self.check_generation(&saved.generation, true)?;
            if row.generation != saved.generation
                || !saved.bindings.iter().any(|b| {
                    b.enabled && b.chat_id == row.chat_id && b.project_id == row.project_id
                })
            {
                self.receipt_status(
                    &row.id,
                    "cancelled",
                    None,
                    Some("会话项目绑定已变化，本次回复取消"),
                )?;
                continue;
            }
            self.receipt_status(&row.id, "generating", None, None)?;
            let generated = match (self.ask)(&row.project_id, &row.question) {
                Ok(value) => value,
                Err(_) => {
                    self.receipt_status(
                        &row.id,
                        "failed",
                        None,
                        Some("项目记忆问答失败，请检查记忆、模型配置和资料访问授权"),
                    )?;
                    continue;
                }
            };
            if self.check_generation(&saved.generation, true).is_err() {
                self.receipt_status(
                    &row.id,
                    "cancelled",
                    None,
                    Some("生成期间设置或工作区已更新，本次回复取消"),
                )?;
                continue;
            }
            if generated["grounded"].as_bool() != Some(true)
                || generated["citations"].as_array().is_none_or(Vec::is_empty)
            {
                self.receipt_status(
                    &row.id,
                    "skipped",
                    None,
                    Some("没有足够的项目记忆依据，未自动回复"),
                )?;
                continue;
            }
            let Some(answer) = reply_text(saved, &generated) else {
                self.receipt_status(
                    &row.id,
                    "skipped",
                    None,
                    Some("记忆回答为空或过长，未自动回复"),
                )?;
                continue;
            };
            // Refresh/verify identity again if a slow generation outlived its token.
            let (_, latest_session) = match self.valid_session() {
                Ok(value) => value,
                Err(e) => {
                    let status = if ["FEISHU_NETWORK", "FEISHU_RESPONSE", "FEISHU_API"]
                        .contains(&e.code.as_str())
                    {
                        "pending"
                    } else {
                        "failed"
                    };
                    self.receipt_status(&row.id, status, Some(&answer), Some(&e.message))?;
                    return Err(e);
                }
            };
            if latest_session.user.open_id != session.user.open_id {
                return Err(error(
                    "FEISHU_ACCOUNT_MISMATCH",
                    "个人账号已变化，本次回复取消",
                ));
            }
            let _gate = lock(&self.send_gate)?;
            if let Err(e) = self.check_generation(&saved.generation, true) {
                self.receipt_status(
                    &row.id,
                    "cancelled",
                    Some(&answer),
                    Some("发送前设置或工作区已更新，本次回复取消"),
                )?;
                return Err(e);
            }
            if (self.validate)(&generated["context"]).is_err() {
                self.receipt_status(
                    &row.id,
                    "cancelled",
                    Some(&answer),
                    Some("记忆版本、模型配置或工作区已变化，本次回复取消"),
                )?;
                continue;
            }
            // Commit intent BEFORE issuing a write. A crash or ambiguous response
            // leaves unknown and is never automatically retried, even after 1h.
            self.receipt_status(&row.id, "sending", Some(&answer), None)?;
            let path = format!("/open-apis/im/v1/messages/{}/reply", row.message_id);
            let sent = self.api.json(Method::POST,&path,&[],Some(&latest_session.access_token),
                Some(&json!({"msg_type":"text","content":json!({"text":answer}).to_string(),"uuid":row.uuid})));
            match sent {
                Ok(data)
                    if data["message_id"]
                        .as_str()
                        .is_some_and(|id| valid_id(id, "om_")) =>
                {
                    lock(&self.receipts)?.execute("UPDATE receipts SET status='replied',reply_id=?1,error=NULL,updated_at=?2 WHERE id=?3",params![data["message_id"].as_str(),now(),row.id])?;
                }
                Ok(_) => self.receipt_status(
                    &row.id,
                    "unknown",
                    Some(&answer),
                    Some("飞书未返回有效回执，结果未知，不会自动重发"),
                )?,
                Err(e) => {
                    let status = if ["FEISHU_AUTH_EXPIRED", "FEISHU_PERMISSION"]
                        .contains(&e.code.as_str())
                    {
                        "failed"
                    } else {
                        "unknown"
                    };
                    self.receipt_status(&row.id, status, Some(&answer), Some(&e.message))?;
                    self.record_error(&e);
                    if status == "failed" {
                        return Err(e);
                    }
                }
            }
        }
        Ok(())
    }
    fn receipt_status(
        &self,
        receipt: &str,
        status: &str,
        answer: Option<&str>,
        reason: Option<&str>,
    ) -> Result<()> {
        lock(&self.receipts)?.execute("UPDATE receipts SET status=?1,answer=COALESCE(?2,answer),error=?3,updated_at=?4 WHERE id=?5",params![status,answer,reason,now(),receipt])?;
        Ok(())
    }
}

struct Receipt {
    id: String,
    message_id: String,
    chat_id: String,
    project_id: String,
    question: String,
    uuid: String,
    generation: String,
}
struct Candidate<'a> {
    binding: &'a Binding,
    message_id: &'a str,
    chat_id: &'a str,
    project_id: &'a str,
    question: String,
}
fn candidate<'a>(saved: &'a Saved, me: &str, message: &'a Value) -> Option<Candidate<'a>> {
    let message_id = message["message_id"]
        .as_str()
        .filter(|s| valid_id(s, "om_"))?;
    let chat_id = message["chat_id"].as_str()?;
    let binding = saved
        .bindings
        .iter()
        .find(|b| b.enabled && b.chat_id == chat_id)?;
    let mut created: i64 = message["create_time"]
        .as_str()
        .and_then(|s| s.parse().ok())
        .or_else(|| message["create_time"].as_i64())?;
    if created > 10_000_000_000 {
        created /= 1000;
    }
    if created < saved.active_since.max(binding.since) || created > timestamp() + 60 {
        return None;
    }
    if message["deleted"].as_bool() == Some(true) {
        return None;
    }
    let sender = &message["sender"];
    if sender["sender_type"].as_str() != Some("user") || sender["id"].as_str() == Some(me) {
        return None;
    }
    if sender["id"]
        .as_str()
        .is_none_or(|id| !valid_id(id, "ou_") && !valid_id(id, "ou-"))
    {
        return None;
    }
    if sender["id_type"].as_str().is_some_and(|t| t != "open_id") {
        return None;
    }
    let mentions = message["mentions"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    if binding.chat_type == ChatType::P2p {
        if binding.peer_id.is_empty() || sender["id"].as_str() != Some(&binding.peer_id) {
            return None;
        }
    } else if !mentions.iter().any(|m| {
        m["id"].as_str() == Some(me) && m["id_type"].as_str().is_none_or(|t| t == "open_id")
    }) {
        return None;
    }
    let content: Value = serde_json::from_str(message["body"]["content"].as_str()?).ok()?;
    let mut question = match message["msg_type"]
        .as_str()
        .or_else(|| message["message_type"].as_str())?
    {
        "text" => content["text"].as_str()?.to_owned(),
        "post" => post_question(&content, mentions, me)?,
        // Images, files, audio and cards are never guessed or downloaded.
        _ => return None,
    };
    for mention in mentions {
        if let Some(key) = mention["key"].as_str().filter(|s| !s.is_empty()) {
            let replacement = if mention["id"].as_str() == Some(me) {
                ""
            } else {
                mention["name"].as_str().unwrap_or("成员")
            };
            question = question.replace(key, replacement);
        }
    }
    let question = question.trim().to_owned();
    if question.is_empty() || question.len() > 16_000 {
        return None;
    }
    Some(Candidate {
        binding,
        message_id,
        chat_id,
        project_id: &binding.project_id,
        question,
    })
}
fn post_question(content: &Value, mentions: &[Value], me: &str) -> Option<String> {
    // mget may return a direct post or the locale map used by send APIs.
    let post = if content["content"].is_array() {
        content
    } else {
        content
            .get("zh_cn")
            .filter(|v| v["content"].is_array())
            .or_else(|| content.get("en_us").filter(|v| v["content"].is_array()))
            .or_else(|| {
                content
                    .as_object()?
                    .values()
                    .find(|v| v["content"].is_array())
            })?
    };
    let mut lines = Vec::new();
    if let Some(title) = post["title"].as_str().filter(|s| !s.trim().is_empty()) {
        lines.push(title.to_owned());
    }
    for row in post["content"].as_array()? {
        let mut line = String::new();
        for node in row.as_array()? {
            match node["tag"].as_str().unwrap_or("") {
                "text" | "a" | "md" => {
                    if let Some(text) = node["text"].as_str() {
                        line.push_str(text);
                    }
                }
                "at" => {
                    let target = node["user_id"].as_str().unwrap_or("");
                    if target != me {
                        let display = mentions
                            .iter()
                            .find(|m| m["id"].as_str() == Some(target))
                            .and_then(|m| m["name"].as_str())
                            .or_else(|| node["user_name"].as_str())
                            .or_else(|| node["name"].as_str())
                            .unwrap_or("成员");
                        line.push_str(display);
                    }
                }
                _ => (),
            }
        }
        if !line.trim().is_empty() {
            lines.push(line);
        }
    }
    Some(lines.join("\n"))
}
fn reply_text(saved: &Saved, generated: &Value) -> Option<String> {
    let answer = generated["answer"].as_str()?.trim();
    if answer.is_empty() {
        return None;
    }
    // The trusted QA layer already appends the evidence labels to its answer.
    let result = format!("{}{}", saved.reply_prefix, answer);
    // Feishu text sends are limited; keep a conservative UTF-8 byte bound.
    (result.len() <= 20_000).then_some(result)
}
fn search_ids(data: &Value) -> Result<Vec<String>> {
    required_items(data)?
        .iter()
        .map(|item| {
            item["meta_data"]["message_id"]
                .as_str()
                .filter(|s| valid_id(s, "om_"))
                .map(str::to_owned)
                .ok_or_else(|| error("FEISHU_RESPONSE", "飞书搜索结果缺少消息 ID，未推进轮询进度"))
        })
        .collect()
}
fn required_items(value: &Value) -> Result<&Vec<Value>> {
    value["items"]
        .as_array()
        .ok_or_else(|| error("FEISHU_RESPONSE", "飞书响应缺少消息列表，未推进轮询进度"))
}
fn has_more(value: &Value) -> Result<bool> {
    value["has_more"]
        .as_bool()
        .ok_or_else(|| error("FEISHU_RESPONSE", "飞书响应缺少分页状态，未推进轮询进度"))
}
fn next_page(value: &Value) -> Result<String> {
    value["page_token"]
        .as_str()
        .filter(|s| !s.is_empty())
        .or_else(|| value["next_page_token"].as_str().filter(|s| !s.is_empty()))
        .filter(|s| s.len() <= 4096)
        .map(str::to_owned)
        .ok_or_else(|| error("FEISHU_PAGINATION", "飞书分页游标无效，未推进轮询进度"))
}
fn worker(weak: Weak<Inner>, receiver: mpsc::Receiver<()>) {
    loop {
        let Some(inner) = weak.upgrade() else {
            return;
        };
        if inner.stopped.load(Ordering::SeqCst) {
            return;
        }
        let (enabled, interval) = match inner.state.lock() {
            Ok(s) => (
                s.saved.enabled && s.saved.session.as_ref().is_some_and(|s| !s.invalid),
                s.saved.poll_interval_seconds.max(30),
            ),
            Err(_) => return,
        };
        if enabled {
            if let Ok(mut s) = inner.state.lock() {
                s.polling = true;
            }
            let result = inner.poll();
            if let Err(e) = &result {
                if e.code != "FEISHU_CANCELLED" {
                    inner.record_error(e);
                }
            }
            if let Ok(mut s) = inner.state.lock() {
                s.polling = false;
                s.last_poll_at = Some(now());
                if result.is_ok() {
                    s.last_error = None;
                }
            }
        }
        drop(inner);
        if let Err(mpsc::RecvTimeoutError::Disconnected) =
            receiver.recv_timeout(Duration::from_secs(interval))
        {
            return;
        }
    }
}

fn public_settings(saved: &Saved) -> Value {
    json!({"appId":saved.app_id,"hasAppSecret":saved.app_secret.is_some(),"enabled":saved.enabled,
        "pollIntervalSeconds":saved.poll_interval_seconds,"replyPrefix":saved.reply_prefix,
        "redirectUri":REDIRECT_URI,"bindings":saved.bindings.iter().map(|b|json!({"chatId":b.chat_id,"projectId":b.project_id,"enabled":b.enabled,"chatType":b.chat_type,"peerId":b.peer_id,"name":b.name})).collect::<Vec<_>>()})
}
fn parse_settings(old: &Saved, p: &Value) -> Result<Saved> {
    let app_id = p["appId"].as_str().unwrap_or("").trim();
    if !app_id.is_empty() && !valid_id(app_id, "cli_") {
        return Err(error("FEISHU_CONFIG", "飞书 App ID 格式无效"));
    }
    let enabled = p["enabled"]
        .as_bool()
        .ok_or_else(|| error("FEISHU_CONFIG", "enabled 必须为布尔值"))?;
    let interval = p["pollIntervalSeconds"]
        .as_u64()
        .filter(|n| (30..=3600).contains(n))
        .ok_or_else(|| error("FEISHU_CONFIG", "轮询间隔需在 30 到 3600 秒之间"))?;
    let prefix = p["replyPrefix"].as_str().unwrap_or("个人助理代答：\n");
    if prefix.len() > 1024 {
        return Err(error("FEISHU_CONFIG", "回复前缀过长"));
    }
    let secret = match p.get("appSecret") {
        Some(Value::String(s)) if s.len() <= 16_384 && !s.contains(['\r', '\n']) => {
            if s.trim().is_empty() {
                None
            } else {
                Some(s.trim().to_owned())
            }
        }
        None if app_id == old.app_id => old.app_secret.clone(),
        None => None,
        _ => return Err(error("FEISHU_CONFIG", "App Secret 格式无效")),
    };
    let mut bindings = Vec::new();
    let mut seen = HashSet::new();
    let entries = p["bindings"]
        .as_array()
        .ok_or_else(|| error("FEISHU_CONFIG", "请提供会话与项目绑定列表"))?;
    if entries.len() > 100 {
        return Err(error("FEISHU_CONFIG", "最多可绑定 100 个群聊或私聊"));
    }
    for entry in entries {
        let chat_id = entry["chatId"]
            .as_str()
            .filter(|s| valid_id(s, "oc_"))
            .ok_or_else(|| error("FEISHU_CONFIG", "会话 ID 格式无效"))?;
        let project_id = crate::required(entry, "projectId")?;
        if project_id.len() > 200 || !seen.insert(chat_id.to_owned()) {
            return Err(error("FEISHU_CONFIG", "一个会话只能绑定一个项目"));
        }
        let chat_type: ChatType =
            serde_json::from_value(entry.get("chatType").cloned().unwrap_or(json!("group")))
                .map_err(|_| error("FEISHU_CONFIG", "会话类型必须为 group 或 p2p"))?;
        let peer_id = entry["peerId"].as_str().unwrap_or("");
        let name = entry["name"].as_str().unwrap_or("").trim();
        if name.len() > 400
            || (chat_type == ChatType::P2p
                && (!valid_id(peer_id, "ou_") && !valid_id(peer_id, "ou-")))
        {
            return Err(error(
                "FEISHU_CONFIG",
                "私聊需填写有效的同事 Open ID，备注最多 400 字节",
            ));
        }
        let binding_enabled = entry["enabled"]
            .as_bool()
            .ok_or_else(|| error("FEISHU_CONFIG", "绑定 enabled 必须为布尔值"))?;
        let since = old
            .bindings
            .iter()
            .find(|b| {
                b.chat_id == chat_id
                    && b.project_id == project_id
                    && b.enabled == binding_enabled
                    && b.chat_type == chat_type
                    && b.peer_id == peer_id
            })
            .map(|b| b.since)
            .unwrap_or_else(timestamp);
        bindings.push(Binding {
            chat_id: chat_id.into(),
            project_id: project_id.into(),
            enabled: binding_enabled,
            chat_type,
            peer_id: if chat_type == ChatType::P2p {
                peer_id.into()
            } else {
                String::new()
            },
            name: name.into(),
            since,
        });
    }
    if enabled && (app_id.is_empty() || secret.is_none() || !bindings.iter().any(|b| b.enabled)) {
        return Err(error(
            "FEISHU_CONFIG",
            "启用前请保存应用凭证并绑定至少一个群聊或私聊项目",
        ));
    }
    let credentials_changed = app_id != old.app_id || secret != old.app_secret;
    Ok(Saved {
        app_id: app_id.into(),
        app_secret: secret,
        enabled,
        poll_interval_seconds: interval,
        reply_prefix: prefix.into(),
        bindings,
        session: if credentials_changed {
            None
        } else {
            old.session.clone()
        },
        generation: id(),
        active_since: if !old.enabled && enabled || credentials_changed {
            timestamp()
        } else {
            old.active_since
        },
        knowledge: old.knowledge.clone(),
    })
}
fn new_authorization(saved: &Saved) -> Result<PendingAuthorization> {
    let state = format!("{}{}", id().replace('-', ""), id().replace('-', ""));
    let verifier = format!("{}{}", id().replace('-', ""), id().replace('-', ""));
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(Sha256::digest(verifier.as_bytes()));
    let mut url = Url::parse("https://accounts.feishu.cn/open-apis/authen/v1/authorize")
        .map_err(|_| error("FEISHU_CONFIG", "授权地址无效"))?;
    url.query_pairs_mut().extend_pairs([
        ("client_id", saved.app_id.as_str()),
        ("response_type", "code"),
        ("redirect_uri", REDIRECT_URI),
        ("scope", SCOPES),
        ("state", state.as_str()),
        ("prompt", "consent"),
        ("code_challenge", challenge.as_str()),
        ("code_challenge_method", "S256"),
    ]);
    Ok(PendingAuthorization {
        state,
        verifier,
        url: url.to_string(),
        expires_at: timestamp() + 300,
        generation: saved.generation.clone(),
        expected_user: saved.session.as_ref().map(|s| s.user.open_id.clone()),
    })
}
fn callback_code(target: &str, pending: &PendingAuthorization) -> Result<String> {
    if pending.expires_at <= timestamp() {
        return Err(error("FEISHU_OAUTH_STATE", "授权请求已过期，请重新授权"));
    }
    if !target.starts_with("/feishu/callback?") || target.len() > 8192 {
        return Err(error("FEISHU_OAUTH_STATE", "授权回调路径无效"));
    }
    let url = Url::parse(&format!("http://127.0.0.1:17179{target}"))
        .map_err(|_| error("FEISHU_OAUTH_STATE", "授权回调无效"))?;
    if url.path() != "/feishu/callback" || url.fragment().is_some() {
        return Err(error("FEISHU_OAUTH_STATE", "授权回调路径无效"));
    }
    let pairs: Vec<_> = url.query_pairs().collect();
    let states: Vec<_> = pairs.iter().filter(|(k, _)| k == "state").collect();
    if states.len() != 1 || states[0].1 != pending.state {
        return Err(error(
            "FEISHU_OAUTH_STATE",
            "授权 state 校验失败，请重新发起授权",
        ));
    }
    if pairs.iter().any(|(k, _)| k == "error") {
        return Err(error("FEISHU_OAUTH_DENIED", "你已取消飞书授权"));
    }
    let codes: Vec<_> = pairs.iter().filter(|(k, _)| k == "code").collect();
    if codes.len() != 1
        || codes[0].1.is_empty()
        || codes[0].1.len() > 2048
        || !codes[0]
            .1
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(error("FEISHU_OAUTH_STATE", "授权码无效"));
    }
    Ok(codes[0].1.to_string())
}
fn session_from_token(token: &Value, user: User) -> Result<Session> {
    let access_token = token["access_token"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 32_768 && !s.contains(['\r', '\n']))
        .ok_or_else(|| error("FEISHU_TOKEN", "飞书未返回有效个人访问凭证"))?;
    let refresh_token = token["refresh_token"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 32_768 && !s.contains(['\r', '\n']))
        .ok_or_else(|| {
            error(
                "FEISHU_TOKEN",
                "飞书未授予 offline_access，无法在后台自动刷新，请补充权限后重新授权",
            )
        })?;
    let expires = token["expires_in"]
        .as_i64()
        .filter(|n| *n > 0 && *n <= 31_536_000)
        .ok_or_else(|| error("FEISHU_TOKEN", "个人访问凭证有效期无效"))?;
    let refresh_expires = token["refresh_token_expires_in"]
        .as_i64()
        .filter(|n| *n > 0 && *n <= 63_072_000)
        .ok_or_else(|| error("FEISHU_TOKEN", "个人刷新凭证有效期无效"))?;
    let scope = token["scope"].as_str().unwrap_or("");
    let granted: HashSet<_> = scope.split_whitespace().collect();
    for required in SCOPES.split_whitespace() {
        if !granted.contains(required) {
            return Err(AppError::new(
                "FEISHU_PERMISSION",
                format!("个人授权缺少 {required} 权限，请在飞书应用后台开通并重新授权"),
            ));
        }
    }
    if token["token_type"]
        .as_str()
        .is_some_and(|s| !s.eq_ignore_ascii_case("Bearer"))
    {
        return Err(error("FEISHU_TOKEN", "飞书返回了不支持的凭证类型"));
    }
    Ok(Session {
        access_token: access_token.into(),
        refresh_token: refresh_token.into(),
        expires_at: timestamp() + expires,
        refresh_expires_at: timestamp() + refresh_expires,
        scope: scope.into(),
        user,
        invalid: false,
    })
}
fn callback_listener(weak: Weak<Inner>, listener: TcpListener) {
    loop {
        let Some(inner) = weak.upgrade() else {
            return;
        };
        let active = !inner.stopped.load(Ordering::SeqCst)
            && inner.state.lock().is_ok_and(|s| {
                s.authorization
                    .as_ref()
                    .is_some_and(|p| p.expires_at > timestamp())
            });
        if !active {
            inner.listener_active.store(false, Ordering::SeqCst);
            return;
        }
        match listener.accept() {
            Ok((mut stream, peer)) if peer.ip().is_loopback() => {
                let result = read_callback_target(&mut stream)
                    .and_then(|target| inner.finish_authorization(&target));
                let (status, message) = match &result {
                    Ok(()) => ("200 OK", "飞书个人账号授权成功，可以关闭此页面并返回助理。"),
                    Err(_) => (
                        "400 Bad Request",
                        "飞书授权未完成，请返回助理查看状态或重新发起授权。",
                    ),
                };
                let response=format!("HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Security-Policy: default-src 'none'\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{message}",message.len());
                let _ = stream.write_all(response.as_bytes());
                if let Err(e) = result {
                    inner.record_error(&e);
                }
            }
            Ok(_) => (),
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => (),
            Err(_) => {
                inner.listener_active.store(false, Ordering::SeqCst);
                return;
            }
        }
        drop(inner);
        thread::sleep(Duration::from_millis(100));
    }
}
fn read_callback_target(stream: &mut TcpStream) -> Result<String> {
    // Accepted sockets inherit nonblocking mode on Windows.
    stream.set_nonblocking(false)?;
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    stream.set_write_timeout(Some(Duration::from_secs(2)))?;
    let mut bytes = Vec::new();
    let mut block = [0_u8; 1024];
    while bytes.len() <= 16_384 && !bytes.windows(4).any(|b| b == b"\r\n\r\n") {
        let n = stream.read(&mut block)?;
        if n == 0 {
            break;
        }
        bytes.extend_from_slice(&block[..n]);
    }
    if bytes.len() > 16_384 {
        return Err(error("FEISHU_CALLBACK", "授权回调请求过大"));
    }
    let text =
        std::str::from_utf8(&bytes).map_err(|_| error("FEISHU_CALLBACK", "授权回调请求无效"))?;
    let first = text.lines().next().unwrap_or("");
    let parts: Vec<_> = first.split_whitespace().collect();
    if parts.len() != 3 || parts[0] != "GET" || !["HTTP/1.0", "HTTP/1.1"].contains(&parts[2]) {
        return Err(error("FEISHU_CALLBACK", "授权回调请求方式无效"));
    }
    let hosts: Vec<_> = text
        .lines()
        .skip(1)
        .filter_map(|line| line.split_once(':'))
        .filter(|(name, _)| name.eq_ignore_ascii_case("host"))
        .collect();
    if hosts.len() != 1 || hosts[0].1.trim() != "127.0.0.1:17179" {
        return Err(error("FEISHU_CALLBACK", "授权回调 Host 无效"));
    }
    Ok(parts[1].into())
}
fn reject_symlink(path: &Path) -> Result<()> {
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() || (!metadata.is_file() && !metadata.is_dir()) {
            return Err(error(
                "FEISHU_SECRET_PATH",
                "飞书私有文件不能是符号链接或特殊文件",
            ));
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return Err(error(
                    "FEISHU_SECRET_PATH",
                    "飞书私有文件不能通过重解析点访问",
                ));
            }
        }
    }
    Ok(())
}
fn private_directory(root: &Path) -> Result<PathBuf> {
    crate::settings::private_directory(root)
}
fn load_saved(root: &Path) -> Result<Saved> {
    let path = private_directory(root)?.join("feishu-settings.json");
    reject_symlink(&path)?;
    let metadata = match fs::metadata(&path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Saved::default()),
        Err(e) => return Err(e.into()),
    };
    if !metadata.is_file() || metadata.len() > 256 * 1024 {
        return Err(error("FEISHU_SECRET_CONFIG", "飞书私有配置文件无效"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
    }
    let saved: Saved = serde_json::from_slice(&fs::read(path)?).map_err(|_| {
        error(
            "FEISHU_SECRET_CONFIG",
            "飞书私有配置无法读取，请检查本地配置文件",
        )
    })?;
    if !(30..=3600).contains(&saved.poll_interval_seconds) || saved.bindings.len() > 100 {
        return Err(error("FEISHU_SECRET_CONFIG", "飞书私有配置无效"));
    }
    Ok(saved)
}
fn save_private(root: &Path, saved: &Saved) -> Result<()> {
    let directory = private_directory(root)?;
    let destination = directory.join("feishu-settings.json");
    reject_symlink(&destination)?;
    let temporary = directory.join(format!(".feishu-{}.tmp", id()));
    let mut options = fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary)?;
    let bytes = serde_json::to_vec(saved)
        .map_err(|_| error("FEISHU_SECRET_CONFIG", "飞书私有配置保存失败"))?;
    if let Err(e) = file.write_all(&bytes).and_then(|_| file.sync_all()) {
        let _ = fs::remove_file(&temporary);
        return Err(e.into());
    }
    drop(file);
    // On Windows std::fs::rename uses MoveFileExW with REPLACE_EXISTING.
    if let Err(e) = fs::rename(&temporary, &destination) {
        let _ = fs::remove_file(&temporary);
        return Err(e.into());
    }
    crate::sync_directory(&directory)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    #[derive(Clone)]
    struct Request {
        method: String,
        target: String,
        authorization: String,
        body: Value,
    }
    struct Fixture {
        base: String,
        stopped: Arc<AtomicBool>,
        requests: Arc<Mutex<Vec<Request>>>,
        thread: Option<thread::JoinHandle<()>>,
    }
    impl Fixture {
        fn new(handler: impl Fn(&Request) -> Option<Value> + Send + 'static) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let base = format!("http://{}", listener.local_addr().unwrap());
            let stopped = Arc::new(AtomicBool::new(false));
            let requests = Arc::new(Mutex::new(Vec::new()));
            let stop = stopped.clone();
            let seen = requests.clone();
            let thread = thread::spawn(move || {
                while !stop.load(Ordering::SeqCst) {
                    match listener.accept() {
                        Ok((mut stream, _)) => {
                            stream.set_nonblocking(false).unwrap();
                            stream
                                .set_read_timeout(Some(Duration::from_secs(2)))
                                .unwrap();
                            let mut bytes = Vec::new();
                            let mut block = [0u8; 2048];
                            let header_end = loop {
                                let n = stream.read(&mut block).unwrap_or(0);
                                if n == 0 {
                                    break None;
                                }
                                bytes.extend_from_slice(&block[..n]);
                                if let Some(index) = bytes.windows(4).position(|b| b == b"\r\n\r\n")
                                {
                                    break Some(index + 4);
                                }
                                if bytes.len() > 64 * 1024 {
                                    break None;
                                }
                            };
                            let Some(header_end) = header_end else {
                                continue;
                            };
                            let headers = String::from_utf8_lossy(&bytes[..header_end]).to_string();
                            let mut first = headers.lines().next().unwrap().split_whitespace();
                            let method = first.next().unwrap().to_owned();
                            let target = first.next().unwrap().to_owned();
                            let pairs: Vec<_> = headers
                                .lines()
                                .skip(1)
                                .filter_map(|l| l.split_once(':'))
                                .collect();
                            let length = pairs
                                .iter()
                                .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
                                .and_then(|(_, v)| v.trim().parse::<usize>().ok())
                                .unwrap_or(0);
                            while bytes.len() < header_end + length {
                                let n = stream.read(&mut block).unwrap_or(0);
                                if n == 0 {
                                    break;
                                }
                                bytes.extend_from_slice(&block[..n]);
                            }
                            let request = Request {
                                method,
                                target,
                                authorization: pairs
                                    .iter()
                                    .find(|(k, _)| k.eq_ignore_ascii_case("authorization"))
                                    .map(|(_, v)| v.trim().to_owned())
                                    .unwrap_or_default(),
                                body: serde_json::from_slice(
                                    bytes.get(header_end..header_end + length).unwrap_or(&[]),
                                )
                                .unwrap_or(Value::Null),
                            };
                            seen.lock().unwrap().push(request.clone());
                            if let Some(value) = handler(&request) {
                                let body = value.to_string();
                                let output=format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body);
                                let _ = stream.write_all(output.as_bytes());
                                let _ = stream.flush();
                                let _ = stream.shutdown(std::net::Shutdown::Write);
                                // Windows closes a socket with RST if the peer's
                                // final TCP bytes have not been drained yet.
                                let _ = stream.set_read_timeout(Some(Duration::from_millis(50)));
                                while stream.read(&mut block).is_ok_and(|n| n > 0) {}
                            }
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(2))
                        }
                        Err(_) => return,
                    }
                }
            });
            Self {
                base,
                stopped,
                requests,
                thread: Some(thread),
            }
        }
        fn api(&self) -> Api {
            Api {
                client: Client::builder()
                    .timeout(Duration::from_secs(2))
                    .pool_max_idle_per_host(0)
                    .no_proxy()
                    .redirect(reqwest::redirect::Policy::none())
                    .build()
                    .unwrap(),
                base: self.base.clone(),
                exchange: format!("{}/token/exchange", self.base),
                refresh: format!("{}/token/refresh", self.base),
                last_request: Mutex::new(None),
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            self.stopped.store(true, Ordering::SeqCst);
            if let Some(t) = self.thread.take() {
                t.join().unwrap();
            }
        }
    }
    fn token() -> Value {
        json!({"code":0,"access_token":"private-rotated-user-token","refresh_token":"private-rotated-refresh-token","expires_in":7200,"refresh_token_expires_in":604800,"scope":SCOPES,"token_type":"Bearer"})
    }
    fn identity() -> Value {
        json!({"code":0,"data":{"open_id":"ou_me","name":"本人"}})
    }
    fn message() -> Value {
        json!({"message_id":"om_question","chat_id":"oc_project","msg_type":"text","create_time":timestamp().to_string(),"sender":{"id":"ou_member","id_type":"open_id","sender_type":"user"},
            "body":{"content":json!({"text":"@_user_1  发布计划是什么？"}).to_string()},"mentions":[{"id":"ou_me","id_type":"open_id","key":"@_user_1","name":"本人"}]})
    }
    fn answer() -> Value {
        json!({"answer":"将在周五发布。","grounded":true,"citations":[{"sourceTitle":"发布计划","revision":2,"evidenceLabel":"第 2 段"}],"context":{"projectId":"project-1","workspaceEpoch":1}})
    }
    fn saved() -> Saved {
        let user = User {
            open_id: "ou_me".into(),
            name: "本人".into(),
        };
        Saved {
            app_id: "cli_fixture".into(),
            app_secret: Some("private-app-secret".into()),
            enabled: true,
            active_since: 0,
            bindings: vec![Binding {
                chat_id: "oc_project".into(),
                project_id: "project-1".into(),
                enabled: true,
                since: 0,
                ..Binding::default()
            }],
            session: Some(session_from_token(&token(), user).unwrap()),
            ..Saved::default()
        }
    }
    fn connector(root: &Path, fixture: &Fixture, ask: Ask) -> Connector {
        save_private(root, &saved()).unwrap();
        Connector::create(root.into(), ask, Arc::new(|_| Ok(())), fixture.api(), false).unwrap()
    }
    fn default_fixture(request: &Request) -> Option<Value> {
        if request.target.starts_with("/open-apis/authen/v1/user_info") {
            return Some(identity());
        }
        if request
            .target
            .starts_with("/open-apis/im/v1/messages/search")
        {
            assert_eq!(request.method, "POST");
            assert_eq!(request.body["query"], "");
            assert_eq!(request.body["filter"]["is_at_me"], true);
            return Some(
                json!({"code":0,"data":{"items":[{"meta_data":{"message_id":"om_question"}}],"has_more":false}}),
            );
        }
        if request.target.starts_with("/open-apis/im/v1/messages/mget") {
            return Some(json!({"code":0,"data":{"items":[message()]}}));
        }
        if request
            .target
            .starts_with("/open-apis/im/v1/messages/om_question/reply")
        {
            assert_eq!(request.body["msg_type"], "text");
            assert!(request.body["uuid"].as_str().unwrap().len() <= 50);
            return Some(json!({"code":0,"data":{"message_id":"om_reply"}}));
        }
        panic!("unexpected fixture request: {}", request.target)
    }

    fn private_binding() -> Binding {
        Binding {
            chat_id: "oc_private".into(),
            project_id: "project-private".into(),
            chat_type: ChatType::P2p,
            peer_id: "ou_colleague".into(),
            name: "同事甲".into(),
            enabled: true,
            since: 0,
        }
    }
    fn private_message() -> Value {
        let mut m = message();
        m["message_id"] = json!("om_private");
        m["chat_id"] = json!("oc_private");
        m["sender"]["id"] = json!("ou_colleague");
        m["sender"]["sender_name"] = json!("同事甲");
        m["body"]["content"] = json!(json!({"text":"发布计划是什么？"}).to_string());
        m.as_object_mut().unwrap().remove("mentions");
        m
    }
    fn private_fixture(r: &Request) -> Option<Value> {
        if r.target.starts_with("/open-apis/im/v1/chats/batch_query") {
            assert_eq!(r.body["chat_ids"], json!(["oc_private"]));
            return Some(
                json!({"code":0,"data":{"items":[{"chat_id":"oc_private","chat_mode":"p2p","p2p_target_id":"ou_colleague"}]}}),
            );
        }
        if r.target.starts_with("/open-apis/im/v1/messages/search")
            && r.body["filter"]["chat_type"] == "p2p"
        {
            assert!(r.body["filter"].get("is_at_me").is_none());
            assert_eq!(r.body["filter"]["from_types"], json!(["user"]));
            return Some(
                json!({"code":0,"data":{"items":[{"meta_data":{"message_id":"om_private"}}],"has_more":false}}),
            );
        }
        if r.target.starts_with("/open-apis/im/v1/messages/mget") && r.target.contains("om_private")
        {
            return Some(json!({"code":0,"data":{"items":[private_message()]}}));
        }
        if r.target
            .starts_with("/open-apis/im/v1/messages/om_private/reply")
        {
            return Some(json!({"code":0,"data":{"message_id":"om_private_reply"}}));
        }
        default_fixture(r)
    }
    #[test]
    fn private_messages_need_exact_colleague_and_binding_but_no_mention() {
        let mut s = saved();
        s.bindings.push(private_binding());
        let original = private_message();
        let c = candidate(&s, "ou_me", &original).unwrap();
        assert_eq!(c.project_id, "project-private");
        assert_eq!(c.question, "发布计划是什么？");
        for case in [
            "own",
            "other-colleague",
            "wrong-id-type",
            "bot",
            "other-chat",
            "old",
            "deleted",
            "image",
            "empty",
        ] {
            let mut m = original.clone();
            match case {
                "own" => m["sender"]["id"] = json!("ou_me"),
                "other-colleague" => m["sender"]["id"] = json!("ou_else"),
                "wrong-id-type" => m["sender"]["id_type"] = json!("user_id"),
                "bot" => m["sender"]["sender_type"] = json!("bot"),
                "other-chat" => m["chat_id"] = json!("oc_else"),
                "old" => m["create_time"] = json!("-1"),
                "deleted" => m["deleted"] = json!(true),
                "image" => m["msg_type"] = json!("image"),
                "empty" => m["body"]["content"] = json!(json!({"text":" "}).to_string()),
                _ => unreachable!(),
            }
            assert!(candidate(&s, "ou_me", &m).is_none(), "{case}");
        }
        let mut rich = original.clone();
        rich["msg_type"] = json!("post");
        rich["body"]["content"] =
            json!(json!({"content":[[{"tag":"text","text":"周五发布吗？"}]]}).to_string());
        assert_eq!(
            candidate(&s, "ou_me", &rich).unwrap().question,
            "周五发布吗？"
        );
        s.bindings[1].since = timestamp() + 1;
        assert!(candidate(&s, "ou_me", &original).is_none());
        s.bindings[1].since = 0;
        s.bindings[1].enabled = false;
        assert!(candidate(&s, "ou_me", &original).is_none());
        // Ordinary group messages still require @me.
        let mut group = message();
        group.as_object_mut().unwrap().remove("mentions");
        assert!(candidate(&s, "ou_me", &group).is_none());
    }
    #[test]
    fn private_and_group_replies_keep_project_scope_and_deduplicate_across_restart() {
        let fixture = Fixture::new(private_fixture);
        let dir = tempfile::tempdir().unwrap();
        let c = connector(
            dir.path(),
            &fixture,
            Arc::new(|project, question| {
                assert!(["project-1", "project-private"].contains(&project));
                assert_eq!(question, "发布计划是什么？");
                Ok(answer())
            }),
        );
        {
            let mut state = lock(&c.inner.state).unwrap();
            state.saved.bindings.push(private_binding());
            c.inner.persist(&state.saved).unwrap();
        }
        c.inner.poll().unwrap();
        c.inner.poll().unwrap();
        assert_eq!(replies(&fixture), 2);
        let recent = c.inner.status().unwrap()["recentMessages"].clone();
        let private = recent
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["chatType"] == "p2p")
            .unwrap();
        assert_eq!(private["peerName"], "同事甲");
        assert_eq!(private["projectId"], "project-private");
        assert_eq!(private["status"], "replied");
        drop(c);
        let reopened = Connector::create(
            dir.path().into(),
            Arc::new(|_, _| panic!("duplicate answer")),
            Arc::new(|_| Ok(())),
            fixture.api(),
            false,
        )
        .unwrap();
        reopened.inner.poll().unwrap();
        assert_eq!(replies(&fixture), 2);
    }
    #[test]
    fn private_chat_identity_must_match_server_before_generation_or_send() {
        for (mode, peer) in [("group", "ou_colleague"), ("p2p", "ou_else")] {
            let fixture = Fixture::new(move |r| {
                if r.target.starts_with("/open-apis/im/v1/chats/batch_query") {
                    return Some(
                        json!({"code":0,"data":{"items":[{"chat_id":"oc_private","chat_mode":mode,"p2p_target_id":peer}]}}),
                    );
                }
                private_fixture(r)
            });
            let dir = tempfile::tempdir().unwrap();
            let c = connector(
                dir.path(),
                &fixture,
                Arc::new(|_, _| panic!("unverified private chat")),
            );
            lock(&c.inner.state).unwrap().saved.bindings = vec![private_binding()];
            assert_eq!(c.inner.poll().unwrap_err().code, "FEISHU_PRIVATE_CHAT");
            assert_eq!(replies(&fixture), 0);
        }
    }
    #[test]
    fn private_discovery_lists_peers_without_sending_or_retaining_history() {
        let fixture = Fixture::new(private_fixture);
        let dir = tempfile::tempdir().unwrap();
        let c = connector(
            dir.path(),
            &fixture,
            Arc::new(|_, _| panic!("discovery must not answer")),
        );
        let result = c
            .handle("list_feishu_private_chats", &json!({}))
            .unwrap()
            .unwrap();
        assert_eq!(
            result["chats"],
            json!([{"chatId":"oc_private","peerId":"ou_colleague","name":"同事甲"}])
        );
        assert!(!result.to_string().contains("发布计划"));
        assert!(c.inner.status().unwrap()["recentMessages"]
            .as_array()
            .unwrap()
            .is_empty());
        assert_eq!(replies(&fixture), 0);
    }
    #[test]
    fn private_reply_requires_evidence_and_ambiguous_send_never_retries() {
        for grounded in [false, true] {
            let fixture = Fixture::new(|r| {
                if r.target.contains("/reply") {
                    None
                } else {
                    private_fixture(r)
                }
            });
            let dir = tempfile::tempdir().unwrap();
            let c = connector(
                dir.path(),
                &fixture,
                Arc::new(move |_, _| {
                    let mut result = answer();
                    result["grounded"] = json!(grounded);
                    Ok(result)
                }),
            );
            lock(&c.inner.state).unwrap().saved.bindings = vec![private_binding()];
            c.inner.poll().unwrap();
            c.inner.poll().unwrap();
            assert_eq!(replies(&fixture), usize::from(grounded));
            assert_eq!(
                c.inner.status().unwrap()["recentMessages"][0]["status"],
                if grounded { "unknown" } else { "skipped" }
            );
        }
    }
    #[test]
    fn legacy_receipts_migrate_without_losing_deduplication_or_send_status() {
        let fixture = Fixture::new(default_fixture);
        let dir = tempfile::tempdir().unwrap();
        save_private(dir.path(), &saved()).unwrap();
        let db = Connection::open(dir.path().join("feishu-runtime.sqlite")).unwrap();
        db.execute_batch("CREATE TABLE receipts (
            id TEXT PRIMARY KEY, account TEXT NOT NULL, message_id TEXT NOT NULL,
            chat_id TEXT NOT NULL, project_id TEXT NOT NULL, question TEXT NOT NULL,
            answer TEXT, status TEXT NOT NULL, error TEXT, generation TEXT NOT NULL,
            uuid TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
            reply_id TEXT, UNIQUE(account,message_id));
            INSERT INTO receipts VALUES ('legacy','cli_fixture:ou_me','om_question','oc_project',
                'project-1','发布计划是什么？','已回复','replied',NULL,'old-generation','stable-uuid','before','before','om_reply');").unwrap();
        drop(db);
        let c = Connector::create(
            dir.path().into(),
            Arc::new(|_, _| panic!("legacy reply must not be regenerated")),
            Arc::new(|_| Ok(())),
            fixture.api(),
            false,
        )
        .unwrap();
        c.inner.poll().unwrap();
        let old = c.inner.status().unwrap()["recentMessages"][0].clone();
        assert_eq!(old["id"], "legacy");
        assert_eq!(old["chatType"], "group");
        assert_eq!(old["status"], "replied");
        assert_eq!(replies(&fixture), 0);
        drop(c);
        let reopened = Connector::create(
            dir.path().into(),
            Arc::new(|_, _| panic!("duplicate reply")),
            Arc::new(|_| Ok(())),
            fixture.api(),
            false,
        )
        .unwrap();
        reopened.inner.poll().unwrap();
        assert_eq!(replies(&fixture), 0);
    }
    #[test]
    fn old_group_settings_stay_group_and_private_changes_reset_start_time() {
        let old = saved();
        let mut serialized = serde_json::to_value(&old).unwrap();
        for key in ["chatType", "peerId", "name"] {
            serialized["bindings"][0]
                .as_object_mut()
                .unwrap()
                .remove(key);
        }
        let legacy: Saved = serde_json::from_value(serialized).unwrap();
        assert!(legacy.bindings[0].chat_type == ChatType::Group);
        let mut s = old.clone();
        s.bindings = vec![private_binding()];
        let mut input = public_settings(&s);
        let unchanged = parse_settings(&s, &input).unwrap();
        assert_eq!(unchanged.bindings[0].since, 0);
        input["bindings"][0]["projectId"] = json!("project-new");
        assert!(parse_settings(&s, &input).unwrap().bindings[0].since > 0);
        input["bindings"][0]["peerId"] = json!("ou_other");
        assert!(parse_settings(&s, &input).unwrap().bindings[0].since > 0);
        input["bindings"][0]["peerId"] = json!("");
        assert!(parse_settings(&s, &input).is_err());
        input["bindings"][0]["chatType"] = json!("unknown");
        assert!(parse_settings(&s, &input).is_err());
    }

    #[test]
    fn knowledge_sync_reads_only_selected_chat_includes_threads_and_excludes_own_replies() {
        let fixed_time = timestamp();
        let fixture = Fixture::new(move |request| {
            if request.target.starts_with("/open-apis/authen/v1/user_info") {
                return Some(identity());
            }
            if request
                .target
                .starts_with("/open-apis/im/v1/messages/search?")
            {
                assert_eq!(request.body["filter"]["chat_ids"], json!(["oc_selected"]));
                assert!(request.body["filter"].get("is_at_me").is_none());
                return Some(
                    json!({"code":0,"data":{"items":[{"meta_data":{"message_id":"om_old_topic_reply"}}],"has_more":false}}),
                );
            }
            if request
                .target
                .starts_with("/open-apis/im/v1/messages/mget?")
            {
                let mut reply = message();
                reply["create_time"] = json!(fixed_time.to_string());
                reply["message_id"] = json!("om_old_topic_reply");
                reply["chat_id"] = json!("oc_selected");
                return Some(json!({"code":0,"data":{"items":[reply]}}));
            }
            if request.target.starts_with("/open-apis/im/v1/messages?") {
                let url = Url::parse(&format!("http://localhost{}", request.target)).unwrap();
                let q = url
                    .query_pairs()
                    .collect::<std::collections::HashMap<_, _>>();
                assert_eq!(request.authorization, "Bearer private-rotated-user-token");
                if q["container_id_type"] == "thread" {
                    assert_eq!(q["container_id"], "omt_thread");
                    let mut reply = message();
                    reply["create_time"] = json!(fixed_time.to_string());
                    reply["chat_id"] = json!("oc_selected");
                    reply["message_id"] = json!("om_thread_reply");
                    reply["body"]["content"] = json!(json!({"text":"该功能周五发布"}).to_string());
                    return Some(json!({"code":0,"data":{"items":[reply],"has_more":false}}));
                }
                assert_eq!(q["container_id"], "oc_selected");
                let mut member = message();
                member["create_time"] = json!(fixed_time.to_string());
                member["chat_id"] = json!("oc_selected");
                member["thread_id"] = json!("omt_thread");
                let mut own = message();
                own["chat_id"] = json!("oc_selected");
                own["message_id"] = json!("om_own");
                own["sender"]["id"] = json!("ou_me");
                own["body"]["content"] =
                    json!(json!({"text":"个人助理代答：\n自动生成的回复"}).to_string());
                let mut bot = message();
                bot["chat_id"] = json!("oc_selected");
                bot["sender"]["sender_type"] = json!("app");
                bot["message_id"] = json!("om_bot");
                return Some(json!({"code":0,"data":{"items":[member,own,bot],"has_more":false}}));
            }
            panic!("unexpected endpoint: {}", request.target)
        });
        let dir = tempfile::tempdir().unwrap();
        let c = connector(
            dir.path(),
            &fixture,
            Arc::new(|_, _| panic!("must not answer during source sync")),
        );
        let collected = Arc::new(Mutex::new(Vec::<Value>::new()));
        let sink = collected.clone();
        c.set_ingest(Arc::new(move |p| {
            let mut list = sink.lock().unwrap();
            let duplicate = list.iter().any(|v| {
                v["origin"]["remoteId"] == p["origin"]["remoteId"]
                    && v["origin"]["remoteRevision"] == p["origin"]["remoteRevision"]
            });
            if !duplicate {
                list.push(p.clone())
            }
            Ok(json!({"duplicate":duplicate}))
        }))
        .unwrap();
        c.inner.save_knowledge(&json!({"enabled":true,"intervalSeconds":60,"sources":[{"kind":"chat","target":"oc_selected","projectId":"project-1","enabled":true,"historyDays":7},{"kind":"chat","target":"oc_disabled","projectId":"project-1","enabled":false,"historyDays":7}]})).unwrap();
        let out = c.inner.sync_knowledge().unwrap();
        assert_eq!(out["imported"], 1);
        assert_eq!(out["failures"], 0);
        assert_eq!(c.inner.sync_knowledge().unwrap()["imported"], 0);
        assert_eq!(collected.lock().unwrap().len(), 1);
        assert_eq!(
            collected.lock().unwrap()[0]["origin"]["provider"],
            "feishu_chat"
        );
        let text = collected.lock().unwrap()[0]["text"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(
            text.contains("om_old_topic_reply")
                && text.contains("om_thread_reply")
                && text.contains("ou_member")
        );
        assert!(!text.contains("自动生成的回复"));
        c.pause().unwrap();
        assert_eq!(
            c.inner.knowledge_status().unwrap()["settings"]["enabled"],
            false
        );
        assert!(c.inner.metadata("knowledge-last").unwrap().is_none());
    }

    #[test]
    fn document_revision_is_checked_before_and_after_read_and_unchanged_documents_skip_content() {
        use std::sync::atomic::AtomicUsize;
        let reads = Arc::new(AtomicUsize::new(0));
        let seen = reads.clone();
        let fixture = Fixture::new(move |request| {
            if request.target.starts_with("/open-apis/authen/v1/user_info") {
                return Some(identity());
            }
            if request
                .target
                .starts_with("/open-apis/wiki/v2/spaces/get_node?")
            {
                return Some(
                    json!({"code":0,"data":{"node":{"obj_type":"docx","obj_token":"doc_fixture"}}}),
                );
            }
            if request.target.ends_with("/raw_content") {
                return Some(json!({"code":0,"data":{"content":"项目一期采用本地存储。"}}));
            }
            if request.target.ends_with("/documents/doc_fixture") {
                let n = seen.fetch_add(1, Ordering::SeqCst);
                return Some(
                    json!({"code":0,"data":{"document":{"title":"项目设计","revision_id":if n==0{1}else{2}}}}),
                );
            }
            panic!("unexpected endpoint: {}", request.target)
        });
        let dir = tempfile::tempdir().unwrap();
        let c = connector(dir.path(), &fixture, Arc::new(|_, _| panic!()));
        let collected = Arc::new(Mutex::new(Vec::<Value>::new()));
        let sink = collected.clone();
        c.set_ingest(Arc::new(move |p| {
            sink.lock().unwrap().push(p.clone());
            Ok(json!({"duplicate":false}))
        }))
        .unwrap();
        c.inner.save_knowledge(&json!({"enabled":true,"intervalSeconds":60,"sources":[{"kind":"document","target":"https://team.feishu.cn/wiki/wiki_fixture","projectId":"project-1","enabled":true,"historyDays":7}]})).unwrap();
        assert_eq!(c.inner.sync_knowledge().unwrap()["failures"], 1);
        assert!(collected.lock().unwrap().is_empty());
        assert_eq!(c.inner.sync_knowledge().unwrap()["imported"], 1);
        assert_eq!(
            collected.lock().unwrap()[0]["origin"]["remoteRevision"],
            "2"
        );
        assert_eq!(c.inner.sync_knowledge().unwrap()["imported"], 0);
        assert_eq!(
            fixture
                .requests
                .lock()
                .unwrap()
                .iter()
                .filter(|r| r.target.ends_with("/raw_content"))
                .count(),
            2
        );
        assert_eq!(reads.load(Ordering::SeqCst), 5);
    }

    #[test]
    fn knowledge_pagination_failure_or_workspace_write_failure_never_advances_cursor() {
        let fail = Arc::new(AtomicBool::new(true));
        let failing = fail.clone();
        let fixture = Fixture::new(move |request| {
            if request.target.starts_with("/open-apis/authen/v1/user_info") {
                return Some(identity());
            }
            if request
                .target
                .starts_with("/open-apis/im/v1/messages/search?")
            {
                return Some(json!({"code":0,"data":{"items":[],"has_more":false}}));
            }
            if request.target.starts_with("/open-apis/im/v1/messages?") {
                if request.target.contains("page_token=") {
                    return Some(json!({"code":999999,"msg":"fixture failure"}));
                }
                return Some(
                    json!({"code":0,"data":{"items":[message()],"has_more":failing.load(Ordering::SeqCst),"page_token":"next"}}),
                );
            }
            panic!()
        });
        let dir = tempfile::tempdir().unwrap();
        let c = connector(dir.path(), &fixture, Arc::new(|_, _| panic!()));
        c.set_ingest(Arc::new(|_| Err(error("IO", "写入失败"))))
            .unwrap();
        c.inner.save_knowledge(&json!({"enabled":true,"intervalSeconds":60,"sources":[{"kind":"chat","target":"oc_project","projectId":"project-1","enabled":true,"historyDays":7}]})).unwrap();
        let saved = lock(&c.inner.state).unwrap().saved.clone();
        let key = c.inner.source_key(&saved.knowledge.sources[0], "ou_me");
        assert_eq!(c.inner.sync_knowledge().unwrap()["failures"], 1);
        assert!(c.inner.metadata(&key).unwrap().is_none());
        fail.store(false, Ordering::SeqCst);
        assert_eq!(c.inner.sync_knowledge().unwrap()["failures"], 1);
        assert!(c.inner.metadata(&key).unwrap().is_none());
        c.set_ingest(Arc::new(|_| Ok(json!({"duplicate":false}))))
            .unwrap();
        assert_eq!(c.inner.sync_knowledge().unwrap()["imported"], 1);
        assert!(c.inner.metadata(&key).unwrap().is_some());
    }

    #[test]
    fn dense_chat_backfill_reduces_window_and_commits_only_a_complete_slice() {
        let fixture = Fixture::new(|request| {
            if request.target.starts_with("/open-apis/authen/v1/user_info") {
                return Some(identity());
            }
            if request
                .target
                .starts_with("/open-apis/im/v1/messages/search?")
            {
                return Some(json!({"code":0,"data":{"items":[],"has_more":false}}));
            }
            let url = Url::parse(&format!("http://localhost{}", request.target)).unwrap();
            let q = url
                .query_pairs()
                .collect::<std::collections::HashMap<_, _>>();
            let start = q["start_time"].parse::<i64>().unwrap();
            let end = q["end_time"].parse::<i64>().unwrap();
            Some(
                json!({"code":0,"data":{"items":[],"has_more":end-start>3600,"page_token":"repeat"}}),
            )
        });
        let dir = tempfile::tempdir().unwrap();
        let c = connector(dir.path(), &fixture, Arc::new(|_, _| panic!()));
        c.set_ingest(Arc::new(|_| panic!("empty pages cannot be imported")))
            .unwrap();
        c.inner.save_knowledge(&json!({"enabled":true,"intervalSeconds":60,"sources":[{"kind":"chat","target":"oc_project","projectId":"project-1","enabled":true,"historyDays":7}]})).unwrap();
        let out = c.inner.sync_knowledge().unwrap();
        assert_eq!(out["failures"], 0);
        let status = c.inner.knowledge_status().unwrap();
        let through = chrono::DateTime::parse_from_rfc3339(
            status["statuses"][0]["through"].as_str().unwrap(),
        )
        .unwrap()
        .timestamp();
        assert!(
            through < timestamp() - 86400,
            "backfill must not claim it has reached current time"
        );
        let requests = fixture.requests.lock().unwrap();
        assert!(
            requests
                .iter()
                .filter(|r| r.target.starts_with("/open-apis/im/v1/messages?"))
                .count()
                > 2
        );
    }
    fn replies(fixture: &Fixture) -> usize {
        fixture
            .requests
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r.target.contains("/reply"))
            .count()
    }

    #[test]
    fn oauth_state_pkce_path_expiry_and_duplicate_values_are_checked() {
        let s = saved();
        let p = new_authorization(&s).unwrap();
        let url = Url::parse(&p.url).unwrap();
        let pairs: std::collections::HashMap<_, _> = url.query_pairs().collect();
        assert_eq!(pairs["code_challenge_method"], "S256");
        assert_eq!(
            pairs["code_challenge"],
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .encode(Sha256::digest(p.verifier.as_bytes()))
        );
        assert!(p.verifier.len() >= 43);
        assert!(!p.url.contains("private-app-secret"));
        assert!(!p.url.contains(&p.verifier));
        let good = format!("/feishu/callback?code=valid_code&state={}", p.state);
        assert_eq!(callback_code(&good, &p).unwrap(), "valid_code");
        for bad in [
            "/feishu/callback?code=abc&state=wrong".to_owned(),
            format!("/wrong?code=abc&state={}", p.state),
            format!("{good}&state={}", p.state),
            format!("{good}&code=second"),
            format!("{good}#fragment"),
        ] {
            assert_eq!(
                callback_code(&bad, &p).unwrap_err().code,
                "FEISHU_OAUTH_STATE"
            );
        }
        let mut expired = p.clone();
        expired.expires_at = timestamp() - 1;
        assert!(callback_code(&good, &expired).is_err());
        assert_eq!(
            callback_code(
                &format!("/feishu/callback?error=access_denied&state={}", p.state),
                &p
            )
            .unwrap_err()
            .code,
            "FEISHU_OAUTH_DENIED"
        );
    }
    #[test]
    fn settings_never_expose_credentials_and_preserve_only_matching_application() {
        let old = saved();
        let p = json!({"appId":old.app_id,"enabled":false,"pollIntervalSeconds":60,"replyPrefix":"代答：","bindings":[{"chatId":"oc_project","projectId":"project-1","enabled":true}]});
        let next = parse_settings(&old, &p).unwrap();
        assert_eq!(next.app_secret.as_deref(), Some("private-app-secret"));
        assert!(next.session.is_some());
        let public = public_settings(&next).to_string();
        for secret in [
            "private-app-secret",
            "private-rotated-user-token",
            "private-rotated-refresh-token",
        ] {
            assert!(!public.contains(secret));
        }
        let mut changed = p.clone();
        changed["appId"] = json!("cli_other");
        let new = parse_settings(&old, &changed).unwrap();
        assert!(new.session.is_none());
        assert!(new.app_secret.is_none());
        changed["appId"] = json!("https://attacker.invalid");
        assert!(parse_settings(&old, &changed).is_err());
        changed = p.clone();
        changed["pollIntervalSeconds"] = json!(1);
        assert!(parse_settings(&old, &changed).is_err());
        changed = p;
        let duplicate = changed["bindings"][0].clone();
        changed["bindings"].as_array_mut().unwrap().push(duplicate);
        assert!(parse_settings(&old, &changed).is_err());
    }
    #[test]
    fn only_exact_personal_mentions_in_enabled_project_chats_are_candidates() {
        let s = saved();
        let original = message();
        assert_eq!(
            candidate(&s, "ou_me", &original).unwrap().question,
            "发布计划是什么？"
        );
        for path in [
            "all",
            "own",
            "other-chat",
            "bot",
            "deleted",
            "stale",
            "other-user",
            "wrong-id-type",
            "card",
        ] {
            let mut m = original.clone();
            match path {
                "all" => m["mentions"][0]["id"] = json!("all"),
                "own" => m["sender"]["id"] = json!("ou_me"),
                "other-chat" => m["chat_id"] = json!("oc_unbound"),
                "bot" => m["sender"]["sender_type"] = json!("bot"),
                "deleted" => m["deleted"] = json!(true),
                "stale" => m["create_time"] = json!("-1"),
                "other-user" => m["mentions"][0]["id"] = json!("ou_other"),
                "wrong-id-type" => m["mentions"][0]["id_type"] = json!("user_id"),
                "card" => m["msg_type"] = json!("interactive"),
                _ => (),
            }
            assert!(
                candidate(&s, "ou_me", &m).is_none(),
                "unexpected candidate {path}"
            );
        }
    }
    #[test]
    fn rich_text_and_other_member_mentions_preserve_the_question_subject() {
        let s = saved();
        let mut m = message();
        m["mentions"]
            .as_array_mut()
            .unwrap()
            .push(json!({"id":"ou_zhang","id_type":"open_id","key":"@_user_2","name":"张三"}));
        m["body"]["content"] = json!(json!({"text":"@_user_1 @_user_2 负责发布吗？"}).to_string());
        assert_eq!(
            candidate(&s, "ou_me", &m).unwrap().question,
            "张三 负责发布吗？"
        );
        let post = json!({"title":"发布安排","content":[[{"tag":"at","user_id":"ou_me"},{"tag":"at","user_id":"ou_zhang"},{"tag":"text","text":"负责"},{"tag":"a","text":"客户端"},{"tag":"md","text":"发布吗？"},{"tag":"img","image_key":"never-read-image"}]]});
        m["msg_type"] = json!("post");
        for content in [
            post.clone(),
            json!({"zh_cn":post.clone()}),
            json!({"en_us":post}),
        ] {
            m["body"]["content"] = json!(content.to_string());
            assert_eq!(
                candidate(&s, "ou_me", &m).unwrap().question,
                "发布安排\n张三负责客户端发布吗？"
            );
        }
        m["body"]["content"]=json!(json!({"content":[[{"tag":"at","user_id":"ou_me"},{"tag":"img","image_key":"no-ocr"}]]}).to_string());
        assert!(candidate(&s, "ou_me", &m).is_none());
    }
    #[test]
    fn oauth_callback_handles_split_headers_on_windows_nonblocking_listener() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let reader = thread::spawn(move || loop {
            match listener.accept() {
                Ok((mut stream, _)) => return read_callback_target(&mut stream),
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(1))
                }
                Err(e) => return Err(e.into()),
            }
        });
        let mut client = TcpStream::connect(address).unwrap();
        client
            .write_all(b"GET /feishu/callback?code=fixture_code&state=fixture_state HTTP/1.1\r\n")
            .unwrap();
        thread::sleep(Duration::from_millis(20));
        client.write_all(b"Host: 127.0.0.1:17179\r\n\r\n").unwrap();
        assert_eq!(
            reader.join().unwrap().unwrap(),
            "/feishu/callback?code=fixture_code&state=fixture_state"
        );
    }
    #[test]
    fn callback_consumes_state_once_and_verifies_the_previously_authorized_person() {
        let fixture = Fixture::new(|r| {
            if r.target.starts_with("/token/exchange") {
                assert!(r.body["code_verifier"].as_str().unwrap().len() >= 43);
                Some(token())
            } else {
                Some(identity())
            }
        });
        let dir = tempfile::tempdir().unwrap();
        let c = connector(dir.path(), &fixture, Arc::new(|_, _| Ok(answer())));
        let p = new_authorization(&lock(&c.inner.state).unwrap().saved).unwrap();
        lock(&c.inner.state).unwrap().authorization = Some(p.clone());
        let target = format!("/feishu/callback?code=valid_code&state={}", p.state);
        c.inner.finish_authorization(&target).unwrap();
        assert_eq!(
            c.inner.status().unwrap()["authorization"]["status"],
            "connected"
        );
        assert!(c.inner.finish_authorization(&target).is_err());
        assert_eq!(
            fixture
                .requests
                .lock()
                .unwrap()
                .iter()
                .filter(|r| r.target.starts_with("/token/exchange"))
                .count(),
            1
        );
        let mut p = new_authorization(&lock(&c.inner.state).unwrap().saved).unwrap();
        p.expected_user = Some("ou_someone_else".into());
        lock(&c.inner.state).unwrap().authorization = Some(p.clone());
        assert_eq!(
            c.inner
                .finish_authorization(&format!(
                    "/feishu/callback?code=other_code&state={}",
                    p.state
                ))
                .unwrap_err()
                .code,
            "FEISHU_ACCOUNT_MISMATCH"
        );
    }
    #[test]
    fn refresh_rotates_and_persists_user_tokens_without_returning_them() {
        let fixture = Fixture::new(|r| {
            if r.target.starts_with("/token/refresh") {
                assert_eq!(r.body["grant_type"], "refresh_token");
                Some(token())
            } else {
                Some(identity())
            }
        });
        let dir = tempfile::tempdir().unwrap();
        let c = connector(dir.path(), &fixture, Arc::new(|_, _| Ok(answer())));
        {
            let mut s = lock(&c.inner.state).unwrap();
            let session = s.saved.session.as_mut().unwrap();
            session.expires_at = timestamp() - 1;
            session.access_token = "private-old-user-token".into();
            session.refresh_token = "private-old-refresh-token".into();
        }
        let (_, session) = c.inner.valid_session().unwrap();
        assert_eq!(session.access_token, "private-rotated-user-token");
        let persisted = load_saved(dir.path()).unwrap();
        assert_eq!(
            persisted.session.unwrap().refresh_token,
            "private-rotated-refresh-token"
        );
        let status = c.inner.status().unwrap().to_string();
        assert!(!status.contains("private-"));
        let requests = fixture.requests.lock().unwrap();
        assert_eq!(
            requests
                .iter()
                .filter(|r| r.target.starts_with("/token/refresh"))
                .count(),
            1
        );
        assert!(requests
            .iter()
            .filter(|r| r.target.starts_with("/open-apis/"))
            .all(|r| r.authorization == "Bearer private-rotated-user-token"));
    }
    #[test]
    fn repeated_search_and_restart_reply_once_with_personal_user_token() {
        let fixture = Fixture::new(default_fixture);
        let dir = tempfile::tempdir().unwrap();
        let count = Arc::new(AtomicUsize::new(0));
        let counted = count.clone();
        let c = connector(
            dir.path(),
            &fixture,
            Arc::new(move |_, _| {
                counted.fetch_add(1, Ordering::SeqCst);
                Ok(answer())
            }),
        );
        c.inner.poll().unwrap();
        c.inner.poll().unwrap();
        assert_eq!(count.load(Ordering::SeqCst), 1);
        assert_eq!(replies(&fixture), 1);
        assert_eq!(
            c.inner.status().unwrap()["recentMessages"][0]["status"],
            "replied"
        );
        drop(c);
        let reopened = Connector::create(
            dir.path().into(),
            Arc::new(|_, _| panic!("duplicate generation")),
            Arc::new(|_| Ok(())),
            fixture.api(),
            false,
        )
        .unwrap();
        reopened.inner.poll().unwrap();
        assert_eq!(replies(&fixture), 1);
        assert!(fixture
            .requests
            .lock()
            .unwrap()
            .iter()
            .all(|r| r.authorization == "Bearer private-rotated-user-token"));
    }
    #[test]
    fn ambiguous_send_is_visible_and_never_retried() {
        let fixture = Fixture::new(|r| {
            if r.target.contains("/reply") {
                None
            } else {
                default_fixture(r)
            }
        });
        let dir = tempfile::tempdir().unwrap();
        let c = connector(dir.path(), &fixture, Arc::new(|_, _| Ok(answer())));
        c.inner.poll().unwrap();
        c.inner.poll().unwrap();
        assert_eq!(replies(&fixture), 1);
        assert_eq!(
            c.inner.status().unwrap()["recentMessages"][0]["status"],
            "unknown"
        );
    }
    #[test]
    fn incomplete_pagination_keeps_watermark_and_restarts_discovered_pending_work() {
        let fixture = Fixture::new(|r| {
            if r.target.starts_with("/open-apis/im/v1/messages/search") {
                if r.target.contains("page_token=p2") {
                    return Some(json!({"code":500,"msg":"private fixture error"}));
                }
                return Some(
                    json!({"code":0,"data":{"items":[{"meta_data":{"message_id":"om_question"}}],"has_more":true,"page_token":"p2"}}),
                );
            }
            default_fixture(r)
        });
        let dir = tempfile::tempdir().unwrap();
        let c = connector(dir.path(), &fixture, Arc::new(|_, _| Ok(answer())));
        assert!(c.inner.poll().is_err());
        assert_eq!(replies(&fixture), 0);
        assert_eq!(
            c.inner.status().unwrap()["recentMessages"][0]["status"],
            "pending"
        );
        assert_eq!(
            lock(&c.inner.receipts)
                .unwrap()
                .query_row(
                    "SELECT COUNT(*) FROM metadata WHERE key LIKE 'watermark:%'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        drop(c);
        let reopened = Connector::create(
            dir.path().into(),
            Arc::new(|_, _| Ok(answer())),
            Arc::new(|_| Ok(())),
            fixture.api(),
            false,
        )
        .unwrap();
        assert!(reopened.inner.poll().is_err());
        assert_eq!(replies(&fixture), 1);
        assert!(reopened.inner.poll().is_err());
        assert_eq!(replies(&fixture), 1);
    }
    #[test]
    fn pause_during_generation_cancels_late_result_and_prevents_send() {
        for private in [false, true] {
            let fixture = Fixture::new(if private {
                private_fixture
            } else {
                default_fixture
            });
            let dir = tempfile::tempdir().unwrap();
            let (started, ready) = mpsc::channel();
            let (release, wait) = mpsc::channel();
            let wait = Mutex::new(wait);
            let c = connector(
                dir.path(),
                &fixture,
                Arc::new(move |_, _| {
                    started.send(()).unwrap();
                    wait.lock()
                        .unwrap()
                        .recv_timeout(Duration::from_secs(5))
                        .unwrap();
                    Ok(answer())
                }),
            );
            if private {
                lock(&c.inner.state).unwrap().saved.bindings = vec![private_binding()];
            }
            let inner = c.inner.clone();
            let job = thread::spawn(move || inner.poll());
            ready.recv_timeout(Duration::from_secs(5)).unwrap();
            c.pause().unwrap();
            release.send(()).unwrap();
            let _ = job.join().unwrap();
            assert_eq!(replies(&fixture), 0);
            assert!(!load_saved(dir.path()).unwrap().enabled);
            assert_eq!(
                c.inner.status().unwrap()["recentMessages"][0]["status"],
                "cancelled"
            );
        }
    }

    #[test]
    fn identity_mismatch_and_missing_evidence_never_send() {
        let fixture = Fixture::new(|r| {
            if r.target.starts_with("/open-apis/authen/v1/user_info") {
                Some(json!({"code":0,"data":{"open_id":"ou_other","name":"Other"}}))
            } else {
                panic!("should not read or write chats")
            }
        });
        let dir = tempfile::tempdir().unwrap();
        let c = connector(
            dir.path(),
            &fixture,
            Arc::new(|_, _| panic!("should not generate")),
        );
        assert_eq!(c.inner.poll().unwrap_err().code, "FEISHU_ACCOUNT_MISMATCH");
        assert_eq!(replies(&fixture), 0);
        drop(c);
        drop(fixture);
        let fixture = Fixture::new(default_fixture);
        let c = connector(
            dir.path(),
            &fixture,
            Arc::new(|_, _| Ok(json!({"grounded":false,"answer":"猜测","citations":[]}))),
        );
        c.inner.poll().unwrap();
        assert_eq!(replies(&fixture), 0);
        assert_eq!(
            c.inner.status().unwrap()["recentMessages"][0]["status"],
            "skipped"
        );
    }
    #[test]
    fn final_context_validation_can_cancel_generation_after_memory_changes() {
        let fixture = Fixture::new(default_fixture);
        let dir = tempfile::tempdir().unwrap();
        save_private(dir.path(), &saved()).unwrap();
        let c = Connector::create(
            dir.path().into(),
            Arc::new(|_, _| Ok(answer())),
            Arc::new(|_| Err(error("STALE_CONTEXT", "memory changed"))),
            fixture.api(),
            false,
        )
        .unwrap();
        c.inner.poll().unwrap();
        assert_eq!(replies(&fixture), 0);
        assert_eq!(
            c.inner.status().unwrap()["recentMessages"][0]["status"],
            "cancelled"
        );
    }

    #[test]
    fn refresh_rotation_is_saved_even_if_pause_cancels_its_business_generation() {
        let (started, ready) = mpsc::channel();
        let (release, wait) = mpsc::channel();
        let fixture = Fixture::new(move |r| {
            if r.target.starts_with("/token/refresh") {
                started.send(()).unwrap();
                wait.recv_timeout(Duration::from_secs(5)).unwrap();
                Some(token())
            } else {
                Some(identity())
            }
        });
        let dir = tempfile::tempdir().unwrap();
        let c = connector(dir.path(), &fixture, Arc::new(|_, _| Ok(answer())));
        {
            let mut s = lock(&c.inner.state).unwrap();
            let session = s.saved.session.as_mut().unwrap();
            session.expires_at = timestamp() - 1;
            session.refresh_token = "private-original-refresh".into();
        }
        let inner = c.inner.clone();
        let refresh = thread::spawn(move || inner.valid_session().map(|_| ()));
        ready.recv_timeout(Duration::from_secs(5)).unwrap();
        c.pause().unwrap();
        release.send(()).unwrap();
        assert_eq!(
            refresh.join().unwrap().unwrap_err().code,
            "FEISHU_CANCELLED"
        );
        let persisted = load_saved(dir.path()).unwrap();
        assert!(!persisted.enabled);
        assert_eq!(
            persisted.session.as_ref().unwrap().refresh_token,
            "private-rotated-refresh-token"
        );
        assert!(!persisted.session.unwrap().invalid);
    }

    #[test]
    fn transient_final_identity_check_returns_receipt_to_pending_instead_of_sticking() {
        let calls = AtomicUsize::new(0);
        let fixture = Fixture::new(move |r| {
            if r.target.starts_with("/open-apis/authen/v1/user_info") {
                let n = calls.fetch_add(1, Ordering::SeqCst) + 1;
                if (3..=5).contains(&n) {
                    return None;
                }
            }
            default_fixture(r)
        });
        let dir = tempfile::tempdir().unwrap();
        let c = connector(dir.path(), &fixture, Arc::new(|_, _| Ok(answer())));
        assert_eq!(c.inner.poll().unwrap_err().code, "FEISHU_NETWORK");
        assert_eq!(
            c.inner.status().unwrap()["recentMessages"][0]["status"],
            "pending"
        );
        c.inner.poll().unwrap();
        assert_eq!(replies(&fixture), 1);
        assert_eq!(
            c.inner.status().unwrap()["recentMessages"][0]["status"],
            "replied"
        );
    }

    #[test]
    fn a_slow_pending_answer_refreshes_credentials_used_by_later_search_pages() {
        let refreshed = AtomicBool::new(false);
        let fixture = Fixture::new(move |r| {
            if r.target.starts_with("/token/refresh") {
                refreshed.store(true, Ordering::SeqCst);
                let mut result = token();
                result["access_token"] = json!("private-new-user-token");
                return Some(result);
            }
            if refreshed.load(Ordering::SeqCst) {
                assert_eq!(r.authorization, "Bearer private-new-user-token");
            }
            default_fixture(r)
        });
        let dir = tempfile::tempdir().unwrap();
        let holder = Arc::new(Mutex::new(None::<Weak<Inner>>));
        let captured = holder.clone();
        let c = connector(
            dir.path(),
            &fixture,
            Arc::new(move |_, _| {
                let inner = captured
                    .lock()
                    .unwrap()
                    .as_ref()
                    .unwrap()
                    .upgrade()
                    .unwrap();
                lock(&inner.state)
                    .unwrap()
                    .saved
                    .session
                    .as_mut()
                    .unwrap()
                    .expires_at = timestamp() - 1;
                Ok(answer())
            }),
        );
        *holder.lock().unwrap() = Some(Arc::downgrade(&c.inner));
        let s = lock(&c.inner.state).unwrap().saved.clone();
        c.inner
            .discover(
                &s,
                s.session.as_ref().unwrap(),
                "cli_fixture:ou_me",
                &message(),
            )
            .unwrap();
        c.inner.poll().unwrap();
        assert_eq!(replies(&fixture), 1);
        assert!(
            !lock(&c.inner.state)
                .unwrap()
                .saved
                .session
                .as_ref()
                .unwrap()
                .invalid
        );
    }
}
