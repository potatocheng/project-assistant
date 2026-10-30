// Read-only reporting of this round. No provider requests or Engine writes.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readPublicLiveReport } from './memory-public-live-io.mjs';
import { buildOptimizedMetrics, assessOptimizedExecution } from './report-memory-extraction-optimized.mjs';

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
      supplementFailureCodes: count(current.map(({ value }) => trace(value)?.supplementStatus).filter(Boolean)),
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
  const registrationMatchesGate = !!registration && !!gate?.registration && stable(registration.thresholds) === stable(gate.registration.thresholds) && registration.registeredAt === gate.registration.registeredAt;
  const gatePrecedesFull = full ? Number.isFinite(Date.parse(gate?.recordedAt)) && Date.parse(gate.recordedAt) <= Date.parse(full.startedAt) : null;
  return { ...result, sameEvaluationRules, registrationMatchesGate, gatePrecedesFull,
    fullAuthorizedWithFrozenRules: !!full && result.fullGateMatches === true && sameEvaluationRules === true && registrationMatchesGate && gatePrecedesFull === true };
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

export function developmentReviewQueue(report) {
  const hypotheses = {
    '747b847': '仅答Europarl而未答CoNLL：题意、平行语料定义与标准答案口径可能不一致，需人工核验。',
    '50cc6c5': 'individual model与joint model粒度混淆；引用含目标事实，但最终答复或审查仍偏向联合模型。',
    '1be54c5': '说明了位置对应的独立decoder，但未显式回答位置本身是否作为输入；检索与答案评分口径也可能分歧。',
    '5daeb8d': '当前数据集与相关研究中的不同语言未分清，可能因主体绑定过严而拒答。',
    '521280a': '标注阶段五名annotators与整个流程六名experts混淆，可能将所问人数扩大到全流程。',
    '10fb7dc': '已引用所有候选义项逐对分类机制，但缺少直接说明可变义项数的结论；memory-only与retrieval-only亦分歧。',
    'd28d865': 'ROUGE平均分已出现，审查要求分项分数或更明确最优模型身份，可能增加未问的缺口并过度拒答。',
    'feafcc1': '首稿部分答案经核验，补查加入额外未知项后最终引用ID绑定失败并安全拒答；可能丢弃已核验部分答案。',
  };
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
  return { ...run, previousOriginal: originalRetrievalSnapshot(baseline, new Set(questionsOf(report).map(q => q.id))), previousUsage,
    evaluationEnvelopeNormalizations: summarizeEnvelopeNormalizations(report),
    questionComparison: retrievalQuestionRows(report, baseline), evaluationSha256: report.evaluationSha256,
    previousOperations: retrievalOperationalMetrics(baseline, new Set(questionsOf(report).map(q => q.id))), operations: retrievalOperationalMetrics(report),
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
    table(['入口', '旧→新QA请求', '旧→新QA token', '旧→新p50/p95毫秒', '旧→新实际补查生成题数', '旧→新可答题拒答数', '旧→新无答案题拒答数'], entries.map(entry => {
      const a = run.previousOperations[entry], b = run.operations[entry];
      return [name[entry], `${a.requests}→${b.requests}`, `${a.reportedTokens}→${b.reportedTokens}`, `${a.p50Ms}/${a.p95Ms}→${b.p50Ms}/${b.p95Ms}`, `${a.actualSupplementGenerationQuestions}→${b.actualSupplementGenerationQuestions}`, `${a.answerableRefusals}→${b.answerableRefusals}`, `${a.unanswerableRefusals}→${b.unanswerableRefusals}`];
    })), '',
    '这里“拒答数”是生产最终grounded/status观测，不等于正确拒答数；正确性在独立无答案分母中另计。“实际补查生成”须至少两次真实generation请求，不能把仅规划或空改写算作补查。', '',
    table(['入口', '旧→新规划补查题数', '旧→新额外检索轮数', '旧→新任一审查拒绝题数', '旧→新补查失败码'], entries.map(entry => {
      const a = run.previousOperations[entry], b = run.operations[entry];
      return [name[entry], `${a.supplementPlanningQuestions}→${b.supplementPlanningQuestions}`, `${a.tracedExtraRetrievalRounds}→${b.tracedExtraRetrievalRounds}`, `${a.anyRejectedReviewQuestions}→${b.anyRejectedReviewQuestions}`, `${counts(a.supplementFailureCodes)}→${counts(b.supplementFailureCodes)}`];
    })), '', '补查失败可被生产流程安全转换为unknown，因此不能只看顶层error计数；这里单列queryTrace.supplementStatus。', '',
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
    `memory-only未判yes而retrieval-only判yes的隔离评分分歧${run.isolatedJudgeDisagreementCases.length}个入口案例。它提示评分不一致，不能据此断言“未存储的信息被检索出来”或作严格因果归因。逐例ID保存在机器JSON。`, '',
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
    table(['入口', '旧原始完整正确', '同次重评旧答案', '本轮完整正确', '配对净增题数', '配对新增 / 退化'], entries.map(entry => {
      const p = run.pairedComparison.summary[`all:${entry}`];
      return [name[entry], rate(old.outcomes[entry].complete), rate(p.beforeFullyCorrect), rate(p.afterFullyCorrect), p.afterFullyCorrect.count - p.beforeFullyCorrect.count, `${p.answerableChanges.new_success ?? 0} / ${p.answerableChanges.regression ?? 0}`];
    })), '',
    '### 同一次100题运行中的开发20题与固定回归80题', '',
    table(['集合 / 入口', '题数（可答/无答案）', '旧原始完整正确', '配对旧答案→本轮', '旧→新参考充分', '旧→新正确拒答'], ['development', 'holdout'].flatMap(split => entries.map(entry => {
      const s = run.splits[split], a = s.previousOriginal.outcomes[entry], b = s.current.outcomes[entry], p = s.paired[entry];
      return [`${split === 'development' ? '开发20' : '固定回归80'} / ${name[entry]}`, `${s.questions}（${s.current.answerable}/${s.current.unanswerable}）`, rate(a.complete), `${rate(p.beforeFullyCorrect)}→${rate(p.afterFullyCorrect)}`, `${rate(a.referencesSufficient)}→${rate(b.referencesSufficient)}`, `${rate(a.abstention)}→${rate(b.abstention)}`];
    }))), '',
    '这两组来自同一个完整100题工件，不把单独开发运行的20题分数拼入100题。80题此前已看过，继续作为固定回归，不能称为未见盲测。生产上下文与审查预算增加，需结合QA调用、token和延迟看收益。', '',
  ];
  return lines.join('\n');
}

export async function generateRetrievalReport(options) {
  for (const [key, expected] of [['markdown', 'memory-retrieval-optimized-report.md'], ['metrics', 'memory-retrieval-optimized-metrics.json']]) {
    if (path.dirname(options[key]) !== path.join(root, 'docs') || path.basename(options[key]) !== expected) throw new Error('Only dedicated retrieval-round report outputs are permitted');
  }
  const registrationBytes = await readFile(path.join(root, 'docs/memory-retrieval-preregistration.json'));
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
  const execution = assessRetrievalExecution({ dev, gate, full, registration, fixture, datasetSha256: registration.datasetSha256, gateFile: options.gate });
  const runs = [initialDevelopment, development, complete].filter(Boolean);
  const developmentManualReviewQueue = developmentReviewQueue(dev);
  const developmentUsage = distinctRetrievalRunUsage([initialDevelopment, development]);
  const metrics = { version: 'memory-retrieval-optimized-report-v1', createdAt: new Date().toISOString(), datasetSha256: registration.datasetSha256,
    inputs: Object.fromEntries(Object.entries(options).filter(([key, value]) => value && !['markdown', 'metrics'].includes(key)).map(([key, value]) => [key, relative(value)])),
    registration, registrationSha256: hash(registrationBytes), execution, gate, deterministicRegressionEvidence: regressions, sameMemoryDiagnostic,
    initialDevelopment, initialDevelopmentGate: initialGate, development, full: complete,
    developmentManualReviewQueue,
    sharedDevelopmentBudget: { ...developmentUsage, limits: registration.limits.development,
      withinRequestLimit: developmentUsage.requests <= registration.limits.development.maxRequests,
      withinTokenLimit: developmentUsage.reportedTokens <= registration.limits.development.maxTokens },
    usage: distinctRetrievalRunUsage(runs),
    limitations: { independentHumanReview: false, unseenBlindEvaluation: false, semanticAssertionPrecision: null, sameMemoryCausalIsolation: false,
      notes: ['Same-model isolated automatic evaluation; possible judge drift.', 'Old original and current paired baseline grades both retained.', 'Extraction is rerun and may drift despite unchanged code.', 'Production QA budgets increased; results are not an equal-cost comparison.', 'Previously examined 100 questions are fixed regressions, not unseen blind evaluation.', 'Nine unanswerable questions cannot establish general refusal reliability.'] } };
  const lines = ['# 检索、上下文与拒答：真实LLM完整链路对比', '', `生成时间：${metrics.createdAt}。模型：\`${development.model}\`。QASPER冻结公开数据，CC BY 4.0，[来源与适配](memory-public-datasets.md)。`, '',
    `20题开发集：${dev.complete ? '完成' : '未完成'}；预注册门槛：${gate.passed ? '通过' : '未通过'}。${full ? `100题：${execution.fullComplete ? '完成' : '尚未完整完成'}；相同生产代码、二进制、评分规则与门槛按顺序运行：${execution.fullAuthorizedWithFrozenRules ? '是' : '否，不能作为获准最终回归'}` : '本报告尚无100题运行工件，不宣称完整100题提升'}。`, '',
    '本轮实际重新执行提取、记忆组织、两个生产问答入口和隔离评分。提取实现保持不变，随机输出仍可能改变；新旧差值属于完整链路联合结果。原80题已参与分析，当前是固定回归集。自动评分使用同一模型，未独立人工复核。', '',
    '## 预算与实现归因', '', '本轮检索继续使用无向量方案。聚焦问答最多24条参考、36000模型参考字符；桌面总览保留40条总参考/40000字符，其中正式记忆至多24条。问题、schema及封装另计入累计输入预算。每个grounded模型回答必须审查，本地结构化字段直读保留；证据不足或审查失败最多一次定向补查。生产QA最多5次模型调用、累计180000输入字符；60000报告token是调用后停止阈值，单个请求可越过后被拒绝输出，不是请求前硬预留。保留原超时；上轮为4次调用及较小输入预算。报告列出实际成本，不能视为等成本收益。', '',
    `本次提供的${metrics.usage.distinctRuns}个不同运行（含已提供失败pilot、新开发及全量）共${metrics.usage.requests}次真实调用、${metrics.usage.reportedTokens}个已报告token；不含上一轮基线。`, '',
  ];
  if (complete) lines.push(fullOverviewMarkdown(complete));
  lines.push(runMarkdown('单独开发集20题', development));
  if (developmentManualReviewQueue.length) lines.push('## 开发集人工复核待办', '',
    `独立开发20题中，自动判参考充分但未完整答对的${developmentManualReviewQueue.reduce((n, row) => n + row.entries.length, 0)}个入口结果涉及${developmentManualReviewQueue.length}道题。下表仅是排查假设，尚未人工评定，不据此改分，也不用于修改当前冻结代码或完整100题运行。`, '',
    table(['题号', '入口', '生产收据ID', '待核验假设', '人工评定'], developmentManualReviewQueue.map(row => [row.id, row.entries.map(e => name[e]).join('、'), row.receiptIds.join(', '), row.hypothesis, '未做'])), '');
  if (initialDevelopment) {
    lines.push('## 已保留的首轮试运行与评分器协议修订', '',
      `首轮pilot完整执行标志${initialDevelopment.complete}，${initialDevelopment.usage.requests}次真实调用、${initialDevelopment.usage.reportedTokens}个已报告token；门槛${initialGate ? initialGate.passed ? '通过（需核查）' : '未通过' : '未提供通过记录'}。原始失败、显式格式重评和所有额外费用均保留，不通过新解析器回填首轮或将其算为通过。`, '',
      `两次开发合计${developmentUsage.requests}/${registration.limits.development.maxRequests}次请求、${developmentUsage.reportedTokens}/${registration.limits.development.maxTokens}个报告token，共享原开发预算；完整100题另按注册上限执行。`, '',
      '首轮评分器对完整flat system1/system2对象判为schema失败。修订后的新运行只增加精确无损外层包装，并按原数值门槛重新完成整个20题；[协议修订说明](memory-retrieval-evaluator-amendment.md)。不能声称整个开发过程从未调整评测器接纳规则。', '',
      runMarkdown('首轮失败pilot（原始结果）', initialDevelopment));
  }
  if (sameMemoryDiagnostic) {
    lines.push('## 相同旧记忆的本地检索诊断', '',
      table(['入口', '旧→新任一相关ID命中', '旧→新全部相关ID命中', '去facets的全部ID命中', '旧→新参考条数总和'], entries.map(entry => {
        const s = sameMemoryDiagnostic.summary[entry];
        return [name[entry], `${s.variants.previous.any}→${s.variants.normal.any}/${s.withKnownRelevantIds}`, `${s.variants.previous.all}→${s.variants.normal.all}/${s.withKnownRelevantIds}`, `${s.variants.withoutFacets.all}/${s.withKnownRelevantIds}`, `${s.variants.previous.totalShown}→${s.variants.normal.totalShown}`];
      })), '',
      '这项只读诊断复用上一轮正式记忆及最后一次真实rewrite，无模型调用；规范ID优先取memoryId，桌面memory:前缀不作为另一个记忆。相关ID来自上一轮事后memory-only评分，未传入检索。ID命中不能代替语义充分、回答正确或独立人工验证；新上下文更大，不能视为等成本收益。去facets只在RAM诊断，正式路径保留条件、实体和有效期。', '');
  }
  if (complete) lines.push(runMarkdown('完整100题', complete));
  lines.push('## 确定性检查与门槛', '', `确定性检查${regressions.passed ? '通过' : '未通过'}，${regressions.commands?.length ?? 0}条命令。评分规则指纹和源码/二进制指纹保存在机器JSON。`, '',
    table(['命令', '退出码', '日志'], (regressions.commands ?? []).map(c => [c.command, c.exitCode, c.log])), '',
    table(['门槛', '通过', '实际观测'], gate.checks.map(c => [c.name, c.passed ? '是' : '否', JSON.stringify(c.actual)])), '',
    regressions.sameMemoryDiagnostic ? `同记忆本地只读诊断：\`${regressions.sameMemoryDiagnostic}\`。复用上一轮真实记忆和已记录rewrite，不调用LLM；normal/withoutFacets结果仅排查检索，不替代本轮重新提取的完整链路分数。` : '未提供同记忆诊断。', '',
    `完整指标、逐题变化、评分修复审计：[机器JSON](${path.basename(options.metrics)})。[上一轮完整链路报告](memory-extraction-optimized-report.md)。`, '',
    '## 限制', '', '- 参考充分和答案正确均是自动评分，不能代替独立人工标注；断言精确率未测。', '- 9道无答案题样本很小，拒答改进或退化均单列；不得混入91道可答题准确率。', '- 公开英文论文不等于中文业务记忆；未覆盖长期冲突、更新、遗忘与全生命周期。', '- 报告生成只读取保存工件，不产生真实模型调用。', '');
  await writeFile(options.metrics, JSON.stringify(metrics, null, 2));
  await writeFile(options.markdown, lines.join('\n'));
  return { markdown: relative(options.markdown), metrics: relative(options.metrics), execution };
}

function cli(args) {
  const options = { dev: 'docs/memory-public-live-retrieval-dev-results.json', gate: 'docs/memory-public-live-retrieval-dev-gate.json',
    regressions: 'docs/memory-retrieval-optimized-regressions.json', markdown: 'docs/memory-retrieval-optimized-report.md', metrics: 'docs/memory-retrieval-optimized-metrics.json' };
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, '');
    if (!['dev', 'gate', 'full', 'initial-dev', 'initial-gate', 'regressions', 'markdown', 'metrics'].includes(key) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Unknown or incomplete argument ${args[i]}`);
    options[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = args[i + 1];
  }
  return Object.fromEntries(Object.entries(options).map(([key, value]) => [key, path.resolve(root, value)]));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) console.log(JSON.stringify(await generateRetrievalReport(cli(process.argv.slice(2))), null, 2));
