#!/bin/bash
# Builds AILimits.app from the Swift sources with the command line toolchain.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
APP="$ROOT/AILimits.app"
BUILD="$ROOT/.build"

mkdir -p "$BUILD/mc" "$BUILD/tmp"
export TMPDIR="$BUILD/tmp"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cp "$ROOT/Sources/Info.plist" "$APP/Contents/Info.plist"
cp "$ROOT/fetch.py" "$APP/Contents/Resources/fetch.py"
cp "$ROOT/serve.py" "$APP/Contents/Resources/serve.py"

SRC=("$ROOT/Sources/main.swift" "$ROOT/Sources/Model.swift" "$ROOT/Sources/Views.swift")
COMMON=(-O -swift-version 5 -module-cache-path "$BUILD/mc"
        -framework AppKit -framework SwiftUI -framework Combine)

# Universal binary so it also runs on Intel Macs.
swiftc "${COMMON[@]}" -target arm64-apple-macos14.0  "${SRC[@]}" -o "$BUILD/AILimits-arm64"
swiftc "${COMMON[@]}" -target x86_64-apple-macos14.0 "${SRC[@]}" -o "$BUILD/AILimits-x86_64"
lipo -create "$BUILD/AILimits-arm64" "$BUILD/AILimits-x86_64" \
  -output "$APP/Contents/MacOS/AILimits"

/usr/bin/codesign --force --sign - --timestamp=none "$APP" >/dev/null 2>&1 || true
echo "built $APP"
