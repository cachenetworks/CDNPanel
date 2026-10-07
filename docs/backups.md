# Backups and restore

A complete backup has **three independent parts**. Backing up PostgreSQL does **not** back up your files.

| Part | Contains | How |
|---|---|---|
| PostgreSQL | Metadata, users, roles, API key hashes, encrypted credentials, audit logs, analytics | `scripts/backup-postgres.sh` |
| File storage | The uploaded bytes | Volume / bucket backup (below) |
| Secrets | `.env`, especially `MASTER_ENCRYPTION_KEY` | Password manager / secrets vault |

Without `MASTER_ENCRYPTION_KEY` the database backup is still restorable, but encrypted fields (storage credentials, TOTP secrets, webhook secrets, API key notes) cannot be decrypted, and **every API key stops validating** (key hashes are keyed with a key derived from it). Store it separately from the database backups.

## PostgreSQL

```bash
./scripts/backup-postgres.sh /srv/backups/cdn     # custom-format dump + .sha256, keeps 14 days
```

Schedule it with cron on the Docker host:

```cron
15 2 * * * cd /opt/stacks/cdn && ./scripts/backup-postgres.sh /srv/backups/cdn >> /var/log/cdn-backup.log 2>&1
```

Copy the dumps off the machine (e.g. `restic`, `rclone` to object storage). Test restores regularly.

### Restore

```bash
cd /opt/stacks/cdn
docker compose stop api worker web nginx
sha256sum -c /srv/backups/cdn/cdn-20260101T021500Z.dump.sha256
docker compose exec -T postgres dropdb -U cdn cdn
docker compose exec -T postgres createdb -U cdn cdn
docker compose exec -T postgres pg_restore -U cdn -d cdn --no-owner < /srv/backups/cdn/cdn-20260101T021500Z.dump
docker compose up -d       # the migrate service applies any newer migrations
```

The audit-log trigger is restored with the schema; `pg_restore` inserts rows, which the trigger allows.

## File storage

### Local storage (default)

Files live in the `cdn_cdn-data` Docker volume (`/data/storage` in the containers). Back it up with a snapshot-capable tool, for example:

```bash
docker run --rm -v cdn_cdn-data:/data:ro -v /srv/backups/cdn-files:/backup alpine \
  tar -czf /backup/files-$(date -u +%Y%m%d).tar.gz -C /data storage
```

or incrementally with `restic`/`borg` against the volume's mountpoint (`docker volume inspect cdn_cdn-data`). Objects are immutable (content never changes after upload), so incremental backups are very efficient.

Restore by extracting back into the volume while the stack is stopped. Take the database and file backups close together: files without a database row are invisible, and rows without files return storage errors.

### S3 / R2 / MinIO / B2

Enable bucket versioning and/or replication at the provider, or mirror the bucket:

```bash
rclone sync cdn-remote:my-cdn-bucket backup-remote:my-cdn-bucket-backup
```

## Redis

Redis holds only rate-limit counters and the job queue. It does not need to be backed up; queued webhook deliveries are also recorded in PostgreSQL and can be retried from the dashboard.
