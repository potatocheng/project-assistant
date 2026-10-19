# Phase one application contract

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

Revision: `{ id, memoryId, number, content, reason, origin: "confirmation"|"user_correction", createdAt, evidence: Evidence[] }`.

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
