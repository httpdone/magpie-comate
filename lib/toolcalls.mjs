// Streaming extraction of text-form tool calls from a model's answer.
//
// The system reminder asks for our own block:
//   <tool_call_call id="call_1" name="bash"><arguments>{"command":"ls"}</arguments></tool_call_call>
// Models drift from it, so these are accepted too:
//   - other tag names: <tool_call>, <function_call>, <invoke> (and <function_calls>/<tool_calls> wrappers);
//   - the name/id as attributes, as <name> children, or inside a JSON body ({"name":..,"arguments":..});
//   - arguments as <arguments>/<parameters>/<args>/<input> JSON, as <parameter name="k">v</parameter>
//     children, or as the plain/fenced JSON body;
//   - DeepSeek special tokens (<｜tool▁calls▁begin｜> … <｜tool▁call▁begin｜>name<｜tool▁sep｜>{…}<｜tool▁call▁end｜>);
//   - a ```json fence whose JSON is a call to one of the declared tools.
// A tag split across chunks is held back until it can be decided. Once a call has started, nothing
// of it is given back as text: at the end of the stream an unclosed call is emitted if it parses,
// otherwise it is reported in `dropped` (the handler retries once and then shows a short note).

const WORD_TAGS = ['tool_call_call', 'function_calls', 'function_call', 'tool_calls', 'tool_call', 'invoke']
const WRAPPERS = new Set(['function_calls', 'tool_calls'])
// DeepSeek tokens use U+FF5C (｜) and U+2581 (▁); some renderings use | and _. Same length, so a
// normalized copy keeps indices aligned with the original text.
const normTokens = (s) => s.replace(/[\uFF5C]/g, '|').replace(/\u2581/g, '_')
const DS_CALLS_BEGIN = '<|tool_calls_begin|>'
const DS_CALLS_END = '<|tool_calls_end|>'
const DS_CALL_BEGIN = '<|tool_call_begin|>'
const DS_CALL_END = '<|tool_call_end|>'
const DS_SEP = '<|tool_sep|>'
// Stray tags that are removed from the text when they start a line (seen live): Comate's own prompt
// wraps the user's text in <user-input> and our transcript uses <tool_result>, and models echo their
// closers; leftover closers of tool markup (e.g. a DSML "</calls>") are dropped the same way.
const JUNK_RE = /<\/?user-input>|<\/(?:tool_result|calls|function_calls|tool_calls|invoke|tool_call_call|tool_call|function_call|arguments|parameters?)>/
const JUNK = ['<user-input>', '</user-input>', ...['tool_result', 'calls', 'function_calls', 'tool_calls', 'invoke', 'tool_call_call', 'tool_call', 'function_call', 'arguments', 'parameters', 'parameter'].map((t) => `</${t}>`)]
const OPENERS = [...WORD_TAGS.map((t) => `<${t}`), DS_CALLS_BEGIN, DS_CALL_BEGIN, DS_CALLS_END, DS_CALL_END, ...JUNK]
const OPEN_RE = new RegExp(`<(${WORD_TAGS.join('|')})(?=[\\s>/])|<\\|tool_calls?_(?:begin|end)\\|>|${JUNK_RE.source}`)
// DeepSeek V4 writes native tool calls as DSML: <｜DSML｜function_calls><｜DSML｜invoke name="x">
// <｜DSML｜parameter name="k" string="true">v</｜DSML｜parameter>… (seen live, garbled, as "</｜｜DSML｜｜ calls>").
// Dropping the marker turns it into the <function_calls>/<invoke> form handled below.
const DSML_RE = /(<\/?)\s*[｜|]{1,2}\s*DSML\s*[｜|]{1,2}\s*(?=[^｜|\s])/g
const DSML_PARTIAL = /<\/?\s*[｜|]{1,2}\s*(?:D(?:S(?:M(?:L\s*(?:[｜|]{1,2})?)?)?)?)?\s*$/

const lower = (s) => String(s ?? '').toLowerCase()
const squash = (s) => lower(s).replace(/[^a-z0-9]/g, '')

// Same-job names, used only when exactly one declared tool falls in the group.
const ALIASES = [
  ['bash', 'shell', 'sh', 'terminal', 'run_command', 'execute_command', 'run_terminal_cmd', 'run_shell_command', 'exec', 'command'],
  ['read', 'read_file', 'view', 'view_file', 'cat', 'open_file'],
  ['write', 'write_file', 'create_file', 'write_to_file'],
  ['edit', 'edit_file', 'str_replace', 'str_replace_editor', 'replace_in_file', 'apply_edit', 'replace'],
  ['grep', 'search', 'grep_search', 'search_files', 'codebase_search'],
  ['ls', 'list', 'list_dir', 'list_files', 'list_directory'],
  ['glob', 'find', 'find_files', 'file_search'],
].map((g) => new Set(g.map(squash)))

/**
 * A declared tool for a model-written name: exact, then case-insensitive, then ignoring
 * punctuation, then an alias group — each step only when it picks exactly one tool.
 * @returns {object|undefined}
 */
export function resolveToolName(name, tools) {
  if (!name || !tools?.length) return undefined
  const one = (list) => (list.length === 1 ? list[0] : undefined)
  const exact = tools.find((t) => t.name === name)
  if (exact) return exact
  const ci = tools.filter((t) => lower(t.name) === lower(name))
  if (ci.length) return one(ci)
  const sq = tools.filter((t) => squash(t.name) === squash(name))
  if (sq.length) return one(sq)
  const group = ALIASES.find((g) => g.has(squash(name)))
  return group ? one(tools.filter((t) => group.has(squash(t.name)))) : undefined
}

const stripFence = (s) => s.trim().replace(/^```[\w-]*\s*/, '').replace(/\s*```$/, '').trim()

function tryJson(s) {
  try {
    return { ok: true, value: JSON.parse(s) }
  } catch {
    return { ok: false }
  }
}

/** JSON, or (for a cut-off stream) JSON with its missing closing quotes/brackets added. */
function parseJsonLoose(raw, repair) {
  const s = stripFence(raw)
  if (!s) return { ok: true, value: {} }
  const r = tryJson(s)
  if (r.ok || !repair) return r
  // close what is open, in order
  const stack = []
  let inStr = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inStr) {
      if (c === '\\') i++
      else if (c === '"') inStr = false
    } else if (c === '"') inStr = true
    else if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']')
    else if (c === '}' || c === ']') stack.pop()
  }
  let fixed = s.replace(/\\$/, '') + (inStr ? '"' : '')
  fixed = fixed.replace(/,\s*$/, '')
  return tryJson(fixed + stack.reverse().join(''))
}

const attr = (head, names) => {
  for (const n of names) {
    const m = head.match(new RegExp(`\\b${n}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`))
    if (m) return m[1] ?? m[2]
  }
  return undefined
}

const child = (inner, names) => {
  for (const n of names) {
    const m = inner.match(new RegExp(`<${n}\\b[^>]*>([\\s\\S]*?)</${n}>`))
    if (m) return m[1]
  }
  return undefined
}

function paramValue(v, schema) {
  const t = schema?.type
  const s = v.replace(/^\n/, '').replace(/\n$/, '')
  if (t === 'string') return s
  const r = tryJson(s.trim())
  if (r.ok && (t ? typeof r.value !== 'string' : true)) return r.value
  return s
}

/** The object a call-shaped JSON value describes: {name, args, id}. */
function callFromJson(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const fn = v.function && typeof v.function === 'object' ? v.function : undefined
  const name = v.name ?? v.tool ?? v.tool_name ?? fn?.name ?? (typeof v.function === 'string' ? v.function : undefined)
  if (typeof name !== 'string' || !name) return undefined
  let args = v.arguments ?? v.parameters ?? v.args ?? v.input ?? v.params ?? fn?.arguments ?? fn?.parameters
  if (typeof args === 'string') {
    const r = tryJson(args)
    args = r.ok ? r.value : args
  }
  if (args == null) args = {}
  return { name, args, id: typeof v.id === 'string' ? v.id : undefined }
}

/**
 * Parse one word-tag block. complete=false: the stream ended before the close tag.
 * @returns {{calls: Array<{id?, name, args}>, bad?: string}}  bad: why nothing usable came out
 */
function parseWordBlock(tag, head, inner, complete, tools) {
  if (WRAPPERS.has(tag)) {
    const sub = createToolCallSplitter({ tools })
    const a = sub.push(inner)
    const b = sub.end()
    const calls = [...a.calls, ...b.calls].map((c) => ({ id: c.id, name: c.name, args: JSON.parse(c.arguments) }))
    const dropped = [...a.dropped ?? [], ...b.dropped]
    return calls.length ? { calls } : { calls: [], bad: dropped[0]?.reason ?? (complete ? 'empty' : 'incomplete'), name: dropped[0]?.name }
  }
  const id = attr(head, ['id', 'call_id'])
  let name = attr(head, ['name', 'tool', 'tool_name', 'function'])
  if (!name) name = child(inner, ['name', 'tool_name', 'function_name'])?.trim()
  let argChild = child(inner, ['arguments', 'parameters', 'args', 'input', 'params'])
  if (argChild == null && !complete) {
    // cut off inside <arguments>…: use what arrived
    const m = inner.match(/<(arguments|parameters|args|input|params)>([\s\S]*)$/)
    if (m) argChild = m[2].replace(/<\/?[a-z_]*$/i, '')
  }
  if (argChild != null) {
    const r = parseJsonLoose(argChild, !complete)
    if (r.ok && r.value && typeof r.value === 'object') {
      if (!name) return { calls: [], bad: 'no tool name' }
      return { calls: [{ id, name, args: r.value }] }
    }
    // <parameters><parameter name=..> nested
    if (/<(?:parameter|param|arg)\b/.test(argChild)) inner = argChild
    else if (complete) return name ? { calls: [{ id, name, args: { raw: stripFence(argChild) } }] } : { calls: [], bad: 'no tool name' }
    else return { calls: [], bad: 'arguments cut off', name }
  }
  // <parameter name="k">v</parameter> children
  const params = [...inner.matchAll(/<(parameter|param|arg)\s+([^>]*?)\/?>(?:([\s\S]*?)<\/\1>)?/g)].filter((p) => attr(p[2], ['name']) != null)
  if (params.length) {
    if (!name) return { calls: [], bad: 'no tool name' }
    const props = resolveToolName(name, tools)?.parameters?.properties ?? {}
    const args = {}
    for (const p of params) {
      const k = attr(p[2], ['name'])
      const str = attr(p[2], ['string']) // DSML: string="true" keeps the raw text, "false" is JSON
      const v = p[3] ?? ''
      args[k] = str === 'true' ? v : str === 'false' ? paramValue(v, { type: 'json' }) : paramValue(v, props[k])
    }
    return { calls: [{ id, name, args }] }
  }
  if (/<(?:parameter|param|arg)\b/.test(inner)) return { calls: [], bad: 'arguments cut off', name }
  // JSON body: plain args, or a whole call object
  const body = inner.replace(/<\/?(?:name|tool_name|function_name)\b[^>]*>[^<]*<\/(?:name|tool_name|function_name)>/g, '').trim()
  if (!body) {
    if (!name) return { calls: [], bad: 'no tool name' }
    if (!complete) return { calls: [], bad: 'no arguments', name }
    return { calls: [{ id, name, args: {} }] }
  }
  const r = parseJsonLoose(body, !complete)
  if (r.ok) {
    const c = !name ? callFromJson(r.value) : undefined
    if (c) return { calls: [{ id: id ?? c.id, name: c.name, args: c.args }] }
    if (name && r.value && typeof r.value === 'object' && !Array.isArray(r.value)) {
      const wrapped = callFromJson(r.value)
      // {"name":"bash","arguments":{..}} inside a named tag
      if (wrapped && lower(wrapped.name) === lower(name) && typeof wrapped.args === 'object') return { calls: [{ id, name, args: wrapped.args }] }
      return { calls: [{ id, name, args: r.value }] }
    }
  }
  if (!name) return { calls: [], bad: 'no tool name' }
  if (!complete) return { calls: [], bad: 'arguments cut off', name }
  return { calls: [{ id, name, args: { raw: stripFence(body) } }] }
}

/** DeepSeek token block (between tool_call(s)_begin and _end), normalized. */
function parseDeepSeek(inner, complete) {
  const calls = []
  let bad
  let badName
  const parts = inner.includes(DS_CALL_BEGIN) ? inner.split(DS_CALL_BEGIN).slice(1) : [inner]
  for (let i = 0; i < parts.length; i++) {
    const closed = parts[i].includes(DS_CALL_END)
    const p = parts[i].split(DS_CALL_END)[0]
    const last = i === parts.length - 1
    const whole = closed || (complete && !last) || complete
    const sep = p.indexOf(DS_SEP)
    let name
    let argText
    if (sep < 0) {
      bad = 'arguments cut off'
      badName = p.trim() || undefined
      continue
    }
    const left = p.slice(0, sep).trim()
    const right = p.slice(sep + DS_SEP.length)
    if (left === 'function' || left === '') {
      // V3: function<sep>name\n```json\n{...}\n```
      const nl = right.indexOf('\n')
      name = (nl < 0 ? right : right.slice(0, nl)).trim()
      argText = nl < 0 ? '' : right.slice(nl + 1)
    } else {
      name = left
      argText = right
    }
    const r = parseJsonLoose(argText, !whole)
    if (name && r.ok && r.value && typeof r.value === 'object' && !(argText.trim() === '' && !whole)) calls.push({ name, args: r.value })
    else {
      bad = name ? 'arguments cut off' : 'no tool name'
      badName = name
    }
  }
  return calls.length ? { calls } : { calls: [], bad: bad ?? 'empty', name: badName }
}

/**
 * @param {{tools?: Array<{name, parameters}>}} [opts]
 * push(text) / end() → {text, calls: [{id, name, arguments}], dropped: [{name?, reason}]}
 */
export function createToolCallSplitter({ tools = [] } = {}) {
  let buf = ''
  let seq = 0
  const fences = tools.length > 0
  const newId = () => `call_${Date.now().toString(36)}_${seq++}`

  // Earliest place a call (or a held-back possible start) begins: {at, kind, ...} or null.
  function findStart(n) {
    const m = OPEN_RE.exec(n)
    let best = m ? { at: m.index, kind: m[1] ? 'word' : m[0].includes('|') ? 'ds' : 'junk', tag: m[1], token: m[0] } : null
    if (fences) {
      const f = n.indexOf('```')
      if (f >= 0 && (!best || f < best.at)) best = { at: f, kind: 'fence' }
    }
    return best
  }

  // Length of a tail that might still turn into an opener.
  function holdTail(n) {
    const d = n.match(DSML_PARTIAL)
    if (d) return d[0].length
    const from = Math.max(0, n.length - 24)
    for (let i = from; i < n.length; i++) {
      const t = n.slice(i)
      if (t[0] === '<' && OPENERS.some((o) => o.startsWith(t))) return n.length - i
      if (fences && t[0] === '`' && '```'.startsWith(t)) return n.length - i
    }
    return 0
  }

  function finish(parsed, out) {
    for (const c of parsed.calls) {
      const tool = resolveToolName(c.name, tools)
      out.calls.push({ id: c.id || newId(), name: tool ? tool.name : c.name, arguments: JSON.stringify(c.args ?? {}) })
    }
  }

  // At stream end an unclosed call only counts if it is usable for the declared tool.
  function usableAtEnd(parsed) {
    return parsed.calls.length > 0 && parsed.calls.every((c) => {
      const tool = resolveToolName(c.name, tools)
      if (tools.length && !tool) return false
      const req = tool?.parameters?.required ?? []
      return req.every((k) => c.args && Object.prototype.hasOwnProperty.call(c.args, k))
    })
  }

  // While a block is open, new text is only checked for its closer and kept in `parts`
  // (joined once the closer shows up), so long write/edit payloads stay linear.
  let waitFor = null // {close, carry}
  let parts = []
  function push(t) {
    if (waitFor) {
      const probe = waitFor.carry + t
      parts.push(t)
      if (!probe.includes('DSML') && !normTokens(probe).includes(waitFor.close)) {
        waitFor.carry = probe.slice(-waitFor.close.length)
        return { text: '', calls: [], dropped: [] }
      }
    } else parts.push(t)
    return drain(false)
  }

  let lastChar = '' // last character given out as text
  function drain(final) {
    const out = drain1(final)
    if (out.text) lastChar = out.text.slice(-1)
    return out
  }

  function drain1(final) {
    const out = { text: '', calls: [], dropped: [] }
    if (parts.length) buf += parts.join('')
    parts = []
    if (buf.includes('DSML')) {
      buf = buf.replace(DSML_RE, '$1')
      if (final) buf = buf.replace(DSML_PARTIAL, '')
    }
    waitFor = null
    for (;;) {
      const n = normTokens(buf)
      const st = findStart(n)
      if (!st) {
        const keep = final ? 0 : holdTail(n)
        out.text += buf.slice(0, buf.length - keep)
        buf = buf.slice(buf.length - keep)
        break
      }
      if (st.at > 0) {
        out.text += buf.slice(0, st.at)
        buf = buf.slice(st.at)
        continue
      }
      // buf starts with a (possible) call
      if (st.kind === 'junk') {
        const prev = out.text ? out.text.slice(-1) : lastChar
        if (prev === '' || prev === '\n') buf = buf.slice(st.token.length)
        else {
          out.text += buf.slice(0, st.token.length)
          buf = buf.slice(st.token.length)
        }
        continue
      }
      if (st.kind === 'ds') {
        if (st.token === DS_CALLS_END || st.token === DS_CALL_END) {
          buf = buf.slice(st.token.length) // stray closer
          continue
        }
        const end = st.token === DS_CALLS_BEGIN ? DS_CALLS_END : DS_CALL_END
        const inner0 = st.token === DS_CALLS_BEGIN ? st.token.length : 0
        const e = n.indexOf(end, st.token.length)
        if (e < 0 && !final) {
          waitFor = { close: end, carry: buf.slice(-end.length) }
          break
        }
        const inner = (e < 0 ? n.slice(inner0) : n.slice(inner0, e)).replace(DS_CALLS_END, '')
        const parsed = parseDeepSeek(inner, e >= 0)
        if (e >= 0 ? parsed.calls.length : usableAtEnd(parsed)) finish(parsed, out)
        else out.dropped.push({ name: parsed.name, reason: parsed.bad ?? 'incomplete' })
        buf = e < 0 ? '' : buf.slice(e + end.length)
        continue
      }
      if (st.kind === 'fence') {
        const r = fenceBlock(n, final)
        if (r === 'wait') break
        if (r.text != null) {
          out.text += buf.slice(0, r.len)
        } else finish(r.parsed, out)
        buf = buf.slice(r.len)
        continue
      }
      // word tag
      const gt = n.indexOf('>')
      if (gt < 0) {
        if (!final) break
        // ended inside the opening tag itself
        const name = attr(buf, ['name', 'tool', 'tool_name'])
        if (st.tag === 'tool_call_call' || name) out.dropped.push({ name, reason: 'cut off in the opening tag' })
        else out.text += buf
        buf = ''
        break
      }
      const head = buf.slice(0, gt + 1) // original text (normalizing is only for finding tokens)
      const selfClosing = /\/\s*>$/.test(head)
      const close = `</${st.tag}>`
      const e = selfClosing ? gt + 1 : n.indexOf(close, gt + 1)
      if (e < 0 && !final) {
        waitFor = { close, carry: buf.slice(-close.length) }
        break
      }
      const complete = e >= 0
      const inner = selfClosing ? '' : complete ? buf.slice(gt + 1, e) : buf.slice(gt + 1)
      const len = selfClosing ? gt + 1 : complete ? e + close.length : n.length
      const parsed = parseWordBlock(st.tag, head, inner, complete, tools)
      const ours = st.tag === 'tool_call_call'
      const known = parsed.calls.length > 0 && (ours || !tools.length || parsed.calls.every((c) => resolveToolName(c.name, tools)))
      if (complete && known) finish(parsed, out)
      else if (!complete && usableAtEnd(parsed)) finish(parsed, out)
      else if (complete && !ours && !parsed.calls.length && parsed.bad === 'no tool name') out.text += buf.slice(0, len) // e.g. prose about <invoke>
      else if (complete && !known && parsed.calls.length) out.text += buf.slice(0, len) // not one of the tools: leave as text
      else if (complete && ours) out.dropped.push({ name: parsed.name, reason: parsed.bad ?? 'unparseable' })
      else if (!complete && (ours || parsed.name || parsed.calls.length || attr(head, ['name']))) out.dropped.push({ name: parsed.name ?? parsed.calls[0]?.name ?? attr(head, ['name']), reason: parsed.bad ?? 'unknown tool' })
      else out.text += buf.slice(0, len)
      buf = buf.slice(len)
    }
    return out
  }

  // ```json fence at the start of n: 'wait', {text, len} (not a call) or {parsed, len}
  function fenceBlock(n, final) {
    const nl = n.indexOf('\n', 3)
    if (nl < 0) {
      if (!final && /^```[\w-]*$/.test(n)) return 'wait'
      return { text: true, len: 3 }
    }
    const info = n.slice(3, nl).trim()
    if (info && !/^(json|json5|tool_call|tool|function_call|javascript|js)?$/i.test(info)) return { text: true, len: 3 }
    const rest = n.slice(nl + 1)
    const first = rest.trimStart()[0]
    if (first == null) return final ? { text: true, len: n.length } : 'wait'
    if (first !== '{' && first !== '[') return { text: true, len: 3 }
    const c = rest.indexOf('```')
    if (c < 0 && !final) return 'wait'
    const body = c < 0 ? rest : rest.slice(0, c)
    const len = c < 0 ? n.length : nl + 1 + c + 3
    const r = parseJsonLoose(body, false)
    const list = r.ok ? (Array.isArray(r.value) ? r.value : [r.value]) : []
    const calls = list.map(callFromJson)
    if (calls.length && calls.every((x) => x && resolveToolName(x.name, tools) && x.args && typeof x.args === 'object')) return { parsed: { calls }, len }
    return { text: true, len }
  }

  return { push, end: () => drain(true) }
}

/** Short visible note for calls that could not be recovered. */
export function droppedNote(dropped) {
  if (!dropped?.length) return ''
  const names = [...new Set(dropped.map((d) => d.name).filter(Boolean))]
  return `\n\n[comate: the model's tool call${names.length ? ` (${names.join(', ')})` : ''} was cut off before it was complete and was not run. Ask it to continue or retry.]`
}
