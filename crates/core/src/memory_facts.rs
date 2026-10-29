//! Explicit, revision-bound organization. Unknown fields stay unknown; an old
//! revision's annotations are never inherited by a changed assertion.
use crate::{AppError, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub(crate) const MIGRATION: &str = "
CREATE TABLE revision_facets(revision_id TEXT PRIMARY KEY REFERENCES revisions(id),facets TEXT NOT NULL);
CREATE TABLE proposal_facets(proposal_id TEXT PRIMARY KEY REFERENCES proposals(id),facets TEXT NOT NULL);
CREATE TABLE memory_lexical_state(rowid INTEGER PRIMARY KEY,memory_id TEXT NOT NULL UNIQUE,revision_id TEXT NOT NULL,label TEXT NOT NULL);
CREATE VIRTUAL TABLE memory_lexical USING fts5(memory_id UNINDEXED,revision_id UNINDEXED,label UNINDEXED,terms,tokenize='unicode61');
PRAGMA user_version=9;";

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Facets {
    #[serde(default)]
    pub entity: String,
    #[serde(default)]
    pub topic: String,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub conditions: Vec<String>,
    #[serde(default)]
    pub valid_from: Option<String>,
    #[serde(default)]
    pub valid_until: Option<String>,
}

/// Navigation labels may be quarantined independently. Applicability fields
/// remain untouched when invalid, so a failed condition never becomes global.
pub(crate) fn identity(value: &Value) -> Value {
    let mut scope = value.clone();
    if let Some(object) = scope.as_object_mut() {
        object.remove("topic");
    }
    scope
}

pub(crate) fn extraction_check(
    facets: &Facets,
    content: &str,
    quotes: &str,
) -> (Value, Value, bool) {
    let original = json!(facets);
    let mut accepted = facets.clone();
    let mut issues = Vec::new();
    if !facets.topic.is_empty()
        && (facets.topic.chars().count() > 160
            || facets.topic.trim() != facets.topic
            || !content.contains(&facets.topic)
            || !quotes.contains(&facets.topic))
    {
        issues.push(json!({"field":"topic","value":facets.topic,"reason":"导航标签未逐字出现在正文和引文中，已隔离标签","severity":"navigation"}));
        accepted.topic.clear();
    }
    let safe = json!(accepted);
    let mut needs_review = false;
    for (field, value) in [
        ("entity", original["entity"].clone()),
        ("role", original["role"].clone()),
        ("conditions", original["conditions"].clone()),
        ("validFrom", original["validFrom"].clone()),
        ("validUntil", original["validUntil"].clone()),
    ] {
        let mut single = json!(Facets::default());
        single[field] = value.clone();
        if checked(&single, content).is_err() || checked(&single, quotes).is_err() {
            needs_review = true;
            issues.push(json!({"field":field,"value":value,"reason":"适用范围字段未通过正文和引文校验，须人工修正或明确审核","severity":"applicability"}));
        }
    }
    if checked(&safe, content).is_err() || checked(&safe, quotes).is_err() {
        needs_review = true;
        if !issues.iter().any(|v| v["severity"] == "applicability") {
            issues.push(json!({"field":"facets","value":original,"reason":"组织字段之间存在冲突","severity":"applicability"}));
        }
    }
    (safe, json!(issues), needs_review)
}

pub(crate) fn checked(value: &Value, content: &str) -> Result<Value> {
    let facets: Facets = serde_json::from_value(value.clone())
        .map_err(|_| AppError::new("VALIDATION", "记忆的主体、事项或条件格式无效"))?;
    if facets.conditions.len() > 8
        || facets.conditions.iter().any(|v| v.trim().is_empty())
        || facets
            .conditions
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len()
            != facets.conditions.len()
        || !["", "owner", "approver", "contact"].contains(&facets.role.as_str())
        || [&facets.entity, &facets.topic]
            .into_iter()
            .chain(facets.conditions.iter())
            .any(|v| {
                v.chars().count() > 160
                    || (!v.is_empty() && (v.trim() != v || !content.contains(v)))
            })
    {
        return Err(AppError::new(
            "VALIDATION",
            "主体、事项和条件须来自当前正文；角色须区分负责人、审批人和联系人",
        ));
    }
    for date in [&facets.valid_from, &facets.valid_until]
        .into_iter()
        .flatten()
    {
        crate::tasks::valid_date(date)?;
        if !content.contains(date) {
            return Err(AppError::new(
                "VALIDATION",
                "有效日期须在正文中明确记录为 YYYY-MM-DD",
            ));
        }
    }
    if matches!((&facets.valid_from, &facets.valid_until), (Some(a), Some(b)) if a > b) {
        return Err(AppError::new("VALIDATION", "生效日期不能晚于失效日期"));
    }
    let markers: &[&str] = match facets.role.as_str() {
        "owner" => &["负责人", "负责", "owner", "assignee"],
        "approver" => &["审批", "批准", "approver"],
        "contact" => &["联系人", "对接人", "contact"],
        _ => &[],
    };
    if !markers.is_empty() && !markers.iter().any(|m| content.to_lowercase().contains(m)) {
        return Err(AppError::new("VALIDATION", "正文没有明确说明所选角色"));
    }
    if facets.role == "owner"
        && (content.contains("审批") || content.contains("批准"))
        && !["负责人", "owner", "assignee"]
            .iter()
            .any(|m| content.to_lowercase().contains(m))
    {
        return Err(AppError::new(
            "VALIDATION",
            "审批职责不能直接标为事项负责人",
        ));
    }
    Ok(json!(facets))
}

pub(crate) fn load(conn: &Connection, revision: &str) -> Result<Value> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT facets FROM revision_facets WHERE revision_id=?",
            [revision],
            |r| r.get(0),
        )
        .optional()?;
    raw.map(|s| serde_json::from_str(&s).map_err(|_| AppError::new("DATABASE", "记忆组织信息损坏")))
        .transpose()
        .map(|v| v.unwrap_or_else(|| json!({})))
}

pub(crate) fn save(conn: &Connection, revision: &str, value: &Value, content: &str) -> Result<()> {
    let facets = checked(value, content)?;
    conn.execute(
        "INSERT INTO revision_facets VALUES(?,?)",
        params![revision, facets.to_string()],
    )?;
    Ok(())
}

pub(crate) fn promote(
    conn: &Connection,
    proposal: &str,
    revision: &str,
    content: &str,
) -> Result<()> {
    let raw: Option<String> = conn.query_row("SELECT f.facets FROM proposal_facets f JOIN proposals p ON p.id=f.proposal_id WHERE p.id=? AND p.content=? AND p.edited=0", params![proposal,content], |r| r.get(0)).optional()?;
    if let Some(raw) = raw {
        let facets: Value = serde_json::from_str(&raw)
            .map_err(|_| AppError::new("DATABASE", "候选组织信息损坏"))?;
        save(conn, revision, &facets, content)?;
    }
    Ok(())
}

pub(crate) fn proposal(conn: &Connection, id: &str) -> Result<Value> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT facets FROM proposal_facets WHERE proposal_id=?",
            [id],
            |r| r.get(0),
        )
        .optional()?;
    raw.map(|s| serde_json::from_str(&s).map_err(|_| AppError::new("DATABASE", "候选组织信息损坏")))
        .transpose()
        .map(|v| v.unwrap_or_else(|| json!({})))
}

pub(crate) fn validate_backup(conn: &Connection) -> Result<()> {
    let definition: String = conn.query_row(
        "SELECT sql FROM sqlite_master WHERE name='memory_lexical' AND type='table'",
        [],
        |r| r.get(0),
    )?;
    let canonical: String = definition
        .chars()
        .filter(|c| !c.is_whitespace())
        .flat_map(char::to_lowercase)
        .collect();
    if canonical!="createvirtualtablememory_lexicalusingfts5(memory_idunindexed,revision_idunindexed,labelunindexed,terms,tokenize='unicode61')" {
        return Err(AppError::new("INVALID_BACKUP","备份检索缓存结构无效"));
    }
    for (table, key, source, source_key) in [
        ("revision_facets", "revision_id", "revisions", "id"),
        ("proposal_facets", "proposal_id", "proposals", "id"),
    ] {
        let invalid: bool = conn.query_row(&format!("SELECT EXISTS(SELECT 1 FROM {table} f LEFT JOIN {source} s ON s.{source_key}=f.{key} WHERE s.{source_key} IS NULL) OR (SELECT count(*)<>count(DISTINCT {key}) FROM {table})"),[],|r|r.get(0))?;
        if invalid {
            return Err(AppError::new(
                "INVALID_BACKUP",
                "备份组织信息存在孤立或重复修订",
            ));
        }
        let mut stmt = conn.prepare(&format!(
            "SELECT f.facets,s.content FROM {table} f JOIN {source} s ON s.{source_key}=f.{key}"
        ))?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        for row in rows {
            let (raw, content) = row?;
            let value: Value = serde_json::from_str(&raw)
                .map_err(|_| AppError::new("INVALID_BACKUP", "备份组织信息无效"))?;
            checked(&value, &content)
                .map_err(|_| AppError::new("INVALID_BACKUP", "备份组织信息与正文不一致"))?;
        }
    }
    // Force a structural read; stale index contents are always rebuilt after restore.
    conn.prepare("SELECT memory_id,revision_id,label,terms FROM memory_lexical")?;
    conn.prepare("SELECT rowid,memory_id,revision_id,label FROM memory_lexical_state")?;
    Ok(())
}

// Confirmed annotations restrict applicability; absence is not a wildcard
// assertion. Untagged records remain searchable and must be qualified by the
// answer contract rather than receiving an inferred subject.
pub(crate) fn applicable(facets: &Value, named: &[String], date: &str) -> bool {
    let entity = facets["entity"].as_str().unwrap_or("");
    if !named.is_empty() && !entity.is_empty() && !named.iter().any(|n| n == entity) {
        return false;
    }
    facets["validFrom"].as_str().is_none_or(|d| d <= date)
        && facets["validUntil"].as_str().is_none_or(|d| d >= date)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn annotations_require_explicit_content_and_valid_time() {
        assert!(checked(&json!({"conditions":[""]}), "甲项目仅在紧急时适用").is_err());
        assert!(checked(
            &json!({"conditions":["紧急","紧急"]}),
            "甲项目仅在紧急时适用"
        )
        .is_err());
        assert!(checked(
            &json!({"entity":"泽川","role":"approver"}),
            "泽川采购审批由李思负责"
        )
        .is_ok());
        assert!(checked(&json!({"entity":"泽川"}), "通用采购审批由李思负责").is_err());
        assert!(checked(&json!({"role":"contact"}), "采购审批由李思负责").is_err());
        assert!(checked(
            &json!({"validFrom":"2026-12-01","validUntil":"2026-01-01"}),
            "2026-12-01 至 2026-01-01"
        )
        .is_err());
        assert!(!applicable(
            &json!({"entity":"泽川"}),
            &["天衡".into()],
            "2026-10-20"
        ));
        assert!(!applicable(
            &json!({"validUntil":"2025-01-01"}),
            &[],
            "2026-10-20"
        ));
    }
}
