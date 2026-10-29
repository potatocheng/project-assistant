use crate::{
    db::{Database, SCHEMA_VERSION},
    hash, id, now, required, AppError, Result,
};
use base64::Engine as _;
use rusqlite::{backup::Backup, params, Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs,
    io::{Cursor, Read, Write},
    path::{Component, Path, PathBuf},
    time::Duration,
};
use zip::write::SimpleFileOptions;

const MAX_ARCHIVE: u64 = 256 * 1024 * 1024;
const MAX_EXPANDED: u64 = 512 * 1024 * 1024;
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    format_version: u32,
    schema_version: i64,
    created_at: String,
    counts: Value,
    files: Vec<Entry>,
}
#[derive(Serialize, Deserialize)]
struct Entry {
    path: String,
    sha256: String,
    size: u64,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RestoreJournal {
    format_version: u32,
    safety_backup: Value,
}
struct Stage(PathBuf);
impl Stage {
    fn new(root: &Path) -> Result<Self> {
        let path = root.join("staging").join(id());
        fs::create_dir_all(&path)?;
        Ok(Self(path))
    }
}
impl Drop for Stage {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub(crate) fn create(db: &mut Database) -> Result<Value> {
    let stage = Stage::new(&db.root)?;
    let snapshot = stage.0.join("workspace.sqlite");
    let mut target = Connection::open(&snapshot)?;
    Backup::new(&db.conn, &mut target)?.run_to_completion(128, Duration::from_millis(5), None)?;
    // Derived search caches are rebuilt from canonical revisions. Compact the
    // private snapshot so cached terms do not inflate archives or survive in
    // free pages; the live index remains available to queries.
    target
        .execute_batch("DELETE FROM memory_lexical; DELETE FROM memory_lexical_state; VACUUM;")?;
    drop(target);
    let mut paths = vec![("workspace.sqlite".to_owned(), snapshot)];
    let mut stmt = db
        .conn
        .prepare("SELECT original_path FROM sources ORDER BY id")?;
    let originals = stmt
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    for relative in originals {
        validate_path(&relative)?;
        paths.push((relative.clone(), db.root.join(relative)));
    }
    let (created, backup_id) = (now(), id());
    let filename = format!("project-assistant-{}.zip", backup_id);
    let archive_path = stage.0.join(&filename);
    let file = fs::File::create(&archive_path)?;
    let mut zip = zip::ZipWriter::new(file);
    let options = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o600);
    let mut entries = Vec::new();
    let mut total = 0u64;
    for (relative, path) in paths {
        let bytes = fs::read(&path)
            .map_err(|e| AppError::new("BACKUP_SOURCE", format!("备份无法读取 {relative}：{e}")))?;
        if bytes.len() > 128 * 1024 * 1024 {
            return Err(AppError::new(
                "BACKUP_LIMIT",
                "单个备份条目超过当前容量限制",
            ));
        }
        total += bytes.len() as u64;
        if total > MAX_EXPANDED {
            return Err(AppError::new("BACKUP_LIMIT", "工作区超过当前备份容量限制"));
        }
        entries.push(Entry {
            path: relative.clone(),
            sha256: hash(&bytes),
            size: bytes.len() as u64,
        });
        zip.start_file(relative, options)?;
        zip.write_all(&bytes)?;
    }
    let counts = db.counts()?;
    let manifest = Manifest {
        format_version: 1,
        schema_version: SCHEMA_VERSION,
        created_at: created.clone(),
        counts: counts.clone(),
        files: entries,
    };
    zip.start_file("manifest.json", options)?;
    zip.write_all(
        &serde_json::to_vec_pretty(&manifest)
            .map_err(|e| AppError::new("SERIALIZATION", e.to_string()))?,
    )?;
    zip.finish()?.sync_all()?;
    let bytes = fs::read(&archive_path)?;
    if bytes.len() as u64 > MAX_ARCHIVE {
        return Err(AppError::new(
            "BACKUP_LIMIT",
            "备份压缩后超过 256 MiB，请缩减资料后重试",
        ));
    }
    let record = json!({"id":backup_id,"filename":filename,"createdAt":created,"byteSize":bytes.len(),"sha256":hash(&bytes),"counts":counts});
    fs::rename(archive_path, db.root.join("backups").join(&filename))?;
    crate::sync_directory(&db.root.join("backups"))?;
    insert_record(&db.conn, &record)?;
    Ok(record)
}

fn insert_record(conn: &Connection, r: &Value) -> Result<()> {
    let filename = required(r, "filename")?;
    if !safe_filename(filename) {
        return Err(AppError::new("INVALID_BACKUP", "备份注册文件名不安全"));
    }
    let size = r["byteSize"]
        .as_i64()
        .filter(|size| *size >= 0)
        .ok_or_else(|| AppError::new("INVALID_BACKUP", "备份长度无效"))?;
    conn.execute("INSERT OR REPLACE INTO backups (id,filename,created_at,byte_size,sha256,counts) VALUES (?,?,?,?,?,?)",params![required(r,"id")?,filename,required(r,"createdAt")?,size,required(r,"sha256")?,r["counts"].to_string()])?;
    Ok(())
}
pub(crate) fn safe_filename(filename: &str) -> bool {
    !filename.contains('\\')
        && !filename.contains('/')
        && filename.ends_with(".zip")
        && Path::new(filename).components().count() == 1
        && !filename.starts_with('.')
}

struct Validated {
    stage: Stage,
    manifest: Manifest,
    conn: Connection,
}
fn decode(p: &Value) -> Result<Vec<u8>> {
    let filename = required(p, "filename")?;
    if !filename.to_ascii_lowercase().ends_with(".zip")
        && !filename.to_ascii_lowercase().ends_with(".pabackup")
    {
        return Err(AppError::new("INVALID_BACKUP", "请选择 ZIP 或加密备份"));
    }
    let encoded = required(p, "contentBase64")?;
    if encoded.len() as u64 > MAX_ARCHIVE * 4 / 3 + 4 {
        return Err(AppError::new("BACKUP_LIMIT", "备份文件过大"));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| AppError::new("INVALID_BACKUP", "备份文件编码无效"))?;
    if filename.ends_with(".pabackup") {
        crate::protection::decrypt_backup(&bytes, required(p, "password")?)
    } else {
        Ok(bytes)
    }
}
fn validate_path(path: &str) -> Result<()> {
    let safe = !path.contains('\\')
        && Path::new(path)
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
        && (path == "workspace.sqlite"
            || (path.starts_with("originals/") && path.split('/').count() == 2));
    if !safe {
        return Err(AppError::new(
            "UNSAFE_ARCHIVE",
            "备份中包含不安全的文件路径",
        ));
    }
    Ok(())
}
fn validate(root: &Path, p: &Value) -> Result<Validated> {
    let bytes = decode(p)?;
    let stage = Stage::new(root)?;
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|_| AppError::new("INVALID_BACKUP", "无法读取 ZIP 备份"))?;
    if zip.len() > 50_001 {
        return Err(AppError::new("BACKUP_LIMIT", "备份包含过多文件"));
    }
    let mut seen = HashSet::new();
    let mut extracted = std::collections::HashMap::new();
    let mut manifest_bytes = None;
    let mut total = 0u64;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i)?;
        let name = entry.name().to_owned();
        if !seen.insert(name.clone()) {
            return Err(AppError::new("INVALID_BACKUP", "备份中存在重复文件"));
        }
        if entry.is_dir() || entry.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000) {
            return Err(AppError::new("UNSAFE_ARCHIVE", "备份中包含目录或符号链接"));
        }
        if name != "manifest.json" {
            validate_path(&name)?;
        }
        total = total
            .checked_add(entry.size())
            .ok_or_else(|| AppError::new("BACKUP_LIMIT", "解压大小无效"))?;
        if total > MAX_EXPANDED
            || entry.size() > 128 * 1024 * 1024
            || (name == "manifest.json" && entry.size() > 8 * 1024 * 1024)
        {
            return Err(AppError::new("BACKUP_LIMIT", "备份解压后过大"));
        }
        let size = entry.size();
        let mut bytes = Vec::new();
        entry.by_ref().take(size + 1).read_to_end(&mut bytes)?;
        if bytes.len() as u64 != entry.size() {
            return Err(AppError::new("INVALID_BACKUP", "备份文件长度不符"));
        }
        if name == "manifest.json" {
            manifest_bytes = Some(bytes);
            continue;
        }
        let path = stage.0.join(&name);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(path, &bytes)?;
        extracted.insert(name, (hash(&bytes), bytes.len() as u64));
    }
    let manifest: Manifest = serde_json::from_slice(
        &manifest_bytes.ok_or_else(|| AppError::new("INVALID_BACKUP", "缺少备份清单"))?,
    )
    .map_err(|_| AppError::new("INVALID_BACKUP", "备份清单格式无效"))?;
    if manifest.format_version != 1 || !(1..=SCHEMA_VERSION).contains(&manifest.schema_version) {
        return Err(AppError::new("INCOMPATIBLE_BACKUP", "备份版本不兼容"));
    }
    let mut declared = HashSet::new();
    for entry in &manifest.files {
        validate_path(&entry.path)?;
        if !declared.insert(entry.path.clone()) {
            return Err(AppError::new("INVALID_BACKUP", "清单重复声明文件"));
        }
        if extracted.get(&entry.path) != Some(&(entry.sha256.clone(), entry.size)) {
            return Err(AppError::new(
                "CHECKSUM_MISMATCH",
                format!("文件校验失败：{}", entry.path),
            ));
        }
    }
    if extracted.len() != declared.len() || !declared.contains("workspace.sqlite") {
        return Err(AppError::new("INVALID_BACKUP", "备份文件与清单不一致"));
    }
    let conn = Connection::open_with_flags(
        stage.0.join("workspace.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    conn.execute_batch("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;")?;
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    let integrity: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
    if version != manifest.schema_version || integrity != "ok" {
        return Err(AppError::new("INVALID_BACKUP", "备份数据库完整性检查失败"));
    }
    let fk_count: i64 =
        conn.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| {
            r.get(0)
        })?;
    let unexpected: i64 = conn.query_row(
        "SELECT count(*) FROM sqlite_master WHERE type IN ('trigger','view')",
        [],
        |r| r.get(0),
    )?;
    if fk_count != 0 || unexpected != 0 {
        return Err(AppError::new("INVALID_BACKUP", "备份数据库结构或关联异常"));
    }
    // Prepare every read/write shape before touching live state.
    for sql in ["SELECT id,name,description,created_at FROM projects","SELECT id,project_id,title,kind,original_filename,source_at,imported_at,sha256,status,segment_count,error,original_path FROM sources","SELECT id,source_id,source_version_id,ordinal,locator,text FROM segments","SELECT id,kind,status,stage,error,source_id,created_at,updated_at,recovered FROM jobs","SELECT id,project_id,source_id,kind,content,status,created_at,memory_id FROM proposals","SELECT proposal_id,segment_id FROM proposal_evidence","SELECT id,project_id,kind,content,revision,state,source_title,confirmed_at,updated_at FROM memories","SELECT id,memory_id,number,content,reason,origin,created_at FROM revisions","SELECT revision_id,segment_id FROM revision_evidence","SELECT id,filename,created_at,byte_size,sha256,counts FROM backups"] {conn.prepare(sql).map_err(|_|AppError::new("INVALID_BACKUP","备份缺少必要数据结构"))?;}
    validate_typed_rows(&conn)?;
    let mut counts = json!({"projects":conn.query_row("SELECT count(*) FROM projects",[],|r|r.get::<_,i64>(0))?,"sources":conn.query_row("SELECT count(*) FROM sources",[],|r|r.get::<_,i64>(0))?,"memories":conn.query_row("SELECT count(*) FROM memories",[],|r|r.get::<_,i64>(0))?});
    if version >= 3 {
        counts["tasks"] =
            json!(conn.query_row("SELECT count(*) FROM tasks", [], |row| row.get::<_, i64>(0))?);
        counts["reports"] = json!(conn.query_row(
            "SELECT count(*) FROM daily_reports",
            [],
            |row| row.get::<_, i64>(0)
        )?);
    }
    if counts != manifest.counts {
        return Err(AppError::new("INVALID_BACKUP", "备份数量与清单不一致"));
    }
    let mut stmt = conn.prepare("SELECT original_path,sha256 FROM sources")?;
    for row in stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
        let (path, sha) = row?;
        validate_path(&path)?;
        if !path.starts_with("originals/") || extracted.get(&path).map(|x| &x.0) != Some(&sha) {
            return Err(AppError::new("INVALID_BACKUP", "原始资料缺失或校验不符"));
        }
    }
    drop(stmt);
    let cross:i64=conn.query_row("SELECT (SELECT count(*) FROM proposal_evidence e JOIN proposals p ON p.id=e.proposal_id JOIN segments g ON g.id=e.segment_id JOIN sources s ON s.id=g.source_id WHERE p.project_id<>s.project_id OR p.source_id<>s.id)+(SELECT count(*) FROM revision_evidence e JOIN revisions r ON r.id=e.revision_id JOIN memories m ON m.id=r.memory_id JOIN segments g ON g.id=e.segment_id JOIN sources s ON s.id=g.source_id WHERE m.project_id<>s.project_id)",[],|r|r.get(0))?;
    if cross != 0 {
        return Err(AppError::new("INVALID_BACKUP", "备份包含跨项目证据关联"));
    }
    let mut registry = conn.prepare("SELECT filename FROM backups")?;
    for name in registry.query_map([], |r| r.get::<_, String>(0))? {
        if !safe_filename(&name?) {
            return Err(AppError::new(
                "UNSAFE_ARCHIVE",
                "备份注册表包含不安全的路径",
            ));
        }
    }
    drop(registry);
    // Checksums prove bytes, not domain consistency. Validate accepted state as well.
    for sql in [
        "SELECT count(*) FROM sources s WHERE s.status NOT IN ('processing','ready','failed') OR (s.status='ready' AND (s.segment_count<>(SELECT count(*) FROM segments g WHERE g.source_id=s.id) OR s.segment_count=0)) OR (SELECT count(*) FROM jobs j WHERE j.source_id=s.id AND j.kind='import')<>1",
        "SELECT count(*) FROM proposals p JOIN sources s ON s.id=p.source_id WHERE p.project_id<>s.project_id OR p.kind NOT IN ('fact','decision','requirement','risk') OR p.status NOT IN ('pending','confirmed','rejected') OR NOT EXISTS(SELECT 1 FROM proposal_evidence e WHERE e.proposal_id=p.id) OR (p.status='confirmed' AND (p.memory_id IS NULL OR NOT EXISTS(SELECT 1 FROM memories m WHERE m.id=p.memory_id AND m.project_id=p.project_id))) OR (p.status<>'confirmed' AND p.memory_id IS NOT NULL)",
        "SELECT count(*) FROM memories m WHERE m.state<>'active' OR m.kind NOT IN ('fact','decision','requirement','risk') OR m.revision<1 OR (SELECT count(*) FROM revisions r WHERE r.memory_id=m.id)<>m.revision OR NOT EXISTS(SELECT 1 FROM revisions r WHERE r.memory_id=m.id AND r.number=m.revision AND r.content=m.content) OR (SELECT min(number) FROM revisions r WHERE r.memory_id=m.id)<>1 OR (SELECT max(number) FROM revisions r WHERE r.memory_id=m.id)<>m.revision",
        "SELECT count(*) FROM revisions r WHERE r.origin NOT IN ('confirmation','user_correction','automatic') OR r.number<1 OR (r.origin IN ('confirmation','automatic') AND NOT EXISTS(SELECT 1 FROM revision_evidence e WHERE e.revision_id=r.id))",
        "SELECT count(*) FROM jobs j JOIN sources s ON s.id=j.source_id WHERE j.kind NOT IN ('import','extract') OR j.status NOT IN ('queued','running','succeeded','failed','cancelled') OR (j.kind='import' AND ((j.status='succeeded' AND s.status<>'ready') OR (j.status IN ('queued','running') AND s.status<>'processing') OR (j.status='failed' AND s.status<>'failed'))) OR (j.kind='extract' AND s.status<>'ready')",
    ] {
        let invalid:i64=conn.query_row(sql,[],|r|r.get(0))?;
        if invalid!=0{return Err(AppError::new("INVALID_BACKUP","备份中的记忆、证据或处理状态不一致"));}
    }
    if version == 1 {
        let invalid: i64 = conn.query_row(
            "SELECT count(*) FROM jobs WHERE kind<>'import' OR status='cancelled'",
            [],
            |row| row.get(0),
        )?;
        if invalid != 0 {
            return Err(AppError::new(
                "INVALID_BACKUP",
                "旧版备份包含不支持的作业类型",
            ));
        }
    }
    if version >= 2 {
        validate_ai_rows(&conn)?;
    }
    if version < SCHEMA_VERSION {
        // Only migrate the validated private staging copy; original archive bytes remain unchanged.
        drop(conn);
        let conn = Connection::open(stage.0.join("workspace.sqlite"))?;
        conn.execute_batch("PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON;")?;
        crate::db::migrate(&conn)?;
        validate_ai_rows(&conn)?;
        crate::tasks::validate_backup(&conn)?;
        crate::memory::validate_backup(&conn)?;
        crate::planning::validate_backup(&conn)?;
        crate::delivery::validate_backup(&conn)?;
        crate::governance::validate_backup(&conn)?;
        crate::change_control::validate_backup(&conn)?;
        crate::coordination::validate_backup(&conn)?;
        crate::memory_workbench::validate_backup(&conn)?;
        crate::memory_facts::validate_backup(&conn)?;
        crate::extraction_store::validate_backup(&conn)?;
        crate::retention::validate_backup(&conn)?;
        crate::daily_use::validate_backup(&conn)?;
        return Ok(Validated {
            stage,
            manifest,
            conn,
        });
    }
    validate_ai_rows(&conn)?;
    crate::tasks::validate_backup(&conn)?;
    crate::memory::validate_backup(&conn)?;
    crate::planning::validate_backup(&conn)?;
    crate::delivery::validate_backup(&conn)?;
    crate::governance::validate_backup(&conn)?;
    crate::change_control::validate_backup(&conn)?;
    crate::coordination::validate_backup(&conn)?;
    crate::memory_workbench::validate_backup(&conn)?;
    crate::memory_facts::validate_backup(&conn)?;
    crate::extraction_store::validate_backup(&conn)?;
    crate::retention::validate_backup(&conn)?;
    crate::daily_use::validate_backup(&conn)?;
    Ok(Validated {
        stage,
        manifest,
        conn,
    })
}

fn validate_typed_rows(conn: &Connection) -> Result<()> {
    // SQLite affinity does not guarantee storage types or valid UTF-8. Decode all persisted DTO fields.
    let specifications = [
        ("projects", "id,name,description,created_at", "", ""),
        (
            "sources",
            "id,project_id,title,kind,original_filename,imported_at,sha256,status,original_path",
            "source_at,error",
            "segment_count",
        ),
        (
            "segments",
            "id,source_id,source_version_id,locator,text",
            "",
            "ordinal",
        ),
        (
            "jobs",
            "id,kind,status,stage,source_id,created_at,updated_at",
            "error",
            "recovered",
        ),
        (
            "proposals",
            "id,project_id,source_id,kind,content,status,created_at",
            "memory_id",
            "",
        ),
        ("proposal_evidence", "proposal_id,segment_id", "", ""),
        (
            "memories",
            "id,project_id,kind,content,state,source_title,confirmed_at,updated_at",
            "",
            "revision",
        ),
        (
            "revisions",
            "id,memory_id,content,reason,origin,created_at",
            "",
            "number",
        ),
        ("revision_evidence", "revision_id,segment_id", "", ""),
        (
            "backups",
            "id,filename,created_at,sha256,counts",
            "",
            "byte_size",
        ),
    ];
    for (table, texts, nullable, integers) in specifications {
        let text_fields = texts
            .split(',')
            .filter(|field| !field.is_empty())
            .collect::<Vec<_>>();
        let nullable_fields = nullable
            .split(',')
            .filter(|field| !field.is_empty())
            .collect::<Vec<_>>();
        let integer_fields = integers
            .split(',')
            .filter(|field| !field.is_empty())
            .collect::<Vec<_>>();
        let columns = [
            text_fields.clone(),
            nullable_fields.clone(),
            integer_fields.clone(),
        ]
        .concat()
        .join(",");
        let mut stmt = conn.prepare(&format!("SELECT {columns} FROM {table}"))?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            for index in 0..text_fields.len() {
                row.get::<_, String>(index)
                    .map_err(|_| AppError::new("INVALID_BACKUP", "备份包含无效文本或字段类型"))?;
            }
            for index in text_fields.len()..text_fields.len() + nullable_fields.len() {
                row.get::<_, Option<String>>(index)
                    .map_err(|_| AppError::new("INVALID_BACKUP", "备份包含无效可选文本字段"))?;
            }
            for index in text_fields.len() + nullable_fields.len()
                ..text_fields.len() + nullable_fields.len() + integer_fields.len()
            {
                let value = row
                    .get::<_, i64>(index)
                    .map_err(|_| AppError::new("INVALID_BACKUP", "备份包含无效数值字段"))?;
                if value < 0 {
                    return Err(AppError::new("INVALID_BACKUP", "备份包含负数计数或版本"));
                }
            }
        }
    }
    let mut stmt = conn.prepare("SELECT counts FROM backups")?;
    for row in stmt.query_map([], |row| row.get::<_, String>(0))? {
        let value: Value = serde_json::from_str(&row?)
            .map_err(|_| AppError::new("INVALID_BACKUP", "备份注册数据格式无效"))?;
        if ["projects", "sources", "memories"]
            .iter()
            .any(|key| value[key].as_u64().is_none())
        {
            return Err(AppError::new("INVALID_BACKUP", "备份注册数量无效"));
        }
    }
    Ok(())
}

fn validate_ai_rows(conn: &Connection) -> Result<()> {
    for (table,texts,optional,integers) in [
        ("jobs","","provider,model,prompt_version,input_hash,error_code,config_revision,source_hash","attempts,generation,completed_batches,total_batches,candidate_count,discarded_count,auto_extract"),
        ("proposals","origin,quotes","provider,model,prompt_version,extraction_job_id,fingerprint","edited"),
    ] {
        let text_fields=texts.split(',').filter(|field|!field.is_empty()).collect::<Vec<_>>();
        let optional_fields=optional.split(',').filter(|field|!field.is_empty()).collect::<Vec<_>>();
        let int_fields=integers.split(',').filter(|field|!field.is_empty()).collect::<Vec<_>>();
        let columns=[text_fields.clone(),optional_fields.clone(),int_fields.clone()].concat().join(",");
        let mut statement=conn.prepare(&format!("SELECT {columns} FROM {table}"))?;
        let mut rows=statement.query([])?;
        while let Some(row)=rows.next()? {
            for index in 0..text_fields.len(){row.get::<_,String>(index).map_err(|_|AppError::new("INVALID_BACKUP","AI 文本字段无效"))?;}
            for index in text_fields.len()..text_fields.len()+optional_fields.len(){row.get::<_,Option<String>>(index).map_err(|_|AppError::new("INVALID_BACKUP","AI 可选字段无效"))?;}
            for index in text_fields.len()+optional_fields.len()..text_fields.len()+optional_fields.len()+int_fields.len(){if row.get::<_,i64>(index).map_err(|_|AppError::new("INVALID_BACKUP","AI 数值字段无效"))?<0{return Err(AppError::new("INVALID_BACKUP","AI 数值不能为负数"));}}
        }
    }
    for sql in [
        "SELECT count(*) FROM jobs WHERE attempts<1 OR completed_batches>total_batches OR auto_extract NOT IN (0,1) OR recovered NOT IN (0,1) OR (kind='extract' AND (provider NOT IN ('openai_compatible','ollama') OR provider IS NULL OR model IS NULL OR trim(model)='' OR prompt_version IS NULL OR config_revision IS NULL)) OR (kind='extract' AND status IN ('running','succeeded') AND (input_hash IS NULL OR source_hash IS NULL))",
        "SELECT count(*) FROM proposals p WHERE origin NOT IN ('manual','ai') OR edited NOT IN (0,1) OR (origin='manual' AND (provider IS NOT NULL OR model IS NOT NULL OR prompt_version IS NOT NULL OR extraction_job_id IS NOT NULL OR fingerprint IS NOT NULL OR quotes<>'[]')) OR (origin='ai' AND (provider IS NULL OR model IS NULL OR prompt_version IS NULL OR extraction_job_id IS NULL OR fingerprint IS NULL OR NOT EXISTS(SELECT 1 FROM jobs j WHERE j.id=p.extraction_job_id AND j.kind='extract' AND j.source_id=p.source_id AND j.status IN ('running','failed','cancelled','queued','succeeded') AND j.provider=p.provider AND j.model=p.model AND j.prompt_version=p.prompt_version)))",
        "SELECT count(*) FROM jobs j WHERE kind='extract' AND candidate_count<>(SELECT count(*) FROM proposals p WHERE p.extraction_job_id=j.id)",
    ] {if conn.query_row(sql,[],|row|row.get::<_,i64>(0))?!=0{return Err(AppError::new("INVALID_BACKUP","AI 作业或来源信息不一致"));}}
    let mut statement = conn.prepare("SELECT id,source_id,quotes,origin FROM proposals")?;
    for row in statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
        ))
    })? {
        let (proposal, source, raw, origin) = row?;
        let quotes: Value = serde_json::from_str(&raw)
            .map_err(|_| AppError::new("INVALID_BACKUP", "AI 引文格式无效"))?;
        let quotes = quotes
            .as_array()
            .ok_or_else(|| AppError::new("INVALID_BACKUP", "AI 引文必须是数组"))?;
        if origin == "ai" && quotes.is_empty() {
            return Err(AppError::new("INVALID_BACKUP", "AI 提议缺少原文引文"));
        }
        let mut quoted = HashSet::new();
        for evidence in quotes {
            let segment = required(evidence, "segmentId")?;
            let quote = required(evidence, "quote")?;
            let text=conn.query_row("SELECT g.text FROM segments g JOIN proposal_evidence e ON e.segment_id=g.id WHERE g.id=? AND g.source_id=? AND e.proposal_id=?",params![segment,source,proposal],|row|row.get::<_,String>(0)).map_err(|_|AppError::new("INVALID_BACKUP","AI 引文不属于提议证据"))?;
            if !text.contains(quote) {
                return Err(AppError::new("INVALID_BACKUP", "AI 引文与原始片段不符"));
            }
            quoted.insert(segment.to_owned());
        }
        if origin == "ai" {
            let evidence_count: i64 = conn.query_row(
                "SELECT count(*) FROM proposal_evidence WHERE proposal_id=?",
                [proposal],
                |row| row.get(0),
            )?;
            if quoted.len() as i64 != evidence_count {
                return Err(AppError::new("INVALID_BACKUP", "AI 证据与引文不一致"));
            }
        }
    }
    Ok(())
}

pub(crate) fn inspect(db: &Database, p: &Value) -> Result<Value> {
    let data = validate(&db.root, p)?;
    let mut counts = data.manifest.counts.clone();
    if counts.get("tasks").is_none() {
        counts["tasks"] = json!(0);
    }
    if counts.get("reports").is_none() {
        counts["reports"] = json!(0);
    }
    Ok(
        json!({"formatVersion":data.manifest.format_version,"createdAt":data.manifest.created_at,"counts":counts,"compatible":true}),
    )
}

pub(crate) fn restore(db: &mut Database, p: &Value) -> Result<Value> {
    if p["confirmation"] != "RESTORE" {
        return Err(AppError::new(
            "CONFIRMATION_REQUIRED",
            "恢复需要明确确认 RESTORE",
        ));
    }
    let data = validate(&db.root, p)?;
    let old_extraction_budget = crate::extraction_store::budget_records(&db.conn)?;
    let old_budget = {
        let mut statement = db.conn.prepare("SELECT day,calls FROM memory_budget")?;
        let rows = statement
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows
    };
    let safety = create(db)?;
    let mut stmt = db
        .conn
        .prepare("SELECT id,filename,created_at,byte_size,sha256,counts FROM backups")?;
    let old_backups = stmt
        .query_map([], crate::db::backup_row)?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    drop(stmt);
    write_journal(&db.root, &safety)?;
    let staged_originals = data.stage.0.join("originals");
    fs::create_dir_all(&staged_originals)?;
    let old_originals = data.stage.0.join("previous-originals");
    fs::rename(db.root.join("originals"), &old_originals)?;
    if let Err(error) = fs::rename(&staged_originals, db.root.join("originals")) {
        let _ = fs::rename(&old_originals, db.root.join("originals"));
        return Err(error.into());
    }
    let copied = (|| -> Result<()> {
        Backup::new(&data.conn, &mut db.conn)?.run_to_completion(
            128,
            Duration::from_millis(5),
            None,
        )?;
        Ok(())
    })();
    if let Err(error) = copied {
        let _ = fs::remove_dir_all(db.root.join("originals"));
        let _ = fs::rename(old_originals, db.root.join("originals"));
        return Err(error);
    }
    db.conn
        .execute_batch("DELETE FROM memory_lexical; DELETE FROM memory_lexical_state;")?;
    db.epoch += 1;
    db.conn.execute("UPDATE workspace_options SET value=json_set(value,'$.enabled',json('false'),'$.automaticIds',json('[]')) WHERE key='backup_policy'",[])?;
    db.conn.execute("UPDATE workspace_options SET value=json_set(value,'$.notifications',json('false'),'$.autostart',json('false')) WHERE key='desktop'",[])?;
    db.conn
        .execute_batch("PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;")?;
    for record in old_backups {
        insert_record(&db.conn, &record)?;
    }
    // Restoring an older project must not refund requests already sent today.
    for (day, calls) in old_budget {
        db.conn.execute("INSERT INTO memory_budget VALUES(?,?) ON CONFLICT(day) DO UPDATE SET calls=max(calls,excluded.calls)",params![day,calls])?;
    }
    crate::extraction_store::preserve_budgets(&db.conn, &old_extraction_budget)?;
    db.conn.execute("UPDATE jobs SET status='cancelled',stage='还原后已暂停，请手动重试',error=NULL,error_code='RESTORED_PAUSED',generation=generation+1,updated_at=? WHERE kind='extract' AND status IN ('queued','running')",[now()])?;
    // Parsing may resume, but a restored import must never inherit authority to send material.
    db.conn
        .execute("UPDATE jobs SET auto_extract=0 WHERE kind='import'", [])?;
    db.conn.execute(
        "UPDATE memory_settings SET enabled=0,revision=? WHERE id=1",
        [crate::id()],
    )?;
    db.conn.execute("UPDATE memory_runs SET status='cancelled',message='还原后暂停',updated_at=? WHERE status='running'",[now()])?;
    db.conn.execute(
        "UPDATE planning_drafts SET status='stale' WHERE status='pending'",
        [],
    )?;
    db.recovered_jobs=db.conn.execute("UPDATE jobs SET status='queued',stage='等待恢复',recovered=1,generation=generation+1,updated_at=? WHERE kind='import' AND status IN ('queued','running')",[now()])?;
    // The journal is the commit marker. A process crash before removal always rolls back.
    db.conn.execute_batch("PRAGMA wal_checkpoint(FULL);")?;
    for entry in &data.manifest.files {
        if entry.path.starts_with("originals/") {
            crate::sync_file(&db.root.join(&entry.path))?;
        }
    }
    crate::sync_directory(&db.root.join("originals"))?;
    fs::remove_file(db.root.join("restore-journal.json"))?;
    crate::sync_directory(&db.root)?;
    Ok(json!({"safetyBackupId":safety["id"],"counts":db.counts()?}))
}

fn write_journal(root: &Path, safety: &Value) -> Result<()> {
    let journal = RestoreJournal {
        format_version: 1,
        safety_backup: safety.clone(),
    };
    let bytes =
        serde_json::to_vec(&journal).map_err(|e| AppError::new("SERIALIZATION", e.to_string()))?;
    let temporary = root.join("restore-journal.pending");
    let mut file = fs::File::create(&temporary)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    fs::rename(temporary, root.join("restore-journal.json"))?;
    crate::sync_directory(root)?;
    Ok(())
}

/// Called before opening SQLite, under the exclusive workspace lock.
/// A validated safety archive is sufficient even if both directory and DB swaps were interrupted.
pub(crate) fn recover_interrupted(root: &Path) -> Result<()> {
    let journal_path = root.join("restore-journal.json");
    if !journal_path.exists() {
        return Ok(());
    }
    let raw = fs::read(&journal_path)?;
    if raw.len() > 16 * 1024 {
        return Err(AppError::new(
            "RESTORE_RECOVERY",
            "恢复日志异常，已保留现场与安全备份",
        ));
    }
    let journal: RestoreJournal = serde_json::from_slice(&raw)
        .map_err(|_| AppError::new("RESTORE_RECOVERY", "恢复日志损坏，已保留现场与安全备份"))?;
    let filename = required(&journal.safety_backup, "filename")?;
    if journal.format_version != 1 || !safe_filename(filename) {
        return Err(AppError::new(
            "RESTORE_RECOVERY",
            "恢复日志中的安全备份路径无效",
        ));
    }
    let bytes = fs::read(root.join("backups").join(filename))?;
    if hash(&bytes) != required(&journal.safety_backup, "sha256")? {
        return Err(AppError::new(
            "RESTORE_RECOVERY",
            "安全备份校验失败，已停止恢复",
        ));
    }
    let payload = json!({"filename":filename,"contentBase64":base64::engine::general_purpose::STANDARD.encode(bytes)});
    let data = validate(root, &payload)?;
    fs::create_dir_all(data.stage.0.join("originals"))?;
    let previous = data.stage.0.join("interrupted-originals");
    if root.join("originals").exists() {
        fs::rename(root.join("originals"), &previous)?;
    }
    fs::rename(data.stage.0.join("originals"), root.join("originals"))?;
    for name in ["workspace.sqlite-wal", "workspace.sqlite-shm"] {
        let path = root.join(name);
        if path.exists() {
            fs::remove_file(path)?;
        }
    }
    let database = root.join("workspace.sqlite");
    fs::copy(data.stage.0.join("workspace.sqlite"), &database)?;
    crate::sync_file(&database)?;
    let conn = Connection::open(&database)?;
    conn.execute_batch("DELETE FROM memory_lexical; DELETE FROM memory_lexical_state;")?;
    insert_record(&conn, &journal.safety_backup)?;
    conn.execute("UPDATE jobs SET status='cancelled',stage='恢复中断后已暂停，请手动重试',error=NULL,error_code='RESTORED_PAUSED',generation=generation+1,updated_at=? WHERE kind='extract' AND status IN ('queued','running')",[now()])?;
    conn.execute("UPDATE jobs SET auto_extract=0 WHERE kind='import'", [])?;
    drop(conn);
    fs::remove_file(journal_path)?;
    crate::sync_directory(root)?;
    eprintln!("rolled back an interrupted restore from validated safety backup");
    Ok(())
}
