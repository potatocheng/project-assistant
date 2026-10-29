//! Both interactive and group questions exercise production retrieval against
//! realistic synthetic project records. These are contract regressions, not a
//! measurement of a real model's semantic accuracy.
use project_assistant_core::{Engine, Request};
use serde_json::{json, Value};
use std::collections::HashMap;

fn call(engine: &Engine, command: &str, payload: Value) -> Value {
    engine
        .execute(Request {
            command: command.into(),
            payload,
        })
        .unwrap_or_else(|error| panic!("{command}: {error}"))
}

#[test]
fn project_manager_scenarios_share_current_scoped_evidence_and_unknowns() {
    let dataset: Value =
        serde_json::from_str(include_str!("fixtures/project-manager-questions-v1.json")).unwrap();
    let directory = tempfile::tempdir().unwrap();
    let engine = Engine::open(directory.path()).unwrap();
    let project = call(
        &engine,
        "create_project",
        json!({"name":dataset["projectName"]}),
    );
    let other = call(
        &engine,
        "create_project",
        json!({"name":"SECRET-OTHER-PROJECT"}),
    );
    call(
        &engine,
        "create_task",
        json!({"projectId":other["id"],"title":"SECRET-OTHER-TASK","category":"action","status":"blocked","progress":0,"priority":"high","workDate":dataset["date"],"clientRequestId":uuid::Uuid::new_v4().to_string()}),
    );
    let mut tasks = HashMap::new();
    for record in dataset["tasks"].as_array().unwrap() {
        let mut payload = record.clone();
        payload["projectId"] = project["id"].clone();
        payload["category"] = json!("action");
        payload["priority"] = json!("high");
        payload["clientRequestId"] = json!(uuid::Uuid::new_v4().to_string());
        let mut task = call(&engine, "create_task", payload);
        if let Some(update) = record.get("update") {
            let mut payload = task.clone();
            payload["taskId"] = task["id"].clone();
            payload["baseVersion"] = task["version"].clone();
            payload["clientRequestId"] = json!(uuid::Uuid::new_v4().to_string());
            for (key, value) in update.as_object().unwrap() {
                payload[key] = value.clone();
            }
            task = call(&engine, "update_task", payload);
        }
        tasks.insert(record["key"].as_str().unwrap().to_owned(), task);
    }
    for record in dataset["milestones"].as_array().unwrap() {
        let mut payload = record.clone();
        payload["projectId"] = project["id"].clone();
        payload["baseVersion"] = json!(0);
        payload["taskIds"] = json!(record["taskKeys"]
            .as_array()
            .unwrap()
            .iter()
            .map(|key| tasks[key.as_str().unwrap()]["id"].clone())
            .collect::<Vec<_>>());
        call(&engine, "save_milestone", payload);
    }
    for record in dataset["governance"].as_array().unwrap() {
        let mut payload = record.clone();
        payload["projectId"] = project["id"].clone();
        payload["severity"] = json!("high");
        payload["impact"] = json!("影响发布安排");
        payload["responsePlan"] = json!("按确认结论跟进");
        payload["escalationTo"] = json!("");
        payload["links"] = json!([]);
        payload["evidenceIds"] = json!([]);
        payload["workDate"] = dataset["date"].clone();
        payload["note"] = json!("登记决策");
        call(&engine, "save_governance_item", payload);
    }
    let before = call(&engine, "get_state", json!({}));
    for case in dataset["questions"].as_array().unwrap() {
        let payload = json!({"projectId":project["id"],"date":dataset["date"],"question":case["question"],"useModel":false});
        let desktop = call(&engine, "ask_assistant", payload.clone());
        let group = call(&engine, "ask_project_question", payload);
        assert_eq!(desktop["citations"], group["citations"], "{}", case["id"]);
        assert_eq!(desktop["status"], group["status"], "{}", case["id"]);
        assert_eq!(desktop["unknowns"], group["unknowns"], "{}", case["id"]);
        assert_eq!(group["queryTrace"]["modelCalls"], 0);
        for answer in [&desktop, &group] {
            let text = answer["answer"].as_str().unwrap();
            for expected in case["contains"].as_array().into_iter().flatten() {
                assert!(
                    text.contains(expected.as_str().unwrap()),
                    "{} missing {expected}: {text}",
                    case["id"]
                );
            }
            for forbidden in case["notContains"].as_array().into_iter().flatten() {
                assert!(
                    !text.contains(forbidden.as_str().unwrap()),
                    "{} contains {forbidden}: {text}",
                    case["id"]
                );
            }
            if let Some(status) = case["status"].as_str() {
                assert_eq!(answer["status"], status, "{}", case["id"]);
                if status == "partial"
                    || status == "unknown" && !answer["citations"].as_array().unwrap().is_empty()
                {
                    assert!(
                        !answer["unknowns"].as_array().unwrap().is_empty(),
                        "{}",
                        case["id"]
                    );
                }
            }
            assert!(!answer.to_string().contains("SECRET-OTHER"));
            for kind in case["citationKinds"].as_array().unwrap() {
                assert!(
                    answer["citations"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|c| c["kind"] == *kind),
                    "{} missing {kind}",
                    case["id"]
                );
            }
            assert!(answer["citations"]
                .as_array()
                .unwrap()
                .iter()
                .all(|c| c["projectId"] == project["id"]));
        }
        if group["grounded"] == true {
            assert!(group["answer"].as_str().unwrap().contains("依据："));
            assert!(group["answer"]
                .as_str()
                .unwrap()
                .starts_with(desktop["answer"].as_str().unwrap()));
        }
    }
    let after = call(&engine, "get_state", json!({}));
    for key in ["tasks", "memories", "reports", "taskProposals"] {
        assert_eq!(before[key], after[key]);
    }
}

#[test]
fn group_questions_require_one_project_and_preserve_model_authorization() {
    let directory = tempfile::tempdir().unwrap();
    let engine = Engine::open(directory.path()).unwrap();
    for project in [Value::Null, json!(""), json!("all"), json!([])] {
        let error = engine
            .execute(Request {
                command: "ask_project_question".into(),
                payload: json!({"projectId":project,"question":"项目进展？","useModel":false}),
            })
            .unwrap_err();
        assert_eq!(error.code, "VALIDATION");
    }
    let project = call(&engine, "create_project", json!({"name":"授权检查"}));
    let error = engine
        .execute(Request {
            command: "ask_project_question".into(),
            payload: json!({"projectId":project["id"],"question":"项目进展？"}),
        })
        .unwrap_err();
    assert_eq!(error.code, "AI_NOT_CONFIGURED");
    let error = engine
        .execute(Request {
            command: "ask_project_question".into(),
            payload: json!({"projectId":project["id"],"question":"项目进展？","useModel":"true"}),
        })
        .unwrap_err();
    assert_eq!(error.code, "VALIDATION");
}

#[test]
fn model_enabled_workflow_queries_use_authoritative_rules_and_missing_fields() {
    let directory = tempfile::tempdir().unwrap();
    let engine = Engine::open(directory.path()).unwrap();
    // No server exists here: any unnecessary model call makes this test fail.
    call(
        &engine,
        "save_ai_settings",
        json!({"provider":"openai_compatible","baseUrl":"http://127.0.0.1:1","model":"fixture-no-network","outputFormat":"json_object","timeoutSeconds":1,"autoExtract":false,"remoteConsent":false,"apiKey":"fixture-key"}),
    );
    let project = call(&engine, "create_project", json!({"name":"规则问答"}));
    call(
        &engine,
        "create_task",
        json!({"projectId":project["id"],"title":"上线联调","status":"blocked","progress":30,"assignee":"小陈","category":"action","priority":"high","workDate":"2026-10-28","clientRequestId":uuid::Uuid::new_v4().to_string()}),
    );
    for command in ["ask_assistant", "ask_project_question"] {
        for (question, mode, status) in [
            ("今天优先跟进谁？", "follow_up_priority", "answered"),
            ("哪些交付可能延期？", "delivery_risk_signals", "answered"),
            ("目前有哪些事项待拍板？", "pending_decisions", "unknown"),
            (
                "上线联调的负责人是谁，截止日期是哪天？",
                "structured_field",
                "partial",
            ),
        ] {
            let answer = call(
                &engine,
                command,
                json!({"projectId":project["id"],"date":"2026-10-28","question":question,"useModel":true}),
            );
            assert_eq!(answer["queryMode"], mode);
            assert_eq!(answer["status"], status);
            assert_eq!(answer["queryTrace"]["modelCalls"], 0);
            if status == "partial" {
                assert!(answer["unknowns"].to_string().contains("截止日期"));
            }
        }
        for question in [
            "上线联调的负责人是谁，截止日期是哪天，预算多少？",
            "上线联调截止日期由谁拍板？",
            "今天先跟进谁要怎么沟通？",
            "哪些交付可能延期该如何调整排期？",
        ] {
            let answer = call(
                &engine,
                command,
                json!({"projectId":project["id"],"date":"2026-10-28","question":question,"useModel":false}),
            );
            assert!(answer["queryMode"].is_null(), "must not discard another asked fact or substitute the assignee for a decision-maker");
        }
    }
}
