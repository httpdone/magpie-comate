#!/usr/bin/env node
// Standalone fallback: an OpenAI-compatible proxy on 127.0.0.1 for the same adapter,
// for when you would rather add Comate to magpie as a custom provider
// (magpie provider add … --base-url http://127.0.0.1:PORT/v1) than load the plugin,
// or use it from any other OpenAI-compatible client.
//
//   COMATE_LICENSE=…  node bin/serve.mjs            # license from env (never logged)
//   COMATE_LICENSE_FILE=~/.config/comate/license node bin/serve.mjs
//   PORT=3426  HOST=127.0.0.1  COMATE_HOST=https://comate.baidu.com  COMATE_TOOL_MODE=xml|mcp
//   PROXY_TOKEN=…   require "Authorization: Bearer <PROXY_TOKEN>" from clients (recommended)
//   COMATE_SESSION_REUSE=0   send every request as a fresh Comate conversation
//   COMATE_SESSION_TTL_MS=1800000  COMATE_SESSION_MAX=200
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { handleChatCompletions, handleModels } from '../lib/handler.mjs'
import { createSessionStore, SESSION_DEFAULTS } from '../lib/sessions.mjs'

function loadLicense() {
  if (process.env.COMATE_LICENSE) return process.env.COMATE_LICENSE.trim()
  const file = process.env.COMATE_LICENSE_FILE
  if (file) return readFileSync(file.replace(/^~(?=\/)/, homedir()), 'utf8').trim()
  return ''
}

export function createProxyServer({ license, options = {}, token = '', fetchImpl, sessions } = {}) {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://local')
      const path = url.pathname.replace(/\/+$/, '')
      if (token) {
        const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.headers['x-api-key'] || ''
        if (got !== token) {
          res.writeHead(401, { 'content-type': 'application/json' })
          return res.end(JSON.stringify({ error: { message: 'bad proxy token', type: 'authentication_error' } }))
        }
      }
      if (req.method === 'GET' && (path === '/health' || path === '')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ ok: true, licensed: !!license }))
      }
      const ac = new AbortController()
      res.on('close', () => { if (!res.writableEnded) ac.abort() })
      let out
      if (req.method === 'GET' && /\/models$/.test(path)) out = await handleModels({ license, options, fetchImpl, signal: ac.signal })
      else if (req.method === 'POST' && /\/chat\/completions$/.test(path)) {
        let raw = ''
        for await (const c of req) raw += c
        let body
        try { body = JSON.parse(raw || '{}') } catch {
          res.writeHead(400, { 'content-type': 'application/json' })
          return res.end(JSON.stringify({ error: { message: 'request body must be JSON', type: 'invalid_request_error' } }))
        }
        out = await handleChatCompletions({ body, license, options, fetchImpl, signal: ac.signal, sessions })
      } else {
        res.writeHead(404, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ error: { message: `not found: ${req.method} ${path}`, type: 'invalid_request_error' } }))
      }
      res.writeHead(out.status, Object.fromEntries(out.headers))
      if (!out.body) return res.end()
      for await (const chunk of out.body) res.write(chunk)
      res.end()
    } catch (e) {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: String(e?.message ?? e).split(license || '\u0000').join('***'), type: 'api_error' } }))
    }
  })
}

const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/serve.mjs') || process.argv[1]?.endsWith('comate-openai-proxy')
if (isMain) {
  const license = loadLicense()
  if (!license) {
    console.error('缺少 license：请设置 COMATE_LICENSE 或 COMATE_LICENSE_FILE')
    process.exit(1)
  }
  const port = Number(process.env.PORT || 3426)
  const host = process.env.HOST || '127.0.0.1'
  const options = process.env.COMATE_HOST ? { host: process.env.COMATE_HOST } : {}
  if (process.env.COMATE_TOOL_MODE) options.toolMode = process.env.COMATE_TOOL_MODE
  const reuse = !/^(0|false|off|no)$/i.test(process.env.COMATE_SESSION_REUSE ?? '')
  const sessions = reuse
    ? createSessionStore({
        ttlMs: Number(process.env.COMATE_SESSION_TTL_MS) > 0 ? Number(process.env.COMATE_SESSION_TTL_MS) : SESSION_DEFAULTS.ttlMs,
        max: Number(process.env.COMATE_SESSION_MAX) > 0 ? Number(process.env.COMATE_SESSION_MAX) : SESSION_DEFAULTS.max,
      })
    : undefined
  createProxyServer({ license, options, token: process.env.PROXY_TOKEN || '', sessions }).listen(port, host, () => {
    console.error(`comate proxy listening on http://${host}:${port}/v1 (license loaded, not shown)`)
  })
}
