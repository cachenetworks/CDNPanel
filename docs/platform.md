# CDNPanel 2.0 — Zones & Edge

This guide covers everything added in 2.0. Every feature is available in the dashboard, through
the REST API (`/api/v1/openapi.json`), the generated SDKs and the `cdnctl` CLI.

- [Upgrading from 1.x](#upgrading-from-1x)
- [Projects, zones and custom domains](#projects-zones-and-custom-domains)
- [Cache management](#cache-management)
- [Image optimisation](#image-optimisation)
- [Video and audio](#video-and-audio)
- [Replication and failover](#replication-and-failover)
- [Share links](#share-links)
- [Revisions, recycle bin and lifecycle rules](#revisions-recycle-bin-and-lifecycle-rules)
- [Edge security](#edge-security)
- [Passkeys and single sign-on](#passkeys-and-single-sign-on)
- [Usage, quotas and costs](#usage-quotas-and-costs)
- [Developer platform](#developer-platform)
- [Operations and observability](#operations-and-observability)
- [Asset Inspector and delivery map](#asset-inspector-and-delivery-map)
- [Supply chain](#supply-chain)

---

## Upgrading from 1.x

1. Pull the new images (or rebuild) and run the stack as usual. The `migrate` service applies
   `20261008000000_platform_v2`, which only **adds** tables and columns. Existing files, URLs,
   API keys and settings keep working unchanged.
2. New permissions (`zones.*`, `cache.purge`, `shares.manage`, `security.manage`, `usage.view`,
   `quotas.manage`, `ops.*`) are granted to the built-in roles by the migration. Custom roles keep
   their permissions — add the new ones in **Roles** if needed.
3. A project called **Default** is created. Create zones when you want per-folder delivery settings;
   files outside zones behave exactly like 1.x.
4. **Behaviour change:** `DELETE /api/v1/files/{id}` now moves files to the recycle bin (30 days by
   default, *Settings → Files*). Pass `?permanent=true` for the old behaviour, or set the retention to 0.
5. Optional: set `PANEL_HOST` (your dashboard hostname) to serve zone custom domains at bare paths,
   and `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ZONE_ID` for edge purges and cache statistics.

## Projects, zones and custom domains

```text
Project (Sentinel)
└── Zone (Sentinel assets) → root folder /sentinel-assets
    ├── Domains:  assets.sentinelbot.dev, media.sentinelbot.dev
    ├── Cache:    edge / browser TTLs, cache rules, Cloudflare credentials
    ├── Security: hotlink protection, geo / ASN blocks, WAF rules
    ├── Images & video, replication, upload rules (storage, size, MIME types)
    └── Usage & quotas
```

A **zone** binds a delivery configuration to a folder subtree. Every file below the zone root is
delivered with the zone's settings, on every URL form (`/files/{id}`, `/p/…`, `/img/…`, `/media/…`).

**Custom domains** (*Zones → zone → Domains → Add domain*):

1. Enter a hostname, e.g. `assets.example.com`.
2. Create a TXT record `_cdnpanel-challenge.assets.example.com` with the shown value.
3. Route the hostname to the server: a CNAME to the CDN host, or — with a Cloudflare Tunnel — a
   *public hostname* for `assets.example.com` pointing at the same service as the dashboard
   (`http://nginx:8080`). Cloudflare issues the certificate.
4. Click **Verify** (also retried automatically every 5 minutes for 7 days).

Once active, a health check fetches `https://<host>/.well-known/cdnpanel/<domain id>` through the
edge every 5 minutes, which proves DNS, routing and TLS end to end (`domain.unhealthy` webhook on
failure). With `PANEL_HOST` set, `https://assets.example.com/img/logo.png` serves
`<zone root>/img/logo.png`. A custom domain only ever serves its own zone's files.

**Project-bound API keys** (`project_id` when creating a key, or keys of a service account bound
to a project) can only see, upload to and modify files inside that project's zones. Uploads without
a folder land in the zone root.

## Cache management

- **Two TTLs.** Browsers get `Cache-Control: public, max-age=<browser TTL>`; CDNs get
  `CDN-Cache-Control: max-age=<edge TTL>`. Set them per zone and override them with **cache rules**
  (zone-relative globs: `/releases/**`, `*.css`; first match by priority wins; *bypass* disables edge caching).
- **Cache tags.** Every public response carries `Cache-Tag: file:<id>, folder:<id>, zone:<slug>,
  project:<id>` plus your own tags (`cache_tags` on upload / PATCH, e.g. `release:v2`).
- **Purges** (*Cache* page, `POST /api/v1/cache/purge`, `cdnctl purge`) by URL, file, folder, tag,
  zone or everything. With Cloudflare credentials they are executed through the Cloudflare API in
  the background (URL, tag, prefix and hostname purges); otherwise recorded as *origin only*.
- **Automatic invalidation** when a file is replaced, rolled back, renamed, moved, re-permissioned
  or deleted (*Settings → Cache → Purge automatically*).
- **Pre-warming**: fetch the most requested (or listed) URLs through the edge, on demand or every
  6 hours (*Settings → Cache*).
- **Statistics**: edge HIT / MISS / EXPIRED / BYPASS from Cloudflare analytics, plus origin outcomes
  (304 revalidations, image-variant hits and misses) from the request log.

## Image optimisation

```text
https://cdn.example.com/img/<file id>?w=800&h=600&fit=cover&format=auto&q=80&s=<signature>
```

| Parameter | Meaning |
|---|---|
| `w`, `h`, `dpr` | Size (CSS pixels × device pixel ratio). Never upscaled. |
| `fit`, `pos` | `cover` / `contain` / `fill` / `inside` / `outside`; crop position incl. `attention`, `entropy` |
| `format`, `q` | `auto` (AVIF / WebP by `Accept`), `webp`, `avif`, `jpeg`, `png`; quality 1–100 |
| `crop` | `x,y,w,h` region before resizing |
| `rotate`, `flip`, `flop`, `blur`, `sharpen`, `grayscale`, `bg` | Adjustments |
| `wm`, `wm_pos`, `wm_opacity`, `wm_scale` | Watermark with another library image |
| `keep_meta` | Keep EXIF / ICC (stripped by default — GPS included) |

Variants are generated once with libvips (sharp), stored next to the original and reused for every
request with the same content and parameters. Signatures (`s`) are required by default so clients
cannot create unlimited variants — create them with `POST /api/v1/images/sign`, the file panel's
*Image optimisation* section or `cdnctl image-url`. Source size is capped (*Settings → Images*).

## Video and audio

Enable *Video processing* on a zone (or for everything in *Settings → Video & audio*). The worker
runs FFmpeg (included in the API image) and produces:

| Rendition | Output |
|---|---|
| `thumbnail` | JPEG poster frame |
| `preview` | 6-second muted 360p MP4 |
| `mp4_h264`, `mp4_h265`, `webm_av1` | Progressive downloads |
| `hls` | Adaptive ladder (default 360p / 720p / 1080p, never upscaled) with a master playlist |
| `dash` | MPEG-DASH manifest and segments |
| `audio` | AAC extraction |
| `waveform` | PNG plus 1000 normalised peaks (JSON) |

Renditions are served from `/media/<file id>/<token>/<kind>/<object>`; the token is `pub` for public
files or a time-limited media token (`GET /api/v1/files/{id}/media`) so players can follow relative
segment URLs of private videos. The dashboard plays HLS with hls.js. `media.ready` fires when done.

## Replication and failover

Give storage providers a region, served countries and a priority (*Storage → edit provider*), then
choose replica providers and a strategy on a zone:

| Strategy | Reads |
|---|---|
| `PRIMARY_ONLY` | Primary provider only; replicas are backups |
| `MIRROR` | Primary; a replica if the primary read fails |
| `FAILOVER` | Healthy providers first (health checked every 2 minutes), then read-error failover |
| `NEAREST` | The healthy copy whose provider serves the visitor's country |

New uploads and revisions are copied in the background and verified by size; an hourly job
re-checks replicas, re-copies missing or stale ones and backfills files when a zone gains a replica
(`replication.failed` webhook after the last retry).

## Share links

From a file's panel (*Share*), `POST /api/v1/files/{id}/shares` or `cdnctl share`: a page at
`/s/<token>` with optional password, expiry, download limit, **download once then destroy**, IP /
country allowlists, email capture, title and message. Links work for private files without API keys,
are listed on the *Share Links* page with their access log, and can be revoked at any time.

## Revisions, recycle bin and lifecycle rules

- **Revisions**: upload new content to an existing file (`POST /api/v1/files/{id}/versions`); the
  id and URLs stay the same, the previous content is kept, and a rollback is one click (itself
  undoable). Old revisions are pruned beyond *Settings → Files → Revisions kept per file*.
- **Recycle bin**: deletes are restorable for the configured retention, then purged hourly.
- **Expiry**: `expires_in_days` on upload or `expires_at` on PATCH.
- **Lifecycle rules** (*Lifecycle Rules* page): for a zone, a folder subtree or everything — after N
  days since upload or last download, optionally filtered by MIME prefix — move to the recycle bin,
  delete, archive to a cold provider or move to another provider. Rules run daily; preview and run
  them on demand.

## Edge security

- **Zone restrictions**: hotlink protection (Referer allowlist, optional empty-Referer), country
  allow / block lists and ASN blocks (`ASN_HEADER`, e.g. from a Cloudflare transform rule).
- **Security rules** (*Security* page): all conditions must match — `ip` (CIDR), `country`, `asn`,
  `path`, `method`, `host`, `user_agent`, `referer`, `requests_per_minute` — then `BLOCK`,
  `CHALLENGE` (proof-of-work browser check), `BAN` (temporary IP ban), `ALLOW` or `LOG`. Use the
  built-in tester to dry-run a hypothetical request.
- **IP bans** apply to everything (dashboard, API, delivery), manual or automatic.
- **Automated API-key abuse response**: denied / blocked requests are counted per key; above the
  threshold (*Settings → Security*) the key is suspended (`api_key.suspended` webhook) until an
  administrator lifts the suspension.
- **Signed cookies** for protected collections: `POST /api/v1/signed-cookies` for a folder returns an
  `install_url` on the CDN host; afterwards plain URLs below that folder work until expiry.

## Passkeys and single sign-on

- **Passkeys** (*Account → Passkeys*): WebAuthn with user verification; satisfies 2FA on its own.
- **SSO** (*Settings → Single sign-on*): Google, GitHub, Discord or any OpenID Connect provider
  (authorization code + PKCE). Existing staff are matched by **verified** email; optionally restrict
  email domains and auto-provision new staff with a default role. Accounts with TOTP still complete
  their code. Staff can link / unlink identities on their account page.
- *Settings → Authentication → Allow password sign-in* can be turned off; staff who have no passkey
  or SSO identity yet can still use their password, so nobody is locked out.

## Usage, quotas and costs

*Usage & Costs* shows month-to-date storage, egress, requests, image transformations (with CPU
time) and uploads for the platform, every project and every zone, plus cost estimates from the
prices set on each storage provider. **Quotas** (platform, project, zone or API key) alert at
configurable thresholds (`quota.threshold` webhook + audit log); **hard** quotas block further
delivery or uploads with `quota_exceeded`.

## Developer platform

- **SDKs** generated from the OpenAPI document (`npm run sdk:generate`; CI fails if they drift):
  - TypeScript / JavaScript — `packages/sdk-js` (`@cachenetworks/cdnpanel-sdk`), with
    `uploadFile()` switching to resumable chunked uploads automatically.
  - Python — `sdks/python` (standard library only), with `upload_path()`.
  - Go — `sdks/go`.
- **cdnctl** — `packages/cli`:

  ```bash
  cdnctl login --url https://cdn.example.com --key cdn_live_…
  cdnctl upload ./dist/*.js --folder fld_… --public --tags release:v2
  cdnctl purge tag release:v2
  cdnctl signed-url file_… --expires 600
  cdnctl zones create prj_… "Sentinel assets"
  cdnctl zones domain-add zon_… assets.example.com
  ```

- **Service accounts** own API keys for machines; disabling one disables all its keys.
  **API key templates** pre-fill scopes, limits and lifetimes.
- **Webhooks**: replay any delivery, send realistic sample payloads for every event, and scope a
  webhook to one project.

## Operations and observability

- *Operations* page: API / delivery latency p50 / p95 / p99, per-minute throughput, PostgreSQL and
  Redis health, storage-provider health and latency, worker heartbeat, webhook backlog, quarantined
  files, and every background queue (file processing, webhooks, media, replication, edge,
  maintenance) — inspect jobs, retry or remove them, retry all failures, pause / resume queues.
- **Prometheus**: `GET /metrics` on the API (`api:4000/metrics` inside the compose network, or with
  `Authorization: Bearer $METRICS_TOKEN`). Includes request histograms, active transfers, delivered
  bytes, cache outcomes, queue depth, dependency health, storage health, webhook backlog.
- **OpenTelemetry**: set `OTEL_EXPORTER_OTLP_ENDPOINT` to export traces (HTTP server / client incl.
  S3 and webhooks, Redis) from the API and the worker.

## Asset Inspector and delivery map

- *Asset Inspector*: paste any CDN URL — see the matched host and zone, file, edge-security decision
  for a chosen country / referer, authorization path, signature validity, transformation, storage
  source and failover order, cache policy, predicted headers, and optionally a live request through
  the edge with real headers and timing.
- *Analytics → Global delivery*: an interactive map of requests by visitor country with animated
  flows from storage origins (placed by each provider's first served country).

## Supply chain

The `CI & images` workflow runs typecheck, lint, unit + integration tests (incl. FFmpeg), a
backup → restore round trip, migration checks (fresh install, upgrade from the previous release,
schema drift), SDK drift checks, `npm audit`, and `nginx -t`. Images are scanned with Trivy (build
fails on fixable critical issues), pushed with an SBOM and maximal provenance, signed with Cosign
(keyless) and attested. CodeQL, dependency review and Dependabot run alongside; tagged releases
publish generated release notes with the SDKs, CLI and OpenAPI document.

Verify an image signature:

```bash
cosign verify ghcr.io/cachenetworks/cdnpanel-api:latest \
  --certificate-identity-regexp 'https://github.com/cachenetworks/CDNPanel/.github/workflows/docker.yml@.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
gh attestation verify oci://ghcr.io/cachenetworks/cdnpanel-api:latest --owner cachenetworks
```
