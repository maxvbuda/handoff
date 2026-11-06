---
name: setup
description: Check that the `handoff` terminal command (handoff start, pair, host, mail) is installed, and explain how to install it if not. Use when the user wants to set up Handoff or says the handoff command is missing.
disable-model-invocation: true
---

Help the user set up Handoff. This plugin is instructions only; the work is done by the open-source `handoff` command, which is installed separately with npm.

1. Run `command -v handoff`.
2. If it prints nothing, the command isn't installed. Tell the user to run this in Terminal themselves (don't run it for them), then open a new Terminal window:
   `npm install -g github:maxvbuda/handoff`
   It needs Node.js 20 or newer. The source is at https://github.com/maxvbuda/handoff.
   If `~/.local/bin/handoff` exists and contains "Installed by the Handoff plugin", it's left over from an older version: tell them they can delete it.
3. If it's installed, tell them what to do next:
   - Not paired yet (`~/.claude-watch-notes/config.json` doesn't exist): run `/handoff:pair`, or `handoff pair` in Terminal.
   - Then, in Terminal, `handoff start` in the project they want Claude to work on.
   - Optional: `handoff mail` to email Claude too (it uses the Mail app), and `handoff host ~/folder` to start chats from the watch.
