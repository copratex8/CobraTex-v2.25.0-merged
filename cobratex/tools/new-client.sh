#!/usr/bin/env bash
# Provision ONE client deployment (own Supabase project + own Vercel projects).
#   bash tools/new-client.sh <slug> <SUPABASE_SESSION_POOLER_URL> [--with-tests] [--dry-run]
# Does: (1) applies the backend schema (0001..N)  (2) applies supabase/migrations/*.sql in order
#       (3) optional: runs supabase/tests/*.sql (rolled back)  (4) writes clients/<slug>.env with fresh random secrets
# Never commit clients/ (it is git-ignored). Requires: psql, node, openssl, and `npm install` already run in backend/.
set -euo pipefail

SLUG="${1:-}"; DB_URL="${2:-}"; shift 2 || true
WITH_TESTS=0; DRY=0
for a in "$@"; do case "$a" in --with-tests) WITH_TESTS=1 ;; --dry-run) DRY=1 ;; *) echo "unknown option $a"; exit 1 ;; esac; done

[[ "$SLUG" =~ ^[a-z0-9][a-z0-9-]{1,28}$ ]] || { echo "slug: 2-29 chars, lowercase letters/digits/hyphen"; exit 1; }
[[ "$DB_URL" =~ ^postgres(ql)?:// ]] || { echo "second argument must be the Supabase SESSION pooler URL (postgresql://...)"; exit 1; }
for bin in openssl node; do command -v $bin >/dev/null || { echo "$bin is required"; exit 1; }; done
[ "$DRY" = 1 ] || command -v psql >/dev/null || { echo "psql is required"; exit 1; }
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
mkdir -p clients; ENVFILE="clients/$SLUG.env"
[ ! -e "$ENVFILE" ] || { echo "$ENVFILE already exists — refusing to overwrite (secrets would change)"; exit 1; }

if [ "$DRY" = 0 ]; then
  echo "1/3  Backend schema (0001..N) ..."
  (cd backend && DATABASE_URL="$DB_URL" npm run migrate)
  echo "2/3  Supabase migrations ..."
  for f in $(ls supabase/migrations/*.sql | sort); do echo "  $f"; psql "$DB_URL" -v ON_ERROR_STOP=1 -q -f "$f" >/dev/null; done
  if [ "$WITH_TESTS" = 1 ]; then
    echo "     Tests (each runs in a rolled-back transaction) ..."
    for t in supabase/tests/*.sql; do echo "  $t"; psql "$DB_URL" -v ON_ERROR_STOP=1 -q -f "$t" | grep -E "PASSED|FAIL" || true; done
  fi
else
  echo "[dry-run] skipping database steps"
fi

echo "3/3  Writing $ENVFILE ..."
rnd() { openssl rand -base64 "$1" | tr -d '\n'; }
TOTP="$(node tools/gen-totp-secret.mjs | head -1 | cut -d= -f2)"
umask 077
cat > "$ENVFILE" <<ENV
# ===== Client: $SLUG — generated $(date -u +%F) — KEEP PRIVATE (never commit) =====
# --- Backend (Vercel project "$SLUG-api", Root Directory = backend) ---
DATABASE_URL=$([ "$DRY" = 1 ] && echo "<TRANSACTION_POOLER_URL_PORT_6543>" || echo "${DB_URL/:5432\//:6543/}")
DB_POOL_MAX=1
DATABASE_SSL=auto
NODE_ENV=production
JWT_ACCESS_SECRET=$(rnd 48)
JWT_REFRESH_SECRET=$(rnd 48)
BOOTSTRAP_SECRET=$(rnd 36)
DEVELOPER_SECRET=$(rnd 30)
DEVELOPER_TOTP_SECRET=$TOTP
CRON_SECRET=$(rnd 30)
DISABLE_LEGACY_LOGIN=true
SUPABASE_URL=https://<PROJECT_REF>.supabase.co
CORS_ORIGINS=https://$SLUG.vercel.app,<DEVELOPER_PANEL_ORIGIN>
# VAPID_PUBLIC_KEY= / VAPID_PRIVATE_KEY= / VAPID_SUBJECT=mailto:you@example.com   (only if you use Web Push)

# --- Frontend (Vercel project "$SLUG", Root Directory = frontend) ---
VITE_AUTH_MODE=supabase
VITE_SUPABASE_URL=https://<PROJECT_REF>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon-or-publishable-key>
VITE_API_BASE_URL=https://$SLUG-api.vercel.app/api
# VITE_CSP=on   # فعّله بعد اختباره على Staging (يراقب Console بحثًا عن Refused to…)

# --- Add to the GitHub secret CLIENTS_JSON (release + backup workflows) ---
# "$SLUG": { "vercel_token": "...", "org_id": "...", "frontend_project_id": "...", "backend_project_id": "..." }
# --- Add to the GitHub secret CLIENT_DB_URLS (nightly backup + keep-alive) ---
# "$SLUG": "<SESSION_POOLER_URL>"
ENV
chmod 600 "$ENVFILE"
cat <<TXT

✓ $ENVFILE written (secrets are random and unique to this client).
Next (manual, once per client) — full list in docs/MULTI-CLIENT_AR.md:
  1. Supabase dashboard: Authentication → Hooks → enable public.custom_access_token_hook; disable "Allow new users to sign up".
  2. Create the two Vercel projects, paste the env vars from $ENVFILE.
  3. Create the client's company:  curl -X POST https://$SLUG-api.vercel.app/api/bootstrap -H "x-bootstrap-secret: <BOOTSTRAP_SECRET>" -H "content-type: application/json" -d '{...}'
  4. Add the client in the developer panel (🖧 الخوادم) and set its license (plan, expiry, grace).
  5. Run: node tools/smoke-test.mjs  (see docs/GO-LIVE_AR.md §6).
TXT
