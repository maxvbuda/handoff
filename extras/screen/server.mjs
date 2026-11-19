#!/usr/bin/env node
// Handoff's screen-control extra: an MCP server that lets a Claude Code chat see the Mac's main
// display and use its mouse and keyboard. Separate from Handoff itself, and off unless you run
// `handoff lab screen-control on`; then the chats `handoff start` and `handoff host` open get it,
// as mcp__screen__*. The mouse and keyboard go through screenctl (screenctl.swift, compiled then).
//
// Coordinates are always in the pixels of the last screenshot: we scale them to the display's points.

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DIR = process.env.CLAUDE_WATCH_NOTES_DIR || path.join(os.homedir(), '.claude-watch-notes')
const CTL = process.env.HANDOFF_SCREENCTL || path.join(DIR, 'bin', 'screenctl')
const MAX_WIDTH = 1440 // screenshots are no wider than this; most Mac displays are about this many points wide

const run = (cmd, args) => new Promise((resolve, reject) =>
  execFile(cmd, args, { timeout: 30_000 }, (e, stdout, stderr) => e ? reject(new Error(String(stderr || e.message).trim())) : resolve(stdout)))
const ctl = (...a) => run(CTL, a.map(String))

let scale = null // screenshot pixels per point, from the last screenshot
async function size() {
  const [w, h] = (await ctl('size')).trim().split(/\s+/).map(Number)
  return { w, h }
}
async function toPoints(x, y) {
  if (scale === null) throw new Error('Take a screenshot first (screen_screenshot): coordinates are in its pixels.')
  if (![x, y].every(Number.isFinite)) throw new Error('x and y must be numbers.')
  return [Math.round(x / scale), Math.round(y / scale)]
}

async function screenshot() {
  // The display may be dark while the Mac is awake: wake it. With the lid closed it can't light up,
  // and a capture would only be black, so say so rather than hand back a black picture.
  const state = await ctl('wake')
  if (state.includes('screen:locked')) {
    throw new Error('The Mac is locked (closing the lid locks it), so the screen is black and nothing can be seen or controlled. ' +
      "Don't type a password or try another way in. Tell the user: unlock it (in person, or with Screen Sharing), then send the note again.")
  }
  if (state.includes('display:asleep')) {
    throw new Error("The Mac's display is off and won't wake (the lid is probably closed, so there is no screen to see). " +
      "Don't try another way to look at it. Tell the user: open the lid and unlock the Mac, then send the note again.")
  }
  const { w, h } = await size()
  scale = Math.min(1, MAX_WIDTH / w)
  const width = Math.round(w * scale)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-screen-'))
  try {
    const raw = path.join(tmp, 'raw.png'), small = path.join(tmp, 'small.jpg')
    await run('/usr/sbin/screencapture', ['-x', '-m', '-t', 'png', raw])
    await run('/usr/bin/sips', ['--resampleWidth', String(width), '-s', 'format', 'jpeg', '-s', 'formatOptions', '70', raw, '--out', small])
    return { data: fs.readFileSync(small).toString('base64'), width, height: Math.round(h * scale) }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

const settle = () => new Promise(r => setTimeout(r, 400)) // let the screen catch up before the next look

const xy = { x: { type: 'number' }, y: { type: 'number' } }
const TOOLS = [
  { name: 'screen_screenshot', description: "A screenshot of the Mac's main display. Coordinates for the other tools are in this image's pixels; take a new one after anything changes the screen.", inputSchema: { type: 'object', properties: {} } },
  { name: 'screen_click', description: 'Click at x, y (pixels of the last screenshot). button: left (default) or right; count: 2 for a double click.', inputSchema: { type: 'object', properties: { ...xy, button: { type: 'string', enum: ['left', 'right'] }, count: { type: 'integer', minimum: 1, maximum: 3 } }, required: ['x', 'y'] } },
  { name: 'screen_move', description: 'Move the pointer to x, y without clicking (to hover).', inputSchema: { type: 'object', properties: xy, required: ['x', 'y'] } },
  { name: 'screen_drag', description: 'Drag with the left button held from x, y to to_x, to_y.', inputSchema: { type: 'object', properties: { ...xy, to_x: { type: 'number' }, to_y: { type: 'number' } }, required: ['x', 'y', 'to_x', 'to_y'] } },
  { name: 'screen_scroll', description: 'Scroll where the pointer is (move it first). lines: negative scrolls down, positive up; across: negative left, positive right.', inputSchema: { type: 'object', properties: { lines: { type: 'integer' }, across: { type: 'integer' } }, required: ['lines'] } },
  { name: 'screen_type', description: 'Type text into whatever has focus.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'screen_key', description: 'Press a key or shortcut, like return, escape, tab, down, cmd+space, cmd+shift+t.', inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } },
  { name: 'screen_batch', description: 'Several actions in a row, in one call, then a screenshot (unless screenshot is false). ' +
      'Each action is {"action": "click"|"move"|"drag"|"scroll"|"type"|"key"|"wait", ...the same fields as that tool} (wait: ms, up to 5000). ' +
      'Coordinates are in the last screenshot\'s pixels, so only chain steps whose positions you already know. Stops at the first that fails.',
    inputSchema: { type: 'object', properties: { actions: { type: 'array', items: { type: 'object', properties: { action: { type: 'string', enum: ['click', 'move', 'drag', 'scroll', 'type', 'key', 'wait'] } }, required: ['action'] }, minItems: 1, maxItems: 30 }, screenshot: { type: 'boolean' } }, required: ['actions'] } },
]

const INSTRUCTIONS = "These tools see and use the Mac's screen, mouse and keyboard, while the user is away. " +
  'Look first (screen_screenshot), act, then look again to check it worked. Prefer the shell or AppleScript ' +
  'when they can do the job. Never type passwords, payment details or codes, never buy, send money, ' +
  'delete things, or send messages unless the note plainly asks for exactly that, and stop at any sign-in prompt.'

const look = async () => {
  const s = await screenshot()
  return [{ type: 'image', data: s.data, mimeType: 'image/jpeg' }, { type: 'text', text: `${s.width}×${s.height}` }]
}

// The note being worked on: a `handoff host` chat says which (HANDOFF_NOTE); otherwise the newest.
// Hand-Off 1.5 and later send `screen` (Settings → Computer use); older apps don't, and then it's allowed.
function allowed() {
  const notes = path.join(DIR, 'notes')
  let note = null
  try {
    const id = process.env.HANDOFF_NOTE
    if (id) note = JSON.parse(fs.readFileSync(path.join(notes, `${id.replace(/[^\w-]/g, '')}.json`), 'utf8'))
    else {
      const newest = fs.readdirSync(notes).filter(f => f.endsWith('.json'))
        .map(f => ({ f, t: fs.statSync(path.join(notes, f)).mtimeMs })).sort((a, b) => b.t - a.t)[0]
      if (newest) note = JSON.parse(fs.readFileSync(path.join(notes, newest.f), 'utf8'))
    }
  } catch {}
  if (note?.screen === false) throw new Error("Computer use is off: turn it on in Hand-Off's Settings on the watch (it's sent with each note). Don't try another way to control the screen.")
}

// While the Mac is locked the screen shows only the lock screen, and unlocking takes the user's password.
async function unlocked() {
  const isLocked = await run(CTL, ['locked']).then(() => true, () => false)
  if (isLocked) throw new Error("The Mac's screen is locked, so nothing on it can be seen or used. Don't try to unlock it " +
    '(that takes the password) or work around it. Tell the user: unlock the Mac, or to keep it from locking while Handoff ' +
    'runs, run `handoff lab screen-control awake on`.')
}

async function call(name, a = {}) {
  allowed()
  await unlocked()
  if (name === 'screen_screenshot') return look()
  if (name === 'screen_batch') {
    const steps = Array.isArray(a.actions) ? a.actions.slice(0, 30) : []
    if (!steps.length) throw new Error('No actions.')
    for (const [i, step] of steps.entries()) {
      try {
        if (step?.action === 'wait') await new Promise(r => setTimeout(r, Math.min(5000, Math.max(0, Number(step.ms) || 0))))
        else await act(`screen_${step?.action}`, step)
      } catch (e) {
        throw new Error(`Step ${i + 1} (${step?.action}) failed: ${e.message}. Steps before it ran.`)
      }
      await new Promise(r => setTimeout(r, 150))
    }
    await settle()
    const done = { type: 'text', text: `Ran ${steps.length} action${steps.length === 1 ? '' : 's'}.` }
    return a.screenshot === false ? [done] : [done, ...await look()]
  }
  await act(name, a)
  await settle()
  return [{ type: 'text', text: 'Done. Take a screenshot to see the result.' }]
}

// One mouse or keyboard action.
async function act(name, a = {}) {
  if (name === 'screen_click') {
    const [x, y] = await toPoints(a.x, a.y)
    await ctl('click', x, y, a.button === 'right' ? 'right' : 'left', a.count || 1)
  } else if (name === 'screen_move') {
    await ctl('move', ...await toPoints(a.x, a.y))
  } else if (name === 'screen_drag') {
    await ctl('drag', ...await toPoints(a.x, a.y), ...await toPoints(a.to_x, a.to_y))
  } else if (name === 'screen_scroll') {
    await ctl('scroll', Math.trunc(a.lines) || 0, Math.trunc(a.across) || 0)
  } else if (name === 'screen_type') {
    if (typeof a.text !== 'string' || !a.text) throw new Error('Nothing to type.')
    await ctl('type', a.text)
  } else if (name === 'screen_key') {
    await ctl('key', String(a.key || ''))
  } else {
    throw new Error(`No tool ${name}`)
  }
}

// ---------- MCP over stdio ----------
const out = msg => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
function handle({ id, method, params }) {
  if (method === 'initialize') {
    return out({ id, result: { protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'screen', version: '0.1.0' }, instructions: INSTRUCTIONS } })
  }
  if (id === undefined) return // notifications
  if (method === 'ping') return out({ id, result: {} })
  if (method === 'tools/list') return out({ id, result: { tools: TOOLS } })
  if (method === 'tools/call') {
    return call(params.name, params.arguments).then(
      content => out({ id, result: { content } }),
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
    if (line) try { handle(JSON.parse(line)) } catch (e) { process.stderr.write(`[screen] bad message ${e.message}\n`) }
  }
})
