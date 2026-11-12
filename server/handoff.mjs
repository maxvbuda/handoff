#!/usr/bin/env node
// handoff: zero-dependency MCP server + Claude Code channel.
// Receives end-to-end encrypted ideas jotted on Apple Watch (relayed via ntfy)
// and pushes them into the running Claude Code session. What goes back to the watch, encrypted
// with the same key, is an optional one-line suggested next prompt, an optional screenshot of what
// Claude changed and, in `handoff start` sessions, permission prompts to answer from the wrist
// (never Claude's response).
//
//   node handoff.mjs         # MCP server (Claude Code spawns this)
//   node handoff.mjs pair CODE  # pair with the watch showing CODE
//   node handoff.mjs pair       # show a code to type on the watch (Hand-Off 1.0)
//
// This file never launches other programs. The `handoff` terminal command (../cli/) does that.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { CONFIG, DIR, NOTES, RELAY, alive, currentClaim, events, noteFile, open, readConfig, runDueSchedules, saveNote, saveSchedules, seal, tryClaim, writeAtomic } from './relay.mjs'

const CURSOR = path.join(DIR, 'cursor')

// ---------- pair ----------
// Code -> (pairing key, pairing topic) via HKDF. The watch derives the same pair,
// posts its freshly generated topic+key sealed with the pairing key, and waits for our ack.
// The watch shows the code and the user types it here; Hand-Off 1.0 works the other way around
// (we show a code to type on the watch). Either way the watch's offer is cached on the relay,
// so it doesn't matter which side starts first.
if (process.argv[2] === 'pair') {
  const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789' // no 0/O, 1/I/L
  const typed = process.argv[3]
  const code = typed !== undefined
    ? [...typed.toUpperCase()].filter(ch => ALPHABET.includes(ch)).join('')
    : process.env.CLAUDE_WATCH_NOTES_PAIR_CODE ||
      Array.from({ length: 8 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('')
  if (code.length !== 8) {
    console.error('  Codes are 8 letters and digits, like K7QX-M2PA.')
    process.exit(1)
  }
  const derive = (info, n) => Buffer.from(crypto.hkdfSync('sha256', code, 'claude-watch-notes-pair', info, n))
  const pk = derive('key', 32)
  const pairURL = `${RELAY}/cwp-${derive('topic', 16).toString('hex')}`

  if (typed !== undefined) console.log('\n  Looking for your watch…\n')
  else console.log(`\n  Pairing code:  ${code.slice(0, 4)}-${code.slice(4)}\n\n  Open the app on your watch and enter it. Waiting up to 10 minutes…\n`)
  try {
    // The pairing topic is derived from a fresh random code, so everything on it is from this attempt.
    // A watch already showing the code has posted its offer, so a typed code needs only a short wait.
    const timeout = AbortSignal.timeout(Number(process.env.CLAUDE_WATCH_NOTES_PAIR_TIMEOUT_MS) || (typed !== undefined ? 60_000 : 600_000))
    for await (const ev of events(`${pairURL}/json?since=all`, timeout)) {
      if (ev.event !== 'message') continue
      let p
      try { p = open(ev.message, pk) } catch { continue }
      const topicOK = typeof p.topic === 'string' && p.topic.startsWith(`${RELAY}/cw-`) &&
        /^[0-9a-f]{32}$/.test(p.topic.slice(RELAY.length + 4))
      if (typeof p.n !== 'string' || Buffer.from(String(p.key), 'base64').length !== 32 || !topicOK) continue
      fs.mkdirSync(DIR, { recursive: true, mode: 0o700 })
      fs.writeFileSync(CONFIG, JSON.stringify({ topicURL: p.topic, key: p.key }, null, 2), { mode: 0o600 })
      await fetch(pairURL, { method: 'POST', body: seal({ ack: p.n }, pk) })
      console.log('  Paired. Running Claude Code sessions pick this up automatically.\n\n  Next: handoff start\n')
      process.exit(0)
    }
  } catch (e) {
    if (e.name !== 'TimeoutError') console.error(`  ${e.message}`)
    else if (typed !== undefined) console.error('  No watch answered. Check the code on your watch (it changes after 10 minutes) and try again.')
    else console.error('  Timed out. Run pair again for a new code.')
  }
  process.exit(1)
}

// ---------- MCP over stdio ----------
fs.mkdirSync(NOTES, { recursive: true, mode: 0o700 })

const out = msg => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
const log = (...a) => process.stderr.write(`[handoff] ${a.join(' ')}\n`)
let ready = false
// Sessions `handoff start` opens run this server and listen on the channel (it sets this).
// Others that run it (`handoff inbox`, host chats) must not claim notes they'd ignore.
const CHANNEL = process.env.CLAUDE_WATCH_NOTES_CHANNEL === '1'
// The chat's name on the watch (`handoff start --name`, else the project folder). Notes sent
// to a chat by name only go to sessions with that name; notes sent to "any chat" go to any of them.
const NAME = (process.env.CLAUDE_WATCH_NOTES_NAME || path.basename(process.cwd()) || 'Claude').slice(0, 40)
const forMe = n => !n.to || n.to === NAME

const INSTRUCTIONS = `Ideas the user jotted on their Apple Watch arrive from this server as <channel note_id="..." at="..."> events.
The user is away from the computer and will not see or answer questions: treat each note as a task to complete autonomously in the current project, making reasonable assumptions (write them down in your final summary). Notes are terse, dictated, and may contain transcription errors.
If an action is blocked or denied by the permission system, do not retry it or look for a way around it: skip that step, finish what you can, and list what was blocked in your summary for the user to do when they get home.
Claude's response is never sent to the watch. Every note must end with a call to watch_note_done with its note_id and a short summary, including quick questions (put the answer in the summary) and notes you decide not to act on. Answering in the terminal alone is not enough: the user isn't there, and watch_note_done is how the result is saved for them and how the suggestion reaches the watch.
You may also pass a suggestion: the one prompt the user would most likely send next, written as the user would type it (under 80 characters, e.g. "add tests for the new parser"). It appears on the watch with an Accept suggestion button that sends it back to you as a new note. Leave it out when there's no obvious next step.
When the note changed something the user can look at (a web page, an app's screen), you may also pass image: the absolute path of a screenshot of it, which the user sees on their watch. Make it yourself, for example with headless Chrome (--headless --screenshot=FILE --window-size=1280,800 URL), then shrink it with \`sips -Z 480 -s format jpeg -s formatOptions 70 FILE --out SMALL.jpg\`. It must be a PNG or JPEG under 300 KB. Leave it out when there's nothing to see.
Notes with source="email" were emailed by the user instead: the summary is emailed back to them, so write it for them to read.
Notes with source="schedule" are recurring tasks the user set up on the watch; they come back on schedule, so do this run's work only.
If you were not started as a channel, call watch_inbox to fetch pending notes.`

const TOOLS = [
  {
    name: 'watch_inbox',
    description: 'List ideas from the Apple Watch that are not done yet.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'watch_note_done',
    description: 'Mark a watch note as done, with a short summary of what was done (stays on this machine; for emailed notes it is also emailed back).',
    inputSchema: {
      type: 'object',
      properties: {
        note_id: { type: 'string' },
        summary: { type: 'string' },
        suggestion: { type: 'string', description: 'Optional: the next prompt the user would most likely send, as they would type it (under 80 characters). Shown on the watch with an Accept suggestion button.' },
        image: { type: 'string', description: 'Optional: absolute path of a screenshot of what you changed (PNG or JPEG, under 300 KB; about 480 px wide is plenty). Shown on the watch.' },
      },
      required: ['note_id', 'summary'],
    },
  },
]

const allNotes = () => fs.readdirSync(NOTES).filter(f => f.endsWith('.json'))
  .map(f => { try { return JSON.parse(fs.readFileSync(path.join(NOTES, f), 'utf8')) } catch { return null } })
  .filter(Boolean).sort((a, b) => String(a.at).localeCompare(String(b.at)))

function push(note) {
  out({
    method: 'notifications/claude/channel',
    params: { content: note.text, meta: { note_id: note.id, at: note.at, ...(note.source && { source: note.source }) } },
  })
}

// Messages back to the watch are sealed with the pairing key on side topics it polls:
// "<topic>-s" for suggestions, "<topic>-c" for which chats are open, "<topic>-p" for permission prompts.
async function postBack(suffix, obj, timeout = 20_000) {
  const cfg = readConfig()
  if (!cfg) return false
  try {
    const body = seal(obj, Buffer.from(cfg.key, 'base64'))
    return (await fetch(`${cfg.topicURL}-${suffix}`, { method: 'POST', body, signal: AbortSignal.timeout(timeout) })).ok
  } catch { return false }
}
const sendSuggestion = (text, noteId) => postBack('s', { s: text, note: noteId, chat: NAME, ts: new Date().toISOString() })
// Screenshots go on "<topic>-i". At this size the relay keeps each as an attachment (about 3 hours).
const sendImage = (img, noteId) => postBack('i', { i: img.toString('base64'), note: noteId, chat: NAME, ts: new Date().toISOString() }, 60_000)

// Claude makes the screenshot (this server runs nothing); we only check it's a small PNG or JPEG.
const IMAGE_MAX = 300 * 1024
function readImage(p) {
  const f = path.resolve(p)
  let st
  try { st = fs.statSync(f) } catch { throw new Error(`Can't read the image ${f}. Nothing was marked done; try again with a screenshot that exists, or without image.`) }
  if (!st.isFile()) throw new Error(`${f} isn't a file. Nothing was marked done.`)
  if (st.size > IMAGE_MAX) throw new Error(`The image is ${Math.round(st.size / 1024)} KB; it must be under 300 KB. Nothing was marked done. Shrink it (sips -Z 480 -s format jpeg -s formatOptions 70 FILE --out SMALL.jpg) and try again.`)
  const b = fs.readFileSync(f)
  const png = b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  const jpeg = b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff
  if (!png && !jpeg) throw new Error(`${f} isn't a PNG or JPEG. Nothing was marked done.`)
  return b
}

// Listening sessions announce themselves every minute so the watch can list them by name.
const HEARTBEAT_MS = Number(process.env.CLAUDE_WATCH_NOTES_HEARTBEAT_MS) || 60_000
// The heartbeat also says which note this chat is working on, for the watch's Projects screen.
const working = () => allNotes().find(n => n.status === 'sent' && currentClaim(n.id)?.pid === process.pid)?.text.slice(0, 120)
const heartbeat = () => postBack('c', { chat: NAME, working: working(), ts: new Date().toISOString() })
let beat // several changes at once (a burst of notes) send one heartbeat
const beatSoon = () => { clearTimeout(beat); beat = setTimeout(heartbeat, 300) }
if (CHANNEL) setInterval(heartbeat, HEARTBEAT_MS)
let lastPairing = readConfig()?.topicURL
fs.watchFile(CONFIG, { interval: 2000 }, () => { // re-paired: announce on the new topic right away
  const t = readConfig()?.topicURL
  if (CHANNEL && ready && t && t !== lastPairing) heartbeat()
  lastPairing = t
})

// ---------- permission relay: approve or deny tool use from the watch ----------
// Only `handoff start` sessions (channels) opt in. Claude Code sends each permission prompt here as
// it opens it in the terminal; we post it sealed to "<topic>-p", and the watch answers sealed on
// "<topic>-v". Whichever answer comes first, terminal or watch, is the one Claude Code applies.
// Only ids this session was asked about are answered, each once, and only from our paired watch.
const ASKED_MS = 15 * 60_000
const asked = new Map() // request_id -> time asked
function askWatch({ request_id, tool_name, description, input_preview } = {}) {
  if (!/^[a-km-z]{5}$/.test(String(request_id))) return
  for (const [id, at] of asked) if (Date.now() - at > ASKED_MS) asked.delete(id)
  asked.set(request_id, Date.now())
  postBack('p', { p: request_id, tool: String(tool_name ?? '').slice(0, 80), what: String(description ?? '').slice(0, 300),
    input: String(input_preview ?? '').slice(0, 1500), chat: NAME, ts: new Date().toISOString() })
}
function verdict(v) {
  const id = String(v?.v ?? '')
  if (!asked.has(id) || typeof v.ok !== 'boolean' || (v.chat && v.chat !== NAME)) return
  asked.delete(id)
  log('watch', v.ok ? 'allowed' : 'denied', id)
  out({ method: 'notifications/claude/channel/permission', params: { request_id: id, behavior: v.ok ? 'allow' : 'deny' } })
}

// Follows a side topic from the watch, sealed with the pairing key: reconnects with backoff and
// starts over on the new topic when re-paired. `since` is asked again on each (re)connect.
const following = new Set()
fs.watchFile(CONFIG, { interval: 2000 }, () => following.forEach(c => c.abort()))
async function follow(suffix, since, handle) {
  for (let delay = 1000; ; delay = Math.min(delay * 2, 60000)) {
    const cfg = readConfig()
    if (cfg) {
      const key = Buffer.from(cfg.key, 'base64')
      const ctrl = new AbortController()
      following.add(ctrl)
      try {
        for await (const ev of events(`${cfg.topicURL}${suffix}/json?since=${since()}`, ctrl.signal)) {
          delay = 1000
          if (ev.event === 'message') try { handle(open(ev.message, key)) } catch {} // not from our watch
        }
      } catch {
        if (ctrl.signal.aborted) delay = 500
      }
      following.delete(ctrl)
    }
    await new Promise(r => setTimeout(r, cfg ? delay : 5000))
  }
}
if (CHANNEL) {
  // Only answers from now on: a prompt is never older than this session.
  const started = Math.floor(Date.now() / 1000) - 5
  follow('-v', () => String(started), verdict)
  // The newest list of recurring tasks the relay still has (it keeps 12 hours).
  follow('-r', () => '12h', p => { if (saveSchedules(p)) sweep() })
}

async function quit() {
  // Tell the watch this chat is gone, so it drops off the list now instead of in a few minutes.
  if (CHANNEL && ready) await postBack('c', { chat: NAME, gone: true, ts: new Date().toISOString() }, 3000)
  process.exit(0)
}

async function callTool(name, args = {}) {
  if (name === 'watch_inbox') {
    const pending = allNotes().filter(n => n.status !== 'done')
    return pending.length
      ? pending.map(n => `note_id=${n.id} at=${n.at}${n.to ? ` to=${n.to}` : ''}\n${n.text}`).join('\n\n---\n\n')
      : 'No pending watch notes.'
  }
  if (name === 'watch_note_done') {
    const f = noteFile(String(args.note_id || ''))
    let n
    try { n = JSON.parse(fs.readFileSync(f, 'utf8')) } catch { throw new Error(`No watch note with id ${args.note_id}`) }
    const image = typeof args.image === 'string' && args.image.trim() ? readImage(args.image.trim()) : null // before anything is saved
    Object.assign(n, { status: 'done', summary: args.summary, doneAt: new Date().toISOString() })
    const suggestion = typeof args.suggestion === 'string' ? args.suggestion.trim().slice(0, 200) : ''
    if (suggestion) n.suggestion = suggestion
    writeAtomic(f, JSON.stringify(n, null, 2))
    if (CHANNEL && ready) beatSoon() // not working on it anymore
    if (n.source === 'email') return `Marked ${n.id} done. \`handoff mail\` will email the summary back.`
    const said = [`Marked ${n.id} done.`]
    if (suggestion) said.push(await sendSuggestion(suggestion, n.id)
      ? 'Suggestion sent to the watch.' : "The suggestion couldn't be sent to the watch (relay unreachable).")
    if (image) said.push(await sendImage(image, n.id)
      ? 'Screenshot sent to the watch.' : "The screenshot couldn't be sent to the watch (relay unreachable).")
    return said.join(' ')
  }
  throw new Error(`unknown tool: ${name}`)
}

function handle(msg) {
  const { id, method, params } = msg
  if (method === 'initialize') {
    return out({ id, result: {
      protocolVersion: params?.protocolVersion || '2025-06-18',
      capabilities: { tools: {}, experimental: { 'claude/channel': {}, ...(CHANNEL && { 'claude/channel/permission': {} }) } },
      serverInfo: { name: 'handoff', version: '3.2.0' },
      instructions: INSTRUCTIONS,
    } })
  }
  if (method === 'notifications/initialized') {
    ready = true
    // Hand this session anything that arrived while no session was listening.
    sweep()
    if (CHANNEL) heartbeat()
    return
  }
  if (method === 'notifications/claude/channel/permission_request') return CHANNEL && askWatch(params)
  if (id === undefined) return // other notifications
  if (method === 'ping') return out({ id, result: {} })
  if (method === 'tools/list') return out({ id, result: { tools: TOOLS } })
  if (method === 'tools/call') {
    return callTool(params.name, params.arguments).then(
      text => out({ id, result: { content: [{ type: 'text', text }] } }),
      e => out({ id, result: { content: [{ type: 'text', text: String(e.message || e) }], isError: true } }))
  }
  out({ id, error: { code: -32601, message: `Method not found: ${method}` } })
}

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (line) try { handle(JSON.parse(line)) } catch (e) { log('bad message', e.message) }
  }
})
process.stdin.on('end', quit)
process.on('SIGTERM', quit)
process.on('SIGINT', quit)

// ---------- notes ----------
const LEGACY_GRACE_MS = 2 * 60_000

// Safety net, run by listening sessions at startup and every 30s. Pushes notes nobody has taken,
// and takes back notes held by a session that wasn't listening (an older version of this plugin
// claimed notes in every session; those claims aren't marked "channel") once it has exited or
// had them for 2 minutes. Notes a listening session took aren't re-sent: it may have done the work.
// Their pending ones stay in watch_inbox.
function sweep() {
  if (!CHANNEL || !ready) return
  runDueSchedules()
  for (const n of allNotes()) {
    if (n.status === 'done') continue
    const c = currentClaim(n.id)
    if (!c) claimAndPush(n)
    else if (!c.channel && (!alive(c.pid) || c.age > LEGACY_GRACE_MS)) {
      log('rescuing', n.id, 'from session', c.pid)
      claimAndPush(n, c.gen + 1)
    }
  }
}
setInterval(sweep, Number(process.env.CLAUDE_WATCH_NOTES_SWEEP_MS) || 30_000)

function claimAndPush(n, gen = 0) {
  if (!forMe(n) || !tryClaim(n.id, gen)) return
  n = { ...n, status: 'sent' }
  writeAtomic(noteFile(n.id), JSON.stringify(n, null, 2))
  push(n)
  beatSoon() // now working on it
}

async function receive(ev, key) {
  const got = await saveNote(ev, key)
  if (!got) return
  if (got.created) log('note', got.note.id)
  // If another session saved it first, it may be one that isn't listening: still try to claim it.
  if (ready && CHANNEL) claimAndPush(got.note)
}

// ---------- ntfy subscription (auto-reconnect, reloads when re-paired) ----------
let current
fs.watchFile(CONFIG, { interval: 2000 }, () => current?.abort())

async function subscribe() {
  for (let delay = 1000; ; delay = Math.min(delay * 2, 60000)) {
    const cfg = readConfig()
    if (!cfg) {
      log('not paired yet: run `handoff pair`')
      await new Promise(r => setTimeout(r, 5000))
      continue
    }
    const key = Buffer.from(cfg.key, 'base64')
    // Cursor is "<topic> <last message id>" so a new pairing starts fresh.
    let since = '12h'
    try {
      const [topic, id] = fs.readFileSync(CURSOR, 'utf8').trim().split(' ')
      if (topic === cfg.topicURL && id) since = id
    } catch {}
    current = new AbortController()
    try {
      for await (const ev of events(`${cfg.topicURL}/json?since=${encodeURIComponent(since)}`, current.signal)) {
        delay = 1000
        await receive(ev, key)
        if (ev.event === 'message') fs.writeFileSync(CURSOR, `${cfg.topicURL} ${ev.id}`)
      }
    } catch (e) {
      if (current.signal.aborted) { log('pairing changed, reconnecting'); delay = 500; continue }
      if (e.message === 'connection idle') delay = 500
      log('subscription:', e.message)
    }
    await new Promise(r => setTimeout(r, delay))
  }
}
subscribe()
