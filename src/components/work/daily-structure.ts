import type { Task } from '../../types';

export type Relation = {
  id: string;
  kind: string;
  taskId: string;
  targetId: string | null;
  active: boolean;
  reason: string;
};

export type DailyGroup = 'ready' | 'waitingToday' | 'waiting' | 'closed';

export interface StructuredRow {
  task: Task;
  group: DailyGroup;
  note: string | null;
  tone: 'unlock' | 'pending' | 'waiting' | null;
}

export const GROUP_LABELS: Record<DailyGroup, { label: string; hint: string }> = {
  ready: { label: '现在可做', hint: '前置条件已具备' },
  waitingToday: { label: '完成前置后可做', hint: '前置任务也在今天的清单里' },
  waiting: { label: '等待中', hint: '等他人交付、存在阻塞，或前置未安排在今天' },
  closed: { label: '已完成 / 已取消', hint: '' },
};

const ACTIVE_STATUSES = new Set(['todo', 'in_progress', 'blocked']);
const GROUP_ORDER: DailyGroup[] = ['ready', 'waitingToday', 'waiting', 'closed'];

function formatQuotedNames(names: string[]): string {
  const head = names.slice(0, 2).map((name) => `「${name}」`).join('、');
  return names.length > 2 ? `${head} 等 ${names.length} 项` : head;
}

function formatPlainNames(names: string[]): string {
  const head = names.slice(0, 2).join('、');
  return names.length > 2 ? `${head} 等 ${names.length} 项` : head;
}

export function structureDailyTasks(
  rows: Task[],
  allTasks: Task[],
  relations: Relation[],
  todayIds: Set<string>,
): StructuredRow[] {
  const byId = new Map<string, Task>();
  for (const row of rows) byId.set(row.id, row);
  for (const task of allTasks) byId.set(task.id, task);

  const activeDeps = relations.filter((r) => r.active && r.kind === 'dependency');
  const activeBlockers = relations.filter((r) => r.active && r.kind === 'blocker');

  const depsByTask = new Map<string, Relation[]>();
  const dependentsByTarget = new Map<string, Task[]>();
  for (const rel of activeDeps) {
    const list = depsByTask.get(rel.taskId) ?? [];
    list.push(rel);
    depsByTask.set(rel.taskId, list);

    if (rel.targetId) {
      const dependent = byId.get(rel.taskId);
      if (dependent && ACTIVE_STATUSES.has(dependent.status)) {
        const depList = dependentsByTarget.get(rel.targetId) ?? [];
        if (!depList.some((item) => item.id === dependent.id)) {
          depList.push(dependent);
          dependentsByTarget.set(rel.targetId, depList);
        }
      }
    }
  }

  const blockersByTask = new Map<string, string[]>();
  for (const rel of activeBlockers) {
    const list = blockersByTask.get(rel.taskId) ?? [];
    list.push(rel.reason);
    blockersByTask.set(rel.taskId, list);
  }

  const buckets: Record<DailyGroup, StructuredRow[]> = {
    ready: [],
    waitingToday: [],
    waiting: [],
    closed: [],
  };

  for (const row of rows) {
    const latest = byId.get(row.id) ?? row;
    if (latest.status === 'done' || latest.status === 'cancelled') {
      buckets.closed.push({ task: row, group: 'closed', note: null, tone: null });
      continue;
    }

    const blockerReasons = blockersByTask.get(row.id) ?? [];
    const deps = depsByTask.get(row.id) ?? [];
    const unmet = deps
      .map((rel) => ({
        rel,
        target: rel.targetId ? byId.get(rel.targetId) : undefined,
      }))
      .filter(({ target }) => !target || target.status !== 'done')
      .map(({ target }) => ({
        target,
        title: target?.title ?? '前置任务',
      }));

    if (latest.status === 'blocked') {
      const note = blockerReasons.length > 0
        ? `阻塞：${blockerReasons[0]}`
        : '任务标记为阻塞，需先解除';
      buckets.waiting.push({ task: row, group: 'waiting', note, tone: 'waiting' });
      continue;
    }

    if (blockerReasons.length > 0) {
      const note = blockerReasons.length > 1
        ? `阻塞：${blockerReasons[0]} 等 ${blockerReasons.length} 项`
        : `阻塞：${blockerReasons[0]}`;
      buckets.waiting.push({ task: row, group: 'waiting', note, tone: 'waiting' });
      continue;
    }

    const cancelled = unmet.filter(({ target }) => target?.status === 'cancelled');
    if (cancelled.length > 0) {
      const note = `前置${formatQuotedNames(cancelled.map((item) => item.title))}已取消，请解除此依赖`;
      buckets.waiting.push({ task: row, group: 'waiting', note, tone: 'waiting' });
      continue;
    }

    const followUps = unmet.filter(({ target }) => target?.category === 'follow_up');
    const offToday = unmet.filter(({ target }) => !target || !todayIds.has(target.id));
    if (followUps.length > 0 || offToday.length > 0) {
      const note = followUps.length > 0
        ? `等待${formatQuotedNames(followUps.map((item) => item.title))}交付（跟进不代表已交付）`
        : `等待${formatQuotedNames(offToday.map((item) => item.title))}（未安排在今天）`;
      buckets.waiting.push({ task: row, group: 'waiting', note, tone: 'waiting' });
      continue;
    }

    if (unmet.length > 0) {
      const note = `完成${formatQuotedNames(unmet.map((item) => item.title))}后可开始`;
      buckets.waitingToday.push({ task: row, group: 'waitingToday', note, tone: 'pending' });
      continue;
    }

    const dependents = dependentsByTarget.get(row.id) ?? [];
    if (dependents.length > 0) {
      const note = `完成后可解锁：${formatPlainNames(dependents.map((item) => item.title))}`;
      buckets.ready.push({ task: row, group: 'ready', note, tone: 'unlock' });
    } else {
      buckets.ready.push({ task: row, group: 'ready', note: null, tone: null });
    }
  }

  return GROUP_ORDER.flatMap((group) => buckets[group]);
}

export function unlockedBy(
  doneTaskId: string,
  allTasks: Task[],
  relations: Relation[],
  candidateIds: Set<string>,
): Task[] {
  const byId = new Map(allTasks.map((task) => [task.id, task]));
  const activeDeps = relations.filter((r) => r.active && r.kind === 'dependency');
  const blockedIds = new Set(
    relations.filter((r) => r.active && r.kind === 'blocker').map((r) => r.taskId),
  );

  const depsByTask = new Map<string, Relation[]>();
  for (const rel of activeDeps) {
    const list = depsByTask.get(rel.taskId) ?? [];
    list.push(rel);
    depsByTask.set(rel.taskId, list);
  }

  return allTasks.filter((task) => {
    if (!candidateIds.has(task.id)) return false;
    if (task.status !== 'todo' && task.status !== 'in_progress') return false;
    if (blockedIds.has(task.id)) return false;
    const deps = depsByTask.get(task.id) ?? [];
    if (!deps.some((rel) => rel.targetId === doneTaskId)) return false;
    return deps.every((rel) => {
      if (rel.targetId === doneTaskId) return true;
      if (!rel.targetId) return false;
      return byId.get(rel.targetId)?.status === 'done';
    });
  });
}
