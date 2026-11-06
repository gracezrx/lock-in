#!/bin/bash
# Installs (or updates) Lock In as a normal Mac app: "Lock In" in Applications, so
# Spotlight, Launchpad and the Dock find it, with its icon in the menu bar.
#
# How it is put together:
#   - Lock In.app is a copy of Electron, renamed, with Lock In's icon and a tiny loader.
#   - The code it runs lives in ~/Library/Application Support/Lock In/runtime.
# Updating only replaces that runtime folder; the app itself stays byte-for-byte the same,
# so macOS keeps the permissions you gave it (Accessibility, Microphone, Automation).
set -euo pipefail

PROJ="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="Lock In"
BUNDLE_ID="app.lockin.desktop"
LOADER_VERSION=3
SUPPORT="$HOME/Library/Application Support/Lock In"
RUNTIME="$SUPPORT/runtime"
ELECTRON_APP="$PROJ/node_modules/electron/dist/Electron.app"
DEV_BIN="$ELECTRON_APP/Contents/MacOS/Electron"

say() { printf '%s\n' "$*"; }

[ "$(uname)" = "Darwin" ] || { say "This installer is for macOS."; exit 1; }
[ -f "$PROJ/dist/main/index.js" ] || { say "Lock In isn't built yet. Run: npm run build"; exit 1; }
[ -d "$ELECTRON_APP" ] || { say "Electron is missing. Run: npm install"; exit 1; }

# Where the app goes: where it already is, else /Applications, else ~/Applications.
DEST_DIR=""
for d in "/Applications" "$HOME/Applications"; do
  if [ -d "$d/$APP_NAME.app" ]; then DEST_DIR="$d"; break; fi
done
if [ -z "$DEST_DIR" ]; then
  if [ -w /Applications ]; then DEST_DIR="/Applications"; else DEST_DIR="$HOME/Applications"; mkdir -p "$DEST_DIR"; fi
fi
DEST="$DEST_DIR/$APP_NAME.app"
APP_BIN="$DEST/Contents/MacOS/Electron"

# 1. Close any running Lock In (the Terminal version or the app) so the new one can start.
running() { pgrep -f "^($DEV_BIN|$APP_BIN)( |$)" >/dev/null 2>&1; }
if running; then
  say "Closing the running Lock In..."
  pkill -TERM -f "^($DEV_BIN|$APP_BIN)( |$)" 2>/dev/null || true
  for _ in $(seq 1 40); do running || break; sleep 0.25; done
  running && pkill -KILL -f "^($DEV_BIN|$APP_BIN)( |$)" 2>/dev/null || true
  sleep 0.5
fi

# 2. The code: swap in a fresh runtime folder.
mkdir -p "$SUPPORT"
STAGE="$SUPPORT/runtime.new"
rm -rf "$STAGE"
mkdir -p "$STAGE/node_modules" "$STAGE/native/mac-helper/build"
cp "$PROJ/package.json" "$STAGE/package.json"
ditto "$PROJ/dist" "$STAGE/dist"
ditto "$PROJ/assets" "$STAGE/assets"
ditto "$PROJ/extension" "$STAGE/extension"
ditto "$PROJ/node_modules/ws" "$STAGE/node_modules/ws"
for bin in lockin-helper lockin-calendar lockin-keys; do
  if [ -f "$PROJ/native/mac-helper/build/$bin" ]; then
    cp -p "$PROJ/native/mac-helper/build/$bin" "$STAGE/native/mac-helper/build/$bin"
  fi
done
rm -rf "$RUNTIME.old"
if [ -d "$RUNTIME" ]; then mv "$RUNTIME" "$RUNTIME.old"; fi
mv "$STAGE" "$RUNTIME"
rm -rf "$RUNTIME.old"

# 3. The app itself, only when it is missing or Electron or the loader changed.
ELECTRON_VERSION="$(defaults read "$ELECTRON_APP/Contents/Info" CFBundleShortVersionString 2>/dev/null || echo unknown)"
STAMP="$LOADER_VERSION-$ELECTRON_VERSION"
CURRENT="$(cat "$DEST/Contents/Resources/app/stamp" 2>/dev/null || true)"
if [ "$CURRENT" != "$STAMP" ]; then
  say "Making the Lock In app (only the first time; about a minute)..."
  WORK="$(mktemp -d)"
  APP="$WORK/$APP_NAME.app"
  ditto "$ELECTRON_APP" "$APP"
  PLIST="$APP/Contents/Info.plist"
  plutil -replace CFBundleName -string "$APP_NAME" "$PLIST"
  plutil -replace CFBundleDisplayName -string "$APP_NAME" "$PLIST"
  plutil -replace CFBundleIdentifier -string "$BUNDLE_ID" "$PLIST"
  plutil -replace LSApplicationCategoryType -string "public.app-category.productivity" "$PLIST"
  plutil -replace NSMicrophoneUsageDescription -string "Lock In listens only when you answer your coach." "$PLIST"
  plutil -replace NSCalendarsUsageDescription -string "Lock In reads your calendar to stay quiet in meetings and plan around them. It never changes it." "$PLIST"
  plutil -replace NSCalendarsFullAccessUsageDescription -string "Lock In reads your calendar to stay quiet in meetings and plan around them. It never changes it." "$PLIST"
  plutil -replace NSAppleEventsUsageDescription -string "Lock In reads the open browser tab and your to-do list, and can hide a distracting app when you ask." "$PLIST"
  plutil -remove ElectronAsarIntegrity "$PLIST" 2>/dev/null || true
  cp "$PROJ/assets/icon.icns" "$APP/Contents/Resources/electron.icns"
  rm -f "$APP/Contents/Resources/default_app.asar"
  mkdir -p "$APP/Contents/Resources/app"
  cp "$PROJ/scripts/loader/package.json" "$PROJ/scripts/loader/main.mjs" "$APP/Contents/Resources/app/"
  printf '%s' "$STAMP" > "$APP/Contents/Resources/app/stamp"
  xattr -cr "$APP"
  # Sign it for this Mac only (ad hoc), which Apple silicon requires to run it. The app itself is
  # then identified by its bundle id, so permissions can carry over when the app is rebuilt.
  codesign --force --deep --sign - "$APP" 2>&1 | grep -v "replacing existing signature" || true
  codesign --force --sign - -r="designated => identifier \"$BUNDLE_ID\"" "$APP" 2>/dev/null || true
  codesign --verify "$APP"
  rm -rf "$DEST"
  ditto "$APP" "$DEST"
  rm -rf "$WORK"
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$DEST" >/dev/null 2>&1 || true
  touch "$DEST"
fi

# 4. Open it.
open "$DEST"
say ""
say "Lock In is installed in $DEST_DIR."
say "Find it in your menu bar (the padlock at the top right), or search \"Lock In\" with Spotlight."
