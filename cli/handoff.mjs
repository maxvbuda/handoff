#!/usr/bin/env node
// `handoff`: terminal command for Handoff, installed with npm (npm install -g github:maxvbuda/handoff).
// The Claude Code plugin is skills only and runs this command; this command starts Handoff's server
// (server/handoff.mjs) for the Claude Code sessions it opens.
//
//   handoff pair [CODE]       pair your watch (pick it from a list, or type the code it shows)
//   handoff unpair            forget the watch this Mac is paired with
//   handoff start [--name N] [args...]   start Claude Code listening for ideas
//   handoff host [folder]     let the watch start chats in folder's projects (run headless here)
//   handoff mail [address]    email Claude too, through the Mail app
//   handoff relay [setup|status|off]   run your own relay instead of ntfy.sh
//   handoff inbox             print notes that aren't done (what /handoff:inbox runs)
//   handoff done <id> <summary> [--suggestion S] [--image FILE]   mark a note done
//   handoff extras [install|remove NAME]   optional Mac extras (extras/): screen, deskhand, cover, lidwake

import { spawn, execFile, execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { CONFIG, DIR, NOTES, OWN_RELAY, alive, ownRelay, events, noteFile, open, readConfig, runDueSchedules, saveNote, saveSchedules, seal, sendRecapIfDue, tryClaim, writeAtomic } from '../server/relay.mjs'

const SERVER = fileURLToPath(new URL('../server/handoff.mjs', import.meta.url))

// Handoff's MCP server, for the sessions this command opens. Its tools show up as mcp__handoff__*.
// With the screen-control extra on (`handoff extras install screen`), its server too, as mcp__screen__*.
// Read each time, so turning it on or off applies to the next chat.
const SCREEN_SERVER = fileURLToPath(new URL('../extras/screen/server.mjs', import.meta.url))
const SCREEN_TOOLS = ['screenshot', 'click', 'move', 'drag', 'scroll', 'type', 'key', 'batch'].map(t => `mcp__screen__screen_${t}`)
const EXTRAS = path.join(DIR, 'extras.json')
const extras = () => { try { return JSON.parse(fs.readFileSync(EXTRAS, 'utf8')) } catch { return {} } }
const screenOn = () => extras().screen === true
// `handoff lab screen-control awake on`: the display doesn't sleep while a chat or host runs, so the Mac
// doesn't lock itself (screen control can't use a locked Mac). caffeinate -w stops when we do.
const stayAwake = () => {
  if (process.platform === 'darwin' && screenOn() && extras().awake === true)
    spawn('caffeinate', ['-d', '-w', String(process.pid)], { stdio: 'ignore', detached: true }).unref()
}
// A host chat gets it unless the note was sent with Settings → Computer use off (`note.screen === false`, Hand-Off 1.5
// and later); older apps have no such setting, so `lab screen-control on` alone decides.
function mcpArgs(note) {
  const servers = { handoff: { command: process.execPath, args: [SERVER] } }
  if (screenOn() && (!note || note.screen !== false)) servers.screen = { command: process.execPath, args: [SCREEN_SERVER] }
  return ['--mcp-config', JSON.stringify({ mcpServers: servers })]
}
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

// A MacBook sleeps when its lid closes, even under caffeinate, and then notes wait until it wakes.
// LidWake (github.com/aaryanbindage/Lidwake) keeps it awake with the lid closed: if it's installed
// and not already running, say how. `--claude` would end after Claude's first reply, so not that.
const macBook = () => { try { return execFileSync('pmset', ['-g', 'batt'], { encoding: 'utf8' }).includes('InternalBattery') } catch { return false } }
function lidTip() {
  if (process.platform !== 'darwin' || !macBook() || lidAwake()) return null
  let state
  try { state = execFileSync('lidwake', ['status', '--short'], { encoding: 'utf8', timeout: 5000 }).trim() } catch { return null }
  if (state !== 'idle') return null
  return 'Closing the lid puts this MacBook to sleep, and notes then wait until it wakes. To keep it working with\n' +
    'the lid closed, run this in another Terminal tab (no time limit; it stops at 10% battery, or with lidwake stop):\n  lidwake start -b --max 0'
}

// With the LidWake extra (`handoff extras install lidwake`), Handoff starts the session itself while a chat or host
// runs: it ends once no `handoff start` or `handoff host` is left, or when the battery is at 10% (and then the Mac
// sleeps, as LidWake does). A session you started yourself is left alone. Our own exit stops it right away
// (lidwake stop: sleep is allowed again, nothing else), so quitting at your desk doesn't put the Mac to sleep.
const HANDOFF_RUNNING = 'node .*handoff(\\.mjs)? (start|host)' // doesn't match itself, so it's safe in lidwake's --cmd
let lidAwakeState
function lidAwake() {
  if (lidAwakeState !== undefined) return lidAwakeState
  lidAwakeState = false
  if (process.platform !== 'darwin' || extras().lidwake !== true || !macBook()) return false
  const ours = path.join(DIR, 'lidwake-session')
  const lw = args => execFileSync('lidwake', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 })
  const session = () => { try { const j = JSON.parse(lw(['status', '--json'])); return j.active ? String(j.started) : '' } catch { return null } }
  const isOurs = () => { const now = session(); try { return !!now && fs.readFileSync(ours, 'utf8') === now } catch { return false } }
  const now = session()
  if (now === null) return false
  if (!now) {
    try { lw(['start', '--cmd', `! pgrep -qf '${HANDOFF_RUNNING}'`, '--battery', '10', '--max', '0', '-b']) } catch { return false }
    fs.writeFileSync(ours, session() || '') // which session is ours: its start time
    console.log('LidWake is on: you can close the lid. It stops when Handoff does, or at 10% battery.\n')
  } else if (!isOurs()) return (lidAwakeState = true) // yours: yours to stop
  process.on('exit', () => {
    let others = []
    try { others = execFileSync('pgrep', ['-f', HANDOFF_RUNNING], { encoding: 'utf8' }).split('\n').filter(p => p && Number(p) !== process.pid) } catch {}
    if (others.length || !isOurs()) return
    try { lw(['stop']) } catch {}
    fs.rmSync(ours, { force: true })
  })
  // So Ctrl+C runs that too (host has its own handlers, which exit).
  setImmediate(() => { for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) if (!process.listenerCount(sig)) process.on(sig, () => process.exit(128 + os.constants.signals[sig])) })
  return (lidAwakeState = true)
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
  // Plugin versions before 3.0 start their own Handoff server in every session. In this one it would
  // take notes too, and Claude Code drops what it sends (it isn't the channel we asked for).
  const old = oldPlugin()
  if (old) {
    console.error(`The Handoff plugin in Claude Code is version ${old}, which would take notes and lose them.\n` +
      'Update it first: claude plugin marketplace update handoff && claude plugin update handoff@handoff')
    process.exit(1)
  }
  const claudeArgs = ['--permission-mode', 'auto', ...mcpArgs(), ...(screenOn() ? ['--allowedTools', ...SCREEN_TOOLS] : []), ...CHANNEL_ARGS, ...rest]
  console.log(`Starting Claude Code with Handoff as the chat "${name}". Ideas from your watch will show up here.\n` +
    'Claude Code will warn about development channels: choose "I am using this for local development".\n' +
    'It may also say "server:handoff · no MCP server configured with that name". That\'s expected: Handoff\'s\n' +
    'server is passed on the command line, which that check doesn\'t look at. Notes still arrive.\n')
  const tip = lidTip()
  if (tip) console.log(tip + '\n')
  // caffeinate keeps the Mac awake (so Claude can keep working) for as long as the session runs.
  // Tells this session's Handoff server that it's listening, so it (not other open sessions) takes the notes.
  const opts = { stdio: 'inherit', env: { ...process.env, CLAUDE_WATCH_NOTES_CHANNEL: '1', CLAUDE_WATCH_NOTES_NAME: name } }
  stayAwake()
  if (process.platform === 'darwin') run('caffeinate', ['-i', 'claude', ...claudeArgs], opts)
  else run('claude', claudeArgs, opts)
  // The watch's Projects screen: this folder's git status while the chat is open, checked every
  // minute and sent when it changes (or every 15 minutes).
  const report = async () => postChanged(`repo ${name}`, { repo: name, ...(await gitStatus(process.cwd())) })
  report()
  setInterval(report, Number(process.env.CLAUDE_WATCH_NOTES_CHECK_MS) || 60_000).unref()
} else if (cmd === 'pair' && rest[0] === '--nearby') {
  // Experimental: no code; the watch finds this Mac on the local network.
  run(process.execPath, [SERVER, 'pair', '--nearby'], { stdio: 'inherit' })
} else if (cmd === 'pair') {
  // The watch shows a code to type here. With no code (pressing Return, or not at a terminal, like
  // the 1.0 /handoff:pair skill), show one to type on the watch instead, as Hand-Off 1.0 asks.
  // At a terminal with no code: list the watches on this network to pick from (Hand-Off 1.5 and
  // later), or type the code (any version). Exit status 3 means Return was pressed: show a code.
  const code = rest.join('')
  if (code) run(process.execPath, [SERVER, 'pair', code], { stdio: 'inherit' })
  else if (!process.stdin.isTTY) pairShowingCode()
  else {
    const status = (await import('node:child_process')).spawnSync(process.execPath, [SERVER, 'pair', '--lobby'], { stdio: 'inherit' }).status
    if (status === 3) pairShowingCode()
    else process.exit(status ?? 1)
  }
} else if (cmd === 'unpair') {
  // Forgets the pairing key. Running chats and the host see it go (they watch the file) and stop
  // listening. Notes and their summaries stay; so do the cursors, which only apply to that pairing.
  if (!readConfig()) console.log('Not paired.')
  else {
    fs.rmSync(CONFIG, { force: true })
    console.log('Unpaired. This Mac no longer gets notes from your watch. Your notes are still in ~/.claude-watch-notes.\n' +
      'On the watch, tap Settings, then Unpair. To pair again, open Hand-Off and run: handoff pair CODE')
  }
} else if (cmd === 'host') {
  host(path.resolve(rest[0] || process.cwd()))
} else if (cmd === 'lab' && rest[0] === 'screen-control') { // the old name for `handoff extras install screen`
  screenControl(rest[1], rest[2])
} else if (cmd === 'extras') {
  extrasCommand(...rest)
} else if (cmd === 'mail') {
  mail(rest[0])
} else if (cmd === 'relay') {
  setImmediate(() => relay(rest[0])) // after the rest of this file has run: relay() uses its constants
} else if (cmd === 'inbox') {
  toolCall('watch_inbox', {}, 3000)
} else if (cmd === 'done') {
  const flag = name => { const i = rest.indexOf(name); return i >= 0 ? rest.splice(i, 2)[1] : undefined }
  const suggestion = flag('--suggestion')
  const image = flag('--image')
  const [noteId, ...summary] = rest
  if (!noteId || !summary.length) { console.error('Usage: handoff done <note_id> <summary> [--suggestion "next prompt"] [--image screenshot.jpg]'); process.exit(1) }
  toolCall('watch_note_done', { note_id: noteId, summary: summary.join(' '), ...(suggestion && { suggestion }), ...(image && { image: path.resolve(image) }) })
} else {
  console.log(`Handoff: jot ideas on your Apple Watch; Claude Code does them while you're away.

  handoff pair [CODE]       Pair your watch: type the code Hand-Off shows
  handoff unpair            Forget the watch this Mac is paired with (your notes stay)
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
  handoff relay setup       Use your own relay instead of ntfy.sh (no daily limit): runs it on
                            this Mac and puts it on the internet with zrok (free account)
  handoff relay status      Check that your own relay answers
  handoff relay off         Go back to ntfy.sh
  handoff inbox             Print the notes that aren't done yet (/handoff:inbox runs it)
  handoff done <note_id> <summary> [--suggestion "next prompt"] [--image screenshot.jpg]
                            Mark a note done (and send a suggestion, screenshot or GIF to the watch)
  handoff extras            Optional Mac extras so Claude can use your screen while you're
                            away (screen control, Deskhand, a fake lock screen, LidWake):
                            handoff extras install all
`)
}

// The version of an installed Handoff plugin older than 3.0 (those declare an MCP server), if any.
function oldPlugin() {
  try {
    const installed = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude/plugins/installed_plugins.json'), 'utf8'))
    for (const [id, list] of Object.entries(installed.plugins ?? {})) {
      if (!id.startsWith('handoff@')) continue
      for (const p of list) if (Number(String(p.version).split('.')[0]) < 3) return p.version
    }
  } catch {}
  return null
}

// A message for the watch, sealed with the pairing key, on "<topic>-<suffix>".
function postSide(suffix, obj, timeout = 20_000) {
  const cfg = readConfig()
  if (!cfg) return Promise.resolve()
  return fetch(`${cfg.topicURL}-${suffix}`, { method: 'POST', body: seal({ ...obj, ts: new Date().toISOString() }, Buffer.from(cfg.key, 'base64')), signal: AbortSignal.timeout(timeout) })
    .catch(() => {})
}

// Sends a status message when it differs from the last one sent under `key`, or that one is 15
// minutes old. ntfy.sh limits messages per day for each home internet connection (a few hundred),
// so status is sent on change rather than every minute. The watch counts a chat open for 20 minutes.
// (The commands above run before this file's later lines, so the record lives on the function.)
function postChanged(key, obj) {
  const sent = postChanged.sent ??= new Map(), resend = Number(process.env.CLAUDE_WATCH_NOTES_HEARTBEAT_MS) || 15 * 60_000
  const json = JSON.stringify(obj), last = sent.get(key)
  if (last && last.json === json && Date.now() - last.at < resend) return Promise.resolve()
  sent.set(key, { json, at: Date.now() })
  return postSide('c', obj)
}

// A folder's branch, how many files have changes, and how many commits aren't pushed yet
// ({} if it isn't a git repository).
function gitStatus(dir) {
  return new Promise(resolve => execFile('git', ['-C', dir, 'status', '--porcelain=v1', '--branch'], { timeout: 10_000 }, (e, out) => {
    if (e) return resolve({})
    const [head = '', ...files] = String(out).split('\n')
    const branch = /^## (?:No commits yet on )?(.+?)(?:\.\.\.\S+)?(?: \[.*\])?$/.exec(head)?.[1]
    resolve({ branch: branch?.startsWith('HEAD') ? 'detached' : branch, changes: files.filter(Boolean).length,
      ahead: Number(/ahead (\d+)/.exec(head)?.[1] ?? 0) })
  }))
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

// Hand-Off 1.0's way: we show a code, the user types it on the watch.
function pairShowingCode() {
  const child = run(process.execPath, [SERVER, 'pair'], { stdio: ['inherit', 'pipe', 'inherit'] })
  let sent = false
  child.stdout.on('data', d => {
    process.stdout.write(d)
    const code = /Pairing code:\s+([A-Z0-9]{4})-([A-Z0-9]{4})/.exec(String(d))
    if (code && !sent) { sent = true; sendToSimulators(code[1] + code[2]) }
  })
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
          execFileSync('xcrun', ['simctl', 'launch', '--terminate-running-process', d.udid, 'dev.maxbuda.ClaudeNotes.watchkitapp', '-pairCode', code], { stdio: 'ignore' })
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
//   - for {stop} requests (Stop on the watch), stops the note that chat is running;
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
  stayAwake()
  lidAwake()
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
  // Every chat until you delete it from the watch, newest first (a cap only keeps the message small).
  const recentChats = () => Object.keys(chats).sort((a, b) => Date.parse(chats[b].lastUsed || 0) - Date.parse(chats[a].lastUsed || 0)).slice(0, 50)
  const logFile = name => path.join(LOGS,
    `${name.replace(/[^\w.-]+/g, '-').slice(0, 30)}-${crypto.createHash('sha1').update(name).digest('hex').slice(0, 8)}.log`)
  const logTo = (name, text) => fs.appendFileSync(logFile(name), text)
  const resumeCommand = c => `cd ${q(c.dir)} && claude --resume ${c.session}`

  const post = (obj, timeout = 20_000, suffix = 'c') => postSide(suffix, obj, timeout)
  // Also each chat's git status and the note it's working on, for the watch's Projects screen.
  // Checked every minute, sent when it changes (or every 15 minutes): see postChanged.
  const announce = async () => {
    await postChanged('host', { host: hostName, root: path.basename(root), projects: projects(), chats: recentChats() })
    for (const n of recentChats()) {
      if (fs.existsSync(chats[n].dir)) postChanged(`repo ${n}`, { repo: n, working: busy.get(n), ...(await gitStatus(chats[n].dir)) })
    }
  }
  const busy = new Map() // chat -> the note it's running
  setInterval(announce, Number(process.env.CLAUDE_WATCH_NOTES_CHECK_MS) || 60_000)
  const quit = async () => { await post({ host: hostName, gone: true }, 3000); process.exit(0) }
  process.on('SIGINT', quit)
  process.on('SIGTERM', quit)

  console.log(`Handoff host: the watch can start chats in ${projects().length} projects in ${root}.\n` +
    'Chats started from the watch run here, with no confirmation needed. Keep this running; Ctrl+C stops it.\n')
  for (const n of recentChats()) console.log(`  chat "${n}"  (open it: ${resumeCommand(chats[n])})`)
  if (!readConfig()) console.log('Not paired yet: run `handoff pair`.')

  // Relay subscriptions: reconnect with backoff, and restart with the new key when re-paired.
  const subs = new Set()
  // Re-paired: follow the new topic, and show the projects on the watch right away.
  fs.watchFile(CONFIG, { interval: 2000 }, () => { subs.forEach(c => c.abort()); postChanged.sent?.clear(); announce() })
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
    else if (req.stop !== undefined) stopChat(String(req.stop))
    else if (req.delete !== undefined) deleteChat(String(req.delete))
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
  // Recurring tasks set up on the watch (see runDueSchedules).
  subscribe('-r', () => '12h', (ev, key) => { try { if (saveSchedules(open(ev.message, key))) sweep() } catch {} })
  // Also pick up notes for our chats that a Claude Code window saved before we saw them.
  const sweep = () => {
    runDueSchedules()
    sendRecapIfDue(r => postSide('s', r).then(res => res?.ok))
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

  // Delete chat on the watch: stops what it's running and forgets it. Its folder and log stay.
  function deleteChat(name) {
    if (!chats[name]) return console.log(`Skipped a request to delete a chat this host doesn't have.`)
    if (running.has(name)) stopChat(name)
    delete chats[name]
    saveChats()
    announce()
    console.log(`Deleted chat "${name}" from the watch (its folder is still there)`)
  }

  // Stop on the watch: interrupt the chat's running note, as Ctrl+C would. The note is kept as stopped.
  function stopChat(name) {
    const child = running.get(name)
    if (!child) return console.log(`Chat "${name}" isn't running a note; nothing to stop.`)
    console.log(`Chat "${name}": stopped from the watch`)
    child.stoppedFromWatch = true
    child.kill('SIGINT')
    setTimeout(() => child.exitCode === null && child.kill('SIGTERM'), 5000).unref()
  }

  // Running notes: one at a time per chat, each continuing the chat's Claude Code session.
  const queues = new Map()
  const running = new Map() // chat -> its claude process
  function take(n) {
    if (!tryClaim(n.id)) return // another process has it
    writeAtomic(noteFile(n.id), JSON.stringify({ ...n, status: 'sent' }, null, 2))
    queues.set(n.to, (queues.get(n.to) || Promise.resolve()).then(() => runNote(n)).catch(e => console.error(e)))
  }

  async function runNote(n) {
    const chat = chats[n.to]
    const stamp = () => new Date().toLocaleTimeString()
    logTo(n.to, `\n━━ ${stamp()} ${n.source === 'schedule' ? 'Recurring task' : 'Note from your watch'}:\n${n.text}\n\n`)
    busy.set(n.to, n.text.slice(0, 120))
    announce()
    console.log(`Chat "${n.to}": working on a note`)
    const prompt = `${n.text}\n\n---\nThis is a note the user jotted on their Apple Watch (note_id=${n.id}). They are away and ` +
      'will not see or answer questions: do it autonomously in this project, making reasonable assumptions. If an action is ' +
      `blocked by the permission system, skip it and mention it. When finished, call watch_note_done with note_id ${n.id}, ` +
      'a short summary, optionally a suggestion (the next prompt they would likely send)' +
      (n.shots === false ? ' (they turned screenshots off on the watch: no image). ' : ' and, if it changed something ') +
      (n.shots === false ? '' : 'they can look at, image: the path of a small screenshot of it (PNG or JPEG under 300 KB), or of an MP4 clip if it moves (ffmpeg -y -t 6 -i VIDEO -vf "fps=30,scale=480:-2" -c:v libx264 -pix_fmt yuv420p -c:a aac -b:a 64k -movflags +faststart CLIP.mp4; if the watch can\'t play videos, watch_note_done says to send a GIF instead). ') +
      'If you reach a real choice only they can make, you may ask once with watch_ask (they tap an answer on the watch).'
    const args = ['-p', '--permission-mode', 'auto', '--output-format', 'stream-json', '--verbose',
      ...mcpArgs(n), '--allowedTools', 'mcp__handoff__watch_note_done', 'mcp__handoff__watch_ask', ...(screenOn() && n.screen !== false ? SCREEN_TOOLS : []),
      ...(chat.started ? ['--resume', chat.session] : ['--session-id', chat.session])]
    const env = { ...process.env, CLAUDE_WATCH_NOTES_NAME: n.to, HANDOFF_NOTE: n.id } // the screen extra checks this note allows it
    delete env.CLAUDE_WATCH_NOTES_CHANNEL // its plugin server must not claim other notes
    let result = '', failed = null, sawSession = false, stopped = false
    await new Promise(resolve => {
      const child = spawn(process.env.CLAUDE_WATCH_NOTES_CLAUDE || 'claude', args, { cwd: chat.dir, env, stdio: ['pipe', 'pipe', 'pipe'] })
      running.set(n.to, child)
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
      child.on('close', code => {
        stopped = !!child.stoppedFromWatch
        if (code && !failed && !stopped) failed = `claude exited with code ${code}`
        resolve()
      })
    })
    running.delete(n.to)
    if (sawSession) chat.started = true
    chat.lastUsed = new Date().toISOString()
    saveChats()
    // If Claude didn't call watch_note_done, keep its final answer as the summary.
    let saved = n
    try { saved = JSON.parse(fs.readFileSync(noteFile(n.id), 'utf8')) } catch {}
    if (saved.status !== 'done') {
      writeAtomic(noteFile(n.id), JSON.stringify({ ...saved, status: stopped ? 'stopped' : failed ? 'failed' : 'done', chat: n.to,
        summary: stopped ? 'Stopped from the watch.' : failed ? `Failed: ${failed}` : result.slice(0, 4000) || 'Finished (no summary).',
        doneAt: new Date().toISOString() }, null, 2))
    }
    logTo(n.to, stopped ? `━━ ${stamp()} Stopped from your watch.\n` : failed ? `━━ ${stamp()} Failed: ${failed}\n` : `━━ ${stamp()} Done.\n`)
    busy.delete(n.to)
    announce()
    console.log(`Chat "${n.to}": ${stopped ? 'stopped' : failed ? `failed (${failed})` : 'done'}`)
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

// ---------- your own relay ----------
// ntfy.sh limits messages per day for each internet connection, and files to 2 MB. `handoff relay
// setup` runs Handoff's own relay (server/relay-server.mjs) on this Mac at login, and zrok (an
// open-source tunnel, free account at myzrok.io) gives it a fixed https address the watch can reach
// from anywhere. Pairing again moves the watch to it; until then (and for watches too old to move)
// everything stays on ntfy.sh.
const RELAY_PORT = 8795
const RELAY_DIR = path.join(DIR, 'relay')
const AGENTS = { relay: 'dev.maxbuda.handoff.relay', share: 'dev.maxbuda.handoff.zrok' }
const plistFor = label => path.join(os.homedir(), 'Library/LaunchAgents', `${label}.plist`)
const readRelaySettings = () => { try { return JSON.parse(fs.readFileSync(OWN_RELAY, 'utf8')) } catch { return {} } }

function zrok() {
  // zrok 2 is `zrok2` from zrok's own installer and `zrok` from Homebrew.
  for (const z of ['zrok2', 'zrok', '/opt/homebrew/bin/zrok2', '/opt/homebrew/bin/zrok', '/usr/local/bin/zrok2', '/usr/local/bin/zrok']) {
    // A full path: login items don't get your PATH.
    try { execFileSync(z, ['version'], { stdio: 'ignore' }); return z.includes('/') ? z : execFileSync('/usr/bin/which', [z], { encoding: 'utf8' }).trim() } catch {}
  }
  return null
}

async function healthy(url) {
  try { return (await fetch(`${url}/v1/health`, { signal: AbortSignal.timeout(10_000) })).ok } catch { return false }
}

// A login item that runs `args` and runs it again whenever it stops (at most every `every` seconds);
// output goes to `logFile`.
function startAgent(label, args, logFile, every = 10) {
  const esc = v => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  fs.mkdirSync(path.dirname(plistFor(label)), { recursive: true })
  fs.writeFileSync(plistFor(label), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>${args.map(a => `<string>${esc(a)}</string>`).join('')}</array>
  <key>EnvironmentVariables</key><dict><key>CLAUDE_WATCH_NOTES_DIR</key><string>${esc(DIR)}</string><key>HOME</key><string>${esc(os.homedir())}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>${every}</integer>
  <key>StandardOutPath</key><string>${esc(logFile)}</string>
  <key>StandardErrorPath</key><string>${esc(logFile)}</string>
</dict></plist>
`)
  stopAgent(label, false)
  // launchd can still be finishing the old one ("Bootstrap failed: 5: Input/output error"): try again.
  for (let i = 0; ; i++) {
    try { execFileSync('launchctl', ['bootstrap', `gui/${process.getuid()}`, plistFor(label)], { stdio: 'pipe' }); return } catch (e) {
      if (i >= 9) throw new Error(`macOS wouldn't start ${label}: ${String(e.stderr).trim()}`)
      sleepSync(1000)
    }
  }
}
// Stops a login item and waits until launchd has let go of it.
function stopAgent(label, remove = true) {
  try { execFileSync('launchctl', ['bootout', `gui/${process.getuid()}/${label}`], { stdio: 'ignore' }) } catch {}
  for (let i = 0; i < 20 && loaded(label); i++) sleepSync(500)
  if (remove) fs.rmSync(plistFor(label), { force: true })
}
const loaded = label => { try { execFileSync('launchctl', ['print', `gui/${process.getuid()}/${label}`], { stdio: 'ignore' }); return true } catch { return false } }
const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

async function relay(sub) {
  const settings = readRelaySettings()
  if (!sub) { // the relay itself (the login item runs this)
    const { startRelay } = await import('../server/relay-server.mjs')
    // The address is read again for each attachment, so it can be set after the relay started.
    const r = await startRelay({ port: settings.port || RELAY_PORT, dir: RELAY_DIR, publicURL: () => readRelaySettings().url })
    console.log(`Handoff relay on ${r.local}${settings.url ? `, on the internet as ${settings.url}` : ''}`)
    return
  }
  if (sub === 'share') { // the zrok login item runs this
    // When the Mac changes networks or sleeps, zrok can die without telling its servers, and the old
    // share keeps the name: every new try then fails with "name … is in use by share 'abc123'". That
    // share is ours (the name is), so release it and start again right away. Anything else, launchd
    // starts this again a minute later.
    const z = zrok()
    if (!z || !settings.name) { console.error('No relay set up. Run: handoff relay setup'); process.exit(1) }
    const share = (tries = 0) => {
      const p = spawn(z, ['share', 'public', `http://127.0.0.1:${settings.port || RELAY_PORT}`, '--name-selection', `public:${settings.name}`, '--headless'])
      let released = false
      const watch = d => {
        process.stdout.write(d)
        const m = /in use by share '([\w-]+)'/.exec(String(d))
        if (m && !released) {
          released = true
          try { execFileSync(z, ['delete', 'share', m[1]], { stdio: 'inherit' }) } catch {}
          p.kill()
        }
      }
      p.stdout.on('data', watch)
      p.stderr.on('data', watch)
      // A few times in a row at most, so a share we can't release doesn't spin.
      p.on('exit', code => released && tries < 3 ? setTimeout(() => share(tries + 1), 2000) : process.exit(code ?? 1))
    }
    share()
    return
  }
  if (sub === 'status') {
    const url = ownRelay()
    if (!url) return console.log('Not using your own relay: the watch and this Mac talk through ntfy.sh. Set one up with: handoff relay setup')
    const local = await healthy(`http://127.0.0.1:${settings.port || RELAY_PORT}`), pub = local && await healthy(url)
    const paired = readConfig()?.topicURL?.startsWith(url + '/')
    console.log(`Your relay: ${url}\n  On this Mac: ${local ? 'running' : 'not running (run: handoff relay setup)'}\n` +
      `  From the internet: ${pub ? 'reachable' : `not reachable (see ${path.join(RELAY_DIR, 'zrok.log')}, or run: handoff relay setup)`}\n` +
      `  Your watch: ${paired ? 'paired through it' : 'not using it yet. On the watch: Settings, Unpair; then open Hand-Off and run handoff pair CODE'}`)
    return
  }
  if (sub === 'off') {
    if (process.platform === 'darwin') for (const label of Object.values(AGENTS)) stopAgent(label)
    fs.rmSync(OWN_RELAY, { force: true })
    console.log('Your own relay is off. To go back to ntfy.sh, pair again: on the watch, Settings, Unpair; then open Hand-Off and run handoff pair CODE')
    return
  }
  if (sub !== 'setup') { console.error('Usage: handoff relay [setup|status|off]'); process.exit(1) }

  if (process.platform !== 'darwin') { console.error('handoff relay setup is for macOS. Elsewhere, run `handoff relay` and put port 8795 on the internet over https yourself.'); process.exit(1) }
  const z = zrok()
  if (!z) {
    console.error('zrok isn\'t installed. It gives your relay a fixed web address, for free. Install it with:\n  brew install zrok\nthen run handoff relay setup again.')
    process.exit(1)
  }
  try { execFileSync(z, ['overview'], { stdio: 'ignore' }) } catch {
    console.error('zrok needs a free account first:\n' +
      '  1. Sign up at https://myzrok.io and open the zrok console there.\n' +
      `  2. Copy your account token and run: ${path.basename(z)} enable YOUR_TOKEN\n` +
      '  3. Run handoff relay setup again.')
    process.exit(1)
  }

  // A fixed name on zrok's public frontend, so the address stays the same after restarts.
  fs.mkdirSync(RELAY_DIR, { recursive: true, mode: 0o700 })
  const name = settings.name || `handoff-${crypto.randomBytes(5).toString('hex')}`
  if (!settings.name) {
    try { execFileSync(z, ['create', 'name', name], { stdio: ['ignore', 'pipe', 'pipe'] }) } catch (e) {
      console.error(`zrok couldn't create the name ${name}: ${String(e.stderr || e.message).trim()}`)
      process.exit(1)
    }
  }
  const save = extra => fs.writeFileSync(OWN_RELAY, JSON.stringify({ ...readRelaySettings(), port: RELAY_PORT, name, ...extra }, null, 2), { mode: 0o600 })
  save({})

  startAgent(AGENTS.relay, [process.execPath, fileURLToPath(import.meta.url), 'relay'], path.join(RELAY_DIR, 'relay.log'))
  const log = path.join(RELAY_DIR, 'zrok.log')
  fs.writeFileSync(log, '')
  // A minute between tries: zrok answers quick retries with 429 ("the zrok service is busy") and keeps refusing.
  startAgent(AGENTS.share, [process.execPath, fileURLToPath(import.meta.url), 'relay', 'share'], log, 60)
  console.log('Started your relay on this Mac (it starts again at login). Putting it on the internet with zrok…')

  // zrok prints the share's address once it's up ("access your zrok share at … handoff-….shares.zrok.io").
  let url
  for (let i = 0; i < 60 && !url; i++) {
    await new Promise(r => setTimeout(r, 1000))
    const host = new RegExp(`\\b${name}(?:\\.[a-z0-9-]+)+`, 'i').exec(fs.readFileSync(log, 'utf8'))?.[0]
    if (host) url = `https://${host}`
  }
  if (!url) {
    console.error(`zrok didn't say its address within a minute. What it said is in ${log}. Run handoff relay setup again to retry.`)
    process.exit(1)
  }
  url = url.toLowerCase()
  save({ url })
  let ok = false
  for (let i = 0; i < 12 && !ok; i++) { ok = await healthy(url); if (!ok) await new Promise(r => setTimeout(r, 5000)) }
  if (!ok) {
    console.error(`\n${url} doesn't answer yet. Check again in a minute with: handoff relay status`)
    process.exit(1)
  }
  console.log(`\nYour relay works: ${url}\n` +
    'Now move your watch to it: on the watch, Settings, Unpair. Then open Hand-Off and run: handoff pair CODE\n' +
    '(Pairing starts on ntfy.sh, so it needs ntfy.sh to let one message through. After that, nothing uses ntfy.sh.)')
}

// The screen-control extra (extras/screen): lets the chats this command opens see the screen and use
// the mouse and keyboard. Off unless you turn it on; deliberately left out of `handoff help`.
function screenControl(sub, arg) {
  const ctl = path.join(DIR, 'bin', 'screenctl')
  const save = (on, more = {}) => { fs.mkdirSync(DIR, { recursive: true, mode: 0o700 }); writeAtomic(EXTRAS, JSON.stringify({ ...extras(), screen: on, ...more }, null, 2)) }
  const check = () => { try { return execFileSync(ctl, ['check'], { encoding: 'utf8' }) } catch { return '' } }
  if (sub === 'on') {
    if (process.platform !== 'darwin') { console.error('Screen control only works on a Mac.'); process.exit(1) }
    fs.mkdirSync(path.dirname(ctl), { recursive: true, mode: 0o700 })
    console.log('Building screenctl (the mouse and keyboard)...')
    try {
      execFileSync('swiftc', ['-O', fileURLToPath(new URL('../extras/screen/screenctl.swift', import.meta.url)), '-o', ctl], { stdio: 'inherit' })
    } catch { console.error("Couldn't build it. It needs Apple's command line tools: xcode-select --install"); process.exit(1) }
    save(true)
    const c = check()
    console.log('\nScreen control is on. New chats from `handoff start` and `handoff host` can see your screen and\n' +
      'use the mouse and keyboard while you are away. Chats already running need a restart.\n')
    if (!c.includes('accessibility:yes') || !c.includes('screen:yes'))
      console.log('macOS needs your OK first. In System Settings > Privacy & Security, allow the app you run\n' +
        'handoff in (Terminal, iTerm...) under both Accessibility and Screen & System Audio Recording,\n' +
        'then quit and reopen that app. Check with: handoff lab screen-control status')
    console.log('Turn it off with: handoff lab screen-control off')
  } else if (sub === 'off') {
    save(false)
    fs.rmSync(ctl, { force: true })
    console.log('Screen control is off. Chats already running keep it until they restart.')
  } else if (sub === 'awake' && (arg === 'on' || arg === 'off')) {
    if (!screenOn()) { console.error('Turn screen control on first: handoff lab screen-control on'); process.exit(1) }
    save(true, { awake: arg === 'on' })
    console.log(arg === 'on'
      ? "While `handoff start` or `handoff host` runs, your display won't sleep, so the Mac won't lock itself\n" +
        'and screen control keeps working. Anyone at the Mac can use it then too. Locking it yourself\n' +
        '(Ctrl+Cmd+Q) still locks it. Restart host and chats to start this.'
      : 'The display can sleep and lock again (after host and chats restart).')
  } else if (sub === 'status') {
    const c = check()
    console.log(`Screen control is ${screenOn() ? 'on' : 'off'}.` + (c ? `\n  Accessibility (mouse, keyboard): ${c.includes('accessibility:yes') ? 'allowed' : 'not allowed'}\n  Screen Recording (screenshots): ${c.includes('screen:yes') ? 'allowed' : 'not allowed'}\n  Screen locked now: ${c.includes('locked:yes') ? 'yes' : 'no'}` : '') +
      `\n  Keep the display awake: ${extras().awake === true ? 'on' : 'off'} (handoff lab screen-control awake on|off)`)
  } else {
    console.error('Usage: handoff lab screen-control on|off|status|awake on|off')
    process.exit(1)
  }
}

// `handoff extras`: optional Mac extras in extras/, so a chat can use the screen while you're away, wired
// up with one command. Each one says what macOS still needs from you (Accessibility switches can't be
// flipped for you). The Claude Code settings it touches (~/.claude/settings.json) are backed up first.
//   screen     Handoff's own screen tools (mcp__screen__*), for chats Handoff opens
//   deskhand   Karam Lamba's Deskhand as the `computer` tool, in every Claude Code chat
//   cover      a fake lock screen: the Mac never really locks, so Claude can still use the screen
//   lidwake    LidWake (github.com/aaryanbindage/Lidwake): keeps the Mac running with the lid closed
function extrasCommand(sub, name, ...args) {
  const NAMES = ['screen', 'deskhand', 'cover', 'lidwake']
  const src = file => fileURLToPath(new URL(`../extras/${file}`, import.meta.url))
  const uid = process.getuid?.()
  const COVER = path.join(DIR, 'bin', 'cover')
  const COVER_LABEL = 'com.handoff.cover'
  const COVER_PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${COVER_LABEL}.plist`)
  const LIFT = `"${COVER}" lift 120`
  const LIFT_TOOLS = 'mcp__computer__computer|mcp__screen__.*'
  const LIDWAKE = '/usr/local/bin/lidwake'
  const saveExtras = more => {
    fs.mkdirSync(DIR, { recursive: true, mode: 0o700 })
    const next = { ...extras(), ...more }
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k]
    writeAtomic(EXTRAS, JSON.stringify(next, null, 2))
  }
  const sh = (file, argv, opts = {}) => { try { return execFileSync(file, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...opts }) } catch { return null } }
  const mac = () => { if (process.platform !== 'darwin') { console.error('The extras only work on a Mac.'); process.exit(1) } }

  // ~/.claude/settings.json: the permission and hook these extras need, added and taken away again.
  const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json')
  const settings = change => {
    let s = {}
    try { s = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')) } catch (e) { if (e.code !== 'ENOENT') { console.error(`Couldn't read ${SETTINGS}: ${e.message}`); process.exit(1) } }
    const before = JSON.stringify(s)
    change(s)
    if (JSON.stringify(s) === before) return
    fs.mkdirSync(path.dirname(SETTINGS), { recursive: true })
    if (fs.existsSync(SETTINGS) && !fs.existsSync(`${SETTINGS}.handoff-backup`)) fs.copyFileSync(SETTINGS, `${SETTINGS}.handoff-backup`)
    writeAtomic(SETTINGS, JSON.stringify(s, null, 2) + '\n')
  }
  const allow = (perm, on) => settings(s => {
    const list = (s.permissions ??= {}).allow ??= []
    const i = list.indexOf(perm)
    if (on && i < 0) list.push(perm)
    if (!on && i >= 0) list.splice(i, 1)
  })
  const liftHook = on => settings(s => {
    const pre = ((s.hooks ??= {}).PreToolUse ??= [])
    const ours = h => h.hooks?.some(x => x.command === LIFT)
    if (on && !pre.some(ours)) pre.push({ matcher: LIFT_TOOLS, hooks: [{ type: 'command', command: LIFT }] })
    if (!on) s.hooks.PreToolUse = pre.filter(h => !ours(h))
    if (!s.hooks.PreToolUse.length) delete s.hooks.PreToolUse
    if (!Object.keys(s.hooks).length) delete s.hooks
  })
  const askForAccessibility = what => {
    console.log(`\nmacOS needs your OK: System Settings > Privacy & Security > Accessibility is opening, with ${what}\n` +
      'in a Finder window. Drag it into the list and switch it on (if it is already there, remove it with − first:\n' +
      'a new build needs a new OK).')
    sh('open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'])
  }

  const deskhandApp = () => ['/Applications/Deskhand.app', path.join(os.homedir(), 'Applications', 'Deskhand.app')].find(a => fs.existsSync(a))
  const coverRunning = () => sh('launchctl', ['print', `gui/${uid}/${COVER_LABEL}`])?.includes('state = running') ?? false
  const deskhandOn = () => (sh('claude', ['mcp', 'get', 'computer']) ?? '').includes('Deskhand')

  const install = {
    screen() { screenControl('on') },
    deskhand() {
      let app = deskhandApp()
      if (!app) {
        app = path.join(os.homedir(), 'Applications', 'Deskhand.app')
        fs.mkdirSync(path.dirname(app), { recursive: true })
        execFileSync('ditto', ['-x', '-k', src('deskhand/Deskhand.zip'), path.dirname(app)])
        fs.rmSync(path.join(path.dirname(app), '__MACOSX'), { recursive: true, force: true })
        saveExtras({ deskhandApp: app })
        console.log(`Put Deskhand in ${app}.`)
      }
      const bin = path.join(app, 'Contents', 'MacOS', 'Deskhand')
      if (!deskhandOn()) {
        sh('claude', ['mcp', 'remove', '--scope', 'user', 'computer'])
        if (sh('claude', ['mcp', 'add', '--scope', 'user', 'computer', '--', bin, '--mcp']) === null) {
          console.error("Couldn't add it to Claude Code. Is `claude` installed? Then: handoff extras install deskhand"); process.exit(1)
        }
      }
      allow('mcp__computer__computer', true)
      console.log('Deskhand is Claude\'s `computer` tool in every Claude Code chat (new chats; restart running ones).\n' +
        'macOS asks first: allow the app you run Claude in (Terminal, iTerm...) under Accessibility and\n' +
        'Screen & System Audio Recording in System Settings > Privacy & Security.')
    },
    cover() {
      mac()
      fs.mkdirSync(path.dirname(COVER), { recursive: true, mode: 0o700 })
      fs.mkdirSync(path.join(DIR, 'cover'), { recursive: true, mode: 0o700 })
      console.log('Building the fake lock screen...')
      try {
        execFileSync('clang', ['-fobjc-arc', '-O2', ...['AppKit', 'CoreGraphics', 'IOKit', 'OpenDirectory', 'QuartzCore'].flatMap(f => ['-framework', f]),
          src('cover/cover.m'), '-o', COVER], { stdio: 'inherit' })
      } catch { console.error("Couldn't build it. It needs Apple's command line tools: xcode-select --install"); process.exit(1) }
      fs.mkdirSync(path.dirname(COVER_PLIST), { recursive: true })
      fs.writeFileSync(COVER_PLIST, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${COVER_LABEL}</string>
  <key>ProgramArguments</key><array><string>${COVER}</string><string>run</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardErrorPath</key><string>${path.join(DIR, 'cover', 'cover.log')}</string>
</dict></plist>
`)
      sh('launchctl', ['bootout', `gui/${uid}`, COVER_PLIST])
      execFileSync('launchctl', ['bootstrap', `gui/${uid}`, COVER_PLIST])
      liftHook(true)
      console.log('\nThe fake lock screen is on. Your Mac no longer locks for real: when the lid closes, or after 5 minutes\n' +
        'with nobody using it and nothing playing, this covers the screen instead. Your Mac password opens it\n' +
        '(macOS checks it; it is never stored). Claude lifts it while it uses the screen.\n' +
        'It is weaker than the real lock, on purpose. Two ways past it if it ever breaks:\n' +
        '  Ctrl+Option+Cmd+Shift+U, or Force Quit (Cmd+Option+Esc)\n' +
        'Try it: handoff extras cover test    Picture: handoff extras cover wallpaper desktop|<image>|none')
      askForAccessibility('cover (so it can take the keyboard)')
      sh('open', ['-R', COVER])
      console.log('Then: handoff extras cover restart')
    },
    lidwake() {
      mac()
      if (fs.existsSync(LIDWAKE)) {
        saveExtras({ lidwake: true })
        console.log(`LidWake is already installed (${LIDWAKE}). Handoff now starts it while a chat or host runs on battery-powered\n` +
          'MacBooks, until Handoff stops or the battery is at 10%.')
        return
      }
      // install.sh builds next to itself, and the package folder may not be writable: run it from a copy.
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lidwake-'))
      fs.cpSync(src('lidwake'), tmp, { recursive: true })
      try { execFileSync('bash', [path.join(tmp, 'install.sh')], { stdio: 'inherit', cwd: tmp }) }
      catch { console.error('LidWake did not install (see above).'); process.exit(1) }
      finally { fs.rmSync(tmp, { recursive: true, force: true }) }
      sh(LIDWAKE, ['claude-hook', '--install'], { stdio: 'inherit' })
      saveExtras({ lidwake: true })
      console.log('\nLidWake keeps the Mac running with the lid closed. Handoff starts it while a chat or host runs, until\n' +
        'Handoff stops or the battery is at 10%. While it runs, Sleep is greyed out in the Apple menu.')
    },
  }
  const remove = {
    screen() { screenControl('off') },
    deskhand() {
      if (deskhandOn()) sh('claude', ['mcp', 'remove', '--scope', 'user', 'computer'])
      allow('mcp__computer__computer', false)
      const ours = extras().deskhandApp
      if (ours) { fs.rmSync(ours, { recursive: true, force: true }); saveExtras({ deskhandApp: undefined }) }
      console.log('Deskhand is no longer a Claude Code tool.' + (ours ? '' : ' The app itself is still where you put it.'))
    },
    cover() {
      sh('launchctl', ['bootout', `gui/${uid}`, COVER_PLIST])
      fs.rmSync(COVER_PLIST, { force: true })
      fs.rmSync(COVER, { force: true })
      liftHook(false)
      console.log('The fake lock screen is off; your Mac locks for real again. You can take cover out of\n' +
        'System Settings > Privacy & Security > Accessibility.')
    },
    lidwake() {
      mac()
      saveExtras({ lidwake: undefined })
      if (!fs.existsSync(LIDWAKE)) { console.log('LidWake is not installed.'); return }
      execFileSync('bash', [src('lidwake/uninstall.sh')], { stdio: 'inherit' })
    },
  }

  const pick = n => {
    const list = n === 'all' ? NAMES : [n]
    if (!list.every(x => NAMES.includes(x))) { console.error(`Which one? ${NAMES.join(', ')} or all`); process.exit(1) }
    return list
  }
  if (sub === 'install' || sub === 'remove') {
    if (!name) { console.error(`Usage: handoff extras ${sub} ${NAMES.join('|')}|all`); process.exit(1) }
    for (const n of pick(name)) {
      if (name === 'all') console.log(`\n== ${n} ==`)
      ;(sub === 'install' ? install : remove)[n]()
    }
  } else if (sub === 'cover' && name === 'test') {
    if (!fs.existsSync(COVER)) { console.error('Install it first: handoff extras install cover'); process.exit(1) }
    console.log('Showing the fake lock screen for up to 60 seconds. Your password, Ctrl+Option+Cmd+Shift+U\n' +
      'or Force Quit (Cmd+Option+Esc) closes it.')
    run(COVER, ['test'], { stdio: 'inherit' })
  } else if (sub === 'cover' && name === 'restart') {
    if (!fs.existsSync(COVER_PLIST)) { console.error('Install it first: handoff extras install cover'); process.exit(1) }
    sh('launchctl', ['kickstart', '-k', `gui/${uid}/${COVER_LABEL}`])
    console.log(coverRunning() ? 'The fake lock screen restarted.' : `It didn't start; see ${path.join(DIR, 'cover', 'cover.log')}`)
  } else if (sub === 'cover' && name === 'wallpaper' && args[0]) {
    const choice = args[0]
    if (choice === 'none' || choice === 'desktop') saveExtras({ coverWallpaper: choice === 'none' ? undefined : 'desktop' })
    else {
      const file = path.resolve(choice)
      const ext = path.extname(file).toLowerCase()
      if (!fs.existsSync(file) || !['.png', '.jpg', '.jpeg', '.heic', '.tif', '.tiff', '.gif', '.webp'].includes(ext)) {
        console.error('Give it a picture (PNG, JPEG, HEIC...), or desktop for your desktop picture, or none.'); process.exit(1)
      }
      // A copy, so it keeps working if you move or delete the original.
      const copy = path.join(DIR, 'cover', `wallpaper${ext}`)
      fs.mkdirSync(path.dirname(copy), { recursive: true, mode: 0o700 })
      for (const old of fs.readdirSync(path.dirname(copy))) if (old.startsWith('wallpaper.')) fs.rmSync(path.join(path.dirname(copy), old))
      fs.copyFileSync(file, copy)
      saveExtras({ coverWallpaper: copy })
    }
    console.log(choice === 'none' ? 'The fake lock screen is plain dark grey again.'
      : `The fake lock screen shows ${choice === 'desktop' ? 'your desktop picture' : path.basename(choice)} from the next time it covers.`)
  } else if (!sub || sub === 'status') {
    const e = extras()
    const yes = b => (b ? 'on ' : 'off')
    console.log(`Handoff extras (handoff extras install|remove NAME, or all):
  screen     ${yes(e.screen === true)}  Handoff's screen tools for the chats it opens
  deskhand   ${yes(deskhandOn())}  Deskhand by Karam Lamba as Claude's computer tool
  cover      ${yes(fs.existsSync(COVER_PLIST))}  fake lock screen${fs.existsSync(COVER_PLIST) ? ` (${coverRunning() ? 'running' : 'not running'}; picture: ${e.coverWallpaper ? (e.coverWallpaper === 'desktop' ? 'desktop' : path.basename(e.coverWallpaper)) : 'none'})` : ''}
  lidwake    ${yes(fs.existsSync(LIDWAKE) && e.lidwake === true)}  LidWake (aaryanbindage): runs with the lid closed while Handoff does (to 10% battery)

  handoff extras cover test | restart | wallpaper desktop|<image>|none`)
  } else {
    console.error(`Usage: handoff extras [status]
       handoff extras install|remove ${NAMES.join('|')}|all
       handoff extras cover test|restart|wallpaper desktop|<image>|none`)
    process.exit(1)
  }
}
