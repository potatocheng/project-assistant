import test from 'node:test';
import assert from 'node:assert/strict';
import { pendingContent, projectHealth } from '../src/components/workspace-model.ts';

const emptyProject = () => ({ profile: { goal: '', targetDate: null, status: 'active' }, taskCounts: { total: 0, cancelled: 0 }, milestones: [], health: 'on_track' });
test('missing project evidence never reports a healthy delivery', () => {
  assert.equal(projectHealth(emptyProject()).state, 'unknown');
  assert.equal(projectHealth({ ...emptyProject(), profile: { ...emptyProject().profile, goal: '一期交付', targetDate: '2026-11-01' } }).state, 'unknown');
});
test('actual risk and terminal project states take precedence over incomplete evidence', () => {
  for (const state of ['blocked', 'at_risk', 'completed']) assert.equal(projectHealth({ ...emptyProject(), health: state }).state, state);
  assert.equal(projectHealth({ ...emptyProject(), profile: { ...emptyProject().profile, status: 'cancelled' }, health: 'blocked' }).label, '已取消');
});
test('a dated plan and confirmed work provide a basis without counting cancelled tasks', () => {
  const project = { ...emptyProject(), profile: { goal: '一期交付', targetDate: '2026-11-01', status: 'active' }, taskCounts: { total: 1, cancelled: 0 } };
  assert.equal(projectHealth(project).state, 'on_track');
  assert.equal(projectHealth({ ...project, taskCounts: { total: 1, cancelled: 1 } }).state, 'unknown');
  assert.equal(projectHealth({ ...project, taskCounts: { total: 0, cancelled: 0 }, milestones: [{ status: 'planned', baselineDate: '2026-11-01' }] }).state, 'on_track');
});
test('pending counts include every actionable category and respect project, source and archived scopes', () => {
  const candidate = (id, projectId, sourceId, status = 'pending') => ({ id, projectId, sourceId, status });
  const state = {
    projects: [{ id: 'a' }, { id: 'b' }], sources: [{ id: 'sa' }, { id: 'sb' }],
    taskProposals: [candidate('task-a', 'a', 'sa'), candidate('task-b', 'b', 'sb'), candidate('done', 'a', 'sa', 'confirmed')],
    proposals: [candidate('memory-a', 'a', 'sa'), candidate('archived-source', 'a', 'old'), candidate('archived-project', 'old', 'sa')],
    extractionDrafts: [candidate('draft-b', 'b', 'sb', 'needs_review'), candidate('reviewed', 'b', 'sb', 'reviewed')],
  };
  assert.equal(pendingContent(state).total, 4);
  assert.equal(pendingContent(state, 'a').total, 2);
  assert.equal(pendingContent(state, 'b', 'sb').total, 2);
  assert.equal(pendingContent(state, 'a', 'sb').total, 0);
  assert.deepEqual(pendingContent(state, 'b').tasks.map(item => item.id), ['task-b']);
});
