#!/usr/bin/env bash
# Installs the launchd agent that runs build.sh every minute for the live server
# folder given as the first argument. See "Live server updates" in docs/fork.md.
set -euo pipefail

live="${1:?Usage: install-agent.sh <live server folder>}"
readonly LABEL=com.t3code.fork-live-build
plist="$HOME/Library/LaunchAgents/$LABEL.plist"

cat >"$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$live/current/scripts/fork-live/build.sh</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>T3CODE_DESKTOP_LIVE_SERVER_DIR</key><string>$live</string>
  </dict>
  <key>StartInterval</key><integer>60</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/t3-live-build.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/t3-live-build.log</string>
</dict>
</plist>
PLIST
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$plist"
echo "Installed $plist"
