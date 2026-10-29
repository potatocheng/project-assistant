//! Local drafts and review queues. Drafts never enter facts or model context.
use crate::{id, now, required, tasks, AppError, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

pub(crate) const MIGRATION: &str = "
CREATE TABLE workspace_drafts(key TEXT PRIMARY KEY,body TEXT NOT NULL,version INTEGER NOT NULL CHECK(version>0),updated_at TEXT NOT NULL);
CREATE TABLE workspace_lifecycle(kind TEXT NOT NULL CHECK(kind IN ('project','source')),entity_id TEXT NOT NULL,archived INTEGER NOT NULL CHECK(archived IN (0,1)),replacement_id TEXT,reason TEXT NOT NULL,version INTEGER NOT NULL CHECK(version>0),updated_at TEXT NOT NULL,PRIMARY KEY(kind,entity_id));
CREATE TABLE workspace_lifecycle_events(id TEXT PRIMARY KEY,kind TEXT NOT NULL,entity_id TEXT NOT NULL,snapshot TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE assistant_sessions(id TEXT PRIMARY KEY,project_id TEXT REFERENCES projects(id),title TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE assistant_turns(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES assistant_sessions(id),question TEXT NOT NULL,resolved_question TEXT NOT NULL,answer TEXT NOT NULL,favorite INTEGER NOT NULL DEFAULT 0 CHECK(favorite IN (0,1)),created_at TEXT NOT NULL);
CREATE INDEX assistant_turn_session ON assistant_turns(session_id,created_at,id);
CREATE TABLE workspace_options(key TEXT PRIMARY KEY,value TEXT NOT NULL);
PRAGMA user_version=12;";

fn invalid(s: &str) -> AppError {
    AppError::new("VALIDATION", s)
}
fn parse(s: String) -> Result<Value> {
    serde_json::from_str(&s).map_err(|_| invalid("本地记录格式无效"))
}
pub(crate) fn draft(conn: &Connection, p: &Value) -> Result<Value> {
    let key = required(p, "key")?;
    let value = conn
        .query_row(
            "SELECT body,version,updated_at FROM workspace_drafts WHERE key=?",
            [key],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, String>(2)?,
                ))
            },
        )
        .optional()?;
    match value {
        Some((body, version, at)) => {
            Ok(json!({"body":parse(body)?,"version":version,"updatedAt":at}))
        }
        None => Ok(json!({"body":null,"version":0})),
    }
}
pub(crate) fn save_draft(conn: &Connection, p: &Value, remove: bool) -> Result<Value> {
    let key = required(p, "key")?;
    if key.len() > 500
        || ![
            "report:",
            "weekly:",
            "meeting:",
            "task:",
            "new-meeting:",
            "quality:",
        ]
        .iter()
        .any(|prefix| key.starts_with(prefix))
    {
        return Err(invalid("草稿位置无效"));
    }
    let base = p["baseVersion"]
        .as_i64()
        .filter(|v| *v >= 0)
        .ok_or_else(|| invalid("草稿版本无效"))?;
    if draft(conn, p)?["version"].as_i64() != Some(base) {
        return Err(AppError::new(
            "DRAFT_CONFLICT",
            "草稿已被其他编辑更新，请保留当前文字并重新打开",
        ));
    }
    if remove {
        conn.execute("DELETE FROM workspace_drafts WHERE key=?", [key])?;
        return Ok(json!({"version":0}));
    }
    let body = p
        .get("body")
        .filter(|v| v.is_object() || v.is_string())
        .ok_or_else(|| invalid("草稿内容无效"))?
        .to_string();
    if body.len() > 200_000 {
        return Err(invalid("草稿超过200 KB，请分段保存"));
    }
    conn.execute("INSERT INTO workspace_drafts VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body,version=excluded.version,updated_at=excluded.updated_at",params![key,body,base+1,now()])?;
    draft(conn, p)
}
pub(crate) fn review_queue(conn: &Connection, p: &Value) -> Result<Value> {
    let date = required(p, "date")?;
    tasks::valid_date(date)?;
    let project = p["projectId"].as_str().filter(|s| !s.is_empty());
    let offset = p["offset"].as_i64().unwrap_or(0).max(0);
    let sql="FROM memories m JOIN revisions r ON r.memory_id=m.id AND r.number=m.revision JOIN revision_retention rt ON rt.revision_id=r.id WHERE m.state='active' AND (?1 IS NULL OR m.project_id=?1) AND json_extract(rt.policy,'$.layer')='working' AND coalesce(json_extract(rt.policy,'$.reviewAfter'),'')<=?2 AND NOT EXISTS(SELECT 1 FROM workspace_lifecycle l WHERE l.kind='project' AND l.entity_id=m.project_id AND l.archived=1) AND (?4 IS NULL OR EXISTS(SELECT 1 FROM revision_evidence e JOIN segments g ON g.id=e.segment_id WHERE e.revision_id=r.id AND g.source_id=?4))";
    let total: i64 = conn.query_row(
        &format!("SELECT count(*) {sql}"),
        params![
            project,
            date,
            offset,
            p["sourceId"].as_str().filter(|v| !v.is_empty())
        ],
        |r| r.get(0),
    )?;
    let mut stmt=conn.prepare(&format!("SELECT json_object('id',m.id,'projectId',m.project_id,'content',m.content,'revision',m.revision,'sourceTitle',m.source_title,'retention',json(rt.policy)) {sql} ORDER BY json_extract(rt.policy,'$.reviewAfter'),m.id LIMIT 50 OFFSET ?3"))?;
    let items = stmt
        .query_map(
            params![
                project,
                date,
                offset,
                p["sourceId"].as_str().filter(|v| !v.is_empty())
            ],
            |r| r.get::<_, String>(0),
        )?
        .map(|r| parse(r?))
        .collect::<Result<Vec<_>>>()?;
    Ok(json!({"items":items,"total":total,"offset":offset,"limit":50}))
}

pub(crate) fn lifecycle_map(conn: &Connection) -> Result<Vec<Value>> {
    let mut stmt=conn.prepare("SELECT json_object('kind',kind,'id',entity_id,'archived',json(CASE archived WHEN 1 THEN 'true' ELSE 'false' END),'replacementId',replacement_id,'reason',reason,'version',version) FROM workspace_lifecycle")?;
    let result = stmt
        .query_map([], |r| r.get::<_, String>(0))?
        .map(|r| parse(r?))
        .collect();
    result
}
pub(crate) fn lifecycle_impact(conn: &Connection, p: &Value) -> Result<Value> {
    let kind = required(p, "kind")?;
    let entity = required(p, "id")?;
    let table = match kind {
        "project" => "projects",
        "source" => "sources",
        _ => return Err(invalid("请选择项目或资料")),
    };
    let title: Option<String> = conn
        .query_row(
            &format!(
                "SELECT {} FROM {table} WHERE id=?",
                if kind == "project" { "name" } else { "title" }
            ),
            [entity],
            |r| r.get(0),
        )
        .optional()?;
    let title = title.ok_or_else(|| AppError::new("NOT_FOUND", "记录不存在"))?;
    let memories = if kind == "project" {
        "SELECT count(*) FROM memories WHERE project_id=?"
    } else {
        "SELECT count(DISTINCT r.memory_id) FROM revisions r JOIN revision_evidence e ON e.revision_id=r.id JOIN segments g ON g.id=e.segment_id WHERE g.source_id=?"
    };
    let count: i64 = conn.query_row(memories, [entity], |r| r.get(0))?;
    let version: i64 = conn
        .query_row(
            "SELECT version FROM workspace_lifecycle WHERE kind=? AND entity_id=?",
            params![kind, entity],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or(0);
    let jobs:i64=conn.query_row(if kind=="source"{"SELECT count(*) FROM jobs WHERE source_id=? AND status IN ('queued','running')"}else{"SELECT count(*) FROM jobs j JOIN sources s ON s.id=j.source_id WHERE s.project_id=? AND j.status IN ('queued','running')"},[entity],|r|r.get(0))?;
    let fingerprint = crate::hash(
        json!([
            kind,
            entity,
            title,
            count,
            version,
            jobs,
            conn.total_changes()
        ])
        .to_string()
        .as_bytes(),
    );
    Ok(
        json!({"kind":kind,"id":entity,"title":title,"memories":count,"runningJobs":jobs,"version":version,"fingerprint":fingerprint}),
    )
}
pub(crate) fn set_lifecycle(conn: &mut Connection, p: &Value) -> Result<Value> {
    let impact = lifecycle_impact(conn, p)?;
    if p["fingerprint"] != impact["fingerprint"] {
        return Err(AppError::new(
            "REVISION_CONFLICT",
            "影响范围已变化，请重新预览",
        ));
    }
    if impact["runningJobs"].as_i64().unwrap_or(0) > 0 {
        return Err(invalid("请先等待或取消相关提取任务，再更改资料状态"));
    }
    let kind = required(p, "kind")?;
    let entity = required(p, "id")?;
    let archived = p["archived"]
        .as_bool()
        .ok_or_else(|| invalid("归档状态无效"))?;
    let reason = required(p, "reason")?;
    if reason.chars().count() > 1000 {
        return Err(invalid("原因最多1000字"));
    }
    let replacement = p["replacementId"].as_str().filter(|s| !s.is_empty());
    if let Some(new) = replacement {
        if kind != "source" || new == entity || !archived {
            return Err(invalid("新版必须是另一份资料，且旧版应停用"));
        }
        let valid:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM sources a JOIN sources b ON b.project_id=a.project_id WHERE a.id=? AND b.id=? AND b.status='ready' AND NOT EXISTS(SELECT 1 FROM workspace_lifecycle l WHERE l.kind='source' AND l.entity_id=b.id AND l.archived=1))",params![entity,new],|r|r.get(0))?;
        if !valid {
            return Err(invalid("请选择同项目内已解析且启用的新版资料"));
        }
    }
    let tx = conn.transaction()?;
    let at = now();
    tx.execute("INSERT INTO workspace_lifecycle VALUES(?,?,?,?,?,?,?) ON CONFLICT(kind,entity_id) DO UPDATE SET archived=excluded.archived,replacement_id=excluded.replacement_id,reason=excluded.reason,version=excluded.version,updated_at=excluded.updated_at",params![kind,entity,archived,replacement,reason,impact["version"].as_i64().unwrap()+1,at])?;
    tx.execute(
        "INSERT INTO workspace_lifecycle_events VALUES(?,?,?,?,?)",
        params![id(), kind, entity, p.to_string(), at],
    )?;
    tx.commit()?;
    Ok(json!({"saved":true}))
}

pub(crate) fn search(conn: &Connection, p: &Value) -> Result<Value> {
    let query = required(p, "query")?.trim();
    if query.chars().count() > 200 {
        return Err(invalid("搜索词最多200字"));
    }
    let project = p["projectId"].as_str().filter(|s| !s.is_empty());
    let kind = p["kind"].as_str().filter(|s| !s.is_empty());
    let offset = p["offset"].as_i64().unwrap_or(0).clamp(0, 100_000);
    let archived = p["includeArchived"].as_bool().unwrap_or(false);
    let union="SELECT 'project' kind,id,id project_id,name title,description content,created_at updated_at FROM projects
        UNION ALL SELECT 'task',id,project_id,title,description||' '||coalesce(assignee,''),updated_at FROM tasks
        UNION ALL SELECT 'memory',id,project_id,substr(content,1,60),content,updated_at FROM memories
        UNION ALL SELECT 'source',s.id,s.project_id,s.title,coalesce((SELECT group_concat(text,' ') FROM segments WHERE source_id=s.id),''),s.imported_at FROM sources s
        UNION ALL SELECT 'report',id,project_id,date||' 日报',content,updated_at FROM daily_reports
        UNION ALL SELECT 'meeting',id,project_id,title,coalesce(json_extract(data_json,'$.minutes'),'')||' '||coalesce(json_extract(data_json,'$.decisions'),''),updated_at FROM coordination_meetings
        UNION ALL SELECT 'governance',id,project_id,title,description,updated_at FROM governance_items
        UNION ALL SELECT 'change',id,project_id,title,data_json,updated_at FROM change_requests
        UNION ALL SELECT 'deliverable',id,project_id,title,data_json,updated_at FROM deliverables
        UNION ALL SELECT 'weekly_report',r.id,r.project_id,r.title,v.content,r.updated_at FROM coordination_reports r JOIN coordination_report_versions v ON v.report_id=r.id AND v.version=r.version";
    // Bound values remain SQL parameters, including wildcard characters.
    let filter="WHERE (?2 IS NULL OR project_id=?2) AND (?3 IS NULL OR kind=?3) AND (instr(lower(title),lower(?1))>0 OR instr(lower(content),lower(?1))>0) AND (?4 OR (NOT EXISTS(SELECT 1 FROM workspace_lifecycle l WHERE l.kind='project' AND l.entity_id=project_id AND l.archived=1) AND NOT EXISTS(SELECT 1 FROM workspace_lifecycle l WHERE l.kind=records.kind AND l.entity_id=records.id AND l.archived=1)))";
    let total: i64 = conn.query_row(
        &format!("WITH records AS ({union}) SELECT count(*) FROM records {filter}"),
        params![query, project, kind, archived],
        |r| r.get(0),
    )?;
    let mut stmt=conn.prepare(&format!("WITH records AS ({union}) SELECT kind,id,project_id,title,substr(content,max(1,instr(lower(content),lower(?1))-100),400),updated_at FROM records {filter} ORDER BY (instr(lower(title),lower(?1))>0) DESC,updated_at DESC,kind,id LIMIT 50 OFFSET ?5"))?;
    let items=stmt.query_map(params![query,project,kind,archived,offset],|r|Ok(json!({"kind":r.get::<_,String>(0)?,"id":r.get::<_,String>(1)?,"projectId":r.get::<_,Option<String>>(2)?,"title":r.get::<_,String>(3)?,"excerpt":r.get::<_,String>(4)?,"updatedAt":r.get::<_,String>(5)?})))?.collect::<std::result::Result<Vec<_>,_>>()?;
    Ok(json!({"items":items,"total":total,"offset":offset,"limit":50}))
}

pub(crate) fn filter_context(conn: &Connection, context: &mut Value) -> Result<()> {
    let hidden = lifecycle_map(conn)?
        .into_iter()
        .filter(|v| v["kind"] == "project" && v["archived"] == true)
        .filter_map(|v| v["id"].as_str().map(str::to_owned))
        .collect::<std::collections::HashSet<_>>();
    if hidden.is_empty() {
        return Ok(());
    }
    if let Some(map) = context.as_object_mut() {
        for (key, value) in map.iter_mut() {
            if let Some(records) = value.as_array_mut() {
                records.retain(|r| {
                    let project = if key == "projects" {
                        r["id"].as_str()
                    } else {
                        r["projectId"].as_str()
                    };
                    !(project.is_some_and(|id| hidden.contains(id))
                        || key == "reports" && project.is_none())
                });
            }
        }
    }
    Ok(())
}

pub(crate) fn validate_backup(conn: &Connection) -> Result<()> {
    let mut stmt = conn.prepare("SELECT key,body,version FROM workspace_drafts")?;
    for row in stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, i64>(2)?,
        ))
    })? {
        let (k, b, v) = row?;
        if k.len() > 500 || b.len() > 200_000 || v < 1 {
            return Err(invalid("备份草稿无效"));
        }
        let body = parse(b)?;
        if !(body.is_object() || body.is_string())
            || ![
                "report:",
                "weekly:",
                "meeting:",
                "task:",
                "new-meeting:",
                "quality:",
            ]
            .iter()
            .any(|prefix| k.starts_with(prefix))
        {
            return Err(invalid("备份草稿内容或位置无效"));
        }
    }
    for value in lifecycle_map(conn)? {
        lifecycle_impact(conn, &value)?;
        if required(&value, "reason")?.chars().count() > 1000 {
            return Err(invalid("备份归档原因无效"));
        }
        if let Some(replacement) = value["replacementId"].as_str() {
            let valid:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM sources a JOIN sources b ON b.project_id=a.project_id WHERE a.id=? AND b.id=? AND a.id<>b.id)",params![value["id"].as_str(),replacement],|r|r.get(0))?;
            if value["kind"] != "source" || value["archived"] != true || !valid {
                return Err(invalid("备份资料版本关联无效"));
            }
        }
        let count: i64 = conn.query_row(
            "SELECT count(*) FROM workspace_lifecycle_events WHERE kind=? AND entity_id=?",
            params![value["kind"].as_str(), value["id"].as_str()],
            |r| r.get(0),
        )?;
        if value["version"].as_i64() != Some(count) {
            return Err(invalid("备份归档历史不完整"));
        }
    }
    let mut stmt = conn.prepare("SELECT answer FROM assistant_turns")?;
    for raw in stmt.query_map([], |r| r.get::<_, String>(0))? {
        let answer = parse(raw?)?;
        if !answer.is_object() || !answer["answer"].is_string() || !answer["citations"].is_array() {
            return Err(invalid("备份问答无效"));
        }
        for citation in answer["citations"].as_array().unwrap() {
            if ["id", "kind", "title", "content"]
                .iter()
                .any(|key| !citation[*key].is_string())
                || citation
                    .get("evidence")
                    .is_some_and(|v| !v.is_null() && !v.is_array())
            {
                return Err(invalid("备份历史引用无效"));
            }
        }
    }
    crate::workspace_policy::validate_backup(conn)?;
    Ok(())
}
