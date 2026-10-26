# QA校准轮：格式与事后诊断边界

本轮不修改答案、记忆、检索三个隔离评分器的 prompt、gold、标签或匿名映射。所有实际生产尝试、原始请求、原始响应和provider用量保留。

生产仍使用精确编号引用及当前正文span；沿用既有捕获投影与producer真实generation选择。审查trace按检索轮记录，实际generation按真实网络调用记录；本地结构化首轮可能没有generation。报告以真实receipt和rewrite轮次关联审查，不能直接把generation索引当review索引。

本轮review保留`supported`、`answersQuestion`、`completeAnswer`、`unsupportedClaims`、`missingAspects`、`reason`，新增：

- `obligations`: 每项包含`target`、`status: answered|partial|missing`、1起始的`claimIndices`。
- `unknownDecisions`: 每项包含1起始的`unknownIndex`、`disposition: retain|unasked|answered`及`claimIndices`；每个原始未知项须恰有一项处置。

`completeAnswer`须与逐目标状态、retain和missingAspects一致；处置逐条应用，不能无条件全清未知项。审查版本为`claim-support-v6-obligation-unknowns`，流程版本为`bounded-question-flow-v4-obligation-review`，`unknownReviewMode=individual-obligation-decisions`。对象歧义的scopeCandidates只作导航、不作为断言证据；真正的回答和支持仍来自当前引用正文。

`unknownIndex`严格指向该次真实review请求的unknowns数组；正常保持该轮generation原始unknowns顺序，legacy `reviewUnknowns`存在时优先。应用后按retain的原顺序保留，再追加不同的missingAspects，因此不能用最终unknowns索引解释原decision。

报告仅对上述保存字段做事后计数，保留原始unknowns、逐条处置、实际选中的generation、对应review轮与收据。旧schema未包含逐条字段时记为未提供，不推造处置标签。最终unknowns可能合并missingAspects，不以数组长度差作为逐项语义解决的依据。此适配不改任何评分事实、答案内容或评分标签，不给生产输入gold。

旧qa-efficient工件、gate、注册和快照不改。共用tag路由新增qa-calibrated分支，故当前共享文件SHA可与旧轮不同；旧轮继续按旧快照校验，新轮保存完整独立manifest和SHA。没有网络重试或择优重跑；沿用既有显式一次评分JSON/schema失败修复规则，所有失败工件与费用必须保留。

## 首次调用前的测量完整性修复

只读代码复核发现，review的JSON/schema失败会安全转为unknown或回退已核验partial，并保留在`queryTrace.reviews[].status=unavailable/errorCode`，不一定同步到顶层error或supplementStatus。首次真实调用前，新gate增加对所有检索轮review协议失败的零容忍检查；补查失败按round>=1的review错误与supplementStatus在同一入口取并集，避免漏计或双计。报告同步列出review unavailable代码及入口数。原注册零协议失败阈值及注册SHA不变，评分prompt、gold、标签和实际回答均未改变。

审查在unknown显示容量外的必要缺项可额外保存在`qualityReview.unrenderedMissingAspects`，它是程序添加的审计字段，不是provider原始模型响应。原`missingAspects`仍完整，审计原始响应时仅将schema原字段逐项对应，不把这个新增可见性字段当成模型输出改写。

## 第二次开发运行前：重复metadata精简兼容

首轮`qa-calibrated-dev`已完整执行但未通过注册门槛；原结果、失败gate、生产/评测快照及首次测试证据均保留。第二次开发继续使用原注册、阈值、数据和评分标准，重新提取完整20题并共享原600请求/300万tokens预算。此处记录第二次真实调用前的模型投影适配，不修改原pilot或其SHA。

仅当`id`严格等于`memory:`加同条`memoryId`时，模型引用投影可省略重复`memoryId`，稳定`id`仍保留。只有同一列表所有引用确实属于同一项目时，才可保留首项显式`projectId`并省略其余重复项；模型规则须明确继承首项项目，跨项目列表不得省略。正文span、显式facets、sourceTitle不省略；可信原始引用和最终citation保持完整，用于当前版本、项目和来源审计。

事后capture保持原始所给metadata，仅读取并精确连接正文span，不为缺省项目自动补值。检索judge仍只接收既有`id ?? memoryId`及正文，评分prompt/标签不变。证据归属scorer已有`memoryId`优先、缺省严格移除`memory:`前缀的规范ID回退；模型投影少重复字段不改变正式记忆映射。事后scope审计通过规范ID核对该paper真实正式记忆和项目，并可核对首项显式项目；不能把缺省项目当作放宽跨项目要求。原始provider请求、响应及其SHA保持原样。

第二次开发的生产审查版本为`claim-support-v7-conservative-partial`、流程版本为`bounded-question-flow-v5-granularity-review`。仅当结构完整、supported/answersQuestion为true、completeAnswer为false，但粗粒度obligations全answered又明确保留retain或missingAspects时，可保守保持partial；不能升级完整性、增加断言或移除必要未知。程序添加`normalization=coarse-answered-with-explicit-gaps`、`effectiveStatus=partial`及未经改写的`rawReview`。报告单列这些次数和raw粗粒度义务/明确缺项冲突，而非将“0结构协议失败”解释成“0模型语义或逻辑不一致”。complete=true且有必要缺项仍拒绝。首轮pilot原有2次失败不能用新规范化回填。

相同事实集合只改变排序时，可在再次校验旧/新快照后跳过重复generation；所有真实尝试顺序、producer generation索引及引用归属保持审计，不能补造一次模型调用。

## 第三次开发前：唯一预算扩展与累计账本

原600请求/300万tokens注册、原质量阈值、两个失败pilot/gate及各自14文件快照不改。[唯一预算addendum](memory-qa-calibrated-budget-addendum-1.json)于新回归和第三次真实调用前独占创建，绑定原注册及阈值SHA、两轮compact/detail/transcript和失败gate SHA，新增300请求/150万tokens，开发累计最多900请求/450万tokens；全量仍单独2000请求/1200万tokens。此扩展发生在观察两次失败之后，不能宣称仍在原预算内，也不能自动进行第二次扩展。

新helper递归验证`--prior-run`完整链路和每条provider收据，核对文件/请求SHA、真实usage、直接前驱声明及规范workspace，检测遗漏、重复/循环、篡改和跨数据/模型/轮次。新运行保留直接`priorRun`，另记完整`priorBudgetLedger`；剩余额度扣除所有先前运行，不只扣最后一次。开发gate同时校验原注册不变、addendum先于新测试/运行且进入新16项manifest、累计账本重算一致及总预算。当前fresh20的QA<=288410和全部质量/协议门槛完全不变。报告按不同workspace一次列出所有失败、新开发及全量费用。

第三版review为`claim-support-v8-explicit-claim-indices`，trace为`bounded-question-flow-v6-explicit-claim-indices`；审查输入显式标每条claimIndex，输出索引enum仅允许真实1..N，运行时越界仍拒绝。metadata投影可在全部引用同一非空project且sourceTitle严格同一非空值时仅首项保留sourceTitle；不满足共同条件时，原缺省projectId/sourceTitle显式null，原空串/null不变，避免被误当作继承首项。当前正文、显式facets、可信引用和评分视图不变。capture仍保留实际原字段，不恢复或推造缺省metadata。
