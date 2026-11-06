#!/usr/bin/env node
// Stands in for `osascript -l JavaScript cli/mail.js` in mail tests. The mailbox is a JSON file
// ({ accounts, sent: [{ messageId, subject, at, content, to }] }); replies are appended to a log,
// and the next FAKE_MAIL_FAIL replies fail.
import fs from 'node:fs'

const [, , , op, me, to, messageId, subject, body] = process.argv.slice(2)
const box = JSON.parse(fs.readFileSync(process.env.FAKE_MAIL, 'utf8'))
if (op === 'accounts') process.stdout.write(JSON.stringify(box.accounts))
else if (!box.accounts.includes(me)) { process.stderr.write(`execution error: Error: No Mail account for ${me} (-2700)`); process.exit(1) }
else if (op === 'fetch') process.stdout.write(JSON.stringify(box.sent.filter(m => m.to === to)))
else if (op === 'reply') {
  const fail = Number(fs.existsSync(process.env.FAKE_MAIL_FAIL) && fs.readFileSync(process.env.FAKE_MAIL_FAIL, 'utf8'))
  if (fail > 0) { fs.writeFileSync(process.env.FAKE_MAIL_FAIL, String(fail - 1)); process.stderr.write('execution error: Error: offline'); process.exit(1) }
  fs.appendFileSync(process.env.FAKE_MAIL_LOG, JSON.stringify({ me, to, messageId, subject, body }) + '\n')
  process.stdout.write('{"ok":true}')
}
