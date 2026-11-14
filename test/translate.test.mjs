import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createXmlSplitter, buildQuery, buildSystemReminder, normalizeTools, thinkingFor, createNativeCollector, toMagpieModel, matchClientTool } from '../lib/translate.mjs'
import { parseSSE } from '../lib/comate.mjs'
import { MODELS } from './mock.mjs'

test('XML splitter cuts tool calls out of text across arbitrary chunk boundaries', () => {
  const full = 'Let me look.<tool_call_call id="call_1" name="read">\n<arguments>\n{"path":"a.txt"}\n</arguments>\n</tool_call_call> and a < b <tool_c'
  for (let size = 1; size <= 9; size++) {
    const s = createXmlSplitter()
    let text = ''
    const calls = []
    for (let i = 0; i < full.length; i += size) {
      const r = s.push(full.slice(i, i + size))
      text += r.text
      calls.push(...r.calls)
    }
    const r = s.end()
    text += r.text
    calls.push(...r.calls)
    assert.equal(text, 'Let me look. and a < b <tool_c')
    assert.deepEqual(calls, [{ id: 'call_1', name: 'read', arguments: '{"path":"a.txt"}' }])
  }
})

test('XML splitter keeps bad JSON as raw and tolerates code fences', () => {
  const s = createXmlSplitter()
  const r1 = s.push('<tool_call_call name="x"><arguments>```json\n{"a":1}\n```</arguments></tool_call_call>')
  assert.equal(r1.calls[0].arguments, '{"a":1}')
  assert.match(r1.calls[0].id, /^call_/)
  const r2 = s.push('<tool_call_call id="c2" name="y"><arguments>not json</arguments></tool_call_call>')
  assert.equal(r2.calls[0].arguments, JSON.stringify({ raw: 'not json' }))
})

test('single user message is sent as is; history becomes a transcript', () => {
  assert.equal(buildQuery([{ role: 'system', content: 's' }, { role: 'user', content: 'hi' }]), 'hi')
  const q = buildQuery([
    { role: 'system', content: 'sys' },
    { role: 'user', content: [{ type: 'text', text: 'list files' }] },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{"cmd":"ls"}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'a.txt\nb.txt' },
  ])
  assert.match(q, /<user>\nlist files\n<\/user>/)
  assert.match(q, /<tool_call_call id="c1" name="bash">/)
  assert.match(q, /<tool_result id="c1" name="bash">\na.txt\nb.txt\n<\/tool_result>/)
  assert.match(q, /<current_turn>\nContinue: use the tool results/)
  assert.doesNotMatch(q, /sys/)
})

test('system reminder carries caller system prompt and tool schemas', () => {
  const tools = normalizeTools([{ type: 'function', function: { name: 'bash', description: 'run', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } } }])
  const s = buildSystemReminder([{ role: 'system', content: 'Be terse.' }, { role: 'user', content: 'x' }], tools, 'required')
  assert.match(s, /Be terse\./)
  assert.match(s, /\[Tool 1\] bash/)
  assert.match(s, /MUST call at least one tool/)
  assert.match(buildSystemReminder([], [], undefined), /No tools are available/)
})

test('thinking/effort mapping follows the model entry', () => {
  const glm = MODELS[1]
  assert.deepEqual(thinkingFor({}, glm), { thinkingEnabled: true, effort: 'max' })
  assert.deepEqual(thinkingFor({ reasoning_effort: 'medium' }, glm), { thinkingEnabled: true, effort: 'low' })
  assert.deepEqual(thinkingFor({ reasoning_effort: 'high' }, glm), { thinkingEnabled: true, effort: 'high' })
  assert.deepEqual(thinkingFor({}, MODELS[2]), { thinkingEnabled: false, effort: 'low' })
  assert.deepEqual(thinkingFor({ reasoning_effort: 'high' }, undefined), { thinkingEnabled: true, effort: 'high' })
})

test('native tool call collector merges appended params', () => {
  const c = createNativeCollector()
  c.onEvent({ content: { type: 'FUNCTION_CALL_START', detail: { toolUse: [{ id: 't1', name: 'read_file', input: {} }] } } })
  c.onEvent({ content: { type: 'FUNCTION_CALL_PARAMS_APPEND', detail: { toolUse: [{ id: 't1', input: { path: 'src/' } }] } } })
  c.onEvent({ content: { type: 'FUNCTION_CALL_PARAMS_APPEND', detail: { toolUse: [{ id: 't1', input: { path: 'a.js' } }] } } })
  assert.deepEqual(c.result(), [{ id: 't1', name: 'read_file', params: { path: 'src/a.js' } }])
  assert.equal(matchClientTool('web_search', [{ name: 'WebSearch' }]).name, 'WebSearch')
  assert.equal(matchClientTool('read_file', [{ name: 'Read' }]), undefined)
})

test('model mapping', () => {
  const m = toMagpieModel(MODELS[1], { limit: { context: 1, output: 32000 } })
  assert.equal(m.id, 'glm-5.3')
  assert.equal(m.name, 'GLM-5.3')
  assert.equal(m.limit.context, 200000)
  assert.equal(m.reasoning, true)
  assert.deepEqual(Object.keys(m.variants), ['low', 'high', 'max'])
  assert.equal(m.rate, 2)
  const om = toMagpieModel(MODELS[2], { id: 'auto', api: { id: 'auto', npm: '@ai-sdk/openai-compatible', url: 'u' }, capabilities: { reasoning: false, toolcall: true } })
  assert.equal(om.api.id, 'kimi-k2.6')
  assert.equal(om.api.url, 'u')
  assert.equal(toMagpieModel(MODELS[2]).variants, undefined)
  assert.equal(toMagpieModel(MODELS[0]).limit.context, 128000)
})

test('SSE parser: split lines, heartbeats, [DONE], CRLF', async () => {
  const raw = ':heartbeat\r\ndata:{"a":1}\r\n\r\nevent: x\ndata: {"b":2}\n\ndata: [DONE]\n\ndata: {"c":3}'
  const bytes = new TextEncoder().encode(raw)
  const chunks = []
  for (let i = 0; i < bytes.length; i += 3) chunks.push(bytes.slice(i, i + 3))
  const out = []
  for await (const e of parseSSE(chunks)) out.push(e)
  assert.deepEqual(out, [{ a: 1 }, { b: 2 }, { c: 3 }])
})
