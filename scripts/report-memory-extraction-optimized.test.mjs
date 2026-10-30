import test from 'node:test';
import assert from 'node:assert/strict';
import { assessOptimizedExecution, buildOptimizedMetrics, withExpectedQuestionScope, summarizeEvaluationRepairs, summarizeEvaluationSyntaxRepairs } from './report-memory-extraction-optimized.mjs';

const datasetSha256 = 'frozen-fixture';
const gateFile = 'docs/unit-test-development-gate.json';

function fixtures() {
  let positiveDev = 0, positiveHoldout = 0;
  const documents = Array.from({ length: 36 }, (_, i) => {
    const split = i < 6 ? 'development' : 'holdout';
    const n = i < 6 ? (i < 2 ? 4 : 3) : (i < 26 ? 3 : 2);
    const id = `paper-${i}`;
    return { id, split, title: id, paragraphs: [{ id: `${id}:p0`, content: `Source ${id}`, section: 'main' }],
      queries: Array.from({ length: n }, (_, index) => ({ id: `${id}:q${index}`, question: `Question ${id} ${index}`,
        answerable: split === 'development' ? positiveDev++ < 19 : positiveHoldout++ < 72,
        acceptableEvidenceSets: [[[`${id}:p0`]]], expectedAnswers: [] })) };
  });
  const makeReport = split => ({ version: 'qasper-production-live-v2', split, judgeMode: 'separated', datasetSha256,
    workspace: '.local-data/nonexistent-unit-report', productionSha256: { 'ai.rs': 'a', 'qa.rs': 'q' }, binarySha256: 'binary',
    complete: true, receipts: [], judgments: [], model: 'unit-model',
    documents: documents.filter(d => split === 'all' || d.split === split).map(d => ({ id: d.id, split: d.split, memories: [], questions: d.queries.map(q => ({ id: q.id, question: q.question, answerable: q.answerable,
      entries: { desktop: { result: { grounded: false, status: 'unknown' }, generations: [] }, connector: { result: { grounded: false, status: 'unknown' }, generations: [] } } })) })) });
  const dev = makeReport('development'), full = makeReport('all');
  full.gate = gateFile;
  full.receipts = [{ phase: 'qa', task: 'generation', usage: { total_tokens: 1 } }];
  const gate = { passed: true, workspace: dev.workspace, datasetSha256,
    productionSha256: { 'qa.rs': 'q', 'ai.rs': 'a' }, binarySha256: 'binary', checks: [{ name: 'answers', required: '5/19', actual: 5, passed: true }] };
  return { fixture: { documents }, dev, full, gate, makeReport };
}

test('scope and hashes allow only exact frozen 20/100 cases, independent of object key order', () => {
  const f = fixtures();
  const result = assessOptimizedExecution({ ...f, datasetSha256, gateFile });
  assert.equal(result.developmentScopeValid, true);
  assert.equal(result.gateMatchesDevelopment, true);
  assert.equal(result.full100QuestionsPresent, true);
  assert.equal(result.fullComplete, true);
  assert.equal(result.fullGateMatches, true);
});

test('an old failed gate, source change, wrong binary or gate path cannot authorize full run', () => {
  for (const change of [
    f => { f.gate.passed = false; },
    f => { f.dev.productionSha256['qa.rs'] = 'changed'; },
    f => { f.full.binarySha256 = 'other'; },
    f => { f.full.gate = 'docs/different-gate.json'; },
    f => { f.gate.datasetSha256 = 'different-fixture'; },
  ]) {
    const f = fixtures(); change(f);
    assert.equal(assessOptimizedExecution({ ...f, datasetSha256, gateFile }).fullGateMatches, false);
  }
});

test('100 duplicated, wrong-text or wrong-answerability rows do not satisfy full scope', () => {
  for (const change of [
    f => { f.full.documents[0].questions[1] = structuredClone(f.full.documents[0].questions[0]); },
    f => { f.full.documents[0].questions[0].question = 'Changed'; },
    f => { f.full.documents[0].questions[0].answerable = false; },
    f => { f.full.documents[0].questions.pop(); },
  ]) {
    const f = fixtures(); change(f);
    const result = assessOptimizedExecution({ ...f, datasetSha256, gateFile });
    assert.equal(result.full100QuestionsPresent, false);
    assert.equal(result.fullComplete, false);
  }
});

test('no full artifact is not reported as full execution or gate approval', () => {
  const f = fixtures(); delete f.full;
  const result = assessOptimizedExecution({ ...f, datasetSha256, gateFile });
  assert.equal(result.fullRunProvided, false);
  assert.equal(result.fullRunExecuted, false);
  assert.equal(result.fullComplete, false);
  assert.equal(result.fullGateMatches, null);
});

test('initial and current gate thresholds compare requirements, not observed scores', () => {
  const f = fixtures();
  const initialGate = structuredClone(f.gate);
  initialGate.passed = false; initialGate.checks[0].actual = 2; initialGate.checks[0].passed = false;
  assert.equal(assessOptimizedExecution({ ...f, initialGate, datasetSha256, gateFile }).gateThresholdsUnchangedSinceInitial, true);
  initialGate.checks[0].required = '2/19';
  assert.equal(assessOptimizedExecution({ ...f, initialGate, datasetSha256, gateFile }).gateThresholdsUnchangedSinceInitial, false);
});

test('missing development papers and questions are padded without invented results', () => {
  const f = fixtures();
  f.dev.documents = [f.dev.documents[0]];
  f.dev.documents[0].questions = [f.dev.documents[0].questions[0]];
  const result = withExpectedQuestionScope(f.dev, f.fixture);
  assert.equal(result.documents.length, 6);
  assert.equal(result.documents.flatMap(p => p.questions).length, 20);
  assert.deepEqual(result.documents[1].memories, []);
  assert.deepEqual(result.documents[1].questions[0].entries, {});
  assert.equal(f.dev.documents.length, 1, 'input remains unchanged');
});

test('incomplete real run keeps 19/1 denominators and never invents successful missing cases', async () => {
  const f = fixtures(), baseline = f.makeReport('all');
  const control = { ...baseline, paragraphControl: true };
  f.dev.documents = [f.dev.documents[0]];
  f.dev.documents[0].questions = [f.dev.documents[0].questions[0]];
  f.dev.complete = false;
  const id = f.dev.documents[0].questions[0].id;
  f.dev.judgments = [{ id, methodology: 'isolated-stage-v2', memorySufficiency: 'yes', entries: { desktop: { answerCorrect: 'yes', retrievalSufficiency: 'yes' }, connector: { answerCorrect: 'partial', retrievalSufficiency: 'partial' } } }];
  const result = await buildOptimizedMetrics(f.dev, baseline, control, f.fixture);
  assert.equal(result.scope.questions, 20);
  assert.equal(result.scope.observedQuestions, 1);
  assert.equal(result.outcomes.desktop.completeCorrect.denominator, 19);
  assert.equal(result.outcomes.desktop.completeCorrect.count, 1);
  assert.equal(result.outcomes.connector.partialCorrect.denominator, 19);
  assert.equal(result.outcomes.connector.partialCorrect.count, 1);
  assert.equal(result.outcomes.desktop.correctAbstention.denominator, 1);
  assert.equal(result.outcomes.desktop.correctAbstention.count, 0);
  assert.equal(result.outcomes.desktop.answerableOutcomes.not_run, 18);
  assert.equal(result.organization.semanticAssertionPrecision, null);
  assert.equal(result.organization.independentHumanReview.performed, false);
});

test('successful format repair retains old judge errors and bills only extra judge requests', () => {
  const report = { judgments: [{ id: 'q1', stages: { answer: { systems: {} }, memory: { memorySufficiency: 'yes' } } }],
    receipts: [
      { index: 1, phase: 'qa', task: 'generation', usage: { total_tokens: 900 } },
      { index: 2, phase: 'judge', judgeStage: 'answer', usage: { total_tokens: 100 } },
      { index: 3, phase: 'judge', judgeStage: 'answer', evaluationRepair: true, usage: { total_tokens: 120 } },
    ], evaluationRepairs: [{ questionId: 'q1', paperId: 'p1', phases: ['answer'], completedAt: '2026-10-20T00:00:00Z',
      previousJudgment: { id: 'q1', error: 'answer: malformed quotation', receiptIds: [2], stages: { answer: { error: 'malformed quotation', errorKind: 'protocol' }, memory: { memorySufficiency: 'yes' } } }, newReceiptIds: [3] }] };
  const result = summarizeEvaluationRepairs(report);
  assert.equal(result.attemptedQuestions, 1);
  assert.deepEqual(result.phases, { answer: 1 });
  assert.equal(result.extraRequests, 1);
  assert.equal(result.extraReportedTokens, 120);
  assert.equal(result.currentJudgeErrorQuestions, 0);
  assert.equal(result.oldErrors[0].error, 'malformed quotation');
  assert.equal(result.oldErrors[0].currentError, null);
  assert.equal(result.previousJudgmentsPreserved, true);
  assert.equal(result.productionRequestsAmongRepairs, 0);
  assert.equal(report.evaluationRepairs[0].previousJudgment.stages.memory.memorySufficiency, 'yes');
});

test('cached single-brace syntax recovery accepts phase/stage metadata and costs zero extra API calls', () => {
  const repair = { questionId: 'q1', paperId: 'p1', receiptId: 246, kind: 'append-single-final-object-brace', appended: '}',
    originalError: 'Expected final object brace', originalSha256: 'a'.repeat(64), repairedSha256: 'b'.repeat(64), modelRequests: 0 };
  const report = { evaluationSyntaxRepairs: [{ ...repair, phase: 'answer' }, { ...repair, questionId: 'q2', receiptId: 300, stage: 'memory' }] };
  const result = summarizeEvaluationSyntaxRepairs(report);
  assert.equal(result.repairs, 2);
  assert.equal(result.questions, 2);
  assert.deepEqual(result.phases, { answer: 1, memory: 1 });
  assert.deepEqual(result.receiptIds, [246, 300]);
  assert.equal(result.additionalApiRequests, 0);
  assert.equal(result.additionalTokens, 0);
  assert.equal(result.singleBraceRuleRecords, 2);
  assert.equal(result.fingerprintedRecords, 2);
  assert.equal(result.records[0].originalError, 'Expected final object brace');
  assert.equal(report.evaluationSyntaxRepairs[1].phase, undefined, 'source metadata is unchanged');
});
