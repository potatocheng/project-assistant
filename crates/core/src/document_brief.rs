use serde_json::{json, Value};
use std::collections::HashSet;

use crate::ai::SourceSegment;

const MIN_BRIEF_CHARS: usize = 2400;
const MAX_OUTLINE_ITEMS: usize = 40;
const MAX_OUTLINE_CHARS: usize = 1500;
const MAX_DEFINITION_ITEMS: usize = 12;
const MAX_DEFINITION_CHARS: usize = 1200;
const MAX_GLOSSARY_ITEMS: usize = 20;
const MAX_BRIEF_JSON_CHARS: usize = 4000;

const CN_NUMERALS: &str = "零一二三四五六七八九十百千万两";
const DEFINITION_MARKERS: [&str; 5] = ["是指", "指的是", "定义为", "简称", "下称"];

fn clip_chars(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        text.to_owned()
    } else {
        text.chars().take(max_chars).collect()
    }
}

fn is_cn_heading(trimmed: &str) -> bool {
    let mut chars = trimmed.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if first == '第' {
        let mut num_count = 0usize;
        for ch in chars {
            if CN_NUMERALS.contains(ch) || ch.is_ascii_digit() {
                num_count += 1;
            } else {
                return num_count > 0 && matches!(ch, '章' | '节' | '部');
            }
        }
        return false;
    }

    let mut num_count = 0usize;
    let rest_all = std::iter::once(first).chain(chars);
    let mut found_sep = false;
    let mut has_tail = false;
    for ch in rest_all {
        if !found_sep {
            if CN_NUMERALS.contains(ch) {
                num_count += 1;
            } else if num_count > 0 && ch == '、' {
                found_sep = true;
            } else {
                return false;
            }
        } else if !ch.is_whitespace() {
            has_tail = true;
            break;
        }
    }
    found_sep && has_tail
}

fn parse_heading(line: &str) -> Option<String> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    let hashes = trimmed.bytes().take_while(|&b| b == b'#').count();
    if (1..=6).contains(&hashes)
        && trimmed
            .as_bytes()
            .get(hashes)
            .is_some_and(|&b| b == b' ' || b == b'\t')
    {
        let title = trimmed[hashes..].trim();
        if !title.is_empty() {
            return Some(title.to_owned());
        }
    }
    if trimmed.chars().count() <= 40 && is_cn_heading(trimmed) {
        return Some(trimmed.to_owned());
    }
    None
}

fn collect_outline(segments: &[SourceSegment]) -> Vec<Value> {
    let mut outline = Vec::new();
    let mut total_title_chars = 0usize;
    let mut in_fence = false;

    for seg in segments {
        for line in seg.text.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with("```") {
                in_fence = !in_fence;
                continue;
            }
            if in_fence {
                continue;
            }
            if let Some(heading) = parse_heading(trimmed) {
                let clipped = clip_chars(&heading, 80);
                let len = clipped.chars().count();
                if outline.len() >= MAX_OUTLINE_ITEMS || total_title_chars + len > MAX_OUTLINE_CHARS
                {
                    return outline;
                }
                total_title_chars += len;
                outline.push(json!({
                    "title": clipped,
                    "locator": seg.locator,
                }));
            }
        }
    }
    outline
}

fn collect_definitions(segments: &[SourceSegment]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut defs = Vec::new();
    let mut total_chars = 0usize;

    for seg in segments {
        for raw in seg.text.split(['。', '；', '\n']) {
            let sentence = raw.trim();
            if sentence.is_empty() {
                continue;
            }
            let char_len = sentence.chars().count();
            if char_len > 200
                || !DEFINITION_MARKERS
                    .iter()
                    .any(|marker| sentence.contains(marker))
            {
                continue;
            }
            if seen.insert(sentence.to_owned()) {
                if defs.len() >= MAX_DEFINITION_ITEMS
                    || total_chars + char_len > MAX_DEFINITION_CHARS
                {
                    return defs;
                }
                total_chars += char_len;
                defs.push(sentence.to_owned());
            }
        }
    }
    defs
}

fn collect_glossary(full_text: &str, aliases: &[Vec<String>]) -> Vec<Value> {
    let mut glossary = Vec::new();
    for group in aliases {
        let terms: Vec<String> = group
            .iter()
            .map(|t| t.trim())
            .filter(|t| !t.is_empty())
            .take(6)
            .map(str::to_owned)
            .collect();
        if terms.iter().any(|term| full_text.contains(term)) {
            glossary.push(json!({ "terms": terms }));
            if glossary.len() >= MAX_GLOSSARY_ITEMS {
                break;
            }
        }
    }
    glossary
}

pub(crate) fn build(
    title: &str,
    segments: &[SourceSegment],
    aliases: &[Vec<String>],
) -> Option<Value> {
    let total_chars: usize = segments.iter().map(|s| s.text.chars().count()).sum();
    if total_chars <= MIN_BRIEF_CHARS {
        return None;
    }

    let outline = collect_outline(segments);
    let definitions = collect_definitions(segments);
    let full_text = segments
        .iter()
        .map(|s| s.text.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let glossary = collect_glossary(&full_text, aliases);

    if outline.is_empty() && definitions.is_empty() && glossary.is_empty() {
        return None;
    }

    let mut brief = json!({
        "role": "长文档导读：仅帮助定位上下文和统一称谓，不是事实依据，候选必须引用原文片段",
        "title": clip_chars(title.trim(), 120),
        "totalChars": total_chars,
        "segmentCount": segments.len(),
        "outline": outline,
        "definitions": definitions,
        "glossary": glossary,
    });

    while brief.to_string().chars().count() > MAX_BRIEF_JSON_CHARS {
        let popped = brief["glossary"]
            .as_array_mut()
            .and_then(|a| a.pop())
            .is_some()
            || brief["definitions"]
                .as_array_mut()
                .and_then(|a| a.pop())
                .is_some()
            || brief["outline"]
                .as_array_mut()
                .and_then(|a| a.pop())
                .is_some();
        if !popped {
            return None;
        }
    }

    let empty = brief["outline"].as_array().is_none_or(Vec::is_empty)
        && brief["definitions"].as_array().is_none_or(Vec::is_empty)
        && brief["glossary"].as_array().is_none_or(Vec::is_empty);
    if empty {
        None
    } else {
        Some(brief)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(id: &str, locator: &str, text: &str) -> SourceSegment {
        SourceSegment {
            id: id.into(),
            locator: locator.into(),
            text: text.into(),
        }
    }

    #[test]
    fn short_document_returns_none() {
        let segments = vec![seg("s1", "第1段", "# 标题\nA是指B。")];
        assert!(build("短文档", &segments, &[vec!["A".into(), "甲".into()]]).is_none());
    }

    #[test]
    fn long_document_builds_outline_definitions_and_glossary_without_fenced_headings() {
        let padding = "补充正文说明内容用于满足长文档字符数阈值要求。".repeat(80);
        let segments = vec![
            seg(
                "s1",
                "第1页",
                &format!(
                    "# 发布概览\n```markdown\n# not heading\n```\n一、核心目标\n结算周期是指T+1个工作日完成对账。\n支付网关本次升级已完成联调。\n{padding}"
                ),
            ),
            seg("s2", "第2页", &format!("第二章 验收规范\n{padding}")),
        ];
        let aliases = vec![
            vec!["支付网关".into(), "PayGW".into()],
            vec!["无关词条".into(), "Other".into()],
        ];
        let brief = build("发布方案 V2", &segments, &aliases).expect("brief");
        assert!(brief.to_string().chars().count() <= MAX_BRIEF_JSON_CHARS);
        let outline_titles: Vec<&str> = brief["outline"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v["title"].as_str().unwrap())
            .collect();
        assert_eq!(
            outline_titles,
            vec!["发布概览", "一、核心目标", "第二章 验收规范"]
        );
        assert!(brief["definitions"].as_array().unwrap().iter().any(|v| v
            .as_str()
            .unwrap()
            .contains("结算周期是指T+1个工作日完成对账")));
        let glossary = brief["glossary"].as_array().unwrap();
        assert_eq!(glossary.len(), 1);
        assert_eq!(glossary[0]["terms"], json!(["支付网关", "PayGW"]));
    }

    #[test]
    fn brief_output_caps_at_4000_chars() {
        let mut lines = Vec::new();
        for i in 0..50 {
            lines.push(format!("# 章节{i}_{}", "长标题".repeat(20)));
            lines.push(format!("术语{i}是指{}。", "非常长的定义解释内容".repeat(7)));
        }
        let segments = vec![seg("s1", "P1", &lines.join("\n"))];
        let aliases: Vec<Vec<String>> = (0..25)
            .map(|i| {
                vec![
                    format!("章节{i}"),
                    format!("Alias{i}_{}", "别名文本".repeat(6)),
                ]
            })
            .collect();
        let brief = build("超长技术白皮书", &segments, &aliases).expect("brief");
        assert!(brief.to_string().chars().count() <= MAX_BRIEF_JSON_CHARS);
    }
}
