//! Personal questions remain useful offline and reject model answers after a
//! concurrent task/configuration change or workspace restore.
#[path = "common/answer.rs"]
mod answer_fixture;

use base64::Engine as _;
use project_assistant_core::{AppError, Engine, Request};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

const DATE: &str = "2026-10-19";
fn call(engine: &Engine, command: &str, payload: Value) -> Value {
    engine
        .execute(Request {
            command: command.into(),
            payload,
        })
        .unwrap_or_else(|error| panic!("{command}: {error}"))
}
fn project(engine: &Engine, name: &str) -> Value {
    call(engine, "create_project", json!({"name":name}))
}
fn task(
    engine: &Engine,
    project: &Value,
    title: &str,
    status: &str,
    date: &str,
    due: Option<&str>,
) -> Value {
    call(
        engine,
        "create_task",
        json!({"projectId":project["id"],"title":title,"description":"","category":"action","assignee":"小林","priority":"high","status":status,"progress":if status=="done"{100}else{0},"dueDate":due,"plannedDate":null,"workDate":date,"clientRequestId":uuid::Uuid::new_v4().to_string()}),
    )
}
fn update(engine: &Engine, task: &Value, status: &str, progress: i64, note: &str) -> Value {
    let mut p = task.clone();
    p["taskId"] = task["id"].clone();
    p["baseVersion"] = task["version"].clone();
    p["status"] = json!(status);
    p["progress"] = json!(progress);
    p["note"] = json!(note);
    p["workDate"] = json!(DATE);
    p["clientRequestId"] = json!(uuid::Uuid::new_v4().to_string());
    call(engine, "update_task", p)
}
fn ask(engine: &Engine, project: &Value, question: &str) -> Value {
    call(
        engine,
        "ask_assistant",
        json!({"projectId":project["id"],"date":DATE,"question":question}),
    )
}
fn settings(url: &str, model: &str) -> Value {
    json!({"provider":"openai_compatible","baseUrl":url,"model":model,"outputFormat":"json_schema","timeoutSeconds":10,"autoExtract":false,"remoteConsent":false,"apiKey":"fixture-assistant-private-key"})
}

#[test]
fn offline_answer_uses_latest_progress_is_scoped_and_does_not_mutate_work() {
    let directory = tempfile::tempdir().unwrap();
    let engine = Engine::open(directory.path()).unwrap();
    let a = project(&engine, "客户交付");
    let b = project(&engine, "隔离项目");
    let t = task(
        &engine,
        &a,
        "登录审计接口",
        "todo",
        "2026-10-16",
        Some("2026-10-23"),
    );
    task(&engine, &b, "绝密任务 ZETA", "blocked", DATE, None);
    let t = update(&engine, &t, "in_progress", 65, "接口已联调，等待审计验收");
    let before = call(&engine, "get_state", json!({}));
    let answer = ask(&engine, &a, "登录审计接口现在进展如何？");
    assert_eq!(answer["mode"], "local");
    assert_eq!(answer["grounded"], true);
    assert!(answer["answer"].as_str().unwrap().contains("65%"));
    assert!(answer["answer"]
        .as_str()
        .unwrap()
        .contains("接口已联调，等待审计验收"));
    assert!(!answer.to_string().contains("ZETA"));
    let citation = &answer["citations"][0];
    assert_eq!(citation["taskId"], t["id"]);
    assert_eq!(citation["record"]["version"], 2);
    assert_eq!(citation["updatedAt"], t["updatedAt"]);
    let detail = call(&engine, "get_task", json!({"taskId":citation["taskId"]}));
    assert_eq!(detail["task"], t);
    let after = call(&engine, "get_state", json!({}));
    for collection in ["tasks", "memories", "taskProposals", "reports"] {
        assert_eq!(before[collection], after[collection]);
    }
    let all = call(
        &engine,
        "ask_assistant",
        json!({"date":DATE,"question":"本周状态"}),
    );
    assert!(all["answer"].as_str().unwrap().contains("客户交付"));
    assert!(all["answer"].as_str().unwrap().contains("隔离项目"));
    assert!(all["citations"]
        .as_array()
        .unwrap()
        .iter()
        .any(|c| c["record"]["taskSummary"]["total"] == 1));
    for command in ["_assistant_context", "_validate_assistant_context"] {
        assert_eq!(
            engine
                .execute(Request {
                    command: command.into(),
                    payload: answer["context"].clone()
                })
                .unwrap_err()
                .code,
            "UNKNOWN_COMMAND"
        );
    }
}

#[test]
fn offline_follow_up_rules_distinguish_old_todo_from_stale_progress_and_respect_snooze() {
    let directory = tempfile::tempdir().unwrap();
    let engine = Engine::open(directory.path()).unwrap();
    let p = project(&engine, "跟进项目");
    task(
        &engine,
        &p,
        "未开始且无承诺的待办",
        "todo",
        "2026-10-12",
        None,
    );
    task(
        &engine,
        &p,
        "进行中但长期未更新",
        "in_progress",
        "2026-10-15",
        None,
    );
    let blocked = task(&engine, &p, "需要先协调的阻塞", "blocked", DATE, None);
    let answer = ask(&engine, &p, "今天先催谁？");
    assert!(!answer["answer"]
        .as_str()
        .unwrap()
        .contains("未开始且无承诺的待办"));
    assert!(answer["answer"]
        .as_str()
        .unwrap()
        .contains("进行中但长期未更新"));
    assert!(answer["answer"]
        .as_str()
        .unwrap()
        .contains("需要先协调的阻塞"));
    call(
        &engine,
        "snooze_follow_up",
        json!({"taskId":blocked["id"],"baseVersion":0,"date":DATE,"snoozedUntil":"2026-10-22"}),
    );
    let snoozed = ask(&engine, &p, "今天先催谁？");
    assert!(!snoozed["answer"]
        .as_str()
        .unwrap()
        .contains("需要先协调的阻塞"));
    assert!(snoozed["limitations"].to_string().contains("没有发送消息"));
    let fallback = call(
        &engine,
        "ask_assistant",
        json!({"projectId":p["id"],"date":DATE,"question":"今天先催谁","useModel":true}),
    );
    assert_eq!(fallback["mode"], "local");
    assert!(fallback["limitations"].to_string().contains("模型配置"));
}

#[test]
fn milestone_reopened_work_is_explicit_and_missing_forecasts_are_never_invented() {
    let directory = tempfile::tempdir().unwrap();
    let engine = Engine::open(directory.path()).unwrap();
    let p = project(&engine, "交付项目");
    let t = task(&engine, &p, "验收准备", "done", DATE, None);
    let m = call(
        &engine,
        "save_milestone",
        json!({"projectId":p["id"],"title":"首轮验收","description":"","status":"completed","baselineDate":"2026-10-20","forecastDate":null,"taskIds":[t["id"]],"baseVersion":0}),
    );
    update(&engine, &t, "in_progress", 80, "验收发现缺陷，重新处理");
    let answer = ask(&engine, &p, "项目里程碑情况");
    assert!(answer["answer"]
        .as_str()
        .unwrap()
        .contains("需复核完成状态"));
    assert!(answer["answer"]
        .as_str()
        .unwrap()
        .contains("当前预计 未记录"));
    assert!(answer["citations"]
        .as_array()
        .unwrap()
        .iter()
        .any(|c| c["milestoneId"] == m["id"] && c["record"]["completionBlocked"] == true));
}

#[test]
fn unsupported_questions_do_not_claim_an_answer_and_unknown_projects_fail() {
    let directory = tempfile::tempdir().unwrap();
    let engine = Engine::open(directory.path()).unwrap();
    let p = project(&engine, "空项目");
    let answer = ask(&engine, &p, "退款服务部署在哪台服务器？");
    assert_eq!(answer["grounded"], false);
    assert_eq!(answer["citations"], json!([]));
    assert!(answer["limitations"].to_string().contains("尚无任务"));
    assert_eq!(
        engine
            .execute(Request {
                command: "ask_assistant".into(),
                payload: json!({"projectId":"missing","question":"本周状态","date":DATE})
            })
            .unwrap_err()
            .code,
        "NOT_FOUND"
    );
}

fn read_request(stream: &mut TcpStream) -> Value {
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 4096];
    let header_end = loop {
        let length = stream.read(&mut buffer).unwrap();
        assert!(length > 0 && bytes.len() < 512 * 1024);
        bytes.extend_from_slice(&buffer[..length]);
        if let Some(index) = bytes.windows(4).position(|p| p == b"\r\n\r\n") {
            break index + 4;
        }
    };
    let headers = String::from_utf8(bytes[..header_end].to_vec()).unwrap();
    let length = headers
        .lines()
        .find_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().unwrap())
        })
        .unwrap();
    while bytes.len() < header_end + length {
        let n = stream.read(&mut buffer).unwrap();
        assert!(n > 0);
        bytes.extend_from_slice(&buffer[..n]);
    }
    serde_json::from_slice(&bytes[header_end..header_end + length]).unwrap()
}
struct PausedModel {
    url: String,
    received: mpsc::Receiver<Value>,
    release: mpsc::Sender<()>,
    worker: Option<thread::JoinHandle<()>>,
}
impl PausedModel {
    fn new(forged: bool, review_expected: bool) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let (tx, received) = mpsc::channel();
        let (release, rx) = mpsc::channel();
        let worker = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let body = read_request(&mut stream);
            let envelope: Value =
                serde_json::from_str(body["messages"][1]["content"].as_str().unwrap()).unwrap();
            let reference = &envelope["references"][0];
            let span = &reference["content"][0];
            let text = span["text"].as_str().unwrap();
            let output = if forged {
                // Preserve the explicit legacy forgery regression: an ID from
                // another project must still fail current-reference binding.
                answer_fixture::bound(text, json!(["task:another-project"]), text)
            } else {
                json!({"grounded":true,"status":"answered","unknowns":[],"claims":[{
                    "text":text,"supportSpans":[{"referenceIndex":reference["referenceIndex"],"spanIndex":span["spanIndex"]}]}]})
            };
            tx.send(body).unwrap();
            rx.recv_timeout(Duration::from_secs(10)).unwrap();
            let response=json!({"choices":[{"message":{"content":output.to_string()},"finish_reason":"stop"}]}).to_string();
            write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",response.len(),response).unwrap();
            drop(stream);
            if !review_expected {
                return;
            }
            listener.set_nonblocking(true).unwrap();
            let review_deadline = Instant::now() + Duration::from_secs(10);
            loop {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        stream.set_nonblocking(false).unwrap();
                        let request = read_request(&mut stream);
                        let input: Value = serde_json::from_str(
                            request["messages"][1]["content"].as_str().unwrap(),
                        )
                        .unwrap();
                        assert!(input.get("claims").is_some(), "expected evidence review");
                        let review = json!({"supported":true,"answersQuestion":true,"completeAnswer":true,
                            "obligations":[{"target":input["question"],"status":"answered","claimIndices":[1]}],
                            "unknownDecisions":[],"unsupportedClaims":[],"missingAspects":[],"reason":"Current task fields directly answer the fixture question."});
                        let response = json!({"choices":[{"message":{"content":review.to_string()},"finish_reason":"stop"}]}).to_string();
                        write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",response.len(),response).unwrap();
                        break;
                    }
                    Err(error)
                        if error.kind() == std::io::ErrorKind::WouldBlock
                            && Instant::now() < review_deadline =>
                    {
                        thread::sleep(Duration::from_millis(2))
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        panic!("expected evidence review: {error}")
                    }
                    Err(error) => panic!("mock review accept failed: {error}"),
                }
            }
        });
        Self {
            url,
            received,
            release,
            worker: Some(worker),
        }
    }
    fn request(&self) -> Value {
        self.received.recv_timeout(Duration::from_secs(10)).unwrap()
    }
    fn finish(&mut self) {
        self.release.send(()).unwrap();
        self.worker.take().unwrap().join().unwrap();
    }
}
impl Drop for PausedModel {
    fn drop(&mut self) {
        let _ = self.release.send(());
    }
}
fn model_ask(engine: &Engine, project: &Value) -> thread::JoinHandle<Result<Value, AppError>> {
    let engine = engine.clone();
    let project = project["id"].clone();
    thread::spawn(move || {
        engine.execute(Request{command:"ask_assistant".into(),payload:json!({"projectId":project,"question":"登录审计接口进展","date":DATE,"useModel":true})})
    })
}

#[test]
fn model_output_schema_is_visible_in_both_json_modes() {
    for format in ["json_object", "json_schema"] {
        let mut model = PausedModel::new(false, true);
        let directory = tempfile::tempdir().unwrap();
        let engine = Engine::open(directory.path()).unwrap();
        let mut config = settings(&model.url, "chosen-model");
        config["outputFormat"] = json!(format);
        call(&engine, "save_ai_settings", config);
        let p = project(&engine, "格式约束");
        task(&engine, &p, "登录审计接口", "in_progress", DATE, None);
        let pending = model_ask(&engine, &p);
        let body = model.request();
        model.finish();
        let answer = pending.join().unwrap().unwrap();
        assert_eq!(answer["mode"], "model");
        let envelope: Value =
            serde_json::from_str(body["messages"][1]["content"].as_str().unwrap()).unwrap();
        let schema = if format == "json_schema" {
            assert!(
                envelope.get("schema").is_none(),
                "strict schema must not be duplicated in the user input"
            );
            assert_eq!(body["response_format"]["type"], "json_schema");
            assert_eq!(body["response_format"]["json_schema"]["strict"], true);
            &body["response_format"]["json_schema"]["schema"]
        } else {
            assert_eq!(body["response_format"]["type"], "json_object");
            assert!(body["response_format"].get("json_schema").is_none());
            &envelope["schema"]
        };
        assert_eq!(
            schema["required"],
            json!(["grounded", "status", "claims", "unknowns"]),
            "{format} did not tell the model the compact expected fields"
        );
        assert_eq!(schema["additionalProperties"], false);
        assert!(schema["properties"].get("answer").is_none());
        assert!(schema["properties"].get("citationIds").is_none());
        assert_eq!(
            schema["properties"]["claims"]["items"]["required"],
            json!(["text", "supportSpans"])
        );
        let indices = &schema["properties"]["claims"]["items"]["properties"]["supportSpans"]
            ["items"]["properties"];
        assert_eq!(indices["referenceIndex"]["type"], "integer");
        assert_eq!(indices["referenceIndex"]["minimum"], 1);
        assert_eq!(
            indices["referenceIndex"]["maximum"],
            envelope["references"].as_array().unwrap().len()
        );
        assert_eq!(indices["spanIndex"]["minimum"], 1);
        for (index, reference) in envelope["references"]
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
        {
            assert_eq!(reference["referenceIndex"], index + 1);
            let spans = reference["content"].as_array().unwrap();
            assert!(!spans.is_empty());
            for (span_index, span) in spans.iter().enumerate() {
                assert_eq!(span["spanIndex"], span_index + 1);
                assert!(span["text"].is_string());
                assert!(span["text"].as_str().unwrap().chars().count() <= 600);
            }
        }
    }
}

#[test]
fn selected_model_receives_only_scoped_records_and_forged_references_are_rejected() {
    for forged in [false, true] {
        let mut model = PausedModel::new(forged, !forged);
        let directory = tempfile::tempdir().unwrap();
        let engine = Engine::open(directory.path()).unwrap();
        call(
            &engine,
            "save_ai_settings",
            settings(&model.url, "chosen-model"),
        );
        let a = project(&engine, "交付项目");
        let b = project(&engine, "隔离项目");
        task(&engine, &a, "登录审计接口", "in_progress", DATE, None);
        task(&engine, &b, "SECRET-OTHER-PROJECT", "blocked", DATE, None);
        let pending = model_ask(&engine, &a);
        let body = model.request();
        assert_eq!(body["model"], "chosen-model");
        assert!(body.get("tools").is_none());
        assert!(!body.to_string().contains("SECRET-OTHER-PROJECT"));
        assert!(!body.to_string().contains("fixture-assistant-private-key"));
        let envelope: Value =
            serde_json::from_str(body["messages"][1]["content"].as_str().unwrap()).unwrap();
        assert!(envelope["references"].as_array().unwrap().iter().all(|r| r
            .get("record")
            .is_none()
            && r.get("evidence").is_none()
            && r["content"].as_array().is_some_and(|spans| {
                !spans.is_empty()
                    && spans.iter().all(|span| {
                        span["text"].is_string() && span["spanIndex"].as_u64().is_some()
                    })
            })));
        model.finish();
        let result = pending.join().unwrap();
        if forged {
            assert_eq!(result.unwrap_err().code, "ASSISTANT_GROUNDING");
        } else {
            let answer = result.unwrap();
            assert_eq!(answer["mode"], "model");
            assert!(answer["citations"]
                .as_array()
                .unwrap()
                .iter()
                .all(|c| c["projectId"] == a["id"]));
            assert!(answer["citations"]
                .as_array()
                .unwrap()
                .iter()
                .all(|c| c.get("record").is_some()));
        }
    }
}

#[test]
fn task_changes_model_changes_and_backup_restore_cancel_late_answers_without_blocking_actor() {
    for change in ["task", "configuration", "restore"] {
        let mut model = PausedModel::new(false, false);
        let directory = tempfile::tempdir().unwrap();
        let engine = Engine::open(directory.path()).unwrap();
        call(
            &engine,
            "save_ai_settings",
            settings(&model.url, "chosen-model"),
        );
        let p = project(&engine, "交付项目");
        let t = task(&engine, &p, "登录审计接口", "in_progress", DATE, None);
        let backup = call(&engine, "create_backup", json!({}));
        let pending = model_ask(&engine, &p);
        model.request();
        let read_engine = engine.clone();
        let (tx, rx) = mpsc::channel();
        let reader = thread::spawn(move || {
            tx.send(call(&read_engine, "get_state", json!({}))).unwrap();
        });
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(2))
                .expect("model blocked database actor")["tasks"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        reader.join().unwrap();
        match change {
            "task" => {
                update(&engine, &t, "blocked", 40, "上游接口变更，等待处理");
            }
            "configuration" => {
                call(
                    &engine,
                    "save_ai_settings",
                    settings(&model.url, "replacement-model"),
                );
            }
            _ => {
                let bytes = std::fs::read(
                    directory
                        .path()
                        .join("backups")
                        .join(backup["filename"].as_str().unwrap()),
                )
                .unwrap();
                call(
                    &engine,
                    "restore_backup",
                    json!({"filename":backup["filename"],"contentBase64":base64::engine::general_purpose::STANDARD.encode(bytes),"confirmation":"RESTORE"}),
                );
            }
        }
        model.finish();
        assert_eq!(
            pending.join().unwrap().unwrap_err().code,
            "ASSISTANT_CONTEXT_STALE",
            "{change}"
        );
    }
}
