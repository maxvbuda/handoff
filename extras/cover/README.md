# Fake lock screen (extra)

A real macOS lock stops screen control: a locked Mac shows only the lock screen, and chats never type
your password. With `cover`, the Mac never really locks. Instead, when the lid closes, or after 5 minutes
with nobody using the Mac and nothing playing (a video keeps it away, like the real lock), a lock screen
of ours covers every display and takes the keyboard and mouse.

    handoff extras install cover
    handoff extras cover test                          # see it now (closes after 60 seconds)
    handoff extras cover wallpaper desktop             # your desktop picture (a moving one shows grey)
    handoff extras cover wallpaper ~/Pictures/me.jpg   # or any picture (a copy is kept)
    handoff extras cover wallpaper none                # plain dark grey
    handoff extras remove cover                        # the real lock comes back

- **It opens with your real Mac password.** macOS checks it (OpenDirectory); it's never stored.
- **Claude lifts it** while it uses the screen: a Claude Code hook runs `cover lift 120` before each
  `computer` or `screen` action, so it stays up for 2 minutes after the last one.
- **With the lid closed** a MacBook has no screen to show, so it makes one in software (as Sidecar does).
  To keep the Mac running with the lid closed, use LidWake too (`handoff extras install lidwake`).

It's weaker than the real lock, on purpose, so you can never get stuck behind it:

- **Ctrl+Option+Cmd+Shift+U** gets past it without the password.
- **Force Quit** (Cmd+Option+Esc) gets past it.
- If it stops responding for 15 seconds, it quits by itself.

It needs **Accessibility** (System Settings > Privacy & Security) to take the keyboard when macOS doesn't
let it in front. Each new build needs a new OK: remove `cover` from the list, add it again, and run
`handoff extras cover restart`. Its log is `~/.claude-watch-notes/cover/cover.log`.
