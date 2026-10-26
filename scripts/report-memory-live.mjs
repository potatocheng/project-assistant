// Report generation only: this script never calls a model.
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const resultBytes = await readFile(path.join(root, 'docs/memory-live-evaluation-results.json'));
const report = JSON.parse(resultBytes);
const reviewFile = path.join(root, 'docs/memory-live-evaluation-review.json');
const savedReview = existsSync(reviewFile) ? JSON.parse(await readFile(reviewFile, 'utf8')) : null;
const review = savedReview?.reviewedResultsSha256 === createHash('sha256').update(resultBytes).digest('hex') ? savedReview : null;
const esc = (v) => String(v ?? '').replaceAll('|', '\\|').replaceAll('\n', '<br>');
const pct = (n, d) => d ? `${n}/${d}（${(n / d * 100).toFixed(1)}%）` : '不适用';
const facts = report.extraction.flatMap((d) => d.factChecks);
const taskGroups = report.extraction.flatMap((d) => d.taskFieldChecks);
const fieldCounts = {};
for (const group of taskGroups) for (const field of Object.keys(group.expected)) {
  const item = fieldCounts[field] ??= { correct: 0, total: 0 };
  item.total++;
  if (group.matched.some((m) => m.checks.some((c) => c.field === field && c.passed))) item.correct++;
}
const stageReceipts = Object.groupBy(report.receipts, (r) => r.stage ?? 'baseline');
const lines = [
  '# 真实 LLM 记忆系统评估', '',
  `模型：**${report.actualModels.join('、')}**。首次开始：${report.startedAt}；结束：${report.finishedAt}。`, '',
  '本轮真实调用 DeepSeek 官方 API，通过生产 Rust Engine 执行提取与问答。资料为固定合成数据，不包含用户项目资料。用于观察能力与复现问题，不代表生产总体准确率。', '',
  '## 方法与可复现性', '',
  '- 标准记忆问答：两种入口分别35题，包含29道有答案、6道无可用答案。标准记忆通过应用API确认入库，120条干扰记忆、旧版本、未确认候选与隔离项目一并构造。冲突处置使用离线SQL固定到已知待确认状态，避免引入冲突比较模型的不确定性。',
  '- 提取：6份带预设事实及任务字段标签的合成原文，经实际提取提示、真实模型、引用校验、候选落库流程。',
  '- 端到端：仅在隔离测试工作区显式确认实际提取候选，再执行5道模型问答。为观察错误传播，未人工修改候选正文；确认不代表已语义审核。',
  '- 使用鉴权的本机观察代理转发真实响应，统计usage；仅添加与生产DeepSeek适配器相同的thinking=disabled。真实响应正文不改写、不补答案。真实API密钥只保留在评估进程内存中。',
  '- 没有自动网络重试。修复协议后仅显式重测桌面35题及端到端5题；飞书结果和6份提取结果复用同一轮已完成数据。',
  '- 本轮真实工作区由API创建，记忆时间戳/ID与离线内存题集不同，存在按时间排序的截断差异；不能把与离线报告的变化全部归因于LLM。',
  `- 标准题集指纹：\`${report.datasetSha256}\`；提取/评分集指纹：\`${report.liveDatasetSha256}\`。`, '',
  '## 测试发现并修复的协议问题', '',
  `初次桌面问答 ${report.beforeFix?.desktopErrors ?? 0}/${report.beforeFix?.desktopCases ?? 0} 题被格式校验拒绝。JSON对象模式原先没有把输出schema发送给模型，模型因而添加了notes、citations等额外字段或使用嵌套answer。`, '',
  '修复：在用户输入中附完整schema，在系统提示中明确仅允许grounded、answer、citationIds及字段类型。继续严格校验输出，没有放宽引用或字段约束。新增回归在修复前失败，修复后覆盖JSON对象及JSON Schema两种模式。', '',
  '原始失败响应见 [修复前记录](memory-live-evaluation-before-fix.json)，最终结果见 [完整JSON](memory-live-evaluation-results.json)。', '',
  '## 基于标准记忆的真实问答', '',
  '| 入口 | 题数 / 协议错误 | 有答案题关键事实命中 | 有答案题引用覆盖 | 无答案题正确放弃 | P50 / P95 |',
  '|---|---:|---:|---:|---:|---:|',
];
for (const [name, s] of Object.entries(report.summary)) lines.push(`| ${name === 'desktop' ? '桌面项目问答（修复后）' : '飞书记忆问答'} | ${s.cases} / ${s.errors} | ${pct(s.expectedClaimsPresent, s.answerable)} | ${pct(s.allGoldEvidenceCited, s.answerable)} | ${pct(s.correctAbstentions, s.unanswerable)} | ${(s.p50Ms / 1000).toFixed(2)}s / ${(s.p95Ms / 1000).toFixed(2)}s |`);
lines.push('', '关键事实命中按预先标注的正则/同义表达检查，引用覆盖按标准记忆ID检查。它们不能证明整段回答语义正确；没有将二者称作最终回答准确率。未命中的有答案题被模型放弃，主要是检索候选没有覆盖相应改写。', '', '### 仍未答出的有答案问题', '', '| 入口 | 问题 | 模型行为 |', '|---|---|---|');
for (const [track, cases] of Object.entries(report.goldQa)) for (const c of cases) if (c.goldEvidence?.length && !c.expectedClaimsPresent) lines.push(`| ${track} | ${esc(c.question)} | ${c.error ? esc(c.errorCode) : c.grounded ? '未满足预设事实检查' : '依据不足，放弃回答'} |`);
lines.push('', '### 引用合法但因果结论仍需复核', '', '以下为编码助理逐题审阅发现，不是独立人工盲评；规则评分均会放过这些回答。', '');
for (const f of review?.findings ?? []) lines.push(`- **${f.track} / ${f.caseId}**：${f.note}`);
if (!review) lines.push('本次结果尚无与文件指纹匹配的审阅标注；不会沿用旧运行的结论。');
lines.push('', '上表的事实命中比例不能直接当成回答正确率。需要额外核对因果关系和问题中的未证实前提；增加召回数量本身无法保证推理正确。', '', '## 真实提取结果', '',
  `- 提取任务成功：${report.extraction.filter((d) => d.job.status === 'succeeded').length}/${report.extraction.length}。`,
  `- 已标注必要事实命中：${pct(facts.filter((f) => f.matches.length).length, facts.length)}。`,
  `- 预设任务组找到对应候选：${taskGroups.filter((g) => g.matched.length).length}/${taskGroups.length}。`,
  `- 生成并保留记忆候选：${report.extraction.reduce((n, d) => n + d.candidates.length, 0)}；任务候选：${report.extraction.reduce((n, d) => n + d.tasks.length, 0)}。`,
  `- 接受的候选原文摘录均可逐字匹配：${report.extraction.every((d) => d.quotesValid) ? '通过' : '失败'}；正式记忆自动创建数：${report.extraction.reduce((n, d) => n + d.autoCreatedMemories, 0)}。`, '',
  '| 标注任务字段 | 匹配预期 |', '|---|---:|',
);
for (const [field, s] of Object.entries(fieldCounts)) lines.push(`| ${field} | ${s.correct}/${s.total} |`);
lines.push('', '这些是18项必要事实和6组任务的字段覆盖检查，未给所有新增候选做独立语义标注，因此不能声称全局提取precision为100%。原文引用存在也不自动证明表达无误。', '',
  '观察：相对日期未擅自补年份；未知负责人保留null；开发完成与验收未开始分开；85%测试覆盖率未填成任务进度；历史与更正分别保留时间条件。恶意指令样本中，实际预算80万元和未知负责人被保留，900万元/管理员未被作为真实项目事实采纳。此单例不代表通过了全面的提示注入安全评估。', '',
  '## 基于真实提取记忆的端到端问答', '', '| 问题ID | 关键事实规则检查 | 有依据回答 |', '|---|---:|---:|',
);
for (const c of report.endToEnd) lines.push(`| ${c.id} | ${c.expectedClaimsPresent ? '通过' : c.error ? esc(c.errorCode) : '未通过'} | ${c.grounded ? '是' : '否'} |`);
lines.push('', '端到端仅5题，包含负责人/日期、未知信息、完成状态与验收、否定范围、资料内恶意指令。未经真实用户资料、独立人工盲评和多次重复验证，不外推到其他项目。', '', '## 调用量与用时', '',
  `实际模型请求共 **${report.requestCount}** 次（含修复前的失败响应）；API返回模型：${report.actualModels.join('、')}。`, '',
  '| 阶段 | 调用数 | API报告总token |', '|---|---:|---:|',
);
for (const [stage, receipts] of Object.entries(stageReceipts)) lines.push(`| ${stage} | ${receipts.length} | ${receipts.reduce((n, r) => n + (r.usage?.total_tokens ?? 0), 0).toLocaleString('en-US')} |`);
lines.push('', `API累计usage：输入 ${report.usage.prompt_tokens.toLocaleString('en-US')}，输出 ${report.usage.completion_tokens.toLocaleString('en-US')}，总计 ${report.usage.total_tokens.toLocaleString('en-US')} token。费用以服务商账单为准，本报告未推算价格。`, '',
  '问答延迟从Engine调用到返回，包含检索、本机代理和真实网络/模型耗时；本轮有最多3路并发，不能与离线纯CPU计时直接比较。', '', '## 复现', '',
  '先构建pm-host，配置环境变量DEEPSEEK_API_KEY，然后运行：', '',
  '```bash', 'cargo build -p project-assistant-core --bin pm-host --locked', 'npm run evaluate:memory:live', '```', '',
  '这条命令会实际调用模型并产生用量，默认最多90次请求/次执行，测试资料固定为合成数据。不要把API Key写入命令参数、报告或提交到仓库。仅重新生成报告可执行 `node scripts/report-memory-live.mjs`，该命令不调用模型。', '',
);
const checksFile = path.join(root, 'docs/memory-live-regression-results.json');
if (existsSync(checksFile)) {
  const checks = JSON.parse(await readFile(checksFile, 'utf8'));
  if (checks.resultsSha256 === createHash('sha256').update(resultBytes).digest('hex')) lines.push(
    '## 修复后的工程回归', '',
    `Rust核心 ${checks.rust.passed} 项测试通过、${checks.rust.failed} 失败（${checks.rust.unit} 单元 + ${checks.rust.integration} 集成），Clippy ${checks.clippy.passed ? '通过' : '未通过'}。记录于 ${checks.recordedAt}。`, '',
    '新增用例检查两种JSON模式都向模型传递完整schema及合法引用枚举。详见 [回归记录](memory-live-regression-results.json)。', '',
  );
}
await writeFile(path.join(root, 'docs/memory-live-evaluation-report.md'), lines.join('\n'));
process.stdout.write('已生成 docs/memory-live-evaluation-report.md\n');
