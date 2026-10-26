import test from 'node:test';
import assert from 'node:assert/strict';
import { annotationTemplate, scoreDataset } from './evaluate-memory-quality.mjs';
const dataset = () => ({ version: 'memory-quality-v1', provenance: { kind: 'synthetic', independentReview: false }, cases: [{
  id: 'synthetic-only', projectGroup: 'p', sourceHashes: ['same-source'], split: 'development',
  extraction: { goldComplete: true, goldAtoms: [{ id: 'a' }, { id: 'b' }], candidates: [{ id: 'c', segmentationReviewed: true, atoms: [
    { correct: true, matchesGoldId: 'a' }, { correct: false, errorKind: 'role' }] }] },
  answer: { actualStatus: 'partial', expectedStatus: 'partial', requestSatisfied: true, segmentationReviewed: true,
    elapsedMs: 100, totalTokens: 20, claims: [{ text: 'A', supported: true, relevant: true, citationComplete: true, scopeCorrect: true }] },
}] });
test('scores all proposed atoms, conditions partial answers on usefulness, and counts duplicates once', () => {
  const data = dataset();
  let result = scoreDataset(data);
  assert.equal(result.independentBusinessBenchmark, false);
  assert.equal(result.development.extraction.precision, .5);
  assert.equal(result.development.extraction.recall, .5);
  assert.equal(result.development.answer.usefulAndSupportedAnswerRate, 1);
  data.cases[0].extraction.candidates[0].atoms[1] = { correct: true, matchesGoldId: 'a' };
  result = scoreDataset(data);
  assert.equal(result.development.extraction.precision, .5);
  assert.equal(result.development.extraction.errors.duplicate, 1);
});
test('missing labels, gold completeness or segmentation never become a passing score', () => {
  for (const change of [d => d.cases[0].extraction.goldComplete = false, d => d.cases[0].extraction.candidates[0].segmentationReviewed = false,
    d => d.cases[0].extraction.candidates[0].atoms[0].correct = null]) {
    const data = dataset(); change(data); assert.equal(scoreDataset(data).development.extraction.precision, null);
  }
  const data = dataset(); data.cases[0].answer.claims[0].supported = null;
  assert.equal(scoreDataset(data).development.answer.assertionSupportRate, null);
});
test('holdout rejects overlap by project or source hash', () => {
  const data = dataset(); data.cases.push({ ...data.cases[0], id: 'heldout', split: 'holdout' });
  assert.throws(() => scoreDataset(data), /leakage/);
  data.cases[1].projectGroup = 'another';
  assert.throws(() => scoreDataset(data), /leakage/);
});
test('imports a full unlabelled inventory without treating rule matches as semantic labels', () => {
  const source = { goldQa: { desktop: [{ id: 'q', grounded: true, answer: 'A. B.', question: 'q', expectedClaimsPresent: true }] },
    extraction: [{ id: 's', sourceText: 'A', candidates: [{ id: 'c', content: 'A' }], tasks: [] }] };
  const template = annotationTemplate(source, Buffer.from('synthetic'));
  const result = scoreDataset(template);
  assert.equal(result.unassigned.answer.assertionSupportRate, null);
  assert.equal(result.unassigned.extraction.precision, null);
  assert.equal(template.cases.length, 2);
});

test('external human annotations remain distinct from a business benchmark', () => {
  const data=dataset(); data.provenance={kind:'external_human_annotated',independentReview:true,reviewer:'dataset authors'};
  assert.equal(scoreDataset(data).independentBusinessBenchmark,false);
});
