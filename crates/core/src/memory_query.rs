//! One eligibility policy and corpus ranker for both memory question entrypoints.
//! Full current text is ranked before excerpt and context limits are applied.
use crate::{hash, memory_facts, search::Query, AppError, Result};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::collections::BTreeMap;

const MAX_SCAN: usize = 10_000;
const MAX_BYTES: usize = 32 * 1024 * 1024;
pub(crate) const MAX_CANDIDATES: usize = 64;
const INDEX_VERSION: &str = "lexicalschema3";

fn stable_memory_order(a: &Value, b: &Value) -> std::cmp::Ordering {
    a["content"]
        .as_str()
        .cmp(&b["content"].as_str())
        .then_with(|| a["facets"].to_string().cmp(&b["facets"].to_string()))
        .then_with(|| a["id"].as_str().cmp(&b["id"].as_str()))
}

// Exact source positions influence navigation only. A corrected/current body
// that is absent from the source has no position and uses the stable fallback.
fn body_gap(source: &str, anchor: &str, candidate: &str) -> Option<usize> {
    let a = source.find(anchor)?;
    let b = source.find(candidate)?;
    Some(if a <= b {
        b.saturating_sub(a + anchor.len())
    } else {
        a.saturating_sub(b + candidate.len())
    })
}

pub(crate) fn survey_question(query: &Query) -> bool {
    [
        "state of the art",
        "state-of-the-art",
        "literature review",
        "related work",
        "survey",
        "overview",
        "研究现状",
        "综述",
        "相关工作",
        "已有方法",
    ]
    .iter()
    .any(|term| query.names(term))
}

fn complement_score(head: &str, candidate: &str) -> usize {
    let operation = |text: &str| {
        let text = text.to_lowercase();
        [
            "uses",
            "utiliz",
            "written using",
            "process",
            "comput",
            "classif",
            "transform",
            "generat",
            "respond",
            "response",
            "learn",
            "algorithm",
            "knowledge",
            "context",
            "memory",
            "rule",
            "处理",
            "规则",
            "生成",
            "知识",
            "算法",
            "功能",
        ]
        .iter()
        .filter(|cue| text.contains(**cue))
        .count()
    };
    let outcome = |text: &str| {
        let text = text.to_lowercase();
        [
            "pass",
            "test",
            "achiev",
            "score",
            "percent",
            "performance",
            "accuracy",
            "evaluat",
            "rated",
            "voted",
            "unable",
            "cannot",
            "失败",
            "效果",
            "准确",
            "性能",
            "测试",
            "通过",
            "不能",
        ]
        .iter()
        .filter(|cue| text.contains(**cue))
        .count()
    };
    let operations = operation(candidate);
    let outcomes = outcome(candidate);
    let primary = if operation(head) == 0 && operations > 0 {
        80
    } else if outcome(head) == 0 && outcomes > 0 {
        60
    } else {
        0
    };
    let head_terms = crate::search::index_tokens(head);
    let candidate_terms = crate::search::index_tokens(candidate);
    primary
        + operations.min(8) * 3
        + outcomes.min(8) * 3
        + candidate_terms.difference(&head_terms).count().min(20)
}

fn section_introduction(body: &str) -> bool {
    let lower = body.to_lowercase();
    [
        "in this section we discuss",
        "in this section we review",
        "this section reviews",
        "this section surveys",
        "this section presents an overview",
        "本节综述",
        "本节回顾",
        "本节介绍",
    ]
    .iter()
    .any(|cue| lower.contains(cue))
}

fn applicable(facets: &Value, named: &[String], as_of: &str) -> bool {
    // Generic subjects retain their original annotation, but do not assert a
    // different named scope. Explicit names must still match the query binding.
    let names = if crate::search::specific_entity(facets["entity"].as_str().unwrap_or("")) {
        named
    } else {
        &[]
    };
    memory_facts::applicable(facets, names, as_of)
}

pub(crate) struct Selection {
    pub records: Vec<Value>,
    pub trace: Value,
    pub catalog: Value,
}

pub(crate) fn evidence(
    conn: &Connection,
    revision: &str,
    project: &str,
    query: &Query,
    limit: usize,
) -> Result<Vec<Value>> {
    let mut statement = conn.prepare(
        "SELECT g.id,s.id,s.title,g.locator,g.text
         FROM revision_evidence e JOIN segments g ON g.id=e.segment_id
         JOIN sources s ON s.id=g.source_id
         WHERE e.revision_id=? AND s.project_id=? AND s.status='ready'
         ORDER BY s.id,g.ordinal LIMIT 3",
    )?;
    let rows = statement.query_map(params![revision, project], |row| {
        let raw: String = row.get(4)?;
        Ok(
            json!({"segmentId":row.get::<_,String>(0)?,"sourceId":row.get::<_,String>(1)?,
            "sourceTitle":row.get::<_,String>(2)?,"locator":row.get::<_,String>(3)?,
            "text":query.excerpt(&raw,limit),"textHash":hash(raw.as_bytes()),
            "truncated":raw.chars().count()>limit}),
        )
    })?;
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .map_err(Into::into)
}

pub(crate) fn retrieve(
    conn: &Connection,
    scope: Option<&str>,
    query: &Query,
    limit: usize,
    excerpt_chars: usize,
    include_unmatched: bool,
    as_of: &str,
) -> Result<Selection> {
    let limit = limit.min(MAX_CANDIDATES);
    let eligible = "FROM memories m JOIN revisions r ON r.memory_id=m.id AND r.number=m.revision AND r.content=m.content
         LEFT JOIN revision_facets f ON f.revision_id=r.id
         WHERE (?1 IS NULL OR m.project_id=?1) AND m.state='active'
         AND NOT EXISTS(SELECT 1 FROM memory_reviews v JOIN proposals p ON p.id=v.proposal_id
            WHERE v.target_id=m.id AND v.status='pending' AND p.status='pending'
            AND v.disposition IN ('conflict','uncertain'))";
    let (scanned, bytes): (usize, usize) = conn.query_row(
        &format!("SELECT count(*),coalesce(sum(length(CAST(m.content AS BLOB))),0) {eligible}"),
        [scope],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    if scanned > MAX_SCAN || bytes > MAX_BYTES {
        return Err(AppError::new(
            "QA_RETRIEVAL_LIMIT",
            "项目记忆超过本地检索容量，请缩小项目范围",
        ));
    }
    sync_index(conn, scope)?;
    // Persisted labels are a derived navigation cache. Revisions remain the
    // canonical source; visibility is checked again on every index join.
    let mut catalog_stmt = conn.prepare(
        &format!("SELECT m.id,m.revision,m.kind,i.label,coalesce(f.facets,'{{}}') {eligible}")
            .replace(
                "WHERE (?1",
                "JOIN memory_lexical_state i ON i.memory_id=m.id AND i.revision_id=r.id WHERE (?1",
            ),
    )?;
    let headings = catalog_stmt.query_map([scope], |r| Ok(json!({"memoryId":r.get::<_,String>(0)?,"revision":r.get::<_,i64>(1)?,"kind":r.get::<_,String>(2)?,"label":r.get::<_,String>(3)?,"facets":serde_json::from_str::<Value>(&r.get::<_,String>(4)?).unwrap_or(json!({}))})))?.collect::<std::result::Result<Vec<_>,_>>()?;
    let mut named = headings
        .iter()
        .filter_map(|h| h["facets"]["entity"].as_str())
        .filter(|e| !e.is_empty() && query.names_entity(e))
        .map(str::to_owned)
        .collect::<Vec<_>>();
    named.sort();
    named.dedup();
    let mut groups = BTreeMap::<String, Vec<Value>>::new();
    let mut shapes = std::collections::HashSet::new();
    let mut headings = headings
        .into_iter()
        .filter(|h| applicable(&h["facets"], &named, as_of))
        .collect::<Vec<_>>();
    let expression = query.index_expression();
    let mut hits = std::collections::HashSet::<String>::new();
    if !expression.is_empty() {
        let mut matches = conn.prepare("SELECT memory_id FROM memory_lexical WHERE memory_lexical MATCH ?1 AND memory_id IN (SELECT id FROM memories WHERE (?2 IS NULL OR project_id=?2))")?;
        hits = matches
            .query_map(params![expression, scope], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<_, _>>()?;
    }
    headings.sort_by_key(|h| {
        (
            std::cmp::Reverse(hits.contains(h["memoryId"].as_str().unwrap_or(""))),
            h["memoryId"].as_str().unwrap_or("").to_owned(),
        )
    });
    for heading in headings {
        let shape: String = heading["label"]
            .as_str()
            .unwrap_or("")
            .chars()
            .filter(|c| !c.is_ascii_digit() && !c.is_whitespace())
            .collect();
        let entity = heading["facets"]["entity"].as_str().unwrap_or("");
        let key = format!(
            "{entity}:{}:{}",
            heading["facets"]["topic"].as_str().unwrap_or(""),
            heading["kind"].as_str().unwrap_or("")
        );
        if shapes.insert(format!("{key}:{shape}")) {
            groups.entry(key).or_default().push(heading);
        }
    }
    let total_headings: usize = groups.values().map(Vec::len).sum();
    let mut groups = groups.into_values().collect::<Vec<_>>();
    groups.sort_by_key(|items| {
        std::cmp::Reverse(
            items
                .first()
                .is_some_and(|h| hits.contains(h["memoryId"].as_str().unwrap_or(""))),
        )
    });
    let mut catalog = Vec::new();
    let mut catalog_chars = 0;
    for offset in 0..24 {
        for group in &groups {
            if let Some(heading) = group.get(offset) {
                // The short body label already contains the organization's
                // literal words. Do not repeat its full facets in navigation.
                let heading = json!({"memoryId":heading["memoryId"],"revision":heading["revision"],"label":heading["label"]});
                let size = heading.to_string().chars().count();
                if catalog.len() < 24 && catalog_chars + size <= 4000 {
                    catalog_chars += size;
                    catalog.push(heading);
                }
            }
        }
    }
    // Score the complete eligible scope. Computing IDF only over the OR-match
    // subset overvalues common query words and changes as rewrites are added.
    // The existing scan/byte limits bound this local work; FTS remains a derived
    // catalog-navigation cache, never the authority for fact eligibility.
    let mut statement = conn.prepare(&format!("SELECT m.id,m.project_id,m.kind,m.content,m.revision,m.source_title,r.id,r.origin,m.updated_at,coalesce(f.facets,'{{}}') {eligible} ORDER BY m.id"))?;
    let read = |row: &rusqlite::Row<'_>| -> rusqlite::Result<Value> {
        Ok(
            json!({"id":row.get::<_,String>(0)?,"memoryId":row.get::<_,String>(0)?,"projectId":row.get::<_,String>(1)?,"kind":row.get::<_,String>(2)?,"content":row.get::<_,String>(3)?,"revision":row.get::<_,i64>(4)?,"sourceTitle":row.get::<_,String>(5)?,"revisionId":row.get::<_,String>(6)?,"origin":row.get::<_,String>(7)?,"updatedAt":row.get::<_,String>(8)?,"facets":serde_json::from_str::<Value>(&row.get::<_,String>(9)?).unwrap_or(json!({}))}),
        )
    };
    let corpus = statement
        .query_map(params![scope], read)?
        .collect::<std::result::Result<Vec<_>, _>>()?
        .into_iter()
        .filter(|m| applicable(&m["facets"], &named, as_of))
        .collect::<Vec<_>>();
    let scores = query.rank(
        &corpus
            .iter()
            .map(|m| m["content"].as_str().unwrap())
            .collect::<Vec<_>>(),
    );
    let matched = scores.iter().filter(|score| **score > 0.0).count();
    let mut ranked = corpus
        .iter()
        .cloned()
        .zip(scores.iter().copied())
        .filter(|(_, score)| *score > 0.0 || include_unmatched)
        .collect::<Vec<_>>();
    ranked.sort_by(|(a, sa), (b, sb)| {
        sb.total_cmp(sa)
            .then_with(|| b["updatedAt"].as_str().cmp(&a["updatedAt"].as_str()))
            .then_with(|| a["id"].as_str().cmp(&b["id"].as_str()))
    });
    let mut duplicates = std::collections::HashSet::new();
    let before_dedup = ranked.len();
    ranked.retain(|(m, _)| {
        duplicates.insert(format!(
            "{}:{}:{}:{}",
            m["projectId"], m["kind"], m["content"], m["facets"]
        ))
    });
    let duplicate_count = before_dedup - ranked.len();
    let limited = ranked.len() > limit;

    // Expand only to other current confirmed memories linked to the same or
    // adjacent source segment. Source text is not returned as a fact, and all
    // expanded records have already passed scope, conflict, entity and time
    // checks. Prefer one neighbor after three direct matches; if direct matches
    // run out, remaining context may fill slots within the same absolute quotas.
    let mut neighbors = Vec::new();
    let mut navigation = Vec::new();
    let mut section_reserved = Vec::new();
    let mut section_members = BTreeMap::<String, Value>::new();
    if !include_unmatched && limit >= 4 && !ranked.is_empty() {
        let mut links = BTreeMap::<String, Vec<(String, i64)>>::new();
        let mut segment_texts = BTreeMap::new();
        let mut link_stmt = conn.prepare("SELECT m.id,s.id,g.ordinal,g.text FROM memories m JOIN revisions r ON r.memory_id=m.id AND r.number=m.revision AND r.content=m.content JOIN revision_evidence e ON e.revision_id=r.id JOIN segments g ON g.id=e.segment_id JOIN sources s ON s.id=g.source_id AND s.project_id=m.project_id AND s.status='ready' WHERE (?1 IS NULL OR m.project_id=?1) AND m.state='active' ORDER BY m.id,s.id,g.ordinal")?;
        let rows = link_stmt.query_map([scope], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, String>(3)?,
            ))
        })?;
        for row in rows {
            let (memory, source, ordinal, text) = row?;
            segment_texts
                .entry((source.clone(), ordinal))
                .or_insert(text);
            links.entry(memory).or_default().push((source, ordinal));
        }
        let mut anchors = Vec::new();
        let mut anchor_segments = Vec::new();
        let mut anchor_bodies = Vec::new();
        let mut seen_segments = std::collections::HashSet::new();
        for anchor in &ranked {
            if let Some(entries) = links.get(anchor.0["id"].as_str().unwrap()) {
                let mut added = false;
                for entry in entries {
                    if anchor_segments.len() < 6 && seen_segments.insert(entry.clone()) {
                        anchor_segments.push(entry.clone());
                        anchor_bodies.push(anchor.0["content"].as_str().unwrap());
                        added = true;
                    }
                }
                if added {
                    anchors.push(anchor);
                }
            }
            if anchor_segments.len() >= 6 {
                break;
            }
        }
        let direct_ids = anchors
            .iter()
            .map(|(m, _)| m["id"].as_str().unwrap())
            .collect::<std::collections::HashSet<_>>();
        let mut neighbor_groups = vec![Vec::new(); anchor_segments.len()];
        for (memory, score) in corpus.iter().zip(scores.iter().copied()) {
            let id = memory["id"].as_str().unwrap();
            if direct_ids.contains(id) {
                continue;
            }
            let Some(candidate_links) = links.get(id) else {
                continue;
            };
            let priority = candidate_links
                .iter()
                .flat_map(|(source, ordinal)| {
                    anchor_segments
                        .iter()
                        .enumerate()
                        .filter(move |(_, (other, n))| other == source && ordinal.abs_diff(*n) <= 1)
                        .map(move |(rank, (_, n))| (ordinal.abs_diff(*n), rank))
                })
                .min();
            if let Some((distance, rank)) = priority {
                let gap = if distance == 0 {
                    segment_texts
                        .get(&anchor_segments[rank])
                        .and_then(|source| {
                            body_gap(
                                source,
                                anchor_bodies[rank],
                                memory["content"].as_str().unwrap(),
                            )
                        })
                } else {
                    None
                };
                neighbor_groups[rank].push((
                    distance,
                    gap.unwrap_or(usize::MAX),
                    memory.clone(),
                    score,
                ));
            }
        }
        // One dense paragraph must not consume every neighbor slot. Match a
        // candidate to its closest independent segment, prefer same-segment
        // evidence inside each group, then take groups in rounds.
        for group in &mut neighbor_groups {
            group.sort_by(|(da, ga, a, sa), (db, gb, b, sb)| {
                da.cmp(db)
                    .then_with(|| ga.cmp(gb))
                    .then_with(|| sb.total_cmp(sa))
                    .then_with(|| stable_memory_order(a, b))
            });
        }
        for round in 0..neighbor_groups.iter().map(Vec::len).max().unwrap_or(0) {
            for (rank, group) in neighbor_groups.iter().enumerate() {
                if let Some((distance, _, memory, score)) = group.get(round) {
                    neighbors.push(((round, rank, *distance), memory.clone(), *score));
                }
            }
        }

        if named.is_empty() && survey_question(query) {
            // A section introduction is a structural directory entry. Walk a
            // bounded forward window instead of treating its first paragraph
            // as the complete section. No benchmark marker or title is parsed,
            // and every returned body is still a current eligible formal fact.
            let mut section_anchors = Vec::new();
            let mut seen_sections = std::collections::HashSet::new();
            for (memory, score) in &ranked {
                if *score <= 0.0 || !section_introduction(memory["content"].as_str().unwrap()) {
                    continue;
                }
                for entry in links
                    .get(memory["id"].as_str().unwrap())
                    .into_iter()
                    .flatten()
                {
                    if section_anchors.is_empty() && seen_sections.insert(entry.clone()) {
                        section_anchors.push((entry.clone(), memory.clone(), *score));
                    }
                }
            }
            for ((source, anchor_ordinal), anchor, anchor_score) in section_anchors {
                let directory_id = anchor["id"].as_str().unwrap().to_owned();
                section_members.insert(directory_id.clone(),json!({"role":"directory","sourceId":source,
                    "ordinal":anchor_ordinal,"revisionId":anchor["revisionId"],"anchorMemoryId":directory_id,
                    "navigationOnly":true,"identityInferred":false}));
                section_reserved.push((anchor, anchor_score, "section_directory"));
                let mut by_segment = BTreeMap::<i64, Vec<(usize, Value, f64)>>::new();
                for (memory, score) in corpus.iter().zip(scores.iter().copied()) {
                    for (candidate_source, ordinal) in links
                        .get(memory["id"].as_str().unwrap())
                        .into_iter()
                        .flatten()
                    {
                        if candidate_source != &source
                            || *ordinal <= anchor_ordinal
                            || ordinal.abs_diff(anchor_ordinal) > 6
                        {
                            continue;
                        }
                        let offset = segment_texts
                            .get(&(source.clone(), *ordinal))
                            .and_then(|text| text.find(memory["content"].as_str().unwrap()))
                            .unwrap_or(usize::MAX);
                        by_segment.entry(*ordinal).or_default().push((
                            offset,
                            memory.clone(),
                            score,
                        ));
                    }
                }
                for (sequence, (ordinal, mut members)) in by_segment.into_iter().take(4).enumerate()
                {
                    members.sort_by(|(oa, a, sa), (ob, b, sb)| {
                        oa.cmp(ob)
                            .then_with(|| sb.total_cmp(sa))
                            .then_with(|| stable_memory_order(a, b))
                    });
                    let (_, head, head_score) = members.remove(0);
                    let head_body = head["content"].as_str().unwrap();
                    members.retain(|(_, memory, _)| memory["content"] != head["content"]);
                    members.sort_by(|(oa, a, sa), (ob, b, sb)| {
                        complement_score(head_body, b["content"].as_str().unwrap())
                            .cmp(&complement_score(head_body, a["content"].as_str().unwrap()))
                            .then_with(|| oa.cmp(ob))
                            .then_with(|| sb.total_cmp(sa))
                            .then_with(|| stable_memory_order(a, b))
                    });
                    let mut group = vec![(head, head_score)];
                    if let Some((_, complement, score)) = members.into_iter().next() {
                        group.push((complement, score));
                    }
                    let ids = group
                        .iter()
                        .map(|(memory, _)| memory["id"].clone())
                        .collect::<Vec<_>>();
                    for (index, (memory, score)) in group.into_iter().enumerate() {
                        section_members.insert(memory["id"].as_str().unwrap().to_owned(),json!({
                            "role":if index==0{"head"}else{"complement"},"groupId":format!("{source}:{anchor_ordinal}:{ordinal}"),
                            "sequenceIndex":sequence,"memberMemoryIds":ids,"sourceId":source,"ordinal":ordinal,
                            "revisionId":memory["revisionId"],"anchorMemoryId":directory_id,
                            "navigationOnly":true,"identityInferred":false}));
                        section_reserved.push((memory, score, "section_group_context"));
                    }
                }
            }
        }

        if named.is_empty() && query.navigates_data_context() {
            // Broad data questions otherwise keep retrieving a component's
            // repeated "training/model" sentences. Preserve a few alternative
            // data-origin and study-declaration sentences from the SAME ready
            // source; these are navigation cues, not an inferred task identity.
            let anchor_sources = anchors
                .iter()
                .filter_map(|(m, _)| links.get(m["id"].as_str().unwrap()))
                .flatten()
                .map(|(source, _)| source.as_str())
                .collect::<std::collections::HashSet<_>>();
            let mut provenance = Vec::new();
            let mut studies = Vec::new();
            for (memory, score) in corpus.iter().zip(scores.iter().copied()) {
                let id = memory["id"].as_str().unwrap();
                let Some(segment) = links.get(id).and_then(|entries| {
                    entries
                        .iter()
                        .find(|(source, _)| anchor_sources.contains(source.as_str()))
                }) else {
                    continue;
                };
                let body = memory["content"].as_str().unwrap();
                let title_score =
                    Query::new(memory["sourceTitle"].as_str().unwrap_or("")).score("", body);
                if crate::search::data_provenance(body) {
                    provenance.push((title_score, score, memory.clone(), segment.clone()));
                }
                if crate::search::study_context(body) {
                    studies.push((title_score, score, memory.clone()));
                }
            }
            let sort = |a: &(usize, f64, Value), b: &(usize, f64, Value)| {
                b.0.cmp(&a.0)
                    .then_with(|| b.1.total_cmp(&a.1))
                    .then_with(|| stable_memory_order(&a.2, &b.2))
            };
            provenance.sort_by(|a, b| {
                b.0.cmp(&a.0)
                    .then_with(|| b.1.total_cmp(&a.1))
                    .then_with(|| stable_memory_order(&a.2, &b.2))
            });
            studies.sort_by(sort);
            // Before spending another navigation slot on one stage, offer a
            // distinct confirmed source segment. A stage label is not inferred;
            // this is diversity of provenance, not a task-identity assertion.
            let mut segments = std::collections::HashSet::new();
            let mut distinct = Vec::new();
            let mut repeated = Vec::new();
            for candidate in provenance {
                if segments.insert(candidate.3.clone()) {
                    distinct.push(candidate)
                } else {
                    repeated.push(candidate)
                }
            }
            let mut provenance = distinct.into_iter().chain(repeated);
            if let Some((_, score, memory, _)) = provenance.next() {
                navigation.push((memory, score, "data_provenance"));
            }
            if let Some((_, score, memory)) = studies.into_iter().next() {
                navigation.push((memory, score, "study_context"));
            }
            navigation.extend(
                provenance
                    .take(2)
                    .map(|(_, score, memory, _)| (memory, score, "data_provenance")),
            );
        }
    }
    let mut selected = Vec::new();
    let mut selected_shapes = std::collections::HashSet::new();
    let mut direct = ranked.into_iter();
    let mut adjacent = neighbors.into_iter();
    let mut navigation = navigation.into_iter();
    let shape = |m: &Value| {
        format!(
            "{}:{}:{}:{}",
            m["projectId"], m["kind"], m["content"], m["facets"]
        )
    };
    let mut adjacent_count = 0;
    // Preserve the original three-direct/one-neighbor schedule's maximum,
    // including after the direct queue is exhausted (24 results => 6 neighbors).
    let adjacent_limit = limit / 4;
    let mut navigation_count = 0;
    let mut section_forward_count = 0;
    while selected.len() < limit {
        let use_neighbor = selected.len() % 4 == 3 && adjacent_count < adjacent_limit;
        let use_navigation = section_reserved.is_empty()
            && selected.len() % 4 == 2
            && navigation_count < (limit / 6).min(4);
        let next_navigation = use_navigation
            .then(|| {
                navigation
                    .by_ref()
                    .find(|(m, _, _)| !selected_shapes.contains(&shape(m)))
            })
            .flatten();
        let next = if next_navigation.is_some() {
            next_navigation
        } else if use_neighbor {
            adjacent
                .by_ref()
                .find(|(_, m, _)| !selected_shapes.contains(&shape(m)))
                .map(|(_, m, score)| (m, score, "adjacent_confirmed"))
                .or_else(|| {
                    direct
                        .by_ref()
                        .find(|(m, _)| !selected_shapes.contains(&shape(m)))
                        .map(|(m, s)| (m, s, "direct_lexical"))
                })
        } else {
            direct
                .by_ref()
                .find(|(m, _)| !selected_shapes.contains(&shape(m)))
                .map(|(m, s)| (m, s, "direct_lexical"))
        }
        .or_else(|| {
            // Sparse matches must not make already-eligible context unreachable
            // merely because the next scheduled navigation slot was not reached.
            (section_reserved.is_empty() && navigation_count < (limit / 6).min(4))
                .then(|| {
                    navigation
                        .by_ref()
                        .find(|(m, _, _)| !selected_shapes.contains(&shape(m)))
                })
                .flatten()
        })
        .or_else(|| {
            (adjacent_count < adjacent_limit)
                .then(|| {
                    adjacent
                        .by_ref()
                        .find(|(_, m, _)| !selected_shapes.contains(&shape(m)))
                        .map(|(_, m, score)| (m, score, "adjacent_confirmed"))
                })
                .flatten()
        });
        let Some((memory, score, reason)) = next else {
            break;
        };
        selected_shapes.insert(shape(&memory));
        adjacent_count += usize::from(reason == "adjacent_confirmed");
        navigation_count += usize::from(matches!(reason, "data_provenance" | "study_context"));
        selected.push((memory, score, reason));
    }
    if !section_reserved.is_empty() {
        // Reserve the directory and four bounded paragraph groups inside the
        // same local limit; they replace lower-ranked generic matches, rather
        // than appending facts beyond the candidate or model budgets.
        let previous = std::mem::take(&mut selected);
        let prefix = previous.iter().take(2).cloned().collect::<Vec<_>>();
        let mut shapes = std::collections::HashSet::new();
        for candidate in prefix
            .into_iter()
            .chain(section_reserved)
            .chain(previous.into_iter().skip(2))
        {
            if selected.len() < limit && shapes.insert(shape(&candidate.0)) {
                selected.push(candidate);
            }
        }
        adjacent_count = selected
            .iter()
            .filter(|(_, _, reason)| *reason == "adjacent_confirmed")
            .count();
        let groups = selected
            .iter()
            .filter_map(|(memory, _, _)| section_members.get(memory["id"].as_str().unwrap()))
            .filter_map(|group| group["groupId"].as_str())
            .collect::<std::collections::HashSet<_>>();
        navigation_count = groups.len();
        section_forward_count = selected
            .iter()
            .filter(|(_, _, reason)| *reason == "section_group_context")
            .count();
    }
    let ranking = selected
        .iter()
        .map(|(m, s, reason)| json!({"id":m["id"],"score":s,"selectionReason":reason}))
        .collect::<Vec<_>>();
    let mut records = selected
        .into_iter()
        .map(|(memory, _, _)| memory)
        .collect::<Vec<_>>();
    // Derive from full current text before excerpting. The resulting edges are
    // audit/navigation metadata only; no source material replaces a formal fact.
    let link_trace = crate::memory_links::derive(conn, &mut records)?;
    for memory in &mut records {
        if let Some(group) = section_members.get(memory["id"].as_str().unwrap()) {
            if memory["navigationLinks"]["sourcePositions"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|position| {
                    position["sourceId"] == group["sourceId"]
                        && position["ordinal"] == group["ordinal"]
                })
                && group["revisionId"] == memory["revisionId"]
            {
                memory["navigationLinks"]["sectionGroup"] = group.clone();
            }
        }
        let full = memory["content"].as_str().unwrap();
        let excerpt = query.excerpt(full, excerpt_chars);
        let full_hash = hash(full.as_bytes());
        let truncated = excerpt != full;
        memory["contentHash"] = json!(full_hash);
        memory["truncated"] = json!(truncated);
        memory["content"] = json!(excerpt);
    }
    Ok(Selection {
        trace: json!({"version":"organized-memory-v12-sparse-context-fallback","scanned":scanned,
        "indexBackend":"fts5-derived-v3","matched":matched,"returned":records.len(),"limited":limited,"ranking":ranking,"exactDuplicatesCollapsed":duplicate_count,"adjacentConfirmed":adjacent_count,"sourceNavigation":navigation_count,
        "candidateLimit":MAX_CANDIDATES,"navigationLinks":link_trace,
        "sectionForwardNavigation":section_forward_count,"sectionForwardMaxSegments":6,"maxSourceNavigation":4,
        "sectionMaxGroups":4,"sectionMaxFactsPerGroup":2,"sectionDirectoryLimit":1,
        "catalogEntries":catalog.len(),"catalogLimited":catalog.len()<total_headings,"catalogMaxEntries":24,"catalogMaxChars":4000,"catalogChars":catalog_chars}),
        records,
        catalog: json!(catalog),
    })
}

// No triggers: importing a backup cannot install executable database hooks.
// Changed revisions are rebuilt lazily; the index is never used as evidence.
fn sync_index(conn: &Connection, scope: Option<&str>) -> Result<()> {
    let mut stale = conn.prepare("SELECT i.rowid FROM memory_lexical_state i LEFT JOIN memories m ON m.id=i.memory_id LEFT JOIN revisions r ON r.id=i.revision_id AND r.memory_id=m.id AND r.number=m.revision AND r.content=m.content LEFT JOIN memory_lexical l ON l.rowid=i.rowid WHERE r.id IS NULL OR l.rowid IS NULL OR substr(l.terms,1,length(?1)+1)<>?1||' '")?;
    let stale_rows = stale
        .query_map([INDEX_VERSION], |r| r.get::<_, i64>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    for rowid in stale_rows {
        conn.execute("DELETE FROM memory_lexical WHERE rowid=?", [rowid])?;
        conn.execute("DELETE FROM memory_lexical_state WHERE rowid=?", [rowid])?;
    }
    let mut stmt = conn.prepare("SELECT m.id,r.id,m.content FROM memories m JOIN revisions r ON r.memory_id=m.id AND r.number=m.revision AND r.content=m.content WHERE (?1 IS NULL OR m.project_id=?1) AND NOT EXISTS(SELECT 1 FROM memory_lexical_state i WHERE i.memory_id=m.id AND i.revision_id=r.id)")?;
    let rows = stmt
        .query_map([scope], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let tx = if conn.is_autocommit() {
        Some(conn.unchecked_transaction()?)
    } else {
        None
    };
    for (memory, revision, content) in rows {
        let terms = crate::search::index_tokens(&content)
            .into_iter()
            .collect::<Vec<_>>()
            .join(" ");
        let terms = format!("{INDEX_VERSION} {terms}");
        let label: String = content.chars().take(100).collect();
        conn.execute(
            "INSERT INTO memory_lexical_state(memory_id,revision_id,label) VALUES(?,?,?)",
            params![memory, revision, label],
        )?;
        let rowid = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO memory_lexical(rowid,memory_id,revision_id,label,terms) VALUES(?,?,?,?,?)",
            params![rowid, memory, revision, label, terms],
        )?;
    }
    if let Some(tx) = tx {
        tx.commit()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn add_memory(conn: &Connection, id: &str, project: &str, content: &str, facets: Value) {
        conn.execute(
            "INSERT INTO memories VALUES(?1,?2,'fact',?3,1,'active','资料','now','now')",
            params![id, project, content],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO revisions VALUES(?1,?1,1,?2,'','user_correction','now')",
            params![id, content],
        )
        .unwrap();
        memory_facts::save(conn, id, &facets, content).unwrap();
    }
    fn database() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;")
            .unwrap();
        crate::db::migrate(&conn).unwrap();
        conn.execute_batch("INSERT INTO projects VALUES('p','项目','','now'); INSERT INTO projects VALUES('other','隔离','','now');").unwrap();
        for (id, project, content, entity) in [
            ("a", "p", "泽川二次验证必须使用硬件密钥。", "泽川"),
            ("b", "p", "天衡二次验证可以使用短信。", "天衡"),
            ("c", "other", "PRIVATE泽川二次验证允许邮箱。", "泽川"),
        ] {
            conn.execute(
                "INSERT INTO memories VALUES(?1,?2,'fact',?3,1,'active','资料','now','now')",
                params![id, project, content],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO revisions VALUES(?1,?1,1,?2,'','user_correction','now')",
                params![id, content],
            )
            .unwrap();
            memory_facts::save(&conn, id, &json!({"entity":entity}), content).unwrap();
        }
        conn
    }
    #[test]
    fn index_filters_entity_and_scope_and_rebuilds_changed_revisions() {
        let conn = database();
        let query = Query::new("泽川二次验证规则");
        let select = || retrieve(&conn, Some("p"), &query, 6, 4000, false, "2026-10-20").unwrap();
        let first = select();
        assert_eq!(first.records.len(), 1);
        assert_eq!(first.records[0]["id"], "a");
        assert!(!first.catalog.to_string().contains("PRIVATE"));
        assert!(!first.catalog.to_string().contains("天衡"));
        assert_eq!(first.trace, select().trace);
        conn.execute_batch("INSERT INTO revisions VALUES('a2','a',2,'泽川二次验证规则待重新核定。','','user_correction','later'); UPDATE memories SET revision=2,content='泽川二次验证规则待重新核定。' WHERE id='a';").unwrap();
        let next = select();
        assert_eq!(next.records[0]["revision"], 2);
        assert_eq!(next.records[0]["facets"], json!({}));
        assert!(!next.records[0]["content"]
            .as_str()
            .unwrap()
            .contains("硬件"));
        assert_eq!(
            conn.query_row(
                "SELECT count(*) FROM memory_lexical WHERE revision_id='a'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
    }

    #[test]
    fn local_candidate_pool_is_bounded_separately_from_the_model_pack() {
        let conn = database();
        for number in 0..70 {
            add_memory(
                &conn,
                &format!("atlas{number:02}"),
                "p",
                &format!("Atlas pipeline uses configuration option {number}."),
                json!({}),
            );
        }
        let selected = retrieve(
            &conn,
            Some("p"),
            &Query::new("Atlas pipeline"),
            1_000,
            4_000,
            false,
            "2026-10-20",
        )
        .unwrap();
        assert_eq!(selected.records.len(), MAX_CANDIDATES);
        assert_eq!(selected.trace["candidateLimit"], MAX_CANDIDATES);
        assert_eq!(selected.trace["limited"], true);
        assert_eq!(
            selected.trace["ranking"].as_array().unwrap().len(),
            MAX_CANDIDATES
        );
        let pack = crate::evidence_pack::select("Atlas pipeline", &selected.records, 24, 36_000);
        assert_eq!(pack.references.len(), 24);
        assert_eq!(pack.trace["candidateCount"], MAX_CANDIDATES);
        assert!(pack
            .references
            .iter()
            .all(|record| selected.records.contains(record)));
    }

    #[test]
    fn survey_section_navigation_rotates_forward_paragraphs_without_source_text_as_facts() {
        let conn = database();
        conn.execute_batch("INSERT INTO sources VALUES('survey-source','p','Survey','text','survey.txt',NULL,'now','survey-hash','ready',5,NULL,'');").unwrap();
        let introduction = "In this section we discuss the state of the art on retrieval systems.";
        let bodies = [
            introduction,
            "Orion is a rule-driven system.",
            "Vega uses statistical retrieval.",
            "Lyra combines rules and corpus evidence.",
            "Draco is a conversational system.",
        ];
        let complements = [
            "",
            "Orion applies substitution rules only to archived reports.",
            "Vega ranks items by a probability score with the recorded conditions.",
            "Lyra cannot return a deleted record without renewed approval.",
            "In blinded tests Draco was rated as human in 67 percent of trials.",
        ];
        for (ordinal, body) in bodies.iter().enumerate() {
            let id = format!("section{ordinal}");
            add_memory(&conn, &id, "p", body, json!({}));
            conn.execute(
                "INSERT INTO segments VALUES(?,'survey-source','v',?,'paragraph',?)",
                params![
                    format!("g{ordinal}"),
                    ordinal as i64,
                    format!("{body} {}", complements[ordinal])
                ],
            )
            .unwrap();
            if ordinal > 0 {
                let detail_id = format!("detail{ordinal}");
                add_memory(&conn, &detail_id, "p", complements[ordinal], json!({}));
                conn.execute(
                    "INSERT INTO revision_evidence VALUES(?,?)",
                    params![detail_id, format!("g{ordinal}")],
                )
                .unwrap();
            }
            conn.execute(
                "INSERT INTO revision_evidence VALUES(?,?)",
                params![id, format!("g{ordinal}")],
            )
            .unwrap();
        }
        for (id, project, body, facets) in [
            (
                "expired",
                "p",
                "Expired system was available until 2025-01-01.",
                json!({"validUntil":"2025-01-01"}),
            ),
            (
                "foreign",
                "other",
                "FOREIGN_SURVEY_SECRET is available.",
                json!({}),
            ),
        ] {
            add_memory(&conn, id, project, body, facets);
            conn.execute("INSERT INTO revision_evidence VALUES(?,'g4')", [id])
                .unwrap();
        }
        for number in 0..40 {
            add_memory(
                &conn,
                &format!("direct{number}"),
                "p",
                &format!("The state of the art covers system architecture category {number}."),
                json!({}),
            );
        }
        let result = retrieve(
            &conn,
            Some("p"),
            &Query::new("What is the state of the art described in the paper?"),
            64,
            4_000,
            false,
            "2026-10-20",
        )
        .unwrap();
        let pack = crate::evidence_pack::select(
            "What is the state of the art described in the paper?",
            &result.records,
            24,
            36_000,
        );
        for number in 1..=4 {
            let id = format!("section{number}");
            assert!(
                result.records.iter().any(|record| record["id"] == id),
                "candidate {id}"
            );
            assert!(
                pack.references.iter().any(|record| record["id"] == id),
                "actual pack {id}"
            );
            let detail_id = format!("detail{number}");
            assert!(result
                .records
                .iter()
                .any(|record| record["id"] == detail_id));
            assert!(
                pack.references
                    .iter()
                    .any(|record| record["id"] == detail_id),
                "full complementary fact {detail_id}"
            );
        }
        assert_eq!(result.trace["sectionForwardNavigation"], 8);
        assert_eq!(result.trace["sourceNavigation"], 4);
        assert!(pack.references.iter().any(|reference| reference["content"]
            .as_str()
            .unwrap()
            .contains("cannot return a deleted record without renewed approval")));
        assert!(
            !json!(crate::answer_contract::indexed_references(&pack.references))
                .to_string()
                .contains("sectionGroup")
        );
        assert!(!result
            .records
            .iter()
            .any(|record| matches!(record["id"].as_str(), Some("expired" | "foreign"))));
        let ordinary = retrieve(
            &conn,
            Some("p"),
            &Query::new("Which system architecture is used?"),
            64,
            4_000,
            false,
            "2026-10-20",
        )
        .unwrap();
        assert_eq!(ordinary.trace["sectionForwardNavigation"], 0);
    }
    #[test]
    fn validity_is_explicit_and_does_not_inherit_occurrence_time() {
        let conn = database();
        conn.execute_batch("DELETE FROM revision_facets WHERE revision_id='a'; UPDATE memories SET content='泽川二次验证在2026-01-01至2026-06-30使用硬件密钥。' WHERE id='a'; UPDATE revisions SET content='泽川二次验证在2026-01-01至2026-06-30使用硬件密钥。' WHERE id='a';").unwrap();
        memory_facts::save(
            &conn,
            "a",
            &json!({"entity":"泽川","validFrom":"2026-01-01","validUntil":"2026-06-30"}),
            "泽川二次验证在2026-01-01至2026-06-30使用硬件密钥。",
        )
        .unwrap();
        for (date, count) in [("2026-02-01", 1), ("2026-10-20", 0)] {
            assert_eq!(
                retrieve(
                    &conn,
                    Some("p"),
                    &Query::new("泽川硬件密钥"),
                    6,
                    4000,
                    false,
                    date
                )
                .unwrap()
                .records
                .len(),
                count
            );
        }
    }

    #[test]
    fn generic_subjects_do_not_create_scope_but_named_subjects_stay_isolated() {
        let conn = database();
        add_memory(
            &conn,
            "model",
            "p",
            "The model uses a worker pool.",
            json!({"entity":"The model"}),
        );
        add_memory(
            &conn,
            "we",
            "p",
            "We use Atlas for the image encoder.",
            json!({"entity":"We"}),
        );
        add_memory(
            &conn,
            "atlas",
            "p",
            "Atlas uses a bounded worker pool.",
            json!({"entity":"Atlas"}),
        );
        add_memory(
            &conn,
            "vega",
            "p",
            "Vega uses an unbounded worker pool.",
            json!({"entity":"Vega"}),
        );
        add_memory(
            &conn,
            "outside",
            "other",
            "Atlas uses a PRIVATE image encoder.",
            json!({"entity":"Atlas"}),
        );
        let generic = retrieve(
            &conn,
            Some("p"),
            &Query::new("What does the model use?"),
            30,
            4000,
            false,
            "2026-10-20",
        )
        .unwrap();
        let ids = generic
            .records
            .iter()
            .map(|m| m["id"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert!(ids.contains(&"atlas") && ids.contains(&"vega") && ids.contains(&"we"));
        let named = retrieve(
            &conn,
            Some("p"),
            &Query::new("How does Atlas use an image encoder?"),
            30,
            4000,
            false,
            "2026-10-20",
        )
        .unwrap();
        let ids = named
            .records
            .iter()
            .map(|m| m["id"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert!(ids.contains(&"atlas") && ids.contains(&"we"));
        assert!(!ids.contains(&"vega") && !ids.contains(&"outside"));
        assert_eq!(
            named.records.iter().find(|m| m["id"] == "we").unwrap()["facets"]["entity"],
            "We"
        );
        assert!(!named.catalog.to_string().contains("PRIVATE"));
    }

    #[test]
    fn old_derived_index_is_rebuilt_for_morphology_and_survives_repeat_reads() {
        let conn = database();
        add_memory(
            &conn,
            "encoder",
            "p",
            "An encoder transforms every image.",
            json!({}),
        );
        conn.execute("INSERT INTO memory_lexical_state(memory_id,revision_id,label) VALUES('encoder','encoder','legacy')", []).unwrap();
        let rowid = conn.last_insert_rowid();
        conn.execute("INSERT INTO memory_lexical(rowid,memory_id,revision_id,label,terms) VALUES(?,'encoder','encoder','legacy','lexicalschema2 encoder transforms image')", [rowid]).unwrap();
        let select = || {
            retrieve(
                &conn,
                Some("p"),
                &Query::new("Which component encodes images?"),
                6,
                4000,
                false,
                "2026-10-20",
            )
            .unwrap()
        };
        let first = select();
        assert_eq!(first.records[0]["id"], "encoder");
        let terms: String = conn
            .query_row(
                "SELECT terms FROM memory_lexical WHERE memory_id='encoder'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(terms.starts_with("lexicalschema3 "));
        assert!(terms.split_whitespace().any(|t| t == "encod"));
        assert_eq!(first.trace, select().trace);
        assert_eq!(first.records, select().records);
    }

    #[test]
    fn only_exact_same_content_and_facets_are_deduplicated() {
        let conn = database();
        let content = "Atlas access lasts 30 days during trials, and 60 days after approval.";
        add_memory(
            &conn,
            "same1",
            "p",
            content,
            json!({"entity":"Atlas","conditions":["during trials"]}),
        );
        add_memory(
            &conn,
            "same2",
            "p",
            content,
            json!({"entity":"Atlas","conditions":["during trials"]}),
        );
        add_memory(
            &conn,
            "different-scope",
            "p",
            content,
            json!({"entity":"Atlas","conditions":["after approval"]}),
        );
        add_memory(
            &conn,
            "opposite",
            "p",
            "Atlas access does not last 30 days.",
            json!({"entity":"Atlas"}),
        );
        let result = retrieve(
            &conn,
            Some("p"),
            &Query::new("Atlas access days"),
            20,
            4000,
            false,
            "2026-10-20",
        )
        .unwrap();
        assert_eq!(result.records.len(), 3);
        assert_eq!(result.trace["exactDuplicatesCollapsed"], 1);
        assert!(result.records.iter().any(|m| m["id"] == "different-scope"));
        assert!(result.records.iter().any(|m| m["id"] == "opposite"));
    }

    #[test]
    fn adjacent_context_is_confirmed_current_scoped_and_time_valid() {
        let conn = database();
        for (id, project, body, facets) in [
            (
                "anchor",
                "p",
                "Atlas encoding uses a two-stage process.",
                json!({"entity":"Atlas"}),
            ),
            (
                "neighbor",
                "p",
                "We apply the second stage to every frame.",
                json!({"entity":"We"}),
            ),
            (
                "stale",
                "p",
                "We apply an OLD discarded instruction.",
                json!({}),
            ),
            (
                "expired",
                "p",
                "We applied this until 2025-01-01.",
                json!({"validUntil":"2025-01-01"}),
            ),
            (
                "future",
                "p",
                "This instruction starts on 2027-01-01.",
                json!({"validFrom":"2027-01-01"}),
            ),
            ("archived", "p", "An archived instruction.", json!({})),
            ("pending", "p", "An uncertain instruction.", json!({})),
            (
                "wrongentity",
                "p",
                "Vega handles the second stage.",
                json!({"entity":"Vega"}),
            ),
            (
                "private",
                "other",
                "Atlas PRIVATE credentials.",
                json!({"entity":"Atlas"}),
            ),
        ] {
            add_memory(&conn, id, project, body, facets);
        }
        conn.execute_batch("INSERT INTO sources VALUES('source','p','资料','text','a.txt',NULL,'now','hash','ready',3,NULL,'');
            INSERT INTO segments VALUES('s0','source','v',0,'line 1','Atlas encoding uses a two-stage process.');
            INSERT INTO segments VALUES('s1','source','v',1,'line 2','We apply the second stage to every frame.');
            INSERT INTO revision_evidence VALUES('anchor','s0');
            INSERT INTO revision_evidence VALUES('neighbor','s1');
            INSERT INTO revision_evidence VALUES('stale','s1');
            INSERT INTO revision_evidence VALUES('expired','s1');
            INSERT INTO revision_evidence VALUES('future','s1');
            INSERT INTO revision_evidence VALUES('archived','s1');
            INSERT INTO revision_evidence VALUES('pending','s1');
            INSERT INTO revision_evidence VALUES('wrongentity','s1');
            INSERT INTO revision_evidence VALUES('private','s1');
            UPDATE memories SET state='archived' WHERE id='archived';
            INSERT INTO proposals(id,project_id,source_id,kind,content,status,created_at,memory_id)
                VALUES('pending-proposal','p','source','fact','A replacement instruction.','pending','now',NULL);
            INSERT INTO memory_reviews VALUES('pending-review','pending-proposal','uncertain','pending',1,'An uncertain instruction.','Review required','pending','now','now');
            INSERT INTO revisions VALUES('stale2','stale',2,'We replaced the old instruction.','','user_correction','later');
            UPDATE memories SET revision=2,content='We replaced the old instruction.' WHERE id='stale';").unwrap();
        let result = retrieve(
            &conn,
            Some("p"),
            &Query::new("Atlas encoding process"),
            6,
            4000,
            false,
            "2026-10-20",
        )
        .unwrap();
        let ids = result
            .records
            .iter()
            .map(|m| m["id"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert!(ids.contains(&"neighbor"));
        for forbidden in [
            "stale",
            "expired",
            "future",
            "archived",
            "pending",
            "wrongentity",
            "private",
        ] {
            assert!(!ids.contains(&forbidden), "{forbidden}");
        }
        assert_eq!(result.trace["adjacentConfirmed"], 1);
        assert!(result.trace["ranking"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["id"] == "neighbor" && r["selectionReason"] == "adjacent_confirmed"));
    }

    #[test]
    fn sparse_matches_fill_adjacent_slots_only_within_the_existing_quota() {
        for direct_count in [1usize, 2, 4] {
            let conn = database();
            conn.execute_batch("INSERT INTO sources VALUES('sparse-source','p','Guide','text','guide.txt',NULL,'now','sparse-hash','ready',2,NULL,'');
                INSERT INTO segments VALUES('sparse-neighbor','sparse-source','v',1,'line 2','Additional details.');").unwrap();
            for n in 0..direct_count {
                let id = format!("sparse-direct-{n}");
                add_memory(
                    &conn,
                    &id,
                    "p",
                    &format!("Atlas encoding option {n}."),
                    json!({}),
                );
                conn.execute(
                    "INSERT INTO segments VALUES(?,'sparse-source','v',?,'line','Atlas encoding.')",
                    params![id, n * 10],
                )
                .unwrap();
                conn.execute("INSERT INTO revision_evidence VALUES(?1,?1)", [&id])
                    .unwrap();
            }
            for n in 0..8 {
                let id = format!("sparse-context-{n}");
                add_memory(
                    &conn,
                    &id,
                    "p",
                    &format!("Only verified staff may perform step {n}."),
                    json!({}),
                );
                conn.execute(
                    "INSERT INTO revision_evidence VALUES(?,'sparse-neighbor')",
                    [&id],
                )
                .unwrap();
            }
            for limit in [1usize, 2, 3, 6, 24] {
                let result = retrieve(
                    &conn,
                    Some("p"),
                    &Query::new("Atlas encoding"),
                    limit,
                    4000,
                    false,
                    "2026-10-20",
                )
                .unwrap();
                let neighbor_count = (limit / 4).min(limit.saturating_sub(direct_count));
                assert_eq!(result.trace["matched"], direct_count);
                assert_eq!(
                    result.trace["adjacentConfirmed"], neighbor_count,
                    "{direct_count} direct matches, limit {limit}"
                );
                assert_eq!(
                    result.records.len(),
                    direct_count.min(limit) + neighbor_count
                );
                assert!(result.records.len() <= limit);
            }

            let unmatched = retrieve(
                &conn,
                Some("p"),
                &Query::new("unrelated telescope"),
                6,
                4000,
                false,
                "2026-10-20",
            )
            .unwrap();
            assert!(unmatched.records.is_empty());
            assert_eq!(unmatched.trace["adjacentConfirmed"], 0);
            assert_eq!(unmatched.trace["sourceNavigation"], 0);
        }
    }

    #[test]
    fn sparse_data_matches_keep_source_navigation_within_the_existing_quota() {
        let conn = database();
        conn.execute_batch("INSERT INTO sources VALUES('sparse-data','p','Rainfall Prediction','text','study.txt',NULL,'now','data-hash','ready',3,NULL,'');
            INSERT INTO segments VALUES('sparse-model','sparse-data','v',0,'line 1','The model is trained using a dataset.');
            INSERT INTO segments VALUES('sparse-origin','sparse-data','v',100,'line 100','A total of 48,000 weather readings are collected from the public registry.');
            INSERT INTO segments VALUES('sparse-study','sparse-data','v',101,'line 101','In this study, we predict rainfall.');").unwrap();
        for (id, body, segment) in [
            (
                "sparse-model",
                "The model is trained using a dataset.",
                "sparse-model",
            ),
            (
                "sparse-origin",
                "A total of 48,000 weather readings are collected from the public registry.",
                "sparse-origin",
            ),
            (
                "sparse-study",
                "In this study, we predict rainfall.",
                "sparse-study",
            ),
        ] {
            add_memory(&conn, id, "p", body, json!({}));
            conn.execute(
                "INSERT INTO revision_evidence VALUES(?,?)",
                params![id, segment],
            )
            .unwrap();
        }
        for (limit, navigation_count) in [(6, 1), (12, 2)] {
            let result = retrieve(
                &conn,
                Some("p"),
                &Query::new("Which dataset is used for training?"),
                limit,
                4000,
                false,
                "2026-10-20",
            )
            .unwrap();
            assert_eq!(result.trace["matched"], 1);
            assert_eq!(result.trace["sourceNavigation"], navigation_count);
            assert_eq!(result.trace["adjacentConfirmed"], 0);
            assert_eq!(result.records.len(), navigation_count + 1);
            assert!(result.records.iter().all(|m| matches!(
                m["id"].as_str(),
                Some("sparse-model" | "sparse-origin" | "sparse-study")
            )));
            if navigation_count == 2 {
                assert!(result.records.iter().any(|m| m["id"] == "sparse-origin"));
                assert!(result.records.iter().any(|m| m["id"] == "sparse-study"));
            }
        }
    }

    fn data_navigation_database() -> Connection {
        let conn = database();
        conn.execute_batch("INSERT INTO sources VALUES('study-source','p','Rainfall Prediction from Weather Data','text','study.txt',NULL,'now','study-hash','ready',4,NULL,'');
            INSERT INTO sources VALUES('unrelated-source','p','Other Archive','text','other.txt',NULL,'now','other-hash','ready',1,NULL,'');
            INSERT INTO segments VALUES('component-segment','study-source','v',0,'line 1','The model is trained using a dataset.');
            INSERT INTO segments VALUES('provenance-segment','study-source','v',100,'line 100','Hourly readings are collected from the public registry.');
            INSERT INTO segments VALUES('study-segment','study-source','v',101,'line 101','In this study, we predict rainfall.');
            INSERT INTO segments VALUES('unrelated-segment','unrelated-source','v',0,'line 1','Data from an unrelated archive.');").unwrap();
        for n in 0..32 {
            let id = format!("component{n:02}");
            add_memory(
                &conn,
                &id,
                "p",
                &format!("The model is trained using dataset training partition {n}."),
                json!({}),
            );
            conn.execute(
                "INSERT INTO revision_evidence VALUES(?,'component-segment')",
                [&id],
            )
            .unwrap();
        }
        for (id, project, body, facets, segment) in [
            ("observations", "p", "A total of 48,000 weather readings are collected from the public registry.", json!({}), "provenance-segment"),
            ("weather-source", "p", "Hourly observations from 2022 are obtained via the municipal archive.", json!({}), "provenance-segment"),
            ("study", "p", "In this study, we predict rainfall using weather observations and seasonal histories.", json!({}), "study-segment"),
            ("disconnected", "p", "A total of 90,000 records are collected from an unrelated archive.", json!({}), "unrelated-segment"),
            ("private", "other", "A total of 70,000 PRIVATE readings are collected from another registry.", json!({}), "provenance-segment"),
            ("expired", "p", "A total of 80,000 readings were collected from a registry until 2024-01-01.", json!({"validUntil":"2024-01-01"}), "provenance-segment"),
        ] {
            add_memory(&conn, id, project, body, facets);
            conn.execute("UPDATE memories SET source_title='Rainfall Prediction from Weather Data' WHERE id=?", [id]).unwrap();
            conn.execute("INSERT INTO revision_evidence VALUES(?,?)", params![id,segment]).unwrap();
        }
        conn
    }

    #[test]
    fn broad_data_questions_include_scoped_source_and_study_alternatives_without_more_slots() {
        let conn = data_navigation_database();
        let query = Query::new("What dataset is used to train the model?");
        let result = retrieve(&conn, Some("p"), &query, 24, 4000, false, "2026-10-20").unwrap();
        let ids = result
            .records
            .iter()
            .map(|m| m["id"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(result.records.len(), 24);
        for required in ["observations", "weather-source", "study"] {
            assert!(ids.contains(&required), "{required}");
        }
        for forbidden in ["private", "expired", "disconnected"] {
            assert!(!ids.contains(&forbidden), "{forbidden}");
        }
        assert!(result.trace["sourceNavigation"].as_u64().unwrap() <= 4);
        let ranking = result.trace["ranking"].as_array().unwrap();
        assert!(ranking.iter().any(|r| r["id"] == "observations"
            && r["selectionReason"] == "data_provenance"
            && r["score"] == 0.0));
        assert!(ranking
            .iter()
            .any(|r| r["id"] == "study" && r["selectionReason"] == "study_context"));
        assert!(
            ranking
                .iter()
                .filter(|r| r["selectionReason"] == "direct_lexical")
                .count()
                > 12
        );
        assert!(result.catalog.as_array().unwrap().len() <= 24);
        assert!(result.trace["catalogChars"].as_u64().unwrap() <= 4000);
        assert!(result
            .catalog
            .as_array()
            .unwrap()
            .iter()
            .all(|h| h.get("facets").is_none()));
    }

    #[test]
    fn explicit_component_and_named_queries_do_not_infer_a_main_task() {
        let conn = data_navigation_database();
        for question in [
            "What dataset trains the classifier?",
            "编码器使用什么训练数据？",
        ] {
            let result = retrieve(
                &conn,
                Some("p"),
                &Query::new(question),
                24,
                4000,
                false,
                "2026-10-20",
            )
            .unwrap();
            assert_eq!(result.trace["sourceNavigation"], 0);
            assert!(!result.records.iter().any(|m| m["id"] == "observations"));
        }
        add_memory(
            &conn,
            "named",
            "p",
            "Atlas model is trained using the Atlas dataset.",
            json!({"entity":"Atlas"}),
        );
        conn.execute(
            "INSERT INTO revision_evidence VALUES('named','component-segment')",
            [],
        )
        .unwrap();
        let result = retrieve(
            &conn,
            Some("p"),
            &Query::new("What dataset trains the Atlas model?"),
            24,
            4000,
            false,
            "2026-10-20",
        )
        .unwrap();
        assert_eq!(result.trace["sourceNavigation"], 0);
        assert!(result.records.iter().any(|m| m["id"] == "named"));
        assert!(!result.records.iter().any(|m| m["id"] == "observations"));
    }

    #[test]
    fn neighbor_slots_rotate_independent_segments_and_prefer_same_segment() {
        let conn = database();
        conn.execute_batch("INSERT INTO sources VALUES('guide','p','Operations guide','text','guide.txt',NULL,'now','guide-hash','ready',5,NULL,'');
            INSERT INTO segments VALUES('sa','guide','v',0,'A','Network access policy.');
            INSERT INTO segments VALUES('sb','guide','v',10,'B','Access policy.');
            INSERT INTO segments VALUES('sb-next','guide','v',11,'B next','Additional constraints.');
            INSERT INTO segments VALUES('sc','guide','v',20,'C','Network policy.');").unwrap();
        for n in 0..18 {
            let id = format!("dense-direct-{n:02}");
            add_memory(
                &conn,
                &id,
                "p",
                &format!("Network access policy rule {n} applies to the service."),
                json!({}),
            );
            conn.execute("INSERT INTO revision_evidence VALUES(?,'sa')", [&id])
                .unwrap();
        }
        for (id, body, segment) in [
            ("anchor-b", "Access policy applies to Team B.", "sb"),
            ("anchor-c", "Network policy applies to Team C.", "sc"),
            (
                "z-same-b",
                "Only service owners can approve this exception.",
                "sb",
            ),
            (
                "a-adjacent-b",
                "A separate constraint applies in emergencies.",
                "sb-next",
            ),
            ("same-c", "The approval window closes each Friday.", "sc"),
        ] {
            add_memory(&conn, id, "p", body, json!({}));
            conn.execute(
                "INSERT INTO revision_evidence VALUES(?,?)",
                params![id, segment],
            )
            .unwrap();
        }
        let result = retrieve(
            &conn,
            Some("p"),
            &Query::new("network access policy"),
            24,
            4000,
            false,
            "2026-10-20",
        )
        .unwrap();
        let ranking = result.trace["ranking"].as_array().unwrap();
        let neighbors = ranking
            .iter()
            .filter(|r| r["selectionReason"] == "adjacent_confirmed")
            .map(|r| r["id"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert!(neighbors.contains(&"z-same-b"));
        assert!(neighbors.contains(&"same-c"));
        if let Some(adjacent) = neighbors.iter().position(|id| *id == "a-adjacent-b") {
            assert!(neighbors.iter().position(|id| *id == "z-same-b").unwrap() < adjacent);
        }
        assert!(neighbors.len() <= 6);
        assert!(result.records.len() <= 24);
        assert_eq!(result.trace["indexBackend"], "fts5-derived-v3");
    }

    #[test]
    fn same_segment_neighbors_follow_exact_current_body_positions_before_id_order() {
        let conn = database();
        let before = "The schedule is reviewed every Friday.";
        let anchor = "Network access policy requires hardware credentials.";
        let after = "These credentials expire after ninety days.";
        let far = "An unrelated team owns the building.";
        let paragraph = format!(
            "{before} {anchor} {after} {} {far} UNCONFIRMED RAW FACT",
            "Distant description. ".repeat(80)
        );
        conn.execute("INSERT INTO sources VALUES('position-source','p','Guide','text','guide.txt',NULL,'now','position-hash','ready',1,NULL,'')", []).unwrap();
        conn.execute(
            "INSERT INTO segments VALUES('position-segment','position-source','v',0,'line 1',?)",
            [&paragraph],
        )
        .unwrap();
        for (id, project, body) in [
            ("anchor", "p", anchor),
            ("z-before", "p", before),
            ("z-after", "p", after),
            ("a-far", "p", far),
            (
                "private",
                "other",
                "Private credentials are retained forever.",
            ),
            ("old", "p", "The superseded instruction is different."),
        ] {
            add_memory(&conn, id, project, body, json!({}));
            conn.execute(
                "INSERT INTO revision_evidence VALUES(?,'position-segment')",
                [id],
            )
            .unwrap();
        }
        conn.execute_batch("INSERT INTO revisions VALUES('old2','old',2,'The current correction has no source position.','','user_correction','later'); UPDATE memories SET revision=2,content='The current correction has no source position.' WHERE id='old';").unwrap();
        for n in 0..9 {
            let id = format!("direct-noise-{n}");
            add_memory(
                &conn,
                &id,
                "p",
                &format!("Network access policy detail {n} is documented separately."),
                json!({}),
            );
            conn.execute(
                "INSERT INTO revision_evidence VALUES(?,'position-segment')",
                [&id],
            )
            .unwrap();
        }
        let result = retrieve(
            &conn,
            Some("p"),
            &Query::new("network access policy credentials"),
            12,
            4000,
            false,
            "2026-10-21",
        )
        .unwrap();
        let neighbors = result.trace["ranking"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|r| r["selectionReason"] == "adjacent_confirmed")
            .map(|r| r["id"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(neighbors.len(), 3);
        assert!(neighbors[..2].contains(&"z-before") && neighbors[..2].contains(&"z-after"));
        assert_eq!(neighbors[2], "a-far");
        assert!(!result
            .records
            .iter()
            .any(|m| m["id"] == "private" || m["id"] == "old"));
        assert!(!serde_json::to_string(&result.records)
            .unwrap()
            .contains("UNCONFIRMED RAW FACT"));
        assert_eq!(
            body_gap(&paragraph, anchor, "Corrected text absent from source."),
            None
        );
        assert!(stable_memory_order(
            &json!({"content":"Alpha","facets":{},"id":"z"}),
            &json!({"content":"Beta","facets":{},"id":"a"})
        )
        .is_lt());
    }

    #[test]
    fn data_navigation_covers_independent_segments_before_repeating_one_stage() {
        let conn = data_navigation_database();
        let second_stage = "A separate corpus is sourced from the National Archive for evaluation.";
        conn.execute(
            "INSERT INTO segments VALUES('second-stage','study-source','v',200,'line 200',?)",
            [second_stage],
        )
        .unwrap();
        add_memory(&conn, "second-stage-resource", "p", second_stage, json!({}));
        conn.execute(
            "INSERT INTO revision_evidence VALUES('second-stage-resource','second-stage')",
            [],
        )
        .unwrap();
        for n in 0..8 {
            let id = format!("repeated-stage-{n}");
            add_memory(&conn, &id, "p", &format!("We collected {n} weather observations from the municipal weather data archive."), json!({}));
            conn.execute("UPDATE memories SET source_title='Rainfall Prediction from Weather Data' WHERE id=?", [&id]).unwrap();
            conn.execute(
                "INSERT INTO revision_evidence VALUES(?,'provenance-segment')",
                [&id],
            )
            .unwrap();
        }
        let result = retrieve(
            &conn,
            Some("p"),
            &Query::new("What dataset is used to train the model?"),
            24,
            4000,
            false,
            "2026-10-21",
        )
        .unwrap();
        assert!(result.trace["ranking"]
            .as_array()
            .unwrap()
            .iter()
            .any(
                |r| r["id"] == "second-stage-resource" && r["selectionReason"] == "data_provenance"
            ));
        assert!(result.trace["sourceNavigation"].as_u64().unwrap() <= 4);
        assert!(result.records.len() <= 24);
    }

    #[test]
    fn navigation_slots_choose_data_resources_instead_of_model_inference() {
        let conn = data_navigation_database();
        for (ordinal, id, body) in [
            (300, "experiment-resource", "We conduct experiments on the Cedar Weather Corpus and the River Rainfall Dataset."),
            (400, "improvement", "The rainfall model obtains small improvements from the standard setup, comparing conditions 3 and 7."),
            (500, "sampled-labels", "We sample role labels from the rainfall training sentences."),
            (600, "sampled-parameters", "We estimate model parameters from the weather data."),
            (700, "generated-latents", "We generate hidden variables from the weather data using a non-parametric process."),
            (800, "clamped-labels", "We clamp the role labels of the supervised sentences using the mapping from section 8."),
        ] {
            let segment = format!("segment-{id}");
            conn.execute(
                "INSERT INTO segments VALUES(?,'study-source','v',?,'line',?)",
                params![segment, ordinal, body],
            )
            .unwrap();
            add_memory(&conn, id, "p", body, json!({}));
            conn.execute("UPDATE memories SET source_title='Rainfall Prediction from Weather Data' WHERE id=?", [id]).unwrap();
            conn.execute(
                "INSERT INTO revision_evidence VALUES(?,?)",
                params![id, segment],
            )
            .unwrap();
        }
        let result = retrieve(
            &conn,
            Some("p"),
            &Query::new("What dataset is used to train the model?"),
            24,
            4000,
            false,
            "2026-10-21",
        )
        .unwrap();
        let ranking = result.trace["ranking"].as_array().unwrap();
        for required in ["experiment-resource", "observations", "weather-source"] {
            assert!(
                ranking
                    .iter()
                    .any(|item| item["id"] == required
                        && item["selectionReason"] == "data_provenance"),
                "{required}"
            );
        }
        for forbidden in [
            "improvement",
            "sampled-labels",
            "sampled-parameters",
            "generated-latents",
            "clamped-labels",
        ] {
            assert!(
                !ranking
                    .iter()
                    .any(|item| item["id"] == forbidden
                        && item["selectionReason"] == "data_provenance"),
                "{forbidden}"
            );
        }
        assert_eq!(result.records.len(), 24);
        assert!(result.trace["sourceNavigation"].as_u64().unwrap() <= 4);
        assert!(
            ranking
                .iter()
                .filter(|item| item["selectionReason"] == "direct_lexical")
                .count()
                > 12
        );
        assert!(!result.records.iter().any(|item| matches!(
            item["id"].as_str(),
            Some("private" | "expired" | "disconnected")
        )));
        assert_eq!(
            result.trace["version"],
            "organized-memory-v12-sparse-context-fallback"
        );
    }
}
