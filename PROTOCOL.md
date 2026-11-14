# Comate SaaS 协议笔记（2026-11-13 调研）

> 本文件属于 [httpdone/magpie-comate](https://github.com/httpdone/magpie-comate)。

来源：Open VSX `BaiduComate.comate` 4.8.0（`dist/comate-engine/server.js`，未混淆；`dist/extension.js` 为 javascript-obfuscator 混淆）、
npm `@comate/comatecli` 2.0.0 / `@comate/zulu` 1.7.21（`dist/zulu/*.js`，压缩未混淆）；第三方 `@cc-api/cli` 1.3.4 作交叉印证。

## 鉴权
- SaaS 下 license 就是凭据，**没有 token 交换、没有签名**。`kernel.config.key = license`。
- 请求头（`getRequestUserHeader`）：`login-name` / `Uuap-login-name` = encodeURIComponent(license)，`X-Source: COMATE`，
  `plugin-version: <ide>-<pluginVersion>`（如 `zulucli-4.13.0`），`x-skip-fcnap: yes`，`X-Trace-Id: <uuid>`。
- 请求体（`getRequestClienInfo`）：`username = license`，`ide`，`ideVersion`，`pluginVersion`。
- license 在 [个人中心](https://comate.baidu.com/zh/user) 获取；本插件登录时让 magpie 打开该页面（OpenCode oauth `method: "code"`），用户粘贴 license 作为 code，回调里校验后作为账号 key 保存。
- 校验：`GET https://comate.baidu.com/api/key/valid/{license}` → `{"status":"OK","data":true}`；无效时 HTTP 200 + `{"status":"FORBIDDEN","data":false}`（已实测）。
- 无效 license 调 autowork 接口：HTTP 200 + `{"code":401,"message":"当前License信息无效…"}`（已实测）。

## 模型
- `GET /api/v2/api/models/available?key=<license>&type=ZULU&loopVersion=v2[&zuluVersion=…&source=plugin]`
  → `{"status":"OK","data":[{modelId, displayName, provider, requestType, supportImage, supportThinking, supportAdaptiveThinking, supportEffort, maxContextWindow, ratio, thinkingConfig:{switchable}, effortConfig:{levels:[{value}]}, …}]}`。
  无效 license 时只返回 `auto`（已实测）。有效 license（2026-11-14 实测）返回 15 个模型，**没有 `auto`**：
  `modelId` 带后缀（如 `glm-5.3_<hash>`），`maxContextWindow` 为 K（1024/1000/512/256/200），
  `ratio` 为字符串（`"0.1x"`…`"1x"`），`supportThinking` 全为 true，`thinkingConfig` / `effortConfig` 全为 null；
  另有顶层 `switchable`、`supportEffort`（如 `"max"`/`"medium"`/null）、`modes:["NORMAL","MAX"]` 等字段，官方 comatecli 不读，本插件也不用。

### 模型参数（客户端代码中的用法）
- `maxContextWindow` 单位是 K tokens：VS Code 扩展 `chat.js` 用 `1e3*Number(maxContextWindow)`，显示为 `200K` / `1M`（≥1024 显示 M）。
- `ratio` 是计费倍率，原样显示在模型名旁。
- `requestType`：服务端路由的 `auto`（只在无效 license 时见过）为 `COMATE_DEFAULT_MODE`，其余 `COMATE_MULTIPLE_MODE`。
- comatecli 2.0：选模型时只有 `thinkingConfig.switchable` 才问思考开关（默认开），只有 `effortConfig.levels` 存在才问档位（默认 `defaultLevel`）；
  `execute` 只在选了时带 `thinkingEnabled` / `effort`，`auto` 两者都不带。请求体里没有 max_tokens / temperature / top_p。
- 本插件只用上面这些接口字段，不按模型名推断任何参数。

## Agent 执行（base：`https://comate.baidu.com/api/aidevops/autocomate/rest/autowork`）
- `POST /v2/conversation` body=clientInfo → `{code:200, data:{id}}`
- `POST /v2/task` body={conversationId, agentId, agentInfo, …clientInfo} → `{code:200, data:{taskId}}`
- `POST /v2/execute`（SSE）body 主要字段：`taskId, conversationId, agentId, query, modelKey, thinkingEnabled, effort, isUserQuery, isFirstQuery, systemReminder, toolUseResults[], contexts[], sysInfo, uploadBaseInfo, agentInfo, agentVersion, subAgents, extendUserQueryInfo, extend`。
  非 SSE 时返回 JSON 错误信封（401/429…）。另有 `/v2/execute-sync`（`{frames:[…]}`，2.0 新增）。
- SSE：`data:{"sessionId"?, "content":{"type", "detail":{delta?, reasoningDelta?, toolUse?:[{id,name,input}], end?, usage?}}}`，`:heartbeat` 注释行。
  type：`ANSWER`、`FUNCTION_CALL_START|PARAMS_APPEND|PARAMS_MERGE|END`、`TOKEN_USAGE`（usage={inputTokens,cachedInputTokens,outputTokens}）、
  `NOTIFICATION`、`EXCEPTION`（detail.exceptionMsg）、`QUOTA_EXCEED`、`DOWNGRADE`、`NEED_RETRY_EXCEPTION`。
- 工具结果回传（下一次 execute，`isUserQuery:false, query:""`）：`toolUseResults:[{id, name, success, params, message}]`。

## 多轮复用（官方客户端怎么做）
来源：`@comate/comatecli` 2.0.0 `dist/zulu/chunk-riLt5CoU.js`（`apiPostConvesation`、`ParameterCollector.start`、Conversation 的 roundtrip 逻辑、`prepareParameterCollectorForResume`），VS Code 扩展 `server.js` 同构。
- `apiPostConvesation`：传入的 `conversationId` 有效（非空且 ≠ -1）就**不调** `/v2/conversation`；`taskId` 有效就**不调** `/v2/task`。只有缺失时才创建。
- 新的用户轮次：`if (previousRoundtrip) { conversationId = prev.context.conversationId; taskId = prev.context.taskId; toolUseResults = getLastToolTurnResults(prev.toolTurns) }`，
  然后 `parameterCollector.start({ query: <仅本轮用户输入>, conversationId, taskId, … })`。`isFirstQuery = !(conversationId||taskId) && !previousRoundtrip`，即续用时为 false/不发送。
  → 同一会话、同一任务承载多轮；每轮只发本轮 query（不重发历史）；服务端保存历史（另有 `/v1/compress {taskId}`、`needCompression`、`rollbackMessageId` 等基于服务端历史的能力）。
- 工具结果续跑同一任务：`updateParams({query:"", isUserQuery:false, isFirstQuery:false})` 后再 `execute`，`toolUseResults:[{id,name,success,params,message}]`（`buildToolUseResult`），id 为服务端下发的 toolId。
- 编辑历史：官方用 `rollbackMessageId` 让服务端回滚；本插件不用，直接新建会话。
- 第三方 `@cc-api/cli` 的 Anthropic 路由也复用会话（把 conv/task 签名藏在回复里，后续请求只发最新 query + toolUseResults，`systemReminder` 只在首轮发送），可作为对线上服务可行性的旁证。
- 本插件：缓存键为消息链哈希（见 README），续用时只发增量；XML 工具结果作为 `<tool_result>` 文本 + `isUserQuery:true`，透传的原生工具结果走 `toolUseResults` + `isUserQuery:false, query:""`。

## 工具（官方客户端怎么处理）
来源：comatecli 2.0.0 `dist/zulu/chunk-riLt5CoU.js`、`@comate/zulu` 1.7.21 `dist/bundle/chunk-BmwAFCfc.js`、VS Code 扩展 `dist/comate-engine/server.js`（三者同构），以及 `@cc-api/cli` 1.3.4 `cc-api`。
- **工具集由服务端固定**：`execute` 没有工具定义字段。客户端只按名字实现（`case"use_mcp_tool":return new McpTool(…)` 等工厂；别名表 `V10_TOOL_ALIASES`：read_file、write_file、edit_file、run_command、grep_content、glob_path、list_dir、codebase_search、web_search、web_fetch、todo_write、skill、use_mcp_tool、ask_user_question、create_plan、delegate_subagent…）。子 agent 只能通过 `toolNames`/`disallowedToolNames` 选择内置工具的名字。
- **调用是结构化事件**：`FUNCTION_CALL_START / PARAMS_APPEND / PARAMS_MERGE / END`，`detail.toolUse:[{id,name,input}]`；客户端本地执行后下一次 `execute` 带 `toolUseResults:[{id,name,success,params,message}]`、`query:""`、`isUserQuery:false`。
- **MCP 工具**（`McpManager` 本地连接 MCP 服务器）：
  - 每次 `execute` 发 `hasMcp: true/false`（`getAllSkillMetadata(...).some(e=>e.type==="mcp")`）；
  - `skillInfos` 里每个已连接服务器一条 `{name:<服务器名>, description:<配置描述> 或 "Includes MCP server named X with these tools: a, b", type:"mcp"}`，只在变化时发送（`computeSkillEmission`）；
  - **不发 schema**。模型先调内置 `skill {name:<服务器名>}`，客户端回 `getMcpSkillToolResult` 文本：`<server name>` 下每个 `<server_tool name><tool_description><input_schema>{JSON}</input_schema>`；
  - 然后模型调内置 `use_mcp_tool {server_name, tool_name, arguments:<JSON 字符串>}`，客户端 `McpTool.execute` → `mcpManager.callTool(server, tool, args)`，文本结果作为 `toolUseResults[].message` 返回；
  - 唯一的结构化 schema 字段是 `subAgents[].mcpInfos:[{serverName, tools:[{name,description,inputSchema}]}]`（`getMcpServers` + `ProjectAgent.pickTaskProperties`），只用于描述可委派的子 agent，主 agent 不直接用它调用。
- **@cc-api/cli** 对接线上服务的做法：Claude Code 内置工具映射成 Comate 原生工具（Bash→run_command 等，参数改名）；`mcp__server__tool` 工具通过 `use_mcp_tool` 调用（`hasMcp:true`，schema 写进首轮 `systemReminder`，并提示不要用 `skill`）；其余工具走 XML 注入。
- **本插件**：`toolMode:"xml"`（默认）= 提示词 + XML；`toolMode:"mcp"` = 把调用方的全部工具作为虚拟 MCP 服务器 `client_tools`：首轮 `hasMcp:true` + `skillInfos:[{name:"client_tools",…,type:"mcp"}]` + `systemReminder` 里列出 schema；`use_mcp_tool` 调用映射为 OpenAI `tool_calls`；结果以 `toolUseResults{name:"use_mcp_tool", params:原参数}` 返回；`skill{name:"client_tools"}` 由插件按官方格式作答；XML 仍解析作兜底。

## 其他（未使用）
- 旧插件 LLM 接口 `/api/v2/api/generate[/stream]`（body 带 `key: license`、`model: EB/EB_4…`、ERNIE function calling），只覆盖老文心模型。
- 内网：`comate.baidu-int.com`、`oneapi-comate.baidu-int.com`（`one-api-token`），外部不可用。
