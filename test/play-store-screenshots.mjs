// Google Play screenshots for the Wear OS app: runs the debug build in a booted Wear OS emulator
// against a mock relay with sample chats, a suggestion and some history, and saves screenshots to
// docs/play-store/screenshots/. Never touches a real watch or your real pairing.
//   node test/play-store-screenshots.mjs [adb serial]   (default: the first emulator)
// Build first: cd wear && ./gradlew assembleDebug
import { execFileSync, spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startMock } from './mock-ntfy.mjs'

const ROOT = new URL('..', import.meta.url).pathname
const SERVER = path.join(ROOT, 'server/handoff.mjs')
const CLI = path.join(ROOT, 'cli/handoff.mjs')
const OUT = path.join(ROOT, 'docs/play-store/screenshots')
const APK = path.join(ROOT, 'wear/app/build/outputs/apk/debug/app-debug.apk')
const APP = 'dev.maxbuda.handoff'
const ADB = path.join(process.env.ANDROID_HOME || path.join(os.homedir(), 'Library/Android/sdk'), 'platform-tools/adb')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const code = () => Array.from({ length: 8 }, () => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[crypto.randomInt(31)]).join('')
const quote = s => `'${String(s).replace(/'/g, `'\\''`)}'`

const serial = process.argv[2] || execFileSync(ADB, ['devices'], { encoding: 'utf8' })
  .split('\n').map(l => l.split('\t')[0]).find(s => s.startsWith('emulator-'))
if (!serial) throw new Error('Start the Wear OS emulator first (emulator -avd Pixel_Watch).')
const adb = (...a) => execFileSync(ADB, ['-s', serial, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })

function seal(obj, key) {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([c.update(JSON.stringify(obj)), c.final()])
  return Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64')
}

const history = JSON.stringify([
  { text: 'Make the settings page work in dark mode', to: 'website', mins: 12 },
  { text: 'Why is the login test flaky', to: 'website', mins: 55 },
  { text: 'Write a README for the weather app', to: 'weather-app', mins: 140 },
])

const mock = await startMock({ port: 8797 })
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwn-play-'))
const env = { ...process.env, CLAUDE_WATCH_NOTES_DIR: dir, CLAUDE_WATCH_NOTES_RELAY: mock.url, CLAUDE_WATCH_NOTES_NO_SIM: '1' }
const kids = []
const run = (args, extra = {}) => { const p = spawn(process.execPath, args, { env: { ...env, ...extra }, stdio: ['pipe', 'ignore', 'ignore'] }); kids.push(p); return p }

const launch = (extras = {}) => {
  const args = Object.entries({ relay: mock.url, ...extras }).map(([k, v]) =>
    typeof v === 'boolean' ? `--ez ${k} ${v}` : `-e ${k} ${quote(v)}`).join(' ')
  adb('shell', `am start -S -W -n ${APP}/.MainActivity ${args}`)
}
const shot = async (name, wait = 4000) => {
  await sleep(wait)
  const file = path.join(OUT, `${name}.png`)
  fs.writeFileSync(file, execFileSync(ADB, ['-s', serial, 'exec-out', 'screencap', '-p']))
  console.log(`  ${path.relative(ROOT, file)}`)
}

try {
  fs.mkdirSync(OUT, { recursive: true })
  adb('install', '-r', APK)
  // The watch must see the relay at the same URL as the Mac (pairing checks the topic's address).
  adb('reverse', `tcp:${new URL(mock.url).port}`, `tcp:${new URL(mock.url).port}`)
  adb('shell', 'settings put global device_provisioned 1; settings put secure user_setup_complete 1; settings put system screen_off_timeout 2147483647')
  adb('shell', 'svc power stayon true; input keyevent KEYCODE_WAKEUP')

  // 1. Pairing: what you see first.
  const c = code()
  launch({ resetPairing: true, pairCode: c })
  await shot('1-pair')

  // Pair for real against the mock relay, then open two chats and a host on the Mac side.
  const pair = run([SERVER, 'pair'], { CLAUDE_WATCH_NOTES_PAIR_CODE: c, CLAUDE_WATCH_NOTES_PAIR_TIMEOUT_MS: '60000' })
  await new Promise(r => pair.on('exit', r))
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'))
  const key = Buffer.from(cfg.key, 'base64')
  for (const name of ['website', 'weather-app']) {
    const s = run([SERVER], { CLAUDE_WATCH_NOTES_CHANNEL: '1', CLAUDE_WATCH_NOTES_NAME: name })
    s.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n')
  }
  const projects = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwn-play-root-')))
  for (const d of ['website', 'weather-app', 'school-robotics']) fs.mkdirSync(path.join(projects, d))
  run([CLI, 'host', projects], { CLAUDE_WATCH_NOTES_HOST_DRYRUN: '1' })
  await fetch(`${cfg.topicURL}-s`, { method: 'POST', body: seal({ s: 'add a dark mode toggle to the header', note: 'x', chat: 'website', ts: new Date().toISOString() }, key) })
  await sleep(2500) // heartbeats land

  // 2. Claude's suggested next step, one tap to send back.
  launch({ target: 'website', draft: '[]', notes: history })
  await shot('2-suggestion', 7000)

  // 3. A note being written, for the chat picked in To.
  launch({ target: 'website', suggestionsOn: false, notes: history,
    draft: JSON.stringify(['Add a contact form to the home page', 'with name and email']) })
  await shot('3-write', 7000)

  // 4. The same, in blue, to show the color themes.
  launch({ theme: 'Blue', target: 'weather-app', suggestionsOn: false, notes: history,
    draft: JSON.stringify(['Show the forecast in Celsius too']) })
  await shot('4-blue', 7000)
  launch({ theme: 'Clay' })
} finally {
  for (const k of kids) k.kill()
  await mock.close()
}
