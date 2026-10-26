//! Reviewed personal preferences, reproducible project briefs and memory quality feedback.
//! Briefs are derived snapshots; they never become new project facts.
use crate::{assistant_qa, hash, id, now, qa, required, tasks, AppError, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

pub(crate) const MIGRATION: &str = "
CREATE TABLE assistant_preferences(id INTEGER PRIMARY KEY CHECK(id=1),role TEXT NOT NULL,answer_style TEXT NOT NULL CHECK(answer_style IN ('standard','concise','detailed')),report_format TEXT NOT NULL CHECK(report_format IN ('structured','brief')),reminder_style TEXT NOT NULL CHECK(reminder_style IN ('standard','gentle','direct')),version INTEGER NOT NULL CHECK(version>=0),updated_at TEXT NOT NULL);
INSERT INTO assistant_preferences VALUES(1,'','standard','structured','standard',0,'');
CREATE TABLE project_briefs(project_id TEXT PRIMARY KEY REFERENCES projects(id),date TEXT NOT NULL,basis TEXT NOT NULL,fingerprint TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE memory_corrections(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),memory_id TEXT NOT NULL REFERENCES memories(id),from_revision INTEGER NOT NULL,to_revision INTEGER NOT NULL,question TEXT NOT NULL,previous_content TEXT NOT NULL,corrected_content TEXT NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(memory_id,to_revision),FOREIGN KEY(memory_id,from_revision) REFERENCES revisions(memory_id,number),FOREIGN KEY(memory_id,to_revision) REFERENCES revisions(memory_id,number));
CREATE TABLE extraction_assessments(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),source_id TEXT NOT NULL REFERENCES sources(id),candidate_id TEXT,candidate_kind TEXT NOT NULL CHECK(candidate_kind IN ('memory','task','source')),verdict TEXT NOT NULL CHECK(verdict IN ('correct','incorrect')),error_kind TEXT NOT NULL CHECK(error_kind IN ('none','content','assignee','date','status','evidence','omission')),reason TEXT NOT NULL,snapshot TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE INDEX correction_project ON memory_corrections(project_id,created_at);
CREATE INDEX assessment_project ON extraction_assessments(project_id,created_at);
PRAGMA user_version=8;";

fn invalid(message: &str) -> AppError {
    AppError::new("VALIDATION", message)
}
fn parse(raw: String) -> Result<Value> {
    serde_json::from_str(&raw).map_err(|_| invalid("保存的记忆数据格式无效"))
}
fn clip(text: &str, limit: usize) -> String {
    text.chars().take(limit).collect()
}
fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}
fn rows(v: &Value, key: &str) -> Vec<Value> {
    v[key].as_array().cloned().unwrap_or_default()
}
fn project(conn: &Connection, p: &Value) -> Result<String> {
    let project = required(p, "projectId")?;
    if !conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM projects WHERE id=?)",
        [project],
        |r| r.get::<_, bool>(0),
    )? {
        return Err(AppError::new("NOT_FOUND", "项目不存在"));
    }
    Ok(project.to_owned())
}
pub(crate) fn preferences(conn: &Connection) -> Result<Value> {
    let raw = conn.query_row("SELECT json_object('role',role,'answerStyle',answer_style,'reportFormat',report_format,'reminderStyle',reminder_style,'version',version,'updatedAt',updated_at) FROM assistant_preferences WHERE id=1",[],|r|r.get(0))?;
    parse(raw)
}
fn validate_preferences(p: &Value) -> Result<()> {
    if p["role"].as_str().is_none_or(|v| v.chars().count() > 1000)
        || !matches!(
            p["answerStyle"].as_str(),
            Some("standard" | "concise" | "detailed")
        )
        || !matches!(p["reportFormat"].as_str(), Some("structured" | "brief"))
        || !matches!(
            p["reminderStyle"].as_str(),
            Some("standard" | "gentle" | "direct")
        )
    {
        return Err(invalid("偏好格式无效，职责说明最多1000字"));
    }
    Ok(())
}
fn save_preferences(conn: &Connection, p: &Value, clear: bool) -> Result<Value> {
    let base = p["baseVersion"]
        .as_i64()
        .filter(|v| *v >= 0)
        .ok_or_else(|| invalid("缺少偏好版本"))?;
    let value = if clear {
        json!({"role":"","answerStyle":"standard","reportFormat":"structured","reminderStyle":"standard"})
    } else {
        p.clone()
    };
    validate_preferences(&value)?;
    if conn.execute("UPDATE assistant_preferences SET role=?,answer_style=?,report_format=?,reminder_style=?,version=version+1,updated_at=? WHERE id=1 AND version=?",params![text(&value,"role").trim(),text(&value,"answerStyle"),text(&value,"reportFormat"),text(&value,"reminderStyle"),now(),base])?!=1 {
        return Err(AppError::new("REVISION_CONFLICT","偏好已更新，请重新载入后保存"));
    }
    preferences(conn)
}

/// Scope-specific revision anchors also cover records beyond the display limits.
fn anchors(conn: &Connection, project: &str) -> Result<String> {
    let mut values = Vec::new();
    for (table, fields) in [
        ("sources", "id,sha256,status"),
        ("memories", "id,revision,state,content"),
        ("tasks", "id,version,updated_at"),
        ("milestones", "id,version,updated_at"),
        ("project_profiles", "project_id,version"),
        ("daily_reports", "id,version"),
        ("task_follow_up_state", "task_id,version"),
        ("governance_items", "id,version"),
        ("change_requests", "id,version"),
        ("deliverables", "id,version"),
        ("coordination_meetings", "id,version"),
        ("coordination_actions", "id,version"),
        ("coordination_reports", "id,version"),
    ] {
        let mut stmt = conn.prepare(&format!(
            "SELECT {fields} FROM {table} WHERE project_id=? ORDER BY 1"
        ))?;
        let count = stmt.column_count();
        let data = stmt
            .query_map([project], |r| {
                let mut fields = Vec::new();
                for index in 0..count {
                    fields.push(format!("{:?}", r.get_ref(index)?));
                }
                Ok(fields)
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        values.push(json!([table, data]));
    }
    for sql in [
        "SELECT json_group_array(json_array(r.id,r.active,r.kind,r.target_id,r.reason)) FROM (SELECT r.* FROM task_relations r JOIN tasks t ON t.id=r.task_id WHERE t.project_id=? ORDER BY r.id) r",
        "SELECT json_group_array(json_array(a.day,a.task_id,a.minutes,a.position,a.reason,a.draft_id)) FROM (SELECT a.* FROM daily_allocations a JOIN tasks t ON t.id=a.task_id WHERE t.project_id=? ORDER BY a.day,a.task_id) a",
        "SELECT json_group_array(json_array(v.id,v.status,v.disposition,v.target_id,v.target_revision,v.reason)) FROM (SELECT v.* FROM memory_reviews v JOIN proposals p ON p.id=v.proposal_id WHERE p.project_id=? ORDER BY v.id) v",
    ] {
        values.push(json!(conn.query_row(sql,[project],|r|r.get::<_,String>(0))?));
    }
    Ok(hash(json!(values).to_string().as_bytes()))
}
fn brief_basis(conn: &Connection, project: &str, date: &str) -> Result<Value> {
    tasks::valid_date(date)?;
    let mut context = assistant_qa::retrieve(
        conn,
        &json!({"projectId":project,"date":date,"question":"项目简报：项目目标当前进展关键决策阻塞待决策下一步"}),
    )?;
    for field in ["capturedAt", "fingerprint", "preferences"] {
        context.as_object_mut().unwrap().remove(field);
    }
    let mut statement=conn.prepare("SELECT json_object('id',v.id,'proposalId',p.id,'targetId',v.target_id,'content',p.content,'reason',v.reason,'sourceId',p.source_id,'sourceTitle',s.title,'disposition',v.disposition) FROM memory_reviews v JOIN proposals p ON p.id=v.proposal_id JOIN sources s ON s.id=p.source_id WHERE p.project_id=? AND v.status='pending' AND p.status='pending' ORDER BY v.created_at,v.id LIMIT 101")?;
    let reviews = statement
        .query_map([project], |r| r.get::<_, String>(0))?
        .map(|r| parse(r?))
        .collect::<Result<Vec<_>>>()?;
    Ok(json!({"context":context,"reviews":reviews,"anchors":anchors(conn,project)?}))
}
fn sections(basis: &Value) -> Value {
    let context = &basis["context"];
    let refs = assistant_qa::references(context);
    let date = text(context, "date");
    let section =
        |key: &str, title: &str, items: Vec<Value>| json!({"key":key,"title":title,"items":items});
    let items = |filter: fn(&Value) -> bool, limit: usize| {
        refs.iter()
            .filter(|r| filter(r))
            .take(limit)
            .cloned()
            .collect::<Vec<_>>()
    };
    let mut recent = refs
        .iter()
        .filter(|r| {
            matches!(
                text(r, "kind"),
                "task" | "memory" | "governance" | "change" | "meeting_action"
            )
        })
        .cloned()
        .collect::<Vec<_>>();
    recent.sort_by(|a, b| {
        text(b, "updatedAt")
            .cmp(text(a, "updatedAt"))
            .then_with(|| text(a, "id").cmp(text(b, "id")))
    });
    let blockers = refs
        .iter()
        .filter(|r| {
            (r["kind"] == "task"
                && (r["record"]["status"] == "blocked"
                    || (matches!(r["record"]["status"].as_str(), Some("todo" | "in_progress"))
                        && r["record"]["dueDate"]
                            .as_str()
                            .is_some_and(|due| due < date))))
                || (r["kind"] == "governance" && r["record"]["status"] != "closed")
                || (r["kind"] == "relation"
                    && !matches!(
                        r["record"]["taskStatus"].as_str(),
                        Some("done" | "cancelled")
                    )
                    && r["record"]["targetStatus"] != "done")
        })
        .take(8)
        .cloned()
        .collect();
    let mut next = refs
        .iter()
        .filter(|r| {
            r["kind"] == "task"
                && matches!(
                    r["record"]["status"].as_str(),
                    Some("todo" | "in_progress" | "blocked")
                )
        })
        .cloned()
        .collect::<Vec<_>>();
    next.sort_by_key(|r| {
        (
            if r["record"]["status"] == "blocked" {
                0
            } else {
                1
            },
            r["record"]["dueDate"]
                .as_str()
                .unwrap_or("9999-12-31")
                .to_owned(),
            text(r, "id").to_owned(),
        )
    });
    next.truncate(6);
    recent.truncate(6);
    json!([
        section("goal", "当前目标", items(|r| r["kind"] == "project", 1)),
        section("progress", "当前进展", items(|r| r["kind"] == "task", 6)),
        section(
            "decisions",
            "已确认决策",
            items(
                |r| (r["kind"] == "memory" && r["record"]["kind"] == "decision")
                    || (r["kind"] == "governance"
                        && r["record"]["kind"] == "decision"
                        && r["record"]["status"] == "closed"),
                6
            )
        ),
        section("blockers", "阻塞与待决策事项", blockers),
        section("next", "建议跟进的现有任务", next),
        section("recent", "最近记录", recent)
    ])
}
fn brief(conn: &Connection, p: &Value, generate: bool) -> Result<Value> {
    let project = project(conn, p)?;
    let date = required(p, "date")?;
    let current = brief_basis(conn, &project, date)?;
    if generate {
        let fingerprint = hash(current.to_string().as_bytes());
        conn.execute("INSERT INTO project_briefs VALUES(?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET date=excluded.date,basis=excluded.basis,fingerprint=excluded.fingerprint,created_at=excluded.created_at",params![project,date,current.to_string(),fingerprint,now()])?;
    }
    let saved = conn
        .query_row(
            "SELECT date,basis,fingerprint,created_at FROM project_briefs WHERE project_id=?",
            [&project],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                ))
            },
        )
        .optional()?;
    let Some((saved_date, raw, fingerprint, created_at)) = saved else {
        return Ok(json!({"projectId":project,"brief":null}));
    };
    let basis = parse(raw)?;
    let stale = saved_date != date || fingerprint != hash(current.to_string().as_bytes());
    Ok(
        json!({"projectId":project,"brief":{"date":saved_date,"createdAt":created_at,"fingerprint":fingerprint,"stale":stale,"sections":sections(&basis),"pendingReviews":basis["reviews"],"limitations":basis["context"]["limitations"]}}),
    )
}

pub(crate) fn correction(conn: &Connection, p: &Value, current: &Value, at: &str) -> Result<()> {
    if p.get("question")
        .is_some_and(|v| !v.is_null() && !v.is_string())
    {
        return Err(invalid("纠正问题必须是文本"));
    }
    let question = p["question"].as_str().unwrap_or("").trim();
    if question.chars().count() > 2000 {
        return Err(invalid("纠正问题最多2000字"));
    }
    let question = if question.is_empty() {
        format!(
            "请核对这条记忆的当前内容：{}",
            clip(text(current, "content"), 120)
        )
    } else {
        question.to_owned()
    };
    conn.execute(
        "INSERT INTO memory_corrections VALUES(?,?,?,?,?,?,?,?,?,?)",
        params![
            id(),
            text(current, "projectId"),
            text(current, "id"),
            current["revision"].as_i64(),
            current["revision"].as_i64().unwrap() + 1,
            question,
            text(current, "content"),
            required(p, "content")?,
            required(p, "reason")?,
            at
        ],
    )?;
    Ok(())
}
fn assess(conn: &Connection, p: &Value) -> Result<Value> {
    let kind = required(p, "candidateKind")?;
    let candidate=match kind {
        "memory" => conn.query_row("SELECT json_object('projectId',project_id,'sourceId',source_id,'id',id,'kind',kind,'content',content,'quotes',json(quotes),'edited',edited,'origin',origin,'provider',provider,'model',model,'promptVersion',prompt_version,'extractionJobId',extraction_job_id) FROM proposals WHERE id=?",[required(p,"candidateId")?],|r|r.get::<_,String>(0)).optional()?,
        "task" => conn.query_row("SELECT json_object('projectId',project_id,'sourceId',source_id,'id',id,'title',title,'description',description,'assignee',assignee,'dueDate',due_date,'dueText',due_text,'status',task_status,'progress',progress,'quotes',json(quotes),'edited',edited,'origin','ai','provider',provider,'model',model,'promptVersion',prompt_version,'extractionJobId',extraction_job_id) FROM task_proposals WHERE id=?",[required(p,"candidateId")?],|r|r.get::<_,String>(0)).optional()?,
        "source" => conn.query_row("SELECT json_object('projectId',project_id,'sourceId',id,'title',title,'sha256',sha256) FROM sources WHERE id=? AND status='ready'",[required(p,"sourceId")?],|r|r.get::<_,String>(0)).optional()?,
        _=>return Err(invalid("抽检对象类型无效")),
    }.map(parse).transpose()?.ok_or_else(||AppError::new("NOT_FOUND","抽检对象不存在"))?;
    if kind != "source" && (candidate["origin"] != "ai" || candidate["edited"] != 0) {
        return Err(invalid("请抽检未经人工编辑的AI候选"));
    }
    let verdict = required(p, "verdict")?;
    let error = required(p, "errorKind")?;
    let reason = p["reason"].as_str().unwrap_or("").trim();
    if !matches!(verdict, "correct" | "incorrect")
        || !matches!(
            error,
            "none" | "content" | "assignee" | "date" | "status" | "evidence" | "omission"
        )
        || (verdict == "correct") != (error == "none")
        || (kind == "source" && error != "omission")
        || (verdict == "incorrect" && reason.is_empty())
        || reason.chars().count() > 2000
    {
        return Err(invalid("请填写有效的抽检结论和错误说明"));
    }
    // A snapshot can have one label; repeated clicks do not inflate sample counts.
    let snapshot = candidate.to_string();
    let key = hash(json!([kind, snapshot]).to_string().as_bytes());
    conn.execute("INSERT INTO extraction_assessments VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET verdict=excluded.verdict,error_kind=excluded.error_kind,reason=excluded.reason,created_at=excluded.created_at",params![key,text(&candidate,"projectId"),text(&candidate,"sourceId"),candidate["id"].as_str(),kind,verdict,error,reason,snapshot,now()])?;
    quality(conn, &json!({"projectId":candidate["projectId"]}), false)
}
fn quality(conn: &Connection, p: &Value, check: bool) -> Result<Value> {
    if p.get("projectId")
        .is_some_and(|v| !v.is_null() && !v.is_string())
    {
        return Err(invalid("项目范围无效"));
    }
    let scope = p["projectId"]
        .as_str()
        .filter(|v| !v.is_empty() && *v != "all");
    if scope.is_some() {
        project(conn, p)?;
    }
    let mut stmt=conn.prepare("SELECT json_object('id',c.id,'projectId',c.project_id,'memoryId',c.memory_id,'fromRevision',c.from_revision,'toRevision',c.to_revision,'question',c.question,'previousContent',c.previous_content,'correctedContent',c.corrected_content,'reason',c.reason,'createdAt',c.created_at,'currentRevision',m.revision,'state',m.state) FROM memory_corrections c JOIN memories m ON m.id=c.memory_id WHERE (? IS NULL OR c.project_id=?) ORDER BY c.created_at DESC,c.id LIMIT 201")?;
    let mut corrections = stmt
        .query_map(params![scope, scope], |r| r.get::<_, String>(0))?
        .map(|r| parse(r?))
        .collect::<Result<Vec<_>>>()?;
    let limited = corrections.len() > 200;
    corrections.truncate(200);
    for case in &mut corrections {
        case["check"] = json!(if case["currentRevision"] != case["toRevision"]
            || case["state"] != "active"
        {
            "superseded"
        } else {
            "unchecked"
        });
        if check && case["check"] == "unchecked" {
            let context = qa::retrieve(
                conn,
                &json!({"projectId":case["projectId"],"question":case["question"]}),
            )?;
            let found = rows(&context, "memories")
                .iter()
                .any(|m| m["memoryId"] == case["memoryId"] && m["revision"] == case["toRevision"]);
            case["check"] = json!(if found { "passed" } else { "not_recalled" });
        }
    }
    let mut statement=conn.prepare("SELECT json_object('id',id,'projectId',project_id,'sourceId',source_id,'candidateId',candidate_id,'candidateKind',candidate_kind,'verdict',verdict,'errorKind',error_kind,'reason',reason,'snapshot',json(snapshot),'createdAt',created_at) FROM extraction_assessments WHERE (? IS NULL OR project_id=?) ORDER BY created_at DESC,id LIMIT 100")?;
    let assessments = statement
        .query_map(params![scope, scope], |r| r.get::<_, String>(0))?
        .map(|r| parse(r?))
        .collect::<Result<Vec<_>>>()?;
    let counts=conn.query_row("SELECT count(*),coalesce(sum(verdict='correct'),0),coalesce(sum(error_kind='assignee'),0),coalesce(sum(error_kind='date'),0),coalesce(sum(error_kind='omission'),0) FROM extraction_assessments WHERE (? IS NULL OR project_id=?)",params![scope,scope],|r|Ok(json!({"reviewed":r.get::<_,i64>(0)?,"correct":r.get::<_,i64>(1)?,"assigneeErrors":r.get::<_,i64>(2)?,"dateErrors":r.get::<_,i64>(3)?,"omissions":r.get::<_,i64>(4)?})))?;
    Ok(
        json!({"corrections":corrections,"assessments":assessments,"counts":counts,"limited":limited,"checkedAt":if check {json!(now())} else {Value::Null}}),
    )
}
pub(crate) fn dispatch(conn: &Connection, command: &str, p: &Value) -> Result<Value> {
    match command {
        "get_assistant_preferences" => preferences(conn),
        "save_assistant_preferences" => save_preferences(conn, p, false),
        "clear_assistant_preferences" => save_preferences(conn, p, true),
        "get_project_brief" => brief(conn, p, false),
        "generate_project_brief" => brief(conn, p, true),
        "get_memory_quality" => quality(conn, p, false),
        "check_memory_quality" => quality(conn, p, true),
        "assess_extraction" => assess(conn, p),
        _ => Err(invalid("不支持的记忆工作台操作")),
    }
}

// Stored briefs are historical snapshots. Their contents can differ from current
// records, but every referenced identifier must still belong to the same project.
fn validate_brief_scope(conn: &Connection, basis: &Value, project: &str) -> Result<()> {
    let context = &basis["context"];
    for (key, table) in [
        ("projects", "projects"),
        ("tasks", "tasks"),
        ("memories", "memories"),
        ("milestones", "milestones"),
        ("relations", "task_relations"),
        ("reports", "daily_reports"),
    ] {
        let items = context[key]
            .as_array()
            .ok_or_else(|| invalid("简报记录格式无效"))?;
        for item in items {
            let id = required(item, "id")?;
            let sql = if table == "projects" {
                "SELECT EXISTS(SELECT 1 FROM projects WHERE id=?1 AND id=?2)".to_owned()
            } else if table == "task_relations" {
                "SELECT EXISTS(SELECT 1 FROM task_relations r JOIN tasks t ON t.id=r.task_id WHERE r.id=?1 AND t.project_id=?2)".to_owned()
            } else {
                format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE id=?1 AND project_id=?2)")
            };
            if !conn.query_row(&sql, params![id, project], |r| r.get::<_, bool>(0))? {
                return Err(invalid("简报引用跨项目或已丢失"));
            }
        }
    }
    for item in context["management"]
        .as_array()
        .ok_or_else(|| invalid("简报管理记录格式无效"))?
    {
        let table = match text(item, "kind") {
            "governance" => "governance_items",
            "change" => "change_requests",
            "deliverable" => "deliverables",
            "meeting" => "coordination_meetings",
            "meeting_action" => "coordination_actions",
            "weekly_report" => "coordination_reports",
            _ => return Err(invalid("简报引用类型无效")),
        };
        if !conn.query_row(
            &format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE id=? AND project_id=?)"),
            params![required(item, "managementId")?, project],
            |r| r.get::<_, bool>(0),
        )? {
            return Err(invalid("简报管理引用范围无效"));
        }
    }
    for key in ["plans", "followUps"] {
        for item in context[key]
            .as_array()
            .ok_or_else(|| invalid("简报关联记录格式无效"))?
        {
            if !conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM tasks WHERE id=? AND project_id=?)",
                params![required(item, "taskId")?, project],
                |r| r.get::<_, bool>(0),
            )? {
                return Err(invalid("简报任务关联范围无效"));
            }
        }
    }
    for item in basis["reviews"]
        .as_array()
        .ok_or_else(|| invalid("简报待确认记录格式无效"))?
    {
        if !conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM proposals WHERE id=? AND source_id=? AND project_id=?)",
            params![
                required(item, "proposalId")?,
                required(item, "sourceId")?,
                project
            ],
            |r| r.get::<_, bool>(0),
        )? {
            return Err(invalid("简报待确认内容范围无效"));
        }
    }
    for reference in assistant_qa::references(context) {
        for evidence in reference["evidence"].as_array().into_iter().flatten() {
            if !conn.query_row("SELECT EXISTS(SELECT 1 FROM segments g JOIN sources s ON s.id=g.source_id WHERE g.id=? AND s.id=? AND s.project_id=?)",params![required(evidence,"segmentId")?,required(evidence,"sourceId")?,project],|r|r.get::<_,bool>(0))? {return Err(invalid("简报原文依据范围无效"));}
        }
    }
    Ok(())
}

pub(crate) fn validate_backup(conn: &Connection) -> Result<()> {
    let check = (|| -> Result<()> {
        let prefs = preferences(conn)?;
        validate_preferences(&prefs)?;
        if prefs["version"].as_i64().is_none_or(|v| v < 0)
            || conn.query_row("SELECT count(*) FROM assistant_preferences", [], |r| {
                r.get::<_, i64>(0)
            })? != 1
        {
            return Err(invalid("偏好版本无效"));
        }
        let broken:i64=conn.query_row("SELECT count(*) FROM memory_corrections c LEFT JOIN memories m ON m.id=c.memory_id LEFT JOIN revisions a ON a.memory_id=c.memory_id AND a.number=c.from_revision LEFT JOIN revisions b ON b.memory_id=c.memory_id AND b.number=c.to_revision WHERE m.project_id<>c.project_id OR m.id IS NULL OR a.id IS NULL OR b.id IS NULL OR c.to_revision<>c.from_revision+1 OR a.content<>c.previous_content OR b.content<>c.corrected_content OR b.origin<>'user_correction' OR b.reason<>c.reason OR length(trim(c.question))=0 OR length(c.question)>2000",[],|r|r.get(0))?;
        if broken != 0 {
            return Err(invalid("纠正记录与记忆修订不一致"));
        }
        let mut stmt =
            conn.prepare("SELECT project_id,date,basis,fingerprint FROM project_briefs")?;
        for row in stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        })? {
            let (project, date, raw, fingerprint) = row?;
            tasks::valid_date(&date)?;
            let basis = parse(raw)?;
            validate_brief_scope(conn, &basis, &project)?;
            if basis["context"]["projectId"] != project
                || basis["context"]["date"] != date
                || fingerprint != hash(basis.to_string().as_bytes())
                || !basis["context"]["projects"].is_array()
                || basis["context"]["projects"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|r| r["id"] != project)
                || assistant_qa::references(&basis["context"])
                    .iter()
                    .any(|r| r["projectId"] != project)
            {
                return Err(invalid("项目摘要范围或指纹无效"));
            }
        }
        let mut stmt=conn.prepare("SELECT project_id,source_id,candidate_id,candidate_kind,verdict,error_kind,snapshot,id,reason,created_at FROM extraction_assessments")?;
        for row in stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
                r.get::<_, String>(6)?,
                r.get::<_, String>(7)?,
                r.get::<_, String>(8)?,
                r.get::<_, String>(9)?,
            ))
        })? {
            let (project, source, candidate, kind, verdict, error, raw, key, reason, created_at) =
                row?;
            let snapshot = parse(raw)?;
            chrono::DateTime::parse_from_rfc3339(&created_at)
                .map_err(|_| invalid("抽检时间无效"))?;
            if key != hash(json!([kind, snapshot.to_string()]).to_string().as_bytes())
                || reason.chars().count() > 2000
                || (verdict == "incorrect" && reason.trim().is_empty())
            {
                return Err(invalid("抽检快照标识或说明无效"));
            }
            let exists: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM sources WHERE id=? AND project_id=?)",
                params![source, project],
                |r| r.get(0),
            )?;
            if kind != "source" {
                let table = match kind.as_str() {
                    "memory" => "proposals",
                    "task" => "task_proposals",
                    _ => return Err(invalid("抽检对象类型无效")),
                };
                if !conn.query_row(&format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE id=? AND source_id=? AND project_id=?)"),params![candidate,source,project],|r|r.get::<_,bool>(0))? {return Err(invalid("抽检候选范围无效"));}
            }
            if !exists
                || snapshot["projectId"] != project
                || snapshot["sourceId"] != source
                || !matches!(kind.as_str(), "memory" | "task" | "source")
                || !matches!(verdict.as_str(), "correct" | "incorrect")
                || !matches!(
                    error.as_str(),
                    "none" | "content" | "assignee" | "date" | "status" | "evidence" | "omission"
                )
                || (verdict == "correct") != (error == "none")
                || (kind == "source" && (candidate.is_some() || error != "omission"))
                || (kind != "source"
                    && (candidate.is_none()
                        || snapshot["id"].as_str() != candidate.as_deref()
                        || snapshot["origin"] != "ai"
                        || snapshot["edited"] != 0))
            {
                return Err(invalid("抽检样本范围或结论无效"));
            }
        }
        Ok(())
    })();
    check.map_err(|_| AppError::new("INVALID_BACKUP", "记忆摘要、偏好或质量反馈数据无效"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ai, db::Database, parse, Request};

    fn call(db: &mut Database, command: &str, payload: Value) -> Value {
        db.execute(Request {
            command: command.into(),
            payload,
        })
        .unwrap()
    }
    fn fixture() -> (tempfile::TempDir, Database, Value, Value) {
        let dir = tempfile::tempdir().unwrap();
        let mut db = Database::open(dir.path().into()).unwrap();
        let p = call(&mut db, "create_project", json!({"name":"记忆工作台测试"}));
        let content = "陈雨负责支付接口验收，2026-10-23完成。";
        let imported = call(
            &mut db,
            "import_text",
            json!({"projectId":p["id"],"title":"验收纪要","text":content}),
        );
        let job = imported["jobId"].as_str().unwrap();
        let task = db.claim(job, db.epoch).unwrap().unwrap();
        db.complete(
            job,
            db.epoch,
            task.generation,
            parse::parse_file(&task.path, &task.kind),
        )
        .unwrap();
        call(
            &mut db,
            "save_ai_settings",
            json!({"provider":"ollama","baseUrl":"http://127.0.0.1:11434","model":"deterministic-fixture","outputFormat":"json_schema","timeoutSeconds":1,"autoExtract":false,"remoteConsent":false}),
        );
        let job = call(
            &mut db,
            "start_extraction",
            json!({"sourceId":imported["sourceId"]}),
        );
        let task = db
            .claim_extract(job["id"].as_str().unwrap(), db.epoch)
            .unwrap()
            .unwrap();
        let evidence = ai::CandidateEvidence {
            segment_id: task.segments[0].id.clone(),
            quote: content.into(),
        };
        db.complete_extract(
            job["id"].as_str().unwrap(),
            db.epoch,
            task.generation,
            Ok(ai::ExtractionResult {
                candidates: vec![ai::Candidate {
                    facets: Default::default(),
                    kind: "fact".into(),
                    content: content.into(),
                    evidence: vec![evidence.clone()],
                }],
                task_candidates: vec![ai::AiTaskCandidate {
                    title: "支付接口验收".into(),
                    description: content.into(),
                    assignee: Some("陈雨".into()),
                    due_date: Some("2026-10-23".into()),
                    due_text: Some("2026-10-23".into()),
                    status: "todo".into(),
                    progress: None,
                    evidence: vec![evidence],
                }],
                discarded_count: 0,
                batch_count: 1,
            }),
        )
        .unwrap();
        (dir, db, p, imported)
    }

    #[test]
    fn ai_memory_and_task_labels_freeze_provenance_and_reject_manual_edits() {
        let (_dir, mut db, p, _) = fixture();
        let state = call(&mut db, "get_state", json!({}));
        let m = &state["proposals"][0];
        let task = &state["taskProposals"][0];
        assert_eq!(state["taskProposals"].as_array().unwrap().len(), 1);
        for (kind, candidate) in [("memory", m), ("task", task)] {
            let payload = json!({"candidateKind":kind,"candidateId":candidate["id"],"verdict":"incorrect","errorKind":"date","reason":"合成标签，仅验证标注存储；并非真实模型的错误。"});
            call(&mut db, "assess_extraction", payload.clone());
            call(&mut db, "assess_extraction", payload);
        }
        let quality = call(&mut db, "get_memory_quality", json!({"projectId":p["id"]}));
        assert_eq!(quality["counts"]["reviewed"], 2);
        assert_eq!(quality["counts"]["dateErrors"], 2);
        for sample in quality["assessments"].as_array().unwrap() {
            assert_eq!(sample["snapshot"]["model"], "deterministic-fixture");
            assert_eq!(sample["snapshot"]["promptVersion"], ai::PROMPT_VERSION);
            assert!(!sample["snapshot"]["quotes"].as_array().unwrap().is_empty());
        }
        validate_backup(&db.conn).unwrap();
        db.conn
            .execute(
                "UPDATE task_proposals SET edited=1 WHERE id=?",
                [task["id"].as_str().unwrap()],
            )
            .unwrap();
        assert_eq!(assess(&db.conn,&json!({"candidateKind":"task","candidateId":task["id"],"verdict":"correct","errorKind":"none"})).unwrap_err().code,"VALIDATION");
        validate_backup(&db.conn).unwrap(); // Existing labels retain the original unedited snapshot.
    }

    #[test]
    fn preference_changes_invalidate_pending_model_context() {
        let (_dir, mut db, p, _) = fixture();
        let payload =
            json!({"projectId":p["id"],"date":"2026-10-20","question":"支付接口验收由谁负责？"});
        let context = assistant_qa::retrieve(&db.conn, &payload).unwrap();
        assistant_qa::validate(&db.conn, &context).unwrap();
        call(
            &mut db,
            "save_assistant_preferences",
            json!({"baseVersion":0,"role":"交付负责人","answerStyle":"concise","reportFormat":"brief","reminderStyle":"direct"}),
        );
        assert_eq!(
            assistant_qa::validate(&db.conn, &context).unwrap_err().code,
            "ASSISTANT_CONTEXT_STALE"
        );
        let refreshed = assistant_qa::retrieve(&db.conn, &payload).unwrap();
        call(
            &mut db,
            "clear_assistant_preferences",
            json!({"baseVersion":1}),
        );
        assert_eq!(
            assistant_qa::validate(&db.conn, &refreshed)
                .unwrap_err()
                .code,
            "ASSISTANT_CONTEXT_STALE"
        );
    }

    #[test]
    fn backup_rejects_cross_project_assessments_and_empty_error_reasons() {
        let (_dir, mut db, p, source) = fixture();
        let other = call(&mut db, "create_project", json!({"name":"另一个项目"}));
        call(
            &mut db,
            "assess_extraction",
            json!({"candidateKind":"source","sourceId":source["sourceId"],"verdict":"incorrect","errorKind":"omission","reason":"合成漏提样本"}),
        );
        validate_backup(&db.conn).unwrap();
        db.conn
            .execute(
                "UPDATE extraction_assessments SET project_id=?",
                [other["id"].as_str().unwrap()],
            )
            .unwrap();
        assert_eq!(
            validate_backup(&db.conn).unwrap_err().code,
            "INVALID_BACKUP"
        );
        db.conn
            .execute(
                "UPDATE extraction_assessments SET project_id=?",
                [p["id"].as_str().unwrap()],
            )
            .unwrap();
        db.conn
            .execute("UPDATE extraction_assessments SET reason=''", [])
            .unwrap();
        assert_eq!(
            validate_backup(&db.conn).unwrap_err().code,
            "INVALID_BACKUP"
        );
    }
}
