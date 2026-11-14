import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createProxyServer } from '../bin/serve.mjs'
import { createBackend, ev, LICENSE, readSSE } from './mock.mjs'

test('standalone proxy: token check, /v1/models, streaming chat', async () => {
  const b = createBackend({ executes: [[ev.text('hello', true)]] })
  const srv = createProxyServer({ license: LICENSE, token: 'tok', fetchImpl: b.fetch })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${srv.address().port}/v1`
  try {
    assert.equal((await fetch(`${base}/models`)).status, 401)
    const auth = { authorization: 'Bearer tok' }
    const models = await (await fetch(`${base}/models`, { headers: auth })).json()
    assert.ok(models.data.some((m) => m.id === 'glm-5.3'))
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'auto', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(res.status, 200)
    const events = await readSSE(res)
    assert.equal(events.slice(0, -1).map((c) => c.choices[0]?.delta?.content ?? '').join(''), 'hello')
  } finally {
    srv.close()
  }
})

test('standalone proxy reuses the Comate conversation across turns', async () => {
  const { createSessionStore } = await import('../lib/sessions.mjs')
  const b = createBackend({ executes: [[ev.text('hello', true)], [ev.text('again', true)]] })
  const srv = createProxyServer({ license: LICENSE, fetchImpl: b.fetch, sessions: createSessionStore() })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${srv.address().port}/v1/chat/completions`
  const post = (messages) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'auto', messages }) }).then((r) => r.json())
  try {
    await post([{ role: 'user', content: 'hi' }])
    const j = await post([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }, { role: 'user', content: 'more' }])
    assert.equal(j.choices[0].message.content, 'again')
    assert.equal(b.conversationCalls().length, 1)
    assert.equal(b.executeCalls()[1].body.query, 'more')
  } finally {
    srv.close()
  }
})
