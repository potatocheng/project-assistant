# 提取预算与组织校验优化：真实LLM完整链路复测

生成时间：2026-10-20T11:12:10.326Z。模型：`deepseek-flash`。QASPER冻结数据，CC BY 4.0，[数据来源和适配](memory-public-datasets.md)。

## 执行范围与结论

开发集：已完成；预注册门槛：未通过；门槛与开发工件匹配：是。

本报告仅包含开发集；未提供100题全量运行结果，不能据此宣称完整链路在100题上的提升。

19道可答题：桌面完整答对 0/19 → 2/19；飞书问答完整答对 0/19 → 2/19。1道无答案题分别计分。

正文留存、检索与回答使用隔离上下文评分；答案新旧匿名配对评分。评分器仍是同一模型，尚无独立人工复核。原80题已参与问题分析，现为固定回归集。

## 方案与边界

提取采用2400字符窗口、6144输出token、12条记忆/4条任务/合计16条上限；Rust执行长度和数量校验，仅对明确输出容量错误有界拆分。任务限制512次请求、300万token和20分钟，缺usage及在途请求保守预留，恢复与还原保留预算高水位。逐批事务保存草稿，保留失败前成果；待确认候选和范围待审核草稿均不参与正式检索。

仅导航topic错误可隔离标签并保留原值。主体、角色、条件、有效期问题转待审核；本次评测未代替人工修正或放行。正式记忆只来自实际模型ready候选的原样确认。研究论文中的语义断言精确率没有独立标签，本报告记为null。

## 开发集20题

6篇、20题（可答19、无答案1）；完成：是；评分模式：`separated`。

| 提取与组织观测 | 结果 |
| --- | --- |
| 任务终态 | succeeded 6 |
| 错误码 / 任务预算失败 | 无 / 0 |
| 正式记忆正文 | 765 |
| 草稿总数 / 范围待审核 | 1001 / 228 |
| topic隔离 / 仅topic隔离且ready | 88 / 44 |
| 草稿状态 | ready 773；needs_review 228 |
| 批次终态 | succeeded 100 |
| 未审草稿进入正式记忆 | 0 |
| 完整JSON响应 / 恰达12条记忆 / 4条任务 / 合计16 | 100 / 33 / 1 / 1 |

恰达上限的批次可能存在信息压缩，单列为饱和信号，不能直接算遗漏。topic隔离可能与关键范围问题重叠；待审核草稿未自动放行。

正文信息留存（可答题，memory-only隔离评分）：no 7；yes 11；partial 1。

| 入口 | 完整答对 | 部分答对 | 无答案题正确拒答 | 协议错误/全部QA错误 | 可答题拒答或不具依据 | p50/p95秒 |
| --- | --- | --- | --- | --- | --- | --- |
| 桌面 | 2/19（10.5%） | 1/19（5.3%） | 1/1（100.0%） | 11/11 | 3/19（15.8%） | 2.9/4.4 |
| 飞书问答 | 2/19（10.5%） | 1/19（5.3%） | 1/1（100.0%） | 13/13 | 3/19（15.8%） | 1.9/2.7 |

| 入口 | 实际最后生成参考正文充分性 | 记忆充分时完整召回 | 参考充分时完整答对 |
| --- | --- | --- | --- |
| 桌面 | no 8；partial 4；yes 7 | 6/11（54.5%） | 2/7（28.6%） |
| 飞书问答 | partial 5；yes 6；no 8 | 5/11（45.5%） | 2/6（33.3%） |

检索充分性由独立上下文的retrieval-only调用判断实际送给最后一次生成的正文；这是同模型自动估计。来源段落ID命中不能代替正文信息充分性。

| 入口 | 同题优化前→后完整答对 | 新增成功 | 退化 | 同次匿名配对评分 |
| --- | --- | --- | --- | --- |
| 桌面 | 0/19 → 2/19 | 2 | 0 | 20/20 |
| 飞书问答 | 0/19 → 2/19 | 2 | 0 | 20/20 |

旧原段落诊断对照（相同问题；跳过提取，不能当完整链路）：桌面 7/19（36.8%）；飞书问答 7/19（36.8%）。

| 阶段 | 调用 | 输入token | 输出token | 总token | 缺usage | 请求耗时累计秒 |
| --- | --- | --- | --- | --- | --- | --- |
| extraction:extraction | 100 | 259530 | 149338 | 408868 | 0 | 458.9 |
| qa:generation | 48 | 260978 | 15347 | 276325 | 0 | 77.2 |
| qa:answer_review | 8 | 22302 | 750 | 23052 | 0 | 9.1 |
| qa:query_rewrite | 8 | 16620 | 197 | 16817 | 0 | 6.1 |
| judge:answer | 20 | 18296 | 2380 | 20676 | 0 | 20.8 |
| judge:memory | 20 | 238414 | 2671 | 241085 | 0 | 27.1 |
| judge:retrieval | 20 | 24338 | 1831 | 26169 | 0 | 21.0 |

本次224次调用、1,012,992个已报告token；实际墙钟6.4分钟。并发请求耗时不能相加当墙钟。

问答错误码：桌面 ASSISTANT_GROUNDING 11；飞书问答 QA_GROUNDING 13。

互斥首次损失标签：桌面 memory_content_missing 8；retrieval_context_loss 5；answer_protocol_error 4；success 2；飞书问答 memory_content_missing 8；retrieval_context_loss 6；answer_protocol_error 3；success 2。这些标签用于排查，不能证明因果。

## 确定性检查与旧候选离线回放

确定性检查：记录全部通过；9条命令。记录时间2026-10-20T11:05:05.756Z。

| 命令 | 退出码 | 日志 |
| --- | --- | --- |
| cargo.exe test -p project-assistant-core --locked | 0 | .local-data\extraction-regressions-yUwMmp\1.log |
| cargo.exe clippy -p project-assistant-core --locked --lib --tests -- -D warnings | 0 | .local-data\extraction-regressions-yUwMmp\2.log |
| cargo.exe build -p project-assistant-core --bin pm-host --locked | 0 | .local-data\extraction-regressions-yUwMmp\3.log |
| powershell.exe -NoProfile -Command npm run build | 0 | .local-data\extraction-regressions-yUwMmp\4.log |
| node.exe --test scripts/score-memory-public-live.test.mjs scripts/memory-public-live-options.test.mjs scripts/evaluate-memory-quality.test.mjs scripts/check-memory-public-development.test.mjs | 0 | .local-data\extraction-regressions-yUwMmp\5.log |
| node.exe scripts/verify-restart.mjs | 0 | .local-data\extraction-regressions-yUwMmp\6.log |
| node.exe scripts/verify-extraction-recovery.mjs | 0 | .local-data\extraction-regressions-yUwMmp\7.log |
| node.exe scripts/verify-memory-public-live.mjs --no-write | 0 | .local-data\extraction-regressions-yUwMmp\8.log |
| cargo.exe test -p project-assistant-core --lib --locked replay_public_live_extraction_v5 -- --ignored --nocapture | 0 | .local-data\extraction-regressions-yUwMmp\9.log |

冻结旧响应2104条候选离线回放：all_fields_valid 1；core_invalid 14；scope_needs_review 1766；topic_only_quarantined_ready 323；单候选ready由1增加到324。

旧6000字符批次有89份响应、1979条候选超出新批次数量容量，需重新提取。此回放没有新LLM调用，不能当成新完整链路结果或语义精确率。

## 开发门槛记录

| 检查 | 通过 | 观测 |
| --- | --- | --- |
| frozen_development_scope | 是 | {"papers":6,"questions":20,"answerable":19,"unanswerable":1} |
| complete_run | 是 | {"complete":true,"haltReason":null} |
| extraction_jobs_completed | 是 | 6 |
| nonempty_confirmed_memory_per_paper | 是 | [{"id":"1603.01514","memories":112},{"id":"1902.09666","memories":74},{"id":"1806.00738","memories":38},{"id":"1908.07245","memories":54},{"id":"1902.09243","memories":107},{"id":"1705.01214","memories":380}] |
| integrity_verified | 是 | [{"file":"docs/memory-public-live-optimized-dev-results.json","passed":true}] |
| deterministic_regressions_passed | 是 | [{"command":"cargo.exe test -p project-assistant-core --locked","exitCode":0,"elapsedMs":81851,"log":".local-data\\extraction-regressions-yUwMmp\\1.log"},{"command":"cargo.exe clippy -p project-assistant-core --locked --lib --tests -- -D warnings","exitCode":0,"elapsedMs":10853,"log":".local-data\\extraction-regressions-yUwMmp\\2.log"},{"command":"cargo.exe build -p project-assistant-core --bin pm-host --locked","exitCode":0,"elapsedMs":1015,"log":".local-data\\extraction-regressions-yUwMmp\\3.log"},{"command":"powershell.exe -NoProfile -Command npm run build","exitCode":0,"elapsedMs":16817,"log":".local-data\\extraction-regressions-yUwMmp\\4.log"},{"command":"node.exe --test scripts/score-memory-public-live.test.mjs scripts/memory-public-live-options.test.mjs scripts/evaluate-memory-quality.test.mjs scripts/check-memory-public-development.test.mjs","exitCode":0,"elapsedMs":618,"log":".local-data\\extraction-regressions-yUwMmp\\5.log"},{"command":"node.exe scripts/verify-restart.mjs","exitCode":0,"elapsedMs":3923,"log":".local-data\\extraction-regressions-yUwMmp\\6.log"},{"command":"node.exe scripts/verify-extraction-recovery.mjs","exitCode":0,"elapsedMs":4220,"log":".local-data\\extraction-regressions-yUwMmp\\7.log"},{"command":"node.exe scripts/verify-memory-public-live.mjs --no-write","exitCode":0,"elapsedMs":782,"log":".local-data\\extraction-regressions-yUwMmp\\8.log"},{"command":"cargo.exe test -p project-assistant-core --lib --locked replay_public_live_extraction_v5 -- --ignored --nocapture","exitCode":0,"elapsedMs":1724,"log":".local-data\\extraction-regressions-yUwMmp\\9.log"}] |
| no_cross_project_citations | 是 | 0 |
| all_isolated_judgments_available | 是 | 20 |
| question_information_retained | 否 | 12 |
| desktop_complete_answers | 否 | 2 |
| desktop_correct_abstention | 是 | 1 |
| connector_complete_answers | 否 | 2 |
| connector_correct_abstention | 是 | 1 |

## 局限与复现

- 提取通过率、组织字段合法率和逐字引文匹配均不能代替事实正确率。语义断言精确率为null，独立人工复核未做。
- 同模型隔离评分减少阶段混淆，仍可能误判；完整段落来源覆盖也不能代替答案所需信息覆盖。
- 公开英文论文不等于中文真实业务数据；未覆盖长期更新、遗忘、实体歧义与全生命周期冲突。
- 报告只读取已保存工件，不产生模型调用。复测命令会产生真实调用与费用。

[机器指标与逐题变化](memory-extraction-optimized-metrics.json)；[旧完整链路报告](memory-public-live-report.md)；[旧原段落诊断对照](memory-public-live-control-summary.json)。

报告输入和所有阶段指标保存在机器JSON；完整原文、模型收据位于相应隔离workspace。生成命令：

```powershell
node scripts/report-memory-extraction-optimized.mjs --dev "docs/memory-public-live-optimized-dev-results.json" --gate "docs/memory-public-live-optimized-dev-gate.json" --regressions "docs/memory-extraction-optimized-regressions.json" --offline "docs/memory-public-live-optimized-offline-replay.json"
```
