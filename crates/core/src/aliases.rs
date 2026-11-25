//! User-maintained entity and terminology aliases (people, project short names, domain terms).
//! Aliases expand retrieval recall and conflict detection only; they never rewrite stored facts
//! or evidence quotes.
use crate::{id, now, required, AppError, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::HashSet;

pub(crate) fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS entity_aliases(
            id TEXT PRIMARY KEY,
            project_id TEXT REFERENCES projects(id),
            canonical TEXT NOT NULL,
            aliases_json TEXT NOT NULL,
            kind TEXT NOT NULL CHECK(kind IN ('person','project','term')),
            note TEXT NOT NULL DEFAULT '',
            version INTEGER NOT NULL CHECK(version>=1),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS entity_aliases_scope ON entity_aliases(project_id, kind);",
    )?;
    Ok(())
}

fn invalid(message: &str) -> AppError {
    AppError::new("VALIDATION", message)
}

fn table_exists(conn: &Connection) -> Result<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='entity_aliases')",
        [],
        |r| r.get(0),
    )?)
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

fn parse_aliases(raw: &Value, canonical: &str) -> Result<Vec<String>> {
    let items = raw
        .as_array()
        .ok_or_else(|| invalid("别名列表必须为字符串数组"))?;
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    seen.insert(canonical.to_lowercase());
    for item in items {
        let text = item
            .as_str()
            .ok_or_else(|| invalid("别名必须为字符串"))?
            .trim();
        if text.is_empty() {
            continue;
        }
        if text.chars().count() > 120 {
            return Err(invalid("单条别名最多 120 字"));
        }
        if seen.insert(text.to_lowercase()) {
            out.push(text.to_owned());
        }
    }
    if out.is_empty() || out.len() > 20 {
        return Err(invalid("请填写 1 至 20 个不同于标准名称的别名"));
    }
    Ok(out)
}

fn read_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let aliases_raw: String = row.get(3)?;
    let aliases: Value = serde_json::from_str(&aliases_raw).unwrap_or_else(|_| json!([]));
    Ok(json!({
        "id": row.get::<_, String>(0)?,
        "projectId": row.get::<_, Option<String>>(1)?,
        "canonical": row.get::<_, String>(2)?,
        "aliases": aliases,
        "kind": row.get::<_, String>(4)?,
        "note": row.get::<_, String>(5)?,
        "version": row.get::<_, i64>(6)?,
        "createdAt": row.get::<_, String>(7)?,
        "updatedAt": row.get::<_, String>(8)?,
    }))
}

pub(crate) fn list(conn: &Connection, p: &Value) -> Result<Value> {
    if !table_exists(conn)? {
        return Ok(json!({"aliases": [], "count": 0}));
    }
    let project = scope_project(conn, p)?;
    let include_global = p["includeGlobal"].as_bool().unwrap_or(true);
    let mut stmt = conn.prepare(
        "SELECT id,project_id,canonical,aliases_json,kind,note,version,created_at,updated_at
         FROM entity_aliases
         WHERE (?1 IS NULL OR project_id=?1 OR (?2=1 AND project_id IS NULL))
         ORDER BY CASE WHEN project_id IS NULL THEN 1 ELSE 0 END, updated_at DESC, id",
    )?;
    let items = stmt
        .query_map(params![project, i64::from(include_global)], read_row)?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let count = items.len();
    Ok(json!({"aliases": items, "count": count}))
}

pub(crate) fn save(conn: &Connection, p: &Value) -> Result<Value> {
    let project = scope_project(conn, p)?;
    let canonical = required(p, "canonical")?.trim();
    if canonical.is_empty() || canonical.chars().count() > 120 {
        return Err(invalid("标准名称不能为空且最多 120 字"));
    }
    let kind = p["kind"].as_str().unwrap_or("term").trim();
    if !matches!(kind, "person" | "project" | "term") {
        return Err(invalid("别名类型仅支持 person、project 或 term"));
    }
    let note = p["note"].as_str().unwrap_or("").trim();
    if note.chars().count() > 500 {
        return Err(invalid("说明最多 500 字"));
    }
    let aliases = parse_aliases(&p["aliases"], canonical)?;
    let aliases_json = json!(aliases).to_string();
    let existing_id = p["id"].as_str().map(str::trim).filter(|s| !s.is_empty());

    let duplicate: bool = conn.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM entity_aliases
            WHERE coalesce(project_id,'')=coalesce(?1,'')
              AND lower(canonical)=lower(?2)
              AND (?3 IS NULL OR id<>?3)
        )",
        params![project, canonical, existing_id],
        |r| r.get(0),
    )?;
    if duplicate {
        return Err(AppError::new(
            "CONFLICT",
            "同范围内已存在该标准名称的别名配置，请直接编辑原条目",
        ));
    }

    let at = now();
    let record_id = if let Some(entry_id) = existing_id {
        let base = p["baseVersion"]
            .as_i64()
            .filter(|v| *v >= 1)
            .ok_or_else(|| invalid("缺少别名版本号"))?;
        let changed = conn.execute(
            "UPDATE entity_aliases
             SET project_id=?,canonical=?,aliases_json=?,kind=?,note=?,version=version+1,updated_at=?
             WHERE id=? AND version=?",
            params![
                project,
                canonical,
                aliases_json,
                kind,
                note,
                at,
                entry_id,
                base
            ],
        )?;
        if changed == 0 {
            let exists: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM entity_aliases WHERE id=?)",
                [entry_id],
                |r| r.get(0),
            )?;
            return Err(if exists {
                AppError::new("REVISION_CONFLICT", "别名条目已更新，请刷新后重试")
            } else {
                AppError::new("NOT_FOUND", "别名条目不存在")
            });
        }
        entry_id.to_owned()
    } else {
        let new_id = id();
        conn.execute(
            "INSERT INTO entity_aliases(id,project_id,canonical,aliases_json,kind,note,version,created_at,updated_at)
             VALUES(?,?,?,?,?,?,1,?,?)",
            params![new_id, project, canonical, aliases_json, kind, note, at, at],
        )?;
        new_id
    };

    conn.query_row(
        "SELECT id,project_id,canonical,aliases_json,kind,note,version,created_at,updated_at
         FROM entity_aliases WHERE id=?",
        [&record_id],
        read_row,
    )
    .optional()?
    .ok_or_else(|| AppError::new("NOT_FOUND", "别名保存后读取失败"))
}

pub(crate) fn delete(conn: &Connection, p: &Value) -> Result<Value> {
    let entry_id = required(p, "id")?.trim();
    let changed = conn.execute("DELETE FROM entity_aliases WHERE id=?", [entry_id])?;
    if changed == 0 {
        return Err(AppError::new("NOT_FOUND", "别名条目不存在"));
    }
    Ok(json!({"deleted": true, "id": entry_id}))
}

pub(crate) fn dispatch(conn: &Connection, command: &str, p: &Value) -> Result<Value> {
    match command {
        "list_entity_aliases" => list(conn, p),
        "save_entity_alias" => save(conn, p),
        "delete_entity_alias" => delete(conn, p),
        _ => Err(invalid("不支持的别名操作")),
    }
}

/// Loads effective alias groups (`[canonical, alias1, ...]`) for a project scope plus global aliases.
/// Returns an empty list if the table has not been created in isolated test schemas.
pub(crate) fn load_groups(conn: &Connection, scope: Option<&str>) -> Result<Vec<Vec<String>>> {
    if !table_exists(conn)? {
        return Ok(Vec::new());
    }
    let mut stmt = conn.prepare(
        "SELECT canonical, aliases_json FROM entity_aliases
         WHERE (?1 IS NULL OR project_id IS NULL OR project_id=?1)
         ORDER BY CASE WHEN project_id IS NULL THEN 1 ELSE 0 END, updated_at DESC, id
         LIMIT 500",
    )?;
    let rows = stmt
        .query_map([scope], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut groups = Vec::with_capacity(rows.len());
    for (canonical, raw) in rows {
        let mut group = Vec::new();
        let canonical = canonical.trim();
        if !canonical.is_empty() {
            group.push(canonical.to_owned());
        }
        if let Ok(Value::Array(items)) = serde_json::from_str::<Value>(&raw) {
            for item in items {
                if let Some(alias) = item.as_str().map(str::trim).filter(|s| !s.is_empty()) {
                    group.push(alias.to_owned());
                }
            }
        }
        if group.len() >= 2 {
            groups.push(group);
        }
    }
    Ok(groups)
}

pub(crate) fn validate_backup(conn: &Connection) -> Result<()> {
    if !table_exists(conn)? {
        return Err(AppError::new("INVALID_BACKUP", "备份缺少术语与别名表"));
    }
    let mut stmt = conn.prepare(
        "SELECT id,project_id,canonical,aliases_json,kind,note,version,created_at,updated_at FROM entity_aliases",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, Option<String>>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, String>(4)?,
            r.get::<_, String>(5)?,
            r.get::<_, i64>(6)?,
            r.get::<_, String>(7)?,
            r.get::<_, String>(8)?,
        ))
    })?;
    for row in rows {
        let (_id, project_id, canonical, aliases_raw, kind, note, version, _created, _updated) =
            row.map_err(|_| AppError::new("INVALID_BACKUP", "备份术语别名字段类型无效"))?;
        if canonical.trim().is_empty()
            || canonical.chars().count() > 120
            || !matches!(kind.as_str(), "person" | "project" | "term")
            || note.chars().count() > 500
            || version < 1
        {
            return Err(AppError::new("INVALID_BACKUP", "备份术语别名内容无效"));
        }
        if let Some(pid) = project_id {
            let exists: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM projects WHERE id=?)",
                [pid],
                |r| r.get(0),
            )?;
            if !exists {
                return Err(AppError::new(
                    "INVALID_BACKUP",
                    "备份术语别名引用了不存在的项目",
                ));
            }
        }
        let parsed: Value = serde_json::from_str(&aliases_raw)
            .map_err(|_| AppError::new("INVALID_BACKUP", "备份术语别名列表格式无效"))?;
        parse_aliases(&parsed, canonical.trim())
            .map_err(|_| AppError::new("INVALID_BACKUP", "备份术语别名条目无效"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;

    #[test]
    fn alias_crud_scoping_and_version_conflict() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path().to_path_buf()).unwrap();
        db.conn
            .execute(
                "INSERT INTO projects VALUES('p1','支付重构','二期','2026-11-24T00:00:00Z')",
                [],
            )
            .unwrap();
        let global = save(
            &db.conn,
            &json!({"canonical":"王明","aliases":["老王","后端王哥","王明"],"kind":"person","note":"后端负责人"}),
        )
        .unwrap();
        assert_eq!(global["version"], 1);
        assert_eq!(global["aliases"], json!(["老王", "后端王哥"]));

        let scoped = save(
            &db.conn,
            &json!({"projectId":"p1","canonical":"支付重构","aliases":["二期","支付二期"],"kind":"project"}),
        )
        .unwrap();
        assert_eq!(scoped["projectId"], "p1");

        let groups = load_groups(&db.conn, Some("p1")).unwrap();
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0][0], "支付重构");
        assert_eq!(groups[1][0], "王明");

        // Stale version fails cleanly
        assert_eq!(
            save(
                &db.conn,
                &json!({"id":global["id"],"baseVersion":99,"canonical":"王明","aliases":["老王"],"kind":"person"}),
            )
            .unwrap_err()
            .code,
            "REVISION_CONFLICT"
        );

        let updated = save(
            &db.conn,
            &json!({"id":global["id"],"baseVersion":1,"canonical":"王明","aliases":["老王","王总"],"kind":"person"}),
        )
        .unwrap();
        assert_eq!(updated["version"], 2);

        delete(&db.conn, &json!({"id":scoped["id"]})).unwrap();
        assert_eq!(load_groups(&db.conn, Some("p1")).unwrap().len(), 1);
    }
}
