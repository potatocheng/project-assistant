import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDevelopment } from './check-memory-public-development.mjs';
function fixture() {
  const questions = Array.from({ length: 20 }, (_, i) => ({ id: `q${i}`, answerable: i !== 19,
    entries: { desktop: { result: {} }, connector: { result: {} } } }));
  return { complete: true, documents: Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, split: 'development',
    extraction: { job: { status: 'succeeded' } }, memories: [{ id: `m${i}` }], questions: questions.filter((_, j) => j % 6 === i) })),
    judgments: questions.map((q, i) => ({ id: q.id, memorySufficiency: i < 15 ? 'partial' : 'no',
      entries: { desktop: { answerCorrect: i < 5 || i === 19 ? 'yes' : 'no' }, connector: { answerCorrect: i < 5 || i === 19 ? 'yes' : 'no' } } })) };
}
const integrity = { results: [{ file: 'test', passed: true }] };
const regression = { passed: true, commands: [{ command: 'deterministic fixture', exitCode: 0 }] };
test('pre-registered minimum passes with complete structural evidence', () => assert.equal(checkDevelopment(fixture(), integrity, regression).passed, true));
test('candidate count and paragraph links cannot substitute semantic retention', () => {
  const r = fixture(); r.judgments.forEach(j => j.memorySufficiency = 'no');
  assert.equal(checkDevelopment(r, integrity, regression).passed, false);
});
test('a protocol error cannot count as a correct final answer', () => {
  const r = fixture(); r.documents[0].questions[0].entries.desktop.error = 'binding';
  assert.equal(checkDevelopment(r, integrity, regression).passed, false);
});
test('partial extraction, missing tests or scope leak prevents full run', () => {
  const a = fixture(); a.documents[0].extraction.job.status = 'failed';
  assert.equal(checkDevelopment(a, integrity, regression).passed, false);
  assert.equal(checkDevelopment(fixture(), integrity, { passed: true, commands: [] }).passed, false);
  const b = fixture(); b.documents[0].questions[0].entries.connector.scopeViolation = true;
  assert.equal(checkDevelopment(b, integrity, regression).passed, false);
});
test('an incorrectly answered unanswerable case prevents full run', () => {
  const r = fixture(); r.judgments[19].entries.connector.answerCorrect = 'no';
  assert.equal(checkDevelopment(r, integrity, regression).passed, false);
});
