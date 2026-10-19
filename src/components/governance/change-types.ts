import type { AppState, Evidence } from '../../types';

export interface ChangeProps { state: AppState; projectId: string; date: string; focusId?: string; onChanged: () => Promise<unknown>; onTaskOpen: (taskId: string, projectId: string) => void; onEvidence?: (evidence: Evidence) => void; notify: (message: string, error?: boolean) => void }
export interface ChangeLink { kind: 'task' | 'milestone' | 'memory'; id: string; version: number; snapshot?: { title?: string; content?: string; status?: string; version?: number } }
export interface Criterion { id?: string; title: string; status: 'pending' | 'pass' | 'fail'; evidence: string; note: string }
export interface ChangeHistory { id: string; version: number; date: string; actor: string; note: string; snapshot: Record<string, unknown> }
export interface ChangeRecord {
  id: string; projectId: string; title: string; status: string; version: number; workDate: string; updatedAt: string;
  before?: string; after?: string; reason?: string; requester?: string; decisionOwner?: string; scopeImpact?: string; scheduleImpact?: string; effortImpact?: string;
  approval?: { actor: string; date: string; note: string; result: string }; implementation?: { actor: string; date: string; note: string };
  owner?: string; target?: ChangeLink; criteria?: Criterion[]; review?: { reviewer: string; date: string; note: string; remediation: string; result: string };
  links: ChangeLink[]; evidence: Evidence[]; history: ChangeHistory[]; needsReReview?: boolean; targetCurrent?: { title: string; status: string; version: number };
}
export interface ChangeData { changes: ChangeRecord[]; deliverables: ChangeRecord[]; milestones: Array<{ id: string; projectId: string; title: string; status: string; version: number }> }
export const CHANGE_STATUS: Record<string, string> = { draft: '草案', submitted: '待审批', approved: '已批准 · 待实施', rejected: '已拒绝', implemented: '已实施', cancelled: '已取消', in_review: '待验收', accepted: '验收通过' };
