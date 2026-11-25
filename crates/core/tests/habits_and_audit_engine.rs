use base64::Engine as _;
use project_assistant_core::{Engine, Request};
use serde_json::{json, Value};
use std::{
    thread,
    time::{Duration, Instant},
};

fn call(engine: &Engine, command: &str, payload: Value) -> Value {
    engine
        .execute(Request {
            command: command.into(),
            payload,
        })
        .unwrap_or_else(|e| panic!("{command} failed: {e}"))
}

fn req_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn wait_ready(engine: &Engine, source_id: &str) {
    let start = Instant::now();
    loop {
        let state = call(engine, "get_state", json!({}));
        let ready = state["sources"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["id"] == source_id && s["status"] == "ready");
        if ready {
            return;
        }
        assert!(
            start.elapsed() < Duration::from_secs(10),
            "source parse timed out"
        );
        thread::sleep(Duration::from_millis(20));
    }
}

fn import_and_confirm(
    engine: &Engine,
    project_id: &str,
    title: &str,
    text: &str,
    content: &str,
) -> String {
    let imported = call(
        engine,
        "import_text",
        json!({"projectId": project_id, "title": title, "text": text}),
    );
    let source_id = imported["sourceId"].as_str().unwrap().to_owned();
    wait_ready(engine, &source_id);
    let detail = call(engine, "get_source", json!({"sourceId": source_id}));
    let seg_id = detail["segments"][0]["id"].as_str().unwrap().to_owned();
    let prop = call(
        engine,
        "create_proposal",
        json!({
            "projectId": project_id,
            "sourceId": source_id,
            "kind": "decision",
            "content": content,
            "segmentIds": [seg_id],
        }),
    );
    let mem = call(
        engine,
        "confirm_proposal",
        json!({"proposalId": prop["id"]}),
    );
    mem["id"].as_str().unwrap().to_owned()
}

#[test]
fn prelude_report_edits_pahf_feedback_proactive_habits_and_reme_utility_loop() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path()).unwrap();

    let project = call(&engine, "create_project", json!({"name": "清结算重构"}));
    let project_id = project["id"].as_str().unwrap().to_owned();

    // 1) PRELUDE report-edit observer: 3 days of dropping percentages & putting risks first
    let mut task = call(
        &engine,
        "create_task",
        json!({
            "clientRequestId": req_id(),
            "projectId": project_id,
            "title": "对账引擎灰度切流",
            "description": "",
            "category": "action",
            "assignee": "王明",
            "priority": "high",
            "status": "in_progress",
            "progress": 65,
            "dueDate": "2026-11-30",
            "plannedDate": "2026-11-22",
            "workDate": "2026-11-22",
        }),
    );

    for (idx, day) in ["2026-11-22", "2026-11-23", "2026-11-24"]
        .iter()
        .enumerate()
    {
        let mut update = task.clone();
        update["taskId"] = task["id"].clone();
        update["baseVersion"] = task["version"].clone();
        update["progress"] = json!(65 + (idx as i64) * 5);
        update["workDate"] = json!(day);
        update["note"] = json!(format!("推进第 {} 批灰度验证", idx + 1));
        update["clientRequestId"] = json!(req_id());
        task = call(&engine, "update_task", update);
        let generated = call(
            &engine,
            "generate_daily_report",
            json!({
                "clientRequestId": req_id(),
                "date": day,
                "projectId": project_id,
            }),
        );
        assert!(
            generated["content"].as_str().unwrap_or("").contains('%'),
            "expected generated report to contain progress percentage: {generated}"
        );
        let edited_content = format!(
            "## 风险与阻塞\n- 待确认清结算回滚窗口\n\n## 今日进展（{day}）\n- 对账引擎灰度切流已按计划推进，王明跟进中。\n"
        );
        call(
            &engine,
            "save_daily_report",
            json!({
                "clientRequestId": req_id(),
                "reportId": generated["id"],
                "baseVersion": generated["version"],
                "content": edited_content,
            }),
        );
    }

    let center = call(
        &engine,
        "get_habits_center",
        json!({"projectId": project_id}),
    );
    // Nothing activates without explicit user confirmation
    assert_eq!(center["counts"]["activeHabits"], 0);
    let proposals = center["proposals"].as_array().unwrap();
    let drop_pct = proposals
        .iter()
        .find(|p| p["patternKey"] == "writing:drop_percentages")
        .unwrap_or_else(|| panic!("expected writing:drop_percentages proposal in {center}"));
    assert!(drop_pct["evidenceCount"].as_i64().unwrap() >= 3);
    assert!(!drop_pct["samples"].as_array().unwrap().is_empty());

    // Confirm the proposal -> becomes an active user_habit
    let confirmed = call(
        &engine,
        "resolve_habit_proposal",
        json!({
            "proposalId": drop_pct["id"],
            "action": "confirm",
            "title": "日报隐藏进度百分比",
        }),
    );
    assert_eq!(confirmed["status"], "confirmed");
    let habit_id = confirmed["habit"]["id"].as_str().unwrap().to_owned();
    assert_eq!(confirmed["habit"]["status"], "active");
    assert_eq!(confirmed["habit"]["title"], "日报隐藏进度百分比");

    // ReMe utility monitoring: 5 overrides trigger lowUtilityWarning
    for _ in 0..5 {
        call(
            &engine,
            "record_habit_outcome",
            json!({"habitIds": [habit_id], "outcome": "overridden"}),
        );
    }
    let after_decay = call(
        &engine,
        "get_habits_center",
        json!({"projectId": project_id}),
    );
    let tracked = after_decay["habits"]
        .as_array()
        .unwrap()
        .iter()
        .find(|h| h["id"] == habit_id)
        .unwrap();
    assert_eq!(tracked["lowUtilityWarning"], true);
    assert_eq!(tracked["overriddenCount"], 5);
    assert!(tracked["utilityScore"].as_f64().unwrap() < 0.35);

    // Pause and resume habit lifecycle
    let paused = call(
        &engine,
        "update_habit_status",
        json!({"id": habit_id, "status": "paused", "baseVersion": tracked["version"]}),
    );
    assert_eq!(paused["status"], "paused");

    // 2) PAHF explicit feedback in Copilot approval card activates habit immediately
    let pahf = call(
        &engine,
        "record_copilot_feedback",
        json!({
            "projectId": project_id,
            "toolName": "create_task",
            "decision": "edited_and_approved",
            "originalArgs": {"priority": "medium", "assignee": ""},
            "finalArgs": {"priority": "high", "assignee": "王明"},
            "rememberAsHabit": true,
        }),
    );
    let saved_habits = pahf["savedHabits"].as_array().unwrap();
    assert_eq!(
        saved_habits.len(),
        2,
        "expected priority + assignee habits: {pahf}"
    );
    assert!(saved_habits
        .iter()
        .any(|h| h["patternKey"] == "workflow:copilot:create_task:priority:high"));

    // 3) Proactive reminder dismissal -> proposal -> confirm -> lowers future scan priority
    for i in 1..=3 {
        call(
            &engine,
            "create_task",
            json!({
                "clientRequestId": req_id(),
                "projectId": project_id,
                "title": format!("逾期跟进事项 {i}"),
                "description": "",
                "category": "action",
                "assignee": null,
                "priority": "high",
                "status": "todo",
                "progress": 0,
                "dueDate": "2020-01-01",
                "plannedDate": "2020-01-01",
                "workDate": "2026-11-24",
            }),
        );
    }
    let scan1 = call(
        &engine,
        "run_proactive_scan",
        json!({"projectId": project_id}),
    );
    let actions1 = scan1["actions"].as_array().unwrap();
    let task_actions: Vec<&Value> = actions1
        .iter()
        .filter(|a| a["targetKind"] == "task" && a["status"] == "ready")
        .collect();
    assert!(
        task_actions.len() >= 3,
        "expected >=3 overdue task proactive items: {scan1}"
    );
    let baseline_priority = task_actions[0]["priority"].as_i64().unwrap();

    for action in task_actions.iter().take(3) {
        call(
            &engine,
            "update_proactive_action",
            json!({
                "actionId": action["id"],
                "baseVersion": action["version"],
                "operation": "dismiss",
                "note": "此类任务我自己在看板看，不用反复提醒",
            }),
        );
    }

    let habits_after_dismiss = call(
        &engine,
        "get_habits_center",
        json!({"projectId": project_id}),
    );
    let remind_prop = habits_after_dismiss["proposals"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["patternKey"] == "reminder:deprioritize:task")
        .unwrap_or_else(|| {
            panic!("expected reminder:deprioritize:task proposal: {habits_after_dismiss}")
        });
    call(
        &engine,
        "resolve_habit_proposal",
        json!({"proposalId": remind_prop["id"], "action": "confirm"}),
    );

    // Create a 4th identical overdue task; rescan should apply learned negative priority delta
    let mut overdue_task = json!({
        "clientRequestId": req_id(),
        "projectId": project_id,
        "title": "逾期跟进事项 4",
        "description": "",
        "category": "action",
        "assignee": null,
        "priority": "high",
        "status": "todo",
        "progress": 0,
        "dueDate": "2020-01-01",
        "plannedDate": "2020-01-01",
        "workDate": "2026-11-24",
    });
    let task4 = call(&engine, "create_task", overdue_task.clone());
    let task4_id = task4["id"].as_str().unwrap();
    let scan2 = call(
        &engine,
        "run_proactive_scan",
        json!({"projectId": project_id}),
    );
    let action4 = scan2["actions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["targetId"] == task4_id)
        .unwrap_or_else(|| panic!("expected proactive item for task4 in {scan2}"));
    let lowered_priority = action4["priority"].as_i64().unwrap();
    assert!(
        lowered_priority < baseline_priority,
        "expected confirmed reminder habit to reduce proactive priority ({lowered_priority} < {baseline_priority})"
    );
    let other_project = call(&engine, "create_project", json!({"name": "对照项目"}));
    overdue_task["projectId"] = other_project["id"].clone();
    overdue_task["clientRequestId"] = json!(req_id());
    let other_task = call(&engine, "create_task", overdue_task);
    let workspace_scan = call(&engine, "run_proactive_scan", json!({}));
    let workspace_priority = |task: &Value| {
        let action = workspace_scan["actions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|action| action["targetId"] == task["id"])
            .unwrap();
        action["priority"].as_i64().unwrap()
    };
    assert_eq!(workspace_priority(&task4), lowered_priority);
    assert_eq!(workspace_priority(&other_task), baseline_priority);
}

#[test]
fn sleep_time_memory_audit_detects_resolves_and_survives_backup_restore() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path()).unwrap();

    let project = call(&engine, "create_project", json!({"name": "海外清结算网关"}));
    let project_id = project["id"].as_str().unwrap().to_owned();

    // Pair 1: date_conflict
    let mem_old_date = import_and_confirm(
        &engine,
        &project_id,
        "11月周会",
        "海外清结算网关灰度上线日期确定为 2026-12-01。",
        "海外清结算网关灰度上线日期确定为 2026-12-01。",
    );
    let mem_new_date = import_and_confirm(
        &engine,
        &project_id,
        "排期变更通知",
        "海外清结算网关灰度上线日期确定为 2026-12-10。",
        "海外清结算网关灰度上线日期确定为 2026-12-10。",
    );

    // Pair 2: owner_conflict
    let _mem_owner_a = import_and_confirm(
        &engine,
        &project_id,
        "分工表v1",
        "风控规则引擎联调模块由王明负责。",
        "风控规则引擎联调模块由王明负责。",
    );
    let _mem_owner_b = import_and_confirm(
        &engine,
        &project_id,
        "分工表v2",
        "风控规则引擎联调模块由李华负责。",
        "风控规则引擎联调模块由李华负责。",
    );

    // Pair 3: negation_conflict
    let _mem_pos = import_and_confirm(
        &engine,
        &project_id,
        "架构评审",
        "决定启用海外渠道异步对账补偿机制。",
        "决定启用海外渠道异步对账补偿机制。",
    );
    let _mem_neg = import_and_confirm(
        &engine,
        &project_id,
        "架构修订",
        "已取消启用海外渠道异步对账补偿机制。",
        "已取消启用海外渠道异步对账补偿机制。",
    );

    // Also save one manual habit to verify backup/restore preserves both habits and audits
    call(
        &engine,
        "save_user_habit",
        json!({
            "projectId": project_id,
            "category": "writing",
            "title": "周报先列阻塞风险",
            "instruction": "输出周报时第一段先列出阻塞风险和责任人。",
        }),
    );

    let audit_res = call(
        &engine,
        "run_memory_audit",
        json!({"projectId": project_id}),
    );
    let audits = audit_res["audits"].as_array().unwrap();
    let kinds: Vec<&str> = audits.iter().filter_map(|a| a["kind"].as_str()).collect();
    assert!(
        kinds.contains(&"date_conflict"),
        "missing date_conflict in {audit_res}"
    );
    assert!(
        kinds.contains(&"owner_conflict"),
        "missing owner_conflict in {audit_res}"
    );
    assert!(
        kinds.contains(&"negation_conflict"),
        "missing negation_conflict in {audit_res}"
    );

    // Resolve date_conflict by keeping mem_new_date (2026-12-10) and archiving mem_old_date (2026-12-01)
    let date_audit = audits
        .iter()
        .find(|a| a["kind"] == "date_conflict")
        .unwrap();
    let keep_action = if date_audit["memoryA"]["id"] == mem_new_date {
        "keep_a"
    } else {
        assert_eq!(date_audit["memoryB"]["id"], mem_new_date);
        "keep_b"
    };
    let resolved = call(
        &engine,
        "resolve_memory_audit",
        json!({"auditId": date_audit["id"], "action": keep_action}),
    );
    assert_eq!(resolved["status"], "resolved");

    // Verify superseded memory was archived via revision retention (not mutating memories.state)
    let old_detail = call(&engine, "get_memory", json!({"memoryId": mem_old_date}));
    assert_eq!(old_detail["memory"]["state"], "active");
    assert_eq!(old_detail["memory"]["revision"], 2);
    assert_eq!(old_detail["memory"]["retention"]["layer"], "archive");

    // Verify verified search excludes the archived superseded memory and returns the kept one
    let search = call(
        &engine,
        "search_verified_memories",
        json!({"projectId": project_id, "query": "海外清结算网关灰度上线日期", "date": "2026-11-24"}),
    );
    let ids: Vec<&str> = search["memories"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|m| m["id"].as_str())
        .collect();
    assert!(
        ids.contains(&mem_new_date.as_str()),
        "kept memory missing: {search}"
    );
    assert!(
        !ids.contains(&mem_old_date.as_str()),
        "archived memory leaked: {search}"
    );

    // Dismiss owner_conflict -> leaves both active
    let owner_audit = audits
        .iter()
        .find(|a| a["kind"] == "owner_conflict")
        .unwrap();
    let dismissed = call(
        &engine,
        "resolve_memory_audit",
        json!({"auditId": owner_audit["id"], "action": "dismiss"}),
    );
    assert_eq!(dismissed["status"], "dismissed");

    // Create backup & restore: validates memories.state='active', habits & memory_audits invariants
    let backup = call(&engine, "create_backup", json!({}));
    let filename = backup["filename"].as_str().unwrap();
    let zip_bytes = std::fs::read(dir.path().join("backups").join(filename)).unwrap();
    let encoded = base64::engine::general_purpose::STANDARD.encode(zip_bytes);
    call(
        &engine,
        "restore_backup",
        json!({"filename": filename, "contentBase64": encoded, "confirmation": "RESTORE"}),
    );

    let habits_restored = call(
        &engine,
        "get_habits_center",
        json!({"projectId": project_id}),
    );
    assert_eq!(habits_restored["counts"]["activeHabits"], 1);
    assert_eq!(habits_restored["habits"][0]["title"], "周报先列阻塞风险");

    let audits_restored = call(
        &engine,
        "get_memory_audits",
        json!({"projectId": project_id}),
    );
    assert_eq!(audits_restored["openCount"], 1);
    assert_eq!(audits_restored["audits"][0]["kind"], "negation_conflict");
}
