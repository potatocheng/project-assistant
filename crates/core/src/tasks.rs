use crate::{ai, hash, id, now, required, AppError, Result};
use chrono::NaiveDate;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

pub(crate) const MIGRATION: &str = r#"
CREATE TABLE tasks(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),title TEXT NOT NULL,description TEXT NOT NULL,category TEXT NOT NULL,assignee TEXT,priority TEXT NOT NULL,status TEXT NOT NULL,progress INTEGER NOT NULL,due_date TEXT,planned_date TEXT,version INTEGER NOT NULL,origin TEXT NOT NULL,memory_id TEXT REFERENCES memories(id),memory_revision INTEGER,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE task_evidence(task_id TEXT NOT NULL REFERENCES tasks(id),segment_id TEXT NOT NULL REFERENCES segments(id),PRIMARY KEY(task_id,segment_id));
CREATE TABLE task_events(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),project_id TEXT NOT NULL REFERENCES projects(id),version INTEGER NOT NULL,work_date TEXT NOT NULL,recorded_at TEXT NOT NULL,note TEXT NOT NULL,origin TEXT NOT NULL,before_json TEXT,after_json TEXT NOT NULL,evidence_json TEXT NOT NULL,UNIQUE(task_id,version));
CREATE TABLE task_proposals(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),source_id TEXT NOT NULL REFERENCES sources(id),title TEXT NOT NULL,description TEXT NOT NULL,assignee TEXT,due_date TEXT,due_text TEXT,task_status TEXT NOT NULL,progress INTEGER,status TEXT NOT NULL,quotes TEXT NOT NULL,model TEXT NOT NULL,provider TEXT NOT NULL,prompt_version TEXT NOT NULL,extraction_job_id TEXT NOT NULL REFERENCES jobs(id),edited INTEGER NOT NULL DEFAULT 0,task_id TEXT REFERENCES tasks(id),created_at TEXT NOT NULL,fingerprint TEXT NOT NULL UNIQUE);
CREATE TABLE task_proposal_evidence(proposal_id TEXT NOT NULL REFERENCES task_proposals(id),segment_id TEXT NOT NULL REFERENCES segments(id),PRIMARY KEY(proposal_id,segment_id));
CREATE TABLE daily_reports(id TEXT PRIMARY KEY,date TEXT NOT NULL,scope TEXT NOT NULL,project_id TEXT REFERENCES projects(id),version INTEGER NOT NULL,edited INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,content TEXT NOT NULL,basis_json TEXT NOT NULL,UNIQUE(date,scope,version));
CREATE TABLE operation_receipts(request_id TEXT PRIMARY KEY,command TEXT NOT NULL,payload_hash TEXT NOT NULL,response_json TEXT NOT NULL,created_at TEXT NOT NULL);
ALTER TABLE jobs ADD COLUMN task_candidate_count INTEGER NOT NULL DEFAULT 0;
CREATE INDEX task_event_date ON task_events(work_date,project_id);
CREATE INDEX task_project ON tasks(project_id);
PRAGMA user_version=3;
"#;

const TASK_SELECT:&str="SELECT id,project_id,title,description,category,assignee,priority,status,progress,due_date,planned_date,version,origin,memory_id,memory_revision,created_at,updated_at FROM tasks";
const PROPOSAL_SELECT:&str="SELECT id,project_id,source_id,title,description,assignee,due_date,due_text,task_status,progress,status,quotes,model,provider,prompt_version,extraction_job_id,edited,task_id,created_at FROM task_proposals";
const REPORT_SELECT:&str="SELECT id,date,project_id,version,edited,created_at,updated_at,content,basis_json FROM daily_reports";

fn failure(message: &str) -> AppError {
    AppError::new("VALIDATION", message)
}
pub(crate) fn valid_date(value: &str) -> Result<()> {
    let date = NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .map_err(|_| failure("日期必须是有效 YYYY-MM-DD"))?;
    if date.format("%Y-%m-%d").to_string() != value {
        return Err(failure("日期必须是完整 YYYY-MM-DD"));
    }
    Ok(())
}
fn optional_string(p: &Value, key: &str) -> Result<Option<String>> {
    match p.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(if value.trim().is_empty() {
            None
        } else {
            Some(value.trim().into())
        }),
        _ => Err(failure("可选文字字段格式无效")),
    }
}
fn optional_date(p: &Value, key: &str) -> Result<Option<String>> {
    let value = optional_string(p, key)?;
    if let Some(value) = &value {
        valid_date(value)?;
    }
    Ok(value)
}
fn integer(p: &Value, key: &str) -> Result<i64> {
    p[key]
        .as_i64()
        .ok_or_else(|| failure("版本或进度必须是整数"))
}
fn project_exists(conn: &Connection, project: &str) -> Result<()> {
    if !conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM projects WHERE id=?)",
        [project],
        |row| row.get::<_, bool>(0),
    )? {
        return Err(AppError::new("NOT_FOUND", "项目不存在"));
    }
    Ok(())
}
fn selected_project(conn: &Connection, p: &Value) -> Result<Option<String>> {
    let project = optional_string(p, "projectId")?;
    if let Some(project) = &project {
        project_exists(conn, project)?;
    }
    Ok(project)
}
fn limited(value: &str, limit: usize, nonempty: bool) -> Result<()> {
    if value.chars().count() > limit || (nonempty && value.trim().is_empty()) {
        Err(failure("文字为空或超过长度限制"))
    } else {
        Ok(())
    }
}
fn validate_fields(p: &Value) -> Result<()> {
    limited(required(p, "title")?, 300, true)?;
    limited(
        p["description"]
            .as_str()
            .ok_or_else(|| failure("description 必须为文字"))?,
        10000,
        false,
    )?;
    if !matches!(p["category"].as_str(), Some("action" | "follow_up"))
        || !matches!(p["priority"].as_str(), Some("high" | "medium" | "low"))
        || !matches!(
            p["status"].as_str(),
            Some("todo" | "in_progress" | "blocked" | "done" | "cancelled")
        )
    {
        return Err(failure("任务分类、优先级或状态无效"));
    }
    let progress = integer(p, "progress")?;
    if !(0..=100).contains(&progress) || (p["status"] == "done" && progress != 100) {
        return Err(failure("进度需为 0 到 100；已完成任务必须为 100"));
    }
    let assignee = optional_string(p, "assignee")?;
    if let Some(value) = assignee {
        limited(&value, 300, false)?;
    }
    optional_date(p, "dueDate")?;
    optional_date(p, "plannedDate")?;
    Ok(())
}
fn task_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(
        json!({"id":row.get::<_,String>(0)?,"projectId":row.get::<_,String>(1)?,"title":row.get::<_,String>(2)?,"description":row.get::<_,String>(3)?,"category":row.get::<_,String>(4)?,"assignee":row.get::<_,Option<String>>(5)?,"priority":row.get::<_,String>(6)?,"status":row.get::<_,String>(7)?,"progress":row.get::<_,i64>(8)?,"dueDate":row.get::<_,Option<String>>(9)?,"plannedDate":row.get::<_,Option<String>>(10)?,"version":row.get::<_,i64>(11)?,"origin":row.get::<_,String>(12)?,"memoryId":row.get::<_,Option<String>>(13)?,"memoryRevision":row.get::<_,Option<i64>>(14)?,"createdAt":row.get::<_,String>(15)?,"updatedAt":row.get::<_,String>(16)?}),
    )
}
pub(crate) fn task(conn: &Connection, id: &str) -> Result<Value> {
    conn.query_row(&format!("{TASK_SELECT} WHERE id=?"), [id], task_row)
        .optional()?
        .ok_or_else(|| AppError::new("NOT_FOUND", "任务不存在"))
}
fn decode_json(raw: String) -> rusqlite::Result<Value> {
    serde_json::from_str(&raw).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
    })
}
fn evidence_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(
        json!({"segmentId":row.get::<_,String>(0)?,"sourceId":row.get::<_,String>(1)?,"sourceTitle":row.get::<_,String>(2)?,"locator":row.get::<_,String>(3)?,"text":row.get::<_,String>(4)?}),
    )
}
fn evidence_for_segments(
    conn: &Connection,
    project: &str,
    segments: &[String],
) -> Result<Vec<Value>> {
    let mut output = Vec::new();
    for segment in segments {
        let value=conn.query_row("SELECT g.id,s.id,s.title,g.locator,g.text FROM segments g JOIN sources s ON s.id=g.source_id WHERE g.id=? AND s.project_id=?",params![segment,project],evidence_row).optional()?.ok_or_else(||AppError::new("EVIDENCE_SCOPE","证据不属于任务项目"))?;
        output.push(value);
    }
    Ok(output)
}
fn event_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(
        json!({"id":row.get::<_,String>(0)?,"taskId":row.get::<_,String>(1)?,"projectId":row.get::<_,String>(2)?,"version":row.get::<_,i64>(3)?,"workDate":row.get::<_,String>(4)?,"recordedAt":row.get::<_,String>(5)?,"note":row.get::<_,String>(6)?,"origin":row.get::<_,String>(7)?,"before":row.get::<_,Option<String>>(8)?.map(decode_json).transpose()?,"after":decode_json(row.get(9)?)?,"evidence":decode_json(row.get(10)?)?}),
    )
}
const EVENT_SELECT:&str="SELECT id,task_id,project_id,version,work_date,recorded_at,note,origin,before_json,after_json,evidence_json FROM task_events";
fn event(conn: &Connection, id: &str) -> Result<Value> {
    conn.query_row(&format!("{EVENT_SELECT} WHERE id=?"), [id], event_row)
        .map_err(Into::into)
}
fn append_event(
    conn: &Connection,
    before: Option<&Value>,
    after: &Value,
    date: &str,
    note: &str,
    origin: &str,
    evidence: &[Value],
) -> Result<()> {
    valid_date(date)?;
    if let Some(last) = conn
        .query_row(
            "SELECT work_date FROM task_events WHERE task_id=? ORDER BY version DESC LIMIT 1",
            [after["id"].as_str().unwrap()],
            |row| row.get::<_, String>(0),
        )
        .optional()?
    {
        if date < last.as_str() {
            return Err(AppError::new(
                "WORK_DATE_ORDER",
                "工作日期不能早于该任务最近一次记录，请按实际日期顺序补录",
            ));
        }
    }
    conn.execute(
        "INSERT INTO task_events VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        params![
            id(),
            after["id"].as_str(),
            after["projectId"].as_str(),
            after["version"].as_i64(),
            date,
            after["updatedAt"].as_str(),
            note,
            origin,
            before.map(Value::to_string),
            after.to_string(),
            json!(evidence).to_string()
        ],
    )?;
    Ok(())
}
pub(crate) fn insert_task(
    conn: &Connection,
    p: &Value,
    origin: &str,
    memory: Option<(&str, i64)>,
    evidence: &[Value],
    note: &str,
) -> Result<Value> {
    let project = required(p, "projectId")?;
    project_exists(conn, project)?;
    let status = match p.get("status") {
        None | Some(Value::Null) => "todo",
        Some(Value::String(value)) => value,
        _ => return Err(failure("status 必须是任务状态文字")),
    };
    let progress = match p.get("progress") {
        None | Some(Value::Null) => 0,
        Some(value) => value
            .as_i64()
            .ok_or_else(|| failure("progress 必须是整数"))?,
    };
    let description = match p.get("description") {
        None | Some(Value::Null) => "",
        Some(Value::String(value)) => value,
        _ => return Err(failure("description 必须是文字")),
    };
    let mut value = json!({"id":id(),"projectId":project,"title":required(p,"title")?.trim(),"description":description,"category":p["category"],"assignee":optional_string(p,"assignee")?,"priority":p["priority"],"status":status,"progress":progress,"dueDate":optional_date(p,"dueDate")?,"plannedDate":optional_date(p,"plannedDate")?,"version":1,"origin":origin,"memoryId":memory.map(|item|item.0),"memoryRevision":memory.map(|item|item.1),"createdAt":now(),"updatedAt":""});
    value["updatedAt"] = value["createdAt"].clone();
    validate_fields(&value)?;
    conn.execute(
        "INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        params![
            value["id"].as_str(),
            project,
            value["title"].as_str(),
            value["description"].as_str(),
            value["category"].as_str(),
            value["assignee"].as_str(),
            value["priority"].as_str(),
            value["status"].as_str(),
            value["progress"].as_i64(),
            value["dueDate"].as_str(),
            value["plannedDate"].as_str(),
            1,
            origin,
            memory.map(|item| item.0),
            memory.map(|item| item.1),
            value["createdAt"].as_str(),
            value["updatedAt"].as_str()
        ],
    )?;
    for item in evidence {
        conn.execute(
            "INSERT INTO task_evidence VALUES (?,?)",
            params![value["id"].as_str(), item["segmentId"].as_str()],
        )?;
    }
    append_event(
        conn,
        None,
        &value,
        required(p, "workDate")?,
        note,
        if origin == "manual" { "user" } else { origin },
        evidence,
    )?;
    Ok(value)
}
pub(crate) fn write_task(
    conn: &Connection,
    before: &Value,
    p: &Value,
    origin: &str,
    evidence: &[Value],
    note: &str,
) -> Result<Value> {
    let base = integer(p, "baseVersion")?;
    if before["version"].as_i64() != Some(base) {
        return Err(AppError::new(
            "VERSION_CONFLICT",
            "任务已有新版本，请重新打开后修改",
        ));
    }
    let mut after = before.clone();
    for key in [
        "title",
        "description",
        "category",
        "assignee",
        "priority",
        "status",
        "progress",
        "dueDate",
        "plannedDate",
    ] {
        if p.get(key).is_none() {
            return Err(failure("更新任务需要完整表单字段"));
        }
        after[key] = p[key].clone();
    }
    validate_fields(&after)?;
    after["assignee"] = json!(optional_string(&after, "assignee")?);
    after["dueDate"] = json!(optional_date(&after, "dueDate")?);
    after["plannedDate"] = json!(optional_date(&after, "plannedDate")?);
    after["version"] = json!(base + 1);
    after["updatedAt"] = json!(now());
    append_event(
        conn,
        Some(before),
        &after,
        required(p, "workDate")?,
        note,
        origin,
        evidence,
    )?;
    conn.execute("UPDATE tasks SET title=?,description=?,category=?,assignee=?,priority=?,status=?,progress=?,due_date=?,planned_date=?,version=?,updated_at=? WHERE id=? AND version=?",params![after["title"].as_str(),after["description"].as_str(),after["category"].as_str(),after["assignee"].as_str(),after["priority"].as_str(),after["status"].as_str(),after["progress"].as_i64(),after["dueDate"].as_str(),after["plannedDate"].as_str(),base+1,after["updatedAt"].as_str(),after["id"].as_str(),base])?;
    Ok(after)
}
pub(crate) fn create(conn: &Connection, p: &Value) -> Result<Value> {
    let project = required(p, "projectId")?;
    let memory = optional_string(p, "memoryId")?;
    let mut revision = None;
    let mut evidence = Vec::new();
    if let Some(memory) = &memory {
        let number = conn
            .query_row(
                "SELECT revision FROM memories WHERE id=? AND project_id=?",
                params![memory, project],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .ok_or_else(|| AppError::new("EVIDENCE_SCOPE", "记忆不属于该项目"))?;
        let mut statement=conn.prepare("SELECT e.segment_id FROM revision_evidence e JOIN revisions r ON r.id=e.revision_id WHERE r.memory_id=? AND r.number=?")?;
        let segments = statement
            .query_map(params![memory, number], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        evidence = evidence_for_segments(conn, project, &segments)?;
        revision = Some(number);
    }
    insert_task(
        conn,
        p,
        if memory.is_some() { "memory" } else { "manual" },
        memory.as_deref().zip(revision),
        &evidence,
        "创建任务",
    )
}
fn update(conn: &Connection, p: &Value) -> Result<Value> {
    let before = task(conn, required(p, "taskId")?)?;
    let note = required(p, "note")?;
    limited(note, 10000, true)?;
    write_task(conn, &before, p, "user", &[], note)
}
pub(crate) fn task_detail(conn: &Connection, id: &str) -> Result<Value> {
    let value = task(conn, id)?;
    let mut statement = conn.prepare(&format!(
        "{EVENT_SELECT} WHERE task_id=? ORDER BY version DESC"
    ))?;
    let events = statement
        .query_map([id], event_row)?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut statement =
        conn.prepare("SELECT segment_id FROM task_evidence WHERE task_id=? ORDER BY segment_id")?;
    let ids = statement
        .query_map([id], |row| row.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(
        json!({"task":value,"events":events,"evidence":evidence_for_segments(conn,value["projectId"].as_str().unwrap(),&ids)?}),
    )
}

fn proposal_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(
        json!({"id":row.get::<_,String>(0)?,"projectId":row.get::<_,String>(1)?,"sourceId":row.get::<_,String>(2)?,"title":row.get::<_,String>(3)?,"description":row.get::<_,String>(4)?,"assignee":row.get::<_,Option<String>>(5)?,"dueDate":row.get::<_,Option<String>>(6)?,"dueText":row.get::<_,Option<String>>(7)?,"taskStatus":row.get::<_,String>(8)?,"progress":row.get::<_,Option<i64>>(9)?,"status":row.get::<_,String>(10)?,"quotes":decode_json(row.get(11)?)?,"model":row.get::<_,String>(12)?,"provider":row.get::<_,String>(13)?,"promptVersion":row.get::<_,String>(14)?,"extractionJobId":row.get::<_,String>(15)?,"edited":row.get::<_,bool>(16)?,"taskId":row.get::<_,Option<String>>(17)?,"createdAt":row.get::<_,String>(18)?}),
    )
}
fn proposal(conn: &Connection, id: &str) -> Result<Value> {
    let mut value = conn
        .query_row(&format!("{PROPOSAL_SELECT} WHERE id=?"), [id], proposal_row)
        .optional()?
        .ok_or_else(|| AppError::new("NOT_FOUND", "任务提议不存在"))?;
    let mut statement = conn.prepare(
        "SELECT segment_id FROM task_proposal_evidence WHERE proposal_id=? ORDER BY segment_id",
    )?;
    value["segmentIds"] = json!(statement
        .query_map([id], |row| row.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?);
    Ok(value)
}
fn validate_proposal(p: &Value) -> Result<()> {
    limited(required(p, "title")?, 300, true)?;
    limited(
        p["description"]
            .as_str()
            .ok_or_else(|| failure("description 必须是文字"))?,
        10000,
        false,
    )?;
    if !matches!(
        p["taskStatus"].as_str(),
        Some("todo" | "in_progress" | "blocked" | "done")
    ) {
        return Err(failure("任务提议状态无效"));
    }
    if !p["progress"].is_null() {
        let value = integer(p, "progress")?;
        if !(0..=100).contains(&value) {
            return Err(failure("提议进度必须是 0 到 100"));
        }
    }
    if let Some(value) = optional_string(p, "assignee")? {
        limited(&value, 300, false)?;
    }
    if let Some(value) = optional_string(p, "dueText")? {
        limited(&value, 1000, false)?;
    }
    optional_date(p, "dueDate")?;
    Ok(())
}
fn edit_proposal(conn: &Connection, p: &Value) -> Result<Value> {
    let id = required(p, "proposalId")?;
    if proposal(conn, id)?["status"] != "pending" {
        return Err(AppError::new("CONFLICT", "只能编辑待确认任务提议"));
    }
    for key in [
        "title",
        "description",
        "assignee",
        "dueDate",
        "dueText",
        "taskStatus",
        "progress",
    ] {
        if p.get(key).is_none() {
            return Err(failure("任务提议需要完整表单"));
        }
    }
    validate_proposal(p)?;
    conn.execute("UPDATE task_proposals SET title=?,description=?,assignee=?,due_date=?,due_text=?,task_status=?,progress=?,edited=1 WHERE id=?",params![p["title"].as_str(),p["description"].as_str(),optional_string(p,"assignee")?,optional_date(p,"dueDate")?,optional_string(p,"dueText")?,p["taskStatus"].as_str(),p["progress"].as_i64(),id])?;
    proposal(conn, id)
}
fn reject_proposal(conn: &Connection, p: &Value) -> Result<Value> {
    let id = required(p, "proposalId")?;
    if proposal(conn, id)?["status"] == "confirmed" {
        return Err(AppError::new("CONFLICT", "已确认提议不能忽略"));
    }
    conn.execute(
        "UPDATE task_proposals SET status='rejected' WHERE id=?",
        [id],
    )?;
    proposal(conn, id)
}
pub(crate) fn confirm_proposal(conn: &Connection, p: &Value) -> Result<Value> {
    let id = required(p, "proposalId")?;
    let candidate = proposal(conn, id)?;
    if candidate["status"] == "confirmed" {
        return task(conn, candidate["taskId"].as_str().unwrap());
    }
    if candidate["status"] == "rejected" {
        return Err(AppError::new("CONFLICT", "已忽略的任务提议无法确认"));
    }
    let note = required(p, "note")?;
    limited(note, 10000, true)?;
    let mut evidence = evidence_for_segments(
        conn,
        candidate["projectId"].as_str().unwrap(),
        &candidate["segmentIds"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_owned())
            .collect::<Vec<_>>(),
    )?;
    for item in &mut evidence {
        item["quotes"] = json!(candidate["quotes"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|quote| quote["segmentId"] == item["segmentId"])
            .map(|quote| quote["quote"].clone())
            .collect::<Vec<_>>());
    }
    let mut input = p.clone();
    input["projectId"] = candidate["projectId"].clone();
    input["status"] = candidate["taskStatus"].clone();
    let combined_note = format!(
        "{note}\n\n来源提议：{}\n{}",
        candidate["title"].as_str().unwrap(),
        candidate["description"].as_str().unwrap()
    );
    let value = match required(p, "mode")? {
        "create" => {
            for key in ["title", "description", "assignee", "dueDate"] {
                input[key] = candidate[key].clone();
            }
            input["progress"] = json!(if candidate["taskStatus"] == "done" {
                100
            } else {
                candidate["progress"].as_i64().unwrap_or(0)
            });
            insert_task(conn, &input, "ai", None, &evidence, &combined_note)?
        }
        "update" => {
            let before = task(conn, required(p, "taskId")?)?;
            if before["projectId"] != candidate["projectId"] {
                return Err(AppError::new("EVIDENCE_SCOPE", "任务与提议不属于同一项目"));
            }
            for key in [
                "title",
                "description",
                "category",
                "assignee",
                "priority",
                "dueDate",
                "plannedDate",
            ] {
                input[key] = before[key].clone();
            }
            input["progress"] = json!(if candidate["taskStatus"] == "done" {
                100
            } else {
                candidate["progress"]
                    .as_i64()
                    .unwrap_or(before["progress"].as_i64().unwrap())
            });
            write_task(conn, &before, &input, "ai", &evidence, &combined_note)?
        }
        _ => return Err(failure("确认模式无效")),
    };
    conn.execute(
        "UPDATE task_proposals SET status='confirmed',task_id=? WHERE id=?",
        params![value["id"].as_str(), id],
    )?;
    Ok(value)
}

pub(crate) fn ground_candidates(
    conn: &Connection,
    source: &str,
    project: &str,
    candidates: Vec<ai::AiTaskCandidate>,
) -> Result<(Vec<ai::AiTaskCandidate>, usize)> {
    let mut statement=conn.prepare("SELECT g.id,g.text,g.locator FROM segments g JOIN sources s ON s.id=g.source_id WHERE s.id=? AND s.project_id=? ORDER BY g.ordinal")?;
    let segments = statement
        .query_map(params![source, project], |row| {
            Ok(ai::SourceSegment {
                id: row.get(0)?,
                text: row.get(1)?,
                locator: row.get(2)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut good = Vec::new();
    let mut discarded = 0;
    for candidate in candidates {
        if ai::grounded_task_candidate(&candidate, &segments) {
            good.push(candidate);
        } else {
            discarded += 1;
        }
    }
    Ok((good, discarded))
}
pub(crate) struct AiOrigin<'a> {
    pub source: &'a str,
    pub project: &'a str,
    pub job: &'a str,
    pub provider: &'a str,
    pub model: &'a str,
    pub prompt: &'a str,
}
pub(crate) fn insert_candidates(
    conn: &Connection,
    origin: AiOrigin<'_>,
    candidates: Vec<ai::AiTaskCandidate>,
) -> Result<usize> {
    let AiOrigin {
        source,
        project,
        job,
        provider,
        model,
        prompt,
    } = origin;
    let mut created = 0;
    for candidate in candidates {
        let mut segments = candidate
            .evidence
            .iter()
            .map(|value| value.segment_id.clone())
            .collect::<Vec<_>>();
        segments.sort();
        segments.dedup();
        let fingerprint = hash(
            json!([
                source,
                candidate.title,
                candidate.description,
                candidate.assignee,
                candidate.due_date,
                candidate.due_text,
                candidate.status,
                candidate.progress,
                segments
            ])
            .to_string()
            .as_bytes(),
        );
        if conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM task_proposals WHERE fingerprint=?)",
            [&fingerprint],
            |row| row.get::<_, bool>(0),
        )? {
            continue;
        }
        let quotes = candidate
            .evidence
            .iter()
            .map(|item| json!({"segmentId":item.segment_id,"quote":item.quote}))
            .collect::<Vec<_>>();
        let id = id();
        conn.execute("INSERT INTO task_proposals VALUES (?,?,?,?,?,?,?,?,?,?,'pending',?,?,?,?,?,0,NULL,?,?)",params![id,project,source,candidate.title,candidate.description,candidate.assignee,candidate.due_date,candidate.due_text,candidate.status,candidate.progress,json!(quotes).to_string(),model,provider,prompt,job,now(),fingerprint])?;
        for segment in segments {
            conn.execute(
                "INSERT INTO task_proposal_evidence VALUES (?,?)",
                params![id, segment],
            )?;
        }
        created += 1;
    }
    Ok(created)
}

fn as_of(conn: &Connection, date: &str, project: Option<&str>) -> Result<Vec<Value>> {
    valid_date(date)?;
    let mut statement=conn.prepare("SELECT after_json FROM task_events e WHERE work_date<=?1 AND (?2 IS NULL OR project_id=?2) AND version=(SELECT max(version) FROM task_events x WHERE x.task_id=e.task_id AND x.work_date<=?1) ORDER BY task_id")?;
    let values = statement
        .query_map(params![date, project], |row| decode_json(row.get(0)?))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(values)
}
fn events_on(conn: &Connection, date: &str, project: Option<&str>) -> Result<Vec<Value>> {
    let mut statement=conn.prepare(&format!("{EVENT_SELECT} WHERE work_date=?1 AND (?2 IS NULL OR project_id=?2) ORDER BY recorded_at,task_id,version"))?;
    let values = statement
        .query_map(params![date, project], event_row)?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(values)
}
fn active(task: &Value) -> bool {
    matches!(
        task["status"].as_str(),
        Some("todo" | "in_progress" | "blocked")
    )
}
fn rank(task: &Value) -> (u8, u8, String, String) {
    (
        if active(task) { 0 } else { 1 },
        match task["priority"].as_str() {
            Some("high") => 0,
            Some("medium") => 1,
            _ => 2,
        },
        task["dueDate"].as_str().unwrap_or("9999-12-31").into(),
        task["id"].as_str().unwrap().into(),
    )
}
fn daily_list(conn: &Connection, p: &Value) -> Result<Value> {
    let date = required(p, "date")?;
    valid_date(date)?;
    let project = selected_project(conn, p)?;
    let happened = events_on(conn, date, project.as_deref())?
        .into_iter()
        .map(|event| event["taskId"].as_str().unwrap().to_owned())
        .collect::<HashSet<_>>();
    let mut tasks = as_of(conn, date, project.as_deref())?
        .into_iter()
        .filter(|task| {
            happened.contains(task["id"].as_str().unwrap())
                || (active(task)
                    && ["plannedDate", "dueDate"]
                        .iter()
                        .any(|field| task[field].as_str().is_some_and(|value| value <= date)))
        })
        .collect::<Vec<_>>();
    tasks.sort_by_key(rank);
    let mut counts = json!({"todo":0,"in_progress":0,"blocked":0,"done":0,"cancelled":0});
    for task in &tasks {
        let status = task["status"].as_str().unwrap();
        counts[status] = json!(counts[status].as_u64().unwrap() + 1);
    }
    Ok(json!({"date":date,"tasks":tasks,"counts":counts}))
}

fn report_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(
        json!({"id":row.get::<_,String>(0)?,"date":row.get::<_,String>(1)?,"projectId":row.get::<_,Option<String>>(2)?,"version":row.get::<_,i64>(3)?,"edited":row.get::<_,bool>(4)?,"createdAt":row.get::<_,String>(5)?,"updatedAt":row.get::<_,String>(6)?,"content":row.get::<_,String>(7)?,"basis":decode_json(row.get(8)?)?}),
    )
}
pub(crate) fn get_report(conn: &Connection, id: &str) -> Result<Value> {
    conn.query_row(&format!("{REPORT_SELECT} WHERE id=?"), [id], report_row)
        .optional()?
        .ok_or_else(|| AppError::new("NOT_FOUND", "日报不存在"))
}
fn task_label(task: &Value) -> String {
    format!(
        "[{}] {}{}",
        if task["category"] == "action" {
            "执行"
        } else {
            "跟进"
        },
        task["title"].as_str().unwrap(),
        task["assignee"]
            .as_str()
            .map(|name| format!("（负责人：{name}）"))
            .unwrap_or_default()
    )
}
fn status_label(status: &str) -> &str {
    match status {
        "todo" => "待办",
        "in_progress" => "进行中",
        "blocked" => "阻塞",
        "done" => "完成",
        "cancelled" => "取消",
        other => other,
    }
}
fn render_report(date: &str, basis: &Value) -> String {
    render_report_template(date, basis, true)
}
fn render_report_template(date: &str, basis: &Value, localized_statuses: bool) -> String {
    let tasks = basis["tasks"].as_array().unwrap();
    let events = basis["events"].as_array().unwrap();
    let by_id = tasks
        .iter()
        .map(|task| (task["id"].as_str().unwrap(), task))
        .collect::<HashMap<_, _>>();
    let completed = events
        .iter()
        .filter(|event| {
            event["after"]["status"] == "done"
                && event["before"]["status"] != "done"
                && by_id
                    .get(event["taskId"].as_str().unwrap())
                    .is_some_and(|task| task["status"] == "done")
        })
        .map(|event| event["taskId"].as_str().unwrap())
        .collect::<HashSet<_>>();
    let mut completion = tasks
        .iter()
        .filter(|task| completed.contains(task["id"].as_str().unwrap()))
        .map(|task| format!("- {}", task_label(task)))
        .collect::<Vec<_>>();
    completion.sort();
    let progress = events
        .iter()
        .filter(|event| !completed.contains(event["taskId"].as_str().unwrap()))
        .map(|event| {
            format!(
                "- {}：{}（{}，{}%）",
                task_label(&event["after"]),
                event["note"].as_str().unwrap(),
                if localized_statuses {
                    status_label(event["after"]["status"].as_str().unwrap())
                } else {
                    event["after"]["status"].as_str().unwrap()
                },
                event["after"]["progress"]
            )
        })
        .collect::<Vec<_>>();
    let problems = tasks
        .iter()
        .filter(|task| {
            active(task)
                && (task["status"] == "blocked"
                    || task["dueDate"].as_str().is_some_and(|due| due < date))
        })
        .map(|task| {
            format!(
                "- {}：{}{}",
                task_label(task),
                if task["status"] == "blocked" {
                    "受阻"
                } else {
                    "未完成"
                },
                task["dueDate"]
                    .as_str()
                    .filter(|due| *due < date)
                    .map(|due| format!("，已逾期（{due}）"))
                    .unwrap_or_default()
            )
        })
        .collect::<Vec<_>>();
    let plans = tasks
        .iter()
        .filter(|task| {
            active(task)
                && ["plannedDate", "dueDate"]
                    .iter()
                    .any(|field| task[field].as_str().is_some_and(|value| value > date))
        })
        .map(|task| {
            format!(
                "- {}：计划 {}，交付期限 {}",
                task_label(task),
                task["plannedDate"].as_str().unwrap_or("未安排"),
                task["dueDate"].as_str().unwrap_or("未设置")
            )
        })
        .collect::<Vec<_>>();
    let section = |items: Vec<String>, empty: &str| {
        if items.is_empty() {
            empty.to_owned()
        } else {
            items.join("\n")
        }
    };
    format!("# {date} 工作日报\n\n{}## 完成事项\n{}\n\n## 推进与跟进\n{}\n\n## 阻塞与逾期\n{}\n\n## 后续安排\n基于该日已知计划，不代表未来成果。\n{}\n",if events.is_empty(){"当日没有记录到工作进展。以下风险和安排仅来自该日已知状态。\n\n"}else{""},section(completion,"当日没有最终保持完成状态的完成记录。"),section(progress,"当日没有其他进展记录。"),section(problems,"该日未记录阻塞或逾期。"),section(plans,"该日没有记录后续计划。"))
}
fn insert_report(
    conn: &Connection,
    date: &str,
    project: Option<&str>,
    edited: bool,
    content: &str,
    basis: &Value,
) -> Result<Value> {
    limited(content, 100000, true)?;
    let scope = project.unwrap_or("*");
    let version = conn.query_row(
        "SELECT coalesce(max(version),0)+1 FROM daily_reports WHERE date=? AND scope=?",
        params![date, scope],
        |row| row.get::<_, i64>(0),
    )?;
    let (id, at) = (id(), now());
    conn.execute(
        "INSERT INTO daily_reports VALUES (?,?,?,?,?,?,?,?,?,?)",
        params![
            id,
            date,
            scope,
            project,
            version,
            edited,
            at,
            at,
            content,
            basis.to_string()
        ],
    )?;
    get_report(conn, &id)
}
fn generate_report(conn: &Connection, p: &Value) -> Result<Value> {
    let date = required(p, "date")?;
    valid_date(date)?;
    let project = selected_project(conn, p)?;
    let basis = json!({"events":events_on(conn,date,project.as_deref())?,"tasks":as_of(conn,date,project.as_deref())?,"generatedAt":now()});
    insert_report(
        conn,
        date,
        project.as_deref(),
        false,
        &render_report(date, &basis),
        &basis,
    )
}
fn save_report(conn: &Connection, p: &Value) -> Result<Value> {
    let old = get_report(conn, required(p, "reportId")?)?;
    let content = required(p, "content")?;
    limited(content, 100000, true)?;
    let base = integer(p, "baseVersion")?;
    let date = old["date"].as_str().unwrap();
    let project = old["projectId"].as_str();
    let latest = conn.query_row(
        "SELECT max(version) FROM daily_reports WHERE date=? AND scope=?",
        params![date, project.unwrap_or("*")],
        |row| row.get::<_, i64>(0),
    )?;
    if old["version"].as_i64() != Some(base) || latest != base {
        return Err(AppError::new(
            "VERSION_CONFLICT",
            "日报已有新版本，请打开最新版本后保存",
        ));
    }
    insert_report(conn, date, project, true, content, &old["basis"])
}

fn mutate(
    conn: &mut Connection,
    command: &str,
    p: &Value,
    operation: fn(&Connection, &Value) -> Result<Value>,
) -> Result<Value> {
    let request = required(p, "clientRequestId")?;
    let request = uuid::Uuid::parse_str(request)
        .map_err(|_| failure("clientRequestId 必须是 UUID"))?
        .to_string();
    let fingerprint = hash(p.to_string().as_bytes());
    let tx = conn.transaction()?;
    if let Some((old_command, old_hash, response)) = tx
        .query_row(
            "SELECT command,payload_hash,response_json FROM operation_receipts WHERE request_id=?",
            [&request],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()?
    {
        if command != old_command || fingerprint != old_hash {
            return Err(AppError::new(
                "CONFLICT",
                "同一请求编号已用于不同操作或内容",
            ));
        }
        return serde_json::from_str(&response)
            .map_err(|_| AppError::new("DATABASE", "幂等记录损坏"));
    }
    let result = operation(&tx, p)?;
    tx.execute(
        "INSERT INTO operation_receipts VALUES (?,?,?,?,?)",
        params![request, command, fingerprint, result.to_string(), now()],
    )?;
    tx.commit()?;
    Ok(result)
}
pub(crate) fn dispatch(conn: &mut Connection, command: &str, p: &Value) -> Result<Value> {
    match command {
        "create_task" => mutate(conn, command, p, create),
        "update_task" => mutate(conn, command, p, update),
        "confirm_task_proposal" => mutate(conn, command, p, confirm_proposal),
        "generate_daily_report" => mutate(conn, command, p, generate_report),
        "save_daily_report" => mutate(conn, command, p, save_report),
        "get_task" => task_detail(conn, required(p, "taskId")?),
        "get_daily_list" => daily_list(conn, p),
        "get_daily_report" => get_report(conn, required(p, "reportId")?),
        "update_task_proposal" => edit_proposal(conn, p),
        "reject_task_proposal" => reject_proposal(conn, p),
        _ => Err(AppError::new("UNKNOWN_COMMAND", "未知操作")),
    }
}
pub(crate) fn state(conn: &Connection) -> Result<Value> {
    let mut statement = conn.prepare(TASK_SELECT)?;
    let tasks = statement
        .query_map([], task_row)?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut statement = conn.prepare("SELECT id FROM task_proposals ORDER BY created_at DESC")?;
    let ids = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let proposals = ids
        .iter()
        .map(|id| proposal(conn, id))
        .collect::<Result<Vec<_>>>()?;
    let mut statement=conn.prepare("SELECT id,date,project_id,version,edited,created_at,updated_at FROM daily_reports ORDER BY date DESC,version DESC")?;
    let reports=statement.query_map([],|row|Ok(json!({"id":row.get::<_,String>(0)?,"date":row.get::<_,String>(1)?,"projectId":row.get::<_,Option<String>>(2)?,"version":row.get::<_,i64>(3)?,"edited":row.get::<_,bool>(4)?,"createdAt":row.get::<_,String>(5)?,"updatedAt":row.get::<_,String>(6)?})))?.collect::<std::result::Result<Vec<_>,_>>()?;
    Ok(json!({"tasks":tasks,"taskProposals":proposals,"reports":reports}))
}

pub(crate) fn validate_snapshot(conn: &Connection, value: &Value) -> Result<()> {
    for key in [
        "id",
        "projectId",
        "title",
        "description",
        "category",
        "assignee",
        "priority",
        "status",
        "progress",
        "dueDate",
        "plannedDate",
        "version",
        "origin",
        "memoryId",
        "memoryRevision",
        "createdAt",
        "updatedAt",
    ] {
        if value.get(key).is_none() {
            return Err(failure("任务快照缺少必要字段"));
        }
    }
    validate_fields(value)?;
    project_exists(conn, required(value, "projectId")?)?;
    uuid::Uuid::parse_str(required(value, "id")?).map_err(|_| failure("任务 ID 无效"))?;
    if integer(value, "version")? < 1
        || !matches!(value["origin"].as_str(), Some("manual" | "memory" | "ai"))
    {
        return Err(failure("任务来源或版本无效"));
    }
    for field in ["createdAt", "updatedAt"] {
        chrono::DateTime::parse_from_rfc3339(required(value, field)?)
            .map_err(|_| failure("任务时间格式无效"))?;
    }
    if value["origin"] == "memory" {
        let memory = required(value, "memoryId")?;
        let revision = integer(value, "memoryRevision")?;
        if !conn.query_row("SELECT EXISTS(SELECT 1 FROM revisions r JOIN memories m ON m.id=r.memory_id WHERE m.id=? AND m.project_id=? AND r.number=?)",params![memory,value["projectId"].as_str(),revision],|row|row.get::<_,bool>(0))?{return Err(failure("任务记忆版本不属于项目"));}
    } else if !value["memoryId"].is_null() || !value["memoryRevision"].is_null() {
        return Err(failure("非记忆任务包含虚构记忆来源"));
    }
    Ok(())
}
fn validate_event_evidence(conn: &Connection, project: &str, values: &Value) -> Result<()> {
    let values = values
        .as_array()
        .ok_or_else(|| failure("事件证据应为数组"))?;
    let mut seen = HashSet::new();
    for item in values {
        let segment = required(item, "segmentId")?;
        if !seen.insert(segment) {
            return Err(failure("事件证据重复"));
        }
        let expected = evidence_for_segments(conn, project, &[segment.to_owned()])?.remove(0);
        for field in ["segmentId", "sourceId", "sourceTitle", "locator", "text"] {
            if item[field] != expected[field] {
                return Err(failure("事件证据与原文不符"));
            }
        }
        if let Some(quotes) = item.get("quotes") {
            let quotes = quotes.as_array().ok_or_else(|| failure("引文格式无效"))?;
            for quote in quotes {
                let quote = quote
                    .as_str()
                    .filter(|quote| !quote.trim().is_empty())
                    .ok_or_else(|| failure("引文为空"))?;
                if !expected["text"].as_str().unwrap().contains(quote) {
                    return Err(failure("事件引文不在原文中"));
                }
            }
        }
    }
    Ok(())
}
pub(crate) fn validate_backup(conn: &Connection) -> Result<()> {
    // Read actual SQLite values: declared TEXT affinity alone does not reject BLOB/invalid UTF-8.
    for(table,texts,optional,integers,nullable_ints) in [
        ("tasks","id,project_id,title,description,category,priority,status,origin,created_at,updated_at","assignee,due_date,planned_date,memory_id","progress,version","memory_revision"),
        ("task_evidence","task_id,segment_id","","",""),
        ("task_events","id,task_id,project_id,work_date,recorded_at,note,origin,after_json,evidence_json","before_json","version",""),
        ("task_proposals","id,project_id,source_id,title,description,task_status,status,quotes,model,provider,prompt_version,extraction_job_id,created_at,fingerprint","assignee,due_date,due_text,task_id","edited","progress"),
        ("task_proposal_evidence","proposal_id,segment_id","","",""),
        ("daily_reports","id,date,scope,created_at,updated_at,content,basis_json","project_id","version,edited",""),
        ("operation_receipts","request_id,command,payload_hash,response_json,created_at","","",""),
        ("jobs","","","task_candidate_count",""),
    ] {
        let fields=[texts,optional,integers,nullable_ints].map(|group|group.split(',').filter(|field|!field.is_empty()).collect::<Vec<_>>());let columns=fields.concat().join(",");let mut statement=conn.prepare(&format!("SELECT {columns} FROM {table}"))?;let mut rows=statement.query([])?;
        while let Some(row)=rows.next()?{let mut index=0;for _ in &fields[0]{row.get::<_,String>(index)?;index+=1;}for _ in &fields[1]{row.get::<_,Option<String>>(index)?;index+=1;}for _ in &fields[2]{if row.get::<_,i64>(index)?<0{return Err(failure("任务计数不能为负数"));}index+=1;}for _ in &fields[3]{if row.get::<_,Option<i64>>(index)?.is_some_and(|value|value<0){return Err(failure("可选任务计数不能为负数"));}index+=1;}}
    }
    let workflow = state(conn)?;
    for current in workflow["tasks"].as_array().unwrap() {
        validate_snapshot(conn, current)?;
        let detail = task_detail(conn, current["id"].as_str().unwrap())?;
        let events = detail["events"].as_array().unwrap();
        if events.len() as i64 != integer(current, "version")? {
            return Err(failure("任务版本与事件数量不一致"));
        }
        let (mut previous, mut last_date) = (Value::Null, String::new());
        for (offset, item) in events.iter().rev().enumerate() {
            let date = required(item, "workDate")?;
            valid_date(date)?;
            if date < last_date.as_str() {
                return Err(failure("任务历史日期逆序"));
            }
            last_date = date.into();
            if integer(item, "version")? != offset as i64 + 1
                || item["before"] != previous
                || item["after"]["version"] != item["version"]
                || item["taskId"] != current["id"]
                || item["projectId"] != current["projectId"]
                || item["after"]["id"] != current["id"]
                || item["after"]["projectId"] != current["projectId"]
            {
                return Err(failure("任务事件链或项目不一致"));
            }
            validate_snapshot(conn, &item["after"])?;
            limited(required(item, "note")?, 22000, true)?;
            if !previous.is_null() {
                for key in [
                    "id",
                    "projectId",
                    "origin",
                    "memoryId",
                    "memoryRevision",
                    "createdAt",
                ] {
                    if item["after"][key] != previous[key] {
                        return Err(failure("任务历史更改了不可变来源"));
                    }
                }
            }
            if !matches!(item["origin"].as_str(), Some("user" | "memory" | "ai")) {
                return Err(failure("任务事件来源无效"));
            }
            if item["origin"] == "user" && !item["evidence"].as_array().is_some_and(Vec::is_empty) {
                return Err(failure("用户更新不能继承原文证据"));
            }
            validate_event_evidence(
                conn,
                current["projectId"].as_str().unwrap(),
                &item["evidence"],
            )?;
            if item["origin"] == "ai" && item["evidence"].as_array().unwrap().is_empty() {
                return Err(failure("AI 事件缺少证据"));
            }
            if item["recordedAt"] != item["after"]["updatedAt"] {
                return Err(failure("事件审计时间不一致"));
            }
            previous = item["after"].clone();
        }
        if previous != *current {
            return Err(failure("任务当前状态与最新事件不一致"));
        }
        validate_event_evidence(
            conn,
            current["projectId"].as_str().unwrap(),
            &detail["evidence"],
        )?;
        let first = events.last().unwrap();
        let ids = |value: &Value| {
            value
                .as_array()
                .unwrap()
                .iter()
                .map(|item| item["segmentId"].as_str().unwrap().to_owned())
                .collect::<HashSet<_>>()
        };
        if ids(&detail["evidence"]) != ids(&first["evidence"]) {
            return Err(failure("任务初始证据不一致"));
        }
        if current["origin"] == "memory" {
            let mut statement=conn.prepare("SELECT e.segment_id FROM revision_evidence e JOIN revisions r ON r.id=e.revision_id WHERE r.memory_id=? AND r.number=?")?;
            let expected = statement
                .query_map(
                    params![
                        current["memoryId"].as_str(),
                        current["memoryRevision"].as_i64()
                    ],
                    |row| row.get::<_, String>(0),
                )?
                .collect::<std::result::Result<HashSet<_>, _>>()?;
            if expected != ids(&first["evidence"]) {
                return Err(failure("记忆任务证据不属于所记录的记忆版本"));
            }
        }
    }
    for candidate in workflow["taskProposals"].as_array().unwrap() {
        validate_proposal(candidate)?;
        let source = required(candidate, "sourceId")?;
        let project = required(candidate, "projectId")?;
        if !conn.query_row("SELECT EXISTS(SELECT 1 FROM sources s JOIN jobs j ON j.source_id=s.id WHERE s.id=? AND s.project_id=? AND j.id=? AND j.kind='extract' AND j.status='succeeded' AND j.provider=? AND j.model=? AND j.prompt_version=?)",params![source,project,candidate["extractionJobId"].as_str(),candidate["provider"].as_str(),candidate["model"].as_str(),candidate["promptVersion"].as_str()],|row|row.get::<_,bool>(0))?{return Err(failure("任务提议模型来源或项目不一致"));}
        let quotes = candidate["quotes"]
            .as_array()
            .ok_or_else(|| failure("任务提议引文格式无效"))?;
        if quotes.is_empty() {
            return Err(failure("任务提议缺少引文"));
        }
        let segments = candidate["segmentIds"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item.as_str().unwrap().to_owned())
            .collect::<HashSet<_>>();
        let mut quoted = HashSet::new();
        for item in quotes {
            let segment = required(item, "segmentId")?;
            let quote = required(item, "quote")?;
            let raw = evidence_for_segments(conn, project, &[segment.to_owned()])?.remove(0);
            if raw["sourceId"] != source
                || !segments.contains(segment)
                || !raw["text"].as_str().unwrap().contains(quote)
            {
                return Err(failure("任务提议引文跨项目或与原文不符"));
            }
            quoted.insert(segment.to_owned());
        }
        if segments != quoted {
            return Err(failure("任务提议证据与引文不一致"));
        }
        if candidate["edited"] == false {
            let raw = ai::AiTaskCandidate {
                title: required(candidate, "title")?.into(),
                description: candidate["description"].as_str().unwrap().into(),
                assignee: optional_string(candidate, "assignee")?,
                due_date: optional_date(candidate, "dueDate")?,
                due_text: optional_string(candidate, "dueText")?,
                status: required(candidate, "taskStatus")?.into(),
                progress: candidate["progress"].as_u64().map(|value| value as u8),
                evidence: quotes
                    .iter()
                    .map(|item| {
                        Ok(ai::CandidateEvidence {
                            segment_id: required(item, "segmentId")?.into(),
                            quote: required(item, "quote")?.into(),
                        })
                    })
                    .collect::<Result<Vec<_>>>()?,
            };
            if ground_candidates(conn, source, project, vec![raw])?
                .0
                .is_empty()
            {
                return Err(failure("未编辑 AI 任务字段没有明确引文依据"));
            }
        }
        if candidate["status"] == "confirmed" {
            if task(conn, required(candidate, "taskId")?)?["projectId"] != project {
                return Err(failure("确认任务提议跨项目"));
            }
        } else if !matches!(candidate["status"].as_str(), Some("pending" | "rejected"))
            || !candidate["taskId"].is_null()
        {
            return Err(failure("任务提议确认状态无效"));
        }
    }
    let invalid:i64=conn.query_row("SELECT count(*) FROM jobs j WHERE task_candidate_count<>(SELECT count(*) FROM task_proposals p WHERE p.extraction_job_id=j.id)",[],|row|row.get(0))?;
    if invalid != 0 {
        return Err(failure("任务候选计数不一致"));
    }
    for table in ["task_proposals", "daily_reports"] {
        let invalid: i64 = conn.query_row(
            &format!("SELECT count(*) FROM {table} WHERE edited NOT IN (0,1)"),
            [],
            |row| row.get(0),
        )?;
        if invalid != 0 {
            return Err(failure("编辑标记不是布尔值"));
        }
    }
    let mut statement = conn.prepare(REPORT_SELECT)?;
    let reports = statement
        .query_map([], report_row)?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    for report in reports {
        let date = required(&report, "date")?;
        valid_date(date)?;
        let project = report["projectId"].as_str();
        if let Some(project) = project {
            project_exists(conn, project)?;
        }
        let scope: String = conn.query_row(
            "SELECT scope FROM daily_reports WHERE id=?",
            [required(&report, "id")?],
            |row| row.get(0),
        )?;
        if scope != project.unwrap_or("*") {
            return Err(failure("日报范围不一致"));
        }
        if integer(&report, "version")? < 1 {
            return Err(failure("日报版本无效"));
        }
        limited(required(&report, "content")?, 100000, true)?;
        let basis = &report["basis"];
        chrono::DateTime::parse_from_rfc3339(required(basis, "generatedAt")?)
            .map_err(|_| failure("日报依据时间无效"))?;
        let basis_events = basis["events"]
            .as_array()
            .ok_or_else(|| failure("日报事件依据无效"))?;
        let mut seen = HashSet::new();
        for item in basis_events {
            let id = required(item, "id")?;
            if !seen.insert(id)
                || item["workDate"] != date
                || project.is_some_and(|project| item["projectId"] != project)
                || event(conn, id)? != *item
            {
                return Err(failure("日报事件与冻结依据不一致"));
            }
        }
        let stored = basis["tasks"]
            .as_array()
            .ok_or_else(|| failure("日报任务依据无效"))?;
        // Later same-day entries can be recorded after generation. Each frozen snapshot must be a real as-of version, not necessarily the latest newly backfilled one.
        let mut seen = HashSet::new();
        for item in stored {
            validate_snapshot(conn, item)?;
            if !seen.insert(required(item, "id")?)
                || project.is_some_and(|project| item["projectId"] != project)
            {
                return Err(failure("日报任务范围无效"));
            }
            let raw = conn.query_row(
                "SELECT after_json FROM task_events WHERE task_id=? AND version=? AND work_date<=?",
                params![item["id"].as_str(), item["version"].as_i64(), date],
                |row| decode_json(row.get(0)?),
            )?;
            if raw != *item {
                return Err(failure("日报任务快照无效"));
            }
        }
        if report["edited"] == false
            && required(&report, "content")? != render_report(date, basis)
            && required(&report, "content")? != render_report_template(date, basis, false)
        {
            return Err(failure("未编辑日报正文与冻结依据不一致"));
        }
    }
    let invalid:i64=conn.query_row("SELECT count(*) FROM (SELECT date,scope,min(version) first,max(version) last,count(*) total FROM daily_reports GROUP BY date,scope) WHERE first<>1 OR last<>total",[],|row|row.get(0))?;
    if invalid != 0 {
        return Err(failure("日报版本历史不连续"));
    }
    let mut statement = conn.prepare(
        "SELECT request_id,command,payload_hash,response_json,created_at FROM operation_receipts",
    )?;
    for row in statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
        ))
    })? {
        let (request, command, digest, response, at) = row?;
        uuid::Uuid::parse_str(&request).map_err(|_| failure("幂等请求 ID 无效"))?;
        if digest.len() != 64 || !digest.chars().all(|char| char.is_ascii_hexdigit()) {
            return Err(failure("幂等请求哈希无效"));
        }
        chrono::DateTime::parse_from_rfc3339(&at).map_err(|_| failure("幂等记录时间无效"))?;
        let value: Value = serde_json::from_str(&response).map_err(|_| failure("幂等响应无效"))?;
        match command.as_str() {
            "create_task" | "update_task" | "confirm_task_proposal" => {
                validate_snapshot(conn, &value)?;
                let raw = conn.query_row(
                    "SELECT after_json FROM task_events WHERE task_id=? AND version=?",
                    params![value["id"].as_str(), value["version"].as_i64()],
                    |row| decode_json(row.get(0)?),
                )?;
                if raw != value {
                    return Err(failure("幂等任务响应与历史不一致"));
                }
            }
            "generate_daily_report" | "save_daily_report" => {
                if get_report(conn, required(&value, "id")?)? != value {
                    return Err(failure("幂等日报响应不一致"));
                }
            }
            _ => return Err(failure("幂等操作类型无效")),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn setup() -> (Connection, String) {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate(&conn).unwrap();
        let project = id();
        conn.execute(
            "INSERT INTO projects VALUES (?,?,'',?)",
            params![project, "任务验收", now()],
        )
        .unwrap();
        (conn, project)
    }
    fn create_input(project: &str, title: &str, date: &str) -> Value {
        json!({"projectId":project,"title":title,"description":"","category":"action","assignee":null,"priority":"high","status":"todo","progress":0,"dueDate":null,"plannedDate":date,"workDate":date,"clientRequestId":id()})
    }
    fn update_input(task: &Value, date: &str, status: &str, progress: i64) -> Value {
        let mut p = task.clone();
        p["taskId"] = task["id"].clone();
        p["baseVersion"] = task["version"].clone();
        p["status"] = json!(status);
        p["progress"] = json!(progress);
        p["note"] = json!("确认实际进展");
        p["workDate"] = json!(date);
        p["clientRequestId"] = json!(id());
        p
    }
    #[test]
    fn idempotency_conflicts_and_out_of_order_changes_do_not_create_events() {
        let (mut conn, project) = setup();
        let p = create_input(&project, "执行任务", "2026-10-18");
        let task = dispatch(&mut conn, "create_task", &p).unwrap();
        assert_eq!(dispatch(&mut conn, "create_task", &p).unwrap(), task);
        let mut changed = p.clone();
        changed["title"] = json!("另一件事");
        assert_eq!(
            dispatch(&mut conn, "create_task", &changed)
                .unwrap_err()
                .code,
            "CONFLICT"
        );
        let update = update_input(&task, "2026-10-19", "in_progress", 50);
        let next = dispatch(&mut conn, "update_task", &update).unwrap();
        assert_eq!(dispatch(&mut conn, "update_task", &update).unwrap(), next);
        let older = update_input(&next, "2026-10-18", "done", 100);
        assert_eq!(
            dispatch(&mut conn, "update_task", &older).unwrap_err().code,
            "WORK_DATE_ORDER"
        );
        assert_eq!(
            task_detail(&conn, task["id"].as_str().unwrap()).unwrap()["events"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        validate_backup(&conn).unwrap();
    }
    #[test]
    fn historical_reports_use_event_snapshots_and_same_day_reopen_is_not_completion() {
        let (mut conn, project) = setup();
        let task = dispatch(
            &mut conn,
            "create_task",
            &create_input(&project, "昨日原始标题", "2026-10-18"),
        )
        .unwrap();
        let done = dispatch(
            &mut conn,
            "update_task",
            &update_input(&task, "2026-10-18", "done", 100),
        )
        .unwrap();
        let first = dispatch(
            &mut conn,
            "generate_daily_report",
            &json!({"date":"2026-10-18","clientRequestId":id()}),
        )
        .unwrap();
        let mut next = update_input(&done, "2026-10-19", "todo", 0);
        next["title"] = json!("次日新标题");
        dispatch(&mut conn, "update_task", &next).unwrap();
        let historical = dispatch(
            &mut conn,
            "generate_daily_report",
            &json!({"date":"2026-10-18","clientRequestId":id()}),
        )
        .unwrap();
        assert!(historical["content"]
            .as_str()
            .unwrap()
            .contains("昨日原始标题"));
        assert!(!historical["content"]
            .as_str()
            .unwrap()
            .contains("次日新标题"));
        assert_eq!(
            first["basis"],
            historical["basis"]
                .as_object()
                .map(|_| {
                    let mut v = historical["basis"].clone();
                    v["generatedAt"] = first["basis"]["generatedAt"].clone();
                    v
                })
                .unwrap()
        );
        let task = dispatch(
            &mut conn,
            "create_task",
            &create_input(&project, "当天重开任务", "2026-10-18"),
        )
        .unwrap();
        let done = dispatch(
            &mut conn,
            "update_task",
            &update_input(&task, "2026-10-18", "done", 100),
        )
        .unwrap();
        dispatch(
            &mut conn,
            "update_task",
            &update_input(&done, "2026-10-18", "in_progress", 80),
        )
        .unwrap();
        let report = dispatch(
            &mut conn,
            "generate_daily_report",
            &json!({"date":"2026-10-18","clientRequestId":id()}),
        )
        .unwrap();
        let section = report["content"]
            .as_str()
            .unwrap()
            .split("## 推进与跟进")
            .next()
            .unwrap();
        assert!(!section.contains("当天重开任务"));
        assert!(report["content"]
            .as_str()
            .unwrap()
            .contains("（进行中，80%）"));
        assert!(!report["content"].as_str().unwrap().contains("in_progress"));
        assert_eq!(
            get_report(&conn, first["id"].as_str().unwrap()).unwrap(),
            first
        );
        validate_backup(&conn).unwrap();
        // Existing v3 drafts retain their old status wording and remain valid backup content.
        let mut legacy = report.clone();
        legacy["content"] = json!(render_report_template(
            "2026-10-18",
            &report["basis"],
            false
        ));
        conn.execute(
            "UPDATE daily_reports SET content=? WHERE id=?",
            params![legacy["content"].as_str(), legacy["id"].as_str()],
        )
        .unwrap();
        conn.execute(
            "UPDATE operation_receipts SET response_json=? WHERE response_json=?",
            params![legacy.to_string(), report.to_string()],
        )
        .unwrap();
        validate_backup(&conn).unwrap();
    }
    #[test]
    fn unscheduled_completed_and_historical_lists_have_separate_rules() {
        let (mut conn, project) = setup();
        let mut p = create_input(&project, "未安排任务", "2026-10-18");
        p["plannedDate"] = Value::Null;
        let task = dispatch(&mut conn, "create_task", &p).unwrap();
        assert_eq!(
            dispatch(&mut conn, "get_daily_list", &json!({"date":"2026-10-19"})).unwrap()["tasks"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
        let mut update = update_input(&task, "2026-10-19", "done", 100);
        update["plannedDate"] = json!("2026-10-19");
        dispatch(&mut conn, "update_task", &update).unwrap();
        assert_eq!(
            dispatch(&mut conn, "get_daily_list", &json!({"date":"2026-10-19"})).unwrap()["counts"]
                ["done"],
            1
        );
        assert_eq!(
            dispatch(&mut conn, "get_daily_list", &json!({"date":"2026-10-20"})).unwrap()["tasks"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
        let report = dispatch(
            &mut conn,
            "generate_daily_report",
            &json!({"date":"2026-10-20","clientRequestId":id()}),
        )
        .unwrap();
        assert!(report["content"]
            .as_str()
            .unwrap()
            .contains("没有记录到工作进展"));
        assert!(!report["content"].as_str().unwrap().contains("未安排任务"));
    }
    #[test]
    fn user_report_edits_are_new_versions_and_old_versions_are_frozen() {
        let (mut conn, _) = setup();
        let request = json!({"date":"2026-10-19","clientRequestId":id()});
        let first = dispatch(&mut conn, "generate_daily_report", &request).unwrap();
        let edit = json!({"reportId":first["id"],"baseVersion":1,"content":"用户补充的日报","clientRequestId":id()});
        let saved = dispatch(&mut conn, "save_daily_report", &edit).unwrap();
        assert_eq!(saved["version"], 2);
        assert_eq!(
            dispatch(&mut conn, "save_daily_report", &edit).unwrap(),
            saved
        );
        assert_eq!(
            dispatch(&mut conn, "generate_daily_report", &request).unwrap(),
            first
        );
        let mut stale = edit;
        stale["clientRequestId"] = json!(id());
        assert_eq!(
            dispatch(&mut conn, "save_daily_report", &stale)
                .unwrap_err()
                .code,
            "VERSION_CONFLICT"
        );
        assert_eq!(
            get_report(&conn, first["id"].as_str().unwrap()).unwrap(),
            first
        );
        validate_backup(&conn).unwrap();
    }
    #[test]
    fn memory_creation_evidence_cannot_be_replaced_with_another_segment_in_the_same_project() {
        let (mut conn, project) = setup();
        let source = id();
        let a = id();
        let b = id();
        let memory = id();
        let revision = id();
        let at = now();
        conn.execute(
            "INSERT INTO sources VALUES (?,?,?,'txt','memory.txt',NULL,?,?,'ready',2,NULL,?)",
            params![
                source,
                project,
                "记忆证据",
                at,
                hash(b"original"),
                format!("originals/{source}.txt")
            ],
        )
        .unwrap();
        for (segment, ordinal, text) in [(&a, 0, "正确的记忆依据"), (&b, 1, "同项目另一段内容")]
        {
            conn.execute(
                "INSERT INTO segments VALUES (?,?,?,?,?,?)",
                params![
                    segment,
                    source,
                    format!("{source}:v1"),
                    ordinal,
                    "段落",
                    text
                ],
            )
            .unwrap();
        }
        conn.execute(
            "INSERT INTO memories VALUES (?,?,'fact','已确认事实',1,'active','记忆证据',?,?)",
            params![memory, project, at, at],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO revisions VALUES (?,?,1,'已确认事实','确认','confirmation',?)",
            params![revision, memory, at],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO revision_evidence VALUES (?,?)",
            params![revision, a],
        )
        .unwrap();
        let mut p = create_input(&project, "从记忆转任务", "2026-10-19");
        p["memoryId"] = json!(memory);
        let created = dispatch(&mut conn, "create_task", &p).unwrap();
        validate_backup(&conn).unwrap();
        conn.execute(
            "UPDATE task_evidence SET segment_id=? WHERE task_id=?",
            params![b, created["id"].as_str()],
        )
        .unwrap();
        let wrong = evidence_for_segments(&conn, &project, &[b]).unwrap();
        conn.execute(
            "UPDATE task_events SET evidence_json=? WHERE task_id=?",
            params![json!(wrong).to_string(), created["id"].as_str()],
        )
        .unwrap();
        assert!(validate_backup(&conn).is_err());
    }
    #[test]
    fn unedited_task_proposal_fields_must_still_be_grounded_after_backup_loading() {
        let (conn, project) = setup();
        let source = id();
        let segment = id();
        let job = id();
        let at = now();
        let text = "接口联调正在进行，李工负责，进度60%，截止2026年10月21日。";
        conn.execute(
            "INSERT INTO sources VALUES (?,?,?,'txt','task.txt',NULL,?,?,'ready',1,NULL,?)",
            params![
                source,
                project,
                "进展原文",
                at,
                hash(text.as_bytes()),
                format!("originals/{source}.txt")
            ],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO segments VALUES (?,?,?,0,'第1行',?)",
            params![segment, source, format!("{source}:v1"), text],
        )
        .unwrap();
        conn.execute("INSERT INTO jobs (id,kind,status,stage,source_id,created_at,updated_at,recovered,provider,model,prompt_version,input_hash,source_hash,config_revision) VALUES (?,'extract','succeeded','完成',?,?,?,0,'ollama','fixture',?,?,?,?)",params![job,source,at,at,ai::PROMPT_VERSION,hash(text.as_bytes()),hash(text.as_bytes()),id()]).unwrap();
        let candidate = ai::AiTaskCandidate {
            title: "接口联调".into(),
            description: "进行中".into(),
            assignee: Some("李工".into()),
            due_date: Some("2026-10-21".into()),
            due_text: Some("2026年10月21日".into()),
            status: "in_progress".into(),
            progress: Some(60),
            evidence: vec![ai::CandidateEvidence {
                segment_id: segment,
                quote: text.into(),
            }],
        };
        assert!(
            ground_candidates(&conn, &source, &project, vec![candidate.clone()])
                .unwrap()
                .1
                == 0
        );
        insert_candidates(
            &conn,
            AiOrigin {
                source: &source,
                project: &project,
                job: &job,
                provider: "ollama",
                model: "fixture",
                prompt: ai::PROMPT_VERSION,
            },
            vec![candidate],
        )
        .unwrap();
        conn.execute("UPDATE jobs SET task_candidate_count=1 WHERE id=?", [job])
            .unwrap();
        validate_backup(&conn).unwrap();
        conn.execute("UPDATE task_proposals SET assignee='王工'", [])
            .unwrap();
        assert!(validate_backup(&conn).is_err());
        conn.execute("UPDATE task_proposals SET edited=1", [])
            .unwrap();
        validate_backup(&conn).unwrap();
    }
    #[test]
    fn backup_validation_rejects_bad_storage_types_and_a_broken_current_snapshot() {
        let (mut conn, project) = setup();
        let task = dispatch(
            &mut conn,
            "create_task",
            &create_input(&project, "类型与领域校验", "2026-10-19"),
        )
        .unwrap();
        validate_backup(&conn).unwrap();
        conn.execute(
            "UPDATE tasks SET title=x'00ff' WHERE id=?",
            [task["id"].as_str().unwrap()],
        )
        .unwrap();
        assert!(validate_backup(&conn).is_err());
        conn.execute(
            "UPDATE tasks SET title='类型与领域校验',progress=100 WHERE id=?",
            [task["id"].as_str().unwrap()],
        )
        .unwrap();
        assert!(validate_backup(&conn).is_err());
    }
}
