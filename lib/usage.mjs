import { randomUUID } from 'node:crypto'
import { matches, messageText, readDesktopCookies, resolveCheckinCookies } from './checkin.mjs'
import { redact } from './comate.mjs'

const WEB = 'https://dumate.baidu.com'
const BASE = 'https://console.bce.baidu.com'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) DuMate/1.0.82 Chrome/130.0.0.0 Electron/33.0.0 Safari/537.36'

const num = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(v)
  return Number.isFinite(n) ? n : 0
}

const PLAN_NAMES = { plan_pro: 'Dumate Pro', plan_max: 'Dumate Max', plan_ultra: 'Dumate Ultra' }

function planName(pkg) {
  const type = String(pkg?.packageType || '').trim()
  if (!type) return ''
  if (PLAN_NAMES[type]) return PLAN_NAMES[type]
  const words = type.replace(/^plan_/, '').split('_').filter(Boolean)
  return words.length ? 'Dumate ' + words.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ') : type
}

function expired() {
  return Object.assign(new Error('百度搭子登录态已失效，积分查询不可用；请重新登录百度搭子或更新 checkinCookie'), { signIn: 'expired' })
}

/**
 * The account's Dumate points as magpie's auth.usage reports them: one
 * 「积分」 window counting used of total, the soonest package expiry as
 * runsOut, and the subscription as plan/until. Needs the Dumate web login
 * (BDUSS) or the console session (bce-sessionid); a license-only account
 * has no points to show.
 */
export async function dumateUsage(getAuth, { options = {}, fetchImpl, desktopCookies = readDesktopCookies, signal } = {}) {
  let auth
  let raw = ''
  let cookies = []
  const clean = (value) => {
    let text = redact(typeof value === 'number' ? String(value) : messageText(value), auth?.key)
    for (const c of cookies) {
      text = redact(text, String(c.value ?? ''))
      text = redact(text, String(c.value ?? '').replace(/^["']+|["']+$/g, ''))
    }
    if (raw) text = redact(text, raw)
    return Array.from(text.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, ' ').trim()).slice(0, 200).join('')
  }
  try {
    auth = await getAuth()
    ;({ raw, cookies } = await resolveCheckinCookies(auth, options, desktopCookies))
    const has = (name, host) => cookies.some((c) => c.name === name && String(c.value ?? '').replace(/^["']+|["']+$/g, '').trim() && matches(c, host))
    const isWeb = has('BDUSS', 'dumate.baidu.com')
    const isConsole = has('bce-sessionid', 'console.bce.baidu.com')
    if (!isWeb && !isConsole) {
      return { error: '积分查询需要百度搭子登录态：请改用「百度 Cookie」或「本地获取」方式登录，或设置含 BDUSS 的 checkinCookie' }
    }
    const base = isWeb ? WEB : BASE
    const f = fetchImpl ?? ((...args) => globalThis.fetch(...args))
    const deviceId = `1|web.${randomUUID()}`
    const header = () => {
      if (isWeb && raw) return raw
      const jar = isWeb ? cookies.filter((c) => matches(c, 'dumate.baidu.com')) : cookies
      return jar.map((c) => {
        if (!isWeb) return `${c.name}=${c.value}`
        let v = String(c.value).replace(/^["']+|["']+$/g, '')
        if (/[:|;=\s]/.test(v)) v = `"${v}"`
        return `${c.name}=${v}`
      }).join('; ') 
    }
    const get = async (path) => {
      const res = await f(base + path, {
        headers: {
          Cookie: header(), 'User-Agent': UA, Accept: 'application/json', Referer: base + (isWeb ? '/app' : '/'),
          ...(isWeb ? { 'Content-Type': 'application/json', Origin: base, 'dumate-version': '1.0.0', 'x-dumate-client-type': 'web', 'x-dumate-device-id': deviceId } : {}),
        },
        redirect: 'manual',
        signal: signal ?? AbortSignal.timeout(20_000),
      })
      if (res.status >= 300 && res.status < 400 || res.status === 401 || res.status === 403) throw expired()
      const text = await res.text()
      let payload
      try { payload = JSON.parse(text) } catch {}
      if (!payload || typeof payload !== 'object') {
        if (/登录|login|<!DOCTYPE|<html/i.test(text.slice(0, 500))) throw expired()
        throw new Error(`积分接口 HTTP ${res.status} 非 JSON 响应`)
      }
      const detail = messageText(payload.message)
      if (/登录|login|expired|过期|失效/i.test(detail)) throw expired()
      if (!res.ok) throw new Error(`积分接口 HTTP ${res.status}${detail ? ': ' + clean(detail) : ''}`)
      if (payload.code !== 0 || payload.success === false) {
        throw new Error(`积分接口错误: ${clean(detail) || clean(payload.code) || '未知错误'}`)
      }
      return payload.result
    }
    const [quota, info] = await Promise.all([
      get('/api/dumate/points/quota_overview'),
      get('/api/dumate/user/info').catch(() => null),
    ])
    const r = quota && typeof quota === 'object' ? quota : {}
    const subs = (Array.isArray(r.subscription) ? r.subscription : []).filter((p) => p && typeof p === 'object')
    const packs = [...subs, ...(Array.isArray(r.incremental) ? r.incremental : [])]
      .filter((p) => p && typeof p === 'object' && String(p.status || 'active') === 'active')
    const sub = subs.find((p) => String(p.status || 'active') === 'active')
    const total = num(r.totalPoints)
    const used = num(r.usedPoints)
    const windows = []
    if (total > 0) {
      const w = {
        name: '积分',
        amount: used,
        limit: total,
        unit: '积分',
        used: used / total * 100,
      }
      // grants and the plan each die on their own date; the soonest one's
      // remaining points are what runsOut reports as lost
      const dated = packs
        .map((p) => ({ at: num(p.pointsExpireDate) || num(p.expireDate), left: num(p.totalPoints) - num(p.usedPoints) }))
        .filter((p) => p.at > 0 && p.left > 0)
      if (dated.length) {
        const at = Math.min(...dated.map((p) => p.at))
        w.runsOutAt = new Date(at * 1000).toISOString()
        w.runsOut = dated.filter((p) => p.at === at).reduce((sum, p) => sum + p.left, 0)
      }
      windows.push(w)
    } else {
      windows.push({ name: '积分', balance: 0, unit: '积分' })
    }
    const name = planName(sub)
    const until = num(sub?.expireDate)
    const displayName = typeof info?.displayName === 'string' ? info.displayName.trim() : ''
    const renew = sub?.autoRenewStatus === 'auto' ? 'auto' : sub?.autoRenewStatus === 'none' ? 'off' : ''
    return {
      ...(name ? { plan: name } : {}),
      ...(until > 0 ? { until: new Date(until * 1000).toISOString() } : {}),
      ...(renew ? { renew } : {}),
      ...(displayName ? { user: displayName } : {}),
      signIn: 'kept',
      windows,
    }
  } catch (e) {
    return {
      error: clean(e?.message) || '积分查询失败',
      ...(e?.signIn === 'expired' ? { signIn: 'expired' } : {}),
    }
  }
}
