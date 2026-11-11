#!/bin/bash
# Builds dist/AI-Limits.zip for another Mac.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
OUT="$ROOT/dist"
STAGE="$OUT/AI-Limits"

"$ROOT/build.sh"

rm -rf "$STAGE" "$OUT/AI-Limits.zip"
mkdir -p "$STAGE"
cp -R "$ROOT/AILimits.app" "$STAGE/AI Limits.app"
cp "$ROOT/dist-template/install.sh" "$STAGE/install.sh"
cp "$ROOT/dist-template/README.txt" "$STAGE/README.txt"

# Ship the Scriptable script with a placeholder, never the local token.
sed 's|/t/[a-f0-9]\{6,\}/|/t/REPLACE_WITH_TOKEN/|g' "$ROOT/ios/ailimits.js" > "$STAGE/ailimits-ios.js"

chmod +x "$STAGE/install.sh"
chmod -R a+rX "$STAGE"

rm -rf "$STAGE/AI Limits.app/Contents/_CodeSignature"
codesign --force --deep --sign - "$STAGE/AI Limits.app" >/dev/null 2>&1

cd "$OUT"
zip -qry "AI-Limits.zip" "AI-Limits"
echo "built $OUT/AI-Limits.zip ($(du -h "$OUT/AI-Limits.zip" | cut -f1))"
