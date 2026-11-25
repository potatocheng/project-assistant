//! Procedural habit learning (PRELUDE edit-diff extraction, PAHF explicit feedback,
//! CIPHER context-aware selection, and ReMe utility tracking).
//!
//! Strict separation invariant: habits live completely outside `memories` and NEVER
//! create, rewrite, or supersede objective project facts.
use crate::{id, now, required, AppError, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

const PROPOSAL_THRESHOLD: i64 = 3;
const OBSERVATION_WINDOW_DAYS: i64 = 60;
const MAX_OBSERVATIONS_KEPT: i64 = 1_000;

pub(crate) fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS habit_observations(
            id TEXT PRIMARY KEY,
            project_id TEXT REFERENCES projects(id),
            source_kind TEXT NOT NULL CHECK(source_kind IN (
                'report_edit','copilot_approval','proactive_feedback',
                'proposal_edit','memory_correction','explicit_feedback'
            )),
            pattern_key TEXT NOT NULL,
            category TEXT NOT NULL CHECK(category IN ('writing','reminder','workflow','filtering')),
            summary TEXT NOT NULL,
            detail_json TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS habit_obs_pattern ON habit_observations(pattern_key, created_at);
        CREATE INDEX IF NOT EXISTS habit_obs_project ON habit_observations(project_id, created_at);

        CREATE TABLE IF NOT EXISTS habit_proposals(
            id TEXT PRIMARY KEY,
            project_id TEXT REFERENCES projects(id),
            pattern_key TEXT NOT NULL,
            category TEXT NOT NULL CHECK(category IN ('writing','reminder','workflow','filtering')),
            title TEXT NOT NULL,
            instruction TEXT NOT NULL,
            rule_json TEXT NOT NULL,
            evidence_count INTEGER NOT NULL CHECK(evidence_count>=1),
            confidence REAL NOT NULL CHECK(confidence>=0.0 AND confidence<=1.0),
            sample_ids_json TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('pending','confirmed','rejected')),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS habit_prop_status ON habit_proposals(status, updated_at);

        CREATE TABLE IF NOT EXISTS user_habits(
            id TEXT PRIMARY KEY,
            project_id TEXT REFERENCES projects(id),
            pattern_key TEXT NOT NULL,
            category TEXT NOT NULL CHECK(category IN ('writing','reminder','workflow','filtering')),
            title TEXT NOT NULL,
            instruction TEXT NOT NULL,
            rule_json TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('active','paused','archived')),
            confidence REAL NOT NULL CHECK(confidence>=0.0 AND confidence<=1.0),
            applied_count INTEGER NOT NULL DEFAULT 0 CHECK(applied_count>=0),
            accepted_count INTEGER NOT NULL DEFAULT 0 CHECK(accepted_count>=0),
            overridden_count INTEGER NOT NULL DEFAULT 0 CHECK(overridden_count>=0),
            version INTEGER NOT NULL CHECK(version>=1),
            last_applied_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS user_habits_scope ON user_habits(status, project_id, category);",
    )?;
    Ok(())
}

fn invalid(message: &str) -> AppError {
    AppError::new("VALIDATION", message)
}

fn table_exists(conn: &Connection, name: &str) -> Result<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?)",
        [name],
        |r| r.get(0),
    )?)
}

fn valid_category(category: &str) -> bool {
    matches!(category, "writing" | "reminder" | "workflow" | "filtering")
}

fn scope_project(conn: &Connection, p: &Value) -> Result<Option<String>> {
    let project = match p.get("projectId") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if s.trim().is_empty() || s.trim() == "all" => None,
        Some(Value::String(s)) => Some(s.trim().to_owned()),
        _ => return Err(invalid("项目范围无效")),
    };
    if let Some(ref pid) = project {
        let exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM projects WHERE id=?)",
            [pid],
            |r| r.get(0),
        )?;
        if !exists {
            return Err(AppError::new("NOT_FOUND", "项目不存在"));
        }
    }
    Ok(project)
}

fn clip(s: &str, max_chars: usize) -> String {
    s.chars().take(max_chars).collect()
}

fn has_percentage(text: &str) -> bool {
    let chars: Vec<char> = text.chars().collect();
    chars
        .windows(2)
        .any(|w| w[0].is_ascii_digit() && (w[1] == '%' || w[1] == '％'))
}

fn first_marker_pos(text: &str, markers: &[&str]) -> Option<usize> {
    markers.iter().filter_map(|m| text.find(m)).min()
}

fn bullet_line_count(text: &str) -> usize {
    text.lines()
        .filter(|line| {
            let trimmed = line.trim_start();
            trimmed.starts_with("- ")
                || trimmed.starts_with("* ")
                || trimmed.starts_with("• ")
                || trimmed.starts_with("· ")
        })
        .count()
}

fn record_observation(
    conn: &Connection,
    project_id: Option<&str>,
    source_kind: &str,
    pattern_key: &str,
    category: &str,
    summary: &str,
    detail: Value,
) -> Result<()> {
    if !table_exists(conn, "habit_observations")? {
        return Ok(());
    }
    conn.execute(
        "INSERT INTO habit_observations(id,project_id,source_kind,pattern_key,category,summary,detail_json,created_at)
         VALUES(?,?,?,?,?,?,?,?)",
        params![
            id(),
            project_id,
            source_kind,
            clip(pattern_key, 120),
            category,
            clip(summary, 300),
            detail.to_string(),
            now(),
        ],
    )?;
    // Keep observation log bounded so SQLite stays compact.
    conn.execute(
        "DELETE FROM habit_observations WHERE id IN (
            SELECT id FROM habit_observations ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?1
        )",
        [MAX_OBSERVATIONS_KEPT],
    )?;
    Ok(())
}

/// PRELUDE-inspired deterministic report-edit diff observer.
/// Compares previous draft vs user-edited saved report and records structural/style deltas.
pub(crate) fn observe_report_edit(
    conn: &Connection,
    project_id: Option<&str>,
    report_kind: &str,
    previous_content: &str,
    new_content: &str,
) -> Result<()> {
    if !table_exists(conn, "habit_observations")? {
        return Ok(());
    }
    let old = previous_content.trim();
    let new = new_content.trim();
    if old.is_empty() || new.is_empty() || old == new {
        return Ok(());
    }
    let mut observed = false;

    // 1. User removed fine-grained percentage numbers from report
    if has_percentage(old) && !has_percentage(new) {
        record_observation(
            conn,
            project_id,
            "report_edit",
            "writing:drop_percentages",
            "writing",
            &format!("编辑{report_kind}时删除了任务完成百分比，更聚焦状态与结论"),
            json!({
                "reportKind": report_kind,
                "title": "汇报默认省略细粒度完成百分比",
                "instruction": "撰写或润色日报/周报时，优先用状态与关键交付结论表达进展，避免罗列琐碎百分比数值。",
                "rule": {"action": "report_style", "omitPercentages": true}
            }),
        )?;
        observed = true;
    }

    // 2. User moved risks/blockers/decisions ahead of progress/completed items
    let risk_markers = ["风险", "阻塞", "卡点", "待拍板", "待决策"];
    let progress_markers = ["进展", "完成", "推进中", "本期完成", "今日完成"];
    let old_risk_first = match (
        first_marker_pos(old, &risk_markers),
        first_marker_pos(old, &progress_markers),
    ) {
        (Some(r), Some(p)) => r < p,
        _ => false,
    };
    let new_risk_first = match (
        first_marker_pos(new, &risk_markers),
        first_marker_pos(new, &progress_markers),
    ) {
        (Some(r), Some(p)) => r < p,
        _ => false,
    };
    if !old_risk_first && new_risk_first {
        record_observation(
            conn,
            project_id,
            "report_edit",
            "writing:risks_first",
            "writing",
            &format!("编辑{report_kind}时将风险/阻塞/待拍板段落前置到了进展前面"),
            json!({
                "reportKind": report_kind,
                "title": "汇报结构优先前置风险与待拍板",
                "instruction": "撰写或润色日报/周报时，将「需关注风险、阻塞与待拍板事项」放在最前面，结论先行。",
                "rule": {"action": "report_style", "risksFirst": true}
            }),
        )?;
        observed = true;
    }

    // 3. User substantially condensed report length (>= 35% shorter)
    let old_chars = old.chars().count();
    let new_chars = new.chars().count();
    if old_chars >= 180 && new_chars * 100 <= old_chars * 65 {
        record_observation(
            conn,
            project_id,
            "report_edit",
            "writing:concise_length",
            "writing",
            &format!("编辑{report_kind}时将篇幅从 {old_chars} 字压缩至 {new_chars} 字"),
            json!({
                "reportKind": report_kind,
                "title": "汇报偏好高度精炼、压缩过程细节",
                "instruction": "撰写或润色日报/周报时保持高度精炼，删去过程性流水账，每项控制在 1~2 句以内。",
                "rule": {"action": "report_style", "concise": true}
            }),
        )?;
        observed = true;
    }

    // 4. User softened "风险/阻塞" wording into diplomatic wording ("需协调/待确认/需关注")
    let had_hard = old.contains("风险") || old.contains("阻塞");
    let has_hard = new.contains("风险") || new.contains("阻塞");
    let has_soft = new.contains("需协调") || new.contains("待确认") || new.contains("需关注");
    if had_hard && !has_hard && has_soft {
        record_observation(
            conn,
            project_id,
            "report_edit",
            "writing:soften_risk_wording",
            "writing",
            &format!("编辑{report_kind}时将「风险/阻塞」改写为「需协调/待确认/需关注」"),
            json!({
                "reportKind": report_kind,
                "title": "汇报措辞偏克制（用「需协调/待确认」替代生硬「风险/阻塞」）",
                "instruction": "撰写或润色汇报时保持措辞克制专业，在客观保留事实的前提下，优先使用「需协调事项 / 待确认事项」而非生硬的「风险 / 阻塞」。",
                "rule": {"action": "report_style", "softenRiskWording": true}
            }),
        )?;
        observed = true;
    }

    // 5. User converted prose into bullet list
    let old_bullets = bullet_line_count(old);
    let new_bullets = bullet_line_count(new);
    if new_bullets >= 3 && new_bullets >= old_bullets + 2 {
        record_observation(
            conn,
            project_id,
            "report_edit",
            "writing:bullet_style",
            "writing",
            &format!("编辑{report_kind}时将正文改写为条列要点（{old_bullets} → {new_bullets} 条）"),
            json!({
                "reportKind": report_kind,
                "title": "汇报正文偏好条列要点格式",
                "instruction": "撰写或润色汇报时统一使用简洁的 Markdown 无序列表要点，避免大段连续文字。",
                "rule": {"action": "report_style", "preferBullets": true}
            }),
        )?;
        observed = true;
    }

    if observed {
        let _ = synthesize_proposals(conn);
    }
    Ok(())
}

/// Observes user dismissals and snooze cadences on proactive alerts & assistant work proposals.
pub(crate) fn observe_proactive_feedback(
    conn: &Connection,
    project_id: Option<&str>,
    target_kind: &str,
    operation: &str,
    snooze_days: Option<i64>,
) -> Result<()> {
    if !table_exists(conn, "habit_observations")? {
        return Ok(());
    }
    let kind_label = match target_kind {
        "task" | "delay" => "任务延期/阻塞提醒",
        "follow_up" => "任务跟进催办提醒",
        "milestone" => "里程碑偏差提醒",
        "governance" => "风险与待决策提醒",
        "memory_review" | "memory_conflict" => "记忆冲突复核提醒",
        other => other,
    };
    let mut observed = false;
    if operation == "dismiss" {
        let key = format!("reminder:deprioritize:{target_kind}");
        record_observation(
            conn,
            project_id,
            "proactive_feedback",
            &key,
            "reminder",
            &format!("忽略了一次「{kind_label}」"),
            json!({
                "targetKind": target_kind,
                "title": format!("降低「{kind_label}」的主动提醒优先级"),
                "instruction": format!("对「{kind_label}」降低主动打扰优先级，仅在临近硬截止或高严重度时置顶提示。"),
                "rule": {"action": "deprioritize_proactive", "targetKind": target_kind, "priorityDelta": -20}
            }),
        )?;
        observed = true;
    } else if operation == "snooze" {
        if let Some(days) = snooze_days.filter(|d| (1..=30).contains(d)) {
            let bucket = if days <= 1 {
                1
            } else if days <= 3 {
                3
            } else if days <= 7 {
                7
            } else {
                14
            };
            let key = format!("reminder:snooze_days:{bucket}");
            record_observation(
                conn,
                project_id,
                "proactive_feedback",
                &key,
                "reminder",
                &format!("将「{kind_label}」暂缓了 {days} 天"),
                json!({
                    "targetKind": target_kind,
                    "days": days,
                    "bucket": bucket,
                    "title": format!("提醒暂缓偏好约 {bucket} 天复查"),
                    "instruction": format!("安排提醒复查或跟进缓冲期时，优先按 {bucket} 天作为默认复查间隔建议。"),
                    "rule": {"action": "default_snooze_days", "days": bucket}
                }),
            )?;
            observed = true;
        }
    }
    if observed {
        let _ = synthesize_proposals(conn);
    }
    Ok(())
}

/// Observes repeated rejections or retention-layer downgrades on AI extraction proposals.
pub(crate) fn observe_proposal_feedback(
    conn: &Connection,
    project_id: Option<&str>,
    proposal_kind: &str,
    action: &str,
    retention_layer: Option<&str>,
) -> Result<()> {
    if !table_exists(conn, "habit_observations")? {
        return Ok(());
    }
    let kind_label = match proposal_kind {
        "fact" => "事实类候选",
        "decision" => "决策类候选",
        "requirement" => "需求类候选",
        "risk" => "风险类候选",
        other => other,
    };
    let mut observed = false;
    if action == "reject" || action == "ignore" {
        let key = format!("filtering:strict_reject:{proposal_kind}");
        record_observation(
            conn,
            project_id,
            "proposal_edit",
            &key,
            "filtering",
            &format!("拒绝/忽略了一条 AI 提取的「{kind_label}」"),
            json!({
                "proposalKind": proposal_kind,
                "title": format!("更严格过滤低价值「{kind_label}」"),
                "instruction": format!("整理与提取「{kind_label}」时提高门槛，跳过寒暄、过渡性过程描述与非核心细节。"),
                "rule": {"action": "extraction_filter", "kind": proposal_kind, "strict": true}
            }),
        )?;
        observed = true;
    } else if action == "downgrade_working" || retention_layer == Some("working") {
        let key = format!("filtering:prefer_working:{proposal_kind}");
        record_observation(
            conn,
            project_id,
            "proposal_edit",
            &key,
            "filtering",
            &format!("将「{kind_label}」调整为短期工作状态（working）复核"),
            json!({
                "proposalKind": proposal_kind,
                "title": format!("「{kind_label}」倾向先归入短期复核（working）"),
                "instruction": format!("对「{kind_label}」中的阶段性状态优先标记为 working（短期复核），待稳定后再沉淀为长期记忆。"),
                "rule": {"action": "prefer_working_layer", "kind": proposal_kind}
            }),
        )?;
        observed = true;
    }
    if observed {
        let _ = synthesize_proposals(conn);
    }
    Ok(())
}

/// Synthesizes pending `habit_proposals` from repeated consistent `habit_observations`
/// (>= PROPOSAL_THRESHOLD within OBSERVATION_WINDOW_DAYS). Safe to run idempotently in idle time.
pub(crate) fn synthesize_proposals(conn: &Connection) -> Result<usize> {
    if !table_exists(conn, "habit_observations")? || !table_exists(conn, "habit_proposals")? {
        return Ok(0);
    }
    let cutoff = (chrono::Utc::now() - chrono::Duration::days(OBSERVATION_WINDOW_DAYS))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let mut stmt = conn.prepare(
        "SELECT id,project_id,pattern_key,category,detail_json,created_at
         FROM habit_observations
         WHERE created_at>=?1
         ORDER BY created_at DESC, rowid DESC",
    )?;
    let rows = stmt
        .query_map([&cutoff], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    drop(stmt);

    // Group by (project_scope_or_global, pattern_key). If a pattern occurs across multiple
    // projects, promote it under global scope (None) as well.
    type ObservationSamples = Vec<(String, String, Value)>;
    let mut grouped: HashMap<(Option<String>, String), ObservationSamples> = HashMap::new();
    let mut by_pattern_global: HashMap<String, ObservationSamples> = HashMap::new();
    for (obs_id, project_id, pattern_key, category, detail_raw, _at) in rows {
        let detail: Value = serde_json::from_str(&detail_raw).unwrap_or_else(|_| json!({}));
        grouped
            .entry((project_id.clone(), pattern_key.clone()))
            .or_default()
            .push((obs_id.clone(), category.clone(), detail.clone()));
        by_pattern_global
            .entry(pattern_key)
            .or_default()
            .push((obs_id, category, detail));
    }
    for (pattern_key, list) in by_pattern_global {
        if list.len() as i64 >= PROPOSAL_THRESHOLD {
            grouped.entry((None, pattern_key)).or_insert(list);
        }
    }

    let mut created_or_updated = 0usize;
    let at = now();
    for ((project_id, pattern_key), samples) in grouped {
        let count = samples.len() as i64;
        if count < PROPOSAL_THRESHOLD {
            continue;
        }
        // Skip if already confirmed active or explicitly rejected for same scope & pattern
        let already_decided: bool = conn.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM user_habits
                WHERE coalesce(project_id,'')=coalesce(?1,'')
                  AND pattern_key=?2
                  AND status IN ('active','paused')
             ) OR EXISTS(
                SELECT 1 FROM habit_proposals
                WHERE coalesce(project_id,'')=coalesce(?1,'')
                  AND pattern_key=?2
                  AND status='rejected'
             )",
            params![project_id, pattern_key],
            |r| r.get(0),
        )?;
        if already_decided {
            continue;
        }
        let (_, category, latest_detail) = &samples[0];
        let title = latest_detail["title"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(&pattern_key);
        let instruction = latest_detail["instruction"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(title);
        let rule = latest_detail
            .get("rule")
            .cloned()
            .unwrap_or_else(|| json!({}));
        let sample_ids: Vec<&str> = samples
            .iter()
            .take(10)
            .map(|(id, _, _)| id.as_str())
            .collect();
        let confidence = (0.55 + 0.08 * (count as f64)).min(0.95);

        let existing_pending: Option<String> = conn
            .query_row(
                "SELECT id FROM habit_proposals
                 WHERE coalesce(project_id,'')=coalesce(?1,'')
                   AND pattern_key=?2
                   AND status='pending'
                 LIMIT 1",
                params![project_id, pattern_key],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(prop_id) = existing_pending {
            conn.execute(
                "UPDATE habit_proposals
                 SET evidence_count=?1, confidence=?2, sample_ids_json=?3, updated_at=?4
                 WHERE id=?5",
                params![
                    count,
                    confidence,
                    json!(sample_ids).to_string(),
                    at,
                    prop_id
                ],
            )?;
        } else {
            conn.execute(
                "INSERT INTO habit_proposals(
                    id,project_id,pattern_key,category,title,instruction,rule_json,
                    evidence_count,confidence,sample_ids_json,status,created_at,updated_at
                 ) VALUES(?,?,?,?,?,?,?,?,?,?,'pending',?,?)",
                params![
                    id(),
                    project_id,
                    clip(&pattern_key, 120),
                    category,
                    clip(title, 160),
                    clip(instruction, 600),
                    rule.to_string(),
                    count,
                    confidence,
                    json!(sample_ids).to_string(),
                    at,
                    at,
                ],
            )?;
            created_or_updated += 1;
        }
    }
    Ok(created_or_updated)
}

fn read_habit_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let applied = row.get::<_, i64>(9)?;
    let accepted = row.get::<_, i64>(10)?;
    let overridden = row.get::<_, i64>(11)?;
    let utility = (accepted as f64 + 1.0) / ((accepted + overridden) as f64 + 2.0);
    let low_utility =
        (accepted + overridden) >= 5 && (overridden as f64 / (accepted + overridden) as f64) >= 0.7;
    let rule: Value = serde_json::from_str(&row.get::<_, String>(6)?).unwrap_or_else(|_| json!({}));
    Ok(json!({
        "id": row.get::<_, String>(0)?,
        "projectId": row.get::<_, Option<String>>(1)?,
        "patternKey": row.get::<_, String>(2)?,
        "category": row.get::<_, String>(3)?,
        "title": row.get::<_, String>(4)?,
        "instruction": row.get::<_, String>(5)?,
        "rule": rule,
        "status": row.get::<_, String>(7)?,
        "confidence": row.get::<_, f64>(8)?,
        "appliedCount": applied,
        "acceptedCount": accepted,
        "overriddenCount": overridden,
        "utilityScore": (utility * 100.0).round() / 100.0,
        "lowUtilityWarning": low_utility,
        "version": row.get::<_, i64>(12)?,
        "lastAppliedAt": row.get::<_, Option<String>>(13)?,
        "createdAt": row.get::<_, String>(14)?,
        "updatedAt": row.get::<_, String>(15)?,
    }))
}

fn read_proposal_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let rule: Value = serde_json::from_str(&row.get::<_, String>(6)?).unwrap_or_else(|_| json!({}));
    let sample_ids: Value =
        serde_json::from_str(&row.get::<_, String>(9)?).unwrap_or_else(|_| json!([]));
    Ok(json!({
        "id": row.get::<_, String>(0)?,
        "projectId": row.get::<_, Option<String>>(1)?,
        "patternKey": row.get::<_, String>(2)?,
        "category": row.get::<_, String>(3)?,
        "title": row.get::<_, String>(4)?,
        "instruction": row.get::<_, String>(5)?,
        "rule": rule,
        "evidenceCount": row.get::<_, i64>(7)?,
        "confidence": row.get::<_, f64>(8)?,
        "sampleIds": sample_ids,
        "status": row.get::<_, String>(10)?,
        "createdAt": row.get::<_, String>(11)?,
        "updatedAt": row.get::<_, String>(12)?,
    }))
}

pub(crate) fn center(conn: &Connection, p: &Value) -> Result<Value> {
    if !table_exists(conn, "user_habits")? {
        return Ok(json!({
            "proposals": [],
            "habits": [],
            "recentObservations": [],
            "counts": {"pendingProposals": 0, "activeHabits": 0, "lowUtilityHabits": 0}
        }));
    }
    let scope = scope_project(conn, p)?;
    let _ = synthesize_proposals(conn);
    let mut prop_stmt = conn.prepare(
        "SELECT id,project_id,pattern_key,category,title,instruction,rule_json,
                evidence_count,confidence,sample_ids_json,status,created_at,updated_at
         FROM habit_proposals
         WHERE status='pending'
           AND (?1 IS NULL OR project_id IS NULL OR project_id=?1)
         ORDER BY confidence DESC, evidence_count DESC, updated_at DESC
         LIMIT 50",
    )?;
    let mut proposals = prop_stmt
        .query_map([scope.as_deref()], read_proposal_row)?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    for prop in &mut proposals {
        let ids: Vec<String> = prop["sampleIds"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| v.as_str().map(str::to_owned))
            .take(5)
            .collect();
        let mut samples = Vec::new();
        for sid in ids {
            if let Some(sample) = conn
                .query_row(
                    "SELECT json_object('id',id,'sourceKind',source_kind,'summary',summary,'createdAt',created_at)
                     FROM habit_observations WHERE id=?",
                    [sid],
                    |r| r.get::<_, String>(0),
                )
                .optional()?
                .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            {
                samples.push(sample);
            }
        }
        prop["samples"] = json!(samples);
    }

    let mut habit_stmt = conn.prepare(
        "SELECT id,project_id,pattern_key,category,title,instruction,rule_json,status,
                confidence,applied_count,accepted_count,overridden_count,version,
                last_applied_at,created_at,updated_at
         FROM user_habits
         WHERE status<>'archived'
           AND (?1 IS NULL OR project_id IS NULL OR project_id=?1)
         ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, updated_at DESC, id
         LIMIT 100",
    )?;
    let habits = habit_stmt
        .query_map([scope.as_deref()], read_habit_row)?
        .collect::<std::result::Result<Vec<_>, _>>()?;

    let mut obs_stmt = conn.prepare(
        "SELECT json_object('id',id,'projectId',project_id,'sourceKind',source_kind,'patternKey',pattern_key,'category',category,'summary',summary,'createdAt',created_at)
         FROM habit_observations
         WHERE (?1 IS NULL OR project_id IS NULL OR project_id=?1)
         ORDER BY created_at DESC, rowid DESC
         LIMIT 30",
    )?;
    let recent_observations = obs_stmt
        .query_map([scope.as_deref()], |r| r.get::<_, String>(0))?
        .filter_map(|r| r.ok())
        .filter_map(|raw| serde_json::from_str::<Value>(&raw).ok())
        .collect::<Vec<_>>();

    let active_count = habits.iter().filter(|h| h["status"] == "active").count();
    let low_utility_count = habits
        .iter()
        .filter(|h| h["status"] == "active" && h["lowUtilityWarning"] == true)
        .count();
    Ok(json!({
        "proposals": proposals,
        "habits": habits,
        "recentObservations": recent_observations,
        "counts": {
            "pendingProposals": proposals.len(),
            "activeHabits": active_count,
            "lowUtilityHabits": low_utility_count,
        }
    }))
}

struct HabitSpec<'a> {
    project_id: Option<&'a str>,
    pattern_key: &'a str,
    category: &'a str,
    title: &'a str,
    instruction: &'a str,
    rule: &'a Value,
    confidence: f64,
}

fn upsert_active_habit(conn: &Connection, spec: HabitSpec<'_>) -> Result<Value> {
    let at = now();
    let existing: Option<(String, i64)> = conn
        .query_row(
            "SELECT id, version FROM user_habits
             WHERE coalesce(project_id,'')=coalesce(?1,'')
               AND pattern_key=?2
               AND status<>'archived'
             LIMIT 1",
            params![spec.project_id, spec.pattern_key],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let habit_id = if let Some((existing_id, _)) = existing {
        conn.execute(
            "UPDATE user_habits
             SET category=?1, title=?2, instruction=?3, rule_json=?4, status='active',
                 confidence=max(confidence,?5), version=version+1, updated_at=?6
             WHERE id=?7",
            params![
                spec.category,
                clip(spec.title, 160),
                clip(spec.instruction, 600),
                spec.rule.to_string(),
                spec.confidence.clamp(0.1, 1.0),
                at,
                existing_id,
            ],
        )?;
        existing_id
    } else {
        let new_id = id();
        conn.execute(
            "INSERT INTO user_habits(
                id,project_id,pattern_key,category,title,instruction,rule_json,status,
                confidence,applied_count,accepted_count,overridden_count,version,last_applied_at,created_at,updated_at
             ) VALUES(?,?,?,?,?,?,?,'active',?,0,1,0,1,NULL,?,?)",
            params![
                new_id,
                spec.project_id,
                clip(spec.pattern_key, 120),
                spec.category,
                clip(spec.title, 160),
                clip(spec.instruction, 600),
                spec.rule.to_string(),
                spec.confidence.clamp(0.1, 1.0),
                at,
                at,
            ],
        )?;
        new_id
    };
    conn.query_row(
        "SELECT id,project_id,pattern_key,category,title,instruction,rule_json,status,
                confidence,applied_count,accepted_count,overridden_count,version,
                last_applied_at,created_at,updated_at
         FROM user_habits WHERE id=?",
        [&habit_id],
        read_habit_row,
    )
    .map_err(Into::into)
}

fn resolve_proposal(conn: &Connection, p: &Value) -> Result<Value> {
    let proposal_id = required(p, "proposalId")?.trim();
    let action = required(p, "action")?.trim();
    if !matches!(action, "confirm" | "reject") {
        return Err(invalid("操作仅支持 confirm 或 reject"));
    }
    let prop = conn
        .query_row(
            "SELECT id,project_id,pattern_key,category,title,instruction,rule_json,
                    evidence_count,confidence,sample_ids_json,status,created_at,updated_at
             FROM habit_proposals WHERE id=?",
            [proposal_id],
            read_proposal_row,
        )
        .optional()?
        .ok_or_else(|| AppError::new("NOT_FOUND", "习惯建议不存在"))?;
    if prop["status"] != "pending" {
        return Err(AppError::new("CONFLICT", "该习惯建议已处理，请刷新"));
    }
    let at = now();
    if action == "reject" {
        conn.execute(
            "UPDATE habit_proposals SET status='rejected', updated_at=? WHERE id=?",
            params![at, proposal_id],
        )?;
        return Ok(json!({"resolved": true, "status": "rejected"}));
    }
    let title = p["title"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| prop["title"].as_str().unwrap_or(""));
    let instruction = p["instruction"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| prop["instruction"].as_str().unwrap_or(""));
    let project_id = if p.get("projectId").is_some() {
        scope_project(conn, p)?
    } else {
        prop["projectId"].as_str().map(str::to_owned)
    };
    let habit = upsert_active_habit(
        conn,
        HabitSpec {
            project_id: project_id.as_deref(),
            pattern_key: prop["patternKey"].as_str().unwrap_or("custom"),
            category: prop["category"].as_str().unwrap_or("workflow"),
            title,
            instruction,
            rule: &prop["rule"],
            confidence: prop["confidence"].as_f64().unwrap_or(0.8),
        },
    )?;
    conn.execute(
        "UPDATE habit_proposals SET status='confirmed', updated_at=? WHERE id=?",
        params![at, proposal_id],
    )?;
    Ok(json!({"resolved": true, "status": "confirmed", "habit": habit}))
}

fn save_habit(conn: &Connection, p: &Value) -> Result<Value> {
    let project = scope_project(conn, p)?;
    let category = p["category"].as_str().unwrap_or("workflow").trim();
    if !valid_category(category) {
        return Err(invalid(
            "习惯类别无效，仅支持 writing / reminder / workflow / filtering",
        ));
    }
    let title = required(p, "title")?.trim();
    let instruction = required(p, "instruction")?.trim();
    if title.chars().count() > 160 || instruction.chars().count() > 600 {
        return Err(invalid("标题最多 160 字，规则说明最多 600 字"));
    }
    let rule = p
        .get("rule")
        .filter(|v| v.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}));
    let existing_id = p["id"].as_str().map(str::trim).filter(|s| !s.is_empty());
    let at = now();
    let habit_id = if let Some(hid) = existing_id {
        let base = p["baseVersion"]
            .as_i64()
            .filter(|v| *v >= 1)
            .ok_or_else(|| invalid("缺少习惯版本号"))?;
        let changed = conn.execute(
            "UPDATE user_habits
             SET project_id=?1, category=?2, title=?3, instruction=?4, rule_json=?5,
                 version=version+1, updated_at=?6
             WHERE id=?7 AND version=?8",
            params![
                project,
                category,
                title,
                instruction,
                rule.to_string(),
                at,
                hid,
                base
            ],
        )?;
        if changed == 0 {
            return Err(AppError::new(
                "REVISION_CONFLICT",
                "习惯已更新，请刷新后重试",
            ));
        }
        hid.to_owned()
    } else {
        let pattern_key = p["patternKey"]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| format!("manual:{category}:{}", &id()[..8]));
        return upsert_active_habit(
            conn,
            HabitSpec {
                project_id: project.as_deref(),
                pattern_key: &pattern_key,
                category,
                title,
                instruction,
                rule: &rule,
                confidence: 0.9,
            },
        );
    };
    conn.query_row(
        "SELECT id,project_id,pattern_key,category,title,instruction,rule_json,status,
                confidence,applied_count,accepted_count,overridden_count,version,
                last_applied_at,created_at,updated_at
         FROM user_habits WHERE id=?",
        [&habit_id],
        read_habit_row,
    )
    .map_err(Into::into)
}

fn update_status(conn: &Connection, p: &Value) -> Result<Value> {
    let hid = required(p, "id")?.trim();
    let status = required(p, "status")?.trim();
    if !matches!(status, "active" | "paused" | "archived") {
        return Err(invalid("习惯状态仅支持 active / paused / archived"));
    }
    let base = p["baseVersion"]
        .as_i64()
        .filter(|v| *v >= 1)
        .ok_or_else(|| invalid("缺少习惯版本号"))?;
    let changed = conn.execute(
        "UPDATE user_habits SET status=?1, version=version+1, updated_at=?2 WHERE id=?3 AND version=?4",
        params![status, now(), hid, base],
    )?;
    if changed == 0 {
        return Err(AppError::new(
            "REVISION_CONFLICT",
            "习惯状态已变化，请刷新后重试",
        ));
    }
    conn.query_row(
        "SELECT id,project_id,pattern_key,category,title,instruction,rule_json,status,
                confidence,applied_count,accepted_count,overridden_count,version,
                last_applied_at,created_at,updated_at
         FROM user_habits WHERE id=?",
        [hid],
        read_habit_row,
    )
    .map_err(Into::into)
}

fn delete_habit(conn: &Connection, p: &Value) -> Result<Value> {
    let hid = required(p, "id")?.trim();
    let changed = conn.execute("DELETE FROM user_habits WHERE id=?", [hid])?;
    if changed == 0 {
        return Err(AppError::new("NOT_FOUND", "习惯不存在"));
    }
    Ok(json!({"deleted": true, "id": hid}))
}

/// PAHF dual-channel feedback entry for Copilot write-tool approval cards.
/// Records parameter adjustments or cancellations as observations, updates ReMe utility counters
/// for applied habits, and immediately activates a confirmed habit when `rememberAsHabit = true`.
fn record_copilot_feedback(conn: &Connection, p: &Value) -> Result<Value> {
    let project = scope_project(conn, p)?;
    let tool = required(p, "toolName")?.trim();
    let decision = required(p, "decision")?.trim();
    if !matches!(decision, "approved" | "edited_and_approved" | "rejected") {
        return Err(invalid(
            "反馈决定仅支持 approved / edited_and_approved / rejected",
        ));
    }
    let remember = p["rememberAsHabit"].as_bool().unwrap_or(false);
    let original = p.get("originalArgs").cloned().unwrap_or_else(|| json!({}));
    let final_args = p
        .get("finalArgs")
        .cloned()
        .unwrap_or_else(|| original.clone());

    let mut created_habits = Vec::new();
    let mut diffs: Vec<(String, String, String, Value)> = Vec::new();
    if decision == "edited_and_approved" {
        if let (Some(old_obj), Some(new_obj)) = (original.as_object(), final_args.as_object()) {
            for field in ["priority", "severity", "assignee"] {
                let old_val = old_obj
                    .get(field)
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim();
                let new_val = new_obj
                    .get(field)
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim();
                if !new_val.is_empty() && new_val != old_val {
                    let (title, instruction) = match (tool, field) {
                        ("create_task" | "update_task", "priority") => {
                            let label = match new_val {
                                "high" => "高",
                                "low" => "低",
                                _ => "中",
                            };
                            (
                                format!("副驾驶建/改任务默认优先级偏「{label}」"),
                                format!("通过副驾驶新建或调整任务且用户未指定优先级时，优先设为「{label}」({new_val})。"),
                            )
                        }
                        ("create_risk_or_decision", "severity") => {
                            let label = match new_val {
                                "high" => "高",
                                "low" => "低",
                                _ => "中",
                            };
                            (
                                format!("记录项目风险默认严重度偏「{label}」"),
                                format!("记录项目风险且用户未指定严重度时，优先建议「{label}」({new_val})。"),
                            )
                        }
                        ("create_task" | "update_task", "assignee") => (
                            format!("常见任务默认负责人倾向「{new_val}」"),
                            format!("涉及此类任务分配时优先参考常用负责人「{new_val}」，确认卡中交由用户核对。"),
                        ),
                        _ => (
                            format!("副驾驶参数 {field} 偏好「{new_val}」"),
                            format!("调用 {tool} 时参数 {field} 优先使用「{new_val}」。"),
                        ),
                    };
                    let pattern_key = format!("workflow:copilot:{tool}:{field}:{new_val}");
                    let rule = json!({"action": "copilot_default", "tool": tool, "field": field, "value": new_val});
                    diffs.push((pattern_key, title, instruction, rule));
                }
            }
        }
    } else if decision == "rejected" {
        let pattern_key = format!("workflow:copilot:cautious:{tool}");
        let title = format!("调用「{tool}」前需更谨慎确认");
        let instruction = format!("在准备触发写入工具 {tool} 前，先用一句话向用户确认意图与关键参数，避免过早弹出写入确认卡。");
        let rule = json!({"action": "copilot_confirm_before_tool", "tool": tool});
        diffs.push((pattern_key, title, instruction, rule));
    }

    for (pattern_key, title, instruction, rule) in &diffs {
        record_observation(
            conn,
            project.as_deref(),
            "copilot_approval",
            pattern_key,
            "workflow",
            title,
            json!({
                "tool": tool,
                "decision": decision,
                "title": title,
                "instruction": instruction,
                "rule": rule,
            }),
        )?;
        if remember {
            let habit = upsert_active_habit(
                conn,
                HabitSpec {
                    project_id: project.as_deref(),
                    pattern_key,
                    category: "workflow",
                    title,
                    instruction,
                    rule,
                    confidence: 0.9,
                },
            )?;
            created_habits.push(habit);
        }
    }

    // ReMe utility feedback for habits currently active in the Copilot session
    if let Some(ids) = p["appliedHabitIds"].as_array() {
        let habit_ids: Vec<String> = ids
            .iter()
            .filter_map(|v| v.as_str().map(str::to_owned))
            .collect();
        if !habit_ids.is_empty() {
            let outcome = if decision == "approved" {
                "accepted"
            } else {
                "overridden"
            };
            let _ = apply_outcome(conn, &habit_ids, outcome);
        }
    }

    let _ = synthesize_proposals(conn);
    Ok(json!({
        "recorded": true,
        "observationsAdded": diffs.len(),
        "savedHabits": created_habits,
    }))
}

fn apply_outcome(conn: &Connection, habit_ids: &[String], outcome: &str) -> Result<usize> {
    if !matches!(outcome, "accepted" | "overridden") || habit_ids.is_empty() {
        return Ok(0);
    }
    let at = now();
    let mut updated = 0usize;
    let unique: HashSet<&String> = habit_ids.iter().collect();
    for hid in unique {
        let sql = if outcome == "accepted" {
            "UPDATE user_habits
             SET applied_count=applied_count+1,
                 accepted_count=accepted_count+1,
                 confidence=min(0.98, confidence+0.02),
                 last_applied_at=?1,
                 updated_at=?1
             WHERE id=?2 AND status='active'"
        } else {
            "UPDATE user_habits
             SET applied_count=applied_count+1,
                 overridden_count=overridden_count+1,
                 confidence=max(0.20, confidence-0.06),
                 last_applied_at=?1,
                 updated_at=?1
             WHERE id=?2 AND status='active'"
        };
        updated += conn.execute(sql, params![at, hid])?;
    }
    Ok(updated)
}

fn record_outcome(conn: &Connection, p: &Value) -> Result<Value> {
    let outcome = required(p, "outcome")?.trim();
    if !matches!(outcome, "accepted" | "overridden") {
        return Err(invalid("效用反馈仅支持 accepted 或 overridden"));
    }
    let ids: Vec<String> = p["habitIds"]
        .as_array()
        .ok_or_else(|| invalid("habitIds 必须为数组"))?
        .iter()
        .filter_map(|v| v.as_str().map(str::to_owned))
        .collect();
    let updated = apply_outcome(conn, &ids, outcome)?;
    Ok(json!({"updated": updated}))
}

/// CIPHER-inspired context-aware selection of active user habits ranked by scope match,
/// lexical relevance, and ReMe utility score.
pub(crate) fn select_for_context(
    conn: &Connection,
    scope: Option<&str>,
    categories: &[&str],
    context_text: &str,
    limit: usize,
) -> Result<Vec<Value>> {
    if !table_exists(conn, "user_habits")? || limit == 0 {
        return Ok(Vec::new());
    }
    let mut stmt = conn.prepare(
        "SELECT id,project_id,pattern_key,category,title,instruction,rule_json,status,
                confidence,applied_count,accepted_count,overridden_count,version,
                last_applied_at,created_at,updated_at
         FROM user_habits
         WHERE status='active'
           AND (?1 IS NULL OR project_id IS NULL OR project_id=?1)
         ORDER BY updated_at DESC, id
         LIMIT 100",
    )?;
    let all = stmt
        .query_map([scope], read_habit_row)?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let query = crate::search::Query::new(context_text);
    let mut scored: Vec<(f64, Value)> = all
        .into_iter()
        .filter(|h| {
            categories.is_empty()
                || categories
                    .iter()
                    .any(|c| h["category"].as_str() == Some(*c))
        })
        .map(|h| {
            let scope_bonus = if scope.is_some() && h["projectId"].as_str() == scope {
                0.25
            } else {
                0.0
            };
            let utility = h["utilityScore"].as_f64().unwrap_or(0.5);
            let conf = h["confidence"].as_f64().unwrap_or(0.7);
            let rel = if !context_text.trim().is_empty() {
                let text = format!(
                    "{} {}",
                    h["title"].as_str().unwrap_or(""),
                    h["instruction"].as_str().unwrap_or("")
                );
                if query.score(&text, "") > 0 {
                    0.2
                } else {
                    0.0
                }
            } else {
                0.0
            };
            let penalty = if h["lowUtilityWarning"] == true {
                -0.4
            } else {
                0.0
            };
            (conf * utility + scope_bonus + rel + penalty, h)
        })
        .collect();
    scored.sort_by(|a, b| b.0.total_cmp(&a.0));
    Ok(scored.into_iter().take(limit).map(|(_, h)| h).collect())
}

/// Returns active priority adjustments (`target_kind -> delta`) learned from confirmed reminder habits.
pub(crate) fn proactive_priority_adjustments(
    conn: &Connection,
    project_id: Option<&str>,
) -> Result<HashMap<String, i64>> {
    let mut adjustments = HashMap::new();
    for habit in select_for_context(conn, project_id, &["reminder"], "", 20)? {
        if habit["rule"]["action"] == "deprioritize_proactive" {
            if let Some(kind) = habit["rule"]["targetKind"].as_str() {
                let delta = habit["rule"]["priorityDelta"]
                    .as_i64()
                    .unwrap_or(-20)
                    .clamp(-40, 0);
                adjustments
                    .entry(kind.to_owned())
                    .and_modify(|v: &mut i64| *v = (*v).min(delta))
                    .or_insert(delta);
            }
        }
    }
    Ok(adjustments)
}

pub(crate) fn dispatch(conn: &Connection, command: &str, p: &Value) -> Result<Value> {
    match command {
        "get_habits_center" => center(conn, p),
        "resolve_habit_proposal" => resolve_proposal(conn, p),
        "save_user_habit" => save_habit(conn, p),
        "update_habit_status" => update_status(conn, p),
        "delete_user_habit" => delete_habit(conn, p),
        "record_copilot_feedback" => record_copilot_feedback(conn, p),
        "record_habit_outcome" => record_outcome(conn, p),
        _ => Err(invalid("不支持的习惯学习操作")),
    }
}

pub(crate) fn validate_backup(conn: &Connection) -> Result<()> {
    for table in ["habit_observations", "habit_proposals", "user_habits"] {
        if !table_exists(conn, table)? {
            return Err(AppError::new("INVALID_BACKUP", "备份缺少习惯学习数据表"));
        }
    }
    let invalid_obs: i64 = conn.query_row(
        "SELECT count(*) FROM habit_observations
         WHERE source_kind NOT IN ('report_edit','copilot_approval','proactive_feedback','proposal_edit','memory_correction','explicit_feedback')
            OR category NOT IN ('writing','reminder','workflow','filtering')
            OR (project_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM projects p WHERE p.id=habit_observations.project_id))",
        [],
        |r| r.get(0),
    )?;
    let invalid_props: i64 = conn.query_row(
        "SELECT count(*) FROM habit_proposals
         WHERE category NOT IN ('writing','reminder','workflow','filtering')
            OR status NOT IN ('pending','confirmed','rejected')
            OR evidence_count < 1
            OR confidence < 0.0 OR confidence > 1.0
            OR (project_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM projects p WHERE p.id=habit_proposals.project_id))",
        [],
        |r| r.get(0),
    )?;
    let invalid_habits: i64 = conn.query_row(
        "SELECT count(*) FROM user_habits
         WHERE category NOT IN ('writing','reminder','workflow','filtering')
            OR status NOT IN ('active','paused','archived')
            OR version < 1
            OR applied_count < 0 OR accepted_count < 0 OR overridden_count < 0
            OR confidence < 0.0 OR confidence > 1.0
            OR (project_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM projects p WHERE p.id=user_habits.project_id))",
        [],
        |r| r.get(0),
    )?;
    if invalid_obs != 0 || invalid_props != 0 || invalid_habits != 0 {
        return Err(AppError::new("INVALID_BACKUP", "备份中的习惯学习记录无效"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;

    #[test]
    fn prelude_report_edits_synthesize_proposal_after_threshold_and_promote_on_confirm() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path().to_path_buf()).unwrap();
        db.conn
            .execute(
                "INSERT INTO projects VALUES('p1','支付二期','','2026-11-24T00:00:00Z')",
                [],
            )
            .unwrap();

        let draft = "今日完成：接口联调进度 60%。\n当前风险：测试账号待开通。";
        let edited = "当前风险：测试账号待开通。\n今日完成：接口联调推进中。";

        // 2 edits stay below threshold (no premature overfitting!)
        observe_report_edit(&db.conn, Some("p1"), "日报", draft, edited).unwrap();
        observe_report_edit(&db.conn, Some("p1"), "日报", draft, edited).unwrap();
        let before = center(&db.conn, &json!({"projectId": "p1"})).unwrap();
        assert_eq!(before["counts"]["pendingProposals"], 0);

        // 3rd consistent edit triggers proposals for drop_percentages & risks_first
        observe_report_edit(&db.conn, Some("p1"), "日报", draft, edited).unwrap();
        let after = center(&db.conn, &json!({"projectId": "p1"})).unwrap();
        let props = after["proposals"].as_array().unwrap();
        assert!(props
            .iter()
            .any(|p| p["patternKey"] == "writing:drop_percentages"));
        assert!(props
            .iter()
            .any(|p| p["patternKey"] == "writing:risks_first"));

        // Confirming promotes into active user_habits; rejecting suppresses re-proposal
        let target = props
            .iter()
            .find(|p| p["patternKey"] == "writing:risks_first")
            .unwrap();
        let confirmed = resolve_proposal(
            &db.conn,
            &json!({"proposalId": target["id"], "action": "confirm"}),
        )
        .unwrap();
        assert_eq!(confirmed["habit"]["status"], "active");

        let selected =
            select_for_context(&db.conn, Some("p1"), &["writing"], "周报润色", 5).unwrap();
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0]["patternKey"], "writing:risks_first");

        // ReMe utility degradation flags low-utility habit after repeated overrides
        let hid = selected[0]["id"].as_str().unwrap().to_owned();
        for _ in 0..5 {
            apply_outcome(&db.conn, std::slice::from_ref(&hid), "overridden").unwrap();
        }
        let degraded = center(&db.conn, &json!({"projectId": "p1"})).unwrap();
        assert_eq!(degraded["habits"][0]["lowUtilityWarning"], true);
    }

    #[test]
    fn pahf_copilot_feedback_saves_explicit_habit_immediately() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path().to_path_buf()).unwrap();
        let res = record_copilot_feedback(
            &db.conn,
            &json!({
                "toolName": "create_task",
                "decision": "edited_and_approved",
                "originalArgs": {"priority": "medium", "assignee": ""},
                "finalArgs": {"priority": "high", "assignee": "王明"},
                "rememberAsHabit": true
            }),
        )
        .unwrap();
        assert_eq!(res["savedHabits"].as_array().unwrap().len(), 2);
        let workflow = select_for_context(&db.conn, None, &["workflow"], "新建任务", 5).unwrap();
        assert_eq!(workflow.len(), 2);
    }
}
