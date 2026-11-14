import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import * as mod from '../index.mjs'
import { createBackend, ev, LICENSE } from './mock.mjs'

let realFetch
let backend
beforeEach(() => {
  realFetch = globalThis.fetch
  mod._internal.modelCache.clear()
})
afterEach(() => {
  globalThis.fetch = realFetch
})
function useBackend(o) {
  backend = createBackend(o)
  globalThis.fetch = backend.fetch
  return backend
}

test('module exports only the plugin function (+ _internal object)', () => {
  const fns = Object.entries(mod).filter(([, v]) => typeof v === 'function').map(([k]) => k)
  assert.deepEqual(fns, ['ComateAuthPlugin'])
})

test('config hook declares the provider without overwriting user config', async () => {
  const hooks = await mod.ComateAuthPlugin({}, undefined)
  const cfg = {}
  await hooks.config(cfg)
  assert.equal(cfg.provider.comate.npm, '@ai-sdk/openai-compatible')
  assert.deepEqual(cfg.provider.comate.models, {}, 'no model ids are made up before sign-in')
  const mine = { provider: { comate: { name: 'mine' } } }
  await hooks.config(mine)
  assert.equal(mine.provider.comate.name, 'mine')
})

test('sign-in opens the Comate license page, then takes and checks the pasted license', async () => {
  const be = useBackend()
  const hooks = await mod.ComateAuthPlugin({}, undefined)
  assert.equal(hooks.auth.methods.length, 1, 'one method: magpie starts it on a single click, no chooser')
  const m = hooks.auth.methods[0]
  assert.equal(m.type, 'oauth')
  assert.ok(m.labels.zh)
  assert.equal(m.prompts, undefined, 'nothing asked before the page opens')
  const step = await m.authorize(undefined)
  assert.equal(step.url, 'https://comate.baidu.com/zh/user')
  assert.equal(mod.LICENSE_PAGE, step.url)
  assert.equal(step.method, 'code')
  assert.match(step.instructions, /comate\.baidu\.com\/zh\/user/, 'the link is in the text too, for when no browser opens')
  assert.deepEqual(await step.callback(` ${LICENSE} \n`), { type: 'success', key: LICENSE })
  assert.ok(be.calls.some((c) => c.path.startsWith('/api/key/valid/')))
  const bad = await step.callback('nope')
  assert.equal(bad.type, 'failed')
  assert.ok(!bad.error.includes('nope'))
  assert.equal((await step.callback('')).type, 'failed')
  assert.equal((await step.callback(undefined)).type, 'failed')
})

test('sign-in: licenseUrl option, network error is redacted, signal is passed on', async () => {
  const hooks = await mod.ComateAuthPlugin({}, { licenseUrl: 'https://comate.example.com/user' })
  assert.equal((await hooks.auth.methods[0].authorize()).url, 'https://comate.example.com/user')
  const odd = await mod.ComateAuthPlugin({}, { licenseUrl: 'javascript:alert(1)' })
  assert.equal((await odd.auth.methods[0].authorize()).url, mod.LICENSE_PAGE)
  let seen
  globalThis.fetch = async (url, init) => {
    seen = init?.signal
    throw new Error(`connect failed for ${url}`)
  }
  const ctl = new AbortController()
  const r = await mod._internal.checkLicense(LICENSE, {}, ctl.signal)
  assert.equal(r.type, 'failed')
  assert.ok(!r.error.includes(LICENSE), r.error)
  assert.ok(seen, 'fetch got a signal')
})

test('provider.models lists the account models; a refused license marks the sign-in', async () => {
  useBackend()
  const hooks = await mod.ComateAuthPlugin({}, undefined)
  const cfg = {}
  await hooks.config(cfg)
  const models = await hooks.provider.models(cfg.provider.comate, { auth: { type: 'api', key: LICENSE } })
  assert.deepEqual(Object.keys(models), ['glm-5.3_00000000000000000000000000000000', 'deepseek-v4-flash_11111111111111111111111111111111', 'kimi-k2.6-oneapi_22222222222222222222222222222222'])
  const glm = models['glm-5.3_00000000000000000000000000000000']
  assert.equal(glm.name, 'GLM-5.3')
  assert.equal(glm.reasoning, true)
  assert.equal(glm.limit.context, 1000000)
  assert.equal(glm.limit.output, 32000)
  assert.equal(glm.variants, undefined, 'no effortConfig / thinkingConfig → no variants')
  assert.equal(glm.rate, 1)
  assert.equal(glm.temperature, false)
  assert.equal(models['deepseek-v4-flash_11111111111111111111111111111111'].limit.context, 1024000)
  assert.equal(models['deepseek-v4-flash_11111111111111111111111111111111'].rate, 0.3)
  assert.equal(models['kimi-k2.6-oneapi_22222222222222222222222222222222'].limit.context, 256000)
  useBackend({ badLicense: true })
  await assert.rejects(hooks.provider.models(cfg.provider.comate, { auth: { type: 'api', key: LICENSE } }), (e) => e.signIn === 'expired')
  // not signed in → the declared list
  assert.equal(await hooks.provider.models(cfg.provider.comate, {}), cfg.provider.comate.models)
})

test('loader fetch passes X-Magpie-Effort; model ids are matched exactly', async () => {
  const { CONFIGURED } = await import('./mock.mjs')
  const L = CONFIGURED[0].modelId
  const send = async (model) => {
    const be = useBackend({ executes: [[ev.text('pong', true)]], models: CONFIGURED })
    mod._internal.modelCache.clear()
    const hooks = await mod.ComateAuthPlugin({}, undefined)
    const l = await hooks.auth.loader(async () => ({ type: 'api', key: LICENSE }))
    const res = await l.fetch(`${l.baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-magpie-effort': 'xhigh' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
    })
    await res.text()
    return be.calls.find((c) => c.path.endsWith('/v2/execute')).body
  }
  let ex = await send(L)
  assert.equal(ex.effort, 'max')
  assert.equal(ex.modelKey, L)
  // a shortened id is not aliased to the listed one: sent as-is, no thinking fields
  ex = await send('x-levels')
  assert.equal(ex.modelKey, 'x-levels')
  assert.equal('effort' in ex, false)
})

test('loader fetch answers chat/completions through Comate', async () => {
  useBackend({ executes: [[ev.text('pong', true)]] })
  const hooks = await mod.ComateAuthPlugin({}, { host: 'https://comate.baidu.com/' })
  const l = await hooks.auth.loader(async () => ({ type: 'api', key: LICENSE }))
  assert.equal(l.baseURL, mod._internal.BASE)
  const res = await l.fetch(`${l.baseURL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer comate-license-in-plugin' },
    body: JSON.stringify({ model: 'glm-5.3_00000000000000000000000000000000', messages: [{ role: 'user', content: 'ping' }] }),
  })
  assert.equal(res.status, 200)
  assert.equal((await res.json()).choices[0].message.content, 'pong')
  assert.ok(backend.calls.every((c) => c.path.startsWith('/api/')))
  const other = await l.fetch(`${l.baseURL}/responses`, { method: 'POST', body: '{}' })
  assert.equal(other.status, 404)
  assert.deepEqual(await hooks.auth.loader(async () => undefined), {})
})
