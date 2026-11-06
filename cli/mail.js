// The Mail app side of `handoff mail`, run with `osascript -l JavaScript mail.js <op> ...`. Prints JSON.
//
//   accounts                                   every Mail account's email addresses
//   fetch <me> <to> <days>                     messages you sent to <to> (the +claude address) lately
//   reply <me> <to> <messageId> <subject> <body>   reply in that thread, to <to>, from "Claude (Handoff)"
//
// Notes only come from your account's Sent mailbox, so mail from anyone else can never be one.

const NAME = 'Claude (Handoff)'

function run([op, ...a]) {
  const Mail = Application('Mail')
  if (op === 'accounts') return JSON.stringify([].concat(...Mail.accounts().map(x => x.emailAddresses())))
  const [me, to] = a
  const account = Mail.accounts().find(x => x.emailAddresses().map(e => e.toLowerCase()).includes(me))
  if (!account) throw new Error(`No Mail account for ${me}`)
  const sent = account.mailboxes().find(m => /^sent( mail| messages| items)?$/i.test(m.name()))
  if (!sent) throw new Error(`No Sent mailbox in the Mail account for ${me}`)

  if (op === 'fetch') {
    const since = new Date(Date.now() - Number(a[2]) * 86400000)
    const notes = []
    for (const m of sent.messages.whose({ dateSent: { _greaterThan: since } })()) {
      const sender = m.sender()
      if (sender.startsWith(NAME) || Mail.extractAddressFrom(sender).toLowerCase() !== me) continue
      const rcpts = m.toRecipients().concat(m.ccRecipients()).map(r => r.address().toLowerCase())
      if (!rcpts.includes(to)) continue
      notes.push({ messageId: m.messageId(), subject: m.subject(), at: m.dateSent().toISOString(), content: m.content() })
    }
    return JSON.stringify(notes)
  }

  if (op === 'reply') {
    const [, , id, subject, body] = a
    const orig = sent.messages.whose({ messageId: id })()[0]
    let r
    if (orig) {
      r = Mail.reply(orig, { openingWindow: false })
      for (let i = r.toRecipients.length - 1; i >= 0; i--) r.toRecipients[i].delete()
    } else { // gone from Sent: start a new message with the same subject
      r = Mail.OutgoingMessage({ subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`, visible: false })
      Mail.outgoingMessages.push(r)
    }
    r.toRecipients.push(Mail.ToRecipient({ address: to }))
    r.sender = `${NAME} <${me}>`
    r.content = body
    r.send()
    return JSON.stringify({ ok: true, threaded: !!orig })
  }
  throw new Error(`unknown op ${op}`)
}
