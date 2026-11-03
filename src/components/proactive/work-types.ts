export type AssistantWorkStatus = 'ready' | 'watching' | 'paused' | 'resolved' | 'cancelled';
export type AssistantWorkChoiceId = 'record_follow_up' | 'set_review' | 'adopt_date' | 'open_review' | 'dismiss';

export interface AssistantWorkChoice {
  id: AssistantWorkChoiceId;
  label: string;
  needsNote: boolean;
  needsReviewAt: boolean;
  needsDate: boolean;
}

export interface AssistantWork {
  id: string; projectId: string; projectName: string;
  kind: 'delay' | 'follow_up' | 'memory_conflict';
  targetId: string; title: string; status: AssistantWorkStatus; version: number;
  reason: string; summary: string;
  evidence: Array<{ kind: string; id: string; label: string; detail: string }>;
  choices: AssistantWorkChoice[];
  nextCheckAt: string | null; updatedAt: string; lastOutcome: string | null;
  reviewId?: string; sourceId?: string;
}

export interface AssistantWorkProposal extends AssistantWork {
  snapshot: Record<string, unknown>;
  stale?: boolean;
}

export interface AssistantWorkData {
  settings: { enabled: boolean; version: number };
  counts: Record<AssistantWorkStatus | 'total', number>;
  works: AssistantWork[];
  pendingEvents: number;
  truncated?: boolean;
  history: Array<{ id: string; workId: string; kind: string; note: string; createdAt: string }>;
}

export const WORK_STATUS: Record<AssistantWorkStatus, string> = {
  ready: '待你处理', watching: '等待复查', paused: '已暂停', resolved: '已收束', cancelled: '已忽略',
};
