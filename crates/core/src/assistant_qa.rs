//! Shared, read-only project questions over current work and confirmed memory.
use crate::{hash, now, required, search, settings, tasks, AppError, Engine, Request, Result};
use chrono::{Datelike, Duration, NaiveDate};
use rusqlite::{params, Connection};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::HashSet, path::Path, sync::mpsc};

const VERSION: &str = "project-assistant-v15-shared-workflows";
const MAX_TASKS: usize = 300;
const MAX_MEMORIES: usize = 64;
const MAX_MILESTONES: usize = 80;
const MAX_REFERENCES: usize = 40;
const MAX_MODEL_CHARS: usize = 40_000;

fn stale() -> AppError {
    AppError::new(
        "ASSISTANT_CONTEXT_STALE",
        "项目记录或模型配置已有变化，请重新提问",
    )
}
fn clip(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}
fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or("")
}
fn records<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value[key].as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn read(conn: &Connection, sql: &str, scope: Option<&str>, limit: usize) -> Result<Vec<Value>> {
    read_bound(conn, sql, params![scope, limit as i64])
}
fn read_bound<P: rusqlite::Params>(conn: &Connection, sql: &str, args: P) -> Result<Vec<Value>> {
    let mut stmt = conn.prepare(sql)?;
    let output = stmt
        .query_map(args, |row| {
            let raw: String = row.get(0)?;
            serde_json::from_str(&raw).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    0,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(output)
}
fn relevance_sql(title: &str, body: &str) -> String {
    // Column expressions are fixed literals. Query data is captured by the
    // registered scorer, and ranking happens before SQL LIMIT.
    format!("project_search_score({title},{body})")
}
fn scoped_count(conn: &Connection, table: &str, scope: Option<&str>) -> Result<i64> {
    // Table names are fixed call-site literals, never user data.
    Ok(conn.query_row(
        &format!("SELECT count(*) FROM {table} WHERE (?1 IS NULL OR project_id=?1)"),
        [scope],
        |row| row.get(0),
    )?)
}

pub(crate) fn retrieve(conn: &Connection, payload: &Value) -> Result<Value> {
    let navigated = crate::qa::navigation_payload(payload);
    let payload = &navigated;
    let question = required(payload, "question")?.trim();
    if question.chars().count() > 2_000 {
        return Err(AppError::new(
            "ASSISTANT_QUESTION_LIMIT",
            "问题最多 2000 字，请缩短后重试",
        ));
    }
    let default_date = chrono::Local::now().format("%Y-%m-%d").to_string();
    let date = payload["date"].as_str().unwrap_or(&default_date);
    tasks::valid_date(date)?;
    let scope = match payload.get("projectId") {
        None | Some(Value::Null) => None,
        Some(Value::String(id)) if id.is_empty() || id == "all" => None,
        Some(Value::String(id)) => Some(id.as_str()),
        _ => return Err(AppError::new("VALIDATION", "项目范围无效")),
    };
    if let Some(project) = scope {
        if !conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM projects WHERE id=?)",
            [project],
            |row| row.get::<_, bool>(0),
        )? {
            return Err(AppError::new("NOT_FOUND", "项目不存在"));
        }
    }
    let query = search::Query::from_payload(payload)?;
    search::register(conn, payload)?;
    let mut projects = read(conn,
        "SELECT json_object('id',p.id,'name',p.name,'description',substr(p.description,1,2000),'goal',substr(coalesce(f.goal,''),1,2000),'status',coalesce(f.status,'active'),'targetDate',f.target_date,'version',coalesce(f.version,0),'updatedAt',coalesce(f.updated_at,p.created_at)) FROM projects p LEFT JOIN project_profiles f ON f.project_id=p.id WHERE (?1 IS NULL OR p.id=?1) ORDER BY p.id LIMIT ?2", scope, 301)?;
    for project in &mut projects {
        project["taskSummary"] = conn.query_row("SELECT json_object('total',count(*),'done',coalesce(sum(status='done'),0),'blocked',coalesce(sum(status='blocked'),0),'inProgress',coalesce(sum(status='in_progress'),0),'todo',coalesce(sum(status='todo'),0),'updatedAt',max(updated_at)) FROM tasks WHERE project_id=?",[text(project,"id")], |row| {
            let raw:String=row.get(0)?;
            serde_json::from_str(&raw).map_err(|error|rusqlite::Error::FromSqlConversionFailure(0,rusqlite::types::Type::Text,Box::new(error)))
        })?;
    }
    let work = read_bound(conn,&format!(
        "SELECT json_object('id',t.id,'projectId',t.project_id,'title',t.title,'description',project_search_excerpt(t.description,1200),'category',t.category,'status',t.status,'progress',t.progress,'assignee',t.assignee,'priority',t.priority,'dueDate',t.due_date,'plannedDate',t.planned_date,'memoryId',t.memory_id,'memoryRevision',t.memory_revision,'version',t.version,'updatedAt',t.updated_at,'latestNote',substr(coalesce((SELECT note FROM task_events e WHERE e.task_id=t.id ORDER BY version DESC LIMIT 1),''),1,1500),'workDate',(SELECT work_date FROM task_events e WHERE e.task_id=t.id ORDER BY version DESC LIMIT 1)) FROM tasks t WHERE (?1 IS NULL OR t.project_id=?1) ORDER BY {} DESC,CASE t.status WHEN 'blocked' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'todo' THEN 2 ELSE 3 END,t.updated_at DESC,t.id LIMIT ?2",relevance_sql("t.title","t.description || ' ' || coalesce(t.assignee,'') || ' ' || coalesce((SELECT note FROM task_events e WHERE e.task_id=t.id ORDER BY version DESC LIMIT 1),'')")),params![scope,(MAX_TASKS+1) as i64])?;
    let memory_selection = crate::memory_query::retrieve(
        conn,
        scope,
        &query,
        MAX_MEMORIES,
        4000,
        query.overview(),
        date,
    )?;
    let memory_candidates = memory_selection.records;
    let memory_pack = crate::qa::selected_memory_pack(question, &memory_candidates);
    let memories = memory_pack.references;
    let milestones = read_bound(conn,&format!(
        "SELECT json_object('id',m.id,'projectId',m.project_id,'title',m.title,'description',project_search_excerpt(m.description,1600),'status',m.status,'baselineDate',m.baseline_date,'forecastDate',m.forecast_date,'version',m.version,'updatedAt',m.updated_at,'linkedTasksUpdatedAt',(SELECT max(t.updated_at) FROM milestone_tasks mt JOIN tasks t ON t.id=mt.task_id WHERE mt.milestone_id=m.id AND t.project_id=m.project_id),'completionBlocked',json(CASE WHEN EXISTS(SELECT 1 FROM milestone_tasks mt JOIN tasks t ON t.id=mt.task_id WHERE mt.milestone_id=m.id AND t.project_id=m.project_id AND t.status<>'done') THEN 'true' ELSE 'false' END),'taskIds',json((SELECT coalesce(json_group_array(mt.task_id),'[]') FROM milestone_tasks mt JOIN tasks t ON t.id=mt.task_id WHERE mt.milestone_id=m.id AND t.project_id=m.project_id))) FROM milestones m WHERE (?1 IS NULL OR m.project_id=?1) ORDER BY {} DESC,m.updated_at DESC,m.id LIMIT ?2",relevance_sql("m.title","m.description")),params![scope,(MAX_MILESTONES+1) as i64])?;
    let relations = read(conn,
        "SELECT json_object('id',r.id,'projectId',t.project_id,'taskId',r.task_id,'targetId',r.target_id,'kind',r.kind,'reason',substr(r.reason,1,1400),'updatedAt',r.created_at,'taskTitle',t.title,'taskStatus',t.status,'targetTitle',u.title,'targetStatus',u.status) FROM task_relations r JOIN tasks t ON t.id=r.task_id LEFT JOIN tasks u ON u.id=r.target_id WHERE r.active=1 AND (?1 IS NULL OR t.project_id=?1) AND (u.id IS NULL OR u.project_id=t.project_id OR ?1 IS NULL) ORDER BY r.id LIMIT ?2", scope, 301)?;
    let plans = read_bound(conn,&format!(
        "SELECT json_object('id',a.day||':'||a.task_id,'projectId',t.project_id,'taskId',t.id,'title',t.title,'date',a.day,'minutes',a.minutes,'position',a.position,'reason',substr(a.reason,1,1000),'updatedAt',d.created_at) FROM daily_allocations a JOIN tasks t ON t.id=a.task_id JOIN planning_drafts d ON d.id=a.draft_id WHERE d.status='applied' AND (?1 IS NULL OR t.project_id=?1) ORDER BY CASE WHEN a.day=?3 THEN 0 WHEN a.day BETWEEN date(?3,'weekday 0','-6 days') AND date(?3,'weekday 0') THEN 1 ELSE 2 END,{} DESC,a.day DESC,a.position,a.task_id LIMIT ?2",relevance_sql("t.title","a.reason")),params![scope,101_i64,date])?;
    let follow_ups = read(conn,
        "SELECT json_object('id',f.task_id,'projectId',f.project_id,'taskId',f.task_id,'title',t.title,'nextFollowUpDate',f.next_follow_up_date,'snoozedUntil',f.snoozed_until,'version',f.version,'updatedAt',f.updated_at,'latestNote',substr(coalesce((SELECT note FROM task_follow_ups h WHERE h.task_id=f.task_id ORDER BY version DESC LIMIT 1),''),1,1400),'lastFollowUpAt',(SELECT recorded_at FROM task_follow_ups h WHERE h.task_id=f.task_id ORDER BY version DESC LIMIT 1)) FROM task_follow_up_state f JOIN tasks t ON t.id=f.task_id AND t.project_id=f.project_id WHERE (?1 IS NULL OR f.project_id=?1) ORDER BY f.updated_at DESC,f.task_id LIMIT ?2", scope, 301)?;
    // A workspace report may contain another project's facts, so single-project
    // retrieval only admits reports explicitly scoped to that project.
    let reports = read(conn,
        "SELECT json_object('id',d.id,'projectId',d.project_id,'date',d.date,'version',d.version,'content',project_search_excerpt(d.content,3000),'edited',json(CASE d.edited WHEN 1 THEN 'true' ELSE 'false' END),'updatedAt',d.updated_at) FROM daily_reports d WHERE (?1 IS NULL OR d.project_id=?1) AND NOT EXISTS(SELECT 1 FROM daily_reports n WHERE n.scope=d.scope AND n.date=d.date AND n.version>d.version) ORDER BY d.date DESC,d.id LIMIT ?2", scope, 15)?;
    let mut context = json!({"retrievalVersion":VERSION,"question":question,"date":date,"projectId":scope,"projects":projects,"tasks":work,"memories":memories,"milestones":milestones,"relations":relations,"plans":plans,"followUps":follow_ups,"reports":reports,"taskCount":scoped_count(conn,"tasks",scope)?,"milestoneCount":scoped_count(conn,"milestones",scope)?,"searchQueries":payload["searchQueries"].as_array().cloned().unwrap_or_default(),"searchTrace":memory_selection.trace,"searchCatalog":memory_selection.catalog});
    context["memoryCandidatePool"] = json!(memory_candidates);
    context["sourcePassages"] = json!(crate::source_passages::retrieve(
        conn,
        scope,
        &query,
        date,
        context["memories"].as_array().unwrap(),
    )?);
    context["evidenceSelectionTrace"] = memory_pack.trace;
    let mut management = crate::management::qa_records(
        conn,
        &json!({"projectId":scope,"date":date,"question":question,"searchQueries":context["searchQueries"]}),
    )?;
    management.sort_by(|a, b| {
        let score = |r: &Value| query.score(text(r, "title"), text(r, "content"));
        score(b)
            .cmp(&score(a))
            .then_with(|| a["id"].as_str().cmp(&b["id"].as_str()))
    });
    context["managementCount"] = json!(management.len());
    management.truncate(160);
    context["management"] = json!(management);
    crate::daily_use::filter_context(conn, &mut context)?;
    let mut limitations = vec![
        "本地规则只使用已记录资料；未记录的负责人、预计完成日期与实际进展无法判断。".to_owned(),
        "长篇正文和描述仅提供节选，完整记录可打开引用查看。".to_owned(),
    ];
    if context["searchTrace"]["limited"] == true {
        limitations
            .push("正式记忆候选超过本地检索窗口，本次按问题覆盖筛选有限当前记录。".to_owned());
    }
    for (key, limit) in [
        ("projects", 300),
        ("tasks", MAX_TASKS),
        ("memories", MAX_MEMORIES),
        ("milestones", MAX_MILESTONES),
        ("relations", 300),
        ("plans", 100),
        ("followUps", 300),
        ("reports", 14),
    ] {
        if let Some(values) = context[key].as_array_mut() {
            if values.len() > limit {
                values.truncate(limit);
                limitations.push(format!(
                    "{key} 超过检索上限 {limit} 条，本次仅汇总已检索记录，请缩小项目范围。"
                ));
            }
        }
    }
    // Evidence joins are scoped and attached only to the current memory revision.
    for memory in context["memories"].as_array_mut().unwrap() {
        let rows = crate::memory_query::evidence(
            conn,
            text(memory, "revisionId"),
            text(memory, "projectId"),
            &query,
            600,
        )?;
        memory["evidence"] = json!(rows);
    }
    context["limitations"] = json!(limitations);
    if context["managementCount"].as_u64().unwrap_or(0) > 160 {
        context["limitations"].as_array_mut().unwrap().push(json!(
            "管理记录超过本次检索上限160条，已优先匹配问题；请缩小项目范围或提供完整名称。"
        ));
    }
    context["preferences"] = crate::memory_workbench::preferences(conn)?;
    context["contextIntent"] = json!(context_intent(question));
    context["fingerprint"] = json!(hash(context.to_string().as_bytes()));
    context["capturedAt"] = json!(now());
    Ok(context)
}

pub(crate) fn validate(conn: &Connection, context: &Value) -> Result<Value> {
    if context["retrievalVersion"] != VERSION
        || context["fingerprint"] != retrieve(conn, context)?["fingerprint"]
    {
        return Err(stale());
    }
    // The snapshot is internal, nevertheless reject changed records even if a
    // caller preserved a genuine fingerprint beside a forged context.
    let mut original = context.clone();
    for key in [
        "fingerprint",
        "capturedAt",
        "workspaceEpoch",
        "modelRevision",
    ] {
        original.as_object_mut().ok_or_else(stale)?.remove(key);
    }
    if context["fingerprint"] != hash(original.to_string().as_bytes()) {
        return Err(stale());
    }
    Ok(json!({"valid":true}))
}

fn status(task: &Value) -> &str {
    match text(task, "status") {
        "todo" => "未开始",
        "in_progress" => "进行中",
        "blocked" => "阻塞",
        "done" => "已完成",
        "cancelled" => "已取消",
        "completed" => "已完成",
        "planned" => "待启动",
        "on_hold" => "暂停",
        _ => "进行中",
    }
}
fn task_line(task: &Value) -> String {
    let owner = task["assignee"]
        .as_str()
        .filter(|v| !v.is_empty())
        .unwrap_or("未指定负责人");
    let due = task["dueDate"]
        .as_str()
        .map(|d| format!("，截止 {d}"))
        .unwrap_or_else(|| "，未记录截止日期".into());
    let note = text(task, "latestNote");
    let description = text(task, "description");
    format!(
        "{}：{}，进度 {}%，{}{}{}{}",
        text(task, "title"),
        status(task),
        task["progress"],
        owner,
        due,
        if description.is_empty() {
            String::new()
        } else {
            format!("；说明：{}", description)
        },
        if note.is_empty() {
            String::new()
        } else {
            format!("；最新记录：{}", clip(note, 300))
        }
    )
}
pub(crate) fn references(context: &Value) -> Vec<Value> {
    let mut output = Vec::new();
    for (key, kind) in [
        ("projects", "project"),
        ("tasks", "task"),
        ("memories", "memory"),
        ("milestones", "milestone"),
        ("relations", "relation"),
        ("plans", "plan"),
        ("followUps", "follow_up"),
        ("reports", "report"),
    ] {
        for record in records(context, key) {
            let id = text(record, "id");
            let project = if kind == "project" {
                record["id"].clone()
            } else {
                record["projectId"].clone()
            };
            let title = match kind {
                "project" => text(record, "name").to_owned(),
                "memory" => text(record, "sourceTitle").to_owned(),
                "relation" => format!("{} 的依赖/阻塞", text(record, "taskTitle")),
                "report" => format!("{} 日报 v{}", text(record, "date"), record["version"]),
                _ => text(record, "title").to_owned(),
            };
            let content = match kind {
                "task" => task_line(record),
                "project" => format!(
                    "目标：{}；状态：{}；目标日期：{}。{}",
                    text(record, "goal"),
                    status(record),
                    record["targetDate"].as_str().unwrap_or("未记录"),
                    text(record, "description")
                ),
                "memory" | "report" => text(record, "content").to_owned(),
                "milestone" => format!(
                    "{}：{}{}；原定 {}；当前预计 {}；{}",
                    text(record, "title"),
                    status(record),
                    if record["status"] == "completed" && record["completionBlocked"] == true {
                        "（关联任务尚未全部完成，需复核完成状态）"
                    } else {
                        ""
                    },
                    record["baselineDate"].as_str().unwrap_or("未记录"),
                    record["forecastDate"].as_str().unwrap_or("未记录"),
                    text(record, "description")
                ),
                "relation" => format!(
                    "{}；{}；关联任务：{}（{}）",
                    text(record, "kind"),
                    text(record, "reason"),
                    record["targetTitle"].as_str().unwrap_or("无"),
                    record["targetStatus"].as_str().unwrap_or("未记录")
                ),
                "plan" => format!(
                    "{} 已确认安排 {} 分钟；{}",
                    text(record, "date"),
                    record["minutes"],
                    text(record, "reason")
                ),
                _ => format!(
                    "上次跟进 {}；下次跟进 {}；暂停提醒至 {}；{}",
                    record["lastFollowUpAt"].as_str().unwrap_or("未记录"),
                    record["nextFollowUpDate"].as_str().unwrap_or("未记录"),
                    record["snoozedUntil"].as_str().unwrap_or("未设置"),
                    text(record, "latestNote")
                ),
            };
            let mut reference = json!({"id":format!("{kind}:{id}"),"kind":kind,"projectId":project,"title":title,"content":content,"updatedAt":record["updatedAt"],"record":record});
            let related_update = match kind {
                "project" => record["taskSummary"]["updatedAt"].as_str(),
                "milestone" => record["linkedTasksUpdatedAt"].as_str(),
                _ => None,
            };
            if let Some(updated) =
                related_update.filter(|updated| *updated > text(record, "updatedAt"))
            {
                reference["updatedAt"] = json!(updated);
            }
            let target = match kind {
                "task" | "plan" | "follow_up" | "relation" => Some("taskId"),
                "memory" => Some("memoryId"),
                "milestone" => Some("milestoneId"),
                "report" => Some("reportId"),
                _ => None,
            };
            if let Some(target) = target {
                reference[target] = if matches!(kind, "plan" | "follow_up" | "relation") {
                    record["taskId"].clone()
                } else {
                    record["id"].clone()
                };
            }
            if kind == "memory" {
                reference["revision"] = record["revision"].clone();
                reference["evidence"] = record["evidence"].clone();
                reference["sourceTitle"] = record["sourceTitle"].clone();
            }
            output.push(reference);
        }
    }
    output.extend(records(context, "management").iter().cloned());
    output
}

fn terms(question: &str) -> search::Query {
    search::Query::new(question)
}

// Only bypass generation when the whole question is a direct lookup of these
// fields. A third requested fact or a different role must not be silently lost.
fn task_fields_only(question: &str, title: &str) -> bool {
    let mut remaining = question.to_lowercase().replace(&title.to_lowercase(), "");
    for word in [
        "截止日期",
        "截止时间",
        "到期日期",
        "到期时间",
        "负责人",
        "由谁负责",
        "谁负责",
        "谁来做",
        "due date",
        "deadline",
        "assignee",
        "owner",
        "什么时候",
        "分别",
        "请问",
        "告诉我",
        "查询",
        "查看",
        "目前",
        "当前",
        "现在",
        "是哪天",
        "哪一天",
        "是什么",
        "何时",
        "哪天",
        "截止",
        "到期",
        "以及",
        "同时",
        "what",
        "when",
        "who",
        "the",
        "and",
        "is",
        "的",
        "是",
        "谁",
        "和",
        "与",
        "及",
        "吗",
        "呢",
    ] {
        remaining = remaining.replace(word, "");
    }
    !remaining.chars().any(char::is_alphanumeric)
}

fn workflow_lookup_only(question: &str) -> bool {
    let mut remaining = question.to_owned();
    for word in [
        "待决策",
        "待拍板",
        "未决事项",
        "优先",
        "跟进",
        "有哪些",
        "哪些",
        "列出",
        "请问",
        "今天",
        "今日",
        "目前",
        "当前",
        "现在",
        "本周",
        "这周",
        "项目",
        "交付",
        "事项",
        "可能",
        "延期",
        "延误",
        "延迟",
        "需要",
        "应该",
        "请",
        "先",
        "催",
        "谁",
        "有",
        "该",
        "吗",
        "呢",
        "的",
    ] {
        remaining = remaining.replace(word, "");
    }
    !remaining.chars().any(char::is_alphanumeric)
}

fn context_intent(question: &str) -> Vec<&'static str> {
    let lower = question.to_lowercase();
    let mut intents = Vec::new();
    for (intent, words) in [
        (
            "progress",
            &["进度", "进展", "状态", "progress", "status"][..],
        ),
        ("decision", &["决策", "决定", "拍板", "decision"][..]),
        (
            "cause",
            &["原因", "为什么", "阻塞", "卡在", "依赖", "why", "blocked"][..],
        ),
        (
            "schedule",
            &[
                "日期",
                "何时",
                "什么时候",
                "安排",
                "排期",
                "截止",
                "deadline",
                "when",
            ][..],
        ),
        (
            "owner",
            &["谁", "负责人", "跟进", "催", "owner", "assignee"][..],
        ),
    ] {
        if words.iter().any(|word| lower.contains(word)) {
            intents.push(intent);
        }
    }
    if intents.is_empty() {
        intents.push("topic");
    }
    intents
}
fn intent_score(context: &Value, reference: &Value) -> usize {
    let kind = text(reference, "kind");
    context_intent(text(context, "question"))
        .iter()
        .map(|intent| match *intent {
            "progress" if matches!(kind, "task" | "milestone" | "meeting_action") => 700,
            "decision"
                if matches!(kind, "memory" | "governance")
                    && reference["record"]["kind"] == "decision" =>
            {
                900
            }
            "cause" if matches!(kind, "relation" | "memory" | "governance" | "task") => 700,
            "schedule" if matches!(kind, "plan" | "task" | "milestone") => 700,
            "owner" if matches!(kind, "task" | "follow_up" | "meeting_action") => 700,
            _ => 0,
        })
        .sum()
}
fn push_reference(
    lines: &mut Vec<String>,
    selected: &mut Vec<Value>,
    reference: &Value,
    line: String,
) {
    let index = if let Some(index) = selected
        .iter()
        .position(|item| item["id"] == reference["id"])
    {
        index + 1
    } else {
        selected.push(reference.clone());
        selected.len()
    };
    lines.push(format!("{line} [{index}]"));
}
fn active(value: &Value) -> bool {
    matches!(
        value["status"].as_str(),
        Some("todo" | "in_progress" | "blocked")
    )
}
fn unresolved_relation(reference: &Value) -> bool {
    reference["kind"] == "relation"
        && !matches!(
            reference["record"]["taskStatus"].as_str(),
            Some("done" | "cancelled")
        )
        && (reference["record"]["kind"] != "dependency"
            || reference["record"]["targetStatus"] != "done")
}

pub(crate) fn local_answer(context: &Value) -> Value {
    let question = text(context, "question");
    let all = references(context);
    let query = search::Query::from_payload(context).unwrap_or_else(|_| terms(question));
    let date = text(context, "date");
    let today = NaiveDate::parse_from_str(date, "%Y-%m-%d").unwrap();
    let week_start = (today - Duration::days(today.weekday().num_days_from_monday() as i64))
        .format("%Y-%m-%d")
        .to_string();
    let week_end = (today + Duration::days(6 - today.weekday().num_days_from_monday() as i64))
        .format("%Y-%m-%d")
        .to_string();
    let mut lines = Vec::new();
    let mut selected = Vec::new();
    let item_limit = |default: usize| match context["preferences"]["answerStyle"].as_str() {
        Some("concise") => default.min(5),
        Some("detailed") => (default * 2).min(24),
        _ => default,
    };
    let display_limit = match context["preferences"]["answerStyle"].as_str() {
        Some("concise") => 5,
        Some("detailed") => 12,
        _ => 10,
    };
    let mut limitations = context["limitations"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    // Read uniquely named task fields directly, without generating a value or
    // confusing an unrelated task's owner with the requested entity.
    let named_tasks = all
        .iter()
        .filter(|r| r["kind"] == "task" && query.names(text(r, "title")))
        .collect::<Vec<_>>();
    let owner_question = ["谁", "负责人", "owner", "assignee"]
        .iter()
        .any(|w| question.contains(w));
    let date_question = ["截止", "到期", "deadline", "due date"]
        .iter()
        .any(|w| question.contains(w));
    let compound = ["，", ",", "；", ";", "以及", "同时", "、"]
        .iter()
        .any(|w| question.contains(w));
    let causal = ["为什么", "为何", "原因", "根因"]
        .iter()
        .any(|w| question.contains(w));
    let other_task_detail = [
        "进展",
        "进度",
        "状态",
        "风险",
        "阻塞",
        "依赖",
        "预计",
        "原因",
        "为什么",
    ]
    .iter()
    .any(|word| question.contains(word));
    if named_tasks.len() == 1
        && (owner_question || date_question)
        && (!compound || (owner_question && date_question))
        && !causal
        && !other_task_detail
        && task_fields_only(question, text(named_tasks[0], "title"))
    {
        let reference = named_tasks[0];
        let mut fields = Vec::new();
        let mut unknowns = Vec::new();
        let mut known = 0;
        for (requested, field, label) in [
            (owner_question, "assignee", "负责人"),
            (date_question, "dueDate", "截止日期"),
        ] {
            if !requested {
                continue;
            }
            let value = reference["record"][field]
                .as_str()
                .filter(|s| !s.trim().is_empty());
            fields.push(format!(
                "{}的{}：{}。 [1]",
                text(reference, "title"),
                label,
                value.unwrap_or("未记录")
            ));
            if value.is_some() {
                known += 1;
            } else {
                unknowns.push(format!(
                    "{}的{}尚未记录，需补充确认。",
                    text(reference, "title"),
                    label
                ));
            }
        }
        let mut answer = result(
            context,
            fields.join("\n"),
            vec![reference.clone()],
            "local",
            limitations,
        );
        answer["queryMode"] = json!("structured_field");
        answer["status"] = json!(if known == 0 {
            "unknown"
        } else if unknowns.is_empty() {
            "answered"
        } else {
            "partial"
        });
        answer["grounded"] = json!(known > 0);
        answer["unknowns"] = json!(unknowns);
        return answer;
    }
    let follow = question.contains('催')
        || question.contains("先跟进")
        || question.contains("提醒")
        || question.contains("跟进谁");
    let blocked = question.contains("阻塞")
        || question.contains("卡在")
        || question.contains("哪里卡")
        || question.contains("依赖");
    let milestones =
        question.contains("里程碑") || question.contains("交付物") || question.contains("目标");
    let delivery_risk = question.contains("延期")
        || question.contains("延误")
        || question.contains("延迟")
        || question.contains("风险");
    let today_plan = question.contains("排期")
        || question.contains("日程")
        || (question.contains("安排")
            && ["今天", "今日", "本周", "这周"]
                .iter()
                .any(|w| question.contains(w)));
    let specific_memory = all
        .iter()
        .any(|r| r["kind"] == "memory" && query.score("", text(r, "content")) > 0)
        && !["哪里有阻塞", "哪些阻塞", "有哪些依赖"]
            .iter()
            .any(|w| question.contains(w));
    let decisions = question.contains("决策") || question.contains("决定");
    let pending_decisions =
        question.contains("待决策") || question.contains("待拍板") || question.contains("未决事项");
    let management_kind = if question.contains("验收") || question.contains("整改") {
        Some("deliverable")
    } else if question.contains("变更") {
        Some("change")
    } else if question.contains("周报") {
        Some("weekly_report")
    } else if question.contains("会议")
        || question.contains("会前")
        || question.contains("议程")
        || question.contains("行动项")
    {
        Some("meeting")
    } else if question.contains("风险")
        || question.contains("问题")
        || question.contains("拍板")
        || pending_decisions
    {
        Some("governance")
    } else {
        None
    };
    let explicit_management = question.contains("交付验收")
        || question.contains("需求变更")
        || question.contains("周报")
        || question.contains("会议")
        || question.contains("会前")
        || question.contains("行动项")
        || pending_decisions
        || question.contains("拍板");
    let named_work_record = all.iter().any(|r| {
        matches!(r["kind"].as_str(), Some("task" | "milestone" | "memory"))
            && !text(r, "title").is_empty()
            && question
                .to_lowercase()
                .contains(&text(r, "title").to_lowercase())
    });
    if let Some(kind) = management_kind.filter(|kind| {
        explicit_management || (!named_work_record && all.iter().any(|r| r["kind"] == *kind))
    }) {
        let subtype = if question.contains("拍板") || pending_decisions {
            Some("decision")
        } else if question.contains("风险") {
            Some("risk")
        } else if question.contains("问题") {
            Some("issue")
        } else {
            None
        };
        let named_meetings = all
            .iter()
            .filter(|r| {
                r["kind"] == "meeting"
                    && !text(r, "title").is_empty()
                    && question.contains(text(r, "title"))
            })
            .map(|r| r["managementId"].clone())
            .collect::<Vec<_>>();
        let mut matches = all
            .iter()
            .filter(|r| {
                (r["kind"] == kind || (kind == "meeting" && r["kind"] == "meeting_action"))
                    && (kind != "meeting"
                        || named_meetings.is_empty()
                        || named_meetings.contains(&r["managementId"]))
                    && !(question.contains("未结")
                        && r["kind"] == "meeting_action"
                        && matches!(
                            r["record"]["completionState"].as_str(),
                            Some("done" | "dismissed")
                        ))
                    && (kind != "governance" || subtype.is_none_or(|s| r["record"]["kind"] == s))
                    && (!pending_decisions || r["record"]["status"] != "closed")
            })
            .collect::<Vec<_>>();
        matches
            .sort_by_key(|r| std::cmp::Reverse(query.score(text(r, "title"), text(r, "content"))));
        lines.push(format!("截至 {date} 的项目管理记录："));
        for reference in matches.iter().take(item_limit(12)) {
            push_reference(
                &mut lines,
                &mut selected,
                reference,
                format!(
                    "• {}：{}",
                    text(reference, "title"),
                    text(reference, "content")
                ),
            );
        }
        if matches.is_empty() {
            lines.push("当前范围没有对应的已记录管理事项，请先在项目管理中记录。".into());
        }
        let mut answer = result(context, lines.join("\n"), selected, "local", limitations);
        if kind == "governance"
            && pending_decisions
            && !compound
            && !causal
            && workflow_lookup_only(question)
            && (question.contains("哪些") || question.contains("列出"))
            && !all.iter().any(|reference| {
                reference["kind"] == "governance" && question.contains(text(reference, "title"))
            })
            && !["优先", "建议", "推荐", "方案"]
                .iter()
                .any(|word| question.contains(word))
        {
            answer["queryMode"] = json!("pending_decisions");
        }
        return answer;
    }
    if follow {
        lines.push(format!(
            "截至 {date}，建议按阻塞、逾期、到期和长期未更新的顺序跟进："
        ));
        let mut ranked = Vec::new();
        for reference in all
            .iter()
            .filter(|r| r["kind"] == "task" && active(&r["record"]))
        {
            let t = &reference["record"];
            let follow_up = records(context, "followUps")
                .iter()
                .find(|f| f["taskId"] == t["id"]);
            if follow_up.is_some_and(|f| f["snoozedUntil"].as_str().is_some_and(|s| s > date)) {
                continue;
            }
            let due = t["dueDate"].as_str();
            let stale_record = (t["status"] == "in_progress" || t["category"] == "follow_up")
                && NaiveDate::parse_from_str(text(t, "workDate"), "%Y-%m-%d")
                    .ok()
                    .is_some_and(|day| (today - day).num_days() >= 3);
            let planned_follow = follow_up
                .is_some_and(|f| f["nextFollowUpDate"].as_str().is_some_and(|d| d <= date));
            let due_soon = due.is_some_and(|d| {
                d <= (today + Duration::days(3))
                    .format("%Y-%m-%d")
                    .to_string()
                    .as_str()
            });
            let score = if t["status"] == "blocked" {
                500
            } else if due.is_some_and(|d| d < date) {
                400
            } else if planned_follow {
                350
            } else if due_soon {
                300
            } else if stale_record {
                200
            } else {
                0
            };
            if score > 0 {
                ranked.push((score, reference, follow_up));
            }
        }
        ranked.sort_by(|a, b| {
            b.0.cmp(&a.0)
                .then_with(|| a.1["id"].as_str().cmp(&b.1["id"].as_str()))
        });
        for (_, reference, follow_up) in ranked.iter().take(item_limit(12)) {
            let task = &reference["record"];
            let reason = if task["status"] == "blocked" {
                "当前阻塞"
            } else if task["dueDate"].as_str().is_some_and(|d| d < date) {
                "已过截止日期"
            } else if follow_up
                .is_some_and(|f| f["nextFollowUpDate"].as_str().is_some_and(|d| d <= date))
            {
                "已到约定跟进日"
            } else {
                "即将到期或至少 3 天未更新"
            };
            push_reference(
                &mut lines,
                &mut selected,
                reference,
                format!("• {}（{}）", reference["content"].as_str().unwrap(), reason),
            );
            if let Some(f) = follow_up {
                if let Some(r) = all
                    .iter()
                    .find(|r| r["kind"] == "follow_up" && r["taskId"] == f["taskId"])
                {
                    push_reference(
                        &mut lines,
                        &mut selected,
                        r,
                        format!("  跟进记录：{}", text(r, "content")),
                    );
                }
            }
        }
        if ranked.is_empty() {
            lines.push("已检索记录中，没有命中上述规则的待跟进事项。".into());
        }
        if blocked {
            lines.push("同时列出当前未解除的依赖和阻塞依据：".into());
            for reference in all
                .iter()
                .filter(|r| unresolved_relation(r))
                .take(item_limit(8))
            {
                push_reference(
                    &mut lines,
                    &mut selected,
                    reference,
                    format!(
                        "• {}：{}",
                        text(reference, "title"),
                        text(reference, "content")
                    ),
                );
            }
        }
        limitations.push(json!(
            "催办建议由本地规则排序；没有发送消息。未设负责人时需先确认负责人。"
        ));
    } else if blocked && !specific_memory {
        lines.push(format!("截至 {date} 的已记录阻塞和依赖："));
        for reference in all
            .iter()
            .filter(|r| r["kind"] == "task" && r["record"]["status"] == "blocked")
            .take(item_limit(12))
        {
            push_reference(
                &mut lines,
                &mut selected,
                reference,
                format!("• {}", text(reference, "content")),
            );
        }
        for reference in all
            .iter()
            .filter(|r| unresolved_relation(r))
            .take(item_limit(12))
        {
            push_reference(
                &mut lines,
                &mut selected,
                reference,
                format!(
                    "• {}：{}",
                    text(reference, "title"),
                    text(reference, "content")
                ),
            );
        }
        if selected.is_empty() {
            lines.push(
                "已检索记录中，没有明确标记的阻塞或未完成依赖；这不代表不存在未记录的问题。".into(),
            );
        }
    } else if delivery_risk {
        lines.push(format!("截至 {date}，已记录的交付延期信号："));
        for reference in all
            .iter()
            .filter(|r| r["kind"] == "milestone" && r["record"]["status"] != "cancelled")
        {
            let m = &reference["record"];
            let slipped = m["status"] != "completed"
                && match (m["baselineDate"].as_str(), m["forecastDate"].as_str()) {
                    (Some(base), Some(forecast)) => forecast > base,
                    _ => false,
                };
            let overdue = m["status"] != "completed"
                && m["forecastDate"]
                    .as_str()
                    .or(m["baselineDate"].as_str())
                    .is_some_and(|d| d < date);
            let reopened = m["status"] == "completed" && m["completionBlocked"] == true;
            if slipped || overdue || reopened {
                let reason = if reopened {
                    "已完成里程碑的关联任务尚未全部完成，需复核"
                } else if overdue {
                    "已超过已记录的交付日期"
                } else {
                    "当前预计日期晚于原定日期"
                };
                push_reference(
                    &mut lines,
                    &mut selected,
                    reference,
                    format!("• {}（{}）", text(reference, "content"), reason),
                );
            }
            if selected.len() >= 12 {
                break;
            }
        }
        for reference in all
            .iter()
            .filter(|r| {
                r["kind"] == "task"
                    && active(&r["record"])
                    && (r["record"]["status"] == "blocked"
                        || r["record"]["dueDate"].as_str().is_some_and(|d| d < date))
            })
            .take(item_limit(8))
        {
            push_reference(
                &mut lines,
                &mut selected,
                reference,
                format!("• 任务交付信号：{}", text(reference, "content")),
            );
        }
        for reference in all
            .iter()
            .filter(|r| {
                r["kind"] == "project"
                    && r["record"]["status"] == "active"
                    && r["record"]["targetDate"].as_str().is_some_and(|d| d < date)
            })
            .take(item_limit(4))
        {
            push_reference(
                &mut lines,
                &mut selected,
                reference,
                format!(
                    "• 项目目标日期已过：{}；{}",
                    text(reference, "title"),
                    text(reference, "content")
                ),
            );
        }
        if selected.is_empty() {
            lines.push("已检索记录中，尚无明确的逾期、日期后移或阻塞信号。未填写交付日期的事项仍需人工确认。".into());
        }
        limitations.push(json!(
            "以上是根据已记录日期、状态生成的提示，不是未来交付预测；不会推算或补填预计完成日期。"
        ));
    } else if today_plan {
        lines.push(format!("{date} 已记录的安排："));
        let scheduled = all
            .iter()
            .filter(|r| r["kind"] == "plan" && r["record"]["date"] == date)
            .collect::<Vec<_>>();
        for reference in scheduled.iter().take(item_limit(18)) {
            push_reference(
                &mut lines,
                &mut selected,
                reference,
                format!(
                    "• 已确认日程：{}，{}",
                    text(reference, "title"),
                    text(reference, "content")
                ),
            );
        }
        for reference in all
            .iter()
            .filter(|r| {
                r["kind"] == "task"
                    && active(&r["record"])
                    && r["record"]["plannedDate"] == date
                    && !scheduled.iter().any(|s| s["taskId"] == r["taskId"])
            })
            .take(item_limit(10))
        {
            push_reference(
                &mut lines,
                &mut selected,
                reference,
                format!("• 任务计划日期为今日：{}", text(reference, "content")),
            );
        }
        if selected.is_empty() {
            lines.push("尚未记录当日已确认日程，或计划日期为当日的未完成任务。".into());
        }
        limitations.push(json!(
            "已确认日程与任务计划日期都表示安排，不能据此认定已经执行或完成。"
        ));
    } else if decisions {
        lines.push("最近的已确认当前项目决策：".into());
        for reference in all
            .iter()
            .filter(|r| r["kind"] == "memory" && r["record"]["kind"] == "decision")
            .take(item_limit(10))
        {
            push_reference(
                &mut lines,
                &mut selected,
                reference,
                format!(
                    "• {}（更新于 {}）",
                    text(reference, "content"),
                    text(reference, "updatedAt")
                ),
            );
        }
        if selected.is_empty() {
            lines.push("当前范围尚无可引用的已确认决策。".into());
        }
        limitations.push(json!(
            "决策记录只说明当前已确认内容；关联任务的执行状态需按任务进展核实。"
        ));
    } else if milestones {
        lines.push(format!("截至 {date} 的项目目标与里程碑："));
        for reference in all
            .iter()
            .filter(|r| matches!(r["kind"].as_str(), Some("project" | "milestone")))
            .take(item_limit(18))
        {
            push_reference(
                &mut lines,
                &mut selected,
                reference,
                format!(
                    "• {}：{}",
                    text(reference, "title"),
                    text(reference, "content")
                ),
            );
        }
    } else {
        let search = &query;
        let mut matched = all
            .iter()
            .filter(|r| {
                matches!(
                    r["kind"].as_str(),
                    Some(
                        "task"
                            | "memory"
                            | "milestone"
                            | "follow_up"
                            | "governance"
                            | "change"
                            | "deliverable"
                            | "meeting"
                            | "meeting_action"
                            | "weekly_report"
                    )
                )
            })
            .map(|r| {
                let score = search.score(text(r, "title"), text(r, "content"));
                (
                    if score > 0 {
                        score + intent_score(context, r)
                    } else {
                        0
                    },
                    r,
                )
            })
            .filter(|(score, _)| *score > 0)
            .collect::<Vec<_>>();
        matched.sort_by(|a, b| {
            b.0.cmp(&a.0)
                .then_with(|| a.1["id"].as_str().cmp(&b.1["id"].as_str()))
        });
        let overview = question.contains("本周")
            || question.contains("这周")
            || question.contains("总览")
            || question.contains("概览")
            || question.contains("怎么样")
            || question.contains("状态")
            || question.contains("进展")
            || question.contains("进度");
        if !matched.is_empty() {
            lines.push("找到以下当前记录：".into());
            for (_, reference) in matched.iter().take(display_limit) {
                push_reference(
                    &mut lines,
                    &mut selected,
                    reference,
                    format!("• {}", text(reference, "content")),
                );
            }
        } else if overview {
            lines.push(format!(
                "截至 {date} 的当前状态（本周 {week_start} 至 {week_end}）："
            ));
            for project in records(context, "projects") {
                let summary = &project["taskSummary"];
                if let Some(reference) = all
                    .iter()
                    .find(|r| r["kind"] == "project" && r["projectId"] == project["id"])
                {
                    push_reference(
                        &mut lines,
                        &mut selected,
                        reference,
                        format!(
                            "• {}：任务 {} 项，已完成 {}，阻塞 {}。{}",
                            text(project, "name"),
                            summary["total"],
                            summary["done"],
                            summary["blocked"],
                            text(reference, "content")
                        ),
                    );
                }
            }
            for reference in all
                .iter()
                .filter(|r| {
                    r["kind"] == "task"
                        && (r["record"]["status"] == "blocked"
                            || r["record"]["workDate"].as_str().is_some_and(|d| {
                                d >= week_start.as_str() && d <= week_end.as_str()
                            }))
                })
                .take(item_limit(10))
            {
                push_reference(
                    &mut lines,
                    &mut selected,
                    reference,
                    format!("• {}", text(reference, "content")),
                );
            }
            for reference in all
                .iter()
                .filter(|r| {
                    r["kind"] == "milestone"
                        && (r["record"]["status"] != "completed"
                            || r["record"]["completionBlocked"] == true)
                        && r["record"]["status"] != "cancelled"
                })
                .take(item_limit(4))
            {
                push_reference(
                    &mut lines,
                    &mut selected,
                    reference,
                    format!("• {}", text(reference, "content")),
                );
            }
            for reference in all
                .iter()
                .filter(|r| r["kind"] == "plan" && r["record"]["date"] == date)
                .take(item_limit(4))
            {
                push_reference(
                    &mut lines,
                    &mut selected,
                    reference,
                    format!(
                        "• 今日安排：{}，{}",
                        text(reference, "title"),
                        text(reference, "content")
                    ),
                );
            }
            for reference in all
                .iter()
                .filter(|r| {
                    r["kind"] == "report"
                        && r["record"]["date"]
                            .as_str()
                            .is_some_and(|d| d >= week_start.as_str() && d <= week_end.as_str())
                })
                .take(item_limit(2))
            {
                push_reference(
                    &mut lines,
                    &mut selected,
                    reference,
                    format!(
                        "• 已保存日报摘要（历史快照）：{}",
                        clip(text(reference, "content"), 500)
                    ),
                );
            }
            limitations.push(json!("当前状态来自最新记录；日报是生成时的历史快照。只有最新进展在本周的任务列入本周进展，不能据此重建完整周报。"));
        } else {
            lines.push("本地记录中未找到与问题匹配的充分依据。可以询问“今天先催谁”“哪里有阻塞”“本周状态”，或提供任务名称。".into());
            limitations.push(json!(
                "本地模式按关键词匹配当前记录，不能回答没有证据的因果或预测问题。"
            ));
        }
    }
    if records(context, "tasks").is_empty() {
        limitations.push(json!("当前范围尚无任务进展记录。"));
    }
    if records(context, "milestones").is_empty() {
        limitations.push(json!("当前范围尚无里程碑记录。"));
    }
    if follow {
        match context["preferences"]["reminderStyle"].as_str() {
            Some("gentle") => lines.insert(
                0,
                "跟进建议：可先向对方确认进展，再一起核对阻塞与期限。".into(),
            ),
            Some("direct") => {
                lines.insert(0, "跟进重点：请优先核对下面记录中的阻塞与期限。".into())
            }
            _ => {}
        }
    }
    let mut answer = result(context, lines.join("\n"), selected, "local", limitations);
    // The priority order is a documented product rule, not a missing fact the
    // language model needs to guess or demand an explicit human ranking for.
    if follow
        && !compound
        && !causal
        && !named_work_record
        && workflow_lookup_only(question)
        && ["先催", "先跟进", "优先跟进"]
            .iter()
            .any(|word| question.contains(word))
    {
        answer["queryMode"] = json!("follow_up_priority");
    }
    if delivery_risk
        && !follow
        && !blocked
        && !compound
        && !causal
        && !named_work_record
        && workflow_lookup_only(question)
        && question.contains("哪些")
        && question.contains("交付")
        && question.contains("可能")
    {
        // This lists existing date slips/blockers. It makes no prediction that
        // an unrecorded delay has or has not actually happened.
        answer["queryMode"] = json!("delivery_risk_signals");
    }
    answer
}

pub(crate) fn deterministic(answer: &Value) -> bool {
    matches!(
        answer["queryMode"].as_str(),
        Some(
            "structured_field"
                | "follow_up_priority"
                | "pending_decisions"
                | "delivery_risk_signals"
        )
    )
}

fn result(
    context: &Value,
    answer: String,
    citations: Vec<Value>,
    mode: &str,
    limitations: Vec<Value>,
) -> Value {
    let grounded = !citations.is_empty();
    let last = references(context)
        .iter()
        .filter_map(|r| r["updatedAt"].as_str())
        .max()
        .map(str::to_owned);
    json!({"answer":answer,"grounded":grounded,"mode":mode,"citations":citations,"updatedAt":context["capturedAt"],"dataUpdatedAt":last,"limitations":limitations,"context":context,"status":if grounded {"answered"} else {"unknown"}})
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ModelAnswer {
    grounded: bool,
    answer: String,
    citation_ids: Vec<String>,
}
fn model_output(context: &Value, candidates: &[Value], output: Value) -> Result<Value> {
    let normalized = crate::answer_contract::normalize(output, candidates, "id").map_err(|_| {
        AppError::new(
            "ASSISTANT_GROUNDING",
            "回答断言缺少当前正文支持或引用不一致",
        )
    })?;
    let output: ModelAnswer = serde_json::from_value(json!({"grounded":normalized["grounded"],"answer":normalized["answer"],"citationIds":normalized["citationIds"]}))
        .map_err(|_| AppError::new("ASSISTANT_MODEL_SCHEMA", "模型问答格式无效，请重新提问"))?;
    if !output.grounded {
        let mut answer = refused(context);
        crate::answer_contract::attach(&mut answer, &normalized);
        return Ok(answer);
    }
    if output.answer.trim().is_empty()
        || output.answer.chars().count() > 6_000
        || output.citation_ids.is_empty()
        || output.citation_ids.len() > MAX_REFERENCES
    {
        return Err(AppError::new(
            "ASSISTANT_GROUNDING",
            "模型没有提供有效依据，请重新提问",
        ));
    }
    let mut seen = HashSet::new();
    let mut citations = Vec::new();
    for id in output.citation_ids {
        if !seen.insert(id.clone()) {
            return Err(AppError::new(
                "ASSISTANT_GROUNDING",
                "模型引用重复，请重新提问",
            ));
        }
        citations.push(
            candidates
                .iter()
                .find(|r| r["id"] == id)
                .ok_or_else(|| {
                    AppError::new(
                        "ASSISTANT_GROUNDING",
                        "模型引用了本次范围以外的记录，请重新提问",
                    )
                })?
                .clone(),
        );
    }
    let mut answer = result(
        context,
        output.answer.trim().into(),
        citations,
        "model",
        context["limitations"]
            .as_array()
            .cloned()
            .unwrap_or_default(),
    );
    crate::answer_contract::attach(&mut answer, &normalized);
    Ok(answer)
}

pub(crate) fn render_reviewed_output(
    context: &Value,
    references: &[Value],
    raw: Value,
) -> Result<Value> {
    model_output(context, references, raw)
}

/// The exact bounded reference set sent to a model. Kept separately so offline
/// evaluations can measure retrieval independently from model generation.
pub(crate) fn model_candidates(context: &Value, local_answer: &Value) -> Vec<Value> {
    let local_ids = local_answer["citations"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|r| r["id"].as_str())
        .collect::<HashSet<_>>();
    let query =
        search::Query::from_payload(context).unwrap_or_else(|_| terms(text(context, "question")));
    let mut memory_order = 0usize;
    let mut ranked = references(context)
        .into_iter()
        .filter_map(|r| {
            // The shared corpus ranker has already selected and ordered current
            // memories using body relevance, diversity and bounded neighbours.
            // Re-scoring the common source title or insisting on another token
            // hit here used to discard useful companion assertions.
            if r["kind"] == "memory" {
                let score = 1000usize.saturating_sub(memory_order) + intent_score(context, &r);
                memory_order += 1;
                return Some((score, r));
            }
            let lexical = query.score(text(&r, "title"), text(&r, "content"));
            let local = local_ids.contains(text(&r, "id"));
            if lexical == 0 && !local && !query.overview() {
                return None;
            }
            let score = usize::from(local) * 200 + lexical + intent_score(context, &r);
            Some((score, r))
        })
        .collect::<Vec<_>>();
    ranked.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then_with(|| a.1["id"].as_str().cmp(&b.1["id"].as_str()))
    });
    let reference_limit = if query.overview() { MAX_REFERENCES } else { 24 };
    let char_limit = if query.overview() {
        MAX_MODEL_CHARS
    } else {
        36_000
    };
    let mut candidates = Vec::new();
    let mut chars = 0;
    let mut kind_counts = std::collections::HashMap::<String, usize>::new();
    for (_, r) in ranked {
        let kind_limit = if r["kind"] == "memory" {
            24
        } else if query.overview() {
            20
        } else {
            6
        };
        let size = crate::answer_contract::indexed_references(std::slice::from_ref(&r))[0]
            .to_string()
            .chars()
            .count()
            + 2; // Reserve for the final multi-digit reference index.
        let count = kind_counts.entry(text(&r, "kind").to_owned()).or_default();
        if candidates.len() < reference_limit && chars + size < char_limit && *count < kind_limit {
            chars += size;
            *count += 1;
            candidates.push(r);
        }
    }
    crate::qa::with_source_passages(
        crate::question_target::model_target_references(text(context, "question"), &candidates),
        context,
    )
}

pub(crate) fn ask(engine: &Engine, payload: &Value) -> Result<Value> {
    ask_shared(&engine.inner.sender, &engine.inner.root, payload, false)
}

/// Connector/preview callers must name one project. Never interpret `all` or
/// an absent project as permission to disclose the whole workspace to a group.
pub(crate) fn ask_project_question(
    sender: &mpsc::SyncSender<crate::Message>,
    root: &Path,
    payload: &Value,
) -> Result<Value> {
    let project = required(payload, "projectId")?;
    if project == "all" {
        return Err(AppError::new("VALIDATION", "群问答必须选择一个项目"));
    }
    let mut request = payload.clone();
    request["useModel"] = json!(match payload.get("useModel") {
        None => true,
        Some(Value::Bool(enabled)) => *enabled,
        _ => return Err(AppError::new("VALIDATION", "useModel 必须为布尔值")),
    });
    let mut answer = ask_shared(sender, root, &request, true)?;
    append_reply_evidence(&mut answer);
    Ok(answer)
}

/// Render group-visible labels from validated records, never model prose.
/// Desktop renders these same citations as navigable records instead.
fn append_reply_evidence(answer: &mut Value) {
    let mut body = answer["answer"].as_str().unwrap_or_default().to_owned();
    if answer["grounded"] != true {
        return;
    }
    body.push_str("\n\n依据：");
    for (index, citation) in records(answer, "citations").iter().enumerate() {
        let kind = match text(citation, "kind") {
            "task" => "任务",
            "memory" => "项目记忆",
            "source_passage" => "原文段落",
            "milestone" => "里程碑",
            "project" => "项目目标",
            "report" => "日报快照",
            "relation" => "依赖与阻塞",
            "plan" => "已确认排期",
            "follow_up" => "跟进记录",
            "governance" => "风险与决策",
            "change" => "需求变更",
            "deliverable" => "交付验收",
            "meeting" | "meeting_action" => "会议记录",
            "weekly_report" => "周报快照",
            _ => "项目记录",
        };
        let title = citation["title"]
            .as_str()
            .or_else(|| citation["sourceTitle"].as_str())
            .unwrap_or(kind)
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        body.push_str(&format!(
            "\n[{}] {} · {}",
            index + 1,
            kind,
            clip(&title, 100)
        ));
        if let Some(version) = citation["revision"]
            .as_u64()
            .or_else(|| citation["record"]["version"].as_u64())
        {
            body.push_str(&format!(" · v{version}"));
        }
        if let Some(updated) = citation["updatedAt"].as_str() {
            body.push_str(&format!(" · 更新 {}", clip(updated, 40)));
        }
        for evidence in records(citation, "evidence").iter().take(2) {
            body.push_str(&format!(
                "（{} · {}）",
                clip(text(evidence, "sourceTitle"), 80),
                clip(text(evidence, "locator"), 80)
            ));
        }
    }
    if let Some(date) = answer["context"]["date"].as_str() {
        body.push_str(&format!(
            "\n核对日期：{date}；依据当前记录，历史报告保留生成时的状态。"
        ));
    }
    answer["answer"] = json!(body);
}

fn ask_shared(
    sender: &mpsc::SyncSender<crate::Message>,
    root: &Path,
    payload: &Value,
    require_model: bool,
) -> Result<Value> {
    let configuration = settings::load(root)?;
    // Automatic replies retain explicit model/material authorization. Desktop
    // questions may still fall back to local rules when a model is unavailable.
    if require_model && payload["useModel"] == true {
        configuration.validate_material_access()?;
    }
    crate::question_flow::run(
        &configuration,
        payload,
        true,
        |payload| {
            crate::actor_call(
                sender,
                Request {
                    command: "_assistant_context".into(),
                    payload,
                },
            )
        },
        |context| {
            crate::actor_call(
                sender,
                Request {
                    command: "_validate_assistant_context".into(),
                    payload: context.clone(),
                },
            )
            .map(|_| ())
        },
    )
}

pub(crate) fn refused(context: &Value) -> Value {
    let mut answer = result(
        context,
        "现有记录不足以支持完整结论或问题前提，请核对原文或补充记录。".into(),
        vec![],
        "model",
        context["limitations"]
            .as_array()
            .cloned()
            .unwrap_or_default(),
    );
    answer["claims"] = json!([]);
    answer["unknowns"] = json!([]);
    answer
}

pub(crate) fn model_answer(
    configuration: &settings::SavedSettings,
    context: &Value,
    budget: &mut crate::question_flow::Budget,
) -> Result<Value> {
    model_answer_with_selection(configuration, context, budget, None)
}

// Selection is controller-owned and cannot widen the original model pack or
// change the context snapshot used by the Engine's final validation.
pub(crate) fn model_answer_with_selection(
    configuration: &settings::SavedSettings,
    context: &Value,
    budget: &mut crate::question_flow::Budget,
    selected_ids: Option<&[String]>,
) -> Result<Value> {
    model_answer_with_input(configuration, context, budget, selected_ids, None)
}

pub(crate) fn model_answer_incremental(
    configuration: &settings::SavedSettings,
    context: &Value,
    budget: &mut crate::question_flow::Budget,
    previous: &Value,
    missing: &[Value],
) -> Result<Value> {
    model_answer_with_input(
        configuration,
        context,
        budget,
        None,
        Some((previous, missing)),
    )
}

fn model_answer_with_input(
    configuration: &settings::SavedSettings,
    context: &Value,
    budget: &mut crate::question_flow::Budget,
    selected_ids: Option<&[String]>,
    incremental: Option<(&Value, &[Value])>,
) -> Result<Value> {
    let local = local_answer(context);
    if deterministic(&local) {
        return Ok(local);
    }
    let candidates = crate::answer_contract::select_current_references(
        &model_candidates(context, &local),
        selected_ids,
    )?;
    if candidates.is_empty() {
        return Ok(refused(context));
    }
    let reader = crate::answer_contract::evidence_reader(context, &candidates, incremental)?;
    let model_chars = reader.input["references"]
        .as_array()
        .unwrap()
        .iter()
        .map(|reference| reference.to_string().chars().count())
        .sum::<usize>();
    let output = budget.complete(
        configuration,
        &reader.system,
        reader.input,
        reader.schema,
        "personal_project_assistant",
    )?;
    let mut answer = model_output(context, &candidates, output)?;
    if let Some((previous, _)) = incremental {
        answer["incrementalBase"] = previous.clone();
    }
    if selected_ids.is_some() {
        answer["referenceSelection"] = json!({"version":"current-reference-subset-v1",
            "reason":"explicit-target-correction","maxReferences":6,
            "referenceIds":candidates.iter().map(|r|r["id"].clone()).collect::<Vec<_>>()});
    }
    answer["contextPack"] = json!({"version":"current-content-pack-v2-indexed-spans",
        "maxReferences":if selected_ids.is_some() {6} else if terms(text(context,"question")).overview() {MAX_REFERENCES} else {32},
        "maxModelChars":if terms(text(context,"question")).overview() {MAX_MODEL_CHARS} else {36_000},
        "returned":candidates.len(),"modelChars":model_chars});
    if references(context).len() > candidates.len() {
        answer["limitations"].as_array_mut().unwrap().push(json!(
            "模型只接收本次筛选的有限记录；请缩小项目范围或提供任务名称以精确查询。"
        ));
    }
    Ok(answer)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selected_reference_indices_keep_full_conditions_and_original_context() {
        let candidates = vec![
            json!({"id":"memory:other","memoryId":"other","projectId":"p","content":"The joint model contains two language models.","revision":1}),
            json!({"id":"memory:base","memoryId":"base","projectId":"p","content":"For archived reports, the individual model uses factorized probabilities.","revision":3,
                "facets":{"conditions":["For archived reports"]}}),
        ];
        let context = json!({"projectId":"p","question":"Which individual model is used?","memories":candidates,
            "fingerprint":"keep-original","limitations":[]});
        let original = context.clone();
        let selected = crate::answer_contract::select_current_references(
            &candidates,
            Some(&["memory:base".to_owned()]),
        )
        .unwrap();
        let output = json!({"grounded":true,"status":"answered","unknowns":[],"claims":[{
            "text":"For archived reports, the individual model uses factorized probabilities.",
            "supportSpans":[{"referenceIndex":1,"spanIndex":1}]}]});
        let answer = model_output(&context, &selected, output.clone()).unwrap();
        assert_eq!(answer["citations"][0]["id"], "memory:base");
        assert_eq!(answer["citations"][0]["facets"], candidates[1]["facets"]);
        assert_eq!(context, original);
        let mut forged = output;
        forged["claims"][0]["supportSpans"][0]["referenceIndex"] = json!(2);
        assert!(model_output(&context, &selected, forged).is_err());
    }

    #[test]
    fn focused_model_pack_preserves_corpus_memory_order_and_keeps_confirmed_companions() {
        let memories=(0..30).map(|index|json!({"id":format!("z-{:02}",29-index),"projectId":"p",
            "kind":"fact","content":if index==0 {"Atlas retention is 30 days.".to_owned()} else {format!("Its component {index} has an additional approval requirement.")},
            "sourceTitle":"Atlas handbook","revision":1,"updatedAt":"2026-10-20",
            "facets":{"entity":"","topic":"","role":"","conditions":[],"validFrom":null,"validUntil":null},
            "evidence":[{"text":"UNTRUSTED_OLD_SOURCE ".repeat(150),"locator":"section"}]})).collect::<Vec<_>>();
        let context = json!({"question":"Atlas retention","memories":memories});
        let original = context.clone();
        let candidates = model_candidates(&context, &json!({"citations":[]}));
        assert_eq!(candidates.len(), 24);
        for (index, candidate) in candidates.iter().enumerate() {
            assert_eq!(candidate["memoryId"], memories[index]["id"]);
            assert_eq!(candidate["content"], memories[index]["content"]);
            assert!(candidate.get("record").is_some());
        }
        assert_eq!(
            candidates[1]["content"],
            "Its component 1 has an additional approval requirement."
        );
        let projected = candidates
            .iter()
            .map(crate::answer_contract::model_reference)
            .collect::<Vec<_>>();
        assert!(
            projected
                .iter()
                .map(|r| r.to_string().chars().count())
                .sum::<usize>()
                < 36_000
        );
        assert!(!serde_json::to_string(&projected)
            .unwrap()
            .contains("UNTRUSTED_OLD_SOURCE"));
        assert!(
            candidates
                .iter()
                .map(|r| r.to_string().chars().count())
                .sum::<usize>()
                > 36_000
        );
        assert_eq!(context, original);
    }

    #[test]
    fn focused_model_pack_still_enforces_projected_character_cap() {
        let context = json!({"question":"Atlas policy","memories":(0..40).map(|index|json!({
            "id":format!("m-{index:02}"),"projectId":"p","kind":"fact",
            "content":format!("Atlas policy {index}: {}","x".repeat(5000)),"sourceTitle":"Atlas handbook","revision":1})).collect::<Vec<_>>()});
        let candidates = model_candidates(&context, &json!({"citations":[]}));
        assert!(candidates.len() < 24);
        assert!(
            candidates
                .iter()
                .map(crate::answer_contract::model_reference)
                .map(|r| r.to_string().chars().count())
                .sum::<usize>()
                < 36_000
        );
    }

    fn large_database() -> (tempfile::TempDir, crate::db::Database) {
        let directory = tempfile::tempdir().unwrap();
        let mut database = crate::db::Database::open(directory.path().to_path_buf()).unwrap();
        let tx = database.conn.transaction().unwrap();
        tx.execute_batch("INSERT INTO projects VALUES('p','当前项目','','2026-10-19T00:00:00Z'); INSERT INTO projects VALUES('other','隔离项目','','2026-10-19T00:00:00Z');").unwrap();
        for index in 0..340 {
            let id = format!("t{index:03}");
            // Every newer active record shares keywords with the old task,
            // while only the old task's complete title is in the question.
            let title = format!("历史审计专项 ALPHA 噪声 {index:03}");
            tx.execute("INSERT INTO tasks VALUES(?1,'p',?2,'','action',NULL,'high','in_progress',20,NULL,NULL,1,'manual',NULL,NULL,'2026-10-19T00:00:00Z','2026-10-19T00:00:00Z')",params![id,title]).unwrap();
        }
        tx.execute_batch("INSERT INTO tasks VALUES('legacy','p','历史审计专项 ALPHA','','action',NULL,'low','done',100,NULL,NULL,1,'manual',NULL,NULL,'2025-01-01T00:00:00Z','2025-01-01T00:00:00Z');
            INSERT INTO tasks VALUES('private','other','历史审计专项 ALPHA PRIVATE','','action',NULL,'high','blocked',0,NULL,NULL,1,'manual',NULL,NULL,'2026-10-19T00:00:00Z','2026-10-19T00:00:00Z');").unwrap();
        for index in 0..90 {
            let key = format!("memory{index:03}");
            let content = format!("普通项目决策 {index:03}");
            tx.execute("INSERT INTO memories VALUES(?1,'p','decision',?2,1,'active','最近纪要','2026-10-19T00:00:00Z','2026-10-19T00:00:00Z')",params![key,content]).unwrap();
            tx.execute(
                "INSERT INTO revisions VALUES(?1,?2,1,?3,'','confirmation','2026-10-19T00:00:00Z')",
                params![format!("revision{index:03}"), key, content],
            )
            .unwrap();
            tx.execute("INSERT INTO milestones VALUES(?1,'p',?2,'','planned',NULL,NULL,1,'2026-10-19T00:00:00Z','2026-10-19T00:00:00Z')",params![format!("milestone{index:03}"),format!("普通批次 {index:03}")]).unwrap();
        }
        tx.execute_batch("INSERT INTO memories VALUES('old-memory','p','decision','雪山协议保留审计日志',1,'active','雪山协议','2025-01-01T00:00:00Z','2025-01-01T00:00:00Z');
            INSERT INTO revisions VALUES('old-revision','old-memory',1,'雪山协议保留审计日志','','confirmation','2025-01-01T00:00:00Z');
            INSERT INTO milestones VALUES('old-milestone','p','旧批次雪山验收','','planned',NULL,NULL,1,'2025-01-01T00:00:00Z','2025-01-01T00:00:00Z');").unwrap();
        let today = NaiveDate::from_ymd_opt(2026, 10, 19).unwrap();
        for offset in 0..151 {
            let day = (today + Duration::days(offset))
                .format("%Y-%m-%d")
                .to_string();
            let key = format!("plan{offset:03}");
            tx.execute("INSERT INTO planning_drafts VALUES(?1,'schedule',?2,'p','applied','{}','{}','[]','2026-10-19T00:00:00Z')",params![key,day]).unwrap();
            tx.execute(
                "INSERT INTO daily_allocations VALUES(?1,'t000',60,0,'已确认检查日期安排',?2)",
                params![day, key],
            )
            .unwrap();
        }
        tx.commit().unwrap();
        (directory, database)
    }
    #[test]
    fn named_old_records_are_ranked_before_limits_without_leaking_project_scope() {
        let (_directory, database) = large_database();
        for (question, key, expected, limit) in [
            (
                "历史审计专项 ALPHA 的进展是什么？",
                "tasks",
                "legacy",
                MAX_TASKS,
            ),
            ("雪山协议是什么？", "memories", "old-memory", MAX_MEMORIES),
            (
                "旧批次雪山验收进展",
                "milestones",
                "old-milestone",
                MAX_MILESTONES,
            ),
            (
                "历史审计专项 ALPHA' OR 1=1 -- 进展",
                "tasks",
                "legacy",
                MAX_TASKS,
            ),
        ] {
            let payload = json!({"projectId":"p","question":question,"date":"2026-10-19"});
            let context = retrieve(&database.conn, &payload).unwrap();
            if key == "memories" {
                assert!(records(&context, key).len() <= limit);
            } else {
                assert_eq!(records(&context, key).len(), limit);
            }
            assert_eq!(context[key][0]["id"], expected, "{question}");
            assert!(!context.to_string().contains("PRIVATE"));
            assert_eq!(
                context["fingerprint"],
                retrieve(&database.conn, &payload).unwrap()["fingerprint"]
            );
            validate(&database.conn, &context).unwrap();
            assert_eq!(
                local_answer(&context)["citations"][0]["record"]["id"],
                expected,
                "{question}"
            );
        }
    }
    #[test]
    fn future_allocations_cannot_displace_the_inspected_day_or_current_week() {
        let (_directory, database) = large_database();
        let payload = json!({"projectId":"p","question":"今天安排了什么？","date":"2026-10-19"});
        let context = retrieve(&database.conn, &payload).unwrap();
        assert_eq!(records(&context, "plans").len(), 100);
        assert_eq!(context["plans"][0]["date"], "2026-10-19");
        assert!(records(&context, "plans")
            .iter()
            .take(7)
            .all(|p| text(p, "date") <= "2026-10-25"));
        let answer = local_answer(&context);
        assert!(records(&answer, "citations")
            .iter()
            .any(|c| c["kind"] == "plan" && c["record"]["date"] == "2026-10-19"));
        validate(&database.conn, &context).unwrap();
    }

    #[test]
    fn shared_search_ranks_aliases_before_limits_and_keeps_late_context() {
        let (_directory, database) = large_database();
        let content = format!(
            "{}ALPHA login audit retains records for 180 days.",
            "普通说明。".repeat(800)
        );
        database
            .conn
            .execute(
                "UPDATE memories SET content=? WHERE id='old-memory'",
                [&content],
            )
            .unwrap();
        database
            .conn
            .execute(
                "UPDATE revisions SET content=? WHERE id='old-revision'",
                [&content],
            )
            .unwrap();
        let payload =
            json!({"projectId":"p","question":"ＡＬＰＨＡ登录审计保留多久？","date":"2026-10-19"});
        let context = retrieve(&database.conn, &payload).unwrap();
        assert_eq!(context["memories"][0]["id"], "old-memory");
        assert!(text(&context["memories"][0], "content").contains("180 days"));
        assert!(!context.to_string().contains("PRIVATE"));
        validate(&database.conn, &context).unwrap();
        assert!(records(&local_answer(&context), "citations")
            .iter()
            .any(|r| r["record"]["id"] == "old-memory"));
    }

    #[test]
    fn task_description_matches_survive_both_sql_and_reference_ranking() {
        let (_directory, database) = large_database();
        let description = format!("{}雪山回滚演练需要保留离线备份。", "普通说明。".repeat(800));
        database
            .conn
            .execute(
                "UPDATE tasks SET title='历史准备事项',description=? WHERE id='legacy'",
                [&description],
            )
            .unwrap();
        let context = retrieve(
            &database.conn,
            &json!({"projectId":"p","question":"雪山回滚演练","date":"2026-10-19"}),
        )
        .unwrap();
        assert_eq!(context["tasks"][0]["id"], "legacy");
        assert!(text(&context["tasks"][0], "description").contains("离线备份"));
        let answer = local_answer(&context);
        assert_eq!(answer["citations"][0]["record"]["id"], "legacy");
        assert!(text(&answer, "answer").contains("离线备份"));
        validate(&database.conn, &context).unwrap();
    }
    fn example_context() -> Value {
        json!({"date":"2026-10-19","capturedAt":"2026-10-19T10:00:00+08:00","limitations":[],
            "projects":[{"id":"p","name":"项目甲","goal":"首发","status":"active","taskSummary":{"total":1,"done":0,"blocked":1},"updatedAt":"2026-10-19"}],
            "tasks":[{"id":"t","projectId":"p","title":"接口联调","status":"blocked","progress":30,"category":"action","assignee":"小林","dueDate":"2026-10-18","version":2,"latestNote":"等待接口约定","workDate":"2026-10-19","updatedAt":"2026-10-19"}],
            "relations":[{"id":"r","projectId":"p","taskId":"t","kind":"dependency","taskTitle":"接口联调","taskStatus":"blocked","targetTitle":"接口评审","targetStatus":"todo","reason":"先评审后联调","updatedAt":"2026-10-19"}],
            "milestones":[{"id":"m","projectId":"p","title":"首发验收","status":"in_progress","baselineDate":"2026-10-20","forecastDate":"2026-10-23","updatedAt":"2026-10-19"}],
            "plans":[{"id":"2026-10-19:t","projectId":"p","taskId":"t","title":"接口联调","date":"2026-10-19","minutes":60,"reason":"确认安排","updatedAt":"2026-10-19"}],
            "memories":[{"id":"mem","projectId":"p","kind":"decision","content":"审计日志保留 180 天","revision":1,"sourceTitle":"接口评审纪要","updatedAt":"2026-10-19"}]
        })
    }
    #[test]
    fn every_suggested_question_has_an_offline_intent_and_specific_citable_record() {
        for (question, expected, kind) in [
            ("今天先跟进谁？", "小林", "task"),
            ("本周卡在哪里？", "先评审后联调", "relation"),
            (
                "哪些交付可能延期？",
                "当前预计日期晚于原定日期",
                "milestone",
            ),
            ("项目整体进展怎么样？", "任务 1 项", "project"),
            ("今天安排了什么？", "60 分钟", "plan"),
            ("最近有哪些项目决策？", "审计日志保留 180 天", "memory"),
            (
                "这周上线卡在哪里，今天应该先跟进谁？",
                "先评审后联调",
                "relation",
            ),
        ] {
            let mut context = example_context();
            context["question"] = json!(question);
            let answer = local_answer(&context);
            assert!(
                answer["answer"].as_str().unwrap().contains(expected),
                "{question}: {}",
                answer["answer"]
            );
            assert!(
                records(&answer, "citations")
                    .iter()
                    .any(|c| c["kind"] == kind),
                "{question}"
            );
        }
    }
    #[test]
    fn completed_dependency_is_cleared_but_cancelled_dependency_requires_review() {
        let mut context = example_context();
        context["question"] = json!("哪里有阻塞");
        context["relations"][0]["targetStatus"] = json!("done");
        assert!(!records(&local_answer(&context), "citations")
            .iter()
            .any(|c| c["kind"] == "relation"));
        context["relations"][0]["targetStatus"] = json!("cancelled");
        assert!(records(&local_answer(&context), "citations")
            .iter()
            .any(|c| c["kind"] == "relation"));
    }
    #[test]
    fn invented_duplicate_and_missing_model_references_are_rejected() {
        let context = json!({"capturedAt":"2026-10-19T00:00:00Z","limitations":[]});
        let candidates = vec![json!({"id":"task:real","kind":"task","content":"已阻塞"})];
        for ids in [
            json!(["task:other-project"]),
            json!(["task:real", "task:real"]),
            json!([]),
        ] {
            assert_eq!(
                model_output(
                    &context,
                    &candidates,
                    json!({"grounded":true,"answer":"当前已阻塞","citationIds":ids})
                )
                .unwrap_err()
                .code,
                "ASSISTANT_GROUNDING"
            );
        }
        let answer = model_output(
            &context,
            &candidates,
            crate::answer_contract::fixture("当前已阻塞", json!(["task:real"]), "已阻塞"),
        )
        .unwrap();
        assert_eq!(answer["citations"], json!(candidates));
    }
}
