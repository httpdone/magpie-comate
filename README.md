# magpie-comate —— 在 magpie 里用你自己的文心快码（Baidu Comate）license，百度搭子（Baidu Dumate）与文心快码共享订阅权益，文心快码支持指定模型，所以我们开发了这个项目。

仓库：<https://github.com/httpdone/magpie-comate> · 问题反馈：<https://github.com/httpdone/magpie-comate/issues>

把**你自己的** Comate license 接成 [magpie](https://github.com/yetone/magpie) 的一个 provider（`comate`），
这样经 magpie 路由的 Claude Code、Codex、Gemini CLI、OpenCode 等 Agent 都能用上你账号里可用的模型
（id 原样取自 Comate，带一段后缀，例如 `comate/glm-5.3_<hash>`；以 `magpie models | grep comate` 列出的为准）。

> ⚠️ 仅供个人使用自己的 license。这是绕开官方客户端调用 Comate 的内部接口（非公开 API），
> 很可能违反百度的服务条款，账号存在被限制/封禁的风险，后果自负。请勿用于共享、转售 license。

## 工作方式

magpie 有真正的插件机制：它在 Bun 里加载 **OpenCode provider 插件**。本项目就是这样一个插件：

```
Agent ──(Anthropic / Responses / Chat / Gemini)──▶ magpie 网关 127.0.0.1:3425
      ──(OpenAI Chat Completions)──▶ 本插件的 fetch ──▶ comate.baidu.com（Comate Zulu Agent 接口）
```

- magpie 负责协议互转，插件只需处理 OpenAI Chat Completions（流式/非流式、tool calls）。
- Comate 后端不是“裸”大模型接口，而是 Zulu Agent 服务（会话 → 任务 → `execute` SSE），**服务端保存对话历史**。插件：
  1. **新对话**：`POST /api/aidevops/autocomate/rest/autowork/v2/conversation` 和 `/v2/task` 新建会话与任务，再
     `POST …/v2/execute`：你的 system prompt 和**你那边 Agent 的工具定义**（默认以 XML 调用约定；`toolMode:"mcp"` 时伪装成 MCP 服务器，见“已知限制”）放进 `systemReminder`，
     对话内容放进 `query`（只有一条用户消息时原样发送，否则渲染成 transcript）；
  2. **后续轮次（会话复用，默认开启）**：和官方客户端一样，沿用同一个 `conversationId`/`taskId`，只发送**新增**的内容：
     新的用户消息、或上一轮工具调用的结果（XML 工具的结果作为 `<tool_result>` 文本放进 `query`；
     透传出去的 Comate 原生工具调用的结果按官方格式放进 `toolUseResults`），不再新建会话、不再重发历史；
  3. 把 SSE 里的 `delta` / `reasoningDelta` / `TOKEN_USAGE` 转成 OpenAI 的 `content` / `reasoning_content` / `usage`，
     把模型输出的 `<tool_call_call …>` XML 块（以及与你的工具同名的 Comate 原生工具调用）转成 `tool_calls`。
     模型写偏的格式也能识别：`<tool_call>` / `<function_call>` / `<invoke>`（含 `<function_calls>` 包裹）、
     `<parameter name=…>` 子元素、JSON 正文、DeepSeek 的 `<｜tool▁call▁begin｜>` 特殊 token、调用你工具的 ```json 代码块；
     工具名大小写/别名（如 `run_command` → `bash`）只在唯一匹配时才映射。
     标签被切在两个流式分片之间也没关系；半截工具调用**不会作为文本漏出**：流结束时能解析就照常发出，
     解析不了就在同一会话里让模型重发一次，仍失败则只显示一句简短说明。
     Comate 自带的 IDE 工具（read_file、run_command…）被调用时，插件在上游直接回一个“不可用”的 tool result，让模型改用你的工具。

### 会话复用怎么判定

OpenAI 风格的客户端每次都会重发完整历史。插件把“我们回答过的那一刻”的完整消息序列（含我们的回复）做哈希缓存：
`key = H(license 的哈希, system prompt, 工具定义, 消息1…消息k, 我们的回复)`。新请求如果是某个缓存状态的**前缀延伸**
（前面完全一致，后面只多了用户消息/工具结果），就续用那个 Comate 任务，只发增量。以下情况自动退回新建会话并发送完整 transcript：

- 历史被编辑/分叉、system prompt 或工具列表变了、中间插入了非我们产生的 assistant 消息；
- 缓存过期（默认 30 分钟未使用）或被 LRU 淘汰（默认最多 200 条）；
- 同一请求被重试/重新生成（缓存状态用一次即作废，避免服务端重复记录同一轮）；
- 续用的任务在产出任何内容前报错（比如服务端任务已失效）：自动换新会话重试一次；鉴权/额度错误不重试。

比较时容忍客户端/网关的常见改写：空白差异、文本拆成多段、丢掉/附带 reasoning、工具参数被重新序列化（只比对工具调用的 id 和名字）。
缓存只在内存里，magpie 重启即清空；key 里只有 license 的哈希，不保存 license 本身。

- 模型列表来自 `GET /api/v2/api/models/available?key=<license>&type=ZULU&loopVersion=v2`，按账号动态获取。

## 安装

### 1. 前提

- **magpie**：本插件在 magpie `0.1.4026` 上实测（`magpie --version` 查看；旧版本先 `magpie update`）。
  登录流程用的是 magpie 的 OpenCode 插件 oauth「code」登录方式，较早的 magpie 若不支持，请先升级。
- **Bun 不用自己装**：magpie 第一次加载插件时会自动下载它自带的 Bun（会提示 `Downloading Bun …, which plugins run on…`）。
- **git**：只有「从 GitHub 安装」需要。
- **Node ≥ 18**：只在跑测试或独立代理（`bin/serve.mjs`）时需要，插件本身不需要。
- 一个**你自己的** Comate 账号（能登录 <https://comate.baidu.com/zh/user>）。

### 2. 安装插件（三选一）

**A. 从 GitHub 直接安装（推荐，能用 `magpie plugin update` 更新）**

```bash
magpie plugin add github:httpdone/magpie-comate
# 等价写法：magpie plugin add https://github.com/httpdone/magpie-comate
```

magpie 用 Bun 从 GitHub 拉取并安装，插件名是 `magpie-comate`。

**B. git clone 到本地再添加（想改代码 / 网络拉不到 GitHub 时）**

```bash
git clone https://github.com/httpdone/magpie-comate ~/tools/magpie-comate
magpie plugin add ~/tools/magpie-comate
```

magpie 直接从这个文件夹加载（不会拷贝），插件名就是这个**路径**。以后 `git pull` 后重启 magpie 即可更新。

**C. 从 zip 安装**

```bash
unzip magpie-comate.zip -d ~/tools          # 解压到一个固定位置，之后不要删
magpie plugin add ~/tools/magpie-comate
```

也可以在 magpie 窗口里：Plugins → Add a plugin → 填 `github:httpdone/magpie-comate` 或选上面的文件夹。

装好后：

```bash
magpie plugin
# github:httpdone/magpie-comate (magpie-comate 0.3.0)  on        ← 方式 B/C 显示的是文件夹路径
#   comate (文心快码 Comate, 1 models)  not signed in · magpie plugin login comate
```

### 3. 登录（会自动打开 license 页面）

```bash
magpie plugin login comate
```

1. magpie 会**自动在浏览器新标签页打开** [Baidu Comate · 个人中心](https://comate.baidu.com/zh/user)；
   打不开（服务器 / Docker / 无桌面）时终端会打印这个链接，手动打开即可。
2. 在个人中心登录百度账号，复制你的 **license**。
3. 回到终端，在 `Code:` 后面粘贴 license，回车。插件先用 `GET /api/key/valid/<license>` 校验，通过后显示
   `✓ signed in to 文心快码 Comate`。

在 magpie 窗口里（桌面版或 `magpie web`）点 comate 的登录按钮也是同一个流程：新标签页打开个人中心，窗口里出现输入框，粘贴 license 后点「完成登录 / Finish sign-in」。

注意：

- `Code:` 这一步终端会**显示**你粘贴的内容（magpie 的 code 输入框不是密码框）。不想让它出现在屏幕上，可以用管道：
  `printf '%s\n' "$COMATE_LICENSE" | magpie plugin login comate`（页面照样会打开，但不需要再输入）。
- license 由 magpie 保存在 `~/.config/magpie/plugin-auth.json`（权限 600），作为该账号的 key；
  **不会写进本项目目录，不进日志，也不会出现在错误信息里**（会被替换成 `***`）。`magpie providers` 里只显示末四位。
- 换 license：`magpie plugin logout comate` 后重新 login。
- VS Code 插件用户也可以在设置项 `baidu.comate.license` 里找到同一个 license。
- 私有化部署可用 `licenseUrl` 选项改掉自动打开的页面（见下文选项）。

### 4. 验证

```bash
magpie plugin                     # comate (文心快码 Comate, N models)  signed in
magpie providers                  # 文心快码 Comate … ● signed in as API key …xxxx
magpie provider test comate       # ✓ chat … · deepseek-v4-flash_…   （发一个极小的请求自检）
magpie models | grep comate       # 你账号可用的模型及完整 id，例如 comate/glm-5.3_<hash>
```

### 5. 分配给 Agent

```bash
# 模型 id 要写完整（含后缀），先用 magpie models | grep comate 查到再复制
magpie claude comate/glm-5.3_<hash>   # Claude Code 用 GLM-5.3
magpie codex  comate/<从 magpie models 复制的 id>
magpie ls                          # 看各 Agent 当前用的模型
magpie claude default              # 把 Claude Code 恢复成原来的设置
```

也可以把 `comate/<model>` 放进路由组（`magpie group add …`）或作为其他 provider 的 fallback
（`magpie provider fallback <id> comate/<完整模型 id>`），和其他 provider 一样。窗口里在 Agents 页直接选模型也可以。

### 6. 选项（可选）

`magpie plugin options <插件名> '<json>'` 设置，`magpie plugin options <插件名>` 查看。
**插件名**：方式 A 装的是 `magpie-comate`；方式 B/C 装的是文件夹**路径**（如 `~/tools/magpie-comate`）。
JSON 会**整体覆盖**之前的选项，需要的字段要一起写。设置后 magpie 会自动重启插件进程（内存里的会话缓存随之清空）。

```bash
magpie plugin options magpie-comate '{"toolMode":"mcp"}'                    # 试用 MCP 工具模式
magpie plugin options magpie-comate '{"sessionReuse":false}'                # 关闭会话复用
magpie plugin options ~/tools/magpie-comate '{"host":"https://comate.baidu.com","toolMode":"xml"}'
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `toolMode` | `xml` | 工具调用方式：`xml`（提示词 + XML 解析，最稳）或 `mcp`（实验：伪装成 MCP 服务器，走 Comate 原生 `use_mcp_tool`，XML 兜底） |
| `sessionReuse` | `true` | 是否跨轮次复用 Comate 会话；`false` 则每个请求都新建会话并发送完整 transcript |
| `sessionTtlMs` | `1800000` | 缓存的会话状态多久未使用即作废 |
| `sessionMax` | `200` | 最多缓存多少个会话状态（LRU） |
| `idleTimeoutMs` | `300000` | 上游流静默多久后中止 |
| `host` | `https://comate.baidu.com` | Comate 服务地址（私有化部署时改这里） |
| `licenseUrl` | `https://comate.baidu.com/zh/user` | 登录时自动打开的「复制 license」页面 |
| `ide` / `ideVersion` / `pluginVersion` | `zulucli` / `1.7.16` / `4.13.0` | 上报的客户端身份（取自官方 `@comate/comatecli`） |
| `agentId` / `agentName` / `agentVersion` | `1` / `Zulu` / `12` | Zulu Agent 参数 |

### 7. 更新 / 停用 / 卸载

```bash
magpie plugin update                    # 方式 A：拉取最新版本（所有插件）
cd ~/tools/magpie-comate && git pull    # 方式 B：更新代码后重启 magpie
magpie plugin off magpie-comate         # 临时停用（on 重新启用）；方式 B/C 用路径
magpie plugin logout comate             # 删除保存的 license
magpie plugin rm magpie-comate          # 卸载插件；方式 B/C 用路径，之后可删掉文件夹
```

### 8. 常见问题

| 现象 | 处理 |
| --- | --- |
| 登录时浏览器没打开 | 终端已打印链接，手动打开 <https://comate.baidu.com/zh/user>；magpie 设置里开了「只给链接」时也是这样 |
| `the sign-in failed: Comate 说这个 license 无效` | 重新从个人中心复制，注意不要带空格/引号；确认账号未过期 |
| `magpie plugin` 显示 `not signed in` | 还没登录或已 logout：`magpie plugin login comate` |
| `magpie: no provider "comate"` | 插件没加载：`magpie plugin` 看是否 `on`；路径装的确认文件夹还在 |
| `magpie: no plugin "…"`（设置 options 时） | 插件名不对：GitHub 装的用 `magpie-comate`，本地装的用文件夹路径（`magpie plugin` 第一列） |
| `comate` 显示 0 个模型 | 还没登录、license 无效或网络不通 Comate；`magpie provider models comate` / `magpie provider test comate` 看报错 |
| 请求返回 401 | license 失效，`magpie providers` 会标记登录过期，重新 login |
| 请求返回 429 | Comate 额度用尽，配置 fallback 让 magpie 自动切换 |
| `plugin add github:…` 报 404 | 仓库地址/网络问题；可改用方式 B（git clone）或 C（zip） |
| 工具调用不稳定 | 换回 `toolMode: "xml"`；或关掉 `sessionReuse` 排查 |

## 备选：独立的本地 OpenAI 兼容代理

不想用插件时，可以把同一套适配器跑成本地服务，再作为自定义 provider 加进 magpie（或给任何 OpenAI 兼容客户端用）：

```bash
# license 从环境变量或文件读，不打印
export COMATE_LICENSE_FILE=~/.config/comate/license   # 文件里只放 license，chmod 600
export PROXY_TOKEN=$(openssl rand -hex 16)             # 建议：客户端需带这个 token
PORT=3426 node ~/tools/magpie-comate/bin/serve.mjs     # 只监听 127.0.0.1

magpie provider add comate-proxy url=http://127.0.0.1:3426/v1 key=$PROXY_TOKEN
magpie provider test comate-proxy
```

提供 `GET /v1/models`、`POST /v1/chat/completions`（流式/非流式）、`GET /health`。会话复用同样默认开启，
`COMATE_SESSION_REUSE=0` 关闭，`COMATE_SESSION_TTL_MS`、`COMATE_SESSION_MAX` 调整；`COMATE_TOOL_MODE=mcp` 切换工具模式。Anthropic / Responses 协议由 magpie 负责转换。

## 测试

```bash
cd ~/tools/magpie-comate
npm test        # 或 bun test；全部用模拟的 Comate 后端，不联网、不需要 license
```

在沙箱 magpie 里完整跑一遍（不碰你真实的 magpie 配置）：

```bash
node test/fake-comate-server.mjs 18080 &          # 本地假 Comate
sb=$(mktemp -d); mkdir -p $sb/bin
printf '#!/bin/sh\necho "$@" >> %s/opened.txt\n' $sb > $sb/bin/xdg-open; chmod +x $sb/bin/xdg-open   # 记录“打开浏览器”，不真的打开
m() { env PATH=$sb/bin:$PATH HOME=$sb XDG_CONFIG_HOME=$sb/.config XDG_CACHE_HOME=$sb/.cache MAGPIE_ADDR=127.0.0.1:3499 magpie "$@"; }
m plugin add ~/tools/magpie-comate </dev/null
m plugin options ~/tools/magpie-comate '{"host":"http://127.0.0.1:18080"}'
echo LIC-test-0123456789abcdef | m plugin login comate    # 打印并“打开” https://comate.baidu.com/zh/user
cat $sb/opened.txt                                        # → https://comate.baidu.com/zh/user
m provider test comate
```

## 模型参数

模型列表和每个模型的参数**完全取自 Comate 的 `models/available` 接口**，不按模型名猜测、不做别名、没有内置的模型表：

| 参数 | 取值 |
| --- | --- |
| 模型 id / 名称 | `modelId` 原样（含后缀，如 `glm-5.3_<hash>`）/ `displayName` |
| 上下文窗口 | `maxContextWindow` × 1000（接口单位是 K tokens，官方 VS Code 扩展同样 `1e3*Number(maxContextWindow)`）；接口没给时统一 128000 |
| 最大输出 | 统一 32000（接口没有这个字段；只是声明给 magpie 的上限，不会发给 Comate） |
| 是否思考 | `supportThinking` |
| 思考开关 / 档位 | 只看 `thinkingConfig.switchable`、`effortConfig.levels` / `defaultLevel`（官方 comatecli 2.0 读的就是这两个） |
| 倍率 | `ratio`（如 `"0.3x"`） |
| 图片 | 插件不转发图片，只声明文本输入 |
| temperature / top_p / max_tokens | 不转发：`execute` 没有这些字段，官方客户端也不发 |

**思考字段怎么发**（与 comatecli 一致）：只有模型的 `thinkingConfig.switchable` 为 true 才发 `thinkingEnabled`，只有 `effortConfig` 有档位才发
`effort`（Agent 选的档位夹到可用档位，未选用 `defaultLevel`；magpie 的 `X-Magpie-Effort` 头优先于请求体）。
**目前（2026-11 实测）所有模型的 `thinkingConfig` / `effortConfig` 都是 null**，所以两个字段都不发，由服务端按模型默认处理。

注意：对没有声明档位但会思考的模型，magpie 会按自己的模型库给一些模型显示档位（例如 GLM-5.3、Deepseek V4.1 Flash 显示 `low/high/max`），
这是 magpie 自己的行为；插件收到这些档位后不会发给 Comate。

实测（真实 license）`magpie models | grep comate` 节选：

```
comate/deepseek-v4-flash_<hash>        Deepseek V4 Flash
comate/ernie-5.5-flash-preview_<hash>  ERNIE 5.5 Flash Preview
comate/glm-5.3_<hash>                  GLM-5.3  low/high/max
comate/minimax-m3_<hash>               MiniMax M3
```

## 已知限制

- **会话复用依赖客户端原样回传历史**：如果某个 Agent 每轮都改写 system prompt（例如嵌入时间戳）或改写历史消息，就匹配不上，
  每轮都会退回“新建会话 + 完整 transcript”（功能正常，只是开销大）。新会话仍需两次建会话请求，这是服务端协议决定的。
- 复用时 `systemReminder` 只在第一轮带完整工具说明（服务端历史里有），之后每轮只带一句简短提醒；极长对话里模型可能淡忘 XML 约定。
- Comate 服务端自己的 Agent 系统提示词仍然存在，模型的“人设”可能不如直连纯净；服务端可能自行压缩长历史。
- **工具 schema 只能以文本形式给模型**：Comate 的工具集由服务端固定（read_file、run_command、use_mcp_tool、skill…），
  `execute` 请求里没有“传工具定义”的字段——官方客户端自己的 MCP 工具也是这样：只发 `hasMcp` 和 `skillInfos`（服务器名+一句描述），
  完整 schema 由模型调用 `skill` 工具后以文本返回，再通过原生 `use_mcp_tool` 调用（详见 PROTOCOL.md）。所以两种模式下 schema 都是文本：
  - `toolMode: "xml"`（默认）：工具和调用格式都在提示词里，调用从输出文本的 XML 块解析；
  - `toolMode: "mcp"`（实验）：仿照官方 MCP 流程把你的工具伪装成一个名为 `client_tools` 的 MCP 服务器，模型用自带的
    `use_mcp_tool` 调用，**调用以结构化 FUNCTION_CALL 事件返回**、结果按官方格式放进 `toolUseResults`；XML 仍作为兜底被解析。
    模型若调用 `skill` 加载这个服务器，插件按官方格式回 schema；调用其它原生工具会被回绝并提示改用 `use_mcp_tool`（最多 3 轮）。
    该模式只在模拟后端上测试过，线上效果需要真实 license 验证；不理想就切回 `xml`。
- **图片**：`supportImage: true` 的模型会转发图片——先把图片 `POST …/rest/autowork/v1/file/upload` 换成服务端 id，再放进 `contexts: [{type:"IMAGE", imageIds:[…]}]`；其余模型仍替换为 `[image omitted]`。只收内联图片（`data:` URL 或 base64），png/jpeg/gif/webp。
- **max_tokens / temperature / top_p 不生效**：Comate `execute` 没有这些字段；32000 输出上限是插件自定的（接口不给）。
- **未接入用量查询**（`magpie quota` 里不显示 Comate 额度）。额度超限时返回 429，magpie 会按 fallback 切换。
- 依赖 Comate 客户端的非公开接口，百度更新后可能失效；届时需对照新版客户端调整 `lib/comate.mjs`。
- 只支持 SaaS license 登录；百度内网账号（token / Uuap）、私有化部署的 VPC 接口未适配（私有化可试 `host` 选项）。

## 文件

| 文件 | 作用 |
| --- | --- |
| `index.mjs` | magpie/OpenCode 插件入口：provider 声明、license 登录（打开个人中心 → 粘贴 → 校验）、模型列表、loader fetch |
| `lib/comate.mjs` | Comate 后端客户端：鉴权头、校验、模型、会话/任务、`execute` SSE 解析、错误映射与脱敏 |
| `lib/models.mjs` | 模型参数：全部取自接口（上下文 K→tokens、思考/档位/倍率），请求档位 → `thinkingEnabled`/`effort` |
| `lib/translate.mjs` | OpenAI ⇄ Comate：transcript、工具 XML 约定、原生工具调用收集、模型映射 |
| `lib/toolcalls.mjs` | 流式工具调用切分：XML 块及常见变体、跨分片、半截调用的补救/丢弃、工具名唯一匹配 |
| `lib/handler.mjs` | 处理一次 `/chat/completions`（流式/非流式，含会话续用与失败回退）与 `/models` |
| `test/toolcalls.test.mjs` | 工具调用切分的测试（含 pi + DeepSeek V4.1 Flash 漏出半截标签的回归用例） |
| `test/toolmode.test.mjs` | `toolMode:"mcp"` 的测试（use_mcp_tool 映射、skill 作答、toolUseResults、XML 兜底） |
| `lib/sessions.mjs` | 会话复用：消息规范化与链式哈希、LRU+TTL 内存缓存、增量（新消息/工具结果）构造 |
| `bin/serve.mjs` | 备选：独立本地 OpenAI 兼容代理 |
| `test/` | 单元/集成测试（模拟后端）与本地假 Comate 服务 |

MIT License.

## 社区

有问题、建议，或想一起折腾？欢迎来 **[linux.do](https://linux.do)** 社区交流反馈。
