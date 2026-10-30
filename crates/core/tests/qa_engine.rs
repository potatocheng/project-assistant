//! Public Engine integration for grounded questions and late-answer rejection.
//! HTTP fixtures pause after receiving a question so actor responsiveness and
//! concurrent edits are checked without relying on arbitrary model delays.

use project_assistant_core::{AppError, Engine, Request};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

fn call(engine: &Engine, command: &str, payload: Value) -> Value {
    engine
        .execute(Request {
            command: command.into(),
            payload,
        })
        .unwrap_or_else(|error| panic!("{command} failed: {error}"))
}

fn settings_payload(url: &str, model: &str) -> Value {
    json!({
        "provider":"openai_compatible","baseUrl":url,"model":model,
        "outputFormat":"json_schema","timeoutSeconds":10,
        "autoExtract":false,"remoteConsent":false,"apiKey":"fixture-private-model-key"
    })
}

fn confirm_memory(engine: &Engine, project: &Value, title: &str, content: &str) -> Value {
    let imported = call(
        engine,
        "import_text",
        json!({
            "projectId":project["id"],"title":title,"text":content
        }),
    );
    let deadline = Instant::now() + Duration::from_secs(10);
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
        assert!(Instant::now() < deadline, "import did not finish");
        thread::sleep(Duration::from_millis(10));
    };
    let proposal = call(
        engine,
        "create_proposal",
        json!({
            "projectId":project["id"],"sourceId":imported["sourceId"],
            "segmentIds":[source["segments"][0]["id"]],"kind":"decision","content":content
        }),
    );
    call(
        engine,
        "confirm_proposal",
        json!({"proposalId":proposal["id"]}),
    )
}

struct Fixture {
    engine: Engine,
    _directory: tempfile::TempDir,
    project: Value,
    memory: Value,
}

impl Fixture {
    fn new(url: &str) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let engine = Engine::open(directory.path()).unwrap();
        call(
            &engine,
            "save_ai_settings",
            settings_payload(url, "selected-model"),
        );
        let project = call(&engine, "create_project", json!({"name":"客户交付"}));
        let memory = confirm_memory(
            &engine,
            &project,
            "评审纪要",
            "登录审计在 10 月 23 日交付。",
        );
        Self {
            _directory: directory,
            engine,
            project,
            memory,
        }
    }

    fn ask(&self) -> thread::JoinHandle<Result<Value, AppError>> {
        let engine = self.engine.clone();
        let project = self.project["id"].clone();
        thread::spawn(move || {
            engine.execute(Request {
                command: "ask_project".into(),
                payload: json!({"projectId":project,"question":"登录审计什么时候交付？"}),
            })
        })
    }
}

struct Captured {
    headers: String,
    body: Value,
}

fn read_request(stream: &mut TcpStream) -> Captured {
    stream.set_nonblocking(false).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 4096];
    let header_end = loop {
        let count = stream.read(&mut buffer).unwrap();
        assert!(count > 0 && bytes.len() < 256 * 1024);
        bytes.extend_from_slice(&buffer[..count]);
        if let Some(index) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
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
    assert!(length < 256 * 1024);
    while bytes.len() < header_end + length {
        let count = stream.read(&mut buffer).unwrap();
        assert!(count > 0);
        bytes.extend_from_slice(&buffer[..count]);
    }
    Captured {
        headers,
        body: serde_json::from_slice(&bytes[header_end..header_end + length]).unwrap(),
    }
}

struct PausedModel {
    url: String,
    received: mpsc::Receiver<Captured>,
    release: mpsc::Sender<()>,
    worker: Option<thread::JoinHandle<()>>,
}

impl PausedModel {
    fn new(review_expected: bool) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let (captured_sender, received) = mpsc::channel();
        let (release, release_receiver) = mpsc::channel();
        let worker = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(15);
            let mut stream = loop {
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(Instant::now() < deadline, "model did not receive a request");
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("mock accept failed: {error}"),
                }
            };
            let captured = read_request(&mut stream);
            let envelope: Value =
                serde_json::from_str(captured.body["messages"][1]["content"].as_str().unwrap())
                    .unwrap();
            let memory = &envelope["references"][0];
            let span = &memory["content"][0];
            let output = json!({"grounded":true,"status":"answered","unknowns":[],"claims":[{
                "text":span["text"],"supportSpans":[{"referenceIndex":memory["referenceIndex"],"spanIndex":span["spanIndex"]}]}]});
            captured_sender.send(captured).unwrap();
            release_receiver
                .recv_timeout(Duration::from_secs(10))
                .unwrap();
            let response = json!({"choices":[{
                "message":{"role":"assistant","content":output.to_string()},"finish_reason":"stop"
            }]})
            .to_string();
            write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",response.len(),response).unwrap();
            drop(stream);
            // Valid grounded generation is now reviewed. Stale-answer cases
            // cancel before review, so waiting for another request is bounded.
            if !review_expected {
                return;
            }
            let review_deadline = Instant::now() + Duration::from_secs(10);
            loop {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let request = read_request(&mut stream);
                        let input: Value = serde_json::from_str(
                            request.body["messages"][1]["content"].as_str().unwrap(),
                        )
                        .unwrap();
                        assert!(input.get("claims").is_some(), "expected evidence review");
                        let review = json!({"supported":true,"answersQuestion":true,"completeAnswer":true,
                            "obligations":[{"target":input["question"],"status":"answered","claimIndices":[1]}],
                            "unknownDecisions":[],"unsupportedClaims":[],"missingAspects":[],"reason":"Current quoted statement directly answers the fixture question."});
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

    fn request(&self) -> Captured {
        self.received
            .recv_timeout(Duration::from_secs(10))
            .expect("model request was not received")
    }

    fn finish(&mut self) {
        self.release.send(()).unwrap();
        self.worker.take().unwrap().join().unwrap();
    }
}

impl Drop for PausedModel {
    fn drop(&mut self) {
        // Unblock the HTTP worker on a failed assertion as well.
        let _ = self.release.send(());
    }
}

#[test]
fn confirmed_memory_is_answered_with_current_revision_evidence_through_public_engine() {
    let mut model = PausedModel::new(true);
    let fixture = Fixture::new(&model.url);
    let other = call(
        &fixture.engine,
        "create_project",
        json!({"name":"隔离项目"}),
    );
    confirm_memory(
        &fixture.engine,
        &other,
        "其他项目纪要",
        "登录审计在 12 月 31 日交付。",
    );
    let before = call(&fixture.engine, "get_state", json!({}));
    let question = fixture.ask();
    let captured = model.request();
    assert!(captured
        .headers
        .to_lowercase()
        .contains("authorization: bearer fixture-private-model-key"));
    assert_eq!(captured.body["model"], "selected-model");
    let envelope: Value =
        serde_json::from_str(captured.body["messages"][1]["content"].as_str().unwrap()).unwrap();
    assert!(envelope.get("schema").is_none());
    let schema = &captured.body["response_format"]["json_schema"]["schema"];
    assert_eq!(
        schema["required"],
        json!(["grounded", "status", "claims", "unknowns"])
    );
    assert_eq!(
        schema["properties"]["claims"]["items"]["properties"]["supportSpans"]["items"]
            ["properties"]["referenceIndex"]["maximum"],
        envelope["references"].as_array().unwrap().len()
    );
    assert_eq!(envelope["references"][0]["referenceIndex"], 1);
    assert_eq!(envelope["references"][0]["content"][0]["spanIndex"], 1);
    assert_eq!(
        envelope["references"][0]["content"][0]["text"],
        "登录审计在 10 月 23 日交付。"
    );

    assert!(!captured.body.to_string().contains("12 月 31"));
    assert!(!captured
        .body
        .to_string()
        .contains("fixture-private-model-key"));
    model.finish();
    let answer = question.join().unwrap().unwrap();
    assert_eq!(answer["grounded"], true);
    assert_eq!(answer["citations"][0]["memoryId"], fixture.memory["id"]);
    assert_eq!(answer["citations"][0]["revision"], 1);
    assert_eq!(
        answer["citations"][0]["evidence"][0]["text"],
        "登录审计在 10 月 23 日交付。"
    );
    assert!(answer["answer"]
        .as_str()
        .unwrap()
        .contains("评审纪要 · 记忆 v1"));
    let after = call(&fixture.engine, "get_state", json!({}));
    for collection in ["memories", "proposals", "tasks", "taskProposals"] {
        assert_eq!(
            before[collection], after[collection],
            "question changed {collection}"
        );
    }
}

#[test]
fn actor_remains_responsive_and_a_concurrent_memory_revision_cancels_late_answer() {
    let mut model = PausedModel::new(false);
    let fixture = Fixture::new(&model.url);
    let question = fixture.ask();
    model.request();
    let engine = fixture.engine.clone();
    let (state_sender, state_receiver) = mpsc::channel();
    let state_reader = thread::spawn(move || {
        state_sender
            .send(engine.execute(Request {
                command: "get_state".into(),
                payload: json!({}),
            }))
            .unwrap()
    });
    let state = state_receiver
        .recv_timeout(Duration::from_secs(2))
        .expect("model request blocked the database actor")
        .unwrap();
    assert_eq!(state["memories"].as_array().unwrap().len(), 1);
    state_reader.join().unwrap();
    let revised = call(
        &fixture.engine,
        "revise_memory",
        json!({
            "memoryId":fixture.memory["id"],"baseRevision":1,
            "content":"登录审计改在 10 月 25 日交付。","reason":"客户已确认新排期","segmentIds":[]
        }),
    );
    assert_eq!(revised["revision"], 2);
    model.finish();
    assert_eq!(
        question.join().unwrap().unwrap_err().code,
        "QA_CONTEXT_STALE"
    );
    let detail = call(
        &fixture.engine,
        "get_memory",
        json!({"memoryId":fixture.memory["id"]}),
    );
    assert_eq!(
        detail["memory"]["content"],
        "登录审计改在 10 月 25 日交付。"
    );
}

#[test]
fn changing_model_configuration_while_answer_is_pending_cancels_late_answer() {
    let mut model = PausedModel::new(false);
    let fixture = Fixture::new(&model.url);
    let question = fixture.ask();
    let captured = model.request();
    assert_eq!(captured.body["model"], "selected-model");
    call(
        &fixture.engine,
        "save_ai_settings",
        settings_payload(&model.url, "replacement-model"),
    );
    model.finish();
    assert_eq!(
        question.join().unwrap().unwrap_err().code,
        "QA_CONTEXT_STALE"
    );
    assert_eq!(
        call(&fixture.engine, "get_ai_settings", json!({}))["model"],
        "replacement-model"
    );
}
