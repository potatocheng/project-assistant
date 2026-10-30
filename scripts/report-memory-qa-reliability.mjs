// Read-only comparison of the separately registered, single fresh20 run.
import {readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {readPublicLiveReport} from './memory-public-live-io.mjs';
import {summarize} from './score-memory-qa-structured-live.mjs';
import {comparePublicLive} from './compare-memory-public-live.mjs';
import {structuredOperationalObservations} from './memory-qa-structured-observations.mjs';

const ENTRIES = ['desktop', 'connector'];
const PHASES = ['all', 'extraction', 'qa', 'judge'];
const LABELS = ['yes', 'partial', 'no', 'uncertain'];
const DEFAULT_BASELINE = 'docs/memory-public-live-qa-structured-dev-v3-results.json';
const hash = value => createHash('sha256').update(value).digest('hex');
const questions = report => report.documents.flatMap(p => p.questions.map(q => ({...q, paperId:p.id})));
const counts = values => values.reduce((out, value) => {out[value] = (out[value] ?? 0) + 1; return out;}, {});
const rate = (count, denominator) => ({count, denominator, rate:denominator ? count / denominator : null});
const validTokens = value => Number.isSafeInteger(value) && value >= 0;
const tokenField = (...values) => values.find(validTokens) ?? null;

export function reliabilityCosts(report) {
  return Object.fromEntries(PHASES.map(phase => {
    const receipts = report.receipts.filter(r => phase === 'all' || r.phase === phase);
    const values = receipts.map(r => ({
      totalTokens:tokenField(r.usage?.total_tokens),
      inputTokens:tokenField(r.usage?.prompt_tokens, r.usage?.input_tokens),
      outputTokens:tokenField(r.usage?.completion_tokens, r.usage?.output_tokens),
      cachedInputTokens:tokenField(r.usage?.prompt_cache_hit_tokens, r.usage?.prompt_tokens_details?.cached_tokens, r.usage?.input_tokens_details?.cached_tokens),
    }));
    const fields = ['totalTokens', 'inputTokens', 'outputTokens', 'cachedInputTokens'];
    return [phase, {
      requests:receipts.length,
      failedRequests:receipts.filter(r => r.error || (Number.isInteger(r.status) && r.status >= 400)).length,
      ...Object.fromEntries(fields.map(field => [field, values.reduce((sum, value) => sum + (value[field] ?? 0), 0)])),
      missingUsage:values.filter(value => ['totalTokens', 'inputTokens', 'outputTokens'].some(field => value[field] === null)).length,
      missingByField:Object.fromEntries(fields.map(field => [field, values.filter(value => value[field] === null).length])),
      interpretation:'Token sums contain recorded nonnegative integer usage only; missing fields are counted explicitly. Cached input is a subset of input, never added to total.',
    }];
  }));
}

export function answerStageJudgment(judgment, arm, entry) {
  const order = judgment?.anonymousOrder;
  const index = Array.isArray(order) && order.filter(value => value === arm).length === 1 ? order.indexOf(arm) : -1;
  const system = index >= 0 ? `system${index + 1}` : null;
  const value = system ? judgment?.stages?.answer?.systems?.[system]?.[entry] : null;
  return {system, answerCorrect:value?.answerCorrect ?? null, reason:value?.reason ?? null,
    source:value ? `stages.answer.systems.${system}.${entry}` : 'missing_answer_stage'};
}

function memoryLabels(report) {
  const selected = questions(report).filter(q => q.answerable);
  const byId = new Map(report.judgments.map(j => [j.id, j]));
  const distribution = Object.fromEntries([...LABELS, 'missing'].map(label => [label, 0]));
  for (const q of selected) {
    const label = byId.get(q.id)?.memorySufficiency;
    distribution[LABELS.includes(label) ? label : 'missing']++;
  }
  return {denominator:selected.length, distribution, yes:rate(distribution.yes, selected.length),
    yesOrPartial:rate(distribution.yes + distribution.partial, selected.length)};
}

function strictPairedSummary(comparison) {
  return Object.fromEntries(ENTRIES.map(entry => {
    const rows = comparison.rows.filter(row => row.entry === entry);
    const positive = rows.filter(row => row.answerable), negative = rows.filter(row => !row.answerable);
    return [entry, {
      cases:rows.length, pairedJudged:rows.filter(row => row.pairedGrade).length,
      beforeFullyCorrect:rate(positive.filter(row => row.pairedGrade && row.oldCorrect).length, positive.length),
      afterFullyCorrect:rate(positive.filter(row => row.newCorrect).length, positive.length),
      beforeCorrectAbstention:rate(negative.filter(row => row.pairedGrade && row.oldCorrect).length, negative.length),
      afterCorrectAbstention:rate(negative.filter(row => row.newCorrect).length, negative.length),
      answerableChanges:counts(positive.map(row => row.pairedGrade ? row.change : 'not_paired')),
      missingPaired:rows.filter(row => !row.pairedGrade).map(row => row.id),
    }];
  }));
}

function executionEvidence(report) {
  return {outputTag:report.outputTag, workspace:report.workspace, binarySha256:report.binarySha256,
    productionSha256:structuredClone(report.productionSha256 ?? {}), evaluationSha256:structuredClone(report.evaluationSha256 ?? {}),
    preLiveEvidence:structuredClone(report.preLiveEvidence ?? null), model:report.model, actualModels:structuredClone(report.actualModels ?? []),
    complete:report.complete, startedAt:report.startedAt, finishedAt:report.finishedAt, haltReason:report.haltReason ?? null};
}

export function buildReliabilityMetrics(current, baseline, fixture = null) {
  const originalOnly = {...current, judgments:current.judgments.map(({baselineEntries, ...judgment}) => judgment)};
  const originalComparison = comparePublicLive(originalOnly, baseline);
  const pairedComparison = comparePublicLive(current, baseline);
  const currentSummary = summarize(current, fixture), baselineOriginalSummary = summarize(baseline, fixture);
  const currentObservations = structuredOperationalObservations(current), baselineObservations = structuredOperationalObservations(baseline);
  const oldQuestions = new Map(questions(baseline).map(q => [q.id, q]));
  const oldJudges = new Map(baseline.judgments.map(j => [j.id, j]));
  const newJudges = new Map(current.judgments.map(j => [j.id, j]));
  const rowKey = row => `${row.id}:${row.entry}`;
  const originalRows = new Map(originalComparison.rows.map(row => [rowKey(row), row]));
  const pairedRows = new Map(pairedComparison.rows.map(row => [rowKey(row), row]));
  const cases = questions(current).flatMap(q => ENTRIES.map(entry => {
    const old = oldQuestions.get(q.id), previous = oldJudges.get(q.id), next = newJudges.get(q.id);
    const original = originalRows.get(`${q.id}:${entry}`), paired = pairedRows.get(`${q.id}:${entry}`);
    const answer = value => ({text:value?.result?.answer ?? null, status:value?.result?.status ?? null,
      errorCode:value?.errorCode ?? null, error:value?.error ?? null});
    return {id:q.id, paperId:q.paperId, question:q.question, entry, answerable:q.answerable,
      baselineOriginalGrade:original.before, baselinePairedGrade:paired.pairedGrade ? paired.before : 'not_judged', currentGrade:paired.after,
      originalChange:original.change, pairedChange:paired.pairedGrade ? paired.change : 'not_paired',
      baselineAnswer:answer(old.entries?.[entry]), currentAnswer:answer(q.entries?.[entry]),
      reasons:{baselineOriginal:answerStageJudgment(previous, 'current', entry), baselinePaired:answerStageJudgment(next, 'baseline', entry), current:answerStageJudgment(next, 'current', entry)},
      memory:{baseline:previous?.memorySufficiency ?? 'missing', current:next?.memorySufficiency ?? 'missing',
        baselineReason:previous?.stages?.memory?.reason ?? null, currentReason:next?.stages?.memory?.reason ?? null},
      retrieval:{baseline:previous?.entries?.[entry]?.retrievalSufficiency ?? 'missing', current:next?.entries?.[entry]?.retrievalSufficiency ?? 'missing',
        baselineReason:previous?.stages?.retrieval?.entries?.[entry]?.reason ?? null, currentReason:next?.stages?.retrieval?.entries?.[entry]?.reason ?? null},
    };
  }));
  const protocol = (summary, observations, report) => ({
    answer:Object.fromEntries(ENTRIES.map(entry => [entry, summary.summary[`all:${entry}`].protocolErrors])),
    review:Object.fromEntries(ENTRIES.map(entry => [entry, observations.perEntry[entry].reviewFailures])),
    judgeErrors:summary.judgeErrors,
    failedJudgeRequests:report.receipts.filter(r => r.phase === 'judge' && (r.error || (Number.isInteger(r.status) && r.status >= 400))).map(r => ({index:r.index, task:r.task, questionId:r.questionId, status:r.status, error:r.error ?? null})),
  });
  return {version:'memory-qa-reliability-metrics-v1', createdAt:new Date().toISOString(), datasetSha256:current.datasetSha256,
    scope:{currentRunTag:current.outputTag, questions:questions(current).length, answerable:questions(current).filter(q => q.answerable).length,
      unanswerable:questions(current).filter(q => !q.answerable).length, full100Executed:false},
    methodology:'One fresh20 extraction/confirmation/retrieval/generation/review/answer run against the historical baseline. Historical original labels and same-call anonymous paired answer labels remain separate. Memory/retrieval labels are distinct original-run estimates, not paired rescoring. These are development regression cases and same-model automatic judgments, not blind evaluation, human truth, or causal attribution.',
    current:executionEvidence(current), baseline:executionEvidence(baseline), currentSummary, baselineOriginalSummary,
    comparisons:{historicalOriginal:originalComparison, anonymousPaired:pairedComparison, strictAnonymousPaired:strictPairedSummary(pairedComparison)},
    memory:{baseline:memoryLabels(baseline), current:memoryLabels(current)}, costs:{baseline:reliabilityCosts(baseline), current:reliabilityCosts(current)},
    observations:{baseline:baselineObservations, current:currentObservations},
    protocol:{baseline:protocol(baselineOriginalSummary, baselineObservations, baseline), current:protocol(currentSummary, currentObservations, current)}, cases};
}

const cell = value => String(value ?? '未记录').replaceAll('|', '\\|').replaceAll('\r', '').replaceAll('\n', '<br>');
const table = (headers, rows) => [`| ${headers.map(cell).join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map(row => `| ${row.map(cell).join(' | ')} |`)].join('\n');
const showRate = value => `${value.count}/${value.denominator}`;
const entryName = entry => entry === 'desktop' ? '桌面' : '飞书';

export function reliabilityMarkdown(metrics) {
  const lines = ['# 记忆系统可靠性：一次20题真实链路比较', '',
    `本轮 ${metrics.scope.currentRunTag}：${metrics.scope.questions}题，其中${metrics.scope.answerable}题可答、${metrics.scope.unanswerable}题无答案。完整执行：${metrics.current.complete}。100题未执行。`, '',
    '本报告保留历史原始评分与本次匿名配对旧答案评分。两轮重新提取和模型输出可能不同，不能把变化全部归因于代码；本次没有新增盲测或人工复核。记忆与检索评分为各次原始自动评分，不声称同次配对净增。', '',
    `当前 binary：${metrics.current.binarySha256 ?? '未记录'}；baseline binary：${metrics.baseline.binarySha256 ?? '未记录'}。执行源码、评测源码和测试证据见机器 metrics，均来自各次运行记录。`, '',
    '## 答案质量', '', table(['入口', '指标', '历史原评', '本次旧答案匿名配对', '本轮'], ENTRIES.flatMap(entry => {
      const old = metrics.baselineOriginalSummary.summary[`all:${entry}`], next = metrics.currentSummary.summary[`all:${entry}`], paired = metrics.comparisons.strictAnonymousPaired[entry];
      return [[entryName(entry), '可答题完整正确', showRate(old.fullyCorrectAnswerable), showRate(paired.beforeFullyCorrect), showRate(next.fullyCorrectAnswerable)],
        [entryName(entry), '无答案题正确拒答', showRate(old.correctAbstention), showRate(paired.beforeCorrectAbstention), showRate(next.correctAbstention)],
        [entryName(entry), '匿名配对已评分', '—', `${paired.pairedJudged}/${paired.cases}`, '—'],
        [entryName(entry), '检索参考充分 yes', showRate(old.rawJudgeStageLabels.fullRetrievalCoverage), '未重评旧参考包', showRate(next.rawJudgeStageLabels.fullRetrievalCoverage)]];
    })), '', '缺失的匿名配对评分不以旧原评分冒充；所有可答题保留在分母。partial 与完整正确分开。', '',
    '## 记忆留存', '', table(['轮次', 'yes', 'partial', 'no', 'uncertain', '缺失', '严格 yes', 'yes + partial'], ['baseline', 'current'].map(arm => {
      const value = metrics.memory[arm], d = value.distribution;
      return [arm === 'baseline' ? '历史原评' : '本轮', d.yes, d.partial, d.no, d.uncertain, d.missing, showRate(value.yes), showRate(value.yesOrPartial)];
    })), '', '记忆按可答问题计数一次，两个入口不重复计数；yes + partial 不标为完整保留。', '',
    '## 请求与 token 使用量', '', '统计包含成功、失败和重试请求。缺失usage不估算为零；下表token数是已记录字段之和，带“已知”表示仍有缺失。cache是input的子集，不重复加入总量。', '',
    table(['阶段', '轮次', '请求', '失败请求', 'total', 'input', 'output', 'cache input', 'usage不完整', '字段缺失(total/input/output/cache)'], PHASES.flatMap(phase => ['baseline', 'current'].map(arm => {
      const c = metrics.costs[arm][phase], fields = ['totalTokens', 'inputTokens', 'outputTokens', 'cachedInputTokens'];
      return [phase, arm === 'baseline' ? '历史' : '本轮', c.requests, c.failedRequests,
        ...fields.map(field => `${c[field]}${c.missingByField[field] ? '（已知）' : ''}`), c.missingUsage, fields.map(field => c.missingByField[field]).join('/')];
    }))), '', '## 链路与协议', '', table(['指标', '历史', '本轮'], [
      ['提取状态', JSON.stringify(metrics.baselineOriginalSummary.extraction.statuses), JSON.stringify(metrics.currentSummary.extraction.statuses)],
      ['正式记忆条数', metrics.baselineOriginalSummary.extraction.formalMemories, metrics.currentSummary.extraction.formalMemories],
      ['QA只读', metrics.baselineOriginalSummary.extraction.qaReadOnly, metrics.currentSummary.extraction.qaReadOnly],
      ...ENTRIES.flatMap(entry => [[`${entryName(entry)}答案协议错误`, JSON.stringify(metrics.protocol.baseline.answer[entry]), JSON.stringify(metrics.protocol.current.answer[entry])],
        [`${entryName(entry)}审查协议错误`, JSON.stringify(metrics.protocol.baseline.review[entry]), JSON.stringify(metrics.protocol.current.review[entry])]]),
      ['最终judge错误', metrics.protocol.baseline.judgeErrors.length, metrics.protocol.current.judgeErrors.length],
      ['失败judge请求（含后来成功的重试）', metrics.protocol.baseline.failedJudgeRequests.length, metrics.protocol.current.failedJudgeRequests.length],
    ]), '', '## 逐题变化与原始理由', '',
    '以下答案理由只取各报告 stages.answer.systems，按各自 anonymousOrder 映射；不使用被检索阶段覆盖的 entries.reason。未记录的理由明确保留为空缺。旧原评与旧配对针对同一条历史答案；原始标签不被重新覆盖。', ''];
  for (const row of metrics.cases) {
    lines.push(`### ${row.id} · ${entryName(row.entry)} · ${row.answerable ? '可答' : '无答案'}`, '', row.question, '',
      table(['历史原评', '本次旧配对', '本轮', '相对原评变化', '相对配对变化'], [[row.baselineOriginalGrade, row.baselinePairedGrade, row.currentGrade, row.originalChange, row.pairedChange]]), '',
      table(['内容', '原始记录'], [['历史答案', row.baselineAnswer.text], ['本轮答案', row.currentAnswer.text],
        ['历史答案原评理由', row.reasons.baselineOriginal.reason], ['历史答案本次匿名配对理由', row.reasons.baselinePaired.reason], ['本轮答案理由', row.reasons.current.reason],
        ['历史记忆标签 / 理由', `${row.memory.baseline} / ${row.memory.baselineReason ?? '未记录'}`], ['本轮记忆标签 / 理由', `${row.memory.current} / ${row.memory.currentReason ?? '未记录'}`],
        ['历史检索标签 / 理由', `${row.retrieval.baseline} / ${row.retrieval.baselineReason ?? '未记录'}`], ['本轮检索标签 / 理由', `${row.retrieval.current} / ${row.retrieval.currentReason ?? '未记录'}`]]), '');
  }
  lines.push('## 审计文件', '', `机器指标：[memory-qa-reliability-metrics.json](memory-qa-reliability-metrics.json)。`,
    `当前原始报告：${metrics.inputs?.current?.file ?? '未提供'}；历史原始报告：${metrics.inputs?.baseline?.file ?? '未提供'}。`,
    `完整性校验：${metrics.integrity ? `${metrics.integrity.file}；通过=${metrics.integrity.currentResult.passed === true}` : '未提供，不能据此声称完整性校验通过'}。`,
    `本轮预算：${metrics.budget ? '已由独立可靠性登记校验；明细见 metrics。' : '未附登记校验结果。'}`, '');
  return lines.join('\n');
}

export function parseReliabilityArgs(args) {
  const result = {baseline:DEFAULT_BASELINE, current:null, integrity:null};
  const seen = new Set();
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i];
    if (!['--current', '--baseline', '--integrity'].includes(name) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Use --current REPORT [--baseline REPORT] [--integrity FILE]');
    const field = name.slice(2);
    if (seen.has(field)) throw new Error(`Duplicate ${name}`);
    seen.add(field);
    result[field] = args[i + 1];
  }
  if (!result.current) throw new Error('--current REPORT is required');
  return result;
}

export async function generateReliabilityReport(args = process.argv.slice(2)) {
  const options = parseReliabilityArgs(args), root = path.resolve(import.meta.dirname, '..');
  const currentFile = path.resolve(root, options.current), baselineFile = path.resolve(root, options.baseline);
  const [current, baseline, currentBytes, baselineBytes] = await Promise.all([
    readPublicLiveReport(currentFile), readPublicLiveReport(baselineFile), readFile(currentFile), readFile(baselineFile),
  ]);
  if (current.outputTag !== 'qa-reliability-dev' || questions(current).length !== 20 || questions(current).filter(q => q.answerable).length !== 19 || current.split !== 'development') throw new Error('Reliability report requires the registered qa-reliability-dev fresh20 scope (19 answerable, one unanswerable)');
  if (!current.baseline || path.resolve(root, current.baseline.file) !== baselineFile || current.baseline.workspace !== baseline.workspace || current.baseline.binarySha256 !== baseline.binarySha256) throw new Error('Report paired baseline differs from the supplied historical baseline');
  const manifest = JSON.parse(await readFile(path.join(root, 'docs/memory-public-dataset-manifest.json')));
  const fixture = JSON.parse(await readFile(path.resolve(root, manifest.fixture)));
  const metrics = buildReliabilityMetrics(current, baseline, fixture);
  metrics.inputs = {current:{file:path.relative(root, currentFile), sha256:hash(currentBytes)}, baseline:{file:path.relative(root, baselineFile), sha256:hash(baselineBytes)}};
  const {verifyQaReliabilityRecordedBudget} = await import('./memory-qa-reliability-evaluation.mjs');
  metrics.budget = await verifyQaReliabilityRecordedBudget(root, current);
  if (options.integrity) {
    const file = path.resolve(root, options.integrity), bytes = await readFile(file), record = JSON.parse(bytes);
    const currentResult = record.results?.find(result => path.resolve(root, result.file) === currentFile);
    if (!currentResult || currentResult.sha256 !== metrics.inputs.current.sha256) throw new Error('Integrity record is not bound to the current report bytes');
    metrics.integrity = {file:path.relative(root, file), sha256:hash(bytes), currentResult, record};
  } else metrics.integrity = null;
  const output = path.join(root, 'docs/memory-qa-reliability-metrics.json'), markdown = path.join(root, 'docs/memory-qa-reliability-report.md');
  if ([currentFile, baselineFile, options.integrity && path.resolve(root, options.integrity)].some(file => [output, markdown].includes(file))) throw new Error('Output must not overwrite an input artifact');
  await writeFile(output, JSON.stringify(metrics, null, 2));
  await writeFile(markdown, reliabilityMarkdown(metrics));
  console.log(JSON.stringify({report:path.relative(root, markdown), metrics:path.relative(root, output), complete:current.complete, full100Executed:false}));
  return metrics;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await generateReliabilityReport();
