//! Question coverage and source-chain diversity within a bounded model pack.
//!
//! All inputs are already current, eligible references. Selection copies whole
//! references, never merges subjects, removes conditions or clips bodies. Link
//! metadata is navigation only and is not sent by the answer projection.
use crate::{answer_contract, search::Query};
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashSet};

const MAX_CANDIDATES: usize = 64;
const MAX_REFERENCES: usize = 24;
const MAX_MODEL_CHARS: usize = 36_000;

pub(crate) struct Pack {
    pub references: Vec<Value>,
    pub trace: Value,
}

#[derive(Clone, Copy)]
struct Relation {
    name: &'static str,
    question: &'static [&'static str],
    evidence: &'static [&'static str],
}

// These are lexical navigation facets, never required answer obligations.
// Keeping them separate prevents a mechanism question from manufacturing an
// unknown about a dimension, batching policy or optimization detail.
const RELATIONS: &[Relation] = &[
    Relation {
        name: "composition",
        question: &[
            "architecture",
            "component",
            "composition",
            "consist",
            "structure",
            "架构",
            "组成",
            "组件",
        ],
        evidence: &[
            "consist",
            "compris",
            "component",
            "contains",
            "architecture",
            "结构",
            "组成",
            "包含",
        ],
    },
    Relation {
        name: "data",
        question: &[
            "data",
            "dataset",
            "corpus",
            "corpora",
            "training set",
            "语料",
            "数据",
            "训练集",
        ],
        evidence: &[
            "data",
            "dataset",
            "corpus",
            "corpora",
            "collected",
            "obtained",
            "sample",
            "数据",
            "语料",
            "采集",
            "收集",
        ],
    },
    Relation {
        name: "method",
        question: &[
            "how",
            "mechanism",
            "method",
            "process",
            "如何",
            "怎么",
            "机制",
            "方法",
            "流程",
        ],
        evidence: &[
            "uses",
            "apply",
            "computed",
            "calculated",
            "process",
            "encode",
            "initialize",
            "select",
            "initializ",
            "步骤",
            "处理",
            "使用",
            "计算",
            "初始化",
            "选择",
        ],
    },
    Relation {
        name: "ordering",
        question: &[
            "sequence",
            "sequential",
            "order",
            "chronological",
            "时序",
            "顺序",
        ],
        evidence: &[
            "sequence",
            "sequential",
            "order",
            "previous",
            "preceding",
            "initializ",
            "context",
            "first",
            "then",
            "时序",
            "顺序",
            "上下文",
            "初始化",
            "之后",
        ],
    },
    Relation {
        name: "quantity",
        question: &[
            "how many", "how much", "number", "size", "多少", "数量", "规模", "人数",
        ],
        evidence: &[
            "total",
            "number",
            "size",
            "count",
            "annotator",
            "participant",
            "数量",
            "总共",
            "共有",
            "名",
            "人",
        ],
    },
    Relation {
        name: "comparison",
        question: &[
            "compare",
            "comparison",
            "difference",
            "baseline",
            "improve",
            "benefit",
            "比较",
            "区别",
            "基线",
            "提升",
            "效果",
        ],
        evidence: &[
            "compare",
            "baseline",
            "improve",
            "significant",
            "better",
            "benefit",
            "lower",
            "higher",
            "difference",
            "比较",
            "基线",
            "改善",
            "提升",
            "显著",
            "差异",
        ],
    },
    Relation {
        name: "sharing",
        question: &["shared", "share", "sharing", "共享"],
        evidence: &[
            "shared",
            "share",
            "sharing",
            "independent",
            "separate",
            "共享",
            "独立",
            "分别",
        ],
    },
];

fn contains_cue(text: &str, cue: &str) -> bool {
    if !cue.is_ascii() {
        return text.contains(cue);
    }
    text.match_indices(cue).any(|(offset, _)| {
        let start = offset == 0
            || text[..offset]
                .chars()
                .next_back()
                .is_none_or(|character| !character.is_alphanumeric());
        // Prefixes deliberately cover morphology (e.g. initialization).
        start
    })
}

fn tokens(text: &str) -> BTreeSet<String> {
    crate::search::index_tokens(text)
        .into_iter()
        .filter(|token| token.chars().count() > 1 && !token.chars().all(char::is_numeric))
        .collect()
}

fn backing(reference: &Value) -> &Value {
    reference.get("record").unwrap_or(reference)
}

fn links(reference: &Value) -> Option<&Value> {
    let record = backing(reference);
    let links = record.get("navigationLinks")?;
    // A full-body hash may describe an original, explicitly truncated body.
    // The matching current revision is still required, and literal witnesses
    // are independently required to remain inside the model-visible content.
    (links["revisionId"] == record["revisionId"]
        && !links["revisionId"].is_null()
        && links["contentHash"] == record["contentHash"]
        && links["evidenceRole"] == "navigation-only")
        .then_some(links)
}

fn id(reference: &Value) -> String {
    reference["id"]
        .as_str()
        .or_else(|| reference["memoryId"].as_str())
        .unwrap_or("")
        .to_owned()
}

fn model_chars(references: &[Value]) -> usize {
    // Count the final projection, including its array and all reference/span
    // indexes; a very long condition can never slip past a body-only estimate.
    json!(answer_contract::indexed_references(references))
        .to_string()
        .chars()
        .count()
}

fn source_distance(a: &Value, b: &Value) -> Option<u64> {
    let a_links = links(a)?;
    let b_links = links(b)?;
    if a["projectId"] != b["projectId"] {
        return None;
    }
    a_links["sourcePositions"]
        .as_array()?
        .iter()
        .flat_map(|a| {
            b_links["sourcePositions"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(move |b| a["sourceId"] == b["sourceId"])
                .filter_map(move |b| Some(a["ordinal"].as_i64()?.abs_diff(b["ordinal"].as_i64()?)))
        })
        .filter(|distance| *distance <= 1)
        .min()
}

fn literal_connection(a: &Value, b: &Value) -> bool {
    let body_a = a["content"].as_str().unwrap_or("");
    let body_b = b["content"].as_str().unwrap_or("");
    if a["projectId"] != b["projectId"] {
        return false;
    }
    [a, b].into_iter().enumerate().any(|(index, reference)| {
        let Some(links) = links(reference) else {
            return false;
        };
        let other = if index == 0 { b } else { a };
        let own_body = if index == 0 { body_a } else { body_b };
        let other_body = if index == 0 { body_b } else { body_a };
        let entity = backing(other)["facets"]["entity"].as_str().unwrap_or("");
        if entity.is_empty()
            || !crate::search::specific_entity(entity)
            || !other_body.contains(entity)
        {
            return false;
        }
        links["literalRelations"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|relation| {
                relation["revisionId"] == backing(reference)["revisionId"]
                    && relation["contentHash"] == backing(reference)["contentHash"]
                    && relation["witness"]
                        .as_str()
                        .is_some_and(|witness| own_body.contains(witness))
                    && ["subject", "object"]
                        .iter()
                        .any(|field| relation[field].as_str() == Some(entity))
            })
    })
}

fn section_navigation_order(question: &Query, candidates: &[&Value]) -> Vec<usize> {
    if !crate::memory_query::survey_question(question) {
        return Vec::new();
    }
    let mut directory = None;
    let mut groups = std::collections::BTreeMap::<(u64, String), Vec<(usize, usize)>>::new();
    for (index, reference) in candidates.iter().enumerate() {
        let Some(links) = links(reference) else {
            continue;
        };
        let group = &links["sectionGroup"];
        if group["navigationOnly"] != true
            || group["revisionId"] != backing(reference)["revisionId"]
            || !links["sourcePositions"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|position| {
                    position["sourceId"] == group["sourceId"]
                        && position["ordinal"] == group["ordinal"]
                })
        {
            continue;
        }
        if group["role"] == "directory" {
            directory.get_or_insert(index);
        } else if let (Some(sequence), Some(id)) =
            (group["sequenceIndex"].as_u64(), group["groupId"].as_str())
        {
            if sequence < 4 {
                groups
                    .entry((sequence, id.to_owned()))
                    .or_default()
                    .push((usize::from(group["role"] != "head"), index));
            }
        }
    }
    let mut order = directory.into_iter().collect::<Vec<_>>();
    for mut group in groups.into_values().take(4) {
        group.sort_unstable();
        order.extend(group.into_iter().take(2).map(|(_, index)| index));
    }
    order
}

fn polarity(body: &str) -> BTreeSet<&'static str> {
    let lower = body.to_lowercase();
    let mut flags = BTreeSet::new();
    for (name, cues) in [
        (
            "negative",
            &["not ", "no ", "never ", "without ", "不", "未", "禁止"][..],
        ),
        (
            "conditional",
            &[
                "if ", "only ", "unless ", "when ", "条件", "仅", "如果", "除非",
            ][..],
        ),
    ] {
        if cues.iter().any(|cue| lower.contains(cue)) {
            flags.insert(name);
        }
    }
    flags
}

fn quantities(body: &str) -> Vec<String> {
    body.split(|character: char| !character.is_numeric() && character != '.')
        .filter(|part| part.chars().any(char::is_numeric))
        .map(str::to_owned)
        .collect()
}

/// Choose from at most 64 local candidates and preserve every selected value
/// byte-for-byte. Protect the leading question matches in the ranked input;
/// use the remaining budget for coverage and bounded source context.
pub(crate) fn select(
    question: &str,
    references: &[Value],
    max_references: usize,
    max_model_chars: usize,
) -> Pack {
    select_with_sizing::<false>(question, references, max_references, max_model_chars)
}

// The eager instantiation exists only in tests, as a deterministic reference
// for the original selection algorithm. Production sizes only the best-scored
// candidate, then retries without it if the exact indexed projection is full.
fn select_with_sizing<const EAGER: bool>(
    question: &str,
    references: &[Value],
    max_references: usize,
    max_model_chars: usize,
) -> Pack {
    let max_references = max_references.min(MAX_REFERENCES);
    let max_model_chars = max_model_chars.min(MAX_MODEL_CHARS);
    let candidates = references.iter().take(MAX_CANDIDATES).collect::<Vec<_>>();
    let resource_profile = crate::memory_links::current_resource_profile(question, references);
    let preferred_anchor =
        resource_profile["preferredReferenceId"]
            .as_str()
            .and_then(|preferred| {
                candidates
                    .iter()
                    .position(|reference| id(reference) == preferred)
            });
    let question_query = Query::new(question);
    let section_order = section_navigation_order(&question_query, &candidates);
    let question_tokens = tokens(question);
    let lower = question.to_lowercase();
    let asked = RELATIONS
        .iter()
        .filter(|relation| {
            relation
                .question
                .iter()
                .any(|cue| contains_cue(&lower, cue))
        })
        .collect::<Vec<_>>();
    let bodies = candidates
        .iter()
        .map(|reference| reference["content"].as_str().unwrap_or("").to_lowercase())
        .collect::<Vec<_>>();
    let features = bodies.iter().map(|body| tokens(body)).collect::<Vec<_>>();
    let polarities = bodies.iter().map(|body| polarity(body)).collect::<Vec<_>>();
    let quantities = bodies
        .iter()
        .map(|body| quantities(body))
        .collect::<Vec<_>>();
    let query_matches = bodies
        .iter()
        .map(|body| question_query.score("", body) > 0)
        .collect::<Vec<_>>();
    // Coverage bonuses are not relevance scores: a dense source chain can
    // otherwise replace every directly relevant fact except the first one.
    // Reserve half the reference slots for the ranked question matches while
    // retaining room for complementary facts and validated section groups.
    let ranked_anchor_limit = max_references / 2;
    let mut ranked_anchor_ids = HashSet::new();
    let ranked_anchors = (0..candidates.len())
        .filter(|index| {
            if !query_matches[*index] {
                return false;
            }
            let reference_id = id(candidates[*index]);
            reference_id.is_empty() || ranked_anchor_ids.insert(reference_id)
        })
        .take(ranked_anchor_limit)
        .collect::<Vec<_>>();
    // Navigation can be seeded by independently relevant evidence, not by
    // another context-only selection. This keeps proximity one hop deep.
    let navigation_anchors = query_matches
        .iter()
        .enumerate()
        .map(|(index, matches)| *matches || Some(index) == preferred_anchor)
        .collect::<Vec<_>>();
    let matched_tokens = features
        .iter()
        .map(|body| {
            body.intersection(&question_tokens)
                .cloned()
                .collect::<BTreeSet<_>>()
        })
        .collect::<Vec<_>>();
    let relation_matches = bodies
        .iter()
        .map(|body| {
            asked
                .iter()
                .enumerate()
                .filter(|(_, relation)| relation.evidence.iter().any(|cue| contains_cue(body, cue)))
                .map(|(index, _)| index)
                .collect::<BTreeSet<_>>()
        })
        .collect::<Vec<_>>();
    let mut selected = Vec::new();
    let mut selected_indexes = Vec::new();
    let mut selected_ids = HashSet::new();
    let mut covered_tokens = BTreeSet::new();
    let mut covered_relations = BTreeSet::new();
    let mut reasons = Vec::new();
    let mut rejected_for_size = HashSet::new();
    let mut skipped_duplicate_ids = BTreeSet::new();
    let mut exact_size_checks = 0usize;
    let mut current_model_chars = 2usize; // The unchanged empty JSON array.
    let mut nearest_source = vec![None::<u64>; candidates.len()];
    let mut literal_connections = vec![false; candidates.len()];
    let mut repetitions = vec![0.0_f64; candidates.len()];
    while selected.len() < max_references {
        let mut best: Option<(usize, f64, Vec<&'static str>, Option<usize>)> = None;
        let order = if selected.is_empty() {
            preferred_anchor
                .into_iter()
                .chain((0..candidates.len()).filter(|index| Some(*index) != preferred_anchor))
                .collect::<Vec<_>>()
        } else {
            section_order
                .iter()
                .copied()
                .chain(
                    ranked_anchors
                        .iter()
                        .copied()
                        .filter(|index| !section_order.contains(index)),
                )
                .chain((0..candidates.len()).filter(|index| {
                    !section_order.contains(index) && !ranked_anchors.contains(index)
                }))
                .collect::<Vec<_>>()
        };
        for index in order {
            let reference = &candidates[index];
            let reference_id = id(reference);
            if selected_indexes.contains(&index) || rejected_for_size.contains(&index) {
                continue;
            }
            if !reference_id.is_empty() && selected_ids.contains(&reference_id) {
                skipped_duplicate_ids.insert(reference_id);
                continue;
            }
            let eager_size = if EAGER {
                let mut trial = selected.clone();
                trial.push((*reference).clone());
                exact_size_checks += 1;
                let size = model_chars(&trial);
                if size > max_model_chars {
                    rejected_for_size.insert(index);
                    continue;
                }
                Some(size)
            } else {
                None
            };
            // The shared ranker already combines aliases, morphology and
            // source navigation. Keep its first fitting result as the anchor:
            // raw token coverage must not displace a correct translated match
            // with an incidental same-language sentence or a common title.
            if selected.is_empty() {
                best = Some((
                    index,
                    f64::INFINITY,
                    vec![if Some(index) == preferred_anchor {
                        "unique_current_resource_anchor"
                    } else {
                        "first_fitting_ranked_anchor"
                    }],
                    eager_size,
                ));
                break;
            }
            if section_order.contains(&index) {
                best = Some((
                    index,
                    f64::INFINITY,
                    vec!["bounded_section_group_navigation"],
                    eager_size,
                ));
                break;
            }
            if ranked_anchors.contains(&index) {
                best = Some((
                    index,
                    f64::INFINITY,
                    vec!["protected_ranked_question_match"],
                    eager_size,
                ));
                break;
            }
            let new_tokens = matched_tokens[index].difference(&covered_tokens).count();
            let new_relations = relation_matches[index]
                .difference(&covered_relations)
                .count();
            let mut why = vec!["ranked_candidate"];
            let mut score = 90.0 / (index + 4) as f64;
            // Purely structural neighbors remain useful for narrative methods;
            // source proximity by itself never claims question coverage.
            let distance = if EAGER {
                selected_indexes
                    .iter()
                    .filter(|chosen| navigation_anchors[**chosen])
                    .filter_map(|chosen| source_distance(candidates[*chosen], reference))
                    .min()
            } else {
                nearest_source[index]
            };
            let explicit_link = if EAGER {
                selected_indexes
                    .iter()
                    .filter(|chosen| navigation_anchors[**chosen])
                    .any(|chosen| literal_connection(candidates[*chosen], reference))
            } else {
                literal_connections[index]
            };
            if new_tokens > 0 {
                score += 14.0 * new_tokens.min(4) as f64;
                why.push("new_question_terms");
            }
            if new_relations > 0 && (query_matches[index] || distance.is_some()) {
                score += 18.0 * new_relations as f64;
                why.push("question_relation_navigation");
            }
            if let Some(distance) = distance {
                score += if distance == 0 { 6.0 } else { 3.0 };
                why.push("current_source_chain");
            }
            if explicit_link {
                score += 9.0;
                why.push("literal_relation_navigation");
            }
            // Penalize repeated phrasing only when polarity AND all applicability
            // facets match. Opposite statements or differing conditions must
            // remain candidates for explicit conflict/qualification review.
            let repetition = if EAGER {
                selected_indexes
                    .iter()
                    .filter(|other| {
                        let other = **other;
                        backing(candidates[other])["facets"] == backing(reference)["facets"]
                            && candidates[other]["projectId"] == reference["projectId"]
                            && polarities[other] == polarities[index]
                            && quantities[other] == quantities[index]
                    })
                    .map(|other| {
                        let common = features[*other].intersection(&features[index]).count();
                        let total = features[*other].union(&features[index]).count();
                        if total == 0 {
                            0.0
                        } else {
                            common as f64 / total as f64
                        }
                    })
                    .fold(0.0, f64::max)
            } else {
                repetitions[index]
            };
            if repetition > 0.7 {
                score -= 18.0 * repetition;
                why.push("repeated_wording_penalty");
            }
            // Equal scores keep the existing stable retrieval order.
            if best
                .as_ref()
                .is_none_or(|(_, previous, _, _)| score > *previous)
            {
                best = Some((index, score, why, eager_size));
            }
        }
        let Some((index, _, why, eager_size)) = best else {
            break;
        };
        let reference = candidates[index];
        let size = eager_size.unwrap_or_else(|| {
            let mut trial = selected.clone();
            trial.push(reference.clone());
            exact_size_checks += 1;
            model_chars(&trial)
        });
        if size > max_model_chars {
            rejected_for_size.insert(index);
            continue;
        }
        covered_tokens.extend(matched_tokens[index].iter().cloned());
        covered_relations.extend(relation_matches[index].iter().copied());
        selected_indexes.push(index);
        selected_ids.insert(id(reference));
        selected.push(reference.clone());
        current_model_chars = size;
        if !EAGER {
            // Each selected/candidate pair is evaluated once. Taking a minimum,
            // any-match and maximum is exactly the original per-round fold;
            // no relationship or applicability rule is approximated.
            for (other, candidate) in candidates.iter().enumerate() {
                if selected_indexes.contains(&other) || rejected_for_size.contains(&other) {
                    continue;
                }
                if navigation_anchors[index] {
                    if let Some(distance) = source_distance(reference, candidate) {
                        nearest_source[other] =
                            Some(nearest_source[other].map_or(distance, |old| old.min(distance)));
                    }
                    literal_connections[other] |= literal_connection(reference, candidate);
                }
                if backing(reference)["facets"] == backing(candidate)["facets"]
                    && reference["projectId"] == candidate["projectId"]
                    && polarities[index] == polarities[other]
                    && quantities[index] == quantities[other]
                {
                    let common = features[index].intersection(&features[other]).count();
                    let total = features[index].union(&features[other]).count();
                    let similarity = if total == 0 {
                        0.0
                    } else {
                        common as f64 / total as f64
                    };
                    repetitions[other] = repetitions[other].max(similarity);
                }
            }
        }
        reasons.push(
            json!({"id":id(reference),"candidateRank":index+1,"reasons":why,
            "packModelCharsAfter":size}),
        );
    }
    let provenance = selected
        .iter()
        .filter_map(|reference| {
            links(reference).map(|links| {
                json!({"id":id(reference),
            "revisionId":links["revisionId"],"sourcePositions":links["sourcePositions"],
            "literalRelations":links["literalRelations"],"evidenceRole":"navigation-only"})
            })
        })
        .collect::<Vec<_>>();
    let trace = json!({"version":"question-coverage-pack-v2-ranked-anchors","candidateCount":candidates.len(),
        "candidateInputCount":references.len(),"candidateLimit":MAX_CANDIDATES,
        "maxReferences":max_references,"maxModelChars":max_model_chars,
        "selectedCount":selected.len(),"selectedIds":selected.iter().map(id).collect::<Vec<_>>(),
        "modelChars":current_model_chars,"selection":reasons,
        "sizingMode":if EAGER {"eager-reference-test-only"} else {"score-then-exact-projection"},
        "exactSizeChecks":exact_size_checks,
        "currentResourceProfile":resource_profile,
        "rankProtection":{"maxReferences":ranked_anchor_limit,
            "priorityIds":ranked_anchors.iter().map(|index|id(candidates[*index])).collect::<Vec<_>>(),
            "selectedIds":ranked_anchors.iter().filter(|index|selected_indexes.contains(index))
                .map(|index|id(candidates[*index])).collect::<Vec<_>>(),
            "remainder":"question-coverage-and-source-diversity"},
        "sourceNavigation":{"anchorIds":selected_indexes.iter().filter(|index|navigation_anchors[**index])
                .map(|index|id(candidates[*index])).collect::<Vec<_>>(),
            "maxDistance":1,"contextOnlyReferencesCanSeedNavigation":false},
        "sectionGroupNavigation":{"priorityIds":section_order.iter().map(|index|id(candidates[*index])).collect::<Vec<_>>(),
            "maxGroups":4,"maxFactsPerGroup":2,"maxDirectoryFacts":1,"navigationOnly":true,"identityInferred":false},
        "questionTermCoverage":{"matched":covered_tokens,"availableQuestionTerms":question_tokens},
        "questionRelationCoverage":asked.iter().enumerate().map(|(index,relation)|json!({
            "relation":relation.name,"navigationSignalPresent":covered_relations.contains(&index),
            "selectedIds":selected_indexes.iter().filter(|selected|relation_matches[**selected].contains(&index))
                .map(|selected|id(candidates[*selected])).collect::<Vec<_>>()
        })).collect::<Vec<_>>(),
        "coverageIsAnswerProof":false,"provenanceLinks":provenance,
        "skippedForSize":rejected_for_size.len(),"duplicateIdsSkipped":skipped_duplicate_ids,
        "wholeReferences":true,"identityInference":false});
    Pack {
        references: selected,
        trace,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reference(id: &str, body: &str) -> Value {
        json!({"id":id,"memoryId":id,"projectId":"p","revision":1,"revisionId":format!("{id}-r1"),
            "content":body,"contentHash":crate::hash(body.as_bytes()),"facets":{},"sourceTitle":"source"})
    }

    fn position(reference: &mut Value, source: &str, ordinal: usize) {
        reference["navigationLinks"] = json!({"revisionId":reference["revisionId"],
            "contentHash":reference["contentHash"],"evidenceRole":"navigation-only",
            "sourcePositions":[{"sourceId":source,"segmentId":format!("{source}-{ordinal}"),"ordinal":ordinal}],
            "literalRelations":[]});
    }

    #[test]
    fn ranked_direct_fact_survives_a_dense_chain_of_lower_ranked_context() {
        let mut references = (0..48)
            .map(|number| {
                let mut value = reference(
                    &format!("configuration-{number}"),
                    &format!(
                        "The service storage engine policy covers configuration option {number}."
                    ),
                );
                position(&mut value, "manual", 0);
                value
            })
            .collect::<Vec<_>>();
        let mut answer = reference(
            "production-stores",
            "The service stores production records in BirchDB and CanyonDB.",
        );
        position(&mut answer, "manual", 100);
        references[9] = answer.clone();
        let original = references.clone();
        let pack = select(
            "Which storage engines are used by the service?",
            &references,
            24,
            36_000,
        );
        assert!(pack.references.contains(&answer));
        assert_eq!(pack.references.len(), 24);
        assert_eq!(pack.trace["rankProtection"]["maxReferences"], 12);
        assert!(pack.trace["selection"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| {
                row["id"] == "production-stores"
                    && row["reasons"] == json!(["protected_ranked_question_match"])
            }));
        assert_eq!(references, original);
        assert_same_selection(
            "Which storage engines are used by the service?",
            &references,
            24,
            36_000,
        );
    }

    #[test]
    fn source_context_does_not_promote_a_second_hop_without_a_question_match() {
        let mut anchor = reference("anchor", "Falcon access policy.");
        let mut bridge = reference("bridge", "Only signed requests pass.");
        let mut distant = reference("distant", "A maintenance window follows.");
        for (ordinal, row) in [&mut anchor, &mut bridge, &mut distant]
            .into_iter()
            .enumerate()
        {
            position(row, "manual", ordinal);
        }
        let pack = select("Falcon access", &[anchor, bridge, distant], 24, 36_000);
        let distant = pack.trace["selection"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["id"] == "distant")
            .unwrap();
        assert!(!distant["reasons"]
            .as_array()
            .unwrap()
            .iter()
            .any(|reason| reason == "current_source_chain"));
        assert_eq!(
            pack.trace["sourceNavigation"]["anchorIds"],
            json!(["anchor"])
        );
    }

    #[test]
    fn coverage_can_reach_a_method_step_beyond_old_first_twenty_four() {
        let mut candidates = (0..40)
            .map(|number| {
                reference(
                    &format!("repeat{number}"),
                    &format!("Atlas sequential encoder has model configuration {number}."),
                )
            })
            .collect::<Vec<_>>();
        let mut definition = reference("later-definition", "The initial context is set to the preceding sentence state, then each sentence is processed in order.");
        position(&mut candidates[0], "paper", 0);
        position(&mut definition, "paper", 1);
        candidates[32] = definition.clone();
        let pack = select(
            "How does Atlas process sentences sequentially?",
            &candidates,
            24,
            36_000,
        );
        assert!(pack.references.contains(&definition));
        assert!(pack.trace["selection"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["id"] == "later-definition"));
        assert_eq!(candidates[32], definition);
    }

    #[test]
    fn lexical_alias_anchor_precedes_incidental_same_language_words_or_title() {
        let english = reference("english", "Audit logs are retained for 90 days.");
        let mut title_only = reference("title-only", "The office has green chairs.");
        title_only["sourceTitle"] = json!("登录审计日志保留多久");
        let candidates = vec![
            english.clone(),
            reference("incidental", "登录审计在十月交付，日志页面另行排期。"),
            title_only,
        ];
        let pack = select("登录审计日志保留多久？", &candidates, 2, 36_000);
        assert_eq!(pack.references[0], english);
        assert_eq!(
            pack.trace["selection"][0]["reasons"][0],
            "first_fitting_ranked_anchor"
        );
        assert!(!pack
            .references
            .iter()
            .any(|record| record["id"] == "title-only"));
    }

    #[test]
    fn a_unique_explicit_current_resource_can_precede_a_background_lexical_anchor() {
        let prior = reference(
            "prior",
            "Prior work evaluated German posts for offensive language.",
        );
        let current=reference("current","Using this annotation model, we create a new dataset of Polish posts. It covers only archived reports.");
        let references = vec![prior.clone(), current.clone()];
        let pack = select("In what language are the posts?", &references, 24, 36_000);
        assert_eq!(pack.references[0], current);
        assert!(pack.references.contains(&prior));
        assert_eq!(
            pack.trace["selection"][0]["reasons"][0],
            "unique_current_resource_anchor"
        );
        assert_same_selection("In what language are the posts?", &references, 24, 36_000);
    }

    #[test]
    fn ambiguous_current_resources_keep_the_original_anchor_and_all_current_options() {
        let references = vec![
            reference("prior", "Prior work evaluated German posts."),
            reference("one", "We create a dataset of Polish posts."),
            reference("two", "We introduce a dataset of French posts."),
        ];
        let pack = select("In what language are the posts?", &references, 24, 36_000);
        assert_eq!(pack.references[0], references[0]);
        assert_eq!(
            pack.trace["currentResourceProfile"]["mode"],
            "ambiguous-current-resources"
        );
        assert!(references
            .iter()
            .all(|reference| pack.references.contains(reference)));
    }

    #[test]
    fn selected_references_preserve_conditions_negation_and_complete_value() {
        let mut conditional = reference(
            "conditional",
            "Atlas uses 32 cases only for archived reports, unless the review is pending.",
        );
        conditional["facets"] =
            json!({"conditions":["only for archived reports"],"validFrom":"2026-01-01"});
        conditional["evidence"] = json!([{"text":"DISPLAY SOURCE MUST STAY"}]);
        let candidates = vec![
            reference("negative", "Atlas does not share its decoder weights."),
            conditional.clone(),
        ];
        let pack = select(
            "Does Atlas share weights and how many archived cases are used?",
            &candidates,
            24,
            36_000,
        );
        assert!(pack.references.contains(&conditional));
        assert!(pack.references.contains(&candidates[0]));
        for selected in &pack.references {
            assert!(candidates.contains(selected));
        }
    }

    #[test]
    fn repetition_penalty_does_not_hide_an_opposite_or_different_quantity() {
        for alternate in [
            "Atlas uses 64 samples for evaluation.",
            "Atlas does not use 32 samples for evaluation.",
        ] {
            let candidates = vec![
                reference("first", "Atlas uses 32 samples for evaluation."),
                reference("duplicate-wording", "Atlas uses 32 samples for evaluation."),
                reference("different", alternate),
            ];
            let pack = select(
                "How many Atlas evaluation samples are used?",
                &candidates,
                2,
                36_000,
            );
            assert!(
                pack.references
                    .iter()
                    .any(|reference| reference["id"] == "different"),
                "{alternate}"
            );
        }
    }

    #[test]
    fn full_indexed_projection_including_conditions_obeys_character_limit() {
        let mut large = reference("large", "Short body.");
        large["facets"] = json!({"conditions":["x".repeat(3_000)]});
        let small = reference("small", "A short useful Atlas method.");
        let pack = select("Atlas method", &[large, small.clone()], 24, 900);
        assert_eq!(pack.references, vec![small]);
        assert!(pack.trace["modelChars"].as_u64().unwrap() <= 900);
        assert_eq!(pack.trace["skippedForSize"], 1);
    }

    #[test]
    fn hard_limits_and_deduplication_apply_without_clipping() {
        let candidates = (0..100)
            .map(|n| reference(&format!("id{n}"), &format!("Unique Atlas item {n}.")))
            .collect::<Vec<_>>();
        let pack = select("Atlas", &candidates, 100, 100_000);
        assert_eq!(pack.trace["candidateCount"], 64);
        assert_eq!(pack.references.len(), 24);
        assert!(pack.trace["modelChars"].as_u64().unwrap() <= 36_000);
        let repeated = vec![candidates[0].clone(), candidates[0].clone()];
        assert_eq!(select("Atlas", &repeated, 24, 36_000).references.len(), 1);
    }

    #[test]
    fn no_source_or_title_implies_no_entity_link() {
        let a = reference("a", "Atlas uses Vega.");
        let b = reference("b", "Vega is a recurrent encoder.");
        let pack = select("Atlas architecture", &[a, b], 24, 36_000);
        assert!(pack.trace["provenanceLinks"].as_array().unwrap().is_empty());
        assert_eq!(pack.trace["identityInference"], false);
        assert_eq!(pack.trace["coverageIsAnswerProof"], false);
    }

    #[test]
    fn stale_or_cross_project_source_positions_do_not_connect() {
        let mut a = reference("a", "Atlas uses a pipeline.");
        let mut b = reference("b", "The next pipeline step is initialization.");
        position(&mut a, "same-source", 0);
        position(&mut b, "same-source", 1);
        assert_eq!(source_distance(&a, &b), Some(1));
        b["projectId"] = json!("other");
        assert_eq!(source_distance(&a, &b), None);
        b["projectId"] = json!("p");
        b["navigationLinks"]["revisionId"] = json!("old");
        assert_eq!(source_distance(&a, &b), None);
    }

    #[test]
    fn literal_relation_navigation_requires_current_visible_witness_and_literal_named_endpoint() {
        let mut a = reference("a", "Atlas uses Vega.");
        let mut b = reference("b", "Vega encodes each sentence.");
        b["facets"] = json!({"entity":"Vega"});
        position(&mut a, "source", 0);
        a["navigationLinks"]["literalRelations"] = json!([{
            "subject":"Atlas","relation":"uses","object":"Vega",
            "witness":"Atlas uses Vega.","revisionId":a["revisionId"],"contentHash":a["contentHash"]
        }]);
        assert!(literal_connection(&a, &b));
        a["navigationLinks"]["literalRelations"][0]["witness"] = json!("An old model uses Vega.");
        assert!(!literal_connection(&a, &b));
        a["navigationLinks"]["literalRelations"][0]["witness"] = json!("Atlas uses Vega.");
        b["facets"]["entity"] = json!("a recurrent encoder");
        assert!(!literal_connection(&a, &b));
    }

    #[test]
    fn source_navigation_is_not_an_answer_obligation() {
        let pack = select(
            "How is each item classified?",
            &[reference("r", "Each item is classified separately.")],
            24,
            36_000,
        );
        let coverage = pack.trace["questionRelationCoverage"].to_string();
        assert!(!coverage.contains("padding"));
        assert!(!coverage.contains("dimension"));
        assert!(pack.trace.get("requiredObligations").is_none());
    }

    #[test]
    fn tiny_budget_and_zero_reference_limit_return_empty_safely() {
        let candidates = vec![reference("r", "Atlas uses Vega.")];
        assert!(select("Atlas", &candidates, 0, 36_000)
            .references
            .is_empty());
        assert!(select("Atlas", &candidates, 24, 1).references.is_empty());
    }

    #[test]
    fn deterministic_selection_keeps_input_values_unchanged() {
        let candidates = vec![
            reference("a", "Atlas uses Vega."),
            reference("b", "Vega encodes each sentence."),
        ];
        let original = candidates.clone();
        let first = select("How does Atlas encode sentences?", &candidates, 24, 36_000);
        let second = select("How does Atlas encode sentences?", &candidates, 24, 36_000);
        assert_eq!(first.references, second.references);
        assert_eq!(first.trace, second.trace);
        assert_eq!(candidates, original);
    }

    fn assert_same_selection(question: &str, references: &[Value], maximum: usize, chars: usize) {
        let eager = select_with_sizing::<true>(question, references, maximum, chars);
        let lazy = select(question, references, maximum, chars);
        assert_eq!(
            lazy.references, eager.references,
            "{question}, {maximum}, {chars}"
        );
        for field in [
            "selectedIds",
            "selection",
            "modelChars",
            "questionTermCoverage",
            "questionRelationCoverage",
            "provenanceLinks",
            "rankProtection",
            "sourceNavigation",
            "wholeReferences",
            "identityInference",
        ] {
            assert_eq!(
                lazy.trace[field], eager.trace[field],
                "field {field}; {question}, {maximum}, {chars}"
            );
        }
        assert_eq!(lazy.trace["modelChars"], model_chars(&lazy.references));
        assert!(
            lazy.trace["exactSizeChecks"].as_u64().unwrap()
                <= references.len().min(MAX_CANDIDATES) as u64
        );
    }

    #[test]
    fn score_then_size_matches_eager_with_overflow_duplicates_links_and_applicability() {
        let mut large = reference("large", "Atlas uses 32 cases only for archived reports.");
        large["facets"] = json!({"conditions":["x".repeat(3_000)]});
        let mut anchor = reference("anchor", "Atlas uses Vega.");
        position(&mut anchor, "source", 0);
        anchor["navigationLinks"]["literalRelations"] = json!([{
            "subject":"Atlas","relation":"uses","object":"Vega","witness":"Atlas uses Vega.",
            "revisionId":anchor["revisionId"],"contentHash":anchor["contentHash"]}]);
        let mut step = reference(
            "step",
            "Vega initializes the previous sentence context before processing.",
        );
        step["facets"] = json!({"entity":"Vega"});
        position(&mut step, "source", 1);
        let mut other_project = reference("other", "Atlas uses 64 cases for evaluation.");
        other_project["projectId"] = json!("other");
        let mut other_source = reference("other-source", "Atlas does not share decoder weights.");
        other_source["sourceTitle"] = json!("Another source");
        let mut empty = reference("empty", "");
        empty["sourceTitle"] = Value::Null;
        let references = vec![
            large,
            anchor.clone(),
            step,
            other_project,
            other_source,
            empty,
            anchor,
        ];
        for maximum in [0, 1, 4, 24] {
            for chars in [1, 350, 900, 36_000] {
                assert_same_selection(
                    "How does Atlas process sentences and share weights?",
                    &references,
                    maximum,
                    chars,
                );
            }
        }
    }

    #[test]
    fn sixty_four_candidate_pack_needs_only_twenty_four_exact_size_checks() {
        let references = (0..64)
            .map(|number| {
                reference(&format!("m{number}"),
            &format!("Atlas sequential encoder processes sentence configuration option {number}."))
            })
            .collect::<Vec<_>>();
        let question = "How does Atlas encoder process each sentence?";
        assert_same_selection(question, &references, 24, 36_000);
        let eager = select_with_sizing::<true>(question, &references, 24, 36_000);
        let lazy = select(question, &references, 24, 36_000);
        assert_eq!(lazy.references.len(), 24);
        assert_eq!(lazy.trace["exactSizeChecks"], 24);
        assert!(eager.trace["exactSizeChecks"].as_u64().unwrap() > 500);
        assert_eq!(lazy.trace["modelChars"], model_chars(&lazy.references));
    }

    #[test]
    fn survey_groups_preserve_directory_and_complete_complementary_facts_within_exact_budget() {
        let mut references = (0..40)
            .map(|number| {
                reference(
                    &format!("generic{number}"),
                    &format!("The state of the art covers generic architecture item {number}."),
                )
            })
            .collect::<Vec<_>>();
        let mut directory = reference(
            "directory",
            "In this section we discuss the state of the art on retrieval systems.",
        );
        position(&mut directory, "paper", 10);
        directory["navigationLinks"]["sectionGroup"] = json!({"role":"directory","sourceId":"paper","ordinal":10,
            "revisionId":directory["revisionId"],"navigationOnly":true});
        references.push(directory.clone());
        for group in 0..4 {
            for (member,body) in [("head",format!("System {group} was developed for conversational processing.")),
                ("complement",format!("System {group} applies rules only to archived reports and cannot remove approved conditions."))] {
                let mut fact=reference(&format!("g{group}-{member}"),&body);
                position(&mut fact,"paper",11+group);
                fact["navigationLinks"]["sectionGroup"]=json!({"role":member,"groupId":format!("group{group}"),"sequenceIndex":group,
                    "sourceId":"paper","ordinal":11+group,"revisionId":fact["revisionId"],"navigationOnly":true});
                references.push(fact);
            }
        }
        let question = "What is the state of the art described in the paper?";
        let pack = select(question, &references, 24, 36_000);
        assert_eq!(pack.references.len(), 24);
        assert!(pack.references.contains(&directory));
        for group in 0..4 {
            for role in ["head", "complement"] {
                assert!(pack
                    .references
                    .iter()
                    .any(|reference| reference["id"] == format!("g{group}-{role}")));
            }
        }
        assert_same_selection(question, &references, 24, 36_000);
        let small = select(question, &references, 24, 1_200);
        assert!(small.trace["modelChars"].as_u64().unwrap() <= 1_200);
        assert!(small
            .references
            .iter()
            .all(|reference| references.contains(reference)));
        let ordinary = select("Which architecture is used?", &references, 24, 36_000);
        assert!(ordinary.trace["sectionGroupNavigation"]["priorityIds"]
            .as_array()
            .unwrap()
            .is_empty());
        let mut forged = references.clone();
        for reference in &mut forged {
            if reference["navigationLinks"]["sectionGroup"].is_object() {
                reference["navigationLinks"]["sectionGroup"]["revisionId"] = json!("old");
            }
        }
        assert!(
            select(question, &forged, 24, 36_000).trace["sectionGroupNavigation"]["priorityIds"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }
}
