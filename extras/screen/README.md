# Screen control (extra)

Lets the Claude Code chats that `handoff start` and `handoff host` open see your Mac's screen and use its
mouse and keyboard, so a note from your watch can work in apps that have no command line. Separate from
Handoff itself and off unless you turn it on:

    handoff extras install screen       # builds screenctl, turns it on for new chats
    handoff lab screen-control status   # on or off, and whether macOS allows it
    handoff extras remove screen

Screen control only works while the Mac is unlocked. With the lid closed there is no screen, and closing
the lid locks the Mac; a locked Mac shows only the lock screen, and chats never type the password, so they
say it's locked and stop. Unlock it in person, or from another device with Screen Sharing (System Settings >
General > Sharing), or use the fake lock screen (`handoff extras install cover`, see [../cover](../cover/)).
`handoff lab screen-control awake on` keeps the display from sleeping (and locking)
while Handoff runs, but then anyone at the Mac can use it.

macOS asks first: in System Settings > Privacy & Security, allow the app you run `handoff` in (Terminal,
iTerm...) under Accessibility and Screen & System Audio Recording.

Nobody is at the Mac to stop it, so it can do anything you could do there. Chats are told never to type
passwords, payment details or codes, buy things, delete things or send messages unless the note plainly
asks, and to stop at sign-in prompts, but that's an instruction, not a lock. Turn it off when you don't need it.

- `server.mjs`: the MCP server (tools `mcp__screen__screen_screenshot`, `_click`, `_move`, `_drag`, `_scroll`, `_type`, `_key`).
  Coordinates are in the pixels of the last screenshot (the main display, at most 1440 wide).
- `screenctl.swift`: the mouse and keyboard (CoreGraphics events), compiled on your Mac with `swiftc`.
