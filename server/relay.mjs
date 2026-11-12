// Shared by the MCP server and the `handoff` command: relay address, local config,
// the sealing format, and ntfy's streaming JSON subscription.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const RELAY = process.env.CLAUDE_WATCH_NOTES_RELAY || 'https://ntfy.sh' // must match Relay.base in the watch app
export const DIR = process.env.CLAUDE_WATCH_NOTES_DIR || path.join(os.homedir(), '.claude-watch-notes')
export const CONFIG = path.join(DIR, 'config.json')
export const readConfig = () => { try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')) } catch { return null } }

// Your own relay (`handoff relay setup`): its public https address, which new pairings move to.
// Pairing itself still starts on ntfy.sh, where the watch looks for the Mac.
export const OWN_RELAY = path.join(DIR, 'relay.json')
export const ownRelay = () => {
  if (process.env.CLAUDE_WATCH_NOTES_OWN_RELAY !== undefined) return process.env.CLAUDE_WATCH_NOTES_OWN_RELAY || null
  try { return JSON.parse(fs.readFileSync(OWN_RELAY, 'utf8')).url || null } catch { return null }
}

// AES-256-GCM in CryptoKit's "combined" layout: nonce(12) | ciphertext | tag(16), base64.
export function open(b64, key) {
  const b = Buffer.from(b64, 'base64')
  if (b.length < 29) throw new Error('short')
  const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12))
  d.setAuthTag(b.subarray(-16))
  return JSON.parse(Buffer.concat([d.update(b.subarray(12, -16)), d.final()]).toString('utf8'))
}
export function seal(obj, key) {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([c.update(JSON.stringify(obj)), c.final()])
  return Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64')
}

// Yields ntfy events from a streaming JSON subscription.
// If nothing (not even a keepalive) arrives for `idleMs`, the connection is treated as dead.
export async function* events(url, signal, idleMs = Number(process.env.CLAUDE_WATCH_NOTES_IDLE_MS) || 120_000) {
  const idle = new AbortController()
  let timer
  const kick = () => { clearTimeout(timer); timer = setTimeout(() => idle.abort(new Error('connection idle')), idleMs) }
  kick()
  try {
    const res = await fetch(url, { signal: AbortSignal.any([signal, idle.signal]) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    yield* lines(res.body, kick)
  } catch (e) {
    throw idle.signal.aborted && !signal.aborted ? idle.signal.reason : e
  } finally {
    clearTimeout(timer)
  }
}

async function* lines(body, kick) {
  const dec = new TextDecoder()
  let pending = ''
  for await (const chunk of body) {
    kick()
    pending += dec.decode(chunk, { stream: true })
    let i
    while ((i = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, i)
      pending = pending.slice(i + 1)
      if (line) yield JSON.parse(line)
    }
  }
}

// ---------- notes on disk ----------
// Several processes (each Claude Code session's server, and `handoff host`) share this folder.
// Each note file is created exactly once (O_EXCL), and claim markers, also O_EXCL and never moved,
// decide which process handles it. Updates are write-then-rename so readers never see half a file.
export const NOTES = path.join(DIR, 'notes')
export const noteFile = id => path.join(NOTES, `${id.replace(/[^\w-]/g, '')}.json`)

export const writeAtomic = (f, data) => {
  const tmp = `${f}.${process.pid}.tmp`
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, f)
}

// Claim markers are generations: <id>.claim, then <id>.claim.1, .2… when a note is rescued.
// Each is created with O_EXCL, so exactly one process wins each generation.
const claimFile = (id, gen) => noteFile(id).replace(/\.json$/, gen ? `.claim.${gen}` : '.claim')

export function tryClaim(id, gen = 0) {
  try { fs.writeFileSync(claimFile(id, gen), `${process.pid} channel`, { flag: 'wx' }); return true } catch { return false }
}

export function currentClaim(id) {
  let gen = 0
  while (fs.existsSync(claimFile(id, gen + 1))) gen++
  try {
    const f = claimFile(id, gen)
    const [pid, kind] = fs.readFileSync(f, 'utf8').trim().split(' ')
    return { gen, pid: Number(pid), channel: kind === 'channel', age: Date.now() - fs.statSync(f).mtimeMs }
  } catch { return null }
}

export const alive = pid => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }

// Decrypts a note event from the watch and saves it (once). Returns {note, created}, or null if
// it isn't a note from our watch.
export async function saveNote(ev, key) {
  if (ev.event !== 'message') return null
  let body = ev.message
  // ntfy turns bodies of 4 KB or more into attachments (kept ~3h on ntfy.sh).
  if (ev.attachment?.url && ev.attachment.size <= 64 * 1024) {
    try { body = await (await fetch(ev.attachment.url, { signal: AbortSignal.timeout(30_000) })).text() } catch { return null }
  }
  let p
  try { p = open(body, key) } catch { return null } // not from our watch: drop silently
  const id = String(p.id || ev.id).replace(/[^\w-]/g, '').slice(0, 64)
  if (!id) return null
  const at = typeof p.ts === 'string' && !isNaN(Date.parse(p.ts)) ? p.ts : new Date(ev.time * 1000).toISOString()
  const note = { id, text: String(p.t ?? '').slice(0, 20000), at, status: 'new' }
  if (typeof p.to === 'string' && p.to) note.to = p.to.slice(0, 40)
  fs.mkdirSync(NOTES, { recursive: true, mode: 0o700 })
  // Created once: a retried or concurrently received copy of the same note fails here.
  try { fs.writeFileSync(noteFile(id), JSON.stringify(note, null, 2), { flag: 'wx' }); return { note, created: true } } catch {}
  try { return { note: JSON.parse(fs.readFileSync(noteFile(id), 'utf8')), created: false } } catch { return { note, created: false } }
}

// ---------- daily recap ----------
// Each evening (6 PM on this Mac, or CLAUDE_WATCH_NOTES_RECAP_HOUR) the watch gets one line per
// chat: the notes it finished today, in the user's own words (never Claude's summaries). Every
// Handoff process tries; a marker file (O_EXCL) makes sure only one sends it.
const RECAP_HOUR = () => Number(process.env.CLAUDE_WATCH_NOTES_RECAP_HOUR ?? 18)
const dayOf = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

export function recap(now = new Date()) {
  const day = dayOf(now)
  const chats = {}
  let files = []
  try { files = fs.readdirSync(NOTES).filter(f => f.endsWith('.json')) } catch {}
  for (const f of files) {
    let n
    try { n = JSON.parse(fs.readFileSync(path.join(NOTES, f), 'utf8')) } catch { continue }
    if (n.status !== 'done' || n.source === 'email' || !n.doneAt || dayOf(new Date(n.doneAt)) !== day) continue
    ;(chats[n.chat || n.to || 'Claude'] ??= []).push({ t: n.text.split('\n')[0].slice(0, 80), at: n.doneAt })
  }
  return { recap: day, lines: Object.entries(chats).sort().map(([chat, done]) =>
    ({ chat, done: done.sort((a, b) => a.at.localeCompare(b.at)).map(d => d.t).slice(-10), count: done.length })) }
}

/// Sends today's recap once, after the recap hour, if anything got done. `post` sends it to the watch.
export async function sendRecapIfDue(post, now = new Date()) {
  if (now.getHours() < RECAP_HOUR()) return false
  const r = recap(now)
  if (!r.lines.length) return false
  const marker = path.join(DIR, `recap-${r.recap}`)
  try { fs.writeFileSync(marker, String(process.pid), { flag: 'wx' }) } catch { return false } // sent already
  if (await post(r)) return true
  fs.rmSync(marker, { force: true }) // try again next time
  return false
}

// ---------- recurring tasks ----------
// The watch keeps the list and sends all of it, sealed, on "<topic>-r" whenever it changes; the
// newest list wins. Every Handoff process on this Mac runs them: when one is due, its note is made
// with a fixed id (O_EXCL), so it's made once however many processes notice, and then delivered
// like any watch note. One missed while the Mac was asleep runs when it wakes, up to 2 hours late.
export const SCHEDULES = path.join(DIR, 'schedules.json')
const LATE_MS = 2 * 3_600_000

export function saveSchedules(p) {
  if (!Array.isArray(p?.schedules) || isNaN(Date.parse(p.ts))) return false
  let cur = {}
  try { cur = JSON.parse(fs.readFileSync(SCHEDULES, 'utf8')) } catch {}
  if (cur.ts && Date.parse(cur.ts) >= Date.parse(p.ts)) return false // older than what we have
  const int = (v, max) => Number.isInteger(v) && v >= 0 && v <= max
  const list = p.schedules.slice(0, 20).filter(s => /^[\w-]{1,40}$/.test(s?.id) && typeof s.t === 'string' && s.t.trim() &&
    ['hour', 'day', 'weekday'].includes(s.every) && int(s.h ?? 0, 23) && int(s.m, 59) && !isNaN(Date.parse(s.since)))
    .map(s => ({ id: s.id, t: s.t.slice(0, 2000), every: s.every, h: s.h ?? 0, m: s.m, since: s.since,
      ...(typeof s.to === 'string' && s.to && { to: s.to.slice(0, 40) }) }))
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 })
  writeAtomic(SCHEDULES, JSON.stringify({ ts: p.ts, list }, null, 2))
  return true
}

// When `s` last came due at or before `now`, in this Mac's time zone.
export function lastDue(s, now = new Date()) {
  const d = new Date(now)
  d.setSeconds(0, 0)
  if (s.every === 'hour') {
    d.setMinutes(s.m)
    if (d > now) d.setHours(d.getHours() - 1)
    return d
  }
  d.setHours(s.h, s.m)
  if (d > now) d.setDate(d.getDate() - 1)
  if (s.every === 'weekday') while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1)
  return d
}

// Makes the notes for recurring tasks that are due. Returns the ones this call made.
export function runDueSchedules(now = new Date()) {
  let list = []
  try { list = JSON.parse(fs.readFileSync(SCHEDULES, 'utf8')).list ?? [] } catch { return [] }
  const made = []
  for (const s of list) {
    const due = lastDue(s, now)
    if (due < Date.parse(s.since) || now - due > LATE_MS) continue
    const note = { id: `sched-${s.id}-${due.getTime()}`, text: s.t, at: due.toISOString(), status: 'new', source: 'schedule', ...(s.to && { to: s.to }) }
    fs.mkdirSync(NOTES, { recursive: true, mode: 0o700 })
    try { fs.writeFileSync(noteFile(note.id), JSON.stringify(note, null, 2), { flag: 'wx' }); made.push(note) } catch {} // made already
  }
  return made
}
