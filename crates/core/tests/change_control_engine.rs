//! Public workflows: changes require fresh approvals and acceptance is independent of execution.
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use project_assistant_core::{AppError, Engine, Request};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{Cursor, Read, Write};
use zip::{write::SimpleFileOptions, ZipArchive, ZipWriter};

const DATE: &str = "2026-10-19";
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
fn task(e: &Engine, p: &Value, status: &str) -> Value {
    task_at(e, p, status, DATE)
}
fn task_at(e: &Engine, p: &Value, status: &str, work_date: &str) -> Value {
    call(
        e,
        "create_task",
        json!({"projectId":p["id"],"title":"联调接口交付","description":"完成接口","category":"action","assignee":"小林","priority":"high","status":status,"progress":if status=="done"{100}else{0},"dueDate":"2026-10-23","plannedDate":null,"workDate":work_date,"clientRequestId":uuid::Uuid::new_v4().to_string()}),
    )
}
fn update(e: &Engine, t: &Value, status: &str) -> Value {
    let mut p = t.clone();
    p["taskId"] = t["id"].clone();
    p["baseVersion"] = t["version"].clone();
    p["status"] = json!(status);
    p["progress"] = json!(if status == "done" { 100 } else { 0 });
    p["workDate"] = json!(DATE);
    p["note"] = json!("更新交付内容");
    p["clientRequestId"] = json!(uuid::Uuid::new_v4().to_string());
    call(e, "update_task", p)
}
fn change(p: &Value) -> Value {
    json!({"projectId":p["id"],"date":DATE,"baseVersion":0,"title":"新增审计日志","before":"仅登录","after":"登录并记录审计日志","reason":"客户验收要求","requester":"小林","decisionOwner":"项目经理","scopeImpact":"新增审计接口","scheduleImpact":"预计延后两天","effortImpact":"增加两人日","links":[],"segmentIds":[]})
}
fn transition(e: &Engine, c: &Value, status: &str) -> Value {
    call(
        e,
        "transition_change_request",
        json!({"changeId":c["id"],"baseVersion":c["version"],"date":DATE,"status":status,"actor":"项目经理","note":"已核对当前范围与实施结果"}),
    )
}
fn delivery(p: &Value, t: &Value, result: &str) -> Value {
    json!({"projectId":p["id"],"date":DATE,"title":"审计接口交付验收","owner":"小林","baseVersion":0,"target":{"kind":"task","id":t["id"],"version":t["version"]},"criteria":[{"title":"审计记录可查询","status":result,"evidence":if result=="pending"{""}else{"测试记录 QA-100 查询通过"},"note":"测试环境验证"}],"links":[],"segmentIds":[]})
}
fn review(e: &Engine, d: &Value, status: &str) -> Value {
    call(
        e,
        "review_deliverable",
        json!({"deliverableId":d["id"],"baseVersion":d["version"],"date":DATE,"status":status,"reviewer":"验收负责人","note":"逐项核验标准","remediation":if status=="rejected"{"修复日志查询"}else{""}}),
    )
}
fn workspace(e: &Engine, p: &Value) -> Value {
    call(
        e,
        "get_change_acceptance",
        json!({"projectId":p["id"],"date":DATE}),
    )
}
fn backup_bytes(e: &Engine, root: &std::path::Path) -> Vec<u8> {
    let backup = call(e, "create_backup", json!({}));
    std::fs::read(
        root.join("backups")
            .join(backup["filename"].as_str().unwrap()),
    )
    .unwrap()
}
fn inspect(e: &Engine, bytes: &[u8]) -> Value {
    call(
        e,
        "inspect_backup",
        json!({"filename":"workflow-backup.zip","contentBase64":BASE64.encode(bytes)}),
    )
}
fn tamper_backup(bytes: &[u8], modify: impl FnOnce(&rusqlite::Connection)) -> Vec<u8> {
    let mut archive = ZipArchive::new(Cursor::new(bytes)).unwrap();
    let mut entries = Vec::new();
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).unwrap();
        let mut data = Vec::new();
        entry.read_to_end(&mut data).unwrap();
        entries.push((entry.name().to_owned(), data));
    }
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("workflow.sqlite");
    let database = entries
        .iter_mut()
        .find(|(name, _)| name == "workspace.sqlite")
        .unwrap();
    std::fs::write(&path, &database.1).unwrap();
    let conn = rusqlite::Connection::open(&path).unwrap();
    modify(&conn);
    drop(conn);
    database.1 = std::fs::read(path).unwrap();
    let checksums = entries
        .iter()
        .filter(|(name, _)| name != "manifest.json")
        .map(|(name, data)| {
            (
                name.clone(),
                (format!("{:x}", Sha256::digest(data)), data.len()),
            )
        })
        .collect::<std::collections::HashMap<_, _>>();
    let manifest_entry = entries
        .iter_mut()
        .find(|(name, _)| name == "manifest.json")
        .unwrap();
    let mut manifest: Value = serde_json::from_slice(&manifest_entry.1).unwrap();
    for file in manifest["files"].as_array_mut().unwrap() {
        let (checksum, size) = &checksums[file["path"].as_str().unwrap()];
        file["sha256"] = json!(checksum);
        file["size"] = json!(size);
    }
    manifest_entry.1 = serde_json::to_vec(&manifest).unwrap();
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    for (name, data) in entries {
        writer
            .start_file(name, SimpleFileOptions::default())
            .unwrap();
        writer.write_all(&data).unwrap();
    }
    writer.finish().unwrap().into_inner()
}
fn rewrite_latest(conn: &rusqlite::Connection, delivery: bool, modify: impl Fn(&mut Value)) {
    let (table, history) = if delivery {
        ("deliverables", "deliverable_history")
    } else {
        ("change_requests", "change_request_history")
    };
    let raw: String = conn
        .query_row(&format!("SELECT data_json FROM {table}"), [], |r| r.get(0))
        .unwrap();
    let mut value: Value = serde_json::from_str(&raw).unwrap();
    modify(&mut value);
    conn.execute(
        &format!("UPDATE {table} SET data_json=?"),
        [value.to_string()],
    )
    .unwrap();
    conn.execute(
        &format!("UPDATE {history} SET snapshot_json=? WHERE version=?"),
        rusqlite::params![value.to_string(), value["version"].as_i64()],
    )
    .unwrap();
}

#[test]
fn approval_and_implementation_are_separate_and_content_edits_invalidate_approval() {
    let dir = tempfile::tempdir().unwrap();
    let e = Engine::open(dir.path()).unwrap();
    let p = project(&e, "变更管理");
    let t = task(&e, &p, "todo");
    let mut payload = change(&p);
    payload["links"] = json!([{"kind":"task","id":t["id"],"version":t["version"]}]);
    let c = call(&e, "save_change_request", payload.clone());
    assert_eq!(error(&e,"transition_change_request",json!({"changeId":c["id"],"baseVersion":1,"date":DATE,"status":"approved","actor":"项目经理","note":"提前批准"})).code,"INVALID_TRANSITION");
    let submitted = transition(&e, &c, "submitted");
    assert_eq!(error(&e,"transition_change_request",json!({"changeId":c["id"],"baseVersion":submitted["version"],"date":DATE,"status":"approved","actor":"小林","note":"自行批准"})).code,"VALIDATION");
    let approved = transition(&e, &submitted, "approved");
    assert_eq!(approved["status"], "approved");
    assert!(approved["implementation"].is_null());
    assert_eq!(
        call(&e, "get_task", json!({"taskId":t["id"]}))["task"]["dueDate"],
        "2026-10-23"
    );
    let updated_task = update(&e, &t, "in_progress");
    let implemented = transition(&e, &approved, "implemented");
    assert_eq!(implemented["implementation"]["actor"], "项目经理");
    assert_eq!(
        implemented["implementation"]["links"][0]["version"],
        updated_task["version"]
    );
    payload["changeId"] = c["id"].clone();
    payload["baseVersion"] = implemented["version"].clone();
    payload["links"][0]["version"] = updated_task["version"].clone();
    payload["after"] = json!("登录并增加两类审计日志");
    let revised = call(&e, "save_change_request", payload.clone());
    assert_eq!(revised["status"], "draft");
    assert!(revised["approval"].is_null());
    assert!(revised["implementation"].is_null());
    assert_eq!(
        revised["history"][1]["snapshot"]["approval"]["result"],
        "approved"
    );
    assert_eq!(
        revised["history"][1]["snapshot"]["after"],
        "登录并记录审计日志"
    );
    assert_eq!(
        error(&e, "save_change_request", payload).code,
        "VERSION_CONFLICT"
    );
    // Actual implementation target versions may change, and a later legitimate
    // content edit must still restore as an unapproved draft.
    inspect(&e, &backup_bytes(&e, dir.path()));
}

#[test]
fn backup_approval_cannot_authorize_content_that_was_never_submitted() {
    let dir = tempfile::tempdir().unwrap();
    let e = Engine::open(dir.path()).unwrap();
    let p = project(&e, "备份审批历史校验");
    let c = call(&e, "save_change_request", change(&p));
    let c = transition(&e, &c, "submitted");
    transition(&e, &c, "approved");
    let original = backup_bytes(&e, dir.path());
    inspect(&e, &original);
    for variant in ["content", "content_version", "predecessor"] {
        let tampered = tamper_backup(&original, |conn| match variant {
            "content" => rewrite_latest(conn, false, |v| {
                v["after"] = json!("另一项从未提交审批的完整范围")
            }),
            "content_version" => {
                rewrite_latest(conn, false, |v| v["approval"]["contentVersion"] = json!(1))
            }
            _ => {
                let raw: String = conn
                    .query_row(
                        "SELECT snapshot_json FROM change_request_history WHERE version=2",
                        [],
                        |r| r.get(0),
                    )
                    .unwrap();
                let mut v: Value = serde_json::from_str(&raw).unwrap();
                v["status"] = json!("draft");
                conn.execute(
                    "UPDATE change_request_history SET snapshot_json=? WHERE version=2",
                    [v.to_string()],
                )
                .unwrap();
            }
        });
        let failure = error(
            &e,
            "inspect_backup",
            json!({"filename":"approval-tampered.zip","contentBase64":BASE64.encode(&tampered)}),
        );
        assert_eq!(failure.code, "VALIDATION", "variant {variant}: {failure}");
        assert!(
            failure.message.contains("内容必须")
                || failure.message.contains("上一待审批")
                || failure.message.contains("历史状态流转"),
            "variant {variant}: {failure}"
        );
    }
    assert_eq!(
        workspace(&e, &p)["changes"][0]["after"],
        "登录并记录审计日志",
        "inspection must not mutate the active workspace"
    );
}

#[test]
fn backup_acceptance_cannot_pass_unreviewed_content_or_skip_review() {
    let dir = tempfile::tempdir().unwrap();
    let e = Engine::open(dir.path()).unwrap();
    let p = project(&e, "备份验收历史校验");
    let t = task(&e, &p, "done");
    let d = call(&e, "save_deliverable", delivery(&p, &t, "pass"));
    let d = review(&e, &d, "in_review");
    review(&e, &d, "accepted");
    let original = backup_bytes(&e, dir.path());
    inspect(&e, &original);
    for variant in ["criterion", "predecessor"] {
        let tampered = tamper_backup(&original, |conn| {
            if variant == "criterion" {
                rewrite_latest(conn, true, |v| {
                    v["criteria"][0]["title"] = json!("未经复核的新验收标准")
                });
            } else {
                let raw: String = conn
                    .query_row(
                        "SELECT snapshot_json FROM deliverable_history WHERE version=2",
                        [],
                        |r| r.get(0),
                    )
                    .unwrap();
                let mut v: Value = serde_json::from_str(&raw).unwrap();
                v["status"] = json!("draft");
                v["review"] = Value::Null;
                conn.execute(
                    "UPDATE deliverable_history SET snapshot_json=? WHERE version=2",
                    [v.to_string()],
                )
                .unwrap();
            }
        });
        let failure = error(
            &e,
            "inspect_backup",
            json!({"filename":"acceptance-tampered.zip","contentBase64":BASE64.encode(&tampered)}),
        );
        assert_eq!(failure.code, "VALIDATION", "variant {variant}: {failure}");
        assert!(
            failure.message.contains("内容必须") || failure.message.contains("历史状态流转"),
            "variant {variant}: {failure}"
        );
    }
    assert_eq!(
        workspace(&e, &p)["deliverables"][0]["criteria"][0]["title"],
        "审计记录可查询"
    );
}

#[test]
fn approvals_and_acceptance_reject_changed_or_cross_project_links() {
    let dir = tempfile::tempdir().unwrap();
    let e = Engine::open(dir.path()).unwrap();
    let p = project(&e, "甲项目");
    let q = project(&e, "乙项目");
    let t = task(&e, &p, "todo");
    let other = task(&e, &q, "done");
    let mut c = change(&p);
    c["links"] = json!([{"kind":"task","id":other["id"],"version":1}]);
    assert_eq!(
        error(&e, "save_change_request", c.clone()).code,
        "PROJECT_SCOPE"
    );
    c["links"] = json!([{"kind":"task","id":t["id"],"version":2}]);
    assert_eq!(
        error(&e, "save_change_request", c.clone()).code,
        "VERSION_CONFLICT"
    );
    c["links"][0]["version"] = json!(1);
    let c = call(&e, "save_change_request", c);
    let submitted = transition(&e, &c, "submitted");
    update(&e, &t, "in_progress");
    assert_eq!(error(&e,"transition_change_request",json!({"changeId":c["id"],"baseVersion":submitted["version"],"date":DATE,"status":"approved","actor":"项目经理","note":"批准"})).code,"LINK_STALE");
    assert_eq!(
        error(&e, "save_deliverable", delivery(&p, &other, "pass")).code,
        "PROJECT_SCOPE"
    );
    assert_eq!(workspace(&e, &q)["changes"].as_array().unwrap().len(), 0);
}

#[test]
fn execution_complete_does_not_imply_acceptance_and_all_criteria_need_evidence() {
    let dir = tempfile::tempdir().unwrap();
    let e = Engine::open(dir.path()).unwrap();
    let p = project(&e, "独立验收");
    let unfinished = task(&e, &p, "todo");
    let mut d = call(&e, "save_deliverable", delivery(&p, &unfinished, "pass"));
    d = review(&e, &d, "in_review");
    assert_eq!(error(&e,"review_deliverable",json!({"deliverableId":d["id"],"baseVersion":d["version"],"date":DATE,"status":"accepted","reviewer":"验收负责人","note":"检查","remediation":""})).code,"ACCEPTANCE_INCOMPLETE");
    let done = update(&e, &unfinished, "done");
    assert_eq!(error(&e,"review_deliverable",json!({"deliverableId":d["id"],"baseVersion":d["version"],"date":DATE,"status":"accepted","reviewer":"验收负责人","note":"检查","remediation":""})).code,"LINK_STALE");
    let mut form = delivery(&p, &done, "pending");
    form["deliverableId"] = d["id"].clone();
    form["baseVersion"] = d["version"].clone();
    let pending = call(&e, "save_deliverable", form.clone());
    let pending = review(&e, &pending, "in_review");
    assert_eq!(error(&e,"review_deliverable",json!({"deliverableId":pending["id"],"baseVersion":pending["version"],"date":DATE,"status":"accepted","reviewer":"验收负责人","note":"检查","remediation":""})).code,"ACCEPTANCE_INCOMPLETE");
    form["baseVersion"] = pending["version"].clone();
    form["criteria"][0]["status"] = json!("pass");
    assert_eq!(
        error(&e, "save_deliverable", form.clone()).code,
        "VALIDATION"
    );
    form["criteria"][0]["evidence"] = json!("回归测试截图 QA-100");
    let ready = call(&e, "save_deliverable", form.clone());
    let checking = review(&e, &ready, "in_review");
    let accepted = review(&e, &checking, "accepted");
    assert_eq!(accepted["status"], "accepted");
    assert_eq!(accepted["needsReReview"], false);
    form["baseVersion"] = ready["version"].clone();
    assert_eq!(error(&e, "save_deliverable", form).code, "VERSION_CONFLICT");
    let reopened = update(&e, &done, "in_progress");
    assert_eq!(workspace(&e, &p)["deliverables"][0]["needsReReview"], true);
    update(&e, &reopened, "done");
    assert_eq!(
        workspace(&e, &p)["deliverables"][0]["needsReReview"],
        true,
        "a new completed version still requires new acceptance"
    );
}

#[test]
fn milestone_acceptance_is_invalidated_when_child_task_reopens() {
    let dir = tempfile::tempdir().unwrap();
    let e = Engine::open(dir.path()).unwrap();
    let p = project(&e, "里程碑验收");
    let t = task(&e, &p, "done");
    let m = call(
        &e,
        "save_milestone",
        json!({"projectId":p["id"],"title":"一期交付","description":"验证接口","status":"completed","baselineDate":DATE,"forecastDate":DATE,"taskIds":[t["id"]]}),
    );
    let mut form = delivery(&p, &t, "pass");
    form["target"] = json!({"kind":"milestone","id":m["id"],"version":m["version"]});
    let d = call(&e, "save_deliverable", form);
    let d = review(&e, &d, "in_review");
    review(&e, &d, "accepted");
    update(&e, &t, "todo");
    let current = workspace(&e, &p);
    assert_eq!(current["deliverables"][0]["targetCurrent"]["version"], 1);
    assert_eq!(current["deliverables"][0]["needsReReview"], true);
}

fn assert_review_waits_for_execution_date(e: &Engine, d: &Value) {
    let early = json!({"deliverableId":d["id"],"baseVersion":d["version"],"date":DATE,"status":"accepted","reviewer":"验收负责人","note":"已核查交付与测试证据","remediation":""});
    assert_eq!(
        error(e, "review_deliverable", early.clone()).code,
        "ACCEPTANCE_DATE_ORDER"
    );
    let mut timely = early;
    timely["date"] = json!("2026-10-25");
    let accepted = call(e, "review_deliverable", timely);
    assert_eq!(accepted["status"], "accepted");
    assert_eq!(accepted["review"]["date"], "2026-10-25");
    assert_eq!(
        accepted["history"][0]["version"], 3,
        "rejected backdating must not append a version"
    );
}

#[test]
fn task_acceptance_cannot_predate_the_exact_execution_version() {
    let dir = tempfile::tempdir().unwrap();
    let e = Engine::open(dir.path()).unwrap();
    let p = project(&e, "按实际执行日期验收");
    let t = task_at(&e, &p, "done", "2026-10-25");
    let d = call(&e, "save_deliverable", delivery(&p, &t, "pass"));
    let d = review(&e, &d, "in_review");
    assert_review_waits_for_execution_date(&e, &d);
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

#[test]
fn milestone_acceptance_cannot_predate_a_child_execution_version() {
    let dir = tempfile::tempdir().unwrap();
    let e = Engine::open(dir.path()).unwrap();
    let p = project(&e, "里程碑实际完成日期");
    let early = task(&e, &p, "done");
    let future = task_at(&e, &p, "done", "2026-10-25");
    let m = call(
        &e,
        "save_milestone",
        json!({"projectId":p["id"],"title":"联调完成","description":"检查两个交付接口","status":"completed","baselineDate":DATE,"forecastDate":"2026-10-25","taskIds":[early["id"],future["id"]]}),
    );
    let mut form = delivery(&p, &early, "pass");
    form["target"] = json!({"kind":"milestone","id":m["id"],"version":m["version"]});
    let d = call(&e, "save_deliverable", form);
    let d = review(&e, &d, "in_review");
    assert_review_waits_for_execution_date(&e, &d);
}

#[test]
fn rejected_reviews_require_remediation_and_only_drafts_can_be_removed() {
    let dir = tempfile::tempdir().unwrap();
    let e = Engine::open(dir.path()).unwrap();
    let p = project(&e, "整改闭环");
    let t = task(&e, &p, "done");
    let d = call(&e, "save_deliverable", delivery(&p, &t, "fail"));
    let d = review(&e, &d, "in_review");
    assert_eq!(error(&e,"review_deliverable",json!({"deliverableId":d["id"],"baseVersion":d["version"],"date":DATE,"status":"rejected","reviewer":"验收人","note":"未通过","remediation":""})).code,"VALIDATION");
    let d = review(&e, &d, "rejected");
    assert_eq!(d["review"]["remediation"], "修复日志查询");
    assert_eq!(
        error(
            &e,
            "delete_deliverable",
            json!({"deliverableId":d["id"],"baseVersion":d["version"],"date":DATE})
        )
        .code,
        "VALIDATION"
    );
    let c = call(&e, "save_change_request", change(&p));
    let removed = call(
        &e,
        "delete_change_request",
        json!({"changeId":c["id"],"baseVersion":c["version"],"date":DATE}),
    );
    assert_eq!(removed["status"], "cancelled");
    assert_eq!(removed["history"].as_array().unwrap().len(), 2);
}

#[test]
fn requirement_memory_and_original_evidence_have_scoped_version_snapshots() {
    let dir = tempfile::tempdir().unwrap();
    let e = Engine::open(dir.path()).unwrap();
    let p = project(&e, "需求来源");
    let q = project(&e, "隔离项目");
    let source = call(
        &e,
        "import_text",
        json!({"projectId":p["id"],"title":"客户需求","text":"客户要求记录并查询登录审计日志。"}),
    );
    let mut detail = Value::Null;
    for _ in 0..100 {
        detail = call(&e, "get_source", json!({"sourceId":source["sourceId"]}));
        if detail["source"]["status"] == "ready" {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    let segment = detail["segments"][0]["id"].clone();
    assert!(segment.is_string());
    let proposal = call(
        &e,
        "create_proposal",
        json!({"projectId":p["id"],"sourceId":source["sourceId"],"kind":"requirement","content":"需支持审计日志查询","segmentIds":[segment]}),
    );
    let memory = call(&e, "confirm_proposal", json!({"proposalId":proposal["id"]}));
    let mut form = change(&p);
    form["links"] = json!([{"kind":"memory","id":memory["id"],"version":memory["revision"]}]);
    form["segmentIds"] = json!([segment]);
    let c = call(&e, "save_change_request", form.clone());
    assert_eq!(c["links"][0]["snapshot"]["content"], "需支持审计日志查询");
    assert_eq!(c["evidence"][0]["sourceTitle"], "客户需求");
    assert!(c["evidence"][0]["sourceVersionId"].is_string());
    form["projectId"] = q["id"].clone();
    form["links"] = json!([]);
    assert_eq!(
        error(&e, "save_change_request", form).code,
        "EVIDENCE_SCOPE"
    );
}

#[test]
fn history_and_re_review_warning_survive_restart_and_backup_restore() {
    let dir = tempfile::tempdir().unwrap();
    let e = Engine::open(dir.path()).unwrap();
    let p = project(&e, "持久化验收");
    let t = task(&e, &p, "done");
    let c = call(&e, "save_change_request", change(&p));
    let c = transition(&e, &c, "submitted");
    transition(&e, &c, "approved");
    let d = call(&e, "save_deliverable", delivery(&p, &t, "pass"));
    let d = review(&e, &d, "in_review");
    review(&e, &d, "accepted");
    update(&e, &t, "todo");
    let before = workspace(&e, &p);
    let backup = call(&e, "create_backup", json!({}));
    let bytes = std::fs::read(
        dir.path()
            .join("backups")
            .join(backup["filename"].as_str().unwrap()),
    )
    .unwrap();
    drop(e);
    let e = Engine::open(dir.path()).unwrap();
    assert_eq!(workspace(&e, &p), before);
    call(&e, "save_change_request", change(&p));
    call(
        &e,
        "restore_backup",
        json!({"filename":backup["filename"],"contentBase64":BASE64.encode(bytes),"confirmation":"RESTORE"}),
    );
    assert_eq!(workspace(&e, &p), before);
}
