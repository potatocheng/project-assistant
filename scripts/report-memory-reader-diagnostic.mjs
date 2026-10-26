import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const data = JSON.parse(await readFile(path.join(root, 'docs/memory-reader-diagnostic-audited-results.json')));
const review = JSON.parse(await readFile(path.join(root, 'docs/memory-diagnostic-adjudication.json')));
const labels = { retrieved_desktop: '统一reader＋桌面首轮证据', retrieved_connector: '统一reader＋连接器首轮证据',
  annotated_passages: '统一reader＋人工标注段落', full_document: '统一reader＋完整论文',
  historical_desktop: '上一轮桌面最终答案（本次复评）', historical_connector: '上一轮连接器最终答案（本次复评）' };
const names = Object.keys(labels), fmt = value => value.toLocaleString('en-US');
const disputed = new Set(review.cases.map(c => c.questionId));
const lines = ['# 记忆系统：固定证据与统一阅读流程诊断', '',
  `状态：${data.complete ? '完成' : '未完整完成'}。模型：deepseek-flash。固定开发集20题，19题可答、1题不可答；四组各一次真实生成，另20次匿名评分。`, '',
  '本次两入口生成已改用同一个生产request builder；诊断通过Rust桥直接复用该builder、段落编号及引用绑定校验。实验不执行生产检索、语义复核、修订与回退，因此下列新答案分数是固定证据的阅读诊断，不能当作更新后产品端到端正确率。', '',
  '实现上，首次回答、证据修订及增量补答共用同一事实指令、question/references/schema布局和问题义务构造。权限、项目隔离、当前版本与来源校验、最终引用校验仍由原生产入口执行。', '',
  '| 条件 | 完整正确 / 19 | 正确率 | 部分正确 | 错误 | 不确定/缺评分 | 无答拒答 / 1 | 本轮生成tokens |',
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'];
for (const name of names) {
  const m = data.arms[name];
  lines.push(`| ${labels[name]} | ${m.completeCorrect}/19 | ${(100 * m.completeCorrect / 19).toFixed(1)}% | ${m.partial} | ${m.incorrect} | ${m.uncertainOrMissing} | ${m.unanswerableCorrect}/1 | ${m.tokens == null ? '历史答案未重新生成' : fmt(m.tokens)} |`);
}
lines.push('', `本轮共${fmt(data.usage.requests)}次请求、${fmt(data.usage.totalTokens)} tokens：生成${fmt(data.usage.readerTokens)}，评分${fmt(data.usage.judgeTokens)}。所有计数来自提供方原始usage；没有按评分重跑，没有模型自动重试。`, '',
  `两入口首轮证据的正文及顺序相同：${data.sameInitialContentQuestions.length}/20；完整元数据完全相同：${data.sameInitialEvidenceQuestions.length}/20。因此入口间差别仍包括记忆标签/元数据以及模型采样变化，不能将分差解释成正文召回差异。`, '',
  '普通证据组固定使用原40次回答的generation 0，已逐条对照真实请求及哈希；不依据旧答案好坏挑选后续证据。人工标注段落组只提供原始证据段落，不提供答案、评分或agent审查意见；唯一不可答题提供全文，避免空证据泄露不可答标签。全文组包含全部段落，不受生产检索32条上限裁剪。人工标注本身存在范围歧义，因此该组不应称为绝对正确证据上限。', '',
  '929条正式记忆没有重新提取或修改。本轮没有重新评估“答题信息完整率”，不报告新的记忆留存提升。', '',
  '## 配对诊断', '');
for (const entry of ['desktop', 'connector']) {
  const changed = data.cases.filter(c => c.historicalOriginalGrades[entry].answerCorrect !== c.grades[`historical_${entry}`].answerCorrect);
  const gains = data.cases.filter(c => c.answerable && c.grades[`retrieved_${entry}`].answerCorrect === 'yes' && c.grades[`historical_${entry}`].answerCorrect !== 'yes');
  const losses = data.cases.filter(c => c.answerable && c.grades[`retrieved_${entry}`].answerCorrect !== 'yes' && c.grades[`historical_${entry}`].answerCorrect === 'yes');
  lines.push(`${entry}：历史相同答案的评分标签改变${changed.length}题（${changed.map(c => `${c.id.slice(0, 8)} ${c.historicalOriginalGrades[entry].answerCorrect}→${c.grades[`historical_${entry}`].answerCorrect}`).join('；')}）。新reader对比历史答案本次同批复评，新增完整正确${gains.length}题、失去完整正确${losses.length}题；这是阅读协议与完整生产链路的比较，不是单一组件因果结论。`);
}
lines.push('', '具体观察：序列位置题两个新检索证据组都区分了“图像嵌入作为输入”和“不同位置使用不同解码器”，旧答案将二者混为一谈；连接器的人数和语料回答也补齐了原来遗漏的范围。词义数量题仍同时存在首轮证据缺少最终选择步骤、题干/人工gold目标范围不一致的问题。全文组能给出完整GlossBERT流程，却仍被当前gold判错。', '',
  '标注段落组的低分不说明真实检索优于完美检索：部分人工gold只涵盖比较片段或相关工作，未包含正文更直接的总结/定义。另一个实际工程失败是全文定义题混淆referenceIndex与spanIndex，被真实绑定校验拒绝。桌面权重答案在“No”后又承认缺少共享权重的直接证据，虽被自动judge判yes，仍存在值得修正的推断/不确定表达问题。', '',
  '本轮建议优先固定无歧义问题范围和评分标准，再验证共享reader加生产复核的端到端效果；针对证据遗漏做有界补检索，针对编号错误沿用生产修订校验。现有数据不支持用扩大上下文或堆叠更多调用来承诺稳定提升。', '');
for (const name of ['annotated_passages', 'full_document']) {
  const improved = data.cases.filter(c => c.answerable && c.grades?.[name]?.answerCorrect === 'yes' && c.grades?.retrieved_desktop?.answerCorrect !== 'yes');
  const regressed = data.cases.filter(c => c.answerable && c.grades?.[name]?.answerCorrect !== 'yes' && c.grades?.retrieved_desktop?.answerCorrect === 'yes');
  lines.push(`相对于“统一reader＋桌面首轮证据”，${labels[name]}新增完整正确${improved.length}题（${improved.map(c => c.id.slice(0, 8)).join('、') || '无'}），失去完整正确${regressed.length}题（${regressed.map(c => c.id.slice(0, 8)).join('、') || '无'}）。`);
}
lines.push('');
for (const name of names.slice(0, 4)) {
  const failed = data.cases.filter(c => c.answerable && c.grades?.[name]?.answerCorrect !== 'yes');
  lines.push(`${labels[name]}未获完整正确的${failed.length}题中，${failed.filter(c => disputed.has(c.id)).length}题属于实验前已登记的五道争议题。这只定位问题，不改判或剔除样本。`);
}
lines.push('',
  '## 逐题原始自动评分', '',
  '| 题号 | 问题 | 桌面证据 | 连接器证据 | 标注段落 | 全文 | 旧桌面复评 | 旧连接器复评 |',
  '| --- | --- | --- | --- | --- | --- | --- | --- |');
for (const c of data.cases) lines.push(`| ${c.id.slice(0, 8)} | ${c.question.replaceAll('|', '\\|')} | ${names.map(n => c.grades?.[n]?.answerCorrect ?? 'missing').join(' | ')} |`);
lines.push('', 'yes=完整正确；partial=部分正确；no=错误；uncertain=评分不确定。历史原评、此次历史答案复评和新答案评分分别保留，不覆盖旧报告。', '',
  '## 证据审查与限制', '',
  '五道争议题的逐段审查见 [agent review](memory-diagnostic-adjudication.md)。这是代码代理阅读本地原文后的审查，不是独立人工复核，没有生成新人工gold、剔除题目或改判历史分数。', '',
  '同一模型同时生成与评分，且所有20题是已知开发题；一次调用无法估计稳定性或产品泛化能力。旧最终答案经过完整生产链路，新答案只有共享reader和绑定校验，二者的分差不能单独归因于提示词或省略复核。引用绑定通过只说明锚点合法，不等于语义正确。', '',
  `完整性：${data.integrity.uniqueRequestIds}个唯一请求；冻结代码/数据未变=${data.integrity.frozenFilesUnchanged}；提供方usage核对=${data.integrity.providerUsageVerified}；绑定失败总数=${names.slice(0, 4).reduce((n, a) => n + data.arms[a].bindingFailures, 0)}。`, '',
  '验证：完整Rust测试474通过、6忽略；Clippy无警告；pm-host构建通过。诊断12项、语法修复3项、独立验证器10项离线测试通过。独立验证器重建80个生产reader请求并重放80个响应规范化，确认结果一致，额外API为0；见 [独立完整性审计](memory-reader-diagnostic-integrity.json)。', '',
  '技术修复：第85次请求的评分JSON缺少最后一个对象括号，六组评分与理由均完整存在。独立派生报告仅追加一个末括号，零新增API、零语义字段修改；原始报告complete=false和原始返回完整保留。全文定义题的越界引用仍计为失败，没有修复生成答案。详见 [修复审计](memory-reader-diagnostic-technical-amendment.json)。', '',
  `原始记录保存在 ${data.workspace}；机器可读结果见 [audited results](memory-reader-diagnostic-audited-results.json)，[原始结果](memory-reader-diagnostic-results.json)和[预登记](memory-reader-diagnostic-preregistration.json)均保留。`, '');
await writeFile(path.join(root, 'docs/memory-reader-diagnostic-report.md'), lines.join('\n'));
console.log(JSON.stringify({ report: 'docs/memory-reader-diagnostic-report.md', complete: data.complete, reviewLoaded: !!review }));
