#!/bin/bash
# Links this Mac's runner to Supabase and verifies it end to end.
#
#   ./connect-supabase.sh https://PROJECT.supabase.co ANON_KEY SERVICE_ROLE_KEY [you@email]
#
# Optional: SUPABASE_ACCESS_TOKEN=sbp_... applies ../supabase.sql for you
# (otherwise paste that file into the SQL editor first).
#
# The service_role key is saved only in ~/.limitswidget/queue.db on this Mac.
set -euo pipefail
cd "$(dirname "$0")"

URL=${1:?usage: connect-supabase.sh https://project.supabase.co ANON_KEY SERVICE_ROLE_KEY [email]}
URL=${URL%/}
ANON=${2:?missing anon key}
SERVICE=${3:?missing service_role key (Project Settings -> API)}
EMAIL=${4:-}
REF=$(echo "$URL" | sed -E 's#https://([^.]+)\..*#\1#')

TOKEN=$(cat "$HOME/.limitswidget/web_token" 2>/dev/null || true)
[ -n "$TOKEN" ] || { echo "install AI Limits first (no web token found)"; exit 1; }
API="http://127.0.0.1:8787/t/$TOKEN/queue/api"

sb() { curl -s "$@" -H "apikey: $SERVICE" -H "Authorization: Bearer $SERVICE"; }

if [ -n "${SUPABASE_ACCESS_TOKEN:-}" ]; then
  echo "== applying supabase.sql"
  python3 -c 'import json,sys;print(json.dumps({"query":open(sys.argv[1]).read()}))' ../supabase.sql |
    curl -sf -X POST "https://api.supabase.com/v1/projects/$REF/database/query" \
      -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "Content-Type: application/json" \
      --data-binary @- >/dev/null
  echo "   done"
fi

echo "== checking schema"
for t in tasks sessions runners; do
  CODE=$(sb -o /dev/null -w "%{http_code}" "$URL/rest/v1/$t?select=id&limit=1")
  [ "$CODE" = "200" ] || { echo "   table $t: HTTP $CODE - run ../supabase.sql in the SQL editor first"; exit 1; }
done
echo "   tasks, sessions, runners ok"

echo "== finding your account"
OWNER=$(sb "$URL/auth/v1/admin/users?per_page=200" | python3 -c '
import json, sys
users = json.load(sys.stdin).get("users", [])
want = sys.argv[1].lower()
hits = [u for u in users if u.get("email", "").lower() == want] if want else users
print(hits[0]["id"] if len(hits) == 1 else "")
' "$EMAIL")
if [ -z "$OWNER" ]; then
  echo "   could not pick one account - sign up in the app first, then pass your email as the 4th argument"
  exit 1
fi
echo "   owner $OWNER"

echo "== saving settings on this Mac"
python3 - "$URL" "$ANON" "$SERVICE" "$OWNER" <<'PY' | curl -sf -X POST "$API/settings" -H 'Content-Type: application/json' --data-binary @- >/dev/null
import json, sys
url, anon, service, owner = sys.argv[1:5]
print(json.dumps({"supabase_url": url, "supabase_key": anon,
                  "supabase_service_key": service, "supabase_owner": owner}))
PY

echo "== waiting for the Mac heartbeat"
for i in $(seq 1 10); do
  sleep 3
  SEEN=$(sb "$URL/rest/v1/runners?select=name,seen_at&order=seen_at.desc&limit=1" |
    python3 -c 'import json,sys,time;d=json.load(sys.stdin);print(d[0]["name"] if d and time.time()-d[0]["seen_at"]<60 else "")' 2>/dev/null || true)
  if [ -n "$SEEN" ]; then echo "   $SEEN is online"; break; fi
done
[ -n "${SEEN:-}" ] || { echo "   no heartbeat yet - restart the runner: launchctl kickstart -k gui/$(id -u)/com.sai.ailimits.queue"; exit 1; }

echo
echo "Connected. Your phone app now shows this Mac as online, its sessions, and runs."
