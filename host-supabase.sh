#!/bin/bash
# Publish the queue to Supabase Storage and print its URL.
#   ./host-supabase.sh https://PROJECT.supabase.co ANON_KEY [SERVICE_ROLE_KEY]
set -euo pipefail
cd "$(dirname "$0")"

URL=${1:?usage: host-supabase.sh https://project.supabase.co anon_key [service_role_key]}
ANON=${2:?missing anon key}
SERVICE=${3:-}
BUCKET=${BUCKET:-app}
KEY=$ANON
[ -n "$SERVICE" ] && KEY=$SERVICE

node hosted/build.mjs >/dev/null
SRC=hosted/dist/sai-agents.html
TMP=$(mktemp)
sed -e "s|__SUPABASE_URL__|$URL|g" -e "s|__SUPABASE_ANON_KEY__|$ANON|g" "$SRC" > "$TMP"

echo "uploading to bucket '$BUCKET'…"
curl -sS -X POST "$URL/storage/v1/object/$BUCKET/sai-agents.html" \
  -H "Authorization: Bearer $KEY" \
  -H "apikey: $ANON" \
  -H "Content-Type: text/html; charset=utf-8" \
  -H "x-upsert: true" \
  --data-binary @"$TMP" | head -c 400
echo
rm -f "$TMP"

APP="$URL/storage/v1/object/public/$BUCKET/sai-agents.html"
CODE=$(curl -s -o /dev/null -w "%{http_code}" "$APP")
echo "app url: $APP  (http $CODE)"
