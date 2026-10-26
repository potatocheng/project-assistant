# 检索、上下文与拒答：真实LLM完整链路对比

生成时间：2026-10-20T13:19:01.872Z。模型：`deepseek-flash`。QASPER冻结公开数据，CC BY 4.0，[来源与适配](memory-public-datasets.md)。

20题开发集：完成；预注册门槛：通过。100题：完成；相同生产代码、二进制、评分规则与门槛按顺序运行：是。

本轮实际重新执行提取、记忆组织、两个生产问答入口和隔离评分。提取实现保持不变，随机输出仍可能改变；新旧差值属于完整链路联合结果。原80题已参与分析，当前是固定回归集。自动评分使用同一模型，未独立人工复核。

## 预算与实现归因

本轮检索继续使用无向量方案。聚焦问答最多24条参考、36000模型参考字符；桌面总览保留40条总参考/40000字符，其中正式记忆至多24条。问题、schema及封装另计入累计输入预算。每个grounded模型回答必须审查，本地结构化字段直读保留；证据不足或审查失败最多一次定向补查。生产QA最多5次模型调用、累计180000输入字符；60000报告token是调用后停止阈值，单个请求可越过后被拒绝输出，不是请求前硬预留。保留原超时；上轮为4次调用及较小输入预算。报告列出实际成本，不能视为等成本收益。

本次提供的3个不同运行（含已提供失败pilot、新开发及全量）共1915次真实调用、10062795个已报告token；不含上一轮基线。

## 完整100题前后总览

91道可答题与9道无答案题分开计分。下表旧值保留上一轮原始评分；同次匿名配对重新评分在下一表另列。

| 环节 | 上一轮原始 | 本轮 |
| --- | --- | --- |
| 提取成功 | 36/36 | 36/36 |
| 正式记忆 | 4571 | 4589 |
| 正文充分 / 部分保留 | 78 / 10 | 81 / 7 |
| 桌面生成参考充分 | 33/91（36.3%） | 69/91（75.8%） |
| 桌面完整正确 | 31/91（34.1%） | 55/91（60.4%） |
| 桌面无答案正确拒答 | 5/9（55.6%） | 7/9（77.8%） |
| 桌面生产QA请求 / token | 215 / 543090 | 329 / 1696051 |
| 飞书问答生成参考充分 | 32/91（35.2%） | 68/91（74.7%） |
| 飞书问答完整正确 | 33/91（36.3%） | 55/91（60.4%） |
| 飞书问答无答案正确拒答 | 5/9（55.6%） | 6/9（66.7%） |
| 飞书问答生产QA请求 / token | 235 / 536256 | 257 / 1207410 |

| 入口 | 旧原始完整正确 | 同次重评旧答案 | 本轮完整正确 | 配对净增题数 | 配对新增 / 退化 |
| --- | --- | --- | --- | --- | --- |
| 桌面 | 31/91（34.1%） | 32/91（35.2%） | 55/91（60.4%） | 23 | 29 / 6 |
| 飞书问答 | 33/91（36.3%） | 33/91（36.3%） | 55/91（60.4%） | 22 | 27 / 5 |

### 同一次100题运行中的开发20题与固定回归80题

| 集合 / 入口 | 题数（可答/无答案） | 旧原始完整正确 | 配对旧答案→本轮 | 旧→新参考充分 | 旧→新正确拒答 |
| --- | --- | --- | --- | --- | --- |
| 开发20 / 桌面 | 20（19/1） | 9/19（47.4%） | 9/19（47.4%）→9/19（47.4%） | 11/19（57.9%）→16/19（84.2%） | 1/1（100.0%）→1/1（100.0%） |
| 开发20 / 飞书问答 | 20（19/1） | 7/19（36.8%） | 7/19（36.8%）→12/19（63.2%） | 8/19（42.1%）→16/19（84.2%） | 1/1（100.0%）→1/1（100.0%） |
| 固定回归80 / 桌面 | 80（72/8） | 22/72（30.6%） | 23/72（31.9%）→46/72（63.9%） | 22/72（30.6%）→53/72（73.6%） | 4/8（50.0%）→6/8（75.0%） |
| 固定回归80 / 飞书问答 | 80（72/8） | 26/72（36.1%） | 26/72（36.1%）→43/72（59.7%） | 24/72（33.3%）→52/72（72.2%） | 4/8（50.0%）→5/8（62.5%） |

这两组来自同一个完整100题工件，不把单独开发运行的20题分数拼入100题。80题此前已看过，继续作为固定回归，不能称为未见盲测。生产上下文与审查预算增加，需结合QA调用、token和延迟看收益。

## 单独开发集20题

6篇/20题，可答19、无答案1。完整执行：是。

| 环节 | 上一轮原始结果 | 本轮结果 |
| --- | --- | --- |
| 提取成功 | 6/6 | 6/6 |
| 正式记忆 | 944 | 931 |
| 信息保留yes / partial / no | yes: 17；no: 1；partial: 1 | yes: 17；no: 2 |
| 桌面参考充分 | 9/19（47.4%） | 16/19（84.2%） |
| 桌面完整正确 | 7/19（36.8%） | 9/19（47.4%） |
| 桌面无答案正确拒答 | 1/1（100.0%） | 1/1（100.0%） |
| 飞书问答参考充分 | 7/19（36.8%） | 16/19（84.2%） |
| 飞书问答完整正确 | 7/19（36.8%） | 13/19（68.4%） |
| 飞书问答无答案正确拒答 | 1/1（100.0%） | 1/1（100.0%） |

### 同次匿名配对与评分漂移

| 入口 | 上一轮原始完整正确 | 本轮重新评分旧答案 | 本轮新答案 | 配对新增 / 退化 | 无答案旧配对 / 本轮 |
| --- | --- | --- | --- | --- | --- |
| 桌面 | 7/19（36.8%） | 6/19（31.6%） | 9/19（47.4%） | 5 / 2 | 1/1（100.0%） / 1/1（100.0%） |
| 飞书问答 | 7/19（36.8%） | 7/19（36.8%） | 13/19（68.4%） | 6 / 0 | 1/1（100.0%） / 1/1（100.0%） |

原始旧评分与本次配对旧评分可能不同；两个结果均保留，不用新评分覆盖旧工件。提取重新运行，记忆正文与组织字段仍可能漂移，因此端到端差值不是检索模块的独立因果效应。

### 阶段损失与上下文组装

| 入口 | 第一处观测损失 | 参考充分时答对 | 有充分记忆时参考充分 | 错误码 | p50 / p95毫秒 |
| --- | --- | --- | --- | --- | --- |
| 桌面 | success: 9；answer_error_or_refusal: 7；memory_content_missing: 2；retrieval_context_loss: 1 | 8/16（50.0%） | 15/17（88.2%） | 无 | 4051 / 12196 |
| 飞书问答 | success: 13；answer_error_or_refusal: 2；retrieval_context_loss: 2；memory_content_missing: 2 | 13/16（81.3%） | 15/17（88.2%） | 无 | 3109 / 4233 |

待审核草稿0条；未审草稿进入正式记忆0条。正式记忆数量和逐字来源校验不能代替语义精确率；该指标仍未独立人工标注。

### 成本与恢复记录

| 入口 | 旧→新QA请求 | 旧→新QA token | 旧→新p50/p95毫秒 | 旧→新实际补查生成题数 | 旧→新可答题拒答数 | 旧→新无答案题拒答数 |
| --- | --- | --- | --- | --- | --- | --- |
| 桌面 | 41→61 | 103733→315694 | 3156/4541→4051/12196 | 2→8 | 1→5 | 1→1 |
| 飞书问答 | 43→42 | 94321→201184 | 2814/3497→3109/4233 | 3→2 | 2→1 | 1→1 |

这里“拒答数”是生产最终grounded/status观测，不等于正确拒答数；正确性在独立无答案分母中另计。“实际补查生成”须至少两次真实generation请求，不能把仅规划或空改写算作补查。

| 入口 | 旧→新规划补查题数 | 旧→新额外检索轮数 | 旧→新任一审查拒绝题数 | 旧→新补查失败码 |
| --- | --- | --- | --- | --- |
| 桌面 | 2→8 | 2→8 | 0→5 | 无→ASSISTANT_GROUNDING: 1 |
| 飞书问答 | 3→2 | 3→2 | 0→0 | 无→无 |

补查失败可被生产流程安全转换为unknown，因此不能只看顶层error计数；这里单列queryTrace.supplementStatus。

| 阶段 | 上一轮请求/token | 本轮请求/token |
| --- | --- | --- |
| all | 246 / 1008603 | 263 / 1379151 |
| extraction | 100 / 436735 | 100 / 433862 |
| qa | 84 / 198054 | 103 / 516878 |
| judge | 62 / 373814 | 60 / 428411 |

| 阶段 | 请求 | 输入token | 输出token | 总token | 缺usage请求 | 累计请求毫秒 |
| --- | --- | --- | --- | --- | --- | --- |
| extraction:extraction | 100 | 287233 | 146629 | 433862 | 0 | 439956 |
| qa:generation | 50 | 371049 | 25966 | 397015 | 0 | 105919 |
| qa:answer_review | 43 | 87323 | 5275 | 92598 | 0 | 49003 |
| qa:query_rewrite | 10 | 26963 | 302 | 27265 | 0 | 7946 |
| judge:answer | 20 | 48998 | 2884 | 51882 | 0 | 25337 |
| judge:memory | 20 | 300786 | 2811 | 303597 | 0 | 30260 |
| judge:retrieval | 20 | 71118 | 1814 | 72932 | 0 | 22904 |

本轮263次真实请求，1379151个已报告token，墙钟7.1分钟。并发请求耗时不可相加当墙钟。计费金额未估算。

评分API格式重评0次、0token；当前评分错误0题。已收到评分JSON末尾单个右括号恢复3条，额外调用0，完整审计保存在机器JSON与原始收据。

完整flat answer系统外层无损规范化3条，额外调用0、额外token为0。只增加systems包装，不更改已有标签、理由或匿名映射；原始与规范JSON的SHA256及收据ID保留在机器JSON。

memory-only未判yes而retrieval-only判yes的隔离评分分歧2个入口案例。它提示评分不一致，不能据此断言“未存储的信息被检索出来”或作严格因果归因。逐例ID保存在机器JSON。

### 逐题对比

| 题号 | 入口 | 可答 | 旧原始/旧配对/本轮答案 | 旧/新正文保留 | 旧/新参考充分 | 配对变化 | 旧/新状态 | 旧/新生成次数 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 747b847d687f703cc20a87877c5b138f26ff137d | 桌面 | 是 | no/no/partial | yes/yes | no/yes | still_unsuccessful | partial/answered | 1/1 |
| 747b847d687f703cc20a87877c5b138f26ff137d | 飞书问答 | 是 | no/no/partial | yes/yes | no/yes | still_unsuccessful | unknown/answered | 2/1 |
| 111afb77cfbf4c98e0458606378fa63a0e965e36 | 桌面 | 是 | partial/partial/yes | yes/yes | yes/yes | new_success | partial/answered | 1/1 |
| 111afb77cfbf4c98e0458606378fa63a0e965e36 | 飞书问答 | 是 | partial/partial/yes | yes/yes | yes/yes | new_success | answered/answered | 1/1 |
| 50cc6c5f2dcf5fb87b56007f6a825fa7c90b64ed | 桌面 | 是 | partial/partial/partial | yes/yes | no/yes | still_unsuccessful | partial/partial | 1/2 |
| 50cc6c5f2dcf5fb87b56007f6a825fa7c90b64ed | 飞书问答 | 是 | partial/partial/partial | yes/yes | no/yes | still_unsuccessful | answered/answered | 1/1 |
| 6bf5620f295b5243230bc97b340fae6e92304595 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 6bf5620f295b5243230bc97b340fae6e92304595 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 1be54c5b3ea67d837ffba2290a40c1e720d9587f | 桌面 | 是 | partial/partial/partial | yes/yes | partial/yes | still_unsuccessful | answered/answered | 1/1 |
| 1be54c5b3ea67d837ffba2290a40c1e720d9587f | 飞书问答 | 是 | yes/yes/yes | yes/yes | partial/yes | retained_success | answered/answered | 1/1 |
| 584af673429c7f8621c6bf83362a37048daa0e5d | 桌面 | 是 | partial/partial/yes | yes/yes | partial/partial | new_success | answered/answered | 1/1 |
| 584af673429c7f8621c6bf83362a37048daa0e5d | 飞书问答 | 是 | partial/partial/partial | yes/yes | partial/partial | still_unsuccessful | answered/answered | 1/1 |
| c37f65c9f0d543a35c784263b79236ccf1c44fac | 桌面 | 是 | no/no/yes | yes/yes | no/yes | new_success | partial/answered | 1/1 |
| c37f65c9f0d543a35c784263b79236ccf1c44fac | 飞书问答 | 是 | no/no/yes | yes/yes | no/yes | new_success | partial/answered | 1/1 |
| b08f88d1facefceb87e134ba2c1fa90035018e83 | 桌面 | 是 | no/no/no | no/no | no/no | still_unsuccessful | unknown/unknown | 2/2 |
| b08f88d1facefceb87e134ba2c1fa90035018e83 | 飞书问答 | 是 | no/no/no | no/no | no/no | still_unsuccessful | unknown/unknown | 2/2 |
| 55bd59076a49b19d3283af41c5e3ccb875f3eb0c | 桌面 | 是 | no/no/yes | yes/yes | yes/yes | new_success | error_or_missing/answered | 1/1 |
| 55bd59076a49b19d3283af41c5e3ccb875f3eb0c | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 5daeb8d4d6f3b8543ec6309a7a35523e160437eb | 桌面 | 是 | no/no/no | yes/yes | no/yes | still_unsuccessful | partial/unknown | 1/2 |
| 5daeb8d4d6f3b8543ec6309a7a35523e160437eb | 飞书问答 | 是 | no/no/yes | yes/yes | no/yes | new_success | answered/answered | 1/1 |
| 521280a87c43fcdf9f577da235e7072a23f0673e | 桌面 | 是 | yes/yes/no | yes/yes | yes/yes | regression | partial/unknown | 1/2 |
| 521280a87c43fcdf9f577da235e7072a23f0673e | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 5a8cc8f80509ea77d8213ed28c5ead501c68c725 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 5a8cc8f80509ea77d8213ed28c5ead501c68c725 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 10fb7dc031075946153baf0a0599e126de29e3a4 | 桌面 | 是 | partial/no/partial | partial/no | no/yes | still_unsuccessful | partial/answered | 1/2 |
| 10fb7dc031075946153baf0a0599e126de29e3a4 | 飞书问答 | 是 | partial/no/partial | partial/no | no/yes | still_unsuccessful | partial/answered | 1/1 |
| c5b0ed5db65051eebd858beaf303809aa815e8e5 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| c5b0ed5db65051eebd858beaf303809aa815e8e5 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 7ab9c0b4ceca1c142ff068f85015a249b14282d0 | 桌面 | 是 | partial/partial/yes | yes/yes | partial/yes | new_success | partial/answered | 1/1 |
| 7ab9c0b4ceca1c142ff068f85015a249b14282d0 | 飞书问答 | 是 | partial/partial/yes | yes/yes | partial/yes | new_success | partial/answered | 1/1 |
| d28d86524292506d4b24ae2d486725a6d57a3db3 | 桌面 | 是 | yes/partial/no | yes/yes | yes/yes | still_unsuccessful | partial/unknown | 1/2 |
| d28d86524292506d4b24ae2d486725a6d57a3db3 | 飞书问答 | 是 | no/no/yes | yes/yes | no/yes | new_success | partial/answered | 1/1 |
| 63488da6c7aff9e374561a24ba224e9ce7f65e40 | 桌面 | 否 | yes/yes/yes | no/no | no/no | retained_success | unknown/unknown | 2/2 |
| 63488da6c7aff9e374561a24ba224e9ce7f65e40 | 飞书问答 | 否 | yes/yes/yes | no/no | no/no | retained_success | unknown/unknown | 2/2 |
| c1c44fd96c3fa6e16949ae8fa453e511c6435c68 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | partial/answered | 1/1 |
| c1c44fd96c3fa6e16949ae8fa453e511c6435c68 | 飞书问答 | 是 | no/partial/yes | yes/yes | partial/yes | new_success | partial/answered | 1/1 |
| feafcc1c4026d7f55a2c8ce7850d7e12030b5c22 | 桌面 | 是 | yes/yes/no | yes/yes | yes/yes | regression | answered/unknown | 1/2 |
| feafcc1c4026d7f55a2c8ce7850d7e12030b5c22 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| dd76130ec5fac477123fe8880472d03fbafddef6 | 桌面 | 是 | partial/partial/partial | yes/yes | partial/partial | still_unsuccessful | answered/answered | 1/1 |
| dd76130ec5fac477123fe8880472d03fbafddef6 | 飞书问答 | 是 | partial/partial/partial | yes/yes | partial/partial | still_unsuccessful | answered/answered | 1/1 |

## 开发集人工复核待办

独立开发20题中，自动判参考充分但未完整答对的11个入口结果涉及8道题。下表仅是排查假设，尚未人工评定，不据此改分，也不用于修改当前冻结代码或完整100题运行。

| 题号 | 入口 | 生产收据ID | 待核验假设 | 人工评定 |
| --- | --- | --- | --- | --- |
| 747b847d687f703cc20a87877c5b138f26ff137d | 桌面、飞书问答 | 73, 75, 77, 78 | 仅答Europarl而未答CoNLL：题意、平行语料定义与标准答案口径可能不一致，需人工核验。 | 未做 |
| 50cc6c5f2dcf5fb87b56007f6a825fa7c90b64ed | 桌面、飞书问答 | 87, 88, 90, 92, 94, 95, 96 | individual model与joint model粒度混淆；引用含目标事实，但最终答复或审查仍偏向联合模型。 | 未做 |
| 1be54c5b3ea67d837ffba2290a40c1e720d9587f | 桌面 | 19, 21 | 说明了位置对应的独立decoder，但未显式回答位置本身是否作为输入；检索与答案评分口径也可能分歧。 | 未做 |
| 5daeb8d4d6f3b8543ec6309a7a35523e160437eb | 桌面 | 43, 48, 50, 53, 54 | 当前数据集与相关研究中的不同语言未分清，可能因主体绑定过严而拒答。 | 未做 |
| 521280a87c43fcdf9f577da235e7072a23f0673e | 桌面 | 58, 60, 61, 63, 64 | 标注阶段五名annotators与整个流程六名experts混淆，可能将所问人数扩大到全流程。 | 未做 |
| 10fb7dc031075946153baf0a0599e126de29e3a4 | 桌面、飞书问答 | 99, 102, 104, 106, 109, 110, 112 | 已引用所有候选义项逐对分类机制，但缺少直接说明可变义项数的结论；memory-only与retrieval-only亦分歧。 | 未做 |
| d28d86524292506d4b24ae2d486725a6d57a3db3 | 桌面 | 136, 137, 139, 140, 141 | ROUGE平均分已出现，审查要求分项分数或更明确最优模型身份，可能增加未问的缺口并过度拒答。 | 未做 |
| feafcc1c4026d7f55a2c8ce7850d7e12030b5c22 | 桌面 | 159, 161, 162, 164 | 首稿部分答案经核验，补查加入额外未知项后最终引用ID绑定失败并安全拒答；可能丢弃已核验部分答案。 | 未做 |

## 已保留的首轮试运行与评分器协议修订

首轮pilot完整执行标志false，271次真实调用、1420745个已报告token；门槛未通过。原始失败、显式格式重评和所有额外费用均保留，不通过新解析器回填首轮或将其算为通过。

两次开发合计534/600次请求、2799896/3000000个报告token，共享原开发预算；完整100题另按注册上限执行。

首轮评分器对完整flat system1/system2对象判为schema失败。修订后的新运行只增加精确无损外层包装，并按原数值门槛重新完成整个20题；[协议修订说明](memory-retrieval-evaluator-amendment.md)。不能声称整个开发过程从未调整评测器接纳规则。

## 首轮失败pilot（原始结果）

6篇/20题，可答19、无答案1。完整执行：否。

| 环节 | 上一轮原始结果 | 本轮结果 |
| --- | --- | --- |
| 提取成功 | 6/6 | 6/6 |
| 正式记忆 | 944 | 945 |
| 信息保留yes / partial / no | yes: 17；no: 1；partial: 1 | yes: 17；partial: 2 |
| 桌面参考充分 | 9/19（47.4%） | 16/19（84.2%） |
| 桌面完整正确 | 7/19（36.8%） | 12/19（63.2%） |
| 桌面无答案正确拒答 | 1/1（100.0%） | 1/1（100.0%） |
| 飞书问答参考充分 | 7/19（36.8%） | 16/19（84.2%） |
| 飞书问答完整正确 | 7/19（36.8%） | 15/19（78.9%） |
| 飞书问答无答案正确拒答 | 1/1（100.0%） | 1/1（100.0%） |

### 同次匿名配对与评分漂移

| 入口 | 上一轮原始完整正确 | 本轮重新评分旧答案 | 本轮新答案 | 配对新增 / 退化 | 无答案旧配对 / 本轮 |
| --- | --- | --- | --- | --- | --- |
| 桌面 | 7/19（36.8%） | 6/19（31.6%） | 12/19（63.2%） | 6 / 0 | 1/1（100.0%） / 1/1（100.0%） |
| 飞书问答 | 7/19（36.8%） | 7/19（36.8%） | 15/19（78.9%） | 8 / 0 | 1/1（100.0%） / 1/1（100.0%） |

原始旧评分与本次配对旧评分可能不同；两个结果均保留，不用新评分覆盖旧工件。提取重新运行，记忆正文与组织字段仍可能漂移，因此端到端差值不是检索模块的独立因果效应。

### 阶段损失与上下文组装

| 入口 | 第一处观测损失 | 参考充分时答对 | 有充分记忆时参考充分 | 错误码 | p50 / p95毫秒 |
| --- | --- | --- | --- | --- | --- |
| 桌面 | success: 12；answer_error_or_refusal: 4；memory_content_missing: 1；judge_unavailable: 1；retrieval_context_loss: 1 | 11/16（68.8%） | 15/17（88.2%） | 无 | 4352 / 11900 |
| 飞书问答 | success: 15；answer_error_or_refusal: 1；memory_content_missing: 1；judge_unavailable: 1；retrieval_context_loss: 1 | 14/16（87.5%） | 15/17（88.2%） | 无 | 2836 / 7978 |

待审核草稿1条；未审草稿进入正式记忆0条。正式记忆数量和逐字来源校验不能代替语义精确率；该指标仍未独立人工标注。

### 成本与恢复记录

| 入口 | 旧→新QA请求 | 旧→新QA token | 旧→新p50/p95毫秒 | 旧→新实际补查生成题数 | 旧→新可答题拒答数 | 旧→新无答案题拒答数 |
| --- | --- | --- | --- | --- | --- | --- |
| 桌面 | 41→58 | 103733→302713 | 3156/4541→4352/11900 | 2→7 | 1→3 | 1→1 |
| 飞书问答 | 43→51 | 94321→240506 | 2814/3497→2836/7978 | 3→5 | 2→1 | 1→1 |

这里“拒答数”是生产最终grounded/status观测，不等于正确拒答数；正确性在独立无答案分母中另计。“实际补查生成”须至少两次真实generation请求，不能把仅规划或空改写算作补查。

| 入口 | 旧→新规划补查题数 | 旧→新额外检索轮数 | 旧→新任一审查拒绝题数 | 旧→新补查失败码 |
| --- | --- | --- | --- | --- |
| 桌面 | 2→7 | 2→7 | 0→4 | 无→无 |
| 飞书问答 | 3→5 | 3→5 | 0→3 | 无→无 |

补查失败可被生产流程安全转换为unknown，因此不能只看顶层error计数；这里单列queryTrace.supplementStatus。

| 阶段 | 上一轮请求/token | 本轮请求/token |
| --- | --- | --- |
| all | 246 / 1008603 | 271 / 1420745 |
| extraction | 100 / 436735 | 100 / 436079 |
| qa | 84 / 198054 | 109 / 543219 |
| judge | 62 / 373814 | 62 / 441447 |

| 阶段 | 请求 | 输入token | 输出token | 总token | 缺usage请求 | 累计请求毫秒 |
| --- | --- | --- | --- | --- | --- | --- |
| extraction:extraction | 100 | 287164 | 148915 | 436079 | 0 | 445345 |
| qa:generation | 52 | 380022 | 28276 | 408298 | 0 | 112015 |
| qa:answer_review | 45 | 96539 | 5431 | 101970 | 0 | 49387 |
| qa:query_rewrite | 12 | 32604 | 347 | 32951 | 0 | 8607 |
| judge:answer | 22 | 59308 | 3271 | 62579 | 0 | 25685 |
| judge:memory | 20 | 304676 | 3014 | 307690 | 0 | 25236 |
| judge:retrieval | 20 | 69322 | 1856 | 71178 | 0 | 19305 |

本轮271次真实请求，1420745个已报告token，墙钟7.8分钟。并发请求耗时不可相加当墙钟。计费金额未估算。

评分API格式重评2次、6658token；当前评分错误1题。已收到评分JSON末尾单个右括号恢复4条，额外调用0，完整审计保存在机器JSON与原始收据。

完整flat answer系统外层无损规范化0条，额外调用0、额外token为0。只增加systems包装，不更改已有标签、理由或匿名映射；原始与规范JSON的SHA256及收据ID保留在机器JSON。

memory-only未判yes而retrieval-only判yes的隔离评分分歧2个入口案例。它提示评分不一致，不能据此断言“未存储的信息被检索出来”或作严格因果归因。逐例ID保存在机器JSON。

### 逐题对比

| 题号 | 入口 | 可答 | 旧原始/旧配对/本轮答案 | 旧/新正文保留 | 旧/新参考充分 | 配对变化 | 旧/新状态 | 旧/新生成次数 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 747b847d687f703cc20a87877c5b138f26ff137d | 桌面 | 是 | no/no/partial | yes/yes | no/yes | still_unsuccessful | partial/answered | 1/1 |
| 747b847d687f703cc20a87877c5b138f26ff137d | 飞书问答 | 是 | no/no/partial | yes/yes | no/yes | still_unsuccessful | unknown/answered | 2/1 |
| 111afb77cfbf4c98e0458606378fa63a0e965e36 | 桌面 | 是 | partial/partial/yes | yes/yes | yes/yes | new_success | partial/answered | 1/2 |
| 111afb77cfbf4c98e0458606378fa63a0e965e36 | 飞书问答 | 是 | partial/partial/yes | yes/yes | yes/yes | new_success | answered/answered | 1/1 |
| 50cc6c5f2dcf5fb87b56007f6a825fa7c90b64ed | 桌面 | 是 | partial/partial/yes | yes/yes | no/partial | new_success | partial/answered | 1/1 |
| 50cc6c5f2dcf5fb87b56007f6a825fa7c90b64ed | 飞书问答 | 是 | partial/partial/yes | yes/yes | no/partial | new_success | answered/answered | 1/2 |
| 6bf5620f295b5243230bc97b340fae6e92304595 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 6bf5620f295b5243230bc97b340fae6e92304595 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 55bd59076a49b19d3283af41c5e3ccb875f3eb0c | 桌面 | 是 | no/no/yes | yes/yes | yes/yes | new_success | error_or_missing/answered | 1/1 |
| 55bd59076a49b19d3283af41c5e3ccb875f3eb0c | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 5daeb8d4d6f3b8543ec6309a7a35523e160437eb | 桌面 | 是 | no/no/no | yes/yes | no/yes | still_unsuccessful | partial/unknown | 1/2 |
| 5daeb8d4d6f3b8543ec6309a7a35523e160437eb | 飞书问答 | 是 | no/no/yes | yes/yes | no/yes | new_success | answered/answered | 1/1 |
| 521280a87c43fcdf9f577da235e7072a23f0673e | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | partial/answered | 1/1 |
| 521280a87c43fcdf9f577da235e7072a23f0673e | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 5a8cc8f80509ea77d8213ed28c5ead501c68c725 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 5a8cc8f80509ea77d8213ed28c5ead501c68c725 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 1be54c5b3ea67d837ffba2290a40c1e720d9587f | 桌面 | 是 | partial/partial/partial | yes/yes | partial/yes | still_unsuccessful | answered/answered | 1/2 |
| 1be54c5b3ea67d837ffba2290a40c1e720d9587f | 飞书问答 | 是 | yes/yes/yes | yes/yes | partial/yes | retained_success | answered/answered | 1/2 |
| 584af673429c7f8621c6bf83362a37048daa0e5d | 桌面 | 是 | partial/partial/yes | yes/yes | partial/yes | new_success | answered/answered | 1/1 |
| 584af673429c7f8621c6bf83362a37048daa0e5d | 飞书问答 | 是 | partial/partial/yes | yes/yes | partial/yes | new_success | answered/answered | 1/1 |
| c37f65c9f0d543a35c784263b79236ccf1c44fac | 桌面 | 是 | no/no/yes | yes/yes | no/yes | new_success | partial/answered | 1/1 |
| c37f65c9f0d543a35c784263b79236ccf1c44fac | 飞书问答 | 是 | no/no/yes | yes/yes | no/yes | new_success | partial/answered | 1/1 |
| b08f88d1facefceb87e134ba2c1fa90035018e83 | 桌面 | 是 | no/no/no | no/partial | no/no | still_unsuccessful | unknown/unknown | 2/2 |
| b08f88d1facefceb87e134ba2c1fa90035018e83 | 飞书问答 | 是 | no/no/no | no/partial | no/no | still_unsuccessful | unknown/unknown | 2/2 |
| 10fb7dc031075946153baf0a0599e126de29e3a4 | 桌面 | 是 | partial/not_judged/not_judged | partial/partial | no/yes | still_unsuccessful | partial/partial | 1/2 |
| 10fb7dc031075946153baf0a0599e126de29e3a4 | 飞书问答 | 是 | partial/not_judged/not_judged | partial/partial | no/yes | still_unsuccessful | partial/answered | 1/2 |
| c5b0ed5db65051eebd858beaf303809aa815e8e5 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| c5b0ed5db65051eebd858beaf303809aa815e8e5 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 7ab9c0b4ceca1c142ff068f85015a249b14282d0 | 桌面 | 是 | partial/partial/yes | yes/yes | partial/yes | new_success | partial/answered | 1/1 |
| 7ab9c0b4ceca1c142ff068f85015a249b14282d0 | 飞书问答 | 是 | partial/partial/yes | yes/yes | partial/yes | new_success | partial/answered | 1/1 |
| d28d86524292506d4b24ae2d486725a6d57a3db3 | 桌面 | 是 | yes/partial/no | yes/yes | yes/yes | still_unsuccessful | partial/unknown | 1/2 |
| d28d86524292506d4b24ae2d486725a6d57a3db3 | 飞书问答 | 是 | no/no/yes | yes/yes | no/yes | new_success | partial/answered | 1/1 |
| 63488da6c7aff9e374561a24ba224e9ce7f65e40 | 桌面 | 否 | yes/yes/yes | no/no | no/no | retained_success | unknown/unknown | 2/2 |
| 63488da6c7aff9e374561a24ba224e9ce7f65e40 | 飞书问答 | 否 | yes/yes/yes | no/no | no/no | retained_success | unknown/unknown | 2/2 |
| c1c44fd96c3fa6e16949ae8fa453e511c6435c68 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | partial/answered | 1/1 |
| c1c44fd96c3fa6e16949ae8fa453e511c6435c68 | 飞书问答 | 是 | no/no/yes | yes/yes | partial/yes | new_success | partial/answered | 1/1 |
| feafcc1c4026d7f55a2c8ce7850d7e12030b5c22 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| feafcc1c4026d7f55a2c8ce7850d7e12030b5c22 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| dd76130ec5fac477123fe8880472d03fbafddef6 | 桌面 | 是 | partial/partial/partial | yes/yes | partial/partial | still_unsuccessful | answered/answered | 1/1 |
| dd76130ec5fac477123fe8880472d03fbafddef6 | 飞书问答 | 是 | partial/partial/partial | yes/yes | partial/partial | still_unsuccessful | answered/answered | 1/1 |

## 相同旧记忆的本地检索诊断

| 入口 | 旧→新任一相关ID命中 | 旧→新全部相关ID命中 | 去facets的全部ID命中 | 旧→新参考条数总和 |
| --- | --- | --- | --- | --- |
| 桌面 | 13→18/19 | 3→11/19 | 9/19 | 109→415 |
| 飞书问答 | 12→19/19 | 3→12/19 | 10/19 | 108→414 |

这项只读诊断复用上一轮正式记忆及最后一次真实rewrite，无模型调用；规范ID优先取memoryId，桌面memory:前缀不作为另一个记忆。相关ID来自上一轮事后memory-only评分，未传入检索。ID命中不能代替语义充分、回答正确或独立人工验证；新上下文更大，不能视为等成本收益。去facets只在RAM诊断，正式路径保留条件、实体和有效期。

## 完整100题

36篇/100题，可答91、无答案9。完整执行：是。

| 环节 | 上一轮原始结果 | 本轮结果 |
| --- | --- | --- |
| 提取成功 | 36/36 | 36/36 |
| 正式记忆 | 4571 | 4589 |
| 信息保留yes / partial / no | yes: 78；no: 3；partial: 10 | yes: 81；no: 3；partial: 7 |
| 桌面参考充分 | 33/91（36.3%） | 69/91（75.8%） |
| 桌面完整正确 | 31/91（34.1%） | 55/91（60.4%） |
| 桌面无答案正确拒答 | 5/9（55.6%） | 7/9（77.8%） |
| 飞书问答参考充分 | 32/91（35.2%） | 68/91（74.7%） |
| 飞书问答完整正确 | 33/91（36.3%） | 55/91（60.4%） |
| 飞书问答无答案正确拒答 | 5/9（55.6%） | 6/9（66.7%） |

### 同次匿名配对与评分漂移

| 入口 | 上一轮原始完整正确 | 本轮重新评分旧答案 | 本轮新答案 | 配对新增 / 退化 | 无答案旧配对 / 本轮 |
| --- | --- | --- | --- | --- | --- |
| 桌面 | 31/91（34.1%） | 32/91（35.2%） | 55/91（60.4%） | 29 / 6 | 5/9（55.6%） / 7/9（77.8%） |
| 飞书问答 | 33/91（36.3%） | 33/91（36.3%） | 55/91（60.4%） | 27 / 5 | 5/9（55.6%） / 6/9（66.7%） |

原始旧评分与本次配对旧评分可能不同；两个结果均保留，不用新评分覆盖旧工件。提取重新运行，记忆正文与组织字段仍可能漂移，因此端到端差值不是检索模块的独立因果效应。

### 阶段损失与上下文组装

| 入口 | 第一处观测损失 | 参考充分时答对 | 有充分记忆时参考充分 | 错误码 | p50 / p95毫秒 |
| --- | --- | --- | --- | --- | --- |
| 桌面 | success: 55；answer_error_or_refusal: 14；retrieval_context_loss: 12；memory_content_missing: 9；answer_protocol_error: 1 | 51/69（73.9%） | 66/81（81.5%） | ASSISTANT_GROUNDING: 1 | 5720 / 12716 |
| 飞书问答 | success: 55；answer_error_or_refusal: 15；retrieval_context_loss: 13；memory_content_missing: 8 | 51/68（75.0%） | 65/81（80.2%） | 无 | 3706 / 7985 |

待审核草稿15条；未审草稿进入正式记忆0条。正式记忆数量和逐字来源校验不能代替语义精确率；该指标仍未独立人工标注。

### 成本与恢复记录

| 入口 | 旧→新QA请求 | 旧→新QA token | 旧→新p50/p95毫秒 | 旧→新实际补查生成题数 | 旧→新可答题拒答数 | 旧→新无答案题拒答数 |
| --- | --- | --- | --- | --- | --- | --- |
| 桌面 | 215→329 | 543090→1696051 | 3488/4887→5720/12716 | 13→48 | 7→14 | 5→7 |
| 飞书问答 | 235→257 | 536256→1207410 | 3004/4937→3706/7985 | 24→27 | 10→9 | 5→6 |

这里“拒答数”是生产最终grounded/status观测，不等于正确拒答数；正确性在独立无答案分母中另计。“实际补查生成”须至少两次真实generation请求，不能把仅规划或空改写算作补查。

| 入口 | 旧→新规划补查题数 | 旧→新额外检索轮数 | 旧→新任一审查拒绝题数 | 旧→新补查失败码 |
| --- | --- | --- | --- | --- |
| 桌面 | 15→50 | 15→50 | 0→24 | 无→ASSISTANT_GROUNDING: 1 |
| 飞书问答 | 26→29 | 26→29 | 0→9 | 无→无 |

补查失败可被生产流程安全转换为unknown，因此不能只看顶层error计数；这里单列queryTrace.supplementStatus。

| 阶段 | 上一轮请求/token | 本轮请求/token |
| --- | --- | --- |
| all | 1240 / 5096530 | 1381 / 7262899 |
| extraction | 490 / 2026410 | 494 / 2037653 |
| qa | 450 / 1079346 | 586 / 2903461 |
| judge | 300 / 1990774 | 301 / 2321785 |

| 阶段 | 请求 | 输入token | 输出token | 总token | 缺usage请求 | 累计请求毫秒 |
| --- | --- | --- | --- | --- | --- | --- |
| extraction:extraction | 494 | 1315909 | 721744 | 2037653 | 0 | 2213228 |
| qa:generation | 275 | 2014722 | 147559 | 2162281 | 0 | 632849 |
| qa:answer_review | 232 | 496534 | 28777 | 525311 | 0 | 289501 |
| qa:query_rewrite | 79 | 213495 | 2374 | 215869 | 0 | 65843 |
| judge:answer | 101 | 265925 | 14542 | 280467 | 0 | 122433 |
| judge:memory | 100 | 1665145 | 15353 | 1680498 | 0 | 149600 |
| judge:retrieval | 100 | 351649 | 9171 | 360820 | 0 | 109978 |

本轮1381次真实请求，7262899个已报告token，墙钟27.4分钟。并发请求耗时不可相加当墙钟。计费金额未估算。

评分API格式重评1次、2551token；当前评分错误0题。已收到评分JSON末尾单个右括号恢复9条，额外调用0，完整审计保存在机器JSON与原始收据。

完整flat answer系统外层无损规范化6条，额外调用0、额外token为0。只增加systems包装，不更改已有标签、理由或匿名映射；原始与规范JSON的SHA256及收据ID保留在机器JSON。

memory-only未判yes而retrieval-only判yes的隔离评分分歧6个入口案例。它提示评分不一致，不能据此断言“未存储的信息被检索出来”或作严格因果归因。逐例ID保存在机器JSON。

### 逐题对比

| 题号 | 入口 | 可答 | 旧原始/旧配对/本轮答案 | 旧/新正文保留 | 旧/新参考充分 | 配对变化 | 旧/新状态 | 旧/新生成次数 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 747b847d687f703cc20a87877c5b138f26ff137d | 桌面 | 是 | no/no/partial | yes/yes | no/yes | still_unsuccessful | partial/answered | 1/1 |
| 747b847d687f703cc20a87877c5b138f26ff137d | 飞书问答 | 是 | no/no/partial | yes/yes | no/yes | still_unsuccessful | partial/answered | 1/1 |
| 111afb77cfbf4c98e0458606378fa63a0e965e36 | 桌面 | 是 | partial/partial/partial | yes/yes | yes/yes | still_unsuccessful | partial/answered | 1/1 |
| 111afb77cfbf4c98e0458606378fa63a0e965e36 | 飞书问答 | 是 | partial/partial/partial | yes/yes | yes/yes | still_unsuccessful | partial/answered | 1/1 |
| 50cc6c5f2dcf5fb87b56007f6a825fa7c90b64ed | 桌面 | 是 | partial/no/yes | yes/yes | no/yes | new_success | partial/answered | 1/1 |
| 50cc6c5f2dcf5fb87b56007f6a825fa7c90b64ed | 飞书问答 | 是 | partial/no/no | yes/yes | no/yes | still_unsuccessful | answered/answered | 1/1 |
| 6bf5620f295b5243230bc97b340fae6e92304595 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 6bf5620f295b5243230bc97b340fae6e92304595 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 55bd59076a49b19d3283af41c5e3ccb875f3eb0c | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 55bd59076a49b19d3283af41c5e3ccb875f3eb0c | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 5daeb8d4d6f3b8543ec6309a7a35523e160437eb | 桌面 | 是 | yes/yes/partial | yes/yes | yes/yes | regression | answered/partial | 1/2 |
| 5daeb8d4d6f3b8543ec6309a7a35523e160437eb | 飞书问答 | 是 | yes/yes/partial | yes/yes | yes/yes | regression | answered/answered | 1/1 |
| 521280a87c43fcdf9f577da235e7072a23f0673e | 桌面 | 是 | yes/yes/partial | yes/yes | yes/yes | regression | answered/partial | 1/2 |
| 521280a87c43fcdf9f577da235e7072a23f0673e | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 5a8cc8f80509ea77d8213ed28c5ead501c68c725 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 5a8cc8f80509ea77d8213ed28c5ead501c68c725 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 1be54c5b3ea67d837ffba2290a40c1e720d9587f | 桌面 | 是 | partial/partial/no | yes/yes | yes/yes | still_unsuccessful | partial/unknown | 1/2 |
| 1be54c5b3ea67d837ffba2290a40c1e720d9587f | 飞书问答 | 是 | partial/partial/yes | yes/yes | yes/yes | new_success | partial/answered | 1/1 |
| 584af673429c7f8621c6bf83362a37048daa0e5d | 桌面 | 是 | partial/partial/partial | yes/yes | partial/partial | still_unsuccessful | partial/answered | 1/1 |
| 584af673429c7f8621c6bf83362a37048daa0e5d | 飞书问答 | 是 | yes/yes/partial | yes/yes | partial/partial | regression | answered/answered | 1/1 |
| c37f65c9f0d543a35c784263b79236ccf1c44fac | 桌面 | 是 | no/no/yes | yes/yes | no/yes | new_success | partial/answered | 1/1 |
| c37f65c9f0d543a35c784263b79236ccf1c44fac | 飞书问答 | 是 | no/no/yes | yes/yes | no/yes | new_success | partial/answered | 1/1 |
| b08f88d1facefceb87e134ba2c1fa90035018e83 | 桌面 | 是 | no/no/no | no/no | no/no | still_unsuccessful | unknown/unknown | 2/2 |
| b08f88d1facefceb87e134ba2c1fa90035018e83 | 飞书问答 | 是 | no/no/no | no/no | no/no | still_unsuccessful | unknown/unknown | 2/2 |
| 10fb7dc031075946153baf0a0599e126de29e3a4 | 桌面 | 是 | partial/partial/partial | partial/partial | partial/yes | still_unsuccessful | partial/partial | 1/2 |
| 10fb7dc031075946153baf0a0599e126de29e3a4 | 飞书问答 | 是 | partial/partial/yes | partial/partial | partial/yes | new_success | partial/answered | 2/2 |
| c5b0ed5db65051eebd858beaf303809aa815e8e5 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| c5b0ed5db65051eebd858beaf303809aa815e8e5 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 7ab9c0b4ceca1c142ff068f85015a249b14282d0 | 桌面 | 是 | partial/partial/yes | yes/yes | partial/yes | new_success | partial/answered | 1/1 |
| 7ab9c0b4ceca1c142ff068f85015a249b14282d0 | 飞书问答 | 是 | partial/no/yes | yes/yes | partial/yes | new_success | answered/answered | 1/1 |
| d28d86524292506d4b24ae2d486725a6d57a3db3 | 桌面 | 是 | yes/yes/no | yes/yes | yes/yes | regression | partial/unknown | 1/2 |
| d28d86524292506d4b24ae2d486725a6d57a3db3 | 飞书问答 | 是 | no/no/yes | yes/yes | no/yes | new_success | partial/answered | 1/1 |
| 63488da6c7aff9e374561a24ba224e9ce7f65e40 | 桌面 | 否 | yes/yes/yes | no/no | no/no | retained_success | unknown/unknown | 2/2 |
| 63488da6c7aff9e374561a24ba224e9ce7f65e40 | 飞书问答 | 否 | yes/yes/yes | no/no | no/no | retained_success | unknown/unknown | 2/2 |
| c1c44fd96c3fa6e16949ae8fa453e511c6435c68 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| c1c44fd96c3fa6e16949ae8fa453e511c6435c68 | 飞书问答 | 是 | no/no/yes | yes/yes | partial/yes | new_success | partial/answered | 1/1 |
| feafcc1c4026d7f55a2c8ce7850d7e12030b5c22 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | partial/answered | 1/2 |
| feafcc1c4026d7f55a2c8ce7850d7e12030b5c22 | 飞书问答 | 是 | partial/partial/yes | yes/yes | partial/yes | new_success | answered/answered | 1/1 |
| dd76130ec5fac477123fe8880472d03fbafddef6 | 桌面 | 是 | partial/partial/partial | yes/yes | partial/no | still_unsuccessful | partial/answered | 1/1 |
| dd76130ec5fac477123fe8880472d03fbafddef6 | 飞书问答 | 是 | partial/partial/partial | yes/yes | partial/no | still_unsuccessful | answered/answered | 1/1 |
| 78292bc57ee68fdb93ed45430d80acca25a9e916 | 桌面 | 是 | partial/yes/yes | yes/yes | partial/yes | retained_success | partial/answered | 1/1 |
| 78292bc57ee68fdb93ed45430d80acca25a9e916 | 飞书问答 | 是 | yes/yes/yes | yes/yes | partial/yes | retained_success | answered/answered | 1/1 |
| 2ea4347f1992b0b3958c4844681ff0fe4d0dd1dd | 桌面 | 是 | no/no/partial | yes/yes | no/partial | still_unsuccessful | partial/partial | 1/2 |
| 2ea4347f1992b0b3958c4844681ff0fe4d0dd1dd | 飞书问答 | 是 | no/no/partial | yes/yes | no/partial | still_unsuccessful | partial/partial | 1/2 |
| 7705dd04acedaefee30d8b2c9978537afb2040dc | 桌面 | 是 | no/no/no | partial/partial | no/no | still_unsuccessful | answered/unknown | 1/2 |
| 7705dd04acedaefee30d8b2c9978537afb2040dc | 飞书问答 | 是 | no/no/no | partial/partial | no/no | still_unsuccessful | partial/unknown | 1/2 |
| 784ce5a983c5f2cc95a2c60ce66f2a8a50f3636f | 桌面 | 是 | partial/partial/no | no/no | no/no | still_unsuccessful | partial/unknown | 1/2 |
| 784ce5a983c5f2cc95a2c60ce66f2a8a50f3636f | 飞书问答 | 是 | partial/partial/no | no/no | no/no | still_unsuccessful | partial/unknown | 2/2 |
| 7595260c5747aede0b32b7414e13899869209506 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 7595260c5747aede0b32b7414e13899869209506 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| ef3567ce7301b28e34377e7b62c4ec9b496f00bf | 桌面 | 是 | no/no/yes | yes/yes | no/yes | new_success | unknown/answered | 2/1 |
| ef3567ce7301b28e34377e7b62c4ec9b496f00bf | 飞书问答 | 是 | no/no/yes | yes/yes | no/yes | new_success | unknown/answered | 2/1 |
| 3355918bbdccac644afe441f085d0ffbbad565d7 | 桌面 | 是 | no/partial/partial | partial/yes | no/partial | still_unsuccessful | partial/partial | 1/2 |
| 3355918bbdccac644afe441f085d0ffbbad565d7 | 飞书问答 | 是 | no/no/partial | partial/yes | partial/partial | still_unsuccessful | partial/answered | 1/1 |
| 0d34c0812f1e69ea33f76ca8c24c23b0415ebc8d | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | partial/answered | 1/1 |
| 0d34c0812f1e69ea33f76ca8c24c23b0415ebc8d | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| cf171fad0bea5ab985c53d11e48e7883c23cdc44 | 桌面 | 是 | no/no/yes | yes/yes | partial/partial | new_success | unknown/answered | 1/1 |
| cf171fad0bea5ab985c53d11e48e7883c23cdc44 | 飞书问答 | 是 | partial/partial/yes | yes/yes | partial/partial | new_success | answered/answered | 1/1 |
| 2a564b092916f2fabbfe893cf13de169945ef2e1 | 桌面 | 是 | partial/partial/partial | yes/yes | partial/partial | still_unsuccessful | answered/partial | 1/2 |
| 2a564b092916f2fabbfe893cf13de169945ef2e1 | 飞书问答 | 是 | partial/partial/yes | yes/yes | partial/yes | new_success | answered/answered | 1/1 |
| bc4dca3e1e83f3b4bbb53a31557fc5d8971603b2 | 桌面 | 是 | partial/partial/yes | yes/yes | no/yes | new_success | partial/answered | 1/1 |
| bc4dca3e1e83f3b4bbb53a31557fc5d8971603b2 | 飞书问答 | 是 | partial/partial/yes | yes/yes | no/yes | new_success | partial/answered | 1/1 |
| 6b9b9e5d154cb963f6d921093539490daa5ebbae | 桌面 | 是 | partial/no/yes | yes/yes | no/yes | new_success | partial/partial | 1/2 |
| 6b9b9e5d154cb963f6d921093539490daa5ebbae | 飞书问答 | 是 | partial/no/yes | yes/yes | no/yes | new_success | partial/answered | 1/1 |
| 6844683935d0d8f588fa06530f5068bf3e1ed0c0 | 桌面 | 是 | yes/yes/no | yes/yes | yes/yes | regression | answered/unknown | 1/2 |
| 6844683935d0d8f588fa06530f5068bf3e1ed0c0 | 飞书问答 | 是 | yes/yes/no | yes/yes | yes/yes | regression | answered/unknown | 1/2 |
| f903396d943541a8cc65edefb04ca37814ed30dd | 桌面 | 否 | yes/yes/yes | no/no | no/no | retained_success | unknown/unknown | 2/2 |
| f903396d943541a8cc65edefb04ca37814ed30dd | 飞书问答 | 否 | yes/yes/yes | no/no | no/no | retained_success | unknown/unknown | 2/2 |
| d6ea7a30b0b61ae126b00b59d2a14fff2ef887bf | 桌面 | 是 | partial/partial/yes | partial/partial | partial/partial | new_success | partial/answered | 1/1 |
| d6ea7a30b0b61ae126b00b59d2a14fff2ef887bf | 飞书问答 | 是 | partial/partial/yes | partial/partial | partial/partial | new_success | partial/answered | 1/1 |
| b970f48d30775d3468952795bc72976baab3438e | 桌面 | 是 | partial/no/no | partial/partial | no/no | still_unsuccessful | partial/unknown | 1/2 |
| b970f48d30775d3468952795bc72976baab3438e | 飞书问答 | 是 | partial/no/no | partial/partial | no/no | still_unsuccessful | answered/answered | 1/1 |
| 975e60535724f4149c7488699a199ba2920a062c | 桌面 | 否 | no/no/no | no/no | no/no | still_unsuccessful | partial/partial | 2/2 |
| 975e60535724f4149c7488699a199ba2920a062c | 飞书问答 | 否 | no/no/no | no/no | no/no | still_unsuccessful | partial/answered | 2/2 |
| 126ff22bfcc14a2f7e1a06a91ba7b646003e9cf0 | 桌面 | 是 | no/no/yes | yes/yes | no/yes | new_success | partial/partial | 1/2 |
| 126ff22bfcc14a2f7e1a06a91ba7b646003e9cf0 | 飞书问答 | 是 | partial/partial/yes | yes/yes | partial/yes | new_success | answered/answered | 2/1 |
| 7e4ef0a4debc048b244b61b4f7dc2518b5b466c0 | 桌面 | 是 | partial/no/yes | yes/yes | no/yes | new_success | partial/answered | 1/1 |
| 7e4ef0a4debc048b244b61b4f7dc2518b5b466c0 | 飞书问答 | 是 | partial/partial/yes | yes/yes | partial/yes | new_success | answered/answered | 1/1 |
| 627b8d7b5b985394428c974aca5ba0c1bbbba377 | 桌面 | 否 | yes/yes/yes | no/no | no/no | retained_success | unknown/unknown | 2/2 |
| 627b8d7b5b985394428c974aca5ba0c1bbbba377 | 飞书问答 | 否 | yes/yes/yes | no/no | no/no | retained_success | unknown/unknown | 2/2 |
| deb89bca0925657e0f91ab5daca78b9e548de2bd | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| deb89bca0925657e0f91ab5daca78b9e548de2bd | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 9c33b340aefbc1f15b6eb6fb3e23ee615ce5b570 | 桌面 | 是 | no/no/yes | yes/yes | no/yes | new_success | partial/answered | 1/1 |
| 9c33b340aefbc1f15b6eb6fb3e23ee615ce5b570 | 飞书问答 | 是 | no/partial/yes | yes/yes | partial/yes | new_success | answered/answered | 2/1 |
| f9f59c171531c452bd2767dc332dc74cadee5120 | 桌面 | 是 | no/no/yes | yes/yes | no/yes | new_success | unknown/answered | 2/1 |
| f9f59c171531c452bd2767dc332dc74cadee5120 | 飞书问答 | 是 | no/no/yes | yes/yes | no/yes | new_success | unknown/answered | 2/1 |
| e6583c60b13b87fc37af75ffc975e7e316d4f4e0 | 桌面 | 是 | no/no/no | yes/yes | no/yes | still_unsuccessful | partial/unknown | 1/2 |
| e6583c60b13b87fc37af75ffc975e7e316d4f4e0 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 2/2 |
| a253749e3b4c4f340778235f640ce694642a4555 | 桌面 | 是 | partial/partial/yes | yes/yes | no/yes | new_success | partial/answered | 1/1 |
| a253749e3b4c4f340778235f640ce694642a4555 | 飞书问答 | 是 | partial/partial/yes | yes/yes | no/yes | new_success | answered/answered | 1/1 |
| 2da4c3679111dd92a1d0869dae353ebe5989dfd2 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 2da4c3679111dd92a1d0869dae353ebe5989dfd2 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 1142784dc4e0e4c0b4eca1feaf1c10dc46dd5891 | 桌面 | 是 | no/no/yes | yes/yes | no/yes | new_success | partial/answered | 1/1 |
| 1142784dc4e0e4c0b4eca1feaf1c10dc46dd5891 | 飞书问答 | 是 | no/no/yes | yes/yes | no/yes | new_success | answered/answered | 1/1 |
| f85f2a532e7e700d9f8f9c09cd08d4e47b87bdd3 | 桌面 | 是 | no/no/partial | partial/partial | no/yes | still_unsuccessful | partial/partial | 1/2 |
| f85f2a532e7e700d9f8f9c09cd08d4e47b87bdd3 | 飞书问答 | 是 | no/no/partial | partial/partial | no/yes | still_unsuccessful | partial/answered | 1/1 |
| adbf33c6144b2f5c40d0c6a328a92687a476f371 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| adbf33c6144b2f5c40d0c6a328a92687a476f371 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| f7a89b9cd2792f23f2cb43d50a01b8218a6fbb24 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| f7a89b9cd2792f23f2cb43d50a01b8218a6fbb24 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 7cd22ca9e107d2b13a7cc94252aaa9007976b338 | 桌面 | 是 | no/no/no | yes/yes | no/yes | still_unsuccessful | unknown/unknown | 2/2 |
| 7cd22ca9e107d2b13a7cc94252aaa9007976b338 | 飞书问答 | 是 | no/no/partial | yes/yes | no/yes | still_unsuccessful | unknown/answered | 2/1 |
| 1591068b747c94f45b948e12edafe74b5e721047 | 桌面 | 是 | no/no/no | yes/yes | no/no | still_unsuccessful | partial/unknown | 1/2 |
| 1591068b747c94f45b948e12edafe74b5e721047 | 飞书问答 | 是 | no/no/no | yes/yes | no/no | still_unsuccessful | unknown/unknown | 2/2 |
| ee7e9a948ee6888aa5830b1a3d0d148ff656d864 | 桌面 | 是 | no/no/yes | yes/yes | no/yes | new_success | unknown/answered | 2/1 |
| ee7e9a948ee6888aa5830b1a3d0d148ff656d864 | 飞书问答 | 是 | no/no/no | yes/yes | no/yes | still_unsuccessful | unknown/unknown | 2/2 |
| 506d21501d54a12d0c9fd3dbbf19067802439a04 | 桌面 | 是 | partial/partial/partial | partial/partial | partial/yes | still_unsuccessful | partial/partial | 1/2 |
| 506d21501d54a12d0c9fd3dbbf19067802439a04 | 飞书问答 | 是 | no/no/partial | partial/partial | partial/yes | still_unsuccessful | unknown/answered | 2/1 |
| 0689904db9b00a814e3109fb1698086370a28fa2 | 桌面 | 是 | partial/no/yes | yes/yes | no/yes | new_success | partial/answered | 1/1 |
| 0689904db9b00a814e3109fb1698086370a28fa2 | 飞书问答 | 是 | partial/no/yes | yes/yes | no/yes | new_success | answered/answered | 1/1 |
| 6cd25c637c6b772ce29e8ee81571e8694549c5ab | 桌面 | 是 | partial/partial/yes | yes/yes | partial/yes | new_success | partial/answered | 1/1 |
| 6cd25c637c6b772ce29e8ee81571e8694549c5ab | 飞书问答 | 是 | partial/partial/yes | yes/yes | no/yes | new_success | answered/answered | 1/1 |
| cb6a8c642575d3577d1840ca2f4cd2cc2c3397c5 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| cb6a8c642575d3577d1840ca2f4cd2cc2c3397c5 | 飞书问答 | 是 | yes/yes/partial | yes/yes | yes/yes | regression | answered/answered | 1/1 |
| c2e475adeddcdc4d637ef0d4f5065b6a9b299827 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| c2e475adeddcdc4d637ef0d4f5065b6a9b299827 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 56b7319be68197727baa7d498fa38af0a8440fe4 | 桌面 | 是 | partial/partial/no | partial/partial | partial/partial | still_unsuccessful | partial/unknown | 1/2 |
| 56b7319be68197727baa7d498fa38af0a8440fe4 | 飞书问答 | 是 | partial/partial/partial | partial/partial | partial/partial | still_unsuccessful | partial/answered | 1/2 |
| a1ac2a152710335519c9a907eec60d9f468b19db | 桌面 | 是 | no/no/yes | yes/yes | yes/yes | new_success | error_or_missing/answered | 1/1 |
| a1ac2a152710335519c9a907eec60d9f468b19db | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| c0bee6539eb6956a7347daa9d2419b367bd02064 | 桌面 | 是 | yes/yes/partial | yes/yes | partial/partial | regression | partial/answered | 1/2 |
| c0bee6539eb6956a7347daa9d2419b367bd02064 | 飞书问答 | 是 | yes/yes/partial | yes/yes | partial/partial | regression | answered/answered | 1/2 |
| 3de0487276bb5961586acc6e9f82934ef8cb668c | 桌面 | 是 | partial/partial/yes | yes/yes | partial/yes | new_success | partial/answered | 1/1 |
| 3de0487276bb5961586acc6e9f82934ef8cb668c | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 6b53e1f46ae4ba9b75117fc6e593abded89366be | 桌面 | 是 | no/no/yes | yes/yes | no/yes | new_success | partial/answered | 1/2 |
| 6b53e1f46ae4ba9b75117fc6e593abded89366be | 飞书问答 | 是 | no/no/yes | yes/yes | no/yes | new_success | partial/answered | 1/2 |
| 01e2d10178347d177519f792f86f25575106ddc7 | 桌面 | 是 | partial/partial/partial | yes/yes | partial/yes | still_unsuccessful | partial/partial | 1/2 |
| 01e2d10178347d177519f792f86f25575106ddc7 | 飞书问答 | 是 | partial/partial/partial | yes/yes | partial/partial | still_unsuccessful | answered/answered | 2/1 |
| 021bfb7e180d67112b74f05ecb3fa13acc036c86 | 桌面 | 是 | partial/partial/yes | yes/yes | partial/partial | new_success | partial/answered | 1/1 |
| 021bfb7e180d67112b74f05ecb3fa13acc036c86 | 飞书问答 | 是 | partial/partial/yes | yes/yes | partial/partial | new_success | answered/answered | 1/1 |
| 5c3e98e3cebaecd5d3e75ec2c9fc3dd267ac3c83 | 桌面 | 是 | no/no/partial | yes/yes | no/partial | still_unsuccessful | partial/partial | 1/2 |
| 5c3e98e3cebaecd5d3e75ec2c9fc3dd267ac3c83 | 飞书问答 | 是 | no/no/partial | yes/yes | no/no | still_unsuccessful | partial/answered | 1/2 |
| 62f27fe08ddb67f16857fab2a8a721926ecbb6fb | 桌面 | 是 | partial/partial/yes | yes/yes | partial/yes | new_success | partial/answered | 1/1 |
| 62f27fe08ddb67f16857fab2a8a721926ecbb6fb | 飞书问答 | 是 | partial/partial/yes | yes/yes | partial/yes | new_success | partial/answered | 1/1 |
| 14b8ae5656e7d4ee02237288372d9e682b24fdb8 | 桌面 | 是 | partial/partial/partial | yes/yes | no/yes | still_unsuccessful | partial/answered | 1/1 |
| 14b8ae5656e7d4ee02237288372d9e682b24fdb8 | 飞书问答 | 是 | partial/partial/partial | yes/yes | partial/yes | still_unsuccessful | answered/answered | 1/1 |
| e3a2d8886f03e78ed5e138df870f48635875727e | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | partial/partial | 1/2 |
| e3a2d8886f03e78ed5e138df870f48635875727e | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 4e1a67f8dc68b55a5ce18e6cd385ae9ab90d891f | 桌面 | 是 | partial/partial/partial | no/no | no/no | still_unsuccessful | partial/answered | 1/1 |
| 4e1a67f8dc68b55a5ce18e6cd385ae9ab90d891f | 飞书问答 | 是 | partial/partial/no | no/no | no/no | still_unsuccessful | answered/unknown | 1/2 |
| 6c96e910bd98c9fd58ba2050f99b9c9bac69840a | 桌面 | 否 | yes/yes/yes | no/no | no/no | retained_success | unknown/unknown | 2/2 |
| 6c96e910bd98c9fd58ba2050f99b9c9bac69840a | 飞书问答 | 否 | yes/yes/yes | no/no | no/no | retained_success | unknown/unknown | 2/2 |
| bfbd6040cb95b179118557352e8e3899ef25c525 | 桌面 | 否 | no/no/yes | no/no | no/no | new_success | partial/unknown | 1/2 |
| bfbd6040cb95b179118557352e8e3899ef25c525 | 飞书问答 | 否 | no/no/yes | no/no | no/no | new_success | partial/unknown | 2/2 |
| d6e353e0231d09fd5dcba493544d53706f3fe1ab | 桌面 | 是 | no/no/partial | yes/yes | no/partial | still_unsuccessful | partial/partial | 1/2 |
| d6e353e0231d09fd5dcba493544d53706f3fe1ab | 飞书问答 | 是 | no/no/partial | yes/yes | no/partial | still_unsuccessful | partial/partial | 1/2 |
| b1ce129678e37070e69f01332f1a8587e18e06b0 | 桌面 | 是 | no/no/no | yes/yes | no/yes | still_unsuccessful | partial/answered | 1/2 |
| b1ce129678e37070e69f01332f1a8587e18e06b0 | 飞书问答 | 是 | no/no/no | yes/yes | no/yes | still_unsuccessful | answered/answered | 1/2 |
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
| f2155dc4aeab86bf31a838c8ff388c85440fce6e | 桌面 | 是 | partial/partial/yes | yes/yes | partial/yes | new_success | partial/answered | 1/2 |
| f2155dc4aeab86bf31a838c8ff388c85440fce6e | 飞书问答 | 是 | partial/partial/partial | yes/yes | partial/yes | still_unsuccessful | answered/answered | 1/1 |
| ed6a15f0f7fa4594e51d5bde21cc0c6c1bedbfdc | 桌面 | 是 | no/no/no | partial/yes | no/no | still_unsuccessful | partial/unknown | 1/2 |
| ed6a15f0f7fa4594e51d5bde21cc0c6c1bedbfdc | 飞书问答 | 是 | no/no/partial | partial/yes | no/partial | still_unsuccessful | unknown/partial | 2/2 |
| 86bf75245358f17e35fc133e46a92439ac86d472 | 桌面 | 是 | partial/partial/yes | yes/yes | partial/yes | new_success | partial/answered | 1/2 |
| 86bf75245358f17e35fc133e46a92439ac86d472 | 飞书问答 | 是 | partial/partial/yes | yes/yes | partial/yes | new_success | answered/answered | 1/1 |
| 9132d56e26844dc13b3355448d0f14b95bd2178a | 桌面 | 是 | no/partial/yes | yes/yes | no/yes | new_success | partial/answered | 1/1 |
| 9132d56e26844dc13b3355448d0f14b95bd2178a | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | partial/answered | 1/1 |
| 22732cb9476e521452bf0538f3fdb94cf3867651 | 桌面 | 否 | no/no/yes | no/no | no/no | new_success | partial/unknown | 1/2 |
| 22732cb9476e521452bf0538f3fdb94cf3867651 | 飞书问答 | 否 | no/no/no | no/no | partial/no | still_unsuccessful | partial/answered | 1/1 |
| bbb77f2d6685c9257763ca38afaaef29044b4018 | 桌面 | 是 | no/no/no | partial/yes | no/no | still_unsuccessful | partial/unknown | 1/2 |
| bbb77f2d6685c9257763ca38afaaef29044b4018 | 飞书问答 | 是 | no/no/no | partial/yes | no/no | still_unsuccessful | partial/unknown | 1/2 |
| 4e748cb2b5e74d905d9b24b53be6cfdf326e8054 | 桌面 | 否 | no/no/no | no/no | no/no | still_unsuccessful | partial/partial | 1/2 |
| 4e748cb2b5e74d905d9b24b53be6cfdf326e8054 | 飞书问答 | 否 | no/no/no | no/no | no/no | still_unsuccessful | partial/answered | 2/1 |
| 4d47bef19afd70c10bbceafd1846516546641a2f | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 4d47bef19afd70c10bbceafd1846516546641a2f | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 4fa6fbb9df1a4c32583d4ef70d2b29ece4b3d802 | 桌面 | 是 | no/no/yes | yes/yes | no/yes | new_success | partial/partial | 1/2 |
| 4fa6fbb9df1a4c32583d4ef70d2b29ece4b3d802 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 6ca938324dc7e1742a840d0a54dc13cc207394a1 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/partial | 2/2 |
| 6ca938324dc7e1742a840d0a54dc13cc207394a1 | 飞书问答 | 是 | partial/partial/partial | yes/yes | partial/partial | still_unsuccessful | partial/answered | 1/1 |
| 20e38438471266ce021817c6364f6a46d01564f2 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | partial/answered | 1/1 |
| 20e38438471266ce021817c6364f6a46d01564f2 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 72f7ef55e150e16dcf97fe443aff9971a32414ef | 桌面 | 是 | yes/yes/no | yes/yes | yes/yes | regression | partial/unknown | 2/2 |
| 72f7ef55e150e16dcf97fe443aff9971a32414ef | 飞书问答 | 是 | no/no/no | yes/yes | no/yes | still_unsuccessful | unknown/unknown | 2/2 |
| 23b2901264bda91045258b5d4120879ae292e950 | 桌面 | 是 | no/no/yes | yes/yes | no/yes | new_success | partial/partial | 1/2 |
| 23b2901264bda91045258b5d4120879ae292e950 | 飞书问答 | 是 | no/no/partial | yes/yes | no/yes | still_unsuccessful | partial/answered | 2/2 |
| b5bc34e1e381dbf972d0b594fe8c66ff75305d71 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/2 |
| b5bc34e1e381dbf972d0b594fe8c66ff75305d71 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 022c365a14fdec406c7a945a1a18e7e79df37f08 | 桌面 | 是 | partial/partial/partial | yes/yes | no/partial | still_unsuccessful | partial/answered | 1/1 |
| 022c365a14fdec406c7a945a1a18e7e79df37f08 | 飞书问答 | 是 | partial/partial/partial | yes/yes | no/partial | still_unsuccessful | answered/answered | 1/1 |
| af34051bf3e628c1e2a00b110bb84e5f018b419f | 桌面 | 是 | partial/partial/yes | yes/yes | partial/partial | new_success | partial/answered | 1/1 |
| af34051bf3e628c1e2a00b110bb84e5f018b419f | 飞书问答 | 是 | partial/partial/yes | yes/yes | partial/partial | new_success | partial/answered | 1/1 |
| 876700622bd6811d903e65314ac75971bbe23dcc | 桌面 | 是 | partial/partial/no | yes/yes | partial/yes | still_unsuccessful | partial/error_or_missing | 1/1 |
| 876700622bd6811d903e65314ac75971bbe23dcc | 飞书问答 | 是 | partial/partial/partial | yes/yes | partial/yes | still_unsuccessful | answered/answered | 1/1 |
| 37edc25e39515ffc2d92115d2fcd9e6ceb18898b | 桌面 | 是 | partial/partial/partial | yes/yes | partial/yes | still_unsuccessful | partial/partial | 1/2 |
| 37edc25e39515ffc2d92115d2fcd9e6ceb18898b | 飞书问答 | 是 | partial/partial/partial | yes/yes | partial/yes | still_unsuccessful | answered/answered | 1/1 |
| e44a6bf67ce3fde0c6608b150030e44d87eb25e3 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | partial/answered | 1/1 |
| e44a6bf67ce3fde0c6608b150030e44d87eb25e3 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 6a31db1aca57a818f36bba9002561724655372a7 | 桌面 | 是 | no/no/yes | yes/yes | no/yes | new_success | unknown/partial | 2/2 |
| 6a31db1aca57a818f36bba9002561724655372a7 | 飞书问答 | 是 | no/no/yes | yes/yes | no/yes | new_success | unknown/answered | 2/2 |
| 37a79be0148e1751ffb2daabe4c8ec6680036106 | 桌面 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |
| 37a79be0148e1751ffb2daabe4c8ec6680036106 | 飞书问答 | 是 | yes/yes/yes | yes/yes | yes/yes | retained_success | answered/answered | 1/1 |

## 确定性检查与门槛

确定性检查通过，11条命令。评分规则指纹和源码/二进制指纹保存在机器JSON。

| 命令 | 退出码 | 日志 |
| --- | --- | --- |
| cargo.exe test -p project-assistant-core --locked | 0 | .local-data\retrieval-regressions-nV4HxW\1.log |
| cargo.exe clippy -p project-assistant-core --locked --lib --tests -- -D warnings | 0 | .local-data\retrieval-regressions-nV4HxW\2.log |
| cargo.exe build -p project-assistant-core --bin pm-host --locked | 0 | .local-data\retrieval-regressions-nV4HxW\3.log |
| powershell.exe -NoProfile -Command npm run build | 0 | .local-data\retrieval-regressions-nV4HxW\4.log |
| node.exe --test scripts/score-memory-public-live.test.mjs scripts/memory-public-live-options.test.mjs scripts/evaluate-memory-quality.test.mjs scripts/check-memory-public-development.test.mjs scripts/report-memory-extraction-optimized.test.mjs scripts/check-memory-retrieval-development.test.mjs scripts/report-memory-retrieval-optimized.test.mjs | 0 | .local-data\retrieval-regressions-nV4HxW\5.log |
| node.exe scripts/verify-restart.mjs | 0 | .local-data\retrieval-regressions-nV4HxW\6.log |
| node.exe scripts/verify-extraction-recovery.mjs | 0 | .local-data\retrieval-regressions-nV4HxW\7.log |
| node.exe scripts/verify-memory-public-live.mjs --no-write | 0 | .local-data\retrieval-regressions-nV4HxW\8.log |
| node.exe scripts/verify-memory-public-live.mjs docs/memory-public-live-optimized-dev-v2-results.json --no-write | 0 | .local-data\retrieval-regressions-nV4HxW\9.log |
| node.exe scripts/verify-memory-public-live.mjs docs/memory-public-live-optimized-full-results.json --no-write | 0 | .local-data\retrieval-regressions-nV4HxW\10.log |
| cargo.exe test -p project-assistant-core --lib --locked diagnose_public_live_retrieval -- --ignored --nocapture | 0 | .local-data\retrieval-regressions-nV4HxW\11.log |

| 门槛 | 通过 | 实际观测 |
| --- | --- | --- |
| frozen_development_scope | 是 | {"papers":6,"questions":20,"answerable":19,"unanswerable":1} |
| complete_run | 是 | {"complete":true,"haltReason":null} |
| extraction_jobs_completed | 是 | 6 |
| nonempty_confirmed_memory_per_paper | 是 | [{"id":"1603.01514","memories":134},{"id":"1806.00738","memories":47},{"id":"1902.09666","memories":77},{"id":"1908.07245","memories":67},{"id":"1902.09243","memories":134},{"id":"1705.01214","memories":472}] |
| integrity_verified | 是 | [{"file":"docs/memory-public-live-retrieval-dev-v2-results.json","passed":true}] |
| deterministic_regressions_passed | 是 | [{"command":"cargo.exe test -p project-assistant-core --locked","exitCode":0,"elapsedMs":35100,"log":".local-data\\retrieval-regressions-nV4HxW\\1.log"},{"command":"cargo.exe clippy -p project-assistant-core --locked --lib --tests -- -D warnings","exitCode":0,"elapsedMs":694,"log":".local-data\\retrieval-regressions-nV4HxW\\2.log"},{"command":"cargo.exe build -p project-assistant-core --bin pm-host --locked","exitCode":0,"elapsedMs":670,"log":".local-data\\retrieval-regressions-nV4HxW\\3.log"},{"command":"powershell.exe -NoProfile -Command npm run build","exitCode":0,"elapsedMs":12070,"log":".local-data\\retrieval-regressions-nV4HxW\\4.log"},{"command":"node.exe --test scripts/score-memory-public-live.test.mjs scripts/memory-public-live-options.test.mjs scripts/evaluate-memory-quality.test.mjs scripts/check-memory-public-development.test.mjs scripts/report-memory-extraction-optimized.test.mjs scripts/check-memory-retrieval-development.test.mjs scripts/report-memory-retrieval-optimized.test.mjs","exitCode":0,"elapsedMs":257,"log":".local-data\\retrieval-regressions-nV4HxW\\5.log"},{"command":"node.exe scripts/verify-restart.mjs","exitCode":0,"elapsedMs":4610,"log":".local-data\\retrieval-regressions-nV4HxW\\6.log"},{"command":"node.exe scripts/verify-extraction-recovery.mjs","exitCode":0,"elapsedMs":6539,"log":".local-data\\retrieval-regressions-nV4HxW\\7.log"},{"command":"node.exe scripts/verify-memory-public-live.mjs --no-write","exitCode":0,"elapsedMs":657,"log":".local-data\\retrieval-regressions-nV4HxW\\8.log"},{"command":"node.exe scripts/verify-memory-public-live.mjs docs/memory-public-live-optimized-dev-v2-results.json --no-write","exitCode":0,"elapsedMs":310,"log":".local-data\\retrieval-regressions-nV4HxW\\9.log"},{"command":"node.exe scripts/verify-memory-public-live.mjs docs/memory-public-live-optimized-full-results.json --no-write","exitCode":0,"elapsedMs":909,"log":".local-data\\retrieval-regressions-nV4HxW\\10.log"},{"command":"cargo.exe test -p project-assistant-core --lib --locked diagnose_public_live_retrieval -- --ignored --nocapture","exitCode":0,"elapsedMs":9051,"log":".local-data\\retrieval-regressions-nV4HxW\\11.log"}] |
| no_cross_project_citations | 是 | 0 |
| all_isolated_judgments_available | 是 | 20 |
| question_information_retained | 是 | 17 |
| desktop_complete_answers | 是 | 9 |
| desktop_correct_abstention | 是 | 1 |
| connector_complete_answers | 是 | 13 |
| connector_correct_abstention | 是 | 1 |
| pre_registered_thresholds | 是 | {"retainedYesOrPartial":15,"desktopComplete":9,"connectorComplete":9,"desktopReferencesSufficient":11,"connectorReferencesSufficient":9,"desktopCorrectAbstention":1,"connectorCorrectAbstention":1,"desktopPairedNetImprovement":1,"connectorPairedNetImprovement":1} |
| registration_and_tests_precede_live_run | 是 | {"registeredAt":"2026-10-20T12:12:25.834Z","testsFinishedAt":"2026-10-20T12:43:41.848Z","liveStartedAt":"2026-10-20T12:43:56.353Z"} |
| same_frozen_dataset_and_model | 是 | {"datasetSha256":"803537c32e89dce765c8e6cef6484f332d6ef5a9c91b726a4ea957e68b461d87","model":"deepseek-flash"} |
| paired_baseline_is_previous_development | 是 | {"file":"docs\\memory-public-live-optimized-dev-v2-results.json","workspace":".local-data\\public-memory-live-wfIe3l","binarySha256":"e9e9e1d05b16bdcc96339a310190ccbe7b8b92e89532de23047b99631a518582"} |
| same_development_questions | 是 | ["747b847d687f703cc20a87877c5b138f26ff137d","111afb77cfbf4c98e0458606378fa63a0e965e36","50cc6c5f2dcf5fb87b56007f6a825fa7c90b64ed","6bf5620f295b5243230bc97b340fae6e92304595","1be54c5b3ea67d837ffba2290a40c1e720d9587f","584af673429c7f8621c6bf83362a37048daa0e5d","c37f65c9f0d543a35c784263b79236ccf1c44fac","b08f88d1facefceb87e134ba2c1fa90035018e83","55bd59076a49b19d3283af41c5e3ccb875f3eb0c","5daeb8d4d6f3b8543ec6309a7a35523e160437eb","521280a87c43fcdf9f577da235e7072a23f0673e","5a8cc8f80509ea77d8213ed28c5ead501c68c725","10fb7dc031075946153baf0a0599e126de29e3a4","c5b0ed5db65051eebd858beaf303809aa815e8e5","7ab9c0b4ceca1c142ff068f85015a249b14282d0","d28d86524292506d4b24ae2d486725a6d57a3db3","63488da6c7aff9e374561a24ba224e9ce7f65e40","c1c44fd96c3fa6e16949ae8fa453e511c6435c68","feafcc1c4026d7f55a2c8ce7850d7e12030b5c22","dd76130ec5fac477123fe8880472d03fbafddef6"] |
| extraction_implementation_unchanged | 是 | {"ai.rs":"3955214b5d9eb0b4a427f40e9c3fd954eac4835b24687924a83980426d38f17e","extraction_store.rs":"013aa5df7efe9051bdab8c96d0084e37ffd4a3c33ca6a1e12f3fb51a3a9aecbc"} |
| tested_source_and_binary_match | 是 | {"sourceMatch":true,"binaryMatch":true} |
| tested_evaluation_rules_match | 是 | {"scripts/evaluate-memory-public-live.mjs":"d3366b303ad3a4ed16c5f8b2caa21b7711a810fa5d532747c1652d70bb735933","scripts/memory-public-live-judges.mjs":"d82723ddcdd217c7275d8a69e37baece19afdf7eea8c5215a3b514e72ff044bd","scripts/memory-public-live-options.mjs":"57f001110417f318ec5dff909388fd4911b7fc78aa189eecd063f5df283d1e61","scripts/memory-public-live-io.mjs":"e6f1b2d4576661ffaabaffa71dbb7c2ad32a4233783a511a06ccc196e02cc74d","scripts/score-memory-public-live.mjs":"37efee7b8ea946ba9da29ff6367e22a99f0c968cc85e2111152a70f7734e677e","scripts/compare-memory-public-live.mjs":"2699e6c1c044221602c2b9aac8e1dd745676747f08ae23b7600194aba72bc834","scripts/check-memory-public-development.mjs":"a01c4f7c59a75c8dbe9563878fa535acae9e6333ee2a661c33e0dbe4f84b171c","scripts/check-memory-retrieval-development.mjs":"d3c78cc04f2104c8da7101dfe9e4e669532d9d2df16e49ffb15a9e0d2a562f2b","scripts/memory-retrieval-evaluation-files.mjs":"431f3dd5e2f18a78558883ef81a6c75a541161aa9111fa69a232c1e86949d414","docs/memory-retrieval-preregistration.json":"2fdeb2bd1be262c808c3d147e991ae7bc07df7fc2587e9cb7747dfde4124a08b","scripts/verify-memory-public-live.mjs":"ee595e6b47cc934700d356b951ad51d8fade1f76a74018a7e781c8f39f916dac","docs/memory-retrieval-evaluator-amendment.md":"ba5c91b05193237c2def80c39c05f1df3f365f5f50eff89f47796b0b2996dcd7"} |
| desktop_improved_complete_answers | 是 | 9 |
| desktop_improved_reference_sufficiency | 是 | 16 |
| desktop_refusal_regression_guard | 是 | 1 |
| desktop_all_answers_paired | 是 | 20 |
| desktop_paired_net_improvement | 是 | {"newComplete":9,"pairedPreviousComplete":6,"netImprovement":3} |
| connector_improved_complete_answers | 是 | 13 |
| connector_improved_reference_sufficiency | 是 | 16 |
| connector_refusal_regression_guard | 是 | 1 |
| connector_all_answers_paired | 是 | 20 |
| connector_paired_net_improvement | 是 | {"newComplete":13,"pairedPreviousComplete":7,"netImprovement":6} |

同记忆本地只读诊断：`.local-data\retrieval-regressions-nV4HxW\same-memory-retrieval-diagnostic.json`。复用上一轮真实记忆和已记录rewrite，不调用LLM；normal/withoutFacets结果仅排查检索，不替代本轮重新提取的完整链路分数。

完整指标、逐题变化、评分修复审计：[机器JSON](memory-retrieval-optimized-metrics.json)。[上一轮完整链路报告](memory-extraction-optimized-report.md)。

## 限制

- 参考充分和答案正确均是自动评分，不能代替独立人工标注；断言精确率未测。
- 9道无答案题样本很小，拒答改进或退化均单列；不得混入91道可答题准确率。
- 公开英文论文不等于中文业务记忆；未覆盖长期冲突、更新、遗忘与全生命周期。
- 报告生成只读取保存工件，不产生真实模型调用。
