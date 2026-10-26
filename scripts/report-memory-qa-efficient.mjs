// Read-only reporting of this round. No provider requests or Engine writes.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readPublicLiveReport } from './memory-public-live-io.mjs';
import { buildOptimizedMetrics, assessOptimizedExecution } from './report-memory-extraction-optimized.mjs';
import { selectedEvaluationGeneration } from './capture-memory-evaluation-references.mjs';

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
  return { ...result, sameEvaluationRules, registrationMatchesGate, registrationHashMatchesGate, gateEvaluationMatches, gatePrecedesFull,
    fullAuthorizedWithFrozenRules: !!full && result.fullGateMatches === true && sameEvaluationRules === true && registrationMatchesGate && registrationHashMatchesGate && gateEvaluationMatches && gatePrecedesFull === true };
}

export function summarizeEnvelopeNormalizations(report) {
  const records = report.evaluationEnvelopeNormalizations ?? [];
  return { count: records.length, additionalApiRequests: 0, additionalTokens: 0, records,
    methodology: 'Only wrap exact complete flat answer system1/system2 JSON inside systems; preserve all four labels/reasons and anonymous mapping. Raw receipts and both hashes retained. Never a semantic re-evaluation.' };
}

export function distinctRetrievalRunUsage(runs) {
  const distinct = [...new Map(runs.filter(Boolean).map(run => [run.workspace, run])).values()];
  return { distinctRuns: distinct.length, requests: distinct.reduce((n, r) => n + r.usage.requests, 0),
    reportedTokens: distinct.reduce((n, r) => n + r.usage.reportedTokens, 0),
    workspaces: distinct.map(r => r.workspace), note: 'Includes provided failed pilot, current development and full runs once each; previous-round baselines excluded. A prior-run shared limit is not deducted from actual observed usage.' };
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
      const reviewReceipts = questionReceipts.filter(r => r.task === 'answer_review');
      const selectedReviewReceipt = selected ? reviewReceipts.find(r => r.index > selected.receiptId
        && !(actual.generations ?? []).some(g => g.receiptId > selected.receiptId && g.receiptId < r.index))?.index ?? null : null;
      return { id: question.id, split: question.split, answerable: question.answerable, selectedGenerationIndex: selectedIndex, selectedReviewIndex,
        generationReceiptId: selected?.receiptId ?? null, reviewReceiptId: selectedReviewReceipt,
        receiptIds: actual?.receiptIds ?? [], rawUnknowns, finalUnknowns: actual?.result?.unknowns ?? null,
        finalGrounded, finalStatus: actual?.result?.status ?? null,
        answerCorrect: actual?.error ? 'protocol_error' : judges.get(question.id)?.entries?.[entry]?.answerCorrect ?? 'not_judged',
        unknownsCleared, completeReviewed,
        reviews: (trace?.reviews ?? []).filter(validReview), humanAssessment: null };
    });
    const reviews = rows.flatMap(row => row.reviews), cleared = rows.filter(row => row.unknownsCleared);
    const completeReviewed = rows.filter(row => row.completeReviewed);
    const cases = values => values.map(({ reviews: _reviews, ...row }) => row);
    return [entry, { validReviews: reviews.length, completeAnswerTrueReviews: reviews.filter(r => r.completeAnswer === true).length,
      selectedRawUnknownsCleared: cleared.length, selectedRawUnknownsClearedOutcomes: count(cleared.map(row => row.answerCorrect)),
      completeReviewedFinalGrounded: completeReviewed.length, completeReviewedFinalGroundedOutcomes: count(completeReviewed.map(row => row.answerCorrect)),
      unknownsClearedCases: cases(cleared), completeReviewedNotFullyCorrectCases: cases(completeReviewed.filter(row => row.answerCorrect !== 'yes')),
      methodology: 'Post-hoc trace audit only: valid review means structured supported/answersQuestion flags, unsupportedClaims/missingAspects arrays and reason. Unknowns-cleared requires nonempty raw unknowns in the producer-selected actual generation, a final grounded result and an explicitly empty final unknowns array. Automatic answer labels are retained without human adjudication.' }];
  }));
}

export function classifyInitialPilot(run, gate) {
  return { executionComplete: run.complete === true, gatePassed: gate?.passed ?? null,
    kind: run.complete !== true ? 'execution_or_evaluation_incomplete' : gate?.passed === false ? 'registered_development_threshold_failed' : gate?.passed === true ? 'passed' : 'gate_not_provided',
    failedChecks: gate?.checks?.filter(check => !check.passed) ?? [] };
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
    `组合QA token：${run.qaEfficiency.previousTokens}→${run.qaEfficiency.currentTokens}，${run.qaEfficiency.reductionFraction == null ? '基线不可计算减少比例' : `减少${(run.qaEfficiency.reductionFraction * 100).toFixed(1)}%`}；实际请求${run.qaEfficiency.previousRequests}→${run.qaEfficiency.currentRequests}。该项不含提取和评分，但所有实际阶段费用均在下表及总用量中保留。`, '',
    table(['入口', '旧→新QA请求', '旧→新QA token', '旧→新p50/p95毫秒', '旧→新实际补查生成题数', '旧→新可答题拒答数', '旧→新无答案题拒答数'], entries.map(entry => {
      const a = run.previousOperations[entry], b = run.operations[entry];
      return [name[entry], `${a.requests}→${b.requests}`, `${a.reportedTokens}→${b.reportedTokens}`, `${a.p50Ms}/${a.p95Ms}→${b.p50Ms}/${b.p95Ms}`, `${a.actualSupplementGenerationQuestions}→${b.actualSupplementGenerationQuestions}`, `${a.answerableRefusals}→${b.answerableRefusals}`, `${a.unanswerableRefusals}→${b.unanswerableRefusals}`];
    })), '',
    '这里“拒答数”是生产最终grounded/status观测，不等于正确拒答数；正确性在独立无答案分母中另计。“实际补查生成”须至少两次真实generation请求，不能把仅规划或空改写算作补查。', '',
    table(['入口', '旧→新规划补查题数', '旧→新额外检索轮数', '旧→新任一审查拒绝题数', '旧→新补查失败码'], entries.map(entry => {
      const a = run.previousOperations[entry], b = run.operations[entry];
      return [name[entry], `${a.supplementPlanningQuestions}→${b.supplementPlanningQuestions}`, `${a.tracedExtraRetrievalRounds}→${b.tracedExtraRetrievalRounds}`, `${a.anyRejectedReviewQuestions}→${b.anyRejectedReviewQuestions}`, `${counts(a.supplementFailureCodes)}→${counts(b.supplementFailureCodes)}`];
    })), '', '补查失败可被生产流程安全转换为unknown，因此不能只看顶层error计数；这里单列queryTrace.supplementStatus。', '',
    table(['入口', '旧→新已核验partial回退', '旧→新相同上下文跳过', '本轮generation选择索引'], entries.map(entry => [name[entry], `${run.previousOperations[entry].reviewedPartialFallbackQuestions}→${run.operations[entry].reviewedPartialFallbackQuestions}`, `${run.previousOperations[entry].unchangedContextSkippedQuestions}→${run.operations[entry].unchangedContextSkippedQuestions}`, counts(run.operations[entry].selectedGenerationIndices)])), '',
    'UNCHANGED_CONTEXT表示复验后跳过重复生成，单列为节省行为，不当成补查失败。安全partial回退仍按实际所有尝试计费，并按producer选中的真实generation参考做检索评分。某分支观测次数为0时，不能把token下降归因于该分支；本报告未做逐机制因果消融。', '',
    '### 审查校准（事后审计）', '',
    table(['入口', '有效review', 'completeAnswer=true', '选中raw unknowns被清空', '清空后自动答案标签', 'complete审查后最终grounded答案标签'], entries.map(entry => {
      const c = run.reviewCalibration[entry];
      return [name[entry], c.validReviews, c.completeAnswerTrueReviews, c.selectedRawUnknownsCleared, counts(c.selectedRawUnknownsClearedOutcomes), counts(c.completeReviewedFinalGroundedOutcomes)];
    })), '',
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
    `组合QA token ${run.qaEfficiency.previousTokens}→${run.qaEfficiency.currentTokens}，${run.qaEfficiency.reductionFraction == null ? '比例未测' : `减少${(run.qaEfficiency.reductionFraction * 100).toFixed(1)}%`}；生产QA调用${run.qaEfficiency.previousRequests}→${run.qaEfficiency.currentRequests}。这是100题观测结果，开发放行门槛使用独立20题原始QA基线，不相互替代。`, '',
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
  for (const [key, expected] of [['markdown', 'memory-qa-efficient-report.md'], ['metrics', 'memory-qa-efficient-metrics.json']]) {
    if (path.dirname(options[key]) !== path.join(root, 'docs') || path.basename(options[key]) !== expected) throw new Error('Only dedicated retrieval-round report outputs are permitted');
  }
  const registrationBytes = await readFile(path.join(root, 'docs/memory-qa-efficient-preregistration.json'));
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
  const initialDev = options.initialDev ? await readPublicLiveReport(options.initialDev) : null;
  let initialGate = null;
  if (options.initialGate) { try { initialGate = JSON.parse(await readFile(options.initialGate)); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  for (const [report, previous, expected] of [[dev, baselineDev, registration.baselineDevelopment], ...(full ? [[full, baselineFull, registration.baselineFull]] : [])]) {
    if (!report.baseline?.file || path.resolve(root, report.baseline.file) !== path.resolve(root, expected.file)
        || report.baseline.workspace !== previous.workspace || report.baseline.binarySha256 !== previous.binarySha256) throw new Error('Paired report baseline is not the registered previous round');
  }
  const development = await buildRun(dev, baselineDev, fixture), complete = full ? await buildRun(full, baselineFull, fixture) : null;
  const initialDevelopment = initialDev ? await buildRun(initialDev, baselineDev, fixture) : null;
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
  const runs = [initialDevelopment, development, complete].filter(Boolean);
  const developmentManualReviewQueue = developmentReviewQueue(dev);
  const developmentUsage = distinctRetrievalRunUsage([initialDevelopment, development]);
  const metrics = { version: 'memory-qa-efficient-report-v1', createdAt: new Date().toISOString(), datasetSha256: registration.datasetSha256,
    inputs: Object.fromEntries(Object.entries(options).filter(([key, value]) => value && !['markdown', 'metrics'].includes(key)).map(([key, value]) => [key, relative(value)])),
    registration, registrationSha256: hash(registrationBytes), execution, gate, deterministicRegressionEvidence: regressions, sameMemoryDiagnostic,
    initialDevelopment, initialDevelopmentGate: initialGate, initialPilotAssessment: initialDevelopment ? classifyInitialPilot(initialDevelopment, initialGate) : null,
    development, full: complete,
    developmentManualReviewQueue,
    sharedDevelopmentBudget: { ...developmentUsage,
      note: 'Includes only provided development runs once each, including the failed pilot; excludes full and previous-round baselines. A prior-run shared limit is not deducted from actual observed usage.',
      limits: registration.limits.development,
      withinRequestLimit: developmentUsage.requests <= registration.limits.development.maxRequests,
      withinTokenLimit: developmentUsage.reportedTokens <= registration.limits.development.maxTokens },
    usage: distinctRetrievalRunUsage(runs),
    limitations: { independentHumanReview: false, unseenBlindEvaluation: false, semanticAssertionPrecision: null, sameMemoryCausalIsolation: false,
      notes: ['Same-model isolated automatic evaluation; possible judge drift.', 'Old original and current paired baseline grades both retained.', 'Extraction is rerun and may drift despite unchanged code.', 'Production QA limits are unchanged; actual requests, tokens and latency are measured per run.', 'Previously examined 100 questions are fixed regressions, not unseen blind evaluation.', 'Nine unanswerable questions cannot establish general refusal reliability.'] } };
  const lines = ['# 拒答、对象区分与输出效率：真实LLM完整链路对比', '', `生成时间：${metrics.createdAt}。模型：\`${development.model}\`。QASPER冻结公开数据，CC BY 4.0，[来源与适配](memory-public-datasets.md)。`, '',
    `20题开发集：${dev.complete ? '完成' : '未完成'}；预注册门槛：${gate.passed ? '通过' : '未通过'}。${full ? `100题：${execution.fullComplete ? '完成' : '尚未完整完成'}；相同生产代码、二进制、评分规则与门槛按顺序运行：${execution.fullAuthorizedWithFrozenRules ? '是' : '否，不能作为获准最终回归'}` : '本报告尚无100题运行工件，不宣称完整100题提升'}。`, '',
    '本轮实际重新执行提取、记忆组织、两个生产问答入口和隔离评分。提取实现保持不变，随机输出仍可能改变；新旧差值属于完整链路联合结果。原80题已参与分析，当前是固定回归集。自动评分使用同一模型，未独立人工复核。', '',
    '## 预算与实现归因', '', '本轮优化过度拒答、主模型与子模型对象区分、无向量通用对象导航及候选多样性、紧凑索引引用格式和token成本。completeAnswer只允许在审查一致且全部所问目标已回答时移除未问unknowns并升级状态，不添加或改写断言/引用；相同上下文复验后可跳过重复生成，补查失败可返回初次已核验partial并复验旧/新快照。生产上限仍为5调用、累计180000输入字符、聚焦24参考/36000字符，实际trace与冻结源码完整保留。所有provider QA请求（包括补查及失败）计入成本；开发门槛要求比同20题基线516878个QA token至少降低15%，即不超过439346。索引span捕获与已核验partial回退的实际generation选择详见格式适配说明；原始请求与全部尝试保持审计。', '',
    `本次提供的${metrics.usage.distinctRuns}个不同运行（含已提供失败pilot、新开发及全量）共${metrics.usage.requests}次真实调用、${metrics.usage.reportedTokens}个已报告token；不含上一轮基线。`, '',
  ];
  if (complete) lines.push(fullOverviewMarkdown(complete));
  lines.push(runMarkdown('单独开发集20题', development));
  if (developmentManualReviewQueue.length) lines.push('## 开发集人工复核待办', '',
    `独立开发20题中，自动判参考充分但未完整答对的${developmentManualReviewQueue.reduce((n, row) => n + row.entries.length, 0)}个入口结果涉及${developmentManualReviewQueue.length}道题。下表仅是排查假设，尚未人工评定，不据此改分，也不用于修改当前冻结代码或完整100题运行。`, '',
    table(['题号', '入口', '生产收据ID', '待核验假设', '人工评定'], developmentManualReviewQueue.map(row => [row.id, row.entries.map(e => name[e]).join('、'), row.receiptIds.join(', '), row.hypothesis, '未做'])), '');
  if (initialDevelopment) {
    const pilot = metrics.initialPilotAssessment;
    lines.push('## 已保留的首轮开发试运行与未通过门槛', '',
      `首轮pilot完整执行标志${initialDevelopment.complete}，${initialDevelopment.usage.requests}次真实调用、${initialDevelopment.usage.reportedTokens}个已报告token；门槛${initialGate ? initialGate.passed ? '通过（需核查）' : '未通过' : '未提供通过记录'}。${pilot.kind === 'registered_development_threshold_failed' ? '该轮提取、问答和评分均完整执行，但未达到预注册开发条件；不能把complete=true当成质量通过。' : '执行完成状态与门槛通过状态分别保留。'}原始分数、收据和所有额外费用均保留。`, '',
      table(['首轮未通过检查', '实际', '冻结要求'], pilot.failedChecks.map(check => [check.name, JSON.stringify(check.actual), JSON.stringify(check.required)])), '',
      `两次开发合计${developmentUsage.requests}/${registration.limits.development.maxRequests}次请求、${developmentUsage.reportedTokens}/${registration.limits.development.maxTokens}个报告token，共享原开发预算；完整100题另按注册上限执行。`, '',
      '任何失败pilot均作为独立工件保留，不回填旧分数或降低门槛；新运行按相同冻结评分标准重新完成20题。格式捕获和实际返回generation归属见[适配说明](memory-qa-efficient-format-adaptation.md)，所有已发生调用计入本轮成本。', '',
      runMarkdown('首轮失败pilot（原始结果）', initialDevelopment));
  }
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
    table(['门槛', '通过', '实际观测'], gate.checks.map(c => [c.name, c.passed ? '是' : '否', JSON.stringify(c.actual)])), '',
    regressions.sameMemoryDiagnostic ? `同记忆本地只读诊断：\`${regressions.sameMemoryDiagnostic}\`。复用上一轮真实记忆和已记录rewrite，不调用LLM；normal/withoutFacets结果仅排查检索，不替代本轮重新提取的完整链路分数。` : '未提供同记忆诊断。', '',
    `完整指标、逐题变化、评分修复审计：[机器JSON](${path.basename(options.metrics)})。[上一轮检索优化报告](memory-retrieval-optimized-report.md)。`, '',
    '## 限制', '', '- 参考充分和答案正确均是自动评分，不能代替独立人工标注；断言精确率未测。', '- 9道无答案题样本很小，拒答改进或退化均单列；不得混入91道可答题准确率。', '- 公开英文论文不等于中文业务记忆；未覆盖长期冲突、更新、遗忘与全生命周期。', '- 报告生成只读取保存工件，不产生真实模型调用。', '');
  await writeFile(options.metrics, JSON.stringify(metrics, null, 2));
  await writeFile(options.markdown, lines.join('\n'));
  return { markdown: relative(options.markdown), metrics: relative(options.metrics), execution };
}

function cli(args) {
  const options = { dev: 'docs/memory-public-live-qa-efficient-dev-v2-results.json', gate: 'docs/memory-public-live-qa-efficient-dev-v2-gate.json',
    initialDev: 'docs/memory-public-live-qa-efficient-dev-results.json', initialGate: 'docs/memory-public-live-qa-efficient-dev-gate.json',
    regressions: 'docs/memory-qa-efficient-regressions.json', markdown: 'docs/memory-qa-efficient-report.md', metrics: 'docs/memory-qa-efficient-metrics.json' };
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, '');
    if (!['dev', 'gate', 'full', 'initial-dev', 'initial-gate', 'regressions', 'markdown', 'metrics'].includes(key) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Unknown or incomplete argument ${args[i]}`);
    options[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = args[i + 1];
  }
  return Object.fromEntries(Object.entries(options).map(([key, value]) => [key, path.resolve(root, value)]));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) console.log(JSON.stringify(await generateRetrievalReport(cli(process.argv.slice(2))), null, 2));
