# 争议题证据审查（agent review）

本报告由 Codex agent 阅读本地原文、原始人工标注和现有答案后整理，不是人工复核，不构成独立人工金标。未调用模型 API。五题为看过结果后选定的开发题，不是盲测。

历史自动分数、20题分母和929条正式记忆均不修改；这里不计算“纠正后正确率”，也不实际剔除任何题。

| 题目 | 桌面原自动分 | 飞书原自动分 | agent review 结论 | 未来无歧义子集建议 |
| --- | --- | --- | --- | --- |
| 521280a8 标注人数与阶段范围 | partial | partial | annotation_phase_ambiguity | 歧义单列，暂不纳入严格无歧义子集 |
| 5a8cc8f8 宽泛概念与操作性定义 | no | no | gold_question_scope_mismatch | 歧义单列，暂不纳入严格无歧义子集 |
| 747b847d 全部实验语料与平行语料 | yes | partial | narrow_question_broad_gold | 保留并预先说明范围/推理规则 |
| 10fb7dc0 GlossBERT机制与相关工作的目标错位 | yes | partial | unspecified_model_and_gold_target_mismatch | 歧义单列，暂不纳入严格无歧义子集 |
| b08f88d1 独立解码器到不共享权重的结构推断 | yes | no | architectural_inference_required | 保留并预先说明范围/推理规则 |

## 521280a87c43fcdf9f577da235e7072a23f0673e · 标注人数与阶段范围

论文：Predicting the Type and Target of Offensive Posts in Social Media（1902.09666）

问题：How many annotators participated?

原始人工答案（未修改）：

- five annotators

人工证据段落：1902.09666:s6:p0

原文与定位（以下均为精确摘录；JSON 保留完整段落、UTF-16 偏移、哈希和冻结 source 引用）：

**1902.09666:s6:p0 · Data Collection · 人工gold段落**

引用：source:8409a569-0324-46d0-bffd-9d47b7137952:825727d6-ee14-43bf-a9c7-a03cfc481d1a；段落正文 SHA256：76666945857efb980e2c21f399e949f1225e1610c1a9ae6c382cfc051829edbf

> We carried out a first round of trial annotation of 300 instances with six experts.

> We computed Fliess' INLINEFORM0 on the trial set for the five annotators on 21 of the tweets.

> Each instance in the dataset was annotated by multiple annotators and inter-annotator agreement has been calculated.

> We first acquired two annotations for each instance. In case of 100% agreement, we considered these as acceptable annotations, and in case of disagreement, we requested more annotations until the agreement was above 66%.

agent review：

人工答案只取一致性统计语境中的 five annotators。同一原段落也明确说首次300条试标注由six experts进行，随后还有众包。题干没有指定阶段；这不证明论文自相矛盾，五人可能是特定统计子集，不能擅自推断六人/五人身份或全部参与总数。

可接受的回答范围：

- 若按人工gold定位：说明五名标注者参与21条推文的Fleiss统计。
- 若解释整项标注工作：同时区分首次试标注六名专家、统计五名标注者，以及未给总人数的众包；不要把六与五相加，也不要把两条标注等同于两名固定参与者。

不可支持的扩大解释：

- 无范围地将五或六宣称为整个项目全部标注者总数。
- 声称已有证据证明六人与五人的人员关系。

**桌面现有答案；原自动分 partial，保持不变**

在试验集上，对21条推文计算Fleiss' kappa时涉及五名标注者。 [1][2]  
试验标注阶段由六名专家对300条实例进行了第一轮标注。 [2]  
正式数据集通过众包（Figure Eight平台）标注，每个实例先获得两条标注；若不一致则继续请求更多标注，直到一致率高于66%。 [2]  
尚待确认：众包标注阶段实际参与标注者的总人数未记录。；How many annotators participated?

原自动理由：Mentions five annotators but adds six experts and crowdsourcing details; the gold answer is simply five annotators.

agent assessment：已明确给出gold的五人及其21条推文统计范围，也正确区分六名专家和众包；自动partial主要惩罚额外范围与unknown，不能据此断言缺少答案事实。回答可更简洁，不应重复原题。

**飞书现有答案；原自动分 partial，保持不变**

数据收集阶段进行了第一轮试验标注，由六名专家标注300条实例。 [1]  
尚待确认：正式众包标注阶段参与标注者的总人数未记录。；How many annotators participated?  
  
依据：  
[1] Predicting the Type and Target of Offensive Posts in Social Media · 导入原文（非正式记忆）（第 23 行）（第 23 行）

原自动理由：Gives six experts for trial annotation instead of the gold five annotators, so the key number is wrong/incomplete.

agent assessment：六名专家这个事实有来源，但只选首次试标注范围，遗漏gold期望的五人统计范围；属于问题范围选择不足，不是所答六人事实凭空捏造。

处理建议：

保留原20题历史分母与分数；未来预先标为阶段歧义题并单列，或把问题明确改为21条推文一致性统计的标注人数。新问题必须有新ID。

原文对照解释：

gold_union已包含六人、五人及众包全部事实；即使直接给gold段落也不能消除原题的阶段歧义。

gold_union：1902.09666:s6:p0

agent_review_context：1902.09666:s6:p0

## 5a8cc8f80509ea77d8213ed28c5ead501c68c725 · 宽泛概念与操作性定义

论文：Predicting the Type and Target of Offensive Posts in Social Media（1902.09666）

问题：What is the definition of offensive language?

原始人工答案（未修改）：

-  Most prior work focuses on a different aspect of offensive language such as abusive language BIBREF0 , BIBREF1 , (cyber-)aggression BIBREF2 , (cyber-)bullying BIBREF3 , BIBREF4 , toxic comments INLINEFORM0 , hate speech BIBREF5 , BIBREF6 , BIBREF7 , BIBREF8 , BIBREF9 , BIBREF10 , and offensive language BIBREF11 . Prior work has focused on these aspects of offensive language in Twitter BIBREF3 , BIBREF7 , BIBREF8 , BIBREF11 , Wikipedia comments, and Facebook posts BIBREF2 .

人工证据段落：1902.09666:s0:p0

原文与定位（以下均为精确摘录；JSON 保留完整段落、UTF-16 偏移、哈希和冻结 source 引用）：

**1902.09666:s0:p0 · Introduction · 人工gold段落**

引用：source:8409a569-0324-46d0-bffd-9d47b7137952:4c5f116f-d5bd-44f2-aa2a-4f13a9af6628；段落正文 SHA256：59c58a623f006d69a957da9a3ea25c0aac83e3c38d0899685f812b230b96f48f

> Most prior work focuses on a different aspect of offensive language such as abusive language BIBREF0 , BIBREF1 , (cyber-)aggression BIBREF2 , (cyber-)bullying BIBREF3 , BIBREF4 , toxic comments INLINEFORM0 , hate speech BIBREF5 , BIBREF6 , BIBREF7 , BIBREF8 , BIBREF9 , BIBREF10 , and offensive language BIBREF11 .

**1902.09666:s3:p3 · Level A: Offensive language Detection · 消歧补充原文**

引用：source:8409a569-0324-46d0-bffd-9d47b7137952:bfcb4271-e131-4566-829a-aae00871c19e；段落正文 SHA256：9887fc28e5449d1a3fad154bb22bcb5c30ab384fd56f0ed87591ff64df3827ca

> Offensive (OFF): We label a post as offensive if it contains any form of non-acceptable language (profanity) or a targeted offense, which can be veiled or direct. This category includes insults, threats, and posts containing profane language or swear words.

agent review：

gold抽取的是引言对既有研究所涉辱骂、攻击、霸凌、有毒评论、仇恨言论等方面的列举；正文另有明确标题为Offensive (OFF)的标注定义。题干只问definition，没有限定必须回答引言的相关工作。两个入口都准确限定“OLID标注”，属于有来源且切题的一种解释；将其判no有gold范围不匹配的证据。

可接受的回答范围：

- 以OLID操作性定义回答：不可接受语言/脏话或隐晦、直接的针对性冒犯，包括侮辱、威胁和粗口。
- 若同时概述引言：说明论文把辱骂、攻击、霸凌、有毒评论和仇恨言论等作为相关研究方面，不把这些方面说成互斥标签或正式穷尽定义。
- 最稳妥是区分“引言广义相关方面”与“本文OFF标注定义”。

不可支持的扩大解释：

- 将intro列举误称为论文的完整正式分类体系。
- 把论文明确给出的OFF定义判成没有原文依据。

**桌面现有答案；原自动分 no，保持不变**

在 OLID 数据集中，一条帖子若包含任何形式的不可接受语言（脏话）或带有针对性的冒犯（可以是隐晦或直接的），就被标注为冒犯性（OFF）。 [1]  
该冒犯性类别包括侮辱、威胁以及含有脏话或粗口的帖子。 [1]

原自动理由：Provides OLID labeling definition rather than the paper's introduction-level description of offensive language; does not match human evidence.

agent assessment：答案与OFF原段落一致且明确限定OLID，不能把历史no解读成编造或记忆缺失；缺少intro枚举仅是与gold所选范围不同。

**飞书现有答案；原自动分 no，保持不变**

在OLID的标注中，Offensive（OFF）指帖子含有任何形式的不可接受语言（脏话）或带有针对性的冒犯（可为隐晦或直接）；该类别包括侮辱、威胁以及含脏话或粗口的帖子。 [1][2]  
与之相对，Not Offensive（NOT）指不含冒犯或脏话的帖子。 [3]  
  
依据：  
[1] Predicting the Type and Target of Offensive Posts in Social Media · 记忆 v1 · 当前版本原文依据（第 15 行）  
[2] Predicting the Type and Target of Offensive Posts in Social Media · 导入原文（非正式记忆）（第 15 行）（第 15 行）  
[3] Predicting the Type and Target of Offensive Posts in Social Media · 记忆 v1 · 当前版本原文依据（第 14 行）

原自动理由：Same OLID definition plus NOT contrast; still not the introduction's broad characterization of offensive language.

agent assessment：同样给出有来源的OFF定义，并补充NOT对照；是否需要intro枚举取决于预先确定的题目范围。

处理建议：

历史分数不改；未来严格无歧义正确率应暂不纳入本题，保留为范围消歧诊断。可分别定义“本文OFF标注定义”和“引言列举哪些冒犯性研究方面”的新题。

原文对照解释：

gold_union只含引言，容易奖励照抄相关工作而非正式定义。agent_review_context必须同时保留intro与OFF定义并明确该选择不是人工gold。

gold_union：1902.09666:s0:p0

agent_review_context：1902.09666:s0:p0, 1902.09666:s3:p3

## 747b847d687f703cc20a87877c5b138f26ff137d · 全部实验语料与平行语料

论文：A Bayesian Model of Multilingual Unsupervised Semantic Role Induction（1603.01514）

问题：Which parallel corpora are used?

原始人工答案（未修改）：

- English (EN) and German (DE) sections of the CoNLL 2009 corpus BIBREF13 / EN-DE section of the Europarl corpus BIBREF14
- the English (EN) and German (DE) sections of the CoNLL 2009 corpus BIBREF13 , and EN-DE section of the Europarl corpus BIBREF14 

人工证据段落：1603.01514:s8:p0

原文与定位（以下均为精确摘录；JSON 保留完整段落、UTF-16 偏移、哈希和冻结 source 引用）：

**1603.01514:s8:p0 · Data · 人工gold段落**

引用：source:f77eab74-a2c6-488c-8db3-e82073df8b78:b7753349-dc33-4de6-8d42-0f8cda9a463b；段落正文 SHA256：c39f98aeec7ee06b54959f6a541295d7bc53c2a30281c42afac3e434618d7300

> Following titovcrosslingual, we run our experiments on the English (EN) and German (DE) sections of the CoNLL 2009 corpus BIBREF13 , and EN-DE section of the Europarl corpus BIBREF14 .

> We get about 40k EN and 36k DE sentences from the CoNLL 2009 training set, and about 1.5M parallel EN-DE sentences from Europarl.

> The word alignments for the EN-DE parallel Europarl corpus are computed using GIZA++ BIBREF17 .

**1603.01514:s9:p1 · Main Results · 消歧补充原文**

引用：source:f77eab74-a2c6-488c-8db3-e82073df8b78:26324fc6-c046-4abc-a1db-2327858857ff；段落正文 SHA256：a0fb4b4616dc87e5cb88450f6f5355e6b230178c309a19b37bf7799ed5cd7e70

> In the first setting (Line 1), we train and test the monolingual model on the CoNLL data.

agent review：

两个独立人工答案均列CoNLL 2009 EN/DE与Europarl EN-DE，按gold完整性必须给出两者。但原文明确称约150万Europarl EN-DE句子为parallel，并将CoNLL用于单语模型；题干“parallel corpora”比gold的“实验用语料”窄。只答Europarl在字面范围下有根据，不能把这简化为纯事实错误或纯检索失败。

可接受的回答范围：

- 基准兼容且语义清晰：实验用了CoNLL 2009英语/德语部分和Europarl EN-DE；其中明确的英德平行语料是Europarl。
- 若严格只答平行句来源，可答Europarl EN-DE，但应指出CoNLL也是实验用语料，以避免与题目可能意图冲突。

不可支持的扩大解释：

- 未经依据将CoNLL英德部分声称为相互句对齐的平行翻译语料。
- 在要求“全部实验语料”的明确问题中只列Europarl。

**桌面现有答案；原自动分 yes，保持不变**

实验使用 CoNLL 2009 语料的英语（EN）和德语（DE）部分，以及 Europarl 语料的 EN-DE 部分。 [1][2]  
其中平行语料是 Europarl 的 EN-DE 部分，约 150 万句平行英德句子。 [1][3]

原自动理由：Correctly names CoNLL 2009 EN/DE sections and Europarl EN-DE section.

agent assessment：同时列两语料并区分真正明确的平行部分，既覆盖gold又避免把CoNLL说成平行翻译语料，范围处理充分。

**飞书现有答案；原自动分 partial，保持不变**

实验使用 Europarl 语料的 EN-DE 部分作为平行语料。 [1][2]  
从 Europarl 获取约 150 万条 EN-DE 平行句。 [3][2]  
EN-DE 平行 Europarl 语料的词对齐用 GIZA++ 计算，并只保留双向交集对齐以提高精度。 [4][2]  
  
依据：  
[1] A Bayesian Model of Multilingual Unsupervised Semantic Role Induction · 记忆 v1 · 当前版本原文依据（第 34 行）  
[2] A Bayesian Model of Multilingual Unsupervised Semantic Role Induction · 导入原文（非正式记忆）（第 34 行）（第 34 行）  
[3] A Bayesian Model of Multilingual Unsupervised Semantic Role Induction · 记忆 v1 · 当前版本原文依据（第 34 行）  
[4] A Bayesian Model of Multilingual Unsupervised Semantic Role Induction · 记忆 v1 · 当前版本原文依据（第 34 行）

原自动理由：Correctly identifies Europarl EN-DE but omits CoNLL 2009 EN/DE corpus.

agent assessment：输出Europarl、数量与对齐方式都有来源；按gold漏CoNLL，但按题干的parallel限定可辩护。其参考已含两者，因此改善方向是范围说明与完整列举，不是只增召回。

处理建议：

历史partial不改；未来保留并标记措辞歧义，预先接受“列两者并说明Europarl为平行部分”。若要无歧义测试全集覆盖，另建“实验使用哪些语料及各自用途”的新题。

原文对照解释：

gold_union的完整Data段落本身已足够同时给出二语料和其区别；补充单语CoNLL段落仅用于消歧审查，不应暗改gold。

gold_union：1603.01514:s8:p0

agent_review_context：1603.01514:s8:p0, 1603.01514:s9:p1

## 10fb7dc031075946153baf0a0599e126de29e3a4 · GlossBERT机制与相关工作的目标错位

论文：GlossBERT: BERT for Word Sense Disambiguation with Gloss Knowledge（1908.07245）

问题：How does the neural network architecture accomodate an unknown amount of senses per word?

原始人工答案（未修改）：

- converts WSD to a sequence learning task /  leverage gloss knowledge / by extending gloss knowledge

人工证据段落：1908.07245:s16:p4

原文与定位（以下均为精确摘录；JSON 保留完整段落、UTF-16 偏移、哈希和冻结 source 引用）：

**1908.07245:s16:p4 · Experiments ::: Results · 人工gold段落**

引用：source:55a90925-b81f-4148-9d51-243dbb5273e4:d28436f7-a2ad-4fff-8c64-1e4fe0d4b417；段落正文 SHA256：60b84f8df7c6af865d3412be035eb664e63c9f426f1955e75f0fe437f0855ca0

> The fourth block shows several recent neural-based methods.

> which converts WSD to a sequence learning task.

> GAS$_{ext}$ BIBREF12 is a variant of GAS which is a gloss-augmented variant of the memory network by extending gloss knowledge.

> CAN$^s$ and HCAN BIBREF13 are sentence-level and hierarchical co-attention neural network models which leverage gloss knowledge.

**1908.07245:s5:p0 · Methodology ::: GlossBERT · 消歧补充原文**

引用：source:55a90925-b81f-4148-9d51-243dbb5273e4:d5697473-b601-4526-a5f0-93970bb30f4f；段落正文 SHA256：be52c05bb6778f1f91711b7052165f5ce8e95b500f5eccb6fcc0f4b7cd0f317f

> we propose GlossBERT to construct context-gloss pairs from all possible senses of the target word in WordNet, thus treating WSD task as a sentence-pair classification problem.

**1908.07245:s6:p0 · Methodology ::: GlossBERT ::: Context-Gloss Pairs · 消歧补充原文**

引用：source:55a90925-b81f-4148-9d51-243dbb5273e4:dfadc7f4-ecb8-468b-be1a-f0349812e1ba；段落正文 SHA256：2009411d59ddaaf5f0426e1cf88d84c1901e88d73b860091455f68d9c16de32f

> For each target word, we extract glosses of all $N$ possible senses (here $N=4$) of the target word (research) in WordNet to obtain the gloss sentence.

**1908.07245:s7:p1 · Methodology ::: GlossBERT ::: Context-Gloss Pairs with Weak Supervision · 消歧补充原文**

引用：source:55a90925-b81f-4148-9d51-243dbb5273e4:d59306f7-3e04-49d5-8e3a-5b6044cf66a0；段落正文 SHA256：12d2023ff001dfcf40d2810f2c5a151d6382610aa7701d9575263c2183441bc3

> When testing, we output the probability of $label=yes$ of each context-gloss pair and choose the sense corresponding to the highest probability as the prediction label of the target word.

**1908.07245:s17:p0 · Experiments ::: Discussion · 消歧补充原文**

引用：source:55a90925-b81f-4148-9d51-243dbb5273e4:125d9fea-210f-41d2-b692-7098b482a56e；段落正文 SHA256：7ce2132b582df96af9285f8b6390756dd30450d4ec7e8bc8a9e5884aac21d4a4

> First, we construct context-gloss pairs and convert WSD problem to a sentence-pair classification task which is similar to NLI tasks and train only one classifier, which is equivalent to expanding the corpus.

**1908.07245:s17:p1 · Experiments ::: Discussion · 消歧补充原文**

引用：source:55a90925-b81f-4148-9d51-243dbb5273e4:ff2aeb65-abca-4ba3-838f-7849f4c810d8；段落正文 SHA256：79fefefd645edc0db3e927c72b9d03b336bdd53c9f30df91b6a099c0c7c7b702

> does not require training a dedicated classifier for every target lemma.

agent review：

人工gold位于Results对Bi-LSTM多任务、GAS_ext、CAN/HCAN等已有工作的比较，三段extractive spans属于不同方法；它不是对本文GlossBERT如何支持可变候选义项数的直接说明。题干未指明哪种network。本文方法段落提供N个context-gloss对、一个分类器、每对yes概率及取最大义项。由此说明候选数变化改变处理的对数而非固定义项类别输出，是有原文支持的组合推理；“未知”不能扩大为无WordNet候选集或零样本识别全新义项。

可接受的回答范围：

- 若指GlossBERT：从WordNet全部N个候选义项构造N个context-gloss对，用单个二分类器分别评分，选择yes概率最高者；明确变的是候选对数，说明这是从流程推得。
- 若指gold中的先前神经方法：按名称分别说明序列学习、扩展gloss的记忆网络和co-attention利用gloss；不能合并为一个网络机制。
- 允许先指出题干未指定网络，再区分本文方法与相关工作。

不可支持的扩大解释：

- 把gold三段不同baseline的性质合成GlossBERT的架构。
- 宣称模型无需枚举候选义项、能直接识别任意未知词义，或虚构padding/固定最大义项槽位。

**桌面现有答案；原自动分 yes，保持不变**

GlossBERT 将 WSD 视为句对分类问题：它从目标词在 WordNet 中的所有可能义项的释义（gloss）出发，构造 context-gloss 对。 [1][2]  
对每个目标词，系统提取其全部 N 个可能义项的释义（文中示例 N=4）以得到 gloss 句子。 [3][4]  
在 context-gloss 对中加入 [CLS] 和 [SEP] 标记，使其适合作为 BERT 模型的输入。 [3][5]  
所用 BERT 架构是多层双向 Transformer 编码器，并在 WSD 任务上对预训练 BERT 进行微调。 [6]  
由于每个义项分别与上下文组成一个句对，义项数量可变时输入的是逐义项构造的句对集合，而非固定数量的义项槽位。 [1][3]  
GlossBERT 将 WSD 视为句对分类问题：它从目标词在 WordNet 中的所有可能义项的释义（gloss）出发，构造 context-gloss 对。 [2][7]  
对每个目标词，系统提取其全部 N 个可能义项的释义（文中示例 N=4）以得到 gloss 句子。 [4][3]  
在 context-gloss 对中加入 [CLS] 和 [SEP] 标记，使其适合作为 BERT 模型的输入。 [5][3]  
所用 BERT 架构是多层双向 Transformer 编码器，并在 WSD 任务上对预训练 BERT 进行微调。 [8][9]  
由于每个义项分别与上下文组成一个句对，义项数量可变时输入的是逐义项构造的句对集合，而非固定数量的义项槽位。 [2][10]  
测试时，系统输出每个 context-gloss 对 label=yes 的概率，并选择概率最高的义项作为目标词的预测标签。 [11]

原自动理由：Correctly explains that each sense forms its own context-gloss pair, so variable sense counts become a set of pairs rather than fixed slots.

agent assessment：已补出逐义项句对集合而非固定槽位的推理，且有N对、句对分类及最高概率原文支持；重复两个生成内容影响简洁性，不改变该核心机制有据。

**飞书现有答案；原自动分 partial，保持不变**

GlossBERT 将 WSD 任务转化为句对分类问题：从目标词在 WordNet 中所有可能词义的释义（gloss）构造 context-gloss 对。 [1][2]  
对每个目标词，抽取其在 WordNet 中全部 N 个可能词义的释义（文中示例 N=4）以得到 gloss 句子。 [3][4]  
在 context-gloss 对中加入 [CLS] 和 [SEP] 标记，使其适合作为 BERT 模型的输入。 [5][4]  
方法对预训练 BERT 模型在 WSD 任务上进行微调。 [6][2]  
GlossBERT 将 WSD 转化为句对分类问题：从目标词在 WordNet 中所有可能词义的释义构造 context-gloss 对。 [7][1]  
对每个目标词，抽取其在 WordNet 中全部 N 个可能词义的释义（示例中 N=4）得到 gloss 句子，因此每个目标词有 N 个 context-gloss 对训练实例（标签为 yes/no）。 [3][8]  
在 context-gloss 对中加入 [CLS] 和 [SEP] 标记，使其适合作为 BERT 模型的输入。 [5]  
模型取首个 token [CLS] 的最终隐状态并加分类层（标签为 yes/no）进行句对分类。 [9]  
测试时，对每个 context-gloss 对输出 label=yes 的概率，并选择概率最高的词义作为该目标词的预测标签。 [10]  
  
依据：  
[1] GlossBERT: BERT for Word Sense Disambiguation with Gloss Knowledge · 记忆 v1 · 当前版本原文依据（第 6 行）  
[2] GlossBERT: BERT for Word Sense Disambiguation with Gloss Knowledge · 导入原文（非正式记忆）（第 6 行）（第 6 行）  
[3] GlossBERT: BERT for Word Sense Disambiguation with Gloss Knowledge · 记忆 v1 · 当前版本原文依据（第 15 行）  
[4] GlossBERT: BERT for Word Sense Disambiguation with Gloss Knowledge · 导入原文（非正式记忆）（第 15 行）（第 15 行）  
[5] GlossBERT: BERT for Word Sense Disambiguation with Gloss Knowledge · 记忆 v1 · 当前版本原文依据（第 15 行）  
[6] GlossBERT: BERT for Word Sense Disambiguation with Gloss Knowledge · 记忆 v1 · 当前版本原文依据（第 11 行）  
[7] GlossBERT: BERT for Word Sense Disambiguation with Gloss Knowledge · 记忆 v1 · 当前版本原文依据（第 13 行）  
[8] GlossBERT: BERT for Word Sense Disambiguation with Gloss Knowledge · 记忆 v1 · 当前版本原文依据（第 17 行）  
[9] GlossBERT: BERT for Word Sense Disambiguation with Gloss Knowledge · 记忆 v1 · 当前版本原文依据（第 20 行）  
[10] GlossBERT: BERT for Word Sense Disambiguation with Gloss Knowledge · 记忆 v1 · 当前版本原文依据（第 17 行）

原自动理由：Covers per-sense context-gloss pairs and N instances but does not explicitly state how variable sense counts are accommodated.

agent assessment：已给N个句对、二分类、最高概率选择，事实基本覆盖本文方法；缺少一句明确连接“候选数可变→处理对数可变”的总结。历史partial可描述显式解释不足，但不等于关键方法证据丢失。

处理建议：

历史分数不改；未来无歧义严格正确率暂不纳入原题，将本文GlossBERT机制与相关工作分别建立清楚指向的新题。原题保留作目标识别/组合推理诊断。

原文对照解释：

仅gold_union只能保证看见已有工作段落，不能把它当本文机制的正确证据上界。agent_review_context需保留gold并加入本文N对、选择与单分类器段落；结果应单列，不能与gold-only混算。

gold_union：1908.07245:s16:p4

agent_review_context：1908.07245:s5:p0, 1908.07245:s6:p0, 1908.07245:s7:p1, 1908.07245:s16:p4, 1908.07245:s17:p0, 1908.07245:s17:p1

## b08f88d1facefceb87e134ba2c1fa90035018e83 · 独立解码器到不共享权重的结构推断

论文：Contextualize, Show and Tell: A Neural Visual Storyteller（1806.00738）

问题：Do the decoder LSTMs all have the same weights?

原始人工答案（未修改）：

- false
- false

人工证据段落：1806.00738:s4:p1

原文与定位（以下均为精确摘录；JSON 保留完整段落、UTF-16 偏移、哈希和冻结 source 引用）：

**1806.00738:s4:p1 · Decoder · 人工gold段落**

引用：source:0056b867-8122-4004-bc43-25fd67204dda:99a5dba5-48ff-48dd-9e38-78acdc8b7b29；段落正文 SHA256：5e0e88517e76dd64de6e01b1f28ed0b19523d69948993cc6b35db0818033c1fd

> Our model contains five independent decoders, one for each image in the sequence.

> All the 5 decoders use the last hidden state of the encoder (i.e. the context) as its first hidden state and take the corresponding image embedding as its first input.

> This allows each decoder to learn a specific language model for each position of the sequence.

**1806.00738:s7:p0 · Conclusions and Future Work · 消歧补充原文**

引用：source:0056b867-8122-4004-bc43-25fd67204dda:21f3eabb-4486-4b12-a466-7200557be9ea；段落正文 SHA256：b616125b48a6cf0e9ffd4d0a78605292b5eb9eb8eb7b9963ef39190c30a0bc5a

> Having an independent decoder for each position of the image sequence, allowed our visual storyteller to build more specific language models using the context vector as its first state and the image embedding as its first input.

agent review：

两个人工答案均为No。gold段落描述五个independent decoders及各自位置特定语言模型，支持通常的架构理解：解码器并非权重绑定的同一模型。段落没有直接写weight sharing，且“共享encoder上下文作初始隐状态”不等于共享参数；不能将缺少weights字面词机械视为完全不可答。这是结构推断题，不是纯逐字抽取题，也不能由自然语言段落证明每一张量绝不共享。

可接受的回答范围：

- 回答No，并说明依据是五个独立、位置特定的解码器；注明这是架构描述所支持的推断，而不是论文逐字声明所有参数细节。
- 可补充所有解码器共享encoder上下文初始化，但不要把共同输入/初始化误当参数共享。

不可支持的扩大解释：

- 因为都使用encoder最后隐状态而回答权重相同。
- 无依据声称所有embedding、所有层参数或训练初始化的具体共享细节。

**桌面现有答案；原自动分 yes，保持不变**

No. The model contains five independent decoders, one for each image in the sequence, and each decoder learns a specific language model for its position. [1]  
The decoders are described as independent and position-specific rather than as sharing weights; the record does not state that they share weights. [1][2]

原自动理由：Correctly answers No, citing five independent decoders each learning a position-specific language model, matching the gold passage.

agent assessment：No与人工gold一致，引用独立且位置特定的解码器并说明并非直接共享权重声明；是有据的结构推断。

**飞书现有答案；原自动分 no，保持不变**

项目记忆中没有足够依据，暂不自动回复。

原自动理由：Refuses/abstains despite the question being answerable; not a correct answer.

agent assessment：最终拒答体现保守门槛，未利用independent decoders与位置特定模型作有限推断；可判未完成可答任务，但不能据此说数据库没有存下原句。

处理建议：

保留该题并预先标注允许有据结构推断；区分参数与状态。无需仅因没有weights字面句就剔除。

原文对照解释：

gold_union已含独立/位置特定描述；oracle仍需推理，不能要求所有正确答案必须原文逐字同义。

gold_union：1806.00738:s4:p1

agent_review_context：1806.00738:s4:p1, 1806.00738:s7:p0

## 原文对照如何本地构造

`docs/memory-public-dataset-manifest.json` 绑定 fixture 与原始 validation 文件 SHA。fixture 每题的 `acceptableEvidenceSets.flat(2)` 得到原人工段落ID并集，按 `doc.paragraphs` 原顺序读取完整 `content`。原始 `.local-data/open-benchmarks/qasper-dev-v0.3.json` 的 `qas[].answers[].answer.evidence` 可交叉验证，五题已逐项校验。

gold_union 只表示人工标注所选段落。agent_review_context 是本 agent 为范围消歧预先列出的原文集合，不能冒充原人工金标，不能把本报告解释、建议答案或评分送入生成上下文。两种对照需分开报告。

生产 source_passage 须按 paragraphId 映射冻结 paper.segments，使用完整 segment.text（含 [[QASPER:...]] 和末尾换行），保持 source/project/segment/hash 真实。直接以纯正文构造独立阅读输入可以，但不能伪装成字节相同的已有 source 引用。

同题 oracle 仍失败，不能直接推断模型能力到顶；可能仍有题意、提示、审查策略或评分差异。oracle 成功也不单独证明纯召回缺陷，因为证据数量、噪声和布局同时可能变化。历史分数与未来对照分开，不用剔除争议题追溯提高旧成绩。

## 来源与完整性

- manifest: docs/memory-public-dataset-manifest.json；SHA256 3c4b365b3407dc42a7dc0038d7e1cf1b09ad9f17c7025886f8d05d2d6885ff5d
- fixture: .local-data\open-benchmarks\qasper-memory-v1.json；SHA256 803537c32e89dce765c8e6cef6484f332d6ef5a9c91b726a4ea957e68b461d87
- originalQasperValidation: .local-data/open-benchmarks/qasper-dev-v0.3.json；SHA256 2ae7ee62a65b1c4225791c70de80c2aad4e8998cf1fd4f09a53103db4f21af93
- architectureV2Metrics: docs/memory-architecture-dev-v2-metrics.json；SHA256 8f7d0a075b607fc02450435d92d0eaf58cddfca953509cc2c0923ae4ad131c23
- architectureV2AuditedReport: docs\memory-architecture-dev-v2-audited-results.json；SHA256 7be6f419796585e2dd182a2f612699859edc780db8a59777df2e5ab92a8ad77e

QASPER v0.3 validation；Dasigi et al. (2021), A Dataset of Information-Seeking Questions and Answers Anchored in Research Papers.；CC-BY-4.0。精确原文保留数据集标记与原有拼写。
