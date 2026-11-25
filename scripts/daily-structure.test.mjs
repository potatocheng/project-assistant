import test from 'node:test';
import assert from 'node:assert/strict';
import { GROUP_LABELS, structureDailyTasks, unlockedBy } from '../src/components/work/daily-structure.ts';

const date = '2026-11-25';
const task = (id, extra = {}) => ({
  id,
  projectId: 'p',
  title: id,
  description: '',
  category: 'action',
  assignee: '负责人',
  priority: 'medium',
  status: 'todo',
  progress: 0,
  dueDate: date,
  plannedDate: date,
  version: 1,
  origin: 'manual',
  memoryId: null,
  memoryRevision: null,
  createdAt: date,
  updatedAt: date,
  ...extra,
});

const dep = (id, taskId, targetId, extra = {}) => ({
  id,
  kind: 'dependency',
  taskId,
  targetId,
  active: true,
  reason: '前置条件',
  ...extra,
});

const blocker = (id, taskId, reason, extra = {}) => ({
  id,
  kind: 'blocker',
  taskId,
  targetId: null,
  active: true,
  reason,
  ...extra,
});

test('action prerequisite in today puts dependent in waitingToday and prerequisite in ready with unlock note', () => {
  const a = task('A', { title: '写接口文档' });
  const b = task('B', { title: '联调接口' });
  const result = structureDailyTasks([b, a], [a, b], [dep('r1', 'B', 'A')], new Set(['A', 'B']));
  assert.deepEqual(result.map((r) => [r.task.id, r.group]), [['A', 'ready'], ['B', 'waitingToday']]);
  assert.equal(result[0].tone, 'unlock');
  assert.equal(result[0].note, '完成后可解锁：联调接口');
  assert.equal(result[1].tone, 'pending');
  assert.equal(result[1].note, '完成「写接口文档」后可开始');
});

test('prerequisite marked done in allTasks makes dependent ready even if row snapshot is stale', () => {
  const staleA = task('A', { title: '前置', status: 'in_progress' });
  const latestA = task('A', { title: '前置', status: 'done' });
  const b = task('B', { title: '后续' });
  const result = structureDailyTasks([staleA, b], [latestA, b], [dep('r1', 'B', 'A')], new Set(['A', 'B']));
  assert.deepEqual(result.map((r) => [r.task.id, r.group]), [['B', 'ready'], ['A', 'closed']]);
  assert.equal(result[0].note, null);
  assert.equal(result[1].note, null);
});

test('follow_up prerequisite puts dependent in waiting with follow-up note', () => {
  const f = task('F', { title: '跟进小王', category: 'follow_up' });
  const b = task('B', { title: '集成测试' });
  const result = structureDailyTasks([f, b], [f, b], [dep('r1', 'B', 'F')], new Set(['F', 'B']));
  assert.equal(result.find((r) => r.task.id === 'B').group, 'waiting');
  assert.equal(result.find((r) => r.task.id === 'B').note, '等待「跟进小王」交付（跟进不代表已交付）');
});

test('prerequisite not in todayIds puts dependent in waiting', () => {
  const a = task('A', { title: '明天才做', plannedDate: '2026-11-26' });
  const b = task('B', { title: '今天任务' });
  const result = structureDailyTasks([b], [a, b], [dep('r1', 'B', 'A')], new Set(['B']));
  assert.equal(result[0].group, 'waiting');
  assert.equal(result[0].note, '等待「明天才做」（未安排在今天）');
});

test('cancelled prerequisite puts dependent in waiting with cancel note', () => {
  const a = task('A', { title: '旧方案', status: 'cancelled' });
  const b = task('B', { title: '后续' });
  const result = structureDailyTasks([b], [a, b], [dep('r1', 'B', 'A')], new Set(['A', 'B']));
  assert.equal(result[0].group, 'waiting');
  assert.equal(result[0].note, '前置「旧方案」已取消，请解除此依赖');
});

test('blocker relation and blocked status put task in waiting', () => {
  const b1 = task('B1', { title: '发布', status: 'blocked' });
  const b2 = task('B2', { title: '压测', status: 'blocked' });
  const b3 = task('B3', { title: '上线', status: 'todo' });
  const result = structureDailyTasks(
    [b1, b2, b3],
    [b1, b2, b3],
    [blocker('blk1', 'B1', '等李四审批'), blocker('blk2', 'B3', '环境未就绪')],
    new Set(['B1', 'B2', 'B3']),
  );
  assert.deepEqual(result.map((r) => [r.task.id, r.group, r.tone, r.note]), [
    ['B1', 'waiting', 'waiting', '阻塞：等李四审批'],
    ['B2', 'waiting', 'waiting', '任务标记为阻塞，需先解除'],
    ['B3', 'waiting', 'waiting', '阻塞：环境未就绪'],
  ]);
});

test('inactive and merge relations are ignored', () => {
  const a = task('A');
  const b = task('B');
  const result = structureDailyTasks(
    [a, b],
    [a, b],
    [
      dep('inactive', 'B', 'A', { active: false }),
      { id: 'm1', kind: 'merge', taskId: 'B', targetId: 'A', active: true, reason: '重复' },
      blocker('blk-off', 'A', '已解除', { active: false }),
    ],
    new Set(['A', 'B']),
  );
  assert.deepEqual(result.map((r) => [r.task.id, r.group, r.note]), [
    ['A', 'ready', null],
    ['B', 'ready', null],
  ]);
});

test('done and cancelled rows go to closed', () => {
  const d = task('D', { status: 'done' });
  const c = task('C', { status: 'cancelled' });
  const result = structureDailyTasks([d, c], [d, c], [], new Set(['D', 'C']));
  assert.deepEqual(result.map((r) => [r.task.id, r.group, r.note]), [
    ['D', 'closed', null],
    ['C', 'closed', null],
  ]);
});

test('group order is ready -> waitingToday -> waiting -> closed and preserves input order within groups', () => {
  const closed = task('closed', { status: 'done' });
  const wait = task('wait', { status: 'blocked' });
  const pre = task('pre');
  const after = task('after');
  const ready1 = task('ready1');
  const ready2 = task('ready2');
  const result = structureDailyTasks(
    [closed, wait, after, ready1, pre, ready2],
    [closed, wait, after, ready1, pre, ready2],
    [dep('r1', 'after', 'pre')],
    new Set(['closed', 'wait', 'after', 'ready1', 'pre', 'ready2']),
  );
  assert.deepEqual(
    result.map((r) => r.task.id),
    ['ready1', 'pre', 'ready2', 'after', 'wait', 'closed'],
  );
  assert.ok(GROUP_LABELS.ready.label);
});

test('unlockedBy returns tasks only when all prerequisites are satisfied and excludes blocked tasks or blockers', () => {
  const p1 = task('P1', { status: 'todo' });
  const p2Done = task('P2', { status: 'done' });
  const p3Open = task('P3', { status: 'in_progress' });
  const readyOnP1 = task('U1');
  const multiUnmet = task('U2');
  const blockedStatus = task('U3', { status: 'blocked' });
  const hasBlocker = task('U4', { status: 'todo' });
  const notCandidate = task('U5');

  const all = [p1, p2Done, p3Open, readyOnP1, multiUnmet, blockedStatus, hasBlocker, notCandidate];
  const rels = [
    dep('d1', 'U1', 'P1'),
    dep('d2', 'U1', 'P2'),
    dep('d3', 'U2', 'P1'),
    dep('d4', 'U2', 'P3'),
    dep('d5', 'U3', 'P1'),
    dep('d6', 'U4', 'P1'),
    dep('d7', 'U5', 'P1'),
    blocker('b1', 'U4', '还缺权限'),
  ];
  const unlocked = unlockedBy('P1', all, rels, new Set(['U1', 'U2', 'U3', 'U4']));
  assert.deepEqual(unlocked.map((t) => t.id), ['U1']);
});
