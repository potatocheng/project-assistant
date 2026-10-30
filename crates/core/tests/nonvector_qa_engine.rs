//! Deterministic protocol tests for the production non-vector search loop.
//! Model fixtures prove control flow and isolation, not semantic model quality.
use project_assistant_core::{Engine, Request};
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

#[test]
fn ordered_mechanism_navigation_reaches_current_facts_without_an_extra_model_call() {
    const PROCESS: &str = "We process the sequence in order, retaining the previous state for the next item. This operation is used only for archived reports.";
    for desktop in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let engine = Engine::open(root.path()).unwrap();
        let project = call(&engine, "create_project", json!({"name":"顺序处理"}));
        formal(&engine, &project, PROCESS, true);
        for n in 0..26 {
            formal(&engine, &project, &format!("Report {n} records a quality rating and an unrelated administrative observation."), true);
        }
        let other = call(&engine, "create_project", json!({"name":"其他范围"}));
        formal(
            &engine,
            &other,
            "FOREIGN_SEQUENCE_SECRET processes every sequence in order.",
            true,
        );
        formal(
            &engine,
            &project,
            "PENDING_SEQUENCE_SECRET processes every sequence in order.",
            false,
        );
        let before = call(&engine, "get_state", json!({}));
        let (url, worker) = model(2, |index, input| {
            assert!(!input.to_string().contains("FOREIGN_SEQUENCE_SECRET"));
            assert!(!input.to_string().contains("PENDING_SEQUENCE_SECRET"));
            if index == 0 {
                let refs = input["references"]
                    .as_array()
                    .or_else(|| input["context"]["memories"].as_array())
                    .unwrap();
                assert!(refs.len() <= 24);
                assert!(input.to_string().contains(PROCESS));
                assert_eq!(refs[0]["content"][0]["text"], PROCESS);
                response(input, PROCESS)
            } else {
                json!({"supported":true,"obligations":[{"target":"sequential processing mechanism","status":"answered","claimIndices":[1]}],
                    "unknownDecisions":[],"unsupportedClaims":[],"missingAspects":[],"reason":"Current ordered processing and state retention are directly recorded."})
            }
        });
        configure(&engine, &url, "nonvector-model");
        let answer = ask(
            &engine,
            &project,
            desktop,
            "How is sequential processing implemented?",
        );
        assert_eq!(answer["grounded"], true);
        assert_eq!(answer["queryTrace"]["modelCalls"], 2);
        assert_eq!(
            answer["queryTrace"]["generationRounds"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert!(answer["answer"]
            .as_str()
            .unwrap()
            .contains("only for archived reports"));
        assert_eq!(
            answer["context"]["searchQueries"],
            json!(["sequence order"])
        );
        let after = call(&engine, "get_state", json!({}));
        for key in ["memories", "proposals", "tasks"] {
            assert_eq!(before[key], after[key]);
        }
        assert_eq!(worker.join().unwrap().len(), 2);
    }
}

fn call(engine: &Engine, command: &str, payload: Value) -> Value {
    engine
        .execute(Request {
            command: command.into(),
            payload,
        })
        .unwrap_or_else(|e| panic!("{command}: {e}"))
}
fn configure(engine: &Engine, url: &str, model: &str) {
    call(
        engine,
        "save_ai_settings",
        json!({"provider":"openai_compatible","baseUrl":url,"model":model,
        "outputFormat":"json_object","timeoutSeconds":10,"autoExtract":false,"remoteConsent":false,"apiKey":"nonvector-fixture-private"}),
    );
}
fn formal(engine: &Engine, project: &Value, text: &str, confirmed: bool) -> Value {
    let imported = call(
        engine,
        "import_text",
        json!({"projectId":project["id"],"title":"已核对资料","text":text}),
    );
    let deadline = Instant::now() + Duration::from_secs(10);
    let source = loop {
        let source = call(
            engine,
            "get_source",
            json!({"sourceId":imported["sourceId"]}),
        );
        if source["source"]["status"] == "ready" {
            break source;
        }
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(5));
    };
    let proposal = call(
        engine,
        "create_proposal",
        json!({"projectId":project["id"],"sourceId":imported["sourceId"],
        "kind":"fact","content":text,"segmentIds":source["segments"].as_array().unwrap().iter().map(|s|s["id"].clone()).collect::<Vec<_>>()}),
    );
    if confirmed {
        call(
            engine,
            "confirm_proposal",
            json!({"proposalId":proposal["id"]}),
        )
    } else {
        proposal
    }
}
fn read_request(stream: &mut TcpStream) -> Value {
    stream.set_nonblocking(false).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 4096];
    let end = loop {
        let n = stream.read(&mut buffer).unwrap();
        assert!(n > 0 && bytes.len() < 512 * 1024);
        bytes.extend_from_slice(&buffer[..n]);
        if let Some(i) = bytes.windows(4).position(|b| b == b"\r\n\r\n") {
            break i + 4;
        }
    };
    let headers = String::from_utf8_lossy(&bytes[..end]);
    let size = headers
        .lines()
        .find_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().unwrap())
        })
        .unwrap();
    while bytes.len() < end + size {
        let n = stream.read(&mut buffer).unwrap();
        assert!(n > 0);
        bytes.extend_from_slice(&buffer[..n]);
    }
    let body: Value = serde_json::from_slice(&bytes[end..end + size]).unwrap();
    assert!(
        body["messages"][0]["content"]
            .as_str()
            .unwrap()
            .contains("JSON"),
        "JSON object mode must state its output format, including review requests"
    );
    assert_eq!(body["model"], "nonvector-model");
    assert!(body.get("tools").is_none());
    serde_json::from_str(body["messages"][1]["content"].as_str().unwrap()).unwrap()
}
fn model(
    count: usize,
    mut respond: impl FnMut(usize, &Value) -> Value + Send + 'static,
) -> (String, thread::JoinHandle<Vec<Value>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let worker = thread::spawn(move || {
        let mut requests = Vec::new();
        for i in 0..count {
            let deadline = Instant::now() + Duration::from_secs(15);
            let mut stream = loop {
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(Instant::now() < deadline, "expected request {i}");
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("{error}"),
                }
            };
            let input = read_request(&mut stream);
            let output = respond(i, &input);
            let response=json!({"usage":{"prompt_tokens":234,"completion_tokens":19,"total_tokens":253},"choices":[{"message":{"content":output.to_string()},"finish_reason":"stop"}]}).to_string();
            write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",response.len(),response).unwrap();
            requests.push(input);
        }
        requests
    });
    (url, worker)
}
fn response(input: &Value, text: &str) -> Value {
    let reference = if input["references"].is_array() {
        &input["references"][0]
    } else {
        &input["context"]["memories"][0]
    };
    assert_eq!(reference["referenceIndex"], 1);
    assert_eq!(reference["content"][0]["spanIndex"], 1);
    json!({"grounded":true,"status":"answered","unknowns":[],"claims":[{
        "text":text,"supportSpans":[{"referenceIndex":1,"spanIndex":1}]}]})
}
fn assert_typed_source_passages(references: &[Value], expected: &[String]) -> usize {
    use sha2::{Digest, Sha256};
    let mut count = 0;
    for reference in references
        .iter()
        .filter(|reference| reference["kind"] == "source_passage")
    {
        count += 1;
        assert!(reference.get("memoryId").is_none());
        let source = reference["sourceId"].as_str().unwrap();
        let segment = reference["segmentId"].as_str().unwrap();
        assert_eq!(reference["id"], format!("source:{source}:{segment}"));
        assert!(!reference["sourceVersionId"].as_str().unwrap().is_empty());
        assert!(!reference["sourceHash"].as_str().unwrap().is_empty());
        let spans = reference["content"].as_array().unwrap();
        let mut content = String::new();
        for (index, span) in spans.iter().enumerate() {
            assert_eq!(span["spanIndex"], index + 1);
            content.push_str(span["text"].as_str().unwrap());
        }
        assert!(
            expected.contains(&content),
            "unexpected or incomplete source passage: {content}"
        );
        assert_eq!(
            reference["contentHash"],
            format!("{:x}", Sha256::digest(content.as_bytes()))
        );
    }
    count
}
fn ask(engine: &Engine, project: &Value, desktop: bool, question: &str) -> Value {
    call(
        engine,
        if desktop {
            "ask_assistant"
        } else {
            "ask_project"
        },
        json!({"projectId":project["id"],"question":question,"date":"2026-10-20","useModel":true}),
    )
}

#[test]
fn both_entrypoints_send_the_same_current_memory_pack_from_sixty_four_candidates() {
    const DEFINITION: &str = "The initial context is set to the preceding sentence state, then each sentence is processed in order. This applies only to archived reports.";
    const QUESTION: &str = "How does Atlas encoder process each sentence?";
    let directory = tempfile::tempdir().unwrap();
    let engine = Engine::open(directory.path()).unwrap();
    let project = call(
        &engine,
        "create_project",
        json!({"name":"Isolated fixture scope"}),
    );
    let revised = formal(
        &engine,
        &project,
        "Atlas sequential encoder has OLD_REVISION_SECRET configuration.",
        true,
    );
    call(
        &engine,
        "revise_memory",
        json!({"memoryId":revised["id"],"baseRevision":1,
        "content":"Atlas sequential encoder has CURRENT_REVISION_MARKER configuration for each sentence.",
        "reason":"Current confirmed correction","segmentIds":[]}),
    );
    for number in 0..62 {
        formal(&engine,&project,&format!("Atlas sequential encoder records each sentence using documented model configuration option {number}."),true);
    }
    // Give the processing term a realistic corpus frequency. A unique method
    // word would otherwise rank the definition first and never exercise pack
    // selection beyond the original 24. These single-term records stay below
    // the richer Atlas candidates and never enter the 64-record pool.
    for number in 0..70 {
        formal(
            &engine,
            &project,
            &format!("Auxiliary service processes diagnostic input batch {number}."),
            true,
        );
    }
    let definition = formal(&engine, &project, DEFINITION, true);
    let other = call(&engine, "create_project", json!({"name":"Foreign scope"}));
    formal(
        &engine,
        &other,
        "FOREIGN_PACK_SECRET Atlas sequential encoder processes each sentence.",
        true,
    );
    formal(
        &engine,
        &project,
        "PENDING_PACK_SECRET Atlas sequential encoder processes each sentence.",
        false,
    );
    let expected_sources = std::iter::once(DEFINITION.to_owned()).chain((0..62).map(|number|
        format!("Atlas sequential encoder records each sentence using documented model configuration option {number}.")))
        .collect::<Vec<_>>();
    let (url, worker) = model(4, move |index, input| {
        for secret in [
            "OLD_REVISION_SECRET",
            "FOREIGN_PACK_SECRET",
            "PENDING_PACK_SECRET",
        ] {
            assert!(
                !input.to_string().contains(secret),
                "model input leaked {secret}"
            );
        }
        assert!(input.get("memoryCandidatePool").is_none());
        assert!(input["context"].get("memoryCandidatePool").is_none());
        assert!(!input.to_string().contains("navigationLinks"));
        let references = input["references"]
            .as_array()
            .or_else(|| input["context"]["memories"].as_array())
            .unwrap();
        let memories = references
            .iter()
            .filter(|reference| reference["kind"] != "source_passage")
            .collect::<Vec<_>>();
        assert_eq!(memories.len(), 24);
        assert!(memories
            .iter()
            .all(|reference| reference["kind"] == "memory" || reference["kind"] == "fact"));
        let sources = assert_typed_source_passages(references, &expected_sources);
        assert!((1..=8).contains(&sources));
        assert_eq!(references.len(), 24 + sources);
        assert!(references.len() <= 32);
        if index % 2 == 0 {
            let reference = memories
                .iter()
                .find(|reference| reference["content"][0]["text"] == DEFINITION)
                .expect("the later method definition must enter the actual first generation pack");
            assert!(serde_json::to_string(references).unwrap().chars().count() <= 36_000);
            json!({"grounded":true,"status":"answered","unknowns":[],"claims":[{
                "text":DEFINITION,"supportSpans":[{"referenceIndex":reference["referenceIndex"],"spanIndex":1}]}]})
        } else {
            assert_eq!(input["reviewEvidenceScope"], "full-actual-generation-pack");
            assert_eq!(
                input["questionPlan"]["obligations"]
                    .as_array()
                    .unwrap()
                    .len(),
                1
            );
            json!({"obligations":[{"obligationId":"o1","status":"answered","claimIds":["c1"]}],
                "claimReviews":[{"claimId":"c1","verdict":"supported","obligationIds":["o1"]}],
                "unknownDecisions":[],"missingAspects":[],"reason":"Current steps and their archived-report condition directly answer the question."})
        }
    });
    configure(&engine, &url, "nonvector-model");
    let before = call(&engine, "get_state", json!({}));
    let mut answers = Vec::new();
    for desktop in [false, true] {
        let answer = ask(&engine, &project, desktop, QUESTION);
        assert_eq!(answer["status"], "answered");
        assert_eq!(answer["queryTrace"]["modelCalls"], 2);
        assert!(answer["answer"]
            .as_str()
            .unwrap()
            .contains("only to archived reports"));
        let context = &answer["context"];
        assert_eq!(context["memoryCandidatePool"].as_array().unwrap().len(), 64);
        assert_eq!(context["memories"].as_array().unwrap().len(), 24);
        let ranking = context["searchTrace"]["ranking"].as_array().unwrap();
        let definition_rank = ranking
            .iter()
            .position(|row| row["id"] == definition["id"])
            .unwrap();
        assert!(
            definition_rank >= 24,
            "fixture must exercise a candidate beyond the previous first 24, got {}",
            definition_rank + 1
        );
        let current = context["memoryCandidatePool"]
            .as_array()
            .unwrap()
            .iter()
            .find(|record| record["id"] == revised["id"])
            .unwrap();
        assert_eq!(current["revision"], 2);
        assert!(current["content"]
            .as_str()
            .unwrap()
            .contains("CURRENT_REVISION_MARKER"));
        assert!(!current["content"]
            .as_str()
            .unwrap()
            .contains("OLD_REVISION_SECRET"));
        answers.push(answer);
    }
    let requests = worker.join().unwrap();
    let normalized_pack = |input: &Value| {
        input["references"].as_array().or_else(||input["context"]["memories"].as_array()).unwrap().iter().map(|reference| {
            if reference["kind"] == "source_passage" {
                return json!({"id":reference["id"],"kind":"source_passage","content":reference["content"],
                    "sourceId":reference["sourceId"],"sourceVersionId":reference["sourceVersionId"],
                    "sourceHash":reference["sourceHash"],"segmentId":reference["segmentId"],"contentHash":reference["contentHash"]});
            }
            let memory=reference["memoryId"].as_str().unwrap_or_else(||reference["id"].as_str().unwrap().strip_prefix("memory:").unwrap());
            json!({"memoryId":memory,"content":reference["content"],"facets":reference["facets"]})
        }).collect::<Vec<_>>()
    };
    assert_eq!(normalized_pack(&requests[0]), normalized_pack(&requests[2]));
    assert_eq!(normalized_pack(&requests[0]), normalized_pack(&requests[1]));
    assert_eq!(normalized_pack(&requests[2]), normalized_pack(&requests[3]));
    assert_eq!(
        answers[0]["context"]["evidenceSelectionTrace"]["selectedIds"],
        answers[1]["context"]["evidenceSelectionTrace"]["selectedIds"]
    );
    let after = call(&engine, "get_state", json!({}));
    for field in ["memories", "proposals", "tasks"] {
        assert_eq!(before[field], after[field]);
    }
}

#[test]
fn one_rewrite_recalls_old_memory_outside_desktop_initial_window_and_preserves_scope() {
    for desktop in [false, true] {
        // Seed before starting the HTTP fixture's accept deadline. Filesystem
        // work under parallel test load must not consume the model wait budget.
        let directory = tempfile::tempdir().unwrap();
        let engine = Engine::open(directory.path()).unwrap();
        let p = call(&engine, "create_project", json!({"name":"权益项目"}));
        let old = formal(
            &engine,
            &p,
            "权益兑换采用实名核验，同一身份证号码只能领取一份。",
            true,
        );
        for i in 0..85 {
            formal(
                &engine,
                &p,
                &format!("例行记录{i}：本周材料整理完成。"),
                true,
            );
        }
        let other = call(&engine, "create_project", json!({"name":"隔离项目"}));
        formal(
            &engine,
            &other,
            "FOREIGN_SECRET 实名核验 身份证无限领取。",
            true,
        );
        formal(&engine, &p, "PENDING_SECRET 身份证可重复领取。", false);
        let before = call(&engine, "get_state", json!({}));
        let (url, worker) = model(3, |i, input| {
            if i == 2 {
                return json!({"supported":true,"answersQuestion":true,"completeAnswer":true,
                    "obligations":[{"target":"重复领取限制","status":"answered","claimIndices":[1]}],
                    "unknownDecisions":[],"unsupportedClaims":[],"missingAspects":[],"reason":"直接回答重复领取限制，当前正文有据"});
            }
            if i == 0 {
                assert!(input["schema"]["properties"]["queries"].is_object());
                assert!(input.get("references").is_none() && input.get("context").is_none());
                assert!(input["memoryIndex"].is_array());
                assert!(
                    !input.to_string().contains("FOREIGN_SECRET")
                        && !input.to_string().contains("PENDING_SECRET")
                );
                json!({"queries":["实名核验 身份证 领取 一份"]})
            } else {
                assert!(input["context"].get("searchCatalog").is_none());
                assert!(input["context"].get("searchQueries").is_none());
                assert!(input.to_string().contains("同一身份证号码"));
                assert!(!input.to_string().contains("FOREIGN_SECRET"));
                assert!(!input.to_string().contains("PENDING_SECRET"));
                response(input, "权益兑换采用实名核验，同一身份证号码只能领取一份。")
            }
        });
        configure(&engine, &url, "nonvector-model");
        let answer = ask(&engine, &p, desktop, "怎样防止一个人反复薅羊毛？");
        assert_eq!(answer["grounded"], true, "{}", answer["queryTrace"]);
        assert_eq!(answer["queryTrace"]["modelCalls"], 3);
        // Initial retrieval, literal probe, then the bounded directory plan.
        assert_eq!(answer["queryTrace"]["rounds"].as_array().unwrap().len(), 3);
        assert!(answer["citations"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["memoryId"] == old["id"]));
        if desktop {
            assert!(!answer["queryTrace"]["rounds"][0]["ranking"]
                .as_array()
                .unwrap()
                .iter()
                .any(|r| r["id"] == old["id"]));
        }
        assert!(
            !answer.to_string().contains("FOREIGN_SECRET")
                && !answer.to_string().contains("PENDING_SECRET")
        );
        let after = call(&engine, "get_state", json!({}));
        for key in ["memories", "proposals", "tasks"] {
            assert_eq!(before[key], after[key]);
        }
        assert_eq!(worker.join().unwrap().len(), 3);
    }
}

#[test]
fn unsupported_causal_answer_or_failed_review_is_never_returned_as_grounded() {
    for (desktop, valid_review) in [(false, true), (true, true), (true, false)] {
        let expected_calls = 2;
        let (url, worker) = model(expected_calls, move |i, input| {
            if i == 0 {
                response(input, "上线已经延期，原因是客户签字未完成。")
            } else if valid_review {
                let references = input["references"].as_array().unwrap();
                assert_eq!(
                    references
                        .iter()
                        .filter(|reference| reference["kind"] == "memory"
                            || reference["kind"] == "fact")
                        .count(),
                    1
                );
                assert_eq!(
                    assert_typed_source_passages(
                        references,
                        &["上线前必须完成支付验收。".to_owned()]
                    ),
                    1
                );
                assert_eq!(
                    references
                        .iter()
                        .filter(|reference| reference["kind"] == "project")
                        .count(),
                    usize::from(desktop)
                );
                assert_eq!(references.len(), 2 + usize::from(desktop));
                assert_eq!(input["reviewEvidenceScope"], "full-actual-generation-pack");
                json!({"supported":false,"answersQuestion":false,"completeAnswer":false,
                    "obligations":[{"target":"实际延期原因","status":"missing","claimIndices":[]}],
                    "unknownDecisions":[],"missingAspects":["实际延期原因"],"unsupportedClaims":["实际上线延期与客户签字原因"],"reason":"记录只有验收前置条件，没有实际延期和该原因"})
            } else {
                json!({"supported":true,"extra":"illegal-schema"})
            }
        });
        let directory = tempfile::tempdir().unwrap();
        let engine = Engine::open(directory.path()).unwrap();
        configure(&engine, &url, "nonvector-model");
        let p = call(&engine, "create_project", json!({"name":"上线项目"}));
        formal(&engine, &p, "上线前必须完成支付验收。", true);
        let answer = ask(&engine, &p, desktop, "上线为什么延期？");
        assert_eq!(answer["grounded"], false);
        assert_eq!(answer["citations"], json!([]));
        assert_eq!(answer["qualityReview"]["supported"], false);
        assert_eq!(answer["queryTrace"]["modelCalls"], expected_calls);
        assert!(!answer["answer"]
            .as_str()
            .unwrap()
            .contains("原因是客户签字"));
        worker.join().unwrap();
    }
}

#[test]
fn supported_conditional_background_cannot_answer_an_unrecorded_actual_cause() {
    let (url, worker) = model(2, |i, input| {
        if i == 0 {
            response(
                input,
                "记录未说明实际延期；上线前必须完成支付验收，未完成时可能影响上线。",
            )
        } else {
            json!({"supported":true,"answersQuestion":false,"completeAnswer":false,
                "obligations":[{"target":"实际延期原因","status":"missing","claimIndices":[]}],
                "unknownDecisions":[],"missingAspects":["实际延期原因"],"unsupportedClaims":[],"reason":"区分了前置条件与实际延期，条件影响有依据"})
        }
    });
    let directory = tempfile::tempdir().unwrap();
    let engine = Engine::open(directory.path()).unwrap();
    configure(&engine, &url, "nonvector-model");
    let p = call(&engine, "create_project", json!({"name":"条件分析"}));
    formal(&engine, &p, "上线前必须完成支付验收。", true);
    let answer = ask(&engine, &p, true, "上线为什么延期？");
    assert_eq!(answer["grounded"], false);
    assert_eq!(answer["status"], "unknown");
    assert_eq!(answer["qualityReview"]["answersQuestion"], false);
    assert_eq!(answer["qualityReview"]["supported"], true);
    worker.join().unwrap();
}

#[test]
fn invalid_rewrite_stops_before_planned_search_or_any_write() {
    let (url, worker) = model(1, |_, _| json!({"queries":["a","b","c","d"]}));
    let directory = tempfile::tempdir().unwrap();
    let engine = Engine::open(directory.path()).unwrap();
    configure(&engine, &url, "nonvector-model");
    let p = call(&engine, "create_project", json!({"name":"预算"}));
    formal(&engine, &p, "权益兑换要求实名核验。", true);
    let before = call(&engine, "get_state", json!({}));
    let answer = ask(&engine, &p, false, "怎样防止反复薅羊毛？");
    assert_eq!(answer["grounded"], false);
    assert_eq!(answer["queryTrace"]["modelCalls"], 1);
    assert_eq!(answer["queryTrace"]["supplementStatus"], "SEARCH_PLAN");
    // The literal probe is read-only; invalid planned queries never execute.
    assert_eq!(answer["queryTrace"]["rounds"].as_array().unwrap().len(), 2);
    let after = call(&engine, "get_state", json!({}));
    for key in ["memories", "proposals", "tasks"] {
        assert_eq!(before[key], after[key]);
    }
    worker.join().unwrap();
}

#[test]
fn changing_configuration_while_rewriting_cancels_both_entrypoints_before_more_calls() {
    for desktop in [false, true] {
        let (sent, received) = mpsc::channel();
        let (release, resume) = mpsc::channel();
        let (url, worker) = model(1, move |_, _| {
            sent.send(()).unwrap();
            resume.recv_timeout(Duration::from_secs(10)).unwrap();
            json!({"queries":["实名核验"]})
        });
        let directory = tempfile::tempdir().unwrap();
        let engine = Engine::open(directory.path()).unwrap();
        configure(&engine, &url, "nonvector-model");
        let p = call(&engine, "create_project", json!({"name":"并发修订"}));
        formal(&engine, &p, "权益兑换要求实名核验。", true);
        let copy = engine.clone();
        let project = p["id"].clone();
        let question = thread::spawn(move || {
            copy.execute(Request{command:if desktop {"ask_assistant"}else{"ask_project"}.into(),
            payload:json!({"projectId":project,"question":"怎样防止反复薅羊毛？","useModel":true})})
        });
        received.recv_timeout(Duration::from_secs(10)).unwrap();
        configure(&engine, &url, "new-configuration");
        release.send(()).unwrap();
        let error = question.join().unwrap().unwrap_err();
        assert!(matches!(
            error.code.as_str(),
            "QA_CONTEXT_STALE" | "ASSISTANT_CONTEXT_STALE"
        ));
        worker.join().unwrap();
    }
}

#[test]
fn owner_of_another_role_cannot_be_substituted_for_the_requested_owner() {
    for desktop in [false, true] {
        let (url, worker) = model(2, |i, input| {
            if i == 0 {
                response(input, "设备采购负责人是李思。")
            } else {
                json!({"supported":false,"answersQuestion":false,"completeAnswer":false,
                    "obligations":[{"target":"设备采购负责人","status":"missing","claimIndices":[]}],
                    "unknownDecisions":[],"missingAspects":["设备采购负责人"],"unsupportedClaims":["设备采购负责人是李思"],"reason":"记录只说明采购审批由李思负责，未说明设备采购负责人"})
            }
        });
        let directory = tempfile::tempdir().unwrap();
        let engine = Engine::open(directory.path()).unwrap();
        configure(&engine, &url, "nonvector-model");
        let p = call(&engine, "create_project", json!({"name":"角色区分"}));
        formal(&engine, &p, "预算上限30万元，采购审批由李思负责。", true);
        let answer = ask(&engine, &p, desktop, "设备采购负责人是谁？");
        assert_eq!(answer["grounded"], false);
        assert_eq!(answer["qualityReview"]["supported"], false);
        worker.join().unwrap();
    }
}

#[test]
fn named_structured_fields_are_answered_without_model_calls() {
    let directory = tempfile::tempdir().unwrap();
    let engine = Engine::open(directory.path()).unwrap();
    configure(&engine, "http://127.0.0.1:9", "nonvector-model");
    let p = call(&engine, "create_project", json!({"name":"任务查询"}));
    let task = call(
        &engine,
        "create_task",
        json!({"projectId":p["id"],"title":"蓝鲸验收","description":"",
        "category":"action","assignee":"陈舟","priority":"high","status":"todo","progress":0,
        "dueDate":"2026-10-25","plannedDate":null,"workDate":"2026-10-20","clientRequestId":uuid::Uuid::new_v4().to_string()}),
    );
    for (question, expected) in [
        ("蓝鲸验收由谁负责？", "陈舟"),
        ("蓝鲸验收截止日期？", "2026-10-25"),
    ] {
        let answer = ask(&engine, &p, true, question);
        assert_eq!(answer["queryMode"], "structured_field");
        assert_eq!(answer["queryTrace"]["modelCalls"], 0);
        assert!(answer["answer"].as_str().unwrap().contains(expected));
        assert_eq!(answer["citations"][0]["taskId"], task["id"]);
    }
}

fn check_partial_answer(question: &str, answers_question: bool) {
    for desktop in [false, true] {
        let (url, worker) = model(2, move |i, input| {
            if i == 0 {
                let mut answer = response(input, "压测尚未启动。");
                answer["status"] = json!("partial");
                answer["unknowns"] = json!(["发布是否实际推迟"]);
                answer
            } else {
                assert_eq!(input["claims"].as_array().unwrap().len(), 1);
                let obligations = if answers_question {
                    json!([{"target":"压测状态","status":"answered","claimIndices":[1]},
                        {"target":"发布是否实际推迟","status":"missing","claimIndices":[]}])
                } else {
                    json!([{"target":"发布推迟原因","status":"missing","claimIndices":[]}])
                };
                json!({"supported":true,"answersQuestion":answers_question,"completeAnswer":false,
                    "obligations":obligations,"unknownDecisions":[{"unknownIndex":1,"disposition":"retain","claimIndices":[]}],
                    "missingAspects":["发布是否实际推迟"],"unsupportedClaims":[],"reason":"保留已知压测状态并明确未知发布前提"})
            }
        });
        let directory = tempfile::tempdir().unwrap();
        let engine = Engine::open(directory.path()).unwrap();
        configure(&engine, &url, "nonvector-model");
        let project = call(&engine, "create_project", json!({"name":"发布"}));
        formal(
            &engine,
            &project,
            "发布压测环境未就绪，压测尚未启动。",
            true,
        );
        let answer = ask(&engine, &project, desktop, question);
        assert_eq!(answer["grounded"], answers_question);
        if answers_question {
            assert_eq!(answer["status"], "partial");
            assert_eq!(answer["claims"].as_array().unwrap().len(), 1);
            assert!(answer["answer"].as_str().unwrap().contains("尚待确认"));
            assert_eq!(answer["claimValidation"]["bindingsValid"], true);
        } else {
            assert_eq!(answer["status"], "unknown");
            assert!(answer["claims"].as_array().unwrap().is_empty());
            assert_eq!(answer["citations"], json!([]));
        }
        assert_eq!(answer["queryTrace"]["reportedTokens"], 506);
        assert_eq!(answer["queryTrace"]["usageComplete"], true);
        worker.join().unwrap();
    }
}

#[test]
fn known_test_status_cannot_answer_an_unrecorded_release_delay_cause() {
    check_partial_answer("发布为什么推迟？", false);
}

#[test]
fn partial_answer_keeps_known_claims_for_a_directly_answered_compound_subquestion() {
    check_partial_answer("发布压测状态如何，发布是否实际推迟？", true);
}

#[test]
fn a_cited_component_dataset_cannot_stand_in_for_the_main_task_dataset() {
    for desktop in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let engine = Engine::open(directory.path()).unwrap();
        let p = call(
            &engine,
            "create_project",
            json!({"name":"Forecasting study"}),
        );
        formal(
            &engine,
            &p,
            "The main forecasting model uses sensor data from 90,000 machine cycles.",
            true,
        );
        formal(
            &engine,
            &p,
            "An auxiliary classifier uses data from 1,200 annotated examples.",
            true,
        );
        let (url, worker) = model(2, |i, input| {
            if i == 1 {
                return json!({"supported":true,"answersQuestion":false,"completeAnswer":false,
                    "obligations":[{"target":"main forecasting model data","status":"missing","claimIndices":[]}],
                    "unknownDecisions":[],"unsupportedClaims":[],"missingAspects":["main task data"],
                    "reason":"The cited data belongs only to the auxiliary classifier."});
            }
            let refs = input["references"]
                .as_array()
                .or_else(|| input["context"]["memories"].as_array())
                .unwrap();
            let reference = refs
                .iter()
                .find(|r| r["content"].to_string().contains("auxiliary classifier"))
                .unwrap();
            let span = &reference["content"][0];
            json!({"grounded":true,"status":"answered","unknowns":[],"claims":[{
                "text":"The auxiliary classifier uses 1,200 annotated examples.",
                "supportSpans":[{"referenceIndex":reference["referenceIndex"],"spanIndex":span["spanIndex"]}]}]})
        });
        configure(&engine, &url, "nonvector-model");
        let answer = ask(
            &engine,
            &p,
            desktop,
            "What data does the main forecasting model use?",
        );
        assert_eq!(answer["grounded"], false);
        assert_eq!(answer["qualityReview"]["supported"], false);
        assert_eq!(
            answer["qualityReview"]["rawProviderReview"]["supported"],
            true
        );
        assert_eq!(answer["qualityReview"]["answersQuestion"], false);
        assert_eq!(answer["citations"], json!([]));
        assert_eq!(worker.join().unwrap().len(), 2);
    }
}

#[test]
fn a_complete_flag_cannot_erase_an_explicitly_missing_requested_relation() {
    for desktop in [false, true] {
        let (url, worker) = model(2, |i, input| {
            if i == 0 {
                let mut answer = response(input, "Two decoders process the inputs independently.");
                answer["status"] = json!("partial");
                answer["unknowns"] = json!(["Whether the decoders share weights is not recorded."]);
                answer
            } else {
                json!({"supported":true,"answersQuestion":true,"completeAnswer":true,
                    "obligations":[{"target":"decoder operation","status":"answered","claimIndices":[1]},
                        {"target":"whether weights are shared","status":"missing","claimIndices":[]}],
                    "unknownDecisions":[{"unknownIndex":1,"disposition":"unasked","claimIndices":[]}],
                    "unsupportedClaims":[],"missingAspects":[],"reason":"Contradictory fixture must fail closed."})
            }
        });
        let directory = tempfile::tempdir().unwrap();
        let engine = Engine::open(directory.path()).unwrap();
        configure(&engine, &url, "nonvector-model");
        let p = call(
            &engine,
            "create_project",
            json!({"name":"Decoder architecture"}),
        );
        formal(
            &engine,
            &p,
            "Two decoders process the inputs independently.",
            true,
        );
        let answer = ask(
            &engine,
            &p,
            desktop,
            "How do the decoders operate, and do they share weights?",
        );
        assert_eq!(answer["grounded"], false);
        assert_eq!(answer["citations"], json!([]));
        assert_eq!(worker.join().unwrap().len(), 2);
    }
}

#[test]
fn an_incomplete_review_keeps_requested_unknowns_when_its_obligation_is_too_broad() {
    for desktop in [false, true] {
        let (url, worker) = model(2, |i, input| {
            if i == 0 {
                let mut answer = response(input, "压测尚未启动。");
                answer["status"] = json!("partial");
                answer["unknowns"] = json!(["发布是否实际推迟"]);
                answer
            } else {
                json!({"supported":true,"answersQuestion":true,"completeAnswer":false,
                    "obligations":[{"target":"压测状态与发布是否推迟","status":"answered","claimIndices":[1]}],
                    "unknownDecisions":[{"unknownIndex":1,"disposition":"retain","claimIndices":[]}],
                    "unsupportedClaims":[],"missingAspects":["发布是否实际推迟"],
                    "reason":"压测状态有据，实际发布是否推迟仍未记录。"})
            }
        });
        let directory = tempfile::tempdir().unwrap();
        let engine = Engine::open(directory.path()).unwrap();
        configure(&engine, &url, "nonvector-model");
        let p = call(&engine, "create_project", json!({"name":"发布状态核对"}));
        formal(&engine, &p, "压测尚未启动。", true);
        let answer = ask(&engine, &p, desktop, "压测状态如何，发布是否实际推迟？");
        assert_eq!(answer["grounded"], true);
        assert_eq!(answer["status"], "partial");
        assert!(answer["unknowns"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item == "发布是否实际推迟"));
        assert_eq!(answer["claims"].as_array().unwrap().len(), 1);
        assert_eq!(answer["qualityReview"]["completeAnswer"], false);
        assert_eq!(worker.join().unwrap().len(), 2);
    }
}

#[test]
fn freeform_success_without_claim_bindings_is_rejected() {
    for desktop in [false, true] {
        let (url, worker) = model(1, |_, input| {
            let mut output = response(input, "当前容量为64。");
            output.as_object_mut().unwrap().remove("claims");
            output["answer"] = json!("当前容量为64。附加一项无依据事实。");
            output
        });
        let directory = tempfile::tempdir().unwrap();
        let engine = Engine::open(directory.path()).unwrap();
        configure(&engine, &url, "nonvector-model");
        let project = call(&engine, "create_project", json!({"name":"容量"}));
        formal(&engine, &project, "当前容量为64。", true);
        let error = engine
            .execute(Request {
                command: if desktop {
                    "ask_assistant"
                } else {
                    "ask_project"
                }
                .into(),
                payload: json!({"projectId":project["id"],"question":"当前容量？","useModel":true}),
            })
            .unwrap_err();
        assert!(matches!(
            error.code.as_str(),
            "QA_GROUNDING" | "ASSISTANT_GROUNDING"
        ));
        worker.join().unwrap();
    }
}

#[test]
fn a_review_cannot_invent_a_claim_index_to_clear_a_requested_unknown() {
    for desktop in [false, true] {
        let (url, worker) = model(2, |i, input| {
            if i == 0 {
                let mut answer = response(input, "The decoder reads each stream independently.");
                answer["status"] = json!("partial");
                answer["unknowns"] = json!(["Whether the weights are shared is not recorded."]);
                answer
            } else {
                assert_eq!(input["claims"][0]["claimIndex"], 1);
                assert_eq!(input["claims"][0]["claimId"], "c1");
                assert_eq!(
                    input["schema"]["properties"]["obligations"]["items"]["properties"]["claimIds"]
                        ["items"]["enum"],
                    json!(["c1"])
                );
                // Legacy saved/provider responses remain bounded too. The
                // advertised protocol now uses stable IDs, but an old numeric
                // response must not invent a second claim to clear a gap.
                json!({"supported":true,"answersQuestion":true,"completeAnswer":true,
                    "obligations":[{"target":"decoder operation and weight sharing","status":"answered","claimIndices":[1,2]}],
                    "unknownDecisions":[{"unknownIndex":1,"disposition":"answered","claimIndices":[2]}],
                    "unsupportedClaims":[],"missingAspects":[],"reason":"Invalid extra legacy claim index must fail closed."})
            }
        });
        let directory = tempfile::tempdir().unwrap();
        let engine = Engine::open(directory.path()).unwrap();
        configure(&engine, &url, "nonvector-model");
        let project = call(
            &engine,
            "create_project",
            json!({"name":"Decoder claim bounds"}),
        );
        formal(
            &engine,
            &project,
            "The decoder reads each stream independently.",
            true,
        );
        let answer = ask(
            &engine,
            &project,
            desktop,
            "How does the decoder operate, and are the weights shared?",
        );
        assert_eq!(answer["grounded"], false);
        assert_eq!(answer["status"], "unknown");
        assert_eq!(answer["citations"], json!([]));
        assert_eq!(answer["queryTrace"]["modelCalls"], 2);
        assert_eq!(worker.join().unwrap().len(), 2);
    }
}

#[test]
fn exact_substring_cannot_bypass_review_by_omitting_conditions() {
    for desktop in [false, true] {
        let (url, worker) = model(2, |i, input| {
            if i == 0 {
                response(input, "可以删除。")
            } else {
                json!({"supported":false,"answersQuestion":false,"completeAnswer":false,
                    "obligations":[{"target":"允许删除的条件","status":"missing","claimIndices":[]}],
                    "unknownDecisions":[],"missingAspects":["允许删除的条件"],"unsupportedClaims":["可以删除"],"reason":"遗漏七年后及法务批准的条件"})
            }
        });
        let directory = tempfile::tempdir().unwrap();
        let engine = Engine::open(directory.path()).unwrap();
        configure(&engine, &url, "nonvector-model");
        let project = call(&engine, "create_project", json!({"name":"条件"}));
        formal(
            &engine,
            &project,
            "归档内容保留七年后，经法务批准可以删除。",
            true,
        );
        let answer = ask(&engine, &project, desktop, "归档内容可以删除吗？");
        assert_eq!(answer["grounded"], false);
        assert_eq!(answer["qualityReview"]["supported"], false);
        assert_eq!(answer["queryTrace"]["modelCalls"], 2);
        worker.join().unwrap();
    }
}

fn check_confused_model_composition(body: &'static str, question: &str) {
    for desktop in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let engine = Engine::open(directory.path()).unwrap();
        let project = call(&engine, "create_project", json!({"name":"Target identity"}));
        formal(&engine, &project, body, true);
        let (url, worker) = model(2, move |i, input| {
            if i == 0 {
                let refs = input["references"]
                    .as_array()
                    .or_else(|| input["context"]["memories"].as_array())
                    .unwrap();
                let joint = refs
                    .iter()
                    .find(|r| r["content"].to_string().contains(body))
                    .unwrap();
                return json!({"grounded":true,"status":"answered","unknowns":[],"claims":[{
                    "text":body,
                    "supportSpans":[{"referenceIndex":joint["referenceIndex"],"spanIndex":1}]}]});
            }
            assert!(input["schema"]["properties"]
                .get("completeAnswer")
                .is_none());
            json!({"supported":true,
                "obligations":[{"target":"individual model","status":"answered","claimIndices":[1]}],
                "unknownDecisions":[],"unsupportedClaims":[],"missingAspects":[],
                "reason":"Adversarial review wrongly treats the joint model as the individual model."})
        });
        configure(&engine, &url, "nonvector-model");
        let answer = ask(&engine, &project, desktop, question);
        assert_eq!(answer["grounded"], false);
        assert_eq!(answer["status"], "unknown");
        assert_eq!(answer["citations"], json!([]));
        assert_eq!(answer["qualityReview"]["answersQuestion"], false);
        assert_eq!(
            answer["qualityReview"]["rawProviderReview"]["obligations"][0]["status"],
            "answered"
        );
        assert_eq!(answer["queryTrace"]["modelCalls"], 2);
        assert_eq!(worker.join().unwrap().len(), 2);
    }
}

#[test]
fn a_joint_model_cannot_answer_an_individual_model_question_even_when_review_agrees() {
    check_confused_model_composition(
        "The joint model consists of language-specific models and a shared latent variable.",
        "Which model is used for individual prediction?",
    );
}

#[test]
fn a_composition_of_multiple_models_cannot_be_relabelled_as_one_individual_model() {
    check_confused_model_composition(
        "The model consists of individual probabilistic models for each language, coupled by cross-language latent variables.",
        "What does an individual model consist of?",
    );
}

#[test]
fn a_known_individual_target_omits_joint_memories_and_preserves_typed_source_context() {
    const BASE: &str = "We use a factorized probabilistic model as our base monolingual model for individual prediction.";
    const JOINT: &str = "The joint model consists of two shared alignment variables.";
    for desktop in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let engine = Engine::open(directory.path()).unwrap();
        let project = call(
            &engine,
            "create_project",
            json!({"name":"Direct target pack"}),
        );
        formal(&engine, &project, JOINT, true);
        formal(&engine, &project, BASE, true);
        let (url, worker) = model(2, |i, input| {
            let refs = input["references"]
                .as_array()
                .or_else(|| input["context"]["memories"].as_array())
                .unwrap();
            let memories = refs
                .iter()
                .filter(|reference| reference["kind"] != "source_passage")
                .collect::<Vec<_>>();
            assert_eq!(memories.len(), 1);
            assert_eq!(memories[0]["content"][0]["text"], BASE);
            assert_eq!(
                assert_typed_source_passages(refs, &[BASE.to_owned(), JOINT.to_owned()]),
                2
            );
            assert_eq!(refs.len(), 3);
            if i == 0 {
                assert_eq!(refs[0]["content"][0]["text"], BASE);
                return response(input, BASE);
            }
            assert_eq!(input["reviewEvidenceScope"], "full-actual-generation-pack");
            json!({"supported":true,
                "obligations":[{"target":"individual model","status":"answered","claimIndices":[1]}],
                "unknownDecisions":[],"unsupportedClaims":[],"missingAspects":[],
                "reason":"The answer identifies the recorded base model."})
        });
        configure(&engine, &url, "nonvector-model");
        let answer = ask(
            &engine,
            &project,
            desktop,
            "What does an individual model consist of?",
        );
        assert_eq!(answer["grounded"], true);
        assert_eq!(answer["claims"][0]["text"], BASE);
        assert_eq!(answer["context"]["memories"].as_array().unwrap().len(), 2);
        assert_eq!(answer["queryTrace"]["modelCalls"], 2);
        assert_eq!(worker.join().unwrap().len(), 2);
    }
}

#[test]
fn an_unused_current_base_model_can_correct_an_explicit_wrong_target_with_four_calls() {
    const BASE: &str = "We use a factorized probabilistic model as our base monolingual model for individual prediction. This applies only to archived reports.";
    const JOINT: &str = "The joint model consists of language-specific models and a shared latent variable. The model has task-specific operating constraints.";
    for desktop in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let engine = Engine::open(directory.path()).unwrap();
        let project = call(
            &engine,
            "create_project",
            json!({"name":"Target correction"}),
        );
        formal(&engine, &project, JOINT, true);
        formal(&engine, &project, BASE, true);
        let (url, worker) = model(4, |i, input| {
            let refs = input["references"]
                .as_array()
                .or_else(|| input["context"]["memories"].as_array())
                .unwrap();
            if i >= 2 {
                assert_eq!(
                    refs.iter()
                        .filter(|reference| reference["kind"] != "source_passage")
                        .count(),
                    1
                );
                assert_eq!(assert_typed_source_passages(refs, &[BASE.to_owned()]), 1);
                assert_eq!(refs.len(), 2);
                assert!(refs
                    .iter()
                    .all(|reference| reference["content"][0]["text"] == BASE));
            } else {
                assert_eq!(
                    assert_typed_source_passages(refs, &[BASE.to_owned(), JOINT.to_owned()]),
                    2
                );
            }
            if i == 0 || i == 2 {
                if i == 2 {
                    assert!(refs[0]["content"].to_string().contains(BASE));
                    assert_eq!(refs[0]["referenceIndex"], 1);
                }
                let selected = refs
                    .iter()
                    .find(|r| {
                        r["content"].to_string().contains(if i == 0 {
                            "joint model consists"
                        } else {
                            BASE
                        })
                    })
                    .unwrap();
                return json!({"grounded":true,"status":"answered","unknowns":[],"claims":[{
                    "text":if i == 0 {"The joint model consists of language-specific models and a shared latent variable."} else {BASE},
                    "supportSpans":[{"referenceIndex":selected["referenceIndex"],"spanIndex":1}]}]});
            }
            assert_eq!(input["reviewEvidenceScope"], "full-actual-generation-pack");
            let unknowns = input["unknowns"].as_array().unwrap();
            if i == 3 {
                assert!(!unknowns.is_empty(), "The target gap must be explicitly reviewed, not silently dropped by correction.");
            }
            json!({"supported":true,
                "obligations":[{"target":"individual model composition","status":"answered","claimIndices":[1]}],
                "unknownDecisions":unknowns.iter().enumerate().map(|(index,_)|json!({"unknownIndex":index+1,"disposition":"answered","claimIndices":[1]})).collect::<Vec<_>>(),
                "unsupportedClaims":[],"missingAspects":[],"reason":"Check the actual cited model and retain its scope."})
        });
        configure(&engine, &url, "nonvector-model");
        let before = call(&engine, "get_state", json!({}));
        let answer = ask(
            &engine,
            &project,
            desktop,
            "What does an individual model consist of?",
        );
        assert_eq!(answer["grounded"], true);
        assert_eq!(answer["status"], "answered");
        assert_eq!(answer["claims"][0]["text"], BASE);
        assert_eq!(answer["citations"].as_array().unwrap().len(), 1);
        assert_eq!(
            answer["referenceSelection"]["reason"],
            "explicit-target-correction"
        );
        assert_eq!(answer["queryTrace"]["modelCalls"], 4);
        assert_eq!(answer["queryTrace"]["answerGenerationIndex"], 1);
        assert_eq!(answer["queryTrace"]["reviewRounds"][1]["retrievalRound"], 1);
        let after = call(&engine, "get_state", json!({}));
        for field in ["memories", "proposals", "tasks"] {
            assert_eq!(before[field], after[field]);
        }
        assert_eq!(worker.join().unwrap().len(), 4);
    }
}

#[test]
fn unasked_internal_dimensions_do_not_trigger_supplement_or_erase_retained_unknowns() {
    for desktop in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let engine = Engine::open(directory.path()).unwrap();
        let project = call(
            &engine,
            "create_project",
            json!({"name":"Bounded granularity"}),
        );
        formal(&engine, &project, "We use a factorized probabilistic model as our base monolingual model for individual prediction.", true);
        let (url, worker) = model(2, |i, input| {
            if i == 0 {
                let mut answer = response(
                    input,
                    "A factorized probabilistic model is used for individual prediction.",
                );
                answer["status"] = json!("partial");
                answer["unknowns"] = json!(["The model's internal dimensions are not recorded."]);
                return answer;
            }
            assert!(input["schema"]["properties"]
                .get("answersQuestion")
                .is_none());
            assert!(input["schema"]["properties"]
                .get("completeAnswer")
                .is_none());
            json!({"supported":true,
                "obligations":[{"target":"individual model","status":"partial","claimIndices":[1]}],
                "unknownDecisions":[{"unknownIndex":1,"disposition":"retain","claimIndices":[]}],
                "unsupportedClaims":[],"missingAspects":["The model's internal dimensions are not recorded."],
                "reason":"The model identity is supported; retain the uncertainty without querying unasked dimensions."})
        });
        configure(&engine, &url, "nonvector-model");
        let answer = ask(
            &engine,
            &project,
            desktop,
            "Which model is used for individual prediction?",
        );
        assert_eq!(answer["grounded"], true);
        assert_eq!(answer["status"], "partial");
        assert!(answer["unknowns"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v == "The model's internal dimensions are not recorded."));
        assert_eq!(answer["qualityReview"]["completeAnswer"], false);
        assert_eq!(
            answer["qualityReview"]["rawProviderReview"]["obligations"][0]["status"],
            "partial"
        );
        assert_eq!(answer["queryTrace"]["modelCalls"], 2);
        assert_eq!(answer["queryTrace"]["reportedTokens"], 506);
        assert_eq!(worker.join().unwrap().len(), 2);
    }
}

#[test]
fn new_review_derives_a_complete_answer_from_obligations_without_summary_flags() {
    for desktop in [false, true] {
        let (url, worker) = model(2, |i, input| {
            if i == 0 {
                assert!(input.get("targetPlan").is_none());
                return response(input, "当前日志保留45天。");
            }
            assert!(input["schema"]["properties"]
                .get("answersQuestion")
                .is_none());
            assert!(input["schema"]["properties"]
                .get("completeAnswer")
                .is_none());
            json!({"supported":true,
                "obligations":[{"target":"日志保留期限","status":"answered","claimIndices":[1]}],
                "unknownDecisions":[],"unsupportedClaims":[],"missingAspects":[],
                "reason":"当前正文明确给出所问期限。"})
        });
        let directory = tempfile::tempdir().unwrap();
        let engine = Engine::open(directory.path()).unwrap();
        configure(&engine, &url, "nonvector-model");
        let project = call(
            &engine,
            "create_project",
            json!({"name":"Derived review state"}),
        );
        formal(&engine, &project, "当前日志保留45天。", true);
        let answer = ask(&engine, &project, desktop, "当前日志保留多久？");
        assert_eq!(answer["grounded"], true);
        assert_eq!(answer["status"], "answered");
        assert_eq!(answer["qualityReview"]["answersQuestion"], true);
        assert_eq!(answer["qualityReview"]["completeAnswer"], true);
        assert!(answer["qualityReview"]["rawProviderReview"]
            .get("completeAnswer")
            .is_none());
        assert_eq!(answer["queryTrace"]["modelCalls"], 2);
        assert_eq!(worker.join().unwrap().len(), 2);
    }
}
