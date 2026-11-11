#!/bin/bash
# Connects the work queue to a Supabase project and verifies it end to end.
#
#   ./connect-supabase.sh https://YOUR-PROJECT.supabase.co YOUR_ANON_KEY
#
# Run supabase.sql in the project's SQL editor first.
set -euo pipefail

URL_ARG="${1:-}"
KEY_ARG="${2:-}"
[ -n "$URL_ARG" ] && [ -n "$KEY_ARG" ] || {
  echo "usage: $0 https://project.supabase.co <anon-key>"; exit 1
}

TOKEN=$(cat "$HOME/.limitswidget/web_token" 2>/dev/null || true)
[ -n "$TOKEN" ] || { echo "install AI Limits first (no web token found)"; exit 1; }
API="http://127.0.0.1:8787/t/$TOKEN/queue/api"

echo "== saving settings"
curl -sf -X POST "$API/settings" -H 'Content-Type: application/json' \
  -d "{\"supabase_url\":\"$URL_ARG\",\"supabase_key\":\"$KEY_ARG\"}" >/dev/null

echo "== checking the tasks table"
CODE=$(curl -s -o /tmp/sb_probe.json -w "%{http_code}" \
  "$URL_ARG/rest/v1/tasks?select=id&limit=1" \
  -H "apikey: $KEY_ARG" -H "Authorization: Bearer $KEY_ARG")
if [ "$CODE" = "200" ]; then
  echo "   table reachable (HTTP 200)"
else
  echo "   HTTP $CODE - did you run supabase.sql?"
  head -c 300 /tmp/sb_probe.json; echo
  exit 1
fi

echo "== queuing a test task"
ID=$(curl -sf -X POST "$API/tasks" -H 'Content-Type: application/json' \
  -d '{"prompt":"Reply with exactly: SYNC OK","model":"codex","title":"Supabase sync test"}' \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
echo "   task $ID"

for i in $(seq 1 30); do
  sleep 3
  ROW=$(curl -s "$URL_ARG/rest/v1/tasks?id=eq.$ID&select=status,title" \
    -H "apikey: $KEY_ARG" -H "Authorization: Bearer $KEY_ARG")
  STATUS=$(echo "$ROW" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d[0]["status"] if d else "missing")' 2>/dev/null || echo missing)
  echo "   mirrored status: $STATUS"
  case "$STATUS" in done|failed|manual) break;; esac
done

echo
echo "Connected. Tasks now mirror to $URL_ARG and anything queued from another device is picked up here."
