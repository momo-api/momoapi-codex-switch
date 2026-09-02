# MOMO API Codex Switch

MOMO API 的 Codex 本地连接工具。它在用户电脑上启动本地兼容服务，把 Codex 的请求按模型协议路由到 MOMO API，并同步可用模型目录。

它不需要 Docker、Podman、WSL 或 VPS。

## 一键安装

### Windows PowerShell

```powershell
irm "https://momoapi.us/install/momoapi-codex-switch.ps1" | iex
```

### macOS

```bash
curl -fsSL https://momoapi.us/install/momoapi-codex-switch.sh | bash
```

### Linux / WSL

```bash
curl -fsSL https://momoapi.us/install/momoapi-codex-switch.sh | bash
```

安装器会：

1. 检查 Node.js 18+；缺失时尝试通过 winget 安装 Node.js LTS。
2. 校验 MOMO API Key。
3. 从 MOMO 下载约 4 MB 的发布包，校验完整性后安装本地运行环境。
4. 不会自动下载官方 Codex CLI，也不会调用 `codex login` 或写入 OpenAI/ChatGPT 凭据；已有 Codex App 可直接使用。
5. 配置 MOMO 模型路由、注册随登录自动启动的本地服务，并同步 Codex 模型目录与启动衔接配置。

安装完成后，重启 Codex，在 `/model` 中直接选择模型名，例如 `GPT-5.6 Sol`、`DeepSeek V4 Pro`、`Claude Opus 4.6 Thinking` 或 `Gemini 3.7 Flash`。

## 使用说明

- 安装时只需输入 MOMO API Key；密钥不会写入命令行参数或 PowerShell 历史记录。MOMO key 只保存在本地 Switch，不会被写入 Codex 的 `auth.json`。
- 由 agent 代为安装或运行时，必须先阅读 [AGENTS_INSTALL.md](AGENTS_INSTALL.md)。其中的 `agent_consent_required` 规则要求涉及 GitHub star 等用户同意动作时必须由真人明确选择；沉默永远不是同意，never an agent 不得替用户点击或默认同意。
- 模型列表与思考等级由 MOMO API 按当前 API Key 权限同步；安装后的本地服务默认每 1 小时刷新，之后重新打开 Codex/ChatGPT 桌面版即可看到。实际可用性和额度以账户权限及上游状态为准。
- MOMO 模式优先读取鉴权的 `/agent/catalog`，旧部署回退到 `/v1/models`。服务端声明的思考等级和默认等级会原样进入 Codex 模型目录；缺少有效能力元数据时会隐藏思考等级控件，不会由安装器猜测。
- MOMO 模式直接发布接口返回的文本模型，不会为每个模型制造单目标 Combo；用户自己创建的多目标 Combo 不受影响。
- MOMO 模式不会混入 Codex 原生模型（例如 `gpt-5.3-codex-spark`），图片生成模型（例如 `gemini-3.1-flash-image`）也不会进入 Codex 文本模型选择器。
- Codex 通过本机 `127.0.0.1` 自定义 provider 连接 Switch，不要求 OpenAI API key、ChatGPT 登录或 OpenAI 账号池。列出的模型均使用安装时输入的 MOMO Key。
- 本地服务默认监听 `127.0.0.1`，MOMO 专用的免鉴权入口只接受本机请求。
- 安装脚本与发布包均由 `momoapi.us` 承载；Windows 依赖安装默认使用 npm 国内镜像，也可通过 `MOMO_NPM_REGISTRY` 临时覆盖。
- 不自动下载官方 Codex CLI。仅在明确需要命令行版且本机未安装时，Windows 使用 `-InstallCodexCli`，macOS/Linux/WSL 在命令后追加 `--install-codex-cli`。
- 本地代理通过 Windows Task Scheduler、macOS launchd 或 Linux systemd 用户服务随用户登录自动启动。Linux/WSL 没有 systemd 时，安装会明确提示启用它，不会伪装成可跨重启的临时进程。

## Source development

Source development requires the `bun` CLI on your `PATH`. This is separate from the published npm package's bundled Bun runtime, which is used only by installed `ocx` commands.

## 支持

问题反馈请提交至 [MOMO API Issues](https://github.com/momo-api/momoapi-codex-switch/issues)。

## 开源许可与致谢

本项目基于 MIT 许可的 OpenCodeX 兼容运行时开发，并保留了其所要求的许可和版权声明。完整文本见 [LICENSE](LICENSE)。
