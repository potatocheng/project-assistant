//! Request reservations survive interrupted runs and restoration of old backups.
//! These are request-count limits; reported tokens are not a currency estimate.
use crate::{required, AppError, Result};
use chrono::Local;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

const DAILY_REQUESTS: i64 = 100;
const PROJECT_REQUESTS: i64 = 60;

pub(crate) fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS assistance_requests(
        run_id TEXT NOT NULL,stage TEXT NOT NULL,day TEXT NOT NULL,project_id TEXT,
        reported_tokens INTEGER CHECK(reported_tokens>=0),settled INTEGER NOT NULL DEFAULT 0 CHECK(settled IN (0,1)),
        PRIMARY KEY(run_id,stage));
        CREATE INDEX IF NOT EXISTS assistance_requests_day ON assistance_requests(day,project_id);")?;
    Ok(())
}

pub(crate) fn record(conn: &Connection, p: &Value) -> Result<()> {
    let run = required(p, "runId")?;
    let project = p["snapshot"]["request"]["projectId"]
        .as_str()
        .filter(|s| !s.is_empty() && *s != "all");
    if p["event"] == "start" {
        let count: i64 = conn.query_row(
            "SELECT count(*) FROM assistance_runs WHERE status='running'",
            [],
            |r| r.get(0),
        )?;
        if count > 3 {
            return Err(AppError::new(
                "ASSISTANCE_BUSY",
                "已有三项分析正在处理，请稍后重试",
            ));
        }
    }
    if let Some(stage) = p["inFlight"].as_str() {
        let prior: Option<i64> = conn
            .query_row(
                "SELECT settled FROM assistance_requests WHERE run_id=? AND stage=?",
                params![run, stage],
                |r| r.get(0),
            )
            .optional()?;
        if prior == Some(1) {
            return Err(AppError::new(
                "ASSISTANCE_AUDIT_INVALID",
                "已结束的分析请求不能重复发送",
            ));
        }
        if prior.is_none() {
            let today = Local::now().format("%Y-%m-%d").to_string();
            let (total, scoped): (i64,i64) = conn.query_row("SELECT count(*),coalesce(sum(project_id IS ?2),0) FROM assistance_requests WHERE day=?1",params![today,project],|r|Ok((r.get(0)?,r.get(1)?)))?;
            if total >= DAILY_REQUESTS || (project.is_some() && scoped >= PROJECT_REQUESTS) {
                return Err(AppError::new("ASSISTANCE_DAILY_LIMIT", "今日建议分析额度已用完（全局100次、单项目60次请求，含生成与核验），明日恢复；本地持续推进仍可使用"));
            }
            conn.execute(
                "INSERT INTO assistance_requests(run_id,stage,day,project_id) VALUES(?,?,?,?)",
                params![run, stage, today, project],
            )?;
        }
    }
    for entry in p["queryTrace"]["stages"].as_array().into_iter().flatten() {
        let stage = match entry["stage"].as_str() {
            Some("daily_project_assistance") => "generation",
            Some("daily_project_assistance_review") => "review",
            _ => continue,
        };
        conn.execute(
            "UPDATE assistance_requests SET settled=1,reported_tokens=? WHERE run_id=? AND stage=?",
            params![entry["usage"]["totalTokens"].as_i64(), run, stage],
        )?;
    }
    Ok(())
}

pub(crate) fn summary(conn: &Connection, project: Option<&str>) -> Result<Value> {
    let today = Local::now().format("%Y-%m-%d").to_string();
    let (calls,tokens,unknown):(i64,i64,i64)=conn.query_row("SELECT count(*),coalesce(sum(reported_tokens),0),coalesce(sum(reported_tokens IS NULL),0) FROM assistance_requests WHERE day=?1 AND (?2 IS NULL OR project_id=?2)",params![today,project],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
    Ok(
        json!({"date":today,"reservedRequests":calls,"reportedTokens":tokens,"unknownUsageRequests":unknown,"globalRequestLimit":DAILY_REQUESTS,"projectRequestLimit":PROJECT_REQUESTS}),
    )
}

pub(crate) fn records(conn: &Connection) -> Result<Vec<Value>> {
    let mut stmt = conn.prepare(
        "SELECT run_id,stage,day,project_id,reported_tokens,settled FROM assistance_requests",
    )?;
    let rows = stmt.query_map([],|r|Ok(json!({"run":r.get::<_,String>(0)?,"stage":r.get::<_,String>(1)?,"day":r.get::<_,String>(2)?,"project":r.get::<_,Option<String>>(3)?,"tokens":r.get::<_,Option<i64>>(4)?,"settled":r.get::<_,i64>(5)?})))?.collect::<std::result::Result<Vec<_>,_>>()?;
    Ok(rows)
}

pub(crate) fn preserve(conn: &Connection, rows: &[Value]) -> Result<()> {
    for row in rows {
        conn.execute("INSERT INTO assistance_requests VALUES(?,?,?,?,?,?) ON CONFLICT(run_id,stage) DO UPDATE SET reported_tokens=CASE WHEN excluded.reported_tokens IS NULL THEN assistance_requests.reported_tokens WHEN assistance_requests.reported_tokens IS NULL THEN excluded.reported_tokens ELSE max(assistance_requests.reported_tokens,excluded.reported_tokens) END,settled=max(assistance_requests.settled,excluded.settled)",params![row["run"].as_str(),row["stage"].as_str(),row["day"].as_str(),row["project"].as_str(),row["tokens"].as_i64(),row["settled"].as_i64()])?;
    }
    Ok(())
}

pub(crate) fn validate_backup(conn: &Connection) -> Result<()> {
    for row in records(conn)? {
        if uuid::Uuid::parse_str(required(&row, "run")?).is_err()
            || !matches!(row["stage"].as_str(), Some("generation" | "review"))
            || !matches!(row["settled"].as_i64(), Some(0 | 1))
            || row["tokens"].as_i64().is_some_and(|n| n < 0)
        {
            return Err(AppError::new("INVALID_BACKUP", "分析预算记录无效"));
        }
        crate::tasks::valid_date(required(&row, "day")?)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn global_quota_counts_requests_across_projects_and_stops_before_reserving() {
        let c = Connection::open_in_memory().unwrap();
        migrate(&c).unwrap();
        for index in 0..DAILY_REQUESTS {
            record(&c,&json!({"runId":crate::id(),"event":"checkpoint","inFlight":"generation","snapshot":{"request":{"projectId":format!("p{}",index%2)}},"queryTrace":{"stages":[]}})).unwrap();
        }
        let result = record(
            &c,
            &json!({"runId":crate::id(),"event":"checkpoint","inFlight":"review","snapshot":{"request":{"projectId":"third"}},"queryTrace":{"stages":[]}}),
        );
        assert_eq!(result.unwrap_err().code, "ASSISTANCE_DAILY_LIMIT");
        assert_eq!(
            summary(&c, None).unwrap()["reservedRequests"],
            DAILY_REQUESTS
        );
        assert_eq!(summary(&c, Some("third")).unwrap()["reservedRequests"], 0);
    }

    #[test]
    fn concurrency_rejection_rolls_back_start_registration() {
        let mut c = Connection::open_in_memory().unwrap();
        migrate(&c).unwrap();
        c.execute_batch("CREATE TABLE assistance_runs(status TEXT);")
            .unwrap();
        for _ in 0..3 {
            c.execute("INSERT INTO assistance_runs VALUES('running')", [])
                .unwrap();
        }
        {
            let tx = c.transaction().unwrap();
            tx.execute("INSERT INTO assistance_runs VALUES('running')", [])
                .unwrap();
            let error = record(&tx, &json!({"runId":crate::id(),"event":"start"})).unwrap_err();
            assert_eq!(error.code, "ASSISTANCE_BUSY");
        }
        assert_eq!(
            c.query_row("SELECT count(*) FROM assistance_runs", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            3
        );
        c.execute(
            "UPDATE assistance_runs SET status='failed' WHERE rowid=1",
            [],
        )
        .unwrap();
        let tx = c.transaction().unwrap();
        tx.execute("INSERT INTO assistance_runs VALUES('running')", [])
            .unwrap();
        record(&tx, &json!({"runId":crate::id(),"event":"start"})).unwrap();
        tx.commit().unwrap();
    }
    #[test]
    fn reservations_survive_old_restore_and_unknown_usage_is_not_zero() {
        let c = Connection::open_in_memory().unwrap();
        migrate(&c).unwrap();
        let run = crate::id();
        let p = json!({"runId":run,"event":"checkpoint","inFlight":"generation","snapshot":{"request":{"projectId":"p"}},"queryTrace":{"stages":[]}});
        record(&c, &p).unwrap();
        record(&c, &p).unwrap();
        assert_eq!(summary(&c, None).unwrap()["reservedRequests"], 1);
        assert_eq!(summary(&c, None).unwrap()["unknownUsageRequests"], 1);
        let before = records(&c).unwrap();
        c.execute("DELETE FROM assistance_requests", []).unwrap();
        preserve(&c, &before).unwrap();
        preserve(&c, &before).unwrap();
        assert_eq!(summary(&c, None).unwrap()["reservedRequests"], 1);
        for _ in 1..PROJECT_REQUESTS {
            let mut next = p.clone();
            next["runId"] = json!(crate::id());
            record(&c, &next).unwrap();
        }
        let mut next = p;
        next["runId"] = json!(crate::id());
        assert_eq!(
            record(&c, &next).unwrap_err().code,
            "ASSISTANCE_DAILY_LIMIT"
        );
        validate_backup(&c).unwrap();
    }
}
