//! Local change approval and independent delivery acceptance with immutable snapshots.
use crate::{id, now, required, tasks, AppError, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::HashSet;

pub(crate) fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch(r#"
CREATE TABLE change_requests(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),title TEXT NOT NULL,status TEXT NOT NULL,version INTEGER NOT NULL,work_date TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,data_json TEXT NOT NULL);
CREATE TABLE change_request_history(id TEXT PRIMARY KEY,change_id TEXT NOT NULL REFERENCES change_requests(id),version INTEGER NOT NULL,work_date TEXT NOT NULL,actor TEXT NOT NULL,note TEXT NOT NULL,snapshot_json TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(change_id,version));
CREATE TABLE deliverables(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),title TEXT NOT NULL,status TEXT NOT NULL,version INTEGER NOT NULL,work_date TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,data_json TEXT NOT NULL);
CREATE TABLE deliverable_history(id TEXT PRIMARY KEY,deliverable_id TEXT NOT NULL REFERENCES deliverables(id),version INTEGER NOT NULL,work_date TEXT NOT NULL,actor TEXT NOT NULL,note TEXT NOT NULL,snapshot_json TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(deliverable_id,version));
CREATE INDEX change_request_project ON change_requests(project_id,work_date);
CREATE INDEX deliverable_project ON deliverables(project_id,work_date);
"#)?;
    Ok(())
}
fn invalid(message: &str) -> AppError {
    AppError::new("VALIDATION", message)
}
fn conflict() -> AppError {
    AppError::new("VERSION_CONFLICT", "内容已更新，请刷新后重试")
}
fn string(p: &Value, key: &str, nonempty: bool) -> Result<String> {
    let s = p[key]
        .as_str()
        .ok_or_else(|| invalid(&format!("{key} 必须是文字")))?
        .trim();
    if s.chars().count() > 20000 || (nonempty && s.is_empty()) {
        return Err(invalid(&format!("{key} 为空或超过 20000 字")));
    }
    Ok(s.into())
}
fn number(p: &Value, key: &str) -> Result<i64> {
    p[key]
        .as_i64()
        .filter(|v| *v >= 0)
        .ok_or_else(|| invalid("版本必须是非负整数"))
}
fn date(p: &Value) -> Result<&str> {
    let d = required(p, "date")?;
    tasks::valid_date(d)?;
    Ok(d)
}
fn project(conn: &Connection, key: &str) -> Result<()> {
    if !conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM projects WHERE id=?)",
        [key],
        |r| r.get::<_, bool>(0),
    )? {
        return Err(AppError::new("PROJECT_SCOPE", "请选择有效项目"));
    }
    Ok(())
}
fn parse(raw: String) -> rusqlite::Result<Value> {
    serde_json::from_str(&raw).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })
}
fn table(delivery: bool) -> (&'static str, &'static str, &'static str) {
    if delivery {
        ("deliverables", "deliverable_history", "deliverable_id")
    } else {
        ("change_requests", "change_request_history", "change_id")
    }
}
fn get(conn: &Connection, key: &str, delivery: bool) -> Result<Value> {
    let (t, _, _) = table(delivery);
    conn.query_row(
        &format!("SELECT data_json FROM {t} WHERE id=?"),
        [key],
        |r| parse(r.get(0)?),
    )
    .optional()?
    .ok_or_else(|| AppError::new("NOT_FOUND", "记录不存在"))
}
fn snapshot(conn: &Connection, project: &str, kind: &str, key: &str) -> Result<Value> {
    let value = match kind {
        "task" => tasks::task(conn,key)?,
        "milestone" => {
            let mut v = conn.query_row("SELECT id,project_id,title,status,version,baseline_date,forecast_date FROM milestones WHERE id=?",[key],|r|Ok(json!({"id":r.get::<_,String>(0)?,"projectId":r.get::<_,String>(1)?,"title":r.get::<_,String>(2)?,"status":r.get::<_,String>(3)?,"version":r.get::<_,i64>(4)?,"baselineDate":r.get::<_,Option<String>>(5)?,"forecastDate":r.get::<_,Option<String>>(6)?}))).optional()?.ok_or_else(||AppError::new("NOT_FOUND","里程碑不存在"))?;
            let mut s=conn.prepare("SELECT t.id,t.version,t.status FROM milestone_tasks l JOIN tasks t ON t.id=l.task_id WHERE l.milestone_id=? ORDER BY t.id")?;
            let children=s.query_map([key],|r|Ok(json!({"id":r.get::<_,String>(0)?,"version":r.get::<_,i64>(1)?,"status":r.get::<_,String>(2)?})))?.collect::<std::result::Result<Vec<_>,_>>()?;
            v["tasks"]=json!(children); v
        },
        "memory" => conn.query_row("SELECT id,project_id,kind,content,revision FROM memories WHERE id=? AND state='active'",[key],|r|Ok(json!({"id":r.get::<_,String>(0)?,"projectId":r.get::<_,String>(1)?,"kind":r.get::<_,String>(2)?,"content":r.get::<_,String>(3)?,"version":r.get::<_,i64>(4)?}))).optional()?.ok_or_else(||AppError::new("NOT_FOUND","项目记忆不存在"))?,
        _ => return Err(invalid("关联类型无效")),
    };
    if value["projectId"] != project {
        return Err(AppError::new("PROJECT_SCOPE", "只能关联同项目内容"));
    }
    Ok(value)
}
fn link(conn: &Connection, project: &str, p: &Value) -> Result<Value> {
    let kind = required(p, "kind")?;
    let key = required(p, "id")?;
    let snap = snapshot(conn, project, kind, key)?;
    if snap["version"].as_i64() != Some(number(p, "version")?) {
        return Err(conflict());
    }
    Ok(json!({"kind":kind,"id":key,"version":snap["version"],"snapshot":snap}))
}
fn links(conn: &Connection, project: &str, p: &Value) -> Result<Value> {
    let rows = p["links"]
        .as_array()
        .filter(|v| v.len() <= 200)
        .ok_or_else(|| invalid("links 必须是数组，最多 200 项"))?;
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for row in rows {
        let l = link(conn, project, row)?;
        if !seen.insert(format!("{}:{}", l["kind"], l["id"])) {
            return Err(invalid("关联不能重复"));
        }
        out.push(l);
    }
    Ok(json!(out))
}
fn evidence(conn: &Connection, project: &str, p: &Value) -> Result<Value> {
    let rows = p["segmentIds"]
        .as_array()
        .filter(|v| v.len() <= 200)
        .ok_or_else(|| invalid("segmentIds 必须是数组，最多 200 项"))?;
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for row in rows {
        let key = row.as_str().ok_or_else(|| invalid("原文引用 ID 无效"))?;
        if !seen.insert(key) {
            return Err(invalid("原文引用不能重复"));
        }
        let v=conn.query_row("SELECT g.id,s.id,s.title,g.locator,g.text,g.source_version_id FROM segments g JOIN sources s ON s.id=g.source_id WHERE g.id=? AND s.project_id=? AND s.status='ready'",params![key,project],|r|Ok(json!({"segmentId":r.get::<_,String>(0)?,"sourceId":r.get::<_,String>(1)?,"sourceTitle":r.get::<_,String>(2)?,"locator":r.get::<_,String>(3)?,"text":r.get::<_,String>(4)?,"sourceVersionId":r.get::<_,String>(5)?}))).optional()?.ok_or_else(||AppError::new("EVIDENCE_SCOPE","原文依据不属于当前项目或尚未就绪"))?;
        out.push(v);
    }
    Ok(json!(out))
}
fn check_base(conn: &Connection, p: &Value, delivery: bool) -> Result<Option<Value>> {
    let key = p[if delivery {
        "deliverableId"
    } else {
        "changeId"
    }]
    .as_str()
    .filter(|v| !v.is_empty());
    if let Some(key) = key {
        let old = get(conn, key, delivery)?;
        if number(p, "baseVersion")? != old["version"].as_i64().unwrap_or(-1) {
            return Err(conflict());
        }
        if p["projectId"].is_string() && p["projectId"] != old["projectId"] {
            return Err(AppError::new("PROJECT_SCOPE", "记录不能转移项目"));
        }
        if date(p)? < old["workDate"].as_str().unwrap_or("") {
            return Err(AppError::new("WORK_DATE_ORDER", "日期不能早于最近一次记录"));
        }
        Ok(Some(old))
    } else {
        if p.get("baseVersion").is_some() && number(p, "baseVersion")? != 0 {
            return Err(conflict());
        }
        Ok(None)
    }
}
fn persist(
    conn: &Connection,
    mut value: Value,
    old: Option<&Value>,
    p: &Value,
    actor: &str,
    note: &str,
    delivery: bool,
) -> Result<Value> {
    let (t, h, fk) = table(delivery);
    let at = now();
    value["id"] = old.map(|v| v["id"].clone()).unwrap_or_else(|| json!(id()));
    value["version"] = json!(old.and_then(|v| v["version"].as_i64()).unwrap_or(0) + 1);
    value["createdAt"] = old
        .map(|v| v["createdAt"].clone())
        .unwrap_or_else(|| json!(at));
    value["updatedAt"] = json!(at);
    value["workDate"] = json!(date(p)?);
    let raw = value.to_string();
    conn.execute(&format!("INSERT INTO {t}(id,project_id,title,status,version,work_date,created_at,updated_at,data_json) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,status=excluded.status,version=excluded.version,work_date=excluded.work_date,updated_at=excluded.updated_at,data_json=excluded.data_json"),params![value["id"].as_str(),value["projectId"].as_str(),value["title"].as_str(),value["status"].as_str(),value["version"].as_i64(),value["workDate"].as_str(),value["createdAt"].as_str(),at,raw])?;
    conn.execute(&format!("INSERT INTO {h}(id,{fk},version,work_date,actor,note,snapshot_json,created_at) VALUES(?,?,?,?,?,?,?,?)"),params![id(),value["id"].as_str(),value["version"].as_i64(),date(p)?,actor,note,value.to_string(),at])?;
    detail(conn, value, delivery)
}
fn detail(conn: &Connection, mut value: Value, delivery: bool) -> Result<Value> {
    let (_, h, fk) = table(delivery);
    let mut s=conn.prepare(&format!("SELECT id,version,work_date,actor,note,snapshot_json,created_at FROM {h} WHERE {fk}=? ORDER BY version DESC"))?;
    let rows=s.query_map([value["id"].as_str().unwrap_or("")],|r|Ok(json!({"id":r.get::<_,String>(0)?,"version":r.get::<_,i64>(1)?,"date":r.get::<_,String>(2)?,"actor":r.get::<_,String>(3)?,"note":r.get::<_,String>(4)?,"snapshot":parse(r.get(5)?)?,"createdAt":r.get::<_,String>(6)?})))?.collect::<std::result::Result<Vec<_>,_>>()?;
    value["history"] = json!(rows);
    if delivery {
        let current = snapshot(
            conn,
            value["projectId"].as_str().unwrap_or(""),
            value["target"]["kind"].as_str().unwrap_or(""),
            value["target"]["id"].as_str().unwrap_or(""),
        )?;
        value["needsReReview"] =
            json!(value["status"] == "accepted" && value["acceptedTarget"] != current);
        value["targetCurrent"] = current;
    }
    Ok(value)
}
fn save_change(conn: &Connection, p: &Value) -> Result<Value> {
    let project_id = required(p, "projectId")?;
    project(conn, project_id)?;
    let old = check_base(conn, p, false)?;
    if old.as_ref().is_some_and(|v| v["status"] == "cancelled") {
        return Err(invalid("已取消变更不能修改"));
    }
    let mut value =
        json!({"projectId":project_id,"status":"draft","approval":null,"implementation":null});
    for f in [
        "title",
        "before",
        "after",
        "reason",
        "requester",
        "decisionOwner",
        "scopeImpact",
        "scheduleImpact",
        "effortImpact",
    ] {
        value[f] = json!(string(p, f, true)?);
    }
    if value["before"] == value["after"] {
        return Err(invalid("变更前后内容不能相同"));
    }
    value["links"] = links(conn, project_id, p)?;
    value["evidence"] = evidence(conn, project_id, p)?;
    let actor = string(p, "requester", true)?;
    persist(
        conn,
        value,
        old.as_ref(),
        p,
        &actor,
        if old.is_some() {
            "修订内容，原审批失效，需重新提交"
        } else {
            "创建变更草案"
        },
        false,
    )
}
fn ensure_links_current(conn: &Connection, value: &Value) -> Result<()> {
    for l in value["links"].as_array().into_iter().flatten() {
        let current = snapshot(
            conn,
            value["projectId"].as_str().unwrap_or(""),
            l["kind"].as_str().unwrap_or(""),
            l["id"].as_str().unwrap_or(""),
        )?;
        if l["snapshot"] != current {
            return Err(AppError::new(
                "LINK_STALE",
                "关联内容已更新，请编辑并重新保存草案后提交",
            ));
        }
    }
    Ok(())
}
fn transition_change(conn: &Connection, p: &Value) -> Result<Value> {
    let old = check_base(conn, p, false)?.ok_or_else(|| invalid("请选择变更"))?;
    let from = old["status"].as_str().unwrap_or("");
    let to = required(p, "status")?;
    let allowed = matches!(
        (from, to),
        ("draft", "submitted")
            | ("submitted", "approved")
            | ("submitted", "rejected")
            | ("submitted", "draft")
            | ("approved", "implemented")
            | ("draft" | "submitted" | "approved" | "rejected", "cancelled")
    );
    if !allowed {
        return Err(AppError::new(
            "INVALID_TRANSITION",
            "变更状态流转无效；修订后需重新提交审批",
        ));
    }
    let actor = string(p, "actor", true)?;
    let note = string(p, "note", true)?;
    let mut value = old.clone();
    value.as_object_mut().unwrap().remove("history");
    if matches!(to, "submitted" | "approved") {
        ensure_links_current(conn, &value)?;
    }
    if matches!(to, "approved" | "rejected") {
        if value["decisionOwner"] != actor {
            return Err(invalid("请由记录的决策人确认审批，并填写本人姓名"));
        }
        value["approval"] = json!({"actor":actor,"date":date(p)?,"note":note,"result":to,"contentVersion":old["version"]});
    }
    if to == "implemented" {
        let mut actual = Vec::new();
        for l in value["links"].as_array().into_iter().flatten() {
            let snap = snapshot(
                conn,
                required(&value, "projectId")?,
                required(l, "kind")?,
                required(l, "id")?,
            )?;
            actual.push(
                json!({"kind":l["kind"],"id":l["id"],"version":snap["version"],"snapshot":snap}),
            );
        }
        value["implementation"] = json!({"actor":actor,"date":date(p)?,"note":note,"links":actual});
    }
    value["status"] = json!(to);
    persist(conn, value, Some(&old), p, &actor, &note, false)
}
fn save_deliverable(conn: &Connection, p: &Value) -> Result<Value> {
    let project_id = required(p, "projectId")?;
    project(conn, project_id)?;
    let old = check_base(conn, p, true)?;
    if old.as_ref().is_some_and(|v| v["status"] == "cancelled") {
        return Err(invalid("已取消验收不能修改"));
    }
    if !matches!(p["target"]["kind"].as_str(), Some("task" | "milestone")) {
        return Err(invalid("交付物必须关联一个任务或里程碑"));
    }
    let target = link(conn, project_id, &p["target"])?;
    let rows = p["criteria"]
        .as_array()
        .filter(|v| !v.is_empty() && v.len() <= 100)
        .ok_or_else(|| invalid("请填写 1 至 100 条验收标准"))?;
    let mut criteria = Vec::new();
    let mut seen = HashSet::new();
    for row in rows {
        let key = row["id"]
            .as_str()
            .filter(|v| !v.trim().is_empty())
            .map(str::to_owned)
            .unwrap_or_else(id);
        if !seen.insert(key.clone()) {
            return Err(invalid("验收标准 ID 不能重复"));
        }
        if !matches!(row["status"].as_str(), Some("pending" | "pass" | "fail")) {
            return Err(invalid("验收标准状态无效"));
        }
        let result = required(row, "status")?;
        let proof = string(row, "evidence", result != "pending")?;
        criteria.push(json!({"id":key,"title":string(row,"title",true)?,"status":result,"evidence":proof,"note":string(row,"note",false)?}));
    }
    let value = json!({"projectId":project_id,"title":string(p,"title",true)?,"owner":string(p,"owner",true)?,"target":target,"criteria":criteria,"links":links(conn,project_id,p)?,"evidence":evidence(conn,project_id,p)?,"status":"draft","review":null,"acceptedTarget":null});
    let actor = string(p, "owner", true)?;
    persist(
        conn,
        value,
        old.as_ref(),
        p,
        &actor,
        if old.is_some() {
            "修订验收内容，需重新复核"
        } else {
            "创建验收草案"
        },
        true,
    )
}
fn complete(target: &Value, kind: &str) -> bool {
    if kind == "task" {
        target["status"] == "done" && target["progress"] == 100
    } else {
        target["status"] == "completed"
            && target["tasks"]
                .as_array()
                .is_some_and(|rows| rows.iter().all(|r| r["status"] == "done"))
    }
}
// Review dates are local work dates, so compare against the exact execution
// versions being accepted rather than against the wall clock or a due date.
fn ensure_completion_recorded_by(
    conn: &Connection,
    project_id: &str,
    target: &Value,
    kind: &str,
    review_date: &str,
) -> Result<()> {
    tasks::valid_date(review_date)?;
    let targets = if kind == "task" {
        vec![target.clone()]
    } else {
        target["tasks"]
            .as_array()
            .ok_or_else(|| invalid("里程碑任务快照无效"))?
            .clone()
    };
    for task in targets {
        let execution_date = conn
            .query_row(
                "SELECT work_date FROM task_events WHERE task_id=? AND project_id=? AND version=?",
                params![task["id"].as_str(), project_id, task["version"].as_i64()],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .ok_or_else(|| {
                AppError::new(
                    "ACCEPTANCE_DATE_ORDER",
                    "交付目标的执行版本无法回查，不能确认验收",
                )
            })?;
        tasks::valid_date(&execution_date)?;
        if execution_date.as_str() > review_date {
            return Err(AppError::new(
                "ACCEPTANCE_DATE_ORDER",
                format!("验收日期不能早于交付目标执行版本的记录日期 {execution_date}"),
            ));
        }
    }
    Ok(())
}
fn review(conn: &Connection, p: &Value) -> Result<Value> {
    let old = check_base(conn, p, true)?.ok_or_else(|| invalid("请选择交付物"))?;
    let to = required(p, "status")?;
    if !matches!(to, "in_review" | "accepted" | "rejected")
        || old["status"] == "cancelled"
        || (old["status"] == to && to != "in_review")
    {
        return Err(AppError::new("INVALID_TRANSITION", "验收状态流转无效"));
    }
    if matches!(to, "accepted" | "rejected") && old["status"] != "in_review" {
        return Err(invalid("请先进入验收复核，再记录验收结果"));
    }
    let actor = string(p, "reviewer", true)?;
    let note = string(p, "note", true)?;
    let remediation = string(p, "remediation", to == "rejected")?;
    let current = snapshot(
        conn,
        old["projectId"].as_str().unwrap_or(""),
        old["target"]["kind"].as_str().unwrap_or(""),
        old["target"]["id"].as_str().unwrap_or(""),
    )?;
    if old["target"]["snapshot"] != current {
        return Err(AppError::new(
            "LINK_STALE",
            "交付目标版本已更新，请编辑验收草案并确认当前目标后再复核",
        ));
    }
    ensure_links_current(conn, &old)?;
    if to == "accepted"
        && (!complete(&current, old["target"]["kind"].as_str().unwrap_or(""))
            || !old["criteria"].as_array().is_some_and(|rows| {
                !rows.is_empty()
                    && rows.iter().all(|r| {
                        r["status"] == "pass"
                            && r["evidence"].as_str().is_some_and(|s| !s.trim().is_empty())
                    })
            }))
    {
        return Err(AppError::new(
            "ACCEPTANCE_INCOMPLETE",
            "交付目标实际完成且所有标准通过并留有证据后才能验收通过",
        ));
    }
    if to == "accepted" {
        ensure_completion_recorded_by(
            conn,
            required(&old, "projectId")?,
            &current,
            required(&old["target"], "kind")?,
            date(p)?,
        )?;
    }
    let mut value = old.clone();
    for k in ["history", "targetCurrent", "needsReReview"] {
        value.as_object_mut().unwrap().remove(k);
    }
    value["status"] = json!(to);
    value["review"] =
        json!({"reviewer":actor,"date":date(p)?,"note":note,"remediation":remediation,"result":to});
    value["acceptedTarget"] = if to == "accepted" {
        current
    } else {
        Value::Null
    };
    persist(conn, value, Some(&old), p, &actor, &note, true)
}
fn discard(conn: &Connection, p: &Value, delivery: bool) -> Result<Value> {
    let old = check_base(conn, p, delivery)?.ok_or_else(|| invalid("请选择记录"))?;
    if old["status"] != "draft" {
        return Err(invalid("仅草案可移除；其余记录请按状态流转处理"));
    }
    let mut value = old.clone();
    value.as_object_mut().unwrap().remove("history");
    value["status"] = json!("cancelled");
    persist(
        conn,
        value,
        Some(&old),
        p,
        "用户",
        "移除草案（保留审计历史）",
        delivery,
    )
}
pub(crate) fn workspace(conn: &Connection, p: &Value) -> Result<Value> {
    let selected = p["projectId"].as_str().filter(|s| !s.is_empty());
    if let Some(k) = selected {
        project(conn, k)?;
    }
    let d = date(p)?;
    let mut output = json!({"projectId":selected,"date":d});
    for (delivery, key) in [(false, "changes"), (true, "deliverables")] {
        let (t, _, _) = table(delivery);
        let mut stmt=conn.prepare(&format!("SELECT data_json FROM {t} WHERE (? IS NULL OR project_id=?) ORDER BY updated_at DESC,id"))?;
        let rows = stmt
            .query_map(params![selected, selected], |r| parse(r.get(0)?))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut out = Vec::new();
        for row in rows {
            out.push(detail(conn, row, delivery)?);
        }
        output[key] = json!(out);
    }
    let mut s=conn.prepare("SELECT id,project_id,title,status,version FROM milestones WHERE (? IS NULL OR project_id=?) ORDER BY title,id")?;
    output["milestones"]=json!(s.query_map(params![selected,selected],|r|Ok(json!({"id":r.get::<_,String>(0)?,"projectId":r.get::<_,String>(1)?,"title":r.get::<_,String>(2)?,"status":r.get::<_,String>(3)?,"version":r.get::<_,i64>(4)?})))?.collect::<std::result::Result<Vec<_>,_>>()?);
    Ok(output)
}
pub(crate) fn dispatch(conn: &mut Connection, command: &str, p: &Value) -> Result<Value> {
    if command == "get_change_acceptance" {
        return workspace(conn, p);
    }
    let tx = conn.transaction()?;
    let result = match command {
        "save_change_request" => save_change(&tx, p),
        "transition_change_request" => transition_change(&tx, p),
        "save_deliverable" => save_deliverable(&tx, p),
        "review_deliverable" => review(&tx, p),
        "delete_change_request" => discard(&tx, p, false),
        "delete_deliverable" => discard(&tx, p, true),
        _ => Err(AppError::new("UNKNOWN_COMMAND", "未知变更验收命令")),
    }?;
    tx.commit()?;
    Ok(result)
}

pub(crate) fn validate_backup(conn: &Connection) -> Result<()> {
    for delivery in [false, true] {
        let (t, h, fk) = table(delivery);
        let mut s = conn.prepare(&format!(
            "SELECT id,project_id,title,status,version,work_date,data_json FROM {t}"
        ))?;
        let rows = s
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, i64>(4)?,
                    r.get::<_, String>(5)?,
                    parse(r.get(6)?)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        for (key, project_id, title, status, version, work_date, value) in rows {
            project(conn, &project_id)?;
            tasks::valid_date(&work_date)?;
            if value["id"] != key
                || value["projectId"] != project_id
                || value["title"] != title
                || value["status"] != status
                || value["version"].as_i64() != Some(version)
                || value["workDate"] != work_date
                || version < 1
            {
                return Err(invalid("变更验收记录快照无效"));
            }
            let valid = if delivery {
                matches!(
                    status.as_str(),
                    "draft" | "in_review" | "accepted" | "rejected" | "cancelled"
                )
            } else {
                matches!(
                    status.as_str(),
                    "draft" | "submitted" | "approved" | "rejected" | "implemented" | "cancelled"
                )
            };
            if !valid {
                return Err(invalid("变更验收状态无效"));
            }
            let mut history = conn.prepare(&format!(
                "SELECT version,work_date,snapshot_json FROM {h} WHERE {fk}=? ORDER BY version"
            ))?;
            let events = history
                .query_map([&key], |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, String>(1)?,
                        parse(r.get(2)?)?,
                    ))
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            if events.len() != version as usize {
                return Err(invalid("变更验收历史版本不连续"));
            }
            let mut last_date = String::new();
            for (i, (n, d, v)) in events.iter().enumerate() {
                tasks::valid_date(d)?;
                if *n != i as i64 + 1
                    || d < &last_date
                    || v["id"] != key
                    || v["projectId"] != project_id
                    || v["version"].as_i64() != Some(*n)
                    || v["workDate"] != *d
                {
                    return Err(invalid("变更验收历史快照无效"));
                }
                last_date = d.clone();
                validate_snapshot(conn, v, delivery)?;
                validate_history_transition(
                    i.checked_sub(1).map(|index| &events[index].2),
                    v,
                    delivery,
                )?;
            }
            if events.last().map(|e| &e.2) != Some(&value) {
                return Err(invalid("变更验收最新历史与记录不符"));
            }
            validate_snapshot(conn, &value, delivery)?;
        }
    }
    Ok(())
}
fn history_content(value: &Value, delivery: bool) -> Value {
    let mut content = value.clone();
    if let Some(fields) = content.as_object_mut() {
        for key in ["status", "version", "workDate", "updatedAt"] {
            fields.remove(key);
        }
        for key in if delivery {
            ["review", "acceptedTarget"]
        } else {
            ["approval", "implementation"]
        } {
            fields.remove(key);
        }
    }
    content
}
fn validate_history_transition(
    before: Option<&Value>,
    after: &Value,
    delivery: bool,
) -> Result<()> {
    let to = required(after, "status")?;
    let reset_fields = if delivery {
        ["review", "acceptedTarget"]
    } else {
        ["approval", "implementation"]
    };
    if to == "draft" {
        if before.is_some_and(|value| value["status"] == "cancelled")
            || reset_fields.iter().any(|key| !after[*key].is_null())
        {
            return Err(invalid("修订草案必须清除原审批或验收结论"));
        }
        return Ok(());
    }
    let before = before.ok_or_else(|| invalid("首个版本必须是草案"))?;
    if history_content(before, delivery) != history_content(after, delivery) {
        return Err(invalid(
            "审批、实施或验收时内容必须与前一版本一致；内容变更需重新保存草案",
        ));
    }
    let from = required(before, "status")?;
    if delivery {
        let allowed = matches!(
            (from, to),
            ("draft" | "in_review" | "accepted" | "rejected", "in_review")
                | ("in_review", "accepted" | "rejected")
                | ("draft", "cancelled")
        );
        if !allowed {
            return Err(invalid("验收历史状态流转无效"));
        }
        if to == "cancelled" {
            if after["review"] != before["review"]
                || after["acceptedTarget"] != before["acceptedTarget"]
            {
                return Err(invalid("移除草案时不能改写验收记录"));
            }
        } else {
            let review = &after["review"];
            string(review, "reviewer", true)?;
            string(review, "note", true)?;
            string(review, "remediation", to == "rejected")?;
            if review["result"] != to
                || review["date"] != after["workDate"]
                || (to == "accepted" && after["acceptedTarget"] != before["target"]["snapshot"])
                || (to != "accepted" && !after["acceptedTarget"].is_null())
            {
                return Err(invalid("验收结论与待复核版本或日期不符"));
            }
        }
    } else {
        let allowed = matches!(
            (from, to),
            ("draft", "submitted")
                | ("submitted", "approved" | "rejected")
                | ("approved", "implemented")
                | ("draft" | "submitted" | "approved" | "rejected", "cancelled")
        );
        if !allowed {
            return Err(invalid("变更历史状态流转无效"));
        }
        if matches!(to, "approved" | "rejected") {
            let approval = &after["approval"];
            if approval["result"] != to
                || approval["contentVersion"] != before["version"]
                || approval["date"] != after["workDate"]
                || approval["actor"] != before["decisionOwner"]
                || after["implementation"] != before["implementation"]
            {
                return Err(invalid("审批结论必须对应上一待审批版本及当次决策人、日期"));
            }
        } else if to == "implemented" {
            if after["approval"] != before["approval"]
                || after["implementation"]["date"] != after["workDate"]
            {
                return Err(invalid("实施不能改变审批结论"));
            }
        } else if after["approval"] != before["approval"]
            || after["implementation"] != before["implementation"]
        {
            return Err(invalid("提交或取消不能改写审批与实施记录"));
        }
    }
    Ok(())
}
fn validate_snapshot(conn: &Connection, v: &Value, delivery: bool) -> Result<()> {
    let project_id = required(v, "projectId")?;
    string(v, "title", true)?;
    tasks::valid_date(required(v, "workDate")?)?;
    let valid_status = if delivery {
        matches!(
            v["status"].as_str(),
            Some("draft" | "in_review" | "accepted" | "rejected" | "cancelled")
        )
    } else {
        matches!(
            v["status"].as_str(),
            Some("draft" | "submitted" | "approved" | "rejected" | "implemented" | "cancelled")
        )
    };
    if !valid_status {
        return Err(invalid("历史状态无效"));
    }
    if delivery {
        string(v, "owner", true)?;
        if !matches!(v["target"]["kind"].as_str(), Some("task" | "milestone")) {
            return Err(invalid("验收目标类型无效"));
        }
        let criteria = v["criteria"]
            .as_array()
            .filter(|rows| !rows.is_empty() && rows.len() <= 100)
            .ok_or_else(|| invalid("验收标准无效"))?;
        let mut ids = HashSet::new();
        for criterion in criteria {
            if !ids.insert(string(criterion, "id", true)?)
                || !matches!(
                    criterion["status"].as_str(),
                    Some("pending" | "pass" | "fail")
                )
            {
                return Err(invalid("验收标准状态或 ID 无效"));
            }
            string(criterion, "title", true)?;
            string(criterion, "evidence", criterion["status"] != "pending")?;
            string(criterion, "note", false)?;
        }
    } else {
        for f in [
            "before",
            "after",
            "reason",
            "requester",
            "decisionOwner",
            "scopeImpact",
            "scheduleImpact",
            "effortImpact",
        ] {
            string(v, f, true)?;
        }
        if v["before"] == v["after"] {
            return Err(invalid("变更前后内容不能相同"));
        }
    }
    let mut refs = v["links"]
        .as_array()
        .ok_or_else(|| invalid("关联快照无效"))?
        .clone();
    if delivery {
        refs.push(v["target"].clone());
    }
    if v["status"] == "implemented" {
        string(&v["implementation"], "actor", true)?;
        string(&v["implementation"], "note", true)?;
        tasks::valid_date(required(&v["implementation"], "date")?)?;
        refs.extend(
            v["implementation"]["links"]
                .as_array()
                .ok_or_else(|| invalid("实施关联快照无效"))?
                .clone(),
        );
    }
    for l in refs {
        let current = snapshot(conn, project_id, required(&l, "kind")?, required(&l, "id")?)?;
        if l["snapshot"]["projectId"] != project_id
            || l["snapshot"]["id"] != l["id"]
            || l["snapshot"]["version"] != l["version"]
            || number(&l, "version")? < 1
            || number(&l, "version")? > number(&current, "version")?
        {
            return Err(invalid("关联版本快照无效"));
        }
        if l["kind"] == "memory" {
            let content = conn.query_row("SELECT r.content FROM revisions r JOIN memories m ON m.id=r.memory_id WHERE m.id=? AND m.project_id=? AND r.number=?",params![l["id"].as_str(),project_id,l["version"].as_i64()],|r|r.get::<_,String>(0)).optional()?.ok_or_else(||invalid("关联记忆历史版本无法回查"))?;
            if l["snapshot"]["content"] != content {
                return Err(invalid("记忆版本内容与原记录不符"));
            }
        }
        if l["kind"] == "task" {
            let original = conn.query_row("SELECT after_json FROM task_events WHERE task_id=? AND project_id=? AND version=?",params![l["id"].as_str(),project_id,l["version"].as_i64()],|r|parse(r.get(0)?)).optional()?.ok_or_else(||invalid("关联任务历史版本无法回查"))?;
            if l["snapshot"] != original {
                return Err(invalid("任务版本快照与原记录不符"));
            }
        }
        if l["kind"] == "milestone" {
            for child in l["snapshot"]["tasks"]
                .as_array()
                .ok_or_else(|| invalid("里程碑任务快照无效"))?
            {
                let original = conn.query_row("SELECT after_json FROM task_events WHERE task_id=? AND project_id=? AND version=?",params![child["id"].as_str(),project_id,child["version"].as_i64()],|r|parse(r.get(0)?)).optional()?.ok_or_else(||invalid("里程碑关联任务历史无法回查"))?;
                if child["status"] != original["status"] {
                    return Err(invalid("里程碑任务版本快照不符"));
                }
            }
        }
    }
    for e in v["evidence"]
        .as_array()
        .ok_or_else(|| invalid("原文证据无效"))?
    {
        let valid=conn.query_row("SELECT EXISTS(SELECT 1 FROM segments g JOIN sources s ON s.id=g.source_id WHERE g.id=? AND s.id=? AND s.project_id=? AND g.source_version_id=? AND g.text=?)",params![e["segmentId"].as_str(),e["sourceId"].as_str(),project_id,e["sourceVersionId"].as_str(),e["text"].as_str()],|r|r.get::<_,bool>(0))?;
        if !valid {
            return Err(invalid("原文依据快照无法回查"));
        }
    }
    if delivery && v["status"] == "accepted" {
        if v["review"]["result"] != "accepted"
            || v["acceptedTarget"] != v["target"]["snapshot"]
            || !complete(
                &v["acceptedTarget"],
                v["target"]["kind"].as_str().unwrap_or(""),
            )
            || !v["criteria"].as_array().is_some_and(|rows| {
                !rows.is_empty()
                    && rows.iter().all(|r| {
                        r["status"] == "pass"
                            && r["evidence"].as_str().is_some_and(|s| !s.trim().is_empty())
                    })
            })
            || v["review"]["reviewer"]
                .as_str()
                .is_none_or(|s| s.trim().is_empty())
        {
            return Err(invalid("验收通过条件无效"));
        }
        string(&v["review"], "note", true)?;
        tasks::valid_date(required(&v["review"], "date")?)?;
        ensure_completion_recorded_by(
            conn,
            project_id,
            &v["acceptedTarget"],
            required(&v["target"], "kind")?,
            required(&v["review"], "date")?,
        )?;
    }
    if !delivery
        && matches!(v["status"].as_str(), Some("approved" | "implemented"))
        && (v["approval"]["result"] != "approved" || v["approval"]["actor"] != v["decisionOwner"])
    {
        return Err(invalid("变更审批记录无效"));
    }
    if !delivery
        && matches!(
            v["status"].as_str(),
            Some("approved" | "implemented" | "rejected")
        )
    {
        if v["approval"]["actor"] != v["decisionOwner"] {
            return Err(invalid("审批人不匹配"));
        }
        string(&v["approval"], "actor", true)?;
        string(&v["approval"], "note", true)?;
        tasks::valid_date(required(&v["approval"], "date")?)?;
    }
    Ok(())
}
