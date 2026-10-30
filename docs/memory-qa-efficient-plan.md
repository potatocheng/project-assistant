# QA高效轮：拒答、对象区分、格式可靠与token评测

本轮基于已完成的检索优化，继续改善过度拒答、主研究/子模型/相关工作的对象区分、输出协议与实际QA token。提取核心及持久化保持上一轮版本；QA、通用对象导航与候选多样性、上下文及引用输出可优化。先完成代码与确定性测试，再真实20题过门槛，最后相同源码/二进制/评测规则运行100题。

## 基线与跑前冻结门槛

[预注册文件](memory-qa-efficient-preregistration.json)保存登记时间、固定数据SHA256及上一轮基线指纹。

- 独立开发基线：`memory-public-live-retrieval-dev-v2-results.json`，桌面9/19、连接器13/19；双方参考充分16/19，正确拒答各1/1。
- 完整100题基线：`memory-public-live-retrieval-full-results.json`，双方55/91完整正确，正确拒答分别7/9、6/9；分开报告历史原分与本轮匿名配对重新评分。
- 数据仍为36篇QASPER论文、100题（91可答、9无答案）；20题开发与80题固定回归按原paper拆分。已看过的问题不是未见盲测。

| 开发检查 | 冻结条件 |
| --- | --- |
| 桌面完整正确 | 至少11/19 |
| 连接器完整正确 | 至少13/19 |
| 两入口参考充分 | 分别至少15/19，上一轮各16/19 |
| 无答案正确拒答 | 两入口分别1/1 |
| 同次匿名配对 | 桌面净增至少1题，连接器不退化，合计净增至少2个入口答案 |
| 记忆信息保留 | yes或partial至少15/19 |
| 提取及完整性 | 6/6提取成功，40个生产入口结果及20题评分齐全，零跨项目引用，完整性验证通过 |
| 顶层QA协议错误 | 0；补查引用/格式失败不超过上一轮开发的1例，即使安全回退也计入 |
| 实际QA token | 全部QA请求usage齐全，组合不超过439346，较同20题旧基线516878至少降低15% |
| 源码与证据 | ai.rs及extraction_store.rs保持基线版本；实际运行源码/二进制及新评测manifest与已通过测试完全一致 |

QA token包括生成、审查、改写和失败尝试，不含提取及事后评分；这些阶段仍计入真实总用量。不得通过缺usage或跳过结果制造节省。正确拒答只有1题，不能外推一般可靠性；完整100题的9道无答案题继续单列。

## 实施边界

通用对象导航区分主研究、模型/子模型、相关工作与实验阶段，避免将整个流程人数、其他研究语言等混入所问对象。不得硬编码QASPER题号、标准答案或gold来源。

审查分开判断断言支持、直接回答及所有所问目标是否完整。`completeAnswer`只允许在所有已问目标已回答且审查一致时，移除未问的unknowns并升级状态；不能添加、修改断言或扩大引用。完整与缺失、支持false矛盾的审查结果拒绝。

紧凑引用使用稳定ID、正整数reference/span索引及完整正文的连续片段。模型输出数字支持片段，Rust按可信当前引用展开并严格校验；不做模糊ID匹配。审查输入保留完整当前编号正文及所选支持片段、项目/标题/时间，去掉重复回答与quote传输。JSON-schema模式只保留provider schema一份，JSON-object保留user.schema一份。

补查失败或被拒绝时，仅可返回初次已经引用校验、supported且answersQuestion的grounded partial；返回前复验初次及当前两个上下文。trace保留全部真实生成顺序，并用answerGenerationIndex=0及reviewedPartialFallback选择实际返回答案对应上下文。预算在第二次请求前拒绝时允许只有一次实际生成，不能伪造第二次。相同上下文补查跳过第二次生成，但仍复验两个快照，记录UNCHANGED_CONTEXT。

生产上限仍为最多5次调用、累计180000输入字符、聚焦24条参考/36000模型参考字符；报告token停止阈值沿用生产实现。实际节省必须用收据验证。评测格式投影与实际generation选择见[格式适配](memory-qa-efficient-format-adaptation.md)，不改变隔离评分提示词或标签。

## 运行顺序

本轮新标签为 `qa-efficient-dev`、`qa-efficient-full`，独立报告及gate不覆盖上一轮。任何失败pilot保留，后续开发通过prior-run共享600请求/300万报告token总预算；完整100题上限2000请求/1200万token。预算耗尽即停，不扩大上限。

```powershell
node scripts/verify-memory-qa-efficient.mjs
node scripts/evaluate-memory-public-live.mjs --split development --output-tag qa-efficient-dev --judge-mode separated --baseline docs/memory-public-live-retrieval-dev-v2-results.json --max-requests 600 --max-tokens 3000000 --workers 3
node scripts/verify-memory-public-live.mjs docs/memory-public-live-qa-efficient-dev-results.json
node scripts/check-memory-qa-efficient-development.mjs docs/memory-public-live-qa-efficient-dev-results.json docs/memory-public-live-qa-efficient-dev-integrity.json docs/memory-qa-efficient-regressions.json docs/memory-public-live-qa-efficient-dev-gate.json
# 只在新门槛通过后执行；同一源码、二进制、评测规则保持冻结。
node scripts/evaluate-memory-public-live.mjs --split all --output-tag qa-efficient-full --judge-mode separated --baseline docs/memory-public-live-retrieval-full-results.json --require-gate docs/memory-public-live-qa-efficient-dev-gate.json --max-requests 2000 --max-tokens 12000000 --workers 3
node scripts/verify-memory-public-live.mjs docs/memory-public-live-qa-efficient-full-results.json
node scripts/report-memory-qa-efficient.mjs --dev docs/memory-public-live-qa-efficient-dev-results.json --gate docs/memory-public-live-qa-efficient-dev-gate.json --full docs/memory-public-live-qa-efficient-full-results.json
```

评分为同模型自动估计，可能存在分阶段分歧；所有原分、重新评分、协议修复、费用均保留。标准答案仅进入事后评分。未经独立人工逐项标注，断言精确率未测；公开英文论文不能代替中文真实业务资料及长期记忆生命周期评测。

## 首轮开发完成但未通过质量门槛

首轮 `qa-efficient-dev` 已完整执行20题：252次真实请求、1162094报告token，其中QA289891，比旧20题QA基线减少43.9%。完整正确为桌面13/19、连接器14/19，双方正确拒答1/1，顶层协议错误0。唯一未通过条件是连接器参考充分14/19，低于冻结的15/19。该结果是完整执行后的质量门槛失败，不是评分JSON故障。

原分数及 `memory-public-live-qa-efficient-dev-gate.json` 的false结果保留；不降低门槛，不对同一输出重评分。修复通用邻接锚点公平性和不规则corpus/corpora词形后，重新完整运行 `qa-efficient-dev-v2`，并重新执行全部确定性检查。

新20题通过 `--prior-run docs/memory-public-live-qa-efficient-dev-results.json --max-requests 600 --max-tokens 3000000` 共享原开发总预算，剩348次请求/1837906token。最终gate为 `memory-public-live-qa-efficient-dev-v2-gate.json`；只有该门槛通过才能进入完整100题。新报告默认读dev-v2，并把首轮作为独立pilot纳入成本；也可显式传 `--initial-dev`、`--initial-gate` 指定原工件。
