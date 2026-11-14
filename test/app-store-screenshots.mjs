// App Store screenshots: runs the watch app in the simulator against a mock relay with sample
// chats, a suggestion and some history, and saves screenshots to docs/app-store/screenshots/.
//   node test/app-store-screenshots.mjs [device type ...]
// Default device types: the largest watch (Ultra 3) and both SE 3 sizes, which App Store Connect
// accepts for every smaller screen. Builds for the simulator only; nothing goes on a real watch.
import { execFileSync, spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startMock } from './mock-ntfy.mjs'

const ROOT = new URL('..', import.meta.url).pathname
const SERVER = path.join(ROOT, 'server/handoff.mjs')
const CLI = path.join(ROOT, 'cli/handoff.mjs')
const OUT = path.join(ROOT, 'docs/app-store/screenshots')
const BUNDLE = 'dev.maxbuda.ClaudeNotes.watchkitapp'
const TYPES = process.argv.slice(2).length ? process.argv.slice(2)
  : ['Apple Watch Ultra 3 (49mm)', 'Apple Watch SE 3 (44mm)', 'Apple Watch SE 3 (40mm)']
const sleep = ms => new Promise(r => setTimeout(r, ms))
const sim = (...a) => execFileSync('xcrun', ['simctl', ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
const code = () => Array.from({ length: 8 }, () => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[crypto.randomInt(31)]).join('')

function seal(obj, key) {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([c.update(JSON.stringify(obj)), c.final()])
  return Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64')
}

// Sample history, as the app stores it (Note's Codable JSON; dates are seconds since 2001).
const ago = mins => (Date.now() / 1000 - 978307200) - mins * 60
const history = [
  { text: 'Make the settings page work in dark mode', to: 'website', mins: 12 },
  { text: 'Why is the login test flaky', to: 'website', mins: 55 },
  { text: 'Write a README for the weather app', to: 'weather-app', mins: 140 },
].map(n => ({ id: crypto.randomUUID().toUpperCase(), text: n.text, ts: ago(n.mins), to: n.to, sent: true }))
const plistData = buf => `<${buf.toString('hex')}>`

// The picture Claude "sends" in screenshot 4: a small web page, drawn by headless Chrome.
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const SAMPLE = (() => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cwn-sample-'))
  fs.writeFileSync(path.join(d, 'page.html'), `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;font:600 34px -apple-system,sans-serif;background:#0f172a;color:#f1f5f9}
    header{display:flex;justify-content:space-between;align-items:center;padding:28px 36px;background:#1e293b}
    .t{width:96px;height:52px;border-radius:26px;background:#f59e0b;position:relative}
    .t:after{content:'';position:absolute;right:6px;top:6px;width:40px;height:40px;border-radius:20px;background:#fff}
    main{padding:40px 36px} h1{font-size:64px;margin:0 0 18px} p{color:#94a3b8;font-weight:400;margin:0 0 30px}
    a{display:inline-block;padding:20px 36px;border-radius:16px;background:#f59e0b;color:#111;text-decoration:none}
  </style><header>My Website <span class="t"></span></header>
  <main><h1>Dark mode is here</h1><p>Tap the switch at the top to change it.</p><a>Get started</a></main>`)
  execFileSync(CHROME, ['--headless', '--disable-gpu', '--hide-scrollbars', '--window-size=800,600',
    `--screenshot=${path.join(d, 'page.png')}`, `file://${path.join(d, 'page.html')}`], { stdio: 'ignore' })
  execFileSync('sips', ['-Z', '480', '-s', 'format', 'jpeg', '-s', 'formatOptions', '80', path.join(d, 'page.png'), '--out', path.join(d, 'page.jpg')], { stdio: 'ignore' })
  return fs.readFileSync(path.join(d, 'page.jpg'))
})()

const mock = await startMock({ port: 8798 })
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwn-shots-'))
const env = { ...process.env, CLAUDE_WATCH_NOTES_DIR: dir, CLAUDE_WATCH_NOTES_RELAY: mock.url, CLAUDE_WATCH_NOTES_NO_SIM: '1' }
const kids = []
const run = (args, extra = {}) => { const p = spawn(process.execPath, args, { env: { ...env, ...extra }, stdio: ['pipe', 'ignore', 'ignore'] }); kids.push(p); return p }

try {
  console.log('Building for the simulator…')
  const build = path.join(ROOT, 'build/dd-shots')
  execFileSync('xcodebuild', ['build', '-project', path.join(ROOT, 'watch/ClaudeNotes.xcodeproj'), '-scheme', 'ClaudeNotes',
    '-configuration', 'Debug', '-destination', 'generic/platform=watchOS Simulator', '-derivedDataPath', build,
    'CODE_SIGN_IDENTITY=-'], { stdio: 'ignore' })
  const app = path.join(build, 'Build/Products/Debug-watchsimulator/ClaudeNotes.app')
  fs.mkdirSync(OUT, { recursive: true })

  for (const type of TYPES) {
    const udid = sim('create', `Screenshots ${type}`, type)
    try {
      sim('boot', udid)
      sim('bootstatus', udid, '-b')
      sim('install', udid, app)
      // -quiet: no haptics, which the simulator plays as sounds.
      const launch = (...args) => { try { sim('terminate', udid, BUNDLE) } catch {} sim('launch', udid, BUNDLE, '-relay', mock.url, '-quiet', 'YES', ...args) }
      const shot = async (name, wait = 4000) => {
        await sleep(wait)
        const file = path.join(OUT, `${type.replace(/[^\w]+/g, '-').replace(/-+$/, '')}-${name}.png`)
        sim('io', udid, 'screenshot', '--type=png', file)
        console.log(`  ${path.relative(ROOT, file)}`)
      }
      console.log(type)

      // 1. Pairing: what you see first.
      launch('-resetPairing', 'YES')
      await shot('1-pair')

      // Pair for real against the mock relay, then open two chats and a host on the Mac side.
      fs.rmSync(path.join(dir, 'config.json'), { force: true })
      const c = code()
      const pair = run([SERVER, 'pair'], { CLAUDE_WATCH_NOTES_PAIR_CODE: c })
      launch('-resetPairing', 'NO', '-pairCode', c)
      await new Promise(r => pair.on('exit', r))
      const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'))
      const key = Buffer.from(cfg.key, 'base64')
      for (const name of ['website', 'weather-app']) {
        const s = run([SERVER], { CLAUDE_WATCH_NOTES_CHANNEL: '1', CLAUDE_WATCH_NOTES_NAME: name })
        s.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n')
      }
      const projects = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwn-shots-root-')))
      for (const d of ['website', 'weather-app', 'school-robotics']) fs.mkdirSync(path.join(projects, d))
      run([CLI, 'host', projects], { CLAUDE_WATCH_NOTES_HOST_DRYRUN: '1' })
      await fetch(`${cfg.topicURL}-s`, { method: 'POST', body: seal({ s: 'add a dark mode toggle to the header', note: 'x', chat: 'website', ts: new Date().toISOString() }, key) })
      await sleep(2500) // heartbeats land

      const notes = plistData(Buffer.from(JSON.stringify(history)))
      // 2. Claude's suggested next step, one tap to send back.
      launch('-target', 'website', '-draft', '()', '-notes', notes)
      await shot('2-suggestion', 7000)

      // 3. A note being written, for the chat picked in To. (`-suggestion <>` clears the saved one.)
      launch('-target', 'website', '-suggestion', '<>', '-suggestionsOn', 'NO', '-notes', notes,
        '-draft', '("Add a contact form to the home page", "with name and email")')
      await shot('3-write', 7000)

      // 4. What Claude built, sent back as a picture (a clip plays the same way).
      await fetch(`${cfg.topicURL}-i`, { method: 'POST', body: seal({ i: SAMPLE.toString('base64'), note: 'x', chat: 'website', ts: new Date().toISOString() }, key) })
      launch('-target', 'website', '-suggestion', '<>', '-suggestionsOn', 'NO', '-notes', notes, '-draft', '()')
      await shot('4-screenshot', 9000)

      // 5. Claude asks before it runs something; allow or deny on the wrist.
      await fetch(`${cfg.topicURL}-p`, { method: 'POST', body: seal({ p: crypto.randomUUID(), tool: 'Bash', what: 'Run the test suite', input: 'npm test', chat: 'website', ts: new Date().toISOString() }, key) })
      launch('-target', 'website', '-suggestion', '<>', '-suggestionsOn', 'NO', '-notes', notes, '-draft', '()')
      await shot('5-approve', 7000)

      for (const k of kids.splice(0)) k.kill()
    } finally {
      try { sim('shutdown', udid) } catch {}
      sim('delete', udid)
    }
  }
} finally {
  for (const k of kids) k.kill()
  await mock.close()
}
