# Deskhand (extra)

[Deskhand](Deskhand.zip) by Karam Lamba (MIT licence; included with permission) is a small menu-bar
app whose `--mcp` mode is an MCP server with one tool, `computer`: screenshots, clicks, typing, keys,
scrolling and dragging. `handoff extras install deskhand` adds it to Claude Code as the `computer`
server for all your projects and allows `mcp__computer__computer`, so chats can use any app.

It uses `/Applications/Deskhand.app` if you have it; otherwise it unzips this copy (1.0.0) to
`~/Applications`. `handoff extras remove deskhand` takes it out of Claude Code again (and deletes the
copy it unzipped).

macOS asks first: allow the app you run Claude in (Terminal, iTerm...) under Accessibility and Screen &
System Audio Recording. Screen control needs the Mac unlocked; see [`cover`](../cover/).
