//! Rebuildable navigation over current, eligible formal memories.
//!
//! No relation is persisted and no source sentence becomes an answer fact.
//! Structural positions only navigate. Literal relations require the complete
//! current body to occur verbatim in a ready source segment, and retain that
//! body, revision and source witness for audit.
use crate::Result;
use rusqlite::{params_from_iter, Connection};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};

const MAX_POSITIONS: usize = 3;
const MAX_RELATIONS: usize = 4;

struct SurveyGroupMember<'a> {
    rank: u8,
    index: usize,
    segment: &'a str,
    members: &'a [Value],
}

/// A map of already supplied survey references, never a completeness verdict.
/// Indices belong to this exact array, before its model projection; callers
/// must not reuse a generation array's indices for a review citation subset.
pub(crate) fn survey_coverage_profile(question: &str, references: &[Value]) -> Value {
    let disabled = || {
        json!({"mode":"disabled","referenceIndexBase":1,"directoryReferenceIndices":[],
            "groups":[],"navigationOnly":true,"identityInferred":false})
    };
    if !crate::memory_query::survey_question(&crate::search::Query::new(question))
        || references.len() > 64
    {
        return disabled();
    }
    let mut seen = HashSet::new();
    let rows = references
        .iter()
        .enumerate()
        .filter_map(|(index, reference)| {
            let (record, group, position) = survey_navigation_row(reference)?;
            let key = (
                record["projectId"].as_str()?,
                record["memoryId"]
                    .as_str()
                    .or_else(|| record["id"].as_str())?,
                record["revisionId"].as_str()?,
            );
            seen.insert(key).then_some((index, record, group, position))
        })
        .collect::<Vec<_>>();
    let mut directories = rows.iter().filter(|(_, record, group, _)| {
        group["role"] == "directory"
            && record["memoryId"]
                .as_str()
                .or_else(|| record["id"].as_str())
                == group["anchorMemoryId"].as_str()
    });
    let Some((directory_index, directory, directory_group, directory_position)) =
        directories.next()
    else {
        return disabled();
    };
    if directories.next().is_some() {
        return disabled();
    }
    let anchor = directory_group["ordinal"].as_u64().unwrap();
    let mut groups = BTreeMap::<(u64, u64, &str), Vec<SurveyGroupMember<'_>>>::new();
    for (index, record, group, position) in &rows {
        let rank = match group["role"].as_str() {
            Some("head") => 0,
            Some("complement") => 1,
            _ => continue,
        };
        let (Some(sequence), Some(group_id), Some(members)) = (
            group["sequenceIndex"].as_u64(),
            group["groupId"].as_str(),
            group["memberMemoryIds"].as_array(),
        ) else {
            continue;
        };
        let ordinal = group["ordinal"].as_u64().unwrap();
        let memory_id = record["memoryId"]
            .as_str()
            .or_else(|| record["id"].as_str())
            .unwrap();
        if sequence >= 4
            || ordinal <= anchor
            || ordinal - anchor > 6
            || record["projectId"] != directory["projectId"]
            || group["anchorMemoryId"] != directory_group["anchorMemoryId"]
            || group["sourceId"] != directory_group["sourceId"]
            || position["sourceHash"] != directory_position["sourceHash"]
            || group_id != format!("{}:{anchor}:{ordinal}", group["sourceId"].as_str().unwrap())
            || members.is_empty()
            || members.len() > 2
            || !members.iter().any(|member| member == memory_id)
        {
            continue;
        }
        groups
            .entry((sequence, ordinal, group_id))
            .or_default()
            .push(SurveyGroupMember {
                rank,
                index: index + 1,
                segment: position["segmentId"].as_str().unwrap(),
                members,
            });
    }
    let groups = groups
        .into_values()
        .filter_map(|mut members| {
            members.sort_unstable_by_key(|member| (member.rank, member.index));
            let head = members.first()?;
            if head.rank != 0 {
                return None;
            }
            let mut indices = vec![head.index];
            if let Some(complement) = members.iter().find(|member| {
                member.rank == 1 && member.segment == head.segment && member.members == head.members
            }) {
                indices.push(complement.index);
            }
            Some(json!({"referenceIndices":indices}))
        })
        .take(4)
        .collect::<Vec<_>>();
    if groups.is_empty() {
        return disabled();
    }
    let profile = json!({"mode":"selected-section-groups","referenceIndexBase":1,
        "directoryReferenceIndices":[directory_index+1],"groups":groups,
        "navigationOnly":true,"identityInferred":false});
    if profile.to_string().chars().count() > 900 {
        disabled()
    } else {
        profile
    }
}

fn survey_navigation_row(reference: &Value) -> Option<(&Value, &Value, &Value)> {
    let record = reference.get("record").unwrap_or(reference);
    let nonempty = |value: &Value| value.as_str().is_some_and(|text| !text.is_empty());
    let links = record.get("navigationLinks")?;
    let group = links.get("sectionGroup")?;
    let body = reference["content"].as_str()?;
    if !nonempty(&record["projectId"])
        || record["memoryId"]
            .as_str()
            .or_else(|| record["id"].as_str())
            .is_none_or(|id| id.is_empty())
        || !nonempty(&record["revisionId"])
        || !nonempty(&record["contentHash"])
        || body.is_empty()
        || reference["content"] != record["content"]
        || (reference.get("record").is_some() && reference["projectId"] != record["projectId"])
        || links["revisionId"] != record["revisionId"]
        || links["contentHash"] != record["contentHash"]
        || links["evidenceRole"] != "navigation-only"
        || group["navigationOnly"] != true
        || group["identityInferred"] != false
        || group["revisionId"] != record["revisionId"]
        || !nonempty(&group["anchorMemoryId"])
        || !nonempty(&group["sourceId"])
        || group["ordinal"].as_u64().is_none()
        || (record["truncated"] != true
            && record["contentHash"].as_str() != Some(crate::hash(body.as_bytes()).as_str()))
    {
        return None;
    }
    let position = links["sourcePositions"]
        .as_array()?
        .iter()
        .find(|position| {
            position["sourceId"] == group["sourceId"]
                && position["ordinal"] == group["ordinal"]
                && nonempty(&position["segmentId"])
                && nonempty(&position["sourceHash"])
        })?;
    Some((record, group, position))
}

/// Question-only navigation for an unqualified attribute of a current data
/// resource. This never grants claim support or infers an identity from titles.
/// Ambiguity is counted over the full bounded pool before display is limited.
pub(crate) fn current_resource_profile(question: &str, references: &[Value]) -> Value {
    let lower = question.to_lowercase();
    let disabled = || {
        json!({"mode":"disabled","preferredReferenceId":null,"currentResources":[],
        "navigationOnly":true,"identityInferred":false})
    };
    let attribute = [
        "language", "format", "label", "annotat", "how many", "size", "数量", "多少", "语言",
        "格式", "标注", "标签",
    ]
    .iter()
    .any(|cue| lower.contains(cue));
    let qualified = [
        "compar",
        "baseline",
        "previous",
        "prior",
        "related work",
        "auxiliary",
        "component",
        "subtask",
        "submodel",
        "encoder",
        "decoder",
        "classifier",
        "vs ",
        "versus",
        "比较",
        "基线",
        "相关工作",
        "子任务",
        "组件",
        "编码器",
        "分类器",
    ]
    .iter()
    .any(|cue| lower.contains(cue));
    if !attribute || qualified {
        return disabled();
    }
    let stop = crate::search::index_tokens("in what which how many much is are was were be been the a an of on at for from to do does did this these those their its it our your language languages format formats label labels annotation annotated size number count amount dataset datasets data corpus corpora and or with have has had used");
    // Explicit names need not have an organization facet on any reference.
    // Preserve their scope even if the current-resource sentence mentions that
    // other name as a baseline or comparison resource.
    if question
        .split(|character: char| !character.is_alphanumeric() && character != '_')
        .filter(|word| !word.is_empty())
        .any(|word| {
            word.chars().any(char::is_uppercase)
                && !stop.contains(&word.to_lowercase())
                && ![
                    "tweets",
                    "posts",
                    "reviews",
                    "records",
                    "images",
                    "sentences",
                    "documents",
                    "samples",
                    "text",
                ]
                .contains(&word.to_lowercase().as_str())
        })
    {
        return disabled();
    }
    let object_terms = if question
        .chars()
        .any(|character| ('\u{4e00}'..='\u{9fff}').contains(&character))
    {
        [
            "推文",
            "评论",
            "文本",
            "文档",
            "图像",
            "图片",
            "样本",
            "数据集",
            "语料",
        ]
        .into_iter()
        .filter(|term| question.contains(term))
        .map(str::to_owned)
        .collect::<Vec<_>>()
    } else {
        crate::search::index_tokens(question)
            .difference(&stop)
            .filter(|term| term.chars().count() > 1 && !term.chars().all(char::is_numeric))
            .cloned()
            .collect::<Vec<_>>()
    };
    // A generic dataset question still has a literal resource subject.
    let object_terms = if object_terms.is_empty()
        && ["dataset", "corpus", "data", "数据集", "语料"]
            .iter()
            .any(|term| lower.contains(term))
    {
        vec!["dataset".to_owned(), "corpus".to_owned(), "data".to_owned()]
    } else {
        object_terms
    };
    if object_terms.is_empty() {
        return disabled();
    }
    let query = crate::search::Query::new(question);
    for reference in references.iter().take(64) {
        let record = reference.get("record").unwrap_or(reference);
        let entity = record["facets"]["entity"].as_str().unwrap_or("");
        let proper = entity.split_whitespace().any(|word| {
            word.chars().any(char::is_uppercase)
                && ![
                    "The",
                    "This",
                    "Our",
                    "We",
                    "Dataset",
                    "Data",
                    "Corpus",
                    "Tweets",
                    "Reviews",
                    "Records",
                    "Images",
                    "Sentences",
                    "Documents",
                    "Samples",
                    "Posts",
                ]
                .contains(&word)
        });
        if proper && query.names_entity(entity) {
            return disabled();
        }
    }
    let mut matches = Vec::new();
    let mut seen = HashSet::new();
    let mut declarations = HashSet::new();
    let mut process_rows = HashSet::new();
    for reference in references.iter().take(64) {
        let record = reference.get("record").unwrap_or(reference);
        let body = reference["content"].as_str().unwrap_or("");
        let text = body.to_lowercase();
        let resource = [
            "dataset",
            "corpus",
            "corpora",
            "collection",
            "数据集",
            "语料",
            "数据集合",
        ]
        .iter()
        .any(|cue| text.contains(cue));
        let current = [
            "we create",
            "we introduce",
            "we present",
            "we release",
            "we collect",
            "our dataset",
            "our corpus",
            "our data collection",
            "this paper presents",
            "this work introduces",
            "我们创建",
            "我们提出",
            "我们发布",
            "我们的数据集",
            "本文提出",
        ]
        .iter()
        .any(|cue| {
            text.match_indices(cue).any(|(offset, _)| {
                !cue.is_ascii()
                    || offset == 0
                    || !text[..offset]
                        .chars()
                        .next_back()
                        .is_some_and(char::is_alphanumeric)
            })
        });
        let other = [
            "previous work",
            "prior work",
            "related work",
            "their dataset",
            "they create",
            "we will",
            "we plan",
            "future work",
            "we do not",
            "we did not",
            "does not introduce",
            "未创建",
            "计划",
            "未来",
            "以往研究",
        ]
        .iter()
        .any(|cue| text.contains(cue))
            || ["not", "no", "never"]
                .iter()
                .any(|word| has_word(&text, word))
            || text.contains("n't");
        let body_tokens = crate::search::index_tokens(body);
        let generic = object_terms == ["dataset", "corpus", "data"];
        let overlap = if generic {
            resource
        } else {
            object_terms
                .iter()
                .all(|term| body_tokens.contains(term) || text.contains(term))
        };
        if !resource || !current || other || !overlap {
            continue;
        }
        let reference_id = reference["id"]
            .as_str()
            .or_else(|| reference["memoryId"].as_str())
            .unwrap_or("");
        let memory = reference["memoryId"]
            .as_str()
            .or_else(|| record["memoryId"].as_str())
            .or_else(|| reference_id.strip_prefix("memory:"))
            .unwrap_or(reference_id);
        let project = reference.get("projectId").unwrap_or(&record["projectId"]);
        let source = reference
            .get("sourceTitle")
            .unwrap_or(&record["sourceTitle"]);
        let key = format!(
            "{}:{memory}:{}:{}:{}:{}",
            project, record["revision"], body, record["facets"], source
        );
        if seen.insert(key) {
            let declaration = [
                "we create",
                "we introduce",
                "we present",
                "we release",
                "we collect",
                "this paper presents",
                "this work introduces",
                "我们创建",
                "我们提出",
                "我们发布",
                "本文提出",
            ]
            .iter()
            .any(|cue| text.contains(cue));
            if declaration {
                declarations.insert(reference_id.to_owned());
            }
            let process_only = !declaration
                && [
                    "sampled our dataset",
                    "sampling our dataset",
                    "process our dataset",
                    "processed our dataset",
                    "preprocess our dataset",
                    "filtered our dataset",
                    "split our dataset",
                    "采样我们的数据集",
                    "处理我们的数据集",
                ]
                .iter()
                .any(|cue| text.contains(cue))
                && !body
                    .split_whitespace()
                    .skip(1)
                    .any(|word| word.chars().any(char::is_uppercase))
                && !text.contains("our dataset of")
                && !record["facets"]["entity"].as_str().is_some_and(|entity| {
                    !entity.is_empty() && crate::search::specific_entity(entity)
                });
            if process_only {
                process_rows.insert(reference_id.to_owned());
            }
            matches.push(
                json!({"referenceId":reference_id,"memoryId":memory,"projectId":project,
                "sourceTitle":source,"witness":body}),
            );
        }
    }
    if matches.is_empty() {
        return disabled();
    }
    // Processing "our dataset" does not declare another resource or prove it
    // has the introducer's identity. Keep the process fact in the references;
    // named resources, attribute rows and conflicting introductions still count.
    let process_contexts = if declarations.is_empty() {
        0
    } else {
        process_rows.len()
    };
    if !declarations.is_empty() {
        matches.retain(|row| {
            !row["referenceId"]
                .as_str()
                .is_some_and(|id| process_rows.contains(id))
        });
    }
    let unique = matches.len() == 1;
    let mut shown = Vec::new();
    let mut chars = 0;
    for row in &matches {
        let size = row.to_string().chars().count();
        if shown.len() < 4 && chars + size <= 1_200 {
            chars += size;
            shown.push(row.clone());
        }
    }
    json!({"mode":if unique {"unique-current-resource"} else {"ambiguous-current-resources"},
        "preferredReferenceId":if unique&&!shown.is_empty(){matches[0]["referenceId"].clone()}else{Value::Null},
        "currentResources":shown,"currentResourceCount":matches.len(),"objectTerms":object_terms,
        "limited":shown.len()<matches.len(),"maxRows":4,"maxWitnessChars":1_200,
        "processContextsNotNewResources":process_contexts,
        "navigationOnly":true,"identityInferred":false})
}

/// Attach only to records already admitted by the shared eligibility policy.
/// SQL binds each current revision again; callers cannot acquire an archived,
/// cross-project, conflicting or historical fact through a navigation edge.
pub(crate) fn derive(conn: &Connection, records: &mut [Value]) -> Result<Value> {
    if records.is_empty() {
        return Ok(json!({"version":"current-literal-links-v1","records":0,
            "sourcePositions":0,"literalRelations":0,"persisted":false}));
    }
    let ids = records
        .iter()
        .filter_map(|record| record["memoryId"].as_str())
        .collect::<Vec<_>>();
    let marks = vec!["?"; ids.len()].join(",");
    let sql = format!(
        "SELECT memory_id,revision_id,positions.project_id,positions.source_id,segment_id,positions.ordinal,positions.locator,source_hash,instr(g.text,m.content)
         FROM (SELECT m.id AS memory_id,r.id AS revision_id,m.project_id,s.id AS source_id,
             g.id AS segment_id,g.ordinal,g.locator,s.sha256 AS source_hash,
             row_number() OVER(PARTITION BY m.id ORDER BY s.id,g.ordinal,g.id) AS position
           FROM memories m JOIN revisions r ON r.memory_id=m.id AND r.number=m.revision AND r.content=m.content
           JOIN revision_evidence e ON e.revision_id=r.id JOIN segments g ON g.id=e.segment_id
           JOIN sources s ON s.id=g.source_id AND s.project_id=m.project_id AND s.status='ready'
           WHERE m.id IN ({marks}) AND m.state='active'
             AND NOT EXISTS(SELECT 1 FROM memory_reviews v JOIN proposals p ON p.id=v.proposal_id
               WHERE v.target_id=m.id AND v.status='pending' AND p.status='pending'
                 AND v.disposition IN ('conflict','uncertain'))) AS positions
         JOIN segments g ON g.id=positions.segment_id JOIN memories m ON m.id=positions.memory_id
         WHERE position <= {MAX_POSITIONS} ORDER BY memory_id,positions.source_id,positions.ordinal,segment_id"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(ids), |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            json!({"sourceId":row.get::<_,String>(3)?,"segmentId":row.get::<_,String>(4)?,
                "ordinal":row.get::<_,i64>(5)?,"locator":row.get::<_,String>(6)?,
                "sourceHash":row.get::<_,String>(7)?,"bodyOffset":row.get::<_,i64>(8)?,
                "bodyOffsetUnit":"unicode-characters-1-based-zero-if-absent"}),
        ))
    })?;
    let mut positions = BTreeMap::<(String, String, String), Vec<Value>>::new();
    for row in rows {
        let (memory, revision, project, position) = row?;
        positions
            .entry((memory, revision, project))
            .or_default()
            .push(position);
    }
    let mut source_count = 0;
    let mut relation_count = 0;
    for record in records.iter_mut() {
        let key = (
            record["memoryId"].as_str().unwrap_or("").to_owned(),
            record["revisionId"].as_str().unwrap_or("").to_owned(),
            record["projectId"].as_str().unwrap_or("").to_owned(),
        );
        let sources = positions.remove(&key).unwrap_or_default();
        let body = record["content"].as_str().unwrap_or("");
        let witnessed = sources.iter().find(|source| {
            source["bodyOffset"]
                .as_i64()
                .is_some_and(|offset| offset > 0)
        });
        let relations = if let Some(source) = witnessed {
            literal_relations(body)
                .into_iter()
                .map(|mut relation| {
                    relation["memoryId"] = record["memoryId"].clone();
                    relation["revisionId"] = record["revisionId"].clone();
                    relation["contentHash"] = json!(crate::hash(body.as_bytes()));
                    relation["sourceId"] = source["sourceId"].clone();
                    relation["segmentId"] = source["segmentId"].clone();
                    relation
                })
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        };
        source_count += sources.len();
        relation_count += relations.len();
        record["navigationLinks"] = json!({"version":"current-literal-links-v1",
            "revisionId":record["revisionId"],"contentHash":crate::hash(body.as_bytes()),
            "evidenceRole":"navigation-only","sourcePositions":sources,
            "literalRelations":relations});
    }
    Ok(
        json!({"version":"current-literal-links-v1","records":records.len(),
        "sourcePositions":source_count,"literalRelations":relation_count,
        "maxPositionsPerRecord":MAX_POSITIONS,"maxRelationsPerRecord":MAX_RELATIONS,
        "persisted":false,"identityInference":false}),
    )
}

fn has_word(text: &str, word: &str) -> bool {
    text.split(|c: char| !c.is_alphanumeric() && c != '\'')
        .any(|part| part == word)
}

/// Parse a small literal grammar only. Named entities, pronouns, previous work,
/// conditions and negation are never completed or resolved from a title.
fn literal_relations(body: &str) -> Vec<Value> {
    let mut found = Vec::new();
    let mut seen = HashSet::new();
    for sentence in body.split_inclusive(['.', '\n', '。', ';', '；']) {
        let witness = sentence.trim();
        if !(8..=600).contains(&witness.chars().count()) {
            continue;
        }
        let lower = witness.to_lowercase();
        if [
            "not", "never", "without", "no", "if", "unless", "may", "might", "could",
        ]
        .iter()
        .any(|word| has_word(&lower, word))
            || lower.contains("n't")
            || ["不", "未", "无", "若", "如果", "可能", "曾经"]
                .iter()
                .any(|word| lower.contains(word))
        {
            continue;
        }
        for (marker, relation) in [
            (" consists of ", "contains"),
            (" comprises ", "contains"),
            (" contains ", "contains"),
            (" includes ", "contains"),
            (" uses ", "uses"),
            (" is trained on ", "trained_on"),
            (" is trained using ", "trained_on"),
            ("使用", "uses"),
            ("包含", "contains"),
            ("训练于", "trained_on"),
        ] {
            let Some(offset) = lower.find(marker) else {
                continue;
            };
            // Lowercasing can change byte lengths in some scripts. Extract
            // only when the original exact marker has the same byte offset.
            let Some(original_marker) = witness.get(offset..offset + marker.len()) else {
                continue;
            };
            if original_marker.to_lowercase() != marker {
                continue;
            }
            let subject = witness[..offset].trim();
            let object = witness[offset + marker.len()..]
                .trim()
                .trim_end_matches(['.', '。', ';', '；']);
            if subject.is_empty()
                || object.is_empty()
                || subject.chars().count() > 100
                || object.chars().count() > 180
                || subject.contains([',', '，', ':', '：'])
                || !crate::search::specific_entity(subject)
                || [
                    "we", "they", "it", "this", "these", "that", "their", "our", "previous",
                    "prior",
                ]
                .iter()
                .any(|word| has_word(&subject.to_lowercase(), word))
            {
                continue;
            }
            let key = (subject.to_owned(), relation, object.to_owned());
            if seen.insert(key) {
                found.push(
                    json!({"subject":subject,"relation":relation,"object":object,
                    "witness":witness,"witnessKind":"current-body-verbatim-in-source"}),
                );
            }
            break;
        }
        if found.len() >= MAX_RELATIONS {
            break;
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    fn survey_reference(id: &str, role: &str, ordinal: u64, sequence: u64) -> Value {
        let content = match role {
            "directory" => {
                "This section reviews representative systems and their roles.".to_owned()
            }
            "head" => format!("System {sequence} processes entries only when the archive is open."),
            _ => format!("System {sequence} does not use unapproved entries, even in batch mode."),
        };
        let revision = format!("{id}-r1");
        let content_hash = crate::hash(content.as_bytes());
        let mut group = json!({"role":role,"sourceId":"source","ordinal":ordinal,
            "revisionId":revision,"anchorMemoryId":"intro","navigationOnly":true,"identityInferred":false});
        if role != "directory" {
            group["groupId"] = json!(format!("source:10:{ordinal}"));
            group["sequenceIndex"] = json!(sequence);
            group["memberMemoryIds"] =
                json!([format!("head{sequence}"), format!("detail{sequence}")]);
        }
        json!({"id":id,"memoryId":id,"projectId":"p","revisionId":revision,
            "content":content,"contentHash":content_hash,"truncated":false,
            "navigationLinks":{"revisionId":revision,"contentHash":content_hash,
                "evidenceRole":"navigation-only","sourcePositions":[{"sourceId":"source",
                    "sourceHash":"current-source-hash","segmentId":format!("segment{ordinal}"),"ordinal":ordinal}],
                "sectionGroup":group}})
    }

    fn survey_references(groups: u64) -> Vec<Value> {
        let mut references = vec![survey_reference("intro", "directory", 10, 0)];
        for sequence in 0..groups {
            references.push(survey_reference(
                &format!("head{sequence}"),
                "head",
                11 + sequence,
                sequence,
            ));
            references.push(survey_reference(
                &format!("detail{sequence}"),
                "complement",
                11 + sequence,
                sequence,
            ));
        }
        references
    }

    #[test]
    fn survey_profile_maps_only_selected_groups_without_assessing_completeness() {
        let references = survey_references(2);
        let original = references.clone();
        let profile = survey_coverage_profile("Give a full survey of all methods.", &references);
        assert_eq!(profile["mode"], "selected-section-groups");
        assert_eq!(profile["referenceIndexBase"], 1);
        assert_eq!(profile["directoryReferenceIndices"], json!([1]));
        assert_eq!(
            profile["groups"],
            json!([
                {"referenceIndices":[2,3]}, {"referenceIndices":[4,5]}
            ])
        );
        assert_eq!(profile["navigationOnly"], true);
        assert_eq!(profile["identityInferred"], false);
        for forbidden in [
            "content",
            "complete",
            "sourceId",
            "groupId",
            "System",
            "source-current",
        ] {
            assert!(!profile.to_string().contains(forbidden), "{forbidden}");
        }
        assert_eq!(references, original);
        assert!(references[1]["content"]
            .as_str()
            .unwrap()
            .contains("only when"));
        assert!(references[2]["content"]
            .as_str()
            .unwrap()
            .contains("does not"));
    }

    #[test]
    fn survey_profile_is_disabled_without_a_survey_or_visible_bound_directory() {
        let references = survey_references(1);
        for (question, visible) in [
            ("How does the processor operate?", references.clone()),
            ("Give an overview.", Vec::new()),
            ("Give an overview.", references[1..].to_vec()),
            ("Give an overview.", vec![references[0].clone()]),
            (
                "Give an overview.",
                vec![json!({"content":"This section reviews systems."})],
            ),
        ] {
            assert_eq!(
                survey_coverage_profile(question, &visible)["mode"],
                "disabled"
            );
        }
    }

    #[test]
    fn survey_profile_rejects_changed_revision_source_hash_and_current_body() {
        let references = survey_references(1);
        for path in [
            "/navigationLinks/revisionId",
            "/navigationLinks/contentHash",
            "/navigationLinks/sectionGroup/revisionId",
            "/navigationLinks/sectionGroup/sourceId",
            "/navigationLinks/sourcePositions/0/sourceHash",
            "/projectId",
            "/content",
        ] {
            let mut changed = references.clone();
            *changed[1].pointer_mut(path).unwrap() = json!("changed");
            assert_eq!(
                survey_coverage_profile("Give an overview.", &changed)["mode"],
                "disabled",
                "{path}"
            );
        }
        let mut no_binding = references;
        no_binding[0]["contentHash"] = Value::Null;
        no_binding[0]["navigationLinks"]["contentHash"] = Value::Null;
        assert_eq!(
            survey_coverage_profile("Give an overview.", &no_binding)["mode"],
            "disabled"
        );
    }

    #[test]
    fn survey_profile_subset_never_recovers_absent_members_or_changes_index_namespace() {
        let references = survey_references(2);
        let visible = vec![references[0].clone(), references[1].clone()];
        let profile = survey_coverage_profile("Give an overview.", &visible);
        assert_eq!(profile["groups"], json!([{"referenceIndices":[2]}]));
        assert!(!profile.to_string().contains("detail"));
        assert_eq!(
            survey_coverage_profile(
                "Give an overview.",
                &[references[0].clone(), references[2].clone()]
            )["mode"],
            "disabled"
        );
        let reordered = vec![
            references[4].clone(),
            references[0].clone(),
            references[3].clone(),
        ];
        let profile = survey_coverage_profile("Give an overview.", &reordered);
        assert_eq!(profile["directoryReferenceIndices"], json!([2]));
        assert_eq!(profile["groups"], json!([{"referenceIndices":[3,1]}]));
    }

    #[test]
    fn survey_profile_supports_desktop_wrappers_and_deduplicates_aliases() {
        let references = survey_references(1);
        let wrap = |record: &Value| {
            json!({"id":format!("memory:{}",record["id"].as_str().unwrap()),
            "projectId":record["projectId"],"content":record["content"],"record":record})
        };
        let visible = vec![
            wrap(&references[2]),
            json!({"id":"other","content":"Unrelated record."}),
            wrap(&references[0]),
            references[1].clone(),
            wrap(&references[1]),
        ];
        let profile = survey_coverage_profile("Give an overview.", &visible);
        assert_eq!(profile["directoryReferenceIndices"], json!([3]));
        assert_eq!(profile["groups"], json!([{"referenceIndices":[4,1]}]));
        let mut changed = visible;
        changed[2]["content"] = json!("Different visible body.");
        assert_eq!(
            survey_coverage_profile("Give an overview.", &changed)["mode"],
            "disabled"
        );
    }

    #[test]
    fn survey_profile_limits_groups_members_and_size_without_extra_body() {
        let mut references = survey_references(5);
        let mut rogue = references[2].clone();
        rogue["id"] = json!("rogue");
        rogue["memoryId"] = json!("rogue");
        rogue["navigationLinks"]["sectionGroup"]["memberMemoryIds"] = json!(["rogue"]);
        references.insert(2, rogue);
        let profile = survey_coverage_profile("Give an overview.", &references);
        let groups = profile["groups"].as_array().unwrap();
        assert_eq!(groups.len(), 4);
        assert!(groups
            .iter()
            .all(|group| group["referenceIndices"].as_array().unwrap().len() <= 2));
        assert_eq!(groups[0]["referenceIndices"], json!([2, 4]));
        assert!(profile.to_string().chars().count() <= 900);
        assert!(!profile.to_string().contains("content"));
        let over_limit = vec![references[0].clone(); 65];
        assert_eq!(
            survey_coverage_profile("Give an overview.", &over_limit)["mode"],
            "disabled"
        );
        let mut second_directory = references[0].clone();
        second_directory["id"] = json!("another-intro");
        second_directory["memoryId"] = json!("another-intro");
        second_directory["navigationLinks"]["sectionGroup"]["anchorMemoryId"] =
            json!("another-intro");
        references.push(second_directory);
        assert_eq!(
            survey_coverage_profile("Give an overview.", &references)["mode"],
            "disabled"
        );
    }

    fn database() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;")
            .unwrap();
        crate::db::migrate(&conn).unwrap();
        conn.execute_batch("INSERT INTO projects VALUES('p','Project','','now');
            INSERT INTO projects VALUES('other','Private','','now');
            INSERT INTO sources VALUES('ready','p','Source','text','source.txt',NULL,'now','ready-hash','ready',1,NULL,'');
            INSERT INTO segments VALUES('segment','ready','v1',0,'line 1','Atlas uses Vega. Atlas contains two layers.');
            INSERT INTO sources VALUES('not-ready','p','Failed source','text','failed.txt',NULL,'now','failed-hash','failed',1,NULL,'');
            INSERT INTO segments VALUES('failed-segment','not-ready','v1',0,'line 1','Atlas uses Vega.');").unwrap();
        conn
    }

    fn insert(conn: &Connection, id: &str, project: &str, body: &str, segment: &str) -> Value {
        conn.execute(
            "INSERT INTO memories VALUES(?1,?2,'fact',?3,1,'active','Source','now','now')",
            rusqlite::params![id, project, body],
        )
        .unwrap();
        let revision = format!("{id}-r1");
        conn.execute(
            "INSERT INTO revisions VALUES(?1,?2,1,?3,'','user_correction','now')",
            rusqlite::params![revision, id, body],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO revision_evidence VALUES(?,?)",
            rusqlite::params![revision, segment],
        )
        .unwrap();
        json!({"id":id,"memoryId":id,"projectId":project,"revisionId":revision,"content":body})
    }

    #[test]
    fn literal_relations_keep_exact_named_witness_without_inventing_identity() {
        let body = "Atlas uses the Vega encoder. Atlas consists of two components.";
        let links = literal_relations(body);
        assert_eq!(links.len(), 2);
        assert_eq!(links[0]["subject"], "Atlas");
        assert_eq!(links[0]["object"], "the Vega encoder");
        for link in links {
            assert!(body.contains(link["witness"].as_str().unwrap()));
            assert!(link.get("targetMemoryId").is_none());
        }
    }

    #[test]
    fn uncertain_negative_pronominal_and_generic_relations_are_not_edges() {
        for body in [
            "Atlas does not use the Vega encoder.",
            "Atlas never uses the Vega encoder.",
            "If enabled Atlas uses the Vega encoder.",
            "Our model uses the Vega encoder.",
            "We use the Vega encoder.",
            "The model uses the Vega encoder.",
            "Prior work uses the Vega encoder.",
            "Atlas可能使用Vega编码器。",
        ] {
            assert!(literal_relations(body).is_empty(), "{body}");
        }
    }

    #[test]
    fn conditional_body_is_preserved_or_skipped_never_rewritten() {
        let body = "Atlas uses Vega only for archived reports.";
        let links = literal_relations(body);
        assert_eq!(links[0]["witness"], body);
        assert_eq!(links[0]["object"], "Vega only for archived reports");
    }

    #[test]
    fn relations_are_bounded_and_not_inferred_from_bag_of_names() {
        assert!(literal_relations("Atlas and Vega are mentioned in this paper.").is_empty());
        let body = (0..20)
            .map(|number| format!("Atlas{number} uses Vega{number}. "))
            .collect::<String>();
        assert_eq!(literal_relations(&body).len(), MAX_RELATIONS);
    }

    #[test]
    fn derived_graph_binds_current_revision_exact_source_and_original_body() {
        let conn = database();
        let record = insert(&conn, "a", "p", "Atlas uses Vega.", "segment");
        let mut records = vec![record.clone()];
        let trace = derive(&conn, &mut records).unwrap();
        assert_eq!(records[0]["content"], record["content"]);
        assert_eq!(trace["literalRelations"], 1);
        let relation = &records[0]["navigationLinks"]["literalRelations"][0];
        assert_eq!(relation["revisionId"], "a-r1");
        assert_eq!(relation["sourceId"], "ready");
        assert_eq!(relation["segmentId"], "segment");
        assert_eq!(relation["witness"], "Atlas uses Vega.");
        assert_eq!(relation["contentHash"], crate::hash(b"Atlas uses Vega."));
        let repeated = derive(&conn, &mut records).unwrap();
        assert_eq!(trace, repeated);
        // Rebuilding the graph cannot change or append canonical memories.
        assert_eq!(
            conn.query_row("SELECT count(*) FROM memories", [], |row| row
                .get::<_, usize>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn paraphrase_gets_source_navigation_but_no_literal_semantic_relation() {
        let conn = database();
        let mut records = vec![insert(
            &conn,
            "paraphrase",
            "p",
            "Atlas uses Rigel.",
            "segment",
        )];
        let trace = derive(&conn, &mut records).unwrap();
        assert_eq!(trace["sourcePositions"], 1);
        assert_eq!(trace["literalRelations"], 0);
        assert_eq!(
            records[0]["navigationLinks"]["sourcePositions"][0]["bodyOffset"],
            0
        );
    }

    #[test]
    fn archived_unready_cross_project_and_old_revision_edges_are_absent() {
        let conn = database();
        let archived = insert(&conn, "archived", "p", "Atlas uses Vega.", "segment");
        conn.execute(
            "UPDATE memories SET state='archived' WHERE id='archived'",
            [],
        )
        .unwrap();
        let unready = insert(&conn, "unready", "p", "Atlas uses Vega.", "failed-segment");
        let private = insert(&conn, "private", "other", "Atlas uses Vega.", "segment");
        let old = insert(&conn, "old", "p", "Atlas uses Vega.", "segment");
        conn.execute_batch("INSERT INTO revisions VALUES('old-r2','old',2,'Atlas uses Rigel.','','user_correction','later');
            UPDATE memories SET revision=2,content='Atlas uses Rigel.' WHERE id='old';").unwrap();
        let mut records = vec![archived, unready, private, old];
        let trace = derive(&conn, &mut records).unwrap();
        assert_eq!(trace["sourcePositions"], 0);
        assert_eq!(trace["literalRelations"], 0);
    }

    #[test]
    fn pending_uncertain_review_cannot_be_reached_through_a_literal_edge() {
        let conn = database();
        let record = insert(&conn, "pending", "p", "Atlas uses Vega.", "segment");
        conn.execute_batch("INSERT INTO proposals(id,project_id,source_id,kind,content,status,created_at,memory_id)
            VALUES('proposal','p','ready','fact','Atlas uses Rigel.','pending','now',NULL);
            INSERT INTO memory_reviews VALUES('review','proposal','uncertain','pending',1,'Atlas uses Vega.','Review required','pending','now','now');").unwrap();
        let mut records = vec![record];
        let trace = derive(&conn, &mut records).unwrap();
        assert_eq!(trace["sourcePositions"], 0);
        assert_eq!(trace["literalRelations"], 0);
    }

    #[test]
    fn source_position_limit_cannot_expand_into_an_unbounded_source_graph() {
        let conn = database();
        let record = insert(&conn, "many", "p", "Atlas uses Vega.", "segment");
        for ordinal in 1..20 {
            conn.execute(
                "INSERT INTO segments VALUES(?,'ready','v1',?,'line','Atlas uses Vega.')",
                rusqlite::params![format!("s{ordinal}"), ordinal],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO revision_evidence VALUES('many-r1',?)",
                [format!("s{ordinal}")],
            )
            .unwrap();
        }
        conn.execute("UPDATE sources SET segment_count=20 WHERE id='ready'", [])
            .unwrap();
        let mut records = vec![record];
        let trace = derive(&conn, &mut records).unwrap();
        assert_eq!(trace["sourcePositions"], MAX_POSITIONS);
        assert_eq!(
            records[0]["navigationLinks"]["sourcePositions"]
                .as_array()
                .unwrap()
                .len(),
            MAX_POSITIONS
        );
    }

    #[test]
    fn unqualified_data_attribute_profiles_current_creation_without_hiding_prior_work() {
        let references = vec![
            json!({"id":"prior","projectId":"p","content":"Prior work studied German posts.","facets":{"entity":"Prior work"}}),
            json!({"id":"current","projectId":"p","revision":1,"content":"Using our annotation model, we create a new dataset of Polish posts only for archived reports.","facets":{}}),
        ];
        let original = references.clone();
        let profile = current_resource_profile("In what language are the posts?", &references);
        assert_eq!(profile["mode"], "unique-current-resource");
        assert_eq!(profile["preferredReferenceId"], "current");
        assert!(profile["currentResources"][0]["witness"]
            .as_str()
            .unwrap()
            .contains("only for archived reports"));
        assert_eq!(profile["navigationOnly"], true);
        assert_eq!(references, original);
    }

    #[test]
    fn resource_profile_retains_multi_resource_ambiguity_before_display_limits() {
        let references=(0..8).map(|number|json!({"id":format!("r{number}"),"projectId":"p",
            "content":format!("We introduce dataset {number} containing annotated posts."),"facets":{}})).collect::<Vec<_>>();
        let profile = current_resource_profile("What labels are used on the posts?", &references);
        assert_eq!(profile["mode"], "ambiguous-current-resources");
        assert_eq!(profile["currentResourceCount"], 8);
        assert!(profile["preferredReferenceId"].is_null());
        assert!(profile["currentResources"].as_array().unwrap().len() <= 4);
        assert!(
            profile["currentResources"]
                .as_array()
                .unwrap()
                .iter()
                .map(|row| row.to_string().chars().count())
                .sum::<usize>()
                <= 1_200
        );
        assert_eq!(profile["limited"], true);
    }

    #[test]
    fn resource_profile_never_overrides_named_comparison_component_or_explicit_attribute() {
        let references = vec![
            json!({"id":"r","projectId":"p","content":"We create a new dataset of English posts.","facets":{"entity":"Atlas"}}),
        ];
        for question in [
            "What language are Atlas posts?",
            "What language are prior work posts?",
            "Compare the languages of the posts.",
            "What language are the auxiliary classifier posts?",
            "What language are the German posts?",
            "What is the model architecture?",
        ] {
            assert_eq!(
                current_resource_profile(question, &references)["mode"],
                "disabled",
                "{question}"
            );
        }
        for content in [
            "We will create a dataset of posts.",
            "We do not introduce a dataset of posts.",
            "Prior work reports that we create a dataset of posts.",
            "We create no new dataset of posts.",
            "We evaluate your dataset of posts.",
        ] {
            assert_eq!(
                current_resource_profile(
                    "What language are the posts?",
                    &[json!({"id":"x","content":content})]
                )["mode"],
                "disabled"
            );
        }
        let comparison = vec![
            json!({"id":"current","content":"We introduce the Alpha corpus and compare it with the named Beta baseline data.","facets":{"entity":"Alpha"}}),
        ];
        assert_eq!(
            current_resource_profile("What language is Beta data?", &comparison)["mode"],
            "disabled"
        );
    }

    #[test]
    fn desktop_alias_of_the_same_current_resource_does_not_create_ambiguity() {
        let raw = json!({"id":"r","memoryId":"r","projectId":"p","revision":1,"sourceTitle":"source",
            "content":"We introduce a new dataset of annotated posts.","facets":{}});
        let wrapper = json!({"id":"memory:r","memoryId":"r","projectId":"p","sourceTitle":"source",
            "content":raw["content"],"record":raw});
        let profile =
            current_resource_profile("What labels are used on the posts?", &[raw, wrapper]);
        assert_eq!(profile["currentResourceCount"], 1);
        assert_eq!(profile["mode"], "unique-current-resource");
    }

    #[test]
    fn process_context_does_not_hide_another_named_or_conflicting_current_resource() {
        let intro =
            json!({"id":"intro","content":"We create a new dataset of English posts.","facets":{}});
        let process = json!({"id":"process","content":"We sampled our dataset such that half the posts concern politics.","facets":{}});
        let profile = current_resource_profile(
            "What language are the posts?",
            &[intro.clone(), process.clone()],
        );
        assert_eq!(profile["mode"], "unique-current-resource");
        assert_eq!(profile["preferredReferenceId"], "intro");
        assert_eq!(profile["processContextsNotNewResources"], 1);
        for other in [
            json!({"id":"other","content":"Our dataset Beta contains German posts.","facets":{"entity":"Beta"}}),
            json!({"id":"other","content":"Our dataset contains German posts.","facets":{}}),
            json!({"id":"other","content":"We introduce another dataset of German posts.","facets":{}}),
            json!({"id":"other","content":"We processed our dataset of German posts.","facets":{}}),
        ] {
            assert_eq!(
                current_resource_profile("What language are the posts?", &[intro.clone(), other])
                    ["mode"],
                "ambiguous-current-resources"
            );
        }
        assert_eq!(
            current_resource_profile("What language are the posts?", &[process])["mode"],
            "unique-current-resource"
        );
    }
}
