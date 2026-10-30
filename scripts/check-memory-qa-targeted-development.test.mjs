import test from 'node:test';
import assert from 'node:assert/strict';
import { checkQaTargetedDevelopment, qaTargetedThresholds } from './check-memory-qa-targeted-development.mjs';
function fixture() {
  const trace = () => ({ maxModelCalls: 5, maxInputChars: 180000, focusedContextMaxReferences: 24, focusedContextMaxModelChars: 36000, modelCalls: 2, inputChars: 10000, reviews: [], reviewRounds: [] });
  const questions = Array.from({ length: 20 }, (_, i) => ({ id: `q${i}`, question: `Question${i}`, answerable: i < 19,
    entries: Object.fromEntries(['desktop', 'connector'].map(entry => [entry, { generations: [{}], result: { queryTrace: trace() } }])) }));
  const source = { 'ai.rs': 'a', 'extraction_store.rs': 'e', 'search.rs': 's', 'memory_query.rs': 'm', 'question_target.rs': 'new' };
  const evaluation = { 'scripts/check-memory-qa-targeted-development.mjs': 'gate', 'docs/memory-qa-targeted-preregistration.json': 'registration', 'scripts/memory-qa-targeted-budget.mjs': 'budget',
    ...Object.fromEntries(['memory-public-live-judges','score-memory-public-live','compare-memory-public-live'].map(name=>[`scripts/${name}.mjs`,'unchanged'])) };
  const budgetRegistration = { sha256: 'registration', developmentLimits: { maxRequests: 1200, maxTokens: 6000000, maxFreshAttempts: 4 } };
  const report = { complete: true, paragraphControl:false,judgeMode:'separated',startedAt: '2026-10-21T02:00:00Z', workspace: 'new', datasetSha256: 'data', model: 'unit',
    baseline: { file: 'docs/calibrated-dev-v3.json', workspace: 'old', binarySha256: 'old-bin' }, productionSha256: source, binarySha256: 'new-bin',
    evaluationSha256: evaluation, evaluationUnchanged: true, limits: { requests: 1200, observedTotalTokens: 6000000 }, budgetRegistration,
    priorRun: null, priorBudgetLedger: null, receipts: [{ phase: 'qa', usage: { total_tokens: 288410 } },
      ...['answer','memory','retrieval'].flatMap(judgeStage=>Array.from({length:20},(_,i)=>({phase:'judge',judgeStage,questionId:`q${i}`,usage:{total_tokens:10}})))],
    documents: Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, split: 'development', memories: [{ id: `m${i}` }], extraction: { job: { status: 'succeeded' } }, questions: questions.filter((_, j) => j % 6 === i) })),
    judgments: questions.map((q, i) => ({ id: q.id, memorySufficiency: i < 18 ? 'yes' : 'no',
      entries: Object.fromEntries(['desktop', 'connector'].map(entry => [entry, { answerCorrect: i < (entry === 'desktop' ? 14 : 16) || i === 19 ? 'yes' : 'partial', retrievalSufficiency: i < 17 ? 'yes' : 'no' }])),
      baselineEntries: Object.fromEntries(['desktop', 'connector'].map(entry => [entry, { answerCorrect: i < (entry === 'desktop' ? 13 : 16) || i === 19 ? 'yes' : 'partial' }])) })) };
  const baseline = { ...structuredClone(report), workspace: 'old', binarySha256: 'old-bin', receipts: [{ phase: 'qa', usage: { total_tokens: 333357 } }] };
  const costReference = { ...structuredClone(baseline), receipts: [{ phase: 'qa', usage: { total_tokens: 262191 } }] };
  return { report, baseline, costReference, integrity: { results: [{ passed: true, file: 'fixture' }] },
    regression: { passed: true, startedAt: '2026-10-21T01:51:00Z', finishedAt: '2026-10-21T01:59:00Z', commands: [{ exitCode: 0 }], productionSha256: { ...source }, binarySha256: 'new-bin', evaluationSha256: { ...evaluation } },
    registration: { version: 'memory-qa-targeted-preregistration-v1', registeredAt: '2026-10-21T01:50:00Z', model: 'unit', datasetSha256: 'data', thresholds: { ...qaTargetedThresholds },
      baselineDevelopment: { file: 'docs/calibrated-dev-v3.json' }, costReferenceDevelopment: { combinedQaTokens: 262191 }, limits: { development: { maxRequests: 1200, maxTokens: 6000000, maxFreshAttempts: 4 } } },
    budgetEvidence: { ledger: null, budgetRegistration } };
}
const check = f => checkQaTargetedDevelopment(f.report, f.integrity, f.regression, f.registration, f.baseline, f.costReference, f.budgetEvidence);
test('targeted exact14/16,17references and288410cost boundary passes with distinct quality and cost baselines', () => assert.equal(check(fixture()).passed, true));
test('one lower accuracy/reference or failed single abstention prevents full', () => {
  for (const mutate of [f => f.report.judgments[13].entries.desktop.answerCorrect = 'partial', f => f.report.judgments[15].entries.connector.answerCorrect = 'partial',
    f => f.report.judgments[16].entries.desktop.retrievalSufficiency = 'partial', f => f.report.judgments[19].entries.connector.answerCorrect = 'no']) {
    const f = fixture(); mutate(f); assert.equal(check(f).passed, false);
  }
});
test('historical floor cannot replace paired non-regression or combined improvement', () => {
  for (const mutate of [f => f.report.judgments[16].baselineEntries.connector.answerCorrect = 'yes', f => f.report.judgments[13].baselineEntries.desktop.answerCorrect = 'yes']) {
    const f = fixture(); mutate(f); assert.equal(check(f).passed, false);
  }
});
test('quality baseline333357 cannot relax the separate262191 cost reference', () => {
  for (const mutate of [f => f.report.receipts[0].usage.total_tokens++, f => f.costReference.receipts[0].usage.total_tokens = 333357,
    f => delete f.report.receipts[0].usage, f => f.costReference.model = 'different']) {
    const f = fixture(); mutate(f); assert.equal(check(f).passed, false);
  }
});
test('initial and safe-fallback supplemental review protocol failures remain visible without rewrite calls', () => {
  const f = fixture(), initialTrace=f.report.documents[0].questions[0].entries.desktop.result.queryTrace;
  initialTrace.reviews = [{ status: 'unavailable', errorCode: 'QA_REVIEW_SCHEMA' }]; initialTrace.reviewRounds=[{reviewIndex:0,generationIndex:0,retrievalRound:0,status:'unavailable'}];
  assert.equal(check(f).checks.find(c => c.name === 'no_review_protocol_failures').actual, 1);
  const g = fixture(), trace = g.report.documents[0].questions[0].entries.desktop.result.queryTrace;
  trace.reviewedPartialFallback = true; trace.reviews = [{ supported: true }, { status: 'unavailable', errorCode: 'QA_REVIEW_SCHEMA' }];
  g.report.documents[0].questions[0].entries.desktop.generations.push({});
  trace.reviewRounds=[{reviewIndex:0,generationIndex:0,retrievalRound:0,status:'validated'},{reviewIndex:1,generationIndex:1,retrievalRound:1,status:'unavailable'}];
  const result = check(g); assert.equal(result.passed, false); assert.equal(result.checks.find(c => c.name === 'supplement_protocol_failures_not_worse').actual, 1);
});
test('first real generation after a local no-model round is still supplementary retrieval without an LLM rewrite', () => {
  const f=fixture(),trace=f.report.documents[0].questions[0].entries.desktop.result.queryTrace;
  trace.reviews=[{status:'unavailable',errorCode:'QA_REVIEW_SCHEMA'}];trace.reviewRounds=[{reviewIndex:0,generationIndex:0,retrievalRound:1,status:'unavailable'}];
  const gate=check(f);assert.equal(gate.checks.find(c=>c.name==='supplement_protocol_failures_not_worse').actual,1);
});
test('frozen extraction/retrieval, source tests, caps and registration cannot drift', () => {
  for (const mutate of [f => f.report.productionSha256['search.rs'] = 'changed', f => f.report.productionSha256['memory_query.rs'] = 'changed',
    f => f.report.documents[0].questions[0].entries.desktop.result.queryTrace.maxModelCalls = 6, f => f.registration.thresholds.desktopComplete = 13,
    f => f.report.budgetRegistration.sha256 = 'changed', f => f.regression.startedAt = '2026-10-21T01:49:00Z']) {
    const f = fixture(); mutate(f); assert.equal(check(f).passed, false);
  }
});
test('paragraph controls, incomplete stage calls or changed grading source cannot masquerade as full pipeline',()=>{
  for(const mutate of [f=>f.report.paragraphControl=true,f=>f.report.receipts.pop(),f=>f.report.evaluationSha256['scripts/memory-public-live-judges.mjs']='changed']){
    const f=fixture();mutate(f);assert.equal(check(f).passed,false);
  }
});
test('only documented existing parser/schema judge repairs may add stage calls and remain in actual budget',()=>{
  const f=fixture();f.report.receipts.push({phase:'judge',judgeStage:'answer',questionId:'q0',usage:{total_tokens:100}});
  assert.equal(check(f).passed,false);f.report.evaluationRepairs=[{questionId:'q0',phases:['answer']}];assert.equal(check(f).passed,true);
});
test('all prior targeted attempts count while the old round is not treated as a budget addendum', () => {
  const f = fixture(), ledger = { entries: [{ workspace: 'first' }, { workspace: 'second' }], requests: 560, totalTokens: 2400000 };
  f.report.priorBudgetLedger = ledger; f.report.priorRun = { workspace: 'second', requests: 280, totalTokens: 1200000 };
  f.budgetEvidence.ledger = ledger; f.report.limits = { requests: 640, observedTotalTokens: 3600000 }; assert.equal(check(f).passed, true);
  f.report.limits.requests++; assert.equal(check(f).passed, false);
  f.report.limits.requests--; f.report.budgetAuthorization = { oldAddendum: true }; assert.equal(check(f).passed, false);
});
