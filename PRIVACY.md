# Privacy Policy: Handoff

_Last updated: November 11, 2026_

Handoff has three parts: an Apple Watch app, the `handoff` command that runs on your own Mac, and a Claude Code plugin with skills that run that command. The developer runs no servers and collects no data.

## What the watch app does with your notes

- Notes you write are stored on your watch until they're delivered, and the 12 most recent are kept as a history list.
- Each note is encrypted on the watch with AES-256-GCM, using a key that only your watch and your Mac have. It's then sent to a public relay, [ntfy.sh](https://ntfy.sh), on a random topic.
- The relay only ever sees encrypted data. It can't read your notes. ntfy.sh keeps messages for up to about 12 hours, and see ntfy's own [privacy policy](https://ntfy.sh/docs/privacy/). Like any web service, it can see your IP address.
- The encryption key is stored in the watch's Keychain and never leaves your devices, except once, during pairing, when it's sent to your Mac encrypted with a key derived from the one-time pairing code.

## What the Mac plugin does

- It downloads your encrypted notes from the relay, decrypts them, and saves them in `~/.claude-watch-notes/` on your Mac.
- It passes each note to your Claude Code session. Claude Code then processes it under your Anthropic account, like anything you type into Claude Code. See [Anthropic's privacy policy](https://www.anthropic.com/legal/privacy).
- When Claude finishes a note, it records a short summary with Handoff's `watch_note_done` tool. The summary is saved in the same place, on your Mac only, and is never sent to the relay or anywhere else (except for notes you emailed; see below).
- Claude can also include a one-line suggested next prompt. It's encrypted with the same key and sent through the relay to the watch, which shows it with an **Accept suggestion** button. Claude's response itself is never sent to the watch.
- When Claude changes something you can look at, like a web page, it can also send a screenshot of it (or a short GIF made from a screen recording), which the watch shows above your notes. Claude takes the screenshot on your Mac, and it's encrypted with the same key. The watch keeps the latest 5, plus any you save, until you delete them.
- Each Claude Code session started with `handoff start` sends the watch its chat name (your folder's name, or one you choose) about once a minute, encrypted, so the watch can list open chats. Notes you address to a chat carry that name too.

## What `handoff host` does (optional)

If you run `handoff host` on your Mac, the watch can start new chats:

- It sends the watch the names of the folders inside the folder you gave it, encrypted, so you can browse them. Only folder names are sent, never file names or file contents.
- **Open on computer** opens one of the host's chats in a Terminal window on your Mac (`claude --resume`). The request only carries the chat's name.
- When you pick a folder on the watch, it registers a chat there. If you ask for a new folder, it creates that empty folder first. It can't reach anything outside the folder you gave it.
- Each note you send to that chat is run by Claude Code on your Mac (`claude -p`) in that folder, under your Anthropic account, like the rest of Handoff. A log of what Claude did is saved in `~/.claude-watch-notes/logs/`, and the list of chats in `~/.claude-watch-notes/host-chats.json`. Neither leaves your Mac.

## What `handoff mail` does (optional)

If you run `handoff mail`, you can also email notes to yourself at you+claude@gmail.com:

- It uses the Mail app on your Mac, with the account you already set up there. It reads only messages from the last two days in that account's Sent mailbox that you addressed to the +claude address. It doesn't read your inbox or any other mail.
- It saves those notes in `~/.claude-watch-notes/` like watch notes, and Claude Code processes them the same way.
- When Claude finishes an emailed note, Mail sends the summary (and any suggestion) back to you as a reply, from your own account. **For emailed notes, the summary leaves your Mac** and is stored in your email, like any email you send. Summaries of watch notes never leave your Mac.
- None of this goes through ntfy.sh or any server run by the developer. The emails travel through your email provider, as usual.

## Everything that travels through the relay

All of it is encrypted with your key, so ntfy.sh can't read any of it:

| Topic | From → to | Contents |
| --- | --- | --- |
| `cw-…` | watch → Mac | your notes, and the chat each is for |
| `cw-…-s` | Mac → watch | Claude's suggested next prompt; the evening recap: each chat's name and the first line of each note it finished that day (your words, never Claude's) |
| `cw-…-i` | Mac → watch | a screenshot of what Claude changed, when it sends one |
| `cw-…-c` | Mac → watch | open chat names, the note each is working on, and each chat folder's git branch, number of changed files and unpushed commits (never file names or contents); the host's chat names and top-level folder names |
| `cw-…-p` | Mac → watch | permission prompts from `handoff start` sessions: the tool's name and what it wants to do (for example the command it would run); questions Claude asks you, with their answers to choose from |
| `cw-…-v` | watch → Mac | your answer to a permission prompt (allow or deny) or to a question; Stop for a chat |
| `cw-…-r` | watch → Mac | your recurring tasks: the note, how often, the time and the chat |
| `cw-…-n` | watch → Mac | requests to the host: list a folder, start a chat, make a folder, open a chat on the Mac, stop a chat's note |
| `cw-…-l` | Mac → watch | subfolder names, in reply to a list request |

## How long data is kept

- **On your Mac:** notes, Claude's summaries, and host chat logs stay in `~/.claude-watch-notes/` until you delete them.
- **In your email (`handoff mail` only):** the notes you emailed and Claude's replies stay in your mailbox until you delete them.
- **On the watch:** up to 12 notes of history (until you delete them in Settings), your draft, the last suggestion, the last 5 screenshots and any you saved, the evening recap, your quick buttons, and your chosen chat. The Smart Stack widget keeps a copy of the suggestion and what each chat is working on, on the watch only.
- **On the relay (ntfy.sh):** encrypted messages for up to about 12 hours, and file attachments (notes and screenshots of 4 KB or more) for about 3 hours.
- **By the developer:** nothing, because no data ever reaches the developer.

## What we collect

Nothing. There are no analytics, accounts, advertising, or tracking, and no servers operated by the developer.

## Deleting your data

Unpair in the app, delete the app, and delete `~/.claude-watch-notes/` on your Mac.

## Contact

Questions: open an issue at https://github.com/maxvbuda/handoff/issues.
