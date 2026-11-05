---
name: setup
description: Install the `handoff` terminal command (handoff start, pair, host, mail) from this plugin. Use when the user wants to set up Handoff or says the handoff command is missing.
disable-model-invocation: true
---

Install the `handoff` command for the user's terminal.

1. Run: `node "${CLAUDE_PLUGIN_ROOT}/cli/handoff.mjs" install`
2. Tell the user what it printed: where the command was installed, and whether they need to open a new Terminal window first. If it says another `handoff` comes first in their PATH, explain that one will run instead and show where it is. If it says a file was left alone, don't overwrite or delete it; tell them which file it is.
3. Then tell them what to do next:
   - Not paired yet (`~/.claude-watch-notes/config.json` doesn't exist): run `/handoff:pair`, or `handoff pair` in Terminal.
   - Then, in Terminal, `handoff start` in the project they want Claude to work on.
   - Optional: `handoff mail` to email Claude too (it uses the Mail app), and `handoff host ~/folder` to start chats from the watch.
