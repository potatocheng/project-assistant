//! Deterministic delivery oversight and local follow-up drafts. This module never
//! sends a message; reminders are derived from the selected local calendar date.
use crate::{id, now, required, tasks, AppError, Result};
use chrono::NaiveDate;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

pub(crate) fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch(r#"
CREATE TABLE project_profiles(project_id TEXT PRIMARY KEY REFERENCES projects(id),goal TEXT NOT NULL,status TEXT NOT NULL,target_date TEXT,version INTEGER NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE milestones(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),title TEXT NOT NULL,description TEXT NOT NULL,status TEXT NOT NULL,baseline_date TEXT,forecast_date TEXT,version INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE milestone_tasks(milestone_id TEXT NOT NULL REFERENCES milestones(id),task_id TEXT NOT NULL REFERENCES tasks(id),PRIMARY KEY(milestone_id,task_id));
CREATE TABLE task_follow_up_state(task_id TEXT PRIMARY KEY REFERENCES tasks(id),project_id TEXT NOT NULL REFERENCES projects(id),next_follow_up_date TEXT,snoozed_until TEXT,version INTEGER NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE task_follow_ups(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),project_id TEXT NOT NULL REFERENCES projects(id),version INTEGER NOT NULL,work_date TEXT NOT NULL,note TEXT NOT NULL,next_follow_up_date TEXT,recorded_at TEXT NOT NULL,UNIQUE(task_id,version));
CREATE INDEX milestone_project ON milestones(project_id);
CREATE INDEX follow_up_history ON task_follow_ups(task_id,work_date,version);
"#)?;
    Ok(())
}

fn invalid(message: &str) -> AppError {
    AppError::new("VALIDATION", message)
}
fn conflict() -> AppError {
    AppError::new("VERSION_CONFLICT", "内容已被更新，请刷新后重试")
}
fn integer(p: &Value, key: &str) -> Result<i64> {
    p[key]
        .as_i64()
        .filter(|n| *n >= 0)
        .ok_or_else(|| invalid("版本必须是非负整数"))
}
fn text(p: &Value, key: &str, maximum: usize, nonempty: bool) -> Result<String> {
    let value = p[key]
        .as_str()
        .ok_or_else(|| invalid(&format!("{key} 必须为文字")))?
        .trim();
    if value.chars().count() > maximum || (nonempty && value.is_empty()) {
        return Err(invalid(&format!("{key} 为空或超过长度限制")));
    }
    Ok(value.into())
}
fn optional_text(p: &Value, key: &str) -> Result<Option<String>> {
    match p.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if s.trim().is_empty() => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.trim().into())),
        _ => Err(invalid(&format!("{key} 必须为文字或空值"))),
    }
}
fn optional_date(p: &Value, key: &str) -> Result<Option<String>> {
    let value = optional_text(p, key)?;
    if let Some(s) = &value {
        tasks::valid_date(s)?;
    }
    Ok(value)
}
fn date(p: &Value) -> Result<&str> {
    let value = required(p, "date")?;
    tasks::valid_date(value)?;
    Ok(value)
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
fn scope(conn: &Connection, p: &Value) -> Result<Option<String>> {
    let value = optional_text(p, "projectId")?;
    if let Some(project) = &value {
        project_exists(conn, project)?;
    }
    Ok(value)
}
fn active(task: &Value) -> bool {
    !matches!(task["status"].as_str(), Some("done" | "cancelled"))
}
fn parse_date(value: &str) -> Result<NaiveDate> {
    tasks::valid_date(value)?;
    NaiveDate::parse_from_str(value, "%Y-%m-%d").map_err(|_| invalid("日期格式无效"))
}
fn days_between(from: &str, to: &str) -> Result<i64> {
    Ok((parse_date(to)? - parse_date(from)?).num_days())
}
fn read_json(conn: &Connection, sql: &str, args: &[&dyn rusqlite::ToSql]) -> Result<Vec<Value>> {
    let mut statement = conn.prepare(sql)?;
    let values = statement
        .query_map(args, |r| {
            let raw: String = r.get(0)?;
            serde_json::from_str(&raw).map_err(|e| {
                rusqlite::Error::FromSqlConversionFailure(
                    0,
                    rusqlite::types::Type::Text,
                    Box::new(e),
                )
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(values)
}
fn profile(conn: &Connection, project: &str) -> Result<Value> {
    Ok(conn.query_row("SELECT goal,status,target_date,version,updated_at FROM project_profiles WHERE project_id=?", [project], |r| Ok(json!({"projectId":project,"goal":r.get::<_,String>(0)?,"status":r.get::<_,String>(1)?,"targetDate":r.get::<_,Option<String>>(2)?,"version":r.get::<_,i64>(3)?,"updatedAt":r.get::<_,String>(4)?}))).optional()?.unwrap_or_else(|| json!({"projectId":project,"goal":"","status":"active","targetDate":null,"version":0,"updatedAt":null})))
}
fn validate_profile(p: &Value) -> Result<()> {
    text(p, "goal", 10000, false)?;
    if !matches!(
        p["status"].as_str(),
        Some("active" | "on_hold" | "completed" | "cancelled")
    ) {
        return Err(invalid("项目状态无效"));
    }
    optional_date(p, "targetDate")?;
    Ok(())
}
fn save_profile(conn: &Connection, p: &Value) -> Result<Value> {
    let project = required(p, "projectId")?;
    project_exists(conn, project)?;
    validate_profile(p)?;
    let base = integer(p, "baseVersion")?;
    if profile(conn, project)?["version"].as_i64() != Some(base) {
        return Err(conflict());
    }
    conn.execute("INSERT INTO project_profiles(project_id,goal,status,target_date,version,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET goal=excluded.goal,status=excluded.status,target_date=excluded.target_date,version=excluded.version,updated_at=excluded.updated_at", params![project,text(p,"goal",10000,false)?,p["status"].as_str(),optional_date(p,"targetDate")?,base + 1,now()])?;
    profile(conn, project)
}

fn milestone_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(
        json!({"id":r.get::<_,String>(0)?,"projectId":r.get::<_,String>(1)?,"title":r.get::<_,String>(2)?,"description":r.get::<_,String>(3)?,"status":r.get::<_,String>(4)?,"baselineDate":r.get::<_,Option<String>>(5)?,"forecastDate":r.get::<_,Option<String>>(6)?,"version":r.get::<_,i64>(7)?,"createdAt":r.get::<_,String>(8)?,"updatedAt":r.get::<_,String>(9)?}),
    )
}
const MILESTONE_SELECT: &str = "SELECT id,project_id,title,description,status,baseline_date,forecast_date,version,created_at,updated_at FROM milestones";
fn milestone(conn: &Connection, milestone_id: &str) -> Result<Value> {
    let mut value = conn
        .query_row(
            &format!("{MILESTONE_SELECT} WHERE id=?"),
            [milestone_id],
            milestone_row,
        )
        .optional()?
        .ok_or_else(|| AppError::new("NOT_FOUND", "里程碑不存在"))?;
    let mut stmt =
        conn.prepare("SELECT task_id FROM milestone_tasks WHERE milestone_id=? ORDER BY task_id")?;
    let ids = stmt
        .query_map([milestone_id], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    value["taskIds"] = json!(ids);
    Ok(value)
}
fn task_ids(p: &Value) -> Result<Vec<String>> {
    let values = p["taskIds"]
        .as_array()
        .filter(|v| v.len() <= 5000)
        .ok_or_else(|| invalid("taskIds 必须为任务 ID 数组，最多 5000 条"))?;
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for value in values {
        let key = value
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| invalid("关联任务 ID 无效"))?;
        if !seen.insert(key) {
            return Err(invalid("关联任务不能重复"));
        }
        result.push(key.into());
    }
    result.sort();
    Ok(result)
}
fn validate_milestone_fields(p: &Value) -> Result<()> {
    text(p, "title", 300, true)?;
    text(p, "description", 10000, false)?;
    if !matches!(
        p["status"].as_str(),
        Some("planned" | "in_progress" | "completed" | "cancelled")
    ) {
        return Err(invalid("里程碑状态无效"));
    }
    optional_date(p, "baselineDate")?;
    optional_date(p, "forecastDate")?;
    task_ids(p)?;
    Ok(())
}
fn save_milestone(conn: &Connection, p: &Value) -> Result<Value> {
    let project = required(p, "projectId")?;
    project_exists(conn, project)?;
    validate_milestone_fields(p)?;
    let keys = task_ids(p)?;
    for key in &keys {
        let task = tasks::task(conn, key)?;
        if task["projectId"] != project {
            return Err(AppError::new("PROJECT_SCOPE", "里程碑只能关联同项目任务"));
        }
        if p["status"] == "completed" && task["status"] != "done" {
            return Err(AppError::new(
                "MILESTONE_INCOMPLETE",
                "关联任务全部完成后才能完成里程碑；已取消任务须解除关联",
            ));
        }
    }
    let at = now();
    let (key, version, created) = if let Some(key) = optional_text(p, "milestoneId")? {
        let previous = milestone(conn, &key)?;
        if previous["projectId"] != project {
            return Err(AppError::new("PROJECT_SCOPE", "里程碑不属于所选项目"));
        }
        let base = integer(p, "baseVersion")?;
        if previous["version"].as_i64() != Some(base) {
            return Err(conflict());
        }
        (
            key,
            base + 1,
            previous["createdAt"].as_str().unwrap().to_owned(),
        )
    } else {
        if p.get("baseVersion")
            .is_some_and(|v| !v.is_null() && v.as_i64() != Some(0))
        {
            return Err(conflict());
        }
        (id(), 1, at.clone())
    };
    conn.execute("INSERT INTO milestones(id,project_id,title,description,status,baseline_date,forecast_date,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,description=excluded.description,status=excluded.status,baseline_date=excluded.baseline_date,forecast_date=excluded.forecast_date,version=excluded.version,updated_at=excluded.updated_at",params![key,project,text(p,"title",300,true)?,text(p,"description",10000,false)?,p["status"].as_str(),optional_date(p,"baselineDate")?,optional_date(p,"forecastDate")?,version,created,at])?;
    conn.execute("DELETE FROM milestone_tasks WHERE milestone_id=?", [&key])?;
    for task in keys {
        conn.execute(
            "INSERT INTO milestone_tasks VALUES (?,?)",
            params![key, task],
        )?;
    }
    milestone(conn, &key)
}
fn counts<'a>(values: impl Iterator<Item = &'a Value>, date: &str) -> Value {
    let mut output = json!({"total":0,"todo":0,"inProgress":0,"blocked":0,"done":0,"cancelled":0,"active":0,"overdue":0});
    for task in values {
        for key in [
            Some("total"),
            match task["status"].as_str() {
                Some("in_progress") => Some("inProgress"),
                Some("todo") => Some("todo"),
                Some("blocked") => Some("blocked"),
                Some("done") => Some("done"),
                Some("cancelled") => Some("cancelled"),
                _ => None,
            },
            active(task).then_some("active"),
            (active(task) && task["dueDate"].as_str().is_some_and(|due| due < date))
                .then_some("overdue"),
        ]
        .into_iter()
        .flatten()
        {
            output[key] = json!(output[key].as_i64().unwrap() + 1);
        }
    }
    output
}
fn relations(conn: &Connection) -> Result<Vec<Value>> {
    read_json(conn,"SELECT json_object('id',id,'kind',kind,'taskId',task_id,'targetId',target_id,'reason',reason,'evidence',json(evidence_json),'active',json('true'),'createdAt',created_at) FROM task_relations WHERE active=1 AND kind IN ('blocker','dependency') ORDER BY id",&[])
}
pub(crate) fn overview(conn: &Connection, p: &Value) -> Result<Value> {
    let date = date(p)?;
    let project = scope(conn, p)?;
    let mut all = tasks::state(conn)?;
    crate::daily_use::filter_context(conn, &mut all)?;
    let all = all["tasks"].as_array().unwrap();
    let by_id: HashMap<&str, &Value> = all.iter().map(|t| (t["id"].as_str().unwrap(), t)).collect();
    let relations = relations(conn)?;
    let projects = read_json(conn,"SELECT json_object('projectId',id,'name',name,'description',description) FROM projects WHERE (?1 IS NULL OR id=?1) AND NOT EXISTS(SELECT 1 FROM workspace_lifecycle l WHERE l.kind='project' AND l.entity_id=projects.id AND l.archived=1) ORDER BY created_at DESC,id",&[&project])?;
    let mut output = Vec::new();
    let mut totals = json!({"projects":projects.len(),"activeTasks":0,"blockedTasks":0,"overdueTasks":0,"atRiskMilestones":0});
    for mut item in projects {
        let key = item["projectId"].as_str().unwrap().to_owned();
        let scoped: Vec<&Value> = all.iter().filter(|t| t["projectId"] == key).collect();
        let mut blockers = Vec::new();
        let mut basis = Vec::new();
        let overdue: Vec<&Value> = scoped
            .iter()
            .copied()
            .filter(|t| active(t) && t["dueDate"].as_str().is_some_and(|d| d < date))
            .collect();
        for task in scoped.iter().copied().filter(|t| active(t)) {
            let related: Vec<&Value> = relations
                .iter()
                .filter(|r| {
                    r["taskId"] == task["id"]
                        && (r["kind"] == "blocker"
                            || r["targetId"]
                                .as_str()
                                .and_then(|id| by_id.get(id))
                                .is_some_and(|t| t["status"] != "done"))
                })
                .collect();
            if task["status"] == "blocked" || !related.is_empty() {
                blockers.push(json!({"task":task,"relations":related}));
                basis.push(json!({"kind":"task","taskId":task["id"],"version":task["version"],"label":format!("{}存在阻塞",task["title"].as_str().unwrap()),"relations":related}));
            }
        }
        for task in &overdue {
            basis.push(json!({"kind":"task","taskId":task["id"],"version":task["version"],"label":format!("{}已超过截止日期 {}",task["title"].as_str().unwrap(),task["dueDate"].as_str().unwrap())}));
        }
        let mut stmt = conn.prepare("SELECT id FROM milestones WHERE project_id=? ORDER BY coalesce(baseline_date,forecast_date,'9999-12-31'),created_at,id")?;
        let milestone_ids = stmt
            .query_map([&key], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut milestones = Vec::new();
        let mut at_risk = 0;
        for milestone_id in milestone_ids {
            let mut m = milestone(conn, &milestone_id)?;
            let linked: Vec<&Value> = m["taskIds"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|id| id.as_str().and_then(|id| by_id.get(id).copied()))
                .collect();
            m["taskCounts"] = counts(linked.iter().copied(), date);
            m["slipDays"] = json!(
                match (m["baselineDate"].as_str(), m["forecastDate"].as_str()) {
                    (Some(base), Some(forecast)) => Some(days_between(base, forecast)?),
                    _ => None,
                }
            );
            let open = m["status"] != "completed" && m["status"] != "cancelled";
            m["isOverdue"] = json!(
                open && m["forecastDate"]
                    .as_str()
                    .or(m["baselineDate"].as_str())
                    .is_some_and(|d| d < date)
            );
            m["completionBlocked"] = json!(linked.iter().any(|t| t["status"] != "done"));
            let reopened = m["status"] == "completed" && m["completionBlocked"] == true;
            let linked_blocked = linked
                .iter()
                .any(|task| blockers.iter().any(|b| b["task"]["id"] == task["id"]));
            if (open
                && (m["isOverdue"] == true
                    || m["slipDays"].as_i64().unwrap_or(0) > 0
                    || linked_blocked))
                || reopened
            {
                at_risk += 1;
                basis.push(json!({"kind":"milestone","milestoneId":m["id"],"version":m["version"],"label":if reopened {"已完成里程碑有关联任务重新打开"} else if m["isOverdue"] == true {"里程碑已逾期"} else {"里程碑存在延期或阻塞"},"baselineDate":m["baselineDate"],"forecastDate":m["forecastDate"],"slipDays":m["slipDays"]}));
            }
            milestones.push(m);
        }
        let profile = profile(conn, &key)?;
        let management = crate::management::attention(conn, &json!({"date":date,"projectId":key}))?;
        for signal in management["items"].as_array().into_iter().flatten() {
            let reasons = signal["reasons"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|r| r["label"].as_str())
                .collect::<Vec<_>>()
                .join("；");
            basis.push(json!({"kind":"management","managementKind":signal["kind"],"managementId":signal["id"],"label":format!("{}：{}",signal["title"].as_str().unwrap_or("管理事项"),reasons),"version":signal["version"]}));
        }
        let task_counts = counts(scoped.iter().copied(), date);
        let target_overdue = profile["status"] == "active"
            && profile["targetDate"].as_str().is_some_and(|d| d < date);
        if target_overdue {
            basis.push(json!({"kind":"project","projectId":key,"label":"项目目标日期已过","targetDate":profile["targetDate"]}));
        }
        let open_milestones = milestones
            .iter()
            .filter(|m| matches!(m["status"].as_str(), Some("planned" | "in_progress")))
            .count();
        let unfinished_completed_project = profile["status"] == "completed"
            && (task_counts["active"].as_i64().unwrap() > 0 || open_milestones > 0);
        if unfinished_completed_project {
            basis.push(json!({"kind":"project","projectId":key,"label":"项目标记完成但仍有未结任务/里程碑，请复核","activeTaskCount":task_counts["active"],"openMilestoneCount":open_milestones}));
        }
        match profile["status"].as_str() {
            Some("on_hold") => basis.push(json!({"kind":"project","projectId":key,"label":"项目已手动标记暂停；交付健康依据当前任务和里程碑计算"})),
            Some("cancelled") => basis.push(json!({"kind":"project","projectId":key,"label":"项目已手动标记取消；请核对未结任务和里程碑是否需要关闭"})),
            _ => {}
        }
        let health = if !blockers.is_empty() {
            "blocked"
        } else if management["count"].as_u64().unwrap_or(0) > 0
            || !overdue.is_empty()
            || at_risk > 0
            || target_overdue
            || unfinished_completed_project
        {
            "at_risk"
        } else if profile["status"] == "completed" {
            "completed"
        } else {
            "on_track"
        };
        for (name, n) in [
            ("activeTasks", task_counts["active"].as_i64().unwrap()),
            ("blockedTasks", blockers.len() as i64),
            ("overdueTasks", overdue.len() as i64),
            ("atRiskMilestones", at_risk),
        ] {
            totals[name] = json!(totals[name].as_i64().unwrap() + n);
        }
        item["profile"] = profile;
        item["taskCounts"] = task_counts;
        item["milestones"] = json!(milestones);
        item["blockers"] = json!(blockers);
        item["overdueTasks"] = json!(overdue);
        item["health"] = json!(health);
        item["basis"] = json!(basis);
        item["managementAttention"] = management["count"].clone();
        output.push(item);
    }
    Ok(json!({"date":date,"projectId":project,"projects":output,"counts":totals}))
}

fn follow_state(conn: &Connection, task: &Value) -> Result<Value> {
    Ok(conn.query_row("SELECT next_follow_up_date,snoozed_until,version,updated_at FROM task_follow_up_state WHERE task_id=?", [task["id"].as_str().unwrap()], |r|Ok(json!({"taskId":task["id"],"projectId":task["projectId"],"nextFollowUpDate":r.get::<_,Option<String>>(0)?,"snoozedUntil":r.get::<_,Option<String>>(1)?,"followUpVersion":r.get::<_,i64>(2)?,"updatedAt":r.get::<_,String>(3)?}))).optional()?.unwrap_or_else(||json!({"taskId":task["id"],"projectId":task["projectId"],"nextFollowUpDate":null,"snoozedUntil":null,"followUpVersion":0,"updatedAt":null})))
}
fn follow_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(
        json!({"id":r.get::<_,String>(0)?,"taskId":r.get::<_,String>(1)?,"projectId":r.get::<_,String>(2)?,"version":r.get::<_,i64>(3)?,"workDate":r.get::<_,String>(4)?,"note":r.get::<_,String>(5)?,"nextFollowUpDate":r.get::<_,Option<String>>(6)?,"recordedAt":r.get::<_,String>(7)?}),
    )
}
const FOLLOW_SELECT: &str = "SELECT id,task_id,project_id,version,work_date,note,next_follow_up_date,recorded_at FROM task_follow_ups";
fn save_follow_state(
    conn: &Connection,
    task: &Value,
    next: Option<&str>,
    snooze: Option<&str>,
    base: i64,
) -> Result<Value> {
    conn.execute("INSERT INTO task_follow_up_state VALUES (?,?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET next_follow_up_date=excluded.next_follow_up_date,snoozed_until=excluded.snoozed_until,version=excluded.version,updated_at=excluded.updated_at",params![task["id"].as_str(),task["projectId"].as_str(),next,snooze,base+1,now()])?;
    follow_state(conn, task)
}
fn record_follow_up(conn: &Connection, p: &Value) -> Result<Value> {
    let task = tasks::task(conn, required(p, "taskId")?)?;
    if !active(&task) {
        return Err(invalid("已完成或取消的任务无需跟进"));
    }
    let state = follow_state(conn, &task)?;
    let base = integer(p, "baseVersion")?;
    if state["followUpVersion"].as_i64() != Some(base) {
        return Err(conflict());
    }
    let work = required(p, "workDate")?;
    tasks::valid_date(work)?;
    let note = text(p, "note", 10000, true)?;
    let next = optional_date(p, "nextFollowUpDate")?;
    if next.as_deref().is_some_and(|d| d < work) {
        return Err(invalid("下次跟进日期不能早于本次跟进日期"));
    }
    // The user explicitly chooses an outcome; free-text promises never change
    // status or deadlines. Both histories are committed in the same transaction.
    let updated_task = if let Some(outcome) = p.get("taskOutcome").filter(|v| !v.is_null()) {
        let status = required(outcome, "status")?;
        if !matches!(status, "in_progress" | "blocked" | "done") {
            return Err(invalid("跟进结果只能更新为进行中、阻塞或完成"));
        }
        if status == "done" && next.is_some() {
            return Err(invalid("确认完成后无需安排后续跟进"));
        }
        let mut fields = task.clone();
        fields["baseVersion"] = json!(integer(outcome, "baseVersion")?);
        fields["workDate"] = json!(work);
        fields["status"] = json!(status);
        if status == "done" {
            fields["progress"] = json!(100);
        }
        Some(tasks::write_task(conn, &task, &fields, "user", &[], &note)?)
    } else {
        None
    };
    let first: String = conn.query_row(
        "SELECT min(work_date) FROM task_events WHERE task_id=?",
        [task["id"].as_str()],
        |r| r.get(0),
    )?;
    let last: Option<String> = conn.query_row(
        "SELECT max(work_date) FROM task_follow_ups WHERE task_id=?",
        [task["id"].as_str()],
        |r| r.get(0),
    )?;
    if work < first.as_str() || last.as_deref().is_some_and(|d| work < d) {
        return Err(AppError::new(
            "WORK_DATE_ORDER",
            "跟进日期不能早于任务建立日期或上次跟进日期",
        ));
    }
    let key = id();
    conn.execute(
        "INSERT INTO task_follow_ups VALUES (?,?,?,?,?,?,?,?)",
        params![
            key,
            task["id"].as_str(),
            task["projectId"].as_str(),
            base + 1,
            work,
            note,
            next,
            now()
        ],
    )?;
    let updated = save_follow_state(conn, &task, next.as_deref(), None, base)?;
    let record = conn.query_row(&format!("{FOLLOW_SELECT} WHERE id=?"), [key], follow_row)?;
    Ok(
        json!({"record":record,"followUpVersion":updated["followUpVersion"],"nextFollowUpDate":updated["nextFollowUpDate"],"snoozedUntil":updated["snoozedUntil"],"task":updated_task}),
    )
}
fn snooze_follow_up(conn: &Connection, p: &Value) -> Result<Value> {
    let today = date(p)?;
    let task = tasks::task(conn, required(p, "taskId")?)?;
    if !active(&task) {
        return Err(invalid("已完成或取消的任务无需暂缓提醒"));
    }
    let state = follow_state(conn, &task)?;
    let base = integer(p, "baseVersion")?;
    if state["followUpVersion"].as_i64() != Some(base) {
        return Err(conflict());
    }
    let until = optional_date(p, "snoozedUntil")?;
    if until.as_deref().is_some_and(|d| d <= today) {
        return Err(invalid("暂缓日期必须晚于所选日期"));
    }
    save_follow_state(
        conn,
        &task,
        state["nextFollowUpDate"].as_str(),
        until.as_deref(),
        base,
    )
}
pub(crate) fn follow_up_center(conn: &Connection, p: &Value) -> Result<Value> {
    let date = date(p)?;
    let project = scope(conn, p)?;
    let mut all = tasks::state(conn)?;
    crate::daily_use::filter_context(conn, &mut all)?;
    let names = read_json(
        conn,
        "SELECT json_object('id',id,'name',name) FROM projects",
        &[],
    )?;
    let names: HashMap<&str, &str> = names
        .iter()
        .map(|v| (v["id"].as_str().unwrap(), v["name"].as_str().unwrap()))
        .collect();
    let mut statement = conn.prepare(&format!("{FOLLOW_SELECT} WHERE work_date<=?1 AND (?2 IS NULL OR project_id=?2) ORDER BY work_date DESC,recorded_at DESC,version DESC,id"))?;
    let history = statement
        .query_map(params![date, project], follow_row)?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut output = Vec::new();
    let mut task_states = Vec::new();
    let mut totals = json!({"total":0,"actionable":0,"snoozed":0,"overdue":0,"dueSoon":0,"stale":0,"followUp":0});
    for task in all["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|t| active(t) && project.as_ref().is_none_or(|p| t["projectId"] == *p))
    {
        let task_id = task["id"].as_str().unwrap();
        let state = follow_state(conn, task)?;
        task_states.push(state.clone());
        let last_progress: Option<String> = conn.query_row(
            "SELECT max(work_date) FROM task_events WHERE task_id=?",
            [task_id],
            |r| r.get(0),
        )?;
        let last = history.iter().find(|r| r["taskId"] == task["id"]);
        let mut reasons = Vec::new();
        if let Some(due) = task["dueDate"].as_str() {
            let days = days_between(date, due)?;
            if days < 0 {
                reasons.push(json!({"kind":"overdue","label":format!("已逾期 {} 天",-days),"referenceDate":due,"days":-days}));
            } else if days <= 3 {
                reasons.push(json!({"kind":"due_soon","label":if days == 0 {"今天到期".into()} else {format!("{} 天内到期",days)},"referenceDate":due,"days":days}));
            }
        }
        if (task["status"] == "in_progress" || task["category"] == "follow_up")
            && last_progress
                .as_deref()
                .is_some_and(|d| days_between(d, date).is_ok_and(|days| days >= 3))
        {
            let last = last_progress.as_deref().unwrap();
            let days = days_between(last, date)?;
            reasons.push(json!({"kind":"stale","label":format!("{} 天没有任务进展记录",days),"referenceDate":last,"days":days}));
        }
        if let Some(next) = state["nextFollowUpDate"].as_str().filter(|d| *d <= date) {
            reasons.push(json!({"kind":"follow_up","label":"已到约定跟进日期","referenceDate":next,"days":days_between(next,date)?}));
        }
        if reasons.is_empty() {
            continue;
        }
        let snoozed = state["snoozedUntil"]
            .as_str()
            .is_some_and(|until| date < until);
        let reason_text = reasons
            .iter()
            .map(|r| r["label"].as_str().unwrap())
            .collect::<Vec<_>>()
            .join("；");
        let person = task["assignee"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or("负责人");
        let mut draft = format!(
            "{}，请同步「{}」的最新进展、当前阻塞和预计完成时间。\n跟进依据：{}。",
            person,
            task["title"].as_str().unwrap(),
            reason_text
        );
        if let Some(last) = last {
            draft.push_str(&format!(
                "\n上次跟进（{}）：{}",
                last["workDate"].as_str().unwrap(),
                last["note"].as_str().unwrap()
            ));
        }
        draft.push_str("\n如需协助，请说明需要谁在什么日期前做出什么决定。");
        for key in ["total", if snoozed { "snoozed" } else { "actionable" }] {
            totals[key] = json!(totals[key].as_i64().unwrap() + 1);
        }
        for reason in &reasons {
            let key = match reason["kind"].as_str().unwrap() {
                "overdue" => "overdue",
                "due_soon" => "dueSoon",
                "stale" => "stale",
                _ => "followUp",
            };
            totals[key] = json!(totals[key].as_i64().unwrap() + 1);
        }
        output.push(json!({"task":task,"projectName":names.get(task["projectId"].as_str().unwrap()).copied().unwrap_or(""),"taskId":task["id"],"projectId":task["projectId"],"reasons":reasons,"lastProgressDate":last_progress,"lastFollowUp":last,"nextFollowUpDate":state["nextFollowUpDate"],"snoozedUntil":state["snoozedUntil"],"snoozed":snoozed,"followUpVersion":state["followUpVersion"],"draft":draft}));
    }
    output.sort_by_key(|item| {
        (
            item["snoozed"].as_bool().unwrap(),
            !item["reasons"]
                .as_array()
                .unwrap()
                .iter()
                .any(|r| r["kind"] == "overdue"),
            item["task"]["dueDate"]
                .as_str()
                .unwrap_or("9999-12-31")
                .to_owned(),
            item["taskId"].as_str().unwrap().to_owned(),
        )
    });
    Ok(
        json!({"date":date,"projectId":project,"items":output,"counts":totals,"history":history,"taskStates":task_states}),
    )
}

pub(crate) fn dispatch(conn: &mut Connection, command: &str, p: &Value) -> Result<Value> {
    match command {
        "get_delivery_overview" => return overview(conn, p),
        "get_follow_up_center" => return follow_up_center(conn, p),
        _ => {}
    }
    let tx = conn.transaction()?;
    let value = match command {
        "save_project_profile" => save_profile(&tx, p),
        "save_milestone" => save_milestone(&tx, p),
        "record_follow_up" => record_follow_up(&tx, p),
        "snooze_follow_up" => snooze_follow_up(&tx, p),
        _ => Err(AppError::new("UNKNOWN_COMMAND", "未知交付管理命令")),
    }?;
    tx.commit()?;
    Ok(value)
}

/// Validate concrete SQLite types and domain invariants before restoring an archive.
pub(crate) fn validate_backup(conn: &Connection) -> Result<()> {
    validate_rows(conn).map_err(|error| {
        AppError::new(
            "INVALID_BACKUP",
            format!("交付与跟进数据无效：{}", error.message),
        )
    })
}
fn timestamp(value: &str) -> Result<()> {
    chrono::DateTime::parse_from_rfc3339(value).map_err(|_| invalid("审计时间无效"))?;
    Ok(())
}
fn validate_rows(conn: &Connection) -> Result<()> {
    // Archives can replace table definitions, so do not rely on the declared
    // PRIMARY KEY/UNIQUE constraints to prove identities are unambiguous.
    for (table, keys) in [
        ("project_profiles", "project_id"),
        ("milestones", "id"),
        ("milestone_tasks", "milestone_id,task_id"),
        ("task_follow_up_state", "task_id"),
        ("task_follow_ups", "id"),
        ("task_follow_ups", "task_id,version"),
    ] {
        let duplicate: bool = conn.query_row(
            &format!("SELECT EXISTS(SELECT 1 FROM {table} GROUP BY {keys} HAVING count(*)>1)"),
            [],
            |r| r.get(0),
        )?;
        if duplicate {
            return Err(invalid("交付或跟进记录标识重复"));
        }
    }
    for (table, texts, optional) in [
        (
            "project_profiles",
            "project_id,goal,status,updated_at",
            "target_date",
        ),
        (
            "milestones",
            "id,project_id,title,description,status,created_at,updated_at",
            "baseline_date,forecast_date",
        ),
        (
            "task_follow_up_state",
            "task_id,project_id,updated_at",
            "next_follow_up_date,snoozed_until",
        ),
        (
            "task_follow_ups",
            "id,task_id,project_id,work_date,note,recorded_at",
            "next_follow_up_date",
        ),
    ] {
        let texts: Vec<&str> = texts.split(',').collect();
        let optional: Vec<&str> = optional.split(',').collect();
        let columns = [texts.clone(), optional.clone(), vec!["version"]]
            .concat()
            .join(",");
        let mut statement = conn.prepare(&format!("SELECT {columns} FROM {table}"))?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            for i in 0..texts.len() {
                row.get::<_, String>(i)?;
            }
            for i in 0..optional.len() {
                row.get::<_, Option<String>>(texts.len() + i)?;
            }
            if row.get::<_, i64>(texts.len() + optional.len())? < 1 {
                return Err(invalid("版本必须为正整数"));
            }
        }
    }
    let profiles = read_json(conn,"SELECT json_object('projectId',project_id,'goal',goal,'status',status,'targetDate',target_date,'version',version,'updatedAt',updated_at) FROM project_profiles",&[])?;
    for p in profiles {
        project_exists(conn, required(&p, "projectId")?)?;
        validate_profile(&p)?;
        timestamp(required(&p, "updatedAt")?)?;
    }
    let mut statement = conn.prepare(&format!("{MILESTONE_SELECT} ORDER BY id"))?;
    let milestones = statement
        .query_map([], milestone_row)?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    for m in milestones {
        let m = milestone(conn, required(&m, "id")?)?;
        project_exists(conn, required(&m, "projectId")?)?;
        validate_milestone_fields(&m)?;
        timestamp(required(&m, "createdAt")?)?;
        timestamp(required(&m, "updatedAt")?)?;
        for key in task_ids(&m)? {
            if tasks::task(conn, &key)?["projectId"] != m["projectId"] {
                return Err(invalid("里程碑关联跨项目"));
            }
        }
    }
    let invalid_links: i64 = conn.query_row("SELECT count(*) FROM milestone_tasks l LEFT JOIN milestones m ON m.id=l.milestone_id LEFT JOIN tasks t ON t.id=l.task_id WHERE typeof(l.milestone_id)<>'text' OR typeof(l.task_id)<>'text' OR m.id IS NULL OR t.id IS NULL OR m.project_id<>t.project_id",[],|r|r.get(0))?;
    if invalid_links != 0 {
        return Err(invalid("里程碑关联无效"));
    }
    let states = read_json(conn,"SELECT json_object('taskId',task_id,'projectId',project_id,'nextFollowUpDate',next_follow_up_date,'snoozedUntil',snoozed_until,'followUpVersion',version,'updatedAt',updated_at) FROM task_follow_up_state",&[])?;
    for s in states {
        let task = tasks::task(conn, required(&s, "taskId")?)?;
        if task["projectId"] != s["projectId"] {
            return Err(invalid("跟进状态跨项目"));
        }
        optional_date(&s, "nextFollowUpDate")?;
        optional_date(&s, "snoozedUntil")?;
        timestamp(required(&s, "updatedAt")?)?;
        let latest = conn
            .query_row(
                &format!("{FOLLOW_SELECT} WHERE task_id=? ORDER BY version DESC LIMIT 1"),
                [required(&s, "taskId")?],
                follow_row,
            )
            .optional()?;
        if latest
            .as_ref()
            .map(|v| &v["nextFollowUpDate"])
            .unwrap_or(&Value::Null)
            != &s["nextFollowUpDate"]
        {
            return Err(invalid("下次跟进日期与最新跟进记录不一致"));
        }
    }
    let mut statement = conn.prepare(&format!("{FOLLOW_SELECT} ORDER BY task_id,version"))?;
    let records = statement
        .query_map([], follow_row)?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut previous: HashMap<String, String> = HashMap::new();
    for r in records {
        let task = tasks::task(conn, required(&r, "taskId")?)?;
        let state = follow_state(conn, &task)?;
        if task["projectId"] != r["projectId"]
            || state["followUpVersion"].as_i64().unwrap() < r["version"].as_i64().unwrap()
        {
            return Err(invalid("跟进记录范围或版本无效"));
        }
        let work = required(&r, "workDate")?;
        tasks::valid_date(work)?;
        text(&r, "note", 10000, true)?;
        timestamp(required(&r, "recordedAt")?)?;
        if optional_date(&r, "nextFollowUpDate")?
            .as_deref()
            .is_some_and(|d| d < work)
        {
            return Err(invalid("跟进日期逆序"));
        }
        let first: String = conn.query_row(
            "SELECT min(work_date) FROM task_events WHERE task_id=?",
            [required(&r, "taskId")?],
            |row| row.get(0),
        )?;
        if work < first.as_str()
            || previous
                .get(required(&r, "taskId")?)
                .is_some_and(|d| work < d.as_str())
        {
            return Err(invalid("跟进历史日期逆序"));
        }
        previous.insert(required(&r, "taskId")?.into(), work.into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (Connection, Value, Value, Value) {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::db::migrate(&conn).unwrap();
        let project = id();
        conn.execute(
            "INSERT INTO projects VALUES (?,'交付校验','',?)",
            params![project, now()],
        )
        .unwrap();
        let task = tasks::dispatch(&mut conn,"create_task",&json!({"projectId":project,"title":"交付任务","description":"","category":"action","assignee":null,"priority":"medium","status":"todo","progress":0,"dueDate":null,"plannedDate":null,"workDate":"2026-10-16","clientRequestId":id()})).unwrap();
        let m = dispatch(&mut conn,"save_milestone",&json!({"projectId":project,"title":"交付","description":"","status":"planned","baselineDate":"2026-10-20","forecastDate":"2026-10-22","taskIds":[task["id"]]})).unwrap();
        dispatch(&mut conn,"save_project_profile",&json!({"projectId":project,"goal":"交付上线","status":"active","targetDate":"2026-10-25","baseVersion":0})).unwrap();
        dispatch(&mut conn,"record_follow_up",&json!({"taskId":task["id"],"baseVersion":0,"workDate":"2026-10-19","note":"等待反馈","nextFollowUpDate":"2026-10-20"})).unwrap();
        validate_backup(&conn).unwrap();
        (conn, json!({"id":project}), task, m)
    }

    #[test]
    fn backup_rejects_invalid_dates_types_statuses_and_inconsistent_follow_up_state() {
        let (conn, _, _, _) = fixture();
        for sql in [
            "UPDATE project_profiles SET goal=x'00ff'",
            "UPDATE project_profiles SET status='unknown'",
            "UPDATE project_profiles SET target_date='2026-02-30'",
            "UPDATE project_profiles SET version=0",
            "UPDATE milestones SET forecast_date='2026-10-2'",
            "UPDATE milestones SET status='done'",
            "UPDATE milestones SET updated_at='not-a-timestamp'",
            "UPDATE task_follow_up_state SET version=1.5",
            "UPDATE task_follow_up_state SET next_follow_up_date=NULL",
            "UPDATE task_follow_up_state SET snoozed_until=x'ff'",
            "UPDATE task_follow_ups SET work_date='2026-10-15'",
            "UPDATE task_follow_ups SET next_follow_up_date='2026-10-18'",
            "UPDATE task_follow_ups SET version=2",
            "DELETE FROM task_follow_up_state",
        ] {
            conn.execute_batch("SAVEPOINT corrupt").unwrap();
            conn.execute_batch(sql).unwrap();
            assert_eq!(
                validate_backup(&conn).unwrap_err().code,
                "INVALID_BACKUP",
                "{sql}"
            );
            conn.execute_batch("ROLLBACK TO corrupt; RELEASE corrupt")
                .unwrap();
        }
        validate_backup(&conn).unwrap();
    }

    #[test]
    fn backup_rejects_cross_project_links_and_follow_up_records() {
        let (conn, _, task, m) = fixture();
        let foreign = id();
        conn.execute(
            "INSERT INTO projects VALUES (?,'另一项目','',?)",
            params![foreign, now()],
        )
        .unwrap();
        conn.execute_batch("SAVEPOINT corrupt").unwrap();
        conn.execute(
            "UPDATE milestones SET project_id=? WHERE id=?",
            params![foreign, m["id"].as_str()],
        )
        .unwrap();
        assert_eq!(validate_backup(&conn).unwrap_err().code, "INVALID_BACKUP");
        conn.execute_batch("ROLLBACK TO corrupt; RELEASE corrupt")
            .unwrap();
        conn.execute_batch("SAVEPOINT corrupt").unwrap();
        conn.execute(
            "UPDATE task_follow_up_state SET project_id=? WHERE task_id=?",
            params![foreign, task["id"].as_str()],
        )
        .unwrap();
        assert_eq!(validate_backup(&conn).unwrap_err().code, "INVALID_BACKUP");
        conn.execute_batch("ROLLBACK TO corrupt; RELEASE corrupt")
            .unwrap();
        conn.execute(
            "UPDATE task_follow_ups SET project_id=? WHERE task_id=?",
            params![foreign, task["id"].as_str()],
        )
        .unwrap();
        assert_eq!(validate_backup(&conn).unwrap_err().code, "INVALID_BACKUP");
    }
}
