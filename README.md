# Handoff for Claude Code

[![Tests](https://github.com/maxvbuda/handoff/actions/workflows/test.yml/badge.svg)](https://github.com/maxvbuda/handoff/actions/workflows/test.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) ![Version](https://img.shields.io/badge/version-2.2.2-informational) ![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen) ![watchOS](https://img.shields.io/badge/watchOS-26-black)

Jot ideas on your Apple Watch. Claude Code works on them while you're away. **The watch never shows Claude's response**, so there's nothing to get pulled into. It's a scratchpad that hands off and goes quiet. The only thing that comes back is Claude's one-line suggestion for what to do next, which you can send with **Accept suggestion**.

```
Watch (dictate/scribble) ──AES-GCM──▶ ntfy topic ──▶ handoff plugin ──channel──▶ Claude Code session
```

- **Watch app**: one SwiftUI file, watch-only (no iPhone app), no assets or dependencies. It builds for watchOS 26 / Apple Watch SE 3 with `-Osize`, whole-module optimization, and dead-code stripping. It works on a watch on its own, with no iPhone nearby, over the watch's Wi-Fi or cellular. Notes queue offline and retry when the app comes back to the foreground, and a note still sending when you lower your wrist gets a little extra time to finish.
- **Plugin** (`plugin/`): a Claude Code plugin around one Node file with zero dependencies, plus the `handoff` terminal command (`plugin/cli/`). It decrypts notes on your Mac and drops anything that doesn't decrypt with your key (prompt-injection gate), then pushes each note into the session as a [channel](https://code.claude.com/docs/en/channels-reference) event.
- **Privacy**: notes are end-to-end encrypted on the watch with a per-device key (stored in the Keychain). The relay only sees ciphertext on a random topic.

## Setup

**1. Install the plugin** (in Claude Code):

```
/plugin marketplace add maxvbuda/handoff
/plugin install handoff@handoff
```

**2. Get the `handoff` command**: it comes with the plugin. In Claude Code, run `/handoff:setup` once. It puts `handoff` in `~/.local/bin` and keeps it pointed at the current version when the plugin updates. (`npm install -g github:maxvbuda/handoff` still works too.)

**3. Install the watch app**: the App Store listing is being prepared ([docs/app-store](docs/app-store/README.md)), which is also the only way onto a watch in Family Setup. Until then, build it yourself: `cd watch && xcodegen generate && open ClaudeNotes.xcodeproj`, pick your team, then Run.

**4. Pair (once):** run `handoff pair`, or `/handoff:pair` inside Claude Code. It shows a code like `K7QX-M2PA`; type it into the app on the watch. The watch generates its own topic and key, sends them sealed with a key derived from the code, and waits for the Mac's acknowledgement. Nothing secret is built into the app, so one build works for anyone. Running Claude Code sessions pick up a new pairing automatically. To pair again, tap **Settings** at the bottom of the list, then **Unpair**.

## Use

Before you leave, start a session in the project you want Claude to work on. There are two ways.

**Instant (channel mode):**

```sh
handoff start             # add --continue to pick up your last conversation
```

Ideas arrive in the session within seconds. Only sessions opened with `handoff start` take notes, so other Claude Code windows you have open won't grab them.

**Several chats:** run `handoff start` in as many projects as you like. Each one shows up on the watch by its folder name, or by a name you choose with `handoff start --name "Website"`. Pick one in the **To** row at the top of the app, and your notes go only to that chat. **Any chat** lets whichever one is open take it. A note for a chat that's closed waits until it opens again.

**New chats from the watch:** run `handoff host ~/GitHub` (or any folder of projects) and leave it running. The watch then shows **New chat**, a browser for the folders inside it. Tap into any folder, then choose **Start chat here**, or type a name under **New folder…** to make a folder there and start in it. Then name the chat (it starts as the folder's name) and tap **Start chat**. The new chat is selected on the watch, so the next note goes straight to it. Only folders inside the one you gave can be opened (no `..` or symlinks out), and `node_modules` and hidden folders aren't listed.

Chats started from the watch run **headless** inside `handoff host`: each note runs `claude -p --permission-mode auto` in that folder, continuing the same Claude Code session, one note at a time. There's no channel, so there's no development-channel warning to click, and nothing runs while the chat is idle. A Terminal window shows each chat's log live. To open the conversation as a normal Claude Code window, choose that chat in **To** and tap **Open on computer** on the watch: a Terminal window opens on the Mac running `claude --resume` for it. Or run the `claude --resume …` command the host prints for that chat. (A chat that hasn't had a note yet opens as a new conversation in its folder.) Keep `handoff host` running while you're away: it is what starts those Claude runs, without anyone at the Mac to approve them.

**Every few minutes (no warning):** in a normal `claude --permission-mode auto` session, run

```
/loop 5m /handoff:inbox
```

`--permission-mode auto` lets Claude work without you there to approve each step: a safety classifier reviews every action instead. If it blocks 3 actions in a row, Claude Code goes back to asking in the terminal, so the server tells Claude to skip blocked steps and list them in its summary instead of retrying.

On the watch, tap **Jot an idea…** and add as many lines as you like. Swipe a line to delete it, then tap the orange send button in the corner. A ✓ means the note was delivered.

When Claude finishes a note it can suggest a next step, like Claude Code's prompt suggestions. The suggestion shows at the top of the watch app. Tap **Accept suggestion** to send it to Claude as a new note, or swipe it away. To turn suggestions off, go to **Settings → Suggestions**.

When you get home, the work is done. Claude calls `watch_note_done` with a summary for each note; the summaries are in `~/.claude-watch-notes/notes/`. Notes that arrive while no session is running are handed to the next session that starts, exactly once even with several sessions open.

## Email (optional)

You can also email Claude, from your phone, a school computer, or anywhere you have Gmail. It uses the Mail app on your Mac, so you don't need a Google Script or any new account permissions. Your email account just has to be set up in Mail.

```sh
handoff mail you@icloud.com   # any account in Mail; remembered, so next time just: handoff mail
```

With no address the first time, it uses your Gmail account if Mail has exactly one. It only listens to that one account. Keep it running next to a `handoff start` session. Then send an email from that account to its +claude address, like **you+claude@icloud.com**. The subject and body are the note, and the session works on it like a note from the watch. When Claude is done, the summary comes back as a reply in the same thread from "Claude (Handoff)". Reply to that to send the next note.

- Only emails you sent count. `handoff mail` reads them from your account's **Sent** mailbox, so nobody else can email Claude instructions, even by faking your address.
- Quoted text from earlier in the thread and your signature are left out of the note.
- The first time, macOS asks whether your terminal can control Mail. Click **OK**, or turn it on later in System Settings → Privacy & Security → Automation.
- It checks Mail once a minute and looks back two days. Your Mac has to be awake, which `handoff start` already takes care of.

## Notes

- ntfy.sh keeps messages for about 12 hours. The server saves them to disk as soon as they arrive, so this only matters if no Claude session is running for that whole time. To self-host ntfy, change `RELAY` in `plugin/server/handoff.mjs` and `Relay.base` in `App.swift`.
- ntfy turns messages of 4 KB or more into file attachments, which ntfy.sh keeps for only about 3 hours. The server handles those, but a very long note (roughly 2,900+ characters) needs a session running within that window.

## Tests

```sh
node --test test/server.test.mjs     # server: 53 tests against a mock relay (protocol, crypto, dedupe,
                                     #   multi-session races, reconnects, stalls, re-pairing, pair command)
node test/watch-e2e.mjs              # watch app in the SE 3 simulator + real pair/MCP server, via mock relay
node test/watch-e2e.mjs --real-relay # same UI flow through the public ntfy.sh
```

The watch end-to-end run unpairs the simulator. Afterwards, run `pair` again.

See [PRIVACY.md](PRIVACY.md) for exactly what data goes where, [SECURITY.md](SECURITY.md) for how notes stay yours and how to report a problem, [CHANGELOG.md](CHANGELOG.md) for what changed, and [docs/official-listing.md](docs/official-listing.md) for the plan to get Handoff on Anthropic's approved channel list.

