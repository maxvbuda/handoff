# Handoff

Jot ideas on your Apple Watch; Claude Code works on them while you're away. The watch never shows Claude's response, so there's nothing to get pulled into. Only a one-line suggested next prompt comes back, with an Accept suggestion button.

This plugin is skills only, with no code. It needs the open-source **`handoff` command**, which you install separately:

```sh
npm install -g github:maxvbuda/handoff
```

The skills run that command. `handoff start` opens a Claude Code session with Handoff's server as a channel, and that server receives your watch's end-to-end encrypted notes and hands them to Claude. The watch app, the command's source and full docs live in the [repository](https://github.com/maxvbuda/handoff).

- `/handoff:setup`: check that the `handoff` command is installed
- `/handoff:pair`: pair your watch
- `/handoff:inbox`: work on pending ideas (or `/loop 5m /handoff:inbox` without channels)
- `handoff start`: open a session that receives ideas instantly (channel mode)

## Data and network use

- **External service:** the `handoff` command uses the public [ntfy.sh](https://ntfy.sh) relay. It's the only service it contacts. Its server receives your watch's notes from ntfy.sh and sends back Claude's optional one-line suggestion, and `handoff pair` exchanges pairing messages through it. The plugin itself contacts nothing. Everything sent through ntfy.sh is end-to-end encrypted (AES-256-GCM) with a key only your watch and Mac have; ntfy.sh only sees ciphertext on a random topic.
- **Stored data:** decrypted notes are saved locally in `~/.claude-watch-notes/` on your Mac until you delete them.
- **No developer servers, accounts, or analytics.** Full details are in [PRIVACY.md](https://github.com/maxvbuda/handoff/blob/main/PRIVACY.md).
