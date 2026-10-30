import test from 'node:test';
import assert from 'node:assert/strict';
import { originalRetrievalSnapshot, retrievalQuestionRows, assessRetrievalExecution, summarizeEnvelopeNormalizations, distinctRetrievalRunUsage,
  retrievalOperationalMetrics, retrievalSplitSummaries } from './report-memory-retrieval-optimized.mjs';

function fixture() {
  const documents = Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, split: 'development', memories: [],
    questions: Array.from({ length: i < 2 ? 4 : 3 }, (_, j) => ({ id: `p${i}q${j}`, question: `Question ${i} ${j}`, answerable: !(i === 5 && j === 2),
      entries: { desktop: { result: { status: 'answered' }, generations: [{}] }, connector: { result: { status: 'answered' }, generations: [{}] } } })) }));
  const questions = documents.flatMap(d => d.questions);
  const previous = { model: 'unit', documents, judgments: questions.map((q, i) => ({ id: q.id, memorySufficiency: 'yes',
    entries: Object.fromEntries(['desktop', 'connector'].map(e => [e, { answerCorrect: i < 7 || !q.answerable ? 'yes' : 'no', retrievalSufficiency: i < 9 ? 'yes' : 'no' }])) })) };
  const current = structuredClone(previous);
  current.judgments.forEach((j, i) => { j.baselineEntries = structuredClone(j.entries); for (const e of ['desktop', 'connector']) j.entries[e].answerCorrect = i < 9 || i === 19 ? 'yes' : 'no'; });
  return { previous, current };
}
test('original previous score is kept separately from anonymous paired baseline score', () => {
  const f = fixture(); f.current.judgments[0].baselineEntries.desktop.answerCorrect = 'no';
  const rows = retrievalQuestionRows(f.current, f.previous);
  const row = rows.find(r => r.entry === 'desktop');
  assert.equal(row.previousOriginalAnswer, 'yes'); assert.equal(row.previousPairedAnswer, 'no');
  assert.equal(row.currentAnswer, 'yes'); assert.equal(row.pairedChange, 'new_success'); assert.equal(row.originalChange, 'retained_success');
  assert.equal(originalRetrievalSnapshot(f.previous).outcomes.desktop.complete.count, 7);
});
test('protocol errors cannot become correct even if a semantic label says yes', () => {
  const f = fixture(); f.current.documents[0].questions[0].entries.desktop.error = 'bad binding';
  const row = retrievalQuestionRows(f.current, f.previous).find(r => r.entry === 'desktop');
  assert.equal(row.currentCorrect, false); assert.equal(row.pairedChange, 'regression');
});
test('unanswerable questions have separate denominator and original stage labels', () => {
  const f = fixture(), s = originalRetrievalSnapshot(f.previous);
  assert.equal(s.answerable, 19); assert.equal(s.unanswerable, 1); assert.equal(s.outcomes.connector.abstention.count, 1);
  assert.equal(s.outcomes.connector.complete.denominator, 19); assert.equal(s.memoryLabels.yes, 19);
});
test('changed question identity fails and never produces a misleading comparison row', () => {
  const f = fixture(); f.current.documents[0].questions[0].question = 'changed';
  assert.throws(() => retrievalQuestionRows(f.current, f.previous), /identity changed/);
});
test('without full artifacts reporting cannot claim complete 100 execution', () => {
  const f = fixture(); Object.assign(f.current, { complete: true, datasetSha256: 'data', productionSha256: { qa: 'new' }, binarySha256: 'b' });
  const r = assessRetrievalExecution({ dev: f.current, gate: null, full: null, datasetSha256: 'data', registration: null });
  assert.equal(r.fullRunExecuted, false); assert.equal(r.fullAuthorizedWithFrozenRules, false);
});
test('same source cannot mask changed evaluation rules or a postdated gate', () => {
  const f = fixture(); Object.assign(f.current, { complete: true, datasetSha256: 'data', workspace: 'unit', productionSha256: { qa: 'new' }, binarySha256: 'b', evaluationSha256: { judge: 'old' }, evaluationUnchanged: true });
  const registration = { registeredAt: '2026-10-20T12:00:00Z', thresholds: { a: 9 } };
  const gate = { ...structuredClone(f.current), passed: true, registration, recordedAt: '2026-10-20T12:02:00Z', checks: [] };
  const full = { ...structuredClone(f.current), gate: 'docs/unit-gate.json', startedAt: '2026-10-20T12:01:00Z', evaluationSha256: { judge: 'new' } };
  const r = assessRetrievalExecution({ dev: f.current, gate, full, registration, datasetSha256: 'data', gateFile: 'docs/unit-gate.json' });
  assert.equal(r.sameEvaluationRules, false); assert.equal(r.gatePrecedesFull, false); assert.equal(r.fullAuthorizedWithFrozenRules, false);
});

test('lossless envelope audit remains distinct from syntax recovery and model re-evaluation', () => {
  const event = { kind: 'wrap-flat-answer-systems', receiptId: 27, modelRequests: 0, originalSha256: 'a', normalizedSha256: 'b' };
  const summary = summarizeEnvelopeNormalizations({ evaluationEnvelopeNormalizations: [event] });
  assert.equal(summary.count, 1); assert.equal(summary.additionalApiRequests, 0); assert.equal(summary.additionalTokens, 0);
  assert.deepEqual(summary.records[0], event);
});

test('failed pilot cost is included once alongside a new development run with shared limits', () => {
  const pilot = { workspace: 'pilot', complete: false, usage: { requests: 271, reportedTokens: 1420745 } };
  const dev = { workspace: 'new-dev', usage: { requests: 260, reportedTokens: 1400000 } };
  const summary = distinctRetrievalRunUsage([pilot, dev, pilot, null]);
  assert.equal(summary.distinctRuns, 2); assert.equal(summary.requests, 531); assert.equal(summary.reportedTokens, 2820745);
});

test('operational cost uses actual QA requests, separates planning from a second generation and includes safe supplemental failures', () => {
  const f = fixture();
  f.current.receipts = [
    { phase: 'qa', entry: 'desktop', questionId: 'p0q0', task: 'generation', usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
    { phase: 'qa', entry: 'desktop', questionId: 'p0q0', task: 'query_rewrite', usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
    { phase: 'qa', entry: 'desktop', questionId: 'p0q0', task: 'generation', usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 } },
    { phase: 'qa', entry: 'desktop', questionId: 'p0q1', task: 'query_rewrite', usage: { total_tokens: 5 } },
    { phase: 'judge', entry: 'desktop', questionId: 'p0q0', task: 'answer', usage: { total_tokens: 999 } },
  ];
  f.current.documents[0].questions[0].entries.desktop = { elapsedMs: 100, result: { grounded: false, status: 'unknown', queryTrace: { rounds: [{}, {}], reviews: [{ supported: true, answersQuestion: false }], supplementStatus: 'QA_GROUNDING' } } };
  f.current.documents[0].questions[1].entries.desktop.elapsedMs = 500;
  const result = retrievalOperationalMetrics(f.current, new Set(['p0q0', 'p0q1'])).desktop;
  assert.equal(result.requests, 4); assert.equal(result.reportedTokens, 44);
  assert.equal(result.supplementPlanningQuestions, 2); assert.equal(result.actualSupplementGenerationQuestions, 1);
  assert.equal(result.tracedExtraRetrievalRounds, 1); assert.equal(result.answerableRefusals, 1);
  assert.equal(result.anyRejectedReviewQuestions, 1); assert.equal(result.supplementFailureCodes.QA_GROUNDING, 1);
  assert.equal(result.p50Ms, 100); assert.equal(result.p95Ms, 500);
});

test('100-run split reporting reads each subset from that run rather than importing standalone development scores', () => {
  const f = fixture(); f.current.receipts = []; f.previous.receipts = [];
  f.current.documents[5].split = 'holdout';
  const comparison = { summary: Object.fromEntries(['development', 'holdout'].flatMap(s => ['desktop', 'connector'].map(e => [`${s}:${e}`, { from: `same-full-${s}-${e}` }]))) };
  const splits = retrievalSplitSummaries(f.current, f.previous, comparison);
  assert.equal(splits.development.questions, 17); assert.equal(splits.holdout.questions, 3);
  assert.equal(splits.development.current.answerable, 17); assert.equal(splits.holdout.current.unanswerable, 1);
  assert.equal(splits.holdout.paired.desktop.from, 'same-full-holdout-desktop');
});
