//! Models supply bounded assertions with exact anchors in current formal text.
//! Only this validated representation is rendered; free-form answer is ignored.
use crate::{AppError, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashSet;

const MAX_SPAN_CHARS: usize = 600;
const MAX_UNKNOWN_CHARS: usize = 2_000;
const UNKNOWN_PRESENTATION_CHARS: usize = 300;

#[cfg(test)]
pub(crate) const RULES: &str = concat!(
    "输出status、grounded、answer、citationIds、claims、unknowns。",
    "status为answered完整回答、partial部分回答、unknown无依据或conflicted存在冲突。",
    "每条claims只陈述一个与问题直接相关的事实，含text、citationIds、supportQuotes；最多12条。",
    "先确定问题要求的对象、字段、数量、种类或关系，再收集回答这些目标所需的多条当前记录；不要只取第一条相关记录。",
    "同主题背景、以往工作的结果或其他对象的信息不等于回答所问对象；不能用背景事实配上未知说明伪装成部分回答。",
    "supportQuotes每项为citationId和quote，quote须逐字摘自该引用的当前content或结构化记录的文字表示，不能引用旧原文覆盖当前事实。",
    "每条claim的每个citationId都必须有对应原文锚点；不要将无关背景、事项相似或通用规定写成当前实体的事实。",
    "answer留空，程序从claims渲染答案；顶层citationIds恰好为claims引用的去重并集。",
    "partial必须至少直接回答一个所问子问题，unknowns仅列剩余缺失字段或未证实前提，不能夹带新事实；如果所有所问目标都缺失，status=unknown且claims为空。",
    "answered/partial时grounded=true；unknown/conflicted时grounded=false，claims和citationIds为空。"
);

pub(crate) const COMPACT_RULES: &str = concat!(
    "Return only grounded,status,claims,unknowns. status: answered/partial/unknown/conflicted. ",
    "Each claim has text and supportSpans of supplied integer referenceIndex/spanIndex only. Max12 claims,12 spans and6 references per claim. Program restores exact quotes. ",
    "Omitted projectId/sourceTitle inherit the first item; distinct projects/sources remain explicit. Indices do not prove support. Check subject,object,role,stage,time,negation,conditions and relation against current text. ",
    "Answer the requested value/name/type/conclusion first, with complementary recorded name/category and scope. Separate main task from components and individual from joint; a whole containing units does not define each unit. Identify current resources from explicit study-to-resource statements; related work cannot supply the current study's attributes. List actual resource uses without turning monolingual into parallel. targetPlan is navigation, never identity proof. ",
    "questionPlan fixes obligations and granularity. Do not expand them from references or unknowns. A documented step-by-step/per-item operation plus selection can explain variable input cardinality; do not add unspecified padding,batching,dimensions or internals. A composition summary may report an explicitly named base/architecture with its condition; a bare unrelated name is insufficient, but do not invent an exhaustive internal decomposition. ",
    "For an unqualified count give the documented participating group and condition; do not replace it with an unknown entire-population total. A named metric may use its documented aggregate/average definition; do not demand a single submetric or separate values unless asked. Joint/end-to-end training can cover component training; do not invent separate pretraining phases. Preserve explicit all/full/internal/separate/comparison/shared-weight/formula requests. ",
    "Yes/no answers lead with the supported conclusion and scope: non-significant improvement means no significant improvement,not absolute ineffectiveness. Missing evidence means unknown,not No. Absence from an input list does NOT prove non-use; routing or independent components do NOT prove excluded inputs or shared/unshared weights. Negative conclusions need explicit negation or an exhaustive supported relation. Purpose is not measured effect. ",
    "For survey_summary, summarize methods/systems reviewed by the source,not the authors' own contribution. Lead with representative approaches and their recorded roles,then categories; introduction alone does not cover available concrete works. surveyCoverage only locates actual references; every role needs its own anchor. source_representatives does not require a worldwide complete inventory or comprehensive conclusion; preserve explicit exhaustive requests and never invent examples. ",
    "Use each questionPlan obligation's granularity.answerFocus and completionCheck to organize the answer at the original scope; they never supply facts. A citation may contain facts not stated in claim.text: naming or citing a paragraph does not mean its other facts have been answered. Keep only directly relevant atomic claims. partial needs a directly answered part and necessary remaining unknowns; never add unasked detail as an unknown. grounded=true for answered/partial. For unknown/conflicted set grounded=false and claims=[]. Unknowns contain no new facts. Use the question's language."
);

/// The two delivery adapters share this entire factual reader. Caller-specific
/// retrieval, authorization and rendering remain outside this contract.
pub(crate) struct EvidenceReader {
    pub system: String,
    pub input: Value,
    pub schema: Value,
}

pub(crate) fn evidence_reader(
    context: &Value,
    references: &[Value],
    incremental: Option<(&Value, &[Value])>,
) -> Result<EvidenceReader> {
    let question = context["question"]
        .as_str()
        .ok_or_else(|| AppError::new("QA_READER_INPUT", "证据阅读必须提供原问题"))?;
    let mut schema = compact_schema(references.len());
    if let Some((previous, _)) = incremental {
        let count = previous["claims"].as_array().map_or(0, Vec::len);
        if previous["grounded"] != true || count == 0 || count >= 12 {
            return Err(AppError::new(
                "QA_INCREMENTAL_LIMIT",
                "增量回答必须保留已审断言且遵守12条总上限",
            ));
        }
        schema["properties"]["claims"]["maxItems"] = json!(12 - count);
    }
    let mut system = format!(
        "{}{}{}{}",
        include_str!("evidence_reader_system.txt"),
        crate::question_flow::GROUNDING_RULES,
        crate::question_flow::ANSWER_RULES,
        COMPACT_RULES
    );
    let mut input = json!({"readerContract":"evidence-answer-reader-v1",
        "task":"依据references逐项回答原问题要求的对象与字段；部分直接可答则partial并保留必要未知，全部无直接依据则unknown。",
        "question":question,"projectId":context["projectId"],
        "references":indexed_references(references),
        "questionPlan":crate::question_plan::QuestionPlan::from_question(question).model_view(),
        "schema":schema});
    let mut presentation = serde_json::Map::new();
    if let Some(date) = context.get("asOfDate").or_else(|| context.get("date")) {
        if !date.is_null() {
            presentation.insert("date".to_owned(), date.clone());
        }
    }
    for field in ["preferences", "contextIntent", "limitations"] {
        if let Some(value) = context.get(field).filter(|value| !value.is_null()) {
            presentation.insert(field.to_owned(), value.clone());
        }
    }
    if !presentation.is_empty() {
        input["presentationContext"] = Value::Object(presentation);
    }
    let target = crate::question_target::model_view(question, references);
    if !target.is_null() {
        input["targetPlan"] = target;
    }
    let resources = crate::qa::current_resource_hint(context, references);
    if resources["mode"] != "disabled" {
        input["currentResourceProfile"] = resources;
    }
    let survey = crate::qa::survey_coverage_hint(question, references, "references");
    if !survey.is_null() {
        input["surveyCoverage"] = survey;
    }
    if let Some(repair) = context
        .get("answerRepair")
        .filter(|repair| repair.is_object())
    {
        input["answerRepair"] = repair.clone();
        system.push_str(crate::answer_repair::repair_instructions());
    }
    if let Some((previous, missing)) = incremental {
        input["incrementalAnswer"] = incremental_input(previous, missing)?;
        input["task"] = json!("只补充missingAspects所需且本次references明确支持的新断言；verifiedClaims仅作去重和条件一致性对照，不重写、不重复输出、不作为新增引用依据。仍缺的必要信息保留unknown，不能补常识或改变原问题义务。程序将单独核验新增断言后合并。");
    }
    Ok(EvidenceReader {
        system,
        input,
        schema,
    })
}

/// Select only complete references already present in a validated snapshot.
/// Selection is an internal controller operation, never a source of facts.
pub(crate) fn select_current_references(
    references: &[Value],
    selected_ids: Option<&[String]>,
) -> Result<Vec<Value>> {
    let Some(selected_ids) = selected_ids else {
        return Ok(references.to_vec());
    };
    let bad = || AppError::new("QA_CONTEXT_SELECTION", "纠错引用必须唯一绑定当前完整上下文");
    if selected_ids.is_empty() || selected_ids.len() > 6 {
        return Err(bad());
    }
    let mut requested = HashSet::new();
    let mut positions = HashSet::new();
    for selected in selected_ids {
        if selected.trim().is_empty() || !requested.insert(selected) {
            return Err(bad());
        }
        let mut matches = references.iter().enumerate().filter(|(_, reference)| {
            reference["id"].as_str() == Some(selected.as_str())
                || reference["memoryId"].as_str() == Some(selected.as_str())
                || reference["memoryId"]
                    .as_str()
                    .filter(|memory_id| !memory_id.is_empty())
                    .is_some_and(|memory_id| selected == &format!("memory:{memory_id}"))
        });
        let Some((position, _)) = matches.next() else {
            return Err(bad());
        };
        if matches.next().is_some() || !positions.insert(position) {
            return Err(bad());
        }
    }
    Ok(references
        .iter()
        .enumerate()
        .filter(|(position, _)| positions.contains(position))
        .map(|(_, reference)| reference.clone())
        .collect())
}

pub(crate) fn compact_schema(reference_count: usize) -> Value {
    json!({"type":"object","additionalProperties":false,
    "required":["grounded","status","claims","unknowns"],"properties":{
        "grounded":{"type":"boolean"},
        "status":{"type":"string","enum":["answered","partial","unknown","conflicted"]},
        "unknowns":{"type":"array","maxItems":6,"items":{"type":"string","minLength":1,"maxLength":MAX_UNKNOWN_CHARS}},
        "claims":{"type":"array","maxItems":12,"items":{"type":"object","additionalProperties":false,
            "required":["text","supportSpans"],"properties":{
                "text":{"type":"string","minLength":1,"maxLength":600},
                "supportSpans":{"type":"array","minItems":1,"maxItems":12,"items":{
                    "type":"object","additionalProperties":false,"required":["referenceIndex","spanIndex"],
                    "properties":{"referenceIndex":{"type":"integer","minimum":1,"maximum":reference_count},
                        "spanIndex":{"type":"integer","minimum":1}}}}
            }}}
    }})
}

/// Exact, contiguous Unicode slices. Prefer sentence/newline boundaries, but
/// never drop whitespace or any other character between the numbered spans.
fn content_spans(content: &str) -> Vec<&str> {
    let mut spans = Vec::new();
    let mut start = 0;
    while start < content.len() {
        let remaining = &content[start..];
        let mut boundary = None;
        let mut end = None;
        for (position, (offset, character)) in remaining.char_indices().enumerate() {
            if position == MAX_SPAN_CHARS {
                end = Some(boundary.unwrap_or(offset));
                break;
            }
            if position >= MAX_SPAN_CHARS / 2
                && matches!(character, '\n' | '.' | '!' | '?' | '。' | '！' | '？')
            {
                boundary = Some(offset + character.len_utf8());
            }
        }
        let end = end.unwrap_or(remaining.len());
        spans.push(&remaining[..end]);
        start += end;
    }
    spans
}

/// Generation receives the current body exactly once, partitioned into numbered
/// spans. Stable IDs remain for trusted evaluation capture; generated output
/// refers only to positions in this immutable, caller-provided reference list.
pub(crate) fn indexed_references(references: &[Value]) -> Vec<Value> {
    let common_project = references
        .first()
        .and_then(|reference| reference["projectId"].as_str())
        .filter(|project| !project.trim().is_empty())
        .filter(|project| {
            references
                .iter()
                .all(|reference| reference["projectId"] == *project)
        });
    let common_source = common_project.and_then(|_| {
        references
            .first()
            .and_then(|reference| reference["sourceTitle"].as_str())
            .filter(|title| !title.trim().is_empty())
            .filter(|title| {
                references
                    .iter()
                    .all(|reference| reference["sourceTitle"] == *title)
            })
    });
    references
        .iter()
        .enumerate()
        .map(|(index, reference)| {
            let mut projected = model_reference(reference);
            let body = reference["content"].as_str().unwrap_or("");
            projected["referenceIndex"] = json!(index + 1);
            projected["content"] = json!(content_spans(body)
                .into_iter()
                .enumerate()
                .map(|(index, text)| json!({"spanIndex":index + 1,"text":text}))
                .collect::<Vec<_>>());
            if let Some(object) = projected.as_object_mut() {
                // Explicit null means originally unavailable. Only fields
                // deliberately omitted by the exact common-value checks may
                // inherit the first reference's project or source metadata.
                object.entry("projectId").or_insert(Value::Null);
                object.entry("sourceTitle").or_insert(Value::Null);
                if index > 0 && common_project.is_some() {
                    object.remove("projectId");
                }
                if object
                    .get("memoryId")
                    .and_then(Value::as_str)
                    .is_some_and(|memory| {
                        !memory.is_empty()
                            && object.get("id").and_then(Value::as_str)
                                == Some(format!("memory:{memory}").as_str())
                    })
                {
                    object.remove("memoryId");
                }
                object.remove("revision");
                object.remove("updatedAt");
                if let Some(facets) = object.get_mut("facets").and_then(Value::as_object_mut) {
                    facets.retain(|_, value| match value {
                        Value::Null => false,
                        Value::String(text) => !text.trim().is_empty(),
                        Value::Array(values) => !values.is_empty(),
                        _ => true,
                    });
                    if facets.is_empty() {
                        object.remove("facets");
                    }
                }
                if object.get("title") == object.get("sourceTitle") {
                    object.remove("title");
                }
                if index > 0 && common_source.is_some() {
                    object.remove("sourceTitle");
                }
            }
            projected
        })
        .collect()
}

#[cfg(test)]
pub(crate) fn schema(ids: Vec<Value>) -> Value {
    let id = json!({"type":"string","enum":ids});
    json!({"type":"object","additionalProperties":false,
    "required":["grounded","answer","citationIds","status","claims","unknowns"],"properties":{
        "grounded":{"type":"boolean"},"answer":{"type":"string","maxLength":0},
        "status":{"type":"string","enum":["answered","partial","unknown","conflicted"]},
        "citationIds":{"type":"array","maxItems":40,"items":id},
        "unknowns":{"type":"array","maxItems":6,"items":{"type":"string","maxLength":300}},
        "claims":{"type":"array","maxItems":12,"items":{"type":"object","additionalProperties":false,
            "required":["text","citationIds","supportQuotes"],"properties":{
                "text":{"type":"string","minLength":1,"maxLength":600},
                "citationIds":{"type":"array","minItems":1,"maxItems":6,"items":id},
                "supportQuotes":{"type":"array","minItems":1,"maxItems":12,"items":{
                    "type":"object","additionalProperties":false,"required":["citationId","quote"],
                    "properties":{"citationId":id,"quote":{"type":"string","minLength":1,"maxLength":600}}}}
            }}}
    }})
}

/// A model-facing view of a current reference. Source excerpts and the full
/// backing record remain available to trusted callers for display and audit,
/// but cannot compete with the current formal assertion in a model prompt.
pub(crate) fn model_reference(reference: &Value) -> Value {
    let mut projected = serde_json::Map::new();
    for field in [
        "id",
        "memoryId",
        "content",
        "title",
        "sourceTitle",
        "kind",
        "projectId",
        "revision",
        "updatedAt",
        "sourceId",
        "sourceVersionId",
        "sourceOrigin",
        "segmentId",
        "sourceHash",
        "contentHash",
        "locator",
        "evidenceLabel",
    ] {
        if let Some(value) = reference.get(field) {
            projected.insert(field.to_owned(), value.clone());
        }
    }
    if let Some(facets) = reference
        .get("facets")
        .and_then(Value::as_object)
        .or_else(|| reference.get("record")?.get("facets")?.as_object())
    {
        let mut accepted = serde_json::Map::new();
        for field in [
            "entity",
            "topic",
            "role",
            "conditions",
            "validFrom",
            "validUntil",
        ] {
            if let Some(value) = facets.get(field) {
                accepted.insert(field.to_owned(), value.clone());
            }
        }
        projected.insert("facets".to_owned(), Value::Object(accepted));
    }
    Value::Object(projected)
}

/// Source passages are independent evidence, never synthetic formal memories.
/// Preserve the historical memory ID convention while allowing typed sources
/// to use their own immutable identity in the connector contract.
pub(crate) fn reference_id<'a>(reference: &'a Value, id_field: &str) -> Option<&'a str> {
    reference[id_field]
        .as_str()
        .filter(|id| !id.is_empty())
        .or_else(|| {
            (reference["kind"] == "source_passage")
                .then(|| reference["id"].as_str().filter(|id| !id.is_empty()))
                .flatten()
        })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Output {
    grounded: bool,
    answer: String,
    citation_ids: Vec<String>,
    #[serde(default)]
    status: String,
    #[serde(default)]
    claims: Vec<Claim>,
    #[serde(default)]
    unknowns: Vec<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Claim {
    text: String,
    citation_ids: Vec<String>,
    support_quotes: Vec<Anchor>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Anchor {
    citation_id: String,
    quote: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CompactOutput {
    grounded: bool,
    status: String,
    claims: Vec<CompactClaim>,
    unknowns: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CompactClaim {
    text: String,
    support_spans: Vec<SpanSelection>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SpanSelection {
    reference_index: usize,
    span_index: usize,
}

fn resolve_compact(raw: Value, references: &[Value], id_field: &str) -> Result<Value> {
    let bad = || AppError::new("QA_CLAIM_BINDING", "回答断言缺少当前正文支持或引用不一致");
    let output: CompactOutput = serde_json::from_value(raw).map_err(|_| bad())?;
    if !output.grounded {
        return Ok(
            json!({"grounded":false,"answer":"","citationIds":[],"claims":[],"unknowns":[],
            "status":if output.status=="conflicted" {"conflicted"}else{"unknown"}}),
        );
    }
    if output.claims.is_empty() || output.claims.len() > 12 {
        return Err(bad());
    }
    let mut ids = Vec::<String>::new();
    let mut claims = Vec::new();
    for claim in output.claims {
        if claim.support_spans.is_empty() || claim.support_spans.len() > 12 {
            return Err(bad());
        }
        let mut selected = HashSet::new();
        let mut claim_ids = Vec::<String>::new();
        let mut anchors = Vec::new();
        for selection in claim.support_spans {
            if !selected.insert((selection.reference_index, selection.span_index)) {
                return Err(bad());
            }
            let reference = selection
                .reference_index
                .checked_sub(1)
                .and_then(|index| references.get(index))
                .ok_or_else(bad)?;
            let id = reference_id(reference, id_field).ok_or_else(bad)?;
            // Ambiguous IDs cannot bind an index to a unique current record.
            if references
                .iter()
                .filter(|reference| reference_id(reference, id_field) == Some(id))
                .count()
                != 1
            {
                return Err(bad());
            }
            let body = reference["content"].as_str().ok_or_else(bad)?;
            let spans = content_spans(body);
            let quote = selection
                .span_index
                .checked_sub(1)
                .and_then(|index| spans.get(index))
                .ok_or_else(bad)?;
            if !claim_ids.iter().any(|known| known == id) {
                claim_ids.push(id.to_owned());
            }
            if !ids.iter().any(|known| known == id) {
                ids.push(id.to_owned());
            }
            anchors.push(json!({"citationId":id,"quote":quote}));
        }
        claims.push(json!({"text":claim.text,"citationIds":claim_ids,"supportQuotes":anchors}));
    }
    Ok(
        json!({"grounded":true,"answer":"","citationIds":ids,"status":output.status,
        "claims":claims,"unknowns":output.unknowns}),
    )
}

pub(crate) fn normalize(raw: Value, references: &[Value], id_field: &str) -> Result<Value> {
    let compact = (raw.get("answer").is_none() && raw.get("citationIds").is_none())
        || raw["claims"].as_array().is_some_and(|claims| {
            claims
                .iter()
                .any(|claim| claim.get("supportSpans").is_some())
        });
    let raw = if compact {
        resolve_compact(raw, references, id_field)?
    } else {
        raw
    };
    let mut normalized = normalize_legacy(raw, references, id_field)?;
    if compact {
        normalized["bindingMode"] = json!("indexed-current-spans-v2");
    }
    Ok(normalized)
}

fn normalize_legacy(raw: Value, references: &[Value], id_field: &str) -> Result<Value> {
    let bad = || AppError::new("QA_CLAIM_BINDING", "回答断言缺少当前正文支持或引用不一致");
    let out: Output = serde_json::from_value(raw).map_err(|_| bad())?;
    // Legacy refusals are safe; successful output must obey the new contract.
    if !out.grounded {
        if !out.claims.is_empty() || !out.unknowns.is_empty() || !out.citation_ids.is_empty() {
            // A refusal never renders supplied prose or references.
            return Ok(
                json!({"grounded":false,"answer":"","citationIds":[],"claims":[],"unknowns":[],"status":"unknown"}),
            );
        }
        return Ok(
            json!({"grounded":false,"answer":"","citationIds":[],"claims":[],"unknowns":[],"status":if out.status=="conflicted" {"conflicted"} else {"unknown"}}),
        );
    }
    if !["answered", "partial"].contains(&out.status.as_str())
        || out.claims.is_empty()
        || out.claims.len() > 12
        || out.unknowns.len() > 6
        || out
            .unknowns
            .iter()
            .any(|s| s.trim().is_empty() || s.chars().count() > MAX_UNKNOWN_CHARS)
        || (out.status == "partial" && out.unknowns.is_empty())
        || out.answer.chars().count() > 6000
    {
        return Err(bad());
    }
    let mut ids = Vec::new();
    let mut claims = Vec::new();
    let mut lines = Vec::new();
    for claim in out.claims {
        let unique = claim.citation_ids.iter().collect::<HashSet<_>>();
        if claim.text.trim().is_empty()
            || claim.text.chars().count() > 600
            || unique.is_empty()
            || unique.len() != claim.citation_ids.len()
            || unique.len() > 6
            || claim.support_quotes.len() > 12
        {
            return Err(bad());
        }
        for anchor in &claim.support_quotes {
            let reference = references
                .iter()
                .find(|r| reference_id(r, id_field) == Some(anchor.citation_id.as_str()))
                .ok_or_else(bad)?;
            if !unique.contains(&anchor.citation_id)
                || anchor.quote.trim().is_empty()
                || anchor.quote.chars().count() > 600
                || !reference["content"]
                    .as_str()
                    .unwrap_or("")
                    .contains(&anchor.quote)
            {
                return Err(bad());
            }
        }
        for id in &claim.citation_ids {
            if !claim.support_quotes.iter().any(|a| &a.citation_id == id) {
                return Err(bad());
            }
            if !ids.contains(id) {
                ids.push(id.clone());
            }
        }
        let markers = claim
            .citation_ids
            .iter()
            .map(|id| format!("[{}]", ids.iter().position(|v| v == id).unwrap() + 1))
            .collect::<String>();
        lines.push(format!("{} {}", claim.text.trim(), markers));
        claims.push(json!({"text":claim.text.trim(),"citationIds":claim.citation_ids,"supportQuotes":claim.support_quotes.iter().map(|a| json!({"citationId":a.citation_id,"quote":a.quote})).collect::<Vec<_>>()}));
    }
    if ids.iter().collect::<HashSet<_>>() != out.citation_ids.iter().collect::<HashSet<_>>()
        || ids.len() != out.citation_ids.len()
    {
        return Err(bad());
    }
    // Keep complete uncertainty for semantic review. Clipping affects only
    // displayed prose, never the partial/unknown/refusal decision or review data.
    let unknowns_presentation = out
        .unknowns
        .iter()
        .map(|unknown| {
            if unknown.chars().count() > UNKNOWN_PRESENTATION_CHARS {
                format!(
                    "{}…",
                    unknown
                        .chars()
                        .take(UNKNOWN_PRESENTATION_CHARS - 1)
                        .collect::<String>()
                )
            } else {
                unknown.clone()
            }
        })
        .collect::<Vec<_>>();
    if !unknowns_presentation.is_empty() {
        lines.push(format!("尚待确认：{}", unknowns_presentation.join("；")));
    }
    // Retain the model's explicit uncertainty without inventing or deleting a
    // fact. All assertion, anchor, citation and size checks have already passed.
    let status = if out.status == "answered" && !out.unknowns.is_empty() {
        "partial"
    } else {
        out.status.as_str()
    };
    Ok(
        json!({"grounded":true,"answer":lines.join("\n"),"citationIds":ids,"claims":claims,"unknowns":out.unknowns,
            "unknownsPresentation":unknowns_presentation,"status":status}),
    )
}

pub(crate) fn attach(answer: &mut Value, normalized: &Value) {
    for key in ["claims", "unknowns", "unknownsPresentation", "status"] {
        answer[key] = normalized[key].clone();
    }
    answer["claimValidation"] = json!({"version":if normalized["bindingMode"]=="indexed-current-spans-v2" {"indexed-current-spans-v2"}else{"atomic-anchors-v1"},
        "bindingsValid":true,"semanticSupport":"not_independently_scored"});
}

/// Re-render a subset of independently reviewed claims. The caller supplies
/// review decisions, never replacement prose or invented reference metadata.
pub(crate) fn retain_reviewed_claims(
    answer: &Value,
    keep_indices: &[usize],
    mut unknowns: Vec<Value>,
    complete: bool,
    desktop: bool,
) -> Result<Value> {
    let bad = || AppError::new("QA_REVIEW_CLAIMS", "已审断言必须唯一绑定本次回答和当前引用");
    let source = answer["claims"].as_array().ok_or_else(bad)?;
    let keep = keep_indices.iter().copied().collect::<HashSet<_>>();
    if keep.len() != keep_indices.len()
        || keep
            .iter()
            .any(|index| *index == 0 || *index > source.len())
        || unknowns.len() > 6
        || unknowns.iter().any(|v| {
            v.as_str()
                .is_none_or(|s| s.trim().is_empty() || s.chars().count() > MAX_UNKNOWN_CHARS)
        })
    {
        return Err(bad());
    }
    let context = &answer["context"];
    if keep.is_empty() {
        let mut refused = if desktop {
            crate::assistant_qa::refused(context)
        } else {
            crate::qa::ungrounded(context)
        };
        refused["reviewUnknowns"] = json!(unknowns);
        refused["reviewedClaimIndices"] = json!([]);
        return Ok(refused);
    }
    if !complete && unknowns.is_empty() {
        unknowns.push(json!("仍有必要问题未获完整证据支持。"));
    }
    let mut claims = Vec::new();
    let mut original_indices = Vec::new();
    let mut ids = Vec::new();
    for (index, claim) in source.iter().enumerate() {
        if !keep.contains(&(index + 1)) {
            continue;
        }
        claims.push(claim.clone());
        original_indices.push(
            answer["reviewedClaimIndices"]
                .as_array()
                .and_then(|indices| indices.get(index))
                .and_then(Value::as_u64)
                .unwrap_or((index + 1) as u64),
        );
        for id in claim["citationIds"].as_array().ok_or_else(bad)? {
            if !ids.contains(id) {
                ids.push(id.clone());
            }
        }
    }
    let references = answer["citations"].as_array().ok_or_else(bad)?;
    let raw = json!({"grounded":true,"status":if complete && unknowns.is_empty() {"answered"} else {"partial"},
        "answer":"","citationIds":ids,"claims":claims,"unknowns":unknowns});
    let rendered = if desktop {
        crate::assistant_qa::render_reviewed_output(context, references, raw)?
    } else {
        crate::qa::render_reviewed_output(context, references, raw)?
    };
    let mut retained = answer.clone();
    for (key, value) in rendered.as_object().ok_or_else(bad)? {
        retained[key] = value.clone();
    }
    if !answer["claimValidation"].is_null() {
        retained["claimValidation"] = answer["claimValidation"].clone();
    }
    retained["reviewedClaimIndices"] = json!(original_indices);
    retained["claimReviewSelection"] = json!({"version":"reviewed-claim-subset-v1",
        "inputCount":source.len(),"retainedSourceIndices":original_indices});
    Ok(retained)
}

pub(crate) fn incremental_input(previous: &Value, missing: &[Value]) -> Result<Value> {
    let claims = previous["claims"]
        .as_array()
        .ok_or_else(|| AppError::new("QA_INCREMENTAL_LIMIT", "增量缺少已审断言"))?;
    if claims.is_empty() || claims.len() >= 12 || missing.len() > 6 {
        return Err(AppError::new(
            "QA_INCREMENTAL_LIMIT",
            "增量回答超过断言或必要缺口上限",
        ));
    }
    let verified = claims
        .iter()
        .enumerate()
        .map(|(index, claim)| {
            json!({
        "verifiedClaimId":format!("verified-{}",index+1),"text":claim["text"]})
        })
        .collect::<Vec<_>>();
    Ok(
        json!({"version":"verified-claims-increment-v1","verifiedClaims":verified,"missingAspects":missing,
        "maxNewClaims":12-claims.len(),"evidenceRole":"consistency-and-deduplication-only"}),
    )
}

/// Merge only a previously reviewed base with a newly reviewed increment.
/// Every assertion is re-bound against the union of its actual current
/// citations; conflicting versions or fabricated identities cannot be merged.
pub(crate) fn merge_verified_answers(
    base: &Value,
    addition: &Value,
    context: &Value,
    desktop: bool,
) -> Result<Value> {
    let bad = || AppError::new("QA_INCREMENTAL_MERGE", "增量断言未通过一致性或当前引用校验");
    if base["grounded"] != true
        || addition["grounded"] != true
        || base["qualityReview"]["supported"] != true
        || addition["qualityReview"]["incrementalConsistency"] != true
        || addition["qualityReview"]["protocolValid"] != true
        || addition["qualityReview"]["status"] == "unavailable"
    {
        return Err(bad());
    }
    for field in ["question", "projectId", "date", "asOfDate"] {
        if base["context"][field] != context[field] || addition["context"][field] != context[field]
        {
            return Err(bad());
        }
    }
    let previous = base["claims"].as_array().ok_or_else(bad)?;
    let added = addition["claims"].as_array().ok_or_else(bad)?;
    if previous.is_empty() || added.is_empty() || previous.len() + added.len() > 12 {
        return Err(bad());
    }
    let mut refs = Vec::<Value>::new();
    let id_field = if desktop { "id" } else { "memoryId" };
    for reference in base["citations"]
        .as_array()
        .ok_or_else(bad)?
        .iter()
        .chain(addition["citations"].as_array().ok_or_else(bad)?)
    {
        let id = reference_id(reference, id_field).ok_or_else(bad)?;
        if let Some(existing) = refs
            .iter()
            .find(|known| reference_id(known, id_field) == Some(id))
        {
            if model_reference(existing) != model_reference(reference) {
                return Err(bad());
            }
        } else {
            refs.push(reference.clone());
        }
    }
    if refs.len()
        > if desktop
            && crate::search::Query::new(context["question"].as_str().unwrap_or("")).overview()
        {
            40
        } else {
            32
        }
    {
        return Err(bad());
    }
    let mut claims = Vec::new();
    let mut provenance = Vec::new();
    let mut ids = Vec::new();
    for (slot, source) in [("base", base), ("addition", addition)] {
        for (index, claim) in source["claims"]
            .as_array()
            .ok_or_else(bad)?
            .iter()
            .enumerate()
        {
            if claims.contains(claim) {
                continue;
            }
            claims.push(claim.clone());
            let source_index = source["reviewedClaimIndices"]
                .as_array()
                .and_then(|values| values.get(index))
                .and_then(Value::as_u64)
                .unwrap_or((index + 1) as u64);
            provenance.push(json!({"claimIndex":claims.len(),"generationSlot":slot,
                "sourceClaimIndex":source_index,"text":claim["text"]}));
            for id in claim["citationIds"].as_array().ok_or_else(bad)? {
                if !ids.contains(id) {
                    ids.push(id.clone());
                }
            }
        }
    }
    let unknowns = addition["unknowns"].as_array().ok_or_else(bad)?;
    let complete = addition["qualityReview"]["completeAnswer"] == true && unknowns.is_empty();
    let raw = json!({"grounded":true,"status":if complete {"answered"} else {"partial"},
        "answer":"","citationIds":ids,"claims":claims,"unknowns":unknowns});
    let mut merged = if desktop {
        crate::assistant_qa::render_reviewed_output(context, &refs, raw)?
    } else {
        crate::qa::render_reviewed_output(context, &refs, raw)?
    };
    for key in ["qualityReview", "contextPack", "referenceSelection"] {
        if !addition[key].is_null() {
            merged[key] = addition[key].clone();
        }
    }
    merged["claimProvenance"] = json!(provenance);
    merged["incrementalMerge"] = json!({"version":"reviewed-incremental-claims-v1",
        "baseClaimCount":previous.len(),"addedClaimCount":added.len(),"finalClaimCount":claims.len()});
    Ok(merged)
}

#[cfg(test)]
pub(crate) fn fixture(text: &str, ids: Value, quote: &str) -> Value {
    let anchors = ids
        .as_array()
        .unwrap()
        .iter()
        .map(|id| json!({"citationId":id,"quote":quote}))
        .collect::<Vec<_>>();
    json!({"grounded":true,"answer":"","citationIds":ids,"status":"answered","unknowns":[],"claims":[{"text":text,"citationIds":ids,"supportQuotes":anchors}]})
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reviewed_fixture(desktop: bool, name: &str, body: &str, question: &str) -> Value {
        let memory = json!({"id":format!("memory:{name}"),"memoryId":name,"content":body,
            "projectId":"p","sourceTitle":format!("Source {name}"),"revision":1,
            "facets":{"conditions":["Only offline"]},"evidence":[],"evidenceLabel":"confirmed"});
        let id = if desktop {
            format!("memory:{name}")
        } else {
            name.to_owned()
        };
        let context = json!({"question":question,"projectId":"p","date":"2026-10-23","limitations":[],"memories":[memory]});
        let raw = fixture(body, json!([id]), body);
        let mut answer = if desktop {
            crate::assistant_qa::render_reviewed_output(&context, &[memory], raw).unwrap()
        } else {
            crate::qa::render_reviewed_output(&context, &[memory], raw).unwrap()
        };
        answer["qualityReview"] =
            json!({"supported":true,"completeAnswer":true,"protocolValid":true});
        answer
    }

    #[test]
    fn reviewed_subset_rebuilds_markers_and_preserves_full_scope() {
        for desktop in [false, true] {
            let original = reviewed_fixture(
                desktop,
                "right",
                "Only offline, Atlas retains logs for 45 days.",
                "How long are logs retained?",
            );
            let mut answer = original.clone();
            let mut claims = answer["claims"].as_array().unwrap().clone();
            let mut wrong = claims[0].clone();
            wrong["text"] = json!("A different model has a separate policy.");
            claims.insert(0, wrong);
            answer["claims"] = json!(claims);
            let retained = retain_reviewed_claims(
                &answer,
                &[2],
                vec![json!("The approval role is not recorded.")],
                false,
                desktop,
            )
            .unwrap();
            assert_eq!(retained["claims"].as_array().unwrap().len(), 1);
            assert_eq!(retained["claims"][0], original["claims"][0]);
            assert_eq!(retained["reviewedClaimIndices"], json!([2]));
            assert_eq!(retained["status"], "partial");
            assert!(retained["answer"]
                .as_str()
                .unwrap()
                .contains("Only offline"));
            assert!(!retained["answer"]
                .as_str()
                .unwrap()
                .contains("different model"));
            assert_eq!(retained["citations"], original["citations"]);
            assert!(retain_reviewed_claims(&answer, &[2, 2], vec![], true, desktop).is_err());
            assert!(retain_reviewed_claims(&answer, &[3], vec![], true, desktop).is_err());
            assert_eq!(answer["claims"].as_array().unwrap().len(), 2);
        }
    }

    #[test]
    fn verified_increment_merges_only_explicitly_reviewed_current_facts() {
        for desktop in [false, true] {
            let question = "How long is retention and who approves?";
            let mut base = reviewed_fixture(
                desktop,
                "duration",
                "Only offline, retention is 45 days.",
                question,
            );
            base["qualityReview"]["completeAnswer"] = json!(false);
            let mut added = reviewed_fixture(
                desktop,
                "approval",
                "Only offline, Mei approves retention.",
                question,
            );
            added["qualityReview"]["incrementalConsistency"] = json!(true);
            let merged = merge_verified_answers(&base, &added, &base["context"], desktop).unwrap();
            assert_eq!(merged["claims"].as_array().unwrap().len(), 2);
            assert_eq!(merged["citations"].as_array().unwrap().len(), 2);
            assert_eq!(merged["claimProvenance"][0]["generationSlot"], "base");
            assert_eq!(merged["claimProvenance"][1]["generationSlot"], "addition");
            assert_eq!(merged["claimProvenance"][1]["sourceClaimIndex"], 1);
            assert_eq!(merged["status"], "answered");
            let mut invalid = added.clone();
            invalid["qualityReview"]["protocolValid"] = json!(false);
            assert!(merge_verified_answers(&base, &invalid, &base["context"], desktop).is_err());
            invalid = added.clone();
            invalid["context"]["projectId"] = json!("other");
            assert!(merge_verified_answers(&base, &invalid, &base["context"], desktop).is_err());
            invalid = added.clone();
            invalid["qualityReview"]["incrementalConsistency"] = json!(false);
            assert!(merge_verified_answers(&base, &invalid, &base["context"], desktop).is_err());
            // The same identity cannot smuggle in a different current body or
            // revision when two independently checked packs are combined.
            invalid = base.clone();
            invalid["qualityReview"]["incrementalConsistency"] = json!(true);
            invalid["citations"][0]["revision"] = json!(2);
            assert!(merge_verified_answers(&base, &invalid, &base["context"], desktop).is_err());
            invalid["citations"][0]["revision"] = json!(1);
            invalid["citations"][0]["content"] = json!("Changed current body.");
            assert!(merge_verified_answers(&base, &invalid, &base["context"], desktop).is_err());
        }
    }

    #[test]
    fn increment_inputs_do_not_repeat_bodies_or_accept_a_full_claim_budget() {
        let mut base = reviewed_fixture(
            false,
            "base",
            "Only offline, retention is 45 days.",
            "Retention and approval?",
        );
        base["context"]["memoryCandidatePool"] =
            json!([{"content":"UNRELATED_CONTEXT_DO_NOT_REPEAT"}]);
        let input = incremental_input(&base, &[json!("Who approves?")]).unwrap();
        assert!(!input
            .to_string()
            .contains("UNRELATED_CONTEXT_DO_NOT_REPEAT"));
        assert!(input.get("citations").is_none());
        assert_eq!(input["maxNewClaims"], 11);
        base["claims"] = json!(vec![base["claims"][0].clone(); 12]);
        assert!(incremental_input(&base, &[]).is_err());
    }

    #[test]
    fn current_reference_selection_preserves_original_order_bodies_and_conditions() {
        let references = vec![
            json!({"id":"memory:first","memoryId":"first","content":"Only offline trials use the individual model. The online policy differs.","revision":3,"facets":{"conditions":["Only offline trials"],"role":"operator","validFrom":"2026-10-01"}}),
            json!({"id":"middle","memoryId":"middle","content":"The joint model contains the individual models.","revision":2}),
            json!({"id":"last","memoryId":"last","content":"The individual model is based on a tree method.","revision":4}),
        ];
        let original = references.clone();
        assert_eq!(
            select_current_references(&references, None).unwrap(),
            original
        );
        let selected = select_current_references(
            &references,
            Some(&["memory:last".to_owned(), "first".to_owned()]),
        )
        .unwrap();
        assert_eq!(selected, vec![original[0].clone(), original[2].clone()]);
        assert_eq!(references, original);
        let id_only = vec![json!({"id":"task:current","content":"Complete current task body."})];
        assert_eq!(
            select_current_references(&id_only, Some(&["task:current".to_owned()])).unwrap(),
            id_only
        );
        assert!(
            select_current_references(&id_only, Some(&["memory:task:current".to_owned()])).is_err()
        );
    }

    #[test]
    fn current_reference_selection_fails_missing_ambiguous_duplicate_and_oversized_requests() {
        let refs = vec![json!({"id":"memory:a","memoryId":"a","content":"Complete body."})];
        for selected in [
            vec![],
            vec!["missing".to_owned()],
            vec![" ".to_owned()],
            vec!["a".to_owned(), "a".to_owned()],
            vec!["memory:a".to_owned(), "a".to_owned()],
            (0..7).map(|index| format!("r{index}")).collect(),
        ] {
            assert_eq!(
                select_current_references(&refs, Some(&selected))
                    .unwrap_err()
                    .code,
                "QA_CONTEXT_SELECTION"
            );
        }
        for ambiguous in [
            vec![refs[0].clone(), refs[0].clone()],
            vec![
                json!({"id":"a","memoryId":"one"}),
                json!({"id":"two","memoryId":"a"}),
            ],
            vec![
                json!({"id":"one","memoryId":"a","revision":1}),
                json!({"id":"two","memoryId":"a","revision":2}),
            ],
        ] {
            assert_eq!(
                select_current_references(&ambiguous, Some(&["a".to_owned()]))
                    .unwrap_err()
                    .code,
                "QA_CONTEXT_SELECTION"
            );
        }
        let six = (0..6)
            .map(|index| json!({"id":format!("r{index}"),"content":format!("Full body {index}")}))
            .collect::<Vec<_>>();
        let ids = (0..6)
            .rev()
            .map(|index| format!("r{index}"))
            .collect::<Vec<_>>();
        assert_eq!(select_current_references(&six, Some(&ids)).unwrap(), six);
    }
    fn output() -> Value {
        json!({"grounded":true,"answer":"IGNORED_EXTRA_FACT","citationIds":["m"],"status":"partial","unknowns":["发布是否实际推迟"],"claims":[{"text":"压测尚未启动。","citationIds":["m"],"supportQuotes":[{"citationId":"m","quote":"环境未就绪，压测尚未启动"}]}]})
    }
    #[test]
    fn renders_only_bound_claims_and_preserves_partial_status() {
        let refs = [json!({"id":"m","content":"环境未就绪，压测尚未启动"})];
        let checked = normalize(output(), &refs, "id").unwrap();
        assert!(!checked["answer"].as_str().unwrap().contains("IGNORED"));
        assert_eq!(checked["status"], "partial");
        for field in ["citationId", "quote"] {
            let mut bad = output();
            bad["claims"][0]["supportQuotes"][0][field] = json!("invented");
            assert!(normalize(bad, &refs, "id").is_err());
        }
        let mut bad = output();
        bad["claims"][0]["citationIds"] = json!(["m", "other"]);
        assert!(normalize(bad, &refs, "id").is_err());
    }

    #[test]
    fn model_reference_preserves_current_content_and_keeps_source_material_out_of_prompt() {
        let reference = json!({
            "id":"memory:m","memoryId":"m","content":"审计日志保留30天。",
            "title":"当前日志安排","sourceTitle":"原始评审","kind":"memory","projectId":"p","revision":2,"updatedAt":"2026-10-20",
            "facets":{"entity":"审计日志","topic":"保留30天","conditions":[],"role":"","validFrom":null,"validUntil":null,"evidence":{"text":"OLD_FACET_SOURCE"}},
            "evidence":[{"text":"OLD_SOURCE：保留180天。","locator":"第3行"}],
            "record":{"content":"OLD_RECORD_COPY","facets":{"entity":"旧主体"},"evidence":[{"text":"OLD_NESTED_SOURCE"}]},
            "extra":"OLD_OTHER_METADATA"
        });
        let original = reference.clone();
        let projected = model_reference(&reference);
        for field in [
            "id",
            "memoryId",
            "content",
            "title",
            "sourceTitle",
            "kind",
            "projectId",
            "revision",
            "updatedAt",
        ] {
            assert_eq!(projected[field], reference[field]);
        }
        assert_eq!(projected["facets"]["entity"], "审计日志");
        assert!(projected["facets"].get("evidence").is_none());
        assert!(projected.get("evidence").is_none());
        assert!(projected.get("record").is_none());
        assert!(projected.get("extra").is_none());
        assert!(!projected.to_string().contains("OLD_"));
        assert_eq!(reference, original);
        assert!(reference["evidence"][0]["text"]
            .as_str()
            .unwrap()
            .contains("180天"));
    }

    #[test]
    fn model_reference_uses_record_facets_without_copying_the_record() {
        let reference = json!({"id":"memory:m","kind":"memory","content":"Only enterprise customers retain logs for 30 days.","record":{"facets":{"entity":"enterprise customers","conditions":["Only enterprise customers"],"role":"","topic":"retain logs","validFrom":null,"validUntil":null},"evidence":[{"text":"OLD_SOURCE"}]}});
        let projected = model_reference(&reference);
        assert_eq!(projected["facets"], reference["record"]["facets"]);
        assert_eq!(projected["content"], reference["content"]);
        assert!(projected.get("record").is_none());
        assert!(!projected.to_string().contains("OLD_SOURCE"));
        let task = json!({"id":"task:t","kind":"task","title":"交付接口","content":"交付接口：进行中，进度30%，小王，截止2026-10-21；说明：等待验收","updatedAt":"2026-10-20","record":{"assignee":"小王","dueDate":"2026-10-21"}});
        let projected_task = model_reference(&task);
        assert_eq!(projected_task["content"], task["content"]);
        assert_eq!(projected_task["title"], task["title"]);
        assert!(projected_task.get("record").is_none());
    }

    #[test]
    fn answered_with_explicit_unknowns_is_conservatively_downgraded_after_validation() {
        let refs = [
            json!({"id":"m","content":"Five annotators participated in the trial set of 21 tweets."}),
        ];
        let mut raw = fixture(
            "Five annotators participated in the trial set.",
            json!(["m"]),
            refs[0]["content"].as_str().unwrap(),
        );
        let unknowns =
            json!(["The total number of annotators for the full dataset is not recorded."]);
        raw["unknowns"] = unknowns.clone();
        let expected_claims = raw["claims"].clone();
        let normalized = normalize(raw, &refs, "id").unwrap();
        assert_eq!(normalized["grounded"], true);
        assert_eq!(normalized["status"], "partial");
        assert_eq!(normalized["unknowns"], unknowns);
        assert_eq!(normalized["claims"], expected_claims);
        assert!(normalized["answer"].as_str().unwrap().contains("尚待确认"));
    }

    #[test]
    fn status_downgrade_does_not_bypass_unknown_bounds_or_current_anchor_checks() {
        let refs = [
            json!({"id":"m","content":"审计日志保留30天。","evidence":[{"text":"审计日志保留180天。"}]}),
        ];
        let mut valid = fixture("审计日志保留30天。", json!(["m"]), "审计日志保留30天。");
        valid["unknowns"] = json!(["当前发布是否已完成"]);
        for unknowns in [
            json!([""]),
            json!(["x".repeat(MAX_UNKNOWN_CHARS + 1)]),
            json!(vec!["未记录"; 7]),
        ] {
            let mut bad = valid.clone();
            bad["unknowns"] = unknowns;
            assert!(normalize(bad, &refs, "id").is_err());
        }
        let mut old_source = valid.clone();
        old_source["claims"][0]["supportQuotes"][0]["quote"] = json!("审计日志保留180天。");
        assert!(normalize(old_source, &refs, "id").is_err());
        let mut bad_union = valid.clone();
        bad_union["citationIds"] = json!(["another"]);
        assert!(normalize(bad_union, &refs, "id").is_err());
        let mut bad_claim = valid.clone();
        bad_claim["claims"][0]["text"] = json!("x".repeat(601));
        assert!(normalize(bad_claim, &refs, "id").is_err());
        let mut empty_partial = valid.clone();
        empty_partial["status"] = json!("partial");
        empty_partial["unknowns"] = json!([]);
        assert!(normalize(empty_partial, &refs, "id").is_err());
        let mut unsupported_status = valid;
        unsupported_status["status"] = json!("unknown");
        assert!(normalize(unsupported_status, &refs, "id").is_err());
    }

    #[test]
    fn refusals_are_never_promoted_by_unknowns_and_complete_answers_stay_complete() {
        let refs = [json!({"id":"m","content":"审计日志保留30天。"})];
        let complete = fixture("审计日志保留30天。", json!(["m"]), "审计日志保留30天。");
        assert_eq!(
            normalize(complete.clone(), &refs, "id").unwrap()["status"],
            "answered"
        );
        let mut refusal = complete;
        refusal["grounded"] = json!(false);
        refusal["unknowns"] = json!(["当前发布是否已完成"]);
        let normalized = normalize(refusal, &refs, "id").unwrap();
        assert_eq!(normalized["grounded"], false);
        assert_eq!(normalized["status"], "unknown");
        assert_eq!(normalized["claims"], json!([]));
        assert_eq!(normalized["citationIds"], json!([]));
    }
    fn compact(text: &str, selections: Value) -> Value {
        json!({"grounded":true,"status":"answered","claims":[{"text":text,"supportSpans":selections}],"unknowns":[]})
    }

    #[test]
    fn indexed_spans_cover_current_unicode_text_once_and_keep_long_tail_selectable() {
        let content = format!(
            "{}\n{} END.",
            "界🙂".repeat(380),
            "Atlas policy. ".repeat(60)
        );
        let refs = [
            json!({"id":"memory:m","memoryId":"m","content":content,"title":"Policy","sourceTitle":"Policy",
            "revision":2,"updatedAt":"today","evidence":[{"text":"OLD_SOURCE"}],"record":{"content":"OLD_SOURCE"}}),
        ];
        let indexed = indexed_references(&refs);
        let spans = indexed[0]["content"].as_array().unwrap();
        assert!(spans.len() > 1);
        assert_eq!(
            spans
                .iter()
                .map(|span| span["text"].as_str().unwrap())
                .collect::<String>(),
            content
        );
        for (index, span) in spans.iter().enumerate() {
            assert_eq!(span["spanIndex"], index + 1);
            assert!(span["text"].as_str().unwrap().chars().count() <= MAX_SPAN_CHARS);
        }
        assert!(!indexed[0].to_string().contains("OLD_SOURCE"));
        assert!(indexed[0].get("revision").is_none());
        assert!(indexed[0].get("title").is_none());
        let normalized = normalize(
            compact(
                "The policy ends with END.",
                json!([{"referenceIndex":1,"spanIndex":spans.len()}]),
            ),
            &refs,
            "id",
        )
        .unwrap();
        let quote = normalized["claims"][0]["supportQuotes"][0]["quote"]
            .as_str()
            .unwrap();
        assert!(quote.ends_with(" END."));
        assert!(content.contains(quote));
        assert_ne!(quote, content_spans(&content)[0]);
        assert_eq!(normalized["citationIds"], json!(["memory:m"]));
        assert_eq!(normalized["bindingMode"], "indexed-current-spans-v2");
    }

    #[test]
    fn compact_selection_restores_exact_quote_without_accepting_model_quote_repairs() {
        let content =
            "In the rest, train is composed by the training and the development instances.";
        let refs = [json!({"id":"m","content":content,"evidence":[{"text":"Old dataset facts."}]})];
        let normalized = normalize(
            compact(
                "Train combines the training and development instances.",
                json!([{"referenceIndex":1,"spanIndex":1}]),
            ),
            &refs,
            "id",
        )
        .unwrap();
        assert_eq!(
            normalized["claims"][0]["supportQuotes"][0]["quote"],
            content
        );
        let legacy = fixture(
            "Train combines the training and development instances.",
            json!(["m"]),
            "In the rest, train is composed by the training and development instances.",
        );
        assert!(
            normalize(legacy, &refs, "id").is_err(),
            "legacy exact anchors must still reject the omitted word"
        );
        let mut forged = compact(
            "Train combines the training and development instances.",
            json!([{"referenceIndex":1,"spanIndex":1}]),
        );
        forged["claims"][0]["supportSpans"][0]["quote"] = json!("Old dataset facts.");
        assert!(normalize(forged, &refs, "id").is_err());
    }

    #[test]
    fn compact_indices_are_exact_bounded_unique_and_cannot_mix_legacy_fields() {
        let refs = [json!({"id":"m","content":"Atlas retains logs for 30 days."})];
        for selections in [
            json!([]),
            json!([{"referenceIndex":0,"spanIndex":1}]),
            json!([{"referenceIndex":2,"spanIndex":1}]),
            json!([{"referenceIndex":1,"spanIndex":0}]),
            json!([{"referenceIndex":1,"spanIndex":2}]),
            json!([{"referenceIndex":-1,"spanIndex":1}]),
            json!([{"referenceIndex":1.5,"spanIndex":1}]),
            json!([{"referenceIndex":"1","spanIndex":1}]),
            json!([{"referenceIndex":1,"spanIndex":1},{"referenceIndex":1,"spanIndex":1}]),
        ] {
            assert!(normalize(
                compact("Atlas retains logs for 30 days.", selections),
                &refs,
                "id"
            )
            .is_err());
        }
        let mut mixed = compact(
            "Atlas retains logs for 30 days.",
            json!([{"referenceIndex":1,"spanIndex":1}]),
        );
        mixed["citationIds"] = json!(["m"]);
        assert!(normalize(mixed, &refs, "id").is_err());
        let duplicate = [refs[0].clone(), refs[0].clone()];
        assert!(normalize(
            compact(
                "Atlas retains logs for 30 days.",
                json!([{"referenceIndex":1,"spanIndex":1}])
            ),
            &duplicate,
            "id"
        )
        .is_err());
        let empty = [json!({"id":"m","content":""})];
        assert!(normalize(
            compact("Fact", json!([{"referenceIndex":1,"spanIndex":1}])),
            &empty,
            "id"
        )
        .is_err());
    }

    #[test]
    fn compact_can_combine_multiple_exact_current_spans_and_resolves_citation_union() {
        let refs = [
            json!({"memoryId":"a","content":"Atlas retains logs for 30 days."}),
            json!({"memoryId":"b","content":"Rina approves Atlas exports."}),
        ];
        let mut raw = compact(
            "Atlas retains logs for 30 days.",
            json!([{"referenceIndex":1,"spanIndex":1}]),
        );
        raw["claims"].as_array_mut().unwrap().push(json!({"text":"Rina approves Atlas exports.","supportSpans":[{"referenceIndex":2,"spanIndex":1}]}));
        let normalized = normalize(raw, &refs, "memoryId").unwrap();
        assert_eq!(normalized["citationIds"], json!(["a", "b"]));
        assert_eq!(normalized["claims"][1]["citationIds"], json!(["b"]));
        let mut answer = json!({});
        attach(&mut answer, &normalized);
        assert_eq!(
            answer["claimValidation"]["version"],
            "indexed-current-spans-v2"
        );
        assert_eq!(
            answer["claimValidation"]["semanticSupport"],
            "not_independently_scored"
        );
    }

    #[test]
    fn unknown_presentation_clipping_keeps_full_semantic_review_input_and_conservative_status() {
        let refs = [json!({"id":"m","content":"Atlas retains logs for 30 days."})];
        let unknown = format!(
            "{} The requested approval relation remains unknown.",
            "界🙂".repeat(170)
        );
        let mut raw = compact(
            "Atlas retains logs for 30 days.",
            json!([{"referenceIndex":1,"spanIndex":1}]),
        );
        raw["unknowns"] = json!([unknown]);
        let normalized = normalize(raw.clone(), &refs, "id").unwrap();
        assert_eq!(normalized["unknowns"][0], unknown);
        let mut attached = json!({});
        attach(&mut attached, &normalized);
        assert_eq!(attached["unknowns"][0], unknown);
        assert_eq!(
            attached["unknownsPresentation"],
            normalized["unknownsPresentation"]
        );
        assert_eq!(normalized["status"], "partial");
        let presentation = normalized["unknownsPresentation"][0].as_str().unwrap();
        assert_eq!(presentation.chars().count(), UNKNOWN_PRESENTATION_CHARS);
        assert!(presentation.ends_with('…'));
        assert!(normalized["answer"]
            .as_str()
            .unwrap()
            .contains(presentation));
        assert!(!normalized["answer"]
            .as_str()
            .unwrap()
            .contains("requested approval relation"));
        raw["grounded"] = json!(false);
        let refusal = normalize(raw, &refs, "id").unwrap();
        assert_eq!(refusal["grounded"], false);
        assert_eq!(refusal["status"], "unknown");
        assert_eq!(refusal["claims"], json!([]));
        let mut too_long = compact("Fact", json!([{"referenceIndex":1,"spanIndex":1}]));
        too_long["unknowns"] = json!(["x".repeat(MAX_UNKNOWN_CHARS + 1)]);
        assert!(normalize(too_long, &refs, "id").is_err());
    }

    #[test]
    fn compact_schema_and_outputs_remove_repeated_uuid_and_quote_tokens() {
        let ids = (0..24)
            .map(|i| json!(format!("memory:00000000-0000-0000-0000-{i:012}")))
            .collect::<Vec<_>>();
        assert!(RULES.contains("supportQuotes"));
        let old = schema(ids.clone()).to_string();
        let new = compact_schema(ids.len()).to_string();
        assert!(new.len() < old.len() / 2);
        assert!(!new.contains("citationId"));
        assert!(!new.contains("quote"));
        assert_eq!(
            compact_schema(24)["properties"]["claims"]["items"]["properties"]["supportSpans"]
                ["items"]["properties"]["referenceIndex"]["maximum"],
            24
        );
        let compact = compact(
            "Atlas retains logs for 30 days.",
            json!([{"referenceIndex":1,"spanIndex":1}]),
        );
        let legacy = fixture(
            "Atlas retains logs for 30 days.",
            json!([ids[0]]),
            &"Exact current text. ".repeat(20),
        );
        assert!(compact.to_string().len() < legacy.to_string().len());
    }
    #[test]
    fn compact_refusals_stay_unknown_and_unreadable_current_bodies_never_bind() {
        for reference in [
            json!({"id":"m"}),
            json!({"id":"m","content":""}),
            json!({"id":"m","content":"  \n  "}),
            json!({"id":"m","content":null}),
            json!({"id":"m","content":["old source"]}),
        ] {
            let refs = [reference];
            let mut raw = compact(
                "Unsupported fact",
                json!([{"referenceIndex":1,"spanIndex":1}]),
            );
            assert!(normalize(raw.clone(), &refs, "id").is_err());
            raw["grounded"] = json!(false);
            let safe = normalize(raw, &refs, "id").unwrap();
            assert_eq!(safe["status"], "unknown");
            assert_eq!(safe["grounded"], false);
            assert_eq!(safe["claims"], json!([]));
            assert_eq!(safe["citationIds"], json!([]));
        }
    }
    #[test]
    fn indexed_projection_drops_empty_facets_but_keeps_every_explicit_scope_constraint() {
        let refs = [
            json!({"id":"memory:m","memoryId":"m","projectId":"p","content":"Only enterprise users retain logs for 30 days.",
            "facets":{"entity":"enterprise users","topic":"","role":"","conditions":["Only enterprise users"],"validFrom":null,"validUntil":"2027-01-01"}}),
            json!({"id":"memory:n","projectId":"q","content":"A separate project.","facets":{"entity":"","topic":"","role":"","conditions":[],"validFrom":null,"validUntil":null}}),
        ];
        let projected = indexed_references(&refs);
        assert_eq!(projected[0]["facets"]["entity"], "enterprise users");
        assert_eq!(
            projected[0]["facets"]["conditions"],
            refs[0]["facets"]["conditions"]
        );
        assert_eq!(projected[0]["facets"]["validUntil"], "2027-01-01");
        for empty in ["topic", "role", "validFrom"] {
            assert!(projected[0]["facets"].get(empty).is_none());
        }
        assert!(projected[1].get("facets").is_none());
        assert_eq!(projected[0]["projectId"], "p");
        assert_eq!(projected[1]["projectId"], "q");
        assert_eq!(projected[0]["id"], refs[0]["id"]);
        assert!(projected[0].get("memoryId").is_none());
        assert_eq!(projected[0]["id"], refs[0]["id"]);
    }

    #[test]
    fn indexed_metadata_omits_only_exact_desktop_aliases_and_repeated_common_projects() {
        let refs = [
            json!({"id":"memory:a","memoryId":"a","projectId":"p","content":"First current fact."}),
            json!({"id":"memory:b","memoryId":"b","projectId":"p","content":"Second current fact."}),
            json!({"id":"memory:other","memoryId":"c","projectId":"p","content":"Third current fact."}),
            json!({"id":"d","memoryId":"d","projectId":"p","content":"Fourth current fact."}),
        ];
        let original = refs.clone();
        let projected = indexed_references(&refs);
        assert_eq!(projected[0]["projectId"], "p");
        for item in &projected[1..] {
            assert!(item.get("projectId").is_none());
        }
        assert!(projected[0].get("memoryId").is_none());
        assert!(projected[1].get("memoryId").is_none());
        assert_eq!(projected[2]["memoryId"], "c");
        assert_eq!(projected[3]["memoryId"], "d");
        for (index, item) in projected.iter().enumerate() {
            assert_eq!(item["id"], refs[index]["id"]);
            assert_eq!(item["content"][0]["text"], refs[index]["content"]);
            assert_eq!(item["referenceIndex"], index + 1);
        }
        assert_eq!(refs, original);
        let normalized = normalize(
            compact(
                "Second current fact.",
                json!([
            {"referenceIndex":2,"spanIndex":1}]),
            ),
            &refs,
            "id",
        )
        .unwrap();
        assert_eq!(normalized["citationIds"], json!(["memory:b"]));
        assert_eq!(
            normalized["claims"][0]["supportQuotes"][0]["quote"],
            "Second current fact."
        );
        let mut uncompressed = projected.clone();
        for (index, item) in uncompressed.iter_mut().enumerate() {
            item["memoryId"] = refs[index]["memoryId"].clone();
            item["projectId"] = refs[index]["projectId"].clone();
        }
        assert!(json!(projected).to_string().len() < json!(uncompressed).to_string().len());
    }

    #[test]
    fn indexed_metadata_keeps_each_project_when_scope_is_mixed_missing_or_empty() {
        for projects in [json!(["p", "q"]), json!(["p", null]), json!(["", ""])] {
            let refs = [
                json!({"id":"a","projectId":projects[0],"content":"First fact."}),
                json!({"id":"b","projectId":projects[1],"content":"Second fact."}),
            ];
            let projected = indexed_references(&refs);
            assert_eq!(projected[0]["projectId"], refs[0]["projectId"]);
            assert_eq!(projected[1]["projectId"], refs[1]["projectId"]);
        }
        let refs = [
            json!({"id":"a","projectId":"p","content":"First fact."}),
            json!({"id":"b","content":"Second fact."}),
        ];
        let projected = indexed_references(&refs);
        assert_eq!(projected[0]["projectId"], "p");
        assert_eq!(projected[1]["projectId"], Value::Null);
    }

    #[test]
    fn indexed_source_title_inheritance_requires_exact_source_and_project_equality() {
        let refs = [
            json!({"id":"a","projectId":"p","title":"Policy","sourceTitle":"Policy","content":"First fact."}),
            json!({"id":"b","projectId":"p","title":"Current arrangement","sourceTitle":"Policy","content":"Second fact.",
                "facets":{"entity":"Atlas","conditions":["enterprise only"],"validUntil":"2027-01-01"}}),
        ];
        let original = refs.clone();
        let projected = indexed_references(&refs);
        assert_eq!(projected[0]["sourceTitle"], "Policy");
        assert!(projected[0].get("title").is_none());
        assert!(projected[1].get("sourceTitle").is_none());
        assert_eq!(projected[1]["title"], "Current arrangement");
        assert_eq!(projected[1]["facets"], refs[1]["facets"]);
        assert_eq!(projected[1]["content"][0]["text"], "Second fact.");
        assert_eq!(refs, original);
        let mut repeated = projected.clone();
        repeated[1]["sourceTitle"] = refs[1]["sourceTitle"].clone();
        assert!(json!(projected).to_string().len() < json!(repeated).to_string().len());

        for (field, value) in [
            ("projectId", json!("q")),
            ("projectId", Value::Null),
            ("sourceTitle", json!("Other policy")),
            ("sourceTitle", json!(" Policy")),
            ("sourceTitle", json!("")),
            ("sourceTitle", Value::Null),
        ] {
            let mut changed = refs.clone();
            changed[1][field] = value;
            let projected = indexed_references(&changed);
            assert_eq!(projected[0]["sourceTitle"], changed[0]["sourceTitle"]);
            assert_eq!(projected[1]["sourceTitle"], changed[1]["sourceTitle"]);
        }
    }

    #[test]
    fn originally_missing_metadata_is_explicit_null_and_never_inherits_by_accident() {
        let refs = [
            json!({"id":"a","projectId":"p","sourceTitle":"Policy","content":"First fact."}),
            json!({"id":"b","content":"Second fact."}),
        ];
        let projected = indexed_references(&refs);
        assert_eq!(projected[0]["projectId"], "p");
        assert_eq!(projected[0]["sourceTitle"], "Policy");
        assert_eq!(projected[1].get("projectId"), Some(&Value::Null));
        assert_eq!(projected[1].get("sourceTitle"), Some(&Value::Null));
        let mut missing_title = refs.clone();
        missing_title[1]["projectId"] = json!("p");
        let projected = indexed_references(&missing_title);
        assert!(projected[1].get("projectId").is_none());
        assert_eq!(projected[1].get("sourceTitle"), Some(&Value::Null));
        for item in &projected {
            assert!(item["content"][0]["text"].is_string());
        }
    }
}
