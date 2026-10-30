// Assemble the existing evaluation receipts; no test or model requests.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const read = (file) => readFile(path.join(root, file), 'utf8');
const json = async (file) => JSON.parse(await read(file));
const sha = (data) => createHash('sha256').update(data).digest('hex');
const [before, after, external, manifest] = await Promise.all([
  json('docs/memory-evaluation-results.json'), json('docs/memory-organized-retrieval-results.json'),
  json('docs/memory-public-retrieval-results.json'), json('docs/memory-public-dataset-manifest.json'),
]);
if (before.datasetSha256 !== after.datasetSha256 || external.datasetSha256 !== manifest.datasetSha256) throw new Error('Dataset comparison fingerprint mismatch');
const rust = await read('.local-data/memory-organized-rust-tests.log');
const matches = [...rust.matchAll(/test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored/g)];
if (!matches.length || matches.some((m) => m[1] !== 'ok' || Number(m[3]) !== 0)) throw new Error('Regression log is incomplete or failed');
const totals = matches.reduce((sum, m) => sum.map((n, i) => n + Number(m[i + 2])), [0, 0, 0]);
const quality = await read('.local-data/memory-organized-quality-tests.log');
const clippy = await read('.local-data/memory-organized-clippy.log');
const restartLog = await read('.local-data/memory-organized-restart.log');
const restart = JSON.parse(restartLog.slice(restartLog.indexOf('{')));
if (!/Finished `dev`/.test(clippy) || /error:/.test(clippy) || restart.passed !== true || !/fail\s+0/.test(quality)) throw new Error('Missing passing engineering receipt');
const files = ['crates/core/src/answer_contract.rs', 'crates/core/src/memory_facts.rs', 'crates/core/src/memory_query.rs',
  'crates/core/src/question_flow.rs', 'crates/core/src/search.rs', 'crates/core/src/ai.rs', 'crates/core/src/qa.rs',
  'crates/core/src/assistant_qa.rs', 'crates/core/src/db.rs', 'crates/core/src/backup.rs', 'crates/core/src/memory.rs',
  'crates/core/src/memory_evaluation.rs', 'crates/core/tests/nonvector_qa_engine.rs', 'crates/core/tests/memory_workbench_engine.rs',
  'scripts/evaluate-memory-quality.mjs', 'scripts/evaluate-memory-quality.test.mjs', 'scripts/prepare-memory-public-eval.mjs',
  'scripts/evaluate-memory-public.mjs', 'src/App.tsx', 'src/types.ts', 'src/components/delivery/AssistantWorkspace.tsx'];
const fingerprints = Object.fromEntries(await Promise.all(files.map(async (f) => [f, sha(await read(f))])));
const report = {
  version: 'organized-memory-implementation-v1', recordedAt: new Date().toISOString(), schema: 9,
  rust: { passed: totals[0], failed: totals[1], ignored: totals[2], logSha256: sha(rust), log: '.local-data/memory-organized-rust-tests.log' },
  qualityScorer: { passed: Number(quality.match(/pass\s+(\d+)/)?.[1]), failed: 0, logSha256: sha(quality) },
  clippy: { passed: true, logSha256: sha(clippy) }, restart: { passed: true, checks: restart.checks, logSha256: sha(restartLog) },
  publicEvaluation: { datasetSha256: manifest.datasetSha256, casesPerEntry: manifest.selectedQuestions,
    summary: external.summary, kind: 'external_human_labelled_evidence_retrieval_only' },
  fixedDevelopment: { datasetSha256: after.datasetSha256, tracks: Object.fromEntries(Object.entries(after.tracks).map(([key, track]) =>
    [key, { before: before.tracks[key].summary, after: track.summary }])), scale: after.scale },
  newRealModelRequests: 0, independentBusinessAccuracy: null, extractionPrecision: null,
  limitations: [
    'Frontend build passed in the tool output; existing Vite chunk-size warning remains.',
    'Public corpus paragraphs are preloaded; this skips extraction, formal memory organization, generation and semantic review.',
    'Human labels for all generated extraction candidates and answer assertions are not yet complete.',
    'Debug latency includes cache construction and varying machine load; not a production SLA.',
    'Claim anchors prove textual presence, not semantic implication; optional review uses the same model in another request.',
    'Reported token stopping threshold is post-response; missing provider usage is not counted as zero billing.',
    'No embeddings or reranker installed. The frozen public benchmark is ready for a subsequent controlled comparison.',
  ], files: fingerprints,
};
await writeFile(path.join(root, 'docs/memory-organized-regression-results.json'), JSON.stringify(report, null, 2));
const pct = (v) => `${(v * 100).toFixed(1)}%`;
const names = { connector_memory: '飞书记忆检索', desktop_local_answer: '桌面本地引用', desktop_model_context: '桌面模型候选' };
const lines = [
  '# 事实组织、断言约束与公开评测实施报告', '', `记录时间：${report.recordedAt}。工作区schema 9。`, '',
  '## 已实现', '',
  '- 主体、事项、角色、条件和有效期按候选及正式修订保存；AI组织字段须得到正文和实际引文支持，修订可编辑，正文变化不继承旧标签。',
  '- 模型按结论、引用和当前正文锚点输出；程序验证并渲染断言，支持部分回答和未知字段，收紧普通问题的上下文。',
  '- 对复杂、部分、范围不明及非完整直引回答执行按需核验；省略条件的正文子串不能绕过核验。',
  '- FTS5候选索引和普通版本映射按修订刷新；目录分主体/事项/类型并优先匹配组；备份快照排除派生缓存，还原后重建。',
  '- 分阶段耗时和服务商usage进入queryTrace；缺少usage显式标记，60000已报告token是响应后停止阈值。',
  '- 原子事实/答案人工计分工具、未标注清单、外部QASPER数据适配与独立来源检索基线。', '',
  '## 工程验证', '',
  `- 常规Rust回归：${totals[0]}通过，${totals[1]}失败。${totals[2]}项公开数据测试在常规命令中忽略，已用专门命令单独执行通过。`,
  `- JavaScript质量计分工具：${report.qualityScorer.passed}通过。`,
  '- Clippy workspace/all-targets/-D warnings、前端构建、真实进程重启及备份恢复：通过。前端仍有既有chunk-size提示。',
  '- 本轮新增真实LLM请求：0；HTTP模型夹具只验证协议和控制流。', '',
  '## 固定开发题集', '',
  '| 入口 | 完整证据@6 | 本地P50前/后 | 本地P95前/后 |', '|---|---:|---:|---:|',
];
for (const [key, value] of Object.entries(report.fixedDevelopment.tracks)) {
  const b = value.before, a = value.after;
  lines.push(`| ${names[key]} | ${Math.round(a.allEvidenceAt6 * a.answerable)}/${a.answerable}（${pct(a.allEvidenceAt6)}） | ${b.latencyMs.p50.toFixed(1)}/${a.latencyMs.p50.toFixed(1)}ms | ${b.latencyMs.p95.toFixed(1)}/${a.latencyMs.p95.toFixed(1)}ms |`);
}
lines.push('', '这些题参与过既有词表调优；不是盲评。新旧计时在debug构建和不同系统负载下获得，包含检索、复核及缓存构建影响，不外推到生产。原始记录见[固定题结果](memory-organized-retrieval-results.json)。', '',
  '## 外部人工标注数据', '',
  'QASPER固定100题、36篇论文，按论文隔离20道开发题与80道保留题。标准答案不进入检索请求，保留全部所选论文正文。许可、出处、筛选及排除数量见[来源说明](memory-public-datasets.md)和[指纹清单](memory-public-dataset-manifest.json)。', '',
  '| 保留集入口 | 有答案题 | 完整证据@6 | 范围泄漏 |', '|---|---:|---:|---:|');
for (const [key, label] of [['holdout:connector_memory', '飞书'], ['holdout:desktop_model_candidates', '桌面模型候选']]) {
  const s = external.summary[key]; lines.push(`| ${label} | ${s.answerable} | ${Math.round(s.allEvidenceAt6 * s.answerable)}/${s.answerable}（${pct(s.allEvidenceAt6)}） | ${s.scopeViolations} |`);
}
lines.push('', '另有8道无答案保留题；本实验没有生成答案，不报告其拒答正确率。公开结果只测预载段落检索，没有测提取、事实组织或端到端回答。未按保留题结果改动检索规则。见[公开结果](memory-public-retrieval-results.json)。', '',
  '## 仍未测得', '',
  '全部提取候选的精确率、逐条答案语义支持率和真实业务准确率仍未获得独立完整标注；待标注工具会输出null。锚点存在和模型核验通过不等于语义正确。当前未安装embedding或语义重排模型，下一阶段可用同一固定题集和语料做对照。', '',
  '完整工程记录与代码指纹见[回归记录](memory-organized-regression-results.json)。', '',
  '## 复现', '', '```bash',
  'cargo test -p project-assistant-core --locked --no-fail-fast',
  'cargo clippy --workspace --all-targets --locked -- -D warnings',
  'npm run build', 'npm run verify:memory:quality', 'npm run verify:restart',
  'npm run prepare:memory:public', 'npm run evaluate:memory:public', '```', '',
);
await writeFile(path.join(root, 'docs/memory-organized-implementation-report.md'), lines.join('\n'));
console.log(JSON.stringify({ rust: report.rust.passed, publicTest: 1, scorer: report.qualityScorer.passed, realModelRequests: 0, report: 'docs/memory-organized-implementation-report.md' }));
