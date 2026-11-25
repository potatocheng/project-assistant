use super::{hash, json, memory, params, Value, DATE};
use crate::{db::Database, Engine, Request};
use std::{collections::HashSet, env, fs, time::Instant};

/// Each conversation is one project. Only timestamp, speaker, utterance and
/// public image caption enter its confirmed memories. Gold turn IDs stay here.
#[test]
#[ignore = "requires the pinned LoCoMo-10 dataset and an output path"]
fn measure_locomo_retrieval() {
    let bytes = fs::read(env::var("LOCOMO_DATA").unwrap()).unwrap();
    let digest = hash(&bytes);
    assert_eq!(
        digest,
        "79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4"
    );
    let conversations: Vec<Value> = serde_json::from_slice(&bytes).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(dir.path().to_path_buf()).unwrap();
    let tx = db.conn.unchecked_transaction().unwrap();
    let mut cases = Vec::new();
    let mut turns = 0;
    let mut invalid_gold = 0;
    let mut adversarial = 0;
    for sample in &conversations {
        let project = sample["sample_id"].as_str().unwrap();
        tx.execute(
            "INSERT INTO projects VALUES(?1,?1,'',?2)",
            params![project, DATE],
        )
        .unwrap();
        let dialog = &sample["conversation"];
        let mut ids = HashSet::new();
        for (key, session) in dialog.as_object().unwrap() {
            if !key.starts_with("session_") || !session.is_array() {
                continue;
            }
            let date = dialog[format!("{key}_date_time")].as_str().unwrap();
            for turn in session.as_array().unwrap() {
                let turn_id = turn["dia_id"].as_str().unwrap();
                assert!(ids.insert(turn_id));
                let mut body = format!(
                    "{date} | {}: {}",
                    turn["speaker"].as_str().unwrap(),
                    turn["text"].as_str().unwrap()
                );
                if let Some(caption) = turn["blip_caption"].as_str() {
                    body.push_str(&format!(" [{caption}]"));
                }
                memory(
                    &tx,
                    project,
                    &format!("{project}/{turn_id}"),
                    "fact",
                    date,
                    &body,
                    None,
                );
                turns += 1;
            }
        }
        let mut strata = std::collections::BTreeMap::<u64, Vec<(String, usize, &Value)>>::new();
        for (i, q) in sample["qa"].as_array().unwrap().iter().enumerate() {
            let category = q["category"].as_u64().unwrap();
            if category == 5 {
                adversarial += 1;
                continue;
            }
            if !q["evidence"].as_array().is_some_and(|gold| {
                !gold.is_empty()
                    && gold
                        .iter()
                        .all(|g| g.as_str().is_some_and(|id| ids.contains(id)))
            }) {
                invalid_gold += 1;
                continue;
            }
            let key = hash(format!("locomo-v1/{project}/{i}").as_bytes());
            strata.entry(category).or_default().push((key, i, q));
        }
        for bucket in strata.values_mut() {
            bucket.sort_by(|a, b| a.0.cmp(&b.0));
            for (_, i, q) in bucket.iter().take(5) {
                cases.push((project, *i, *q));
            }
        }
    }
    tx.commit().unwrap();
    drop(db);
    let engine = Engine::open(dir.path()).unwrap();
    let call = |name: &str, payload: Value| {
        engine
            .execute(Request {
                command: name.into(),
                payload,
            })
            .unwrap()
    };
    let embedding = env::var("LOCOMO_EMBED_URL").ok();
    let model = env::var("LOCOMO_EMBED_MODEL").unwrap_or_else(|_| "all-MiniLM-L6-v2".into());
    if let Some(url) = &embedding {
        call(
            "save_semantic_search_settings",
            json!({"enabled":true, "provider":"ollama","baseUrl":url,"model":model}),
        );
        let built = call("rebuild_semantic_index", json!({}));
        assert_eq!(built["indexed"], turns, "{built}");
    }
    let mut rows = Vec::new();
    for (project, index, q) in cases {
        let started = Instant::now();
        let result = call(
            "search_verified_memories",
            json!({"projectId":project, "date":"2026-10-20",
            "query":q["question"], "limit":5}),
        );
        let trace = &result["searchTrace"]["hybridRetrieval"];
        if embedding.is_some() {
            assert_eq!(trace["fusion"], "rrf", "{trace}");
        }
        let selected: Vec<_> = result["memories"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| {
                assert_eq!(m["projectId"], project);
                m["id"].as_str().unwrap().split_once('/').unwrap().1
            })
            .collect();
        rows.push(
            json!({"project":project,"index":index,"category":q["category"],
            "split":if matches!(project,"conv-26" | "conv-30") {"development"} else {"holdout"},
            "gold":q["evidence"],"selected":selected,"eligibleVecHits":trace["eligibleVecHits"],
            "elapsedMs":started.elapsed().as_secs_f64()*1000.0}),
        );
    }
    let report = json!({"datasetSha256":digest, "turns":turns,"excludedInvalidEvidence":invalid_gold,
        "excludedAdversarial":adversarial, "model":embedding.map(|_|model), "cases":rows});
    fs::write(
        env::var("LOCOMO_REPORT").unwrap(),
        serde_json::to_vec_pretty(&report).unwrap(),
    )
    .unwrap();
}
