export type ProactiveStatus = 'ready' | 'watching' | 'snoozed' | 'resolved' | 'dismissed';
export type ProactiveTargetKind = 'task' | 'governance' | 'change' | 'deliverable' | 'milestone' | 'project';
export type ProactiveOperation = 'watch' | 'snooze' | 'dismiss' | 'reopen';

export interface ProactiveSettings { enabled: boolean; reviewMinutes: number; revision: string }
export interface ProactiveEvidence {
  label: string; detail: string; targetKind: ProactiveTargetKind; targetId: string;
}
export interface ProactiveAction {
  id: string; projectId: string; projectName: string; targetKind: ProactiveTargetKind; targetId: string;
  title: string; status: ProactiveStatus; priority: number; reason: string; suggestedAction: string;
  draft: string; evidence: ProactiveEvidence[]; version: number; createdAt: string; updatedAt: string;
  lastCheckedAt: string | null; nextCheckAt: string | null; reviewCount: number; unchangedChecks: number;
  outcome: string | null;
}
export interface ProactiveHistory {
  id: string; actionId: string; kind: string; note: string; createdAt: string;
}
export interface ProactiveCenterData {
  settings: ProactiveSettings; lastRunAt: string | null; lastError: string | null;
  counts: Record<ProactiveStatus | 'total', number>; actions: ProactiveAction[]; history: ProactiveHistory[];
}

export const PROACTIVE_STATUS: Record<ProactiveStatus, string> = {
  ready: '现在处理', watching: '待复查', snoozed: '已暂缓', resolved: '已收束', dismissed: '已忽略',
};
