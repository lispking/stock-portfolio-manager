# Anthropic Claude 模型支持 设计

日期：2026-08-17
状态：已确认

## 背景

用户希望在 AI 配置中支持 Anthropic Claude 官方 API。现有系统所有提供商统一走 OpenAI 兼容 `/chat/completions`，但 Anthropic 官方 API（`api.anthropic.com`）使用完全不同的 `/v1/messages` 协议：认证头（`x-api-key` + `anthropic-version`）、请求格式（`system` 独立字段、`content` 块）、SSE 事件（`content_block_delta`/`message_delta`）、工具调用（`tool_use` 块）均不同。

## 决策

- **接入方式**：官方 API 新协议（用户确认）
- **模型列表**：Anthropic `/v1/models` 端点（需 API key）
- **工具调用**：支持（复用现有 `execute_tool` 执行逻辑，转换工具定义格式）
- **前端**：提供商列表加 "Anthropic"，其余 UI 不变

## 架构

在 `ai_chat_service.rs` 中按 `cfg.provider == "anthropic"` 分支，走独立的 Anthropic 请求/解析路径，**复用**：
- `build_portfolio_context`（上下文构建）
- `resolve_active_skills` / `build_skill_system_message`（技能激活）
- `execute_tool(ctx, name, args)`（工具执行，`ai_tools.rs:471`）
- 前端 `ai-chat-*` 事件协议不变

### Anthropic 协议差异

| 维度 | OpenAI 兼容（现有） | Anthropic `/v1/messages` |
|---|---|---|
| 端点 | `{base}/chat/completions` | `{base}/v1/messages` |
| 认证 | `Authorization: Bearer` | `x-api-key` + `anthropic-version: 2023-06-01` |
| system | messages 里的 system role | 独立顶层 `system` 字段 |
| 消息 | `{role, content}`（content 字符串） | `{role, content: [{type:"text", text}]}`；assistant 工具用 `content: [{type:"tool_use",...}]` |
| SSE | `data: {...}` + `[DONE]` | `event:` 行 + `data:`，事件：`content_block_start/delta/stop`、`message_delta`、`message_stop` |
| 工具 | `tools: [{type:"function", function:{name, parameters}}]` | `tools: [{name, description, input_schema}]`；响应 `tool_use` 块 |
| 流式增量 | `delta.content` / `delta.tool_calls[]` | `delta.type:"text_delta"→text` / `"input_json_delta"→partial_json` |

### 实现要点

1. **模型列表**（`ai_models_service.rs`）：`resolve_base_url` 加 `"anthropic" => "https://api.anthropic.com"`；`fetch_models` 对 anthropic 用 `GET {base}/v1/models` + `x-api-key` 头
2. **聊天流式**（`ai_chat_service.rs`）：新增 `chat_stream_anthropic` 函数（独立请求/SSE 解析/工具循环），在 `chat_stream` 入口按 provider 分发
3. **工具定义转换**：`tool_definitions()` 保持 OpenAI 格式；对 anthropic 转换 `{type:"function",function:{name,description,parameters}}` → `{name,description,input_schema}`；响应端解析 `tool_use` 块 → 复用 `execute_tool`
4. **工具调用消息**：Anthropic 要求 assistant 消息含 `tool_use` 内容块 + 后续 `tool_result` 用户消息；转换现有 `append_tool_result` 逻辑
5. **前端**（`AI/index.tsx`）：`PROVIDERS` 加 `{value:"anthropic", label:"Anthropic", hint:"Claude 官方 API（Anthropic Messages 协议）", default_base_url:"https://api.anthropic.com", needs_key:true, key_placeholder:"sk-ant-..."}`

## 测试

- `ai_models_service`：anthropic base URL 解析
- `ai_chat_service`：Anthropic 请求体构造（system 独立、content 块）、SSE 解析（text_delta/input_json_delta）、工具调用往返
- 手动：配置 Anthropic key → 获取模型 → 对话 → 工具调用
