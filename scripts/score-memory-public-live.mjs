import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readPublicLiveReport } from './memory-public-live-io.mjs';
import { selectedEvaluationGeneration } from './capture-memory-evaluation-references.mjs';

// Paragraph links measure provenance. Full-paragraph visibility is stricter
// than necessary for answering; other valid evidence can also exist.
export function evidenceCoverage(doc, paper, question, entry) {
  if (!question.answerable) return null;
  const gold = doc.queries.find(q => q.id === question.id).acceptableEvidenceSets;
  const complete = ids => gold.some(set => set.every(alternatives => alternatives.some(id => ids.has(id))));
  const byId = new Map(paper.memories.map(m => [m.id, m]));
  const paragraphId = m => m?.paragraphId ?? paper.segments?.find(s => s.id === m?.quotes?.[0]?.segmentId)?.paragraphId;
  const linked = new Set(paper.memories.flatMap(m => (m.quotes ?? []).map(q => paper.segments?.find(s => s.id === q.segmentId)?.paragraphId)).filter(Boolean));
  const exactMemory = new Set(doc.paragraphs.filter(p => paper.memories.some(m => m.content.includes(p.content))).map(p => p.id));
  const visible = refs => {
    const ids = new Set(), whole = new Set();
    for (const r of refs) {
      const memoryId = r.memoryId ?? r.record?.memoryId ?? (r.id?.startsWith('memory:') ? r.id.slice(7) : r.id);
      const m = byId.get(memoryId), pid = paragraphId(m); if (!pid) continue;
      ids.add(pid);
      const p = doc.paragraphs.find(p => p.id === pid);
      if (p && String(r.content ?? '').includes(p.content)) whole.add(pid);
    }
    return { ids, whole };
  };
  const generations = question.entries[entry]?.generations ?? [];
  const selected = selectedEvaluationGeneration(question.entries[entry]);
  const last = visible(selected?.references ?? []);
  const lastAttempt = visible(generations.at(-1)?.references ?? []);
  return { formalMemoryEvidenceParagraphLinksComplete: complete(linked),
    originalGoldParagraphContentRetained: complete(exactMemory),
    lastGenerationGoldParagraphIdsComplete: complete(last.ids),
    lastGenerationWholeGoldParagraphsVisible: complete(last.whole),
    anyGenerationGoldParagraphIdsComplete: generations.some(g => complete(visible(g.references).ids)),
    selectedParagraphIds: [...last.ids], generations: generations.length,
    selectedGenerationIndex: selected ? generations.indexOf(selected) : null,
    generationSelection: question.entries[entry]?.result?.queryTrace?.reviewedPartialFallback === true ? 'reviewed_partial_fallback' : 'last_actual_attempt',
    lastAttemptGoldParagraphIdsComplete: complete(lastAttempt.ids), lastAttemptWholeGoldParagraphsVisible: complete(lastAttempt.whole),
    lastAttemptParagraphIds: [...lastAttempt.ids] };
}

export function firstLoss(paper, question, judgment, entry, coverage) {
  const value = question.entries?.[entry];
  if (!value) return 'not_run';
  // These losses are observable without asking a semantic judge.
  if (question.answerable && !paper.memories?.length && (paper.extraction?.job?.status === 'failed' || paper.extraction?.interrupted)) return 'extraction_job_failure';
  if (question.answerable && paper.memories?.length === 0) return 'memory_content_missing';
  if (!judgment || judgment.error) return 'judge_unavailable';
  const evaluation = judgment.entries?.[entry];
  if (!evaluation) return 'judge_unavailable';
  if (!question.answerable) return evaluation.answerCorrect === 'yes' && !value.error ? 'correct_abstention' : value.error ? 'answer_protocol_error' : 'incorrect_abstention_or_answer';
  if (evaluation.answerCorrect === 'yes' && !value.error) return 'success';
  if (paper.extraction?.diagnosticControl) {
    if (evaluation.answerCorrect === 'yes' && !value.error) return 'success';
    if (!coverage) return 'evidence_attribution_unavailable';
    if (!coverage.originalGoldParagraphContentRetained) return 'source_text_or_mapping_gap';
    if (!coverage.lastGenerationGoldParagraphIdsComplete) return 'retrieval_evidence_gap';
    if (!coverage.lastGenerationWholeGoldParagraphsVisible) return 'context_excerpt_gap';
    if (value.error) return 'answer_protocol_error';
    return evaluation.answerCorrect === 'uncertain' ? 'uncertain_answer' : 'answer_error_or_refusal';
  }
  if (judgment.memorySufficiency !== 'yes') return judgment.memorySufficiency === 'uncertain' ? 'uncertain_memory_coverage'
    : paper.extraction?.diagnosticControl ? 'source_text_or_gold_limit' : 'memory_content_missing';
  if (judgment.methodology === 'isolated-stage-v2' && !evaluation.retrievalSufficiency) return value.error ? 'answer_protocol_error' : 'retrieval_or_answer_not_separated';
  if (evaluation.retrievalSufficiency !== 'yes') return evaluation.retrievalSufficiency === 'uncertain' ? 'uncertain_retrieval' : 'retrieval_context_loss';
  if (value.error) return 'answer_protocol_error';
  if (evaluation.answerCorrect !== 'yes') return evaluation.answerCorrect === 'uncertain' ? 'uncertain_answer' : 'answer_error_or_refusal';
  return 'success';
}
const counts = values => values.reduce((sum, v) => { sum[v] = (sum[v] || 0) + 1; return sum; }, {});
const rate = (n, d) => ({ count: n, denominator: d, rate: d ? n / d : null });
const percentile = (values, p) => values.length ? [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)] : null;
export function summarize(report, fixture) {
  const cases = report.documents.flatMap(paper => paper.questions.flatMap(question => ['desktop', 'connector'].map(entry => {
    const judgment = report.judgments.find(j => j.id === question.id);
    const doc = fixture?.documents.find(d => d.id === paper.id);
    const coverage = doc ? evidenceCoverage(doc, paper, question, entry) : null;
    return { id: question.id, paperId: paper.id, split: paper.split, entry, answerable: question.answerable,
      firstLoss: firstLoss(paper, question, judgment, entry, coverage), coverage, value: question.entries[entry], judgment: judgment?.entries?.[entry], memorySufficiency: judgment?.memorySufficiency, judged: ['yes', 'partial', 'no', 'uncertain'].includes(judgment?.entries?.[entry]?.answerCorrect) };
  })));
  const summary = {};
  for (const split of ['all', 'development', 'holdout']) for (const entry of ['desktop', 'connector']) {
    const rows = cases.filter(c => c.entry === entry && (split === 'all' || c.split === split));
    const positives = rows.filter(c => c.answerable), negatives = rows.filter(c => !c.answerable);
    const memoryEnough = positives.filter(c => c.memorySufficiency === 'yes');
    const retrieved = memoryEnough.filter(c => c.judgment?.retrievalSufficiency === 'yes');
    const judged = rows.filter(c => c.judged);
    summary[`${split}:${entry}`] = {
      cases: rows.length, executed: rows.filter(c => c.value).length, judged: judged.length,
      answerable: positives.length, unanswerable: negatives.length,
      fullyCorrectAnswerable: rate(positives.filter(c => c.judgment?.answerCorrect === 'yes' && !c.value?.error).length, positives.length),
      partiallyCorrectAnswerable: rate(positives.filter(c => c.judgment?.answerCorrect === 'partial' && !c.value?.error).length, positives.length),
      correctAbstention: rate(negatives.filter(c => c.judgment?.answerCorrect === 'yes' && !c.value?.error).length, negatives.length),
      evidenceProvenance: fixture ? {
        originalGoldParagraphContentRetained: rate(positives.filter(c => c.coverage.originalGoldParagraphContentRetained).length, positives.length),
        lastGenerationGoldParagraphIdsComplete: rate(positives.filter(c => c.coverage.lastGenerationGoldParagraphIdsComplete).length, positives.length),
        lastGenerationWholeGoldParagraphsVisible: rate(positives.filter(c => c.coverage.lastGenerationWholeGoldParagraphsVisible).length, positives.length),
        answerGivenWholeGoldParagraphsVisible: rate(positives.filter(c => c.coverage.lastGenerationWholeGoldParagraphsVisible && c.judgment?.answerCorrect === 'yes' && !c.value?.error).length, positives.filter(c => c.coverage.lastGenerationWholeGoldParagraphsVisible).length),
      } : null,
      rawJudgeStageLabels: { excludedFromStageAttribution: report.version !== 'qasper-production-live-v2',
        reason: report.version === 'qasper-production-live-v2' ? 'Memory and answer judges receive isolated views; retrieval sufficiency is absent unless a third isolated judge ran. These remain automatic estimates.' : 'Inspection of judge reasons found joint judge conflating available full memories with missed retrieval/answer content. These labels are retained for audit only.',
        fullMemoryCoverage: rate(memoryEnough.length, positives.length),
        fullRetrievalCoverage: rate(positives.filter(c => c.judgment?.retrievalSufficiency === 'yes').length, positives.length),
        retrievalGivenSufficientMemory: rate(retrieved.length, memoryEnough.length),
        answerGivenSufficientMemoryAndReferences: rate(retrieved.filter(c => c.judgment?.answerCorrect === 'yes' && !c.value?.error).length, retrieved.length),
      },
      protocolErrors: counts(rows.filter(c => c.value?.error).map(c => c.value.errorCode || 'unknown')),
      firstLoss: counts(positives.map(c => c.firstLoss)), scopeViolations: rows.filter(c => c.value?.scopeViolation).length,
      unsupportedFinalAnswers: judged.some(c => c.judgment?.claimsSupported) ? judged.filter(c => !c.value?.error && c.value?.result?.grounded && c.judgment?.claimsSupported === 'no').length : null,
      claimsSupportEvaluation: judged.some(c => c.judgment?.claimsSupported) ? 'automatic_estimate' : 'not_run',
      p50Ms: percentile(rows.map(c => c.value?.elapsedMs).filter(Number.isFinite), .5),
      p95Ms: percentile(rows.map(c => c.value?.elapsedMs).filter(Number.isFinite), .95),
    };
  }
  return { judgeMode: report.judgeMode || 'legacy-joint', outputTag: report.outputTag, methodology: 'Mutually exclusive observed loss, not causal proof. All answerable cases stay in accuracy denominators; missing/uncertain judges never count as correct. Answer correctness is same-model post-hoc judgment, not independently validated. Joint judge memory/retrieval labels were found confounded and excluded from stage attribution. Paragraph control attribution uses actual gold paragraph links/full text. Missing one gold set does not prove no equivalent evidence existed, and whole paragraph visibility does not prove sufficient reading. Organization errors are not separately blamed without evidence from facet ablation.',
    paragraphControl: report.paragraphControl ?? false, complete: report.complete, summary,
    extraction: { papers: report.documents.length, statuses: counts(report.documents.map(d => d.extraction?.job?.status || 'not_run')),
      errorCodes: counts(report.documents.filter(d => d.extraction?.job?.errorCode).map(d => d.extraction.job.errorCode)),
      drafts: counts(report.documents.flatMap(d => (d.extractionDrafts ?? []).map(x => x.status || 'unknown'))),
      formalMemories: report.documents.reduce((n, d) => n + d.memories.length, 0),
      discarded: report.documents.reduce((n, d) => n + (d.extraction?.job?.discardedCount || 0), 0),
      qaReadOnly: report.documents.every(d => d.qaReadOnly === true),
      harnessErrors: report.documents.filter(d => d.harnessError).map(d => ({ id: d.id, error: d.harnessError })) },
    judgeErrors: report.judgments.filter(j => j.error).map(j => ({ id: j.id, error: j.error })),
    cases: cases.map(({ value, judgment, ...c }) => ({ ...c, errorCode: value?.errorCode, status: value?.result?.status, answerCorrect: judgment?.answerCorrect, retrievalSufficiency: judgment?.retrievalSufficiency })),
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const input = path.resolve(process.argv[2] || 'docs/memory-public-live-results.json');
  const output = path.resolve(process.argv[3] || 'docs/memory-public-live-summary.json');
  const root = path.resolve(import.meta.dirname, '..');
  const manifest = JSON.parse(await readFile(path.join(root, 'docs/memory-public-dataset-manifest.json')));
  const fixture = JSON.parse(await readFile(path.resolve(root, manifest.fixture)));
  const result = summarize(await readPublicLiveReport(input), fixture);
  await writeFile(output, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ extraction: result.extraction, summary: result.summary, judgeErrors: result.judgeErrors }));
}
