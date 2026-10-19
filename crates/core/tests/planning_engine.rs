//! Real model HTTP and public Engine integration; only loopback fixtures are used.
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

fn day() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}
struct Fixture {
    _directory: tempfile::TempDir,
    engine: Engine,
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
            "接口评审",
            "先确认接口约定，再上线联调。",
        );
        for title in ["确认接口约定", "上线联调"] {
            call(
                &engine,
                "create_task",
                json!({"projectId":project["id"],"title":title,"description":"","category":"action","assignee":null,"priority":"medium","status":"todo","progress":0,"dueDate":null,"plannedDate":null,"workDate":day(),"clientRequestId":uuid::Uuid::new_v4().to_string()}),
            );
        }
        call(
            &engine,
            "save_daily_capacity",
            json!({"date":day(),"minutes":180,"bufferMinutes":30,"baseRevision":null}),
        );
        Self {
            _directory: directory,
            engine,
            project,
            memory,
        }
    }
    fn analyze(&self) -> thread::JoinHandle<Result<Value, AppError>> {
        let engine = self.engine.clone();
        let project = self.project["id"].clone();
        thread::spawn(move || {
            engine.execute(Request {
                command: "analyze_task_workload".into(),
                payload: json!({"date":day(),"projectId":project,"useModel":true}),
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
    fn new(invalid_quote: bool) -> Self {
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
            let tasks = envelope["tasks"].as_array().unwrap();
            let first = tasks.iter().find(|t| t["title"] == "确认接口约定").unwrap();
            let second = tasks.iter().find(|t| t["title"] == "上线联调").unwrap();
            let memory = envelope["memories"][0].clone();
            let reference = envelope["evidence"]
                .as_array()
                .unwrap()
                .iter()
                .find(|e| e["refId"].as_str().unwrap().starts_with("memory:"))
                .unwrap();
            let output = json!({"changes":[{"kind":"dependency","taskId":second["id"],"targetId":first["id"],"proposalId":null,"memoryId":null,"title":null,"minutes":null,"reason":"先确认接口约定才能上线联调","evidence":[{"refId":reference["refId"],"quote":if invalid_quote {"不存在的引文"}else{"先确认接口约定，再上线联调。"}}]},{"kind":"memory_task","taskId":null,"targetId":null,"proposalId":null,"memoryId":memory["id"],"title":"跟进上线前接口确认","minutes":null,"reason":"来自项目当前记忆","evidence":[{"refId":reference["refId"],"quote":"先确认接口约定，再上线联调。"}]}]});
            captured_sender.send(captured).unwrap();
            release_receiver
                .recv_timeout(Duration::from_secs(10))
                .unwrap();
            let response = json!({"choices":[{
                "message":{"role":"assistant","content":output.to_string()},"finish_reason":"stop"
            }]})
            .to_string();
            write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",response.len(),response).unwrap();
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
fn model_reads_memory_but_changes_only_selected_items_after_explicit_approval() {
    let mut model = PausedModel::new(false);
    let fixture = Fixture::new(&model.url);
    let other = call(
        &fixture.engine,
        "create_project",
        json!({"name":"其他客户"}),
    );
    confirm_memory(
        &fixture.engine,
        &other,
        "保密纪要",
        "这条其他项目内容不能发送。",
    );
    let before = call(&fixture.engine, "get_state", json!({}));
    let analysis = fixture.analyze();
    let request = model.request();
    assert!(request
        .headers
        .to_lowercase()
        .contains("authorization: bearer fixture-private-model-key"));
    assert_eq!(request.body["model"], "selected-model");
    assert!(!request.body.to_string().contains("这条其他项目内容"));
    let input: Value =
        serde_json::from_str(request.body["messages"][1]["content"].as_str().unwrap()).unwrap();
    assert_eq!(input["memories"][0]["id"], fixture.memory["id"]);
    model.finish();
    let draft = analysis.join().unwrap().unwrap();
    assert_eq!(draft["result"]["changes"].as_array().unwrap().len(), 2);
    assert_eq!(
        call(&fixture.engine, "get_state", json!({}))["tasks"],
        before["tasks"]
    );
    let scope = json!({"date":day(),"projectId":fixture.project["id"]});
    assert!(
        call(&fixture.engine, "get_daily_planning", scope.clone())["relations"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    call(
        &fixture.engine,
        "confirm_planning_draft",
        json!({"draftId":draft["id"],"selectedIds":[draft["result"]["changes"][0]["id"]]}),
    );
    assert_eq!(
        call(&fixture.engine, "get_state", json!({}))["tasks"],
        before["tasks"]
    );
    assert_eq!(
        call(&fixture.engine, "get_daily_planning", scope.clone())["relations"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let plan = call(&fixture.engine, "generate_daily_plan", scope);
    assert_eq!(plan["result"]["items"][0]["title"], "确认接口约定");
    assert_eq!(
        plan["result"]["items"][1]["conditionalOn"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    call(
        &fixture.engine,
        "confirm_planning_draft",
        json!({"draftId":plan["id"],"selectedIds":[]}),
    );
    assert!(call(&fixture.engine, "get_state", json!({}))["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .all(|t| t["plannedDate"] == day()));
}
#[test]
fn model_wait_does_not_block_actor_and_changed_capacity_rejects_late_analysis() {
    let mut model = PausedModel::new(false);
    let fixture = Fixture::new(&model.url);
    let analysis = fixture.analyze();
    model.request();
    let engine = fixture.engine.clone();
    let project = fixture.project["id"].clone();
    let (tx, rx) = mpsc::channel();
    let reader = thread::spawn(move || {
        let scope = json!({"date":day(),"projectId":project});
        tx.send(call(&engine, "get_daily_planning", scope)).unwrap()
    });
    let overview = rx
        .recv_timeout(Duration::from_secs(2))
        .expect("model request blocked actor");
    reader.join().unwrap();
    call(
        &fixture.engine,
        "save_daily_capacity",
        json!({"date":day(),"minutes":120,"bufferMinutes":30,"baseRevision":overview["capacity"]["revision"]}),
    );
    model.finish();
    assert_eq!(analysis.join().unwrap().unwrap_err().code, "PLANNING_STALE");
    assert!(call(
        &fixture.engine,
        "get_daily_planning",
        json!({"date":day(),"projectId":fixture.project["id"]})
    )["drafts"]
        .as_array()
        .unwrap()
        .is_empty());
}
#[test]
fn unknown_model_quotes_never_create_a_reviewable_draft() {
    let mut model = PausedModel::new(true);
    let fixture = Fixture::new(&model.url);
    let analysis = fixture.analyze();
    model.request();
    model.finish();
    assert_eq!(
        analysis.join().unwrap().unwrap_err().code,
        "PLANNING_VALIDATION"
    );
    assert!(call(
        &fixture.engine,
        "get_daily_planning",
        json!({"date":day(),"projectId":fixture.project["id"]})
    )["drafts"]
        .as_array()
        .unwrap()
        .is_empty());
}
