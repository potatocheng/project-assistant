# Phase one application contract

## Personal Feishu assistant extension

`ask_project {projectId,question}` performs read-only retrieval over the project's active current confirmed memory, then an independently prompted model answer. Returns `{answer,citations,grounded,context}`. No matches returns grounded=false without a model request. Citations carry the current revision and its evidence. Actor-owned snapshots carry workspace epoch and model settings revision; changes during generation reject stale answers. Extraction material consent also gates remote QA.

`get_feishu_status {}` returns redacted settings, personal authorization status, runtime status, and recent delivery records. `save_feishu_settings {appId,appSecret?,enabled,pollIntervalSeconds,replyPrefix,bindings:[{chatId,projectId,enabled}]}` validates local project IDs and updates device settings. `begin_feishu_authorization {}` returns `{authorizationUrl,redirectUri,expiresAt}` and starts a state-checked loopback OAuth callback. `disconnect_feishu {}` clears local personal authorization and disables delivery. `poll_feishu_now {}` requests an asynchronous poll. `list_feishu_chats {}` returns `{chats:[{chatId,name}]}` from personal authorization.

The connector uses personal OAuth credentials only and searches new mentions of the authorized user inside explicitly bound enabled group chats. Delivery receipts have persistent message-ID deduplication outside project backups. Restore pauses the connector before changing project state. Network operations run outside the database actor and reuse its existing Engine rather than opening another workspace instance. Configuration and tokens are device-local, private, redacted, and excluded from project backups. See [setup and operational behavior](feishu-personal-assistant.md).

The Rust core owns all persistent state. React uses a single `execute` Tauri command with `{ request: { command, payload } }`. Payloads and response objects use camelCase. Commands return JSON data or an error `{ code, message }`. There is no model connection in phase one. A user creates a proposal from source segments, then explicitly confirms it.

Core public API: `Engine::open(root: impl AsRef<Path>) -> Result<Engine, AppError>`; cloneable Engine; `Engine::execute(request: Request) -> Result<serde_json::Value, AppError>`; `Request { command: String, payload: serde_json::Value }` (serde). A dedicated database thread owns the connection; parsing is outside the database actor. On startup pending/interrupted imports resume from persisted originals. All tests use isolated workspace directories.

## Commands

* `get_state {}` → `{ workspace, projects, sources, proposals, memories, jobs, backups }`.
* `create_project { name, description? }` → Project.
* `import_text { projectId, title, text, sourceAt? }` → `{ jobId, duplicate, sourceId }`.
* `import_file { projectId, filename, contentBase64, sourceAt? }` → same result. Inputs are user-selected file bytes; never arbitrary renderer-supplied filesystem paths. Support TXT/MD/DOCX/text PDF, with an explicit failure for empty/scanned PDF. File limit 10 MiB.
* `get_source { sourceId }` → `{ source, segments }`.
* `create_proposal { projectId, sourceId, segmentIds, kind, content }` → Proposal. Evidence must belong to that project/source; content and at least one segment are required.
* `confirm_proposal { proposalId }` → Memory summary. Repeating confirmation is idempotent.
* `reject_proposal { proposalId }` → Proposal.
* `get_memory { memoryId }` → `{ memory, revisions }`, each revision includes its evidence array.
* `revise_memory { memoryId, baseRevision, content, reason, segmentIds? }` → Memory summary. Reject stale baseRevision. Empty segmentIds means a personal correction, not a claim supported by old evidence.
* `create_backup {}` → Backup record. A ZIP with manifest, consistent SQLite snapshot, and original files; excludes backups. Verify checksums and schema/integrity before restore.
* `inspect_backup { filename, contentBase64 }` → `{ formatVersion, createdAt, counts, compatible }`.
* `restore_backup { filename, contentBase64, confirmation: "RESTORE" }` → `{ safetyBackupId, counts }`. Validate fully first; automatically retain a safety backup of current state. Running imports cannot write old results after restoration.

## DTOs

Workspace: `{ dataDir, schemaVersion, recoveredJobs }`.

Project: `{ id, name, description, createdAt }`.

Source: `{ id, projectId, title, kind, originalFilename, sourceAt: string|null, importedAt, sha256, status: "processing"|"ready"|"failed", segmentCount, error: string|null }`.

Segment: `{ id, sourceVersionId, ordinal, locator, text }`. Text is returned intact. A locator identifies paragraph/table/page; never exchange UTF-8 byte offsets for JS slicing.

Proposal: `{ id, projectId, sourceId, kind, content, status: "pending"|"confirmed"|"rejected", segmentIds: string[], createdAt, memoryId: string|null }`.

Memory: `{ id, projectId, kind, content, revision: number, state: "active", sourceTitle, confirmedAt, updatedAt }`.

Revision: `{ id, memoryId, number, content, reason, origin: "confirmation"|"user_correction"|"automatic", createdAt, evidence: Evidence[] }`.

Evidence: `{ segmentId, sourceId, sourceTitle, locator, text }`.

Job: `{ id, kind, status: "queued"|"running"|"succeeded"|"failed", stage, error: string|null, sourceId, createdAt, updatedAt, recovered: boolean }`.

Backup: `{ id, filename, createdAt, byteSize, sha256, counts: { projects, sources, memories } }`.

Kinds for memories/proposals: `fact`, `decision`, `requirement`, `risk`.

## Desktop-only operations

`export_backup { backupId }` opens a native Save dialog in Rust and exports that backup to the chosen path. Cancellation returns `{ cancelled: true }`. Rust resolves backup IDs within its own backup directory; the renderer cannot choose an arbitrary read path.

## Browser QA

A development-only HTTP adapter can forward the same JSON requests to the Rust JSONL host. It must be loopback-only, origin-checked, not included in the production build, and use isolated test data. The packaged application needs no local HTTP server and no external service.


## Phase two: AI extraction (authoritative additions)

Settings are device-local, excluded from backups. Raw API keys are never returned, stored in SQLite, included in jobs, sent to the renderer on reads, or logged. Defaults: provider=openai_compatible, baseUrl=https://api.deepseek.com, model=deepseek-flash, outputFormat=json_object, timeoutSeconds=60, autoExtract=false, remoteConsent=false. DeepSeek JSON mode uses response_format=json_object with JSON instructions. Ollama remains an optional loopback-only provider.

### Commands

- `get_ai_settings {}` -> AiSettingsPublic.
- `save_ai_settings {provider,baseUrl,model,outputFormat,timeoutSeconds,autoExtract,remoteConsent,apiKey?}` -> AiSettingsPublic. Omitted apiKey retains the existing key ONLY when provider and normalized baseUrl are unchanged; empty string clears it. Endpoint changes clear the key unless explicitly replaced. Settings/key are a private local file (directory0700/file0600), never part of a ZIP. Enabling autoExtract affects future imports only; never silently scans existing ready sources.
- `test_ai_connection {}` -> `{ok:true,message,models:string[]}`. Tests SAVED config with a small synthetic structured extraction request, sending no project material; runs outside DB actor. Validates the selected model/auth/output shape, not just GET models.
- `start_extraction {sourceId}` -> Job. Explicitly starts extraction for ready source with saved valid config/remoteConsent, even when autoExtract=false. Returns existing queued/running job for source; a completed prior run can produce a new run but exact candidate fingerprints never reappear (including ignored/confirmed).
- `retry_extraction {jobId}` -> Job. Failed/cancelled job only; increments attempt/generation, reuses job. No automatic network retries.
- `cancel_extraction {jobId}` -> Job. Immediate persisted cancellation; invalidates old results by generation; stops later batches. Inflight HTTP may already have been sent.
- `update_proposal {proposalId,kind,content}` -> Proposal. Pending only; preserves evidence/provenance and sets edited=true. Confirmed or rejected proposals cannot be edited.

### DTO additions

`AiSettingsPublic = {provider: "openai_compatible"|"ollama",baseUrl:string,model:string,outputFormat:"json_object"|"json_schema",timeoutSeconds:number,autoExtract:boolean,remoteConsent:boolean,configured:boolean,hasApiKey:boolean}`. configured means complete usable saved config, NOT proven connection success. All keys above required on reads.

AppState adds `aiSettings:AiSettingsPublic`. Jobs add `attempts:number,generation:number,provider:string|null,model:string|null,promptVersion:string|null,inputHash:string|null,completedBatches:number,totalBatches:number,candidateCount:number,discardedCount:number,errorCode:string|null`. kind adds extract; status adds cancelled. Source parsing status remains independent of AI state. Source-level extraction state comes from latest extract job for source (updatedAt/createdAt), with no job meaning never started.

Proposals add `origin:"manual"|"ai",provider:string|null,model:string|null,promptVersion:string|null,extractionJobId:string|null,quotes:Array<{segmentId:string,quote:string}>,edited:boolean`. Manual proposals default origin=manual, other provenance null,quotes=[],edited=false. AI evidence requires a valid segment ID in the current source/batch and an exact nonempty quote substring of it. Formal memory is created ONLY by confirm_proposal.

### Execution and recovery

Parsing completion atomically queues extraction only if saved autoExtract is enabled and configured/consented. Separate bounded worker for AI; actor never blocks on HTTP. Whole extraction output commits as pending candidates in one transaction after all batches succeed. Mixed invalid items are discarded with counts; all-invalid output is an explicit grounding failure; a valid empty array is successful zero candidates. No automatic memory merging or updates.

Claim/progress/complete use epoch+generation and verify running status. Source hash/prompt/provider/model are snapshotted per attempt (never key). Repeated requests deduplicate. Restart recovers interrupted jobs, cancellation stays cancelled. AI config changes cancel old queued/running jobs (old endpoint work must not resume under a different setting); do not mutate completed results. Restoring a backup preserves current device settings, invalidates old worker results, and pauses restored extraction jobs until explicit user retry; no cloud requests triggered by a restored archive alone.

Schema v1 opens with transactional migration to v2 preserving manual provenance. Both v1 and v2 backups validate and restore; unknown future versions refuse. AI provenance and job fields are part of v2 backup validation.

## Phase three: local tasks, daily work and reports (authoritative)

No API key is required for task management, daily lists or report generation. Reports are deterministic LOCAL drafts from confirmed task events, with editable saved versions. AI continues to generate proposals only. Never guess personal identity from assignee strings: action=personal execution, follow_up=tracking somebody's delivery, explicitly selected by the user (source candidates default follow_up).

### Dates and events

All date-only fields use strict YYYY-MM-DD; frontend computes date using LOCAL calendar fields, never UTC toISOString slicing. Every task mutation supplies workDate (actual business date) and a clientRequestId (UUID) for idempotent retries. recordedAt is independent UTC audit time. Task changes use baseVersion. A task mutation workDate cannot precede that task's last event workDate (explicit validation error, no silent rewriting); backdated creation and chronologically recorded progress are supported. plannedDate/dueDate can be future. Historical lists/reports use immutable event snapshots as of requested date, never today's task fields. A later reopen or rename cannot change a past draft or historical completion classification.

### Task commands

- `create_task {projectId,title,description?,category,assignee?,priority,status?,progress?,dueDate?,plannedDate?,workDate,clientRequestId,memoryId?}` -> Task. memoryId must belong to project; evidence is copied from that memory's CURRENT revision only, store memoryRevision. Manual tasks have no fabricated evidence. Title required <=300 chars, description <=10000. status default todo; progress default0; done requires100. progress100 does NOT implicitly mark done. category action|follow_up, priority high|medium|low. Optional strings/dates may be null. A nonempty assignee is a free text label, never inferred as the current user.
- `update_task {taskId,baseVersion,title,description,category,assignee,priority,status,progress,dueDate,plannedDate,note,workDate,clientRequestId}` -> Task. Full form values; note required, <=10000; optimistic conflict preserves state. Appends event with before/after snapshots, actual workDate and user origin. Evidence does not silently carry into USER progress events (original task evidence remains visible separately).
- `get_task {taskId}` -> `{task:Task,events:TaskEvent[],evidence:Evidence[]}`; events newest first, including per-event original evidence when source-backed.
- `get_daily_list {date,projectId?}` -> `{date,tasks:Task[],counts:{todo,in_progress,blocked,done,cancelled}}`. Tasks as of date included if (active and (plannedDate<=date OR dueDate<=date)) OR had a task event on date. Active=todo/in_progress/blocked. Unscheduled work stays in task pool until explicitly planned. Sort active first then priority/due date. Done/cancelled from older days do not reappear merely because overdue. ProjectId absent means all projects; never cross project evidence boundaries.

Task = `{id,projectId,title,description,category:"action"|"follow_up",assignee:string|null,priority:"high"|"medium"|"low",status:"todo"|"in_progress"|"blocked"|"done"|"cancelled",progress:number,dueDate:string|null,plannedDate:string|null,version:number,origin:"manual"|"memory"|"ai",memoryId:string|null,memoryRevision:number|null,createdAt,updatedAt}`. Daily task snapshots use same shape (version represents as-of snapshot). TaskEvent = `{id,taskId,projectId,version,workDate,recordedAt,note,origin:"user"|"memory"|"ai",before:Task|null,after:Task,evidence:Evidence[]}`. A creation can be done (backfilled result), but completion date remains workDate, never import date.

### AI task proposals

AppState adds `tasks:Task[],taskProposals:TaskProposal[],reports:ReportSummary[]`. Job adds `taskCandidateCount:number` (separate from existing memory candidateCount). Existing fields remain compatible.

The model's structured output adds optional `taskCandidates:AiTaskCandidate[]`, alongside existing `candidates`. New requested schema requires both fields, runtime accepts old candidates-only responses as taskCandidates=[] for compatibility. PROMPT_VERSION increments. AiTaskCandidate = `{title,description,assignee:string|null,dueDate:string|null,dueText:string|null,status:"todo"|"in_progress"|"blocked"|"done",progress:number|null,evidence:CandidateEvidence[]}`. Only explicit absolute dates with a year are resolved; relative dates stay verbatim dueText, dueDate=null. Assignee/progress must be explicit and supported in quoted evidence. Development completion is not evidence that a wider delivery/acceptance task is done. No previously confirmed task state is sent to the model or silently modified. All-invalid task output is grounding failure; legitimate empty arrays succeed; both proposal types commit atomically after all batches succeed.

TaskProposal = `{id,projectId,sourceId,title,description,assignee:string|null,dueDate:string|null,dueText:string|null,taskStatus,progress:number|null,status:"pending"|"confirmed"|"rejected",segmentIds:string[],quotes:Array<{segmentId,quote}>,model,provider,promptVersion,extractionJobId,edited:boolean,taskId:string|null,createdAt}`. Exact quote, scope, epoch/generation, restart, dedup and restoration controls match memory candidates. No general memories receive task statuses.

- `update_task_proposal {proposalId,title,description,assignee,dueDate,dueText,taskStatus,progress}` -> TaskProposal. Pending only; retains original evidence/model/fingerprint and edited=true. Required fields supplied, nullable values allowed.
- `confirm_task_proposal {proposalId,mode:"create"|"update",taskId?,baseVersion?,category,priority,plannedDate?,workDate,note,clientRequestId}` -> Task. create uses proposal fields, default category must be explicitly chosen by UI; update applies proposed status/progress as a REVIEWED update to existing same-project task (baseVersion required), keeps that task's existing title/assignee/priority/dueDate/category/plan, records original proposal text/quotes as this progress event. For update UI shows compared current/proposed status and progress before submission. Idempotent confirmation returns already linked task; rejected cannot confirm.
- `reject_task_proposal {proposalId}` -> TaskProposal. Confirmed proposal cannot reject.

### Daily reports

- `generate_daily_report {date,projectId?,clientRequestId}` -> DailyReport. Always local, no network. Freezes relevant task events and as-of task snapshots in report basis; creates a NEW report version for that date+scope, never overwrites an edited previous version. Repeated same clientRequestId returns same report. Sections: completion, other progress/follow-up, blocked/overdue, follow-up plans. Completion requires an event transition to done ON date and final as-of-date status still done. Reopen same day belongs in progress, not final completion; already done before date is not today's achievement. action/follow_up and assignee displayed, never calls another person's delivery "I completed". Future task changes cannot leak into old reports. No-event dates explicitly say no recorded progress. Plans are based on as-of-date facts and explicitly labeled; not promised future accomplishments.
- `get_daily_report {reportId}` -> DailyReport.
- `save_daily_report {reportId,baseVersion,content,clientRequestId}` -> DailyReport. Saves user text as NEW version (does not destroy generated or edited history); optimistic concurrency per date+scope latest version; no source event mutation. content <=100000 chars, nonempty. Edited report preserves original frozen basis and shows edited=true. No regenerated AI prose without user action.

ReportSummary = `{id,date,projectId:string|null,version:number,edited:boolean,createdAt,updatedAt}`. DailyReport adds `{content:string,basis:{events:TaskEvent[],tasks:Task[],generatedAt:string}}`. null projectId=all projects. UI supports version selection, plain Markdown editing, clipboard copy, native .md export. Never auto-send a report to a colleague/platform. Core reports include task IDs and source references in basis so UI can open task/evidence.

Desktop `export_report {reportId}` -> `{cancelled:boolean,path?:string}` opens native save dialog and writes report content obtained from Rust, never an arbitrary renderer filesystem path. QA bridge adds GET /reports/:id/download for isolated dev only.

### Persistence

Schema3 transactional migration preserves v1/v2 sources/memories/AI provenance. Tasks/events/proposals/report versions/idempotency records join consistent backups and full type/domain/evidence validation. v1 and v2 archives restore and migrate; unknown future schema refuses. Existing restored import/extract pause rules remain unchanged. Default daily page uses client date 2026-10-19 when applicable; do not hardcode it in product code.

Phase3 desktop also adds `copy_report {reportId}` -> `{copied:true}`, writing the Rust-stored report through native clipboard; renderer does not receive general clipboard-read access. Counts for v3 backups add `tasks,reports` (report version count); old backup counts may omit these and UI displays0. Restore inspection must show task/report differences too. Existing counts fields remain unchanged.


## Schema 4: source ingestion and memory maintenance

- `get_feishu_sources {}` → `{settings:{enabled,intervalSeconds,sources:[{kind:"chat"|"document",target,projectId,enabled,historyDays}]},syncing,statuses,lastError}`. Source start anchors are server managed. Only explicitly selected sources are read; document URLs are validated as Feishu docx/wiki references. No arbitrary URL fetching.
- `save_feishu_sources {enabled,intervalSeconds,sources}` → same status. Validates existing project IDs, source identity uniqueness, intervals60–3600 and lookback1–30 days. Source settings and cursors are device-local, excluded from archives.
- `sync_feishu_sources {}` → `{queued:true}`. Queues asynchronous read/import work; inspect source statuses for completion. No reply is sent by ingestion.
- `get_memory_maintenance {}` → `{settings:{enabled,idleSeconds,dailyCalls,autoNew,revision},callsToday,blockedReason,reviews,runs,origins}`. Defaults: enabled=true, idleSeconds=120, dailyCalls=100, autoNew=true. `get_state` adds `memoryReviewCount`.
- `save_memory_maintenance {enabled,idleSeconds,dailyCalls,autoNew}` → settings. Validates idle30–3600 and dailyCalls1–2000; cancels stale work through a new configuration revision.
- `memory_activity {}` → `{ok:true}`. Debounced actual user input only; polling must never call it.
- `run_memory_maintenance {}` → `{queued:true}`. Explicitly runs one item even when scheduled maintenance is disabled; respects saved model permissions and daily budget.
- `retry_memory_maintenance {}` requeues failed comparisons. Extraction retries use `retry_extraction`.
- `recompare_memory_review {reviewId}` discards a still-pending comparison and queues fresh comparison; never changes formal memory.
- `resolve_memory_review {reviewId,action:"new"|"replace"|"mergeEvidence"|"ignore",baseRevision?,content?}` → `{resolved:true}`. Public calls cannot set automatic provenance. Target mutations require both reviewed and current revisions to match. New/replace may use user-edited content; mergeEvidence preserves current content and prior evidence.

Comparisons use current same-project memory with bounded model input, occurrence/revision metadata, exact-quote proposals and immutable source snapshots. Incomplete context cannot auto-admit new facts. Only Feishu-collected sources auto-apply independent new facts (if enabled) or literal duplicates; manually imported candidates remain pending. Conflicts and semantic duplicates need user review. Each accepted change creates a revision with evidence; `automatic` is visibly distinguished from human confirmation.

Workspace epoch, configuration revision, model revision, source/job generations, proposal and memory snapshots plus user-activity generation guard commits. Worker HTTP runs outside the actor. Counters reserve each network model call before dispatch, including failed/ambiguous requests; deterministic local comparisons do not consume calls. Restoration pauses scheduled work and keeps the larger local daily usage counter, so old archives cannot refund requests. Secrets, subscriptions, cursors and reply receipts never enter project archives; source provenance, memory reviews and run histories do.

Unresolved pending conflict/uncertain reviews with a target temporarily exclude that target from QA retrieval; the same check before sending invalidates an answer started before the conflict appeared. Resolution restores eligibility without deleting historical memory.


## Schema 5: reviewed workload and daily capacity planning

- `get_daily_planning {date,projectId?}` returns dated `capacity` (nullable), scoped active `tasks`, `estimates`, `relations`, that date's `allocations`, latest scoped `drafts` with stale flags, latest applicable `confirmedPlan`, bounded context counts and `modelAvailable`. Polling does not count as user activity.
- `save_daily_capacity {date,minutes,bufferMinutes,baseRevision}` explicitly sets that date's personal capacity. Integer minutes0–960, buffer0–minutes, optimistic revision (null on creation). Past dates are immutable. No default/carry-forward capacity.
- `save_task_estimate {taskId,baseVersion,baseUpdatedAt,minutes}` explicitly confirms5–1440 integer minutes. Task version and prior estimate timestamp (null on first estimate) must match.
- `analyze_task_workload {date,projectId?,useModel?:boolean}` captures actor snapshot, performs bounded grounded structured analysis outside actor, saves pending analysis only if snapshot still current. Default useModel=true, saved material consent required. useModel=false suggests literal duplicates and existing pending source task proposals. No task mutation.
- `preview_task_relation {date,projectId?,kind:"dependency"|"blocker",taskId,targetId:string|null,reason}` creates a one-change pending review; dependency means taskId waits for targetId. Same project, no self-reference.
- `generate_daily_plan {date,projectId?,durationOverrides?:Record<taskId,integer>,skipTaskIds?:string[]}` creates pending deterministic dependency/capacity preview. Requires saved capacity. Unknown task overrides rejected. Result contains `items`, `deferred`, `commitments`, totals, date changes, reasons, assumptions and conditional prerequisites; no task mutation.
- `confirm_planning_draft {draftId,selectedIds:string[]}`: analysis requires nonempty explicit chosen suggestion IDs; schedule requires[] and confirms complete reviewed plan (partial changes require regenerated preview). Snapshot guards include task versions, source/memory/proposal snapshots, estimates, graph, allocations, daily capacity, model revision and workspace epoch. Atomic transaction; cyclic graphs and merge chains rejected, no cross-project edges. Same applied selection is idempotent.
- `dismiss_planning_draft {draftId}` dismisses pending suggestion with no task changes.
- `remove_task_relation {relationId,createdAt}` confirms deactivation of one dependency/blocker. History retained. Does not change task status.

Capacity is shared across projects; scoped plans reserve other-project same-day commitments plus same-day done work. Action predecessors may be sequenced in one day with explicit conditional wording. Follow-up effort never proves delivery and cannot unlock a dependent task. Scheduling does not change task status/progress/owner/deadline. Future planned dates are kept; non-fitting same-day items explicitly preview clearing plannedDate to null; no automatic next-day promises. Confirmed duration/order/reasons are separately persisted; task date changes enter normal user task events. Merge cancels source tasks with notes, keeps target fields, redirects dependencies/blockers and preserves history. Reviewed source task proposals can apply status/progress as shown; memory-based new tasks are unscheduled follow-ups with unassigned owner/deadline.

Model evidence must be a same-project literal quote from the supplied catalog; memory_task and proposal changes must cite their respective source object. Current memories with pending conflict/uncertain reviews are excluded. Latest ready remote object version is used for Feishu original excerpts. Full scoped active task inventory is retained; descriptions and material excerpts are bounded, coverage limitations displayed. Up to100 suggested changes. No credentials, privileged commands or source instructions enter control flow.

Schema5 adds planning_capacity,task_estimates,task_relations,planning_drafts,daily_allocations. Snapshot fingerprints, authentic historical task snapshots, analysis grounding, graph validity, deterministic schedule equality and allocation/draft consistency are validated during backup inspection. Restoration preserves confirmed planning history and invalidates pending drafts. Device Feishu credentials/settings remain excluded.
# 项目交付与统一问答增量接口（schema 6）

| 命令 | 主要输入 | 行为 |
| --- | --- | --- |
| `get_delivery_overview` | `date`, 可选 `projectId` | 返回项目档案、里程碑、任务计数、关注状态及判断依据 |
| `save_project_profile` | `projectId`, `goal`, `status`, `targetDate`, `baseVersion` | 首次版本 0；后续按当前版本更新 |
| `save_milestone` | `projectId`, 可选 `milestoneId`/`baseVersion`, `title`, `description`, `status`, `baselineDate`, `forecastDate`, `taskIds` | 新建或更新里程碑；关联仅限同项目，完成需关联任务全部完成 |
| `get_follow_up_center` | `date`, 可选 `projectId` | 返回命中提醒、暂缓状态、跟进历史和未结任务跟进版本 |
| `record_follow_up` | `taskId`, `baseVersion`, `workDate`, `note`, `nextFollowUpDate` | 保存独立跟进历史及下次日期，不修改任务交付状态 |
| `snooze_follow_up` | `taskId`, `baseVersion`, `date`, `snoozedUntil` | 暂缓至指定日期；空值取消暂缓 |
| `ask_assistant` | `question`, `date`, 可选 `projectId`/`useModel` | 默认本地规则，返回 `answer`, `mode`, `grounded`, `citations`, `updatedAt`, `limitations` |

上述读取以当前记录为基础；`date` 不重建历史快照。问答内部快照与校验命令不能由公开 Engine/Tauri 接口调用。`ask_project` 与飞书问答的记忆范围保持独立。

## 项目管理增量接口（schema 7）

所有写入均校验同项目引用与当前版本，保留业务日期、录入时间和不可变修订。工作区备份包含新台账及历史。`get_state` 增加 `managementRevision`，用于使问答和管理提示随记录更新。

| 命令 | 主要输入与行为 |
| --- | --- |
| `get_governance_workspace` / `get_governance_item` | `projectId?`, `date` / `itemId`；返回风险、问题、待决策台账及修订、依据 |
| `save_governance_item` | `itemId?`, `baseVersion?`, `projectId`, `kind`, `title`, `owner`, `severity`, `impact`, `responsePlan`, `status`, `workDate`，可选期限、复查、升级对象、关联和证据；关闭需 `resolution` / `closureReason`，决策另需 `decisionMaker` / `conclusion` |
| `record_governance_progress` | `itemId`, `baseVersion`, `workDate`, `note`；记录独立进展 |
| `get_change_acceptance` | `projectId?`, `date`；返回变更、交付验收、历史及目标版本复核结果 |
| `save_change_request` | `changeId?`, `baseVersion?`, `projectId`, `date`, `title`, `before`, `after`, `reason`, `requester`, `decisionOwner`, `scopeImpact`, `scheduleImpact`, `effortImpact`, `links`, `segmentIds` |
| `transition_change_request` | `changeId`, `baseVersion`, `date`, `status`, `actor`, `note`；提交、批准、拒绝、实施或取消，批准人必须匹配决策人 |
| `save_deliverable` | `deliverableId?`, `baseVersion?`, `projectId`, `date`, `title`, `owner`, `target:{kind,id,version}`, `criteria:[{id?,title,status,evidence,note}]`, `links`, `segmentIds` |
| `review_deliverable` | `deliverableId`, `baseVersion`, `date`, `status`, `reviewer`, `note`, `remediation`；先进入 `in_review`，再 `accepted` / `rejected`，通过要求标准全部通过且目标在验收日期前已完成 |
| `delete_change_request` / `delete_deliverable` | 草案软取消，保留历史 |
| `coordination_list` | `projectId?`；返回周报、会议及行动项索引 |
| `coordination_generate_report` | `projectId?`, `startDate`, `endDate`, `reportId?`, `baseVersion?`；保存新报告版本及冻结依据 |
| `coordination_get_report` / `coordination_save_report` | `reportId`, `version?` / `reportId`, `baseVersion`, `content`；读取历史或保存编辑版 |
| `coordination_save_meeting` | `projectId`, `meetingId?`, `baseVersion?`, `title`, `date`, `attendees`, `objective`, `agenda`, `briefing`, `minutes`, `decisions` |
| `coordination_prepare_meeting` / `coordination_get_meeting` | `meetingId`, `baseVersion` / `meetingId`, `version?`；生成材料或读取历史 |
| `coordination_save_action` | `meetingId`, `actionId?`, `baseVersion?`, `title`, `owner`, `dueDate`, `status`；仅记录约定 |
| `coordination_confirm_action` | `actionId`, `baseVersion`, `workDate`, `category?:action\|follow_up`；默认跟进，幂等返回 `{action,task,alreadyConfirmed}` |
| `get_management_attention` | `date`, `projectId?`；只读关注项，供总览与全局提示使用 |

桌面 `export_coordination_report {reportId,version}` 使用保存对话框导出 Rust 中已保存的 Markdown；`copy_coordination_report` 复制同一保存版本。统一问答增加治理、变更、验收、周报、会议及行动项引用，可跳回管理记录；行动项同时标明当前任务状态、负责人、期限和会议原约定。


## 飞书私聊代答

`save_feishu_settings.bindings[]` 在原有 `chatId`、`projectId`、`enabled` 上增加 `chatType: group|p2p`、`peerId`、`name`。省略 `chatType` 的旧配置仍视为群聊；私聊必须提供同事 Open ID。会话 ID 全局唯一，绑定项目必须存在。修改类型、同事、项目或启用状态时重置该绑定的新消息起点。

`list_feishu_private_chats {}` 使用个人身份读取最近 30 天最多 500 条私聊消息及会话元数据，返回 `{chats:[{chatId,peerId,name}],hasMore}`；仅发现会话，不入项目资料、不排队回复、不返回消息正文。`hasMore` 表示达到扫描上限，界面允许手动填写。

`get_feishu_status.recentMessages[]` 增加 `chatType`、`peerId`、`peerName`，来自接收消息时的绑定快照，不依赖当前绑定。旧回执自动迁移为 `group`，原去重与发送状态保留；回执不随项目备份倒退。群聊仍要求明确 @本人，私聊仅接受已核对的会话及同事的新消息。

## 主动巡检与持续跟进增量接口（schema 8）

主动巡检运行在 Rust 核心，默认启用、默认复查间隔为 60 分钟。应用启动、每分钟后台轮询和相关业务写入后评估当前工作区；不依赖 React 页面保持打开。应用退出后不会继续运行。读取中心不触发巡检，`projectId` 只限制读取和本次手动巡检范围，后台仍评估整个工作区。

| 命令 | 输入与返回 |
| --- | --- |
| `get_proactive_center` | `{projectId?}` → ProactiveCenter；读取行动、历史和设置 |
| `run_proactive_scan` | `{projectId?}` → ProactiveCenter；立即评估所选范围，关闭时保持暂停 |
| `save_proactive_settings` | `{enabled,reviewMinutes,baseRevision}` → Settings；`reviewMinutes` 为 5–10080 的整数，`baseRevision` 必须匹配当前 UUID 版本；重新启用后立即评估 |
| `update_proactive_action` | `{actionId,baseVersion,operation,note,nextCheckAt?}` → Action；`operation` 为 `watch` / `snooze` / `dismiss` / `reopen`，版本冲突拒绝覆盖 |

`ProactiveCenter = {settings,lastRunAt,lastError,counts,actions,history}`。`Settings = {enabled,reviewMinutes,revision}`；`counts` 包含 `ready,watching,snoozed,resolved,dismissed,total`。`Action` 包含 `id,projectId,projectName,targetKind,targetId,title,status,priority,reason,suggestedAction,draft,evidence,version,createdAt,updatedAt,lastCheckedAt,nextCheckAt,reviewCount,unchangedChecks,outcome`；`priority` 为整数，越大越优先。`evidence[] = {label,detail,targetKind,targetId}`，引用同项目的实际记录；`History = {id,actionId,kind,note,createdAt}`。按项目读取时，行动、统计和历史均限制在该项目；中心返回最近 200 条历史，完整历史持久保存。

`watch` / `snooze` 必须提供非空说明及未来 366 天以内的 RFC3339 `nextCheckAt`；`watch` 表示已采取跟进并约定复查，`snooze` 表示暂缓处理。`dismiss` / `reopen` 的说明可为空。复查记录和处理说明持久保存，同一目标重复巡检复用行动。目标完成或关注条件解除时自动收束，忽略持续至该次关注解除；再次发生风险时可重开。暂停或取消的项目停止主动跟进。行动仅准备说明、建议和草稿，不替用户修改业务事实、确认资料或发送消息。

schema 8 将主动设置、行动和行动历史纳入一致备份并验证状态、版本、引用及领域约束。兼容旧版工作区迁移和备份恢复，拒绝未来版本。恢复保留跟进记录但将巡检设为关闭；重新启用才重评当前状态。内部定时命令 `_proactive_tick` 不能通过公开 Engine / Tauri / QA bridge 接口调用，也不提供公开测试时钟。运行说明见[主动行动](proactive-assistant.md)。
