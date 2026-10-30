# 公开记忆评测数据

核对日期：2026-10-20。公开数据提供外部问题和标注，结果仍需注明任务、语言、语料和评测入口。

## 已接入：QASPER

- 发布者：Allen Institute for AI；[官方数据卡](https://huggingface.co/datasets/allenai/qasper)，[论文](https://arxiv.org/abs/2105.03011)。
- 论文阅读者编写问题，由另一批NLP从业者回答并标出证据。适合检查长文检索、跨段证据、数字与方法条件以及无答案问题。
- 数据卡标注许可为[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)。归属：Pradeep Dasigi、Kyle Lo、Iz Beltagy、Arman Cohan、Noah A. Smith、Matt Gardner，2021，*A Dataset of Information-Seeking Questions and Answers Anchored in Research Papers*。
- 本项目改编方式：固定v0.3验证集归档SHA256；按论文ID的固定哈希顺序选36篇论文、100道问题，20道开发题、80道保留题。论文不跨组；每篇最多4题；保留所选论文全部正文段落及原始答案。未翻译、未生成新标准答案、未按检索结果选题。混合“可答/不可答”标注和无法映射到正文段落的证据显式跳过，数量保存在清单。
- 多位标注者的证据集合按替代正确集合处理；同一段文字重复出现时允许任一相同段落，不把所有标注者的段落强制并集。
- 数据归档及改编文件放在`.local-data/open-benchmarks/`，不提交论文全文；[来源清单](memory-public-dataset-manifest.json)保存许可、来源、改编说明、分组和指纹。

```bash
npm run prepare:memory:public
npm run evaluate:memory:public
```

本实验将全部正文段落预置为隔离数据库里的正式记录，走实际Rust检索路径。标准答案只供评估器使用，不进入检索请求。该实验测“找到完整标准证据”的能力；不执行LLM提取、问答、核验或翻译，因此没有LLM费用，不能报告为提取准确率、回答准确率、真实项目能力或官方QASPER F1。

首轮结果在[公开检索结果](memory-public-retrieval-results.json)：保留题80道，其中72道有答案。飞书入口完整证据@6为42/72（58.3%），桌面模型候选完整证据@6为36/72（50.0%），观察到跨论文范围泄漏0次。未因这些保留题的结果调整词表、规则或候选阈值。对比实验必须保持题集指纹、语料和口径一致；后续调参使用开发题。

## 真实模型完整流程

```bash
# 先在本机环境设置 DEEPSEEK_API_KEY；脚本不会打印或保存真实密钥
npm run evaluate:memory:public:live
npm run score:memory:public:live
npm run verify:memory:public:scoring
# 如果进程意外中断，可续跑同一隔离目录；已执行的模型任务不自动重试
npm run evaluate:memory:public:live -- --resume .local-data/public-memory-live-目录后缀
```

每篇全文单独导入实际`pm-host`工作区，通过现有批处理提取候选，再原样确认模型真正产生的记忆，分别从桌面助手与飞书问答的生产入口提问。人工确认是实验模拟步骤，不是人工逐条审核正确性；维护和自动冲突合并关闭，本轮不衡量飞书事件接收、自动去重/冲突审核、长期删除/更新能力。原始段落仅增加定位标记并合并段内换行，不将问题或标准答案交给提取器。完整原始请求与响应保存在隔离目录的`receipts.jsonl`，项目设置仅保存随机回环凭据。

默认模型`deepseek-flash`，最多4个工作进程。实验与段落对照合计最多1200次上游请求，累计已报告token达到500万后停止新请求；在途请求可能超过token止损阈值。生产请求维持原有4096输出token上限，不自动重试，不依据保留题修改产品代码或提示词。协议错误和拒答均保留，不能把安全拒答算成可答题成功。

若提取后记忆不足，另设段落对照：全部原始段落原样确认为正式记录，跳过LLM提取和facets，再调用相同生产问答。对照不按标准证据选段落，也不预置答案，用于隔离下游检索/生成问题；**不能把对照准确率称为端到端准确率**。完成主实验后可运行：

```bash
node scripts/evaluate-memory-public-live.mjs --paragraph-control --prior-run docs/memory-public-live-results.json
node scripts/score-memory-public-live.mjs docs/memory-public-live-control-results.json docs/memory-public-live-control-summary.json
```

主实验和对照分别保存到`memory-public-live-results.json`、`memory-public-live-control-results.json`；详细结论见[真实模型公开数据报告](memory-public-live-report.md)。人工答案只进入事后评估器；语义完整性和正确率由同一模型判断，不能视为独立人工审核或官方QASPER F1。严格拒绝评估器返回未授权记忆ID的评分，不自动修正或重试其答案。

## 后续候选

| 数据 | 可以评估什么 | 来源与边界 |
|---|---|---|
| LongMemEval | 跨会话、时间、知识更新、拒答 | [官方仓库](https://github.com/xiaowu0162/LongMemEval)、[作者清洗版数据](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned)。数据卡标注MIT；问题和证据有人工作业，对话含LLM模拟及人工编辑，不能称为真实用户日志。 |
| DuReader / DuReader Robust | 中文真实问题、改写鲁棒性、语义角色和阅读理解 | [百度官方仓库](https://github.com/baidu/DuReader)。可作为中文补充；尚未下载具体数据包，接入时记录该版本的下载来源、条款和指纹。 |
| LoCoMo | 长期对话中的事件与跨会话记忆 | [官方仓库](https://github.com/snap-research/locomo)、[许可](https://github.com/snap-research/locomo/blob/main/LICENSE.txt)。对话由代理生成；许可为CC BY-NC 4.0，本轮未纳入默认数据。 |

LongMemEval的oracle文件仅保留证据会话，适合阅读协议检查；不能据此声称完成包含干扰会话的完整长期记忆评测。本轮没有下载完整LongMemEval。最初的QASPER检索实验没有调用模型，新增真实模型流程的结果单独保存。

## 仍需独立标注的部分

公开QA数据没有穷举本系统应提取的全部原子事实，也没有替本系统生成的额外候选判断对错。完整提取精确率、条件保留率和答案逐条支持率，仍需通过`evaluate:memory:quality`的原子标注流程获得。工具不把关键词匹配、引用ID存在、同模型核验通过或人工标注覆盖不足当成语义正确。
