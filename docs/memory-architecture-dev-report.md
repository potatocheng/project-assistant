# 记忆架构：固定记忆上的20题真实问答比较

本轮 qa-architecture-dev，20题：19题可答、1题无答案。冻结正式记忆 929 条，新增 0 条；提取请求 0 次。100题未执行。

与 reliability 的历史答案做本次匿名配对重评；同时保留 reliability 原评。v3 只列历史原评参考，本轮没有重评 v3。下面是同模型自动评分，开发集已用于回归，并非新增盲测。

## 正确率与参考充分性

| 入口 | 指标 | v3 历史参考 | reliability 原评 | 本次 reliability 配对 | 本轮 |
| --- | --- | --- | --- | --- | --- |
| 桌面 | 可答题完整正确 | 16/19 | 12/19 | 12/19 | 13/19 |
| 桌面 | 无答案题正确拒答 | 1/1 | 1/1 | 1/1 | 1/1 |
| 桌面 | 检索参考充分 yes | 17/19 | 16/19 | 旧参考包未重评 | 17/19 |
| 桌面 | 相对本次旧答案配对的新增成功 / 退化 | — | — | — | 1 / 0 |
| 飞书 | 可答题完整正确 | 16/19 | 15/19 | 13/19 | 13/19 |
| 飞书 | 无答案题正确拒答 | 1/1 | 1/1 | 1/1 | 1/1 |
| 飞书 | 检索参考充分 yes | 17/19 | 16/19 | 旧参考包未重评 | 18/19 |
| 飞书 | 相对本次旧答案配对的新增成功 / 退化 | — | — | — | 1 / 1 |

partial 不计入完整正确；所有可答题保留在分母。历史原评与本次配对评分分开，不将评分漂移归为代码收益。

## 冻结记忆与独立原文通道

正式记忆内容、条件、修订、证据和原始段落均与 reliability 一致。下面的记忆标签是同一内容再次接受 judge 评分；任何变化都不表示新增留存。原文通道不进入记忆留存评分。

| 评分 | yes | partial | no | uncertain | 缺失 | 严格 yes |
| --- | --- | --- | --- | --- | --- | --- |
| reliability 原评 | 17 | 1 | 1 | 0 | 0 | 17/19 |
| 冻结内容本次重评 | 17 | 1 | 1 | 0 | 0 | 17/19 |

| 入口 | 含原文的生成次数 | 最终生产参考含原文的题数 | 最终生产原文参考数 | 引用原文的题数 | 原文引用数 | 单次生成最多原文 / 总参考 |
| --- | --- | --- | --- | --- | --- | --- |
| 桌面 | 21/21 | 20/20 | 161 | 17/20 | 43 | 8 / 32 |
| 飞书 | 21/21 | 20/20 | 160 | 16/20 | 36 | 8 / 32 |

原文参考数量按最终答案实际生产上下文的并集统计；并集跨两次生成时不等同于单个参考包。来源字段与整段内容通过完整性校验。引用或可见原文不单独证明其导致答案正确。

## 分阶段请求与 tokens

成本只作同阶段比较：QA 对 QA、judge 对 judge。本轮复用已完成的提取，不将本轮 QA-only 总量与旧含提取总量相比来宣称节省。未提供货币账单或单价，因此不估算货币费用。

| 阶段 | reliability 请求 / tokens | 本轮请求 / tokens | 同阶段 tokens 变化 |
| --- | --- | --- | --- |
| qa | 95 / 312132 | 91 / 753084 | +440952 (141.27%) |
| judge | 60 / 449849 | 60 / 535424 | +85575 (19.02%) |
| extraction | 100 / 435450 | 0 / 0 | 本轮未执行 |
| all | 255 / 1197431 | 151 / 1288508 | 范围不同，不计算节省 |

| 本轮阶段 | input | output | cache input | 失败请求 | 缺失(total/input/output/cache) |
| --- | --- | --- | --- | --- | --- |
| qa | 732055 | 21029 | 85888 | 0 | 0/0/0/0 |
| judge | 527426 | 7998 | 311552 | 0 | 0/0/0/0 |
| extraction | 0 | 0 | 0 | 0 | 0/0/0/0 |
| all | 1259481 | 29027 | 397440 | 0 | 0/0/0/0 |

所有成功、失败和重试请求均纳入实际收据；cache 属于 input，不重复加入 total。

## 逐题变化

理由来自对应 stages.answer.systems，按 anonymousOrder 映射；不使用检索阶段覆盖后的扁平 reason。

### 55bd59076a49b19d3283af41c5e3ccb875f3eb0c · 桌面 · 可答

What is the best performing model?

| reliability 原评 | 本次 reliability 配对 | 本轮 | 相对原评 | 相对配对 |
| --- | --- | --- | --- | --- |
| yes | yes | yes | retained_success | retained_success |

| 内容 | 原始记录 |
| --- | --- |
| reliability 答案 | A CNN-based sentence classifier achieved the best results in all three sub-tasks. [1]<br>The CNN outperformed the RNN model, achieving a macro-F1 score of 0.80. [2]<br>In a separate experiment, the CNN system achieved higher performance than the BiLSTM, with a macro-F1 score of 0.69. [3] |
| 本轮答案 | A CNN-based sentence classifier achieved the best results in all three sub-tasks. [1]<br>In the offensive vs. non-offensive (OFF/NOT) experiment, the CNN outperformed the RNN model, achieving a macro-F1 score of 0.80. [2]<br>In the target-identification experiment, the CNN system achieved higher performance than the BiLSTM, with a macro-F1 score of 0.69. [3] |
| reliability 原评理由 | Identifies CNN as best-performing model, matching the gold answer, with supporting F1 details. |
| reliability 本次配对理由 | Identifies CNN as best-performing model, matching the gold answer, with supporting detail. |
| 本轮理由 | Identifies CNN as best-performing model, matching the gold answer, with supporting detail. |
| 旧 / 本轮参考充分性 | yes / yes |
| 本轮参考理由 | References include 'The CNN outperforms the RNN model, achieving a macro-F1 score of 0.80' and 'A CNN-based sentence classifier achieved the best results in all three sub-tasks,' directly supporting CNN as best model. |
| 最终生产原文参考 ID | source:8409a569-0324-46d0-bffd-9d47b7137952:8345e4cb-0e83-4ed5-a109-cc11c64bea26, source:8409a569-0324-46d0-bffd-9d47b7137952:f0ee3311-5536-47db-b578-048006607cdd, source:8409a569-0324-46d0-bffd-9d47b7137952:51890b9f-f2fa-49b2-be5d-9a103a75b638, source:8409a569-0324-46d0-bffd-9d47b7137952:dbac5e1a-ee48-4c1d-9995-af9441242a0e, source:8409a569-0324-46d0-bffd-9d47b7137952:48f17d29-1512-44ea-8a73-382fb8871e1b, source:8409a569-0324-46d0-bffd-9d47b7137952:f5f8da9a-baf2-402b-b83b-2b8c35b6307c, source:8409a569-0324-46d0-bffd-9d47b7137952:5fdb9af7-a0d2-456f-835c-d1356dc36452, source:8409a569-0324-46d0-bffd-9d47b7137952:1045f677-7666-4be0-a3f1-f6debf394a9b |
| 最终原文引用 ID | source:8409a569-0324-46d0-bffd-9d47b7137952:f0ee3311-5536-47db-b578-048006607cdd, source:8409a569-0324-46d0-bffd-9d47b7137952:8345e4cb-0e83-4ed5-a109-cc11c64bea26, source:8409a569-0324-46d0-bffd-9d47b7137952:51890b9f-f2fa-49b2-be5d-9a103a75b638 |

### 55bd59076a49b19d3283af41c5e3ccb875f3eb0c · 飞书 · 可答

What is the best performing model?

| reliability 原评 | 本次 reliability 配对 | 本轮 | 相对原评 | 相对配对 |
| --- | --- | --- | --- | --- |
| yes | yes | yes | retained_success | retained_success |

| 内容 | 原始记录 |
| --- | --- |
| reliability 答案 | A CNN-based sentence classifier achieved the best results in all three sub-tasks. [1]<br>The CNN outperforms the RNN model, achieving a macro-F1 score of 0.80. [2]<br>The CNN system achieved higher performance than the BiLSTM in that experiment, with a macro-F1 score of 0.69. [3]<br><br>依据：<br>[1] Predicting the Type and Target of Offensive Posts in Social Media · 记忆 v1 · 当前版本原文依据（第 31 行）<br>[2] Predicting the Type and Target of Offensive Posts in Social Media · 记忆 v1 · 当前版本原文依据（第 26 行）<br>[3] Predicting the Type and Target of Offensive Posts in Social Media · 记忆 v1 · 当前版本原文依据（第 28 行） |
| 本轮答案 | A CNN-based sentence classifier achieved the best results in all three sub-tasks. [1]<br>The CNN outperforms the RNN model, achieving a macro-F1 score of 0.80. [2]<br>In the target-identification experiment, the CNN system achieved higher performance than the BiLSTM, with a macro-F1 score of 0.69. [3]<br><br>依据：<br>[1] Predicting the Type and Target of Offensive Posts in Social Media · 导入原文（非正式记忆）（第 31 行）（第 31 行）<br>[2] Predicting the Type and Target of Offensive Posts in Social Media · 导入原文（非正式记忆）（第 26 行）（第 26 行）<br>[3] Predicting the Type and Target of Offensive Posts in Social Media · 导入原文（非正式记忆）（第 28 行）（第 28 行） |
| reliability 原评理由 | States CNN achieved best results, matching the gold answer. |
| reliability 本次配对理由 | States CNN achieved best results in all sub-tasks, matching the gold answer. |
| 本轮理由 | States CNN achieved best results in all sub-tasks, matching the gold answer. |
| 旧 / 本轮参考充分性 | yes / yes |
| 本轮参考理由 | Same evidence present: CNN outperforms RNN with macro-F1 0.80 and CNN-based classifier achieved best results in all sub-tasks, matching gold answer CNN. |
| 最终生产原文参考 ID | source:8409a569-0324-46d0-bffd-9d47b7137952:8345e4cb-0e83-4ed5-a109-cc11c64bea26, source:8409a569-0324-46d0-bffd-9d47b7137952:f0ee3311-5536-47db-b578-048006607cdd, source:8409a569-0324-46d0-bffd-9d47b7137952:51890b9f-f2fa-49b2-be5d-9a103a75b638, source:8409a569-0324-46d0-bffd-9d47b7137952:dbac5e1a-ee48-4c1d-9995-af9441242a0e, source:8409a569-0324-46d0-bffd-9d47b7137952:48f17d29-1512-44ea-8a73-382fb8871e1b, source:8409a569-0324-46d0-bffd-9d47b7137952:f5f8da9a-baf2-402b-b83b-2b8c35b6307c, source:8409a569-0324-46d0-bffd-9d47b7137952:5fdb9af7-a0d2-456f-835c-d1356dc36452, source:8409a569-0324-46d0-bffd-9d47b7137952:1045f677-7666-4be0-a3f1-f6debf394a9b |
| 最终原文引用 ID | source:8409a569-0324-46d0-bffd-9d47b7137952:f0ee3311-5536-47db-b578-048006607cdd, source:8409a569-0324-46d0-bffd-9d47b7137952:8345e4cb-0e83-4ed5-a109-cc11c64bea26, source:8409a569-0324-46d0-bffd-9d47b7137952:51890b9f-f2fa-49b2-be5d-9a103a75b638 |

### 5daeb8d4d6f3b8543ec6309a7a35523e160437eb · 桌面 · 可答

In what language are the tweets?

| reliability 原评 | 本次 reliability 配对 | 本轮 | 相对原评 | 相对配对 |
| --- | --- | --- | --- | --- |
| yes | yes | yes | retained_success | retained_success |

| 内容 | 原始记录 |
| --- | --- |
| reliability 答案 | 当前资源所创建的数据集为英语推文（English tweets）。 [1] |
| 本轮答案 | 本文新建的公开数据集由英语推文组成。 [1]<br>作为对比，GermEval 共享任务针对的是德语推文。 [2]<br>Davidson 等人的仇恨言论检测数据集包含超过 24,000 条英语推文。 [3] |
| reliability 原评理由 | States the tweets are English, matching the gold answer. |
| reliability 本次配对理由 | States the dataset is English tweets, matching the gold answer. |
| 本轮理由 | States the dataset consists of English tweets, matching the gold answer. |
| 旧 / 本轮参考充分性 | yes / yes |
| 本轮参考理由 | Reference memory:0ced79d8 states the dataset is of 'English tweets,' directly answering the language question. |
| 最终生产原文参考 ID | source:8409a569-0324-46d0-bffd-9d47b7137952:d7b3b540-50b0-4672-8239-a033c38e2d49, source:8409a569-0324-46d0-bffd-9d47b7137952:9a7333a6-8e0d-490b-82a1-ebeaabb871c5, source:8409a569-0324-46d0-bffd-9d47b7137952:f0ee3311-5536-47db-b578-048006607cdd, source:8409a569-0324-46d0-bffd-9d47b7137952:84d37cb1-0425-49db-9f6b-dae303df29fc, source:8409a569-0324-46d0-bffd-9d47b7137952:6175c6e9-4cb8-42de-87da-255961cfed2f, source:8409a569-0324-46d0-bffd-9d47b7137952:a3748c4f-c0b7-4a3b-ad52-18847690cd9a, source:8409a569-0324-46d0-bffd-9d47b7137952:bfcb4271-e131-4566-829a-aae00871c19e, source:8409a569-0324-46d0-bffd-9d47b7137952:df63d6c3-d66c-425a-b08c-4362337e913b |
| 最终原文引用 ID | 无 |

### 5daeb8d4d6f3b8543ec6309a7a35523e160437eb · 飞书 · 可答

In what language are the tweets?

| reliability 原评 | 本次 reliability 配对 | 本轮 | 相对原评 | 相对配对 |
| --- | --- | --- | --- | --- |
| yes | yes | yes | retained_success | retained_success |

| 内容 | 原始记录 |
| --- | --- |
| reliability 答案 | 本项目创建的推文数据集为英文推文（English tweets）。 [1]<br><br>依据：<br>[1] Predicting the Type and Target of Offensive Posts in Social Media · 记忆 v1 · 当前版本原文依据（第 4 行） |
| 本轮答案 | 本文所述新建的推文数据集为英语推文（English tweets）。 [1]<br><br>依据：<br>[1] Predicting the Type and Target of Offensive Posts in Social Media · 记忆 v1 · 当前版本原文依据（第 4 行） |
| reliability 原评理由 | States the tweets are English, matching the gold answer. |
| reliability 本次配对理由 | States the tweets are English tweets, matching the gold answer. |
| 本轮理由 | States the tweets are English tweets, matching the gold answer. |
| 旧 / 本轮参考充分性 | yes / yes |
| 本轮参考理由 | Reference 0ced79d8 states 'dataset of English tweets,' directly supplying the answer. |
| 最终生产原文参考 ID | source:8409a569-0324-46d0-bffd-9d47b7137952:d7b3b540-50b0-4672-8239-a033c38e2d49, source:8409a569-0324-46d0-bffd-9d47b7137952:9a7333a6-8e0d-490b-82a1-ebeaabb871c5, source:8409a569-0324-46d0-bffd-9d47b7137952:f0ee3311-5536-47db-b578-048006607cdd, source:8409a569-0324-46d0-bffd-9d47b7137952:84d37cb1-0425-49db-9f6b-dae303df29fc, source:8409a569-0324-46d0-bffd-9d47b7137952:6175c6e9-4cb8-42de-87da-255961cfed2f, source:8409a569-0324-46d0-bffd-9d47b7137952:a3748c4f-c0b7-4a3b-ad52-18847690cd9a, source:8409a569-0324-46d0-bffd-9d47b7137952:bfcb4271-e131-4566-829a-aae00871c19e, source:8409a569-0324-46d0-bffd-9d47b7137952:df63d6c3-d66c-425a-b08c-4362337e913b |
| 最终原文引用 ID | 无 |

### 521280a87c43fcdf9f577da235e7072a23f0673e · 桌面 · 可答

How many annotators participated?

| reliability 原评 | 本次 reliability 配对 | 本轮 | 相对原评 | 相对配对 |
| --- | --- | --- | --- | --- |
| partial | partial | partial | still_unsuccessful | still_unsuccessful |

| 内容 | 原始记录 |
| --- | --- |
| reliability 答案 | The trial set involved five annotators on 21 of the tweets. [1]<br>Each dataset instance was annotated by multiple annotators, and inter-annotator agreement was calculated. [2]<br>Initially two annotations were acquired per instance; in case of disagreement, more annotations were requested until agreement exceeded 66%. [3]<br>尚待确认：The total number of annotators who participated in the overall dataset annotation is not recorded; only the five annotators on the trial set and the per-instance annotation procedure are documented.；整体数据集标注中参与标注者的总人数未记录，仅有试验集五名标注者及每实例标注流程。；How many annotators participated? |
| 本轮答案 | The trial annotation of 300 instances was carried out with six experts. [1]<br>For the trial set, Fliess' kappa was computed for the five annotators on 21 of the tweets. [1][2]<br>The main crowdsourcing annotation began with two annotations per instance, with more requested in case of disagreement until agreement exceeded 66%; the total number of crowdsourcing annotators is not stated. [1][3]<br>尚待确认：The total number of annotators who participated in the full crowdsourcing annotation is not recorded; only the trial (six experts) and the agreement subset (five annotators) are specified.；完整众包标注阶段参与标注者的总人数未记录；How many annotators participated? |
| reliability 原评理由 | Mentions five annotators on the trial set but frames the total as unrecorded, so the direct answer 'five annotators' is not clearly given. |
| reliability 本次配对理由 | States five annotators but frames it as trial set and says total unrecorded, not a clean answer of five. |
| 本轮理由 | Mentions five annotators but adds six experts and says total is unstated, rather than answering five. |
| 旧 / 本轮参考充分性 | yes / yes |
| 本轮参考理由 | References include the sentence 'We computed Fliess' INLINEFORM0 on the trial set for the five annotators,' which directly states five annotators, matching the gold answer. |
| 最终生产原文参考 ID | source:8409a569-0324-46d0-bffd-9d47b7137952:33561ead-7ea9-43c9-9170-9ac680eb14ca, source:8409a569-0324-46d0-bffd-9d47b7137952:825727d6-ee14-43bf-a9c7-a03cfc481d1a, source:8409a569-0324-46d0-bffd-9d47b7137952:9a7333a6-8e0d-490b-82a1-ebeaabb871c5, source:8409a569-0324-46d0-bffd-9d47b7137952:48f17d29-1512-44ea-8a73-382fb8871e1b |
| 最终原文引用 ID | source:8409a569-0324-46d0-bffd-9d47b7137952:825727d6-ee14-43bf-a9c7-a03cfc481d1a |

### 521280a87c43fcdf9f577da235e7072a23f0673e · 飞书 · 可答

How many annotators participated?

| reliability 原评 | 本次 reliability 配对 | 本轮 | 相对原评 | 相对配对 |
| --- | --- | --- | --- | --- |
| yes | yes | partial | regression | regression |

| 内容 | 原始记录 |
| --- | --- |
| reliability 答案 | 在21条推文的试验集上，计算了五名标注者之间的Fliess' kappa。 [1][2]<br><br>依据：<br>[1] Predicting the Type and Target of Offensive Posts in Social Media · 记忆 v1 · 当前版本原文依据（第 23 行）<br>[2] Predicting the Type and Target of Offensive Posts in Social Media · 记忆 v1 · 当前版本原文依据（第 23 行） |
| 本轮答案 | 在21条推文的试验集上，计算Fleiss' kappa时涉及五名标注者。 [1][2]<br>首轮试验标注由六名专家完成，共标注300条实例。 [3]<br>正式众包标注中，每条实例先获取两份标注；若不一致则继续请求更多标注，直至一致率高于66%。 [4][3]<br>尚待确认：正式众包标注阶段实际参与标注者的总人数未明确记录。；How many annotators participated?<br><br>依据：<br>[1] Predicting the Type and Target of Offensive Posts in Social Media · 记忆 v1 · 当前版本原文依据（第 23 行）<br>[2] Predicting the Type and Target of Offensive Posts in Social Media · 记忆 v1 · 当前版本原文依据（第 23 行）<br>[3] Predicting the Type and Target of Offensive Posts in Social Media · 导入原文（非正式记忆）（第 23 行）（第 23 行）<br>[4] Predicting the Type and Target of Offensive Posts in Social Media · 记忆 v1 · 当前版本原文依据（第 23 行） |
| reliability 原评理由 | States five annotators on the 21-tweet trial set, matching the gold answer 'five annotators'. |
| reliability 本次配对理由 | Correctly answers five annotators, matching the gold 'five annotators'. |
| 本轮理由 | States five annotators but also adds six experts and treats total as unknown instead of answering five. |
| 旧 / 本轮参考充分性 | yes / yes |
| 本轮参考理由 | Connector references contain the same 'five annotators' sentence, supplying the needed count to answer the question. |
| 最终生产原文参考 ID | source:8409a569-0324-46d0-bffd-9d47b7137952:33561ead-7ea9-43c9-9170-9ac680eb14ca, source:8409a569-0324-46d0-bffd-9d47b7137952:825727d6-ee14-43bf-a9c7-a03cfc481d1a, source:8409a569-0324-46d0-bffd-9d47b7137952:9a7333a6-8e0d-490b-82a1-ebeaabb871c5, source:8409a569-0324-46d0-bffd-9d47b7137952:48f17d29-1512-44ea-8a73-382fb8871e1b |
| 最终原文引用 ID | source:8409a569-0324-46d0-bffd-9d47b7137952:825727d6-ee14-43bf-a9c7-a03cfc481d1a |

### 5a8cc8f80509ea77d8213ed28c5ead501c68c725 · 桌面 · 可答

What is the definition of offensive language?

| reliability 原评 | 本次 reliability 配对 | 本轮 | 相对原评 | 相对配对 |
| --- | --- | --- | --- | --- |
| yes | yes | yes | retained_success | retained_success |

| 内容 | 原始记录 |
| --- | --- |
| reliability 答案 | In the OLID annotation, a post is labeled offensive (OFF) if it contains any form of non-acceptable language (profanity) or a targeted offense, which can be veiled or direct; this category includes insults, threats, and posts containing profane language or swear words. [1]<br>By contrast, Not Offensive (NOT) covers posts that do not contain offense or profanity. [2]<br>Level A of the hierarchical annotation model discriminates between offensive (OFF) and non-offensive (NOT) tweets. [3] |
| 本轮答案 | 在 OLID 数据集中，一条帖子若包含任何形式的不可接受语言（脏话）或带有针对性的冒犯（可以是隐晦的或直接的），就被标注为冒犯性（OFF）。 [1][2]<br>该冒犯性类别包括侮辱、威胁，以及包含脏话或粗口的帖子。 [1][2] |
| reliability 原评理由 | Provides the same correct OLID definition; extra contrast with NOT and Level A does not introduce error. |
| reliability 本次配对理由 | Gives the OLID definition of offensive posts (non-acceptable language/profanity or targeted offense, including insults, threats, profanity), matching the human answer's cited definition. |
| 本轮理由 | States the OLID definition of offensive posts accurately, including non-acceptable language/profanity and targeted offense with insults and threats. |
| 旧 / 本轮参考充分性 | yes / yes |
| 本轮参考理由 | Includes the explicit definition of offensive (OFF) as non-acceptable language/profanity or targeted offense, including insults, threats, and swear words, which directly answers the definition question. |
| 最终生产原文参考 ID | source:8409a569-0324-46d0-bffd-9d47b7137952:bfcb4271-e131-4566-829a-aae00871c19e, source:8409a569-0324-46d0-bffd-9d47b7137952:d7b3b540-50b0-4672-8239-a033c38e2d49, source:8409a569-0324-46d0-bffd-9d47b7137952:df63d6c3-d66c-425a-b08c-4362337e913b, source:8409a569-0324-46d0-bffd-9d47b7137952:6175c6e9-4cb8-42de-87da-255961cfed2f, source:8409a569-0324-46d0-bffd-9d47b7137952:4c5f116f-d5bd-44f2-aa2a-4f13a9af6628, source:8409a569-0324-46d0-bffd-9d47b7137952:9a7333a6-8e0d-490b-82a1-ebeaabb871c5, source:8409a569-0324-46d0-bffd-9d47b7137952:f0ee3311-5536-47db-b578-048006607cdd, source:8409a569-0324-46d0-bffd-9d47b7137952:1045f677-7666-4be0-a3f1-f6debf394a9b |
| 最终原文引用 ID | source:8409a569-0324-46d0-bffd-9d47b7137952:bfcb4271-e131-4566-829a-aae00871c19e |

### 5a8cc8f80509ea77d8213ed28c5ead501c68c725 · 飞书 · 可答

What is the definition of offensive language?

| reliability 原评 | 本次 reliability 配对 | 本轮 | 相对原评 | 相对配对 |
| --- | --- | --- | --- | --- |
| yes | yes | yes | retained_success | retained_success |

| 内容 | 原始记录 |
| --- | --- |
| reliability 答案 | Offensive (OFF) 的定义：帖子若包含任何形式的不可接受语言（脏话）或针对性冒犯（可为隐晦或直接），即标记为冒犯性；该类别包括侮辱、威胁以及含脏话或粗口的帖子。 [1]<br>Not Offensive (NOT) 指不含冒犯或脏话的帖子。 [2]<br><br>依据：<br>[1] Predicting the Type and Target of Offensive Posts in Social Media · 记忆 v1 · 当前版本原文依据（第 15 行）<br>[2] Predicting the Type and Target of Offensive Posts in Social Media · 记忆 v1 · 当前版本原文依据（第 14 行） |
| 本轮答案 | 在OLID的标注定义中，攻击性（OFF）帖子的判定标准是：帖子包含任何形式的不可接受语言（脏话）或带有针对性的冒犯，且该冒犯可以是隐晦的或直接的；该类别包括侮辱、威胁以及含脏话或粗口的帖子。 [1][2]<br>与之相对，非攻击性（NOT）帖子是不含冒犯或脏话的帖子。 [3]<br><br>依据：<br>[1] Predicting the Type and Target of Offensive Posts in Social Media · 记忆 v1 · 当前版本原文依据（第 15 行）<br>[2] Predicting the Type and Target of Offensive Posts in Social Media · 导入原文（非正式记忆）（第 15 行）（第 15 行）<br>[3] Predicting the Type and Target of Offensive Posts in Social Media · 记忆 v1 · 当前版本原文依据（第 14 行） |
| reliability 原评理由 | Chinese answer gives the correct offensive definition plus a correct NOT contrast. |
| reliability 本次配对理由 | Provides the same correct OLID offensive-language definition plus the NOT contrast, consistent with the human answer. |
| 本轮理由 | Gives the correct OLID offensive definition and adds the NOT contrast, matching the human answer. |
| 旧 / 本轮参考充分性 | yes / yes |
| 本轮参考理由 | Contains the same explicit OFF definition (non-acceptable language/profanity or targeted offense, including insults, threats, swear words), sufficient to answer the definition question. |
| 最终生产原文参考 ID | source:8409a569-0324-46d0-bffd-9d47b7137952:bfcb4271-e131-4566-829a-aae00871c19e, source:8409a569-0324-46d0-bffd-9d47b7137952:d7b3b540-50b0-4672-8239-a033c38e2d49, source:8409a569-0324-46d0-bffd-9d47b7137952:df63d6c3-d66c-425a-b08c-4362337e913b, source:8409a569-0324-46d0-bffd-9d47b7137952:6175c6e9-4cb8-42de-87da-255961cfed2f, source:8409a569-0324-46d0-bffd-9d47b7137952:4c5f116f-d5bd-44f2-aa2a-4f13a9af6628, source:8409a569-0324-46d0-bffd-9d47b7137952:9a7333a6-8e0d-490b-82a1-ebeaabb871c5, source:8409a569-0324-46d0-bffd-9d47b7137952:f0ee3311-5536-47db-b578-048006607cdd, source:8409a569-0324-46d0-bffd-9d47b7137952:1045f677-7666-4be0-a3f1-f6debf394a9b |
| 最终原文引用 ID | source:8409a569-0324-46d0-bffd-9d47b7137952:bfcb4271-e131-4566-829a-aae00871c19e |

### 747b847d687f703cc20a87877c5b138f26ff137d · 桌面 · 可答

Which parallel corpora are used?

| reliability 原评 | 本次 reliability 配对 | 本轮 | 相对原评 | 相对配对 |
| --- | --- | --- | --- | --- |
| no | no | partial | still_unsuccessful | still_unsuccessful |

| 内容 | 原始记录 |
| --- | --- |
| reliability 答案 | 记录提到使用未标注的 Europarl 数据来采样源语言角色。 [1]<br>尚待确认：除 Europarl 外，所使用平行语料库的完整名称与范围未明确记录。；Which parallel corpora are used? |
| 本轮答案 | 实验使用的平行语料是 Europarl 语料的 EN-DE 部分。 [1][2]<br>从 Europarl 中取得约 150 万条 EN-DE 平行句。 [1][3]<br>Europarl 平行语料的词对齐使用 GIZA++ 计算，并只保留双向交集对齐。 [1][4] |
| reliability 原评理由 | Only mentions unlabeled Europarl and fails to name CoNLL 2009 or the EN-DE pair. |
| reliability 本次配对理由 | Mentions only Europarl and explicitly says the full set of parallel corpora is unknown; omits CoNLL 2009 EN/DE, which the gold answer requires. |
| 本轮理由 | Correctly identifies the EN-DE Europarl section but omits the CoNLL 2009 EN and DE sections, so the answer is incomplete. |
| 旧 / 本轮参考充分性 | no / yes |
| 本轮参考理由 | Reference memory:2de559bb states experiments use EN/DE sections of CoNLL 2009 and EN-DE section of Europarl, matching gold. |
| 最终生产原文参考 ID | source:f77eab74-a2c6-488c-8db3-e82073df8b78:18180ceb-c3b0-4f24-8b85-ad4ca5bb9d99, source:f77eab74-a2c6-488c-8db3-e82073df8b78:5cc40b40-a8bc-45e2-aa42-f863104ea031, source:f77eab74-a2c6-488c-8db3-e82073df8b78:193b50ad-f652-4003-956f-c8933ac94ef9, source:f77eab74-a2c6-488c-8db3-e82073df8b78:b6a6a03c-aa65-40a9-8a01-2bdec2adc38b, source:f77eab74-a2c6-488c-8db3-e82073df8b78:b7753349-dc33-4de6-8d42-0f8cda9a463b, source:f77eab74-a2c6-488c-8db3-e82073df8b78:45611eba-990c-4a19-81f7-302188e2b5e6, source:f77eab74-a2c6-488c-8db3-e82073df8b78:df2aae18-f16b-44d0-8cac-30bd9f032a23, source:f77eab74-a2c6-488c-8db3-e82073df8b78:dafc584b-7b1d-4f35-bbd9-5a2d53537b1f |
| 最终原文引用 ID | source:f77eab74-a2c6-488c-8db3-e82073df8b78:b7753349-dc33-4de6-8d42-0f8cda9a463b |

### 747b847d687f703cc20a87877c5b138f26ff137d · 飞书 · 可答

Which parallel corpora are used?

| reliability 原评 | 本次 reliability 配对 | 本轮 | 相对原评 | 相对配对 |
| --- | --- | --- | --- | --- |
| no | no | partial | still_unsuccessful | still_unsuccessful |

| 内容 | 原始记录 |
| --- | --- |
| reliability 答案 | 该模型使用平行语料库中句子之间的词对齐来利用跨语言的语义角色对应关系。 [1]<br>源语言角色是在未标注的 Europarl 数据上采样的。 [2]<br>尚待确认：除 Europarl 外，记录未明确列出所使用的平行语料库名称或具体语种对。；除 Europarl 外，未明确列出所使用的平行语料库名称或具体语种对。；Which parallel corpora are used?<br><br>依据：<br>[1] A Bayesian Model of Multilingual Unsupervised Semantic Role Induction · 记忆 v1 · 当前版本原文依据（第 15 行）<br>[2] A Bayesian Model of Multilingual Unsupervised Semantic Role Induction · 记忆 v1 · 当前版本原文依据（第 41 行） |
| 本轮答案 | 实验使用 EN-DE 部分的 Europarl 语料作为平行语料。 [1][2]<br>从 Europarl 取得约 150 万条 EN-DE 平行句。 [3][2]<br>该 EN-DE 平行 Europarl 语料的词对齐用 GIZA++ 计算，并只保留双向交集对齐。 [4][2]<br><br>依据：<br>[1] A Bayesian Model of Multilingual Unsupervised Semantic Role Induction · 记忆 v1 · 当前版本原文依据（第 34 行）<br>[2] A Bayesian Model of Multilingual Unsupervised Semantic Role Induction · 导入原文（非正式记忆）（第 34 行）（第 34 行）<br>[3] A Bayesian Model of Multilingual Unsupervised Semantic Role Induction · 记忆 v1 · 当前版本原文依据（第 34 行）<br>[4] A Bayesian Model of Multilingual Unsupervised Semantic Role Induction · 记忆 v1 · 当前版本原文依据（第 34 行） |
| reliability 原评理由 | Does not identify the parallel corpora; only mentions Europarl and general alignment use. |
| reliability 本次配对理由 | Only names Europarl and states other corpora are unlisted; misses the CoNLL 2009 EN/DE sections required by the gold answer. |
| 本轮理由 | Names only the EN-DE Europarl section and omits the CoNLL 2009 EN/DE sections, making it incomplete. |
| 旧 / 本轮参考充分性 | no / yes |
| 本轮参考理由 | Connector includes memory:2de559bb naming CoNLL 2009 EN/DE and Europarl EN-DE, fully answering the question. |
| 最终生产原文参考 ID | source:f77eab74-a2c6-488c-8db3-e82073df8b78:18180ceb-c3b0-4f24-8b85-ad4ca5bb9d99, source:f77eab74-a2c6-488c-8db3-e82073df8b78:5cc40b40-a8bc-45e2-aa42-f863104ea031, source:f77eab74-a2c6-488c-8db3-e82073df8b78:193b50ad-f652-4003-956f-c8933ac94ef9, source:f77eab74-a2c6-488c-8db3-e82073df8b78:b6a6a03c-aa65-40a9-8a01-2bdec2adc38b, source:f77eab74-a2c6-488c-8db3-e82073df8b78:b7753349-dc33-4de6-8d42-0f8cda9a463b, source:f77eab74-a2c6-488c-8db3-e82073df8b78:45611eba-990c-4a19-81f7-302188e2b5e6, source:f77eab74-a2c6-488c-8db3-e82073df8b78:df2aae18-f16b-44d0-8cac-30bd9f032a23, source:f77eab74-a2c6-488c-8db3-e82073df8b78:dafc584b-7b1d-4f35-bbd9-5a2d53537b1f |
| 最终原文引用 ID | source:f77eab74-a2c6-488c-8db3-e82073df8b78:b7753349-dc33-4de6-8d42-0f8cda9a463b |

### 111afb77cfbf4c98e0458606378fa63a0e965e36 · 桌面 · 可答

Overall, does having parallel data improve semantic role induction across multiple languages?

| reliability 原评 | 本次 reliability 配对 | 本轮 | 相对原评 | 相对配对 |
| --- | --- | --- | --- | --- |
| yes | yes | yes | retained_success | retained_success |

| 内容 | 原始记录 |
| --- | --- |
| reliability 答案 | 总体而言，加入平行句中的词对齐只带来小幅且不显著的提升，即使源语言已有部分标注数据也是如此。 [1]<br>结果表明，从该平行数据设置中能学到的语义角色信息很少。 [2]<br>作者认为，改进对齐模型是有效利用平行数据于多语言语义角色归纳的必要步骤。 [3]<br>标注少量数据带来的性能提升，很容易超过加入大规模无标注数据集以及加入平行语料库所带来的提升。 [4] |
| 本轮答案 | 总体而言，没有证据表明平行数据能显著改善多语言语义角色归纳：在平行句中加入词对齐只带来小幅、不显著的提升，即使源语言已有部分标注数据也是如此。 [1][2]<br>作者指出，这些结果表明从该平行数据设置中几乎学不到关于语义角色的信息。 [3][4]<br>一个可能的原因是，按对齐论元的定义，只有8%的英语论元和17%的德语论元是对齐的，这很可能限制了跨语言信息的影响。 [3][5]<br>作者认为，改进对齐模型是有效利用平行数据进行多语言SRI的必要步骤，并将这一探索留待未来工作。 [3][6]<br>在标注迁移场景中，目标语言只获得小幅改进。 [5] |
| reliability 原评理由 | Correctly reports small non-significant gains and little learnable role information, consistent with gold. |
| reliability 本次配对理由 | Correctly states parallel data yields only small, non-significant improvements and little learnable role information, matching the gold conclusion. |
| 本轮理由 | Correctly answers no significant improvement, with accurate supporting details on small gains and limited aligned arguments. |
| 旧 / 本轮参考充分性 | yes / yes |
| 本轮参考理由 | Includes the conclusion paragraph stating parallel data yields only small, non-significant improvements, directly answering the yes/no question. |
| 最终生产原文参考 ID | source:f77eab74-a2c6-488c-8db3-e82073df8b78:45611eba-990c-4a19-81f7-302188e2b5e6, source:f77eab74-a2c6-488c-8db3-e82073df8b78:18180ceb-c3b0-4f24-8b85-ad4ca5bb9d99, source:f77eab74-a2c6-488c-8db3-e82073df8b78:d66d2555-85d3-4a50-992e-5f85d31d5b76, source:f77eab74-a2c6-488c-8db3-e82073df8b78:193b50ad-f652-4003-956f-c8933ac94ef9, source:f77eab74-a2c6-488c-8db3-e82073df8b78:df2aae18-f16b-44d0-8cac-30bd9f032a23, source:f77eab74-a2c6-488c-8db3-e82073df8b78:dfda6549-fdc9-4966-8497-c310ed454b8d, source:f77eab74-a2c6-488c-8db3-e82073df8b78:19b66cf7-92a6-4ded-8496-2b84931fddb6, source:f77eab74-a2c6-488c-8db3-e82073df8b78:f093dd01-be9b-4652-92a3-82934a9f828b |
| 最终原文引用 ID | source:f77eab74-a2c6-488c-8db3-e82073df8b78:18180ceb-c3b0-4f24-8b85-ad4ca5bb9d99, source:f77eab74-a2c6-488c-8db3-e82073df8b78:df2aae18-f16b-44d0-8cac-30bd9f032a23, source:f77eab74-a2c6-488c-8db3-e82073df8b78:45611eba-990c-4a19-81f7-302188e2b5e6 |

### 111afb77cfbf4c98e0458606378fa63a0e965e36 · 飞书 · 可答

Overall, does having parallel data improve semantic role induction across multiple languages?

| reliability 原评 | 本次 reliability 配对 | 本轮 | 相对原评 | 相对配对 |
| --- | --- | --- | --- | --- |
| yes | yes | yes | retained_success | retained_success |

| 内容 | 原始记录 |
| --- | --- |
| reliability 答案 | 总体而言，没有显著改善：在平行句中加入词对齐只带来小幅、非显著的提升，即使源语言已有部分标注数据也是如此。 [1]<br>作者指出，从这一平行数据设置中能学到的语义角色信息很少。 [2]<br>作者认为，改进对齐模型是让平行数据在多语言语义角色归纳中发挥有效作用的必要步骤，并将该探索留作未来工作。 [3][4]<br><br>依据：<br>[1] A Bayesian Model of Multilingual Unsupervised Semantic Role Induction · 记忆 v1 · 当前版本原文依据（第 51 行）<br>[2] A Bayesian Model of Multilingual Unsupervised Semantic Role Induction · 记忆 v1 · 当前版本原文依据（第 40 行）<br>[3] A Bayesian Model of Multilingual Unsupervised Semantic Role Induction · 记忆 v1 · 当前版本原文依据（第 40 行）<br>[4] A Bayesian Model of Multilingual Unsupervised Semantic Role Induction · 记忆 v1 · 当前版本原文依据（第 40 行） |
| 本轮答案 | 总体而言，没有证据表明平行数据能显著改善多语言语义角色归纳：在平行句中加入词对齐只带来小幅、不显著的提升，即使源语言已有部分标注数据也是如此。 [1][2]<br>作者指出，这些结果表明从该平行数据设置中几乎学不到关于语义角色的信息；一个可能原因是该设置本身不充分。 [3][4]<br>按对齐论元的定义，只有8%的英语论元和17%的德语论元是对齐的，这可能限制跨语言信息的影响。 [5][6]<br>作者据此认为，改进对齐模型是有效利用平行数据于多语言SRI的必要步骤，并将这一探索留作未来工作。 [7][8]<br><br>依据：<br>[1] A Bayesian Model of Multilingual Unsupervised Semantic Role Induction · 记忆 v1 · 当前版本原文依据（第 51 行）<br>[2] A Bayesian Model of Multilingual Unsupervised Semantic Role Induction · 导入原文（非正式记忆）（第 51 行）（第 51 行）<br>[3] A Bayesian Model of Multilingual Unsupervised Semantic Role Induction · 记忆 v1 · 当前版本原文依据（第 40 行）<br>[4] A Bayesian Model of Multilingual Unsupervised Semantic Role Induction · 导入原文（非正式记忆）（第 40 行）（第 40 行）<br>[5] A Bayesian Model of Multilingual Unsupervised Semantic Role Induction · 记忆 v1 · 当前版本原文依据（第 40 行）<br>[6] A Bayesian Model of Multilingual Unsupervised Semantic Role Induction · 导入原文（非正式记忆）（第 41 行）（第 41 行）<br>[7] A Bayesian Model of Multilingual Unsupervised Semantic Role Induction · 记忆 v1 · 当前版本原文依据（第 40 行）<br>[8] A Bayesian Model of Multilingual Unsupervised Semantic Role Induction · 记忆 v1 · 当前版本原文依据（第 40 行） |
| reliability 原评理由 | Correctly states no significant improvement and adds accurate supporting context from the paper. |
| reliability 本次配对理由 | Same correct conclusion: no significant improvement, small non-significant gains, alignment model improvement needed. |
| 本轮理由 | Correctly states no significant improvement and cites the small, non-significant gains and alignment limitations. |
| 旧 / 本轮参考充分性 | yes / yes |
| 本轮参考理由 | Contains the gold conclusion paragraph noting small non-significant improvements from parallel data, sufficient to answer. |
| 最终生产原文参考 ID | source:f77eab74-a2c6-488c-8db3-e82073df8b78:45611eba-990c-4a19-81f7-302188e2b5e6, source:f77eab74-a2c6-488c-8db3-e82073df8b78:18180ceb-c3b0-4f24-8b85-ad4ca5bb9d99, source:f77eab74-a2c6-488c-8db3-e82073df8b78:d66d2555-85d3-4a50-992e-5f85d31d5b76, source:f77eab74-a2c6-488c-8db3-e82073df8b78:193b50ad-f652-4003-956f-c8933ac94ef9, source:f77eab74-a2c6-488c-8db3-e82073df8b78:df2aae18-f16b-44d0-8cac-30bd9f032a23, source:f77eab74-a2c6-488c-8db3-e82073df8b78:dfda6549-fdc9-4966-8497-c310ed454b8d, source:f77eab74-a2c6-488c-8db3-e82073df8b78:19b66cf7-92a6-4ded-8496-2b84931fddb6, source:f77eab74-a2c6-488c-8db3-e82073df8b78:f093dd01-be9b-4652-92a3-82934a9f828b |
| 最终原文引用 ID | source:f77eab74-a2c6-488c-8db3-e82073df8b78:18180ceb-c3b0-4f24-8b85-ad4ca5bb9d99, source:f77eab74-a2c6-488c-8db3-e82073df8b78:df2aae18-f16b-44d0-8cac-30bd9f032a23, source:f77eab74-a2c6-488c-8db3-e82073df8b78:45611eba-990c-4a19-81f7-302188e2b5e6 |

### 50cc6c5f2dcf5fb87b56007f6a825fa7c90b64ed · 桌面 · 可答

What does an individual model consist of?

| reliability 原评 | 本次 reliability 配对 | 本轮 | 相对原评 | 相对配对 |
| --- | --- | --- | --- | --- |
| no | no | partial | still_unsuccessful | still_unsuccessful |

| 内容 | 原始记录 |
| --- | --- |
| reliability 答案 | 现有记录不足以支持完整结论或问题前提，请核对原文或补充记录。 |
| 本轮答案 | The base monolingual model used for each language is the Bayesian model of garg2012unsupervised. [1][2]<br>尚待确认：What does an individual model consist of? |
| reliability 原评理由 | Refuses/claims insufficient records instead of giving the gold answer. |
| reliability 本次配对理由 | Refuses/claims insufficient records instead of answering; no correct content. |
| 本轮理由 | Gives the base monolingual Bayesian model correctly but marks the question as still pending. |
| 旧 / 本轮参考充分性 | yes / yes |
| 本轮参考理由 | Reference 084fc750 states the base monolingual model is the Bayesian model of garg2012unsupervised, matching the gold span; other references add role inventory details. |
| 最终生产原文参考 ID | source:f77eab74-a2c6-488c-8db3-e82073df8b78:d66d2555-85d3-4a50-992e-5f85d31d5b76, source:f77eab74-a2c6-488c-8db3-e82073df8b78:a93a46de-d7ab-496e-aa73-0f5ef38fa8e1, source:f77eab74-a2c6-488c-8db3-e82073df8b78:b6a6a03c-aa65-40a9-8a01-2bdec2adc38b, source:f77eab74-a2c6-488c-8db3-e82073df8b78:c045e998-ca2a-4169-9538-b9676faad8cc, source:f77eab74-a2c6-488c-8db3-e82073df8b78:5a6cf43e-6f31-4486-96de-f97f8883e8dc, source:f77eab74-a2c6-488c-8db3-e82073df8b78:a8783593-c127-4e00-bb03-1d9d633c068d, source:f77eab74-a2c6-488c-8db3-e82073df8b78:193b50ad-f652-4003-956f-c8933ac94ef9, source:f77eab74-a2c6-488c-8db3-e82073df8b78:a3c087e0-5401-41c6-88dc-7c5418ce0db2 |
| 最终原文引用 ID | source:f77eab74-a2c6-488c-8db3-e82073df8b78:5a6cf43e-6f31-4486-96de-f97f8883e8dc |

### 50cc6c5f2dcf5fb87b56007f6a825fa7c90b64ed · 飞书 · 可答

What does an individual model consist of?

| reliability 原评 | 本次 reliability 配对 | 本轮 | 相对原评 | 相对配对 |
| --- | --- | --- | --- | --- |
| yes | partial | partial | regression | still_unsuccessful |

| 内容 | 原始记录 |
| --- | --- |
| reliability 答案 | 每个语言的个体模型以 garg2012unsupervised 的贝叶斯模型作为基础单语模型。 [1]<br>尚待确认：What does an individual model consist of?<br><br>依据：<br>[1] A Bayesian Model of Multilingual Unsupervised Semantic Role Induction · 记忆 v1 · 当前版本原文依据（第 11 行） |
| 本轮答案 | 整体模型由各语言各自的贝叶斯模型（individual Bayesian models for each language）以及跨语言隐变量组成；跨语言隐变量用于在已对齐成分之间引入软性角色一致性。 [1][2]<br>单语基础模型采用 garg2012unsupervised 的贝叶斯模型，语义角色是谓词特定的。 [3][4]<br>尚待确认：What does an individual model consist of?<br><br>依据：<br>[1] A Bayesian Model of Multilingual Unsupervised Semantic Role Induction · 记忆 v1 · 当前版本原文依据（第 7 行）<br>[2] A Bayesian Model of Multilingual Unsupervised Semantic Role Induction · 导入原文（非正式记忆）（第 7 行）（第 7 行）<br>[3] A Bayesian Model of Multilingual Unsupervised Semantic Role Induction · 记忆 v1 · 当前版本原文依据（第 11 行）<br>[4] A Bayesian Model of Multilingual Unsupervised Semantic Role Induction · 导入原文（非正式记忆）（第 11 行）（第 11 行） |
| reliability 原评理由 | Gives the correct base monolingual model answer despite an extra unknown note. |
| reliability 本次配对理由 | States the base monolingual model is garg2012unsupervised's Bayesian model, matching the gold, but flags the question as unresolved. |
| 本轮理由 | Correctly identifies the base monolingual Bayesian model, but adds crosslingual latent variables from the overall joint model, which is not what an individual model consists of. |
| 旧 / 本轮参考充分性 | yes / yes |
| 本轮参考理由 | Reference 5a6cf43e contains the gold sentence identifying the garg2012unsupervised Bayesian model as the base monolingual model, plus role inventory details. |
| 最终生产原文参考 ID | source:f77eab74-a2c6-488c-8db3-e82073df8b78:d66d2555-85d3-4a50-992e-5f85d31d5b76, source:f77eab74-a2c6-488c-8db3-e82073df8b78:a93a46de-d7ab-496e-aa73-0f5ef38fa8e1, source:f77eab74-a2c6-488c-8db3-e82073df8b78:b6a6a03c-aa65-40a9-8a01-2bdec2adc38b, source:f77eab74-a2c6-488c-8db3-e82073df8b78:c045e998-ca2a-4169-9538-b9676faad8cc, source:f77eab74-a2c6-488c-8db3-e82073df8b78:5a6cf43e-6f31-4486-96de-f97f8883e8dc, source:f77eab74-a2c6-488c-8db3-e82073df8b78:a8783593-c127-4e00-bb03-1d9d633c068d, source:f77eab74-a2c6-488c-8db3-e82073df8b78:193b50ad-f652-4003-956f-c8933ac94ef9, source:f77eab74-a2c6-488c-8db3-e82073df8b78:a3c087e0-5401-41c6-88dc-7c5418ce0db2 |
| 最终原文引用 ID | source:f77eab74-a2c6-488c-8db3-e82073df8b78:d66d2555-85d3-4a50-992e-5f85d31d5b76, source:f77eab74-a2c6-488c-8db3-e82073df8b78:5a6cf43e-6f31-4486-96de-f97f8883e8dc |

### 6bf5620f295b5243230bc97b340fae6e92304595 · 桌面 · 可答

What baseline model is used?

| reliability 原评 | 本次 reliability 配对 | 本轮 | 相对原评 | 相对配对 |
| --- | --- | --- | --- | --- |
| yes | yes | yes | retained_success | retained_success |

| 内容 | 原始记录 |
| --- | --- |
| reliability 答案 | The baseline used is the same baseline as in lang2011unsupervised, which assigns a semantic role to a constituent based on its syntactic function (the dependency relation to its head). [1] |
| 本轮答案 | The baseline model used is the same baseline as used by lang2011unsupervised, which has been shown to be difficult to outperform. [1][2]<br>This baseline assigns a semantic role to a constituent based on its syntactic function, i.e., the dependency relation to its head. [1][2]<br>In addition, a separate “supervised baseline” was constructed: for predicates seen in the supervised sentences, a MAP estimate of the parameters was calculated using the predefined mapping, while for unseen predicates the standard baseline was used. [3][4] |
| reliability 原评理由 | Correctly identifies the lang2011unsupervised baseline and its syntactic-function assignment. |
| reliability 本次配对理由 | Correctly identifies the lang2011unsupervised baseline and its syntactic-function assignment, matching the gold. |
| 本轮理由 | Identifies the lang2011unsupervised baseline and its syntactic-function assignment, matching the gold answer; extra supervised-baseline detail is accurate and not harmful. |
| 旧 / 本轮参考充分性 | yes / yes |
| 本轮参考理由 | Reference memory:2828defa states the baseline is the same as lang2011unsupervised, matching the gold answer. |
| 最终生产原文参考 ID | source:f77eab74-a2c6-488c-8db3-e82073df8b78:767f583d-d005-43a2-8c07-4ba108942b5d, source:f77eab74-a2c6-488c-8db3-e82073df8b78:0ceb87db-e8aa-4f91-a536-aefd6cd3f9e1, source:f77eab74-a2c6-488c-8db3-e82073df8b78:2c632bf7-5f59-42bc-a3f8-b637597da839, source:f77eab74-a2c6-488c-8db3-e82073df8b78:bf12efc2-e227-4730-a13e-555ff3e89cd3, source:f77eab74-a2c6-488c-8db3-e82073df8b78:dc3b65e4-2677-4ffe-9fd2-1f6868be2752, source:f77eab74-a2c6-488c-8db3-e82073df8b78:a93a46de-d7ab-496e-aa73-0f5ef38fa8e1, source:f77eab74-a2c6-488c-8db3-e82073df8b78:26324fc6-c046-4abc-a1db-2327858857ff, source:f77eab74-a2c6-488c-8db3-e82073df8b78:b6a6a03c-aa65-40a9-8a01-2bdec2adc38b |
| 最终原文引用 ID | source:f77eab74-a2c6-488c-8db3-e82073df8b78:0ceb87db-e8aa-4f91-a536-aefd6cd3f9e1, source:f77eab74-a2c6-488c-8db3-e82073df8b78:767f583d-d005-43a2-8c07-4ba108942b5d |

### 6bf5620f295b5243230bc97b340fae6e92304595 · 飞书 · 可答

What baseline model is used?

| reliability 原评 | 本次 reliability 配对 | 本轮 | 相对原评 | 相对配对 |
| --- | --- | --- | --- | --- |
| yes | yes | yes | retained_success | retained_success |

| 内容 | 原始记录 |
| --- | --- |
| reliability 答案 | 所用基线是 lang2011unsupervised 使用的同一基线；该基线根据成分的句法功能（即与其中心词的依存关系）为其指派语义角色。 [1]<br><br>依据：<br>[1] A Bayesian Model of Multilingual Unsupervised Semantic Role Induction · 记忆 v1 · 当前版本原文依据（第 31 行） |
| 本轮答案 | 所用基线是 lang2011unsupervised 使用的同一基线，该基线被指出难以超越。 [1][2]<br>该基线依据成分的句法功能（即与其中心词的依存关系）为其指派语义角色。 [1][2]<br><br>依据：<br>[1] A Bayesian Model of Multilingual Unsupervised Semantic Role Induction · 记忆 v1 · 当前版本原文依据（第 31 行）<br>[2] A Bayesian Model of Multilingual Unsupervised Semantic Role Induction · 导入原文（非正式记忆）（第 31 行）（第 31 行） |
| reliability 原评理由 | Same correct content in Chinese, matching the gold baseline description. |
| reliability 本次配对理由 | Correctly states the lang2011unsupervised baseline and its syntactic-function/dependency-relation assignment, matching the gold. |
| 本轮理由 | Correctly states the lang2011unsupervised baseline and its syntactic-function/dependency-relation assignment, matching the gold. |
| 旧 / 本轮参考充分性 | yes / yes |
| 本轮参考理由 | Reference 2828defa and source s6:p0 both state the baseline is the same as lang2011unsupervised, matching gold. |
| 最终生产原文参考 ID | source:f77eab74-a2c6-488c-8db3-e82073df8b78:767f583d-d005-43a2-8c07-4ba108942b5d, source:f77eab74-a2c6-488c-8db3-e82073df8b78:0ceb87db-e8aa-4f91-a536-aefd6cd3f9e1, source:f77eab74-a2c6-488c-8db3-e82073df8b78:2c632bf7-5f59-42bc-a3f8-b637597da839, source:f77eab74-a2c6-488c-8db3-e82073df8b78:bf12efc2-e227-4730-a13e-555ff3e89cd3, source:f77eab74-a2c6-488c-8db3-e82073df8b78:dc3b65e4-2677-4ffe-9fd2-1f6868be2752, source:f77eab74-a2c6-488c-8db3-e82073df8b78:a93a46de-d7ab-496e-aa73-0f5ef38fa8e1, source:f77eab74-a2c6-488c-8db3-e82073df8b78:26324fc6-c046-4abc-a1db-2327858857ff, source:f77eab74-a2c6-488c-8db3-e82073df8b78:b6a6a03c-aa65-40a9-8a01-2bdec2adc38b |
| 最终原文引用 ID | source:f77eab74-a2c6-488c-8db3-e82073df8b78:0ceb87db-e8aa-4f91-a536-aefd6cd3f9e1 |

### 1be54c5b3ea67d837ffba2290a40c1e720d9587f · 桌面 · 可答

Is the position in the sequence part of the input?

| reliability 原评 | 本次 reliability 配对 | 本轮 | 相对原评 | 相对配对 |
| --- | --- | --- | --- | --- |
| no | no | yes | new_success | new_success |

| 内容 | 原始记录 |
| --- | --- |
| reliability 答案 | No. The recorded input to each decoder is the corresponding image embedding e(I_i), not the position in the sequence; the position determines which decoder handles which image. [1][2][3] |
| 本轮答案 | 是。该模型为图像序列的每个位置设置一个独立解码器，每个解码器对应序列中的一张图像，并学习该位置特定的语言模型。 [1][2]<br>每个解码器的首个输入是其对应图像的图像嵌入 e(I_i)，而非位置编号本身；位置通过“对应图像”这一方式与输入关联。 [3][4] |
| reliability 原评理由 | Answers 'No' to a yes/no question whose human answer is yes; contradicts the per-position decoder design. |
| reliability 本次配对理由 | Says position is not part of input, contradicting the gold answer that each decoder learns a position-specific model (position is part of input). |
| 本轮理由 | Answers yes, explaining each position has its own decoder and position is tied to the corresponding image input. |
| 旧 / 本轮参考充分性 | yes / yes |
| 本轮参考理由 | References state each decoder corresponds to a position in the sequence and takes the corresponding image embedding as first input, indicating position is part of input. |
| 最终生产原文参考 ID | source:0056b867-8122-4004-bc43-25fd67204dda:99a5dba5-48ff-48dd-9e38-78acdc8b7b29, source:0056b867-8122-4004-bc43-25fd67204dda:21f3eabb-4486-4b12-a466-7200557be9ea, source:0056b867-8122-4004-bc43-25fd67204dda:4ed951a9-15c4-432b-b827-f49c4081c7da, source:0056b867-8122-4004-bc43-25fd67204dda:00011657-a46d-4d6f-92d6-d081f5d2027f, source:0056b867-8122-4004-bc43-25fd67204dda:683e67ac-3e5a-4524-bd86-eb1b8c732cd1, source:0056b867-8122-4004-bc43-25fd67204dda:2c617d30-268e-45da-96a6-0cc91661bf2a, source:0056b867-8122-4004-bc43-25fd67204dda:e9cf78d6-9302-48a1-a4a4-c7d08882ab7c, source:0056b867-8122-4004-bc43-25fd67204dda:a1876bf5-068c-4e23-a1d3-e4fbb91d36ee |
| 最终原文引用 ID | source:0056b867-8122-4004-bc43-25fd67204dda:99a5dba5-48ff-48dd-9e38-78acdc8b7b29, source:0056b867-8122-4004-bc43-25fd67204dda:683e67ac-3e5a-4524-bd86-eb1b8c732cd1 |

### 1be54c5b3ea67d837ffba2290a40c1e720d9587f · 飞书 · 可答

Is the position in the sequence part of the input?

| reliability 原评 | 本次 reliability 配对 | 本轮 | 相对原评 | 相对配对 |
| --- | --- | --- | --- | --- |
| partial | partial | yes | new_success | new_success |

| 内容 | 原始记录 |
| --- | --- |
| reliability 答案 | 记录未明确说明序列位置本身是否作为输入；已记录的是每个解码器以对应图像嵌入 e(I_i) 作为首个输入，并以编码器最后隐藏状态（上下文）初始化隐藏状态。 [1][2]<br>模型为序列中每张图像设置一个独立解码器，每个解码器针对序列中对应位置学习特定的语言模型。 [3][4]<br>尚待确认：序列位置是否作为显式输入（如位置编码或位置向量）未被记录。；Is the position in the sequence part of the input?<br><br>依据：<br>[1] Contextualize, Show and Tell: A Neural Visual Storyteller · 记忆 v1 · 当前版本原文依据（第 10 行）<br>[2] Contextualize, Show and Tell: A Neural Visual Storyteller · 记忆 v1 · 当前版本原文依据（第 9 行）<br>[3] Contextualize, Show and Tell: A Neural Visual Storyteller · 记忆 v1 · 当前版本原文依据（第 9 行）<br>[4] Contextualize, Show and Tell: A Neural Visual Storyteller · 记忆 v1 · 当前版本原文依据（第 9 行） |
| 本轮答案 | 是。每个解码器以对应图像的图像嵌入 e(I_i) 作为第一项输入，而位置由独立的解码器承担：第一个解码器为第一张图生成词序列，第二个为第二张，依此类推。 [1][2][3]<br>模型含五个独立解码器，每个图像位置一个；各解码器用编码器最后隐状态（上下文）初始化，并以对应图像嵌入为首输入，从而为序列的每个位置学习特定的语言模型。 [4][3][5]<br><br>依据：<br>[1] Contextualize, Show and Tell: A Neural Visual Storyteller · 记忆 v1 · 当前版本原文依据（第 10 行）<br>[2] Contextualize, Show and Tell: A Neural Visual Storyteller · 记忆 v1 · 当前版本原文依据（第 9 行）<br>[3] Contextualize, Show and Tell: A Neural Visual Storyteller · 记忆 v1 · 当前版本原文依据（第 9 行）<br>[4] Contextualize, Show and Tell: A Neural Visual Storyteller · 记忆 v1 · 当前版本原文依据（第 9 行）<br>[5] Contextualize, Show and Tell: A Neural Visual Storyteller · 记忆 v1 · 当前版本原文依据（第 9 行） |
| reliability 原评理由 | Notes per-position decoders but hedges that position input is unrecorded, failing to give the expected yes. |
| reliability 本次配对理由 | Notes position-specific decoders but hedges that position as explicit input is unconfirmed, rather than answering yes. |
| 本轮理由 | Answers yes, citing independent per-position decoders and position-specific language models. |
| 旧 / 本轮参考充分性 | yes / yes |
| 本轮参考理由 | Same evidence: decoders per position take corresponding image embedding as first input, showing position is part of input. |
| 最终生产原文参考 ID | source:0056b867-8122-4004-bc43-25fd67204dda:99a5dba5-48ff-48dd-9e38-78acdc8b7b29, source:0056b867-8122-4004-bc43-25fd67204dda:21f3eabb-4486-4b12-a466-7200557be9ea, source:0056b867-8122-4004-bc43-25fd67204dda:4ed951a9-15c4-432b-b827-f49c4081c7da, source:0056b867-8122-4004-bc43-25fd67204dda:00011657-a46d-4d6f-92d6-d081f5d2027f, source:0056b867-8122-4004-bc43-25fd67204dda:683e67ac-3e5a-4524-bd86-eb1b8c732cd1, source:0056b867-8122-4004-bc43-25fd67204dda:2c617d30-268e-45da-96a6-0cc91661bf2a, source:0056b867-8122-4004-bc43-25fd67204dda:e9cf78d6-9302-48a1-a4a4-c7d08882ab7c, source:0056b867-8122-4004-bc43-25fd67204dda:a1876bf5-068c-4e23-a1d3-e4fbb91d36ee |
| 最终原文引用 ID | 无 |

### 584af673429c7f8621c6bf83362a37048daa0e5d · 桌面 · 可答

How is the sequential nature of the story captured?

| reliability 原评 | 本次 reliability 配对 | 本轮 | 相对原评 | 相对配对 |
| --- | --- | --- | --- | --- |
| yes | yes | yes | retained_success | retained_success |

| 内容 | 原始记录 |
| --- | --- |
| reliability 答案 | The encoder processes the images in order, taking one image at every timestep t; at t=5 the context vector is obtained through h_e^(t). [1]<br>The model's first component is an LSTM that summarizes the sequence of images; at t=5 it has encoded the 5 images and provides the sequence's context via its last hidden state h_e^(t). [2][3]<br>The model contains five independent decoders, one for each image in the sequence, and each decoder generates a sequence of words for its image; the final story is the concatenation of the five decoders' outputs. [4][5]<br>The first decoder generates words for the first image, the second decoder for the second image, and so on, allowing each decoder to learn a specific language model for each position of the sequence. [6][7]<br>All five decoders use the encoder's last hidden state as their first hidden state and take the corresponding image embedding as their first input. [8] |
| 本轮答案 | The encoder captures the sequence by taking the images in order, one at every timestep t; at time t=5 it obtains the context vector through h_e^(t) (represented by Z). [1][2]<br>The first component is an LSTM that summarizes the sequence of images: at every timestep t it takes as input an image I_i (i in {1,2,3,4,5}) from the sequence, and at t=5 it has encoded the 5 images and provides the sequence's context through its last hidden state h_e^(t). [3]<br>The model contains five independent decoders, one for each image in the sequence; all five use the encoder's last hidden state (the context) as their first hidden state and take the corresponding image embedding as their first input. [4][5]<br>The first decoder generates the words for the first image, the second decoder for the second image, and so on, so each decoder learns a specific language model for each position of the sequence. [4][6][7]<br>For example, the first decoder learns the opening sentences of the story while the last decoder learns the closing sentences. [4]<br>Each decoder generates a sequence of words for each image, and the final story is the concatenation of the output of the 5 decoders. [8][2]<br>The context vector initializes each decoder's hidden state, while each decoder's first input is its corresponding image embedding e(I_i). [9][2]<br>Having an independent decoder for each position of the image sequence allowed the visual storyteller to build more specific language models using the context vector as its first state and the image embedding as its first input. [10][11] |
| reliability 原评理由 | Explains encoder processes images in order per timestep, context vector at t=5, five decoders each generating words per image, concatenated story—matches gold. |
| reliability 本次配对理由 | States encoder takes images in order per timestep, context vector at t=5, five independent decoders per image, per-position language models, and concatenation—semantically equivalent to gold. |
| 本轮理由 | Explains encoder processes images in order per timestep, context vector at t=5, decoders initialized with context and image embedding, per-position decoders, and concatenation—matching both gold answers. |
| 旧 / 本轮参考充分性 | yes / yes |
| 本轮参考理由 | References include the encoder processing images in order per timestep, the context vector, per-image decoders generating word sequences, and concatenation into the final story, matching the gold explanation of sequential capture. |
| 最终生产原文参考 ID | source:0056b867-8122-4004-bc43-25fd67204dda:683e67ac-3e5a-4524-bd86-eb1b8c732cd1, source:0056b867-8122-4004-bc43-25fd67204dda:99a5dba5-48ff-48dd-9e38-78acdc8b7b29, source:0056b867-8122-4004-bc43-25fd67204dda:4ed951a9-15c4-432b-b827-f49c4081c7da, source:0056b867-8122-4004-bc43-25fd67204dda:00011657-a46d-4d6f-92d6-d081f5d2027f, source:0056b867-8122-4004-bc43-25fd67204dda:2c617d30-268e-45da-96a6-0cc91661bf2a, source:0056b867-8122-4004-bc43-25fd67204dda:e9cf78d6-9302-48a1-a4a4-c7d08882ab7c, source:0056b867-8122-4004-bc43-25fd67204dda:21f3eabb-4486-4b12-a466-7200557be9ea, source:0056b867-8122-4004-bc43-25fd67204dda:a1876bf5-068c-4e23-a1d3-e4fbb91d36ee |
| 最终原文引用 ID | source:0056b867-8122-4004-bc43-25fd67204dda:683e67ac-3e5a-4524-bd86-eb1b8c732cd1, source:0056b867-8122-4004-bc43-25fd67204dda:4ed951a9-15c4-432b-b827-f49c4081c7da, source:0056b867-8122-4004-bc43-25fd67204dda:99a5dba5-48ff-48dd-9e38-78acdc8b7b29, source:0056b867-8122-4004-bc43-25fd67204dda:21f3eabb-4486-4b12-a466-7200557be9ea |

### 584af673429c7f8621c6bf83362a37048daa0e5d · 飞书 · 可答

How is the sequential nature of the story captured?

| reliability 原评 | 本次 reliability 配对 | 本轮 | 相对原评 | 相对配对 |
| --- | --- | --- | --- | --- |
| yes | yes | yes | retained_success | retained_success |

| 内容 | 原始记录 |
| --- | --- |
| reliability 答案 | 编码器按顺序逐个时间步接收图像，在 t=5 时通过最后隐藏状态 h_e^(t)（记为 Z）得到上下文向量。 [1][2]<br>模型包含五个独立解码器，每个图像对应一个解码器；第一个解码器为第一张图像生成词序列，第二个为第二张，依此类推。 [3][4]<br>每个解码器为序列中对应图像生成一段词序列，最终故事是五个解码器输出的拼接。 [5]<br>编码器最后隐藏状态（上下文）用于初始化每个解码器的隐藏状态，每个解码器的首个输入是其对应的图像嵌入 e(I_i)。 [6][7]<br>这种设计使每个解码器学习针对序列各位置特定的语言模型。 [8]<br><br>依据：<br>[1] Contextualize, Show and Tell: A Neural Visual Storyteller · 记忆 v1 · 当前版本原文依据（第 10 行）<br>[2] Contextualize, Show and Tell: A Neural Visual Storyteller · 记忆 v1 · 当前版本原文依据（第 7 行）<br>[3] Contextualize, Show and Tell: A Neural Visual Storyteller · 记忆 v1 · 当前版本原文依据（第 9 行）<br>[4] Contextualize, Show and Tell: A Neural Visual Storyteller · 记忆 v1 · 当前版本原文依据（第 9 行）<br>[5] Contextualize, Show and Tell: A Neural Visual Storyteller · 记忆 v1 · 当前版本原文依据（第 10 行）<br>[6] Contextualize, Show and Tell: A Neural Visual Storyteller · 记忆 v1 · 当前版本原文依据（第 10 行）<br>[7] Contextualize, Show and Tell: A Neural Visual Storyteller · 记忆 v1 · 当前版本原文依据（第 9 行）<br>[8] Contextualize, Show and Tell: A Neural Visual Storyteller · 记忆 v1 · 当前版本原文依据（第 9 行） |
| 本轮答案 | 故事序列性由编码器按顺序逐时间步读入图像来捕获：每个时间步 t 输入序列中的一张图像 I_i（i∈{1,2,3,4,5}），到 t=5 时 LSTM 已编码5张图像，并通过最后隐藏状态 h_e^(t)（上下文向量 Z）提供整段序列的上下文。 [1][2]<br>该上下文向量用于初始化每个解码器的隐藏状态，而每个解码器的首个输入是其对应图像的嵌入 e(I_i)。 [2][3]<br>模型包含5个独立解码器，每个图像位置一个；第一个解码器为第一张图像生成词序列，第二个为第二张，依此类推，从而让每个解码器学习该位置特定的语言模型（如第一个学开头句、最后一个学结尾句）。 [3][4]<br>每个解码器为序列中对应图像生成一段词序列，最终故事是5个解码器输出的拼接。 [2]<br><br>依据：<br>[1] Contextualize, Show and Tell: A Neural Visual Storyteller · 导入原文（非正式记忆）（第 7 行）（第 7 行）<br>[2] Contextualize, Show and Tell: A Neural Visual Storyteller · 导入原文（非正式记忆）（第 10 行）（第 10 行）<br>[3] Contextualize, Show and Tell: A Neural Visual Storyteller · 导入原文（非正式记忆）（第 9 行）（第 9 行）<br>[4] Contextualize, Show and Tell: A Neural Visual Storyteller · 记忆 v1 · 当前版本原文依据（第 9 行） |
| reliability 原评理由 | Covers ordered encoder timesteps, context vector at t=5, five decoders per image, concatenation, and initialization—semantically equivalent to gold. |
| reliability 本次配对理由 | Includes ordered per-timestep encoding, context vector, five decoders per image, per-position language models, decoder initialization, and concatenation. |
| 本轮理由 | Covers ordered per-timestep encoding, context vector h_e^(t), decoder initialization with context and image embedding, per-position decoders, and concatenation of outputs. |
| 旧 / 本轮参考充分性 | yes / yes |
| 本轮参考理由 | Connector references contain the same key evidence: ordered encoder timesteps, context vector, per-image decoder word sequences, and concatenation, sufficient to explain how sequential nature is captured. |
| 最终生产原文参考 ID | source:0056b867-8122-4004-bc43-25fd67204dda:683e67ac-3e5a-4524-bd86-eb1b8c732cd1, source:0056b867-8122-4004-bc43-25fd67204dda:99a5dba5-48ff-48dd-9e38-78acdc8b7b29, source:0056b867-8122-4004-bc43-25fd67204dda:4ed951a9-15c4-432b-b827-f49c4081c7da, source:0056b867-8122-4004-bc43-25fd67204dda:00011657-a46d-4d6f-92d6-d081f5d2027f, source:0056b867-8122-4004-bc43-25fd67204dda:2c617d30-268e-45da-96a6-0cc91661bf2a, source:0056b867-8122-4004-bc43-25fd67204dda:e9cf78d6-9302-48a1-a4a4-c7d08882ab7c, source:0056b867-8122-4004-bc43-25fd67204dda:21f3eabb-4486-4b12-a466-7200557be9ea, source:0056b867-8122-4004-bc43-25fd67204dda:a1876bf5-068c-4e23-a1d3-e4fbb91d36ee |
| 最终原文引用 ID | source:0056b867-8122-4004-bc43-25fd67204dda:4ed951a9-15c4-432b-b827-f49c4081c7da, source:0056b867-8122-4004-bc43-25fd67204dda:683e67ac-3e5a-4524-bd86-eb1b8c732cd1, source:0056b867-8122-4004-bc43-25fd67204dda:99a5dba5-48ff-48dd-9e38-78acdc8b7b29 |

### c37f65c9f0d543a35c784263b79236ccf1c44fac · 桌面 · 可答

What model is used to encode the images?

| reliability 原评 | 本次 reliability 配对 | 本轮 | 相对原评 | 相对配对 |
| --- | --- | --- | --- | --- |
| yes | yes | yes | retained_success | retained_success |

| 内容 | 原始记录 |
| --- | --- |
| reliability 答案 | The image representations were obtained using Inception V3. [1][2]<br>The encoder is a Convolutional Neural Network (CNN). [3] |
| 本轮答案 | 图像表示（image representation）是通过 Inception V3 获得的。 [1][2][3]<br>编码器是一个卷积神经网络（CNN），解码器是一个长短期记忆（LSTM）网络。 [4][5]<br>图像经过编码器生成图像表示，解码器利用该表示逐词生成描述。 [6][5] |
| reliability 原评理由 | States Inception V3 and CNN encoder, matching the human answers. |
| reliability 本次配对理由 | States Inception V3 for image representations and CNN as encoder, matching both human answers. |
| 本轮理由 | States Inception V3 for image representations and CNN encoder, matching human answers. |
| 旧 / 本轮参考充分性 | yes / yes |
| 本轮参考理由 | References include 'The encoder is a Convolutional Neural Network (CNN)' and 'The representation of the images was obtained through Inception V3,' covering both gold answers. |
| 最终生产原文参考 ID | source:0056b867-8122-4004-bc43-25fd67204dda:b7aa9590-9e5c-4ed8-9719-835845b5dc4f, source:0056b867-8122-4004-bc43-25fd67204dda:00011657-a46d-4d6f-92d6-d081f5d2027f, source:0056b867-8122-4004-bc43-25fd67204dda:2c617d30-268e-45da-96a6-0cc91661bf2a, source:0056b867-8122-4004-bc43-25fd67204dda:683e67ac-3e5a-4524-bd86-eb1b8c732cd1, source:0056b867-8122-4004-bc43-25fd67204dda:4ed951a9-15c4-432b-b827-f49c4081c7da, source:0056b867-8122-4004-bc43-25fd67204dda:99a5dba5-48ff-48dd-9e38-78acdc8b7b29, source:0056b867-8122-4004-bc43-25fd67204dda:21f3eabb-4486-4b12-a466-7200557be9ea, source:0056b867-8122-4004-bc43-25fd67204dda:9caa7a86-ad9c-4941-8b88-018d54bb01b8 |
| 最终原文引用 ID | source:0056b867-8122-4004-bc43-25fd67204dda:4ed951a9-15c4-432b-b827-f49c4081c7da, source:0056b867-8122-4004-bc43-25fd67204dda:b7aa9590-9e5c-4ed8-9719-835845b5dc4f |

### c37f65c9f0d543a35c784263b79236ccf1c44fac · 飞书 · 可答

What model is used to encode the images?

| reliability 原评 | 本次 reliability 配对 | 本轮 | 相对原评 | 相对配对 |
| --- | --- | --- | --- | --- |
| yes | yes | yes | retained_success | retained_success |

| 内容 | 原始记录 |
| --- | --- |
| reliability 答案 | 图像表示通过 Inception V3 获得。 [1]<br>对序列中的每张图像，使用 Inception v3 获得其表示。 [2]<br><br>依据：<br>[1] Contextualize, Show and Tell: A Neural Visual Storyteller · 记忆 v1 · 当前版本原文依据（第 7 行）<br>[2] Contextualize, Show and Tell: A Neural Visual Storyteller · 记忆 v1 · 当前版本原文依据（第 10 行） |
| 本轮答案 | 图像表示使用 Inception V3 获得。 [1][2][3]<br>编码器是卷积神经网络（CNN）。 [4][5]<br>在本视觉故事模型中，编码器是用于汇总图像序列的循环神经网络（RNN），更具体地说是 LSTM。 [6][3]<br><br>依据：<br>[1] Contextualize, Show and Tell: A Neural Visual Storyteller · 记忆 v1 · 当前版本原文依据（第 7 行）<br>[2] Contextualize, Show and Tell: A Neural Visual Storyteller · 记忆 v1 · 当前版本原文依据（第 10 行）<br>[3] Contextualize, Show and Tell: A Neural Visual Storyteller · 导入原文（非正式记忆）（第 7 行）（第 7 行）<br>[4] Contextualize, Show and Tell: A Neural Visual Storyteller · 记忆 v1 · 当前版本原文依据（第 6 行）<br>[5] Contextualize, Show and Tell: A Neural Visual Storyteller · 导入原文（非正式记忆）（第 6 行）（第 6 行）<br>[6] Contextualize, Show and Tell: A Neural Visual Storyteller · 记忆 v1 · 当前版本原文依据（第 7 行） |
| reliability 原评理由 | States Inception V3 for image representations, matching the human answer. |
| reliability 本次配对理由 | States Inception V3 for image representations, matching a human answer. |
| 本轮理由 | States Inception V3, CNN encoder, and LSTM, covering both human answers. |
| 旧 / 本轮参考充分性 | yes / yes |
| 本轮参考理由 | Connector references contain the CNN encoder statement and the Inception V3 image representation statement, matching both human gold spans. |
| 最终生产原文参考 ID | source:0056b867-8122-4004-bc43-25fd67204dda:b7aa9590-9e5c-4ed8-9719-835845b5dc4f, source:0056b867-8122-4004-bc43-25fd67204dda:00011657-a46d-4d6f-92d6-d081f5d2027f, source:0056b867-8122-4004-bc43-25fd67204dda:2c617d30-268e-45da-96a6-0cc91661bf2a, source:0056b867-8122-4004-bc43-25fd67204dda:683e67ac-3e5a-4524-bd86-eb1b8c732cd1, source:0056b867-8122-4004-bc43-25fd67204dda:4ed951a9-15c4-432b-b827-f49c4081c7da, source:0056b867-8122-4004-bc43-25fd67204dda:99a5dba5-48ff-48dd-9e38-78acdc8b7b29, source:0056b867-8122-4004-bc43-25fd67204dda:21f3eabb-4486-4b12-a466-7200557be9ea, source:0056b867-8122-4004-bc43-25fd67204dda:9caa7a86-ad9c-4941-8b88-018d54bb01b8 |
| 最终原文引用 ID | source:0056b867-8122-4004-bc43-25fd67204dda:4ed951a9-15c4-432b-b827-f49c4081c7da, source:0056b867-8122-4004-bc43-25fd67204dda:b7aa9590-9e5c-4ed8-9719-835845b5dc4f |

### b08f88d1facefceb87e134ba2c1fa90035018e83 · 桌面 · 可答

Do the decoder LSTMs all have the same weights?

| reliability 原评 | 本次 reliability 配对 | 本轮 | 相对原评 | 相对配对 |
| --- | --- | --- | --- | --- |
| no | no | no | still_unsuccessful | still_unsuccessful |

| 内容 | 原始记录 |
| --- | --- |
| reliability 答案 | 现有记录不足以支持完整结论或问题前提，请核对原文或补充记录。 |
| 本轮答案 | 现有记录不足以支持完整结论或问题前提，请核对原文或补充记录。 |
| reliability 原评理由 | Refuses/claims insufficient records instead of answering; question is answerable. |
| reliability 本次配对理由 | Refuses/claims insufficient records instead of answering the answerable question. |
| 本轮理由 | Refuses/claims insufficient records instead of answering; the passage states five independent decoders, implying different weights. |
| 旧 / 本轮参考充分性 | no / no |
| 本轮参考理由 | Selected references mention five independent decoders and their inputs/states, but none state whether the decoder LSTMs share weights; the gold paragraph also does not explicitly address weight sharing. |
| 最终生产原文参考 ID | source:0056b867-8122-4004-bc43-25fd67204dda:7c8a0b73-3b6a-46e9-9734-e49eb4e942e9, source:0056b867-8122-4004-bc43-25fd67204dda:99a5dba5-48ff-48dd-9e38-78acdc8b7b29, source:0056b867-8122-4004-bc43-25fd67204dda:2c617d30-268e-45da-96a6-0cc91661bf2a, source:0056b867-8122-4004-bc43-25fd67204dda:b7aa9590-9e5c-4ed8-9719-835845b5dc4f, source:0056b867-8122-4004-bc43-25fd67204dda:4ed951a9-15c4-432b-b827-f49c4081c7da, source:0056b867-8122-4004-bc43-25fd67204dda:683e67ac-3e5a-4524-bd86-eb1b8c732cd1, source:0056b867-8122-4004-bc43-25fd67204dda:00011657-a46d-4d6f-92d6-d081f5d2027f, source:0056b867-8122-4004-bc43-25fd67204dda:21f3eabb-4486-4b12-a466-7200557be9ea |
| 最终原文引用 ID | 无 |

### b08f88d1facefceb87e134ba2c1fa90035018e83 · 飞书 · 可答

Do the decoder LSTMs all have the same weights?

| reliability 原评 | 本次 reliability 配对 | 本轮 | 相对原评 | 相对配对 |
| --- | --- | --- | --- | --- |
| no | no | no | still_unsuccessful | still_unsuccessful |

| 内容 | 原始记录 |
| --- | --- |
| reliability 答案 | 项目记忆中没有足够依据，暂不自动回复。 |
| 本轮答案 | 项目记忆中没有足够依据，暂不自动回复。 |
| reliability 原评理由 | Refuses/claims insufficient records instead of answering; question is answerable. |
| reliability 本次配对理由 | Refuses with no answer; fails to state that decoders are independent/differently weighted. |
| 本轮理由 | Refuses with no answer; does not address whether decoder LSTMs share weights. |
| 旧 / 本轮参考充分性 | no / no |
| 本轮参考理由 | Connector references include the gold paragraph about five independent decoders but no statement about whether their weights are shared, so the question cannot be answered from the shown evidence. |
| 最终生产原文参考 ID | source:0056b867-8122-4004-bc43-25fd67204dda:7c8a0b73-3b6a-46e9-9734-e49eb4e942e9, source:0056b867-8122-4004-bc43-25fd67204dda:99a5dba5-48ff-48dd-9e38-78acdc8b7b29, source:0056b867-8122-4004-bc43-25fd67204dda:2c617d30-268e-45da-96a6-0cc91661bf2a, source:0056b867-8122-4004-bc43-25fd67204dda:b7aa9590-9e5c-4ed8-9719-835845b5dc4f, source:0056b867-8122-4004-bc43-25fd67204dda:4ed951a9-15c4-432b-b827-f49c4081c7da, source:0056b867-8122-4004-bc43-25fd67204dda:683e67ac-3e5a-4524-bd86-eb1b8c732cd1, source:0056b867-8122-4004-bc43-25fd67204dda:00011657-a46d-4d6f-92d6-d081f5d2027f, source:0056b867-8122-4004-bc43-25fd67204dda:21f3eabb-4486-4b12-a466-7200557be9ea |
| 最终原文引用 ID | 无 |

### 10fb7dc031075946153baf0a0599e126de29e3a4 · 桌面 · 可答

How does the neural network architecture accomodate an unknown amount of senses per word?

| reliability 原评 | 本次 reliability 配对 | 本轮 | 相对原评 | 相对配对 |
| --- | --- | --- | --- | --- |
| partial | partial | partial | still_unsuccessful | still_unsuccessful |

| 内容 | 原始记录 |
| --- | --- |
| reliability 答案 | The paper constructs context-gloss pairs from glosses of all possible senses (in WordNet) of the target word, treating WSD as a sentence-pair classification problem. [1]<br>For each target word, glosses of all N possible senses are extracted to form the gloss sentence; the example given uses N=4. [2]<br>GlossBERT将WSD建模为句对分类：为每个目标词构造上下文-释义对，释义取自该词在WordNet中所有可能义项的释义。 [3][1]<br>对每个目标词，抽取其全部N个可能义项的释义来构成释义句，示例中N=4。 [2]<br>因此每个目标词有N个上下文-释义对训练实例，标签为yes或no。 [4]<br>测试时输出每个上下文-释义对label=yes的概率，取概率最高的义项作为该目标词的预测标签。 [5]<br>上下文-释义对中加入[CLS]和[SEP]标记，以适配BERT模型的输入。 [6]<br>尚待确认：The records do not explicitly state how the architecture handles a variable or unknown number of senses per word beyond forming one context-gloss pair per sense; no padding, batching, or aggregation mechanism is documented.；未说明在形成每个义项一个上下文-释义对之后，架构如何通过填充、批处理或聚合机制处理每词可变或未知数量的义项。；记录未说明在形成每个义项一个上下文-释义对之后，架构如何通过填充、批处理或聚合机制处理每词可变或未知数量的义项。；How does the neural network architecture accomodate an unknown amount of senses per word? |
| 本轮答案 | GlossBERT将WSD任务转化为句对分类问题：它为目标词在WordNet中所有可能义项的释义分别构造上下文—释义对。 [1][2]<br>因此，义项数量是通过为每个义项各构造一个上下文—释义对来处理的，而不是把义项数固定为某个值。 [2][3]<br>记录中给出的示例将N设为4（N=4），但这是示例设定，并非架构上的固定上限。 [3]<br>这些上下文—释义对会加入[CLS]和[SEP]标记，以适配BERT的输入。 [4]<br>模型使用预训练的BERT（多层双向Transformer编码器），并在WSD任务上微调。 [5][6] |
| reliability 原评理由 | Adds the N-senses gloss sentence and [CLS]/[SEP] input details, but still does not explain how the architecture handles a variable/unknown number of senses; flagged as unknown. |
| reliability 本次配对理由 | Explains constructing one context-gloss pair per sense, but the human answer emphasizes converting WSD to a sequence learning task and extending gloss knowledge; it omits the sequence-learning framing and adds unconfirmed caveats. |
| 本轮理由 | Correctly explains one context-gloss pair per sense and that N=4 is an example, but does not mention converting WSD to a sequence learning task or extending gloss knowledge as in the human answer. |
| 旧 / 本轮参考充分性 | no / partial |
| 本轮参考理由 | Selected references include the gold paragraph (neural methods like Bi-LSTM, GAS, CAN/HCAN) but do not clearly explain how an unknown/variable number of senses per word is accommodated; only gloss-pair construction hints at it. |
| 最终生产原文参考 ID | source:55a90925-b81f-4148-9d51-243dbb5273e4:d28436f7-a2ad-4fff-8c64-1e4fe0d4b417, source:55a90925-b81f-4148-9d51-243dbb5273e4:ff2aeb65-abca-4ba3-838f-7849f4c810d8, source:55a90925-b81f-4148-9d51-243dbb5273e4:70462d99-ea16-425f-8dab-4588588ca354, source:55a90925-b81f-4148-9d51-243dbb5273e4:1290a492-68e9-4695-9f15-c1baea8728c8, source:55a90925-b81f-4148-9d51-243dbb5273e4:752f7893-0764-47df-ae8d-20a356a0ea70, source:55a90925-b81f-4148-9d51-243dbb5273e4:92e750b5-26c3-4477-a9cd-e057cb62e7cb, source:55a90925-b81f-4148-9d51-243dbb5273e4:a76cab5b-a329-4121-859a-f0547f3ad2b3, source:55a90925-b81f-4148-9d51-243dbb5273e4:0d0308f3-9c8a-4886-96da-fb34353f13fb |
| 最终原文引用 ID | source:55a90925-b81f-4148-9d51-243dbb5273e4:70462d99-ea16-425f-8dab-4588588ca354, source:55a90925-b81f-4148-9d51-243dbb5273e4:752f7893-0764-47df-ae8d-20a356a0ea70 |

### 10fb7dc031075946153baf0a0599e126de29e3a4 · 飞书 · 可答

How does the neural network architecture accomodate an unknown amount of senses per word?

| reliability 原评 | 本次 reliability 配对 | 本轮 | 相对原评 | 相对配对 |
| --- | --- | --- | --- | --- |
| partial | partial | partial | still_unsuccessful | still_unsuccessful |

| 内容 | 原始记录 |
| --- | --- |
| reliability 答案 | 对每个目标词，从WordNet中抽取该词全部N个可能词义的释义（gloss），文中示例N=4，以得到释义句。 [1]<br>系统从目标词所有可能词义（WordNet中）的释义构造上下文-释义对，从而把WSD任务视为句对分类问题。 [2]<br>在上下文-释义对中加入[CLS]和[SEP]标记，使其适合作为BERT模型的输入。 [3]<br>对每个目标词，系统从WordNet中抽取该词全部N个可能词义的释义（gloss）以得到释义句，文中示例N=4。 [1]<br>GlossBERT从目标词所有可能词义（WordNet中）的释义构造上下文-释义对，从而把WSD任务视为句对分类问题。 [4][2]<br>在上下文-释义对中加入[CLS]和[SEP]标记，使其适合作为BERT模型的输入。 [3][5]<br>尚待确认：记录未说明当每个词的词义数量未知或可变时，架构如何动态处理该数量（如逐对独立处理、填充或批处理等具体机制）。；未说明当每个词的词义数量未知或可变时，架构如何动态处理该数量（如逐对独立处理、填充或批处理等具体机制）。；How does the neural network architecture accomodate an unknown amount of senses per word?<br><br>依据：<br>[1] GlossBERT: BERT for Word Sense Disambiguation with Gloss Knowledge · 记忆 v1 · 当前版本原文依据（第 15 行）<br>[2] GlossBERT: BERT for Word Sense Disambiguation with Gloss Knowledge · 记忆 v1 · 当前版本原文依据（第 6 行）<br>[3] GlossBERT: BERT for Word Sense Disambiguation with Gloss Knowledge · 记忆 v1 · 当前版本原文依据（第 15 行）<br>[4] GlossBERT: BERT for Word Sense Disambiguation with Gloss Knowledge · 记忆 v1 · 当前版本原文依据（第 13 行）<br>[5] GlossBERT: BERT for Word Sense Disambiguation with Gloss Knowledge · 记忆 v1 · 当前版本原文依据（第 15 行） |
| 本轮答案 | GlossBERT 将 WSD 视为句对分类问题：为目标词所有可能义项（WordNet 中）的释义分别构造 context-gloss 对，每个义项对应一个句对。 [1][2]<br>对每个目标词，原文示例提取其全部 N 个可能义项（此处 N=4）的 WordNet 释义以得到 gloss sentence。 [3]<br>在 context-gloss 对中加入 [CLS] 和 [SEP] 标记，使其适合作为 BERT 模型的输入。 [4][5]<br>方法是在 WSD 任务上微调预训练的 BERT 模型，BERT 架构为多层双向 Transformer 编码器。 [6][7]<br>GlossBERT 将 WSD 视为句对分类问题：为目标词在 WordNet 中所有可能义项的释义分别构造 context-gloss 对，每个义项对应一个句对。 [8][1]<br>对每个目标词，原文示例提取其全部 N 个可能义项（此处 N=4）的 WordNet 释义以得到 gloss sentence。 [3][9]<br>训练时每个目标词有 N 个 context-gloss 对训练实例（标签为 yes/no）。 [10][11]<br>测试时输出每个 context-gloss 对 label=yes 的概率，并选择概率最高的义项作为该目标词的预测标签。 [12][11]<br>方法是在 WSD 任务上微调预训练的 BERT 模型，BERT 架构为多层双向 Transformer 编码器。 [13][7]<br>尚待确认：原文未说明当义项数量 N 不固定（未知数量）时，句对如何组织成批次或进行填充等具体处理。；原文未说明当每个词的义项数量 N 不固定（未知数量）时，句对如何组织成批次、是否填充或采用其他具体处理。；原文未说明当义项数量 N 不固定时，context-gloss 对如何组织成批次、是否填充或采用其他具体处理。；How does the neural network architecture accomodate an unknown amount of senses per word?<br><br>依据：<br>[1] GlossBERT: BERT for Word Sense Disambiguation with Gloss Knowledge · 记忆 v1 · 当前版本原文依据（第 6 行）<br>[2] GlossBERT: BERT for Word Sense Disambiguation with Gloss Knowledge · 导入原文（非正式记忆）（第 6 行）（第 6 行）<br>[3] GlossBERT: BERT for Word Sense Disambiguation with Gloss Knowledge · 记忆 v1 · 当前版本原文依据（第 15 行）<br>[4] GlossBERT: BERT for Word Sense Disambiguation with Gloss Knowledge · 记忆 v1 · 当前版本原文依据（第 15 行）<br>[5] GlossBERT: BERT for Word Sense Disambiguation with Gloss Knowledge · 记忆 v1 · 当前版本原文依据（第 15 行）<br>[6] GlossBERT: BERT for Word Sense Disambiguation with Gloss Knowledge · 记忆 v1 · 当前版本原文依据（第 11 行）<br>[7] GlossBERT: BERT for Word Sense Disambiguation with Gloss Knowledge · 记忆 v1 · 当前版本原文依据（第 11 行）<br>[8] GlossBERT: BERT for Word Sense Disambiguation with Gloss Knowledge · 记忆 v1 · 当前版本原文依据（第 13 行）<br>[9] GlossBERT: BERT for Word Sense Disambiguation with Gloss Knowledge · 导入原文（非正式记忆）（第 15 行）（第 15 行）<br>[10] GlossBERT: BERT for Word Sense Disambiguation with Gloss Knowledge · 记忆 v1 · 当前版本原文依据（第 17 行）<br>[11] GlossBERT: BERT for Word Sense Disambiguation with Gloss Knowledge · 导入原文（非正式记忆）（第 17 行）（第 17 行）<br>[12] GlossBERT: BERT for Word Sense Disambiguation with Gloss Knowledge · 记忆 v1 · 当前版本原文依据（第 17 行）<br>[13] GlossBERT: BERT for Word Sense Disambiguation with Gloss Knowledge · 记忆 v1 · 当前版本原文依据（第 6 行） |
| reliability 原评理由 | Covers gloss extraction for all N senses and BERT input formatting, but does not describe the mechanism for variable sense counts; explicitly marked unknown. |
| reliability 本次配对理由 | Describes context-gloss pairs per sense and BERT input formatting, but omits the human answer's sequence-learning conversion and gloss-knowledge extension framing. |
| 本轮理由 | Covers per-sense context-gloss pairs and BERT fine-tuning, but omits the human answer's sequence-learning conversion and gloss-knowledge extension points. |
| 旧 / 本轮参考充分性 | no / yes |
| 本轮参考理由 | Connector references include context-gloss pairs from all possible senses, N context-gloss pair instances per target, and selecting highest-probability sense, which explains handling a variable number of senses. |
| 最终生产原文参考 ID | source:55a90925-b81f-4148-9d51-243dbb5273e4:d28436f7-a2ad-4fff-8c64-1e4fe0d4b417, source:55a90925-b81f-4148-9d51-243dbb5273e4:ff2aeb65-abca-4ba3-838f-7849f4c810d8, source:55a90925-b81f-4148-9d51-243dbb5273e4:70462d99-ea16-425f-8dab-4588588ca354, source:55a90925-b81f-4148-9d51-243dbb5273e4:1290a492-68e9-4695-9f15-c1baea8728c8, source:55a90925-b81f-4148-9d51-243dbb5273e4:752f7893-0764-47df-ae8d-20a356a0ea70, source:55a90925-b81f-4148-9d51-243dbb5273e4:92e750b5-26c3-4477-a9cd-e057cb62e7cb, source:55a90925-b81f-4148-9d51-243dbb5273e4:a76cab5b-a329-4121-859a-f0547f3ad2b3, source:55a90925-b81f-4148-9d51-243dbb5273e4:0d0308f3-9c8a-4886-96da-fb34353f13fb, source:55a90925-b81f-4148-9d51-243dbb5273e4:d5697473-b601-4526-a5f0-93970bb30f4f, source:55a90925-b81f-4148-9d51-243dbb5273e4:dfadc7f4-ecb8-468b-be1a-f0349812e1ba, source:55a90925-b81f-4148-9d51-243dbb5273e4:92e750b5-26c3-4477-a9cd-e057cb62e7cb, source:55a90925-b81f-4148-9d51-243dbb5273e4:41ca9fc1-4a0e-44b3-942b-313efe547cb5, source:55a90925-b81f-4148-9d51-243dbb5273e4:d59306f7-3e04-49d5-8e3a-5b6044cf66a0, source:55a90925-b81f-4148-9d51-243dbb5273e4:d28436f7-a2ad-4fff-8c64-1e4fe0d4b417, source:55a90925-b81f-4148-9d51-243dbb5273e4:ff2aeb65-abca-4ba3-838f-7849f4c810d8 |
| 最终原文引用 ID | source:55a90925-b81f-4148-9d51-243dbb5273e4:70462d99-ea16-425f-8dab-4588588ca354, source:55a90925-b81f-4148-9d51-243dbb5273e4:dfadc7f4-ecb8-468b-be1a-f0349812e1ba, source:55a90925-b81f-4148-9d51-243dbb5273e4:d59306f7-3e04-49d5-8e3a-5b6044cf66a0 |

### c5b0ed5db65051eebd858beaf303809aa815e8e5 · 桌面 · 可答

Do they use large or small BERT?

| reliability 原评 | 本次 reliability 配对 | 本轮 | 相对原评 | 相对配对 |
| --- | --- | --- | --- | --- |
| yes | yes | yes | retained_success | retained_success |

| 内容 | 原始记录 |
| --- | --- |
| reliability 答案 | They use the pre-trained uncased BERT_BASE model for fine-tuning, not BERT_LARGE, because they find BERT_LARGE performs slightly worse than BERT_BASE on this task. [1] |
| 本轮答案 | They use the pre-trained uncased BERT_BASE model for fine-tuning, not BERT_LARGE. [1][2]<br>The stated reason is that BERT_LARGE performs slightly worse than BERT_BASE on this task. [1][2]<br>The recorded configuration matches BERT_BASE: 12 Transformer blocks, hidden size 768, 12 self-attention heads, and 110M parameters. [3][2] |
| reliability 原评理由 | States they use BERT_BASE (small BERT), matching the human answer. |
| reliability 本次配对理由 | States they use BERT_BASE, not BERT_LARGE, matching 'small BERT'. |
| 本轮理由 | States they use BERT_BASE (small), not BERT_LARGE, matching 'small BERT'. |
| 旧 / 本轮参考充分性 | yes / yes |
| 本轮参考理由 | Reference states they use pre-trained uncased BERT_BASE (small) model, directly answering small BERT. |
| 最终生产原文参考 ID | source:55a90925-b81f-4148-9d51-243dbb5273e4:ad85d452-6e86-457e-81fa-257f9e5f9fd2, source:55a90925-b81f-4148-9d51-243dbb5273e4:752f7893-0764-47df-ae8d-20a356a0ea70, source:55a90925-b81f-4148-9d51-243dbb5273e4:ff2aeb65-abca-4ba3-838f-7849f4c810d8, source:55a90925-b81f-4148-9d51-243dbb5273e4:665bc8ee-76ff-4a93-88e2-0d78f496c111, source:55a90925-b81f-4148-9d51-243dbb5273e4:fe97a3b1-c81b-4e43-8609-03aa287d2457, source:55a90925-b81f-4148-9d51-243dbb5273e4:3af22022-37cf-4754-a189-0dd3181b6fc7, source:55a90925-b81f-4148-9d51-243dbb5273e4:f6047421-1286-4763-bade-55a700e4e38e, source:55a90925-b81f-4148-9d51-243dbb5273e4:70462d99-ea16-425f-8dab-4588588ca354 |
| 最终原文引用 ID | source:55a90925-b81f-4148-9d51-243dbb5273e4:ad85d452-6e86-457e-81fa-257f9e5f9fd2 |

### c5b0ed5db65051eebd858beaf303809aa815e8e5 · 飞书 · 可答

Do they use large or small BERT?

| reliability 原评 | 本次 reliability 配对 | 本轮 | 相对原评 | 相对配对 |
| --- | --- | --- | --- | --- |
| yes | yes | yes | retained_success | retained_success |

| 内容 | 原始记录 |
| --- | --- |
| reliability 答案 | 他们使用预训练的 uncased BERT_BASE 模型进行微调，因为发现 BERT_LARGE 在该任务上表现略差于 BERT_BASE。 [1]<br><br>依据：<br>[1] GlossBERT: BERT for Word Sense Disambiguation with Gloss Knowledge · 记忆 v1 · 当前版本原文依据（第 25 行） |
| 本轮答案 | 他们使用的是预训练的无大小写 BERT_BASE 模型进行微调，而不是 BERT_LARGE；原因是他们发现 BERT_LARGE 在该任务上表现略差于 BERT_BASE。 [1][2]<br><br>依据：<br>[1] GlossBERT: BERT for Word Sense Disambiguation with Gloss Knowledge · 记忆 v1 · 当前版本原文依据（第 25 行）<br>[2] GlossBERT: BERT for Word Sense Disambiguation with Gloss Knowledge · 导入原文（非正式记忆）（第 25 行）（第 25 行） |
| reliability 原评理由 | States they use BERT_BASE (small BERT), matching the human answer. |
| reliability 本次配对理由 | States they use BERT_BASE rather than BERT_LARGE, matching 'small BERT'. |
| 本轮理由 | States they use BERT_BASE rather than BERT_LARGE, matching 'small BERT'. |
| 旧 / 本轮参考充分性 | yes / yes |
| 本轮参考理由 | Reference explicitly says they use BERT_BASE (small) rather than BERT_LARGE, sufficient to answer. |
| 最终生产原文参考 ID | source:55a90925-b81f-4148-9d51-243dbb5273e4:ad85d452-6e86-457e-81fa-257f9e5f9fd2, source:55a90925-b81f-4148-9d51-243dbb5273e4:752f7893-0764-47df-ae8d-20a356a0ea70, source:55a90925-b81f-4148-9d51-243dbb5273e4:ff2aeb65-abca-4ba3-838f-7849f4c810d8, source:55a90925-b81f-4148-9d51-243dbb5273e4:665bc8ee-76ff-4a93-88e2-0d78f496c111, source:55a90925-b81f-4148-9d51-243dbb5273e4:fe97a3b1-c81b-4e43-8609-03aa287d2457, source:55a90925-b81f-4148-9d51-243dbb5273e4:3af22022-37cf-4754-a189-0dd3181b6fc7, source:55a90925-b81f-4148-9d51-243dbb5273e4:f6047421-1286-4763-bade-55a700e4e38e, source:55a90925-b81f-4148-9d51-243dbb5273e4:70462d99-ea16-425f-8dab-4588588ca354 |
| 最终原文引用 ID | source:55a90925-b81f-4148-9d51-243dbb5273e4:ad85d452-6e86-457e-81fa-257f9e5f9fd2 |

### 7ab9c0b4ceca1c142ff068f85015a249b14282d0 · 桌面 · 可答

Do they incoprorate WordNet into the model?

| reliability 原评 | 本次 reliability 配对 | 本轮 | 相对原评 | 相对配对 |
| --- | --- | --- | --- | --- |
| yes | yes | yes | retained_success | retained_success |

| 内容 | 原始记录 |
| --- | --- |
| reliability 答案 | Yes. The paper constructs context-gloss pairs from glosses of all possible senses (in WordNet) of the target word, treating WSD as a sentence-pair classification problem. [1]<br>For each target word, the authors extract glosses of all N possible senses (N=4) from WordNet to obtain the gloss sentence. [2]<br>The authors extract word sense glosses from WordNet 3.0, since BIBREF17 maps all sense annotations in these datasets to WordNet 3.0. [3]<br>The extracted context-gloss pairs are fed to the pre-trained BERT model, which the authors fine-tune on the WSD task. [4][5] |
| 本轮答案 | Yes. The paper's GlossBERT constructs context-gloss pairs from glosses of all possible senses of the target word in WordNet, treating WSD as a sentence-pair classification problem. [1][2]<br>For each target word, the authors extract glosses of all N possible senses (N=4) in WordNet to form the gloss sentence. [3][4]<br>They extract word sense glosses from WordNet 3.0, since the datasets' sense annotations were mapped to WordNet 3.0. [5][6]<br>Candidate senses for each target come from entries of its lemma in a pre-defined sense inventory, usually WordNet. [7] |
| reliability 原评理由 | Affirms WordNet use with the context-gloss pair construction, matching human answers. |
| reliability 本次配对理由 | Affirms WordNet use and cites constructing context-gloss pairs from all WordNet senses, matching the human answers. |
| 本轮理由 | Affirms WordNet incorporation via context-gloss pairs from all senses in WordNet, matching human answers. |
| 旧 / 本轮参考充分性 | yes / yes |
| 本轮参考理由 | References explicitly state they construct context-gloss pairs from all possible senses of the target word in WordNet, directly answering that WordNet is incorporated. |
| 最终生产原文参考 ID | source:55a90925-b81f-4148-9d51-243dbb5273e4:d5697473-b601-4526-a5f0-93970bb30f4f, source:55a90925-b81f-4148-9d51-243dbb5273e4:dfadc7f4-ecb8-468b-be1a-f0349812e1ba, source:55a90925-b81f-4148-9d51-243dbb5273e4:08496d7d-30df-4ef1-9408-3bcefd1b629f, source:55a90925-b81f-4148-9d51-243dbb5273e4:70462d99-ea16-425f-8dab-4588588ca354, source:55a90925-b81f-4148-9d51-243dbb5273e4:92e750b5-26c3-4477-a9cd-e057cb62e7cb, source:55a90925-b81f-4148-9d51-243dbb5273e4:b616368e-bc16-46d1-a374-f2075a2cd61a, source:55a90925-b81f-4148-9d51-243dbb5273e4:752f7893-0764-47df-ae8d-20a356a0ea70, source:55a90925-b81f-4148-9d51-243dbb5273e4:2456bfd6-b9a6-4afe-a678-8e34a801b6b2 |
| 最终原文引用 ID | source:55a90925-b81f-4148-9d51-243dbb5273e4:70462d99-ea16-425f-8dab-4588588ca354, source:55a90925-b81f-4148-9d51-243dbb5273e4:d5697473-b601-4526-a5f0-93970bb30f4f, source:55a90925-b81f-4148-9d51-243dbb5273e4:dfadc7f4-ecb8-468b-be1a-f0349812e1ba, source:55a90925-b81f-4148-9d51-243dbb5273e4:92e750b5-26c3-4477-a9cd-e057cb62e7cb |

### 7ab9c0b4ceca1c142ff068f85015a249b14282d0 · 飞书 · 可答

Do they incoprorate WordNet into the model?

| reliability 原评 | 本次 reliability 配对 | 本轮 | 相对原评 | 相对配对 |
| --- | --- | --- | --- | --- |
| yes | yes | yes | retained_success | retained_success |

| 内容 | 原始记录 |
| --- | --- |
| reliability 答案 | 是。该工作从WordNet 3.0提取词义释义（gloss），并据此为目标词所有可能词义构建上下文-释义对。 [1][2]<br>具体做法是为每个目标词从WordNet中提取其全部N个可能词义的释义（示例中N=4）。 [3]<br>候选词义来自目标词lemma在预定义词义清单（通常为WordNet）中的条目。 [4]<br><br>依据：<br>[1] GlossBERT: BERT for Word Sense Disambiguation with Gloss Knowledge · 记忆 v1 · 当前版本原文依据（第 24 行）<br>[2] GlossBERT: BERT for Word Sense Disambiguation with Gloss Knowledge · 记忆 v1 · 当前版本原文依据（第 6 行）<br>[3] GlossBERT: BERT for Word Sense Disambiguation with Gloss Knowledge · 记忆 v1 · 当前版本原文依据（第 15 行）<br>[4] GlossBERT: BERT for Word Sense Disambiguation with Gloss Knowledge · 记忆 v1 · 当前版本原文依据（第 10 行） |
| 本轮答案 | 是。GlossBERT 从 WordNet 中目标词的所有可能义项抽取释义，构建上下文—释义对，从而把 WSD 视为句对分类问题。 [1][2]<br>具体做法是：对每个目标词，从 WordNet 中抽取其全部 N 个可能义项（文中示例 N=4）的释义，得到释义句。 [3][4]<br>候选义项来自目标词词元在预定义义项库（通常为 WordNet）中的条目。 [5]<br>由于相关数据集的所有义项标注已被映射到 WordNet 3.0，他们从 WordNet 3.0 抽取词义释义。 [6][7]<br><br>依据：<br>[1] GlossBERT: BERT for Word Sense Disambiguation with Gloss Knowledge · 记忆 v1 · 当前版本原文依据（第 13 行）<br>[2] GlossBERT: BERT for Word Sense Disambiguation with Gloss Knowledge · 记忆 v1 · 当前版本原文依据（第 6 行）<br>[3] GlossBERT: BERT for Word Sense Disambiguation with Gloss Knowledge · 记忆 v1 · 当前版本原文依据（第 15 行）<br>[4] GlossBERT: BERT for Word Sense Disambiguation with Gloss Knowledge · 导入原文（非正式记忆）（第 15 行）（第 15 行）<br>[5] GlossBERT: BERT for Word Sense Disambiguation with Gloss Knowledge · 记忆 v1 · 当前版本原文依据（第 10 行）<br>[6] GlossBERT: BERT for Word Sense Disambiguation with Gloss Knowledge · 记忆 v1 · 当前版本原文依据（第 24 行）<br>[7] GlossBERT: BERT for Word Sense Disambiguation with Gloss Knowledge · 导入原文（非正式记忆）（第 24 行）（第 24 行） |
| reliability 原评理由 | States glosses extracted from WordNet 3.0 and context-gloss pairs built, matching gold. |
| reliability 本次配对理由 | States WordNet 3.0 glosses used to build context-gloss pairs from all senses, equivalent to the gold answer. |
| 本轮理由 | Says GlossBERT extracts glosses from all WordNet senses to build context-gloss pairs, equivalent to gold. |
| 旧 / 本轮参考充分性 | yes / yes |
| 本轮参考理由 | References include the same statement about constructing context-gloss pairs from WordNet senses, sufficient to answer yes. |
| 最终生产原文参考 ID | source:55a90925-b81f-4148-9d51-243dbb5273e4:d5697473-b601-4526-a5f0-93970bb30f4f, source:55a90925-b81f-4148-9d51-243dbb5273e4:dfadc7f4-ecb8-468b-be1a-f0349812e1ba, source:55a90925-b81f-4148-9d51-243dbb5273e4:08496d7d-30df-4ef1-9408-3bcefd1b629f, source:55a90925-b81f-4148-9d51-243dbb5273e4:70462d99-ea16-425f-8dab-4588588ca354, source:55a90925-b81f-4148-9d51-243dbb5273e4:92e750b5-26c3-4477-a9cd-e057cb62e7cb, source:55a90925-b81f-4148-9d51-243dbb5273e4:b616368e-bc16-46d1-a374-f2075a2cd61a, source:55a90925-b81f-4148-9d51-243dbb5273e4:752f7893-0764-47df-ae8d-20a356a0ea70, source:55a90925-b81f-4148-9d51-243dbb5273e4:2456bfd6-b9a6-4afe-a678-8e34a801b6b2 |
| 最终原文引用 ID | source:55a90925-b81f-4148-9d51-243dbb5273e4:dfadc7f4-ecb8-468b-be1a-f0349812e1ba, source:55a90925-b81f-4148-9d51-243dbb5273e4:92e750b5-26c3-4477-a9cd-e057cb62e7cb |

### d28d86524292506d4b24ae2d486725a6d57a3db3 · 桌面 · 可答

What is the ROUGE score of the highest performing model?

| reliability 原评 | 本次 reliability 配对 | 本轮 | 相对原评 | 相对配对 |
| --- | --- | --- | --- | --- |
| yes | yes | yes | retained_success | retained_success |

| 内容 | 原始记录 |
| --- | --- |
| reliability 答案 | The highest-performing model is not explicitly named; the paper's own model is reported as achieving a 33.33 average of ROUGE-1, ROUGE-2 and ROUGE-L on CNN/Daily Mail, described as state-of-the-art. [1][2]<br>The 33.33 figure is an average across ROUGE-1, ROUGE-2 and ROUGE-L, not a single ROUGE metric value. [1]<br>论文未明确点名“最高性能模型”；其自身模型在 CNN/Daily Mail 上报告的 ROUGE-1、ROUGE-2 和 ROUGE-L 平均值为 33.33，并称达到 state-of-the-art。 [1][2]<br>33.33 是 ROUGE-1、ROUGE-2 和 ROUGE-L 三项的平均值，并非单一 ROUGE 指标分数。 [1]<br>尚待确认：未明确点名“最高性能模型”的具体身份，也未给出其单一 ROUGE 指标分数；仅有作者模型在 CNN/Daily Mail 上三项 ROUGE 的平均值 33.33。；What is the ROUGE score of the highest performing model? |
| 本轮答案 | 记录中未给出“最高性能模型”的单独 ROUGE 分数；可确认的是，作者称其模型在 CNN/Daily Mail 上取得 ROUGE-1、ROUGE-2 和 ROUGE-L 的平均值 33.33，并称其为 state-of-the-art。 [1][2]<br>记录未给出“最高性能模型”单独的 ROUGE-1、ROUGE-2 或 ROUGE-L 数值；可确认的是，作者称其模型在 CNN/Daily Mail 上取得 ROUGE-1、ROUGE-2 和 ROUGE-L 的平均值 33.33，并称其为 state-of-the-art。 [1][3]<br>尚待确认：记录未明确哪个模型是“最高性能模型”，也未给出该模型单独的 ROUGE-1、ROUGE-2 或 ROUGE-L 具体数值。；最高性能模型单独的 ROUGE-1、ROUGE-2、ROUGE-L 具体数值未给出，仅有三者平均值 33.33。；What is the ROUGE score of the highest performing model? |
| reliability 原评理由 | Gives 33.33 average of ROUGE-1/2/L, matching the gold answer. |
| reliability 本次配对理由 | States the model achieves a 33.33 average of ROUGE-1, ROUGE-2, and ROUGE-L, matching the gold answer. |
| 本轮理由 | Gives the 33.33 average of ROUGE-1, ROUGE-2, and ROUGE-L, matching the gold answer. |
| 旧 / 本轮参考充分性 | yes / yes |
| 本轮参考理由 | Reference memory:b77628c1 and f00cd9ef state the model achieves a 33.33 average ROUGE-1/2/L, matching the gold answer. |
| 最终生产原文参考 ID | source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:a4c0a79c-6847-4caf-a229-37ec0ae28aa3, source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:71d240a3-78bd-4321-af65-e6e5992e0f11, source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:164347ea-a560-4767-b2b4-49ca4260ef99, source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:f27858f2-0ec4-4488-bb8c-67562f1145b8, source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:eaaa6dbc-9f71-4bf3-a66d-d6c08efa151a, source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:b80902c4-dcc7-49f4-98db-145cc38bea08, source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:09dc8eda-ae4a-4665-8cb6-d08c77cb047a, source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:c82105da-a420-470f-bae2-7c4a632bc92a, source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:164347ea-a560-4767-b2b4-49ca4260ef99, source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:a4c0a79c-6847-4caf-a229-37ec0ae28aa3, source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:71d240a3-78bd-4321-af65-e6e5992e0f11, source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:09dc8eda-ae4a-4665-8cb6-d08c77cb047a, source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:f27858f2-0ec4-4488-bb8c-67562f1145b8, source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:eaaa6dbc-9f71-4bf3-a66d-d6c08efa151a, source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:b80902c4-dcc7-49f4-98db-145cc38bea08, source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:3d9780d1-da90-43c8-9e11-ff0d10a290eb |
| 最终原文引用 ID | source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:b80902c4-dcc7-49f4-98db-145cc38bea08 |

### d28d86524292506d4b24ae2d486725a6d57a3db3 · 飞书 · 可答

What is the ROUGE score of the highest performing model?

| reliability 原评 | 本次 reliability 配对 | 本轮 | 相对原评 | 相对配对 |
| --- | --- | --- | --- | --- |
| yes | yes | yes | retained_success | retained_success |

| 内容 | 原始记录 |
| --- | --- |
| reliability 答案 | 在 CNN/Daily Mail 上，我们的模型在 ROUGE-1、ROUGE-2 和 ROUGE-L 上的平均值为 33.33，并称其为 state-of-the-art。 [1][2]<br>在 CNN/Daily Mail 上，我们的模型在 ROUGE-1、ROUGE-2 和 ROUGE-L 上的平均值为 33.33，并称其为 state-of-the-art。 [2][1]<br>尚待确认：未明确记录“最高性能模型”的具体身份，也未给出其单独的 ROUGE-1、ROUGE-2、ROUGE-L 各项分数；仅记录了上述平均值与相对提升。；最高性能模型的具体身份未明确；最高性能模型单独的 ROUGE-1、ROUGE-2、ROUGE-L 各项分数未给出；未明确记录“最高性能模型”的具体身份。；未给出该模型单独的 ROUGE-1、ROUGE-2、ROUGE-L 各项分数，仅记录了上述平均值。；该模型单独的 ROUGE-1、ROUGE-2、ROUGE-L 各项分数未给出<br><br>依据：<br>[1] Pretraining-Based Natural Language Generation for Text Summarization · 记忆 v1 · 当前版本原文依据（第 8 行）<br>[2] Pretraining-Based Natural Language Generation for Text Summarization · 记忆 v1 · 当前版本原文依据（第 8 行） |
| 本轮答案 | 在 CNN/Daily Mail 上，该模型（“our model”）取得 ROUGE-1、ROUGE-2 和 ROUGE-L 的平均分 33.33，原文称其为 state-of-the-art。 [1][2][3]<br>在 CNN/Daily Mail 上，ROUGE-1、ROUGE-2、ROUGE-L 报告的是全长 F-1 分数，使用 PyRouge 包和 Porter stemmer 选项计算。 [4][5]<br>在 New York Times 数据集上，该模型在 ROUGE-1 上取得约 5.6% 的相对提升。 [6][7][3]<br>在 NYT50 上，评估的是限定长度的 ROUGE recall 分数（将生成摘要长度限制为真实摘要长度）。 [8][5]<br>尚待确认：原文未明确以“最高性能模型”这一名称指代某一模型，也未给出该模型在全部数据集上的单一 ROUGE 总分；上述分数分别对应 CNN/Daily Mail 的平均分与 New York Times 的 ROUGE-1 相对提升。<br><br>依据：<br>[1] Pretraining-Based Natural Language Generation for Text Summarization · 记忆 v1 · 当前版本原文依据（第 8 行）<br>[2] Pretraining-Based Natural Language Generation for Text Summarization · 记忆 v1 · 当前版本原文依据（第 8 行）<br>[3] Pretraining-Based Natural Language Generation for Text Summarization · 导入原文（非正式记忆）（第 8 行）（第 8 行）<br>[4] Pretraining-Based Natural Language Generation for Text Summarization · 记忆 v1 · 当前版本原文依据（第 59 行）<br>[5] Pretraining-Based Natural Language Generation for Text Summarization · 导入原文（非正式记忆）（第 59 行）（第 59 行）<br>[6] Pretraining-Based Natural Language Generation for Text Summarization · 记忆 v1 · 当前版本原文依据（第 8 行）<br>[7] Pretraining-Based Natural Language Generation for Text Summarization · 记忆 v1 · 当前版本原文依据（第 8 行）<br>[8] Pretraining-Based Natural Language Generation for Text Summarization · 记忆 v1 · 当前版本原文依据（第 59 行） |
| reliability 原评理由 | States the 33.33 average ROUGE score, matching the human answer. |
| reliability 本次配对理由 | Reports the 33.33 average of ROUGE-1/2/L on CNN/Daily Mail, matching the gold answer. |
| 本轮理由 | States the 33.33 average of ROUGE-1/2/L on CNN/Daily Mail, matching the gold answer. |
| 旧 / 本轮参考充分性 | yes / yes |
| 本轮参考理由 | Reference b77628c1 and f00cd9ef state the 33.33 average ROUGE score, matching the gold answer. |
| 最终生产原文参考 ID | source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:a4c0a79c-6847-4caf-a229-37ec0ae28aa3, source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:71d240a3-78bd-4321-af65-e6e5992e0f11, source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:164347ea-a560-4767-b2b4-49ca4260ef99, source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:f27858f2-0ec4-4488-bb8c-67562f1145b8, source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:eaaa6dbc-9f71-4bf3-a66d-d6c08efa151a, source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:b80902c4-dcc7-49f4-98db-145cc38bea08, source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:09dc8eda-ae4a-4665-8cb6-d08c77cb047a, source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:c82105da-a420-470f-bae2-7c4a632bc92a |
| 最终原文引用 ID | source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:b80902c4-dcc7-49f4-98db-145cc38bea08, source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:164347ea-a560-4767-b2b4-49ca4260ef99 |

### 63488da6c7aff9e374561a24ba224e9ce7f65e40 · 桌面 · 无答案

When is this paper published?

| reliability 原评 | 本次 reliability 配对 | 本轮 | 相对原评 | 相对配对 |
| --- | --- | --- | --- | --- |
| yes | yes | yes | retained_success | retained_success |

| 内容 | 原始记录 |
| --- | --- |
| reliability 答案 | 现有记录不足以支持完整结论或问题前提，请核对原文或补充记录。 |
| 本轮答案 | 现有记录不足以支持完整结论或问题前提，请核对原文或补充记录。 |
| reliability 原评理由 | Explicitly states records are insufficient, refusing without inventing facts. |
| reliability 本次配对理由 | Explicitly states records are insufficient, refusing without inventing facts. |
| 本轮理由 | Explicitly states records are insufficient, refusing without inventing facts. |
| 旧 / 本轮参考充分性 | no / no |
| 本轮参考理由 | No reference states the paper's publication date; the only date mentioned (January 1, 2007) refers to dataset test-set filtering, not the paper. |
| 最终生产原文参考 ID | source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:e9cb2509-d7d8-4dff-8bb9-458dcd10274b, source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:a93e50f4-2b45-4f39-bf60-f8765adda722, source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:60e33ac2-d815-47f3-8b5f-e8f1f36bb968, source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:e651ee13-e0f0-4c18-94f7-fd07c93da085, source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:0d8669c9-8a98-4484-855b-a1ba47677bad |
| 最终原文引用 ID | 无 |

### 63488da6c7aff9e374561a24ba224e9ce7f65e40 · 飞书 · 无答案

When is this paper published?

| reliability 原评 | 本次 reliability 配对 | 本轮 | 相对原评 | 相对配对 |
| --- | --- | --- | --- | --- |
| yes | yes | yes | retained_success | retained_success |

| 内容 | 原始记录 |
| --- | --- |
| reliability 答案 | 项目记忆中没有足够依据，暂不自动回复。 |
| 本轮答案 | 项目记忆中没有足够依据，暂不自动回复。 |
| reliability 原评理由 | States insufficient basis and declines to answer, a valid refusal. |
| reliability 本次配对理由 | Explicitly says insufficient basis, a valid refusal with no invented facts. |
| 本轮理由 | Explicitly says insufficient basis, a valid refusal with no invented facts. |
| 旧 / 本轮参考充分性 | no / no |
| 本轮参考理由 | Same references; the January 1, 2007 date concerns NYT dataset examples, not the paper's publication date, so the question remains unanswered. |
| 最终生产原文参考 ID | source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:e9cb2509-d7d8-4dff-8bb9-458dcd10274b, source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:a93e50f4-2b45-4f39-bf60-f8765adda722, source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:60e33ac2-d815-47f3-8b5f-e8f1f36bb968, source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:e651ee13-e0f0-4c18-94f7-fd07c93da085, source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:0d8669c9-8a98-4484-855b-a1ba47677bad |
| 最终原文引用 ID | 无 |

### c1c44fd96c3fa6e16949ae8fa453e511c6435c68 · 桌面 · 可答

Why masking words in the decoder is helpful?

| reliability 原评 | 本次 reliability 配对 | 本轮 | 相对原评 | 相对配对 |
| --- | --- | --- | --- | --- |
| yes | yes | yes | retained_success | retained_success |

| 内容 | 原始记录 |
| --- | --- |
| reliability 答案 | 掩码解码器逐词掩码摘要草稿中的每个词，再由精炼解码器基于源文档和其他词一次预测一个精炼词，使每个词的预测能利用两侧上下文信息。 [1][2][3]<br>该掩码精炼过程类似BERT的完形填空预训练任务，可借助上下文语言模型能力生成更流畅自然的序列。 [4]<br>从BERT等上下文化嵌入的角度看，精炼解码提供了更完整的输入序列，与其预训练过程一致。 [5]<br>引入精炼过程的主要目的是利用BERT的上下文化表示增强解码器。 [6] |
| 本轮答案 | 掩码解码器逐词掩码摘要草稿中的每个词，再让解码器在给定摘要其他词的条件下预测该位置的细化词，因此每个词都能利用两侧上下文信息。 [1][2]<br>该过程与BERT预训练中的完形填空任务相似，借助上下文语言模型的能力，解码器可以生成更流畅、更自然的序列。 [3]<br>从BERT等上下文化嵌入的角度看，细化解码提供了更完整的输入序列，与其预训练过程一致。 [4]<br>细化解码器一次聚焦一个词，依据源文档以及其他词来编辑草稿。 [4]<br>引入细化过程的主要原因是利用BERT的上下文化表示增强解码器。 [5]<br>此前抽象式方法使用仅左上下文的解码器，预测每个词时没有完整上下文；掩码细化正是为弥补这一问题而设计。 [6][7] |
| reliability 原评理由 | States masking is similar to BERT's cloze task and lets the contextual LM generate more fluent/natural sequences, matching the gold answer. |
| reliability 本次配对理由 | Gives the key reason: masking resembles BERT's cloze pretraining, enabling more fluent and natural sequences via the contextual LM. |
| 本轮理由 | States the masking makes the process similar to BERT's cloze task, letting the contextual LM generate more fluent/natural sequences, matching the human answer. |
| 旧 / 本轮参考充分性 | yes / yes |
| 本轮参考理由 | Reference e5b4cdb9 states masking is like BERT's cloze task, letting the contextual LM generate more fluent/natural sequences, matching the gold answer. |
| 最终生产原文参考 ID | source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:27a600b7-1369-4595-9e89-d197b126d8c0, source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:e651ee13-e0f0-4c18-94f7-fd07c93da085, source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:2ebdf0ea-0934-44bc-8801-46fc1e317979, source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:df5002d6-0135-4112-abb7-868dec01e9d3, source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:c19d5d54-3ab2-4c05-b0ef-9567276f84a5, source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:7045767c-55b2-44ab-9ce2-f3b846de1140, source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:a497bf4e-6855-4d3c-b8fd-421469b78016, source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:adc15522-4123-4050-aef1-d6c6549a8029 |
| 最终原文引用 ID | source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:27a600b7-1369-4595-9e89-d197b126d8c0, source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:a497bf4e-6855-4d3c-b8fd-421469b78016, source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:7045767c-55b2-44ab-9ce2-f3b846de1140, source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:df5002d6-0135-4112-abb7-868dec01e9d3, source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:adc15522-4123-4050-aef1-d6c6549a8029, source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:e651ee13-e0f0-4c18-94f7-fd07c93da085 |

### c1c44fd96c3fa6e16949ae8fa453e511c6435c68 · 飞书 · 可答

Why masking words in the decoder is helpful?

| reliability 原评 | 本次 reliability 配对 | 本轮 | 相对原评 | 相对配对 |
| --- | --- | --- | --- | --- |
| yes | yes | yes | retained_success | retained_success |

| 内容 | 原始记录 |
| --- | --- |
| reliability 答案 | 掩码词级精炼解码与BERT预训练中的完形填空任务相似，因此可利用上下文语言模型的能力生成更流畅、自然的序列。 [1]<br>精炼解码过程为BERT等上下文化嵌入提供更完整的输入序列，与其预训练过程一致。 [2]<br>精炼解码器接收生成的摘要草稿作为输入，逐词掩码并基于源文档及其他词预测精炼词，从而输出精炼摘要。 [3][4]<br>该设计旨在解决以往抽象式方法仅使用左上下文解码器、预测每个词时缺乏完整上下文的问题。 [5][6]<br><br>依据：<br>[1] Pretraining-Based Natural Language Generation for Text Summarization · 记忆 v1 · 当前版本原文依据（第 46 行）<br>[2] Pretraining-Based Natural Language Generation for Text Summarization · 记忆 v1 · 当前版本原文依据（第 45 行）<br>[3] Pretraining-Based Natural Language Generation for Text Summarization · 记忆 v1 · 当前版本原文依据（第 42 行）<br>[4] Pretraining-Based Natural Language Generation for Text Summarization · 记忆 v1 · 当前版本原文依据（第 45 行）<br>[5] Pretraining-Based Natural Language Generation for Text Summarization · 记忆 v1 · 当前版本原文依据（第 3 行）<br>[6] Pretraining-Based Natural Language Generation for Text Summarization · 记忆 v1 · 当前版本原文依据（第 7 行） |
| 本轮答案 | 掩码设计使精炼解码过程类似于BERT预训练中的完形填空（cloze）任务，从而利用上下文语言模型的能力生成更流畅、自然的序列。 [1][2]<br>从BERT或其他上下文化嵌入的角度看，精炼解码过程提供了更完整的输入序列，与其预训练过程一致。 [3][4]<br>精炼解码器逐个掩码摘要草稿中的每个词，再将草稿送入BERT生成上下文向量，最后预测精炼后的摘要词。 [5][6]<br>在精炼阶段，解码器基于源文档及其他词，一次集中处理一个词，从而编辑草稿。 [7][4]<br>该两阶段解码架构使模型在生成摘要的每个词时能考虑两侧的上下文信息。 [8][9]<br><br>依据：<br>[1] Pretraining-Based Natural Language Generation for Text Summarization · 记忆 v1 · 当前版本原文依据（第 46 行）<br>[2] Pretraining-Based Natural Language Generation for Text Summarization · 导入原文（非正式记忆）（第 46 行）（第 46 行）<br>[3] Pretraining-Based Natural Language Generation for Text Summarization · 记忆 v1 · 当前版本原文依据（第 45 行）<br>[4] Pretraining-Based Natural Language Generation for Text Summarization · 导入原文（非正式记忆）（第 45 行）（第 45 行）<br>[5] Pretraining-Based Natural Language Generation for Text Summarization · 记忆 v1 · 当前版本原文依据（第 42 行）<br>[6] Pretraining-Based Natural Language Generation for Text Summarization · 导入原文（非正式记忆）（第 42 行）（第 42 行）<br>[7] Pretraining-Based Natural Language Generation for Text Summarization · 记忆 v1 · 当前版本原文依据（第 45 行）<br>[8] Pretraining-Based Natural Language Generation for Text Summarization · 记忆 v1 · 当前版本原文依据（第 7 行）<br>[9] Pretraining-Based Natural Language Generation for Text Summarization · 导入原文（非正式记忆）（第 7 行）（第 7 行） |
| reliability 原评理由 | Includes the core reason: cloze-task similarity and using contextual LM ability to produce more fluent, natural sequences. |
| reliability 本次配对理由 | States the cloze-task similarity and contextual LM ability yielding more fluent, natural sequences, matching the human answer. |
| 本轮理由 | Includes the core reason: cloze-task similarity and using contextual LM ability to produce more fluent, natural sequences. |
| 旧 / 本轮参考充分性 | yes / yes |
| 本轮参考理由 | Reference 7045767c gives the cloze-task/BERT rationale and fluent natural sequence benefit, matching the gold evidence. |
| 最终生产原文参考 ID | source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:27a600b7-1369-4595-9e89-d197b126d8c0, source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:e651ee13-e0f0-4c18-94f7-fd07c93da085, source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:2ebdf0ea-0934-44bc-8801-46fc1e317979, source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:df5002d6-0135-4112-abb7-868dec01e9d3, source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:c19d5d54-3ab2-4c05-b0ef-9567276f84a5, source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:7045767c-55b2-44ab-9ce2-f3b846de1140, source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:a497bf4e-6855-4d3c-b8fd-421469b78016, source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:adc15522-4123-4050-aef1-d6c6549a8029 |
| 最终原文引用 ID | source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:7045767c-55b2-44ab-9ce2-f3b846de1140, source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:df5002d6-0135-4112-abb7-868dec01e9d3, source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:27a600b7-1369-4595-9e89-d197b126d8c0, source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:a497bf4e-6855-4d3c-b8fd-421469b78016 |

### feafcc1c4026d7f55a2c8ce7850d7e12030b5c22 · 桌面 · 可答

How are the different components of the model trained? Is it trained end-to-end?

| reliability 原评 | 本次 reliability 配对 | 本轮 | 相对原评 | 相对配对 |
| --- | --- | --- | --- | --- |
| yes | yes | yes | retained_success | retained_success |

| 内容 | 原始记录 |
| --- | --- |
| reliability 答案 | The proposed BERT-based natural language generation model can be trained end-to-end without handcrafted features. [1]<br>The model uses a two-stage decoder process, in which each summary word is generated considering both sides' context information. [2]<br>During model training, the objective is the sum of the two processes, jointly trained using the "teacher-forcing" algorithm, feeding the ground-truth summary to each decoder and minimizing the objective. [3]<br>The model loss is defined as the sum of the decoder loss and the refine loss (L_model = L_dec + L_refine). [4]<br>Training uses an Adam optimizer with learning rate 3e-4, β1=0.9, β2=0.999, ε=1e-9, and a dynamic learning rate. [5]<br>Due to GPU memory limits, gradient accumulation is used with an accumulate step of 12 and 3 samples fed at each step. [6]<br>Training uses batch size 36 for 4 epochs (8 epochs for NYT50), with the best model selected from the last 10 models based on development set performance. [7] |
| 本轮答案 | 该模型是基于BERT的自然语言生成模型，在编码器和解码器过程中利用预训练语言模型，并且可以在无需手工特征的情况下进行端到端训练。 [1][2]<br>模型采用两阶段解码器流程，使生成摘要的每个词时能同时考虑两侧的上下文信息。 [3]<br>训练时模型的目标是两个过程目标之和，使用“teacher-forcing”算法联合训练；训练中把真实摘要输入每个解码器并最小化该目标。 [4][5]<br>模型目标函数记为 L_model = L̂_dec + L̂_refine。 [6]<br>消融实验中的模型变体包括：One-Stage（基于BERT、带复制机制的序列到序列模型）、Two-Stage（在One-Stage上加入word-refine解码器）、Two-Stage + RL（带refine过程并结合RL目标的完整模型）。 [7]<br>训练设置：batch size为36，训练4个epoch（NYT50因训练样本少得多而训练8个epoch），训练后根据开发集表现从最后10个模型中选出最佳模型。 [8]<br>训练使用Adam优化器，学习率3e-4，β1=0.9、β2=0.999、ε=10^-9，并在训练过程中使用动态学习率。 [9] |
| reliability 原评理由 | States end-to-end training and joint teacher-forcing training with summed objective, matching the human answers. |
| reliability 本次配对理由 | States end-to-end training and joint teacher-forcing training of the summed two-process objective, matching the gold answer. |
| 本轮理由 | States end-to-end training and joint teacher-forcing training of the summed two-process objective, matching the gold answer. |
| 旧 / 本轮参考充分性 | yes / yes |
| 本轮参考理由 | References include the joint teacher-forcing training objective (sum of two processes, ground-truth summary fed to each decoder) and the end-to-end trainable statement, covering both parts of the question. |
| 最终生产原文参考 ID | source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:5ced2a89-cc66-43ad-a164-9741ed1c6d28, source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:69e754d8-fa92-4c16-814c-464311c3ab64, source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:4cbb716e-93d4-477c-9259-cd9cb2fae1a7, source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:19964b0c-3dd0-4d05-9c52-54775a99729f, source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:f27858f2-0ec4-4488-bb8c-67562f1145b8, source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:09dc8eda-ae4a-4665-8cb6-d08c77cb047a, source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:69580ab6-28a4-4bab-ac02-621f830d0550, source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:dc5013e2-0661-42db-96b3-cfe46ce005f1 |
| 最终原文引用 ID | source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:5ced2a89-cc66-43ad-a164-9741ed1c6d28, source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:19964b0c-3dd0-4d05-9c52-54775a99729f, source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:4cbb716e-93d4-477c-9259-cd9cb2fae1a7 |

### feafcc1c4026d7f55a2c8ce7850d7e12030b5c22 · 飞书 · 可答

How are the different components of the model trained? Is it trained end-to-end?

| reliability 原评 | 本次 reliability 配对 | 本轮 | 相对原评 | 相对配对 |
| --- | --- | --- | --- | --- |
| yes | yes | yes | retained_success | retained_success |

| 内容 | 原始记录 |
| --- | --- |
| reliability 答案 | 该模型可端到端训练，无需手工特征。 [1]<br>训练时模型目标为两个过程之和，使用“teacher-forcing”算法联合训练；训练中向每个解码器输入真实摘要并最小化目标。 [2]<br>模型采用两阶段解码器流程，生成摘要每个词时考虑两侧上下文信息。 [3]<br>训练使用Adam优化器，学习率3e-4，β1=0.9、β2=0.999、ε=10^-9，并在训练过程中使用动态学习率。 [4]<br>训练时batch size设为36，训练4个epoch（NYT50因训练样本少得多而训练8个epoch），训练后依据开发集表现从最后10个模型中选出最佳模型。 [5]<br>因GPU内存限制，使用梯度累积，累积步数设为12，每步输入3个样本。 [6]<br>正则化使用dropout和label smoothing，dropout率0.15、label smoothing值0.1，RL目标因子γ设为0.99。 [7]<br><br>依据：<br>[1] Pretraining-Based Natural Language Generation for Text Summarization · 记忆 v1 · 当前版本原文依据（第 6 行）<br>[2] Pretraining-Based Natural Language Generation for Text Summarization · 记忆 v1 · 当前版本原文依据（第 50 行）<br>[3] Pretraining-Based Natural Language Generation for Text Summarization · 记忆 v1 · 当前版本原文依据（第 7 行）<br>[4] Pretraining-Based Natural Language Generation for Text Summarization · 记忆 v1 · 当前版本原文依据（第 53 行）<br>[5] Pretraining-Based Natural Language Generation for Text Summarization · 记忆 v1 · 当前版本原文依据（第 54 行）<br>[6] Pretraining-Based Natural Language Generation for Text Summarization · 记忆 v1 · 当前版本原文依据（第 54 行）<br>[7] Pretraining-Based Natural Language Generation for Text Summarization · 记忆 v1 · 当前版本原文依据（第 53 行） |
| 本轮答案 | 模型训练时，目标函数是两个过程之和，使用“teacher-forcing”算法联合训练；训练中把真实摘要（ground-truth summary）喂给每个解码器并最小化目标。 [1][2]<br>模型采用两阶段解码器流程，生成摘要每个词时同时考虑两侧上下文信息。 [3]<br>消融实验包含三个模型变体：One-Stage（基于BERT、带copy机制的序列到序列模型）；Two-Stage（在One-Stage上加入word-refine解码器）；Two-Stage + RL（完整模型，refine过程配合RL目标）。 [4]<br>模型损失为 L_model = L̂_dec + L̂_refine（式23）。 [5]<br>训练设置：batch size为36，训练4个epoch（NYT50因训练样本少得多而用8个epoch），训练后依据开发集表现从最后10个模型中选出最佳模型。 [6]<br>优化器为Adam，学习率3e-4，β1=0.9、β2=0.999、ε=10^-9，训练中使用动态学习率。 [7]<br>正则化使用dropout和label smoothing，dropout率为0.15、label smoothing值为0.1，RL目标因子γ设为0.99。 [8]<br>是，论文明确称该模型可以端到端训练，无需手工特征。 [9][10]<br><br>依据：<br>[1] Pretraining-Based Natural Language Generation for Text Summarization · 记忆 v1 · 当前版本原文依据（第 50 行）<br>[2] Pretraining-Based Natural Language Generation for Text Summarization · 导入原文（非正式记忆）（第 50 行）（第 50 行）<br>[3] Pretraining-Based Natural Language Generation for Text Summarization · 记忆 v1 · 当前版本原文依据（第 7 行）<br>[4] Pretraining-Based Natural Language Generation for Text Summarization · 导入原文（非正式记忆）（第 61 行）（第 61 行）<br>[5] Pretraining-Based Natural Language Generation for Text Summarization · 记忆 v1 · 当前版本原文依据（第 51 行）<br>[6] Pretraining-Based Natural Language Generation for Text Summarization · 记忆 v1 · 当前版本原文依据（第 54 行）<br>[7] Pretraining-Based Natural Language Generation for Text Summarization · 记忆 v1 · 当前版本原文依据（第 53 行）<br>[8] Pretraining-Based Natural Language Generation for Text Summarization · 记忆 v1 · 当前版本原文依据（第 53 行）<br>[9] Pretraining-Based Natural Language Generation for Text Summarization · 记忆 v1 · 当前版本原文依据（第 6 行）<br>[10] Pretraining-Based Natural Language Generation for Text Summarization · 导入原文（非正式记忆）（第 6 行）（第 6 行） |
| reliability 原评理由 | Covers end-to-end training and joint teacher-forcing training with summed objective, matching the gold answers. |
| reliability 本次配对理由 | States end-to-end training and joint teacher-forcing training with summed objective, matching the gold answer. |
| 本轮理由 | States joint teacher-forcing training of summed objective and explicitly confirms end-to-end training, matching the gold answer. |
| 旧 / 本轮参考充分性 | yes / yes |
| 本轮参考理由 | Same content present: joint teacher-forcing training of both processes plus explicit 'model can be trained end-to-end' statement, sufficient for both sub-questions. |
| 最终生产原文参考 ID | source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:5ced2a89-cc66-43ad-a164-9741ed1c6d28, source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:69e754d8-fa92-4c16-814c-464311c3ab64, source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:4cbb716e-93d4-477c-9259-cd9cb2fae1a7, source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:19964b0c-3dd0-4d05-9c52-54775a99729f, source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:f27858f2-0ec4-4488-bb8c-67562f1145b8, source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:09dc8eda-ae4a-4665-8cb6-d08c77cb047a, source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:69580ab6-28a4-4bab-ac02-621f830d0550, source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:dc5013e2-0661-42db-96b3-cfe46ce005f1 |
| 最终原文引用 ID | source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:19964b0c-3dd0-4d05-9c52-54775a99729f, source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:4cbb716e-93d4-477c-9259-cd9cb2fae1a7, source:3bf48129-2ab8-4bef-91c8-d4f6b1cf999e:5ced2a89-cc66-43ad-a164-9741ed1c6d28 |

### dd76130ec5fac477123fe8880472d03fbafddef6 · 桌面 · 可答

What is the state of the art described in the paper?

| reliability 原评 | 本次 reliability 配对 | 本轮 | 相对原评 | 相对配对 |
| --- | --- | --- | --- | --- |
| partial | partial | partial | still_unsuccessful | still_unsuccessful |

| 内容 | 原始记录 |
| --- | --- |
| reliability 答案 | The paper reviews the state of the art on conversational systems from three perspectives: types of interactions, types of architecture, and types of context reasoning, and consolidates them in a comparison table. [1]<br>For context reasoning, most proposed approaches in the state of the art rely on rules using logics and knowledge bases (the rule-oriented architecture). [2]<br>Three main types of architectures are identified for building conversational systems: totally rule-oriented, totally data-oriented, and a mix of rules and data-oriented. [3]<br>Most existing chatbots, from ELIZA to modern state-of-the-art ones, fall into the dyadic category. [4]<br>A dyadic chatbot does not know how to coordinate with many members in a chat group and lacks the social ability to know when it is more suitable to answer or not. [5]<br>The paper states there is a lack of methods and tools to design and engineer coordination and mediation among chatbots and humans. [6]<br>With regard to chatbot engines, there is a lack of research directed to building coordination laws integrated with natural language. [7]<br>The paper states its proposed architecture is, to the best of the authors' knowledge, the first in the state of the art designed to support coordinated aware chatbots in a multiparty conversation. [8]<br>The paper states it is not meant to advance the state of the art on the norms for MPCS. [9]<br>尚待确认：The record does not provide the full list of specific systems or approaches reviewed in the state-of-the-art section beyond the named examples (ELIZA, PARRY, A.L.I.C.E., Cleverbot).；What is the state of the art described in the paper? |
| 本轮答案 | 论文将对话系统的研究现状按三个视角讨论：交互类型、架构类型和上下文推理类型，并用一张表汇总比较。 [1][2]<br>在上下文推理方面，现有大多数方法依赖使用逻辑和知识库的规则（规则导向架构）。 [3][4]<br>对于能参与多方对话的聊天机器人，当前研究现状是聊天机器人创建研究与多智能体系统协调/治理研究的结合。 [5][6]<br>论文指出，在聊天机器人引擎方面缺乏将协调规则与自然语言结合的研究，且现有聊天机器人引擎不能妥善处理多用户、多机器人的群聊。 [7][8][9]<br>论文称，据其所知，本文提出的架构是现有技术中首个旨在支持多方对话中协调感知聊天机器人设计与开发的架构。 [10][8]<br>论文明确表示，本文并不打算推进多方对话系统（MPCS）规范方面的研究现状，其目标也不是提升对话系统规范说明的研究现状。 [11][9][12][13]<br>论文回顾的早期系统包括 ELIZA（1966年，MIT，模拟心理治疗师）和 PARRY（20世纪70年代初，Kenneth Colby 在斯坦福大学开发）。 [14][15]<br>论文还提到 A.L.I.C.E.（1995年出现，当前版本使用 AIML）和 Cleverbot（1997-2014年，由 Rollo Carpenter 开发）。 [16][17]<br>论文提到近期开发此类系统的最新技术采用了 RNN、动态上下文敏感生成和记忆网络等。 [18]<br>尚待确认：论文对交互类型和架构类型两个视角的具体分类内容未在提供的记录中展开。；论文汇总比较表的具体内容未在提供的记录中给出。；交互类型与架构类型两个视角下的具体分类内容未展开；汇总比较表的具体内容未给出；What is the state of the art described in the paper? |
| reliability 原评理由 | Describes the three perspectives and architectures but omits the named systems ELIZA, PARRY, A.L.I.C.E., Cleverbot that the human answer lists. |
| reliability 本次配对理由 | Mentions the three perspectives and named systems ELIZA/PARRY/A.L.I.C.E./Cleverbot, but omits key details like PARRY passing the Turing test and Cleverbot's 2011 result, and adds much unrelated material. |
| 本轮理由 | Includes the three perspectives and the four named systems, but omits PARRY's Turing test result and Cleverbot's 2011 Turing test outcome. |
| 旧 / 本轮参考充分性 | yes / yes |
| 本轮参考理由 | References include the section intro and descriptions of ELIZA, PARRY, A.L.I.C.E., and Cleverbot, matching the gold answer's named systems. |
| 最终生产原文参考 ID | source:842c4bc3-23cf-45fb-8e11-a789a82589bf:e91b2c81-c674-432a-8b12-b1587005a07e, source:842c4bc3-23cf-45fb-8e11-a789a82589bf:a6e078c6-d708-4a2b-93a4-44068cee503f, source:842c4bc3-23cf-45fb-8e11-a789a82589bf:9e518c71-efcd-4ae0-a7e1-bb9c64497e2d, source:842c4bc3-23cf-45fb-8e11-a789a82589bf:74227b49-2b5a-4764-a226-977fd031bdeb, source:842c4bc3-23cf-45fb-8e11-a789a82589bf:329e8283-6f3a-4b9c-abee-b574921313da, source:842c4bc3-23cf-45fb-8e11-a789a82589bf:b92a8e80-37d6-4215-83a3-3d3d3a0010c1, source:842c4bc3-23cf-45fb-8e11-a789a82589bf:4c576208-05bf-4f58-adaa-7cdc47256eb6, source:842c4bc3-23cf-45fb-8e11-a789a82589bf:443c4a14-9001-40fc-964b-99a3b2545d85 |
| 最终原文引用 ID | source:842c4bc3-23cf-45fb-8e11-a789a82589bf:b92a8e80-37d6-4215-83a3-3d3d3a0010c1, source:842c4bc3-23cf-45fb-8e11-a789a82589bf:74227b49-2b5a-4764-a226-977fd031bdeb, source:842c4bc3-23cf-45fb-8e11-a789a82589bf:443c4a14-9001-40fc-964b-99a3b2545d85, source:842c4bc3-23cf-45fb-8e11-a789a82589bf:e91b2c81-c674-432a-8b12-b1587005a07e, source:842c4bc3-23cf-45fb-8e11-a789a82589bf:a6e078c6-d708-4a2b-93a4-44068cee503f, source:842c4bc3-23cf-45fb-8e11-a789a82589bf:9e518c71-efcd-4ae0-a7e1-bb9c64497e2d |

### dd76130ec5fac477123fe8880472d03fbafddef6 · 飞书 · 可答

What is the state of the art described in the paper?

| reliability 原评 | 本次 reliability 配对 | 本轮 | 相对原评 | 相对配对 |
| --- | --- | --- | --- | --- |
| yes | partial | partial | regression | still_unsuccessful |

| 内容 | 原始记录 |
| --- | --- |
| reliability 答案 | 论文综述对话系统的最新技术时，从三个视角展开：交互类型、架构类型和上下文推理类型，并用一张表汇总比较。 [1]<br>ELIZA 是早期理解自然语言处理的软件之一，由 Joseph Weizenbaum 于 1966 年在 MIT 创建，以扮演心理治疗师著称，只需反射病人的陈述。 [2]<br>ELIZA 旨在解决五个“基本技术问题”：识别关键词、发现最小上下文、选择适当变换、生成适当回应（有或无关键词时），以及为 ELIZA 脚本提供结束能力。 [3]<br>PARRY 紧随 ELIZA 之后，由斯坦福大学的精神病学家 Kenneth Colby 在 1970 年代初开发。 [4]<br>该程序用 MLISP 语言在 DEC PDP-10 的 WAITS 操作系统上编写，代码不可移植，部分用 PDP-10 汇编代码、部分用 MLISP 编写。 [5]<br>A.L.I.C.E. 于 1995 年出现，当前版本使用 AIML——一种为创建刺激-反应聊天机器人而设计的 XML 语言。 [6]<br>该程序无法通过图灵测试，因为即使是普通用户也常能在简短对话中暴露其机械性。 [7]<br>Cleverbot（1997-2014）是由英国 AI 科学家 Rollo Carpenter 开发的聊天机器人。 [8]<br>它通过了 2011 年图灵测试，该测试在印度理工学院古瓦哈提分校举办的 Technique Techno-Management Festival 上举行。 [9]<br>在最新技术中，大多数上下文推理方法依赖使用逻辑和知识库的规则，如规则导向架构小节所述。 [10]<br>构建对话系统主要有三类架构：完全规则导向、完全数据导向，以及规则与数据导向的混合。 [11]<br>大多数现有聊天机器人，从最早的 ELIZA 到现代最先进的系统，都属于这一类。 [12]<br>尚待确认：论文对最新技术的综述中，除 ELIZA、PARRY、A.L.I.C.E.、Cleverbot 及三类架构外，其他具体系统或方法的名称与角色未在已确认记忆中记录。；论文综述中除 ELIZA、PARRY、A.L.I.C.E.、Cleverbot 及三类架构外，其他具体系统或方法的名称与角色未记录。；What is the state of the art described in the paper?<br><br>依据：<br>[1] A Hybrid Architecture for Multi-Party Conversational Systems · 记忆 v1 · 当前版本原文依据（第 16 行）<br>[2] A Hybrid Architecture for Multi-Party Conversational Systems · 记忆 v1 · 当前版本原文依据（第 17 行）<br>[3] A Hybrid Architecture for Multi-Party Conversational Systems · 记忆 v1 · 当前版本原文依据（第 17 行）<br>[4] A Hybrid Architecture for Multi-Party Conversational Systems · 记忆 v1 · 当前版本原文依据（第 18 行）<br>[5] A Hybrid Architecture for Multi-Party Conversational Systems · 记忆 v1 · 当前版本原文依据（第 18 行）<br>[6] A Hybrid Architecture for Multi-Party Conversational Systems · 记忆 v1 · 当前版本原文依据（第 19 行）<br>[7] A Hybrid Architecture for Multi-Party Conversational Systems · 记忆 v1 · 当前版本原文依据（第 19 行）<br>[8] A Hybrid Architecture for Multi-Party Conversational Systems · 记忆 v1 · 当前版本原文依据（第 20 行）<br>[9] A Hybrid Architecture for Multi-Party Conversational Systems · 记忆 v1 · 当前版本原文依据（第 20 行）<br>[10] A Hybrid Architecture for Multi-Party Conversational Systems · 记忆 v1 · 当前版本原文依据（第 78 行）<br>[11] A Hybrid Architecture for Multi-Party Conversational Systems · 记忆 v1 · 当前版本原文依据（第 42 行）<br>[12] A Hybrid Architecture for Multi-Party Conversational Systems · 记忆 v1 · 当前版本原文依据（第 24 行） |
| 本轮答案 | 论文从三个视角讨论对话系统的研究现状：交互类型、架构类型和上下文推理类型，并用一张表汇总比较。 [1][2]<br>在上下文推理方面，现有大多数方法依赖使用逻辑和知识库的规则（规则导向架构）。 [3][4]<br>早期代表性系统包括ELIZA（1966年由Joseph Weizenbaum在MIT创建，扮演心理治疗师），以及随后由斯坦福大学精神病学家Kenneth Colby在1970年代初开发的PARRY。 [5][6]<br>A.L.I.C.E.出现于1995年，当前版本使用为创建刺激-响应聊天机器人而设计的XML语言AIML。 [7]<br>Cleverbot（1997-2014）由英国AI科学家Rollo Carpenter开发。 [8]<br>创建能参与多方对话的聊天机器人的现状，是聊天机器人创建研究与多智能体系统协调/治理研究的结合；但缺乏创建多方感知或受治理聊天机器人的解决方案。 [9][10]<br>在聊天机器人引擎方面，缺乏将协调规则与自然语言结合的研究。 [11][12]<br>近期开发此类系统的最先进工作采用了循环神经网络（RNN）、动态上下文敏感生成和记忆网络等。 [13]<br>Sukhbaatar的工作综述了利用RNN或基于LSTM的模型将对话上下文作为序列中长期结构来捕获的近期努力。 [14]<br>论文声明其提出的架构（据作者所知）是首个旨在支持多方对话中协调感知聊天机器人设计与开发的架构。 [15][12]<br><br>依据：<br>[1] A Hybrid Architecture for Multi-Party Conversational Systems · 记忆 v1 · 当前版本原文依据（第 16 行）<br>[2] A Hybrid Architecture for Multi-Party Conversational Systems · 导入原文（非正式记忆）（第 16 行）（第 16 行）<br>[3] A Hybrid Architecture for Multi-Party Conversational Systems · 记忆 v1 · 当前版本原文依据（第 78 行）<br>[4] A Hybrid Architecture for Multi-Party Conversational Systems · 导入原文（非正式记忆）（第 78 行）（第 78 行）<br>[5] A Hybrid Architecture for Multi-Party Conversational Systems · 记忆 v1 · 当前版本原文依据（第 17 行）<br>[6] A Hybrid Architecture for Multi-Party Conversational Systems · 记忆 v1 · 当前版本原文依据（第 18 行）<br>[7] A Hybrid Architecture for Multi-Party Conversational Systems · 记忆 v1 · 当前版本原文依据（第 19 行）<br>[8] A Hybrid Architecture for Multi-Party Conversational Systems · 记忆 v1 · 当前版本原文依据（第 20 行）<br>[9] A Hybrid Architecture for Multi-Party Conversational Systems · 记忆 v1 · 当前版本原文依据（第 28 行）<br>[10] A Hybrid Architecture for Multi-Party Conversational Systems · 导入原文（非正式记忆）（第 28 行）（第 28 行）<br>[11] A Hybrid Architecture for Multi-Party Conversational Systems · 记忆 v1 · 当前版本原文依据（第 41 行）<br>[12] A Hybrid Architecture for Multi-Party Conversational Systems · 导入原文（非正式记忆）（第 41 行）（第 41 行）<br>[13] A Hybrid Architecture for Multi-Party Conversational Systems · 记忆 v1 · 当前版本原文依据（第 70 行）<br>[14] A Hybrid Architecture for Multi-Party Conversational Systems · 记忆 v1 · 当前版本原文依据（第 100 行）<br>[15] A Hybrid Architecture for Multi-Party Conversational Systems · 记忆 v1 · 当前版本原文依据（第 41 行） |
| reliability 原评理由 | Includes ELIZA, PARRY, A.L.I.C.E., and Cleverbot, matching the human answer's systems. |
| reliability 本次配对理由 | Covers the three perspectives and describes ELIZA, PARRY, A.L.I.C.E., and Cleverbot, but omits notable facts such as PARRY passing the Turing test and Cleverbot's 59.3% result. |
| 本轮理由 | Covers the three perspectives and the four systems, but omits PARRY's Turing test success and Cleverbot's 2011 Turing test result. |
| 旧 / 本轮参考充分性 | yes / yes |
| 本轮参考理由 | Same content as desktop: intro plus ELIZA, PARRY, A.L.I.C.E., and Cleverbot descriptions cover the gold answer. |
| 最终生产原文参考 ID | source:842c4bc3-23cf-45fb-8e11-a789a82589bf:e91b2c81-c674-432a-8b12-b1587005a07e, source:842c4bc3-23cf-45fb-8e11-a789a82589bf:a6e078c6-d708-4a2b-93a4-44068cee503f, source:842c4bc3-23cf-45fb-8e11-a789a82589bf:9e518c71-efcd-4ae0-a7e1-bb9c64497e2d, source:842c4bc3-23cf-45fb-8e11-a789a82589bf:74227b49-2b5a-4764-a226-977fd031bdeb, source:842c4bc3-23cf-45fb-8e11-a789a82589bf:329e8283-6f3a-4b9c-abee-b574921313da, source:842c4bc3-23cf-45fb-8e11-a789a82589bf:b92a8e80-37d6-4215-83a3-3d3d3a0010c1, source:842c4bc3-23cf-45fb-8e11-a789a82589bf:4c576208-05bf-4f58-adaa-7cdc47256eb6, source:842c4bc3-23cf-45fb-8e11-a789a82589bf:443c4a14-9001-40fc-964b-99a3b2545d85 |
| 最终原文引用 ID | source:842c4bc3-23cf-45fb-8e11-a789a82589bf:b92a8e80-37d6-4215-83a3-3d3d3a0010c1, source:842c4bc3-23cf-45fb-8e11-a789a82589bf:74227b49-2b5a-4764-a226-977fd031bdeb, source:842c4bc3-23cf-45fb-8e11-a789a82589bf:443c4a14-9001-40fc-964b-99a3b2545d85, source:842c4bc3-23cf-45fb-8e11-a789a82589bf:e91b2c81-c674-432a-8b12-b1587005a07e |

## 审计

当前报告：docs\memory-public-live-qa-architecture-dev-results.json；直接比较基线：docs\memory-public-live-qa-reliability-dev-results.json；v3 历史参考：docs\memory-public-live-qa-structured-dev-v3-results.json。
完整性：docs\memory-public-live-qa-architecture-dev-integrity.json，通过=true；报告 SHA 与完整性记录绑定。
当前 binary：3d6c3f6385b05c0024299eee9ade9696efe88b370d9e573b7fd587bcb9e11231；注册、源码、评测快照、逐题原文计数与完整成本字段见同名 metrics。
