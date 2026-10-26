import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluationRoundForTag } from './memory-evaluation-round.mjs';
import { capturedEvaluationReferences, selectedEvaluationGeneration, selectedEvaluationReferences, capturedEvaluationSchema } from './capture-memory-evaluation-references.mjs';

test('new round selects its independent gate and registration without changing legacy manifests', () => {
  const current = evaluationRoundForTag('qa-efficient-dev-v2'), previous = evaluationRoundForTag('retrieval-full');
  assert.equal(current.name, 'qa-efficient'); assert.equal(previous.name, 'retrieval');
  assert(current.files.includes('scripts/check-memory-qa-efficient-development.mjs'));
  assert(current.files.includes('docs/memory-qa-efficient-preregistration.json'));
  assert(!previous.files.includes('docs/memory-qa-efficient-preregistration.json'));
});
test('legacy string references are unchanged and source envelopes stay untouched', () => {
  const input = { references: [{ id: 'memory:m', content: 'Current body.', facets: { entity: 'Atlas' } }] };
  const original = structuredClone(input);
  assert.deepEqual(capturedEvaluationReferences(input), original.references); assert.deepEqual(input, original);
});
test('indexed reference spans are joined exactly in supplied order with IDs and Unicode intact', () => {
  const input = { context: { memories: [{ id: 'memory:m', memoryId: 'm', referenceIndex: 0,
    content: [{ spanIndex: 1, text: 'Atlas 保留\n' }, { spanIndex: 2, text: '30天。  ' }] }] } };
  const original = structuredClone(input), result = capturedEvaluationReferences(input);
  assert.equal(result[0].content, 'Atlas 保留\n30天。  '); assert.equal(result[0].id, 'memory:m');
  assert.equal(result[0].memoryId, 'm'); assert.equal(result[0].referenceIndex, 0); assert.deepEqual(input, original);
});
test('capture rejects malformed spans instead of inventing or dropping body text', () => {
  for (const content of [null, [], [{ spanIndex: 1, text: 'a' }, { spanIndex: 1, text: 'b' }], [{ spanIndex: 0, text: 'a' }], [{ spanIndex: -1, text: 'a' }], [{ spanIndex: 2, text: 'a' }], [{ spanIndex: 1, text: null }]])
    assert.throws(() => capturedEvaluationReferences({ references: [{ content }] }), /capture spans/);
});

const selectionFixture = () => ({ receiptIds: [1, 2, 3, 4, 5],
  generations: [{ receiptId: 1, references: [{ id: 'a', content: 'FIRST' }], output: { grounded: true, status: 'answered' } },
    { receiptId: 4, references: [{ id: 'b', content: 'LAST' }], output: { grounded: false } }],
  result: { grounded: true, status: 'partial', queryTrace: { answerGenerationIndex: 0, reviewedPartialFallback: true,
    reviews: [{ supported: true, answersQuestion: true }] } } });

test('reviewed partial fallback selects the actual first reference set without changing chronological attempts', () => {
  const actual = selectionFixture(), original = structuredClone(actual);
  assert.equal(selectedEvaluationGeneration(actual), actual.generations[0]);
  assert.equal(selectedEvaluationReferences(actual)[0].content, 'FIRST'); assert.deepEqual(actual, original);
});
test('default and latest explicit generation select last, and zero-generation local answers stay empty', () => {
  const actual = selectionFixture(); delete actual.result.queryTrace;
  assert.equal(selectedEvaluationGeneration(actual), actual.generations[1]);
  actual.result.queryTrace = { answerGenerationIndex: 1 };
  assert.equal(selectedEvaluationGeneration(actual), actual.generations[1]);
  assert.deepEqual(selectedEvaluationReferences({ generations: [], result: { queryMode: 'structured_field' } }), []);
});
test('an arbitrary, stale, unreviewed or nonpartial fallback generation is never accepted', () => {
  for (const change of [a => { a.result.queryTrace.answerGenerationIndex = 2; }, a => { a.result.queryTrace.answerGenerationIndex = -1; },
    a => { a.result.queryTrace.answerGenerationIndex = '0'; }, a => { a.result.queryTrace.answerGenerationIndex = null; },
    a => { a.result.queryTrace.answerGenerationIndex = undefined; }, a => { delete a.result.queryTrace.answerGenerationIndex; },
    a => { a.result.queryTrace.reviewedPartialFallback = false; },
    a => { a.result.status = 'answered'; }, a => { a.result.queryTrace.reviews[0].supported = false; },
    a => { a.result.queryTrace.reviews[0].answersQuestion = false; }, a => { a.generations[0].output.grounded = false; }]) {
    const actual = selectionFixture(); change(actual); assert.throws(() => selectedEvaluationGeneration(actual), /Evaluation/);
  }
});
test('selected generation is bounded by the real captured receipt mapping, not retrieval-round count', () => {
  for (const change of [a => { a.generations[0].receiptId = 99; }, a => { a.generations[1].receiptId = 1; },
    a => { a.generations.reverse(); }]) {
    const actual = selectionFixture(); change(actual); assert.throws(() => selectedEvaluationGeneration(actual), /receipt mapping/);
  }
  const actual = selectionFixture(); actual.generations.pop(); actual.result.queryTrace = { answerGenerationIndex: 0, rounds: [{}, {}] };
  assert.equal(selectedEvaluationGeneration(actual), actual.generations[0]);
  actual.result.queryTrace.reviewedPartialFallback = true; actual.result.queryTrace.reviews = [{ supported: true, answersQuestion: true }];
  assert.equal(selectedEvaluationGeneration(actual), actual.generations[0]);
});

test('task schema capture follows user JSON-object, provider JSON-schema or Ollama format without changing requests', () => {
  const schema = { required: ['unsupportedClaims'] }, request = { response_format: { json_schema: { schema } } };
  assert.deepEqual(capturedEvaluationSchema({}, { schema }), schema);
  assert.deepEqual(capturedEvaluationSchema(request, {}), schema);
  assert.deepEqual(capturedEvaluationSchema({ format: schema }, {}), schema);
  assert.deepEqual(capturedEvaluationSchema({ format: 'json' }, {}), {});
  assert.deepEqual(capturedEvaluationSchema(request, { schema: { required: ['queries'] } }), { required: ['queries'] });
});
