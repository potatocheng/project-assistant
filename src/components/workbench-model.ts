import type { Task } from '../types';
import type { FollowUpItem } from './delivery/types';
import type { GovernanceItem } from './governance/gov-types';
import type { ChangeRecord } from './governance/change-types';
import type { Milestone, ProjectDelivery } from './delivery/types';

export interface TodayWork { task: Task; reason: string; urgent: boolean }

/** Personal execution is an explicit task category, never inferred from a person's name. */
export function collectTodayWork(tasks: Task[], date: string, projectId: string): TodayWork[] {
  return tasks.filter(task => (!projectId || task.projectId === projectId)
    && task.category === 'action' && task.status !== 'done' && task.status !== 'cancelled'
    && ((task.plannedDate && task.plannedDate <= date) || (task.dueDate && task.dueDate <= date)
      || (task.status === 'in_progress' && !task.plannedDate)))
    .map(task => ({ task, urgent: task.status === 'blocked' || !!task.dueDate && task.dueDate < date,
      reason: task.status === 'blocked' ? '遇到阻塞，需要先解决前置条件'
        : task.dueDate && task.dueDate < date ? `已逾期 · 原定 ${task.dueDate}`
        : task.dueDate === date ? '今天截止'
        : task.plannedDate === date ? '已安排在今天'
        : task.plannedDate && task.plannedDate < date ? `之前安排未完成 · ${task.plannedDate}`
        : '正在进行，尚未安排日期',
    })).sort((a, b) => Number(b.urgent) - Number(a.urgent)
      || Number(b.task.dueDate === date) - Number(a.task.dueDate === date)
      || ({ high: 0, medium: 1, low: 2 }[a.task.priority] - { high: 0, medium: 1, low: 2 }[b.task.priority])
      || (a.task.dueDate || '9999').localeCompare(b.task.dueDate || '9999')
      || a.task.id.localeCompare(b.task.id));
}

export function nextMilestone(milestones: Milestone[]): Milestone | undefined {
  return milestones.filter(item => item.status !== 'completed' && item.status !== 'cancelled')
    .sort((a, b) => (a.forecastDate || a.baselineDate || '9999').localeCompare(b.forecastDate || b.baselineDate || '9999') || a.id.localeCompare(b.id))[0];
}

export function projectOrder(project: ProjectDelivery): number {
  if (project.profile.status === 'completed' || project.profile.status === 'cancelled') return 5;
  if (project.profile.status === 'on_hold') return 4;
  return { blocked: 0, at_risk: 1, on_track: 2, completed: 3 }[project.health];
}

export interface AttentionItem {
  key: string;
  kind: 'task' | 'governance' | 'change' | 'deliverable';
  intent: 'action' | 'followup' | 'decision' | 'risk';
  id: string; projectId: string; title: string; owner: string; date: string | null;
  note: string; rank: number;
  task?: Task; followUp?: FollowUpItem; governance?: GovernanceItem; record?: ChangeRecord;
}

export function collectAttention({ tasks, followUps, governance, changes, deliverables, date, projectId }: {
  tasks: Task[]; followUps: FollowUpItem[]; governance: GovernanceItem[];
  changes: ChangeRecord[]; deliverables: ChangeRecord[]; date: string; projectId: string;
}): AttentionItem[] {
  const items = new Map<string, AttentionItem>();
  const inScope = (id: string) => !projectId || id === projectId;
  const snoozed = new Set(followUps.filter(item => item.snoozed).map(item => item.taskId));
  const actionable = new Map(followUps.filter(item => !item.snoozed).map(item => [item.taskId, item]));
  for (const task of tasks) {
    if (!inScope(task.projectId) || task.status === 'done' || task.status === 'cancelled' || snoozed.has(task.id)) continue;
    const followUp = actionable.get(task.id);
    const overdue = !!task.dueDate && task.dueDate < date;
    const blocked = task.status === 'blocked';
    if (!followUp && !blocked && !overdue && task.dueDate !== date && task.plannedDate !== date && task.priority !== 'high') continue;
    const rank = (blocked ? 110 : overdue ? 100 : followUp ? 80 : task.dueDate === date ? 75 : 50) + (task.priority === 'high' ? 5 : 0);
    items.set(`task:${task.id}`, {
      key: `task:${task.id}`, kind: 'task', intent: blocked ? 'risk' : task.category === 'follow_up' || followUp ? 'followup' : 'action',
      id: task.id, projectId: task.projectId, title: task.title, owner: task.assignee || '负责人待定',
      date: task.dueDate || followUp?.nextFollowUpDate || task.plannedDate,
      note: blocked ? task.description || '当前记录为阻塞，请核对前置条件。' : followUp?.reasons.map(reason => reason.label).join(' · ') || (overdue ? `已超过截止日期 ${task.dueDate}` : task.description),
      rank, task, followUp,
    });
  }
  for (const item of governance) {
    if (!inScope(item.projectId) || item.status === 'closed') continue;
    items.set(`governance:${item.id}`, {
      key: `governance:${item.id}`, kind: 'governance', intent: item.kind === 'decision' ? 'decision' : 'risk',
      id: item.id, projectId: item.projectId, title: item.title, owner: item.kind === 'decision' ? item.decisionMaker || item.owner : item.owner,
      date: item.dueDate || item.reviewDate, note: item.impact || item.description,
      rank: item.status === 'escalated' ? 120 : item.severity === 'high' ? 105 : item.kind === 'decision' ? 85 : 65, governance: item,
    });
  }
  for (const [kind, records] of [['change', changes], ['deliverable', deliverables]] as const) {
    for (const record of records) {
      const pending = kind === 'change' ? record.status === 'submitted' : record.status === 'in_review' || record.needsReReview === true;
      if (!inScope(record.projectId) || !pending) continue;
      items.set(`${kind}:${record.id}`, {
        key: `${kind}:${record.id}`, kind, intent: 'decision', id: record.id, projectId: record.projectId, title: record.title,
        owner: record.decisionOwner || record.owner || '负责人待定', date: null,
        note: kind === 'change' ? record.scheduleImpact || record.scopeImpact || '需求变更等待审批。' : record.needsReReview ? '关联目标已变化，需要重新复核。' : '交付物等待验收。',
        rank: record.needsReReview ? 95 : 85, record,
      });
    }
  }
  return [...items.values()].sort((a, b) => b.rank - a.rank || (a.date || '9999').localeCompare(b.date || '9999') || a.title.localeCompare(b.title, 'zh-CN'));
}

export interface TaskConnection { id: string; role: 'before' | 'after'; task: Task; reason: string }

/** Only confirmed direct dependencies form edges. Siblings never become a chain. */
export function directConnections(task: Task, tasks: Task[], relations: Array<{ id: string; kind: string; taskId: string; targetId: string | null; active: boolean; reason: string }>): TaskConnection[] {
  const byId = new Map(tasks.filter(item => item.projectId === task.projectId).map(item => [item.id, item]));
  return relations.flatMap(relation => {
    if (!relation.active || relation.kind !== 'dependency') return [];
    const role = relation.taskId === task.id ? 'before' : relation.targetId === task.id ? 'after' : null;
    const target = role === 'before' ? byId.get(relation.targetId || '') : role === 'after' ? byId.get(relation.taskId) : undefined;
    return role && target ? [{ id: relation.id, role, task: target, reason: relation.reason }] : [];
  });
}
