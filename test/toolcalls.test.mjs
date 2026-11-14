import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createToolCallSplitter, resolveToolName } from '../lib/toolcalls.mjs'
import { handleChatCompletions } from '../lib/handler.mjs'
import { createBackend, ev, LICENSE, readSSE } from './mock.mjs'

const P = (props, req = []) => ({ type: 'object', properties: props, required: req })
// pi coding agent's tools
const PI = [
  { name: 'read', parameters: P({ path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } }, ['path']) },
  { name: 'bash', parameters: P({ command: { type: 'string' }, timeout: { type: 'number' } }, ['command']) },
  { name: 'edit', parameters: P({ path: { type: 'string' }, oldText: { type: 'string' }, newText: { type: 'string' } }, ['path', 'oldText', 'newText']) },
  { name: 'write', parameters: P({ path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']) },
]

/** Feed `full` in chunks of every size 1..max; assert each run gives the same result. */
function split(full, { tools = PI, max = 9 } = {}) {
  let first
  for (let size = 1; size <= max; size++) {
    const s = createToolCallSplitter({ tools })
    const out = { text: '', calls: [], dropped: [] }
    const add = (r) => {
      out.text += r.text
      out.calls.push(...r.calls)
      out.dropped.push(...r.dropped)
    }
    for (let i = 0; i < full.length; i += size) add(s.push(full.slice(i, i + size)))
    add(s.end())
    out.calls = out.calls.map((c) => ({ ...c, id: /^call_[0-9a-z]+_\d+$/.test(c.id) ? '<gen>' : c.id, arguments: JSON.parse(c.arguments) }))
    if (first) assert.deepEqual(out, first, `chunk size ${size}`)
    else first = out
  }
  return first
}

const LEAK = '确认隐藏头像/校徽时的样式类与序列化处理。\n\n <tool_call_call id="call_00_grep_css" name="bash">'

test('regression: the exact leaked snippet never shows the tag; it is reported as dropped', () => {
  const r = split(LEAK)
  assert.equal(r.text, '确认隐藏头像/校徽时的样式类与序列化处理。\n\n ')
  assert.doesNotMatch(r.text, /tool_call/)
  assert.deepEqual(r.calls, [])
  assert.deepEqual(r.dropped, [{ name: 'bash', reason: 'no arguments' }])
})

test('regression: same snippet with English narration first, ended mid-arguments, is salvaged', () => {
  const full = 'Let me grep CSS for these class names.\n\n' + LEAK + '\n<arguments>\n{"command": "grep -rn \\"hide-avatar\\" src'
  const r = split(full)
  assert.equal(r.text, 'Let me grep CSS for these class names.\n\n确认隐藏头像/校徽时的样式类与序列化处理。\n\n ')
  assert.deepEqual(r.calls, [{ id: 'call_00_grep_css', name: 'bash', arguments: { command: 'grep -rn "hide-avatar" src' } }])
  assert.deepEqual(r.dropped, [])
})

test('unclosed call ended after </arguments> or inside the closing tags is emitted', () => {
  for (const end of ['</arguments>', '</arguments>\n</tool_call_c', '</argu', '\n']) {
    const r = split('<tool_call_call id="c" name="read">\n<arguments>\n{"path":"a.txt"}\n' + end)
    assert.deepEqual(r.calls, [{ id: 'c', name: 'read', arguments: { path: 'a.txt' } }], end)
    assert.equal(r.text, '', end)
  }
})

test('unclosed tag cut inside the opening tag is dropped, not shown', () => {
  const r = split('看一下 <tool_call_call id="call_1" name="ba')
  assert.equal(r.text, '看一下 ')
  assert.equal(r.calls.length, 0)
  assert.equal(r.dropped.length, 1)
})

test('unclosed call whose JSON body (no <arguments>) is complete is still emitted', () => {
  const r = split('<tool_call_call id="call_1" name="bash">\n{"command":"ls"}\n')
  assert.deepEqual(r.calls, [{ id: 'call_1', name: 'bash', arguments: { command: 'ls' } }])
})

test('unclosed call missing a required parameter is dropped', () => {
  const r = split('<tool_call_call id="c" name="edit"><arguments>{"path":"a.txt"}</arguments>')
  assert.deepEqual(r.calls, [])
  assert.equal(r.dropped[0].name, 'edit')
})

test('variants: tag names, attributes, JSON body, child params', () => {
  const cases = [
    ['<tool_call_call id="a" name="bash"><arguments>{"command":"ls"}</arguments></tool_call_call>', 'a'],
    ['<tool_call name="bash">{"command":"ls"}</tool_call>', '<gen>'],
    ['<tool_call>\n{"name": "bash", "arguments": {"command": "ls"}}\n</tool_call>', '<gen>'],
    ['<function_call id="b" name="bash"><parameters>{"command":"ls"}</parameters></function_call>', 'b'],
    ['<invoke name="bash"><parameter name="command">ls</parameter></invoke>', '<gen>'],
    ['<function_calls>\n<invoke name="bash">\n<parameter name="command">ls</parameter>\n</invoke>\n</function_calls>', '<gen>'],
    ['<tool_call_call id="c" name="bash">\n```json\n{"command":"ls"}\n```\n</tool_call_call>', 'c'],
    ['<tool_call_call name="bash"><name>bash</name><arguments>{"command":"ls"}</arguments></tool_call_call>', '<gen>'],
    ['```json\n{"name": "bash", "arguments": {"command": "ls"}}\n```', '<gen>'],
    ['<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>bash<｜tool▁sep｜>{"command":"ls"}<｜tool▁call▁end｜><｜tool▁calls▁end｜>', '<gen>'],
    ['<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>bash\n```json\n{"command":"ls"}\n```<｜tool▁call▁end｜><｜tool▁calls▁end｜>', '<gen>'],
    ['<|tool_call_begin|>bash<|tool_sep|>{"command":"ls"}<|tool_call_end|>', '<gen>'],
  ]
  for (const [block, id] of cases) {
    const r = split(`前文 ${block} 后文`)
    assert.equal(r.text, '前文  后文', block)
    assert.deepEqual(r.calls, [{ id, name: 'bash', arguments: { command: 'ls' } }], block)
    assert.deepEqual(r.dropped, [], block)
  }
})

test('special characters inside arguments are kept as written', () => {
  const r = split('<tool_call_call id="a" name="bash"><arguments>{"command":"echo ▁｜ok｜"}</arguments></tool_call_call>')
  assert.deepEqual(r.calls[0].arguments, { command: 'echo ▁｜ok｜' })
  assert.equal(split('prose ending in <invoke').text, 'prose ending in <invoke')
})

test('parameter children keep strings for string params and parse numbers', () => {
  const r = split('<invoke name="read"><parameter name="path">a.txt</parameter><parameter name="limit">20</parameter></invoke>')
  assert.deepEqual(r.calls[0].arguments, { path: 'a.txt', limit: 20 })
})

test('several calls in one wrapper, and two plain blocks back to back', () => {
  const r = split('<function_calls><invoke name="read"><parameter name="path">a</parameter></invoke><invoke name="read"><parameter name="path">b</parameter></invoke></function_calls>')
  assert.deepEqual(r.calls.map((c) => c.arguments.path), ['a', 'b'])
  const r2 = split('<tool_call_call id="1" name="read"><arguments>{"path":"a"}</arguments></tool_call_call>\n<tool_call_call id="2" name="read"><arguments>{"path":"b"}</arguments></tool_call_call>')
  assert.deepEqual(r2.calls.map((c) => c.id), ['1', '2'])
  assert.equal(r2.text, '\n')
})

test('stray </user-input> echoed after a tool block (seen live) is removed', () => {
  const r = split('三个文件有相关引用。\n\n<tool_call_call id="call_2" name="read">\n<arguments>\n{"path":"a"}\n</arguments>\n</tool_call_call>\n</user-input>')
  assert.equal(r.text, '三个文件有相关引用。\n\n\n')
  assert.equal(r.calls.length, 1)
  assert.equal(split('我先搜索。\n\n\n</tool_result>').text, '我先搜索。\n\n\n')
  // inside a line it is kept
  assert.equal(split('close it with </tool_result> here').text, 'close it with </tool_result> here')
})

test('DeepSeek V4 DSML tool markup is parsed, and its garbled leftovers (seen live) are removed', () => {
  const dsml = '好。\n<｜DSML｜function_calls>\n<｜DSML｜invoke name="bash">\n<｜DSML｜parameter name="command" string="true">ls -la</｜DSML｜parameter>\n<｜DSML｜parameter name="timeout" string="false">60</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜function_calls>'
  const r = split(dsml)
  assert.equal(r.text, '好。\n')
  assert.deepEqual(r.calls, [{ id: '<gen>', name: 'bash', arguments: { command: 'ls -la', timeout: 60 } }])
  // live: '…</tool_call_call>\n</｜｜DSML｜｜ calls>' after two good blocks
  const live = '我先浏览项目结构。\n\n<tool_call_call id="call_1" name="bash">\n<arguments>\n{"command": "ls"}\n</arguments>\n</tool_call_call>\n</｜｜DSML｜｜ calls>'
  const r2 = split(live)
  assert.equal(r2.text, '我先浏览项目结构。\n\n\n')
  assert.equal(r2.calls.length, 1)
})

test('ordinary text, code and prose about tags stay text', () => {
  const t = 'if (a < b && c > d) {}\n```js\nconst x = `<b>` + "```"\n```\nUse <invoke> in prose, and ```json\n{"a": 1}\n``` is data. a <tool_c'
  const r = split(t)
  assert.equal(r.text, t)
  assert.deepEqual(r.calls, [])
  assert.deepEqual(r.dropped, [])
})

test('a JSON fence calling an undeclared tool stays text; a variant tag with an unknown tool stays text', () => {
  const t = '```json\n{"name": "deploy", "arguments": {}}\n```\n<tool_call name="deploy">{}</tool_call>'
  assert.equal(split(t).text, t)
})

test('our own tag with an unknown name is still passed on (the caller reports the error)', () => {
  const r = split('<tool_call_call id="x" name="grep"><arguments>{"q":"a"}</arguments></tool_call_call>')
  assert.deepEqual(r.calls, [{ id: 'x', name: 'grep', arguments: { q: 'a' } }])
})

test('tool names: exact, case-insensitive, punctuation, alias — only when unambiguous', () => {
  assert.equal(resolveToolName('Bash', PI).name, 'bash')
  assert.equal(resolveToolName('READ', PI).name, 'read')
  assert.equal(resolveToolName('run_command', PI).name, 'bash')
  assert.equal(resolveToolName('read_file', PI).name, 'read')
  assert.equal(resolveToolName('str_replace', PI).name, 'edit')
  assert.equal(resolveToolName('nope', PI), undefined)
  // ambiguous: two tools differ only in case, or two tools in one alias group
  assert.equal(resolveToolName('bash', [{ name: 'Bash' }, { name: 'BASH' }]), undefined)
  assert.equal(resolveToolName('shell', [{ name: 'bash' }, { name: 'run_command' }]), undefined)
  const r = split('<invoke name="Run_Command"><parameter name="command">ls</parameter></invoke>')
  assert.equal(r.calls[0].name, 'bash')
})

test('unclosed DeepSeek block at end: emitted if parseable, else dropped', () => {
  const ok = split('<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>bash<｜tool▁sep｜>{"command":"ls"}')
  assert.deepEqual(ok.calls, [{ id: '<gen>', name: 'bash', arguments: { command: 'ls' } }])
  const bad = split('x<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>bash')
  assert.equal(bad.text, 'x')
  assert.equal(bad.calls.length, 0)
  assert.equal(bad.dropped.length, 1)
})

// --- handler: retry once on the same session, then a short note ---
const piTools = PI.map((t) => ({ type: 'function', function: { name: t.name, description: t.name, parameters: t.parameters } }))
const MODEL = 'deepseek-v4-flash_11111111111111111111111111111111'
const chunks = (s, n = 4) => (s.match(new RegExp(`[\\s\\S]{1,${n}}`, 'g')) ?? []).map((d) => ev.text(d))

test('handler: cut-off call is asked for again once and the retried call goes out; the tag never shows', async () => {
  const good = '<tool_call_call id="call_01" name="bash">\n<arguments>\n{"command":"grep -rn hide-avatar src"}\n</arguments>\n</tool_call_call>'
  const b = createBackend({ executes: [[...chunks(LEAK), ev.text('', true)], [...chunks(good), ev.text('', true)]] })
  const res = await handleChatCompletions({ body: { model: MODEL, stream: true, tools: piTools, messages: [{ role: 'user', content: '查一下' }] }, license: LICENSE, fetchImpl: b.fetch })
  const out = (await readSSE(res)).slice(0, -1)
  const text = out.map((c) => c.choices[0]?.delta?.content ?? '').join('')
  assert.doesNotMatch(text, /tool_call|<|comate:/)
  const tc = out.flatMap((c) => c.choices[0]?.delta?.tool_calls ?? [])
  assert.deepEqual(tc.map((t) => [t.id, t.function.name, t.function.arguments]), [['call_01', 'bash', '{"command":"grep -rn hide-avatar src"}']])
  assert.equal(out.at(-1).choices[0].finish_reason, 'tool_calls')
  const ex = b.executeCalls()
  assert.equal(ex.length, 2)
  assert.match(JSON.stringify(ex[1].body), /cut off/)
})

test('handler: if the retry is cut off too, a short note replaces the half tag', async () => {
  const b = createBackend({ executes: [[...chunks(LEAK), ev.text('', true)], [...chunks('<tool_call_call id="c" name="bash">'), ev.text('', true)]] })
  const res = await handleChatCompletions({ body: { model: MODEL, tools: piTools, messages: [{ role: 'user', content: '查一下' }] }, license: LICENSE, fetchImpl: b.fetch })
  const j = await res.json()
  const m = j.choices[0].message
  assert.doesNotMatch(m.content, /<tool_call/)
  assert.match(m.content, /^确认隐藏头像/)
  assert.match(m.content, /\[comate: .*bash.* cut off/)
  assert.equal(m.tool_calls, undefined)
  assert.equal(j.choices[0].finish_reason, 'stop')
  assert.equal(b.executeCalls().length, 2)
})
