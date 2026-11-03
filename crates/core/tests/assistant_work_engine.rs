//! Public Engine acceptance for persistent local assistance. Uses temporary
//! workspaces and deterministic domain data; never contacts a model or Feishu.
use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::{Duration, Local};
use project_assistant_core::{Engine, Request};
use serde_json::{json, Value};

fn call(engine: &Engine, command: &str, payload: Value) -> Value {
    engine
        .execute(Request {
            command: command.into(),
            payload,
        })
        .unwrap_or_else(|error| panic!("{command}: {error}"))
}
fn rejected(engine: &Engine, command: &str, payload: Value) {
    assert!(engine
        .execute(Request {
            command: command.into(),
            payload
        })
        .is_err());
}
fn task(engine: &Engine, project: &Value) -> Value {
    call(
        engine,
        "create_task",
        json!({
            "projectId":project["id"], "title":"接口交付核实", "description":"需先交付接口再开展联调",
            "category":"follow_up", "assignee":"项目同事", "priority":"high", "status":"todo", "progress":0,
            "dueDate":(Local::now().date_naive()-Duration::days(1)).to_string(), "plannedDate":null,
            "workDate":Local::now().date_naive().to_string(), "clientRequestId":uuid::Uuid::new_v4().to_string()
        }),
    )
}
fn work(engine: &Engine, target: &Value) -> Value {
    let center = call(
        engine,
        "get_assistant_work",
        json!({"projectId":target["projectId"]}),
    );
    center["works"]
        .as_array()
        .unwrap()
        .iter()
        .find(|work| work["targetId"] == target["id"] && work["kind"] == "delay")
        .unwrap_or_else(|| panic!("No delay work: {center}"))
        .clone()
}

#[test]
fn event_intake_decision_and_restart_preserve_one_business_change() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path()).unwrap();
    let project = call(&engine, "create_project", json!({"name":"持续推进验收"}));
    let other = call(&engine, "create_project", json!({"name":"另一个项目"}));
    let target = task(&engine, &project);
    let initial = work(&engine, &target);
    assert_eq!(initial["status"], "ready");
    let scope = call(
        &engine,
        "get_assistant_work",
        json!({"projectId":other["id"]}),
    );
    assert!(scope["works"].as_array().unwrap().is_empty());
    call(&engine, "run_assistant_work", json!({}));
    assert_eq!(work(&engine, &target)["version"], initial["version"]);
    let next = (Local::now().date_naive() + Duration::days(3)).to_string();
    let decision = json!({"workId":initial["id"],"baseVersion":initial["version"],
        "decisionId":uuid::Uuid::new_v4().to_string(),"choice":"adopt_date",
        "proposedDate":next,"reviewAt":(chrono::Utc::now()+Duration::days(1)).to_rfc3339(),
        "note":"已核对交付安排，调整期限"});
    call(&engine, "decide_action_proposal", decision.clone());
    let after = call(&engine, "get_task", json!({"taskId":target["id"]}));
    assert_eq!(after["task"]["dueDate"], next);
    assert_eq!(after["task"]["status"], "todo");
    assert_eq!(
        after["task"]["version"].as_i64(),
        target["version"].as_i64().map(|v| v + 1)
    );
    call(&engine, "decide_action_proposal", decision.clone());
    assert_eq!(
        call(&engine, "get_task", json!({"taskId":target["id"]})),
        after
    );
    let mut altered = decision.clone();
    altered["proposedDate"] = json!((Local::now().date_naive() + Duration::days(5)).to_string());
    rejected(&engine, "decide_action_proposal", altered);
    drop(engine);
    let engine = Engine::open(dir.path()).unwrap();
    call(&engine, "decide_action_proposal", decision);
    assert_eq!(
        call(&engine, "get_task", json!({"taskId":target["id"]})),
        after
    );
}

#[test]
fn paused_work_and_restore_cannot_reuse_old_authority() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path()).unwrap();
    let project = call(&engine, "create_project", json!({"name":"恢复与暂停验收"}));
    let target = task(&engine, &project);
    let initial = work(&engine, &target);
    call(
        &engine,
        "pause_assistant_work",
        json!({"workId":initial["id"],"baseVersion":initial["version"],"paused":true}),
    );
    let paused = work(&engine, &target);
    assert_eq!(paused["status"], "paused");
    call(&engine, "run_assistant_work", json!({}));
    assert_eq!(work(&engine, &target)["status"], "paused");
    rejected(
        &engine,
        "decide_action_proposal",
        json!({"workId":initial["id"],"baseVersion":initial["version"],
        "decisionId":uuid::Uuid::new_v4().to_string(),"choice":"dismiss","note":"过期页面不能操作"}),
    );
    let backup = call(&engine, "create_backup", json!({}));
    let bytes = std::fs::read(
        dir.path()
            .join("backups")
            .join(backup["filename"].as_str().unwrap()),
    )
    .unwrap();
    let archive = json!({"filename":backup["filename"],"contentBase64":STANDARD.encode(bytes),"confirmation":"RESTORE"});
    call(&engine, "restore_backup", archive);
    let center = call(&engine, "get_assistant_work", json!({}));
    assert_eq!(center["settings"]["enabled"], false);
    assert!(center["history"]
        .as_array()
        .unwrap()
        .iter()
        .any(|entry| entry["workId"] == initial["id"]));
    drop(engine);
    let engine = Engine::open(dir.path()).unwrap();
    assert_eq!(
        call(&engine, "get_assistant_work", json!({}))["settings"]["enabled"],
        false
    );
    let current = call(&engine, "get_task", json!({"taskId":target["id"]}));
    assert_eq!(current["task"]["dueDate"], target["dueDate"]);
    assert_eq!(current["task"]["version"], target["version"]);
}
