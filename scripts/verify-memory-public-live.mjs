// Offline integrity checks, no API requests. Run after both live runs finish.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { readPublicLiveReport } from './memory-public-live-io.mjs';
import { validateIsolatedJudgment, wrapFlatAnswerSystems } from './memory-public-live-judges.mjs';
const root = path.resolve(import.meta.dirname, '..');
const hash = v => createHash('sha256').update(v).digest('hex');
const manifest = JSON.parse(await readFile(path.join(root, 'docs/memory-public-dataset-manifest.json')));
const fixtureBytes = await readFile(path.resolve(root, manifest.fixture));
assert.equal(hash(fixtureBytes), manifest.datasetSha256);
const fixture = JSON.parse(fixtureBytes), results = [];
const requested = process.argv.slice(2).filter(x => !x.startsWith('--'));
for (const file of requested.length ? requested : ['docs/memory-public-live-results.json', 'docs/memory-public-live-control-results.json']) {
  const reportPath = path.resolve(root, file);
  const reportBytes = await readFile(reportPath);
  const report = await readPublicLiveReport(reportPath);
  const selectedDocuments = fixture.documents.filter(d => !report.split || report.split === 'all' || d.split === report.split);
  const expectedQuestions = selectedDocuments.reduce((n, d) => n + d.queries.length, 0);
  const expectedSegments = selectedDocuments.reduce((n, d) => n + d.paragraphs.length, 0);
  assert.equal(report.complete, true); assert.equal(report.haltReason, null);
  assert.equal(report.datasetSha256, manifest.datasetSha256);
  assert.equal(report.productionUnchanged, true);
  const snapshot = path.join(root, report.productionSnapshot || path.join(report.workspace, 'production'));
  assert.equal(hash(await readFile(path.join(snapshot, process.platform === 'win32' ? 'pm-host.exe' : 'pm-host'))), report.binarySha256);
  for (const [name, sha] of Object.entries(report.productionSha256)) assert.equal(hash(await readFile(path.join(snapshot, name))), sha);
  if (report.evaluationSha256) {
    assert.equal(report.evaluationUnchanged, true);
    const evaluationSnapshot = path.join(root, report.evaluationSnapshot);
    for (const [name, sha] of Object.entries(report.evaluationSha256)) assert.equal(hash(await readFile(path.join(evaluationSnapshot, name))), sha);
  }
  const transcript = await readFile(path.join(root, report.workspace, 'receipts.jsonl'));
  if (process.env.DEEPSEEK_API_KEY) {
    assert.equal(reportBytes.includes(process.env.DEEPSEEK_API_KEY), false);
    assert.equal(transcript.includes(process.env.DEEPSEEK_API_KEY), false);
  }
  const raw = transcript.toString('utf8').trim().split('\n').map(JSON.parse), seen = new Set();
  assert.equal(raw.length, report.receipts.length);
  for (const r of raw) {
    assert.equal(seen.has(r.index), false); seen.add(r.index);
    const meta = report.receipts.find(x => x.index === r.index);
    assert.ok(meta); assert.equal(r.requestSha256, hash(JSON.stringify(r.request)));
    assert.equal(r.status, 200); assert.equal(r.request.model, report.model);
    const upstream = JSON.parse(r.responseText);
    assert.equal(upstream.model, r.actualModel); assert.equal(upstream.usage.total_tokens, r.usage.total_tokens);
    const input = JSON.parse(r.request.messages.at(-1).content);
    if (r.phase !== 'judge') {
      for (const key of ['humanAnswers', 'goldParagraphs', 'humanEvidenceAlternatives', 'acceptableEvidenceSets', 'expectedAnswers']) assert.equal(Object.hasOwn(input, key), false);
      const paper = report.documents.find(d => d.id === r.paperId); assert.ok(paper);
      if (r.task === 'extraction') {
        const segmentIds = new Set(paper.segments.map(s => s.id));
        assert.ok(input.segments.every(s => segmentIds.has(s.id)));
      } else {
        const question = paper.questions.find(q => q.id === r.questionId); assert.ok(question);
        if (r.task === 'generation') assert.equal(input.question ?? input.context?.question, question.question.trim());
      }
    }
  }
  for (const repair of report.evaluationSyntaxRepairs ?? []) {
    const receipt = raw.find(r => r.index === repair.receiptId);
    assert.ok(receipt); assert.equal(receipt.phase, 'judge'); assert.equal(receipt.finishReason, 'stop');
    const phase = repair.phase ?? repair.stage;
    assert.equal(receipt.questionId, repair.questionId); assert.equal(receipt.judgeStage, phase);
    const original = JSON.parse(receipt.responseText).choices[0].message.content;
    assert.equal(repair.appended, '}'); assert.equal(hash(original), repair.originalSha256);
    assert.equal(hash(original + '}'), repair.repairedSha256);
    assert.throws(() => JSON.parse(original), SyntaxError);
    const paper = report.documents.find(d => d.id === repair.paperId);
    const recovered = validateIsolatedJudgment({ phase }, JSON.parse(original + '}'), new Set(paper.memories.map(m => m.id)));
    assert.deepEqual(report.judgments.find(j => j.id === repair.questionId).stages[phase], recovered);
  }
  for (const record of report.evaluationEnvelopeNormalizations ?? []) {
    const receipt = raw.find(r => r.index === record.receiptId);
    assert.ok(receipt); assert.equal(receipt.phase, 'judge'); assert.equal(receipt.finishReason, 'stop');
    assert.equal(record.stage, 'answer'); assert.equal(receipt.judgeStage, 'answer');
    assert.equal(receipt.questionId, record.questionId); assert.equal(receipt.paperId, record.paperId);
    assert.equal(record.kind, 'wrap-flat-answer-systems'); assert.equal(record.addedField, 'systems'); assert.equal(record.modelRequests, 0);
    const originalText = JSON.parse(receipt.responseText).choices[0].message.content;
    assert.equal(hash(originalText), record.originalSha256);
    const original = JSON.parse(originalText);
    const normalized = wrapFlatAnswerSystems(original);
    assert.deepEqual(normalized.systems, original);
    assert.equal(hash(JSON.stringify(normalized)), record.normalizedSha256);
    const recovered = validateIsolatedJudgment({ phase: 'answer' }, normalized, new Set());
    assert.deepEqual(report.judgments.find(j => j.id === record.questionId).stages.answer, recovered);
  }
  let questions = 0, segments = 0, facts = 0;
  for (const d of report.documents) {
    const doc = fixture.documents.find(p => p.id === d.id); assert.ok(doc);
    assert.equal(d.qaReadOnly, true); assert.equal(d.harnessError, undefined);
    assert.equal(d.segments.length, doc.paragraphs.length); segments += d.segments.length;
    for (const p of doc.paragraphs) {
      const s = d.segments.find(s => s.paragraphId === p.id); assert.ok(s);
      assert.equal(s.text.trimEnd(), `[[QASPER:${p.id}]] ${p.content.replace(/[\r\n]+/g, ' ')}`.trimEnd());
    }
    assert.equal(d.questions.length, doc.queries.length);
    for (const q of d.questions) {
      questions++;
      assert.ok(doc.queries.some(g => g.id === q.id && g.question === q.question && g.answerable === q.answerable));
      for (const entry of ['desktop', 'connector']) { assert.ok(q.entries[entry]); assert.equal(q.entries[entry].scopeViolation, false); }
    }
    for (const draft of d.extractionDrafts ?? []) {
      if (draft.status === 'needs_review') { assert.equal(draft.proposalId, null); assert.equal(d.memories.some(m => m.proposalId && m.proposalId === draft.proposalId), false); }
      if (draft.proposalId && d.memories.some(m => m.proposalId === draft.proposalId)) assert.ok(['ready', 'reviewed'].includes(draft.status));
    }
    for (const m of d.memories) {
      facts++;
      assert.ok(m.quotes?.length > 0);
      assert.ok(m.quotes.every(q => d.segments.some(s => s.id === q.segmentId && s.text.includes(q.quote))));
      if (!report.paragraphControl) {
        assert.equal(m.content, m.detail.memory.content);
        assert.deepEqual(m.facets, m.detail.revisions.find(r => r.number === 1 || r.facets)?.facets);
      }
    }
    for (const j of report.judgments.filter(j => j.paperId === d.id && !j.error)) {
      assert.ok(j.relevantMemoryIds.every(id => d.memories.some(m => m.id === id)));
      assert.ok(j.organizationIssues.every(i => d.memories.some(m => m.id === i.memoryId)));
    }
  }
  assert.equal(questions, expectedQuestions); assert.equal(segments, expectedSegments);
  assert.equal(report.documents.length, selectedDocuments.length);
  assert.equal(new Set(report.judgments.map(j => j.id)).size, expectedQuestions);
  assert.ok(raw.length <= report.limits.requests);
  if (report.version === 'qasper-production-live-v2') assert.equal(report.judgments.some(j => j.error), false);
  const totalTokens = raw.reduce((n, r) => n + r.usage.total_tokens, 0);
  assert.equal(totalTokens, report.usage.total_tokens);
  results.push({ file, sha256: hash(reportBytes), transcriptSha256: hash(transcript), requests: raw.length, totalTokens, questions, segments, formalMemories: facts, rejectedJudgeOutputs: report.judgments.filter(j => j.error).length, passed: true });
}
if (!requested.length) assert.ok(results.reduce((n, r) => n + r.requests, 0) <= 1200);
// Observed usage, not a reservation of tokens for in-flight requests.
const summary = { checkedAt: new Date().toISOString(), checks: ['frozen dataset/source/binary hashes', 'no key in reports/transcripts', 'unique receipt indices/request hashes/provider usage', 'gold absent from production input envelope', 'complete paragraph provenance', 'both entries and project scope', 'unchanged confirmed facts/facets', 'read-only QA', 'strict judge memory ID whitelist', 'shared request budget'], results };
const output = requested.length === 1 ? path.resolve(root, requested[0]).replace(/-results\.json$/, '-integrity.json') : path.join(root, requested.length ? 'docs/memory-public-live-selected-integrity.json' : 'docs/memory-public-live-integrity.json');
if (requested.length === 1 && output === path.resolve(root, requested[0])) throw new Error('Integrity report must not overwrite its input');
if (!process.argv.includes('--no-write')) await writeFile(output, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
