export type MemoryKind = 'fact' | 'decision' | 'requirement' | 'risk';
export type ManagementKind = 'governance' | 'change' | 'deliverable' | 'meeting' | 'meeting_action' | 'weekly_report';
export type Page = 'workbench' | 'inbox' | 'governance' | 'changes' | 'coordination' | 'overview' | 'followups' | 'assistant' | 'daily' | 'tasks' | 'reports' | 'sources' | 'memories' | 'backups';

export interface Project { id: string; name: string; description: string; createdAt: string }
export interface Source {
  id: string; projectId: string; title: string; kind: string; originalFilename: string;
  sourceAt: string | null; importedAt: string; sha256: string;
  status: 'processing' | 'ready' | 'failed'; segmentCount: number; error: string | null;
}
export interface Segment { id: string; sourceVersionId: string; ordinal: number; locator: string; text: string }
export interface RetentionPolicy { layer: "durable" | "working" | "clarify" | "archive"; reason: string; reviewAfter?: string | null }
export interface Proposal {
  retention?: RetentionPolicy;
  facets?: Partial<MemoryFacets>;
  id: string; projectId: string; sourceId: string; kind: MemoryKind; content: string;
  status: 'pending' | 'confirmed' | 'rejected'; segmentIds: string[];
  createdAt: string; memoryId: string | null;
  origin: 'manual' | 'ai'; provider: string | null; model: string | null;
  promptVersion: string | null; extractionJobId: string | null;
  quotes: Array<{ segmentId: string; quote: string }>; edited: boolean;
}
export interface ExtractionDraft {
  id: string; jobId: string; sourceId: string; projectId: string; batchKey: string;
  candidate: { retention?: RetentionPolicy; kind: MemoryKind; content: string; facets: MemoryFacets; evidence: Array<{ segmentId: string; quote: string }> };
  facets: MemoryFacets; issues: Array<{ field: string; reason: string; severity: string; value?: unknown }>;
  status: 'ready' | 'needs_review' | 'rejected' | 'reviewed' | 'retained'; proposalId: string | null;
  reviewReason: string; createdAt: string; reviewedAt: string | null;
}
export interface Memory {
  retention?: RetentionPolicy;
  id: string; projectId: string; kind: MemoryKind; content: string; revision: number;
  state: 'active'; sourceTitle: string; confirmedAt: string; updatedAt: string;
}
export interface Evidence { segmentId: string; sourceId: string; sourceTitle: string; locator: string; text: string }
export interface MemoryFacets {
  entity: string; topic: string; role: '' | 'owner' | 'approver' | 'contact'; conditions: string[];
  validFrom: string | null; validUntil: string | null;
}
export interface AnswerClaim {
  text: string; citationIds: string[]; supportQuotes: Array<{ citationId: string; quote: string }>;
}
export type AnswerStatus = 'answered' | 'partial' | 'unknown' | 'conflicted';
export interface Revision {
  retention?: RetentionPolicy;
  facets?: Partial<MemoryFacets>;
  id: string; memoryId: string; number: number; content: string; reason: string;
  origin: 'confirmation' | 'user_correction' | 'automatic'; createdAt: string; evidence: Evidence[];
}
export interface Job {
  id: string; kind: string; status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  stage: string; error: string | null; sourceId: string; createdAt: string; updatedAt: string; recovered: boolean;
  attempts: number; generation: number; provider: string | null; model: string | null;
  promptVersion: string | null; inputHash: string | null;
  completedBatches: number; totalBatches: number; candidateCount: number; discardedCount: number; errorCode: string | null;
  taskCandidateCount: number;
}
export interface AiSettings {
  provider: 'openai_compatible' | 'ollama'; baseUrl: string; model: string;
  outputFormat: 'json_object' | 'json_schema'; timeoutSeconds: number;
  autoExtract: boolean; remoteConsent: boolean; configured: boolean; hasApiKey: boolean;
}
export interface Counts { projects: number; sources: number; memories: number; tasks?: number; reports?: number }
export interface Backup {
  id: string; filename: string; createdAt: string; byteSize: number; sha256: string;
  counts: Counts; kind?: 'manual' | 'safety';
}
export interface AppState {
  lifecycle?: Array<{ kind: 'project' | 'source'; id: string; archived: boolean; replacementId: string | null; reason: string; version: number }>;
  workspace: { dataDir: string; schemaVersion: number; recoveredJobs: number; revision?: string };
  projects: Project[]; sources: Source[]; proposals: Proposal[];
  extractionDrafts?: ExtractionDraft[];
  extractionBatches?: { jobId: string; sourceId: string; batchKey: string; status: string; coverage?: { previousCandidates?: { content: string }[]; issues?: { field: string; reason: string; segmentId?: string }[] } }[];
  memories: Memory[]; jobs: Job[]; backups: Backup[];
  aiSettings: AiSettings; memoryReviewCount: number;
  managementRevision?: string;
  assistantPreferenceVersion?: number;
  tasks: Task[]; taskProposals: TaskProposal[]; reports: ReportSummary[];
}
export type TaskStatus = 'todo' | 'in_progress' | 'blocked' | 'done' | 'cancelled';
export type TaskCategory = 'action' | 'follow_up';
export type TaskPriority = 'high' | 'medium' | 'low';
export interface Task {
  id: string; projectId: string; title: string; description: string;
  category: TaskCategory; assignee: string | null; priority: TaskPriority;
  status: TaskStatus; progress: number; dueDate: string | null; plannedDate: string | null;
  version: number; origin: 'manual' | 'memory' | 'ai'; memoryId: string | null;
  memoryRevision: number | null; createdAt: string; updatedAt: string;
}
export interface TaskEvent {
  id: string; taskId: string; projectId: string; version: number; workDate: string;
  recordedAt: string; note: string; origin: 'user' | 'memory' | 'ai';
  before: Task | null; after: Task; evidence: Evidence[];
}
export interface TaskDetail { task: Task; events: TaskEvent[]; evidence: Evidence[] }
export interface DailyList { date: string; tasks: Task[]; counts: Record<TaskStatus, number> }
export interface TaskProposal {
  id: string; projectId: string; sourceId: string; title: string; description: string;
  assignee: string | null; dueDate: string | null; dueText: string | null;
  taskStatus: Exclude<TaskStatus, 'cancelled'>; progress: number | null;
  status: 'pending' | 'confirmed' | 'rejected'; segmentIds: string[];
  quotes: Array<{ segmentId: string; quote: string }>; model: string; provider: string;
  promptVersion: string; extractionJobId: string; edited: boolean; taskId: string | null; createdAt: string;
}
export interface ReportSummary {
  id: string; date: string; projectId: string | null; version: number; edited: boolean; createdAt: string; updatedAt: string;
}
export interface DailyReport extends ReportSummary {
  content: string; basis: { events: TaskEvent[]; tasks: Task[]; generatedAt: string };
}
export const TASK_STATUS: Record<TaskStatus, string> = { todo: '待办', in_progress: '进行中', blocked: '阻塞', done: '完成', cancelled: '取消' };
export const TASK_PRIORITY: Record<TaskPriority, string> = { high: '高', medium: '中', low: '低' };
export const TASK_CATEGORY: Record<TaskCategory, string> = { action: '亲自执行', follow_up: '跟进交付' };
export interface SourceDetail { source: Source; segments: Segment[] }
export interface MemoryDetail { memory: Memory; revisions: Revision[] }
export interface BackupInspection { formatVersion: number; createdAt: string; counts: Counts; compatible: boolean }
export interface ImportResult { jobId: string; duplicate: boolean; sourceId: string }
export interface FileInput { filename: string; contentBase64: string; password?: string }

export interface FeishuBinding { chatId: string; projectId: string; enabled: boolean }
export interface FeishuEditableSettings {
  appId: string; enabled: boolean; pollIntervalSeconds: number; replyPrefix: string; bindings: FeishuBinding[];
}
export interface FeishuMessage {
  id: string; messageId: string; chatId: string; projectId: string; question: string; answer: string | null;
  status: string; error: string | null; createdAt: string; updatedAt: string;
}
export interface FeishuStatus {
  settings: FeishuEditableSettings & { hasAppSecret: boolean; redirectUri: string };
  authorization: {
    status: 'disconnected' | 'authorizing' | 'connected' | 'expired';
    user: { openId: string; name: string } | null; authorizationUrl?: string | null;
    stage?: 'permissions' | 'account';
  };
  runtime: { polling: boolean; lastPollAt: string | null; lastError: string | null };
  recentMessages: FeishuMessage[];
}
export interface ProjectAnswer {
  answer: string; grounded: boolean; context: unknown;
  citations: Array<{ id?: string; kind?: 'source_passage'; memoryId?: string; revision?: number; sourceId?: string; segmentId?: string; locator?: string; content: string; sourceTitle: string; evidence: Evidence[] }>;
  queryTrace?: MemoryQueryTrace; qualityReview?: MemoryQualityReview;
  status?: AnswerStatus; claims?: AnswerClaim[]; unknowns?: string[];
}

export interface MemoryQueryTrace {
  modelCalls: number; maxModelCalls: number; inputChars: number; maxInputChars: number;
  maxOutputCharsPerCall: number; elapsedMs: number; timeoutSeconds: number;
  searchQueries?: string[]; supplementStatus?: string;
  retrievalMs?: number[]; reportedTokens?: number; usageComplete?: boolean;
  reportedTokenStopThreshold?: number; tokenBudgetMode?: string;
  stages?: Array<{ stage: string; elapsedMs: number; inputChars: number; errorCode?: string;
    usage: { inputTokens: number; outputTokens: number; totalTokens: number } | null }>;

  rounds?: Array<{ version: string; scanned: number; matched: number; returned: number; limited: boolean;
    catalogEntries: number; catalogLimited: boolean; ranking: Array<{ id: string; score: number }> }>;
}
export interface MemoryQualityReview {
  supported: boolean; unsupportedClaims?: string[]; reason?: string; version?: string;
  status?: 'unavailable'; errorCode?: string;
}

export const KIND_LABELS: Record<MemoryKind, string> = {
  fact: '项目事实', decision: '项目决策', requirement: '项目需求', risk: '项目风险',
};
