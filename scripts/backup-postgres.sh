#!/usr/bin/env bash
# PostgreSQL backup for the docker compose deployment.
#   ./scripts/backup-postgres.sh [backup-dir]        (default: ./backups)
# Produces a compressed custom-format dump, keeps the last $KEEP_DAYS days.
# This backs up the DATABASE ONLY — file contents live in the storage backend and
# must be backed up separately (see docs/backups.md).
set -euo pipefail

cd "$(dirname "$0")/.."
BACKUP_DIR="${1:-./backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

DB_USER="$(docker compose exec -T postgres printenv POSTGRES_USER)"
DB_NAME="$(docker compose exec -T postgres printenv POSTGRES_DB)"
OUT="$BACKUP_DIR/cdn-${STAMP}.dump"

docker compose exec -T postgres pg_dump -U "$DB_USER" -d "$DB_NAME" --format=custom --compress=9 --no-owner > "$OUT.partial"
mv "$OUT.partial" "$OUT"
chmod 600 "$OUT"
sha256sum "$OUT" > "$OUT.sha256"

# Sanity check: the archive must be readable.
docker compose exec -T postgres pg_restore --list < "$OUT" > /dev/null

find "$BACKUP_DIR" -name 'cdn-*.dump*' -mtime +"$KEEP_DAYS" -delete
echo "Backup written: $OUT ($(du -h "$OUT" | cut -f1))"
