# MOMO API Codex Switch

MOMO API 的 Codex 本地连接工具。它在用户电脑上启动本地兼容服务，把 Codex 的请求按模型协议路由到 MOMO API，并同步可用模型目录。

它不需要 Docker、Podman、WSL 或 VPS。

## Windows 一键安装

在 PowerShell 中执行：

```powershell
irm "https://momoapi.us/install/momoapi-codex-switch.ps1" | iex
```

安装器会：

1. 检查 Node.js 18+；缺失时尝试通过 winget 安装 Node.js LTS。
2. 校验 MOMO API Key。
3. 从 MOMO 下载约 4 MB 的发布包，校验完整性后安装本地运行环境。
4. 不会自动下载官方 Codex CLI，也不会调用 `codex login` 或写入 OpenAI/ChatGPT 凭据；已有 Codex App 可直接使用。
5. 配置 MOMO 模型路由、启动本地服务并同步 Codex 模型目录与启动衔接配置。

安装完成后，重启 Codex，在 `/model` 中直接选择模型名，例如 `GPT-5.6 Sol`、`DeepSeek V4 Pro`、`Claude Opus 4.6 Thinking` 或 `Gemini 3.7 Flash`。

## 使用说明

- 安装时只需输入 MOMO API Key；密钥不会写入命令行参数或 PowerShell 历史记录。MOMO key 只保存在本地 Switch，不会被写入 Codex 的 `auth.json`。
- 模型列表由 MOMO API 同步，实际可用性和额度以账户权限及上游状态为准。
- Codex 通过本机 `127.0.0.1` 自定义 provider 连接 Switch，不要求 OpenAI API key、ChatGPT 登录或 OpenAI 账号池。列出的模型均使用安装时输入的 MOMO Key。
- 本地服务默认监听 `127.0.0.1`，MOMO 专用的免鉴权入口只接受本机请求。
- 安装脚本与发布包均由 `momoapi.us` 承载；Windows 依赖安装默认使用 npm 国内镜像，也可通过 `MOMO_NPM_REGISTRY` 临时覆盖。
- 仅在明确需要命令行版且本机未安装时，才使用 `-InstallCodexCli` 参数安装官方 Codex CLI。

## 支持

问题反馈请提交至 [MOMO API Issues](https://github.com/momo-api/momoapi-codex-switch/issues)。

## 开源许可与致谢

本项目基于 MIT 许可的 OpenCodeX 兼容运行时开发，并保留了其所要求的许可和版权声明。完整文本见 [LICENSE](LICENSE)。
