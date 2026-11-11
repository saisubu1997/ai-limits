#!/bin/bash
# Prints the current LAN and public URLs for the phone view.
TOKEN="$(cat "$HOME/.limitswidget/web_token" 2>/dev/null)"
HOST="$(scutil --get LocalHostName 2>/dev/null || hostname -s)"
PUBLIC="$(grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" "$HOME/.limitswidget/cloudflared.log" 2>/dev/null | tail -1)"

[ -z "$TOKEN" ] && { echo "no token - run ./install.sh first"; exit 1; }
echo "LAN     http://$HOST.local:8787/t/$TOKEN/"
if [ -n "$PUBLIC" ]; then
  echo "Public  $PUBLIC/t/$TOKEN/"
else
  echo "Public  (tunnel not running)"
fi
