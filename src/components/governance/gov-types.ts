import type { AppState, Evidence } from '../../types';

export type GovernanceKind = 'risk' | 'issue' | 'decision';
export type GovernanceStatus = 'open' | 'in_progress' | 'escalated' | 'closed';
export interface GovernanceLink { kind: 'task' | 'milestone' | 'memory'; id: string; version: number }
export interface GovernanceItem {
  id: string; projectId: string; kind: GovernanceKind; title: string; description: string;
  owner: string; severity: 'high' | 'medium' | 'low'; impact: string; responsePlan: string;
  dueDate: string | null; reviewDate: string | null; escalationTo: string; status: GovernanceStatus;
  decisionMaker: string; conclusion: string; resolution: string; closureReason: string;
  links: GovernanceLink[]; evidenceIds: string[]; version: number; workDate: string;
  createdAt: string; updatedAt: string; attention?: Array<{ kind: string; label: string }>;
}
export interface GovernanceRevision {
  id: string; itemId: string; projectId: string; version: number;
  eventType: 'created' | 'updated' | 'closed' | 'reopened' | 'progress';
  workDate: string; note: string; recordedAt: string; snapshot: GovernanceItem;
}
export interface GovernanceDetail { item: GovernanceItem; revisions: GovernanceRevision[]; evidence: Evidence[] }
export interface GovernanceDraft {
  memoryId: string; memoryRevision: number; projectId: string; kind: 'risk' | 'decision';
  title: string; description: string; evidenceIds: string[];
}
export interface GovernanceWorkspaceData {
  date: string; items: GovernanceItem[];
  counts: { open: number; inProgress: number; escalated: number; closed: number; attention: number };
  memoryDrafts: GovernanceDraft[];
  milestones: Array<{ id: string; projectId: string; title: string; version: number; status: string }>;
}
export interface GovernanceProps {
  state: AppState; projectId: string; date: string;
  focusId?: string;
  onChanged: () => Promise<unknown>; onTaskOpen: (taskId: string, projectId: string) => void;
  onEvidence?: (evidence: Evidence) => void; notify: (message: string, error?: boolean) => void;
}
export const GOV_KIND: Record<GovernanceKind, string> = { risk: '风险', issue: '问题', decision: '待决策' };
export const GOV_STATUS: Record<GovernanceStatus, string> = { open: '待处理', in_progress: '处理中', escalated: '已升级', closed: '已关闭' };
