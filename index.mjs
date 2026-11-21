/**
 * magpie-comate (https://github.com/httpdone/magpie-comate) — your own Baidu Comate (文心快码) license as a magpie / OpenCode provider.
 *
 * magpie sends this provider OpenAI Chat Completions (npm "@ai-sdk/openai-compatible");
 * the loader's fetch answers them with Comate's agent API (see lib/handler.mjs).
 *
 * Sign-in: one "oauth" method of the "code" kind. magpie opens Comate's 个人中心
 * (https://comate.baidu.com/zh/user, or options.licenseUrl) where the user copies the
 * license, then asks for it; the callback checks it with GET /api/key/valid/{license}
 * and magpie keeps it as the account's key in plugin-auth.json (mode 600). It never goes
 * into this folder, into logs, or into error messages.
 *
 * Options (magpie plugin options comate '{…}'), all optional:
 *   licenseUrl     page opened at sign-in to copy the license (default https://comate.baidu.com/zh/user)
 *   host           Comate service, default https://comate.baidu.com (private deployments differ)
 *   ide, ideVersion, pluginVersion, agentId, agentName, agentVersion   client identity sent upstream
 *   idleTimeoutMs  abort an upstream stream silent for this long (default 300000)
 *   sessionReuse   continue the same Comate conversation across turns (default true)
 *   sessionTtlMs   forget a cached conversation state after this long unused (default 1800000)
 *   sessionMax     at most this many cached states, least recently used dropped (default 200)
 *   toolMode       "xml" (default): tools described as an XML text convention;
 *                  "mcp" (experimental): tools exposed as one MCP server, called via Comate's use_mcp_tool
 */
import { createClient, ComateError, redact } from './lib/comate.mjs'
import { checkin } from './lib/checkin.mjs'
import { handleChatCompletions } from './lib/handler.mjs'
import { toMagpieModel } from './lib/translate.mjs'
import { createSessionStore, SESSION_DEFAULTS } from './lib/sessions.mjs'

const PROVIDER = 'comate'
// Requests never reach this address: the loader's fetch intercepts them.
const BASE = 'https://comate.baidu.com/magpie-comate/v1'

// Comate has no fixed model ids (they carry a per-deployment suffix, e.g. glm-5.3_<hash>): nothing is
// declared up front; provider.models lists the account's models from the API after sign-in.
// provider.models answers OpenCode Model objects: the host reads capabilities / api / variants from them.
const BASE_MODEL = {
  limit: { context: 128000, output: 32000 },
  tool_call: true,
  api: { url: BASE, npm: '@ai-sdk/openai-compatible' },
  capabilities: { temperature: false, reasoning: false, attachment: false, toolcall: true, input: { text: true, image: false, audio: false, video: false, pdf: false }, output: { text: true }, interleaved: false },
}
const DEFAULT_MODELS = {}

// Per-license model info cache (for thinking/effort decisions), keyed by the license itself
// in memory only.
const modelCache = new Map()
const CACHE_MS = 10 * 60 * 1000

async function modelsFor(license, options) {
  const hit = modelCache.get(license)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.list
  const list = await createClient({ license, options }).listModels()
  modelCache.set(license, { at: Date.now(), list })
  return list
}

function requestUrl(input) {
  try {
    return input instanceof Request ? new URL(input.url) : new URL(String(input))
  } catch {
    return null
  }
}

/** A request header from init or the Request (magpie tells the picked effort in X-Magpie-Effort). */
function headerOf(input, init, name) {
  try {
    const own = init?.headers ? new Headers(init.headers).get(name) : null
    return own ?? (input instanceof Request ? input.headers.get(name) : null) ?? undefined
  } catch {
    return undefined
  }
}

async function readBody(input, init) {
  let raw = init?.body
  if (raw == null && input instanceof Request) raw = await input.text()
  if (raw instanceof Uint8Array || raw instanceof ArrayBuffer) raw = new TextDecoder().decode(raw)
  if (typeof raw !== 'string') raw = raw == null ? '' : String(raw)
  return JSON.parse(raw || '{}')
}

function makeFetch(license, options, sessions) {
  return async function comateFetch(input, init) {
    const url = requestUrl(input)
    const path = url?.pathname ?? ''
    if (/\/models\/?$/.test(path) && (init?.method ?? 'GET').toUpperCase() === 'GET') {
      const list = await modelsFor(license, options).catch(() => [])
      const data = list.map((m) => ({ id: m.modelId, object: 'model', owned_by: 'comate', name: m.displayName }))
      return new Response(JSON.stringify({ object: 'list', data }), { headers: { 'content-type': 'application/json' } })
    }
    if (!/\/chat\/completions\/?$/.test(path)) {
      return new Response(JSON.stringify({ error: { message: `Comate 插件只支持 chat/completions（收到 ${path}）`, type: 'invalid_request_error' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })
    }
    let body
    try {
      body = await readBody(input, init)
    } catch {
      return new Response(JSON.stringify({ error: { message: 'request body must be JSON', type: 'invalid_request_error' } }), { status: 400, headers: { 'content-type': 'application/json' } })
    }
    return handleChatCompletions({
      body,
      license,
      options,
      signal: init?.signal,
      sessions,
      effortHeader: headerOf(input, init, 'x-magpie-effort'),
      getModelInfo: async (id) => {
        const list = await modelsFor(license, options).catch(() => [])
        return list.find((m) => (m.modelId ?? m.id) === id)
      },
    })
  }
}

// Where a Comate user finds their license.
export const LICENSE_PAGE = 'https://comate.baidu.com/zh/user'

/** The license page for these options: {"licenseUrl": …} wins, else the default host's 个人中心. */
function licensePage(opts) {
  const own = typeof opts.licenseUrl === 'string' ? opts.licenseUrl.trim() : ''
  return /^https?:\/\//i.test(own) ? own : LICENSE_PAGE
}

/**
 * The sign-in, as OpenCode's oauth "code" flow: the page to open, what to do there, and the
 * callback that takes the pasted license, checks it with Comate and keeps it as the account's key.
 */
function signInStep(opts) {
  const url = licensePage(opts)
  return {
    url,
    method: 'code',
    instructions: `正在打开 Comate 个人中心（没自动打开请手动访问 ${url}）：登录后复制 license，粘贴到这里。`,
    async callback(code, { signal } = {}) {
      return checkLicense(code, opts, signal)
    },
  }
}

/** Validate a pasted license; never echoes it back in an error. */
async function checkLicense(input, opts, signal) {
  const key = String(input ?? '').trim()
  if (!key) return { type: 'failed', error: '没有填写 license' }
  try {
    const ok = await createClient({ license: key, options: opts }).validate(signal)
    if (!ok) return { type: 'failed', error: 'Comate 说这个 license 无效' }
    return { type: 'success', key }
  } catch (e) {
    return { type: 'failed', error: redact(e?.message ?? String(e), key).slice(0, 500) }
  }
}

/** In-memory conversation cache, unless turned off with {"sessionReuse": false}. */
function makeSessions(opts) {
  if (opts.sessionReuse === false || opts.sessionReuse === 'false' || opts.sessionReuse === 0) return undefined
  const ttlMs = Number(opts.sessionTtlMs) > 0 ? Number(opts.sessionTtlMs) : SESSION_DEFAULTS.ttlMs
  const max = Number(opts.sessionMax) > 0 ? Math.floor(Number(opts.sessionMax)) : SESSION_DEFAULTS.max
  return createSessionStore({ ttlMs, max })
}

export const ComateAuthPlugin = async (_input, options) => {
  const opts = options && typeof options === 'object' ? options : {}
  const sessions = makeSessions(opts)
  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[PROVIDER] ??= {
        name: '文心快码 Comate',
        npm: '@ai-sdk/openai-compatible',
        api: BASE,
        models: DEFAULT_MODELS,
      }
    },

    auth: {
      provider: PROVIDER,
      maxConcurrency: 2,
      checkin: (getAuth) => checkin(getAuth, { options: opts }),
      methods: [
        {
          // An "oauth" method whose sign-in page is Comate's 个人中心: magpie opens it (a new
          // tab in magpie web, the default browser from the app and `magpie plugin login`,
          // the link printed when it can't), then asks for the "code", the license copied there.
          type: 'oauth',
          label: 'Comate license (copy it from your Comate account page)',
          labels: { zh: 'Comate license（自动打开个人中心复制）', 'zh-TW': 'Comate license（自動打開個人中心複製）' },
          authorize: async () => signInStep(opts),
        },
      ],
      async loader(getAuth) {
        const auth = await getAuth()
        const license = auth?.type === 'api' ? auth.key : undefined
        if (!license) return {}
        return { baseURL: BASE, apiKey: 'comate-license-in-plugin', fetch: makeFetch(license, opts, sessions) }
      },
    },

    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        if (auth?.type !== 'api' || !auth.key) return provider.models
        let list
        try {
          list = await createClient({ license: auth.key, options: opts }).listModels()
        } catch (e) {
          if (e instanceof ComateError && e.kind === 'auth') throw Object.assign(new Error('Comate 拒绝了 license'), { signIn: 'expired' })
          return provider.models
        }
        modelCache.set(auth.key, { at: Date.now(), list })
        if (!list.length) return provider.models
        const base = BASE_MODEL
        const out = {}
        for (const m of list) {
          const id = m?.modelId ?? m?.id
          if (!id) continue
          out[id] = toMagpieModel(m, base)
        }
        return out
      },
    },
  }
}

// Test surface (not a plugin function; the host calls every exported function).
export const _internal = { makeFetch, makeSessions, modelCache, PROVIDER, BASE, signInStep, checkLicense, licensePage }
