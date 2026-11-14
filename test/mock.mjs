// A fake Comate backend as a fetch function. Records every request.
export const LICENSE = 'LIC-test-0123456789abcdef'

export function sse(events) {
  return events.map((e) => (typeof e === 'string' ? e : `data:${JSON.stringify(e)}`)).join('\n\n') + '\n\n'
}

export const ev = {
  text: (delta, end) => ({ sessionId: 1, content: { type: 'ANSWER', detail: { delta, ...(end ? { end: true } : {}) } } }),
  reason: (reasoningDelta) => ({ content: { type: 'ANSWER', detail: { reasoningDelta } } }),
  usage: (inputTokens, outputTokens, cachedInputTokens = 0) => ({ content: { type: 'TOKEN_USAGE', detail: { usage: { inputTokens, outputTokens, cachedInputTokens } } } }),
  fnStart: (id, name) => ({ content: { type: 'FUNCTION_CALL_START', detail: { toolUse: [{ id, name, input: {} }] } } }),
  fnAppend: (id, input) => ({ content: { type: 'FUNCTION_CALL_PARAMS_APPEND', detail: { toolUse: [{ id, input }] } } }),
  fnEnd: (id) => ({ content: { type: 'FUNCTION_CALL_END', detail: { toolUse: [{ id }], end: true } } }),
  notice: () => ({ content: { type: 'NOTIFICATION', detail: { msg: 'x' } } }),
  exception: (exceptionMsg) => ({ content: { type: 'EXCEPTION', detail: { exceptionMsg } } }),
  quota: () => ({ content: { type: 'QUOTA_EXCEED', detail: { reason: 'daily' } } }),
}

export const MODELS = [
  // shape as the live endpoint answers (2026-11-13): most fields may be null
  { modelId: 'auto', displayName: 'Auto', provider: null, requestType: 'COMATE_DEFAULT_MODE', supportImage: null, supportThinking: null, maxContextWindow: null, ratio: null, thinkingConfig: null, effortConfig: null },
  { modelId: 'glm-5.3', displayName: 'GLM-5.3', supportThinking: true, thinkingConfig: { switchable: false }, effortConfig: { levels: [{ value: 'low' }, { value: 'high' }, { value: 'max' }] }, maxContextWindow: 200000, ratio: 2 },
  { modelId: 'kimi-k2.6', displayName: 'Kimi-K2.6', supportThinking: false, contextWindow: 256000 },
]

/**
 * @param {object} o
 * @param {Array<string|Array>} o.executes  one SSE script per /execute call (array of events or raw string)
 * @param {boolean} o.badLicense
 */
export function createBackend({ executes = [], badLicense = false, chunkSize = 7 } = {}) {
  const calls = []
  let execN = 0
  let convN = 0
  let taskN = 0
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } })
  const fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url)
    const headers = Object.fromEntries(new Headers(init.headers ?? {}).entries())
    const body = init.body ? JSON.parse(init.body) : undefined
    calls.push({ method: init.method ?? 'GET', path: url.pathname, search: url.search, headers, body })
    const p = url.pathname
    if (p.startsWith('/api/key/valid/')) return json({ status: 'OK', data: !badLicense && decodeURIComponent(p.split('/').pop()) === LICENSE })
    if (headers['login-name'] !== encodeURIComponent(LICENSE) || badLicense) return json({ code: 401, message: 'license invalid' })
    if (p === '/api/v2/api/models/available') return json({ status: 'OK', data: MODELS })
    if (p.endsWith('/rest/autowork/v2/conversation')) return json({ code: 200, data: { id: 111 + convN++ } })
    if (p.endsWith('/rest/autowork/v2/task')) return json({ code: 200, data: { taskId: 222 + taskN++ } })
    if (p.endsWith('/rest/autowork/v2/execute')) {
      const script = executes[execN++] ?? [ev.text('', true)]
      if (script && script.httpJson) return json(script.httpJson)
      const text = typeof script === 'string' ? script : sse(script)
      const bytes = new TextEncoder().encode(text)
      const stream = new ReadableStream({
        start(c) {
          for (let i = 0; i < bytes.length; i += chunkSize) c.enqueue(bytes.slice(i, i + chunkSize))
          c.close()
        },
      })
      return new Response(stream, { headers: { 'content-type': 'text/event-stream;charset=UTF-8' } })
    }
    return json({ code: 404, message: 'no route ' + p }, 404)
  }
  return {
    fetch,
    calls,
    executeCalls: () => calls.filter((c) => c.path.endsWith('/v2/execute')),
    conversationCalls: () => calls.filter((c) => c.path.endsWith('/v2/conversation')),
    reset: () => calls.splice(0),
  }
}

export async function readSSE(res) {
  const text = await res.text()
  return text
    .split('\n\n')
    .map((b) => b.replace(/^data: /, '').trim())
    .filter(Boolean)
    .map((d) => (d === '[DONE]' ? d : JSON.parse(d)))
}
