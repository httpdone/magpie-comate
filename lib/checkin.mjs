import { createDecipheriv } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { redact } from './comate.mjs'

const BASE = 'https://console.bce.baidu.com'
const HOST = 'console.bce.baidu.com'
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

function matches(cookie) {
  if (!cookie.domain) return true
  const domain = cookie.domain.replace(/^\./, '')
  return HOST === domain || HOST.endsWith('.' + domain)
}

function expired() {
  return Object.assign(new Error('百度搭子登录态已失效，请重新登录百度搭子或更新 checkinCookie'), { signIn: 'expired' })
}

export async function checkin(getAuth, { options = {}, fetchImpl, desktopCookies = readDesktopCookies } = {}) {
  let cookies = []
  let auth
  let raw = typeof options.checkinCookie === 'string' ? options.checkinCookie.trim() : ''
  const message = (value) => {
    let text = redact(String(value ?? ''), auth?.key)
    for (const c of cookies) {
      text = redact(text, String(c.value ?? ''))
      text = redact(text, String(c.value ?? '').replace(/^["']+|["']+$/g, ''))
    }
    if (raw) text = redact(text, raw)
    return Array.from(text.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, ' ').trim()).slice(0, 200).join('')
  }
  try {
    auth = await getAuth()
    if (!raw && typeof auth?.metadata?.checkinCookie === 'string') raw = auth.metadata.checkinCookie.trim()
    cookies = raw ? parseCookies(raw) : await desktopCookies()
    cookies = cookies.filter((c) => c && typeof c.name === 'string' && typeof c.value === 'string' && (c.domain == null || typeof c.domain === 'string'))
    if (!cookies.some((c) => c.name === 'bce-sessionid' && c.value && matches(c))) {
      return { outcome: 'failed', message: '请先登录百度搭子桌面端，或在登录表单填写签到 Cookie，也可设置含 bce-sessionid 的 checkinCookie 选项以启用每日签到' }
    }
    const f = fetchImpl ?? ((...args) => globalThis.fetch(...args))
    const deadline = Date.now() + 25_000
    async function request(path, post = false) {
      const header = post ? cookies.filter(matches).map((c) => {
        let value = c.value.replace(/^["']+|["']+$/g, '')
        if (/[:|;=\s]/.test(value)) value = `"${value}"`
        return `${c.name}=${value}`
      }).join('; ') : cookies.map((c) => `${c.name}=${c.value}`).join('; ')
      const csrf = cookies.find((c) => c.name === 'bce-user-info' && c.domain && matches(c))
      const res = await f(BASE + path, {
        ...(post ? { method: 'POST', body: '{}' } : {}),
        headers: {
          Cookie: header, 'User-Agent': UA, Accept: 'application/json', Referer: BASE + '/',
          ...(post ? { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', Origin: BASE, csrftoken: csrf?.value.replace(/^["']+|["']+$/g, '') || '' } : {}),
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
      if (!res.ok) throw new Error(`签到接口 HTTP ${res.status}`)
      if (payload.code !== 0 || payload.success === false) {
        if (/登录凭证|重新登录|login/i.test(String(payload.message))) throw expired()
        throw new Error(`签到接口错误: ${message(payload.message) || payload.code}`)
      }
      return payload.result
    }
    let before
    try { before = await request(INFO) } catch (e) {
      if (e?.signIn === 'expired') throw e
    }
    if (before?.hasIssued === true) return { outcome: 'done', message: `今日已签到（累计 ${message(before.totalTimes) || '?'} 天）` }
    if (Date.now() >= deadline) return { outcome: 'failed', message: '签到超时，稍后自动重试' }
    const beforePoints = parseFloat(before?.totalPoints ?? '0') || 0
    await request('/api/dumate/points/loginBonus', true)
    let after
    try { after = await request(INFO) } catch {}
    if (after?.hasIssued === true) {
      const delta = Math.max(0, Math.round((parseFloat(after.totalPoints ?? '0') || 0) - beforePoints))
      return { outcome: 'claimed', ...(delta ? { credit: delta } : {}), message: `签到成功${delta ? ` +${delta} 积分` : ''}（累计 ${message(after.totalTimes) || '?'} 天）` }
    }
    return { outcome: 'inactive', message: '签到请求已提交，但今日积分尚未到账（可能延迟，稍后自动重试）' }
  } catch (e) {
    return { outcome: 'failed', message: message(e?.message) || '签到失败', ...(e?.signIn === 'expired' ? { signIn: 'expired' } : {}) }
  }
}
