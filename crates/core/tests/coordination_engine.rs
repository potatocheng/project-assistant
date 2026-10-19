//! Public actor coverage: truthful date cutoffs, immutable reports, and opt-in actions.
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use project_assistant_core::{AppError, Engine, Request};
use serde_json::{json, Value};

fn call(e: &Engine, command: &str, payload: Value) -> Value {
    e.execute(Request {
        command: command.into(),
        payload,
    })
    .unwrap_or_else(|err| panic!("{command}: {err}"))
}
fn error(e: &Engine, command: &str, payload: Value) -> AppError {
    e.execute(Request {
        command: command.into(),
        payload,
    })
    .unwrap_err()
}
fn project(e: &Engine, name: &str) -> Value {
    call(e, "create_project", json!({"name":name}))
}
fn task(e: &Engine, p: &Value, title: &str, status: &str, day: &str) -> Value {
    call(
        e,
        "create_task",
        json!({"projectId":p["id"],"title":title,"description":"","category":"action","assignee":"小周","priority":"high","status":status,"progress":if status=="done"{100}else{0},"dueDate":"2026-10-25","plannedDate":null,"workDate":day,"clientRequestId":uuid::Uuid::new_v4().to_string()}),
    )
}
fn update(e: &Engine, t: &Value, title: &str, status: &str, day: &str) -> Value {
    let mut p = t.clone();
    p["taskId"] = t["id"].clone();
    p["baseVersion"] = t["version"].clone();
    p["title"] = json!(title);
    p["status"] = json!(status);
    p["progress"] = json!(if status == "done" { 100 } else { 0 });
    p["workDate"] = json!(day);
    p["note"] = json!("实际进展");
    p["clientRequestId"] = json!(uuid::Uuid::new_v4().to_string());
    call(e, "update_task", p)
}
fn weekly(e: &Engine, p: &Value) -> Value {
    call(
        e,
        "coordination_generate_report",
        json!({"projectId":p["id"],"startDate":"2026-10-19","endDate":"2026-10-25"}),
    )
}
fn meeting(e: &Engine, p: &Value, title: &str, day: &str) -> Value {
    call(
        e,
        "coordination_save_meeting",
        json!({"projectId":p["id"],"title":title,"date":day,"attendees":"项目经理、小周","objective":"明确交付安排","agenda":"","briefing":"","minutes":"","decisions":""}),
    )
}
fn action(e: &Engine, m: &Value, title: &str) -> Value {
    call(
        e,
        "coordination_save_action",
        json!({"meetingId":m["id"],"title":title,"owner":"小周","dueDate":"2026-10-30","status":"open"}),
    )
}

#[test]
fn weekly_completion_requires_transition_inside_period_and_cutoff_still_done() {
    let dir = tempfile::tempdir().unwrap();
    let e = Engine::open(dir.path()).unwrap();
    let p = project(&e, "跨周真实性");
    let other = project(&e, "其他项目");
    let old = task(&e, &p, "上周完成", "todo", "2026-10-16");
    let old = update(&e, &old, "上周完成", "done", "2026-10-18");
    update(&e, &old, "本周只是改名的上周成果", "done", "2026-10-20");
    let completed = task(&e, &p, "本周成果", "todo", "2026-10-18");
    let completed = update(&e, &completed, "本周成果", "done", "2026-10-21");
    let reopened = task(&e, &p, "本周重开", "todo", "2026-10-19");
    let reopened = update(&e, &reopened, "本周重开", "done", "2026-10-20");
    update(&e, &reopened, "本周重开", "todo", "2026-10-23");
    task(&e, &other, "其他项目成果", "done", "2026-10-21");
    let before = weekly(&e, &p);
    assert_eq!(before["basis"]["completed"].as_array().unwrap().len(), 1);
    assert_eq!(before["basis"]["completed"][0]["taskId"], completed["id"]);
    let later = update(&e, &completed, "下周才改的新标题", "todo", "2026-10-26");
    let regenerated = weekly(&e, &p);
    assert_eq!(
        regenerated["basis"]["completed"][0]["after"]["title"],
        "本周成果"
    );
    assert_eq!(
        regenerated["basis"]["completed"][0]["after"]["status"],
        "done"
    );
    assert!(regenerated["content"]
        .as_str()
        .unwrap()
        .contains("本周成果"));
    assert!(!regenerated["content"]
        .as_str()
        .unwrap()
        .contains("下周才改的新标题"));
    assert_eq!(later["status"], "todo");
    assert!(before["basis"]["taskStates"]
        .as_array()
        .unwrap()
        .iter()
        .all(|e| e["projectId"] == p["id"]));
    let all = call(
        &e,
        "coordination_generate_report",
        json!({"startDate":"2026-10-19","endDate":"2026-10-25"}),
    );
    assert_eq!(all["basis"]["completed"].as_array().unwrap().len(), 2);
}

#[test]
fn saved_report_revisions_freeze_basis_and_older_versions_remain_readable() {
    let dir = tempfile::tempdir().unwrap();
    let e = Engine::open(dir.path()).unwrap();
    let p = project(&e, "版本冻结");
    let t = task(&e, &p, "验收", "blocked", "2026-10-19");
    let r = weekly(&e, &p);
    update(&e, &t, "新进展", "done", "2026-10-24");
    let saved = call(
        &e,
        "coordination_save_report",
        json!({"reportId":r["id"],"baseVersion":1,"content":"# 项目周报\n\n人工补充管理判断"}),
    );
    assert_eq!(saved["version"], 2);
    assert_eq!(saved["basis"], r["basis"]);
    assert_eq!(saved["history"].as_array().unwrap().len(), 2);
    let old = call(
        &e,
        "coordination_get_report",
        json!({"reportId":r["id"],"version":1}),
    );
    assert_eq!(old["content"], r["content"]);
    assert_eq!(old["basis"], r["basis"]);
    assert_eq!(old["latestVersion"], 2);
    assert_eq!(
        error(
            &e,
            "coordination_save_report",
            json!({"reportId":r["id"],"baseVersion":1,"content":"覆盖"})
        )
        .code,
        "VERSION_CONFLICT"
    );
    let regenerated = call(
        &e,
        "coordination_generate_report",
        json!({"reportId":r["id"],"baseVersion":2,"projectId":p["id"],"startDate":"2026-10-19","endDate":"2026-10-25"}),
    );
    assert_eq!(regenerated["version"], 3);
    assert_eq!(
        regenerated["basis"]["completed"].as_array().unwrap().len(),
        1
    );
    assert_eq!(
        call(
            &e,
            "coordination_get_report",
            json!({"reportId":r["id"],"version":2})
        )["basis"],
        r["basis"]
    );
    assert_eq!(
        error(
            &e,
            "coordination_generate_report",
            json!({"startDate":"2026-10-25","endDate":"2026-10-19"})
        )
        .code,
        "VALIDATION"
    );
}

#[test]
fn meeting_actions_create_tasks_only_after_explicit_confirmation_and_are_idempotent() {
    let dir = tempfile::tempdir().unwrap();
    let e = Engine::open(dir.path()).unwrap();
    let p = project(&e, "会后闭环");
    let m = meeting(&e, &p, "周例会", "2026-10-19");
    let a = action(&e, &m, "确认接口交付时间");
    assert_eq!(
        call(&e, "get_state", json!({}))["tasks"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
    let payload = json!({"actionId":a["id"],"baseVersion":1,"workDate":"2026-10-19"});
    let confirmed = call(&e, "coordination_confirm_action", payload.clone());
    let repeated = call(&e, "coordination_confirm_action", payload);
    assert_eq!(confirmed["task"]["id"], repeated["task"]["id"]);
    assert_eq!(repeated["alreadyConfirmed"], true);
    assert_eq!(confirmed["task"]["category"], "follow_up");
    assert_eq!(
        call(&e, "get_state", json!({}))["tasks"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let current = call(&e, "coordination_get_meeting", json!({"meetingId":m["id"]}));
    assert_eq!(current["actions"][0]["taskId"], confirmed["task"]["id"]);
    assert_eq!(current["actions"][0]["completionState"], "todo");
    update(
        &e,
        &confirmed["task"],
        "确认接口交付时间",
        "done",
        "2026-10-20",
    );
    let current = call(&e, "coordination_get_meeting", json!({"meetingId":m["id"]}));
    assert_eq!(current["actions"][0]["completionState"], "done");
    assert_eq!(current["actions"][0]["task"]["version"], 2);
    let explicit = action(&e, &m, "本人执行事项");
    let explicit = call(
        &e,
        "coordination_confirm_action",
        json!({"actionId":explicit["id"],"baseVersion":1,"workDate":"2026-10-20","category":"action"}),
    );
    assert_eq!(explicit["task"]["category"], "action");
    let a = action(&e, &m, "待定行动");
    assert_eq!(
        error(
            &e,
            "coordination_confirm_action",
            json!({"actionId":a["id"],"baseVersion":1,"workDate":"2026-10-18"})
        )
        .code,
        "VALIDATION"
    );
}

#[test]
fn meeting_preparation_rolls_forward_unfinished_actions_with_project_and_date_boundaries() {
    let dir = tempfile::tempdir().unwrap();
    let e = Engine::open(dir.path()).unwrap();
    let p = project(&e, "周会准备");
    let other = project(&e, "外部项目");
    let first = meeting(&e, &p, "上次会议", "2026-10-19");
    let pending = action(&e, &first, "等待确认方案");
    let done = action(&e, &first, "已完成约定");
    let t = call(
        &e,
        "coordination_confirm_action",
        json!({"actionId":done["id"],"baseVersion":1,"workDate":"2026-10-19"}),
    );
    update(&e, &t["task"], "已完成约定", "done", "2026-10-20");
    let pending_task = call(
        &e,
        "coordination_confirm_action",
        json!({"actionId":pending["id"],"baseVersion":1,"workDate":"2026-10-19"}),
    );
    let mut assigned = pending_task["task"].clone();
    assigned["assignee"] = json!("小李");
    assigned["dueDate"] = json!("2026-10-31");
    let assigned = update(&e, &assigned, "等待确认方案", "in_progress", "2026-10-20");
    let future = meeting(&e, &p, "未来会议", "2026-10-28");
    action(&e, &future, "来自未来的行动");
    let foreign = meeting(&e, &other, "其他项目会议", "2026-10-18");
    action(&e, &foreign, "跨项目行动");
    let next = meeting(&e, &p, "本次会议", "2026-10-21");
    let prepared = call(
        &e,
        "coordination_prepare_meeting",
        json!({"meetingId":next["id"],"baseVersion":1}),
    );
    assert_eq!(prepared["version"], 2);
    assert_eq!(
        prepared["preparationBasis"]["previousActions"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        prepared["preparationBasis"]["previousActions"][0]["id"],
        pending["id"]
    );
    assert!(prepared["agenda"].as_str().unwrap().contains("1 项"));
    assert!(prepared["briefing"]
        .as_str()
        .unwrap()
        .contains("生成时任务负责人：小李 · 期限 2026-10-31；会议原约定：小周 · 期限 2026-10-30"));
    assert_eq!(
        prepared["preparationBasis"]["previousActions"][0]["task"]["assignee"],
        "小李"
    );
    assert_eq!(
        prepared["preparationBasis"]["previousActions"][0]["owner"],
        "小周"
    );
    let mut reassigned = assigned.clone();
    reassigned["assignee"] = json!("小王");
    reassigned["dueDate"] = json!("2026-11-02");
    update(&e, &reassigned, "等待确认方案", "in_progress", "2026-10-22");
    let frozen = call(
        &e,
        "coordination_get_meeting",
        json!({"meetingId":next["id"],"version":2}),
    );
    assert_eq!(
        frozen["preparationBasis"]["previousActions"][0]["task"]["assignee"],
        "小李"
    );
    assert_eq!(error(&e,"coordination_save_action",json!({"meetingId":foreign["id"],"actionId":pending["id"],"baseVersion":1,"title":"错项目","owner":"小周","dueDate":"2026-10-30","status":"open"})).code,"VALIDATION");
    assert_eq!(
        error(
            &e,
            "coordination_prepare_meeting",
            json!({"meetingId":next["id"],"baseVersion":1})
        )
        .code,
        "VERSION_CONFLICT"
    );
    let mut saved = prepared.clone();
    saved["meetingId"] = prepared["id"].clone();
    saved["baseVersion"] = json!(2);
    saved["minutes"] = json!("讨论了接口交付风险");
    saved["decisions"] = json!("由小周周五前确认");
    let saved = call(&e, "coordination_save_meeting", saved);
    assert_eq!(saved["version"], 3);
    assert_eq!(
        call(
            &e,
            "coordination_get_meeting",
            json!({"meetingId":next["id"],"version":2})
        )["minutes"],
        ""
    );
}

#[test]
fn reports_and_meeting_action_links_survive_restart_and_verified_backup_restore() {
    let dir = tempfile::tempdir().unwrap();
    let e = Engine::open(dir.path()).unwrap();
    let p = project(&e, "持久化");
    task(&e, &p, "报告任务", "done", "2026-10-19");
    let r = weekly(&e, &p);
    let m = meeting(&e, &p, "首次会议", "2026-10-19");
    let a = action(&e, &m, "会议行动");
    call(
        &e,
        "coordination_confirm_action",
        json!({"actionId":a["id"],"baseVersion":1,"workDate":"2026-10-19"}),
    );
    let next = meeting(&e, &p, "复盘会议", "2026-10-20");
    call(
        &e,
        "coordination_prepare_meeting",
        json!({"meetingId":next["id"],"baseVersion":1}),
    );
    let original_list = call(&e, "coordination_list", json!({"projectId":p["id"]}));
    let original_report = call(&e, "coordination_get_report", json!({"reportId":r["id"]}));
    let original_meeting = call(
        &e,
        "coordination_get_meeting",
        json!({"meetingId":next["id"]}),
    );
    let backup = call(&e, "create_backup", json!({}));
    let bytes = std::fs::read(
        dir.path()
            .join("backups")
            .join(backup["filename"].as_str().unwrap()),
    )
    .unwrap();
    drop(e);
    let e = Engine::open(dir.path()).unwrap();
    assert_eq!(
        call(&e, "coordination_list", json!({"projectId":p["id"]})),
        original_list
    );
    call(
        &e,
        "coordination_save_report",
        json!({"reportId":r["id"],"baseVersion":1,"content":"修改后的报告"}),
    );
    call(
        &e,
        "inspect_backup",
        json!({"filename":backup["filename"],"contentBase64":BASE64.encode(&bytes)}),
    );
    call(
        &e,
        "restore_backup",
        json!({"filename":backup["filename"],"contentBase64":BASE64.encode(bytes),"confirmation":"RESTORE"}),
    );
    assert_eq!(
        call(&e, "coordination_get_report", json!({"reportId":r["id"]})),
        original_report
    );
    assert_eq!(
        call(
            &e,
            "coordination_get_meeting",
            json!({"meetingId":next["id"]})
        ),
        original_meeting
    );
    assert_eq!(
        call(&e, "coordination_list", json!({"projectId":p["id"]})),
        original_list
    );
}

#[test]
fn acceptance_reopening_is_checked_against_report_cutoff_instead_of_mutable_current_task() {
    let dir = tempfile::tempdir().unwrap();
    let e = Engine::open(dir.path()).unwrap();
    let p = project(&e, "验收状态截止日");
    let t = task(&e, &p, "交付接口", "done", "2026-10-19");
    let d = call(
        &e,
        "save_deliverable",
        json!({"projectId":p["id"],"date":"2026-10-19","baseVersion":0,"title":"接口验收","owner":"小周","target":{"kind":"task","id":t["id"],"version":1},"criteria":[{"title":"接口联调通过","status":"pass","evidence":"测试记录 QA-101","note":"已检查"}],"links":[],"segmentIds":[]}),
    );
    let d = call(
        &e,
        "review_deliverable",
        json!({"deliverableId":d["id"],"baseVersion":1,"date":"2026-10-19","status":"in_review","reviewer":"经理","note":"复核交付","remediation":""}),
    );
    call(
        &e,
        "review_deliverable",
        json!({"deliverableId":d["id"],"baseVersion":d["version"],"date":"2026-10-19","status":"accepted","reviewer":"经理","note":"全部标准已通过","remediation":""}),
    );
    let clean = weekly(&e, &p);
    assert_eq!(
        clean["basis"]["deliverables"][0]["acceptanceCheck"]["needsReReview"],
        false
    );
    update(&e, &t, "接口重开补充", "todo", "2026-10-23");
    let reopened = weekly(&e, &p);
    assert_eq!(
        reopened["basis"]["deliverables"][0]["acceptanceCheck"]["needsReReview"],
        true
    );
    assert!(reopened["content"].as_str().unwrap().contains("需重新复核"));
    let historic = call(
        &e,
        "coordination_generate_report",
        json!({"projectId":p["id"],"startDate":"2026-10-19","endDate":"2026-10-20"}),
    );
    assert_eq!(
        historic["basis"]["deliverables"][0]["acceptanceCheck"]["needsReReview"],
        false
    );
    let backup = call(&e, "create_backup", json!({}));
    let bytes = std::fs::read(
        dir.path()
            .join("backups")
            .join(backup["filename"].as_str().unwrap()),
    )
    .unwrap();
    call(
        &e,
        "inspect_backup",
        json!({"filename":backup["filename"],"contentBase64":BASE64.encode(bytes)}),
    );
}
