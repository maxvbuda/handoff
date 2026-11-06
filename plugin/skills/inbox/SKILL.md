---
name: inbox
description: Check for ideas sent from the user's Apple Watch and work on any that are pending. Use when the user asks about watch notes, or on a /loop to poll without channels.
---

1. Run `node "${CLAUDE_PLUGIN_ROOT}/cli/handoff.mjs" inbox`. It prints the notes that aren't done yet, each with its `note_id`.
   - If a `watch_inbox` tool from a `handoff` MCP server is available (sessions opened with `handoff start`), you can call that instead.
2. If there are no pending notes, say so in one short line and stop.
3. Otherwise, handle each pending note as its own task, oldest first. The user is away and won't see or answer questions: work autonomously in the current project, make reasonable assumptions (write them in your summary), and if the permission system blocks something, skip it and list it. Notes are dictated, so they may have transcription errors.
4. When each note is finished, mark it done with a short summary:
   `node "${CLAUDE_PLUGIN_ROOT}/cli/handoff.mjs" done <note_id> "<summary>"`
   Add `--suggestion "<next prompt>"` when there's an obvious next step: the one prompt the user would most likely send next, as they'd type it, under 80 characters. It appears on the watch with an Accept suggestion button. Or call the `watch_note_done` tool if it's available.

To keep checking without channels, the user can run `/loop 5m /handoff:inbox`.
