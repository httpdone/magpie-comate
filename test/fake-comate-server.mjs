#!/usr/bin/env node
// A local stand-in for comate.baidu.com, for trying the plugin inside a sandboxed magpie:
//   node test/fake-comate-server.mjs 18080
//   magpie plugin options comate '{"host":"http://127.0.0.1:18080"}'
//   magpie plugin login comate      # opens the license page; paste LIC-test-0123456789abcdef
//   magpie provider test comate
import { createServer } from 'node:http'
import { createBackend, ev } from './mock.mjs'

const port = Number(process.argv[2] || 18080)
const script = () => [ev.reason('thinking…'), ev.text('pong from fake Comate'), ev.usage(12, 4), ev.text('', true)]
createServer(async (req, res) => {
  let raw = ''
  for await (const c of req) raw += c
  // with tools offered, answer with one XML tool call (unless tool results are already in the query)
  let parsed = {}
  try { parsed = JSON.parse(raw || '{}') } catch {}
  const wantsTool = /\[Tool 1\] (\S+)/.exec(parsed.systemReminder || '')
  const toolScript = wantsTool && !/<tool_result/.test(parsed.query || '')
    ? [ev.text('Calling a tool. '), ev.text(`<tool_call_call id="call_fake1" name="${wantsTool[1]}">\n<arguments>\n{}\n</arguments>\n</tool_call_call>`), ev.text('', true)]
    : null
  const backend = createBackend({ executes: [toolScript ?? script()] })
  const out = await backend.fetch(`http://x${req.url}`, { method: req.method, headers: req.headers, body: raw || undefined })
  const c = backend.calls[0]
  console.error(`${req.method} ${c.path.replace(/^\/api\/key\/valid\/.*/, '/api/key/valid/***')} login-name=${c.headers['login-name'] ? 'set' : 'missing'}${c.body?.modelKey ? ' model=' + c.body.modelKey : ''}${c.body && 'thinkingEnabled' in c.body ? ' thinking=' + c.body.thinkingEnabled : ''}${c.body && 'effort' in c.body ? ' effort=' + c.body.effort : ''}${c.body?.query ? ' query=' + JSON.stringify(c.body.query.slice(0, 60)) : ''}`)
  res.writeHead(out.status, Object.fromEntries(out.headers))
  for await (const chunk of out.body) res.write(chunk)
  res.end()
}).listen(port, '127.0.0.1', () => console.error(`fake comate on http://127.0.0.1:${port}`))
