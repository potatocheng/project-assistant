import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ARMS, ALL_ARMS, LIMITS, hash, normalizedReferences, prepareCases, buildJobs,
  modelBody, anonymousOrder, answerView, buildJudge, parseJudge, requestReservation, validateUsage,
} from './memory-reader-diagnostic.mjs';

function inputs() {
  const paragraphs = [
    { id: 'intro', content: 'Introduction without the answer.', section: 'Introduction' },
    { id: 'answer-a', content: 'First relevant source paragraph.', section: 'Methods' },
    { id: 'long', content: '原文🙂'.repeat(4000), section: 'Results' },
    { id: 'answer-b', content: 'Second relevant source paragraph.', section: 'Discussion' },
  ];
  const queries = Array.from({ length: 20 }, (_, i) => ({
    id: `q${i}`, question: `Question ${i}?`, answerable: i < 19,
    expectedAnswers: [`PRIVATE_GOLD_ANSWER_${i}`],
    acceptableEvidenceSets: i < 19 ? [[['answer-b'], ['answer-a']], [['answer-a']]] : [],
  }));
  const receipts = [];
  const questions = queries.map((q, index) => ({
    id: q.id, question: q.question,
    entries: Object.fromEntries(['desktop', 'connector'].map((entry, entryIndex) => {
      const receiptId = index * 2 + entryIndex + 1;
      receipts.push({ index: receiptId, phase: 'qa', questionId: q.id, entry, requestSha256: hash(`request-${receiptId}`) });
      const references = [{ id: `first-${entry}`, content: `FIRST_GENERATION_${q.id}`, projectId: 'project', sourceTitle: 'Paper' }];
      return [entry, {
        result: { status: 'answered', answer: `Historical ${entry} ${q.id}`, claims: [] },
        generations: [
          { receiptId, references, rawReferences: [{ id: 'raw', content: [{ spanIndex: 1, text: references[0].content }] }] },
          { receiptId: 9999, references: [{ id: 'later', content: 'ANSWER_DEPENDENT_LATER_PACK' }] },
        ],
        finalProducerGenerations: [1],
      }];
    })),
  }));
  return {
    fixture: { documents: [{ id: 'paper', title: 'Paper', split: 'development', paragraphs, queries }] },
    historical: { documents: [{ id: 'paper', projectId: 'project', questions }], receipts,
      judgments: queries.map(q => ({ id: q.id, entries: { desktop: { answerCorrect: 'no' } } })) },
  };
}

test('neutral reference IDs preserve complete text and inherit only omitted metadata', () => {
  const original = [
    { memoryId: 'm1', referenceIndex: 7, projectId: 'p', sourceTitle: 'Title', content: '原文🙂'.repeat(4000) },
    { id: 's2', content: 'Missing common fields', evidence: [{ text: 'independent' }] },
    { id: 's3', projectId: null, sourceTitle: null, content: 'Explicitly unknown fields' },
  ];
  const before = structuredClone(original);
  const actual = normalizedReferences(original);
  assert.deepEqual(original, before);
  assert.deepEqual(actual.map(r => r.id), ['evidence-1', 'evidence-2', 'evidence-3']);
  assert.equal(actual[0].content, original[0].content);
  assert.equal(actual[0].memoryId, undefined);
  assert.equal(actual[0].referenceIndex, undefined);
  assert.equal(actual[1].projectId, 'p');
  assert.equal(actual[1].sourceTitle, 'Title');
  assert.equal(actual[2].projectId, null);
  assert.equal(actual[2].sourceTitle, null);
  actual[1].evidence[0].text = 'changed';
  assert.equal(original[1].evidence[0].text, 'independent');
});

test('invalid reference bodies and duplicate original identities fail before requests', () => {
  for (const references of [
    [{ id: 'a', content: '' }], [{ id: 'a', content: '  ' }],
    [{ id: 'a', content: [{ text: 'not restored' }] }], [{ content: 'missing identity' }],
    [{ id: 'a', content: 'one' }, { memoryId: 'a', content: 'two' }],
  ]) assert.throws(() => normalizedReferences(references));
});

test('normal arms freeze generation zero even when later generations produced the final answer', () => {
  const { fixture, historical } = inputs();
  const before = structuredClone({ fixture, historical });
  const cases = prepareCases(fixture, historical);
  assert.equal(cases.length, 20);
  for (const c of cases) for (const entry of ['desktop', 'connector']) {
    assert.equal(c.packs[`retrieved_${entry}`][0].content, `FIRST_GENERATION_${c.id}`);
    const source = historical.documents[0].questions.find(q => q.id === c.id).entries[entry].generations[0];
    const provenance = c.provenance[`retrieved_${entry}`];
    assert.equal(provenance.generationIndex, 0);
    assert.equal(provenance.receiptId, source.receiptId);
    assert.equal(provenance.originalReferencesSha256, hash(JSON.stringify(source.references)));
    assert.equal(provenance.rawReferencesSha256, hash(JSON.stringify(source.rawReferences)));
  }
  assert.deepEqual({ fixture, historical }, before);
});

test('annotated evidence is a document-ordered deduplicated union and unanswerable receives the full document', () => {
  const { fixture, historical } = inputs();
  const cases = prepareCases(fixture, historical);
  assert.deepEqual(cases[0].packs.annotated_passages.map(r => r.content), [
    'First relevant source paragraph.', 'Second relevant source paragraph.',
  ]);
  const all = fixture.documents[0].paragraphs.map(p => p.content);
  assert.deepEqual(cases[0].packs.full_document.map(r => r.content), all);
  assert.deepEqual(cases[19].packs.annotated_passages, cases[19].packs.full_document);
  assert.equal(cases[19].packs.full_document[2].content.length, '原文🙂'.repeat(4000).length);
  assert.equal(cases[19].goldParagraphs.length, 0);
});

test('reader jobs contain only question and evidence, never gold labels or historical grades', () => {
  const { fixture, historical } = inputs();
  const jobs = buildJobs(prepareCases(fixture, historical));
  assert.equal(jobs.length, 80);
  assert.equal(new Set(jobs.map(j => j.id)).size, 80);
  for (const job of jobs) {
    assert.deepEqual(Object.keys(job).sort(), ['id', 'question', 'references']);
    const wire = modelBody({ system: 'Production reader', input: { question: job.question, references: job.references } });
    const text = wire.messages[1].content;
    for (const secret of ['PRIVATE_GOLD_ANSWER', 'answerable', 'annotatedPolicy', 'historicalGrades', ...ARMS]) {
      assert.equal(text.includes(secret), false, secret);
    }
  }
});

test('missing question, absent gold, missing initial pack and invalid receipt provenance fail closed', () => {
  const mutations = [
    ({ historical }) => { historical.documents[0].questions[0].question = 'Different question'; },
    ({ fixture }) => { fixture.documents[0].queries[0].acceptableEvidenceSets = [[['absent']]]; },
    ({ fixture }) => { fixture.documents[0].queries[0].acceptableEvidenceSets = []; },
    ({ historical }) => { historical.documents[0].questions[0].entries.desktop.generations[0].references = []; },
    ({ historical }) => { historical.receipts[0].entry = 'connector'; },
    ({ historical }) => { historical.receipts[0].phase = 'extraction'; },
    ({ fixture }) => { fixture.documents[0].queries.pop(); },
  ];
  for (const mutate of mutations) {
    const data = inputs(); mutate(data);
    assert.throws(() => prepareCases(data.fixture, data.historical));
  }
});

test('model body preserves the production request and rejects evaluation-only keys at any depth', () => {
  const input = { question: 'Q?', references: [{ id: 'e1', content: 'full input' }] };
  const body = modelBody({ system: 'Exact production prompt', input, schema: { hidden: 'not a second prompt' } });
  assert.equal(body.messages[0].content, 'Exact production prompt');
  assert.deepEqual(JSON.parse(body.messages[1].content), input);
  assert.equal(body.max_tokens, LIMITS.outputTokens);
  assert.equal(body.stream, false);
  for (const key of ['expectedAnswers', 'humanAnswers', 'goldParagraphs', 'humanEvidenceAlternatives', 'acceptableEvidenceSets', 'answerCorrect']) {
    assert.throws(() => modelBody({ system: 'reader', input: { nested: { [key]: 'leak' } } }), /Evaluation labels/);
  }
});

test('all six answers are anonymously mapped and judge grades restore the exact arm identities', () => {
  const { fixture, historical } = inputs();
  const c = prepareCases(fixture, historical)[0];
  const normalized = new Map(ARMS.map(arm => [`${c.id}:${arm}`, {
    ok: true, result: { status: 'answered', answer: `Output ${arm}`, claims: [{ text: 'A fact', citationIds: ['private-id'] }] },
  }]));
  const { order, body } = buildJudge(c, normalized);
  assert.deepEqual(order, anonymousOrder(c.id));
  assert.deepEqual([...order].sort(), [...ALL_ARMS].sort());
  const input = JSON.parse(body.messages[1].content);
  assert.deepEqual(Object.keys(input.systems), ['system1', 'system2', 'system3', 'system4', 'system5', 'system6']);
  const systems = {};
  order.forEach((arm, i) => {
    assert.equal(input.systems[`system${i + 1}`].answer,
      arm.startsWith('historical_') ? `Historical ${arm.slice(11)} ${c.id}` : `Output ${arm}`);
    assert.equal(JSON.stringify(input.systems[`system${i + 1}`]).includes('private-id'), false);
    systems[`system${i + 1}`] = { answerCorrect: ['yes', 'partial', 'no', 'uncertain'][i % 4], reason: `Reason ${i}` };
  });
  const grades = parseJudge(JSON.stringify({ systems }), order);
  order.forEach((arm, i) => assert.deepEqual(grades[arm], systems[`system${i + 1}`]));
});

test('binding errors remain errors for the judge and cannot become correct abstentions', () => {
  assert.deepEqual(answerView(undefined, 'Invalid citation'), { error: 'Invalid citation', notRun: true });
  assert.deepEqual(answerView({ status: 'unknown', answer: ' ' }, 'Invalid citation'), { error: 'Invalid citation', notRun: true });
  assert.deepEqual(answerView({ status: 'unknown', answer: '' }), { answer: 'I cannot answer from the supplied evidence.' });
  assert.deepEqual(answerView({ status: 'unknown', answer: ' Explicit refusal. ' }), { answer: 'Explicit refusal.' });
});

test('judge schema rejects incomplete, extra, malformed and unsupported verdicts', () => {
  const order = anonymousOrder('q');
  const good = () => ({ systems: Object.fromEntries(order.map((_, i) => [`system${i + 1}`, { answerCorrect: 'yes', reason: 'Supported.' }])) });
  assert.throws(() => parseJudge('not JSON', order));
  for (const change of [
    x => { delete x.systems.system1; },
    x => { x.systems.system7 = { answerCorrect: 'yes', reason: 'extra' }; },
    x => { x.systems.system1.answerCorrect = 'correct'; },
    x => { x.systems.system1.reason = ' '; },
    x => { x.systems.unexpected = x.systems.system1; delete x.systems.system1; },
  ]) { const x = good(); change(x); assert.throws(() => parseJudge(JSON.stringify(x), order)); }
});

test('reservation accounts for UTF-8 bytes and the complete output allowance', () => {
  const body = { model: 'deepseek-flash', max_tokens: LIMITS.outputTokens, messages: [{ content: '中文🙂'.repeat(100) }] };
  assert.equal(requestReservation(body), Buffer.byteLength(JSON.stringify(body), 'utf8') + LIMITS.outputTokens + 512);
  assert.ok(requestReservation(body) > JSON.stringify(body).length + LIMITS.outputTokens + 512);
  assert.deepEqual(LIMITS, { requests: 100, totalTokens: 1600000, outputTokens: 4096, automaticRetries: 0 });
});

test('provider usage must be complete, internally consistent, within reservation and finished', () => {
  const good = () => ({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, choices: [{ finish_reason: 'stop' }] });
  assert.deepEqual(validateUsage(good(), 15), good().usage);
  for (const change of [
    x => { delete x.usage; }, x => { delete x.usage.total_tokens; },
    x => { x.usage.prompt_tokens = -1; }, x => { x.usage.total_tokens = 14; },
    x => { x.usage.prompt_tokens = 10.5; }, x => { x.choices[0].finish_reason = 'length'; },
  ]) { const x = good(); change(x); assert.throws(() => validateUsage(x, 15)); }
  assert.throws(() => validateUsage(good(), 14));
});
