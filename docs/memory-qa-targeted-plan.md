# qa-targeted：回答目标与未知项成本校准

不可覆盖的事前注册见[注册JSON](memory-qa-targeted-preregistration.json)。本轮开发质量比较qa-calibrated-dev-v3（完整正确13/16、参考充分17/17、正确拒答各1/1、QA333357 tokens）；成本恢复另比qa-efficient-dev-v2（QA262191），不能用333357放宽成本门槛。完整100题直接比较qa-efficient-full；上一轮calibrated没有运行100题。

## 固定开发门槛

20题中19道可答、1道无答案。记忆保留yes或partial至少18；桌面完整正确至少14/19、连接器至少16/19；参考充分各至少17/19；正确拒答各1/1。同次匿名配对净增每入口至少0、合计至少1。顶层QA、所有review轮次以及补查协议错误均为0，安全partial fallback也不隐藏协议失败。实际QA总tokens最多288410，并单列恢复到262191的更强目标。

所有6篇/20题/40个入口/60个分离评分请求、source/eval/binary快照、scope、只读和完整usage均须通过检查。提取、search和memory_query实现本轮保持冻结；允许新question_target及QA/controller/格式合同变更。

## 首次登记即覆盖全部允许开发尝试

新独立开发累计上限1200请求/6M tokens、最多4次fresh20。每次新的完整开发尝试都扣除本轮全部已发生费用，失败运行不删除，不根据分数降低门槛，无自动预算扩展。原calibrated三次失败829请求/3652548 tokens作为历史账本单列，跨轮总费用完整相加。

通过后同生产源码、二进制、评分规则运行完整100题，独立上限2000请求/12M。事前全量目标：完整正确至少62/60，参考充分至少69/68，正确拒答各至少7/9，QA最多1664381；完全恢复成本目标为1513074。未达到的目标如实报告，不能用独立20题拼入100题。

根代理是唯一真实API调用者。具体实现、格式说明、门槛、manifest先冻结，再由11命令统一回归验收，最后运行真实20题；通过才进入100题。所有公开数据是已分析的固定回归，不是未见盲测，自动同模型评判不代替人工语义标注。

## 执行命令

```powershell
node scripts/verify-memory-qa-targeted.mjs
node scripts/evaluate-memory-public-live.mjs --split development --judge-mode separated --output-tag qa-targeted-dev --baseline docs/memory-public-live-qa-calibrated-dev-v3-results.json --max-requests 1200 --max-tokens 6000000
node scripts/verify-memory-qa-targeted-results.mjs docs/memory-public-live-qa-targeted-dev-results.json
node scripts/check-memory-qa-targeted-development.mjs docs/memory-public-live-qa-targeted-dev-results.json docs/memory-public-live-qa-targeted-dev-integrity.json docs/memory-qa-targeted-regressions.json docs/memory-public-live-qa-targeted-dev-gate.json
```

首次开发不传prior-run：上一轮费用已登记为历史成本，不属于新轮额度。若一次开发失败且仍有足够登记预算，修复并重新验收后用新tag，例如qa-targeted-dev-v2，同时传`--prior-run docs/memory-public-live-qa-targeted-dev-results.json`，上限仍为1200/6M，递归扣除所有本轮旧尝试。各次回归证据应保留各自唯一logs/evidence和首次调用前副本，不能覆盖失败gate。

仅固定门槛通过后执行：

```powershell
node scripts/evaluate-memory-public-live.mjs --split all --judge-mode separated --output-tag qa-targeted-full --baseline docs/memory-public-live-qa-efficient-full-results.json --require-gate docs/memory-public-live-qa-targeted-dev-gate.json --max-requests 2000 --max-tokens 12000000
node scripts/verify-memory-qa-targeted-results.mjs docs/memory-public-live-qa-targeted-full-results.json
node scripts/report-memory-qa-targeted.mjs --full docs/memory-public-live-qa-targeted-full-results.json
```

如果通过的是后续开发tag，full的require-gate和报告的`--dev`/`--gate`同时改为该次工件；full不传prior-run或旧budget-addendum。完整100题仅有一个fresh运行tag，失败时只能按原预算显式resume，不能另开fresh full重置费用。
