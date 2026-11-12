// Your own relay, instead of ntfy.sh: the small part of ntfy that Handoff uses, run on this Mac by
// `handoff relay` and put on the internet with zrok. Like ntfy.sh it only ever sees
// sealed messages (the watch and the Mac encrypt everything), so it can't read your notes.
//
//   POST /<topic>                       publish; bodies of 4 KB or more become attachments
//   GET  /<topic>/json?since=…[&poll=1] messages since an id, a duration (10m) or a time; streams unless poll=1
//   GET  /file/<name>                   an attachment
//   GET  /v1/health                     {"healthy":true}
//
// Only Handoff's topics are accepted (cw-<32 hex>[-x] and cwp-<32 hex>). Messages and attachments
// are kept 12 hours, on disk, so a restart or a sleeping Mac doesn't lose them.
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

const TOPIC = /^cwp?-[0-9a-f]{32}(-[a-z])?$/
const KEEP_MS = 12 * 3600_000
const MAX_BODY = 16 * 1024 * 1024 // a 4 MB GIF, sealed twice over in base64, is about 7 MB
const MAX_FILES = 300 * 1024 * 1024 // attachments on disk; the oldest go first
const PER_TOPIC = 500 // newest messages kept per topic
const ATTACH_AT = 4096 // like ntfy: the Mac and the watch read big bodies from the attachment url
const KEEPALIVE_MS = 45_000

export async function startRelay({ port = 0, host = '127.0.0.1', dir, publicURL } = {}) {
  const files = path.join(dir, 'files')
  fs.mkdirSync(files, { recursive: true, mode: 0o700 })
  const log = path.join(dir, 'messages.jsonl')
  const topics = new Map() // topic -> [event], oldest first
  const streams = new Set() // { topic, res }
  // publicURL may be a function: the address can change, or be known only after the relay started.
  const baseURL = () => (typeof publicURL === 'function' ? publicURL() : publicURL) || local

  // Messages from before a restart, minus expired ones.
  const now = () => Math.floor(Date.now() / 1000)
  try {
    for (const line of fs.readFileSync(log, 'utf8').split('\n')) {
      if (!line) continue
      try { const ev = JSON.parse(line); if (TOPIC.test(ev.topic)) add(ev) } catch {}
    }
  } catch {}
  prune()
  const compact = setInterval(prune, 10 * 60_000)

  function add(ev) {
    if (!topics.has(ev.topic)) topics.set(ev.topic, [])
    const list = topics.get(ev.topic)
    list.push(ev)
    if (list.length > PER_TOPIC) list.splice(0, list.length - PER_TOPIC)
  }

  // Drops expired messages and attachments, keeps attachments under MAX_FILES, and rewrites the log.
  function prune() {
    const cutoff = now() - KEEP_MS / 1000
    for (const [t, list] of topics) {
      const kept = list.filter(e => e.time >= cutoff)
      if (kept.length) topics.set(t, kept); else topics.delete(t)
    }
    const live = new Set([...topics.values()].flat().map(e => e.attachment && `${e.id}.txt`).filter(Boolean))
    let stored = []
    try { stored = fs.readdirSync(files).map(f => ({ f, ...fs.statSync(path.join(files, f)) })) } catch {}
    let total = 0
    for (const s of stored.sort((a, b) => b.mtimeMs - a.mtimeMs)) {
      total += s.size
      if (!live.has(s.f) || total > MAX_FILES) fs.rmSync(path.join(files, s.f), { force: true })
    }
    const tmp = `${log}.tmp`
    fs.writeFileSync(tmp, [...topics.values()].flat().sort((a, b) => a.seq - b.seq).map(e => JSON.stringify(e) + '\n').join(''), { mode: 0o600 })
    fs.renameSync(tmp, log)
  }

  let seq = Math.max(0, ...[...topics.values()].flat().map(e => e.seq || 0)) + 1
  const strip = ({ seq, ...ev }) => ev
  const write = (res, ev) => res.write(JSON.stringify(strip(ev)) + '\n')
  const json = (res, code, obj) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(obj) + '\n')

  function select(list, since) {
    if (!since || since === 'all') return list
    if (/^\d+$/.test(since)) return list.filter(e => e.time >= Number(since))
    const dur = /^(\d+)([smhd])$/.exec(since)
    if (dur) return list.filter(e => e.time >= now() - Number(dur[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[dur[2]])
    const i = list.findIndex(e => e.id === since)
    return i >= 0 ? list.slice(i + 1) : list
  }

  let local
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    const parts = url.pathname.split('/').filter(Boolean)
    try {
      if (req.method === 'GET' && url.pathname === '/v1/health') return json(res, 200, { healthy: true })

      if (req.method === 'GET' && parts[0] === 'file' && parts.length === 2 && /^[\w-]+\.txt$/.test(parts[1])) {
        const f = path.join(files, parts[1])
        if (!fs.existsSync(f)) return json(res, 404, { error: 'not found' })
        res.writeHead(200, { 'content-type': 'text/plain', 'content-length': fs.statSync(f).size })
        return fs.createReadStream(f).pipe(res)
      }

      const topic = parts[0]
      if (!topic || !TOPIC.test(topic)) return json(res, 404, { error: 'not found' })

      if ((req.method === 'POST' || req.method === 'PUT') && parts.length === 1) {
        if (Number(req.headers['content-length']) > MAX_BODY) return json(res, 413, { error: 'too large' })
        const chunks = []
        let size = 0
        for await (const c of req) {
          size += c.length
          if (size > MAX_BODY) return json(res, 413, { error: 'too large' })
          chunks.push(c)
        }
        const body = Buffer.concat(chunks)
        const id = crypto.randomBytes(9).toString('base64url')
        const ev = { id, time: now(), event: 'message', topic, seq: seq++ }
        if (body.length >= ATTACH_AT) {
          fs.writeFileSync(path.join(files, `${id}.txt`), body, { mode: 0o600 })
          ev.message = 'You received a file: attachment.txt'
          ev.attachment = { name: 'attachment.txt', size: body.length, url: `${baseURL()}/file/${id}.txt` }
        } else {
          ev.message = body.toString('utf8')
        }
        add(ev)
        fs.appendFileSync(log, JSON.stringify(ev) + '\n', { mode: 0o600 })
        for (const s of streams) if (s.topic === topic) write(s.res, ev)
        return json(res, 200, strip(ev))
      }

      if (req.method === 'GET' && parts[1] === 'json' && parts.length === 2) {
        const cached = select(topics.get(topic) || [], url.searchParams.get('since'))
        res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' })
        if (url.searchParams.get('poll') === '1') {
          for (const ev of cached) write(res, ev)
          return res.end()
        }
        const s = { topic, res }
        streams.add(s)
        write(res, { id: 'open', time: now(), event: 'open', topic })
        for (const ev of cached) write(res, ev)
        const ka = setInterval(() => write(res, { id: 'keepalive', time: now(), event: 'keepalive', topic }), KEEPALIVE_MS)
        req.on('close', () => { clearInterval(ka); streams.delete(s) })
        return
      }
      json(res, 404, { error: 'not found' })
    } catch (e) {
      if (!res.headersSent) json(res, 500, { error: 'relay error' })
      else res.destroy()
    }
  })
  server.requestTimeout = 0 // streams stay open
  server.headersTimeout = 30_000

  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve) })
  local = `http://${host}:${server.address().port}`
  return {
    get url() { return baseURL() },
    local,
    close() {
      clearInterval(compact)
      for (const s of streams) s.res.destroy()
      const closed = new Promise(r => server.close(r))
      server.closeAllConnections()
      return closed
    },
  }
}
