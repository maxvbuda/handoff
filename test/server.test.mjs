// End-to-end tests for server/handoff.mjs against a mock ntfy relay.
// Run: node --test test/
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { startMock } from './mock-ntfy.mjs'
import { startRelay } from '../server/relay-server.mjs'

const SERVER = new URL('../server/handoff.mjs', import.meta.url).pathname
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ---- the watch side, mirroring App.swift (CryptoKit AES.GCM combined, base64) ----
function seal(obj, key) {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([c.update(typeof obj === 'string' ? obj : JSON.stringify(obj)), c.final()])
  return Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64')
}
function openBox(b64, key) {
  const b = Buffer.from(b64, 'base64')
  const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12))
  d.setAuthTag(b.subarray(-16))
  return JSON.parse(Buffer.concat([d.update(b.subarray(12, -16)), d.final()]).toString())
}
const post = (url, body) => fetch(url, { method: 'POST', body }).then(r => r.json())
const note = (text, extra = {}) => ({ id: crypto.randomUUID().toUpperCase(), t: text, ts: new Date().toISOString(), ...extra })

let mock
const spawned = new Set()
before(async () => { mock = await startMock({ keepaliveMs: 300 }) })
after(() => { for (const p of spawned) p.kill(); return mock.close() })

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cwn-')) }
function pairDir(dir, topic = `cw-${crypto.randomBytes(16).toString('hex')}`) {
  const key = crypto.randomBytes(32)
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ topicURL: `${mock.url}/${topic}`, key: key.toString('base64') }))
  return { key, topicURL: `${mock.url}/${topic}`, topic }
}

/** Spawns the MCP server; collects JSON-RPC output. */
function startServer(dir, { init = true, env = {} } = {}) {
  const p = spawn(process.execPath, [SERVER], {
    env: { ...process.env, CLAUDE_WATCH_NOTES_DIR: dir, CLAUDE_WATCH_NOTES_RELAY: mock.url, CLAUDE_WATCH_NOTES_IDLE_MS: '1500', CLAUDE_WATCH_NOTES_CHANNEL: '1', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  spawned.add(p)
  const msgs = []
  let stderr = ''
  let buf = ''
  p.stdout.on('data', d => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) { msgs.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1) }
  })
  p.stderr.on('data', d => { stderr += d })
  let nextId = 100
  const s = {
    p, msgs,
    get stderr() { return stderr },
    send(m) { p.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n') },
    raw(text) { p.stdin.write(text) },
    async waitFor(pred, ms = 5000, what = 'message') {
      const end = Date.now() + ms
      while (Date.now() < end) {
        const m = msgs.find(pred)
        if (m) return m
        await sleep(25)
      }
      throw new Error(`timed out waiting for ${what}\nstdout: ${JSON.stringify(msgs)}\nstderr: ${stderr}`)
    },
    async request(method, params) {
      const id = nextId++
      s.send({ id, method, params })
      return s.waitFor(m => m.id === id, 5000, method)
    },
    pushes() { return msgs.filter(m => m.method === 'notifications/claude/channel') },
    async init() {
      const r = await s.request('initialize', { protocolVersion: '2025-06-18' })
      s.send({ method: 'notifications/initialized' })
      return r
    },
    async stop() { p.stdin.end(); await new Promise(r => p.exitCode !== null ? r() : p.on('exit', r)) },
  }
  if (init) s.ready = s.init()
  return s
}

async function connected(topic, n = 1) {
  const end = Date.now() + 5000
  while (mock.streamCount(topic) < n) {
    if (Date.now() > end) throw new Error('server never subscribed')
    await sleep(20)
  }
}
const pushFor = id => m => m.method === 'notifications/claude/channel' && m.params.meta.note_id === id

describe('MCP protocol', () => {
  let dir, s
  before(async () => { dir = tmpDir(); pairDir(dir); s = startServer(dir, { init: false }) })
  after(() => s.stop())

  test('initialize declares the channel capability and instructions', async () => {
    const r = await s.request('initialize', { protocolVersion: '2025-03-26' })
    assert.equal(r.result.protocolVersion, '2025-03-26')
    assert.deepEqual(r.result.capabilities.experimental, { 'claude/channel': {}, 'claude/channel/permission': {} })
    assert.ok(r.result.capabilities.tools)
    assert.match(r.result.instructions, /watch_note_done/)
    assert.match(r.result.instructions, /blocked/)
    s.send({ method: 'notifications/initialized' })
  })

  test('tools/list exposes inbox, done and ask', async () => {
    const r = await s.request('tools/list')
    assert.deepEqual(r.result.tools.map(t => t.name).sort(), ['watch_ask', 'watch_inbox', 'watch_note_done'])
  })

  test('ping', async () => assert.deepEqual((await s.request('ping')).result, {}))

  test('unknown method -> -32601', async () => assert.equal((await s.request('resources/list')).error.code, -32601))

  test('malformed JSON is ignored and the server keeps working', async () => {
    s.raw('{not json\n\n   \n')
    assert.deepEqual((await s.request('ping')).result, {})
    assert.match(s.stderr, /bad message/)
  })

  test('messages split across writes and batched in one write', async () => {
    const line = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
    s.raw(line.slice(0, 10)); await sleep(30); s.raw(line.slice(10) + '\n' + JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }) + '\n')
    await s.waitFor(m => m.id === 1); await s.waitFor(m => m.id === 2)
  })

  test('unknown tool -> isError', async () => {
    const r = await s.request('tools/call', { name: 'nope', arguments: {} })
    assert.equal(r.result.isError, true)
  })

  test('watch_note_done with unknown or hostile id is a clean error and touches nothing', async () => {
    const before = fs.readFileSync(path.join(dir, 'config.json'), 'utf8')
    for (const note_id of ['missing', '../config', '../../etc/passwd', '']) {
      const r = await s.request('tools/call', { name: 'watch_note_done', arguments: { note_id, summary: 'x' } })
      assert.equal(r.result.isError, true, note_id)
      assert.match(r.result.content[0].text, /No watch note/)
    }
    assert.equal(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), before)
  })

  test('watch_inbox when empty', async () => {
    const r = await s.request('tools/call', { name: 'watch_inbox', arguments: {} })
    assert.equal(r.result.content[0].text, 'No pending watch notes.')
  })
})

describe('delivery', () => {
  let dir, s, cfg
  before(async () => { dir = tmpDir(); cfg = pairDir(dir); s = startServer(dir); await s.ready; await connected(cfg.topic) })
  after(() => s.stop())

  test('an encrypted note is pushed into the session and saved', async () => {
    const n = note('Add dark mode to settings\nuse system colors')
    await post(cfg.topicURL, seal(n, cfg.key))
    const m = await s.waitFor(pushFor(n.id))
    assert.equal(m.params.content, n.t)
    assert.equal(m.params.meta.at, n.ts)
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'notes', `${n.id}.json`), 'utf8'))
    assert.equal(saved.status, 'sent')
  })

  test('unicode, emoji, quotes and newlines survive', async () => {
    const n = note('café ☕️ "quotes" \'single\' <tag> & \\ backslash\n日本語 🚀\n\n  indented')
    await post(cfg.topicURL, seal(n, cfg.key))
    assert.equal((await s.waitFor(pushFor(n.id))).params.content, n.t)
  })

  test('long notes (relay turns them into attachments) are still delivered', async () => {
    const n = note('long idea '.repeat(900)) // ~9 KB plaintext -> attachment
    const ev = await post(cfg.topicURL, seal(n, cfg.key))
    assert.ok(ev.attachment, 'mock should have turned this into an attachment')
    assert.equal((await s.waitFor(pushFor(n.id))).params.content, n.t)
  })

  test('the same note retried by the watch is delivered once', async () => {
    const n = note('retry me')
    await post(cfg.topicURL, seal(n, cfg.key))
    await post(cfg.topicURL, seal(n, cfg.key)) // fresh nonce, same note id
    await s.waitFor(pushFor(n.id))
    await sleep(300)
    assert.equal(s.pushes().filter(pushFor(n.id)).length, 1)
  })

  test('anything not sealed with our key is dropped without crashing', async () => {
    const before = s.pushes().length
    const evil = note('rm -rf ~')
    await post(cfg.topicURL, 'plain text injection attempt')
    await post(cfg.topicURL, seal(evil, crypto.randomBytes(32)))        // wrong key
    await post(cfg.topicURL, seal(evil, cfg.key).slice(0, 30))         // truncated
    await post(cfg.topicURL, Buffer.from('x'.repeat(5000)).toString()) // junk attachment
    await post(cfg.topicURL, seal('not json at all', cfg.key))        // right key, bad payload
    const ok = note('after the junk')
    await post(cfg.topicURL, seal(ok, cfg.key))
    await s.waitFor(pushFor(ok.id))
    assert.equal(s.pushes().length, before + 1)
    assert.equal(fs.existsSync(path.join(dir, 'notes', `${evil.id}.json`)), false)
  })

  test('odd payload fields fall back sanely', async () => {
    const before = s.pushes().length
    await post(cfg.topicURL, seal({ t: 'no id, numeric ts', ts: 12345 }, cfg.key))
    await post(cfg.topicURL, seal({ id: '../../evil', t: 'traversal id' }, cfg.key))
    await s.waitFor(() => s.pushes().length === before + 2)
    const [a, b] = s.pushes().slice(-2)
    assert.ok(!isNaN(Date.parse(a.params.meta.at)))
    assert.equal(b.params.meta.note_id, 'evil')
    assert.ok(fs.existsSync(path.join(dir, 'notes', 'evil.json')))
    // inbox still renders with mixed notes
    const r = await s.request('tools/call', { name: 'watch_inbox', arguments: {} })
    assert.match(r.result.content[0].text, /traversal id/)
  })

  test('watch_inbox / watch_note_done round trip', async () => {
    const n = note('inbox me')
    await post(cfg.topicURL, seal(n, cfg.key))
    await s.waitFor(pushFor(n.id))
    let r = await s.request('tools/call', { name: 'watch_inbox', arguments: {} })
    assert.match(r.result.content[0].text, new RegExp(n.id))
    r = await s.request('tools/call', { name: 'watch_note_done', arguments: { note_id: n.id, summary: 'did it' } })
    assert.equal(r.result.isError, undefined)
    r = await s.request('tools/call', { name: 'watch_inbox', arguments: {} })
    assert.doesNotMatch(r.result.content[0].text, new RegExp(n.id))
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'notes', `${n.id}.json`), 'utf8'))
    assert.equal(saved.status, 'done'); assert.equal(saved.summary, 'did it'); assert.ok(saved.doneAt)
  })

  test('watch_note_done sends an encrypted suggestion to <topic>-s', async () => {
    const n = note('suggest me')
    await post(cfg.topicURL, seal(n, cfg.key))
    await s.waitFor(pushFor(n.id))
    const r = await s.request('tools/call', { name: 'watch_note_done', arguments: { note_id: n.id, summary: 'ok', suggestion: '  add tests for it  ' } })
    assert.match(r.result.content[0].text, /Suggestion sent/)
    const evs = await (await fetch(`${cfg.topicURL}-s/json?poll=1&since=all`)).text()
    const [ev] = evs.trim().split('\n').map(l => JSON.parse(l))
    assert.doesNotMatch(ev.message, /add tests/) // relay only sees ciphertext
    const got = openBox(ev.message, cfg.key)
    assert.equal(got.s, 'add tests for it'); assert.equal(got.note, n.id)
    assert.equal(typeof got.chat, 'string')
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'notes', `${n.id}.json`), 'utf8'))
    assert.equal(saved.suggestion, 'add tests for it')
  })

  test('watch_note_done sends an encrypted screenshot to <topic>-i, as a relay attachment', async () => {
    const n = note('make the button blue')
    await post(cfg.topicURL, seal(n, cfg.key))
    await s.waitFor(pushFor(n.id))
    const img = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(20_000)])
    const file = path.join(dir, 'shot.jpg')
    fs.writeFileSync(file, img)
    const r = await s.request('tools/call', { name: 'watch_note_done', arguments: { note_id: n.id, summary: 'ok', image: file } })
    assert.match(r.result.content[0].text, /Screenshot sent/)
    const [ev] = (await (await fetch(`${cfg.topicURL}-i/json?poll=1&since=all`)).text()).trim().split('\n').map(l => JSON.parse(l))
    assert.ok(ev.attachment) // too big for a message
    const got = openBox(await (await fetch(ev.attachment.url)).text(), cfg.key)
    assert.ok(Buffer.from(got.i, 'base64').equals(img)); assert.equal(got.note, n.id)
  })

  test('watch_note_done sends a full-quality GIF clip, much bigger than a screenshot may be', async () => {
    const n = note('gif')
    await post(cfg.topicURL, seal(n, cfg.key))
    await s.waitFor(pushFor(n.id))
    const gif = Buffer.concat([Buffer.from('GIF89a'), crypto.randomBytes(3_900_000)])
    const file = path.join(dir, 'clip.gif')
    fs.writeFileSync(file, gif)
    const r = await s.request('tools/call', { name: 'watch_note_done', arguments: { note_id: n.id, summary: 'ok', image: file } })
    assert.match(r.result.content[0].text, /Screenshot sent/)
    const ev = (await (await fetch(`${cfg.topicURL}-i/json?poll=1&since=all`)).text()).trim().split('\n').map(l => JSON.parse(l)).pop()
    assert.ok(ev.attachment.size < 8_000_000) // the watch downloads up to 8 MB (Store.maxDownload)
    assert.ok(Buffer.from(openBox(await (await fetch(ev.attachment.url)).text(), cfg.key).i, 'base64').equals(gif))
  })

  test('watch_note_done refuses a screenshot that is too big or not an image, and leaves the note open', async () => {
    const n = note('bad image')
    await post(cfg.topicURL, seal(n, cfg.key))
    await s.waitFor(pushFor(n.id))
    for (const [name, bytes, why] of [['big.png', Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(400_000)]), /under 300 KB/],
      ['big.gif', Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(4_300_000)]), /under 4 MB/],
      ['clip.mp4', Buffer.from('\0\0\0\x20ftypisom'), /isn't a PNG, JPEG or GIF/],
      ['notes.txt', Buffer.from('hello'), /isn't a PNG, JPEG or GIF/], ['missing.jpg', null, /Can't read/]]) {
      const file = path.join(dir, name)
      if (bytes) fs.writeFileSync(file, bytes)
      const r = await s.request('tools/call', { name: 'watch_note_done', arguments: { note_id: n.id, summary: 'ok', image: file } })
      assert.equal(r.result.isError, true); assert.match(r.result.content[0].text, why)
    }
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'notes', `${n.id}.json`), 'utf8')).status !== 'done', true)
  })

  test('a burst of 30 notes all arrive, in order', async () => {
    const ns = Array.from({ length: 30 }, (_, i) => note(`burst ${i}`))
    for (const n of ns) await post(cfg.topicURL, seal(n, cfg.key))
    for (const n of ns) await s.waitFor(pushFor(n.id))
    const order = s.pushes().filter(m => m.params.content.startsWith('burst ')).map(m => m.params.content)
    assert.deepEqual(order, ns.map(n => n.t))
  })
})

describe('approvals from the watch (permission relay)', () => {
  const ask = (s, request_id, extra = {}) => s.send({ method: 'notifications/claude/channel/permission_request',
    params: { request_id, tool_name: 'Bash', description: 'Run the tests', input_preview: '{"command": "npm test"}', ...extra } })
  const prompts = async cfg => (await (await fetch(`${cfg.topicURL}-p/json?poll=1&since=all`)).text())
    .trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
  const verdicts = s => s.msgs.filter(m => m.method === 'notifications/claude/channel/permission')

  test('a prompt reaches the watch sealed, and only the watch\'s answer to it, once, is applied', async () => {
    const dir = tmpDir(); const cfg = pairDir(dir)
    const s = startServer(dir, { env: { CLAUDE_WATCH_NOTES_NAME: 'website' } })
    await s.ready
    await connected(`${cfg.topic}-v`)
    ask(s, 'abcde')
    let evs = []
    const end = Date.now() + 5000
    while (!evs.length && Date.now() < end) { evs = await prompts(cfg); await sleep(50) }
    assert.doesNotMatch(evs[0].message, /npm test/) // relay only sees ciphertext
    const got = openBox(evs[0].message, cfg.key)
    assert.deepEqual([got.p, got.tool, got.what, got.input, got.chat], ['abcde', 'Bash', 'Run the tests', '{"command": "npm test"}', 'website'])

    const v = `${cfg.topicURL}-v`
    await post(v, seal({ v: 'abcde', ok: true }, crypto.randomBytes(32))) // not our watch
    await post(v, seal({ v: 'zzzzz', ok: true }, cfg.key)) // never asked
    await post(v, seal({ v: 'abcde', ok: true, chat: 'other chat' }, cfg.key)) // another chat's
    await post(v, seal({ v: 'abcde', ok: 'yes' }, cfg.key)) // not a verdict
    await post(v, seal({ v: 'abcde', ok: true, chat: 'website' }, cfg.key))
    await post(v, seal({ v: 'abcde', ok: false }, cfg.key)) // already answered
    await s.waitFor(m => m.method === 'notifications/claude/channel/permission', 5000, 'verdict')
    await sleep(300)
    assert.deepEqual(verdicts(s).map(m => m.params), [{ request_id: 'abcde', behavior: 'allow' }])

    ask(s, 'qwert'); await sleep(200)
    await post(v, seal({ v: 'qwert', ok: false }, cfg.key))
    await s.waitFor(m => m.params?.request_id === 'qwert', 5000, 'deny')
    assert.equal(verdicts(s).at(-1).params.behavior, 'deny')
    assert.equal(s.pushes().length, 0) // verdicts are never handed to Claude as notes
    await s.stop()
  })

  test('watch_ask: the question reaches the watch sealed, and the option tapped there is the answer', async () => {
    for (const channel of ['1', '']) { // a listening session, and a headless host chat's (which listens just for this)
      const dir = tmpDir(); const cfg = pairDir(dir)
      const s = startServer(dir, { env: { CLAUDE_WATCH_NOTES_NAME: 'website', CLAUDE_WATCH_NOTES_CHANNEL: channel } })
      await s.ready
      if (channel) await connected(`${cfg.topic}-v`)
      const id = 900 + Number(!!channel)
      s.send({ id, method: 'tools/call', params: { name: 'watch_ask', arguments: { question: 'Red or blue theme?', options: ['Red', 'Blue'] } } })
      let evs = []
      const end = Date.now() + 5000
      while (!evs.length && Date.now() < end) { evs = await prompts(cfg); await sleep(50) }
      const q = openBox(evs[0].message, cfg.key)
      assert.deepEqual([q.question, q.options, q.chat], ['Red or blue theme?', ['Red', 'Blue'], 'website'])
      assert.match(q.q, /^q[0-9a-f]{12}$/)
      await connected(`${cfg.topic}-v`)
      const v = `${cfg.topicURL}-v`
      await post(v, seal({ a: q.q, choice: 'Green' }, cfg.key)) // not one of the options
      await post(v, seal({ a: q.q, choice: 'Red' }, crypto.randomBytes(32))) // not our watch
      await post(v, seal({ a: q.q, choice: 'Blue' }, cfg.key))
      const r = await s.waitFor(m => m.id === id, 5000, 'answer')
      assert.equal(r.result.content[0].text, 'The user chose: Blue')
      await s.stop()
    }
  })

  test('watch_ask: no answer in time means Claude decides; a question needs 2 to 4 options', async () => {
    const dir = tmpDir(); pairDir(dir)
    const s = startServer(dir)
    await s.ready
    const r = await s.request('tools/call', { name: 'watch_ask', arguments: { question: 'Which?', options: ['A', 'B'], wait_minutes: 0.01 } })
    assert.match(r.result.content[0].text, /No answer from the watch.*Decide yourself/)
    const bad = await s.request('tools/call', { name: 'watch_ask', arguments: { question: 'Which?', options: ['A'] } })
    assert.equal(bad.result.isError, true)
    await s.stop()
  })

  test('Stop on the watch tells this chat to wrap up the note it is working on', async () => {
    const dir = tmpDir(); const cfg = pairDir(dir)
    const s = startServer(dir, { env: { CLAUDE_WATCH_NOTES_NAME: 'website' } })
    await s.ready
    await connected(cfg.topic); await connected(`${cfg.topic}-v`)
    const n = note('rebuild everything')
    await post(cfg.topicURL, seal(n, cfg.key))
    await s.waitFor(pushFor(n.id))
    const v = `${cfg.topicURL}-v`
    await post(v, seal({ stop: 'other chat', ts: new Date().toISOString() }, cfg.key)) // another chat's
    await post(v, seal({ stop: 'website', ts: new Date(Date.now() - 3_600_000).toISOString() }, cfg.key)) // old
    await post(v, seal({ stop: 'website', ts: new Date().toISOString() }, cfg.key))
    const stop = await s.waitFor(m => m.params?.meta?.source === 'stop', 5000, 'stop')
    assert.equal(stop.params.meta.note_id, n.id)
    assert.match(stop.params.content, /tapped Stop/)
    await sleep(300)
    assert.equal(s.pushes().filter(m => m.params.meta.source === 'stop').length, 1)
    await s.stop()
  })

  test('sessions that aren\'t listening don\'t offer approvals or forward prompts', async () => {
    const dir = tmpDir(); const cfg = pairDir(dir)
    const s = startServer(dir, { init: false, env: { CLAUDE_WATCH_NOTES_CHANNEL: '' } })
    const r = await s.init()
    assert.deepEqual(r.result.capabilities.experimental, { 'claude/channel': {} })
    ask(s, 'abcde'); await sleep(400)
    assert.equal((await prompts(cfg)).length, 0)
    await s.stop()
  })
})

describe('recurring tasks and the Projects screen', () => {
  test('lastDue: hourly, daily and weekdays, in local time', async () => {
    const { lastDue } = await import('../server/relay.mjs')
    const at = (d, h, m) => new Date(2026, 10, d, h, m) // Nov 2026: the 6th is a Friday
    assert.deepEqual(lastDue({ every: 'hour', m: 15 }, at(4, 10, 20)), at(4, 10, 15))
    assert.deepEqual(lastDue({ every: 'hour', m: 30 }, at(4, 10, 20)), at(4, 9, 30))
    assert.deepEqual(lastDue({ every: 'day', h: 8, m: 0 }, at(4, 9, 0)), at(4, 8, 0))
    assert.deepEqual(lastDue({ every: 'day', h: 8, m: 0 }, at(4, 7, 59)), at(3, 8, 0))
    assert.deepEqual(lastDue({ every: 'weekday', h: 8, m: 0 }, at(8, 12, 0)), at(6, 8, 0)) // Sunday -> Friday
    assert.deepEqual(lastDue({ every: 'weekday', h: 8, m: 0 }, at(9, 7, 0)), at(6, 8, 0)) // Monday before 8
  })

  test('a due task becomes one note, delivered once across sessions; older or bad lists are ignored', async () => {
    const dir = tmpDir(); const cfg = pairDir(dir)
    const env = { CLAUDE_WATCH_NOTES_SWEEP_MS: '200' }
    const a = startServer(dir, { env }), b = startServer(dir, { env })
    await Promise.all([a.ready, b.ready])
    await connected(`${cfg.topic}-r`, 2)
    const since = new Date(Date.now() - 3 * 3_600_000).toISOString()
    const m = new Date(Date.now() - 60_000).getMinutes() // came due a minute ago
    const list = (ts, schedules) => post(`${cfg.topicURL}-r`, seal({ ts, schedules }, cfg.key))
    await list(new Date().toISOString(), [
      { id: 'tests', t: 'run the tests', every: 'hour', m, since },
      { id: 'later', t: 'not yet', every: 'hour', m, since: new Date().toISOString() }, // made after it was due
      { id: 'bad id!', t: 'x', every: 'hour', m, since }, { id: 'nope', t: 'x', every: 'year', m, since },
    ])
    await list(new Date(Date.now() - 86_400_000).toISOString(), []) // an older list arriving late
    await post(`${cfg.topicURL}-r`, seal({ ts: new Date().toISOString(), schedules: [] }, crypto.randomBytes(32))) // not our watch
    const isTask = m => m.method === 'notifications/claude/channel' && m.params.content === 'run the tests'
    const got = await Promise.race([a.waitFor(isTask, 5000, 'task'), b.waitFor(isTask, 5000, 'task')])
    assert.equal(got.params.meta.source, 'schedule')
    await sleep(800)
    assert.equal(a.msgs.filter(isTask).length + b.msgs.filter(isTask).length, 1)
    assert.equal([...a.pushes(), ...b.pushes()].length, 1)
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'schedules.json'), 'utf8'))
    assert.deepEqual(saved.list.map(s => s.id), ['tests', 'later'])
    await a.stop(); await b.stop()
  })

  test('daily recap: one line per chat of the notes done today, sent once after the recap hour', async () => {
    const dir = tmpDir(); const cfg = pairDir(dir)
    const notes = path.join(dir, 'notes'); fs.mkdirSync(notes)
    const today = new Date().toISOString(), yesterday = new Date(Date.now() - 2 * 86_400_000).toISOString()
    const save = n => fs.writeFileSync(path.join(notes, `${n.id}.json`), JSON.stringify(n))
    save({ id: 'a', text: 'add dark mode\nand make it nice', status: 'done', doneAt: today, chat: 'website' })
    save({ id: 'b', text: 'fix the footer', status: 'done', doneAt: today, chat: 'website' })
    save({ id: 'c', text: 'make a game', status: 'done', doneAt: today, to: 'game' })
    save({ id: 'd', text: 'old', status: 'done', doneAt: yesterday, chat: 'website' })
    save({ id: 'e', text: 'still going', status: 'sent', chat: 'website' })
    save({ id: 'f', text: 'emailed', status: 'done', doneAt: today, source: 'email', chat: 'website' })
    const env = { CLAUDE_WATCH_NOTES_SWEEP_MS: '200', CLAUDE_WATCH_NOTES_RECAP_HOUR: '0' }
    const a = startServer(dir, { env }), b = startServer(dir, { env })
    await Promise.all([a.ready, b.ready])
    await sleep(1200)
    const sent = (await (await fetch(`${cfg.topicURL}-s/json?poll=1&since=all`)).text()).trim().split('\n').filter(Boolean)
      .map(l => openBox(JSON.parse(l).message, cfg.key))
    assert.equal(sent.length, 1) // once, from two sessions and several sweeps
    assert.deepEqual(sent[0].lines, [{ chat: 'game', done: ['make a game'], count: 1 },
      { chat: 'website', done: ['add dark mode', 'fix the footer'], count: 2 }])
    await a.stop(); await b.stop()
  })

  test('heartbeats say which note the chat is working on, until it is done', async () => {
    const dir = tmpDir(); const cfg = pairDir(dir)
    const s = startServer(dir, { env: { CLAUDE_WATCH_NOTES_NAME: 'website' } })
    await s.ready
    await connected(cfg.topic)
    const beats = async () => (await (await fetch(`${cfg.topicURL}-c/json?poll=1&since=all`)).text())
      .trim().split('\n').filter(Boolean).map(l => openBox(JSON.parse(l).message, cfg.key))
    const n = note('make the logo bigger')
    await post(cfg.topicURL, seal(n, cfg.key))
    await s.waitFor(pushFor(n.id))
    const end = Date.now() + 5000
    while (!(await beats()).some(b => b.working) && Date.now() < end) await sleep(100)
    assert.equal((await beats()).at(-1).working, 'make the logo bigger')
    await s.request('tools/call', { name: 'watch_note_done', arguments: { note_id: n.id, summary: 'ok' } })
    await sleep(800)
    assert.equal((await beats()).at(-1).working, undefined)
    await s.stop()
  })
})

describe('sessions, restarts and the network', () => {
  test('only the channel session claims notes; other open sessions leave them alone', async () => {
    const dir = tmpDir(); const cfg = pairDir(dir)
    const other = startServer(dir, { env: { CLAUDE_WATCH_NOTES_CHANNEL: '' } }) // e.g. a `claude --resume` window
    await other.ready; await connected(cfg.topic)
    const n = note('for the channel session')
    await post(cfg.topicURL, seal(n, cfg.key))
    await sleep(800)
    assert.equal(other.pushes().length, 0)
    const r = await other.request('tools/call', { name: 'watch_inbox', arguments: {} })
    assert.match(r.result.content[0].text, new RegExp(n.id)) // still reachable from /handoff:inbox
    const listening = startServer(dir)
    await listening.waitFor(pushFor(n.id))
    await Promise.all([other.stop(), listening.stop()])
  })

  test('the listening session gets a note even when another session saves it to disk first', async () => {
    const dir = tmpDir(); const cfg = pairDir(dir)
    const others = [1, 2, 3].map(() => startServer(dir, { env: { CLAUDE_WATCH_NOTES_CHANNEL: '' } }))
    const listening = startServer(dir)
    await Promise.all([...others, listening].map(x => x.ready)); await connected(cfg.topic, 4)
    const ns = Array.from({ length: 10 }, (_, i) => note(`race ${i}`))
    for (const n of ns) await post(cfg.topicURL, seal(n, cfg.key))
    for (const n of ns) await listening.waitFor(pushFor(n.id))
    assert.equal(listening.pushes().length, 10)
    await Promise.all([...others, listening].map(x => x.stop()))
  })

  test('safety net: takes back notes held by non-listening sessions, not by listeners', async () => {
    const dir = tmpDir(); pairDir(dir)
    const notes = path.join(dir, 'notes'); fs.mkdirSync(notes, { recursive: true })
    const held = (text, claim, ageMs = 0) => {
      const n = { id: crypto.randomUUID().toUpperCase(), text, at: new Date().toISOString(), status: 'sent' }
      fs.writeFileSync(path.join(notes, `${n.id}.json`), JSON.stringify(n))
      const f = path.join(notes, `${n.id}.claim`)
      fs.writeFileSync(f, claim)
      if (ageMs) { const t = (Date.now() - ageMs) / 1000; fs.utimesSync(f, t, t) }
      return n
    }
    const dead = spawn(process.execPath, ['-e', '']); await new Promise(r => dead.on('exit', r))
    const exited = held('held by an exited old-version session', String(dead.pid))
    const exitedListener = held('held by an exited listener', `${dead.pid} channel`)
    const oldVersion = held('held by an old-version session', String(process.pid), 5 * 60_000)
    const fresh = held('just taken by an old-version session', String(process.pid))
    const listener = held('held by a live listener', `${process.pid} channel`)
    const done = held('already done', `${dead.pid} channel`)
    fs.writeFileSync(path.join(notes, `${done.id}.json`), JSON.stringify({ ...done, status: 'done' }))

    const s = startServer(dir, { env: { CLAUDE_WATCH_NOTES_SWEEP_MS: '200' } })
    await s.ready
    await s.waitFor(pushFor(exited.id)); await s.waitFor(pushFor(oldVersion.id))
    // Rescued exactly once, even though the sweep keeps running.
    await sleep(800)
    for (const n of [exited, oldVersion]) assert.equal(s.pushes().filter(m => m.params.meta.note_id === n.id).length, 1)
    for (const n of [fresh, listener, exitedListener, done]) assert.equal(s.pushes().filter(m => m.params.meta.note_id === n.id).length, 0, n.text)
    assert.ok(fs.existsSync(path.join(notes, `${exited.id}.claim.1`)))
    await s.stop()
  })

  test('chats: a note sent to a chat by name only goes to that chat; untargeted notes go to any', async () => {
    const dir = tmpDir(); const cfg = pairDir(dir)
    const web = startServer(dir, { env: { CLAUDE_WATCH_NOTES_NAME: 'website' } })
    const app = startServer(dir, { env: { CLAUDE_WATCH_NOTES_NAME: 'app' } })
    await Promise.all([web.ready, app.ready]); await connected(cfg.topic, 2)
    const toApp = note('for app', { to: 'app' }), toWeb = note('for website', { to: 'website' }), any = note('for anyone')
    const toGone = note('for a chat that is not open', { to: 'closed' })
    for (const n of [toApp, toWeb, any, toGone]) await post(cfg.topicURL, seal(n, cfg.key))
    await app.waitFor(pushFor(toApp.id)); await web.waitFor(pushFor(toWeb.id))
    await sleep(500)
    assert.equal(web.pushes().filter(pushFor(toApp.id)).length, 0)
    assert.equal(app.pushes().filter(pushFor(toWeb.id)).length, 0)
    assert.equal([...web.pushes(), ...app.pushes()].filter(pushFor(any.id)).length, 1)
    assert.equal([...web.pushes(), ...app.pushes()].filter(pushFor(toGone.id)).length, 0)
    // It waits for that chat: delivered when a session with that name starts.
    const closed = startServer(dir, { env: { CLAUDE_WATCH_NOTES_NAME: 'closed' } })
    await closed.waitFor(pushFor(toGone.id))
    await Promise.all([web.stop(), app.stop(), closed.stop()])
  })

  test('chats: listening sessions announce their name (sealed) and say goodbye on exit', async () => {
    const dir = tmpDir(); const cfg = pairDir(dir)
    const quiet = startServer(dir, { env: { CLAUDE_WATCH_NOTES_CHANNEL: '', CLAUDE_WATCH_NOTES_NAME: 'not listening' } })
    const s = startServer(dir, { env: { CLAUDE_WATCH_NOTES_NAME: 'website', CLAUDE_WATCH_NOTES_HEARTBEAT_MS: '300' } })
    await Promise.all([quiet.ready, s.ready])
    const chats = async () => (await (await fetch(`${cfg.topicURL}-c/json?poll=1&since=all`)).text())
      .trim().split('\n').filter(Boolean).map(l => openBox(JSON.parse(l).message, cfg.key))
    const end = Date.now() + 5000
    while ((await chats()).length < 3 && Date.now() < end) await sleep(100)
    let got = await chats()
    assert.ok(got.length >= 3, 'initial + periodic heartbeats')
    assert.ok(got.every(c => c.chat === 'website' && !c.gone))
    await s.stop(); await quiet.stop()
    got = await chats()
    assert.equal(got.at(-1).gone, true)
    assert.equal(got.filter(c => c.chat !== 'website').length, 0)
  })

  test('notes that arrive before the session is ready are pushed on initialize', async () => {
    const dir = tmpDir(); const cfg = pairDir(dir)
    const s = startServer(dir, { init: false })
    await connected(cfg.topic)
    const n = note('early bird')
    await post(cfg.topicURL, seal(n, cfg.key))
    await sleep(300)
    assert.equal(s.pushes().length, 0)
    await s.init()
    await s.waitFor(pushFor(n.id))
    await s.stop()
  })

  test('notes sent while no session was running are delivered when one starts', async () => {
    const dir = tmpDir(); const cfg = pairDir(dir)
    const n = note('sent while away')
    await post(cfg.topicURL, seal(n, cfg.key))
    const s = startServer(dir)
    await s.waitFor(pushFor(n.id))
    await s.stop()
  })

  for (let run = 1; run <= Number(process.env.RACE_RUNS || 10); run++)
  test(`two sessions at once: every note is handed to exactly one (run ${run})`, async () => {
    const dir = tmpDir(); const cfg = pairDir(dir)
    const a = startServer(dir), b = startServer(dir)
    await Promise.all([a.ready, b.ready]); await connected(cfg.topic, 2)
    const ns = Array.from({ length: 20 }, (_, i) => note(`shared ${i}`))
    for (const n of ns) await post(cfg.topicURL, seal(n, cfg.key))
    const end = Date.now() + 5000
    while (a.pushes().length + b.pushes().length < 20 && Date.now() < end) await sleep(50)
    await sleep(500)
    for (const n of ns) {
      const count = [...a.pushes(), ...b.pushes()].filter(pushFor(n.id)).length
      assert.equal(count, 1, `${n.t} delivered ${count} times`)
    }
    await a.stop(); await b.stop()
  })

  test('restart does not re-deliver handled notes', async () => {
    const dir = tmpDir(); const cfg = pairDir(dir)
    let s = startServer(dir); await s.ready; await connected(cfg.topic)
    const n = note('once only')
    await post(cfg.topicURL, seal(n, cfg.key))
    await s.waitFor(pushFor(n.id)); await s.stop()
    s = startServer(dir); await s.ready; await connected(cfg.topic)
    const n2 = note('after restart')
    await post(cfg.topicURL, seal(n2, cfg.key))
    await s.waitFor(pushFor(n2.id))
    assert.equal(s.pushes().filter(pushFor(n.id)).length, 0)
    await s.stop()
  })

  test('relay drops the connection: server reconnects and catches up', async () => {
    const dir = tmpDir(); const cfg = pairDir(dir)
    const s = startServer(dir); await s.ready; await connected(cfg.topic)
    mock.dropStreams()
    const n = note('sent during the outage') // posted before the server reconnects
    await post(cfg.topicURL, seal(n, cfg.key))
    await s.waitFor(pushFor(n.id), 8000)
    await s.stop()
  })

  test('silent stall (no bytes, no close): watchdog reconnects', async () => {
    const dir = tmpDir(); const cfg = pairDir(dir)
    const s = startServer(dir); await s.ready; await connected(cfg.topic)
    mock.stall(true)
    const n = note('sent while the connection was wedged')
    await post(cfg.topicURL, seal(n, cfg.key)) // not forwarded on the stalled stream
    await sleep(2000) // > CLAUDE_WATCH_NOTES_IDLE_MS
    mock.stall(false)
    await s.waitFor(pushFor(n.id), 8000)
    assert.match(s.stderr, /connection idle/)
    await s.stop()
  })

  test('relay unreachable at start, then comes up', async () => {
    const dir = tmpDir()
    const down = await startMock(); const downURL = down.url; await down.close()
    const key = crypto.randomBytes(32); const topic = `cw-${crypto.randomBytes(16).toString('hex')}`
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ topicURL: `${downURL}/${topic}`, key: key.toString('base64') }))
    const s = startServer(dir); await s.ready
    await sleep(1500)
    const up = await startMock({ port: Number(new URL(downURL).port) })
    const n = note('relay is back')
    await post(`${downURL}/${topic}`, seal(n, key))
    await s.waitFor(pushFor(n.id), 10000)
    assert.match(s.stderr, /subscription:/)
    await s.stop(); await up.close()
  })

  test('not paired at start; pairing later is picked up without restart', async () => {
    const dir = tmpDir()
    const s = startServer(dir); await s.ready
    await sleep(300)
    assert.match(s.stderr, /not paired yet/)
    const cfg = pairDir(dir)
    await connected(cfg.topic)
    const n = note('first note after pairing')
    await post(cfg.topicURL, seal(n, cfg.key))
    await s.waitFor(pushFor(n.id), 8000)
    await s.stop()
  })

  test('re-pairing switches topic and key live; the old pairing stops working', async () => {
    const dir = tmpDir(); const old = pairDir(dir)
    const s = startServer(dir); await s.ready; await connected(old.topic)
    const fresh = pairDir(dir)
    await connected(fresh.topic)
    const stale = note('old pairing'); const good = note('new pairing')
    await post(old.topicURL, seal(stale, old.key))
    await post(fresh.topicURL, seal(good, fresh.key))
    await s.waitFor(pushFor(good.id), 8000)
    await sleep(300)
    assert.equal(s.pushes().filter(pushFor(stale.id)).length, 0)
    assert.ok(fs.readFileSync(path.join(dir, 'cursor'), 'utf8').startsWith(fresh.topicURL))
    await s.stop()
  })
})

describe('host command (new chats from the watch)', () => {
  const CLI = new URL('../cli/handoff.mjs', import.meta.url).pathname
  test('lists projects, opens only listed ones, ignores stale/forged requests, quotes names safely', async () => {
    const dir = tmpDir(); const cfg = pairDir(dir)
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwn-root-')))
    for (const d of ['website', 'app', '.hidden', 'website/src', 'website/src/deep', 'website/node_modules']) fs.mkdirSync(path.join(root, d))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cwn-outside-'))
    fs.symlinkSync(outside, path.join(root, 'escape-link'))
    fs.symlinkSync(path.join(root, 'app'), path.join(root, 'app-link'))
    fs.writeFileSync(path.join(root, 'notes.txt'), '')
    const h = spawn(process.execPath, [CLI, 'host', root], {
      env: { ...process.env, CLAUDE_WATCH_NOTES_DIR: dir, CLAUDE_WATCH_NOTES_RELAY: mock.url, CLAUDE_WATCH_NOTES_HOST_DRYRUN: '1', CLAUDE_WATCH_NOTES_CHECK_MS: '100' },
    })
    spawned.add(h)
    let out = ''
    h.stdout.on('data', d => { out += d })
    const announced = async () => (await (await fetch(`${cfg.topicURL}-c/json?poll=1&since=all`)).text())
      .trim().split('\n').filter(Boolean).map(l => openBox(JSON.parse(l).message, cfg.key))
    let end = Date.now() + 5000
    while (!(await announced()).length && Date.now() < end) await sleep(50)
    const [a] = await announced()
    assert.deepEqual(a.projects, ['app', 'app-link', 'website']) // symlinks only when they stay inside
    assert.equal(typeof a.host, 'string')
    await sleep(800) // checked every 100ms here, but nothing changed: not sent again (ntfy.sh's daily limit)
    assert.equal((await announced()).filter(m => m.host).length, 1)
    await connected(`${cfg.topic}-n`)

    const ask = (r, key = cfg.key) => post(`${cfg.topicURL}-n`, seal({ ts: new Date().toISOString(), ...r }, key))
    const evil = "it's $(touch pwned) `x` \"q\""
    await ask({ project: '../..', name: 'escape' })
    await ask({ project: 'website', name: 'stale', ts: new Date(Date.now() - 11 * 60_000).toISOString() })
    await ask({ project: 'website', name: 'forged' }, crypto.randomBytes(32))
    await ask({ path: 'escape-link', name: 'symlink escape' })
    await ask({ path: 'website', create: '../breakout', name: 'bad folder' })
    await ask({ project: 'website', name: evil }) // the old watch build's field
    await ask({ path: 'website/src/deep', name: 'deep' })
    await ask({ path: 'website/src', create: 'made-on-watch' })
    end = Date.now() + 5000
    while ((out.match(/^LAUNCH/gm) || []).length < 3 && Date.now() < end) await sleep(50)
    await sleep(300)
    const launches = [...out.matchAll(/^LAUNCH (.*)$/gm)].map(m => JSON.parse(m[1]))
    assert.deepEqual(launches.map(l => [l.dir, l.name]), [
      [path.join(root, 'website'), evil],
      [path.join(root, 'website/src/deep'), 'deep'],
      [path.join(root, 'website/src/made-on-watch'), 'made-on-watch'],
    ], out)
    assert.ok(fs.statSync(path.join(root, 'website/src/made-on-watch')).isDirectory())
    assert.ok(!fs.existsSync(path.join(root, 'breakout')) && !fs.existsSync(path.join(root, 'website/breakout')))

    // Folder browsing: listings come back sealed on "<topic>-l"; paths outside the root get none.
    const lsReply = async (ls) => {
      const id = crypto.randomUUID()
      await ask({ ls, id })
      const stop = Date.now() + 5000
      while (Date.now() < stop) {
        const got = (await (await fetch(`${cfg.topicURL}-l/json?poll=1&since=all`)).text()).trim().split('\n').filter(Boolean)
          .map(l => openBox(JSON.parse(l).message, cfg.key)).find(m => m.id === id)
        if (got) return got
        await sleep(50)
      }
      throw new Error('no listing reply')
    }
    assert.deepEqual((await lsReply('')).dirs, ['app', 'app-link', 'website'])
    assert.deepEqual((await lsReply('website')).dirs, ['src']) // node_modules hidden
    assert.deepEqual((await lsReply('website/src')).dirs, ['deep', 'made-on-watch'])
    assert.equal((await lsReply('../')).dirs, null)
    assert.equal((await lsReply('escape-link')).dirs, null)
    // The log window's script quotes the name and log path: running it with the name runs no command.
    const { execFileSync } = await import('node:child_process')
    const title = launches[0].script.match(/^printf '\\033\]0;%s\\007' (.*)$/m)[1]
    assert.equal(execFileSync('/bin/sh', ['-c', `printf %s ${title}`], { cwd: root }).toString(), `Handoff: ${evil}`)
    assert.match(launches[0].script, /tail -n \+1 -F '[^'$`"]+\.log'\n$/)
    assert.ok(!fs.existsSync(path.join(root, 'pwned')))
    assert.deepEqual((await announced()).filter(a => a.host).at(-1).chats.sort(), [evil, 'deep', 'made-on-watch'].sort())
    // Each chat's status for the Projects screen (these folders aren't git repositories).
    assert.ok((await announced()).some(a => a.repo === 'deep' && a.branch === undefined))

    // "Open on computer": only chats this host has, never stale or forged requests. A chat that
    // hasn't run a note yet opens a new conversation in its folder; every value is quoted.
    await ask({ open: 'not a chat' })
    await ask({ open: 'deep', ts: new Date(Date.now() - 11 * 60_000).toISOString() })
    await ask({ open: 'deep' }, crypto.randomBytes(32))
    await ask({ open: evil })
    end = Date.now() + 5000
    while (!/^OPEN /m.test(out) && Date.now() < end) await sleep(50)
    await sleep(300)
    const opens = [...out.matchAll(/^OPEN (.*)$/gm)].map(m => JSON.parse(m[1]))
    assert.deepEqual(opens.map(o => o.name), [evil], out)
    assert.match(out, /Skipped a request to open a chat this host doesn't have/)
    assert.match(opens[0].script, new RegExp(`\ncd '${path.join(root, 'website').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}' \\|\\| exit 1\nexec '[^']+'\n$`))
    const openTitle = opens[0].script.match(/^printf '\\033\]0;%s\\007' (.*)$/m)[1]
    assert.equal(execFileSync('/bin/sh', ['-c', `printf %s ${openTitle}`], { cwd: root }).toString(), `Claude: ${evil}`)

    h.kill('SIGTERM'); await new Promise(r => h.on('exit', r))
    assert.equal((await announced()).at(-1).gone, true)
  })

  test('runs notes for its chats headless, one at a time, continuing the same session', async () => {
    const dir = tmpDir(); const cfg = pairDir(dir)
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwn-root-')))
    fs.mkdirSync(path.join(root, 'website'))
    const calls = path.join(dir, 'fake-claude.jsonl')
    const env = { ...process.env, CLAUDE_WATCH_NOTES_DIR: dir, CLAUDE_WATCH_NOTES_RELAY: mock.url, CLAUDE_WATCH_NOTES_HOST_DRYRUN: '1',
      CLAUDE_WATCH_NOTES_CLAUDE: new URL('./fake-claude.mjs', import.meta.url).pathname, FAKE_CLAUDE_LOG: calls,
      CLAUDE_WATCH_NOTES_SWEEP_MS: '200', CLAUDE_WATCH_NOTES_CHANNEL: '1' }
    let h = spawn(process.execPath, [CLI, 'host', root], { env })
    spawned.add(h)
    let out = ''
    h.stdout.on('data', d => { out += d })
    await connected(`${cfg.topic}-n`); await connected(cfg.topic)
    await post(`${cfg.topicURL}-n`, seal({ ts: new Date().toISOString(), path: 'website', name: 'web' }, cfg.key))
    let end = Date.now() + 5000
    while (!out.includes('LAUNCH') && Date.now() < end) await sleep(50)
    const { session } = JSON.parse(out.match(/^LAUNCH (.*)$/m)[1])

    const ran = () => { try { return fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
    const saved = id => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'notes', `${id}.json`), 'utf8')) } catch { return {} } }
    const until = async (cond, what) => { const stop = Date.now() + 8000; while (!cond()) { if (Date.now() > stop) throw new Error(`timed out: ${what}\n${out}`); await sleep(50) } }

    const first = note('-rf make a todo app', { to: 'web' }), second = note('add dark mode', { to: 'web' })
    const other = note('not for the host', { to: 'some other chat' })
    for (const n of [first, second, other]) await post(cfg.topicURL, seal(n, cfg.key))
    await until(() => ran().length >= 2 && saved(second.id).status === 'done', 'both notes run')
    const [a, b] = ran()
    assert.equal(a.cwd, path.join(root, 'website'))
    assert.equal(a.name, 'web')
    assert.ok(a.args.includes('-p') && a.args.includes('--permission-mode') && a.args.includes('auto'))
    assert.deepEqual(a.args.slice(a.args.indexOf('--session-id'), a.args.indexOf('--session-id') + 2), ['--session-id', session])
    assert.deepEqual(b.args.slice(b.args.indexOf('--resume'), b.args.indexOf('--resume') + 2), ['--resume', session]) // same conversation
    assert.ok(a.prompt.startsWith('-rf make a todo app') && a.prompt.includes(`note_id=${first.id}`)) // prompt on stdin, not argv
    assert.ok(!a.args.some(x => x.includes('todo')))
    assert.equal(saved(first.id).summary, 'Did: -rf make a todo app') // Claude didn't call watch_note_done
    assert.equal(ran().length, 2) // the note for another chat isn't run here
    assert.equal(saved(other.id).status, 'new')
    const log = fs.readFileSync(path.join(dir, 'logs', fs.readdirSync(path.join(dir, 'logs'))[0]), 'utf8')
    assert.match(log, /Note from your watch:\n-rf make a todo app/)
    assert.match(log, /→ Bash \{"command":"ls"\}/)
    assert.match(log, new RegExp(`claude --resume ${session}`))

    // Opening it on the computer continues the same conversation.
    await post(`${cfg.topicURL}-n`, seal({ ts: new Date().toISOString(), open: 'web' }, cfg.key))
    await until(() => /^OPEN /m.test(out), 'open')
    const opened = JSON.parse(out.match(/^OPEN (.*)$/m)[1])
    assert.match(opened.script, new RegExp(`\nexec '[^']*fake-claude\\.mjs' --resume '${session}'\n$`))

    // Failures are recorded, and the chat survives a host restart (it keeps resuming the session).
    const bad = note('FAIL please', { to: 'web' })
    await post(cfg.topicURL, seal(bad, cfg.key))
    await until(() => saved(bad.id).status === 'failed', 'failure recorded')
    assert.match(saved(bad.id).summary, /something broke/)
    h.kill('SIGTERM'); await new Promise(r => h.on('exit', r))
    h = spawn(process.execPath, [CLI, 'host', root], { env })
    spawned.add(h)
    await connected(cfg.topic)
    const later = note('one more thing', { to: 'web' })
    await post(cfg.topicURL, seal(later, cfg.key))
    await until(() => saved(later.id).status === 'done', 'note after restart')
    const last = ran().at(-1)
    assert.equal(last.args[last.args.indexOf('--resume') + 1], session)
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'host-chats.json'), 'utf8')).web.session, session) // a replayed request didn't start it over
    assert.equal(ran().filter(r => r.prompt.includes(first.id)).length, 1) // nothing re-run after the restart

    // Stop on the watch interrupts the note the chat is running.
    const slow = note('SLOW rebuild everything', { to: 'web' })
    await post(cfg.topicURL, seal(slow, cfg.key))
    await until(() => ran().some(r => r.prompt.includes(slow.id)), 'slow note started')
    await connected(`${cfg.topic}-n`)
    await post(`${cfg.topicURL}-n`, seal({ ts: new Date().toISOString(), stop: 'web' }, cfg.key))
    await until(() => saved(slow.id).status === 'stopped', 'stopped')
    assert.equal(saved(slow.id).summary, 'Stopped from the watch.')
    assert.ok(ran().at(-1).args.includes('mcp__handoff__watch_ask'))
    h.kill('SIGTERM'); await new Promise(r => h.on('exit', r))
  })
})

describe('mail command (email Claude through the Mail app)', () => {
  const CLI = new URL('../cli/handoff.mjs', import.meta.url).pathname
  let dir, s, mailbox, log, failFile, h, out
  const box = () => JSON.parse(fs.readFileSync(mailbox, 'utf8'))
  const send = m => fs.writeFileSync(mailbox, JSON.stringify({ ...box(), sent: [...box().sent, { to: 'me+claude@gmail.com', at: new Date().toISOString(), ...m }] }))
  const replies = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []
  const until = async (cond, what) => { const stop = Date.now() + 8000; while (!cond()) { if (Date.now() > stop) throw new Error(`timed out: ${what}\n${out}`); await sleep(50) } }
  const mailId = messageId => `mail-${crypto.createHash('sha256').update(messageId).digest('hex').slice(0, 24)}`
  const saved = id => JSON.parse(fs.readFileSync(path.join(dir, 'notes', `${id}.json`), 'utf8'))
  function startMail(args = []) {
    out = ''
    h = spawn(process.execPath, [CLI, 'mail', ...args], { env: { ...process.env, CLAUDE_WATCH_NOTES_DIR: dir, CLAUDE_WATCH_NOTES_MAIL_MS: '150',
      CLAUDE_WATCH_NOTES_OSASCRIPT: new URL('./fake-osascript.mjs', import.meta.url).pathname, FAKE_MAIL: mailbox, FAKE_MAIL_LOG: log, FAKE_MAIL_FAIL: failFile } })
    spawned.add(h)
    h.stdout.on('data', d => { out += d }); h.stderr.on('data', d => { out += d })
    return h
  }
  const stopMail = () => { h.kill('SIGTERM'); return new Promise(r => h.exitCode !== null ? r() : h.on('exit', r)) }

  before(async () => {
    dir = tmpDir(); pairDir(dir)
    mailbox = path.join(dir, 'mailbox.json'); log = path.join(dir, 'replies.log'); failFile = path.join(dir, 'fail')
    fs.writeFileSync(mailbox, JSON.stringify({ accounts: ['me@gmail.com', 'me@icloud.com'], sent: [] }))
    s = startServer(dir, { env: { CLAUDE_WATCH_NOTES_SWEEP_MS: '150' } })
    await s.ready
    startMail()
    await until(() => /email me\+claude@gmail\.com from me@gmail\.com/.test(out), 'mail started')
  })
  after(async () => { await stopMail(); await s.stop() })

  test('an emailed note reaches the session once, and the summary is emailed back in the thread', async () => {
    send({ messageId: '<a1@mail.gmail.com>', subject: 'Fix the typo', content: 'in the README please\n\n-- \nMax' })
    const id = mailId('<a1@mail.gmail.com>')
    const m = await s.waitFor(pushFor(id), 8000, 'email push')
    assert.equal(m.params.content, 'Fix the typo\n\nin the README please')
    assert.equal(m.params.meta.source, 'email')
    await sleep(500)
    assert.equal(s.pushes().filter(pushFor(id)).length, 1)
    const r = await s.request('tools/call', { name: 'watch_note_done', arguments: { note_id: id, summary: 'Fixed it.', suggestion: 'add a spellcheck' } })
    assert.match(r.result.content[0].text, /email the summary back/)
    await until(() => replies().length === 1, 'reply')
    const [rep] = replies()
    assert.deepEqual([rep.me, rep.to, rep.messageId, rep.subject], ['me@gmail.com', 'me+claude@gmail.com', '<a1@mail.gmail.com>', 'Fix the typo'])
    assert.match(rep.body, /^Fixed it\.\n\nNext step\? Reply with: add a spellcheck\n\n—\nHandoff · /)
    await until(() => saved(id).replied === true, 'marked replied')
  })

  test('a reply in the thread is a new note without the quoted text; our own replies are never notes', async () => {
    send({ messageId: '<ours@x>', subject: 'Re: Fix the typo', content: 'Fixed it.\n\n—\nHandoff · reply to send Claude another note' })
    send({ messageId: '<a2@x>', subject: 'Re: Fix the typo', content: 'now the other one\n\nOn Wed, Nov 5, 2026 at 10:00 AM Claude (Handoff) <\nme@gmail.com> wrote:\n> Fixed it.\n' })
    const m = await s.waitFor(pushFor(mailId('<a2@x>')), 8000, 'reply note')
    assert.equal(m.params.content, 'now the other one')
    await sleep(500)
    assert.ok(!fs.existsSync(path.join(dir, 'notes', `${mailId('<ours@x>')}.json`)))
  })

  test('mail to other addresses is ignored', async () => {
    send({ messageId: '<other@x>', subject: 'hi mom', content: 'dinner?', to: 'mom@example.com' })
    await sleep(600)
    assert.ok(!fs.existsSync(path.join(dir, 'notes', `${mailId('<other@x>')}.json`)))
  })

  test('a reply that fails is retried, and a restart never sends one twice', async () => {
    fs.writeFileSync(failFile, '2')
    send({ messageId: '<a3@x>', subject: 'third', content: 'go' })
    const id = mailId('<a3@x>')
    await s.waitFor(pushFor(id), 8000, 'third push')
    await s.request('tools/call', { name: 'watch_note_done', arguments: { note_id: id, summary: 'ok' } })
    await until(() => replies().some(r => r.messageId === '<a3@x>'), 'retried reply')
    assert.match(out, /will retry/)
    await until(() => saved(id).replied === true, 'marked replied')
    const before = replies().length
    await stopMail(); startMail(['me@gmail.com'])
    await sleep(800)
    assert.equal(replies().length, before)
    assert.equal(fs.readdirSync(path.join(dir, 'notes')).filter(f => f.startsWith('mail-') && f.endsWith('.json')).length, 3)
  })

  test('asks which address when Mail has no single Gmail account, then remembers the one given', async () => {
    const fresh = tmpDir(), two = path.join(fresh, 'two.json')
    fs.writeFileSync(two, JSON.stringify({ accounts: ['a@gmail.com', 'b@gmail.com', 'me@icloud.com'], sent: [] }))
    const env = { ...process.env, CLAUDE_WATCH_NOTES_DIR: fresh, CLAUDE_WATCH_NOTES_MAIL_MS: '150',
      CLAUDE_WATCH_NOTES_OSASCRIPT: new URL('./fake-osascript.mjs', import.meta.url).pathname, FAKE_MAIL: two }
    const run = (args, ms) => new Promise(r => {
      const p = spawn(process.execPath, [CLI, 'mail', ...args], { env })
      spawned.add(p)
      let text = ''
      p.stdout.on('data', d => { text += d }); p.stderr.on('data', d => { text += d })
      const t = ms && setTimeout(() => p.kill('SIGTERM'), ms)
      p.on('exit', code => { clearTimeout(t); r({ code, text }) })
    })
    let r = await run([])
    assert.equal(r.code, 1)
    assert.match(r.text, /handoff mail <address>[\s\S]*a@gmail\.com, b@gmail\.com, me@icloud\.com/)
    r = await run(['Me@iCloud.com'], 600)
    assert.match(r.text, /email me\+claude@icloud\.com from me@icloud\.com/)
    r = await run([], 600) // remembered
    assert.match(r.text, /email me\+claude@icloud\.com from me@icloud\.com/)
  })
})

describe('pair command', () => {
  const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
  const code = () => Array.from({ length: 8 }, () => ALPHABET[crypto.randomInt(31)]).join('')
  const derive = (c, info, n) => Buffer.from(crypto.hkdfSync('sha256', c, 'claude-watch-notes-pair', info, n))

  // `typed`: the code the user types on the Mac (the watch shows it); otherwise the Mac shows `c`.
  function runPair(dir, c, timeoutMs = 15000, typed, env = {}) {
    const p = spawn(process.execPath, [SERVER, 'pair', ...(typed === undefined ? [] : [typed])], {
      env: { ...process.env, CLAUDE_WATCH_NOTES_DIR: dir, CLAUDE_WATCH_NOTES_RELAY: mock.url, CLAUDE_WATCH_NOTES_PAIR_CODE: c,
        CLAUDE_WATCH_NOTES_NO_SIM: '1', CLAUDE_WATCH_NOTES_PAIR_TIMEOUT_MS: String(timeoutMs), CLAUDE_WATCH_NOTES_OWN_RELAY: '', ...env },
    })
    spawned.add(p)
    let outText = ''
    p.stdout.on('data', d => { outText += d }); p.stderr.on('data', d => { outText += d })
    return { p, get out() { return outText }, exit: new Promise(r => p.on('exit', r)) }
  }
  // What the watch does (Pairer.pair in App.swift).
  async function watchPair(c, { topic, key, n = crypto.randomBytes(16).toString('hex'), moves } = {}) {
    const pk = derive(c, 'key', 32)
    const pairURL = `${mock.url}/cwp-${derive(c, 'topic', 16).toString('hex')}`
    topic ??= `${mock.url}/cw-${crypto.randomBytes(16).toString('hex')}`
    key ??= crypto.randomBytes(32).toString('base64')
    const offer = await post(pairURL, seal({ topic, key, n, ...(moves && { moves }) }, pk))
    for (let i = 0; i < 40; i++) {
      await sleep(100)
      const res = await (await fetch(`${pairURL}/json?poll=1&since=${offer.id}`)).text()
      for (const line of res.split('\n').filter(Boolean)) {
        try { const ack = openBox(JSON.parse(line).message, pk); if (ack.ack === n) return { topic, key, ack } } catch {}
      }
    }
    return null
  }

  test('pairs: writes config and acknowledges the watch', async () => {
    const dir = tmpDir(); const c = code()
    const run = runPair(dir, c)
    await sleep(300)
    assert.match(run.out, new RegExp(`${c.slice(0, 4)}-${c.slice(4)}`))
    const w = await watchPair(c)
    assert.ok(w, 'watch never got an ack')
    assert.equal(await run.exit, 0)
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'))
    assert.deepEqual(cfg, { topicURL: w.topic, key: w.key })
    assert.equal(fs.statSync(path.join(dir, 'config.json')).mode & 0o777, 0o600)
  })

  test('with your own relay, a watch that can move is told to, and the Mac follows', async () => {
    const own = await startRelay({ dir: tmpDir() })
    try {
      const dir = tmpDir(); const c = code()
      const run = runPair(dir, c, 15000, undefined, { CLAUDE_WATCH_NOTES_OWN_RELAY: own.url })
      const w = await watchPair(c, { moves: true })
      assert.ok(w, 'watch never got an ack'); assert.equal(await run.exit, 0)
      assert.equal(w.ack.relay, own.url)
      const name = w.topic.slice(mock.url.length)
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')), { topicURL: own.url + name, key: w.key })
      assert.match(run.out, /through your own relay/)
    } finally { await own.close() }
  })

  test('an older watch, or your own relay not answering, stays on ntfy.sh', async () => {
    const own = await startRelay({ dir: tmpDir() })
    try {
      const dir = tmpDir(); const c = code()
      const run = runPair(dir, c, 15000, undefined, { CLAUDE_WATCH_NOTES_OWN_RELAY: own.url })
      const w = await watchPair(c) // no "moves": Hand-Off 1.2 and older
      assert.equal(await run.exit, 0); assert.equal(w.ack.relay, undefined)
      assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).topicURL, w.topic)
      assert.match(run.out, /too old for your own relay/)
    } finally { await own.close() }
    const dir = tmpDir(); const c = code()
    const run = runPair(dir, c, 15000, undefined, { CLAUDE_WATCH_NOTES_OWN_RELAY: 'http://127.0.0.1:9' })
    const w = await watchPair(c, { moves: true })
    assert.equal(await run.exit, 0); assert.equal(w.ack.relay, undefined)
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).topicURL, w.topic)
    assert.match(run.out, /didn't answer, so this pairing uses ntfy.sh/)
  })

  test('the watch posting before the Mac starts listening still pairs', async () => {
    const dir = tmpDir(); const c = code()
    const watch = watchPair(c)
    await sleep(150)
    const run = runPair(dir, c)
    assert.ok(await watch); assert.equal(await run.exit, 0)
  })

  test('rejects malformed offers and keeps waiting for a valid one', async () => {
    const dir = tmpDir(); const c = code()
    const run = runPair(dir, c)
    await sleep(300)
    const pk = derive(c, 'key', 32)
    const pairURL = `${mock.url}/cwp-${derive(c, 'topic', 16).toString('hex')}`
    const good = { topic: `${mock.url}/cw-${'a'.repeat(32)}`, key: crypto.randomBytes(32).toString('base64'), n: 'x' }
    await post(pairURL, seal({ ...good, topic: 'https://evil.example/cw-' + 'a'.repeat(32) }, pk)) // other host
    await post(pairURL, seal({ ...good, topic: `${mock.url}/cw-../../x` }, pk))                    // bad topic
    await post(pairURL, seal({ ...good, key: crypto.randomBytes(16).toString('base64') }, pk))      // short key
    await post(pairURL, seal({ ...good, n: 42 }, pk))                                                // bad nonce
    await post(pairURL, seal(good, crypto.randomBytes(32)))                                          // wrong code
    await sleep(500)
    assert.equal(fs.existsSync(path.join(dir, 'config.json')), false)
    assert.equal(run.p.exitCode, null, 'pair should still be waiting')
    assert.ok(await watchPair(c)); assert.equal(await run.exit, 0)
  })

  test('the code shown on the watch, typed on the Mac, pairs', async () => {
    const dir = tmpDir(); const c = code()
    const watch = watchPair(c) // the watch offers as soon as it shows the code
    await sleep(150)
    // Lowercase and a dash are fine; CLAUDE_WATCH_NOTES_PAIR_CODE is ignored when a code is typed.
    const run = runPair(dir, code(), 15000, `${c.slice(0, 4).toLowerCase()}-${c.slice(4)}`)
    const w = await watch
    assert.ok(w, 'watch never got an ack'); assert.equal(await run.exit, 0)
    assert.match(run.out, /Looking for your watch/)
    assert.doesNotMatch(run.out, /Pairing code:/)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')), { topicURL: w.topic, key: w.key })
  })

  test('a typed code that no watch shows times out with advice', async () => {
    const dir = tmpDir()
    const run = runPair(dir, code(), 800, code())
    assert.equal(await run.exit, 1)
    assert.match(run.out, /No watch answered/)
    assert.equal(fs.existsSync(path.join(dir, 'config.json')), false)
  })

  test('a typed code of the wrong length is refused', async () => {
    const run = runPair(tmpDir(), code(), 15000, 'K7QX-M2')
    assert.equal(await run.exit, 1)
    assert.match(run.out, /8 letters and digits/)
  })

  test('a wrong code never pairs', async () => {
    const dir = tmpDir(); const c = code()
    const run = runPair(dir, c, 2500)
    await sleep(300)
    assert.equal(await watchPair(c.replace(/^./, ch => (ch === 'A' ? 'B' : 'A'))), null)
    assert.equal(await run.exit, 1)
    assert.match(run.out, /Timed out/)
    assert.equal(fs.existsSync(path.join(dir, 'config.json')), false)
  })
})

describe('inbox and done commands (/handoff:inbox without the plugin running a server)', () => {
  const CLI = new URL('../cli/handoff.mjs', import.meta.url).pathname
  const run = (args, env) => new Promise(r => {
    const p = spawn(process.execPath, [CLI, ...args], { env })
    spawned.add(p)
    let out = ''
    p.stdout.on('data', d => { out += d }); p.stderr.on('data', d => { out += d })
    p.on('exit', code => r({ code, out }))
  })

  test('unpair forgets the pairing and keeps the notes', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cwn-unpair-'))
    fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({ topicURL: 'https://ntfy.sh/cw-x', key: 'a2V5' }))
    fs.mkdirSync(path.join(d, 'notes')); fs.writeFileSync(path.join(d, 'notes', 'n1.json'), '{}')
    let r = await run(['unpair'], { ...process.env, CLAUDE_WATCH_NOTES_DIR: d })
    assert.match(r.out, /Unpaired/)
    assert.equal(fs.existsSync(path.join(d, 'config.json')), false)
    assert.equal(fs.existsSync(path.join(d, 'notes', 'n1.json')), true)
    r = await run(['unpair'], { ...process.env, CLAUDE_WATCH_NOTES_DIR: d })
    assert.match(r.out, /Not paired/)
  })

  test('inbox fetches notes waiting on the relay; done marks one done and sends the suggestion', async () => {
    const dir = tmpDir(); const cfg = pairDir(dir)
    const env = { ...process.env, CLAUDE_WATCH_NOTES_DIR: dir, CLAUDE_WATCH_NOTES_RELAY: mock.url, CLAUDE_WATCH_NOTES_CHANNEL: '1' }
    const n = note('rename the button')
    await post(cfg.topicURL, seal(n, cfg.key))
    let r = await run(['inbox'], env)
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, new RegExp(`note_id=${n.id}`))
    assert.match(r.out, /rename the button/)
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'notes', `${n.id}.json`), 'utf8')).status, 'new') // not claimed

    r = await run(['done', n.id, 'Renamed', 'it', '--suggestion', 'add a test'], env)
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /Suggestion sent/)
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'notes', `${n.id}.json`), 'utf8'))
    assert.equal(saved.status, 'done'); assert.equal(saved.summary, 'Renamed it'); assert.equal(saved.suggestion, 'add a test')
    assert.match((await run(['inbox'], env)).out, /No pending watch notes/)
    assert.equal((await run(['done', 'nope', 'x'], env)).code, 1)
  })
})

describe('your own relay (handoff relay)', () => {
  const topic = () => `cw-${crypto.randomBytes(16).toString('hex')}`
  const poll = async (url, since = 'all') => (await (await fetch(`${url}/json?poll=1&since=${since}`)).text()).split('\n').filter(Boolean).map(l => JSON.parse(l))

  test('publishes, polls since an id, streams, and keeps messages across a restart', async () => {
    const dir = tmpDir()
    let r = await startRelay({ dir })
    const t = `${r.url}/${topic()}`
    const a = await post(t, 'one'), b = await post(t, 'two')
    assert.deepEqual((await poll(t)).map(e => e.message), ['one', 'two'])
    assert.deepEqual((await poll(t, a.id)).map(e => e.id), [b.id])
    assert.deepEqual((await poll(t, '10m')).length, 2)
    const ctrl = new AbortController(), got = []
    const res = await fetch(`${t}/json?since=${b.id}`, { signal: ctrl.signal })
    const reading = (async () => { for await (const c of res.body) { got.push(...String(Buffer.from(c)).split('\n').filter(Boolean).map(l => JSON.parse(l))); if (got.some(e => e.message === 'three')) break } })()
    await sleep(100); await post(t, 'three'); await reading; ctrl.abort()
    assert.equal(got[0].event, 'open'); assert.ok(got.some(e => e.message === 'three'))
    await r.close(); await sleep(200) // lets fetch drop its kept-alive connection to the old one
    r = await startRelay({ dir, port: Number(new URL(t).port) })
    try { assert.deepEqual((await poll(t)).map(e => e.message), ['one', 'two', 'three']) } finally { await r.close() }
  })

  test('big bodies become attachments, with no 2 MB limit like ntfy.sh', async () => {
    const r = await startRelay({ dir: tmpDir(), publicURL: undefined })
    try {
      const t = `${r.url}/${topic()}-i`
      const big = crypto.randomBytes(5 * 1024 * 1024).toString('base64') // about 7 MB, like a sealed 4 MB GIF
      const ev = await post(t, big)
      assert.equal(ev.attachment.size, big.length)
      assert.equal(await (await fetch(ev.attachment.url)).text(), big)
      assert.equal((await fetch(`${t}`, { method: 'POST', body: Buffer.alloc(17 * 1024 * 1024) })).status, 413)
    } finally { await r.close() }
  })

  test("only Handoff's topics, and a health check", async () => {
    const r = await startRelay({ dir: tmpDir() })
    try {
      assert.deepEqual(await (await fetch(`${r.url}/v1/health`)).json(), { healthy: true })
      for (const bad of ['mytopic', 'cw-123', `cw-${'a'.repeat(32)}-xyz`, '..%2Fx'])
        assert.equal((await fetch(`${r.url}/${bad}`, { method: 'POST', body: 'x' })).status, 404, bad)
      assert.equal((await fetch(`${r.url}/file/..%2Fmessages.jsonl`)).status, 404)
    } finally { await r.close() }
  })

  test('through ntfy.sh, a GIF over 1.1 MB is refused with advice', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ topicURL: `https://ntfy.sh/${topic()}`, key: crypto.randomBytes(32).toString('base64') }))
    const s = startServer(dir, { env: { CLAUDE_WATCH_NOTES_RELAY: 'http://127.0.0.1:9' } })
    try {
      await s.ready
      const id = 'GIFTEST1'
      fs.mkdirSync(path.join(dir, 'notes'), { recursive: true })
      fs.writeFileSync(path.join(dir, 'notes', `${id}.json`), JSON.stringify({ id, text: 'x', at: new Date().toISOString(), status: 'sent' }))
      const gif = path.join(dir, 'clip.gif')
      fs.writeFileSync(gif, Buffer.concat([Buffer.from('GIF89a'), crypto.randomBytes(1200 * 1024)]))
      const r = await s.request('tools/call', { name: 'watch_note_done', arguments: { note_id: id, summary: 'ok', image: gif } })
      assert.ok(r.result.isError); assert.match(r.result.content[0].text, /through ntfy.sh it must be under 1100 KB.*handoff relay setup/s)
      assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'notes', `${id}.json`), 'utf8')).status, 'sent')
    } finally { await s.stop() }
  })

  test("the Mac's server gets notes and sends a big GIF through it", async () => {
    const r = await startRelay({ dir: tmpDir() })
    const dir = tmpDir(), t = topic(), key = crypto.randomBytes(32)
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ topicURL: `${r.url}/${t}`, key: key.toString('base64') }))
    const s = startServer(dir)
    try {
      await s.ready
      await sleep(500)
      const n = note('through my own relay')
      await post(`${r.url}/${t}`, seal(n, key))
      await s.waitFor(pushFor(n.id), 5000, 'note push')
      const gif = path.join(dir, 'clip.gif')
      fs.writeFileSync(gif, Buffer.concat([Buffer.from('GIF89a'), crypto.randomBytes(3 * 1024 * 1024)]))
      const done = await s.request('tools/call', { name: 'watch_note_done', arguments: { note_id: n.id, summary: 'ok', image: gif } })
      assert.ok(!done.result.isError, JSON.stringify(done.result))
      const [ev] = await poll(`${r.url}/${t}-i`)
      const body = await (await fetch(ev.attachment.url)).text()
      assert.ok(body.length > 4 * 1024 * 1024)
      assert.equal(Buffer.from(openBox(body, key).i, 'base64').subarray(0, 6).toString(), 'GIF89a')
    } finally { await s.stop(); await r.close() }
  })
})
