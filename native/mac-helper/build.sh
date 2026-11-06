#!/usr/bin/env bash
# Builds Lock In's two small Swift helpers. Safe to run anywhere: it skips on non-macOS
# machines and when Swift is missing, and the app falls back without them.
#   lockin-helper    the window sensor (which app and window is in front)
#   lockin-calendar  reads the Calendar app on this Mac (EventKit), read-only
#   lockin-keys      hold the space bar to talk to Lock In
set -uo pipefail
cd "$(dirname "$0")"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "[helper] Skipping: the Swift helpers only build on macOS."
  exit 0
fi

if ! command -v swiftc >/dev/null 2>&1; then
  echo "[helper] swiftc not found. Install the Xcode Command Line Tools with: xcode-select --install"
  echo "[helper] Lock In will still run, but without window titles, file paths, call detection or the Mac Calendar."
  exit 0
fi

mkdir -p build

if [[ -f build/lockin-helper && build/lockin-helper -nt main.swift ]]; then
  echo "[helper] Window sensor up to date."
elif swiftc -O -swift-version 5 main.swift -o build/lockin-helper \
  -framework Cocoa -framework ApplicationServices -framework CoreAudio; then
  echo "[helper] Built native/mac-helper/build/lockin-helper"
else
  echo "[helper] Couldn't build the window sensor; Lock In falls back to basic sensing."
fi

if [[ -f build/lockin-calendar && build/lockin-calendar -nt calendar.swift ]]; then
  echo "[helper] Calendar reader up to date."
elif swiftc -O -swift-version 5 calendar.swift -o build/lockin-calendar -framework EventKit; then
  echo "[helper] Built native/mac-helper/build/lockin-calendar"
else
  echo "[helper] Couldn't build the calendar reader; calendar links still work."
fi
if [[ -f build/lockin-keys && build/lockin-keys -nt keys.swift ]]; then
  echo "[helper] Space-bar watcher up to date."
elif swiftc -O -swift-version 5 keys.swift -o build/lockin-keys -framework Cocoa -framework ApplicationServices; then
  echo "[helper] Built native/mac-helper/build/lockin-keys"
else
  echo "[helper] Couldn't build the space-bar watcher; Command-Shift-Space still opens a conversation."
fi
exit 0
