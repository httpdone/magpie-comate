// Comate conversation reuse.
//
// The official clients keep one Comate conversation+task per chat and, for every later
// turn, send only the new user query (plus the results of the last tool turn) with the
// same conversationId/taskId and isFirstQuery unset: the server keeps the history.
// OpenAI-style callers resend the whole history instead, so we recognise a request as the
// continuation of one we answered by hashing its messages:
//
//   key = H(scope, m1, …, mk, our reply)     scope = H(license) + system prompt + tool schemas
//
// A later request whose messages start with exactly that prefix continues that Comate
// task with only the messages after it. Anything else (edited/branched history, changed
// system prompt or tools, expired or evicted entry) starts a fresh conversation.
// Entries are claimed (removed) when used, so a retry of the same request never replays
// a turn the server already has. Memory only; the license is kept only as a hash.
import { createHash } from 'node:crypto'
import { textOf } from './translate.mjs'

export const SESSION_DEFAULTS = Object.freeze({ ttlMs: 30 * 60 * 1000, max: 200 })

const sha = (s) => createHash('sha256').update(s).digest('hex')
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()

/** Canonical form of one message, tolerant to what clients/gateways change on the way back. */
export function canonMessage(m) {
  if (!m) return ''
  if (m.role === 'assistant') {
    // ids + names only: arguments get re-serialised by gateways; reasoning is often dropped
    const calls = (m.tool_calls || []).map((c) => `${c.id}:${c.function?.name ?? ''}`).join(',')
    return `assistant|${norm(textOf(m.content))}|${calls}`
  }
  if (m.role === 'tool') return `tool|${m.tool_call_id ?? ''}|${norm(textOf(m.content))}`
  if (m.role === 'function') return `function|${m.name ?? ''}|${norm(textOf(m.content))}`
  return `${m.role}|${norm(textOf(m.content))}`
}

/** Assistant message as we answered it (text we emitted, tool calls we emitted). */
export function replyMessage(text, calls) {
  return { role: 'assistant', content: text, tool_calls: calls.map((c) => ({ id: c.id, function: { name: c.name } })) }
}

export function sessionScope(license, systemText, tools) {
  return sha(`${sha(`comate-license:${license}`)}|${sha(norm(systemText))}|${sha(JSON.stringify(tools ?? []))}`)
}

/** h[k] = hash of the first k messages under scope (h[0] = scope). */
export function chainHashes(scope, messages) {
  const h = [scope]
  for (const m of messages) h.push(sha(`${h[h.length - 1]}\n${canonMessage(m)}`))
  return h
}

export const extendHash = (prev, m) => sha(`${prev}\n${canonMessage(m)}`)

export function createSessionStore({ ttlMs = SESSION_DEFAULTS.ttlMs, max = SESSION_DEFAULTS.max, now = () => Date.now() } = {}) {
  const map = new Map() // key → {entry, at}; insertion order = LRU order
  const live = (key) => {
    const v = map.get(key)
    if (!v) return undefined
    if (now() - v.at > ttlMs) {
      map.delete(key)
      return undefined
    }
    return v
  }
  return {
    has: (key) => !!live(key),
    /** Remove and return a live entry. */
    take(key) {
      const v = live(key)
      if (!v) return undefined
      map.delete(key)
      return v.entry
    },
    set(key, entry) {
      map.delete(key)
      map.set(key, { entry, at: now() })
      while (map.size > max) map.delete(map.keys().next().value)
    },
    get size() {
      return map.size
    },
    clear: () => map.clear(),
  }
}

/**
 * Find the newest cached state that the conversation extends.
 * @returns {{index:number, entry:object, delta:Array}|undefined}  delta = messages after the cached prefix
 */
export function findContinuation(store, hashes, convo) {
  for (let i = convo.length - 1; i >= 1; i--) {
    if (convo[i - 1]?.role !== 'assistant') continue
    if (!store.has(hashes[i])) continue
    const delta = convo.slice(i)
    // only new user turns / tool results can be appended to the server-side history
    if (!delta.length || delta.some((m) => m.role !== 'user' && m.role !== 'tool' && m.role !== 'function')) return undefined
    const entry = store.take(hashes[i])
    return entry ? { index: i, entry, delta } : undefined
  }
  return undefined
}

/**
 * Turn the new messages into one Comate turn on the existing task.
 * Results of Comate-native calls we passed through go back as toolUseResults (as the
 * official client does); results of our XML calls and new user text go in the query.
 */
export function buildDelta(delta, pendingNative = {}, callNames = {}, carryResults = []) {
  // results we answered ourselves last turn (rejected/internal native calls) ride along
  const toolUseResults = [...(carryResults ?? [])]
  const lines = []
  let userText = ''
  for (const m of delta) {
    const text = textOf(m.content)
    if (m.role === 'tool' && pendingNative[m.tool_call_id]) {
      const p = pendingNative[m.tool_call_id]
      toolUseResults.push({ id: m.tool_call_id, name: p.name, success: true, params: p.params ?? {}, message: text })
    } else if (m.role === 'tool' || m.role === 'function') {
      lines.push(`<tool_result id="${m.tool_call_id ?? ''}" name="${m.name || callNames[m.tool_call_id] || ''}">\n${text}\n</tool_result>`)
    } else if (m.role === 'user') {
      userText += (userText ? '\n\n' : '') + text
    }
  }
  if (!lines.length && !userText) return { query: '', toolUseResults, isUserQuery: false }
  const query = [lines.join('\n'), userText || (lines.length ? 'Continue: use the tool results above to proceed with the task.' : '')].filter(Boolean).join('\n\n')
  return { query, toolUseResults, isUserQuery: true }
}
