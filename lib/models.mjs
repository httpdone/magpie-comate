/**
 * Per-model parameters, taken only from what Comate's model list returns — no per-family tables,
 * no guessing from the model id.
 *
 * GET /api/v2/api/models/available fields used (see PROTOCOL.md "模型参数"):
 *  - modelId (used as-is, e.g. "glm-5.3_<hash>"), displayName
 *  - maxContextWindow: K tokens (the VS Code extension computes 1e3*Number(maxContextWindow))
 *  - supportThinking; thinkingConfig.switchable; effortConfig.{levels[].value, defaultLevel}
 *  - ratio: credit multiple, e.g. "0.3x"
 *  - requestType: COMATE_DEFAULT_MODE is the server-routed model (no thinking fields sent)
 * As in comatecli 2.0, thinkingEnabled / effort are sent only when the model's thinkingConfig /
 * effortConfig offers a choice. The live list (2026-11) has both null for every model, so
 * normally neither is sent. No client sends max_tokens, temperature or top_p.
 */

export const ORDER = ['low', 'medium', 'high', 'max']
/** Generic defaults, used only when the API leaves the field out. */
export const DEFAULT_CONTEXT = 128000
export const DEFAULT_OUTPUT = 32000 // the list has no output-limit field

/** "0.3x" / "2" / 2 → number (0 when missing or unparsable). */
export function num(v) {
  const n = typeof v === 'string' ? Number(v.trim().replace(/^[x×]\s*|\s*[x×]$/gi, '')) : v
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0
}

/** maxContextWindow (K tokens) → tokens. */
export const contextTokens = (v) => Math.round(num(v) * 1000)

export function levelsOf(m) {
  const raw = m?.effortConfig?.levels
  return (Array.isArray(raw) ? raw : []).map((l) => (typeof l === 'string' ? l : l?.value)).filter((v) => typeof v === 'string' && v)
}

/** Everything a model entry offers, straight from the API entry. */
export function profileOf(m) {
  const id = m?.modelId ?? m?.id
  const auto = m?.requestType === 'COMATE_DEFAULT_MODE'
  const levels = levelsOf(m)
  const def = m?.effortConfig?.defaultLevel
  const ctx = contextTokens(m?.maxContextWindow)
  return {
    id,
    name: m?.displayName || id,
    auto,
    context: ctx || DEFAULT_CONTEXT,
    output: DEFAULT_OUTPUT,
    thinking: !auto && m?.supportThinking === true,
    switchable: m?.thinkingConfig?.switchable === true,
    levels,
    defaultLevel: levels.includes(def) ? def : levels[0],
    image: m?.supportImage === true,
    rate: num(m?.ratio),
  }
}

/** Efforts an agent may pick (magpie variants): the effortConfig levels, plus "none" when thinkingConfig.switchable. */
export function effortsOf(p) {
  if (!p.thinking) return []
  if (!p.levels.length && !p.switchable) return []
  const lv = p.levels.length ? p.levels : ['high']
  return p.switchable ? ['none', ...lv] : lv
}

/** Nearest offered level not above the asked one, else the lowest offered. */
export function clampLevel(asked, levels) {
  if (!levels.length) return undefined
  if (levels.includes(asked)) return asked
  const want = ORDER.indexOf(asked)
  if (want < 0) return undefined
  const below = levels.filter((l) => ORDER.indexOf(l) >= 0 && ORDER.indexOf(l) <= want)
  return below.length ? below[below.length - 1] : levels[0]
}

/** A thinking budget (Anthropic thinking.budget_tokens) as an effort. */
export function budgetEffort(budget) {
  const b = Number(budget)
  if (b === -1 || !Number.isFinite(b)) return '' // auto: the model's default
  if (b <= 0) return 'none'
  if (b <= 1024) return 'low'
  if (b <= 8192) return 'medium'
  if (b <= 24576) return 'high'
  return 'max'
}

/** The effort a request asks for: magpie's X-Magpie-Effort, else reasoning_effort, reasoning.effort, thinking. */
export function askedEffort(body, headerEffort) {
  let e = String(headerEffort ?? '').trim().toLowerCase()
  if (!e) e = String(body?.reasoning_effort ?? body?.reasoning?.effort ?? '').trim().toLowerCase()
  if (!e && body?.thinking && typeof body.thinking === 'object') {
    const t = body.thinking
    e = t.type === 'disabled' ? 'none' : t.type === 'enabled' ? budgetEffort(t.budget_tokens) : ''
  }
  if (e === 'auto' || e === 'default') e = ''
  if (e === 'xhigh') e = 'max'
  if (e === 'minimal') e = 'low+off'
  return e || undefined
}

/**
 * thinkingEnabled / effort for the execute body (undefined = not sent), as comatecli does:
 *  - thinkingEnabled only when thinkingConfig.switchable is true;
 *  - effort only when effortConfig has levels: the asked one clamped to them, else defaultLevel;
 *  - nothing for a model without these configs, a server-routed model, or one not in the list.
 */
export function resolveThinking(p, asked) {
  if (!p || !p.id || p.auto || !p.thinking) return {}
  const off = asked === 'none' || asked === 'low+off'
  const want = asked === 'low+off' ? 'low' : asked
  const out = {}
  if (p.switchable) out.thinkingEnabled = asked ? !off : true
  if (p.levels.length) out.effort = (want && !off && clampLevel(want, p.levels)) || p.defaultLevel
  return out
}
