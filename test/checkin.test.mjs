import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv, randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkin, readDesktopCookies } from '../lib/checkin.mjs'
import { ComateAuthPlugin } from '../index.mjs'

const cookie = 'bce-sessionid=session-secret; bce-user-info=csrf:secret'
const auth = async () => ({ type: 'api', key: 'license-secret' })
const json = (result) => new Response(JSON.stringify({ code: 0, result }))

function mock(responses, options = { checkinCookie: cookie }, desktopCookies = () => []) {
  const calls = []
  return {
    calls,
    run: (getAuth = auth) => checkin(getAuth, {
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

test('already issued: one GET, no claim', async () => {
  const m = mock([{ hasIssued: true, totalTimes: 3 }])
  assert.deepEqual(await m.run(), { outcome: 'done', message: '今日已签到（累计 3 天）' })
  assert.equal(m.calls.length, 1)
  assert.equal(m.calls[0].url, 'https://console.bce.baidu.com/api/dumate/points/loginBonusInfo')
  assert.equal(m.calls[0].headers.Cookie, cookie)
  assert.equal(m.calls[0].redirect, 'manual')
  assert.ok(m.calls[0].signal instanceof AbortSignal)
})

test('claim verifies issuance and calculates actual delta with console POST headers', async () => {
  const m = mock([
    { hasIssued: false, totalPoints: '100' }, {},
    { hasIssued: true, totalPoints: '750', totalTimes: 4 },
  ])
  assert.deepEqual(await m.run(), { outcome: 'claimed', credit: 650, message: '签到成功 +650 积分（累计 4 天）' })
  assert.equal(m.calls.length, 3)
  const post = m.calls[1]
  assert.equal(post.url, 'https://console.bce.baidu.com/api/dumate/points/loginBonus')
  assert.equal(post.method, 'POST')
  assert.equal(post.body, '{}')
  assert.equal(post.headers.Cookie, 'bce-sessionid=session-secret; bce-user-info="csrf:secret"')
  assert.equal(post.headers.csrftoken, 'csrf:secret')
  assert.equal(post.headers.Origin, 'https://console.bce.baidu.com')
  assert.equal(post.headers.Referer, 'https://console.bce.baidu.com/')
  assert.equal(post.headers['X-Requested-With'], 'XMLHttpRequest')
  assert.equal(post.headers['Content-Type'], 'application/json')
  assert.match(post.headers['User-Agent'], /DuMate/)
  assert.equal(post.headers.Accept, 'application/json')
})

test('POST accepted but no issuance is inactive, including failed verification', async () => {
  for (const after of [{ hasIssued: false }, new Error('verification unavailable')]) {
    const m = mock([{ hasIssued: false }, {}, after])
    assert.equal((await m.run()).outcome, 'inactive')
  }
})

test('zero or negative delta does not claim a credit amount', async () => {
  const m = mock([{ totalPoints: 100 }, {}, { hasIssued: true, totalPoints: 90 }])
  const result = await m.run()
  assert.equal(result.outcome, 'claimed')
  assert.equal(result.credit, undefined)
})

test('expired redirects, login HTML and console errors propagate signIn', async () => {
  for (const response of [
    new Response('', { status: 302, headers: { Location: 'https://login.bce.baidu.com/' } }),
    new Response('<!DOCTYPE html><html>login</html>'),
    new Response(JSON.stringify({ code: 1, message: '登录凭证已过期' })),
  ]) {
    const m = mock([response])
    const result = await m.run()
    assert.equal(result.outcome, 'failed')
    assert.equal(result.signIn, 'expired')
    assert.equal(m.calls.length, 1)
  }
})

test('missing cookies and invalid explicit cookie give actionable failure without network', async () => {
  for (const options of [{}, { checkinCookie: 'other=value' }]) {
    const m = mock([], options)
    const result = await m.run()
    assert.equal(result.outcome, 'failed')
    assert.match(result.message, /百度搭子桌面端/)
    assert.match(result.message, /checkinCookie/)
    assert.equal(m.calls.length, 0)
  }
})

test('option cookie is preferred over desktop without reading desktop credentials', async () => {
  const m = mock([{ hasIssued: true }], { checkinCookie: cookie }, () => assert.fail('desktop must not be read'))
  assert.equal((await m.run()).outcome, 'done')
  assert.equal(m.calls[0].headers.Cookie, cookie)
})

test('desktop fallback filters and quotes POST cookies by domain', async () => {
  const m = mock([{ hasIssued: false }, {}, { hasIssued: true }], {}, () => [
    { name: 'bce-sessionid', value: 'desktop', domain: '.baidu.com' },
    { name: 'bce-user-info', value: '"csrf:desktop"', domain: '.bce.baidu.com' },
    { name: 'unrelated', value: 'secret', domain: 'example.com' },
  ])
  assert.equal((await m.run()).outcome, 'claimed')
  assert.equal(m.calls[1].headers.Cookie, 'bce-sessionid=desktop; bce-user-info="csrf:desktop"')
  assert.equal(m.calls[1].headers.csrftoken, 'csrf:desktop')
})

test('errors are sanitized and credentials redacted; auth expiration propagates', async () => {
  const m = mock([{}, new Error('session-secret csrf:secret license-secret\n\u001b failure')])
  const result = await m.run()
  assert.equal(result.outcome, 'failed')
  assert.doesNotMatch(result.message, /session-secret|csrf:secret|license-secret|[\n\u001b]/)
  const expired = await mock([]).run(async () => { throw Object.assign(new Error('expired'), { signIn: 'expired' }) })
  assert.equal(expired.signIn, 'expired')
})

test('non-auth preflight failure still attempts claim; POST HTTP and malformed JSON fail', async () => {
  const successful = mock([new Error('temporary'), {}, { hasIssued: true, totalPoints: 25 }])
  assert.equal((await successful.run()).credit, 25)
  for (const response of [new Response('{}', { status: 500 }), new Response('not json')]) {
    assert.equal((await mock([{}, response]).run()).outcome, 'failed')
  }
})

test('Comate plugin exposes checkin without changing license auth', async () => {
  const hooks = await ComateAuthPlugin({}, { checkinCookie: 'invalid' })
  assert.equal(typeof hooks.auth.checkin, 'function')
  assert.equal((await hooks.auth.checkin(auth)).outcome, 'failed')
  assert.equal(hooks.auth.methods.length, 1)
})

test('desktop cookie decryption and discovery on each OS, override and corrupt data', () => {
  const home = mkdtempSync(join(tmpdir(), 'comate-checkin-'))
  const cookies = [{ name: 'bce-sessionid', value: 'desktop', domain: '.baidu.com' }]
  const cases = [
    { platform: 'darwin', env: {}, dir: join(home, 'Library', 'Application Support', 'qianfan-desktop-app') },
    { platform: 'linux', env: {}, dir: join(home, '.config', 'qianfan-desktop-app') },
    { platform: 'linux', env: { XDG_CONFIG_HOME: join(home, 'xdg') }, dir: join(home, 'xdg', 'qianfan-desktop-app') },
    { platform: 'win32', env: { APPDATA: join(home, 'appdata') }, dir: join(home, 'appdata', 'qianfan-desktop-app') },
    { platform: 'linux', env: { DUMATE_USER_DATA_DIR: join(home, 'override') }, dir: join(home, 'override') },
  ]
  try {
    for (const { dir, ...settings } of cases) {
      assert.deepEqual(readDesktopCookies({ home, ...settings }), [])
      mkdirSync(dir, { recursive: true })
      const key = randomBytes(32)
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const ct = Buffer.concat([cipher.update(JSON.stringify(cookies)), cipher.final()])
      writeFileSync(join(dir, '.cookie-key'), key)
      writeFileSync(join(dir, 'auth.json'), JSON.stringify({ cookies: Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64') }))
      assert.deepEqual(readDesktopCookies({ home, ...settings }), cookies)
      writeFileSync(join(dir, '.cookie-key'), randomBytes(32))
      assert.deepEqual(readDesktopCookies({ home, ...settings }), [])
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
