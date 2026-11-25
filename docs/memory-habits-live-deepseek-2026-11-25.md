# DeepSeek 真实端到端评测（记忆检索、冲突巡检与习惯系统）

本页记录在完成 6 项工程缺陷修复后，使用 `deepseek-flash` 通过生产 Rust Engine（`pm-host`）与真实副驾驶（`pi-copilot-agent.ts`）跑通端到端闭环的结果。本机保持不接入任何远程向量服务。

- 本次实测共调用 DeepSeek API **43** 次，合计消耗 **95,328** tokens（输入 89,787 / 输出 5,541）。
- 完整原始结果见 `output/live-deepseek-20261125/results.json`（已纳入 `.gitignore`）。

## 总体结果

| 链路 | 样本与场景 | 实测结果 | 说明 |
| --- | --- | --- | --- |
| Track A：别名有据问答与拒答 | 5 题可答（别名/否定）+ 3 题不可答 | 可答 **5/5**、拒答 **3/3** | 归档、跨项目与未知问题均返回 `unknown`（0 引用） |
| Track B：提取 → 休眠期冲突巡检 → 解决 → 问答 | 2 份前后变更文档 | 提取 **4/4**、检出 **2/2** 冲突、解决后问答 **2/2** 正确 | 新日期（12-10）与新负责人（李静）命中，旧值（12-01 / 王明）**0 泄漏** |
| Track C：PRELUDE 写作习惯 → 日报润色 A/B | 4 份新建草稿（无习惯 vs 3 次编辑学得习惯） | 软化风险措辞 **0/4 → 3/4**；省略百分比 **0/4 → 1/4** | 条列风格基线与加习惯均为 4/4；4 份均保留关键事实（其中 `48小时` 模型改写为空格版 `48 小时`） |
| Track D：PAHF 副驾驶习惯学习 → 漂移 → 事实隔离 | 4 阶段连续交互 | 遵循 **2/2**、漂移适配 **100%**、事实隔离 **通过** | `priority:high → low` 覆盖并记住后自动暂停旧习惯并立即按新习惯建任务；事实问答查记忆答出陈雨 |

## 逐项观察与边界

### Track A：中文别名问答

| 用例 | 类型 | 状态 | 耗时（ms） | 观察 |
| --- | --- | --- | ---: | --- |
| `alias_person`（老王） | 人名别名 | `partial`（有据） | 7143.8 | 通过别名召回王明记录并给出路由与 `2026-12-05`；因原文未写“老王”，严谨审校将别名对应列为待确认 |
| `alias_term`（RC） | 术语别名 | `answered` | 2145.7 | 准确答出 `35 毫秒` 与超时降级放行 |
| `alias_project`（二期） | 项目别名 | `answered` | 2358.7 | 准确答出 `5%` 与观察 `48 小时` |
| `alias_multi`（敏姐 / 清算） | 多实体组合 | `answered` | 3583.4 | 准确答出 `5000 TPS` 与冻结 `DDL` |
| `negation_decision` | 否定决策 | `answered` | 1957.8 | 准确答出已否决短信验证码 |
| `archived_abstention` | 归档隔离 | `unknown` | 2715.4 | 正确拒答，未泄漏已归档路由与人名 |
| `cross_project_abstention` | 跨项目隔离 | `unknown` | 2296.0 | 正确拒答，未泄漏隔离项目中的 `SECRET_TOKEN_42` |
| `unknown_abstention` | 无资料拒答 | `unknown` | 2352.4 | 正确拒答，未编造机房信息 |

### Track B：真实提取 → 休眠期冲突巡检 → 解决 → 问答

1. 两份资料（`11月周会纪要` 与 `排期变更通知`）经真实模型提取并确认形成 4 条活跃记忆。
2. `run_memory_audit` 自动检出 `owner_conflict` 与 `date_conflict`（2/2）。
3. 调用 `resolve_memory_audit` 保留最新记录后，旧修订转入归档层；后续针对上线日期和负责人的问答均命中最新结论（`2026-12-10`、`李静`），旧值（`2026-12-01`、`王明`）零泄漏。

### Track C：PRELUDE 日报润色习惯 A/B（4 份草稿）

通过 3 次真实日报编辑自动合成并确认 3 条习惯（`writing:bullet_style`、`writing:soften_risk_wording`、`writing:drop_percentages`；因示例编辑将「存在风险」改写为「需协调与待确认事项」，未触发 `writing:risks_first`）。

| 指标 | 无习惯基线（n=4） | 启用学得习惯后（n=4） | 备注 |
| --- | ---: | ---: | --- |
| 省略细粒度百分比 | 0/4（0%） | 1/4（25%） | 模型在 `team` 风格草稿中仍常保留原始进度百分比，单靠软提示词约束有限 |
| 软化「风险/阻塞」措辞 | 0/4（0%） | 3/4（75%） | 多份草稿将小节标题改为「待协调事项 / 待确认事项」 |
| 条列要点格式 | 4/4（100%） | 4/4（100%） | `team` 风格模板默认即使用列表 |
| 关键事实保留（含空格归一） | 4/4（100%） | 4/4（100%） | 严格子串统计为 3/4，因 `d4` 中 `48小时` 被排版为 `48 小时` |

### Track D：PAHF 副驾驶偏好漂移与事实隔离

1. **冷启动（Stage 1）**：用户要求创建「补齐压测报告」时模型未预设优先级与负责人；用户在审批卡覆盖为 `priority=high, assignee=王明` 并勾选记住习惯后，立即激活两条工作流习惯。
2. **习惯遵循（Stage 2）**：新任务「核对灰度回滚脚本」未指定参数时，模型自动填入 `priority=high, assignee=王明`。
3. **偏好漂移（Stage 3）**：用户在下一任务将优先级改回 `low` 并记住习惯后，旧 `priority:high` 自动转为 `paused`，`priority:low` 与 `assignee:王明` 共存为 `active`；随后创建「整理上线验收清单」时模型立即切换为 `priority=low` 并保留 `assignee=王明`。
4. **事实隔离（Stage 4）**：询问「支付重构核心交易路由模块是谁负责的？」时，尽管工作流习惯存在 `assignee=王明`，副驾驶仍主动调用 `ask_verified_memory` 与 `search_project_memory`，明确回答由**陈雨**负责，并主动提示王明仅负责外围压测脚本。

## 方法与复跑

脚本位于 [live-deepseek-e2e.mjs](../scripts/benchmarks/live-deepseek-e2e.mjs)，通过本机回环鉴权代理转发至 `https://api.deepseek.com/chat/completions`（自动附带 `thinking: { type: "disabled" }`），真实 API Key 仅保留在环境变量与进程内存中，不写入任何报告或工作区文件。每组场景均为小样本定向验证，不代表生产总体准确率。

```powershell
cargo build -p project-assistant-core --bin pm-host --locked
$env:DEEPSEEK_API_KEY = "<your-key>"
node scripts/benchmarks/live-deepseek-e2e.mjs
```

## 第二轮改进与复测（2026-11-25）

针对第一轮基准与真实 DeepSeek 端到端中暴露的 4 项瓶颈完成定点修复：

1. **休眠期冲突巡检召回与同项目分阶段保护**（[memory_audit.rs](../crates/core/src/memory_audit.rs)）：支持中文日期（`12月5日`/`2026年12月5日`）、英文日期（`Dec 5`）与短斜杠/短横线日期并做同月日跨格式去重；新增阶段兼容保护（如同项目 `封板` 与 `上线` 不再误报 `date_conflict`）；扩展中英文自然语言负责人表达并加主题词相似度保护（同项目不同任务不再误报）；补充英文否定词识别。
2. **问答与审校链路条件透传 `entityAliases`**（[aliases.rs](../crates/core/src/aliases.rs)、[assistant_qa.rs](../crates/core/src/assistant_qa.rs)、[qa.rs](../crates/core/src/qa.rs)、[answer_contract.rs](../crates/core/src/answer_contract.rs)、[question_flow.rs](../crates/core/src/question_flow.rs)）：仅当问题命中用户配置的别名组时，向 `evidence_reader` 的 `presentationContext.entityAliases` 与复核输入透传别名映射。
3. **润色 Prompt 分离写作习惯与事实红线**（[ai.rs](../crates/core/src/ai.rs)）：新增 `polish_habit_block`，将已确认 `writing_habits` 提升为最高优先级指令块，并在启用省略百分比习惯时动态调整第 2 条数值红线。
4. **扩展 PRELUDE 规则外写作习惯观测器**（[habits.rs](../crates/core/src/habits.rs)）：新增 `writing:no_greeting_closing`（去问候与客套结语）、`writing:table_style`（Markdown 表格改写）与 `writing:conclusion_first`（结论/总结前置）。

复测结果（`cargo test -p project-assistant-core --locked` 全部通过、`node --test scripts/pi-copilot-memory.test.mjs` 11/11 通过，DeepSeek Track A,C 复测结果保存于 [results-round2.json](../output/live-deepseek-20261125/results-round2.json)，共 24 次请求 / 52,036 tokens）：

| 专项 / 链路指标 | 修复前（第一轮） | 修复后（第二轮） |
| --- | ---: | ---: |
| 休眠期冲突巡检 F1（32 对） | `0.7568`（P `93.3%` / R `63.6%`） | **`0.9000`**（P **`100%`** / R **`81.8%`**） |
| 休眠期冲突巡检难负样本通过率 | `9/10` | **`10/10`**（`0` 误报） |
| PRELUDE 规则外表格改写样本 | `0/6` | `1/6`（`writing:table_style` 命中；另 2 项新规则经单测验证） |
| DeepSeek Track A：`alias_person` 状态 | `partial` | **`answered`**（可答 `5/5`、拒答 `3/3`） |
| DeepSeek Track C：`polish_report` 省略百分比 | `1/4`（`25%`） | **`4/4`（`100%`）** |
| DeepSeek Track C：`polish_report` 软化风险措辞 | `3/4`（`75%`） | **`4/4`（`100%`）** |

注：Track C 中 `d4` 原稿 `48小时` 在模型输出中规范排版为 `48 小时`（严格子串校验仍计 `3/4`，语义事实 `4/4` 均保留）。

