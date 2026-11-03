//! Durable model-run accounting. Audit records never become project facts.
use crate::{now, required, AppError, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

fn invalid() -> AppError {
    AppError::new("ASSISTANCE_AUDIT_INVALID", "分析运行记录无效")
}
fn parse(raw: &str) -> Result<Value> {
    serde_json::from_str(raw).map_err(|_| invalid())
}

pub(crate) fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS assistance_runs(
        id TEXT PRIMARY KEY,project_id TEXT REFERENCES projects(id),task_id TEXT REFERENCES tasks(id),
        request_json TEXT NOT NULL,fingerprint TEXT NOT NULL,workspace_epoch INTEGER NOT NULL,model_revision TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed','interrupted')),
        trace_json TEXT NOT NULL,review_json TEXT NOT NULL,error_code TEXT,in_flight TEXT,
        created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS assistance_runs_project ON assistance_runs(project_id,created_at);")?;
    Ok(())
}

fn trace_valid(trace: &Value) -> bool {
    const KEYS: &[&str] = &[
        "version",
        "modelCalls",
        "maxModelCalls",
        "inputChars",
        "maxInputChars",
        "maxOutputCharsPerCall",
        "elapsedMs",
        "timeoutSeconds",
        "stages",
        "reportedTokens",
        "reportedTokenStopThreshold",
        "usageComplete",
        "tokenBudgetMode",
        "cacheHit",
    ];
    if !trace
        .as_object()
        .is_some_and(|o| o.keys().all(|k| KEYS.contains(&k.as_str())))
    {
        return false;
    }
    let Some(calls) = trace["modelCalls"].as_u64() else {
        return false;
    };
    let Some(stages) = trace["stages"].as_array() else {
        return false;
    };
    calls <= 2
        && stages.len() as u64 == calls
        && trace["reportedTokens"].as_u64().is_some()
        && trace["inputChars"].as_u64().is_some()
        && trace["usageComplete"].as_bool().is_some()
        && trace.to_string().len() < 32_000
        && stages.iter().all(|s| {
            if !s.as_object().is_some_and(|o| {
                o.keys().all(|k| {
                    ["stage", "elapsedMs", "inputChars", "usage", "errorCode"].contains(&k.as_str())
                })
            }) {
                return false;
            }
            matches!(
                s["stage"].as_str(),
                Some("daily_project_assistance" | "daily_project_assistance_review")
            ) && s["elapsedMs"].as_u64().is_some()
                && s["inputChars"].as_u64().is_some()
                && (s["usage"].is_null()
                    || (s["usage"].as_object().is_some_and(|o| o.len() == 3)
                        && ["inputTokens", "outputTokens", "totalTokens"]
                            .iter()
                            .all(|key| s["usage"][key].as_u64().is_some())
                        && s["usage"]["inputTokens"].as_u64().and_then(|n| {
                            n.checked_add(s["usage"]["outputTokens"].as_u64().unwrap_or(0))
                        }) == s["usage"]["totalTokens"].as_u64()))
                && (s["errorCode"].is_null() || error_valid(&s["errorCode"]))
        })
        && trace["reportedTokens"].as_u64()
            == stages.iter().try_fold(0u64, |sum, s| {
                sum.checked_add(s["usage"]["totalTokens"].as_u64().unwrap_or(0))
            })
        && trace["usageComplete"].as_bool() == Some(stages.iter().all(|s| s["usage"].is_object()))
}
fn error_valid(value: &Value) -> bool {
    value.as_str().is_some_and(|s| {
        !s.is_empty()
            && s.len() <= 100
            && s.bytes()
                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == b'_')
    })
}

fn read(conn: &Connection, id: &str) -> Result<Value> {
    let row: Option<Value> = conn.query_row("SELECT id,project_id,task_id,request_json,fingerprint,workspace_epoch,model_revision,status,trace_json,review_json,error_code,in_flight,created_at,updated_at FROM assistance_runs WHERE id=?",[id],|r|Ok(json!({
        "runId":r.get::<_,String>(0)?,"projectId":r.get::<_,Option<String>>(1)?,"taskId":r.get::<_,Option<String>>(2)?,
        "requestRaw":r.get::<_,String>(3)?,"fingerprint":r.get::<_,String>(4)?,"workspaceEpoch":r.get::<_,u64>(5)?,
        "modelRevision":r.get::<_,String>(6)?,"status":r.get::<_,String>(7)?,"traceRaw":r.get::<_,String>(8)?,
        "reviewRaw":r.get::<_,String>(9)?,"errorCode":r.get::<_,Option<String>>(10)?,"inFlight":r.get::<_,Option<String>>(11)?,
        "createdAt":r.get::<_,String>(12)?,"updatedAt":r.get::<_,String>(13)?}))).optional()?;
    let mut value = row.ok_or_else(|| AppError::new("NOT_FOUND", "分析运行记录不存在"))?;
    for (raw, key) in [
        ("requestRaw", "request"),
        ("traceRaw", "queryTrace"),
        ("reviewRaw", "review"),
    ] {
        value[key] = parse(value[raw].as_str().unwrap())?;
        value.as_object_mut().unwrap().remove(raw);
    }
    // A reservation may have reached the provider before a process interruption.
    value["unresolvedRequest"] = json!(!value["inFlight"].is_null());
    Ok(value)
}

pub(crate) fn record(conn: &Connection, p: &Value) -> Result<Value> {
    let run_id = required(p, "runId")?;
    if uuid::Uuid::parse_str(run_id).is_err() || !trace_valid(&p["queryTrace"]) {
        return Err(invalid());
    }
    let snapshot = &p["snapshot"];
    let fingerprint = required(snapshot, "fingerprint")?;
    let model = required(snapshot, "modelRevision")?;
    let epoch = snapshot["workspaceEpoch"]
        .as_u64()
        .filter(|n| *n <= i64::MAX as u64)
        .ok_or_else(invalid)?;
    if fingerprint.len() != 64
        || !fingerprint.bytes().all(|c| c.is_ascii_hexdigit())
        || model.len() > 200
    {
        return Err(invalid());
    }
    let status = required(p, "status")?;
    let event = required(p, "event")?;
    let in_flight = p["inFlight"].as_str();
    if !p["inFlight"].is_null() && !matches!(in_flight, Some("generation" | "review")) {
        return Err(invalid());
    }
    if !p["errorCode"].is_null() && !error_valid(&p["errorCode"]) {
        return Err(invalid());
    }
    if p["review"].to_string().len() > 80_000 {
        return Err(invalid());
    }
    let at = now();
    if event == "start" {
        if status != "running"
            || p["queryTrace"]["modelCalls"] != 0
            || in_flight.is_some()
            || !p["review"].is_null()
            || !p["errorCode"].is_null()
        {
            return Err(invalid());
        }
        let req = &snapshot["request"];
        if (!req["projectId"].is_null() && !req["projectId"].is_string())
            || (!req["taskId"].is_null() && !req["taskId"].is_string())
        {
            return Err(invalid());
        }
        if !matches!(req["kind"].as_str(), Some("brief" | "coach")) {
            return Err(invalid());
        }
        crate::tasks::valid_date(required(req, "date")?)?;
        let project = req["projectId"]
            .as_str()
            .filter(|id| !id.is_empty() && *id != "all");
        let task = req["taskId"].as_str();
        if let Some(project) = project {
            if !conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM projects WHERE id=?)",
                [project],
                |r| r.get::<_, bool>(0),
            )? {
                return Err(invalid());
            }
        }
        if req["kind"] == "coach" && (task.is_none() || project.is_none()) {
            return Err(invalid());
        }
        if let Some(task) = task {
            if !conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM tasks WHERE id=? AND project_id=?)",
                params![task, project],
                |r| r.get::<_, bool>(0),
            )? {
                return Err(invalid());
            }
        }
        let request =
            json!({"kind":req["kind"],"date":req["date"],"projectId":project,"taskId":task});
        conn.execute(
            "INSERT INTO assistance_runs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            params![
                run_id,
                project,
                task,
                request.to_string(),
                fingerprint,
                epoch,
                model,
                status,
                p["queryTrace"].to_string(),
                "null",
                Option::<String>::None,
                Option::<String>::None,
                at,
                at
            ],
        )?;
    } else {
        let prior = read(conn, run_id)?;
        if prior["status"] != "running"
            || prior["fingerprint"] != fingerprint
            || prior["workspaceEpoch"] != epoch
            || prior["modelRevision"] != model
            || p["queryTrace"]["modelCalls"].as_u64() < prior["queryTrace"]["modelCalls"].as_u64()
            || p["queryTrace"]["reportedTokens"].as_u64()
                < prior["queryTrace"]["reportedTokens"].as_u64()
        {
            return Err(invalid());
        }
        if event == "checkpoint" {
            if status != "running" || !p["errorCode"].is_null() {
                return Err(invalid());
            }
        } else if event == "finish" {
            if !matches!(status, "succeeded" | "failed")
                || in_flight.is_some()
                || (status == "succeeded"
                    && (p["review"]["status"] != "passed" || !p["errorCode"].is_null()))
                || (status == "failed" && !error_valid(&p["errorCode"]))
            {
                return Err(invalid());
            }
        } else {
            return Err(invalid());
        }
        conn.execute("UPDATE assistance_runs SET status=?,trace_json=?,review_json=?,error_code=?,in_flight=?,updated_at=? WHERE id=? AND status='running'",params![status,p["queryTrace"].to_string(),p["review"].to_string(),p["errorCode"].as_str(),in_flight,at,run_id])?;
    }
    Ok(json!({"runId":run_id,"saved":true}))
}

pub(crate) fn list(conn: &Connection, p: &Value) -> Result<Value> {
    let project = p["projectId"]
        .as_str()
        .filter(|id| !id.is_empty() && *id != "all");
    if !p["projectId"].is_null() && !p["projectId"].is_string() {
        return Err(invalid());
    }
    if let Some(project) = project {
        if !conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM projects WHERE id=?)",
            [project],
            |r| r.get::<_, bool>(0),
        )? {
            return Err(AppError::new("NOT_FOUND", "项目不存在"));
        }
    }
    let offset = p["offset"].as_i64().unwrap_or(0).max(0);
    let mut s=conn.prepare("SELECT id FROM assistance_runs WHERE (?1 IS NULL OR project_id=?1) ORDER BY created_at DESC,rowid DESC LIMIT 50 OFFSET ?2")?;
    let ids = s
        .query_map(params![project, offset], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let runs = ids
        .iter()
        .map(|id| read(conn, id))
        .collect::<Result<Vec<_>>>()?;
    let total = conn.query_row(
        "SELECT count(*) FROM assistance_runs WHERE (?1 IS NULL OR project_id=?1)",
        [project],
        |r| r.get::<_, i64>(0),
    )?;
    Ok(json!({"runs":runs,"total":total,"offset":offset}))
}

pub(crate) fn interrupt_running(conn: &Connection, reason: &str) -> Result<()> {
    let code = if reason == "restore" {
        "RESTORE_PAUSED"
    } else {
        "RESTART_INTERRUPTED"
    };
    conn.execute("UPDATE assistance_runs SET status='interrupted',error_code=?,updated_at=? WHERE status='running'",params![code,now()])?;
    Ok(())
}

pub(crate) fn validate_backup(conn: &Connection) -> Result<()> {
    let mut s = conn.prepare("SELECT id FROM assistance_runs")?;
    let ids = s
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    for id in ids {
        let v = read(conn, &id)?;
        if uuid::Uuid::parse_str(&id).is_err()
            || !trace_valid(&v["queryTrace"])
            || !matches!(
                v["status"].as_str(),
                Some("running" | "succeeded" | "failed" | "interrupted")
            )
            || v["fingerprint"]
                .as_str()
                .is_none_or(|f| f.len() != 64 || !f.bytes().all(|c| c.is_ascii_hexdigit()))
            || !matches!(v["request"]["kind"].as_str(), Some("brief" | "coach"))
            || v["projectId"] != v["request"]["projectId"]
            || v["taskId"] != v["request"]["taskId"]
            || (v["status"] == "succeeded"
                && (v["review"]["status"] != "passed" || !v["inFlight"].is_null()))
            || (!v["inFlight"].is_null()
                && !matches!(v["inFlight"].as_str(), Some("generation" | "review")))
            || (!v["errorCode"].is_null() && !error_valid(&v["errorCode"]))
        {
            return Err(invalid());
        }
        crate::tasks::valid_date(required(&v["request"], "date")?)?;
        if let Some(task) = v["taskId"].as_str() {
            if !conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM tasks WHERE id=? AND project_id=?)",
                params![task, v["projectId"].as_str()],
                |r| r.get::<_, bool>(0),
            )? {
                return Err(invalid());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn interrupted_request_stays_unknown_without_inventing_zero_usage() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE projects(id TEXT PRIMARY KEY);CREATE TABLE tasks(id TEXT PRIMARY KEY,project_id TEXT);").unwrap();
        migrate(&conn).unwrap();
        let mut p = json!({"runId":crate::id(),"event":"start","snapshot":{"request":{"kind":"brief","date":"2026-11-03","projectId":null,"taskId":null},"fingerprint":"a".repeat(64),"workspaceEpoch":0,"modelRevision":"model-1"},"status":"running","queryTrace":{"modelCalls":0,"reportedTokens":0,"inputChars":0,"usageComplete":true,"stages":[]}});
        record(&conn, &p).unwrap();
        p["event"] = json!("checkpoint");
        p["inFlight"] = json!("generation");
        record(&conn, &p).unwrap();
        interrupt_running(&conn, "restart").unwrap();
        let result = list(&conn, &json!({})).unwrap();
        assert_eq!(result["runs"][0]["status"], "interrupted");
        assert_eq!(result["runs"][0]["unresolvedRequest"], true);
        assert!(record(&conn, &p).is_err());
        validate_backup(&conn).unwrap();
        conn.execute("UPDATE assistance_runs SET trace_json='{}'", [])
            .unwrap();
        assert!(validate_backup(&conn).is_err());
    }
}
