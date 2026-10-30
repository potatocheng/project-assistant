import test from 'node:test';
import assert from 'node:assert/strict';
import { appendOnlyMissingFinalBrace } from './amend-memory-reader-diagnostic-json.mjs';
const order = ['a', 'b', 'c', 'd', 'e', 'f'];
const original = JSON.stringify({ systems: Object.fromEntries(order.map((arm, i) => [`system${i + 1}`, { answerCorrect: i === 3 ? 'partial' : 'yes', reason: `${arm}: exact original reason` }])) });
test('one missing terminal delimiter is repaired without changing any verdict or reason', () => {
  const repaired = appendOnlyMissingFinalBrace(original.slice(0, -1), order, 'stop');
  assert.equal(repaired.amended, original);
  assert.equal(repaired.grades.d.answerCorrect, 'partial');
  assert.equal(repaired.grades.d.reason, 'd: exact original reason');
});
test('complete, truncated or internally malformed output cannot be amended', () => {
  assert.throws(() => appendOnlyMissingFinalBrace(original, order, 'stop'));
  assert.throws(() => appendOnlyMissingFinalBrace(original.slice(0, -1), order, 'length'));
  assert.throws(() => appendOnlyMissingFinalBrace(original.replace('"partial"', 'partial').slice(0, -1), order, 'stop'));
  assert.throws(() => appendOnlyMissingFinalBrace(original.slice(0, -2), order, 'stop'));
});
test('missing system grades or invalid labels are never invented', () => {
  const missing = JSON.parse(original); delete missing.systems.system6;
  assert.throws(() => appendOnlyMissingFinalBrace(JSON.stringify(missing).slice(0, -1), order, 'stop'));
  assert.throws(() => appendOnlyMissingFinalBrace(original.replace('"partial"', '"maybe"').slice(0, -1), order, 'stop'));
});
