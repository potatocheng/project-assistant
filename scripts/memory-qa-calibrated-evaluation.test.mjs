import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { evaluationRoundForTag } from './memory-evaluation-round.mjs';
import { qaCalibratedThresholds } from './check-memory-qa-calibrated-development.mjs';
import { capturedEvaluationReferences } from './capture-memory-evaluation-references.mjs';
import { isolatedJudgeTasks } from './memory-public-live-judges.mjs';
import { evidenceCoverage } from './score-memory-public-live.mjs';

test('new calibrated tags select a separate manifest while historical tag routes remain unchanged', () => {
  const current = evaluationRoundForTag('qa-calibrated-dev'), old = evaluationRoundForTag('qa-efficient-full');
  assert.equal(current.name, 'qa-calibrated'); assert.equal(old.name, 'qa-efficient');
  assert(current.files.includes('scripts/check-memory-qa-calibrated-development.mjs'));
  assert(current.files.includes('docs/memory-qa-calibrated-preregistration.json'));
  assert(!old.files.includes('docs/memory-qa-calibrated-preregistration.json'));
  assert.equal(evaluationRoundForTag('retrieval-full').name, 'retrieval');
  assert.equal(new Set(current.files).size, current.files.length);
});

test('registered thresholds and previous-round baselines exactly match before any live calls', async () => {
  const reg = JSON.parse(await readFile('docs/memory-qa-calibrated-preregistration.json'));
  assert.deepEqual(reg.thresholds, qaCalibratedThresholds);
  assert.equal(reg.qaCostBaseline.combined, 262191); assert.equal(reg.thresholds.maxCombinedQaTokens, 288410);
  for (const baseline of [reg.baselineDevelopment, reg.baselineFull]) {
    assert.equal(createHash('sha256').update(await readFile(baseline.file)).digest('hex'), baseline.sha256);
  }
  assert.deepEqual(reg.fullTargets, { desktopComplete: 62, connectorComplete: 60, desktopReferencesSufficient: 69,
    connectorReferencesSufficient: 68, desktopCorrectAbstention: 7, connectorCorrectAbstention: 7,
    maxCombinedQaTokens: 1664381, baselineCombinedQaTokens: 1513074, maxQaTokenGrowthFraction: .1 });
});

test('compact repeated metadata preserves reference bodies, stable IDs, judge views and paragraph attribution', () => {
  const raw = { references: [
    { id: 'memory:a', projectId: 'p', sourceTitle: 'Study', facets: { conditions: ['only on validation'], validUntil: '2026-12-31' }, referenceIndex: 1,
      content: [{ spanIndex: 1, text: 'First exact paragraph.' }] },
    { id: 'memory:b', sourceTitle: 'Study', facets: { entity: 'main task', role: 'training' }, referenceIndex: 2,
      content: [{ spanIndex: 1, text: 'Second exact ' }, { spanIndex: 2, text: 'paragraph.' }] },
  ] };
  const saved = structuredClone(raw), references = capturedEvaluationReferences(raw);
  assert.deepEqual(raw, saved); assert.equal(Object.hasOwn(references[1], 'projectId'), false);
  assert.equal(Object.hasOwn(references[0], 'memoryId'), false); assert.equal(references[1].id, 'memory:b');
  assert.deepEqual(references.map(r => r.content), ['First exact paragraph.', 'Second exact paragraph.']);
  assert.deepEqual(references[0].facets, raw.references[0].facets); assert.equal(references[1].sourceTitle, 'Study');
  const question = { id: 'q', question: 'Which two observations are used?', answerable: true,
    acceptableEvidenceSets: [[['p1'], ['p2']]], expectedAnswers: ['Both observations'], entries: {
      desktop: { generations: [{ references }] }, connector: { generations: [{ references: references.map(r => ({ ...r, memoryId: r.id.slice(7) })) }] },
    } };
  const doc = { paragraphs: [{ id: 'p1', content: 'First exact paragraph.' }, { id: 'p2', content: 'Second exact paragraph.' }], queries: [question] };
  const paper = { memories: [{ id: 'a', content: 'First exact paragraph.', paragraphId: 'p1' }, { id: 'b', content: 'Second exact paragraph.', paragraphId: 'p2' }] };
  const tasks = isolatedJudgeTasks({ doc, paper, question, actual: question, baselineActual: question, mode: 'separated' });
  assert.deepEqual(tasks.find(t => t.phase === 'retrieval').input.entries.desktop.references,
    [{ id: 'memory:a', content: 'First exact paragraph.' }, { id: 'memory:b', content: 'Second exact paragraph.' }]);
  for (const entry of ['desktop', 'connector']) {
    const coverage = evidenceCoverage(doc, paper, question, entry);
    assert.equal(coverage.lastGenerationGoldParagraphIdsComplete, true);
    assert.equal(coverage.lastGenerationWholeGoldParagraphsVisible, true);
  }
});

test('capture retains explicit cross-project metadata and never invents inherited scope', () => {
  const input = { references: [
    { id: 'memory:a', projectId: 'p', content: [{ spanIndex: 1, text: 'A' }] },
    { id: 'memory:b', projectId: 'other', content: [{ spanIndex: 1, text: 'B' }] },
  ] };
  assert.deepEqual(capturedEvaluationReferences(input).map(r => r.projectId), ['p', 'other']);
  const missing = { references: [{ id: 'memory:a', content: [{ spanIndex: 1, text: 'A' }] }] };
  assert.equal(Object.hasOwn(capturedEvaluationReferences(missing)[0], 'projectId'), false);
});

test('same-source omissions and explicit null metadata stay distinguishable without changing capture facts', () => {
  const common = { references: [
    { id: 'memory:a', projectId: 'p', sourceTitle: 'Study', content: [{ spanIndex: 1, text: 'Exact A' }] },
    { id: 'memory:b', content: [{ spanIndex: 1, text: 'Exact B' }] },
  ] };
  const refs = capturedEvaluationReferences(common);
  assert.equal(Object.hasOwn(refs[1], 'projectId'), false); assert.equal(Object.hasOwn(refs[1], 'sourceTitle'), false);
  const unknown = { references: [{ id: 'memory:x', projectId: null, sourceTitle: null, content: [{ spanIndex: 1, text: 'Exact X' }] }] };
  const captured = capturedEvaluationReferences(unknown)[0];
  assert.equal(captured.projectId, null); assert.equal(captured.sourceTitle, null); assert.equal(captured.content, 'Exact X');
});
