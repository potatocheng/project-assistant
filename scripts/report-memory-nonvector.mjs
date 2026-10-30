// Generates a report from existing artifacts; never calls a model.
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const load = async (name) => JSON.parse(await readFile(path.join(root, 'docs', name), 'utf8'));
const optional = async (name) => existsSync(path.join(root, 'docs', name)) ? load(name) : null;
const baseline = await load('memory-nonvector-baseline.json');
const current = await load('memory-evaluation-results.json');
if (baseline.datasetSha256 !== current.datasetSha256) throw new Error('Offline comparison requires an unchanged fixture.');
const live = await optional('memory-nonvector-live-results.json');
const initial = await optional('memory-nonvector-live-initial.json');
const beforeReviewFix = await optional('memory-nonvector-live-before-review-fix.json');
const oldLive = await optional('memory-live-evaluation-results.json');
const review = await optional('memory-nonvector-live-review.json');
const regression = await optional('memory-nonvector-regression-results.json');
if (process.env.DEEPSEEK_API_KEY && JSON.stringify([baseline,current,live,initial,beforeReviewFix,oldLive,review,regression]).includes(process.env.DEEPSEEK_API_KEY)) {
  throw new Error('Refusing to render artifacts containing the model credential.');
}
const pct = (n) => `${(100 * n).toFixed(1)}%`;
const count = (track, k) => `${Math.round(track.summary[`allEvidenceAt${k}`] * track.summary.answerable)}/${track.summary.answerable}`;
const names = { connector_memory: '飞书记忆检索', desktop_local_answer: '桌面本地引用', desktop_model_context: '桌面模型候选' };
const lines = [
  '# 无向量记忆优化实现与评估', '',
  `报告生成时间：${new Date().toISOString()}。`, '',
  '## 已实现能力', '',
  '- 两个入口共用当前记忆筛选、全量合格正文的BM25排序、字段相关性与节选；保留项目、修订及冲突限制。',
  '- 常用术语归一化，明确唯一任务的负责人/截止日期直接读取，减少宽泛意图词造成的错误路由。',
  '- 初次依据不足时，用当前可见记忆的短目录帮助改写检索词，再补查一次。目录最多48项、约8000字符；重复编号笔记合并为导航项。目录与改写都不作为答案证据。',
  '- 因果、延期前提及负责人/截止字段问题按需通过独立模型请求核验，核验拒绝或失败则取消生成结论。',
  '- 每题最多4次模型请求，累计输入及schema120000字符，每次结果16000字符；模型阶段共享设置超时，无自动网络重试。字符限额不是精确token限额。',
  '- 问答只读，新增检索轨迹和核验状态；补查及回答前后核对配置、工作区和数据版本。', '',
  '当前没有embedding、语义重排模型或向量数据库。后续向量索引基于组织后的正式记录与证据构建。', '',
  '## 固定开发题集前后对照', '',
  `题集指纹：\`${current.datasetSha256}\`。相同35题、29道有答案、6道无答案，19条基础记忆及120条干扰记忆。`, '',
  '| 入口 | K | 修改前完整证据命中 | 修改后完整证据命中 | 修改前MRR@6 | 修改后MRR@6 |',
  '|---|---:|---:|---:|---:|---:|',
];
for (const [key, after] of Object.entries(current.tracks)) {
  const before = baseline.tracks[key], k = key === 'desktop_model_context' ? 40 : 6;
  lines.push(`| ${names[key]} | ${k} | ${count(before,k)}（${pct(before.summary[`allEvidenceAt${k}`])}） | ${count(after,k)}（${pct(after.summary[`allEvidenceAt${k}`])}） | ${before.summary.mrrAt6.toFixed(3)} | ${after.summary.mrrAt6.toFixed(3)} |`);
}
lines.push('', '这组题参与过词表与路由调整，属于开发回归结果。离线评估不执行模型查询改写或回答，不能将它的召回当成最终回答正确率。', '',
  '| 入口 | 修改前本地P50/P95 | 修改后本地P50/P95 | 修改后范围/旧版冲突泄漏 |', '|---|---:|---:|---:|');
for (const [key, after] of Object.entries(current.tracks)) {
  const before = baseline.tracks[key];
  const timing = (t) => `${t.summary.latencyMs.p50.toFixed(1)}/${t.summary.latencyMs.p95.toFixed(1)}ms`;
  lines.push(`| ${names[key]} | ${timing(before)} | ${timing(after)} | ${after.summary.scopeViolations}/${after.summary.staleOrConflictViolations} |`);
}
lines.push('', '计时为同进程内存SQLite debug构建，包含检索和快照复核，排除网络与模型；运行时系统负载不同，仅作观察。当前全文扫描和更丰富的词表增加CPU工作，后续应以release构建与更大语料验证性能。', '',
  '未命中的有答案题：', '');
for (const [key, track] of Object.entries(current.tracks)) {
  const k = key === 'desktop_model_context' ? 40 : 6;
  for (const c of track.cases.filter((c) => c.gold.length && !c.gold.every((id) => c.selected.slice(0,k).includes(id)))) lines.push(`- ${names[key]}：${c.question}`);
}
lines.push('', `固定负责人排序探针：修改前${baseline.scale.map((s) => `${s.memories}条记忆下${s.top1Correct}/${s.queries}`).join('、')}；修改后${current.scale.map((s) => `${s.memories}条下${s.top1Correct}/${s.queries}`).join('、')}。每组重复同一问题，不能当成独立正确率样本。`, '',
  '原始数据：[修改前](memory-nonvector-baseline.json)、[修改后](memory-evaluation-results.json)。', '',
  '## 真实模型专项评估', '');
const comparison = {};
if (live?.nonvector) {
  lines.push(`模型：${live.requestedModel}。执行时间：${live.startedAt} 至 ${live.finishedAt}。每入口计划18题，包括12道已知开发题和6道新增合成挑战题。新增题由编码助理设计，不是独立人工盲测。`, '',
    '| 入口 | 完成题数/协议错误 | 有答案题关键事实命中 | 完整标准引用 | 无答案题拒答 | P50/P95 |', '|---|---:|---:|---:|---:|---:|');
  for (const [key, s] of Object.entries(live.summary ?? {})) {
    lines.push(`| ${key} | ${s.cases}/${s.errors} | ${s.expectedClaimsPresent}/${s.answerable} | ${s.allGoldEvidenceCited}/${s.answerable} | ${s.correctAbstentions}/${s.unanswerable} | ${(s.p50Ms/1000).toFixed(2)}/${(s.p95Ms/1000).toFixed(2)}s |`);
    const cases = live.goldQa[key], ids = new Set(cases.filter((c) => !c.id.startsWith('challenge_')).map((c) => c.id));
    const oldCases = oldLive?.goldQa[key]?.filter((c) => ids.has(c.id) && c.goldEvidence?.length) ?? [];
    const newCases = cases.filter((c) => ids.has(c.id) && c.goldEvidence?.length);
    const successful = (c) => c.grounded && c.expectedClaimsPresent && c.allGoldEvidenceCited;
    comparison[key] = { old: { passed:oldCases.filter(successful).length,total:oldCases.length }, new: { passed:newCases.filter(successful).length,total:newCases.length } };
  }
  lines.push('', '关键事实按预设表达匹配，标准引用按记忆ID覆盖检查，二者都不能单独证明整段回答正确。专项跳过提取；未测出新的提取准确率。', '',
    '### 旧题交集观察', '');
  for (const [key,c] of Object.entries(comparison)) lines.push(`- ${key}：同ID有答案旧题的“关键事实与标准引用均命中”从${c.old.passed}/${c.old.total}变为${c.new.passed}/${c.new.total}。`);
  lines.push('', '新轮次增加了5条挑战记忆，且ID/时间戳不同；这是观察对照，不能将所有变化归于单一组件。', '', '### 补查与核验', '');
  for (const [key,cases] of Object.entries(live.goldQa)) {
    const rewritten = cases.filter((c) => c.queryTrace?.searchQueries?.length);
    const reviewed = cases.filter((c) => c.qualityReview);
    lines.push(`- ${key}：${rewritten.length}题执行改写补查，${reviewed.length}题有证据核验；核验拒绝/失败${reviewed.filter((c) => !c.qualityReview.supported).length}题，观察到跨项目泄漏${cases.filter((c) => c.scopeViolation).length}题。`);
  }
  lines.push('', `本次最终轮次共${live.requestCount}次真实请求，API报告输入${live.usage.prompt_tokens ?? 0}、输出${live.usage.completion_tokens ?? 0}、总计${live.usage.total_tokens ?? 0} token。`, '');
  if (initial) lines.push(`首轮在核验请求出现HTTP400后停止，已调用${initial.requestCount}次、${initial.usage?.total_tokens ?? 0} token。补齐所有问答阶段的JSON输出指令并增加回归后重测；首轮保存在[初始记录](memory-nonvector-live-initial.json)。`, '');
  if (beforeReviewFix) lines.push(`第二轮完成${beforeReviewFix.requestCount}次请求、${beforeReviewFix.usage?.total_tokens ?? 0} token，发现对明确说明未知前提的回答误拒绝，以及审批人与具体采购负责人混淆。修改核验边界并补充角色检查后完整重测，第二轮保存在[核验调整前记录](memory-nonvector-live-before-review-fix.json)。`, '');
  lines.push(`本次实施各轮合计${(initial?.requestCount ?? 0)+(beforeReviewFix?.requestCount ?? 0)+live.requestCount}次请求、${(initial?.usage?.total_tokens ?? 0)+(beforeReviewFix?.usage?.total_tokens ?? 0)+(live.usage?.total_tokens ?? 0)} token。`, '');
  lines.push(`最终轮次 halted=${live.halted}。结果与全部实际输出见[原始JSON](memory-nonvector-live-results.json)。费用以服务商账单为准。`, '');
  const bytes = await readFile(path.join(root,'docs/memory-nonvector-live-results.json'));
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (review?.resultsSha256 === digest) {
    lines.push('### 逐题语义复核', '', '以下由编码助理复核，非独立人工盲评：', '');
    for (const finding of review.findings) lines.push(`- ${finding}`);
    lines.push('');
  }
} else lines.push('当前尚无专项真实模型结果。', '');

const logPath = path.join(root,'.local-data/nonvector-rust-tests.log');
let rust = null;
if (existsSync(logPath)) {
  const log = await readFile(logPath,'utf8');
  const suites = [...log.matchAll(/test result: (ok|FAILED)\. (\d+) passed; (\d+) failed/g)];
  rust = { passed:suites.reduce((sum,m)=>sum+Number(m[2]),0), failed:suites.reduce((sum,m)=>sum+Number(m[3]),0), suites:suites.length };
  lines.push('## 工程回归', '', `Rust测试日志统计：${rust.passed}项通过、${rust.failed}项失败。新增集成用例覆盖目录与补查范围、超过初始窗口的旧记忆、非法改写、配置变更、核验拒绝/无效输出和结构化字段零模型调用。`, '');
}
if (regression) {
  lines.push('其他检查：', '', ...[...regression.checks,...regression.process].map((c)=>`- \`${c.command}\`：${c.passed?'通过':'未通过'}${c.note?`；${c.note}`:''}`), '',
    '工程记录与代码指纹见[回归记录](memory-nonvector-regression-results.json)。', '');
}
lines.push('## 后续工作', '',
  '将真实用户问题与完整提取候选加入独立标注集，继续检查实体、时间、条件和关系；在该无向量基线上比较组织后的向量检索。向量仅索引可追溯的正式记录与片段，后端保持可重建、可按版本失效。', '',
  '## 复现', '', '```bash', 'npm run evaluate:memory', 'cargo test -p project-assistant-core --locked --no-fail-fast', 'cargo build -p project-assistant-core --bin pm-host --locked', 'npm run evaluate:memory:nonvector:live', 'node scripts/report-memory-nonvector.mjs', '```', '',
  '真实模型命令需要环境变量DEEPSEEK_API_KEY，使用隔离合成工作区，每次执行最多90次请求。报告脚本只读取已有结果。', '');

await writeFile(path.join(root,'docs/memory-nonvector-evaluation-report.md'), lines.join('\n'),'utf8');
await writeFile(path.join(root,'docs/memory-nonvector-comparison.json'), JSON.stringify({ generatedAt:new Date().toISOString(),datasetSha256:current.datasetSha256,
  before:Object.fromEntries(Object.entries(baseline.tracks).map(([k,v])=>[k,v.summary])),
  after:Object.fromEntries(Object.entries(current.tracks).map(([k,v])=>[k,v.summary])),liveComparison:comparison, liveSummary:live?.summary ?? null, rust },null,2),'utf8');
process.stdout.write('Generated docs/memory-nonvector-evaluation-report.md\n');
