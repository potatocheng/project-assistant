# Changelog

All notable changes to **循序（Cadence）** are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed & Improved
- 修复报告润色中写入习惯匹配读取 `ruleKey` 而非 `patternKey` 导致 11 条强规则在生产未触发的问题（[crates/core/src/ai.rs](crates/core/src/ai.rs)）。
- 接通已确认 `filtering` 提取偏好至文档提取上下文（`userExtractionPreferences`），以及 `default_snooze_days` 提醒暂缓偏好至主动巡检中心与快捷暂缓按钮，并过滤 <20 小时的短时暂缓噪声观察。
- 为 `rank_copilot_habits` 增加进程内候选习惯向量缓存，仅对未命中缓存的习惯增量调用 embedding 接口。
- 在 AI 副驾驶在线与离线审批卡中增加基于已确认 `workflow` 习惯的确定性参数预填（`priority` / `severity` / `assignee`），并补全离线审批卡的习惯反馈与效用归因闭环。
- 新增 AI 副驾驶长对话轮次压缩（`compactConversation`）：保留最近 2 轮完整工具结果，超出预算时将早期轮次摘要为备忘录注入系统提示并保持前端历史记录与 `toolCallId` 配对完整。
- 升级混合语义索引为语境增强向量文本（拼接类型、来源标题与分面信息，首次升级将对已有向量执行一次重算），并在后台空闲整理周期中自动执行增量向量同步（`idle_sync`，单次上限 128 条）。
- 为长文档（>2400 字）记忆提取自动生成结构化 `documentBrief`（目录大纲、关键术语定义与实体别名表）注入冻结提取上下文，助力跨段指代消解与定位。
- 后台记忆核对支持同来源待审候选批量核对（每次最多 8 条、仅消耗 1 次 `reserve()` 预算配额），纯本地可判定的候选零预算完成，且取消主任务时同步取消关联批次元运行记录。
- 升级数据库 schema 至 v17，增强库内隐性冲突巡检（[memory_audit.rs](crates/core/src/memory_audit.rs)）：支持带单位的数值指标冲突检测（`numeric_conflict`）、超过 200 条记录时启用倒排分桶召回（扫描上限提升至 2000 条），并在记忆中心新增「合并为一条（保留双方原文依据）」处理操作。
- 放宽 `source_passages` 原文隔离粒度（[source_passages.rs](crates/core/src/source_passages.rs)）：对可精确定位 `segment_id` 的过期/已修订/待审片段仅屏蔽受影响段落及前后邻段，无新证据的人工修订仍保守降级为整源屏蔽。
- 升级用户习惯感知系统（[habits.rs](crates/core/src/habits.rs)）：增加分受众/汇报类型（`executive`/`team`/`client`、`daily`/`weekly`）条件化筛选与互斥槽位隔离、连续相关性与近因衰减排序、被拒习惯 30 天/3 次新信号冷却期、润色保存逆向负反馈（`evaluate_polish_feedback`）、休眠期开放式写法差异 LLM 归纳及审批卡 `dueDate`/标题前缀偏好捕获。
- 升级混合检索为分数校准融合（[memory_query.rs](crates/core/src/memory_query.rs) 结合归一化 BM25 强度与余弦相似度）、语境增强向量文本中英文自适应去噪（[semantic.rs](crates/core/src/semantic.rs)）、检索概念覆盖度免重复分词加速及英文缩写碎片停用词清理（[search.rs](crates/core/src/search.rs)），以及日报润色模板标题/顺序与写作习惯动态对齐（[ai.rs](crates/core/src/ai.rs)）。

### Added
- 新增休眠期过程记忆主题归并模块（[memory_consolidation.rs](crates/core/src/memory_consolidation.rs)）：空闲期按实体/主题聚类多条过程记忆并生成阶段快照归并建议，经用户在记忆中心确认后更新目标记忆修订、合并全部原文依据并将旧过程记忆归档为仅存原文。
- AI 副驾驶新增 `propose_user_habit` 对话式教学工具（[pi-copilot-agent.ts](src/components/shell/pi-copilot-agent.ts)），用户在对话中明确要求写作/提醒/筛选/工作流规则时可直接入列待确认习惯建议，不绕过人工确认或修改客观事实。
- 开源社区与发布工程整备：
  - 新增自动化开源桌面发布工作流 `.github/workflows/release.yml`（推送 `v*` 标签或手动触发即可构建 Windows NSIS `.exe` 与 macOS `.dmg` 安装包并生成 `SHA256SUMS.txt`）。
  - 新增落地页自动部署工作流 `.github/workflows/pages.yml`（一键部署 `website/index.html` 至 GitHub Pages）。
  - 新增英文说明文档 `README_EN.md`、贡献指南 `CONTRIBUTING.md`、安全政策 `SECURITY.md` 与 GitHub Issue 表单模板。
- 记忆与习惯系统评测及每日结构化排期增强（持续完善中）。

### Changed
- 将 `docs/` 下 200+ MB 的历史多兆字节原始评测结果 JSON 移出主仓库工作区，保留全部 Markdown 评测报告与关键校验配置，显著提升克隆速度。

## [0.3.0] - 2026-11-25

### Added
- **全新品牌与视觉体系**：正式更名为 **循序（Cadence）**，全面统一 Ledger 账本设计体系、可打断微动效与品牌应用图标。
- **混合检索与记忆治理引擎**：引入 `jieba` 中文分词 + `sqlite-vec` 向量混合检索、用户习惯学习与空闲期冲突审计。
- **PM 全生命周期交付工作台**：
  - 「今日行动流」与早/中/晚工作节奏条。
  - 全格式办公文件直读与原文坐标溯源（`.xlsx` / `.docx` / `.pptx` / `.pdf` / `.csv` / `.eml` / `.md` / `.txt` 及微信/企微群聊粘贴）。
  - 列表视图 + 4 列拖拽任务看板 + 里程碑基线/预计对比甘特时间轴 + CSV 导出。
  - AI 副驾驶（`⌘J` / `Ctrl+J`），内置只读自动查、写入必弹人工确认卡机制。
  - 日报/周报多受众风格切换（老板摘要版 / 团队对齐版 / 客户专业版）与富文本、原生 `.docx`、2x 高清长图 `.png`、PDF 导出。
  - 4 套开箱即用 PM 行业模板与零 API Key 一键体验示例模式。
  - 可选的飞书个人账号助理（分级权限同步群聊/云文档与基于证据的 `@` 拟答）。
- **本地安全与备份保护**：支持 macOS Keychain / Windows Credential Manager 系统凭据 AES-256-GCM 加密、`remoteConsent` 外发红线、本机 Ollama 断网运行、AES-256-GCM 加密迁移包（`.pabackup`）及一键脱敏诊断导出。
- **独立展示落地页**：单文件零构建交互落地页 [`website/index.html`](website/index.html)。
