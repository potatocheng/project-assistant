// Read-only reporting of this round. No provider requests or Engine writes.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readPublicLiveReport } from './memory-public-live-io.mjs';
import { buildOptimizedMetrics, assessOptimizedExecution } from './report-memory-extraction-optimized.mjs';
import { selectedEvaluationGeneration } from './capture-memory-evaluation-references.mjs';
import { verifyRecordedBudget } from './memory-public-live-budget.mjs';

const root = path.resolve(import.meta.dirname, '..');
const entries = ['desktop', 'connector'];
const name = { desktop: '桌面', connector: '飞书问答' };
const stable = value => JSON.stringify(value, (_, v) => v && !Array.isArray(v) && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const relative = file => path.relative(root, file).replaceAll('\\', '/');
const count = values => values.reduce((s, v) => { s[v ?? 'missing'] = (s[v ?? 'missing'] ?? 0) + 1; return s; }, {});
const table = (headers, rows) => [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map(row => `| ${row.map(v => String(v ?? '—').replaceAll('|', '\\|').replaceAll('\n', ' ')).join(' | ')} |`)].join('\n');
const rate = value => !value?.denominator ? '不适用' : `${value.count}/${value.denominator}（${(value.rate * 100).toFixed(1)}%）`;
const counts = value => Object.entries(value ?? {}).map(([k, v]) => `${k}: ${v}`).join('；') || '无';
const questionsOf = report => (report?.documents ?? []).flatMap(p => p.questions.map(q => ({ ...q, paperId: p.id, split: p.split })));
const percentile = (values, p) => values.length ? [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)] : null;
const tokenChange = fraction => fraction == null ? '比例未测' : `${fraction >= 0 ? '减少' : '增加'}${(Math.abs(fraction) * 100).toFixed(1)}%`;
const protocolFailureCode = code => /GROUNDING|SCHEMA|CLAIM_BINDING|MODEL_(?:JSON|RESPONSE|OUTPUT|INCOMPLETE|TOOLS)/.test(code ?? '');

export function markdownObservation(value, maxChars = 300) {
  if (!Number.isSafeInteger(maxChars) || maxChars < 80) throw new Error('Markdown observation limit must be at least 80 characters');
  const serialized = JSON.stringify(value) ?? String(value);
  if (serialized.length <= maxChars) return serialized;
  const description = Array.isArray(value) ? `数组（${value.length}项）` : value && typeof value === 'object'
    ? `对象（${Object.keys(value).length}字段：${Object.keys(value).slice(0, 6).map(key => key.slice(0, 24)).join('、')}${Object.keys(value).length > 6 ? '…' : ''}）`
    : `长文本（${serialized.length}字符）`;
  const suffix = `；原值${serialized.length}字符，完整值见机器JSON`;
  return description.slice(0, maxChars - suffix.length) + suffix;
}

export function observedScopeLimitation(fullProvided, scope) {
  return fullProvided ? '- 9道无答案题样本很小，拒答改进或退化均单列；不得混入91道可答题准确率。'
    : `- 本轮仅执行固定${scope.questions}题开发集（${scope.answerable}道可答、${scope.unanswerable}道无答案）；三次复测没有增加不同问题样本。完整100题预设的91道可答/9道无答案均尚未执行，不能当作本轮已观测分母，全部全量质量与拒答指标未测。`;
}

export function retrievalOperationalMetrics(report, allowedIds) {
  const questions = questionsOf(report).filter(q => !allowedIds || allowedIds.has(q.id));
  const ids = new Set(questions.map(q => q.id));
  return Object.fromEntries(entries.map(entry => {
    const receipts = report.receipts.filter(r => r.phase === 'qa' && r.entry === entry && ids.has(r.questionId));
    const current = questions.map(q => ({ question: q, value: q.entries?.[entry] }));
    const trace = v => v?.result?.queryTrace;
    const refuses = v => !!v?.result && !v.error && (v.result.grounded === false || ['unknown', 'conflicted'].includes(v.result.status));
    const latencies = current.map(({ value }) => value?.elapsedMs).filter(Number.isFinite);
    return [entry, { questions: questions.length, executed: current.filter(x => !!x.value).length,
      requests: receipts.length, requestStages: count(receipts.map(r => r.task)),
      inputTokens: receipts.reduce((n, r) => n + (r.usage?.prompt_tokens ?? 0), 0),
      outputTokens: receipts.reduce((n, r) => n + (r.usage?.completion_tokens ?? 0), 0),
      reportedTokens: receipts.reduce((n, r) => n + (r.usage?.total_tokens ?? 0), 0),
      missingUsageRequests: receipts.filter(r => !Number.isFinite(r.usage?.total_tokens)).length,
      p50Ms: percentile(latencies, .5), p95Ms: percentile(latencies, .95),
      supplementPlanningQuestions: new Set(receipts.filter(r => r.task === 'query_rewrite').map(r => r.questionId)).size,
      actualSupplementGenerationQuestions: questions.filter(q => receipts.filter(r => r.questionId === q.id && r.task === 'generation').length > 1).length,
      tracedExtraRetrievalRounds: current.reduce((n, { value }) => n + Math.max(0, (trace(value)?.rounds?.length ?? 1) - 1), 0),
      finalStatusCounts: count(current.map(({ value }) => value?.error ? 'error' : value?.result?.status ?? 'not_run')),
      answerableRefusals: current.filter(({ question, value }) => question.answerable && refuses(value)).length,
      unanswerableRefusals: current.filter(({ question, value }) => !question.answerable && refuses(value)).length,
      anyRejectedReviewQuestions: current.filter(({ value }) => trace(value)?.reviews?.some(r => r && (r.supported === false || r.answersQuestion === false))).length,
      reviewedPartialFallbackQuestions: current.filter(({ value }) => trace(value)?.reviewedPartialFallback === true).length,
      selectedGenerationIndices: count(current.map(({ value }) => trace(value)?.answerGenerationIndex).filter(v => Number.isSafeInteger(v))),
      unchangedContextSkippedQuestions: current.filter(({ value }) => trace(value)?.supplementStatus === 'UNCHANGED_CONTEXT').length,
      supplementStatusCounts: count(current.map(({ value }) => trace(value)?.supplementStatus).filter(Boolean)),
      supplementFailureCodes: count(current.map(({ value }) => trace(value)?.supplementStatus).filter(s => s && s !== 'UNCHANGED_CONTEXT')),
      reviewUnavailableCodes: count(current.flatMap(({ value }) => (trace(value)?.reviews ?? [])
        .filter(review => review?.status === 'unavailable').map(review => review.errorCode ?? 'missing_error_code'))),
      reviewProtocolFailureQuestions: current.filter(({ value }) => trace(value)?.reviews?.some(review => review?.status === 'unavailable'
        && protocolFailureCode(review.errorCode))).length,
      supplementProtocolFailureQuestions: current.filter(({ value }) => protocolFailureCode(trace(value)?.supplementStatus)
        || trace(value)?.reviews?.some((review, round) => round >= 1 && review?.status === 'unavailable' && protocolFailureCode(review.errorCode))).length,
    }];
  }));
}

export function retrievalSplitSummaries(report, baseline, comparison) {
  return Object.fromEntries(['development', 'holdout'].map(split => {
    const ids = new Set(questionsOf(report).filter(q => q.split === split).map(q => q.id));
    return [split, { questions: ids.size, previousOriginal: originalRetrievalSnapshot(baseline, ids),
      current: originalRetrievalSnapshot(report, ids), paired: Object.fromEntries(entries.map(entry => [entry, comparison.summary[`${split}:${entry}`]])),
      previousOperations: retrievalOperationalMetrics(baseline, ids), currentOperations: retrievalOperationalMetrics(report, ids) }];
  }));
}

export function originalRetrievalSnapshot(report, allowedIds) {
  const questions = questionsOf(report).filter(q => !allowedIds || allowedIds.has(q.id));
  const positive = questions.filter(q => q.answerable), negative = questions.filter(q => !q.answerable);
  const judges = new Map(report.judgments.map(j => [j.id, j]));
  const metric = (n, d) => ({ count: n, denominator: d, rate: d ? n / d : null });
  const validGrade = (q, e) => !q.entries?.[e]?.error && judges.get(q.id)?.entries?.[e]?.answerCorrect === 'yes';
  return { answerable: positive.length, unanswerable: negative.length,
    memoryLabels: count(positive.map(q => judges.get(q.id)?.memorySufficiency)),
    outcomes: Object.fromEntries(entries.map(e => [e, {
      complete: metric(positive.filter(q => validGrade(q, e)).length, positive.length),
      abstention: metric(negative.filter(q => validGrade(q, e)).length, negative.length),
      referencesSufficient: metric(positive.filter(q => judges.get(q.id)?.entries?.[e]?.retrievalSufficiency === 'yes').length, positive.length),
    }])) };
}

export function retrievalQuestionRows(current, previous) {
  const previousQuestions = new Map(questionsOf(previous).map(q => [q.id, q]));
  const oldJudges = new Map(previous.judgments.map(j => [j.id, j]));
  const newJudges = new Map(current.judgments.map(j => [j.id, j]));
  return questionsOf(current).flatMap(q => entries.map(entry => {
    const old = previousQuestions.get(q.id), before = oldJudges.get(q.id), after = newJudges.get(q.id);
    if (!old || old.question !== q.question || old.answerable !== q.answerable || old.paperId !== q.paperId) throw new Error('Previous/current question identity changed');
    const originalCorrect = !old.entries?.[entry]?.error && before?.entries?.[entry]?.answerCorrect === 'yes';
    const pairedCorrect = !old.entries?.[entry]?.error && after?.baselineEntries?.[entry]?.answerCorrect === 'yes';
    const currentCorrect = !q.entries?.[entry]?.error && after?.entries?.[entry]?.answerCorrect === 'yes';
    return { id: q.id, paperId: q.paperId, split: q.split, entry, answerable: q.answerable,
      previousOriginalAnswer: before?.entries?.[entry]?.answerCorrect ?? 'not_judged', previousPairedAnswer: after?.baselineEntries?.[entry]?.answerCorrect ?? 'not_judged', currentAnswer: after?.entries?.[entry]?.answerCorrect ?? 'not_judged',
      previousError: old.entries?.[entry]?.errorCode ?? null, currentError: q.entries?.[entry]?.errorCode ?? null,
      previousOriginalCorrect: originalCorrect, previousPairedCorrect: pairedCorrect, currentCorrect,
      pairedChange: currentCorrect ? pairedCorrect ? 'retained_success' : 'new_success' : pairedCorrect ? 'regression' : 'still_unsuccessful',
      originalChange: currentCorrect ? originalCorrect ? 'retained_success' : 'new_success' : originalCorrect ? 'regression' : 'still_unsuccessful',
      previousMemory: before?.memorySufficiency ?? 'not_judged', currentMemory: after?.memorySufficiency ?? 'not_judged',
      previousReferences: before?.entries?.[entry]?.retrievalSufficiency ?? 'not_judged', currentReferences: after?.entries?.[entry]?.retrievalSufficiency ?? 'not_judged',
      previousStatus: old.entries?.[entry]?.result?.status ?? 'error_or_missing', currentStatus: q.entries?.[entry]?.result?.status ?? 'error_or_missing',
      previousGenerationCount: old.entries?.[entry]?.generations?.length ?? 0, currentGenerationCount: q.entries?.[entry]?.generations?.length ?? 0,
    };
  }));
}

export function assessRetrievalExecution(input) {
  const result = assessOptimizedExecution(input);
  const { dev, gate, full, registration } = input;
  const sameEvaluationRules = full ? !!dev.evaluationSha256 && stable(full.evaluationSha256) === stable(dev.evaluationSha256) && dev.evaluationUnchanged === true && full.evaluationUnchanged === true : null;
  const gateEvaluationMatches = !!gate?.evaluationSha256 && stable(gate.evaluationSha256) === stable(dev.evaluationSha256);
  const registrationHashMatchesGate = !!input.registrationSha256 && input.registrationSha256 === gate?.registration?.sha256;
  const registrationMatchesGate = !!registration && !!gate?.registration && stable(registration.thresholds) === stable(gate.registration.thresholds) && registration.registeredAt === gate.registration.registeredAt;
  const gatePrecedesFull = full ? Number.isFinite(Date.parse(gate?.recordedAt)) && Date.parse(gate.recordedAt) <= Date.parse(full.startedAt) : null;
  const budgetAuthorizationMatches = dev.budgetAuthorization ? stable(dev.budgetAuthorization) === stable(gate?.budgetAuthorization)
    && (!full || stable(full.budgetAuthorization) === stable(dev.budgetAuthorization)) : !gate?.budgetAuthorization && !full?.budgetAuthorization;
  const productionStayedFrozen = full ? dev.productionUnchanged === true && full.productionUnchanged === true : null;
  return { ...result, sameEvaluationRules, registrationMatchesGate, registrationHashMatchesGate, gateEvaluationMatches, gatePrecedesFull,
    budgetAuthorizationMatches, productionStayedFrozen,
    fullAuthorizedWithFrozenRules: !!full && result.fullComplete === true && result.fullGateMatches === true && productionStayedFrozen === true && sameEvaluationRules === true && registrationMatchesGate && registrationHashMatchesGate && gateEvaluationMatches && gatePrecedesFull === true && budgetAuthorizationMatches };
}

export function selectInitialPilotGate(explicitGate, verifiedGate) {
  if (explicitGate && verifiedGate && stable(explicitGate) !== stable(verifiedGate)) throw new Error('Explicit initial gate differs from verified prior ledger gate');
  return verifiedGate ?? explicitGate ?? null;
}

export function assessObservedRunBudget(run, limits) {
  return { requests: run.usage.requests, reportedTokens: run.usage.reportedTokens, limits,
    withinRequestLimit: run.usage.requests <= limits.maxRequests, withinTokenLimit: run.usage.reportedTokens <= limits.maxTokens };
}

export function summarizeEnvelopeNormalizations(report) {
  const records = report.evaluationEnvelopeNormalizations ?? [];
  return { count: records.length, additionalApiRequests: 0, additionalTokens: 0, records,
    methodology: 'Only wrap exact complete flat answer system1/system2 JSON inside systems; preserve all four labels/reasons and anonymous mapping. Raw receipts and both hashes retained. Never a semantic re-evaluation.' };
}

export function distinctRetrievalRunUsage(runs) {
  const byWorkspace = new Map();
  for (const run of runs.filter(Boolean)) {
    const previous = byWorkspace.get(run.workspace);
    if (previous && (previous.usage.requests !== run.usage.requests || previous.usage.reportedTokens !== run.usage.reportedTokens)) throw new Error('Conflicting observed cost for the same workspace');
    byWorkspace.set(run.workspace, run);
  }
  const distinct = [...byWorkspace.values()];
  return { distinctRuns: distinct.length, requests: distinct.reduce((n, r) => n + r.usage.requests, 0),
    reportedTokens: distinct.reduce((n, r) => n + r.usage.reportedTokens, 0),
    workspaces: distinct.map(r => r.workspace), note: 'Counts each provided run artifact once, including failed development pilots. Full is counted only when its artifact is supplied; previous-round baselines are excluded. A prior-run shared limit is not deducted from actual observed usage.' };
}

export function summarizeDevelopmentBudget(runs, registration, authorization) {
  const usage = distinctRetrievalRunUsage(runs), originalLimits = registration.limits.development;
  const limits = authorization?.effectiveDevelopmentLimits ?? originalLimits;
  return { ...usage, note: 'Every provided development workspace billed once, including all failed pilots; full100 and previous-round baselines excluded.',
    originalLimits, limits, extensionUsed: !!authorization, authorization: authorization ?? null,
    withinRequestLimit: usage.requests <= limits.maxRequests, withinTokenLimit: usage.reportedTokens <= limits.maxTokens,
    withinOriginalRequestLimit: usage.requests <= originalLimits.maxRequests, withinOriginalTokenLimit: usage.reportedTokens <= originalLimits.maxTokens };
}

export function summarizeQaEfficiency(previous, current) {
  const sum = (values, field) => ['desktop', 'connector'].reduce((n, e) => n + values[e][field], 0);
  const previousTokens = sum(previous, 'reportedTokens'), currentTokens = sum(current, 'reportedTokens');
  return { previousRequests: sum(previous, 'requests'), currentRequests: sum(current, 'requests'), previousTokens, currentTokens,
    savedTokens: previousTokens - currentTokens, reductionFraction: previousTokens ? 1 - currentTokens / previousTokens : null,
    methodology: 'All actual QA generation/review/rewrite provider token usage, including unsuccessful attempts and safe fallback work. Extraction and evaluator calls are excluded here and included separately in total real usage.' };
}

export function reviewCalibrationMetrics(report, allowedIds) {
  const questions = questionsOf(report).filter(q => !allowedIds || allowedIds.has(q.id));
  const judges = new Map(report.judgments.map(j => [j.id, j]));
  const validReview = review => !!review && typeof review.supported === 'boolean' && typeof review.answersQuestion === 'boolean'
    && Array.isArray(review.unsupportedClaims) && Array.isArray(review.missingAspects) && typeof review.reason === 'string';
  return Object.fromEntries(entries.map(entry => {
    const rows = questions.map(question => {
      const actual = question.entries?.[entry], trace = actual?.result?.queryTrace;
      const selected = selectedEvaluationGeneration(actual), selectedIndex = selected ? actual.generations.indexOf(selected) : null;
      const questionReceipts = report.receipts.filter(r => r.phase === 'qa' && r.entry === entry && r.questionId === question.id);
      // Reviews follow retrieval rounds; a local first round may have no model generation.
      const selectedReviewIndex = selected ? questionReceipts.filter(r => r.task === 'query_rewrite' && r.index < selected.receiptId).length : null;
      const selectedReview = selectedReviewIndex == null ? null : trace?.reviews?.[selectedReviewIndex];
      const finalGrounded = !actual?.error && actual?.result?.grounded === true;
      const rawUnknowns = Array.isArray(selected?.output?.unknowns) ? selected.output.unknowns : [];
      const unknownsCleared = finalGrounded && rawUnknowns.length > 0 && Array.isArray(actual.result.unknowns) && actual.result.unknowns.length === 0;
      const completeReviewed = finalGrounded && validReview(selectedReview) && selectedReview.supported === true
        && selectedReview.answersQuestion === true && selectedReview.completeAnswer === true;
      const selectedUnknownDecisions = Array.isArray(selectedReview?.unknownDecisions) ? selectedReview.unknownDecisions : null;
      const selectedObligations = Array.isArray(selectedReview?.obligations) ? selectedReview.obligations : null;
      const reviewReceipts = questionReceipts.filter(r => r.task === 'answer_review');
      const selectedReviewReceipt = selected ? reviewReceipts.find(r => r.index > selected.receiptId
        && !(actual.generations ?? []).some(g => g.receiptId > selected.receiptId && g.receiptId < r.index))?.index ?? null : null;
      return { id: question.id, split: question.split, answerable: question.answerable, selectedGenerationIndex: selectedIndex, selectedReviewIndex,
        generationReceiptId: selected?.receiptId ?? null, reviewReceiptId: selectedReviewReceipt,
        receiptIds: actual?.receiptIds ?? [], rawUnknowns, finalUnknowns: actual?.result?.unknowns ?? null,
        finalGrounded, finalStatus: actual?.result?.status ?? null,
        answerCorrect: actual?.error ? 'protocol_error' : judges.get(question.id)?.entries?.[entry]?.answerCorrect ?? 'not_judged',
        unknownsCleared, completeReviewed, selectedUnknownDecisions, selectedObligations,
        selectedReviewNormalization: selectedReview?.normalization ?? null,
        selectedEffectiveStatus: selectedReview?.effectiveStatus ?? null,
        selectedRawReview: selectedReview?.rawReview ?? null,
        reviews: (trace?.reviews ?? []).filter(validReview), humanAssessment: null };
    });
    const reviews = rows.flatMap(row => row.reviews), cleared = rows.filter(row => row.unknownsCleared);
    const completeReviewed = rows.filter(row => row.completeReviewed), decisionRows = rows.filter(row => row.selectedUnknownDecisions);
    const cases = values => values.map(({ reviews: _reviews, ...row }) => row);
    return [entry, { validReviews: reviews.length, completeAnswerTrueReviews: reviews.filter(r => r.completeAnswer === true).length,
      selectedRawUnknownsCleared: cleared.length, selectedRawUnknownsClearedOutcomes: count(cleared.map(row => row.answerCorrect)),
      completeReviewedFinalGrounded: completeReviewed.length, completeReviewedFinalGroundedOutcomes: count(completeReviewed.map(row => row.answerCorrect)),
      unknownsClearedCases: cases(cleared), completeReviewedNotFullyCorrectCases: cases(completeReviewed.filter(row => row.answerCorrect !== 'yes')),
      obligationReviewCount: reviews.filter(review => Array.isArray(review.obligations)).length,
      obligationStatusCounts: count(reviews.flatMap(review => review.obligations ?? []).map(value => value.status)),
      unknownDecisionReviewCount: reviews.filter(review => Array.isArray(review.unknownDecisions)).length,
      unknownDispositionCounts: count(reviews.flatMap(review => review.unknownDecisions ?? []).map(value => value.disposition)),
      selectedUnknownDecisionEntries: decisionRows.length,
      selectedUnknownDispositionCounts: count(decisionRows.flatMap(row => row.selectedUnknownDecisions).map(value => value.disposition)),
      selectedPartialUnknownRemovalEntries: decisionRows.filter(row => row.finalGrounded && row.selectedUnknownDecisions.some(value => value.disposition === 'retain')
        && row.selectedUnknownDecisions.some(value => ['unasked', 'answered'].includes(value.disposition))).length,
      selectedUnknownDecisionCases: cases(decisionRows),
      normalizationCounts: count(reviews.map(review => review.normalization).filter(Boolean)),
      rawReviewPreservedReviews: reviews.filter(review => validReview(review.rawReview)).length,
      effectiveStatusCounts: count(reviews.map(review => review.effectiveStatus).filter(Boolean)),
      rawCoarseAnsweredWithExplicitGapsReviews: reviews.filter(review => {
        const raw = review.rawReview;
        return Array.isArray(raw?.obligations) && raw.obligations.length > 0 && raw.obligations.every(value => value.status === 'answered')
          && ((raw.missingAspects?.length ?? 0) > 0 || raw.unknownDecisions?.some(value => value.disposition === 'retain'));
      }).length,
      selectedNormalizationCases: cases(rows.filter(row => row.selectedReviewNormalization)),
      methodology: 'Post-hoc trace audit only: valid review means structured supported/answersQuestion flags, unsupportedClaims/missingAspects arrays and reason. Unknowns-cleared requires nonempty raw unknowns in the producer-selected actual generation, a final grounded result and an explicitly empty final unknowns array. Automatic answer labels are retained without human adjudication.' }];
  }));
}

export function classifyInitialPilot(run, gate) {
  return { executionComplete: run.complete === true, gatePassed: gate?.passed ?? null,
    kind: run.complete !== true ? 'execution_or_evaluation_incomplete' : gate?.passed === false ? 'registered_development_threshold_failed' : gate?.passed === true ? 'passed' : 'gate_not_provided',
    failedChecks: gate?.checks?.filter(check => !check.passed) ?? [] };
}

export function assessFullTargets(run, targets) {
  const checks = [];
  const add = (name, actual, required, lowerIsBetter = false) => checks.push({ name, actual, required,
    passed: Number.isFinite(actual) && Number.isFinite(required) && (lowerIsBetter ? actual <= required : actual >= required) });
  for (const entry of entries) {
    add(`${entry}_complete`, run.outcomes[entry].completeCorrect.count, targets[`${entry}Complete`]);
    add(`${entry}_references_sufficient`, run.outcomes[entry].fullRetrieval.count, targets[`${entry}ReferencesSufficient`]);
    add(`${entry}_correct_abstention`, run.outcomes[entry].correctAbstention.count, targets[`${entry}CorrectAbstention`]);
  }
  add('combined_qa_tokens', run.qaEfficiency.currentTokens, targets.maxCombinedQaTokens, true);
  return { allTargetsMet: checks.every(check => check.passed), checks,
    methodology: 'Registered before first live call; report every failed full-run target without changing its threshold. These are full100 reporting targets, separate from development permission.' };
}

export function developmentReviewQueue(report) {
  const hypotheses = {};
  const judges = new Map(report.judgments.map(j => [j.id, j]));
  return questionsOf(report).filter(q => q.answerable).flatMap(q => {
    const judge = judges.get(q.id);
    const affected = entries.filter(entry => judge?.entries?.[entry]?.retrievalSufficiency === 'yes'
      && (q.entries?.[entry]?.error || judge?.entries?.[entry]?.answerCorrect !== 'yes'));
    if (!affected.length) return [];
    return [{ id: q.id, paperId: q.paperId, entries: affected,
      receiptIds: [...new Set(affected.flatMap(entry => q.entries?.[entry]?.receiptIds ?? []))].sort((a, b) => a - b),
      hypothesis: Object.entries(hypotheses).find(([prefix]) => q.id.startsWith(prefix))?.[1] ?? '参考被自动判充分而最终答案未完整正确，需人工核查目标理解、完整性与评分口径。',
      humanAssessment: null, status: 'pending_independent_review' }];
  });
}

async function buildRun(report, baseline, fixture) {
  const run = await buildOptimizedMetrics(report, baseline, baseline, fixture);
  delete run.paragraphControlMatched;
  const paperIds = new Set(report.documents.map(d => d.id));
  const previousReceipts = baseline.receipts.filter(r => paperIds.has(r.paperId));
  const previousUsage = Object.fromEntries(['all', 'extraction', 'qa', 'judge'].map(phase => {
    const receipts = previousReceipts.filter(r => phase === 'all' || r.phase === phase);
    return [phase, { requests: receipts.length, reportedTokens: receipts.reduce((n, r) => n + (r.usage?.total_tokens ?? 0), 0) }];
  }));
  const previousOperations = retrievalOperationalMetrics(baseline, new Set(questionsOf(report).map(q => q.id)));
  const operations = retrievalOperationalMetrics(report);
  return { ...run, previousOriginal: originalRetrievalSnapshot(baseline, new Set(questionsOf(report).map(q => q.id))), previousUsage,
    evaluationEnvelopeNormalizations: summarizeEnvelopeNormalizations(report),
    questionComparison: retrievalQuestionRows(report, baseline), evaluationSha256: report.evaluationSha256,
    previousOperations, operations, qaEfficiency: summarizeQaEfficiency(previousOperations, operations), reviewCalibration: reviewCalibrationMetrics(report),
    budgetAuthorization: report.budgetAuthorization ?? null, priorBudgetLedger: report.priorBudgetLedger ?? null,
    splits: retrievalSplitSummaries(report, baseline, run.pairedComparison),
    isolatedJudgeDisagreementCases: report.judgments.flatMap(j => entries.filter(e => j.memorySufficiency !== 'yes' && j.entries?.[e]?.retrievalSufficiency === 'yes')
      .map(entry => ({ id: j.id, entry, memory: j.memorySufficiency, references: 'yes' }))),
    evaluationUnchanged: report.evaluationUnchanged,
    extractionSourceUnchangedFromPrevious: Object.fromEntries(['ai.rs', 'extraction_store.rs'].map(file => [file, report.productionSha256[file] === baseline.productionSha256[file]])) };
}

function runMarkdown(label, run) {
  const old = run.previousOriginal, e = run.extraction;
  const lines = [`## ${label}`, '', `${run.scope.papers}篇/${run.scope.questions}题，可答${run.scope.answerable}、无答案${run.scope.unanswerable}。完整执行：${run.complete ? '是' : '否'}。`, '',
    table(['环节', '上一轮原始结果', '本轮结果'], [
      ['提取成功', `${run.pairedComparison.extraction.before.statuses.succeeded ?? 0}/${run.pairedComparison.extraction.before.papers}`, `${e.jobStatuses.succeeded ?? 0}/${run.scope.papers}`],
      ['正式记忆', run.pairedComparison.extraction.before.formalMemories, e.formalMemories],
      ['信息保留yes / partial / no', counts(old.memoryLabels), counts(run.retainedMemoryContent?.labels)],
      ...entries.flatMap(entry => [
        [`${name[entry]}参考充分`, rate(old.outcomes[entry].referencesSufficient), rate(run.outcomes[entry].fullRetrieval)],
        [`${name[entry]}完整正确`, rate(old.outcomes[entry].complete), rate(run.outcomes[entry].completeCorrect)],
        [`${name[entry]}无答案正确拒答`, rate(old.outcomes[entry].abstention), rate(run.outcomes[entry].correctAbstention)],
      ]),
    ]), '',
    '### 同次匿名配对与评分漂移', '',
    table(['入口', '上一轮原始完整正确', '本轮重新评分旧答案', '本轮新答案', '配对新增 / 退化', '无答案旧配对 / 本轮'], entries.map(entry => {
      const p = run.pairedComparison.summary[`all:${entry}`];
      return [name[entry], rate(old.outcomes[entry].complete), rate(p.beforeFullyCorrect), rate(p.afterFullyCorrect), `${p.answerableChanges.new_success ?? 0} / ${p.answerableChanges.regression ?? 0}`, `${rate(p.beforeCorrectAbstention)} / ${rate(p.afterCorrectAbstention)}`];
    })), '', '原始旧评分与本次配对旧评分可能不同；两个结果均保留，不用新评分覆盖旧工件。提取重新运行，记忆正文与组织字段仍可能漂移，因此端到端差值不是检索模块的独立因果效应。', '',
    '### 阶段损失与上下文组装', '',
    table(['入口', '第一处观测损失', '参考充分时答对', '有充分记忆时参考充分', '错误码', 'p50 / p95毫秒'], entries.map(entry => {
      const r = run.outcomes[entry];
      return [name[entry], counts(run.observedFirstLoss[entry]), rate(r.answerGivenFullShownEvidence), rate(r.retrievalGivenFullMemory), counts(r.allErrors), `${r.p50Ms ?? '未测'} / ${r.p95Ms ?? '未测'}`];
    })), '',
    `待审核草稿${e.scopeNeedsReview}条；未审草稿进入正式记忆${e.unreviewedFormalMemories}条。正式记忆数量和逐字来源校验不能代替语义精确率；该指标仍未独立人工标注。`, '',
    '### 成本与恢复记录', '',
    `组合QA token：${run.qaEfficiency.previousTokens}→${run.qaEfficiency.currentTokens}，${tokenChange(run.qaEfficiency.reductionFraction)}；实际请求${run.qaEfficiency.previousRequests}→${run.qaEfficiency.currentRequests}。该项不含提取和评分，但所有实际阶段费用均在下表及总用量中保留。`, '',
    table(['入口', '旧→新QA请求', '旧→新QA token', '旧→新p50/p95毫秒', '旧→新实际补查生成题数', '旧→新可答题拒答数', '旧→新无答案题拒答数'], entries.map(entry => {
      const a = run.previousOperations[entry], b = run.operations[entry];
      return [name[entry], `${a.requests}→${b.requests}`, `${a.reportedTokens}→${b.reportedTokens}`, `${a.p50Ms}/${a.p95Ms}→${b.p50Ms}/${b.p95Ms}`, `${a.actualSupplementGenerationQuestions}→${b.actualSupplementGenerationQuestions}`, `${a.answerableRefusals}→${b.answerableRefusals}`, `${a.unanswerableRefusals}→${b.unanswerableRefusals}`];
    })), '',
    '这里“拒答数”是生产最终grounded/status观测，不等于正确拒答数；正确性在独立无答案分母中另计。“实际补查生成”须至少两次真实generation请求，不能把仅规划或空改写算作补查。', '',
    table(['入口', '旧→新规划补查题数', '旧→新额外检索轮数', '旧→新任一审查拒绝题数', '旧→新补查失败码'], entries.map(entry => {
      const a = run.previousOperations[entry], b = run.operations[entry];
      return [name[entry], `${a.supplementPlanningQuestions}→${b.supplementPlanningQuestions}`, `${a.tracedExtraRetrievalRounds}→${b.tracedExtraRetrievalRounds}`, `${a.anyRejectedReviewQuestions}→${b.anyRejectedReviewQuestions}`, `${counts(a.supplementFailureCodes)}→${counts(b.supplementFailureCodes)}`];
    })), '', '补查失败可被生产流程安全转换为unknown或退回已核验partial，因此不能只看顶层error或supplementStatus；下表同时读取各检索轮的review unavailable。', '',
    table(['入口', '旧→新review unavailable代码', '旧→新协议review失败题数', '旧→新补查协议失败题数（入口并集）'], entries.map(entry => {
      const a = run.previousOperations[entry], b = run.operations[entry];
      return [name[entry], `${counts(a.reviewUnavailableCodes)}→${counts(b.reviewUnavailableCodes)}`,
        `${a.reviewProtocolFailureQuestions}→${b.reviewProtocolFailureQuestions}`, `${a.supplementProtocolFailureQuestions}→${b.supplementProtocolFailureQuestions}`];
    })), '',
    table(['入口', '旧→新已核验partial回退', '旧→新相同上下文跳过', '本轮generation选择索引'], entries.map(entry => [name[entry], `${run.previousOperations[entry].reviewedPartialFallbackQuestions}→${run.operations[entry].reviewedPartialFallbackQuestions}`, `${run.previousOperations[entry].unchangedContextSkippedQuestions}→${run.operations[entry].unchangedContextSkippedQuestions}`, counts(run.operations[entry].selectedGenerationIndices)])), '',
    'UNCHANGED_CONTEXT表示复验后跳过重复生成，单列为节省行为，不当成补查失败。安全partial回退仍按实际所有尝试计费，并按producer选中的真实generation参考做检索评分。某分支观测次数为0时，不能把token下降归因于该分支；本报告未做逐机制因果消融。', '',
    '### 审查校准（事后审计）', '',
    table(['入口', '有效review', 'completeAnswer=true', '选中raw unknowns被清空', '清空后自动答案标签', 'complete审查后最终grounded答案标签'], entries.map(entry => {
      const c = run.reviewCalibration[entry];
      return [name[entry], c.validReviews, c.completeAnswerTrueReviews, c.selectedRawUnknownsCleared, counts(c.selectedRawUnknownsClearedOutcomes), counts(c.completeReviewedFinalGroundedOutcomes)];
    })), '',
    table(['入口', '逐目标review', '目标状态', '逐unknown review', '全部模型unknown处置', '选中review的模型unknown处置', 'grounded且保留/移除并存'], entries.map(entry => {
      const c = run.reviewCalibration[entry];
      return [name[entry], c.obligationReviewCount, counts(c.obligationStatusCounts), c.unknownDecisionReviewCount,
        counts(c.unknownDispositionCounts), counts(c.selectedUnknownDispositionCounts), c.selectedPartialUnknownRemovalEntries];
    })), '',
    table(['入口', '保守规范化', '保留rawReview数', 'effectiveStatus', 'raw义务全answered但仍有明确缺项'], entries.map(entry => {
      const c = run.reviewCalibration[entry];
      return [name[entry], counts(c.normalizationCounts), c.rawReviewPreservedReviews, counts(c.effectiveStatusCounts), c.rawCoarseAnsweredWithExplicitGapsReviews];
    })), '',
    '0结构协议失败不等于0模型语义或逻辑不一致。第二次开发前的生产修复只允许将结构完整、supported/answersQuestion为true、completeAnswer为false且有明确retain/missing的粗粒度矛盾审查保守保留为partial；不得升级完整答案或删除必要未知。normalization、effectiveStatus和未改写的rawReview均保留，逐unknown处置另列。首轮pilot原有2个协议失败仍保留，不用新解析或新规范化回填。', '',
    '逐unknown统计仅读取本轮保存的obligations/unknownDecisions；未含这些字段的旧schema记为未提供，不推造处理结论。disposition与claimIndices是模型审查产物，尚未人工评定；不能把unasked/answered标签视为事实正确证明。原始unknown顺序和处置索引均保留，最终unknown还可能合并missingAspects，因此不按数组长度差推断每条语义是否解决。', '',
    '有效review按保存的结构字段计数，null或不完整记录不计；unknowns清空要求实际选中generation原有非空unknowns、最终grounded=true且最终unknowns显式为空。completeAnswer=true不是独立的完整性证明：审查也可能把未回答目标当作背景，或把事实暗示当作直接结论。下列自动非完整标签与unknowns处理案例仅供事后人工复核，不据此修改分数或判定人工错误；完整原始unknowns和逐例收据保存在机器JSON。', '',
    table(['题号', '入口', '选中generation', '生成/审查收据', 'unknowns清空', '自动答案标签', '人工评定'], entries.flatMap(entry => {
      const c = run.reviewCalibration[entry];
      return [...new Map([...c.unknownsClearedCases, ...c.completeReviewedNotFullyCorrectCases].map(row => [row.id, row])).values()]
        .map(row => [row.id, name[entry], row.selectedGenerationIndex, `${row.generationReceiptId ?? '未捕获'}/${row.reviewReceiptId ?? '未捕获'}`, row.unknownsCleared ? '是' : '否', row.answerCorrect, '未做']);
    })), '',
    table(['阶段', '上一轮请求/token', '本轮请求/token'], ['all', 'extraction', 'qa', 'judge'].map(phase => {
      const old = run.previousUsage[phase];
      const current = phase === 'all' ? { requests: run.usage.requests, totalTokens: run.usage.reportedTokens } : Object.entries(run.usage.byPhase)
        .filter(([key]) => key === phase || key.startsWith(`${phase}:`)).reduce((sum, [, value]) => ({ requests: sum.requests + value.requests, totalTokens: sum.totalTokens + value.totalTokens }), { requests: 0, totalTokens: 0 });
      return [phase, `${old.requests} / ${old.reportedTokens}`, `${current.requests} / ${current.totalTokens}`];
    })), '',
    table(['阶段', '请求', '输入token', '输出token', '总token', '缺usage请求', '累计请求毫秒'], Object.entries(run.usage.byPhase).map(([phase, u]) => [phase, u.requests, u.inputTokens, u.outputTokens, u.totalTokens, u.missingUsageRequests, u.sumRequestElapsedMs])), '',
    `本轮${run.usage.requests}次真实请求，${run.usage.reportedTokens}个已报告token，墙钟${run.usage.wallClockMs == null ? '未测' : `${(run.usage.wallClockMs / 60000).toFixed(1)}分钟`}。并发请求耗时不可相加当墙钟。计费金额未估算。`, '',
    `评分API格式重评${run.evaluationRepairs.extraRequests}次、${run.evaluationRepairs.extraReportedTokens}token；当前评分错误${run.evaluationRepairs.currentJudgeErrorQuestions}题。已收到评分JSON末尾单个右括号恢复${run.evaluationSyntaxRepairs.repairs}条，额外调用0，完整审计保存在机器JSON与原始收据。`, '',
    `完整flat answer系统外层无损规范化${run.evaluationEnvelopeNormalizations.count}条，额外调用0、额外token为0。只增加systems包装，不更改已有标签、理由或匿名映射；原始与规范JSON的SHA256及收据ID保留在机器JSON。`, '',
    `memory-only未判yes而retrieval-only判yes的隔离评分分歧${run.isolatedJudgeDisagreementCases.length}个入口案例。${run.isolatedJudgeDisagreementCases.length ? '它提示评分不一致，不能据此断言“未存储的信息被检索出来”或作严格因果归因。逐例ID保存在机器JSON。' : '本次未发现这类隔离评分分歧。'}`, '',
    '### 逐题对比', '',
    table(['题号', '入口', '可答', '旧原始/旧配对/本轮答案', '旧/新正文保留', '旧/新参考充分', '配对变化', '旧/新状态', '旧/新生成次数'], run.questionComparison.map(r => [r.id, name[r.entry], r.answerable ? '是' : '否', `${r.previousOriginalAnswer}/${r.previousPairedAnswer}/${r.currentAnswer}`, `${r.previousMemory}/${r.currentMemory}`, `${r.previousReferences}/${r.currentReferences}`, r.pairedChange, `${r.previousStatus}/${r.currentStatus}`, `${r.previousGenerationCount}/${r.currentGenerationCount}`])), '',
  ];
  return lines.join('\n');
}

function fullOverviewMarkdown(run) {
  const old = run.previousOriginal, extractionBefore = run.pairedComparison.extraction.before;
  const rows = [
    ['提取成功', `${extractionBefore.statuses.succeeded ?? 0}/${extractionBefore.papers}`, `${run.extraction.jobStatuses.succeeded ?? 0}/${run.scope.papers}`],
    ['正式记忆', extractionBefore.formalMemories, run.extraction.formalMemories],
    ['正文充分 / 部分保留', `${old.memoryLabels.yes ?? 0} / ${old.memoryLabels.partial ?? 0}`, `${run.retainedMemoryContent?.labels.yes ?? 0} / ${run.retainedMemoryContent?.labels.partial ?? 0}`],
    ...entries.flatMap(entry => [
      [`${name[entry]}生成参考充分`, rate(old.outcomes[entry].referencesSufficient), rate(run.outcomes[entry].fullRetrieval)],
      [`${name[entry]}完整正确`, rate(old.outcomes[entry].complete), rate(run.outcomes[entry].completeCorrect)],
      [`${name[entry]}无答案正确拒答`, rate(old.outcomes[entry].abstention), rate(run.outcomes[entry].correctAbstention)],
      [`${name[entry]}生产QA请求 / token`, `${run.previousOperations[entry].requests} / ${run.previousOperations[entry].reportedTokens}`, `${run.operations[entry].requests} / ${run.operations[entry].reportedTokens}`],
    ]),
  ];
  const lines = ['## 完整100题前后总览', '', `${run.scope.answerable}道可答题与${run.scope.unanswerable}道无答案题分开计分。下表旧值保留上一轮原始评分；同次匿名配对重新评分在下一表另列。`, '', table(['环节', '上一轮原始', '本轮'], rows), '',
    `组合QA token ${run.qaEfficiency.previousTokens}→${run.qaEfficiency.currentTokens}，${tokenChange(run.qaEfficiency.reductionFraction)}；生产QA调用${run.qaEfficiency.previousRequests}→${run.qaEfficiency.currentRequests}。这是100题观测结果，开发放行门槛使用独立20题原始QA基线，不相互替代。`, '',
    table(['入口', '旧原始完整正确', '同次重评旧答案', '本轮完整正确', '配对净增题数', '配对新增 / 退化'], entries.map(entry => {
      const p = run.pairedComparison.summary[`all:${entry}`];
      return [name[entry], rate(old.outcomes[entry].complete), rate(p.beforeFullyCorrect), rate(p.afterFullyCorrect), p.afterFullyCorrect.count - p.beforeFullyCorrect.count, `${p.answerableChanges.new_success ?? 0} / ${p.answerableChanges.regression ?? 0}`];
    })), '',
    '### 同一次100题运行中的开发20题与固定回归80题', '',
    table(['集合 / 入口', '题数（可答/无答案）', '旧原始完整正确', '配对旧答案→本轮', '旧→新参考充分', '旧→新正确拒答'], ['development', 'holdout'].flatMap(split => entries.map(entry => {
      const s = run.splits[split], a = s.previousOriginal.outcomes[entry], b = s.current.outcomes[entry], p = s.paired[entry];
      return [`${split === 'development' ? '开发20' : '固定回归80'} / ${name[entry]}`, `${s.questions}（${s.current.answerable}/${s.current.unanswerable}）`, rate(a.complete), `${rate(p.beforeFullyCorrect)}→${rate(p.afterFullyCorrect)}`, `${rate(a.referencesSufficient)}→${rate(b.referencesSufficient)}`, `${rate(a.abstention)}→${rate(b.abstention)}`];
    }))), '',
    '这两组来自同一个完整100题工件，不把单独开发运行的20题分数拼入100题。80题此前已看过，继续作为固定回归，不能称为未见盲测。生产上限保持不变，需结合实际QA调用、token和延迟看收益。', '',
  ];
  return lines.join('\n');
}

export async function generateRetrievalReport(options) {
  for (const [key, expected] of [['markdown', 'memory-qa-calibrated-report.md'], ['metrics', 'memory-qa-calibrated-metrics.json']]) {
    if (path.dirname(options[key]) !== path.join(root, 'docs') || path.basename(options[key]) !== expected) throw new Error('Only dedicated retrieval-round report outputs are permitted');
  }
  const registrationBytes = await readFile(path.join(root, 'docs/memory-qa-calibrated-preregistration.json'));
  const registration = JSON.parse(registrationBytes);
  for (const baseline of [registration.baselineDevelopment, registration.baselineFull]) if (hash(await readFile(path.resolve(root, baseline.file))) !== baseline.sha256) throw new Error('Previous round baseline fingerprint changed');
  const fixtureBytes = await readFile(path.resolve(root, JSON.parse(await readFile(path.join(root, 'docs/memory-public-dataset-manifest.json'))).fixture));
  if (hash(fixtureBytes) !== registration.datasetSha256) throw new Error('Frozen fixture changed');
  const fixture = JSON.parse(fixtureBytes);
  const [dev, baselineDev, baselineFull, gate, regressions] = await Promise.all([
    readPublicLiveReport(options.dev), readPublicLiveReport(path.resolve(root, registration.baselineDevelopment.file)), readPublicLiveReport(path.resolve(root, registration.baselineFull.file)),
    JSON.parse(await readFile(options.gate)), JSON.parse(await readFile(options.regressions)),
  ]);
  const full = options.full ? await readPublicLiveReport(options.full) : null;
  const budgetEvidence = await verifyRecordedBudget(root, dev);
  if (full) await verifyRecordedBudget(root, full);
  const priorReports = [];
  for (const entry of budgetEvidence.ledger?.entries ?? []) {
    const report = await readPublicLiveReport(path.resolve(root, entry.file));
    let failedGate = null;
    const failedGateFile = entry.file.replace(/-results\.json$/, '-gate.json');
    try { failedGate = JSON.parse(await readFile(path.resolve(root, failedGateFile))); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    priorReports.push({ file: entry.file, sha256: entry.sha256, report, gateFile: failedGateFile, gate: failedGate });
  }
  const explicitInitial = options.initialDev ? await readPublicLiveReport(options.initialDev) : null;
  if (explicitInitial && budgetEvidence.ledger && !priorReports.some(value => value.report.workspace === explicitInitial.workspace)) throw new Error('Explicit pilot is absent from verified cumulative prior ledger');
  if (explicitInitial && !priorReports.some(value => value.report.workspace === explicitInitial.workspace)) priorReports.push({ file: relative(options.initialDev), report: explicitInitial });
  const initialDev = priorReports[0]?.report ?? null;
  let initialGate = null;
  if (options.initialGate) { try { initialGate = JSON.parse(await readFile(options.initialGate)); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  initialGate = selectInitialPilotGate(initialGate, priorReports[0]?.gate);
  for (const [report, previous, expected] of [[dev, baselineDev, registration.baselineDevelopment], ...(full ? [[full, baselineFull, registration.baselineFull]] : [])]) {
    if (!report.baseline?.file || path.resolve(root, report.baseline.file) !== path.resolve(root, expected.file)
        || report.baseline.workspace !== previous.workspace || report.baseline.binarySha256 !== previous.binarySha256) throw new Error('Paired report baseline is not the registered previous round');
  }
  const development = await buildRun(dev, baselineDev, fixture), complete = full ? await buildRun(full, baselineFull, fixture) : null;
  const previousDevelopmentAttempts = [];
  for (const [index, value] of priorReports.entries()) previousDevelopmentAttempts.push({ file: value.file, sha256: value.sha256 ?? null,
    gateFile: value.gateFile ?? (index === 0 ? options.initialGate : null),
    gate: value.gate ?? (index === 0 ? initialGate : null), run: await buildRun(value.report, baselineDev, fixture) });
  const initialDevelopment = previousDevelopmentAttempts[0]?.run ?? null;
  let sameMemoryDiagnostic = null;
  if (regressions.logs) {
    const overlapFile = path.resolve(root, regressions.logs, 'same-memory-id-overlap.json');
    try {
      const diagnostic = JSON.parse(await readFile(overlapFile));
      if (diagnostic.diagnosticSha256 !== hash(await readFile(path.resolve(root, diagnostic.diagnostic)))) throw new Error('Same-memory diagnostic fingerprint changed');
      sameMemoryDiagnostic = { ...diagnostic, file: relative(overlapFile) };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const execution = assessRetrievalExecution({ dev, gate, full, registration, registrationSha256: hash(registrationBytes), fixture, datasetSha256: registration.datasetSha256, gateFile: options.gate });
  const runs = [...previousDevelopmentAttempts.map(value => value.run), development, complete].filter(Boolean);
  const developmentManualReviewQueue = developmentReviewQueue(dev);
  const developmentUsage = summarizeDevelopmentBudget([...previousDevelopmentAttempts.map(value => value.run), development], registration, dev.budgetAuthorization);
  const metrics = { version: 'memory-qa-calibrated-report-v1', createdAt: new Date().toISOString(), datasetSha256: registration.datasetSha256,
    inputs: Object.fromEntries(Object.entries(options).filter(([key, value]) => value && !['markdown', 'metrics'].includes(key)).map(([key, value]) => [key, relative(value)])),
    registration, registrationSha256: hash(registrationBytes), execution, gate, deterministicRegressionEvidence: regressions, sameMemoryDiagnostic,
    initialDevelopment, initialDevelopmentGate: initialGate, initialPilotAssessment: initialDevelopment ? classifyInitialPilot(initialDevelopment, initialGate) : null,
    previousDevelopmentAttempts, budgetExtension: budgetEvidence.authorization ? { authorization: budgetEvidence.authorization,
      document: budgetEvidence.document, cumulativePriorLedger: budgetEvidence.ledger } : null,
    development, full: complete, fullTargetAssessment: complete ? assessFullTargets(complete, registration.fullTargets) : null,
    fullBudgetAssessment: complete ? assessObservedRunBudget(complete, registration.limits.full) : null,
    developmentManualReviewQueue,
    sharedDevelopmentBudget: developmentUsage,
    usage: distinctRetrievalRunUsage(runs),
    limitations: { independentHumanReview: false, unseenBlindEvaluation: false, semanticAssertionPrecision: null, sameMemoryCausalIsolation: false,
      notes: ['Same-model isolated automatic evaluation; possible judge drift.', 'Old original and current paired baseline grades both retained.', 'Extraction is rerun and may drift despite unchanged code.', 'Production QA limits are unchanged; actual requests, tokens and latency are measured per run.', 'Previously examined 100 questions are fixed regressions, not unseen blind evaluation.', 'Nine unanswerable questions cannot establish general refusal reliability.'] } };
  const lines = ['# 逐项目标与未知项校准：真实LLM完整链路对比', '', `生成时间：${metrics.createdAt}。模型：\`${development.model}\`。QASPER冻结公开数据，CC BY 4.0，[来源与适配](memory-public-datasets.md)。`, '',
    `20题开发集：${dev.complete ? '完成' : '未完成'}；预注册门槛：${gate.passed ? '通过' : '未通过'}。${full ? `100题：${execution.fullComplete ? '完成' : '尚未完整完成'}；相同生产代码、二进制、评分规则与门槛按顺序运行：${execution.fullAuthorizedWithFrozenRules ? '是' : '否，不能作为获准最终回归'}` : '本报告尚无100题运行工件，不宣称完整100题提升'}。`, '',
    '本轮实际重新执行提取、记忆组织、两个生产问答入口和隔离评分。提取实现保持不变，随机输出仍可能改变；新旧差值属于完整链路联合结果。原80题已参与分析，当前是固定回归集。自动评分使用同一模型，未独立人工复核。', '',
    '## 预算与实现归因', '', '本轮继续优化未知项审查、回答目标区分、覆盖与拒答校准；生产上限保持5调用、累计180000输入字符、24参考/36000字符。所有provider QA尝试（包括补查、审查和失败）计入实际成本。开发门槛要求相对同20题上一轮262191个QA token增长不超过10%，即不超过288410。全量成本目标不超过1664381，并分别保留质量、参考充分和无答案正确拒答目标的达成情况。逐unknown诊断仅读取保存trace，不改变实际回答或评分；完整格式和producer选择规则见适配说明。', '',
    `本次提供的${metrics.usage.distinctRuns}个不同实际运行（含已提供失败pilot、本次开发${complete ? '及全量' : ''}）共${metrics.usage.requests}次真实调用、${metrics.usage.reportedTokens}个已报告token；不含上一轮基线。${complete ? '' : '完整100题未运行，未发生的全量调用不计入费用，也没有全量质量指标。'}`, '',
  ];
  if (metrics.budgetExtension) lines.push('## 唯一预算扩展与全部开发尝试', '',
    `原注册开发预算${registration.limits.development.maxRequests}请求/${registration.limits.development.maxTokens}tokens未改；观察两次失败后，${metrics.budgetExtension.authorization.registeredAt}登记一次扩展，开发累计上限${developmentUsage.limits.maxRequests}/${developmentUsage.limits.maxTokens}。质量、当前fresh20 QA<=288410和全部100题目标不变，不自动进行第二次扩展。`, '',
    table(['尝试','完整执行','gate','调用','报告tokens'], [...previousDevelopmentAttempts.map((value, index) => [index + 1, value.run.complete, value.gate?.passed ?? '未提供', value.run.usage.requests, value.run.usage.reportedTokens]),
      [previousDevelopmentAttempts.length + 1, development.complete, gate.passed, development.usage.requests, development.usage.reportedTokens]]), '',
    `开发累计${developmentUsage.requests}/${developmentUsage.limits.maxRequests}次请求、${developmentUsage.reportedTokens}/${developmentUsage.limits.maxTokens}tokens；原600/3M内：请求${developmentUsage.withinOriginalRequestLimit ? '是' : '否'}、tokens${developmentUsage.withinOriginalTokenLimit ? '是' : '否'}。全量2000/12M独立计限，最终总费用仍包含全部失败、新开发与全量工作区各一次。原始账本和addendum SHA在机器JSON，不按最新prior单独扣费。`, '');
  if (complete) {
    lines.push(fullOverviewMarkdown(complete));
    lines.push(`全量独立调用预算：${metrics.fullBudgetAssessment.requests}/${registration.limits.full.maxRequests}次请求（${metrics.fullBudgetAssessment.withinRequestLimit ? '限额内' : '超出限额'}）、${metrics.fullBudgetAssessment.reportedTokens}/${registration.limits.full.maxTokens}个报告token（${metrics.fullBudgetAssessment.withinTokenLimit ? '限额内' : '超出限额'}）；全量成本单独核验，仍纳入本轮所有尝试的实际总成本。`, '');
    lines.push('## 事前登记的完整100题目标', '', table(['目标','实际','事前要求','达到'], metrics.fullTargetAssessment.checks.map(c=>[c.name,c.actual,c.required,c.passed?'是':'否'])), '', '这些目标在首次真实调用前登记；未达到的目标如实保留，不能回头改标准，也不能用开发集分数代替全量观测。', '');
  }
  lines.push(runMarkdown('单独开发集20题', development));
  lines.push('## 结果解释与未解决问题', '',
    `当前开发门槛${gate.passed ? '通过' : `仍未通过，失败项为${gate.checks.filter(check => !check.passed).map(check => check.name).join('、')}`}。参考充分率、完整正确率、协议可靠性和实际QA成本分别判断；参考充分不能证明主模型/子模型归属、未知项处理或完整回答已全部修复。${!complete && !gate.passed ? '因此未进入100题运行，全部100题成功目标仍未测。' : ''}`, '',
    '已记录的剩余排查方向包括individual与joint主体混淆、未问细节保留为unknown而触发补查，以及相关研究或数据增强来源占用导航位置。这些是事后审计案例，自动标签仍需人工复核；不能据少量开发样本宣称问题已完全解决。', '',
    '[案例审计](memory-qa-calibrated-case-audit.json) · [成本与协议审计](memory-qa-calibrated-cost-protocol-audit.json) · [第三版代码审计](memory-qa-calibrated-third-code-audit.json) · [首次调用前审计](memory-qa-calibrated-pre-live-audit.json) · [最终原始收据审计](memory-qa-calibrated-final-audit.json)', '');
  if (developmentManualReviewQueue.length) lines.push('## 开发集人工复核待办', '',
    `独立开发20题中，自动判参考充分但未完整答对的${developmentManualReviewQueue.reduce((n, row) => n + row.entries.length, 0)}个入口结果涉及${developmentManualReviewQueue.length}道题。下表仅是排查假设，尚未人工评定，不据此改分，也不用于修改当前冻结代码或完整100题运行。`, '',
    table(['题号', '入口', '生产收据ID', '待核验假设', '人工评定'], developmentManualReviewQueue.map(row => [row.id, row.entries.map(e => name[e]).join('、'), row.receiptIds.join(', '), row.hypothesis, '未做'])), '');
  if (initialDevelopment) {
    const pilot = metrics.initialPilotAssessment;
    lines.push('## 已保留的首轮开发试运行与未通过门槛', '',
      `首轮pilot完整执行标志${initialDevelopment.complete}，${initialDevelopment.usage.requests}次真实调用、${initialDevelopment.usage.reportedTokens}个已报告token；门槛${initialGate ? initialGate.passed ? '通过（需核查）' : '未通过' : '未提供通过记录'}。${pilot.kind === 'registered_development_threshold_failed' ? '该轮提取、问答和评分均完整执行，但未达到预注册开发条件；不能把complete=true当成质量通过。' : '执行完成状态与门槛通过状态分别保留。'}原始分数、收据和所有额外费用均保留。`, '',
      table(['首轮未通过检查', '实际', '冻结要求'], pilot.failedChecks.map(check => [check.name, markdownObservation(check.actual), markdownObservation(check.required)])), '',
      `${developmentUsage.distinctRuns}次开发合计${developmentUsage.requests}/${developmentUsage.limits.maxRequests}次请求、${developmentUsage.reportedTokens}/${developmentUsage.limits.maxTokens}个报告token，共享已登记的累计开发预算；完整100题另按原注册上限执行。`, '',
      '任何失败pilot均作为独立工件保留，不回填旧分数或降低门槛；新运行按相同冻结评分标准重新完成20题。格式捕获和实际返回generation归属见[适配说明](memory-qa-calibrated-format-adaptation.md)，所有已发生调用计入本轮成本。', '',
      runMarkdown('首轮失败pilot（原始结果）', initialDevelopment));
  }
  for (const [index, value] of previousDevelopmentAttempts.entries()) if (index > 0) lines.push(`## 第${index + 1}轮失败开发试运行（原始结果）`, '',
    table(['未通过检查', '实际', '要求'], (value.gate?.checks ?? []).filter(check => !check.passed).map(check => [check.name, markdownObservation(check.actual), markdownObservation(check.required)])), '',
    '该轮原始结果与失败gate保持不变，不用后来生产修复、规范化或评分规则回填；费用已纳入累计账本。', '', runMarkdown(`失败开发${index + 1}：逐题与成本`, value.run));
  if (sameMemoryDiagnostic) {
    lines.push('## 相同旧记忆的本地检索诊断', '',
      table(['入口', '旧→新任一相关ID命中', '旧→新全部相关ID命中', '去facets的全部ID命中', '旧→新参考条数总和'], entries.map(entry => {
        const s = sameMemoryDiagnostic.summary[entry];
        return [name[entry], `${s.variants.previous.any}→${s.variants.normal.any}/${s.withKnownRelevantIds}`, `${s.variants.previous.all}→${s.variants.normal.all}/${s.withKnownRelevantIds}`, `${s.variants.withoutFacets.all}/${s.withKnownRelevantIds}`, `${s.variants.previous.totalShown}→${s.variants.normal.totalShown}`];
      })), '',
      '这项只读诊断复用上一轮正式记忆及最后一次真实rewrite，无模型调用；规范ID优先取memoryId，桌面memory:前缀不作为另一个记忆。相关ID来自上一轮事后memory-only评分，未传入检索。ID命中不能代替语义充分、回答正确或独立人工验证；上下文内容与候选排列改变，ID命中变化不能视为等成本收益。去facets只在RAM诊断，正式路径保留条件、实体和有效期。', '');
  }
  if (complete) lines.push(runMarkdown('完整100题', complete));
  lines.push('## 确定性检查与门槛', '', `确定性检查${regressions.passed ? '通过' : '未通过'}，${regressions.commands?.length ?? 0}条命令。评分规则指纹和源码/二进制指纹保存在机器JSON。`, '',
    table(['命令', '退出码', '日志'], (regressions.commands ?? []).map(c => [c.command, c.exitCode, c.log])), '',
    '复杂检查值在下表仅列字段/项数摘要（每格最多300字符）；完整trace、指纹、账本和实际值均保留于机器JSON及原始gate。', '',
    table(['门槛', '通过', '实际观测'], gate.checks.map(c => [c.name, c.passed ? '是' : '否', markdownObservation(c.actual)])), '',
    regressions.sameMemoryDiagnostic ? `同记忆本地只读诊断：\`${regressions.sameMemoryDiagnostic}\`。复用上一轮真实记忆和已记录rewrite，不调用LLM；normal/withoutFacets结果仅排查检索，不替代本轮重新提取的完整链路分数。` : '未提供同记忆诊断。', '',
    `完整指标、逐题变化、评分修复审计：[机器JSON](${path.basename(options.metrics)})。[上一轮QA效率报告](memory-qa-efficient-report.md)。`, '',
    '## 限制', '', '- 参考充分和答案正确均是自动评分，不能代替独立人工标注；断言精确率未测。', observedScopeLimitation(!!complete, development.scope), '- 公开英文论文不等于中文业务记忆；未覆盖长期冲突、更新、遗忘与全生命周期。', '- 报告生成只读取保存工件，不产生真实模型调用。', '');
  await writeFile(options.metrics, JSON.stringify(metrics, null, 2));
  await writeFile(options.markdown, lines.join('\n'));
  return { markdown: relative(options.markdown), metrics: relative(options.metrics), execution };
}

function cli(args) {
  const options = { dev: 'docs/memory-public-live-qa-calibrated-dev-v3-results.json', gate: 'docs/memory-public-live-qa-calibrated-dev-v3-gate.json',
    regressions: 'docs/memory-qa-calibrated-regressions.json', markdown: 'docs/memory-qa-calibrated-report.md', metrics: 'docs/memory-qa-calibrated-metrics.json' };
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, '');
    if (!['dev', 'gate', 'full', 'initial-dev', 'initial-gate', 'regressions', 'markdown', 'metrics'].includes(key) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Unknown or incomplete argument ${args[i]}`);
    options[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = args[i + 1];
  }
  return Object.fromEntries(Object.entries(options).map(([key, value]) => [key, path.resolve(root, value)]));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) console.log(JSON.stringify(await generateRetrievalReport(cli(process.argv.slice(2))), null, 2));
