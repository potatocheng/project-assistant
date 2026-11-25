# 参与贡献 · Contributing to Cadence (循序)

欢迎为 **循序（Cadence）** 提交 Issue、改进文档或贡献代码！无论是修复 Bug、补强文档解析格式、优化项目经理工作流，还是完善多语言界面，我们都非常欢迎。

---

## 1. 开发环境准备 / Prerequisites

- **Node.js**：22 LTS 或 24（与 CI 一致）
- **Rust**：仓库根目录 [`rust-toolchain.toml`](rust-toolchain.toml) 锁定的工具链
- **Tauri 2 系统依赖**：
  - **Windows**：Visual Studio C++ Build Tools + WebView2
  - **macOS**：Xcode Command Line Tools

```bash
git clone https://github.com/potatocheng/project-assistant.git
cd project-assistant
npm ci
```

## 2. 本地运行 / Running Locally

### 桌面客户端热重载（推荐）

```bash
npm run desktop:dev
```

### 浏览器 + 同款 Rust 核心（快速调试 UI）

```bash
cargo build -p project-assistant-core --bin pm-host --locked
node scripts/qa-bridge.mjs --workspace /absolute/path/to/isolated-qa-data
# 另开终端
VITE_QA_BRIDGE_URL=http://127.0.0.1:4174 npm run dev
```

## 3. 提交前必须通过的检查 / Verification Checklist

请根据修改范围运行对应检查（完整列表与 CI [.github/workflows/checks.yml](.github/workflows/checks.yml) 一致）：

```bash
# 前端构建与模型单测
npm run build
npm run verify:workbench
npm run verify:daily-structure
npm run verify:coach

# Rust 核心格式、单测与 Lint
cargo fmt --all --check
cargo test -p project-assistant-core --locked
cargo clippy -p project-assistant-core --all-targets --locked -- -D warnings

# 端到端核心工作流验证
cargo build -p project-assistant-core --bin pm-host --locked
npm run verify:restart
npm run verify:ai
npm run verify:workflow
npm run verify:proactive
```

## 4. 项目核心红线 / Core Design Guardrails

贡献代码时请务必遵守以下原则（详见 [PRIVACY.md](PRIVACY.md) 与 [docs/contract.md](docs/contract.md)）：

1. **Local-First & 零埋点**：绝不引入云端账号、后台遥测或未经显式勾选同意（`remoteConsent`）的外部数据外发。
2. **原文可溯源**：任何记忆提取、问答与汇报结论必须保留原文依据坐标，不编造不存在的任务、日期或负责人。
3. **人工拍板红线**：AI 副驾驶与主动巡检可以自动只读查询，但任何修改任务、创建风险或改动排期的写入操作都必须经过用户确认。
4. **密钥与备份隔离**：API Key 和 OAuth 令牌只留在 `secrets/`，绝不写入 SQLite、日志或导出备份。
5. **仓库体量控制**：不要将大体积测试数据、本机数据库（`*.sqlite`）或原始多 MB 评测日志直接提交进仓库。

## 5. 提交 PR 流程 / Pull Request Flow

1. 从 `main` 拉取语义化分支（如 `feat/csv-import-encoding`、`fix/gantt-timezone`）。
2. 提交记录建议采用 Conventional Commits 风格（`feat:` / `fix:` / `docs:` / `refactor:` / `test:`）。
3. 在 PR 描述中写清楚「改动动机」「对原文依据/历史版本/备份恢复的影响」以及实际跑过的验证命令。
