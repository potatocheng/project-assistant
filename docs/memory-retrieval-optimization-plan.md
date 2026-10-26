# 检索、上下文组装与拒答优化：实施及预注册评测

本轮沿用已完成的提取预算、组织校验和草稿审核机制；改进正式记忆检索、发送给模型的上下文选择、回答审查及证据不足时的定向补查。先完成代码及确定性测试，运行真实 LLM 的20题开发集，通过冻结门槛后运行完整100题。

## 冻结材料与比较方式

- 数据指纹与来源沿用 [QASPER 数据清单](memory-public-dataset-manifest.json)，36篇论文、91道可答题和9道无答案题。
- 开发集：固定6篇、20题（19道可答、1道无答案）；上一轮开发基线是 `memory-public-live-optimized-dev-v2-results.json`。
- 完整100题比较基线是 `memory-public-live-optimized-full-results.json`。所有旧工件保留；新标签为 `retrieval-dev`、`retrieval-full`，失败后修订使用新的标签及门槛文件。
- 每轮实际重新执行全文提取、组织校验、ready候选原样确认、两个生产问答入口和隔离评分。待审核草稿不自动修正或确认。
- 提取核心 `ai.rs` 和持久化 `extraction_store.rs` 与上一轮开发基线指纹必须一致。新的提取输出仍有模型随机性，因此完整链路差值不能完全归因为检索变更；如做同记忆诊断，单独标记，不替代端到端结果。
- 回答评分在同一调用内对新旧答案匿名配对；报告同时列出上一轮原始评分与本轮重新评分的基线，明确评分漂移。
- memory-only评分只看正式记忆正文；retrieval-only评分只看最后一次实际生成上下文；answer-only评分看参考答案和匿名最终答案。评分提示词与规则继续沿用上一轮。

## 跑前冻结开发门槛

机器注册文件：[memory-retrieval-preregistration.json](memory-retrieval-preregistration.json)。时间戳和旧基线SHA256保存在注册工件中；门槛脚本禁止覆盖已写入的门槛结果。

| 检查 | 本轮最低条件 | 上一轮开发原始值 |
| --- | --- | --- |
| 桌面完整答对 | 至少9/19 | 7/19 |
| 飞书问答完整答对 | 至少9/19 | 7/19 |
| 同次匿名配对净增完整答对 | 每入口至少净增1题，20题配对评分齐全 | 上一轮原始分另列，不替代同次配对 |
| 桌面实际生成参考充分 | 至少11/19 | 9/19 |
| 飞书问答实际生成参考充分 | 至少9/19 | 7/19 |
| 两入口无答案正确拒答 | 分别1/1 | 分别1/1 |
| 正式记忆信息保留 | 至少15/19为yes或partial | 18/19 |
| 提取/工件/范围 | 6/6成功、20题评分齐全、零跨项目引用、完整性验证通过 | 必须保持 |
| 确定性回归 | 所有记录命令退出0；测试的源码和二进制匹配真实开发运行 | 必须满足 |

开发集只有1道无答案题，不能证明一般拒答能力。完整100题中的9道无答案题仍要单列，上一轮两个入口均为5/9；不把无答案题混入91道可答题准确率。若开发门槛失败，保留失败工件与分数，先修代码，不放宽门槛进入100题。

## 实现和预算边界

检索继续采用无向量方案。扩大候选覆盖、减少重复上下文、保留条件及来源邻近信息；只读取已确认且未失效的正式记忆。聚焦问答使用最多24条参考、约36000模型参考字符；桌面总览保留40条总参考/40000字符，其中正式记忆最多24条。问题、schema与封装另计入累计输入预算。每次grounded模型输出执行证据审查，本地结构化字段直读保留；unknown/partial或有效语义审查否决时最多一次定向补查。审查的传输、解析、schema或预算不可用时直接拒答，不再发起补查。最多5次生产模型调用、累计180000输入字符。60000报告token为调用后停止阈值，单请求可以越过阈值并被拒绝输出，不是调用前硬预留。保留原超时。

这同时改变了检索与QA预算，报告须列出实际调用、输入/输出token、延迟及补查次数。不得把预算增加带来的收益称为等成本提升。提取和QA均禁止读取标准答案、gold段落标记或评测结论。

真实调用总上限：开发集600次请求/300万报告token，完整100题2000次请求/1200万报告token；包含提取、生产问答和评分。无网络自动重试。到达上限后保留已完成工件并停止，缺失结果保留分母。评分器单个末尾右括号的确定性语法恢复沿用原规则并审计；显式格式重评只针对失败评分阶段，不选分数较高者。

## 复现顺序

```powershell
node scripts/verify-memory-retrieval-optimized.mjs
node scripts/evaluate-memory-public-live.mjs --split development --output-tag retrieval-dev --judge-mode separated --baseline docs/memory-public-live-optimized-dev-v2-results.json --max-requests 600 --max-tokens 3000000 --workers 3
node scripts/verify-memory-public-live.mjs docs/memory-public-live-retrieval-dev-results.json
node scripts/check-memory-retrieval-development.mjs docs/memory-public-live-retrieval-dev-results.json docs/memory-public-live-retrieval-dev-integrity.json docs/memory-retrieval-optimized-regressions.json docs/memory-public-live-retrieval-dev-gate.json
# 仅上一命令返回通过后运行；源码、二进制与通过门槛的开发运行保持相同。
node scripts/evaluate-memory-public-live.mjs --split all --output-tag retrieval-full --judge-mode separated --baseline docs/memory-public-live-optimized-full-results.json --require-gate docs/memory-public-live-retrieval-dev-gate.json --max-requests 2000 --max-tokens 12000000 --workers 3
node scripts/verify-memory-public-live.mjs docs/memory-public-live-retrieval-full-results.json
node scripts/report-memory-retrieval-optimized.mjs --dev docs/memory-public-live-retrieval-dev-results.json --gate docs/memory-public-live-retrieval-dev-gate.json --full docs/memory-public-live-retrieval-full-results.json
```

完整100题已经参与此前分析，是固定回归集，不是未见过的盲测。自动评分使用同一模型，可能产生错误；未经独立人工逐条标注，断言精确率保持未测。公开英文论文不能替代中文业务资料及长期记忆生命周期评测。
