import { test } from 'node:test'
import assert from 'node:assert/strict'
import { profileOf, effortsOf, clampLevel, budgetEffort } from '../lib/models.mjs'
import { createXmlSplitter, buildQuery, buildSystemReminder, normalizeTools, thinkingFor, createNativeCollector, toMagpieModel, matchClientTool } from '../lib/translate.mjs'
import { parseSSE } from '../lib/comate.mjs'
import { MODELS, CONFIGURED, GLM, DSF, KIMI } from './mock.mjs'

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

test('thinking/effort mapping follows the model entry only', () => {
  const [lv, sw, routed] = CONFIGURED
  // live entries: no thinkingConfig / effortConfig → nothing sent
  for (const m of MODELS) {
    for (const ask of [{}, { reasoning_effort: 'high' }, { reasoning_effort: 'none' }, { thinking: { type: 'enabled', budget_tokens: 30000 } }]) {
      assert.deepEqual(thinkingFor(ask, m, 'max'), {})
    }
  }
  assert.deepEqual(thinkingFor({}, lv), { effort: 'high' })
  assert.deepEqual(thinkingFor({ reasoning_effort: 'medium' }, lv), { effort: 'low' })
  assert.deepEqual(thinkingFor({ reasoning_effort: 'xhigh' }, lv), { effort: 'max' })
  assert.deepEqual(thinkingFor({ reasoning_effort: 'none' }, lv), { effort: 'high' }, 'cannot be turned off')
  assert.deepEqual(thinkingFor({ thinking: { type: 'enabled', budget_tokens: 2000 } }, lv), { effort: 'low' })
  assert.deepEqual(thinkingFor({ thinking: { type: 'enabled', budget_tokens: 30000 } }, lv), { effort: 'max' })
  assert.deepEqual(thinkingFor({ reasoning_effort: 'minimal' }, sw), { thinkingEnabled: false })
  assert.deepEqual(thinkingFor({ reasoning: { effort: 'low' } }, sw), { thinkingEnabled: true })
  assert.deepEqual(thinkingFor({ reasoning_effort: 'none' }, routed), {})
  // a model not in the list: nothing is guessed from its name
  assert.deepEqual(thinkingFor({ model: 'glm-6', reasoning_effort: 'high' }, undefined), {})
})

test('model profiles come straight from the API entry', () => {
  const [glm, dsf, kimi] = MODELS
  assert.equal(profileOf(glm).id, GLM)
  assert.equal(profileOf(glm).context, 1000000)
  assert.equal(profileOf(dsf).context, 1024000)
  assert.equal(profileOf(kimi).context, 256000)
  assert.equal(profileOf(dsf).rate, 0.3)
  assert.equal(profileOf(glm).thinking, true)
  assert.deepEqual(effortsOf(profileOf(glm)), [])
  // missing field → the one generic default, regardless of the id
  assert.equal(profileOf({ modelId: 'glm-5.3_x', maxContextWindow: null }).context, 128000)
  assert.equal(profileOf({ modelId: 'glm-5.3_x' }).thinking, false)
  assert.deepEqual(effortsOf(profileOf(CONFIGURED[0])), ['low', 'high', 'max'])
  assert.deepEqual(effortsOf(profileOf(CONFIGURED[1])), ['none', 'high'])
  assert.deepEqual(effortsOf(profileOf(CONFIGURED[2])), [])
  assert.equal(profileOf({ modelId: 'x', ratio: '1.5x' }).rate, 1.5)
  assert.equal(profileOf({ modelId: 'x', ratio: 2 }).rate, 2)
  assert.equal(clampLevel('medium', ['low', 'high']), 'low')
  assert.equal(clampLevel('low', ['high', 'max']), 'high')
  assert.equal(budgetEffort(-1), '')
  assert.equal(budgetEffort(0), 'none')
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
  const m = toMagpieModel(MODELS[0], { limit: { context: 1, output: 32000 } })
  assert.equal(m.id, GLM)
  assert.equal(m.name, 'GLM-5.3')
  assert.equal(m.limit.context, 1000000)
  assert.equal(m.limit.output, 32000)
  assert.equal(m.reasoning, true)
  assert.equal(m.variants, undefined)
  assert.equal(m.rate, 1)
  assert.equal(m.temperature, false)
  assert.deepEqual(m.modalities.input, ['text'])
  const om = toMagpieModel(MODELS[2], { api: { id: 'x', npm: '@ai-sdk/openai-compatible', url: 'u' }, capabilities: { reasoning: false, toolcall: true } })
  assert.equal(om.api.id, KIMI)
  assert.equal(om.api.url, 'u')
  assert.equal(toMagpieModel(MODELS[1]).rate, 0.3)
  assert.equal(toMagpieModel(MODELS[1]).id, DSF)
  const c = toMagpieModel(CONFIGURED[0])
  assert.deepEqual(Object.keys(c.variants), ['low', 'high', 'max'])
  assert.equal(c.limit.context, 200000)
  assert.equal(toMagpieModel(CONFIGURED[2]).reasoning, false)
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
