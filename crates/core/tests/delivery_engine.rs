//! Public Engine coverage for delivery oversight and follow-up workflows.
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use project_assistant_core::{AppError, Engine, Request};
use serde_json::{json, Value};

fn call(engine: &Engine, command: &str, payload: Value) -> Value {
    engine
        .execute(Request {
            command: command.into(),
            payload,
        })
        .unwrap_or_else(|e| panic!("{command}: {e}"))
}
fn error(engine: &Engine, command: &str, payload: Value) -> AppError {
    engine
        .execute(Request {
            command: command.into(),
            payload,
        })
        .unwrap_err()
}
fn project(engine: &Engine, name: &str) -> Value {
    call(engine, "create_project", json!({"name":name}))
}
fn create_task(
    engine: &Engine,
    project: &Value,
    title: &str,
    category: &str,
    status: &str,
    due: Option<&str>,
    work: &str,
) -> Value {
    call(
        engine,
        "create_task",
        json!({"projectId":project["id"],"title":title,"description":"交付内容","category":category,"assignee":"小周","priority":"medium","status":status,"progress":if status == "done" {100} else {0},"dueDate":due,"plannedDate":null,"workDate":work,"clientRequestId":uuid::Uuid::new_v4().to_string()}),
    )
}
fn update_task(engine: &Engine, task: &Value, status: &str, work: &str) -> Value {
    let mut fields = task.clone();
    fields["taskId"] = task["id"].clone();
    fields["baseVersion"] = task["version"].clone();
    fields["status"] = json!(status);
    fields["progress"] = json!(if status == "done" { 100 } else { 0 });
    fields["workDate"] = json!(work);
    fields["note"] = json!("更新任务进展");
    fields["clientRequestId"] = json!(uuid::Uuid::new_v4().to_string());
    call(engine, "update_task", fields)
}
fn center(engine: &Engine, project: &Value, date: &str) -> Value {
    call(
        engine,
        "get_follow_up_center",
        json!({"date":date,"projectId":project["id"]}),
    )
}
fn contains_reason(center: &Value, task: &Value, kind: &str) -> bool {
    center["items"].as_array().unwrap().iter().any(|v| {
        v["taskId"] == task["id"]
            && v["reasons"]
                .as_array()
                .unwrap()
                .iter()
                .any(|r| r["kind"] == kind)
    })
}
fn milestone_payload(project: &Value, tasks: &[&Value], status: &str) -> Value {
    json!({"projectId":project["id"],"title":"周五联调","description":"完成接口和联调","status":status,"baselineDate":"2026-10-20","forecastDate":"2026-10-23","taskIds":tasks.iter().map(|t|t["id"].clone()).collect::<Vec<_>>()})
}

#[test]
fn reminders_observe_date_boundaries_scope_and_terminal_statuses() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path()).unwrap();
    let p = project(&engine, "提醒边界");
    let other = project(&engine, "另一个项目");
    let overdue = create_task(
        &engine,
        &p,
        "昨日到期",
        "action",
        "todo",
        Some("2026-10-18"),
        "2026-10-16",
    );
    let today = create_task(
        &engine,
        &p,
        "今天到期",
        "action",
        "todo",
        Some("2026-10-19"),
        "2026-10-16",
    );
    let soon = create_task(
        &engine,
        &p,
        "三天内到期",
        "action",
        "todo",
        Some("2026-10-22"),
        "2026-10-16",
    );
    let later = create_task(
        &engine,
        &p,
        "四天后到期",
        "action",
        "todo",
        Some("2026-10-23"),
        "2026-10-16",
    );
    let stale = create_task(
        &engine,
        &p,
        "三天无进展",
        "action",
        "in_progress",
        None,
        "2026-10-16",
    );
    let recent = create_task(
        &engine,
        &p,
        "两天无进展",
        "action",
        "in_progress",
        None,
        "2026-10-17",
    );
    let follow = create_task(
        &engine,
        &p,
        "待跟进未启动",
        "follow_up",
        "todo",
        None,
        "2026-10-16",
    );
    let done = create_task(
        &engine,
        &p,
        "已完成",
        "follow_up",
        "done",
        Some("2026-10-18"),
        "2026-10-16",
    );
    let cancelled = create_task(
        &engine,
        &p,
        "已取消",
        "follow_up",
        "cancelled",
        Some("2026-10-18"),
        "2026-10-16",
    );
    create_task(
        &engine,
        &other,
        "别的项目逾期",
        "action",
        "todo",
        Some("2026-10-18"),
        "2026-10-16",
    );
    let result = center(&engine, &p, "2026-10-19");
    assert!(contains_reason(&result, &overdue, "overdue"));
    assert!(contains_reason(&result, &today, "due_soon"));
    assert!(contains_reason(&result, &soon, "due_soon"));
    assert!(contains_reason(&result, &stale, "stale"));
    assert!(contains_reason(&result, &follow, "stale"));
    for task in [&later, &recent, &done, &cancelled] {
        assert!(!result["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["taskId"] == task["id"]));
    }
    assert_eq!(result["counts"]["actionable"], 5);
    assert_eq!(result["counts"]["dueSoon"], 2);
    assert_eq!(result["taskStates"].as_array().unwrap().len(), 7);
    let all = call(
        &engine,
        "get_follow_up_center",
        json!({"date":"2026-10-19"}),
    );
    assert_eq!(all["counts"]["actionable"], 6);
    assert_eq!(
        error(
            &engine,
            "get_follow_up_center",
            json!({"date":"2026-02-30"})
        )
        .code,
        "VALIDATION"
    );
    assert_eq!(
        error(
            &engine,
            "get_follow_up_center",
            json!({"date":"2026-10-19","projectId":"missing"})
        )
        .code,
        "NOT_FOUND"
    );
}

#[test]
fn first_follow_up_is_available_without_a_trigger_and_snooze_resumes_on_selected_day() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path()).unwrap();
    let p = project(&engine, "跟进闭环");
    let task = create_task(
        &engine,
        &p,
        "尚未到期的需求确认",
        "action",
        "todo",
        None,
        "2026-10-16",
    );
    let initial = center(&engine, &p, "2026-10-19");
    assert_eq!(initial["items"], json!([]));
    assert_eq!(initial["taskStates"][0]["followUpVersion"], 0);
    let follow = json!({"taskId":task["id"],"baseVersion":0,"workDate":"2026-10-19","note":"等待客户确认范围","nextFollowUpDate":"2026-10-20"});
    call(&engine, "record_follow_up", follow.clone());
    assert_eq!(
        error(&engine, "record_follow_up", follow.clone()).code,
        "VERSION_CONFLICT"
    );
    assert_eq!(center(&engine, &p, "2026-10-19")["counts"]["total"], 0);
    let due = center(&engine, &p, "2026-10-20");
    assert!(contains_reason(&due, &task, "follow_up"));
    assert!(due["items"][0]["draft"].as_str().unwrap().contains("小周"));
    assert!(due["items"][0]["draft"]
        .as_str()
        .unwrap()
        .contains("等待客户确认范围"));
    let snooze = json!({"taskId":task["id"],"baseVersion":1,"date":"2026-10-20","snoozedUntil":"2026-10-22"});
    call(&engine, "snooze_follow_up", snooze.clone());
    assert_eq!(
        error(&engine, "snooze_follow_up", snooze).code,
        "VERSION_CONFLICT"
    );
    assert_eq!(center(&engine, &p, "2026-10-21")["counts"]["actionable"], 0);
    assert_eq!(center(&engine, &p, "2026-10-21")["counts"]["snoozed"], 1);
    assert_eq!(center(&engine, &p, "2026-10-22")["counts"]["actionable"], 1);
    let mut invalid = follow.clone();
    invalid["baseVersion"] = json!(2);
    invalid["nextFollowUpDate"] = json!("2026-10-18");
    assert_eq!(
        error(&engine, "record_follow_up", invalid).code,
        "VALIDATION"
    );
    call(
        &engine,
        "record_follow_up",
        json!({"taskId":task["id"],"baseVersion":2,"workDate":"2026-10-22","note":"客户已回应，本次无需继续提醒","nextFollowUpDate":null}),
    );
    assert_eq!(center(&engine, &p, "2026-10-22")["counts"]["total"], 0);
    assert_eq!(
        center(&engine, &p, "2026-10-22")["history"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(error(&engine,"record_follow_up",json!({"taskId":task["id"],"baseVersion":3,"workDate":"2026-10-21","note":"倒序补录","nextFollowUpDate":null})).code,"WORK_DATE_ORDER");
    update_task(&engine, &task, "done", "2026-10-22");
    assert_eq!(center(&engine, &p, "2026-10-23")["counts"]["total"], 0);
    assert_eq!(error(&engine,"record_follow_up",json!({"taskId":task["id"],"baseVersion":3,"workDate":"2026-10-23","note":"已完结仍跟进","nextFollowUpDate":null})).code,"VALIDATION");
}

#[test]
fn project_and_milestone_versions_enforce_scope_and_completed_delivery() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path()).unwrap();
    let p = project(&engine, "交付项目");
    let other = project(&engine, "隔离项目");
    let task = create_task(
        &engine,
        &p,
        "接口交付",
        "action",
        "todo",
        Some("2026-10-18"),
        "2026-10-16",
    );
    let foreign = create_task(
        &engine,
        &other,
        "其他接口",
        "action",
        "todo",
        None,
        "2026-10-16",
    );
    let profile = json!({"projectId":p["id"],"goal":"按期完成客户联调","status":"active","targetDate":"2026-10-25","baseVersion":0});
    let saved = call(&engine, "save_project_profile", profile.clone());
    assert_eq!(saved["version"], 1);
    assert_eq!(
        error(&engine, "save_project_profile", profile).code,
        "VERSION_CONFLICT"
    );
    assert_eq!(
        error(
            &engine,
            "save_milestone",
            milestone_payload(&p, &[&foreign], "planned")
        )
        .code,
        "PROJECT_SCOPE"
    );
    assert_eq!(
        error(
            &engine,
            "save_milestone",
            milestone_payload(&p, &[&task], "completed")
        )
        .code,
        "MILESTONE_INCOMPLETE"
    );
    let m = call(
        &engine,
        "save_milestone",
        milestone_payload(&p, &[&task], "planned"),
    );
    let mut update = milestone_payload(&p, &[&task], "in_progress");
    update["milestoneId"] = m["id"].clone();
    update["baseVersion"] = json!(1);
    call(&engine, "save_milestone", update.clone());
    assert_eq!(
        error(&engine, "save_milestone", update.clone()).code,
        "VERSION_CONFLICT"
    );
    update["projectId"] = other["id"].clone();
    update["taskIds"] = json!([]);
    update["baseVersion"] = json!(2);
    assert_eq!(
        error(&engine, "save_milestone", update).code,
        "PROJECT_SCOPE"
    );
    let result = call(
        &engine,
        "get_delivery_overview",
        json!({"date":"2026-10-19","projectId":p["id"]}),
    );
    assert_eq!(result["projects"][0]["profile"]["goal"], "按期完成客户联调");
    assert_eq!(result["projects"][0]["milestones"][0]["slipDays"], 3);
    assert_eq!(result["projects"][0]["taskCounts"]["overdue"], 1);
    assert_eq!(result["projects"][0]["health"], "at_risk");
    let cancelled = update_task(&engine, &task, "cancelled", "2026-10-19");
    let mut complete = milestone_payload(&p, &[&task], "completed");
    complete["milestoneId"] = m["id"].clone();
    complete["baseVersion"] = json!(2);
    assert_eq!(
        error(&engine, "save_milestone", complete.clone()).code,
        "MILESTONE_INCOMPLETE"
    );
    let done = update_task(&engine, &cancelled, "done", "2026-10-19");
    call(&engine, "save_milestone", complete);
    update_task(&engine, &done, "in_progress", "2026-10-20");
    let reopened = call(
        &engine,
        "get_delivery_overview",
        json!({"date":"2026-10-20","projectId":p["id"]}),
    );
    assert_eq!(
        reopened["projects"][0]["milestones"][0]["completionBlocked"],
        true
    );
    assert!(reopened["projects"][0]["basis"]
        .as_array()
        .unwrap()
        .iter()
        .any(|b| b["label"] == "已完成里程碑有关联任务重新打开"));
    assert_eq!(
        call(
            &engine,
            "get_delivery_overview",
            json!({"date":"2026-10-20"})
        )["counts"]["projects"],
        2
    );
}

#[test]
fn dependency_on_a_cancelled_task_remains_a_delivery_blocker() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path()).unwrap();
    let p = project(&engine, "依赖阻塞");
    let task = create_task(
        &engine,
        &p,
        "等待接口联调",
        "action",
        "todo",
        None,
        "2026-10-16",
    );
    let prerequisite = create_task(
        &engine,
        &p,
        "已取消但未交付接口",
        "action",
        "cancelled",
        None,
        "2026-10-16",
    );
    drop(engine);
    let conn = rusqlite::Connection::open(dir.path().join("workspace.sqlite")).unwrap();
    conn.execute("INSERT INTO task_relations VALUES ('test-dependency','dependency',?,?,'前置交付尚未完成','[]',1,'2026-10-19T00:00:00Z')",rusqlite::params![task["id"].as_str(),prerequisite["id"].as_str()]).unwrap();
    drop(conn);
    let engine = Engine::open(dir.path()).unwrap();
    let view = call(
        &engine,
        "get_delivery_overview",
        json!({"date":"2026-10-19","projectId":p["id"]}),
    );
    assert_eq!(view["projects"][0]["health"], "blocked");
    assert_eq!(view["counts"]["blockedTasks"], 1);
    assert_eq!(
        view["projects"][0]["blockers"][0]["relations"][0]["targetId"],
        prerequisite["id"]
    );
}

#[test]
fn delivery_and_follow_up_data_survive_restart_and_backup_restore() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path()).unwrap();
    let p = project(&engine, "持久化项目");
    let task = create_task(
        &engine,
        &p,
        "待交付",
        "action",
        "in_progress",
        Some("2026-10-20"),
        "2026-10-16",
    );
    call(
        &engine,
        "save_project_profile",
        json!({"projectId":p["id"],"goal":"验收上线","status":"active","targetDate":"2026-10-25","baseVersion":0}),
    );
    call(
        &engine,
        "save_milestone",
        milestone_payload(&p, &[&task], "in_progress"),
    );
    call(
        &engine,
        "record_follow_up",
        json!({"taskId":task["id"],"baseVersion":0,"workDate":"2026-10-19","note":"等待负责人反馈","nextFollowUpDate":"2026-10-20"}),
    );
    call(
        &engine,
        "snooze_follow_up",
        json!({"taskId":task["id"],"baseVersion":1,"date":"2026-10-19","snoozedUntil":"2026-10-22"}),
    );
    let before_overview = call(
        &engine,
        "get_delivery_overview",
        json!({"date":"2026-10-20"}),
    );
    let before_center = center(&engine, &p, "2026-10-20");
    let backup = call(&engine, "create_backup", json!({}));
    let bytes = std::fs::read(
        dir.path()
            .join("backups")
            .join(backup["filename"].as_str().unwrap()),
    )
    .unwrap();
    drop(engine);
    let engine = Engine::open(dir.path()).unwrap();
    assert_eq!(
        call(
            &engine,
            "get_delivery_overview",
            json!({"date":"2026-10-20"})
        ),
        before_overview
    );
    assert_eq!(center(&engine, &p, "2026-10-20"), before_center);
    call(
        &engine,
        "save_project_profile",
        json!({"projectId":p["id"],"goal":"修改后目标","status":"on_hold","targetDate":null,"baseVersion":1}),
    );
    call(
        &engine,
        "record_follow_up",
        json!({"taskId":task["id"],"baseVersion":2,"workDate":"2026-10-20","note":"已重新跟进","nextFollowUpDate":null}),
    );
    call(
        &engine,
        "restore_backup",
        json!({"filename":backup["filename"],"contentBase64":BASE64.encode(bytes),"confirmation":"RESTORE"}),
    );
    assert_eq!(
        call(
            &engine,
            "get_delivery_overview",
            json!({"date":"2026-10-20"})
        ),
        before_overview
    );
    assert_eq!(center(&engine, &p, "2026-10-20"), before_center);
}

#[test]
fn schema_five_workspace_migrates_without_changing_existing_projects_and_tasks() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path()).unwrap();
    let p = project(&engine, "老工作区");
    let task = create_task(
        &engine,
        &p,
        "原有任务",
        "action",
        "todo",
        None,
        "2026-10-16",
    );
    drop(engine);
    let conn = rusqlite::Connection::open(dir.path().join("workspace.sqlite")).unwrap();
    conn.execute_batch("DROP TABLE assistant_turns;DROP TABLE assistant_sessions;DROP TABLE workspace_drafts;DROP TABLE workspace_lifecycle_events;DROP TABLE workspace_lifecycle;DROP TABLE workspace_options;DROP TABLE extraction_drafts;DROP TABLE extraction_batches;DROP TABLE extraction_budget;DROP TABLE memory_lexical;DROP TABLE memory_lexical_state;DROP TABLE revision_facets;DROP TABLE proposal_facets;DROP TABLE extraction_assessments;DROP TABLE memory_corrections;DROP TABLE project_briefs;DROP TABLE assistant_preferences;DROP TABLE coordination_action_versions;DROP TABLE coordination_actions;DROP TABLE coordination_meeting_versions;DROP TABLE coordination_meetings;DROP TABLE coordination_report_versions;DROP TABLE coordination_reports;DROP TABLE deliverable_history;DROP TABLE deliverables;DROP TABLE change_request_history;DROP TABLE change_requests;DROP TABLE governance_revisions;DROP TABLE governance_items;DROP TABLE milestone_tasks;DROP TABLE milestones;DROP TABLE task_follow_ups;DROP TABLE task_follow_up_state;DROP TABLE project_profiles;PRAGMA user_version=5;").unwrap();
    drop(conn);
    let engine = Engine::open(dir.path()).unwrap();
    let state = call(&engine, "get_state", json!({}));
    assert_eq!(state["workspace"]["schemaVersion"], 12);
    assert_eq!(state["tasks"][0], task);
    let overview = call(
        &engine,
        "get_delivery_overview",
        json!({"date":"2026-10-19","projectId":p["id"]}),
    );
    assert_eq!(overview["projects"][0]["profile"]["version"], 0);
    assert_eq!(overview["projects"][0]["taskCounts"]["total"], 1);
    call(&engine, "create_backup", json!({}));
}

#[test]
fn completed_project_still_exposes_unfinished_tasks_and_milestones() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path()).unwrap();
    let p = project(&engine, "完成标记复核");
    call(
        &engine,
        "save_project_profile",
        json!({"projectId":p["id"],"goal":"验收交付","status":"completed","targetDate":null,"baseVersion":0}),
    );
    let view = || {
        call(
            &engine,
            "get_delivery_overview",
            json!({"date":"2026-10-19","projectId":p["id"]}),
        )
    };
    assert_eq!(view()["projects"][0]["health"], "completed");
    let task = create_task(
        &engine,
        &p,
        "未结交付",
        "action",
        "todo",
        None,
        "2026-10-16",
    );
    let with_task = view();
    assert_eq!(with_task["projects"][0]["profile"]["status"], "completed");
    assert_eq!(with_task["projects"][0]["health"], "at_risk");
    assert!(with_task["projects"][0]["basis"]
        .as_array()
        .unwrap()
        .iter()
        .any(
            |b| b["label"] == "项目标记完成但仍有未结任务/里程碑，请复核"
                && b["activeTaskCount"] == 1
                && b["openMilestoneCount"] == 0
        ));
    update_task(&engine, &task, "done", "2026-10-19");
    assert_eq!(view()["projects"][0]["health"], "completed");
    let payload = json!({"projectId":p["id"],"title":"尚待验收","description":"","status":"planned","baselineDate":"2026-10-25","forecastDate":"2026-10-25","taskIds":[]});
    let milestone = call(&engine, "save_milestone", payload.clone());
    let with_milestone = view();
    assert_eq!(with_milestone["projects"][0]["health"], "at_risk");
    assert!(with_milestone["projects"][0]["basis"]
        .as_array()
        .unwrap()
        .iter()
        .any(|b| b["activeTaskCount"] == 0 && b["openMilestoneCount"] == 1));
    let mut complete = payload;
    complete["milestoneId"] = milestone["id"].clone();
    complete["baseVersion"] = json!(1);
    complete["status"] = json!("completed");
    call(&engine, "save_milestone", complete);
    assert_eq!(view()["projects"][0]["health"], "completed");
}
