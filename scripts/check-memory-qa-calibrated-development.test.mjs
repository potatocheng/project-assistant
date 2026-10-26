import test from 'node:test';
import assert from 'node:assert/strict';
import { checkQaCalibratedDevelopment, qaCalibratedThresholds } from './check-memory-qa-calibrated-development.mjs';
import { budgetCanonical, budgetHash } from './memory-public-live-budget.mjs';
function fixture() {
  const trace = () => ({ maxModelCalls: 5, maxInputChars: 180000, focusedContextMaxReferences: 24,
    focusedContextMaxModelChars: 36000, modelCalls: 2, inputChars: 10000 });
  const qs = Array.from({ length: 20 }, (_, i) => ({ id: `q${i}`, question: `Question ${i}`, answerable: i < 19,
    entries: { desktop: { result: { queryTrace: trace() } }, connector: { result: { queryTrace: trace() } } } }));
  const source = { 'ai.rs': 'a', 'extraction_store.rs': 'e', 'memory_query.rs': 'm', 'search.rs': 's', 'qa.rs': 'new' };
  const evaluation = { 'scripts/check-memory-qa-calibrated-development.mjs': 'gate', 'docs/memory-qa-calibrated-preregistration.json': 'registration' };
  const report = { complete: true, startedAt: '2026-10-20T14:30:00Z', workspace: 'new', datasetSha256: 'data', model: 'unit',
    baseline: { file: 'docs/previous-dev.json', workspace: 'old', binarySha256: 'old-bin' },
    binarySha256: 'new-bin', productionSha256: source, evaluationSha256: evaluation, evaluationUnchanged: true,
    limits: { requests: 600, observedTotalTokens: 3000000 },
    receipts: [{ phase: 'qa', usage: { total_tokens: 288410 } }],
    documents: Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, split: 'development', memories: [{ id: `m${i}` }], extraction: { job: { status: 'succeeded' } }, questions: qs.filter((_, j) => j % 6 === i) })),
    judgments: qs.map((q, i) => ({ id: q.id, memorySufficiency: i < 18 ? 'yes' : 'no',
      entries: Object.fromEntries(['desktop', 'connector'].map(e => [e, { answerCorrect: i < (e === 'desktop' ? 13 : 14) || i === 19 ? 'yes' : 'partial', retrievalSufficiency: i < 16 ? 'yes' : 'no' }])),
      baselineEntries: Object.fromEntries(['desktop', 'connector'].map(e => [e, { answerCorrect: i < (e === 'desktop' ? 12 : 14) || i === 19 ? 'yes' : 'no' }])) })) };
  const baseline = { ...structuredClone(report), workspace: 'old', binarySha256: 'old-bin', receipts: [{ phase: 'qa', usage: { total_tokens: 262191 } }] };
  return { report, baseline, integrity: { results: [{ passed: true, file: 'fixture' }] },
    regression: { passed: true, finishedAt: '2026-10-20T14:29:00Z', commands: [{ command: 'fixture', exitCode: 0 }], productionSha256: { ...source }, binarySha256: 'new-bin', evaluationSha256: { ...evaluation } },
    registration: { version: 'memory-qa-calibrated-preregistration-v1', registeredAt: '2026-10-20T14:20:00Z', model: 'unit', datasetSha256: 'data', thresholds: { ...qaCalibratedThresholds }, baselineDevelopment: { file: 'docs/previous-dev.json' }, qaCostBaseline: { combined: 262191 }, limits: { development: { maxRequests: 600, maxTokens: 3000000 } } } };
}
const check = f => checkQaCalibratedDevelopment(f.report, f.integrity, f.regression, f.registration, f.baseline);
test('exact new accuracy, paired improvement and ten-percent token growth gate passes at the registered boundary', () => assert.equal(check(fixture()).passed, true));
test('one token over target or missing usage cannot be counted as efficiency', () => {
  for (const change of [f => { f.report.receipts[0].usage.total_tokens++; }, f => { f.report.receipts[0].usage = null; }, f => { f.baseline.receipts[0].usage.total_tokens = 600000; }]) {
    const f = fixture(); change(f); assert.equal(check(f).passed, false);
  }
});
test('cheaper but weaker answers, reference collapse or failed refusal prevents expansion', () => {
  for (const change of [f => { f.report.judgments[12].entries.desktop.answerCorrect = 'partial'; }, f => { f.report.judgments[13].entries.connector.answerCorrect = 'partial'; },
    f => { f.report.judgments[15].entries.desktop.retrievalSufficiency = 'partial'; }, f => { f.report.judgments[19].entries.connector.answerCorrect = 'no'; }]) {
    const f = fixture(); change(f); assert.equal(check(f).passed, false);
  }
});
test('historical original floors cannot hide paired connector regression or insufficient combined gain', () => {
  const f = fixture(); f.report.judgments[14].baselineEntries.connector.answerCorrect = 'yes'; assert.equal(check(f).passed, false);
  const g = fixture(); g.report.judgments[12].baselineEntries.desktop.answerCorrect = 'yes'; assert.equal(check(g).passed, false);
});
test('protocol errors and more supplemental protocol failures cannot buy a lower token total', () => {
  const f = fixture(); f.report.documents[0].questions.at(-1).entries.desktop.error = 'invalid'; f.report.documents[0].questions.at(-1).entries.desktop.errorCode = 'ASSISTANT_GROUNDING';
  assert.equal(check(f).passed, false);
  const g = fixture(); g.report.documents[0].questions[0].entries.desktop.result.queryTrace.supplementStatus = 'QA_GROUNDING';
  g.report.documents[1].questions[0].entries.connector.result.queryTrace.supplementStatus = 'MODEL_JSON';
  assert.equal(check(g).passed, false);
});
test('changed extraction, wrong baseline or post-test evaluator changes cannot pass', () => {
  for (const change of [f => { f.report.productionSha256['ai.rs'] = 'changed'; }, f => { f.report.baseline.file = 'docs/older-easy-baseline.json'; },
    f => { f.report.evaluationSha256['scripts/check-memory-qa-calibrated-development.mjs'] = 'changed'; }, f => { f.registration.thresholds.desktopComplete = 9; }]) {
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

test("retained information below eighteen or a single supplemental protocol failure blocks expansion",()=>{const f=fixture();f.report.judgments[17].memorySufficiency="no";assert.equal(check(f).passed,false);const g=fixture();g.report.documents[0].questions[0].entries.desktop.result.queryTrace.supplementStatus="QA_REVIEW_SCHEMA";assert.equal(check(g).passed,false);});

test('missing traces or raised production caps cannot pass even at the token boundary', () => {
  for (const change of [f => { delete f.report.documents[0].questions[0].entries.desktop.result.queryTrace; },
    f => { f.report.documents[0].questions[0].entries.desktop.result.queryTrace.maxModelCalls = 6; },
    f => { f.report.documents[0].questions[0].entries.connector.result.queryTrace.inputChars = 180001; }]) {
    const f = fixture(); change(f); assert.equal(check(f).passed, false);
  }
});

test('an initial unavailable review cannot silently count as zero QA protocol failures', () => {
  const f = fixture();
  f.report.documents[0].questions[0].entries.desktop.result.queryTrace.reviews = [{ status: 'unavailable', errorCode: 'QA_REVIEW_SCHEMA' }];
  const g = check(f); assert.equal(g.passed, false);
  assert.equal(g.checks.find(c => c.name === 'no_review_protocol_failures').actual, 1);
  assert.equal(g.checks.find(c => c.name === 'supplement_protocol_failures_not_worse').actual, 0);
});

test('a supplemental review failure remains counted after safe partial fallback and is not double-counted', () => {
  const f = fixture(), result = f.report.documents[0].questions[0].entries.connector.result;
  result.grounded = true; result.status = 'partial';
  Object.assign(result.queryTrace, { reviewedPartialFallback: true, answerGenerationIndex: 0,
    reviews: [{ supported: true, answersQuestion: true }, { status: 'unavailable', errorCode: 'MODEL_JSON' }], supplementStatus: 'MODEL_JSON' });
  const g = check(f); assert.equal(g.passed, false);
  assert.equal(g.checks.find(c => c.name === 'no_review_protocol_failures').actual, 1);
  assert.equal(g.checks.find(c => c.name === 'supplement_protocol_failures_not_worse').actual, 1);
  result.queryTrace.reviews[0] = null; delete result.queryTrace.supplementStatus;
  assert.equal(check(f).checks.find(c => c.name === 'supplement_protocol_failures_not_worse').actual, 1);
});

function extendedFixture() {
  const f = fixture(), ledger = { requests: 548, totalTokens: 2451045, entries: [{ workspace: 'A' }, { workspace: 'B' }], sha256: 'verified-ledger' };
  const authorization = { sha256: 'addendum', registeredAt: '2026-10-20T14:25:00Z', baseRegistrationSha256: 'registration',
    baseThresholdsSha256: budgetHash(budgetCanonical(f.registration.thresholds)), effectiveDevelopmentLimits: { maxRequests: 900, maxTokens: 4500000 } };
  Object.assign(f.report.evaluationSha256, { 'scripts/memory-public-live-budget.mjs': 'helper', 'docs/memory-qa-calibrated-budget-addendum-1.json': 'addendum' });
  f.regression.evaluationSha256 = { ...f.report.evaluationSha256 };
  f.report.priorBudgetLedger = ledger; f.report.budgetAuthorization = authorization;
  f.report.priorRun = { workspace: 'B', requests: 266, totalTokens: 1177756 };
  f.report.limits = { requests: 352, observedTotalTokens: 2048955 };
  f.budgetEvidence = { authorization, ledger };
  return f;
}

test('one registered extension accounts for both failed pilots while preserving every quality threshold', () => {
  const f = extendedFixture();
  const result = checkQaCalibratedDevelopment(f.report, f.integrity, f.regression, f.registration, f.baseline, f.budgetEvidence);
  assert.equal(result.passed, true); assert.equal(f.registration.limits.development.maxRequests, 600);
  assert.equal(result.checks.find(c => c.name === 'shared_registered_development_budget').actual.priorRequests, 548);
  assert.equal(check(f).passed, false);
  f.report.receipts.push({ phase: 'extraction', usage: { total_tokens: 1800000 } });
  assert.equal(checkQaCalibratedDevelopment(f.report, f.integrity, f.regression, f.registration, f.baseline, f.budgetEvidence)
    .checks.find(c => c.name === 'shared_registered_development_budget').passed, false);
});

test('late addenda, missing cumulative ledgers and changed quality thresholds cannot authorize expansion', () => {
  for (const mutate of [f => { f.report.budgetAuthorization.registeredAt = '2026-10-20T14:29:30Z'; },
    f => { delete f.report.priorBudgetLedger; }, f => { f.registration.thresholds.connectorComplete--; }]) {
    const f = extendedFixture(); mutate(f);
    assert.equal(checkQaCalibratedDevelopment(f.report, f.integrity, f.regression, f.registration, f.baseline, f.budgetEvidence).passed, false);
  }
});
