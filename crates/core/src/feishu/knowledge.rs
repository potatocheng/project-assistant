//! Only explicitly selected sources are read. Cursors are device-local; immutable
//! originals/provenance are committed to the workspace before a cursor advances.
use super::*;
pub(super) type Ingest = Arc<dyn Fn(&Value) -> Result<Value> + Send + Sync>;
#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(super) struct Config {
    pub enabled: bool,
    pub interval_seconds: u64,
    pub sources: Vec<Source>,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            enabled: false,
            interval_seconds: 300,
            sources: vec![],
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Source {
    kind: String,
    target: String,
    project_id: String,
    enabled: bool,
    history_days: u64,
    #[serde(default)]
    since: i64,
}
fn document_reference(raw: &str) -> Result<(String, String)> {
    let url = Url::parse(raw).map_err(|_| error("FEISHU_SOURCE", "请输入飞书文档链接"))?;
    let host = url.host_str().unwrap_or("");
    let parts = url
        .path_segments()
        .map(|s| s.collect::<Vec<_>>())
        .unwrap_or_default();
    if url.scheme() != "https"
        || !host.ends_with(".feishu.cn")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || parts.len() != 2
        || !["docx", "wiki"].contains(&parts[0])
        || !valid_token(parts[1])
    {
        return Err(error(
            "FEISHU_SOURCE",
            "仅支持飞书 /docx/ 或 /wiki/ 文档链接",
        ));
    }
    Ok((parts[0].into(), parts[1].into()))
}
fn valid_token(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 160
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
fn extend_messages(target: &mut Vec<Value>, items: Vec<Value>) -> Result<()> {
    if target.len() + items.len() > 5000
        || target
            .iter()
            .chain(items.iter())
            .map(|v| v.to_string().len())
            .sum::<usize>()
            > 8 * 1024 * 1024
    {
        return Err(error(
            "FEISHU_SYNC_LIMIT",
            "本轮消息量过大，将缩小时间窗口继续同步",
        ));
    }
    target.extend(items);
    Ok(())
}
impl Inner {
    pub(super) fn knowledge_status(&self) -> Result<Value> {
        let saved = lock(&self.state)?.saved.clone();
        let config = saved.knowledge.clone();
        let mut statuses = Vec::new();
        if let Some(session) = saved.session {
            for source in &config.sources {
                let key = self.source_key(source, &session.user.open_id);
                if let Some(raw) = self.metadata(&format!("knowledge-status:{key}"))? {
                    if let Ok(status) = serde_json::from_str::<Value>(&raw) {
                        statuses.push(status)
                    }
                }
            }
        }
        Ok(
            json!({"settings":config,"syncing":self.syncing.load(Ordering::SeqCst),"statuses":statuses,"lastError":self.metadata("knowledge-error")?}),
        )
    }
    pub(super) fn save_knowledge(&self, p: &Value) -> Result<Value> {
        let mut config: Config = serde_json::from_value(p.clone())
            .map_err(|_| error("FEISHU_SOURCE", "飞书资料设置格式无效"))?;
        if !(60..=3600).contains(&config.interval_seconds) || config.sources.len() > 50 {
            return Err(error(
                "FEISHU_SOURCE",
                "同步间隔应为 60–3600 秒，最多指定 50 个来源",
            ));
        }
        if config.enabled && !config.sources.iter().any(|source| source.enabled) {
            return Err(error(
                "FEISHU_SOURCE",
                "启用同步前请指定至少一个启用的资料来源",
            ));
        }
        let _gate = lock(&self.send_gate)?;
        let mut state = lock(&self.state)?;
        let mut seen = HashSet::new();
        for source in &mut config.sources {
            source.target = source.target.trim().into();
            if !(1..=30).contains(&source.history_days) || source.project_id.is_empty() {
                return Err(error(
                    "FEISHU_SOURCE",
                    "请选择项目，首次回看范围应为 1–30 天",
                ));
            }
            if source.kind == "chat" {
                if !valid_id(&source.target, "oc_") {
                    return Err(error("FEISHU_SOURCE", "群聊 ID 格式无效"));
                }
            } else if source.kind == "document" {
                let (kind, token) = document_reference(&source.target)?;
                let mut url = Url::parse(&source.target).unwrap();
                url.set_query(None);
                url.set_fragment(None);
                source.target = url.to_string();
                if !seen.insert(format!("{kind}:{token}")) {
                    return Err(error("FEISHU_SOURCE", "请勿重复添加同一来源"));
                }
            } else {
                return Err(error("FEISHU_SOURCE", "来源类型无效"));
            }
            if !seen.insert(source.target.clone()) {
                return Err(error("FEISHU_SOURCE", "请勿重复添加同一来源"));
            }
            source.since = state
                .saved
                .knowledge
                .sources
                .iter()
                .find(|s| {
                    s.target == source.target
                        && s.project_id == source.project_id
                        && s.history_days == source.history_days
                })
                .map(|s| s.since)
                .filter(|n| *n > 0)
                .unwrap_or_else(|| timestamp() - source.history_days as i64 * 86400);
        }
        let mut next = state.saved.clone();
        next.knowledge = config;
        next.generation = id();
        self.persist(&next)?;
        state.saved = next;
        drop(state);
        drop(_gate);
        let _ = self.wake.try_send(());
        self.knowledge_status()
    }
    pub(super) fn metadata(&self, key: &str) -> Result<Option<String>> {
        Ok(lock(&self.receipts)?
            .query_row("SELECT value FROM metadata WHERE key=?", [key], |r| {
                r.get(0)
            })
            .optional()?)
    }
    fn set_metadata(&self, key: &str, value: &str) -> Result<()> {
        lock(&self.receipts)?.execute(
            "INSERT INTO metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![key, value],
        )?;
        Ok(())
    }
    pub(super) fn source_key(&self, s: &Source, account: &str) -> String {
        format!(
            "knowledge:{}",
            crate::hash(
                json!([account, s.kind, s.target, s.project_id, s.since])
                    .to_string()
                    .as_bytes()
            )
        )
    }
    pub(super) fn sync_knowledge_if_due(&self) -> Result<()> {
        let saved = lock(&self.state)?.saved.clone();
        if !saved.knowledge.enabled || saved.session.is_none() || lock(&self.ingest)?.is_none() {
            return Ok(());
        }
        let last = self
            .metadata("knowledge-last")?
            .and_then(|s| s.parse::<i64>().ok())
            .unwrap_or(0);
        if timestamp() - last < saved.knowledge.interval_seconds as i64 {
            return Ok(());
        }
        self.sync_knowledge().map(|_| ())
    }
    pub(super) fn sync_knowledge(&self) -> Result<Value> {
        if self.syncing.swap(true, Ordering::SeqCst) {
            return Err(error("FEISHU_SYNC_BUSY", "资料正在同步"));
        }
        let result = self.sync_knowledge_inner();
        let recorded = self.set_metadata(
            "knowledge-error",
            &result
                .as_ref()
                .err()
                .filter(|e| e.code != "FEISHU_CANCELLED")
                .map(|e| format!("{}: {}", e.code, e.message))
                .unwrap_or_default(),
        );
        self.syncing.store(false, Ordering::SeqCst);
        recorded?;
        result
    }
    pub(super) fn trigger_knowledge(&self) -> Result<Value> {
        let saved = lock(&self.state)?.saved.clone();
        if !saved.knowledge.enabled || !saved.knowledge.sources.iter().any(|s| s.enabled) {
            return Err(error("FEISHU_SOURCE", "请先启用并指定至少一个资料来源"));
        }
        if saved.session.is_none() {
            return Err(error("FEISHU_NOT_CONNECTED", "请先授权飞书个人账号"));
        }
        if self.syncing.load(Ordering::SeqCst) {
            return Err(error("FEISHU_SYNC_BUSY", "资料正在同步"));
        }
        self.set_metadata("knowledge-last", "0")?;
        let _ = self.wake.try_send(());
        Ok(json!({"queued":true}))
    }
    fn sync_knowledge_inner(&self) -> Result<Value> {
        let (saved, session) = self.valid_session()?;
        if !saved.knowledge.enabled {
            return Err(error("FEISHU_SOURCE", "请先启用飞书资料同步"));
        }
        if lock(&self.ingest)?.is_none() {
            return Err(error("FEISHU_SOURCE", "资料库尚未就绪"));
        }
        self.set_metadata("knowledge-last", &timestamp().to_string())?;
        let mut failures = 0;
        let mut imported = 0;
        for source in saved.knowledge.sources.iter().filter(|s| s.enabled) {
            self.check_generation(&saved.generation, false)?;
            let key = self.source_key(source, &session.user.open_id);
            let result = if source.kind == "chat" {
                self.sync_chat(&saved, &session, source, &key)
            } else {
                self.sync_document(&saved, &session, source, &key)
            };
            let status = match result {
                Ok(n) => {
                    imported += n;
                    json!({"target":source.target,"projectId":source.project_id,"at":now(),"through":if source.kind=="chat"{self.metadata(&key)?.and_then(|v|v.parse::<i64>().ok()).map(iso)}else{None},"imported":n,"error":null})
                }
                Err(e) => {
                    if e.code == "FEISHU_CANCELLED" {
                        return Err(e);
                    }
                    failures += 1;
                    json!({"target":source.target,"projectId":source.project_id,"at":now(),"imported":0,"error":format!("{}: {}",e.code,e.message)})
                }
            };
            self.set_metadata(&format!("knowledge-status:{key}"), &status.to_string())?;
        }
        Ok(json!({"imported":imported,"failures":failures}))
    }
    fn commit_source(&self, saved: &Saved, source: &Source, payload: Value) -> Result<bool> {
        let _gate = lock(&self.send_gate)?;
        self.check_generation(&saved.generation, false)?;
        if !lock(&self.state)?
            .saved
            .knowledge
            .sources
            .iter()
            .any(|s| s.enabled && s.project_id == source.project_id && s.target == source.target)
        {
            return Err(error("FEISHU_CANCELLED", "资料来源设置已变化"));
        }
        let ingest = lock(&self.ingest)?
            .clone()
            .ok_or_else(|| error("FEISHU_SOURCE", "资料库尚未就绪"))?;
        let out = ingest(&payload)?;
        Ok(out["duplicate"] != true)
    }
    fn sync_chat(
        &self,
        saved: &Saved,
        session: &Session,
        source: &Source,
        key: &str,
    ) -> Result<usize> {
        let cursor = self
            .metadata(key)?
            .and_then(|s| s.parse::<i64>().ok())
            .unwrap_or(source.since);
        // Backfill at most one day per pass; reduce dense windows rather than
        // restarting the same overfull history forever. Cursor advances only
        // after the complete chosen window is durably imported.
        let mut end = timestamp().min(cursor + 86400);
        let messages = loop {
            let overlap_start = cursor - OVERLAP_SECONDS.min((end - cursor).max(60));
            let start = if end - cursor >= 600 {
                overlap_start.div_euclid(600) * 600
            } else {
                overlap_start
            }
            .max(source.since);
            match self.chat_window(saved, session, source, start, end) {
                Ok(messages) => break messages,
                Err(e) if e.code == "FEISHU_SYNC_LIMIT" && end - cursor > 60 => {
                    end = cursor + (end - cursor) / 2;
                }
                Err(e) => return Err(e),
            }
        };
        self.import_chat_window(saved, session, source, key, end, messages)
    }
    fn chat_window(
        &self,
        saved: &Saved,
        session: &Session,
        source: &Source,
        start: i64,
        end: i64,
    ) -> Result<Vec<Value>> {
        let mut messages =
            self.chat_messages(saved, session, "chat", &source.target, start, end)?;
        let threads = messages
            .iter()
            .filter_map(|m| m["thread_id"].as_str().filter(|s| valid_token(s)))
            .collect::<HashSet<_>>()
            .into_iter()
            .map(str::to_owned)
            .collect::<Vec<_>>();
        if threads.len() > 200 {
            return Err(error("FEISHU_SYNC_LIMIT", "话题过多，请缩短首次回看范围"));
        }
        for thread in threads {
            extend_messages(
                &mut messages,
                self.chat_messages(saved, session, "thread", &thread, start, end)?,
            )?;
        }
        // Chat history returns topic roots. Search also discovers new replies to
        // roots older than the initial lookback, so those replies are not missed.
        extend_messages(
            &mut messages,
            self.search_chat_messages(saved, session, source, start, end)?,
        )?;
        Ok(messages)
    }
    fn import_chat_window(
        &self,
        saved: &Saved,
        session: &Session,
        source: &Source,
        key: &str,
        end: i64,
        messages: Vec<Value>,
    ) -> Result<usize> {
        let mut count = 0;
        let mut seen = HashSet::new();
        let mut bundles = std::collections::BTreeMap::<i64, Vec<Value>>::new();
        for message in messages {
            if message["chat_id"]
                .as_str()
                .is_some_and(|chat| chat != source.target)
            {
                return Err(error(
                    "FEISHU_RESPONSE",
                    "消息所属群与指定来源不一致，本轮未推进游标",
                ));
            }
            let Some(message_id) = message["message_id"]
                .as_str()
                .filter(|s| valid_id(s, "om_"))
            else {
                continue;
            };
            if !seen.insert(message_id.to_owned())
                || message["deleted"] == true
                || message["sender"]["sender_type"] != "user"
            {
                continue;
            }
            // A reply whose send result was unknown is still excluded by its visible prefix.
            let own_reply: bool = lock(&self.receipts)?.query_row(
                "SELECT EXISTS(SELECT 1 FROM receipts WHERE reply_id=?)",
                [message_id],
                |r| r.get(0),
            )?;
            if own_reply {
                continue;
            }
            let Some(text) = message_text(&message) else {
                continue;
            };
            let author = message["sender"]["id"].as_str().unwrap_or("未记录作者");
            if author == session.user.open_id {
                let generated:bool=lock(&self.receipts)?.query_row("SELECT EXISTS(SELECT 1 FROM receipts WHERE account=? AND chat_id=? AND answer=? AND status IN ('sending','unknown','replied'))",params![session.user.open_id,source.target,text],|r|r.get(0))?;
                if generated {
                    continue;
                }
            }
            if author == session.user.open_id
                && !saved.reply_prefix.trim().is_empty()
                && text.starts_with(saved.reply_prefix.trim())
            {
                continue;
            }
            let occurred = message["create_time"]
                .as_str()
                .and_then(|s| s.parse::<i64>().ok())
                .or_else(|| message["create_time"].as_i64())
                .ok_or_else(|| error("FEISHU_RESPONSE", "消息缺少发生时间"))?;
            let seconds = if occurred > 10_000_000_000 {
                occurred / 1000
            } else {
                occurred
            };
            let revision = crate::hash(message["body"].to_string().as_bytes());
            bundles.entry(seconds.div_euclid(600)*600).or_default().push(json!({"messageId":message_id,"at":iso(seconds),"seconds":seconds,"author":author,"text":text,"revision":revision}));
        }
        for (bucket, mut messages) in bundles {
            messages.sort_by(|a, b| {
                a["seconds"]
                    .as_i64()
                    .cmp(&b["seconds"].as_i64())
                    .then_with(|| a["messageId"].as_str().cmp(&b["messageId"].as_str()))
            });
            let revision = crate::hash(json!(messages).to_string().as_bytes());
            let text = messages
                .iter()
                .map(|m| {
                    format!(
                        "[{}] {} · {}\n{}",
                        m["at"].as_str().unwrap(),
                        m["author"].as_str().unwrap(),
                        m["messageId"].as_str().unwrap(),
                        m["text"].as_str().unwrap()
                    )
                })
                .collect::<Vec<_>>()
                .join("\n\n");
            let occurred = messages[0]["at"].as_str().unwrap();
            let payload = json!({"projectId":source.project_id,"title":format!("飞书群 · {} · {}",source.target,iso(bucket)),"sourceAt":occurred,"text":text,"origin":{"provider":"feishu_chat","remoteId":format!("{}:{bucket}",source.target),"remoteRevision":revision,"url":format!("https://applink.feishu.cn/client/chat/open?openChatId={}",source.target),"author":"群成员（各条发言人见原文）","occurredAt":occurred,"fetchedAt":now()}});
            if self.commit_source(saved, source, payload)? {
                count += 1
            }
        }
        let _gate = lock(&self.send_gate)?;
        self.check_generation(&saved.generation, false)?;
        self.set_metadata(key, &end.to_string())?;
        Ok(count)
    }
    fn chat_messages(
        &self,
        saved: &Saved,
        session: &Session,
        kind: &str,
        target: &str,
        start: i64,
        end: i64,
    ) -> Result<Vec<Value>> {
        let mut items = Vec::new();
        let mut page = String::new();
        let mut seen = HashSet::new();
        for _ in 0..40 {
            self.check_generation(&saved.generation, false)?;
            let mut query = vec![
                ("container_id_type".into(), kind.into()),
                ("container_id".into(), target.into()),
                ("start_time".into(), start.to_string()),
                ("end_time".into(), end.to_string()),
                ("sort_type".into(), "ByCreateTimeAsc".into()),
                ("page_size".into(), "50".into()),
            ];
            if !page.is_empty() {
                query.push(("page_token".into(), page.clone()));
            }
            let data = self.api.json(
                Method::GET,
                "/open-apis/im/v1/messages",
                &query,
                Some(&session.access_token),
                None,
            )?;
            extend_messages(&mut items, required_items(&data)?.to_vec())?;
            if !has_more(&data)? {
                return Ok(items);
            }
            page = next_page(&data)?;
            if !seen.insert(page.clone()) {
                break;
            }
        }
        Err(error(
            "FEISHU_SYNC_LIMIT",
            "消息超过单轮分页限制，未推进游标，请缩短首次回看范围",
        ))
    }
    fn search_chat_messages(
        &self,
        saved: &Saved,
        session: &Session,
        source: &Source,
        start: i64,
        end: i64,
    ) -> Result<Vec<Value>> {
        let body = json!({"query":"","filter":{"chat_ids":[source.target],"from_types":["user"],"time_range":{"start_time":iso(start),"end_time":iso(end)}}});
        let mut messages = Vec::new();
        let mut page = String::new();
        let mut pages = HashSet::new();
        for _ in 0..40 {
            self.check_generation(&saved.generation, false)?;
            let mut query = vec![("page_size".into(), "50".into())];
            if !page.is_empty() {
                query.push(("page_token".into(), page.clone()));
            }
            let data = self.api.json(
                Method::POST,
                "/open-apis/im/v1/messages/search",
                &query,
                Some(&session.access_token),
                Some(&body),
            )?;
            let ids = required_items(&data)?
                .iter()
                .map(|item| {
                    item["meta_data"]["message_id"]
                        .as_str()
                        .filter(|s| valid_id(s, "om_"))
                        .map(str::to_owned)
                        .ok_or_else(|| {
                            error("FEISHU_RESPONSE", "搜索结果缺少消息 ID，未推进同步游标")
                        })
                })
                .collect::<Result<Vec<_>>>()?;
            if !ids.is_empty() {
                let query = ids
                    .iter()
                    .map(|id| ("message_ids".into(), id.clone()))
                    .collect::<Vec<_>>();
                let details = self.api.json(
                    Method::GET,
                    "/open-apis/im/v1/messages/mget",
                    &query,
                    Some(&session.access_token),
                    None,
                )?;
                let items = required_items(&details)?;
                if ids
                    .iter()
                    .any(|id| !items.iter().any(|m| m["message_id"] == *id))
                {
                    return Err(error(
                        "FEISHU_RESPONSE",
                        "部分搜索消息未能读取，未推进同步游标",
                    ));
                }
                extend_messages(
                    &mut messages,
                    items
                        .iter()
                        .filter(|m| ids.iter().any(|id| m["message_id"] == *id))
                        .cloned()
                        .collect(),
                )?;
            }
            if !has_more(&data)? {
                return Ok(messages);
            }
            page = next_page(&data)?;
            if !pages.insert(page.clone()) {
                break;
            }
        }
        Err(error(
            "FEISHU_SYNC_LIMIT",
            "消息搜索分页未完成，未推进同步游标",
        ))
    }
    fn sync_document(
        &self,
        saved: &Saved,
        session: &Session,
        source: &Source,
        key: &str,
    ) -> Result<usize> {
        let (kind, mut token) = document_reference(&source.target)?;
        if kind == "wiki" {
            let data = self.api.json(
                Method::GET,
                "/open-apis/wiki/v2/spaces/get_node",
                &[("token".into(), token)],
                Some(&session.access_token),
                None,
            )?;
            if data["node"]["obj_type"] != "docx" {
                return Err(error(
                    "FEISHU_SOURCE",
                    "该知识库节点不是新版文档，目前支持 docx 正文",
                ));
            }
            token = crate::required(&data["node"], "obj_token")?.into();
            if !valid_token(&token) {
                return Err(error("FEISHU_RESPONSE", "文档标识无效"));
            }
        }
        let path = format!("/open-apis/docx/v1/documents/{token}");
        let before = self
            .api
            .json(Method::GET, &path, &[], Some(&session.access_token), None)?;
        let revision = before["document"]["revision_id"]
            .as_i64()
            .ok_or_else(|| error("FEISHU_RESPONSE", "文档缺少版本号"))?
            .to_string();
        let version = format!("{token}:{revision}");
        if self.metadata(key)?.as_deref() == Some(&version) {
            return Ok(0);
        }
        thread::sleep(Duration::from_millis(220));
        let body = self.api.json(
            Method::GET,
            &format!("{path}/raw_content"),
            &[],
            Some(&session.access_token),
            None,
        )?;
        thread::sleep(Duration::from_millis(220));
        let after = self
            .api
            .json(Method::GET, &path, &[], Some(&session.access_token), None)?;
        if before["document"]["revision_id"] != after["document"]["revision_id"] {
            return Err(error(
                "FEISHU_DOCUMENT_CHANGED",
                "读取期间文档发生编辑，本次未入库，下轮重新读取",
            ));
        }
        let text = crate::required(&body, "content")?;
        if text.len() > 2 * 1024 * 1024 {
            return Err(error("FEISHU_SYNC_LIMIT", "文档正文超过 2 MiB，请拆分文档"));
        }
        let title = before["document"]["title"]
            .as_str()
            .unwrap_or("飞书文档")
            .chars()
            .take(260)
            .collect::<String>();
        let n=self.commit_source(saved,source,json!({"projectId":source.project_id,"title":title,"text":text,"origin":{"provider":"feishu_document","remoteId":token,"remoteRevision":revision,"url":source.target,"author":"飞书文档（正文接口不提供作者）","occurredAt":"未提供，以文档版本号识别先后","fetchedAt":now()}}))?;
        let _gate = lock(&self.send_gate)?;
        self.check_generation(&saved.generation, false)?;
        self.set_metadata(key, &version)?;
        Ok(usize::from(n))
    }
}
fn message_text(m: &Value) -> Option<String> {
    let body: Value = serde_json::from_str(m["body"]["content"].as_str()?).ok()?;
    let mentions = m["mentions"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    let mut text = match m["msg_type"]
        .as_str()
        .or_else(|| m["message_type"].as_str())?
    {
        "text" => body["text"].as_str()?.to_owned(),
        "post" => post_question(&body, mentions, "")?,
        _ => return None,
    };
    for mention in mentions {
        if let Some(key) = mention["key"].as_str() {
            text = text.replace(key, mention["name"].as_str().unwrap_or("成员"));
        }
    }
    let text = text.trim().to_owned();
    if text.is_empty() || text.len() > 64 * 1024 {
        None
    } else {
        Some(text)
    }
}
