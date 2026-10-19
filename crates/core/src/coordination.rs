//! Local, versioned weekly reports and explicit meeting action confirmation.
use crate::{id, now, required, tasks, AppError, Result};
use chrono::{Duration, NaiveDate};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::HashSet;

pub(crate) fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch(r#"
CREATE TABLE coordination_reports(id TEXT PRIMARY KEY,project_id TEXT REFERENCES projects(id),start_date TEXT NOT NULL,end_date TEXT NOT NULL,title TEXT NOT NULL,version INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE coordination_report_versions(id TEXT PRIMARY KEY,report_id TEXT NOT NULL REFERENCES coordination_reports(id),version INTEGER NOT NULL,content TEXT NOT NULL,snapshot_json TEXT NOT NULL,edited INTEGER NOT NULL,created_at TEXT NOT NULL,UNIQUE(report_id,version));
CREATE TABLE coordination_meetings(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),date TEXT NOT NULL,title TEXT NOT NULL,version INTEGER NOT NULL,data_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE coordination_meeting_versions(id TEXT PRIMARY KEY,meeting_id TEXT NOT NULL REFERENCES coordination_meetings(id),version INTEGER NOT NULL,snapshot_json TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(meeting_id,version));
CREATE TABLE coordination_actions(id TEXT PRIMARY KEY,meeting_id TEXT NOT NULL REFERENCES coordination_meetings(id),project_id TEXT NOT NULL REFERENCES projects(id),title TEXT NOT NULL,owner TEXT NOT NULL,due_date TEXT NOT NULL,status TEXT NOT NULL,task_id TEXT UNIQUE REFERENCES tasks(id),version INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE coordination_action_versions(id TEXT PRIMARY KEY,action_id TEXT NOT NULL REFERENCES coordination_actions(id),version INTEGER NOT NULL,snapshot_json TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(action_id,version));
CREATE INDEX coordination_reports_scope ON coordination_reports(project_id,start_date,end_date);
CREATE INDEX coordination_meetings_scope ON coordination_meetings(project_id,date);
CREATE INDEX coordination_actions_meeting ON coordination_actions(meeting_id);
"#)?;
    Ok(())
}

fn invalid(message: &str) -> AppError {
    AppError::new("VALIDATION", message)
}
fn conflict() -> AppError {
    AppError::new("VERSION_CONFLICT", "内容已被更新，请刷新并重新核对后保存")
}
fn number(p: &Value, key: &str) -> Result<i64> {
    p[key]
        .as_i64()
        .filter(|v| *v > 0)
        .ok_or_else(|| invalid("版本必须为正整数"))
}
fn text(p: &Value, key: &str, max: usize, nonempty: bool) -> Result<String> {
    let s = p[key]
        .as_str()
        .ok_or_else(|| invalid(&format!("{key} 必须为文字")))?
        .trim();
    if s.chars().count() > max || (nonempty && s.is_empty()) {
        return Err(invalid(&format!("{key} 为空或超过长度限制")));
    }
    Ok(s.into())
}
fn timestamp(s: &str) -> Result<()> {
    chrono::DateTime::parse_from_rfc3339(s).map_err(|_| invalid("审计时间无效"))?;
    Ok(())
}
fn date(p: &Value, key: &str) -> Result<String> {
    let s = required(p, key)?;
    tasks::valid_date(s)?;
    Ok(s.into())
}
fn project(conn: &Connection, p: &str) -> Result<()> {
    if !conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM projects WHERE id=?)",
        [p],
        |r| r.get::<_, bool>(0),
    )? {
        return Err(AppError::new("NOT_FOUND", "项目不存在"));
    }
    Ok(())
}
fn scope(conn: &Connection, p: &Value) -> Result<Option<String>> {
    match p.get("projectId") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if s.is_empty() => Ok(None),
        Some(Value::String(s)) => {
            project(conn, s)?;
            Ok(Some(s.clone()))
        }
        _ => Err(invalid("项目范围无效")),
    }
}
fn decode(raw: String) -> rusqlite::Result<Value> {
    serde_json::from_str(&raw).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })
}
fn read(conn: &Connection, sql: &str, args: &[&dyn rusqlite::ToSql]) -> Result<Vec<Value>> {
    let mut s = conn.prepare(sql)?;
    let rows = s
        .query_map(args, |r| decode(r.get(0)?))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}
const EVENT_JSON: &str = "json_object('id',id,'taskId',task_id,'projectId',project_id,'version',version,'workDate',work_date,'recordedAt',recorded_at,'note',note,'before',json(before_json),'after',json(after_json),'evidence',json(evidence_json))";

/// Each task's newest event through the calendar cutoff, never the mutable task row.
fn task_basis(conn: &Connection, project: Option<&str>, end: &str) -> Result<Vec<Value>> {
    read(conn,&format!("SELECT {EVENT_JSON} FROM task_events e WHERE work_date<=?1 AND (?2 IS NULL OR project_id=?2) AND NOT EXISTS(SELECT 1 FROM task_events n WHERE n.task_id=e.task_id AND n.work_date<=?1 AND n.version>e.version) ORDER BY e.task_id"),&[&end,&project])
}
fn historical(
    conn: &Connection,
    table: &str,
    key: &str,
    project: Option<&str>,
    end: &str,
) -> Result<Vec<Value>> {
    // Only internally selected tables/columns reach this SQL.
    let sql = if table == "governance_revisions" {
        format!("SELECT json_object('recordId',r.id,'version',r.version,'workDate',r.work_date,'recordedAt',r.recorded_at,'snapshot',json(r.snapshot_json)) FROM {table} r WHERE r.work_date<=?1 AND (?2 IS NULL OR r.project_id=?2) AND NOT EXISTS(SELECT 1 FROM {table} n WHERE n.{key}=r.{key} AND n.work_date<=?1 AND n.version>r.version) ORDER BY r.{key}")
    } else {
        let parent = if table == "change_request_history" {
            "change_requests"
        } else {
            "deliverables"
        };
        format!("SELECT json_object('recordId',r.id,'version',r.version,'workDate',r.work_date,'recordedAt',r.created_at,'snapshot',json(r.snapshot_json)) FROM {table} r JOIN {parent} p ON p.id=r.{key} WHERE r.work_date<=?1 AND (?2 IS NULL OR p.project_id=?2) AND NOT EXISTS(SELECT 1 FROM {table} n WHERE n.{key}=r.{key} AND n.work_date<=?1 AND n.version>r.version) ORDER BY r.{key}")
    };
    read(conn, &sql, &[&end, &project])
}
fn snapshot(conn: &Connection, project: Option<&str>, start: &str, end: &str) -> Result<Value> {
    let events = read(conn,&format!("SELECT {EVENT_JSON} FROM task_events WHERE work_date BETWEEN ?1 AND ?2 AND (?3 IS NULL OR project_id=?3) ORDER BY work_date,task_id,version"),&[&start,&end,&project])?;
    let task_events = task_basis(conn, project, end)?;
    let completed: Vec<Value> = task_events
        .iter()
        .filter(|e| {
            e["after"]["status"] == "done"
                && events.iter().any(|v| {
                    v["taskId"] == e["taskId"]
                        && v["after"]["status"] == "done"
                        && v["before"]["status"] != "done"
                })
        })
        .cloned()
        .collect();
    let milestones=read(conn,"SELECT json_object('id',id,'projectId',project_id,'title',title,'description',description,'status',status,'baselineDate',baseline_date,'forecastDate',forecast_date,'version',version,'updatedAt',updated_at) FROM milestones WHERE (?1 IS NULL OR project_id=?1) ORDER BY id",&[&project])?;
    let relations=read(conn,"SELECT json_object('id',r.id,'projectId',t.project_id,'kind',r.kind,'taskId',r.task_id,'targetId',r.target_id,'reason',r.reason,'createdAt',r.created_at) FROM task_relations r JOIN tasks t ON t.id=r.task_id WHERE r.active=1 AND r.kind IN ('blocker','dependency') AND (?1 IS NULL OR t.project_id=?1) ORDER BY r.id",&[&project])?;
    let mut deliverables = historical(conn, "deliverable_history", "deliverable_id", project, end)?;
    for entry in &mut deliverables {
        entry["acceptanceCheck"] = acceptance_check(&entry["snapshot"], &task_events);
    }
    Ok(
        json!({"projectId":project,"startDate":start,"endDate":end,"generatedAt":now(),"taskEvents":events,"taskStates":task_events,"completed":completed,"governance":historical(conn,"governance_revisions","item_id",project,end)?,"changes":historical(conn,"change_request_history","change_id",project,end)?,"deliverables":deliverables,"currentMilestones":milestones,"currentRelations":relations,"currentSnapshotNotice":"里程碑与依赖未保存历史版本，以下仅为生成时当前快照，不代表报告截止日状态。任务及风险、问题、待决策、变更、验收按工作日期取截止日版本。"}),
    )
}
fn acceptance_check(delivery: &Value, states: &[Value]) -> Value {
    if delivery["status"] != "accepted" {
        return json!({"needsReReview":false,"message":""});
    }
    let target = &delivery["acceptedTarget"];
    let changed = if delivery["target"]["kind"] == "task" {
        states
            .iter()
            .find(|e| e["taskId"] == target["id"])
            .map(|e| e["after"]["version"] != target["version"] || e["after"]["status"] != "done")
    } else {
        let children = target["tasks"].as_array();
        if children.is_some_and(|tasks| {
            tasks.iter().any(|t| {
                states
                    .iter()
                    .find(|e| e["taskId"] == t["id"])
                    .is_none_or(|e| {
                        e["after"]["version"] != t["version"] || e["after"]["status"] != "done"
                    })
            })
        }) {
            Some(true)
        } else {
            None
        }
    };
    match changed {
        Some(true) => {
            json!({"needsReReview":true,"message":"需重新复核：截止日任务版本或完成状态与验收时不同。"})
        }
        Some(false) => json!({"needsReReview":false,"message":"截止日任务版本与验收通过时一致。"}),
        None => {
            json!({"needsReReview":null,"message":"缺少交付目标的截止日历史，验收结论按记录版本展示，请核对当前目标。"})
        }
    }
}
fn task_label(t: &Value) -> String {
    format!(
        "{}（负责人：{}；状态：{}；进度：{}%；期限：{}）",
        t["title"].as_str().unwrap_or("未命名"),
        t["assignee"].as_str().unwrap_or("待定"),
        status_label(t["status"].as_str().unwrap_or("")),
        t["progress"].as_i64().unwrap_or(0),
        t["dueDate"].as_str().unwrap_or("未设置")
    )
}
fn status_label(s: &str) -> &str {
    match s {
        "todo" => "待办",
        "in_progress" => "进行中",
        "blocked" => "阻塞",
        "done" => "完成",
        "cancelled" => "取消",
        "open" => "未结",
        "closed" => "已关闭",
        "escalated" => "已升级",
        "draft" => "草案",
        "submitted" => "待审批",
        "approved" => "已批准",
        "rejected" => "已拒绝/未通过",
        "implemented" => "已实施",
        "in_review" => "验收复核中",
        "accepted" => "验收通过",
        "planned" => "待开始",
        "completed" => "已完成",
        "pending_confirmation" => "待确认",
        _ => s,
    }
}
fn bullet(out: &mut String, lines: Vec<String>) {
    if lines.is_empty() {
        out.push_str("- 暂无已记录事项。\n");
    } else {
        for line in lines {
            out.push_str("- ");
            out.push_str(&line.replace('\n', " "));
            out.push('\n');
        }
    }
    out.push('\n');
}
fn values(v: &Value, key: &str) -> Vec<Value> {
    v[key].as_array().cloned().unwrap_or_default()
}
fn report_content(conn: &Connection, b: &Value) -> Result<String> {
    let name = if let Some(p) = b["projectId"].as_str() {
        conn.query_row("SELECT name FROM projects WHERE id=?", [p], |r| {
            r.get::<_, String>(0)
        })?
    } else {
        "全部项目".into()
    };
    let start = required(b, "startDate")?;
    let end = required(b, "endDate")?;
    let mut s = format!(
        "# {name} · 项目周报\n\n报告区间：{start} 至 {end}\n生成时间：{}\n\n## 本期完成\n\n",
        required(b, "generatedAt")?
    );
    bullet(
        &mut s,
        values(b, "completed")
            .iter()
            .map(|e| {
                format!(
                    "{} [任务 {} v{}；截止事件 {}；{}]",
                    task_label(&e["after"]),
                    e["taskId"].as_str().unwrap_or(""),
                    e["version"],
                    e["id"].as_str().unwrap_or(""),
                    e["workDate"].as_str().unwrap_or("")
                )
            })
            .collect(),
    );
    s.push_str("## 本期进展\n\n");
    bullet(
        &mut s,
        values(b, "taskEvents")
            .iter()
            .map(|e| {
                format!(
                    "{}：{} → {}；{} [事件 {} v{}；{}]",
                    e["after"]["title"].as_str().unwrap_or(""),
                    e["before"]["status"]
                        .as_str()
                        .map(status_label)
                        .unwrap_or("创建"),
                    status_label(e["after"]["status"].as_str().unwrap_or("")),
                    e["note"].as_str().unwrap_or(""),
                    e["id"].as_str().unwrap_or(""),
                    e["version"],
                    e["workDate"].as_str().unwrap_or("")
                )
            })
            .collect(),
    );
    let states = values(b, "taskStates");
    let active = |e: &&Value| !matches!(e["after"]["status"].as_str(), Some("done" | "cancelled"));
    s.push_str("## 计划偏差与阻塞（截止日任务状态）\n\n");
    bullet(
        &mut s,
        states
            .iter()
            .filter(active)
            .filter(|e| {
                e["after"]["status"] == "blocked"
                    || e["after"]["dueDate"].as_str().is_some_and(|d| d < end)
                    || e["after"]["plannedDate"].as_str().is_some_and(|d| d < end)
            })
            .map(|e| {
                format!(
                    "{} [任务 {} v{}；事件 {}]",
                    task_label(&e["after"]),
                    e["taskId"].as_str().unwrap_or(""),
                    e["version"],
                    e["id"].as_str().unwrap_or("")
                )
            })
            .collect(),
    );
    for (key, title) in [
        ("governance", "风险、问题与待决策"),
        ("changes", "需求变更"),
        ("deliverables", "交付与验收"),
    ] {
        s.push_str(&format!("## {title}（截止日版本）\n\n"));
        bullet(
            &mut s,
            values(b, key)
                .iter()
                .map(|e| {
                    let v = &e["snapshot"];
                    format!(
                        "{} · {} · 负责人/决策人：{} [记录 {} v{}；历史 {}；{}]",
                        v["title"].as_str().unwrap_or(""),
                        status_label(v["status"].as_str().unwrap_or("")),
                        v["owner"]
                            .as_str()
                            .or(v["decisionOwner"].as_str())
                            .unwrap_or("待定"),
                        v["id"].as_str().unwrap_or(""),
                        e["version"],
                        e["recordId"].as_str().unwrap_or(""),
                        e["workDate"].as_str().unwrap_or("")
                    ) + e["acceptanceCheck"]["message"]
                        .as_str()
                        .filter(|m| !m.is_empty())
                        .map(|m| format!(" · {m}"))
                        .unwrap_or_default()
                        .as_str()
                })
                .collect(),
        );
    }
    s.push_str("## 里程碑与依赖（生成时当前快照）\n\n");
    s.push_str(required(b, "currentSnapshotNotice")?);
    s.push_str("\n\n");
    bullet(
        &mut s,
        values(b, "currentMilestones")
            .iter()
            .map(|m| {
                format!(
                    "{} · {} · 基准 {} → 预计 {} [里程碑 {} v{}；更新 {}]",
                    m["title"].as_str().unwrap_or(""),
                    status_label(m["status"].as_str().unwrap_or("")),
                    m["baselineDate"].as_str().unwrap_or("未设置"),
                    m["forecastDate"].as_str().unwrap_or("未设置"),
                    m["id"].as_str().unwrap_or(""),
                    m["version"],
                    m["updatedAt"].as_str().unwrap_or("")
                )
            })
            .collect(),
    );
    bullet(
        &mut s,
        values(b, "currentRelations")
            .iter()
            .map(|r| {
                format!(
                    "{} [依赖 {}；任务 {}；记录 {}]",
                    r["reason"].as_str().unwrap_or(""),
                    r["id"].as_str().unwrap_or(""),
                    r["taskId"].as_str().unwrap_or(""),
                    r["createdAt"].as_str().unwrap_or("")
                )
            })
            .collect(),
    );
    let next = (NaiveDate::parse_from_str(end, "%Y-%m-%d").map_err(|_| invalid("截止日期无效"))?
        + Duration::days(7))
    .to_string();
    s.push_str("## 下期重点（按截止日未结任务提出）\n\n");
    bullet(
        &mut s,
        states
            .iter()
            .filter(active)
            .filter(|e| {
                e["after"]["priority"] == "high"
                    || e["after"]["status"] == "blocked"
                    || e["after"]["dueDate"]
                        .as_str()
                        .is_some_and(|d| d <= next.as_str())
            })
            .map(|e| {
                format!(
                    "{} [任务 {} v{}]",
                    task_label(&e["after"]),
                    e["taskId"].as_str().unwrap_or(""),
                    e["version"]
                )
            })
            .collect(),
    );
    s.push_str(
        "*本期完成仅统计期间发生完成记录且截止日仍完成的任务；生成后保存的版本及依据保持冻结。*\n",
    );
    Ok(s)
}

const REPORT_JSON:&str="json_object('id',id,'projectId',project_id,'startDate',start_date,'endDate',end_date,'title',title,'version',version,'createdAt',created_at,'updatedAt',updated_at)";
fn report(conn: &Connection, key: &str, version: Option<i64>) -> Result<Value> {
    let mut v = read(
        conn,
        &format!("SELECT {REPORT_JSON} FROM coordination_reports WHERE id=?"),
        &[&key],
    )?
    .into_iter()
    .next()
    .ok_or_else(|| AppError::new("NOT_FOUND", "周报不存在"))?;
    let selected = version.unwrap_or(number(&v, "version")?);
    let row:Value=conn.query_row("SELECT json_object('versionId',id,'version',version,'content',content,'basis',json(snapshot_json),'edited',json(CASE WHEN edited=1 THEN 'true' ELSE 'false' END),'savedAt',created_at) FROM coordination_report_versions WHERE report_id=? AND version=?",params![key,selected],|r|decode(r.get(0)?)).optional()?.ok_or_else(||AppError::new("NOT_FOUND","周报版本不存在"))?;
    v["latestVersion"] = v["version"].clone();
    for (k, value) in row.as_object().ok_or_else(|| invalid("周报版本格式无效"))? {
        v[k] = value.clone();
    }
    v["history"]=json!(read(conn,"SELECT json_object('versionId',id,'version',version,'edited',json(CASE WHEN edited=1 THEN 'true' ELSE 'false' END),'createdAt',created_at) FROM coordination_report_versions WHERE report_id=? ORDER BY version DESC",&[&key])?);
    Ok(v)
}
fn insert_report_version(
    conn: &Connection,
    key: &str,
    version: i64,
    content: &str,
    basis: &Value,
    edited: bool,
) -> Result<()> {
    conn.execute(
        "INSERT INTO coordination_report_versions VALUES(?,?,?,?,?,?,?)",
        params![
            id(),
            key,
            version,
            content,
            basis.to_string(),
            edited,
            now()
        ],
    )?;
    Ok(())
}
fn generate_report(conn: &Connection, p: &Value) -> Result<Value> {
    let project = scope(conn, p)?;
    let start = date(p, "startDate")?;
    let end = date(p, "endDate")?;
    let span = (NaiveDate::parse_from_str(&end, "%Y-%m-%d").map_err(|_| invalid("日期无效"))?
        - NaiveDate::parse_from_str(&start, "%Y-%m-%d").map_err(|_| invalid("日期无效"))?)
    .num_days();
    if !(0..=366).contains(&span) {
        return Err(invalid("报告日期区间应为 1 至 367 天"));
    }
    let basis = snapshot(conn, project.as_deref(), &start, &end)?;
    let content = report_content(conn, &basis)?;
    let at = now();
    let (key, version) = if let Some(key) = p["reportId"].as_str() {
        let old = report(conn, key, None)?;
        if old["projectId"].as_str() != project.as_deref()
            || old["startDate"] != start
            || old["endDate"] != end
        {
            return Err(invalid("重新生成不能改变报告范围或日期"));
        }
        let base = number(p, "baseVersion")?;
        if old["version"].as_i64() != Some(base) {
            return Err(conflict());
        }
        conn.execute(
            "UPDATE coordination_reports SET version=?,updated_at=? WHERE id=?",
            params![base + 1, at, key],
        )?;
        (key.to_owned(), base + 1)
    } else {
        let key = id();
        conn.execute(
            "INSERT INTO coordination_reports VALUES(?,?,?,?,?,1,?,?)",
            params![key, project, start, end, "项目周报", at, at],
        )?;
        (key, 1)
    };
    insert_report_version(conn, &key, version, &content, &basis, false)?;
    report(conn, &key, None)
}
fn save_report(conn: &Connection, p: &Value) -> Result<Value> {
    let key = required(p, "reportId")?;
    let old = report(conn, key, None)?;
    let base = number(p, "baseVersion")?;
    if old["version"].as_i64() != Some(base) {
        return Err(conflict());
    }
    let content = text(p, "content", 200000, true)?;
    conn.execute(
        "UPDATE coordination_reports SET version=?,updated_at=? WHERE id=?",
        params![base + 1, now(), key],
    )?;
    insert_report_version(conn, key, base + 1, &content, &old["basis"], true)?;
    report(conn, key, None)
}

fn meeting(conn: &Connection, key: &str, version: Option<i64>) -> Result<Value> {
    let mut v = conn
        .query_row(
            "SELECT data_json FROM coordination_meetings WHERE id=?",
            [key],
            |r| decode(r.get(0)?),
        )
        .optional()?
        .ok_or_else(|| AppError::new("NOT_FOUND", "会议不存在"))?;
    let latest = v["version"].clone();
    if let Some(number) = version {
        v=conn.query_row("SELECT snapshot_json FROM coordination_meeting_versions WHERE meeting_id=? AND version=?",params![key,number],|r|decode(r.get(0)?)).optional()?.ok_or_else(||AppError::new("NOT_FOUND","会议版本不存在"))?;
    }
    v["latestVersion"] = latest;
    v["history"]=json!(read(conn,"SELECT json_object('version',version,'createdAt',created_at) FROM coordination_meeting_versions WHERE meeting_id=? ORDER BY version DESC",&[&key])?);
    v["actions"] = json!(actions(conn, None, Some(key))?);
    Ok(v)
}
fn bare_meeting(mut v: Value) -> Value {
    if let Some(map) = v.as_object_mut() {
        map.remove("latestVersion");
        map.remove("history");
        map.remove("actions");
    }
    v
}
fn persist_meeting(conn: &Connection, v: &Value, new: bool) -> Result<Value> {
    if new {
        conn.execute(
            "INSERT INTO coordination_meetings VALUES(?,?,?,?,?,?,?,?)",
            params![
                v["id"].as_str(),
                v["projectId"].as_str(),
                v["date"].as_str(),
                v["title"].as_str(),
                v["version"].as_i64(),
                v.to_string(),
                v["createdAt"].as_str(),
                v["updatedAt"].as_str()
            ],
        )?;
    } else {
        conn.execute("UPDATE coordination_meetings SET date=?,title=?,version=?,data_json=?,updated_at=? WHERE id=?",params![v["date"].as_str(),v["title"].as_str(),v["version"].as_i64(),v.to_string(),v["updatedAt"].as_str(),v["id"].as_str()])?;
    }
    conn.execute(
        "INSERT INTO coordination_meeting_versions VALUES(?,?,?,?,?)",
        params![
            id(),
            v["id"].as_str(),
            v["version"].as_i64(),
            v.to_string(),
            v["updatedAt"].as_str()
        ],
    )?;
    meeting(conn, required(v, "id")?, None)
}
fn validate_meeting(v: &Value) -> Result<()> {
    for (key, max, nonempty) in [
        ("title", 300, true),
        ("attendees", 2000, false),
        ("objective", 10000, false),
        ("agenda", 50000, false),
        ("briefing", 100000, false),
        ("minutes", 100000, false),
        ("decisions", 50000, false),
    ] {
        text(v, key, max, nonempty)?;
    }
    date(v, "date")?;
    Ok(())
}
fn save_meeting(conn: &Connection, p: &Value) -> Result<Value> {
    let pr = required(p, "projectId")?;
    project(conn, pr)?;
    validate_meeting(p)?;
    let at = now();
    let (mut v, new) = if let Some(key) = p["meetingId"].as_str() {
        let old = meeting(conn, key, None)?;
        if old["projectId"] != pr {
            return Err(invalid("会议不能跨项目移动"));
        }
        let base = number(p, "baseVersion")?;
        if old["version"].as_i64() != Some(base) {
            return Err(conflict());
        }
        if old["date"] != p["date"] && !actions(conn, None, Some(key))?.is_empty() {
            return Err(invalid("已有行动项的会议不可修改日期，请保留原会议并新建"));
        }
        let changed_date = old["date"] != p["date"];
        let mut old = bare_meeting(old);
        if changed_date {
            old["preparationBasis"] = Value::Null;
        }
        old["version"] = json!(base + 1);
        (old, false)
    } else {
        (
            json!({"id":id(),"projectId":pr,"version":1,"createdAt":at,"preparationBasis":null}),
            true,
        )
    };
    for key in [
        "title",
        "date",
        "attendees",
        "objective",
        "agenda",
        "briefing",
        "minutes",
        "decisions",
    ] {
        v[key] = json!(text(
            p,
            key,
            if key == "date" { 10 } else { 100000 },
            false
        )?);
    }
    v["updatedAt"] = json!(at);
    persist_meeting(conn, &v, new)
}
const ACTION_JSON:&str="json_object('id',a.id,'meetingId',a.meeting_id,'projectId',a.project_id,'title',a.title,'owner',a.owner,'dueDate',a.due_date,'status',a.status,'taskId',a.task_id,'version',a.version,'createdAt',a.created_at,'updatedAt',a.updated_at)";
fn actions(conn: &Connection, project: Option<&str>, meeting: Option<&str>) -> Result<Vec<Value>> {
    let mut result=read(conn,&format!("SELECT {ACTION_JSON} FROM coordination_actions a WHERE (?1 IS NULL OR a.project_id=?1) AND (?2 IS NULL OR a.meeting_id=?2) ORDER BY a.due_date,a.id"),&[&project,&meeting])?;
    for a in &mut result {
        a["task"] = if let Some(key) = a["taskId"].as_str() {
            tasks::task(conn, key)?
        } else {
            Value::Null
        };
        a["completionState"] = if a["status"] == "dismissed" {
            json!("dismissed")
        } else if a["task"]["status"] == "done" {
            json!("done")
        } else if a["task"].is_null() {
            json!("pending_confirmation")
        } else {
            a["task"]["status"].clone()
        };
    }
    Ok(result)
}
fn action(conn: &Connection, key: &str) -> Result<Value> {
    read(
        conn,
        &format!("SELECT {ACTION_JSON} FROM coordination_actions a WHERE a.id=?"),
        &[&key],
    )?
    .into_iter()
    .next()
    .ok_or_else(|| AppError::new("NOT_FOUND", "行动项不存在"))
}
fn persist_action(conn: &Connection, v: &Value, new: bool) -> Result<Value> {
    if new {
        conn.execute(
            "INSERT INTO coordination_actions VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            params![
                v["id"].as_str(),
                v["meetingId"].as_str(),
                v["projectId"].as_str(),
                v["title"].as_str(),
                v["owner"].as_str(),
                v["dueDate"].as_str(),
                v["status"].as_str(),
                v["taskId"].as_str(),
                v["version"].as_i64(),
                v["createdAt"].as_str(),
                v["updatedAt"].as_str()
            ],
        )?;
    } else {
        conn.execute("UPDATE coordination_actions SET title=?,owner=?,due_date=?,status=?,task_id=?,version=?,updated_at=? WHERE id=?",params![v["title"].as_str(),v["owner"].as_str(),v["dueDate"].as_str(),v["status"].as_str(),v["taskId"].as_str(),v["version"].as_i64(),v["updatedAt"].as_str(),v["id"].as_str()])?;
    }
    conn.execute(
        "INSERT INTO coordination_action_versions VALUES(?,?,?,?,?)",
        params![
            id(),
            v["id"].as_str(),
            v["version"].as_i64(),
            v.to_string(),
            v["updatedAt"].as_str()
        ],
    )?;
    action(conn, required(v, "id")?)
}
fn save_action(conn: &Connection, p: &Value) -> Result<Value> {
    let meeting_id = required(p, "meetingId")?;
    let m = meeting(conn, meeting_id, None)?;
    let title = text(p, "title", 300, true)?;
    let owner = text(p, "owner", 300, true)?;
    let due = date(p, "dueDate")?;
    if due.as_str() < required(&m, "date")? {
        return Err(invalid("行动项期限不能早于会议日期"));
    }
    if !matches!(p["status"].as_str(), Some("open" | "dismissed")) {
        return Err(invalid("行动项状态无效"));
    }
    let at = now();
    let (mut v, new) = if let Some(key) = p["actionId"].as_str() {
        let mut old = action(conn, key)?;
        if old["meetingId"] != meeting_id || old["projectId"] != m["projectId"] {
            return Err(invalid("行动项不属于该会议及项目"));
        }
        if !old["taskId"].is_null() {
            return Err(invalid("行动项已转为任务，请在任务中更新"));
        }
        let base = number(p, "baseVersion")?;
        if old["version"].as_i64() != Some(base) {
            return Err(conflict());
        }
        old["version"] = json!(base + 1);
        (old, false)
    } else {
        (
            json!({"id":id(),"meetingId":meeting_id,"projectId":m["projectId"],"version":1,"taskId":null,"createdAt":at}),
            true,
        )
    };
    v["title"] = json!(title);
    v["owner"] = json!(owner);
    v["dueDate"] = json!(due);
    v["status"] = p["status"].clone();
    v["updatedAt"] = json!(at);
    persist_action(conn, &v, new)
}
fn confirm_action(conn: &Connection, p: &Value) -> Result<Value> {
    let mut a = action(conn, required(p, "actionId")?)?;
    // An already confirmed action is its own stable idempotency key.
    if let Some(key) = a["taskId"].as_str() {
        return Ok(json!({"action":a,"task":tasks::task(conn,key)?,"alreadyConfirmed":true}));
    }
    if a["version"].as_i64() != Some(number(p, "baseVersion")?) {
        return Err(conflict());
    }
    if a["status"] != "open" {
        return Err(invalid("已撤销行动项不能确认"));
    }
    let work = date(p, "workDate")?;
    let m = meeting(conn, required(&a, "meetingId")?, None)?;
    if work.as_str() < required(&m, "date")? {
        return Err(invalid("确认工作日期不能早于会议日期"));
    }
    let category = match p.get("category") {
        None => "follow_up",
        Some(Value::String(s)) if matches!(s.as_str(), "action" | "follow_up") => s.as_str(),
        _ => return Err(invalid("执行方式必须为亲自执行或跟进交付")),
    };
    let payload = json!({"projectId":a["projectId"],"title":a["title"],"description":format!("会议：{}；会议记录 {}；行动项 {}",required(&m,"title")?,required(&m,"id")?,required(&a,"id")?),"category":category,"assignee":a["owner"],"priority":"medium","status":"todo","progress":0,"dueDate":a["dueDate"],"plannedDate":null,"workDate":work});
    let task = tasks::insert_task(conn, &payload, "manual", None, &[], "用户确认会议行动项")?;
    a["taskId"] = task["id"].clone();
    a["status"] = json!("confirmed");
    a["version"] = json!(number(&a, "version")? + 1);
    a["updatedAt"] = json!(now());
    persist_action(conn, &a, false)?;
    Ok(json!({"action":a,"task":task,"alreadyConfirmed":false}))
}
fn prepare_meeting(conn: &Connection, p: &Value) -> Result<Value> {
    let key = required(p, "meetingId")?;
    let mut m = bare_meeting(meeting(conn, key, None)?);
    let base = number(p, "baseVersion")?;
    if m["version"].as_i64() != Some(base) {
        return Err(conflict());
    }
    let project = required(&m, "projectId")?;
    let day = required(&m, "date")?;
    let mut prior = Vec::new();
    for a in actions(conn, Some(project), None)? {
        if a["meetingId"] == key || a["status"] == "dismissed" || a["completionState"] == "done" {
            continue;
        }
        let other = meeting(conn, required(&a, "meetingId")?, None)?;
        if required(&other, "date")? < day
            || (required(&other, "date")? == day
                && required(&other, "createdAt")? < required(&m, "createdAt")?)
        {
            let mut a = a;
            a["sourceMeetingTitle"] = other["title"].clone();
            a["sourceMeetingDate"] = other["date"].clone();
            a["sourceMeetingVersion"] = other["version"].clone();
            prior.push(a);
        }
    }
    let basis = snapshot(conn, Some(project), day, day)?;
    let mut briefing = format!(
        "会前资料 · {}\n\n上次及此前会议未结行动项：\n",
        required(&m, "title")?
    );
    for a in &prior {
        let assignment = if a["task"].is_null() {
            format!(
                "{} · 期限 {}",
                required(a, "owner")?,
                required(a, "dueDate")?
            )
        } else {
            format!(
                "生成时任务负责人：{} · 期限 {}；会议原约定：{} · 期限 {}",
                a["task"]["assignee"].as_str().unwrap_or("待定"),
                a["task"]["dueDate"].as_str().unwrap_or("未设置"),
                required(a, "owner")?,
                required(a, "dueDate")?
            )
        };
        briefing.push_str(&format!(
            "- {} · {} · {} [行动项 {} v{}；会议 {}]\n",
            required(a, "title")?,
            assignment,
            status_label(a["completionState"].as_str().unwrap_or("")),
            required(a, "id")?,
            a["version"],
            required(a, "meetingId")?
        ));
    }
    if prior.is_empty() {
        briefing.push_str("- 暂无已记录的未结行动项。\n");
    }
    briefing.push_str("\n以上行动项与完成状态为生成时当前快照；下列项目事项按会议日期取已记录的历史版本。\n\n阻塞与待拍板事项：\n");
    for e in values(&basis, "taskStates")
        .iter()
        .filter(|e| e["after"]["status"] == "blocked")
    {
        briefing.push_str(&format!(
            "- {} [任务 {} v{}；事件 {}]\n",
            task_label(&e["after"]),
            required(e, "taskId")?,
            e["version"],
            required(e, "id")?
        ));
    }
    for e in values(&basis, "governance")
        .iter()
        .filter(|e| e["snapshot"]["status"] != "closed")
    {
        let v = &e["snapshot"];
        briefing.push_str(&format!(
            "- {} · {} · 负责人 {} · 期限 {} [记录 {} v{}；历史 {}]\n",
            v["kind"].as_str().unwrap_or(""),
            v["title"].as_str().unwrap_or(""),
            v["owner"].as_str().unwrap_or("待定"),
            v["dueDate"].as_str().unwrap_or("未设置"),
            v["id"].as_str().unwrap_or(""),
            e["version"],
            e["recordId"].as_str().unwrap_or("")
        ));
    }
    briefing.push_str("\n里程碑与依赖：生成时当前快照；详见准备依据，不代表会议日期历史。\n");
    m["agenda"]=json!(format!("1. 核对会议目标：{}\n2. 回顾此前会议未结行动项（{} 项）\n3. 讨论阻塞、风险、问题与待拍板事项\n4. 核对交付与验收安排\n5. 明确结论、行动项负责人及期限",m["objective"].as_str().unwrap_or(""),prior.len()));
    m["briefing"] = json!(briefing);
    m["preparationBasis"] =
        json!({"generatedAt":now(),"previousActions":prior,"projectSnapshot":basis});
    m["version"] = json!(base + 1);
    m["updatedAt"] = json!(now());
    persist_meeting(conn, &m, false)
}

pub(crate) fn dispatch(conn: &mut Connection, command: &str, p: &Value) -> Result<Value> {
    match command {
        "coordination_list" => {
            let project = scope(conn, p)?;
            let reports=read(conn,&format!("SELECT {REPORT_JSON} FROM coordination_reports WHERE (?1 IS NULL OR project_id=?1) ORDER BY end_date DESC,updated_at DESC"),&[&project])?;
            let meetings=read(conn,"SELECT json_object('id',id,'projectId',project_id,'date',date,'title',title,'version',version,'updatedAt',updated_at) FROM coordination_meetings WHERE (?1 IS NULL OR project_id=?1) ORDER BY date DESC,updated_at DESC",&[&project])?;
            Ok(
                json!({"reports":reports,"meetings":meetings,"actions":actions(conn,project.as_deref(),None)?}),
            )
        }
        "coordination_get_report" => report(
            conn,
            required(p, "reportId")?,
            if p.get("version").is_some() {
                Some(number(p, "version")?)
            } else {
                None
            },
        ),
        "coordination_get_meeting" => meeting(
            conn,
            required(p, "meetingId")?,
            if p.get("version").is_some() {
                Some(number(p, "version")?)
            } else {
                None
            },
        ),
        _ => {
            let tx = conn.transaction()?;
            let result = match command {
                "coordination_generate_report" => generate_report(&tx, p),
                "coordination_save_report" => save_report(&tx, p),
                "coordination_save_meeting" => save_meeting(&tx, p),
                "coordination_prepare_meeting" => prepare_meeting(&tx, p),
                "coordination_save_action" => save_action(&tx, p),
                "coordination_confirm_action" => confirm_action(&tx, p),
                _ => Err(AppError::new("UNKNOWN_COMMAND", "未知协作操作")),
            }?;
            tx.commit()?;
            Ok(result)
        }
    }
}

fn verify_task_event(
    conn: &Connection,
    v: &Value,
    project: Option<&str>,
    start: Option<&str>,
    end: &str,
) -> Result<()> {
    let day = required(v, "workDate")?;
    tasks::valid_date(day)?;
    if day > end || start.is_some_and(|s| day < s) || project.is_some_and(|p| v["projectId"] != p) {
        return Err(invalid("报告任务依据日期或项目不一致"));
    }
    let actual = read(
        conn,
        &format!("SELECT {EVENT_JSON} FROM task_events WHERE id=?"),
        &[&required(v, "id")?],
    )?
    .into_iter()
    .next();
    if actual.as_ref() != Some(v) {
        return Err(invalid("任务依据与原始事件不一致"));
    }
    Ok(())
}
fn validate_basis(
    conn: &Connection,
    b: &Value,
    project: Option<&str>,
    start: &str,
    end: &str,
) -> Result<()> {
    if b["projectId"].as_str() != project || b["startDate"] != start || b["endDate"] != end {
        return Err(invalid("报告范围与依据不一致"));
    }
    timestamp(required(b, "generatedAt")?)?;
    for key in [
        "taskEvents",
        "taskStates",
        "completed",
        "governance",
        "changes",
        "deliverables",
        "currentMilestones",
        "currentRelations",
    ] {
        if !b[key].is_array() {
            return Err(invalid("报告依据数组缺失"));
        }
    }
    for e in values(b, "taskEvents") {
        verify_task_event(conn, &e, project, Some(start), end)?;
    }
    let states = values(b, "taskStates");
    let mut seen = HashSet::new();
    for e in &states {
        verify_task_event(conn, e, project, None, end)?;
        if !seen.insert(required(e, "taskId")?) {
            return Err(invalid("任务截止状态重复"));
        }
    }
    let expected: Vec<Value> = states
        .iter()
        .filter(|e| {
            e["after"]["status"] == "done"
                && values(b, "taskEvents").iter().any(|v| {
                    v["taskId"] == e["taskId"]
                        && v["after"]["status"] == "done"
                        && v["before"]["status"] != "done"
                })
        })
        .cloned()
        .collect();
    if b["completed"] != json!(expected) {
        return Err(invalid("本期完成与期间事件及截止状态不一致"));
    }
    for delivery in values(b, "deliverables") {
        if delivery["acceptanceCheck"] != acceptance_check(&delivery["snapshot"], &states) {
            return Err(invalid("验收复核判断与截止日任务快照不一致"));
        }
    }
    for (key, table) in [
        ("governance", "governance_revisions"),
        ("changes", "change_request_history"),
        ("deliverables", "deliverable_history"),
    ] {
        for e in values(b, key) {
            let v = &e["snapshot"];
            if project.is_some_and(|p| v["projectId"] != p) || required(&e, "workDate")? > end {
                return Err(invalid("治理与变更依据跨项目或超出截止日"));
            }
            let (actual, version, day): (Value, i64, String) = conn.query_row(
                &format!("SELECT snapshot_json,version,work_date FROM {table} WHERE id=?"),
                [required(&e, "recordId")?],
                |r| Ok((decode(r.get(0)?)?, r.get(1)?, r.get(2)?)),
            )?;
            if actual != *v || e["version"].as_i64() != Some(version) || e["workDate"] != day {
                return Err(invalid("治理与变更历史快照不一致"));
            }
        }
    }
    for m in values(b, "currentMilestones") {
        let actual: Option<String> = conn
            .query_row(
                "SELECT project_id FROM milestones WHERE id=?",
                [required(&m, "id")?],
                |r| r.get(0),
            )
            .optional()?;
        if actual.as_deref() != m["projectId"].as_str()
            || project.is_some_and(|p| m["projectId"] != p)
        {
            return Err(invalid("里程碑快照跨项目"));
        }
        number(&m, "version")?;
        timestamp(required(&m, "updatedAt")?)?;
    }
    for r in values(b, "currentRelations") {
        let t = tasks::task(conn, required(&r, "taskId")?)?;
        if r["projectId"] != t["projectId"] || project.is_some_and(|p| r["projectId"] != p) {
            return Err(invalid("依赖快照跨项目"));
        }
    }
    Ok(())
}
fn validate_recorded_task(conn: &Connection, t: &Value) -> Result<()> {
    tasks::validate_snapshot(conn, t)?;
    let raw: Value = conn.query_row(
        "SELECT after_json FROM task_events WHERE task_id=? AND version=?",
        params![t["id"].as_str(), t["version"].as_i64()],
        |r| decode(r.get(0)?),
    )?;
    if raw != *t {
        return Err(invalid("行动项中的任务快照与任务历史不一致"));
    }
    Ok(())
}
pub(crate) fn validate_backup(conn: &Connection) -> Result<()> {
    validate_rows(conn).map_err(|e| {
        AppError::new(
            "INVALID_BACKUP",
            format!("周报与会议数据无效：{}", e.message),
        )
    })
}
fn validate_rows(conn: &Connection) -> Result<()> {
    for (table, keys) in [
        ("coordination_reports", "id"),
        ("coordination_report_versions", "id"),
        ("coordination_report_versions", "report_id,version"),
        ("coordination_meetings", "id"),
        ("coordination_meeting_versions", "id"),
        ("coordination_meeting_versions", "meeting_id,version"),
        ("coordination_actions", "id"),
        ("coordination_action_versions", "id"),
        ("coordination_action_versions", "action_id,version"),
    ] {
        if conn.query_row(
            &format!("SELECT EXISTS(SELECT 1 FROM {table} GROUP BY {keys} HAVING count(*)>1)"),
            [],
            |r| r.get::<_, bool>(0),
        )? {
            return Err(invalid("记录标识或版本重复"));
        }
    }
    let reports = read(
        conn,
        &format!("SELECT {REPORT_JSON} FROM coordination_reports"),
        &[],
    )?;
    for r in reports {
        let key = required(&r, "id")?;
        let project_id = r["projectId"].as_str();
        if let Some(p) = project_id {
            project(conn, p)?;
        }
        let start = date(&r, "startDate")?;
        let end = date(&r, "endDate")?;
        if start > end {
            return Err(invalid("报告日期逆序"));
        }
        let max = number(&r, "version")?;
        timestamp(required(&r, "createdAt")?)?;
        timestamp(required(&r, "updatedAt")?)?;
        let versions=read(conn,"SELECT json_object('id',id,'version',version,'content',content,'basis',json(snapshot_json),'edited',edited,'createdAt',created_at) FROM coordination_report_versions WHERE report_id=? ORDER BY version",&[&key])?;
        if versions.len() as i64 != max {
            return Err(invalid("报告版本链不完整"));
        }
        for (index, v) in versions.iter().enumerate() {
            if v["version"].as_i64() != Some(index as i64 + 1)
                || !matches!(v["edited"].as_i64(), Some(0 | 1))
            {
                return Err(invalid("报告版本或编辑标记无效"));
            }
            text(v, "content", 200000, true)?;
            timestamp(required(v, "createdAt")?)?;
            validate_basis(conn, &v["basis"], project_id, &start, &end)?;
            if v["edited"] == 1 && index > 0 && v["basis"] != versions[index - 1]["basis"] {
                return Err(invalid("编辑报告修改了冻结依据"));
            }
        }
    }
    let meeting_ids:Vec<Value>=read(conn,"SELECT json_object('id',id,'projectId',project_id,'date',date,'title',title,'version',version,'data',json(data_json),'createdAt',created_at,'updatedAt',updated_at) FROM coordination_meetings",&[])?;
    for row in meeting_ids {
        let key = required(&row, "id")?;
        let m = &row["data"];
        project(conn, required(m, "projectId")?)?;
        validate_meeting(m)?;
        for k in [
            "id",
            "projectId",
            "date",
            "title",
            "version",
            "createdAt",
            "updatedAt",
        ] {
            if row[k] != m[k] {
                return Err(invalid("会议索引与内容不一致"));
            }
        }
        let versions=read(conn,"SELECT json_object('version',version,'snapshot',json(snapshot_json),'createdAt',created_at) FROM coordination_meeting_versions WHERE meeting_id=? ORDER BY version",&[&key])?;
        if versions.len() as i64 != number(m, "version")?
            || versions.last().map(|v| &v["snapshot"]) != Some(m)
        {
            return Err(invalid("会议版本链不完整"));
        }
        for (i, v) in versions.iter().enumerate() {
            let snap = &v["snapshot"];
            if v["version"].as_i64() != Some(i as i64 + 1)
                || snap["version"] != v["version"]
                || snap["id"] != key
                || snap["projectId"] != m["projectId"]
            {
                return Err(invalid("会议历史版本或项目不一致"));
            }
            validate_meeting(snap)?;
            timestamp(required(v, "createdAt")?)?;
            if !snap["preparationBasis"].is_null() {
                let b = &snap["preparationBasis"];
                timestamp(required(b, "generatedAt")?)?;
                let day = required(snap, "date")?;
                validate_basis(
                    conn,
                    &b["projectSnapshot"],
                    snap["projectId"].as_str(),
                    day,
                    day,
                )?;
                for a in values(b, "previousActions") {
                    let actual = action(conn, required(&a, "id")?)?;
                    let other = meeting(conn, required(&a, "meetingId")?, None)?;
                    if a["projectId"] != m["projectId"]
                        || other["projectId"] != m["projectId"]
                        || required(&other, "date")? > day
                        || actual["meetingId"] != a["meetingId"]
                    {
                        return Err(invalid("会前行动项跨项目或来自未来会议"));
                    }
                    let source:Value=conn.query_row("SELECT snapshot_json FROM coordination_action_versions WHERE action_id=? AND version=?",params![a["id"].as_str(),a["version"].as_i64()],|r|decode(r.get(0)?))?;
                    let source_meeting:Value=conn.query_row("SELECT snapshot_json FROM coordination_meeting_versions WHERE meeting_id=? AND version=?",params![a["meetingId"].as_str(),a["sourceMeetingVersion"].as_i64()],|r|decode(r.get(0)?))?;
                    if source_meeting["title"] != a["sourceMeetingTitle"]
                        || source_meeting["date"] != a["sourceMeetingDate"]
                    {
                        return Err(invalid("会前行动项来源会议版本不一致"));
                    }
                    if !a["task"].is_null() {
                        validate_recorded_task(conn, &a["task"])?;
                        if a["task"]["id"] != a["taskId"]
                            || a["task"]["projectId"] != a["projectId"]
                            || a["task"]["status"] == "done"
                        {
                            return Err(invalid("未结行动项的任务快照无效"));
                        }
                    }
                    for field in [
                        "id",
                        "meetingId",
                        "projectId",
                        "title",
                        "owner",
                        "dueDate",
                        "status",
                        "taskId",
                        "version",
                        "createdAt",
                        "updatedAt",
                    ] {
                        if a[field] != source[field] {
                            return Err(invalid("会前行动项快照不一致"));
                        }
                    }
                }
            }
        }
    }
    let mut task_ids = HashSet::new();
    for a in actions(conn, None, None)? {
        let key = required(&a, "id")?;
        let m = meeting(conn, required(&a, "meetingId")?, None)?;
        if a["projectId"] != m["projectId"] || required(&a, "dueDate")? < required(&m, "date")? {
            return Err(invalid("行动项项目或期限无效"));
        }
        date(&a, "dueDate")?;
        text(&a, "title", 300, true)?;
        text(&a, "owner", 300, true)?;
        if !matches!(
            a["status"].as_str(),
            Some("open" | "dismissed" | "confirmed")
        ) {
            return Err(invalid("行动项状态无效"));
        }
        if a["status"] == "confirmed" {
            let t = tasks::task(conn, required(&a, "taskId")?)?;
            if t["projectId"] != a["projectId"]
                || !task_ids.insert(required(&a, "taskId")?.to_owned())
            {
                return Err(invalid("行动项任务跨项目或重复"));
            }
        } else if !a["taskId"].is_null() {
            return Err(invalid("未确认行动项含任务关联"));
        }
        let versions=read(conn,"SELECT json_object('version',version,'snapshot',json(snapshot_json),'createdAt',created_at) FROM coordination_action_versions WHERE action_id=? ORDER BY version",&[&key])?;
        if versions.len() as i64 != number(&a, "version")? {
            return Err(invalid("行动项版本不完整"));
        }
        let latest = action(conn, key)?;
        for (i, v) in versions.iter().enumerate() {
            let snap = &v["snapshot"];
            if v["version"].as_i64() != Some(i as i64 + 1)
                || snap["version"] != v["version"]
                || snap["id"] != key
                || snap["meetingId"] != m["id"]
                || snap["projectId"] != m["projectId"]
            {
                return Err(invalid("行动项历史项目或版本无效"));
            }
            timestamp(required(v, "createdAt")?)?;
            text(snap, "title", 300, true)?;
            text(snap, "owner", 300, true)?;
            date(snap, "dueDate")?;
            timestamp(required(snap, "createdAt")?)?;
            timestamp(required(snap, "updatedAt")?)?;
            if required(snap, "dueDate")? < required(&m, "date")?
                || !matches!(
                    snap["status"].as_str(),
                    Some("open" | "dismissed" | "confirmed")
                )
            {
                return Err(invalid("行动项历史期限或状态无效"));
            }
            if i > 0 && versions[i - 1]["snapshot"]["status"] == "confirmed" {
                return Err(invalid("已确认行动项不能继续改写历史"));
            }
            if snap["status"] == "confirmed" {
                let first: Value = conn.query_row(
                    "SELECT after_json FROM task_events WHERE task_id=? AND version=1",
                    [required(snap, "taskId")?],
                    |r| decode(r.get(0)?),
                )?;
                if first["projectId"] != snap["projectId"]
                    || first["title"] != snap["title"]
                    || first["assignee"] != snap["owner"]
                    || first["dueDate"] != snap["dueDate"]
                    || !required(&first, "description")?.contains(key)
                {
                    return Err(invalid("确认行动项与正式任务初始记录不一致"));
                }
                let first_date: String = conn.query_row(
                    "SELECT work_date FROM task_events WHERE task_id=? AND version=1",
                    [required(snap, "taskId")?],
                    |r| r.get(0),
                )?;
                if first_date.as_str() < required(&m, "date")? {
                    return Err(invalid("行动项确认日期早于会议"));
                }
            } else if !snap["taskId"].is_null() {
                return Err(invalid("未确认行动项历史包含任务关联"));
            }
        }
        if let Some(last) = versions.last() {
            if latest != last["snapshot"] {
                return Err(invalid("行动项与最新版本不一致"));
            }
        }
    }
    // Detect orphan version rows even if the archive replaced foreign key declarations.
    for(sql,label)in[("SELECT count(*) FROM coordination_report_versions v LEFT JOIN coordination_reports p ON p.id=v.report_id WHERE p.id IS NULL","周报"),("SELECT count(*) FROM coordination_meeting_versions v LEFT JOIN coordination_meetings p ON p.id=v.meeting_id WHERE p.id IS NULL","会议"),("SELECT count(*) FROM coordination_action_versions v LEFT JOIN coordination_actions p ON p.id=v.action_id WHERE p.id IS NULL","行动项")] {if conn.query_row(sql,[],|r|r.get::<_,i64>(0))?!=0{return Err(invalid(&format!("{label}历史缺少主体")));}}
    Ok(())
}
