import test from 'node:test';
import assert from 'node:assert/strict';
import { collectAttention, collectTodayWork, directConnections, nextMilestone, projectOrder } from '../src/components/workbench-model.ts';

const date = '2026-10-28';
const task = (id, extra = {}) => ({ id, projectId: 'p', title: id, description: '', category: 'action', assignee: '负责人', priority: 'medium', status: 'todo', progress: 0, dueDate: date, plannedDate: null, version: 1, origin: 'manual', memoryId: null, memoryRevision: null, createdAt: date, updatedAt: date, ...extra });
const collect = (extra = {}) => collectAttention({ tasks: [], followUps: [], governance: [], changes: [], deliverables: [], date, projectId: '', ...extra });

test('today separates personal execution from follow-up work without guessing identity', () => {
  const result = collectTodayWork([task('mine'), task('follow', { category: 'follow_up' }), task('other-project', { projectId: 'q' })], date, 'p');
  assert.deepEqual(result.map(item => item.task.id), ['mine']);
});

test('today carries unfinished work and excludes future, unplanned, completed and cancelled tasks', () => {
  const result = collectTodayWork([
    task('carry', { dueDate: null, plannedDate: '2026-10-27' }), task('due'),
    task('future', { dueDate: '2026-10-30', plannedDate: '2026-10-29', priority: 'high' }),
    task('unplanned', { dueDate: null }), task('done', { status: 'done' }), task('cancelled', { status: 'cancelled' }),
    task('ongoing', { status: 'in_progress', dueDate: null }),
  ], date, '');
  assert.deepEqual(new Set(result.map(item => item.task.id)), new Set(['carry', 'due', 'ongoing']));
  assert.match(result.find(item => item.task.id === 'carry').reason, /之前安排未完成/);
});

test('today puts blockers and overdue items before ordinary work and explains the priority', () => {
  const result = collectTodayWork([task('ordinary'), task('overdue', { dueDate: '2026-10-26' }), task('blocker', { status: 'blocked' })], date, '');
  assert(result[0].urgent && result[1].urgent);
  assert.equal(result[2].task.id, 'ordinary');
  assert.match(result.find(item => item.task.id === 'overdue').reason, /已逾期/);
  assert.match(result.find(item => item.task.id === 'blocker').reason, /阻塞/);
});

test('next milestone uses the nearest current forecast and skips finished or cancelled milestones', () => {
  const milestone = (id, status, baselineDate, forecastDate = null) => ({ id, status, baselineDate, forecastDate });
  const values = [milestone('late', 'planned', '2026-10-20', '2026-11-02'), milestone('done', 'completed', '2026-10-21'), milestone('cancelled', 'cancelled', '2026-10-22'), milestone('next', 'in_progress', '2026-10-29'), milestone('unknown', 'planned', null)];
  assert.equal(nextMilestone(values).id, 'next');
  assert.equal(values[0].id, 'late', 'sorting must not mutate the API response');
  assert.equal(nextMilestone(values.filter(item => ['completed', 'cancelled'].includes(item.status))), undefined);
});

test('project attention ranks active delivery risks before healthy, held and completed projects', () => {
  const project = (status, health) => ({ profile: { status }, health });
  assert(projectOrder(project('active', 'blocked')) < projectOrder(project('active', 'on_track')));
  assert(projectOrder(project('active', 'at_risk')) < projectOrder(project('on_hold', 'blocked')));
  assert(projectOrder(project('active', 'on_track')) < projectOrder(project('completed', 'completed')));
});

test('completed, cancelled and explicitly snoozed tasks do not reappear as urgent work', () => {
  const tasks = [task('done', { status: 'done' }), task('cancelled', { status: 'cancelled' }), task('snoozed', { priority: 'high', status: 'blocked' }), task('today')];
  const result = collect({ tasks, followUps: [{ taskId: 'snoozed', snoozed: true }] });
  assert.deepEqual(result.map(item => item.id), ['today']);
});

test('project scope applies to tasks, governance and approvals', () => {
  const decision = id => ({ id, projectId: id, kind: 'decision', title: id, status: 'open', severity: 'medium', owner: '', dueDate: null, reviewDate: null });
  const result = collect({ projectId: 'p', tasks: [task('p-task'), task('foreign', { projectId: 'q' })], governance: [decision('p'), decision('q')], changes: [{ id: 'q-change', projectId: 'q', title: '', status: 'submitted' }] });
  assert.equal(result.length, 2);
  assert(result.every(item => item.projectId === 'p'));
});

test('a blocked task is shown once with its follow-up context ahead of ordinary planned work', () => {
  const blocked = task('blocked', { status: 'blocked', category: 'follow_up' });
  const result = collect({ tasks: [task('today'), blocked], followUps: [{ taskId: 'blocked', snoozed: false, reasons: [{ label: '约定跟进' }], nextFollowUpDate: date }] });
  assert.equal(result[0].id, 'blocked');
  assert.equal(result.filter(item => item.id === 'blocked').length, 1);
  assert.equal(result[0].followUp.taskId, 'blocked');
});

test('only pending approvals and reviews enter the decision list', () => {
  const record = (id, status) => ({ id, projectId: 'p', title: id, status });
  const result = collect({ changes: [record('draft', 'draft'), record('submitted', 'submitted'), record('approved', 'approved')], deliverables: [record('review', 'in_review'), record('accepted', 'accepted'), { ...record('changed-target', 'accepted'), needsReReview: true }] });
  assert.deepEqual(new Set(result.map(item => item.id)), new Set(['submitted', 'review', 'changed-target']));
});

test('dependency display preserves direction and parallel branches without inventing edges', () => {
  const tasks = [task('before'), task('focus'), task('after-a'), task('after-b'), task('foreign', { projectId: 'q' })];
  const edge = (id, taskId, targetId, extra = {}) => ({ id, taskId, targetId, kind: 'dependency', active: true, reason: '已确认依赖', ...extra });
  const result = directConnections(tasks[1], tasks, [edge('incoming', 'focus', 'before'), edge('a', 'after-a', 'focus'), edge('b', 'after-b', 'focus'), edge('cross-project', 'foreign', 'focus'), edge('inactive', 'before', 'focus', { active: false }), edge('blocker', 'focus', null, { kind: 'blocker' })]);
  assert.deepEqual(result.map(item => [item.id, item.role, item.task.id]), [['incoming', 'before', 'before'], ['a', 'after', 'after-a'], ['b', 'after', 'after-b']]);
});
