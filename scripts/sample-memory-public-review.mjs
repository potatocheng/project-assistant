// Offline directed review samples. No model requests or workspace DB access.
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { readPublicLiveReport } from './memory-public-live-io.mjs';
import { firstLoss } from './score-memory-public-live.mjs';

const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const reportArgument = args.shift();
if (!reportArgument || reportArgument.startsWith('--')) throw new Error('Usage: node sample-memory-public-review.mjs REPORT [--count 30] [--dry-run]');
let count = 30, dryRun = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--dry-run' && !dryRun) dryRun = true;
  else if (args[i] === '--count' && args[i + 1] && !args[i + 1].startsWith('--')) {
    if (args.indexOf('--count') !== i) throw new Error('Duplicate --count');
    count = Number(args[++i]);
  } else throw new Error(`Unknown or duplicate option: ${args[i]}`);
}
if (!Number.isSafeInteger(count) || count < 1 || count > 300) throw new Error('--count must be 1..300');
const reportFile = path.resolve(reportArgument);
const report = await readPublicLiveReport(reportFile);
if (!report.complete || report.haltReason || report.fatalError) throw new Error('Export requires a complete, non-halted report');
if (report.paragraphControl) throw new Error('Use an actual extraction run, not the paragraph control');
const ignoredRoot = await realpath(path.join(root, '.local-data'));
const workspace = await realpath(path.resolve(root, report.workspace));
const relativeWorkspace = path.relative(ignoredRoot, workspace);
if (!relativeWorkspace || relativeWorkspace.startsWith('..') || path.isAbsolute(relativeWorkspace)) throw new Error('Review output must remain in this run under .local-data');
const output = path.join(workspace, 'review-sample.json');
const manifest = JSON.parse(await readFile(path.join(root, 'docs/memory-public-dataset-manifest.json')));
const fixtureBytes = await readFile(path.resolve(root, manifest.fixture));
const hash = value => createHash('sha256').update(value).digest('hex');
if (hash(fixtureBytes) !== report.datasetSha256) throw new Error('Frozen dataset fingerprint mismatch');
const fixture = JSON.parse(fixtureBytes);
const fixturePapers = new Map(fixture.documents.map(d => [d.id, d]));
const judgments = new Map(report.judgments.map(j => [j.id, j]));
const seed = `public-memory-directed-review-v1|${report.datasetSha256}`;
const stableKey = (stratum, item) => hash(`${seed}|${stratum}|${item.paper.id}|${item.id}`);
const tally = values => values.reduce((sum, value) => { sum[value] = (sum[value] ?? 0) + 1; return sum; }, {});
const usedMemories = new Set(), usedQuestions = new Set();

// Round-robin across deterministically ordered papers within each stratum.
// Candidate wording, source/gold answers and perceived quality never rank items.
function select(pool, desired, used, stratum) {
  const groups = new Map();
  for (const item of pool) {
    if (used.has(item.id)) continue;
    const group = groups.get(item.paper.id) ?? [];
    group.push(item); groups.set(item.paper.id, group);
  }
  const keys = [...groups.keys()].sort((a, b) => hash(`${seed}|${stratum}|${a}`).localeCompare(hash(`${seed}|${stratum}|${b}`)));
  for (const group of groups.values()) group.sort((a, b) => stableKey(stratum, a).localeCompare(stableKey(stratum, b)));
  const selected = [];
  while (selected.length < desired && keys.some(key => groups.get(key).length)) {
    for (const key of keys) {
      const item = groups.get(key).shift();
      if (!item) continue;
      used.add(item.id); selected.push({ ...item, selectedStratum: stratum });
      if (selected.length === desired) break;
    }
  }
  return selected;
}

const memoryPool = report.documents.flatMap(paper => {
  if (paper.extractionDrafts?.length) return paper.extractionDrafts.map(draft => ({ id: `draft:${paper.id}:${draft.id}`, paper, draft,
    stratum: draft.status === 'needs_review' ? 'needs_review' : ['ready', 'reviewed'].includes(draft.status)
      ? draft.issues?.some(i => i.field === 'topic' && i.severity === 'navigation') ? 'topic_isolated' : 'ready' : 'rejected' }));
  return (paper.memories ?? []).map(memory => ({ id: `memory:${paper.id}:${memory.id}`, paper, memory, stratum: 'ready' }));
});
const memoryTarget = Math.min(count, Math.round(count * 2 / 3));
const questionTarget = count - memoryTarget;
const reviewQuota = Math.floor(memoryTarget / 4), topicQuota = Math.floor(memoryTarget / 4);
const memoryRows = [];
for (const [stratum, desired] of [['needs_review', reviewQuota], ['topic_isolated', topicQuota], ['ready', memoryTarget - reviewQuota - topicQuota]]) {
  memoryRows.push(...select(memoryPool.filter(m => m.stratum === stratum), desired, usedMemories, stratum));
}
if (memoryRows.length < memoryTarget) memoryRows.push(...select(memoryPool.filter(m => ['ready', 'topic_isolated'].includes(m.stratum)), memoryTarget - memoryRows.length, usedMemories, 'ready_fallback'));
if (memoryRows.length < memoryTarget) memoryRows.push(...select(memoryPool.filter(m => m.stratum === 'needs_review'), memoryTarget - memoryRows.length, usedMemories, 'needs_review_fallback'));

const questionPool = report.documents.flatMap(paper => paper.questions.map(question => {
  const judgment = judgments.get(question.id);
  const labels = Object.fromEntries(['desktop', 'connector'].map(entry => [entry, {
    firstLoss: firstLoss(paper, question, judgment, entry),
    answerCorrect: judgment?.entries?.[entry]?.answerCorrect ?? null,
    retrievalSufficiency: judgment?.entries?.[entry]?.retrievalSufficiency ?? null,
    status: question.entries?.[entry]?.result?.status ?? null,
    grounded: question.entries?.[entry]?.result?.grounded ?? null,
    errorCode: question.entries?.[entry]?.errorCode ?? null,
  }]));
  const values = Object.values(labels), categories = [];
  if (values.some(v => v.firstLoss === 'success')) categories.push('success');
  if (values.some(v => v.firstLoss === 'retrieval_context_loss')) categories.push('retrieval_loss');
  if (question.answerable && ['no', 'partial'].includes(judgment?.memorySufficiency)) categories.push('memory_missing');
  if (values.some(v => v.status === 'partial' || v.answerCorrect === 'partial')) categories.push('partial');
  if (values.some(v => ['unknown', 'conflicted'].includes(v.status) || v.grounded === false)) categories.push('refusal');
  return { id: `question:${paper.id}:${question.id}`, paper, question, judgment, labels, categories };
}));
const questionRows = [];
const questionStrata = ['success', 'retrieval_loss', 'memory_missing', 'partial', 'refusal'];
for (let i = 0; i < questionStrata.length; i++) {
  const stratum = questionStrata[i];
  const desired = Math.floor(questionTarget / questionStrata.length) + (i < questionTarget % questionStrata.length ? 1 : 0);
  questionRows.push(...select(questionPool.filter(q => q.categories.includes(stratum)), desired, usedQuestions, stratum));
}
if (questionRows.length < questionTarget) questionRows.push(...select(questionPool, questionTarget - questionRows.length, usedQuestions, 'question_fallback'));

function sourceEvidence(paper, evidence) {
  const segments = new Map((paper.segments ?? []).map(s => [s.id, s]));
  const paragraphs = new Map((fixturePapers.get(paper.id)?.paragraphs ?? []).map(p => [p.id, p]));
  return (evidence ?? []).map(e => {
    const segment = segments.get(e.segmentId), paragraph = paragraphs.get(segment?.paragraphId);
    return { segmentId: e.segmentId, quote: e.quote, quoteIsExactSourceSubstring: segment ? segment.text.includes(e.quote) : null,
      paragraphId: segment?.paragraphId ?? null, sourceSegmentText: segment?.text ?? null,
      originalParagraph: paragraph ?? null };
  });
}
function memorySample(item) {
  const { paper, draft } = item;
  const memory = item.memory ?? paper.memories.find(m => m.proposalId === draft.proposalId);
  const candidate = draft?.candidate ?? { kind: memory.kind, content: memory.content, facets: memory.facets, evidence: memory.quotes ?? [] };
  return { sampleId: item.id, selectedStratum: item.selectedStratum, paperId: paper.id, paperTitle: paper.title, split: paper.split,
    draftId: draft?.id ?? null, proposalId: draft?.proposalId ?? memory?.proposalId ?? null, memoryId: memory?.id ?? null,
    generatedBody: candidate.content, currentFormalBody: memory?.detail?.memory?.content ?? memory?.content ?? null,
    kind: candidate.kind, originalFacets: candidate.facets ?? {}, acceptedFacets: draft?.facets ?? memory?.facets ?? {},
    originalIssues: draft?.issues ?? [], draftStatus: draft?.status ?? null,
    sourceEvidence: sourceEvidence(paper, candidate.evidence),
    automatedLabels: { draftStatus: draft?.status ?? null, hasConfirmedFormalMemory: !!memory, humanSemanticPrecisionLabel: null },
    humanAssessment: null };
}
function questionSample(item) {
  const { paper, question, judgment } = item;
  const gold = fixturePapers.get(paper.id)?.queries.find(q => q.id === question.id);
  const goldIds = new Set(gold?.acceptableEvidenceSets.flat(2) ?? []);
  const entries = Object.fromEntries(['desktop', 'connector'].map(entry => {
    const actual = question.entries?.[entry];
    const references = actual?.generations?.at(-1)?.references ?? [];
    const referenced = references.map(reference => {
      const memoryId = reference.memoryId ?? reference.id?.replace(/^memory:/, '');
      const memory = paper.memories.find(m => m.id === memoryId);
      return { id: reference.id ?? reference.memoryId, content: reference.content, facets: reference.facets ?? memory?.facets ?? {},
        sourceEvidence: sourceEvidence(paper, memory?.quotes ?? []) };
    });
    return [entry, { final: actual?.result ? { answer: actual.result.answer, status: actual.result.status, grounded: actual.result.grounded,
      claims: actual.result.claims, unknowns: actual.result.unknowns } : null, error: actual?.error ?? null,
      errorCode: actual?.errorCode ?? null, lastGenerationReferences: referenced }];
  }));
  return { sampleId: item.id, selectedStratum: item.selectedStratum, matchingStrata: item.categories, paperId: paper.id,
    paperTitle: paper.title, split: paper.split, questionId: question.id, question: question.question, answerable: question.answerable,
    humanDatasetAnswers: gold?.expectedAnswers ?? [], humanDatasetEvidenceAlternatives: gold?.acceptableEvidenceSets ?? [],
    sourceGoldParagraphs: fixturePapers.get(paper.id)?.paragraphs.filter(p => goldIds.has(p.id)) ?? [], entries,
    automatedLabels: { memorySufficiency: judgment?.memorySufficiency ?? null, entries: item.labels, judgment: judgment ?? null },
    humanAssessment: null };
}

const sample = { version: 'public-memory-directed-review-v1', createdAt: new Date().toISOString(),
  report: path.relative(root, reportFile), runWorkspace: path.relative(root, workspace), outputTag: report.outputTag,
  datasetSha256: report.datasetSha256, productionSha256: report.productionSha256, binarySha256: report.binarySha256,
  provenance: report.provenance ?? fixture.provenance,
  purpose: 'Directed stratified audit samples, not a probability sample or an estimate of overall extraction precision. No independent human assessment has been performed; every humanAssessment starts as null. Model judgments are shown as provisional labels, not ground truth.',
  sampling: { requestedCount: count, memoryTarget, questionTarget, seed, deterministic: true,
    memoryStrata: 'Default30:5 needs_review,5 topic_isolated,10 ready; shortages first fill from ready/topic_isolated, then needs_review. Rejected core evidence is not presented as confirmable memory.',
    questionStrata: 'Default30:2 distinct questions each for success, retrieval_loss, memory_missing, partial, refusal; mutually overlapping eligibility, unique selected questions. Missing strata fill from the remaining questions.',
    order: 'Stable SHA256 order with paper round-robin per stratum. Memory selection uses draft status/issues; question selection uses existing automatic outcome labels. Neither source/gold text nor perceived example quality ranks selection. Gold is attached only after selection for offline review.',
    memoryCounts: tally(memoryRows.map(m => m.selectedStratum)), questionCounts: tally(questionRows.map(q => q.selectedStratum)),
    actualMemoryCount: memoryRows.length, actualQuestionCount: questionRows.length,
    unmetQuestionStrata: questionStrata.filter(s => !questionRows.some(q => q.selectedStratum === s)),
  }, memories: memoryRows.map(memorySample), questions: questionRows.map(questionSample), humanReviewStatus: 'unreviewed' };
const summary = { output: path.relative(root, output), dryRun, requestedCount: count,
  actualCount: sample.memories.length + sample.questions.length, memoryCount: sample.memories.length, questionCount: sample.questions.length,
  memoryStrata: sample.sampling.memoryCounts, questionStrata: sample.sampling.questionCounts, missingQuestionStrata: sample.sampling.unmetQuestionStrata,
  selectionRules: sample.sampling.order, humanReviewStatus: sample.humanReviewStatus,
  license: sample.provenance?.license, citation: sample.provenance?.citation,
  warning: 'Directed samples; not population precision. Human assessment remains null. Full content is stored only in this ignored run directory.' };
if (!dryRun) await writeFile(output, JSON.stringify(sample, null, 2), { flag: 'wx' });
console.log(JSON.stringify(summary, null, 2));
