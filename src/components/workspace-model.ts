import type { AppState } from '../types';
import type { ProjectDelivery } from './delivery/types';

/** A candidate is counted once, even when it also has a memory-quality review. */
export function pendingContent(state: Pick<AppState, 'projects' | 'sources' | 'taskProposals' | 'proposals' | 'extractionDrafts'>, projectId = '', sourceId = '') {
  const projects = new Set(state.projects.map(project => project.id));
  const sources = new Set(state.sources.map(source => source.id));
  const inScope = (item: { projectId: string; sourceId: string }) => projects.has(item.projectId)
    && sources.has(item.sourceId) && (!projectId || item.projectId === projectId) && (!sourceId || item.sourceId === sourceId);
  const tasks = state.taskProposals.filter(item => item.status === 'pending' && inScope(item));
  const memories = state.proposals.filter(item => item.status === 'pending' && inScope(item));
  const drafts = (state.extractionDrafts ?? []).filter(item => item.status === 'needs_review' && inScope(item));
  return { tasks, memories, drafts, total: tasks.length + memories.length + drafts.length };
}

export function projectHealth(project: ProjectDelivery) {
  if (project.profile.status === 'cancelled') return { state: 'inactive', label: '已取消' };
  if (project.profile.status === 'on_hold') return { state: 'inactive', label: '已暂停' };
  if (project.profile.status === 'completed' || project.health === 'completed') return { state: 'completed', label: '项目已完成' };
  if (project.health === 'blocked') return { state: 'blocked', label: '存在阻塞' };
  if (project.health === 'at_risk') return { state: 'at_risk', label: '交付有风险' };
  const hasSchedule = project.milestones.some(item => item.status !== 'cancelled' && !!(item.baselineDate || item.forecastDate));
  if (!project.profile.goal.trim() || !(project.profile.targetDate || hasSchedule)
    || !(project.taskCounts.total - project.taskCounts.cancelled > 0 || hasSchedule)) {
    return { state: 'unknown', label: '资料不足，暂无法判断' };
  }
  return { state: 'on_track', label: '当前记录未见交付偏差' };
}
