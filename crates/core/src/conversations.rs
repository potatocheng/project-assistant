use crate::{id, now, required, AppError, Engine, Request, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

pub(crate) fn dispatch(conn: &Connection, command: &str, p: &Value) -> Result<Value> {
    match command {
        "list_conversations" => {
            let mut stmt=conn.prepare("SELECT json_object('id',id,'projectId',project_id,'title',title,'updatedAt',updated_at) FROM assistant_sessions WHERE (?1 IS NULL OR coalesce(project_id,'')=?1) ORDER BY updated_at DESC,id LIMIT 100 OFFSET ?2")?;
            let rows = stmt
                .query_map(
                    params![
                        p["projectId"].as_str(),
                        p["offset"].as_i64().unwrap_or(0).max(0)
                    ],
                    |r| r.get::<_, String>(0),
                )?
                .map(|r| {
                    serde_json::from_str::<Value>(&r?)
                        .map_err(|_| AppError::new("DATABASE", "会话格式无效"))
                })
                .collect::<Result<Vec<_>>>()?;
            Ok(json!(rows))
        }
        "create_conversation" => {
            let project = p["projectId"].as_str().filter(|v| !v.is_empty());
            let title = p["title"]
                .as_str()
                .unwrap_or("新对话")
                .chars()
                .take(100)
                .collect::<String>();
            let session = id();
            let at = now();
            conn.execute(
                "INSERT INTO assistant_sessions VALUES(?,?,?,?,?)",
                params![session, project, title, at, at],
            )?;
            Ok(json!({"id":session,"projectId":project,"title":title,"updatedAt":at}))
        }
        "get_conversation" => {
            let session = required(p, "sessionId")?;
            let project: Option<String> = conn.query_row(
                "SELECT project_id FROM assistant_sessions WHERE id=?",
                [session],
                |r| r.get(0),
            )?;
            let mut stmt=conn.prepare("SELECT id,question,resolved_question,answer,favorite,created_at FROM (SELECT rowid,* FROM assistant_turns WHERE session_id=? ORDER BY rowid DESC LIMIT 100 OFFSET ?2) ORDER BY rowid")?;
            let offset = p["offset"].as_i64().unwrap_or(0).max(0);
            let total: i64 = conn.query_row(
                "SELECT count(*) FROM assistant_turns WHERE session_id=?",
                [session],
                |r| r.get(0),
            )?;
            let turns=stmt.query_map(params![session,offset],|r|Ok(json!({"id":r.get::<_,String>(0)?,"question":r.get::<_,String>(1)?,"resolvedQuestion":r.get::<_,String>(2)?,"answer":serde_json::from_str::<Value>(&r.get::<_,String>(3)?).unwrap_or(Value::Null),"favorite":r.get::<_,bool>(4)?,"createdAt":r.get::<_,String>(5)?})))?.collect::<std::result::Result<Vec<_>,_>>()?;
            Ok(
                json!({"id":session,"projectId":project,"turns":turns,"total":total,"offset":offset}),
            )
        }
        "favorite_answer" => {
            let value = p["favorite"]
                .as_bool()
                .ok_or_else(|| AppError::new("VALIDATION", "收藏状态无效"))?;
            if conn.execute(
                "UPDATE assistant_turns SET favorite=? WHERE id=?",
                params![value, required(p, "turnId")?],
            )? != 1
            {
                return Err(AppError::new("NOT_FOUND", "回答不存在"));
            }
            Ok(json!({"saved":true}))
        }
        "_prepare_conversation_question" => {
            let session = required(p, "sessionId")?;
            let project: Option<String> = conn.query_row(
                "SELECT project_id FROM assistant_sessions WHERE id=?",
                [session],
                |r| r.get(0),
            )?;
            let question = required(p, "question")?;
            if question.chars().count() > 1500 {
                return Err(AppError::new("VALIDATION", "问题最多1500字"));
            }
            let previous:Option<String>=conn.query_row("SELECT resolved_question FROM assistant_turns WHERE session_id=? ORDER BY rowid DESC LIMIT 1",[session],|r|r.get(0)).optional()?;
            let subject = p["subject"].as_str().unwrap_or("").trim();
            if subject.chars().count() > 300 {
                return Err(AppError::new("VALIDATION", "追问对象最多300字"));
            }
            let resolved = if p["followUp"] == true && previous.is_some() && !subject.is_empty() {
                format!("针对「{subject}」，{question}")
            } else {
                question.to_owned()
            };
            Ok(
                json!({"projectId":project,"question":resolved,"useModel":p["useModel"],"date":p["date"]}),
            )
        }
        "_save_conversation_answer" => {
            let session = required(p, "sessionId")?;
            let turn = required(p, "turnId")?;
            if p["answer"].to_string().len() > 2_000_000 {
                return Err(AppError::new("VALIDATION", "回答超出保存容量"));
            }
            conn.execute(
                "INSERT INTO assistant_turns VALUES(?,?,?,?,?,0,?)",
                params![
                    turn,
                    session,
                    required(p, "question")?,
                    required(p, "resolvedQuestion")?,
                    p["answer"].to_string(),
                    now()
                ],
            )?;
            conn.execute("UPDATE assistant_sessions SET title=CASE WHEN title='新对话' THEN ? ELSE title END,updated_at=? WHERE id=?",params![required(p,"question")?.chars().take(80).collect::<String>(),now(),session])?;
            Ok(json!({"turnId":turn}))
        }
        _ => Err(AppError::new("UNKNOWN_COMMAND", "未知会话操作")),
    }
}

pub(crate) fn ask(engine: &Engine, p: &Value) -> Result<Value> {
    let prepared = engine.call(Request {
        command: "_prepare_conversation_question".into(),
        payload: p.clone(),
    })?;
    // History is navigation only. Old answers never enter the evidence pack.
    let answer = crate::assistant_qa::ask(engine, &prepared)?;
    let turn = id();
    engine.call(Request{command:"_save_conversation_answer".into(),payload:json!({"sessionId":p["sessionId"],"turnId":turn,"question":p["question"],"resolvedQuestion":prepared["question"],"answer":answer,"workspaceEpoch":prepared["workspaceEpoch"]})})?;
    Ok(json!({"turnId":turn,"answer":answer,"resolvedQuestion":prepared["question"]}))
}
