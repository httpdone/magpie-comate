// toolMode "mcp": the caller's tools are exposed as one MCP server and called via use_mcp_tool.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handleChatCompletions } from '../lib/handler.mjs'
import { createSessionStore } from '../lib/sessions.mjs'
import { MCP_SERVER, mapNativeCall, normalizeTools } from '../lib/translate.mjs'
import { createBackend, ev, LICENSE, readSSE } from './mock.mjs'

const tools = [
  { type: 'function', function: { name: 'bash', description: 'Run a command', parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] } } },
  { type: 'function', function: { name: 'web_search', description: 'Search', parameters: { type: 'object', properties: { q: { type: 'string' } } } } },
]
const MCP = { toolMode: 'mcp' }

async function chat(b, messages, { options = MCP, sessions, ...extra } = {}) {
  const res = await handleChatCompletions({ body: { model: 'glm-5.3_00000000000000000000000000000000', tools, messages, ...extra }, license: LICENSE, options, fetchImpl: b.fetch, sessions })
  return extra.stream ? { res, events: await readSSE(res) } : { res, json: await res.json() }
}

const mcpCall = (id, tool, argChunks) => [
  ev.fnStart(id, 'use_mcp_tool'),
  ev.fnAppend(id, { server_name: MCP_SERVER, tool_name: tool }),
  ...argChunks.map((a) => ev.fnAppend(id, { arguments: a })),
  ev.fnEnd(id),
]

test('mcp mode advertises the tools like an MCP server (hasMcp + skillInfos + schemas)', async () => {
  const b = createBackend({ executes: [[ev.text('ok', true)]] })
  await chat(b, [{ role: 'user', content: 'hi' }])
  const body = b.executeCalls()[0].body
  assert.equal(body.hasMcp, true)
  assert.deepEqual(body.skillInfos, [{ name: MCP_SERVER, description: `Includes MCP server named ${MCP_SERVER} with these tools: bash, web_search`, type: 'mcp' }])
  assert.match(body.systemReminder, /use_mcp_tool/)
  assert.match(body.systemReminder, /server_name: "client_tools"/)
  assert.match(body.systemReminder, /"required":\["cmd"\]/)
  assert.match(body.systemReminder, /tool_call_call/, 'XML kept as fallback')
})

test('xml mode (default) and mcp mode without tools keep hasMcp false and no skillInfos', async () => {
  const b = createBackend({ executes: [[ev.text('ok', true)], [ev.text('ok', true)]] })
  await chat(b, [{ role: 'user', content: 'hi' }], { options: {} })
  await chat(b, [{ role: 'user', content: 'hi' }], { tools: [] })
  for (const c of b.executeCalls()) {
    assert.equal(c.body.hasMcp, false)
    assert.equal(c.body.skillInfos, undefined)
    assert.doesNotMatch(c.body.systemReminder, /use_mcp_tool/)
  }
})

test('use_mcp_tool call becomes an OpenAI tool_call (streamed arguments string)', async () => {
  const b = createBackend({ executes: [[ev.text('Running. '), ...mcpCall('m1', 'bash', ['{"cmd":', '"ls -la"}'])]] })
  const { json } = await chat(b, [{ role: 'user', content: 'list' }])
  assert.equal(json.choices[0].finish_reason, 'tool_calls')
  assert.equal(json.choices[0].message.content, 'Running. ')
  assert.deepEqual(json.choices[0].message.tool_calls, [{ id: 'm1', type: 'function', function: { name: 'bash', arguments: '{"cmd":"ls -la"}' } }])
})

test('streaming: use_mcp_tool arrives as tool_calls chunk', async () => {
  const b = createBackend({ executes: [mcpCall('m2', 'web_search', ['{"q":"comate"}'])] })
  const { events } = await chat(b, [{ role: 'user', content: 'search' }], { stream: true })
  const tc = events.flatMap((e) => e.choices?.[0]?.delta?.tool_calls ?? [])
  assert.deepEqual(tc, [{ index: 0, id: 'm2', type: 'function', function: { name: 'web_search', arguments: '{"q":"comate"}' } }])
  assert.equal(events.at(-2).choices[0].finish_reason, 'tool_calls')
})

test('tool result goes back as toolUseResults on the same task (official MCP flow)', async () => {
  const b = createBackend({ executes: [mcpCall('m1', 'bash', ['{"cmd":"ls"}']), [ev.text('two files', true)]] })
  const store = createSessionStore()
  const t1 = [{ role: 'user', content: 'list' }]
  const r1 = await chat(b, t1, { sessions: store })
  const call = r1.json.choices[0].message.tool_calls[0]
  const r2 = await chat(b, [...t1, { role: 'assistant', content: null, tool_calls: [call] }, { role: 'tool', tool_call_id: 'm1', content: 'a.txt\nb.txt' }], { sessions: store })
  assert.equal(r2.json.choices[0].message.content, 'two files')
  assert.equal(b.conversationCalls().length, 1)
  const body = b.executeCalls()[1].body
  assert.equal(body.query, '')
  assert.equal(body.isUserQuery, false)
  assert.equal(body.isFirstQuery, undefined)
  assert.equal(body.hasMcp, true)
  assert.equal(body.skillInfos, undefined, 'skillInfos only on the first query')
  assert.deepEqual(body.toolUseResults, [{ id: 'm1', name: 'use_mcp_tool', success: true, params: { server_name: MCP_SERVER, tool_name: 'bash', arguments: '{"cmd":"ls"}' }, message: 'a.txt\nb.txt' }])
})

test('skill call loading the virtual server is answered with the schemas, then the call passes', async () => {
  const b = createBackend({
    executes: [
      [ev.fnStart('s1', 'skill'), ev.fnAppend('s1', { name: MCP_SERVER }), ev.fnEnd('s1')],
      mcpCall('m1', 'bash', ['{"cmd":"pwd"}']),
    ],
  })
  const { json } = await chat(b, [{ role: 'user', content: 'where am i' }])
  assert.deepEqual(json.choices[0].message.tool_calls.map((t) => [t.function.name, t.function.arguments]), [['bash', '{"cmd":"pwd"}']])
  const second = b.executeCalls()[1].body
  assert.equal(second.isUserQuery, false)
  const r = second.toolUseResults[0]
  assert.equal(r.id, 's1')
  assert.equal(r.success, true)
  assert.match(r.message, /<server name="client_tools">/)
  assert.match(r.message, /<server_tool name="bash">/)
})

test('XML block still works in mcp mode (fallback)', async () => {
  const b = createBackend({ executes: [[ev.text('<tool_call_call id="c1" name="bash"><arguments>{"cmd":"id"}</arguments></tool_call_call>', true)]] })
  const { json } = await chat(b, [{ role: 'user', content: 'who' }])
  assert.deepEqual(json.choices[0].message.tool_calls, [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{"cmd":"id"}' } }])
})

test('unknown native tool is rejected with use_mcp_tool guidance; carried with the next results', async () => {
  const b = createBackend({
    executes: [
      [ev.fnStart('r1', 'read_file'), ev.fnAppend('r1', { path: 'x' }), ev.fnEnd('r1'), ...mcpCall('m1', 'bash', ['{"cmd":"cat x"}'])],
      [ev.text('done', true)],
    ],
  })
  const store = createSessionStore()
  const t1 = [{ role: 'user', content: 'read x' }]
  const r1 = await chat(b, t1, { sessions: store })
  const calls = r1.json.choices[0].message.tool_calls
  assert.deepEqual(calls.map((c) => c.function.name), ['bash'])
  assert.equal(b.executeCalls().length, 1, 'caller has a call to run: no extra round')
  await chat(b, [...t1, { role: 'assistant', content: null, tool_calls: calls }, { role: 'tool', tool_call_id: 'm1', content: 'X' }], { sessions: store })
  const res = b.executeCalls()[1].body.toolUseResults
  assert.deepEqual(res.map((r) => [r.id, r.name, r.success]), [['r1', 'read_file', false], ['m1', 'use_mcp_tool', true]])
  assert.match(res[0].message, /use_mcp_tool with server_name "client_tools"/)
})

test('use_mcp_tool naming an unknown tool is rejected and retried upstream', async () => {
  const b = createBackend({ executes: [mcpCall('m9', 'rm_rf', ['{}']), [ev.text('sorry', true)]] })
  const { json } = await chat(b, [{ role: 'user', content: 'x' }])
  assert.equal(json.choices[0].message.content, 'sorry')
  const r = b.executeCalls()[1].body.toolUseResults[0]
  assert.equal(r.id, 'm9')
  assert.equal(r.success, false)
})

test('mapNativeCall: arguments as JSON string, object or empty; server name not required to match', () => {
  const t = normalizeTools(tools)
  assert.deepEqual(mapNativeCall({ name: 'use_mcp_tool', params: { server_name: MCP_SERVER, tool_name: 'bash', arguments: '{"cmd":"a"}' } }, t).args, { cmd: 'a' })
  assert.deepEqual(mapNativeCall({ name: 'use_mcp_tool', params: { server_name: 'other', tool_name: 'bash', arguments: { cmd: 'b' } } }, t).args, { cmd: 'b' })
  assert.deepEqual(mapNativeCall({ name: 'use_mcp_tool', params: { tool_name: 'web_search' } }, t).args, {})
  assert.deepEqual(mapNativeCall({ name: 'use_mcp_tool', params: { tool_name: 'bash', arguments: 'not json' } }, t).args, { raw: 'not json' })
  assert.equal(mapNativeCall({ name: 'use_mcp_tool', params: { tool_name: 'nope' } }, t), undefined)
  assert.equal(mapNativeCall({ name: 'web_search', params: { q: 1 } }, t).tool.name, 'web_search')
  assert.equal(mapNativeCall({ name: 'use_mcp_tool', params: { tool_name: 'bash' } }, []), undefined)
})

test('switching toolMode does not reuse a session cached under the other mode', async () => {
  const b = createBackend({ executes: [[ev.text('a', true)], [ev.text('b', true)]] })
  const store = createSessionStore()
  const t1 = [{ role: 'user', content: 'hi' }]
  await chat(b, t1, { sessions: store, options: {} })
  await chat(b, [...t1, { role: 'assistant', content: 'a' }, { role: 'user', content: 'again' }], { sessions: store })
  assert.equal(b.conversationCalls().length, 2)
})
