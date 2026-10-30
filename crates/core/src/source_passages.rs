//! Read-only, version-bound source passages alongside confirmed memory.
//! A passage is imported document evidence, never an automatically confirmed
//! assertion. Sources touched by revised, archived, conflicting or out-of-date
//! memory are excluded conservatively until a finer supersession policy exists.
//! Remote provenance identifies the latest locally imported snapshot, not the
//! live remote document. Plain imports have no logical-document lineage: equal
//! titles/file names alone must never establish a version or supersession link.
use crate::{hash, memory_facts, search::Query, AppError, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};

pub(crate) const MAX_PASSAGES: usize = 8;
pub(crate) const MAX_PASSAGE_CHARS: usize = 6_000;
pub(crate) const MAX_TOTAL_CHARS: usize = 24_000;
const MAX_ANCHORS: usize = 64;
const MAX_SOURCES: usize = 8;
const MAX_SCAN_SEGMENTS: usize = 10_000;
const MAX_SCAN_BYTES: usize = 32 * 1024 * 1024;
const MAX_READING_PASSAGES: usize = 6;
const MAX_READING_CHARS: usize = 18_000;

#[derive(Default)]
struct SourceAnchors {
    memory_ids: Vec<String>,
    segment_anchors: BTreeMap<String, Vec<usize>>,
}

struct PassageCandidate {
    reference: Value,
    anchors: Vec<usize>,
    score: f64,
    chars: usize,
}

fn stale() -> AppError {
    AppError::new("QA_CONTEXT_STALE", "原文资料或关联记忆已有变化，请重新提问")
}

fn frozen(conn: &Connection, memory: &str) -> Result<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM memory_reviews v JOIN proposals p ON p.id=v.proposal_id
         WHERE v.target_id=? AND v.status='pending' AND p.status='pending'
         AND v.disposition IN ('conflict','uncertain'))",
        [memory],
        |row| row.get(0),
    )?)
}

fn source_origin(conn: &Connection, source: &str) -> Result<Value> {
    Ok(conn.query_row(
        "SELECT provider,remote_id,remote_revision,fetched_at FROM source_origins WHERE source_id=?",
        [source], |row| Ok(json!({"provider":row.get::<_,String>(0)?,"remoteId":row.get::<_,String>(1)?,
            "remoteRevision":row.get::<_,String>(2)?,"fetchedAt":row.get::<_,String>(3)?})),
    ).optional()?.unwrap_or(Value::Null))
}

fn eligible_source(conn: &Connection, project: &str, source: &str, as_of: &str) -> Result<bool> {
    if conn.query_row("SELECT EXISTS(SELECT 1 FROM workspace_lifecycle WHERE archived=1 AND ((kind='source' AND entity_id=?1) OR (kind='project' AND entity_id=?2)))",rusqlite::params![source,project],|r|r.get::<_,bool>(0))? { return Ok(false); }
    let ready: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sources WHERE id=? AND project_id=? AND status='ready')",
        params![source, project],
        |row| row.get(0),
    )?;
    if !ready {
        return Ok(false);
    }
    // Use the same remote identity/order as planning, but do not fall back to
    // stale text while the newer snapshot is parsing or has failed.
    let superseded: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM source_origins o JOIN source_origins newer
         ON newer.provider=o.provider AND newer.remote_id=o.remote_id
         JOIN sources ns ON ns.id=newer.source_id
         WHERE o.source_id=? AND ns.project_id=?
         AND (newer.fetched_at>o.fetched_at OR (newer.fetched_at=o.fetched_at AND newer.rowid>o.rowid)))",
        params![source,project], |row| row.get(0),
    )?;
    if superseded {
        return Ok(false);
    }
    // Editing a draft before confirmation still produces revision 1 with a
    // confirmation origin. Preserve that human correction as well.
    let edited: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM proposals WHERE source_id=? AND project_id=? AND status='confirmed' AND edited<>0)",
        params![source,project], |row| row.get(0),
    )?;
    if edited {
        return Ok(false);
    }
    let pending: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM memory_reviews v JOIN proposals p ON p.id=v.proposal_id
         WHERE p.source_id=? AND p.project_id=? AND p.status='pending' AND v.status='pending'
         AND v.disposition IN ('conflict','uncertain'))",
        params![source, project],
        |row| row.get(0),
    )?;
    if pending {
        return Ok(false);
    }
    // Inspect all historical links: a correction without new evidence must
    // still prevent an unchanged sibling memory from reopening the old source.
    let mut statement = conn.prepare(
        "SELECT DISTINCT m.id,m.state,m.revision,r.origin,r.id,r.content,m.content
         FROM memories m JOIN revisions history ON history.memory_id=m.id
         JOIN revision_evidence e ON e.revision_id=history.id JOIN segments g ON g.id=e.segment_id
         JOIN revisions r ON r.memory_id=m.id AND r.number=m.revision
         WHERE g.source_id=? AND m.project_id=?",
    )?;
    let rows = statement.query_map(params![source, project], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, String>(5)?,
            row.get::<_, String>(6)?,
        ))
    })?;
    for row in rows {
        let (memory, state, revision, origin, revision_id, revision_content, content) = row?;
        if state != "active"
            || revision != 1
            || origin == "user_correction"
            || content != revision_content
            || frozen(conn, &memory)?
            || !crate::retention::eligible(&crate::retention::revision(conn, &revision_id)?, as_of)
            || !memory_facts::applicable(&memory_facts::load(conn, &revision_id)?, &[], as_of)
        {
            return Ok(false);
        }
    }
    Ok(true)
}

fn anchor_sources(
    conn: &Connection,
    scope: Option<&str>,
    as_of: &str,
    anchors: &[Value],
) -> Result<BTreeMap<(String, String), SourceAnchors>> {
    let mut sources = BTreeMap::<(String, String), SourceAnchors>::new();
    let mut seen = HashSet::new();
    for (anchor_index, reference) in anchors.iter().take(MAX_ANCHORS).enumerate() {
        let anchor = reference.get("record").unwrap_or(reference);
        let Some(memory) = anchor["memoryId"]
            .as_str()
            .or_else(|| anchor["id"].as_str())
        else {
            continue;
        };
        let Some(project) = anchor["projectId"].as_str() else {
            continue;
        };
        if scope.is_some_and(|scope| scope != project) {
            continue;
        }
        let row = conn
            .query_row(
                "SELECT m.content,m.revision,r.id,r.origin FROM memories m
             JOIN revisions r ON r.memory_id=m.id AND r.number=m.revision AND r.content=m.content
             WHERE m.id=? AND m.project_id=? AND m.state='active'",
                params![memory, project],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                },
            )
            .optional()?;
        let Some((content, revision, revision_id, origin)) = row else {
            continue;
        };
        let facets = memory_facts::load(conn, &revision_id)?;
        if anchor["revision"] != revision
            || anchor["revisionId"] != revision_id
            || anchor["content"]
                .as_str()
                .is_none_or(|body| body.trim().is_empty() || !content.contains(body))
            || anchor
                .get("contentHash")
                .is_some_and(|value| *value != hash(content.as_bytes()))
            || anchor.get("facets").is_some_and(|value| *value != facets)
            || revision != 1
            || origin == "user_correction"
            || frozen(conn, memory)?
            || !memory_facts::applicable(&facets, &[], as_of)
        {
            continue;
        }
        if !seen.insert((project.to_owned(), memory.to_owned())) {
            continue;
        }
        let mut statement = conn.prepare(
            "SELECT DISTINCT s.id,g.id,g.ordinal FROM revision_evidence e JOIN segments g ON g.id=e.segment_id
             JOIN sources s ON s.id=g.source_id WHERE e.revision_id=? AND s.project_id=? AND s.status='ready' ORDER BY s.id,g.ordinal,g.id",
        )?;
        let links = statement.query_map(params![revision_id, project], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        for link in links {
            let (source, segment) = link?;
            let key = (project.to_owned(), source.clone());
            if !sources.contains_key(&key) && sources.len() >= MAX_SOURCES {
                continue;
            }
            if !eligible_source(conn, project, &source, as_of)? {
                continue;
            }
            let selected = sources.entry(key).or_default();
            if !selected.memory_ids.iter().any(|id| id == memory) {
                selected.memory_ids.push(memory.to_owned());
            }
            selected
                .segment_anchors
                .entry(segment)
                .or_default()
                .push(anchor_index);
        }
    }
    Ok(sources)
}

/// Rank whole original segments only inside sources reached from current,
/// eligible memory anchors. No database writes, extraction or provider calls.
/// Both entrypoints pass their actually selected formal memories, in pack order.
pub(crate) fn retrieve(
    conn: &Connection,
    scope: Option<&str>,
    query: &Query,
    as_of: &str,
    anchors: &[Value],
) -> Result<Vec<Value>> {
    crate::tasks::valid_date(as_of)?;
    let sources = anchor_sources(conn, scope, as_of, anchors)?;
    let mut candidates = Vec::new();
    let (mut scanned, mut bytes) = (0usize, 0usize);
    for ((project, source), source_anchors) in sources {
        let origin = source_origin(conn, &source)?;
        let (count,size): (usize,usize) = conn.query_row(
            "SELECT count(*),coalesce(sum(length(CAST(text AS BLOB))),0) FROM segments WHERE source_id=?",
            [&source], |row| Ok((row.get(0)?,row.get(1)?)),
        )?;
        scanned = scanned.saturating_add(count);
        bytes = bytes.saturating_add(size);
        if scanned > MAX_SCAN_SEGMENTS || bytes > MAX_SCAN_BYTES {
            return Err(AppError::new(
                "QA_RETRIEVAL_LIMIT",
                "关联原文超过本地检索容量，请缩小项目范围",
            ));
        }
        let mut statement = conn.prepare(
            "SELECT g.id,g.source_version_id,g.ordinal,g.locator,g.text,s.title,s.sha256
             FROM segments g JOIN sources s ON s.id=g.source_id
             WHERE s.id=? AND s.project_id=? AND s.status='ready' ORDER BY g.ordinal,g.id",
        )?;
        let rows = statement.query_map(params![source, project], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
            ))
        })?;
        for row in rows {
            let (segment, version, ordinal, locator, content, title, source_hash) = row?;
            // Do not turn a character cap into a silently missing condition.
            if content.trim().is_empty() || content.chars().count() > MAX_PASSAGE_CHARS {
                continue;
            }
            let anchor_indices = source_anchors
                .segment_anchors
                .get(&segment)
                .cloned()
                .unwrap_or_default();
            candidates.push((json!({"id":format!("source:{source}:{segment}"),"kind":"source_passage",
                "projectId":project,"sourceId":source,"sourceVersionId":version,"segmentId":segment,
                "ordinal":ordinal,"locator":locator,"contentHash":hash(content.as_bytes()),"content":content,
                "sourceHash":source_hash,"sourceTitle":title,"title":title,"sourceOrigin":origin,"asOfDate":as_of,"anchorMemoryIds":source_anchors.memory_ids,
                "evidence":[{"sourceId":source,"segmentId":segment,"sourceTitle":title,"locator":locator,"text":content}],
                "evidenceLabel":"导入原文（非正式记忆）"}), anchor_indices));
        }
    }
    let bodies = candidates
        .iter()
        .map(|(value, _)| value["content"].as_str().unwrap())
        .collect::<Vec<_>>();
    let scores = query.rank(&bodies);
    let mut ranked = candidates
        .into_iter()
        .zip(scores)
        .filter(|((_, anchors), score)| *score > 0.0 || !anchors.is_empty())
        .map(|((reference, anchors), score)| PassageCandidate {
            chars: reference["content"].as_str().unwrap().chars().count(),
            reference,
            anchors,
            score,
        })
        .collect::<Vec<_>>();
    ranked.sort_by(|a, b| {
        b.score.total_cmp(&a.score).then_with(|| {
            let (a, b) = (&a.reference, &b.reference);
            a["projectId"]
                .as_str()
                .cmp(&b["projectId"].as_str())
                .then_with(|| a["sourceId"].as_str().cmp(&b["sourceId"].as_str()))
                .then_with(|| a["ordinal"].as_i64().cmp(&b["ordinal"].as_i64()))
                .then_with(|| a["segmentId"].as_str().cmp(&b["segmentId"].as_str()))
        })
    });
    let (mut selected, mut chars) = (Vec::new(), 0usize);
    // Read selected facts in their actual original context before letting
    // repeated question words in introductions consume every source slot.
    // One new segment per anchor on the first pass covers distinct facts;
    // multiple citations to one paragraph never increase its priority.
    for anchor_index in 0..anchors.len().min(MAX_ANCHORS) {
        if selected.len() >= MAX_READING_PASSAGES {
            break;
        }
        if let Some((index, _)) = ranked.iter().enumerate().find(|(index, candidate)| {
            candidate.anchors.contains(&anchor_index)
                && !selected.contains(index)
                && chars + candidate.chars <= MAX_READING_CHARS
        }) {
            select_passage(
                &ranked,
                index,
                &mut selected,
                &mut chars,
                MAX_READING_PASSAGES,
                MAX_READING_CHARS,
            );
        }
    }
    for (index, _) in ranked
        .iter()
        .enumerate()
        .filter(|(_, c)| !c.anchors.is_empty())
    {
        select_passage(
            &ranked,
            index,
            &mut selected,
            &mut chars,
            MAX_READING_PASSAGES,
            MAX_READING_CHARS,
        );
    }
    // Keep capacity for direct source matches, including useful paragraphs
    // that were never extracted into a formal memory. Unused capacity can
    // finally read further linked paragraphs, never unrelated zero-hit text.
    for (index, _) in ranked.iter().enumerate().filter(|(_, c)| c.score > 0.0) {
        select_passage(
            &ranked,
            index,
            &mut selected,
            &mut chars,
            MAX_PASSAGES,
            MAX_TOTAL_CHARS,
        );
    }
    for (index, _) in ranked
        .iter()
        .enumerate()
        .filter(|(_, c)| !c.anchors.is_empty())
    {
        select_passage(
            &ranked,
            index,
            &mut selected,
            &mut chars,
            MAX_PASSAGES,
            MAX_TOTAL_CHARS,
        );
    }
    Ok(selected
        .into_iter()
        .map(|index| ranked[index].reference.clone())
        .collect())
}

fn select_passage(
    candidates: &[PassageCandidate],
    index: usize,
    selected: &mut Vec<usize>,
    chars: &mut usize,
    max_passages: usize,
    max_chars: usize,
) {
    if selected.len() < max_passages
        && !selected.contains(&index)
        && *chars + candidates[index].chars <= max_chars
    {
        *chars += candidates[index].chars;
        selected.push(index);
    }
}

/// Recheck one trusted snapshot reference against current source and anchor
/// identity. The caller still enforces its requested project/date and compares
/// the complete retrieved snapshot when selection itself must remain frozen.
pub(crate) fn validate(conn: &Connection, reference: &Value) -> Result<()> {
    let text = |field: &str| {
        reference[field]
            .as_str()
            .filter(|value| !value.is_empty())
            .ok_or_else(stale)
    };
    let (project, source, segment, as_of) = (
        text("projectId")?,
        text("sourceId")?,
        text("segmentId")?,
        text("asOfDate")?,
    );
    crate::tasks::valid_date(as_of).map_err(|_| stale())?;
    if reference["kind"] != "source_passage"
        || reference.get("memoryId").is_some()
        || reference["id"] != format!("source:{source}:{segment}")
        || reference["evidenceLabel"] != "导入原文（非正式记忆）"
        || reference.get("sourceOrigin") != Some(&source_origin(conn, source)?)
        || !eligible_source(conn, project, source, as_of)?
    {
        return Err(stale());
    }
    let row = conn
        .query_row(
            "SELECT g.source_version_id,g.ordinal,g.locator,g.text,s.title,s.sha256
         FROM segments g JOIN sources s ON s.id=g.source_id
         WHERE g.id=? AND s.id=? AND s.project_id=? AND s.status='ready'",
            params![segment, source, project],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(stale)?;
    if reference["sourceVersionId"] != row.0
        || reference["ordinal"] != row.1
        || reference["locator"] != row.2
        || reference["content"] != row.3
        || reference["contentHash"] != hash(row.3.as_bytes())
        || reference["sourceTitle"] != row.4
        || reference["title"] != row.4
        || reference["sourceHash"] != row.5
        || reference["evidence"]
            != json!([{"sourceId":source,"segmentId":segment,"sourceTitle":row.4,"locator":row.2,"text":row.3}])
        || row.3.trim().is_empty()
        || row.3.chars().count() > MAX_PASSAGE_CHARS
    {
        return Err(stale());
    }
    let anchors = reference["anchorMemoryIds"]
        .as_array()
        .filter(|ids| !ids.is_empty() && ids.len() <= MAX_ANCHORS)
        .ok_or_else(stale)?;
    let mut seen = HashSet::new();
    for id in anchors {
        let id = id
            .as_str()
            .filter(|id| seen.insert(*id))
            .ok_or_else(stale)?;
        let linked: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM memories m JOIN revisions r ON r.memory_id=m.id AND r.number=m.revision AND r.content=m.content
             JOIN revision_evidence e ON e.revision_id=r.id JOIN segments g ON g.id=e.segment_id
             WHERE m.id=? AND m.project_id=? AND m.state='active' AND m.revision=1 AND r.origin<>'user_correction' AND g.source_id=?)",
            params![id,project,source], |row| row.get(0),
        )?;
        if !linked {
            return Err(stale());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    const DATE: &str = "2026-10-26";

    fn database() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        crate::db::migrate(&conn).unwrap();
        conn.execute_batch(
            "INSERT INTO projects VALUES('p','Project','','now'),('other','Other','','now');",
        )
        .unwrap();
        conn
    }

    fn source(conn: &Connection, id: &str, project: &str, texts: &[&str]) {
        conn.execute("INSERT INTO sources VALUES(?,?,?,'text','paper.txt',NULL,'now',?,'ready',?,NULL,'paper.txt')",
            params![id,project,"Same title",hash(id.as_bytes()),texts.len()]).unwrap();
        for (ordinal, text) in texts.iter().enumerate() {
            conn.execute(
                "INSERT INTO segments VALUES(?,?,?,?,?,?)",
                params![
                    format!("{id}:{ordinal}"),
                    id,
                    format!("{id}:v1"),
                    ordinal,
                    format!("paragraph {}", ordinal + 1),
                    text
                ],
            )
            .unwrap();
        }
    }

    fn memory(conn: &Connection, id: &str, project: &str, source: &str, content: &str) -> Value {
        conn.execute(
            "INSERT INTO memories VALUES(?,?,'fact',?,1,'active','Same title','now','now')",
            params![id, project, content],
        )
        .unwrap();
        let revision = format!("{id}:r1");
        conn.execute(
            "INSERT INTO revisions VALUES(?,?,1,?,'confirmed','confirmation','now')",
            params![revision, id, content],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO revision_evidence VALUES(?,?)",
            params![revision, format!("{source}:0")],
        )
        .unwrap();
        json!({"id":id,"memoryId":id,"projectId":project,"kind":"fact","content":content,"revision":1,
            "revisionId":revision,"origin":"confirmation","contentHash":hash(content.as_bytes()),"facets":{}})
    }

    fn fixture() -> (Connection, Value) {
        let conn = database();
        source(&conn,"s","p",&["The protocol applies only to the pilot. Context metrics are described below.",
            "Context evaluation used a parallel corpus with English and German, but only for the alignment trial."]);
        let anchor = memory(
            &conn,
            "m",
            "p",
            "s",
            "The protocol applies only to the pilot.",
        );
        (conn, anchor)
    }

    fn passages(conn: &Connection, anchors: &[Value]) -> Vec<Value> {
        retrieve(
            conn,
            Some("p"),
            &Query::new("context parallel corpus"),
            DATE,
            anchors,
        )
        .unwrap()
    }

    fn conflict(conn: &Connection, source: &str, target: Option<&str>) {
        conn.execute("INSERT INTO proposals(id,project_id,source_id,kind,content,status,created_at) VALUES('proposal','p',?,'fact','disputed','pending','now')",[source]).unwrap();
        conn.execute("INSERT INTO memory_reviews VALUES('review','proposal','conflict',?,1,'old','verify','pending','now','now')",[target]).unwrap();
    }

    #[test]
    fn whole_unlinked_source_context_is_read_only_and_has_its_own_identity() {
        let (conn, anchor) = fixture();
        let before = conn.total_changes();
        let result = passages(&conn, std::slice::from_ref(&anchor));
        let wrapped = json!({"id":"memory:m","kind":"memory","record":anchor});
        assert_eq!(result, passages(&conn, &[wrapped]));
        let passage = result.iter().find(|p| p["segmentId"] == "s:1").unwrap();
        assert_eq!(passage["content"],"Context evaluation used a parallel corpus with English and German, but only for the alignment trial.");
        assert_eq!(passage["id"], "source:s:s:1");
        assert_eq!(passage["kind"], "source_passage");
        assert_eq!(passage["anchorMemoryIds"], json!(["m"]));
        assert_eq!(passage["evidence"][0]["text"], passage["content"]);
        assert_eq!(passage["title"], passage["sourceTitle"]);
        assert!(passage.get("memoryId").is_none());
        for value in &result {
            validate(&conn, value).unwrap();
        }
        assert_eq!(
            conn.total_changes(),
            before,
            "source retrieval must not create formal memories or modify the database"
        );
    }

    #[test]
    fn source_search_requires_current_project_bound_formal_anchors() {
        let (conn, anchor) = fixture();
        source(
            &conn,
            "secret",
            "other",
            &["Context parallel corpus confidential values"],
        );
        let other = memory(
            &conn,
            "other-m",
            "other",
            "secret",
            "Context parallel corpus confidential values",
        );
        assert!(passages(&conn, &[]).is_empty());
        assert!(passages(&conn, std::slice::from_ref(&other)).is_empty());
        let result = passages(&conn, &[anchor.clone(), other]);
        assert!(result
            .iter()
            .all(|v| v["projectId"] == "p" && v["sourceId"] == "s"));
        for (field, bad) in [
            ("revision", json!(2)),
            ("revisionId", json!("absent")),
            ("content", json!("forged")),
            ("contentHash", json!("forged")),
            ("facets", json!({"entity":"forged"})),
            ("projectId", json!("other")),
            ("memoryId", json!("proposal")),
        ] {
            let mut forged = anchor.clone();
            forged[field] = bad;
            assert!(
                passages(&conn, &[forged]).is_empty(),
                "accepted forged {field}"
            );
        }
        conn.execute("UPDATE sources SET status='parsing' WHERE id='s'", [])
            .unwrap();
        assert!(passages(&conn, &[anchor]).is_empty());
    }

    #[test]
    fn corrected_archived_conflicting_or_expired_siblings_quarantine_the_whole_source() {
        for variant in [
            "correction",
            "maintenance",
            "edited_confirmation",
            "archived",
            "target_conflict",
            "incoming_conflict",
            "uncertain",
            "expired",
            "future",
        ] {
            let (conn, anchor) = fixture();
            memory(
                &conn,
                "sibling",
                "p",
                "s",
                "Context policy from 2026-01-01 until 2026-10-01; future 2027-01-01.",
            );
            let old = passages(&conn, std::slice::from_ref(&anchor));
            assert!(!old.is_empty());
            match variant {
                "correction" | "maintenance" => {
                    let origin = if variant == "correction" {
                        "user_correction"
                    } else {
                        "maintenance"
                    };
                    conn.execute("INSERT INTO revisions VALUES('sibling:r2','sibling',2,'Corrected policy','correction',?,'later')",[origin]).unwrap();
                    // No new evidence link: the historical link must still quarantine s.
                    conn.execute("UPDATE memories SET revision=2,content='Corrected policy' WHERE id='sibling'",[]).unwrap();
                }
                "archived" => {
                    conn.execute(
                        "UPDATE memories SET state='archived' WHERE id='sibling'",
                        [],
                    )
                    .unwrap();
                }
                "edited_confirmation" => {
                    conn.execute("INSERT INTO proposals(id,project_id,source_id,kind,content,status,created_at,memory_id,edited) VALUES('edited','p','s','fact','Manually corrected','confirmed','now','sibling',1)",[]).unwrap();
                }
                "target_conflict" => {
                    source(&conn, "incoming", "p", &["Incoming context"]);
                    conflict(&conn, "incoming", Some("sibling"));
                }
                "incoming_conflict" => conflict(&conn, "s", None),
                "uncertain" => {
                    conflict(&conn, "s", Some("sibling"));
                    conn.execute("UPDATE memory_reviews SET disposition='uncertain'", [])
                        .unwrap();
                }
                "expired" | "future" => {
                    let facets = if variant == "expired" {
                        json!({"validUntil":"2026-10-01"})
                    } else {
                        json!({"validFrom":"2027-01-01"})
                    };
                    memory_facts::save(
                        &conn,
                        "sibling:r1",
                        &facets,
                        "Context policy from 2026-01-01 until 2026-10-01; future 2027-01-01.",
                    )
                    .unwrap();
                }
                _ => unreachable!(),
            }
            assert!(
                passages(&conn, &[anchor]).is_empty(),
                "{variant} reopened the source"
            );
            assert_eq!(
                validate(&conn, &old[0]).unwrap_err().code,
                "QA_CONTEXT_STALE",
                "{variant}"
            );
        }
    }

    #[test]
    fn blocked_sources_do_not_quarantine_other_sources_with_the_same_title() {
        let (conn, anchor) = fixture();
        source(
            &conn,
            "clean",
            "p",
            &["Context parallel corpus still available from another source."],
        );
        let clean = memory(
            &conn,
            "clean-m",
            "p",
            "clean",
            "Context parallel corpus still available from another source.",
        );
        conn.execute("UPDATE memories SET state='archived' WHERE id='m'", [])
            .unwrap();
        let result = passages(&conn, &[anchor, clean]);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0]["sourceId"], "clean");
        validate(&conn, &result[0]).unwrap();
    }

    fn remote(conn: &Connection, source: &str, document: &str, revision: &str, fetched: &str) {
        conn.execute("INSERT INTO source_origins VALUES(?,'feishu_document',?,?,'https://example.test/doc','Author','2026-01-01',?)",
            params![source,document,revision,fetched]).unwrap();
    }

    #[test]
    fn only_latest_locally_imported_remote_version_is_eligible_without_stale_fallback() {
        for latest_state in ["ready", "parsing", "failed"] {
            let (conn, anchor) = fixture();
            remote(&conn, "s", "document", "1", "2026-10-25T08:00:00Z");
            let old = passages(&conn, std::slice::from_ref(&anchor));
            assert!(!old.is_empty());
            assert_eq!(old[0]["sourceOrigin"]["remoteRevision"], "1");
            source(&conn, "latest", "p", &["Context parallel corpus updated."]);
            let latest = memory(
                &conn,
                "latest-m",
                "p",
                "latest",
                "Context parallel corpus updated.",
            );
            remote(&conn, "latest", "document", "2", "2026-10-26T08:00:00Z");
            conn.execute(
                "UPDATE sources SET status=? WHERE id='latest'",
                [latest_state],
            )
            .unwrap();
            let result = passages(&conn, &[anchor, latest]);
            assert!(result.iter().all(|v| v["sourceId"] == "latest"));
            assert_eq!(result.len(), usize::from(latest_state == "ready"));
            assert_eq!(
                validate(&conn, &old[0]).unwrap_err().code,
                "QA_CONTEXT_STALE"
            );
            for reference in &result {
                validate(&conn, reference).unwrap();
            }
        }
    }

    #[test]
    fn remote_version_order_has_stable_ties_and_does_not_cross_project_or_document() {
        let (conn, anchor) = fixture();
        remote(&conn, "s", "document", "1", "2026-10-25T08:00:00Z");
        source(
            &conn,
            "unrelated",
            "p",
            &["Context parallel corpus unrelated."],
        );
        remote(
            &conn,
            "unrelated",
            "another-document",
            "99",
            "2026-10-26T08:00:00Z",
        );
        source(
            &conn,
            "outside",
            "other",
            &["Context parallel corpus outside."],
        );
        remote(&conn, "outside", "document", "99", "2026-10-26T08:00:00Z");
        let before = passages(&conn, std::slice::from_ref(&anchor));
        assert!(!before.is_empty());
        source(&conn, "tie", "p", &["Context parallel corpus tie."]);
        let tie = memory(&conn, "tie-m", "p", "tie", "Context parallel corpus tie.");
        remote(&conn, "tie", "document", "2", "2026-10-25T08:00:00Z");
        let result = passages(&conn, &[anchor, tie]);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0]["sourceId"], "tie");
        let current = &result[0];
        conn.execute(
            "UPDATE source_origins SET remote_revision='3' WHERE source_id='tie'",
            [],
        )
        .unwrap();
        assert_eq!(
            validate(&conn, current).unwrap_err().code,
            "QA_CONTEXT_STALE"
        );
    }

    #[test]
    fn validation_rejects_forged_reference_fields_and_every_source_identity_change() {
        let (conn, anchor) = fixture();
        let reference = passages(&conn, &[anchor]).remove(0);
        for field in [
            "id",
            "kind",
            "projectId",
            "sourceId",
            "segmentId",
            "sourceVersionId",
            "locator",
            "content",
            "contentHash",
            "sourceHash",
            "sourceTitle",
            "title",
            "evidenceLabel",
            "asOfDate",
        ] {
            let mut forged = reference.clone();
            forged[field] = json!("forged");
            assert_eq!(
                validate(&conn, &forged).unwrap_err().code,
                "QA_CONTEXT_STALE",
                "{field}"
            );
        }
        for (field, value) in [
            ("ordinal", json!(999)),
            ("memoryId", json!("m")),
            ("anchorMemoryIds", json!([])),
            ("anchorMemoryIds", json!(["m", "m"])),
            ("anchorMemoryIds", json!(["unknown"])),
            ("evidence", json!([])),
            ("sourceOrigin", json!({"remoteRevision":"fake"})),
        ] {
            let mut forged = reference.clone();
            forged[field] = value;
            assert!(validate(&conn, &forged).is_err(), "{field}");
        }
        for sql in [
            "UPDATE sources SET sha256='changed' WHERE id='s'",
            "UPDATE sources SET title='changed' WHERE id='s'",
            "UPDATE sources SET status='failed' WHERE id='s'",
            "UPDATE segments SET text='changed' WHERE source_id='s'",
            "UPDATE segments SET source_version_id='s:v2' WHERE source_id='s'",
            "UPDATE segments SET locator='changed' WHERE source_id='s'",
            "UPDATE segments SET ordinal=ordinal+100 WHERE source_id='s'",
            "UPDATE memories SET content='changed' WHERE id='m'",
        ] {
            conn.execute_batch("SAVEPOINT mutation").unwrap();
            conn.execute(sql, []).unwrap();
            assert_eq!(
                validate(&conn, &reference).unwrap_err().code,
                "QA_CONTEXT_STALE",
                "{sql}"
            );
            conn.execute_batch("ROLLBACK TO mutation; RELEASE mutation")
                .unwrap();
        }
    }

    #[test]
    fn chosen_facts_keep_full_context_when_query_words_only_match_introductions() {
        let conn = database();
        let bodies = [
            "This overview introduces the document's contributions.",
            "The overview covers four earlier components.",
            "The Atlas component performs lookup. It also verifies returned values against the original record.",
            "The Birch component monitors updates. It records an audit trail for every changed entry.",
            "The Cedar component repairs malformed input. It preserves the rejected input alongside the corrected record.",
            "The Delta component routes requests. It checks the destination before releasing any content.",
            "An overview of the overview is provided here.",
            "This overview discusses the scope of our overview.",
            "Our overview is the first such overview.",
            "The overview concludes with future overview work.",
            "An unrelated appendix describes a calendar widget.",
        ];
        source(&conn, "s", "p", &bodies);
        let mut anchors = Vec::new();
        for (number, segment) in [0, 1, 2, 2, 3, 3, 4, 4, 5, 5].into_iter().enumerate() {
            let id = format!("m{number}");
            let content = bodies[segment].split('.').next().unwrap();
            anchors.push(memory(&conn, &id, "p", "s", content));
            conn.execute(
                "UPDATE revision_evidence SET segment_id=? WHERE revision_id=?",
                params![format!("s:{segment}"), format!("{id}:r1")],
            )
            .unwrap();
        }
        let before = conn.total_changes();
        let result = retrieve(
            &conn,
            Some("p"),
            &Query::new("What is the overview?"),
            DATE,
            &anchors,
        )
        .unwrap();
        for (segment, body) in bodies.iter().enumerate().take(6) {
            let selected = result
                .iter()
                .find(|r| r["segmentId"] == format!("s:{segment}"))
                .unwrap_or_else(|| {
                    panic!("selected fact lost its whole source paragraph {segment}")
                });
            assert_eq!(selected["content"], *body);
            validate(&conn, selected).unwrap();
        }
        assert_eq!(result.len(), MAX_PASSAGES);
        assert!(result
            .iter()
            .skip(6)
            .all(|r| (6..10).any(|i| r["segmentId"] == format!("s:{i}"))));
        assert!(result.iter().all(|r| r["segmentId"] != "s:10"));
        assert_eq!(
            result
                .iter()
                .map(|r| r["id"].as_str().unwrap())
                .collect::<HashSet<_>>()
                .len(),
            result.len()
        );
        assert_eq!(conn.total_changes(), before);
    }

    #[test]
    fn multi_evidence_anchor_cannot_take_all_reading_slots_before_other_chosen_facts() {
        let conn = database();
        let bodies = [
            "Alpha behavior.",
            "Alpha history.",
            "Alpha detail.",
            "Alpha extension.",
            "Alpha example.",
            "Alpha conclusion.",
            "Beta behavior. Its independent condition remains attached.",
            "Gamma behavior. Its restriction must be read together.",
            "Overview introduction.",
        ];
        source(&conn, "s", "p", &bodies);
        let alpha = memory(&conn, "alpha", "p", "s", "Alpha behavior.");
        for segment in 1..6 {
            conn.execute(
                "INSERT INTO revision_evidence VALUES('alpha:r1',?)",
                [format!("s:{segment}")],
            )
            .unwrap();
        }
        let beta = memory(&conn, "beta", "p", "s", "Beta behavior.");
        conn.execute(
            "UPDATE revision_evidence SET segment_id='s:6' WHERE revision_id='beta:r1'",
            [],
        )
        .unwrap();
        let gamma = memory(&conn, "gamma", "p", "s", "Gamma behavior.");
        conn.execute(
            "UPDATE revision_evidence SET segment_id='s:7' WHERE revision_id='gamma:r1'",
            [],
        )
        .unwrap();
        let result = retrieve(
            &conn,
            Some("p"),
            &Query::new("overview"),
            DATE,
            &[alpha.clone(), alpha, beta, gamma],
        )
        .unwrap();
        assert!(result.iter().take(3).any(|r| r["segmentId"] == "s:6"));
        assert!(result.iter().take(3).any(|r| r["segmentId"] == "s:7"));
        assert!(result.iter().any(|r| r["segmentId"] == "s:8"));
        assert!(result.len() <= MAX_PASSAGES);
    }

    #[test]
    fn reading_context_leaves_char_capacity_for_direct_matches_and_never_truncates() {
        let conn = database();
        let mut bodies = (0..6)
            .map(|index| format!("Component {index} condition. {}", "界".repeat(5_800)))
            .collect::<Vec<_>>();
        bodies.extend(
            (0..2).map(|index| format!("Overview direct match {index}. {}", "文".repeat(2_800))),
        );
        source(
            &conn,
            "s",
            "p",
            &bodies.iter().map(String::as_str).collect::<Vec<_>>(),
        );
        let mut anchors = Vec::new();
        for index in 0..6 {
            let id = format!("m{index}");
            anchors.push(memory(
                &conn,
                &id,
                "p",
                "s",
                &format!("Component {index} condition."),
            ));
            conn.execute(
                "UPDATE revision_evidence SET segment_id=? WHERE revision_id=?",
                params![format!("s:{index}"), format!("{id}:r1")],
            )
            .unwrap();
        }
        let result = retrieve(&conn, Some("p"), &Query::new("overview"), DATE, &anchors).unwrap();
        assert_eq!(result.len(), 5);
        assert!(result.iter().any(|r| r["segmentId"] == "s:6"));
        assert!(result.iter().any(|r| r["segmentId"] == "s:7"));
        assert!(
            result
                .iter()
                .map(|r| r["content"].as_str().unwrap().chars().count())
                .sum::<usize>()
                <= MAX_TOTAL_CHARS
        );
        assert!(result
            .iter()
            .all(|r| bodies.iter().any(|body| r["content"] == *body)));
    }

    #[test]
    fn limits_preserve_whole_unicode_segments_without_silent_truncation() {
        let conn = database();
        let body = format!("context {}", "语境".repeat(1_495));
        let oversized = format!("context {}", "境".repeat(MAX_PASSAGE_CHARS));
        let mut bodies = vec![body.as_str(); 12];
        bodies.push(&oversized);
        source(&conn, "s", "p", &bodies);
        let anchor = memory(&conn, "m", "p", "s", "context");
        let result = passages(&conn, &[anchor]);
        assert_eq!(result.len(), MAX_PASSAGES);
        assert!(result
            .iter()
            .all(|v| v["content"] == body && v["segmentId"] != "s:12"));
        assert!(
            result
                .iter()
                .map(|v| v["content"].as_str().unwrap().chars().count())
                .sum::<usize>()
                <= MAX_TOTAL_CHARS
        );
        for reference in &result {
            validate(&conn, reference).unwrap();
        }
    }

    #[test]
    fn retention_review_cannot_be_bypassed_through_source_passages() {
        let (conn, anchor) = fixture();
        crate::retention::save_revision(
            &conn,
            "m:r1",
            &json!({"layer":"working","reason":"工作状态","reviewAfter":"2000-01-01"}),
        )
        .unwrap();
        assert!(passages(&conn, &[anchor]).is_empty());
    }
}
