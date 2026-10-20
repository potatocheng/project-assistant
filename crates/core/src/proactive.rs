//! Persistent, deterministic oversight. Drafts are local suggestions: this module
//! has no network access and never changes a task or sends a message.
use crate::{hash, id, required, AppError, Result};
use chrono::{DateTime, Duration, FixedOffset, Local, SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};

pub(crate) fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch(r#"
CREATE TABLE proactive_settings(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),review_minutes INTEGER NOT NULL CHECK(review_minutes BETWEEN 5 AND 10080),revision TEXT NOT NULL,last_run_at TEXT,last_error TEXT,source_hash TEXT);
CREATE TABLE proactive_actions(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),target_kind TEXT NOT NULL,target_id TEXT NOT NULL,status TEXT NOT NULL,priority INTEGER NOT NULL,version INTEGER NOT NULL,next_check_at TEXT,source_hash TEXT NOT NULL,data_json TEXT NOT NULL,UNIQUE(project_id,target_kind,target_id));
CREATE TABLE proactive_history(id TEXT PRIMARY KEY,action_id TEXT NOT NULL REFERENCES proactive_actions(id),project_id TEXT NOT NULL REFERENCES projects(id),kind TEXT NOT NULL,note TEXT NOT NULL,created_at TEXT NOT NULL,version INTEGER NOT NULL,snapshot_json TEXT NOT NULL,UNIQUE(action_id,version));
CREATE INDEX proactive_due ON proactive_actions(status,next_check_at);
CREATE INDEX proactive_project ON proactive_actions(project_id,status,priority);
CREATE INDEX proactive_audit ON proactive_history(action_id,created_at,id);
"#)?;
    conn.execute(
        "INSERT INTO proactive_settings VALUES(1,1,60,?,NULL,NULL,NULL)",
        [id()],
    )?;
    Ok(())
}

fn invalid(message: &str) -> AppError {
    AppError::new("VALIDATION", message)
}
fn conflict() -> AppError {
    AppError::new("VERSION_CONFLICT", "主动跟进已更新，请刷新后重试")
}
fn stamp(at: &DateTime<FixedOffset>) -> String {
    at.with_timezone(&Utc)
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}
fn parse_stamp(value: &str) -> Result<DateTime<FixedOffset>> {
    DateTime::parse_from_rfc3339(value).map_err(|_| invalid("复查时间必须为有效 RFC3339 时间"))
}
fn future_date(date: Option<&str>, at: &DateTime<FixedOffset>) -> Option<String> {
    let date = date.filter(|d| *d > at.format("%Y-%m-%d").to_string().as_str())?;
    let parsed =
        DateTime::parse_from_rfc3339(&format!("{date}T00:00:00{}", at.format("%:z"))).ok()?;
    Some(stamp(&parsed))
}
fn later(a: Option<String>, b: Option<String>) -> Option<String> {
    match (a, b) {
        (Some(a), Some(b)) => Some(a.max(b)),
        (a, b) => a.or(b),
    }
}
fn scope(conn: &Connection, p: &Value) -> Result<Option<String>> {
    let project = match p.get("projectId") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if s.trim().is_empty() => None,
        Some(Value::String(s)) => Some(s.trim().to_owned()),
        _ => return Err(invalid("项目范围无效")),
    };
    if let Some(project) = &project {
        if !conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM projects WHERE id=?)",
            [project],
            |r| r.get::<_, bool>(0),
        )? {
            return Err(AppError::new("NOT_FOUND", "项目不存在"));
        }
    }
    Ok(project)
}
fn settings(conn: &Connection) -> Result<Value> {
    Ok(conn.query_row("SELECT enabled,review_minutes,revision FROM proactive_settings WHERE id=1", [], |r| {
        Ok(json!({"enabled":r.get::<_,bool>(0)?,"reviewMinutes":r.get::<_,i64>(1)?,"revision":r.get::<_,String>(2)?}))
    })?)
}
fn decode(raw: String) -> rusqlite::Result<Value> {
    serde_json::from_str(&raw).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })
}
fn read_actions(conn: &Connection, project: Option<&str>) -> Result<Vec<Value>> {
    let mut s = conn.prepare("SELECT data_json FROM proactive_actions WHERE (?1 IS NULL OR project_id=?1) ORDER BY CASE status WHEN 'ready' THEN 0 WHEN 'watching' THEN 1 WHEN 'snoozed' THEN 2 WHEN 'resolved' THEN 3 ELSE 4 END,priority DESC,json_extract(data_json,'$.createdAt'),id")?;
    let rows = s
        .query_map([project], |r| decode(r.get(0)?))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}
fn center(conn: &Connection, project: Option<&str>) -> Result<Value> {
    let actions = read_actions(conn, project)?;
    let mut counts = json!({"ready":0,"watching":0,"snoozed":0,"resolved":0,"dismissed":0,"total":actions.len()});
    for a in &actions {
        let key = a["status"]
            .as_str()
            .ok_or_else(|| invalid("主动跟进状态无效"))?;
        counts[key] = json!(counts[key].as_i64().unwrap_or(0) + 1);
    }
    let (last_run, last_error): (Option<String>, Option<String>) = conn.query_row(
        "SELECT last_run_at,last_error FROM proactive_settings WHERE id=1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let mut s = conn.prepare("SELECT id,action_id,kind,note,created_at FROM proactive_history WHERE (?1 IS NULL OR project_id=?1) ORDER BY created_at DESC,rowid DESC LIMIT 200")?;
    let history = s.query_map([project], |r| Ok(json!({"id":r.get::<_,String>(0)?,"actionId":r.get::<_,String>(1)?,"kind":r.get::<_,String>(2)?,"note":r.get::<_,String>(3)?,"createdAt":r.get::<_,String>(4)?})))?.collect::<std::result::Result<Vec<_>,_>>()?;
    Ok(
        json!({"settings":settings(conn)?,"lastRunAt":last_run,"lastError":last_error,"counts":counts,"actions":actions,"history":history}),
    )
}

#[derive(Clone)]
struct Candidate {
    project: String,
    name: String,
    kind: String,
    target: String,
    title: String,
    priority: i64,
    reasons: Vec<String>,
    evidence: Vec<Value>,
    source: Vec<Value>,
    suggested: String,
    draft: String,
    hold: Option<String>,
}
impl Candidate {
    fn new(project: &str, name: &str, kind: &str, target: &str, title: &str) -> Self {
        Self {
            project: project.into(),
            name: name.into(),
            kind: kind.into(),
            target: target.into(),
            title: title.into(),
            priority: 0,
            reasons: vec![],
            evidence: vec![],
            source: vec![],
            suggested: String::new(),
            draft: String::new(),
            hold: None,
        }
    }
    fn basis(&mut self, priority: i64, label: &str, detail: Value, source: Value) {
        self.priority = self.priority.max(priority);
        if !self.reasons.iter().any(|r| r == label) {
            self.reasons.push(label.to_owned());
            let mut facts = vec![label.to_owned()];
            if let Some(task) = source.get("task") {
                if let Some(owner) = task["assignee"].as_str().filter(|s| !s.is_empty()) {
                    facts.push(format!("负责人：{owner}"));
                }
                let status = match task["status"].as_str().unwrap_or("") {
                    "blocked" => "阻塞",
                    "in_progress" => "进行中",
                    "todo" => "待开始",
                    other => other,
                };
                facts.push(format!("任务状态：{status}"));
                if let Some(due) = task["dueDate"].as_str() {
                    facts.push(format!("截止日期：{due}"));
                }
            }
            if let Some(date) = detail["referenceDate"].as_str() {
                facts.push(format!("依据日期：{date}"));
            }
            if let Some(relations) = detail.as_array() {
                for relation in relations {
                    if let Some(reason) = relation["reason"].as_str().filter(|s| !s.is_empty()) {
                        facts.push(format!("依赖说明：{reason}"));
                    }
                }
            }
            self.evidence.push(json!({"label":label,"detail":facts.join("；"),"targetKind":self.kind,"targetId":self.target}));
        }
        self.source.push(source);
    }
    fn fingerprint(&self) -> String {
        hash(
            json!([
                self.project,
                self.kind,
                self.target,
                self.title,
                self.source,
                self.hold
            ])
            .to_string()
            .as_bytes(),
        )
    }
}
fn candidate_key(project: &str, kind: &str, target: &str) -> String {
    format!("{project}/{kind}/{target}")
}
fn from_task<'a>(
    items: &'a mut BTreeMap<String, Candidate>,
    task: &Value,
    name: &str,
) -> &'a mut Candidate {
    let (project, target) = (
        task["projectId"].as_str().unwrap(),
        task["id"].as_str().unwrap(),
    );
    items
        .entry(candidate_key(project, "task", target))
        .or_insert_with(|| {
            Candidate::new(
                project,
                name,
                "task",
                target,
                task["title"].as_str().unwrap(),
            )
        })
}
fn candidates(
    conn: &Connection,
    project: Option<&str>,
    at: &DateTime<FixedOffset>,
) -> Result<BTreeMap<String, Candidate>> {
    let date = at.format("%Y-%m-%d").to_string();
    let p = json!({"date":date,"projectId":project});
    let follow = crate::delivery::follow_up_center(conn, &p)?;
    let delivery = crate::delivery::overview(conn, &p)?;
    let management = crate::management::attention(conn, &p)?;
    let names: HashMap<String, String> = delivery["projects"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| {
            (
                p["projectId"].as_str().unwrap().into(),
                p["name"].as_str().unwrap().into(),
            )
        })
        .collect();
    let states: HashMap<String, Value> = follow["taskStates"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| (s["taskId"].as_str().unwrap().into(), s.clone()))
        .collect();
    let mut output = BTreeMap::new();
    for item in follow["items"].as_array().unwrap() {
        let task = &item["task"];
        let c = from_task(
            &mut output,
            task,
            item["projectName"].as_str().unwrap_or(""),
        );
        for reason in item["reasons"].as_array().unwrap() {
            let priority = match reason["kind"].as_str() {
                Some("overdue") => 80 + reason["days"].as_i64().unwrap_or(0).clamp(0, 10),
                Some("follow_up") => 75,
                Some("stale") => 65,
                _ => 55,
            };
            c.basis(priority,reason["label"].as_str().unwrap(),reason.clone(),json!({"task":task,"reasonKind":reason["kind"],"referenceDate":reason["referenceDate"],"followUpVersion":item["followUpVersion"],"lastFollowUp":item["lastFollowUp"]}));
        }
        c.draft = item["draft"].as_str().unwrap_or("").into();
    }
    for project in delivery["projects"].as_array().unwrap() {
        let name = project["name"].as_str().unwrap();
        let pid = project["projectId"].as_str().unwrap();
        for blocker in project["blockers"].as_array().unwrap() {
            let task = &blocker["task"];
            let c = from_task(&mut output, task, name);
            let downstream:i64=conn.query_row("SELECT count(*) FROM task_relations r JOIN tasks t ON t.id=r.task_id WHERE r.active=1 AND r.kind='dependency' AND r.target_id=? AND t.status NOT IN ('done','cancelled')",[task["id"].as_str()],|r|r.get(0))?;
            c.basis(
                82 + downstream.min(5),
                "任务存在阻塞或未完成的前置依赖",
                blocker["relations"].clone(),
                blocker.clone(),
            );
            c.source.push(json!({"activeDownstreamTasks":downstream}));
        }
        for basis in project["basis"].as_array().unwrap() {
            let (kind, target, title, source) = match basis["kind"].as_str() {
                Some("milestone") => {
                    let target = basis["milestoneId"].as_str().unwrap();
                    let m = project["milestones"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|m| m["id"] == target)
                        .unwrap();
                    ("milestone", target, m["title"].as_str().unwrap(), m.clone())
                }
                Some("project")
                    if project["profile"]["status"] == "active"
                        || project["profile"]["status"] == "completed" =>
                {
                    (
                        "project",
                        pid,
                        name,
                        json!({"profile":project["profile"],"basis":basis}),
                    )
                }
                _ => continue,
            };
            let c = output
                .entry(candidate_key(pid, kind, target))
                .or_insert_with(|| Candidate::new(pid, name, kind, target, title));
            c.basis(
                if kind == "milestone" { 85 } else { 80 },
                basis["label"].as_str().unwrap_or("交付需要复查"),
                basis.clone(),
                source,
            );
        }
    }
    // Reuse management attention so governance, approvals, and acceptance use
    // exactly the same evidence as the management screens.
    for item in management["items"].as_array().unwrap() {
        let pid = item["projectId"].as_str().unwrap();
        let kind = item["kind"].as_str().unwrap();
        let target = item["id"].as_str().unwrap();
        let c = output
            .entry(candidate_key(pid, kind, target))
            .or_insert_with(|| {
                Candidate::new(
                    pid,
                    names.get(pid).map(String::as_str).unwrap_or(""),
                    kind,
                    target,
                    item["title"].as_str().unwrap_or("管理事项"),
                )
            });
        for reason in item["reasons"].as_array().unwrap() {
            c.basis(
                match reason["kind"].as_str() {
                    Some("high_severity") => 95,
                    Some("decision_pending") => 90,
                    _ => 80,
                },
                reason["label"].as_str().unwrap_or("管理事项需要处理"),
                reason.clone(),
                json!({"version":item["version"],"reasonKind":reason["kind"]}),
            );
        }
    }
    for c in output.values_mut() {
        if c.kind == "task" {
            let task = crate::tasks::task(conn, &c.target)?;
            c.priority = (c.priority
                + match task["priority"].as_str() {
                    Some("high") => 10,
                    Some("medium") => 4,
                    _ => 0,
                }
                + if task["dueDate"].as_str().is_some_and(|d| d <= date.as_str()) {
                    3
                } else {
                    0
                })
            .min(100);
            if let Some(state) = states.get(&c.target) {
                c.hold = later(
                    future_date(state["snoozedUntil"].as_str(), at),
                    future_date(state["nextFollowUpDate"].as_str(), at),
                );
                c.source.push(state.clone());
            }
            let owner = task["assignee"]
                .as_str()
                .filter(|s| !s.is_empty())
                .unwrap_or("负责人");
            let has_reason = |kind: &str| c.source.iter().any(|s| s["reasonKind"] == kind);
            c.suggested = if task["status"] == "blocked"
                || c.source.iter().any(|s| s.get("relations").is_some())
            {
                format!(
                    "向{owner}核实「{}」的解除条件、前置负责人及所需协助，记录下一次检查点。",
                    c.title
                )
            } else if has_reason("overdue") {
                format!("向{owner}核实「{}」剩余交付项和补救安排，确认负责人给出的完成预期并记录下一次检查点。",c.title)
            } else if has_reason("stale") {
                format!(
                    "向{owner}核实「{}」的最新进展和未更新原因，补记已完成项、阻塞与下一次检查点。",
                    c.title
                )
            } else if has_reason("follow_up") {
                format!(
                    "与{owner}核对「{}」上次约定后是否有新进展，确认下一步行动及复查时间。",
                    c.title
                )
            } else {
                format!(
                    "向{owner}核实「{}」临近截止日的剩余工作与风险，列出需要协调的事项。",
                    c.title
                )
            };
            if c.draft.is_empty() {
                c.draft = format!("请同步「{}」的当前阻塞、需要的协助和预计解除时间。请说明每项前置依赖的负责人及交付日期。",c.title);
            }
        } else {
            c.suggested = match c.kind.as_str() {
                "governance" => "复核风险依据、负责人及处理期限，准备需要拍板的选项。",
                "change" => "核对变更范围与排期影响，准备审批所需材料和备选方案。",
                "deliverable" => "核对交付标准与证据，准备验收或整改复核清单。",
                _ => "复核交付条件、依赖和剩余工作，准备调整排期的方案。",
            }
            .into();
            c.draft = format!("请复核「{}」。\n当前依据：{}。\n请确认处理负责人、下一步行动及明确的复查时间；需要决策时请列出可选方案与影响。",c.title,c.reasons.join("；"));
        }
    }
    // A paused or cancelled project is outside active delivery oversight until
    // the owner resumes it. Keep its audit trail, without continuing to nudge.
    let paused: HashSet<&str> = delivery["projects"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|p| {
            matches!(
                p["profile"]["status"].as_str(),
                Some("on_hold" | "cancelled")
            )
        })
        .filter_map(|p| p["projectId"].as_str())
        .collect();
    output.retain(|_, c| !paused.contains(c.project.as_str()));
    Ok(output)
}

fn resolution_note(conn: &Connection, action: &Value) -> Result<String> {
    let project_status: Option<String> = conn
        .query_row(
            "SELECT status FROM project_profiles WHERE project_id=?",
            [action["projectId"].as_str()],
            |r| r.get(0),
        )
        .optional()?;
    if project_status.as_deref() == Some("on_hold") {
        return Ok("项目已暂停，主动跟进停止；恢复项目后将重新判断".into());
    }
    if project_status.as_deref() == Some("cancelled") {
        return Ok("项目已取消，主动跟进停止；历史记录保留".into());
    }
    if action["targetKind"] == "task" {
        let status: Option<String> = conn
            .query_row(
                "SELECT status FROM tasks WHERE id=?",
                [action["targetId"].as_str()],
                |r| r.get(0),
            )
            .optional()?;
        return Ok(match status.as_deref() {
            Some("done") => "任务已标记完成，主动关注已收束",
            Some("cancelled") => "任务已取消，主动关注已收束",
            None => "来源已移除，主动关注已收束",
            _ => "当前风险条件已解除，主动关注已收束；交付状态以原始记录为准",
        }
        .into());
    }
    Ok("当前关注条件已解除或来源已关闭/移除；交付状态以原始记录为准".into())
}

fn source_fingerprint(conn: &Connection, date: &str) -> Result<String> {
    let mut output = vec![json!(date)];
    // Versioned business records plus relation/follow-up identities capture
    // meaningful writes without re-running all oversight queries every minute.
    for sql in [
        "SELECT json_array(id,name,description) FROM projects ORDER BY id",
        "SELECT json_array(id,project_id,version) FROM tasks ORDER BY id",
        "SELECT json_array(id,project_id,revision,state) FROM memories ORDER BY id",
        "SELECT json_array(project_id,version) FROM project_profiles ORDER BY project_id",
        "SELECT json_array(id,project_id,version) FROM milestones ORDER BY id",
        "SELECT json_array(milestone_id,task_id) FROM milestone_tasks ORDER BY milestone_id,task_id",
        "SELECT json_array(id,kind,task_id,target_id,active,reason,evidence_json) FROM task_relations ORDER BY id",
        "SELECT json_array(task_id,project_id,version,next_follow_up_date,snoozed_until) FROM task_follow_up_state ORDER BY task_id",
        "SELECT json_array(id,project_id,version) FROM governance_items ORDER BY id",
        "SELECT json_array(id,project_id,version) FROM change_requests ORDER BY id",
        "SELECT json_array(id,project_id,version) FROM deliverables ORDER BY id",
    ] {
        let mut statement = conn.prepare(sql)?;
        let values = statement.query_map([],|r|r.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
        output.push(json!(values));
    }
    Ok(hash(json!(output).to_string().as_bytes()))
}
fn store(conn: &Connection, a: &Value, fingerprint: &str) -> Result<()> {
    conn.execute("INSERT INTO proactive_actions(id,project_id,target_kind,target_id,status,priority,version,next_check_at,source_hash,data_json) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,priority=excluded.priority,version=excluded.version,next_check_at=excluded.next_check_at,source_hash=excluded.source_hash,data_json=excluded.data_json",params![a["id"].as_str(),a["projectId"].as_str(),a["targetKind"].as_str(),a["targetId"].as_str(),a["status"].as_str(),a["priority"].as_i64(),a["version"].as_i64(),a["nextCheckAt"].as_str(),fingerprint,a.to_string()])?;
    Ok(())
}
fn history(conn: &Connection, a: &Value, kind: &str, note: &str, at: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO proactive_history VALUES(?,?,?,?,?,?,?,?)",
        params![
            id(),
            a["id"].as_str(),
            a["projectId"].as_str(),
            kind,
            note,
            at,
            a["version"].as_i64(),
            a.to_string()
        ],
    )?;
    Ok(())
}
fn apply_candidate(a: &mut Value, c: &Candidate) {
    a["projectName"] = json!(c.name);
    a["title"] = json!(c.title);
    a["priority"] = json!(c.priority);
    a["reason"] = json!(c.reasons.join("；"));
    a["suggestedAction"] = json!(c.suggested);
    a["draft"] = json!(c.draft);
    a["evidence"] = json!(c.evidence);
}
fn is_due(value: &Value, at: &DateTime<FixedOffset>) -> bool {
    value
        .as_str()
        .and_then(|v| parse_stamp(v).ok())
        .is_none_or(|v| v <= *at)
}

// Caller owns the transaction; failures leave every action and audit row intact.
fn scan_at(
    conn: &Connection,
    project: Option<&str>,
    force: bool,
    at: &DateTime<FixedOffset>,
) -> Result<Value> {
    let policy = settings(conn)?;
    let timestamp = stamp(at);
    let (last, previous_hash): (Option<String>, Option<String>) = conn.query_row(
        "SELECT last_run_at,source_hash FROM proactive_settings WHERE id=1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    if policy["enabled"] != true {
        return Ok(json!({"scanned":false,"changed":0,"ready":0,"lastRunAt":last}));
    }
    let fingerprint = source_fingerprint(conn, &at.format("%Y-%m-%d").to_string())?;
    let due: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM proactive_actions WHERE status IN ('ready','watching','snoozed') AND (next_check_at IS NULL OR next_check_at<=?))",[&timestamp],|r|r.get(0))?;
    if !force && previous_hash.as_deref() == Some(&fingerprint) && !due {
        return Ok(json!({"scanned":false,"changed":0,"ready":0,"lastRunAt":last}));
    }
    let candidates = candidates(conn, project, at)?;
    let all = read_actions(conn, project)?;
    let mut existing: HashMap<String, Value> = all
        .into_iter()
        .map(|a| {
            (
                candidate_key(
                    a["projectId"].as_str().unwrap(),
                    a["targetKind"].as_str().unwrap(),
                    a["targetId"].as_str().unwrap(),
                ),
                a,
            )
        })
        .collect();
    let next = stamp(&(*at + Duration::minutes(policy["reviewMinutes"].as_i64().unwrap())));
    let mut changed = 0;
    for (key, c) in candidates {
        let source = c.fingerprint();
        if let Some(mut a) = existing.remove(&key) {
            let old_hash: String = conn.query_row(
                "SELECT source_hash FROM proactive_actions WHERE id=?",
                [a["id"].as_str()],
                |r| r.get(0),
            )?;
            let material = old_hash != source;
            let status = a["status"].as_str().unwrap().to_owned();
            let due = is_due(&a["nextCheckAt"], at);
            // Dismissal remains respected while this same risk persists. When
            // cleared below it resolves, so a later recurrence can reopen it.
            if status == "dismissed" {
                continue;
            }
            let held = c
                .hold
                .as_deref()
                .is_some_and(|until| parse_stamp(until).is_ok_and(|until| until > *at));
            let manual_snooze = status == "snoozed" && !due && a["outcome"] == "用户暂缓";
            if !force && !material && !due {
                continue;
            }
            let watching_wait = status == "watching" && !due && !material;
            let new_status = if held || manual_snooze {
                "snoozed"
            } else if watching_wait {
                "watching"
            } else {
                "ready"
            };
            let event = if status == "resolved" {
                Some(("reopened", "来源再次出现需要处理的风险"))
            } else if new_status != status {
                Some((
                    if held { "deferred" } else { "review_due" },
                    if held {
                        "遵守已记录的跟进约定，等待约定日期复查"
                    } else {
                        "已到复查时间或来源发生变化，请处理下一步"
                    },
                ))
            } else if material && !manual_snooze {
                Some(("source_changed", "跟进依据发生变化，已更新判断与草稿"))
            } else {
                None
            };
            apply_candidate(&mut a, &c);
            a["status"] = json!(new_status);
            // Quiet periodic checks update diagnostics, without changing the
            // attention/version identity that drives UI notifications.
            a["version"] = json!(a["version"].as_i64().unwrap() + i64::from(event.is_some()));
            a["reviewCount"] = json!(a["reviewCount"].as_i64().unwrap() + 1);
            a["unchangedChecks"] = json!(if material {
                0
            } else {
                a["unchangedChecks"].as_i64().unwrap() + 1
            });
            a["lastCheckedAt"] = json!(timestamp);
            a["updatedAt"] = json!(timestamp);
            a["nextCheckAt"] = if held {
                json!(c.hold)
            } else if manual_snooze || watching_wait {
                a["nextCheckAt"].clone()
            } else {
                json!(next)
            };
            if !manual_snooze && !watching_wait {
                a["outcome"] = json!(if held {
                    "等待已约定的跟进日期"
                } else {
                    ""
                });
            }
            store(conn, &a, &source)?;
            if let Some((kind, note)) = event {
                history(conn, &a, kind, note, &timestamp)?;
                changed += 1;
            }
        } else {
            let held = c.hold.is_some();
            let mut a = json!({"id":id(),"projectId":c.project,"projectName":c.name,"targetKind":c.kind,"targetId":c.target,"title":c.title,"status":if held {"snoozed"} else {"ready"},"priority":c.priority,"reason":"","suggestedAction":"","draft":"","evidence":[],"version":1,"createdAt":timestamp,"updatedAt":timestamp,"lastCheckedAt":timestamp,"nextCheckAt":c.hold.as_ref().unwrap_or(&next),"reviewCount":1,"unchangedChecks":0,"outcome":if held {"等待已约定的跟进日期"} else {""}});
            apply_candidate(&mut a, &c);
            store(conn, &a, &source)?;
            history(
                conn,
                &a,
                "created",
                if held {
                    "识别到风险；遵守已记录的跟进日期，暂缓提醒"
                } else {
                    "主动巡检识别到需要推进的事项，已准备依据和草稿"
                },
                &timestamp,
            )?;
            changed += 1;
        }
    }
    // Terminal task states, closed management records, deleted targets, and
    // cleared conditions all disappear from the current candidate set.
    for mut a in existing.into_values() {
        if a["status"] == "resolved" {
            continue;
        }
        a["status"] = json!("resolved");
        a["nextCheckAt"] = Value::Null;
        a["outcome"] = json!(resolution_note(conn, &a)?);
        a["lastCheckedAt"] = json!(timestamp);
        a["updatedAt"] = json!(timestamp);
        a["version"] = json!(a["version"].as_i64().unwrap() + 1);
        a["reviewCount"] = json!(a["reviewCount"].as_i64().unwrap() + 1);
        let source: String = conn.query_row(
            "SELECT source_hash FROM proactive_actions WHERE id=?",
            [a["id"].as_str()],
            |r| r.get(0),
        )?;
        store(conn, &a, &source)?;
        history(
            conn,
            &a,
            "resolved",
            "已核对当前来源，事项自动收束",
            &timestamp,
        )?;
        changed += 1;
    }
    conn.execute(
        "UPDATE proactive_settings SET last_run_at=?,last_error=NULL,source_hash=? WHERE id=1",
        params![
            timestamp,
            if project.is_none() {
                Some(fingerprint)
            } else {
                None
            }
        ],
    )?;
    let ready:i64=conn.query_row("SELECT count(*) FROM proactive_actions WHERE status='ready' AND (?1 IS NULL OR project_id=?1)",[project],|r|r.get(0))?;
    Ok(json!({"scanned":true,"changed":changed,"ready":ready,"lastRunAt":timestamp}))
}

fn save_settings(conn: &Connection, p: &Value, at: &DateTime<FixedOffset>) -> Result<Value> {
    let old = settings(conn)?;
    if p["baseRevision"] != old["revision"] {
        return Err(conflict());
    }
    let enabled = p["enabled"]
        .as_bool()
        .ok_or_else(|| invalid("启用状态必须是布尔值"))?;
    let minutes = p["reviewMinutes"]
        .as_i64()
        .filter(|n| (5..=10080).contains(n))
        .ok_or_else(|| invalid("复查间隔必须为 5 到 10080 分钟"))?;
    conn.execute("UPDATE proactive_settings SET enabled=?,review_minutes=?,revision=?,source_hash=NULL WHERE id=1",params![enabled,minutes,id()])?;
    if enabled {
        scan_at(conn, None, true, at)?;
    }
    settings(conn)
}
fn update_action(conn: &Connection, p: &Value, at: &DateTime<FixedOffset>) -> Result<Value> {
    let key = required(p, "actionId")?;
    let mut a = conn
        .query_row(
            "SELECT data_json FROM proactive_actions WHERE id=?",
            [key],
            |r| decode(r.get(0)?),
        )
        .optional()?
        .ok_or_else(|| AppError::new("NOT_FOUND", "主动跟进事项不存在"))?;
    let base = p["baseVersion"]
        .as_i64()
        .filter(|v| *v > 0)
        .ok_or_else(|| invalid("请提供有效事项版本"))?;
    if a["version"].as_i64() != Some(base) {
        return Err(conflict());
    }
    let operation = required(p, "operation")?;
    let note = match p.get("note") {
        None | Some(Value::Null) => "",
        Some(Value::String(s)) => s.trim(),
        _ => return Err(invalid("处理说明必须为文字")),
    };
    if note.chars().count() > 10000 {
        return Err(invalid("处理说明过长"));
    }
    let active = matches!(a["status"].as_str(), Some("ready" | "watching" | "snoozed"));
    let (status, next, outcome) = match operation {
        "watch" | "snooze" => {
            if !active {
                return Err(invalid("请先重新打开已收束或忽略的事项"));
            }
            if note.is_empty() {
                return Err(invalid("请记录本次行动或暂缓原因"));
            }
            let next = parse_stamp(required(p, "nextCheckAt")?)?;
            if next <= *at || next > *at + Duration::days(366) {
                return Err(invalid("复查时间必须晚于现在，且在一年以内"));
            }
            (
                if operation == "watch" {
                    "watching"
                } else {
                    "snoozed"
                },
                Some(stamp(&next)),
                if operation == "watch" {
                    note.to_owned()
                } else {
                    "用户暂缓".into()
                },
            )
        }
        "dismiss" => {
            if !active {
                return Err(invalid("事项已收束或忽略"));
            }
            ("dismissed", None, note.to_owned())
        }
        "reopen" => {
            if active {
                return Err(invalid("事项已在跟进中"));
            }
            ("ready", Some(stamp(at)), note.to_owned())
        }
        _ => return Err(invalid("主动跟进操作无效")),
    };
    a["status"] = json!(status);
    a["nextCheckAt"] = json!(next);
    a["outcome"] = json!(outcome);
    a["version"] = json!(base + 1);
    a["updatedAt"] = json!(stamp(at));
    let source: String = conn.query_row(
        "SELECT source_hash FROM proactive_actions WHERE id=?",
        [key],
        |r| r.get(0),
    )?;
    store(conn, &a, &source)?;
    history(conn, &a, operation, note, &stamp(at))?;
    Ok(a)
}

pub(crate) fn dispatch(conn: &mut Connection, command: &str, p: &Value) -> Result<Value> {
    // Public callers cannot supply a clock or override a paused policy.
    let at = Local::now().fixed_offset();
    if command == "get_proactive_center" {
        let project = scope(conn, p)?;
        return center(conn, project.as_deref());
    }
    let result = (|| -> Result<Value> {
        let tx = conn.transaction()?;
        let value = match command {
            "run_proactive_scan" => {
                let project = scope(&tx, p)?;
                scan_at(&tx, project.as_deref(), true, &at)?;
                center(&tx, project.as_deref())?
            }
            "_proactive_tick" => scan_at(&tx, None, false, &at)?,
            "save_proactive_settings" => save_settings(&tx, p, &at)?,
            "update_proactive_action" => update_action(&tx, p, &at)?,
            _ => return Err(AppError::new("UNKNOWN_COMMAND", "未知主动跟进命令")),
        };
        tx.commit()?;
        Ok(value)
    })();
    if matches!(
        command,
        "run_proactive_scan" | "_proactive_tick" | "save_proactive_settings"
    ) {
        if let Err(error) = &result {
            let _ = conn.execute(
                "UPDATE proactive_settings SET last_error=? WHERE id=1",
                [format!("{}：{}", error.code, error.message)],
            );
        }
    }
    result
}

pub(crate) fn pause_after_restore(conn: &Connection) -> Result<()> {
    conn.execute("UPDATE proactive_settings SET enabled=0,revision=?,source_hash=NULL,last_error=NULL WHERE id=1",[id()])?;
    Ok(())
}

fn validate_action(conn: &Connection, a: &Value) -> Result<()> {
    let object = a.as_object().ok_or_else(|| invalid("行动必须是对象"))?;
    let fields = [
        "id",
        "projectId",
        "projectName",
        "targetKind",
        "targetId",
        "title",
        "status",
        "priority",
        "reason",
        "suggestedAction",
        "draft",
        "evidence",
        "version",
        "createdAt",
        "updatedAt",
        "lastCheckedAt",
        "nextCheckAt",
        "reviewCount",
        "unchangedChecks",
        "outcome",
    ];
    if object.len() != fields.len() || fields.iter().any(|key| !object.contains_key(*key)) {
        return Err(invalid("行动字段不完整或含未知字段"));
    }
    for (key, limit, nonempty) in [
        ("id", 100, true),
        ("projectId", 100, true),
        ("projectName", 300, false),
        ("targetId", 100, true),
        ("title", 300, true),
        ("reason", 30000, true),
        ("suggestedAction", 30000, true),
        ("draft", 60000, true),
        ("outcome", 10000, false),
    ] {
        let s = a[key]
            .as_str()
            .ok_or_else(|| invalid("行动文字字段类型无效"))?;
        if s.chars().count() > limit || (nonempty && s.trim().is_empty()) {
            return Err(invalid("行动文字字段无效"));
        }
    }
    let kind = required(a, "targetKind")?;
    let table = match kind {
        "task" => "tasks",
        "governance" => "governance_items",
        "change" => "change_requests",
        "deliverable" => "deliverables",
        "milestone" => "milestones",
        "project" => "projects",
        _ => return Err(invalid("行动目标类型无效")),
    };
    let project = required(a, "projectId")?;
    if !conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM projects WHERE id=?)",
        [project],
        |r| r.get::<_, bool>(0),
    )? {
        return Err(invalid("行动项目不存在"));
    }
    let sql = if kind == "project" {
        "SELECT id FROM projects WHERE id=?".to_owned()
    } else {
        format!("SELECT project_id FROM {table} WHERE id=?")
    };
    let target_project: Option<String> = conn
        .query_row(&sql, [required(a, "targetId")?], |r| r.get(0))
        .optional()?;
    if target_project.as_deref().is_some_and(|p| p != project) {
        return Err(invalid("行动目标跨项目"));
    }
    // Removing a change/deliverable draft preserves its cancelled source row,
    // so every retained action must still identify an actual same-project target.
    if target_project.is_none() {
        return Err(invalid("行动目标不存在"));
    }
    let status = required(a, "status")?;
    if !matches!(
        status,
        "ready" | "watching" | "snoozed" | "resolved" | "dismissed"
    ) {
        return Err(invalid("行动状态无效"));
    }
    if !a["priority"]
        .as_i64()
        .is_some_and(|n| (0..=100).contains(&n))
    {
        return Err(invalid("行动优先级无效"));
    }
    let positive = |key: &str| -> Result<i64> {
        a[key]
            .as_i64()
            .filter(|n| *n > 0)
            .ok_or_else(|| invalid("行动版本或复查计数无效"))
    };
    positive("version")?;
    let checks = positive("reviewCount")?;
    if !a["unchangedChecks"]
        .as_i64()
        .is_some_and(|n| n >= 0 && n <= checks)
    {
        return Err(invalid("连续未变化计数无效"));
    }
    let created = parse_stamp(required(a, "createdAt")?)?;
    let updated = parse_stamp(required(a, "updatedAt")?)?;
    let checked = parse_stamp(required(a, "lastCheckedAt")?)?;
    if updated < created || checked < created || checked > updated {
        return Err(invalid("行动审计时间逆序"));
    }
    if matches!(status, "ready" | "watching" | "snoozed") {
        parse_stamp(required(a, "nextCheckAt")?)?;
    } else if !a["nextCheckAt"].is_null() {
        return Err(invalid("收束行动不能继续安排复查"));
    }
    let evidence = a["evidence"]
        .as_array()
        .filter(|e| !e.is_empty() && e.len() <= 1000)
        .ok_or_else(|| invalid("行动依据无效"))?;
    for e in evidence {
        if e["targetKind"] != a["targetKind"] || e["targetId"] != a["targetId"] {
            return Err(invalid("行动依据目标不一致"));
        }
        for key in ["label", "detail"] {
            if required(e, key)?.is_empty() || required(e, key)?.chars().count() > 30000 {
                return Err(invalid("行动依据文字无效"));
            }
        }
    }
    Ok(())
}

fn validate_rows(conn: &Connection) -> Result<()> {
    // An archive can substitute its own table declarations. Compare the actual
    // schema, not just today's rows, before trusting UPSERT and identity rules.
    let expected = Connection::open_in_memory()?;
    migrate(&expected)?;
    for name in [
        "proactive_settings",
        "proactive_actions",
        "proactive_history",
        "proactive_due",
        "proactive_project",
        "proactive_audit",
    ] {
        let schema = |db: &Connection| -> Result<String> {
            Ok(db
                .query_row("SELECT sql FROM sqlite_master WHERE name=?", [name], |r| {
                    r.get::<_, String>(0)
                })?
                .split_whitespace()
                .collect::<String>())
        };
        if schema(conn)? != schema(&expected)? {
            return Err(invalid("主动跟进数据结构不匹配"));
        }
    }
    let setting_count: i64 =
        conn.query_row("SELECT count(*) FROM proactive_settings", [], |r| r.get(0))?;
    if setting_count != 1 {
        return Err(invalid("主动跟进设置缺失或重复"));
    }
    let (setting_id,enabled,minutes,revision,last,error,source):(i64,i64,i64,String,Option<String>,Option<String>,Option<String>)=conn.query_row("SELECT id,enabled,review_minutes,revision,last_run_at,last_error,source_hash FROM proactive_settings",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?)))?;
    let valid_hash = |s: &str| {
        s.len() == 64
            && s.bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    };
    if setting_id != 1
        || !matches!(enabled, 0 | 1)
        || !(5..=10080).contains(&minutes)
        || uuid::Uuid::parse_str(&revision).is_err()
        || source.as_deref().is_some_and(|s| !valid_hash(s))
        || error.as_deref().is_some_and(|s| s.len() > 10000)
    {
        return Err(invalid("主动跟进设置字段无效"));
    }
    if let Some(last) = last {
        parse_stamp(&last)?;
    }
    let mut statement=conn.prepare("SELECT id,project_id,target_kind,target_id,status,priority,version,next_check_at,source_hash,data_json FROM proactive_actions")?;
    let mut rows = statement.query([])?;
    let mut actions = HashMap::new();
    let mut identities = HashSet::new();
    while let Some(row) = rows.next()? {
        let a: Value =
            serde_json::from_str(&row.get::<_, String>(9)?).map_err(|_| invalid("行动JSON无效"))?;
        validate_action(conn, &a)?;
        for (i, key) in [
            (0, "id"),
            (1, "projectId"),
            (2, "targetKind"),
            (3, "targetId"),
            (4, "status"),
        ] {
            if row.get::<_, String>(i)? != required(&a, key)? {
                return Err(invalid("行动索引与内容不一致"));
            }
        }
        for (i, key) in [(5, "priority"), (6, "version")] {
            if Some(row.get::<_, i64>(i)?) != a[key].as_i64() {
                return Err(invalid("行动版本或优先级索引不一致"));
            }
        }
        if row.get::<_, Option<String>>(7)?.as_deref() != a["nextCheckAt"].as_str()
            || !valid_hash(&row.get::<_, String>(8)?)
        {
            return Err(invalid("行动复查索引或来源指纹无效"));
        }
        if !identities.insert(candidate_key(
            required(&a, "projectId")?,
            required(&a, "targetKind")?,
            required(&a, "targetId")?,
        )) || actions.insert(required(&a, "id")?.to_owned(), a).is_some()
        {
            return Err(invalid("行动标识重复"));
        }
    }
    drop(rows);
    drop(statement);
    let mut statement=conn.prepare("SELECT id,action_id,project_id,kind,note,created_at,version,snapshot_json FROM proactive_history ORDER BY action_id,version")?;
    let mut rows = statement.query([])?;
    let mut ids = HashSet::new();
    let mut latest: HashMap<String, (i64, String, Value)> = HashMap::new();
    while let Some(row) = rows.next()? {
        let (key, action, project, kind, note, at, version, raw): (
            String,
            String,
            String,
            String,
            String,
            String,
            i64,
            String,
        ) = (
            row.get(0)?,
            row.get(1)?,
            row.get(2)?,
            row.get(3)?,
            row.get(4)?,
            row.get(5)?,
            row.get(6)?,
            row.get(7)?,
        );
        if !ids.insert(key)
            || note.chars().count() > 10000
            || !matches!(
                kind.as_str(),
                "created"
                    | "watch"
                    | "snooze"
                    | "dismiss"
                    | "reopen"
                    | "source_changed"
                    | "reopened"
                    | "review_due"
                    | "deferred"
                    | "resolved"
            )
        {
            return Err(invalid("行动历史标识或操作无效"));
        }
        let snapshot: Value =
            serde_json::from_str(&raw).map_err(|_| invalid("行动历史JSON无效"))?;
        validate_action(conn, &snapshot)?;
        let current = actions
            .get(&action)
            .ok_or_else(|| invalid("行动历史来源不存在"))?;
        if snapshot["id"] != action
            || snapshot["projectId"] != project
            || snapshot["targetKind"] != current["targetKind"]
            || snapshot["targetId"] != current["targetId"]
            || snapshot["projectId"] != current["projectId"]
            || snapshot["version"].as_i64() != Some(version)
            || version > current["version"].as_i64().unwrap()
            || snapshot["updatedAt"] != at
        {
            return Err(invalid("行动历史范围、版本或时间不一致"));
        }
        parse_stamp(&at)?;
        let expected_status = match kind.as_str() {
            "watch" => Some("watching"),
            "snooze" | "deferred" => Some("snoozed"),
            "dismiss" => Some("dismissed"),
            "reopen" | "review_due" => Some("ready"),
            "resolved" => Some("resolved"),
            _ => None,
        };
        if expected_status.is_some_and(|s| snapshot["status"] != s)
            || matches!(kind.as_str(), "created" | "reopened")
                && !matches!(snapshot["status"].as_str(), Some("ready" | "snoozed"))
            || matches!(kind.as_str(), "watch" | "snooze") && note.trim().is_empty()
        {
            return Err(invalid("行动历史操作与状态不一致"));
        }
        if let Some((previous, previous_at, _)) = latest.get(&action) {
            if kind == "created"
                || version != *previous + 1
                || parse_stamp(&at)? < parse_stamp(previous_at)?
            {
                return Err(invalid("行动历史版本或时间逆序"));
            }
        } else if kind != "created" || version != 1 || snapshot["createdAt"] != at {
            return Err(invalid("行动缺少初始识别历史"));
        }
        latest.insert(action, (version, at, snapshot));
    }
    for (key, current) in actions {
        let (_, _, last) = latest.get(&key).ok_or_else(|| invalid("行动缺少历史"))?;
        if last["status"] != current["status"]
            || last["createdAt"] != current["createdAt"]
            || last["version"] != current["version"]
        {
            return Err(invalid("行动当前状态与历史不一致"));
        }
    }
    Ok(())
}

pub(crate) fn validate_backup(conn: &Connection) -> Result<()> {
    validate_rows(conn)
        .map_err(|e| AppError::new("INVALID_BACKUP", format!("主动跟进记录无效：{}", e.message)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{db::Database, Request};

    fn at(value: &str) -> DateTime<FixedOffset> {
        parse_stamp(value).unwrap()
    }
    fn call(db: &mut Database, command: &str, payload: Value) -> Value {
        db.execute(Request {
            command: command.into(),
            payload,
        })
        .unwrap()
    }
    fn project(db: &mut Database) -> Value {
        call(db, "create_project", json!({"name":"持续托管"}))
    }
    fn task(
        db: &mut Database,
        p: &Value,
        title: &str,
        status: &str,
        due: Option<&str>,
        priority: &str,
    ) -> Value {
        call(
            db,
            "create_task",
            json!({"projectId":p["id"],"title":title,"description":"接口交付","category":"action","assignee":"小周","priority":priority,"status":status,"progress":0,"dueDate":due,"plannedDate":null,"workDate":"2026-10-16","clientRequestId":id()}),
        )
    }
    fn change_task(db: &mut Database, t: &Value, status: &str) -> Value {
        let mut p = t.clone();
        p["taskId"] = t["id"].clone();
        p["baseVersion"] = t["version"].clone();
        p["status"] = json!(status);
        p["progress"] = json!(if status == "done" { 100 } else { 0 });
        p["workDate"] = json!("2026-10-19");
        p["note"] = json!("核对实际交付状态");
        p["clientRequestId"] = json!(id());
        call(db, "update_task", p)
    }
    fn scan(db: &mut Database, time: &DateTime<FixedOffset>, force: bool) -> Value {
        let tx = db.conn.transaction().unwrap();
        let r = scan_at(&tx, None, force, time).unwrap();
        tx.commit().unwrap();
        r
    }
    fn actions(db: &Database) -> Vec<Value> {
        read_actions(&db.conn, None).unwrap()
    }
    fn update(
        db: &mut Database,
        a: &Value,
        operation: &str,
        next: Option<&str>,
        time: &DateTime<FixedOffset>,
    ) -> Value {
        let tx = db.conn.transaction().unwrap();
        let v=update_action(&tx,&json!({"actionId":a["id"],"baseVersion":a["version"],"operation":operation,"note":"已准备处理材料，按约定复查","nextCheckAt":next}),time).unwrap();
        tx.commit().unwrap();
        v
    }

    #[test]
    fn quiet_reviews_preserve_attention_identity_and_future_watch_even_on_manual_scan() {
        let dir = tempfile::tempdir().unwrap();
        let mut db = Database::open(dir.path().into()).unwrap();
        let p = project(&mut db);
        task(
            &mut db,
            &p,
            "接口逾期",
            "in_progress",
            Some("2026-10-18"),
            "high",
        );
        let start = at("2026-10-19T10:00:00+08:00");
        assert_eq!(scan(&mut db, &start, false)["changed"], 1);
        let first = actions(&db)[0].clone();
        assert_eq!(
            scan(&mut db, &(start + Duration::minutes(5)), false)["scanned"],
            false
        );
        assert_eq!(
            scan(&mut db, &(start + Duration::minutes(61)), false)["changed"],
            0
        );
        let reviewed = actions(&db)[0].clone();
        assert_eq!(reviewed["version"], first["version"]);
        assert_eq!(reviewed["reviewCount"], 2);
        assert_eq!(reviewed["unchangedChecks"], 1);
        assert_eq!(
            center(&db.conn, None).unwrap()["history"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        let watching = update(
            &mut db,
            &reviewed,
            "watch",
            Some("2026-10-19T16:00:00+08:00"),
            &(start + Duration::minutes(62)),
        );
        scan(&mut db, &(start + Duration::minutes(63)), true);
        assert_eq!(actions(&db)[0]["status"], "watching");
        assert_eq!(actions(&db)[0]["nextCheckAt"], watching["nextCheckAt"]);
        // Another task changes the workspace fingerprint, but not this source.
        task(&mut db, &p, "尚未承诺日期的任务", "todo", None, "low");
        scan(&mut db, &(start + Duration::minutes(64)), false);
        assert_eq!(actions(&db)[0]["status"], "watching");
        scan(&mut db, &at("2026-10-19T16:01:00+08:00"), false);
        let ready = actions(&db)[0].clone();
        assert_eq!(ready["status"], "ready");
        assert!(ready["version"].as_i64() > watching["version"].as_i64());
        validate_backup(&db.conn).unwrap();
    }

    #[test]
    fn changed_sources_reopen_watch_but_snooze_respects_date_and_terminal_sources_close() {
        let dir = tempfile::tempdir().unwrap();
        let mut db = Database::open(dir.path().into()).unwrap();
        let p = project(&mut db);
        let t = task(&mut db, &p, "联调阻塞", "blocked", None, "high");
        let start = at("2026-10-19T10:00:00+08:00");
        scan(&mut db, &start, false);
        let first = actions(&db)[0].clone();
        update(
            &mut db,
            &first,
            "watch",
            Some("2026-10-19T16:00:00+08:00"),
            &(start + Duration::minutes(1)),
        );
        let t = change_task(&mut db, &t, "in_progress");
        // Moving from blocked to in_progress still has the 3-day stale risk.
        scan(&mut db, &(start + Duration::minutes(2)), false);
        assert_eq!(actions(&db)[0]["status"], "resolved");
        let t = change_task(&mut db, &t, "blocked");
        scan(&mut db, &(start + Duration::minutes(3)), false);
        let ready = actions(&db)[0].clone();
        assert_eq!(ready["id"], first["id"]);
        assert_eq!(ready["status"], "ready");
        update(
            &mut db,
            &ready,
            "snooze",
            Some("2026-10-19T18:00:00+08:00"),
            &(start + Duration::minutes(4)),
        );
        let t = change_task(&mut db, &t, "blocked");
        scan(&mut db, &(start + Duration::minutes(5)), false);
        assert_eq!(actions(&db)[0]["status"], "snoozed");
        let t = change_task(&mut db, &t, "done");
        scan(&mut db, &(start + Duration::minutes(6)), false);
        assert_eq!(actions(&db)[0]["status"], "resolved");
        assert!(actions(&db)[0]["outcome"]
            .as_str()
            .unwrap()
            .contains("任务已标记完成"));
        let t = change_task(&mut db, &t, "blocked");
        scan(&mut db, &(start + Duration::minutes(7)), false);
        let ready = actions(&db)[0].clone();
        update(
            &mut db,
            &ready,
            "dismiss",
            None,
            &(start + Duration::minutes(8)),
        );
        scan(&mut db, &(start + Duration::hours(1)), true);
        assert_eq!(actions(&db)[0]["status"], "dismissed");
        let t = change_task(&mut db, &t, "cancelled");
        scan(&mut db, &(start + Duration::minutes(61)), false);
        assert_eq!(actions(&db)[0]["status"], "resolved");
        change_task(&mut db, &t, "blocked");
        scan(&mut db, &(start + Duration::minutes(62)), false);
        assert_eq!(actions(&db)[0]["status"], "ready");
        validate_backup(&db.conn).unwrap();
        let before = center(&db.conn, None).unwrap();
        let result=dispatch(&mut db.conn,"update_proactive_action",&json!({"actionId":first["id"],"baseVersion":1,"operation":"dismiss","note":"陈旧写入"})).unwrap_err();
        assert_eq!(result.code, "VERSION_CONFLICT");
        assert_eq!(center(&db.conn, None).unwrap(), before);
    }

    #[test]
    fn follow_up_agreements_and_paused_project_suppress_reminders_then_resume() {
        let dir = tempfile::tempdir().unwrap();
        let mut db = Database::open(dir.path().into()).unwrap();
        let p = project(&mut db);
        let t = task(
            &mut db,
            &p,
            "约定周四跟进",
            "blocked",
            Some("2026-10-18"),
            "medium",
        );
        call(
            &mut db,
            "record_follow_up",
            json!({"taskId":t["id"],"baseVersion":0,"workDate":"2026-10-19","note":"负责人承诺周四同步结果","nextFollowUpDate":"2026-10-22"}),
        );
        let start = at("2026-10-19T10:00:00+08:00");
        scan(&mut db, &start, false);
        assert_eq!(actions(&db)[0]["status"], "snoozed");
        assert_eq!(actions(&db)[0]["nextCheckAt"], "2026-10-21T16:00:00.000Z");
        let initial_version = actions(&db)[0]["version"].clone();
        scan(&mut db, &at("2026-10-21T10:00:00+08:00"), true);
        assert_eq!(actions(&db)[0]["status"], "snoozed");
        assert_eq!(actions(&db)[0]["version"], initial_version);
        scan(&mut db, &at("2026-10-22T00:01:00+08:00"), false);
        assert_eq!(actions(&db)[0]["status"], "ready");
        call(
            &mut db,
            "save_project_profile",
            json!({"projectId":p["id"],"baseVersion":0,"goal":"按期交付","status":"on_hold","targetDate":null}),
        );
        scan(&mut db, &at("2026-10-22T01:00:00+08:00"), false);
        assert_eq!(actions(&db)[0]["status"], "resolved");
        assert!(actions(&db)[0]["outcome"]
            .as_str()
            .unwrap()
            .contains("项目已暂停"));
        call(
            &mut db,
            "save_project_profile",
            json!({"projectId":p["id"],"baseVersion":1,"goal":"按期交付","status":"active","targetDate":null}),
        );
        scan(&mut db, &at("2026-10-22T02:00:00+08:00"), false);
        assert_eq!(actions(&db)[0]["status"], "ready");
        validate_backup(&db.conn).unwrap();
    }

    #[test]
    fn sorting_no_duplicate_and_backup_validation_rejects_forged_scope_state_and_schema() {
        let dir = tempfile::tempdir().unwrap();
        let mut db = Database::open(dir.path().into()).unwrap();
        let p = project(&mut db);
        let urgent = task(
            &mut db,
            &p,
            "高优先级阻塞",
            "blocked",
            Some("2026-10-18"),
            "high",
        );
        task(&mut db, &p, "低优先级阻塞", "blocked", None, "low");
        task(&mut db, &p, "长期未更新", "in_progress", None, "medium");
        task(&mut db, &p, "等待开始且无承诺日期", "todo", None, "high");
        let start = at("2026-10-19T10:00:00+08:00");
        scan(&mut db, &start, false);
        let all = actions(&db);
        assert_eq!(all.len(), 3);
        assert_eq!(all[0]["targetId"], urgent["id"]);
        assert!(all[0]["evidence"].as_array().unwrap().len() >= 2);
        assert!(all[0]["evidence"][0]["detail"]
            .as_str()
            .unwrap()
            .contains("负责人：小周"));
        scan(&mut db, &start, true);
        assert_eq!(actions(&db).len(), 3);
        validate_backup(&db.conn).unwrap();
        let mut forged = all[0].clone();
        forged["status"] = json!("sent");
        db.conn
            .execute(
                "UPDATE proactive_actions SET data_json=? WHERE id=?",
                params![forged.to_string(), forged["id"].as_str()],
            )
            .unwrap();
        assert_eq!(
            validate_backup(&db.conn).unwrap_err().code,
            "INVALID_BACKUP"
        );
        store(&db.conn, &all[0], &"0".repeat(64)).unwrap();
        let other = project(&mut db);
        forged = all[0].clone();
        forged["projectId"] = other["id"].clone();
        db.conn
            .execute(
                "UPDATE proactive_actions SET project_id=?,data_json=? WHERE id=?",
                params![
                    other["id"].as_str(),
                    forged.to_string(),
                    forged["id"].as_str()
                ],
            )
            .unwrap();
        assert_eq!(
            validate_backup(&db.conn).unwrap_err().code,
            "INVALID_BACKUP"
        );
        db.conn
            .execute(
                "UPDATE proactive_actions SET project_id=?,data_json=? WHERE id=?",
                params![
                    all[0]["projectId"].as_str(),
                    all[0].to_string(),
                    all[0]["id"].as_str()
                ],
            )
            .unwrap();
        validate_backup(&db.conn).unwrap();
        db.conn
            .execute_batch(
                "DROP INDEX proactive_due;CREATE INDEX proactive_due ON proactive_actions(status);",
            )
            .unwrap();
        assert_eq!(
            validate_backup(&db.conn).unwrap_err().code,
            "INVALID_BACKUP"
        );
    }

    #[test]
    fn failed_scan_rolls_back_every_action_and_records_error() {
        let dir = tempfile::tempdir().unwrap();
        let mut db = Database::open(dir.path().into()).unwrap();
        let p = project(&mut db);
        task(&mut db, &p, "阻塞事项", "blocked", None, "high");
        scan(&mut db, &at("2026-10-19T10:00:00+08:00"), false);
        let before = actions(&db);
        let history_count: i64 = db
            .conn
            .query_row("SELECT count(*) FROM proactive_history", [], |r| r.get(0))
            .unwrap();
        db.conn.execute_batch("CREATE TRIGGER fail_patrol BEFORE UPDATE ON proactive_settings WHEN new.last_run_at<>old.last_run_at BEGIN SELECT RAISE(ABORT,'fixture fault'); END;").unwrap();
        assert!(dispatch(&mut db.conn, "run_proactive_scan", &json!({})).is_err());
        assert_eq!(actions(&db), before);
        assert_eq!(
            db.conn
                .query_row("SELECT count(*) FROM proactive_history", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            history_count
        );
        assert!(center(&db.conn, None).unwrap()["lastError"]
            .as_str()
            .unwrap()
            .contains("fixture fault"));
    }
}
