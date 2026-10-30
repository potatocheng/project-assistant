//! Derived reading plans. Stored segments and their identities remain immutable.
use crate::ai::{Candidate, SourceSegment};
use serde_json::{json, Value};

struct ChatMessage {
    id: String,
    parent: Option<String>,
    header: usize,
    metadata: usize,
    body: Vec<usize>,
}

// Imported chat text is split into lines. Reconstruct links for reading without
// changing segment identities or manufacturing evidence from metadata.
fn chat_messages(source: &[SourceSegment]) -> Vec<ChatMessage> {
    let mut messages = Vec::new();
    for i in 1..source.len() {
        let Some(raw) = source[i].text.trim().strip_prefix("消息关系：") else {
            continue;
        };
        let Ok(metadata) = serde_json::from_str::<Value>(raw) else {
            continue;
        };
        let header = source[i - 1].text.trim();
        let Some((_, id)) = header.rsplit_once(" · ") else {
            continue;
        };
        if !header.starts_with('[') || !id.starts_with("om_") {
            continue;
        }
        messages.push(ChatMessage {
            id: id.into(),
            parent: metadata["parentId"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(str::to_owned),
            header: i - 1,
            metadata: i,
            body: vec![],
        });
    }
    for i in 0..messages.len() {
        let end = messages.get(i + 1).map_or(source.len(), |m| m.header);
        messages[i].body = (messages[i].metadata + 1..end).collect();
    }
    messages
}

#[cfg(test)]
pub(crate) fn plan(
    core: &[SourceSegment],
    source: &[SourceSegment],
    limit: usize,
) -> Vec<SourceSegment> {
    plan_scoped(core, source, limit, true)
}

pub(crate) fn plan_scoped(
    core: &[SourceSegment],
    source: &[SourceSegment],
    limit: usize,
    expand_primary: bool,
) -> Vec<SourceSegment> {
    let mut result = core.to_vec();
    let mut used: usize = result.iter().map(|s| s.text.chars().count()).sum();
    for item in &mut result {
        if let Some(original) = source.iter().find(|s| s.id == item.id) {
            let old = item.text.chars().count();
            let full = original.text.chars().count();
            if expand_primary && old < full && used - old + full <= limit {
                *item = original.clone();
                used = used - old + full;
            }
        }
    }
    if !expand_primary {
        for item in &mut result {
            if let Some(original) = source.iter().find(|s| s.id == item.id) {
                if let Some(start) = original.text.find(&item.text) {
                    let end = start + item.text.len();
                    let before = sentences(&original.text[..start])
                        .last()
                        .copied()
                        .unwrap_or("");
                    let after = sentences(&original.text[end..])
                        .first()
                        .copied()
                        .unwrap_or("");
                    let expanded = format!("{before}{}{after}", item.text);
                    let extra = expanded.chars().count() - item.text.chars().count();
                    if used + extra <= limit && original.text.contains(&expanded) {
                        item.text = expanded;
                        used += extra;
                    }
                }
            }
        }
    }
    let positions: Vec<_> = source
        .iter()
        .enumerate()
        .filter(|(_, s)| core.iter().any(|c| c.id == s.id))
        .map(|(i, _)| i)
        .collect();
    let Some(&first) = positions.first() else {
        return result;
    };
    let last = *positions.last().unwrap();
    // Read both directions before adding a distant heading. Complete blocks are
    // preferable to arbitrary tails; omitted blocks remain visible as risks.
    let mut neighbors = Vec::new();
    if last + 1 < source.len() {
        neighbors.push(last + 1);
    }
    if first > 0 {
        neighbors.push(first - 1);
    }
    neighbors.extend(structural_context(core, source));
    for i in neighbors {
        let item = &source[i];
        if result.iter().any(|s| s.id == item.id) {
            continue;
        }
        let size = item.text.chars().count();
        if used + size <= limit {
            result.push(item.clone());
            used += size;
        }
    }
    result.sort_by_key(|s| {
        source
            .iter()
            .position(|original| original.id == s.id)
            .unwrap_or(usize::MAX)
    });
    result
}

// These links guide reading only; a heading or table header is not an inferred
// subject or condition. Every included block retains its original evidence ID.
fn structural_context(core: &[SourceSegment], source: &[SourceSegment]) -> Vec<usize> {
    let mut indices = Vec::new();
    let messages = chat_messages(source);
    for message in &messages {
        if !message
            .body
            .iter()
            .any(|&i| core.iter().any(|s| s.id == source[i].id))
        {
            continue;
        }
        indices.extend([message.header, message.metadata]);
        for linked in &messages {
            if message.parent.as_deref() == Some(&linked.id)
                || linked.parent.as_deref() == Some(&message.id)
            {
                indices.extend([linked.header, linked.metadata]);
                indices.extend(&linked.body);
            }
        }
    }
    let first = source
        .iter()
        .position(|s| core.iter().any(|c| c.id == s.id))
        .unwrap_or(0);
    let mut headings = Vec::new();
    let mut fenced = false;
    for (i, s) in source.iter().enumerate().take(first) {
        let text = s.text.trim();
        if text.starts_with("```") || text.starts_with("~~~") {
            fenced = !fenced;
        }
        if fenced {
            continue;
        }
        let level = text.chars().take_while(|c| *c == '#').count();
        if (1..=6).contains(&level) && text.chars().nth(level).is_some_and(char::is_whitespace) {
            headings.retain(|(depth, _)| *depth < level);
            headings.push((level, i));
        } else if s.locator.starts_with("标题") {
            headings.clear();
            headings.push((1, i));
        }
    }
    indices.extend(headings.into_iter().map(|(_, i)| i));
    for item in core {
        if item.locator.starts_with("表格 ") {
            let table = item.locator.split(" / ").next().unwrap();
            let row = item
                .locator
                .rsplit_once(" / ")
                .map(|(row, _)| row)
                .unwrap_or("");
            indices.extend(
                source
                    .iter()
                    .enumerate()
                    .filter(|(_, s)| {
                        s.locator.starts_with(&format!("{table} / 行 1 /"))
                            || (!row.is_empty() && s.locator.starts_with(&format!("{row} /")))
                    })
                    .map(|(i, _)| i),
            );
        }
    }
    if core
        .iter()
        .any(|s| s.text.trim_start().starts_with(['-', '*', '•']))
    {
        if let Some(i) = (0..first)
            .rev()
            .take(16)
            .find(|&i| source[i].text.trim_end().ends_with([':', '：']))
        {
            indices.push(i);
        }
    }
    // Markdown tables have a literal header separator. Keep the actual header
    // and separator, never manufacture a sentence from their cell values.
    if core.iter().any(|s| s.text.contains('|')) {
        if let Some(i) = (1..first).rev().take(64).find(|&i| {
            let t = source[i].text.trim();
            t.contains('|')
                && t.contains('-')
                && t.chars().all(|c| c.is_whitespace() || "|:-".contains(c))
        }) {
            indices.extend([i - 1, i]);
        }
    }
    indices.sort_unstable();
    indices.dedup();
    indices
}

pub(crate) fn primary(candidate: &Candidate, core: &[SourceSegment]) -> bool {
    candidate.evidence.iter().any(|e| {
        core.iter()
            .any(|s| s.id == e.segment_id && s.text.contains(&e.quote))
    })
}

fn normalized(text: &str) -> String {
    text.chars().filter(|c| !c.is_whitespace()).collect()
}
fn includes(body: &str, text: &str) -> bool {
    !text.trim().is_empty() && normalized(body).contains(&normalized(text))
}
fn sentences(text: &str) -> Vec<&str> {
    let chars: Vec<_> = text.chars().collect();
    let mut start = 0;
    let mut result = Vec::new();
    for (i, (offset, c)) in text.char_indices().enumerate() {
        if crate::ai::sentence_boundary(&chars, i) {
            let end = offset + c.len_utf8();
            if !text[start..end].trim().is_empty() {
                result.push(text[start..end].trim());
            }
            start = end;
        }
    }
    if !text[start..].trim().is_empty() {
        result.push(text[start..].trim());
    }
    result
}
fn conditional(text: &str) -> bool {
    let lower = text.to_lowercase();
    [
        "仅",
        "除非",
        "前提",
        "只有",
        "不包括",
        "未批准",
        "unless",
        "only if",
        "provided that",
        "contingent on",
        "restricted to",
        "subject to",
        "不适用",
        "须经",
    ]
    .iter()
    .any(|cue| lower.contains(cue))
}
fn referring(text: &str) -> bool {
    let text = text.trim_start().to_lowercase();
    [
        "上述",
        "该计划",
        "此计划",
        "本次",
        "此前",
        "以下",
        "this plan",
        "the above",
        "this rollout",
        "this release",
        "this arrangement",
        "这项安排",
        "该安排",
        "这项计划",
        "下列",
        "the following",
    ]
    .iter()
    .any(|cue| text.starts_with(cue))
}
fn touches(candidate: &Candidate, segment: &SourceSegment, sentence: &str) -> bool {
    includes(&candidate.content, sentence)
        || candidate.evidence.iter().any(|e| {
            e.segment_id == segment.id
                && (includes(sentence, &e.quote) || includes(&e.quote, sentence))
        })
}
fn add_issue(issues: &mut Vec<Value>, segment: &SourceSegment, quote: &str, reason: &str) {
    let issue = json!({"field":"context","segmentId":segment.id,"requiredQuote":quote,"reason":format!("{}：{}",segment.locator,reason),"severity":"context"});
    if !issues.contains(&issue) {
        issues.push(issue);
    }
}

/// Each assertion is checked independently against immutable source text. A
/// complete sibling never grants eligibility to a shorter, unqualified claim.
/// Lexical links flag uncertainty only; they never add conditions to a fact.
pub(crate) fn candidate_issues(
    candidate: &Candidate,
    context: &[SourceSegment],
    source: &[SourceSegment],
) -> Vec<Value> {
    let mut issues = Vec::new();
    let messages = chat_messages(source);
    for message in &messages {
        if !message.body.iter().any(|&i| {
            candidate
                .evidence
                .iter()
                .any(|e| e.segment_id == source[i].id)
        }) {
            continue;
        }
        if let Some(parent) = &message.parent {
            if let Some(anchor) = messages.iter().find(|m| m.id == *parent) {
                if message.body.iter().any(|&i| conditional(&source[i].text)) {
                    for &i in &anchor.body {
                        if !includes(&candidate.content, &source[i].text) {
                            add_issue(
                                &mut issues,
                                &source[i],
                                &source[i].text,
                                "回复中的条件缺少所指的原始事项",
                            );
                        }
                    }
                }
            } else {
                add_issue(
                    &mut issues,
                    &source[message.metadata],
                    &source[message.metadata].text,
                    "所回复消息未能读取，须核对所指事项",
                );
            }
        }
        for reply in messages
            .iter()
            .filter(|m| m.parent.as_deref() == Some(&message.id))
        {
            for &i in &reply.body {
                if conditional(&source[i].text) && !includes(&candidate.content, &source[i].text) {
                    add_issue(
                        &mut issues,
                        &source[i],
                        &source[i].text,
                        "关联回复中的条件或例外尚未保留",
                    );
                }
            }
        }
    }
    let own: Vec<_> = source
        .iter()
        .enumerate()
        .filter(|(_, s)| candidate.evidence.iter().any(|e| e.segment_id == s.id))
        .collect();
    for &(position, segment) in &own {
        let parts = sentences(&segment.text);
        for (i, sentence) in parts.iter().enumerate() {
            if !conditional(sentence) {
                continue;
            }
            let previous = if i > 0 {
                Some((segment, parts[i - 1]))
            } else {
                position.checked_sub(1).and_then(|p| {
                    sentences(&source[p].text)
                        .last()
                        .copied()
                        .map(|t| (&source[p], t))
                })
            };
            if touches(candidate, segment, sentence) && !includes(&candidate.content, sentence) {
                add_issue(
                    &mut issues,
                    segment,
                    sentence,
                    "本条候选可能删掉原句的条件或否定，请核对完整原句",
                );
            }
            if referring(sentence) {
                if let Some((anchor_segment, anchor)) = previous {
                    if touches(candidate, anchor_segment, anchor)
                        && !includes(&candidate.content, sentence)
                    {
                        add_issue(
                            &mut issues,
                            segment,
                            sentence,
                            "本条事实后的指代限定尚未保留",
                        );
                    }
                    if touches(candidate, segment, sentence)
                        && !includes(&candidate.content, anchor)
                    {
                        add_issue(
                            &mut issues,
                            anchor_segment,
                            anchor,
                            "本条限定语缺少所指的前文事实",
                        );
                    }
                }
            }
        }
        // A following paragraph may qualify a claim even when another window
        // already produced a complete version of the same claim.
        if let (Some(anchor), Some(next)) = (parts.last(), source.get(position + 1)) {
            if let Some(qualifier) = sentences(&next.text).first().copied() {
                if conditional(qualifier)
                    && referring(qualifier)
                    && touches(candidate, segment, anchor)
                    && !includes(&candidate.content, qualifier)
                {
                    add_issue(
                        &mut issues,
                        next,
                        qualifier,
                        "本条事实缺少后续段落的指代限定",
                    );
                }
            }
        }
        let relevant = [segment.clone()];
        for index in structural_context(&relevant, source) {
            let structural = &source[index];
            if !context
                .iter()
                .any(|s| s.id == structural.id && s.text == structural.text)
            {
                add_issue(
                    &mut issues,
                    structural,
                    &structural.text,
                    "本条关联的标题、表头或引导语未完整提供",
                );
            }
            if segment.text.trim_start().starts_with(['-', '*', '•'])
                && conditional(&structural.text)
                && !includes(&candidate.content, &structural.text)
            {
                add_issue(
                    &mut issues,
                    structural,
                    &structural.text,
                    "本条列表事实缺少引导语中的适用范围",
                );
            }
        }
        if ["以下", "下列", "the following"]
            .iter()
            .any(|cue| segment.text.trim_start().to_lowercase().starts_with(cue))
            && conditional(&segment.text)
            && touches(candidate, segment, &segment.text)
        {
            let has_item = source
                .iter()
                .skip(position + 1)
                .take(16)
                .filter(|s| s.text.trim_start().starts_with(['-', '*', '•']))
                .any(|s| {
                    includes(
                        &candidate.content,
                        s.text
                            .trim_start()
                            .trim_start_matches(['-', '*', '•'])
                            .trim(),
                    )
                });
            if !has_item {
                add_issue(
                    &mut issues,
                    segment,
                    &segment.text,
                    "列表限定语未关联具体条目",
                );
            }
        }
    }
    issues
}

pub(crate) fn inspect(
    core: &[SourceSegment],
    context: &[SourceSegment],
    source: &[SourceSegment],
    candidates: &[Candidate],
    discarded: usize,
    saturated: bool,
) -> Value {
    let mut issues = Vec::new();
    if saturated {
        issues.push(json!({"field":"coverage","reason":"输出达到候选容量；若不能继续分区，剩余事实覆盖须核对","severity":"coverage"}));
    }
    if discarded > 0 {
        issues.push(json!({"field":"coverage","reason":"部分输出未通过校验，对应原文可能尚未保留","severity":"coverage"}));
    }
    let candidate_issues: Vec<_> = candidates
        .iter()
        .map(|candidate| candidate_issues(candidate, context, source))
        .collect();
    for item in candidate_issues.iter().flatten() {
        if !issues.contains(item) {
            issues.push(item.clone());
        }
    }
    // Empty outputs retain a diagnostic without inventing a candidate.
    if candidates.is_empty() {
        for (i, segment) in source.iter().enumerate() {
            if conditional(&segment.text)
                && (core.iter().any(|s| s.id == segment.id)
                    || i.checked_sub(1)
                        .is_some_and(|p| core.iter().any(|s| s.id == source[p].id)))
            {
                add_issue(
                    &mut issues,
                    segment,
                    &segment.text,
                    "含条件的原文尚无对应候选，需核对覆盖",
                );
            }
        }
    }
    json!({"version":"context-plan-v2-per-candidate","issues":issues,"candidateIssues":candidate_issues,"primary":core,"providedSegmentIds":context.iter().map(|s| &s.id).collect::<Vec<_>>(),"semanticCompleteness":"unverified"})
}

#[cfg(test)]
mod tests {
    use super::*;
    fn s(id: &str, text: &str) -> SourceSegment {
        SourceSegment {
            id: id.into(),
            text: text.into(),
            locator: id.into(),
        }
    }
    #[test]
    fn reads_following_condition_and_keeps_source_identity() {
        let all = vec![
            s("h", "# Atlas"),
            s("a", "11月5日上线。"),
            s("b", "上述计划仅面向内部员工。"),
        ];
        let plan = plan(&all[1..2], &all, 2400);
        assert_eq!(
            plan.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(),
            vec!["h", "a", "b"]
        );
        assert_eq!(plan[2].text, all[2].text);
        assert!(!inspect(&all[1..2], &plan, &all, &[], 0, false)["issues"]
            .as_array()
            .unwrap()
            .is_empty());
    }
    #[test]
    fn table_reading_includes_header_and_whole_row_without_invented_quotes() {
        let mut all = vec![
            s("header", "项目"),
            s("other", "其他项目"),
            s("cell1", "Atlas"),
            s("cell2", "11月5日"),
        ];
        for (item, locator) in all.iter_mut().zip([
            "表格 1 / 行 1 / 段落 1",
            "表格 1 / 行 2 / 段落 2",
            "表格 1 / 行 3 / 段落 3",
            "表格 1 / 行 3 / 段落 4",
        ]) {
            item.locator = locator.into();
        }
        let context = plan(&all[3..], &all, 2400);
        for id in ["header", "cell1", "cell2"] {
            assert!(context.iter().any(|s| s.id == id));
        }
        assert!(context.iter().all(|s| all
            .iter()
            .any(|original| s.id == original.id && s.text == original.text)));
    }
    #[test]
    fn context_only_fact_cannot_be_promoted_by_another_primary_window() {
        let candidate = Candidate {
            retention: Default::default(),
            kind: "fact".into(),
            content: "邻段事实".into(),
            evidence: vec![crate::ai::CandidateEvidence {
                segment_id: "context".into(),
                quote: "邻段事实".into(),
            }],
            facets: Default::default(),
        };
        assert!(!primary(&candidate, &[s("primary", "本段事实")]));
    }
    #[test]
    fn skips_whole_oversized_context_and_reports_unresolved_condition() {
        let all = vec![
            s("a", "计划上线。"),
            s("b", &format!("仅限{}", "甲".repeat(2400))),
        ];
        let plan = plan(&all[..1], &all, 2400);
        assert_eq!(plan.len(), 1);
        assert_eq!(
            inspect(&all[..1], &plan, &all, &[], 0, false)["issues"][0]["segmentId"],
            "b"
        );
    }
    fn candidate(body: &str, evidence: &[(&str, &str)]) -> Candidate {
        Candidate {
            retention: Default::default(),
            kind: "fact".into(),
            content: body.into(),
            facets: Default::default(),
            evidence: evidence
                .iter()
                .map(|(id, quote)| crate::ai::CandidateEvidence {
                    segment_id: (*id).into(),
                    quote: (*quote).into(),
                })
                .collect(),
        }
    }
    #[test]
    fn each_overlap_candidate_requires_its_own_anchor_and_condition() {
        let all = vec![
            s("a", "Atlas计划于11月5日上线。"),
            s("b", "上述计划以安全通过为前提，且仅面向内部员工。"),
        ];
        let complete = candidate(
            &(all[0].text.clone() + &all[1].text),
            &[("a", &all[0].text), ("b", &all[1].text)],
        );
        let short = candidate(&all[0].text, &[("a", &all[0].text)]);
        let qualifier = candidate(&all[1].text, &[("b", &all[1].text)]);
        for core in [&all[..1], &all[1..]] {
            let check = inspect(
                core,
                &all,
                &all,
                &[complete.clone(), short.clone(), qualifier.clone()],
                0,
                false,
            );
            assert_eq!(check["candidateIssues"][0], json!([]));
            assert!(!check["candidateIssues"][1].as_array().unwrap().is_empty());
            assert!(!check["candidateIssues"][2].as_array().unwrap().is_empty());
        }
        let mut wrong = short;
        wrong.content.push_str("仅面向客户。");
        assert!(!candidate_issues(&wrong, &all, &all).is_empty());
    }
    #[test]
    fn unrelated_neighbor_and_independent_sentence_are_not_conditioned() {
        let all = vec![
            s("a", "Aurora已批准上线。"),
            s("b", "Borealis仅在法务批准后上线。"),
        ];
        assert!(
            candidate_issues(&candidate(&all[0].text, &[("a", &all[0].text)]), &all, &all)
                .is_empty()
        );
        let one = vec![s("s", "Aurora已批准上线。Borealis仅在法务批准后上线。")];
        assert!(candidate_issues(
            &candidate("Aurora已批准上线。", &[("s", "Aurora已批准上线。")]),
            &one,
            &one
        )
        .is_empty());
        assert!(!candidate_issues(
            &candidate("Borealis上线。", &[("s", &one[0].text)]),
            &one,
            &one
        )
        .is_empty());
    }
    #[test]
    fn list_scope_checks_each_item_even_with_complete_sibling() {
        let all = vec![
            s("intro", "以下两项仅适用于测试环境，生产环境未批准："),
            s("filler", "归档说明。"),
            s("a", "- Nimbus允许扩容。"),
            s("b", "- Cirrus允许离线。"),
        ];
        let complete = candidate(
            &(all[0].text.clone() + "Nimbus允许扩容。"),
            &[("intro", &all[0].text), ("a", &all[2].text)],
        );
        assert!(candidate_issues(&complete, &all, &all).is_empty());
        assert!(!candidate_issues(
            &candidate("Cirrus允许离线。", &[("b", &all[3].text)]),
            &all,
            &all
        )
        .is_empty());
    }

    #[test]
    fn varied_references_keep_their_conditions_and_objects() {
        for (fact, limitation) in [
            (
                "Helios计划于2026-12-12启用批量导入。",
                "这项安排以安全批准为前提，仅限境内员工。",
            ),
            (
                "Aster will release on December 12.",
                "This release is contingent on approval and restricted to employees.",
            ),
        ] {
            let source = vec![s("a", fact), s("b", limitation)];
            let short = candidate(fact, &[("a", fact)]);
            assert!(!candidate_issues(&short, &source, &source).is_empty());
            let full = candidate(
                &format!("{fact}{limitation}"),
                &[("a", fact), ("b", limitation)],
            );
            assert!(candidate_issues(&full, &source, &source).is_empty());
        }
        let intro = "下列变更仅适用于测试环境：";
        let source = vec![s("a", intro), s("b", "- Cedar开启重试。")];
        assert!(!candidate_issues(&candidate(intro, &[("a", intro)]), &source, &source).is_empty());
    }

    #[test]
    fn reply_metadata_preserves_conditions_across_headers_and_missing_parents_are_reviewed() {
        let source = vec![
            s("h1", "[2026-10-28] 甲 · om_a"),
            s("m1", r#"消息关系：{"parentId":null}"#),
            s("a", "计划周五发布。"),
            s("h2", "[2026-10-29] 乙 · om_b"),
            s("m2", r#"消息关系：{"parentId":"om_a"}"#),
            s("b", "仅限内部员工，且须经安全批准。"),
        ];
        let short = candidate("计划周五发布。", &[("a", "计划周五发布。")]);
        assert!(!candidate_issues(&short, &source, &source).is_empty());
        let full = candidate(
            "计划周五发布。仅限内部员工，且须经安全批准。",
            &[
                ("a", "计划周五发布。"),
                ("b", "仅限内部员工，且须经安全批准。"),
            ],
        );
        assert!(candidate_issues(&full, &source, &source).is_empty());
        let plan = plan(&source[2..3], &source, 2400);
        assert!(plan.iter().any(|s| s.id == "b"));
        let missing = &source[3..];
        assert!(!candidate_issues(
            &candidate(
                "仅限内部员工，且须经安全批准。",
                &[("b", "仅限内部员工，且须经安全批准。")]
            ),
            missing,
            missing
        )
        .is_empty());
    }
}
