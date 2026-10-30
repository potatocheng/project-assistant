use crate::{backup, db::Database, now, required, AppError, Result};
use chrono::Timelike;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
pub(crate) fn option(conn: &Connection, key: &str, default: Value) -> Result<Value> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM workspace_options WHERE key=?",
            [key],
            |r| r.get(0),
        )
        .optional()?;
    raw.map(|s| serde_json::from_str(&s).map_err(|_| AppError::new("DATABASE", "工作区设置损坏")))
        .unwrap_or(Ok(default))
}
pub(crate) fn save(conn: &Connection, key: &str, value: &Value) -> Result<()> {
    conn.execute("INSERT INTO workspace_options VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![key,value.to_string()])?;
    Ok(())
}
pub(crate) fn desktop(conn: &Connection) -> Result<Value> {
    option(
        conn,
        "desktop",
        json!({"background":false,"notifications":false,"autostart":false,"quietStart":"22:00","quietEnd":"08:00"}),
    )
}
pub(crate) fn validate_backup(conn: &Connection) -> Result<()> {
    let mut stmt = conn.prepare("SELECT key,value FROM workspace_options")?;
    for row in stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
        let (key, raw) = row?;
        let value: Value = serde_json::from_str(&raw)
            .map_err(|_| AppError::new("VALIDATION", "备份设置格式无效"))?;
        if raw.len() > 100_000 || !value.is_object() {
            return Err(AppError::new("VALIDATION", "备份设置超出范围"));
        }
        let valid = match key.as_str() {
            "desktop" => {
                ["background", "notifications", "autostart"]
                    .iter()
                    .all(|k| value[*k].is_boolean())
                    && ["quietStart", "quietEnd"].iter().all(|k| {
                        value[*k].as_str().is_some_and(|s| {
                            s.len() == 5 && chrono::NaiveTime::parse_from_str(s, "%H:%M").is_ok()
                        })
                    })
            }
            "backup_policy" => {
                value["enabled"].is_boolean()
                    && value["intervalHours"]
                        .as_i64()
                        .is_some_and(|v| (1..=168).contains(&v))
                    && value["keep"]
                        .as_i64()
                        .is_some_and(|v| (3..=100).contains(&v))
                    && value["automaticIds"]
                        .as_array()
                        .is_some_and(|ids| ids.iter().all(Value::is_string))
                    && value["lastSuccess"]
                        .as_str()
                        .is_none_or(|v| chrono::DateTime::parse_from_rfc3339(v).is_ok())
            }
            "notification_receipt" => {
                value["signature"]
                    .as_str()
                    .is_some_and(|s| s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit()))
                    && value["at"]
                        .as_str()
                        .is_some_and(|v| chrono::DateTime::parse_from_rfc3339(v).is_ok())
            }
            _ => false,
        };
        if !valid {
            return Err(AppError::new("VALIDATION", "备份桌面或备份策略无效"));
        }
    }
    Ok(())
}
pub(crate) fn save_desktop(conn: &Connection, p: &Value) -> Result<Value> {
    for key in ["background", "notifications", "autostart"] {
        if !p[key].is_boolean() {
            return Err(AppError::new("VALIDATION", "桌面设置格式无效"));
        }
    }
    for key in ["quietStart", "quietEnd"] {
        let value = required(p, key)?;
        if chrono::NaiveTime::parse_from_str(value, "%H:%M").is_err() || value.len() != 5 {
            return Err(AppError::new("VALIDATION", "免打扰时间应为HH:MM"));
        }
    }
    let value = json!({"background":p["background"],"notifications":p["notifications"],"autostart":p["autostart"],"quietStart":p["quietStart"],"quietEnd":p["quietEnd"]});
    save(conn, "desktop", &value)?;
    Ok(value)
}
pub(crate) fn backup_settings(conn: &Connection) -> Result<Value> {
    option(
        conn,
        "backup_policy",
        json!({"enabled":false,"intervalHours":24,"keep":7,"lastSuccess":null,"lastError":null,"automaticIds":[]}),
    )
}
pub(crate) fn save_backup_settings(conn: &Connection, p: &Value) -> Result<Value> {
    let enabled = p["enabled"]
        .as_bool()
        .ok_or_else(|| AppError::new("VALIDATION", "自动备份开关无效"))?;
    let hours = p["intervalHours"]
        .as_i64()
        .filter(|v| (1..=168).contains(v))
        .ok_or_else(|| AppError::new("VALIDATION", "备份间隔需为1–168小时"))?;
    let keep = p["keep"]
        .as_i64()
        .filter(|v| (3..=100).contains(v))
        .ok_or_else(|| AppError::new("VALIDATION", "至少保留3份，最多100份自动备份"))?;
    let mut value = backup_settings(conn)?;
    value["enabled"] = json!(enabled);
    value["intervalHours"] = json!(hours);
    value["keep"] = json!(keep);
    save(conn, "backup_policy", &value)?;
    Ok(value)
}
pub(crate) fn backup_tick(db: &mut Database) -> Result<Value> {
    let mut policy = backup_settings(&db.conn)?;
    if policy["enabled"] != true {
        return Ok(json!({"created":false}));
    }
    let due = policy["lastSuccess"]
        .as_str()
        .and_then(|v| chrono::DateTime::parse_from_rfc3339(v).ok())
        .is_none_or(|at| {
            chrono::Utc::now().signed_duration_since(at).num_hours()
                >= policy["intervalHours"].as_i64().unwrap_or(24)
        });
    if !due {
        return Ok(json!({"created":false}));
    }
    let record = match backup::create(db) {
        Ok(value) => value,
        Err(e) => {
            policy["lastError"] = json!(e.message);
            save(&db.conn, "backup_policy", &policy)?;
            return Err(e);
        }
    };
    let mut ids = policy["automaticIds"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    ids.push(record["id"].clone());
    policy["automaticIds"] = json!(ids);
    policy["lastSuccess"] = json!(now());
    policy["lastError"] = Value::Null;
    save(&db.conn, "backup_policy", &policy)?;
    let cleanup = (|| -> Result<()> {
        let keep = policy["keep"].as_u64().unwrap_or(7) as usize;
        while ids.len() > keep {
            let old = ids[0].clone();
            let Some(old) = old.as_str() else {
                ids.remove(0);
                continue;
            };
            let filename: Option<String> = db
                .conn
                .query_row("SELECT filename FROM backups WHERE id=?", [old], |r| {
                    r.get(0)
                })
                .optional()?;
            if let Some(filename) = filename {
                if !backup::safe_filename(&filename) {
                    return Err(AppError::new("BACKUP_PATH", "自动备份路径无效"));
                }
                let root = db.root.join("backups").canonicalize()?;
                let candidate = root.join(filename);
                if candidate.exists() {
                    let path = candidate.canonicalize()?;
                    if path.parent() != Some(root.as_path()) {
                        return Err(AppError::new("BACKUP_PATH", "自动备份不在备份目录"));
                    }
                    std::fs::remove_file(path)?;
                }
                db.conn.execute("DELETE FROM backups WHERE id=?", [old])?;
            }
            ids.remove(0);
        }
        Ok(())
    })();
    if let Err(ref error) = cleanup {
        policy["lastError"] = json!(format!("备份成功，清理旧副本失败：{}", error.message));
    }
    policy["automaticIds"] = json!(ids);
    save(&db.conn, "backup_policy", &policy)?;
    cleanup?;
    Ok(json!({"created":true,"backup":record}))
}
pub(crate) fn notification(conn: &Connection) -> Result<Value> {
    let settings = desktop(conn)?;
    if settings["notifications"] != true {
        return Ok(Value::Null);
    }
    let now_local = chrono::Local::now();
    let time = format!("{:02}:{:02}", now_local.hour(), now_local.minute());
    let start = settings["quietStart"].as_str().unwrap_or("22:00");
    let end = settings["quietEnd"].as_str().unwrap_or("08:00");
    let quiet = if start < end {
        time.as_str() >= start && time.as_str() < end
    } else if start > end {
        time.as_str() >= start || time.as_str() < end
    } else {
        false
    };
    if quiet {
        return Ok(Value::Null);
    }
    let date = now_local.date_naive().to_string();
    let hidden = crate::daily_use::lifecycle_map(conn)?
        .into_iter()
        .filter(|v| v["kind"] == "project" && v["archived"] == true)
        .filter_map(|v| v["id"].as_str().map(str::to_owned))
        .collect::<std::collections::HashSet<_>>();
    let follow = crate::delivery::follow_up_center(conn, &json!({"date":date}))?;
    let reviews = crate::daily_use::review_queue(conn, &json!({"date":date}))?;
    let mut attention = crate::management::attention(conn, &json!({"date":date}))?;
    if let Some(items) = attention["items"].as_array_mut() {
        items.retain(|v| {
            !v["projectId"]
                .as_str()
                .is_some_and(|id| hidden.contains(id))
        });
    }
    let tasks = follow["items"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter(|item| {
                    item["snoozed"] != true
                        && !item["projectId"]
                            .as_str()
                            .is_some_and(|id| hidden.contains(id))
                })
                .map(|item| item["taskId"].clone())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let total = tasks.len()
        + reviews["total"].as_u64().unwrap_or(0) as usize
        + attention["items"].as_array().map(Vec::len).unwrap_or(0);
    if total == 0 {
        return Ok(Value::Null);
    }
    let signature = crate::hash(
        json!([date, tasks, reviews, attention["items"]])
            .to_string()
            .as_bytes(),
    );
    let previous = option(conn, "notification_receipt", json!({}))?;
    if previous["signature"] == signature {
        return Ok(Value::Null);
    }
    if previous["at"]
        .as_str()
        .and_then(|v| chrono::DateTime::parse_from_rfc3339(v).ok())
        .is_some_and(|at| chrono::Utc::now().signed_duration_since(at).num_minutes() < 30)
    {
        return Ok(Value::Null);
    }
    Ok(
        json!({"title":"项目助理 · 待处理提醒","body":format!("有{total}项任务、管理事项或到期记忆需要查看。"),"signature":signature}),
    )
}
