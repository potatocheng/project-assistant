use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use project_assistant_core::{Engine, Request};
use serde_json::{json, Value};

const DAY: &str = "2026-10-19";
fn call(e: &Engine, command: &str, payload: Value) -> Value {
    e.execute(Request {
        command: command.into(),
        payload,
    })
    .unwrap_or_else(|err| panic!("{command}: {err}"))
}
fn task(e: &Engine, p: &Value) -> Value {
    call(
        e,
        "create_task",
        json!({"projectId":p["id"],"title":"接口交付","description":"接口与审计记录","category":"action","assignee":"研发负责人","priority":"high","status":"done","progress":100,"dueDate":DAY,"plannedDate":null,"workDate":DAY,"clientRequestId":uuid::Uuid::new_v4().to_string()}),
    )
}

#[test]
fn p1_records_connect_oversight_attention_qa_and_frozen_reports_and_restore_together() {
    let dir = tempfile::tempdir().unwrap();
    let e = Engine::open(dir.path()).unwrap();
    let p = call(&e, "create_project", json!({"name":"端到端交付"}));
    let t = task(&e, &p);
    let decision = call(
        &e,
        "save_governance_item",
        json!({"projectId":p["id"],"kind":"decision","title":"是否延期上线","description":"需要确定上线窗口","owner":"项目经理","severity":"high","impact":"影响发布安排","responsePlan":"评估验收结果后决策","dueDate":DAY,"reviewDate":DAY,"escalationTo":"","status":"open","decisionMaker":"","conclusion":"","resolution":"","closureReason":"","links":[],"evidenceIds":[],"workDate":DAY,"note":"登记待拍板事项"}),
    );
    let c = call(
        &e,
        "save_change_request",
        json!({"projectId":p["id"],"baseVersion":0,"date":DAY,"title":"增加审计日志","before":"仅查询","after":"查询并记录日志","reason":"客户确认","requester":"客户代表","decisionOwner":"项目经理","scopeImpact":"新增日志","scheduleImpact":"待评估","effortImpact":"待估时","links":[],"segmentIds":[]}),
    );
    call(
        &e,
        "transition_change_request",
        json!({"changeId":c["id"],"baseVersion":c["version"],"date":DAY,"status":"submitted","actor":"项目经理","note":"请确认变更影响"}),
    );
    let d = call(
        &e,
        "save_deliverable",
        json!({"projectId":p["id"],"baseVersion":0,"date":DAY,"title":"接口验收","owner":"研发负责人","target":{"kind":"task","id":t["id"],"version":t["version"]},"criteria":[{"title":"审计记录可查询","status":"pass","evidence":"测试记录 QA-001 已核验","note":"已验证"}],"links":[],"segmentIds":[]}),
    );
    let d = call(
        &e,
        "review_deliverable",
        json!({"deliverableId":d["id"],"baseVersion":d["version"],"date":DAY,"status":"in_review","reviewer":"验收负责人","note":"开始逐项验收","remediation":""}),
    );
    call(
        &e,
        "review_deliverable",
        json!({"deliverableId":d["id"],"baseVersion":d["version"],"date":DAY,"status":"accepted","reviewer":"验收负责人","note":"标准全部通过","remediation":""}),
    );
    let answer = call(
        &e,
        "ask_assistant",
        json!({"projectId":p["id"],"date":DAY,"question":"有哪些待决策事项？"}),
    );
    assert!(answer["citations"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["managementId"] == decision["id"]));
    assert!(answer["answer"].as_str().unwrap().contains("是否延期上线"));
    let view = call(
        &e,
        "get_delivery_overview",
        json!({"projectId":p["id"],"date":DAY}),
    );
    assert_eq!(view["projects"][0]["health"], "at_risk");
    assert!(view["projects"][0]["basis"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["managementId"] == decision["id"]));
    let report = call(
        &e,
        "coordination_generate_report",
        json!({"projectId":p["id"],"startDate":DAY,"endDate":DAY}),
    );
    assert!(report["content"].as_str().unwrap().contains("是否延期上线"));
    let mut edit = t.clone();
    edit["taskId"] = t["id"].clone();
    edit["baseVersion"] = t["version"].clone();
    edit["workDate"] = json!("2026-10-20");
    edit["status"] = json!("in_progress");
    edit["progress"] = json!(80);
    edit["note"] = json!("验收后发现缺陷，重新打开");
    edit["clientRequestId"] = json!(uuid::Uuid::new_v4().to_string());
    call(&e, "update_task", edit);
    let answer = call(
        &e,
        "ask_assistant",
        json!({"projectId":p["id"],"date":"2026-10-20","question":"交付验收情况？"}),
    );
    assert!(answer["answer"].as_str().unwrap().contains("需要重新复核"));
    let attention = call(
        &e,
        "get_management_attention",
        json!({"projectId":p["id"],"date":"2026-10-20"}),
    );
    assert_eq!(attention["count"], 3);
    let current = call(
        &e,
        "coordination_get_report",
        json!({"reportId":report["id"]}),
    );
    assert_eq!(current["basis"], report["basis"]);
    let backup = call(&e, "create_backup", json!({}));
    let archive = BASE64.encode(
        std::fs::read(
            dir.path()
                .join("backups")
                .join(backup["filename"].as_str().unwrap()),
        )
        .unwrap(),
    );
    call(
        &e,
        "restore_backup",
        json!({"filename":backup["filename"],"contentBase64":archive,"confirmation":"RESTORE"}),
    );
    let current = call(
        &e,
        "coordination_get_report",
        json!({"reportId":report["id"]}),
    );
    assert_eq!(current["basis"], report["basis"]);
    drop(e);
    let e = Engine::open(dir.path()).unwrap();
    assert_eq!(
        call(&e, "get_management_attention", json!({"date":"2026-10-20"}))["count"],
        3
    );
}

#[test]
fn schema_six_migrates_without_changing_delivery_state() {
    let dir = tempfile::tempdir().unwrap();
    let e = Engine::open(dir.path()).unwrap();
    let p = call(&e, "create_project", json!({"name":"P0工作区"}));
    let t = task(&e, &p);
    drop(e);
    let conn = rusqlite::Connection::open(dir.path().join("workspace.sqlite")).unwrap();
    conn.execute_batch("DROP TABLE proactive_history;DROP TABLE proactive_actions;DROP TABLE proactive_settings;DROP TABLE coordination_action_versions;DROP TABLE coordination_actions;DROP TABLE coordination_meeting_versions;DROP TABLE coordination_meetings;DROP TABLE coordination_report_versions;DROP TABLE coordination_reports;DROP TABLE deliverable_history;DROP TABLE deliverables;DROP TABLE change_request_history;DROP TABLE change_requests;DROP TABLE governance_revisions;DROP TABLE governance_items;PRAGMA user_version=6;").unwrap();
    drop(conn);
    let e = Engine::open(dir.path()).unwrap();
    let state = call(&e, "get_state", json!({}));
    assert_eq!(state["workspace"]["schemaVersion"], 8);
    assert_eq!(state["tasks"][0], t);
    assert_eq!(
        call(&e, "get_management_attention", json!({"date":DAY}))["count"],
        0
    );
    assert_eq!(
        call(
            &e,
            "get_delivery_overview",
            json!({"projectId":p["id"],"date":DAY})
        )["projects"][0]["taskCounts"]["done"],
        1
    );
}

#[test]
fn meeting_questions_include_independent_actions_and_track_their_current_task_status() {
    let dir = tempfile::tempdir().unwrap();
    let e = Engine::open(dir.path()).unwrap();
    let p = call(&e, "create_project", json!({"name":"行动项问答"}));
    let meeting = call(
        &e,
        "coordination_save_meeting",
        json!({"projectId":p["id"],"title":"联调会议","date":DAY,"attendees":"小周、项目经理","objective":"核对交付","agenda":"","briefing":"","minutes":"","decisions":""}),
    );
    let a = call(
        &e,
        "coordination_save_action",
        json!({"meetingId":meeting["id"],"title":"周五提交接口","owner":"小周","dueDate":"2026-10-23","status":"open"}),
    );
    let other = call(
        &e,
        "coordination_save_meeting",
        json!({"projectId":p["id"],"title":"其他会议","date":DAY,"attendees":"小周","objective":"其他安排","agenda":"","briefing":"","minutes":"","decisions":""}),
    );
    call(
        &e,
        "coordination_save_action",
        json!({"meetingId":other["id"],"title":"其他会议专属行动","owner":"小王","dueDate":"2026-10-23","status":"open"}),
    );
    let ask = |question: &str| {
        call(
            &e,
            "ask_assistant",
            json!({"projectId":p["id"],"date":DAY,"question":question}),
        )
    };
    let answer = ask("联调会议有哪些未结行动项，谁负责？");
    assert!(answer["answer"].as_str().unwrap().contains("周五提交接口"));
    assert!(answer["answer"].as_str().unwrap().contains("小周"));
    assert!(!answer["answer"]
        .as_str()
        .unwrap()
        .contains("其他会议专属行动"));
    assert!(answer["citations"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["kind"] == "meeting_action" && r["managementId"] == meeting["id"]));
    let confirmed = call(
        &e,
        "coordination_confirm_action",
        json!({"actionId":a["id"],"baseVersion":a["version"],"workDate":DAY}),
    );
    let task_id = confirmed["action"]["taskId"].as_str().unwrap();
    let task = call(&e, "get_task", json!({"taskId":task_id}))["task"].clone();
    let mut update = task.clone();
    update["taskId"] = json!(task_id);
    update["baseVersion"] = task["version"].clone();
    update["assignee"] = json!("小李");
    update["dueDate"] = json!("2026-10-26");
    update["workDate"] = json!(DAY);
    update["note"] = json!("转交小李，调整交付期限");
    update["clientRequestId"] = json!(uuid::Uuid::new_v4().to_string());
    let task = call(&e, "update_task", update);
    let answer = ask("联调会议有哪些未结行动项，谁负责、何时交付？");
    let action = answer["citations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|reference| reference["kind"] == "meeting_action")
        .unwrap();
    assert!(action["content"]
        .as_str()
        .unwrap()
        .contains("当前负责人：小李；当前截止：2026-10-26"));
    assert!(action["content"]
        .as_str()
        .unwrap()
        .contains("会议原约定负责人：小周；原约定截止：2026-10-23"));
    assert_eq!(action["record"]["owner"], "小李");
    assert_eq!(action["record"]["dueDate"], "2026-10-26");
    assert_eq!(action["record"]["originalOwner"], "小周");
    assert_eq!(action["record"]["originalDueDate"], "2026-10-23");
    let mut update = task.clone();
    update["taskId"] = json!(task_id);
    update["baseVersion"] = task["version"].clone();
    update["status"] = json!("done");
    update["progress"] = json!(100);
    update["workDate"] = json!(DAY);
    update["note"] = json!("接口已交付");
    update["clientRequestId"] = json!(uuid::Uuid::new_v4().to_string());
    call(&e, "update_task", update);
    assert!(!ask("联调会议有哪些未结行动项，谁负责？")["answer"]
        .as_str()
        .unwrap()
        .contains("周五提交接口"));
    assert!(ask("联调会议行动项情况")["answer"]
        .as_str()
        .unwrap()
        .contains("已完成"));
}
