---
name: pair
description: Pair an Apple Watch running the Handoff app with this Mac. Use when the user wants to set up, connect, or re-pair their watch.
disable-model-invocation: true
---

Pair the user's Apple Watch with this Mac.

1. Ask the user to open Hand-Off on their watch and tell you the 8-character code it shows (like `K7QX-M2PA`). If the user already gave a code, use it.
2. Run `handoff pair <code>` (it waits up to a minute for the watch).
   If the `handoff` command isn't installed, stop and tell the user to run `/handoff:setup`.
3. If it prints `Paired.`, tell the user they're set, and that ideas will reach any session started with `handoff start`. If no watch answered, ask them to check the code on the watch (it changes after 10 minutes) and try again.

If the watch asks for a code instead of showing one (Hand-Off 1.0), run `handoff pair` with no code in the background. As soon as it prints `Pairing code:  XXXX-XXXX`, show the user that code in large, clear text to type on the watch, and wait for `Paired.` (up to 10 minutes).
