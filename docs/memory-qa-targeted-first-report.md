# 逐项目标与未知项校准：真实LLM完整链路对比

生成时间：2026-10-21T02:23:00.976Z。模型：`deepseek-flash`。QASPER冻结公开数据，CC BY 4.0，[来源与适配](memory-public-datasets.md)。

20题开发集：完成；预注册门槛：未通过。本报告尚无100题运行工件，不宣称完整100题提升。

本轮实际重新执行提取、记忆组织、两个生产问答入口和隔离评分。提取实现保持不变，随机输出仍可能改变；新旧差值属于完整链路联合结果。原80题已参与分析，当前是固定回归集。自动评分使用同一模型，未独立人工复核。

比较基线分开登记：开发质量及匿名配对使用qa-calibrated-dev-v3（原完整正确13/16、参考充分17/17）；开发QA成本恢复使用qa-efficient-dev-v2的262191 tokens。完整100题直接比较qa-efficient-full，因为calibrated-full从未运行。历史原分与同次匿名重新评分均独立保留。

## 预算与实现归因

本轮继续优化未知项审查、回答目标区分、覆盖与拒答校准；生产上限保持5调用、累计180000输入字符、24参考/36000字符。所有provider QA尝试（包括补查、审查和失败）计入实际成本。开发门槛要求相对同20题成本参考262191个QA token增长不超过10%，即不超过288410。全量成本目标不超过1664381，并分别保留质量、参考充分和无答案正确拒答目标的达成情况。逐unknown诊断仅读取保存trace，不改变实际回答或评分；完整格式和producer选择规则见适配说明。

本次提供的1个不同实际运行（含已提供失败pilot、本次开发）共238次真实调用、1102421个已报告token；不含上一轮基线。完整100题未运行，未发生的全量调用不计入费用，也没有全量质量指标。

## 新独立轮次预算与全部开发尝试

本轮在首次API前登记开发累计1200请求/6M tokens、最多4次fresh20，无自动预算扩展。这不是旧calibrated轮的第二次预算扩展。

| 尝试 | 完整执行 | gate | 调用 | 报告tokens |
| --- | --- | --- | --- | --- |
| 1 | true | false | 238 | 1102421 |

本轮开发累计238/1200次请求、1102421/6000000tokens；全量2000/12M独立计限。所有失败开发与当前开发都在本轮递归账本计费，不只扣最新prior。

旧calibrated三次失败完整保留：829次调用/3652548 tokens；与本轮已提供工件合计1067次调用/4754969 tokens。此跨轮合计涵盖紧邻的两轮，不冒充整个项目历次总成本，也不将历史费用扣入本轮预算。历史指纹与failedgate均见机器JSON。

## 单独开发集20题

6篇/20题，可答19、无答案1。完整执行：是。

| 环节 | 上一轮原始结果 | 本轮结果 |
| --- | --- | --- |
| 提取成功 | 6/6 | 6/6 |
| 正式记忆 | 926 | 940 |
| 信息保留yes / partial / no | yes: 17；no: 1；partial: 1 | yes: 17；no: 1；partial: 1 |
| 桌面参考充分 | 17/19（89.5%） | 16/19（84.2%） |
| 桌面完整正确 | 13/19（68.4%） | 13/19（68.4%） |
| 桌面无答案正确拒答 | 1/1（100.0%） | 1/1（100.0%） |
| 飞书问答参考充分 | 17/19（89.5%） | 16/19（84.2%） |
| 飞书问答完整正确 | 16/19（84.2%） | 11/19（57.9%） |
| 飞书问答无答案正确拒答 | 1/1（100.0%） | 1/1（100.0%） |

### 同次匿名配对与评分漂移

| 入口 | 上一轮原始完整正确 | 本轮重新评分旧答案 | 本轮新答案 | 配对新增 / 退化 | 无答案旧配对 / 本轮 |
| --- | --- | --- | --- | --- | --- |
| 桌面 | 13/19（68.4%） | 12/19（63.2%） | 13/19（68.4%） | 2 / 1 | 1/1（100.0%） / 1/1（100.0%） |
| 飞书问答 | 16/19（84.2%） | 13/19（68.4%） | 11/19（57.9%） | 0 / 2 | 1/1（100.0%） / 1/1（100.0%） |

原始旧评分与本次配对旧评分可能不同；两个结果均保留，不用新评分覆盖旧工件。提取重新运行，记忆正文与组织字段仍可能漂移，因此端到端差值不是检索模块的独立因果效应。

### 阶段损失与上下文组装

| 入口 | 第一处观测损失 | 参考充分时答对 | 有充分记忆时参考充分 | 错误码 | p50 / p95毫秒 |
| --- | --- | --- | --- | --- | --- |
| 桌面 | success: 13；answer_error_or_refusal: 3；memory_content_missing: 2；retrieval_context_loss: 1 | 13/16（81.3%） | 16/17（94.1%） | 无 | 2466 / 3829 |
| 飞书问答 | success: 11；answer_error_or_refusal: 5；memory_content_missing: 2；retrieval_context_loss: 1 | 11/16（68.8%） | 16/17（94.1%） | 无 | 2094 / 3614 |

待审核草稿1条；未审草稿进入正式记忆0条。正式记忆数量和逐字来源校验不能代替语义精确率；该指标仍未独立人工标注。

### 成本与恢复记录

组合QA token：333357→227088，减少31.9%；实际请求121→78。该项不含提取和评分，但所有实际阶段费用均在下表及总用量中保留。

| 入口 | 旧→新QA请求 | 旧→新QA token | 旧→新p50/p95毫秒 | 旧→新实际补查生成题数 | 旧→新可答题拒答数 | 旧→新无答案题拒答数 |
| --- | --- | --- | --- | --- | --- | --- |
| 桌面 | 66→39 | 174946→108896 | 3207/8416→2466/3829 | 9→0 | 1→1 | 1→1 |
| 飞书问答 | 55→39 | 158411→118192 | 2317/7127→2094/3614 | 6→0 | 1→1 | 1→1 |

这里“拒答数”是生产最终grounded/status观测，不等于正确拒答数；正确性在独立无答案分母中另计。“实际补查生成”须至少两次真实generation请求，不能把仅规划或空改写算作补查。

| 入口 | 旧→新规划补查题数 | 旧→新额外检索轮数 | 旧→新任一审查拒绝题数 | 旧→新补查失败码 |
| --- | --- | --- | --- | --- |
| 桌面 | 10→0 | 10→6 | 2→1 | 无→无 |
| 飞书问答 | 6→0 | 6→6 | 1→1 | 无→无 |

补查失败可被生产流程安全转换为unknown或退回已核验partial，因此不能只看顶层error或supplementStatus；下表同时读取各检索轮的review unavailable。

| 入口 | 旧→新review unavailable代码 | 旧→新协议review失败题数 | 旧→新补查协议失败题数（入口并集） |
| --- | --- | --- | --- |
| 桌面 | QA_REVIEW_SCHEMA: 1→无 | 1→0 | 1→0 |
| 飞书问答 | 无→无 | 0→0 | 0→0 |

| 入口 | 旧→新已核验partial回退 | 旧→新相同上下文跳过 | 本轮generation选择索引 |
| --- | --- | --- | --- |
| 桌面 | 1→0 | 1→2 | 0: 20 |
| 飞书问答 | 0→0 | 0→5 | 0: 20 |

UNCHANGED_CONTEXT表示复验后跳过重复生成，单列为节省行为，不当成补查失败。安全partial回退仍按实际所有尝试计费，并按producer选中的真实generation参考做检索评分。某分支观测次数为0时，不能把token下降归因于该分支；本报告未做逐机制因果消融。

### 审查校准（事后审计）

新review的answersQuestion/completeAnswer是controller根据目标、义务及unknown裁决派生的兼容字段，不是provider重复给出的summary布尔；原始provider对象保留在rawProviderReview，derivedState和localTargetGuard单列。unknownIndex对应reviewInputUnknowns的1-based位置，不使用最终unknowns或raw generation索引解释。旧基线保留其原始合同解释。

| 入口 | 有效review | 派生completeAnswer=true | 选中raw unknowns被清空 | 清空后自动答案标签 | complete审查后最终grounded答案标签 |
| --- | --- | --- | --- | --- | --- |
| 桌面 | 19 | 12 | 1 | yes: 1 | yes: 10；partial: 2 |
| 飞书问答 | 19 | 12 | 1 | partial: 1 | yes: 8；partial: 4 |

| 入口 | 逐目标review | 目标状态 | 逐unknown review | 全部模型unknown处置 | 选中review的模型unknown处置 | grounded且保留/移除并存 |
| --- | --- | --- | --- | --- | --- | --- |
| 桌面 | 19 | answered: 12；partial: 6；missing: 1 | 19 | retain: 7；unasked: 1 | retain: 7；unasked: 1 | 0 |
| 飞书问答 | 19 | answered: 14；partial: 5；missing: 1 | 19 | retain: 7；unasked: 1 | retain: 7；unasked: 1 | 0 |

| 入口 | 保守规范化 | 保留rawProviderReview数 | derivedState.status | raw义务全answered但仍有明确缺项 |
| --- | --- | --- | --- | --- |
| 桌面 | 无 | 19 | answered: 12；partial: 6；unknown: 1 | 0 |
| 飞书问答 | coarse-answered-with-explicit-gaps: 1 | 19 | answered: 12；partial: 6；unknown: 1 | 1 |

0结构协议失败不等于0模型语义或逻辑不一致。新provider去掉重复summary布尔，controller从目标、义务和逐unknown裁决派生兼容状态；rawProviderReview、derivedState、inputUnknowns和localTargetGuard分别保留。局部目标守卫的保守降级不能当作provider原始意见，也不能据派生complete认定人工正确。旧calibrated三轮失败保持原样，不用本轮规则回填。

逐unknown统计仅读取本轮保存的obligations/unknownDecisions；未含这些字段的旧schema记为未提供，不推造处理结论。disposition与claimIndices是模型审查产物，尚未人工评定；不能把unasked/answered标签视为事实正确证明。原始unknown顺序和处置索引均保留，最终unknown还可能合并missingAspects，因此不按数组长度差推断每条语义是否解决。

有效review按保存的结构字段计数，null或不完整记录不计；unknowns清空要求实际选中generation原有非空unknowns、最终grounded=true且最终unknowns显式为空。completeAnswer=true不是独立的完整性证明：审查也可能把未回答目标当作背景，或把事实暗示当作直接结论。下列自动非完整标签与unknowns处理案例仅供事后人工复核，不据此修改分数或判定人工错误；完整原始unknowns和逐例收据保存在机器JSON。

| 题号 | 入口 | 选中generation | 生成/审查收据 | unknowns清空 | 自动答案标签 | 人工评定 |
| --- | --- | --- | --- | --- | --- | --- |
| feafcc1c4026d7f55a2c8ce7850d7e12030b5c22 | 桌面 | 0 | 130/131 | 是 | yes | 未做 |
| 5daeb8d4d6f3b8543ec6309a7a35523e160437eb | 桌面 | 0 | 44/45 | 否 | partial | 未做 |
| dd76130ec5fac477123fe8880472d03fbafddef6 | 桌面 | 0 | 175/176 | 否 | partial | 未做 |
| dd76130ec5fac477123fe8880472d03fbafddef6 | 飞书问答 | 0 | 177/178 | 是 | partial | 未做 |
| 747b847d687f703cc20a87877c5b138f26ff137d | 飞书问答 | 0 | 72/75 | 否 | partial | 未做 |
| 50cc6c5f2dcf5fb87b56007f6a825fa7c90b64ed | 飞书问答 | 0 | 87/89 | 否 | partial | 未做 |
| 1be54c5b3ea67d837ffba2290a40c1e720d9587f | 飞书问答 | 0 | 22/23 | 否 | partial | 未做 |

| 阶段 | 上一轮请求/token | 本轮请求/token |
| --- | --- | --- |
| all | 281 / 1201503 | 238 / 1102421 |
| extraction | 100 / 432692 | 100 / 434437 |
| qa | 121 / 333357 | 78 / 227088 |
| judge | 60 / 435454 | 60 / 440896 |

| 阶段 | 请求 | 输入token | 输出token | 总token | 缺usage请求 | 累计请求毫秒 |
| --- | --- | --- | --- | --- | --- | --- |
| extraction:extraction | 100 | 287182 | 147255 | 434437 | 0 | 443080 |
| qa:generation | 40 | 156653 | 7006 | 163659 | 0 | 49581 |
| qa:answer_review | 38 | 59980 | 3449 | 63429 | 0 | 35029 |
| judge:answer | 20 | 64231 | 2898 | 67129 | 0 | 23867 |
| judge:memory | 20 | 301293 | 2785 | 304078 | 0 | 26253 |
| judge:retrieval | 20 | 67764 | 1925 | 69689 | 0 | 20143 |

本轮238次真实请求，1102421个已报告token，墙钟6.5分钟。并发请求耗时不可相加当墙钟。计费金额未估算。

评分API格式重评0次、0token；当前评分错误0题。已收到评分JSON末尾单个右括号恢复4条，额外调用0，完整审计保存在机器JSON与原始收据。

完整flat answer系统外层无损规范化0条，额外调用0、额外token为0。只增加systems包装，不更改已有标签、理由或匿名映射；原始与规范JSON的SHA256及收据ID保留在机器JSON。

memory-only未判yes而retrieval-only判yes的隔离评分分歧0个入口案例。本次未发现这类隔离评分分歧。

### 逐题对比

| 题号 | 入口 | 可答 | 旧原始/旧配对/本轮答案 | 旧/新正文保留 | 旧/新参考充分 | 配对变化 | 旧/新状态 | 旧/新生成次数 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 55bd59076a49b19d3283af41c5e3ccb875f3eb0c | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | partial/answered | 2/1 |
| 55bd59076a49b19d3283af41c5e3ccb875f3eb0c | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 5daeb8d4d6f3b8543ec6309a7a35523e160437eb | 桌面 | 是 | partial/partial/partial | yes/yes | yes/yes | still_unsuccessful | answered/answered | 1/1 |
| 5daeb8d4d6f3b8543ec6309a7a35523e160437eb | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 521280a87c43fcdf9f577da235e7072a23f0673e | 桌面 | 是 | partial/partial/partial | yes/yes | yes/yes | still_unsuccessful | partial/partial | 2/1 |
| 521280a87c43fcdf9f577da235e7072a23f0673e | 飞书问答 | 是 | yes/yes/partial | yes/yes | yes/yes | regression | answered/partial | 1/1 |
| 5a8cc8f80509ea77d8213ed28c5ead501c68c725 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 5a8cc8f80509ea77d8213ed28c5ead501c68c725 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 747b847d687f703cc20a87877c5b138f26ff137d | 桌面 | 是 | partial/partial/yes | yes/yes | yes/yes | new_success | answered/answered | 1/1 |
| 747b847d687f703cc20a87877c5b138f26ff137d | 飞书问答 | 是 | yes/yes/partial | yes/yes | yes/yes | regression | answered/answered | 1/1 |
| 111afb77cfbf4c98e0458606378fa63a0e965e36 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/partial | 2/1 |
| 111afb77cfbf4c98e0458606378fa63a0e965e36 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/partial | 2/1 |
| 50cc6c5f2dcf5fb87b56007f6a825fa7c90b64ed | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | partial/partial | 2/1 |
| 50cc6c5f2dcf5fb87b56007f6a825fa7c90b64ed | 飞书问答 | 是 | no/partial/partial | yes/yes | yes/yes | still_unsuccessful | answered/answered | 1/1 |
| 6bf5620f295b5243230bc97b340fae6e92304595 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 6bf5620f295b5243230bc97b340fae6e92304595 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 1be54c5b3ea67d837ffba2290a40c1e720d9587f | 桌面 | 是 | partial/no/yes | yes/yes | yes/yes | new_success | answered/answered | 1/1 |
| 1be54c5b3ea67d837ffba2290a40c1e720d9587f | 飞书问答 | 是 | yes/partial/partial | yes/yes | yes/yes | still_unsuccessful | answered/answered | 1/1 |
| 584af673429c7f8621c6bf83362a37048daa0e5d | 桌面 | 是 | yes/yes/partial | yes/yes | yes/yes | regression | answered/partial | 2/1 |
| 584af673429c7f8621c6bf83362a37048daa0e5d | 飞书问答 | 是 | yes/partial/partial | yes/yes | yes/yes | still_unsuccessful | answered/partial | 1/1 |
| c37f65c9f0d543a35c784263b79236ccf1c44fac | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| c37f65c9f0d543a35c784263b79236ccf1c44fac | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| b08f88d1facefceb87e134ba2c1fa90035018e83 | 桌面 | 是 | no/no/no | no/no | no/no | still_unsuccessful | unknown/unknown | 1/1 |
| b08f88d1facefceb87e134ba2c1fa90035018e83 | 飞书问答 | 是 | no/no/no | no/no | no/no | still_unsuccessful | unknown/unknown | 2/1 |
| 10fb7dc031075946153baf0a0599e126de29e3a4 | 桌面 | 是 | yes/partial/partial | partial/partial | yes/no | still_unsuccessful | partial/partial | 2/1 |
| 10fb7dc031075946153baf0a0599e126de29e3a4 | 飞书问答 | 是 | yes/partial/partial | partial/partial | yes/no | still_unsuccessful | partial/partial | 2/1 |
| c5b0ed5db65051eebd858beaf303809aa815e8e5 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| c5b0ed5db65051eebd858beaf303809aa815e8e5 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 7ab9c0b4ceca1c142ff068f85015a249b14282d0 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 7ab9c0b4ceca1c142ff068f85015a249b14282d0 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| d28d86524292506d4b24ae2d486725a6d57a3db3 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | partial/partial | 2/1 |
| d28d86524292506d4b24ae2d486725a6d57a3db3 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | partial/partial | 2/1 |
| 63488da6c7aff9e374561a24ba224e9ce7f65e40 | 桌面 | 否 | yes/yes/yes | no/no | no/no | retained_success | unknown/unknown | 2/1 |
| 63488da6c7aff9e374561a24ba224e9ce7f65e40 | 飞书问答 | 否 | yes/yes/yes | no/no | no/no | retained_success | unknown/unknown | 2/1 |
| c1c44fd96c3fa6e16949ae8fa453e511c6435c68 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| c1c44fd96c3fa6e16949ae8fa453e511c6435c68 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| feafcc1c4026d7f55a2c8ce7850d7e12030b5c22 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| feafcc1c4026d7f55a2c8ce7850d7e12030b5c22 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/partial | 2/1 |
| dd76130ec5fac477123fe8880472d03fbafddef6 | 桌面 | 是 | partial/partial/partial | yes/yes | partial/partial | still_unsuccessful | partial/answered | 2/1 |
| dd76130ec5fac477123fe8880472d03fbafddef6 | 飞书问答 | 是 | partial/partial/partial | yes/yes | partial/partial | still_unsuccessful | answered/answered | 1/1 |

### 独立开发成本恢复参考

| 比较项 | 实际QA tokens | 硬上限 | 完全恢复目标 |
| --- | --- | --- | --- |
| qa-calibrated-dev-v3质量基线 | 333357 | 不用于放宽成本门槛 | — |
| qa-efficient-dev-v2成本参考 | 262191 | 288410 | 262191 |
| 本轮真实开发 | 227088 | 达到 | 达到 |

## 结果解释与未解决问题

当前开发门槛仍未通过，失败项为desktop_complete_answer_floor、desktop_references_preserved、connector_complete_answer_floor、connector_references_preserved、connector_paired_correctness_guard、combined_paired_improvement。参考充分率、完整正确率、协议可靠性和实际QA成本分别判断；参考充分不能证明主模型/子模型归属、未知项处理或完整回答已全部修复。因此未进入100题运行，全部100题成功目标仍未测。

上一轮已记录individual与joint主体混淆、未问细节保留为unknown触发补查，以及相关研究或数据增强来源占用导航位置。本轮以保存的实际收据逐项核查，不预设这些问题已修复或仍成立；自动标签和事后案例仍需人工复核。

[上一轮案例审计](memory-qa-calibrated-case-audit.json) · [上一轮成本与协议审计](memory-qa-calibrated-cost-protocol-audit.json) · [上一轮最终原始审计](memory-qa-calibrated-final-audit.json)

## 开发集人工复核待办

独立开发20题中，自动判参考充分但未完整答对的8个入口结果涉及6道题。下表仅是排查假设，尚未人工评定，不据此改分，也不用于修改当前冻结代码或完整100题运行。

| 题号 | 入口 | 生产收据ID | 待核验假设 | 人工评定 |
| --- | --- | --- | --- | --- |
| 5daeb8d4d6f3b8543ec6309a7a35523e160437eb | 桌面 | 44, 45 | 参考被自动判充分而最终答案未完整正确，需人工核查目标理解、完整性与评分口径。 | 未做 |
| 521280a87c43fcdf9f577da235e7072a23f0673e | 桌面、飞书问答 | 50, 51, 52, 54 | 参考被自动判充分而最终答案未完整正确，需人工核查目标理解、完整性与评分口径。 | 未做 |
| 747b847d687f703cc20a87877c5b138f26ff137d | 飞书问答 | 72, 75 | 参考被自动判充分而最终答案未完整正确，需人工核查目标理解、完整性与评分口径。 | 未做 |
| 50cc6c5f2dcf5fb87b56007f6a825fa7c90b64ed | 飞书问答 | 87, 89 | 参考被自动判充分而最终答案未完整正确，需人工核查目标理解、完整性与评分口径。 | 未做 |
| 1be54c5b3ea67d837ffba2290a40c1e720d9587f | 飞书问答 | 22, 23 | 参考被自动判充分而最终答案未完整正确，需人工核查目标理解、完整性与评分口径。 | 未做 |
| 584af673429c7f8621c6bf83362a37048daa0e5d | 桌面、飞书问答 | 24, 25, 28, 29 | 参考被自动判充分而最终答案未完整正确，需人工核查目标理解、完整性与评分口径。 | 未做 |

## 确定性检查与门槛

确定性检查通过，11条命令。评分规则指纹和源码/二进制指纹保存在机器JSON。

| 命令 | 退出码 | 日志 |
| --- | --- | --- |
| cargo.exe test -p project-assistant-core --locked | 0 | .local-data\qa-targeted-regressions-RwRCBh\1.log |
| cargo.exe clippy -p project-assistant-core --locked --lib --tests -- -D warnings | 0 | .local-data\qa-targeted-regressions-RwRCBh\2.log |
| cargo.exe build -p project-assistant-core --bin pm-host --locked | 0 | .local-data\qa-targeted-regressions-RwRCBh\3.log |
| powershell.exe -NoProfile -Command npm run build | 0 | .local-data\qa-targeted-regressions-RwRCBh\4.log |
| node.exe --test scripts/check-memory-public-development.test.mjs scripts/check-memory-qa-calibrated-development.test.mjs scripts/check-memory-qa-efficient-development.test.mjs scripts/check-memory-qa-targeted-development.test.mjs scripts/check-memory-retrieval-development.test.mjs scripts/evaluate-memory-quality.test.mjs scripts/memory-public-live-budget.test.mjs scripts/memory-public-live-options.test.mjs scripts/memory-qa-calibrated-evaluation.test.mjs scripts/memory-qa-efficient-evaluation.test.mjs scripts/memory-qa-targeted-budget.test.mjs scripts/memory-qa-targeted-evaluation.test.mjs scripts/report-memory-extraction-optimized.test.mjs scripts/report-memory-qa-calibrated.test.mjs scripts/report-memory-qa-efficient.test.mjs scripts/report-memory-qa-targeted.test.mjs scripts/report-memory-retrieval-optimized.test.mjs scripts/score-memory-public-live.test.mjs | 0 | .local-data\qa-targeted-regressions-RwRCBh\5.log |
| node.exe scripts/verify-restart.mjs | 0 | .local-data\qa-targeted-regressions-RwRCBh\6.log |
| node.exe scripts/verify-extraction-recovery.mjs | 0 | .local-data\qa-targeted-regressions-RwRCBh\7.log |
| node.exe scripts/verify-memory-public-live.mjs --no-write | 0 | .local-data\qa-targeted-regressions-RwRCBh\8.log |
| node.exe scripts/verify-memory-public-live.mjs docs/memory-public-live-qa-efficient-dev-v2-results.json docs/memory-public-live-qa-calibrated-dev-results.json docs/memory-public-live-qa-calibrated-dev-v2-results.json docs/memory-public-live-qa-calibrated-dev-v3-results.json --no-write | 0 | .local-data\qa-targeted-regressions-RwRCBh\9.log |
| node.exe scripts/verify-memory-public-live.mjs docs/memory-public-live-qa-efficient-full-results.json --no-write | 0 | .local-data\qa-targeted-regressions-RwRCBh\10.log |
| cargo.exe test -p project-assistant-core --lib --locked diagnose_public_live_retrieval -- --ignored --nocapture | 0 | .local-data\qa-targeted-regressions-RwRCBh\11.log |

复杂检查值在下表仅列字段/项数摘要（每格最多300字符）；完整trace、指纹、账本和实际值均保留于机器JSON及原始gate。

| 门槛 | 通过 | 实际观测 |
| --- | --- | --- |
| frozen_development_scope | 是 | {"papers":6,"questions":20,"answerable":19,"unanswerable":1} |
| complete_run | 是 | {"complete":true,"haltReason":null} |
| extraction_jobs_completed | 是 | 6 |
| nonempty_confirmed_memory_per_paper | 是 | [{"id":"1902.09666","memories":74},{"id":"1603.01514","memories":135},{"id":"1806.00738","memories":45},{"id":"1908.07245","memories":70},{"id":"1902.09243","memories":131},{"id":"1705.01214","memories":485}] |
| integrity_verified | 是 | [{"file":"docs/memory-public-live-qa-targeted-dev-results.json","passed":true}] |
| deterministic_regressions_passed | 是 | 数组（11项）；原值2910字符，完整值见机器JSON |
| no_cross_project_citations | 是 | 0 |
| all_isolated_judgments_available | 是 | 20 |
| question_information_retained | 是 | 18 |
| desktop_complete_answers | 是 | 13 |
| desktop_correct_abstention | 是 | 1 |
| connector_complete_answers | 是 | 11 |
| connector_correct_abstention | 是 | 1 |
| qa_targeted_registered_thresholds | 是 | 对象（14字段：retainedYesOrPartial、desktopComplete、connectorComplete、desktopReferencesSuffici、connectorReferencesSuffi、desktopCorrectAbstention…）；原值416字符，完整值见机器JSON |
| registration_and_tests_before_development | 是 | {"registration":"2026-10-21T01:38:47.015Z","tests":"2026-10-21T02:14:48.972Z","live":"2026-10-21T02:15:29.997Z"} |
| registered_dataset_model_and_previous_baseline | 是 | {"file":"docs\\memory-public-live-qa-calibrated-dev-v3-results.json","workspace":".local-data\\public-memory-live-gyhgY7","binarySha256":"d2c65408a3f1fd8778834d7195b4068f10d4d6c58e14f4364b6af6dde9adfd22"} |
| same_twenty_development_questions | 是 | 数组（20项）；原值861字符，完整值见机器JSON |
| production_full_pipeline_and_separated_judges | 是 | {"paragraphControl":false,"mode":"separated","stages":{"answer":20,"memory":20,"retrieval":20}} |
| grading_criteria_and_labels_unchanged | 是 | 对象（18字段：scripts/evaluate-memory-、scripts/memory-evaluatio、scripts/memory-public-li、scripts/memory-public-li、scripts/memory-public-li、scripts/score-memory-pub…）；原值1985字符，完整值见机器JSON |
| extraction_and_retrieval_sources_unchanged | 是 | 对象（29字段：ai.rs、answer_contract.rs、assistant_qa.rs、backup.rs、bin\pm-host.rs、change_control.rs…）；原值2399字符，完整值见机器JSON |
| tested_source_binary_and_evaluation_match | 是 | 对象（2字段：binary、evaluation）；原值2076字符，完整值见机器JSON |
| retained_memory_floor | 是 | 18 |
| desktop_complete_answer_floor | 否 | 13 |
| desktop_references_preserved | 否 | 16 |
| desktop_correct_refusal | 是 | 1 |
| desktop_all_twenty_anonymously_paired | 是 | 20 |
| desktop_paired_correctness_guard | 是 | {"current":13,"previousPaired":12,"net":1} |
| connector_complete_answer_floor | 否 | 11 |
| connector_references_preserved | 否 | 16 |
| connector_correct_refusal | 是 | 1 |
| connector_all_twenty_anonymously_paired | 是 | 20 |
| connector_paired_correctness_guard | 否 | {"current":11,"previousPaired":13,"net":-2} |
| combined_paired_improvement | 否 | -1 |
| targeted_explicit_review_provenance | 是 | 数组（40项）；原值3047字符，完整值见机器JSON |
| all_forty_production_entries | 是 | 40 |
| registered_production_caps_observed | 是 | 数组（40项）；原值280649字符，完整值见机器JSON |
| no_top_level_qa_protocol_errors | 是 | 0 |
| no_review_protocol_failures | 是 | 0 |
| supplement_protocol_failures_not_worse | 是 | 0 |
| qa_token_usage_complete | 是 | {"requests":78,"currentComplete":true,"baselineComplete":true} |
| qa_cost_baseline_is_registered_previous_development | 是 | 262191 |
| cost_reference_dataset_and_model_unchanged | 是 | {"dataset":"803537c32e89dce765c8e6cef6484f332d6ef5a9c91b726a4ea957e68b461d87","model":"deepseek-flash"} |
| combined_qa_tokens_within_ten_percent_growth | 是 | {"previousTokens":262191,"currentTokens":227088,"reductionFraction":0.13388331407256537} |
| cumulative_prior_ledger_verified | 是 | 对象（2字段：ledger、registration）；原值433字符，完整值见机器JSON |
| independent_budget_registration_frozen | 是 | 对象（6字段：file、sha256、registeredAt、developmentLimits、fullLimits、historicalLedgerSha256）；原值402字符，完整值见机器JSON |
| shared_registered_development_budget | 是 | {"currentRequests":238,"priorRequests":0,"currentTokens":1102421,"priorTokens":0,"attempt":1,"limits":{"maxRequests":1200,"maxTokens":6000000,"maxFreshAttempts":4}} |
| integrity_bound_to_this_compact_report | 是 | [{"file":"docs/memory-public-live-qa-targeted-dev-results.json","sha256":"d001e988b60f4860d4509975ece4b26c7699354621b6c07f08c633751db11699"}] |

未提供同记忆诊断。

完整指标、逐题变化、评分修复审计：[机器JSON](memory-qa-targeted-metrics.json)。[上一轮QA效率报告](memory-qa-efficient-report.md)。

## 限制

- 参考充分和答案正确均是自动评分，不能代替独立人工标注；断言精确率未测。
- 本轮仅执行固定20题开发集（19道可答、1道无答案）；1次复测没有增加不同问题样本。完整100题预设的91道可答/9道无答案均尚未执行，不能当作本轮已观测分母，全部全量质量与拒答指标未测。
- 公开英文论文不等于中文业务记忆；未覆盖长期冲突、更新、遗忘与全生命周期。
- 报告生成只读取保存工件，不产生真实模型调用。
