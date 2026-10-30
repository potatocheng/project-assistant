import test from 'node:test';
import assert from 'node:assert/strict';
import { checkQaEfficientDevelopment, qaEfficientThresholds } from './check-memory-qa-efficient-development.mjs';
function fixture() {
  const qs = Array.from({ length: 20 }, (_, i) => ({ id: `q${i}`, question: `Question ${i}`, answerable: i < 19,
    entries: { desktop: { result: {} }, connector: { result: {} } } }));
  const source = { 'ai.rs': 'a', 'extraction_store.rs': 'e', 'memory_query.rs': 'm', 'search.rs': 's', 'qa.rs': 'new' };
  const evaluation = { 'scripts/check-memory-qa-efficient-development.mjs': 'gate', 'docs/memory-qa-efficient-preregistration.json': 'registration' };
  const report = { complete: true, startedAt: '2026-10-20T14:30:00Z', workspace: 'new', datasetSha256: 'data', model: 'unit',
    baseline: { file: 'docs/previous-dev.json', workspace: 'old', binarySha256: 'old-bin' },
    binarySha256: 'new-bin', productionSha256: source, evaluationSha256: evaluation, evaluationUnchanged: true,
    limits: { requests: 600, observedTotalTokens: 3000000 },
    receipts: [{ phase: 'qa', usage: { total_tokens: 439346 } }],
    documents: Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, split: 'development', memories: [{ id: `m${i}` }], extraction: { job: { status: 'succeeded' } }, questions: qs.filter((_, j) => j % 6 === i) })),
    judgments: qs.map((q, i) => ({ id: q.id, memorySufficiency: i < 15 ? 'yes' : 'no',
      entries: Object.fromEntries(['desktop', 'connector'].map(e => [e, { answerCorrect: i < (e === 'desktop' ? 11 : 13) || i === 19 ? 'yes' : 'partial', retrievalSufficiency: i < 15 ? 'yes' : 'no' }])),
      baselineEntries: Object.fromEntries(['desktop', 'connector'].map(e => [e, { answerCorrect: i < (e === 'desktop' ? 9 : 13) || i === 19 ? 'yes' : 'no' }])) })) };
  const baseline = { ...structuredClone(report), workspace: 'old', binarySha256: 'old-bin', receipts: [{ phase: 'qa', usage: { total_tokens: 516878 } }] };
  return { report, baseline, integrity: { results: [{ passed: true, file: 'fixture' }] },
    regression: { passed: true, finishedAt: '2026-10-20T14:29:00Z', commands: [{ command: 'fixture', exitCode: 0 }], productionSha256: { ...source }, binarySha256: 'new-bin', evaluationSha256: { ...evaluation } },
    registration: { version: 'memory-qa-efficient-preregistration-v1', registeredAt: '2026-10-20T14:20:00Z', datasetSha256: 'data', thresholds: { ...qaEfficientThresholds }, baselineDevelopment: { file: 'docs/previous-dev.json' }, qaCostBaseline: { combined: 516878 }, limits: { development: { maxRequests: 600, maxTokens: 3000000 } } } };
}
const check = f => checkQaEfficientDevelopment(f.report, f.integrity, f.regression, f.registration, f.baseline);
test('exact new accuracy, paired improvement and fifteen-percent token gate passes at the registered boundary', () => assert.equal(check(fixture()).passed, true));
test('one token over target or missing usage cannot be counted as efficiency', () => {
  for (const change of [f => { f.report.receipts[0].usage.total_tokens++; }, f => { f.report.receipts[0].usage = null; }, f => { f.baseline.receipts[0].usage.total_tokens = 600000; }]) {
    const f = fixture(); change(f); assert.equal(check(f).passed, false);
  }
});
test('cheaper but weaker answers, reference collapse or failed refusal prevents expansion', () => {
  for (const change of [f => { f.report.judgments[10].entries.desktop.answerCorrect = 'partial'; }, f => { f.report.judgments[12].entries.connector.answerCorrect = 'partial'; },
    f => { f.report.judgments[14].entries.desktop.retrievalSufficiency = 'partial'; }, f => { f.report.judgments[19].entries.connector.answerCorrect = 'no'; }]) {
    const f = fixture(); change(f); assert.equal(check(f).passed, false);
  }
});
test('historical original floors cannot hide paired connector regression or insufficient combined gain', () => {
  const f = fixture(); f.report.judgments[13].baselineEntries.connector.answerCorrect = 'yes'; assert.equal(check(f).passed, false);
  const g = fixture(); g.report.judgments[9].baselineEntries.desktop.answerCorrect = 'yes'; assert.equal(check(g).passed, false);
});
test('protocol errors and more supplemental protocol failures cannot buy a lower token total', () => {
  const f = fixture(); f.report.documents[0].questions.at(-1).entries.desktop.error = 'invalid'; f.report.documents[0].questions.at(-1).entries.desktop.errorCode = 'ASSISTANT_GROUNDING';
  assert.equal(check(f).passed, false);
  const g = fixture(); g.report.documents[0].questions[0].entries.desktop.result.queryTrace = { supplementStatus: 'QA_GROUNDING' };
  g.report.documents[1].questions[0].entries.connector.result.queryTrace = { supplementStatus: 'MODEL_JSON' };
  assert.equal(check(g).passed, false);
});
test('changed extraction, wrong baseline or post-test evaluator changes cannot pass', () => {
  for (const change of [f => { f.report.productionSha256['ai.rs'] = 'changed'; }, f => { f.report.baseline.file = 'docs/older-easy-baseline.json'; },
    f => { f.report.evaluationSha256['scripts/check-memory-qa-efficient-development.mjs'] = 'changed'; }, f => { f.registration.thresholds.desktopComplete = 9; }]) {
    const f = fixture(); change(f); assert.equal(check(f).passed, false);
  }
});
test('authorized target navigation changes are allowed when the exact new source was tested', () => {
  const f = fixture(); f.report.productionSha256['memory_query.rs'] = 'new-tested-ranker';
  f.regression.productionSha256['memory_query.rs'] = 'new-tested-ranker'; assert.equal(check(f).passed, true);
});
test('a replacement development run cannot drop its prior pilot from the registered total budget', () => {
  const f = fixture(); f.report.priorRun = { requests: 100, totalTokens: 100000 }; assert.equal(check(f).passed, false);
  f.report.limits = { requests: 500, observedTotalTokens: 2900000 }; assert.equal(check(f).passed, true);
});
