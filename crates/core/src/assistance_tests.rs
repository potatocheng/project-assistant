//! Real Engine + HTTP protocol fixture. No live model or user credentials.
use crate::{Engine, Request};
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};

struct Model {
    url: String,
    calls: Arc<AtomicUsize>,
    mode: Arc<AtomicUsize>,
    seen: Arc<Mutex<Vec<Value>>>,
    stop: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}
impl Model {
    fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let mode = Arc::new(AtomicUsize::new(0));
        let seen = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let (count, behavior, requests, stopped) =
            (calls.clone(), mode.clone(), seen.clone(), stop.clone());
        let worker = thread::spawn(move || {
            while !stopped.load(Ordering::SeqCst) {
                let Ok((mut stream, _)) = listener.accept() else {
                    thread::sleep(Duration::from_millis(5));
                    continue;
                };
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut bytes = Vec::new();
                let mut chunk = [0; 8192];
                let (header, length) = loop {
                    let n = stream.read(&mut chunk).unwrap();
                    assert!(n > 0);
                    bytes.extend_from_slice(&chunk[..n]);
                    if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&bytes[..end]).to_lowercase();
                        let length = headers
                            .lines()
                            .find_map(|l| l.strip_prefix("content-length:"))
                            .unwrap()
                            .trim()
                            .parse::<usize>()
                            .unwrap();
                        break (end + 4, length);
                    }
                };
                while bytes.len() < header + length {
                    let n = stream.read(&mut chunk).unwrap();
                    assert!(n > 0);
                    bytes.extend_from_slice(&chunk[..n]);
                }
                let body: Value = serde_json::from_slice(&bytes[header..header + length]).unwrap();
                let input: Value =
                    serde_json::from_str(body["messages"][1]["content"].as_str().unwrap()).unwrap();
                assert!(
                    input["schema"]["properties"]["focus"].is_object(),
                    "JSON-object models must receive the output schema"
                );
                requests.lock().unwrap().push(input.clone());
                let mode = behavior.load(Ordering::SeqCst);
                count.fetch_add(1, Ordering::SeqCst);
                if mode == 2 {
                    thread::sleep(Duration::from_millis(300));
                }
                let reference = input["references"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|r| r["kind"] == "task")
                    .unwrap();
                let output = json!({"focus":[{"title":"先核对当前阻塞","analysis":reference["content"],"action":"向负责人核实前置条件与可交付时间。", "taskId":reference["taskId"],
                    "evidence":[{"referenceId":if mode==1 {json!("forged")} else {reference["id"].clone()},"quote":reference["content"]}]}],
                    "risks":[],"actions":[],"questions":[],"communicationDraft":if input["request"]["kind"]=="coach" {"想核对一下目前的前置条件，方便确认下一步需要什么吗？"} else {""}});
                let response = json!({"choices":[{"message":{"role":"assistant","content":output.to_string()},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":50,"total_tokens":150}}).to_string();
                write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",response.len(),response).unwrap();
            }
        });
        Self {
            url,
            calls,
            mode,
            seen,
            stop,
            worker: Some(worker),
        }
    }
}
impl Drop for Model {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        self.worker.take().unwrap().join().unwrap();
    }
}
fn call(e: &Engine, command: &str, payload: Value) -> Value {
    e.execute(Request {
        command: command.into(),
        payload,
    })
    .unwrap_or_else(|err| panic!("{command}: {err}"))
}
fn task(e: &Engine, project: &Value, title: &str) -> Value {
    call(
        e,
        "create_task",
        json!({"projectId":project["id"],"clientRequestId":uuid::Uuid::new_v4().to_string(),"title":title,"description":"前置接口尚待确认","category":"action","priority":"high","status":"blocked","workDate":"2026-10-30","plannedDate":"2026-10-30"}),
    )
}
fn update(e: &Engine, task: &Value) -> Value {
    let mut request = task.clone();
    request["clientRequestId"] = json!(uuid::Uuid::new_v4().to_string());
    request["taskId"] = task["id"].clone();
    request["baseVersion"] = task["version"].clone();
    request["workDate"] = json!("2026-10-30");
    request["description"] = json!("前置接口已有新变化，等待核实");
    request["note"] = json!("记录变化");
    call(e, "update_task", request)
}
fn setup(model: &Model) -> (tempfile::TempDir, Engine, Value, Value) {
    let dir = tempfile::tempdir().unwrap();
    let e = Engine::open(dir.path()).unwrap();
    call(
        &e,
        "save_ai_settings",
        json!({"provider":"openai_compatible","baseUrl":model.url,"model":"fixture","outputFormat":"json_object","timeoutSeconds":5,"apiKey":"fixture-key","autoExtract":false,"remoteConsent":false}),
    );
    let p = call(&e, "create_project", json!({"name":"交付项目"}));
    let t = task(&e, &p, "接口联调");
    (dir, e, p, t)
}
fn confirmed_material(e: &Engine, p: &Value) {
    let content = "接口联调必须先由业务方核对验收清单，验收联系人尚待确认。";
    let imported = call(
        e,
        "import_text",
        json!({"projectId":p["id"],"title":"联调验收约定","text":content}),
    );
    let mut source = Value::Null;
    for _ in 0..400 {
        source = call(e, "get_source", json!({"sourceId":imported["sourceId"]}));
        if source["source"]["status"] == "ready" {
            break;
        }
        thread::sleep(Duration::from_millis(5));
    }
    let proposal = call(
        e,
        "create_proposal",
        json!({"projectId":p["id"],"sourceId":imported["sourceId"],"kind":"requirement","content":content,"segmentIds":[source["segments"][0]["id"]]}),
    );
    call(e, "confirm_proposal", json!({"proposalId":proposal["id"]}));
}

#[test]
fn briefs_and_coaching_use_scoped_evidence_cache_and_never_edit_tasks() {
    let model = Model::start();
    let (_dir, e, p, t) = setup(&model);
    confirmed_material(&e, &p);
    let other = call(&e, "create_project", json!({"name":"隔离项目"}));
    task(&e, &other, "SECRET_OTHER_PROJECT");
    call(
        &e,
        "record_follow_up",
        json!({"taskId":t["id"],"baseVersion":0,"workDate":"2026-10-30","note":"已询问对方测试环境何时可用","nextFollowUpDate":"2026-10-31"}),
    );
    let pld = json!({"date":"2026-10-30","projectId":p["id"]});
    let first = call(&e, "generate_today_brief", pld.clone());
    assert_eq!(first["mode"], "model");
    assert_eq!(first["cached"], false);
    assert_eq!(
        call(&e, "generate_today_brief", pld.clone())["cached"],
        true
    );
    assert_eq!(model.calls.load(Ordering::SeqCst), 1);
    let coach = call(
        &e,
        "generate_task_coaching",
        json!({"date":"2026-10-30","taskId":t["id"],"reason":"reply","situation":"对方尚未回复"}),
    );
    assert!(!coach["communicationDraft"].as_str().unwrap().is_empty());
    let seen = model.seen.lock().unwrap();
    assert!(seen
        .iter()
        .all(|v| !v.to_string().contains("SECRET_OTHER_PROJECT")));
    assert!(seen[1].to_string().contains("已询问对方测试环境何时可用"));
    assert_eq!(seen[1]["request"]["situation"], "对方尚未回复");
    drop(seen);
    let seen = model.seen.lock().unwrap();
    assert!(seen[0]["references"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["kind"] == "source_passage"));
    assert!(seen[1].to_string().contains("验收联系人尚待确认"));
    drop(seen);
    assert_eq!(
        call(&e, "get_task", json!({"taskId":t["id"]}))["task"]["version"],
        1
    );
    update(&e, &t);
    call(&e, "generate_today_brief", pld.clone());
    assert_eq!(model.calls.load(Ordering::SeqCst), 3);
    call(
        &e,
        "generate_today_brief",
        json!({"date":"2026-10-30","projectId":p["id"],"refresh":true}),
    );
    assert_eq!(model.calls.load(Ordering::SeqCst), 4);
}

#[test]
fn forged_citations_and_results_from_changed_records_are_rejected() {
    let model = Model::start();
    let (_dir, e, p, t) = setup(&model);
    model.mode.store(1, Ordering::SeqCst);
    let pld = json!({"date":"2026-10-30","projectId":p["id"]});
    assert_eq!(
        e.execute(Request {
            command: "generate_today_brief".into(),
            payload: pld.clone()
        })
        .unwrap_err()
        .code,
        "ASSISTANCE_INVALID"
    );
    model.mode.store(2, Ordering::SeqCst);
    let handle = e.clone();
    let running = thread::spawn(move || {
        handle.execute(Request {
            command: "generate_today_brief".into(),
            payload: pld,
        })
    });
    for _ in 0..500 {
        if model.calls.load(Ordering::SeqCst) >= 2 {
            break;
        }
        thread::sleep(Duration::from_millis(5));
    }
    update(&e, &t);
    assert_eq!(
        running.join().unwrap().unwrap_err().code,
        "ASSISTANCE_STALE"
    );
}

#[test]
fn missing_configuration_and_cross_project_task_requests_do_not_call_a_model() {
    let dir = tempfile::tempdir().unwrap();
    let e = Engine::open(dir.path()).unwrap();
    assert_eq!(
        e.execute(Request {
            command: "generate_today_brief".into(),
            payload: json!({"date":"2026-10-30"})
        })
        .unwrap_err()
        .code,
        "AI_NOT_CONFIGURED"
    );
    let model = Model::start();
    let (_dir, e, _p, t) = setup(&model);
    let other = call(&e, "create_project", json!({"name":"其他项目"}));
    assert_eq!(
        e.execute(Request {
            command: "generate_task_coaching".into(),
            payload: json!({"date":"2026-10-30","projectId":other["id"],"taskId":t["id"]})
        })
        .unwrap_err()
        .code,
        "ASSISTANCE_INVALID"
    );
    assert_eq!(model.calls.load(Ordering::SeqCst), 0);
}

#[test]
fn evidence_revision_changes_for_followups_and_profiles_but_not_saved_drafts() {
    let model = Model::start();
    let (_dir, e, p, t) = setup(&model);
    let before = call(&e, "get_state", json!({}))["assistanceRevision"].clone();
    call(
        &e,
        "save_draft",
        json!({"key":"task:ai-coach:sample","baseVersion":0,"body":{"situation":"尚未提交的补充"}}),
    );
    assert_eq!(
        call(&e, "get_state", json!({}))["assistanceRevision"],
        before
    );
    call(
        &e,
        "record_follow_up",
        json!({"taskId":t["id"],"baseVersion":0,"workDate":"2026-10-30","note":"等待新回复","nextFollowUpDate":"2026-10-31"}),
    );
    let followup = call(&e, "get_state", json!({}))["assistanceRevision"].clone();
    assert_ne!(before, followup);
    call(
        &e,
        "save_project_profile",
        json!({"projectId":p["id"],"baseVersion":0,"goal":"优先保证验收质量","status":"active","targetDate":"2026-11-06"}),
    );
    assert_ne!(
        call(&e, "get_state", json!({}))["assistanceRevision"],
        followup
    );
}
