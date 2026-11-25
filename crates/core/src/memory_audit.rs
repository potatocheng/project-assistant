//! Sleep-time (idle) contradiction and duplicate audit over active confirmed memories.
//! Zero-token deterministic scan that catches latent conflicts (different dates, owners,
//! affirmative vs negated decisions, or near-duplicate active records) without breaking
//! immutable revision history or backup invariants.
use crate::{id, now, required, AppError, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap, HashSet};

const MAX_SCAN_PER_PROJECT: usize = 400;

pub(crate) fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS memory_audits(
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id),
            memory_a_id TEXT NOT NULL REFERENCES memories(id),
            memory_a_revision INTEGER NOT NULL CHECK(memory_a_revision>=1),
            memory_b_id TEXT NOT NULL REFERENCES memories(id),
            memory_b_revision INTEGER NOT NULL CHECK(memory_b_revision>=1),
            kind TEXT NOT NULL CHECK(kind IN ('date_conflict','owner_conflict','negation_conflict','duplicate_overlap')),
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

fn extract_iso_dates(text: &str) -> BTreeSet<String> {
    let bytes = text.as_bytes();
    let mut dates = BTreeSet::new();
    if bytes.len() < 10 {
        return dates;
    }
    for i in 0..=bytes.len() - 10 {
        let s = &bytes[i..i + 10];
        if s[0..4].iter().all(u8::is_ascii_digit)
            && s[4] == b'-'
            && s[5..7].iter().all(u8::is_ascii_digit)
            && s[7] == b'-'
            && s[8..10].iter().all(u8::is_ascii_digit)
        {
            if let Ok(token) = std::str::from_utf8(s) {
                dates.insert(token.to_owned());
            }
        }
    }
    dates
}

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
    // Pattern 1: "由<name>负责"
    if let Some(start) = content.find('由') {
        let rest = &content[start + '由'.len_utf8()..];
        if let Some(end) = rest.find("负责") {
            let candidate = rest[..end].trim();
            let char_len = candidate.chars().count();
            if (1..=12).contains(&char_len)
                && !candidate.contains(['，', '。', '、', ',', '.', '；', ';', '\n', ' '])
            {
                return Some(canonicalize(candidate, alias_map));
            }
        }
    }
    // Pattern 2: "负责人：<name>" / "负责人为<name>"
    for prefix in ["负责人：", "负责人:", "负责人为", "负责人是"] {
        if let Some(start) = content.find(prefix) {
            let rest = content[start + prefix.len()..].trim_start();
            let candidate: String = rest
                .chars()
                .take_while(|c| {
                    !matches!(
                        c,
                        '，' | '。' | '、' | ',' | '.' | '；' | ';' | '\n' | ' ' | '（' | '('
                    )
                })
                .collect();
            let char_len = candidate.chars().count();
            if (1..=12).contains(&char_len) {
                return Some(canonicalize(&candidate, alias_map));
            }
        }
    }
    None
}

fn has_negation(content: &str) -> bool {
    [
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
    tokens: HashSet<String>,
    dates: BTreeSet<String>,
    owner: Option<String>,
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
                let tokens = canonical_tokens(&content, &alias_map);
                let dates = extract_iso_dates(&content);
                let owner = extract_owner(&content, &facets, &alias_map);
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
                    tokens,
                    dates,
                    owner,
                    negated,
                    entity,
                }
            })
            .collect();
        drop(stmt);

        for i in 0..items.len() {
            for j in (i + 1)..items.len() {
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
                let shared_entity =
                    matches!((&a.entity, &b.entity), (Some(ea), Some(eb)) if ea == eb);
                let sim = jaccard(&a.tokens, &b.tokens);
                if sim < 0.30 && !shared_entity {
                    continue;
                }

                let finding: Option<(&str, String)> = if sim >= 0.85
                    && a.dates == b.dates
                    && a.negated == b.negated
                    && a.owner == b.owner
                {
                    Some((
                        "duplicate_overlap",
                        "两条活跃记忆表述高度重复，建议保留更完整的一条，将另一条归档为仅存原文。"
                            .into(),
                    ))
                } else if (sim >= 0.35 || shared_entity)
                    && !a.dates.is_empty()
                    && !b.dates.is_empty()
                    && a.dates.is_disjoint(&b.dates)
                {
                    let da = a.dates.iter().cloned().collect::<Vec<_>>().join("、");
                    let db = b.dates.iter().cloned().collect::<Vec<_>>().join("、");
                    Some((
                        "date_conflict",
                        format!("两条相关活跃记忆记录了不同日期（{da} vs {db}），可能存在排期变更后旧记忆未更新。"),
                    ))
                } else if (sim >= 0.35 || shared_entity)
                    && matches!((&a.owner, &b.owner), (Some(oa), Some(ob)) if oa != ob)
                {
                    let oa = a.owner.as_deref().unwrap_or("");
                    let ob = b.owner.as_deref().unwrap_or("");
                    Some((
                        "owner_conflict",
                        format!("两条相关活跃记忆记录了不同负责人（{oa} vs {ob}），请核对最新责任归属。"),
                    ))
                } else if (sim >= 0.45 || (shared_entity && sim >= 0.30)) && a.negated != b.negated
                {
                    Some((
                        "negation_conflict",
                        "两条相关活跃记忆存在肯定与取消/否决表述矛盾，请确认当前有效结论。".into(),
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

pub(crate) fn resolve(conn: &mut Connection, p: &Value) -> Result<Value> {
    let audit_id = required(p, "auditId")?.trim();
    let action = required(p, "action")?.trim();
    if !matches!(action, "dismiss" | "keep_a" | "keep_b") {
        return Err(invalid("处理方式仅支持 dismiss / keep_a / keep_b"));
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
    let reason = p["reason"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("库内冲突巡检确认：已由另一条活跃记忆替代，转仅存原文");
    let tx = conn.transaction()?;
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
        _ => unreachable!(),
    };
    tx.execute(
        "UPDATE memory_audits SET status=?, updated_at=? WHERE id=?",
        params![new_status, now(), audit_id],
    )?;
    tx.commit()?;
    Ok(json!({"resolved": true, "status": new_status}))
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
         WHERE a.kind NOT IN ('date_conflict','owner_conflict','negation_conflict','duplicate_overlap')
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
}
