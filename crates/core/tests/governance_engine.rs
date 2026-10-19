//! End-to-end coverage of accountable risk, issue and decision registers.
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use project_assistant_core::{AppError, Engine, Request};
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
fn fields(project: &Value, kind: &str) -> Value {
    json!({"projectId":project["id"],"kind":kind,"title":"核心接口交付需要确认","description":"联调依赖核心接口","owner":"小周","severity":"high","impact":"可能影响周五联调","responsePlan":"准备替代接口并在周三复核","dueDate":"2026-10-20","reviewDate":"2026-10-19","escalationTo":"","status":"open","decisionMaker":"","conclusion":"","resolution":"","closureReason":"","links":[],"evidenceIds":[],"workDate":"2026-10-18","note":"首次登记"})
}
fn edit(value: &Value, status: &str, date: &str) -> Value {
    let mut p = value.clone();
    p["itemId"] = value["id"].clone();
    p["baseVersion"] = value["version"].clone();
    p["status"] = json!(status);
    p["workDate"] = json!(date);
    p["note"] = json!("更新处理记录");
    p
}
fn workspace(engine: &Engine, project: &Value, date: &str) -> Value {
    call(
        engine,
        "get_governance_workspace",
        json!({"projectId":project["id"],"date":date}),
    )
}
fn memory(engine: &Engine, project: &Value) -> (Value, Value) {
    let imported = call(
        engine,
        "import_text",
        json!({"projectId":project["id"],"title":"评审纪要","text":"核心接口延期会影响周五联调。"}),
    );
    let until = Instant::now() + Duration::from_secs(10);
    let source = loop {
        let value = call(
            engine,
            "get_source",
            json!({"sourceId":imported["sourceId"]}),
        );
        if value["source"]["status"] != "processing" {
            assert_eq!(value["source"]["status"], "ready");
            break value;
        }
        assert!(Instant::now() < until);
        thread::sleep(Duration::from_millis(10));
    };
    let proposal = call(
        engine,
        "create_proposal",
        json!({"projectId":project["id"],"sourceId":imported["sourceId"],"kind":"risk","content":"核心接口延期风险","segmentIds":[source["segments"][0]["id"]]}),
    );
    (
        call(
            engine,
            "confirm_proposal",
            json!({"proposalId":proposal["id"]}),
        ),
        source,
    )
}

#[test]
fn decision_closure_requires_result_reason_and_decider_reopening_preserves_history() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path()).unwrap();
    let p = project(&engine, "决策闭环");
    let decision = call(&engine, "save_governance_item", fields(&p, "decision"));
    let mut close = edit(&decision, "closed", "2026-10-19");
    for field in ["resolution", "closureReason", "decisionMaker", "conclusion"] {
        assert_eq!(
            error(&engine, "save_governance_item", close.clone()).code,
            "VALIDATION"
        );
        close[field] = json!(format!("已填写 {field}"));
        assert_eq!(
            call(
                &engine,
                "get_governance_item",
                json!({"itemId":decision["id"]})
            )["revisions"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }
    let closed = call(&engine, "save_governance_item", close.clone());
    assert_eq!(closed["version"], 2);
    assert_eq!(
        error(
            &engine,
            "save_governance_item",
            edit(&closed, "closed", "2026-10-19")
        )
        .code,
        "VALIDATION"
    );
    assert_eq!(
        error(
            &engine,
            "record_governance_progress",
            json!({"itemId":closed["id"],"baseVersion":2,"workDate":"2026-10-19","note":"试图修改"})
        )
        .code,
        "VALIDATION"
    );
    let mut reopen = edit(&closed, "in_progress", "2026-10-20");
    reopen["note"] = json!("客户提出新约束，需要重新决策");
    reopen["resolution"] = json!("");
    reopen["closureReason"] = json!("");
    reopen["decisionMaker"] = json!("");
    reopen["conclusion"] = json!("");
    let reopened = call(&engine, "save_governance_item", reopen);
    assert_eq!(reopened["status"], "in_progress");
    let detail = call(
        &engine,
        "get_governance_item",
        json!({"itemId":closed["id"]}),
    );
    assert_eq!(detail["revisions"][1]["eventType"], "closed");
    assert_eq!(
        detail["revisions"][1]["snapshot"]["conclusion"],
        "已填写 conclusion"
    );
    assert_eq!(detail["revisions"][2]["eventType"], "reopened");
    assert_eq!(detail["revisions"][2]["snapshot"]["conclusion"], "");
}

#[test]
fn scope_date_version_and_escalation_are_enforced_atomically() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path()).unwrap();
    let p = project(&engine, "问题闭环");
    let other = project(&engine, "其他项目");
    let mut invalid = fields(&p, "issue");
    invalid["workDate"] = json!("2026-02-30");
    assert_eq!(
        error(&engine, "save_governance_item", invalid).code,
        "VALIDATION"
    );
    let mut invalid = fields(&p, "issue");
    invalid["status"] = json!("escalated");
    assert_eq!(
        error(&engine, "save_governance_item", invalid.clone()).code,
        "VALIDATION"
    );
    invalid["escalationTo"] = json!("项目经理");
    let item = call(&engine, "save_governance_item", invalid);
    let mut cross = edit(&item, "open", "2026-10-19");
    cross["projectId"] = other["id"].clone();
    assert_eq!(
        error(&engine, "save_governance_item", cross).code,
        "PROJECT_SCOPE"
    );
    assert_eq!(
        error(
            &engine,
            "record_governance_progress",
            json!({"itemId":item["id"],"baseVersion":1,"workDate":"2026-10-17","note":"逆序记录"})
        )
        .code,
        "VALIDATION"
    );
    let progress = call(
        &engine,
        "record_governance_progress",
        json!({"itemId":item["id"],"baseVersion":1,"workDate":"2026-10-19","note":"已向负责人确认补救方案"}),
    );
    assert_eq!(progress["version"], 2);
    assert_eq!(
        error(
            &engine,
            "save_governance_item",
            edit(&item, "in_progress", "2026-10-19")
        )
        .code,
        "VERSION_CONFLICT"
    );
    let detail = call(&engine, "get_governance_item", json!({"itemId":item["id"]}));
    assert_eq!(detail["revisions"].as_array().unwrap().len(), 2);
    assert_eq!(detail["revisions"][1]["eventType"], "progress");
    assert_eq!(
        detail["revisions"][1]["snapshot"]["responsePlan"],
        item["responsePlan"]
    );
    assert!(workspace(&engine, &other, "2026-10-19")["items"]
        .as_array()
        .unwrap()
        .is_empty());
}

#[test]
fn memory_drafts_require_confirmation_and_same_project_current_references_and_evidence() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path()).unwrap();
    let p = project(&engine, "来源闭环");
    let other = project(&engine, "其他项目");
    let (risk, source) = memory(&engine, &p);
    let view = workspace(&engine, &p, "2026-10-19");
    assert_eq!(view["memoryDrafts"][0]["memoryId"], risk["id"]);
    assert!(view["items"].as_array().unwrap().is_empty());
    let mut draft = fields(&p, "risk");
    draft["links"] = json!([{"kind":"memory","id":risk["id"],"version":1}]);
    draft["evidenceIds"] = json!([source["segments"][0]["id"]]);
    let mut cross = draft.clone();
    cross["projectId"] = other["id"].clone();
    assert_eq!(
        error(&engine, "save_governance_item", cross).code,
        "PROJECT_SCOPE"
    );
    let mut evidence_cross = draft.clone();
    evidence_cross["projectId"] = other["id"].clone();
    evidence_cross["links"] = json!([]);
    assert_eq!(
        error(&engine, "save_governance_item", evidence_cross).code,
        "EVIDENCE_SCOPE"
    );
    let saved = call(&engine, "save_governance_item", draft.clone());
    assert_eq!(
        call(
            &engine,
            "get_governance_item",
            json!({"itemId":saved["id"]})
        )["evidence"][0]["text"],
        source["segments"][0]["text"]
    );
    call(
        &engine,
        "revise_memory",
        json!({"memoryId":risk["id"],"baseRevision":1,"content":"接口已有备选方案，但仍需复核","reason":"评审更新","segmentIds":[]}),
    );
    assert_eq!(
        error(&engine, "save_governance_item", draft.clone()).code,
        "REFERENCE_STALE"
    );
    let view = workspace(&engine, &p, "2026-10-19");
    assert!(view["items"][0]["attention"]
        .as_array()
        .unwrap()
        .iter()
        .any(|v| v["kind"] == "reference_stale"));
    draft["links"][0]["version"] = json!(2);
    call(&engine, "save_governance_item", draft);
    let memory_after = call(&engine, "get_memory", json!({"memoryId":risk["id"]}));
    assert_eq!(memory_after["memory"]["revision"], 2);
    // An old reference is legitimate audit evidence once the source is revised.
    let backup = call(&engine, "create_backup", json!({}));
    let bytes = std::fs::read(
        dir.path()
            .join("backups")
            .join(backup["filename"].as_str().unwrap()),
    )
    .unwrap();
    call(
        &engine,
        "inspect_backup",
        json!({"filename":backup["filename"],"contentBase64":BASE64.encode(bytes)}),
    );
}

#[test]
fn task_and_milestone_links_reject_cross_project_and_outdated_versions() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path()).unwrap();
    let p = project(&engine, "依赖工作");
    let other = project(&engine, "其他项目");
    let task = call(
        &engine,
        "create_task",
        json!({"projectId":p["id"],"title":"核心接口","description":"","category":"action","assignee":null,"priority":"medium","status":"todo","progress":0,"dueDate":null,"plannedDate":null,"workDate":"2026-10-18","clientRequestId":uuid::Uuid::new_v4().to_string()}),
    );
    let milestone = call(
        &engine,
        "save_milestone",
        json!({"projectId":p["id"],"title":"联调","description":"","status":"planned","baselineDate":"2026-10-23","forecastDate":"2026-10-23","taskIds":[task["id"]]}),
    );
    let mut value = fields(&p, "risk");
    value["links"] = json!([{"kind":"task","id":task["id"],"version":1},{"kind":"milestone","id":milestone["id"],"version":1}]);
    call(&engine, "save_governance_item", value.clone());
    value["projectId"] = other["id"].clone();
    assert_eq!(
        error(&engine, "save_governance_item", value.clone()).code,
        "PROJECT_SCOPE"
    );
    value["projectId"] = p["id"].clone();
    value["links"][1]["version"] = json!(2);
    assert_eq!(
        error(&engine, "save_governance_item", value.clone()).code,
        "REFERENCE_STALE"
    );
    let mut update = task.clone();
    update["taskId"] = task["id"].clone();
    update["baseVersion"] = json!(1);
    update["workDate"] = json!("2026-10-19");
    update["note"] = json!("开始执行");
    update["status"] = json!("in_progress");
    update["clientRequestId"] = json!(uuid::Uuid::new_v4().to_string());
    call(&engine, "update_task", update);
    value["links"][1]["version"] = json!(1);
    assert_eq!(
        error(&engine, "save_governance_item", value).code,
        "REFERENCE_STALE"
    );
}

#[test]
fn attention_respects_selected_date_terminal_status_and_survives_reopen_restore() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path()).unwrap();
    let p = project(&engine, "重启与备份");
    let mut value = fields(&p, "risk");
    value["reviewDate"] = Value::Null;
    let risk = call(&engine, "save_governance_item", value);
    assert_eq!(
        workspace(&engine, &p, "2026-10-20")["counts"]["attention"],
        0
    );
    assert_eq!(
        workspace(&engine, &p, "2026-10-21")["counts"]["attention"],
        1
    );
    let before = call(&engine, "get_governance_item", json!({"itemId":risk["id"]}));
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
        call(&engine, "get_governance_item", json!({"itemId":risk["id"]})),
        before
    );
    let mut close = edit(&risk, "closed", "2026-10-21");
    close["resolution"] = json!("备选接口完成联调");
    close["closureReason"] = json!("风险已消除");
    call(&engine, "save_governance_item", close);
    assert_eq!(
        workspace(&engine, &p, "2026-10-22")["counts"]["attention"],
        0
    );
    call(
        &engine,
        "restore_backup",
        json!({"filename":backup["filename"],"contentBase64":BASE64.encode(bytes),"confirmation":"RESTORE"}),
    );
    assert_eq!(
        call(&engine, "get_governance_item", json!({"itemId":risk["id"]})),
        before
    );
    assert_eq!(
        workspace(&engine, &p, "2026-10-21")["counts"]["attention"],
        1
    );
}
