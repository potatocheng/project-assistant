# 逐项目标与未知项校准：真实LLM完整链路对比

生成时间：2026-10-20T17:12:45.101Z。模型：`deepseek-flash`。QASPER冻结公开数据，CC BY 4.0，[来源与适配](memory-public-datasets.md)。

20题开发集：完成；预注册门槛：未通过。本报告尚无100题运行工件，不宣称完整100题提升。

本轮实际重新执行提取、记忆组织、两个生产问答入口和隔离评分。提取实现保持不变，随机输出仍可能改变；新旧差值属于完整链路联合结果。原80题已参与分析，当前是固定回归集。自动评分使用同一模型，未独立人工复核。

## 预算与实现归因

本轮继续优化未知项审查、回答目标区分、覆盖与拒答校准；生产上限保持5调用、累计180000输入字符、24参考/36000字符。所有provider QA尝试（包括补查、审查和失败）计入实际成本。开发门槛要求相对同20题上一轮262191个QA token增长不超过10%，即不超过288410。全量成本目标不超过1664381，并分别保留质量、参考充分和无答案正确拒答目标的达成情况。逐unknown诊断仅读取保存trace，不改变实际回答或评分；完整格式和producer选择规则见适配说明。

本次提供的3个不同实际运行（含已提供失败pilot、本次开发）共829次真实调用、3652548个已报告token；不含上一轮基线。完整100题未运行，未发生的全量调用不计入费用，也没有全量质量指标。

## 唯一预算扩展与全部开发尝试

原注册开发预算600请求/3000000tokens未改；观察两次失败后，2026-10-20T16:46:59.334Z登记一次扩展，开发累计上限900/4500000。质量、当前fresh20 QA<=288410和全部100题目标不变，不自动进行第二次扩展。

| 尝试 | 完整执行 | gate | 调用 | 报告tokens |
| --- | --- | --- | --- | --- |
| 1 | true | false | 282 | 1273289 |
| 2 | true | false | 266 | 1177756 |
| 3 | true | false | 281 | 1201503 |

开发累计829/900次请求、3652548/4500000tokens；原600/3M内：请求否、tokens否。全量2000/12M独立计限，最终总费用仍包含全部失败、新开发与全量工作区各一次。原始账本和addendum SHA在机器JSON，不按最新prior单独扣费。

## 单独开发集20题

6篇/20题，可答19、无答案1。完整执行：是。

| 环节 | 上一轮原始结果 | 本轮结果 |
| --- | --- | --- |
| 提取成功 | 6/6 | 6/6 |
| 正式记忆 | 944 | 926 |
| 信息保留yes / partial / no | yes: 17；no: 1；partial: 1 | yes: 17；no: 1；partial: 1 |
| 桌面参考充分 | 16/19（84.2%） | 17/19（89.5%） |
| 桌面完整正确 | 13/19（68.4%） | 13/19（68.4%） |
| 桌面无答案正确拒答 | 1/1（100.0%） | 1/1（100.0%） |
| 飞书问答参考充分 | 16/19（84.2%） | 17/19（89.5%） |
| 飞书问答完整正确 | 14/19（73.7%） | 16/19（84.2%） |
| 飞书问答无答案正确拒答 | 1/1（100.0%） | 1/1（100.0%） |

### 同次匿名配对与评分漂移

| 入口 | 上一轮原始完整正确 | 本轮重新评分旧答案 | 本轮新答案 | 配对新增 / 退化 | 无答案旧配对 / 本轮 |
| --- | --- | --- | --- | --- | --- |
| 桌面 | 13/19（68.4%） | 13/19（68.4%） | 13/19（68.4%） | 1 / 1 | 1/1（100.0%） / 1/1（100.0%） |
| 飞书问答 | 14/19（73.7%） | 15/19（78.9%） | 16/19（84.2%） | 1 / 0 | 1/1（100.0%） / 1/1（100.0%） |

原始旧评分与本次配对旧评分可能不同；两个结果均保留，不用新评分覆盖旧工件。提取重新运行，记忆正文与组织字段仍可能漂移，因此端到端差值不是检索模块的独立因果效应。

### 阶段损失与上下文组装

| 入口 | 第一处观测损失 | 参考充分时答对 | 有充分记忆时参考充分 | 错误码 | p50 / p95毫秒 |
| --- | --- | --- | --- | --- | --- |
| 桌面 | success: 13；answer_error_or_refusal: 4；memory_content_missing: 1；retrieval_context_loss: 1 | 13/17（76.5%） | 16/17（94.1%） | 无 | 3207 / 8416 |
| 飞书问答 | success: 16；answer_error_or_refusal: 1；memory_content_missing: 1；retrieval_context_loss: 1 | 16/17（94.1%） | 16/17（94.1%） | 无 | 2317 / 7127 |

待审核草稿1条；未审草稿进入正式记忆0条。正式记忆数量和逐字来源校验不能代替语义精确率；该指标仍未独立人工标注。

### 成本与恢复记录

组合QA token：262191→333357，增加27.1%；实际请求83→121。该项不含提取和评分，但所有实际阶段费用均在下表及总用量中保留。

| 入口 | 旧→新QA请求 | 旧→新QA token | 旧→新p50/p95毫秒 | 旧→新实际补查生成题数 | 旧→新可答题拒答数 | 旧→新无答案题拒答数 |
| --- | --- | --- | --- | --- | --- | --- |
| 桌面 | 41→66 | 132336→174946 | 2630/3197→3207/8416 | 1→9 | 0→1 | 1→1 |
| 飞书问答 | 42→55 | 129855→158411 | 2330/3255→2317/7127 | 2→6 | 1→1 | 1→1 |

这里“拒答数”是生产最终grounded/status观测，不等于正确拒答数；正确性在独立无答案分母中另计。“实际补查生成”须至少两次真实generation请求，不能把仅规划或空改写算作补查。

| 入口 | 旧→新规划补查题数 | 旧→新额外检索轮数 | 旧→新任一审查拒绝题数 | 旧→新补查失败码 |
| --- | --- | --- | --- | --- |
| 桌面 | 1→10 | 1→10 | 0→2 | 无→无 |
| 飞书问答 | 2→6 | 2→6 | 0→1 | 无→无 |

补查失败可被生产流程安全转换为unknown或退回已核验partial，因此不能只看顶层error或supplementStatus；下表同时读取各检索轮的review unavailable。

| 入口 | 旧→新review unavailable代码 | 旧→新协议review失败题数 | 旧→新补查协议失败题数（入口并集） |
| --- | --- | --- | --- |
| 桌面 | 无→QA_REVIEW_SCHEMA: 1 | 0→1 | 0→1 |
| 飞书问答 | 无→无 | 0→0 | 0→0 |

| 入口 | 旧→新已核验partial回退 | 旧→新相同上下文跳过 | 本轮generation选择索引 |
| --- | --- | --- | --- |
| 桌面 | 0→1 | 0→1 | 0: 12；1: 8 |
| 飞书问答 | 0→0 | 0→0 | 0: 14；1: 6 |

UNCHANGED_CONTEXT表示复验后跳过重复生成，单列为节省行为，不当成补查失败。安全partial回退仍按实际所有尝试计费，并按producer选中的真实generation参考做检索评分。某分支观测次数为0时，不能把token下降归因于该分支；本报告未做逐机制因果消融。

### 审查校准（事后审计）

| 入口 | 有效review | completeAnswer=true | 选中raw unknowns被清空 | 清空后自动答案标签 | complete审查后最终grounded答案标签 |
| --- | --- | --- | --- | --- | --- |
| 桌面 | 26 | 12 | 0 | 无 | partial: 3；yes: 9 |
| 飞书问答 | 23 | 16 | 1 | partial: 1 | yes: 14；no: 1；partial: 1 |

| 入口 | 逐目标review | 目标状态 | 逐unknown review | 全部模型unknown处置 | 选中review的模型unknown处置 | grounded且保留/移除并存 |
| --- | --- | --- | --- | --- | --- | --- |
| 桌面 | 26 | partial: 13；answered: 15；missing: 1 | 26 | retain: 16 | retain: 9 | 0 |
| 飞书问答 | 23 | answered: 17；partial: 6；missing: 1 | 23 | retain: 7；unasked: 1 | retain: 2；unasked: 1 | 0 |

| 入口 | 保守规范化 | 保留rawReview数 | effectiveStatus | raw义务全answered但仍有明确缺项 |
| --- | --- | --- | --- | --- |
| 桌面 | 无 | 0 | 无 | 0 |
| 飞书问答 | 无 | 0 | 无 | 0 |

0结构协议失败不等于0模型语义或逻辑不一致。第二次开发前的生产修复只允许将结构完整、supported/answersQuestion为true、completeAnswer为false且有明确retain/missing的粗粒度矛盾审查保守保留为partial；不得升级完整答案或删除必要未知。normalization、effectiveStatus和未改写的rawReview均保留，逐unknown处置另列。首轮pilot原有2个协议失败仍保留，不用新解析或新规范化回填。

逐unknown统计仅读取本轮保存的obligations/unknownDecisions；未含这些字段的旧schema记为未提供，不推造处理结论。disposition与claimIndices是模型审查产物，尚未人工评定；不能把unasked/answered标签视为事实正确证明。原始unknown顺序和处置索引均保留，最终unknown还可能合并missingAspects，因此不按数组长度差推断每条语义是否解决。

有效review按保存的结构字段计数，null或不完整记录不计；unknowns清空要求实际选中generation原有非空unknowns、最终grounded=true且最终unknowns显式为空。completeAnswer=true不是独立的完整性证明：审查也可能把未回答目标当作背景，或把事实暗示当作直接结论。下列自动非完整标签与unknowns处理案例仅供事后人工复核，不据此修改分数或判定人工错误；完整原始unknowns和逐例收据保存在机器JSON。

| 题号 | 入口 | 选中generation | 生成/审查收据 | unknowns清空 | 自动答案标签 | 人工评定 |
| --- | --- | --- | --- | --- | --- | --- |
| 5daeb8d4d6f3b8543ec6309a7a35523e160437eb | 桌面 | 0 | 54/55 | 否 | partial | 未做 |
| 747b847d687f703cc20a87877c5b138f26ff137d | 桌面 | 0 | 81/82 | 否 | partial | 未做 |
| 1be54c5b3ea67d837ffba2290a40c1e720d9587f | 桌面 | 0 | 18/20 | 否 | partial | 未做 |
| dd76130ec5fac477123fe8880472d03fbafddef6 | 飞书问答 | 0 | 220/221 | 是 | partial | 未做 |
| 50cc6c5f2dcf5fb87b56007f6a825fa7c90b64ed | 飞书问答 | 0 | 117/119 | 否 | no | 未做 |

| 阶段 | 上一轮请求/token | 本轮请求/token |
| --- | --- | --- |
| all | 243 / 1128989 | 281 / 1201503 |
| extraction | 100 / 434860 | 100 / 432692 |
| qa | 83 / 262191 | 121 / 333357 |
| judge | 60 / 431938 | 60 / 435454 |

| 阶段 | 请求 | 输入token | 输出token | 总token | 缺usage请求 | 累计请求毫秒 |
| --- | --- | --- | --- | --- | --- | --- |
| extraction:extraction | 100 | 287011 | 145681 | 432692 | 0 | 442003 |
| qa:generation | 55 | 212993 | 9749 | 222742 | 0 | 72617 |
| qa:answer_review | 50 | 78429 | 5176 | 83605 | 0 | 48083 |
| qa:query_rewrite | 16 | 26467 | 543 | 27010 | 0 | 11514 |
| judge:answer | 20 | 59019 | 2761 | 61780 | 0 | 24597 |
| judge:memory | 20 | 298341 | 2838 | 301179 | 0 | 26723 |
| judge:retrieval | 20 | 70714 | 1781 | 72495 | 0 | 22935 |

本轮281次真实请求，1201503个已报告token，墙钟7.0分钟。并发请求耗时不可相加当墙钟。计费金额未估算。

评分API格式重评0次、0token；当前评分错误0题。已收到评分JSON末尾单个右括号恢复1条，额外调用0，完整审计保存在机器JSON与原始收据。

完整flat answer系统外层无损规范化0条，额外调用0、额外token为0。只增加systems包装，不更改已有标签、理由或匿名映射；原始与规范JSON的SHA256及收据ID保留在机器JSON。

memory-only未判yes而retrieval-only判yes的隔离评分分歧2个入口案例。它提示评分不一致，不能据此断言“未存储的信息被检索出来”或作严格因果归因。逐例ID保存在机器JSON。

### 逐题对比

| 题号 | 入口 | 可答 | 旧原始/旧配对/本轮答案 | 旧/新正文保留 | 旧/新参考充分 | 配对变化 | 旧/新状态 | 旧/新生成次数 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 55bd59076a49b19d3283af41c5e3ccb875f3eb0c | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/partial | 1/2 |
| 55bd59076a49b19d3283af41c5e3ccb875f3eb0c | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 5daeb8d4d6f3b8543ec6309a7a35523e160437eb | 桌面 | 是 | yes/partial/partial | yes/yes | yes/yes | still_unsuccessful | answered/answered | 1/1 |
| 5daeb8d4d6f3b8543ec6309a7a35523e160437eb | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 521280a87c43fcdf9f577da235e7072a23f0673e | 桌面 | 是 | yes/yes/partial | yes/yes | yes/yes | regression | answered/partial | 1/2 |
| 521280a87c43fcdf9f577da235e7072a23f0673e | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 5a8cc8f80509ea77d8213ed28c5ead501c68c725 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 5a8cc8f80509ea77d8213ed28c5ead501c68c725 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 747b847d687f703cc20a87877c5b138f26ff137d | 桌面 | 是 | partial/partial/partial | yes/yes | yes/yes | still_unsuccessful | answered/answered | 1/1 |
| 747b847d687f703cc20a87877c5b138f26ff137d | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 111afb77cfbf4c98e0458606378fa63a0e965e36 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/2 |
| 111afb77cfbf4c98e0458606378fa63a0e965e36 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/2 |
| 50cc6c5f2dcf5fb87b56007f6a825fa7c90b64ed | 桌面 | 是 | no/no/yes | yes/yes | yes/yes | new_success | answered/partial | 1/2 |
| 50cc6c5f2dcf5fb87b56007f6a825fa7c90b64ed | 飞书问答 | 是 | no/no/no | yes/yes | yes/yes | still_unsuccessful | answered/answered | 1/1 |
| 6bf5620f295b5243230bc97b340fae6e92304595 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 6bf5620f295b5243230bc97b340fae6e92304595 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 1be54c5b3ea67d837ffba2290a40c1e720d9587f | 桌面 | 是 | partial/partial/partial | yes/yes | yes/yes | still_unsuccessful | answered/answered | 1/1 |
| 1be54c5b3ea67d837ffba2290a40c1e720d9587f | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 584af673429c7f8621c6bf83362a37048daa0e5d | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/2 |
| 584af673429c7f8621c6bf83362a37048daa0e5d | 飞书问答 | 是 | partial/partial/yes | yes/yes | yes/yes | new_success | answered/answered | 1/1 |
| c37f65c9f0d543a35c784263b79236ccf1c44fac | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| c37f65c9f0d543a35c784263b79236ccf1c44fac | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| b08f88d1facefceb87e134ba2c1fa90035018e83 | 桌面 | 是 | no/partial/no | no/no | no/no | still_unsuccessful | answered/unknown | 1/1 |
| b08f88d1facefceb87e134ba2c1fa90035018e83 | 飞书问答 | 是 | no/no/no | no/no | no/no | still_unsuccessful | unknown/unknown | 2/2 |
| 10fb7dc031075946153baf0a0599e126de29e3a4 | 桌面 | 是 | no/yes/yes | partial/partial | no/yes | retained_success | answered/partial | 1/2 |
| 10fb7dc031075946153baf0a0599e126de29e3a4 | 飞书问答 | 是 | no/yes/yes | partial/partial | no/yes | retained_success | answered/partial | 1/2 |
| c5b0ed5db65051eebd858beaf303809aa815e8e5 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| c5b0ed5db65051eebd858beaf303809aa815e8e5 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 7ab9c0b4ceca1c142ff068f85015a249b14282d0 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 7ab9c0b4ceca1c142ff068f85015a249b14282d0 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| d28d86524292506d4b24ae2d486725a6d57a3db3 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/partial | 1/2 |
| d28d86524292506d4b24ae2d486725a6d57a3db3 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/partial | 1/2 |
| 63488da6c7aff9e374561a24ba224e9ce7f65e40 | 桌面 | 否 | yes/yes/yes | no/no | no/no | retained_success | unknown/unknown | 2/2 |
| 63488da6c7aff9e374561a24ba224e9ce7f65e40 | 飞书问答 | 否 | yes/yes/yes | no/no | no/no | retained_success | unknown/unknown | 2/2 |
| c1c44fd96c3fa6e16949ae8fa453e511c6435c68 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| c1c44fd96c3fa6e16949ae8fa453e511c6435c68 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| feafcc1c4026d7f55a2c8ce7850d7e12030b5c22 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| feafcc1c4026d7f55a2c8ce7850d7e12030b5c22 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/2 |
| dd76130ec5fac477123fe8880472d03fbafddef6 | 桌面 | 是 | no/partial/partial | yes/yes | partial/partial | still_unsuccessful | answered/partial | 1/2 |
| dd76130ec5fac477123fe8880472d03fbafddef6 | 飞书问答 | 是 | no/partial/partial | yes/yes | partial/partial | still_unsuccessful | answered/answered | 1/1 |

## 结果解释与未解决问题

当前开发门槛仍未通过，失败项为no_review_protocol_failures、supplement_protocol_failures_not_worse、combined_qa_tokens_within_ten_percent_growth。参考充分率、完整正确率、协议可靠性和实际QA成本分别判断；参考充分不能证明主模型/子模型归属、未知项处理或完整回答已全部修复。因此未进入100题运行，全部100题成功目标仍未测。

已记录的剩余排查方向包括individual与joint主体混淆、未问细节保留为unknown而触发补查，以及相关研究或数据增强来源占用导航位置。这些是事后审计案例，自动标签仍需人工复核；不能据少量开发样本宣称问题已完全解决。

[案例审计](memory-qa-calibrated-case-audit.json) · [成本与协议审计](memory-qa-calibrated-cost-protocol-audit.json) · [第三版代码审计](memory-qa-calibrated-third-code-audit.json) · [首次调用前审计](memory-qa-calibrated-pre-live-audit.json) · [最终原始收据审计](memory-qa-calibrated-final-audit.json)

## 开发集人工复核待办

独立开发20题中，自动判参考充分但未完整答对的5个入口结果涉及5道题。下表仅是排查假设，尚未人工评定，不据此改分，也不用于修改当前冻结代码或完整100题运行。

| 题号 | 入口 | 生产收据ID | 待核验假设 | 人工评定 |
| --- | --- | --- | --- | --- |
| 5daeb8d4d6f3b8543ec6309a7a35523e160437eb | 桌面 | 54, 55 | 参考被自动判充分而最终答案未完整正确，需人工核查目标理解、完整性与评分口径。 | 未做 |
| 521280a87c43fcdf9f577da235e7072a23f0673e | 桌面 | 60, 61, 62, 63, 65 | 参考被自动判充分而最终答案未完整正确，需人工核查目标理解、完整性与评分口径。 | 未做 |
| 747b847d687f703cc20a87877c5b138f26ff137d | 桌面 | 81, 82 | 参考被自动判充分而最终答案未完整正确，需人工核查目标理解、完整性与评分口径。 | 未做 |
| 50cc6c5f2dcf5fb87b56007f6a825fa7c90b64ed | 飞书问答 | 117, 119 | 参考被自动判充分而最终答案未完整正确，需人工核查目标理解、完整性与评分口径。 | 未做 |
| 1be54c5b3ea67d837ffba2290a40c1e720d9587f | 桌面 | 18, 20 | 参考被自动判充分而最终答案未完整正确，需人工核查目标理解、完整性与评分口径。 | 未做 |

## 已保留的首轮开发试运行与未通过门槛

首轮pilot完整执行标志true，282次真实调用、1273289个已报告token；门槛未通过。该轮提取、问答和评分均完整执行，但未达到预注册开发条件；不能把complete=true当成质量通过。原始分数、收据和所有额外费用均保留。

| 首轮未通过检查 | 实际 | 冻结要求 |
| --- | --- | --- |
| no_review_protocol_failures | 2 | "0 entries with unavailable protocol/schema/JSON review in any retrieval round, including safe fallbacks" |
| supplement_protocol_failures_not_worse | 1 | "0 supplemental binding/schema/protocol failures; safe fallbacks still counted" |
| combined_qa_tokens_within_ten_percent_growth | {"previousTokens":262191,"currentTokens":401601,"reductionFraction":-0.5317116148151539} | "<=288410 QA tokens, <=10% above the same previous 20-question development baseline" |

3次开发合计829/900次请求、3652548/4500000个报告token，共享已登记的累计开发预算；完整100题另按原注册上限执行。

任何失败pilot均作为独立工件保留，不回填旧分数或降低门槛；新运行按相同冻结评分标准重新完成20题。格式捕获和实际返回generation归属见[适配说明](memory-qa-calibrated-format-adaptation.md)，所有已发生调用计入本轮成本。

## 首轮失败pilot（原始结果）

6篇/20题，可答19、无答案1。完整执行：是。

| 环节 | 上一轮原始结果 | 本轮结果 |
| --- | --- | --- |
| 提取成功 | 6/6 | 6/6 |
| 正式记忆 | 944 | 930 |
| 信息保留yes / partial / no | yes: 17；no: 1；partial: 1 | yes: 17；no: 1；partial: 1 |
| 桌面参考充分 | 16/19（84.2%） | 17/19（89.5%） |
| 桌面完整正确 | 13/19（68.4%） | 15/19（78.9%） |
| 桌面无答案正确拒答 | 1/1（100.0%） | 1/1（100.0%） |
| 飞书问答参考充分 | 16/19（84.2%） | 17/19（89.5%） |
| 飞书问答完整正确 | 14/19（73.7%） | 15/19（78.9%） |
| 飞书问答无答案正确拒答 | 1/1（100.0%） | 1/1（100.0%） |

### 同次匿名配对与评分漂移

| 入口 | 上一轮原始完整正确 | 本轮重新评分旧答案 | 本轮新答案 | 配对新增 / 退化 | 无答案旧配对 / 本轮 |
| --- | --- | --- | --- | --- | --- |
| 桌面 | 13/19（68.4%） | 14/19（73.7%） | 15/19（78.9%） | 2 / 1 | 1/1（100.0%） / 1/1（100.0%） |
| 飞书问答 | 14/19（73.7%） | 13/19（68.4%） | 15/19（78.9%） | 4 / 2 | 1/1（100.0%） / 1/1（100.0%） |

原始旧评分与本次配对旧评分可能不同；两个结果均保留，不用新评分覆盖旧工件。提取重新运行，记忆正文与组织字段仍可能漂移，因此端到端差值不是检索模块的独立因果效应。

### 阶段损失与上下文组装

| 入口 | 第一处观测损失 | 参考充分时答对 | 有充分记忆时参考充分 | 错误码 | p50 / p95毫秒 |
| --- | --- | --- | --- | --- | --- |
| 桌面 | success: 15；answer_error_or_refusal: 2；memory_content_missing: 1；retrieval_context_loss: 1 | 15/17（88.2%） | 16/17（94.1%） | 无 | 3406 / 8867 |
| 飞书问答 | success: 15；answer_error_or_refusal: 2；memory_content_missing: 1；retrieval_context_loss: 1 | 15/17（88.2%） | 16/17（94.1%） | 无 | 2369 / 7765 |

待审核草稿2条；未审草稿进入正式记忆0条。正式记忆数量和逐字来源校验不能代替语义精确率；该指标仍未独立人工标注。

### 成本与恢复记录

组合QA token：262191→401601，增加53.2%；实际请求83→122。该项不含提取和评分，但所有实际阶段费用均在下表及总用量中保留。

| 入口 | 旧→新QA请求 | 旧→新QA token | 旧→新p50/p95毫秒 | 旧→新实际补查生成题数 | 旧→新可答题拒答数 | 旧→新无答案题拒答数 |
| --- | --- | --- | --- | --- | --- | --- |
| 桌面 | 41→68 | 132336→225309 | 2630/3197→3406/8867 | 1→10 | 0→1 | 1→1 |
| 飞书问答 | 42→54 | 129855→176292 | 2330/3255→2369/7765 | 2→6 | 1→2 | 1→1 |

这里“拒答数”是生产最终grounded/status观测，不等于正确拒答数；正确性在独立无答案分母中另计。“实际补查生成”须至少两次真实generation请求，不能把仅规划或空改写算作补查。

| 入口 | 旧→新规划补查题数 | 旧→新额外检索轮数 | 旧→新任一审查拒绝题数 | 旧→新补查失败码 |
| --- | --- | --- | --- | --- |
| 桌面 | 1→10 | 1→10 | 0→1 | 无→无 |
| 飞书问答 | 2→6 | 2→6 | 0→2 | 无→无 |

补查失败可被生产流程安全转换为unknown或退回已核验partial，因此不能只看顶层error或supplementStatus；下表同时读取各检索轮的review unavailable。

| 入口 | 旧→新review unavailable代码 | 旧→新协议review失败题数 | 旧→新补查协议失败题数（入口并集） |
| --- | --- | --- | --- |
| 桌面 | 无→无 | 0→0 | 0→0 |
| 飞书问答 | 无→QA_REVIEW_SCHEMA: 2 | 0→2 | 0→1 |

| 入口 | 旧→新已核验partial回退 | 旧→新相同上下文跳过 | 本轮generation选择索引 |
| --- | --- | --- | --- |
| 桌面 | 0→0 | 0→0 | 0: 10；1: 10 |
| 飞书问答 | 0→1 | 0→0 | 0: 15；1: 5 |

UNCHANGED_CONTEXT表示复验后跳过重复生成，单列为节省行为，不当成补查失败。安全partial回退仍按实际所有尝试计费，并按producer选中的真实generation参考做检索评分。某分支观测次数为0时，不能把token下降归因于该分支；本报告未做逐机制因果消融。

### 审查校准（事后审计）

| 入口 | 有效review | completeAnswer=true | 选中raw unknowns被清空 | 清空后自动答案标签 | complete审查后最终grounded答案标签 |
| --- | --- | --- | --- | --- | --- |
| 桌面 | 28 | 15 | 1 | yes: 1 | partial: 2；yes: 13 |
| 飞书问答 | 20 | 14 | 1 | partial: 1 | partial: 2；yes: 12 |

| 入口 | 逐目标review | 目标状态 | 逐unknown review | 全部模型unknown处置 | 选中review的模型unknown处置 | grounded且保留/移除并存 |
| --- | --- | --- | --- | --- | --- | --- |
| 桌面 | 28 | partial: 10；answered: 34；missing: 3 | 28 | retain: 12；unasked: 1 | unasked: 1；retain: 4 | 0 |
| 飞书问答 | 20 | answered: 31；partial: 3；missing: 4 | 20 | retain: 7；unasked: 1 | retain: 4；unasked: 1 | 0 |

| 入口 | 保守规范化 | 保留rawReview数 | effectiveStatus | raw义务全answered但仍有明确缺项 |
| --- | --- | --- | --- | --- |
| 桌面 | 无 | 0 | 无 | 0 |
| 飞书问答 | 无 | 0 | 无 | 0 |

0结构协议失败不等于0模型语义或逻辑不一致。第二次开发前的生产修复只允许将结构完整、supported/answersQuestion为true、completeAnswer为false且有明确retain/missing的粗粒度矛盾审查保守保留为partial；不得升级完整答案或删除必要未知。normalization、effectiveStatus和未改写的rawReview均保留，逐unknown处置另列。首轮pilot原有2个协议失败仍保留，不用新解析或新规范化回填。

逐unknown统计仅读取本轮保存的obligations/unknownDecisions；未含这些字段的旧schema记为未提供，不推造处理结论。disposition与claimIndices是模型审查产物，尚未人工评定；不能把unasked/answered标签视为事实正确证明。原始unknown顺序和处置索引均保留，最终unknown还可能合并missingAspects，因此不按数组长度差推断每条语义是否解决。

有效review按保存的结构字段计数，null或不完整记录不计；unknowns清空要求实际选中generation原有非空unknowns、最终grounded=true且最终unknowns显式为空。completeAnswer=true不是独立的完整性证明：审查也可能把未回答目标当作背景，或把事实暗示当作直接结论。下列自动非完整标签与unknowns处理案例仅供事后人工复核，不据此修改分数或判定人工错误；完整原始unknowns和逐例收据保存在机器JSON。

| 题号 | 入口 | 选中generation | 生成/审查收据 | unknowns清空 | 自动答案标签 | 人工评定 |
| --- | --- | --- | --- | --- | --- | --- |
| 50cc6c5f2dcf5fb87b56007f6a825fa7c90b64ed | 桌面 | 1 | 109/111 | 是 | yes | 未做 |
| 747b847d687f703cc20a87877c5b138f26ff137d | 桌面 | 1 | 84/86 | 否 | partial | 未做 |
| dd76130ec5fac477123fe8880472d03fbafddef6 | 桌面 | 1 | 219/220 | 否 | partial | 未做 |
| dd76130ec5fac477123fe8880472d03fbafddef6 | 飞书问答 | 0 | 221/222 | 是 | partial | 未做 |
| 747b847d687f703cc20a87877c5b138f26ff137d | 飞书问答 | 0 | 88/89 | 否 | partial | 未做 |

| 阶段 | 上一轮请求/token | 本轮请求/token |
| --- | --- | --- |
| all | 243 / 1128989 | 282 / 1273289 |
| extraction | 100 / 434860 | 100 / 434425 |
| qa | 83 / 262191 | 122 / 401601 |
| judge | 60 / 431938 | 60 / 437263 |

| 阶段 | 请求 | 输入token | 输出token | 总token | 缺usage请求 | 累计请求毫秒 |
| --- | --- | --- | --- | --- | --- | --- |
| extraction:extraction | 100 | 287041 | 147384 | 434425 | 0 | 440004 |
| qa:generation | 56 | 275163 | 9915 | 285078 | 0 | 71910 |
| qa:answer_review | 50 | 82317 | 7361 | 89678 | 0 | 60901 |
| qa:query_rewrite | 16 | 26311 | 534 | 26845 | 0 | 13192 |
| judge:answer | 20 | 59849 | 2704 | 62553 | 0 | 22474 |
| judge:memory | 20 | 300655 | 2947 | 303602 | 0 | 27737 |
| judge:retrieval | 20 | 69329 | 1779 | 71108 | 0 | 20372 |

本轮282次真实请求，1273289个已报告token，墙钟7.3分钟。并发请求耗时不可相加当墙钟。计费金额未估算。

评分API格式重评0次、0token；当前评分错误0题。已收到评分JSON末尾单个右括号恢复1条，额外调用0，完整审计保存在机器JSON与原始收据。

完整flat answer系统外层无损规范化0条，额外调用0、额外token为0。只增加systems包装，不更改已有标签、理由或匿名映射；原始与规范JSON的SHA256及收据ID保留在机器JSON。

memory-only未判yes而retrieval-only判yes的隔离评分分歧2个入口案例。它提示评分不一致，不能据此断言“未存储的信息被检索出来”或作严格因果归因。逐例ID保存在机器JSON。

### 逐题对比

| 题号 | 入口 | 可答 | 旧原始/旧配对/本轮答案 | 旧/新正文保留 | 旧/新参考充分 | 配对变化 | 旧/新状态 | 旧/新生成次数 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 747b847d687f703cc20a87877c5b138f26ff137d | 桌面 | 是 | partial/partial/partial | yes/yes | yes/yes | still_unsuccessful | answered/answered | 1/2 |
| 747b847d687f703cc20a87877c5b138f26ff137d | 飞书问答 | 是 | yes/yes/partial | yes/yes | yes/yes | regression | answered/answered | 1/1 |
| 111afb77cfbf4c98e0458606378fa63a0e965e36 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/2 |
| 111afb77cfbf4c98e0458606378fa63a0e965e36 | 飞书问答 | 是 | yes/yes/no | yes/yes | yes/yes | regression | answered/unknown | 1/1 |
| 50cc6c5f2dcf5fb87b56007f6a825fa7c90b64ed | 桌面 | 是 | no/partial/yes | yes/yes | yes/yes | new_success | answered/answered | 1/2 |
| 50cc6c5f2dcf5fb87b56007f6a825fa7c90b64ed | 飞书问答 | 是 | no/partial/yes | yes/yes | yes/yes | new_success | answered/answered | 1/1 |
| 6bf5620f295b5243230bc97b340fae6e92304595 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 6bf5620f295b5243230bc97b340fae6e92304595 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 55bd59076a49b19d3283af41c5e3ccb875f3eb0c | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 55bd59076a49b19d3283af41c5e3ccb875f3eb0c | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 5daeb8d4d6f3b8543ec6309a7a35523e160437eb | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 5daeb8d4d6f3b8543ec6309a7a35523e160437eb | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 521280a87c43fcdf9f577da235e7072a23f0673e | 桌面 | 是 | yes/yes/partial | yes/yes | yes/yes | regression | answered/partial | 1/2 |
| 521280a87c43fcdf9f577da235e7072a23f0673e | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 5a8cc8f80509ea77d8213ed28c5ead501c68c725 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 5a8cc8f80509ea77d8213ed28c5ead501c68c725 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 1be54c5b3ea67d837ffba2290a40c1e720d9587f | 桌面 | 是 | partial/partial/yes | yes/yes | yes/yes | new_success | answered/answered | 1/1 |
| 1be54c5b3ea67d837ffba2290a40c1e720d9587f | 飞书问答 | 是 | yes/no/yes | yes/yes | yes/yes | new_success | answered/answered | 1/1 |
| 584af673429c7f8621c6bf83362a37048daa0e5d | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/2 |
| 584af673429c7f8621c6bf83362a37048daa0e5d | 飞书问答 | 是 | partial/partial/yes | yes/yes | yes/yes | new_success | answered/answered | 1/2 |
| c37f65c9f0d543a35c784263b79236ccf1c44fac | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| c37f65c9f0d543a35c784263b79236ccf1c44fac | 飞书问答 | 是 | yes/partial/yes | yes/yes | yes/yes | new_success | answered/answered | 1/1 |
| b08f88d1facefceb87e134ba2c1fa90035018e83 | 桌面 | 是 | no/no/no | no/no | no/no | still_unsuccessful | answered/unknown | 1/2 |
| b08f88d1facefceb87e134ba2c1fa90035018e83 | 飞书问答 | 是 | no/no/no | no/no | no/no | still_unsuccessful | unknown/unknown | 2/2 |
| 10fb7dc031075946153baf0a0599e126de29e3a4 | 桌面 | 是 | no/yes/yes | partial/partial | no/yes | retained_success | answered/partial | 1/2 |
| 10fb7dc031075946153baf0a0599e126de29e3a4 | 飞书问答 | 是 | no/yes/yes | partial/partial | no/yes | retained_success | answered/partial | 1/2 |
| c5b0ed5db65051eebd858beaf303809aa815e8e5 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| c5b0ed5db65051eebd858beaf303809aa815e8e5 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 7ab9c0b4ceca1c142ff068f85015a249b14282d0 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 7ab9c0b4ceca1c142ff068f85015a249b14282d0 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| d28d86524292506d4b24ae2d486725a6d57a3db3 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/partial | 1/2 |
| d28d86524292506d4b24ae2d486725a6d57a3db3 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/partial | 1/2 |
| 63488da6c7aff9e374561a24ba224e9ce7f65e40 | 桌面 | 否 | yes/yes/yes | no/no | no/no | retained_success | unknown/unknown | 2/2 |
| 63488da6c7aff9e374561a24ba224e9ce7f65e40 | 飞书问答 | 否 | yes/yes/yes | no/no | no/no | retained_success | unknown/unknown | 2/2 |
| c1c44fd96c3fa6e16949ae8fa453e511c6435c68 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| c1c44fd96c3fa6e16949ae8fa453e511c6435c68 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| feafcc1c4026d7f55a2c8ce7850d7e12030b5c22 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| feafcc1c4026d7f55a2c8ce7850d7e12030b5c22 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/partial | 1/2 |
| dd76130ec5fac477123fe8880472d03fbafddef6 | 桌面 | 是 | no/partial/partial | yes/yes | partial/partial | still_unsuccessful | answered/answered | 1/2 |
| dd76130ec5fac477123fe8880472d03fbafddef6 | 飞书问答 | 是 | no/partial/partial | yes/yes | partial/partial | still_unsuccessful | answered/answered | 1/1 |

## 第2轮失败开发试运行（原始结果）

| 未通过检查 | 实际 | 要求 |
| --- | --- | --- |
| connector_complete_answer_floor | 13 | ">=14/19; previous original 14/19" |
| connector_paired_correctness_guard | {"current":13,"previousPaired":14,"net":-1} | "net>=0" |
| combined_paired_improvement | -1 | ">=1 net additional correct entry-answers vs same-call paired baseline" |
| no_review_protocol_failures | 2 | "0 entries with unavailable protocol/schema/JSON review in any retrieval round, including safe fallbacks" |
| supplement_protocol_failures_not_worse | 1 | "0 supplemental binding/schema/protocol failures; safe fallbacks still counted" |
| combined_qa_tokens_within_ten_percent_growth | {"previousTokens":262191,"currentTokens":305081,"reductionFraction":-0.16358303679378783} | "<=288410 QA tokens, <=10% above the same previous 20-question development baseline" |

该轮原始结果与失败gate保持不变，不用后来生产修复、规范化或评分规则回填；费用已纳入累计账本。

## 失败开发2：逐题与成本

6篇/20题，可答19、无答案1。完整执行：是。

| 环节 | 上一轮原始结果 | 本轮结果 |
| --- | --- | --- |
| 提取成功 | 6/6 | 6/6 |
| 正式记忆 | 944 | 934 |
| 信息保留yes / partial / no | yes: 17；no: 1；partial: 1 | yes: 17；no: 1；partial: 1 |
| 桌面参考充分 | 16/19（84.2%） | 16/19（84.2%） |
| 桌面完整正确 | 13/19（68.4%） | 14/19（73.7%） |
| 桌面无答案正确拒答 | 1/1（100.0%） | 1/1（100.0%） |
| 飞书问答参考充分 | 16/19（84.2%） | 16/19（84.2%） |
| 飞书问答完整正确 | 14/19（73.7%） | 13/19（68.4%） |
| 飞书问答无答案正确拒答 | 1/1（100.0%） | 1/1（100.0%） |

### 同次匿名配对与评分漂移

| 入口 | 上一轮原始完整正确 | 本轮重新评分旧答案 | 本轮新答案 | 配对新增 / 退化 | 无答案旧配对 / 本轮 |
| --- | --- | --- | --- | --- | --- |
| 桌面 | 13/19（68.4%） | 14/19（73.7%） | 14/19（73.7%） | 0 / 0 | 1/1（100.0%） / 1/1（100.0%） |
| 飞书问答 | 14/19（73.7%） | 14/19（73.7%） | 13/19（68.4%） | 1 / 2 | 1/1（100.0%） / 1/1（100.0%） |

原始旧评分与本次配对旧评分可能不同；两个结果均保留，不用新评分覆盖旧工件。提取重新运行，记忆正文与组织字段仍可能漂移，因此端到端差值不是检索模块的独立因果效应。

### 阶段损失与上下文组装

| 入口 | 第一处观测损失 | 参考充分时答对 | 有充分记忆时参考充分 | 错误码 | p50 / p95毫秒 |
| --- | --- | --- | --- | --- | --- |
| 桌面 | success: 14；answer_error_or_refusal: 3；memory_content_missing: 1；retrieval_context_loss: 1 | 13/16（81.3%） | 16/17（94.1%） | 无 | 2813 / 7869 |
| 飞书问答 | success: 13；answer_error_or_refusal: 4；memory_content_missing: 1；retrieval_context_loss: 1 | 12/16（75.0%） | 16/17（94.1%） | 无 | 2408 / 5664 |

待审核草稿3条；未审草稿进入正式记忆0条。正式记忆数量和逐字来源校验不能代替语义精确率；该指标仍未独立人工标注。

### 成本与恢复记录

组合QA token：262191→305081，增加16.4%；实际请求83→106。该项不含提取和评分，但所有实际阶段费用均在下表及总用量中保留。

| 入口 | 旧→新QA请求 | 旧→新QA token | 旧→新p50/p95毫秒 | 旧→新实际补查生成题数 | 旧→新可答题拒答数 | 旧→新无答案题拒答数 |
| --- | --- | --- | --- | --- | --- | --- |
| 桌面 | 41→58 | 132336→161929 | 2630/3197→2813/7869 | 1→7 | 0→1 | 1→1 |
| 飞书问答 | 42→48 | 129855→143152 | 2330/3255→2408/5664 | 2→3 | 1→2 | 1→1 |

这里“拒答数”是生产最终grounded/status观测，不等于正确拒答数；正确性在独立无答案分母中另计。“实际补查生成”须至少两次真实generation请求，不能把仅规划或空改写算作补查。

| 入口 | 旧→新规划补查题数 | 旧→新额外检索轮数 | 旧→新任一审查拒绝题数 | 旧→新补查失败码 |
| --- | --- | --- | --- | --- |
| 桌面 | 1→7 | 1→7 | 0→2 | 无→无 |
| 飞书问答 | 2→4 | 2→4 | 0→2 | 无→无 |

补查失败可被生产流程安全转换为unknown或退回已核验partial，因此不能只看顶层error或supplementStatus；下表同时读取各检索轮的review unavailable。

| 入口 | 旧→新review unavailable代码 | 旧→新协议review失败题数 | 旧→新补查协议失败题数（入口并集） |
| --- | --- | --- | --- |
| 桌面 | 无→QA_REVIEW_SCHEMA: 1 | 0→1 | 0→1 |
| 飞书问答 | 无→QA_REVIEW_SCHEMA: 1 | 0→1 | 0→0 |

| 入口 | 旧→新已核验partial回退 | 旧→新相同上下文跳过 | 本轮generation选择索引 |
| --- | --- | --- | --- |
| 桌面 | 0→1 | 0→0 | 0: 14；1: 6 |
| 飞书问答 | 0→0 | 0→1 | 0: 17；1: 3 |

UNCHANGED_CONTEXT表示复验后跳过重复生成，单列为节省行为，不当成补查失败。安全partial回退仍按实际所有尝试计费，并按producer选中的真实generation参考做检索评分。某分支观测次数为0时，不能把token下降归因于该分支；本报告未做逐机制因果消融。

### 审查校准（事后审计）

| 入口 | 有效review | completeAnswer=true | 选中raw unknowns被清空 | 清空后自动答案标签 | complete审查后最终grounded答案标签 |
| --- | --- | --- | --- | --- | --- |
| 桌面 | 23 | 14 | 2 | yes: 1；partial: 1 | yes: 11；partial: 2；no: 1 |
| 飞书问答 | 20 | 16 | 1 | partial: 1 | yes: 12；partial: 4 |

| 入口 | 逐目标review | 目标状态 | 逐unknown review | 全部模型unknown处置 | 选中review的模型unknown处置 | grounded且保留/移除并存 |
| --- | --- | --- | --- | --- | --- | --- |
| 桌面 | 23 | answered: 16；partial: 7；missing: 1 | 23 | retain: 10；unasked: 3 | retain: 6；unasked: 2 | 0 |
| 飞书问答 | 20 | answered: 17；missing: 1；partial: 2 | 20 | retain: 4；unasked: 1 | retain: 2；unasked: 1 | 0 |

| 入口 | 保守规范化 | 保留rawReview数 | effectiveStatus | raw义务全answered但仍有明确缺项 |
| --- | --- | --- | --- | --- |
| 桌面 | coarse-answered-with-explicit-gaps: 1 | 1 | partial: 1 | 1 |
| 飞书问答 | coarse-answered-with-explicit-gaps: 1 | 1 | partial: 1 | 1 |

0结构协议失败不等于0模型语义或逻辑不一致。第二次开发前的生产修复只允许将结构完整、supported/answersQuestion为true、completeAnswer为false且有明确retain/missing的粗粒度矛盾审查保守保留为partial；不得升级完整答案或删除必要未知。normalization、effectiveStatus和未改写的rawReview均保留，逐unknown处置另列。首轮pilot原有2个协议失败仍保留，不用新解析或新规范化回填。

逐unknown统计仅读取本轮保存的obligations/unknownDecisions；未含这些字段的旧schema记为未提供，不推造处理结论。disposition与claimIndices是模型审查产物，尚未人工评定；不能把unasked/answered标签视为事实正确证明。原始unknown顺序和处置索引均保留，最终unknown还可能合并missingAspects，因此不按数组长度差推断每条语义是否解决。

有效review按保存的结构字段计数，null或不完整记录不计；unknowns清空要求实际选中generation原有非空unknowns、最终grounded=true且最终unknowns显式为空。completeAnswer=true不是独立的完整性证明：审查也可能把未回答目标当作背景，或把事实暗示当作直接结论。下列自动非完整标签与unknowns处理案例仅供事后人工复核，不据此修改分数或判定人工错误；完整原始unknowns和逐例收据保存在机器JSON。

| 题号 | 入口 | 选中generation | 生成/审查收据 | unknowns清空 | 自动答案标签 | 人工评定 |
| --- | --- | --- | --- | --- | --- | --- |
| 584af673429c7f8621c6bf83362a37048daa0e5d | 桌面 | 0 | 25/26 | 是 | yes | 未做 |
| dd76130ec5fac477123fe8880472d03fbafddef6 | 桌面 | 0 | 203/204 | 是 | partial | 未做 |
| 747b847d687f703cc20a87877c5b138f26ff137d | 桌面 | 0 | 72/73 | 否 | partial | 未做 |
| 1be54c5b3ea67d837ffba2290a40c1e720d9587f | 桌面 | 0 | 19/20 | 否 | no | 未做 |
| dd76130ec5fac477123fe8880472d03fbafddef6 | 飞书问答 | 0 | 205/206 | 是 | partial | 未做 |
| 747b847d687f703cc20a87877c5b138f26ff137d | 飞书问答 | 0 | 75/76 | 否 | partial | 未做 |
| 50cc6c5f2dcf5fb87b56007f6a825fa7c90b64ed | 飞书问答 | 0 | 100/102 | 否 | partial | 未做 |
| c37f65c9f0d543a35c784263b79236ccf1c44fac | 飞书问答 | 0 | 33/34 | 否 | partial | 未做 |

| 阶段 | 上一轮请求/token | 本轮请求/token |
| --- | --- | --- |
| all | 243 / 1128989 | 266 / 1177756 |
| extraction | 100 / 434860 | 100 / 435162 |
| qa | 83 / 262191 | 106 / 305081 |
| judge | 60 / 431938 | 60 / 437513 |

| 阶段 | 请求 | 输入token | 输出token | 总token | 缺usage请求 | 累计请求毫秒 |
| --- | --- | --- | --- | --- | --- | --- |
| extraction:extraction | 100 | 287227 | 147935 | 435162 | 0 | 451484 |
| qa:generation | 50 | 208057 | 8108 | 216165 | 0 | 62715 |
| qa:answer_review | 45 | 65883 | 4570 | 70453 | 0 | 48699 |
| qa:query_rewrite | 11 | 18104 | 359 | 18463 | 0 | 9352 |
| judge:answer | 20 | 57465 | 2741 | 60206 | 0 | 22674 |
| judge:memory | 20 | 303559 | 2929 | 306488 | 0 | 27453 |
| judge:retrieval | 20 | 69045 | 1774 | 70819 | 0 | 21640 |

本轮266次真实请求，1177756个已报告token，墙钟6.7分钟。并发请求耗时不可相加当墙钟。计费金额未估算。

评分API格式重评0次、0token；当前评分错误0题。已收到评分JSON末尾单个右括号恢复0条，额外调用0，完整审计保存在机器JSON与原始收据。

完整flat answer系统外层无损规范化1条，额外调用0、额外token为0。只增加systems包装，不更改已有标签、理由或匿名映射；原始与规范JSON的SHA256及收据ID保留在机器JSON。

memory-only未判yes而retrieval-only判yes的隔离评分分歧0个入口案例。本次未发现这类隔离评分分歧。

### 逐题对比

| 题号 | 入口 | 可答 | 旧原始/旧配对/本轮答案 | 旧/新正文保留 | 旧/新参考充分 | 配对变化 | 旧/新状态 | 旧/新生成次数 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 55bd59076a49b19d3283af41c5e3ccb875f3eb0c | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 55bd59076a49b19d3283af41c5e3ccb875f3eb0c | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 5daeb8d4d6f3b8543ec6309a7a35523e160437eb | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 5daeb8d4d6f3b8543ec6309a7a35523e160437eb | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 521280a87c43fcdf9f577da235e7072a23f0673e | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/partial | 1/2 |
| 521280a87c43fcdf9f577da235e7072a23f0673e | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 5a8cc8f80509ea77d8213ed28c5ead501c68c725 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 5a8cc8f80509ea77d8213ed28c5ead501c68c725 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 747b847d687f703cc20a87877c5b138f26ff137d | 桌面 | 是 | partial/partial/partial | yes/yes | yes/yes | still_unsuccessful | answered/answered | 1/1 |
| 747b847d687f703cc20a87877c5b138f26ff137d | 飞书问答 | 是 | yes/yes/partial | yes/yes | yes/yes | regression | answered/answered | 1/1 |
| 111afb77cfbf4c98e0458606378fa63a0e965e36 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/2 |
| 111afb77cfbf4c98e0458606378fa63a0e965e36 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 50cc6c5f2dcf5fb87b56007f6a825fa7c90b64ed | 桌面 | 是 | no/no/partial | yes/yes | yes/yes | still_unsuccessful | answered/partial | 1/2 |
| 50cc6c5f2dcf5fb87b56007f6a825fa7c90b64ed | 飞书问答 | 是 | no/no/partial | yes/yes | yes/yes | still_unsuccessful | answered/answered | 1/1 |
| 6bf5620f295b5243230bc97b340fae6e92304595 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 6bf5620f295b5243230bc97b340fae6e92304595 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 1be54c5b3ea67d837ffba2290a40c1e720d9587f | 桌面 | 是 | partial/no/no | yes/yes | yes/yes | still_unsuccessful | answered/answered | 1/1 |
| 1be54c5b3ea67d837ffba2290a40c1e720d9587f | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 584af673429c7f8621c6bf83362a37048daa0e5d | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 584af673429c7f8621c6bf83362a37048daa0e5d | 飞书问答 | 是 | partial/partial/yes | yes/yes | yes/yes | new_success | answered/answered | 1/1 |
| c37f65c9f0d543a35c784263b79236ccf1c44fac | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| c37f65c9f0d543a35c784263b79236ccf1c44fac | 飞书问答 | 是 | yes/partial/partial | yes/yes | yes/yes | still_unsuccessful | answered/answered | 1/1 |
| b08f88d1facefceb87e134ba2c1fa90035018e83 | 桌面 | 是 | no/partial/no | no/no | no/no | still_unsuccessful | answered/unknown | 1/2 |
| b08f88d1facefceb87e134ba2c1fa90035018e83 | 飞书问答 | 是 | no/no/no | no/no | no/no | still_unsuccessful | unknown/unknown | 2/1 |
| 10fb7dc031075946153baf0a0599e126de29e3a4 | 桌面 | 是 | no/yes/yes | partial/partial | no/partial | retained_success | answered/partial | 1/2 |
| 10fb7dc031075946153baf0a0599e126de29e3a4 | 飞书问答 | 是 | no/yes/yes | partial/partial | no/partial | retained_success | answered/partial | 1/2 |
| c5b0ed5db65051eebd858beaf303809aa815e8e5 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| c5b0ed5db65051eebd858beaf303809aa815e8e5 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 7ab9c0b4ceca1c142ff068f85015a249b14282d0 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 7ab9c0b4ceca1c142ff068f85015a249b14282d0 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| d28d86524292506d4b24ae2d486725a6d57a3db3 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/partial | 1/2 |
| d28d86524292506d4b24ae2d486725a6d57a3db3 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/2 |
| 63488da6c7aff9e374561a24ba224e9ce7f65e40 | 桌面 | 否 | yes/yes/yes | no/no | no/no | retained_success | unknown/unknown | 2/2 |
| 63488da6c7aff9e374561a24ba224e9ce7f65e40 | 飞书问答 | 否 | yes/yes/yes | no/no | no/no | retained_success | unknown/unknown | 2/2 |
| c1c44fd96c3fa6e16949ae8fa453e511c6435c68 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| c1c44fd96c3fa6e16949ae8fa453e511c6435c68 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| feafcc1c4026d7f55a2c8ce7850d7e12030b5c22 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| feafcc1c4026d7f55a2c8ce7850d7e12030b5c22 | 飞书问答 | 是 | yes/yes/no | yes/yes | yes/yes | regression | answered/unknown | 1/1 |
| dd76130ec5fac477123fe8880472d03fbafddef6 | 桌面 | 是 | no/partial/partial | yes/yes | partial/partial | still_unsuccessful | answered/answered | 1/1 |
| dd76130ec5fac477123fe8880472d03fbafddef6 | 飞书问答 | 是 | no/partial/partial | yes/yes | partial/partial | still_unsuccessful | answered/answered | 1/1 |

## 确定性检查与门槛

确定性检查通过，11条命令。评分规则指纹和源码/二进制指纹保存在机器JSON。

| 命令 | 退出码 | 日志 |
| --- | --- | --- |
| cargo.exe test -p project-assistant-core --locked | 0 | .local-data\qa-calibrated-regressions-x3tJvJ\1.log |
| cargo.exe clippy -p project-assistant-core --locked --lib --tests -- -D warnings | 0 | .local-data\qa-calibrated-regressions-x3tJvJ\2.log |
| cargo.exe build -p project-assistant-core --bin pm-host --locked | 0 | .local-data\qa-calibrated-regressions-x3tJvJ\3.log |
| powershell.exe -NoProfile -Command npm run build | 0 | .local-data\qa-calibrated-regressions-x3tJvJ\4.log |
| node.exe --test scripts/check-memory-public-development.test.mjs scripts/check-memory-qa-calibrated-development.test.mjs scripts/check-memory-qa-efficient-development.test.mjs scripts/check-memory-retrieval-development.test.mjs scripts/evaluate-memory-quality.test.mjs scripts/memory-public-live-budget.test.mjs scripts/memory-public-live-options.test.mjs scripts/memory-qa-calibrated-evaluation.test.mjs scripts/memory-qa-efficient-evaluation.test.mjs scripts/report-memory-extraction-optimized.test.mjs scripts/report-memory-qa-calibrated.test.mjs scripts/report-memory-qa-efficient.test.mjs scripts/report-memory-retrieval-optimized.test.mjs scripts/score-memory-public-live.test.mjs | 0 | .local-data\qa-calibrated-regressions-x3tJvJ\5.log |
| node.exe scripts/verify-restart.mjs | 0 | .local-data\qa-calibrated-regressions-x3tJvJ\6.log |
| node.exe scripts/verify-extraction-recovery.mjs | 0 | .local-data\qa-calibrated-regressions-x3tJvJ\7.log |
| node.exe scripts/verify-memory-public-live.mjs --no-write | 0 | .local-data\qa-calibrated-regressions-x3tJvJ\8.log |
| node.exe scripts/verify-memory-public-live.mjs docs/memory-public-live-qa-efficient-dev-v2-results.json docs/memory-public-live-qa-calibrated-dev-results.json docs/memory-public-live-qa-calibrated-dev-v2-results.json --no-write | 0 | .local-data\qa-calibrated-regressions-x3tJvJ\9.log |
| node.exe scripts/verify-memory-public-live.mjs docs/memory-public-live-qa-efficient-full-results.json --no-write | 0 | .local-data\qa-calibrated-regressions-x3tJvJ\10.log |
| cargo.exe test -p project-assistant-core --lib --locked diagnose_public_live_retrieval -- --ignored --nocapture | 0 | .local-data\qa-calibrated-regressions-x3tJvJ\11.log |

复杂检查值在下表仅列字段/项数摘要（每格最多300字符）；完整trace、指纹、账本和实际值均保留于机器JSON及原始gate。

| 门槛 | 通过 | 实际观测 |
| --- | --- | --- |
| frozen_development_scope | 是 | {"papers":6,"questions":20,"answerable":19,"unanswerable":1} |
| complete_run | 是 | {"complete":true,"haltReason":null} |
| extraction_jobs_completed | 是 | 6 |
| nonempty_confirmed_memory_per_paper | 是 | [{"id":"1902.09666","memories":71},{"id":"1603.01514","memories":132},{"id":"1806.00738","memories":49},{"id":"1908.07245","memories":66},{"id":"1902.09243","memories":132},{"id":"1705.01214","memories":476}] |
| integrity_verified | 是 | [{"file":"docs/memory-public-live-qa-calibrated-dev-v3-results.json","passed":true}] |
| deterministic_regressions_passed | 是 | 数组（11项）；原值2684字符，完整值见机器JSON |
| no_cross_project_citations | 是 | 0 |
| all_isolated_judgments_available | 是 | 20 |
| question_information_retained | 是 | 18 |
| desktop_complete_answers | 是 | 13 |
| desktop_correct_abstention | 是 | 1 |
| connector_complete_answers | 是 | 16 |
| connector_correct_abstention | 是 | 1 |
| qa_calibrated_registered_thresholds | 是 | 对象（14字段：retainedYesOrPartial、desktopComplete、connectorComplete、desktopReferencesSuffici、connectorReferencesSuffi、desktopCorrectAbstention…）；原值416字符，完整值见机器JSON |
| registration_and_tests_before_development | 是 | {"registration":"2026-10-20T15:57:50.901Z","tests":"2026-10-20T16:55:55.674Z","live":"2026-10-20T16:56:11.086Z"} |
| registered_dataset_model_and_previous_baseline | 是 | {"file":"docs\\memory-public-live-qa-efficient-dev-v2-results.json","workspace":".local-data\\public-memory-live-VtyS0h","binarySha256":"57248d7658e4b18cf03bfcaa2a75fbc4848b5c4f09e82aeec3ccf5b392d82f89"} |
| same_twenty_development_questions | 是 | 数组（20项）；原值861字符，完整值见机器JSON |
| extraction_sources_unchanged | 是 | 对象（28字段：ai.rs、answer_contract.rs、assistant_qa.rs、backup.rs、bin\pm-host.rs、change_control.rs…）；原值2311字符，完整值见机器JSON |
| tested_source_binary_and_evaluation_match | 是 | 对象（2字段：binary、evaluation）；原值1872字符，完整值见机器JSON |
| retained_memory_floor | 是 | 18 |
| desktop_complete_answer_floor | 是 | 13 |
| desktop_references_preserved | 是 | 17 |
| desktop_correct_refusal | 是 | 1 |
| desktop_all_twenty_anonymously_paired | 是 | 20 |
| desktop_paired_correctness_guard | 是 | {"current":13,"previousPaired":13,"net":0} |
| connector_complete_answer_floor | 是 | 16 |
| connector_references_preserved | 是 | 17 |
| connector_correct_refusal | 是 | 1 |
| connector_all_twenty_anonymously_paired | 是 | 20 |
| connector_paired_correctness_guard | 是 | {"current":16,"previousPaired":15,"net":1} |
| combined_paired_improvement | 是 | 1 |
| all_forty_production_entries | 是 | 40 |
| registered_production_caps_observed | 是 | 数组（40项）；原值278241字符，完整值见机器JSON |
| no_top_level_qa_protocol_errors | 是 | 0 |
| no_review_protocol_failures | 否 | 1 |
| supplement_protocol_failures_not_worse | 否 | 1 |
| qa_token_usage_complete | 是 | {"requests":121,"currentComplete":true,"baselineComplete":true} |
| qa_cost_baseline_is_registered_previous_development | 是 | 262191 |
| combined_qa_tokens_within_ten_percent_growth | 否 | {"previousTokens":262191,"currentTokens":333357,"reductionFraction":-0.2714280810554137} |
| cumulative_prior_ledger_verified | 是 | 对象（5字段：version、entries、requests、totalTokens、sha256）；原值1477字符，完整值见机器JSON |
| original_budget_registration_unchanged | 是 | {"maxRequests":600,"maxTokens":3000000} |
| one_time_budget_extension_registered_before_tests_and_live | 是 | 对象（8字段：file、sha256、registeredAt、baseRegistrationSha256、baseThresholdsSha256、originalDevelopmentLimit…）；原值588字符，完整值见机器JSON |
| shared_registered_development_budget | 是 | {"currentRequests":281,"priorRequests":548,"currentTokens":1201503,"priorTokens":2451045,"declaredLimits":{"requests":352,"observedTotalTokens":2048955,"concurrentWorkers":3,"automaticRetries":0},"effectiveTotalLimits":{"maxRequests":900,"maxTokens":4500000}} |

未提供同记忆诊断。

完整指标、逐题变化、评分修复审计：[机器JSON](memory-qa-calibrated-metrics.json)。[上一轮QA效率报告](memory-qa-efficient-report.md)。

## 限制

- 参考充分和答案正确均是自动评分，不能代替独立人工标注；断言精确率未测。
- 本轮仅执行固定20题开发集（19道可答、1道无答案）；三次复测没有增加不同问题样本。完整100题预设的91道可答/9道无答案均尚未执行，不能当作本轮已观测分母，全部全量质量与拒答指标未测。
- 公开英文论文不等于中文业务记忆；未覆盖长期冲突、更新、遗忘与全生命周期。
- 报告生成只读取保存工件，不产生真实模型调用。
