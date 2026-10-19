# 项目助理 · 本地工作助理

**Tauri 2 + Rust 核心 + React / TypeScript + SQLite**。资料、记忆、任务、进展、日报和备份保存在本机。桌面通过 IPC 调用 Rust，无需自建服务器。开启云端 AI 后，选中的资料文本会发送给你配置的模型服务。

## 当前版本：0.3.0

1. 创建项目，导入资料，核对带原文依据的记忆和任务候选。AI 提取需自行配置模型；人工整理与以下工作流程无需模型密钥。
2. 在“任务”新建事项，选择“我的执行”或“跟进他人交付”，设置负责人、优先级、计划日期和截止日期；也可从已确认记忆创建任务，固定对应的记忆版本和依据。
3. 在“每日清单”按日期和项目查看当天安排、未结和逾期事项。无日期的事项保留在任务池，可再加入指定日期。
4. 打开任务记录进度、状态和说明。每次修改保存业务日期、修改前后状态及版本，冲突时重新加载核对；来源资料与人工进展分别保留。
5. 在“日报”选择日期与项目，本地整理当天事件、阻塞与后续安排。完成后重新打开的事项不会列为当天完成；其他日期的完成事项不会冒充当天成果。
6. 核对日报依据，编辑后保存新版本，可查看旧版本、复制或导出 Markdown。日报不自动发送给他人。

清单和日报按所选日期的历史状态生成，之后的改名、进度或重新打开操作不会污染历史快照。工作日期不能早于该任务最后一条进展日期；录入时间另行保留。日报使用本地规则整理已记录的事实，当前不调用模型润色。

AI 任务候选可以确认成新任务，也可以关联同项目的已有任务。关联时明确展示状态和进度的前后比较，确认后才更新，保留原有任务名称、负责人及排期。AI 不自行识别“我”，个人执行与跟进角色由用户选择。

## 第二阶段：自动提取候选

1. 打开“模型设置”。DeepSeek 预设为 `https://api.deepseek.com`、`deepseek-flash`、JSON 对象输出，也可配置其他兼容 API 或本机 Ollama。
2. 在应用中输入自己的 API Key 并保存。点击“测试连接”，使用一段内置合成文字验证认证、模型和结构化输出，不发送项目资料。
3. 核对服务地址，勾选同意发送资料并开启“新资料自动提取”。设置影响以后导入的资料；已有资料需要逐份点击“开始提取”。
4. 导入文字、Markdown、DOCX 或可提取文字的 PDF。原文解析完成后，独立后台任务调用模型；界面显示排队、批次进度及结果。
5. 核对 AI 候选的内容与原文引用，可先编辑、忽略或确认。**只有用户确认才创建正式记忆**。引用能逐字匹配原文不等于内容必然正确，仍需核对表达与语义。
6. 提取失败可重试，运行中可取消。取消后不会写入迟到结果；已发送的模型请求可能已经产生服务费用。没有自动网络重试。

记忆提取类型：项目事实、决策、需求、风险；同次提取可生成独立的任务候选。相对时间保留原文表达，等待用户核定日期。人工整理入口仍然可用。办公平台自动接入、语义检索与自动记忆合并尚未实现。

## 记忆与恢复

- SQLite 是正式状态的唯一存储；原件单独保存，证据引用稳定的片段 ID。DOCX 保留段落/表格定位，PDF 保留页面定位。
- 候选保留人工/AI来源、模型、提示版本、提取任务和原文摘录；编辑不抹掉来源。修订正式记忆必须写原因，旧版本与依据完整保留。
- 原文解析与模型请求使用独立工作线程，不阻塞数据库线程。提取完整成功后一次提交候选；错误引用不会进入正式记忆。
- 重启恢复未完成任务；取消任务不自动复活。旧版本工作区自动事务迁移，仍可恢复第一阶段备份。
- 还原先校验完整性与数据约束，再自动创建当前状态安全副本。旧工作任务的迟到结果不能写入还原后的工作区。
- **从备份还原的 AI 任务会暂停**，需要手动重试后才会调用模型。还原保留本机模型设置，不从备份导入凭据。
- 第三阶段备份包含任务、原文依据、全部进展事件、任务候选和日报各版本；校验引用及领域约束后整体还原。兼容第一、二阶段备份，迁移不会虚构任务和日报。

## 密钥与本地数据

- macOS 默认目录：`~/Library/Application Support/com.projectassistant.desktop/workspace`，应用内可查看实际位置。
- 密钥和设备模型设置位于工作区 `secrets/ai-settings.json`，不写入 SQLite、任务记录、日志或备份；读取接口只返回是否已配置密钥。端点变更时清除旧密钥，防止误发到另一服务。
- 当前密钥文件采用用户专属目录/文件权限（Unix 0700/0600），**尚未接入系统钥匙串，也不声称文件内容已加密**。
- 备份为未加密 ZIP，包含一致数据库快照、原件和校验清单，不包含其他备份、模型设置或密钥。
- 默认不自动调用模型。云端外发只发生在用户配置并授权之后；本机 Ollama 仅允许回环地址。
- `PROJECT_ASSISTANT_DATA_DIR` 可指定隔离工作区。开发和验收全部使用隔离目录，不写入正式资料。

## 直接体验测试版

交付目录中的 `项目助理-macOS-arm64测试版.zip` 适用于 Apple Silicon Mac。解压后打开 `项目助理.app`。这是本地测试构建，尚未完成正式开发者签名与公证。

首次打开是空工作区。“先看看示例”会在你主动导入后建立样例资料。云端使用自己的模型账户，应用不附带 API Key。

## 开发启动

需要 Node.js 22 LTS 或更高版本 / npm、由 `rust-toolchain.toml` 锁定的 Rust、系统 Tauri 编译环境。macOS 使用 Xcode Command Line Tools。

```bash
npm install
npm run desktop:dev
```

构建：

```bash
npm run desktop:build
# Apple Silicon Mac 本机测试包
npm run tauri -- build --debug --bundles app
```

## 验证

```bash
cargo test -p project-assistant-core
cargo clippy --workspace --all-targets -- -D warnings
npm run build
cargo build -p project-assistant-core --bin pm-host
npm run verify:restart
npm run verify:ai
npm run verify:workflow
```

`verify:restart` 验证真实 Rust 进程终止、重开与备份还原；`verify:ai` 使用明确标注的确定性 HTTP 测试服务验证模型协议、自动候选、确认、取消、重试、密钥隔离及旧备份迁移；`verify:workflow` 验证任务、历史清单、日报版本、幂等与冲突、候选应用和跨版本恢复。测试**不代表真实 DeepSeek 的提取质量验收**，真实云端验收需在应用中配置自己的密钥并测试。

浏览器界面验收使用同一个 Rust 核心，无模拟持久化：

```bash
node scripts/qa-bridge.mjs --workspace /absolute/path/to/isolated-qa-data
VITE_QA_BRIDGE_URL=http://127.0.0.1:4174 npm run dev
```

桥接服务只监听本机并校验来源，不被打包进应用；桌面始终优先 Tauri IPC，只有开发浏览器才启用 HTTP 桥。

## 代码与设计

- `crates/core/src/ai.rs`：结构化模型协议、分批、引用校验。
- `crates/core/src/settings.rs`：本机配置、密钥权限与脱敏接口。
- `crates/core/src/db.rs`、`lib.rs`：数据库、迁移、工作线程与持久化任务。
- `crates/core/src/tasks.rs`：任务事件、历史清单、任务候选确认与本地版本化日报。
- `crates/core/src/backup.rs`：一致快照、完整性检查与还原回滚。
- `src/`：工作台、模型设置、提取状态与候选确认。
- `scripts/`：开发和验收工具，不是产品模型实现。
- [接口契约](docs/contract.md)、[第一阶段验收](docs/phase-one-verification.md)、[第二阶段验收](docs/phase-two-verification.md)、[第三阶段验收](docs/phase-three-verification.md)、[开源复用](docs/open-source-reuse.md)。

## GitHub 管理

源码与设计文档保存在公开仓库 [potatocheng/project-assistant](https://github.com/potatocheng/project-assistant)，`main` 为默认分支。日常功能通过分支和 Pull Request 审阅，GitHub Actions 检查前端构建、Rust 核心与本地完整流程；不会自动发布桌面包，也不会上传应用中的项目资料。详见 [GitHub 工作流程](docs/github-workflow.md)。

DeepSeek 接口配置依据其[官方入门文档](https://api-docs.deepseek.com/zh-cn/)和 [JSON 输出说明](https://api-docs.deepseek.com/guides/json_mode/)。模型名称可在设置中修改，以你账户实际可用模型为准。
