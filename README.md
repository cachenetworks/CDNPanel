# CDN Platform

A self-hosted CDN and file delivery platform: secure uploads, public/private files, signed URLs, API keys with scopes, staff dashboard with RBAC, analytics, audit logs, webhooks and interactive API documentation.

- **API** — Fastify + TypeScript, PostgreSQL (Prisma), Redis (rate limits, BullMQ jobs)
- **Worker** — malware scanning (ClamAV), media metadata, webhooks, cleanup, analytics roll-ups, retention
- **Dashboard** — Next.js 15, React 19, Tailwind
- **Storage** — local filesystem or any S3-compatible service (AWS S3, Cloudflare R2, MinIO, Backblaze B2)
- **Edge** — Nginx (X-Accel-Redirect file serving), Cloudflare-aware

## Contents

1. [Features](#features) · 2. [Architecture](#architecture) · 3. [Requirements](#requirements) · 4. [Installation](#installation) · 5. [Docker deployment](#docker-deployment) · 6. [Environment](#environment-configuration) · 7. [Storage](#storage-configuration) · 8. [Cloudflare](#cloudflare-configuration) · 9. [Nginx](#nginx-configuration) · 10. [Security model](#security-model) · 11. [API authentication](#api-authentication) · 12. [API documentation](#api-documentation) · 13. [Backups](#backups) · 14. [Updating](#updating) · 15. [Troubleshooting](#troubleshooting) · 16. [Development](#development) · 17. [License](#license)

## Features

- **Files** — grid/list explorer, nested folders, breadcrumbs, search (name, id, SHA-256, MIME, folder, uploader) and filters (date, type, size, visibility, uploader), bulk select/move/delete, preview, rename/move/copy, copy CDN/API URLs, per-file metadata (type, size, checksum, dimensions, duration, storage, downloads, bandwidth).
- **Uploads** — drag & drop, multiple concurrent uploads with progress/speed/retry; resumable chunked uploads for large files; content-type detection from file signatures; SHA-256 integrity; deduplication; size limits, allowed MIME types, blocked extensions, quotas.
- **Visibility** — `PUBLIC`, `PRIVATE`, `AUTHENTICATED`, `SIGNED_URL_ONLY`, with folder inheritance. Expiring HMAC-signed URLs.
- **Delivery** — `GET`/`HEAD /files/{id}` and `/p/{folder}/{file}` with `Range`, `ETag`, `Last-Modified`, conditional requests, per-file `Cache-Control`, forced `Content-Disposition: attachment` + sandbox CSP for HTML/SVG/XML/JS/PDF.
- **API keys** — `cdn_live_…`/`cdn_test_…`, shown once, stored as HMAC-SHA256 hashes; scopes, expiry, per-key rate limits, IP/CIDR allowlists, endpoint allowlists, disable/rotate (with grace period)/revoke/revoke-all.
- **Staff auth** — Argon2id passwords, HttpOnly session cookies, remember-me, per-session and all-device logout, TOTP 2FA with recovery codes, brute-force throttling and lockout, step-up re-authentication for dangerous actions, invitations and reset links.
- **RBAC** — 23 granular permissions, 7 built-in roles (Founder, Administrator, Developer, Moderator, Support, Uploader, Viewer), custom roles, privilege-escalation guards, folder role restrictions.
- **Analytics** — requests, bandwidth, downloads, cache revalidations, response times, errors; breakdowns by file, folder, API key, MIME type, country and status code; 24h/7d/30d/90d/custom ranges; daily roll-ups beyond the raw retention window.
- **Audit & security** — append-only audit log (enforced by a database trigger), security events, security center (failed logins, suspicious IPs/keys, expired/revoked keys, active sessions, login IPs), session revocation.
- **Webhooks** — HMAC-SHA256 signed events with retries and delivery history.
- **Docs** — OpenAPI 3.1 at `/openapi.json` and an interactive reference at `/dashboard/docs` with curl/JavaScript/Node.js/Python samples and “Try it”.

## Architecture

```
                 Cloudflare (TLS, WAF)
                        │  tunnel / proxied
                        ▼
                ┌───────────────┐   /, /login, /dashboard/*   ┌──────────┐
   :8873 ──────▶│     Nginx     │────────────────────────────▶│   web    │ Next.js dashboard
                │               │   /api/*, /files/*, /p/*,   ├──────────┤
                │ X-Accel files │──────/openapi.json─────────▶│   api    │ Fastify (REST + delivery)
                └──────┬────────┘                             └────┬─────┘
                       │ internal /_protected_storage/              │ BullMQ
                       ▼                                            ▼
                 cdn-data volume ◀──────────────────────────── ┌──────────┐
                 (local storage)                               │  worker  │ scan · metadata · webhooks · cleanup · roll-ups
                                                               └────┬─────┘
                                     PostgreSQL ◀──────────────────┤
                                     Redis      ◀──────────────────┘
```

```
apps/
  api/        Fastify API, CDN delivery, background worker (src/worker), CLI scripts
  web/        Next.js staff dashboard
packages/
  shared/     Errors, ids, RBAC catalogue, crypto (AES-256-GCM, API keys, signed URLs, webhooks), filename rules
  storage/    Storage driver abstraction: local + S3-compatible
  database/   Prisma schema, migrations, seed
infrastructure/
  docker/     Dockerfiles      nginx/   Nginx configuration
docs/         Backups
scripts/      backup-postgres.sh
```

Every REST route is declared once (`apps/api/src/http/route.ts`): the same definition drives validation, auth mode, permission/scope enforcement, CSRF, step-up auth, per-route rate limits and the OpenAPI document. `/api/v2` can be added as a new route set alongside v1.

## Requirements

- Docker 24+ with Docker Compose v2 (production), **or**
- Node.js 22.9+, PostgreSQL 14+, Redis 6.2+ (development)
- Optional: ClamAV (`--profile clamav`), an S3-compatible bucket

## Installation

```bash
git clone <repo> cdn && cd cdn
cp .env.example .env
# Fill in the REQUIRED values (commands are in the comments):
#   POSTGRES_PASSWORD, REDIS_PASSWORD, SESSION_SECRET, MASTER_ENCRYPTION_KEY, *_URL
```

## Docker deployment

```bash
docker compose up -d --build                 # postgres, redis, migrate, api, worker, web, nginx
docker compose exec api npm run create-admin # prompts for email, name and password
```

Open `APP_URL`, sign in and enable two-factor authentication under **Account & security**. There are no default credentials; `create-admin` is the only bootstrap path and needs shell access to the host.

- The `migrate` service applies Prisma migrations before the API starts; the API re-seeds the permission catalogue and built-in roles on boot (idempotent).
- Health: `GET /health` (liveness), `GET /health/ready` (PostgreSQL, Redis, storage).
- Optional services: `docker compose --profile clamav up -d` then set `CLAMAV_HOST=clamav` and enable *Settings → Uploads → Require malware scan*.
- **Dockge (prebuilt images)**: `deploy/dockge/compose.yaml` is self-contained — it pulls `ghcr.io/cachenetworks/cdnpanel-api` / `-web` (built by GitHub Actions on every push to `main`) and embeds the Nginx config. In Dockge create a stack `cdn`, paste the compose file, fill in `deploy/dockge/.env.example` as the stack `.env`, run `docker login ghcr.io` once on the host (token with `read:packages`, since the images are private), then deploy. Update by pressing *Update* in Dockge (pulls `:latest`).
- **Dockge (build from source)**: alternatively put the repository itself in `/opt/stacks/cdn` with its `.env`; the root `docker-compose.yml` builds the images locally.

## Environment configuration

See `.env.example` for every variable. The process refuses to boot when required values are missing, malformed (e.g. a master key that is not 32 bytes) or unsafe in production (`TRUST_PROXY=true`, placeholder secrets).

| Variable | Purpose |
|---|---|
| `APP_URL`, `CDN_URL`, `API_URL` | Public URLs. May all be the same host (single domain) or separate hosts. |
| `CORS_ORIGINS` | Extra browser origins allowed to call the API with bearer keys. |
| `SESSION_SECRET` | ≥32 chars. |
| `MASTER_ENCRYPTION_KEY` | 32 random bytes (base64). Derives the AES-256-GCM, API-key-hash, signed-URL and CSRF subkeys via HKDF. **Back it up.** |
| `MASTER_ENCRYPTION_KEY_VERSION`, `MASTER_ENCRYPTION_KEYS_PREVIOUS` | Key rotation (see Security model). |
| `STORAGE_DRIVER`, `LOCAL_STORAGE_PATH`, `S3_*` | Default storage provider. |
| `TRUST_PROXY` | Proxy IPs/CIDRs whose `X-Forwarded-For` is honoured. |
| `TRUST_CLOUDFLARE_HEADERS` | Use `CF-Connecting-IP` / `CF-IPCountry` (only from trusted proxies). |
| `DELIVERY_MODE` | `stream`, `x-accel` (Nginx serves local files) or `redirect` (S3 presigned URLs). |
| `MAX_UPLOAD_SIZE` | Hard cap; the dashboard setting can only lower it. Keep Nginx `client_max_body_size` in sync. |

Runtime settings (upload rules, cache headers, rate limits, session lifetimes, 2FA policy, retention, analytics privacy, webhooks) are edited under **Settings** and audited.

## Storage configuration

The environment defines the *default* provider. More providers can be added under **Storage** — their credentials are stored encrypted with AES-256-GCM (bound to the provider id) and never returned by the API.

| Provider | Endpoint | Notes |
|---|---|---|
| Local | — | Must be inside `LOCAL_STORAGE_ALLOWED_ROOT` (`/data` in Docker). |
| AWS S3 | *(empty)* | Region required. |
| Cloudflare R2 | `https://<account>.r2.cloudflarestorage.com` | Region `auto`. |
| MinIO | `http://minio:9000` | Path-style addressing. |
| Backblaze B2 | `https://s3.<region>.backblazeb2.com` | Use an application key. |

Stored object keys are generated from file ids (`objects/ab/cd/file_…`) — user-supplied names never touch the filesystem, and the local driver re-verifies every resolved path (including symlinks) stays inside its root.

For large deployments use `DELIVERY_MODE=x-accel` (local) so Nginx streams bytes after the API authorises the request, or `DELIVERY_MODE=redirect` (S3) to hand clients a short-lived presigned URL.

## Cloudflare configuration

Recommended: **Cloudflare Tunnel** (`cloudflared`) → `http://localhost:8873`. The origin then needs no open inbound ports.

```yaml
# /etc/cloudflared/config.yml
ingress:
  - hostname: cdn.example.com
    service: http://localhost:8873
    originRequest: { disableChunkedEncoding: false }
  - service: http_status:404
```

`.env`: `TRUST_CLOUDFLARE_HEADERS=true`. In the compose setup the API trusts only the Docker networks (Nginx), and Nginx forwards `CF-Connecting-IP`/`CF-IPCountry` only for requests arriving from loopback / the Docker bridge (the tunnel). Requests reaching port 8873 from elsewhere have those headers stripped, so they cannot spoof client IPs.

Firewall: do not expose 8873 publicly when using a tunnel. If you use a proxied DNS record instead of a tunnel, publish Nginx on a Cloudflare-supported port (e.g. 443/8443), allow inbound traffic **only** from [Cloudflare IP ranges](https://www.cloudflare.com/ips/), and use Full (strict) TLS.

Cloudflare caches public files according to the `Cache-Control` the platform sends (`public, max-age=31536000, immutable` by default); private and signed responses are `private, no-store`. Cloudflare's 100 MB upload limit per request applies — the dashboard automatically uses chunked uploads above 64 MB.

## Nginx configuration

`infrastructure/nginx/` contains the production config:

- Unbuffered request bodies for `/api/` (uploads stream directly to storage), 600 s timeouts, `client_max_body_size 5g`.
- `/files/` and `/p/` are authorised by the API and served from an `internal` location via `X-Accel-Redirect`, so Nginx handles ranges and sendfile without buffering whole files.
- `X-Forwarded-For` is overwritten (not appended); access logs use `$uri` so signed-URL signatures are never logged.
- An extra `limit_req` zone protects the login endpoint.

For a split-domain setup (`panel.`, `api.`, `cdn.`), create one `server` block per host: panel → `web` plus `/api/`, api → `api`, cdn → only `/files/` and `/p/`.

## Security model

| Concern | Implementation |
|---|---|
| Passwords | Argon2id (64 MiB, t=3), rehash on login when parameters change, policy check. |
| API keys | 190-bit random secret; stored as `HMAC-SHA256(HKDF(master,"api-key-hash"), key)` + version + display prefix; looked up by hash, compared with `timingSafeEqual`; shown once. |
| Encryption at rest | AES-256-GCM, format `enc.v1.<keyVersion>.<iv>.<tag>.<ciphertext>`, AAD binds each value to its row. Used for storage credentials, TOTP secrets, webhook secrets and API key notes. |
| Key rotation | Set a new `MASTER_ENCRYPTION_KEY` + increment `MASTER_ENCRYPTION_KEY_VERSION`, move the old key into `MASTER_ENCRYPTION_KEYS_PREVIOUS="1:<old>"`. Old ciphertexts, API key hashes and signed URLs keep working; new data uses the new key. |
| Sessions | 256-bit token in an HttpOnly, SameSite=Lax cookie (`__Host-` prefixed and Secure over HTTPS); only SHA-256 stored; expiry, revocation, logout-all. |
| CSRF | Cookie-authenticated mutations require `X-CSRF-Token` = HMAC(session token) plus an allowed `Origin`. Bearer requests are not cookie-based. |
| Authorization | Every route declares its auth mode, permissions and scopes; enforced server-side before validation and handlers. Admin endpoints reject API keys. |
| Step-up | Deleting users/roles, many files or folder trees, storage changes, security settings, revoke-all, 2FA resets require password (+TOTP) confirmation within a short window. |
| Brute force | Per-IP and per-account login limits, temporary lockout, MFA attempt limits, Redis-backed global/IP/key/route rate limits with `X-RateLimit-*` headers. |
| Uploads | Normalised names, blocked extensions, signature-based type detection, size/quota limits, checksum verification, optional ClamAV with quarantine; files are not served until `READY`. |
| Stored XSS | Active content is forced to download with `Content-Security-Policy: sandbox` and `nosniff`; the dashboard CSP forbids third-party scripts. |
| Logging | Structured JSON with request ids; `Authorization`, cookies, passwords, tokens, keys and secrets are redacted; audit metadata is sanitised. |
| Audit integrity | A PostgreSQL trigger rejects UPDATE/DELETE on audit rows except explicit retention pruning. |
| SSRF | Webhook targets must resolve to public addresses (override with `WEBHOOK_ALLOW_PRIVATE_NETWORKS`). |
| CORS | Explicit allowlist with credentials for the API; delivery routes allow any origin without credentials. |

## API authentication

```bash
curl -H "Authorization: Bearer cdn_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" https://cdn.example.com/api/v1/files
```

Errors always look like `{"error":{"code":"invalid_api_key","message":"…","request_id":"req_…"}}`.

## API documentation

- Interactive reference: **`/dashboard/docs`** (search, per-endpoint scopes/permissions, parameters, examples in curl/JavaScript/Node.js/Python, Try it). API keys typed into Try it live only in page memory.
- Machine-readable: **`/openapi.json`** (OpenAPI 3.1). Export with `npm run openapi -w @cdn/api -- openapi.json`.

## Backups

See [docs/backups.md](docs/backups.md). In short: `scripts/backup-postgres.sh` for the database, a separate backup of the `cdn-data` volume or bucket for file contents, and the `.env` (especially `MASTER_ENCRYPTION_KEY`) in a password manager.

## Updating

```bash
cd /opt/stacks/cdn
./scripts/backup-postgres.sh
git pull                       # or replace the files
docker compose up -d --build   # migrate runs automatically before the API starts
```

## Troubleshooting

| Symptom | Check |
|---|---|
| API exits immediately | `docker compose logs api` — the env validator prints exactly which variable is missing/invalid. |
| `/health/ready` returns 503 | Which check is `error`: database, redis or storage (volume permissions / bucket credentials). |
| Every client IP is the proxy IP | `TRUST_PROXY` must include the proxy address; behind Cloudflare also `TRUST_CLOUDFLARE_HEADERS=true`. |
| Uploads fail at ~100 MB | Cloudflare request limit — use chunked uploads (the dashboard does automatically). |
| `413 file_too_large` | Settings → Uploads limit, `MAX_UPLOAD_SIZE`, Nginx `client_max_body_size`. |
| `csrf_failed` | Dashboard served from an origin not listed in `APP_URL`/`CORS_ORIGINS`. |
| Files stuck in `SCANNING` | Worker logs; ClamAV reachable at `CLAMAV_HOST`? |
| Analytics empty | Settings → Analytics enabled; worker running for roll-ups. |
| Lost `MASTER_ENCRYPTION_KEY` | Encrypted fields are unrecoverable and all API keys must be re-issued. |

## Development

```bash
npm install
cp .env.example .env               # point DATABASE_URL / REDIS_URL at local services
npm run db:migrate && npm run db:seed
npm run create-admin -- # (build first: npm run build)
npm run dev                        # api :4000, worker, web :3000 (proxies /api, /files, /p)

npm run build       # all packages and apps
npm run typecheck
npm run lint
npm test            # unit + integration (integration needs Postgres + Redis; TEST_DATABASE_URL / TEST_REDIS_URL)
```

The integration suite resets the `cdn_test` database and exercises login, CSRF, RBAC, API keys (revoked/expired/scopes/IP/endpoint/rate limit/rotation), uploads, delivery (HEAD, ranges, 304), private files, signed URL forgery and expiry, path traversal, malformed ids, chunked uploads, analytics and audit-log immutability.


## License

CDNPanel is **source-available, not open source**. It is licensed under the [Cache Networks Personal Use License](LICENSE).

You may use and modify it for your own personal, non-commercial use. General redistribution, re-hosting, resale, sublicensing, commercial/organisational use, and publishing CDNPanel as a separate product are not permitted without prior written permission from Cache Networks.

**Community forks are welcome.** You may fork CDNPanel on GitHub to prepare fixes, features, documentation, tests, code-review suggestions, issue reproductions, or pull requests that help the official project grow. Community forks must keep the license and attribution, remain clearly unofficial, and cannot be turned into a competing product, hosted service, resale, mirror, or independent release.

If you copy or derive code from CDNPanel for another project, the applicable source must retain clear attribution to **Cache Networks** and link back to this repository. See [LICENSE](LICENSE) for the full terms and contribution grant.
