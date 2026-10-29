use base64::{engine::general_purpose::STANDARD, Engine as _};
use project_assistant_core::{Engine, Request};
use serde_json::{json, Value};
use std::{
    thread,
    time::{Duration, Instant},
};
fn call(e: &Engine, c: &str, p: Value) -> Value {
    e.execute(Request {
        command: c.into(),
        payload: p,
    })
    .unwrap_or_else(|err| panic!("{c}: {err}"))
}
fn fail(e: &Engine, c: &str, p: Value) -> String {
    e.execute(Request {
        command: c.into(),
        payload: p,
    })
    .unwrap_err()
    .code
}
fn project(e: &Engine) -> Value {
    call(e, "create_project", json!({"name":"验收项目"}))
}
fn memory(e: &Engine, p: &Value) -> (Value, Value) {
    let imported = call(
        e,
        "import_text",
        json!({"projectId":p["id"],"title":"Atlas发布约定","text":"Atlas发布由小林负责，仅限测试环境。"}),
    );
    let start = Instant::now();
    let source = loop {
        let v = call(e, "get_source", json!({"sourceId":imported["sourceId"]}));
        if v["source"]["status"] == "ready" {
            break v;
        }
        assert!(start.elapsed() < Duration::from_secs(10));
        thread::sleep(Duration::from_millis(10));
    };
    let proposal = call(
        e,
        "create_proposal",
        json!({"projectId":p["id"],"sourceId":source["source"]["id"],"content":"Atlas发布由小林负责，仅限测试环境。","kind":"fact","segmentIds":[source["segments"][0]["id"]]}),
    );
    (
        call(e, "confirm_proposal", json!({"proposalId":proposal["id"]})),
        source,
    )
}
#[test]
fn drafts_survive_restart_and_restore_and_reject_stale_writes() {
    let dir = tempfile::tempdir().unwrap();
    let e = Engine::open(dir.path()).unwrap();
    call(
        &e,
        "save_draft",
        json!({"key":"report:sample","baseVersion":0,"body":"未保存但重要的正文"}),
    );
    assert_eq!(
        fail(
            &e,
            "save_draft",
            json!({"key":"report:sample","baseVersion":0,"body":"过期覆盖"})
        ),
        "DRAFT_CONFLICT"
    );
    let backup = call(&e, "create_backup", json!({}));
    drop(e);
    let e = Engine::open(dir.path()).unwrap();
    assert_eq!(
        call(&e, "get_draft", json!({"key":"report:sample"}))["body"],
        "未保存但重要的正文"
    );
    call(
        &e,
        "delete_draft",
        json!({"key":"report:sample","baseVersion":1}),
    );
    let bytes = std::fs::read(
        dir.path()
            .join("backups")
            .join(backup["filename"].as_str().unwrap()),
    )
    .unwrap();
    call(
        &e,
        "restore_backup",
        json!({"filename":backup["filename"],"contentBase64":STANDARD.encode(bytes),"confirmation":"RESTORE"}),
    );
    assert_eq!(
        call(&e, "get_draft", json!({"key":"report:sample"}))["body"],
        "未保存但重要的正文"
    );
}
#[test]
fn review_preserves_evidence_and_conflict_guard() {
    let dir = tempfile::tempdir().unwrap();
    let e = Engine::open(dir.path()).unwrap();
    let p = project(&e);
    let (m, s) = memory(&e, &p);
    call(
        &e,
        "revise_memory",
        json!({"memoryId":m["id"],"baseRevision":1,"content":m["content"],"reason":"暂时工作状态","segmentIds":[s["segments"][0]["id"]],"retention":{"layer":"working","reason":"待核对","reviewAfter":"2026-01-01"}}),
    );
    assert_eq!(
        call(&e, "get_retention_reviews", json!({"date":"2026-10-28"}))["total"],
        1
    );
    let request = json!({"memoryId":m["id"],"baseRevision":2,"date":"2026-10-28","reason":"已与负责人核实","retention":{"layer":"working","reason":"继续跟进","reviewAfter":"2026-11-04"}});
    let next = call(&e, "review_retention", request.clone());
    assert_eq!(next["revision"], 3);
    assert_eq!(fail(&e, "review_retention", request), "REVISION_CONFLICT");
    let detail = call(&e, "get_memory", json!({"memoryId":m["id"]}));
    assert_eq!(
        detail["revisions"][0]["evidence"][0]["segmentId"],
        s["segments"][0]["id"]
    );
    assert_eq!(
        call(&e, "get_retention_reviews", json!({"date":"2026-10-28"}))["total"],
        0
    );
}
#[test]
fn lifecycle_preview_and_search_and_current_qa_are_consistent() {
    let dir = tempfile::tempdir().unwrap();
    let e = Engine::open(dir.path()).unwrap();
    let p = project(&e);
    let (m, s) = memory(&e, &p);
    let results = call(&e, "search_workspace", json!({"query":"Atlas"}));
    assert!(results["total"].as_i64().unwrap() >= 2);
    let mut impact = call(
        &e,
        "lifecycle_impact",
        json!({"kind":"source","id":s["source"]["id"]}),
    );
    assert_eq!(impact["memories"], 1);
    impact["archived"] = json!(true);
    impact["reason"] = json!("误导入的旧约定");
    call(&e, "set_lifecycle", impact.clone());
    assert_eq!(fail(&e, "set_lifecycle", impact), "REVISION_CONFLICT");
    let answer = call(
        &e,
        "ask_assistant",
        json!({"projectId":p["id"],"date":"2026-10-28","question":"Atlas发布由谁负责？","useModel":false}),
    );
    assert!(!answer["citations"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["memoryId"] == m["id"]));
    assert_eq!(
        call(&e, "get_source", json!({"sourceId":s["source"]["id"]}))["segments"],
        s["segments"]
    );
    let mut impact = call(
        &e,
        "lifecycle_impact",
        json!({"kind":"source","id":s["source"]["id"]}),
    );
    impact["archived"] = json!(false);
    impact["reason"] = json!("恢复使用");
    call(&e, "set_lifecycle", impact);
    assert!(
        call(
            &e,
            "search_workspace",
            json!({"query":"Atlas","kind":"source"})
        )["total"]
            .as_i64()
            .unwrap()
            > 0
    );
}
#[test]
fn conversations_retain_history_and_favorites_across_restart() {
    let dir = tempfile::tempdir().unwrap();
    let e = Engine::open(dir.path()).unwrap();
    let p = project(&e);
    let _ = memory(&e, &p);
    let session = call(&e, "create_conversation", json!({"projectId":p["id"]}));
    let result = call(
        &e,
        "ask_conversation",
        json!({"sessionId":session["id"],"question":"Atlas发布由谁负责？","date":"2026-10-28","useModel":false}),
    );
    call(
        &e,
        "favorite_answer",
        json!({"turnId":result["turnId"],"favorite":true}),
    );
    call(
        &e,
        "ask_conversation",
        json!({"sessionId":session["id"],"question":"限什么环境？","subject":"Atlas发布","followUp":true,"date":"2026-10-28","useModel":false}),
    );
    drop(e);
    let e = Engine::open(dir.path()).unwrap();
    let saved = call(&e, "get_conversation", json!({"sessionId":session["id"]}));
    assert_eq!(saved["turns"].as_array().unwrap().len(), 2);
    assert_eq!(saved["turns"][0]["favorite"], true);
    assert_eq!(
        saved["turns"][1]["resolvedQuestion"],
        "针对「Atlas发布」，限什么环境？"
    );
}
#[test]
fn automatic_backup_is_opt_in_and_restore_pauses_it() {
    let dir = tempfile::tempdir().unwrap();
    let e = Engine::open(dir.path()).unwrap();
    project(&e);
    assert_eq!(
        call(&e, "run_automatic_backup", json!({}))["created"],
        false
    );
    call(
        &e,
        "save_backup_policy",
        json!({"enabled":true,"intervalHours":24,"keep":3}),
    );
    let result = call(&e, "run_automatic_backup", json!({}));
    assert_eq!(result["created"], true);
    assert_eq!(
        call(&e, "run_automatic_backup", json!({}))["created"],
        false
    );
    let b = &result["backup"];
    let bytes = std::fs::read(
        dir.path()
            .join("backups")
            .join(b["filename"].as_str().unwrap()),
    )
    .unwrap();
    call(
        &e,
        "restore_backup",
        json!({"filename":b["filename"],"contentBase64":STANDARD.encode(bytes),"confirmation":"RESTORE"}),
    );
    assert_eq!(call(&e, "get_backup_policy", json!({}))["enabled"], false);
}

fn task(e: &Engine, p: &Value, title: &str) -> Value {
    call(
        e,
        "create_task",
        json!({"projectId":p["id"],"title":title,"description":"","category":"action","assignee":null,"priority":"high","status":"todo","progress":0,"dueDate":"2026-01-01","plannedDate":null,"workDate":"2026-01-01","clientRequestId":uuid::Uuid::new_v4().to_string()}),
    )
}
#[test]
fn batch_planning_is_atomic_idempotent_and_backup_valid() {
    let dir = tempfile::tempdir().unwrap();
    let e = Engine::open(dir.path()).unwrap();
    let p = project(&e);
    let a = task(&e, &p, "安排A");
    let b = task(&e, &p, "安排B");
    let mut request = json!({"tasks":[{"taskId":a["id"],"baseVersion":1},{"taskId":b["id"],"baseVersion":0}],"plannedDate":"2026-10-29","workDate":"2026-10-28","note":"统一协调","clientRequestId":uuid::Uuid::new_v4().to_string()});
    assert_eq!(
        fail(&e, "batch_schedule_tasks", request.clone()),
        "VERSION_CONFLICT"
    );
    assert_eq!(
        call(&e, "get_task", json!({"taskId":a["id"]}))["task"]["version"],
        1
    );
    request["tasks"][1]["baseVersion"] = json!(1);
    let result = call(&e, "batch_schedule_tasks", request.clone());
    assert_eq!(result["tasks"][0]["plannedDate"], "2026-10-29");
    assert_eq!(call(&e, "batch_schedule_tasks", request), result);
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
        json!({"filename":backup["filename"],"contentBase64":STANDARD.encode(bytes)}),
    );
}
#[test]
fn digest_merges_deduplicates_and_excludes_archived_projects() {
    let dir = tempfile::tempdir().unwrap();
    let e = Engine::open(dir.path()).unwrap();
    let p = project(&e);
    task(&e, &p, "逾期待跟进");
    assert_eq!(call(&e, "get_notification_digest", json!({})), Value::Null);
    call(
        &e,
        "save_desktop_settings",
        json!({"background":false,"notifications":true,"autostart":false,"quietStart":"00:00","quietEnd":"00:00"}),
    );
    let digest = call(&e, "get_notification_digest", json!({}));
    assert!(digest["signature"].is_string());
    assert!(!digest["body"].as_str().unwrap().contains("逾期待跟进"));
    call(
        &e,
        "ack_notification",
        json!({"signature":digest["signature"]}),
    );
    assert_eq!(call(&e, "get_notification_digest", json!({})), Value::Null);
    let mut impact = call(
        &e,
        "lifecycle_impact",
        json!({"kind":"project","id":p["id"]}),
    );
    impact["archived"] = json!(true);
    impact["reason"] = json!("项目结束");
    call(&e, "set_lifecycle", impact);
    assert_eq!(call(&e, "get_notification_digest", json!({})), Value::Null);
}
#[test]
fn encrypted_backup_inspection_and_restore() {
    let dir = tempfile::tempdir().unwrap();
    let e = Engine::open(dir.path()).unwrap();
    let p = project(&e);
    task(&e, &p, "加密恢复验收");
    let b = call(&e, "create_backup", json!({}));
    let bytes = std::fs::read(
        dir.path()
            .join("backups")
            .join(b["filename"].as_str().unwrap()),
    )
    .unwrap();
    let encoded =
        project_assistant_core::encrypt_backup_bytes(&bytes, "synthetic-passphrase-123").unwrap();
    let payload = json!({"filename":"fixture.pabackup","contentBase64":STANDARD.encode(encoded),"password":"synthetic-passphrase-123","confirmation":"RESTORE"});
    call(&e, "inspect_backup", payload.clone());
    call(&e, "restore_backup", payload);
    assert_eq!(
        call(&e, "get_state", json!({}))["tasks"][0]["title"],
        "加密恢复验收"
    );
}
