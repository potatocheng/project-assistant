//! Local derived semantic index backed by `sqlite-vec` (vec0 cosine KNN).
//! Vectors are strictly a recall-expansion cache stored in `<workspace>/semantic-index.sqlite`,
//! never canonical facts and never included in backups. Eligibility (active state, pending
//! conflicts, retention expiry, archive lifecycle, entity/date facets) is always enforced by
//! `memory_query.rs` over canonical `workspace.sqlite` revisions.
use crate::{hash, id, settings, AppError, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Write,
    net::IpAddr,
    path::Path,
    sync::Once,
    time::Duration,
};

const CACHE_FILENAME: &str = "semantic-index.sqlite";
const SETTINGS_FILENAME: &str = "embedding-settings.json";
const MAX_BATCH_SIZE: usize = 16;
const MAX_SYNC_PER_QUERY: usize = 64;
const MAX_EMBED_CHARS: usize = 3_000;
const MIN_DIM: usize = 8;
const MAX_DIM: usize = 8_192;

pub(crate) fn ensure_sqlite_vec_registered() {
    static INIT: Once = Once::new();
    INIT.call_once(|| unsafe {
        type AutoExt = unsafe extern "C" fn(
            *mut rusqlite::ffi::sqlite3,
            *mut *mut std::ffi::c_char,
            *const rusqlite::ffi::sqlite3_api_routines,
        ) -> std::ffi::c_int;
        let init_fn: AutoExt =
            std::mem::transmute::<*const (), AutoExt>(sqlite_vec::sqlite3_vec_init as *const ());
        rusqlite::ffi::sqlite3_auto_extension(Some(init_fn));
    });
}

pub(crate) fn sqlite_vec_version() -> Result<String> {
    ensure_sqlite_vec_registered();
    let conn = Connection::open_in_memory()?;
    let version: String = conn.query_row("SELECT vec_version()", [], |r| r.get(0))?;
    Ok(version)
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EmbeddingSettings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_provider")]
    pub provider: String,
    #[serde(default = "default_base_url")]
    pub base_url: String,
    #[serde(default = "default_model")]
    pub model: String,
    #[serde(default = "default_timeout")]
    pub timeout_seconds: u64,
    #[serde(default)]
    pub remote_consent: bool,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default = "default_revision")]
    pub revision: String,
}

fn default_provider() -> String {
    "ollama".into()
}
fn default_base_url() -> String {
    "http://127.0.0.1:11434".into()
}
fn default_model() -> String {
    "bge-m3".into()
}
fn default_timeout() -> u64 {
    15
}
fn default_revision() -> String {
    "unconfigured".into()
}

impl Default for EmbeddingSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            provider: default_provider(),
            base_url: default_base_url(),
            model: default_model(),
            timeout_seconds: default_timeout(),
            remote_consent: false,
            api_key: None,
            revision: default_revision(),
        }
    }
}

impl EmbeddingSettings {
    pub(crate) fn is_remote(&self) -> bool {
        let Ok(url) = reqwest::Url::parse(&self.base_url) else {
            return true;
        };
        let host = url.host_str().unwrap_or("").trim_matches(['[', ']']);
        host != "localhost"
            && !host
                .parse::<IpAddr>()
                .is_ok_and(|address| address.is_loopback())
    }

    pub(crate) fn validate(&self, inherited_key: Option<&str>) -> Result<()> {
        if !matches!(self.provider.as_str(), "ollama" | "openai_compatible") {
            return Err(AppError::new(
                "EMBEDDING_CONFIG",
                "向量服务仅支持本机 Ollama 或 OpenAI 兼容接口",
            ));
        }
        let url = reqwest::Url::parse(&self.base_url)
            .map_err(|_| AppError::new("EMBEDDING_CONFIG", "向量服务地址无效"))?;
        if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
            return Err(AppError::new("EMBEDDING_CONFIG", "向量服务地址无效"));
        }
        if self.provider == "ollama" && self.is_remote() {
            return Err(AppError::new(
                "EMBEDDING_CONFIG",
                "Ollama 向量服务仅允许本机地址（127.0.0.1 / localhost）",
            ));
        }
        if self.model.trim().is_empty() || self.model.chars().count() > 200 {
            return Err(AppError::new("EMBEDDING_CONFIG", "向量模型名称无效"));
        }
        if !(2..=120).contains(&self.timeout_seconds) {
            return Err(AppError::new(
                "EMBEDDING_CONFIG",
                "向量请求超时需在 2 到 120 秒之间",
            ));
        }
        if self.enabled {
            if self.is_remote() && !self.remote_consent {
                return Err(AppError::new(
                    "REMOTE_CONSENT_REQUIRED",
                    "请先确认允许将记忆正文发送到已设置的远程向量服务",
                ));
            }
            if self.provider == "openai_compatible"
                && self.is_remote()
                && self.effective_api_key(inherited_key).is_none()
            {
                return Err(AppError::new(
                    "EMBEDDING_CONFIG",
                    "远程向量服务需要 API Key",
                ));
            }
        }
        Ok(())
    }

    pub(crate) fn effective_api_key<'a>(&'a self, inherited: Option<&'a str>) -> Option<&'a str> {
        self.api_key
            .as_deref()
            .filter(|k| !k.trim().is_empty())
            .or_else(|| inherited.filter(|k| !k.trim().is_empty()))
    }

    pub(crate) fn public(&self, inherited_key: Option<&str>) -> Value {
        json!({
            "enabled": self.enabled,
            "provider": self.provider,
            "baseUrl": self.base_url,
            "model": self.model,
            "timeoutSeconds": self.timeout_seconds,
            "remoteConsent": self.remote_consent,
            "hasApiKey": self.api_key.as_ref().is_some_and(|k| !k.is_empty()),
            "usingSharedAiKey": self.api_key.as_ref().is_none_or(|k| k.is_empty()) && inherited_key.is_some(),
            "isRemote": self.is_remote(),
            "configured": self.enabled && self.validate(inherited_key).is_ok(),
        })
    }

    fn profile_key(&self, dimensions: usize) -> String {
        format!(
            "{}|{}|{}|{}",
            self.provider,
            self.base_url.trim_end_matches('/'),
            self.model.trim(),
            dimensions
        )
    }
}

fn inherited_ai_key(root: &Path, config: &EmbeddingSettings) -> Option<String> {
    if config.provider != "openai_compatible" {
        return None;
    }
    let ai = settings::load(root).ok()?;
    if ai.provider == "openai_compatible"
        && ai.base_url.trim_end_matches('/') == config.base_url.trim_end_matches('/')
    {
        ai.api_key
    } else {
        None
    }
}

pub(crate) fn load_settings(root: &Path) -> Result<EmbeddingSettings> {
    let directory = settings::private_directory(root)?;
    let path = directory.join(SETTINGS_FILENAME);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(EmbeddingSettings::default())
        }
        Err(error) => return Err(error.into()),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 64 * 1024 {
        return Err(AppError::new("SECRET_CONFIG", "向量配置文件无效"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
    }
    serde_json::from_slice(&crate::protection::decode_secret(root, &fs::read(path)?)?)
        .map_err(|_| AppError::new("SECRET_CONFIG", "向量配置无法读取，请重新配置"))
}

pub(crate) fn save_settings(root: &Path, p: &Value) -> Result<Value> {
    let _guard = crate::protection::guard()?;
    let old = load_settings(root)?;
    let enabled = p["enabled"].as_bool().unwrap_or(old.enabled);
    let provider = p["provider"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&old.provider)
        .to_owned();
    let raw_url = p["baseUrl"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&old.base_url);
    let url = reqwest::Url::parse(raw_url)
        .map_err(|_| AppError::new("EMBEDDING_CONFIG", "向量服务地址无效"))?;
    let base_url = url.as_str().trim_end_matches('/').to_owned();
    let model = p["model"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&old.model)
        .to_owned();
    let timeout_seconds = p["timeoutSeconds"].as_u64().unwrap_or(old.timeout_seconds);
    let remote_consent = p["remoteConsent"].as_bool().unwrap_or(old.remote_consent);
    let api_key = match p.get("apiKey") {
        Some(Value::String(key)) => {
            if key.len() > 16 * 1024 || key.contains(['\r', '\n']) {
                return Err(AppError::new("EMBEDDING_CONFIG", "向量 API Key 格式无效"));
            }
            let key = key.trim();
            if key.is_empty() {
                None
            } else {
                Some(key.to_owned())
            }
        }
        None if provider == old.provider && base_url == old.base_url => old.api_key.clone(),
        None => None,
        _ => {
            return Err(AppError::new(
                "EMBEDDING_CONFIG",
                "向量 API Key 必须是字符串",
            ))
        }
    };
    let mut next = EmbeddingSettings {
        enabled,
        provider,
        base_url,
        model,
        timeout_seconds,
        remote_consent,
        api_key,
        revision: old.revision.clone(),
    };
    let inherited = inherited_ai_key(root, &next);
    next.validate(inherited.as_deref())?;
    let changed = serde_json::to_vec(&old).ok() != serde_json::to_vec(&next).ok();
    if changed {
        next.revision = id();
        let directory = settings::private_directory(root)?;
        let temporary = directory.join(format!(".{}.tmp", id()));
        let mut options = fs::OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        let bytes = serde_json::to_vec(&next)
            .map_err(|_| AppError::new("SECRET_CONFIG", "向量配置保存失败"))?;
        let bytes = crate::protection::encode_secret(root, &bytes)?;
        if let Err(error) = file.write_all(&bytes).and_then(|_| file.sync_all()) {
            let _ = fs::remove_file(&temporary);
            return Err(error.into());
        }
        fs::rename(&temporary, directory.join(SETTINGS_FILENAME))?;
        crate::sync_directory(&directory)?;
    }
    status(root, None)
}

pub(crate) fn clear_workspace_cache(root: &Path) {
    for suffix in ["", "-wal", "-shm"] {
        let path = root.join(format!("{CACHE_FILENAME}{suffix}"));
        if path.exists() {
            let _ = fs::remove_file(path);
        }
    }
}

fn f32_to_bytes(vector: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(vector.len() * 4);
    for &value in vector {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    bytes
}

fn validate_vector(vector: &[f32], expected_dim: Option<usize>) -> Result<usize> {
    let dim = vector.len();
    if !(MIN_DIM..=MAX_DIM).contains(&dim) || !vector.iter().all(|v| v.is_finite()) {
        return Err(AppError::new(
            "EMBEDDING_OUTPUT",
            "模型返回的向量维度或数值无效",
        ));
    }
    if let Some(expected) = expected_dim {
        if dim != expected {
            return Err(AppError::new("EMBEDDING_OUTPUT", "批次内向量维度不一致"));
        }
    }
    Ok(dim)
}

pub(crate) struct VectorIndex {
    conn: Connection,
}

impl VectorIndex {
    pub(crate) fn open(root: &Path) -> Result<Self> {
        ensure_sqlite_vec_registered();
        let conn = Connection::open(root.join(CACHE_FILENAME))?;
        conn.busy_timeout(Duration::from_secs(5))?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")?;
        Self::init(conn)
    }

    #[cfg(test)]
    pub(crate) fn open_in_memory() -> Result<Self> {
        ensure_sqlite_vec_registered();
        let conn = Connection::open_in_memory()?;
        Self::init(conn)
    }

    fn init(conn: Connection) -> Result<Self> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS vec_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS memory_vec_map(
                 rowid INTEGER PRIMARY KEY,
                 memory_id TEXT NOT NULL UNIQUE,
                 revision_id TEXT NOT NULL,
                 project_id TEXT NOT NULL,
                 content_hash TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS memory_vec_map_project ON memory_vec_map(project_id);",
        )?;
        Ok(Self { conn })
    }

    fn meta(&self, key: &str) -> Result<Option<String>> {
        Ok(self
            .conn
            .query_row("SELECT value FROM vec_meta WHERE key=?", [key], |r| {
                r.get(0)
            })
            .optional()?)
    }

    fn has_vec_table(&self) -> Result<bool> {
        Ok(self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_vec')",
            [],
            |r| r.get(0),
        )?)
    }

    pub(crate) fn stats(&self) -> Result<Value> {
        let indexed: i64 = self
            .conn
            .query_row("SELECT count(*) FROM memory_vec_map", [], |r| r.get(0))?;
        let dimensions = self
            .meta("dimensions")?
            .and_then(|v| v.parse::<usize>().ok());
        let profile = self.meta("profile_key")?;
        let vec_ready = self.has_vec_table()?;
        Ok(json!({
            "indexedCount": indexed,
            "dimensions": dimensions,
            "profileKey": profile,
            "vecTableReady": vec_ready,
        }))
    }

    pub(crate) fn ensure_profile(&mut self, profile_key: &str, dimensions: usize) -> Result<bool> {
        if !(MIN_DIM..=MAX_DIM).contains(&dimensions) {
            return Err(AppError::new("EMBEDDING_OUTPUT", "向量维度超出支持范围"));
        }
        let current_profile = self.meta("profile_key")?;
        let current_dim = self
            .meta("dimensions")?
            .and_then(|v| v.parse::<usize>().ok());
        if current_profile.as_deref() == Some(profile_key)
            && current_dim == Some(dimensions)
            && self.has_vec_table()?
        {
            return Ok(false);
        }
        let tx = self.conn.transaction()?;
        tx.execute_batch(
            "DROP TABLE IF EXISTS memory_vec;
             DELETE FROM memory_vec_map;
             DELETE FROM vec_meta;",
        )?;
        tx.execute_batch(&format!(
            "CREATE VIRTUAL TABLE memory_vec USING vec0(embedding float[{dimensions}] distance_metric=cosine);"
        ))?;
        tx.execute(
            "INSERT INTO vec_meta(key,value) VALUES('profile_key',?1),('dimensions',?2)",
            params![profile_key, dimensions.to_string()],
        )?;
        tx.commit()?;
        Ok(true)
    }

    pub(crate) fn existing_map(&self) -> Result<HashMap<String, (String, String)>> {
        let mut stmt = self
            .conn
            .prepare("SELECT memory_id, revision_id, content_hash FROM memory_vec_map")?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    (r.get::<_, String>(1)?, r.get::<_, String>(2)?),
                ))
            })?
            .collect::<std::result::Result<HashMap<_, _>, _>>()?;
        Ok(rows)
    }

    pub(crate) fn prune_missing(&mut self, active: &HashSet<(String, String)>) -> Result<usize> {
        if !self.has_vec_table()? {
            return Ok(0);
        }
        let mut stmt = self
            .conn
            .prepare("SELECT rowid, memory_id, revision_id FROM memory_vec_map")?;
        let stale: Vec<i64> = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })?
            .filter_map(|row| row.ok())
            .filter(|(_, memory_id, revision_id)| {
                !active.contains(&(memory_id.clone(), revision_id.clone()))
            })
            .map(|(rowid, _, _)| rowid)
            .collect();
        drop(stmt);
        if stale.is_empty() {
            return Ok(0);
        }
        let tx = self.conn.transaction()?;
        for rowid in &stale {
            tx.execute("DELETE FROM memory_vec WHERE rowid=?", [rowid])?;
            tx.execute("DELETE FROM memory_vec_map WHERE rowid=?", [rowid])?;
        }
        tx.commit()?;
        Ok(stale.len())
    }

    pub(crate) fn upsert_batch(
        &mut self,
        items: &[(String, String, String, String, Vec<f32>)],
    ) -> Result<()> {
        if items.is_empty() {
            return Ok(());
        }
        let tx = self.conn.transaction()?;
        for (memory_id, revision_id, project_id, content_hash, embedding) in items {
            let old_rowid: Option<i64> = tx
                .query_row(
                    "SELECT rowid FROM memory_vec_map WHERE memory_id=?",
                    [memory_id],
                    |r| r.get(0),
                )
                .optional()?;
            if let Some(old) = old_rowid {
                tx.execute("DELETE FROM memory_vec WHERE rowid=?", [old])?;
                tx.execute("DELETE FROM memory_vec_map WHERE rowid=?", [old])?;
            }
            tx.execute(
                "INSERT INTO memory_vec_map(memory_id,revision_id,project_id,content_hash) VALUES(?,?,?,?)",
                params![memory_id, revision_id, project_id, content_hash],
            )?;
            let rowid = tx.last_insert_rowid();
            let bytes = f32_to_bytes(embedding);
            tx.execute(
                "INSERT INTO memory_vec(rowid,embedding) VALUES(?1,?2)",
                params![rowid, bytes],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub(crate) fn search(&self, query_embedding: &[f32], k: usize) -> Result<Vec<(String, f64)>> {
        if k == 0 || !self.has_vec_table()? {
            return Ok(Vec::new());
        }
        let count: i64 = self
            .conn
            .query_row("SELECT count(*) FROM memory_vec_map", [], |r| r.get(0))?;
        if count == 0 {
            return Ok(Vec::new());
        }
        let effective_k = (k as i64).min(count).max(1);
        let bytes = f32_to_bytes(query_embedding);
        let mut stmt = self.conn.prepare(
            "SELECT m.memory_id, v.distance
             FROM memory_vec v
             JOIN memory_vec_map m ON m.rowid = v.rowid
             WHERE v.embedding MATCH ?1 AND k = ?2
             ORDER BY v.distance ASC",
        )?;
        let rows = stmt
            .query_map(params![bytes, effective_k], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }
}

fn openai_embeddings_url(base_url: &str) -> Result<reqwest::Url> {
    let mut url = reqwest::Url::parse(base_url)
        .map_err(|_| AppError::new("EMBEDDING_CONFIG", "向量服务地址无效"))?;
    let trimmed = url.path().trim_end_matches('/');
    let path = if trimmed.ends_with("/embeddings") {
        trimmed.to_owned()
    } else if trimmed.is_empty() {
        "/v1/embeddings".to_owned()
    } else {
        format!("{trimmed}/embeddings")
    };
    url.set_path(&path);
    Ok(url)
}

fn build_http_client(timeout_seconds: u64) -> Result<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(timeout_seconds.min(10)))
        .timeout(Duration::from_secs(timeout_seconds))
        .build()
        .map_err(|_| AppError::new("EMBEDDING_NETWORK", "无法初始化向量 HTTP 客户端"))
}

pub(crate) fn embed_texts(
    config: &EmbeddingSettings,
    api_key: Option<&str>,
    texts: &[String],
) -> Result<Vec<Vec<f32>>> {
    if texts.is_empty() {
        return Ok(Vec::new());
    }
    config.validate(api_key)?;
    let clipped: Vec<String> = texts
        .iter()
        .map(|t| t.chars().take(MAX_EMBED_CHARS).collect())
        .collect();
    let client = build_http_client(config.timeout_seconds)?;

    if config.provider == "ollama" {
        let base = config.base_url.trim_end_matches('/');
        let embed_url = format!("{base}/api/embed");
        let resp = client
            .post(&embed_url)
            .json(&json!({"model": config.model, "input": clipped}))
            .send()
            .map_err(|_| AppError::new("EMBEDDING_NETWORK", "无法连接本机 Ollama 向量接口"))?;
        if resp.status().as_u16() == 404 {
            // Fallback for older Ollama versions exposing only /api/embeddings
            let legacy_url = format!("{base}/api/embeddings");
            let mut vectors = Vec::with_capacity(clipped.len());
            let mut expected_dim = None;
            for prompt in &clipped {
                let legacy = client
                    .post(&legacy_url)
                    .json(&json!({"model": config.model, "prompt": prompt}))
                    .send()
                    .map_err(|_| {
                        AppError::new("EMBEDDING_NETWORK", "无法连接本机 Ollama 向量接口")
                    })?;
                if !legacy.status().is_success() {
                    return Err(AppError::new(
                        "EMBEDDING_HTTP",
                        format!("Ollama 向量接口返回错误状态 {}", legacy.status().as_u16()),
                    ));
                }
                let body: Value = legacy
                    .json()
                    .map_err(|_| AppError::new("EMBEDDING_OUTPUT", "Ollama 向量响应格式无效"))?;
                let vec: Vec<f32> = serde_json::from_value(body["embedding"].clone())
                    .map_err(|_| AppError::new("EMBEDDING_OUTPUT", "Ollama 响应缺少向量字段"))?;
                let dim = validate_vector(&vec, expected_dim)?;
                expected_dim = Some(dim);
                vectors.push(vec);
            }
            return Ok(vectors);
        }
        if !resp.status().is_success() {
            return Err(AppError::new(
                "EMBEDDING_HTTP",
                format!("Ollama 向量接口返回错误状态 {}", resp.status().as_u16()),
            ));
        }
        let body: Value = resp
            .json()
            .map_err(|_| AppError::new("EMBEDDING_OUTPUT", "Ollama 向量响应格式无效"))?;
        let raw_list = body["embeddings"]
            .as_array()
            .ok_or_else(|| AppError::new("EMBEDDING_OUTPUT", "Ollama 响应缺少 embeddings 数组"))?;
        if raw_list.len() != clipped.len() {
            return Err(AppError::new(
                "EMBEDDING_OUTPUT",
                "Ollama 返回的向量条数与输入不匹配",
            ));
        }
        let mut vectors = Vec::with_capacity(raw_list.len());
        let mut expected_dim = None;
        for entry in raw_list {
            let vec: Vec<f32> = serde_json::from_value(entry.clone())
                .map_err(|_| AppError::new("EMBEDDING_OUTPUT", "向量数值格式无效"))?;
            let dim = validate_vector(&vec, expected_dim)?;
            expected_dim = Some(dim);
            vectors.push(vec);
        }
        return Ok(vectors);
    }

    let url = openai_embeddings_url(&config.base_url)?;
    let mut request = client
        .post(url)
        .json(&json!({"model": config.model, "input": clipped}));
    if let Some(key) = config.effective_api_key(api_key) {
        request = request.bearer_auth(key);
    }
    let resp = request
        .send()
        .map_err(|_| AppError::new("EMBEDDING_NETWORK", "无法连接向量模型服务"))?;
    if !resp.status().is_success() {
        return Err(AppError::new(
            "EMBEDDING_HTTP",
            format!("向量模型服务返回错误状态 {}", resp.status().as_u16()),
        ));
    }
    let body: Value = resp
        .json()
        .map_err(|_| AppError::new("EMBEDDING_OUTPUT", "向量响应 JSON 无效"))?;
    let mut entries = body["data"]
        .as_array()
        .ok_or_else(|| AppError::new("EMBEDDING_OUTPUT", "向量响应缺少 data 数组"))?
        .clone();
    entries.sort_by_key(|item| item["index"].as_u64().unwrap_or(0));
    if entries.len() != clipped.len() {
        return Err(AppError::new(
            "EMBEDDING_OUTPUT",
            "向量返回条数与输入不匹配",
        ));
    }
    let mut vectors = Vec::with_capacity(entries.len());
    let mut expected_dim = None;
    for entry in entries {
        let vec: Vec<f32> = serde_json::from_value(entry["embedding"].clone())
            .map_err(|_| AppError::new("EMBEDDING_OUTPUT", "向量数值格式无效"))?;
        let dim = validate_vector(&vec, expected_dim)?;
        expected_dim = Some(dim);
        vectors.push(vec);
    }
    Ok(vectors)
}

pub(crate) fn test_connection(root: &Path) -> Result<Value> {
    let mut config = load_settings(root)?;
    let inherited = inherited_ai_key(root, &config);
    config.enabled = true;
    config.validate(inherited.as_deref())?;
    let probe = vec!["项目记忆本地混合语义检索连接测试".to_owned()];
    let vectors = embed_texts(&config, inherited.as_deref(), &probe)?;
    let dim = vectors.first().map_or(0, Vec::len);
    let vec_version = sqlite_vec_version()?;
    Ok(json!({
        "ok": true,
        "provider": config.provider,
        "model": config.model,
        "dimensions": dim,
        "sqliteVecVersion": vec_version,
        "message": format!("连接成功，向量维度 {dim}，sqlite-vec {vec_version} 就绪。"),
    }))
}

#[derive(Clone, Debug)]
pub(crate) struct ActiveMemoryInput {
    pub memory_id: String,
    pub revision_id: String,
    pub project_id: String,
    pub content: String,
}

impl ActiveMemoryInput {
    pub(crate) fn from_values(rows: &[Value]) -> Vec<Self> {
        rows.iter()
            .filter_map(|row| {
                Some(Self {
                    memory_id: row["memoryId"].as_str()?.to_owned(),
                    revision_id: row["revisionId"].as_str()?.to_owned(),
                    project_id: row["projectId"].as_str()?.to_owned(),
                    content: row["content"].as_str()?.to_owned(),
                })
            })
            .collect()
    }
}

pub(crate) fn rebuild_index(root: &Path, memories: &[ActiveMemoryInput]) -> Result<Value> {
    let config = load_settings(root)?;
    let inherited = inherited_ai_key(root, &config);
    if !config.enabled {
        return Err(AppError::new(
            "EMBEDDING_DISABLED",
            "尚未开启本地混合语义检索，请先在模型设置中启用并保存",
        ));
    }
    config.validate(inherited.as_deref())?;
    let mut index = VectorIndex::open(root)?;
    let active_set: HashSet<(String, String)> = memories
        .iter()
        .map(|m| (m.memory_id.clone(), m.revision_id.clone()))
        .collect();
    let pruned = index.prune_missing(&active_set)?;
    if memories.is_empty() {
        return Ok(json!({
            "indexed": 0,
            "skipped": 0,
            "pruned": pruned,
            "dimensions": index.meta("dimensions")?.and_then(|v| v.parse::<usize>().ok()),
            "sqliteVecVersion": sqlite_vec_version()?,
        }));
    }

    let mut embedded = 0usize;
    let mut skipped = 0usize;
    let mut dim_seen: Option<usize> = index
        .meta("dimensions")?
        .and_then(|v| v.parse::<usize>().ok());
    let mut existing = index.existing_map()?;
    let expected_prefix = format!(
        "{}|{}|{}|",
        config.provider,
        config.base_url.trim_end_matches('/'),
        config.model.trim()
    );
    let profile_matches = index
        .meta("profile_key")?
        .is_some_and(|k| k.starts_with(&expected_prefix))
        && index.has_vec_table()?;
    if !profile_matches {
        existing.clear();
        dim_seen = None;
    }

    let mut pending = Vec::new();
    for m in memories {
        let content_hash = hash(m.content.as_bytes());
        if existing
            .get(&m.memory_id)
            .is_some_and(|(rev, h)| rev == &m.revision_id && h == &content_hash)
        {
            skipped += 1;
        } else {
            pending.push((m, content_hash));
        }
    }

    for chunk in pending.chunks(MAX_BATCH_SIZE) {
        let texts: Vec<String> = chunk.iter().map(|(m, _)| m.content.clone()).collect();
        let vectors = embed_texts(&config, inherited.as_deref(), &texts)?;
        let Some(first) = vectors.first() else {
            continue;
        };
        let dim = first.len();
        let profile_key = config.profile_key(dim);
        index.ensure_profile(&profile_key, dim)?;
        dim_seen = Some(dim);
        let batch: Vec<_> = chunk
            .iter()
            .zip(vectors)
            .map(|((m, content_hash), vec)| {
                (
                    m.memory_id.clone(),
                    m.revision_id.clone(),
                    m.project_id.clone(),
                    content_hash.clone(),
                    vec,
                )
            })
            .collect();
        embedded += batch.len();
        index.upsert_batch(&batch)?;
    }

    Ok(json!({
        "indexed": embedded,
        "skipped": skipped,
        "pruned": pruned,
        "totalActive": memories.len(),
        "dimensions": dim_seen,
        "sqliteVecVersion": sqlite_vec_version()?,
    }))
}

pub(crate) struct SemanticQueryOutcome {
    pub hits: Vec<(String, f64)>,
    pub trace: Value,
}

/// Synchronizes missing active revisions (bounded per query) and executes cosine KNN in `sqlite-vec`.
/// Never fails a user query: if disabled or the embedding service is unreachable, gracefully falls
/// back to lexical retrieval and records `fallbackReason` in the trace.
pub(crate) fn query_hits(
    root: &Path,
    question: &str,
    memories: &[ActiveMemoryInput],
    top_k: usize,
) -> SemanticQueryOutcome {
    let config = match load_settings(root) {
        Ok(c) => c,
        Err(error) => {
            return SemanticQueryOutcome {
                hits: Vec::new(),
                trace: json!({
                    "enabled": false,
                    "backend": "sqlite-vec",
                    "fallbackReason": error.message,
                }),
            }
        }
    };
    if !config.enabled || question.trim().is_empty() || memories.is_empty() {
        return SemanticQueryOutcome {
            hits: Vec::new(),
            trace: json!({
                "enabled": config.enabled,
                "backend": "sqlite-vec",
                "provider": config.provider,
                "model": config.model,
                "vecHits": 0,
                "fusion": if config.enabled { "rrf" } else { "lexical_only" },
            }),
        };
    }
    let inherited = inherited_ai_key(root, &config);
    if let Err(error) = config.validate(inherited.as_deref()) {
        return SemanticQueryOutcome {
            hits: Vec::new(),
            trace: json!({
                "enabled": true,
                "backend": "sqlite-vec",
                "provider": config.provider,
                "model": config.model,
                "vecHits": 0,
                "fusion": "lexical_fallback",
                "fallbackReason": error.message,
            }),
        };
    }

    match query_hits_inner(
        root,
        &config,
        inherited.as_deref(),
        question,
        memories,
        top_k,
    ) {
        Ok(outcome) => outcome,
        Err(error) => SemanticQueryOutcome {
            hits: Vec::new(),
            trace: json!({
                "enabled": true,
                "backend": "sqlite-vec",
                "provider": config.provider,
                "model": config.model,
                "vecHits": 0,
                "fusion": "lexical_fallback",
                "fallbackReason": error.message,
            }),
        },
    }
}

fn query_hits_inner(
    root: &Path,
    config: &EmbeddingSettings,
    inherited_key: Option<&str>,
    question: &str,
    memories: &[ActiveMemoryInput],
    top_k: usize,
) -> Result<SemanticQueryOutcome> {
    let mut index = VectorIndex::open(root)?;
    let query_vectors = embed_texts(config, inherited_key, &[question.to_owned()])?;
    let query_vec = query_vectors
        .into_iter()
        .next()
        .ok_or_else(|| AppError::new("EMBEDDING_OUTPUT", "查询向量为空"))?;
    let dim = query_vec.len();
    let profile_key = config.profile_key(dim);
    index.ensure_profile(&profile_key, dim)?;

    let active_set: HashSet<(String, String)> = memories
        .iter()
        .map(|m| (m.memory_id.clone(), m.revision_id.clone()))
        .collect();
    let _ = index.prune_missing(&active_set)?;
    let existing = index.existing_map()?;

    let mut missing = Vec::new();
    for m in memories {
        let content_hash = hash(m.content.as_bytes());
        if !existing
            .get(&m.memory_id)
            .is_some_and(|(rev, h)| rev == &m.revision_id && h == &content_hash)
        {
            missing.push((m, content_hash));
            if missing.len() >= MAX_SYNC_PER_QUERY {
                break;
            }
        }
    }
    let mut synced_now = 0usize;
    for chunk in missing.chunks(MAX_BATCH_SIZE) {
        let texts: Vec<String> = chunk.iter().map(|(m, _)| m.content.clone()).collect();
        let vectors = embed_texts(config, inherited_key, &texts)?;
        let batch: Vec<_> = chunk
            .iter()
            .zip(vectors)
            .filter(|(_, vec)| vec.len() == dim)
            .map(|((m, content_hash), vec)| {
                (
                    m.memory_id.clone(),
                    m.revision_id.clone(),
                    m.project_id.clone(),
                    content_hash.clone(),
                    vec,
                )
            })
            .collect();
        synced_now += batch.len();
        index.upsert_batch(&batch)?;
    }

    let hits = index.search(&query_vec, top_k)?;
    Ok(SemanticQueryOutcome {
        trace: json!({
            "enabled": true,
            "backend": "sqlite-vec",
            "provider": config.provider,
            "model": config.model,
            "dimensions": dim,
            "syncedNow": synced_now,
            "vecHits": hits.len(),
            "fusion": "rrf",
        }),
        hits,
    })
}

pub(crate) fn status(root: &Path, active_count: Option<i64>) -> Result<Value> {
    let config = load_settings(root)?;
    let inherited = inherited_ai_key(root, &config);
    let vec_version = sqlite_vec_version().unwrap_or_else(|_| "unavailable".into());
    let stats = if root.join(CACHE_FILENAME).exists() {
        VectorIndex::open(root)
            .and_then(|idx| idx.stats())
            .unwrap_or_else(
                |_| json!({"indexedCount": 0, "dimensions": null, "vecTableReady": false}),
            )
    } else {
        json!({"indexedCount": 0, "dimensions": null, "vecTableReady": false})
    };
    Ok(json!({
        "settings": config.public(inherited.as_deref()),
        "sqliteVecVersion": vec_version,
        "index": stats,
        "activeMemoryCount": active_count,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        thread,
    };

    #[test]
    fn sqlite_vec_cosine_knn_indexes_prunes_and_switches_dimensions_cleanly() {
        let ver = sqlite_vec_version().unwrap();
        assert!(!ver.is_empty());

        let mut idx = VectorIndex::open_in_memory().unwrap();
        idx.ensure_profile("ollama|http://127.0.0.1:11434|bge-m3|8", 8)
            .unwrap();
        idx.upsert_batch(&[
            (
                "m1".into(),
                "r1".into(),
                "p1".into(),
                "h1".into(),
                vec![1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            ),
            (
                "m2".into(),
                "r2".into(),
                "p1".into(),
                "h2".into(),
                vec![0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            ),
            (
                "m3".into(),
                "r3".into(),
                "p1".into(),
                "h3".into(),
                vec![0.9, 0.1, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            ),
        ])
        .unwrap();

        let hits = idx
            .search(&[1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0], 2)
            .unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].0, "m1");
        assert!(hits[0].1 < 0.001);
        assert_eq!(hits[1].0, "m3");

        // Prune removed revision
        let keep: HashSet<_> = [("m3".into(), "r3".into())].into_iter().collect();
        assert_eq!(idx.prune_missing(&keep).unwrap(), 2);
        let after = idx
            .search(&[1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0], 5)
            .unwrap();
        assert_eq!(after.len(), 1);
        assert_eq!(after[0].0, "m3");

        // Switching embedding model dimension recreates vec0 cleanly
        assert!(idx
            .ensure_profile("ollama|http://127.0.0.1:11434|bge-small|16", 16)
            .unwrap());
        assert_eq!(idx.stats().unwrap()["indexedCount"], 0);
        assert_eq!(idx.stats().unwrap()["dimensions"], 16);
    }

    #[test]
    fn loopback_ollama_embedding_syncs_index_and_returns_semantic_hits() {
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        };
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let addr = listener.local_addr().unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = stop.clone();
        let server = thread::spawn(move || {
            while !stopping.load(Ordering::SeqCst) {
                let (mut stream, _) = match listener.accept() {
                    Ok(s) => s,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                    Err(_) => break,
                };
                stream.set_nonblocking(false).unwrap();
                let mut buf = Vec::new();
                let mut tmp = [0u8; 4096];
                let end = loop {
                    let n = stream.read(&mut tmp).unwrap();
                    if n == 0 {
                        break buf.len();
                    }
                    buf.extend_from_slice(&tmp[..n]);
                    if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        break pos + 4;
                    }
                };
                let headers = String::from_utf8_lossy(&buf[..end]);
                let content_len = headers
                    .lines()
                    .filter_map(|l| l.split_once(':'))
                    .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
                    .and_then(|(_, v)| v.trim().parse::<usize>().ok())
                    .unwrap_or(0);
                while buf.len() < end + content_len {
                    let n = stream.read(&mut tmp).unwrap();
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&tmp[..n]);
                }
                let body: Value = serde_json::from_slice(&buf[end..end + content_len]).unwrap();
                let inputs = body["input"].as_array().unwrap();
                let embeddings: Vec<Vec<f32>> = inputs
                    .iter()
                    .map(|v| {
                        let s = v.as_str().unwrap_or("");
                        if s.contains("推迟") || s.contains("延期") || s.contains("后移") {
                            vec![1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]
                        } else {
                            vec![0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]
                        }
                    })
                    .collect();
                let resp = json!({"embeddings": embeddings}).to_string();
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    resp.len(),
                    resp
                )
                .unwrap();
            }
        });

        let dir = tempfile::tempdir().unwrap();
        save_settings(
            dir.path(),
            &json!({
                "enabled": true,
                "provider": "ollama",
                "baseUrl": format!("http://{addr}"),
                "model": "bge-m3",
                "timeoutSeconds": 10,
                "remoteConsent": false
            }),
        )
        .unwrap();

        let memories = vec![
            ActiveMemoryInput {
                memory_id: "m-delay".into(),
                revision_id: "r1".into(),
                project_id: "p1".into(),
                content: "支付网关上线日期已推迟到下周三。".into(),
            },
            ActiveMemoryInput {
                memory_id: "m-other".into(),
                revision_id: "r2".into(),
                project_id: "p1".into(),
                content: "办公区会议室预订规则更新。".into(),
            },
        ];
        // Query uses a completely different Chinese phrasing ("延期") with zero lexical overlap!
        let outcome = query_hits(dir.path(), "发版会不会延期？", &memories, 5);
        assert_eq!(outcome.trace["fusion"], "rrf");
        assert_eq!(outcome.hits[0].0, "m-delay");
        assert!(outcome.hits[0].1 < 0.01);

        stop.store(true, Ordering::SeqCst);
        let _ = server.join();
    }
}
