# 拒答、对象区分与输出效率：真实LLM完整链路对比

生成时间：2026-10-20T15:35:03.146Z。模型：`deepseek-flash`。QASPER冻结公开数据，CC BY 4.0，[来源与适配](memory-public-datasets.md)。

20题开发集：完成；预注册门槛：通过。100题：完成；相同生产代码、二进制、评分规则与门槛按顺序运行：是。

本轮实际重新执行提取、记忆组织、两个生产问答入口和隔离评分。提取实现保持不变，随机输出仍可能改变；新旧差值属于完整链路联合结果。原80题已参与分析，当前是固定回归集。自动评分使用同一模型，未独立人工复核。

## 预算与实现归因

本轮优化过度拒答、主模型与子模型对象区分、无向量通用对象导航及候选多样性、紧凑索引引用格式和token成本。completeAnswer只允许在审查一致且全部所问目标已回答时移除未问unknowns并升级状态，不添加或改写断言/引用；相同上下文复验后可跳过重复生成，补查失败可返回初次已核验partial并复验旧/新快照。生产上限仍为5调用、累计180000输入字符、聚焦24参考/36000字符，实际trace与冻结源码完整保留。所有provider QA请求（包括补查及失败）计入成本；开发门槛要求比同20题基线516878个QA token至少降低15%，即不超过439346。索引span捕获与已核验partial回退的实际generation选择详见格式适配说明；原始请求与全部尝试保持审计。

本次提供的3个不同运行（含已提供失败pilot、新开发及全量）共1774次真实调用、8181511个已报告token；不含上一轮基线。

## 完整100题前后总览

91道可答题与9道无答案题分开计分。下表旧值保留上一轮原始评分；同次匿名配对重新评分在下一表另列。

| 环节 | 上一轮原始 | 本轮 |
| --- | --- | --- |
| 提取成功 | 36/36 | 36/36 |
| 正式记忆 | 4589 | 4604 |
| 正文充分 / 部分保留 | 81 / 7 | 80 / 8 |
| 桌面生成参考充分 | 69/91（75.8%） | 64/91（70.3%） |
| 桌面完整正确 | 55/91（60.4%） | 62/91（68.1%） |
| 桌面无答案正确拒答 | 7/9（77.8%） | 6/9（66.7%） |
| 桌面生产QA请求 / token | 329 / 1696051 | 242 / 776389 |
| 飞书问答生成参考充分 | 68/91（74.7%） | 65/91（71.4%） |
| 飞书问答完整正确 | 55/91（60.4%） | 60/91（65.9%） |
| 飞书问答无答案正确拒答 | 6/9（66.7%） | 6/9（66.7%） |
| 飞书问答生产QA请求 / token | 257 / 1207410 | 243 / 736685 |

组合QA token 2903461→1513074，减少47.9%；生产QA调用586→485。这是100题观测结果，开发放行门槛使用独立20题原始QA基线，不相互替代。

| 入口 | 旧原始完整正确 | 同次重评旧答案 | 本轮完整正确 | 配对净增题数 | 配对新增 / 退化 |
| --- | --- | --- | --- | --- | --- |
| 桌面 | 55/91（60.4%） | 53/91（58.2%） | 62/91（68.1%） | 9 | 10 / 1 |
| 飞书问答 | 55/91（60.4%） | 53/91（58.2%） | 60/91（65.9%） | 7 | 9 / 2 |

### 同一次100题运行中的开发20题与固定回归80题

| 集合 / 入口 | 题数（可答/无答案） | 旧原始完整正确 | 配对旧答案→本轮 | 旧→新参考充分 | 旧→新正确拒答 |
| --- | --- | --- | --- | --- | --- |
| 开发20 / 桌面 | 20（19/1） | 9/19（47.4%） | 10/19（52.6%）→13/19（68.4%） | 16/19（84.2%）→16/19（84.2%） | 1/1（100.0%）→1/1（100.0%） |
| 开发20 / 飞书问答 | 20（19/1） | 12/19（63.2%） | 13/19（68.4%）→14/19（73.7%） | 16/19（84.2%）→16/19（84.2%） | 1/1（100.0%）→1/1（100.0%） |
| 固定回归80 / 桌面 | 80（72/8） | 46/72（63.9%） | 43/72（59.7%）→49/72（68.1%） | 53/72（73.6%）→48/72（66.7%） | 6/8（75.0%）→5/8（62.5%） |
| 固定回归80 / 飞书问答 | 80（72/8） | 43/72（59.7%） | 40/72（55.6%）→46/72（63.9%） | 52/72（72.2%）→49/72（68.1%） | 5/8（62.5%）→5/8（62.5%） |

这两组来自同一个完整100题工件，不把单独开发运行的20题分数拼入100题。80题此前已看过，继续作为固定回归，不能称为未见盲测。生产上限保持不变，需结合实际QA调用、token和延迟看收益。

## 单独开发集20题

6篇/20题，可答19、无答案1。完整执行：是。

| 环节 | 上一轮原始结果 | 本轮结果 |
| --- | --- | --- |
| 提取成功 | 6/6 | 6/6 |
| 正式记忆 | 931 | 944 |
| 信息保留yes / partial / no | yes: 17；no: 2 | yes: 17；no: 1；partial: 1 |
| 桌面参考充分 | 16/19（84.2%） | 16/19（84.2%） |
| 桌面完整正确 | 9/19（47.4%） | 13/19（68.4%） |
| 桌面无答案正确拒答 | 1/1（100.0%） | 1/1（100.0%） |
| 飞书问答参考充分 | 16/19（84.2%） | 16/19（84.2%） |
| 飞书问答完整正确 | 13/19（68.4%） | 14/19（73.7%） |
| 飞书问答无答案正确拒答 | 1/1（100.0%） | 1/1（100.0%） |

### 同次匿名配对与评分漂移

| 入口 | 上一轮原始完整正确 | 本轮重新评分旧答案 | 本轮新答案 | 配对新增 / 退化 | 无答案旧配对 / 本轮 |
| --- | --- | --- | --- | --- | --- |
| 桌面 | 9/19（47.4%） | 9/19（47.4%） | 13/19（68.4%） | 4 / 0 | 1/1（100.0%） / 1/1（100.0%） |
| 飞书问答 | 13/19（68.4%） | 13/19（68.4%） | 14/19（73.7%） | 1 / 0 | 1/1（100.0%） / 1/1（100.0%） |

原始旧评分与本次配对旧评分可能不同；两个结果均保留，不用新评分覆盖旧工件。提取重新运行，记忆正文与组织字段仍可能漂移，因此端到端差值不是检索模块的独立因果效应。

### 阶段损失与上下文组装

| 入口 | 第一处观测损失 | 参考充分时答对 | 有充分记忆时参考充分 | 错误码 | p50 / p95毫秒 |
| --- | --- | --- | --- | --- | --- |
| 桌面 | success: 13；answer_error_or_refusal: 3；memory_content_missing: 2；retrieval_context_loss: 1 | 13/16（81.3%） | 16/17（94.1%） | 无 | 2630 / 3197 |
| 飞书问答 | success: 14；answer_error_or_refusal: 2；memory_content_missing: 2；retrieval_context_loss: 1 | 14/16（87.5%） | 16/17（94.1%） | 无 | 2330 / 3255 |

待审核草稿1条；未审草稿进入正式记忆0条。正式记忆数量和逐字来源校验不能代替语义精确率；该指标仍未独立人工标注。

### 成本与恢复记录

组合QA token：516878→262191，减少49.3%；实际请求103→83。该项不含提取和评分，但所有实际阶段费用均在下表及总用量中保留。

| 入口 | 旧→新QA请求 | 旧→新QA token | 旧→新p50/p95毫秒 | 旧→新实际补查生成题数 | 旧→新可答题拒答数 | 旧→新无答案题拒答数 |
| --- | --- | --- | --- | --- | --- | --- |
| 桌面 | 61→41 | 315694→132336 | 4051/12196→2630/3197 | 8→1 | 5→0 | 1→1 |
| 飞书问答 | 42→42 | 201184→129855 | 3109/4233→2330/3255 | 2→2 | 1→1 | 1→1 |

这里“拒答数”是生产最终grounded/status观测，不等于正确拒答数；正确性在独立无答案分母中另计。“实际补查生成”须至少两次真实generation请求，不能把仅规划或空改写算作补查。

| 入口 | 旧→新规划补查题数 | 旧→新额外检索轮数 | 旧→新任一审查拒绝题数 | 旧→新补查失败码 |
| --- | --- | --- | --- | --- |
| 桌面 | 8→1 | 8→1 | 5→0 | ASSISTANT_GROUNDING: 1→无 |
| 飞书问答 | 2→2 | 2→2 | 0→0 | 无→无 |

补查失败可被生产流程安全转换为unknown，因此不能只看顶层error计数；这里单列queryTrace.supplementStatus。

| 入口 | 旧→新已核验partial回退 | 旧→新相同上下文跳过 | 本轮generation选择索引 |
| --- | --- | --- | --- |
| 桌面 | 0→0 | 0→0 | 0: 19；1: 1 |
| 飞书问答 | 0→0 | 0→0 | 0: 18；1: 2 |

UNCHANGED_CONTEXT表示复验后跳过重复生成，单列为节省行为，不当成补查失败。安全partial回退仍按实际所有尝试计费，并按producer选中的真实generation参考做检索评分。某分支观测次数为0时，不能把token下降归因于该分支；本报告未做逐机制因果消融。

### 审查校准（事后审计）

| 入口 | 有效review | completeAnswer=true | 选中raw unknowns被清空 | 清空后自动答案标签 | complete审查后最终grounded答案标签 |
| --- | --- | --- | --- | --- | --- |
| 桌面 | 19 | 19 | 4 | yes: 2；no: 2 | partial: 2；yes: 13；no: 4 |
| 飞书问答 | 18 | 18 | 3 | no: 2；yes: 1 | yes: 14；no: 3；partial: 1 |

有效review按保存的结构字段计数，null或不完整记录不计；unknowns清空要求实际选中generation原有非空unknowns、最终grounded=true且最终unknowns显式为空。completeAnswer=true不是独立的完整性证明：审查也可能把未回答目标当作背景，或把事实暗示当作直接结论。下列自动非完整标签与unknowns处理案例仅供事后人工复核，不据此修改分数或判定人工错误；完整原始unknowns和逐例收据保存在机器JSON。

| 题号 | 入口 | 选中generation | 生成/审查收据 | unknowns清空 | 自动答案标签 | 人工评定 |
| --- | --- | --- | --- | --- | --- | --- |
| 584af673429c7f8621c6bf83362a37048daa0e5d | 桌面 | 0 | 25/27 | 是 | yes | 未做 |
| b08f88d1facefceb87e134ba2c1fa90035018e83 | 桌面 | 0 | 36/39 | 是 | no | 未做 |
| 10fb7dc031075946153baf0a0599e126de29e3a4 | 桌面 | 0 | 89/92 | 是 | no | 未做 |
| d28d86524292506d4b24ae2d486725a6d57a3db3 | 桌面 | 0 | 120/121 | 是 | yes | 未做 |
| 747b847d687f703cc20a87877c5b138f26ff137d | 桌面 | 0 | 69/70 | 否 | partial | 未做 |
| 50cc6c5f2dcf5fb87b56007f6a825fa7c90b64ed | 桌面 | 0 | 81/82 | 否 | no | 未做 |
| 1be54c5b3ea67d837ffba2290a40c1e720d9587f | 桌面 | 0 | 19/21 | 否 | partial | 未做 |
| dd76130ec5fac477123fe8880472d03fbafddef6 | 桌面 | 0 | 180/181 | 否 | no | 未做 |
| 10fb7dc031075946153baf0a0599e126de29e3a4 | 飞书问答 | 0 | 93/95 | 是 | no | 未做 |
| d28d86524292506d4b24ae2d486725a6d57a3db3 | 飞书问答 | 0 | 122/124 | 是 | yes | 未做 |
| dd76130ec5fac477123fe8880472d03fbafddef6 | 飞书问答 | 0 | 182/183 | 是 | no | 未做 |
| 50cc6c5f2dcf5fb87b56007f6a825fa7c90b64ed | 飞书问答 | 0 | 84/85 | 否 | no | 未做 |
| 584af673429c7f8621c6bf83362a37048daa0e5d | 飞书问答 | 0 | 28/29 | 否 | partial | 未做 |

| 阶段 | 上一轮请求/token | 本轮请求/token |
| --- | --- | --- |
| all | 263 / 1379151 | 243 / 1128989 |
| extraction | 100 / 433862 | 100 / 434860 |
| qa | 103 / 516878 | 83 / 262191 |
| judge | 60 / 428411 | 60 / 431938 |

| 阶段 | 请求 | 输入token | 输出token | 总token | 缺usage请求 | 累计请求毫秒 |
| --- | --- | --- | --- | --- | --- | --- |
| extraction:extraction | 100 | 287224 | 147636 | 434860 | 0 | 450392 |
| qa:generation | 43 | 205897 | 6017 | 211914 | 0 | 51700 |
| qa:answer_review | 37 | 42306 | 2835 | 45141 | 0 | 38314 |
| qa:query_rewrite | 3 | 5065 | 71 | 5136 | 0 | 2061 |
| judge:answer | 20 | 54493 | 2716 | 57209 | 0 | 25238 |
| judge:memory | 20 | 302331 | 2838 | 305169 | 0 | 29091 |
| judge:retrieval | 20 | 67744 | 1816 | 69560 | 0 | 22303 |

本轮243次真实请求，1128989个已报告token，墙钟6.8分钟。并发请求耗时不可相加当墙钟。计费金额未估算。

评分API格式重评0次、0token；当前评分错误0题。已收到评分JSON末尾单个右括号恢复1条，额外调用0，完整审计保存在机器JSON与原始收据。

完整flat answer系统外层无损规范化1条，额外调用0、额外token为0。只增加systems包装，不更改已有标签、理由或匿名映射；原始与规范JSON的SHA256及收据ID保留在机器JSON。

memory-only未判yes而retrieval-only判yes的隔离评分分歧0个入口案例。本次未发现这类隔离评分分歧。

### 逐题对比

| 题号 | 入口 | 可答 | 旧原始/旧配对/本轮答案 | 旧/新正文保留 | 旧/新参考充分 | 配对变化 | 旧/新状态 | 旧/新生成次数 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 747b847d687f703cc20a87877c5b138f26ff137d | 桌面 | 是 | partial/partial/partial | yes/yes | yes/yes | still_unsuccessful | answered/answered | 1/1 |
| 747b847d687f703cc20a87877c5b138f26ff137d | 飞书问答 | 是 | partial/partial/yes | yes/yes | yes/yes | new_success | answered/answered | 1/1 |
| 111afb77cfbf4c98e0458606378fa63a0e965e36 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 111afb77cfbf4c98e0458606378fa63a0e965e36 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 50cc6c5f2dcf5fb87b56007f6a825fa7c90b64ed | 桌面 | 是 | partial/partial/no | yes/yes | yes/yes | still_unsuccessful | partial/answered | 2/1 |
| 50cc6c5f2dcf5fb87b56007f6a825fa7c90b64ed | 飞书问答 | 是 | partial/no/no | yes/yes | yes/yes | still_unsuccessful | answered/answered | 1/1 |
| 6bf5620f295b5243230bc97b340fae6e92304595 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 6bf5620f295b5243230bc97b340fae6e92304595 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 55bd59076a49b19d3283af41c5e3ccb875f3eb0c | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 55bd59076a49b19d3283af41c5e3ccb875f3eb0c | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 5daeb8d4d6f3b8543ec6309a7a35523e160437eb | 桌面 | 是 | no/no/yes | yes/yes | yes/yes | new_success | unknown/answered | 2/1 |
| 5daeb8d4d6f3b8543ec6309a7a35523e160437eb | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 521280a87c43fcdf9f577da235e7072a23f0673e | 桌面 | 是 | no/no/yes | yes/yes | yes/yes | new_success | unknown/answered | 2/1 |
| 521280a87c43fcdf9f577da235e7072a23f0673e | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 5a8cc8f80509ea77d8213ed28c5ead501c68c725 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 5a8cc8f80509ea77d8213ed28c5ead501c68c725 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 1be54c5b3ea67d837ffba2290a40c1e720d9587f | 桌面 | 是 | partial/partial/partial | yes/yes | yes/yes | still_unsuccessful | answered/answered | 1/1 |
| 1be54c5b3ea67d837ffba2290a40c1e720d9587f | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 584af673429c7f8621c6bf83362a37048daa0e5d | 桌面 | 是 | yes/yes/yes | yes/yes | partial/yes | retained_success | answered/answered | 1/1 |
| 584af673429c7f8621c6bf83362a37048daa0e5d | 飞书问答 | 是 | partial/partial/partial | yes/yes | partial/yes | still_unsuccessful | answered/answered | 1/1 |
| c37f65c9f0d543a35c784263b79236ccf1c44fac | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| c37f65c9f0d543a35c784263b79236ccf1c44fac | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| b08f88d1facefceb87e134ba2c1fa90035018e83 | 桌面 | 是 | no/no/no | no/no | no/no | still_unsuccessful | unknown/answered | 2/1 |
| b08f88d1facefceb87e134ba2c1fa90035018e83 | 飞书问答 | 是 | no/no/no | no/no | no/no | still_unsuccessful | unknown/unknown | 2/2 |
| 10fb7dc031075946153baf0a0599e126de29e3a4 | 桌面 | 是 | partial/no/no | no/partial | yes/no | still_unsuccessful | answered/answered | 2/1 |
| 10fb7dc031075946153baf0a0599e126de29e3a4 | 飞书问答 | 是 | partial/no/no | no/partial | yes/no | still_unsuccessful | answered/answered | 1/1 |
| c5b0ed5db65051eebd858beaf303809aa815e8e5 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| c5b0ed5db65051eebd858beaf303809aa815e8e5 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 7ab9c0b4ceca1c142ff068f85015a249b14282d0 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 7ab9c0b4ceca1c142ff068f85015a249b14282d0 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| d28d86524292506d4b24ae2d486725a6d57a3db3 | 桌面 | 是 | no/no/yes | yes/yes | yes/yes | new_success | unknown/answered | 2/1 |
| d28d86524292506d4b24ae2d486725a6d57a3db3 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 63488da6c7aff9e374561a24ba224e9ce7f65e40 | 桌面 | 否 | yes/yes/yes | no/no | no/no | retained_success | unknown/unknown | 2/2 |
| 63488da6c7aff9e374561a24ba224e9ce7f65e40 | 飞书问答 | 否 | yes/yes/yes | no/no | no/no | retained_success | unknown/unknown | 2/2 |
| c1c44fd96c3fa6e16949ae8fa453e511c6435c68 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| c1c44fd96c3fa6e16949ae8fa453e511c6435c68 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| feafcc1c4026d7f55a2c8ce7850d7e12030b5c22 | 桌面 | 是 | no/no/yes | yes/yes | yes/yes | new_success | unknown/answered | 2/1 |
| feafcc1c4026d7f55a2c8ce7850d7e12030b5c22 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| dd76130ec5fac477123fe8880472d03fbafddef6 | 桌面 | 是 | partial/no/no | yes/yes | partial/partial | still_unsuccessful | answered/answered | 1/1 |
| dd76130ec5fac477123fe8880472d03fbafddef6 | 飞书问答 | 是 | partial/no/no | yes/yes | partial/partial | still_unsuccessful | answered/answered | 1/1 |

## 开发集人工复核待办

独立开发20题中，自动判参考充分但未完整答对的5个入口结果涉及4道题。下表仅是排查假设，尚未人工评定，不据此改分，也不用于修改当前冻结代码或完整100题运行。

| 题号 | 入口 | 生产收据ID | 待核验假设 | 人工评定 |
| --- | --- | --- | --- | --- |
| 747b847d687f703cc20a87877c5b138f26ff137d | 桌面 | 69, 70 | 参考被自动判充分而最终答案未完整正确，需人工核查目标理解、完整性与评分口径。 | 未做 |
| 50cc6c5f2dcf5fb87b56007f6a825fa7c90b64ed | 桌面、飞书问答 | 81, 82, 84, 85 | 参考被自动判充分而最终答案未完整正确，需人工核查目标理解、完整性与评分口径。 | 未做 |
| 1be54c5b3ea67d837ffba2290a40c1e720d9587f | 桌面 | 19, 21 | 参考被自动判充分而最终答案未完整正确，需人工核查目标理解、完整性与评分口径。 | 未做 |
| 584af673429c7f8621c6bf83362a37048daa0e5d | 飞书问答 | 28, 29 | 参考被自动判充分而最终答案未完整正确，需人工核查目标理解、完整性与评分口径。 | 未做 |

## 已保留的首轮开发试运行与未通过门槛

首轮pilot完整执行标志true，252次真实调用、1162094个已报告token；门槛未通过。该轮提取、问答和评分均完整执行，但未达到预注册开发条件；不能把complete=true当成质量通过。原始分数、收据和所有额外费用均保留。

| 首轮未通过检查 | 实际 | 冻结要求 |
| --- | --- | --- |
| connector_references_preserved | 14 | ">=15/19; previous original 16/19" |

两次开发合计495/600次请求、2291083/3000000个报告token，共享原开发预算；完整100题另按注册上限执行。

任何失败pilot均作为独立工件保留，不回填旧分数或降低门槛；新运行按相同冻结评分标准重新完成20题。格式捕获和实际返回generation归属见[适配说明](memory-qa-efficient-format-adaptation.md)，所有已发生调用计入本轮成本。

## 首轮失败pilot（原始结果）

6篇/20题，可答19、无答案1。完整执行：是。

| 环节 | 上一轮原始结果 | 本轮结果 |
| --- | --- | --- |
| 提取成功 | 6/6 | 6/6 |
| 正式记忆 | 931 | 937 |
| 信息保留yes / partial / no | yes: 17；no: 2 | yes: 17；no: 1；partial: 1 |
| 桌面参考充分 | 16/19（84.2%） | 15/19（78.9%） |
| 桌面完整正确 | 9/19（47.4%） | 13/19（68.4%） |
| 桌面无答案正确拒答 | 1/1（100.0%） | 1/1（100.0%） |
| 飞书问答参考充分 | 16/19（84.2%） | 14/19（73.7%） |
| 飞书问答完整正确 | 13/19（68.4%） | 14/19（73.7%） |
| 飞书问答无答案正确拒答 | 1/1（100.0%） | 1/1（100.0%） |

### 同次匿名配对与评分漂移

| 入口 | 上一轮原始完整正确 | 本轮重新评分旧答案 | 本轮新答案 | 配对新增 / 退化 | 无答案旧配对 / 本轮 |
| --- | --- | --- | --- | --- | --- |
| 桌面 | 9/19（47.4%） | 10/19（52.6%） | 13/19（68.4%） | 3 / 0 | 1/1（100.0%） / 1/1（100.0%） |
| 飞书问答 | 13/19（68.4%） | 14/19（73.7%） | 14/19（73.7%） | 0 / 0 | 1/1（100.0%） / 1/1（100.0%） |

原始旧评分与本次配对旧评分可能不同；两个结果均保留，不用新评分覆盖旧工件。提取重新运行，记忆正文与组织字段仍可能漂移，因此端到端差值不是检索模块的独立因果效应。

### 阶段损失与上下文组装

| 入口 | 第一处观测损失 | 参考充分时答对 | 有充分记忆时参考充分 | 错误码 | p50 / p95毫秒 |
| --- | --- | --- | --- | --- | --- |
| 桌面 | success: 13；answer_error_or_refusal: 3；retrieval_context_loss: 2；memory_content_missing: 1 | 12/15（80.0%） | 14/17（82.4%） | 无 | 2611 / 6868 |
| 飞书问答 | success: 14；retrieval_context_loss: 2；answer_error_or_refusal: 2；memory_content_missing: 1 | 12/14（85.7%） | 14/17（82.4%） | 无 | 2119 / 3091 |

待审核草稿1条；未审草稿进入正式记忆0条。正式记忆数量和逐字来源校验不能代替语义精确率；该指标仍未独立人工标注。

### 成本与恢复记录

组合QA token：516878→289891，减少43.9%；实际请求103→92。该项不含提取和评分，但所有实际阶段费用均在下表及总用量中保留。

| 入口 | 旧→新QA请求 | 旧→新QA token | 旧→新p50/p95毫秒 | 旧→新实际补查生成题数 | 旧→新可答题拒答数 | 旧→新无答案题拒答数 |
| --- | --- | --- | --- | --- | --- | --- |
| 桌面 | 61→50 | 315694→160566 | 4051/12196→2611/6868 | 8→4 | 5→0 | 1→1 |
| 飞书问答 | 42→42 | 201184→129325 | 3109/4233→2119/3091 | 2→2 | 1→1 | 1→1 |

这里“拒答数”是生产最终grounded/status观测，不等于正确拒答数；正确性在独立无答案分母中另计。“实际补查生成”须至少两次真实generation请求，不能把仅规划或空改写算作补查。

| 入口 | 旧→新规划补查题数 | 旧→新额外检索轮数 | 旧→新任一审查拒绝题数 | 旧→新补查失败码 |
| --- | --- | --- | --- | --- |
| 桌面 | 8→4 | 8→4 | 5→1 | ASSISTANT_GROUNDING: 1→无 |
| 飞书问答 | 2→2 | 2→2 | 0→0 | 无→无 |

补查失败可被生产流程安全转换为unknown，因此不能只看顶层error计数；这里单列queryTrace.supplementStatus。

| 入口 | 旧→新已核验partial回退 | 旧→新相同上下文跳过 | 本轮generation选择索引 |
| --- | --- | --- | --- |
| 桌面 | 0→0 | 0→0 | 0: 16；1: 4 |
| 飞书问答 | 0→0 | 0→0 | 0: 18；1: 2 |

UNCHANGED_CONTEXT表示复验后跳过重复生成，单列为节省行为，不当成补查失败。安全partial回退仍按实际所有尝试计费，并按producer选中的真实generation参考做检索评分。某分支观测次数为0时，不能把token下降归因于该分支；本报告未做逐机制因果消融。

### 审查校准（事后审计）

| 入口 | 有效review | completeAnswer=true | 选中raw unknowns被清空 | 清空后自动答案标签 | complete审查后最终grounded答案标签 |
| --- | --- | --- | --- | --- | --- |
| 桌面 | 22 | 18 | 4 | yes: 3；no: 1 | partial: 3；yes: 13；no: 2 |
| 飞书问答 | 18 | 18 | 2 | yes: 2 | partial: 3；yes: 14；no: 1 |

有效review按保存的结构字段计数，null或不完整记录不计；unknowns清空要求实际选中generation原有非空unknowns、最终grounded=true且最终unknowns显式为空。completeAnswer=true不是独立的完整性证明：审查也可能把未回答目标当作背景，或把事实暗示当作直接结论。下列自动非完整标签与unknowns处理案例仅供事后人工复核，不据此修改分数或判定人工错误；完整原始unknowns和逐例收据保存在机器JSON。

| 题号 | 入口 | 选中generation | 生成/审查收据 | unknowns清空 | 自动答案标签 | 人工评定 |
| --- | --- | --- | --- | --- | --- | --- |
| 584af673429c7f8621c6bf83362a37048daa0e5d | 桌面 | 0 | 24/26 | 是 | yes | 未做 |
| b08f88d1facefceb87e134ba2c1fa90035018e83 | 桌面 | 0 | 35/36 | 是 | no | 未做 |
| 10fb7dc031075946153baf0a0599e126de29e3a4 | 桌面 | 1 | 92/94 | 是 | yes | 未做 |
| d28d86524292506d4b24ae2d486725a6d57a3db3 | 桌面 | 0 | 129/130 | 是 | yes | 未做 |
| 747b847d687f703cc20a87877c5b138f26ff137d | 桌面 | 0 | 73/75 | 否 | partial | 未做 |
| 50cc6c5f2dcf5fb87b56007f6a825fa7c90b64ed | 桌面 | 1 | 91/93 | 否 | partial | 未做 |
| 1be54c5b3ea67d837ffba2290a40c1e720d9587f | 桌面 | 0 | 18/20 | 否 | no | 未做 |
| dd76130ec5fac477123fe8880472d03fbafddef6 | 桌面 | 0 | 189/190 | 否 | partial | 未做 |
| 10fb7dc031075946153baf0a0599e126de29e3a4 | 飞书问答 | 0 | 96/99 | 是 | yes | 未做 |
| d28d86524292506d4b24ae2d486725a6d57a3db3 | 飞书问答 | 0 | 131/133 | 是 | yes | 未做 |
| 747b847d687f703cc20a87877c5b138f26ff137d | 飞书问答 | 0 | 76/77 | 否 | partial | 未做 |
| 50cc6c5f2dcf5fb87b56007f6a825fa7c90b64ed | 飞书问答 | 0 | 95/97 | 否 | no | 未做 |
| 1be54c5b3ea67d837ffba2290a40c1e720d9587f | 飞书问答 | 0 | 21/23 | 否 | partial | 未做 |
| dd76130ec5fac477123fe8880472d03fbafddef6 | 飞书问答 | 0 | 191/192 | 否 | partial | 未做 |

| 阶段 | 上一轮请求/token | 本轮请求/token |
| --- | --- | --- |
| all | 263 / 1379151 | 252 / 1162094 |
| extraction | 100 / 433862 | 100 / 434948 |
| qa | 103 / 516878 | 92 / 289891 |
| judge | 60 / 428411 | 60 / 437255 |

| 阶段 | 请求 | 输入token | 输出token | 总token | 缺usage请求 | 累计请求毫秒 |
| --- | --- | --- | --- | --- | --- | --- |
| extraction:extraction | 100 | 286792 | 148156 | 434948 | 0 | 450956 |
| qa:generation | 46 | 222458 | 6763 | 229221 | 0 | 54817 |
| qa:answer_review | 40 | 47452 | 3160 | 50612 | 0 | 41547 |
| qa:query_rewrite | 6 | 9886 | 172 | 10058 | 0 | 4955 |
| judge:answer | 20 | 55931 | 2780 | 58711 | 0 | 23831 |
| judge:memory | 20 | 304160 | 2779 | 306939 | 0 | 26104 |
| judge:retrieval | 20 | 69812 | 1793 | 71605 | 0 | 21600 |

本轮252次真实请求，1162094个已报告token，墙钟6.7分钟。并发请求耗时不可相加当墙钟。计费金额未估算。

评分API格式重评0次、0token；当前评分错误0题。已收到评分JSON末尾单个右括号恢复4条，额外调用0，完整审计保存在机器JSON与原始收据。

完整flat answer系统外层无损规范化1条，额外调用0、额外token为0。只增加systems包装，不更改已有标签、理由或匿名映射；原始与规范JSON的SHA256及收据ID保留在机器JSON。

memory-only未判yes而retrieval-only判yes的隔离评分分歧1个入口案例。它提示评分不一致，不能据此断言“未存储的信息被检索出来”或作严格因果归因。逐例ID保存在机器JSON。

### 逐题对比

| 题号 | 入口 | 可答 | 旧原始/旧配对/本轮答案 | 旧/新正文保留 | 旧/新参考充分 | 配对变化 | 旧/新状态 | 旧/新生成次数 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 747b847d687f703cc20a87877c5b138f26ff137d | 桌面 | 是 | partial/partial/partial | yes/yes | yes/partial | still_unsuccessful | answered/answered | 1/1 |
| 747b847d687f703cc20a87877c5b138f26ff137d | 飞书问答 | 是 | partial/partial/partial | yes/yes | yes/partial | still_unsuccessful | answered/answered | 1/1 |
| 111afb77cfbf4c98e0458606378fa63a0e965e36 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 111afb77cfbf4c98e0458606378fa63a0e965e36 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 50cc6c5f2dcf5fb87b56007f6a825fa7c90b64ed | 桌面 | 是 | partial/partial/partial | yes/yes | yes/yes | still_unsuccessful | partial/answered | 2/2 |
| 50cc6c5f2dcf5fb87b56007f6a825fa7c90b64ed | 飞书问答 | 是 | partial/no/no | yes/yes | yes/yes | still_unsuccessful | answered/answered | 1/1 |
| 6bf5620f295b5243230bc97b340fae6e92304595 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 6bf5620f295b5243230bc97b340fae6e92304595 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 55bd59076a49b19d3283af41c5e3ccb875f3eb0c | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 55bd59076a49b19d3283af41c5e3ccb875f3eb0c | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 5daeb8d4d6f3b8543ec6309a7a35523e160437eb | 桌面 | 是 | no/no/yes | yes/yes | yes/yes | new_success | unknown/answered | 2/1 |
| 5daeb8d4d6f3b8543ec6309a7a35523e160437eb | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 521280a87c43fcdf9f577da235e7072a23f0673e | 桌面 | 是 | no/no/partial | yes/yes | yes/yes | still_unsuccessful | unknown/partial | 2/2 |
| 521280a87c43fcdf9f577da235e7072a23f0673e | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 5a8cc8f80509ea77d8213ed28c5ead501c68c725 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 5a8cc8f80509ea77d8213ed28c5ead501c68c725 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 1be54c5b3ea67d837ffba2290a40c1e720d9587f | 桌面 | 是 | partial/no/no | yes/yes | yes/yes | still_unsuccessful | answered/answered | 1/1 |
| 1be54c5b3ea67d837ffba2290a40c1e720d9587f | 飞书问答 | 是 | yes/partial/partial | yes/yes | yes/yes | still_unsuccessful | answered/answered | 1/1 |
| 584af673429c7f8621c6bf83362a37048daa0e5d | 桌面 | 是 | yes/yes/yes | yes/yes | partial/partial | retained_success | answered/answered | 1/1 |
| 584af673429c7f8621c6bf83362a37048daa0e5d | 飞书问答 | 是 | partial/yes/yes | yes/yes | partial/partial | retained_success | answered/answered | 1/1 |
| c37f65c9f0d543a35c784263b79236ccf1c44fac | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| c37f65c9f0d543a35c784263b79236ccf1c44fac | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| b08f88d1facefceb87e134ba2c1fa90035018e83 | 桌面 | 是 | no/no/no | no/no | no/no | still_unsuccessful | unknown/answered | 2/1 |
| b08f88d1facefceb87e134ba2c1fa90035018e83 | 飞书问答 | 是 | no/no/no | no/no | no/no | still_unsuccessful | unknown/unknown | 2/2 |
| 10fb7dc031075946153baf0a0599e126de29e3a4 | 桌面 | 是 | partial/yes/yes | no/partial | yes/yes | retained_success | answered/answered | 2/2 |
| 10fb7dc031075946153baf0a0599e126de29e3a4 | 飞书问答 | 是 | partial/yes/yes | no/partial | yes/partial | retained_success | answered/answered | 1/1 |
| c5b0ed5db65051eebd858beaf303809aa815e8e5 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| c5b0ed5db65051eebd858beaf303809aa815e8e5 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 7ab9c0b4ceca1c142ff068f85015a249b14282d0 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 7ab9c0b4ceca1c142ff068f85015a249b14282d0 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| d28d86524292506d4b24ae2d486725a6d57a3db3 | 桌面 | 是 | no/no/yes | yes/yes | yes/yes | new_success | unknown/answered | 2/1 |
| d28d86524292506d4b24ae2d486725a6d57a3db3 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 63488da6c7aff9e374561a24ba224e9ce7f65e40 | 桌面 | 否 | yes/yes/yes | no/no | no/no | retained_success | unknown/unknown | 2/2 |
| 63488da6c7aff9e374561a24ba224e9ce7f65e40 | 飞书问答 | 否 | yes/yes/yes | no/no | no/no | retained_success | unknown/unknown | 2/2 |
| c1c44fd96c3fa6e16949ae8fa453e511c6435c68 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| c1c44fd96c3fa6e16949ae8fa453e511c6435c68 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| feafcc1c4026d7f55a2c8ce7850d7e12030b5c22 | 桌面 | 是 | no/no/yes | yes/yes | yes/yes | new_success | unknown/answered | 2/1 |
| feafcc1c4026d7f55a2c8ce7850d7e12030b5c22 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| dd76130ec5fac477123fe8880472d03fbafddef6 | 桌面 | 是 | partial/partial/partial | yes/yes | partial/partial | still_unsuccessful | answered/answered | 1/1 |
| dd76130ec5fac477123fe8880472d03fbafddef6 | 飞书问答 | 是 | partial/partial/partial | yes/yes | partial/partial | still_unsuccessful | answered/answered | 1/1 |

## 完整100题

36篇/100题，可答91、无答案9。完整执行：是。

| 环节 | 上一轮原始结果 | 本轮结果 |
| --- | --- | --- |
| 提取成功 | 36/36 | 36/36 |
| 正式记忆 | 4589 | 4604 |
| 信息保留yes / partial / no | yes: 81；no: 3；partial: 7 | yes: 80；no: 3；partial: 8 |
| 桌面参考充分 | 69/91（75.8%） | 64/91（70.3%） |
| 桌面完整正确 | 55/91（60.4%） | 62/91（68.1%） |
| 桌面无答案正确拒答 | 7/9（77.8%） | 6/9（66.7%） |
| 飞书问答参考充分 | 68/91（74.7%） | 65/91（71.4%） |
| 飞书问答完整正确 | 55/91（60.4%） | 60/91（65.9%） |
| 飞书问答无答案正确拒答 | 6/9（66.7%） | 6/9（66.7%） |

### 同次匿名配对与评分漂移

| 入口 | 上一轮原始完整正确 | 本轮重新评分旧答案 | 本轮新答案 | 配对新增 / 退化 | 无答案旧配对 / 本轮 |
| --- | --- | --- | --- | --- | --- |
| 桌面 | 55/91（60.4%） | 53/91（58.2%） | 62/91（68.1%） | 10 / 1 | 7/9（77.8%） / 6/9（66.7%） |
| 飞书问答 | 55/91（60.4%） | 53/91（58.2%） | 60/91（65.9%） | 9 / 2 | 6/9（66.7%） / 6/9（66.7%） |

原始旧评分与本次配对旧评分可能不同；两个结果均保留，不用新评分覆盖旧工件。提取重新运行，记忆正文与组织字段仍可能漂移，因此端到端差值不是检索模块的独立因果效应。

### 阶段损失与上下文组装

| 入口 | 第一处观测损失 | 参考充分时答对 | 有充分记忆时参考充分 | 错误码 | p50 / p95毫秒 |
| --- | --- | --- | --- | --- | --- |
| 桌面 | success: 62；answer_error_or_refusal: 7；memory_content_missing: 10；retrieval_context_loss: 12 | 57/64（89.1%） | 64/80（80.0%） | 无 | 3011 / 7812 |
| 飞书问答 | success: 60；answer_error_or_refusal: 7；memory_content_missing: 11；retrieval_context_loss: 13 | 58/65（89.2%） | 65/80（81.3%） | 无 | 2747 / 6598 |

待审核草稿16条；未审草稿进入正式记忆0条。正式记忆数量和逐字来源校验不能代替语义精确率；该指标仍未独立人工标注。

### 成本与恢复记录

组合QA token：2903461→1513074，减少47.9%；实际请求586→485。该项不含提取和评分，但所有实际阶段费用均在下表及总用量中保留。

| 入口 | 旧→新QA请求 | 旧→新QA token | 旧→新p50/p95毫秒 | 旧→新实际补查生成题数 | 旧→新可答题拒答数 | 旧→新无答案题拒答数 |
| --- | --- | --- | --- | --- | --- | --- |
| 桌面 | 329→242 | 1696051→776389 | 5720/12716→3011/7812 | 48→20 | 14→7 | 7→6 |
| 飞书问答 | 257→243 | 1207410→736685 | 3706/7985→2747/6598 | 27→21 | 9→6 | 6→6 |

这里“拒答数”是生产最终grounded/status观测，不等于正确拒答数；正确性在独立无答案分母中另计。“实际补查生成”须至少两次真实generation请求，不能把仅规划或空改写算作补查。

| 入口 | 旧→新规划补查题数 | 旧→新额外检索轮数 | 旧→新任一审查拒绝题数 | 旧→新补查失败码 |
| --- | --- | --- | --- | --- |
| 桌面 | 50→22 | 50→22 | 24→6 | ASSISTANT_GROUNDING: 1→无 |
| 飞书问答 | 29→23 | 29→23 | 9→5 | 无→无 |

补查失败可被生产流程安全转换为unknown，因此不能只看顶层error计数；这里单列queryTrace.supplementStatus。

| 入口 | 旧→新已核验partial回退 | 旧→新相同上下文跳过 | 本轮generation选择索引 |
| --- | --- | --- | --- |
| 桌面 | 0→0 | 0→0 | 0: 80；1: 20 |
| 飞书问答 | 0→2 | 0→0 | 0: 81；1: 19 |

UNCHANGED_CONTEXT表示复验后跳过重复生成，单列为节省行为，不当成补查失败。安全partial回退仍按实际所有尝试计费，并按producer选中的真实generation参考做检索评分。某分支观测次数为0时，不能把token下降归因于该分支；本报告未做逐机制因果消融。

### 审查校准（事后审计）

| 入口 | 有效review | completeAnswer=true | 选中raw unknowns被清空 | 清空后自动答案标签 | complete审查后最终grounded答案标签 |
| --- | --- | --- | --- | --- | --- |
| 桌面 | 100 | 86 | 32 | partial: 13；yes: 16；no: 3 | partial: 18；yes: 62；no: 6 |
| 飞书问答 | 99 | 82 | 30 | partial: 12；yes: 13；no: 5 | partial: 18；yes: 58；no: 6 |

有效review按保存的结构字段计数，null或不完整记录不计；unknowns清空要求实际选中generation原有非空unknowns、最终grounded=true且最终unknowns显式为空。completeAnswer=true不是独立的完整性证明：审查也可能把未回答目标当作背景，或把事实暗示当作直接结论。下列自动非完整标签与unknowns处理案例仅供事后人工复核，不据此修改分数或判定人工错误；完整原始unknowns和逐例收据保存在机器JSON。

| 题号 | 入口 | 选中generation | 生成/审查收据 | unknowns清空 | 自动答案标签 | 人工评定 |
| --- | --- | --- | --- | --- | --- | --- |
| 10fb7dc031075946153baf0a0599e126de29e3a4 | 桌面 | 0 | 88/90 | 是 | partial | 未做 |
| d28d86524292506d4b24ae2d486725a6d57a3db3 | 桌面 | 1 | 136/138 | 是 | yes | 未做 |
| 2ea4347f1992b0b3958c4844681ff0fe4d0dd1dd | 桌面 | 0 | 171/172 | 是 | partial | 未做 |
| 3355918bbdccac644afe441f085d0ffbbad565d7 | 桌面 | 0 | 282/284 | 是 | partial | 未做 |
| 2a564b092916f2fabbfe893cf13de169945ef2e1 | 桌面 | 0 | 304/305 | 是 | yes | 未做 |
| 6b9b9e5d154cb963f6d921093539490daa5ebbae | 桌面 | 0 | 278/279 | 是 | yes | 未做 |
| d6ea7a30b0b61ae126b00b59d2a14fff2ef887bf | 桌面 | 0 | 446/449 | 是 | partial | 未做 |
| b970f48d30775d3468952795bc72976baab3438e | 桌面 | 0 | 457/459 | 是 | partial | 未做 |
| 126ff22bfcc14a2f7e1a06a91ba7b646003e9cf0 | 桌面 | 0 | 366/370 | 是 | yes | 未做 |
| e6583c60b13b87fc37af75ffc975e7e316d4f4e0 | 桌面 | 0 | 374/376 | 是 | yes | 未做 |
| 7cd22ca9e107d2b13a7cc94252aaa9007976b338 | 桌面 | 0 | 476/479 | 是 | partial | 未做 |
| ee7e9a948ee6888aa5830b1a3d0d148ff656d864 | 桌面 | 0 | 522/524 | 是 | yes | 未做 |
| 56b7319be68197727baa7d498fa38af0a8440fe4 | 桌面 | 1 | 565/568 | 是 | partial | 未做 |
| 6b53e1f46ae4ba9b75117fc6e593abded89366be | 桌面 | 0 | 659/660 | 是 | partial | 未做 |
| 01e2d10178347d177519f792f86f25575106ddc7 | 桌面 | 0 | 634/636 | 是 | partial | 未做 |
| 021bfb7e180d67112b74f05ecb3fa13acc036c86 | 桌面 | 0 | 640/641 | 是 | yes | 未做 |
| 5c3e98e3cebaecd5d3e75ec2c9fc3dd267ac3c83 | 桌面 | 0 | 699/701 | 是 | partial | 未做 |
| 14b8ae5656e7d4ee02237288372d9e682b24fdb8 | 桌面 | 0 | 713/716 | 是 | yes | 未做 |
| b1ce129678e37070e69f01332f1a8587e18e06b0 | 桌面 | 0 | 738/740 | 是 | no | 未做 |
| f2155dc4aeab86bf31a838c8ff388c85440fce6e | 桌面 | 1 | 796/797 | 是 | yes | 未做 |
| 86bf75245358f17e35fc133e46a92439ac86d472 | 桌面 | 1 | 819/820 | 是 | yes | 未做 |
| 22732cb9476e521452bf0538f3fdb94cf3867651 | 桌面 | 0 | 824/825 | 是 | no | 未做 |
| 4e748cb2b5e74d905d9b24b53be6cfdf326e8054 | 桌面 | 0 | 851/853 | 是 | no | 未做 |
| 4fa6fbb9df1a4c32583d4ef70d2b29ece4b3d802 | 桌面 | 0 | 850/852 | 是 | yes | 未做 |
| 6ca938324dc7e1742a840d0a54dc13cc207394a1 | 桌面 | 0 | 859/860 | 是 | partial | 未做 |
| 72f7ef55e150e16dcf97fe443aff9971a32414ef | 桌面 | 0 | 901/902 | 是 | yes | 未做 |
| 23b2901264bda91045258b5d4120879ae292e950 | 桌面 | 1 | 922/924 | 是 | yes | 未做 |
| b5bc34e1e381dbf972d0b594fe8c66ff75305d71 | 桌面 | 0 | 932/933 | 是 | yes | 未做 |
| af34051bf3e628c1e2a00b110bb84e5f018b419f | 桌面 | 0 | 946/947 | 是 | yes | 未做 |
| 876700622bd6811d903e65314ac75971bbe23dcc | 桌面 | 0 | 905/907 | 是 | partial | 未做 |
| 37edc25e39515ffc2d92115d2fcd9e6ceb18898b | 桌面 | 0 | 914/916 | 是 | partial | 未做 |
| 6a31db1aca57a818f36bba9002561724655372a7 | 桌面 | 1 | 970/971 | 是 | yes | 未做 |
| 1be54c5b3ea67d837ffba2290a40c1e720d9587f | 桌面 | 0 | 18/20 | 否 | partial | 未做 |
| 747b847d687f703cc20a87877c5b138f26ff137d | 桌面 | 0 | 74/75 | 否 | partial | 未做 |
| 50cc6c5f2dcf5fb87b56007f6a825fa7c90b64ed | 桌面 | 0 | 85/86 | 否 | partial | 未做 |
| dd76130ec5fac477123fe8880472d03fbafddef6 | 桌面 | 0 | 314/317 | 否 | partial | 未做 |
| 7705dd04acedaefee30d8b2c9978537afb2040dc | 桌面 | 1 | 226/228 | 否 | no | 未做 |
| 975e60535724f4149c7488699a199ba2920a062c | 桌面 | 0 | 467/471 | 否 | no | 未做 |
| e3a2d8886f03e78ed5e138df870f48635875727e | 桌面 | 0 | 724/726 | 否 | partial | 未做 |
| 022c365a14fdec406c7a945a1a18e7e79df37f08 | 桌面 | 0 | 940/942 | 否 | no | 未做 |
| 1be54c5b3ea67d837ffba2290a40c1e720d9587f | 飞书问答 | 0 | 22/23 | 是 | partial | 未做 |
| 10fb7dc031075946153baf0a0599e126de29e3a4 | 飞书问答 | 0 | 94/96 | 是 | partial | 未做 |
| d28d86524292506d4b24ae2d486725a6d57a3db3 | 飞书问答 | 0 | 139/141 | 是 | yes | 未做 |
| dd76130ec5fac477123fe8880472d03fbafddef6 | 飞书问答 | 0 | 318/320 | 是 | partial | 未做 |
| 7705dd04acedaefee30d8b2c9978537afb2040dc | 飞书问答 | 0 | 229/232 | 是 | no | 未做 |
| 3355918bbdccac644afe441f085d0ffbbad565d7 | 飞书问答 | 0 | 287/289 | 是 | partial | 未做 |
| 2a564b092916f2fabbfe893cf13de169945ef2e1 | 飞书问答 | 0 | 307/308 | 是 | partial | 未做 |
| 6b9b9e5d154cb963f6d921093539490daa5ebbae | 飞书问答 | 0 | 281/283 | 是 | yes | 未做 |
| d6ea7a30b0b61ae126b00b59d2a14fff2ef887bf | 飞书问答 | 0 | 451/453 | 是 | partial | 未做 |
| b970f48d30775d3468952795bc72976baab3438e | 飞书问答 | 0 | 462/464 | 是 | partial | 未做 |
| 975e60535724f4149c7488699a199ba2920a062c | 飞书问答 | 0 | 474/477 | 是 | no | 未做 |
| 126ff22bfcc14a2f7e1a06a91ba7b646003e9cf0 | 飞书问答 | 0 | 373/375 | 是 | yes | 未做 |
| e6583c60b13b87fc37af75ffc975e7e316d4f4e0 | 飞书问答 | 0 | 379/381 | 是 | yes | 未做 |
| 7cd22ca9e107d2b13a7cc94252aaa9007976b338 | 飞书问答 | 0 | 481/482 | 是 | partial | 未做 |
| ee7e9a948ee6888aa5830b1a3d0d148ff656d864 | 飞书问答 | 0 | 525/526 | 是 | yes | 未做 |
| 01e2d10178347d177519f792f86f25575106ddc7 | 飞书问答 | 0 | 637/638 | 是 | partial | 未做 |
| 021bfb7e180d67112b74f05ecb3fa13acc036c86 | 飞书问答 | 0 | 642/644 | 是 | yes | 未做 |
| 5c3e98e3cebaecd5d3e75ec2c9fc3dd267ac3c83 | 飞书问答 | 0 | 702/703 | 是 | partial | 未做 |
| 14b8ae5656e7d4ee02237288372d9e682b24fdb8 | 飞书问答 | 0 | 719/722 | 是 | partial | 未做 |
| f2155dc4aeab86bf31a838c8ff388c85440fce6e | 飞书问答 | 0 | 800/801 | 是 | yes | 未做 |
| ed6a15f0f7fa4594e51d5bde21cc0c6c1bedbfdc | 飞书问答 | 1 | 812/814 | 是 | no | 未做 |
| 86bf75245358f17e35fc133e46a92439ac86d472 | 飞书问答 | 0 | 821/823 | 是 | yes | 未做 |
| 9132d56e26844dc13b3355448d0f14b95bd2178a | 飞书问答 | 0 | 831/832 | 是 | yes | 未做 |
| 22732cb9476e521452bf0538f3fdb94cf3867651 | 飞书问答 | 0 | 828/830 | 是 | no | 未做 |
| 4e748cb2b5e74d905d9b24b53be6cfdf326e8054 | 飞书问答 | 0 | 856/858 | 是 | no | 未做 |
| 4fa6fbb9df1a4c32583d4ef70d2b29ece4b3d802 | 飞书问答 | 0 | 854/857 | 是 | yes | 未做 |
| 6ca938324dc7e1742a840d0a54dc13cc207394a1 | 飞书问答 | 0 | 861/864 | 是 | partial | 未做 |
| b5bc34e1e381dbf972d0b594fe8c66ff75305d71 | 飞书问答 | 0 | 934/936 | 是 | yes | 未做 |
| af34051bf3e628c1e2a00b110bb84e5f018b419f | 飞书问答 | 0 | 948/950 | 是 | yes | 未做 |
| 6a31db1aca57a818f36bba9002561724655372a7 | 飞书问答 | 1 | 974/975 | 是 | yes | 未做 |
| 50cc6c5f2dcf5fb87b56007f6a825fa7c90b64ed | 飞书问答 | 0 | 87/89 | 否 | partial | 未做 |
| cb6a8c642575d3577d1840ca2f4cd2cc2c3397c5 | 飞书问答 | 0 | 571/574 | 否 | partial | 未做 |
| e3a2d8886f03e78ed5e138df870f48635875727e | 飞书问答 | 0 | 730/732 | 否 | partial | 未做 |
| b1ce129678e37070e69f01332f1a8587e18e06b0 | 飞书问答 | 0 | 742/744 | 否 | partial | 未做 |
| 022c365a14fdec406c7a945a1a18e7e79df37f08 | 飞书问答 | 0 | 943/944 | 否 | no | 未做 |
| 876700622bd6811d903e65314ac75971bbe23dcc | 飞书问答 | 0 | 909/912 | 否 | partial | 未做 |
| 37edc25e39515ffc2d92115d2fcd9e6ceb18898b | 飞书问答 | 0 | 918/920 | 否 | partial | 未做 |

| 阶段 | 上一轮请求/token | 本轮请求/token |
| --- | --- | --- |
| all | 1381 / 7262899 | 1279 / 5890428 |
| extraction | 494 / 2037653 | 494 / 2039478 |
| qa | 586 / 2903461 | 485 / 1513074 |
| judge | 301 / 2321785 | 300 / 2337876 |

| 阶段 | 请求 | 输入token | 输出token | 总token | 缺usage请求 | 累计请求毫秒 |
| --- | --- | --- | --- | --- | --- | --- |
| extraction:extraction | 494 | 1316233 | 723245 | 2039478 | 0 | 2242989 |
| qa:generation | 241 | 1153182 | 35895 | 1189077 | 0 | 322038 |
| qa:answer_review | 199 | 234043 | 15947 | 249990 | 0 | 211639 |
| qa:query_rewrite | 45 | 72731 | 1276 | 74007 | 0 | 37968 |
| judge:answer | 100 | 289445 | 13945 | 303390 | 0 | 131341 |
| judge:memory | 100 | 1672412 | 14794 | 1687206 | 0 | 164112 |
| judge:retrieval | 100 | 338145 | 9135 | 347280 | 0 | 121339 |

本轮1279次真实请求，5890428个已报告token，墙钟24.1分钟。并发请求耗时不可相加当墙钟。计费金额未估算。

评分API格式重评0次、0token；当前评分错误0题。已收到评分JSON末尾单个右括号恢复5条，额外调用0，完整审计保存在机器JSON与原始收据。

完整flat answer系统外层无损规范化5条，额外调用0、额外token为0。只增加systems包装，不更改已有标签、理由或匿名映射；原始与规范JSON的SHA256及收据ID保留在机器JSON。

memory-only未判yes而retrieval-only判yes的隔离评分分歧0个入口案例。本次未发现这类隔离评分分歧。

### 逐题对比

| 题号 | 入口 | 可答 | 旧原始/旧配对/本轮答案 | 旧/新正文保留 | 旧/新参考充分 | 配对变化 | 旧/新状态 | 旧/新生成次数 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1be54c5b3ea67d837ffba2290a40c1e720d9587f | 桌面 | 是 | no/no/partial | yes/yes | yes/yes | still_unsuccessful | unknown/answered | 2/1 |
| 1be54c5b3ea67d837ffba2290a40c1e720d9587f | 飞书问答 | 是 | yes/partial/partial | yes/yes | yes/yes | still_unsuccessful | answered/answered | 1/1 |
| 584af673429c7f8621c6bf83362a37048daa0e5d | 桌面 | 是 | partial/yes/yes | yes/yes | partial/yes | retained_success | answered/answered | 1/1 |
| 584af673429c7f8621c6bf83362a37048daa0e5d | 飞书问答 | 是 | partial/partial/yes | yes/yes | partial/yes | new_success | answered/answered | 1/1 |
| c37f65c9f0d543a35c784263b79236ccf1c44fac | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| c37f65c9f0d543a35c784263b79236ccf1c44fac | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| b08f88d1facefceb87e134ba2c1fa90035018e83 | 桌面 | 是 | no/no/no | no/no | no/no | still_unsuccessful | unknown/unknown | 2/2 |
| b08f88d1facefceb87e134ba2c1fa90035018e83 | 飞书问答 | 是 | no/no/no | no/no | no/no | still_unsuccessful | unknown/unknown | 2/2 |
| 747b847d687f703cc20a87877c5b138f26ff137d | 桌面 | 是 | partial/partial/partial | yes/yes | yes/yes | still_unsuccessful | answered/answered | 1/1 |
| 747b847d687f703cc20a87877c5b138f26ff137d | 飞书问答 | 是 | partial/partial/yes | yes/yes | yes/yes | new_success | answered/answered | 1/1 |
| 111afb77cfbf4c98e0458606378fa63a0e965e36 | 桌面 | 是 | partial/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 111afb77cfbf4c98e0458606378fa63a0e965e36 | 飞书问答 | 是 | partial/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 50cc6c5f2dcf5fb87b56007f6a825fa7c90b64ed | 桌面 | 是 | yes/partial/partial | yes/yes | yes/yes | still_unsuccessful | answered/answered | 1/1 |
| 50cc6c5f2dcf5fb87b56007f6a825fa7c90b64ed | 飞书问答 | 是 | no/partial/partial | yes/yes | yes/yes | still_unsuccessful | answered/answered | 1/1 |
| 6bf5620f295b5243230bc97b340fae6e92304595 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 6bf5620f295b5243230bc97b340fae6e92304595 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 55bd59076a49b19d3283af41c5e3ccb875f3eb0c | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 55bd59076a49b19d3283af41c5e3ccb875f3eb0c | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 5daeb8d4d6f3b8543ec6309a7a35523e160437eb | 桌面 | 是 | partial/partial/yes | yes/yes | yes/yes | new_success | partial/answered | 2/1 |
| 5daeb8d4d6f3b8543ec6309a7a35523e160437eb | 飞书问答 | 是 | partial/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 521280a87c43fcdf9f577da235e7072a23f0673e | 桌面 | 是 | partial/partial/yes | yes/yes | yes/yes | new_success | partial/answered | 2/1 |
| 521280a87c43fcdf9f577da235e7072a23f0673e | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 5a8cc8f80509ea77d8213ed28c5ead501c68c725 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 5a8cc8f80509ea77d8213ed28c5ead501c68c725 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 10fb7dc031075946153baf0a0599e126de29e3a4 | 桌面 | 是 | partial/partial/partial | partial/partial | yes/partial | still_unsuccessful | partial/answered | 2/1 |
| 10fb7dc031075946153baf0a0599e126de29e3a4 | 飞书问答 | 是 | yes/yes/partial | partial/partial | yes/partial | regression | answered/answered | 2/1 |
| c5b0ed5db65051eebd858beaf303809aa815e8e5 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| c5b0ed5db65051eebd858beaf303809aa815e8e5 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 7ab9c0b4ceca1c142ff068f85015a249b14282d0 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 7ab9c0b4ceca1c142ff068f85015a249b14282d0 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| d28d86524292506d4b24ae2d486725a6d57a3db3 | 桌面 | 是 | no/no/yes | yes/yes | yes/yes | new_success | unknown/answered | 2/2 |
| d28d86524292506d4b24ae2d486725a6d57a3db3 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 63488da6c7aff9e374561a24ba224e9ce7f65e40 | 桌面 | 否 | yes/yes/yes | no/no | no/no | retained_success | unknown/unknown | 2/2 |
| 63488da6c7aff9e374561a24ba224e9ce7f65e40 | 飞书问答 | 否 | yes/yes/yes | no/no | no/no | retained_success | unknown/unknown | 2/2 |
| c1c44fd96c3fa6e16949ae8fa453e511c6435c68 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| c1c44fd96c3fa6e16949ae8fa453e511c6435c68 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| feafcc1c4026d7f55a2c8ce7850d7e12030b5c22 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 2/1 |
| feafcc1c4026d7f55a2c8ce7850d7e12030b5c22 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| dd76130ec5fac477123fe8880472d03fbafddef6 | 桌面 | 是 | partial/partial/partial | yes/yes | no/partial | still_unsuccessful | answered/answered | 1/1 |
| dd76130ec5fac477123fe8880472d03fbafddef6 | 飞书问答 | 是 | partial/partial/partial | yes/yes | no/partial | still_unsuccessful | answered/answered | 1/1 |
| 78292bc57ee68fdb93ed45430d80acca25a9e916 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 78292bc57ee68fdb93ed45430d80acca25a9e916 | 飞书问答 | 是 | yes/partial/yes | yes/yes | yes/yes | new_success | answered/answered | 1/1 |
| 2ea4347f1992b0b3958c4844681ff0fe4d0dd1dd | 桌面 | 是 | partial/partial/partial | yes/yes | partial/partial | still_unsuccessful | partial/answered | 2/1 |
| 2ea4347f1992b0b3958c4844681ff0fe4d0dd1dd | 飞书问答 | 是 | partial/partial/partial | yes/yes | partial/partial | still_unsuccessful | partial/partial | 2/2 |
| 7705dd04acedaefee30d8b2c9978537afb2040dc | 桌面 | 是 | no/no/no | partial/partial | no/no | still_unsuccessful | unknown/answered | 2/2 |
| 7705dd04acedaefee30d8b2c9978537afb2040dc | 飞书问答 | 是 | no/no/no | partial/partial | no/no | still_unsuccessful | unknown/answered | 2/1 |
| 784ce5a983c5f2cc95a2c60ce66f2a8a50f3636f | 桌面 | 是 | no/no/partial | no/no | no/no | still_unsuccessful | unknown/partial | 2/2 |
| 784ce5a983c5f2cc95a2c60ce66f2a8a50f3636f | 飞书问答 | 是 | no/no/no | no/no | no/no | still_unsuccessful | unknown/unknown | 2/2 |
| 7595260c5747aede0b32b7414e13899869209506 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 7595260c5747aede0b32b7414e13899869209506 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| ef3567ce7301b28e34377e7b62c4ec9b496f00bf | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| ef3567ce7301b28e34377e7b62c4ec9b496f00bf | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 3355918bbdccac644afe441f085d0ffbbad565d7 | 桌面 | 是 | partial/partial/partial | yes/partial | partial/partial | still_unsuccessful | partial/answered | 2/1 |
| 3355918bbdccac644afe441f085d0ffbbad565d7 | 飞书问答 | 是 | partial/partial/partial | yes/partial | partial/partial | still_unsuccessful | answered/answered | 1/1 |
| 0d34c0812f1e69ea33f76ca8c24c23b0415ebc8d | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 0d34c0812f1e69ea33f76ca8c24c23b0415ebc8d | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| cf171fad0bea5ab985c53d11e48e7883c23cdc44 | 桌面 | 是 | yes/partial/yes | yes/yes | partial/yes | new_success | answered/answered | 1/1 |
| cf171fad0bea5ab985c53d11e48e7883c23cdc44 | 飞书问答 | 是 | yes/partial/yes | yes/yes | partial/yes | new_success | answered/answered | 1/1 |
| 2a564b092916f2fabbfe893cf13de169945ef2e1 | 桌面 | 是 | partial/partial/yes | yes/yes | partial/partial | new_success | partial/answered | 2/1 |
| 2a564b092916f2fabbfe893cf13de169945ef2e1 | 飞书问答 | 是 | yes/yes/partial | yes/yes | yes/partial | regression | answered/answered | 1/1 |
| bc4dca3e1e83f3b4bbb53a31557fc5d8971603b2 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| bc4dca3e1e83f3b4bbb53a31557fc5d8971603b2 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 6b9b9e5d154cb963f6d921093539490daa5ebbae | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | partial/answered | 2/1 |
| 6b9b9e5d154cb963f6d921093539490daa5ebbae | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 6844683935d0d8f588fa06530f5068bf3e1ed0c0 | 桌面 | 是 | no/no/yes | yes/yes | yes/yes | new_success | unknown/answered | 2/1 |
| 6844683935d0d8f588fa06530f5068bf3e1ed0c0 | 飞书问答 | 是 | no/no/yes | yes/yes | yes/yes | new_success | unknown/partial | 2/2 |
| f903396d943541a8cc65edefb04ca37814ed30dd | 桌面 | 否 | yes/yes/yes | no/no | no/no | retained_success | unknown/unknown | 2/2 |
| f903396d943541a8cc65edefb04ca37814ed30dd | 飞书问答 | 否 | yes/yes/yes | no/no | no/no | retained_success | unknown/unknown | 2/2 |
| d6ea7a30b0b61ae126b00b59d2a14fff2ef887bf | 桌面 | 是 | yes/partial/partial | partial/partial | partial/partial | still_unsuccessful | answered/answered | 1/1 |
| d6ea7a30b0b61ae126b00b59d2a14fff2ef887bf | 飞书问答 | 是 | yes/partial/partial | partial/partial | partial/partial | still_unsuccessful | answered/answered | 1/1 |
| b970f48d30775d3468952795bc72976baab3438e | 桌面 | 是 | no/no/partial | partial/partial | no/no | still_unsuccessful | unknown/answered | 2/1 |
| b970f48d30775d3468952795bc72976baab3438e | 飞书问答 | 是 | no/partial/partial | partial/partial | no/no | still_unsuccessful | answered/answered | 1/1 |
| 975e60535724f4149c7488699a199ba2920a062c | 桌面 | 否 | no/no/no | no/no | no/no | still_unsuccessful | partial/answered | 2/1 |
| 975e60535724f4149c7488699a199ba2920a062c | 飞书问答 | 否 | no/no/no | no/no | no/no | still_unsuccessful | answered/answered | 2/1 |
| 126ff22bfcc14a2f7e1a06a91ba7b646003e9cf0 | 桌面 | 是 | yes/partial/yes | yes/yes | yes/yes | new_success | partial/answered | 2/1 |
| 126ff22bfcc14a2f7e1a06a91ba7b646003e9cf0 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 7e4ef0a4debc048b244b61b4f7dc2518b5b466c0 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 7e4ef0a4debc048b244b61b4f7dc2518b5b466c0 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 627b8d7b5b985394428c974aca5ba0c1bbbba377 | 桌面 | 否 | yes/yes/yes | no/no | no/no | retained_success | unknown/unknown | 2/2 |
| 627b8d7b5b985394428c974aca5ba0c1bbbba377 | 飞书问答 | 否 | yes/yes/yes | no/no | no/no | retained_success | unknown/unknown | 2/2 |
| deb89bca0925657e0f91ab5daca78b9e548de2bd | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| deb89bca0925657e0f91ab5daca78b9e548de2bd | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 9c33b340aefbc1f15b6eb6fb3e23ee615ce5b570 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 9c33b340aefbc1f15b6eb6fb3e23ee615ce5b570 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| f9f59c171531c452bd2767dc332dc74cadee5120 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| f9f59c171531c452bd2767dc332dc74cadee5120 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| e6583c60b13b87fc37af75ffc975e7e316d4f4e0 | 桌面 | 是 | no/no/yes | yes/yes | yes/yes | new_success | unknown/answered | 2/1 |
| e6583c60b13b87fc37af75ffc975e7e316d4f4e0 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 2/1 |
| a253749e3b4c4f340778235f640ce694642a4555 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| a253749e3b4c4f340778235f640ce694642a4555 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 2da4c3679111dd92a1d0869dae353ebe5989dfd2 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 2da4c3679111dd92a1d0869dae353ebe5989dfd2 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 1142784dc4e0e4c0b4eca1feaf1c10dc46dd5891 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 1142784dc4e0e4c0b4eca1feaf1c10dc46dd5891 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| f85f2a532e7e700d9f8f9c09cd08d4e47b87bdd3 | 桌面 | 是 | partial/partial/no | partial/partial | yes/partial | still_unsuccessful | partial/unknown | 2/2 |
| f85f2a532e7e700d9f8f9c09cd08d4e47b87bdd3 | 飞书问答 | 是 | partial/partial/partial | partial/partial | yes/partial | still_unsuccessful | answered/partial | 1/2 |
| adbf33c6144b2f5c40d0c6a328a92687a476f371 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| adbf33c6144b2f5c40d0c6a328a92687a476f371 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| f7a89b9cd2792f23f2cb43d50a01b8218a6fbb24 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| f7a89b9cd2792f23f2cb43d50a01b8218a6fbb24 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 7cd22ca9e107d2b13a7cc94252aaa9007976b338 | 桌面 | 是 | no/no/partial | yes/yes | yes/yes | still_unsuccessful | unknown/answered | 2/1 |
| 7cd22ca9e107d2b13a7cc94252aaa9007976b338 | 飞书问答 | 是 | partial/partial/partial | yes/yes | yes/yes | still_unsuccessful | answered/answered | 1/1 |
| 1591068b747c94f45b948e12edafe74b5e721047 | 桌面 | 是 | no/no/no | yes/yes | no/no | still_unsuccessful | unknown/unknown | 2/2 |
| 1591068b747c94f45b948e12edafe74b5e721047 | 飞书问答 | 是 | no/no/partial | yes/yes | no/no | still_unsuccessful | unknown/partial | 2/2 |
| ee7e9a948ee6888aa5830b1a3d0d148ff656d864 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| ee7e9a948ee6888aa5830b1a3d0d148ff656d864 | 飞书问答 | 是 | no/no/yes | yes/yes | yes/yes | new_success | unknown/answered | 2/1 |
| 506d21501d54a12d0c9fd3dbbf19067802439a04 | 桌面 | 是 | partial/partial/no | partial/partial | yes/partial | still_unsuccessful | partial/unknown | 2/2 |
| 506d21501d54a12d0c9fd3dbbf19067802439a04 | 飞书问答 | 是 | partial/partial/no | partial/partial | yes/partial | still_unsuccessful | answered/unknown | 1/2 |
| 0689904db9b00a814e3109fb1698086370a28fa2 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 0689904db9b00a814e3109fb1698086370a28fa2 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 6cd25c637c6b772ce29e8ee81571e8694549c5ab | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 6cd25c637c6b772ce29e8ee81571e8694549c5ab | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| cb6a8c642575d3577d1840ca2f4cd2cc2c3397c5 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| cb6a8c642575d3577d1840ca2f4cd2cc2c3397c5 | 飞书问答 | 是 | partial/partial/partial | yes/yes | yes/yes | still_unsuccessful | answered/answered | 1/1 |
| c2e475adeddcdc4d637ef0d4f5065b6a9b299827 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| c2e475adeddcdc4d637ef0d4f5065b6a9b299827 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 56b7319be68197727baa7d498fa38af0a8440fe4 | 桌面 | 是 | no/no/partial | partial/partial | partial/partial | still_unsuccessful | unknown/answered | 2/2 |
| 56b7319be68197727baa7d498fa38af0a8440fe4 | 飞书问答 | 是 | partial/partial/partial | partial/partial | partial/partial | still_unsuccessful | answered/partial | 2/2 |
| a1ac2a152710335519c9a907eec60d9f468b19db | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| a1ac2a152710335519c9a907eec60d9f468b19db | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| c0bee6539eb6956a7347daa9d2419b367bd02064 | 桌面 | 是 | partial/no/yes | yes/yes | partial/yes | new_success | answered/answered | 2/1 |
| c0bee6539eb6956a7347daa9d2419b367bd02064 | 飞书问答 | 是 | partial/no/yes | yes/yes | partial/yes | new_success | answered/answered | 2/1 |
| 3de0487276bb5961586acc6e9f82934ef8cb668c | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 3de0487276bb5961586acc6e9f82934ef8cb668c | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 6b53e1f46ae4ba9b75117fc6e593abded89366be | 桌面 | 是 | yes/yes/partial | yes/yes | yes/partial | regression | answered/answered | 2/1 |
| 6b53e1f46ae4ba9b75117fc6e593abded89366be | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 2/2 |
| 01e2d10178347d177519f792f86f25575106ddc7 | 桌面 | 是 | partial/partial/partial | yes/yes | yes/partial | still_unsuccessful | partial/answered | 2/1 |
| 01e2d10178347d177519f792f86f25575106ddc7 | 飞书问答 | 是 | partial/partial/partial | yes/yes | partial/partial | still_unsuccessful | answered/answered | 1/1 |
| 021bfb7e180d67112b74f05ecb3fa13acc036c86 | 桌面 | 是 | yes/yes/yes | yes/yes | partial/yes | retained_success | answered/answered | 1/1 |
| 021bfb7e180d67112b74f05ecb3fa13acc036c86 | 飞书问答 | 是 | yes/yes/yes | yes/yes | partial/yes | retained_success | answered/answered | 1/1 |
| 5c3e98e3cebaecd5d3e75ec2c9fc3dd267ac3c83 | 桌面 | 是 | partial/partial/partial | yes/yes | partial/partial | still_unsuccessful | partial/answered | 2/1 |
| 5c3e98e3cebaecd5d3e75ec2c9fc3dd267ac3c83 | 飞书问答 | 是 | partial/partial/partial | yes/yes | no/partial | still_unsuccessful | answered/answered | 2/1 |
| 62f27fe08ddb67f16857fab2a8a721926ecbb6fb | 桌面 | 是 | yes/yes/yes | yes/yes | yes/partial | retained_success | answered/answered | 1/1 |
| 62f27fe08ddb67f16857fab2a8a721926ecbb6fb | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/partial | retained_success | answered/answered | 1/1 |
| 14b8ae5656e7d4ee02237288372d9e682b24fdb8 | 桌面 | 是 | partial/yes/yes | yes/yes | yes/partial | retained_success | answered/answered | 1/1 |
| 14b8ae5656e7d4ee02237288372d9e682b24fdb8 | 飞书问答 | 是 | partial/partial/partial | yes/yes | yes/partial | still_unsuccessful | answered/answered | 1/1 |
| e3a2d8886f03e78ed5e138df870f48635875727e | 桌面 | 是 | yes/partial/partial | yes/yes | yes/yes | still_unsuccessful | partial/answered | 2/1 |
| e3a2d8886f03e78ed5e138df870f48635875727e | 飞书问答 | 是 | yes/partial/partial | yes/yes | yes/yes | still_unsuccessful | answered/answered | 1/1 |
| 4e1a67f8dc68b55a5ce18e6cd385ae9ab90d891f | 桌面 | 是 | partial/yes/yes | no/no | no/no | retained_success | answered/answered | 1/1 |
| 4e1a67f8dc68b55a5ce18e6cd385ae9ab90d891f | 飞书问答 | 是 | no/no/no | no/no | no/partial | still_unsuccessful | unknown/unknown | 2/2 |
| 6c96e910bd98c9fd58ba2050f99b9c9bac69840a | 桌面 | 否 | yes/yes/yes | no/no | no/no | retained_success | unknown/unknown | 2/2 |
| 6c96e910bd98c9fd58ba2050f99b9c9bac69840a | 飞书问答 | 否 | yes/yes/yes | no/no | no/no | retained_success | unknown/unknown | 2/2 |
| bfbd6040cb95b179118557352e8e3899ef25c525 | 桌面 | 否 | yes/yes/yes | no/no | no/no | retained_success | unknown/unknown | 2/2 |
| bfbd6040cb95b179118557352e8e3899ef25c525 | 飞书问答 | 否 | yes/yes/yes | no/no | no/no | retained_success | unknown/unknown | 2/2 |
| d6e353e0231d09fd5dcba493544d53706f3fe1ab | 桌面 | 是 | partial/partial/no | yes/yes | partial/no | still_unsuccessful | partial/unknown | 2/2 |
| d6e353e0231d09fd5dcba493544d53706f3fe1ab | 飞书问答 | 是 | partial/partial/no | yes/yes | partial/no | still_unsuccessful | partial/unknown | 2/2 |
| b1ce129678e37070e69f01332f1a8587e18e06b0 | 桌面 | 是 | no/no/no | yes/yes | yes/yes | still_unsuccessful | answered/answered | 2/1 |
| b1ce129678e37070e69f01332f1a8587e18e06b0 | 飞书问答 | 是 | no/no/partial | yes/yes | yes/yes | still_unsuccessful | answered/answered | 2/1 |
| 4c07c33dfaf4f3e6db55e377da6fa69825d0ba15 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 4c07c33dfaf4f3e6db55e377da6fa69825d0ba15 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 9b76f428b7c8c9fc930aa88ee585a03478bff9b3 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 9b76f428b7c8c9fc930aa88ee585a03478bff9b3 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| f2e8497aa16327aa297a7f9f7d156e485fe33945 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| f2e8497aa16327aa297a7f9f7d156e485fe33945 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 2916bbdb95ef31ab26527ba67961cf5ec94d6afe | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 2916bbdb95ef31ab26527ba67961cf5ec94d6afe | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 6f024d4c952fbb53b6f8cf27020659aa4d9a6590 | 桌面 | 否 | yes/yes/yes | no/no | no/no | retained_success | unknown/unknown | 1/1 |
| 6f024d4c952fbb53b6f8cf27020659aa4d9a6590 | 飞书问答 | 否 | yes/yes/yes | no/no | no/no | retained_success | unknown/unknown | 1/1 |
| f2155dc4aeab86bf31a838c8ff388c85440fce6e | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 2/2 |
| f2155dc4aeab86bf31a838c8ff388c85440fce6e | 飞书问答 | 是 | partial/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| ed6a15f0f7fa4594e51d5bde21cc0c6c1bedbfdc | 桌面 | 是 | no/no/no | yes/yes | no/partial | still_unsuccessful | unknown/unknown | 2/2 |
| ed6a15f0f7fa4594e51d5bde21cc0c6c1bedbfdc | 飞书问答 | 是 | partial/partial/no | yes/yes | partial/partial | still_unsuccessful | partial/answered | 2/2 |
| 86bf75245358f17e35fc133e46a92439ac86d472 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 2/2 |
| 86bf75245358f17e35fc133e46a92439ac86d472 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 9132d56e26844dc13b3355448d0f14b95bd2178a | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 9132d56e26844dc13b3355448d0f14b95bd2178a | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 22732cb9476e521452bf0538f3fdb94cf3867651 | 桌面 | 否 | yes/yes/no | no/no | no/no | regression | unknown/answered | 2/1 |
| 22732cb9476e521452bf0538f3fdb94cf3867651 | 飞书问答 | 否 | no/no/no | no/no | no/no | still_unsuccessful | answered/answered | 1/1 |
| bbb77f2d6685c9257763ca38afaaef29044b4018 | 桌面 | 是 | no/no/no | yes/yes | no/partial | still_unsuccessful | unknown/unknown | 2/2 |
| bbb77f2d6685c9257763ca38afaaef29044b4018 | 飞书问答 | 是 | no/no/no | yes/yes | no/partial | still_unsuccessful | unknown/unknown | 2/2 |
| 4e748cb2b5e74d905d9b24b53be6cfdf326e8054 | 桌面 | 否 | no/no/no | no/no | no/no | still_unsuccessful | partial/answered | 2/1 |
| 4e748cb2b5e74d905d9b24b53be6cfdf326e8054 | 飞书问答 | 否 | no/no/no | no/no | no/no | still_unsuccessful | answered/answered | 1/1 |
| 4d47bef19afd70c10bbceafd1846516546641a2f | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 4d47bef19afd70c10bbceafd1846516546641a2f | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 4fa6fbb9df1a4c32583d4ef70d2b29ece4b3d802 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | partial/answered | 2/1 |
| 4fa6fbb9df1a4c32583d4ef70d2b29ece4b3d802 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 6ca938324dc7e1742a840d0a54dc13cc207394a1 | 桌面 | 是 | yes/partial/partial | yes/yes | yes/partial | still_unsuccessful | partial/answered | 2/1 |
| 6ca938324dc7e1742a840d0a54dc13cc207394a1 | 飞书问答 | 是 | partial/partial/partial | yes/yes | partial/partial | still_unsuccessful | answered/answered | 1/1 |
| 20e38438471266ce021817c6364f6a46d01564f2 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 20e38438471266ce021817c6364f6a46d01564f2 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 72f7ef55e150e16dcf97fe443aff9971a32414ef | 桌面 | 是 | no/no/yes | yes/yes | yes/yes | new_success | unknown/answered | 2/1 |
| 72f7ef55e150e16dcf97fe443aff9971a32414ef | 飞书问答 | 是 | no/no/yes | yes/yes | yes/yes | new_success | unknown/partial | 2/2 |
| 23b2901264bda91045258b5d4120879ae292e950 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | partial/answered | 2/2 |
| 23b2901264bda91045258b5d4120879ae292e950 | 飞书问答 | 是 | partial/partial/yes | yes/yes | yes/yes | new_success | answered/answered | 2/2 |
| b5bc34e1e381dbf972d0b594fe8c66ff75305d71 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 2/1 |
| b5bc34e1e381dbf972d0b594fe8c66ff75305d71 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 022c365a14fdec406c7a945a1a18e7e79df37f08 | 桌面 | 是 | partial/no/no | yes/yes | partial/no | still_unsuccessful | answered/answered | 1/1 |
| 022c365a14fdec406c7a945a1a18e7e79df37f08 | 飞书问答 | 是 | partial/no/no | yes/yes | partial/no | still_unsuccessful | answered/answered | 1/1 |
| af34051bf3e628c1e2a00b110bb84e5f018b419f | 桌面 | 是 | yes/yes/yes | yes/yes | partial/partial | retained_success | answered/answered | 1/1 |
| af34051bf3e628c1e2a00b110bb84e5f018b419f | 飞书问答 | 是 | yes/yes/yes | yes/yes | partial/partial | retained_success | answered/answered | 1/1 |
| 876700622bd6811d903e65314ac75971bbe23dcc | 桌面 | 是 | no/no/partial | yes/yes | yes/partial | still_unsuccessful | error_or_missing/answered | 1/1 |
| 876700622bd6811d903e65314ac75971bbe23dcc | 飞书问答 | 是 | partial/partial/partial | yes/yes | yes/partial | still_unsuccessful | answered/answered | 1/1 |
| 37edc25e39515ffc2d92115d2fcd9e6ceb18898b | 桌面 | 是 | partial/partial/partial | yes/yes | yes/yes | still_unsuccessful | partial/answered | 2/1 |
| 37edc25e39515ffc2d92115d2fcd9e6ceb18898b | 飞书问答 | 是 | partial/partial/partial | yes/yes | yes/yes | still_unsuccessful | answered/answered | 1/1 |
| e44a6bf67ce3fde0c6608b150030e44d87eb25e3 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| e44a6bf67ce3fde0c6608b150030e44d87eb25e3 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 6a31db1aca57a818f36bba9002561724655372a7 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | partial/answered | 2/2 |
| 6a31db1aca57a818f36bba9002561724655372a7 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 2/2 |
| 37a79be0148e1751ffb2daabe4c8ec6680036106 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 37a79be0148e1751ffb2daabe4c8ec6680036106 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |

## 确定性检查与门槛

确定性检查通过，11条命令。评分规则指纹和源码/二进制指纹保存在机器JSON。

| 命令 | 退出码 | 日志 |
| --- | --- | --- |
| cargo.exe test -p project-assistant-core --locked | 0 | .local-data\qa-efficient-regressions-gtMExO\1.log |
| cargo.exe clippy -p project-assistant-core --locked --lib --tests -- -D warnings | 0 | .local-data\qa-efficient-regressions-gtMExO\2.log |
| cargo.exe build -p project-assistant-core --bin pm-host --locked | 0 | .local-data\qa-efficient-regressions-gtMExO\3.log |
| powershell.exe -NoProfile -Command npm run build | 0 | .local-data\qa-efficient-regressions-gtMExO\4.log |
| node.exe --test scripts/check-memory-public-development.test.mjs scripts/check-memory-qa-efficient-development.test.mjs scripts/check-memory-retrieval-development.test.mjs scripts/evaluate-memory-quality.test.mjs scripts/memory-public-live-options.test.mjs scripts/memory-qa-efficient-evaluation.test.mjs scripts/report-memory-extraction-optimized.test.mjs scripts/report-memory-qa-efficient.test.mjs scripts/report-memory-retrieval-optimized.test.mjs scripts/score-memory-public-live.test.mjs | 0 | .local-data\qa-efficient-regressions-gtMExO\5.log |
| node.exe scripts/verify-restart.mjs | 0 | .local-data\qa-efficient-regressions-gtMExO\6.log |
| node.exe scripts/verify-extraction-recovery.mjs | 0 | .local-data\qa-efficient-regressions-gtMExO\7.log |
| node.exe scripts/verify-memory-public-live.mjs --no-write | 0 | .local-data\qa-efficient-regressions-gtMExO\8.log |
| node.exe scripts/verify-memory-public-live.mjs docs/memory-public-live-retrieval-dev-v2-results.json --no-write | 0 | .local-data\qa-efficient-regressions-gtMExO\9.log |
| node.exe scripts/verify-memory-public-live.mjs docs/memory-public-live-retrieval-full-results.json --no-write | 0 | .local-data\qa-efficient-regressions-gtMExO\10.log |
| cargo.exe test -p project-assistant-core --lib --locked diagnose_public_live_retrieval -- --ignored --nocapture | 0 | .local-data\qa-efficient-regressions-gtMExO\11.log |

| 门槛 | 通过 | 实际观测 |
| --- | --- | --- |
| frozen_development_scope | 是 | {"papers":6,"questions":20,"answerable":19,"unanswerable":1} |
| complete_run | 是 | {"complete":true,"haltReason":null} |
| extraction_jobs_completed | 是 | 6 |
| nonempty_confirmed_memory_per_paper | 是 | [{"id":"1603.01514","memories":129},{"id":"1902.09666","memories":77},{"id":"1806.00738","memories":50},{"id":"1908.07245","memories":72},{"id":"1902.09243","memories":134},{"id":"1705.01214","memories":482}] |
| integrity_verified | 是 | [{"file":"docs/memory-public-live-qa-efficient-dev-v2-results.json","passed":true}] |
| deterministic_regressions_passed | 是 | [{"command":"cargo.exe test -p project-assistant-core --locked","exitCode":0,"elapsedMs":74796,"log":".local-data\\qa-efficient-regressions-gtMExO\\1.log"},{"command":"cargo.exe clippy -p project-assistant-core --locked --lib --tests -- -D warnings","exitCode":0,"elapsedMs":760,"log":".local-data\\qa-efficient-regressions-gtMExO\\2.log"},{"command":"cargo.exe build -p project-assistant-core --bin pm-host --locked","exitCode":0,"elapsedMs":631,"log":".local-data\\qa-efficient-regressions-gtMExO\\3.log"},{"command":"powershell.exe -NoProfile -Command npm run build","exitCode":0,"elapsedMs":11973,"log":".local-data\\qa-efficient-regressions-gtMExO\\4.log"},{"command":"node.exe --test scripts/check-memory-public-development.test.mjs scripts/check-memory-qa-efficient-development.test.mjs scripts/check-memory-retrieval-development.test.mjs scripts/evaluate-memory-quality.test.mjs scripts/memory-public-live-options.test.mjs scripts/memory-qa-efficient-evaluation.test.mjs scripts/report-memory-extraction-optimized.test.mjs scripts/report-memory-qa-efficient.test.mjs scripts/report-memory-retrieval-optimized.test.mjs scripts/score-memory-public-live.test.mjs","exitCode":0,"elapsedMs":414,"log":".local-data\\qa-efficient-regressions-gtMExO\\5.log"},{"command":"node.exe scripts/verify-restart.mjs","exitCode":0,"elapsedMs":3503,"log":".local-data\\qa-efficient-regressions-gtMExO\\6.log"},{"command":"node.exe scripts/verify-extraction-recovery.mjs","exitCode":0,"elapsedMs":4184,"log":".local-data\\qa-efficient-regressions-gtMExO\\7.log"},{"command":"node.exe scripts/verify-memory-public-live.mjs --no-write","exitCode":0,"elapsedMs":733,"log":".local-data\\qa-efficient-regressions-gtMExO\\8.log"},{"command":"node.exe scripts/verify-memory-public-live.mjs docs/memory-public-live-retrieval-dev-v2-results.json --no-write","exitCode":0,"elapsedMs":375,"log":".local-data\\qa-efficient-regressions-gtMExO\\9.log"},{"command":"node.exe scripts/verify-memory-public-live.mjs docs/memory-public-live-retrieval-full-results.json --no-write","exitCode":0,"elapsedMs":1254,"log":".local-data\\qa-efficient-regressions-gtMExO\\10.log"},{"command":"cargo.exe test -p project-assistant-core --lib --locked diagnose_public_live_retrieval -- --ignored --nocapture","exitCode":0,"elapsedMs":9519,"log":".local-data\\qa-efficient-regressions-gtMExO\\11.log"}] |
| no_cross_project_citations | 是 | 0 |
| all_isolated_judgments_available | 是 | 20 |
| question_information_retained | 是 | 18 |
| desktop_complete_answers | 是 | 13 |
| desktop_correct_abstention | 是 | 1 |
| connector_complete_answers | 是 | 14 |
| connector_correct_abstention | 是 | 1 |
| qa_efficient_registered_thresholds | 是 | {"retainedYesOrPartial":15,"desktopComplete":11,"connectorComplete":13,"desktopReferencesSufficient":15,"connectorReferencesSufficient":15,"desktopCorrectAbstention":1,"connectorCorrectAbstention":1,"desktopPairedNetImprovement":1,"connectorPairedNetImprovement":0,"combinedPairedNetImprovement":2,"maxQaProtocolErrors":0,"maxSupplementProtocolFailures":1,"minQaTokenReductionFraction":0.15,"maxCombinedQaTokens":439346} |
| registration_and_tests_before_development | 是 | {"registration":"2026-10-20T14:18:33.793Z","tests":"2026-10-20T14:53:28.618Z","live":"2026-10-20T14:53:38.701Z"} |
| registered_dataset_model_and_previous_baseline | 是 | {"file":"docs\\memory-public-live-retrieval-dev-v2-results.json","workspace":".local-data\\public-memory-live-RRTTuu","binarySha256":"5b86a9f0fe696084e5eae15371d936424ab43d35c2ee6dcc16bb8f6a8c2526b0"} |
| same_twenty_development_questions | 是 | ["747b847d687f703cc20a87877c5b138f26ff137d","111afb77cfbf4c98e0458606378fa63a0e965e36","50cc6c5f2dcf5fb87b56007f6a825fa7c90b64ed","6bf5620f295b5243230bc97b340fae6e92304595","55bd59076a49b19d3283af41c5e3ccb875f3eb0c","5daeb8d4d6f3b8543ec6309a7a35523e160437eb","521280a87c43fcdf9f577da235e7072a23f0673e","5a8cc8f80509ea77d8213ed28c5ead501c68c725","1be54c5b3ea67d837ffba2290a40c1e720d9587f","584af673429c7f8621c6bf83362a37048daa0e5d","c37f65c9f0d543a35c784263b79236ccf1c44fac","b08f88d1facefceb87e134ba2c1fa90035018e83","10fb7dc031075946153baf0a0599e126de29e3a4","c5b0ed5db65051eebd858beaf303809aa815e8e5","7ab9c0b4ceca1c142ff068f85015a249b14282d0","d28d86524292506d4b24ae2d486725a6d57a3db3","63488da6c7aff9e374561a24ba224e9ce7f65e40","c1c44fd96c3fa6e16949ae8fa453e511c6435c68","feafcc1c4026d7f55a2c8ce7850d7e12030b5c22","dd76130ec5fac477123fe8880472d03fbafddef6"] |
| extraction_sources_unchanged | 是 | {"ai.rs":"3955214b5d9eb0b4a427f40e9c3fd954eac4835b24687924a83980426d38f17e","answer_contract.rs":"30ddea16243de153f0281db1eb62c9194b5b2d2053901078a24d8c6a04f4c3e2","assistant_qa.rs":"2f4aa507c9eced426a04e1ac4b67f8622904d076160a0018d417cbbe269a6a1c","backup.rs":"54df70f761956d2096622f3e20e14905484206f3d1a67b23f278780b1ec07a9e","bin\\pm-host.rs":"eb36bfd48207dca3b9694efd5bcde70316c466746c736efbeba99e40521937aa","change_control.rs":"9e8bf7c92d5ec3cb30e8d48c4411a4684169952d5d2c803478b04e37fdb014b2","coordination.rs":"551852f9918597e85407fd2d10647e5a7ea52df3a8bfdf604d62c3267210a703","db.rs":"9d2504455d03b8493be24f51fb30ad64013b6a0faeb43a3c687a160121704319","delivery.rs":"3036ea1f332c6a757946df25c48ec682211e188a1ca10065bbf5548e99a0aa49","extraction_store.rs":"013aa5df7efe9051bdab8c96d0084e37ffd4a3c33ca6a1e12f3fb51a3a9aecbc","feishu.rs":"f909f9368448aee02312b32130b319e45bd3b0a2e558dfb680cdec16ab28a6d1","feishu\\knowledge.rs":"b98b21b69564801a09ef5bf005e217c164e0d3b323bbf6662f31c1380147fdf4","governance.rs":"fbc8b6bdc3b5d619f806433967ef561370a6801c357911e2421a47a1eaf2e180","lib.rs":"c7aa2928ec0bdce1cbbded3a16a288b0d0db3e0017805c49fd620bfdf3a0f681","maintenance.rs":"797fa3deb63fa364efecc8e84627a45564985f4b1b7e733847fbce2db2a7f907","management.rs":"3ef4b58e1c5e09ca728157797192d6d6fcf8a27fda375d918e8b6b80124a6aad","memory.rs":"d0fd214f460c5e217c8720355754d2e66138922da0d1a00ded4dd6a7d35afea8","memory_evaluation.rs":"d229ba9f7a5110747bf2e536bc48425b5739882e380f060c2c66b9969e9cd8c9","memory_facts.rs":"86bbc4b9f74d5e74ac5fa46029364e7de051ab7d6d19149271b0a6a4b3d50d62","memory_query.rs":"34ce10df7b64bd710aa295f1f48b29ea3c28a4b9c6d2166bdcd0b5036bd21e17","memory_workbench.rs":"be51d0a44fe1b2b6b35ac6c1fc3fd6b4977a8a1ad829542c5e2fd85f4554a856","parse.rs":"4ed5828c2445639784ff0c997d78ce3c4113712848e7fe788734bc2ebb9b4c58","planning.rs":"1b06c2662ad5e3ee85fc286264dd04ad5702f96473145031d4288f9f837ad405","qa.rs":"649c5d59973c8cf5c9a3f7a1dba39ab9c666a594c881566a1271fcfd28679ac7","question_flow.rs":"685a4fa8024d215a136798a8588325bf0610332640124aa6e1c77e14452d85ec","search.rs":"5b1567beeca4a66c9ffd1a613ee8705ff28a95f194e260dbf3cb8427eeb061c1","settings.rs":"373c0139373a061fca84eccccc700abc5bff0e261950aca631616f4bdb463117","tasks.rs":"861efd389b78a55c0bb2a46f6fa4cf420ce879e9dc68720fe4191a8b473e01ca"} |
| tested_source_binary_and_evaluation_match | 是 | {"binary":"57248d7658e4b18cf03bfcaa2a75fbc4848b5c4f09e82aeec3ccf5b392d82f89","evaluation":{"scripts/evaluate-memory-public-live.mjs":"6502c73a0d6b1c8664ac1c8db5deab7493d570fbad496be7863a6a7995c7817d","scripts/memory-evaluation-round.mjs":"27d91948deabddc4eafe1a6f7addb0d1d0c3aab841fc4791ebae4bcebcb024f3","scripts/memory-public-live-judges.mjs":"09cca6b4c8ea7fecffbfe6c1fdc7d4c320cf56a817587bfb0a196ba9eba1d70c","scripts/memory-public-live-options.mjs":"57f001110417f318ec5dff909388fd4911b7fc78aa189eecd063f5df283d1e61","scripts/memory-public-live-io.mjs":"e6f1b2d4576661ffaabaffa71dbb7c2ad32a4233783a511a06ccc196e02cc74d","scripts/score-memory-public-live.mjs":"1ecfb56f62e690662e172dcaa737eba848694db3e2e9f119b8b79d3ed9385293","scripts/compare-memory-public-live.mjs":"2699e6c1c044221602c2b9aac8e1dd745676747f08ae23b7600194aba72bc834","scripts/check-memory-public-development.mjs":"a01c4f7c59a75c8dbe9563878fa535acae9e6333ee2a661c33e0dbe4f84b171c","scripts/check-memory-qa-efficient-development.mjs":"672914c7376bd8e9b1f0b04fdeb2f58452084f54882fb9fa8a53491d4e905a57","scripts/memory-qa-efficient-evaluation-files.mjs":"3f72f462f743f29026fe13724d2014465eccf002c3933be6d278e19f0ee0a435","docs/memory-qa-efficient-preregistration.json":"52c22592ef95ddda299c4f8e7e9a39115ae7d2db294a6b88d18d238ba3cb949e","scripts/verify-memory-public-live.mjs":"ee595e6b47cc934700d356b951ad51d8fade1f76a74018a7e781c8f39f916dac","scripts/capture-memory-evaluation-references.mjs":"a6c7fa49265d5d11e14d7180b2b7cd403690c2e04f061ebcd85334c2e7c576e3","docs/memory-qa-efficient-format-adaptation.md":"8d99e717531929bb30e10cfd5473d151b117310982b27e17f2fbfea4217b02b3"}} |
| desktop_complete_answer_floor | 是 | 13 |
| desktop_references_preserved | 是 | 16 |
| desktop_correct_refusal | 是 | 1 |
| desktop_all_twenty_anonymously_paired | 是 | 20 |
| desktop_paired_correctness_guard | 是 | {"current":13,"previousPaired":9,"net":4} |
| connector_complete_answer_floor | 是 | 14 |
| connector_references_preserved | 是 | 16 |
| connector_correct_refusal | 是 | 1 |
| connector_all_twenty_anonymously_paired | 是 | 20 |
| connector_paired_correctness_guard | 是 | {"current":14,"previousPaired":13,"net":1} |
| combined_paired_improvement | 是 | 5 |
| all_forty_production_entries | 是 | 40 |
| no_top_level_qa_protocol_errors | 是 | 0 |
| supplement_protocol_failures_not_worse | 是 | 0 |
| qa_token_usage_complete | 是 | {"requests":83,"currentComplete":true,"baselineComplete":true} |
| qa_cost_baseline_is_registered_previous_development | 是 | 516878 |
| combined_qa_tokens_at_least_fifteen_percent_lower | 是 | {"previousTokens":516878,"currentTokens":262191,"reductionFraction":0.4927410336675192} |
| shared_registered_development_budget | 是 | {"currentRequests":243,"priorRequests":252,"currentTokens":1128989,"priorTokens":1162094,"declaredLimits":{"requests":348,"observedTotalTokens":1837906,"concurrentWorkers":3,"automaticRetries":0}} |

未提供同记忆诊断。

完整指标、逐题变化、评分修复审计：[机器JSON](memory-qa-efficient-metrics.json)。[上一轮检索优化报告](memory-retrieval-optimized-report.md)。

## 限制

- 参考充分和答案正确均是自动评分，不能代替独立人工标注；断言精确率未测。
- 9道无答案题样本很小，拒答改进或退化均单列；不得混入91道可答题准确率。
- 公开英文论文不等于中文业务记忆；未覆盖长期冲突、更新、遗忘与全生命周期。
- 报告生成只读取保存工件，不产生真实模型调用。
