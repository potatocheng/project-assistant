//! Read-only connections between management records, oversight, and personal QA.
use crate::{hash, required, tasks, Result};
use rusqlite::Connection;
use serde_json::{json, Value};

pub(crate) fn revision(conn: &Connection) -> Result<String> {
    let mut records = Vec::new();
    for table in [
        "governance_items",
        "change_requests",
        "deliverables",
        "coordination_reports",
        "coordination_meetings",
        "coordination_actions",
    ] {
        let mut statement = conn.prepare(&format!("SELECT id,version FROM {table} ORDER BY id"))?;
        let values = statement
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        records.push(json!({"table":table,"versions":values}));
    }
    Ok(hash(json!(records).to_string().as_bytes()))
}

pub(crate) fn attention(conn: &Connection, p: &Value) -> Result<Value> {
    let date = required(p, "date")?;
    tasks::valid_date(date)?;
    let governance = crate::governance::workspace(conn, p)?;
    let changes = crate::change_control::workspace(conn, p)?;
    let mut items = Vec::new();
    for item in governance["items"].as_array().into_iter().flatten() {
        if item["status"] == "closed" {
            continue;
        }
        let mut reasons = item["attention"].as_array().cloned().unwrap_or_default();
        if item["kind"] == "decision" {
            reasons.push(json!({"kind":"decision_pending","label":"等待拍板"}));
        }
        if item["severity"] == "high" {
            reasons.push(json!({"kind":"high_severity","label":"高影响事项尚未关闭"}));
        }
        if !reasons.is_empty() {
            items.push(json!({"kind":"governance","id":item["id"],"projectId":item["projectId"],"title":item["title"],"version":item["version"],"reasons":reasons}));
        }
    }
    for item in changes["changes"].as_array().into_iter().flatten() {
        if item["status"] == "submitted" {
            items.push(json!({"kind":"change","id":item["id"],"projectId":item["projectId"],"title":item["title"],"version":item["version"],"reasons":[{"kind":"approval_pending","label":"变更等待审批"}]}));
        }
    }
    for item in changes["deliverables"].as_array().into_iter().flatten() {
        let reason = if item["needsReReview"] == true {
            Some("已验收交付发生变化，需要复核")
        } else if item["status"] == "rejected" {
            Some("验收未通过，等待整改")
        } else if item["status"] == "in_review" {
            Some("交付等待验收")
        } else {
            None
        };
        if let Some(reason) = reason {
            items.push(json!({"kind":"deliverable","id":item["id"],"projectId":item["projectId"],"title":item["title"],"version":item["version"],"reasons":[{"kind":"acceptance_attention","label":reason}]}));
        }
    }
    let mut visible = json!({"items":items});
    crate::daily_use::filter_context(conn, &mut visible)?;
    let mut items = visible["items"].as_array().cloned().unwrap_or_default();
    items.sort_by(|a, b| {
        a["kind"]
            .as_str()
            .cmp(&b["kind"].as_str())
            .then_with(|| a["id"].as_str().cmp(&b["id"].as_str()))
    });
    Ok(json!({"date":date,"count":items.len(),"items":items}))
}

fn short(value: &Value, key: &str) -> String {
    value[key]
        .as_str()
        .unwrap_or("")
        .chars()
        .take(1200)
        .collect()
}
fn state_label(value: &Value) -> &str {
    match value["status"].as_str().unwrap_or("") {
        "open" => "待处理",
        "in_progress" => "处理中",
        "escalated" => "已升级",
        "closed" => "已关闭",
        "draft" => "草稿",
        "submitted" => "待审批",
        "approved" => "已批准",
        "rejected" => "未通过",
        "implemented" => "已实施",
        "cancelled" => "已取消",
        "in_review" => "待验收",
        "accepted" => "验收通过",
        other => other,
    }
}
fn confirmation_text(value: &Value, actor_key: &str) -> String {
    if value.is_null() {
        return "尚未记录".to_owned();
    }
    let mut summary = format!(
        "{}，{}，说明：{}",
        short(value, actor_key),
        short(value, "date"),
        short(value, "note")
    );
    let remediation = short(value, "remediation");
    if !remediation.is_empty() {
        summary.push_str(&format!("；整改要求：{remediation}"));
    }
    summary
}
fn citation(item: &Value, kind: &str, content: String) -> Value {
    let mut reference = json!({"id":format!("{}:{}",kind,item["id"].as_str().unwrap_or("")),"kind":kind,"projectId":item["projectId"],"title":item["title"],"updatedAt":item["updatedAt"],"content":content,"managementId":item["id"],"record":{"id":item["id"],"projectId":item["projectId"],"kind":item["kind"],"status":item["status"],"version":item["version"],"needsReReview":item["needsReReview"],"attention":item["attention"]}});
    if let Some(link) = item["links"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|l| l["kind"] == "task")
    {
        reference["taskId"] = link["id"].clone();
    }
    if item["target"]["kind"] == "task" {
        reference["taskId"] = item["target"]["id"].clone();
    }
    if let Some(evidence) = item["evidence"].as_array() {
        reference["evidence"] = json!(evidence
            .iter()
            .take(3)
            .map(|e| {
                let mut e = e.clone();
                e["text"] = json!(short(&e, "text"));
                e
            })
            .collect::<Vec<_>>());
    }
    reference
}

pub(crate) fn qa_records(conn: &Connection, p: &Value) -> Result<Vec<Value>> {
    let governance = crate::governance::workspace(conn, p)?;
    let changes = crate::change_control::workspace(conn, p)?;
    let mut records = Vec::new();
    for item in governance["items"].as_array().into_iter().flatten() {
        let kind = match item["kind"].as_str() {
            Some("risk") => "风险",
            Some("decision") if item["status"] == "closed" => "已关闭决策",
            Some("decision") => "待决策事项",
            _ => "问题",
        };
        let content=format!("{}：{}；状态：{}；负责人：{}；影响：{}；处理方案：{}；处理期限：{}；复查日期：{}；升级对象：{}；拍板人：{}；结论：{}；处理结果：{}；关闭原因：{}。{}",kind,short(item,"description"),state_label(item),short(item,"owner"),short(item,"impact"),short(item,"responsePlan"),short(item,"dueDate"),short(item,"reviewDate"),short(item,"escalationTo"),short(item,"decisionMaker"),short(item,"conclusion"),short(item,"resolution"),short(item,"closureReason"),if item["attention"].as_array().is_some_and(|a|!a.is_empty()){"存在待复核或到期关注事项"}else{""});
        records.push(citation(item, "governance", content));
    }
    for item in changes["changes"].as_array().into_iter().flatten() {
        let content=format!("需求变更：{}；状态：{}；变更前：{}；变更后：{}；理由：{}；提出人：{}；决策人：{}；范围影响：{}；排期影响：{}；工作量影响：{}；审批记录：{}；实施记录：{}",short(item,"title"),state_label(item),short(item,"before"),short(item,"after"),short(item,"reason"),short(item,"requester"),short(item,"decisionOwner"),short(item,"scopeImpact"),short(item,"scheduleImpact"),short(item,"effortImpact"),confirmation_text(&item["approval"],"actor"),confirmation_text(&item["implementation"],"actor"));
        records.push(citation(item, "change", content));
    }
    for item in changes["deliverables"].as_array().into_iter().flatten() {
        let criteria = item["criteria"]
            .as_array()
            .into_iter()
            .flatten()
            .take(20)
            .map(|c| {
                format!(
                    "{}：{}；证据：{}；说明：{}",
                    short(c, "title"),
                    match c["status"].as_str() {
                        Some("pass") => "通过",
                        Some("fail") => "未通过",
                        _ => "待核验",
                    },
                    short(c, "evidence"),
                    short(c, "note")
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        let content = format!(
            "交付验收：{}；状态：{}{}；负责人：{}；标准与证据：\n{}\n验收记录：{}",
            short(item, "title"),
            state_label(item),
            if item["needsReReview"] == true {
                "（目标已变化，需要重新复核，不能沿用旧验收结论）"
            } else {
                ""
            },
            short(item, "owner"),
            criteria,
            confirmation_text(&item["review"], "reviewer")
        );
        records.push(citation(item, "deliverable", content));
    }
    let scope = p["projectId"].as_str();
    let question = p["question"].as_str().unwrap_or("");
    let mut stmt=conn.prepare("SELECT m.data_json FROM coordination_meetings m WHERE (?1 IS NULL OR m.project_id=?1) ORDER BY CASE WHEN m.title<>'' AND instr(lower(?2),lower(m.title))>0 THEN 0 ELSE 1 END,m.date DESC,m.id LIMIT 81")?;
    let meetings = stmt
        .query_map(rusqlite::params![scope, question], |r| {
            let raw: String = r.get(0)?;
            serde_json::from_str::<Value>(&raw).map_err(|e| {
                rusqlite::Error::FromSqlConversionFailure(
                    0,
                    rusqlite::types::Type::Text,
                    Box::new(e),
                )
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    for item in meetings {
        let content = format!(
            "会议日期：{}；目标：{}；参会人：{}；议程：{}；会前资料：{}；纪要：{}；决策记录：{}",
            short(&item, "date"),
            short(&item, "objective"),
            short(&item, "attendees"),
            short(&item, "agenda"),
            short(&item, "briefing"),
            short(&item, "minutes"),
            short(&item, "decisions")
        );
        records.push(citation(&item, "meeting", content));
    }
    let mut stmt=conn.prepare("SELECT json_object('id',a.id,'projectId',a.project_id,'title',a.title,'meetingId',a.meeting_id,'meetingTitle',m.title,'meetingDate',m.date,'owner',CASE WHEN a.task_id IS NULL THEN a.owner ELSE t.assignee END,'dueDate',CASE WHEN a.task_id IS NULL THEN a.due_date ELSE t.due_date END,'originalOwner',a.owner,'originalDueDate',a.due_date,'status',a.status,'taskId',a.task_id,'version',a.version,'taskVersion',t.version,'progress',t.progress,'completionState',CASE WHEN a.status='dismissed' THEN 'dismissed' WHEN a.task_id IS NULL THEN 'pending_confirmation' ELSE t.status END,'updatedAt',max(a.updated_at,coalesce(t.updated_at,a.updated_at))) FROM coordination_actions a JOIN coordination_meetings m ON m.id=a.meeting_id AND m.project_id=a.project_id LEFT JOIN tasks t ON t.id=a.task_id AND t.project_id=a.project_id WHERE (?1 IS NULL OR a.project_id=?1) ORDER BY CASE WHEN instr(lower(?2),lower(m.title))>0 OR instr(lower(?2),lower(a.title))>0 THEN 0 ELSE 1 END,a.updated_at DESC,a.id LIMIT 161")?;
    let actions = stmt
        .query_map(rusqlite::params![scope, question], |r| {
            let raw: String = r.get(0)?;
            serde_json::from_str::<Value>(&raw).map_err(|e| {
                rusqlite::Error::FromSqlConversionFailure(
                    0,
                    rusqlite::types::Type::Text,
                    Box::new(e),
                )
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    for item in actions {
        let completion = match item["completionState"].as_str() {
            Some("done") => "已完成",
            Some("dismissed") => "已忽略",
            Some("pending_confirmation") => "待确认，尚未创建任务",
            Some("blocked") => "任务阻塞",
            Some("in_progress") => "任务进行中",
            Some("cancelled") => "关联任务已取消，需核实交付",
            _ => "任务待办",
        };
        let content = format!(
            "会议「{}」（{}）行动项：{}；当前负责人：{}；当前截止：{}；当前状态：{}{}",
            short(&item, "meetingTitle"),
            short(&item, "meetingDate"),
            short(&item, "title"),
            item["owner"]
                .as_str()
                .filter(|s| !s.is_empty())
                .unwrap_or("未设置"),
            item["dueDate"].as_str().unwrap_or("未设置"),
            completion,
            if item["taskId"].is_string() {
                format!(
                    "；会议原约定负责人：{}；原约定截止：{}",
                    short(&item, "originalOwner"),
                    short(&item, "originalDueDate")
                )
            } else {
                String::new()
            }
        );
        let mut reference = citation(&item, "meeting_action", content);
        reference["managementId"] = item["meetingId"].clone();
        reference["record"]["completionState"] = item["completionState"].clone();
        reference["record"]["taskVersion"] = item["taskVersion"].clone();
        for field in ["owner", "dueDate", "originalOwner", "originalDueDate"] {
            reference["record"][field] = item[field].clone();
        }
        reference["taskId"] = item["taskId"].clone();
        records.push(reference);
    }
    let mut stmt=conn.prepare("SELECT r.id,r.project_id,r.title,r.version,r.start_date,r.end_date,r.updated_at,v.content FROM coordination_reports r JOIN coordination_report_versions v ON v.report_id=r.id AND v.version=r.version WHERE (?1 IS NULL OR r.project_id=?1) ORDER BY r.end_date DESC,r.id LIMIT 31")?;
    let reports=stmt.query_map([scope],|r|Ok(json!({"id":r.get::<_,String>(0)?,"projectId":r.get::<_,Option<String>>(1)?,"title":r.get::<_,String>(2)?,"version":r.get::<_,i64>(3)?,"startDate":r.get::<_,String>(4)?,"endDate":r.get::<_,String>(5)?,"updatedAt":r.get::<_,String>(6)?,"content":r.get::<_,String>(7)?})))?.collect::<std::result::Result<Vec<_>,_>>()?;
    for item in reports {
        records.push(citation(
            &item,
            "weekly_report",
            format!(
                "已保存周报历史快照（{} 至 {}，v{}）：\n{}",
                short(&item, "startDate"),
                short(&item, "endDate"),
                item["version"],
                short(&item, "content")
            ),
        ));
    }
    Ok(records)
}
