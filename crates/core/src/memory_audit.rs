//! Sleep-time (idle) contradiction and duplicate audit over active confirmed memories.
//! Zero-token deterministic scan that catches latent conflicts (different dates, owners,
//! affirmative vs negated decisions, or near-duplicate active records) without breaking
//! immutable revision history or backup invariants.
use crate::{id, now, required, AppError, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap, HashSet};

const MAX_SCAN_PER_PROJECT: usize = 2_000;

pub(crate) fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS memory_audits(
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id),
            memory_a_id TEXT NOT NULL REFERENCES memories(id),
            memory_a_revision INTEGER NOT NULL CHECK(memory_a_revision>=1),
            memory_b_id TEXT NOT NULL REFERENCES memories(id),
            memory_b_revision INTEGER NOT NULL CHECK(memory_b_revision>=1),
            kind TEXT NOT NULL CHECK(kind IN ('date_conflict','owner_conflict','negation_conflict','numeric_conflict','duplicate_overlap')),
            reason TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('open','dismissed','resolved')),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(memory_a_id, memory_a_revision, memory_b_id, memory_b_revision, kind)
        );
        CREATE INDEX IF NOT EXISTS memory_audits_status ON memory_audits(status, project_id, updated_at);",
    )?;
    Ok(())
}

pub(crate) fn migrate_v17(conn: &Connection) -> Result<()> {
    let sql: Option<String> = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='memory_audits'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    let Some(table_sql) = sql else {
        return migrate(conn);
    };
    if table_sql.contains("'numeric_conflict'") {
        return Ok(());
    }
    conn.execute_batch(
        "ALTER TABLE memory_audits RENAME TO memory_audits_v16;
         CREATE TABLE memory_audits(
             id TEXT PRIMARY KEY,
             project_id TEXT NOT NULL REFERENCES projects(id),
             memory_a_id TEXT NOT NULL REFERENCES memories(id),
             memory_a_revision INTEGER NOT NULL CHECK(memory_a_revision>=1),
             memory_b_id TEXT NOT NULL REFERENCES memories(id),
             memory_b_revision INTEGER NOT NULL CHECK(memory_b_revision>=1),
             kind TEXT NOT NULL CHECK(kind IN ('date_conflict','owner_conflict','negation_conflict','numeric_conflict','duplicate_overlap')),
             reason TEXT NOT NULL,
             status TEXT NOT NULL CHECK(status IN ('open','dismissed','resolved')),
             created_at TEXT NOT NULL,
             updated_at TEXT NOT NULL,
             UNIQUE(memory_a_id, memory_a_revision, memory_b_id, memory_b_revision, kind)
         );
         INSERT INTO memory_audits(id,project_id,memory_a_id,memory_a_revision,memory_b_id,memory_b_revision,kind,reason,status,created_at,updated_at)
         SELECT id,project_id,memory_a_id,memory_a_revision,memory_b_id,memory_b_revision,kind,reason,status,created_at,updated_at
         FROM memory_audits_v16;
         DROP TABLE memory_audits_v16;
         CREATE INDEX IF NOT EXISTS memory_audits_status ON memory_audits(status, project_id, updated_at);",
    )?;
    Ok(())
}

fn invalid(message: &str) -> AppError {
    AppError::new("VALIDATION", message)
}

fn table_exists(conn: &Connection) -> Result<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_audits')",
        [],
        |r| r.get(0),
    )?)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd)]
struct DateToken {
    year: Option<u16>,
    month: u8,
    day: u8,
}

impl DateToken {
    fn matches(self, other: Self) -> bool {
        self.month == other.month
            && self.day == other.day
            && match (self.year, other.year) {
                (Some(a), Some(b)) => a == b,
                _ => true,
            }
    }

    fn format(self) -> String {
        match self.year {
            Some(y) => format!("{y:04}-{:02}-{:02}", self.month, self.day),
            None => format!("{:02}-{:02}", self.month, self.day),
        }
    }
}

fn valid_calendar_date(month: u8, day: u8) -> bool {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => (1..=31).contains(&day),
        4 | 6 | 9 | 11 => (1..=30).contains(&day),
        2 => (1..=29).contains(&day),
        _ => false,
    }
}

fn dates_match(a: &BTreeSet<DateToken>, b: &BTreeSet<DateToken>) -> bool {
    a.len() == b.len() && a.iter().zip(b.iter()).all(|(da, db)| da.matches(*db))
}

fn parse_ascii_u16(bytes: &[u8]) -> Option<u16> {
    if bytes.is_empty() || !bytes.iter().all(u8::is_ascii_digit) {
        return None;
    }
    std::str::from_utf8(bytes).ok()?.parse::<u16>().ok()
}

fn parse_english_month(token: &str) -> Option<u8> {
    match token {
        "jan" | "january" => Some(1),
        "feb" | "february" => Some(2),
        "mar" | "march" => Some(3),
        "apr" | "april" => Some(4),
        "may" => Some(5),
        "jun" | "june" => Some(6),
        "jul" | "july" => Some(7),
        "aug" | "august" => Some(8),
        "sep" | "sept" | "september" => Some(9),
        "oct" | "october" => Some(10),
        "nov" | "november" => Some(11),
        "dec" | "december" => Some(12),
        _ => None,
    }
}

fn parse_english_day(token: &str) -> Option<u8> {
    let trimmed = token
        .strip_suffix("st")
        .or_else(|| token.strip_suffix("nd"))
        .or_else(|| token.strip_suffix("rd"))
        .or_else(|| token.strip_suffix("th"))
        .unwrap_or(token);
    if trimmed.is_empty() || trimmed.len() > 2 || !trimmed.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    trimmed.parse::<u8>().ok().filter(|d| (1..=31).contains(d))
}

fn extract_dates(text: &str) -> BTreeSet<DateToken> {
    let mut dates = BTreeSet::new();
    let bytes = text.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        let prev_digit = i > 0 && bytes[i - 1].is_ascii_digit();
        if !prev_digit && i + 8 <= bytes.len() {
            if let Some(year) =
                parse_ascii_u16(&bytes[i..i + 4]).filter(|y| (1900..=2199).contains(y))
            {
                let sep = bytes[i + 4];
                if matches!(sep, b'-' | b'/' | b'.') {
                    let m_start = i + 5;
                    let m_len = bytes[m_start..]
                        .iter()
                        .take(2)
                        .take_while(|b| b.is_ascii_digit())
                        .count();
                    if (1..=2).contains(&m_len) && bytes.get(m_start + m_len) == Some(&sep) {
                        let d_start = m_start + m_len + 1;
                        let d_len = bytes[d_start..]
                            .iter()
                            .take(2)
                            .take_while(|b| b.is_ascii_digit())
                            .count();
                        let after_digit =
                            bytes.get(d_start + d_len).is_some_and(u8::is_ascii_digit);
                        if (1..=2).contains(&d_len) && !after_digit {
                            if let (Some(m), Some(d)) = (
                                parse_ascii_u16(&bytes[m_start..m_start + m_len]).map(|v| v as u8),
                                parse_ascii_u16(&bytes[d_start..d_start + d_len]).map(|v| v as u8),
                            ) {
                                if valid_calendar_date(m, d) {
                                    dates.insert(DateToken {
                                        year: Some(year),
                                        month: m,
                                        day: d,
                                    });
                                    i = d_start + d_len;
                                    continue;
                                }
                            }
                        }
                    }
                }
            }
        }
        let prev_joined = i > 0
            && (bytes[i - 1].is_ascii_alphanumeric() || matches!(bytes[i - 1], b'-' | b'/' | b'.'));
        if !prev_joined && i + 3 <= bytes.len() && bytes[i].is_ascii_digit() {
            let m_len = bytes[i..]
                .iter()
                .take(2)
                .take_while(|b| b.is_ascii_digit())
                .count();
            if (1..=2).contains(&m_len) {
                if let Some(&_sep @ (b'-' | b'/')) = bytes.get(i + m_len) {
                    let d_start = i + m_len + 1;
                    let d_len = bytes[d_start..]
                        .iter()
                        .take(2)
                        .take_while(|b| b.is_ascii_digit())
                        .count();
                    let next_joined = bytes.get(d_start + d_len).is_some_and(|b| {
                        b.is_ascii_alphanumeric() || matches!(b, b'-' | b'/' | b'.')
                    });
                    if (1..=2).contains(&d_len) && !next_joined {
                        if let (Some(m), Some(d)) = (
                            parse_ascii_u16(&bytes[i..i + m_len]).map(|v| v as u8),
                            parse_ascii_u16(&bytes[d_start..d_start + d_len]).map(|v| v as u8),
                        ) {
                            if valid_calendar_date(m, d) {
                                dates.insert(DateToken {
                                    year: None,
                                    month: m,
                                    day: d,
                                });
                                i = d_start + d_len;
                                continue;
                            }
                        }
                    }
                }
            }
        }
        i += 1;
    }

    for (idx, _) in text.match_indices('月') {
        let before = text[..idx].trim_end();
        let month_digits: String = before
            .chars()
            .rev()
            .take_while(|c| c.is_ascii_digit())
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        if !(1..=2).contains(&month_digits.len()) {
            continue;
        }
        let Ok(month) = month_digits.parse::<u8>() else {
            continue;
        };
        let before_month = before[..before.len() - month_digits.len()].trim_end();
        let year = if let Some(before_year) = before_month.strip_suffix('年') {
            let y_digits: String = before_year
                .trim_end()
                .chars()
                .rev()
                .take_while(|c| c.is_ascii_digit())
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect();
            if y_digits.len() == 4 {
                y_digits
                    .parse::<u16>()
                    .ok()
                    .filter(|y| (1900..=2199).contains(y))
            } else {
                None
            }
        } else {
            None
        };
        let after = text[idx + '月'.len_utf8()..].trim_start();
        let day_digits: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
        if !(1..=2).contains(&day_digits.len()) {
            continue;
        }
        if !after[day_digits.len()..].starts_with(['日', '号']) {
            continue;
        }
        if let Ok(day) = day_digits.parse::<u8>() {
            if valid_calendar_date(month, day) {
                dates.insert(DateToken { year, month, day });
            }
        }
    }

    let mut ascii_tokens: Vec<(String, usize, usize)> = Vec::new();
    let mut t_start: Option<usize> = None;
    for (pos, ch) in text.char_indices() {
        if ch.is_ascii_alphanumeric() {
            t_start.get_or_insert(pos);
        } else if let Some(s) = t_start.take() {
            ascii_tokens.push((text[s..pos].to_lowercase(), s, pos));
        }
    }
    if let Some(s) = t_start {
        ascii_tokens.push((text[s..].to_lowercase(), s, text.len()));
    }
    let gap_ok = |a_end: usize, b_start: usize| -> bool {
        let gap = &text[a_end..b_start];
        gap.len() <= 4 && gap.chars().all(|c| c.is_ascii_whitespace() || c == ',')
    };
    let mut ti = 0usize;
    while ti + 1 < ascii_tokens.len() {
        if !gap_ok(ascii_tokens[ti].2, ascii_tokens[ti + 1].1) {
            ti += 1;
            continue;
        }
        let mut matched = None;
        if let (Some(m), Some(d)) = (
            parse_english_month(&ascii_tokens[ti].0),
            parse_english_day(&ascii_tokens[ti + 1].0),
        ) {
            matched = Some((m, d));
        } else if let (Some(d), Some(m)) = (
            parse_english_day(&ascii_tokens[ti].0),
            parse_english_month(&ascii_tokens[ti + 1].0),
        ) {
            matched = Some((m, d));
        }
        if let Some((month, day)) = matched {
            let year = if ti + 2 < ascii_tokens.len()
                && gap_ok(ascii_tokens[ti + 1].2, ascii_tokens[ti + 2].1)
                && ascii_tokens[ti + 2].0.len() == 4
            {
                ascii_tokens[ti + 2]
                    .0
                    .parse::<u16>()
                    .ok()
                    .filter(|y| (1900..=2199).contains(y))
            } else {
                None
            };
            if valid_calendar_date(month, day) {
                dates.insert(DateToken { year, month, day });
            }
            ti += if year.is_some() { 3 } else { 2 };
            continue;
        }
        ti += 1;
    }

    dates
}

fn extract_stages(text: &str) -> BTreeSet<&'static str> {
    let lower = text.to_lowercase();
    let mut stages = BTreeSet::new();
    const STAGE_GROUPS: &[(&str, &[&str])] = &[
        ("kickoff", &["立项", "启动", "kickoff", "kick-off"]),
        (
            "design",
            &[
                "方案评审",
                "架构评审",
                "设计评审",
                "需求评审",
                "立项评审",
                "design review",
                "prd",
            ],
        ),
        (
            "dev",
            &[
                "开发完成",
                "联调",
                "提测",
                "code complete",
                "dev complete",
                "integration",
            ],
        ),
        (
            "freeze",
            &["封板", "冻结", "code freeze", "feature freeze", "freeze"],
        ),
        (
            "uat",
            &[
                "内测",
                "灰度",
                "试运行",
                "验收",
                "uat",
                "beta",
                "canary",
                "pilot",
            ],
        ),
        (
            "release",
            &[
                "上线",
                "发布",
                "投产",
                "交付",
                "launch",
                "release",
                "go-live",
                "go live",
                "production",
            ],
        ),
        ("retro", &["复盘", "总结", "归档", "retro", "postmortem"]),
    ];
    for (bucket, cues) in STAGE_GROUPS {
        if cues.iter().any(|cue| lower.contains(cue)) {
            stages.insert(*bucket);
        }
    }
    stages
}

fn is_valid_owner_candidate(candidate: &str) -> bool {
    let trimmed = candidate.trim();
    let char_len = trimmed.chars().count();
    if !(2..=20).contains(&char_len) {
        return false;
    }
    let has_cjk = trimmed
        .chars()
        .any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c));
    if has_cjk && char_len > 6 {
        return false;
    }
    !matches!(
        trimmed.to_lowercase().as_str(),
        "谁" | "自己"
            | "团队"
            | "小组"
            | "部门"
            | "研发"
            | "开发"
            | "测试"
            | "运维"
            | "产品"
            | "前端"
            | "后端"
            | "专人"
            | "系统"
            | "模块"
            | "项目"
            | "我们"
            | "大家"
            | "各自"
            | "共同"
            | "全权"
            | "主要"
            | "具体"
            | "统一"
            | "人员"
            | "同事"
            | "同学"
            | "技术"
            | "the"
            | "a"
            | "an"
            | "this"
            | "that"
            | "it"
            | "team"
            | "backend"
            | "frontend"
    )
}

fn strip_owner_suffix(mut s: &str) -> &str {
    const SUFFIXES: &[&str] = &[
        "全权负责",
        "全权承接",
        "全权",
        "承接",
        "承担",
        "主导",
        "接手",
        "跟进",
        "负责",
        "处理",
        "牵头",
    ];
    loop {
        s = s.trim();
        let before = s;
        for suf in SUFFIXES {
            if let Some(stripped) = s.strip_suffix(suf) {
                s = stripped.trim();
                break;
            }
        }
        if s == before {
            return s;
        }
    }
}

fn extract_owner_raw(content: &str) -> Option<String> {
    for (idx, _) in content.match_indices('由') {
        if idx > 0 && matches!(content[..idx].chars().next_back(), Some('理' | '自' | '原')) {
            continue;
        }
        let rest = &content[idx + '由'.len_utf8()..];
        for verb in ["负责", "接手", "牵头", "跟进", "承接"] {
            if let Some(end) = rest.find(verb) {
                let candidate = strip_owner_suffix(rest[..end].trim());
                let char_len = candidate.chars().count();
                if (1..=12).contains(&char_len)
                    && !candidate.contains(['，', '。', '、', ',', '.', '；', ';', '\n', ' '])
                    && is_valid_owner_candidate(candidate)
                {
                    return Some(candidate.to_owned());
                }
            }
        }
    }
    for prefix in [
        "负责人：",
        "负责人:",
        "负责人为",
        "负责人是",
        "已转交",
        "转交给",
        "转交",
        "交给",
        "改派给",
        "改派",
    ] {
        if let Some(start) = content.find(prefix) {
            let rest = content[start + prefix.len()..].trim_start();
            let candidate: String = rest
                .chars()
                .take_while(|c| {
                    !matches!(
                        c,
                        '，' | '。'
                            | '、'
                            | ','
                            | '.'
                            | '；'
                            | ';'
                            | '\n'
                            | ' '
                            | '（'
                            | '('
                            | '）'
                            | ')'
                    )
                })
                .collect();
            let trimmed = strip_owner_suffix(&candidate);
            if is_valid_owner_candidate(trimmed) {
                return Some(trimmed.to_owned());
            }
        }
    }
    for verb in ["负责", "牵头", "接手", "跟进", "承接"] {
        for (idx, _) in content.match_indices(verb) {
            let before = content[..idx].trim_end();
            let raw_candidate: String = before
                .chars()
                .rev()
                .take_while(|c| {
                    !matches!(
                        c,
                        '，' | '。'
                            | '、'
                            | ','
                            | '.'
                            | '；'
                            | ';'
                            | '\n'
                            | ' '
                            | '：'
                            | ':'
                            | '（'
                            | '('
                            | '）'
                            | ')'
                            | '将'
                            | '把'
                            | '由'
                            | '改'
                            | '转'
                            | '请'
                            | '让'
                            | '需'
                            | '已'
                            | '并'
                            | '和'
                            | '与'
                            | '及'
                    )
                })
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect();
            let candidate = strip_owner_suffix(&raw_candidate);
            if is_valid_owner_candidate(candidate) {
                return Some(candidate.to_owned());
            }
        }
    }
    let lower = content.to_lowercase();
    for cue in [
        "owner:",
        "owner is ",
        "owned by ",
        "assigned to ",
        "led by ",
    ] {
        if let Some(idx) = lower.find(cue) {
            let rest = content[idx + cue.len()..].trim_start();
            let candidate: String = rest
                .chars()
                .take_while(|c| c.is_ascii_alphabetic() || *c == '-' || *c == '_')
                .collect();
            let trimmed = strip_owner_suffix(&candidate);
            if is_valid_owner_candidate(trimmed) {
                return Some(trimmed.to_owned());
            }
        }
    }
    for cue in [" owns ", " leads "] {
        if let Some(idx) = lower.find(cue) {
            let before = content[..idx].trim_end();
            let raw_candidate: String = before
                .chars()
                .rev()
                .take_while(|c| c.is_ascii_alphabetic() || *c == '-' || *c == '_')
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect();
            let candidate = strip_owner_suffix(&raw_candidate);
            if is_valid_owner_candidate(candidate) {
                return Some(candidate.to_owned());
            }
        }
    }
    None
}

#[allow(dead_code)]
fn extract_owner(
    content: &str,
    facets: &Value,
    alias_map: &HashMap<String, String>,
) -> Option<String> {
    if facets["role"].as_str() == Some("owner") {
        if let Some(entity) = facets["entity"]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            return Some(canonicalize(entity, alias_map));
        }
    }
    extract_owner_raw(content).map(|raw| canonicalize(&raw, alias_map))
}

fn is_audit_punct(c: char) -> bool {
    c.is_ascii_punctuation()
        || matches!(
            c,
            '，' | '。'
                | '、'
                | '；'
                | '：'
                | '！'
                | '？'
                | '（'
                | '）'
                | '【'
                | '】'
                | '「'
                | '」'
                | '『'
                | '』'
                | '“'
                | '”'
                | '‘'
                | '’'
                | '—'
                | '…'
                | '·'
        )
}

fn owner_subject(content: &str, raw: &str) -> Option<String> {
    let idx = if content.is_ascii() {
        content
            .to_ascii_lowercase()
            .find(&raw.to_ascii_lowercase())?
    } else {
        content.find(raw)?
    };
    let mut before = &content[..idx];
    const CUES: &[&str] = &[
        "已交由",
        "交由",
        "改由",
        "已转交",
        "转交给",
        "转交",
        "交给",
        "改派给",
        "改派",
        "负责人：",
        "负责人:",
        "负责人为",
        "负责人是",
        "由",
        "is owned by",
        "owned by",
        "is assigned to",
        "assigned to",
        "is led by",
        "led by",
        "owner is",
        "owner:",
    ];
    loop {
        before = before.trim_end_matches(|c: char| c.is_whitespace() || is_audit_punct(c));
        let prev = before;
        let lower_before = before.to_ascii_lowercase();
        for cue in CUES {
            if cue.is_ascii() {
                if lower_before.ends_with(cue) {
                    before = &before[..before.len() - cue.len()];
                    break;
                }
            } else if let Some(stripped) = before.strip_suffix(cue) {
                before = stripped;
                break;
            }
        }
        if before == prev {
            break;
        }
    }
    let norm: String = before
        .chars()
        .filter(|c| !c.is_whitespace() && !is_audit_punct(*c))
        .flat_map(|c| c.to_lowercase())
        .collect();
    if norm.chars().count() >= 2 {
        Some(norm)
    } else {
        None
    }
}

fn extract_numbers(text: &str) -> BTreeSet<String> {
    let mut nums = BTreeSet::new();
    let mut cur = String::new();
    for ch in text.chars() {
        if ch.is_ascii_digit() {
            cur.push(ch);
        } else if !cur.is_empty() {
            nums.insert(std::mem::take(&mut cur));
        }
    }
    if !cur.is_empty() {
        nums.insert(cur);
    }
    nums
}

#[derive(Clone, Debug)]
struct MetricToken {
    value: f64,
    unit: &'static str,
    display: String,
}

fn parse_metric_unit(rest: &str) -> Option<(f64, &'static str, usize)> {
    const CJK_UNITS: &[(&str, f64, &str)] = &[
        ("工作日", 1.0, "day"),
        ("毫秒", 1.0, "ms"),
        ("分钟", 1.0, "min"),
        ("小时", 1.0, "hour"),
        ("次/秒", 1.0, "qps"),
        ("万元", 1.0, "wan"),
        ("美元", 1.0, "usd"),
        ("秒", 1000.0, "ms"),
        ("天", 1.0, "day"),
        ("万", 1.0, "wan"),
        ("元", 1.0, "yuan"),
        ("人", 1.0, "headcount"),
        ("名", 1.0, "headcount"),
        ("%", 1.0, "percent"),
        ("％", 1.0, "percent"),
    ];
    for &(u, factor, canonical) in CJK_UNITS {
        if rest.starts_with(u) {
            return Some((factor, canonical, u.len()));
        }
    }
    let lower_prefix: String = rest
        .chars()
        .take(6)
        .collect::<String>()
        .to_ascii_lowercase();
    const ASCII_UNITS: &[(&str, f64, &str)] = &[
        ("days", 1.0, "day"),
        ("day", 1.0, "day"),
        ("min", 1.0, "min"),
        ("tps", 1.0, "tps"),
        ("qps", 1.0, "qps"),
        ("rps", 1.0, "rps"),
        ("usd", 1.0, "usd"),
        ("ms", 1.0, "ms"),
        ("kb", 1.0 / 1024.0, "mb"),
        ("mb", 1.0, "mb"),
        ("gb", 1024.0, "mb"),
        ("s", 1000.0, "ms"),
        ("h", 1.0, "hour"),
    ];
    for &(u, factor, canonical) in ASCII_UNITS {
        if lower_prefix.starts_with(u) {
            let end = rest
                .char_indices()
                .nth(u.chars().count())
                .map_or(rest.len(), |(idx, _)| idx);
            let next_char = rest[end..].chars().next();
            if !next_char.is_some_and(|c| c.is_ascii_alphabetic()) {
                return Some((factor, canonical, end));
            }
        }
    }
    None
}

fn extract_metrics(text: &str) -> Vec<MetricToken> {
    let bytes = text.as_bytes();
    let mut metrics = Vec::new();
    let mut i = 0usize;
    while i < bytes.len() {
        if !bytes[i].is_ascii_digit() {
            i += 1;
            continue;
        }
        let prev = text[..i].chars().next_back();
        if matches!(prev, Some('v' | 'V' | '第' | '-' | '/' | '.'))
            || prev.is_some_and(|c| c.is_ascii_alphanumeric())
        {
            while i < bytes.len() && (bytes[i].is_ascii_digit() || bytes[i] == b'.') {
                i += 1;
            }
            continue;
        }
        let mut end = i;
        let mut seen_dot = false;
        while end < bytes.len() {
            if bytes[end].is_ascii_digit() {
                end += 1;
            } else if bytes[end] == b'.'
                && !seen_dot
                && end + 1 < bytes.len()
                && bytes[end + 1].is_ascii_digit()
            {
                seen_dot = true;
                end += 1;
            } else {
                break;
            }
        }
        let Ok(num) = text[i..end].parse::<f64>() else {
            i = end;
            continue;
        };
        let unit_start = if bytes.get(end) == Some(&b' ') {
            end + 1
        } else {
            end
        };
        if let Some((factor, canonical, unit_bytes)) = parse_metric_unit(&text[unit_start..]) {
            metrics.push(MetricToken {
                value: num * factor,
                unit: canonical,
                display: text[i..unit_start + unit_bytes].to_owned(),
            });
            i = unit_start + unit_bytes;
        } else {
            i = end;
        }
    }
    metrics
}

fn numeric_metric_conflict(a: &[MetricToken], b: &[MetricToken]) -> Option<(String, String)> {
    let approx_eq = |x: f64, y: f64| -> bool {
        let scale = x.abs().max(y.abs()).max(1e-9);
        (x - y).abs() <= scale * 0.01
    };
    for ma in a {
        let same_unit_b: Vec<&MetricToken> = b.iter().filter(|mb| mb.unit == ma.unit).collect();
        if same_unit_b.is_empty() {
            continue;
        }
        if !same_unit_b.iter().any(|mb| approx_eq(ma.value, mb.value)) {
            return Some((ma.display.clone(), same_unit_b[0].display.clone()));
        }
    }
    None
}

fn common_prefix_chars(a: &str, b: &str) -> usize {
    a.chars()
        .filter(|c| !c.is_whitespace())
        .zip(b.chars().filter(|c| !c.is_whitespace()))
        .take_while(|(ca, cb)| ca == cb)
        .count()
}

fn shared_subject_prefix(a: &str, b: &str) -> bool {
    let n = common_prefix_chars(a, b);
    if n < 4 {
        return false;
    }
    let has_cjk = a
        .chars()
        .filter(|c| !c.is_whitespace())
        .take(n)
        .any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c));
    has_cjk || n >= 12
}

fn implicit_exclusive(a: &str, b: &str) -> Option<((&'static str, &'static str), usize)> {
    const CJK_PAIRS: &[(&str, &str)] = &[
        ("线下", "线上"),
        ("纸质", "电子"),
        ("人工", "自动"),
        ("手动", "自动"),
        ("同步", "异步"),
        ("串行", "并行"),
        ("本地", "云端"),
        ("单体", "微服务"),
        ("启用", "停用"),
        ("启用", "禁用"),
        ("开启", "关闭"),
        ("盖章", "签章"),
    ];
    const EN_PAIRS: &[(&str, &str)] = &[
        ("online", "offline"),
        ("manual", "automatic"),
        ("manual", "automated"),
        ("enabled", "disabled"),
        ("synchronous", "asynchronous"),
    ];
    let en_words = |t: &str| -> HashSet<String> {
        t.split_whitespace()
            .map(|w| w.trim_matches(|c: char| is_audit_punct(c)).to_lowercase())
            .filter(|w| !w.is_empty())
            .collect()
    };
    let words_a = en_words(a);
    let words_b = en_words(b);

    let mut first: Option<(&'static str, &'static str)> = None;
    let mut count = 0usize;

    for &(x, y) in CJK_PAIRS {
        let a_x = a.contains(x);
        let a_y = a.contains(y);
        let b_x = b.contains(x);
        let b_y = b.contains(y);
        if (a_x && !a_y && b_y && !b_x) || (a_y && !a_x && b_x && !b_y) {
            first.get_or_insert((x, y));
            count += 1;
        }
    }
    for &(x, y) in EN_PAIRS {
        let a_x = words_a.contains(x);
        let a_y = words_a.contains(y);
        let b_x = words_b.contains(x);
        let b_y = words_b.contains(y);
        if (a_x && !a_y && b_y && !b_x) || (a_y && !a_x && b_x && !b_y) {
            first.get_or_insert((x, y));
            count += 1;
        }
    }
    first.map(|pair| (pair, count))
}

fn has_change_cue(t: &str) -> bool {
    [
        "改用",
        "改为",
        "改成",
        "换成",
        "换用",
        "切换为",
        "切换到",
        "替换为",
        "替代",
        "转为",
        "不再采用",
        "switched to",
        "replaced",
        "instead",
    ]
    .iter()
    .any(|cue| t.contains(cue))
}

fn has_negation(content: &str) -> bool {
    if [
        "已取消",
        "取消",
        "暂缓",
        "不再",
        "已否决",
        "否决",
        "已停止",
        "停止",
        "已放弃",
        "放弃",
        "已废止",
        "废止",
        "不启用",
        "不做",
    ]
    .iter()
    .any(|cue| content.contains(cue))
    {
        return true;
    }
    let lower = content.to_lowercase();
    [
        "cancelled",
        "canceled",
        "dropped",
        "abandoned",
        "deprecated",
        "rejected",
        "on hold",
        "discontinued",
        "no longer",
        "stopped",
        "removed",
        "not used",
        "won't use",
        "will not use",
        " not ",
        "n't ",
        "never ",
        "disabled",
    ]
    .iter()
    .any(|cue| lower.contains(cue))
}

fn build_alias_map(groups: &[Vec<String>]) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for group in groups {
        let Some(canonical) = group.first() else {
            continue;
        };
        let canon = canonical.trim().to_lowercase();
        for item in group {
            let key = item.trim().to_lowercase();
            if !key.is_empty() {
                map.insert(key, canon.clone());
            }
        }
    }
    map
}

fn canonicalize(value: &str, alias_map: &HashMap<String, String>) -> String {
    let lower = value.trim().to_lowercase();
    alias_map.get(&lower).cloned().unwrap_or(lower)
}

fn canonical_tokens(text: &str, alias_map: &HashMap<String, String>) -> HashSet<String> {
    let mut out = HashSet::new();
    for token in crate::search::index_tokens(text) {
        if token.chars().count() >= 2 && !token.chars().all(|c| c.is_ascii_digit()) {
            let mapped = alias_map.get(&token).cloned().unwrap_or(token);
            out.insert(mapped);
        }
    }
    // Also map any multi-char alias occurring verbatim in the text to its canonical token
    let lower = text.to_lowercase();
    for (alias, canon) in alias_map {
        if alias.chars().count() >= 2 && lower.contains(alias) {
            out.insert(canon.clone());
        }
    }
    out
}

fn jaccard(a: &HashSet<String>, b: &HashSet<String>) -> f64 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let inter = a.intersection(b).count() as f64;
    let union = a.union(b).count() as f64;
    if union == 0.0 {
        0.0
    } else {
        inter / union
    }
}

fn non_overlapping_validity(a: &Value, b: &Value) -> bool {
    let a_from = a["validFrom"].as_str();
    let a_until = a["validUntil"].as_str();
    let b_from = b["validFrom"].as_str();
    let b_until = b["validUntil"].as_str();
    matches!((a_until, b_from), (Some(u), Some(f)) if u < f)
        || matches!((b_until, a_from), (Some(u), Some(f)) if u < f)
}

fn disjoint_explicit_conditions(a: &Value, b: &Value) -> bool {
    let conds = |v: &Value| -> HashSet<String> {
        v["conditions"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|c| c.as_str().map(|s| s.trim().to_lowercase()))
            .filter(|s| !s.is_empty())
            .collect()
    };
    let ca = conds(a);
    let cb = conds(b);
    !ca.is_empty() && !cb.is_empty() && ca.is_disjoint(&cb)
}

struct ActiveMemory {
    id: String,
    revision: i64,
    facets: Value,
    text: String,
    tokens: HashSet<String>,
    subject_tokens: HashSet<String>,
    numbers: BTreeSet<String>,
    metrics: Vec<MetricToken>,
    dates: BTreeSet<DateToken>,
    stages: BTreeSet<&'static str>,
    owner: Option<String>,
    owner_subject: Option<String>,
    negated: bool,
    entity: Option<String>,
}

/// Scans active non-archived memories for latent contradictions and near-duplicates.
/// Safe to execute in idle maintenance (`maintenance.rs`) or on user demand.
pub(crate) fn scan(conn: &Connection, scope: Option<&str>) -> Result<Value> {
    if !table_exists(conn)? {
        return Ok(json!({"scannedProjects": 0, "newFindings": 0, "autoResolved": 0}));
    }
    let at = now();
    // Auto-resolve open audits if either memory was revised, moved to archive/clarify, or archived project.
    let auto_resolved = conn.execute(
        "UPDATE memory_audits SET status='resolved', updated_at=?1
         WHERE status='open'
           AND (
             NOT EXISTS(
               SELECT 1 FROM memories ma
               JOIN revisions ra ON ra.memory_id=ma.id AND ra.number=ma.revision
               WHERE ma.id=memory_audits.memory_a_id
                 AND ma.revision=memory_audits.memory_a_revision
                 AND ma.state='active'
                 AND NOT EXISTS(SELECT 1 FROM revision_retention rt WHERE rt.revision_id=ra.id AND json_extract(rt.policy,'$.layer') IN ('archive','clarify'))
             )
             OR NOT EXISTS(
               SELECT 1 FROM memories mb
               JOIN revisions rb ON rb.memory_id=mb.id AND rb.number=mb.revision
               WHERE mb.id=memory_audits.memory_b_id
                 AND mb.revision=memory_audits.memory_b_revision
                 AND mb.state='active'
                 AND NOT EXISTS(SELECT 1 FROM revision_retention rt WHERE rt.revision_id=rb.id AND json_extract(rt.policy,'$.layer') IN ('archive','clarify'))
             )
             OR EXISTS(SELECT 1 FROM workspace_lifecycle l WHERE l.kind='project' AND l.entity_id=memory_audits.project_id AND l.archived=1)
           )",
        [&at],
    )?;

    let mut project_stmt = conn.prepare(
        "SELECT id FROM projects p
         WHERE (?1 IS NULL OR p.id=?1)
           AND NOT EXISTS(SELECT 1 FROM workspace_lifecycle l WHERE l.kind='project' AND l.entity_id=p.id AND l.archived=1)
         ORDER BY p.id",
    )?;
    let projects: Vec<String> = project_stmt
        .query_map([scope], |r| r.get(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    drop(project_stmt);

    let mut new_findings = 0usize;
    for project_id in &projects {
        let alias_groups = crate::aliases::load_groups(conn, Some(project_id))?;
        let alias_map = build_alias_map(&alias_groups);
        let mut stmt = conn.prepare(
            "SELECT m.id, m.revision, m.content, coalesce(f.facets,'{}')
             FROM memories m
             JOIN revisions r ON r.memory_id=m.id AND r.number=m.revision AND r.content=m.content
             LEFT JOIN revision_facets f ON f.revision_id=r.id
             WHERE m.project_id=?1
               AND m.state='active'
               AND NOT EXISTS(SELECT 1 FROM revision_retention rt WHERE rt.revision_id=r.id AND json_extract(rt.policy,'$.layer') IN ('archive','clarify'))
               AND NOT EXISTS(SELECT 1 FROM revisions lr JOIN revision_evidence le ON le.revision_id=lr.id JOIN segments lg ON lg.id=le.segment_id JOIN workspace_lifecycle l ON l.kind='source' AND l.entity_id=lg.source_id AND l.archived=1 WHERE lr.memory_id=m.id)
             ORDER BY m.updated_at DESC, m.id
             LIMIT ?2",
        )?;
        let items: Vec<ActiveMemory> = stmt
            .query_map(params![project_id, MAX_SCAN_PER_PROJECT as i64], |r| {
                let id: String = r.get(0)?;
                let revision: i64 = r.get(1)?;
                let content: String = r.get(2)?;
                let facets_raw: String = r.get(3)?;
                Ok((id, revision, content, facets_raw))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?
            .into_iter()
            .map(|(id, revision, content, facets_raw)| {
                let facets: Value = serde_json::from_str(&facets_raw).unwrap_or_else(|_| json!({}));
                let text = content.to_lowercase();
                let tokens = canonical_tokens(&content, &alias_map);
                let numbers = extract_numbers(&content);
                let metrics = extract_metrics(&content);
                let dates = extract_dates(&content);
                let stages = extract_stages(&content);
                let raw_text_owner = extract_owner_raw(&content);
                let owner = if facets["role"].as_str() == Some("owner") {
                    facets["entity"]
                        .as_str()
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(|e| canonicalize(e, &alias_map))
                        .or_else(|| {
                            raw_text_owner
                                .as_deref()
                                .map(|r| canonicalize(r, &alias_map))
                        })
                } else {
                    raw_text_owner
                        .as_deref()
                        .map(|r| canonicalize(r, &alias_map))
                };
                let owner_subject = raw_text_owner
                    .as_deref()
                    .and_then(|raw| owner_subject(&content, raw));
                let subject_tokens: HashSet<String> = tokens
                    .iter()
                    .filter(|t| {
                        let s = t.as_str();
                        owner.as_deref() != Some(s)
                            && !matches!(
                                s,
                                "负责"
                                    | "负责人"
                                    | "接手"
                                    | "牵头"
                                    | "跟进"
                                    | "改由"
                                    | "转交"
                                    | "交给"
                                    | "改派"
                                    | "交由"
                                    | "全权"
                                    | "承接"
                                    | "承担"
                                    | "主导"
                                    | "已交由"
                                    | "owner"
                                    | "owned"
                                    | "assigned"
                                    | "leads"
                                    | "owns"
                                    | "by"
                                    | "to"
                                    | "is"
                                    | "the"
                            )
                    })
                    .cloned()
                    .collect();
                let negated = has_negation(&content);
                let entity = facets["entity"]
                    .as_str()
                    .map(str::trim)
                    .filter(|e| !e.is_empty() && crate::search::specific_entity(e))
                    .map(|e| canonicalize(e, &alias_map));
                ActiveMemory {
                    id,
                    revision,
                    facets,
                    text,
                    tokens,
                    subject_tokens,
                    numbers,
                    metrics,
                    dates,
                    stages,
                    owner,
                    owner_subject,
                    negated,
                    entity,
                }
            })
            .collect();
        drop(stmt);

        let candidate_pairs: Vec<(usize, usize)> = if items.len() <= 200 {
            let mut pairs = Vec::with_capacity(items.len() * items.len().saturating_sub(1) / 2);
            for i in 0..items.len() {
                for j in (i + 1)..items.len() {
                    pairs.push((i, j));
                }
            }
            pairs
        } else {
            let mut buckets: HashMap<String, Vec<usize>> = HashMap::new();
            for (idx, item) in items.iter().enumerate() {
                for tok in &item.tokens {
                    buckets.entry(format!("t:{tok}")).or_default().push(idx);
                }
                if let Some(ent) = &item.entity {
                    buckets.entry(format!("e:{ent}")).or_default().push(idx);
                }
                if let Some(sub) = &item.owner_subject {
                    buckets.entry(format!("o:{sub}")).or_default().push(idx);
                }
                let p4: String = item
                    .text
                    .chars()
                    .filter(|c| !c.is_whitespace())
                    .take(4)
                    .collect();
                if p4.chars().count() >= 4 {
                    buckets.entry(format!("p:{p4}")).or_default().push(idx);
                }
            }
            let mut seen_pairs: BTreeSet<(usize, usize)> = BTreeSet::new();
            for indices in buckets.values() {
                if !(2..=50).contains(&indices.len()) {
                    continue;
                }
                for a_i in 0..indices.len() {
                    for b_i in (a_i + 1)..indices.len() {
                        let pair = (
                            indices[a_i].min(indices[b_i]),
                            indices[a_i].max(indices[b_i]),
                        );
                        seen_pairs.insert(pair);
                        if seen_pairs.len() >= 20_000 {
                            break;
                        }
                    }
                    if seen_pairs.len() >= 20_000 {
                        break;
                    }
                }
                if seen_pairs.len() >= 20_000 {
                    break;
                }
            }
            seen_pairs.into_iter().collect()
        };

        for (i, j) in candidate_pairs {
            let (a, b) = if items[i].id < items[j].id {
                (&items[i], &items[j])
            } else {
                (&items[j], &items[i])
            };
            if non_overlapping_validity(&a.facets, &b.facets)
                || disjoint_explicit_conditions(&a.facets, &b.facets)
            {
                continue;
            }
            let shared_entity = matches!((&a.entity, &b.entity), (Some(ea), Some(eb)) if ea == eb);
            let sim = jaccard(&a.tokens, &b.tokens);
            let subject_sim = jaccard(&a.subject_tokens, &b.subject_tokens);
            let shared_stage = !a.stages.is_disjoint(&b.stages);
            let prefix = shared_subject_prefix(&a.text, &b.text);
            let same_owner_subject =
                matches!((&a.owner_subject, &b.owner_subject), (Some(x), Some(y)) if x == y);
            let implicit = implicit_exclusive(&a.text, &b.text);
            let has_metrics_pair = !a.metrics.is_empty() && !b.metrics.is_empty();
            let contained = {
                let pair = if a.tokens.len() < b.tokens.len() && a.tokens.is_subset(&b.tokens) {
                    Some((&a.tokens, &b.tokens))
                } else if b.tokens.len() < a.tokens.len() && b.tokens.is_subset(&a.tokens) {
                    Some((&b.tokens, &a.tokens))
                } else {
                    None
                };
                pair.is_some_and(|(small, big)| {
                    small.len() >= 4
                        && small.len() * 10 >= big.len() * 7
                        && a.numbers == b.numbers
                        && !big
                            .difference(small)
                            .any(|t| t.contains(['不', '未', '无', '非', '没']))
                })
            };
            if sim < 0.30
                && !shared_entity
                && subject_sim < 0.45
                && !(shared_stage && prefix)
                && !same_owner_subject
                && !(implicit.is_some() && prefix)
                && !(prefix && has_metrics_pair)
                && !contained
            {
                continue;
            }
            let stage_compatible = a.stages.is_empty() || b.stages.is_empty() || shared_stage;
            let num_conflict = numeric_metric_conflict(&a.metrics, &b.metrics);

            let finding: Option<(&str, String)> = if (sim >= 0.85 || contained)
                && stage_compatible
                && dates_match(&a.dates, &b.dates)
                && a.numbers == b.numbers
                && a.negated == b.negated
                && a.owner == b.owner
            {
                Some((
                    "duplicate_overlap",
                    "两条活跃记忆表述高度重复，建议保留更完整的一条，将另一条归档为仅存原文。"
                        .into(),
                ))
            } else if (sim >= 0.35 || shared_entity || (shared_stage && prefix))
                && stage_compatible
                && !a.dates.is_empty()
                && !b.dates.is_empty()
                && !a
                    .dates
                    .iter()
                    .any(|da| b.dates.iter().any(|db| da.matches(*db)))
            {
                let da = a
                    .dates
                    .iter()
                    .map(|d| d.format())
                    .collect::<Vec<_>>()
                    .join("、");
                let db = b
                    .dates
                    .iter()
                    .map(|d| d.format())
                    .collect::<Vec<_>>()
                    .join("、");
                Some((
                    "date_conflict",
                    format!("两条相关活跃记忆记录了不同日期（{da} vs {db}），可能存在排期变更后旧记忆未更新。"),
                ))
            } else if (same_owner_subject
                || ((sim >= 0.35 || shared_entity || subject_sim >= 0.50) && subject_sim >= 0.25))
                && matches!((&a.owner, &b.owner), (Some(oa), Some(ob)) if oa != ob)
            {
                let oa = a.owner.as_deref().unwrap_or("");
                let ob = b.owner.as_deref().unwrap_or("");
                Some((
                    "owner_conflict",
                    format!(
                        "两条相关活跃记忆记录了不同负责人（{oa} vs {ob}），请核对最新责任归属。"
                    ),
                ))
            } else if (sim >= 0.45 || (shared_entity && sim >= 0.30)) && a.negated != b.negated {
                Some((
                    "negation_conflict",
                    "两条相关活跃记忆存在肯定与取消/否决表述矛盾，请确认当前有效结论。".into(),
                ))
            } else if a.negated == b.negated
                && matches!(implicit, Some((_, count)) if count >= 2 || has_change_cue(&a.text) || has_change_cue(&b.text))
                && (prefix || sim >= 0.30 || shared_entity)
            {
                let ((x, y), _) = implicit.unwrap();
                Some((
                    "negation_conflict",
                    format!("两条相关活跃记忆对同一事项记录了互斥做法（{x} vs {y}），可能是方案变更后旧记忆未更新。"),
                ))
            } else if (sim >= 0.35 || shared_entity || prefix)
                && stage_compatible
                && dates_match(&a.dates, &b.dates)
                && num_conflict.is_some()
            {
                let (va, vb) = num_conflict.unwrap();
                Some((
                    "numeric_conflict",
                    format!("两条相关活跃记忆记录了不同数值指标（{va} vs {vb}），请核对最新标准或阈值。"),
                ))
            } else {
                None
            };

            if let Some((kind, reason)) = finding {
                let inserted = conn.execute(
                    "INSERT OR IGNORE INTO memory_audits(
                        id,project_id,memory_a_id,memory_a_revision,memory_b_id,memory_b_revision,
                        kind,reason,status,created_at,updated_at
                     ) VALUES(?,?,?,?,?,?,?,?,'open',?,?)",
                    params![
                        id(),
                        project_id,
                        a.id,
                        a.revision,
                        b.id,
                        b.revision,
                        kind,
                        reason,
                        at,
                        at,
                    ],
                )?;
                new_findings += inserted;
            }
        }
    }
    Ok(json!({
        "scannedProjects": projects.len(),
        "newFindings": new_findings,
        "autoResolved": auto_resolved,
    }))
}

pub(crate) fn list(conn: &Connection, p: &Value) -> Result<Value> {
    if !table_exists(conn)? {
        return Ok(json!({"audits": [], "openCount": 0}));
    }
    let scope = p["projectId"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty() && *s != "all");
    let mut stmt = conn.prepare(
        "SELECT a.id,a.project_id,a.kind,a.reason,a.status,a.created_at,a.updated_at,
                a.memory_a_id,a.memory_a_revision,ma.content,ma.source_title,ma.updated_at,
                a.memory_b_id,a.memory_b_revision,mb.content,mb.source_title,mb.updated_at
         FROM memory_audits a
         JOIN memories ma ON ma.id=a.memory_a_id
         JOIN memories mb ON mb.id=a.memory_b_id
         WHERE a.status='open'
           AND (?1 IS NULL OR a.project_id=?1)
         ORDER BY a.updated_at DESC, a.id
         LIMIT 100",
    )?;
    let audits = stmt
        .query_map([scope], |r| {
            Ok(json!({
                "id": r.get::<_, String>(0)?,
                "projectId": r.get::<_, String>(1)?,
                "kind": r.get::<_, String>(2)?,
                "reason": r.get::<_, String>(3)?,
                "status": r.get::<_, String>(4)?,
                "createdAt": r.get::<_, String>(5)?,
                "updatedAt": r.get::<_, String>(6)?,
                "memoryA": {
                    "id": r.get::<_, String>(7)?,
                    "revision": r.get::<_, i64>(8)?,
                    "content": r.get::<_, String>(9)?,
                    "sourceTitle": r.get::<_, String>(10)?,
                    "updatedAt": r.get::<_, String>(11)?,
                },
                "memoryB": {
                    "id": r.get::<_, String>(12)?,
                    "revision": r.get::<_, i64>(13)?,
                    "content": r.get::<_, String>(14)?,
                    "sourceTitle": r.get::<_, String>(15)?,
                    "updatedAt": r.get::<_, String>(16)?,
                },
            }))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let open_count = audits.len();
    Ok(json!({"audits": audits, "openCount": open_count}))
}

/// Archives a superseded memory by appending a new `user_correction` revision with
/// `retention.layer = "archive"` (preserves immutable revision history and backup invariants).
fn archive_superseded_memory(
    tx: &Connection,
    memory_id: &str,
    expected_revision: i64,
    reason: &str,
) -> Result<()> {
    let row: Option<(String, i64)> = tx
        .query_row(
            "SELECT content, revision FROM memories WHERE id=? AND state='active'",
            [memory_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((content, current_rev)) = row else {
        return Err(AppError::new("NOT_FOUND", "目标记忆不存在"));
    };
    if current_rev != expected_revision {
        return Err(AppError::new(
            "REVISION_CONFLICT",
            "相关记忆已被修订，请重新运行巡检后再处理",
        ));
    }
    let old_rev_id: String = tx.query_row(
        "SELECT id FROM revisions WHERE memory_id=? AND number=?",
        params![memory_id, current_rev],
        |r| r.get(0),
    )?;
    let next_number = current_rev + 1;
    let new_rev_id = id();
    let at = now();
    tx.execute(
        "UPDATE memories SET revision=?, updated_at=? WHERE id=?",
        params![next_number, at, memory_id],
    )?;
    tx.execute(
        "INSERT INTO revisions VALUES(?,?,?,?,?,'user_correction',?)",
        params![new_rev_id, memory_id, next_number, content, reason, at],
    )?;
    tx.execute(
        "INSERT OR IGNORE INTO revision_facets SELECT ?, facets FROM revision_facets WHERE revision_id=?",
        params![new_rev_id, old_rev_id],
    )?;
    tx.execute(
        "INSERT OR IGNORE INTO revision_evidence SELECT ?, segment_id FROM revision_evidence WHERE revision_id=?",
        params![new_rev_id, old_rev_id],
    )?;
    crate::retention::save_revision(
        tx,
        &new_rev_id,
        &json!({"layer": "archive", "reason": reason}),
    )?;
    Ok(())
}

fn merge_memories_in_tx(
    tx: &Connection,
    keep_id: &str,
    keep_rev: i64,
    drop_id: &str,
    drop_rev: i64,
    merged_content: &str,
    reason: &str,
) -> Result<()> {
    let keep_cur: Option<i64> = tx
        .query_row(
            "SELECT revision FROM memories WHERE id=? AND state='active'",
            [keep_id],
            |r| r.get(0),
        )
        .optional()?;
    let drop_cur: Option<i64> = tx
        .query_row(
            "SELECT revision FROM memories WHERE id=? AND state='active'",
            [drop_id],
            |r| r.get(0),
        )
        .optional()?;
    if keep_cur != Some(keep_rev) || drop_cur != Some(drop_rev) {
        return Err(AppError::new(
            "REVISION_CONFLICT",
            "相关记忆已被修订，请重新运行巡检后再处理",
        ));
    }
    let keep_old_rev_id: String = tx.query_row(
        "SELECT id FROM revisions WHERE memory_id=? AND number=?",
        params![keep_id, keep_rev],
        |r| r.get(0),
    )?;
    let drop_old_rev_id: String = tx.query_row(
        "SELECT id FROM revisions WHERE memory_id=? AND number=?",
        params![drop_id, drop_rev],
        |r| r.get(0),
    )?;
    let next_rev = keep_rev + 1;
    let new_rev_id = id();
    let at = now();
    tx.execute(
        "UPDATE memories SET content=?, revision=?, updated_at=? WHERE id=?",
        params![merged_content, next_rev, at, keep_id],
    )?;
    tx.execute(
        "INSERT INTO revisions VALUES(?,?,?,?,?,'user_correction',?)",
        params![new_rev_id, keep_id, next_rev, merged_content, reason, at],
    )?;
    tx.execute(
        "INSERT OR IGNORE INTO revision_facets SELECT ?, facets FROM revision_facets WHERE revision_id=?",
        params![new_rev_id, keep_old_rev_id],
    )?;
    tx.execute(
        "INSERT OR IGNORE INTO revision_evidence SELECT ?, segment_id FROM revision_evidence WHERE revision_id IN (?,?)",
        params![new_rev_id, keep_old_rev_id, drop_old_rev_id],
    )?;
    crate::retention::save_revision(
        tx,
        &new_rev_id,
        &json!({"layer": "durable", "reason": reason}),
    )?;
    archive_superseded_memory(tx, drop_id, drop_rev, reason)?;
    Ok(())
}

pub(crate) fn resolve(conn: &mut Connection, p: &Value) -> Result<Value> {
    let audit_id = required(p, "auditId")?.trim();
    let action = required(p, "action")?.trim();
    if !matches!(action, "dismiss" | "keep_a" | "keep_b" | "merge") {
        return Err(invalid("处理方式仅支持 dismiss / keep_a / keep_b / merge"));
    }
    let row: Option<(String, i64, String, i64, String)> = conn
        .query_row(
            "SELECT memory_a_id,memory_a_revision,memory_b_id,memory_b_revision,status
             FROM memory_audits WHERE id=?",
            [audit_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional()?;
    let Some((mem_a, rev_a, mem_b, rev_b, status)) = row else {
        return Err(AppError::new("NOT_FOUND", "冲突巡检记录不存在"));
    };
    if status != "open" {
        return Err(AppError::new("CONFLICT", "该巡检项已处理，请刷新"));
    }
    let merged_content = if action == "merge" {
        let m = required(p, "mergedContent")?.trim();
        if m.is_empty() {
            return Err(invalid("合并后的记忆正文不能为空"));
        }
        crate::db::validate_content(m)?;
        Some(m.to_owned())
    } else {
        None
    };
    let reason = p["reason"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(if action == "merge" {
            "库内冲突巡检合并：整合两条记忆并保留双方原文依据"
        } else {
            "库内冲突巡检确认：已由另一条活跃记忆替代，转仅存原文"
        });
    let tx = conn.transaction()?;
    let mut merged_memory_id: Option<String> = None;
    let new_status = match action {
        "dismiss" => "dismissed",
        "keep_a" => {
            archive_superseded_memory(&tx, &mem_b, rev_b, reason)?;
            "resolved"
        }
        "keep_b" => {
            archive_superseded_memory(&tx, &mem_a, rev_a, reason)?;
            "resolved"
        }
        "merge" => {
            let keep_b = p["keepTarget"].as_str() == Some("b");
            let (keep_id, keep_rev, drop_id, drop_rev) = if keep_b {
                (mem_b.as_str(), rev_b, mem_a.as_str(), rev_a)
            } else {
                (mem_a.as_str(), rev_a, mem_b.as_str(), rev_b)
            };
            merge_memories_in_tx(
                &tx,
                keep_id,
                keep_rev,
                drop_id,
                drop_rev,
                merged_content.as_deref().unwrap(),
                reason,
            )?;
            merged_memory_id = Some(keep_id.to_owned());
            "resolved"
        }
        _ => unreachable!(),
    };
    tx.execute(
        "UPDATE memory_audits SET status=?, updated_at=? WHERE id=?",
        params![new_status, now(), audit_id],
    )?;
    tx.commit()?;
    let mut out = json!({"resolved": true, "status": new_status});
    if let Some(mid) = merged_memory_id {
        out["mergedMemoryId"] = json!(mid);
    }
    Ok(out)
}

pub(crate) fn dispatch(conn: &mut Connection, command: &str, p: &Value) -> Result<Value> {
    match command {
        "get_memory_audits" => list(conn, p),
        "run_memory_audit" => {
            let scope = p["projectId"]
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty() && *s != "all");
            let summary = scan(conn, scope)?;
            let mut listed = list(conn, p)?;
            listed["scan"] = summary;
            Ok(listed)
        }
        "resolve_memory_audit" => resolve(conn, p),
        _ => Err(invalid("不支持的冲突巡检操作")),
    }
}

pub(crate) fn validate_backup(conn: &Connection) -> Result<()> {
    if !table_exists(conn)? {
        return Err(AppError::new("INVALID_BACKUP", "备份缺少记忆冲突巡检表"));
    }
    let invalid: i64 = conn.query_row(
        "SELECT count(*) FROM memory_audits a
         WHERE a.kind NOT IN ('date_conflict','owner_conflict','negation_conflict','numeric_conflict','duplicate_overlap')
            OR a.status NOT IN ('open','dismissed','resolved')
            OR a.memory_a_revision < 1 OR a.memory_b_revision < 1
            OR NOT EXISTS(SELECT 1 FROM projects p WHERE p.id=a.project_id)
            OR NOT EXISTS(SELECT 1 FROM memories m WHERE m.id=a.memory_a_id AND m.project_id=a.project_id)
            OR NOT EXISTS(SELECT 1 FROM memories m WHERE m.id=a.memory_b_id AND m.project_id=a.project_id)",
        [],
        |r| r.get(0),
    )?;
    if invalid != 0 {
        return Err(AppError::new("INVALID_BACKUP", "备份中的冲突巡检记录无效"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;

    fn insert_active(conn: &Connection, id: &str, project: &str, content: &str) {
        conn.execute(
            "INSERT INTO memories VALUES(?,?,'fact',?,1,'active','纪要','now','now')",
            params![id, project, content],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO revisions VALUES(?,?,1,?,'确认','confirmation','now')",
            params![id, id, content],
        )
        .unwrap();
    }

    #[test]
    fn audit_detects_date_owner_negation_and_duplicate_conflicts_and_resolves_cleanly() {
        let dir = tempfile::tempdir().unwrap();
        let mut db = Database::open(dir.path().to_path_buf()).unwrap();
        db.conn
            .execute("INSERT INTO projects VALUES('p1','支付二期','','now')", [])
            .unwrap();

        insert_active(&db.conn, "m1", "p1", "支付网关上线日期确定为 2026-12-01。");
        insert_active(&db.conn, "m2", "p1", "支付网关上线日期确定为 2026-12-08。");
        insert_active(&db.conn, "m3", "p1", "登录审计模块由王明负责。");
        insert_active(&db.conn, "m4", "p1", "登录审计模块由李静负责。");
        insert_active(&db.conn, "m5", "p1", "灰度切换方案需要提前通知客服团队。");
        insert_active(
            &db.conn,
            "m6",
            "p1",
            "灰度切换方案已取消，不再通知客服团队。",
        );

        let summary = scan(&db.conn, Some("p1")).unwrap();
        assert!(summary["newFindings"].as_u64().unwrap() >= 3);

        let listed = list(&db.conn, &json!({"projectId": "p1"})).unwrap();
        let audits = listed["audits"].as_array().unwrap();
        assert!(audits.iter().any(|a| a["kind"] == "date_conflict"));
        assert!(audits.iter().any(|a| a["kind"] == "owner_conflict"));
        assert!(audits.iter().any(|a| a["kind"] == "negation_conflict"));

        let date_audit = audits
            .iter()
            .find(|a| a["kind"] == "date_conflict")
            .unwrap();
        let audit_id = date_audit["id"].as_str().unwrap();
        let superseded_id = date_audit["memoryA"]["id"].as_str().unwrap().to_owned();
        resolve(
            &mut db.conn,
            &json!({"auditId": audit_id, "action": "keep_b", "reason": "12-08 为最新排期"}),
        )
        .unwrap();

        // Superseded memory moved to revision 2 with retention layer = archive
        let rev: i64 = db
            .conn
            .query_row(
                "SELECT revision FROM memories WHERE id=?",
                [&superseded_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(rev, 2);
        let rev_id: String = db
            .conn
            .query_row(
                "SELECT id FROM revisions WHERE memory_id=? AND number=2",
                [&superseded_id],
                |r| r.get(0),
            )
            .unwrap();
        let policy = crate::retention::revision(&db.conn, &rev_id).unwrap();
        assert_eq!(policy["layer"], "archive");
    }

    #[test]
    fn audit_handles_non_iso_dates_stage_guard_natural_owner_and_english_negation() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path().to_path_buf()).unwrap();
        db.conn
            .execute("INSERT INTO projects VALUES('p1','Nova','','now')", [])
            .unwrap();

        // 1) Chinese date conflict ("12月5日" vs "12月12日")
        insert_active(&db.conn, "c1", "p1", "Nova网关发布时间定在12月5日。");
        insert_active(&db.conn, "c2", "p1", "Nova网关发布时间调整为12月12日。");

        // 2) English date conflict ("Dec 5" vs "Dec 19")
        insert_active(
            &db.conn,
            "e1",
            "p1",
            "Atlas billing migration launch date is Dec 5.",
        );
        insert_active(
            &db.conn,
            "e2",
            "p1",
            "Atlas billing migration launch date is Dec 19.",
        );

        // 3) Equivalent cross-format dates should NOT conflict ("2026-11-28" == "11月28日")
        insert_active(&db.conn, "q1", "p1", "Orion灰度验证日期定在2026-11-28。");
        insert_active(&db.conn, "q2", "p1", "Orion灰度验证时间已确认为11月28日。");

        // 4) Same-project different-stage dates should NOT conflict ("封板" vs "上线")
        insert_active(
            &db.conn,
            "s1",
            "p1",
            "Apollo版本代码封板日期定在2026-11-20。",
        );
        insert_active(
            &db.conn,
            "s2",
            "p1",
            "Apollo版本正式上线日期定在2026-12-01。",
        );

        // 5) Natural Chinese owner conflict ("王明负责" vs "李静接手")
        insert_active(&db.conn, "o1", "p1", "账单对账中心重构由王明负责推进。");
        insert_active(&db.conn, "o2", "p1", "账单对账中心重构改由李静接手。");

        // 6) English owner conflict ("owned by Alice" vs "assigned to Bob")
        insert_active(
            &db.conn,
            "eo1",
            "p1",
            "Token rotation service is owned by Alice.",
        );
        insert_active(
            &db.conn,
            "eo2",
            "p1",
            "Token rotation service is assigned to Bob.",
        );

        // 7) English negation conflict ("deprecated / no longer")
        insert_active(
            &db.conn,
            "n1",
            "p1",
            "Legacy webhook signature V1 remains active for partner callbacks.",
        );
        insert_active(
            &db.conn,
            "n2",
            "p1",
            "Legacy webhook signature V1 is deprecated and no longer used for partner callbacks.",
        );

        // 8) Same project unrelated tasks with different owners + shared entity should NOT conflict
        insert_active(&db.conn, "u1", "p1", "Nova移动端推送通知由张三负责。");
        insert_active(&db.conn, "u2", "p1", "Nova财务对账报表由赵四负责。");
        for (mid, ent) in [("u1", "Nova"), ("u2", "Nova")] {
            db.conn
                .execute(
                    "INSERT INTO revision_facets VALUES(?,?)",
                    params![mid, json!({"entity": ent}).to_string()],
                )
                .unwrap();
        }

        scan(&db.conn, Some("p1")).unwrap();
        let listed = list(&db.conn, &json!({"projectId": "p1"})).unwrap();
        let audits = listed["audits"].as_array().unwrap();
        let has_pair = |x: &str, y: &str, kind: &str| {
            audits.iter().any(|a| {
                a["kind"] == kind
                    && ((a["memoryA"]["id"] == x && a["memoryB"]["id"] == y)
                        || (a["memoryA"]["id"] == y && a["memoryB"]["id"] == x))
            })
        };

        assert!(has_pair("c1", "c2", "date_conflict"), "audits: {audits:?}");
        assert!(has_pair("e1", "e2", "date_conflict"), "audits: {audits:?}");
        assert!(
            !has_pair("q1", "q2", "date_conflict"),
            "equivalent dates conflicted: {audits:?}"
        );
        assert!(
            !has_pair("s1", "s2", "date_conflict"),
            "different stages conflicted: {audits:?}"
        );
        assert!(has_pair("o1", "o2", "owner_conflict"), "audits: {audits:?}");
        assert!(
            has_pair("eo1", "eo2", "owner_conflict"),
            "audits: {audits:?}"
        );
        assert!(
            has_pair("n1", "n2", "negation_conflict"),
            "audits: {audits:?}"
        );
        assert!(
            !has_pair("u1", "u2", "owner_conflict"),
            "unrelated shared-entity tasks conflicted: {audits:?}"
        );
    }

    #[test]
    fn audit_closes_paraphrase_handover_implicit_and_containment_boundaries() {
        let check_pair = |pid: &str, a: &str, b: &str| -> Vec<String> {
            let dir = tempfile::tempdir().unwrap();
            let db = Database::open(dir.path().to_path_buf()).unwrap();
            db.conn
                .execute("INSERT INTO projects VALUES(?,?,?,'now')", [pid, pid, ""])
                .unwrap();
            insert_active(&db.conn, "m1", pid, a);
            insert_active(&db.conn, "m2", pid, b);
            scan(&db.conn, Some(pid)).unwrap();
            let listed = list(&db.conn, &json!({"projectId": pid})).unwrap();
            listed["audits"]
                .as_array()
                .unwrap()
                .iter()
                .map(|item| item["kind"].as_str().unwrap().to_owned())
                .collect()
        };

        assert!(check_pair(
            "p_para",
            "风控规则引擎封板日期为 2026-12-02。",
            "风控规则引擎代码冻结推迟到 2026-12-09。"
        )
        .contains(&"date_conflict".to_owned()));
        assert!(check_pair(
            "p_hand",
            "退款对账任务已交由王明接手跟进。",
            "退款对账任务改派李静全权承接。"
        )
        .contains(&"owner_conflict".to_owned()));
        assert!(check_pair(
            "p_imp",
            "客户验收采用线下纸质盖章确认。",
            "客户验收改用线上电子签章确认。"
        )
        .contains(&"negation_conflict".to_owned()));
        assert!(check_pair(
            "p_dup",
            "Authentication audit events are retained for 180 days.",
            "Authentication audit events are retained for 180 days in production."
        )
        .contains(&"duplicate_overlap".to_owned()));

        assert!(check_pair(
            "p_roles",
            "支付重构二期后端开发由王明负责。",
            "支付重构二期测试验收由张敏负责。"
        )
        .is_empty());
        assert!(!check_pair(
            "p_num",
            "账户锁定时长为 15 分钟。",
            "账户锁定时长为 30 分钟。"
        )
        .contains(&"duplicate_overlap".to_owned()));
        assert!(!check_pair(
            "p_not",
            "Single sign-on is enabled.",
            "Single sign-on is not enabled."
        )
        .contains(&"duplicate_overlap".to_owned()));
    }

    #[test]
    fn audit_detects_unit_aware_numeric_conflict_and_ignores_equivalent_units() {
        let check_pair = |pid: &str, a: &str, b: &str| -> Vec<String> {
            let dir = tempfile::tempdir().unwrap();
            let db = Database::open(dir.path().to_path_buf()).unwrap();
            db.conn
                .execute("INSERT INTO projects VALUES(?,?,?,'now')", [pid, pid, ""])
                .unwrap();
            insert_active(&db.conn, "m1", pid, a);
            insert_active(&db.conn, "m2", pid, b);
            scan(&db.conn, Some(pid)).unwrap();
            let listed = list(&db.conn, &json!({"projectId": pid})).unwrap();
            listed["audits"]
                .as_array()
                .unwrap()
                .iter()
                .map(|item| item["kind"].as_str().unwrap().to_owned())
                .collect()
        };

        assert!(check_pair(
            "p_ms",
            "支付网关响应时间上限为 200ms。",
            "支付网关响应时间放宽至 0.5s。"
        )
        .contains(&"numeric_conflict".to_owned()));
        assert!(check_pair(
            "p_min",
            "账户锁定时长为 15 分钟。",
            "账户锁定时长为 30 分钟。"
        )
        .contains(&"numeric_conflict".to_owned()));
        assert!(!check_pair(
            "p_eq",
            "支付网关超时阈值为 1000ms。",
            "支付网关超时阈值为 1s。"
        )
        .contains(&"numeric_conflict".to_owned()));
    }

    #[test]
    fn audit_merge_preserves_combined_evidence_and_passes_backup_validation() {
        let dir = tempfile::tempdir().unwrap();
        let mut db = Database::open(dir.path().to_path_buf()).unwrap();
        db.conn
            .execute("INSERT INTO projects VALUES('p1','合并项目','','now')", [])
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO sources VALUES('s1','p1','压测文档','text','s1.txt',NULL,'now','h1','ready',2,NULL,'originals/s1.txt')",
                [],
            )
            .unwrap();
        for (mid, sid, ord, content) in [
            ("ma", "seg_a", 0, "支付网关响应时间上限为 200ms。"),
            (
                "mb",
                "seg_b",
                1,
                "支付网关响应时间放宽至 0.5s，限灰度阶段。",
            ),
        ] {
            db.conn
                .execute(
                    "INSERT INTO segments VALUES(?,?,?,?,?,?)",
                    params![sid, "s1", "v1", ord, format!("段{}", ord + 1), content],
                )
                .unwrap();
            insert_active(&db.conn, mid, "p1", content);
            db.conn
                .execute(
                    "INSERT INTO revision_evidence VALUES(?,?)",
                    params![mid, sid],
                )
                .unwrap();
        }

        scan(&db.conn, Some("p1")).unwrap();
        let audits = list(&db.conn, &json!({"projectId": "p1"})).unwrap();
        let audit_id = audits["audits"][0]["id"].as_str().unwrap();

        let res = resolve(
            &mut db.conn,
            &json!({
                "auditId": audit_id,
                "action": "merge",
                "mergedContent": "支付网关全量上限为 200ms（灰度期间放宽至 0.5s）。",
            }),
        )
        .unwrap();
        assert_eq!(res["status"], "resolved");
        assert_eq!(res["mergedMemoryId"], "ma");

        let (ma_rev, ma_content): (i64, String) = db
            .conn
            .query_row(
                "SELECT revision, content FROM memories WHERE id='ma'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(ma_rev, 2);
        assert_eq!(
            ma_content,
            "支付网关全量上限为 200ms（灰度期间放宽至 0.5s）。"
        );

        let ma_rev2: String = db
            .conn
            .query_row(
                "SELECT id FROM revisions WHERE memory_id='ma' AND number=2",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let ev_count: i64 = db
            .conn
            .query_row(
                "SELECT count(*) FROM revision_evidence WHERE revision_id=?",
                [&ma_rev2],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(ev_count, 2);

        let mb_rev2: String = db
            .conn
            .query_row(
                "SELECT id FROM revisions WHERE memory_id='mb' AND number=2",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            crate::retention::revision(&db.conn, &mb_rev2).unwrap()["layer"],
            "archive"
        );

        validate_backup(&db.conn).unwrap();
        crate::retention::validate_backup(&db.conn).unwrap();
    }
}
