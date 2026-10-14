#!/usr/bin/env bash
# One-shot phone test. Plug the phone in (USB debugging on), then:
#   scripts/phone-test.sh [--reader-token TOKEN] [--skip-download] [--install-reader]
# Uses a separate vault "Talking Cards Test" on the phone; never touches a real vault.
set -euo pipefail
cd "$(dirname "$0")/.."
source ~/.nvm/nvm.sh >/dev/null

DEVICE_VAULT="/sdcard/Documents/Talking Cards Test"
READER_APK="$HOME/Projects/reader/app/build/outputs/apk/release/app-release.apk"

echo "== device"
adb get-state >/dev/null 2>&1 || { echo "No phone over adb. Data cable, USB debugging on, accept the prompt."; exit 1; }
adb shell getprop ro.product.model

echo "== build"
npm run -s build
npm test 2>&1 | grep -E "^ℹ (pass|fail)"

echo "== push test vault + plugin to $DEVICE_VAULT"
adb shell mkdir -p "\"$DEVICE_VAULT/.obsidian/plugins/talking-cards\""
for f in test-vault/*; do adb push "$f" "$DEVICE_VAULT/" >/dev/null; done
adb push main.js manifest.json styles.css "$DEVICE_VAULT/.obsidian/plugins/talking-cards/" >/dev/null
adb push test-vault/.obsidian/community-plugins.json "$DEVICE_VAULT/.obsidian/" >/dev/null
echo "pushed"

if [[ " $* " == *" --install-reader "* ]]; then
  echo "== Reader 0.5.0 (adb install -r keeps your library)"
  read -r -p "Update Reader on the phone to the voice-bridge build? [y/N] " ok
  [[ "$ok" == "y" ]] && adb install -r "$READER_APK"
fi

cat <<'MSG'

== on the phone (first time only)
  1. Obsidian → vault switcher → Open folder as vault → Documents/Talking Cards Test
  2. Trust the plugin (turn off Restricted mode) and enable Talking Cards
  3. Leave Obsidian open on that vault, screen on
MSG
read -r -p "Press Enter when Obsidian shows the test vault… "

PID=$(adb shell pidof md.obsidian | tr -d '\r')
SOCK=$(adb shell cat /proc/net/unix | grep -ao "webview_devtools_remote_$PID" | head -1)
[[ -n "$SOCK" ]] || { echo "Obsidian's debug socket not found."; exit 1; }
adb forward tcp:9333 "localabstract:$SOCK" >/dev/null
trap 'adb forward --remove tcp:9333 >/dev/null 2>&1 || true' EXIT

echo "== checks"
node scripts/phone-checks.mjs "$@"
