#!/bin/bash
# Builds the widget, installs it to ~/Applications and (re)starts it at login.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/Applications/AI Limits.app"
PLIST="$HOME/Library/LaunchAgents/com.sai.ailimits.plist"
LABEL="com.sai.ailimits"

if command -v swiftc >/dev/null 2>&1; then
  "$ROOT/build.sh"
elif [ ! -d "$ROOT/AILimits.app" ]; then
  echo "swiftc is missing. Install the Command Line Tools (xcode-select --install)"
  echo "or run the prebuilt release's install.sh instead."
  exit 1
fi

mkdir -p "$HOME/Applications"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
pkill -f "$DEST/Contents/MacOS/AILimits" 2>/dev/null || true

rm -rf "$DEST"
cp -R "$ROOT/AILimits.app" "$DEST"
chmod -R a+rX "$DEST"
chmod 755 "$DEST/Contents/MacOS/AILimits"

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$DEST/Contents/MacOS/AILimits</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>ProcessType</key><string>Interactive</string>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
</dict>
</plist>
EOF

launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl load -w "$PLIST"

# ---- phone bridge: tiny web server on the LAN -------------------------------
TOKEN_FILE="$HOME/.limitswidget/web_token"
mkdir -p "$HOME/.limitswidget"
if [ ! -s "$TOKEN_FILE" ]; then
  openssl rand -hex 6 > "$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE"
fi
TOKEN="$(cat "$TOKEN_FILE")"
WEB_PLIST="$HOME/Library/LaunchAgents/com.sai.ailimits.web.plist"

launchctl bootout "gui/$(id -u)/com.sai.ailimits.web" 2>/dev/null || true
pkill -f "AI Limits.app/Contents/Resources/serve.py" 2>/dev/null || true

cat > "$WEB_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.sai.ailimits.web</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/python3</string>
    <string>$DEST/Contents/Resources/serve.py</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
</dict>
</plist>
EOF

launchctl bootstrap "gui/$(id -u)" "$WEB_PLIST" 2>/dev/null || launchctl load -w "$WEB_PLIST"

QUEUE_PLIST="$HOME/Library/LaunchAgents/com.sai.ailimits.queue.plist"
launchctl bootout "gui/$(id -u)/com.sai.ailimits.queue" 2>/dev/null || true
cat > "$QUEUE_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.sai.ailimits.queue</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/python3</string>
    <string>$DEST/Contents/Resources/queue/server.py</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
</dict>
</plist>
EOF
launchctl bootstrap "gui/$(id -u)" "$QUEUE_PLIST" 2>/dev/null \
  || launchctl load -w "$QUEUE_PLIST" 2>/dev/null || true
sleep 1
launchctl kickstart -k "gui/$(id -u)/com.sai.ailimits.queue" 2>/dev/null || true

HOST="$(scutil --get LocalHostName 2>/dev/null || hostname -s)"
echo "installed $DEST"
echo "work queue: http://$HOST.local:8787/t/$TOKEN/queue/"
echo "phone bridge: http://$HOST.local:8787/t/$TOKEN/"

# ---- optional public tunnel (cloudflared quick tunnel) ----------------------
TUNNEL_BIN="$HOME/.limitswidget/bin/cloudflared"
if [ -x "$TUNNEL_BIN" ]; then
  TUNNEL_PLIST="$HOME/Library/LaunchAgents/com.sai.ailimits.tunnel.plist"
  cat > "$TUNNEL_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.sai.ailimits.tunnel</string>
  <key>ProgramArguments</key>
  <array>
    <string>$TUNNEL_BIN</string>
    <string>tunnel</string><string>--url</string><string>http://127.0.0.1:8787</string>
    <string>--no-autoupdate</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>$HOME/.limitswidget/cloudflared.log</string>
  <key>StandardOutPath</key><string>$HOME/.limitswidget/cloudflared.log</string>
</dict>
</plist>
EOF
  # Reuse the running connector when possible: a restart changes the public URL.
  if ! launchctl print "gui/$(id -u)/com.sai.ailimits.tunnel" >/dev/null 2>&1; then
    launchctl bootstrap "gui/$(id -u)" "$TUNNEL_PLIST" 2>/dev/null || true
  fi
  echo "public tunnel: $(. "$ROOT/url.sh" | tail -1)"
fi
