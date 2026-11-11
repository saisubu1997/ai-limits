#!/bin/bash
# Builds Sai Agents.app - a tiny WKWebView shell around the queue PWA.
set -euo pipefail
cd "$(dirname "$0")"
APP="build/Sai Agents.app"
rm -rf build
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" build/AppIcon.iconset

# The toolchain defaults to a macOS 28 minimum, which LaunchServices refuses on 27.
swiftc -O -target "$(uname -m)-apple-macos14.0" -o "$APP/Contents/MacOS/SaiAgents" main.swift \
  -framework Cocoa -framework WebKit 2>&1 | grep -v "warning:" || true

SRC=web/icon-512.png
[ -f "$SRC" ] || SRC=../queue/web/icon-512.png
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$SRC" --out "build/AppIcon.iconset/icon_${size}x${size}.png" >/dev/null
  sips -z "$((size*2))" "$((size*2))" "$SRC" --out "build/AppIcon.iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns build/AppIcon.iconset -o "$APP/Contents/Resources/AppIcon.icns"

cp Info.plist "$APP/Contents/Info.plist"
codesign --force --deep --sign - "$APP" 2>/dev/null || true
echo "built: $APP"