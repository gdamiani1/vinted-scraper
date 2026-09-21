#!/bin/bash
# Permanent public address for the dashboard via a named Cloudflare Tunnel, run as a login service.
# Prerequisite (once, interactive): cloudflared tunnel login   → pick the domain in your Cloudflare account.
# Usage: bash deploy/setup-tunnel.sh vinted.yourdomain.com
set -e
HOST="$1"
[ -n "$HOST" ] || { echo "usage: bash deploy/setup-tunnel.sh <hostname on a domain in your Cloudflare account>"; exit 1; }
[ -f ~/.cloudflared/cert.pem ] || { echo "not logged in yet: run  cloudflared tunnel login  first (opens the browser), then re-run this."; exit 1; }
NAME=vinted
if ! cloudflared tunnel list 2>/dev/null | grep -q " $NAME "; then cloudflared tunnel create "$NAME"; fi
ID=$(cloudflared tunnel list --output json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const t=JSON.parse(s).find(x=>x.name==='$NAME');if(!t){process.exit(1)}console.log(t.id)})")
CRED=$(ls ~/.cloudflared/"$ID".json)
cat > ~/.cloudflared/config.yml <<CFG
tunnel: $ID
credentials-file: $CRED
ingress:
  - hostname: $HOST
    service: http://localhost:3211
  - service: http_status:404
CFG
cloudflared tunnel route dns --overwrite-dns "$NAME" "$HOST"
mkdir -p ~/Library/LaunchAgents ~/Library/Logs/vinted
cat > ~/Library/LaunchAgents/com.arcstore.vinted.tunnel.plist <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.arcstore.vinted.tunnel</string>
  <key>ProgramArguments</key><array><string>$(which cloudflared)</string><string>tunnel</string><string>--no-autoupdate</string><string>run</string><string>$NAME</string></array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>15</integer>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/vinted/tunnel.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/vinted/tunnel.log</string>
</dict></plist>
PL
pkill -f "cloudflared tunnel --url" 2>/dev/null || true
launchctl bootout "gui/$(id -u)/com.arcstore.vinted.tunnel" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.arcstore.vinted.tunnel.plist
sleep 5
echo "tunnel service installed. Dashboard: https://$HOST  (password in .env). Logs: ~/Library/Logs/vinted/tunnel.log"
curl -s -o /dev/null -w "check: HTTP %{http_code} (401 = up and asking for the password)\n" "https://$HOST/api/stats" || true
