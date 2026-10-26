//! Public API regression coverage for schema 8 memory features. No cloud model,
//! user workspace, external account or real project material is used.
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
fn source(engine: &Engine, p: &Value, content: &str) -> Value {
    let imported = call(
        engine,
        "import_text",
        json!({"projectId":p["id"],"title":"验收纪要","text":content}),
    );
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let source = call(
            engine,
            "get_source",
            json!({"sourceId":imported["sourceId"]}),
        );
        if source["source"]["status"] != "processing" {
            assert_eq!(source["source"]["status"], "ready");
            return source;
        }
        assert!(Instant::now() < deadline, "source parsing timed out");
        thread::sleep(Duration::from_millis(10));
    }
}
fn memory(engine: &Engine, p: &Value, content: &str) -> (Value, Value, Value) {
    let s = source(engine, p, content);
    let proposal = call(
        engine,
        "create_proposal",
        json!({"projectId":p["id"],"sourceId":s["source"]["id"],"segmentIds":[s["segments"][0]["id"]],"kind":"decision","content":content}),
    );
    let m = call(
        engine,
        "confirm_proposal",
        json!({"proposalId":proposal["id"]}),
    );
    (m, s, proposal)
}
fn revise(engine: &Engine, m: &Value, content: &str) -> Value {
    call(
        engine,
        "revise_memory",
        json!({"memoryId":m["id"],"baseRevision":m["revision"],"content":content,"reason":"依据最新确认更正负责人","question":"支付接口验收由谁负责？","segmentIds":[]}),
    )
}

#[test]
fn organized_facets_are_atomic_revision_bound_and_survive_restore() {
    let dir = tempfile::tempdir().unwrap();
    let e = Engine::open(dir.path()).unwrap();
    let p = project(&e, "事实组织");
    let content = "泽川采购审批由李思负责；仅限硬件密钥。";
    let (m, _, _) = memory(&e, &p, content);
    let facets =
        json!({"entity":"泽川","topic":"采购审批","role":"approver","conditions":["仅限硬件密钥"]});
    let organized = call(
        &e,
        "revise_memory",
        json!({"memoryId":m["id"],"baseRevision":1,"content":content,"reason":"明确事项及角色","facets":facets,"segmentIds":[]}),
    );
    let detail = call(&e, "get_memory", json!({"memoryId":m["id"]}));
    assert_eq!(detail["revisions"][0]["facets"]["entity"], "泽川");
    assert_eq!(detail["revisions"][0]["facets"]["role"], "approver");
    let invalid = json!({"memoryId":m["id"],"baseRevision":2,"content":content,"reason":"无效主体","facets":{"entity":"天衡"},"segmentIds":[]});
    assert_eq!(error(&e, "revise_memory", invalid).code, "VALIDATION");
    assert_eq!(call(&e, "get_memory", json!({"memoryId":m["id"]})), detail);
    call(
        &e,
        "ask_assistant",
        json!({"projectId":p["id"],"question":"泽川采购审批","date":"2026-10-20"}),
    );
    let backup = call(&e, "create_backup", json!({}));
    let bytes = std::fs::read(
        dir.path()
            .join("backups")
            .join(backup["filename"].as_str().unwrap()),
    )
    .unwrap();
    revise(&e, &organized, "泽川采购审批尚未指定审批人。");
    assert_eq!(
        call(&e, "get_memory", json!({"memoryId":m["id"]}))["revisions"][0]["facets"],
        json!({})
    );
    call(
        &e,
        "restore_backup",
        json!({"filename":backup["filename"],"contentBase64":BASE64.encode(bytes),"confirmation":"RESTORE"}),
    );
    assert_eq!(
        call(&e, "get_memory", json!({"memoryId":m["id"]}))["revisions"][0]["facets"]["role"],
        "approver"
    );
    let conn = rusqlite::Connection::open(dir.path().join("workspace.sqlite")).unwrap();
    assert_eq!(
        conn.query_row("SELECT count(*) FROM memory_lexical_state", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    drop(conn);
    let answer = call(
        &e,
        "ask_assistant",
        json!({"projectId":p["id"],"question":"泽川采购审批","date":"2026-10-20"}),
    );
    assert_eq!(
        answer["context"]["memories"][0]["facets"]["role"],
        "approver"
    );
    drop(e);
    let conn = rusqlite::Connection::open(dir.path().join("workspace.sqlite")).unwrap();
    conn.execute_batch("DROP TABLE extraction_drafts; DROP TABLE extraction_batches; DROP TABLE extraction_budget; DROP TABLE memory_lexical; DROP TABLE memory_lexical_state; DROP TABLE revision_facets; DROP TABLE proposal_facets; PRAGMA user_version=8;").unwrap();
    drop(conn);
    let reopened = Engine::open(dir.path()).unwrap();
    assert_eq!(
        call(&reopened, "get_state", json!({}))["workspace"]["schemaVersion"],
        10
    );
    assert_eq!(
        call(&reopened, "get_memory", json!({"memoryId":m["id"]}))["memory"]["content"],
        content
    );
}
fn prefs(base: i64) -> Value {
    json!({"baseVersion":base,"role":"交付负责人","answerStyle":"concise","reportFormat":"brief","reminderStyle":"gentle"})
}
fn brief(engine: &Engine, p: &Value, generate: bool) -> Value {
    call(
        engine,
        if generate {
            "generate_project_brief"
        } else {
            "get_project_brief"
        },
        json!({"projectId":p["id"],"date":"2026-10-20"}),
    )
}

#[test]
fn preferences_have_explicit_defaults_cas_clear_and_frozen_report_format() {
    let dir = tempfile::tempdir().unwrap();
    let e = Engine::open(dir.path()).unwrap();
    let p = project(&e, "偏好");
    let initial = call(&e, "get_assistant_preferences", json!({}));
    assert_eq!(initial["version"], 0);
    assert_eq!(initial["role"], "");
    assert_eq!(
        call(&e, "save_assistant_preferences", prefs(0))["version"],
        1
    );
    assert_eq!(
        error(&e, "save_assistant_preferences", prefs(0)).code,
        "REVISION_CONFLICT"
    );
    let mut invalid = prefs(1);
    invalid["answerStyle"] = json!("invented");
    assert_eq!(
        error(&e, "save_assistant_preferences", invalid).code,
        "VALIDATION"
    );
    let report = call(
        &e,
        "generate_daily_report",
        json!({"projectId":p["id"],"date":"2026-10-20","clientRequestId":uuid::Uuid::new_v4().to_string()}),
    );
    assert_eq!(report["basis"]["reportFormat"], "brief");
    assert!(report["content"].as_str().unwrap().contains("工作简报"));
    let cleared = call(&e, "clear_assistant_preferences", json!({"baseVersion":1}));
    assert_eq!(cleared["role"], "");
    assert_eq!(cleared["answerStyle"], "standard");
    assert_eq!(cleared["version"], 2);
    assert_eq!(
        call(&e, "get_daily_report", json!({"reportId":report["id"]})),
        report
    );
    assert_eq!(
        call(&e, "get_state", json!({}))["assistantPreferenceVersion"],
        2
    );
}

#[test]
fn briefs_are_explicit_scoped_snapshots_and_detect_changes() {
    let dir = tempfile::tempdir().unwrap();
    let e = Engine::open(dir.path()).unwrap();
    let p = project(&e, "本项目");
    let other = project(&e, "其他项目");
    let (m, _, _) = memory(&e, &p, "支付接口验收由张磊负责。");
    memory(&e, &other, "OTHER_PROJECT_SECRET 的验收负责人另行指定。");
    assert!(brief(&e, &p, false)["brief"].is_null());
    let first = brief(&e, &p, true);
    assert_eq!(first["brief"]["stale"], false);
    assert!(!first.to_string().contains("OTHER_PROJECT_SECRET"));
    assert!(first["brief"]["sections"]
        .as_array()
        .unwrap()
        .iter()
        .any(|s| s["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["memoryId"] == m["id"])));
    memory(&e, &other, "隔离项目的新增决策。");
    assert_eq!(
        brief(&e, &p, false)["brief"]["stale"],
        false,
        "unrelated project invalidated brief"
    );
    revise(&e, &m, "支付接口验收改由陈雨负责。");
    let stale = brief(&e, &p, false);
    assert_eq!(stale["brief"]["stale"], true);
    assert_eq!(
        stale["brief"]["sections"], first["brief"]["sections"],
        "read silently rewrote historical snapshot"
    );
    assert_eq!(brief(&e, &p, true)["brief"]["stale"], false);
    assert_eq!(
        call(
            &e,
            "get_project_brief",
            json!({"projectId":p["id"],"date":"2026-10-21"})
        )["brief"]["stale"],
        true
    );
    source(&e, &p, "补充的原始资料，尚未提取。");
    assert_eq!(brief(&e, &p, false)["brief"]["stale"], true);
    assert_eq!(
        error(
            &e,
            "generate_project_brief",
            json!({"projectId":"missing","date":"2026-10-20"})
        )
        .code,
        "NOT_FOUND"
    );
}

#[test]
fn corrections_are_atomic_versioned_scoped_and_retrieval_checkable() {
    let dir = tempfile::tempdir().unwrap();
    let e = Engine::open(dir.path()).unwrap();
    let p = project(&e, "纠错");
    let other = project(&e, "隔离");
    let (m, _, _) = memory(&e, &p, "支付接口验收由张磊负责。");
    let invalid = json!({"memoryId":m["id"],"baseRevision":1,"content":"支付接口验收由陈雨负责。","reason":"更正","question":"问".repeat(2001)});
    assert_eq!(error(&e, "revise_memory", invalid).code, "VALIDATION");
    assert_eq!(
        call(&e, "get_memory", json!({"memoryId":m["id"]}))["memory"]["revision"],
        1
    );
    assert!(
        call(&e, "get_memory_quality", json!({"projectId":p["id"]}))["corrections"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let m = revise(&e, &m, "支付接口验收改由陈雨负责。");
    let quality = call(&e, "check_memory_quality", json!({"projectId":p["id"]}));
    assert_eq!(quality["corrections"][0]["check"], "passed");
    assert!(quality["corrections"][0]["previousContent"]
        .as_str()
        .unwrap()
        .contains("张磊"));
    assert!(quality["corrections"][0]["correctedContent"]
        .as_str()
        .unwrap()
        .contains("陈雨"));
    revise(&e, &m, "支付接口验收改由赵岚负责。");
    let quality = call(&e, "check_memory_quality", json!({"projectId":p["id"]}));
    let cases = quality["corrections"].as_array().unwrap();
    assert!(cases
        .iter()
        .any(|c| c["toRevision"] == 2 && c["check"] == "superseded"));
    assert!(cases
        .iter()
        .any(|c| c["toRevision"] == 3 && c["check"] == "passed"));
    assert!(
        call(&e, "get_memory_quality", json!({"projectId":other["id"]}))["corrections"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let answer = call(
        &e,
        "ask_assistant",
        json!({"projectId":p["id"],"date":"2026-10-20","question":"支付接口验收由谁负责？"}),
    );
    assert!(answer["answer"].as_str().unwrap().contains("赵岚"));
    assert!(!answer["answer"].as_str().unwrap().contains("张磊"));
}

#[test]
fn assessments_are_idempotent_and_all_workbench_data_survives_restart_and_restore() {
    let dir = tempfile::tempdir().unwrap();
    let e = Engine::open(dir.path()).unwrap();
    let p = project(&e, "恢复");
    let (m, s, proposal) = memory(&e, &p, "支付接口验收由张磊负责。");
    let m = revise(&e, &m, "支付接口验收由陈雨负责。");
    call(&e, "save_assistant_preferences", prefs(0));
    let saved_brief = brief(&e, &p, true);
    assert_eq!(error(&e,"assess_extraction",json!({"candidateKind":"memory","candidateId":proposal["id"],"verdict":"correct","errorKind":"none"})).code,"VALIDATION");
    let assessment = json!({"candidateKind":"source","sourceId":s["source"]["id"],"verdict":"incorrect","errorKind":"omission","reason":"合成抽检：还需要提取验收事项，原文第1段。"});
    call(&e, "assess_extraction", assessment.clone());
    let quality = call(&e, "assess_extraction", assessment);
    assert_eq!(quality["counts"]["reviewed"], 1);
    assert_eq!(quality["counts"]["omissions"], 1);
    assert_eq!(error(&e,"assess_extraction",json!({"candidateKind":"source","sourceId":s["source"]["id"],"verdict":"correct","errorKind":"none"})).code,"VALIDATION");
    let backup = call(&e, "create_backup", json!({}));
    let bytes = std::fs::read(
        dir.path()
            .join("backups")
            .join(backup["filename"].as_str().unwrap()),
    )
    .unwrap();
    drop(e);
    let e = Engine::open(dir.path()).unwrap();
    assert_eq!(brief(&e, &p, false), saved_brief);
    assert_eq!(
        call(&e, "get_memory_quality", json!({"projectId":p["id"]})),
        quality
    );
    call(&e, "clear_assistant_preferences", json!({"baseVersion":1}));
    revise(&e, &m, "支付接口验收由赵岚负责。");
    brief(&e, &p, true);
    call(
        &e,
        "restore_backup",
        json!({"filename":backup["filename"],"contentBase64":BASE64.encode(bytes),"confirmation":"RESTORE"}),
    );
    assert_eq!(brief(&e, &p, false), saved_brief);
    assert_eq!(
        call(&e, "get_assistant_preferences", json!({}))["role"],
        "交付负责人"
    );
    assert_eq!(
        call(&e, "get_memory_quality", json!({"projectId":p["id"]})),
        quality
    );
}
