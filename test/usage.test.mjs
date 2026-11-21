import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dumateUsage } from '../lib/usage.mjs'
import { ComateAuthPlugin } from '../index.mjs'

const cookie = 'BDUSS=fake-bduss; bce-sessionid=fake-session'
const auth = async () => ({ type: 'api', key: 'license-secret' })
const json = (result) => new Response(JSON.stringify({ code: 0, success: true, result }))

const overview = {
  isSubscribed: true,
  usedPoints: '1200.00',
  totalPoints: '26100.00',
  subscription: [{
    packageId: 'p1', usedPoints: '1200.00', totalPoints: '25000.00',
    startDate: 1794556475, expireDate: 1797148475, pointsExpireDate: 1797148475,
    packageType: 'plan_pro', source: 'operation_redeem', status: 'active',
    autoRenewStatus: 'none', nextAutoRenewAt: 0, product: 'dumate',
  }],
  incremental: [{
    packageId: 'g1', usedPoints: '0.00', totalPoints: '300.00',
    startDate: 1795190400, expireDate: 1797782399,
    packageType: 'grant_point', source: 'login_bonus', status: 'active', product: 'dumate',
  }],
}
const info = { bceAccountId: 'acct', displayName: 'Yon_888' }

function mock(responses, options = { checkinCookie: cookie }, desktopCookies = () => []) {
  const calls = []
  return {
    calls,
    run: (getAuth = auth) => dumateUsage(getAuth, {
      options, desktopCookies,
      fetchImpl: async (url, init) => {
        calls.push({ url, ...init })
        assert.ok(responses.length, 'unexpected request')
        const next = responses.shift()
        if (next instanceof Error) throw next
        return next instanceof Response ? next : json(next)
      },
    }),
  }
}

test('quota overview maps to a points window, plan, expiry and account name', async () => {
  const m = mock([overview, info])
  const u = await m.run()
  assert.equal(u.signIn, 'kept')
  assert.equal(u.plan, 'Dumate Pro')
  assert.equal(u.until, new Date(1797148475 * 1000).toISOString())
  assert.equal(u.renew, 'off')
  assert.equal(u.user, 'Yon_888')
  assert.equal(u.error, undefined)
  assert.equal(m.calls.length, 2)
  assert.equal(m.calls[0].url, 'https://dumate.baidu.com/api/dumate/points/quota_overview')
  assert.equal(m.calls[1].url, 'https://dumate.baidu.com/api/dumate/user/info')
  for (const call of m.calls) {
    assert.equal(call.headers.Cookie, cookie)
    assert.equal(call.headers.Referer, 'https://dumate.baidu.com/app')
    assert.equal(call.headers['dumate-version'], '1.0.0')
    assert.equal(call.headers['x-dumate-client-type'], 'web')
    assert.match(call.headers['x-dumate-device-id'], /^1\|web\.[0-9a-f-]{36}$/)
    assert.equal(call.method, undefined)
  }
  assert.equal(m.calls[0].headers['x-dumate-device-id'], m.calls[1].headers['x-dumate-device-id'])
  const w = u.windows[0]
  assert.equal(w.name, '积分')
  assert.equal(w.amount, 1200)
  assert.equal(w.limit, 26100)
  assert.equal(w.unit, '积分')
  assert.ok(Math.abs(w.used - (1200 / 26100) * 100) < 1e-9)
  // the subscription's 23800 remaining points die soonest, at its expiry
  assert.equal(w.runsOutAt, new Date(1797148475 * 1000).toISOString())
  assert.equal(w.runsOut, 23800)
})

test('soonest package expiry wins runsOut and expired packages are ignored', async () => {
  const result = {
    ...overview,
    subscription: [],
    incremental: [
      { totalPoints: '300.00', usedPoints: '0.00', expireDate: 1797782399, packageType: 'grant_point', status: 'active' },
      { totalPoints: '100.00', usedPoints: '40.00', expireDate: 1796000000, pointsExpireDate: 1796000000, packageType: 'grant_point', status: 'active' },
      { totalPoints: '999.00', usedPoints: '0.00', expireDate: 1795000000, packageType: 'grant_point', status: 'expired' },
      { totalPoints: '50.00', usedPoints: '50.00', expireDate: 1794000000, packageType: 'grant_point', status: 'active' },
    ],
  }
  const m = mock([result, {}])
  const w = (await m.run()).windows[0]
  assert.equal(w.runsOutAt, new Date(1796000000 * 1000).toISOString())
  assert.equal(w.runsOut, 60)
  assert.equal(w.limit, 26100)
})

test('user info failure only drops the name; quota still reports', async () => {
  const m = mock([overview, new Error('boom')])
  const u = await m.run()
  assert.equal(u.user, undefined)
  assert.equal(u.plan, 'Dumate Pro')
  assert.equal(u.windows.length, 1)
})

test('session-only cookie uses the console endpoint with plain cookie pairs', async () => {
  const m = mock([overview, {}], { checkinCookie: 'bce-sessionid=fake-session; bce-user-info="csrf:secret"' })
  const u = await m.run()
  assert.equal(u.signIn, 'kept')
  assert.equal(m.calls[0].url, 'https://console.bce.baidu.com/api/dumate/points/quota_overview')
  assert.equal(m.calls[0].headers.Cookie, 'bce-sessionid=fake-session; bce-user-info=csrf:secret')
  assert.equal(m.calls[0].headers.Referer, 'https://console.bce.baidu.com/')
  assert.equal(m.calls[0].headers['dumate-version'], undefined)
})

test('metadata cookie beats desktop jar; jar supplies credentials when nothing is stored', async () => {
  const getAuth = async () => ({ type: 'api', key: 'license-secret', metadata: { checkinCookie: 'bce-sessionid=meta-session' } })
  const m = mock([overview, {}], {}, () => assert.fail('desktop must not be read'))
  assert.equal((await m.run(getAuth)).signIn, 'kept')
  assert.equal(m.calls[0].url, 'https://console.bce.baidu.com/api/dumate/points/quota_overview')

  const jar = mock([overview, {}], {}, () => [
    { name: 'BDUSS', value: 'desk-bduss', domain: '.baidu.com' },
    { name: 'bce-sessionid', value: 'desk-session', domain: '.bce.baidu.com' },
    { name: 'unrelated', value: 'x', domain: 'example.com' },
  ])
  const u = await jar.run(async () => ({ type: 'api', key: 'license-secret' }))
  assert.equal(u.signIn, 'kept')
  // web end keeps only cookies the dumate host would send
  assert.equal(jar.calls[0].headers.Cookie, 'BDUSS=desk-bduss')
  assert.equal(jar.calls[0].url, 'https://dumate.baidu.com/api/dumate/points/quota_overview')
})

test('license-only and cookie-less accounts get an error without network', async () => {
  for (const [getAuth, options] of [
    [auth, {}],
    [async () => ({ type: 'api', key: 'license-secret' }), { checkinCookie: 'other=value' }],
  ]) {
    const m = mock([], options)
    const u = await m.run(getAuth)
    assert.match(u.error, /百度搭子登录态/)
    assert.equal(u.signIn, undefined)
    assert.equal(m.calls.length, 0)
  }
})

test('empty points report a zero balance window', async () => {
  const m = mock([{ isSubscribed: false, usedPoints: '0.00', totalPoints: '0.00', subscription: [], incremental: [] }, {}])
  const u = await m.run()
  assert.equal(u.plan, undefined)
  assert.equal(u.until, undefined)
  assert.equal(u.signIn, 'kept')
  assert.deepEqual(u.windows, [{ name: '积分', balance: 0, unit: '积分' }])
})

test('expired login propagates signIn through redirects, HTML and API codes', async () => {
  for (const response of [
    new Response('', { status: 302, headers: { Location: 'https://login.bce.baidu.com/' } }),
    new Response('<!DOCTYPE html><html>login</html>'),
    new Response(JSON.stringify({ code: 10001, message: '登录已经过期' })),
    new Response(JSON.stringify({ success: false, message: { global: '登录凭证已过期，请重新登录' } })),
    new Response('{}', { status: 401 }),
  ]) {
    const m = mock([response, {}])
    const u = await m.run()
    assert.equal(u.signIn, 'expired')
    assert.ok(u.error)
    assert.equal(m.calls.length, 2)
  }
})

test('HTTP and envelope errors become sanitized error strings', async () => {
  const envelope = (payload) => new Response(JSON.stringify(payload))
  for (const response of [
    new Response('{}', { status: 500 }),
    new Response('not json'),
    envelope({ code: 1, message: '系统繁忙' }),
    envelope({ success: false, message: '积分接口维护中' }),
  ]) {
    const m = mock([response])
    const u = await m.run()
    assert.ok(u.error)
    assert.equal(u.signIn, undefined)
    assert.equal(u.windows, undefined)
  }
  const busy = await mock([envelope({ code: 7, message: '积分服务暂不可用' })]).run()
  assert.match(busy.error, /积分服务暂不可用/)
})

test('fetch failures and secrets are redacted from the error', async () => {
  const m = mock([new Error('fake-bduss fake-session license-secret\n failure')])
  const u = await m.run()
  assert.ok(u.error)
  assert.doesNotMatch(u.error, /fake-bduss|fake-session|license-secret|\n/)
  const denied = await mock([]).run(async () => { throw Object.assign(new Error('denied'), { signIn: 'expired' }) })
  assert.equal(denied.signIn, 'expired')
})

test('Comate plugin exposes usage beside checkin and methods stay four', async () => {
  const hooks = await ComateAuthPlugin({}, { checkinCookie: cookie, fetchImpl: async (url) => {
    if (url.includes('quota_overview')) return json(overview)
    if (url.includes('user/info')) return json(info)
    throw new Error('unexpected ' + url)
  } })
  assert.equal(typeof hooks.auth.usage, 'function')
  assert.equal(hooks.auth.methods.length, 4)
  const u = await hooks.auth.usage(auth, {}, {})
  assert.equal(u.signIn, 'kept')
  assert.equal(u.plan, 'Dumate Pro')
  assert.equal(u.windows[0].limit, 26100)
})
