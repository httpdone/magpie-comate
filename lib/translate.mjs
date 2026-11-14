// OpenAI Chat Completions  <->  Comate autowork (agent) protocol.
//
// Comate's backend is an agent service, not a plain LLM endpoint: it keeps its own
// system prompt and its own (IDE-side) tool set. To make it behave like a chat model
// for any agent behind magpie, a fresh session gets:
//   - systemReminder = the caller's system prompt + the caller's tools, described as
//     an XML calling convention, or (toolMode "mcp") as one MCP server called through
//     Comate's use_mcp_tool (Comate has no field for foreign tool schemas);
//   - query          = the conversation rendered as a transcript.
// Later turns on a reused session send only the delta (see sessions.mjs).
// Tool calls come back either as our XML blocks inside the text (preferred) or as
// Comate native tool calls; both are turned into OpenAI tool_calls.

import { profileOf, effortsOf, askedEffort, resolveThinking } from './models.mjs'
import { createToolCallSplitter, resolveToolName } from './toolcalls.mjs'

export { resolveToolName, droppedNote } from './toolcalls.mjs'

export const TOOL_TAG = 'tool_call_call'

export function textOf(content) {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === 'string') return p
        if (p?.type === 'text' || p?.type === 'input_text') return p.text ?? ''
        if (p?.type === 'image_url' || p?.type === 'input_image' || p?.type === 'image') return '[image omitted: 当前插件不转发图片]'
        return ''
      })
      .join('')
  }
  if (typeof content === 'object' && typeof content.text === 'string') return content.text
  return String(content)
}

export function normalizeTools(tools) {
  if (!Array.isArray(tools)) return []
  return tools
    .filter((t) => t && (t.type === 'function' || t.function))
    .map((t) => ({ name: t.function?.name, description: t.function?.description ?? '', parameters: t.function?.parameters ?? { type: 'object', properties: {} } }))
    .filter((t) => typeof t.name === 'string' && t.name)
}

export function toolCallXml(id, name, args) {
  let json = args
  if (typeof json !== 'string') json = JSON.stringify(json ?? {})
  return `<${TOOL_TAG} id="${id}" name="${name}">\n<arguments>\n${json}\n</arguments>\n</${TOOL_TAG}>`
}

// toolMode "mcp": the caller's tools are presented to Comate as one MCP server, the way the
// official clients expose MCP servers (skillInfos type "mcp" + hasMcp), so the model calls
// them through its built-in use_mcp_tool tool and the calls arrive as structured
// FUNCTION_CALL events instead of text. XML stays accepted as a fallback.
export const MCP_SERVER = 'client_tools'

/** skillInfos entry for the virtual server, in the official getAllSkillMetadata shape. */
export function mcpSkillInfos(tools) {
  return [{ name: MCP_SERVER, description: `Includes MCP server named ${MCP_SERVER} with these tools: ${tools.map((t) => t.name).join(', ')}`, type: 'mcp' }]
}

/** What the official `skill` tool returns for an MCP server (getMcpSkillToolResult). */
export function mcpServerToolText(tools) {
  const list = tools
    .map((t) => `<server_tool name="${t.name}">\n<tool_description>\n${t.description || ''}\n</tool_description>\n<input_schema>\n${JSON.stringify(t.parameters ?? {})}\n</input_schema>\n</server_tool>`)
    .join('\n\n')
  return `You can use the \`use_mcp_tool\` tool to call one or more tools below.\n<server name="${MCP_SERVER}">\n${list}\n</server>`
}

function parseArgs(a) {
  if (a == null || a === '') return {}
  if (typeof a === 'object') return a
  try {
    const v = JSON.parse(a)
    return v && typeof v === 'object' ? v : { value: v }
  } catch {
    return { raw: String(a) }
  }
}

/**
 * Map a Comate native call to one of the caller's tools.
 * use_mcp_tool {server_name, tool_name, arguments} → that tool; else a same-named native tool.
 * @returns {{tool, args}|undefined}
 */
export function mapNativeCall(n, tools) {
  if (!tools.length) return undefined
  const p = n.params ?? {}
  if (n.name === 'use_mcp_tool' && typeof p.tool_name === 'string') {
    const tool = tools.find((t) => t.name === p.tool_name) ?? matchClientTool(p.tool_name, tools)
    return tool ? { tool, args: parseArgs(p.arguments) } : undefined
  }
  const tool = matchClientTool(n.name, tools)
  return tool ? { tool, args: p } : undefined
}

export function buildSystemReminder(messages, tools, toolChoice, toolMode = 'xml') {
  const parts = []
  const system = (messages || [])
    .filter((m) => m.role === 'system' || m.role === 'developer')
    .map((m) => textOf(m.content))
    .filter(Boolean)
    .join('\n\n')
  parts.push(`# Operating mode (highest priority)

You are being used as a plain chat model through an API bridge. The caller's own instructions follow below and override any built-in role.
- Your built-in IDE tools (read_file, write_file, edit_file, run_command, list_dir, codebase_search, todo_write, web_search, ...) are DISABLED here. Calling them only returns an error.${toolMode === 'mcp' && tools.length ? ' Only use_mcp_tool works, for the tools listed below.' : ''}
- If the first user query holds a <conversation_history> transcript, that is the conversation so far: continue it as the assistant (answer the last user turn, or continue after the latest tool results) and do not repeat it. Later turns arrive as normal messages; tool results arrive as <tool_result> entries.`)
  if (system) parts.push(`# Caller instructions\n\n${system}`)
  if (tools.length) {
    const list = tools
      .map((t, i) => `[Tool ${i + 1}] ${t.name}\nDescription: ${t.description || 'No description'}\nParameters: ${JSON.stringify(t.parameters ?? {})}`)
      .join('\n\n')
    let choice = ''
    if (toolChoice === 'required') choice = '\n- You MUST call at least one tool in this reply.'
    else if (toolChoice && typeof toolChoice === 'object' && toolChoice.function?.name) choice = `\n- You MUST call the tool "${toolChoice.function.name}" in this reply.`
    else if (toolChoice === 'none') choice = '\n- Do NOT call any tool in this reply; answer in text.'
    if (toolMode === 'mcp') {
      parts.push(`# Available tools (MCP server "${MCP_SERVER}")

The caller's tools are provided as the MCP server "${MCP_SERVER}". Call them with your built-in \`use_mcp_tool\` tool:
- server_name: "${MCP_SERVER}"
- tool_name: the tool name below
- arguments: a JSON string of the tool parameters (a string, NOT an object)
Do not use the \`skill\` tool to load them: every tool is listed here. You may call several tools; then stop and wait for the results.
If use_mcp_tool is unavailable, call a tool with this text block instead (outside any code fence):
<${TOOL_TAG} id="call_<unique>" name="<tool_name>">
<arguments>
{"param": "value"}
</arguments>
</${TOOL_TAG}>
Only these tools exist:${choice}

${list}`)
    } else {
      parts.push(`# Available tools (XML calling convention)

To call a tool, output this block exactly (outside any code fence), with nothing else on its lines:

<${TOOL_TAG} id="call_<unique>" name="<tool_name>">
<arguments>
{"param": "value"}
</arguments>
</${TOOL_TAG}>

Rules:
- Use exactly this tag name (${TOOL_TAG}) with both the id and name attributes, and always write the full block: the <arguments> element with one valid JSON object matching the tool's parameters, then </arguments> and </${TOOL_TAG}>. Never stop in the middle of a block.
- Do not use any other tool-call format: not your native tool-call markup (DSML or other special tokens), not <tool_call> or <function_calls>/<invoke>, not JSON in code fences. Do not put the block inside a code fence, and do not add closing tags such as </user-input> or </tool_result> after it.
- The tool name must be one of the names listed below, spelled exactly.
- Keep any text before a tool block short and in the user's language. Do not write out your private reasoning as text.
- You may output several blocks to call several tools. After the tool blocks, STOP and wait: the results arrive in the next turn as <tool_result> entries.
- Only these tools exist:${choice}

${list}`)
    }
  } else {
    parts.push('# Tools\n\nNo tools are available in this conversation. Answer directly in text.')
  }
  return parts.join('\n\n')
}

/** Render the non-system conversation as a transcript (stateless request). */
export function buildQuery(messages) {
  const convo = (messages || []).filter((m) => m.role !== 'system' && m.role !== 'developer')
  if (convo.length === 1 && convo[0].role === 'user') return textOf(convo[0].content)
  if (convo.length === 0) return ''

  const last = convo[convo.length - 1]
  const history = last.role === 'user' ? convo.slice(0, -1) : convo
  const names = new Map()
  const lines = []
  for (const m of history) {
    if (m.role === 'user') lines.push(`<user>\n${textOf(m.content)}\n</user>`)
    else if (m.role === 'assistant') {
      const body = []
      const reasoning = m.reasoning_content
      const text = textOf(m.content)
      if (text) body.push(text)
      for (const tc of m.tool_calls || []) {
        names.set(tc.id, tc.function?.name)
        body.push(toolCallXml(tc.id, tc.function?.name, tc.function?.arguments || '{}'))
      }
      if (!body.length && reasoning) body.push('(thinking only)')
      lines.push(`<assistant>\n${body.join('\n')}\n</assistant>`)
    } else if (m.role === 'tool') {
      const name = m.name || names.get(m.tool_call_id) || ''
      lines.push(`<tool_result id="${m.tool_call_id ?? ''}" name="${name}">\n${textOf(m.content)}\n</tool_result>`)
    } else if (m.role === 'function') {
      lines.push(`<tool_result name="${m.name ?? ''}">\n${textOf(m.content)}\n</tool_result>`)
    }
  }
  const tail = last.role === 'user'
    ? textOf(last.content)
    : last.role === 'tool' || last.role === 'function'
      ? 'Continue: use the tool results above to proceed with the task.'
      : 'Continue.'
  return `<conversation_history>\n${lines.join('\n')}\n</conversation_history>\n\n<current_turn>\n${tail}\n</current_turn>`
}

/**
 * The request's reasoning choice (X-Magpie-Effort, reasoning_effort, reasoning.effort or an Anthropic
 * thinking budget) → the execute body's thinkingEnabled / effort for this model; undefined fields are not sent.
 */
export function thinkingFor(body, modelInfo, headerEffort) {
  return resolveThinking(modelInfo ? profileOf(modelInfo) : null, askedEffort(body, headerEffort))
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '')

export function matchClientTool(nativeName, tools) {
  const n = norm(nativeName)
  const exact = tools.find((t) => t.name === nativeName)
  if (exact) return exact
  const same = tools.filter((t) => norm(t.name) === n)
  return same.length === 1 ? same[0] : undefined // only when unambiguous; no aliasing for native calls (different params)
}

/**
 * Incremental splitter for text-form tool calls (our XML block and common variants), see toolcalls.mjs.
 * push(text) / end() → {text, calls, dropped}
 */
export function createXmlSplitter(opts) {
  return createToolCallSplitter(opts)
}

/** Collect native tool calls from Comate events (FUNCTION_CALL_* / ANSWER.toolUse). */
export function createNativeCollector() {
  const calls = new Map()
  const ensure = (item) => {
    if (!calls.has(item.id)) calls.set(item.id, { id: item.id, name: item.name ?? '', str: '', obj: {} })
    const c = calls.get(item.id)
    if (item.name && !c.name) c.name = item.name
    return c
  }
  const apply = (c, input, mode) => {
    if (input == null) return
    if (typeof input === 'string') c.str = mode === 'append' ? c.str + input : input
    else if (typeof input === 'object') {
      for (const [k, v] of Object.entries(input)) {
        if (mode === 'append' && typeof v === 'string') c.obj[k] = (c.obj[k] ?? '') + v
        else c.obj[k] = v
      }
    }
  }
  return {
    onEvent(ev) {
      const type = ev?.content?.type
      const items = ev?.content?.detail?.toolUse
      if (!Array.isArray(items)) return
      for (const item of items) {
        if (!item?.id) continue
        const c = ensure(item)
        if (type === 'FUNCTION_CALL_PARAMS_APPEND') apply(c, item.input, 'append')
        else if (type === 'FUNCTION_CALL_START' && (item.input == null || (typeof item.input === 'object' && !Object.keys(item.input).length))) continue
        else apply(c, item.input, 'merge')
      }
    },
    result() {
      return [...calls.values()].map((c) => {
        let params = c.obj
        if (!Object.keys(params).length && c.str) {
          try {
            params = JSON.parse(c.str)
          } catch {
            params = { raw: c.str }
          }
        }
        return { id: c.id, name: c.name, params }
      })
    },
    size: () => calls.size,
  }
}

/** Comate model entry → OpenCode/magpie model. */
// toMagpieModel: one models/available entry as a magpie/OpenCode model (see lib/models.mjs for sources)
export function toMagpieModel(m, base = {}) {
  const p = profileOf(m)
  const efforts = effortsOf(p)
  return {
    ...base,
    id: p.id,
    name: p.name,
    limit: { context: p.context, output: p.output },
    tool_call: true,
    reasoning: !!p.thinking,
    // Comate's execute takes no temperature / top_p (no client sends them)
    temperature: false,
    attachment: false,
    // images are not forwarded by this plugin, whatever supportImage says
    modalities: { input: ['text'], output: ['text'] },
    ...(efforts.length ? { variants: Object.fromEntries(efforts.map((e) => [e, {}])) } : {}),
    // ratio: the credit multiple the official clients show beside the model
    ...(p.rate > 0 ? { rate: p.rate } : {}),
    // provider.models hands OpenCode Model objects: their api.id is what goes on the wire
    ...(base.api ? { api: { ...base.api, id: p.id } } : {}),
    status: 'active',
    ...(base.capabilities ? { capabilities: { ...base.capabilities, reasoning: !!p.thinking, toolcall: true } } : {}),
  }
}
