import type { AppState, Evidence, ManagementKind, Task, MemoryQueryTrace, MemoryQualityReview } from '../../types';

export interface DeliveryProps {
  state: AppState;
  projectId: string;
  date: string;
  onChanged: () => Promise<unknown>;
  onTaskOpen: (taskId: string, projectId: string) => void;
  notify: (message: string, error?: boolean) => void;
  onManagementOpen?: (kind: ManagementKind, id: string, projectId: string) => void;
  onMemoryOpen?: (memoryId: string, projectId: string) => void;
  onEvidence?: (evidence: Evidence) => void;
}
export type ProjectStatus = 'active' | 'on_hold' | 'completed' | 'cancelled';
export type MilestoneStatus = 'planned' | 'in_progress' | 'completed' | 'cancelled';
export interface ProjectProfile {
  projectId: string; goal: string; status: ProjectStatus; targetDate: string | null; version: number; updatedAt: string | null;
}
export interface DeliveryTaskCounts {
  total: number; todo: number; inProgress: number; blocked: number; done: number; cancelled: number; active: number; overdue: number;
}
export interface Milestone {
  id: string; projectId: string; title: string; description: string; status: MilestoneStatus;
  baselineDate: string | null; forecastDate: string | null; taskIds: string[]; version: number;
  createdAt: string; updatedAt: string; taskCounts: DeliveryTaskCounts; slipDays: number | null;
  isOverdue: boolean; completionBlocked: boolean;
}
export interface ProjectDelivery {
  projectId: string; name: string; description: string; profile: ProjectProfile;
  taskCounts: DeliveryTaskCounts; milestones: Milestone[];
  blockers: Array<{ task: Task; relations: unknown[] }>; overdueTasks: Task[];
  health: 'on_track' | 'at_risk' | 'blocked' | 'completed'; basis: DeliveryBasis[];
}
export interface DeliveryBasis {
  kind: 'task' | 'milestone' | 'project' | 'management'; label: string; taskId?: string; milestoneId?: string;
  managementKind?: ManagementKind; managementId?: string;
  targetDate?: string; baselineDate?: string | null; forecastDate?: string | null; slipDays?: number;
}
export interface DeliveryOverviewData {
  date: string; projectId: string | null; projects: ProjectDelivery[];
  counts: { projects: number; activeTasks: number; blockedTasks: number; overdueTasks: number; atRiskMilestones: number };
}
export interface FollowUpRecord {
  id: string; taskId: string; projectId: string; workDate: string; note: string; nextFollowUpDate: string | null; recordedAt: string;
}
export type FollowUpReasonKind = 'overdue' | 'due_soon' | 'stale' | 'follow_up';
export interface FollowUpItem {
  task: Task; projectName: string; taskId: string; projectId: string;
  reasons: Array<{ kind: FollowUpReasonKind; label: string; referenceDate: string; days: number }>;
  lastProgressDate: string; lastFollowUp: FollowUpRecord | null; nextFollowUpDate: string | null;
  snoozedUntil: string | null; snoozed: boolean; followUpVersion: number; draft: string;
}
export interface FollowUpCenterData {
  date: string; projectId: string | null; items: FollowUpItem[]; history: FollowUpRecord[];
  taskStates: FollowUpTaskState[];
  counts: { total: number; actionable: number; snoozed: number; overdue: number; dueSoon: number; stale: number; followUp: number };
}
export interface FollowUpTaskState {
  taskId: string; projectId: string; followUpVersion: number; nextFollowUpDate: string | null; snoozedUntil: string | null; updatedAt: string | null;
}
export interface AssistantCitation {
  id: string; kind: ManagementKind | 'task' | 'memory' | 'source_passage' | 'milestone' | 'project' | 'report' | 'relation' | 'plan' | 'follow_up';
  projectId: string; title: string; updatedAt: string; content: string;
  taskId?: string; memoryId?: string; milestoneId?: string; reportId?: string; sourceId?: string;
  evidence?: Evidence[];
  managementId?: string;
}
export interface AssistantAnswer {
  answer: string; grounded: boolean; mode: 'local' | 'model'; citations: AssistantCitation[];
  updatedAt: string; dataUpdatedAt?: string | null; limitations: string[]; context: unknown;
  status?: import('../../types').AnswerStatus; claims?: import('../../types').AnswerClaim[]; unknowns?: string[];
  queryMode?: 'structured_field' | 'follow_up_priority' | 'pending_decisions' | 'delivery_risk_signals'; queryTrace?: MemoryQueryTrace; qualityReview?: MemoryQualityReview;
}
