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
        .unwrap()
}
fn ready(engine: &Engine, id: &Value) -> Value {
    let until = Instant::now() + Duration::from_secs(10);
    loop {
        let value = call(engine, "get_source", json!({"sourceId":id}));
        if value["source"]["status"] != "processing" {
            return value;
        }
        assert!(Instant::now() < until);
        thread::sleep(Duration::from_millis(10));
    }
}
#[test]
fn unicode_evidence_and_personal_correction() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path()).unwrap();
    let project = call(&engine, "create_project", json!({"name":"客户交付"}));
    let source = call(
        &engine,
        "import_text",
        json!({"projectId":project["id"],"title":"评审纪要","text":"一期先交付核心流程。\n张三负责接口，周五完成。"}),
    );
    let original = ready(&engine, &source["sourceId"]);
    assert_eq!(original["segments"][0]["text"], "一期先交付核心流程。\n");
    let p = call(
        &engine,
        "create_proposal",
        json!({"projectId":project["id"],"sourceId":source["sourceId"],"segmentIds":[original["segments"][0]["id"]],"kind":"decision","content":"一期交付核心流程"}),
    );
    let memory = call(&engine, "confirm_proposal", json!({"proposalId":p["id"]}));
    assert_eq!(
        memory,
        call(&engine, "confirm_proposal", json!({"proposalId":p["id"]}))
    );
    call(
        &engine,
        "revise_memory",
        json!({"memoryId":memory["id"],"baseRevision":1,"content":"一期还需交付报表","reason":"客户已电话确认","segmentIds":[]}),
    );
    let detail = call(&engine, "get_memory", json!({"memoryId":memory["id"]}));
    assert!(detail["revisions"][0]["evidence"]
        .as_array()
        .unwrap()
        .is_empty());
    assert_eq!(
        detail["revisions"][1]["evidence"][0]["text"],
        "一期先交付核心流程。\n"
    );
    assert_eq!(engine.execute(Request{command:"revise_memory".into(),payload:json!({"memoryId":memory["id"],"baseRevision":1,"content":"过期修改","reason":"测试"})}).unwrap_err().code,"REVISION_CONFLICT");
}
#[test]
fn workspace_lock_and_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path()).unwrap();
    assert!(matches!(Engine::open(dir.path()),Err(error)if error.code=="WORKSPACE_LOCKED"));
    let clone = engine.clone();
    drop(engine);
    assert!(Engine::open(dir.path()).is_err());
    drop(clone);
    let reopened = Engine::open(dir.path()).unwrap();
    assert_eq!(
        call(&reopened, "get_state", json!({}))["workspace"]["schemaVersion"],
        16
    );
}
#[test]
fn empty_pdf_failure_is_persisted() {
    use base64::Engine as _;
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path()).unwrap();
    let p = call(&engine, "create_project", json!({"name":"失败案例"}));
    let result = call(
        &engine,
        "import_file",
        json!({"projectId":p["id"],"filename":"broken.pdf","contentBase64":base64::engine::general_purpose::STANDARD.encode(b"%PDF-1.4 invalid")}),
    );
    let source = ready(&engine, &result["sourceId"]);
    assert_eq!(source["source"]["status"], "failed");
    assert!(source["source"]["error"].as_str().unwrap().contains("PDF"));
}

#[test]
fn reopen_proposal_and_public_command_allowlist_work() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path()).unwrap();
    let project = call(&engine, "create_project", json!({"name":"撤销测试"}));
    let source = call(
        &engine,
        "import_text",
        json!({"projectId":project["id"],"title":"会议纪要","text":"系统本周五上线。"}),
    );
    let original = ready(&engine, &source["sourceId"]);
    let p = call(
        &engine,
        "create_proposal",
        json!({"projectId":project["id"],"sourceId":source["sourceId"],"segmentIds":[original["segments"][0]["id"]],"kind":"fact","content":"系统本周五上线"}),
    );
    let rejected = call(&engine, "reject_proposal", json!({"proposalId":p["id"]}));
    assert_eq!(rejected["status"], "rejected");
    let reopened = call(&engine, "reopen_proposal", json!({"proposalId":p["id"]}));
    assert_eq!(reopened["status"], "pending");
    let memory = call(&engine, "confirm_proposal", json!({"proposalId":p["id"]}));
    assert_eq!(memory["content"], "系统本周五上线");

    for cmd in [
        "list_entity_aliases",
        "save_entity_alias",
        "delete_entity_alias",
        "get_habits_center",
        "resolve_habit_proposal",
        "save_user_habit",
        "update_habit_status",
        "delete_user_habit",
        "record_copilot_feedback",
        "record_habit_outcome",
        "get_memory_audits",
        "run_memory_audit",
        "resolve_memory_audit",
        "get_semantic_search_status",
        "save_semantic_search_settings",
        "test_embedding_connection",
        "rebuild_semantic_index",
        "search_verified_memories",
        "reopen_proposal",
        "reopen_task_proposal",
        "restore_task_relation",
        "reopen_planning_draft",
    ] {
        assert!(
            project_assistant_core::is_public_command(cmd),
            "missing public command in allowlist: {cmd}"
        );
    }
    assert!(!project_assistant_core::is_public_command("_internal"));
}
