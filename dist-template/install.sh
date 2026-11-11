#!/bin/bash
# AI Limits - installer for another Mac.
# Run from the unzipped folder:  ./install.sh   (add --tunnel for internet access)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC_APP="$HERE/AI Limits.app"
DEST="$HOME/Applications/AI Limits.app"
DATA="$HOME/.limitswidget"
LABEL="com.sai.ailimits"
WEB_LABEL="com.sai.ailimits.web"
WANT_TUNNEL="no"
[ "${1:-}" = "--tunnel" ] && WANT_TUNNEL="yes"

[ -d "$SRC_APP" ] || { echo "AI Limits.app not found next to this script"; exit 1; }

echo "== checking this Mac"
osver="$(sw_vers -productVersion)"
major="$(echo "$osver" | cut -d. -f1)"
[ "$major" -ge 14 ] || { echo "macOS 14 or newer required (found $osver)"; exit 1; }

if ! /usr/bin/python3 -c "import json,sqlite3" >/dev/null 2>&1; then
  echo "Python 3 is missing. Install the Command Line Tools with:"
  echo "    xcode-select --install"
  echo "then run this installer again."
  exit 1
fi

echo "== installing to ~/Applications"
mkdir -p "$HOME/Applications" "$DATA"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootout "gui/$(id -u)/$WEB_LABEL" 2>/dev/null || true
pkill -f "$DEST/Contents/MacOS/AILimits" 2>/dev/null || true
rm -rf "$DEST"
cp -R "$SRC_APP" "$DEST"
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true
chmod -R a+rX "$DEST"
chmod 755 "$DEST/Contents/MacOS/AILimits"

TOKEN_FILE="$DATA/web_token"
if [ ! -s "$TOKEN_FILE" ]; then
  openssl rand -hex 6 > "$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE"
fi
TOKEN="$(cat "$TOKEN_FILE")"

echo "== starting the desktop widget"
cat > "$HOME/Library/LaunchAgents/$LABEL.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.sai.ailimits</string>
  <key>ProgramArguments</key>
  <array><string>$DEST/Contents/MacOS/AILimits</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>ProcessType</key><string>Interactive</string>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
</dict>
</plist>
EOF
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/$LABEL.plist" 2>/dev/null || true

echo "== starting the phone bridge"
cat > "$HOME/Library/LaunchAgents/$WEB_LABEL.plist" <<EOF
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
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/$WEB_LABEL.plist" 2>/dev/null || true

if [ "$WANT_TUNNEL" = "yes" ]; then
  echo "== installing the public tunnel"
  mkdir -p "$DATA/bin"
  if [ ! -x "$DATA/bin/cloudflared" ]; then
    case "$(uname -m)" in arm64) ARCH=arm64 ;; *) ARCH=amd64 ;; esac
    curl -sL -o "$DATA/bin/cf.tgz" "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-$ARCH.tgz"
    tar xzf "$DATA/bin/cf.tgz" -C "$DATA/bin"
    rm -f "$DATA/bin/cf.tgz"
    chmod +x "$DATA/bin/cloudflared"
  fi
  cat > "$HOME/Library/LaunchAgents/com.sai.ailimits.tunnel.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.sai.ailimits.tunnel</string>
  <key>ProgramArguments</key>
  <array>
    <string>$DATA/bin/cloudflared</string>
    <string>tunnel</string><string>--url</string><string>http://127.0.0.1:8787</string>
    <string>--no-autoupdate</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>$DATA/cloudflared.log</string>
  <key>StandardOutPath</key><string>$DATA/cloudflared.log</string>
</dict>
</plist>
EOF
  launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.sai.ailimits.tunnel.plist" 2>/dev/null || true
fi

HOSTLOCAL="$(scutil --get LocalHostName 2>/dev/null || hostname -s)"

if [ -f "$HERE/ailimits-ios.js" ]; then
  sed -e "s|REPLACE_WITH_TOKEN|$TOKEN|g" -e "s|YOUR-MAC|$HOSTLOCAL|g" \
    "$HERE/ailimits-ios.js" > "$DATA/ailimits-ios.js"
  chmod 600 "$DATA/ailimits-ios.js"
fi
echo
echo "Done."
echo "  Widget:      on the desktop"
echo "  Phone (LAN): http://$HOSTLOCAL.local:8787/t/$TOKEN/"
[ "$WANT_TUNNEL" = "yes" ] && echo "  Public URL:  ~/.limitswidget/cloudflared.log (about 15 seconds)"
echo
echo "First launch asks for Keychain access (Claude Safe Storage, Antigravity)."
echo "Choose Always Allow so the widget can refresh on its own."
