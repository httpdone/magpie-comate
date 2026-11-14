import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handleChatCompletions, handleModels } from '../lib/handler.mjs'
import { createBackend, ev, LICENSE, readSSE, sse } from './mock.mjs'

const tools = [
  { type: 'function', function: { name: 'bash', description: 'Run a shell command', parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] } } },
  { type: 'function', function: { name: 'web_search', description: 'Search', parameters: { type: 'object', properties: { q: { type: 'string' } } } } },
]

function run(backend, body) {
  return handleChatCompletions({ body, license: LICENSE, fetchImpl: backend.fetch })
}

test('non-streaming text answer, request shape and auth headers', async () => {
  const b = createBackend({ executes: [[ev.notice(), ev.text('你好，'), ev.text('世界'), ev.usage(10, 3, 2), ev.text('', true)]] })
  const res = await run(b, { model: 'kimi-k2.6-oneapi_22222222222222222222222222222222', messages: [{ role: 'system', content: 'Be nice' }, { role: 'user', content: 'hi' }] })
  assert.equal(res.status, 200)
  const j = await res.json()
  assert.equal(j.object, 'chat.completion')
  assert.equal(j.choices[0].message.content, '你好，世界')
  assert.equal(j.choices[0].finish_reason, 'stop')
  assert.deepEqual(j.usage, { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15, prompt_tokens_details: { cached_tokens: 2 } })

  const paths = b.calls.map((c) => c.path)
  assert.deepEqual(paths, ['/api/aidevops/autocomate/rest/autowork/v2/conversation', '/api/aidevops/autocomate/rest/autowork/v2/task', '/api/aidevops/autocomate/rest/autowork/v2/execute'])
  const exec = b.executeCalls()[0]
  assert.equal(exec.headers['login-name'], encodeURIComponent(LICENSE))
  assert.equal(exec.headers['x-source'], 'COMATE')
  assert.equal(exec.body.username, LICENSE)
  assert.equal(exec.body.conversationId, 111)
  assert.equal(exec.body.taskId, 222)
  assert.equal(exec.body.modelKey, 'kimi-k2.6-oneapi_22222222222222222222222222222222')
  assert.equal(exec.body.query, 'hi')
  assert.equal(exec.body.isFirstQuery, true)
  assert.match(exec.body.systemReminder, /Be nice/)
  assert.doesNotMatch(JSON.stringify(j), new RegExp(LICENSE))
})

test('streaming: role, reasoning, text, usage, [DONE]', async () => {
  const b = createBackend({ executes: [[ev.reason('想一想'), ev.text('答'), ev.text('案'), ev.usage(5, 2), ev.text('', true)]] })
  const res = await run(b, { model: 'glm-5.3_00000000000000000000000000000000', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'q' }] })
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /text\/event-stream/)
  const events = await readSSE(res)
  assert.equal(events.at(-1), '[DONE]')
  const chunks = events.slice(0, -1)
  assert.deepEqual(chunks[0].choices[0].delta, { role: 'assistant', content: '' })
  assert.equal(chunks.map((c) => c.choices[0]?.delta?.reasoning_content ?? '').join(''), '想一想')
  assert.equal(chunks.map((c) => c.choices[0]?.delta?.content ?? '').join(''), '答案')
  const fin = chunks.find((c) => c.choices[0]?.finish_reason)
  assert.equal(fin.choices[0].finish_reason, 'stop')
  assert.deepEqual(chunks.at(-1).usage, { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 })
})

test('streaming: XML tool call becomes OpenAI tool_calls', async () => {
  const xml = '好的。<tool_call_call id="call_9" name="bash">\n<arguments>\n{"cmd":"ls -la"}\n</arguments>\n</tool_call_call>'
  const parts = xml.match(/.{1,5}/gs).map((d) => ev.text(d))
  const b = createBackend({ executes: [[...parts, ev.text('', true)]] })
  const res = await run(b, { model: 'glm-5.3_00000000000000000000000000000000', stream: true, tools, messages: [{ role: 'user', content: 'list' }] })
  const chunks = (await readSSE(res)).slice(0, -1)
  assert.equal(chunks.map((c) => c.choices[0]?.delta?.content ?? '').join(''), '好的。')
  const tc = chunks.flatMap((c) => c.choices[0]?.delta?.tool_calls ?? [])
  assert.deepEqual(tc, [{ index: 0, id: 'call_9', type: 'function', function: { name: 'bash', arguments: '{"cmd":"ls -la"}' } }])
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'tool_calls')
  assert.match(b.executeCalls()[0].body.systemReminder, /\[Tool 1\] bash/)
})

test('non-streaming: multi-turn with tool results renders a transcript', async () => {
  const b = createBackend({ executes: [[ev.text('两个文件', true)]] })
  const res = await run(b, {
    model: 'glm-5.3_00000000000000000000000000000000', tools,
    messages: [
      { role: 'user', content: 'list' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'bash', arguments: '{"cmd":"ls"}' } }] },
      { role: 'tool', tool_call_id: 'call_9', content: 'a\nb' },
    ],
  })
  assert.equal((await res.json()).choices[0].message.content, '两个文件')
  const q = b.executeCalls()[0].body.query
  assert.match(q, /<tool_result id="call_9" name="bash">\na\nb\n<\/tool_result>/)
})

test('native Comate tool call matching a client tool is passed through', async () => {
  const b = createBackend({ executes: [[ev.fnStart('t1', 'web_search'), ev.fnAppend('t1', { q: 'magpie ' }), ev.fnAppend('t1', { q: 'gateway' }), ev.fnEnd('t1')]] })
  const res = await run(b, { model: 'glm-5.3_00000000000000000000000000000000', tools, messages: [{ role: 'user', content: 'search' }] })
  const j = await res.json()
  assert.equal(j.choices[0].finish_reason, 'tool_calls')
  assert.deepEqual(j.choices[0].message.tool_calls, [{ id: 't1', type: 'function', function: { name: 'web_search', arguments: '{"q":"magpie gateway"}' } }])
  assert.equal(b.executeCalls().length, 1)
})

test('unknown native tool call is answered upstream and the turn continues', async () => {
  const b = createBackend({
    executes: [
      [ev.fnStart('t1', 'read_file'), ev.fnAppend('t1', { path: 'x' }), ev.fnEnd('t1')],
      [ev.text('<tool_call_call id="c1" name="bash"><arguments>{"cmd":"cat x"}</arguments></tool_call_call>', true)],
    ],
  })
  const res = await run(b, { model: 'glm-5.3_00000000000000000000000000000000', tools, messages: [{ role: 'user', content: 'read x' }] })
  const j = await res.json()
  assert.deepEqual(j.choices[0].message.tool_calls.map((t) => t.function.name), ['bash'])
  const ex = b.executeCalls()
  assert.equal(ex.length, 2)
  assert.equal(ex[1].body.isUserQuery, false)
  assert.equal(ex[1].body.isFirstQuery, undefined)
  assert.equal(ex[1].body.query, '')
  assert.equal(ex[1].body.toolUseResults[0].id, 't1')
  assert.equal(ex[1].body.toolUseResults[0].name, 'read_file')
  assert.equal(ex[1].body.toolUseResults[0].success, false)
  assert.match(ex[1].body.toolUseResults[0].message, /not available/)
})

test('bad license → HTTP 401 before streaming starts, license not echoed', async () => {
  const b = createBackend({ badLicense: true })
  const res = await run(b, { model: 'glm-5.3_00000000000000000000000000000000', stream: true, messages: [{ role: 'user', content: 'q' }] })
  assert.equal(res.status, 401)
  const j = await res.json()
  assert.equal(j.error.type, 'authentication_error')
  assert.doesNotMatch(JSON.stringify(j), new RegExp(LICENSE))
})

test('QUOTA_EXCEED as first frame → HTTP 429', async () => {
  const b = createBackend({ executes: [[ev.quota()]] })
  const res = await run(b, { model: 'glm-5.3_00000000000000000000000000000000', stream: true, messages: [{ role: 'user', content: 'q' }] })
  assert.equal(res.status, 429)
})

test('EXCEPTION after output → error event inside the stream', async () => {
  const b = createBackend({ executes: [[ev.text('部分'), ev.exception('boom ' + LICENSE)]] })
  const res = await run(b, { model: 'glm-5.3_00000000000000000000000000000000', stream: true, messages: [{ role: 'user', content: 'q' }] })
  assert.equal(res.status, 200)
  const events = await readSSE(res)
  const err = events.find((e) => e.error)
  assert.match(err.error.message, /boom \*\*\*/)
  assert.doesNotMatch(JSON.stringify(events), new RegExp(LICENSE))
  assert.equal(events.at(-1), '[DONE]')
})

test('execute answering JSON envelope instead of SSE → mapped error', async () => {
  const b = createBackend({ executes: [{ httpJson: { code: 429, message: '资源使用超过限制' } }] })
  const res = await run(b, { model: 'glm-5.3_00000000000000000000000000000000', messages: [{ role: 'user', content: 'q' }] })
  assert.equal(res.status, 429)
})

test('/v1/models lists the account models exactly as the API names them', async () => {
  const b = createBackend()
  const res = await handleModels({ license: LICENSE, fetchImpl: b.fetch })
  const j = await res.json()
  assert.deepEqual(j.data.map((m) => m.id), ['glm-5.3_00000000000000000000000000000000', 'deepseek-v4-flash_11111111111111111111111111111111', 'kimi-k2.6-oneapi_22222222222222222222222222222222'])
  assert.equal(j.data[0].name, 'GLM-5.3')
  assert.match(b.calls[0].search, /key=LIC-test/)
  assert.match(b.calls[0].search, /type=ZULU/)
})

test('a request without a model is refused, nothing sent upstream', async () => {
  const b = createBackend()
  const res = await run(b, { messages: [{ role: 'user', content: 'q' }] })
  assert.equal(res.status, 400)
  assert.equal(b.calls.length, 0)
})

async function execBody(body, effortHeader) {
  const b = createBackend({ executes: [[ev.text('ok', true)]] })
  const { MODELS, CONFIGURED } = await import('./mock.mjs')
  await handleChatCompletions({
    body: { messages: [{ role: 'user', content: 'q' }], ...body },
    license: LICENSE, fetchImpl: b.fetch, effortHeader,
    getModelInfo: async (id) => [...MODELS, ...CONFIGURED].find((m) => m.modelId === id),
  }).then((r) => r.json())
  return b.executeCalls()[0].body
}

test('execute carries thinkingEnabled / effort only when the model entry offers them', async () => {
  // live models: supportThinking true, thinkingConfig / effortConfig null → neither field, whatever is asked
  for (const model of ['glm-5.3_00000000000000000000000000000000', 'deepseek-v4-flash_11111111111111111111111111111111', 'kimi-k2.6-oneapi_22222222222222222222222222222222', 'not-in-list']) {
    for (const ask of [{ reasoning_effort: 'high' }, { reasoning_effort: 'none' }, {}]) {
      const body = await execBody({ model, ...ask }, ask.reasoning_effort === 'high' ? 'max' : undefined)
      assert.equal('thinkingEnabled' in body, false, model)
      assert.equal('effort' in body, false, model)
      assert.equal(body.modelKey, model)
    }
  }
  // effortConfig levels: clamped, default defaultLevel; thinkingConfig.switchable false → no thinkingEnabled
  const L = 'x-levels_00000000000000000000000000000001'
  let body = await execBody({ model: L, reasoning_effort: 'high' })
  assert.equal('thinkingEnabled' in body, false)
  assert.equal(body.effort, 'high')
  assert.equal((await execBody({ model: L, reasoning_effort: 'medium' })).effort, 'low')
  assert.equal((await execBody({ model: L })).effort, 'high')
  assert.equal((await execBody({ model: L, reasoning_effort: 'low' }, 'max')).effort, 'max', 'X-Magpie-Effort wins')
  // thinkingConfig.switchable true, no levels: on/off only
  const S = 'x-switch_00000000000000000000000000000002'
  body = await execBody({ model: S, reasoning_effort: 'none' })
  assert.equal(body.thinkingEnabled, false)
  assert.equal('effort' in body, false)
  assert.equal((await execBody({ model: S })).thinkingEnabled, true)
  assert.equal((await execBody({ model: S, thinking: { type: 'disabled' } })).thinkingEnabled, false)
  // server-routed (COMATE_DEFAULT_MODE): nothing
  body = await execBody({ model: 'x-routed', reasoning_effort: 'none' })
  assert.equal('thinkingEnabled' in body || 'effort' in body, false)
  // max_tokens / temperature have no execute field
  body = await execBody({ model: 'glm-5.3_00000000000000000000000000000000', max_tokens: 100, temperature: 0.2 })
  assert.equal('max_tokens' in body || 'temperature' in body, false)
})

test('raw SSE helper sanity', () => {
  assert.match(sse([ev.text('a')]), /^data:\{/)
})
