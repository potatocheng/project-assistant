// Runs the real Rust retrieval/local-answer code over a fixed synthetic corpus.
// No model endpoint, production workspace or user credentials are used.
import { spawn } from 'node:child_process';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const reportPath = path.join(root, 'docs/memory-evaluation-results.json');
const markdownPath = path.join(root, 'docs/memory-evaluation-report.md');
const localCargo = path.join(homedir(), '.cargo/bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo');
const cargo = existsSync(localCargo) ? localCargo : 'cargo';
const started = Date.now();
const child = spawn(cargo, ['test', '-p', 'project-assistant-core', '--locked', '--lib', 'memory_evaluation::measure_current_memory_capability', '--', '--nocapture'], {
  cwd: root, stdio: 'inherit', env: { ...process.env, MEMORY_EVAL_REPORT: reportPath },
});
const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (value) => resolve(value ?? 1)); });
if (code !== 0) process.exit(code);
if ((await stat(reportPath)).mtimeMs < started) throw new Error('Evaluation did not produce a fresh report.');
const report = JSON.parse(await readFile(reportPath, 'utf8'));
const dataset = await readFile(path.join(root, 'crates/core/tests/fixtures/memory-evaluation-v1.json'));
if (report.datasetSha256 !== createHash('sha256').update(dataset).digest('hex')) throw new Error('Dataset fingerprint mismatch.');
const names = { connector_memory: '飞书记忆检索', desktop_local_answer: '桌面本地回答引用', desktop_model_context: '桌面模型候选上下文' };
const pct = (value) => value == null ? '不适用' : `${(value * 100).toFixed(1)}%`;
const escape = (value) => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
const lines = [
  '# 当前记忆系统能力实测', '',
  `生成时间：${report.recordedAt}。数据集：\`${report.datasetVersion}\`。`, '',
  '本次使用人工编写的合成资料，预置正式记忆；不调用真实 LLM，不测真实模型提取准确率或生成正确率。每题明确标注应命中的记忆。结果只代表这组样本。', '',
  '## 测试条件', '',
  `- 数据集指纹：\`${report.datasetSha256}\`。`,
  `- ${report.corpus.goldMemories} 条基础记忆（含1条待确认冲突），${report.corpus.noiseMemories} 条干扰记忆，另有隔离项目记忆与未确认候选。`,
  '- 35 道问题：29 道有答案，6 道无可用答案；每个入口使用相同问题。',
  '- 三个入口使用生产代码；模型候选选择函数与实际模型请求共用。桌面本地回答引用和模型输入分别衡量。',
  `- 延迟口径：${report.latencyScope}。`, '',
  '## 总体结果', '',
  '| 入口 | K | 证据 Recall@K | 全部所需证据命中 | MRR@6 | 无答案题返回空集合 | 跨项目泄漏 / 旧版冲突泄漏 |',
  '|---|---:|---:|---:|---:|---:|---:|',
];
const regressionPath = path.join(root, 'docs/memory-regression-results.json');
if (existsSync(regressionPath)) {
  const regression = JSON.parse(await readFile(regressionPath, 'utf8'));
  const section = [
    '## 最近一次工程回归', '',
    `执行时间：${regression.recordedAt}。Rust 核心 ${regression.rust.passed} 个测试通过、${regression.rust.failed} 个失败（${regression.rust.unit} 单元 + ${regression.rust.integration} 集成）。另有 ${regression.process.filter((p) => p.passed).length} 组真实进程验证通过。`, '',
    '本轮发现并修复：只读简报刷新会重置空闲计时、推迟自动整理。新增回归先复现失败，再校正活动判断，保留真正用户写入对后台任务的中断行为。另同步了旧测试的 schema 版本断言。', '',
    '通过的检查：', '',
    ...regression.process.map((p) => `- \`${p.command}\``),
    ...regression.checks.filter((p) => p.passed).map((p) => `- \`${p.command}\`${p.note ? `（${p.note}）` : ''}`), '',
    '该部分是工程行为验证，非真实模型准确率。明细见 [回归记录](memory-regression-results.json)。复跑能力题集不会自动重跑或刷新上述工程回归记录。', '',
  ];
  const at = lines.indexOf('## 总体结果');
  lines.splice(at, 0, ...section);
}
for (const [key, track] of Object.entries(report.tracks)) {
  const k = key === 'desktop_model_context' ? 40 : 6;
  const s = track.summary;
  const empty = track.cases.filter((c) => !c.gold.length && !c.selected.length).length;
  lines.push(`| ${names[key]} | ${k} | ${pct(s[`recallAt${k}`])} | ${pct(s[`allEvidenceAt${k}`])} | ${s.mrrAt6.toFixed(3)} | ${empty}/${s.unanswerable} | ${s.scopeViolations} / ${s.staleOrConflictViolations} |`);
}
lines.push('', '“返回空集合”只描述检索/引用行为。飞书检索和模型候选上下文有记录，不等于模型会作答；桌面本地回答的 grounded 标志也不等于答案在语义上充分。MRR@6 衡量前6条的排序，不衡量完整模型上下文中的推理。', '', '## 分类结果', '', '| 入口 | 分类 | 有答案/无答案题数 | 全部证据命中题数 | 空集合题数（仅无答案题） |', '|---|---|---:|---:|---:|');
for (const [key, track] of Object.entries(report.tracks)) {
  const k = key === 'desktop_model_context' ? 40 : 6;
  for (const [category, metrics] of Object.entries(track.categories)) {
    const cases = track.cases.filter((c) => c.category === category);
    const positive = cases.filter((c) => c.gold.length);
    const negative = cases.filter((c) => !c.gold.length);
    const full = positive.filter((c) => c.gold.every((id) => c.selected.slice(0, k).includes(id))).length;
    lines.push(`| ${names[key]} | ${category} | ${positive.length}/${negative.length} | ${positive.length ? `${full}/${positive.length}` : '不适用'} | ${negative.length ? `${negative.filter((c) => !c.selected.length).length}/${negative.length}` : '不适用'} |`);
  }
}
lines.push('', '## 未命中及无答案题的候选', '', '| 入口 | 问题 | 缺失依据 / 仍有候选 |', '|---|---|---|');
for (const [key, track] of Object.entries(report.tracks)) {
  const k = key === 'desktop_model_context' ? 40 : 6;
  for (const c of track.cases) {
    const missing = c.gold.filter((id) => !c.selected.slice(0, k).includes(id));
    if (missing.length || (!c.gold.length && c.selected.length)) {
      lines.push(`| ${names[key]} | ${escape(c.question)} | ${missing.length ? `缺失：${missing.join('、')}` : `无答案题仍有 ${c.selected.length} 条候选/引用`} |`);
    }
  }
}
lines.push('', '## 延迟与干扰规模', '', '| 入口 | P50 毫秒 | P95 毫秒 |', '|---|---:|---:|');
for (const [key, track] of Object.entries(report.tracks)) lines.push(`| ${names[key]} | ${track.summary.latencyMs.p50.toFixed(2)} | ${track.summary.latencyMs.p95.toFixed(2)} |`);
lines.push('', '| 项目记忆数 | 重复查询数 | 正确负责人记录排第1 | P50 毫秒 | P95 毫秒 |', '|---:|---:|---:|---:|---:|');
for (const s of report.scale) lines.push(`| ${s.memories} | ${s.queries} | ${s.top1Correct}/${s.queries} | ${s.p50Ms.toFixed(2)} | ${s.p95Ms.toFixed(2)} |`);
lines.push('', '规模测试重复同一道“支付接口验收由谁负责”，仅用于观察固定问题的排序稳定性和耗时，不能当成独立正确率样本。计时为单机内存 SQLite、debug 构建，排除网络、模型与冷启动；不等于桌面完整响应延迟。', '', '## 如何解读', '',
  '- 测试通过表示范围、版本和长正文节选等硬约束未失败；召回、排序、空集合比例是能力观测值，未设置成必过断言。',
  '- semantic_gap 是刻意设计的强改写难题；negation_evidence 只检查是否找到包含否定的依据，没有验证 LLM 是否理解否定。',
  '- 多条依据全部命中表示材料齐全，不表示模型完成了正确因果推理。',
  '- 未测真实 LLM 的提取精确率/召回率、回答正确率、提示注入防御效果、云端成本和完整端到端延迟。',
  '- 完整逐题结果、候选 ID、本地回答和耗时见 [JSON 原始结果](memory-evaluation-results.json)；评估口径和后续真实样本方案见 [评估设计](memory-evaluation.md)。', '',
);
await writeFile(markdownPath, lines.join('\n'), 'utf8');
process.stdout.write(`\n已生成：${markdownPath}\n原始结果：${reportPath}\n`);
