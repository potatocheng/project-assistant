//! Reproducible capability measurement. Golden memories are preloaded: this is
//! retrieval/local-answer evaluation, not real-LLM extraction or generation QA.
use crate::{assistant_qa, db, hash, qa};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::{collections::BTreeMap, time::Instant};

const DATA: &str = include_str!("../tests/fixtures/memory-evaluation-v1.json");
const DATE: &str = "2026-10-20T00:00:00Z";

/// A file-only diagnostic bridge to the production reader and exact binding
/// validator. It neither retrieves/truncates evidence nor calls a provider.
#[test]
#[ignore = "requires MEMORY_READER_DIAGNOSTIC_INPUT and MEMORY_READER_DIAGNOSTIC_OUTPUT"]
fn evidence_reader_diagnostic_bridge() {
    let input_path = std::env::var("MEMORY_READER_DIAGNOSTIC_INPUT").unwrap();
    let output_path = std::env::var("MEMORY_READER_DIAGNOSTIC_OUTPUT").unwrap();
    assert_ne!(input_path, output_path, "never overwrite diagnostic input");
    let input: Value = serde_json::from_slice(&std::fs::read(input_path).unwrap()).unwrap();
    let mode = input["mode"].as_str().unwrap();
    assert!(matches!(mode, "build" | "normalize"));
    let rows = input["jobs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|job| match evidence_reader_diagnostic_job(mode, job) {
            Ok(value) => value,
            Err(error) => json!({"id":job["id"],"ok":false,"error":error}),
        })
        .collect::<Vec<_>>();
    let output = json!({"version":"evidence-reader-diagnostic-v1","mode":mode,
        "scope":"fixed-evidence reader; normalization validates binding only, not semantic truth or the full production flow",
        "providerCalls":0,"rows":rows});
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(output_path)
        .unwrap();
    file.write_all(serde_json::to_string_pretty(&output).unwrap().as_bytes())
        .unwrap();
    file.sync_all().unwrap();
}

fn evidence_reader_diagnostic_job(mode: &str, job: &Value) -> crate::Result<Value> {
    let bad = || {
        crate::AppError::new(
            "QA_READER_INPUT",
            "诊断输入需要原问题、唯一引用ID与完整正文",
        )
    };
    let question = job["question"]
        .as_str()
        .filter(|q| !q.trim().is_empty())
        .ok_or_else(bad)?;
    let references = job["references"].as_array().ok_or_else(bad)?;
    let mut ids = std::collections::HashSet::new();
    for reference in references {
        let id = reference["id"]
            .as_str()
            .filter(|id| !id.trim().is_empty())
            .ok_or_else(bad)?;
        if !ids.insert(id) || !reference["content"].is_string() {
            return Err(bad());
        }
    }
    if mode == "normalize" {
        let raw = if let Some(text) = job["rawOutput"].as_str() {
            serde_json::from_str(text)
                .map_err(|error| crate::AppError::new("QA_READER_JSON", error.to_string()))?
        } else {
            job["rawOutput"].clone()
        };
        let result = crate::answer_contract::normalize(raw, references, "id")?;
        return Ok(json!({"id":job["id"],"ok":true,"bindingValidationOnly":true,"result":result}));
    }
    if mode != "build" {
        return Err(bad());
    }
    let project = references
        .first()
        .map(|r| &r["projectId"])
        .filter(|project| references.iter().all(|r| &r["projectId"] == *project))
        .cloned()
        .unwrap_or(Value::Null);
    let mut context = json!({"question":question,"projectId":project});
    if let Some(presentation) = job["presentationContext"].as_object() {
        for field in ["date", "preferences", "contextIntent", "limitations"] {
            if let Some(value) = presentation.get(field) {
                context[field] = value.clone();
            }
        }
    }
    let reader = crate::answer_contract::evidence_reader(&context, references, None)?;
    // Budget::complete adds this same wire-format instruction to all production calls.
    let system = format!("{}只返回符合本次 schema 的 JSON 对象。", reader.system);
    Ok(
        json!({"id":job["id"],"ok":true,"request":{"system":system,"input":reader.input,"schema":reader.schema}}),
    )
}

#[test]
fn evidence_reader_diagnostic_jobs_preserve_full_text_and_reject_bad_bindings() {
    let text = "Complete original content. ".repeat(200);
    let references = (0..40)
        .map(|index| {
            json!({"id":format!("s{index}"),"projectId":"p",
        "kind":"source_passage","content":format!("{index}: {text}")})
        })
        .collect::<Vec<_>>();
    let job = json!({"id":"long","question":"What does the source say?","references":references});
    let built = evidence_reader_diagnostic_job("build", &job).unwrap();
    let supplied = built["request"]["input"]["references"].as_array().unwrap();
    assert_eq!(supplied.len(), 40);
    for (original, supplied) in references.iter().zip(supplied) {
        let restored = supplied["content"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["text"].as_str().unwrap())
            .collect::<String>();
        assert_eq!(restored, original["content"].as_str().unwrap());
    }
    let mut output = job.clone();
    output["rawOutput"] = json!({"grounded":true,"status":"answered","unknowns":[],"claims":[{
        "text":"A source fact.","supportSpans":[{"referenceIndex":41,"spanIndex":1}]}]});
    assert!(evidence_reader_diagnostic_job("normalize", &output).is_err());
    output["rawOutput"]["claims"][0]["supportSpans"][0]["referenceIndex"] = json!(1);
    let normalized = evidence_reader_diagnostic_job("normalize", &output).unwrap();
    assert_eq!(
        normalized["result"]["claims"][0]["citationIds"],
        json!(["s0"])
    );
    assert_eq!(normalized["bindingValidationOnly"], true);
}

/// Reclassify the frozen complete v4 responses using the actual v5 candidate
/// and organization checks. This is validation replay, not a new extraction or
/// a measurement of semantic precision, recall, or full-document completion.
#[test]
#[ignore = "requires frozen public live receipts and v4 diagnostic baseline"]
fn replay_public_live_extraction_v5() {
    let receipts_path = std::env::var("MEMORY_PUBLIC_REPLAY_RECEIPTS").unwrap();
    let baseline_path = std::env::var("MEMORY_PUBLIC_REPLAY_BASELINE").unwrap();
    let output_path = std::env::var("MEMORY_PUBLIC_REPLAY_OUTPUT").unwrap();
    assert_ne!(
        output_path, baseline_path,
        "never overwrite the frozen baseline"
    );
    let receipts_bytes = std::fs::read(&receipts_path).unwrap();
    let baseline_bytes = std::fs::read(&baseline_path).unwrap();
    let baseline: Value = serde_json::from_slice(&baseline_bytes).unwrap();
    let old_rows = baseline["candidates"].as_array().unwrap();
    let old = old_rows
        .iter()
        .map(|row| {
            (
                (
                    row["receiptId"].as_u64().unwrap(),
                    row["candidateIndex"].as_u64().unwrap(),
                ),
                row,
            )
        })
        .collect::<BTreeMap<_, _>>();
    let mut counts = BTreeMap::<String, usize>::new();
    let mut issue_fields = BTreeMap::<String, usize>::new();
    let mut transitions = BTreeMap::<String, usize>::new();
    let mut candidates = Vec::new();
    let mut complete_receipts = 0;
    let mut quantity_overflow_receipts = 0;
    let mut quantity_overflow_candidates = 0;
    for line in std::str::from_utf8(&receipts_bytes)
        .unwrap()
        .lines()
        .filter(|line| !line.is_empty())
    {
        let receipt: Value = serde_json::from_str(line).unwrap();
        if receipt["task"] != "extraction" || receipt["finishReason"] != "stop" {
            continue;
        }
        let request: Value = serde_json::from_str(
            receipt["request"]["messages"]
                .as_array()
                .unwrap()
                .last()
                .unwrap()["content"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        let response: Value =
            serde_json::from_str(receipt["responseText"].as_str().unwrap()).unwrap();
        let Ok(output) = serde_json::from_str::<Value>(
            response["choices"][0]["message"]["content"]
                .as_str()
                .unwrap(),
        ) else {
            continue;
        };
        let Some(items) = output["candidates"].as_array() else {
            continue;
        };
        let segments: Vec<crate::ai::SourceSegment> =
            serde_json::from_value(request["segments"].clone()).unwrap();
        complete_receipts += 1;
        let task_count = output["taskCandidates"].as_array().map_or(0, Vec::len);
        let quantity_overflow = items.len() > 12 || task_count > 4 || items.len() + task_count > 16;
        if quantity_overflow {
            quantity_overflow_receipts += 1;
            quantity_overflow_candidates += items.len();
        }
        for (index, item) in items.iter().enumerate() {
            let receipt_id = receipt["index"].as_u64().unwrap();
            let old_row = old
                .get(&(receipt_id, index as u64))
                .expect("every replayed candidate belongs to frozen baseline");
            assert_eq!(old_row["paperId"], receipt["paperId"]);
            let (category, facets, issues) =
                match crate::ai::checked_candidate(item.clone(), &segments) {
                    None => ("core_invalid", Value::Null, json!([])),
                    Some((candidate, _)) => {
                        let quotes = candidate
                            .evidence
                            .iter()
                            .map(|e| e.quote.as_str())
                            .collect::<Vec<_>>()
                            .join("\n");
                        let (facets, issues, needs_review) = crate::memory_facts::extraction_check(
                            &candidate.facets,
                            &candidate.content,
                            &quotes,
                        );
                        let category = if needs_review {
                            "scope_needs_review"
                        } else if issues.as_array().unwrap().is_empty() {
                            "all_fields_valid"
                        } else {
                            "topic_only_quarantined_ready"
                        };
                        (category, facets, issues)
                    }
                };
            *counts.entry(category.into()).or_default() += 1;
            for issue in issues.as_array().unwrap() {
                *issue_fields
                    .entry(issue["field"].as_str().unwrap().into())
                    .or_default() += 1;
            }
            let old_pass = old_row["passesProductionChecks"].as_bool().unwrap();
            *transitions
                .entry(format!(
                    "{}->{category}",
                    if old_pass {
                        "old_valid"
                    } else {
                        "old_rejected"
                    }
                ))
                .or_default() += 1;
            candidates.push(json!({"receiptId":receipt_id,"paperId":receipt["paperId"],"candidateIndex":index,"oldPassesProductionChecks":old_pass,"category":category,"safeFacets":facets,"issues":issues,"originalBatchExceedsV5QuantityLimit":quantity_overflow}));
        }
    }
    assert_eq!(candidates.len(), old_rows.len());
    assert_eq!(
        candidates.len(),
        2104,
        "this replay is bound to the frozen 2104-candidate run"
    );
    let old_valid = old_rows
        .iter()
        .filter(|row| row["passesProductionChecks"] == true)
        .count();
    assert_eq!(old_valid, 1);
    let ready = counts.get("all_fields_valid").copied().unwrap_or(0)
        + counts
            .get("topic_only_quarantined_ready")
            .copied()
            .unwrap_or(0);
    let sources = ["ai.rs", "memory_facts.rs", "extraction_store.rs"]
        .into_iter()
        .map(|name| {
            let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("src")
                .join(name);
            (name.to_owned(), hash(&std::fs::read(path).unwrap()))
        })
        .collect::<BTreeMap<_, _>>();
    let report = json!({"methodology":"Offline replay of all 2104 memory candidates in 102 complete v4 extraction receipts. Candidate classification calls current Rust ai::checked_candidate and memory_facts::extraction_check. No model calls, document imports, candidate confirmations, database mutations, or gold answers. Categories are disjoint and do not measure semantic correctness. Old 6000-character response batches are not rerun: v5 quantity overflow is reported separately, so per-candidate ready does not mean these old batches would be accepted by v5.","baseline":{"path":baseline_path,"sha256":hash(&baseline_bytes),"passedCandidates":old_valid},"receipts":{"path":receipts_path,"sha256":hash(&receipts_bytes),"completeReceipts":complete_receipts},"productionSourceSha256":sources,"summary":{"candidates":candidates.len(),"categories":counts,"readyCandidates":ready,"oldReadyCandidates":old_valid,"readyCandidateChange":ready as i64-old_valid as i64,"fieldIssueCountsOverlapping":issue_fields,"transitions":transitions,"originalBatchQuantityOverflowReceipts":quantity_overflow_receipts,"originalBatchQuantityOverflowCandidates":quantity_overflow_candidates},"candidates":candidates});
    std::fs::write(&output_path, serde_json::to_string_pretty(&report).unwrap()).unwrap();
    println!("PUBLIC_LIVE_V5_REPLAY {}", report["summary"]);
}

/// Replays only validation against captured real responses. No model calls,
/// database edits or relaxed production checks; reasons may overlap.
#[test]
#[ignore = "requires captured public live receipts"]
fn diagnose_public_live_extraction() {
    let file = std::env::var("MEMORY_PUBLIC_LIVE_RECEIPTS").unwrap();
    let lines = std::fs::read_to_string(file).unwrap();
    let mut output = Vec::new();
    for line in lines.lines().filter(|s| !s.is_empty()) {
        let receipt: Value = serde_json::from_str(line).unwrap();
        if receipt["task"] != "extraction" || receipt["finishReason"] != "stop" {
            continue;
        }
        let request: Value = serde_json::from_str(
            receipt["request"]["messages"]
                .as_array()
                .unwrap()
                .last()
                .unwrap()["content"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        let response: Value =
            serde_json::from_str(receipt["responseText"].as_str().unwrap()).unwrap();
        let Ok(value) = serde_json::from_str::<Value>(
            response["choices"][0]["message"]["content"]
                .as_str()
                .unwrap(),
        ) else {
            continue;
        };
        let segments: Vec<crate::ai::SourceSegment> =
            serde_json::from_value(request["segments"].clone()).unwrap();
        for (index, item) in value["candidates"]
            .as_array()
            .into_iter()
            .flatten()
            .enumerate()
        {
            let mut issues = Vec::new();
            match serde_json::from_value::<crate::ai::Candidate>(item.clone()) {
                Err(_) => issues.push("candidate_schema"),
                Ok(candidate) => {
                    if !["fact", "decision", "requirement", "risk"]
                        .contains(&candidate.kind.as_str())
                    {
                        issues.push("kind");
                    }
                    if candidate.content.trim().is_empty() || candidate.content.len() > 64 * 1024 {
                        issues.push("content");
                    }
                    if crate::memory_facts::checked(&json!(candidate.facets), &candidate.content)
                        .is_err()
                    {
                        issues.push("facets_not_in_content_or_invalid");
                    }
                    let quotes = candidate
                        .evidence
                        .iter()
                        .map(|e| e.quote.as_str())
                        .collect::<Vec<_>>()
                        .join("\n");
                    if crate::memory_facts::checked(&json!(candidate.facets), &quotes).is_err() {
                        issues.push("facets_not_in_quotes_or_invalid");
                    }
                    if candidate.evidence.is_empty()
                        || candidate.evidence.len() > 100
                        || !candidate.evidence.iter().all(|e| {
                            !e.quote.trim().is_empty()
                                && segments
                                    .iter()
                                    .any(|s| s.id == e.segment_id && s.text.contains(&e.quote))
                        })
                    {
                        issues.push("source_quote_mismatch");
                    }
                }
            }
            output.push(json!({"receiptId":receipt["index"],"paperId":receipt["paperId"],"candidateIndex":index,"issues":issues,"passesProductionChecks":issues.is_empty()}));
        }
    }
    std::fs::write(std::env::var("MEMORY_PUBLIC_LIVE_DIAGNOSTICS").unwrap(), serde_json::to_string_pretty(&json!({"methodology":"Offline replay of production schema, facet and source-substring checks on complete real responses. Flags overlap; passing candidates may be deduplicated or lost when a later batch fails.","candidates":output})).unwrap()).unwrap();
    println!("PUBLIC_LIVE_EXTRACTION candidates={}", output.len());
}

/// The ablation exists only inside this ignored evaluation: SQLite backup to
/// RAM, production retrieval, then remove facets in RAM and retrieve again.
#[test]
#[ignore = "requires completed public live workspaces"]
fn diagnose_public_live_retrieval() {
    let report: Value = serde_json::from_slice(
        &std::fs::read(std::env::var("MEMORY_PUBLIC_LIVE_REPORT").unwrap()).unwrap(),
    )
    .unwrap();
    let root = std::env::var("MEMORY_PUBLIC_LIVE_ROOT").unwrap();
    let mut cases = Vec::new();
    for paper in report["documents"].as_array().unwrap() {
        let workspace = std::path::Path::new(&root).join(paper["workspace"].as_str().unwrap());
        let source = Connection::open_with_flags(
            workspace.join("workspace.sqlite"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        let mut conn = Connection::open_in_memory().unwrap();
        rusqlite::backup::Backup::new(&source, &mut conn)
            .unwrap()
            .run_to_completion(100, std::time::Duration::from_millis(1), None)
            .unwrap();
        for question in paper["questions"].as_array().unwrap() {
            for entry in ["desktop", "connector"] {
                let result = &question["entries"][entry];
                let queries = result["rewrites"]
                    .as_array()
                    .and_then(|a| a.last())
                    .and_then(|v| v["queries"].as_array())
                    .cloned()
                    .unwrap_or_default();
                let payload = json!({"projectId":paper["projectId"],"question":question["question"],"date":"2026-10-20","asOfDate":"2026-10-20","searchQueries":queries});
                let mut variants = serde_json::Map::new();
                conn.execute_batch("SAVEPOINT facet_ablation;").unwrap();
                for ablate in [false, true] {
                    if ablate {
                        conn.execute("DELETE FROM revision_facets", []).unwrap();
                    }
                    let context = if entry == "desktop" {
                        assistant_qa::retrieve(&conn, &payload).unwrap()
                    } else {
                        qa::retrieve(&conn, &payload).unwrap()
                    };
                    let selected = if entry == "desktop" {
                        assistant_qa::model_candidates(
                            &context,
                            &assistant_qa::local_answer(&context),
                        )
                    } else {
                        context["memories"].as_array().unwrap().clone()
                    };
                    variants.insert(if ablate { "withoutFacets" } else { "normal" }.into(), json!({"selected":selected,"searchTrace":context["searchTrace"],"memorySearchTrace":context["memorySearchTrace"]}));
                }
                conn.execute_batch("ROLLBACK TO facet_ablation; RELEASE facet_ablation;")
                    .unwrap();
                cases.push(json!({"id":question["id"],"paperId":paper["id"],"entry":entry,"variants":variants}));
            }
        }
    }
    std::fs::write(std::env::var("MEMORY_PUBLIC_LIVE_ABLATION").unwrap(), serde_json::to_string_pretty(&json!({"methodology":"Production retrieval on read-only workspace backup in RAM; original facets vs facets removed only in RAM. Last actual rewrite reused. No gold enters retrieval; no source database changes.","cases":cases})).unwrap()).unwrap();
    println!("PUBLIC_LIVE_RETRIEVAL cases={}", cases.len());
}

#[test]
#[ignore = "requires captured public live receipts"]
fn diagnose_public_live_answer_binding() {
    let lines =
        std::fs::read_to_string(std::env::var("MEMORY_PUBLIC_LIVE_RECEIPTS").unwrap()).unwrap();
    let mut cases = Vec::new();
    for line in lines.lines().filter(|s| !s.is_empty()) {
        let receipt: Value = serde_json::from_str(line).unwrap();
        if receipt["task"] != "generation" || receipt["finishReason"] != "stop" {
            continue;
        }
        let request: Value = serde_json::from_str(
            receipt["request"]["messages"]
                .as_array()
                .unwrap()
                .last()
                .unwrap()["content"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        let response: Value =
            serde_json::from_str(receipt["responseText"].as_str().unwrap()).unwrap();
        let Ok(value) = serde_json::from_str::<Value>(
            response["choices"][0]["message"]["content"]
                .as_str()
                .unwrap(),
        ) else {
            continue;
        };
        let desktop = receipt["entry"] == "desktop";
        let field = if desktop { "id" } else { "memoryId" };
        let references = request
            .get("references")
            .unwrap_or(&request["context"]["memories"]);
        let references = references.as_array().cloned().unwrap_or_default();
        let normalized = crate::answer_contract::normalize(value.clone(), &references, field);
        let mut anchors = Vec::new();
        for claim in value["claims"].as_array().into_iter().flatten() {
            for anchor in claim["supportQuotes"].as_array().into_iter().flatten() {
                let reference = references.iter().find(|r| r[field] == anchor["citationId"]);
                let quote = anchor["quote"].as_str().unwrap_or("");
                anchors.push(json!({"citationId":anchor["citationId"],"quote":quote,"quoteChars":quote.chars().count(),"knownCitation":reference.is_some(),"inCurrentContent":reference.is_some_and(|r| r["content"].as_str().unwrap_or("").contains(quote)),"claimedCitation":claim["citationIds"].as_array().is_some_and(|ids|ids.contains(&anchor["citationId"]))}));
            }
        }
        cases.push(json!({"receiptId":receipt["index"],"paperId":receipt["paperId"],"questionId":receipt["questionId"],"entry":receipt["entry"],"rawGrounded":value["grounded"],"rawStatus":value["status"],"contractValid":normalized.is_ok(),"normalizationError":normalized.err().map(|e|e.code),"anchors":anchors}));
    }
    std::fs::write(std::env::var("MEMORY_PUBLIC_LIVE_BINDING").unwrap(), serde_json::to_string_pretty(&json!({"methodology":"Actual production answer_contract::normalize replayed on captured requests and outputs. Binding validity is not semantic truth. Anchor checks expose exact-text/length/ID failures; a different contract rule can also fail.","cases":cases})).unwrap()).unwrap();
    println!("PUBLIC_LIVE_ANSWER_BINDING cases={}", cases.len());
}

/// External gold never enters the retrieval request. All paper paragraphs are
/// preloaded, so this measures evidence retrieval, not extraction or answers.
#[test]
#[ignore = "requires pinned public data; run npm run evaluate:memory:public"]
fn measure_public_external_evidence() {
    let file = std::env::var("MEMORY_PUBLIC_DATASET").expect("MEMORY_PUBLIC_DATASET required");
    let bytes = std::fs::read(file).unwrap();
    let dataset: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(dataset["version"], "qasper-memory-retrieval-v1");
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;")
        .unwrap();
    db::migrate(&conn).unwrap();
    for paper in dataset["documents"].as_array().unwrap() {
        let project = paper["id"].as_str().unwrap();
        conn.execute(
            "INSERT INTO projects VALUES(?1,?2,'公开论文全文',?3)",
            params![project, paper["title"].as_str(), DATE],
        )
        .unwrap();
        let tx = conn.unchecked_transaction().unwrap();
        for paragraph in paper["paragraphs"].as_array().unwrap() {
            memory(
                &conn,
                project,
                paragraph["id"].as_str().unwrap(),
                "fact",
                paper["title"].as_str().unwrap(),
                paragraph["content"].as_str().unwrap(),
                None,
            );
        }
        tx.commit().unwrap();
    }
    let mut cases = Vec::new();
    for paper in dataset["documents"].as_array().unwrap() {
        for question in paper["queries"].as_array().unwrap() {
            let payload = json!({"projectId":paper["id"],"question":question["question"],"date":"2026-10-20"});
            for desktop in [false, true] {
                let started = Instant::now();
                let context = if desktop {
                    assistant_qa::retrieve(&conn, &payload).unwrap()
                } else {
                    qa::retrieve(&conn, &payload).unwrap()
                };
                let records = if desktop {
                    assistant_qa::model_candidates(&context, &assistant_qa::local_answer(&context))
                } else {
                    context["memories"].as_array().unwrap().clone()
                };
                assert!(records.iter().all(|r| r["projectId"] == paper["id"]));
                let selected = records
                    .iter()
                    .filter_map(|r| {
                        r["memoryId"]
                            .as_str()
                            .or_else(|| r["record"]["memoryId"].as_str())
                    })
                    .map(str::to_owned)
                    .collect::<Vec<_>>();
                let sets = question["acceptableEvidenceSets"].as_array().unwrap();
                let mut complete = serde_json::Map::new();
                for k in [1, 3, 6, 12] {
                    let all = sets.iter().any(|set| {
                        set.as_array().unwrap().iter().all(|alternatives| {
                            alternatives
                                .as_array()
                                .unwrap()
                                .iter()
                                .any(|id| selected.iter().take(k).any(|s| id == s))
                        })
                    });
                    complete.insert(
                        format!("allEvidenceAt{k}"),
                        if question["answerable"] == true {
                            json!(all)
                        } else {
                            Value::Null
                        },
                    );
                }
                cases.push(json!({"id":question["id"],"paperId":paper["id"],"split":paper["split"],"track":if desktop {"desktop_model_candidates"} else {"connector_memory"},"answerable":question["answerable"],"selected":selected,"retrievedCount":records.len(),"evidenceCoverage":complete,"elapsedMs":started.elapsed().as_secs_f64()*1000.0}));
            }
        }
    }
    let mut summaries = serde_json::Map::new();
    for split in ["development", "holdout"] {
        for track in ["desktop_model_candidates", "connector_memory"] {
            let rows = cases
                .iter()
                .filter(|c| c["split"] == split && c["track"] == track)
                .collect::<Vec<_>>();
            let positive = rows
                .iter()
                .filter(|c| c["answerable"] == true)
                .collect::<Vec<_>>();
            let mut summary = json!({"questions":rows.len(),"answerable":positive.len(),"unanswerable":rows.len()-positive.len(),"scopeViolations":0});
            for k in [1, 3, 6, 12] {
                let count = positive
                    .iter()
                    .filter(|c| c["evidenceCoverage"][format!("allEvidenceAt{k}")] == true)
                    .count();
                summary[format!("allEvidenceAt{k}")] = if positive.is_empty() {
                    Value::Null
                } else {
                    json!(count as f64 / positive.len() as f64)
                };
            }
            let mut timings = rows
                .iter()
                .map(|c| c["elapsedMs"].as_f64().unwrap())
                .collect::<Vec<_>>();
            timings.sort_by(f64::total_cmp);
            summary["p50Ms"] = timings
                .get(timings.len().saturating_sub(1) / 2)
                .map_or(Value::Null, |n| json!(n));
            summary["p95Ms"] = timings
                .get((timings.len() * 95).div_ceil(100).saturating_sub(1))
                .map_or(Value::Null, |n| json!(n));
            summaries.insert(format!("{split}:{track}"), summary);
        }
    }
    let report = json!({"version":dataset["version"],"datasetSha256":hash(&bytes),"recordedAt":crate::now(),"provenance":dataset["provenance"],"methodology":"External human-labelled QASPER; full text paragraphs preloaded as confirmed records in an isolated in-memory database. Gold annotations never sent to retrieval. Not LLM extraction, generation, business accuracy or official QASPER answer F1. K counts memory paragraphs; latency is debug retrieval only, includes initial index construction, excludes network.","summary":summaries,"cases":cases});
    std::fs::write(
        std::env::var("MEMORY_PUBLIC_REPORT").expect("MEMORY_PUBLIC_REPORT required"),
        serde_json::to_string_pretty(&report).unwrap(),
    )
    .unwrap();
    println!("PUBLIC_MEMORY_RETRIEVAL {}", report["summary"]);
}

fn memory(
    conn: &Connection,
    project: &str,
    id: &str,
    kind: &str,
    title: &str,
    body: &str,
    previous: Option<&str>,
) {
    let revision = if previous.is_some() { 2 } else { 1 };
    conn.execute(
        "INSERT INTO memories VALUES(?1,?2,?3,?4,?5,'active',?6,?7,?7)",
        params![id, project, kind, body, revision, title, DATE],
    )
    .unwrap();
    if let Some(old) = previous {
        conn.execute(
            "INSERT INTO revisions VALUES(?1,?2,1,?3,'原始确认','confirmation',?4)",
            params![format!("{id}:1"), id, old, DATE],
        )
        .unwrap();
    }
    let rid = format!("{id}:{revision}");
    conn.execute(
        "INSERT INTO revisions VALUES(?1,?2,?3,?4,'合成评估资料',?5,?6)",
        params![
            rid,
            id,
            revision,
            body,
            if previous.is_some() {
                "user_correction"
            } else {
                "confirmation"
            },
            DATE
        ],
    )
    .unwrap();
    let source = format!("source:{id}");
    let segment = format!("segment:{id}");
    conn.execute("INSERT INTO sources(id,project_id,title,kind,original_filename,source_at,imported_at,sha256,status,segment_count,error,original_path) VALUES(?1,?2,?3,'text','fixture.txt',NULL,?4,?5,'ready',1,NULL,'originals/fixture.txt')",params![source,project,title,DATE,hash(format!("{id}:{body}").as_bytes())]).unwrap();
    conn.execute(
        "INSERT INTO segments VALUES(?1,?2,?3,0,'合成资料第1段',?4)",
        params![segment, source, format!("{source}:v1"), body],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO revision_evidence VALUES(?,?)",
        params![rid, segment],
    )
    .unwrap();
}

fn corpus(dataset: &Value, noise: usize) -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
    db::migrate(&conn).unwrap();
    for id in ["alpha", "other"] {
        conn.execute(
            "INSERT INTO projects VALUES(?1,?1,'合成评估项目',?2)",
            params![id, DATE],
        )
        .unwrap();
    }
    for item in dataset["memories"].as_array().unwrap() {
        let id = item["id"].as_str().unwrap();
        let body = format!(
            "{}{}",
            "会议背景与例行事项说明。".repeat(item["prefixRepeat"].as_u64().unwrap_or(0) as usize),
            item["content"].as_str().unwrap()
        );
        memory(
            &conn,
            "alpha",
            id,
            item["kind"].as_str().unwrap(),
            item["title"].as_str().unwrap_or("项目确认纪要"),
            &body,
            item["previous"].as_str(),
        );
        if item["conflict"] == true {
            conn.execute("INSERT INTO proposals(id,project_id,source_id,kind,content,status,created_at,memory_id) VALUES('conflict-proposal','alpha',?,'decision','迁移时间待重新核定','pending',?,NULL)",params![format!("source:{id}"),DATE]).unwrap();
            conn.execute("INSERT INTO memory_reviews VALUES('conflict-review','conflict-proposal','conflict',?,1,'旧内容','等待用户核定','pending',?,?)",params![id,DATE,DATE]).unwrap();
        }
    }
    conn.execute("INSERT INTO proposals(id,project_id,source_id,kind,content,status,created_at,memory_id) VALUES('pending','alpha','source:owner','fact','星舰负责人为林楚','pending',?,NULL)",[DATE]).unwrap();
    memory(
        &conn,
        "other",
        "foreign",
        "fact",
        "隔离项目",
        "支付接口验收由OTHER_PROJECT_SECRET负责；登录审计留存7天。",
        None,
    );
    let tx = conn.unchecked_transaction().unwrap();
    for index in 0..noise {
        let id = format!("noise{index:04}");
        let body = format!("例行同步记录{index}：资料已整理，沟通安排另行确认。");
        tx.execute(
            "INSERT INTO memories VALUES(?1,'alpha','fact',?2,1,'active','日常记录',?3,?3)",
            params![id, body, DATE],
        )
        .unwrap();
        tx.execute(
            "INSERT INTO revisions VALUES(?1,?2,1,?3,'合成干扰','confirmation',?4)",
            params![format!("{id}:1"), id, body, DATE],
        )
        .unwrap();
    }
    tx.commit().unwrap();
    conn
}

fn metrics(cases: &[Value]) -> Value {
    let positives = cases
        .iter()
        .filter(|c| !c["gold"].as_array().unwrap().is_empty())
        .collect::<Vec<_>>();
    let negatives = cases
        .iter()
        .filter(|c| c["gold"].as_array().unwrap().is_empty())
        .collect::<Vec<_>>();
    let mean = |values: Vec<f64>| {
        if values.is_empty() {
            Value::Null
        } else {
            json!(values.iter().sum::<f64>() / values.len() as f64)
        }
    };
    let mut output =
        json!({"cases":cases.len(),"answerable":positives.len(),"unanswerable":negatives.len()});
    for k in [1, 3, 6, 40] {
        output[format!("recallAt{k}")] = mean(
            positives
                .iter()
                .map(|c| {
                    let gold = c["gold"].as_array().unwrap();
                    let got = c["selected"].as_array().unwrap();
                    gold.iter()
                        .filter(|id| got.iter().take(k).any(|v| v == *id))
                        .count() as f64
                        / gold.len() as f64
                })
                .collect(),
        );
    }
    output["mrrAt6"] = mean(
        positives
            .iter()
            .map(|c| {
                c["selected"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .take(6)
                    .position(|id| c["gold"].as_array().unwrap().contains(id))
                    .map(|index| 1.0 / (index + 1) as f64)
                    .unwrap_or(0.0)
            })
            .collect(),
    );
    output["allEvidenceAt6"] = mean(
        positives
            .iter()
            .map(|c| {
                f64::from(c["gold"].as_array().unwrap().iter().all(|id| {
                    c["selected"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .take(6)
                        .any(|v| v == id)
                }))
            })
            .collect(),
    );
    output["allEvidenceAt40"] = mean(
        positives
            .iter()
            .map(|c| {
                f64::from(c["gold"].as_array().unwrap().iter().all(|id| {
                    c["selected"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .take(40)
                        .any(|v| v == id)
                }))
            })
            .collect(),
    );
    output["negativeEmptyRate"] = mean(
        negatives
            .iter()
            .map(|c| f64::from(c["selected"].as_array().unwrap().is_empty()))
            .collect(),
    );
    output["scopeViolations"] = json!(cases.iter().filter(|c| c["scopeViolation"] == true).count());
    output["staleOrConflictViolations"] = json!(cases
        .iter()
        .filter(|c| c["staleOrConflictViolation"] == true)
        .count());
    let mut times = cases
        .iter()
        .map(|c| c["elapsedMs"].as_f64().unwrap())
        .collect::<Vec<_>>();
    times.sort_by(f64::total_cmp);
    if !times.is_empty() {
        output["latencyMs"] = json!({"p50":times[(times.len()-1)/2],"p95":times[((times.len() as f64*0.95).ceil() as usize).saturating_sub(1)]});
    }
    output
}

#[test]
fn navigation_catalog_is_bounded_and_excludes_other_projects_pending_and_conflicted_memory() {
    let dataset: Value = serde_json::from_str(DATA).unwrap();
    let conn = corpus(&dataset, 120);
    let payload = json!({"projectId":"alpha","question":"未知主题"});
    let context = qa::retrieve(&conn, &payload).unwrap();
    let catalog = context["searchCatalog"].as_array().unwrap();
    assert!(catalog.len() <= 48);
    assert!(context["searchCatalog"].to_string().chars().count() <= 8050);
    assert!(!catalog.iter().any(|r| matches!(
        r["memoryId"].as_str(),
        Some("foreign" | "conflicted" | "pending")
    )));
    assert!(!context["searchCatalog"]
        .to_string()
        .contains("OTHER_PROJECT_SECRET"));
    // Numbered repetitive notes collapse into a single navigation heading.
    assert_eq!(
        catalog
            .iter()
            .filter(|r| r["label"].as_str().unwrap().contains("例行同步记录"))
            .count(),
        1
    );
    let desktop = assistant_qa::retrieve(&conn, &payload).unwrap();
    assert_eq!(desktop["searchCatalog"], context["searchCatalog"]);
}

#[test]
fn measure_current_memory_capability() {
    let dataset: Value = serde_json::from_str(DATA).unwrap();
    let conn = corpus(&dataset, 120);
    let mut tracks = BTreeMap::new();
    for track in [
        "connector_memory",
        "desktop_local_answer",
        "desktop_model_context",
    ] {
        let mut cases = Vec::new();
        for query in dataset["queries"].as_array().unwrap() {
            let payload =
                json!({"projectId":"alpha","date":"2026-10-20","question":query["question"]});
            let start = Instant::now();
            let (selected, records, output) = if track == "connector_memory" {
                let result = qa::retrieve(&conn, &payload).unwrap();
                qa::validate(&conn, &result).unwrap();
                let records = result["memories"].as_array().unwrap().clone();
                (
                    records
                        .iter()
                        .map(|v| v["memoryId"].clone())
                        .collect::<Vec<_>>(),
                    records,
                    result,
                )
            } else {
                let context = assistant_qa::retrieve(&conn, &payload).unwrap();
                assistant_qa::validate(&conn, &context).unwrap();
                let result = assistant_qa::local_answer(&context);
                let records = if track == "desktop_model_context" {
                    assistant_qa::model_candidates(&context, &result)
                } else {
                    result["citations"].as_array().unwrap().clone()
                };
                (
                    records
                        .iter()
                        .map(|v| {
                            v["memoryId"]
                                .as_str()
                                .map(|s| json!(s))
                                .unwrap_or_else(|| v["id"].clone())
                        })
                        .collect::<Vec<_>>(),
                    records,
                    result,
                )
            };
            let elapsed = start.elapsed().as_secs_f64() * 1000.0;
            let encoded = json!(records).to_string();
            let stale = selected.contains(&json!("conflicted"))
                || encoded.contains("由张磊负责")
                || encoded.contains("2026-10-20。");
            let scope = selected.contains(&json!("foreign"))
                || output.to_string().contains("OTHER_PROJECT_SECRET");
            let mut item = query.clone();
            item["selected"] = json!(selected);
            item["elapsedMs"] = json!(elapsed);
            item["selectedRecordChars"] = json!(encoded.chars().count());
            item["localAnswer"] = output["answer"].clone();
            item["scopeViolation"] = json!(scope);
            item["staleOrConflictViolation"] = json!(stale);
            item["excerptContainsRequired"] = query["mustInclude"]
                .as_str()
                .map(|term| json!(encoded.contains(term)))
                .unwrap_or(Value::Null);
            item["preview"] = json!(records
                .iter()
                .take(6)
                .map(|r| r["content"]
                    .as_str()
                    .unwrap_or("")
                    .chars()
                    .take(160)
                    .collect::<String>())
                .collect::<Vec<_>>());
            cases.push(item);
        }
        let categories = cases
            .iter()
            .map(|c| c["category"].as_str().unwrap().to_owned())
            .collect::<std::collections::BTreeSet<_>>();
        let by_category = categories
            .into_iter()
            .map(|category| {
                let subset = cases
                    .iter()
                    .filter(|c| c["category"] == category)
                    .cloned()
                    .collect::<Vec<_>>();
                (category, metrics(&subset))
            })
            .collect::<BTreeMap<_, _>>();
        tracks.insert(
            track,
            json!({"summary":metrics(&cases),"categories":by_category,"cases":cases}),
        );
    }
    let mut scale = Vec::new();
    for noise in [0, 100, 1000] {
        let conn = corpus(&dataset, noise);
        let q = json!({"projectId":"alpha","question":"支付接口验收由谁负责？"});
        let mut times = Vec::new();
        let mut found = 0;
        for _ in 0..10 {
            let start = Instant::now();
            let result = qa::retrieve(&conn, &q).unwrap();
            times.push(start.elapsed().as_secs_f64() * 1000.0);
            found += usize::from(result["memories"][0]["memoryId"] == "owner");
        }
        times.sort_by(f64::total_cmp);
        scale.push(json!({"memories":dataset["memories"].as_array().unwrap().len()+noise,"queries":10,"top1Correct":found,"p50Ms":times[4],"p95Ms":times[9]}));
    }
    let report = json!({"datasetVersion":dataset["version"],"datasetSha256":hash(DATA.as_bytes()),"recordedAt":crate::now(),"kind":"synthetic_retrieval_and_local_rules_no_real_llm","corpus":{"goldMemories":19,"noiseMemories":120,"foreignMemories":1,"pendingCandidates":2},"latencyScope":"in-process in-memory SQLite debug build; query retrieval plus snapshot validation for main tracks; retrieval only for scale; excludes HTTP/model/network and cold start","tracks":tracks,"scale":scale});
    if let Ok(path) = std::env::var("MEMORY_EVAL_REPORT") {
        std::fs::write(path, serde_json::to_string_pretty(&report).unwrap()).unwrap();
    }
    println!("MEMORY_EVALUATION_SUMMARY {}",serde_json::to_string(&json!({"datasetVersion":report["datasetVersion"],"tracks":report["tracks"].as_object().unwrap().iter().map(|(key,v)|(key,v["summary"].clone())).collect::<BTreeMap<_,_>>(),"scale":report["scale"]})).unwrap());
    for track in report["tracks"].as_object().unwrap().values() {
        assert_eq!(
            track["summary"]["scopeViolations"], 0,
            "cross-project data leaked"
        );
        assert_eq!(
            track["summary"]["staleOrConflictViolations"], 0,
            "stale/conflicted memory leaked"
        );
        assert!(
            track["cases"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|c| c["mustInclude"].is_string())
                .all(|c| c["excerptContainsRequired"] == true),
            "long-memory excerpt lost required evidence"
        );
    }
    // Recall/abstention are measurements, not assertions that the current system
    // meets a product target. The JSON reports every failed capability case.
}
