# 安全政策 · Security Policy

**循序（Cadence）** 是一款 Local-First（本地优先）桌面应用，所有项目资料、原文依据与数据库均默认保存在用户本机硬盘，详细边界见 [本地数据隐私与安全白皮书](PRIVACY.md)。

## 支持的版本 / Supported Versions

| 版本 | 是否提供安全修复 |
| --- | --- |
| 最新正式发布版本（`v0.3.x`） | ✅ 支持 |
| `main` 分支 | ✅ 支持 |
| 更早的测试快照 | ❌ 不再维护，请升级至最新版本 |

## 如何报告安全漏洞 / Reporting a Vulnerability

如果你发现了潜在的安全隐患（例如：本地密钥泄漏、未经授权的数据外发、路径穿越、备份加解密缺陷、Tauri 权限越界或恶意文档解析问题），请 **不要在公开 Issue 中直接披露可复现利用细节**。

请通过以下方式私密反馈：

1. 在 GitHub 仓库页面打开 **Security → Advisories → Report a vulnerability**（推荐）。
2. 提交报告时请尽量包含：
   - 影响的版本号与操作系统（Windows / macOS）。
   - 最小化复现步骤与预期/实际行为。
   - **切勿在报告中附带真实 API Key、飞书 Token 或任何公司机密业务文档**。

我们会在确认问题后尽快响应、定位并发布修复版本。

## 关于未签名安装包校验 / Verifying Open-Source Builds

- 开源社区版安装包在 [GitHub Releases](https://github.com/potatocheng/project-assistant/releases) 均附带 `SHA256SUMS.txt` 校验文件，下载后建议核对哈希值。
- 如对桌面二进制有严格的企业内审要求，可直接审查源码并执行 `npm ci && npm run desktop:build` 本地自行构建。
