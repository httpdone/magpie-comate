// Comate (文心快码) SaaS backend client.
//
// Protocol derived from the publicly distributed Comate clients:
//   - VS Code extension BaiduComate.comate 4.8.0 (dist/comate-engine/server.js)
//   - npm @comate/comatecli 2.0.0 / @comate/zulu (dist/zulu/*.js)
//
// Auth: the license key itself. The official clients put it in
//   - header  login-name / Uuap-login-name  (URL-encoded)
//   - body    username
//   - query   key=  (model list, license check)
// There is no token exchange and no request signing for the SaaS license flow.
//
// The license is a secret: it is never logged and never put in error messages.

export const DEFAULT_HOST = 'https://comate.baidu.com'
const AUTOWORK = '/api/aidevops/autocomate/rest/autowork'

export const DEFAULTS = Object.freeze({
  host: DEFAULT_HOST,
  // Identity of the official Zulu/Comate CLI (dist/zulu: ideSeries/ideName "zulucli").
  ide: 'zulucli',
  ideVersion: '1.7.16',
  pluginVersion: '4.13.0',
  agentId: '1',
  agentName: 'Zulu',
  agentVersion: 12,
  // How long a silent upstream stream may stay idle before it is aborted.
  idleTimeoutMs: 300_000,
})

export class ComateError extends Error {
  constructor(message, { status = 502, code, kind = 'upstream' } = {}) {
    super(message)
    this.name = 'ComateError'
    this.status = status
    this.code = code
    this.kind = kind
  }
}

/** Never let the license show up in a message we pass on. */
export function redact(text, license) {
  let s = String(text ?? '')
  if (license && license.length >= 4) s = s.split(license).join('***')
  if (license) s = s.split(encodeURIComponent(license)).join('***')
  return s
}

function trimHost(host) {
  return String(host || DEFAULT_HOST).replace(/\/+$/, '').replace(/\/api$/, '')
}

export function resolveConfig(options = {}) {
  const cfg = { ...DEFAULTS }
  for (const k of Object.keys(DEFAULTS)) if (options[k] !== undefined && options[k] !== '') cfg[k] = options[k]
  cfg.host = trimHost(cfg.host)
  return cfg
}

export function userHeaders(license, cfg) {
  const enc = encodeURIComponent(license || '')
  return {
    'login-name': enc,
    'Uuap-login-name': enc,
    'X-Source': 'COMATE',
    'Content-Type': 'application/json',
    'plugin-version': `${cfg.ide}-${cfg.pluginVersion}`,
    'x-skip-fcnap': 'yes',
    'Accept-Language': 'zh-CN,zh',
  }
}

export function clientInfo(license, cfg) {
  return { username: license, ide: cfg.ide, ideVersion: cfg.ideVersion, pluginVersion: cfg.pluginVersion }
}

function traceId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

/** Map a Comate JSON envelope {code, message, data} to data, or throw. */
function unwrap(json, what, license) {
  const code = json?.code
  const msg = redact(json?.message || '', license)
  if (code === 401) throw new ComateError(`Comate 拒绝了 license（${what}）: ${msg || 'unauthorized'}`, { status: 401, code, kind: 'auth' })
  if (code === 429) throw new ComateError(`Comate 额度/频率超限（${what}）: ${msg || 'rate limited'}`, { status: 429, code, kind: 'quota' })
  if (typeof code === 'number' && (code < 200 || code >= 300)) throw new ComateError(`Comate ${what} 失败: ${msg || code}`, { status: 502, code })
  return json?.data
}

async function readJson(res, what, license) {
  const text = await res.text()
  if (res.status === 401 || res.status === 403) throw new ComateError(`Comate ${what}: HTTP ${res.status}`, { status: 401, kind: 'auth' })
  if (res.status === 429) throw new ComateError(`Comate ${what}: HTTP 429`, { status: 429, kind: 'quota' })
  if (!res.ok) throw new ComateError(`Comate ${what}: HTTP ${res.status} ${redact(text.slice(0, 300), license)}`, { status: 502 })
  try {
    return JSON.parse(text)
  } catch {
    throw new ComateError(`Comate ${what}: 非 JSON 响应 ${redact(text.slice(0, 200), license)}`, { status: 502 })
  }
}

export function createClient({ license, options = {}, fetchImpl } = {}) {
  if (!license || typeof license !== 'string') throw new ComateError('缺少 Comate license', { status: 401, kind: 'auth' })
  const cfg = resolveConfig(options)
  const f = fetchImpl ?? ((...a) => globalThis.fetch(...a))
  const lic = license.trim()

  async function postJson(path, body, what, signal) {
    const res = await f(cfg.host + path, {
      method: 'POST',
      headers: { ...userHeaders(lic, cfg), 'X-Trace-Id': traceId() },
      body: JSON.stringify(body),
      signal,
    })
    return unwrap(await readJson(res, what, lic), what, lic)
  }

  return {
    cfg,
    /** GET /api/key/valid/{license} → data truthy when the license is valid (comatecli validateLicenseAuth). */
    async validate(signal) {
      const res = await f(`${cfg.host}/api/key/valid/${encodeURIComponent(lic)}`, {
        headers: userHeaders(lic, cfg),
        signal,
      })
      const json = await readJson(res, 'license 校验', lic)
      return Boolean(json?.data)
    },

    /** GET /api/v2/api/models/available?key=…&type=ZULU&loopVersion=v2 → [{modelId, displayName, …}] */
    async listModels(signal) {
      const q = new URLSearchParams({ key: lic, type: 'ZULU', repoName: '', loopVersion: 'v2', zuluVersion: cfg.pluginVersion, source: 'plugin' })
      const res = await f(`${cfg.host}/api/v2/api/models/available?${q}`, { headers: userHeaders(lic, cfg), signal })
      const json = await readJson(res, '模型列表', lic)
      const data = json?.data
      if (Array.isArray(data)) return data
      if (Array.isArray(data?.models)) return data.models
      if (typeof json?.code === 'number') unwrap(json, '模型列表', lic)
      return []
    },

    /** POST …/v2/conversation → data.id */
    async createConversation(signal) {
      const data = await postJson(`${AUTOWORK}/v2/conversation`, { ...clientInfo(lic, cfg) }, '创建会话', signal)
      if (data?.id == null) throw new ComateError('Comate 创建会话没有返回 id')
      return data.id
    },

    /** POST …/v2/task → data.taskId */
    async createTask(conversationId, signal) {
      const data = await postJson(
        `${AUTOWORK}/v2/task`,
        {
          conversationId,
          ...clientInfo(lic, cfg),
          agentId: cfg.agentId,
          agentInfo: { agentId: cfg.agentId, agentName: cfg.agentName, isProjectAgent: false },
        },
        '创建任务',
        signal,
      )
      if (data?.taskId == null) throw new ComateError('Comate 创建任务没有返回 taskId')
      return data.taskId
    },

    async createSession(signal) {
      const conversationId = await this.createConversation(signal)
      const taskId = await this.createTask(conversationId, signal)
      return { conversationId, taskId }
    },

    /** Body for POST …/v2/execute, as the official client builds it (ParameterCollector.start). */
    buildExecuteBody({ session, query, modelKey, systemReminder, toolUseResults = [], isUserQuery = true, isFirstQuery = true, thinkingEnabled, effort, hasMcp = false, skillInfos }) {
      const body = {
        ...clientInfo(lic, cfg),
        taskId: session.taskId,
        conversationId: session.conversationId,
        agentId: cfg.agentId,
        query: query ?? '',
        modelKey,
        // only when chosen, as the official client: undefined is left out of the JSON
        thinkingEnabled,
        effort,
        sendMode: 'normal',
        startGoal: false,
        hasMcp: !!hasMcp,
        isUserQuery,
        isMockQuery: false,
        localIndex: false,
        agentVersion: Number(cfg.agentVersion) || DEFAULTS.agentVersion,
        systemReminder: systemReminder ?? '',
        uploadBaseInfo: {
          extName: cfg.ide, extVersion: cfg.pluginVersion, ideType: cfg.ide, ideName: cfg.ide, ideVersion: cfg.ideVersion,
          vcsType: 'git', vcsRepo: '', vcsBranchName: '', license: lic, pluginVersion: cfg.pluginVersion, triggerSource: '',
        },
        sysInfo: { os: process.platform, defaultShell: '', homeDir: '', installedCommands: [], notInstalledCommands: [], workspacePath: '' },
        contexts: [],
        toolUseResults,
        subAgents: [],
        extendUserQueryInfo: { commands: [], skills: [], subagents: [], rules: [] },
        extend: { isMultiWorkspace: false, useWorkflow: false },
        agentInfo: { type: 'main', agentId: cfg.agentId, agentName: cfg.agentName, isProjectAgent: false, isCustomAgent: false },
      }
      if (isFirstQuery) body.isFirstQuery = true
      if (Array.isArray(skillInfos)) body.skillInfos = skillInfos
      return body
    },

    /**
     * POST …/v2/execute (SSE). Yields parsed events {sessionId?, content: {type, detail, end?}}.
     * Throws ComateError for EXCEPTION / QUOTA_EXCEED / DOWNGRADE / NEED_RETRY_EXCEPTION frames.
     */
    async *execute(body, signal) {
      const ctrl = new AbortController()
      const onAbort = () => ctrl.abort(signal?.reason)
      if (signal) signal.aborted ? ctrl.abort() : signal.addEventListener('abort', onAbort, { once: true })
      let idle
      const kick = () => {
        clearTimeout(idle)
        idle = setTimeout(() => ctrl.abort(new Error('idle timeout')), Number(cfg.idleTimeoutMs) || DEFAULTS.idleTimeoutMs)
      }
      kick()
      try {
        const res = await f(`${cfg.host}${AUTOWORK}/v2/execute`, {
          method: 'POST',
          headers: { ...userHeaders(lic, cfg), 'X-Trace-Id': traceId(), Accept: 'text/event-stream' },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        })
        const ct = res.headers.get('content-type') || ''
        if (!ct.includes('text/event-stream')) {
          // A JSON envelope instead of a stream is an error answer.
          const json = await readJson(res, '执行', lic)
          unwrap(json, '执行', lic)
          throw new ComateError(`Comate 执行没有返回事件流: ${redact(JSON.stringify(json).slice(0, 300), lic)}`)
        }
        for await (const ev of parseSSE(res.body)) {
          kick()
          const type = ev?.content?.type
          const detail = ev?.content?.detail
          if (type === 'EXCEPTION') throw new ComateError(`Comate 执行异常: ${redact(detail?.exceptionMsg ?? '', lic)}`, { status: 502 })
          if (type === 'QUOTA_EXCEED' || type === 'DOWNGRADE') throw new ComateError(`Comate 额度不足: ${redact(JSON.stringify(detail ?? {}), lic)}`, { status: 429, kind: 'quota' })
          if (type === 'NEED_RETRY_EXCEPTION') throw new ComateError(`Comate 要求重试: ${redact(detail?.exceptionMsg ?? '', lic)}`, { status: 503 })
          yield ev
        }
      } finally {
        clearTimeout(idle)
        signal?.removeEventListener?.('abort', onAbort)
      }
    },
  }
}

/** Parse Comate's SSE body: `data: {json}` lines, `:heartbeat` comments, optional `[DONE]`. */
export async function* parseSSE(body) {
  if (!body) return
  const decoder = new TextDecoder()
  let buf = ''
  const handle = (line) => {
    line = line.replace(/\r$/, '')
    if (!line || line.startsWith(':')) return undefined
    if (/^(event|id|retry):/.test(line)) return undefined
    const data = line.replace(/^data:/, '').trim()
    if (!data || data === '[DONE]') return undefined
    try {
      return JSON.parse(data)
    } catch {
      return undefined
    }
  }
  for await (const chunk of body) {
    buf += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      const ev = handle(line)
      if (ev) yield ev
    }
  }
  buf += decoder.decode()
  const ev = handle(buf)
  if (ev) yield ev
}
