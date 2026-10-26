import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { originalJudgeBody, planMissingJudges } from './continue-memory-architecture-missing-judges.mjs';
import { isolatedJudgeTasks } from './memory-qa-structured-judges.mjs';
import { architectureRequestReservation } from './memory-architecture-evaluation.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
function fixture() {
  const grade = { answerCorrect: 'yes', reason: 'evidence matches' };
  const queries = Array.from({ length: 20 }, (_, i) => ({ id: `question-${i}`, question: 'What happened?',
    answerable: true, expectedAnswers: ['a fact'], acceptableEvidenceSets: [['p1']] }));
  const documents = [{ id: 'paper', split: 'development', paragraphs: [{ id: 'p1', text: 'a fact' }], queries }];
  const questions = queries.map(q => ({ id: q.id, entries: { desktop: { result: { answer: 'a fact' } }, connector: { result: { answer: 'a fact' } } } }));
  const paper = { id: 'paper', complete: true, questions, memories: [{ id: 'm1', content: 'a fact', facets: {} }] };
  const report = { outputTag: 'qa-architecture-dev-v2', split: 'development', judgeMode: 'separated', model: 'deepseek-flash', complete: false,
    haltReason: 'Architecture request/token reservation limit', limits: { requests: 300, observedTotalTokens: 1600000, automaticRetries: 0 },
    documents: [paper], receipts: [], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 0 },
    judgments: queries.map(q => ({ id: q.id, paperId: 'paper', stages: {
      answer: { systems: { system1: { desktop: grade, connector: grade }, system2: { desktop: grade, connector: grade } } },
      memory: { memorySufficiency: 'yes', relevantMemoryIds: ['m1'], organizationIssues: [], reason: 'matches' },
      retrieval: { entries: { desktop: { retrievalSufficiency: 'yes', reason: 'matches' }, connector: { retrievalSufficiency: 'yes', reason: 'matches' } } },
    } })) };
  for (const [index, stage] of [[0, 'memory'], [0, 'retrieval'], [1, 'retrieval'], [2, 'retrieval']])
    report.judgments[index].stages[stage] = { error: 'Evaluation halted before judge', errorKind: 'transport' };
  return { report, raw: [], documents, baseline: { documents: [paper] } };
}
const plan = f => planMissingJudges(f.report, f.raw, f.documents, f.baseline);
function receipt(f, index, phase = 'answer') {
  const request = { model: 'deepseek-flash' }, value = { index, questionId: 'question-0', judgeStage: phase,
    group: `judge-question-0-${phase}`, usage: { total_tokens: 0 }, requestSha256: hash(JSON.stringify(request)) };
  f.report.receipts.push(value); f.raw.push({ ...value, request, responseText: '{}' });
}

test('plan contains only the four unsent stages and leaves all existing results unchanged', () => {
  const f = fixture(), before = JSON.stringify(f);
  const items = plan(f);
  assert.equal(items.length, 4);
  assert.deepEqual(items.map(i => i.task.phase).sort(), ['memory', 'retrieval', 'retrieval', 'retrieval']);
  assert.ok(items.every(i => i.plan.existingReceiptCount === 0 && i.plan.tokenReservation === architectureRequestReservation(i.body)));
  assert.equal(JSON.stringify(f), before);
});
test('body is the original isolated judge request with disabled thinking and no repair suffix', () => {
  const f = fixture(), item = plan(f)[0];
  const task = isolatedJudgeTasks({ doc: f.documents[0], paper: f.report.documents[0], question: f.documents[0].queries[0],
    actual: f.report.documents[0].questions[0], baselineActual: f.baseline.documents[0].questions[0], mode: 'separated' }).find(t => t.phase === item.task.phase);
  assert.deepEqual(item.body, originalJudgeBody('deepseek-flash', task));
  assert.equal(item.body.messages[0].content, task.system);
  assert.equal(item.body.messages[1].content, JSON.stringify(task.input));
  assert.equal(item.body.max_tokens, 4096); assert.equal(item.body.temperature, 0);
  assert.deepEqual(item.body.thinking, { type: 'disabled' });
});
test('existing raw lines can be in completion order, but duplicate indices are rejected', () => {
  const f = fixture(); receipt(f, 1); receipt(f, 2); f.raw.reverse();
  assert.equal(plan(f).length, 4);
  f.raw[0] = f.raw[1]; assert.throws(() => plan(f), /Duplicate/);
});
test('an existing provider receipt for a missing stage forbids any repeat', () => {
  const f = fixture(); receipt(f, 1, 'memory');
  assert.throws(() => plan(f), /already has a provider receipt/);
});
test('protocol failures and missing answers cannot be regraded', () => {
  const f = fixture(); f.report.judgments[0].stages.memory.errorKind = 'protocol';
  assert.throws(() => plan(f), /Only unsent/);
  const g = fixture(); g.report.judgments[0].stages.answer = { error: 'blocked', errorKind: 'transport' };
  assert.throws(() => plan(g), /Only unsent/);
});
test('all production QA results must exist before any judge continuation', () => {
  const f = fixture(); delete f.report.documents[0].questions[1].entries.connector.result;
  assert.throws(() => plan(f), /All 40 QA/);
});
test('a previous continuation or modified token cap is rejected', () => {
  const f = fixture(); f.report.technicalContinuation = { status: 'failed' };
  assert.throws(() => plan(f), /Only the original/);
  const g = fixture(); g.report.limits.observedTotalTokens++;
  assert.throws(() => plan(g), /Only the original/);
});
test('unreconciled raw receipts and usage fail closed', () => {
  const f = fixture(); receipt(f, 1); f.raw[0].request.model = 'changed';
  assert.throws(() => plan(f), /receipt evidence/);
  const g = fixture(); g.report.usage.total_tokens = 1;
  assert.throws(() => plan(g), /aggregate usage/);
});
