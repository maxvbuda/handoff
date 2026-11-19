# Extras (Mac)

Optional add-ons so the Claude Code chats Handoff opens can use your Mac's screen while you're away, even
with the lid closed. None of them is on unless you install it, and each one comes off again:

    handoff extras                      # what's on
    handoff extras install all          # or: screen, deskhand, cover, lidwake
    handoff extras remove cover         # takes one off again

| Extra | What it does | Made by |
|---|---|---|
| [`screen`](screen/) | Screen tools (`mcp__screen__*`) for the chats Handoff opens: screenshots, mouse, keyboard | Handoff |
| [`deskhand`](deskhand/) | Deskhand as Claude's `computer` tool, in every Claude Code chat | Karam Lamba (MIT) |
| [`cover`](cover/) | A fake lock screen: the Mac never really locks, so Claude can still use the screen | Handoff |
| [`lidwake`](lidwake/) | Keeps the Mac running with the lid closed and no monitor | [aaryanbindage/Lidwake](https://github.com/aaryanbindage/Lidwake) |

Deskhand and LidWake are included with their makers' permission. LidWake here is a copy of
[aaryanbindage/Lidwake](https://github.com/aaryanbindage/Lidwake) at `d32bfbf` (without its relay server,
which you only need to host your own); its own README explains it.

## What the install does

- **screen**: builds `screenctl` with `swiftc` and turns the screen tools on for new chats.
- **deskhand**: uses `/Applications/Deskhand.app`, or unzips the included copy to `~/Applications`; adds it
  to Claude Code as the `computer` MCP server (user scope) and allows `mcp__computer__computer`.
- **cover**: builds `cover` with `clang` into `~/.claude-watch-notes/bin`, starts it at login (LaunchAgent
  `com.handoff.cover`), and adds a Claude Code hook that lifts it while Claude uses the screen.
- **lidwake**: runs LidWake's own installer (it asks for your password once, for a sudoers rule that lets
  it run `pmset -a disablesleep 0|1`), then its Claude Code hook.

Changes to `~/.claude/settings.json` are backed up first, to `settings.json.handoff-backup`.

## What macOS still asks you

These switches can't be flipped for you:

- **Accessibility** and **Screen & System Audio Recording** for the app you run Claude in (Terminal,
  iTerm...), for `screen` and `deskhand`.
- **Accessibility** for `cover`, so it can take the keyboard when it isn't in front. The installer opens
  the right page and shows `cover` in Finder: drag it into the list and switch it on, then run
  `handoff extras cover restart`.

## Be aware

With these on, a chat can do anything you could do at the Mac, while nobody is watching. And with
`cover`, your Mac is only as locked as a program can make it: anyone who knows the shortcut below, or
Force Quit, gets in. It keeps out people who just open the lid, not people who know about it.
