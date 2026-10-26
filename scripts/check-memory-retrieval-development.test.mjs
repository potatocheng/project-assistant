import test from 'node:test';
import assert from 'node:assert/strict';
import { checkRetrievalDevelopment, retrievalThresholds } from './check-memory-retrieval-development.mjs';

function fixture() {
  const questions = Array.from({ length: 20 }, (_, i) => ({ id: `q${i}`, question: `Question ${i}`, answerable: i !== 19,
    entries: { desktop: { result: {} }, connector: { result: {} } } }));
  const report = { complete: true, startedAt: '2026-10-20T12:02:00Z', datasetSha256: 'frozen', model: 'unit-model',
    workspace: 'previous-unit-workspace', baseline: { file: 'docs/previous-development.json', workspace: 'previous-unit-workspace', binarySha256: 'binary' },
    binarySha256: 'binary', productionSha256: { 'ai.rs': 'a', 'extraction_store.rs': 'e', 'qa.rs': 'new-q' }, evaluationSha256: { judge: 'unchanged' }, evaluationUnchanged: true,
    documents: Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, split: 'development', extraction: { job: { status: 'succeeded' } },
      memories: [{ id: `m${i}` }], questions: questions.filter((_, j) => j % 6 === i) })),
    judgments: questions.map((q, i) => ({ id: q.id, memorySufficiency: i < 15 ? 'partial' : 'no',
      baselineEntries: Object.fromEntries(['desktop', 'connector'].map(e => [e, { answerCorrect: i < 7 || i === 19 ? 'yes' : 'no' }])),
      entries: Object.fromEntries(['desktop', 'connector'].map(e => [e, { answerCorrect: i < 9 || i === 19 ? 'yes' : 'no', retrievalSufficiency: i < (e === 'desktop' ? 11 : 9) ? 'yes' : 'no' }])) })) };
  return { report, baseline: { ...structuredClone(report), productionSha256: { ...report.productionSha256, 'qa.rs': 'old-q' } },
    integrity: { results: [{ file: 'test', passed: true }] },
    regression: { passed: true, finishedAt: '2026-10-20T12:01:00Z', commands: [{ command: 'fixture', exitCode: 0 }], binarySha256: report.binarySha256, productionSha256: { ...report.productionSha256 }, evaluationSha256: { ...report.evaluationSha256 } },
    registration: { version: 'memory-retrieval-preregistration-v1', registeredAt: '2026-10-20T12:00:00Z', datasetSha256: 'frozen', baselineDevelopment: { file: 'docs/previous-development.json' }, thresholds: { ...retrievalThresholds } } };
}
const check = f => checkRetrievalDevelopment(f.report, f.integrity, f.regression, f.registration, f.baseline);
test('new higher answer and context thresholds pass only with prior tests and unchanged extraction', () => assert.equal(check(fixture()).passed, true));
test('old 7/19 result is insufficient despite satisfying the previous gate', () => {
  const f = fixture(); f.report.judgments.slice(7, 9).forEach(j => j.entries.desktop.answerCorrect = 'partial');
  assert.equal(check(f).passed, false);
});
test('context sufficiency must improve separately for each entry', () => {
  for (const e of ['desktop', 'connector']) { const f = fixture(); f.report.judgments[0].entries[e].retrievalSufficiency = 'partial'; assert.equal(check(f).passed, false); }
});
test('the single abstention regression, a scope leak or missing integrity blocks progression', () => {
  for (const change of [f => { f.report.judgments[19].entries.connector.answerCorrect = 'no'; },
    f => { f.report.documents[0].questions[0].entries.desktop.scopeViolation = true; }, f => { f.integrity.results = []; }]) {
    const f = fixture(); change(f); assert.equal(check(f).passed, false);
  }
});
test('lowered thresholds, changed extraction or untested binary cannot authorize 100 questions', () => {
  for (const change of [f => { f.registration.thresholds.desktopComplete = 7; }, f => { f.report.productionSha256['ai.rs'] = 'changed'; },
    f => { f.regression.binarySha256 = 'old'; }, f => { f.regression.finishedAt = '2026-10-20T12:03:00Z'; },
    f => { f.report.evaluationSha256.judge = 'looser-rules'; }, f => { f.report.baseline.file = 'docs/older-empty-corpus.json'; }]) {
    const f = fixture(); change(f); assert.equal(check(f).passed, false);
  }
});
test('changed question wording, model or duplicate judgments cannot pass', () => {
  for (const change of [f => { f.report.documents[0].questions[0].question = 'new text'; }, f => { f.report.model = 'different-model'; },
    f => { f.report.judgments[1] = structuredClone(f.report.judgments[0]); }]) {
    const f = fixture(); change(f); assert.equal(check(f).passed, false);
  }
});
test('absolute target does not pass when paired previous scores match or exceed the new score', () => {
  const f = fixture(); f.report.judgments[7].baselineEntries.desktop.answerCorrect = 'yes'; f.report.judgments[8].baselineEntries.desktop.answerCorrect = 'yes';
  assert.equal(check(f).passed, false);
  const g = fixture(); delete g.report.judgments[19].baselineEntries.connector;
  assert.equal(check(g).passed, false);
});
