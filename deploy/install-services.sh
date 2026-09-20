#!/bin/bash
# Installs the watcher, dashboard and daily hunt as macOS login services (launchd).
# Run once:  bash deploy/install-services.sh      Remove:  bash deploy/install-services.sh uninstall
set -e
cd "$(dirname "$0")/.."
mkdir -p ~/Library/LaunchAgents ~/Library/Logs/vinted
pkill -f "bin/vinted.js watch" 2>/dev/null && echo "stopped the watcher running in a terminal" || true
pkill -f "bin/vinted.js serve --db vinted.db --port 3211" 2>/dev/null && echo "stopped the shared dashboard (the service takes over port 3211)" || true
for l in com.arcstore.vinted.watch com.arcstore.vinted.dashboard com.arcstore.vinted.hunt; do
  launchctl bootout "gui/$(id -u)/$l" 2>/dev/null || true
  if [ "$1" != "uninstall" ]; then
    cp "deploy/launchd/$l.plist" ~/Library/LaunchAgents/
    launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/$l.plist && echo "started $l"
  else
    rm -f ~/Library/LaunchAgents/$l.plist; echo "removed $l"
  fi
done
[ "$1" = "uninstall" ] || { sleep 3; launchctl list | grep arcstore; echo; echo "logs: ~/Library/Logs/vinted/   dashboard: http://localhost:3211 (password in .env)"; }
