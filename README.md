# CDNPanel

> A security-focused, self-hosted CDN and file-delivery platform built for people who want control of their storage, delivery, API access, staff permissions, analytics, and infrastructure.

[![Build & publish images](https://github.com/cachenetworks/CDNPanel/actions/workflows/docker.yml/badge.svg)](https://github.com/cachenetworks/CDNPanel/actions/workflows/docker.yml)
![Node.js](https://img.shields.io/badge/Node.js-22.9%2B-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-14%2B-4169E1?logo=postgresql&logoColor=white)
![Redis](https://img.shields.io/badge/Redis-6.2%2B-DC382D?logo=redis&logoColor=white)
![License](https://img.shields.io/badge/license-Source--Available-orange)

**CDNPanel** combines a staff dashboard, REST API, secure upload pipeline, storage abstraction, file delivery layer, analytics, audit logging, background workers, and production deployment tooling in one project.

It supports local storage and S3-compatible backends including **AWS S3, Cloudflare R2, MinIO, and Backblaze B2**, and is designed to sit behind **Nginx and/or Cloudflare**.

> [!IMPORTANT]
> CDNPanel is **source-available, not open source**. Personal non-commercial use and community contribution forks are allowed. Redistribution, rebranding, commercial use, organisational deployment, independent releases, and hosted resale are restricted. Read the [LICENSE](LICENSE) before using or forking the project.

---

## Why CDNPanel?

A normal file uploader is easy to build. A trustworthy file-delivery platform is not.

CDNPanel is designed around the parts that become difficult once a project starts handling real users, API clients, staff access, multiple storage providers, large uploads, and security-sensitive data:

- secure staff authentication and session management;
- granular role-based access control;
- scoped and revocable API keys;
- resumable uploads with integrity checks;
- public, private, authenticated, and signed-only delivery;
- storage-provider abstraction;
- malware scanning and quarantine;
- audit logging and security events;
- analytics and bandwidth tracking;
- webhook delivery and retries;
- production Docker deployments;
- Cloudflare-aware reverse-proxy handling;
- generated OpenAPI documentation;
- backup, retention, and operational tooling.

CDNPanel is intended to be understandable enough to self-host while still having the structure expected from a serious production service.

---

## Table of contents

- [Feature overview](#feature-overview)
- [Architecture](#architecture)
- [Technology stack](#technology-stack)
- [Quick start](#quick-start)
- [Docker and Dockge deployment](#docker-and-dockge-deployment)
- [Storage](#storage)
- [File delivery](#file-delivery)
- [Authentication and RBAC](#authentication-and-rbac)
- [API keys](#api-keys)
- [Security model](#security-model)
- [Analytics and audit logs](#analytics-and-audit-logs)
- [Webhooks](#webhooks)
- [API documentation](#api-documentation)
- [Cloudflare](#cloudflare)
- [Health and operations](#health-and-operations)
- [Backups](#backups)
- [Development](#development)
- [Testing](#testing)
- [Contributing](#contributing)
- [License](#license)

---

## Feature overview

### File management

- grid and list file explorer;
- nested folders and breadcrumbs;
- search by name, ID, SHA-256, MIME type, folder, or uploader;
- filtering by date, type, size, visibility, and uploader;
- rename, move, copy, preview, download, and delete;
- bulk selection and bulk actions;
- friendly folder/file paths;
- copyable CDN and API URLs;
- file metadata including:
  - MIME type;
  - extension;
  - size;
  - SHA-256;
  - image dimensions;
  - media duration;
  - storage provider;
  - download count;
  - bandwidth usage;
  - last access time.

### Upload pipeline

- drag-and-drop uploads;
- multiple concurrent uploads;
- progress and transfer-speed reporting;
- retry support;
- resumable chunked uploads for large files;
- signature-based content-type detection;
- SHA-256 verification;
- duplicate detection;
- file-size limits;
- allowed MIME-type rules;
- blocked extension rules;
- storage quotas;
- optional ClamAV malware scanning;
- quarantine before delivery when scanning is required.

### Visibility and delivery

Files support:

- `PUBLIC`;
- `PRIVATE`;
- `AUTHENTICATED`;
- `SIGNED_URL_ONLY`.

Folder defaults can influence file visibility, while signed URLs provide expiring HMAC-authorised access.

Delivery supports:

- `GET` and `HEAD`;
- HTTP Range requests;
- `ETag`;
- `Last-Modified`;
- conditional requests and `304 Not Modified`;
- per-file `Cache-Control`;
- safe handling of active content;
- Nginx `X-Accel-Redirect`;
- S3 presigned redirects;
- direct application streaming.

### Staff authentication

- Argon2id password hashing;
- HttpOnly session cookies;
- optional "keep me signed in";
- per-session logout;
- logout from all devices;
- TOTP two-factor authentication;
- recovery codes;
- staff invitations;
- password reset tokens;
- brute-force throttling;
- temporary account lockout;
- step-up re-authentication for sensitive actions.

### RBAC

CDNPanel ships with granular permissions and built-in roles including:

- Founder;
- Administrator;
- Developer;
- Moderator;
- Support;
- Uploader;
- Viewer.

Custom roles are supported, along with privilege-escalation protections and folder-level staff restrictions.

### API keys

API keys use `cdn_live_...` and `cdn_test_...` prefixes and support:

- one-time secret display;
- HMAC-SHA256 storage rather than raw-key storage;
- scopes;
- expiration;
- per-key request limits;
- IP and CIDR restrictions;
- endpoint allowlists;
- disable/enable;
- rotation with a grace period;
- revocation;
- revoke-all workflows;
- last-used metadata;
- usage analytics.

### Analytics

CDNPanel can track:

- requests;
- downloads;
- bandwidth;
- upload activity;
- response time;
- errors;
- cache status;
- status codes;
- MIME types;
- files;
- folders;
- API keys;
- countries.

The dashboard supports common time windows and custom ranges. Raw request data can be retained for a limited period while daily roll-ups preserve longer-term analytics.

### Audit and security events

The platform includes:

- append-only audit logs;
- database-level protection against normal audit-row mutation;
- failed-login tracking;
- invalid-key events;
- suspicious API-key activity;
- CSRF failures;
- signed-URL failures;
- rate-limit events;
- session visibility;
- session revocation;
- security-event retention.

### Webhooks

Webhook support includes:

- event subscriptions;
- HMAC-SHA256 signing;
- delivery history;
- retries;
- response-code recording;
- failure details;
- delayed retry scheduling;
- SSRF-aware destination validation.

### API documentation

The API definition is generated from the same route declarations used by the application.

That gives CDNPanel:

- OpenAPI 3.1;
- `/openapi.json`;
- interactive docs under `/dashboard/docs`;
- endpoint search;
- parameter documentation;
- permissions and scopes;
- example requests;
- "Try it" support;
- examples for curl, JavaScript, Node.js, and Python.

---

## Architecture

```text
                             Internet
                                │
                                ▼
                    ┌─────────────────────┐
                    │ Cloudflare / TLS    │
                    │ WAF / Tunnel / DNS  │
                    └──────────┬──────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │        Nginx        │
                    │ reverse proxy       │
                    │ X-Accel delivery    │
                    └──────┬───────┬──────┘
                           │       │
              dashboard    │       │ API / delivery
                           ▼       ▼
                  ┌────────────┐  ┌────────────┐
                  │ Next.js Web│  │ Fastify API│
                  └────────────┘  └──────┬─────┘
                                         │
                                  BullMQ │ jobs
                                         ▼
                                  ┌────────────┐
                                  │   Worker   │
                                  │ scan       │
                                  │ metadata   │
                                  │ webhooks   │
                                  │ cleanup    │
                                  │ roll-ups   │
                                  └─────┬──────┘
                                        │
             ┌──────────────────────────┼──────────────────────────┐
             ▼                          ▼                          ▼
       PostgreSQL                    Redis                Storage providers
                                                       local / S3 / R2 /
                                                       MinIO / Backblaze B2
```

### Repository layout

```text
apps/
  api/              Fastify REST API, file delivery, worker, CLI scripts
  web/              Next.js staff dashboard

packages/
  shared/           errors, IDs, RBAC, crypto, signed URLs, validation
  storage/          local + S3-compatible storage abstraction
  database/         Prisma schema, migrations, seeds

infrastructure/
  docker/           production Dockerfiles
  nginx/            Nginx configuration

deploy/
  dockge/           prebuilt-image Dockge stack

docs/
  backups.md

scripts/
  backup-postgres.sh
```

A REST route is declared once in the API route system. The same definition drives request validation, authentication mode, permission/scope enforcement, CSRF requirements, step-up authentication, rate limits, and OpenAPI output.

---

## Technology stack

| Layer | Technology |
|---|---|
| API | Fastify + TypeScript |
| Dashboard | Next.js 15 + React 19 + Tailwind |
| Database | PostgreSQL + Prisma |
| Queue / rate limiting | Redis + BullMQ |
| Worker | Node.js / TypeScript |
| Local delivery | Nginx + X-Accel-Redirect |
| Object storage | S3-compatible API |
| Malware scanning | ClamAV |
| Containers | Docker / Docker Compose |
| CI / images | GitHub Actions + GHCR |

### Requirements

For production deployment:

- Docker 24+;
- Docker Compose v2.

For development without the full Docker stack:

- Node.js 22.9+;
- PostgreSQL 14+;
- Redis 6.2+.

Optional:

- ClamAV;
- an S3-compatible storage service;
- Cloudflare Tunnel or a Cloudflare-proxied hostname.

---

## Quick start

Clone the repository:

```bash
git clone https://github.com/cachenetworks/CDNPanel.git
cd CDNPanel
cp .env.example .env
```

Generate and configure the required secrets in `.env`.

At minimum, review:

```text
POSTGRES_PASSWORD
REDIS_PASSWORD
SESSION_SECRET
MASTER_ENCRYPTION_KEY
APP_URL
CDN_URL
API_URL
```

Then start the stack:

```bash
docker compose up -d --build
```

Create the initial administrator:

```bash
docker compose exec api npm run create-admin
```

There are **no default credentials**.

After signing in, enable two-factor authentication for the founder/admin account.

### Health checks

```text
GET /health
GET /health/ready
```

`/health` is the liveness endpoint.

`/health/ready` verifies critical dependencies including PostgreSQL, Redis, and storage availability.

---

## Docker and Dockge deployment

### Source build

The root `docker-compose.yml` builds the application locally.

```bash
docker compose up -d --build
```

### Dockge / prebuilt images

`deploy/dockge/compose.yaml` is intended for deployments that use the images published by GitHub Actions:

```text
ghcr.io/cachenetworks/cdnpanel-api
ghcr.io/cachenetworks/cdnpanel-web
```

The normal flow is:

1. create a Dockge stack;
2. use `deploy/dockge/compose.yaml`;
3. configure the stack environment from `deploy/dockge/.env.example`;
4. authenticate the host to GHCR where required;
5. deploy the stack;
6. use Dockge's normal update flow to pull newer images.

The GitHub Actions workflow runs type checks, linting, and tests before publishing application images.

---

## Storage

CDNPanel supports multiple storage providers.

| Provider | Kind | Notes |
|---|---|---|
| Local filesystem | `LOCAL` | restricted to the configured storage root |
| AWS S3 | `S3` | standard S3 API |
| Cloudflare R2 | `R2` | S3-compatible, region `auto` |
| MinIO | `MINIO` | S3-compatible, commonly path-style |
| Backblaze B2 | `B2` | S3-compatible B2 endpoint |

Storage-provider credentials are encrypted using AES-256-GCM and are not returned back through the normal API.

Stored object keys are generated from internal file IDs rather than user-provided filenames.

Example object layout:

```text
objects/ab/cd/file_...
```

The local storage driver re-validates resolved paths to prevent escaping the configured storage root.

### Delivery modes

`DELIVERY_MODE` can be configured as:

- `stream` — the API streams file bytes;
- `x-accel` — the API authorises access and Nginx serves local bytes;
- `redirect` — the API authorises access and redirects to a short-lived storage URL.

For large local deployments, `x-accel` is generally the preferred mode.

For S3-compatible object storage, `redirect` can reduce application-server bandwidth.

---

## File delivery

Canonical delivery endpoints include:

```text
GET  /files/{id}
HEAD /files/{id}

GET  /p/{folder}/{file}
HEAD /p/{folder}/{file}
```

The delivery layer handles:

- authorisation;
- signed URLs;
- visibility;
- ranges;
- ETags;
- conditional requests;
- cache headers;
- safe content-disposition behaviour;
- analytics;
- storage access.

HTML, SVG, XML, JavaScript, PDF, and other active or potentially risky content can be forced into safer download behaviour and sandboxed response policies.

---

## Authentication and RBAC

Staff authentication and API authentication are deliberately separate.

Dashboard/admin routes use secure staff sessions.

External API clients use bearer API keys.

Sensitive staff actions can require recent password/TOTP confirmation even when the current session is otherwise valid.

Examples include:

- destructive user changes;
- role changes;
- mass deletion;
- storage configuration changes;
- security settings;
- revoke-all operations;
- two-factor resets.

---

## API keys

Example:

```bash
curl \
  -H "Authorization: Bearer cdn_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" \
  https://cdn.example.com/api/v1/files
```

API errors use a predictable structure:

```json
{
  "error": {
    "code": "invalid_api_key",
    "message": "The supplied API key is invalid.",
    "request_id": "req_..."
  }
}
```

API keys are never stored in plaintext after creation.

---

## Security model

CDNPanel is designed with defence in depth.

| Area | Implementation |
|---|---|
| Passwords | Argon2id with rehash support |
| API keys | random secret + keyed HMAC hash |
| Encryption at rest | AES-256-GCM |
| Key derivation | HKDF-derived subkeys |
| Key rotation | current + previous master-key versions |
| Sessions | random tokens, only hashes stored server-side |
| Cookies | HttpOnly, SameSite, Secure where applicable |
| CSRF | origin validation + session-bound token |
| 2FA | TOTP + recovery codes |
| Authorisation | route-declared permissions/scopes |
| Sensitive actions | step-up re-authentication |
| Login protection | per-IP/per-account throttling and lockout |
| API protection | Redis-backed global/key/route limits |
| Uploads | file rules, signature detection, integrity checks |
| Malware | optional ClamAV quarantine |
| Path handling | generated storage keys + root validation |
| Stored active content | forced-safe delivery and CSP |
| Logging | structured logs with secret redaction |
| Audit log | append-only enforcement in PostgreSQL |
| Webhooks | HMAC signatures + SSRF-aware target validation |
| Proxy IPs | trusted-proxy / Cloudflare-aware resolution |

No self-hosted application is automatically secure simply because it includes security controls. Operators are responsible for correct deployment, TLS, firewalling, backups, secrets, dependency updates, and host security.

---

## Analytics and audit logs

Raw request analytics can be retained temporarily and rolled up into longer-term daily records.

Analytics can be broken down by:

- file;
- folder;
- API key;
- MIME type;
- country;
- status code;
- request type.

Privacy controls allow IP storage to be configured as:

- full;
- anonymised;
- disabled.

User-agent retention can also be controlled.

Audit records are designed for administrative accountability and are protected against ordinary update/delete operations at the database layer.

---

## Webhooks

Webhook deliveries are signed and retried.

The system records:

- event name;
- payload;
- delivery state;
- attempts;
- response status;
- response body where permitted;
- last error;
- next retry time;
- delivery time.

Webhook secrets are stored encrypted.

---

## API documentation

Machine-readable OpenAPI:

```text
/openapi.json
/api/v1/openapi.json
```

Interactive staff documentation:

```text
/dashboard/docs
```

To export the schema during development:

```bash
npm run openapi -w @cdn/api -- openapi.json
```

---

## Cloudflare

A recommended production setup is:

```text
Internet
   │
Cloudflare
   │
Cloudflare Tunnel
   │
localhost:8873
   │
Nginx
   │
CDNPanel
```

Example tunnel configuration:

```yaml
ingress:
  - hostname: cdn.example.com
    service: http://localhost:8873
    originRequest:
      disableChunkedEncoding: false

  - service: http_status:404
```

When the origin is reachable only through a tunnel, inbound public origin ports do not need to be exposed.

If using normal proxied DNS instead, restrict the origin appropriately and use strict TLS.

CDNPanel can trust Cloudflare client-IP/country headers only when requests arrive through configured trusted proxies. Do not enable trusted proxy behaviour blindly.

---

## Health and operations

Useful operational checks include:

```bash
docker compose ps
docker compose logs api
docker compose logs worker
docker compose logs web
docker compose logs nginx
```

If readiness fails, inspect:

- PostgreSQL connectivity;
- Redis connectivity;
- storage credentials;
- local-volume permissions;
- worker status;
- proxy configuration.

### Common issues

| Symptom | Check |
|---|---|
| API exits on startup | required environment values and secret validation |
| `/health/ready` returns 503 | database, Redis, or storage readiness |
| client IP always equals proxy IP | `TRUST_PROXY` configuration |
| uploads fail around proxy limits | use resumable/chunked upload flow |
| `413 file_too_large` | dashboard limit, `MAX_UPLOAD_SIZE`, Nginx body size |
| `csrf_failed` | `APP_URL`, CORS, request origin |
| files remain in `SCANNING` | worker and ClamAV connectivity |
| analytics are empty | analytics settings and worker roll-ups |
| encrypted settings become unreadable | verify the master encryption key and rotation config |

> [!CAUTION]
> Losing `MASTER_ENCRYPTION_KEY` can make encrypted configuration unrecoverable and can require API credentials to be re-issued. Back it up securely.

---

## Backups

Database backup tooling is documented in [docs/backups.md](docs/backups.md).

A complete backup plan should cover:

1. PostgreSQL;
2. file/object storage;
3. deployment configuration;
4. environment secrets;
5. `MASTER_ENCRYPTION_KEY`;
6. any previous encryption keys required during key rotation.

Database-only backups are **not** sufficient if your actual file data lives separately.

---

## Updating

Before an update:

```bash
./scripts/backup-postgres.sh
```

Then update and redeploy:

```bash
git pull
docker compose up -d --build
```

The migration service applies Prisma migrations before the application starts.

For image-based deployments, pull the new release/image according to your deployment tooling.

---

## Development

Install dependencies:

```bash
npm install
```

Configure local services:

```bash
cp .env.example .env
```

Generate Prisma and prepare the database:

```bash
npm run db:generate
npm run db:migrate
npm run db:seed
```

Build the shared packages where needed, then create an admin:

```bash
npm run build
npm run create-admin
```

Start the development stack:

```bash
npm run dev
```

Typical local services:

```text
web       :3000
api       :4000
worker    background process
```

### Useful commands

```bash
npm run build
npm run typecheck
npm run lint
npm test
npm run test:unit
npm run test:integration
```

---

## Testing

The test suite covers security and application behaviour including:

- login;
- CSRF;
- RBAC;
- API-key scopes;
- revoked and expired API keys;
- API-key IP restrictions;
- API-key endpoint restrictions;
- key rate limiting;
- key rotation;
- uploads;
- delivery;
- HEAD requests;
- Range requests;
- `304` responses;
- private files;
- signed-URL forgery;
- signed-URL expiry;
- path traversal;
- malformed IDs;
- chunked uploads;
- analytics;
- audit-log immutability.

GitHub Actions runs the automated checks before publishing application images.

---

## Contributing

Community development is welcome.

You are explicitly allowed to create a GitHub fork for genuine CDNPanel contribution work such as:

- fixes;
- feature proposals;
- documentation;
- tests;
- refactors;
- performance improvements;
- issue reproductions;
- code-review suggestions;
- pull requests.

Start by reading [CONTRIBUTING.md](CONTRIBUTING.md).

A community fork is **not** permission to create an independent CDNPanel product, mirror, resale, hosted service, rebrand, package distribution, or competing release.

If you find a bug, open an issue with enough detail to reproduce it.

If you have a code improvement, keep the change focused, add or update tests where practical, and explain why the change is useful.

---

## License

CDNPanel uses the **Cache Networks Source-Available Personal & Community Contribution License v2.0**.

This is a custom **source-available** license and is **not an open-source license**.

### At a glance

| Activity | Status |
|---|---|
| View the source | ✅ Allowed |
| Download for personal use | ✅ Allowed |
| Run privately for personal, non-commercial use | ✅ Allowed |
| Modify privately | ✅ Allowed |
| Fork on GitHub to contribute to CDNPanel | ✅ Allowed |
| Submit pull requests | ✅ Allowed |
| Maintain a public contribution fork | ✅ Allowed |
| Publish your own CDNPanel distribution | ❌ Not allowed |
| Rebrand CDNPanel as your own | ❌ Not allowed |
| Mirror it as another download source | ❌ Not allowed |
| Publish independent binaries/packages/containers | ❌ Not allowed |
| Use it for a business or organisation | ❌ Permission required |
| Sell or monetise it | ❌ Permission required |
| Offer it as a hosted/managed service | ❌ Permission required |
| Copy protected code into another distributed project | ❌ Permission required |
| Remove attribution from copied code | ❌ Not allowed |

### Attribution

Where permission exists to copy or adapt protected CDNPanel code, the license requires attribution substantially equivalent to:

```text
Contains code derived from CDNPanel by Cache Networks.
Original project: https://github.com/cachenetworks/CDNPanel
Licensed under the Cache Networks Source-Available Personal &
Community Contribution License.
```

Read the complete [LICENSE](LICENSE) before relying on any permission.

> [!NOTE]
> The license is intentionally restrictive about redistribution and commercial use while remaining friendly to genuine community contribution.

---

## Project status

CDNPanel is actively developed.

The project prioritises:

- security;
- predictable deployment;
- maintainability;
- self-hosting;
- transparent API behaviour;
- operational visibility;
- community-driven improvements without allowing unauthorised redistribution.

---

Built and maintained under **Cache Networks**.
