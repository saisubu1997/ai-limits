#!/bin/bash
# Deploys the HTML-serving Edge Function.
#   SUPABASE_ACCESS_TOKEN=sbp_... ./deploy-function.sh
set -euo pipefail
cd "$(dirname "$0")"
REF=${PROJECT_REF:-ipxgejfvnvowrgwezcpl}
[ -n "${SUPABASE_ACCESS_TOKEN:-}" ] || { echo "set SUPABASE_ACCESS_TOKEN (https://supabase.com/dashboard/account/tokens)"; exit 1; }
npx --yes supabase@latest functions deploy sai-agents \
  --project-ref "$REF" --no-verify-jwt --use-api
echo "https://$REF.supabase.co/functions/v1/sai-agents"
