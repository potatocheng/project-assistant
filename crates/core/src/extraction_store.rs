//! Durable extraction checkpoints and reviewable drafts. These tables are never
//! consulted by retrieval: only explicit confirmation creates formal memory.
use crate::{ai, db::Database, hash, id, now, required, AppError, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

pub(crate) const MIGRATION: &str = "
CREATE TABLE extraction_batches(id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES jobs(id),snapshot_key TEXT NOT NULL,batch_key TEXT NOT NULL,checkpoint TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE INDEX extraction_batch_snapshot ON extraction_batches(job_id,snapshot_key,batch_key);
CREATE TABLE extraction_budget(job_id TEXT NOT NULL,snapshot_key TEXT NOT NULL,budget TEXT NOT NULL,PRIMARY KEY(job_id,snapshot_key));
CREATE TABLE extraction_drafts(id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES jobs(id),snapshot_key TEXT NOT NULL,batch_key TEXT NOT NULL,candidate_index INTEGER NOT NULL,candidate TEXT NOT NULL,facets TEXT NOT NULL,issues TEXT NOT NULL,status TEXT NOT NULL,proposal_id TEXT REFERENCES proposals(id),review_reason TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,reviewed_at TEXT,UNIQUE(job_id,snapshot_key,batch_key,candidate_index));
PRAGMA user_version=10;";

fn snapshot(conn: &Connection, job: &str) -> Result<String> {
    let parts: (String, String, String, String) = conn.query_row(
        "SELECT source_hash,input_hash,config_revision,prompt_version FROM jobs WHERE id=?",
        [job],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )?;
    Ok(hash(json!(parts).to_string().as_bytes()))
}

pub(crate) fn resume(conn: &Connection, job: &str) -> Result<Vec<ai::ExtractionCheckpoint>> {
    let snapshot = snapshot(conn, job)?;
    let mut stmt = conn.prepare("SELECT checkpoint FROM extraction_batches b WHERE job_id=? AND snapshot_key=? AND rowid=(SELECT max(n.rowid) FROM extraction_batches n WHERE n.job_id=b.job_id AND n.snapshot_key=b.snapshot_key AND n.batch_key=b.batch_key) ORDER BY rowid")?;
    let rows = stmt.query_map(params![job, snapshot], |r| r.get::<_, String>(0))?;
    let mut checkpoints: Vec<ai::ExtractionCheckpoint> = rows
        .map(|r| serde_json::from_str(&r?).map_err(|_| AppError::new("DATABASE", "提取检查点损坏")))
        .collect::<Result<_>>()?;
    let budget: Option<String> = conn
        .query_row(
            "SELECT budget FROM extraction_budget WHERE job_id=? AND snapshot_key=?",
            params![job, snapshot],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(raw) = budget {
        let budget: ai::ExtractionBudget =
            serde_json::from_str(&raw).map_err(|_| AppError::new("DATABASE", "提取预算损坏"))?;
        // Budget-only state cannot be mistaken for a cached model result. It
        // survives restoring an earlier archive without restoring lost facts.
        if let Some(existing) = checkpoints
            .iter_mut()
            .max_by_key(|c| (c.budget.requests, c.budget.elapsed_ms))
        {
            existing.budget = merge_budget(&existing.budget, &budget);
        } else {
            checkpoints.push(ai::ExtractionCheckpoint {
                key: "__budget_only".into(),
                parent_key: None,
                status: "budget".into(),
                input_hash: String::new(),
                candidates: vec![],
                task_candidates: vec![],
                raw_output: None,
                discarded_count: 0,
                usage: None,
                error_code: None,
                budget,
                completed_batches: 0,
                total_batches: 0,
            });
        }
    }
    Ok(checkpoints)
}

fn merge_budget(a: &ai::ExtractionBudget, b: &ai::ExtractionBudget) -> ai::ExtractionBudget {
    if (a.requests, a.elapsed_ms) > (b.requests, b.elapsed_ms) {
        a.clone()
    } else {
        b.clone()
    }
}

pub(crate) fn budget_records(
    conn: &Connection,
) -> Result<Vec<(String, String, ai::ExtractionBudget)>> {
    let mut stmt = conn.prepare("SELECT job_id,snapshot_key,budget FROM extraction_budget")?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
        ))
    })?;
    rows.map(|row| {
        let (job, snapshot, raw) = row?;
        Ok((
            job,
            snapshot,
            serde_json::from_str(&raw).map_err(|_| AppError::new("DATABASE", "提取预算损坏"))?,
        ))
    })
    .collect()
}

pub(crate) fn preserve_budgets(
    conn: &Connection,
    records: &[(String, String, ai::ExtractionBudget)],
) -> Result<()> {
    for (job, snapshot, budget) in records {
        let old: Option<String> = conn
            .query_row(
                "SELECT budget FROM extraction_budget WHERE job_id=? AND snapshot_key=?",
                params![job, snapshot],
                |r| r.get(0),
            )
            .optional()?;
        let budget = if let Some(raw) = old {
            merge_budget(
                &serde_json::from_str(&raw)
                    .map_err(|_| AppError::new("DATABASE", "提取预算损坏"))?,
                budget,
            )
        } else {
            budget.clone()
        };
        conn.execute("INSERT INTO extraction_budget VALUES(?,?,?) ON CONFLICT(job_id,snapshot_key) DO UPDATE SET budget=excluded.budget",params![job,snapshot,json!(budget).to_string()])?;
    }
    Ok(())
}

fn source_scope(conn: &Connection, job: &str) -> Result<(String, String)> {
    Ok(conn.query_row("SELECT j.source_id,s.project_id FROM jobs j JOIN sources s ON s.id=j.source_id WHERE j.id=?", [job], |r| Ok((r.get(0)?, r.get(1)?)))?)
}

fn supported(
    conn: &Connection,
    source: &str,
    project: &str,
    candidate: &ai::Candidate,
) -> Result<bool> {
    if !matches!(
        candidate.kind.as_str(),
        "fact" | "decision" | "requirement" | "risk"
    ) || candidate.content.trim().is_empty()
        || crate::db::validate_content(&candidate.content).is_err()
        || candidate.evidence.is_empty()
    {
        return Ok(false);
    }
    for evidence in &candidate.evidence {
        let text: Option<String> = conn.query_row("SELECT g.text FROM segments g JOIN sources s ON s.id=g.source_id WHERE g.id=? AND s.id=? AND s.project_id=? AND s.status='ready'", params![evidence.segment_id,source,project], |r| r.get(0)).optional()?;
        if evidence.quote.trim().is_empty()
            || !text.is_some_and(|text| text.contains(&evidence.quote))
        {
            return Ok(false);
        }
    }
    Ok(true)
}

fn insert_proposal(
    conn: &Connection,
    job: &str,
    candidate: &ai::Candidate,
    facets: &Value,
) -> Result<String> {
    let (source, project) = source_scope(conn, job)?;
    if !supported(conn, &source, &project, candidate)? {
        return Err(AppError::new("GROUNDING_FAILED", "候选引文无效"));
    }
    let quotes: Vec<Value> = candidate
        .evidence
        .iter()
        .map(|e| json!({"segmentId":e.segment_id,"quote":e.quote}))
        .collect();
    let mut segments: Vec<String> = candidate
        .evidence
        .iter()
        .map(|e| e.segment_id.clone())
        .collect();
    segments.sort();
    segments.dedup();
    let normalized = candidate
        .content
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let fingerprint = hash(
        json!([
            source,
            candidate.kind,
            normalized,
            crate::memory_facts::identity(facets),
            candidate.retention.layer
        ])
        .to_string()
        .as_bytes(),
    );
    if let Some(existing) = conn
        .query_row(
            "SELECT id FROM proposals WHERE fingerprint=?",
            [&fingerprint],
            |r| r.get::<_, String>(0),
        )
        .optional()?
    {
        // Checkpoints are saved before the extractor combines duplicate claims.
        // Retain their additional quotes here, but never change a proposal once
        // a person has edited/reviewed it or a different snapshot has claimed it.
        let current_snapshot = snapshot(conn, job)?;
        let mutable: bool = conn.query_row(
            "SELECT status='pending' AND edited=0 AND extraction_job_id=? AND EXISTS(SELECT 1 FROM extraction_drafts d WHERE d.proposal_id=p.id AND d.job_id=? AND d.snapshot_key=?) AND NOT EXISTS(SELECT 1 FROM extraction_drafts d WHERE d.proposal_id=p.id AND (d.status<>'ready' OR d.job_id<>? OR d.snapshot_key<>?)) FROM proposals p WHERE id=?",
            params![job,job,current_snapshot,job,current_snapshot,existing], |r| r.get(0),
        )?;
        if mutable {
            for segment in &segments {
                conn.execute(
                    "INSERT OR IGNORE INTO proposal_evidence VALUES(?,?)",
                    params![existing, segment],
                )?;
            }
            let raw: String = conn.query_row(
                "SELECT quotes FROM proposals WHERE id=?",
                [&existing],
                |r| r.get(0),
            )?;
            let mut retained: Vec<Value> = serde_json::from_str(&raw)
                .map_err(|_| AppError::new("DATABASE", "候选原文引文损坏"))?;
            let previous_count = retained.len();
            for quote in quotes {
                if !retained.contains(&quote) {
                    retained.push(quote);
                }
            }
            if retained.len() != previous_count {
                conn.execute(
                    "UPDATE proposals SET quotes=? WHERE id=?",
                    params![json!(retained).to_string(), existing],
                )?;
            }
        }
        return Ok(existing);
    }
    let proposal = id();
    conn.execute("INSERT INTO proposals(id,project_id,source_id,kind,content,status,created_at,memory_id,origin,provider,model,prompt_version,extraction_job_id,quotes,edited,fingerprint) SELECT ?,?,?,?,?,'pending',?,NULL,'ai',provider,model,prompt_version,?,?,0,? FROM jobs WHERE id=?", params![proposal,project,source,candidate.kind,candidate.content,now(),job,json!(quotes).to_string(),fingerprint,job])?;
    conn.execute(
        "INSERT INTO proposal_retention VALUES(?,?)",
        params![
            proposal,
            crate::retention::checked(&json!(candidate.retention))?.to_string()
        ],
    )?;
    conn.execute(
        "INSERT INTO proposal_facets VALUES(?,?)",
        params![proposal, facets.to_string()],
    )?;
    for segment in segments {
        conn.execute(
            "INSERT INTO proposal_evidence VALUES(?,?)",
            params![proposal, segment],
        )?;
    }
    Ok(proposal)
}

pub(crate) fn persist(
    db: &mut Database,
    job: &str,
    epoch: u64,
    generation: i64,
    checkpoint: &ai::ExtractionCheckpoint,
) -> Result<bool> {
    if epoch != db.epoch || db.root.join("restore-journal.json").exists() {
        return Ok(false);
    }
    let active: bool = db.conn.query_row("SELECT EXISTS(SELECT 1 FROM jobs j JOIN sources s ON s.id=j.source_id WHERE j.id=? AND j.kind='extract' AND j.status='running' AND j.generation=? AND j.source_hash=s.sha256 AND s.status='ready')", params![job,generation], |r| r.get(0))?;
    if !active {
        return Ok(false);
    }
    let snapshot = snapshot(&db.conn, job)?;
    let (source, project) = source_scope(&db.conn, job)?;
    let tx = db.conn.transaction()?;
    preserve_budgets(
        &tx,
        &[(job.into(), snapshot.clone(), checkpoint.budget.clone())],
    )?;
    tx.execute(
        "INSERT INTO extraction_batches VALUES(?,?,?,?,?,?)",
        params![
            id(),
            job,
            snapshot,
            checkpoint.key,
            serde_json::to_string(checkpoint)
                .map_err(|_| AppError::new("SERIALIZATION", "提取检查点序列化失败"))?,
            now()
        ],
    )?;
    if matches!(checkpoint.status.as_str(), "succeeded" | "partitioned") {
        for (index, candidate) in checkpoint.candidates.iter().enumerate() {
            let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM extraction_drafts WHERE job_id=? AND snapshot_key=? AND batch_key=? AND candidate_index=?)", params![job,snapshot,checkpoint.key,index as i64], |r| r.get(0))?;
            if exists {
                continue;
            }
            let quotes = candidate
                .evidence
                .iter()
                .map(|e| e.quote.as_str())
                .collect::<Vec<_>>()
                .join("\n");
            let (facets, mut issues, needs_review) = crate::memory_facts::extraction_check(
                &candidate.facets,
                &candidate.content,
                &quotes,
            );
            let coverage = checkpoint.raw_output.as_ref().map(|v| &v["_coverage"]);
            let context_issues = coverage.and_then(|v| {
                if v["version"] == "context-plan-v2-per-candidate" {
                    v["candidateIssues"][index].as_array()
                } else {
                    v["issues"].as_array()
                }
            });
            if coverage.is_some_and(|v| v["version"] == "context-plan-v2-per-candidate")
                && context_issues.is_none()
            {
                return Err(AppError::new(
                    "MODEL_CHECKPOINT",
                    "逐条审核结果与候选不匹配",
                ));
            }
            if let Some(context_issues) = context_issues {
                issues
                    .as_array_mut()
                    .unwrap()
                    .extend(context_issues.iter().cloned());
            }
            let policy = crate::retention::checked(&json!(candidate.retention));
            if policy.is_err() || candidate.retention.layer == "clarify" {
                issues.as_array_mut().unwrap().push(json!({"field":"retention","reason":if policy.is_err(){"保留策略格式无效"}else{&candidate.retention.reason},"severity":"retention"}));
            }
            let needs_review = needs_review
                || context_issues.is_some_and(|v| !v.is_empty())
                || policy.is_err()
                || candidate.retention.layer == "clarify";
            let valid = supported(&tx, &source, &project, candidate)?;
            let (status, proposal) = if !valid {
                issues.as_array_mut().unwrap().push(
                    json!({"field":"evidence","reason":"正文或原文引文无效","severity":"fact"}),
                );
                ("rejected", None)
            } else if needs_review {
                ("needs_review", None)
            } else if candidate.retention.layer == "archive" {
                ("retained", None)
            } else {
                (
                    "ready",
                    Some(insert_proposal(&tx, job, candidate, &facets)?),
                )
            };
            tx.execute("INSERT INTO extraction_drafts(id,job_id,snapshot_key,batch_key,candidate_index,candidate,facets,issues,status,proposal_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)", params![id(),job,snapshot,checkpoint.key,index as i64,json!(candidate).to_string(),facets.to_string(),issues.to_string(),status,proposal,now()])?;
        }
        let (tasks, _) = crate::tasks::ground_candidates(
            &tx,
            &source,
            &project,
            checkpoint.task_candidates.clone(),
        )?;
        let (provider, model, prompt): (String, String, String) = tx.query_row(
            "SELECT provider,model,prompt_version FROM jobs WHERE id=?",
            [job],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
        crate::tasks::insert_candidates(
            &tx,
            crate::tasks::AiOrigin {
                source: &source,
                project: &project,
                job,
                provider: &provider,
                model: &model,
                prompt: &prompt,
            },
            tasks,
        )?;
    }
    tx.execute("UPDATE jobs SET completed_batches=?,total_batches=?,candidate_count=(SELECT count(*) FROM proposals WHERE extraction_job_id=?),task_candidate_count=(SELECT count(*) FROM task_proposals WHERE extraction_job_id=?),stage=?,updated_at=? WHERE id=?", params![checkpoint.completed_batches as i64,checkpoint.total_batches as i64,job,job,format!("已保存 {}/{} 批；候选尚待确认",checkpoint.completed_batches,checkpoint.total_batches),now(),job])?;
    tx.commit()?;
    Ok(true)
}

pub(crate) fn state(conn: &Connection) -> Result<Value> {
    let mut stmt = conn.prepare("SELECT d.id,d.job_id,j.source_id,s.project_id,d.batch_key,d.candidate,d.facets,d.issues,d.status,d.proposal_id,d.review_reason,d.created_at,d.reviewed_at FROM extraction_drafts d JOIN jobs j ON j.id=d.job_id JOIN sources s ON s.id=j.source_id ORDER BY d.rowid")?;
    let values = stmt.query_map([], |r| Ok(json!({"id":r.get::<_,String>(0)?,"jobId":r.get::<_,String>(1)?,"sourceId":r.get::<_,String>(2)?,"projectId":r.get::<_,String>(3)?,"batchKey":r.get::<_,String>(4)?,"candidate":parse(r.get(5)?)?,"facets":parse(r.get(6)?)?,"issues":parse(r.get(7)?)?,"status":r.get::<_,String>(8)?,"proposalId":r.get::<_,Option<String>>(9)?,"reviewReason":r.get::<_,String>(10)?,"createdAt":r.get::<_,String>(11)?,"reviewedAt":r.get::<_,Option<String>>(12)?})))?.collect::<std::result::Result<Vec<_>,_>>()?;
    Ok(json!(values))
}

pub(crate) fn batch_state(conn: &Connection) -> Result<Value> {
    let mut stmt=conn.prepare("SELECT b.job_id,j.source_id,b.batch_key,b.checkpoint,(SELECT count(*) FROM extraction_batches e WHERE e.job_id=b.job_id AND e.snapshot_key=b.snapshot_key AND e.batch_key=b.batch_key) FROM extraction_batches b JOIN jobs j ON j.id=b.job_id WHERE b.rowid=(SELECT max(n.rowid) FROM extraction_batches n WHERE n.job_id=b.job_id AND n.snapshot_key=b.snapshot_key AND n.batch_key=b.batch_key) ORDER BY b.rowid")?;
    let mut values = Vec::new();
    for row in stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, i64>(4)?,
        ))
    })? {
        let (job, source, key, raw, count) = row?;
        let checkpoint: ai::ExtractionCheckpoint =
            serde_json::from_str(&raw).map_err(|_| AppError::new("DATABASE", "提取检查点损坏"))?;
        values.push(json!({"jobId":job,"sourceId":source,"batchKey":key,"parentKey":checkpoint.parent_key,"status":checkpoint.status,"coverage":checkpoint.raw_output.as_ref().map(|v| &v["_coverage"]),"inputHash":checkpoint.input_hash,"discardedCount":checkpoint.discarded_count,"usage":checkpoint.usage,"errorCode":checkpoint.error_code,"budget":checkpoint.budget,"completedBatches":checkpoint.completed_batches,"totalBatches":checkpoint.total_batches,"checkpointCount":count}));
    }
    Ok(json!(values))
}

fn parse(raw: String) -> rusqlite::Result<Value> {
    serde_json::from_str(&raw).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })
}

pub(crate) fn guard_proposal(conn: &Connection, proposal: &str) -> Result<()> {
    let stale: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM extraction_drafts d JOIN jobs j ON j.id=d.job_id JOIN sources s ON s.id=j.source_id WHERE d.proposal_id=? AND (d.status NOT IN ('ready','reviewed') OR j.source_hash<>s.sha256))", [proposal], |r| r.get(0))?;
    if stale {
        return Err(AppError::new(
            "EXTRACTION_REVIEW_REQUIRED",
            "候选范围尚未审核或资料版本已变化",
        ));
    }
    Ok(())
}

pub(crate) fn review(db: &mut Database, p: &Value) -> Result<Value> {
    let draft = required(p, "draftId")?;
    let reason = required(p, "reason")?;
    if reason.chars().count() > 1000 {
        return Err(AppError::new("VALIDATION", "审核原因过长"));
    }
    let (job, old_snapshot, raw, status): (String, String, String, String) = db
        .conn
        .query_row(
            "SELECT job_id,snapshot_key,candidate,status FROM extraction_drafts WHERE id=?",
            [draft],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?
        .ok_or_else(|| AppError::new("NOT_FOUND", "提取草稿不存在"))?;
    if !matches!(status.as_str(), "needs_review" | "retained") {
        return Err(AppError::new("CONFLICT", "仅能审核待审核的提取草稿"));
    }
    if old_snapshot != snapshot(&db.conn, &job)? {
        return Err(AppError::new("SOURCE_CHANGED", "草稿已过期，请重新提取"));
    }
    let (source, project) = source_scope(&db.conn, &job)?;
    let current: bool = db.conn.query_row(
        "SELECT j.source_hash=s.sha256 FROM jobs j JOIN sources s ON s.id=j.source_id WHERE j.id=?",
        [&job],
        |r| r.get(0),
    )?;
    if !current {
        return Err(AppError::new(
            "SOURCE_CHANGED",
            "资料版本已变化，请重新提取",
        ));
    }
    let tx = db.conn.transaction()?;
    if p["action"] == "reject" {
        tx.execute("UPDATE extraction_drafts SET status='rejected',review_reason=?,reviewed_at=? WHERE id=?", params![reason,now(),draft])?;
    } else if p["action"] == "approve" {
        let mut candidate: ai::Candidate =
            serde_json::from_str(&raw).map_err(|_| AppError::new("DATABASE", "草稿损坏"))?;
        let original = json!(candidate.facets);
        candidate.content = required(p, "content")?.to_owned();
        let value = p
            .get("facets")
            .ok_or_else(|| AppError::new("VALIDATION", "审核时须明确提交完整组织字段"))?;
        for field in ["entity", "role", "validFrom", "validUntil"] {
            if original[field].as_str().is_some_and(|v| !v.is_empty())
                && value[field].as_str().is_none_or(|v| v.is_empty())
            {
                return Err(AppError::new(
                    "EXTRACTION_REVIEW_REQUIRED",
                    "不能通过清空原有适用范围来批准草稿；请修正为有依据的字段或忽略草稿",
                ));
            }
        }
        if value["conditions"].as_array().map_or(0, Vec::len)
            < original["conditions"].as_array().map_or(0, Vec::len)
        {
            return Err(AppError::new(
                "EXTRACTION_REVIEW_REQUIRED",
                "不能通过删除适用条件来批准草稿；请逐条修正或忽略草稿",
            ));
        }
        candidate.facets = serde_json::from_value(value.clone())
            .map_err(|_| AppError::new("VALIDATION", "组织字段格式无效"))?;
        let quotes = candidate
            .evidence
            .iter()
            .map(|e| e.quote.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        let facets = crate::memory_facts::checked(value, &candidate.content)?;
        crate::memory_facts::checked(value, &quotes)?;
        if !supported(&tx, &source, &project, &candidate)? {
            return Err(AppError::new("GROUNDING_FAILED", "候选引文无效"));
        }
        if let Some(policy) = p.get("retention") {
            let policy = crate::retention::checked(policy)?;
            candidate.retention = crate::retention::Retention {
                layer: policy["layer"].as_str().unwrap().into(),
                reason: policy["reason"].as_str().unwrap().into(),
            };
        }
        if !matches!(candidate.retention.layer.as_str(), "durable" | "working") {
            return Err(AppError::new(
                "VALIDATION",
                "批准前请选择长期记忆或工作状态",
            ));
        }
        let proposal = insert_proposal(&tx, &job, &candidate, &facets)?;
        tx.execute("UPDATE extraction_drafts SET status='reviewed',facets=?,proposal_id=?,review_reason=?,reviewed_at=? WHERE id=?", params![facets.to_string(),proposal,reason,now(),draft])?;
        tx.execute("UPDATE jobs SET candidate_count=(SELECT count(*) FROM proposals WHERE extraction_job_id=?) WHERE id=?", params![job,job])?;
    } else {
        return Err(AppError::new("VALIDATION", "审核操作须为approve或reject"));
    }
    tx.commit()?;
    Ok(json!({"draftId":draft,"action":p["action"]}))
}

pub(crate) fn validate_backup(conn: &Connection) -> Result<()> {
    budget_records(conn).map_err(|_| AppError::new("INVALID_BACKUP", "提取预算台账无效"))?;
    let mut stmt = conn.prepare("SELECT checkpoint,batch_key FROM extraction_batches")?;
    for row in stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
        let (raw, key) = row?;
        let event: ai::ExtractionCheckpoint = serde_json::from_str(&raw)
            .map_err(|_| AppError::new("INVALID_BACKUP", "提取检查点无效"))?;
        if event.key != key
            || ![
                "started",
                "succeeded",
                "failed",
                "split",
                "review_pending",
                "partitioned",
            ]
            .contains(&event.status.as_str())
            || event.completed_batches > event.total_batches
        {
            return Err(AppError::new("INVALID_BACKUP", "提取检查点状态无效"));
        }
    }
    let mut stmt=conn.prepare("SELECT d.candidate,d.facets,d.issues,d.status,d.proposal_id,j.source_id,s.project_id FROM extraction_drafts d JOIN jobs j ON j.id=d.job_id JOIN sources s ON s.id=j.source_id")?;
    for row in stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, Option<String>>(4)?,
            r.get::<_, String>(5)?,
            r.get::<_, String>(6)?,
        ))
    })? {
        let (raw, facets, issues, status, proposal, source, project) = row?;
        let candidate: ai::Candidate = serde_json::from_str(&raw)
            .map_err(|_| AppError::new("INVALID_BACKUP", "提取草稿无效"))?;
        let facets: Value = serde_json::from_str(&facets)
            .map_err(|_| AppError::new("INVALID_BACKUP", "提取草稿字段无效"))?;
        if !serde_json::from_str::<Value>(&issues).is_ok_and(|v| v.is_array())
            || !["ready", "needs_review", "rejected", "reviewed", "retained"]
                .contains(&status.as_str())
            || (matches!(status.as_str(), "ready" | "reviewed") != proposal.is_some())
        {
            return Err(AppError::new("INVALID_BACKUP", "提取草稿状态无效"));
        }
        // Invalid raw facets are intentionally retained for review and must not
        // invalidate a backup. Only releasable proposals use validated facets.
        if status == "ready"
            && (crate::memory_facts::checked(&facets, &candidate.content).is_err()
                || !supported(conn, &source, &project, &candidate)?)
        {
            return Err(AppError::new("INVALID_BACKUP", "可确认草稿缺少有效依据"));
        }
        if let Some(proposal) = proposal {
            let body: String = conn
                .query_row(
                    "SELECT content FROM proposals WHERE id=? AND source_id=? AND project_id=?",
                    params![proposal, source, project],
                    |r| r.get(0),
                )
                .map_err(|_| AppError::new("INVALID_BACKUP", "提取草稿关联候选跨项目或资料"))?;
            if crate::memory_facts::checked(&facets, &body).is_err()
                || crate::memory_facts::identity(&crate::memory_facts::proposal(conn, &proposal)?)
                    != crate::memory_facts::identity(&facets)
            {
                let edited: bool =
                    conn.query_row("SELECT edited FROM proposals WHERE id=?", [proposal], |r| {
                        r.get(0)
                    })?;
                if !edited {
                    return Err(AppError::new(
                        "INVALID_BACKUP",
                        "提取草稿与审核后候选组织字段不一致",
                    ));
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{parse::ParsedSegment, Request};
    use base64::Engine as _;

    const TEXT: &str = "甲项目仅在紧急条件下由李思负责。乙项目常规由王芳负责。";
    fn call(db: &mut Database, command: &str, payload: Value) -> Value {
        db.execute(Request {
            command: command.into(),
            payload,
        })
        .unwrap()
    }
    fn setup() -> (
        tempfile::TempDir,
        Database,
        String,
        String,
        crate::db::AiTask,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let mut db = Database::open(dir.path().into()).unwrap();
        call(
            &mut db,
            "save_ai_settings",
            json!({"provider":"ollama","baseUrl":"http://127.0.0.1:11434","model":"checkpoint-fixture","outputFormat":"json_schema","timeoutSeconds":5,"autoExtract":false,"remoteConsent":false}),
        );
        let project = call(&mut db, "create_project", json!({"name":"提取草稿"}));
        let imported = call(
            &mut db,
            "import_text",
            json!({"projectId":project["id"],"title":"原文","text":TEXT}),
        );
        let parse = imported["jobId"].as_str().unwrap();
        let task = db.claim(parse, db.epoch).unwrap().unwrap();
        db.complete(
            parse,
            db.epoch,
            task.generation,
            Ok(vec![ParsedSegment {
                locator: "第1行".into(),
                text: TEXT.into(),
            }]),
        )
        .unwrap();
        let source = imported["sourceId"].as_str().unwrap().to_owned();
        let job = call(&mut db, "start_extraction", json!({"sourceId":source}))["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let task = db.claim_extract(&job, db.epoch).unwrap().unwrap();
        (dir, db, source, job, task)
    }
    fn event(task: &crate::db::AiTask) -> ai::ExtractionCheckpoint {
        ai::ExtractionCheckpoint {
            key: "leaf-1".into(),
            parent_key: None,
            status: "succeeded".into(),
            input_hash: hash(TEXT.as_bytes()),
            candidates: vec![ai::Candidate {
                retention: Default::default(),
                kind: "fact".into(),
                content: TEXT.into(),
                evidence: vec![ai::CandidateEvidence {
                    segment_id: task.segments[0].id.clone(),
                    quote: TEXT.into(),
                }],
                facets: Default::default(),
            }],
            task_candidates: vec![],
            raw_output: None,
            discarded_count: 0,
            usage: Some(json!({"totalTokens":40})),
            error_code: None,
            budget: ai::ExtractionBudget {
                requests: 1,
                input_tokens: 30,
                output_tokens: 10,
                usage_complete: true,
                ..Default::default()
            },
            completed_batches: 1,
            total_batches: 2,
        }
    }
    fn single_claim(task: &crate::db::AiTask) -> ai::ExtractionCheckpoint {
        let mut checkpoint = event(task);
        checkpoint.candidates[0].content = "甲项目仅在紧急条件下由李思负责。".into();
        checkpoint.candidates[0].evidence[0].quote = checkpoint.candidates[0].content.clone();
        checkpoint.candidates[0].facets.entity = "甲项目".into();
        checkpoint
    }

    #[test]
    fn per_candidate_context_review_survives_overlap_replay_and_backup() {
        let (_dir, mut db, _, job, task) = setup();
        let mut checkpoint = single_claim(&task);
        let mut incomplete = checkpoint.candidates[0].clone();
        incomplete.content = "甲项目由李思负责。".into();
        checkpoint.candidates.push(incomplete);
        checkpoint.raw_output = Some(
            json!({"_coverage":{"version":"context-plan-v2-per-candidate","issues":[{"field":"coverage","reason":"批次饱和"}],"candidateIssues":[[],[{"field":"context","reason":"缺少紧急条件限定","severity":"context"}]]}}),
        );
        let mut parent = checkpoint.clone();
        parent.key = "parent".into();
        parent.status = "partitioned".into();
        persist(&mut db, &job, 0, task.generation, &parent).unwrap();
        assert_eq!(
            call(&mut db, "get_state", json!({}))["extractionDrafts"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        for key in ["first", "first", "overlap"] {
            checkpoint.key = key.into();
            persist(&mut db, &job, 0, task.generation, &checkpoint).unwrap();
        }
        let state = call(&mut db, "get_state", json!({}));
        assert_eq!(state["proposals"].as_array().unwrap().len(), 1);
        let drafts = state["extractionDrafts"].as_array().unwrap();
        assert_eq!(drafts.len(), 6);
        assert_eq!(drafts.iter().filter(|d| d["status"] == "ready").count(), 3);
        assert_eq!(
            drafts
                .iter()
                .filter(|d| d["status"] == "needs_review" && d["proposalId"].is_null())
                .count(),
            3
        );
        assert!(state["memories"].as_array().unwrap().is_empty());
        validate_backup(&db.conn).unwrap();
        let mut malformed = checkpoint;
        malformed.key = "malformed".into();
        malformed.raw_output.as_mut().unwrap()["_coverage"]["candidateIssues"] = json!([[]]);
        assert_eq!(
            persist(&mut db, &job, 0, task.generation, &malformed)
                .unwrap_err()
                .code,
            "MODEL_CHECKPOINT"
        );
        assert_eq!(
            call(&mut db, "get_state", json!({}))["extractionDrafts"],
            state["extractionDrafts"]
        );
    }
    #[test]
    fn context_review_holds_candidates_and_survives_backup_validation() {
        let (_dir, mut db, _, job, task) = setup();
        let mut checkpoint = event(&task);
        checkpoint.status = "review_pending".into();
        checkpoint.raw_output = Some(
            json!({"_coverage":{"issues":[{"field":"context","reason":"后文条件待核对","severity":"context"}]}}),
        );
        assert!(persist(&mut db, &job, 0, task.generation, &checkpoint).unwrap());
        assert!(call(&mut db, "get_state", json!({}))["proposals"]
            .as_array()
            .unwrap()
            .is_empty());
        validate_backup(&db.conn).unwrap();
        checkpoint.key = "review-1".into();
        checkpoint.status = "succeeded".into();
        assert!(persist(&mut db, &job, 0, task.generation, &checkpoint).unwrap());
        let state = call(&mut db, "get_state", json!({}));
        assert!(state["proposals"].as_array().unwrap().is_empty());
        assert_eq!(state["extractionDrafts"][0]["status"], "needs_review");
        validate_backup(&db.conn).unwrap();
    }
    #[test]
    fn partial_success_survives_failure_retry_and_restart_without_duplicate_candidates() {
        let (dir, mut db, _, job, task) = setup();
        let checkpoint = event(&task);
        assert!(persist(&mut db, &job, 0, task.generation, &checkpoint).unwrap());
        assert!(persist(&mut db, &job, 0, task.generation, &checkpoint).unwrap());
        db.complete_extract(
            &job,
            0,
            task.generation,
            Err(AppError::new("MODEL_HTTP", "暂时不可用")),
        )
        .unwrap();
        let before = call(&mut db, "get_state", json!({}));
        assert_eq!(before["proposals"].as_array().unwrap().len(), 1);
        assert!(before["memories"].as_array().unwrap().is_empty());
        let failed = before["jobs"]
            .as_array()
            .unwrap()
            .iter()
            .find(|j| j["id"] == job)
            .unwrap();
        assert_eq!(failed["candidateCount"], 1);
        assert_eq!(failed["status"], "failed");
        call(&mut db, "retry_extraction", json!({"jobId":job}));
        let resumed = db.claim_extract(&job, 0).unwrap().unwrap();
        assert_eq!(resumed.checkpoints.len(), 1);
        assert_eq!(resumed.checkpoints[0].budget.requests, 1);
        assert!(!persist(&mut db, &job, 0, task.generation, &checkpoint).unwrap());
        drop(db);
        let mut db = Database::open(dir.path().into()).unwrap();
        let resumed = db.claim_extract(&job, 0).unwrap().unwrap();
        assert_eq!(resumed.checkpoints.len(), 1);
        let mut done = checkpoint;
        done.total_batches = 1;
        assert!(persist(&mut db, &job, 0, resumed.generation, &done).unwrap());
        db.complete_extract(
            &job,
            0,
            resumed.generation,
            Ok(ai::ExtractionResult {
                candidates: vec![],
                task_candidates: vec![],
                discarded_count: 0,
                batch_count: 1,
            }),
        )
        .unwrap();
        let after = call(&mut db, "get_state", json!({}));
        assert_eq!(after["proposals"].as_array().unwrap().len(), 1);
        assert_eq!(after["extractionDrafts"].as_array().unwrap().len(), 1);
        let succeeded = after["jobs"]
            .as_array()
            .unwrap()
            .iter()
            .find(|j| j["id"] == job)
            .unwrap();
        assert_eq!(succeeded["candidateCount"], 1);
    }
    #[test]
    fn duplicate_claim_quotes_survive_checkpoint_replay_completion_and_restart() {
        let (dir, mut db, _, job, task) = setup();
        let first = single_claim(&task);
        let mut second = first.clone();
        second.key = "leaf-2".into();
        second.candidates[0].evidence[0].quote = TEXT.into();
        second.completed_batches = 2;
        second.budget.requests = 2;
        persist(&mut db, &job, 0, task.generation, &first).unwrap();
        persist(&mut db, &job, 0, task.generation, &second).unwrap();
        persist(&mut db, &job, 0, task.generation, &second).unwrap();
        db.complete_extract(
            &job,
            0,
            task.generation,
            Ok(ai::ExtractionResult {
                candidates: vec![],
                task_candidates: vec![],
                discarded_count: 0,
                batch_count: 2,
            }),
        )
        .unwrap();
        drop(db);
        let mut db = Database::open(dir.path().into()).unwrap();
        let state = call(&mut db, "get_state", json!({}));
        assert_eq!(state["proposals"].as_array().unwrap().len(), 1);
        assert_eq!(
            state["proposals"][0]["quotes"],
            json!([
                {"segmentId":task.segments[0].id,"quote":first.candidates[0].content},
                {"segmentId":task.segments[0].id,"quote":TEXT}
            ])
        );
        assert_eq!(
            state["proposals"][0]["content"],
            first.candidates[0].content
        );
        assert_eq!(state["proposals"][0]["facets"]["entity"], "甲项目");
        assert_eq!(state["extractionDrafts"].as_array().unwrap().len(), 2);
        assert_eq!(
            state["extractionDrafts"][0]["candidate"]["evidence"][0]["quote"],
            first.candidates[0].content
        );
        assert_eq!(
            state["extractionDrafts"][1]["candidate"]["evidence"][0]["quote"],
            TEXT
        );
        assert!(state["memories"].as_array().unwrap().is_empty());
        assert_eq!(
            resume(&db.conn, &job)
                .unwrap()
                .last()
                .unwrap()
                .budget
                .requests,
            2
        );
        validate_backup(&db.conn).unwrap();
        let archive = call(&mut db, "create_backup", json!({}));
        let bytes = std::fs::read(
            db.root
                .join("backups")
                .join(archive["filename"].as_str().unwrap()),
        )
        .unwrap();
        let payload = json!({"filename":archive["filename"],"contentBase64":base64::engine::general_purpose::STANDARD.encode(bytes),"confirmation":"RESTORE"});
        assert_eq!(
            call(&mut db, "inspect_backup", payload.clone())["compatible"],
            true
        );
        call(&mut db, "restore_backup", payload);
        let restored = call(&mut db, "get_state", json!({}));
        assert_eq!(restored["proposals"], state["proposals"]);
        assert_eq!(restored["extractionDrafts"], state["extractionDrafts"]);
    }
    #[test]
    fn duplicate_quotes_merge_within_a_checkpoint_without_merging_distinct_facets() {
        let (_dir, mut db, _, job, task) = setup();
        let mut checkpoint = single_claim(&task);
        let mut duplicate = checkpoint.candidates[0].clone();
        duplicate.evidence[0].quote = TEXT.into();
        checkpoint.candidates.push(duplicate.clone());
        checkpoint.candidates.push(duplicate.clone());
        duplicate.facets.conditions = vec!["紧急条件下".into()];
        checkpoint.candidates.push(duplicate);
        persist(&mut db, &job, 0, task.generation, &checkpoint).unwrap();
        let state = call(&mut db, "get_state", json!({}));
        assert_eq!(state["proposals"].as_array().unwrap().len(), 2);
        let plain = state["proposals"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["facets"]["conditions"] == json!([]))
            .unwrap();
        let conditional = state["proposals"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["facets"]["conditions"] == json!(["紧急条件下"]))
            .unwrap();
        assert_eq!(plain["quotes"].as_array().unwrap().len(), 2);
        assert_eq!(
            conditional["quotes"],
            json!([{"segmentId":task.segments[0].id,"quote":TEXT}])
        );
        assert_eq!(state["extractionDrafts"].as_array().unwrap().len(), 4);
        validate_backup(&db.conn).unwrap();
    }
    #[test]
    fn new_quotes_never_change_edited_rejected_confirmed_or_reviewed_proposals() {
        for action in ["edited", "rejected", "confirmed", "reviewed"] {
            let (_dir, mut db, _, job, task) = setup();
            let mut first = single_claim(&task);
            if action == "reviewed" {
                first.candidates[0].facets.entity = "待人工修正的主体".into();
            }
            persist(&mut db, &job, 0, task.generation, &first).unwrap();
            let initial = call(&mut db, "get_state", json!({}));
            if action == "reviewed" {
                review(&mut db,&json!({"draftId":initial["extractionDrafts"][0]["id"],"action":"approve","content":first.candidates[0].content,"facets":single_claim(&task).candidates[0].facets,"reason":"按原文修正主体"})).unwrap();
            } else {
                let proposal = &initial["proposals"][0]["id"];
                match action {
                    "edited" => {
                        call(
                            &mut db,
                            "update_proposal",
                            json!({"proposalId":proposal,"kind":"fact","content":"人工编辑后的正文"}),
                        );
                    }
                    "rejected" => {
                        call(&mut db, "reject_proposal", json!({"proposalId":proposal}));
                    }
                    "confirmed" => {
                        call(&mut db, "confirm_proposal", json!({"proposalId":proposal}));
                    }
                    _ => unreachable!(),
                }
            }
            let before = call(&mut db, "get_state", json!({}));
            let mut second = single_claim(&task);
            second.key = "leaf-2".into();
            second.candidates[0].evidence[0].quote = TEXT.into();
            persist(&mut db, &job, 0, task.generation, &second).unwrap();
            persist(&mut db, &job, 0, task.generation, &first).unwrap();
            let after = call(&mut db, "get_state", json!({}));
            assert_eq!(after["proposals"], before["proposals"], "{action}");
            assert_eq!(
                after["extractionDrafts"][0], before["extractionDrafts"][0],
                "{action}"
            );
            assert_eq!(after["memories"], before["memories"], "{action}");
            validate_backup(&db.conn).unwrap();
        }
    }
    #[test]
    fn duplicate_quotes_do_not_rewrite_a_proposal_from_another_snapshot() {
        let (_dir, mut db, _, job, task) = setup();
        let first = single_claim(&task);
        persist(&mut db, &job, 0, task.generation, &first).unwrap();
        let before = call(&mut db, "get_state", json!({}));
        db.conn
            .execute(
                "UPDATE jobs SET config_revision=? WHERE id=?",
                params!["different-configuration", job],
            )
            .unwrap();
        let mut second = first.clone();
        second.key = "leaf-2".into();
        second.candidates[0].evidence[0].quote = TEXT.into();
        persist(&mut db, &job, 0, task.generation, &second).unwrap();
        let after = call(&mut db, "get_state", json!({}));
        assert_eq!(after["proposals"], before["proposals"]);
        assert_eq!(budget_records(&db.conn).unwrap().len(), 2);
        assert_eq!(resume(&db.conn, &job).unwrap().len(), 1);
        validate_backup(&db.conn).unwrap();
    }
    #[test]
    fn navigation_is_audited_but_invalid_scope_requires_corrected_review() {
        let (_dir, mut db, _, job, task) = setup();
        let mut checkpoint = event(&task);
        checkpoint.candidates[0].facets.topic = "并不存在的主题".into();
        checkpoint.candidates.push(checkpoint.candidates[0].clone());
        checkpoint.candidates[1].facets.entity = "臆测主体".into();
        persist(&mut db, &job, 0, task.generation, &checkpoint).unwrap();
        let state = call(&mut db, "get_state", json!({}));
        assert_eq!(state["proposals"].as_array().unwrap().len(), 1);
        assert_eq!(state["proposals"][0]["facets"]["topic"], "");
        let draft = state["extractionDrafts"]
            .as_array()
            .unwrap()
            .iter()
            .find(|d| d["status"] == "needs_review")
            .unwrap();
        assert_eq!(draft["candidate"]["facets"]["entity"], "臆测主体");
        let draft_id = draft["id"].as_str().unwrap().to_owned();
        let blank=review(&mut db,&json!({"draftId":draft_id,"action":"approve","content":TEXT,"facets":json!(crate::memory_facts::Facets::default()),"reason":"清空字段"})).unwrap_err();
        assert_eq!(blank.code, "EXTRACTION_REVIEW_REQUIRED");
        let corrected = json!({"entity":"甲项目","topic":"","role":"","conditions":[],"validFrom":null,"validUntil":null});
        review(&mut db,&json!({"draftId":draft_id,"action":"approve","content":TEXT,"facets":corrected,"reason":"按原文修正主体为甲项目"})).unwrap();
        let state = call(&mut db, "get_state", json!({}));
        assert_eq!(state["proposals"].as_array().unwrap().len(), 2);
        assert_eq!(state["memories"].as_array().unwrap().len(), 0);
        assert_eq!(state["extractionDrafts"][1]["status"], "reviewed");
        validate_backup(&db.conn).unwrap();
        let mut conditional = event(&task);
        conditional.key = "conditional".into();
        conditional.candidates[0].facets.conditions = vec!["模型生成的无效条件".into()];
        persist(&mut db, &job, 0, task.generation, &conditional).unwrap();
        let state = call(&mut db, "get_state", json!({}));
        let draft = state["extractionDrafts"]
            .as_array()
            .unwrap()
            .iter()
            .find(|d| d["batchKey"] == "conditional")
            .unwrap();
        let error=review(&mut db,&json!({"draftId":draft["id"],"action":"approve","content":TEXT,"facets":{"conditions":[""]},"reason":"试图用空占位清空范围"})).unwrap_err();
        assert_eq!(error.code, "VALIDATION");
    }
    #[test]
    fn differing_scopes_are_not_deduplicated_and_bad_quotes_never_become_proposals() {
        let (_dir, mut db, _, job, task) = setup();
        let mut checkpoint = event(&task);
        checkpoint.candidates[0].facets.entity = "甲项目".into();
        let mut other = checkpoint.candidates[0].clone();
        other.facets.entity = "乙项目".into();
        checkpoint.candidates.push(other);
        let mut bad = checkpoint.candidates[0].clone();
        bad.evidence[0].quote = "伪造证据".into();
        checkpoint.candidates.push(bad);
        persist(&mut db, &job, 0, task.generation, &checkpoint).unwrap();
        let state = call(&mut db, "get_state", json!({}));
        assert_eq!(state["proposals"].as_array().unwrap().len(), 2);
        assert_eq!(state["extractionDrafts"][2]["status"], "rejected");
        assert!(state["memories"].as_array().unwrap().is_empty());
    }
    #[test]
    fn partial_checkpoints_and_invalid_raw_facets_roundtrip_backup_and_restore_pauses_old_work() {
        let (_dir, mut db, _, job, task) = setup();
        let mut checkpoint = event(&task);
        checkpoint.candidates[0].facets.valid_until = Some("yesterday".into());
        persist(&mut db, &job, 0, task.generation, &checkpoint).unwrap();
        let archive = crate::backup::create(&mut db).unwrap();
        let bytes = std::fs::read(
            db.root
                .join("backups")
                .join(archive["filename"].as_str().unwrap()),
        )
        .unwrap();
        crate::backup::restore(&mut db,&json!({"filename":archive["filename"],"contentBase64":base64::engine::general_purpose::STANDARD.encode(bytes),"confirmation":"RESTORE"})).unwrap();
        assert!(!persist(&mut db, &job, 0, task.generation, &checkpoint).unwrap());
        let state = call(&mut db, "get_state", json!({}));
        assert_eq!(state["extractionDrafts"][0]["status"], "needs_review");
        assert_eq!(state["extractionBatches"][0]["status"], "succeeded");
        assert!(state["proposals"].as_array().unwrap().is_empty());
    }
    #[test]
    fn source_mutation_blocks_checkpoint_commit_and_candidate_confirmation() {
        let (_dir, mut db, source, job, task) = setup();
        let checkpoint = event(&task);
        persist(&mut db, &job, 0, task.generation, &checkpoint).unwrap();
        let state = call(&mut db, "get_state", json!({}));
        let proposal = state["proposals"][0]["id"].as_str().unwrap();
        db.conn
            .execute(
                "UPDATE sources SET sha256=? WHERE id=?",
                params![hash(b"new-version"), source],
            )
            .unwrap();
        assert!(!persist(&mut db, &job, 0, task.generation, &checkpoint).unwrap());
        assert!(guard_proposal(&db.conn, proposal).is_err());
        let err = db
            .execute(Request {
                command: "confirm_proposal".into(),
                payload: json!({"proposalId":proposal}),
            })
            .unwrap_err();
        assert_eq!(err.code, "EXTRACTION_REVIEW_REQUIRED");
    }
    #[test]
    fn restoring_an_older_snapshot_never_refunds_sent_requests_or_restores_lost_facts() {
        let (_dir, mut db, _, job, task) = setup();
        let archive = crate::backup::create(&mut db).unwrap();
        let bytes = std::fs::read(
            db.root
                .join("backups")
                .join(archive["filename"].as_str().unwrap()),
        )
        .unwrap();
        let mut checkpoint = event(&task);
        checkpoint.budget.requests = 9;
        checkpoint.budget.input_tokens = 800;
        checkpoint.budget.elapsed_ms = 5000;
        persist(&mut db, &job, 0, task.generation, &checkpoint).unwrap();
        crate::backup::restore(&mut db,&json!({"filename":archive["filename"],"contentBase64":base64::engine::general_purpose::STANDARD.encode(bytes),"confirmation":"RESTORE"})).unwrap();
        let state = call(&mut db, "get_state", json!({}));
        assert!(state["proposals"].as_array().unwrap().is_empty());
        assert!(state["extractionBatches"].as_array().unwrap().is_empty());
        call(&mut db, "retry_extraction", json!({"jobId":job}));
        let resumed = db.claim_extract(&job, db.epoch).unwrap().unwrap();
        assert_eq!(resumed.checkpoints.len(), 1);
        assert_eq!(resumed.checkpoints[0].status, "budget");
        assert_eq!(resumed.checkpoints[0].budget.requests, 9);
        assert_eq!(resumed.checkpoints[0].budget.input_tokens, 800);
        assert_eq!(resumed.checkpoints[0].budget.elapsed_ms, 5000);
    }

    #[test]
    fn retention_layers_survive_confirmation_and_expired_work_is_not_retrieved() {
        let (_dir, mut db, _, job, task) = setup();
        let mut checkpoint = event(&task);
        for (i, layer) in ["durable", "working", "clarify", "archive"]
            .iter()
            .enumerate()
        {
            checkpoint.key = format!("layer-{i}");
            checkpoint.candidates[0].retention = crate::retention::Retention {
                layer: (*layer).into(),
                reason: "分层回归".into(),
            };
            assert!(persist(&mut db, &job, 0, task.generation, &checkpoint).unwrap());
        }
        let state = call(&mut db, "get_state", json!({}));
        assert_eq!(state["proposals"].as_array().unwrap().len(), 2);
        assert!(state["extractionDrafts"]
            .as_array()
            .unwrap()
            .iter()
            .any(|d| d["status"] == "retained"));
        assert!(state["extractionDrafts"]
            .as_array()
            .unwrap()
            .iter()
            .any(|d| d["status"] == "needs_review"));
        let working = state["proposals"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["retention"]["layer"] == "working")
            .unwrap();
        let confirmed = call(
            &mut db,
            "confirm_proposal",
            json!({"proposalId":working["id"]}),
        );
        assert_eq!(confirmed["retention"]["layer"], "working");
        assert!(confirmed["retention"]["reviewAfter"].as_str().is_some());
        let project = confirmed["projectId"].as_str().unwrap();
        let query = crate::search::Query::new(TEXT);
        assert_eq!(
            crate::memory_query::retrieve(
                &db.conn,
                Some(project),
                &query,
                24,
                600,
                false,
                "2000-01-01"
            )
            .unwrap()
            .records
            .len(),
            1
        );
        assert!(crate::memory_query::retrieve(
            &db.conn,
            Some(project),
            &query,
            24,
            600,
            false,
            "2099-01-01"
        )
        .unwrap()
        .records
        .is_empty());
        crate::retention::validate_backup(&db.conn).unwrap();
        validate_backup(&db.conn).unwrap();
        let detail = call(&mut db, "get_memory", json!({"memoryId":confirmed["id"]}));
        assert_eq!(detail["revisions"][0]["retention"], confirmed["retention"]);
    }

    #[test]
    fn topic_changes_merge_but_conditions_and_retention_do_not() {
        let (_dir, mut db, _, job, task) = setup();
        let mut checkpoint = event(&task);
        checkpoint.candidates[0].facets.topic = "甲项目".into();
        persist(&mut db, &job, 0, task.generation, &checkpoint).unwrap();
        checkpoint.key = "another-topic".into();
        checkpoint.candidates[0].facets.topic = "紧急条件".into();
        persist(&mut db, &job, 0, task.generation, &checkpoint).unwrap();
        assert_eq!(
            call(&mut db, "get_state", json!({}))["proposals"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        checkpoint.key = "different-scope".into();
        checkpoint.candidates[0]
            .facets
            .conditions
            .push("紧急条件".into());
        persist(&mut db, &job, 0, task.generation, &checkpoint).unwrap();
        assert_eq!(
            call(&mut db, "get_state", json!({}))["proposals"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        validate_backup(&db.conn).unwrap();
    }
}
