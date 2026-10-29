//! Retention is a review policy, never evidence that a claim is true.
use crate::{AppError, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub(crate) const MIGRATION: &str = "
CREATE TABLE IF NOT EXISTS proposal_retention(proposal_id TEXT PRIMARY KEY REFERENCES proposals(id),policy TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS revision_retention(revision_id TEXT PRIMARY KEY REFERENCES revisions(id),policy TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS extraction_project_context(job_id TEXT PRIMARY KEY REFERENCES jobs(id),context TEXT NOT NULL);
PRAGMA user_version=11;";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Retention {
    pub layer: String,
    pub reason: String,
}
impl Default for Retention {
    fn default() -> Self {
        Self {
            layer: "durable".into(),
            reason: "旧版或人工记录，沿用原有保留方式".into(),
        }
    }
}
pub(crate) fn checked(value: &Value) -> Result<Value> {
    if !value.as_object().is_some_and(|v| {
        v.keys()
            .all(|k| matches!(k.as_str(), "layer" | "reason" | "reviewAfter"))
    }) || value
        .get("reviewAfter")
        .is_some_and(|v| !v.is_null() && !v.is_string())
    {
        return Err(AppError::new("VALIDATION", "保留策略字段或日期类型无效"));
    }
    let layer = value["layer"].as_str().unwrap_or("");
    let reason = value["reason"].as_str().unwrap_or("").trim();
    if !["durable", "working", "clarify", "archive"].contains(&layer)
        || reason.is_empty()
        || reason.chars().count() > 400
    {
        return Err(AppError::new(
            "VALIDATION",
            "请选择保留层次并填写不超过400字的理由",
        ));
    }
    let review = value["reviewAfter"].as_str();
    if let Some(date) = review {
        crate::tasks::valid_date(date)?;
    }
    if layer != "working" && review.is_some() {
        return Err(AppError::new("VALIDATION", "只有工作状态可以设置复核日期"));
    }
    Ok(json!({"layer":layer,"reason":reason,"reviewAfter":review}))
}
pub(crate) fn proposal(conn: &Connection, id: &str) -> Result<Value> {
    load(conn, "proposal_retention", "proposal_id", id)
}
pub(crate) fn revision(conn: &Connection, id: &str) -> Result<Value> {
    load(conn, "revision_retention", "revision_id", id)
}
fn load(conn: &Connection, table: &str, key: &str, id: &str) -> Result<Value> {
    let raw: Option<String> = conn
        .query_row(
            &format!("SELECT policy FROM {table} WHERE {key}=?"),
            [id],
            |r| r.get(0),
        )
        .optional()?;
    checked(
        &raw.map(|v| serde_json::from_str(&v))
            .transpose()
            .map_err(|_| AppError::new("DATABASE", "保留策略损坏"))?
            .unwrap_or_else(|| json!(Retention::default())),
    )
}
pub(crate) fn save_revision(conn: &Connection, id: &str, value: &Value) -> Result<()> {
    let mut policy = checked(value)?;
    if policy["layer"] == "working" && policy["reviewAfter"].is_null() {
        // This is a product review interval, not an inferred factual expiry.
        policy["reviewAfter"] =
            json!((chrono::Local::now().date_naive() + chrono::Duration::days(7)).to_string());
    }
    conn.execute(
        "INSERT INTO revision_retention VALUES(?,?)",
        params![id, policy.to_string()],
    )?;
    Ok(())
}
pub(crate) fn promote(conn: &Connection, proposal_id: &str, revision_id: &str) -> Result<()> {
    save_revision(conn, revision_id, &proposal(conn, proposal_id)?)
}
pub(crate) fn eligible(policy: &Value, as_of: &str) -> bool {
    match policy["layer"].as_str() {
        Some("durable") => true,
        Some("working") => policy["reviewAfter"]
            .as_str()
            .is_some_and(|date| as_of < date),
        _ => false,
    }
}
pub(crate) fn validate_backup(conn: &Connection) -> Result<()> {
    for table in ["proposal_retention", "revision_retention"] {
        let mut stmt = conn.prepare(&format!("SELECT policy FROM {table}"))?;
        for raw in stmt.query_map([], |r| r.get::<_, String>(0))? {
            checked(
                &serde_json::from_str::<Value>(&raw?)
                    .map_err(|_| AppError::new("INVALID_BACKUP", "保留策略损坏"))?,
            )?;
        }
    }
    let mut stmt = conn.prepare("SELECT context FROM extraction_project_context")?;
    for raw in stmt.query_map([], |r| r.get::<_, String>(0))? {
        let value: Value = serde_json::from_str(&raw?)
            .map_err(|_| AppError::new("INVALID_BACKUP", "提取背景无效"))?;
        if !value.is_object() || value.to_string().len() > 32_000 {
            return Err(AppError::new(
                "INVALID_BACKUP",
                "提取背景超过容量或格式无效",
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn review_date_is_not_a_truth_or_expiration_claim() {
        let p =
            checked(&json!({"layer":"working","reason":"当前排查状态","reviewAfter":"2026-11-04"}))
                .unwrap();
        assert!(eligible(&p, "2026-11-03"));
        assert!(!eligible(&p, "2026-11-04"));
        assert!(!eligible(&json!({"layer":"clarify"}), "2026-10-28"));
        assert!(
            checked(&json!({"layer":"durable","reason":"x","reviewAfter":"2026-11-04"})).is_err()
        );
    }
}
