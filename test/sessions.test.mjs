import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handleChatCompletions } from '../lib/handler.mjs'
import { createSessionStore, canonMessage, buildDelta } from '../lib/sessions.mjs'
import { _internal } from '../index.mjs'
import { createBackend, ev, LICENSE, readSSE } from './mock.mjs'

const tools = [
  { type: 'function', function: { name: 'bash', description: 'Run', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } } },
  { type: 'function', function: { name: 'web_search', description: 'Search', parameters: { type: 'object', properties: { q: { type: 'string' } } } } },
]
const SYS = { role: 'system', content: 'You are terse.' }

async function chat(b, sessions, messages, extra = {}) {
  const res = await handleChatCompletions({ body: { model: 'auto', messages, ...extra }, license: LICENSE, fetchImpl: b.fetch, sessions })
  return extra.stream ? { res, events: await readSSE(res) } : { res, json: await res.json() }
}

test('second turn continues the same Comate conversation with only the new message', async () => {
  const b = createBackend({ executes: [[ev.text('hello', true)], [ev.text('more!', true)]] })
  const store = createSessionStore()
  const t1 = [SYS, { role: 'user', content: 'hi' }]
  const r1 = await chat(b, store, t1)
  assert.equal(r1.json.choices[0].message.content, 'hello')
  assert.equal(store.size, 1)
  b.reset()

  const r2 = await chat(b, store, [...t1, { role: 'assistant', content: 'hello' }, { role: 'user', content: 'tell me more' }])
  assert.equal(r2.json.choices[0].message.content, 'more!')
  assert.equal(b.conversationCalls().length, 0, 'no new conversation')
  assert.equal(b.calls.filter((c) => c.path.endsWith('/v2/task')).length, 0, 'no new task')
  const ex = b.executeCalls()
  assert.equal(ex.length, 1)
  assert.equal(ex[0].body.conversationId, 111)
  assert.equal(ex[0].body.taskId, 222)
  assert.equal(ex[0].body.query, 'tell me more')
  assert.equal(ex[0].body.isUserQuery, true)
  assert.equal(ex[0].body.isFirstQuery, undefined)
  assert.doesNotMatch(ex[0].body.systemReminder, /You are terse/)
  assert.equal(store.size, 1, 'old state claimed, new state stored')
})

test('tolerates what clients change in the echoed assistant message', async () => {
  const xml = 'Sure. <tool_call_call id="call_1" name="bash"><arguments>{"cmd": "ls"}</arguments></tool_call_call>'
  const b = createBackend({ executes: [[ev.text(xml, true)], [ev.text('done', true)]] })
  const store = createSessionStore()
  const t1 = [SYS, { role: 'user', content: 'list' }]
  const r1 = await chat(b, store, t1, { tools })
  const call = r1.json.choices[0].message.tool_calls[0]
  b.reset()
  // content as parts, trailing whitespace, reasoning added, arguments re-serialised
  const echoed = { role: 'assistant', content: [{ type: 'text', text: '  Sure.\n' }], reasoning_content: 'x', tool_calls: [{ ...call, function: { ...call.function, arguments: '{ "cmd":"ls" }' } }] }
  await chat(b, store, [...t1, echoed, { role: 'tool', tool_call_id: 'call_1', content: 'a.txt' }], { tools })
  assert.equal(b.conversationCalls().length, 0)
})

test('XML tool results continue the task as a new user turn', async () => {
  const xml = '<tool_call_call id="call_9" name="bash"><arguments>{"cmd":"ls"}</arguments></tool_call_call>'
  const b = createBackend({ executes: [[ev.text('好的。'), ev.text(xml, true)], [ev.text('两个文件', true)]] })
  const store = createSessionStore()
  const t1 = [SYS, { role: 'user', content: 'list' }]
  const r1 = await chat(b, store, t1, { tools })
  const msg = r1.json.choices[0].message
  b.reset()
  const r2 = await chat(b, store, [...t1, msg, { role: 'tool', tool_call_id: 'call_9', content: 'a\nb' }], { tools })
  assert.equal(r2.json.choices[0].message.content, '两个文件')
  const ex = b.executeCalls()[0].body
  assert.equal(b.conversationCalls().length, 0)
  assert.equal(ex.taskId, 222)
  assert.match(ex.query, /^<tool_result id="call_9" name="bash">\na\nb\n<\/tool_result>/)
  assert.match(ex.query, /Continue: use the tool results/)
  assert.deepEqual(ex.toolUseResults, [])
  assert.equal(ex.isUserQuery, true)
  assert.doesNotMatch(ex.query, /conversation_history/)
})

test('results of passed-through Comate native calls go back as toolUseResults', async () => {
  const b = createBackend({
    executes: [
      [ev.fnStart('t1', 'web_search'), ev.fnAppend('t1', { q: 'magpie' }), ev.fnEnd('t1')],
      [ev.text('found it', true)],
    ],
  })
  const store = createSessionStore()
  const t1 = [{ role: 'user', content: 'search magpie' }]
  const r1 = await chat(b, store, t1, { tools })
  const msg = r1.json.choices[0].message
  assert.equal(msg.tool_calls[0].id, 't1')
  b.reset()
  await chat(b, store, [...t1, msg, { role: 'tool', tool_call_id: 't1', content: 'result page' }], { tools })
  const ex = b.executeCalls()[0].body
  assert.equal(b.conversationCalls().length, 0)
  assert.deepEqual(ex.toolUseResults, [{ id: 't1', name: 'web_search', success: true, params: { q: 'magpie' }, message: 'result page' }])
  assert.equal(ex.isUserQuery, false)
  assert.equal(ex.query, '')
})

test('edited history falls back to a fresh conversation with the full transcript', async () => {
  const b = createBackend({ executes: [[ev.text('hello', true)], [ev.text('fresh', true)]] })
  const store = createSessionStore()
  await chat(b, store, [{ role: 'user', content: 'hi' }])
  b.reset()
  await chat(b, store, [{ role: 'user', content: 'hi (edited)' }, { role: 'assistant', content: 'hello' }, { role: 'user', content: 'next' }])
  assert.equal(b.conversationCalls().length, 1)
  const ex = b.executeCalls()[0].body
  assert.equal(ex.conversationId, 112)
  assert.equal(ex.isFirstQuery, true)
  assert.match(ex.query, /<conversation_history>/)
})

test('changed system prompt or tools → fresh conversation', async () => {
  const b = createBackend({ executes: [[ev.text('a', true)], [ev.text('b', true)], [ev.text('c', true)]] })
  const store = createSessionStore()
  const t1 = [SYS, { role: 'user', content: 'hi' }]
  await chat(b, store, t1)
  b.reset()
  await chat(b, store, [{ role: 'system', content: 'Different.' }, t1[1], { role: 'assistant', content: 'a' }, { role: 'user', content: 'x' }])
  assert.equal(b.conversationCalls().length, 1)
  b.reset()
  await chat(b, store, [SYS, t1[1], { role: 'assistant', content: 'a' }, { role: 'user', content: 'x' }], { tools })
  assert.equal(b.conversationCalls().length, 1)
})

test('a retried request does not replay a turn the server already has', async () => {
  const b = createBackend({ executes: [[ev.text('hello', true)], [ev.text('r1', true)], [ev.text('r2', true)]] })
  const store = createSessionStore()
  await chat(b, store, [{ role: 'user', content: 'hi' }])
  const t2 = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }, { role: 'user', content: 'again' }]
  b.reset()
  await chat(b, store, t2)
  assert.equal(b.conversationCalls().length, 0)
  b.reset()
  await chat(b, store, t2) // same request again (client retry / regenerate)
  assert.equal(b.conversationCalls().length, 1)
})

test('entries expire after the TTL', async () => {
  let now = 1_000_000
  const store = createSessionStore({ ttlMs: 1000, now: () => now })
  const b = createBackend({ executes: [[ev.text('hello', true)], [ev.text('x', true)]] })
  await chat(b, store, [{ role: 'user', content: 'hi' }])
  now += 1001
  b.reset()
  await chat(b, store, [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }, { role: 'user', content: 'later' }])
  assert.equal(b.conversationCalls().length, 1)
  assert.equal(b.executeCalls()[0].body.isFirstQuery, true)
})

test('LRU keeps at most max entries', () => {
  const store = createSessionStore({ max: 2 })
  store.set('a', 1)
  store.set('b', 2)
  assert.equal(store.has('a'), true) // a stays (has() doesn't reorder; set does)
  store.set('c', 3)
  assert.equal(store.size, 2)
  assert.equal(store.has('a'), false)
  assert.equal(store.take('b'), 2)
  assert.equal(store.has('b'), false)
})

test('reused task failing before any output → transparently retried on a fresh conversation', async () => {
  const b = createBackend({ executes: [[ev.text('hello', true)], [ev.exception('task not found')], [ev.text('recovered', true)]] })
  const store = createSessionStore()
  await chat(b, store, [{ role: 'user', content: 'hi' }])
  b.reset()
  const r = await chat(b, store, [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }, { role: 'user', content: 'go on' }])
  assert.equal(r.res.status, 200)
  assert.equal(r.json.choices[0].message.content, 'recovered')
  const ex = b.executeCalls()
  assert.equal(ex.length, 2)
  assert.equal(ex[0].body.taskId, 222)
  assert.equal(ex[1].body.taskId, 223)
  assert.equal(ex[1].body.isFirstQuery, true)
  assert.match(ex[1].body.query, /<conversation_history>/)
})

test('auth errors on a reused task are not retried', async () => {
  const b = createBackend({ executes: [[ev.text('hello', true)], { httpJson: { code: 401, message: 'nope' } }] })
  const store = createSessionStore()
  await chat(b, store, [{ role: 'user', content: 'hi' }])
  b.reset()
  const r = await chat(b, store, [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }, { role: 'user', content: 'x' }])
  assert.equal(r.res.status, 401)
  assert.equal(b.conversationCalls().length, 0)
})

test('streaming turns are cached after the stream ends and reused', async () => {
  const b = createBackend({ executes: [[ev.text('he'), ev.text('llo', true)], [ev.text('ok', true)]] })
  const store = createSessionStore()
  const r1 = await chat(b, store, [{ role: 'user', content: 'hi' }], { stream: true })
  const text = r1.events.slice(0, -1).map((c) => c.choices?.[0]?.delta?.content ?? '').join('')
  assert.equal(text, 'hello')
  b.reset()
  await chat(b, store, [{ role: 'user', content: 'hi' }, { role: 'assistant', content: text }, { role: 'user', content: 'y' }], { stream: true })
  assert.equal(b.conversationCalls().length, 0)
})

test('a cancelled stream caches nothing', async () => {
  const b = createBackend({ executes: [[ev.text('a'), ev.text('b'), ev.text('c', true)]], chunkSize: 4 })
  const store = createSessionStore()
  const res = await handleChatCompletions({ body: { model: 'auto', stream: true, messages: [{ role: 'user', content: 'hi' }] }, license: LICENSE, fetchImpl: b.fetch, sessions: store })
  const reader = res.body.getReader()
  await reader.read()
  await reader.cancel()
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(store.size, 0)
})

test('without a store every request is fresh; plugin option turns reuse off', async () => {
  const b = createBackend({ executes: [[ev.text('hello', true)], [ev.text('x', true)]] })
  await chat(b, undefined, [{ role: 'user', content: 'hi' }])
  await chat(b, undefined, [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }, { role: 'user', content: 'y' }])
  assert.equal(b.conversationCalls().length, 2)
  assert.equal(_internal.makeSessions({ sessionReuse: false }), undefined)
  assert.ok(_internal.makeSessions({}))
  assert.ok(_internal.makeSessions({ sessionTtlMs: 5, sessionMax: 3 }))
})

test('canonical form and delta builder', () => {
  assert.equal(canonMessage({ role: 'user', content: [{ type: 'text', text: ' a \n b ' }] }), 'user|a b')
  const d = buildDelta([{ role: 'tool', tool_call_id: 'c1', content: 'r' }, { role: 'user', content: 'and?' }], {}, { c1: 'bash' })
  assert.equal(d.query, '<tool_result id="c1" name="bash">\nr\n</tool_result>\n\nand?')
  assert.equal(d.isUserQuery, true)
})

test('the license never appears in cache keys or entries', async () => {
  const store = createSessionStore()
  const seen = []
  const spy = { ...store, set: (k, v) => (seen.push(k, JSON.stringify(v)), store.set(k, v)), has: store.has, take: store.take }
  const b = createBackend({ executes: [[ev.text('hello', true)]] })
  await chat(b, spy, [{ role: 'user', content: 'hi' }])
  assert.equal(seen.length, 2)
  for (const s of seen) assert.doesNotMatch(s, new RegExp(LICENSE))
})
