
# MomoCodex (MomoAPI 专属轻量版) 产品需求文档 (PRD)

| 文档版本 | 状态 | 编写日期 | 目标发布 |
| :--- | :--- | :--- | :--- |
| **v1.0.0** | 待评审 / 实施中 | 2026-09-02 | MomoCodex Release |

---

## 1. 背景与核心痛点

### 1.1 现状与背景
OpenCodex 原生架构定位于“多厂商聚合与逆向客户端”（涵盖 Google Antigravity OAuth、Cursor 逆向、AWS Bedrock、Vertex、Kiro 等）。这导致系统内存在大量复杂的账户状态机、OAuth 轮询刷新、项目绑定和庞大的 Combo 映射机制。

### 1.2 核心痛点
1. **配置极其繁琐**：对接 MomoAPI 时，用户被迫将同一个 API Key 拆分配置到 3 个独立的 Provider（momo-claude、momo-gemini、momo-responses），且需要配置冗长的 Combo 别名列表。
2. **模型与思考等级脱节**：MomoAPI 上线新模型或调整思考等级（reasoning_efforts）时，本地客户端无法实时同步，容易因思考等级映射缺失导致 400 报错。
3. **协议边界脆弱**：Gemini/Claude 对尾部轮次（Assistant/Model Tail）有严格限制，若无完善的末尾防护（Tail Guard）和签名透传，频繁引发请求拒绝。
4. **冗余代码庞大**：70% 以上的代码都在服务不需要的 OAuth、网页端抓取和逆向工程，导致调试困难、维护成本高。

---

## 2. 产品定位与目标

打造 **MomoAPI 专属的超轻量、零维护、高兼容中转代理（MomoCodex）**。

- **单 Key 极简驱动**：用户仅需提供一个 MOMO_API_KEY（或极简 JSON 配置），开箱即用。
- **模型与能力全自动同步**：自动从 https://momoapi.us/agent/catalog 同步最新可用模型及其支持的思考等级（reasoning_efforts），支持启动加载与定时热更新。
- **智能单入口协议分发**：对外提供统一的 OpenAI/Codex 兼容接口；对内根据模型自动分派到最佳流式协议内核（Claude -> Anthropic Wire, Gemini -> Google Wire, GPT/DeepSeek -> OpenAI Wire）。
- **坚如磐石的协议鲁棒性**：内置完整的 Tail Guard、Thought Signature 保持、Tool Call 准确映射。
- **代码瘦身 70%+**：彻底剥离所有无关的 OAuth 账户系统与第三方逆向模块。

---

## 3. 功能模块详细设计

### 3.1 极简配置与启动引擎
- **环境变量优先**：支持 MOMO_API_KEY、MOMO_BASE_URL（默认 https://momoapi.us）。
- **极简配置文件**：
```json
{
  "apiKey": "sk-momo-xxxxxxxxxxxxxxxx",
  "baseUrl": "https://momoapi.us",
  "autoSync": {
    "enabled": true,
    "intervalMinutes": 60
  }
}
```
- 移除所有复杂的 combos、managedModelIds、disabledModels 手动维护逻辑。

### 3.2 自动模型发现与思考等级热同步 (Auto-Sync)
- **拉取端点**：优先请求 GET https://momoapi.us/agent/catalog（携带 Bearer Auth），若失败则降级到 GET /v1/models。
- **元数据解析**：
  - 解析每个模型的支持状态：state: supported / unsupported
  - 解析思考等级阶梯：efforts: [low, medium, high, xhigh]
  - 解析默认思考等级：default_effort
- **动态热注册**：
  - 自动将拉取到的模型列表注册到本地 Codex 目录中。
  - 自动生成各模型在流式请求时的思考等级映射字典，避免协议转换 400。
- **后台定时刷新**：支持配置定时器（默认 60 分钟）静默轮询同步，MomoAPI 上线新模型无感即刻可用。

### 3.3 智能统一路由分发 (Smart Router)
当 Codex 发送模型调用请求时，代理内部根据模型名称与 Catalog 特征自动分流：
1. **Claude 系列**（如 claude-opus-4-6-thinking, claude-sonnet-4-5）-> 路由至 **Anthropic 协议内核**，直连 momoapi.us/v1/messages。
2. **Gemini 系列**（如 gemini-3.7-flash, gemini-3-pro）-> 路由至 **Google 协议内核**，直连 momoapi.us/v1beta/models。
3. **GPT / DeepSeek / 通用系列**（如 gpt-5.4, deepseek-v4-pro）-> 路由至 **OpenAI Responses/Chat 协议内核**。

### 3.4 协议健壮性保障
- **Tail Guard (末尾轮次保护)**：
  - Anthropic 与 Gemini 适配器统一加入尾部检查：当历史记录为空或以 assistant / model 结尾时，自动追加 role: user, content: "(continue)"，消除 Requests ending with a model turn are not supported 错误。
- **Thought Signature 透传**：
  - 保证多轮推理工具调用中的思维签名（thoughtSignature）完整跨轮传递，避免长思考链断裂。
- **Tool Call 准确映射**：
  - 保证参数名称合规转换与 Tool Call ID 双向绑定。

### 3.5 废弃模块清理清单 (Clean-up Scope)
| 模块类别 | 清理目标 | 说明 |
| :--- | :--- | :--- |
| **OAuth 账户系统** | Google Antigravity Onboarding, Refresh Token 轮询, 本地持久化证书 | 纯 API Key 模式无需 OAuth |
| **第三方逆向适配器** | Cursor 逆向, Vertex 企业鉴权, AWS Bedrock, Kiro | 不再承载 Momo 以外的异构云厂商 |
| **多余配置层** | 复杂的 Combo 映射、手动 disabledModels 过滤 | 统一由 Momo Auto-Sync 驱动 |

---

## 4. 实施路线图 (Roadmap)

1. [第一阶段] 完善内核防护与基础验证 (已就绪 - Tail Guard)
2. [第二阶段] 建立 Momo 统一路由与自动模型同步强化 (单 Provider 入口 + Catalog 动态绑定)
3. [第三阶段] 冗余模块精简与代码瘦身 (清理无用 OAuth 与异构适配器)
4. [第四阶段] 自动化测试与打包交付 (多模型流式及热更新测试)
