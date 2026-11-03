//! Durable, local project work. Events are written by SQLite triggers in the
//! business transaction; decisions and their business effects commit together.
//! This first execution policy has no network or model tools.
use crate::{hash, id, now, required, tasks, AppError, Result};
use chrono::{DateTime, Duration, FixedOffset, Local, SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

const EVENT_LIMIT: i64 = 64;
const DUE_LIMIT: i64 = 32;

fn invalid(message: &str) -> AppError {
    AppError::new("VALIDATION", message)
}
fn conflict() -> AppError {
    AppError::new("VERSION_CONFLICT", "依据或行动已变化，请刷新方案后重新选择")
}
fn decode(raw: String) -> rusqlite::Result<Value> {
    serde_json::from_str(&raw).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })
}
fn stamp(at: &DateTime<FixedOffset>) -> String {
    at.with_timezone(&Utc)
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}
fn rows(conn: &Connection, sql: &str, args: &[&dyn rusqlite::ToSql]) -> Result<Vec<Value>> {
    let mut s = conn.prepare(sql)?;
    let values = s
        .query_map(args, |r| decode(r.get(0)?))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(values)
}

pub(crate) fn migrate(conn: &Connection) -> Result<()> {
    // Trigger inserts explicitly exclude pending entities. An outer business
    // UPSERT can override a trigger's INSERT OR IGNORE conflict policy, so queue
    // deduplication must avoid the unique conflict before attempting insertion.
    conn.execute_batch(r#"
CREATE TABLE IF NOT EXISTS assistant_work_settings(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL CHECK(enabled IN(0,1)),version INTEGER NOT NULL CHECK(version>0),last_day TEXT);
INSERT OR IGNORE INTO assistant_work_settings VALUES(1,1,1,NULL);
CREATE TABLE IF NOT EXISTS assistant_events(id INTEGER PRIMARY KEY AUTOINCREMENT,project_id TEXT NOT NULL REFERENCES projects(id),entity_kind TEXT NOT NULL CHECK(entity_kind IN('task','review')),entity_id TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','done')),created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),processed_at TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS assistant_pending_entity ON assistant_events(entity_kind,entity_id) WHERE status='pending';
CREATE INDEX IF NOT EXISTS assistant_pending_events ON assistant_events(status,id);
CREATE TABLE IF NOT EXISTS assistant_work(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),kind TEXT NOT NULL CHECK(kind IN('delay','follow_up','memory_conflict')),target_id TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN('ready','watching','paused','resolved','cancelled')),version INTEGER NOT NULL CHECK(version>0),fingerprint TEXT NOT NULL,snapshot_json TEXT NOT NULL,proposal_json TEXT NOT NULL,next_check_at TEXT,updated_at TEXT NOT NULL,UNIQUE(kind,target_id));
CREATE INDEX IF NOT EXISTS assistant_work_due ON assistant_work(status,next_check_at);
CREATE TABLE IF NOT EXISTS assistant_work_runs(id TEXT PRIMARY KEY,work_id TEXT NOT NULL REFERENCES assistant_work(id),event_id INTEGER REFERENCES assistant_events(id),kind TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN('succeeded','waiting','cancelled')),snapshot_hash TEXT NOT NULL,result_json TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS assistant_decisions(id TEXT PRIMARY KEY,work_id TEXT NOT NULL REFERENCES assistant_work(id),payload_hash TEXT NOT NULL,response_json TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS assistant_work_history(id TEXT PRIMARY KEY,work_id TEXT NOT NULL REFERENCES assistant_work(id),kind TEXT NOT NULL,note TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS assistant_work_history_order ON assistant_work_history(work_id,created_at);
CREATE TRIGGER IF NOT EXISTS assistant_task_insert AFTER INSERT ON tasks BEGIN INSERT INTO assistant_events(project_id,entity_kind,entity_id) SELECT incoming.project_id,incoming.entity_kind,incoming.entity_id FROM (SELECT NEW.project_id AS project_id,'task' AS entity_kind,NEW.id AS entity_id) AS incoming WHERE NOT EXISTS(SELECT 1 FROM assistant_events e WHERE e.entity_kind=incoming.entity_kind AND e.entity_id=incoming.entity_id AND e.status='pending'); END;
CREATE TRIGGER IF NOT EXISTS assistant_task_update AFTER UPDATE ON tasks BEGIN INSERT INTO assistant_events(project_id,entity_kind,entity_id) SELECT incoming.project_id,incoming.entity_kind,incoming.entity_id FROM (SELECT NEW.project_id AS project_id,'task' AS entity_kind,NEW.id AS entity_id) AS incoming WHERE NOT EXISTS(SELECT 1 FROM assistant_events e WHERE e.entity_kind=incoming.entity_kind AND e.entity_id=incoming.entity_id AND e.status='pending'); END;
CREATE TRIGGER IF NOT EXISTS assistant_follow_insert AFTER INSERT ON task_follow_up_state BEGIN INSERT INTO assistant_events(project_id,entity_kind,entity_id) SELECT incoming.project_id,incoming.entity_kind,incoming.entity_id FROM (SELECT NEW.project_id AS project_id,'task' AS entity_kind,NEW.task_id AS entity_id) AS incoming WHERE NOT EXISTS(SELECT 1 FROM assistant_events e WHERE e.entity_kind=incoming.entity_kind AND e.entity_id=incoming.entity_id AND e.status='pending'); END;
CREATE TRIGGER IF NOT EXISTS assistant_follow_update AFTER UPDATE ON task_follow_up_state BEGIN INSERT INTO assistant_events(project_id,entity_kind,entity_id) SELECT incoming.project_id,incoming.entity_kind,incoming.entity_id FROM (SELECT NEW.project_id AS project_id,'task' AS entity_kind,NEW.task_id AS entity_id) AS incoming WHERE NOT EXISTS(SELECT 1 FROM assistant_events e WHERE e.entity_kind=incoming.entity_kind AND e.entity_id=incoming.entity_id AND e.status='pending'); END;
CREATE TRIGGER IF NOT EXISTS assistant_review_insert AFTER INSERT ON memory_reviews BEGIN INSERT INTO assistant_events(project_id,entity_kind,entity_id) SELECT incoming.project_id,incoming.entity_kind,incoming.entity_id FROM (SELECT project_id AS project_id,'review' AS entity_kind,NEW.id AS entity_id FROM proposals WHERE id=NEW.proposal_id) AS incoming WHERE NOT EXISTS(SELECT 1 FROM assistant_events e WHERE e.entity_kind=incoming.entity_kind AND e.entity_id=incoming.entity_id AND e.status='pending'); END;
CREATE TRIGGER IF NOT EXISTS assistant_review_update AFTER UPDATE ON memory_reviews BEGIN INSERT INTO assistant_events(project_id,entity_kind,entity_id) SELECT incoming.project_id,incoming.entity_kind,incoming.entity_id FROM (SELECT project_id AS project_id,'review' AS entity_kind,NEW.id AS entity_id FROM proposals WHERE id=NEW.proposal_id) AS incoming WHERE NOT EXISTS(SELECT 1 FROM assistant_events e WHERE e.entity_kind=incoming.entity_kind AND e.entity_id=incoming.entity_id AND e.status='pending'); END;
CREATE TRIGGER IF NOT EXISTS assistant_review_delete AFTER DELETE ON memory_reviews BEGIN INSERT INTO assistant_events(project_id,entity_kind,entity_id) SELECT incoming.project_id,incoming.entity_kind,incoming.entity_id FROM (SELECT project_id AS project_id,'review' AS entity_kind,OLD.id AS entity_id FROM proposals WHERE id=OLD.proposal_id) AS incoming WHERE NOT EXISTS(SELECT 1 FROM assistant_events e WHERE e.entity_kind=incoming.entity_kind AND e.entity_id=incoming.entity_id AND e.status='pending'); END;
CREATE TRIGGER IF NOT EXISTS assistant_proposal_update AFTER UPDATE ON proposals BEGIN INSERT INTO assistant_events(project_id,entity_kind,entity_id) SELECT incoming.project_id,incoming.entity_kind,incoming.entity_id FROM (SELECT NEW.project_id AS project_id,'review' AS entity_kind,id AS entity_id FROM memory_reviews WHERE proposal_id=NEW.id) AS incoming WHERE NOT EXISTS(SELECT 1 FROM assistant_events e WHERE e.entity_kind=incoming.entity_kind AND e.entity_id=incoming.entity_id AND e.status='pending'); END;
CREATE TRIGGER IF NOT EXISTS assistant_memory_update AFTER UPDATE ON memories BEGIN INSERT INTO assistant_events(project_id,entity_kind,entity_id) SELECT incoming.project_id,incoming.entity_kind,incoming.entity_id FROM (SELECT p.project_id AS project_id,'review' AS entity_kind,r.id AS entity_id FROM memory_reviews r JOIN proposals p ON p.id=r.proposal_id WHERE r.target_id=NEW.id) AS incoming WHERE NOT EXISTS(SELECT 1 FROM assistant_events e WHERE e.entity_kind=incoming.entity_kind AND e.entity_id=incoming.entity_id AND e.status='pending'); END;
CREATE TRIGGER IF NOT EXISTS assistant_source_update AFTER UPDATE ON sources BEGIN INSERT INTO assistant_events(project_id,entity_kind,entity_id) SELECT incoming.project_id,incoming.entity_kind,incoming.entity_id FROM (SELECT p.project_id AS project_id,'review' AS entity_kind,r.id AS entity_id FROM memory_reviews r JOIN proposals p ON p.id=r.proposal_id WHERE p.source_id=NEW.id) AS incoming WHERE NOT EXISTS(SELECT 1 FROM assistant_events e WHERE e.entity_kind=incoming.entity_kind AND e.entity_id=incoming.entity_id AND e.status='pending'); END;
CREATE TRIGGER IF NOT EXISTS assistant_milestone_update AFTER UPDATE ON milestones BEGIN INSERT INTO assistant_events(project_id,entity_kind,entity_id) SELECT incoming.project_id,incoming.entity_kind,incoming.entity_id FROM (SELECT NEW.project_id AS project_id,'task' AS entity_kind,task_id AS entity_id FROM milestone_tasks WHERE milestone_id=NEW.id) AS incoming WHERE NOT EXISTS(SELECT 1 FROM assistant_events e WHERE e.entity_kind=incoming.entity_kind AND e.entity_id=incoming.entity_id AND e.status='pending'); END;
CREATE TRIGGER IF NOT EXISTS assistant_milestone_link AFTER INSERT ON milestone_tasks BEGIN INSERT INTO assistant_events(project_id,entity_kind,entity_id) SELECT incoming.project_id,incoming.entity_kind,incoming.entity_id FROM (SELECT project_id AS project_id,'task' AS entity_kind,NEW.task_id AS entity_id FROM tasks WHERE id=NEW.task_id) AS incoming WHERE NOT EXISTS(SELECT 1 FROM assistant_events e WHERE e.entity_kind=incoming.entity_kind AND e.entity_id=incoming.entity_id AND e.status='pending'); END;
CREATE TRIGGER IF NOT EXISTS assistant_milestone_unlink AFTER DELETE ON milestone_tasks BEGIN INSERT INTO assistant_events(project_id,entity_kind,entity_id) SELECT incoming.project_id,incoming.entity_kind,incoming.entity_id FROM (SELECT project_id AS project_id,'task' AS entity_kind,OLD.task_id AS entity_id FROM tasks WHERE id=OLD.task_id) AS incoming WHERE NOT EXISTS(SELECT 1 FROM assistant_events e WHERE e.entity_kind=incoming.entity_kind AND e.entity_id=incoming.entity_id AND e.status='pending'); END;
CREATE TRIGGER IF NOT EXISTS assistant_profile_insert AFTER INSERT ON project_profiles BEGIN INSERT INTO assistant_events(project_id,entity_kind,entity_id) SELECT incoming.project_id,incoming.entity_kind,incoming.entity_id FROM (SELECT project_id AS project_id,'task' AS entity_kind,id AS entity_id FROM tasks WHERE project_id=NEW.project_id) AS incoming WHERE NOT EXISTS(SELECT 1 FROM assistant_events e WHERE e.entity_kind=incoming.entity_kind AND e.entity_id=incoming.entity_id AND e.status='pending'); INSERT INTO assistant_events(project_id,entity_kind,entity_id) SELECT incoming.project_id,incoming.entity_kind,incoming.entity_id FROM (SELECT p.project_id AS project_id,'review' AS entity_kind,r.id AS entity_id FROM memory_reviews r JOIN proposals p ON p.id=r.proposal_id WHERE p.project_id=NEW.project_id) AS incoming WHERE NOT EXISTS(SELECT 1 FROM assistant_events e WHERE e.entity_kind=incoming.entity_kind AND e.entity_id=incoming.entity_id AND e.status='pending'); END;
CREATE TRIGGER IF NOT EXISTS assistant_profile_update AFTER UPDATE ON project_profiles BEGIN INSERT INTO assistant_events(project_id,entity_kind,entity_id) SELECT incoming.project_id,incoming.entity_kind,incoming.entity_id FROM (SELECT project_id AS project_id,'task' AS entity_kind,id AS entity_id FROM tasks WHERE project_id=NEW.project_id) AS incoming WHERE NOT EXISTS(SELECT 1 FROM assistant_events e WHERE e.entity_kind=incoming.entity_kind AND e.entity_id=incoming.entity_id AND e.status='pending'); INSERT INTO assistant_events(project_id,entity_kind,entity_id) SELECT incoming.project_id,incoming.entity_kind,incoming.entity_id FROM (SELECT p.project_id AS project_id,'review' AS entity_kind,r.id AS entity_id FROM memory_reviews r JOIN proposals p ON p.id=r.proposal_id WHERE p.project_id=NEW.project_id) AS incoming WHERE NOT EXISTS(SELECT 1 FROM assistant_events e WHERE e.entity_kind=incoming.entity_kind AND e.entity_id=incoming.entity_id AND e.status='pending'); END;
CREATE TRIGGER IF NOT EXISTS assistant_lifecycle_insert AFTER INSERT ON workspace_lifecycle BEGIN INSERT INTO assistant_events(project_id,entity_kind,entity_id) SELECT incoming.project_id,incoming.entity_kind,incoming.entity_id FROM (SELECT project_id AS project_id,'task' AS entity_kind,id AS entity_id FROM tasks WHERE NEW.kind='project' AND project_id=NEW.entity_id) AS incoming WHERE NOT EXISTS(SELECT 1 FROM assistant_events e WHERE e.entity_kind=incoming.entity_kind AND e.entity_id=incoming.entity_id AND e.status='pending'); INSERT INTO assistant_events(project_id,entity_kind,entity_id) SELECT incoming.project_id,incoming.entity_kind,incoming.entity_id FROM (SELECT p.project_id AS project_id,'review' AS entity_kind,r.id AS entity_id FROM memory_reviews r JOIN proposals p ON p.id=r.proposal_id WHERE (NEW.kind='project' AND p.project_id=NEW.entity_id) OR (NEW.kind='source' AND p.source_id=NEW.entity_id)) AS incoming WHERE NOT EXISTS(SELECT 1 FROM assistant_events e WHERE e.entity_kind=incoming.entity_kind AND e.entity_id=incoming.entity_id AND e.status='pending'); END;
CREATE TRIGGER IF NOT EXISTS assistant_lifecycle_update AFTER UPDATE ON workspace_lifecycle BEGIN INSERT INTO assistant_events(project_id,entity_kind,entity_id) SELECT incoming.project_id,incoming.entity_kind,incoming.entity_id FROM (SELECT project_id AS project_id,'task' AS entity_kind,id AS entity_id FROM tasks WHERE NEW.kind='project' AND project_id=NEW.entity_id) AS incoming WHERE NOT EXISTS(SELECT 1 FROM assistant_events e WHERE e.entity_kind=incoming.entity_kind AND e.entity_id=incoming.entity_id AND e.status='pending'); INSERT INTO assistant_events(project_id,entity_kind,entity_id) SELECT incoming.project_id,incoming.entity_kind,incoming.entity_id FROM (SELECT p.project_id AS project_id,'review' AS entity_kind,r.id AS entity_id FROM memory_reviews r JOIN proposals p ON p.id=r.proposal_id WHERE (NEW.kind='project' AND p.project_id=NEW.entity_id) OR (NEW.kind='source' AND p.source_id=NEW.entity_id)) AS incoming WHERE NOT EXISTS(SELECT 1 FROM assistant_events e WHERE e.entity_kind=incoming.entity_kind AND e.entity_id=incoming.entity_id AND e.status='pending'); END;
INSERT OR IGNORE INTO assistant_events(project_id,entity_kind,entity_id) SELECT project_id,'task',id FROM tasks;
INSERT OR IGNORE INTO assistant_events(project_id,entity_kind,entity_id) SELECT p.project_id,'review',r.id FROM memory_reviews r JOIN proposals p ON p.id=r.proposal_id;
"#)?;
    Ok(())
}

fn settings(conn: &Connection) -> Result<Value> {
    Ok(conn.query_row(
        "SELECT enabled,version FROM assistant_work_settings WHERE id=1",
        [],
        |r| Ok(json!({"enabled":r.get::<_,bool>(0)?,"version":r.get::<_,i64>(1)?})),
    )?)
}
fn enabled(conn: &Connection) -> Result<bool> {
    Ok(settings(conn)?["enabled"] == true)
}
fn project_context(conn: &Connection, project: &str) -> Result<Value> {
    Ok(conn.query_row("SELECT p.name,COALESCE(f.status,'active'),COALESCE(l.archived,0),COALESCE(f.version,0),COALESCE(l.version,0) FROM projects p LEFT JOIN project_profiles f ON f.project_id=p.id LEFT JOIN workspace_lifecycle l ON l.kind='project' AND l.entity_id=p.id WHERE p.id=?",[project],|r|Ok(json!({"name":r.get::<_,String>(0)?,"status":r.get::<_,String>(1)?,"archived":r.get::<_,bool>(2)?,"version":r.get::<_,i64>(3)?,"lifecycleVersion":r.get::<_,i64>(4)?})))?)
}
fn project_active(project: &Value) -> bool {
    project["archived"] == false && project["status"] == "active"
}
fn task_snapshot(conn: &Connection, key: &str) -> Result<Option<Value>> {
    let task = match tasks::task(conn, key) {
        Ok(t) => t,
        Err(e) if e.code == "NOT_FOUND" => return Ok(None),
        Err(e) => return Err(e),
    };
    let project = project_context(conn, required(&task, "projectId")?)?;
    let follow=conn.query_row("SELECT version,next_follow_up_date,snoozed_until FROM task_follow_up_state WHERE task_id=?",[key],|r|Ok(json!({"version":r.get::<_,i64>(0)?,"nextFollowUpDate":r.get::<_,Option<String>>(1)?,"snoozedUntil":r.get::<_,Option<String>>(2)?}))).optional()?.unwrap_or(json!({"version":0,"nextFollowUpDate":null,"snoozedUntil":null}));
    let milestones=rows(conn,"SELECT json_object('id',m.id,'title',m.title,'status',m.status,'baselineDate',m.baseline_date,'forecastDate',m.forecast_date,'version',m.version) FROM milestone_tasks mt JOIN milestones m ON m.id=mt.milestone_id WHERE mt.task_id=? ORDER BY m.id LIMIT 64",&[&key])?;
    Ok(Some(
        json!({"task":task,"project":project,"followUp":follow,"milestones":milestones}),
    ))
}
fn review_snapshot(conn: &Connection, key: &str) -> Result<Option<Value>> {
    let review=conn.query_row("SELECT json_object('id',r.id,'projectId',p.project_id,'proposalId',p.id,'sourceId',p.source_id,'sourceTitle',s.title,'sourceStatus',s.status,'sourceArchived',COALESCE(l.archived,0),'content',p.content,'quotes',json(p.quotes),'proposalStatus',p.status,'disposition',r.disposition,'reason',r.reason,'status',r.status,'targetId',r.target_id,'targetRevision',r.target_revision,'targetContent',r.target_content,'currentTargetRevision',m.revision,'currentTargetContent',m.content,'currentTargetState',m.state) FROM memory_reviews r JOIN proposals p ON p.id=r.proposal_id JOIN sources s ON s.id=p.source_id LEFT JOIN memories m ON m.id=r.target_id LEFT JOIN workspace_lifecycle l ON l.kind='source' AND l.entity_id=s.id WHERE r.id=?",[key],|r|decode(r.get(0)?)).optional()?;
    let Some(review) = review else {
        return Ok(None);
    };
    let project = project_context(conn, required(&review, "projectId")?)?;
    Ok(Some(json!({"review":review,"project":project})))
}
fn fingerprint(snapshot: &Value) -> String {
    let mut semantic = snapshot.clone();
    if let Some(task) = semantic.get_mut("task").and_then(Value::as_object_mut) {
        for key in ["version", "updatedAt", "createdAt", "description"] {
            task.remove(key);
        }
    }
    if let Some(project) = semantic.get_mut("project").and_then(Value::as_object_mut) {
        project.remove("version");
        project.remove("lifecycleVersion");
    }
    hash(semantic.to_string().as_bytes())
}
fn choices(kind: &str) -> Value {
    let mut choices = vec![];
    if kind == "memory_conflict" {
        choices.push(json!({"id":"open_review","label":"核对原文并处理冲突","needsNote":false,"needsReviewAt":false,"needsDate":false}));
    } else {
        choices.push(json!({"id":"record_follow_up","label":"记录实际跟进并继续复查","needsNote":true,"needsReviewAt":true,"needsDate":false}));
    }
    if kind == "delay" {
        choices.push(json!({"id":"adopt_date","label":"确认调整截止日期","needsNote":true,"needsReviewAt":true,"needsDate":true}));
    }
    choices.push(json!({"id":"set_review","label":"稍后复查","needsNote":true,"needsReviewAt":true,"needsDate":false}));
    choices.push(json!({"id":"dismiss","label":"停止本次跟进","needsNote":false,"needsReviewAt":false,"needsDate":false}));
    json!(choices)
}
fn candidate(snapshot: &Value, kind: &str, today: &str, continuing: bool) -> Option<Value> {
    if !project_active(&snapshot["project"]) {
        return None;
    }
    if kind == "memory_conflict" {
        let r = &snapshot["review"];
        if r["status"] != "pending"
            || r["proposalStatus"] != "pending"
            || r["sourceStatus"] != "ready"
            || r["sourceArchived"] != 0
        {
            return None;
        }
        return Some(
            json!({"projectId":r["projectId"],"projectName":snapshot["project"]["name"],"kind":kind,"targetId":r["id"],"reviewId":r["id"],"sourceId":r["sourceId"],"title":format!("核对资料：{}",r["sourceTitle"].as_str().unwrap_or("新资料")),"reason":r["reason"],"summary":"已有资料需要核对。原文与当前记忆保留各自依据；在原审核流程处理后，助理会检查是否已解决。","evidence":[{"kind":"memory_review","id":r["id"],"label":"待核对资料","detail":r["content"]},{"kind":"memory","id":r["targetId"],"label":"当前记忆","detail":r["currentTargetContent"]}],"choices":choices(kind)}),
        );
    }
    let t = &snapshot["task"];
    if matches!(t["status"].as_str(), Some("done" | "cancelled")) {
        return None;
    }
    let due = t["dueDate"].as_str();
    let follow = &snapshot["followUp"];
    let delayed = due.is_some_and(|v| v < today);
    let milestone_impacts: Vec<_> = snapshot["milestones"]
        .as_array()?
        .iter()
        .filter(|m| {
            m["status"] != "completed"
                && m["status"] != "cancelled"
                && due
                    .zip(m["forecastDate"].as_str().or(m["baselineDate"].as_str()))
                    .is_some_and(|(d, m)| d > m)
        })
        .collect();
    let follow_due = follow["nextFollowUpDate"]
        .as_str()
        .is_some_and(|v| v <= today)
        && follow["snoozedUntil"].as_str().is_none_or(|v| v <= today);
    if !continuing
        && ((kind == "delay" && !delayed && milestone_impacts.is_empty())
            || (kind == "follow_up" && !follow_due))
    {
        return None;
    }
    let mut evidence = vec![
        json!({"kind":"task","id":t["id"],"label":"当前任务","detail":format!("{}；负责人：{}；状态：{}；截止：{}",t["title"].as_str().unwrap_or(""),t["assignee"].as_str().unwrap_or("未指定"),t["status"].as_str().unwrap_or(""),due.unwrap_or("未设置"))}),
    ];
    for m in &milestone_impacts {
        evidence.push(json!({"kind":"milestone","id":m["id"],"label":"关联里程碑","detail":format!("{}；目标日期：{}。任务期限晚于此日期，需核对实际影响。",m["title"].as_str().unwrap_or(""),m["forecastDate"].as_str().or(m["baselineDate"].as_str()).unwrap_or(""))}));
    }
    if kind == "follow_up" {
        evidence.push(json!({"kind":"task","id":t["id"],"label":"约定跟进日期","detail":follow["nextFollowUpDate"]}));
    }
    let reason = if continuing && !delayed && milestone_impacts.is_empty() && !follow_due {
        "已安排后续跟进，继续核对实际进展与交付结果"
    } else if kind == "follow_up" {
        "已到约定跟进日期"
    } else if delayed {
        "任务已超过记录的截止日期，仍未完成"
    } else {
        "任务期限晚于关联里程碑日期，存在交付风险"
    };
    Some(
        json!({"projectId":t["projectId"],"projectName":snapshot["project"]["name"],"kind":kind,"targetId":t["id"],"title":format!("{}：{}",if kind=="delay"{"核对交付影响"}else{"跟进约定结果"},t["title"].as_str().unwrap_or("")),"reason":reason,"summary":if kind=="delay"{"核对实际进度与关联里程碑；记录跟进，或明确确认新的截止日期。日期风险不代表已经实际延期交付。"}else{"记录对方实际回复，约定下次复查。没有回复或交付依据时不改变任务完成状态。"},"evidence":evidence,"choices":choices(kind)}),
    )
}
fn get_work(conn: &Connection, key: &str) -> Result<Value> {
    conn.query_row(
        "SELECT proposal_json FROM assistant_work WHERE id=?",
        [key],
        |r| decode(r.get(0)?),
    )
    .optional()?
    .ok_or_else(|| AppError::new("NOT_FOUND", "持续推进事项不存在"))
}
fn save_work(conn: &Connection, work: &Value, snapshot: &Value, fp: &str) -> Result<()> {
    conn.execute("INSERT INTO assistant_work(id,project_id,kind,target_id,status,version,fingerprint,snapshot_json,proposal_json,next_check_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,version=excluded.version,fingerprint=excluded.fingerprint,snapshot_json=excluded.snapshot_json,proposal_json=excluded.proposal_json,next_check_at=excluded.next_check_at,updated_at=excluded.updated_at",params![work["id"].as_str(),work["projectId"].as_str(),work["kind"].as_str(),work["targetId"].as_str(),work["status"].as_str(),work["version"].as_i64(),fp,snapshot.to_string(),work.to_string(),work["nextCheckAt"].as_str(),work["updatedAt"].as_str()])?;
    Ok(())
}
fn history(conn: &Connection, key: &str, kind: &str, note: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO assistant_work_history VALUES(?,?,?,?,?)",
        params![id(), key, kind, note, now()],
    )?;
    Ok(())
}
fn sync_work(
    conn: &Connection,
    kind: &str,
    target: &str,
    snapshot: Option<&Value>,
    at: &DateTime<FixedOffset>,
    event: Option<i64>,
) -> Result<()> {
    let existing=conn.query_row("SELECT proposal_json,fingerprint,snapshot_json FROM assistant_work WHERE kind=? AND target_id=?",params![kind,target],|r|Ok((decode(r.get(0)?)?,r.get::<_,String>(1)?,decode(r.get(2)?)?))).optional()?;
    // A delayed task already owns its follow-up commitment. The business API
    // stores follow-up dates at day precision; do not create a second immediate
    // reminder when this work is explicitly waiting until an hour later today.
    if kind=="follow_up" && existing.is_none() && conn.query_row("SELECT EXISTS(SELECT 1 FROM assistant_work WHERE kind='delay' AND target_id=? AND status<>'resolved')",[target],|r|r.get::<_,bool>(0))? {return Ok(());}
    let today = at.format("%Y-%m-%d").to_string();
    let continuing = existing
        .as_ref()
        .is_some_and(|(w, _, _)| w["continuing"] == true);
    let proposal = snapshot.and_then(|s| candidate(s, kind, &today, continuing));
    let Some(mut proposal) = proposal else {
        if let Some((mut w, fp, s)) = existing {
            if w["status"] != "resolved" {
                w["status"] = json!("resolved");
                w["version"] = json!(w["version"].as_i64().unwrap() + 1);
                w["nextCheckAt"] = Value::Null;
                w["updatedAt"] = json!(stamp(at));
                w["lastOutcome"] = json!("已核对当前记录，关注条件已解除或项目已停止推进");
                save_work(conn, &w, &s, &fp)?;
                history(
                    conn,
                    required(&w, "id")?,
                    "resolved",
                    "当前记录中的关注条件已解除；未自动宣称业务交付完成",
                )?;
            }
        }
        return Ok(());
    };
    let snapshot = snapshot.unwrap();
    let fp = fingerprint(snapshot);
    let (key, version, status, next, outcome, changed) =
        if let Some((old, previous, prior_snapshot)) = &existing {
            if matches!(old["status"].as_str(), Some("paused" | "cancelled")) {
                return Ok(());
            }
            let due = old["status"] == "watching"
                && old["nextCheckAt"]
                    .as_str()
                    .is_some_and(|v| v <= stamp(at).as_str());
            let changed = previous != &fp || old["status"] == "resolved" || due;
            if !changed && prior_snapshot == snapshot {
                return Ok(());
            }
            let status = if changed {
                "ready"
            } else {
                old["status"].as_str().unwrap()
            };
            (
                required(old, "id")?.to_owned(),
                old["version"].as_i64().unwrap() + 1,
                status.to_owned(),
                if changed {
                    Value::Null
                } else {
                    old["nextCheckAt"].clone()
                },
                old["lastOutcome"].clone(),
                changed,
            )
        } else {
            (id(), 1, "ready".into(), Value::Null, Value::Null, true)
        };
    proposal["id"] = json!(key);
    proposal["version"] = json!(version);
    proposal["status"] = json!(status);
    proposal["nextCheckAt"] = next;
    proposal["updatedAt"] = json!(stamp(at));
    proposal["lastOutcome"] = outcome;
    proposal["continuing"] = json!(continuing);
    save_work(conn, &proposal, snapshot, &fp)?;
    if changed {
        history(
            conn,
            &key,
            if existing.is_some() {
                "reassessed"
            } else {
                "prepared"
            },
            if existing.is_some() {
                "依据变化或约定复查到期，已重新准备下一步"
            } else {
                "已按当前记录准备行动与可执行选项"
            },
        )?;
        conn.execute(
            "INSERT INTO assistant_work_runs VALUES(?,?,?,?,?,?,?,?)",
            params![
                id(),
                key,
                event,
                "prepare",
                "succeeded",
                hash(snapshot.to_string().as_bytes()),
                proposal.to_string(),
                stamp(at)
            ],
        )?;
    }
    Ok(())
}
fn process_entity(
    conn: &Connection,
    kind: &str,
    key: &str,
    at: &DateTime<FixedOffset>,
    event: Option<i64>,
) -> Result<()> {
    if kind == "task" {
        let s = task_snapshot(conn, key)?;
        for k in ["delay", "follow_up"] {
            sync_work(conn, k, key, s.as_ref(), at, event)?;
        }
    } else {
        let s = review_snapshot(conn, key)?;
        sync_work(conn, "memory_conflict", key, s.as_ref(), at, event)?;
    }
    Ok(())
}
fn tick_at(conn: &Connection, at: &DateTime<FixedOffset>) -> Result<Value> {
    if !enabled(conn)? {
        return Ok(json!({"processed":0,"paused":true}));
    }
    let today = at.format("%Y-%m-%d").to_string();
    let previous: Option<String> = conn.query_row(
        "SELECT last_day FROM assistant_work_settings WHERE id=1",
        [],
        |r| r.get(0),
    )?;
    if previous.as_deref() != Some(&today) {
        conn.execute("INSERT OR IGNORE INTO assistant_events(project_id,entity_kind,entity_id) SELECT t.project_id,'task',t.id FROM tasks t LEFT JOIN task_follow_up_state f ON f.task_id=t.id WHERE t.status NOT IN('done','cancelled') AND ((t.due_date IS NOT NULL AND t.due_date<?1) OR (f.next_follow_up_date IS NOT NULL AND f.next_follow_up_date<=?1))",[&today])?;
        conn.execute(
            "UPDATE assistant_work_settings SET last_day=? WHERE id=1",
            [today],
        )?;
    }
    let due=rows(conn,"SELECT json_object('projectId',project_id,'kind',kind,'targetId',target_id) FROM assistant_work WHERE status='watching' AND next_check_at<=? ORDER BY next_check_at,id LIMIT ?",&[&stamp(at),&DUE_LIMIT])?;
    for w in due {
        conn.execute("INSERT OR IGNORE INTO assistant_events(project_id,entity_kind,entity_id) VALUES(?,?,?)",params![w["projectId"].as_str(),if w["kind"]=="memory_conflict"{"review"}else{"task"},w["targetId"].as_str()])?;
    }
    let mut stmt=conn.prepare("SELECT id,entity_kind,entity_id FROM assistant_events WHERE status='pending' ORDER BY id LIMIT ?")?;
    let events = stmt
        .query_map([EVENT_LIMIT], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    drop(stmt);
    for (event, kind, key) in &events {
        process_entity(conn, kind, key, at, Some(*event))?;
        conn.execute(
            "UPDATE assistant_events SET status='done',processed_at=? WHERE id=?",
            params![stamp(at), event],
        )?;
    }
    Ok(json!({"processed":events.len(),"paused":false}))
}
pub(crate) fn tick(conn: &mut Connection) -> Result<Value> {
    let tx = conn.transaction()?;
    let v = tick_at(&tx, &Local::now().fixed_offset())?;
    tx.commit()?;
    Ok(v)
}

fn center(conn: &Connection, p: &Value) -> Result<Value> {
    let project = p["projectId"].as_str().filter(|v| !v.is_empty());
    if let Some(project) = project {
        project_context(conn, project)?;
    }
    let works=rows(conn,"SELECT proposal_json FROM assistant_work WHERE (?1 IS NULL OR project_id=?1) ORDER BY CASE status WHEN 'ready' THEN 0 WHEN 'watching' THEN 1 WHEN 'paused' THEN 2 ELSE 3 END,updated_at DESC,id LIMIT 500",&[&project])?;
    let mut counts =
        json!({"ready":0,"watching":0,"paused":0,"resolved":0,"cancelled":0,"total":0});
    let mut stmt=conn.prepare("SELECT status,count(*) FROM assistant_work WHERE (?1 IS NULL OR project_id=?1) GROUP BY status")?;
    let values = stmt
        .query_map([project], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    for (status, n) in values {
        counts["total"] = json!(counts["total"].as_i64().unwrap() + n);
        counts[status] = json!(n);
    }
    let pending:i64=conn.query_row("SELECT count(*) FROM assistant_events WHERE status='pending' AND (?1 IS NULL OR project_id=?1)",[project],|r|r.get(0))?;
    let history=rows(conn,"SELECT json_object('id',h.id,'workId',h.work_id,'kind',h.kind,'note',h.note,'createdAt',h.created_at) FROM assistant_work_history h JOIN assistant_work w ON w.id=h.work_id WHERE (?1 IS NULL OR w.project_id=?1) ORDER BY h.rowid DESC LIMIT 100",&[&project])?;
    Ok(
        json!({"settings":settings(conn)?,"works":works,"counts":counts,"pendingEvents":pending,"history":history,"truncated":counts["total"].as_i64().unwrap_or(0)>500}),
    )
}
fn stored_snapshot(conn: &Connection, key: &str) -> Result<Value> {
    Ok(conn.query_row(
        "SELECT snapshot_json FROM assistant_work WHERE id=?",
        [key],
        |r| decode(r.get(0)?),
    )?)
}
fn live_snapshot(conn: &Connection, w: &Value) -> Result<Option<Value>> {
    if w["kind"] == "memory_conflict" {
        review_snapshot(conn, required(w, "targetId")?)
    } else {
        task_snapshot(conn, required(w, "targetId")?)
    }
}
fn require_version(w: &Value, p: &Value) -> Result<()> {
    if p["baseVersion"].as_i64().filter(|v| *v > 0) != w["version"].as_i64() {
        Err(conflict())
    } else {
        Ok(())
    }
}
fn review_time(p: &Value, at: &DateTime<FixedOffset>) -> Result<String> {
    let value = DateTime::parse_from_rfc3339(required(p, "reviewAt")?)
        .map_err(|_| invalid("复查时间格式无效"))?;
    if value <= *at || value > *at + Duration::days(366) {
        return Err(invalid("复查时间须在未来一年内"));
    }
    Ok(stamp(&value))
}
fn decide(conn: &Connection, p: &Value, at: &DateTime<FixedOffset>) -> Result<Value> {
    let key = required(p, "workId")?;
    let decision = required(p, "decisionId")?;
    if decision.len() > 200 {
        return Err(invalid("决定标识过长"));
    }
    let payload_hash = hash(p.to_string().as_bytes());
    if let Some((prior, response)) = conn
        .query_row(
            "SELECT payload_hash,response_json FROM assistant_decisions WHERE id=?",
            [decision],
            |r| Ok((r.get::<_, String>(0)?, decode(r.get(1)?)?)),
        )
        .optional()?
    {
        if prior != payload_hash {
            return Err(AppError::new(
                "IDEMPOTENCY_CONFLICT",
                "该决定标识已用于不同的操作",
            ));
        }
        return Ok(response);
    }
    if !enabled(conn)? {
        return Err(AppError::new(
            "AUTOMATION_PAUSED",
            "持续推进已暂停，请先启用",
        ));
    }
    let mut w = get_work(conn, key)?;
    require_version(&w, p)?;
    if !matches!(w["status"].as_str(), Some("ready" | "watching")) {
        return Err(invalid("当前事项不能执行此选择"));
    }
    let snapshot = stored_snapshot(conn, key)?;
    let live = live_snapshot(conn, &w)?.ok_or_else(conflict)?;
    if snapshot != live
        || candidate(
            &live,
            required(&w, "kind")?,
            &at.format("%Y-%m-%d").to_string(),
            w["continuing"] == true,
        )
        .is_none()
    {
        return Err(conflict());
    }
    let choice = required(p, "choice")?;
    if !w["choices"]
        .as_array()
        .is_some_and(|c| c.iter().any(|v| v["id"] == choice))
    {
        return Err(invalid("此事项不支持该选择"));
    }
    let note = p["note"].as_str().unwrap_or("").trim();
    if note.chars().count() > 5000 {
        return Err(invalid("说明过长"));
    }
    let needs_note = matches!(choice, "record_follow_up" | "set_review" | "adopt_date");
    if needs_note && note.is_empty() {
        return Err(invalid("请记录实际跟进或调整理由"));
    }
    let review = if needs_note {
        Some(review_time(p, at)?)
    } else if choice == "open_review" {
        Some(stamp(&(*at + Duration::hours(1))))
    } else {
        None
    };
    let today = at.format("%Y-%m-%d").to_string();
    let mut result = json!({"choice":choice});
    if choice == "adopt_date" {
        let proposed = required(p, "proposedDate")?;
        tasks::valid_date(proposed)?;
        if proposed < today.as_str() {
            return Err(invalid("新的截止日期不能早于今天"));
        }
        let t = &live["task"];
        let mut fields = t.clone();
        fields["baseVersion"] = t["version"].clone();
        fields["dueDate"] = json!(proposed);
        fields["workDate"] = json!(today);
        result["task"] = tasks::write_task(conn, t, &fields, "user", &[], note)?;
    }
    if matches!(choice, "record_follow_up" | "adopt_date") {
        let next = DateTime::parse_from_rfc3339(review.as_deref().unwrap())
            .map_err(|_| invalid("复查时间格式无效"))?
            .with_timezone(&Local)
            .format("%Y-%m-%d")
            .to_string();
        result["followUp"] = crate::delivery::record_follow_up(
            conn,
            &json!({"taskId":w["targetId"],"baseVersion":live["followUp"]["version"],"workDate":today,"note":note,"nextFollowUpDate":next}),
        )?;
    }
    let updated = live_snapshot(conn, &w)?.ok_or_else(conflict)?;
    w["status"] = json!(if choice == "dismiss" {
        "cancelled"
    } else {
        "watching"
    });
    w["continuing"] = json!(choice != "dismiss");
    w["version"] = json!(w["version"].as_i64().unwrap() + 1);
    w["nextCheckAt"] = json!(review);
    w["updatedAt"] = json!(stamp(at));
    w["lastOutcome"] = json!(match choice {
        "adopt_date" => format!(
            "已确认截止日期为 {}，并记录跟进；到期继续核对",
            p["proposedDate"].as_str().unwrap_or("")
        ),
        "record_follow_up" => "已保存实际跟进记录，等待约定复查".into(),
        "set_review" => "已安排复查；没有修改业务记录".into(),
        "open_review" => "已转往资料审核；冲突尚未解决，将继续核对审核状态".into(),
        _ => "已停止本次跟进，记录与依据保留".into(),
    });
    save_work(conn, &w, &updated, &fingerprint(&updated))?;
    history(
        conn,
        key,
        choice,
        if note.is_empty() {
            w["lastOutcome"].as_str().unwrap_or("")
        } else {
            note
        },
    )?;
    conn.execute(
        "INSERT INTO assistant_work_runs VALUES(?,?,?,?,?,?,?,?)",
        params![
            id(),
            key,
            None::<i64>,
            "execute",
            if choice == "dismiss" {
                "cancelled"
            } else {
                "waiting"
            },
            hash(snapshot.to_string().as_bytes()),
            result.to_string(),
            stamp(at)
        ],
    )?;
    conn.execute(
        "INSERT INTO assistant_decisions VALUES(?,?,?,?,?)",
        params![decision, key, payload_hash, w.to_string(), stamp(at)],
    )?;
    Ok(w)
}

pub(crate) fn dispatch(conn: &mut Connection, command: &str, p: &Value) -> Result<Value> {
    match command {
        "get_assistant_work" => return center(conn, p),
        "get_action_proposal" => {
            let key = required(p, "workId")?;
            let mut w = get_work(conn, key)?;
            let snapshot = stored_snapshot(conn, key)?;
            let live = live_snapshot(conn, &w)?;
            w["stale"] = json!(
                live.as_ref() != Some(&snapshot)
                    || live.as_ref().is_none_or(|s| candidate(
                        s,
                        w["kind"].as_str().unwrap_or(""),
                        &Local::now().format("%Y-%m-%d").to_string(),
                        w["continuing"] == true
                    )
                    .is_none())
            );
            w["snapshot"] = snapshot;
            return Ok(w);
        }
        "run_assistant_work" if p["workId"].as_str().is_some() => {
            let tx = conn.transaction()?;
            if !enabled(&tx)? {
                return Err(AppError::new(
                    "AUTOMATION_PAUSED",
                    "持续推进已暂停，请先启用",
                ));
            }
            let w = get_work(&tx, required(p, "workId")?)?;
            let live = live_snapshot(&tx, &w)?;
            sync_work(
                &tx,
                required(&w, "kind")?,
                required(&w, "targetId")?,
                live.as_ref(),
                &Local::now().fixed_offset(),
                None,
            )?;
            let result = get_work(&tx, required(&w, "id")?)?;
            tx.commit()?;
            return Ok(result);
        }
        "run_assistant_work" | "_assistant_work_tick" => return tick(conn),
        _ => {}
    }
    let at = Local::now().fixed_offset();
    let tx = conn.transaction()?;
    let value = match command {
        "decide_action_proposal" => decide(&tx, p, &at)?,
        "save_assistant_work_settings" => {
            let s = settings(&tx)?;
            if p["baseVersion"].as_i64() != s["version"].as_i64() {
                return Err(conflict());
            }
            let on = p["enabled"]
                .as_bool()
                .ok_or_else(|| invalid("启用状态无效"))?;
            tx.execute(
                "UPDATE assistant_work_settings SET enabled=?,version=version+1 WHERE id=1",
                [on],
            )?;
            settings(&tx)?
        }
        "pause_assistant_work" => {
            let key = required(p, "workId")?;
            let mut w = get_work(&tx, key)?;
            require_version(&w, p)?;
            let paused = p["paused"]
                .as_bool()
                .ok_or_else(|| invalid("暂停状态无效"))?;
            if paused && !matches!(w["status"].as_str(), Some("ready" | "watching"))
                || !paused && !matches!(w["status"].as_str(), Some("paused" | "cancelled"))
            {
                return Err(invalid("当前状态不支持此操作"));
            }
            let s = stored_snapshot(&tx, key)?;
            w["status"] = json!(if paused { "paused" } else { "ready" });
            w["version"] = json!(w["version"].as_i64().unwrap() + 1);
            w["updatedAt"] = json!(stamp(&at));
            w["lastOutcome"] = json!(if paused {
                "已暂停此事项"
            } else {
                "已恢复，等待核对最新依据"
            });
            save_work(&tx, &w, &s, &fingerprint(&s))?;
            history(
                &tx,
                key,
                if paused { "paused" } else { "resumed" },
                w["lastOutcome"].as_str().unwrap(),
            )?;
            if !paused {
                let live = live_snapshot(&tx, &w)?;
                sync_work(
                    &tx,
                    required(&w, "kind")?,
                    required(&w, "targetId")?,
                    live.as_ref(),
                    &at,
                    None,
                )?;
            }
            get_work(&tx, key)?
        }
        _ => return Err(AppError::new("UNKNOWN_COMMAND", "未知持续推进操作")),
    };
    tx.commit()?;
    Ok(value)
}

pub(crate) fn pause_after_restore(conn: &Connection) -> Result<()> {
    conn.execute(
        "UPDATE assistant_work_settings SET enabled=0,version=version+1,last_day=NULL WHERE id=1",
        [],
    )?;
    Ok(())
}

/// Backup schemas are executable input. Build the only permitted triggers from
/// our compiled migration on a private empty database, never from archive SQL.
/// Compare their complete sqlite_master definitions, including target tables;
/// a trusted name with a modified body is not sufficient.
pub(crate) fn validate_expected_triggers(conn: &Connection) -> Result<()> {
    fn definitions(
        conn: &Connection,
    ) -> Result<std::collections::BTreeMap<String, (String, String)>> {
        let views: i64 = conn.query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='view'",
            [],
            |r| r.get(0),
        )?;
        if views != 0 {
            return Err(AppError::new("INVALID_BACKUP", "备份包含不允许的视图"));
        }
        let mut stmt = conn.prepare(
            "SELECT name,tbl_name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name",
        )?;
        let records = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    (r.get::<_, String>(1)?, r.get::<_, String>(2)?),
                ))
            })?
            .collect::<std::result::Result<std::collections::BTreeMap<_, _>, _>>()?;
        Ok(records)
    }
    let trusted = Connection::open_in_memory()?;
    // Only names and columns consumed by migrate's seed statements are needed.
    // SQLite parses the trusted trigger declarations without executing them.
    trusted.execute_batch(
        "CREATE TABLE projects(id TEXT PRIMARY KEY);
         CREATE TABLE tasks(id TEXT,project_id TEXT);
         CREATE TABLE task_follow_up_state(task_id TEXT,project_id TEXT);
         CREATE TABLE memory_reviews(id TEXT,proposal_id TEXT,target_id TEXT);
         CREATE TABLE proposals(id TEXT,project_id TEXT,source_id TEXT);
         CREATE TABLE memories(id TEXT);
         CREATE TABLE sources(id TEXT);
         CREATE TABLE milestones(id TEXT,project_id TEXT);
         CREATE TABLE milestone_tasks(milestone_id TEXT,task_id TEXT);
         CREATE TABLE project_profiles(project_id TEXT);
         CREATE TABLE workspace_lifecycle(kind TEXT,entity_id TEXT);",
    )?;
    migrate(&trusted)?;
    if definitions(conn)? != definitions(&trusted)? {
        return Err(AppError::new(
            "INVALID_BACKUP",
            "备份中的事件触发器缺失、被修改或包含未知触发器",
        ));
    }
    Ok(())
}
pub(crate) fn validate_backup(conn: &Connection) -> Result<()> {
    let settings = settings(conn)?;
    if settings["version"].as_i64().is_none_or(|v| v < 1) {
        return Err(invalid("持续推进设置版本无效"));
    }
    let mut stmt=conn.prepare("SELECT id,project_id,kind,target_id,status,version,proposal_json,snapshot_json FROM assistant_work")?;
    let values = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, i64>(5)?,
                decode(r.get(6)?)?,
                decode(r.get(7)?)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    for (key, project, kind, target, status, version, work, snapshot) in values {
        if work["id"] != key
            || work["projectId"] != project
            || work["kind"] != kind
            || work["targetId"] != target
            || work["status"] != status
            || work["version"] != version
            || version < 1
        {
            return Err(invalid("持续推进状态与保存的方案不一致"));
        }
        let actual = if kind == "memory_conflict" {
            snapshot["review"]["projectId"].as_str()
        } else {
            snapshot["task"]["projectId"].as_str()
        };
        if actual != Some(project.as_str()) {
            return Err(invalid("持续推进依据跨越项目"));
        }
        if let Some(next) = work["nextCheckAt"].as_str() {
            DateTime::parse_from_rfc3339(next).map_err(|_| invalid("复查时间无效"))?;
        }
        if work["choices"] != choices(&kind) {
            return Err(invalid("持续推进方案包含未知执行选项"));
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "orchestration_tests.rs"]
mod tests;
