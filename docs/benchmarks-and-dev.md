# 开发构建、测试验证与记忆系统评测归档

本文档记录「项目助理」的本地开发启动、自动化测试套件以及记忆系统的公开数据集实测基线与演化历程。

---

## 1. 开发启动与打包

环境要求：
- Node.js 22 LTS 或更高版本 / npm
- 由 `rust-toolchain.toml` 锁定的 Rust 工具链
- Tauri 2 系统编译环境（macOS 需 Xcode Command Line Tools；Windows 需 MSVC + WebView2）

```bash
npm install
npm run desktop:dev
```

构建安装包：

```bash
npm run desktop:build
# Apple Silicon Mac 本机测试包
npm run tauri -- build --debug --bundles app
```

打包、签名、更新源与回滚细节见 [桌面发布说明](desktop-release.md)。

---

## 2. 完整验证与回归命令

```bash
cargo fmt --all --check
cargo test -p project-assistant-core --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
npm run build
npm run verify:workbench
cargo build -p project-assistant-core --bin pm-host --locked
npm run verify:restart
npm run verify:ai
npm run verify:workflow
npm run verify:planning
npm run verify:proactive
npm run verify:retention:scoring
npm run verify:daily-use:scale
```

- `verify:restart`：验证真实 Rust 进程终止、重开与备份还原；
- `verify:ai`：使用确定性 HTTP 测试服务验证模型协议、自动候选、确认、取消、重试、密钥隔离及旧备份迁移；
- `verify:workflow`：验证任务、历史清单、日报版本、幂等与冲突、候选应用和跨版本恢复；
- `verify:planning`：验证容量必填、整理建议确认、依赖顺序、估时调整、排期幂等及重启还原；
- `verify:proactive`：使用真实 Rust 进程验证自动巡检、行动去重、项目范围、跟进持久化、完成收束、关闭与备份恢复暂停。

浏览器端使用同款 Rust 核心（开发验收专用，不打包进正式客户端）：

```bash
node scripts/qa-bridge.mjs --workspace /absolute/path/to/isolated-qa-data
VITE_QA_BRIDGE_URL=http://127.0.0.1:4174 npm run dev
```

---

## 3. 代码结构与设计文档索引

- [接口契约](contract.md)
- [记忆系统架构与边界](memory-system.md)
- [主动智能升级方案](proactive-intelligence-plan.md) / [首批实施说明](proactive-intelligence-implementation.md)
- [项目经理统一问答与验证](project-questions.md)
- [飞书个人账号助理](feishu-personal-assistant.md)
- [交付与跟进说明](p0-delivery.md) / [项目管理说明](p1-management.md) / [每日排期说明](daily-planning.md)
- [新手项目推进说明](pm-coach.md) / [日常使用交付记录](daily-use-upgrade.md)
- [第一阶段验收](phase-one-verification.md) / [第二阶段验收](phase-two-verification.md) / [第三阶段验收](phase-three-verification.md)
- [GitHub 工作流程](github-workflow.md) / [开源复用](open-source-reuse.md)

核心源码目录：
- `crates/core/src/parse.rs`、`docx_export.rs`：TXT / MD / DOCX / PDF / CSV / XLSX / PPTX / EML 多格式解析与 Word 导出
- `crates/core/src/memory.rs`、`maintenance.rs`、`feishu/`：来源采集、记忆比较、空闲整理、分级权限与代答
- `crates/core/src/ai.rs`：结构化提取、副驾驶代理转发、报告风格润色与引用校验
- `crates/core/src/settings.rs`、`protection.rs`：本机密钥隔离、系统凭据 AES-256-GCM 保护
- `crates/core/src/db.rs`、`lib.rs`、`backup.rs`：SQLite 状态、跨版本迁移、一致快照备份与恢复回滚
- `src/` & `src-tauri/`：Tauri 2 桌面宿主、Astryx/Ledger UI、AI 副驾驶、看板与甘特时间轴

---

## 4. 记忆质量与公开数据集评测归档

固定合成题集评估：

```bash
npm run evaluate:memory
```

真实模型评估（使用 `DEEPSEEK_API_KEY`）：

```bash
cargo build -p project-assistant-core --bin pm-host --locked
npm run evaluate:memory:live
npm run evaluate:memory:nonvector:live
node scripts/report-memory-nonvector.mjs
```

公开数据集（QASPER 100 题按论文隔离开发/保留集）评估与评分：

```bash
npm run verify:memory:quality
node scripts/verify-memory-extraction-optimized.mjs
npm run prepare:memory:public
npm run evaluate:memory:public
npm run evaluate:memory:public:live -- --split development --output-tag optimized-development --judge-mode separated
npm run score:memory:public:live -- docs/memory-public-live-optimized-development-results.json .local-data/optimized-development-summary.json
```

历史阶段报告归档：

> 说明：为避免仓库体积膨胀影响开源用户克隆，77 份历史多兆字节原始评测输出 JSON（约 207 MB）已从主仓库工作区归档移出（本地压缩归档于 `.local-data/`，可按需附挂至 GitHub Release）；所有 Markdown 评测总结报告、公开题集清单与预算回归测试夹具均完整保留。

- 评估维度与方法：[memory-evaluation.md](memory-evaluation.md) / [memory-evaluation-report.md](memory-evaluation-report.md)
- 公开数据集说明：[memory-public-datasets.md](memory-public-datasets.md)
- 提取优化复测报告：[memory-extraction-optimized-report.md](memory-extraction-optimized-report.md)
- 检索、上下文与拒答优化：[memory-retrieval-optimization-plan.md](memory-retrieval-optimization-plan.md) / [memory-retrieval-optimized-report.md](memory-retrieval-optimized-report.md)
- 回答可靠性与 Token 优化：[memory-qa-efficient-plan.md](memory-qa-efficient-plan.md) / [memory-qa-efficient-report.md](memory-qa-efficient-report.md)
- 目标校准与增量回答诊断：[memory-qa-calibrated-report.md](memory-qa-calibrated-report.md) / [memory-qa-targeted-report.md](memory-qa-targeted-report.md) / [memory-qa-structured-report.md](memory-qa-structured-report.md)
