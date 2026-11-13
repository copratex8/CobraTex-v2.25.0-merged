#!/usr/bin/env bash
# Restore (or just VERIFY) an encrypted CobraTex backup produced by .github/workflows/db-backup.yml.
#
#   BACKUP_PASSPHRASE=... bash tools/restore-backup.sh <backup.dump.gpg|backup.dump> --verify-only
#   BACKUP_PASSPHRASE=... bash tools/restore-backup.sh <backup.dump.gpg> <TARGET_DB_URL> --wipe [--yes] [--migrations-dir DIR]
#
# What it does:
#   1. decrypts the archive and checks it is readable and contains the core tables (integrity check, no DB needed);
#   2. (restore mode) requires the TARGET to ALREADY have the schema (run `npm run migrate` in backend/ on a new project first);
#   3. with --wipe: empties every table in schema public, then loads the backup DATA with triggers/FKs suspended
#      (session_replication_role=replica) in ONE transaction — all or nothing;
#   4. re-runs supabase/migrations/*.sql (they are idempotent) so Supabase Auth users, hook, policies and Realtime are rebuilt;
#   5. prints row counts and checks that posted journal entries still balance (debit = credit).
# It refuses to touch a non-empty database without --wipe, and asks you to type the database host to confirm (unless --yes).
set -euo pipefail

die() { echo "✗ $*" >&2; exit 1; }
usage() { sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }

FILE="${1:-}"; [ -n "$FILE" ] || usage
shift || true
URL=""
if [ $# -gt 0 ] && [[ "$1" != --* ]]; then URL="$1"; shift; fi
VERIFY=0; WIPE=0; YES=0; MIGDIR="supabase/migrations"
while [ $# -gt 0 ]; do
  case "$1" in
    --verify-only) VERIFY=1 ;;
    --wipe) WIPE=1 ;;
    --yes) YES=1 ;;
    --migrations-dir) shift; MIGDIR="${1:?--migrations-dir needs a value}" ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done

[ -f "$FILE" ] || die "file not found: $FILE"
command -v pg_restore >/dev/null || die "pg_restore not found — install the PostgreSQL client tools (same major version as the server)"
if [ "$VERIFY" = 0 ]; then
  [ -n "$URL" ] || die "give the TARGET database URL (or use --verify-only)"
  command -v psql >/dev/null || die "psql not found"
fi

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
DUMP="$TMP/db.dump"

if [[ "$FILE" == *.gpg ]]; then
  command -v gpg >/dev/null || die "gpg not found"
  if [ -z "${BACKUP_PASSPHRASE:-}" ]; then read -r -s -p "Backup passphrase: " BACKUP_PASSPHRASE; echo; fi
  printf '%s' "$BACKUP_PASSPHRASE" | gpg --batch --yes --quiet --pinentry-mode loopback --passphrase-fd 0 -d -o "$DUMP" "$FILE" \
    || die "decryption failed (wrong passphrase or corrupted file)"
else
  cp "$FILE" "$DUMP"
fi
echo "✓ decrypted"

pg_restore --list "$DUMP" > "$TMP/toc.txt" || die "archive is unreadable/corrupted"
for t in tenants users companies journal_entries journal_lines; do
  grep -Eq "TABLE DATA public $t " "$TMP/toc.txt" || die "archive has no data section for table '$t' — not a CobraTex backup?"
done
echo "✓ archive readable: $(grep -c 'TABLE DATA' "$TMP/toc.txt") table data sections"
[ "$VERIFY" = 1 ] && { echo "✓ verify-only: done (nothing was restored)"; exit 0; }

HOST="$(printf '%s' "$URL" | sed -E 's#^[a-zA-Z]+://([^@/]*@)?([^/:?]+).*#\2#')"
Q() { psql "$URL" -v ON_ERROR_STOP=1 -Atq -c "$1"; }

[ "$(Q "select to_regclass('public.tenants') is not null and to_regclass('public._migrations') is not null")" = "t" ] \
  || die "target has no CobraTex schema. On a NEW project first run:  cd backend && DATABASE_URL=<target> npm run migrate"
EXISTING="$(Q "select count(*) from public.tenants")"
if [ "$EXISTING" != "0" ] && [ "$WIPE" = 0 ]; then die "target already holds data ($EXISTING tenant rows). Use --wipe to REPLACE it."; fi

if [ "$YES" = 0 ]; then
  echo "⚠  About to REPLACE all data in schema public on host: $HOST"
  read -r -p "Type the host name to confirm: " ans
  [ "$ans" = "$HOST" ] || die "confirmation does not match — aborted"
fi

if [ "$WIPE" = 1 ]; then
  Q "DO \$\$ DECLARE r record; BEGIN FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='public' LOOP EXECUTE format('TRUNCATE TABLE public.%I CASCADE', r.tablename); END LOOP; END \$\$;"
  echo "✓ target emptied"
fi

PGOPTIONS="-c session_replication_role=replica" pg_restore --data-only --no-owner --no-privileges --single-transaction --exit-on-error -d "$URL" "$DUMP" \
  || die "restore failed — nothing was changed in the target (single transaction)"
echo "✓ data restored"

if [ -d "$MIGDIR" ] && [ "$(Q "select to_regnamespace('auth') is not null")" = "t" ]; then
  for f in $(ls "$MIGDIR"/*.sql | sort); do psql "$URL" -v ON_ERROR_STOP=1 -q -f "$f" >/dev/null || die "re-applying $f failed"; done
  echo "✓ Supabase layer re-applied (auth users, hook, policies, realtime)"
else
  echo "• Supabase layer skipped (no auth schema on target or $MIGDIR missing)"
fi

echo "— row counts —"
for t in tenants companies users journal_entries journal_lines sales_invoices attachments; do
  printf '%-18s %s\n' "$t" "$(Q "select count(*) from public.$t" 2>/dev/null || echo n/a)"
done
DIFF="$(Q "select coalesce(sum(l.debit),0) - coalesce(sum(l.credit),0) from public.journal_lines l join public.journal_entries e on e.id = l.journal_entry_id where e.status = 'posted'")"
echo "posted journal imbalance (must be 0): $DIFF"
[ "$(printf '%s' "$DIFF" | sed -E 's/^-?0(\.0+)?$/0/')" = "0" ] || { echo "✗ posted journal entries do NOT balance after restore — investigate before opening to users" >&2; exit 2; }
echo "✓ restore complete. Run tools/smoke-test.mjs against this environment, then switch users over."
