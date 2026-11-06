#!/usr/bin/env node
// `handoff`: terminal command for Handoff. The plugin itself declares no MCP server: this command
// starts Handoff's server (server/handoff.mjs) for the Claude Code sessions it opens.
//
//   handoff pair              pair your watch (shows a code to type on it)
//   handoff start [--name N] [args...]   start Claude Code listening for ideas
//   handoff host [folder]     let the watch start chats in folder's projects (run headless here)
//   handoff mail [address]    email Claude too, through the Mail app
//   handoff inbox             print notes that aren't done (what /handoff:inbox runs)
//   handoff done <id> <summary> [--suggestion S]   mark a note done
//   handoff install           put this command on your PATH (what /handoff:setup runs)

import { spawn, execFile, execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { CONFIG, DIR, NOTES, alive, events, noteFile, open, readConfig, saveNote, seal, tryClaim, writeAtomic } from '../server/relay.mjs'

const SERVER = fileURLToPath(new URL('../server/handoff.mjs', import.meta.url))

// Handoff's MCP server, for the sessions this command opens. Its tools show up as mcp__handoff__*.
const MCP_ARGS = ['--mcp-config', JSON.stringify({ mcpServers: { handoff: { command: process.execPath, args: [SERVER] } } })]
// Custom channels need the development flag until Handoff is on Anthropic's approved list.
const CHANNEL_ARGS = ['--dangerously-load-development-channels', 'server:handoff']

const [cmd, ...rest] = process.argv.slice(2)

function run(file, args, opts) {
  const child = spawn(file, args, opts)
  child.on('error', e => {
    console.error(e.code === 'ENOENT' ? `\`${file}\` not found.` : e.message)
    process.exit(1)
  })
  child.on('exit', code => process.exit(code ?? 0))
  return child
}

if (cmd === 'start') {
  // --name sets the chat's name on the watch (default: this folder's name). Everything else goes to claude.
  let name = path.basename(process.cwd())
  const i = rest.findIndex(a => a === '--name' || a.startsWith('--name='))
  if (i >= 0) {
    const [flag, value] = rest[i].includes('=') ? [1, rest[i].slice(7)] : [2, rest[i + 1]]
    if (!value) { console.error('Usage: handoff start --name <chat name>'); process.exit(1) }
    name = value
    rest.splice(i, flag)
  }
  const claudeArgs = ['--permission-mode', 'auto', ...MCP_ARGS, ...CHANNEL_ARGS, ...rest]
  console.log(`Starting Claude Code with Handoff as the chat "${name}". Ideas from your watch will show up here.\n` +
    'Claude Code will warn about development channels: choose "I am using this for local development".\n')
  // caffeinate keeps the Mac awake (so Claude can keep working) for as long as the session runs.
  // Tells this session's Handoff server that it's listening, so it (not other open sessions) takes the notes.
  const opts = { stdio: 'inherit', env: { ...process.env, CLAUDE_WATCH_NOTES_CHANNEL: '1', CLAUDE_WATCH_NOTES_NAME: name } }
  if (process.platform === 'darwin') run('caffeinate', ['-i', 'claude', ...claudeArgs], opts)
  else run('claude', claudeArgs, opts)
} else if (cmd === 'pair') {
  const child = run(process.execPath, [SERVER, 'pair'], { stdio: ['inherit', 'pipe', 'inherit'] })
  let sent = false
  child.stdout.on('data', d => {
    process.stdout.write(d)
    const code = /Pairing code:\s+([A-Z0-9]{4})-([A-Z0-9]{4})/.exec(String(d))
    if (code && !sent) { sent = true; sendToSimulators(code[1] + code[2]) }
  })
} else if (cmd === 'host') {
  host(path.resolve(rest[0] || process.cwd()))
} else if (cmd === 'mail') {
  mail(rest[0])
} else if (cmd === 'install') {
  install()
} else if (cmd === 'inbox') {
  toolCall('watch_inbox', {}, 3000)
} else if (cmd === 'done') {
  const i = rest.indexOf('--suggestion')
  const suggestion = i >= 0 ? rest.splice(i, 2)[1] : undefined
  const [noteId, ...summary] = rest
  if (!noteId || !summary.length) { console.error('Usage: handoff done <note_id> <summary> [--suggestion "next prompt"]'); process.exit(1) }
  toolCall('watch_note_done', { note_id: noteId, summary: summary.join(' '), ...(suggestion && { suggestion }) })
} else {
  console.log(`Handoff: jot ideas on your Apple Watch; Claude Code does them while you're away.

  handoff pair              Pair your watch (shows a code to type on it)
  handoff start [args...]   Start Claude Code listening for ideas (extra args go to claude,
                            e.g. --continue to keep your last conversation)
    --name <name>           The chat's name on the watch (default: this folder's name)
  handoff host [folder]     Let the watch start new chats: lists the projects in folder
                            (default: this one) on the watch and opens a Terminal window
                            running handoff start in the one you pick
  handoff mail [address]    Email Claude too: notes you email yourself at you+claude@…
                            go to your handoff start sessions, and the summary comes back
                            as a reply. Uses the Mail app; keep this running. Only that
                            one account is listened to, and it's remembered for next time
  handoff install           Put this command on your PATH (/handoff:setup in Claude Code
                            runs it). It always runs the plugin's current version
  handoff inbox             Print the notes that aren't done yet (/handoff:inbox runs it)
  handoff done <note_id> <summary> [--suggestion "next prompt"]
                            Mark a note done (and send a suggestion to the watch)
`)
}

// One call to a Handoff server tool, for sessions that don't run the server themselves
// (/handoff:inbox). `settleMs` gives the server time to fetch notes waiting on the relay first.
function toolCall(name, args, settleMs = 0) {
  const env = { ...process.env }
  delete env.CLAUDE_WATCH_NOTES_CHANNEL // this short-lived server must not claim notes
  const child = spawn(process.execPath, [SERVER], { env, stdio: ['pipe', 'pipe', 'ignore'] })
  const send = m => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n')
  let buf = ''
  child.stdout.on('data', d => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      let m
      try { m = JSON.parse(buf.slice(0, i)) } catch {}
      buf = buf.slice(i + 1)
      if (m?.id !== 2) continue
      console.log(m.result?.content?.[0]?.text ?? m.error?.message ?? '')
      child.kill()
      process.exit(m.result?.isError || m.error ? 1 : 0)
    }
  })
  send({ id: 1, method: 'initialize', params: {} })
  send({ method: 'notifications/initialized' })
  setTimeout(() => send({ id: 2, method: 'tools/call', params: { name, arguments: args } }), settleMs)
}

// Typing on a simulated watch is painful: hand the code to any booted watch simulator with the app.
function sendToSimulators(code) {
  if (process.platform !== 'darwin') return
  try {
    const { devices } = JSON.parse(execFileSync('xcrun', ['simctl', 'list', 'devices', 'booted', '-j'], { stdio: ['ignore', 'pipe', 'ignore'] }))
    for (const [runtime, list] of Object.entries(devices)) {
      if (!runtime.includes('watchOS')) continue
      for (const d of list) {
        try {
          execFileSync('xcrun', ['simctl', 'launch', '--terminate-running-process', d.udid, 'dev.maxbuda.ClaudeNotes', '-pairCode', code], { stdio: 'ignore' })
          console.log(`  Sent the code to simulator "${d.name}".\n`)
        } catch {} // app not installed on this simulator
      }
    }
  } catch {} // no Xcode
}

// ---------- host: new chats from the watch ----------
// Lets the watch start chats in folders under `root` without anyone at the Mac. These chats run
// Claude Code headless (`claude -p`, one run per note, resuming the same session), so no channel
// and no confirmation prompt are involved. The host:
//   - announces its projects and chats on "<topic>-c", sealed, every minute;
//   - answers {ls, id} requests on "<topic>-n" with {ls, id, dirs} on "<topic>-l" (folder browsing);
//   - registers a chat for {path, name, create?} requests, and opens a Terminal window showing its log;
//   - for {open} requests, opens that chat as a normal Claude Code window in Terminal (claude --resume);
//   - takes notes addressed to its chats from the main topic and runs them, one at a time per chat.
// Paths are relative to `root`; anything that resolves outside it (.., symlinks) is refused.
function host(root) {
  if (!fs.existsSync(root)) { console.error(`No such folder: ${root}`); process.exit(1) }
  root = fs.realpathSync(root)
  // root/rel, if it's an existing folder inside root (or root itself), else null.
  const inside = rel => {
    if (typeof rel !== 'string' || rel.length > 500 || rel.includes('\0')) return null
    try {
      const real = fs.realpathSync(path.resolve(root, rel))
      return (real === root || real.startsWith(root + path.sep)) && fs.statSync(real).isDirectory() ? real : null
    } catch { return null }
  }
  const subfolders = dir => fs.readdirSync(dir, { withFileTypes: true })
    .filter(d => (d.isDirectory() || (d.isSymbolicLink() && inside(path.relative(root, path.join(dir, d.name))))) &&
      !d.name.startsWith('.') && d.name !== 'node_modules')
    .map(d => d.name).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).slice(0, 60)
  const hostName = os.hostname().replace(/\.local$/, '')
  const projects = () => subfolders(root)
  const dryRun = !!process.env.CLAUDE_WATCH_NOTES_HOST_DRYRUN // tests: don't open Terminal windows
  const q = v => `'${String(v).replace(/'/g, `'\\''`)}'` // single-quoted for the shell

  // Chats: name -> {dir, session, started, lastUsed}, kept across restarts. Each has a log file.
  const CHATS = path.join(DIR, 'host-chats.json')
  const LOGS = path.join(DIR, 'logs')
  fs.mkdirSync(LOGS, { recursive: true, mode: 0o700 })
  let chats = {}
  try { chats = JSON.parse(fs.readFileSync(CHATS, 'utf8')) } catch {}
  const saveChats = () => writeAtomic(CHATS, JSON.stringify(chats, null, 2))
  const recentChats = () => Object.keys(chats).filter(n => Date.now() - Date.parse(chats[n].lastUsed) < 3 * 86_400_000)
  const logFile = name => path.join(LOGS,
    `${name.replace(/[^\w.-]+/g, '-').slice(0, 30)}-${crypto.createHash('sha1').update(name).digest('hex').slice(0, 8)}.log`)
  const logTo = (name, text) => fs.appendFileSync(logFile(name), text)
  const resumeCommand = c => `cd ${q(c.dir)} && claude --resume ${c.session}`

  const post =(obj, timeout = 20_000, suffix = 'c') => {
    const cfg = readConfig()
    if (!cfg) return Promise.resolve()
    return fetch(`${cfg.topicURL}-${suffix}`, { method: 'POST', body: seal({ ...obj, ts: new Date().toISOString() }, Buffer.from(cfg.key, 'base64')), signal: AbortSignal.timeout(timeout) })
      .catch(() => {})
  }
  const announce = () => post({ host: hostName, root: path.basename(root), projects: projects(), chats: recentChats() })
  setInterval(announce, Number(process.env.CLAUDE_WATCH_NOTES_HEARTBEAT_MS) || 60_000)
  const quit = async () => { await post({ host: hostName, gone: true }, 3000); process.exit(0) }
  process.on('SIGINT', quit)
  process.on('SIGTERM', quit)

  console.log(`Handoff host: the watch can start chats in ${projects().length} projects in ${root}.\n` +
    'Chats started from the watch run here, with no confirmation needed. Keep this running; Ctrl+C stops it.\n')
  for (const n of recentChats()) console.log(`  chat "${n}"  (open it: ${resumeCommand(chats[n])})`)
  if (!readConfig()) console.log('Not paired yet: run `handoff pair`.')

  // Relay subscriptions: reconnect with backoff, and restart with the new key when re-paired.
  const subs = new Set()
  fs.watchFile(CONFIG, { interval: 2000 }, () => subs.forEach(c => c.abort()))
  function subscribe(suffix, since, onMessage) {
    ;(async () => {
      for (let delay = 1000; ; delay = Math.min(delay * 2, 60_000)) {
        const cfg = readConfig()
        if (!cfg) { await new Promise(r => setTimeout(r, 5000)); continue }
        const ctrl = new AbortController()
        subs.add(ctrl)
        try {
          for await (const ev of events(`${cfg.topicURL}${suffix}/json?since=${encodeURIComponent(since(cfg))}`, ctrl.signal)) {
            delay = 1000
            if (ev.event === 'message') await onMessage(ev, Buffer.from(cfg.key, 'base64'), cfg)
          }
        } catch (e) {
          if (!ctrl.signal.aborted) console.error(`relay: ${e.message}`)
        }
        subs.delete(ctrl)
        await new Promise(r => setTimeout(r, ctrl.signal.aborted ? 200 : delay))
      }
    })()
  }
  announce()

  // Requests from the watch: only ones made from now on. `since` is in whole seconds, so a restart
  // can replay a request from earlier that second; remembering handled ids stops it running twice
  // (which would start the chat over in a new conversation).
  let reqSince = String(Math.floor(Date.now() / 1000))
  const HANDLED = path.join(DIR, 'host-requests.json')
  let handled = []
  try { handled = JSON.parse(fs.readFileSync(HANDLED, 'utf8')) } catch {}
  subscribe('-n', () => reqSince, (ev, key) => {
    reqSince = ev.id
    if (handled.includes(ev.id)) return
    handled = [...handled, ev.id].slice(-50)
    try { writeAtomic(HANDLED, JSON.stringify(handled)) } catch {}
    let req
    try { req = open(ev.message, key) } catch { return } // not from our watch
    if (!(Date.now() - Date.parse(req.ts) < 10 * 60_000)) return console.log('Skipped an old request.')
    if (req.ls !== undefined) listFolder(req)
    else if (req.open !== undefined) openChat(req)
    else startChat(req)
  })

  // Notes: the host keeps its own cursor, so notes for its chats arrive with no Claude Code window open.
  const CURSOR = path.join(DIR, 'host-cursor')
  const noteSince = cfg => {
    try { const [t, id] = fs.readFileSync(CURSOR, 'utf8').trim().split(' '); if (t === cfg.topicURL && id) return id } catch {}
    return '12h'
  }
  subscribe('', noteSince, async (ev, key, cfg) => {
    const got = await saveNote(ev, key)
    if (got && chats[got.note.to] && got.note.status === 'new') take(got.note)
    fs.writeFileSync(CURSOR, `${cfg.topicURL} ${ev.id}`)
  })
  // Also pick up notes for our chats that a Claude Code window saved before we saw them.
  const sweep = () => {
    let files = []
    try { files = fs.readdirSync(NOTES).filter(f => f.endsWith('.json')) } catch {}
    for (const f of files) {
      try { const n = JSON.parse(fs.readFileSync(path.join(NOTES, f), 'utf8')); if (n.status === 'new' && chats[n.to]) take(n) } catch {}
    }
  }
  sweep()
  setInterval(sweep, Number(process.env.CLAUDE_WATCH_NOTES_SWEEP_MS) || 30_000)

  function listFolder(req) {
    const dir = inside(req.ls)
    const dirs = dir ? subfolders(dir) : null
    post({ ls: req.ls, id: String(req.id ?? ''), dirs }, 20_000, 'l')
  }

  function startChat(req) {
    let dir = inside(req.path ?? req.project) // `project`: watch builds from before folder browsing
    if (!dir) return console.log('Skipped a request for a folder outside the host folder.')
    if (req.create !== undefined) { // a new folder, made here first
      const folder = String(req.create).trim()
      if (!folder || folder.length > 60 || /[\/\u0000-\u001f\u007f]/.test(folder) || folder.startsWith('.'))
        return console.log('Skipped a request with a bad folder name.')
      dir = path.join(dir, folder)
      try { fs.mkdirSync(dir) } catch (e) { if (e.code !== 'EEXIST') return console.log(`Couldn't make ${dir}: ${e.message}`) }
    }
    const fallback = path.basename(dir)
    const name = String(req.name || fallback).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40) || fallback
    const chat = chats[name] = { dir, session: crypto.randomUUID(), started: false, lastUsed: new Date().toISOString() }
    saveChats()
    announce()
    console.log(`Started chat "${name}" in ${dir}  (open it: ${resumeCommand(chat)})`)
    logTo(name, `Chat "${name}" in ${dir}\nTo open it as a normal Claude Code window: ${resumeCommand(chat)}\nWaiting for notes from your watch…\n`)
    // A Terminal window that shows this chat's log as Claude works.
    const script = terminalScript(`Handoff: ${name}`, [`exec tail -n +1 -F ${q(logFile(name))}`])
    if (dryRun) return console.log(`LAUNCH ${JSON.stringify({ dir, name, session: chat.session, script })}`)
    openTerminal(script)
  }

  // "Open on computer" on the watch: the chat as a normal Claude Code window, continuing its
  // conversation. A chat that hasn't run a note yet has no conversation, so that opens a new one there.
  function openChat(req) {
    const name = String(req.open)
    const chat = chats[name]
    if (!chat || !inside(path.relative(root, chat.dir))) return console.log('Skipped a request to open a chat this host doesn\'t have.')
    const claude = whichClaude()
    const script = terminalScript(`Claude: ${name}`, [
      `cd ${q(chat.dir)} || exit 1`,
      chat.started ? `exec ${q(claude)} --resume ${q(chat.session)}` : `exec ${q(claude)}`,
    ])
    console.log(`Opening chat "${name}" in Terminal`)
    logTo(name, `━━ Opened in Terminal on this Mac.${chat.started ? '' : ' (No notes yet, so that window is a new conversation.)'}\n`)
    if (dryRun) return console.log(`OPEN ${JSON.stringify({ dir: chat.dir, name, session: chat.session, script })}`)
    openTerminal(script)
  }

  // A one-shot Terminal script: deletes itself, sets the window title, runs `lines`. Values are single-quoted.
  function terminalScript(title, lines) {
    return ['#!/bin/sh', 'rm -f "$0"', `printf '\\033]0;%s\\007' ${q(title)}`, ...lines].join('\n') + '\n'
  }
  function openTerminal(script) {
    const file = path.join(os.tmpdir(), `handoff-${crypto.randomUUID()}.command`)
    fs.writeFileSync(file, script, { mode: 0o700 })
    execFile('open', ['-a', 'Terminal', file], e => { if (e) console.error(`Couldn't open Terminal: ${e.message}`) })
  }
  // Terminal windows may not have the same PATH as this one, so use the full path to claude.
  function whichClaude() {
    const c = process.env.CLAUDE_WATCH_NOTES_CLAUDE || 'claude'
    if (c.includes('/')) return c
    for (const d of (process.env.PATH || '').split(path.delimiter)) {
      try { fs.accessSync(path.join(d, c), fs.constants.X_OK); return path.join(d, c) } catch {}
    }
    return c
  }

  // Running notes: one at a time per chat, each continuing the chat's Claude Code session.
  const queues = new Map()
  function take(n) {
    if (!tryClaim(n.id)) return // another process has it
    writeAtomic(noteFile(n.id), JSON.stringify({ ...n, status: 'sent' }, null, 2))
    queues.set(n.to, (queues.get(n.to) || Promise.resolve()).then(() => runNote(n)).catch(e => console.error(e)))
  }

  async function runNote(n) {
    const chat = chats[n.to]
    const stamp = () => new Date().toLocaleTimeString()
    logTo(n.to, `\n━━ ${stamp()} Note from your watch:\n${n.text}\n\n`)
    console.log(`Chat "${n.to}": working on a note`)
    const prompt = `${n.text}\n\n---\nThis is a note the user jotted on their Apple Watch (note_id=${n.id}). They are away and ` +
      'will not see or answer questions: do it autonomously in this project, making reasonable assumptions. If an action is ' +
      `blocked by the permission system, skip it and mention it. When finished, call watch_note_done with note_id ${n.id}, ` +
      'a short summary, and optionally a suggestion (the next prompt they would likely send).'
    const args = ['-p', '--permission-mode', 'auto', '--output-format', 'stream-json', '--verbose',
      ...MCP_ARGS, '--allowedTools', 'mcp__handoff__watch_note_done',
      ...(chat.started ? ['--resume', chat.session] : ['--session-id', chat.session])]
    const env = { ...process.env, CLAUDE_WATCH_NOTES_NAME: n.to }
    delete env.CLAUDE_WATCH_NOTES_CHANNEL // its plugin server must not claim other notes
    let result = '', failed = null, sawSession = false
    await new Promise(resolve => {
      const child = spawn(process.env.CLAUDE_WATCH_NOTES_CLAUDE || 'claude', args, { cwd: chat.dir, env, stdio: ['pipe', 'pipe', 'pipe'] })
      child.on('error', e => { failed = e.code === 'ENOENT' ? '`claude` not found' : e.message; resolve() })
      child.stdin.end(prompt) // on stdin, so a note starting with "-" can't be read as an option
      let buf = ''
      child.stdout.on('data', d => {
        buf += d
        let i
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i)
          buf = buf.slice(i + 1)
          let m
          try { m = JSON.parse(line) } catch { continue }
          if (m.session_id) sawSession = true
          if (m.type === 'assistant') {
            for (const c of m.message?.content ?? []) {
              if (c.type === 'text' && c.text.trim()) logTo(n.to, `${c.text.trim()}\n\n`)
              if (c.type === 'tool_use') logTo(n.to, `  → ${c.name} ${JSON.stringify(c.input ?? {}).slice(0, 160)}\n`)
            }
          } else if (m.type === 'result') {
            result = String(m.result ?? '')
            if (m.is_error) failed = result || 'Claude reported an error'
          }
        }
      })
      child.stderr.on('data', d => logTo(n.to, String(d)))
      child.on('close', code => { if (code && !failed) failed = `claude exited with code ${code}`; resolve() })
    })
    if (sawSession) chat.started = true
    chat.lastUsed = new Date().toISOString()
    saveChats()
    // If Claude didn't call watch_note_done, keep its final answer as the summary.
    let saved = n
    try { saved = JSON.parse(fs.readFileSync(noteFile(n.id), 'utf8')) } catch {}
    if (saved.status !== 'done') {
      writeAtomic(noteFile(n.id), JSON.stringify({ ...saved, status: failed ? 'failed' : 'done',
        summary: failed ? `Failed: ${failed}` : result.slice(0, 4000) || 'Finished (no summary).', doneAt: new Date().toISOString() }, null, 2))
    }
    logTo(n.to, failed ? `━━ ${stamp()} Failed: ${failed}\n` : `━━ ${stamp()} Done.\n`)
    console.log(`Chat "${n.to}": ${failed ? `failed (${failed})` : 'done'}`)
  }
}

// ---------- mail: email Claude through the Mail app ----------
// Notes you email yourself at you+claude@… are read from your account's Sent mailbox in the Mail
// app and saved like watch notes, so `handoff start` sessions pick them up. Only mail you sent
// counts, so nobody else can email Claude instructions. When a note is done, its summary goes back
// as a reply in the same thread, addressed to +claude, so replying to it sends the next note.
function osa(args) {
  const script = fileURLToPath(new URL('./mail.js', import.meta.url))
  return new Promise((resolve, reject) =>
    execFile(process.env.CLAUDE_WATCH_NOTES_OSASCRIPT || 'osascript', ['-l', 'JavaScript', script, ...args],
      { timeout: 120_000, maxBuffer: 32 << 20 }, (e, out, err) => {
        if (e) {
          const msg = String(err || e.message).trim().replace(/^[\s\S]*execution error: (Error: )*/, '')
          return reject(new Error(/-1743|not authori[sz]ed/i.test(msg)
            ? 'not allowed to use Mail. Allow it in System Settings → Privacy & Security → Automation, then restart this.' : msg))
        }
        try { resolve(JSON.parse(out)) } catch { reject(new Error('Mail gave an answer that isn\'t JSON')) }
      }))
}

// The note in an email: the subject (unless it's a reply) and the body, without the quoted thread.
function mailText(subject, content) {
  const body = String(content ?? '').replace(/\r/g, '')
    .split(/^On [^\n]*(?:\n[^\n]*)?wrote:[ \t]*$/m)[0] // "On <date>, <name> wrote:", maybe wrapped
    .split(/^-- ?$/m)[0] // signature
    .split('\n').filter(l => !l.startsWith('>')).join('\n').trim()
  subject = String(subject ?? '').trim()
  return (!subject || /^(re|fwd?):/i.test(subject) ? body : `${subject}\n\n${body}`).trim()
}

async function mail(arg) {
  const FOOTER = 'Handoff · reply to send Claude another note'
  const DAYS = 2 // how far back to look
  if (process.platform !== 'darwin' && !process.env.CLAUDE_WATCH_NOTES_OSASCRIPT) {
    console.error('`handoff mail` uses the Mail app, so it only runs on a Mac.')
    process.exit(1)
  }
  if (arg === '--help' || arg === '-h') {
    return console.log('handoff mail [address]   listen for notes you email from that Mail account to its +claude address.\n' +
      '                         The address is remembered, so next time plain `handoff mail` uses it.')
  }
  // The account to listen to: the one given (remembered for next time), the remembered one,
  // or else the only Gmail account in Mail.
  const SAVED = path.join(DIR, 'mail.json')
  let me = arg?.toLowerCase()
  if (!me) try { me = JSON.parse(fs.readFileSync(SAVED, 'utf8')).address } catch {}
  if (!me) {
    let addrs
    try { addrs = await osa(['accounts']) } catch (e) { console.error(`Mail: ${e.message}`); process.exit(1) }
    const gmail = addrs.filter(a => /@(gmail|googlemail)\.com$/i.test(a))
    if (gmail.length !== 1) {
      console.error(`Which address should Claude use? Run: handoff mail <address>\n  (Mail has: ${addrs.join(', ') || 'no accounts'})`)
      process.exit(1)
    }
    me = gmail[0].toLowerCase()
  }
  if (!/^[^@\s+]+(\+[^@\s]*)?@[^@\s]+$/.test(me)) { console.error(`Not an email address: ${me}`); process.exit(1) }
  const [user, domain] = me.split('@')
  me = `${user.split('+')[0]}@${domain}`
  const to = `${user.split('+')[0]}+claude@${domain}`
  fs.mkdirSync(NOTES, { recursive: true, mode: 0o700 })
  if (arg) writeAtomic(SAVED, JSON.stringify({ address: me }, null, 2))

  const save = m => {
    const text = mailText(m.subject, m.content).slice(0, 20000)
    if (!text || text.includes(FOOTER)) return // empty, or one of our own replies
    const id = `mail-${crypto.createHash('sha256').update(String(m.messageId)).digest('hex').slice(0, 24)}`
    const at = typeof m.at === 'string' && !isNaN(Date.parse(m.at)) ? m.at : new Date().toISOString()
    const note = { id, text, at, status: 'new', source: 'email', mail: { messageId: String(m.messageId), subject: String(m.subject ?? '') } }
    try {
      fs.writeFileSync(noteFile(id), JSON.stringify(note, null, 2), { flag: 'wx' })
      console.log(`Email: ${text.split('\n')[0].slice(0, 70)}`)
    } catch {} // already have it
  }

  // Each reply is claimed with an O_EXCL marker, so it's sent once even with two of these running.
  const replies = async () => {
    let files = []
    try { files = fs.readdirSync(NOTES).filter(f => f.startsWith('mail-') && f.endsWith('.json')) } catch {}
    for (const f of files) {
      let n
      try { n = JSON.parse(fs.readFileSync(path.join(NOTES, f), 'utf8')) } catch { continue }
      if (n.source !== 'email' || !n.mail || n.replied || !['done', 'failed'].includes(n.status)) continue
      const marker = noteFile(n.id).replace(/\.json$/, '.replied')
      try {
        if (!alive(Number(fs.readFileSync(marker, 'utf8')))) fs.rmSync(marker) // left by one that crashed
      } catch {}
      try { fs.writeFileSync(marker, String(process.pid), { flag: 'wx' }) } catch { continue }
      let body = n.summary || 'Done.'
      if (n.suggestion) body += `\n\nNext step? Reply with: ${n.suggestion}`
      body += `\n\n—\n${FOOTER}`
      try {
        await osa(['reply', me, to, n.mail.messageId, n.mail.subject, body])
        let latest = n
        try { latest = JSON.parse(fs.readFileSync(noteFile(n.id), 'utf8')) } catch {}
        writeAtomic(noteFile(n.id), JSON.stringify({ ...latest, replied: true }, null, 2))
        console.log(`Replied: ${n.text.split('\n')[0].slice(0, 70)}`)
      } catch (e) {
        fs.rmSync(marker, { force: true })
        console.error(`Couldn't send a reply yet (will retry): ${e.message}`)
      }
    }
  }

  console.log(`Handoff mail: email ${to} from ${me}, and your handoff start sessions will work on it.\n` +
    'The summary comes back as a reply. Keep this running; Ctrl+C stops it.\n')
  process.on('SIGINT', () => process.exit(0))
  process.on('SIGTERM', () => process.exit(0))
  let failing = false
  for (;;) {
    try {
      for (const m of await osa(['fetch', me, to, String(DAYS)])) save(m)
      if (failing) console.log('Mail is working again.')
      failing = false
    } catch (e) {
      if (!failing) console.error(`Mail: ${e.message}`)
      failing = true
    }
    await replies()
    await new Promise(r => setTimeout(r, Number(process.env.CLAUDE_WATCH_NOTES_MAIL_MS) || 60_000))
  }
}

// ---------- install: put `handoff` on your PATH (/handoff:setup runs this) ----------
// Writes a small script that runs the installed plugin's copy of this file. Plugin updates move the
// plugin, so it looks the location up in ~/.claude-watch-notes/plugin-root, which the plugin's
// server rewrites every time a Claude Code session starts.
function install() {
  const MARK = 'Installed by the Handoff plugin'
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 })
  writeAtomic(path.join(DIR, 'plugin-root'), path.dirname(path.dirname(fileURLToPath(import.meta.url))))
  const home = os.homedir()
  const onPath = (process.env.PATH || '').split(path.delimiter)
  const local = path.join(home, '.local', 'bin')
  const bin = [local, path.join(home, 'bin')].find(d => onPath.includes(d)) || local
  const target = path.join(bin, 'handoff')
  try {
    if (!fs.readFileSync(target, 'utf8').includes(MARK)) {
      console.error(`${target} already exists and isn't from Handoff, so it was left alone.`)
      process.exit(1)
    }
  } catch {} // not there yet
  fs.mkdirSync(bin, { recursive: true })
  fs.writeFileSync(target, `#!/bin/sh
# ${MARK} (/handoff:setup). Runs the installed plugin's \`handoff\` command.
# The newest installed version of the plugin, else wherever /handoff:setup last ran from.
cache="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/cache/handoff/handoff"
root=$(ls -1 "$cache" 2>/dev/null | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1)
if [ -n "$root" ] && [ -f "$cache/$root/cli/handoff.mjs" ]; then root="$cache/$root"
else root=$(cat "\${CLAUDE_WATCH_NOTES_DIR:-$HOME/.claude-watch-notes}/plugin-root" 2>/dev/null); fi
if [ ! -f "$root/cli/handoff.mjs" ]; then
  echo "handoff: can't find the Handoff plugin. In Claude Code, run /plugin install handoff@handoff, then /handoff:setup." >&2
  exit 1
fi
exec node "$root/cli/handoff.mjs" "$@"
`)
  fs.chmodSync(target, 0o755)
  console.log(`Installed the handoff command at ${target}.`)

  if (!onPath.includes(bin)) {
    const rc = path.join(home, process.env.SHELL?.endsWith('bash') ? '.bash_profile' : '.zshrc')
    const line = 'export PATH="$HOME/.local/bin:$PATH" # added by Handoff'
    let current = ''
    try { current = fs.readFileSync(rc, 'utf8') } catch {}
    if (!current.includes(line)) fs.appendFileSync(rc, `\n${line}\n`)
    console.log(`Added ${bin} to your PATH in ${rc}. Open a new Terminal window to use it.`)
  } else {
    // Another `handoff` earlier in PATH (an old npm install, say) would run instead.
    const first = onPath.slice(0, onPath.indexOf(bin)).map(d => path.join(d, 'handoff')).find(f => fs.existsSync(f))
    if (first) console.log(`Note: ${first} comes first in your PATH and will run instead. Remove it to use this one.`)
  }
}
