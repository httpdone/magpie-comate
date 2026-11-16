// Serve one OpenAI Chat Completions request with a Comate license.
import { createClient, ComateError, redact } from './comate.mjs'
import {
  normalizeTools, buildSystemReminder, buildQuery, thinkingFor, mapNativeCall,
  createXmlSplitter, createNativeCollector, textOf, MCP_SERVER, mcpSkillInfos, mcpServerToolText, TOOL_TAG, droppedNote,
  collectImages, maskImages, modelTakesImages,
} from './translate.mjs'
import { chainHashes, sessionScope, findContinuation, buildDelta, extendHash, replyMessage } from './sessions.mjs'

const MAX_NATIVE_ROUNDS = 3
// Asked (once per turn) when the answer ended inside a tool call that could not be recovered.
const RETRY_CUT_CALL = `Your last tool call was cut off before it was complete, so it was not run. Output the complete tool call again now: the full <${TOOL_TAG} id="call_<unique>" name="<tool_name>"> block with <arguments> JSON, closed with </${TOOL_TAG}>. No other text.`

/**
 * Upload the turn's images and build the IMAGE context execute takes
 * ({type:"IMAGE", imageIds:[…], images:[{id,name,url}]}, as the official client builds it).
 * An image that cannot be uploaded is dropped rather than failing the turn.
 */
async function imageContexts(client, images, signal) {
  const done = []
  for (const img of images) {
    try {
      const { id, url } = await client.uploadFile(img, signal)
      done.push({ id, name: img.name, url })
    } catch {}
  }
  return done.length ? [{ type: 'IMAGE', imageIds: done.map((d) => d.id), images: done }] : []
}

function errorResponse(status, message, type = 'api_error') {
  return new Response(JSON.stringify({ error: { message, type, code: status } }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function errorType(err) {
  if (err?.kind === 'auth') return 'authentication_error'
  if (err?.kind === 'quota') return 'rate_limit_error'
  return 'api_error'
}

const SHORT_REMINDER_TOOLS = `Reminder: your built-in IDE tools are disabled. Call tools only with the full XML block from the start of this conversation: <${TOOL_TAG} id="call_<unique>" name="<tool_name>"><arguments>{JSON}</arguments></${TOOL_TAG}>, always closed, never in a code fence, no other format.`
const SHORT_REMINDER_MCP = `Reminder: your built-in IDE tools are disabled. Call tools only through use_mcp_tool with server_name "${MCP_SERVER}" (tools listed at the start of this conversation).`
const SHORT_REMINDER_NO_TOOLS = 'Reminder: no tools are available; answer in text.'

/**
 * Rounds of /execute on one session, with the internal answer to Comate-native calls the
 * caller doesn't have. Yields normalized outputs; returns what the session still waits for.
 */
async function* runRounds({ client, session, first, tools, toolMode, modelKey, thinkingEnabled, effort, signal, state }) {
  const mcp = toolMode === 'mcp' && tools.length > 0
  let exec = first
  let retried = false
  for (let round = 0; round < MAX_NATIVE_ROUNDS; round++) {
    const body = client.buildExecuteBody({ session, modelKey, thinkingEnabled, effort, hasMcp: mcp, ...exec })
    const splitter = createXmlSplitter({ tools })
    const native = createNativeCollector()
    let roundCalls = 0
    for await (const ev of client.execute(body, signal)) {
      const type = ev?.content?.type
      const detail = ev?.content?.detail
      if (!detail) continue
      if (type === 'TOKEN_USAGE') {
        if (detail.usage) yield { type: 'usage', usage: detail.usage }
        continue
      }
      if (type === 'NOTIFICATION') continue
      if (typeof detail.reasoningDelta === 'string' && detail.reasoningDelta) yield { type: 'reasoning', text: detail.reasoningDelta }
      if (typeof detail.delta === 'string' && detail.delta) {
        const { text, calls } = splitter.push(detail.delta)
        if (text) yield { type: 'text', text }
        for (const c of calls) {
          roundCalls++
          yield { type: 'tool_call', ...c }
        }
      }
      native.onEvent(ev)
    }
    const tail = splitter.end()
    if (tail.text) yield { type: 'text', text: tail.text }
    for (const c of tail.calls) {
      roundCalls++
      yield { type: 'tool_call', ...c }
    }
    const nativeCalls = native.result()
    if (tail.dropped.length && !roundCalls && !nativeCalls.length && tools.length) {
      // The answer ended inside a tool call we could not recover: ask once on the same session
      // for the complete call; if that fails too, say so instead of showing a half tag.
      if (!retried && round + 1 < MAX_NATIVE_ROUNDS) {
        retried = true
        exec = { query: RETRY_CUT_CALL, systemReminder: '', toolUseResults: [], isUserQuery: true, isFirstQuery: false }
        continue
      }
      yield { type: 'text', text: droppedNote(tail.dropped) }
      break
    }
    if (tail.dropped.length) yield { type: 'text', text: droppedNote(tail.dropped) }

    // Comate native tool calls: pass through those that map to the caller's tools
    // (use_mcp_tool on our virtual server, or a same-named tool), answer the rest here.
    const internal = []
    for (const n of nativeCalls) {
      const m = mapNativeCall(n, tools)
      if (m) {
        state.pendingNative[n.id] = { name: n.name, params: n.params ?? {} }
        yield { type: 'tool_call', id: n.id, name: m.tool.name, arguments: JSON.stringify(m.args ?? {}) }
      } else if (mcp && n.name === 'skill' && (n.params?.name === MCP_SERVER || n.params?.skill === MCP_SERVER)) {
        // the official flow loads an MCP server's tool list through `skill`; answer it like the client does
        internal.push({ id: n.id, name: n.name, success: true, params: n.params ?? {}, message: mcpServerToolText(tools) })
      } else {
        const how = mcp ? `use_mcp_tool with server_name "${MCP_SERVER}" and one of: ${tools.map((x) => x.name).join(', ')}` : `only the XML tools listed in the system reminder (${tools.map((x) => x.name).join(', ')})`
        internal.push({
          id: n.id,
          name: n.name,
          success: false,
          params: n.params ?? {},
          message: tools.length
            ? `Tool "${n.name}" is not available in this environment. Use ${how}, or answer in text.`
            : `Tool "${n.name}" is not available. No tools exist in this conversation; answer directly in text.`,
        })
      }
    }
    if (!internal.length) break
    if (state.calls.length > 0) {
      // the caller has calls to run: our answers go along with its results next turn
      state.carryResults.push(...internal)
      break
    }
    exec = { query: '', systemReminder: '', toolUseResults: internal, isUserQuery: false, isFirstQuery: false }
  }
}

/**
 * Normalized output of one chat turn: {type:'text'|'reasoning'|'tool_call'|'usage'|'meta', …}
 * With a session store, continues a cached Comate conversation when the request extends one.
 */
async function* runTurn({ client, body, modelInfo, effortHeader, signal, sessions, license, toolMode = 'xml' }) {
  const tools = body.tool_choice === 'none' ? [] : normalizeTools(body.tools)
  const messages = Array.isArray(body.messages) ? body.messages : []
  const convo = messages.filter((m) => m.role !== 'system' && m.role !== 'developer')
  const systemText = messages.filter((m) => m.role === 'system' || m.role === 'developer').map((m) => textOf(m.content)).join('\n\n')
  const { thinkingEnabled, effort } = thinkingFor(body, modelInfo, effortHeader)
  const mcp = toolMode === 'mcp' && tools.length > 0
  const common = { tools, toolMode, modelKey: body.model, thinkingEnabled, effort, signal }

  let hashes
  let cont
  if (sessions) {
    hashes = chainHashes(sessionScope(license, `${systemText}\u0000toolMode=${mcp ? 'mcp' : 'xml'}`, tools), convo)
    cont = findContinuation(sessions, hashes, convo)
  }

  // what the turn produced, for caching the next state
  const state = { text: '', calls: [], pendingNative: {}, carryResults: [] }
  const track = (o) => {
    if (o.type === 'text') state.text += o.text
    else if (o.type === 'tool_call') state.calls.push(o)
    return o
  }

  let session
  let produced = false
  if (cont) {
    session = cont.entry.session
    const images = modelTakesImages(modelInfo) ? collectImages(cont.delta) : []
    const contexts = images.length ? await imageContexts(client, images, signal) : []
    const d = buildDelta(contexts.length ? maskImages(cont.delta) : cont.delta, cont.entry.pendingNative, cont.entry.callNames, cont.entry.carryResults)
    const first = {
      query: d.query,
      toolUseResults: d.toolUseResults,
      isUserQuery: d.isUserQuery,
      isFirstQuery: false,
      contexts,
      systemReminder: d.isUserQuery ? (mcp ? SHORT_REMINDER_MCP : tools.length ? SHORT_REMINDER_TOOLS : SHORT_REMINDER_NO_TOOLS) : '',
    }
    yield { type: 'meta', session, reused: true }
    try {
      for await (const o of runRounds({ client, session, first, state, ...common })) {
        produced = true
        yield track(o)
      }
    } catch (e) {
      // The cached task may be gone server-side: start over with the full transcript,
      // unless output already went out or a fresh session can't help (auth/quota/abort).
      if (produced || e?.kind === 'auth' || e?.kind === 'quota' || signal?.aborted) throw e
      session = undefined
      state.text = ''
      state.calls = []
      state.pendingNative = {}
      state.carryResults = []
    }
  }
  if (!session) {
    session = await client.createSession(signal)
    yield { type: 'meta', session, reused: false }
    const images = modelTakesImages(modelInfo) ? collectImages(messages) : []
    const contexts = images.length ? await imageContexts(client, images, signal) : []
    const shown = contexts.length ? maskImages(messages) : messages
    const first = {
      query: buildQuery(shown),
      systemReminder: buildSystemReminder(shown, tools, body.tool_choice, mcp ? 'mcp' : 'xml'),
      toolUseResults: [],
      contexts,
      isUserQuery: true,
      isFirstQuery: true,
      ...(mcp ? { skillInfos: mcpSkillInfos(tools) } : {}),
    }
    for await (const o of runRounds({ client, session, first, state, ...common })) yield track(o)
  }

  // Completed without error and not cancelled: remember where this conversation stands.
  if (sessions && hashes) {
    const key = extendHash(hashes[convo.length], replyMessage(state.text, state.calls))
    const callNames = Object.fromEntries(state.calls.map((c) => [c.id, c.name]))
    sessions.set(key, { session, pendingNative: state.pendingNative, callNames, carryResults: state.carryResults })
  }
}

function makeId(session) {
  return `chatcmpl-comate-${session?.conversationId ?? 'x'}-${session?.taskId ?? 'x'}-${Date.now().toString(36)}`
}

function toOpenAIUsage(u) {
  if (!u) return undefined
  const prompt = (u.inputTokens ?? 0) + (u.cachedInputTokens ?? 0)
  const completion = u.outputTokens ?? 0
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    ...(u.cachedInputTokens ? { prompt_tokens_details: { cached_tokens: u.cachedInputTokens } } : {}),
  }
}

function addUsage(acc, u) {
  acc = acc ?? { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }
  acc.inputTokens += Number(u.inputTokens) || 0
  acc.cachedInputTokens += Number(u.cachedInputTokens) || 0
  acc.outputTokens += Number(u.outputTokens) || 0
  return acc
}

/**
 * @param {object} p
 * @param {object} p.body     parsed Chat Completions request
 * @param {string} p.license  the user's Comate license
 * @param {object} [p.options] plugin options (host, ide, …)
 * @param {Function} [p.fetchImpl]
 * @param {AbortSignal} [p.signal]
 * @param {Function} [p.getModelInfo] async (modelId) => Comate model entry
 * @param {object} [p.sessions] session store (lib/sessions.mjs); omit to send every request statelessly
 */
export async function handleChatCompletions({ body, license, options, fetchImpl, signal, getModelInfo, sessions, effortHeader }) {
  if (!body || typeof body !== 'object') return errorResponse(400, 'request body must be JSON', 'invalid_request_error')
  let client
  try {
    client = createClient({ license, options, fetchImpl })
  } catch (e) {
    return errorResponse(e.status ?? 401, e.message, errorType(e))
  }
  const model = typeof body.model === 'string' ? body.model.trim() : ''
  if (!model) return errorResponse(400, 'model is required: use an id from GET /v1/models (e.g. glm-5.3_…)', 'invalid_request_error')
  let modelInfo
  try {
    modelInfo = getModelInfo ? await getModelInfo(model) : undefined
  } catch {}

  const it = runTurn({ client, body: { ...body, model }, modelInfo, effortHeader, signal, sessions, license, toolMode: options?.toolMode === 'mcp' ? 'mcp' : 'xml' })
  // Pull up to the first real output before answering, so sign-in / quota failures get a
  // real HTTP status (magpie marks the account on 401 and fails over on 429/5xx).
  const pre = []
  let done = false
  let session
  try {
    for (;;) {
      const r = await it.next()
      if (r.done) {
        done = true
        break
      }
      if (r.value.type === 'meta') {
        session = r.value.session
        continue
      }
      pre.push(r.value)
      break
    }
  } catch (e) {
    const status = e instanceof ComateError ? e.status : 502
    return errorResponse(status, redact(e?.message ?? String(e), license), errorType(e))
  }
  const items = (async function* () {
    yield* pre
    if (done) return
    for (;;) {
      const r = await it.next()
      if (r.done) return
      if (r.value.type !== 'meta') yield r.value
    }
  })()

  const created = Math.floor(Date.now() / 1000)
  const id = makeId(session)

  if (!body.stream) {
    let text = ''
    let reasoning = ''
    const calls = []
    let usage
    try {
      for await (const o of items) {
        if (o.type === 'text') text += o.text
        else if (o.type === 'reasoning') reasoning += o.text
        else if (o.type === 'tool_call') calls.push({ id: o.id, type: 'function', function: { name: o.name, arguments: o.arguments } })
        else if (o.type === 'usage') usage = addUsage(usage, o.usage)
      }
    } catch (e) {
      const status = e instanceof ComateError ? e.status : 502
      return errorResponse(status, redact(e?.message ?? String(e), license), errorType(e))
    }
    const message = { role: 'assistant', content: text || (calls.length ? null : '') }
    if (reasoning) message.reasoning_content = reasoning
    if (calls.length) message.tool_calls = calls
    return new Response(
      JSON.stringify({
        id, object: 'chat.completion', created, model,
        choices: [{ index: 0, message, finish_reason: calls.length ? 'tool_calls' : 'stop' }],
        usage: toOpenAIUsage(usage) ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }

  const enc = new TextEncoder()
  const includeUsage = !!body.stream_options?.include_usage
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj) => controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`))
      const chunk = (delta, finish = null) => send({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] })
      let sentRole = false
      const role = () => {
        if (!sentRole) {
          sentRole = true
          chunk({ role: 'assistant', content: '' })
        }
      }
      let toolIndex = 0
      let usage
      try {
        for await (const o of items) {
          if (o.type === 'text') {
            role()
            chunk({ content: o.text })
          } else if (o.type === 'reasoning') {
            role()
            chunk({ reasoning_content: o.text })
          } else if (o.type === 'tool_call') {
            role()
            chunk({ tool_calls: [{ index: toolIndex++, id: o.id, type: 'function', function: { name: o.name, arguments: o.arguments } }] })
          } else if (o.type === 'usage') usage = addUsage(usage, o.usage)
        }
        role()
        chunk({}, toolIndex > 0 ? 'tool_calls' : 'stop')
        if (includeUsage) send({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: toOpenAIUsage(usage) ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } })
        controller.enqueue(enc.encode('data: [DONE]\n\n'))
      } catch (e) {
        const msg = redact(e?.message ?? String(e), license)
        send({ error: { message: msg, type: errorType(e), code: e?.status ?? 502 } })
        controller.enqueue(enc.encode('data: [DONE]\n\n'))
      } finally {
        controller.close()
      }
    },
    cancel() {
      items.return?.()
      it.return?.()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' },
  })
}

/** /v1/models in OpenAI shape. */
export async function handleModels({ license, options, fetchImpl, signal }) {
  try {
    const client = createClient({ license, options, fetchImpl })
    const list = await client.listModels(signal)
    const data = list.map((m) => ({ id: m.modelId ?? m.id, object: 'model', created: 0, owned_by: 'comate', name: m.displayName }))
    return new Response(JSON.stringify({ object: 'list', data }), { headers: { 'content-type': 'application/json' } })
  } catch (e) {
    return errorResponse(e?.status ?? 502, redact(e?.message ?? String(e), license), errorType(e))
  }
}
