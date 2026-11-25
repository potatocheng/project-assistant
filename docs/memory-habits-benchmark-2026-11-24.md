# 记忆与用户习惯评测

本页保留当次版本的结果。后续的低分原因、修复前后对照和独立验收记录见[副驾驶最终回答的偏好遵循率](copilot-answer-quality-2026-11-24.md)；基于 `deepseek-flash` 的真实端到端闭环评测见[DeepSeek 真实端到端评测](memory-habits-live-deepseek-2026-11-25.md)。

2026 年 11 月 24 日。基线取自本轮修改前的工作区，包含当时尚未提交的重构。前后使用相同的问题、候选、证据标注和模型。本地临时数据库承载公开语料，模型在本机 CPU 上运行。[基线文件指纹](../output/memory-habits-20261124/baseline-files.json)

## 保留集结果

| 任务 | 指标 | 修复前 | 修复后 |
| --- | --- | ---: | ---: |
| PrefEval 已确认偏好，827 题 | 目标偏好排第 1 | 43/827（5.2%） | 292/827（35.3%） |
| 同上 | 目标偏好进前 5 | 206/827（24.9%） | 452/827（54.7%） |
| 同上 | 目标偏好进入提示词的 12 个位置 | 490/827（59.3%） | 621/827（75.1%） |
| PrefEval 四选一，16 个保留主题 | 本地 Qwen 答对 | 31/64（48.4%） | 32/64（50.0%） |
| LoCoMo 混合检索，160 题 | 前 5 条至少命中一条标注证据 | 82/160（51.3%） | 84/160（52.5%） |
| 同上 | 前 5 条找全标注证据 | 57/160（35.6%） | 61/160（38.1%） |
| 同上 | 每题证据召回率取平均，前 5 条 | 42.1% | 44.2% |
| LoCoMo 纯关键词检索，相同 160 题 | 前 5 条找全标注证据 | 63/160（39.4%） | 63/160（39.4%） |
| QASPER，72 道有答案的题 | 前 6 段找全一组可接受证据 | 42/72（58.3%） | 42/72（58.3%） |

**选偏好的改善最大。** 在 20 条候选中随机排列，目标排第一的概率为 5%。逐题比较，修复后有 257 题新排到第一，8 题从第一回落。仍有 206/827 题的目标偏好完全没有进入提示词。用户是否能直接看到更合意的回答，另用四选一题检验。[PrefEval 基线](../output/memory-habits-20261124/prefeval-before.json) · [修复后逐题排名](../output/memory-habits-20261124/prefeval-after.json)

**混合检索小幅改善，跨多条发言的证据仍容易漏。** 修复后有 5 题新找全证据，1 题丢失完整证据。在 40 道多跳题中只找全了 4 道，前 5 条命中至少一条证据的有 20 道。其中 2 道的标注本身就超过 5 条。作为参照，纯关键词在全部 160 题中比修复后的混合检索多找全 2 题。这组结果支持修复项目内漏召回，对默认启用向量检索的收益仍缺乏证据。[LoCoMo 混合基线](../output/memory-habits-20261124/locomo-hybrid-before.json) · [修复后混合检索](../output/memory-habits-20261124/locomo-hybrid-after.json) · [关键词对照](../output/memory-habits-20261124/locomo-lexical-after.json)

**论文证据检索结果稳定。** 另从今天记忆重构提交 `110b478` 的父提交 `229dc74` 导出原始 Rust 源码及锁文件，实际重新编译并跑同一份 QASPER。重构前、接手时、本次修复后三个版本各跑连接器和桌面模型候选两条路径，每条 100 题。三个版本的 200 组候选 ID、顺序及证据覆盖逐题一致。保留集的 72 道有答案题在前 3、6、12 段分别找全 33、42、51 道。另有 8 道不可回答的题参与项目隔离检查，两条路径的越界次数均为 0。[重构前的复跑记录](../output/memory-habits-20261124/qasper-pre-refactor.json) · [接手时基线](../output/memory-habits-20261124/qasper-before.json) · [修复后逐题证据](../output/memory-habits-20261124/qasper-after.json)

## 偏好是否影响最终回答

从官方 PrefEval 四选一文件读取原题、偏好和选项，按固定哈希打乱选项位置。给本地 Qwen2.5-1.5B-Instruct 同一道题，分别配修复前后的副驾驶系统提示词。模型始终能看到题目和四个选项，偏好排序只接收题目。用正确选项直接评分，未使用模型裁判。

冻结排序后，从每个保留主题按固定哈希抽 4 题，共 64 题。仅按页面选择偏好的对照复现了原基线全部 1,000 个逐题排名，以及工作主题 36 份逐字一致的模型输入。保留集的 64 对输入中，42 对的系统提示词发生变化。答对数从 **31/64 到 32/64**，其中 3 题由错变对，2 题由对变错。这一题净增不足以说明真实回答已普遍更符合偏好。[页面对照逐题答案](../output/memory-habits-20261124/mcq-holdout-page.json) · [按提问选择后的答案](../output/memory-habits-20261124/mcq-holdout-turn.json)

在与产品最接近的工作地点与工作方式主题，答对数从 **20/36（55.6%）到 21/36（58.3%）**。有 1 题由错变对，其余 35 题对错相同。该主题属于开发集。[工作主题基线](../output/memory-habits-20261124/mcq-before.json) · [修复后回答](../output/memory-habits-20261124/mcq-after.json)

## 已修改的行为

- 副驾驶每次请求都用本轮问题、页面和项目选择最多 12 条已确认习惯。词项匹配支持中文分词，并对许多习惯都出现的词降低权重。同一页面连续问两个不同问题的回归用例覆盖了真实发给模型的提示词。[副驾驶实现](../src/components/shell/pi-copilot-agent.ts) · [回归用例](../scripts/pi-copilot-memory.test.mjs)
- 审批反馈归到本轮实际展示且作用于对应工具和参数的习惯。全工作区写作只取全局习惯，跨项目提醒按每条提醒自己的项目计算优先级。[审批反馈](../src/components/shell/pi-copilot-agent.ts) · [习惯选择](../crates/core/src/habits.rs) · [提醒扫描](../crates/core/src/proactive.rs)
- 中文编辑学习的 10 个定向正反例从 **5/10 到 10/10**。原先把百分比从 70% 改成 80 %、在前言提到风险、给列表或正文追加待办，都可能留下错误的风格信号。全角百分比又可能被漏掉。修复后检测章节顺序、正文替换及全角数值。这里衡量一次编辑产生的观察是否正确，样本来自本地回归用例。重复观察、形成提案、用户确认和效用衰减也经过单测。[基线失败记录](../output/memory-habits-20261124/controls-before.log) · [复测记录](../output/memory-habits-20261124/controls-after.log)
- 向量检索先限定项目再取最近邻。在其他项目有 12 条更近向量的构造用例中，本项目唯一候选从漏掉变为命中。按项目重建只清理该项目的过期向量。词法与向量的倒数排名融合也调整了头部权重。公开评测报告的是这两项检索修改的合计效果。[向量索引](../crates/core/src/semantic.rs) · [融合排序](../crates/core/src/memory_query.rs) · [跨项目回归](../crates/core/tests/hybrid_retrieval_engine.rs)

Rust 核心的默认测试通过 588 项，失败 0 项，默认忽略 7 项。上文的 LoCoMo 和 QASPER 用独立命令显式执行。副驾驶及工作台的 19 项前端测试和生产构建均通过。跨项目提醒扫描与单项目向量重建还分别通过了产品入口的集成测试。[Rust 完整日志](../output/memory-habits-20261124/core-tests.log) · [前端测试](../output/memory-habits-20261124/frontend-tests.log) · [提醒作用域](../output/memory-habits-20261124/proactive-scope.log) · [向量重建](../output/memory-habits-20261124/hybrid-engine.log)

## 数据和口径

- **LoCoMo-10** 使用全部 10 组对话的 5,882 条发言，每组对应一个项目。逐条保留日期、说话人、对话正文及公开图片说明，作为已确认记忆进入真实搜索入口。按对话及非对抗题类分层，每层用固定哈希最多取 5 题，共 195 题。排除 446 道对抗题及 13 道证据缺失或引用无效的题。开发集为 conv-26、conv-30 的 35 题，其余 8 组对话的 160 题留作验证。用开发集选择融合配置，选定后才读取保留集结果。开发集的混合完整命中为 16/35 → 17/35，关键词为 17/35。逐题平均证据召回率采用官方按发言 ID 对齐的定义。此项衡量检索，未跑生成问答、事件摘要或图像生成。[基准论文与项目](https://snap-research.github.io/locomo/) · [固定版本数据](https://github.com/snap-research/locomo/tree/cbfbc1dba6bc53d00625212a0f22d55ffee7c1fc/data) · [评测入口](../crates/core/src/memory_evaluation/locomo.rs)
- **PrefEval** 使用全部 20 个显式偏好主题的 1,000 对偏好与问题。每题放入一条目标偏好和来自其余 19 个主题的固定干扰项，项目、类别、置信度、效用、更新时间完全相同。所有候选都已确认，系统看不到正确选项或主题标签。按主题哈希留出 16 个主题 827 题，另 4 个主题 173 题用于开发。开发集的首位命中为 10/173 → 26/173。结果衡量从已知偏好中选对当前所需偏好，以及选择题上的遵从度。对话里隐式发现偏好、长期用户满意度和原始长上下文榜单均超出本次测量范围。[PrefEval 论文与任务说明](https://prefeval.github.io/) · [固定版本数据](https://github.com/amazon-science/PrefEval/tree/50795054b5ff5f418d2b768a331d71e480f93331/benchmark_dataset) · [评测入口](../scripts/benchmark-prefeval.mjs)
- **QASPER v0.3** 沿用仓库已有的论文证据测试。36 篇论文的 1,686 个段落进入隔离数据库，按论文划分 20 道开发题与 80 道保留题。给检索器原始问题，以人工标注判断是否找全至少一组可接受证据。这项指标衡量段落召回，最终答案 F1 未测。[原始数据集](https://huggingface.co/datasets/allenai/qasper) · [仓库数据清单](memory-public-dataset-manifest.json)

三个公开数据集均使用英文。本次对中文产品场景的直接验证覆盖编辑、上下文切换与审批。Rust 公开评测实际使用 release 构建，QASPER 原始 JSON 中的 debug 字样来自仓库旧说明。耗时受同机并行编译影响，表格只比较质量。

## 复跑

以下 PowerShell 示例从仓库根目录运行。使用新的输出目录便于保留逐题结果。原始工作区含未提交改动，可用保存的文件指纹核对基线。当前代码可以复跑修复后结果和仅按页面选偏好的对照。

```powershell
$data = '.local-data/open-benchmarks'
$out = 'output/memory-habits-rerun'
New-Item -ItemType Directory -Force $out | Out-Null

$env:LOCOMO_DATA = "$data/locomo10.json"
$env:LOCOMO_REPORT = "$out/locomo-lexical.json"
Remove-Item Env:LOCOMO_EMBED_URL -ErrorAction SilentlyContinue
cargo test --release --locked -p project-assistant-core --lib memory_evaluation::locomo::measure_locomo_retrieval -- --ignored --exact
node scripts/benchmarks/summarize-locomo.mjs "$out/locomo-lexical.json"

$env:MEMORY_PUBLIC_DATASET = "$data/qasper-memory-v1.json"
$env:MEMORY_PUBLIC_REPORT = "$out/qasper.json"
cargo test --release --locked -p project-assistant-core --lib memory_evaluation::measure_public_external_evidence -- --ignored --exact

$env:PREFEVAL_CONTEXT = 'turn'
$env:PREFEVAL_MCQ_SET = 'holdout'
$env:PREFEVAL_MCQ_INPUT = "$out/mcq-input.json"
node scripts/benchmark-prefeval.mjs "$data/prefeval-extracted" "$out/prefeval.json"
```

LoCoMo 文件取上文固定版本的 `data/locomo10.json`，SHA-256 为 `79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4`。PrefEval 目录下应有同一版本的 `explicit_preference` 和 `mcq_options` 两个目录。QASPER 文件可用 `node scripts/prepare-memory-public-eval.mjs` 生成，指纹为 `803537c32e89dce765c8e6cef6484f332d6ef5a9c91b726a4ea957e68b461d87`。

混合检索使用 384 维 all-MiniLM-L6-v2 的量化 ONNX 权重，最多 256 个 token，按 attention mask 均值池化并做 L2 归一化。实测环境包含 onnxruntime 1.23.2、tokenizers 0.22.1 和 numpy 2.2.6。在第二个终端启动下列服务，随后用 `LOCOMO_EMBED_URL=http://127.0.0.1:57743` 和新的 `LOCOMO_REPORT` 再跑 LoCoMo 命令。脚本校验模型和分词器的哈希。[模型固定版本](https://huggingface.co/Xenova/all-MiniLM-L6-v2/tree/751bff37182d3f1213fa05d7196b954e230abad9) · [本地模型服务](../scripts/benchmarks/minilm-server.py)

```powershell
python scripts/benchmarks/minilm-server.py .local-data/open-benchmarks/minilm-onnx/model-mirror.onnx .local-data/open-benchmarks/minilm-onnx/tokenizer-mirror.json 57743
```

选择题使用 llama.cpp b12676、Qwen2.5-1.5B-Instruct Q4_K_M、4,096 token 上下文、CPU、单并发，温度 0、种子 42，输出约束为 A 至 D。GGUF 文件的 SHA-256 为 `6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e`。启动本地模型后在主终端运行答题脚本。重建页面基线用 `PREFEVAL_CONTEXT=page`，重建完整工作主题用 `PREFEVAL_MCQ_SET=work`，每次指定新输出文件。[模型发布](https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF) · [llama.cpp b12676](https://github.com/ggml-org/llama.cpp/releases/tag/b12676) · [选择题评分](../scripts/benchmarks/prefeval-mcq.mjs)

```powershell
# 第二个终端
& .local-data/open-benchmarks/llama-b12676/bin/llama-server.exe -m .local-data/open-benchmarks/qwen2.5-1.5b-instruct-q4_k_m.gguf --host 127.0.0.1 --port 57742 -ngl 0 -t 4 -c 4096 -np 1

# 主终端
node scripts/benchmarks/prefeval-mcq.mjs "$out/mcq-input.json" "$out/mcq-answers.json" http://127.0.0.1:57742
```
