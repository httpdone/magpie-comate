import { createDecipheriv, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { redact } from './comate.mjs'

const BASE = 'https://console.bce.baidu.com'
const HOST = 'console.bce.baidu.com'
const WEB = 'https://dumate.baidu.com'
const INFO = '/api/dumate/points/loginBonusInfo'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) DuMate/1.0.82 Chrome/130.0.0.0 Electron/33.0.0 Safari/537.36'

export function readDesktopCookies({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  const dir = String(env.DUMATE_USER_DATA_DIR ?? '').trim() || (platform === 'darwin'
    ? join(home, 'Library', 'Application Support', 'qianfan-desktop-app')
    : platform === 'linux'
      ? join(env.XDG_CONFIG_HOME || join(home, '.config'), 'qianfan-desktop-app')
      : join(env.APPDATA || '', 'qianfan-desktop-app'))
  try {
    const auth = JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf8'))
    const key = readFileSync(join(dir, '.cookie-key'))
    if (key.length !== 32 || typeof auth?.cookies !== 'string') return []
    const buf = Buffer.from(auth.cookies, 'base64')
    const decipher = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12))
    decipher.setAuthTag(buf.subarray(12, 28))
    const cookies = JSON.parse(Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8'))
    return Array.isArray(cookies) ? cookies : []
  } catch {
    return []
  }
}

function parseCookies(raw) {
  return raw.split(/;\s*/).flatMap((part) => {
    const i = part.indexOf('=')
    if (i <= 0) return []
    return [{ name: part.slice(0, i).trim(), value: part.slice(i + 1).trim().replace(/^["']|["']$/g, ''), domain: '.baidu.com' }]
  })
}

export function matches(cookie, host = HOST) {
  if (!cookie.domain) return true
  const domain = cookie.domain.replace(/^\./, '')
  return host === domain || host.endsWith('.' + domain)
}

export function messageText(value) {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    if (typeof value.global === 'string') return value.global
    return Object.values(value).find((item) => typeof item === 'string') || ''
  }
  return ''
}

function expired() {
  return Object.assign(new Error('百度搭子登录态已失效，请重新登录百度搭子或更新 checkinCookie'), { signIn: 'expired' })
}

/**
 * The check-in credential in priority order: the plugin option, then the
 * account's metadata cookie, then the Dumate desktop app's jar. Returns the
 * raw pasted string (sent verbatim to the web end) and the parsed jar.
 */
export async function resolveCheckinCookies(auth, options = {}, desktopCookies = readDesktopCookies) {
  let raw = typeof options.checkinCookie === 'string' ? options.checkinCookie.trim() : ''
  if (!raw && typeof auth?.metadata?.checkinCookie === 'string') raw = auth.metadata.checkinCookie.trim()
  const cookies = (raw ? parseCookies(raw) : await desktopCookies() ?? [])
    .filter((c) => c && typeof c.name === 'string' && typeof c.value === 'string' && (c.domain == null || typeof c.domain === 'string'))
  return { raw, cookies }
}

export async function checkin(getAuth, { options = {}, fetchImpl, desktopCookies = readDesktopCookies } = {}) {
  let cookies = []
  let auth
  let raw = ''
  const message = (value) => {
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
    const valueOf = (name, host) => cookies.find((c) => c.name === name && c.value.replace(/^["']+|["']+$/g, '').trim() && matches(c, host))
    const web = Boolean(valueOf('BDUSS', 'dumate.baidu.com'))
    const session = valueOf('bce-sessionid', HOST)
    let csrf = valueOf('bce-user-info', HOST)
    if (!web && !session) {
      return { outcome: 'failed', message: '请先登录百度搭子桌面端，或在登录表单填写签到 Cookie，也可设置含 bce-sessionid 的 checkinCookie 选项以启用每日签到' }
    }
    const f = fetchImpl ?? ((...args) => globalThis.fetch(...args))
    const deviceId = `1|web.${randomUUID()}`
    if (session && !csrf) {
      // Console pages don't always set bce-user-info; the csrftoken is just the BCE account id,
      // which a valid session already exposes via /api/dumate/user/info — mint it for the PC claim.
      try {
        const info = await request(BASE, '/api/dumate/user/info')
        const accountId = typeof info?.bceAccountId === 'string' ? info.bceAccountId.trim() : ''
        if (accountId) {
          csrf = { name: 'bce-user-info', value: accountId, domain: '.bce.baidu.com' }
          cookies.push(csrf)
        }
      } catch {}
    }
    const ends = [...(web ? [{ label: '网页端', base: WEB }] : []), ...(session && csrf ? [{ label: 'PC 端', base: BASE }] : [])]
    if (!ends.length) return { outcome: 'inactive', message: '当前 Cookie 缺少网页端 BDUSS 与 PC 端 CSRF，暂不签到；请更新 Cookie 或登录百度搭子桌面端' }
    async function request(base, path, post = false) {
      const isWeb = base === WEB
      const header = isWeb && raw ? raw : (isWeb || post ? cookies.filter((c) => matches(c, new URL(base).hostname)) : cookies).map((c) => {
        if (!post && !isWeb) return `${c.name}=${c.value}`
        let value = c.value.replace(/^["']+|["']+$/g, '')
        if (/[:|;=\s]/.test(value)) value = `"${value}"`
        return `${c.name}=${value}`
      }).join('; ')
      const res = await f(base + path, {
        ...(post ? { method: 'POST', body: '{}' } : {}),
        headers: {
          Cookie: header, 'User-Agent': UA, Accept: 'application/json', Referer: base + (isWeb ? '/app' : '/'),
          ...(isWeb ? { 'Content-Type': 'application/json', Origin: base, 'dumate-version': '1.0.0', 'x-dumate-client-type': 'web', 'x-dumate-device-id': deviceId } : {}),
          ...(post && !isWeb ? { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', Origin: base, csrftoken: csrf.value.replace(/^["']+|["']+$/g, '') } : {}),
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(20_000),
      })
      if (res.status >= 300 && res.status < 400) throw expired()
      const text = await res.text()
      let payload
      try { payload = JSON.parse(text) } catch {}
      if (!payload || typeof payload !== 'object') {
        if (/登录|login|<!DOCTYPE|<html/i.test(text.slice(0, 500))) throw expired()
        throw new Error(`签到接口 HTTP ${res.status} 非 JSON 响应`)
      }
      const detail = messageText(payload.message)
      if (/登录凭证|重新登录|login/i.test(detail)) throw expired()
      if (!res.ok) throw new Error(`签到接口 HTTP ${res.status}${detail ? ': ' + message(detail) : ''}`)
      if (payload.code !== 0 || payload.success === false) {
        throw new Error(`签到接口错误: ${message(detail) || message(payload.code) || '未知错误'}`)
      }
      return payload.result
    }
    async function claim(base) {
      const deadline = Date.now() + 25_000
      let before
      try { before = await request(base, INFO) } catch (e) {
        if (e?.signIn === 'expired') throw e
      }
      if (before?.hasIssued === true) return { outcome: 'done', message: `今日已签到（累计 ${message(before.totalTimes) || '?'} 天）` }
      if (Date.now() >= deadline) return { outcome: 'failed', message: '签到超时，稍后自动重试' }
      const beforePoints = parseFloat(before?.totalPoints ?? '0') || 0
      await request(base, '/api/dumate/points/loginBonus', true)
      let after
      try { after = await request(base, INFO) } catch {}
      if (after?.hasIssued === true) {
        const delta = Math.max(0, Math.round((parseFloat(after.totalPoints ?? '0') || 0) - beforePoints))
        return { outcome: 'claimed', ...(delta ? { credit: delta } : {}), message: `签到成功${delta ? ` +${delta} 积分` : ''}（累计 ${message(after.totalTimes) || '?'} 天）` }
      }
      return { outcome: 'inactive', message: '签到请求已提交，但今日积分尚未到账（可能延迟，稍后自动重试）' }
    }
    const results = []
    for (const end of ends) {
      try { results.push({ ...end, ...await claim(end.base) }) } catch (e) {
        results.push({ ...end, outcome: 'failed', message: message(e?.message) || '签到失败', ...(e?.signIn === 'expired' ? { signIn: 'expired' } : {}) })
      }
    }
    if (results.length === 1 && results[0].base === BASE) {
      const { base, label, ...result } = results[0]
      return result
    }
    const outcome = results.some((r) => r.outcome === 'claimed') ? 'claimed'
      : results.every((r) => r.outcome === 'done') ? 'done'
        : results.every((r) => r.outcome === 'failed') ? 'failed' : 'inactive'
    const credit = results.reduce((sum, r) => sum + (r.credit || 0), 0)
    return {
      outcome,
      ...(credit ? { credit } : {}),
      message: results.map((r) => `${r.label}：${r.message}`).join('；'),
      ...(outcome === 'failed' && results.some((r) => r.signIn === 'expired') ? { signIn: 'expired' } : {}),
    }
  } catch (e) {
    return { outcome: 'failed', message: message(e?.message) || '签到失败', ...(e?.signIn === 'expired' ? { signIn: 'expired' } : {}) }
  }
}
