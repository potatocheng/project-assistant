import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evidenceCoverage, firstLoss, summarize } from './score-memory-public-live.mjs';
const paper = { id: 'p', split: 'holdout', extraction: { job: { status: 'succeeded' } }, memories: [{ id: 'm' }], qaReadOnly: true };
const question = { id: 'q', answerable: true, entries: { desktop: { result: { status: 'answered' }, elapsedMs: 5 } } };
const judgment = { id: 'q', memorySufficiency: 'yes', entries: { desktop: { retrievalSufficiency: 'yes', answerCorrect: 'yes' } } };
test('loss precedence does not blame retrieval for failed extraction', () => {
  assert.equal(firstLoss({ ...paper, memories: [], extraction: { job: { status: 'failed' } } }, question, judgment, 'desktop'), 'extraction_job_failure');
  assert.equal(firstLoss(paper, question, { ...judgment, memorySufficiency: 'no', entries: { desktop: { answerCorrect: 'no' } } }, 'desktop'), 'memory_content_missing');
});
test('partially failed jobs can still supply a correct answer', () => {
  assert.equal(firstLoss({ ...paper, extraction: { job: { status: 'failed' } } }, question, judgment, 'desktop'), 'success');
});
test('error cannot count as success or correct abstention', () => {
  const broken = { ...question, entries: { desktop: { error: 'bad', errorCode: 'GROUNDING' } } };
  assert.equal(firstLoss(paper, broken, judgment, 'desktop'), 'answer_protocol_error');
  assert.equal(firstLoss(paper, { ...broken, answerable: false }, judgment, 'desktop'), 'answer_protocol_error');
});
test('missing judges and missing entries remain visible', () => {
  assert.equal(firstLoss(paper, question, null, 'desktop'), 'judge_unavailable');
  assert.equal(firstLoss(paper, question, judgment, 'connector'), 'not_run');
  const s = summarize({ documents: [{ ...paper, questions: [question] }], judgments: [], complete: false });
  assert.deepEqual(s.summary['holdout:desktop'].fullyCorrectAnswerable, { count: 0, denominator: 1, rate: 0 });
  assert.equal(s.summary['holdout:connector'].executed, 0);
});
test('an empty confirmed corpus is an observable upstream loss even if judge fails', () => {
  assert.equal(firstLoss({ ...paper, memories: [] }, question, null, 'desktop'), 'memory_content_missing');
});
test('retrieval conditional denominator excludes insufficient memories', () => {
  const s = summarize({ documents: [{ ...paper, questions: [question] }], judgments: [{ ...judgment, memorySufficiency: 'partial' }], complete: true });
  assert.deepEqual(s.summary['holdout:desktop'].rawJudgeStageLabels.retrievalGivenSufficientMemory, { count: 0, denominator: 0, rate: null });
});
test('paragraph control ignores confounded judge memory labels', () => {
  assert.equal(firstLoss({ ...paper, extraction: { diagnosticControl: true } }, question, { ...judgment, memorySufficiency: 'partial' }, 'desktop', {}), 'success');
});
test('evidence groups accept alternative annotations, not their union; clipping is visible', () => {
  const doc = { paragraphs: [{ id: 'a', content: 'full A' }, { id: 'b', content: 'full B' }], queries: [{ id: 'q', acceptableEvidenceSets: [[['a']], [['b']]] }] };
  const p = { memories: [{ id: 'm', paragraphId: 'b', content: 'full B' }], segments: [] };
  const q = { ...question, entries: { desktop: { generations: [{ references: [{ id: 'memory:m', content: 'B' }] }] } } };
  const c = evidenceCoverage(doc, p, q, 'desktop');
  assert.equal(c.originalGoldParagraphContentRetained, true);
  assert.equal(c.lastGenerationGoldParagraphIdsComplete, true);
  assert.equal(c.lastGenerationWholeGoldParagraphsVisible, false);
});
