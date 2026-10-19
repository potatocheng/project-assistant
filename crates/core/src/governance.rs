//! Local risk, issue and decision registers with an append-only audit history.
use crate::{id, now, required, tasks, AppError, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::HashSet;

pub(crate) fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch(r#"
CREATE TABLE governance_items(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),kind TEXT NOT NULL,title TEXT NOT NULL,description TEXT NOT NULL,owner TEXT NOT NULL,severity TEXT NOT NULL,impact TEXT NOT NULL,response_plan TEXT NOT NULL,due_date TEXT,review_date TEXT,escalation_to TEXT NOT NULL,status TEXT NOT NULL,decision_maker TEXT NOT NULL,conclusion TEXT NOT NULL,resolution TEXT NOT NULL,closure_reason TEXT NOT NULL,links_json TEXT NOT NULL,evidence_json TEXT NOT NULL,version INTEGER NOT NULL,work_date TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE governance_revisions(id TEXT PRIMARY KEY,item_id TEXT NOT NULL REFERENCES governance_items(id),project_id TEXT NOT NULL REFERENCES projects(id),version INTEGER NOT NULL,event_type TEXT NOT NULL,work_date TEXT NOT NULL,note TEXT NOT NULL,recorded_at TEXT NOT NULL,snapshot_json TEXT NOT NULL,UNIQUE(item_id,version));
CREATE INDEX governance_project_status ON governance_items(project_id,status);
CREATE INDEX governance_history ON governance_revisions(item_id,version);
"#)?;
    Ok(())
}

fn invalid(message: &str) -> AppError {
    AppError::new("VALIDATION", message)
}
fn conflict() -> AppError {
    AppError::new("VERSION_CONFLICT", "事项已更新，请重新打开详情后重试")
}
fn text(p: &Value, key: &str, limit: usize, needed: bool) -> Result<String> {
    let value = p[key]
        .as_str()
        .ok_or_else(|| invalid(&format!("{key} 必须为文字")))?
        .trim();
    if value.chars().count() > limit || (needed && value.is_empty()) {
        return Err(invalid(&format!("{key} 为空或超过长度限制")));
    }
    Ok(value.into())
}
fn optional(p: &Value, key: &str) -> Result<Option<String>> {
    match p.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(v)) if v.trim().is_empty() => Ok(None),
        Some(Value::String(v)) if v.chars().count() <= 300 => Ok(Some(v.trim().into())),
        _ => Err(invalid(&format!("{key} 必须为文字或空值"))),
    }
}
fn optional_date(p: &Value, key: &str) -> Result<Option<String>> {
    let value = optional(p, key)?;
    if let Some(v) = &value {
        tasks::valid_date(v)?;
    }
    Ok(value)
}
fn positive(p: &Value, key: &str) -> Result<i64> {
    p[key]
        .as_i64()
        .filter(|v| *v > 0)
        .ok_or_else(|| invalid("版本必须为正整数"))
}
fn project_exists(conn: &Connection, project: &str) -> Result<()> {
    if !conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM projects WHERE id=?)",
        [project],
        |r| r.get::<_, bool>(0),
    )? {
        return Err(AppError::new("NOT_FOUND", "项目不存在"));
    }
    Ok(())
}
fn string_ids(p: &Value, key: &str) -> Result<Vec<String>> {
    let values = p[key]
        .as_array()
        .filter(|v| v.len() <= 500)
        .ok_or_else(|| invalid("依据必须为数组，最多 500 条"))?;
    let mut seen = HashSet::new();
    values
        .iter()
        .map(|v| {
            let key = v
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or_else(|| invalid("依据 ID 无效"))?;
            if !seen.insert(key) {
                return Err(invalid("依据不能重复"));
            }
            Ok(key.into())
        })
        .collect()
}
fn validate_fields(p: &Value) -> Result<()> {
    for (key, limit, needed) in [
        ("title", 300, true),
        ("description", 10000, false),
        ("owner", 300, true),
        ("impact", 10000, true),
        ("responsePlan", 10000, true),
        ("escalationTo", 300, false),
        ("decisionMaker", 300, false),
        ("conclusion", 10000, false),
        ("resolution", 10000, false),
        ("closureReason", 10000, false),
    ] {
        text(p, key, limit, needed)?;
    }
    if !matches!(p["kind"].as_str(), Some("risk" | "issue" | "decision"))
        || !matches!(p["severity"].as_str(), Some("high" | "medium" | "low"))
        || !matches!(
            p["status"].as_str(),
            Some("open" | "in_progress" | "escalated" | "closed")
        )
    {
        return Err(invalid("事项类型、级别或状态无效"));
    }
    optional_date(p, "dueDate")?;
    optional_date(p, "reviewDate")?;
    tasks::valid_date(required(p, "workDate")?)?;
    if p["status"] == "escalated" && text(p, "escalationTo", 300, true).is_err() {
        return Err(invalid("升级时需要填写升级对象"));
    }
    if p["status"] == "closed" {
        text(p, "closureReason", 10000, true).map_err(|_| invalid("关闭时必须填写关闭原因"))?;
        text(p, "resolution", 10000, true).map_err(|_| invalid("关闭时必须填写处理结果"))?;
        if p["kind"] == "decision" {
            text(p, "decisionMaker", 300, true).map_err(|_| invalid("决策关闭前必须填写拍板人"))?;
            text(p, "conclusion", 10000, true)
                .map_err(|_| invalid("决策关闭前必须填写决策结论"))?;
        }
    }
    string_ids(p, "evidenceIds")?;
    links(p)?;
    Ok(())
}
fn links(p: &Value) -> Result<Vec<Value>> {
    let values = p["links"]
        .as_array()
        .filter(|v| v.len() <= 500)
        .ok_or_else(|| invalid("关联必须为数组，最多 500 条"))?;
    let mut seen = HashSet::new();
    for link in values {
        if !matches!(link["kind"].as_str(), Some("task" | "milestone" | "memory")) {
            return Err(invalid("关联类型无效"));
        }
        let key = text(link, "id", 300, true)?;
        positive(link, "version")?;
        if !seen.insert(format!("{}:{key}", required(link, "kind")?)) {
            return Err(invalid("关联不能重复"));
        }
    }
    Ok(values.clone())
}
fn reference(conn: &Connection, link: &Value) -> Result<(String, i64)> {
    let query = match required(link, "kind")? {
        "task" => "SELECT project_id,version FROM tasks WHERE id=?",
        "milestone" => "SELECT project_id,version FROM milestones WHERE id=?",
        "memory" => "SELECT project_id,revision FROM memories WHERE id=? AND state='active'",
        _ => return Err(invalid("关联类型无效")),
    };
    conn.query_row(query, [required(link, "id")?], |r| {
        Ok((r.get(0)?, r.get(1)?))
    })
    .optional()?
    .ok_or_else(|| AppError::new("NOT_FOUND", "关联事项不存在或记忆未确认"))
}
fn validate_links(conn: &Connection, p: &Value, current: bool) -> Result<()> {
    let project = required(p, "projectId")?;
    for link in links(p)? {
        let (scope, version) = reference(conn, &link)?;
        if scope != project {
            return Err(AppError::new(
                "PROJECT_SCOPE",
                "只能关联同一项目的任务、里程碑与记忆",
            ));
        }
        let saved = positive(&link, "version")?;
        if (current && saved != version) || saved > version {
            return Err(AppError::new(
                "REFERENCE_STALE",
                "关联版本已更新，请重新选择当前版本",
            ));
        }
        if link["kind"] == "memory"
            && !conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM revisions WHERE memory_id=? AND number=?)",
                params![required(&link, "id")?, saved],
                |r| r.get::<_, bool>(0),
            )?
        {
            return Err(invalid("关联记忆修订不存在"));
        }
    }
    evidence(conn, project, &string_ids(p, "evidenceIds")?)?;
    Ok(())
}
fn evidence(conn: &Connection, project: &str, ids: &[String]) -> Result<Vec<Value>> {
    ids.iter().map(|key| conn.query_row("SELECT g.id,s.id,s.title,g.locator,g.text FROM segments g JOIN sources s ON s.id=g.source_id WHERE g.id=? AND s.project_id=? AND s.status='ready'",params![key,project],|r|Ok(json!({"segmentId":r.get::<_,String>(0)?,"sourceId":r.get::<_,String>(1)?,"sourceTitle":r.get::<_,String>(2)?,"locator":r.get::<_,String>(3)?,"text":r.get::<_,String>(4)?}))).optional()?.ok_or_else(||AppError::new("EVIDENCE_SCOPE","原文依据不存在、尚未就绪或不属于该项目"))).collect()
}
const SELECT: &str = "SELECT json_object('id',id,'projectId',project_id,'kind',kind,'title',title,'description',description,'owner',owner,'severity',severity,'impact',impact,'responsePlan',response_plan,'dueDate',due_date,'reviewDate',review_date,'escalationTo',escalation_to,'status',status,'decisionMaker',decision_maker,'conclusion',conclusion,'resolution',resolution,'closureReason',closure_reason,'links',json(links_json),'evidenceIds',json(evidence_json),'version',version,'workDate',work_date,'createdAt',created_at,'updatedAt',updated_at) FROM governance_items";
fn parse_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let raw: String = r.get(0)?;
    serde_json::from_str(&raw).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })
}
fn item(conn: &Connection, key: &str) -> Result<Value> {
    conn.query_row(&format!("{SELECT} WHERE id=?"), [key], parse_row)
        .optional()?
        .ok_or_else(|| AppError::new("NOT_FOUND", "事项不存在"))
}
fn revisions(conn: &Connection, key: &str) -> Result<Vec<Value>> {
    let mut stmt = conn.prepare("SELECT json_object('id',id,'itemId',item_id,'projectId',project_id,'version',version,'eventType',event_type,'workDate',work_date,'note',note,'recordedAt',recorded_at,'snapshot',json(snapshot_json)) FROM governance_revisions WHERE item_id=? ORDER BY version")?;
    let values = stmt
        .query_map([key], parse_row)?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(values)
}
fn detail(conn: &Connection, p: &Value) -> Result<Value> {
    let value = item(conn, required(p, "itemId")?)?;
    Ok(
        json!({"item":value,"revisions":revisions(conn,required(&value,"id")?)?,"evidence":evidence(conn,required(&value,"projectId")?,&string_ids(&value,"evidenceIds")?)?}),
    )
}
fn append(conn: &Connection, value: &Value, event: &str, p: &Value) -> Result<()> {
    conn.execute(
        "INSERT INTO governance_revisions VALUES(?,?,?,?,?,?,?,?,?)",
        params![
            id(),
            required(value, "id")?,
            required(value, "projectId")?,
            positive(value, "version")?,
            event,
            required(value, "workDate")?,
            text(p, "note", 10000, true)?,
            required(value, "updatedAt")?,
            value.to_string()
        ],
    )?;
    Ok(())
}
fn save(conn: &Connection, p: &Value) -> Result<Value> {
    let project = text(p, "projectId", 300, true)?;
    project_exists(conn, &project)?;
    validate_fields(p)?;
    validate_links(conn, p, true)?;
    text(p, "note", 10000, true)?;
    let mut value = p.clone();
    let (key, version, created, event) = if let Some(key) = optional(p, "itemId")? {
        let before = item(conn, &key)?;
        if before["projectId"] != project || before["kind"] != p["kind"] {
            return Err(AppError::new("PROJECT_SCOPE", "已建事项不能变更项目或类型"));
        }
        let base = positive(p, "baseVersion")?;
        if before["version"].as_i64() != Some(base) {
            return Err(conflict());
        }
        if required(p, "workDate")? < required(&before, "workDate")? {
            return Err(invalid("记录日期不能早于上次进展日期"));
        }
        if before["status"] == "closed" && p["status"] == "closed" {
            return Err(invalid("已关闭事项需要先重新打开，才能修改"));
        }
        let event = if before["status"] == "closed" {
            "reopened"
        } else if p["status"] == "closed" {
            "closed"
        } else {
            "updated"
        };
        (
            key,
            base + 1,
            required(&before, "createdAt")?.to_owned(),
            event,
        )
    } else {
        (id(), 1, now(), "created")
    };
    for (field, limit, needed) in [
        ("title", 300, true),
        ("description", 10000, false),
        ("owner", 300, true),
        ("impact", 10000, true),
        ("responsePlan", 10000, true),
        ("escalationTo", 300, false),
        ("decisionMaker", 300, false),
        ("conclusion", 10000, false),
        ("resolution", 10000, false),
        ("closureReason", 10000, false),
    ] {
        value[field] = json!(text(p, field, limit, needed)?);
    }
    value["id"] = json!(key);
    value["projectId"] = json!(project);
    value["version"] = json!(version);
    value["createdAt"] = json!(created);
    value["updatedAt"] = json!(now());
    value["dueDate"] = json!(optional_date(p, "dueDate")?);
    value["reviewDate"] = json!(optional_date(p, "reviewDate")?);
    // Store only the stable public item shape, never request metadata.
    conn.execute("INSERT INTO governance_items VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,description=excluded.description,owner=excluded.owner,severity=excluded.severity,impact=excluded.impact,response_plan=excluded.response_plan,due_date=excluded.due_date,review_date=excluded.review_date,escalation_to=excluded.escalation_to,status=excluded.status,decision_maker=excluded.decision_maker,conclusion=excluded.conclusion,resolution=excluded.resolution,closure_reason=excluded.closure_reason,links_json=excluded.links_json,evidence_json=excluded.evidence_json,version=excluded.version,work_date=excluded.work_date,updated_at=excluded.updated_at",params![key,project,required(&value,"kind")?,required(&value,"title")?,value["description"].as_str(),required(&value,"owner")?,required(&value,"severity")?,required(&value,"impact")?,required(&value,"responsePlan")?,value["dueDate"].as_str(),value["reviewDate"].as_str(),value["escalationTo"].as_str(),required(&value,"status")?,value["decisionMaker"].as_str(),value["conclusion"].as_str(),value["resolution"].as_str(),value["closureReason"].as_str(),value["links"].to_string(),value["evidenceIds"].to_string(),version,required(&value,"workDate")?,created,required(&value,"updatedAt")?])?;
    let stored = item(conn, &key)?;
    append(conn, &stored, event, p)?;
    Ok(stored)
}
fn progress(conn: &Connection, p: &Value) -> Result<Value> {
    let key = required(p, "itemId")?;
    let before = item(conn, key)?;
    if before["version"].as_i64() != Some(positive(p, "baseVersion")?) {
        return Err(conflict());
    }
    if before["status"] == "closed" {
        return Err(invalid("已关闭事项需要先重新打开，才能记录进展"));
    }
    let date = required(p, "workDate")?;
    tasks::valid_date(date)?;
    if date < required(&before, "workDate")? {
        return Err(invalid("记录日期不能早于上次进展日期"));
    }
    text(p, "note", 10000, true)?;
    conn.execute(
        "UPDATE governance_items SET version=version+1,work_date=?,updated_at=? WHERE id=?",
        params![date, now(), key],
    )?;
    let after = item(conn, key)?;
    append(conn, &after, "progress", p)?;
    Ok(after)
}
pub(crate) fn workspace(conn: &Connection, p: &Value) -> Result<Value> {
    let date = required(p, "date")?;
    tasks::valid_date(date)?;
    let project = optional(p, "projectId")?;
    if let Some(scope) = &project {
        project_exists(conn, scope)?;
    }
    let mut stmt=conn.prepare(&format!("{SELECT} WHERE (?1 IS NULL OR project_id=?1) ORDER BY CASE WHEN status='closed' THEN 1 ELSE 0 END,CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,updated_at DESC,id"))?;
    let mut items = stmt
        .query_map([&project], parse_row)?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut counts = json!({"open":0,"inProgress":0,"escalated":0,"closed":0,"attention":0});
    for value in &mut items {
        let mut attention = Vec::new();
        if value["status"] != "closed" {
            if value["dueDate"].as_str().is_some_and(|v| v < date) {
                attention.push(json!({"kind":"overdue","label":"处理期限已过"}));
            }
            if value["reviewDate"].as_str().is_some_and(|v| v <= date) {
                attention.push(json!({"kind":"review_due","label":"已到复查日期"}));
            }
            if value["status"] == "escalated" {
                attention.push(json!({"kind":"escalated","label":"等待升级处理"}));
            }
            if links(value)?.iter().any(|link| {
                reference(conn, link)
                    .map(|(_, version)| Some(version) != link["version"].as_i64())
                    .unwrap_or(true)
            }) {
                attention.push(json!({"kind":"reference_stale","label":"关联内容已更新，请复核"}));
            }
        }
        if !attention.is_empty() {
            counts["attention"] = json!(counts["attention"].as_i64().unwrap() + 1);
        }
        let status = match value["status"].as_str() {
            Some("in_progress") => "inProgress",
            Some("escalated") => "escalated",
            Some("closed") => "closed",
            _ => "open",
        };
        counts[status] = json!(counts[status].as_i64().unwrap() + 1);
        value["attention"] = json!(attention);
        value["evidence"] = json!(evidence(
            conn,
            required(value, "projectId")?,
            &string_ids(value, "evidenceIds")?
        )?);
    }
    let mut stmt=conn.prepare("SELECT id,project_id,kind,content,revision FROM memories WHERE state='active' AND kind IN ('risk','decision') AND (?1 IS NULL OR project_id=?1) ORDER BY updated_at DESC,id")?;
    let memories = stmt
        .query_map([&project], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, i64>(4)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut drafts = Vec::new();
    for (key, scope, kind, content, revision) in memories {
        let mut evidence_stmt=conn.prepare("SELECT e.segment_id FROM revision_evidence e JOIN revisions r ON r.id=e.revision_id WHERE r.memory_id=? AND r.number=? ORDER BY e.segment_id")?;
        let ids = evidence_stmt
            .query_map(params![key, revision], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        drafts.push(json!({"memoryId":key,"memoryRevision":revision,"projectId":scope,"kind":kind,"title":content.chars().take(100).collect::<String>(),"description":content,"evidenceIds":ids}));
    }
    let mut stmt=conn.prepare("SELECT json_object('id',id,'projectId',project_id,'title',title,'version',version,'status',status) FROM milestones WHERE (?1 IS NULL OR project_id=?1) ORDER BY title,id")?;
    let milestones = stmt
        .query_map([&project], parse_row)?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(
        json!({"date":date,"items":items,"counts":counts,"memoryDrafts":drafts,"milestones":milestones}),
    )
}
pub(crate) fn dispatch(conn: &mut Connection, command: &str, p: &Value) -> Result<Value> {
    match command {
        "get_governance_workspace" => return workspace(conn, p),
        "get_governance_item" => return detail(conn, p),
        _ => {}
    }
    let tx = conn.transaction()?;
    let value = match command {
        "save_governance_item" => save(&tx, p),
        "record_governance_progress" => progress(&tx, p),
        _ => Err(AppError::new("UNKNOWN_COMMAND", "未知治理命令")),
    }?;
    tx.commit()?;
    Ok(value)
}

pub(crate) fn validate_backup(conn: &Connection) -> Result<()> {
    validate_rows(conn).map_err(|error| {
        AppError::new(
            "INVALID_BACKUP",
            format!("风险、问题和决策记录无效：{}", error.message),
        )
    })
}
fn timestamp(value: &str) -> Result<()> {
    chrono::DateTime::parse_from_rfc3339(value).map_err(|_| invalid("审计时间无效"))?;
    Ok(())
}
fn validate_rows(conn: &Connection) -> Result<()> {
    for (table, keys) in [
        ("governance_items", "id"),
        ("governance_revisions", "id"),
        ("governance_revisions", "item_id,version"),
    ] {
        if conn.query_row(
            &format!("SELECT EXISTS(SELECT 1 FROM {table} GROUP BY {keys} HAVING count(*)>1)"),
            [],
            |r| r.get::<_, bool>(0),
        )? {
            return Err(invalid("事项或修订标识重复"));
        }
    }
    for (table,texts,dates) in [("governance_items","id,project_id,kind,title,description,owner,severity,impact,response_plan,escalation_to,status,decision_maker,conclusion,resolution,closure_reason,links_json,evidence_json,work_date,created_at,updated_at","due_date,review_date"),("governance_revisions","id,item_id,project_id,event_type,work_date,note,recorded_at,snapshot_json","")] {
        let mut predicates=texts.split(',').map(|key|format!("typeof({key})<>'text'")).collect::<Vec<_>>();
        predicates.extend(dates.split(',').filter(|s|!s.is_empty()).map(|key|format!("typeof({key}) NOT IN ('text','null')")));
        predicates.push("typeof(version)<>'integer' OR version<1".into());
        if conn.query_row(&format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE {})",predicates.join(" OR ")),[],|r|r.get::<_,bool>(0))? {return Err(invalid("事项或修订字段类型无效"));}
    }
    let mut stmt = conn.prepare(SELECT)?;
    let items = stmt
        .query_map([], parse_row)?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut seen = HashSet::new();
    for value in items {
        let key = required(&value, "id")?;
        seen.insert(key.to_owned());
        project_exists(conn, required(&value, "projectId")?)?;
        validate_fields(&value)?;
        validate_links(conn, &value, false)?;
        timestamp(required(&value, "createdAt")?)?;
        timestamp(required(&value, "updatedAt")?)?;
        if chrono::DateTime::parse_from_rfc3339(required(&value, "createdAt")?).unwrap()
            > chrono::DateTime::parse_from_rfc3339(required(&value, "updatedAt")?).unwrap()
        {
            return Err(invalid("创建时间不能晚于更新时间"));
        }
        let history = revisions(conn, key)?;
        if history.len() as i64 != positive(&value, "version")?
            || history.last().map(|v| &v["snapshot"]) != Some(&value)
        {
            return Err(invalid("事项与修订历史不一致"));
        }
        let mut previous: Option<Value> = None;
        for (index, event) in history.iter().enumerate() {
            text(event, "id", 300, true)?;
            let snapshot = &event["snapshot"];
            if event["version"].as_i64() != Some(index as i64 + 1)
                || event["projectId"] != value["projectId"]
                || snapshot["id"] != value["id"]
                || snapshot["projectId"] != value["projectId"]
                || snapshot["kind"] != value["kind"]
                || snapshot["version"] != event["version"]
                || snapshot["workDate"] != event["workDate"]
                || snapshot["updatedAt"] != event["recordedAt"]
                || snapshot["createdAt"] != value["createdAt"]
            {
                return Err(invalid("修订身份、范围或版本无效"));
            }
            validate_fields(snapshot)?;
            validate_links(conn, snapshot, false)?;
            text(event, "note", 10000, true)?;
            timestamp(required(event, "recordedAt")?)?;
            let kind = required(event, "eventType")?;
            if let Some(before) = &previous {
                if required(snapshot, "workDate")? < required(before, "workDate")? {
                    return Err(invalid("修订日期逆序"));
                }
                if chrono::DateTime::parse_from_rfc3339(required(snapshot, "updatedAt")?).unwrap()
                    < chrono::DateTime::parse_from_rfc3339(required(before, "updatedAt")?).unwrap()
                {
                    return Err(invalid("修订记录时间逆序"));
                }
                let expected = if before["status"] == "closed" {
                    "reopened"
                } else if snapshot["status"] == "closed" {
                    "closed"
                } else if kind == "progress" {
                    "progress"
                } else {
                    "updated"
                };
                if kind != expected
                    || (before["status"] == "closed" && snapshot["status"] == "closed")
                {
                    return Err(invalid("修订状态转换无效"));
                }
                if kind == "progress" {
                    let mut compare = snapshot.clone();
                    for field in ["version", "workDate", "updatedAt"] {
                        compare[field] = before[field].clone();
                    }
                    if &compare != before {
                        return Err(invalid("进展日志不能修改事项字段"));
                    }
                }
            } else if kind != "created" {
                return Err(invalid("缺少创建修订"));
            }
            previous = Some(snapshot.clone());
        }
    }
    let mut stmt = conn.prepare("SELECT item_id FROM governance_revisions")?;
    let identities = stmt
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if identities.iter().any(|key| !seen.contains(key)) {
        return Err(invalid("存在无主修订"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (Connection, Value) {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE projects(id TEXT PRIMARY KEY); INSERT INTO projects VALUES('project');",
        )
        .unwrap();
        migrate(&conn).unwrap();
        let p = json!({"projectId":"project","kind":"issue","title":"联调阻塞","description":"","owner":"小周","severity":"high","impact":"联调延期","responsePlan":"补齐接口","dueDate":null,"reviewDate":null,"escalationTo":"","status":"open","decisionMaker":"","conclusion":"","resolution":"","closureReason":"","links":[],"evidenceIds":[],"workDate":"2026-10-19","note":"登记问题"});
        let item = dispatch(&mut conn, "save_governance_item", &p).unwrap();
        validate_backup(&conn).unwrap();
        (conn, item)
    }

    #[test]
    fn backup_rejects_history_gaps_and_latest_snapshot_mismatch() {
        let (mut conn, item) = fixture();
        dispatch(&mut conn,"record_governance_progress",&json!({"itemId":item["id"],"baseVersion":1,"workDate":"2026-10-20","note":"已确认补救方案"})).unwrap();
        validate_backup(&conn).unwrap();
        conn.execute("UPDATE governance_items SET owner='篡改负责人'", [])
            .unwrap();
        assert_eq!(validate_backup(&conn).unwrap_err().code, "INVALID_BACKUP");
        conn.execute("UPDATE governance_items SET owner='小周'", [])
            .unwrap();
        conn.execute("DELETE FROM governance_revisions WHERE version=1", [])
            .unwrap();
        assert_eq!(validate_backup(&conn).unwrap_err().code, "INVALID_BACKUP");
    }

    #[test]
    fn backup_rejects_progress_that_rewrites_fields_even_when_latest_snapshot_matches() {
        let (mut conn, item) = fixture();
        dispatch(&mut conn,"record_governance_progress",&json!({"itemId":item["id"],"baseVersion":1,"workDate":"2026-10-20","note":"已确认补救方案"})).unwrap();
        conn.execute("UPDATE governance_items SET owner='篡改负责人'", [])
            .unwrap();
        let changed = super::item(&conn, required(&item, "id").unwrap()).unwrap();
        conn.execute(
            "UPDATE governance_revisions SET snapshot_json=? WHERE version=2",
            [changed.to_string()],
        )
        .unwrap();
        assert_eq!(validate_backup(&conn).unwrap_err().code, "INVALID_BACKUP");
    }
}
