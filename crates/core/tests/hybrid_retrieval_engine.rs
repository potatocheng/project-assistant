use project_assistant_core::{Engine, Request};
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};

fn call(engine: &Engine, command: &str, payload: Value) -> Value {
    engine
        .execute(Request {
            command: command.into(),
            payload,
        })
        .unwrap_or_else(|e| panic!("{command} failed: {e}"))
}

fn wait_ready(engine: &Engine, source_id: &str) {
    let start = Instant::now();
    loop {
        let state = call(engine, "get_state", json!({}));
        let ready = state["sources"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["id"] == source_id && s["status"] == "ready");
        if ready {
            return;
        }
        assert!(start.elapsed() < Duration::from_secs(10), "source parse timed out");
        thread::sleep(Duration::from_millis(20));
    }
}

fn import_and_confirm(engine: &Engine, project_id: &str, title: &str, text: &str, content: &str) -> (String, String) {
    let imported = call(
        engine,
        "import_text",
        json!({"projectId": project_id, "title": title, "text": text}),
    );
    let source_id = imported["sourceId"].as_str().unwrap().to_owned();
    wait_ready(engine, &source_id);
    let detail = call(engine, "get_source", json!({"sourceId": source_id}));
    let seg_id = detail["segments"][0]["id"].as_str().unwrap().to_owned();
    let prop = call(
        engine,
        "create_proposal",
        json!({"projectId": project_id, "sourceId": source_id, "kind": "fact", "content": content, "segmentIds": [seg_id]}),
    );
    let mem = call(engine, "confirm_proposal", json!({"proposalId": prop["id"]}));
    (source_id, mem["id"].as_str().unwrap().to_owned())
}

#[test]
fn verified_memory_search_respects_aliases_lifecycle_and_hybrid_sqlite_vec() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path()).unwrap();

    let project = call(&engine, "create_project", json!({"name": "支付网关二期"}));
    let project_id = project["id"].as_str().unwrap().to_owned();

    let (_src1, mem_owner) = import_and_confirm(
        &engine,
        &project_id,
        "周会纪要",
        "支付重构核心模块由王明负责，预计下周三联调。",
        "支付重构核心模块由王明负责。",
    );
    let (_src2, mem_delay) = import_and_confirm(
        &engine,
        &project_id,
        "排期同步",
        "网关上线日期已推迟至 2026-12-03。",
        "网关上线日期已推迟至 2026-12-03。",
    );
    let (src_archived, mem_archived) = import_and_confirm(
        &engine,
        &project_id,
        "过期方案",
        "支付重构旧版接口采用明文传输。",
        "支付重构旧版接口采用明文传输。",
    );

    // Archive src_archived -> its memory must NEVER appear in verified search
    let impact = call(
        &engine,
        "lifecycle_impact",
        json!({"kind": "source", "id": src_archived}),
    );
    call(
        &engine,
        "set_lifecycle",
        json!({"kind": "source", "id": src_archived, "archived": true, "reason": "旧版已废止", "baseVersion": 0, "fingerprint": impact["fingerprint"]}),
    );

    // Add team alias: 老王 -> 王明
    call(
        &engine,
        "save_entity_alias",
        json!({"projectId": project_id, "canonical": "王明", "aliases": ["老王", "后端王哥"], "kind": "person", "note": "后端负责人"}),
    );

    // Verified search via alias finds mem_owner with evidence and excludes archived mem_archived
    let res = call(
        &engine,
        "search_verified_memories",
        json!({"projectId": project_id, "query": "老王负责什么模块", "date": "2026-11-24"}),
    );
    let ids: Vec<&str> = res["memories"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|m| m["id"].as_str())
        .collect();
    assert!(ids.contains(&mem_owner.as_str()), "expected alias match: {res}");
    assert!(!ids.contains(&mem_archived.as_str()), "archived memory leaked: {res}");
    assert_eq!(res["searchTrace"]["jieba"], true);
    assert!(res["searchTrace"]["aliasGroupsApplied"].as_u64().unwrap() >= 1);

    // Start local loopback Ollama-compatible embedding stub
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let addr = listener.local_addr().unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let stopping = stop.clone();
    let server = thread::spawn(move || {
        while !stopping.load(Ordering::SeqCst) {
            let (mut stream, _) = match listener.accept() {
                Ok(s) => s,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(5));
                    continue;
                }
                Err(_) => break,
            };
            stream.set_nonblocking(false).unwrap();
            let mut buf = Vec::new();
            let mut tmp = [0u8; 4096];
            let end = loop {
                let n = stream.read(&mut tmp).unwrap();
                if n == 0 {
                    break buf.len();
                }
                buf.extend_from_slice(&tmp[..n]);
                if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                    break pos + 4;
                }
            };
            let headers = String::from_utf8_lossy(&buf[..end]);
            let len = headers
                .lines()
                .filter_map(|l| l.split_once(':'))
                .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
                .and_then(|(_, v)| v.trim().parse::<usize>().ok())
                .unwrap_or(0);
            while buf.len() < end + len {
                let n = stream.read(&mut tmp).unwrap();
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&tmp[..n]);
            }
            let body: Value = serde_json::from_slice(&buf[end..end + len]).unwrap();
            let inputs = body["input"].as_array().unwrap();
            let embeddings: Vec<Vec<f32>> = inputs
                .iter()
                .map(|v| {
                    let s = v.as_str().unwrap_or("");
                    if s.contains("延期") || s.contains("推迟") {
                        vec![1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]
                    } else if s.contains("明文") {
                        // Even if archived memory matches vector identically, Rust MUST block it!
                        vec![1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]
                    } else {
                        vec![0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]
                    }
                })
                .collect();
            let resp = json!({"embeddings": embeddings}).to_string();
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                resp.len(),
                resp
            )
            .unwrap();
        }
    });

    call(
        &engine,
        "save_semantic_search_settings",
        json!({
            "enabled": true,
            "provider": "ollama",
            "baseUrl": format!("http://{addr}"),
            "model": "bge-m3",
            "timeoutSeconds": 10,
            "remoteConsent": false
        }),
    );
    let tested = call(&engine, "test_embedding_connection", json!({}));
    assert_eq!(tested["ok"], true);
    assert_eq!(tested["dimensions"], 8);

    let rebuilt = call(&engine, "rebuild_semantic_index", json!({}));
    assert_eq!(rebuilt["indexed"], 3);
    assert_eq!(rebuilt["dimensions"], 8);

    // Hybrid search: query "发版会不会延期" has zero lexical overlap with "网关上线日期已推迟至 2026-12-03。"
    let hybrid = call(
        &engine,
        "search_verified_memories",
        json!({"projectId": project_id, "query": "发版会不会延期", "date": "2026-11-24"}),
    );
    let hybrid_ids: Vec<&str> = hybrid["memories"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|m| m["id"].as_str())
        .collect();
    assert_eq!(hybrid_ids, vec![mem_delay.as_str()]);
    assert!(!hybrid_ids.contains(&mem_archived.as_str()));
    assert_eq!(hybrid["searchTrace"]["hybridRetrieval"]["fusion"], "rrf");
    assert_eq!(hybrid["searchTrace"]["hybridRetrieval"]["eligibleVecHits"], 1);

    // Backup & restore preserves entity_aliases and clears derived semantic-index.sqlite
    let backup = call(&engine, "create_backup", json!({}));
    let filename = backup["filename"].as_str().unwrap();
    let zip_bytes = std::fs::read(dir.path().join("backups").join(filename)).unwrap();
    use base64::Engine as _;
    let encoded = base64::engine::general_purpose::STANDARD.encode(zip_bytes);
    call(
        &engine,
        "restore_backup",
        json!({"filename": filename, "contentBase64": encoded, "confirmation": "RESTORE"}),
    );
    assert!(!dir.path().join("semantic-index.sqlite").exists());
    let aliases_after = call(&engine, "list_entity_aliases", json!({"projectId": project_id}));
    assert_eq!(aliases_after["count"], 1);
    assert_eq!(aliases_after["aliases"][0]["canonical"], "王明");

    stop.store(true, Ordering::SeqCst);
    let _ = server.join();
}
