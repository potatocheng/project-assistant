//! Read-only, project-scoped questions over confirmed current memory. Retrieval
//! never uses proposals or revision history, and model output cannot name a
//! citation outside the retrieved snapshot.

use crate::{
    hash, memory_query, required, search::Query, settings::SavedSettings, AppError, Result,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashSet;

const RETRIEVAL_VERSION: &str = "memory-and-source-evidence-v12-anchor-reading";
const MAX_QUESTION_CHARS: usize = 2_000;
const MAX_MEMORIES: usize = 24;
const MAX_REFERENCES: usize = 32;
const MAX_CANDIDATES: usize = 64;
const MAX_CONTENT_CHARS: usize = 4_000;
const MAX_CONTEXT_CHARS: usize = 36_000;
const MAX_EVIDENCE_CHARS: usize = 800;
const NO_ANSWER: &str = "项目记忆中没有足够依据，暂不自动回复。";

fn stale() -> AppError {
    AppError::new(
        "QA_CONTEXT_STALE",
        "项目记忆已有变化，本次回答已取消，请重新提问",
    )
}

fn clip(text: &str, maximum: usize) -> String {
    text.chars().take(maximum).collect()
}

fn evidence(conn: &Connection, revision: &str, project: &str, query: &Query) -> Result<Vec<Value>> {
    memory_query::evidence(conn, revision, project, query, MAX_EVIDENCE_CHARS)
}

pub(crate) fn selected_memory_pack(
    question: &str,
    candidates: &[Value],
) -> crate::evidence_pack::Pack {
    crate::evidence_pack::select(
        question,
        candidates,
        MAX_MEMORIES,
        MAX_CONTEXT_CHARS.saturating_sub(question.chars().count() + 512),
    )
}

/// Current assertions keep their places. Independently typed original passages
/// add context within the same model budget, without becoming stored memories.
pub(crate) fn with_source_passages(mut references: Vec<Value>, context: &Value) -> Vec<Value> {
    for passage in context["sourcePassages"].as_array().into_iter().flatten() {
        if references.len() >= MAX_REFERENCES {
            break;
        }
        let mut candidate = references.clone();
        candidate.push(passage.clone());
        if json!(crate::answer_contract::indexed_references(&candidate))
            .to_string()
            .chars()
            .count()
            <= MAX_CONTEXT_CHARS - 3_000
        {
            references = candidate;
        }
    }
    references
}

/// Small question-only language navigation. These terms are neither evidence
/// nor a statement about a particular architecture. Explicit retrieval plans
/// (including an empty plan) always take precedence.
pub(crate) fn navigation_payload(payload: &Value) -> Value {
    let mut request = payload.clone();
    if payload.get("searchQueries").is_some() {
        return request;
    }
    let question = payload["question"].as_str().unwrap_or("").to_lowercase();
    let words = question
        .split(|c: char| !c.is_alphanumeric())
        .collect::<HashSet<_>>();
    let mechanism = words.contains("how")
        || words.contains("mechanism")
        || ["如何", "怎么", "机制"]
            .iter()
            .any(|word| question.contains(word));
    let ordered = words.contains("sequential")
        || words.contains("sequentially")
        || words.contains("chronological")
        || ["时序", "时间顺序"]
            .iter()
            .any(|word| question.contains(word));
    let negated = [
        "not sequential",
        "non-sequential",
        "nonsequential",
        "无序",
        "非时序",
    ]
    .iter()
    .any(|word| question.contains(word));
    if mechanism && ordered && !negated {
        request["searchQueries"] = json!(["sequence order"]);
    }
    request
}

pub(crate) fn retrieve(conn: &Connection, payload: &Value) -> Result<Value> {
    let navigated = navigation_payload(payload);
    let payload = &navigated;
    let project = required(payload, "projectId")?;
    let question = required(payload, "question")?.trim();
    if question.chars().count() > MAX_QUESTION_CHARS {
        return Err(AppError::new(
            "QA_QUESTION_LIMIT",
            "问题最多 2000 字，请缩短后重试",
        ));
    }
    let name = conn
        .query_row("SELECT name FROM projects WHERE id=?", [project], |row| {
            row.get::<_, String>(0)
        })
        .optional()?
        .ok_or_else(|| AppError::new("NOT_FOUND", "项目不存在"))?;
    let query = Query::from_payload(payload)?;
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let as_of = payload["asOfDate"].as_str().unwrap_or(&today);
    crate::tasks::valid_date(as_of)?;
    let selection = memory_query::retrieve(
        conn,
        Some(project),
        &query,
        MAX_CANDIDATES,
        MAX_CONTENT_CHARS,
        false,
        as_of,
    )?;
    let mut memories = Vec::new();
    for mut memory in selection.records {
        let rows = evidence(
            conn,
            memory["revisionId"].as_str().unwrap(),
            project,
            &query,
        )?;
        memory["evidenceLabel"] = json!(if rows.is_empty() {
            if memory["origin"] == "user_correction" {
                "人工纠正（无原文依据）"
            } else {
                "已确认记忆（无原文依据）"
            }
        } else {
            "当前版本原文依据"
        });
        memory["evidence"] = json!(rows);
        memories.push(memory);
    }
    let pack = selected_memory_pack(question, &memories);
    let source_passages =
        crate::source_passages::retrieve(conn, Some(project), &query, as_of, &pack.references)?;
    let context_chars = json!(crate::answer_contract::indexed_references(&pack.references))
        .to_string()
        .chars()
        .count();
    Ok(json!({
        "projectId":project,"projectName":name,"question":question,"asOfDate":as_of,
        "retrievalVersion":RETRIEVAL_VERSION,"memories":pack.references,"memoryCandidatePool":memories,
        "evidenceSelectionTrace":pack.trace,
        "sourcePassages":source_passages,
        "searchQueries":payload["searchQueries"].as_array().cloned().unwrap_or_default(),
        "searchTrace":selection.trace,"searchCatalog":selection.catalog,
        "contextPack":{"version":"current-content-pack-v2-indexed-spans","maxReferences":MAX_MEMORIES,
            "maxModelChars":MAX_CONTEXT_CHARS,"modelChars":context_chars,"returned":pack.references.len(),
            "candidateLimit":MAX_CANDIDATES,"candidateCount":memories.len()}
    }))
}

pub(crate) fn validate(conn: &Connection, context: &Value) -> Result<Value> {
    let query = Query::from_payload(context)?;
    let as_of = context["asOfDate"].as_str().ok_or_else(stale)?;
    crate::tasks::valid_date(as_of).map_err(|_| stale())?;
    let project = context["projectId"].as_str().ok_or_else(stale)?;
    let project_exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM projects WHERE id=? AND name=?)",
        params![project, context["projectName"].as_str().ok_or_else(stale)?],
        |row| row.get(0),
    )?;
    let memories = context["memories"].as_array().ok_or_else(stale)?;
    if !project_exists
        || context["retrievalVersion"] != RETRIEVAL_VERSION
        || memories.len() > MAX_MEMORIES
    {
        return Err(stale());
    }
    if context.get("memoryCandidatePool").is_some() {
        let fresh = retrieve(conn, context)?;
        for field in [
            "memories",
            "memoryCandidatePool",
            "evidenceSelectionTrace",
            "contextPack",
            "sourcePassages",
        ] {
            if fresh[field] != context[field] {
                return Err(stale());
            }
        }
    }
    for passage in context["sourcePassages"].as_array().into_iter().flatten() {
        if passage["projectId"] != context["projectId"]
            || passage["asOfDate"] != context["asOfDate"]
        {
            return Err(stale());
        }
        crate::source_passages::validate(conn, passage)?;
    }
    let mut seen = HashSet::new();
    for memory in memories {
        let id = memory["memoryId"].as_str().ok_or_else(stale)?;
        if !seen.insert(id) {
            return Err(stale());
        }
        let row = conn.query_row(
            "SELECT m.content,m.revision,m.source_title,r.id,r.origin,m.kind
             FROM memories m JOIN revisions r ON r.memory_id=m.id AND r.number=m.revision AND r.content=m.content
             WHERE m.id=? AND m.project_id=? AND m.state='active' AND NOT EXISTS(SELECT 1 FROM memory_reviews v JOIN proposals p ON p.id=v.proposal_id WHERE v.target_id=m.id AND v.status='pending' AND p.status='pending' AND v.disposition IN ('conflict','uncertain'))",
            params![id, project],
            |row| Ok((row.get::<_,String>(0)?,row.get::<_,i64>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?,row.get::<_,String>(4)?,row.get::<_,String>(5)?)),
        ).optional()?.ok_or_else(stale)?;
        let excerpt = memory["content"].as_str().ok_or_else(stale)?;
        if memory["revision"].as_i64() != Some(row.1)
            || memory["sourceTitle"] != row.2
            || memory["revisionId"] != row.3
            || memory["origin"] != row.4
            || memory["kind"] != row.5
            || memory["facets"] != crate::memory_facts::load(conn, &row.3)?
            || !crate::memory_facts::applicable(&memory["facets"], &[], as_of)
            || memory["contentHash"] != hash(row.0.as_bytes())
            || excerpt.is_empty()
            || !row.0.contains(excerpt)
            || memory["evidence"] != json!(evidence(conn, &row.3, project, &query)?)
        {
            return Err(stale());
        }
    }
    Ok(json!({"valid":true}))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ModelAnswer {
    grounded: bool,
    answer: String,
    citation_ids: Vec<String>,
}

pub(crate) fn ungrounded(context: &Value) -> Value {
    json!({"answer":NO_ANSWER,"citations":[],"grounded":false,"context":context,"status":"unknown","claims":[],"unknowns":[]})
}

#[cfg(test)]
fn grounded_output(context: &Value, output: Value) -> Result<Value> {
    grounded_output_with_references(
        context,
        context["memories"].as_array().ok_or_else(stale)?,
        output,
    )
}

fn grounded_output_with_references(
    context: &Value,
    memories: &[Value],
    output: Value,
) -> Result<Value> {
    let normalized = crate::answer_contract::normalize(output, memories, "memoryId")
        .map_err(|_| AppError::new("QA_GROUNDING", "回答断言缺少当前正文支持或引用不一致"))?;
    let output: ModelAnswer = serde_json::from_value(json!({"grounded":normalized["grounded"],"answer":normalized["answer"],"citationIds":normalized["citationIds"]}))
        .map_err(|_| AppError::new("QA_MODEL_SCHEMA", "模型问答 JSON 格式无效，已取消自动回复"))?;
    if !output.grounded {
        let mut answer = ungrounded(context);
        crate::answer_contract::attach(&mut answer, &normalized);
        return Ok(answer);
    }
    if output.answer.trim().is_empty()
        || output.answer.chars().count() > 4_000
        || output.citation_ids.is_empty()
        || output.citation_ids.len() > MAX_REFERENCES
    {
        return Err(AppError::new(
            "QA_GROUNDING",
            "模型未提供有效的回答依据，已取消自动回复",
        ));
    }
    let mut seen = HashSet::new();
    let mut citations = Vec::new();
    for id in output.citation_ids {
        if !seen.insert(id.clone()) {
            return Err(AppError::new(
                "QA_GROUNDING",
                "模型引用重复，已取消自动回复",
            ));
        }
        let memory = memories
            .iter()
            .find(|memory| {
                crate::answer_contract::reference_id(memory, "memoryId") == Some(id.as_str())
            })
            .ok_or_else(|| {
                AppError::new(
                    "QA_GROUNDING",
                    "模型引用了检索范围以外的记忆，已取消自动回复",
                )
            })?;
        if memory["kind"] == "source_passage" {
            citations.push(memory.clone());
            continue;
        }
        citations.push(json!({
            "memoryId":memory["memoryId"],"revision":memory["revision"],
            "content":memory["content"],"sourceTitle":memory["sourceTitle"],
            "evidence":memory["evidence"],"evidenceLabel":memory["evidenceLabel"],"origin":memory["origin"],"facets":memory["facets"]
        }));
    }
    // Visible references are rendered from trusted retrieval metadata, never
    // copied from a model-supplied title, version, URL, or quote.
    let mut answer = output.answer.trim().to_owned();
    answer.push_str("\n\n依据：");
    for (index, citation) in citations.iter().enumerate() {
        let title = clip(
            citation["sourceTitle"].as_str().unwrap_or("已确认记忆"),
            120,
        );
        let label = citation["evidenceLabel"].as_str().unwrap_or("已确认记忆");
        let locators = citation["evidence"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|item| item["locator"].as_str())
            .map(|locator| clip(locator, 80))
            .collect::<Vec<_>>()
            .join("、");
        if citation["kind"] == "source_passage" {
            answer.push_str(&format!(
                "\n[{}] {} · {}（{}）",
                index + 1,
                title,
                label,
                citation["locator"].as_str().unwrap_or("原文段落")
            ));
        } else {
            answer.push_str(&format!(
                "\n[{}] {} · 记忆 v{} · {}",
                index + 1,
                title,
                citation["revision"],
                label
            ));
        }
        if !locators.is_empty() {
            answer.push_str(&format!("（{locators}）"));
        }
    }
    let mut output =
        json!({"answer":answer,"citations":citations,"grounded":true,"context":context});
    crate::answer_contract::attach(&mut output, &normalized);
    Ok(output)
}

pub(crate) fn render_reviewed_output(
    context: &Value,
    references: &[Value],
    raw: Value,
) -> Result<Value> {
    grounded_output_with_references(context, references, raw)
}

#[cfg(test)]
fn answer(settings: &SavedSettings, context: &Value) -> Result<Value> {
    answer_with_budget(
        settings,
        context,
        &mut crate::question_flow::Budget::new(settings),
    )
}

pub(crate) fn answer_with_budget(
    settings: &SavedSettings,
    context: &Value,
    budget: &mut crate::question_flow::Budget,
) -> Result<Value> {
    answer_with_budget_selection(settings, context, budget, None)
}

/// A navigation hint may inspect the local candidate pool for ambiguity, but
/// provider-visible witnesses must come from the actual supplied references.
pub(crate) fn current_resource_hint(context: &Value, references: &[Value]) -> Value {
    let question = context["question"].as_str().unwrap_or("");
    let pool = context["memoryCandidatePool"]
        .as_array()
        .map_or(references, Vec::as_slice);
    let local = crate::memory_links::current_resource_profile(question, pool);
    let disabled = || json!({"mode":"disabled","navigationOnly":true,"identityInferred":false});
    match local["mode"].as_str() {
        Some("ambiguous-current-resources") => json!({"mode":"ambiguous-current-resources",
            "preferredReferenceId":null,"navigationOnly":true,"identityInferred":false}),
        Some("unique-current-resource") => {
            let visible = crate::memory_links::current_resource_profile(question, references);
            let canonical = |value: &Value| {
                value
                    .as_str()
                    .map(|id| id.strip_prefix("memory:").unwrap_or(id).to_owned())
            };
            let expected = canonical(&local["preferredReferenceId"]);
            if visible["mode"] == "unique-current-resource"
                && expected.is_some()
                && canonical(&visible["preferredReferenceId"]) == expected
            {
                visible
            } else {
                disabled()
            }
        }
        _ => disabled(),
    }
}

/// Indices name only the references visible in this particular provider call.
/// The same source group can have different indices after citation selection.
pub(crate) fn survey_coverage_hint(
    question: &str,
    references: &[Value],
    reference_array: &str,
) -> Value {
    let mut hint = crate::memory_links::survey_coverage_profile(question, references);
    if hint["mode"] != "selected-section-groups" {
        return Value::Null;
    }
    hint["referenceArray"] = json!(reference_array);
    if hint.to_string().chars().count() > 900 {
        Value::Null
    } else {
        hint
    }
}

/// Citation projections omit local navigation metadata. Recover it only from
/// an exact current-pack match, preserving the review's citation order.
#[cfg(test)]
pub(crate) fn survey_review_hint(context: &Value, citations: &[Value]) -> Value {
    let canonical = |reference: &Value| {
        reference["memoryId"]
            .as_str()
            .or_else(|| reference["id"].as_str())
            .map(|id| id.strip_prefix("memory:").unwrap_or(id).to_owned())
            .filter(|id| !id.is_empty())
    };
    let pack: &[Value] = context["memories"].as_array().map_or(&[], Vec::as_slice);
    let rebound = citations
        .iter()
        .map(|citation| {
            let Some(id) = canonical(citation) else {
                return Value::Null;
            };
            if citation["revision"].as_u64().is_none()
                || citation["content"].as_str().is_none()
                || citation.get("kind").is_some_and(|kind| kind != "memory")
            {
                return Value::Null;
            }
            let mut matches = pack.iter().filter(|reference| {
                canonical(reference).as_deref() == Some(id.as_str())
                    && reference["revision"] == citation["revision"]
                    && reference["content"] == citation["content"]
                    && context["projectId"]
                        .as_str()
                        .is_none_or(|project| reference["projectId"] == project)
                    && citation
                        .get("projectId")
                        .is_none_or(|project| reference["projectId"] == *project)
            });
            match (matches.next(), matches.next()) {
                (Some(reference), None) => reference.clone(),
                _ => Value::Null,
            }
        })
        .collect::<Vec<_>>();
    survey_coverage_hint(
        context["question"].as_str().unwrap_or(""),
        &rebound,
        "references",
    )
}

pub(crate) fn model_references(context: &Value) -> Vec<Value> {
    with_source_passages(
        crate::question_target::model_target_references(
            context["question"].as_str().unwrap_or(""),
            context["memories"].as_array().map_or(&[], Vec::as_slice),
        ),
        context,
    )
}

// Internal correction selects a subset of the original references. The
// context and its database fingerprint stay intact for final validation.
pub(crate) fn answer_with_budget_selection(
    settings: &SavedSettings,
    context: &Value,
    budget: &mut crate::question_flow::Budget,
    selected_ids: Option<&[String]>,
) -> Result<Value> {
    answer_with_budget_input(settings, context, budget, selected_ids, None)
}

pub(crate) fn answer_with_budget_incremental(
    settings: &SavedSettings,
    context: &Value,
    budget: &mut crate::question_flow::Budget,
    previous: &Value,
    missing: &[Value],
) -> Result<Value> {
    answer_with_budget_input(settings, context, budget, None, Some((previous, missing)))
}

fn answer_with_budget_input(
    settings: &SavedSettings,
    context: &Value,
    budget: &mut crate::question_flow::Budget,
    selected_ids: Option<&[String]>,
    incremental: Option<(&Value, &[Value])>,
) -> Result<Value> {
    let memories = context["memories"].as_array().ok_or_else(stale)?;
    if memories.len() > MAX_MEMORIES {
        return Err(AppError::new("QA_CONTEXT_LIMIT", "问答上下文超过长度上限"));
    }
    let memories = crate::answer_contract::select_current_references(
        &model_references(context),
        selected_ids,
    )?;
    if memories.is_empty() {
        return Ok(ungrounded(context));
    }
    // This is the same material-access consent used for extraction. Merely
    // enabling a connector does not grant a remote model access to memory.
    settings.validate_material_access()?;
    let reader = crate::answer_contract::evidence_reader(context, &memories, incremental)?;
    // Retain the adapter's evidence/context cap. Shared plans, schema and
    // repair instructions are charged by Budget, as before this unification.
    let context_chars = reader.input["references"].to_string().chars().count()
        + context["question"].to_string().chars().count();
    if context_chars > MAX_CONTEXT_CHARS + 2_000 {
        return Err(AppError::new("QA_CONTEXT_LIMIT", "问答上下文超过长度上限"));
    }
    let output = budget.complete(
        settings,
        &reader.system,
        reader.input,
        reader.schema,
        "project_memory_answer",
    )?;
    let mut answer = grounded_output_with_references(context, &memories, output)?;
    if let Some((previous, _)) = incremental {
        answer["incrementalBase"] = previous.clone();
    }
    if selected_ids.is_some() {
        answer["referenceSelection"] = json!({"version":"current-reference-subset-v1",
            "reason":"explicit-target-correction","maxReferences":6,
            "referenceIds":memories.iter().map(|r|crate::answer_contract::reference_id(r,"memoryId")).collect::<Vec<_>>()});
    }
    Ok(answer)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[test]
    fn source_passage_citations_keep_their_own_identity_and_original_label() {
        let reference = json!({"id":"source:s:g","kind":"source_passage","projectId":"p",
            "sourceId":"s","segmentId":"g","sourceHash":"snapshot","contentHash":"body",
            "sourceTitle":"Atlas handbook","locator":"section 2","content":"Atlas routes requests by region.",
            "evidenceLabel":"导入原文（非正式记忆）","evidence":[]});
        let raw = json!({"grounded":true,"status":"answered","unknowns":[],"claims":[{
            "text":"Atlas routes requests by region.","supportSpans":[{"referenceIndex":1,"spanIndex":1}]}]});
        let output =
            grounded_output_with_references(&json!({"projectId":"p"}), &[reference], raw).unwrap();
        assert_eq!(output["claims"][0]["citationIds"], json!(["source:s:g"]));
        assert!(output["citations"][0].get("memoryId").is_none());
        assert!(output["answer"].as_str().unwrap().contains("导入原文"));
        assert!(!output["answer"].as_str().unwrap().contains("记忆 vnull"));
    }

    #[test]
    fn original_passages_have_a_separate_budget_without_displacing_current_assertions() {
        let memories = (0..24)
            .map(|index| {
                json!({"memoryId":format!("m{index}"),
            "content":format!("Atlas current fact {index}.")})
            })
            .collect::<Vec<_>>();
        let sources = (0..10)
            .map(|index| {
                json!({"id":format!("source:s:g{index}"),"kind":"source_passage",
            "content":format!("Atlas paragraph {index}.")})
            })
            .collect::<Vec<_>>();
        let packed = with_source_passages(memories.clone(), &json!({"sourcePassages":sources}));
        assert_eq!(&packed[..24], &memories);
        assert_eq!(packed.len(), 32);
        assert_eq!(
            with_source_passages(
                memories.clone(),
                &json!({"sourcePassages":[
                    {"id":"source:s:large","kind":"source_passage","content":"x".repeat(36_000)}
                ]})
            ),
            memories
        );
    }

    #[test]
    fn resource_hints_preserve_pool_ambiguity_without_exposing_unselected_bodies() {
        let first = json!({"id":"a","memoryId":"a","projectId":"p","revision":1,
            "content":"We create a new dataset of English reviews.","sourceTitle":"Current paper"});
        let second = json!({"id":"b","memoryId":"b","projectId":"p","revision":1,
            "content":"We introduce a new corpus of PRIVATE_UNSELECTED German reviews.","sourceTitle":"Current paper"});
        let background = json!({"id":"background","memoryId":"background","projectId":"p",
            "content":"Previous work evaluates reviews in a different language."});
        let context = json!({"question":"In what language are the reviews?",
            "memoryCandidatePool":[first.clone(),second]});
        let hint = current_resource_hint(&context, std::slice::from_ref(&first));
        assert_eq!(hint["mode"], "ambiguous-current-resources");
        assert!(hint["preferredReferenceId"].is_null());
        assert!(!hint.to_string().contains("PRIVATE_UNSELECTED"));
        assert!(!hint.to_string().contains("English"));
        let context = json!({"question":context["question"],"memoryCandidatePool":[first.clone(),background.clone()]});
        let hint = current_resource_hint(&context, std::slice::from_ref(&first));
        assert_eq!(hint["mode"], "unique-current-resource");
        assert!(hint.to_string().contains("English"));
        let hidden = current_resource_hint(&context, &[background]);
        assert_eq!(hidden["mode"], "disabled");
        assert!(!hidden.to_string().contains("English"));
        let mut wrapper = first;
        wrapper["id"] = json!("memory:a");
        assert_eq!(
            current_resource_hint(&context, &[wrapper])["mode"],
            "unique-current-resource"
        );
    }

    #[test]
    fn survey_hints_use_this_calls_reference_namespace_and_never_supply_hidden_members() {
        let reference = |id: &str, role: &str, ordinal: u64| {
            let body = format!("PRIVATE_BODY_{id}: processing applies only to archived reports.");
            let hash = crate::hash(body.as_bytes());
            let revision = format!("revision-{id}");
            let mut group = json!({"role":role,"sourceId":"source","ordinal":ordinal,
                "revisionId":revision,"anchorMemoryId":"intro","navigationOnly":true,"identityInferred":false});
            if role != "directory" {
                group["groupId"] = json!("source:10:11");
                group["sequenceIndex"] = json!(0);
                group["memberMemoryIds"] = json!(["head", "PRIVATE_HIDDEN_MEMBER"]);
            }
            json!({"id":id,"memoryId":id,"projectId":"p","revision":1,"content":body,"contentHash":hash,
                "revisionId":revision,"navigationLinks":{"revisionId":revision,"contentHash":hash,
                    "evidenceRole":"navigation-only","sourcePositions":[{"sourceId":"source",
                        "sourceHash":"source-current","segmentId":format!("segment-{ordinal}"),"ordinal":ordinal}],
                    "sectionGroup":group}})
        };
        let directory = reference("intro", "directory", 10);
        let head = reference("head", "head", 11);
        let detail = reference("PRIVATE_HIDDEN_MEMBER", "complement", 11);
        let references = vec![head.clone(), directory.clone(), detail];
        let original = references.clone();
        let question = "What approaches are described in the survey?";
        let generated = survey_coverage_hint(question, &references, "context.memories");
        assert_eq!(generated["referenceArray"], "context.memories");
        assert_eq!(generated["directoryReferenceIndices"], json!([2]));
        assert_eq!(generated["groups"], json!([{"referenceIndices":[1,3]}]));
        let review = survey_coverage_hint(question, &[directory, head], "references");
        assert_eq!(review["referenceArray"], "references");
        assert_eq!(review["directoryReferenceIndices"], json!([1]));
        assert_eq!(review["groups"], json!([{"referenceIndices":[2]}]));
        assert_eq!(review["navigationOnly"], true);
        assert_eq!(review["identityInferred"], false);
        for hint in [&generated, &review] {
            assert!(!hint.to_string().contains("PRIVATE_BODY"));
            assert!(!hint.to_string().contains("PRIVATE_HIDDEN_MEMBER"));
            assert!(hint.get("complete").is_none());
            assert!(hint.to_string().chars().count() <= 900);
        }
        assert_eq!(references, original);
        assert!(
            survey_coverage_hint("Who approved the change?", &references, "references").is_null()
        );
        assert!(survey_coverage_hint(question, &references, &"x".repeat(900)).is_null());

        let context = json!({"question":question,"projectId":"p","memories":references,
            "memoryCandidatePool":[{"memoryId":"PRIVATE_UNSELECTED","content":"PRIVATE_UNSELECTED"}]});
        let citations = references
            .iter()
            .map(|reference| {
                json!({"memoryId":reference["memoryId"],"revision":reference["revision"],
                "content":reference["content"]})
            })
            .collect::<Vec<_>>();
        let bound = survey_review_hint(&context, &citations);
        assert_eq!(bound["directoryReferenceIndices"], json!([2]));
        assert_eq!(bound["groups"], json!([{"referenceIndices":[1,3]}]));
        assert_eq!(bound["referenceArray"], "references");
        assert!(!bound.to_string().contains("PRIVATE_UNSELECTED"));
        for (field, value) in [
            ("content", json!("Changed assertion.")),
            ("revision", json!(2)),
            ("projectId", json!("other")),
        ] {
            let mut changed = citations.clone();
            changed[0][field] = value;
            assert!(survey_review_hint(&context, &changed).is_null(), "{field}");
        }
        let mut pool_only = context.clone();
        pool_only["memories"] = json!([references[1], references[2]]);
        pool_only["memoryCandidatePool"] = json!(references);
        assert!(survey_review_hint(&pool_only, &citations).is_null());
        let mut duplicate = context;
        duplicate["memories"]
            .as_array_mut()
            .unwrap()
            .push(references[0].clone());
        assert!(survey_review_hint(&duplicate, &citations).is_null());
    }
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;

    #[test]
    fn ordered_mechanism_navigation_preserves_question_scope_and_explicit_plans() {
        let original = json!({"question":"How is sequential processing implemented?", "projectId":"p", "asOfDate":"2026-10-21"});
        let navigated = navigation_payload(&original);
        assert_eq!(navigated["searchQueries"], json!(["sequence order"]));
        for key in ["question", "projectId", "asOfDate"] {
            assert_eq!(navigated[key], original[key]);
        }
        assert!(original.get("searchQueries").is_none());
        for plan in [
            json!([]),
            json!(["explicit current operation"]),
            json!(false),
        ] {
            let mut supplied = original.clone();
            supplied["searchQueries"] = plan;
            assert_eq!(navigation_payload(&supplied), supplied);
        }
        for question in [
            "Who is responsible for sequential processing?",
            "How is non-sequential processing implemented?",
            "How is the nonsequential processor designed?",
            "How does the model consume data?",
            "How are sequentiality scores evaluated?",
        ] {
            let request = json!({"question":question});
            assert_eq!(navigation_payload(&request), request);
        }
        let documents = [
            "The processor reads a sequence in order.",
            "Story quality is rated by several people.",
        ];
        let scores = Query::from_payload(&navigated).unwrap().rank(&documents);
        assert!(scores[0] > scores[1]);
    }

    #[test]
    fn selected_reference_indices_bind_to_the_actual_subset_without_changing_the_snapshot() {
        let references = vec![
            json!({"memoryId":"other","content":"The joint model contains two language models.","revision":1}),
            json!({"memoryId":"base","content":"For archived reports, the individual model uses factorized probabilities.","revision":3,
                "facets":{"conditions":["For archived reports"]}}),
        ];
        let context = json!({"memories":references,"fingerprint":"keep-original"});
        let original = context.clone();
        let selected = crate::answer_contract::select_current_references(
            &references,
            Some(&["base".to_owned()]),
        )
        .unwrap();
        let output = json!({"grounded":true,"status":"answered","unknowns":[],"claims":[{
            "text":"For archived reports, the individual model uses factorized probabilities.",
            "supportSpans":[{"referenceIndex":1,"spanIndex":1}]}]});
        let answer = grounded_output_with_references(&context, &selected, output.clone()).unwrap();
        assert_eq!(answer["citations"][0]["memoryId"], "base");
        assert_eq!(answer["citations"][0]["facets"], references[1]["facets"]);
        assert_eq!(answer["context"], original);
        assert_eq!(context, original);
        let mut forged = output;
        forged["claims"][0]["supportSpans"][0]["referenceIndex"] = json!(2);
        assert!(grounded_output_with_references(&context, &selected, forged).is_err());
    }

    fn completion_server(
        response: Value,
    ) -> (
        String,
        mpsc::Receiver<(String, Value)>,
        thread::JoinHandle<()>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let (sender, receiver) = mpsc::channel();
        let task = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut buffer = [0_u8; 4096];
            let header_end = loop {
                let length = stream.read(&mut buffer).unwrap();
                assert!(length > 0 && bytes.len() < 256 * 1024);
                bytes.extend_from_slice(&buffer[..length]);
                if let Some(index) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                    break index + 4;
                }
            };
            let headers = String::from_utf8(bytes[..header_end].to_vec()).unwrap();
            let content_length = headers
                .lines()
                .find_map(|line| {
                    let (key, value) = line.split_once(':')?;
                    key.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().unwrap())
                })
                .unwrap();
            assert!(content_length < 256 * 1024);
            while bytes.len() < header_end + content_length {
                let length = stream.read(&mut buffer).unwrap();
                assert!(length > 0);
                bytes.extend_from_slice(&buffer[..length]);
            }
            let body =
                serde_json::from_slice(&bytes[header_end..header_end + content_length]).unwrap();
            let response = response.to_string();
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", response.len(), response).unwrap();
            sender.send((headers, body)).unwrap();
        });
        (url, receiver, task)
    }

    fn database() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT);
             CREATE TABLE memories(id TEXT PRIMARY KEY,project_id TEXT,kind TEXT,content TEXT,revision INTEGER,state TEXT,source_title TEXT,updated_at TEXT);
             CREATE TABLE revisions(id TEXT PRIMARY KEY,memory_id TEXT,number INTEGER,content TEXT,origin TEXT);
             CREATE TABLE sources(id TEXT PRIMARY KEY,project_id TEXT,title TEXT,status TEXT,sha256 TEXT);
             CREATE TABLE segments(id TEXT PRIMARY KEY,source_id TEXT,ordinal INTEGER,locator TEXT,text TEXT);
             CREATE TABLE revision_evidence(revision_id TEXT,segment_id TEXT);
             CREATE TABLE proposals(id TEXT,project_id TEXT,content TEXT,status TEXT,source_id TEXT,edited INTEGER DEFAULT 0,memory_id TEXT);
             CREATE TABLE source_origins(source_id TEXT,provider TEXT,remote_id TEXT,remote_revision TEXT,fetched_at TEXT);
             CREATE TABLE memory_reviews(proposal_id TEXT,target_id TEXT,status TEXT,disposition TEXT);
             INSERT INTO projects VALUES ('a','项目 A'),('b','项目 B');
             INSERT INTO memories VALUES ('ma','a','decision','登录审计在 10 月 23 日交付。',2,'active','个人纠正','');
             INSERT INTO revisions VALUES ('ra1','ma',1,'登录审计在 10 月 20 日交付。','confirmation'),('ra2','ma',2,'登录审计在 10 月 23 日交付。','user_correction');
             INSERT INTO memories VALUES ('mb','b','decision','登录审计在 10 月 30 日交付。',1,'active','项目 B 原文','');
             INSERT INTO revisions VALUES ('rb','mb',1,'登录审计在 10 月 30 日交付。','confirmation');
             INSERT INTO memories VALUES ('deleted','a','fact','登录审计已经取消。',1,'archived','旧记录','');
             INSERT INTO revisions VALUES ('rd','deleted',1,'登录审计已经取消。','confirmation');
             INSERT INTO sources VALUES ('sa','a','原始会议记录','ready','source-hash');
             INSERT INTO segments VALUES ('g1','sa',0,'第 1 行','登录审计在 10 月 20 日交付。');
             INSERT INTO revision_evidence VALUES ('ra1','g1');
             INSERT INTO proposals(id,project_id,content,status) VALUES ('pending','a','登录审计改到下个月交付。','pending');"
        ).unwrap();
        conn.execute_batch(crate::memory_facts::MIGRATION).unwrap();
        conn.execute_batch(crate::daily_use::MIGRATION).unwrap();
        conn.execute_batch(
            "CREATE TABLE revision_retention(revision_id TEXT PRIMARY KEY, policy TEXT NOT NULL);",
        )
        .unwrap();
        conn
    }

    fn context(conn: &Connection) -> Value {
        retrieve(
            conn,
            &json!({"projectId":"a","question":"请问登录审计什么时候交付？"}),
        )
        .unwrap()
    }

    #[test]
    fn context_pack_keeps_twenty_four_current_bodies_without_charging_ui_evidence_to_model() {
        let conn = database();
        let source = "Atlas capacity details ".repeat(400);
        conn.execute(
            "INSERT INTO segments VALUES('heavy','sa',9,'section 9',?)",
            [&source],
        )
        .unwrap();
        for index in 0..30 {
            let id = format!("atlas-{index:02}");
            let revision = format!("atlas-r-{index:02}");
            let content = format!("Atlas component {index} capacity is {}.", index + 1);
            conn.execute(
                "INSERT INTO memories VALUES(?,'a','fact',?,1,'active','Atlas manual','')",
                params![id, content],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO revisions VALUES(?,?,1,?,'confirmation')",
                params![revision, id, content],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO revision_evidence VALUES(?,'heavy')",
                [revision],
            )
            .unwrap();
        }
        let packed = retrieve(
            &conn,
            &json!({"projectId":"a","question":"Atlas component capacity"}),
        )
        .unwrap();
        assert_eq!(packed["memories"].as_array().unwrap().len(), 24);
        assert_eq!(packed["contextPack"]["maxReferences"], 24);
        assert_eq!(packed["contextPack"]["maxModelChars"], 36_000);
        let bodies = packed["memories"]
            .as_array()
            .unwrap()
            .iter()
            .map(crate::answer_contract::model_reference)
            .map(|m| m.to_string().chars().count())
            .sum::<usize>();
        assert!(bodies < 36_000);
        assert!(packed["memories"].to_string().chars().count() > bodies);
        validate(&conn, &packed).unwrap();
        let mut forged = packed;
        forged["memories"][0]["content"] = json!("Atlas capacity is unlimited.");
        assert_eq!(
            validate(&conn, &forged).unwrap_err().code,
            "QA_CONTEXT_STALE"
        );
    }

    #[test]
    fn retrieval_uses_only_current_confirmed_memory_from_bound_project() {
        let conn = database();
        let value = context(&conn);
        let memories = value["memories"].as_array().unwrap();
        assert_eq!(memories.len(), 1);
        assert_eq!(memories[0]["memoryId"], "ma");
        assert_eq!(memories[0]["revision"], 2);
        assert_eq!(memories[0]["content"], "登录审计在 10 月 23 日交付。");
        assert_eq!(memories[0]["evidence"], json!([]));
        assert_eq!(memories[0]["evidenceLabel"], "人工纠正（无原文依据）");
        assert!(!value.to_string().contains("10 月 20"));
        assert!(!value.to_string().contains("10 月 30"));
        validate(&conn, &value).unwrap();
    }

    #[test]
    fn unrelated_and_stopword_only_questions_do_not_fill_context() {
        let conn = database();
        for question in ["数据库备份存储在哪里？", "请问目前这个项目怎么样？"]
        {
            let value = retrieve(&conn, &json!({"projectId":"a","question":question})).unwrap();
            assert!(value["memories"].as_array().unwrap().is_empty());
            let result = answer(&SavedSettings::default(), &value).unwrap();
            assert_eq!(result["grounded"], false);
        }
    }

    #[test]
    fn chinese_alias_queries_retrieve_english_memory_without_title_only_matches() {
        let conn = database();
        conn.execute_batch("INSERT INTO memories VALUES ('english','a','fact','ALPHA login audit retains records for 180 days.',1,'active','English notes','');
            INSERT INTO revisions VALUES ('re','english',1,'ALPHA login audit retains records for 180 days.','confirmation');
            INSERT INTO memories VALUES ('title-only','a','fact','采购预算已经核对。',1,'active','ALPHA 登录审计','');
            INSERT INTO revisions VALUES ('rt','title-only',1,'采购预算已经核对。','confirmation');").unwrap();
        let result = retrieve(
            &conn,
            &json!({"projectId":"a","question":"ＡＬＰＨＡ登录审计"}),
        )
        .unwrap();
        assert_eq!(result["memories"][0]["memoryId"], "english");
        // Navigation headings may mention another eligible memory, but it must
        // not become a retrieved answer source on a title-only match.
        assert!(!result["memories"].to_string().contains("title-only"));
        assert!(result["searchCatalog"].to_string().contains("title-only"));
        validate(&conn, &result).unwrap();
    }

    #[test]
    fn long_memory_excerpt_includes_dense_matches_at_the_end_and_validates() {
        let conn = database();
        let content = format!("接口{}雪山接口验收由小王负责。", "无关说明".repeat(1400));
        conn.execute("UPDATE memories SET content=? WHERE id='ma'", [&content])
            .unwrap();
        conn.execute("UPDATE revisions SET content=? WHERE id='ra2'", [&content])
            .unwrap();
        let result = retrieve(&conn, &json!({"projectId":"a","question":"雪山接口验收"})).unwrap();
        assert!(result["memories"][0]["content"]
            .as_str()
            .unwrap()
            .contains("雪山接口验收由小王负责"));
        assert_eq!(result["memories"][0]["truncated"], true);
        validate(&conn, &result).unwrap();
    }

    #[test]
    fn stale_revision_archived_memory_and_changed_content_cancel_answer() {
        let conn = database();
        let value = context(&conn);
        conn.execute(
            "UPDATE memories SET content='登录审计暂缓。' WHERE id='ma'",
            [],
        )
        .unwrap();
        assert_eq!(
            validate(&conn, &value).unwrap_err().code,
            "QA_CONTEXT_STALE"
        );
        conn.execute("UPDATE memories SET content='登录审计在 10 月 23 日交付。',state='archived' WHERE id='ma'", []).unwrap();
        assert_eq!(
            validate(&conn, &value).unwrap_err().code,
            "QA_CONTEXT_STALE"
        );
        conn.execute("DELETE FROM projects WHERE id='a'", [])
            .unwrap();
        assert_eq!(
            validate(&conn, &value).unwrap_err().code,
            "QA_CONTEXT_STALE"
        );
    }

    #[test]
    fn forged_missing_and_duplicate_citations_are_rejected() {
        let conn = database();
        let value = context(&conn);
        for ids in [json!(["mb"]), json!([]), json!(["ma", "ma"])] {
            let result = grounded_output(
                &value,
                json!({"grounded":true,"answer":"23 日交付","citationIds":ids}),
            );
            assert_eq!(result.unwrap_err().code, "QA_GROUNDING");
        }
        let result = grounded_output(
            &value,
            crate::answer_contract::fixture(
                "10 月 23 日交付。",
                json!(["ma"]),
                value["memories"][0]["content"].as_str().unwrap(),
            ),
        )
        .unwrap();
        assert!(result["answer"].as_str().unwrap().contains("记忆 v2"));
        assert!(result["answer"]
            .as_str()
            .unwrap()
            .contains("人工纠正（无原文依据）"));
        let result = grounded_output(
            &value,
            json!({"grounded":false,"answer":"无依据的文字","citationIds":["ma"]}),
        )
        .unwrap();
        assert_eq!(result["grounded"], false);
        assert_eq!(result["citations"], json!([]));
    }

    #[test]
    fn remote_material_consent_is_required_before_answering() {
        let conn = database();
        let value = context(&conn);
        let settings = SavedSettings {
            api_key: Some("test-key".into()),
            remote_consent: false,
            ..SavedSettings::default()
        };
        assert_eq!(
            answer(&settings, &value).unwrap_err().code,
            "REMOTE_CONSENT_REQUIRED"
        );
    }

    #[test]
    fn evidence_is_current_revision_only_and_changes_invalidate_snapshot() {
        let conn = database();
        conn.execute("INSERT INTO segments VALUES ('g2','sa',1,'第 2 行','用户纠正：登录审计改在 10 月 23 日交付。')", []).unwrap();
        conn.execute("INSERT INTO revision_evidence VALUES ('ra2','g2')", [])
            .unwrap();
        let value = context(&conn);
        assert_eq!(value["memories"][0]["evidence"][0]["segmentId"], "g2");
        validate(&conn, &value).unwrap();
        conn.execute("UPDATE segments SET text='该资料已修改' WHERE id='g2'", [])
            .unwrap();
        assert_eq!(
            validate(&conn, &value).unwrap_err().code,
            "QA_CONTEXT_STALE"
        );
    }

    #[test]
    fn english_terms_match_whole_words_and_chinese_ignores_question_particles() {
        let query = Query::new("请问谁负责登录审计？");
        assert!(query.score("", "登录审计") > 0);
        assert_eq!(query.score("", "负责财务"), 0);
        assert_eq!(Query::new("api").score("", "the apiary feature"), 0);
        assert!(Query::new("api").score("", "the api feature") > 0);
    }

    #[test]
    fn model_question_roundtrip_uses_selected_provider_and_bounded_citation_schema() {
        let conn = database();
        let value = context(&conn);
        for provider in ["openai_compatible", "ollama"] {
            let output = crate::answer_contract::fixture(
                "登录审计在 10 月 23 日交付。",
                json!(["ma"]),
                value["memories"][0]["content"].as_str().unwrap(),
            );
            let response = if provider == "ollama" {
                json!({"message":{"content":output.to_string()},"done":true,"done_reason":"stop"})
            } else {
                json!({"choices":[{"message":{"content":output.to_string()},"finish_reason":"stop"}]})
            };
            let (url, request, server) = completion_server(response);
            let settings = SavedSettings {
                provider: provider.into(),
                base_url: url,
                model: "chosen-model".into(),
                output_format: "json_schema".into(),
                timeout_seconds: 5,
                api_key: Some("private-model-key".into()),
                remote_consent: false,
                ..SavedSettings::default()
            };
            let result = answer(&settings, &value).unwrap();
            assert_eq!(result["grounded"], true);
            let (headers, body) = request.recv_timeout(Duration::from_secs(5)).unwrap();
            server.join().unwrap();
            assert_eq!(body["model"], "chosen-model");
            assert_eq!(body["stream"], false);
            assert!(body.get("tools").is_none());
            assert!(!body.to_string().contains("private-model-key"));
            let schema = if provider == "ollama" {
                assert!(!headers.to_lowercase().contains("authorization"));
                assert!(headers.starts_with("POST /api/chat "));
                &body["format"]
            } else {
                assert!(headers
                    .to_lowercase()
                    .contains("authorization: bearer private-model-key"));
                assert!(headers.starts_with("POST /chat/completions "));
                assert_eq!(body["response_format"]["json_schema"]["strict"], true);
                &body["response_format"]["json_schema"]["schema"]
            };
            assert_eq!(
                schema["properties"]["claims"]["items"]["properties"]["supportSpans"]["items"]
                    ["properties"]["referenceIndex"]["maximum"],
                1
            );
            assert!(schema["properties"].get("citationIds").is_none());
            let envelope: Value =
                serde_json::from_str(body["messages"][1]["content"].as_str().unwrap()).unwrap();
            assert_eq!(envelope["projectId"], "a");
            assert_eq!(envelope["references"][0]["memoryId"], "ma");
            assert_eq!(
                envelope["references"][0]["content"][0]["text"],
                value["memories"][0]["content"]
            );
            assert!(envelope.get("schema").is_none());
            assert!(envelope["references"][0].get("evidence").is_none());
            assert!(envelope["references"][0].get("record").is_none());
            assert_eq!(
                result["citations"][0]["evidence"],
                value["memories"][0]["evidence"]
            );
            assert!(!envelope.to_string().contains("10 月 20"));
            assert!(!envelope.to_string().contains("10 月 30"));
        }
    }

    #[test]
    fn evidence_reader_is_identical_across_entrypoints_for_fixed_evidence() {
        let fact = "Atlas records observations as a table.";
        let source = json!({"id":"source:atlas:section","kind":"source_passage","projectId":"p",
            "sourceId":"atlas","segmentId":"section","sourceTitle":"Atlas handbook",
            "sourceHash":"snapshot","contentHash":"body","locator":"section","content":fact,
            "evidenceLabel":"导入原文（非正式记忆）"});
        let base = json!({"projectId":"p","question":"What format does Atlas record?",
            "date":"2026-10-26","asOfDate":"2026-10-26","memories":[],"sourcePassages":[source],
            "limitations":[],"preferences":{"answerStyle":"concise"},"contextIntent":["topic"],
            "searchTrace":{"private":"SEARCH_TRACE_NOT_EVIDENCE"},"projectName":"UNREAD_PROJECT_METADATA"});
        let response = json!({"grounded":true,"status":"answered","unknowns":[],"claims":[{
            "text":fact,"supportSpans":[{"referenceIndex":1,"spanIndex":1}]}]});
        let previous = json!({"grounded":true,"claims":[{"text":"A separately reviewed fact."}]});
        let missing = vec![json!({"label":"the requested format"})];
        for mode in ["initial", "repair", "incremental"] {
            let mut context = base.clone();
            if mode == "repair" {
                context["answerRepair"] = json!({"version":"evidence-repair-v1","issues":[]});
            }
            let original = context.clone();
            let mut requests = Vec::new();
            for desktop in [false, true] {
                let (url, received, worker) = completion_server(json!({"choices":[{
                    "message":{"content":response.to_string()},"finish_reason":"stop"}]}));
                let settings = SavedSettings {
                    provider: "openai_compatible".into(),
                    base_url: url,
                    model: "reader-fixture".into(),
                    output_format: "json_schema".into(),
                    timeout_seconds: 5,
                    api_key: Some("fixture-key".into()),
                    ..SavedSettings::default()
                };
                let mut budget = crate::question_flow::Budget::new(&settings);
                let answer = match (desktop, mode) {
                    (true, "incremental") => crate::assistant_qa::model_answer_incremental(
                        &settings,
                        &context,
                        &mut budget,
                        &previous,
                        &missing,
                    ),
                    (true, _) => {
                        crate::assistant_qa::model_answer(&settings, &context, &mut budget)
                    }
                    (false, "incremental") => answer_with_budget_incremental(
                        &settings,
                        &context,
                        &mut budget,
                        &previous,
                        &missing,
                    ),
                    (false, _) => answer_with_budget(&settings, &context, &mut budget),
                }
                .unwrap();
                assert_eq!(answer["claims"][0]["text"], fact);
                assert_eq!(answer["citations"][0]["id"], source["id"]);
                let (_, body) = received.recv_timeout(Duration::from_secs(5)).unwrap();
                worker.join().unwrap();
                requests.push(body);
            }
            assert_eq!(context, original);
            assert_eq!(requests[0]["messages"], requests[1]["messages"], "{mode}");
            assert_eq!(
                requests[0]["response_format"]["json_schema"]["schema"],
                requests[1]["response_format"]["json_schema"]["schema"]
            );
            let input: Value =
                serde_json::from_str(requests[0]["messages"][1]["content"].as_str().unwrap())
                    .unwrap();
            assert_eq!(input["readerContract"], "evidence-answer-reader-v1");
            assert_eq!(input["references"].as_array().unwrap().len(), 1);
            assert_eq!(input["references"][0]["content"][0]["text"], fact);
            assert!(input.get("context").is_none());
            assert!(!input.to_string().contains("SEARCH_TRACE_NOT_EVIDENCE"));
            assert!(!input.to_string().contains("UNREAD_PROJECT_METADATA"));
            assert_eq!(input["presentationContext"]["date"], "2026-10-26");
            if mode == "incremental" {
                assert_eq!(
                    requests[0]["response_format"]["json_schema"]["schema"]["properties"]["claims"]
                        ["maxItems"],
                    11
                );
            }
        }
    }

    #[test]
    fn truncated_model_completion_cannot_become_an_automatic_reply() {
        let conn = database();
        let response = json!({"choices":[{"message":{"content":"{\"grounded\":true"},"finish_reason":"length"}]});
        let (url, request, server) = completion_server(response);
        let settings = SavedSettings {
            base_url: url,
            api_key: Some("test-key".into()),
            timeout_seconds: 5,
            ..SavedSettings::default()
        };
        let error = answer(&settings, &context(&conn)).unwrap_err();
        request.recv_timeout(Duration::from_secs(5)).unwrap();
        server.join().unwrap();
        assert_eq!(error.code, "MODEL_INCOMPLETE");
    }
}
