# 模型适配与开源参考

核对日期：2026-10-19。实现位于 `crates/core/src/ai.rs`，沿用 Rust 核心，不增加 Python 运行时。

## 本阶段的选择

| 项目 | 本阶段用途 | 许可证与一手依据 |
|---|---|---|
| reqwest | 实际采用的 Rust HTTP 客户端。使用 blocking 接口，在独立工作线程发送请求，设置连接与总超时，关闭重定向 | MIT OR Apache-2.0；[官方 Cargo.toml](https://github.com/seanmonstar/reqwest/blob/master/Cargo.toml)、[blocking ClientBuilder](https://docs.rs/reqwest/0.12/reqwest/blocking/struct.ClientBuilder.html) |
| Rig | 已评估的 Rust LLM 应用框架；当前两个提供方的提取流程使用小型适配层，后续增加更复杂模型能力时可重新评估 | MIT；[官方仓库](https://github.com/0xPlaygrounds/rig)、[许可证](https://github.com/0xPlaygrounds/rig/blob/main/LICENSE) |
| Google LangExtract | 参考逐字原文对齐、长文分块、未对齐提取结果过滤的设计。Python 包不进入桌面应用 | Apache-2.0；[官方原文对齐及长文说明](https://github.com/google/langextract#why-langextract)、[许可证](https://github.com/google/langextract/blob/main/LICENSE) |
| Mem0 | 参考信息提取与记忆管理分层、作用域隔离的思路。正式项目记忆继续采用本产品的人工确认与修订流程 | Apache-2.0；[官方实现](https://github.com/mem0ai/mem0/blob/main/mem0/memory/main.py)、[许可证](https://github.com/mem0ai/mem0/blob/main/LICENSE) |

Mem0 当前公开实现可见先检索同作用域的已有记忆，再做 additive extraction；本阶段没有直接引入其 Python SDK、向量存储或自动记忆写入流程。上述参考项目没有作为 Python 服务捆绑到应用。

## 两种显式模型配置

默认云服务配置是 OpenAI-compatible、`https://api.deepseek.com`、`deepseek-flash`、`json_object`。当前 DeepSeek 官方首页将 `deepseek-flash` 映射至 DeepSeek-V4.1-Flash-1017。JSON 模式通过 `response_format: {"type":"json_object"}` 开启，提示词中同时提供 JSON 格式要求及候选 schema。

来源：[DeepSeek 首次调用](https://api-docs.deepseek.com/zh-cn/)、[JSON Output](https://api-docs.deepseek.com/zh-cn/guides/json_mode/)。模型名称由用户配置，应用不自动切换到其他提供方。

DeepSeek 官方思考模式默认开启，支持 `thinking: {"type":"disabled"}`。提取器只对 `api.deepseek.com` 添加关闭思考的参数；其他兼容服务使用通用参数。[官方思考模式说明](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode/)

Ollama 是可选的本机提供方，仅接受 loopback 地址，调用 `/api/chat`，设置 `stream:false`。JSON Schema 模式将 schema 放入 `format`，JSON 模式使用 `format:"json"`。Ollama 官方说明其云服务当前不支持 structured outputs，因此这里的 Ollama 选项指向本机服务。[Ollama Structured Outputs](https://docs.ollama.com/capabilities/structured-outputs)、[Chat API](https://docs.ollama.com/api/chat)

## 提取与记忆边界

- 提取提示版本为 `project-memory-task-extraction-v3`。资料按最多 6,000 个 Unicode 字符分批，预留 256 字符给重叠上下文；超长单段优先在句末切分，相邻段落跨批时也保留前文尾部。原片段 ID 与逐字引用保持不变，超出处理上限时明确报错，不截断资料。
- 提示要求按主体与事项分别提取，保留否定、条件和时间区别；建议、计划和被否决方案不能改写成已确认决策或当前需求，开发完成不能当作验收完成。
- 输出分为 `candidates`（fact、decision、requirement、risk 四类记忆候选）和 `taskCandidates`（工作及进展候选）。每项依据必须使用当前批次的片段 ID，并给出该片段中的非空逐字子串。旧的仅 `candidates` 响应继续兼容。
- 任务候选的负责人、原文日期表达和数字百分比必须得到引文支持；只有带年份的完整绝对日期才规范为 `dueDate`。相对日期保留在 `dueText`，不按今天推算，也不猜测谁是当前用户。
- `dueDate` 与已填写的 `dueText` 必须对应同一个完整日期，不能将会议日期挪作“下周截止”的日期；引文明示为覆盖率、利用率等指标的百分比不能写入任务进度。
- 同一轮提取中，正文与类型相同的记忆合并不同原文依据；任务还需负责人、日期、状态、进度等字段相同才合并。不同状态或不同负责人保留为独立候选供核对，不进行语义相似自动合并。
- 混合结果中过滤无效候选并统计数量；全为无效候选时返回依据校验错误；合法空数组代表成功提取到零条。
- 全部批次完成后才返回两类候选。任何批次失败或用户取消均不返回可部分保存的结果。数据库负责在单个事务中保存待确认候选；记忆和任务都需要用户确认。任务进展候选不会自动覆盖已确认状态。
- 不向模型注册工具，不执行模型返回的工具调用。API Key 只作为 HTTP 认证参数，模型提示中不包含密钥；错误信息不包含原始响应、密钥或完整连接地址。
- 连接测试发送固定的合成资料，验证所选模型、认证、JSON 结构和原文依据，不发送项目资料。

逐字子串校验保证引用可定位，但不能单独证明候选陈述完全符合原意。候选确认界面继续展示原文依据，让用户核实语义。

## 本地检索

- 两个问答入口共用 `crates/core/src/search.rs`：区分中英文词边界、统一 ASCII 全角与大小写，以中文二字、三字片段和短语匹配，并对登录/login、审计/audit、接口/API 等有限术语补充低权重同义匹配。英文 API 不会匹配 apiary。
- 飞书代答按同项目当前已确认记忆构建 BM25 排序，结合词的稀有程度、重复次数与正文长度，在上下文条数限制之前排序。仅资料标题命中不能引入无关记忆；原有待确认冲突排除规则继续生效。扫描最多 10,000 条、32 MiB 记忆正文，超过上限报错。
- 桌面统一问答使用相同的词与短语权重、重复词饱和和长度惩罚，在 SQL 的条数限制之前排序，并搜索任务描述、负责人和最新进展说明。任务、记忆、里程碑与日报长正文优先截取命中密集的位置，避免只传正文开头。
- 排序和节选完全在本机进行，不调用额外模型或向量服务。有限同义词与词法排序不等于通用语义检索；复杂改写、隐含指代和未列出的同义表达仍可能漏检。

## 验证方式

模块内 provider 测试通过真实 loopback TCP/HTTP 请求检查协议、分批、引用、取消及错误处理；测试服务返回预设结果，不提供真实模型质量证明。真实模型连通与中文提取效果需要使用用户显式配置的服务另行验证。
