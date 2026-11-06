---
name: setup
description: Install the `handoff` terminal command (handoff start, pair, host, mail) with npm if it's missing. Use when the user wants to set up Handoff or says the handoff command is missing.
disable-model-invocation: true
---

Help the user set up Handoff. This plugin is instructions only; the work is done by the open-source `handoff` command, which is installed separately with npm.

1. Run `command -v handoff`.
2. If it prints nothing, the command isn't installed. Tell the user in one line what you're about to install (the open-source `handoff` command from https://github.com/maxvbuda/handoff, with npm), then run it:
   `npm install -g github:maxvbuda/handoff`
   It needs Node.js 20 or newer. If `npm` isn't found, tell them to install Node.js from https://nodejs.org first. If the install is blocked or denied, don't retry or work around it: show them the command so they can run it themselves.
   If `~/.local/bin/handoff` exists and contains "Installed by the Handoff plugin", it's left over from an older version and will run instead of the new one: tell them, and delete it if they say so.
   After installing, run `command -v handoff` again to check. If it's still not found, tell them to open a new Terminal window.
3. Once it's installed, tell them what to do next:
   - Not paired yet (`~/.claude-watch-notes/config.json` doesn't exist): run `/handoff:pair`, or `handoff pair` in Terminal.
   - Then, in Terminal, `handoff start` in the project they want Claude to work on.
   - Optional: `handoff mail` to email Claude too (it uses the Mail app), and `handoff host ~/folder` to start chats from the watch.
