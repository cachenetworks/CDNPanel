#!/usr/bin/env bash
# CI check: a pg_dump of a populated database restores into an empty database with identical
# row counts, the audit-log immutability trigger intact and no pending migrations.
#   DATABASE_URL=postgresql://user:pass@host:5432/source ./scripts/test-backup-restore.sh
set -euo pipefail
cd "$(dirname "$0")/.."

SRC="${DATABASE_URL:?set DATABASE_URL to the populated source database}"
BASE="${SRC%/*}"
DST="${BASE}/cdn_restore_check"
DUMP="$(mktemp -d)/backup.dump"

echo "› Dumping source database"
pg_dump --format=custom --compress=9 --no-owner --dbname="$SRC" --file="$DUMP"
pg_restore --list "$DUMP" > /dev/null

echo "› Restoring into a fresh database"
psql "$BASE/postgres" -v ON_ERROR_STOP=1 -q -c 'DROP DATABASE IF EXISTS cdn_restore_check' -c 'CREATE DATABASE cdn_restore_check'
pg_restore --no-owner --exit-on-error --dbname="$DST" "$DUMP"

TABLES=(User Role ApiKey File FileVersion Folder Project Zone ZoneDomain AuditLog SecurityEvent ShareLink FileRequest Setting)
fail=0
for t in "${TABLES[@]}"; do
  a=$(psql "$SRC" -tAc "SELECT count(*) FROM \"$t\"")
  b=$(psql "$DST" -tAc "SELECT count(*) FROM \"$t\"")
  printf '  %-14s source=%-6s restored=%-6s %s\n' "$t" "$a" "$b" "$([ "$a" = "$b" ] && echo ok || echo MISMATCH)"
  [ "$a" = "$b" ] || fail=1
done

echo "› Checking the audit-log trigger survived"
trig=$(psql "$DST" -tAc "SELECT count(*) FROM pg_trigger WHERE tgname = 'audit_log_immutable'")
[ "$trig" = "1" ] || { echo "audit_log_immutable trigger missing"; fail=1; }
if psql "$DST" -q -c 'UPDATE "AuditLog" SET "action" = '"'"'TAMPERED'"'"' WHERE "id" = (SELECT "id" FROM "AuditLog" LIMIT 1)' 2>/dev/null; then
  [ "$(psql "$DST" -tAc 'SELECT count(*) FROM "AuditLog"')" = "0" ] || { echo "audit log rows were modifiable after restore"; fail=1; }
fi

echo "› Checking migration status of the restored database"
DATABASE_URL="$DST" npx prisma migrate status --schema packages/database/prisma/schema.prisma

psql "$BASE/postgres" -q -c 'DROP DATABASE cdn_restore_check'
[ "$fail" = "0" ] && echo "Backup / restore check passed" || { echo "Backup / restore check FAILED"; exit 1; }
