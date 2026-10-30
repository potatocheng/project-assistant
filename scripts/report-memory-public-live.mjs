import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readPublicLiveReport } from './memory-public-live-io.mjs';
const root = path.resolve(import.meta.dirname, '..');
const read = async file => JSON.parse(await readFile(path.join(root, file)));
const main = await readPublicLiveReport(path.join(root, 'docs/memory-public-live-results.json'));
const control = await readPublicLiveReport(path.join(root, 'docs/memory-public-live-control-results.json'));
const downstream = await read('docs/memory-public-live-control-summary.json');
const extraction = await read('docs/memory-public-live-extraction-diagnostics.json');
const binding = await read('docs/memory-public-live-answer-binding.json');
const ablation = await read('docs/memory-public-live-facet-ablation.json');
const integrity = await read('docs/memory-public-live-integrity.json');
const raw = new Map((await readFile(path.join(root, control.workspace, 'receipts.jsonl'), 'utf8')).trim().split('\n').map(line => { const r = JSON.parse(line); return [r.index, r]; }));
const count = values => values.reduce((a, k) => { a[k] = (a[k] || 0) + 1; return a; }, {});
const rate = r => r.denominator ? `${r.count}/${r.denominator}（${(r.rate * 100).toFixed(1)}%）` : '不适用';
const violations = binding.cases.filter(c => !c.contractValid).map(c => {
  const output = JSON.parse(JSON.parse(raw.get(c.receiptId).responseText).choices[0].message.content);
  const issues = [];
  if (output.status === 'answered' && output.unknowns?.length) issues.push('answered_with_unknowns');
  if (c.anchors.some(a => !a.inCurrentContent)) issues.push('quote_not_in_current_content');
  const union = new Set(output.claims.flatMap(c => c.citationIds));
  if (output.citationIds.some(id => !union.has(id)) || [...union].some(id => !output.citationIds.includes(id))) issues.push('root_citation_union_mismatch');
  return { receiptId: c.receiptId, entry: c.entry, questionId: c.questionId, issues };
});
const ids = selected => selected.map(r => r.memoryId ?? r.record?.memoryId ?? r.id);
const changed = ablation.cases.filter(c => JSON.stringify(ids(c.variants.normal.selected)) !== JSON.stringify(ids(c.variants.withoutFacets.selected)));
const auditExamples = ['bc4dca3e', '6a31db1a'].map(prefix => {
  const judgment = control.judgments.find(j => j.id.startsWith(prefix));
  const measured = downstream.cases.filter(c => c.id === judgment.id);
  return { id: judgment.id, reportedMemorySufficiency: judgment.memorySufficiency, reason: judgment.reason,
    objectiveGoldParagraphContentRetained: measured[0].coverage.originalGoldParagraphContentRetained,
    lastGenerationGoldParagraphIdsComplete: Object.fromEntries(measured.map(c => [c.entry, c.coverage.lastGenerationGoldParagraphIdsComplete])) };
});
const diagnosis = {
  recordedAt: new Date().toISOString(), realRequests: main.receipts.length + control.receipts.length,
  realTokens: main.usage.total_tokens + control.usage.total_tokens,
  extractionCandidateValidation: { parsedCandidates: extraction.candidates.length, accepted: extraction.candidates.filter(c => c.passesProductionChecks).length,
    overlappingIssues: count(extraction.candidates.flatMap(c => c.issues)),
    note: 'Only complete JSON responses; excludes 17 truncated responses. Validation acceptance is not semantic precision. Failed jobs can lose earlier batches; discardedCount on terminal jobs undercounts captured rejections.' },
  answerProtocolValidation: { failedGenerations: violations.length, overlappingIssues: count(violations.flatMap(v => v.issues)), cases: violations },
  facetQueryAblation: { cases: ablation.cases.length, changedSelectedIdSequences: changed.length, restoredGoldenEvidence: 0,
    note: 'Main experiment has only one formal memory; no evidence that query-time facet filtering is the current loss. This cannot validate metadata quality in a larger corpus.' },
  judgeStageAudit: { excluded: ['memorySufficiency', 'retrievalSufficiency'],
    reason: 'Inspection found stage conflation in the joint judge. Use original gold paragraph mapping/full content and production validation replay for stage diagnosis. Final answer correctness remains provisional same-model scoring.', examples: auditExamples },
};
await writeFile(path.join(root, 'docs/memory-public-live-diagnosis.json'), JSON.stringify(diagnosis, null, 2));
const allD = downstream.summary['all:desktop'], allC = downstream.summary['all:connector'];
const heldD = downstream.summary['holdout:desktop'], heldC = downstream.summary['holdout:connector'];
const failedBinding = diagnosis.answerProtocolValidation.overlappingIssues;
const text = `# 公开数据真实 LLM 完整链路评测

日期：2026-10-20。模型：\`${main.actualModels.join(', ')}\`。范围：QASPER固定36篇英文论文、1686段正文、100道人工问题；其中91题有答案、9题无答案，开发/保留题为20/80，论文不跨组。数据归属：Dasigi等（2021），[QASPER来源与CC BY 4.0许可](memory-public-datasets.md)。

## 结论

**当前最大的损失发生在提取响应和组织字段校验阶段。** 实际全文提取后仅形成1条正式记忆，两个入口在91道可答题上均未完整答对。把全部原始段落原样确认的独立对照可以正常回答一部分问题，说明后续检索和回答仍有改善空间，但不能靠它们恢复已经丢失的提取内容。

建议先修复提取输出预算、组织字段生成/校验与可恢复批次，再修复回答状态协议和检索覆盖。此次结果还不足以证明引入向量或重排模型能优先解决现有问题。

## 实验方式

1. 主实验经实际\`pm-host\`导入全文、按生产提示词和6000字符批次调用真实LLM提取；所有实际生成的记忆候选原样确认，只在隔离工作区模拟用户确认，没有按标准答案补齐内容。
2. 分别调用桌面\`ask_assistant\`和飞书问答\`ask_project\`入口，各100题；走实际检索、最多一次查询改写、生成、原子断言约束和证据核验。没有测试飞书网络事件传输。
3. 对照在另一组工作区把**全部1686段原始正文**原样确认为fact，不使用问题/答案/证据标签筛选段落，跳过提取和facets，再跑同样的两个入口。对照是下游诊断，不能视为端到端结果。
4. 人工标准答案和证据只供事后评分使用，不进入生产提取或问答。全文仅合并段内换行并增加定位标记。原始段落、完整模型上下文和输出保存在忽略的本地工作区，仓库结果为带指纹的精简报告。
5. 自动维护关闭，13条任务候选没有确认为任务。没有测长期更新/遗忘、自动冲突合并、中文真实业务数据的精确率。

真实调用合计**${diagnosis.realRequests}次、${diagnosis.realTokens.toLocaleString('en-US')} token**：主实验260次，其中119次提取、38次生成、3次改写、100次事后评估；对照500次，其中215次生成、166次生产核验、19次改写、100次事后评估。没有自动网络重试。未达到合计1200次/500万已报告token的止损阈值。

8个生产源码指纹和已运行二进制指纹保持一致。评测脚本修正过3篇长标题的项目显示名限制，发生在导入和模型调用之前；源资料保留完整标题，已执行模型任务没有重跑。初版事后评估器出现4次非法记忆ID输出，已拒绝计分，没有修正成通过；对照前收紧了评估器ID说明，生产提示词未改。

## 一、提取与组织

| 观测 | 结果 |
|---|---:|
| 完整导入论文 / 段落 | 36 / 1686 |
| 提取任务完成 / 失败 | 7 / 29 |
| 响应截断导致任务失败 | 17篇，涉及43道可答题 |
| 候选全部不通过校验导致失败 | 12篇，涉及30道可答题 |
| 完成任务涉及的可答题 | 18题，仍缺少所需正式记忆 |
| 完整响应中可解析记忆候选 | 2104条 |
| 通过现有候选校验并形成正式记忆 | 1条 |
| 最终端到端可答题完整回答 | 桌面0/91；飞书0/91 |

### 响应预算

119次提取调用中17次\`finish_reason=length\`。生产提取的输出上限为4096 token，输出同时包含正文、引文和组织字段，复杂批次容易超限；当前事务语义使一个批次失败后整篇任务不产生候选，前面批次的模型输出也不会成为正式记忆。这是实际工程损失，不是检索没命中。

### 组织字段成为整体丢弃条件

对102份完整响应的2104条候选回放生产schema、facets和引文检查：

- 2086条的facets不符合所引原文的逐字/格式要求。
- 1976条的facets不符合候选正文的逐字/格式要求。
- 11条另有原文引文匹配问题。
- 2103条均至少触发一项facets问题；上述计数相互重叠，不能相加。

生产提示词原本已要求\`content\`使用原文相同语言，同时要求主体、事项和条件均逐字存在于content和所引原文。复核原始请求后，更正此前“提示词要求简明中文陈述”的解释：实际问题是模型仍输出中文译文或概括作为组织字段，未遵守已有约束；即使引文逐字匹配，也会被整条丢弃。模型生成的topic还经常不是content里的连续子串。

这说明**当前跨语言提示词与严格组织契约的配合失败**，不能将1/2104解释成事实精确率，更不能据此推断中文业务数据也只有这个通过率。终态\`discardedCount\`合计611没有覆盖失败任务中的全部丢弃；原始响应回放才揭示了2103条校验拒绝。

查询时facets消融在RAM克隆数据库中完成，200个入口案例移除facets后选中ID序列变化${changed.length}次；没有恢复缺失的标准证据。主实验仅有1条正式记忆，**尚不能验证大规模实体/时间组织效果**。现有主要组织损失发生在入库前。

## 二、下游对照

| 指标（100题全量） | 桌面 | 飞书问答 |
|---|---:|---:|
| 标准证据段落原文保存在正式记忆 | 91/91 | 91/91 |
| 最后一次生成收到全部标准证据段落ID | ${rate(allD.evidenceProvenance.lastGenerationGoldParagraphIdsComplete)} | ${rate(allC.evidenceProvenance.lastGenerationGoldParagraphIdsComplete)} |
| 最后一次生成收到完整标准证据段落正文 | ${rate(allD.evidenceProvenance.lastGenerationWholeGoldParagraphsVisible)} | ${rate(allC.evidenceProvenance.lastGenerationWholeGoldParagraphsVisible)} |
| 完整答对（自动语义评分） | ${rate(allD.fullyCorrectAnswerable)} | ${rate(allC.fullyCorrectAnswerable)} |
| 部分答对，单独列示 | ${rate(allD.partiallyCorrectAnswerable)} | ${rate(allC.partiallyCorrectAnswerable)} |
| 无答案题正确拒答 | ${rate(allD.correctAbstention)} | ${rate(allC.correctAbstention)} |
| 回答协议错误 | 20/100 | 5/100 |
| 收到完整标准段落后的完整答对率 | ${rate(allD.evidenceProvenance.answerGivenWholeGoldParagraphsVisible)} | ${rate(allC.evidenceProvenance.answerGivenWholeGoldParagraphsVisible)} |

| 指标（80题保留集） | 桌面 | 飞书问答 |
|---|---:|---:|
| 完整答对（72道可答题） | ${rate(heldD.fullyCorrectAnswerable)} | ${rate(heldC.fullyCorrectAnswerable)} |
| 最后一次生成收到完整标准段落正文 | ${rate(heldD.evidenceProvenance.lastGenerationWholeGoldParagraphsVisible)} | ${rate(heldC.evidenceProvenance.lastGenerationWholeGoldParagraphsVisible)} |
| 无答案题正确拒答 | ${rate(heldD.correctAbstention)} | ${rate(heldC.correctAbstention)} |

标准证据有多位标注者时接受任一完整替代集合。ID覆盖是来源指标，不等于语义充分；“完整段落可见”比实际回答所需更严格，模型也可能利用另一处等价证据答对。不能把缺少标注段落的每一道题都直接算成检索错误。

### 检索与上下文

全部原文已保留，仍有大量标准段落未送入生成上下文。桌面虽然有12条总引用上限，但普通问题每种kind最多6条；本对照全部为fact，且还有上下文字符上限。只返回局部证据并回答为partial时，现有流程不会自动触发补查；查询改写只在第一次生成\`grounded=false\`时触发。对照200个入口案例只调用了19次改写。

可复查例子：中文数据大小问题\`6a31db1a\`的32,595 posts证据存在于正式段落记忆，却没有进入最后生成的标准证据集合。类似问题应先评估词法检索、kind配额、按子问题补查和上下文选择，再做向量增益对照。

### 回答协议与阅读

对215次生成输出调用实际\`answer_contract::normalize\`离线回放，25次不通过，与20个桌面错误、5个飞书错误一致：${failedBinding.answered_with_unknowns}次出现\`status=answered\`却包含\`unknowns\`，${failedBinding.quote_not_in_current_content}次出现锚点不在当前正文，${failedBinding.root_citation_union_mismatch}次出现顶层引用并集不一致；原因有重叠。

即使完整标准段落可见，桌面仍有14题、飞书15题未完整答对，包含协议错误、部分回答、漏答或拒答。核验器主要检查断言是否有依据，不保证回答覆盖用户问题的全部方面。对照无答案题正确拒答仅3/9、6/9；引用有依据的相关背景仍可能没有回答所问问题。不能把锚点合法或模型核验通过当成答案正确。

## 三、评估器本身的限制

人工标准来自QASPER，但本次最终答案正确性仍由**同一模型**事后评分，没有独立人工逐条审核，也不是官方QASPER F1。

联合评估器有明显阶段混淆：例如\`bc4dca3e\`的理由承认语义与句法探针段落均在记忆中，仍因检索/回答漏项将memorySufficiency评为partial；\`6a31db1a\`也出现同样问题。因此，原始\`memorySufficiency\`、\`retrievalSufficiency\`保留供审计，已从阶段归因中排除，改用标准段落映射、全文可见性和生产校验回放。答案正确率也只作为自动估计，后续需要独立复核。

主实验199次返回unknown、1次返回协议错误；两入口无答案题均9/9拒答，主要原因是几乎没有正式记忆，不能据此宣称拒答能力优秀。主实验的“有足够记忆后的检索成功率”没有有效分母，应当为空，不报告成0%或100%。

## 四、建议的优化顺序

1. **提取与入库：** 在开发题上缩小输入批次或限制每批候选/引文数量，按任务预算控制输出；为批次保存可恢复草稿，保留失败原因与完成进度。保持候选确认边界。
2. **组织契约：** 明确原文语言策略，让可选组织字段使用可验证的原文片段；事实正文与组织字段分开校验，考虑将错误组织字段隔离为待审核，而不是无提示地整条丢弃。继续严格校验原文依据，不能为提高通过率直接取消事实校验。
3. **回答协议：** 加强answered/partial与unknowns的一致性，加入开发集协议遵循测试；可评估有预算上限的格式纠正，保留事实锚点检查。
4. **检索与覆盖：** 分离问题子项，记录各子项缺失证据；对有依据的部分回答评估一次定向补查；检查kind配额、检索词与片段预算。之后再用同口径比较组织后向量/重排是否有增益。
5. **评估：** 对最终答案抽样独立复核，组织、检索、回答分开判断；补中文公开数据和版本冲突/时间/删除任务。保留集只做评测，调整使用20道开发题，新一轮最终验证应增加未见题。

## 五、产物与复现

- [主实验精简结果](memory-public-live-results.json)、[主实验评分](memory-public-live-summary.json)
- [段落对照精简结果](memory-public-live-control-results.json)、[对照评分](memory-public-live-control-summary.json)
- [诊断汇总](memory-public-live-diagnosis.json)、[提取校验回放](memory-public-live-extraction-diagnostics.json)、[回答协议回放](memory-public-live-answer-binding.json)、[facets消融](memory-public-live-facet-ablation.json)
- [完整性检查](memory-public-live-integrity.json)：两组均通过。含固定数据/源码/二进制指纹、请求/usage一致性、生产输入无gold字段、段落定位、原样确认、只读问答和引用范围检查。
- 主实验详情与原始收据：\`${main.workspace}\\results.json\`、\`receipts.jsonl\`；对照：\`${control.workspace}\\results.json\`、\`receipts.jsonl\`。精简报告保存详情SHA256，计分工具会校验后读取本地详情。

本轮验证：7条评分单元测试、2条既有记忆评估回归通过；3个忽略式Rust诊断分别完成提取、回答契约回放和RAM facets消融；核心库及测试Clippy（-D warnings）与完整性检查通过。未修改产品逻辑，也未把本次失败案例补进生产词表或提示词。

\`npm run evaluate:memory:public:live\`会重新产生真实调用与费用；只复查已保存结果使用\`npm run score:memory:public:live\`、\`node scripts/verify-memory-public-live.mjs\`和\`node scripts/report-memory-public-live.mjs\`，不会访问模型。
`;
await writeFile(path.join(root, 'docs/memory-public-live-report.md'), text);
console.log(JSON.stringify({ report: 'docs/memory-public-live-report.md', requests: diagnosis.realRequests, tokens: diagnosis.realTokens, integrityPassed: integrity.results.every(r => r.passed) }));
