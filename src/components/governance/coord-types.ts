import type { AppState, Evidence, Task, TaskEvent } from '../../types';

export interface CoordinationProps {
  focusId?: string;
  state: AppState; projectId: string; date: string; onChanged: () => Promise<unknown>;
  onTaskOpen: (taskId: string, projectId: string) => void;
  onEvidence?: (evidence: Evidence) => void; notify: (message: string, error?: boolean) => void;
}
export interface ReportBasis {
  generatedAt: string; startDate: string; endDate: string; projectId: string | null;
  taskEvents: TaskEvent[]; taskStates: TaskEvent[]; completed: TaskEvent[];
  governance: HistoryBasis[]; changes: HistoryBasis[]; deliverables: HistoryBasis[];
  currentMilestones: Array<{ id: string; projectId: string; title: string; version: number; updatedAt: string; status: string; baselineDate: string | null; forecastDate: string | null }>;
  currentRelations: Array<{ id: string; projectId: string; taskId: string; reason: string; createdAt: string }>;
  currentSnapshotNotice: string;
}
export interface HistoryBasis {
  acceptanceCheck?: { needsReReview: boolean | null; message: string };
  recordId: string; version: number; workDate: string; recordedAt: string;
  snapshot: { id: string; projectId: string; title: string; status: string; kind?: string; owner?: string; decisionOwner?: string; dueDate?: string };
}
export interface WeeklyReportSummary { id: string; projectId: string | null; startDate: string; endDate: string; title: string; version: number; createdAt: string; updatedAt: string }
export interface WeeklyReport extends WeeklyReportSummary {
  latestVersion: number; versionId: string; content: string; basis: ReportBasis; edited: boolean; savedAt: string;
  history: Array<{ versionId: string; version: number; edited: boolean; createdAt: string }>;
}
export interface MeetingSummary { id: string; projectId: string; date: string; title: string; version: number; updatedAt: string }
export interface Meeting extends MeetingSummary {
  attendees: string; objective: string; agenda: string; briefing: string; minutes: string; decisions: string;
  createdAt: string; latestVersion: number; actions: MeetingAction[];
  history: Array<{ version: number; createdAt: string }>;
  preparationBasis: { generatedAt: string; previousActions: Array<MeetingAction & { sourceMeetingTitle: string; sourceMeetingDate: string; sourceMeetingVersion: number }>; projectSnapshot: ReportBasis } | null;
}
export interface MeetingAction {
  id: string; meetingId: string; projectId: string; title: string; owner: string; dueDate: string;
  status: 'open' | 'dismissed' | 'confirmed'; taskId: string | null; version: number;
  createdAt: string; updatedAt: string; task: Task | null;
  completionState: string;
}
export interface CoordinationList { reports: WeeklyReportSummary[]; meetings: MeetingSummary[]; actions: MeetingAction[] }
