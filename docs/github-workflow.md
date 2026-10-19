# GitHub 管理

代码保存在公开仓库 [potatocheng/project-assistant](https://github.com/potatocheng/project-assistant)，默认分支为 `main`。GitHub 保存代码与设计文档；应用运行仍然无需自建服务器，也不会把项目资料同步到 GitHub。

## 提交范围

提交 Rust、React / TypeScript 源码、依赖锁文件、设计文档和合成测试资料。忽略规则排除本机工作区、原件、备份、数据库、模型密钥、环境配置、截图、依赖与构建产物。历史版本迁移用的两份合成 ZIP 在测试目录中明确保留。

正式资料使用应用的“备份中心”保存和还原，GitHub 不能代替工作区备份。桌面安装包按需要单独交付，当前不配置自动发布。

## 日常开发

小修改可以在本地 `main` 完成检查后提交、推送。功能开发建议从最新 `main` 建立 `feat/功能名` 分支，完成后提交 Pull Request；修复使用 `fix/问题名`。提交描述具体行为变化。

```bash
git switch main
git pull --ff-only
git switch -c feat/example
# 修改、验证后
git add <相关文件>
git commit -m "feat: describe the behavior change"
git push -u origin feat/example
gh pr create
```

不在代码、提交信息或 Issue 中放 API Key、原始聊天或真实项目资料。示例与验收使用合成内容。

## 自动检查

推送 `main`、提交 Pull Request 或手动运行时，GitHub Actions 执行前端类型检查与生产构建、Rust 格式与核心测试、核心 Clippy，以及真实 Rust 进程的重启、备份、AI 协议夹具和每日工作流程回归。模型测试只连接本机确定性夹具，不需要真实模型密钥。

CI 只读仓库，不自动发布应用。macOS 桌面构建与原生界面、系统保存对话框、剪贴板仍需在 Mac 验收。工作流采用 GitHub 官方 [checkout](https://github.com/actions/checkout) 与 [setup-node](https://github.com/actions/setup-node)，锁定已核实的提交版本。
