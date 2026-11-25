//! Sleep-time consolidation of episodic / working-layer memories into stage snapshots.
//! Generates pending user-confirmable proposals; never mutates facts silently and preserves
//! every underlying revision and evidence link on confirmation.
use crate::{id, now, required, AppError, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};

const MAX_MEMORIES_PER_PROJECT: usize = 500;
const MAX_CLUSTER_ITEMS: usize = 8;

pub(crate) fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS memory_consolidations(
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id),
            topic_key TEXT NOT NULL,
            title TEXT NOT NULL,
            proposed_content TEXT NOT NULL,
            source_memory_ids_json TEXT NOT NULL,
            source_revisions_json TEXT NOT NULL,
            reason TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('pending','confirmed','dismissed')),
            target_memory_id TEXT REFERENCES memories(id),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS memory_consolidations_status ON memory_consolidations(status, project_id, updated_at);",
    )?;
    Ok(())
}

fn invalid(message: &str) -> AppError {
    AppError::new("VALIDATION", message)
}

fn table_exists(conn: &Connection) -> Result<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_consolidations')",
        [],
        |r| r.get(0),
    )?)
}

fn clip(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        text.to_owned()
    } else {
        text.chars().take(max_chars).collect()
    }
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

struct ClusterItem {
    id: String,
    revision: i64,
    content: String,
    updated_at: String,
    layer: String,
    review_after: Option<String>,
}

fn source_revisions_still_active(
    conn: &Connection,
    project_id: &str,
    revs: &[Value],
) -> Result<bool> {
    let archived_project: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM workspace_lifecycle WHERE kind='project' AND entity_id=?1 AND archived=1)",
        [project_id],
        |r| r.get(0),
    )?;
    if archived_project || revs.len() < 2 {
        return Ok(false);
    }
    for entry in revs {
        let Some(mid) = entry["memoryId"].as_str() else {
            return Ok(false);
        };
        let Some(rev) = entry["revision"].as_i64() else {
            return Ok(false);
        };
        let valid: bool = conn.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM memories m
                JOIN revisions r ON r.memory_id=m.id AND r.number=m.revision AND r.content=m.content
                WHERE m.id=?1 AND m.project_id=?2 AND m.revision=?3 AND m.state='active'
                  AND NOT EXISTS(SELECT 1 FROM revision_retention rt WHERE rt.revision_id=r.id AND json_extract(rt.policy,'$.layer') IN ('archive','clarify'))
            )",
            params![mid, project_id, rev],
            |r| r.get(0),
        )?;
        if !valid {
            return Ok(false);
        }
    }
    Ok(true)
}

pub(crate) fn scan(conn: &Connection, scope: Option<&str>, as_of: &str) -> Result<Value> {
    if !table_exists(conn)? {
        return Ok(json!({"scannedProjects": 0, "newProposals": 0, "autoDismissed": 0}));
    }
    let at = now();

    // Auto-dismiss pending proposals whose project was archived or source revisions changed.
    let mut pending_stmt = conn.prepare(
        "SELECT id, project_id, source_revisions_json FROM memory_consolidations WHERE status='pending'",
    )?;
    let pending_rows: Vec<(String, String, String)> = pending_stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    drop(pending_stmt);

    let mut auto_dismissed = 0usize;
    for (cid, pid, revs_raw) in pending_rows {
        let revs: Vec<Value> = serde_json::from_str(&revs_raw).unwrap_or_default();
        if !source_revisions_still_active(conn, &pid, &revs)? {
            conn.execute(
                "UPDATE memory_consolidations SET status='dismissed', updated_at=?1 WHERE id=?2",
                params![at, cid],
            )?;
            auto_dismissed += 1;
        }
    }

    let mut proj_stmt = conn.prepare(
        "SELECT id FROM projects p
         WHERE (?1 IS NULL OR p.id=?1)
           AND NOT EXISTS(SELECT 1 FROM workspace_lifecycle l WHERE l.kind='project' AND l.entity_id=p.id AND l.archived=1)
         ORDER BY p.id",
    )?;
    let projects: Vec<String> = proj_stmt
        .query_map([scope], |r| r.get(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    drop(proj_stmt);

    let mut new_proposals = 0usize;
    for project_id in &projects {
        let alias_groups = crate::aliases::load_groups(conn, Some(project_id))?;
        let alias_map = build_alias_map(&alias_groups);

        let mut stmt = conn.prepare(
            "SELECT m.id, m.revision, m.content, m.updated_at,
                    coalesce(f.facets,'{}'),
                    coalesce(rt.policy,'{\"layer\":\"durable\",\"reason\":\"旧版或人工记录\"}')
             FROM memories m
             JOIN revisions r ON r.memory_id=m.id AND r.number=m.revision AND r.content=m.content
             LEFT JOIN revision_facets f ON f.revision_id=r.id
             LEFT JOIN revision_retention rt ON rt.revision_id=r.id
             WHERE m.project_id=?1
               AND m.state='active'
               AND NOT EXISTS(SELECT 1 FROM revision_retention x WHERE x.revision_id=r.id AND json_extract(x.policy,'$.layer') IN ('archive','clarify'))
               AND NOT EXISTS(SELECT 1 FROM revisions lr JOIN revision_evidence le ON le.revision_id=lr.id JOIN segments lg ON lg.id=le.segment_id JOIN workspace_lifecycle l ON l.kind='source' AND l.entity_id=lg.source_id AND l.archived=1 WHERE lr.memory_id=m.id)
             ORDER BY m.updated_at DESC, m.id
             LIMIT ?2",
        )?;
        let rows: Vec<(String, i64, String, String, String, String)> = stmt
            .query_map(params![project_id, MAX_MEMORIES_PER_PROJECT as i64], |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        drop(stmt);

        let mut clusters: BTreeMap<String, (String, Vec<ClusterItem>)> = BTreeMap::new();
        for (mem_id, rev, content, updated_at, facets_raw, ret_raw) in rows {
            let facets: Value = serde_json::from_str(&facets_raw).unwrap_or_else(|_| json!({}));
            let retention: Value = serde_json::from_str(&ret_raw).unwrap_or_else(|_| json!({}));
            let layer = retention["layer"].as_str().unwrap_or("durable").to_owned();
            let review_after = retention["reviewAfter"].as_str().map(str::to_owned);

            let entity = facets["entity"]
                .as_str()
                .map(str::trim)
                .filter(|e| !e.is_empty() && crate::search::specific_entity(e));
            let topic = facets["topic"]
                .as_str()
                .map(str::trim)
                .filter(|t| !t.is_empty());

            let key_label = if let Some(ent) = entity {
                let canon = canonicalize(ent, &alias_map);
                Some((format!("entity:{canon}"), ent.to_owned()))
            } else if let Some(tp) = topic {
                Some((format!("topic:{}", tp.to_lowercase()), tp.to_owned()))
            } else if layer == "working" {
                let mut tokens: Vec<String> = crate::search::index_tokens(&content)
                    .into_iter()
                    .filter(|t| t.chars().count() >= 2 && !t.chars().all(|c| c.is_ascii_digit()))
                    .map(|t| canonicalize(&t, &alias_map))
                    .collect();
                tokens.sort();
                tokens.dedup();
                if tokens.len() >= 2 {
                    let (a, b) = (&tokens[0], &tokens[1]);
                    Some((format!("working:{a}+{b}"), format!("{a} / {b}")))
                } else {
                    None
                }
            } else {
                None
            };

            let Some((topic_key, topic_label)) = key_label else {
                continue;
            };
            clusters
                .entry(topic_key)
                .or_insert_with(|| (topic_label, Vec::new()))
                .1
                .push(ClusterItem {
                    id: mem_id,
                    revision: rev,
                    content,
                    updated_at,
                    layer,
                    review_after,
                });
        }

        for (topic_key, (topic_label, mut items)) in clusters {
            let has_working = items.iter().any(|it| it.layer == "working");
            let qualifies = items.len() >= 2
                && (has_working || (!topic_key.starts_with("working:") && items.len() >= 3));
            if !qualifies {
                continue;
            }
            items.sort_by(|a, b| {
                a.updated_at
                    .cmp(&b.updated_at)
                    .then_with(|| a.id.cmp(&b.id))
            });
            if items.len() > MAX_CLUSTER_ITEMS {
                let excess = items.len() - MAX_CLUSTER_ITEMS;
                items.drain(..excess);
            }

            let source_ids: Vec<&str> = items.iter().map(|it| it.id.as_str()).collect();
            let source_revs: Vec<Value> = items
                .iter()
                .map(|it| json!({"memoryId": it.id, "revision": it.revision}))
                .collect();
            let revs_json = json!(source_revs).to_string();

            let already: bool = conn.query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM memory_consolidations
                    WHERE project_id=?1 AND topic_key=?2 AND source_revisions_json=?3 AND status IN ('pending','dismissed')
                )",
                params![project_id, topic_key, revs_json],
                |r| r.get(0),
            )?;
            if already {
                continue;
            }

            conn.execute(
                "UPDATE memory_consolidations SET status='dismissed', updated_at=?1 WHERE project_id=?2 AND topic_key=?3 AND status='pending'",
                params![at, project_id, topic_key],
            )?;

            let latest = items.last().unwrap().content.trim();
            let mut earlier_seen = HashSet::new();
            let mut earlier = Vec::new();
            for it in items.iter().take(items.len() - 1) {
                let body = it.content.trim();
                if !body.is_empty() && body != latest && earlier_seen.insert(body.to_owned()) {
                    earlier.push(clip(body, 120));
                    if earlier.len() >= 3 {
                        break;
                    }
                }
            }
            let proposed_content = if earlier.is_empty() {
                clip(latest, 800)
            } else {
                clip(
                    &format!(
                        "{latest}（整合自 {} 条阶段记录；早期脉络：{}）",
                        items.len(),
                        earlier.join("；")
                    ),
                    800,
                )
            };
            let title = clip(&format!("主题归并：{topic_label}"), 120);
            let has_expired = items.iter().any(|it| {
                it.layer == "working"
                    && it.review_after.as_deref().is_some_and(|date| date <= as_of)
            });
            let reason = if has_expired {
                "包含已到期过程记忆，建议归并为阶段快照并归档旧记录"
            } else {
                "同一主题积累多条过程/阶段记忆，建议归并为一条最新结论并保留全部原文追溯"
            };

            conn.execute(
                "INSERT INTO memory_consolidations(
                    id,project_id,topic_key,title,proposed_content,source_memory_ids_json,
                    source_revisions_json,reason,status,target_memory_id,created_at,updated_at
                 ) VALUES(?,?,?,?,?,?,?,?,'pending',NULL,?,?)",
                params![
                    id(),
                    project_id,
                    topic_key,
                    title,
                    proposed_content,
                    json!(source_ids).to_string(),
                    revs_json,
                    reason,
                    at,
                    at,
                ],
            )?;
            new_proposals += 1;
        }
    }

    Ok(json!({
        "scannedProjects": projects.len(),
        "newProposals": new_proposals,
        "autoDismissed": auto_dismissed,
    }))
}

pub(crate) fn list(conn: &Connection, p: &Value) -> Result<Value> {
    if !table_exists(conn)? {
        return Ok(json!({"consolidations": [], "pendingCount": 0}));
    }
    let scope = p["projectId"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty() && *s != "all");
    let mut stmt = conn.prepare(
        "SELECT id, project_id, topic_key, title, proposed_content,
                source_revisions_json, reason, status, created_at, updated_at
         FROM memory_consolidations
         WHERE status='pending'
           AND (?1 IS NULL OR project_id=?1)
         ORDER BY updated_at DESC, id
         LIMIT 50",
    )?;
    struct PendingConsolidationRow {
        id: String,
        project_id: String,
        topic_key: String,
        title: String,
        proposed_content: String,
        revs_raw: String,
        reason: String,
        status: String,
        created_at: String,
        updated_at: String,
    }
    let rows: Vec<PendingConsolidationRow> = stmt
        .query_map([scope], |r| {
            Ok(PendingConsolidationRow {
                id: r.get(0)?,
                project_id: r.get(1)?,
                topic_key: r.get(2)?,
                title: r.get(3)?,
                proposed_content: r.get(4)?,
                revs_raw: r.get(5)?,
                reason: r.get(6)?,
                status: r.get(7)?,
                created_at: r.get(8)?,
                updated_at: r.get(9)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    drop(stmt);

    let mut consolidations = Vec::with_capacity(rows.len());
    for row in rows {
        let revs: Vec<Value> = serde_json::from_str(&row.revs_raw).unwrap_or_default();
        let mut source_memories = Vec::new();
        for entry in &revs {
            let Some(mid) = entry["memoryId"].as_str() else {
                continue;
            };
            let detail = conn
                .query_row(
                    "SELECT m.id, m.revision, m.kind, m.content, m.source_title, m.updated_at,
                            coalesce(rt.policy,'{\"layer\":\"durable\"}')
                     FROM memories m
                     JOIN revisions r ON r.memory_id=m.id AND r.number=m.revision
                     LEFT JOIN revision_retention rt ON rt.revision_id=r.id
                     WHERE m.id=?1",
                    [mid],
                    |r| {
                        let ret_raw: String = r.get(6)?;
                        let ret: Value =
                            serde_json::from_str(&ret_raw).unwrap_or_else(|_| json!({}));
                        Ok(json!({
                            "id": r.get::<_, String>(0)?,
                            "revision": r.get::<_, i64>(1)?,
                            "kind": r.get::<_, String>(2)?,
                            "content": r.get::<_, String>(3)?,
                            "sourceTitle": r.get::<_, String>(4)?,
                            "updatedAt": r.get::<_, String>(5)?,
                            "layer": ret["layer"].as_str().unwrap_or("durable"),
                        }))
                    },
                )
                .optional()?;
            if let Some(m) = detail {
                source_memories.push(m);
            }
        }
        consolidations.push(json!({
            "id": row.id,
            "projectId": row.project_id,
            "topicKey": row.topic_key,
            "title": row.title,
            "proposedContent": row.proposed_content,
            "reason": row.reason,
            "status": row.status,
            "sourceMemories": source_memories,
            "createdAt": row.created_at,
            "updatedAt": row.updated_at,
        }));
    }
    let pending_count = consolidations.len();
    Ok(json!({
        "consolidations": consolidations,
        "pendingCount": pending_count,
    }))
}

fn archive_member_in_tx(
    tx: &Connection,
    memory_id: &str,
    old_rev_id: &str,
    current_rev: i64,
    content: &str,
    reason: &str,
    at: &str,
) -> Result<()> {
    let next_rev = current_rev + 1;
    let new_rev_id = id();
    tx.execute(
        "UPDATE memories SET revision=?, updated_at=? WHERE id=?",
        params![next_rev, at, memory_id],
    )?;
    tx.execute(
        "INSERT INTO revisions VALUES(?,?,?,?,?,'user_correction',?)",
        params![new_rev_id, memory_id, next_rev, content, reason, at],
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
    let cid = required(p, "consolidationId")?.trim();
    let action = required(p, "action")?.trim();
    if !matches!(action, "confirm" | "dismiss") {
        return Err(invalid("处理方式仅支持 confirm 或 dismiss"));
    }
    let row: Option<(String, String, String, String)> = conn
        .query_row(
            "SELECT project_id, proposed_content, source_revisions_json, status
             FROM memory_consolidations WHERE id=?",
            [cid],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    let Some((project_id, proposed_content, revs_raw, status)) = row else {
        return Err(AppError::new("NOT_FOUND", "主题归并建议不存在"));
    };
    if status != "pending" {
        return Err(AppError::new("CONFLICT", "该归并建议已处理，请刷新"));
    }
    let at = now();
    if action == "dismiss" {
        conn.execute(
            "UPDATE memory_consolidations SET status='dismissed', updated_at=? WHERE id=?",
            params![at, cid],
        )?;
        return Ok(json!({"resolved": true, "status": "dismissed"}));
    }

    let final_content = p["content"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&proposed_content);
    crate::db::validate_content(final_content)?;
    let layer = p["layer"]
        .as_str()
        .map(str::trim)
        .filter(|s| matches!(*s, "durable" | "working"))
        .unwrap_or("durable");
    let reason = p["reason"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("休眠期主题归并确认：整合多条过程记忆为阶段快照");

    let revs: Vec<Value> = serde_json::from_str(&revs_raw)
        .map_err(|_| AppError::new("DATABASE", "归并建议来源记录损坏"))?;
    if revs.len() < 2 {
        return Err(invalid("至少需要两条记忆才能执行归并"));
    }

    let tx = conn.transaction()?;
    let mut verified: Vec<(String, i64, String, String)> = Vec::with_capacity(revs.len());
    for entry in &revs {
        let mid = entry["memoryId"]
            .as_str()
            .ok_or_else(|| AppError::new("DATABASE", "归并建议记忆 ID 无效"))?;
        let expected_rev = entry["revision"]
            .as_i64()
            .ok_or_else(|| AppError::new("DATABASE", "归并建议版本号无效"))?;
        let mem_row: Option<(i64, String, String)> = tx
            .query_row(
                "SELECT m.revision, m.content, r.id
                 FROM memories m
                 JOIN revisions r ON r.memory_id=m.id AND r.number=m.revision
                 WHERE m.id=?1 AND m.project_id=?2 AND m.state='active'",
                params![mid, project_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        let Some((current_rev, current_content, rev_id)) = mem_row else {
            return Err(AppError::new(
                "REVISION_CONFLICT",
                "关联记忆已变更，请重新扫描",
            ));
        };
        if current_rev != expected_rev {
            return Err(AppError::new(
                "REVISION_CONFLICT",
                "关联记忆已有新修订，请重新扫描后确认",
            ));
        }
        verified.push((mid.to_owned(), current_rev, current_content, rev_id));
    }

    let (target_id, target_rev, _, target_old_rev_id) = verified.last().unwrap().clone();
    let new_rev_number = target_rev + 1;
    let new_rev_id = id();
    tx.execute(
        "UPDATE memories SET content=?, revision=?, updated_at=? WHERE id=?",
        params![final_content, new_rev_number, at, target_id],
    )?;
    tx.execute(
        "INSERT INTO revisions VALUES(?,?,?,?,?,'user_correction',?)",
        params![
            new_rev_id,
            target_id,
            new_rev_number,
            final_content,
            reason,
            at
        ],
    )?;
    tx.execute(
        "INSERT OR IGNORE INTO revision_facets SELECT ?, facets FROM revision_facets WHERE revision_id=?",
        params![new_rev_id, target_old_rev_id],
    )?;
    for (_, _, _, old_rev_id) in &verified {
        tx.execute(
            "INSERT OR IGNORE INTO revision_evidence SELECT ?, segment_id FROM revision_evidence WHERE revision_id=?",
            params![new_rev_id, old_rev_id],
        )?;
    }
    crate::retention::save_revision(&tx, &new_rev_id, &json!({"layer": layer, "reason": reason}))?;

    for (mid, current_rev, content, old_rev_id) in verified.iter().take(verified.len() - 1) {
        archive_member_in_tx(
            tx_conn(&tx),
            mid,
            old_rev_id,
            *current_rev,
            content,
            reason,
            &at,
        )?;
    }

    tx.execute(
        "UPDATE memory_consolidations SET status='confirmed', target_memory_id=?, updated_at=? WHERE id=?",
        params![target_id, at, cid],
    )?;
    tx.commit()?;

    Ok(json!({
        "resolved": true,
        "status": "confirmed",
        "targetMemoryId": target_id,
    }))
}

fn tx_conn<'a>(tx: &'a rusqlite::Transaction<'_>) -> &'a Connection {
    tx
}

pub(crate) fn dispatch(conn: &mut Connection, command: &str, p: &Value) -> Result<Value> {
    match command {
        "get_memory_consolidations" => list(conn, p),
        "run_memory_consolidation" => {
            let scope = p["projectId"]
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty() && *s != "all");
            let today = chrono::Local::now().format("%Y-%m-%d").to_string();
            let scan_summary = scan(conn, scope, &today)?;
            let mut listed = list(conn, p)?;
            listed["scan"] = scan_summary;
            Ok(listed)
        }
        "resolve_memory_consolidation" => resolve(conn, p),
        _ => Err(invalid("不支持的主题归并操作")),
    }
}

pub(crate) fn validate_backup(conn: &Connection) -> Result<()> {
    if !table_exists(conn)? {
        return Err(AppError::new("INVALID_BACKUP", "备份缺少主题归并记录表"));
    }
    let invalid: i64 = conn.query_row(
        "SELECT count(*) FROM memory_consolidations c
         WHERE c.status NOT IN ('pending','confirmed','dismissed')
            OR NOT EXISTS(SELECT 1 FROM projects p WHERE p.id=c.project_id)
            OR (c.target_memory_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM memories m WHERE m.id=c.target_memory_id AND m.project_id=c.project_id))",
        [],
        |r| r.get(0),
    )?;
    if invalid != 0 {
        return Err(AppError::new("INVALID_BACKUP", "备份中的主题归并记录无效"));
    }
    let mut stmt = conn.prepare(
        "SELECT source_memory_ids_json, source_revisions_json FROM memory_consolidations",
    )?;
    for row in stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
        let (ids_raw, revs_raw) = row?;
        let ids: Value = serde_json::from_str(&ids_raw)
            .map_err(|_| AppError::new("INVALID_BACKUP", "备份中的归并来源列表无效"))?;
        let revs: Value = serde_json::from_str(&revs_raw)
            .map_err(|_| AppError::new("INVALID_BACKUP", "备份中的归并版本列表无效"))?;
        if !ids.is_array() || !revs.is_array() {
            return Err(AppError::new("INVALID_BACKUP", "备份中的归并结构无效"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;

    #[allow(clippy::too_many_arguments)]
    fn seed_working_memory(
        conn: &Connection,
        id: &str,
        project: &str,
        source_id: &str,
        seg_id: &str,
        ordinal: i64,
        entity: &str,
        content: &str,
        updated_at: &str,
        review_after: &str,
    ) {
        conn.execute(
            "INSERT INTO segments VALUES(?,?,?,?,?,?)",
            params![
                seg_id,
                source_id,
                "v1",
                ordinal,
                format!("第{}段", ordinal + 1),
                content
            ],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO memories VALUES(?,?,'fact',?,1,'active','进展纪要',?,?)",
            params![id, project, content, updated_at, updated_at],
        )
        .unwrap();
        let rev_id = format!("{id}:r1");
        conn.execute(
            "INSERT INTO revisions VALUES(?,?,1,?,'确认','confirmation',?)",
            params![rev_id, id, content, updated_at],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO revision_evidence VALUES(?,?)",
            params![rev_id, seg_id],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO revision_facets VALUES(?,?)",
            params![rev_id, json!({"entity": entity}).to_string()],
        )
        .unwrap();
        crate::retention::save_revision(
            conn,
            &rev_id,
            &json!({"layer": "working", "reason": "阶段进展", "reviewAfter": review_after}),
        )
        .unwrap();
    }

    #[test]
    fn consolidation_clusters_working_memories_preserves_evidence_and_archives_siblings() {
        let dir = tempfile::tempdir().unwrap();
        let mut db = Database::open(dir.path().to_path_buf()).unwrap();
        db.conn
            .execute("INSERT INTO projects VALUES('p1','网关项目','','now')", [])
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO sources VALUES('s1','p1','周报汇总','text','s1.txt',NULL,'now','h1','ready',2,NULL,'originals/s1.txt')",
                [],
            )
            .unwrap();

        seed_working_memory(
            &db.conn,
            "m1",
            "p1",
            "s1",
            "seg1",
            0,
            "支付网关",
            "支付网关压测完成30%，仍有一个超时缺陷。",
            "2026-11-10T10:00:00Z",
            "2026-11-17",
        );
        seed_working_memory(
            &db.conn,
            "m2",
            "p1",
            "s1",
            "seg2",
            1,
            "支付网关",
            "支付网关压测缺陷已修复，达到全量上线标准。",
            "2026-11-20T10:00:00Z",
            "2026-11-27",
        );

        let summary = scan(&db.conn, Some("p1"), "2026-11-25").unwrap();
        assert_eq!(summary["newProposals"], 1);

        let listed = list(&db.conn, &json!({"projectId": "p1"})).unwrap();
        let items = listed["consolidations"].as_array().unwrap();
        assert_eq!(items.len(), 1);
        let cid = items[0]["id"].as_str().unwrap();
        assert_eq!(items[0]["sourceMemories"].as_array().unwrap().len(), 2);

        let res = resolve(
            &mut db.conn,
            &json!({
                "consolidationId": cid,
                "action": "confirm",
                "content": "支付网关压测缺陷已修复并达到全量上线标准。",
                "layer": "durable",
            }),
        )
        .unwrap();
        assert_eq!(res["status"], "confirmed");
        assert_eq!(res["targetMemoryId"], "m2");

        // Target m2 moved to revision 2 and inherits both seg1 and seg2 evidence
        let (m2_rev, m2_content): (i64, String) = db
            .conn
            .query_row(
                "SELECT revision, content FROM memories WHERE id='m2'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(m2_rev, 2);
        assert_eq!(m2_content, "支付网关压测缺陷已修复并达到全量上线标准。");

        let m2_new_rev_id: String = db
            .conn
            .query_row(
                "SELECT id FROM revisions WHERE memory_id='m2' AND number=2",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let ev_count: i64 = db
            .conn
            .query_row(
                "SELECT count(*) FROM revision_evidence WHERE revision_id=?",
                [&m2_new_rev_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(ev_count, 2);

        // Older sibling m1 moved to revision 2 with archive retention layer
        let m1_rev: i64 = db
            .conn
            .query_row("SELECT revision FROM memories WHERE id='m1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(m1_rev, 2);
        let m1_new_rev_id: String = db
            .conn
            .query_row(
                "SELECT id FROM revisions WHERE memory_id='m1' AND number=2",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let m1_ret = crate::retention::revision(&db.conn, &m1_new_rev_id).unwrap();
        assert_eq!(m1_ret["layer"], "archive");

        validate_backup(&db.conn).unwrap();
        crate::retention::validate_backup(&db.conn).unwrap();
    }
}
