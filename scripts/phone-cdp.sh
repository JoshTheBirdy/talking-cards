#!/usr/bin/env bash
# Forwards the phone's Obsidian WebView debug socket to localhost:9333 (re-run after Obsidian restarts).
PID=$(adb shell pidof md.obsidian | tr -d '\r')
SOCK=$(adb shell cat /proc/net/unix | grep -ao "webview_devtools_remote_$PID" | head -1)
[[ -n "$SOCK" ]] || { echo "no debug socket (pid '$PID')" >&2; exit 1; }
adb forward --remove tcp:9333 >/dev/null 2>&1
adb forward tcp:9333 "localabstract:$SOCK" >/dev/null && echo "forwarded $SOCK"
