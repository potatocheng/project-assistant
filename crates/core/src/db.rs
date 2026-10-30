use crate::tasks;
use crate::{
    ai, backup, hash, id, now, parse::ParsedSegment, required, settings, AppError, Request, Result,
};
use base64::Engine as _;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::{fs, path::PathBuf};

pub(crate) const SCHEMA_VERSION: i64 = 12;
pub(crate) struct ParseTask {
    pub path: PathBuf,
    pub kind: String,
    pub generation: i64,
}
pub(crate) struct AiTask {
    pub settings: settings::SavedSettings,
    pub project_context: Value,
    pub segments: Vec<ai::SourceSegment>,
    pub generation: i64,
    pub checkpoints: Vec<ai::ExtractionCheckpoint>,
}
pub(crate) struct Database {
    pub conn: Connection,
    pub root: PathBuf,
    pub epoch: u64,
    pub recovered_jobs: usize,
}

impl Database {
    pub fn open(root: PathBuf) -> Result<Self> {
        fs::create_dir_all(root.join("originals"))?;
        fs::create_dir_all(root.join("backups"))?;
        let root = fs::canonicalize(root)?;
        backup::recover_interrupted(&root)?;
        let conn = Connection::open(root.join("workspace.sqlite"))?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;",
        )?;
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version > SCHEMA_VERSION {
            return Err(AppError::new(
                "SCHEMA_VERSION",
                "工作区版本较新，请升级应用",
            ));
        }
        migrate(&conn)?;
        conn.execute("UPDATE memory_runs SET status='cancelled',message='应用重启，等待重新整理',updated_at=? WHERE status='running'",[now()])?;
        let recovered_jobs = conn.execute("UPDATE jobs SET status='queued',stage='等待恢复',recovered=1,generation=generation+1,updated_at=? WHERE status IN ('queued','running')", [now()])?;
        Ok(Self {
            conn,
            root,
            epoch: 0,
            recovered_jobs,
        })
    }
    pub fn execute(&mut self, request: Request) -> Result<Value> {
        if self.root.join("restore-journal.json").exists() {
            return Err(AppError::new(
                "RESTORE_RECOVERY",
                "恢复尚未完成，请关闭并重新打开工作区以自动回滚",
            ));
        }
        let p = request.payload;
        match request.command.as_str() {
            "list_conversations"
            | "create_conversation"
            | "get_conversation"
            | "favorite_answer"
            | "_prepare_conversation_question" => {
                let mut result = crate::conversations::dispatch(&self.conn, &request.command, &p)?;
                if request.command == "_prepare_conversation_question" {
                    result["workspaceEpoch"] = json!(self.epoch);
                }
                Ok(result)
            }
            "_save_conversation_answer" => {
                if p["workspaceEpoch"].as_u64() != Some(self.epoch) {
                    return Err(AppError::new("CONTEXT_STALE", "工作区已恢复，请重新提问"));
                }
                crate::conversations::dispatch(&self.conn, &request.command, &p)
            }
            "search_workspace" => crate::daily_use::search(&self.conn, &p),
            "get_desktop_settings" => crate::workspace_policy::desktop(&self.conn),
            "save_desktop_settings" => crate::workspace_policy::save_desktop(&self.conn, &p),
            "get_backup_policy" => crate::workspace_policy::backup_settings(&self.conn),
            "save_backup_policy" => crate::workspace_policy::save_backup_settings(&self.conn, &p),
            "run_automatic_backup" => crate::workspace_policy::backup_tick(self),
            "get_notification_digest" => crate::workspace_policy::notification(&self.conn),
            "ack_notification" => {
                crate::workspace_policy::save(
                    &self.conn,
                    "notification_receipt",
                    &json!({"signature":required(&p,"signature")?,"at":now()}),
                )?;
                Ok(json!({}))
            }
            "get_workspace_revision" => {
                Ok(json!({"revision":format!("{}:{}",self.epoch,self.conn.total_changes())}))
            }
            "get_draft" => crate::daily_use::draft(&self.conn, &p),
            "save_draft" => crate::daily_use::save_draft(&self.conn, &p, false),
            "delete_draft" => crate::daily_use::save_draft(&self.conn, &p, true),
            "get_retention_reviews" => crate::daily_use::review_queue(&self.conn, &p),
            "review_retention" => self.review_retention(&p),
            "lifecycle_impact" => crate::daily_use::lifecycle_impact(&self.conn, &p),
            "set_lifecycle" => crate::daily_use::set_lifecycle(&mut self.conn, &p),
            "get_assistant_preferences"
            | "save_assistant_preferences"
            | "clear_assistant_preferences"
            | "get_project_brief"
            | "generate_project_brief"
            | "get_memory_quality"
            | "check_memory_quality"
            | "assess_extraction" => {
                crate::memory_workbench::dispatch(&self.conn, &request.command, &p)
            }
            "get_governance_workspace"
            | "get_governance_item"
            | "save_governance_item"
            | "record_governance_progress" => {
                let mut value = crate::governance::dispatch(&mut self.conn, &request.command, &p)?;
                if request.command == "get_governance_workspace" {
                    crate::daily_use::filter_context(&self.conn, &mut value)?;
                }
                Ok(value)
            }
            "get_change_acceptance"
            | "save_change_request"
            | "transition_change_request"
            | "save_deliverable"
            | "review_deliverable"
            | "delete_change_request"
            | "delete_deliverable" => {
                let mut value =
                    crate::change_control::dispatch(&mut self.conn, &request.command, &p)?;
                if request.command == "get_change_acceptance" {
                    crate::daily_use::filter_context(&self.conn, &mut value)?;
                }
                Ok(value)
            }
            "coordination_list"
            | "coordination_generate_report"
            | "coordination_get_report"
            | "coordination_save_report"
            | "coordination_save_meeting"
            | "coordination_prepare_meeting"
            | "coordination_get_meeting"
            | "coordination_save_action"
            | "coordination_confirm_action" => {
                let mut value =
                    crate::coordination::dispatch(&mut self.conn, &request.command, &p)?;
                if request.command == "coordination_list" {
                    crate::daily_use::filter_context(&self.conn, &mut value)?;
                }
                Ok(value)
            }
            "get_management_attention" => crate::management::attention(&self.conn, &p),
            "get_delivery_overview"
            | "save_project_profile"
            | "save_milestone"
            | "get_follow_up_center"
            | "record_follow_up"
            | "snooze_follow_up" => crate::delivery::dispatch(&mut self.conn, &request.command, &p),
            "_assistance_context" => {
                let mut snapshot = crate::assistance::capture(&self.conn, &p)?;
                snapshot["workspaceEpoch"] = json!(self.epoch);
                snapshot["modelRevision"] = json!(settings::load(&self.root)?.revision);
                Ok(snapshot)
            }
            "_validate_assistance_context" => {
                let current = crate::assistance::capture(&self.conn, &p["request"])?;
                if current["fingerprint"] != p["fingerprint"]
                    || p["workspaceEpoch"].as_u64() != Some(self.epoch)
                    || p["modelRevision"] != settings::load(&self.root)?.revision
                {
                    return Err(AppError::new(
                        "ASSISTANCE_STALE",
                        "项目资料或模型已变化，请重新分析",
                    ));
                }
                Ok(json!({"valid":true}))
            }
            "_assistant_context" => {
                let mut context = crate::assistant_qa::retrieve(&self.conn, &p)?;
                context["workspaceEpoch"] = json!(self.epoch);
                Ok(context)
            }
            "_validate_assistant_context" => {
                if p["workspaceEpoch"].as_u64() != Some(self.epoch)
                    || p["modelRevision"].as_str()
                        != Some(settings::load(&self.root)?.revision.as_str())
                {
                    return Err(AppError::new(
                        "ASSISTANT_CONTEXT_STALE",
                        "项目或模型配置已更新，请重新提问",
                    ));
                }
                crate::assistant_qa::validate(&self.conn, &p)
            }
            "_planning_snapshot" => self.planning_snapshot(&p),
            "_save_planning_draft" => self.save_planning_draft(&p),
            "preview_task_relation" => self.preview_task_relation(&p),
            "get_daily_planning" => self.planning_overview(&p),
            "save_daily_capacity" => self.save_planning_capacity(&p),
            "save_task_estimate" => self.save_task_estimate(&p),
            "remove_task_relation" => self.remove_task_relation(&p),
            "generate_daily_plan" => self.generate_daily_plan(&p),
            "confirm_planning_draft" => self.confirm_planning_draft(&p),
            "dismiss_planning_draft" => self.dismiss_planning_draft(&p),
            "recompare_memory_review" => self.recompare_memory_review(&p),
            "get_memory_maintenance" => self.memory_status(),
            "_memory_policy" => self.memory_policy(),
            "save_memory_maintenance" => self.save_memory_settings(&p),
            "resolve_memory_review" => {
                let mut p = p.clone();
                p["automatic"] = json!(false);
                self.resolve_memory_review(&p)
            }
            "retry_memory_maintenance" => {
                self.conn.execute("UPDATE memory_runs SET status='cancelled',message='用户请求重试',updated_at=? WHERE status='failed'",[now()])?;
                Ok(json!({"queued":true}))
            }
            "_ingest_remote" => self.ingest_remote(&p),
            "_memory_alive" => Ok(json!(self.maintenance_alive(&p)?)),
            "_memory_reserve" => Ok(json!(self.reserve_memory_call(&p)?)),
            "_memory_cancel" => {
                self.cancel_memory_run(required(&p, "run")?, p["job"].as_str())?;
                Ok(json!({}))
            }
            "get_state" => self.state(),
            "create_project" => self.create_project(&p),
            "import_text" => self.import(&p, true),
            "import_file" => self.import(&p, false),
            "get_source" => self.source_detail(required(&p, "sourceId")?),
            "create_proposal" => self.create_proposal(&p),
            "confirm_proposal" => self.confirm(required(&p, "proposalId")?),
            "reject_proposal" => self.reject(required(&p, "proposalId")?),
            "get_memory" => self.memory_detail(required(&p, "memoryId")?),
            "revise_memory" => self.revise(&p),
            "get_ai_settings" => Ok(settings::load(&self.root)?.public()),
            "save_ai_settings" => self.save_ai_settings(&p),
            "start_extraction" => self.start_extraction(required(&p, "sourceId")?),
            "retry_extraction" => self.retry_extraction(required(&p, "jobId")?),
            "review_extraction_draft" => crate::extraction_store::review(self, &p),
            "cancel_extraction" => self.cancel_extraction(required(&p, "jobId")?),
            "update_proposal" => self.update_proposal(&p),
            "create_backup" => backup::create(self),
            "inspect_backup" => backup::inspect(self, &p),
            "restore_backup" => backup::restore(self, &p),
            "_pending" => self.pending(),
            "_pending_extract" => self.pending_extract(),
            "_retrieve_qa_context" => {
                let mut context = crate::qa::retrieve(&self.conn, &p)?;
                context["workspaceEpoch"] = json!(self.epoch);
                Ok(context)
            }
            "_validate_qa_context" => {
                if p["workspaceEpoch"].as_u64() != Some(self.epoch)
                    || p["modelRevision"].as_str()
                        != Some(settings::load(&self.root)?.revision.as_str())
                {
                    return Err(AppError::new(
                        "QA_CONTEXT_STALE",
                        "项目或模型配置已更新，请重新提问",
                    ));
                }
                crate::qa::validate(&self.conn, &p)
            }
            "_validate_feishu_bindings" => {
                let bindings = p["bindings"]
                    .as_array()
                    .ok_or_else(|| AppError::new("VALIDATION", "请提供飞书群与项目绑定列表"))?;
                for binding in bindings {
                    self.ensure_project(required(binding, "projectId")?)?;
                }
                Ok(json!({"valid":true}))
            }
            _ => tasks::dispatch(&mut self.conn, &request.command, &p),
        }
    }
    fn state(&self) -> Result<Value> {
        let workflow = tasks::state(&self.conn)?;
        let proposals = self
            .all(PROPOSAL_SELECT, proposal_row)?
            .into_iter()
            .map(|mut p| {
                p["segmentIds"] = self.proposal_segments(p["id"].as_str().unwrap())?;
                p["facets"] = crate::memory_facts::proposal(&self.conn, p["id"].as_str().unwrap())?;
                p["retention"] = crate::retention::proposal(&self.conn, p["id"].as_str().unwrap())?;
                Ok(p)
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(json!({
            "workspace": { "dataDir": self.root, "schemaVersion": SCHEMA_VERSION, "recoveredJobs": self.recovered_jobs, "revision":format!("{}:{}",self.epoch,self.conn.total_changes()) },
            "lifecycle":crate::daily_use::lifecycle_map(&self.conn)?,
            "managementRevision":crate::management::revision(&self.conn)?,
            "assistanceRevision":crate::assistance::revision(&self.conn)?,
            "assistantPreferenceVersion":crate::memory_workbench::preferences(&self.conn)?["version"],
            "aiSettings": settings::load(&self.root)?.public(),
            "memoryReviewCount":self.conn.query_row("SELECT count(*) FROM memory_reviews r JOIN proposals p ON p.id=r.proposal_id WHERE r.status='pending' AND p.status='pending'",[],|r|r.get::<_,i64>(0))?,
            "tasks":workflow["tasks"],"taskProposals":workflow["taskProposals"],"reports":workflow["reports"],
            "projects": self.all("SELECT id,name,description,created_at FROM projects ORDER BY created_at DESC", project_row)?,
            "sources": self.all(SOURCE_SELECT, source_row)?,
            "proposals": proposals,
            "extractionDrafts":crate::extraction_store::state(&self.conn)?,
            "extractionBatches":crate::extraction_store::batch_state(&self.conn)?,
            "memories": self.all(MEMORY_SELECT, memory_row)?,
            "jobs": self.all(JOB_SELECT, job_row)?,
            "backups": self.all("SELECT id,filename,created_at,byte_size,sha256,counts FROM backups ORDER BY created_at DESC", backup_row)?.into_iter().filter(|b| b["filename"].as_str().is_some_and(|f| backup::safe_filename(f) && self.root.join("backups").join(f).is_file())).collect::<Vec<_>>()
        }))
    }
    pub fn counts(&self) -> Result<Value> {
        Ok(json!({
            "projects": self.conn.query_row("SELECT count(*) FROM projects", [], |r| r.get::<_,i64>(0))?,
            "sources": self.conn.query_row("SELECT count(*) FROM sources", [], |r| r.get::<_,i64>(0))?,
            "memories": self.conn.query_row("SELECT count(*) FROM memories", [], |r| r.get::<_,i64>(0))?,
            "tasks":self.conn.query_row("SELECT count(*) FROM tasks",[],|row|row.get::<_,i64>(0))?,
            "reports":self.conn.query_row("SELECT count(*) FROM daily_reports",[],|row|row.get::<_,i64>(0))?
        }))
    }
    fn all(
        &self,
        sql: &str,
        mapper: fn(&rusqlite::Row<'_>) -> rusqlite::Result<Value>,
    ) -> Result<Vec<Value>> {
        let mut stmt = self.conn.prepare(sql)?;
        let rows = stmt
            .query_map([], mapper)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }
    fn create_project(&self, p: &Value) -> Result<Value> {
        let name = required(p, "name")?.trim();
        if name.chars().count() > 100 {
            return Err(AppError::new("VALIDATION", "项目名称最多 100 字"));
        }
        let description = p["description"].as_str().unwrap_or("");
        let (id, at) = (id(), now());
        self.conn.execute(
            "INSERT INTO projects VALUES (?,?,?,?)",
            params![id, name, description, at],
        )?;
        Ok(json!({"id":id,"name":name,"description":description,"createdAt":at}))
    }
    fn ensure_project(&self, project: &str) -> Result<()> {
        if !self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM projects WHERE id=?)",
            [project],
            |r| r.get::<_, bool>(0),
        )? {
            return Err(AppError::new("NOT_FOUND", "项目不存在"));
        }
        Ok(())
    }
    pub(crate) fn import(&mut self, p: &Value, text: bool) -> Result<Value> {
        let project = required(p, "projectId")?;
        self.ensure_project(project)?;
        let (filename, title, kind, bytes) = if text {
            let title = required(p, "title")?.trim().to_owned();
            (
                format!("{title}.txt"),
                title,
                "txt".to_owned(),
                required(p, "text")?.as_bytes().to_vec(),
            )
        } else {
            let name = required(p, "filename")?;
            let filename = std::path::Path::new(name)
                .file_name()
                .and_then(|n| n.to_str())
                .filter(|s| !s.is_empty())
                .ok_or_else(|| AppError::new("VALIDATION", "文件名无效"))?
                .to_owned();
            let kind = filename
                .rsplit('.')
                .next()
                .unwrap_or("")
                .to_ascii_lowercase();
            if !matches!(kind.as_str(), "txt" | "md" | "docx" | "pdf") {
                return Err(AppError::new(
                    "UNSUPPORTED_FILE",
                    "支持 TXT、MD、DOCX 和文本 PDF",
                ));
            }
            let encoded = required(p, "contentBase64")?;
            if encoded.len() > 14 * 1024 * 1024 {
                return Err(AppError::new("FILE_TOO_LARGE", "单个文件最多 10 MiB"));
            }
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .map_err(|_| AppError::new("VALIDATION", "文件编码无效"))?;
            (filename.clone(), filename, kind, bytes)
        };
        if bytes.is_empty() || bytes.len() > 10 * 1024 * 1024 {
            return Err(AppError::new(
                "FILE_TOO_LARGE",
                "文件不能为空，且最多 10 MiB",
            ));
        }
        if title.chars().count() > 300 {
            return Err(AppError::new("VALIDATION", "资料名称最多 300 字"));
        }
        let source_at = p["sourceAt"].as_str().filter(|s| !s.is_empty());
        if let Some(at) = source_at {
            if chrono::DateTime::parse_from_rfc3339(at).is_err()
                && chrono::NaiveDate::parse_from_str(at, "%Y-%m-%d").is_err()
            {
                return Err(AppError::new("VALIDATION", "资料发生日期格式无效"));
            }
        }
        let sha = hash(&bytes);
        if let Some((source, job)) = self.conn.query_row("SELECT s.id,j.id FROM sources s JOIN jobs j ON j.source_id=s.id WHERE s.project_id=? AND s.sha256=? LIMIT 1", params![project,sha], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).optional()? {
            return Ok(json!({"sourceId":source,"jobId":job,"duplicate":true}));
        }
        let (source, job, at) = (id(), id(), now());
        let relative = format!("originals/{source}.{kind}");
        let path = self.root.join(&relative);
        fs::write(&path, &bytes)?;
        crate::sync_file(&path)?;
        crate::sync_directory(&self.root.join("originals"))?;
        let configuration = settings::load(&self.root)?;
        let auto_extract = configuration.auto_extract
            && p["deferExtraction"] != true
            && configuration.validate_material_access().is_ok();
        let tx = self.conn.transaction()?;
        let written = (|| -> Result<()> {
            tx.execute("INSERT INTO sources (id,project_id,title,kind,original_filename,source_at,imported_at,sha256,status,segment_count,error,original_path) VALUES (?,?,?,?,?,?,?,?, 'processing',0,NULL,?)",params![source,project,title,kind,filename,source_at,at,sha,relative])?;
            tx.execute("INSERT INTO jobs (id,kind,status,stage,error,source_id,created_at,updated_at,recovered,auto_extract,config_revision) VALUES (?,'import','queued','等待解析',NULL,?,?,?,0,?,?)",params![job,source,at,at,auto_extract,configuration.revision])?;
            Ok(())
        })();
        if let Err(error) = written {
            drop(tx);
            let _ = fs::remove_file(path);
            return Err(error);
        }
        tx.commit()?;
        Ok(json!({"sourceId":source,"jobId":job,"duplicate":false}))
    }
    pub fn pending(&self) -> Result<Value> {
        let mut stmt = self
            .conn
            .prepare("SELECT id FROM jobs WHERE kind='import' AND status='queued' ORDER BY created_at LIMIT 1")?;
        let ids = stmt
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(json!(ids
            .into_iter()
            .map(|id| json!({"id":id,"epoch":self.epoch}))
            .collect::<Vec<_>>()))
    }
    pub fn claim(&self, job: &str, epoch: u64) -> Result<Option<ParseTask>> {
        if self.root.join("restore-journal.json").exists() {
            return Ok(None);
        }
        if epoch != self.epoch {
            return Ok(None);
        }
        let task = self.conn.query_row("SELECT s.original_path,s.kind,j.generation FROM jobs j JOIN sources s ON s.id=j.source_id WHERE j.id=? AND j.kind='import' AND j.status='queued' AND s.status='processing'",[job],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,i64>(2)?))).optional()?;
        if let Some((path, kind, generation)) = task {
            self.conn.execute(
                "UPDATE jobs SET status='running',stage='提取正文',updated_at=? WHERE id=?",
                params![now(), job],
            )?;
            Ok(Some(ParseTask {
                path: self.root.join(path),
                kind,
                generation,
            }))
        } else {
            Ok(None)
        }
    }
    pub fn complete(
        &mut self,
        job: &str,
        epoch: u64,
        generation: i64,
        result: Result<Vec<ParsedSegment>>,
    ) -> Result<()> {
        if epoch != self.epoch || self.root.join("restore-journal.json").exists() {
            return Ok(());
        }
        let source = self
            .conn
            .query_row(
                "SELECT source_id FROM jobs WHERE id=? AND kind='import' AND status='running' AND generation=?",
                params![job,generation],
                |r| r.get::<_, String>(0),
            )
            .optional()?;
        let Some(source) = source else {
            return Ok(());
        };
        let configuration = settings::load(&self.root).ok();
        let auto = if let Some(configuration) = &configuration {
            self.conn.query_row(
                "SELECT auto_extract=1 AND config_revision=? FROM jobs WHERE id=?",
                params![configuration.revision, job],
                |row| row.get::<_, bool>(0),
            )?
        } else {
            false
        };
        let tx = self.conn.transaction()?;
        match result {
            Ok(segments) => {
                tx.execute("DELETE FROM segments WHERE source_id=?", [&source])?;
                for (ordinal, segment) in segments.iter().enumerate() {
                    tx.execute("INSERT INTO segments (id,source_id,source_version_id,ordinal,locator,text) VALUES (?,?,?,?,?,?)",params![id(),source,format!("{source}:v1"),ordinal as i64,segment.locator,segment.text])?;
                }
                tx.execute(
                    "UPDATE sources SET status='ready',segment_count=?,error=NULL WHERE id=?",
                    params![segments.len() as i64, source],
                )?;
                tx.execute("UPDATE jobs SET status='succeeded',stage='可建立记忆',error=NULL,updated_at=? WHERE id=?",params![now(),job])?;
                if let Some(configuration) = &configuration {
                    if auto
                        && configuration.auto_extract
                        && configuration.validate_material_access().is_ok()
                    {
                        enqueue_extraction(&tx, &source, configuration)?;
                    }
                }
            }
            Err(error) => {
                tx.execute(
                    "UPDATE sources SET status='failed',error=? WHERE id=?",
                    params![error.message, source],
                )?;
                tx.execute("UPDATE jobs SET status='failed',stage='解析失败',error=?,updated_at=? WHERE id=?",params![error.message,now(),job])?;
            }
        }
        tx.commit()?;
        Ok(())
    }
    fn source_detail(&self, source: &str) -> Result<Value> {
        let source_value = self
            .conn
            .query_row(&format!("{SOURCE_SELECT} WHERE id=?"), [source], source_row)
            .optional()?
            .ok_or_else(|| AppError::new("NOT_FOUND", "资料不存在"))?;
        let mut stmt = self.conn.prepare("SELECT id,source_version_id,ordinal,locator,text FROM segments WHERE source_id=? ORDER BY ordinal")?;
        let segments = stmt.query_map([source],|r|Ok(json!({"id":r.get::<_,String>(0)?,"sourceVersionId":r.get::<_,String>(1)?,"ordinal":r.get::<_,i64>(2)?,"locator":r.get::<_,String>(3)?,"text":r.get::<_,String>(4)?})))?.collect::<std::result::Result<Vec<_>,_>>()?;
        Ok(json!({"source":source_value,"segments":segments}))
    }
    pub(crate) fn segments(p: &Value) -> Result<Vec<String>> {
        let Some(value) = p.get("segmentIds") else {
            return Ok(vec![]);
        };
        let arr = value
            .as_array()
            .ok_or_else(|| AppError::new("VALIDATION", "segmentIds 必须是数组"))?;
        if arr.len() > 100 {
            return Err(AppError::new("VALIDATION", "一次最多选择 100 段证据"));
        }
        let mut result = Vec::new();
        for value in arr {
            let item = value
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or_else(|| AppError::new("VALIDATION", "证据 ID 无效"))?
                .to_owned();
            if !result.contains(&item) {
                result.push(item);
            }
        }
        Ok(result)
    }
    pub(crate) fn validate_evidence(
        &self,
        project: &str,
        source: Option<&str>,
        segments: &[String],
    ) -> Result<()> {
        for segment in segments {
            let valid = self.conn.query_row("SELECT s.project_id,s.id FROM segments g JOIN sources s ON s.id=g.source_id WHERE g.id=? AND s.status='ready'",[segment],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).optional()?;
            if !valid
                .is_some_and(|(p, s)| p == project && source.is_none_or(|expected| expected == s))
            {
                return Err(AppError::new(
                    "EVIDENCE_SCOPE",
                    "证据不属于此项目或指定资料",
                ));
            }
        }
        Ok(())
    }
    fn create_proposal(&mut self, p: &Value) -> Result<Value> {
        let (project, source, kind, content) = (
            required(p, "projectId")?,
            required(p, "sourceId")?,
            required(p, "kind")?,
            required(p, "content")?,
        );
        self.ensure_project(project)?;
        validate_kind(kind)?;
        validate_content(content)?;
        let segments = Self::segments(p)?;
        if segments.is_empty() {
            return Err(AppError::new("VALIDATION", "请选择至少一段原文证据"));
        }
        self.validate_evidence(project, Some(source), &segments)?;
        let (proposal, at) = (id(), now());
        let tx = self.conn.transaction()?;
        tx.execute("INSERT INTO proposals (id,project_id,source_id,kind,content,status,created_at,memory_id) VALUES (?,?,?,?,?,'pending',?,NULL)",params![proposal,project,source,kind,content,at])?;
        for segment in segments {
            tx.execute(
                "INSERT INTO proposal_evidence VALUES (?,?)",
                params![proposal, segment],
            )?;
        }
        tx.commit()?;
        self.proposal(&proposal)
    }
    fn proposal_segments(&self, proposal: &str) -> Result<Value> {
        let mut stmt = self.conn.prepare(
            "SELECT segment_id FROM proposal_evidence WHERE proposal_id=? ORDER BY rowid",
        )?;
        let rows = stmt
            .query_map([proposal], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(json!(rows))
    }
    pub(crate) fn proposal(&self, proposal: &str) -> Result<Value> {
        let mut value = self
            .conn
            .query_row(
                &format!("{PROPOSAL_SELECT} WHERE id=?"),
                [proposal],
                proposal_row,
            )
            .optional()?
            .ok_or_else(|| AppError::new("NOT_FOUND", "候选记忆不存在"))?;
        value["segmentIds"] = self.proposal_segments(proposal)?;
        value["facets"] = crate::memory_facts::proposal(&self.conn, proposal)?;
        value["retention"] = crate::retention::proposal(&self.conn, proposal)?;
        Ok(value)
    }
    fn confirm(&mut self, proposal: &str) -> Result<Value> {
        let p = self.proposal(proposal)?;
        if p["status"] == "confirmed" {
            return self.memory(p["memoryId"].as_str().unwrap());
        }
        if p["status"] == "rejected" {
            return Err(AppError::new("CONFLICT", "已忽略的候选无法确认"));
        }
        if self.conn.query_row("SELECT EXISTS(SELECT 1 FROM memory_reviews WHERE proposal_id=? AND status='pending' AND target_id IS NOT NULL)",[proposal],|r|r.get::<_,bool>(0))? {
            return Err(AppError::new("MEMORY_REVIEW_REQUIRED","此候选与已有记忆有关联，请在记忆中心核对并选择如何更新"));
        }
        crate::extraction_store::guard_proposal(&self.conn, proposal)?;
        let project = p["projectId"].as_str().unwrap();
        let source = p["sourceId"].as_str().unwrap();
        let segments = Self::segments(&p)?;
        if segments.is_empty() {
            return Err(AppError::new("VALIDATION", "候选缺少原文证据，无法确认"));
        }
        self.validate_evidence(project, Some(source), &segments)?;
        let title: String =
            self.conn
                .query_row("SELECT title FROM sources WHERE id=?", [source], |r| {
                    r.get(0)
                })?;
        let (memory, revision, at) = (id(), id(), now());
        let tx = self.conn.transaction()?;
        tx.execute("INSERT INTO memories (id,project_id,kind,content,revision,state,source_title,confirmed_at,updated_at) VALUES (?,?,?,?,1,'active',?,?,?)",params![memory,project,p["kind"].as_str().unwrap(),p["content"].as_str().unwrap(),title,at,at])?;
        tx.execute("INSERT INTO revisions (id,memory_id,number,content,reason,origin,created_at) VALUES (?,?,1,?,'确认原文提取','confirmation',?)",params![revision,memory,p["content"].as_str().unwrap(),at])?;
        crate::memory_facts::promote(&tx, proposal, &revision, p["content"].as_str().unwrap())?;
        crate::retention::promote(&tx, proposal, &revision)?;
        for segment in segments {
            tx.execute(
                "INSERT INTO revision_evidence VALUES (?,?)",
                params![revision, segment],
            )?;
        }
        tx.execute(
            "UPDATE proposals SET status='confirmed',memory_id=? WHERE id=?",
            params![memory, proposal],
        )?;
        tx.commit()?;
        self.memory(&memory)
    }
    fn reject(&self, proposal: &str) -> Result<Value> {
        let p = self.proposal(proposal)?;
        if p["status"] == "confirmed" {
            return Err(AppError::new(
                "CONFLICT",
                "已确认记忆不能忽略，请通过修订更正",
            ));
        }
        self.conn.execute(
            "UPDATE proposals SET status='rejected' WHERE id=?",
            [proposal],
        )?;
        self.proposal(proposal)
    }
    pub(crate) fn memory(&self, memory: &str) -> Result<Value> {
        self.conn
            .query_row(&format!("{MEMORY_SELECT} WHERE id=?"), [memory], memory_row)
            .optional()?
            .ok_or_else(|| AppError::new("NOT_FOUND", "记忆不存在"))
    }
    fn memory_detail(&self, memory: &str) -> Result<Value> {
        let value = self.memory(memory)?;
        let mut stmt=self.conn.prepare("SELECT id,memory_id,number,content,reason,origin,created_at FROM revisions WHERE memory_id=? ORDER BY number DESC")?;
        let revisions=stmt.query_map([memory],|r|Ok(json!({"id":r.get::<_,String>(0)?,"memoryId":r.get::<_,String>(1)?,"number":r.get::<_,i64>(2)?,"content":r.get::<_,String>(3)?,"reason":r.get::<_,String>(4)?,"origin":r.get::<_,String>(5)?,"createdAt":r.get::<_,String>(6)?})))?.collect::<std::result::Result<Vec<_>,_>>()?;
        let mut out = Vec::new();
        for mut revision in revisions {
            revision["retention"] =
                crate::retention::revision(&self.conn, revision["id"].as_str().unwrap())?;
            revision["facets"] =
                crate::memory_facts::load(&self.conn, revision["id"].as_str().unwrap())?;
            let mut evidence=self.conn.prepare("SELECT g.id,s.id,s.title,g.locator,g.text FROM revision_evidence e JOIN segments g ON g.id=e.segment_id JOIN sources s ON s.id=g.source_id WHERE e.revision_id=? ORDER BY g.ordinal")?;
            let rows=evidence.query_map([revision["id"].as_str().unwrap()],|r|Ok(json!({"segmentId":r.get::<_,String>(0)?,"sourceId":r.get::<_,String>(1)?,"sourceTitle":r.get::<_,String>(2)?,"locator":r.get::<_,String>(3)?,"text":r.get::<_,String>(4)?})))?.collect::<std::result::Result<Vec<_>,_>>()?;
            revision["evidence"] = json!(rows);
            out.push(revision);
        }
        Ok(json!({"memory":value,"revisions":out}))
    }
    fn review_retention(&mut self, p: &Value) -> Result<Value> {
        let memory = required(p, "memoryId")?;
        let detail = self.memory_detail(memory)?;
        let current = &detail["memory"];
        let revision = detail["revisions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["number"] == current["revision"])
            .ok_or_else(|| AppError::new("NOT_FOUND", "记忆版本不存在"))?;
        let mut update = p.clone();
        if update.get("content").is_none() {
            update["content"] = current["content"].clone();
        }
        update["segmentIds"] = json!(revision["evidence"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["segmentId"].clone())
            .collect::<Vec<_>>());
        update["facets"] = revision["facets"].clone();
        if update["retention"]["layer"] == "working" {
            let date = required(p, "date")?;
            crate::tasks::valid_date(date)?;
            let next = required(&p["retention"], "reviewAfter")?;
            crate::tasks::valid_date(next)?;
            if next <= date {
                return Err(AppError::new(
                    "VALIDATION",
                    "继续保留的复核日期必须晚于今天",
                ));
            }
        }
        self.revise(&update)
    }
    fn revise(&mut self, p: &Value) -> Result<Value> {
        let memory = required(p, "memoryId")?;
        let content = required(p, "content")?;
        validate_content(content)?;
        let reason = required(p, "reason")?;
        let base = p["baseRevision"]
            .as_i64()
            .filter(|v| *v > 0)
            .ok_or_else(|| AppError::new("VALIDATION", "baseRevision 必须是正整数"))?;
        let current = self.memory(memory)?;
        if current["revision"].as_i64() != Some(base) {
            return Err(AppError::new(
                "REVISION_CONFLICT",
                "记忆已有新版本，请重新打开后修订",
            ));
        }
        let segments = Self::segments(p)?;
        self.validate_evidence(current["projectId"].as_str().unwrap(), None, &segments)?;
        let title = if let Some(first) = segments.first() {
            self.conn.query_row(
                "SELECT s.title FROM segments g JOIN sources s ON s.id=g.source_id WHERE g.id=?",
                [first],
                |r| r.get::<_, String>(0),
            )?
        } else {
            "个人纠正".into()
        };
        let (revision, at) = (id(), now());
        let tx = self.conn.transaction()?;
        tx.execute(
            "INSERT INTO revisions VALUES (?,?,?,?,?,'user_correction',?)",
            params![revision, memory, base + 1, content, reason, at],
        )?;
        for segment in segments {
            tx.execute(
                "INSERT INTO revision_evidence VALUES (?,?)",
                params![revision, segment],
            )?;
        }
        tx.execute("UPDATE memories SET content=?,revision=?,source_title=?,updated_at=? WHERE id=? AND revision=?",params![content,base+1,title,at,memory,base])?;
        if let Some(facets) = p.get("facets") {
            crate::memory_facts::save(&tx, &revision, facets, content)?;
        }
        let previous: String = tx.query_row(
            "SELECT id FROM revisions WHERE memory_id=? AND number=?",
            params![memory, base],
            |r| r.get(0),
        )?;
        crate::retention::save_revision(
            &tx,
            &revision,
            &p.get("retention")
                .cloned()
                .unwrap_or(crate::retention::revision(&tx, &previous)?),
        )?;
        crate::memory_workbench::correction(&tx, p, &current, &at)?;
        tx.commit()?;
        self.memory(memory)
    }

    fn save_ai_settings(&mut self, p: &Value) -> Result<Value> {
        let (configuration, changed) = settings::save(&self.root, p)?;
        if changed {
            self.conn.execute("UPDATE jobs SET status='cancelled',stage='配置已变更，请手动重试',error='模型配置已变更',error_code='CONFIG_CHANGED',generation=generation+1,updated_at=? WHERE kind='extract' AND status IN ('queued','running')",[now()])?;
        }
        Ok(configuration.public())
    }
    fn job(&self, job: &str) -> Result<Value> {
        self.conn
            .query_row(&format!("{JOB_SELECT} WHERE id=?"), [job], job_row)
            .optional()?
            .ok_or_else(|| AppError::new("NOT_FOUND", "处理任务不存在"))
    }
    fn start_extraction(&mut self, source: &str) -> Result<Value> {
        let configuration = settings::load(&self.root)?;
        configuration.validate_material_access()?;
        let job = enqueue_extraction(&self.conn, source, &configuration)?;
        self.job(&job)
    }
    fn retry_extraction(&mut self, job: &str) -> Result<Value> {
        let configuration = settings::load(&self.root)?;
        configuration.validate_material_access()?;
        let current = self.job(job)?;
        if current["kind"] != "extract"
            || !matches!(current["status"].as_str(), Some("failed" | "cancelled"))
        {
            return Err(AppError::new("CONFLICT", "仅能重试失败或已取消的 AI 提取"));
        }
        let source = current["sourceId"].as_str().unwrap();
        let active:bool=self.conn.query_row("SELECT EXISTS(SELECT 1 FROM jobs WHERE kind='extract' AND source_id=? AND status IN ('queued','running'))",[source],|row|row.get(0))?;
        if active {
            return Err(AppError::new("CONFLICT", "该资料已有正在进行的提取"));
        }
        let ready: bool = self.conn.query_row(
            "SELECT status='ready' FROM sources WHERE id=?",
            [source],
            |row| row.get(0),
        )?;
        if !ready {
            return Err(AppError::new("SOURCE_NOT_READY", "资料尚未解析完成"));
        }
        let (revision, source_hash, actual_hash, prompt): (Option<String>, Option<String>, String, Option<String>) = self.conn.query_row("SELECT j.config_revision,j.source_hash,s.sha256,j.prompt_version FROM jobs j JOIN sources s ON s.id=j.source_id WHERE j.id=?", [job], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))?;
        if revision.as_deref() != Some(configuration.revision.as_str())
            || prompt.as_deref() != Some(ai::PROMPT_VERSION)
            || source_hash
                .as_ref()
                .is_some_and(|value| value != &actual_hash)
        {
            // Old drafts keep their immutable provenance. A changed snapshot
            // starts a fresh job rather than relabelling old model output.
            return self.start_extraction(source);
        }
        self.conn.execute("UPDATE jobs SET status='queued',stage='等待恢复未完成批次',error=NULL,error_code=NULL,generation=generation+1,attempts=attempts+1,updated_at=? WHERE id=?",params![now(),job])?;
        self.job(job)
    }
    fn cancel_extraction(&mut self, job: &str) -> Result<Value> {
        let current = self.job(job)?;
        if current["kind"] != "extract" {
            return Err(AppError::new("CONFLICT", "仅能取消 AI 提取"));
        }
        if current["status"] == "cancelled" {
            return Ok(current);
        }
        if !matches!(current["status"].as_str(), Some("queued" | "running")) {
            return Err(AppError::new("CONFLICT", "该提取已经结束"));
        }
        self.conn.execute("UPDATE jobs SET status='cancelled',stage='已取消',error=NULL,error_code='CANCELLED',generation=generation+1,updated_at=? WHERE id=?",params![now(),job])?;
        self.job(job)
    }
    fn update_proposal(&self, p: &Value) -> Result<Value> {
        let proposal = required(p, "proposalId")?;
        let kind = required(p, "kind")?;
        let content = required(p, "content")?;
        validate_kind(kind)?;
        validate_content(content)?;
        if self.proposal(proposal)?["status"] != "pending" {
            return Err(AppError::new("CONFLICT", "只能编辑待确认的提议"));
        }
        let tx = self.conn.unchecked_transaction()?;
        tx.execute(
            "UPDATE proposals SET kind=?,content=?,edited=1 WHERE id=?",
            params![kind, content, proposal],
        )?;
        tx.execute(
            "DELETE FROM proposal_facets WHERE proposal_id=?",
            [proposal],
        )?;
        if let Some(policy) = p.get("retention") {
            tx.execute("INSERT INTO proposal_retention VALUES(?,?) ON CONFLICT(proposal_id) DO UPDATE SET policy=excluded.policy",params![proposal,crate::retention::checked(policy)?.to_string()])?;
        }
        tx.commit()?;
        self.proposal(proposal)
    }
    pub fn pending_extract(&self) -> Result<Value> {
        let mut stmt=self.conn.prepare("SELECT id FROM jobs WHERE kind='extract' AND status='queued' ORDER BY created_at LIMIT 1")?;
        let ids = stmt
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(json!(ids
            .into_iter()
            .map(|id| json!({"id":id,"epoch":self.epoch}))
            .collect::<Vec<_>>()))
    }
    pub fn claim_extract(&mut self, job: &str, epoch: u64) -> Result<Option<AiTask>> {
        if epoch != self.epoch || self.root.join("restore-journal.json").exists() {
            return Ok(None);
        }
        let row=self.conn.query_row("SELECT j.source_id,j.generation,j.config_revision,s.sha256 FROM jobs j JOIN sources s ON s.id=j.source_id WHERE j.id=? AND j.kind='extract' AND j.status='queued' AND s.status='ready'",[job],|row|Ok((row.get::<_,String>(0)?,row.get::<_,i64>(1)?,row.get::<_,Option<String>>(2)?,row.get::<_,String>(3)?))).optional()?;
        let Some((source, generation, revision, source_hash)) = row else {
            return Ok(None);
        };
        let configuration = settings::load(&self.root)?;
        if revision.as_deref() != Some(configuration.revision.as_str()) {
            self.conn.execute("UPDATE jobs SET status='cancelled',stage='配置已变更，请手动重试',error_code='CONFIG_CHANGED',generation=generation+1,updated_at=? WHERE id=?",params![now(),job])?;
            return Ok(None);
        }
        if let Err(error) = configuration.validate_material_access() {
            self.conn.execute("UPDATE jobs SET status='failed',stage='AI 配置不可用',error=?,error_code=?,updated_at=? WHERE id=?",params![error.message,error.code,now(),job])?;
            return Ok(None);
        }
        let mut stmt = self
            .conn
            .prepare("SELECT id,text,locator FROM segments WHERE source_id=? ORDER BY ordinal")?;
        let segments = stmt
            .query_map([&source], |row| {
                Ok(ai::SourceSegment {
                    id: row.get(0)?,
                    text: row.get(1)?,
                    locator: row.get(2)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let context: String = self.conn.query_row("SELECT json_object('name',p.name,'description',substr(p.description,1,2000),'goal',substr(coalesce(f.goal,''),1,2000),'status',coalesce(f.status,'active'),'targetDate',f.target_date) FROM sources s JOIN projects p ON p.id=s.project_id LEFT JOIN project_profiles f ON f.project_id=p.id WHERE s.id=?", [&source], |r|r.get(0))?;
        self.conn.execute(
            "INSERT OR IGNORE INTO extraction_project_context VALUES(?,?)",
            params![job, context],
        )?;
        let raw: String = self.conn.query_row(
            "SELECT context FROM extraction_project_context WHERE job_id=?",
            [job],
            |r| r.get(0),
        )?;
        let project_context: Value = serde_json::from_str(&raw)
            .map_err(|_| AppError::new("DATABASE", "项目提取背景损坏"))?;
        let input_hash=hash(&serde_json::to_vec(&segments.iter().map(|segment|json!({"id":segment.id,"text":segment.text,"locator":segment.locator})).collect::<Vec<_>>()).map_err(|_|AppError::new("SERIALIZATION","资料快照失败"))?);
        self.conn.execute("UPDATE jobs SET status='running',stage='AI 正在提取',error=NULL,error_code=NULL,provider=?,model=?,prompt_version=?,input_hash=?,source_hash=?,updated_at=? WHERE id=?",params![configuration.provider,configuration.model,ai::PROMPT_VERSION,input_hash,source_hash,now(),job])?;
        Ok(Some(AiTask {
            settings: configuration,
            project_context,
            segments,
            generation,
            checkpoints: crate::extraction_store::resume(&self.conn, job)?,
        }))
    }
    pub fn progress_extract(
        &self,
        job: &str,
        epoch: u64,
        generation: i64,
        done: usize,
        total: usize,
    ) -> Result<bool> {
        if epoch != self.epoch || self.root.join("restore-journal.json").exists() {
            return Ok(false);
        }
        let changed=self.conn.execute("UPDATE jobs SET completed_batches=?,total_batches=?,stage=?,updated_at=? WHERE id=? AND kind='extract' AND status='running' AND generation=?",params![done as i64,total as i64,format!("AI 提取 {done}/{total} 批"),now(),job,generation])?;
        Ok(changed == 1)
    }
    pub fn complete_extract(
        &mut self,
        job: &str,
        epoch: u64,
        generation: i64,
        result: Result<ai::ExtractionResult>,
    ) -> Result<()> {
        if epoch != self.epoch || self.root.join("restore-journal.json").exists() {
            return Ok(());
        }
        let row=self.conn.query_row("SELECT j.source_id,s.project_id,j.source_hash,s.sha256,j.provider,j.model,j.prompt_version FROM jobs j JOIN sources s ON s.id=j.source_id WHERE j.id=? AND j.kind='extract' AND j.status='running' AND j.generation=?",params![job,generation],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,Option<String>>(2)?,row.get::<_,String>(3)?,row.get::<_,Option<String>>(4)?,row.get::<_,Option<String>>(5)?,row.get::<_,Option<String>>(6)?))).optional()?;
        let Some((_source, _project, snapshot_hash, current_hash, _provider, _model, _prompt)) =
            row
        else {
            return Ok(());
        };
        if snapshot_hash.as_deref() != Some(current_hash.as_str()) {
            self.conn.execute("UPDATE jobs SET status='cancelled',stage='资料版本已变化',error_code='SOURCE_CHANGED',generation=generation+1,updated_at=? WHERE id=?",params![now(),job])?;
            return Ok(());
        }
        let output = match result {
            Ok(output) => output,
            Err(error) => {
                self.conn.execute("UPDATE jobs SET status='failed',stage='AI 提取失败，可重试',error=?,error_code=?,updated_at=? WHERE id=?",params![error.message,error.code,now(),job])?;
                return Ok(());
            }
        };
        let checkpoints = crate::extraction_store::resume(&self.conn, job)?;
        if checkpoints.is_empty() {
            // Compatibility path used by maintenance and deterministic callers.
            // The same durable validation path applies to every extraction.
            let checkpoint = ai::ExtractionCheckpoint {
                key: "legacy-complete".into(),
                parent_key: None,
                status: "succeeded".into(),
                input_hash: snapshot_hash.unwrap_or_default(),
                candidates: output.candidates,
                task_candidates: output.task_candidates,
                raw_output: None,
                discarded_count: output.discarded_count,
                usage: None,
                error_code: None,
                budget: Default::default(),
                completed_batches: output.batch_count,
                total_batches: output.batch_count,
            };
            if !crate::extraction_store::persist(self, job, epoch, generation, &checkpoint)? {
                return Ok(());
            }
        }
        let (created, tasks, review): (i64,i64,i64) = self.conn.query_row("SELECT (SELECT count(*) FROM proposals WHERE extraction_job_id=?),(SELECT count(*) FROM task_proposals WHERE extraction_job_id=?),(SELECT count(*) FROM extraction_drafts WHERE job_id=? AND status='needs_review')", params![job,job,job], |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
        let stage = if review > 0 {
            format!("提取完成；{created}条待确认，{review}条事实与范围待审核")
        } else if created == 0 && tasks == 0 {
            "提取完成，没有新增提议".into()
        } else {
            "提议已逐批保存，等待确认".into()
        };
        self.conn.execute("UPDATE jobs SET status='succeeded',stage=?,error=NULL,error_code=NULL,completed_batches=?,total_batches=?,candidate_count=?,task_candidate_count=?,discarded_count=?,updated_at=? WHERE id=?", params![stage,output.batch_count as i64,output.batch_count as i64,created,tasks,output.discarded_count as i64,now(),job])?;
        Ok(())
    }
}

pub(crate) fn enqueue_extraction(
    conn: &Connection,
    source: &str,
    configuration: &settings::SavedSettings,
) -> Result<String> {
    if let Some(job)=conn.query_row("SELECT id FROM jobs WHERE kind='extract' AND source_id=? AND status IN ('queued','running') LIMIT 1",[source],|row|row.get::<_,String>(0)).optional()?{return Ok(job);}
    let ready = conn
        .query_row(
            "SELECT status='ready' FROM sources WHERE id=?",
            [source],
            |row| row.get::<_, bool>(0),
        )
        .optional()?
        .ok_or_else(|| AppError::new("NOT_FOUND", "资料不存在"))?;
    if !ready {
        return Err(AppError::new("SOURCE_NOT_READY", "资料尚未解析完成"));
    }
    let (job, at) = (id(), now());
    conn.execute("INSERT INTO jobs (id,kind,status,stage,error,source_id,created_at,updated_at,recovered,provider,model,prompt_version,config_revision) VALUES (?,'extract','queued','等待 AI 提取',NULL,?,?,?,0,?,?,?,?)",params![job,source,at,at,configuration.provider,configuration.model,ai::PROMPT_VERSION,configuration.revision])?;
    Ok(job)
}

pub(crate) fn migrate(conn: &Connection) -> Result<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if version > SCHEMA_VERSION {
        return Err(AppError::new(
            "SCHEMA_VERSION",
            "工作区版本较新，请升级应用",
        ));
    }
    if version == SCHEMA_VERSION {
        return Ok(());
    }
    conn.execute_batch("BEGIN IMMEDIATE;")?;
    let result = (|| -> Result<()> {
        if version == 0 {
            conn.execute_batch(SCHEMA)?;
        }
        if version < 2 {
            conn.execute_batch(MIGRATION_V2)?;
        }
        if version < 3 {
            conn.execute_batch(tasks::MIGRATION)?;
        }
        if version < 4 {
            conn.execute_batch(crate::memory::MIGRATION)?;
        }
        if version < 5 {
            conn.execute_batch(crate::planning::MIGRATION)?;
        }
        if version < 6 {
            crate::delivery::migrate(conn)?;
            conn.execute_batch("PRAGMA user_version=6;")?;
        }
        if version < 7 {
            crate::governance::migrate(conn)?;
            crate::change_control::migrate(conn)?;
            crate::coordination::migrate(conn)?;
            conn.execute_batch("PRAGMA user_version=7;")?;
        }
        if version < 8 {
            conn.execute_batch(crate::memory_workbench::MIGRATION)?;
            conn.execute_batch("INSERT INTO memory_corrections SELECT r.id,m.project_id,m.id,a.number,r.number,'请核对这条记忆的当前内容：'||substr(a.content,1,120),a.content,r.content,r.reason,r.created_at FROM revisions r JOIN memories m ON m.id=r.memory_id JOIN revisions a ON a.memory_id=r.memory_id AND a.number=r.number-1 WHERE r.origin='user_correction';")?;
        }
        if version < 9 {
            conn.execute_batch(crate::memory_facts::MIGRATION)?;
        }
        if version < 10 {
            conn.execute_batch(crate::extraction_store::MIGRATION)?;
        }
        if version < 11 {
            conn.execute_batch(crate::retention::MIGRATION)?;
        }
        if version < 12 {
            conn.execute_batch(crate::daily_use::MIGRATION)?;
        }
        Ok(())
    })();
    match result {
        Ok(()) => {
            conn.execute_batch("COMMIT;")?;
            Ok(())
        }
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK;");
            Err(error)
        }
    }
}

fn validate_kind(kind: &str) -> Result<()> {
    if matches!(kind, "fact" | "decision" | "requirement" | "risk") {
        Ok(())
    } else {
        Err(AppError::new("VALIDATION", "记忆类型无效"))
    }
}
pub(crate) fn validate_content(content: &str) -> Result<()> {
    if content.len() > 64 * 1024 {
        Err(AppError::new("VALIDATION", "记忆内容过长"))
    } else {
        Ok(())
    }
}
const SOURCE_SELECT:&str="SELECT id,project_id,title,kind,original_filename,source_at,imported_at,sha256,status,segment_count,error FROM sources";
const PROPOSAL_SELECT: &str =
    "SELECT id,project_id,source_id,kind,content,status,created_at,memory_id,origin,provider,model,prompt_version,extraction_job_id,quotes,edited FROM proposals";
const MEMORY_SELECT:&str="SELECT id,project_id,kind,content,revision,state,source_title,confirmed_at,updated_at,coalesce((SELECT rt.policy FROM revision_retention rt JOIN revisions r ON r.id=rt.revision_id WHERE r.memory_id=memories.id AND r.number=memories.revision),'{\"layer\":\"durable\",\"reason\":\"旧版或人工记录\"}') FROM memories";
const JOB_SELECT: &str =
    "SELECT id,kind,status,stage,error,source_id,created_at,updated_at,recovered,attempts,generation,provider,model,prompt_version,input_hash,completed_batches,total_batches,candidate_count,discarded_count,error_code,task_candidate_count FROM jobs";
fn project_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(
        json!({"id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"description":r.get::<_,String>(2)?,"createdAt":r.get::<_,String>(3)?}),
    )
}
fn source_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(
        json!({"id":r.get::<_,String>(0)?,"projectId":r.get::<_,String>(1)?,"title":r.get::<_,String>(2)?,"kind":r.get::<_,String>(3)?,"originalFilename":r.get::<_,String>(4)?,"sourceAt":r.get::<_,Option<String>>(5)?,"importedAt":r.get::<_,String>(6)?,"sha256":r.get::<_,String>(7)?,"status":r.get::<_,String>(8)?,"segmentCount":r.get::<_,i64>(9)?,"error":r.get::<_,Option<String>>(10)?}),
    )
}
fn proposal_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(
        json!({"id":r.get::<_,String>(0)?,"projectId":r.get::<_,String>(1)?,"sourceId":r.get::<_,String>(2)?,"kind":r.get::<_,String>(3)?,"content":r.get::<_,String>(4)?,"status":r.get::<_,String>(5)?,"createdAt":r.get::<_,String>(6)?,"memoryId":r.get::<_,Option<String>>(7)?,"origin":r.get::<_,String>(8)?,"provider":r.get::<_,Option<String>>(9)?,"model":r.get::<_,Option<String>>(10)?,"promptVersion":r.get::<_,Option<String>>(11)?,"extractionJobId":r.get::<_,Option<String>>(12)?,"quotes":serde_json::from_str::<Value>(&r.get::<_,String>(13)?).map_err(|error|rusqlite::Error::FromSqlConversionFailure(13,rusqlite::types::Type::Text,Box::new(error)))?,"edited":r.get::<_,bool>(14)?}),
    )
}
fn memory_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(
        json!({"id":r.get::<_,String>(0)?,"projectId":r.get::<_,String>(1)?,"kind":r.get::<_,String>(2)?,"content":r.get::<_,String>(3)?,"revision":r.get::<_,i64>(4)?,"state":r.get::<_,String>(5)?,"sourceTitle":r.get::<_,String>(6)?,"confirmedAt":r.get::<_,String>(7)?,"updatedAt":r.get::<_,String>(8)?,"retention":serde_json::from_str::<Value>(&r.get::<_,String>(9)?).unwrap_or(Value::Null)}),
    )
}
fn job_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(
        json!({"id":r.get::<_,String>(0)?,"kind":r.get::<_,String>(1)?,"status":r.get::<_,String>(2)?,"stage":r.get::<_,String>(3)?,"error":r.get::<_,Option<String>>(4)?,"sourceId":r.get::<_,String>(5)?,"createdAt":r.get::<_,String>(6)?,"updatedAt":r.get::<_,String>(7)?,"recovered":r.get::<_,bool>(8)?,"attempts":r.get::<_,i64>(9)?,"generation":r.get::<_,i64>(10)?,"provider":r.get::<_,Option<String>>(11)?,"model":r.get::<_,Option<String>>(12)?,"promptVersion":r.get::<_,Option<String>>(13)?,"inputHash":r.get::<_,Option<String>>(14)?,"completedBatches":r.get::<_,i64>(15)?,"totalBatches":r.get::<_,i64>(16)?,"candidateCount":r.get::<_,i64>(17)?,"discardedCount":r.get::<_,i64>(18)?,"errorCode":r.get::<_,Option<String>>(19)?,"taskCandidateCount":r.get::<_,i64>(20)?}),
    )
}
pub(crate) fn backup_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(
        json!({"id":r.get::<_,String>(0)?,"filename":r.get::<_,String>(1)?,"createdAt":r.get::<_,String>(2)?,"byteSize":r.get::<_,i64>(3)?,"sha256":r.get::<_,String>(4)?,"counts":serde_json::from_str::<Value>(&r.get::<_,String>(5)?).unwrap_or(json!({}))}),
    )
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),title TEXT NOT NULL,kind TEXT NOT NULL,original_filename TEXT NOT NULL,source_at TEXT,imported_at TEXT NOT NULL,sha256 TEXT NOT NULL,status TEXT NOT NULL,segment_count INTEGER NOT NULL,error TEXT,original_path TEXT NOT NULL,UNIQUE(project_id,sha256));
CREATE TABLE IF NOT EXISTS segments(id TEXT PRIMARY KEY,source_id TEXT NOT NULL REFERENCES sources(id),source_version_id TEXT NOT NULL,ordinal INTEGER NOT NULL,locator TEXT NOT NULL,text TEXT NOT NULL,UNIQUE(source_id,ordinal));
CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,kind TEXT NOT NULL,status TEXT NOT NULL,stage TEXT NOT NULL,error TEXT,source_id TEXT NOT NULL REFERENCES sources(id),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,recovered INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS proposals(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),source_id TEXT NOT NULL REFERENCES sources(id),kind TEXT NOT NULL,content TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,memory_id TEXT REFERENCES memories(id));
CREATE TABLE IF NOT EXISTS proposal_evidence(proposal_id TEXT NOT NULL REFERENCES proposals(id),segment_id TEXT NOT NULL REFERENCES segments(id),PRIMARY KEY(proposal_id,segment_id));
CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),kind TEXT NOT NULL,content TEXT NOT NULL,revision INTEGER NOT NULL,state TEXT NOT NULL,source_title TEXT NOT NULL,confirmed_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS revisions(id TEXT PRIMARY KEY,memory_id TEXT NOT NULL REFERENCES memories(id),number INTEGER NOT NULL,content TEXT NOT NULL,reason TEXT NOT NULL,origin TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(memory_id,number));
CREATE TABLE IF NOT EXISTS revision_evidence(revision_id TEXT NOT NULL REFERENCES revisions(id),segment_id TEXT NOT NULL REFERENCES segments(id),PRIMARY KEY(revision_id,segment_id));
CREATE TABLE IF NOT EXISTS backups(id TEXT PRIMARY KEY,filename TEXT NOT NULL,created_at TEXT NOT NULL,byte_size INTEGER NOT NULL,sha256 TEXT NOT NULL,counts TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS segment_source ON segments(source_id);
CREATE INDEX IF NOT EXISTS memory_project ON memories(project_id);
PRAGMA user_version=1;
"#;

const MIGRATION_V2: &str = r#"
ALTER TABLE jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 1;
ALTER TABLE jobs ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN provider TEXT;
ALTER TABLE jobs ADD COLUMN model TEXT;
ALTER TABLE jobs ADD COLUMN prompt_version TEXT;
ALTER TABLE jobs ADD COLUMN input_hash TEXT;
ALTER TABLE jobs ADD COLUMN completed_batches INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN total_batches INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN candidate_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN discarded_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN error_code TEXT;
ALTER TABLE jobs ADD COLUMN config_revision TEXT;
ALTER TABLE jobs ADD COLUMN source_hash TEXT;
ALTER TABLE jobs ADD COLUMN auto_extract INTEGER NOT NULL DEFAULT 0;
ALTER TABLE proposals ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE proposals ADD COLUMN provider TEXT;
ALTER TABLE proposals ADD COLUMN model TEXT;
ALTER TABLE proposals ADD COLUMN prompt_version TEXT;
ALTER TABLE proposals ADD COLUMN extraction_job_id TEXT REFERENCES jobs(id);
ALTER TABLE proposals ADD COLUMN quotes TEXT NOT NULL DEFAULT '[]';
ALTER TABLE proposals ADD COLUMN edited INTEGER NOT NULL DEFAULT 0;
ALTER TABLE proposals ADD COLUMN fingerprint TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS proposal_fingerprint ON proposals(fingerprint) WHERE fingerprint IS NOT NULL;
CREATE INDEX IF NOT EXISTS job_kind_status ON jobs(kind,status);
PRAGMA user_version=2;
"#;

#[cfg(test)]
mod tests {
    use super::*;
    fn local_settings(db: &mut Database, auto: bool) {
        db.save_ai_settings(&json!({"provider":"ollama","baseUrl":"http://127.0.0.1:11434","model":"local-fixture","outputFormat":"json_schema","timeoutSeconds":5,"autoExtract":auto,"remoteConsent":false})).unwrap();
    }
    fn imported(db: &mut Database, title: &str) -> Value {
        let project = db.create_project(&json!({"name":title})).unwrap();
        db.import(&json!({"projectId":project["id"],"title":title,"text":"客户确认一期仅支持账号密码登录。"}),true).unwrap()
    }
    fn finish_parse(db: &mut Database, source: &Value) {
        let job = source["jobId"].as_str().unwrap();
        let task = db.claim(job, db.epoch).unwrap().unwrap();
        db.complete(
            job,
            db.epoch,
            task.generation,
            Ok(vec![ParsedSegment {
                locator: "第1行".into(),
                text: "客户确认一期仅支持账号密码登录。".into(),
            }]),
        )
        .unwrap();
    }
    fn result(segment: &str) -> Result<ai::ExtractionResult> {
        Ok(ai::ExtractionResult {
            task_candidates: vec![],
            candidates: vec![ai::Candidate {
                retention: Default::default(),
                facets: Default::default(),
                kind: "decision".into(),
                content: "一期仅支持账号密码登录".into(),
                evidence: vec![ai::CandidateEvidence {
                    segment_id: segment.into(),
                    quote: "一期仅支持账号密码登录".into(),
                }],
            }],
            discarded_count: 0,
            batch_count: 1,
        })
    }

    #[test]
    fn automatic_extraction_only_applies_to_imports_created_under_the_saved_configuration() {
        let dir = tempfile::tempdir().unwrap();
        let mut db = Database::open(dir.path().into()).unwrap();
        let old = imported(&mut db, "启用前导入");
        local_settings(&mut db, true);
        finish_parse(&mut db, &old);
        assert_eq!(
            db.conn
                .query_row(
                    "SELECT count(*) FROM jobs WHERE kind='extract'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        let new = imported(&mut db, "启用后导入");
        finish_parse(&mut db, &new);
        assert_eq!(
            db.conn
                .query_row(
                    "SELECT count(*) FROM jobs WHERE kind='extract'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        assert_eq!(db.state().unwrap()["memories"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn cancellation_retry_and_editing_do_not_allow_stale_or_duplicate_ai_results() {
        let dir = tempfile::tempdir().unwrap();
        let mut db = Database::open(dir.path().into()).unwrap();
        local_settings(&mut db, false);
        let source = imported(&mut db, "代际提取");
        finish_parse(&mut db, &source);
        let job = db
            .start_extraction(source["sourceId"].as_str().unwrap())
            .unwrap();
        let job = job["id"].as_str().unwrap();
        let first = db.claim_extract(job, db.epoch).unwrap().unwrap();
        let segment = first.segments[0].id.clone();
        db.cancel_extraction(job).unwrap();
        db.retry_extraction(job).unwrap();
        let second = db.claim_extract(job, db.epoch).unwrap().unwrap();
        db.complete_extract(job, db.epoch, first.generation, result(&segment))
            .unwrap();
        assert!(db.state().unwrap()["proposals"]
            .as_array()
            .unwrap()
            .is_empty());
        db.complete_extract(job, db.epoch, second.generation, result(&segment))
            .unwrap();
        let state = db.state().unwrap();
        assert!(state["memories"].as_array().unwrap().is_empty());
        assert_eq!(state["proposals"][0]["origin"], "ai");
        let proposal = state["proposals"][0]["id"].as_str().unwrap();
        db.update_proposal(
            &json!({"proposalId":proposal,"kind":"requirement","content":"用户改写的交付范围"}),
        )
        .unwrap();
        let next = db
            .start_extraction(source["sourceId"].as_str().unwrap())
            .unwrap();
        let next = next["id"].as_str().unwrap();
        let next_task = db.claim_extract(next, db.epoch).unwrap().unwrap();
        db.complete_extract(next, db.epoch, next_task.generation, result(&segment))
            .unwrap();
        assert_eq!(
            db.state().unwrap()["proposals"].as_array().unwrap().len(),
            1
        );
        assert_eq!(db.job(next).unwrap()["candidateCount"], 0);
        assert_eq!(
            db.confirm(proposal).unwrap()["content"],
            "用户改写的交付范围"
        );
    }

    #[test]
    fn settings_changes_cancel_old_work_and_restore_does_not_send_archived_jobs() {
        let dir = tempfile::tempdir().unwrap();
        let mut db = Database::open(dir.path().into()).unwrap();
        local_settings(&mut db, false);
        let source = imported(&mut db, "配置边界");
        finish_parse(&mut db, &source);
        let old = db
            .start_extraction(source["sourceId"].as_str().unwrap())
            .unwrap();
        local_settings(&mut db, true);
        assert_eq!(
            db.job(old["id"].as_str().unwrap()).unwrap()["status"],
            "cancelled"
        );
        let next = db
            .start_extraction(source["sourceId"].as_str().unwrap())
            .unwrap();
        let archive = backup::create(&mut db).unwrap();
        let bytes = fs::read(
            db.root
                .join("backups")
                .join(archive["filename"].as_str().unwrap()),
        )
        .unwrap();
        backup::restore(&mut db,&json!({"filename":archive["filename"],"contentBase64":base64::engine::general_purpose::STANDARD.encode(bytes),"confirmation":"RESTORE"})).unwrap();
        assert_eq!(
            db.job(next["id"].as_str().unwrap()).unwrap()["status"],
            "cancelled"
        );
        assert_eq!(
            db.job(next["id"].as_str().unwrap()).unwrap()["errorCode"],
            "RESTORED_PAUSED"
        );
        assert!(settings::load(&db.root).unwrap().auto_extract);
        assert!(db.pending_extract().unwrap().as_array().unwrap().is_empty());
    }

    #[test]
    fn real_schema_two_backup_migrates_ai_provenance_and_empty_task_tables() {
        let dir = tempfile::tempdir().unwrap();
        let mut db = Database::open(dir.path().into()).unwrap();
        let bytes = include_bytes!("../tests/fixtures/schema-v2.zip");
        backup::restore(&mut db,&json!({"filename":"schema-v2.zip","contentBase64":base64::engine::general_purpose::STANDARD.encode(bytes),"confirmation":"RESTORE"})).unwrap();
        let state = db.state().unwrap();
        assert_eq!(state["workspace"]["schemaVersion"], SCHEMA_VERSION);
        assert!(!state["memories"].as_array().unwrap().is_empty());
        assert!(state["proposals"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["origin"] == "ai"));
        assert!(state["tasks"].as_array().unwrap().is_empty());
        assert!(state["reports"].as_array().unwrap().is_empty());
    }
    #[test]
    fn real_schema_one_backup_migrates_preserving_manual_provenance() {
        let dir = tempfile::tempdir().unwrap();
        let mut db = Database::open(dir.path().into()).unwrap();
        let bytes = include_bytes!("../tests/fixtures/schema-v1.zip");
        backup::restore(&mut db,&json!({"filename":"schema-v1.zip","contentBase64":base64::engine::general_purpose::STANDARD.encode(bytes),"confirmation":"RESTORE"})).unwrap();
        let state = db.state().unwrap();
        assert_eq!(state["workspace"]["schemaVersion"], SCHEMA_VERSION);
        assert_eq!(state["memories"].as_array().unwrap().len(), 1);
        assert_eq!(state["proposals"][0]["origin"], "manual");
        assert_eq!(state["proposals"][0]["quotes"], json!([]));
        assert!(db.pending_extract().unwrap().as_array().unwrap().is_empty());
    }

    #[test]
    fn restoring_an_unparsed_import_resumes_parsing_without_authorizing_ai() {
        let dir = tempfile::tempdir().unwrap();
        let mut db = Database::open(dir.path().into()).unwrap();
        local_settings(&mut db, true);
        let source = imported(&mut db, "备份中的待解析原件");
        let archive = backup::create(&mut db).unwrap();
        let bytes = fs::read(
            db.root
                .join("backups")
                .join(archive["filename"].as_str().unwrap()),
        )
        .unwrap();
        backup::restore(&mut db,&json!({"filename":archive["filename"],"contentBase64":base64::engine::general_purpose::STANDARD.encode(bytes),"confirmation":"RESTORE"})).unwrap();
        finish_parse(&mut db, &source);
        assert_eq!(
            db.conn
                .query_row(
                    "SELECT count(*) FROM jobs WHERE kind='extract'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        assert_eq!(
            db.source_detail(source["sourceId"].as_str().unwrap())
                .unwrap()["source"]["status"],
            "ready"
        );
    }

    #[test]
    fn restart_resumes_interrupted_extraction_but_keeps_cancellation() {
        let dir = tempfile::tempdir().unwrap();
        let mut db = Database::open(dir.path().into()).unwrap();
        local_settings(&mut db, false);
        let source = imported(&mut db, "恢复作业");
        finish_parse(&mut db, &source);
        let job = db
            .start_extraction(source["sourceId"].as_str().unwrap())
            .unwrap();
        let job = job["id"].as_str().unwrap().to_owned();
        db.claim_extract(&job, db.epoch).unwrap().unwrap();
        drop(db);
        let mut db = Database::open(dir.path().into()).unwrap();
        assert_eq!(db.job(&job).unwrap()["status"], "queued");
        assert_eq!(db.job(&job).unwrap()["recovered"], true);
        db.cancel_extraction(&job).unwrap();
        drop(db);
        let db = Database::open(dir.path().into()).unwrap();
        assert_eq!(db.job(&job).unwrap()["status"], "cancelled");
        assert!(db.pending_extract().unwrap().as_array().unwrap().is_empty());
    }
    #[test]
    fn restore_epoch_rejects_a_previous_parser_result_even_for_the_same_job_id() {
        let dir = tempfile::tempdir().unwrap();
        let mut db = Database::open(dir.path().into()).unwrap();
        let project = db
            .execute(Request {
                command: "create_project".into(),
                payload: json!({"name":"代际隔离"}),
            })
            .unwrap();
        let source = db
            .execute(Request {
                command: "import_text".into(),
                payload: json!({"projectId":project["id"],"title":"原始","text":"真正原文"}),
            })
            .unwrap();
        let backup = backup::create(&mut db).unwrap();
        let job = source["jobId"].as_str().unwrap();
        assert!(db.claim(job, 0).unwrap().is_some());
        let bytes = fs::read(
            db.root
                .join("backups")
                .join(backup["filename"].as_str().unwrap()),
        )
        .unwrap();
        backup::restore(&mut db,&json!({"filename":backup["filename"],"contentBase64":base64::engine::general_purpose::STANDARD.encode(bytes),"confirmation":"RESTORE"})).unwrap();
        db.complete(
            job,
            0,
            0,
            Ok(vec![ParsedSegment {
                locator: "旧任务".into(),
                text: "不应写回".into(),
            }]),
        )
        .unwrap();
        assert_eq!(
            db.source_detail(source["sourceId"].as_str().unwrap())
                .unwrap()["source"]["status"],
            "processing"
        );
        assert_eq!(
            db.conn
                .query_row("SELECT count(*) FROM segments", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        let task = db.claim(job, db.epoch).unwrap().unwrap();
        db.complete(
            job,
            db.epoch,
            task.generation,
            Ok(vec![ParsedSegment {
                locator: "第 1 行".into(),
                text: "真正原文".into(),
            }]),
        )
        .unwrap();
        assert_eq!(
            db.source_detail(source["sourceId"].as_str().unwrap())
                .unwrap()["segments"][0]["text"],
            "真正原文"
        );
    }
}
