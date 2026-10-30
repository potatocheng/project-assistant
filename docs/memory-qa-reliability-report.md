# 记忆系统可靠性：一次20题真实链路比较

本轮 qa-reliability-dev：20题，其中19题可答、1题无答案。完整执行：true。100题未执行。

本报告保留历史原始评分与本次匿名配对旧答案评分。两轮重新提取和模型输出可能不同，不能把变化全部归因于代码；本次没有新增盲测或人工复核。记忆与检索评分为各次原始自动评分，不声称同次配对净增。

当前 binary：3c620bd26ce1b1fb1c9c887ad722c4b9f733024a53def6a13bbe6b881da04082；baseline binary：ecdbe7ea8c72eb0c2083c6c615fc50fb29c6daecf9f2732c80b81cba1d777173。执行源码、评测源码和测试证据见机器 metrics，均来自各次运行记录。

## 答案质量

| 入口 | 指标 | 历史原评 | 本次旧答案匿名配对 | 本轮 |
| --- | --- | --- | --- | --- |
| 桌面 | 可答题完整正确 | 16/19 | 16/19 | 12/19 |
| 桌面 | 无答案题正确拒答 | 1/1 | 1/1 | 1/1 |
| 桌面 | 匿名配对已评分 | — | 20/20 | — |
| 桌面 | 检索参考充分 yes | 17/19 | 未重评旧参考包 | 16/19 |
| 飞书 | 可答题完整正确 | 16/19 | 16/19 | 15/19 |
| 飞书 | 无答案题正确拒答 | 1/1 | 1/1 | 1/1 |
| 飞书 | 匿名配对已评分 | — | 20/20 | — |
| 飞书 | 检索参考充分 yes | 17/19 | 未重评旧参考包 | 16/19 |

缺失的匿名配对评分不以旧原评分冒充；所有可答题保留在分母。partial 与完整正确分开。

## 记忆留存

| 轮次 | yes | partial | no | uncertain | 缺失 | 严格 yes | yes + partial |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 历史原评 | 17 | 0 | 2 | 0 | 0 | 17/19 | 17/19 |
| 本轮 | 17 | 1 | 1 | 0 | 0 | 17/19 | 18/19 |

记忆按可答问题计数一次，两个入口不重复计数；yes + partial 不标为完整保留。

## 请求与 token 使用量

统计包含成功、失败和重试请求。缺失usage不估算为零；下表token数是已记录字段之和，带“已知”表示仍有缺失。cache是input的子集，不重复加入总量。

| 阶段 | 轮次 | 请求 | 失败请求 | total | input | output | cache input | usage不完整 | 字段缺失(total/input/output/cache) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| all | 历史 | 252 | 0 | 1181244 | 1007760 | 173484 | 202368 | 0 | 0/0/0/0 |
| all | 本轮 | 255 | 0 | 1197431 | 1025007 | 172424 | 191616 | 0 | 0/0/0/0 |
| extraction | 历史 | 100 | 0 | 436994 | 287134 | 149860 | 102400 | 0 | 0/0/0/0 |
| extraction | 本轮 | 100 | 0 | 435450 | 287044 | 148406 | 102400 | 0 | 0/0/0/0 |
| qa | 历史 | 92 | 0 | 299354 | 282927 | 16427 | 64256 | 0 | 0/0/0/0 |
| qa | 本轮 | 95 | 0 | 312132 | 295585 | 16547 | 68736 | 0 | 0/0/0/0 |
| judge | 历史 | 60 | 0 | 444896 | 437699 | 7197 | 35712 | 0 | 0/0/0/0 |
| judge | 本轮 | 60 | 0 | 449849 | 442378 | 7471 | 20480 | 0 | 0/0/0/0 |

## 链路与协议

| 指标 | 历史 | 本轮 |
| --- | --- | --- |
| 提取状态 | {"succeeded":6} | {"succeeded":6} |
| 正式记忆条数 | 944 | 929 |
| QA只读 | true | true |
| 桌面答案协议错误 | {} | {} |
| 桌面审查协议错误 | {} | {} |
| 飞书答案协议错误 | {} | {} |
| 飞书审查协议错误 | {} | {} |
| 最终judge错误 | 0 | 0 |
| 失败judge请求（含后来成功的重试） | 0 | 0 |

## 逐题变化与原始理由

以下答案理由只取各报告 stages.answer.systems，按各自 anonymousOrder 映射；不使用被检索阶段覆盖的 entries.reason。未记录的理由明确保留为空缺。旧原评与旧配对针对同一条历史答案；原始标签不被重新覆盖。

### 55bd59076a49b19d3283af41c5e3ccb875f3eb0c · 桌面 · 可答

What is the best performing model?

| 历史原评 | 本次旧配对 | 本轮 | 相对原评变化 | 相对配对变化 |
| --- | --- | --- | --- | --- |
| yes | yes | yes | retained_success | retained_success |

| 内容 | 原始记录 |
| --- | --- |
| 历史答案 | A CNN-based sentence classifier achieved the best results in all three sub-tasks. [1]<br>The CNN outperforms the RNN model, achieving a macro-F1 score of 0.80. [2]<br>In one experiment, the CNN system achieved higher performance than the BiLSTM, with a macro-F1 score of 0.69. [3]<br>尚待确认：The records do not give a single overall best-performing model across all tasks and experiments; the best model is reported per sub-task or per experiment.；缺少跨所有子任务与实验的统一最佳模型结论；最佳模型仅按子任务或实验分别报告。；What is the best performing model? |
| 本轮答案 | A CNN-based sentence classifier achieved the best results in all three sub-tasks. [1]<br>The CNN outperformed the RNN model, achieving a macro-F1 score of 0.80. [2]<br>In a separate experiment, the CNN system achieved higher performance than the BiLSTM, with a macro-F1 score of 0.69. [3] |
| 历史答案原评理由 | Identifies CNN as best-performing model, matching the gold answer, with supporting scores. |
| 历史答案本次匿名配对理由 | States CNN achieved best results in all three sub-tasks, matching the gold answer; the added caveat does not contradict it. |
| 本轮答案理由 | Identifies CNN as best-performing model, matching the gold answer, with supporting F1 details. |
| 历史记忆标签 / 理由 | yes / Memories state the CNN outperforms RNN/BiLSTM and that a CNN-based classifier achieved the best results in all three sub-tasks, matching the human answer 'CNN'. |
| 本轮记忆标签 / 理由 | yes / Memories state the CNN outperforms RNN/BiLSTM and that a CNN-based classifier achieved the best results in all three sub-tasks, matching the human answer 'CNN'. |
| 历史检索标签 / 理由 | yes / References include 'CNN outperforms the RNN model' and 'CNN-based sentence classifier achieved the best results in all three sub-tasks,' directly supporting CNN as best model. |
| 本轮检索标签 / 理由 | yes / References include 'CNN outperforms the RNN model' and 'CNN-based sentence classifier achieved the best results in all three sub-tasks,' directly supporting CNN as best model. |

### 55bd59076a49b19d3283af41c5e3ccb875f3eb0c · 飞书 · 可答

What is the best performing model?

| 历史原评 | 本次旧配对 | 本轮 | 相对原评变化 | 相对配对变化 |
| --- | --- | --- | --- | --- |
| yes | yes | yes | retained_success | retained_success |

| 内容 | 原始记录 |
| --- | --- |
| 历史答案 | A CNN-based sentence classifier achieved the best results in all three sub-tasks. [1]<br>The CNN outperforms the RNN model, achieving a macro-F1 score of 0.80. [2]<br>In one experiment, the CNN system achieved higher performance than the BiLSTM, with a macro-F1 score of 0.69. [3]<br><br>依据：<br>[1] Predicting the Type and Target of Offensive Posts in Social Media · 记忆 v1 · 当前版本原文依据（第 31 行）<br>[2] Predicting the Type and Target of Offensive Posts in Social Media · 记忆 v1 · 当前版本原文依据（第 26 行）<br>[3] Predicting the Type and Target of Offensive Posts in Social Media · 记忆 v1 · 当前版本原文依据（第 28 行） |
| 本轮答案 | A CNN-based sentence classifier achieved the best results in all three sub-tasks. [1]<br>The CNN outperforms the RNN model, achieving a macro-F1 score of 0.80. [2]<br>The CNN system achieved higher performance than the BiLSTM in that experiment, with a macro-F1 score of 0.69. [3]<br><br>依据：<br>[1] Predicting the Type and Target of Offensive Posts in Social Media · 记忆 v1 · 当前版本原文依据（第 31 行）<br>[2] Predicting the Type and Target of Offensive Posts in Social Media · 记忆 v1 · 当前版本原文依据（第 26 行）<br>[3] Predicting the Type and Target of Offensive Posts in Social Media · 记忆 v1 · 当前版本原文依据（第 28 行） |
| 历史答案原评理由 | States CNN achieved best results in all three sub-tasks, matching the gold answer. |
| 历史答案本次匿名配对理由 | States CNN achieved best results, matching the gold answer. |
| 本轮答案理由 | States CNN achieved best results, matching the gold answer. |
| 历史记忆标签 / 理由 | yes / Memories state the CNN outperforms RNN/BiLSTM and that a CNN-based classifier achieved the best results in all three sub-tasks, matching the human answer 'CNN'. |
| 本轮记忆标签 / 理由 | yes / Memories state the CNN outperforms RNN/BiLSTM and that a CNN-based classifier achieved the best results in all three sub-tasks, matching the human answer 'CNN'. |
| 历史检索标签 / 理由 | yes / Same references present, including CNN outperforming RNN and CNN achieving best results in all sub-tasks, sufficient to answer. |
| 本轮检索标签 / 理由 | yes / Same references present, including explicit statement that CNN achieved best results in all three sub-tasks, matching gold answer CNN. |

### 5daeb8d4d6f3b8543ec6309a7a35523e160437eb · 桌面 · 可答

In what language are the tweets?

| 历史原评 | 本次旧配对 | 本轮 | 相对原评变化 | 相对配对变化 |
| --- | --- | --- | --- | --- |
| yes | yes | yes | retained_success | retained_success |

| 内容 | 原始记录 |
| --- | --- |
| 历史答案 | 本文创建的新数据集由英语推文组成。 [1] |
| 本轮答案 | 当前资源所创建的数据集为英语推文（English tweets）。 [1] |
| 历史答案原评理由 | States the new dataset consists of English tweets, matching the gold answer English. |
| 历史答案本次匿名配对理由 | States the dataset consists of English tweets, matching the gold answer. |
| 本轮答案理由 | States the tweets are English, matching the gold answer. |
| 历史记忆标签 / 理由 | yes / Memory 636e82d5 explicitly states the dataset is of English tweets, matching the human answer 'English'. |
| 本轮记忆标签 / 理由 | yes / Memory 0ced79d8 explicitly states the dataset consists of English tweets, directly answering the language question and matching the human answer 'English'. |
| 历史检索标签 / 理由 | yes / Reference states 'dataset of English tweets,' directly answering the language question. |
| 本轮检索标签 / 理由 | yes / Reference memory:0ced79d8 states the dataset is of English tweets, directly answering the language question. |

### 5daeb8d4d6f3b8543ec6309a7a35523e160437eb · 飞书 · 可答

In what language are the tweets?

| 历史原评 | 本次旧配对 | 本轮 | 相对原评变化 | 相对配对变化 |
| --- | --- | --- | --- | --- |
| yes | yes | yes | retained_success | retained_success |

| 内容 | 原始记录 |
| --- | --- |
| 历史答案 | 本项目创建的公开数据集由英语推文组成。 [1]<br><br>依据：<br>[1] Predicting the Type and Target of Offensive Posts in Social Media · 记忆 v1 · 当前版本原文依据（第 4 行） |
| 本轮答案 | 本项目创建的推文数据集为英文推文（English tweets）。 [1]<br><br>依据：<br>[1] Predicting the Type and Target of Offensive Posts in Social Media · 记忆 v1 · 当前版本原文依据（第 4 行） |
| 历史答案原评理由 | States the created public dataset consists of English tweets, matching English. |
| 历史答案本次匿名配对理由 | States the dataset consists of English tweets, matching the gold answer. |
| 本轮答案理由 | States the tweets are English, matching the gold answer. |
| 历史记忆标签 / 理由 | yes / Memory 636e82d5 explicitly states the dataset is of English tweets, matching the human answer 'English'. |
| 本轮记忆标签 / 理由 | yes / Memory 0ced79d8 explicitly states the dataset consists of English tweets, directly answering the language question and matching the human answer 'English'. |
| 历史检索标签 / 理由 | yes / Same reference states 'dataset of English tweets,' directly answering the language question. |
| 本轮检索标签 / 理由 | yes / Reference 0ced79d8 states the dataset is of English tweets, directly answering the language question. |

### 521280a87c43fcdf9f577da235e7072a23f0673e · 桌面 · 可答

How many annotators participated?

| 历史原评 | 本次旧配对 | 本轮 | 相对原评变化 | 相对配对变化 |
| --- | --- | --- | --- | --- |
| partial | partial | partial | still_unsuccessful | still_unsuccessful |

| 内容 | 原始记录 |
| --- | --- |
| 历史答案 | The dataset records state that each instance was annotated by multiple annotators, without giving an exact total. [1]<br>A separate record mentions five annotators on 21 tweets for a trial-set agreement computation. [2]<br>尚待确认：The exact total number of annotators who participated in the dataset annotation is not recorded.；数据集标注中参与标注者的确切总人数未被记录。；How many annotators participated? |
| 本轮答案 | The trial set involved five annotators on 21 of the tweets. [1]<br>Each dataset instance was annotated by multiple annotators, and inter-annotator agreement was calculated. [2]<br>Initially two annotations were acquired per instance; in case of disagreement, more annotations were requested until agreement exceeded 66%. [3]<br>尚待确认：The total number of annotators who participated in the overall dataset annotation is not recorded; only the five annotators on the trial set and the per-instance annotation procedure are documented.；整体数据集标注中参与标注者的总人数未记录，仅有试验集五名标注者及每实例标注流程。；How many annotators participated? |
| 历史答案原评理由 | Mentions five annotators but frames it as trial-set only and denies a total, rather than answering five directly. |
| 历史答案本次匿名配对理由 | Mentions five annotators only for the trial-set agreement computation and treats the total as unrecorded, not answering 'five annotators' directly. |
| 本轮答案理由 | Mentions five annotators on the trial set but frames the total as unrecorded, so the direct answer 'five annotators' is not clearly given. |
| 历史记忆标签 / 理由 | yes / Memory 8f7de76f states Fliess' score was computed for the five annotators, matching the human answer 'five annotators'; 299a16c0 also references the five annotators. |
| 本轮记忆标签 / 理由 | yes / Memories explicitly state 'five annotators' on the trial set, matching the human answer 'five annotators'. |
| 历史检索标签 / 理由 | yes / Reference states 'five annotators,' directly answering the question. |
| 本轮检索标签 / 理由 | yes / Reference states 'five annotators' on the trial set, matching the gold answer 'five annotators'. |

### 521280a87c43fcdf9f577da235e7072a23f0673e · 飞书 · 可答

How many annotators participated?

| 历史原评 | 本次旧配对 | 本轮 | 相对原评变化 | 相对配对变化 |
| --- | --- | --- | --- | --- |
| yes | yes | yes | retained_success | retained_success |

| 内容 | 原始记录 |
| --- | --- |
| 历史答案 | 在21条推文的试验集上，针对五名标注者计算了Fliess' INLINEFORM0。 [1][2]<br><br>依据：<br>[1] Predicting the Type and Target of Offensive Posts in Social Media · 记忆 v1 · 当前版本原文依据（第 23 行）<br>[2] Predicting the Type and Target of Offensive Posts in Social Media · 记忆 v1 · 当前版本原文依据（第 23 行） |
| 本轮答案 | 在21条推文的试验集上，计算了五名标注者之间的Fliess' kappa。 [1][2]<br><br>依据：<br>[1] Predicting the Type and Target of Offensive Posts in Social Media · 记忆 v1 · 当前版本原文依据（第 23 行）<br>[2] Predicting the Type and Target of Offensive Posts in Social Media · 记忆 v1 · 当前版本原文依据（第 23 行） |
| 历史答案原评理由 | States five annotators participated in the trial set, matching the gold answer 'five annotators'. |
| 历史答案本次匿名配对理由 | States five annotators on the 21-tweet trial set, matching the gold answer 'five annotators'. |
| 本轮答案理由 | States five annotators on the 21-tweet trial set, matching the gold answer 'five annotators'. |
| 历史记忆标签 / 理由 | yes / Memory 8f7de76f states Fliess' score was computed for the five annotators, matching the human answer 'five annotators'; 299a16c0 also references the five annotators. |
| 本轮记忆标签 / 理由 | yes / Memories explicitly state 'five annotators' on the trial set, matching the human answer 'five annotators'. |
| 历史检索标签 / 理由 | yes / Reference states 'five annotators,' directly answering the question. |
| 本轮检索标签 / 理由 | yes / Reference states 'five annotators' on the trial set, matching the gold answer 'five annotators'. |

### 5a8cc8f80509ea77d8213ed28c5ead501c68c725 · 桌面 · 可答

What is the definition of offensive language?

| 历史原评 | 本次旧配对 | 本轮 | 相对原评变化 | 相对配对变化 |
| --- | --- | --- | --- | --- |
| yes | yes | yes | retained_success | retained_success |

| 内容 | 原始记录 |
| --- | --- |
| 历史答案 | Offensive (OFF) is defined as a post labeled offensive if it contains any form of non-acceptable language (profanity) or a targeted offense, which can be veiled or direct; this category includes insults, threats, and posts containing profane language or swear words. [1] |
| 本轮答案 | In the OLID annotation, a post is labeled offensive (OFF) if it contains any form of non-acceptable language (profanity) or a targeted offense, which can be veiled or direct; this category includes insults, threats, and posts containing profane language or swear words. [1]<br>By contrast, Not Offensive (NOT) covers posts that do not contain offense or profanity. [2]<br>Level A of the hierarchical annotation model discriminates between offensive (OFF) and non-offensive (NOT) tweets. [3] |
| 历史答案原评理由 | Provides the OLID offensive-post definition, semantically equivalent to the human answer. |
| 历史答案本次匿名配对理由 | Gives the OLID definition of offensive language (non-acceptable language/profanity or targeted offense, including insults, threats, swear words), matching the intended definition. |
| 本轮答案理由 | Provides the same correct OLID definition; extra contrast with NOT and Level A does not introduce error. |
| 历史记忆标签 / 理由 | yes / Memory 643198c5 explicitly defines offensive (OFF) as containing non-acceptable language (profanity) or targeted offense including insults, threats, and profanity, which matches the human evidence span discussing offensive language aspects. Supporting memories list related aspects and contexts. |
| 本轮记忆标签 / 理由 | yes / Memory c4ea03f2 provides the explicit definition of offensive language (non-acceptable language/profanity or targeted offense, including insults, threats, profanity), and memories 21c1425e and 058b9772 match the human evidence span about prior work on aspects of offensive language. |
| 历史检索标签 / 理由 | yes / Includes the explicit definition: a post is offensive if it contains non-acceptable language (profanity) or a targeted offense, including insults, threats, and profanity. |
| 本轮检索标签 / 理由 | yes / Includes the explicit definition: offensive if it contains non-acceptable language (profanity) or a targeted offense, including insults, threats, profanity. |

### 5a8cc8f80509ea77d8213ed28c5ead501c68c725 · 飞书 · 可答

What is the definition of offensive language?

| 历史原评 | 本次旧配对 | 本轮 | 相对原评变化 | 相对配对变化 |
| --- | --- | --- | --- | --- |
| yes | yes | yes | retained_success | retained_success |

| 内容 | 原始记录 |
| --- | --- |
| 历史答案 | Offensive (OFF) 的定义：帖子若包含任何形式的不可接受语言（脏话）或带有针对性的冒犯（可以是隐晦或直接的），即被标注为冒犯性；该类别包括侮辱、威胁以及含脏话或粗口的帖子。 [1]<br><br>依据：<br>[1] Predicting the Type and Target of Offensive Posts in Social Media · 记忆 v1 · 当前版本原文依据（第 15 行） |
| 本轮答案 | Offensive (OFF) 的定义：帖子若包含任何形式的不可接受语言（脏话）或针对性冒犯（可为隐晦或直接），即标记为冒犯性；该类别包括侮辱、威胁以及含脏话或粗口的帖子。 [1]<br>Not Offensive (NOT) 指不含冒犯或脏话的帖子。 [2]<br><br>依据：<br>[1] Predicting the Type and Target of Offensive Posts in Social Media · 记忆 v1 · 当前版本原文依据（第 15 行）<br>[2] Predicting the Type and Target of Offensive Posts in Social Media · 记忆 v1 · 当前版本原文依据（第 14 行） |
| 历史答案原评理由 | Chinese version states the same offensive-post definition, equivalent to the human answer. |
| 历史答案本次匿名配对理由 | Chinese translation conveys the same complete OLID definition of offensive language. |
| 本轮答案理由 | Chinese answer gives the correct offensive definition plus a correct NOT contrast. |
| 历史记忆标签 / 理由 | yes / Memory 643198c5 explicitly defines offensive (OFF) as containing non-acceptable language (profanity) or targeted offense including insults, threats, and profanity, which matches the human evidence span discussing offensive language aspects. Supporting memories list related aspects and contexts. |
| 本轮记忆标签 / 理由 | yes / Memory c4ea03f2 provides the explicit definition of offensive language (non-acceptable language/profanity or targeted offense, including insults, threats, profanity), and memories 21c1425e and 058b9772 match the human evidence span about prior work on aspects of offensive language. |
| 历史检索标签 / 理由 | yes / Same explicit OFF definition is present, directly answering the definition of offensive language. |
| 本轮检索标签 / 理由 | yes / Same definitional memory is present, supplying the needed definition of offensive language. |

### 747b847d687f703cc20a87877c5b138f26ff137d · 桌面 · 可答

Which parallel corpora are used?

| 历史原评 | 本次旧配对 | 本轮 | 相对原评变化 | 相对配对变化 |
| --- | --- | --- | --- | --- |
| yes | yes | no | regression | regression |

| 内容 | 原始记录 |
| --- | --- |
| 历史答案 | 实验使用 CoNLL 2009 语料库的英语（EN）和德语（DE）部分，以及 Europarl 语料库的 EN-DE 部分。 [1] |
| 本轮答案 | 记录提到使用未标注的 Europarl 数据来采样源语言角色。 [1]<br>尚待确认：除 Europarl 外，所使用平行语料库的完整名称与范围未明确记录。；Which parallel corpora are used? |
| 历史答案原评理由 | Names both CoNLL 2009 EN/DE sections and Europarl EN-DE, matching the gold answer. |
| 历史答案本次匿名配对理由 | Names both CoNLL 2009 EN/DE sections and Europarl EN-DE, matching the gold answer. |
| 本轮答案理由 | Only mentions unlabeled Europarl and fails to name CoNLL 2009 or the EN-DE pair. |
| 历史记忆标签 / 理由 | yes / Memory 0c29612b explicitly states experiments use the EN and DE sections of CoNLL 2009 and the EN-DE section of Europarl, matching both human answer alternatives. |
| 本轮记忆标签 / 理由 | yes / Memory 2de559bb explicitly states experiments use the English (EN) and German (DE) sections of the CoNLL 2009 corpus and the EN-DE section of the Europarl corpus, matching both human answer alternatives. |
| 历史检索标签 / 理由 | yes / Reference 0c29612b explicitly names the CoNLL 2009 EN/DE sections and the EN-DE Europarl corpus, matching the gold answer. |
| 本轮检索标签 / 理由 | no / No reference names the CoNLL 2009 or Europarl corpora as the parallel corpora used; only generic mentions of parallel corpora/Europarl data appear. |

### 747b847d687f703cc20a87877c5b138f26ff137d · 飞书 · 可答

Which parallel corpora are used?

| 历史原评 | 本次旧配对 | 本轮 | 相对原评变化 | 相对配对变化 |
| --- | --- | --- | --- | --- |
| partial | partial | no | still_unsuccessful | still_unsuccessful |

| 内容 | 原始记录 |
| --- | --- |
| 历史答案 | 实验使用的平行语料是 Europarl 语料的英语-德语（EN-DE）部分。 [1]<br><br>依据：<br>[1] A Bayesian Model of Multilingual Unsupervised Semantic Role Induction · 记忆 v1 · 当前版本原文依据（第 34 行） |
| 本轮答案 | 该模型使用平行语料库中句子之间的词对齐来利用跨语言的语义角色对应关系。 [1]<br>源语言角色是在未标注的 Europarl 数据上采样的。 [2]<br>尚待确认：除 Europarl 外，记录未明确列出所使用的平行语料库名称或具体语种对。；除 Europarl 外，未明确列出所使用的平行语料库名称或具体语种对。；Which parallel corpora are used?<br><br>依据：<br>[1] A Bayesian Model of Multilingual Unsupervised Semantic Role Induction · 记忆 v1 · 当前版本原文依据（第 15 行）<br>[2] A Bayesian Model of Multilingual Unsupervised Semantic Role Induction · 记忆 v1 · 当前版本原文依据（第 41 行） |
| 历史答案原评理由 | Mentions only Europarl EN-DE and omits the CoNLL 2009 EN/DE sections. |
| 历史答案本次匿名配对理由 | Mentions only Europarl EN-DE and omits the CoNLL 2009 EN/DE sections. |
| 本轮答案理由 | Does not identify the parallel corpora; only mentions Europarl and general alignment use. |
| 历史记忆标签 / 理由 | yes / Memory 0c29612b explicitly states experiments use the EN and DE sections of CoNLL 2009 and the EN-DE section of Europarl, matching both human answer alternatives. |
| 本轮记忆标签 / 理由 | yes / Memory 2de559bb explicitly states experiments use the English (EN) and German (DE) sections of the CoNLL 2009 corpus and the EN-DE section of the Europarl corpus, matching both human answer alternatives. |
| 历史检索标签 / 理由 | yes / Reference 0c29612b explicitly names the CoNLL 2009 EN/DE sections and the EN-DE Europarl corpus, matching the gold answer. |
| 本轮检索标签 / 理由 | no / References mention parallel corpora and Europarl generically but never identify CoNLL 2009 EN/DE or the EN-DE Europarl section as the corpora used. |

### 111afb77cfbf4c98e0458606378fa63a0e965e36 · 桌面 · 可答

Overall, does having parallel data improve semantic role induction across multiple languages?

| 历史原评 | 本次旧配对 | 本轮 | 相对原评变化 | 相对配对变化 |
| --- | --- | --- | --- | --- |
| yes | yes | yes | retained_success | retained_success |

| 内容 | 原始记录 |
| --- | --- |
| 历史答案 | No. Adding word alignments in parallel sentences yields only small, non-significant improvements, even when some labeled data is available in the source language. [1]<br>The results indicate that little information about semantic roles can be learned from this parallel data setup. [2] |
| 本轮答案 | 总体而言，加入平行句中的词对齐只带来小幅且不显著的提升，即使源语言已有部分标注数据也是如此。 [1]<br>结果表明，从该平行数据设置中能学到的语义角色信息很少。 [2]<br>作者认为，改进对齐模型是有效利用平行数据于多语言语义角色归纳的必要步骤。 [3]<br>标注少量数据带来的性能提升，很容易超过加入大规模无标注数据集以及加入平行语料库所带来的提升。 [4] |
| 历史答案原评理由 | Clearly answers no, citing small non-significant improvements and little learnable information. |
| 历史答案本次匿名配对理由 | Correctly states parallel data yields only small, non-significant improvements, matching the gold conclusion. |
| 本轮答案理由 | Correctly reports small non-significant gains and little learnable role information, consistent with gold. |
| 历史记忆标签 / 理由 | yes / Memories state that adding word alignments in parallel sentences yields only small, non-significant improvements, and explain the limited role alignment, directly answering whether parallel data improves SRI across languages. |
| 本轮记忆标签 / 理由 | yes / Memories state that adding word alignments in parallel sentences yields only small, non-significant improvements, with explanation about limited role alignment, directly answering whether parallel data improves SRI across languages. |
| 历史检索标签 / 理由 | yes / References state parallel/word alignments give small non-significant improvements and little info learned, directly answering whether parallel data improves SRI across languages. |
| 本轮检索标签 / 理由 | yes / Includes the key finding that adding word alignments in parallel sentences yields only small, non-significant improvements, plus supporting statements that little information is learned from parallel data, directly answering the question. |

### 111afb77cfbf4c98e0458606378fa63a0e965e36 · 飞书 · 可答

Overall, does having parallel data improve semantic role induction across multiple languages?

| 历史原评 | 本次旧配对 | 本轮 | 相对原评变化 | 相对配对变化 |
| --- | --- | --- | --- | --- |
| yes | yes | yes | retained_success | retained_success |

| 内容 | 原始记录 |
| --- | --- |
| 历史答案 | 总体而言，没有显著改善：在平行句中加入词对齐只带来小幅、非显著的提升，即使源语言已有部分标注数据也是如此。 [1]<br>这些结果表明，从该平行数据设置中几乎学不到关于语义角色的信息。 [2]<br><br>依据：<br>[1] A Bayesian Model of Multilingual Unsupervised Semantic Role Induction · 记忆 v1 · 当前版本原文依据（第 51 行）<br>[2] A Bayesian Model of Multilingual Unsupervised Semantic Role Induction · 记忆 v1 · 当前版本原文依据（第 40 行） |
| 本轮答案 | 总体而言，没有显著改善：在平行句中加入词对齐只带来小幅、非显著的提升，即使源语言已有部分标注数据也是如此。 [1]<br>作者指出，从这一平行数据设置中能学到的语义角色信息很少。 [2]<br>作者认为，改进对齐模型是让平行数据在多语言语义角色归纳中发挥有效作用的必要步骤，并将该探索留作未来工作。 [3][4]<br><br>依据：<br>[1] A Bayesian Model of Multilingual Unsupervised Semantic Role Induction · 记忆 v1 · 当前版本原文依据（第 51 行）<br>[2] A Bayesian Model of Multilingual Unsupervised Semantic Role Induction · 记忆 v1 · 当前版本原文依据（第 40 行）<br>[3] A Bayesian Model of Multilingual Unsupervised Semantic Role Induction · 记忆 v1 · 当前版本原文依据（第 40 行）<br>[4] A Bayesian Model of Multilingual Unsupervised Semantic Role Induction · 记忆 v1 · 当前版本原文依据（第 40 行） |
| 历史答案原评理由 | Explicitly concludes no significant overall improvement with supporting evidence. |
| 历史答案本次匿名配对理由 | Same correct conclusion: no significant improvement from parallel data, with supporting evidence. |
| 本轮答案理由 | Correctly states no significant improvement and adds accurate supporting context from the paper. |
| 历史记忆标签 / 理由 | yes / Memories state that adding word alignments in parallel sentences yields only small, non-significant improvements, and explain the limited role alignment, directly answering whether parallel data improves SRI across languages. |
| 本轮记忆标签 / 理由 | yes / Memories state that adding word alignments in parallel sentences yields only small, non-significant improvements, with explanation about limited role alignment, directly answering whether parallel data improves SRI across languages. |
| 历史检索标签 / 理由 | yes / Same references include the key finding that adding word alignments in parallel sentences yields small, non-significant improvements, sufficient to answer the question. |
| 本轮检索标签 / 理由 | yes / Contains the same decisive evidence: parallel/word-alignment data gives small non-significant improvements and little role information is learned, sufficient to answer whether parallel data improves SRI. |

### 50cc6c5f2dcf5fb87b56007f6a825fa7c90b64ed · 桌面 · 可答

What does an individual model consist of?

| 历史原评 | 本次旧配对 | 本轮 | 相对原评变化 | 相对配对变化 |
| --- | --- | --- | --- | --- |
| yes | yes | no | regression | regression |

| 内容 | 原始记录 |
| --- | --- |
| 历史答案 | The base monolingual model is the Bayesian model of garg2012unsupervised. [1]<br>The crosslingual latent variables capture correlations between roles in different languages and regularize the parameter estimates of the monolingual models. [2] |
| 本轮答案 | 现有记录不足以支持完整结论或问题前提，请核对原文或补充记录。 |
| 历史答案原评理由 | States the base monolingual model is the Bayesian model of garg2012unsupervised, matching gold. |
| 历史答案本次匿名配对理由 | States the base monolingual model is the Bayesian model of garg2012unsupervised, matching the gold answer. |
| 本轮答案理由 | Refuses/claims insufficient records instead of giving the gold answer. |
| 历史记忆标签 / 理由 | yes / Memory 25cb627d states the base monolingual model is the Bayesian model of garg2012unsupervised, matching the human evidence span; memory e00c4929 notes the joint model consists of individual Bayesian models per language, supporting the 'individual model' framing. |
| 本轮记忆标签 / 理由 | yes / Memory 084fc750 states the base monolingual model is the Bayesian model of garg2012unsupervised, matching the human evidence span; 0ed34457 describes the model consisting of individual Bayesian models per language. |
| 历史检索标签 / 理由 | yes / Reference 25cb627d states the base monolingual model is the Bayesian model of garg2012unsupervised, matching the gold answer about what an individual model consists of. |
| 本轮检索标签 / 理由 | yes / Reference 084fc750 states the base monolingual model is the Bayesian model of garg2012unsupervised, matching the gold evidence that an individual model consists of this base monolingual model. |

### 50cc6c5f2dcf5fb87b56007f6a825fa7c90b64ed · 飞书 · 可答

What does an individual model consist of?

| 历史原评 | 本次旧配对 | 本轮 | 相对原评变化 | 相对配对变化 |
| --- | --- | --- | --- | --- |
| yes | yes | yes | retained_success | retained_success |

| 内容 | 原始记录 |
| --- | --- |
| 历史答案 | 每个语言的独立模型以 garg2012unsupervised 的贝叶斯模型作为基础单语模型。 [1]<br><br>依据：<br>[1] A Bayesian Model of Multilingual Unsupervised Semantic Role Induction · 记忆 v1 · 当前版本原文依据（第 11 行） |
| 本轮答案 | 每个语言的个体模型以 garg2012unsupervised 的贝叶斯模型作为基础单语模型。 [1]<br>尚待确认：What does an individual model consist of?<br><br>依据：<br>[1] A Bayesian Model of Multilingual Unsupervised Semantic Role Induction · 记忆 v1 · 当前版本原文依据（第 11 行） |
| 历史答案原评理由 | Correctly identifies the garg2012unsupervised Bayesian model as the base monolingual model, matching gold. |
| 历史答案本次匿名配对理由 | States each language's model uses the garg2012unsupervised Bayesian model as base monolingual model, matching gold. |
| 本轮答案理由 | Gives the correct base monolingual model answer despite an extra unknown note. |
| 历史记忆标签 / 理由 | yes / Memory 25cb627d states the base monolingual model is the Bayesian model of garg2012unsupervised, matching the human evidence span; memory e00c4929 notes the joint model consists of individual Bayesian models per language, supporting the 'individual model' framing. |
| 本轮记忆标签 / 理由 | yes / Memory 084fc750 states the base monolingual model is the Bayesian model of garg2012unsupervised, matching the human evidence span; 0ed34457 describes the model consisting of individual Bayesian models per language. |
| 历史检索标签 / 理由 | yes / Reference 25cb627d identifies the Bayesian model of garg2012unsupervised as the base monolingual model, matching the gold evidence. |
| 本轮检索标签 / 理由 | yes / Reference 084fc750 contains the gold sentence identifying the base monolingual model as garg2012unsupervised's Bayesian model, sufficient to answer what an individual model consists of. |

### 6bf5620f295b5243230bc97b340fae6e92304595 · 桌面 · 可答

What baseline model is used?

| 历史原评 | 本次旧配对 | 本轮 | 相对原评变化 | 相对配对变化 |
| --- | --- | --- | --- | --- |
| yes | yes | yes | retained_success | retained_success |

| 内容 | 原始记录 |
| --- | --- |
| 历史答案 | The baseline used is the same baseline as in lang2011unsupervised, which assigns a semantic role to a constituent based on its syntactic function (the dependency relation to its head). [1] |
| 本轮答案 | The baseline used is the same baseline as in lang2011unsupervised, which assigns a semantic role to a constituent based on its syntactic function (the dependency relation to its head). [1] |
| 历史答案原评理由 | Correctly identifies the lang2011unsupervised baseline and its syntactic-function assignment. |
| 历史答案本次匿名配对理由 | Correctly identifies the lang2011unsupervised baseline and its syntactic-function assignment. |
| 本轮答案理由 | Correctly identifies the lang2011unsupervised baseline and its syntactic-function assignment. |
| 历史记忆标签 / 理由 | yes / Memory d81db557 states the baseline is the same as used by lang2011unsupervised, matching the human answer and evidence. |
| 本轮记忆标签 / 理由 | yes / Memory 2828defa states the baseline is the same as used by lang2011unsupervised, matching the human answer and evidence. |
| 历史检索标签 / 理由 | yes / Reference d81db557 states the baseline is the same as lang2011unsupervised and describes it, matching the gold answer. |
| 本轮检索标签 / 理由 | yes / Reference 2828defa states the baseline is the same as lang2011unsupervised, matching the gold answer. |

### 6bf5620f295b5243230bc97b340fae6e92304595 · 飞书 · 可答

What baseline model is used?

| 历史原评 | 本次旧配对 | 本轮 | 相对原评变化 | 相对配对变化 |
| --- | --- | --- | --- | --- |
| yes | yes | yes | retained_success | retained_success |

| 内容 | 原始记录 |
| --- | --- |
| 历史答案 | 所用基线模型与 lang2011unsupervised 使用的基线相同；该基线根据成分的句法功能（即与其中心词的依存关系）为其指派语义角色。 [1]<br>此外，本文还构建了一个“supervised baseline”：对在监督句中出现的谓词，使用预定义映射计算参数的 MAP 估计；对未见的谓词，则使用标准基线。 [2]<br><br>依据：<br>[1] A Bayesian Model of Multilingual Unsupervised Semantic Role Induction · 记忆 v1 · 当前版本原文依据（第 31 行）<br>[2] A Bayesian Model of Multilingual Unsupervised Semantic Role Induction · 记忆 v1 · 当前版本原文依据（第 43 行） |
| 本轮答案 | 所用基线是 lang2011unsupervised 使用的同一基线；该基线根据成分的句法功能（即与其中心词的依存关系）为其指派语义角色。 [1]<br><br>依据：<br>[1] A Bayesian Model of Multilingual Unsupervised Semantic Role Induction · 记忆 v1 · 当前版本原文依据（第 31 行） |
| 历史答案原评理由 | Correctly states the lang2011unsupervised baseline; extra supervised-baseline detail is accurate and not contradictory. |
| 历史答案本次匿名配对理由 | Correct baseline plus accurate extra detail about the supervised baseline; still answers the question correctly. |
| 本轮答案理由 | Same correct content in Chinese, matching the gold baseline description. |
| 历史记忆标签 / 理由 | yes / Memory d81db557 states the baseline is the same as used by lang2011unsupervised, matching the human answer and evidence. |
| 本轮记忆标签 / 理由 | yes / Memory 2828defa states the baseline is the same as used by lang2011unsupervised, matching the human answer and evidence. |
| 历史检索标签 / 理由 | yes / Reference d81db557 gives the baseline (same as lang2011unsupervised) and its description, sufficient to answer. |
| 本轮检索标签 / 理由 | yes / Reference 2828defa explicitly identifies the baseline as the one used by lang2011unsupervised, matching gold. |

### 1be54c5b3ea67d837ffba2290a40c1e720d9587f · 桌面 · 可答

Is the position in the sequence part of the input?

| 历史原评 | 本次旧配对 | 本轮 | 相对原评变化 | 相对配对变化 |
| --- | --- | --- | --- | --- |
| yes | yes | no | regression | regression |

| 内容 | 原始记录 |
| --- | --- |
| 历史答案 | 是。模型为序列中每个位置使用独立的解码器，每个解码器对应序列中的一张图像，从而针对序列的每个位置学习特定的语言模型。 [1][2]<br>每个解码器的首个输入是对应图像的嵌入，而非位置本身；位置通过为每个位置分配独立解码器来体现。 [2][3] |
| 本轮答案 | No. The recorded input to each decoder is the corresponding image embedding e(I_i), not the position in the sequence; the position determines which decoder handles which image. [1][2][3] |
| 历史答案原评理由 | Explicitly answers yes and explains position is represented via independent per-position decoders, matching the human yes answer. |
| 历史答案本次匿名配对理由 | Correctly answers yes: each sequence position has its own decoder, and position is reflected via per-position decoders rather than explicit input. |
| 本轮答案理由 | Answers 'No' to a yes/no question whose human answer is yes; contradicts the per-position decoder design. |
| 历史记忆标签 / 理由 | yes / Memory dec65d88 states the network takes an image from the sequence as input at each timestep, and a3c99e0f/9c4e61fb describe position-specific decoders, supporting that sequence position is part of the input. |
| 本轮记忆标签 / 理由 | yes / Memory ccae1e88 states the network takes as input an image I_i where i∈{1,2,3,4,5} from the sequence, and f201d612/65e4f88a confirm the LSTM summarizes/encodes the sequence of images, supporting that the position in the sequence is part of the input. |
| 历史检索标签 / 理由 | yes / References state each decoder learns a specific language model for each position of the sequence and that decoders correspond to each image position, indicating position is part of the input. |
| 本轮检索标签 / 理由 | yes / References state each decoder corresponds to a position in the sequence and takes the corresponding image embedding as first input, indicating position is part of input. |

### 1be54c5b3ea67d837ffba2290a40c1e720d9587f · 飞书 · 可答

Is the position in the sequence part of the input?

| 历史原评 | 本次旧配对 | 本轮 | 相对原评变化 | 相对配对变化 |
| --- | --- | --- | --- | --- |
| yes | yes | partial | regression | regression |

| 内容 | 原始记录 |
| --- | --- |
| 历史答案 | 是。模型为序列中每个位置使用独立的解码器，每个解码器针对序列中对应位置学习特定的语言模型。 [1][2]<br>每个解码器的首个输入是对应图像的嵌入，而非位置编号；位置通过各解码器与图像的对应关系体现。 [3][4]<br><br>依据：<br>[1] Contextualize, Show and Tell: A Neural Visual Storyteller · 记忆 v1 · 当前版本原文依据（第 17 行）<br>[2] Contextualize, Show and Tell: A Neural Visual Storyteller · 记忆 v1 · 当前版本原文依据（第 9 行）<br>[3] Contextualize, Show and Tell: A Neural Visual Storyteller · 记忆 v1 · 当前版本原文依据（第 9 行）<br>[4] Contextualize, Show and Tell: A Neural Visual Storyteller · 记忆 v1 · 当前版本原文依据（第 10 行） |
| 本轮答案 | 记录未明确说明序列位置本身是否作为输入；已记录的是每个解码器以对应图像嵌入 e(I_i) 作为首个输入，并以编码器最后隐藏状态（上下文）初始化隐藏状态。 [1][2]<br>模型为序列中每张图像设置一个独立解码器，每个解码器针对序列中对应位置学习特定的语言模型。 [3][4]<br>尚待确认：序列位置是否作为显式输入（如位置编码或位置向量）未被记录。；Is the position in the sequence part of the input?<br><br>依据：<br>[1] Contextualize, Show and Tell: A Neural Visual Storyteller · 记忆 v1 · 当前版本原文依据（第 10 行）<br>[2] Contextualize, Show and Tell: A Neural Visual Storyteller · 记忆 v1 · 当前版本原文依据（第 9 行）<br>[3] Contextualize, Show and Tell: A Neural Visual Storyteller · 记忆 v1 · 当前版本原文依据（第 9 行）<br>[4] Contextualize, Show and Tell: A Neural Visual Storyteller · 记忆 v1 · 当前版本原文依据（第 9 行） |
| 历史答案原评理由 | Explicitly answers yes and explains position is reflected through per-position decoders, matching the human yes answer. |
| 历史答案本次匿名配对理由 | Same correct yes answer, explaining independent decoders per position and image embedding as first input. |
| 本轮答案理由 | Notes per-position decoders but hedges that position input is unrecorded, failing to give the expected yes. |
| 历史记忆标签 / 理由 | yes / Memory dec65d88 states the network takes an image from the sequence as input at each timestep, and a3c99e0f/9c4e61fb describe position-specific decoders, supporting that sequence position is part of the input. |
| 本轮记忆标签 / 理由 | yes / Memory ccae1e88 states the network takes as input an image I_i where i∈{1,2,3,4,5} from the sequence, and f201d612/65e4f88a confirm the LSTM summarizes/encodes the sequence of images, supporting that the position in the sequence is part of the input. |
| 历史检索标签 / 理由 | yes / Same references explicitly say each decoder learns a specific language model for each position of the sequence, supporting that position is part of the input. |
| 本轮检索标签 / 理由 | yes / Same references show per-position decoders using corresponding image embeddings as input, supporting that sequence position is part of the input. |

### 584af673429c7f8621c6bf83362a37048daa0e5d · 桌面 · 可答

How is the sequential nature of the story captured?

| 历史原评 | 本次旧配对 | 本轮 | 相对原评变化 | 相对配对变化 |
| --- | --- | --- | --- | --- |
| yes | yes | yes | retained_success | retained_success |

| 内容 | 原始记录 |
| --- | --- |
| 历史答案 | The encoder takes the images in order, one at every timestep t, using Inception v3 to obtain each image's representation. [1]<br>An LSTM summarizes the sequence of images; at time t=5 it has encoded the 5 images and provides the sequence's context through its last hidden state h_e^(t). [2][3]<br>The model contains five independent decoders, one for each image in the sequence; all use the encoder's last hidden state as their first hidden state and the corresponding image embedding as their first input. [4]<br>Each decoder generates a sequence of words for its image, and the final story is the concatenation of the outputs of the 5 decoders. [5]<br>The first decoder generates words for the first image, the second for the second image, and so on, allowing each decoder to learn a specific language model for each position of the sequence. [6]<br>For instance, the first decoder learns the opening sentences of the story while the last decoder learns the closing sentences. [7] |
| 本轮答案 | The encoder processes the images in order, taking one image at every timestep t; at t=5 the context vector is obtained through h_e^(t). [1]<br>The model's first component is an LSTM that summarizes the sequence of images; at t=5 it has encoded the 5 images and provides the sequence's context via its last hidden state h_e^(t). [2][3]<br>The model contains five independent decoders, one for each image in the sequence, and each decoder generates a sequence of words for its image; the final story is the concatenation of the five decoders' outputs. [4][5]<br>The first decoder generates words for the first image, the second decoder for the second image, and so on, allowing each decoder to learn a specific language model for each position of the sequence. [6][7]<br>All five decoders use the encoder's last hidden state as their first hidden state and take the corresponding image embedding as their first input. [8] |
| 历史答案原评理由 | Explains sequential capture via encoder processing images in order per timestep and LSTM context, plus per-position decoders and concatenation. |
| 历史答案本次匿名配对理由 | Includes ordered encoder timesteps, LSTM context at t=5, five decoders per image, concatenation, and per-position language models—matches gold. |
| 本轮答案理由 | Explains encoder processes images in order per timestep, context vector at t=5, five decoders each generating words per image, concatenated story—matches gold. |
| 历史记忆标签 / 理由 | yes / Memories capture the sequential encoding (images in order per timestep, context vector at t=5) and decoder use of global sequence context plus local image content, matching both human evidence alternatives. |
| 本轮记忆标签 / 理由 | yes / Memories capture the encoder taking images in order per timestep, context vector from last hidden state initializing each decoder, and each decoder generating words per image, matching both evidence alternatives. |
| 历史检索标签 / 理由 | yes / References include the encoder taking images in order at each timestep, the context vector initializing each decoder, per-image word sequences, and concatenation into the final story, matching both gold spans. |
| 本轮检索标签 / 理由 | yes / References include encoder processing images in order per timestep, context vector at t=5, and each decoder generating words per image, matching gold explanation of sequential capture. |

### 584af673429c7f8621c6bf83362a37048daa0e5d · 飞书 · 可答

How is the sequential nature of the story captured?

| 历史原评 | 本次旧配对 | 本轮 | 相对原评变化 | 相对配对变化 |
| --- | --- | --- | --- | --- |
| yes | yes | yes | retained_success | retained_success |

| 内容 | 原始记录 |
| --- | --- |
| 历史答案 | 模型先用LSTM编码器按时间步依次输入5张图像，在t=5时以最后隐藏状态h_e^(t)作为整段序列的上下文。 [1][2][3]<br>模型包含5个独立解码器，每个解码器对应序列中的一张图像，分别生成该位置的词序列，最终故事由5个解码器的输出拼接而成。 [4][5][6]<br>每个解码器以编码器最后隐藏状态（上下文）初始化，并以对应图像嵌入e(I_i)作为首个输入。 [7][4]<br>这种按位置分配解码器的设计使每个解码器学习序列特定位置的语言模型，例如第一个解码器学习故事开头、最后一个学习结尾。 [6][8]<br><br>依据：<br>[1] Contextualize, Show and Tell: A Neural Visual Storyteller · 记忆 v1 · 当前版本原文依据（第 7 行）<br>[2] Contextualize, Show and Tell: A Neural Visual Storyteller · 记忆 v1 · 当前版本原文依据（第 7 行）<br>[3] Contextualize, Show and Tell: A Neural Visual Storyteller · 记忆 v1 · 当前版本原文依据（第 7 行）<br>[4] Contextualize, Show and Tell: A Neural Visual Storyteller · 记忆 v1 · 当前版本原文依据（第 9 行）<br>[5] Contextualize, Show and Tell: A Neural Visual Storyteller · 记忆 v1 · 当前版本原文依据（第 10 行）<br>[6] Contextualize, Show and Tell: A Neural Visual Storyteller · 记忆 v1 · 当前版本原文依据（第 9 行）<br>[7] Contextualize, Show and Tell: A Neural Visual Storyteller · 记忆 v1 · 当前版本原文依据（第 10 行）<br>[8] Contextualize, Show and Tell: A Neural Visual Storyteller · 记忆 v1 · 当前版本原文依据（第 9 行） |
| 本轮答案 | 编码器按顺序逐个时间步接收图像，在 t=5 时通过最后隐藏状态 h_e^(t)（记为 Z）得到上下文向量。 [1][2]<br>模型包含五个独立解码器，每个图像对应一个解码器；第一个解码器为第一张图像生成词序列，第二个为第二张，依此类推。 [3][4]<br>每个解码器为序列中对应图像生成一段词序列，最终故事是五个解码器输出的拼接。 [5]<br>编码器最后隐藏状态（上下文）用于初始化每个解码器的隐藏状态，每个解码器的首个输入是其对应的图像嵌入 e(I_i)。 [6][7]<br>这种设计使每个解码器学习针对序列各位置特定的语言模型。 [8]<br><br>依据：<br>[1] Contextualize, Show and Tell: A Neural Visual Storyteller · 记忆 v1 · 当前版本原文依据（第 10 行）<br>[2] Contextualize, Show and Tell: A Neural Visual Storyteller · 记忆 v1 · 当前版本原文依据（第 7 行）<br>[3] Contextualize, Show and Tell: A Neural Visual Storyteller · 记忆 v1 · 当前版本原文依据（第 9 行）<br>[4] Contextualize, Show and Tell: A Neural Visual Storyteller · 记忆 v1 · 当前版本原文依据（第 9 行）<br>[5] Contextualize, Show and Tell: A Neural Visual Storyteller · 记忆 v1 · 当前版本原文依据（第 10 行）<br>[6] Contextualize, Show and Tell: A Neural Visual Storyteller · 记忆 v1 · 当前版本原文依据（第 10 行）<br>[7] Contextualize, Show and Tell: A Neural Visual Storyteller · 记忆 v1 · 当前版本原文依据（第 9 行）<br>[8] Contextualize, Show and Tell: A Neural Visual Storyteller · 记忆 v1 · 当前版本原文依据（第 9 行） |
| 历史答案原评理由 | Covers encoder step-by-step processing, LSTM context at t=5, per-position decoders, and concatenated story. |
| 历史答案本次匿名配对理由 | Describes sequential encoder, context at t=5, five decoders per image, concatenation, and position-specific models—equivalent to gold. |
| 本轮答案理由 | Covers ordered encoder timesteps, context vector at t=5, five decoders per image, concatenation, and initialization—semantically equivalent to gold. |
| 历史记忆标签 / 理由 | yes / Memories capture the sequential encoding (images in order per timestep, context vector at t=5) and decoder use of global sequence context plus local image content, matching both human evidence alternatives. |
| 本轮记忆标签 / 理由 | yes / Memories capture the encoder taking images in order per timestep, context vector from last hidden state initializing each decoder, and each decoder generating words per image, matching both evidence alternatives. |
| 历史检索标签 / 理由 | yes / Same full set of references covers sequential encoding, context initialization, per-image decoding, and story concatenation, sufficient to answer how sequentiality is captured. |
| 本轮检索标签 / 理由 | yes / Same references cover ordered encoder timesteps, context vector, and per-image decoder word generation, sufficient to explain sequential story capture. |

### c37f65c9f0d543a35c784263b79236ccf1c44fac · 桌面 · 可答

What model is used to encode the images?

| 历史原评 | 本次旧配对 | 本轮 | 相对原评变化 | 相对配对变化 |
| --- | --- | --- | --- | --- |
| yes | yes | yes | retained_success | retained_success |

| 内容 | 原始记录 |
| --- | --- |
| 历史答案 | The image representation is obtained using Inception v3. [1]<br>The encoder is a Convolutional Neural Network (CNN). [2]<br>The image representation is obtained through Inception V3. [3] |
| 本轮答案 | The image representations were obtained using Inception V3. [1][2]<br>The encoder is a Convolutional Neural Network (CNN). [3] |
| 历史答案原评理由 | States Inception V3 and CNN encoder, matching the gold answers. |
| 历史答案本次匿名配对理由 | States Inception V3 and CNN, matching the human answers for image encoding. |
| 本轮答案理由 | States Inception V3 and CNN encoder, matching the human answers. |
| 历史记忆标签 / 理由 | yes / Memories state the encoder is a CNN and that image representations were obtained through Inception V3, covering the CNN and Inception V3 answer alternatives. |
| 本轮记忆标签 / 理由 | yes / Memories state the encoder is a CNN and image representations were obtained via Inception V3, covering both human answer alternatives (CNN and LSTM/Inception V3). |
| 历史检索标签 / 理由 | yes / References include 'The encoder is a Convolutional Neural Network (CNN)' and 'representation of the images was obtained through Inception V3', covering both gold answers. |
| 本轮检索标签 / 理由 | yes / References include 'The encoder is a Convolutional Neural Network (CNN)' and 'The representation of the images was obtained through Inception V3', covering both gold answers. |

### c37f65c9f0d543a35c784263b79236ccf1c44fac · 飞书 · 可答

What model is used to encode the images?

| 历史原评 | 本次旧配对 | 本轮 | 相对原评变化 | 相对配对变化 |
| --- | --- | --- | --- | --- |
| yes | yes | yes | retained_success | retained_success |

| 内容 | 原始记录 |
| --- | --- |
| 历史答案 | 图像表示通过 Inception V3 获得。 [1]<br>编码器是卷积神经网络（CNN）。 [2]<br>编码器按顺序接收图像，每个时间步接收一张。 [3]<br><br>依据：<br>[1] Contextualize, Show and Tell: A Neural Visual Storyteller · 记忆 v1 · 当前版本原文依据（第 7 行）<br>[2] Contextualize, Show and Tell: A Neural Visual Storyteller · 记忆 v1 · 当前版本原文依据（第 6 行）<br>[3] Contextualize, Show and Tell: A Neural Visual Storyteller · 记忆 v1 · 当前版本原文依据（第 10 行） |
| 本轮答案 | 图像表示通过 Inception V3 获得。 [1]<br>对序列中的每张图像，使用 Inception v3 获得其表示。 [2]<br><br>依据：<br>[1] Contextualize, Show and Tell: A Neural Visual Storyteller · 记忆 v1 · 当前版本原文依据（第 7 行）<br>[2] Contextualize, Show and Tell: A Neural Visual Storyteller · 记忆 v1 · 当前版本原文依据（第 10 行） |
| 历史答案原评理由 | Same correct content in Chinese: Inception V3 and CNN encoder. |
| 历史答案本次匿名配对理由 | States Inception V3 and CNN encoder, matching the human answers. |
| 本轮答案理由 | States Inception V3 for image representations, matching the human answer. |
| 历史记忆标签 / 理由 | yes / Memories state the encoder is a CNN and that image representations were obtained through Inception V3, covering the CNN and Inception V3 answer alternatives. |
| 本轮记忆标签 / 理由 | yes / Memories state the encoder is a CNN and image representations were obtained via Inception V3, covering both human answer alternatives (CNN and LSTM/Inception V3). |
| 历史检索标签 / 理由 | yes / Same references present, including CNN encoder and Inception V3 image representation, matching both human gold spans. |
| 本轮检索标签 / 理由 | yes / Same references present, including CNN encoder and Inception V3 image representation, matching both human gold spans. |

### b08f88d1facefceb87e134ba2c1fa90035018e83 · 桌面 · 可答

Do the decoder LSTMs all have the same weights?

| 历史原评 | 本次旧配对 | 本轮 | 相对原评变化 | 相对配对变化 |
| --- | --- | --- | --- | --- |
| no | no | no | still_unsuccessful | still_unsuccessful |

| 内容 | 原始记录 |
| --- | --- |
| 历史答案 | 现有记录不足以支持完整结论或问题前提，请核对原文或补充记录。 |
| 本轮答案 | 现有记录不足以支持完整结论或问题前提，请核对原文或补充记录。 |
| 历史答案原评理由 | Refuses/claims insufficient records instead of answering; question is answerable. |
| 历史答案本次匿名配对理由 | Refuses/claims insufficient records instead of answering; question is answerable. |
| 本轮答案理由 | Refuses/claims insufficient records instead of answering; question is answerable. |
| 历史记忆标签 / 理由 | no / Memories state there are five independent decoders and each learns a specific language model, but none explicitly state whether the decoder LSTMs share the same weights; the required fact is absent. |
| 本轮记忆标签 / 理由 | no / Memories state five independent decoders each learn a specific language model, but none explicitly say whether the decoder LSTMs share the same weights; the gold paragraph also does not directly answer weight sharing. |
| 历史检索标签 / 理由 | no / References describe five independent decoders each learning a specific language model, implying separate weights, but never explicitly state whether decoder LSTMs share the same weights. |
| 本轮检索标签 / 理由 | no / References only state there are five independent decoders; none address whether decoder LSTMs share weights. |

### b08f88d1facefceb87e134ba2c1fa90035018e83 · 飞书 · 可答

Do the decoder LSTMs all have the same weights?

| 历史原评 | 本次旧配对 | 本轮 | 相对原评变化 | 相对配对变化 |
| --- | --- | --- | --- | --- |
| no | no | no | still_unsuccessful | still_unsuccessful |

| 内容 | 原始记录 |
| --- | --- |
| 历史答案 | 项目记忆中没有足够依据，暂不自动回复。 |
| 本轮答案 | 项目记忆中没有足够依据，暂不自动回复。 |
| 历史答案原评理由 | Refuses/claims insufficient records instead of answering; question is answerable. |
| 历史答案本次匿名配对理由 | Refuses/claims insufficient records instead of answering; question is answerable. |
| 本轮答案理由 | Refuses/claims insufficient records instead of answering; question is answerable. |
| 历史记忆标签 / 理由 | no / Memories state there are five independent decoders and each learns a specific language model, but none explicitly state whether the decoder LSTMs share the same weights; the required fact is absent. |
| 本轮记忆标签 / 理由 | no / Memories state five independent decoders each learn a specific language model, but none explicitly say whether the decoder LSTMs share the same weights; the gold paragraph also does not directly answer weight sharing. |
| 历史检索标签 / 理由 | no / Same references; they mention independent decoders and per-position language models but do not explicitly address whether the decoder LSTMs have identical weights. |
| 本轮检索标签 / 理由 | no / Same references; no content about weight sharing among decoder LSTMs. |

### 10fb7dc031075946153baf0a0599e126de29e3a4 · 桌面 · 可答

How does the neural network architecture accomodate an unknown amount of senses per word?

| 历史原评 | 本次旧配对 | 本轮 | 相对原评变化 | 相对配对变化 |
| --- | --- | --- | --- | --- |
| partial | partial | partial | still_unsuccessful | still_unsuccessful |

| 内容 | 原始记录 |
| --- | --- |
| 历史答案 | GlossBERT treats WSD as a sentence-pair classification problem: it constructs context-gloss pairs from the glosses of all possible senses (in WordNet) of the target word. [1]<br>For each target, its candidate senses come from entries of its lemma in a pre-defined sense inventory (usually WordNet), so the number of candidate senses is not fixed in advance. [2]<br>GlossBERT 将 WSD 视为句对分类问题：它用目标词在 WordNet 中所有可能义项的释义构造 context-gloss 对。 [1][3]<br>模型以 context-gloss 对为输入，取首个 token [CLS] 的最终隐状态作为整个序列的表示，并加一个二分类层（label∈{yes, no}）。 [4]<br>测试时，模型输出每个 context-gloss 对 label=yes 的概率，并选择概率最高的义项作为目标词的预测标签。 [5]<br>每个目标词有 N 个 context-gloss 对训练实例（label∈{yes, no}）。 [6]<br>尚待确认：The records do not describe the internal mechanism by which the architecture handles a variable/unknown number of senses per word (e.g., how context-gloss pairs are batched or aggregated across senses).；未说明在候选义项数量可变时，context-gloss 对如何被批处理或跨义项聚合以完成分类。；记录未说明在候选义项数量可变时，context-gloss 对如何被批处理或跨义项聚合以完成分类。；记录未说明网络内部如何具体处理每个词义项数量未知的情况（例如批大小或聚合方式）。；How does the neural network architecture accomodate an unknown amount of senses per word? |
| 本轮答案 | The paper constructs context-gloss pairs from glosses of all possible senses (in WordNet) of the target word, treating WSD as a sentence-pair classification problem. [1]<br>For each target word, glosses of all N possible senses are extracted to form the gloss sentence; the example given uses N=4. [2]<br>GlossBERT将WSD建模为句对分类：为每个目标词构造上下文-释义对，释义取自该词在WordNet中所有可能义项的释义。 [3][1]<br>对每个目标词，抽取其全部N个可能义项的释义来构成释义句，示例中N=4。 [2]<br>因此每个目标词有N个上下文-释义对训练实例，标签为yes或no。 [4]<br>测试时输出每个上下文-释义对label=yes的概率，取概率最高的义项作为该目标词的预测标签。 [5]<br>上下文-释义对中加入[CLS]和[SEP]标记，以适配BERT模型的输入。 [6]<br>尚待确认：The records do not explicitly state how the architecture handles a variable or unknown number of senses per word beyond forming one context-gloss pair per sense; no padding, batching, or aggregation mechanism is documented.；未说明在形成每个义项一个上下文-释义对之后，架构如何通过填充、批处理或聚合机制处理每词可变或未知数量的义项。；记录未说明在形成每个义项一个上下文-释义对之后，架构如何通过填充、批处理或聚合机制处理每词可变或未知数量的义项。；How does the neural network architecture accomodate an unknown amount of senses per word? |
| 历史答案原评理由 | Adds that candidate senses come from lemma entries in a sense inventory, implying variable count, but does not explain the internal mechanism for unknown sense counts. |
| 历史答案本次匿名配对理由 | Describes context-gloss pairs for all senses and per-pair classification, but does not explain how the architecture accommodates a variable/unknown number of senses; it explicitly flags this as unknown. |
| 本轮答案理由 | Adds the N-senses gloss sentence and [CLS]/[SEP] input details, but still does not explain how the architecture handles a variable/unknown number of senses; flagged as unknown. |
| 历史记忆标签 / 理由 | no / No supplied memory states how the architecture handles an unknown/variable number of senses per word; memories only mention constructing context-gloss pairs from all possible senses, not the mechanism for unknown sense counts. |
| 本轮记忆标签 / 理由 | partial / Memories cover converting WSD to sequence/sentence-pair classification and constructing context-gloss pairs from all N senses, which addresses variable sense counts, but no memory explicitly states the architecture accommodates an unknown/variable number of senses per word. |
| 历史检索标签 / 理由 | no / Selected references discuss gloss knowledge, context-gloss pairs, and BERT, but none explain how the architecture handles a variable/unknown number of senses per word (e.g., per-sense classification or N context-gloss pairs). |
| 本轮检索标签 / 理由 | no / Selected references describe gloss-based WSD models and context-gloss pairs but do not explain how the architecture handles a variable/unknown number of senses per word. |

### 10fb7dc031075946153baf0a0599e126de29e3a4 · 飞书 · 可答

How does the neural network architecture accomodate an unknown amount of senses per word?

| 历史原评 | 本次旧配对 | 本轮 | 相对原评变化 | 相对配对变化 |
| --- | --- | --- | --- | --- |
| partial | partial | partial | still_unsuccessful | still_unsuccessful |

| 内容 | 原始记录 |
| --- | --- |
| 历史答案 | GlossBERT将WSD任务视为句子对分类问题：为目标词所有可能义项（WordNet中的释义）构造上下文-释义对。 [1]<br>每个目标词t的候选义项{c1,…,cn}来自其词元在预定义义项库（通常为WordNet）中的条目。 [2]<br>GlossBERT将WSD视为句子对分类问题：为目标词所有可能义项（WordNet中的释义）构造上下文-释义对。 [3][1]<br>模型以上下文-释义对为输入，取首个token [CLS]的最终隐藏状态作为整个序列的表示，并加一个二分类层（label∈{yes,no}）。 [4]<br>测试时，对每个上下文-释义对输出label=yes的概率，取概率最高的义项作为目标词的预测标签。 [5]<br>每个目标词有N个上下文-释义对训练实例（label∈{yes,no}）。 [6]<br>尚待确认：记录未说明神经网络架构在内部如何具体处理可变数量的候选义项（如逐对处理、聚合或填充等机制）。；神经网络架构内部如何具体处理可变数量的候选义项（如逐对处理、聚合或填充等机制）未说明；How does the neural network architecture accomodate an unknown amount of senses per word?<br><br>依据：<br>[1] GlossBERT: BERT for Word Sense Disambiguation with Gloss Knowledge · 记忆 v1 · 当前版本原文依据（第 6 行）<br>[2] GlossBERT: BERT for Word Sense Disambiguation with Gloss Knowledge · 记忆 v1 · 当前版本原文依据（第 10 行）<br>[3] GlossBERT: BERT for Word Sense Disambiguation with Gloss Knowledge · 记忆 v1 · 当前版本原文依据（第 13 行）<br>[4] GlossBERT: BERT for Word Sense Disambiguation with Gloss Knowledge · 记忆 v1 · 当前版本原文依据（第 19 行）<br>[5] GlossBERT: BERT for Word Sense Disambiguation with Gloss Knowledge · 记忆 v1 · 当前版本原文依据（第 17 行）<br>[6] GlossBERT: BERT for Word Sense Disambiguation with Gloss Knowledge · 记忆 v1 · 当前版本原文依据（第 17 行） |
| 本轮答案 | 对每个目标词，从WordNet中抽取该词全部N个可能词义的释义（gloss），文中示例N=4，以得到释义句。 [1]<br>系统从目标词所有可能词义（WordNet中）的释义构造上下文-释义对，从而把WSD任务视为句对分类问题。 [2]<br>在上下文-释义对中加入[CLS]和[SEP]标记，使其适合作为BERT模型的输入。 [3]<br>对每个目标词，系统从WordNet中抽取该词全部N个可能词义的释义（gloss）以得到释义句，文中示例N=4。 [1]<br>GlossBERT从目标词所有可能词义（WordNet中）的释义构造上下文-释义对，从而把WSD任务视为句对分类问题。 [4][2]<br>在上下文-释义对中加入[CLS]和[SEP]标记，使其适合作为BERT模型的输入。 [3][5]<br>尚待确认：记录未说明当每个词的词义数量未知或可变时，架构如何动态处理该数量（如逐对独立处理、填充或批处理等具体机制）。；未说明当每个词的词义数量未知或可变时，架构如何动态处理该数量（如逐对独立处理、填充或批处理等具体机制）。；How does the neural network architecture accomodate an unknown amount of senses per word?<br><br>依据：<br>[1] GlossBERT: BERT for Word Sense Disambiguation with Gloss Knowledge · 记忆 v1 · 当前版本原文依据（第 15 行）<br>[2] GlossBERT: BERT for Word Sense Disambiguation with Gloss Knowledge · 记忆 v1 · 当前版本原文依据（第 6 行）<br>[3] GlossBERT: BERT for Word Sense Disambiguation with Gloss Knowledge · 记忆 v1 · 当前版本原文依据（第 15 行）<br>[4] GlossBERT: BERT for Word Sense Disambiguation with Gloss Knowledge · 记忆 v1 · 当前版本原文依据（第 13 行）<br>[5] GlossBERT: BERT for Word Sense Disambiguation with Gloss Knowledge · 记忆 v1 · 当前版本原文依据（第 15 行） |
| 历史答案原评理由 | Includes candidate senses from lemma entries and context-gloss pairing, but leaves the variable-count handling mechanism unstated. |
| 历史答案本次匿名配对理由 | Same content as desktop: covers context-gloss pair construction and per-pair prediction but leaves the variable-sense-count handling unaddressed. |
| 本轮答案理由 | Covers gloss extraction for all N senses and BERT input formatting, but does not describe the mechanism for variable sense counts; explicitly marked unknown. |
| 历史记忆标签 / 理由 | no / No supplied memory states how the architecture handles an unknown/variable number of senses per word; memories only mention constructing context-gloss pairs from all possible senses, not the mechanism for unknown sense counts. |
| 本轮记忆标签 / 理由 | partial / Memories cover converting WSD to sequence/sentence-pair classification and constructing context-gloss pairs from all N senses, which addresses variable sense counts, but no memory explicitly states the architecture accommodates an unknown/variable number of senses per word. |
| 历史检索标签 / 理由 | partial / References mention constructing context-gloss pairs from all possible senses and N training instances per target, hinting at per-sense handling, but do not explicitly explain how the architecture accommodates an unknown number of senses. |
| 本轮检索标签 / 理由 | no / References mention candidate senses and gloss pairs but give no mechanism for accommodating an unknown number of senses per word. |

### c5b0ed5db65051eebd858beaf303809aa815e8e5 · 桌面 · 可答

Do they use large or small BERT?

| 历史原评 | 本次旧配对 | 本轮 | 相对原评变化 | 相对配对变化 |
| --- | --- | --- | --- | --- |
| yes | yes | yes | retained_success | retained_success |

| 内容 | 原始记录 |
| --- | --- |
| 历史答案 | They use the pre-trained uncased BERT_BASE model for fine-tuning, because BERT_LARGE performs slightly worse than BERT_BASE on this task. [1] |
| 本轮答案 | They use the pre-trained uncased BERT_BASE model for fine-tuning, not BERT_LARGE, because they find BERT_LARGE performs slightly worse than BERT_BASE on this task. [1] |
| 历史答案原评理由 | States they use BERT_BASE (small BERT), matching the human answer. |
| 历史答案本次匿名配对理由 | States they use BERT_BASE (small BERT), matching the human answer. |
| 本轮答案理由 | States they use BERT_BASE (small BERT), matching the human answer. |
| 历史记忆标签 / 理由 | yes / Memory 751f5c70 states they use the pre-trained uncased BERT_BASE model for fine-tuning, which corresponds to small BERT and matches the human answer 'small BERT'. |
| 本轮记忆标签 / 理由 | yes / Memory 77c49331 states they use the pre-trained uncased BERT_BASE model for fine-tuning, which corresponds to 'small BERT' and matches the human answer. |
| 历史检索标签 / 理由 | yes / Reference states they use pre-trained uncased BERT_BASE (small) rather than BERT_LARGE, directly answering the question. |
| 本轮检索标签 / 理由 | yes / Reference states they use BERT_BASE (small) rather than BERT_LARGE, directly answering the question. |

### c5b0ed5db65051eebd858beaf303809aa815e8e5 · 飞书 · 可答

Do they use large or small BERT?

| 历史原评 | 本次旧配对 | 本轮 | 相对原评变化 | 相对配对变化 |
| --- | --- | --- | --- | --- |
| yes | yes | yes | retained_success | retained_success |

| 内容 | 原始记录 |
| --- | --- |
| 历史答案 | 他们使用预训练的 uncased BERT_BASE 模型进行微调，因为发现 BERT_LARGE 在该任务上表现略差于 BERT_BASE。 [1]<br><br>依据：<br>[1] GlossBERT: BERT for Word Sense Disambiguation with Gloss Knowledge · 记忆 v1 · 当前版本原文依据（第 25 行） |
| 本轮答案 | 他们使用预训练的 uncased BERT_BASE 模型进行微调，因为发现 BERT_LARGE 在该任务上表现略差于 BERT_BASE。 [1]<br><br>依据：<br>[1] GlossBERT: BERT for Word Sense Disambiguation with Gloss Knowledge · 记忆 v1 · 当前版本原文依据（第 25 行） |
| 历史答案原评理由 | Chinese answer states BERT_BASE is used, equivalent to small BERT. |
| 历史答案本次匿名配对理由 | States they use BERT_BASE (small BERT), matching the human answer. |
| 本轮答案理由 | States they use BERT_BASE (small BERT), matching the human answer. |
| 历史记忆标签 / 理由 | yes / Memory 751f5c70 states they use the pre-trained uncased BERT_BASE model for fine-tuning, which corresponds to small BERT and matches the human answer 'small BERT'. |
| 本轮记忆标签 / 理由 | yes / Memory 77c49331 states they use the pre-trained uncased BERT_BASE model for fine-tuning, which corresponds to 'small BERT' and matches the human answer. |
| 历史检索标签 / 理由 | yes / Reference states they use pre-trained uncased BERT_BASE (small) rather than BERT_LARGE, directly answering the question. |
| 本轮检索标签 / 理由 | yes / Same reference explicitly says BERT_BASE is used because BERT_LARGE performs worse, answering small BERT. |

### 7ab9c0b4ceca1c142ff068f85015a249b14282d0 · 桌面 · 可答

Do they incoprorate WordNet into the model?

| 历史原评 | 本次旧配对 | 本轮 | 相对原评变化 | 相对配对变化 |
| --- | --- | --- | --- | --- |
| yes | yes | yes | retained_success | retained_success |

| 内容 | 原始记录 |
| --- | --- |
| 历史答案 | Yes. The paper's GlossBERT constructs context-gloss pairs from all possible senses of the target word in WordNet, treating WSD as a sentence-pair classification problem. [1]<br>The authors extract word sense glosses from WordNet 3.0, since prior work mapped the datasets' sense annotations to WordNet 3.0. [2]<br>Candidate senses for each target come from entries of its lemma in a pre-defined sense inventory, usually WordNet. [3] |
| 本轮答案 | Yes. The paper constructs context-gloss pairs from glosses of all possible senses (in WordNet) of the target word, treating WSD as a sentence-pair classification problem. [1]<br>For each target word, the authors extract glosses of all N possible senses (N=4) from WordNet to obtain the gloss sentence. [2]<br>The authors extract word sense glosses from WordNet 3.0, since BIBREF17 maps all sense annotations in these datasets to WordNet 3.0. [3]<br>The extracted context-gloss pairs are fed to the pre-trained BERT model, which the authors fine-tune on the WSD task. [4][5] |
| 历史答案原评理由 | Explicitly answers yes and cites WordNet sense glosses, matching the human answers. |
| 历史答案本次匿名配对理由 | Affirms WordNet use and cites the exact context-gloss construction from WordNet senses, matching human answers. |
| 本轮答案理由 | Affirms WordNet use with the context-gloss pair construction, matching human answers. |
| 历史记忆标签 / 理由 | yes / Memories explicitly state context-gloss pairs are constructed from glosses of all possible senses in WordNet, matching the human evidence that WordNet is incorporated. |
| 本轮记忆标签 / 理由 | yes / Memory f696e466 states context-gloss pairs are constructed from glosses of all possible senses (in WordNet) of the target word, directly matching the human evidence that WordNet is incorporated. Supporting memories confirm WordNet gloss extraction and GlossBERT construction. |
| 历史检索标签 / 理由 | yes / References include the exact gold sentence constructing context-gloss pairs from WordNet senses, directly answering that WordNet is incorporated. |
| 本轮检索标签 / 理由 | yes / Reference f696e466 states context-gloss pairs are constructed from WordNet senses, directly showing WordNet is incorporated. |

### 7ab9c0b4ceca1c142ff068f85015a249b14282d0 · 飞书 · 可答

Do they incoprorate WordNet into the model?

| 历史原评 | 本次旧配对 | 本轮 | 相对原评变化 | 相对配对变化 |
| --- | --- | --- | --- | --- |
| yes | yes | yes | retained_success | retained_success |

| 内容 | 原始记录 |
| --- | --- |
| 历史答案 | 是。GlossBERT 从 WordNet 中目标词所有可能义项的释义构造上下文-释义对，从而将 WSD 视为句对分类问题。 [1][2]<br>由于 BIBREF17 将这些数据集中所有义项标注映射到 WordNet 3.0，他们从 WordNet 3.0 提取词义释义。 [3]<br>每个目标词的候选义项来自其词元在预定义义项库（通常为 WordNet）中的条目。 [4]<br><br>依据：<br>[1] GlossBERT: BERT for Word Sense Disambiguation with Gloss Knowledge · 记忆 v1 · 当前版本原文依据（第 13 行）<br>[2] GlossBERT: BERT for Word Sense Disambiguation with Gloss Knowledge · 记忆 v1 · 当前版本原文依据（第 6 行）<br>[3] GlossBERT: BERT for Word Sense Disambiguation with Gloss Knowledge · 记忆 v1 · 当前版本原文依据（第 24 行）<br>[4] GlossBERT: BERT for Word Sense Disambiguation with Gloss Knowledge · 记忆 v1 · 当前版本原文依据（第 10 行） |
| 本轮答案 | 是。该工作从WordNet 3.0提取词义释义（gloss），并据此为目标词所有可能词义构建上下文-释义对。 [1][2]<br>具体做法是为每个目标词从WordNet中提取其全部N个可能词义的释义（示例中N=4）。 [3]<br>候选词义来自目标词lemma在预定义词义清单（通常为WordNet）中的条目。 [4]<br><br>依据：<br>[1] GlossBERT: BERT for Word Sense Disambiguation with Gloss Knowledge · 记忆 v1 · 当前版本原文依据（第 24 行）<br>[2] GlossBERT: BERT for Word Sense Disambiguation with Gloss Knowledge · 记忆 v1 · 当前版本原文依据（第 6 行）<br>[3] GlossBERT: BERT for Word Sense Disambiguation with Gloss Knowledge · 记忆 v1 · 当前版本原文依据（第 15 行）<br>[4] GlossBERT: BERT for Word Sense Disambiguation with Gloss Knowledge · 记忆 v1 · 当前版本原文依据（第 10 行） |
| 历史答案原评理由 | Affirms yes and describes using WordNet senses/glosses, equivalent to gold. |
| 历史答案本次匿名配对理由 | States GlossBERT builds context-gloss pairs from WordNet senses, matching the gold answer. |
| 本轮答案理由 | States glosses extracted from WordNet 3.0 and context-gloss pairs built, matching gold. |
| 历史记忆标签 / 理由 | yes / Memories explicitly state context-gloss pairs are constructed from glosses of all possible senses in WordNet, matching the human evidence that WordNet is incorporated. |
| 本轮记忆标签 / 理由 | yes / Memory f696e466 states context-gloss pairs are constructed from glosses of all possible senses (in WordNet) of the target word, directly matching the human evidence that WordNet is incorporated. Supporting memories confirm WordNet gloss extraction and GlossBERT construction. |
| 历史检索标签 / 理由 | yes / References contain the gold sentence about constructing context-gloss pairs from WordNet senses, sufficient to answer yes. |
| 本轮检索标签 / 理由 | yes / Reference f696e466 explicitly says context-gloss pairs are built from WordNet senses, confirming WordNet incorporation. |

### d28d86524292506d4b24ae2d486725a6d57a3db3 · 桌面 · 可答

What is the ROUGE score of the highest performing model?

| 历史原评 | 本次旧配对 | 本轮 | 相对原评变化 | 相对配对变化 |
| --- | --- | --- | --- | --- |
| yes | yes | yes | retained_success | retained_success |

| 内容 | 原始记录 |
| --- | --- |
| 历史答案 | 在 CNN/Daily Mail 上，我们的模型在 ROUGE-1、ROUGE-2 和 ROUGE-L 上的平均值为 33.33，据称达到 state-of-the-art。 [1]<br>尚待确认：记录中未明确给出“最高性能模型”的 ROUGE 分数；仅记录了“我们的模型”在 CNN/Daily Mail 上的三项 ROUGE 平均值 33.33，无法确认该模型是否为最高性能模型。；未明确说明“我们的模型”是否为最高性能模型，因此无法确认最高性能模型的 ROUGE 分数。；What is the ROUGE score of the highest performing model?；未明确给出“最高性能模型”的 ROUGE 分数；仅记录了“我们的模型”在 CNN/Daily Mail 上的三项 ROUGE 平均值 33.33，无法确认该模型是否为最高性能模型。 |
| 本轮答案 | The highest-performing model is not explicitly named; the paper's own model is reported as achieving a 33.33 average of ROUGE-1, ROUGE-2 and ROUGE-L on CNN/Daily Mail, described as state-of-the-art. [1][2]<br>The 33.33 figure is an average across ROUGE-1, ROUGE-2 and ROUGE-L, not a single ROUGE metric value. [1]<br>论文未明确点名“最高性能模型”；其自身模型在 CNN/Daily Mail 上报告的 ROUGE-1、ROUGE-2 和 ROUGE-L 平均值为 33.33，并称达到 state-of-the-art。 [1][2]<br>33.33 是 ROUGE-1、ROUGE-2 和 ROUGE-L 三项的平均值，并非单一 ROUGE 指标分数。 [1]<br>尚待确认：未明确点名“最高性能模型”的具体身份，也未给出其单一 ROUGE 指标分数；仅有作者模型在 CNN/Daily Mail 上三项 ROUGE 的平均值 33.33。；What is the ROUGE score of the highest performing model? |
| 历史答案原评理由 | Reports the 33.33 average of ROUGE-1/2/L on CNN/Daily Mail, matching the gold answer. |
| 历史答案本次匿名配对理由 | States the 33.33 average of ROUGE-1/2/L on CNN/Daily Mail, matching the gold answer. |
| 本轮答案理由 | Gives 33.33 average of ROUGE-1/2/L, matching the gold answer. |
| 历史记忆标签 / 理由 | yes / Memories state the model achieves a 33.33 average of ROUGE-1, ROUGE-2 and ROUGE-L on CNN/Daily Mail, matching the human answer 33.33. |
| 本轮记忆标签 / 理由 | yes / Memories explicitly state the model achieves a 33.33 average of ROUGE-1, ROUGE-2 and ROUGE-L on CNN/Daily Mail, matching the human answer 33.33. |
| 历史检索标签 / 理由 | yes / References include 'Our model achieves a 33.33 average of ROUGE-1, ROUGE-2 and ROUGE-L on the CNN/Daily Mail,' directly giving the ROUGE score of the highest performing model. |
| 本轮检索标签 / 理由 | yes / Reference b77628c1/f00cd9ef states the model achieves a 33.33 average of ROUGE-1, ROUGE-2 and ROUGE-L, matching the gold answer. |

### d28d86524292506d4b24ae2d486725a6d57a3db3 · 飞书 · 可答

What is the ROUGE score of the highest performing model?

| 历史原评 | 本次旧配对 | 本轮 | 相对原评变化 | 相对配对变化 |
| --- | --- | --- | --- | --- |
| yes | yes | yes | retained_success | retained_success |

| 内容 | 原始记录 |
| --- | --- |
| 历史答案 | 在 CNN/Daily Mail 上，我们的模型取得 ROUGE-1、ROUGE-2 和 ROUGE-L 的平均值 33.33，并称其为 state-of-the-art。 [1][2]<br>在 CNN/Daily Mail 上，我们的模型取得 ROUGE-1、ROUGE-2 和 ROUGE-L 的平均值 33.33，并称其为 state-of-the-art。 [1]<br>尚待确认：记录未明确将“highest performing model”对应到某一具体模型，也未给出该模型单一的 ROUGE 分数；上述数值分别属于不同数据集或指标。；未明确“highest performing model”对应哪个具体模型，也未给出该模型单一的 ROUGE 分数；现有数值分属不同数据集或指标。；What is the ROUGE score of the highest performing model?；记录未明确“highest performing model”对应哪个具体模型，也未给出该模型单一的 ROUGE 分数；上述数值分属不同数据集或指标。；未明确“highest performing model”具体指哪个模型，也未给出该模型单一的 ROUGE 分数；现有数值分属不同数据集或指标。<br><br>依据：<br>[1] Pretraining-Based Natural Language Generation for Text Summarization · 记忆 v1 · 当前版本原文依据（第 8 行）<br>[2] Pretraining-Based Natural Language Generation for Text Summarization · 记忆 v1 · 当前版本原文依据（第 8 行） |
| 本轮答案 | 在 CNN/Daily Mail 上，我们的模型在 ROUGE-1、ROUGE-2 和 ROUGE-L 上的平均值为 33.33，并称其为 state-of-the-art。 [1][2]<br>在 CNN/Daily Mail 上，我们的模型在 ROUGE-1、ROUGE-2 和 ROUGE-L 上的平均值为 33.33，并称其为 state-of-the-art。 [2][1]<br>尚待确认：未明确记录“最高性能模型”的具体身份，也未给出其单独的 ROUGE-1、ROUGE-2、ROUGE-L 各项分数；仅记录了上述平均值与相对提升。；最高性能模型的具体身份未明确；最高性能模型单独的 ROUGE-1、ROUGE-2、ROUGE-L 各项分数未给出；未明确记录“最高性能模型”的具体身份。；未给出该模型单独的 ROUGE-1、ROUGE-2、ROUGE-L 各项分数，仅记录了上述平均值。；该模型单独的 ROUGE-1、ROUGE-2、ROUGE-L 各项分数未给出<br><br>依据：<br>[1] Pretraining-Based Natural Language Generation for Text Summarization · 记忆 v1 · 当前版本原文依据（第 8 行）<br>[2] Pretraining-Based Natural Language Generation for Text Summarization · 记忆 v1 · 当前版本原文依据（第 8 行） |
| 历史答案原评理由 | Reports the 33.33 ROUGE average on CNN/Daily Mail, matching the gold answer. |
| 历史答案本次匿名配对理由 | Reports the 33.33 average ROUGE score, matching the human answer. |
| 本轮答案理由 | States the 33.33 average ROUGE score, matching the human answer. |
| 历史记忆标签 / 理由 | yes / Memories state the model achieves a 33.33 average of ROUGE-1, ROUGE-2 and ROUGE-L on CNN/Daily Mail, matching the human answer 33.33. |
| 本轮记忆标签 / 理由 | yes / Memories explicitly state the model achieves a 33.33 average of ROUGE-1, ROUGE-2 and ROUGE-L on CNN/Daily Mail, matching the human answer 33.33. |
| 历史检索标签 / 理由 | yes / References include the statement that the model achieves a 33.33 average of ROUGE-1, ROUGE-2 and ROUGE-L, matching the gold answer. |
| 本轮检索标签 / 理由 | yes / Reference b77628c1/f00cd9ef explicitly gives the 33.33 average ROUGE score, matching the gold answer. |

### 63488da6c7aff9e374561a24ba224e9ce7f65e40 · 桌面 · 无答案

When is this paper published?

| 历史原评 | 本次旧配对 | 本轮 | 相对原评变化 | 相对配对变化 |
| --- | --- | --- | --- | --- |
| yes | yes | yes | retained_success | retained_success |

| 内容 | 原始记录 |
| --- | --- |
| 历史答案 | 现有记录不足以支持完整结论或问题前提，请核对原文或补充记录。 |
| 本轮答案 | 现有记录不足以支持完整结论或问题前提，请核对原文或补充记录。 |
| 历史答案原评理由 | Explicitly states records are insufficient, refusing without inventing facts. |
| 历史答案本次匿名配对理由 | Explicitly states records are insufficient, refusing without inventing facts. |
| 本轮答案理由 | Explicitly states records are insufficient, refusing without inventing facts. |
| 历史记忆标签 / 理由 | no / The question is unanswerable per human answers, and no memory contains the paper's publication date. |
| 本轮记忆标签 / 理由 | no / The question is unanswerable per the human annotation, and no supplied memory states the paper's publication date. The memories cover summarization methods, model architecture, and experiments but contain no publication time information. |
| 历史检索标签 / 理由 | no / No reference states the paper's own publication date; the only date mentioned (Jan 1, 2007) refers to test-set example publication dates, not the paper. |
| 本轮检索标签 / 理由 | no / No reference states the paper's publication date; the only date mentioned (Jan 1, 2007) refers to dataset filtering, not the paper. |

### 63488da6c7aff9e374561a24ba224e9ce7f65e40 · 飞书 · 无答案

When is this paper published?

| 历史原评 | 本次旧配对 | 本轮 | 相对原评变化 | 相对配对变化 |
| --- | --- | --- | --- | --- |
| yes | yes | yes | retained_success | retained_success |

| 内容 | 原始记录 |
| --- | --- |
| 历史答案 | 项目记忆中没有足够依据，暂不自动回复。 |
| 本轮答案 | 项目记忆中没有足够依据，暂不自动回复。 |
| 历史答案原评理由 | Explicitly says insufficient basis, refusing without invented facts. |
| 历史答案本次匿名配对理由 | States insufficient basis and declines to answer, a valid refusal. |
| 本轮答案理由 | States insufficient basis and declines to answer, a valid refusal. |
| 历史记忆标签 / 理由 | no / The question is unanswerable per human answers, and no memory contains the paper's publication date. |
| 本轮记忆标签 / 理由 | no / The question is unanswerable per the human annotation, and no supplied memory states the paper's publication date. The memories cover summarization methods, model architecture, and experiments but contain no publication time information. |
| 历史检索标签 / 理由 | no / Same references; none give the paper's publication date, only a dataset cutoff date of January 1, 2007. |
| 本轮检索标签 / 理由 | no / Same references; none give the paper's publication date, only an unrelated dataset date of January 1, 2007. |

### c1c44fd96c3fa6e16949ae8fa453e511c6435c68 · 桌面 · 可答

Why masking words in the decoder is helpful?

| 历史原评 | 本次旧配对 | 本轮 | 相对原评变化 | 相对配对变化 |
| --- | --- | --- | --- | --- |
| yes | yes | yes | retained_success | retained_success |

| 内容 | 原始记录 |
| --- | --- |
| 历史答案 | 掩码解码器中的词有助于利用BERT等上下文语言模型的能力：refine解码过程提供更完整的输入序列，与其预训练过程一致。 [1]<br>设计词级refine解码器是因为该过程类似BERT预训练中的完形填空任务，从而能借助上下文语言模型生成更流畅自然的序列。 [2]<br>refine过程的主要目的是用BERT的上下文化表示增强解码器。 [3]<br>在第二阶段，对摘要中的每个词进行掩码，并用refine解码器逐个预测精炼后的词。 [4]<br>refine解码器以生成的摘要草稿为输入，输出精炼后的摘要，并基于源文档及其他词一次聚焦一个词。 [5][6] |
| 本轮答案 | 掩码解码器逐词掩码摘要草稿中的每个词，再由精炼解码器基于源文档和其他词一次预测一个精炼词，使每个词的预测能利用两侧上下文信息。 [1][2][3]<br>该掩码精炼过程类似BERT的完形填空预训练任务，可借助上下文语言模型能力生成更流畅自然的序列。 [4]<br>从BERT等上下文化嵌入的角度看，精炼解码提供了更完整的输入序列，与其预训练过程一致。 [5]<br>引入精炼过程的主要目的是利用BERT的上下文化表示增强解码器。 [6] |
| 历史答案原评理由 | States masking resembles BERT's cloze pretraining, enabling the contextual LM to generate more fluent/natural sequences, matching the gold answer. |
| 历史答案本次匿名配对理由 | Explicitly gives the cloze-task similarity and fluent/natural sequence generation rationale from the gold answer. |
| 本轮答案理由 | States masking is similar to BERT's cloze task and lets the contextual LM generate more fluent/natural sequences, matching the gold answer. |
| 历史记忆标签 / 理由 | yes / Memory 72a661b1 directly states the word-level refine decoder masks words because it resembles BERT's cloze pre-training, letting the contextual language model generate more fluent and natural sequences, matching the human answer. Supporting memories describe the masking process and consistency with pre-training. |
| 本轮记忆标签 / 理由 | yes / Memory e5b4cdb9 states the word-level refine decoder is similar to BERT's cloze task, so using the contextual language model lets the decoder generate more fluent and natural sequences, matching the human answer. Supporting memories describe masking each word and the more complete input consistent with pre-training. |
| 历史检索标签 / 理由 | yes / Reference 72a661b1 directly states masking is similar to BERT's cloze pre-training, letting the contextual LM generate more fluent/natural sequences, matching the gold answer. |
| 本轮检索标签 / 理由 | yes / Reference e5b4cdb9 directly states masking is similar to BERT's cloze pre-training, enabling the contextual language model to generate more fluent/natural sequences, matching the gold answer. |

### c1c44fd96c3fa6e16949ae8fa453e511c6435c68 · 飞书 · 可答

Why masking words in the decoder is helpful?

| 历史原评 | 本次旧配对 | 本轮 | 相对原评变化 | 相对配对变化 |
| --- | --- | --- | --- | --- |
| yes | yes | yes | retained_success | retained_success |

| 内容 | 原始记录 |
| --- | --- |
| 历史答案 | 掩码词级精炼解码器之所以有帮助，是因为该过程类似于BERT预训练中的完形填空任务，借助上下文语言模型的能力，解码器可以生成更流畅、更自然的序列。 [1]<br>从BERT或其他上下文化嵌入的角度看，精炼解码过程提供了更完整的输入序列，这与它们的预训练过程一致。 [2]<br>设计精炼过程是为了缓解解码器无法利用BERT生成高质量上下文向量能力的问题，该问题在使用其他上下文化词表示时也存在。 [3][4]<br><br>依据：<br>[1] Pretraining-Based Natural Language Generation for Text Summarization · 记忆 v1 · 当前版本原文依据（第 46 行）<br>[2] Pretraining-Based Natural Language Generation for Text Summarization · 记忆 v1 · 当前版本原文依据（第 45 行）<br>[3] Pretraining-Based Natural Language Generation for Text Summarization · 记忆 v1 · 当前版本原文依据（第 32 行）<br>[4] Pretraining-Based Natural Language Generation for Text Summarization · 记忆 v1 · 当前版本原文依据（第 33 行） |
| 本轮答案 | 掩码词级精炼解码与BERT预训练中的完形填空任务相似，因此可利用上下文语言模型的能力生成更流畅、自然的序列。 [1]<br>精炼解码过程为BERT等上下文化嵌入提供更完整的输入序列，与其预训练过程一致。 [2]<br>精炼解码器接收生成的摘要草稿作为输入，逐词掩码并基于源文档及其他词预测精炼词，从而输出精炼摘要。 [3][4]<br>该设计旨在解决以往抽象式方法仅使用左上下文解码器、预测每个词时缺乏完整上下文的问题。 [5][6]<br><br>依据：<br>[1] Pretraining-Based Natural Language Generation for Text Summarization · 记忆 v1 · 当前版本原文依据（第 46 行）<br>[2] Pretraining-Based Natural Language Generation for Text Summarization · 记忆 v1 · 当前版本原文依据（第 45 行）<br>[3] Pretraining-Based Natural Language Generation for Text Summarization · 记忆 v1 · 当前版本原文依据（第 42 行）<br>[4] Pretraining-Based Natural Language Generation for Text Summarization · 记忆 v1 · 当前版本原文依据（第 45 行）<br>[5] Pretraining-Based Natural Language Generation for Text Summarization · 记忆 v1 · 当前版本原文依据（第 3 行）<br>[6] Pretraining-Based Natural Language Generation for Text Summarization · 记忆 v1 · 当前版本原文依据（第 7 行） |
| 历史答案原评理由 | Gives the cloze-task/BERT pretraining rationale and fluent natural sequences, matching the gold answer. |
| 历史答案本次匿名配对理由 | Directly states the cloze-task similarity and contextual LM benefit of more fluent, natural sequences. |
| 本轮答案理由 | Includes the core reason: cloze-task similarity and using contextual LM ability to produce more fluent, natural sequences. |
| 历史记忆标签 / 理由 | yes / Memory 72a661b1 directly states the word-level refine decoder masks words because it resembles BERT's cloze pre-training, letting the contextual language model generate more fluent and natural sequences, matching the human answer. Supporting memories describe the masking process and consistency with pre-training. |
| 本轮记忆标签 / 理由 | yes / Memory e5b4cdb9 states the word-level refine decoder is similar to BERT's cloze task, so using the contextual language model lets the decoder generate more fluent and natural sequences, matching the human answer. Supporting memories describe masking each word and the more complete input consistent with pre-training. |
| 历史检索标签 / 理由 | yes / Reference 72a661b1 explicitly gives the cloze-task/BERT rationale and the fluency/naturalness benefit, fully covering the gold answer. |
| 本轮检索标签 / 理由 | yes / Reference e5b4cdb9 explicitly gives the cloze-task/BERT rationale and fluent natural sequence benefit, fully covering the gold evidence. |

### feafcc1c4026d7f55a2c8ce7850d7e12030b5c22 · 桌面 · 可答

How are the different components of the model trained? Is it trained end-to-end?

| 历史原评 | 本次旧配对 | 本轮 | 相对原评变化 | 相对配对变化 |
| --- | --- | --- | --- | --- |
| yes | yes | yes | retained_success | retained_success |

| 内容 | 原始记录 |
| --- | --- |
| 历史答案 | 该模型基于BERT，在编码器和解码器过程中利用预训练语言模型，并且可以端到端训练，无需手工特征。 [1]<br>训练时模型目标是两个过程目标之和，使用“teacher-forcing”算法联合训练；训练中把真实摘要输入每个解码器并最小化目标。 [2]<br>模型目标函数为 L_model = L̂_dec + L̂_refine。 [3]<br>模型变体包括：One-Stage（基于BERT、带复制机制的序列到序列模型）、Two-Stage（在One-Stage上增加word-refine解码器）、Two-Stage + RL（带refine过程并结合RL目标的完整模型）。 [4] |
| 本轮答案 | The proposed BERT-based natural language generation model can be trained end-to-end without handcrafted features. [1]<br>The model uses a two-stage decoder process, in which each summary word is generated considering both sides' context information. [2]<br>During model training, the objective is the sum of the two processes, jointly trained using the "teacher-forcing" algorithm, feeding the ground-truth summary to each decoder and minimizing the objective. [3]<br>The model loss is defined as the sum of the decoder loss and the refine loss (L_model = L_dec + L_refine). [4]<br>Training uses an Adam optimizer with learning rate 3e-4, β1=0.9, β2=0.999, ε=1e-9, and a dynamic learning rate. [5]<br>Due to GPU memory limits, gradient accumulation is used with an accumulate step of 12 and 3 samples fed at each step. [6]<br>Training uses batch size 36 for 4 epochs (8 epochs for NYT50), with the best model selected from the last 10 models based on development set performance. [7] |
| 历史答案原评理由 | States end-to-end training and joint teacher-forcing training on summed objective, matching the human answers. |
| 历史答案本次匿名配对理由 | States end-to-end training and joint teacher-forcing training with summed objective, matching the human answers. |
| 本轮答案理由 | States end-to-end training and joint teacher-forcing training with summed objective, matching the human answers. |
| 历史记忆标签 / 理由 | yes / Memories state the model is jointly trained with teacher-forcing, objective is sum of the two processes (L_dec + L_refine), and the model can be trained end-to-end, covering both training method and end-to-end question. |
| 本轮记忆标签 / 理由 | yes / Memories state the model is jointly trained with teacher-forcing, objective is sum of the two processes (L_model = L_dec + L_refine), and the model can be trained end-to-end, matching the human answers. |
| 历史检索标签 / 理由 | yes / References include the joint teacher-forcing training objective summing the two processes and the statement that the model can be trained end-to-end, covering both parts of the question. |
| 本轮检索标签 / 理由 | yes / References include the joint teacher-forcing training objective (sum of two processes, ground-truth summary fed to each decoder) and the statement that the model can be trained end-to-end, covering both parts of the question. |

### feafcc1c4026d7f55a2c8ce7850d7e12030b5c22 · 飞书 · 可答

How are the different components of the model trained? Is it trained end-to-end?

| 历史原评 | 本次旧配对 | 本轮 | 相对原评变化 | 相对配对变化 |
| --- | --- | --- | --- | --- |
| yes | yes | yes | retained_success | retained_success |

| 内容 | 原始记录 |
| --- | --- |
| 历史答案 | 模型可端到端训练，无需手工特征。 [1]<br>训练时模型目标为两个过程之和，使用“teacher-forcing”算法联合训练；训练中向每个解码器输入真实摘要并最小化目标。 [2]<br>模型损失为解码损失与refine损失之和（L_model = L̂_dec + L̂_refine）。 [3]<br>两阶段结构为：One-Stage是基于BERT、带copy机制的序列到序列模型；Two-Stage在One-Stage上加入word-refine解码器；Two-Stage + RL为refine过程与RL目标配合的完整模型。 [4]<br><br>依据：<br>[1] Pretraining-Based Natural Language Generation for Text Summarization · 记忆 v1 · 当前版本原文依据（第 6 行）<br>[2] Pretraining-Based Natural Language Generation for Text Summarization · 记忆 v1 · 当前版本原文依据（第 50 行）<br>[3] Pretraining-Based Natural Language Generation for Text Summarization · 记忆 v1 · 当前版本原文依据（第 51 行）<br>[4] Pretraining-Based Natural Language Generation for Text Summarization · 记忆 v1 · 当前版本原文依据（第 61 行） |
| 本轮答案 | 该模型可端到端训练，无需手工特征。 [1]<br>训练时模型目标为两个过程之和，使用“teacher-forcing”算法联合训练；训练中向每个解码器输入真实摘要并最小化目标。 [2]<br>模型采用两阶段解码器流程，生成摘要每个词时考虑两侧上下文信息。 [3]<br>训练使用Adam优化器，学习率3e-4，β1=0.9、β2=0.999、ε=10^-9，并在训练过程中使用动态学习率。 [4]<br>训练时batch size设为36，训练4个epoch（NYT50因训练样本少得多而训练8个epoch），训练后依据开发集表现从最后10个模型中选出最佳模型。 [5]<br>因GPU内存限制，使用梯度累积，累积步数设为12，每步输入3个样本。 [6]<br>正则化使用dropout和label smoothing，dropout率0.15、label smoothing值0.1，RL目标因子γ设为0.99。 [7]<br><br>依据：<br>[1] Pretraining-Based Natural Language Generation for Text Summarization · 记忆 v1 · 当前版本原文依据（第 6 行）<br>[2] Pretraining-Based Natural Language Generation for Text Summarization · 记忆 v1 · 当前版本原文依据（第 50 行）<br>[3] Pretraining-Based Natural Language Generation for Text Summarization · 记忆 v1 · 当前版本原文依据（第 7 行）<br>[4] Pretraining-Based Natural Language Generation for Text Summarization · 记忆 v1 · 当前版本原文依据（第 53 行）<br>[5] Pretraining-Based Natural Language Generation for Text Summarization · 记忆 v1 · 当前版本原文依据（第 54 行）<br>[6] Pretraining-Based Natural Language Generation for Text Summarization · 记忆 v1 · 当前版本原文依据（第 54 行）<br>[7] Pretraining-Based Natural Language Generation for Text Summarization · 记忆 v1 · 当前版本原文依据（第 53 行） |
| 历史答案原评理由 | States end-to-end training and joint teacher-forcing training on summed loss, matching the human answers. |
| 历史答案本次匿名配对理由 | Covers end-to-end training and joint teacher-forcing training with summed loss, matching the gold answers. |
| 本轮答案理由 | Covers end-to-end training and joint teacher-forcing training with summed objective, matching the gold answers. |
| 历史记忆标签 / 理由 | yes / Memories state the model is jointly trained with teacher-forcing, objective is sum of the two processes (L_dec + L_refine), and the model can be trained end-to-end, covering both training method and end-to-end question. |
| 本轮记忆标签 / 理由 | yes / Memories state the model is jointly trained with teacher-forcing, objective is sum of the two processes (L_model = L_dec + L_refine), and the model can be trained end-to-end, matching the human answers. |
| 历史检索标签 / 理由 | yes / References include the joint teacher-forcing training objective summing the two processes and the statement that the model can be trained end-to-end, covering both parts of the question. |
| 本轮检索标签 / 理由 | yes / Same references present: joint teacher-forcing objective plus end-to-end trainability statement, sufficient to answer how components are trained and whether it is end-to-end. |

### dd76130ec5fac477123fe8880472d03fbafddef6 · 桌面 · 可答

What is the state of the art described in the paper?

| 历史原评 | 本次旧配对 | 本轮 | 相对原评变化 | 相对配对变化 |
| --- | --- | --- | --- | --- |
| yes | yes | partial | regression | regression |

| 内容 | 原始记录 |
| --- | --- |
| 历史答案 | The paper reviews the state of the art on conversational systems from three perspectives: types of interactions, types of architecture, and types of context reasoning, and consolidates them in a comparison table. [1]<br>In the reviewed state of the art, most proposed approaches for context reasoning rely on rules using logics and knowledge bases. [2]<br>The most recent state of the art for developing such systems has employed Recurrent Neural Networks (RNN), Dynamic Context-Sensitive Generation, and Memory Networks, among others. [3]<br>Sukhbaatar's work presents the state of the art of recent efforts to capture dialogue context as long-term structure within sequences using RNNs or LSTM-based models. [4]<br>Among the reviewed systems, ELIZA was one of the first software programs created to understand natural language processing, built by Joseph Weizenbaum at MIT in 1966 and known for acting like a psychotherapist. [5]<br>ELIZA was created to tackle five fundamental technical problems: identifying critical words, discovering a minimal context, choosing appropriate transformations, generating appropriate responses, and providing an ending capacity for ELIZA scripts. [6]<br>PARRY was developed by Kenneth Colby, a psychiatrist at Stanford University, in the early 1970s. [7]<br>A.L.I.C.E. appeared in 1995, and its current version uses AIML, an XML language designed for creating stimulus-response chat robots. [8]<br>Cleverbot (1997-2014) is a chatbot developed by the British AI scientist Rollo Carpenter. [9]<br>The paper states that most existing chatbots, from ELIZA to modern state-of-the-art ones, fall into this category. [10]<br>The paper notes a lack of methods and tools to design and engineer coordination and mediation among chatbots and humans, and a lack of research on building coordination laws integrated with natural language for chatbot engines. [11][12]<br>The authors state that, to the best of their knowledge, the architecture proposed in the paper is the first in the state of the art designed to support coordinated aware chatbots in a multiparty conversation. [13]<br>尚待确认：The records do not provide a complete inventory of all systems or approaches covered in the state-of-the-art review, nor the full contents of the comparison table.；完整综述所涵盖的全部系统/方法清单及比较表的完整内容未提供，仅能依据已记录的代表性条目概述。；What is the state of the art described in the paper? |
| 本轮答案 | The paper reviews the state of the art on conversational systems from three perspectives: types of interactions, types of architecture, and types of context reasoning, and consolidates them in a comparison table. [1]<br>For context reasoning, most proposed approaches in the state of the art rely on rules using logics and knowledge bases (the rule-oriented architecture). [2]<br>Three main types of architectures are identified for building conversational systems: totally rule-oriented, totally data-oriented, and a mix of rules and data-oriented. [3]<br>Most existing chatbots, from ELIZA to modern state-of-the-art ones, fall into the dyadic category. [4]<br>A dyadic chatbot does not know how to coordinate with many members in a chat group and lacks the social ability to know when it is more suitable to answer or not. [5]<br>The paper states there is a lack of methods and tools to design and engineer coordination and mediation among chatbots and humans. [6]<br>With regard to chatbot engines, there is a lack of research directed to building coordination laws integrated with natural language. [7]<br>The paper states its proposed architecture is, to the best of the authors' knowledge, the first in the state of the art designed to support coordinated aware chatbots in a multiparty conversation. [8]<br>The paper states it is not meant to advance the state of the art on the norms for MPCS. [9]<br>尚待确认：The record does not provide the full list of specific systems or approaches reviewed in the state-of-the-art section beyond the named examples (ELIZA, PARRY, A.L.I.C.E., Cleverbot).；What is the state of the art described in the paper? |
| 历史答案原评理由 | Covers the three perspectives and names ELIZA, PARRY, A.L.I.C.E., and Cleverbot, matching the human answer. |
| 历史答案本次匿名配对理由 | Names ELIZA, PARRY, A.L.I.C.E., and Cleverbot, matching the human answer's state-of-the-art systems. |
| 本轮答案理由 | Describes the three perspectives and architectures but omits the named systems ELIZA, PARRY, A.L.I.C.E., Cleverbot that the human answer lists. |
| 历史记忆标签 / 理由 | yes / Memories contain the state-of-the-art section framing (three perspectives) and the named systems ELIZA, PARRY, A.L.I.C.E., and Cleverbot, matching the human answer spans. |
| 本轮记忆标签 / 理由 | yes / Memories include the state-of-the-art framing and the named systems ELIZA, PARRY, A.L.I.C.E., and Cleverbot, matching the human answer spans. |
| 历史检索标签 / 理由 | yes / References include the section intro and full descriptions of ELIZA, PARRY, A.L.I.C.E., and Cleverbot, matching the gold answer spans. |
| 本轮检索标签 / 理由 | yes / References include the state-of-the-art section intro and full descriptions of ELIZA, PARRY, A.L.I.C.E., and Cleverbot, matching the gold answer spans. |

### dd76130ec5fac477123fe8880472d03fbafddef6 · 飞书 · 可答

What is the state of the art described in the paper?

| 历史原评 | 本次旧配对 | 本轮 | 相对原评变化 | 相对配对变化 |
| --- | --- | --- | --- | --- |
| yes | yes | yes | retained_success | retained_success |

| 内容 | 原始记录 |
| --- | --- |
| 历史答案 | 论文从交互类型、架构类型和上下文推理类型三个视角讨论对话系统的研究现状，并用一张表汇总比较。 [1]<br>ELIZA 是最早用于理解自然语言处理的软件之一，由 Joseph Weizenbaum 于 1966 年在 MIT 创建，以扮演心理治疗师著称。 [2]<br>ELIZA 旨在解决五个“基本技术问题”：识别关键词、发现最小上下文、选择适当变换、生成适当响应，以及为 ELIZA 脚本提供结束能力。 [3]<br>ELIZA 之后出现 PARRY，由斯坦福大学精神病学家 Kenneth Colby 在 1970 年代初开发。 [4]<br>A.L.I.C.E. 出现于 1995 年，其当前版本使用为创建刺激-响应聊天机器人而设计的 XML 语言 AIML。 [5]<br>Cleverbot（1997-2014）是由英国 AI 科学家 Rollo Carpenter 开发的聊天机器人。 [6]<br>在上下文推理方面，现有大多数方法依赖使用逻辑和知识库的规则。 [7]<br>近期开发此类系统的最新研究采用了循环神经网络（RNN）、动态上下文敏感生成和记忆网络等。 [8]<br>尚待确认：论文对“state of the art”的完整分类与逐项比较细节未在已记录片段中给出。；论文对state of the art按交互类型、架构类型和上下文推理类型三个视角的完整分类与逐项比较细节（汇总表内容）未给出。；What is the state of the art described in the paper?<br><br>依据：<br>[1] A Hybrid Architecture for Multi-Party Conversational Systems · 记忆 v1 · 当前版本原文依据（第 16 行）<br>[2] A Hybrid Architecture for Multi-Party Conversational Systems · 记忆 v1 · 当前版本原文依据（第 17 行）<br>[3] A Hybrid Architecture for Multi-Party Conversational Systems · 记忆 v1 · 当前版本原文依据（第 17 行）<br>[4] A Hybrid Architecture for Multi-Party Conversational Systems · 记忆 v1 · 当前版本原文依据（第 18 行）<br>[5] A Hybrid Architecture for Multi-Party Conversational Systems · 记忆 v1 · 当前版本原文依据（第 19 行）<br>[6] A Hybrid Architecture for Multi-Party Conversational Systems · 记忆 v1 · 当前版本原文依据（第 20 行）<br>[7] A Hybrid Architecture for Multi-Party Conversational Systems · 记忆 v1 · 当前版本原文依据（第 78 行）<br>[8] A Hybrid Architecture for Multi-Party Conversational Systems · 记忆 v1 · 当前版本原文依据（第 70 行） |
| 本轮答案 | 论文综述对话系统的最新技术时，从三个视角展开：交互类型、架构类型和上下文推理类型，并用一张表汇总比较。 [1]<br>ELIZA 是早期理解自然语言处理的软件之一，由 Joseph Weizenbaum 于 1966 年在 MIT 创建，以扮演心理治疗师著称，只需反射病人的陈述。 [2]<br>ELIZA 旨在解决五个“基本技术问题”：识别关键词、发现最小上下文、选择适当变换、生成适当回应（有或无关键词时），以及为 ELIZA 脚本提供结束能力。 [3]<br>PARRY 紧随 ELIZA 之后，由斯坦福大学的精神病学家 Kenneth Colby 在 1970 年代初开发。 [4]<br>该程序用 MLISP 语言在 DEC PDP-10 的 WAITS 操作系统上编写，代码不可移植，部分用 PDP-10 汇编代码、部分用 MLISP 编写。 [5]<br>A.L.I.C.E. 于 1995 年出现，当前版本使用 AIML——一种为创建刺激-反应聊天机器人而设计的 XML 语言。 [6]<br>该程序无法通过图灵测试，因为即使是普通用户也常能在简短对话中暴露其机械性。 [7]<br>Cleverbot（1997-2014）是由英国 AI 科学家 Rollo Carpenter 开发的聊天机器人。 [8]<br>它通过了 2011 年图灵测试，该测试在印度理工学院古瓦哈提分校举办的 Technique Techno-Management Festival 上举行。 [9]<br>在最新技术中，大多数上下文推理方法依赖使用逻辑和知识库的规则，如规则导向架构小节所述。 [10]<br>构建对话系统主要有三类架构：完全规则导向、完全数据导向，以及规则与数据导向的混合。 [11]<br>大多数现有聊天机器人，从最早的 ELIZA 到现代最先进的系统，都属于这一类。 [12]<br>尚待确认：论文对最新技术的综述中，除 ELIZA、PARRY、A.L.I.C.E.、Cleverbot 及三类架构外，其他具体系统或方法的名称与角色未在已确认记忆中记录。；论文综述中除 ELIZA、PARRY、A.L.I.C.E.、Cleverbot 及三类架构外，其他具体系统或方法的名称与角色未记录。；What is the state of the art described in the paper?<br><br>依据：<br>[1] A Hybrid Architecture for Multi-Party Conversational Systems · 记忆 v1 · 当前版本原文依据（第 16 行）<br>[2] A Hybrid Architecture for Multi-Party Conversational Systems · 记忆 v1 · 当前版本原文依据（第 17 行）<br>[3] A Hybrid Architecture for Multi-Party Conversational Systems · 记忆 v1 · 当前版本原文依据（第 17 行）<br>[4] A Hybrid Architecture for Multi-Party Conversational Systems · 记忆 v1 · 当前版本原文依据（第 18 行）<br>[5] A Hybrid Architecture for Multi-Party Conversational Systems · 记忆 v1 · 当前版本原文依据（第 18 行）<br>[6] A Hybrid Architecture for Multi-Party Conversational Systems · 记忆 v1 · 当前版本原文依据（第 19 行）<br>[7] A Hybrid Architecture for Multi-Party Conversational Systems · 记忆 v1 · 当前版本原文依据（第 19 行）<br>[8] A Hybrid Architecture for Multi-Party Conversational Systems · 记忆 v1 · 当前版本原文依据（第 20 行）<br>[9] A Hybrid Architecture for Multi-Party Conversational Systems · 记忆 v1 · 当前版本原文依据（第 20 行）<br>[10] A Hybrid Architecture for Multi-Party Conversational Systems · 记忆 v1 · 当前版本原文依据（第 78 行）<br>[11] A Hybrid Architecture for Multi-Party Conversational Systems · 记忆 v1 · 当前版本原文依据（第 42 行）<br>[12] A Hybrid Architecture for Multi-Party Conversational Systems · 记忆 v1 · 当前版本原文依据（第 24 行） |
| 历史答案原评理由 | States the three perspectives and names ELIZA, PARRY, A.L.I.C.E., and Cleverbot, matching the human answer. |
| 历史答案本次匿名配对理由 | Covers the same four systems (ELIZA, PARRY, A.L.I.C.E., Cleverbot) as the human answer. |
| 本轮答案理由 | Includes ELIZA, PARRY, A.L.I.C.E., and Cleverbot, matching the human answer's systems. |
| 历史记忆标签 / 理由 | yes / Memories contain the state-of-the-art section framing (three perspectives) and the named systems ELIZA, PARRY, A.L.I.C.E., and Cleverbot, matching the human answer spans. |
| 本轮记忆标签 / 理由 | yes / Memories include the state-of-the-art framing and the named systems ELIZA, PARRY, A.L.I.C.E., and Cleverbot, matching the human answer spans. |
| 历史检索标签 / 理由 | yes / Same references cover the state-of-the-art conversational systems (ELIZA, PARRY, A.L.I.C.E., Cleverbot) needed for the gold answer. |
| 本轮检索标签 / 理由 | yes / Same references cover the state-of-the-art section and all four systems (ELIZA, PARRY, A.L.I.C.E., Cleverbot) needed for the gold answer. |

## 审计文件

机器指标：[memory-qa-reliability-metrics.json](memory-qa-reliability-metrics.json)。
当前原始报告：docs\memory-public-live-qa-reliability-dev-results.json；历史原始报告：docs\memory-public-live-qa-structured-dev-v3-results.json。
完整性校验：docs\memory-public-live-qa-reliability-dev-integrity.json；通过=true。
本轮预算：已由独立可靠性登记校验；明细见 metrics。
