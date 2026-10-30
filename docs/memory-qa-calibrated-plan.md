# 记忆问答校准：实施与评测

## 冻结比较对象

本轮tag为`qa-calibrated`，使用真实`deepseek-flash`及相同QASPER公开100题。重新执行全文提取、草稿确认、记忆组织、两个Rust问答入口和隔离评分。旧结果不改写：

- 开发基线：`memory-public-live-qa-efficient-dev-v2-results.json`，完整正确13/19、14/19，参考充分均16/19，正确拒答均1/1，实际QA用量262191 tokens。
- 全量基线：`memory-public-live-qa-efficient-full-results.json`，完整正确62/91、60/91，参考充分64/91、65/91，正确拒答均6/9，实际QA用量1513074 tokens。

注册见[不可变预登记](memory-qa-calibrated-preregistration.json)，于首次新真实调用之前写入。提取核心不变；提取随机漂移仍计入完整链路差值。答案、记忆、检索评分的prompt、gold、标签、匿名配对规则不变。旧原始评分和本次重新评分旧答案分别报告。

## 20题放行条件

所有条件必须同时通过，不根据新结果降低：

| 条件 | 最低或最高值 |
| --- | --- |
| 论文、问题、入口、隔离评分 | 6篇、20题、40入口、20份完整判断 |
| 正式记忆正文yes或partial | 至少18/19 |
| 桌面/飞书完整正确 | 至少13/19、14/19 |
| 桌面/飞书参考充分 | 各至少16/19 |
| 无答案正确拒答 | 两入口各1/1 |
| 同次匿名配对净增 | 每入口至少0，合计至少1 |
| 顶层及补查协议失败 | 均为0 |
| 两入口实际QA tokens | 至多288410，较262191增长不超过10% |
| 完整性 | 零跨项目引用；只读问答；来源、当前版本、gold隔离校验通过 |
| 冻结 | 通过测试的源码、二进制、新轮评测manifest和注册SHA与运行一致 |

历史原开发预算为600次真实请求、300万provider报告tokens；原注册和两轮失败结果均保留。两次失败后、第三次回归和真实调用前登记[唯一预算addendum](memory-qa-calibrated-budget-addendum-1.json)：仅增加300请求/150万tokens，累计最多900请求/450万tokens，不自动进行第二次扩展。两失败共548请求/2451045tokens，第三次运行剩352请求/2048955tokens；不是重置为新预算。生产仍最多5次调用、累计180000输入字符、24条聚焦参考/36000字符。所有生成、改写、审查和失败尝试均计入成本，质量及当前20题QA<=288410原样。

## 100题事前目标

开发通过后以完全相同版本运行完整100题。下列目标用于最终诚实对比，未达逐项保留，不能回头改变标准：完整正确至少62/91、60/91；参考充分至少69/91、68/91；两入口无答案正确拒答各至少7/9；两入口QA tokens至多1664381（上一轮1513074的110%向下取整）。全量总预算2000请求、1200万报告tokens。

## 执行顺序

根代理持有唯一真实API执行权。以下工具只使用既有环境变量，不在命令中写密钥。

```powershell
node scripts/verify-memory-qa-calibrated.mjs
node scripts/evaluate-memory-public-live.mjs --split development --judge-mode separated --output-tag qa-calibrated-dev-v3 --baseline docs/memory-public-live-qa-efficient-dev-v2-results.json --prior-run docs/memory-public-live-qa-calibrated-dev-v2-results.json --budget-addendum docs/memory-qa-calibrated-budget-addendum-1.json --max-requests 900 --max-tokens 4500000
node scripts/verify-memory-public-live.mjs docs/memory-public-live-qa-calibrated-dev-v3-results.json --no-write
```

将上述完整性结果保存到新的本轮文件，然后执行新gate；输出使用独占创建，不能覆盖已发生的失败门槛。

```powershell
node scripts/check-memory-qa-calibrated-development.mjs docs/memory-public-live-qa-calibrated-dev-v3-results.json docs/memory-public-live-qa-calibrated-dev-v3-integrity.json docs/memory-qa-calibrated-regressions.json docs/memory-public-live-qa-calibrated-dev-v3-gate.json
```

仅`passed=true`且所有检查通过后：

```powershell
node scripts/evaluate-memory-public-live.mjs --split all --judge-mode separated --output-tag qa-calibrated-full --baseline docs/memory-public-live-qa-efficient-full-results.json --require-gate docs/memory-public-live-qa-calibrated-dev-v3-gate.json --budget-addendum docs/memory-qa-calibrated-budget-addendum-1.json --max-requests 2000 --max-tokens 12000000
node scripts/verify-memory-public-live.mjs docs/memory-public-live-qa-calibrated-full-results.json --no-write
node scripts/report-memory-qa-calibrated.mjs --full docs/memory-public-live-qa-calibrated-full-results.json
```

新运行若出现开发失败，原始工件和gate保留；修代码后重新完成测试，用新tag、`--prior-run`递归共享累计预算，不能只扣上一轮或重置。全量也显式传同一addendum以匹配gate，但不传development的prior-run，其2000/12M预算独立。报告从最终dev的完整ledger自动读取两轮失败运行并去重计费，支持显式`--dev`、`--gate`和历史`--initial-dev`/`--initial-gate`参数。不得为挑选好答案而重评已合法打分的题；沿用既有一次评分格式失败修复流程，失败响应与额外费用完整保留。

## 报告与限制

完整100题总览前置，分别统计同一次100题内开发20和固定回归80；不把单独开发运行拼入全量分数。逐题记录新增、退化、拒答、参考充分、阶段损失、真实QA调用/tokens/延迟。实际producer选择和审查轮次分别关联，避免本地首轮没有generation时错配。未知项处理只做保存工件的事后诊断，原始unknowns、review和收据保持可审计；格式说明见[本轮适配边界](memory-qa-calibrated-format-adaptation.md)。

80题已参与此前分析，全部100题均为固定回归，不是未见盲测。评分仍是同模型自动判断；人工语义复核、断言精确率和长期记忆生命周期未完成。9道无答案题不能建立普遍拒答可靠性。两轮旧14文件SHA及快照保留，第三次新增预算helper/addendum后采用独立16项manifest，不修改历史证据。
