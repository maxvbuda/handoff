# Changelog

## 2.2.2 (2026-11-05)

- **Open on computer:** a button on the watch opens a host chat in a Terminal window on your Mac.
- The watch app is faster: it checks chats and suggestions at the same time and gives up on slow requests sooner.
- The watch app works on a watch without its iPhone, over Wi-Fi or cellular, and finishes sending a note after you lower your wrist.
- The New chat button sits below the note, so you can start writing on a small screen (SE 3, 40 mm) without scrolling.
- Privacy manifest and App Store listing prepared ([docs/app-store](docs/app-store/README.md)).
- The repo is now `maxvbuda/handoff`. Old links redirect.

## 2.2.1 (2026-11-05)

- `handoff mail` remembers which Mail account to listen to, and only listens to that one.

## 2.2.0 (2026-11-05)

- **Email Claude** through the Mac Mail app with `handoff mail`. The summary comes back as a reply in the same thread.
- The `handoff` command ships inside the plugin. Run `/handoff:setup` once to install it.

## 2.0.0 (2026-10-08)

- Renamed to **Handoff** (plugin, command and listing).
- Chats started from the watch run headless, so they don't stop at the channel warning.
- Name chats on the watch, and start new chats in any folder with `handoff host`.

## 1.1.0 (2026-10-07)

- **Suggestions:** Claude's next step shows on the watch with an Accept suggestion button.
- Settings on the watch, with a Suggestions switch and Delete All History.
- Only sessions started with `handoff start` take notes.

## 1.0.0 (2026-10-07)

- First release: the Apple Watch app and the Claude Code channel plugin, with end-to-end encrypted notes over ntfy.sh.
