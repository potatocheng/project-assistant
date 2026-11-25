# Changelog

All notable changes to **循序（Cadence）** are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
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
