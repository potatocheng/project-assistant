import test from 'node:test';
import assert from 'node:assert/strict';
import { followUpNote, outcomeUpdate, BLOCKERS } from '../src/components/coach/coach-model.ts';

const task = { version: 7, status: 'blocked', progress: 40, dueDate: '2026-10-30', assignee: '小周' };
test('recording a promise never infers completion, ownership or a deadline change', () => {
  assert.equal(outcomeUpdate(task, 'note'), undefined);
  const note = followUpNote('note', ' 小周说周五给测试版本 ', '小周', '2026-10-30');
  assert.match(note, /实际交付待核实/);
  assert.match(note, /小周说周五给测试版本/);
  assert.equal(task.dueDate, '2026-10-30');
});
test('only explicit user outcomes request a version-checked state update', () => {
  assert.deepEqual(outcomeUpdate(task, 'done'), { baseVersion: 7, status: 'done' });
  assert.deepEqual(outcomeUpdate(task, 'progress'), { baseVersion: 7, status: 'in_progress' });
  assert.deepEqual(outcomeUpdate(task, 'blocked'), { baseVersion: 7, status: 'blocked' });
});
test('unknown blockers ask one concrete question; silence remains uncertain', () => {
  assert.equal(BLOCKERS.unknown.question, '现在等谁给出什么结果？');
  assert.match(BLOCKERS.reply.why, /原因还需要确认/);
});
