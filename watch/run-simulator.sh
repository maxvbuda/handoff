#!/bin/sh
# Builds Hand-Off, runs it in a watch simulator and pairs it with this Mac: it uses the Mac's own
# pairing (~/.claude-watch-notes/config.json), so your real watch stays paired too.
#   watch/run-simulator.sh [simulator name or UDID]   (default: the newest Apple Watch simulator)
set -e
cd "$(dirname "$0")"
CONFIG="${CLAUDE_WATCH_NOTES_DIR:-$HOME/.claude-watch-notes}/config.json"
[ -f "$CONFIG" ] || { echo "This Mac isn't paired yet: run handoff pair first."; exit 1; }

DEVICE="${1:-$(xcrun simctl list devices available | grep 'Apple Watch' | tail -1 | sed -E 's/.*\(([0-9A-F-]{36})\).*/\1/')}"
DD="${TMPDIR:-/tmp}/handoff-sim-build"

xcodegen -q
xcodebuild -project ClaudeNotes.xcodeproj -scheme ClaudeNotes -destination "id=$DEVICE" -derivedDataPath "$DD" \
  CODE_SIGNING_ALLOWED=NO build -quiet
xcrun simctl boot "$DEVICE" 2>/dev/null || true
xcrun simctl bootstatus "$DEVICE" -b >/dev/null
xcrun simctl install "$DEVICE" "$DD/Build/Products/Debug-watchsimulator/ClaudeNotes.app"
PAIRING=$(base64 < "$CONFIG" | tr -d '\n')
xcrun simctl terminate "$DEVICE" dev.maxbuda.ClaudeNotes.watchkitapp 2>/dev/null || true
xcrun simctl launch "$DEVICE" dev.maxbuda.ClaudeNotes.watchkitapp -pairWith "$PAIRING"
open /Applications/Xcode.app/Contents/Applications/DeviceHub.app 2>/dev/null || open -a Simulator 2>/dev/null || true
echo "Hand-Off is running on $DEVICE, paired with this Mac."
