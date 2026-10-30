# 桌面打包、签名更新与回滚

## 本地测试包

`npm ci` 后运行 `npm run desktop:build -- --ci`。Windows 默认生成当前用户范围的 NSIS 安装包，macOS 默认生成 app 和 DMG。产物在 `target/release/bundle/`。此命令未提供正式证书时生成测试包；不要描述为经过发布者签名或 Apple 公证。

`.github/workflows/desktop.yml` 在 Windows / macOS 检查桌面编译和打包，保留测试安装包14天。当前工作环境只能实际验证 Windows；macOS 矩阵需在仓库 CI 运行。

## 发布准备

`.github/workflows/release-candidate.yml` 仅手动触发，在 `desktop-release` 环境生成可审阅的签名候选包，不自动创建公开 Release。配置这些变量与 Secrets：

| 类型 | 配置 |
| --- | --- |
| 共用变量 | `PROJECT_ASSISTANT_UPDATE_URL`（HTTPS 静态 manifest URL）、`PROJECT_ASSISTANT_UPDATE_PUBKEY`（Tauri 更新公钥内容） |
| 共用 Secrets | `TAURI_SIGNING_PRIVATE_KEY`、可选 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` |
| Windows 变量 | `WINDOWS_TIMESTAMP_URL`（证书提供方的时间戳服务） |
| Windows Secrets | `WINDOWS_CERTIFICATE`（可导出的 PFX，base64）、`WINDOWS_CERTIFICATE_PASSWORD` |
| macOS Secrets | `APPLE_CERTIFICATE`（P12，base64）、`APPLE_CERTIFICATE_PASSWORD`、`KEYCHAIN_PASSWORD`、`APPLE_SIGNING_IDENTITY`、`APPLE_ID`、`APPLE_PASSWORD`（应用专用密码）、`APPLE_TEAM_ID` |

Windows 工作流适用于提供可导出证书的签名方案；如果证书必须放在硬件或托管签名服务中，应按发行方方案改为 Tauri `signCommand`，不能导出硬件私钥规避其限制。macOS runner 架构决定包架构；面向 Intel 需另加 x86_64 构建并实机验收。

本地正式打包需先安装有效的平台证书，设置上述共用环境变量及平台变量，然后：

```sh
node scripts/release-preflight.mjs
npm run desktop:build -- --ci --config src-tauri/tauri.release.local.json
```

预检只检查配置及版本一致性；真正的签名、公证和签名验证必须在构建中成功。平台签名和 Tauri 更新签名是独立环节；私钥不进入仓库、前端包、工作区或更新 manifest。更新源与公钥编译进二进制，普通工作区数据不能更改它们。

## 更新清单

将已验签安装包和 `.sig` 放到待发布目录后，准备 `release-input.json`，每个文件的 URL 必须指向实际的 HTTPS 分发位置：

```json
{
  "notes": "本次功能与兼容性说明",
  "artifacts": [
    {
      "platform": "windows-x86_64",
      "url": "https://your-release-host.example/releases/0.3.0/setup.exe",
      "signatureFile": "target/release/bundle/nsis/实际安装包.exe.sig"
    }
  ]
}
```

运行 `node scripts/update-manifest.mjs release-input.json latest.json`。脚本只生成本地清单，不上传。审核版本、文件、哈希、签名和 URL 后再发布；发布新版本时同步 package.json、package-lock.json、两个 Cargo.toml、Cargo.lock 和 tauri.conf.json 的版本。示例地址不能作为正式配置。

应用中的“桌面运行与数据保护 → 检查签名更新”显示版本说明。选择安装后重新确认版本未变化、等待草稿落盘、创建安全备份，再下载、验签和安装。未配置更新源的构建明确显示尚未配置，不能用开发服务器代替。

## 回滚

1. 升级前导出完整备份；需要离机保存时用密码加密导出，密码另外保管。
2. 数据迁移后，旧应用不能直接打开新 schema（当前12），程序会拒绝以免破坏数据。
3. 关闭新应用，保留当前完整工作区与升级前副本。安装之前的可信签名版本，用独立空工作区打开，通过其备份恢复入口导入该版本支持的升级前副本。
4. 核对项目、任务、资料和最近版本，再决定是否切换工作区。模型/飞书凭据不进入备份，需重新配置。系统凭据保护绑定当前账号及工作区路径，不能靠复制私有配置文件搬迁密钥。
5. 恢复会暂停采集、模型整理、自动备份、通知和自启动；核对恢复结果后再逐项启用。手动备份和恢复前安全副本不参与自动副本清理。

正式上线仍需真实证书、分发地址、平台安装/升级/回滚验收。参考：[Tauri Windows 签名](https://v2.tauri.app/distribute/sign/windows/)、[macOS 签名与公证](https://v2.tauri.app/distribute/sign/macos/)、[签名更新](https://v2.tauri.app/plugin/updater/)。
