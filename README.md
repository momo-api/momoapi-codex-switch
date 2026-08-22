# MOMO API Codex Switch

MOMO API 的 Codex 本地连接工具。它在用户电脑上启动本地兼容服务，把 Codex 的请求按模型协议路由到 MOMO API，并同步可用模型目录。

它不需要 Docker、Podman、WSL 或 VPS。

## Windows 一键安装

在 PowerShell 中执行：

```powershell
irm "https://raw.githubusercontent.com/momo-api/momoapi-codex-switch/main/install/windows.ps1" | iex
```

安装器会：

1. 检查 Node.js 18+；缺失时尝试通过 winget 安装 Node.js LTS。
2. 校验 MOMO API Key。
3. 下载约 3 MB 的 MOMO 发布包并安装本地运行环境。
4. 缺失时安装官方 Codex CLI；不会调用 `codex login` 或写入 OpenAI/ChatGPT 凭据。
5. 配置 MOMO 模型路由、启动本地服务并同步 Codex 模型目录与启动衔接配置。

安装完成后，重启 Codex，在 `/model` 中选择 MOMOAPI 模型。

## 使用说明

- 安装时只需输入 MOMO API Key；密钥不会写入命令行参数或 PowerShell 历史记录。MOMO key 只保存在本地 Switch，不会被写入 Codex 的 `auth.json`。
- 模型列表由 MOMO API 同步，实际可用性和额度以账户权限及上游状态为准。
- Codex 通过本机 `127.0.0.1` 自定义 provider 连接 Switch，不要求 OpenAI API key 或 Codex CLI 登录。远程插件发现默认关闭，避免未登录时产生 ChatGPT 401 警告。
- 本地服务默认监听 `127.0.0.1`，MOMO 专用的免鉴权入口只接受本机请求。

## 支持

问题反馈请提交至 [MOMO API Issues](https://github.com/momo-api/momoapi-codex-switch/issues)。

## 开源许可与致谢

本项目基于 MIT 许可的 OpenCodeX 兼容运行时开发，并保留了其所要求的许可和版权声明。完整文本见 [LICENSE](LICENSE)。
