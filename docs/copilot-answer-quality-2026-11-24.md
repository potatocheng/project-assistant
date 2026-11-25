# 副驾驶最终回答的偏好遵循率

本轮在本机隔离的测试工作区运行，输入采用公开与合成数据。

## 最终结果

同样的题目、选项和偏好记录交给不同的回答模型，差异最大。32 道逐字相同输入上，1.5B 答对 17 道，7B 答对 26 道。再从最终验收集中每个主题预取一道，使用最终向量配置完全相同的输入，1.5B 答对 7/16，7B 答对 13/16，6 道由错变对，0 道由对变错。应用已有的本地模型预设为 `qwen2.5:7b`。[逐题配对汇总](../output/answer-quality-20261124/role-check/paired-summary.json) · [应用预设](../src/components/ModelSettings.tsx)

| 最终验收，96 道 PrefEval 四选一，共用 1.5B 回答模型 | 原系统 | 最终默认配置 | 最终配置开启向量搜索 |
| --- | ---: | ---: | ---: |
| 最终答案正确 | 46/96（47.9%） | 43/96（44.8%） | 47/96（49.0%） |
| 正确偏好进入模型上下文 | 68/96 | 68/96 | 94/96 |
| 在已经拿到正确偏好的题中答对 | 34/68 | 32/68 | 45/94 |
| 由错变对 / 由对变错，相对原系统 | — | 3 / 6 | 7 / 6 |

默认配置相对原系统少答对 3 道，向量配置多答对 1 道，双侧精确 McNemar 检验分别为 p=0.508 和 p=1.000。向量配置多找回了 26 道题的正确偏好，并保留了原有证据。在拿到正确偏好的 94 道题中，1.5B 仍答错 49 道，最终正确率接近一半。单次偏好匹配用时中位数分别为 1 ms 和 19 ms，95 分位分别为 2 ms 和 27 ms。[默认配置汇总](../output/answer-quality-20261124/role-check/summary-release.json) · [向量配置汇总](../output/answer-quality-20261124/role-check/summary-embedding.json)

## 原因定位

上轮 PrefEval 的 64 道四选一题答对了 32 道。重新对齐模型实际收到的提示词和四选一版本的偏好原文后，53 道题的正确偏好已进入上下文，其中答对 27 道、答错 26 道。另有 11 道题漏掉目标偏好，其中 6 道答错。两种错误需要分别处理。[上轮结果](memory-habits-benchmark-2026-11-24.md) · [按偏好位置统计](../output/answer-quality-20261124/prior-rank-buckets.json)

从这 64 道旧题中，每个主题用哈希选 2 道做对照。保持同一模型、题干、选项顺序和解码设置，仅改变给模型的上下文。

| 32 道诊断题 | 答对数 |
| --- | ---: |
| 原提示词，去掉所有习惯 | 13 |
| 原提示词，原系统挑选的 12 条习惯 | 18 |
| 原提示词，仅提供标注的那条偏好 | 19 |
| 第一版缩短后的提示词，仅提供同一条标注偏好 | 18 |

旧提示词明确要求模型把已确认习惯仅用于表达风格、工具默认参数及交互习惯。对需要按偏好改变具体建议的问题，这条指令限制了偏好的用途。挑选逻辑也会补足 12 条习惯，主题关联很弱的记录仍会占据上下文。旧题对照反映了本机 1.5B 模型即便拿到单条正确信息，也会在选出合适回答时出错。单独缩短和改写系统指令，在这组题上也没有带来提升。[无习惯对照](../output/answer-quality-20261124/diagnostic-none.json) · [单条正确偏好对照](../output/answer-quality-20261124/diagnostic-oracle.json)

同一批 32 道诊断题只把四个选项循环移动一个位置，保持选项文字和正确偏好完全相同。旧提示词加单条正确偏好时，答对数从 19 变为 21，有 13 道改选了另一段回答内容。这个小模型对选项位置的敏感性也是分数波动的来源。正式验收统一固定选项顺序。[轮换后的逐题选择](../output/answer-quality-20261124/diagnostic-rotated.json) · [缩短指令的单条偏好对照](../output/answer-quality-20261124/diagnostic-oracle-new.json)

在另外 32 道按主题分层抽取的题上，保持包含检索证据的模型输入逐字相同，将回答模型从 Qwen2.5-1.5B-Instruct 换成同系列 7B。答对数由 17/32（53.1%）升至 26/32（81.3%），9 道由错变对，0 道由对变错，双侧精确 McNemar 检验 p=0.0039。这里隔离出了回答模型对准确率的直接影响，效应大小仅适用于本次样本和这两个量化模型。[1.5B 逐题结果](../output/answer-quality-20261124/capacity-small.json) · [7B 逐题结果](../output/answer-quality-20261124/capacity-large.json)

## 两个中间版本

第一版让同一台本地对话模型先从候选习惯中选出至多 4 条，再把选中的原文交给回答模型。第一次独立验证从 64/128 降到 56/128，4 道由错变对，12 道由对变错。全部 128 次筛选都返回了有效编号，但目标偏好进入上下文的题数从 99 降到 42。每题平均留下 1.75 条，筛选步骤本身的中位耗时为 5.85 秒。另预选 32 题将该筛选服务切为离线，旧版本答对 17 道，第一版在线、离线均为 16 道。中文自由回答两版均为 8/12。这版已撤回。[第一版汇总](../output/answer-quality-20261124/summary-first.json) · [筛选原始记录](../output/answer-quality-20261124/fresh-selection.json) · [离线对照](../output/answer-quality-20261124/fresh-offline-control.json)

第二版完整保留本地前 12 条，再把最相关的习惯附在发给模型的本轮用户消息里。另取 128 道题，原系统答对 56 道，这版默认答对 64 道，开启向量搜索答对 67 道。相对原系统的双侧配对检验分别为 p=0.134 和 p=0.099。目标偏好分别出现在 95、95、125 道题的上下文里，向量条件还有 59 道在拿到正确偏好后答错。[默认配置汇总](../output/answer-quality-20261124/summary-release.json) · [向量配置汇总](../output/answer-quality-20261124/summary-embedding.json)

这版的中文办公自由回答分别是原系统 8/12、默认 6/12、向量 8/12。用户明确指定这次改用新地点或联络渠道时，两种新配置的遵循率都从 4/4 降到 2/4，模型在回答中复述了历史做法。于是保留这版的证据召回方式，撤回将历史记录写进用户消息的做法。[中文原始回答](../output/answer-quality-20261124/controls-release.json) · [向量配置的中文回答](../output/answer-quality-20261124/controls-embedding.json)

## 最终实现

- 副驾驶等待当前项目的习惯加载完成，先筛除其他项目、暂停和低效的记录，再保留原有排序中的前 12 条作为回答依据。原有候选的保留与匹配服务是否可用无关。
- 默认在本机用本轮请求匹配习惯。检索结果仅出现在系统消息，最相关的记录单列为历史默认值，每条原文只出现一次。发给模型的用户消息逐字保留当前请求。同一轮的后续工具调用复用同一份上下文。回答指令要求先满足本轮明确指定的内容，再把适用偏好落实到用户交由助手决定的部分，项目事实继续核实，写操作继续审批。
- 如果工作区已启用向量搜索，使用现有配置及授权，把请求与最多 32 条候选一起编码，按余弦相似度突出最多 4 条。匹配到原有 12 条以外的习惯时补入依据。向量服务超时或报错时仍使用本地匹配。准备上下文只需本地词法匹配或一次向量请求，后续工具轮次沿用缓存。[副驾驶实现](../src/components/shell/pi-copilot-agent.ts) · [向量匹配](../crates/core/src/semantic.rs)

## 验收设计

在修改产品代码前封存了另外 128 道题，与旧 64 道四选一零重合。沿用上轮的 16 个保留主题，每个主题从剩余题中按固定哈希取 8 道。这些题来自同一公开数据集，之前的显式偏好检索评测已覆盖其中的题目，最终答案此前没有评分。数据版本为 `50795054b5ff5f418d2b768a331d71e480f93331`，样本清单 SHA-256 为 `9a9b5a467b7c36a585380a24aad9a6384bbaf3a2ee201f18c943718a39acb7fa`。[封存清单](../output/answer-quality-20261124/sealed-split.json) · [修复版本及输入指纹](../output/answer-quality-20261124/candidate-freeze.json)

发现第一版丢失原有证据后，在同样的 16 个主题中又封存了 128 道题，与前两批共 192 道题零重合。清单 SHA-256 为 `8378d47918aed669d6a7edee5b7318e5aa059cf8e47f4473b50df3f92b3df6f5`。在查看这批题的回答分数前固定了第二版实现和实验条件。默认设置是主条件，额外测量开启通用预训练向量模型 all-MiniLM-L6-v2 的工作区。两种条件共用同一个回答模型。[第二批清单](../output/answer-quality-20261124/confirmation-split.json) · [第二版实现指纹](../output/answer-quality-20261124/release-freeze-final.json)

在修改消息角色前，从剩余样本中按新固定哈希每个主题抽 6 道，共 96 道，与前面 320 道均无重合。清单 SHA-256 为 `c919de1fc3af62b04d1af7ea34c6979d5842d8c2094dae2ba59caa3d2f606cb8`。在回答评分前，逐题验证两个条件的用户消息与基线完全相同，所有原有偏好均已保留且没有重复，并封存代码和模型输入。未按题目、选项、专名或主题配置任何产品规则。[最终验收清单](../output/answer-quality-20261124/role-holdout-split.json) · [源码和逐题输入指纹](../output/answer-quality-20261124/role-check/freeze.json)

每道题有 20 条已确认习惯，其中 19 条取自其他主题。检索仅使用题干和候选习惯，候选不含主题名、正确性标签或选项。回答模型看到原题及固定打乱的四个选项。主实验修复前后共用本地 Qwen2.5-1.5B-Instruct Q4_K_M、llama.cpp b12676、温度 0、种子 42 和单字母输出约束。按公开答案精确计分。这是将 PrefEval 分类任务接入产品的测试，覆盖从已确认习惯到选择回答这一段。原基准还包含从历史对话提取偏好以及自由生成的评测。[PrefEval 项目](https://prefeval.github.io/) · [固定版本与输入构造](../scripts/benchmark-prefeval.mjs)

另写 4 组中文办公场景，每组 3 次。从真实副驾驶入口发问，两次只交换一条已确认的交付地点、故障联络渠道、签核入口或交接位置，第三次在当前消息中明确改用另一个。模型保留产品默认温度 0.2，每个条件自由回答一次，用两种答案的互斥专名评分。回复要包含应选的专名，且不能同时提及另一个专名或跨项目的干扰专名。错误、空答和工具循环均计为失败。这组测试只覆盖上述四种场景。[自由回答用例及评分规则](../scripts/benchmarks/copilot-preference-controls.mjs)

最终实现固定后，又写了 3 个独立中文场景，分别是读书摘记的导出格式、实验笔记的标签和分享会的提问方式。每组共 3 次，覆盖默认偏好的两个方向，以及收件方、负责人或场地方改变本轮要求。沿用同一真实副驾驶入口和互斥名称评分规则。[新场景和评分脚本](../output/answer-quality-20261124/role-check/transfer-controls.mjs)

| 中文自由回答，1.5B | 原系统 | 最终默认配置 | 最终配置开启向量搜索 |
| --- | ---: | ---: | ---: |
| 原有 4 个办公场景的全部回答 | 8/12 | 7/12 | 9/12 |
| 其中，用户当场改变要求 | 4/4 | 4/4 | 4/4 |
| 实现固定后新增的 3 个场景 | 4/9 | 5/9 | 6/9 |
| 其中，用户转述本轮外部要求 | 0/3 | 1/3 | 1/3 |

全部自由回答均完成，没有报错。最终默认配置在原有 12 个回答中少答对 1 个，在独立 9 个回答中多答对 1 个。用户只说明收件方或场地等外部要求时，模型仍经常沿用既有做法。这组题每个条件只生成一次，计分要求命中指定名称。[最终默认配置的原有场景回答](../output/answer-quality-20261124/role-check/controls-release.json) · [独立场景的原系统回答](../output/answer-quality-20261124/role-check/transfer-original.json) · [独立场景的向量配置回答](../output/answer-quality-20261124/role-check/transfer-embedding.json)

模型能力对照固定两组输入。第一组在第二版向量条件的 128 道题内每主题按独立哈希取 2 道，共 32 道，输入 SHA-256 为 `2b74acce15e7da1c87edc7e4480e1dc86cd3f844614dac52b654666efc85b9c4`。只切换 Qwen2.5-1.5B-Instruct 和 Qwen2.5-7B-Instruct，两边共用完全相同的消息、选项、精度、生成配置和评分。第二组在最终 96 道中每个主题预取 1 道，共 16 道，用于核对最终版本在 7B 上的实际表现。7B 也是应用已有的 Ollama 本地模型预设，两组实测均用独立的 llama.cpp 服务运行官方 Q4_K_M 权重。[第一组冻结输入](../output/answer-quality-20261124/capacity-input.json) · [第二组原系统输入](../output/answer-quality-20261124/role-check/preset-before-input.json) · [第二组最终输入](../output/answer-quality-20261124/role-check/preset-embedding-input.json) · [官方模型发布](https://huggingface.co/Qwen/Qwen2.5-7B-Instruct-GGUF)

| 最终 96 道中的同一组 16 道 | 原系统 | 最终默认配置 | 最终配置开启向量搜索 |
| --- | ---: | ---: | ---: |
| 1.5B | 6/16 | 6/16 | 7/16 |
| 7B | 12/16 | 12/16 | 13/16 |

7B 的默认配置是在主实验后用同一组预选题、已有的冻结输入补跑的。固定 7B 时，默认配置有 1 道由错变对、1 道由对变错，向量配置相对原系统有 1 道由错变对。每个主题只有一道题，这组数据对同一模型上的软件收益仅提供方向性复核。模型权重缓存在本机 `.local-data/open-benchmarks/qwen2.5-7b/`，两个文件合计约 4.68 GB。[7B 基线](../output/answer-quality-20261124/role-check/preset-before.json) · [7B 默认配置](../output/answer-quality-20261124/role-check/preset-default.json) · [7B 向量配置](../output/answer-quality-20261124/role-check/preset-embedding.json)

## 回归检查

Rust core 通过 589 项测试，另有 7 项标成按需运行。副驾驶和工作台的 29 项针对性测试、前端生产构建、桌面端 Cargo 检查均通过。Node 全量测试通过 313/314，唯一失败项核对 10 月份历史评测归档的文件指纹。已逐一对照 24 个归档文件，其中 12 个与历史指纹不符，这 12 个的工作区内容均与本轮开始时的 Git HEAD 逐字节一致。[副驾驶回归](../output/answer-quality-20261124/role-check/node-focused-final.log) · [Rust 结果](../output/answer-quality-20261124/final-rust.log) · [Node 全量结果](../output/answer-quality-20261124/role-check/node-full-final.log)

## 复跑

使用新的输出目录，按上轮报告启动本地 llama.cpp 服务，以下命令从仓库根目录运行。脚本验证固定版本的题目和选项。原版本的输入与源码保留在本机，可在同一个模型服务上重跑配对基线。[原版本副驾驶](../output/answer-quality-20261124/agent-before.ts) · [最终确认集的 96 份原版本输入](../output/answer-quality-20261124/role-check/confirmation-before-input.json)

```powershell
cargo build --locked -p project-assistant-core --bin pm-host
$out = 'output/preference-answers-rerun'
$archive = 'output/answer-quality-20261124'
New-Item -ItemType Directory -Force $out | Out-Null
$url = 'http://127.0.0.1:57744'
$model = (Invoke-RestMethod "$url/v1/models").data[0].id
$env:PREFEVAL_CONTEXT = 'turn'
$env:PREFEVAL_MCQ_SET = 'roles'
$env:PREFEVAL_AGENT_MODULE = "$archive/agent-before.ts"
$env:PREFEVAL_MCQ_INPUT = "$out/confirmation-before-input.json"
$env:PREFEVAL_MCQ_PROFILES = "$out/confirmation-profiles.json"
node scripts/benchmark-prefeval.mjs .local-data/open-benchmarks/prefeval-extracted "$out/local-ranking.json"
node scripts/benchmarks/prefeval-mcq.mjs "$out/confirmation-before-input.json" "$out/confirmation-before.json" $url
node scripts/benchmarks/copilot-preference-controls.mjs "$archive/agent-before.ts" "$out/controls-before.json" $url $model
node scripts/benchmarks/prepare-personalized-answers.mjs "$out/confirmation-profiles.json" "$out/confirmation-before-input.json" "$out/input-release.json" "$out/selection-release.json" $url $model
node scripts/benchmarks/prefeval-mcq.mjs "$out/input-release.json" "$out/confirmation-release.json" $url
node scripts/benchmarks/copilot-preference-controls.mjs src/components/shell/pi-copilot-agent.ts "$out/controls-release.json" $url $model
node scripts/benchmarks/summarize-personalized-answers.mjs $out release
```

要复跑向量条件，在另一个终端运行上轮报告的 MiniLM 服务，随后给 `prepare-personalized-answers.mjs` 和自由回答脚本各追加两个参数，即服务 URL 及 `all-MiniLM-L6-v2`，并使用新的输出文件名。

要复跑模型能力对照，将同一份冻结输入分别送给两个本地服务。以下示例使用 1.5B 的 57744 端口和 7B 的 57746 端口。7B 两个分片的 SHA-256 分别为 `dfce12e3862a5283ccfb88221b48480e58745165de856439950d0f22590580db` 和 `539cf93f78e887edea1c04e2d7d8cdaca9d01dae9c9025bcb8accbe29df3d72a`。[权重校验记录](../output/answer-quality-20261124/download-capacity-model.log)

```powershell
node scripts/benchmarks/prefeval-mcq.mjs "$archive/capacity-input.json" "$out/capacity-small.json" http://127.0.0.1:57744
node scripts/benchmarks/prefeval-mcq.mjs "$archive/capacity-input.json" "$out/capacity-large.json" http://127.0.0.1:57746
node scripts/benchmarks/prefeval-mcq.mjs "$archive/role-check/preset-before-input.json" "$out/preset-before.json" http://127.0.0.1:57746
node scripts/benchmarks/prefeval-mcq.mjs "$archive/role-check/preset-default-input.json" "$out/preset-default.json" http://127.0.0.1:57746
node scripts/benchmarks/prefeval-mcq.mjs "$archive/role-check/preset-embedding-input.json" "$out/preset-embedding.json" http://127.0.0.1:57746
```
