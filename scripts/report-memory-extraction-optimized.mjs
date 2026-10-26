// Offline report generation only. It reads frozen live artifacts; never calls
// a provider, starts an Engine, changes production code, or replaces v4 reports.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readPublicLiveReport } from './memory-public-live-io.mjs';
import { summarize } from './score-memory-public-live.mjs';
import { comparePublicLive } from './compare-memory-public-live.mjs';

const root = path.resolve(import.meta.dirname, '..');
const labels = ['yes', 'partial', 'no', 'uncertain'];
const entries = ['desktop', 'connector'];
const entryName = { desktop: '桌面', connector: '飞书问答' };
const hash = value => createHash('sha256').update(value).digest('hex');
const count = values => values.reduce((out, value) => { out[value ?? 'missing'] = (out[value ?? 'missing'] ?? 0) + 1; return out; }, {});
const sum = (values, field) => values.reduce((n, value) => n + (Number.isFinite(value[field]) ? value[field] : 0), 0);
const rate = (n, d) => ({ count: n, denominator: d, rate: d ? n / d : null });
const showRate = value => !value || !value.denominator ? '不适用' : `${value.count}/${value.denominator}（${(100 * value.rate).toFixed(1)}%）`;
const showCounts = values => Object.entries(values ?? {}).map(([key, n]) => `${key} ${n}`).join('；') || '无';
const relative = file => path.relative(root, file).replaceAll('\\', '/');
const table = (headers, rows) => [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map(row => `| ${row.map(v => String(v ?? '—').replaceAll('|', '\\|').replaceAll('\n', ' ')).join(' | ')} |`)].join('\n');
const scalar = (value, digits = 1) => value == null ? '未测' : Number(value).toFixed(digits);
const isProtocolError = value => !!value?.error && /GROUNDING|SCHEMA|ANSWER_(?:CONTRACT|PROTOCOL)|MODEL_(?:JSON|RESPONSE|OUTPUT|INCOMPLETE|TOOLS)/.test(value.errorCode ?? '');
const outputFiles = { markdown: 'memory-extraction-optimized-report.md', metrics: 'memory-extraction-optimized-metrics.json' };
const stable = value => JSON.stringify(value, (_, v) => v && !Array.isArray(v) && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
const questionsOf = report => (report?.documents ?? []).flatMap(d => d.questions ?? []);
const sameHashes = (a, b) => !!a?.productionSha256 && !!b?.productionSha256 && !!a?.binarySha256 && a.binarySha256 === b.binarySha256 && stable(a.productionSha256) === stable(b.productionSha256);

export function assessOptimizedExecution({ dev, gate, full, datasetSha256, gateFile, fixture, initialGate }) {
  const scopeMatches = (report, split, countQuestions, countAnswerable, countPapers) => {
    const docs = report?.documents ?? [], questions = questionsOf(report);
    if (docs.length !== countPapers || questions.length !== countQuestions || new Set(docs.map(d => d.id)).size !== countPapers || new Set(questions.map(q => q.id)).size !== countQuestions || questions.filter(q => q.answerable).length !== countAnswerable) return false;
    if (split === 'development' && docs.some(d => d.split !== 'development')) return false;
    if (fixture) {
      const expected = fixture.documents.filter(d => split === 'all' || d.split === split);
      const wanted = new Map(expected.flatMap(d => d.queries.map(q => [q.id, { ...q, paperId: d.id }])));
      if (wanted.size !== questions.length || !docs.every(d => (d.questions ?? []).every(q => { const gold = wanted.get(q.id); return gold?.paperId === d.id && gold.question === q.question && gold.answerable === q.answerable; }))) return false;
    }
    return true;
  };
  const developmentScopeValid = scopeMatches(dev, 'development', 20, 19, 6);
  const fullScopeValid = full ? scopeMatches(full, 'all', 100, 91, 36) : null;
  const gateMatchesDevelopment = !!gate && developmentScopeValid && dev.datasetSha256 === datasetSha256 && gate.datasetSha256 === datasetSha256 && gate.workspace === dev.workspace && sameHashes(dev, gate);
  const sameFrozenProduction = full ? sameHashes(full, dev) : null;
  const fullGateMatches = full ? !!gate && gate.passed === true && gateMatchesDevelopment && dev.complete === true && sameFrozenProduction && full.datasetSha256 === datasetSha256 && !!full.gate && !!gateFile && path.resolve(root, full.gate) === path.resolve(root, gateFile) : null;
  const thresholdsUnchanged = initialGate && gate ? stable(initialGate.checks?.map(c => ({ name: c.name, required: c.required }))) === stable(gate.checks?.map(c => ({ name: c.name, required: c.required }))) : null;
  return { developmentComplete: dev.complete === true, developmentScopeValid, developmentGatePassed: gate?.passed ?? null, gateMatchesDevelopment,
    fullRunProvided: !!full, fullRunExecuted: !!full && (full.receipts?.length ?? 0) > 0,
    full100QuestionsPresent: fullScopeValid, fullComplete: !!full && full.complete === true && fullScopeValid === true,
    sameFrozenProduction, fullGateMatches, fullGateProvenance: full?.gate ?? null, gateThresholdsUnchangedSinceInitial: thresholdsUnchanged,
    failedGateChecks: gate?.checks?.filter(c => !c.passed) ?? [] };
}

// Frozen expected questions stay in denominators even when the pipeline or
// judge did not reach them. These stubs carry no memories or invented results.
export function withExpectedQuestionScope(report, fixture) {
  const scope = report.split ?? (questionsOf(report).length === 100 ? 'all' : null);
  if (!['all', 'development', 'holdout'].includes(scope)) return report;
  const expected = fixture.documents.filter(d => scope === 'all' || d.split === scope);
  const observed = new Map(report.documents.map(d => [d.id, d]));
  return { ...report, documents: expected.map(doc => {
    const paper = observed.get(doc.id) ?? { id: doc.id, split: doc.split, title: doc.title, memories: [], questions: [] };
    const questions = new Map(paper.questions.map(q => [q.id, q]));
    return { ...paper, questions: doc.queries.map(q => questions.get(q.id) ?? { id: q.id, question: q.question, answerable: q.answerable, entries: {} }) };
  }) };
}

export function summarizeEvaluationRepairs(report) {
  const records = report.evaluationRepairs ?? [];
  const receiptIds = new Set(records.flatMap(r => r.newReceiptIds ?? []));
  const receipts = (report.receipts ?? []).filter(r => receiptIds.has(r.index) || r.evaluationRepair === true);
  const judgments = new Map((report.judgments ?? []).map(j => [j.id, j]));
  const oldErrors = records.flatMap(r => (r.phases ?? []).map(phase => ({ questionId: r.questionId, paperId: r.paperId, phase,
    error: r.previousJudgment?.stages?.[phase]?.error ?? r.previousJudgment?.error ?? null,
    errorKind: r.previousJudgment?.stages?.[phase]?.errorKind ?? null,
    originalReceiptIds: r.previousJudgment?.receiptIds ?? [], newReceiptIds: r.newReceiptIds ?? [],
    currentError: judgments.get(r.questionId)?.stages?.[phase]?.error ?? null,
    replacementStagePresent: !!judgments.get(r.questionId)?.stages?.[phase],
  })));
  return { attemptedQuestions: new Set(records.map(r => r.questionId)).size, repairRecords: records.length,
    completedRepairQuestions: new Set(records.filter(r => r.completedAt).map(r => r.questionId)).size,
    attemptedStages: oldErrors.length, phases: count(oldErrors.map(r => r.phase)),
    extraRequests: receipts.length, extraReportedTokens: receipts.reduce((n, r) => n + (r.usage?.total_tokens ?? 0), 0),
    extraMissingUsageRequests: receipts.filter(r => !Number.isFinite(r.usage?.total_tokens)).length,
    productionRequestsAmongRepairs: receipts.filter(r => r.phase !== 'judge').length,
    currentJudgeErrorQuestions: (report.judgments ?? []).filter(j => j.error).length,
    previousJudgmentsPreserved: records.every(r => !!r.previousJudgment), oldErrors,
    records,
    note: 'One explicit format/schema re-evaluation of recorded failed judge stages. Original judgments and receipts remain retained. Valid judge stages and production extraction/retrieval/QA are not retried by this mechanism; scores are not selected between old and new valid answers. Zero current judge errors does not mean the first attempt had no malformed outputs.' };
}

export function summarizeEvaluationSyntaxRepairs(report) {
  const records = report.evaluationSyntaxRepairs ?? [];
  const rows = records.map(record => ({ ...record, phase: record.phase ?? record.stage ?? 'unknown' }));
  return { repairs: rows.length, questions: new Set(rows.map(r => r.questionId)).size,
    phases: count(rows.map(r => r.phase)), receiptIds: [...new Set(rows.map(r => r.receiptId).filter(id => id != null))],
    additionalApiRequests: 0, additionalTokens: 0,
    declaredExtraRequests: rows.reduce((n, r) => n + (r.modelRequests ?? 0), 0),
    singleBraceRuleRecords: rows.filter(r => r.kind === 'append-single-final-object-brace' && r.appended === '}').length,
    fingerprintedRecords: rows.filter(r => /^[a-f0-9]{64}$/.test(r.originalSha256 ?? '') && /^[a-f0-9]{64}$/.test(r.repairedSha256 ?? '')).length,
    records: rows,
    note: 'Deterministic parsing of an already received judge response by appending exactly one terminal object brace, followed by unchanged judge schema and memory-ID checks. Raw receipts and original/repaired hashes remain retained. This produces no provider request or new token usage, does not change existing grade strings, and is neither another LLM evaluation nor production recovery.' };
}

function validateOutputs(options) {
  for (const [key, filename] of Object.entries(outputFiles)) {
    if (path.dirname(options[key]) !== path.join(root, 'docs') || path.basename(options[key]) !== filename) throw new Error('Only dedicated new optimized report outputs under docs are allowed');
  }
  const inputs = Object.entries(options).filter(([key]) => !Object.hasOwn(outputFiles, key)).map(([, value]) => value);
  if (inputs.includes(options.markdown) || inputs.includes(options.metrics)) throw new Error('Output must not overwrite any input');
}

async function jsonFile(file, optional = false) {
  if (!file) return null;
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
}
async function rawReceipts(report) {
  try { return (await readFile(path.join(root, report.workspace, 'receipts.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function saturation(receipts) {
  if (!receipts) return { available: false, completeJsonResponses: null, memoryAt12: null, taskAt4: null, totalAt16: null };
  const batches = [];
  let malformed = 0;
  for (const receipt of receipts.filter(r => r.phase === 'extraction')) {
    if (receipt.finishReason !== 'stop') continue;
    try {
      const outer = JSON.parse(receipt.responseText);
      const output = JSON.parse(outer.choices[0].message.content);
      if (!Array.isArray(output.candidates) || !Array.isArray(output.taskCandidates)) { malformed++; continue; }
      const memory = output.candidates.length, task = output.taskCandidates.length;
      batches.push({ receiptId: receipt.index, paperId: receipt.paperId, memory, task,
        memoryAt12: memory === 12, taskAt4: task === 4, totalAt16: memory + task === 16,
        exceedsQuantity: memory > 12 || task > 4 || memory + task > 16 });
    } catch { malformed++; }
  }
  return { available: true, completeJsonResponses: batches.length, malformedCompleteResponses: malformed,
    memoryAt12: batches.filter(b => b.memoryAt12).length, taskAt4: batches.filter(b => b.taskAt4).length,
    totalAt16: batches.filter(b => b.totalAt16).length, quantityExceeded: batches.filter(b => b.exceedsQuantity).length,
    saturatedReceiptIds: batches.filter(b => b.memoryAt12 || b.taskAt4 || b.totalAt16),
    note: 'Counts overlap. Exactly reaching a cap is a saturation signal, not proof of omitted facts or truncation; raw complete responses include parents later split or rejected.' };
}
function usage(report) {
  const groups = new Map();
  for (const receipt of report.receipts ?? []) {
    const key = receipt.phase === 'judge' ? `judge:${receipt.judgeStage ?? 'legacy-joint'}` : `${receipt.phase ?? 'unknown'}:${receipt.task ?? 'unknown'}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(receipt);
  }
  return { byPhase: Object.fromEntries([...groups].map(([key, rows]) => [key, { requests: rows.length,
    inputTokens: rows.reduce((n, r) => n + (r.usage?.prompt_tokens ?? 0), 0),
    outputTokens: rows.reduce((n, r) => n + (r.usage?.completion_tokens ?? 0), 0),
    totalTokens: rows.reduce((n, r) => n + (r.usage?.total_tokens ?? 0), 0),
    missingUsageRequests: rows.filter(r => !Number.isFinite(r.usage?.total_tokens)).length,
    sumRequestElapsedMs: sum(rows, 'elapsedMs'), errors: rows.filter(r => r.error || (r.status != null && r.status !== 200)).length }])),
    requests: report.receipts?.length ?? 0, reportedTokens: (report.receipts ?? []).reduce((n, r) => n + (r.usage?.total_tokens ?? 0), 0),
    missingUsageRequests: (report.receipts ?? []).filter(r => !Number.isFinite(r.usage?.total_tokens)).length,
    wallClockMs: report.finishedAt && report.startedAt ? Date.parse(report.finishedAt) - Date.parse(report.startedAt) : null,
    extractionJobElapsedMsSum: report.documents.reduce((n, d) => n + (d.extraction?.elapsedMs ?? 0), 0),
    note: 'Provider-reported tokens only, not price. Request durations and paper extraction durations overlap under concurrency; neither is wall-clock duration. Missing usage is not zero cost.' };
}

export async function buildOptimizedMetrics(report, baseline, control, fixture) {
  if (report.paragraphControl) throw new Error('Optimized run must be the actual extraction pipeline, not paragraph control');
  if (report.datasetSha256 !== baseline.datasetSha256 || control.datasetSha256 !== baseline.datasetSha256) throw new Error('Frozen dataset mismatch');
  const observedPapers = report.documents.length, observedQuestions = questionsOf(report).length;
  report = withExpectedQuestionScope(report, fixture);
  const evaluated = summarize(report, fixture), comparison = comparePublicLive(report, baseline);
  const questionRows = report.documents.flatMap(p => p.questions.map(q => ({ ...q, paperId: p.id, split: p.split })));
  const positive = questionRows.filter(q => q.answerable), negative = questionRows.filter(q => !q.answerable);
  const judges = new Map(report.judgments.map(j => [j.id, j]));
  const drafts = report.documents.flatMap(p => p.extractionDrafts ?? []);
  const batches = report.documents.flatMap(p => p.extractionBatches ?? []);
  const memoryAvailable = report.version === 'qasper-production-live-v2' && ['separated', 'memory-answer'].includes(report.judgeMode);
  const retrievalAvailable = report.version === 'qasper-production-live-v2' && report.judgeMode === 'separated';
  const stageLabels = fn => count(positive.map(q => fn(judges.get(q.id))));
  const outcomes = Object.fromEntries(entries.map(entry => {
    const classify = q => {
      const value = q.entries?.[entry];
      if (!value) return 'not_run';
      if (value.error) return isProtocolError(value) ? 'protocol_error' : 'operational_error';
      const grade = judges.get(q.id)?.entries?.[entry]?.answerCorrect;
      return labels.includes(grade) ? grade : 'not_judged';
    };
    const selected = questionRows.map(q => q.entries?.[entry]);
    const memoryEnough = positive.filter(q => judges.get(q.id)?.memorySufficiency === 'yes');
    const shownEnough = positive.filter(q => judges.get(q.id)?.entries?.[entry]?.retrievalSufficiency === 'yes');
    return [entry, { answerable: positive.length, unanswerable: negative.length,
      answerableOutcomes: count(positive.map(classify)), unanswerableOutcomes: count(negative.map(classify)),
      completeCorrect: rate(positive.filter(q => classify(q) === 'yes').length, positive.length),
      partialCorrect: rate(positive.filter(q => classify(q) === 'partial').length, positive.length),
      correctAbstention: rate(negative.filter(q => classify(q) === 'yes').length, negative.length),
      modelUnknownOrUngroundedAnswerable: rate(positive.filter(q => { const v = q.entries?.[entry]; return v && !v.error && (v.result?.status === 'unknown' || v.result?.grounded === false); }).length, positive.length),
      allErrors: count(selected.filter(v => v?.error).map(v => v.errorCode ?? 'unknown')),
      protocolErrors: selected.filter(isProtocolError).length,
      retrievalLabels: retrievalAvailable ? stageLabels(j => j?.entries?.[entry]?.retrievalSufficiency) : null,
      fullRetrieval: retrievalAvailable ? rate(shownEnough.length, positive.length) : null,
      retrievalGivenFullMemory: retrievalAvailable && memoryAvailable ? rate(memoryEnough.filter(q => judges.get(q.id)?.entries?.[entry]?.retrievalSufficiency === 'yes').length, memoryEnough.length) : null,
      answerGivenFullShownEvidence: retrievalAvailable ? rate(shownEnough.filter(q => classify(q) === 'yes').length, shownEnough.length) : null,
      statusCounts: count(selected.filter(Boolean).map(v => v.error ? 'error' : v.result?.status ?? 'missing')),
      p50Ms: evaluated.summary[`all:${entry}`].p50Ms, p95Ms: evaluated.summary[`all:${entry}`].p95Ms,
    }];
  }));
  const ids = new Set(questionRows.map(q => q.id)), paperIds = new Set(report.documents.map(p => p.id));
  const matched = original => ({ ...original, documents: original.documents.filter(p => paperIds.has(p.id)).map(p => ({ ...p, questions: p.questions.filter(q => ids.has(q.id)) })), judgments: original.judgments.filter(j => ids.has(j.id)) });
  const raw = await rawReceipts(report);
  return { outputTag: report.outputTag, model: report.model, actualModels: report.actualModels ?? [], workspace: report.workspace,
    complete: report.complete === true, haltReason: report.haltReason ?? null, fatalError: report.fatalError ?? null,
    datasetSha256: report.datasetSha256, productionSha256: report.productionSha256, binarySha256: report.binarySha256,
    productionUnchanged: report.productionUnchanged ?? null, judgeMode: report.judgeMode,
    scope: { papers: report.documents.length, questions: questionRows.length, answerable: positive.length, unanswerable: negative.length, observedPapers, observedQuestions,
      paperSplits: count(report.documents.map(p => p.split)), expectedPapers: report.expectedPapers ?? null, expectedQuestions: report.expectedQuestions ?? null },
    extraction: { promptVersions: count(report.documents.map(p => p.extraction?.job?.promptVersion ?? 'unknown')), jobStatuses: count(report.documents.map(p => p.extraction?.job?.status ?? 'not_run')),
      jobErrors: count(report.documents.filter(p => p.extraction?.job?.errorCode).map(p => p.extraction.job.errorCode)),
      budgetFailedJobs: report.documents.filter(p => p.extraction?.job?.errorCode === 'MODEL_TASK_BUDGET').length,
      formalMemories: report.documents.reduce((n, p) => n + p.memories.length, 0), draftStatuses: count(drafts.map(d => d.status)),
      totalDrafts: drafts.length, scopeNeedsReview: drafts.filter(d => ['needs_review', 'review_required'].includes(d.status)).length,
      topicQuarantined: drafts.filter(d => d.issues?.some(i => i.field === 'topic' && i.severity === 'navigation')).length,
      topicOnlyReady: drafts.filter(d => d.status === 'ready' && d.issues?.some(i => i.field === 'topic') && !d.issues.some(i => i.severity === 'applicability')).length,
      scopeIssueFieldsOverlapping: count(drafts.flatMap(d => (d.issues ?? []).filter(i => i.severity === 'applicability').map(i => i.field))),
      batchStatuses: count(batches.map(b => b.status)), discardedByRecordedLatestBatch: batches.reduce((n, b) => n + (b.discardedCount ?? 0), 0),
      unreviewedFormalMemories: report.documents.reduce((n, p) => n + (p.extractionDrafts ?? []).filter(d => ['needs_review', 'review_required'].includes(d.status) && d.proposalId && p.memories.some(m => m.proposalId === d.proposalId)).length, 0),
      saturation: saturation(raw) },
    organization: { semanticAssertionPrecision: null, independentHumanReview: { performed: false, reviewedItems: null },
      note: 'Validation acceptance and source substring matches are not semantic assertion precision. Scope-needs-review drafts remain outside formal memory.' },
    retainedMemoryContent: memoryAvailable ? { labels: stageLabels(j => j?.memorySufficiency), denominator: positive.length,
      methodology: 'Isolated same-model judge sees formal memory CONTENT only, not retrieval or final answers; yes/partial/no/uncertain are automatic estimates.' } : null,
    outcomes, summary: evaluated.summary, observedFirstLoss: Object.fromEntries(entries.map(e => [e, evaluated.summary[`all:${e}`].firstLoss])),
    pairedComparison: comparison,
    historicalBaselineMatched: summarize(matched(baseline), fixture), paragraphControlMatched: summarize(matched(control), fixture),
    usage: usage(report),
    evaluationRepairs: summarizeEvaluationRepairs(report),
    evaluationSyntaxRepairs: summarizeEvaluationSyntaxRepairs(report),
    caseResults: evaluated.cases,
  };
}

function runMarkdown(name, run) {
  const e = run.extraction, s = run.scope, sat = e.saturation;
  const lines = [`## ${name}`, '', `${s.papers}篇、${s.questions}题（可答${s.answerable}、无答案${s.unanswerable}）；完成：${run.complete ? '是' : '否'}；评分模式：\`${run.judgeMode}\`。${run.haltReason || run.fatalError ? `停止原因：${run.haltReason ?? run.fatalError}。` : ''}`, '',
    table(['提取与组织观测', '结果'], [
      ['任务终态', showCounts(e.jobStatuses)], ['错误码 / 任务预算失败', `${showCounts(e.jobErrors)} / ${e.budgetFailedJobs}`],
      ['正式记忆正文', e.formalMemories], ['草稿总数 / 范围待审核', `${e.totalDrafts} / ${e.scopeNeedsReview}`],
      ['topic隔离 / 仅topic隔离且ready', `${e.topicQuarantined} / ${e.topicOnlyReady}`], ['草稿状态', showCounts(e.draftStatuses)],
      ['批次终态', showCounts(e.batchStatuses)], ['未审草稿进入正式记忆', e.unreviewedFormalMemories],
      ['完整JSON响应 / 恰达12条记忆 / 4条任务 / 合计16', sat.available ? `${sat.completeJsonResponses} / ${sat.memoryAt12} / ${sat.taskAt4} / ${sat.totalAt16}` : '原始收据缺失，未测'],
    ]), '', '恰达上限的批次可能存在信息压缩，单列为饱和信号，不能直接算遗漏。topic隔离可能与关键范围问题重叠；待审核草稿未自动放行。', '',
    `正文信息留存（可答题，memory-only隔离评分）：${run.retainedMemoryContent ? showCounts(run.retainedMemoryContent.labels) : '未执行可用的隔离评分'}。`, '',
    table(['入口', '完整答对', '部分答对', '无答案题正确拒答', '协议错误/全部QA错误', '可答题拒答或不具依据', 'p50/p95秒'], entries.map(entry => {
      const a = run.outcomes[entry];
      return [entryName[entry], showRate(a.completeCorrect), showRate(a.partialCorrect), showRate(a.correctAbstention), `${a.protocolErrors}/${Object.values(a.allErrors).reduce((n, v) => n + v, 0)}`, showRate(a.modelUnknownOrUngroundedAnswerable), `${scalar(a.p50Ms == null ? null : a.p50Ms / 1000)}/${scalar(a.p95Ms == null ? null : a.p95Ms / 1000)}`];
    })), '',
    table(['入口', '实际最后生成参考正文充分性', '记忆充分时完整召回', '参考充分时完整答对'], entries.map(entry => { const a = run.outcomes[entry]; return [entryName[entry], a.retrievalLabels ? showCounts(a.retrievalLabels) : '未隔离评分', showRate(a.retrievalGivenFullMemory), showRate(a.answerGivenFullShownEvidence)]; })), '',
    '检索充分性由独立上下文的retrieval-only调用判断实际送给最后一次生成的正文；这是同模型自动估计。来源段落ID命中不能代替正文信息充分性。', '',
    table(['入口', '同题优化前→后完整答对', '新增成功', '退化', '同次匿名配对评分'], entries.map(entry => {
      const p = run.pairedComparison.summary[`all:${entry}`];
      return [entryName[entry], `${p.beforeFullyCorrect.count}/${p.answerable} → ${p.afterFullyCorrect.count}/${p.answerable}`, p.answerableChanges.new_success ?? 0, p.answerableChanges.regression ?? 0, `${p.pairedJudged}/${p.cases}`];
    })), '',
    `旧原段落诊断对照（相同问题；跳过提取，不能当完整链路）：${entries.map(entry => `${entryName[entry]} ${showRate(run.paragraphControlMatched.summary[`all:${entry}`].fullyCorrectAnswerable)}`).join('；')}。`, '',
    table(['阶段', '调用', '输入token', '输出token', '总token', '缺usage', '请求耗时累计秒'], Object.entries(run.usage.byPhase).map(([phase, u]) => [phase, u.requests, u.inputTokens, u.outputTokens, u.totalTokens, u.missingUsageRequests, scalar(u.sumRequestElapsedMs / 1000)])), '',
    `本次${run.usage.requests}次调用、${run.usage.reportedTokens.toLocaleString('en-US')}个已报告token；实际墙钟${run.usage.wallClockMs == null ? '未结束' : `${scalar(run.usage.wallClockMs / 60000)}分钟`}。并发请求耗时不能相加当墙钟。`, '',
    `问答错误码：${entries.map(entry => `${entryName[entry]} ${showCounts(run.outcomes[entry].allErrors)}`).join('；')}。`, '',
    `互斥首次损失标签：${entries.map(entry => `${entryName[entry]} ${showCounts(run.observedFirstLoss[entry])}`).join('；')}。这些标签用于排查，不能证明因果。`, ''];
  const repairs = run.evaluationRepairs;
  if (repairs.attemptedQuestions || repairs.extraRequests) {
    lines.push('### 评分器API格式重评记录', '',
      `历史有${repairs.attemptedQuestions}题、${repairs.attemptedStages}个阶段进入一次显式格式重评（${showCounts(repairs.phases)}）；额外${repairs.extraRequests}次请求、${repairs.extraReportedTokens.toLocaleString('en-US')}个已报告token，已包含在本运行总使用量。当前仍有评分错误${repairs.currentJudgeErrorQuestions}题。当前错误为0也不表示首轮没有坏JSON输出。`, '',
      '重评只覆盖原有parser/schema失败的评估阶段；原judgment和全部收据保留，不重跑合法评估阶段、生产提取或问答，不在多个合法分数间挑选。此次为评分格式恢复，不是生产重试，仍属于同模型自动评估。', '',
      table(['题号', '重评阶段', '原错误', '当前阶段错误', '新请求ID'], repairs.oldErrors.map(r => [r.questionId, r.phase, r.error ?? '未保存', r.currentError ?? (r.replacementStagePresent ? '无' : '尚无替换结果'), r.newReceiptIds.join(',')])), '',
      `重评收据中的生产请求：${repairs.productionRequestsAmongRepairs}；原始judgment保留：${repairs.previousJudgmentsPreserved ? '是' : '存在缺失，需审计'}。`, '');
  } else lines.push(`评分器API格式重评：无已记录重评；当前评分错误${repairs.currentJudgeErrorQuestions}题。`, '');
  const syntax = run.evaluationSyntaxRepairs;
  if (syntax.repairs) {
    lines.push('### 已缓存评分JSON的确定性语法恢复', '',
      `记录${syntax.repairs}条、涉及${syntax.questions}题（${showCounts(syntax.phases)}），收据ID：${syntax.receiptIds.join(', ')}。额外API调用0次、额外token为0；原响应本身的调用和usage已在总量中计算。`, '',
      '规则严格限定为在已收到的JSON末尾追加一个根对象右括号 `}`；随后执行原有schema和记忆ID白名单校验，不修改分数字符串或其他字段。原始收据、原文与修复文本SHA256均保留。这是离线/本地解析恢复，不是再次LLM评审或生产流程恢复；若发生在API格式重评之后，也不会再增加调用。', '',
      table(['题号', '阶段', '收据ID', '原错误', '原文本SHA256', '恢复文本SHA256'], syntax.records.map(r => [r.questionId, r.phase, r.receiptId, r.originalError ?? r.error, r.originalSha256, r.repairedSha256])), '',
      `符合单个右括号规则${syntax.singleBraceRuleRecords}/${syntax.repairs}条，完整记录双SHA256为${syntax.fingerprintedRecords}/${syntax.repairs}条。`, '');
  }
  return lines.join('\n');
}

export async function generateOptimizedReport(options) {
  validateOutputs(options);
  const manifest = await jsonFile(path.join(root, 'docs/memory-public-dataset-manifest.json'));
  const fixtureBytes = await readFile(path.resolve(root, manifest.fixture));
  if (hash(fixtureBytes) !== manifest.datasetSha256) throw new Error('Frozen fixture fingerprint changed');
  const fixture = JSON.parse(fixtureBytes);
  const [dev, baseline, control, gate, regressions, offline, initialDev, initialGate, initialRegressions] = await Promise.all([
    readPublicLiveReport(options.dev), readPublicLiveReport(options.baseline), readPublicLiveReport(options.control),
    jsonFile(options.gate, true), jsonFile(options.regressions, true), jsonFile(options.offline, true),
    options.initialDev ? readPublicLiveReport(options.initialDev) : null, jsonFile(options.initialGate), jsonFile(options.initialRegressions),
  ]);
  const full = options.full ? await readPublicLiveReport(options.full) : null;
  if (gate && gate.datasetSha256 !== manifest.datasetSha256) throw new Error('Gate fixture mismatch');
  const development = await buildOptimizedMetrics(dev, baseline, control, fixture);
  const initialDevelopment = initialDev ? await buildOptimizedMetrics(initialDev, baseline, control, fixture) : null;
  const completeRun = full ? await buildOptimizedMetrics(full, baseline, control, fixture) : null;
  const execution = assessOptimizedExecution({ dev, gate, full, datasetSha256: manifest.datasetSha256, gateFile: options.gate, fixture, initialGate });
  const downstreamChanged = Object.entries(development.pairedComparison.downstreamCodeUnchanged).filter(([, same]) => !same).map(([file]) => file);
  const productionChangesSinceInitial = initialDev ? [...new Set([...Object.keys(initialDev.productionSha256), ...Object.keys(dev.productionSha256)])].filter(file => initialDev.productionSha256[file] !== dev.productionSha256[file]) : null;
  const runArtifacts = [initialDev, dev, full].filter(Boolean);
  const uniqueRuns = [...new Map(runArtifacts.map(r => [r.workspace, r])).values()];
  const metrics = { version: 'memory-extraction-optimized-report-v2', createdAt: new Date().toISOString(), datasetSha256: manifest.datasetSha256,
    methodology: 'Actual production extraction, revision-bound organization, two production retrieval/QA entries, and isolated automatic post-hoc stages. Unedited ready proposals are confirmed only in isolated evaluation workspaces. Gold appears only in post-hoc judges. Anonymous paired answer scoring uses the same generating model, not independent validation. The previously examined 80 held-out questions are fixed regressions, not unseen blind evaluation. Paragraph control skips extraction and is diagnostic only.',
    inputs: Object.fromEntries(Object.entries(options).filter(([key, value]) => value && !['markdown', 'metrics'].includes(key)).map(([key, value]) => [key, relative(value)])),
    execution,
    developmentGate: gate, deterministicRegressionEvidence: regressions, offlineReplay: offline ? { ...offline, candidates: undefined } : null,
    initialDevelopment, initialDevelopmentGate: initialGate, initialDeterministicRegressionEvidence: initialRegressions,
    development, full: completeRun,
    revisionAttribution: { downstreamChangedFromLegacyBaseline: downstreamChanged, productionChangesSinceInitial,
      extractionOnlyComparison: downstreamChanged.length === 0,
      note: downstreamChanged.length ? 'This revision includes downstream QA changes. Measured gains belong to the combined extraction and QA revision; they do not isolate extraction-only effects.' : 'Tracked downstream files match the legacy baseline; extraction changes still include interacting budget/prompt/organization differences.' },
    totalNewRealUsage: { distinctRuns: uniqueRuns.length, requests: uniqueRuns.reduce((n, r) => n + r.receipts.length, 0),
      reportedTokens: uniqueRuns.reduce((n, r) => n + usage(r).reportedTokens, 0),
      note: 'Sum of distinct provided initial-development/current-development/full workspaces; legacy baseline and paragraph control excluded.' },
    scientificLimits: { semanticAssertionPrecision: null, independentHumanReview: false, unseenBlindEvaluation: false, longTermMemoryLifecycleEvaluated: false,
      notes: ['No independent assertion-level labels: precision remains null.', 'An exact source quote is provenance, not proof that every generated assertion follows.', 'All expected answerable cases remain denominators; missing judges and pipeline errors never count as correct.', 'The 9 unanswerable cases are a small sample and cannot establish general abstention reliability.', 'No organized-vector or reranker improvement was measured.', 'Repeated same-model judgments can drift; round-to-round score changes are not independent human validation.'] },
  };
  const selected = completeRun ?? development;
  const scope = selected.scope;
  const lines = ['# 提取预算与组织校验优化：真实LLM完整链路复测', '',
    `生成时间：${metrics.createdAt}。模型：\`${selected.model}\`。QASPER冻结数据，CC BY 4.0，[数据来源和适配](memory-public-datasets.md)。`, '',
    '## 执行范围与结论', '',
    `当前开发集：${dev.complete ? '已完成' : '未完成'}；预注册门槛：${gate ? gate.passed ? '通过' : '未通过' : '尚无门槛结果'}；门槛与开发工件匹配：${execution.gateMatchesDevelopment ? '是' : '否/未提供'}。`, '',
    full ? `已提供全量运行工件，实际记录${scope.observedQuestions}题；${execution.fullComplete ? '100题完整运行已完成。' : '全量尚未完整完成；按固定题集保留分母，缺失结果不计成功。'}全量与当前门槛/源码匹配：${execution.fullGateMatches ? '是' : '否，不能视为获准且同配置的最终回归'}。` : '本报告仅包含开发集；未提供100题全量运行结果，不能据此宣称完整链路在100题上的提升。只有当前第二轮通过原门槛，才能按同一源码进入全量。', '',
    `${scope.answerable}道可答题：${entries.map(entry => { const p = selected.pairedComparison.summary[`all:${entry}`]; return `${entryName[entry]}完整答对 ${p.beforeFullyCorrect.count}/${p.answerable} → ${p.afterFullyCorrect.count}/${p.answerable}`; }).join('；')}。${scope.unanswerable}道无答案题分别计分。`, '',
    '正文留存、检索与回答使用隔离上下文评分；答案新旧匿名配对评分。评分器仍是同一模型，尚无独立人工复核。原80题已参与问题分析，现为固定回归集。', '',
    `本次提供的${metrics.totalNewRealUsage.distinctRuns}个不同新运行工件合计${metrics.totalNewRealUsage.requests}次真实调用、${metrics.totalNewRealUsage.reportedTokens.toLocaleString('en-US')}个已报告token；不含历史baseline与原段落对照。`, '',
    '## 方案与边界', '',
    '提取采用2400字符窗口、6144输出token、12条记忆/4条任务/合计16条上限；Rust执行长度和数量校验，仅对明确输出容量错误有界拆分。任务限制512次请求、300万token和20分钟，缺usage及在途请求保守预留，恢复与还原保留预算高水位。逐批事务保存草稿，保留失败前成果；待确认候选和范围待审核草稿均不参与正式检索。', '',
    '仅导航topic错误可隔离标签并保留原值。主体、角色、条件、有效期问题转待审核；本次评测未代替人工修正或放行。正式记忆只来自实际模型ready候选的原样确认。研究论文中的语义断言精确率没有独立标签，本报告记为null。', '',
    downstreamChanged.length ? `当前修订改变了下游源码：${downstreamChanged.map(f => `\`${f}\``).join('、')}。第二轮包含提取和问答输入/协议修复，不再声称QA固定，不能将联合增益全部归因给提取。` : '受跟踪的下游QA源码与旧baseline一致；本轮提取预算、提示词、组织校验同时变化，仍无法据此拆出单项因果增益。', '',
  ];
  if (completeRun) {
    const before = completeRun.pairedComparison.extraction.before;
    const after = completeRun.pairedComparison.extraction.after;
    const retained = completeRun.retainedMemoryContent?.labels;
    const rows = [
      ['提取任务成功', `${before.statuses.succeeded ?? 0}/${before.papers}`, `${after.statuses.succeeded ?? 0}/${after.papers}`],
      ['正式记忆', before.formalMemories, after.formalMemories],
      ['正式记忆正文信息充分', '旧联合评分不作阶段归因', retained ? `${retained.yes ?? 0}/${completeRun.scope.answerable}充分，${retained.partial ?? 0}题部分保留` : '未测'],
      ...entries.map(e => [`${entryName[e]}实际生成参考充分`, '旧联合评分不作阶段归因', showRate(completeRun.outcomes[e].fullRetrieval)]),
      ...entries.map(e => [`${entryName[e]}完整答对`, showRate(completeRun.pairedComparison.summary[`all:${e}`].beforeFullyCorrect), showRate(completeRun.outcomes[e].completeCorrect)]),
      ...entries.map(e => [`${entryName[e]}无答案题正确拒答`, showRate(completeRun.pairedComparison.summary[`all:${e}`].beforeCorrectAbstention), showRate(completeRun.outcomes[e].correctAbstention)]),
      ['提取请求 / 已报告token', `${before.requests} / ${before.tokens.toLocaleString('en-US')}`, `${after.requests} / ${after.tokens.toLocaleString('en-US')}`],
    ];
    lines.push('## 完整100题：优化前后链路总览', '', table(['环节', '优化前', '优化后'], rows), '',
      `提取任务完成率明显提高，范围待审核${completeRun.extraction.scopeNeedsReview}条，未审草稿进入正式记忆${completeRun.extraction.unreviewedFormalMemories}条。记忆条数增加不是语义精确率的证明；该指标仍缺独立人工标签。`, '',
      `当前主要损失出现在检索和上下文选择：${retained?.yes ?? 0}题的正式记忆正文被评为充分，但实际生成参考仅桌面${completeRun.outcomes.desktop.fullRetrieval.count}题、飞书问答${completeRun.outcomes.connector.fullRetrieval.count}题充分。参考充分时，完整答对分别为${showRate(completeRun.outcomes.desktop.answerGivenFullShownEvidence)}和${showRate(completeRun.outcomes.connector.answerGivenFullShownEvidence)}。这是隔离自动评分得到的排查方向，尚不是单项因果验证。`, '',
      `无答案题存在明确退化：两个入口均从${showRate(completeRun.pairedComparison.summary['all:desktop'].beforeCorrectAbstention)}降到${showRate(completeRun.outcomes.desktop.correctAbstention)}。下一轮应同时改进检索候选与上下文组装、补充无答案拒答回归。当前完整回答结果仍低于跳过提取的原段落诊断对照；对照不代表真实完整链路。`, '');
    const sampleFile = path.join(root, completeRun.workspace, 'review-sample.json');
    const sample = await jsonFile(sampleFile, true);
    if (sample && sample.datasetSha256 === manifest.datasetSha256 && sample.binarySha256 === full.binarySha256) {
      lines.push(`已导出[定向人工复核样本](${path.relative(path.dirname(options.markdown), sampleFile).replaceAll('\\', '/')})：${sample.memories?.length ?? 0}条记忆/草稿、${sample.questions?.length ?? 0}道问题。样本按固定分层规则选取，尚无独立人工评定，不能估计总体精确率。`, '');
    }
  }
  if (initialDevelopment) {
    const old = initialDevelopment.historicalBaselineMatched;
    const rows = [
      ['旧baseline', old.extraction.formalMemories, '旧联合评分不作阶段归因', ...entries.map(e => showRate(old.summary[`all:${e}`].fullyCorrectAnswerable)), '不适用', old.extraction.requests ?? '详见旧工件', '旧工件', '历史结果'],
      ...[[initialDevelopment, '首轮：仅提取v5', initialGate], [development, '第二轮：提取v6＋QA输入/协议', gate]].map(([r, label, g]) => {
        const retained = r.retainedMemoryContent?.labels;
        return [label, r.extraction.formalMemories, retained ? `${(retained.yes ?? 0) + (retained.partial ?? 0)}/${r.scope.answerable}（yes或partial）` : '未测', ...entries.map(e => showRate(r.outcomes[e].completeCorrect)), r.extraction.scopeNeedsReview, r.usage.requests, r.usage.reportedTokens.toLocaleString('en-US'), g ? g.passed ? '通过' : '未通过' : '未提供'];
      }),
    ];
    lines.push('## 三阶段开发集对比', '', table(['修订', '正式记忆', '正文信息留存', '桌面完整正确', '飞书完整正确', '范围待审', '调用', 'token', '门槛'], rows), '',
      `首轮失败门槛与原始分数保留；第二轮门槛条件与首轮一致：${execution.gateThresholdsUnchangedSinceInitial == null ? '待核对' : execution.gateThresholdsUnchangedSinceInitial ? '是' : '否，存在改变'}。`, '',
      '各轮旧baseline答案会在同次匿名配对评分中重新打分，原始旧分与配对旧分均保存在机器JSON。同模型重复评分会漂移；首轮与第二轮并非同一次相互匿名配对，不能把二者差值当独立验证或单项因果增益。', '',
      runMarkdown('首轮开发集：提取v5（原始失败结果）', initialDevelopment));
  }
  lines.push(runMarkdown(initialDevelopment ? '第二轮开发集：提取v6＋QA输入/协议' : '开发集20题', development));
  if (completeRun) lines.push(runMarkdown('固定100题全量回归', completeRun));
  lines.push('## 确定性检查与旧候选离线回放', '',
    regressions ? `确定性检查：${regressions.passed ? '记录全部通过' : '存在失败或未完成'}；${regressions.commands?.length ?? 0}条命令。记录时间${regressions.finishedAt ?? '尚未结束'}。` : '未提供确定性检查工件，不能声明回归全部通过。', '');
  if (regressions?.commands) lines.push(table(['命令', '退出码', '日志'], regressions.commands.map(c => [c.command, c.exitCode, c.log])), '');
  if (initialRegressions) lines.push(`首轮确定性检查原始记录：${initialRegressions.passed ? '全部通过' : '有失败/未完成'}，${initialRegressions.commands?.length ?? 0}条命令，记录时间${initialRegressions.finishedAt ?? '未结束'}；保留于输入工件，不用第二轮记录覆盖。`, '');
  if (offline) lines.push(`冻结旧响应${offline.summary.candidates}条候选离线回放：${showCounts(offline.summary.categories)}；单候选ready由${offline.summary.oldReadyCandidates}增加到${offline.summary.readyCandidates}。`, '',
    `旧6000字符批次有${offline.summary.originalBatchQuantityOverflowReceipts}份响应、${offline.summary.originalBatchQuantityOverflowCandidates}条候选超出新批次数量容量，需重新提取。此回放没有新LLM调用，不能当成新完整链路结果或语义精确率。`, '');
  if (gate?.checks) lines.push('## 开发门槛记录', '', table(['检查', '通过', '观测'], gate.checks.map(c => [c.name, c.passed ? '是' : '否', JSON.stringify(c.actual)])), '');
  lines.push('## 局限与复现', '',
    '- 提取通过率、组织字段合法率和逐字引文匹配均不能代替事实正确率。语义断言精确率为null，独立人工复核未做。',
    '- 同模型隔离评分减少阶段混淆，仍可能误判；完整段落来源覆盖也不能代替答案所需信息覆盖。',
    '- 公开英文论文不等于中文真实业务数据；未覆盖长期更新、遗忘、实体歧义与全生命周期冲突。',
    '- 报告只读取已保存工件，不产生模型调用。复测命令会产生真实调用与费用。', '',
    `[机器指标与逐题变化](${path.basename(options.metrics)})；[旧完整链路报告](memory-public-live-report.md)；[旧原段落诊断对照](memory-public-live-control-summary.json)。`, '',
    '报告输入和所有阶段指标保存在机器JSON；完整原文、模型收据位于相应隔离workspace。生成命令：', '', '```powershell',
    `node scripts/report-memory-extraction-optimized.mjs --dev "${relative(options.dev)}"${options.full ? ` --full "${relative(options.full)}"` : ''}${options.initialDev ? ` --initial-dev "${relative(options.initialDev)}"` : ''}${options.initialGate ? ` --initial-gate "${relative(options.initialGate)}"` : ''}${options.initialRegressions ? ` --initial-regressions "${relative(options.initialRegressions)}"` : ''} --gate "${relative(options.gate)}" --regressions "${relative(options.regressions)}" --offline "${relative(options.offline)}"`, '```', '');
  await writeFile(options.metrics, `${JSON.stringify(metrics, null, 2)}\n`);
  await writeFile(options.markdown, lines.join('\n'));
  return { markdown: relative(options.markdown), metrics: relative(options.metrics), execution: metrics.execution,
    outcomes: Object.fromEntries(entries.map(entry => [entry, selected.outcomes[entry].completeCorrect])) };
}

function cli(args) {
  const defaults = { dev: 'docs/memory-public-live-optimized-dev-results.json', gate: 'docs/memory-public-live-optimized-dev-gate.json',
    regressions: 'docs/memory-extraction-optimized-regressions.json', offline: 'docs/memory-public-live-optimized-offline-replay.json',
    baseline: 'docs/memory-public-live-results.json', control: 'docs/memory-public-live-control-results.json',
    markdown: 'docs/memory-extraction-optimized-report.md', metrics: 'docs/memory-extraction-optimized-metrics.json' };
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, '').replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    if (!['full', 'initialDev', 'initialGate', 'initialRegressions', ...Object.keys(defaults)].includes(key) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Unknown or incomplete argument: ${args[i]}`);
    defaults[key] = args[i + 1];
  }
  const options = Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, path.resolve(root, value)]));
  validateOutputs(options);
  return options;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await generateOptimizedReport(cli(process.argv.slice(2))), null, 2));
}
