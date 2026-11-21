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
  assert.equal(hooks.auth.methods.length, 3)
  const m = hooks.auth.methods[1]
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
  assert.equal((await hooks.auth.methods[1].authorize()).url, 'https://comate.example.com/user')
  const odd = await mod.ComateAuthPlugin({}, { licenseUrl: 'javascript:alert(1)' })
  assert.equal((await odd.auth.methods[1].authorize()).url, mod.LICENSE_PAGE)
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

test('default Cookie sign-in opens Dumate before asking for the Cookie, with safe URL override', async () => {
  for (const [cookieUrl, expected] of [
    [undefined, 'https://dumate.baidu.com'],
    [' https://dumate.example.com/login ', 'https://dumate.example.com/login'],
    ['javascript:alert(1)', 'https://dumate.baidu.com'],
    ['', 'https://dumate.baidu.com'],
  ]) {
    const hooks = await mod.ComateAuthPlugin({}, { cookieUrl, fetchImpl: () => assert.fail('opening the page needs no API call') })
    const method = hooks.auth.methods[0]
    assert.equal(method.type, 'oauth')
    assert.equal(method.prompts, undefined)
    const step = await method.authorize()
    assert.equal(step.url, expected)
    assert.equal(step.method, 'code')
    assert.ok(step.instructions.includes(expected))
    assert.match(step.instructions, /登录.*DevTools → Network.*Request Headers.*Cookie/)
    assert.match(step.instructions, /httpOnly/)
    assert.equal(typeof step.callback, 'function')
  }
})

test('third method is a masked Cookie/license form with Chinese method labels', async () => {
  const calls = []
  const ctl = new AbortController()
  const hooks = await mod.ComateAuthPlugin({}, { fetchImpl: async (url, init) => {
    calls.push({ url, ...init })
    return Response.json(url.endsWith('/api/user') ? { status: 'OK', data: { license: LICENSE } } : { data: true })
  } })
  assert.deepEqual(hooks.auth.methods.map((method) => method.label), [
    '百度 Cookie（打开百度搭子复制）',
    'Comate license（从个人中心复制）',
    '百度 Cookie / license（密码表单，不打开网页）',
  ])
  const form = hooks.auth.methods[2]
  assert.equal(form.type, 'api')
  assert.deepEqual(form.prompts.map((prompt) => [prompt.key, prompt.type]), [['cookie', 'password'], ['license', 'password']])
  assert.equal(calls.length, 0)
  const cookie = 'BDUSS=fake-passport; bce-sessionid=fake-session'
  const expected = { type: 'success', key: LICENSE, metadata: { checkinCookie: cookie } }
  assert.deepEqual(await form.authorize({ cookie, license: LICENSE }, { signal: ctl.signal }), expected)
  assert.equal(calls.length, 1)
  assert.ok(calls[0].url.includes('/api/key/valid/'))
  assert.equal(calls[0].signal, ctl.signal)
  assert.deepEqual(await form.authorize({ cookie, license: ' ' }, { signal: ctl.signal }), expected)
  assert.equal(calls.length, 3)
  assert.ok(calls[1].url.endsWith('/api/user'))
  assert.equal(calls[1].signal, ctl.signal)
  assert.deepEqual(await form.authorize({ license: LICENSE, cookie: ' ' }), { type: 'success', key: LICENSE })
  assert.equal(calls.length, 4)
  assert.deepEqual(await form.authorize({ license: LICENSE, cookie: 'BDUSS=fake-passport' }), { type: 'success', key: LICENSE })
})

test('masked form rejects empty inputs and returns credential-safe errors', async () => {
  const hooks = await mod.ComateAuthPlugin({}, { fetchImpl: async () => { throw new Error(`${LICENSE} fake-passport fake-session`) } })
  const form = hooks.auth.methods[2]
  for (const inputs of [undefined, {}, { cookie: ' ', license: ' ' }]) {
    const result = await form.authorize(inputs)
    assert.equal(result.type, 'failed')
    assert.match(result.error, /至少填写/)
  }
  for (const inputs of [
    { cookie: 'BDUSS=fake-passport; bce-sessionid=fake-session' },
    { cookie: 'BDUSS=fake-passport; bce-sessionid=fake-session', license: LICENSE },
  ]) {
    const result = await form.authorize(inputs)
    assert.equal(result.type, 'failed')
    assert.ok(!result.error.includes(LICENSE))
    assert.doesNotMatch(result.error, /fake-passport|fake-session/)
    assert.equal(result.metadata, undefined)
  }
})

test('Cookie sign-in requires a nonempty Cookie containing BDUSS', async () => {
  const hooks = await mod.ComateAuthPlugin({}, { fetchImpl: () => assert.fail('no request expected') })
  const step = await hooks.auth.methods[0].authorize()
  for (const cookie of ['other=fake', 'bce-sessionid=fake-session', 'BDUSS=', 'BDUSS=""', 'other=BDUSS=fake']) {
    const result = await step.callback(cookie)
    assert.equal(result.type, 'failed')
    assert.match(result.error, /BDUSS/)
    assert.doesNotMatch(result.error, /fake-passport/)
  }
  assert.equal((await step.callback()).type, 'failed')
  assert.equal((await step.callback(' ')).type, 'failed')
})

test('cookie-only sign-in retrieves and validates license, storing the full check-in Cookie', async () => {
  const cookie = 'BDUSS="fake-passport"; BAIDUID=fake-id; bce-sessionid=fake-session'
  const calls = []
  const ctl = new AbortController()
  const hooks = await mod.ComateAuthPlugin({}, {
    host: 'https://comate.example.com/api/',
    fetchImpl: async (url, init) => {
      calls.push({ url, ...init })
      return Response.json(calls.length === 1 ? { status: 'OK', data: { license: ` ${LICENSE} ` } } : { data: true })
    },
  })
  const step = await hooks.auth.methods[0].authorize()
  assert.deepEqual(await step.callback(` ${cookie} `, { signal: ctl.signal }), {
    type: 'success', key: LICENSE, metadata: { checkinCookie: cookie },
  })
  assert.deepEqual(calls.map((c) => c.url), ['https://comate.example.com/api/user', `https://comate.example.com/api/key/valid/${LICENSE}`])
  assert.deepEqual(calls[0].headers, {
    Cookie: cookie, Accept: 'application/json', 'Content-Type': 'application/json', Referer: 'https://comate.example.com/zh/user',
  })
  assert.equal(calls[0].signal, ctl.signal)
  assert.equal(calls[1].signal, ctl.signal)
  assert.equal(calls[0].redirect, 'manual')
  assert.equal(calls[1].headers.Cookie, undefined)
})

test('Cookie without a session signs in without persisting passport credentials', async () => {
  const calls = []
  const hooks = await mod.ComateAuthPlugin({}, { fetchImpl: async (url, init) => {
    calls.push({ url, ...init })
    return Response.json(url.endsWith('/api/user') ? { status: 'OK', data: { license: LICENSE } } : { data: true })
  } })
  const step = await hooks.auth.methods[0].authorize()
  const result = await step.callback('BDUSS=fake-passport; bce-sessionid=""')
  assert.deepEqual(result, { type: 'success', key: LICENSE })
  assert.equal(calls.length, 2)
  assert.equal(calls[0].url, 'https://comate.baidu.com/api/user')
  assert.ok(calls[0].signal instanceof AbortSignal)
})

test('user API failures have one generic Chinese error and never validate or persist credentials', async () => {
  for (const response of [
    Response.json({ status: 'UNAUTHORIZED', message: 'fake-passport' }),
    Response.json({ status: 'OK', data: {} }),
    Response.json({ status: 'OK', data: { license: ' ' } }),
    Response.json({ status: 'OK', data: { license: 123 } }),
    Response.json({ status: 'OK', data: { license: LICENSE } }, { status: 403 }),
    new Response('fake-passport invalid json'),
    new Error('fake-passport fake-session'),
  ]) {
    let calls = 0
    const hooks = await mod.ComateAuthPlugin({}, { fetchImpl: async () => {
      calls++
      if (response instanceof Error) throw response
      return response
    } })
    const step = await hooks.auth.methods[0].authorize()
    const result = await step.callback('BDUSS=fake-passport; bce-sessionid=fake-session')
    assert.deepEqual(result, { type: 'failed', error: '无法通过百度 Cookie 获取 Comate license，请更新 Cookie 或手动填写 license' })
    assert.equal(calls, 1)
  }
})

test('Cookie sign-in refuses invalid retrieved license and redacts validation failures', async () => {
  const cookie = 'BDUSS=fake-passport; bce-sessionid=fake-session; bce-user-info="fake-csrf"'
  for (const fail of [false, true]) {
    const fetchImpl = async (url) => {
      if (url.endsWith('/api/user')) return Response.json({ status: 'OK', data: { license: LICENSE } })
      if (fail) throw new Error(`${LICENSE} ${cookie} fake-session fake-csrf`)
      return Response.json({ data: false })
    }
    const hooks = await mod.ComateAuthPlugin({}, { fetchImpl })
    const step = await hooks.auth.methods[0].authorize()
    const result = await step.callback(cookie)
    assert.equal(result.type, 'failed')
    assert.equal(result.metadata, undefined)
    assert.ok(!result.error.includes(LICENSE))
    assert.doesNotMatch(result.error, /fake-session|fake-csrf/)
  }
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
