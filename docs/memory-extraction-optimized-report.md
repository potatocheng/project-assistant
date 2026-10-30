# 提取预算与组织校验优化：真实LLM完整链路复测

生成时间：2026-10-20T12:03:05.550Z。模型：`deepseek-flash`。QASPER冻结数据，CC BY 4.0，[数据来源和适配](memory-public-datasets.md)。

## 执行范围与结论

当前开发集：已完成；预注册门槛：通过；门槛与开发工件匹配：是。

已提供全量运行工件，实际记录100题；100题完整运行已完成。全量与当前门槛/源码匹配：是。

91道可答题：桌面完整答对 0/91 → 31/91；飞书问答完整答对 0/91 → 33/91。9道无答案题分别计分。

正文留存、检索与回答使用隔离上下文评分；答案新旧匿名配对评分。评分器仍是同一模型，尚无独立人工复核。原80题已参与问题分析，现为固定回归集。

本次提供的3个不同新运行工件合计1710次真实调用、7,118,125个已报告token；不含历史baseline与原段落对照。

## 方案与边界

提取采用2400字符窗口、6144输出token、12条记忆/4条任务/合计16条上限；Rust执行长度和数量校验，仅对明确输出容量错误有界拆分。任务限制512次请求、300万token和20分钟，缺usage及在途请求保守预留，恢复与还原保留预算高水位。逐批事务保存草稿，保留失败前成果；待确认候选和范围待审核草稿均不参与正式检索。

仅导航topic错误可隔离标签并保留原值。主体、角色、条件、有效期问题转待审核；本次评测未代替人工修正或放行。正式记忆只来自实际模型ready候选的原样确认。研究论文中的语义断言精确率没有独立标签，本报告记为null。

当前修订改变了下游源码：`qa.rs`、`assistant_qa.rs`、`answer_contract.rs`、`question_flow.rs`。第二轮包含提取和问答输入/协议修复，不再声称QA固定，不能将联合增益全部归因给提取。

## 完整100题：优化前后链路总览

| 环节 | 优化前 | 优化后 |
| --- | --- | --- |
| 提取任务成功 | 7/36 | 36/36 |
| 正式记忆 | 1 | 4571 |
| 正式记忆正文信息充分 | 旧联合评分不作阶段归因 | 78/91充分，10题部分保留 |
| 桌面实际生成参考充分 | 旧联合评分不作阶段归因 | 33/91（36.3%） |
| 飞书问答实际生成参考充分 | 旧联合评分不作阶段归因 | 32/91（35.2%） |
| 桌面完整答对 | 0/91（0.0%） | 31/91（34.1%） |
| 飞书问答完整答对 | 0/91（0.0%） | 33/91（36.3%） |
| 桌面无答案题正确拒答 | 9/9（100.0%） | 5/9（55.6%） |
| 飞书问答无答案题正确拒答 | 9/9（100.0%） | 5/9（55.6%） |
| 提取请求 / 已报告token | 119 / 737,206 | 490 / 2,026,410 |

提取任务完成率明显提高，范围待审核20条，未审草稿进入正式记忆0条。记忆条数增加不是语义精确率的证明；该指标仍缺独立人工标签。

当前主要损失出现在检索和上下文选择：78题的正式记忆正文被评为充分，但实际生成参考仅桌面33题、飞书问答32题充分。参考充分时，完整答对分别为30/33（90.9%）和30/32（93.8%）。这是隔离自动评分得到的排查方向，尚不是单项因果验证。

无答案题存在明确退化：两个入口均从9/9（100.0%）降到5/9（55.6%）。下一轮应同时改进检索候选与上下文组装、补充无答案拒答回归。当前完整回答结果仍低于跳过提取的原段落诊断对照；对照不代表真实完整链路。

已导出[定向人工复核样本](../.local-data/public-memory-live-DRCwWA/review-sample.json)：20条记忆/草稿、10道问题。样本按固定分层规则选取，尚无独立人工评定，不能估计总体精确率。

## 三阶段开发集对比

| 修订 | 正式记忆 | 正文信息留存 | 桌面完整正确 | 飞书完整正确 | 范围待审 | 调用 | token | 门槛 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 旧baseline | 0 | 旧联合评分不作阶段归因 | 0/19（0.0%） | 0/19（0.0%） | 不适用 | 详见旧工件 | 旧工件 | 历史结果 |
| 首轮：仅提取v5 | 765 | 12/19（yes或partial） | 2/19（10.5%） | 2/19（10.5%） | 228 | 224 | 1,012,992 | 未通过 |
| 第二轮：提取v6＋QA输入/协议 | 944 | 18/19（yes或partial） | 7/19（36.8%） | 7/19（36.8%） | 1 | 246 | 1,008,603 | 通过 |

首轮失败门槛与原始分数保留；第二轮门槛条件与首轮一致：是。

各轮旧baseline答案会在同次匿名配对评分中重新打分，原始旧分与配对旧分均保存在机器JSON。同模型重复评分会漂移；首轮与第二轮并非同一次相互匿名配对，不能把二者差值当独立验证或单项因果增益。

## 首轮开发集：提取v5（原始失败结果）

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

正文信息留存（可答题，memory-only隔离评分）：yes 11；no 7；partial 1。

| 入口 | 完整答对 | 部分答对 | 无答案题正确拒答 | 协议错误/全部QA错误 | 可答题拒答或不具依据 | p50/p95秒 |
| --- | --- | --- | --- | --- | --- | --- |
| 桌面 | 2/19（10.5%） | 1/19（5.3%） | 1/1（100.0%） | 11/11 | 3/19（15.8%） | 2.9/4.4 |
| 飞书问答 | 2/19（10.5%） | 1/19（5.3%） | 1/1（100.0%） | 13/13 | 3/19（15.8%） | 1.9/2.7 |

| 入口 | 实际最后生成参考正文充分性 | 记忆充分时完整召回 | 参考充分时完整答对 |
| --- | --- | --- | --- |
| 桌面 | yes 7；no 8；partial 4 | 6/11（54.5%） | 2/7（28.6%） |
| 飞书问答 | yes 6；no 8；partial 5 | 5/11（45.5%） | 2/6（33.3%） |

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

互斥首次损失标签：桌面 success 2；answer_protocol_error 4；memory_content_missing 8；retrieval_context_loss 5；飞书问答 success 2；answer_protocol_error 3；memory_content_missing 8；retrieval_context_loss 6。这些标签用于排查，不能证明因果。

评分器API格式重评：无已记录重评；当前评分错误0题。

## 第二轮开发集：提取v6＋QA输入/协议

6篇、20题（可答19、无答案1）；完成：是；评分模式：`separated`。

| 提取与组织观测 | 结果 |
| --- | --- |
| 任务终态 | succeeded 6 |
| 错误码 / 任务预算失败 | 无 / 0 |
| 正式记忆正文 | 944 |
| 草稿总数 / 范围待审核 | 960 / 1 |
| topic隔离 / 仅topic隔离且ready | 2 / 2 |
| 草稿状态 | ready 959；needs_review 1 |
| 批次终态 | succeeded 100 |
| 未审草稿进入正式记忆 | 0 |
| 完整JSON响应 / 恰达12条记忆 / 4条任务 / 合计16 | 100 / 21 / 0 / 0 |

恰达上限的批次可能存在信息压缩，单列为饱和信号，不能直接算遗漏。topic隔离可能与关键范围问题重叠；待审核草稿未自动放行。

正文信息留存（可答题，memory-only隔离评分）：yes 17；no 1；partial 1。

| 入口 | 完整答对 | 部分答对 | 无答案题正确拒答 | 协议错误/全部QA错误 | 可答题拒答或不具依据 | p50/p95秒 |
| --- | --- | --- | --- | --- | --- | --- |
| 桌面 | 7/19（36.8%） | 7/19（36.8%） | 1/1（100.0%） | 1/1 | 1/19（5.3%） | 3.2/4.5 |
| 飞书问答 | 7/19（36.8%） | 6/19（31.6%） | 1/1（100.0%） | 0/0 | 2/19（10.5%） | 2.8/3.5 |

| 入口 | 实际最后生成参考正文充分性 | 记忆充分时完整召回 | 参考充分时完整答对 |
| --- | --- | --- | --- |
| 桌面 | yes 9；no 6；partial 4 | 9/17（52.9%） | 7/9（77.8%） |
| 飞书问答 | yes 7；no 7；partial 5 | 7/17（41.2%） | 6/7（85.7%） |

检索充分性由独立上下文的retrieval-only调用判断实际送给最后一次生成的正文；这是同模型自动估计。来源段落ID命中不能代替正文信息充分性。

| 入口 | 同题优化前→后完整答对 | 新增成功 | 退化 | 同次匿名配对评分 |
| --- | --- | --- | --- | --- |
| 桌面 | 0/19 → 7/19 | 7 | 0 | 20/20 |
| 飞书问答 | 0/19 → 7/19 | 7 | 0 | 20/20 |

旧原段落诊断对照（相同问题；跳过提取，不能当完整链路）：桌面 7/19（36.8%）；飞书问答 7/19（36.8%）。

| 阶段 | 调用 | 输入token | 输出token | 总token | 缺usage | 请求耗时累计秒 |
| --- | --- | --- | --- | --- | --- | --- |
| extraction:extraction | 100 | 287293 | 149442 | 436735 | 0 | 466.7 |
| qa:generation | 45 | 121504 | 14857 | 136361 | 0 | 76.4 |
| qa:answer_review | 34 | 48898 | 3153 | 52051 | 0 | 39.5 |
| qa:query_rewrite | 5 | 9531 | 111 | 9642 | 0 | 3.9 |
| judge:answer | 22 | 33432 | 2983 | 36415 | 0 | 27.7 |
| judge:memory | 20 | 306536 | 2821 | 309357 | 0 | 29.4 |
| judge:retrieval | 20 | 26335 | 1707 | 28042 | 0 | 21.4 |

本次246次调用、1,008,603个已报告token；实际墙钟10.8分钟。并发请求耗时不能相加当墙钟。

问答错误码：桌面 ASSISTANT_GROUNDING 1；飞书问答 无。

互斥首次损失标签：桌面 answer_protocol_error 1；retrieval_context_loss 8；success 7；answer_error_or_refusal 1；memory_content_missing 2；飞书问答 success 7；retrieval_context_loss 9；answer_error_or_refusal 1；memory_content_missing 2。这些标签用于排查，不能证明因果。

### 评分器API格式重评记录

历史有2题、2个阶段进入一次显式格式重评（answer 2）；额外2次请求、3,498个已报告token，已包含在本运行总使用量。当前仍有评分错误0题。当前错误为0也不表示首轮没有坏JSON输出。

重评只覆盖原有parser/schema失败的评估阶段；原judgment和全部收据保留，不重跑合法评估阶段、生产提取或问答，不在多个合法分数间挑选。此次为评分格式恢复，不是生产重试，仍属于同模型自动评估。

| 题号 | 重评阶段 | 原错误 | 当前阶段错误 | 新请求ID |
| --- | --- | --- | --- | --- |
| 747b847d687f703cc20a87877c5b138f26ff137d | answer | Expected ',' or '}' after property value in JSON at position 517 (line 1 column 518) | 无 | 245 |
| 7ab9c0b4ceca1c142ff068f85015a249b14282d0 | answer | Expected ',' or '}' after property value in JSON at position 651 (line 1 column 652) | 无 | 246 |

重评收据中的生产请求：0；原始judgment保留：是。

### 已缓存评分JSON的确定性语法恢复

记录1条、涉及1题（answer 1），收据ID：246。额外API调用0次、额外token为0；原响应本身的调用和usage已在总量中计算。

规则严格限定为在已收到的JSON末尾追加一个根对象右括号 `}`；随后执行原有schema和记忆ID白名单校验，不修改分数字符串或其他字段。原始收据、原文与修复文本SHA256均保留。这是离线/本地解析恢复，不是再次LLM评审或生产流程恢复；若发生在API格式重评之后，也不会再增加调用。

| 题号 | 阶段 | 收据ID | 原错误 | 原文本SHA256 | 恢复文本SHA256 |
| --- | --- | --- | --- | --- | --- |
| 7ab9c0b4ceca1c142ff068f85015a249b14282d0 | answer | 246 | Expected ',' or '}' after property value in JSON at position 509 (line 1 column 510) | 47df63862f81e0cdc3a1df674b024b89af5fe2dc4e4fd0bca996f81ef5b9a264 | 3bfe5b5ead680fbad156f7a15a084e1eea8f967e5a0674f74ee903ca9cdf1521 |

符合单个右括号规则1/1条，完整记录双SHA256为1/1条。

## 固定100题全量回归

36篇、100题（可答91、无答案9）；完成：是；评分模式：`separated`。

| 提取与组织观测 | 结果 |
| --- | --- |
| 任务终态 | succeeded 36 |
| 错误码 / 任务预算失败 | 无 / 0 |
| 正式记忆正文 | 4571 |
| 草稿总数 / 范围待审核 | 4664 / 20 |
| topic隔离 / 仅topic隔离且ready | 2 / 2 |
| 草稿状态 | ready 4644；needs_review 20 |
| 批次终态 | succeeded 490 |
| 未审草稿进入正式记忆 | 0 |
| 完整JSON响应 / 恰达12条记忆 / 4条任务 / 合计16 | 490 / 101 / 4 / 2 |

恰达上限的批次可能存在信息压缩，单列为饱和信号，不能直接算遗漏。topic隔离可能与关键范围问题重叠；待审核草稿未自动放行。

正文信息留存（可答题，memory-only隔离评分）：yes 78；no 3；partial 10。

| 入口 | 完整答对 | 部分答对 | 无答案题正确拒答 | 协议错误/全部QA错误 | 可答题拒答或不具依据 | p50/p95秒 |
| --- | --- | --- | --- | --- | --- | --- |
| 桌面 | 31/91（34.1%） | 32/91（35.2%） | 5/9（55.6%） | 1/1 | 7/91（7.7%） | 3.5/4.9 |
| 飞书问答 | 33/91（36.3%） | 32/91（35.2%） | 5/9（55.6%） | 0/0 | 10/91（11.0%） | 3.0/4.9 |

| 入口 | 实际最后生成参考正文充分性 | 记忆充分时完整召回 | 参考充分时完整答对 |
| --- | --- | --- | --- |
| 桌面 | yes 33；no 37；partial 21 | 33/78（42.3%） | 30/33（90.9%） |
| 飞书问答 | yes 32；no 32；partial 27 | 32/78（41.0%） | 30/32（93.8%） |

检索充分性由独立上下文的retrieval-only调用判断实际送给最后一次生成的正文；这是同模型自动估计。来源段落ID命中不能代替正文信息充分性。

| 入口 | 同题优化前→后完整答对 | 新增成功 | 退化 | 同次匿名配对评分 |
| --- | --- | --- | --- | --- |
| 桌面 | 0/91 → 31/91 | 31 | 0 | 100/100 |
| 飞书问答 | 0/91 → 33/91 | 33 | 0 | 100/100 |

旧原段落诊断对照（相同问题；跳过提取，不能当完整链路）：桌面 41/91（45.1%）；飞书问答 48/91（52.7%）。

| 阶段 | 调用 | 输入token | 输出token | 总token | 缺usage | 请求耗时累计秒 |
| --- | --- | --- | --- | --- | --- | --- |
| extraction:extraction | 490 | 1307287 | 719123 | 2026410 | 0 | 2237.0 |
| qa:generation | 237 | 638169 | 76283 | 714452 | 0 | 393.8 |
| qa:answer_review | 172 | 247850 | 15957 | 263807 | 0 | 194.4 |
| qa:query_rewrite | 41 | 100093 | 994 | 101087 | 0 | 33.5 |
| judge:answer | 100 | 158622 | 13462 | 172084 | 0 | 133.2 |
| judge:memory | 100 | 1660492 | 14738 | 1675230 | 0 | 157.7 |
| judge:retrieval | 100 | 134740 | 8720 | 143460 | 0 | 117.8 |

本次1240次调用、5,096,530个已报告token；实际墙钟24.1分钟。并发请求耗时不能相加当墙钟。

问答错误码：桌面 MODEL_JSON 1；飞书问答 无。

互斥首次损失标签：桌面 success 31；retrieval_context_loss 44；answer_error_or_refusal 2；memory_content_missing 13；answer_protocol_error 1；飞书问答 success 33；retrieval_context_loss 43；answer_error_or_refusal 2；memory_content_missing 13。这些标签用于排查，不能证明因果。

评分器API格式重评：无已记录重评；当前评分错误0题。

### 已缓存评分JSON的确定性语法恢复

记录10条、涉及10题（answer 10），收据ID：952, 977, 979, 1041, 1069, 1087, 1154, 1198, 1206, 1231。额外API调用0次、额外token为0；原响应本身的调用和usage已在总量中计算。

规则严格限定为在已收到的JSON末尾追加一个根对象右括号 `}`；随后执行原有schema和记忆ID白名单校验，不修改分数字符串或其他字段。原始收据、原文与修复文本SHA256均保留。这是离线/本地解析恢复，不是再次LLM评审或生产流程恢复；若发生在API格式重评之后，也不会再增加调用。

| 题号 | 阶段 | 收据ID | 原错误 | 原文本SHA256 | 恢复文本SHA256 |
| --- | --- | --- | --- | --- | --- |
| 111afb77cfbf4c98e0458606378fa63a0e965e36 | answer | 952 | Expected ',' or '}' after property value in JSON at position 676 (line 1 column 677) | b216f1f3b575d5b69a2a62e98d7ded413e5a33ee2fcf906b86e84a9aace6a0bb | a63f99e90f80a7dd9ba673838ac977b3b804365ae2bf5bbfefea5a13047209b7 |
| 10fb7dc031075946153baf0a0599e126de29e3a4 | answer | 977 | Expected ',' or '}' after property value in JSON at position 690 (line 1 column 691) | 075cb5110c915764a308d12d2821f0dc7d4f1dc9a05b25eb4102b3710423ed61 | 4baf3a99d4eb8c63356b4b5674b3547a07fce0fa53fdcb6dcdf8efadf536bc18 |
| 7ab9c0b4ceca1c142ff068f85015a249b14282d0 | answer | 979 | Expected ',' or '}' after property value in JSON at position 589 (line 1 column 590) | 4ce3cf18d8862977c0d722e93e74e8d85f89a13badd51c13a6a8bb1dd93c0d18 | a27e190ecef81e3632ef470bb503420a78bec0e4f38d8522b7acb0dac2799b0c |
| d6ea7a30b0b61ae126b00b59d2a14fff2ef887bf | answer | 1041 | Expected ',' or '}' after property value in JSON at position 673 (line 1 column 674) | 1181ac37b5b7e03a592a2f79a124736bc4e317e5870b98c93fe5564f9451b3c9 | 29e6ff4beeb9e06401cbf5633aba074a45bfefbb7768e10c4085f41c8174f3c6 |
| e6583c60b13b87fc37af75ffc975e7e316d4f4e0 | answer | 1069 | Expected ',' or '}' after property value in JSON at position 539 (line 1 column 540) | 1ac0bd3e866cc85e8fbb7ee9d0f284110d353222ee9d000a6457b5753a2aac74 | 8cab73245c63dd6214760debf6e9de7a532ea9a50d0360005277a1545f00b114 |
| f7a89b9cd2792f23f2cb43d50a01b8218a6fbb24 | answer | 1087 | Expected ',' or '}' after property value in JSON at position 480 (line 1 column 481) | b067baf618c6e9c912853f0223a3c5326d527319b37fab648490096ee194853f | 010ed439e32aa594d3bccfbbfe06ffe24574958476417394108b35b9c62a606f |
| d6e353e0231d09fd5dcba493544d53706f3fe1ab | answer | 1154 | Expected ',' or '}' after property value in JSON at position 555 (line 1 column 556) | 061f5d611c71b29e2d0756511d4aa06046512b6cc6f824e205be59c570e0bf57 | 01149c7e088ca50cd375c8f3692eab67ee78094f16c083f1b7a4c0d613508e1b |
| 4fa6fbb9df1a4c32583d4ef70d2b29ece4b3d802 | answer | 1198 | Expected ',' or '}' after property value in JSON at position 600 (line 1 column 601) | 909d8763916dd4a5f5e7cf19581eae8dfd1bf81e83560cb354c06d91b1bf058d | b50fe126cfcc4212b8a5693ea89ad1dc0a0c3384eb4c71121e394a527cca8daa |
| 20e38438471266ce021817c6364f6a46d01564f2 | answer | 1206 | Expected ',' or '}' after property value in JSON at position 647 (line 1 column 648) | 67b59fbdd62442caaca7cf49970a042b3b578f358c3197d5b5ebc72f34a2f551 | 57ea1e7cf3c358706baa2b5332dc141678af16bd986537c0414e495dc261fe0d |
| e44a6bf67ce3fde0c6608b150030e44d87eb25e3 | answer | 1231 | Expected ',' or '}' after property value in JSON at position 558 (line 1 column 559) | a1ba659442755e970c38f72d3e351582928e8a5a33591812cbbfa16b8dc74416 | 40b59a1d9d23cd62a925a531b47d6334bd3d133314f1dd330817b1a5a7c0ba92 |

符合单个右括号规则10/10条，完整记录双SHA256为10/10条。

## 确定性检查与旧候选离线回放

确定性检查：记录全部通过；12条命令。记录时间2026-10-20T11:38:39.560Z。

| 命令 | 退出码 | 日志 |
| --- | --- | --- |
| cargo.exe test -p project-assistant-core --locked | 0 | .local-data\extraction-regressions-VedBFI\1.log |
| cargo.exe clippy -p project-assistant-core --locked --lib --tests -- -D warnings | 0 | .local-data\extraction-regressions-VedBFI\2.log |
| cargo.exe build -p project-assistant-core --bin pm-host --locked | 0 | .local-data\extraction-regressions-VedBFI\3.log |
| powershell.exe -NoProfile -Command npm run build | 0 | .local-data\extraction-regressions-VedBFI\4.log |
| node.exe --test scripts/score-memory-public-live.test.mjs scripts/memory-public-live-options.test.mjs scripts/evaluate-memory-quality.test.mjs scripts/check-memory-public-development.test.mjs | 0 | .local-data\extraction-regressions-VedBFI\5.log |
| node.exe scripts/verify-restart.mjs | 0 | .local-data\extraction-regressions-VedBFI\6.log |
| node.exe scripts/verify-extraction-recovery.mjs | 0 | .local-data\extraction-regressions-VedBFI\7.log |
| node.exe scripts/verify-memory-public-live.mjs --no-write | 0 | .local-data\extraction-regressions-VedBFI\8.log |
| cargo.exe test -p project-assistant-core --lib --locked replay_public_live_extraction_v5 -- --ignored --nocapture | 0 | .local-data\extraction-regressions-VedBFI\9.log |
| node --test scripts/report-memory-extraction-optimized.test.mjs | 0 | .local-data\extraction-regressions-VedBFI\10-report.log |
| node --test scripts/score-memory-public-live.test.mjs scripts/memory-public-live-options.test.mjs scripts/evaluate-memory-quality.test.mjs scripts/check-memory-public-development.test.mjs scripts/report-memory-extraction-optimized.test.mjs | 0 | .local-data\extraction-regressions-VedBFI\11-final-js.log |
| node --test scripts/score-memory-public-live.test.mjs scripts/memory-public-live-options.test.mjs scripts/evaluate-memory-quality.test.mjs scripts/check-memory-public-development.test.mjs scripts/report-memory-extraction-optimized.test.mjs | 0 | .local-data\extraction-regressions-VedBFI\12-final-js-all.log |

首轮确定性检查原始记录：全部通过，9条命令，记录时间2026-10-20T11:05:05.756Z；保留于输入工件，不用第二轮记录覆盖。

冻结旧响应2104条候选离线回放：all_fields_valid 1；core_invalid 14；scope_needs_review 1766；topic_only_quarantined_ready 323；单候选ready由1增加到324。

旧6000字符批次有89份响应、1979条候选超出新批次数量容量，需重新提取。此回放没有新LLM调用，不能当成新完整链路结果或语义精确率。

## 开发门槛记录

| 检查 | 通过 | 观测 |
| --- | --- | --- |
| frozen_development_scope | 是 | {"papers":6,"questions":20,"answerable":19,"unanswerable":1} |
| complete_run | 是 | {"complete":true,"haltReason":null} |
| extraction_jobs_completed | 是 | 6 |
| nonempty_confirmed_memory_per_paper | 是 | [{"id":"1902.09666","memories":78},{"id":"1806.00738","memories":46},{"id":"1603.01514","memories":135},{"id":"1908.07245","memories":74},{"id":"1902.09243","memories":137},{"id":"1705.01214","memories":474}] |
| integrity_verified | 是 | [{"file":"docs/memory-public-live-optimized-dev-v2-results.json","passed":true}] |
| deterministic_regressions_passed | 是 | [{"command":"cargo.exe test -p project-assistant-core --locked","exitCode":0,"elapsedMs":82719,"log":".local-data\\extraction-regressions-VedBFI\\1.log"},{"command":"cargo.exe clippy -p project-assistant-core --locked --lib --tests -- -D warnings","exitCode":0,"elapsedMs":7278,"log":".local-data\\extraction-regressions-VedBFI\\2.log"},{"command":"cargo.exe build -p project-assistant-core --bin pm-host --locked","exitCode":0,"elapsedMs":1307,"log":".local-data\\extraction-regressions-VedBFI\\3.log"},{"command":"powershell.exe -NoProfile -Command npm run build","exitCode":0,"elapsedMs":12716,"log":".local-data\\extraction-regressions-VedBFI\\4.log"},{"command":"node.exe --test scripts/score-memory-public-live.test.mjs scripts/memory-public-live-options.test.mjs scripts/evaluate-memory-quality.test.mjs scripts/check-memory-public-development.test.mjs","exitCode":0,"elapsedMs":211,"log":".local-data\\extraction-regressions-VedBFI\\5.log"},{"command":"node.exe scripts/verify-restart.mjs","exitCode":0,"elapsedMs":4665,"log":".local-data\\extraction-regressions-VedBFI\\6.log"},{"command":"node.exe scripts/verify-extraction-recovery.mjs","exitCode":0,"elapsedMs":5757,"log":".local-data\\extraction-regressions-VedBFI\\7.log"},{"command":"node.exe scripts/verify-memory-public-live.mjs --no-write","exitCode":0,"elapsedMs":728,"log":".local-data\\extraction-regressions-VedBFI\\8.log"},{"command":"cargo.exe test -p project-assistant-core --lib --locked replay_public_live_extraction_v5 -- --ignored --nocapture","exitCode":0,"elapsedMs":1540,"log":".local-data\\extraction-regressions-VedBFI\\9.log"},{"command":"node --test scripts/report-memory-extraction-optimized.test.mjs","exitCode":0,"elapsedMs":202,"log":".local-data\\extraction-regressions-VedBFI\\10-report.log"},{"command":"node --test scripts/score-memory-public-live.test.mjs scripts/memory-public-live-options.test.mjs scripts/evaluate-memory-quality.test.mjs scripts/check-memory-public-development.test.mjs scripts/report-memory-extraction-optimized.test.mjs","exitCode":0,"elapsedMs":252,"log":".local-data\\extraction-regressions-VedBFI\\11-final-js.log"}] |
| no_cross_project_citations | 是 | 0 |
| all_isolated_judgments_available | 是 | 20 |
| question_information_retained | 是 | 18 |
| desktop_complete_answers | 是 | 7 |
| desktop_correct_abstention | 是 | 1 |
| connector_complete_answers | 是 | 7 |
| connector_correct_abstention | 是 | 1 |

## 局限与复现

- 提取通过率、组织字段合法率和逐字引文匹配均不能代替事实正确率。语义断言精确率为null，独立人工复核未做。
- 同模型隔离评分减少阶段混淆，仍可能误判；完整段落来源覆盖也不能代替答案所需信息覆盖。
- 公开英文论文不等于中文真实业务数据；未覆盖长期更新、遗忘、实体歧义与全生命周期冲突。
- 报告只读取已保存工件，不产生模型调用。复测命令会产生真实调用与费用。

[机器指标与逐题变化](memory-extraction-optimized-metrics.json)；[旧完整链路报告](memory-public-live-report.md)；[旧原段落诊断对照](memory-public-live-control-summary.json)。

报告输入和所有阶段指标保存在机器JSON；完整原文、模型收据位于相应隔离workspace。生成命令：

```powershell
node scripts/report-memory-extraction-optimized.mjs --dev "docs/memory-public-live-optimized-dev-v2-results.json" --full "docs/memory-public-live-optimized-full-results.json" --initial-dev "docs/memory-public-live-optimized-dev-results.json" --initial-gate "docs/memory-public-live-optimized-dev-gate.json" --initial-regressions "docs/memory-extraction-optimized-initial-regressions.json" --gate "docs/memory-public-live-optimized-dev-v2-gate.json" --regressions "docs/memory-extraction-optimized-regressions.json" --offline "docs/memory-public-live-optimized-offline-replay.json"
```
