#!/bin/bash
# Links this Mac's runner to Supabase and verifies it end to end.
#
#   ./connect-supabase.sh https://PROJECT.supabase.co ANON_KEY SERVICE_ROLE_KEY [you@email]
#   ./connect-supabase.sh https://PROJECT.supabase.co - - you@email   # keys from the clipboard
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

# "-" means: take the key from the clipboard (Copy button in the dashboard),
# so it never has to be pasted into a command line.
from_clipboard() {
  local name=$1 key
  while true; do
    printf '\nIn Supabase (Project Settings -> API keys), click Copy next to the %s key,\nthen press Enter here... ' "$name" >&2
    read -r _
    key=$(pbpaste | tr -d '[:space:]')
    case "$key" in
      eyJ*|sb_publishable_*|sb_secret_*) printf '   got the %s key (%s…)\n' "$name" "${key:0:6}" >&2; echo "$key"; return;;
      *) printf '   the clipboard does not hold a Supabase key yet - try again\n' >&2;;
    esac
  done
}
[ "$ANON" = "-" ] && ANON=$(from_clipboard "anon (public)")
[ "$SERVICE" = "-" ] && SERVICE=$(from_clipboard "service_role (secret)")
[ "$ANON" = "$SERVICE" ] && { echo "Both keys are the same - copy the service_role key for the second one."; exit 1; }
printf '' | pbcopy 2>/dev/null || true   # don't leave the secret on the clipboard

for v in "$ANON" "$SERVICE"; do
  case "$v" in
    eyJ*|sb_publishable_*|sb_secret_*) ;;
    *) echo "'$v' is not a Supabase key. Copy the real anon and service_role keys from"
       echo "Project Settings -> API (they start with eyJ, sb_publishable_ or sb_secret_)."; exit 1;;
  esac
done
case "$EMAIL" in your@email|you@email*) echo "Replace your@email with the email you signed up with in the app."; exit 1;; esac
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
  case "$CODE" in
    200) ;;
    401|403) echo "   Supabase rejected the service_role key (HTTP $CODE) - copy it again from Project Settings -> API"; exit 1;;
    *) echo "   table $t: HTTP $CODE - run ../supabase.sql in the SQL editor first"; exit 1;;
  esac
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
