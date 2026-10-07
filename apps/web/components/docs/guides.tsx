import * as React from 'react';
import { CodeBlock } from './code';

/** Narrative documentation sections. Endpoint references are generated from the OpenAPI document. */
export interface Guide {
  id: string;
  title: string;
  /** Plain text used for search. */
  text: string;
  render: (ctx: { origin: string; scopes: Record<string, string>; errors: Record<string, { status: number; message: string }> }) => React.ReactNode;
}

const P = ({ children }: { children: React.ReactNode }) => <p className="mb-3 text-sm leading-6 text-muted-foreground">{children}</p>;
const H = ({ children }: { children: React.ReactNode }) => <h3 className="mb-2 mt-5 text-sm font-semibold">{children}</h3>;
const C = ({ children }: { children: React.ReactNode }) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-[12px] text-foreground">{children}</code>;

export const GUIDES: Guide[] = [
  {
    id: 'introduction',
    title: 'Introduction',
    text: 'REST API versioned base /api/v1 JSON request ids file delivery',
    render: ({ origin }) => (
      <>
        <P>
          The CDN exposes a versioned REST API at <C>{origin}/api/v1</C>. Requests and responses use JSON (uploads use <C>multipart/form-data</C>). Files are delivered from <C>{origin}/files/{'{file_id}'}</C> and, for public files, from friendly paths such as{' '}
          <C>{origin}/p/assets/logo.png</C>.
        </P>
        <P>
          Every response includes an <C>X-Request-Id</C> header; include it when reporting problems. The full machine-readable specification is available at <C>{origin}/openapi.json</C> (OpenAPI 3.1).
        </P>
        <P>Future versions will be served side by side under <C>/api/v2</C>; v1 will keep working until it is formally deprecated.</P>
      </>
    ),
  },
  {
    id: 'authentication',
    title: 'Authentication',
    text: 'API key bearer authorization header cdn_live cdn_test scopes create key secret shown once',
    render: ({ origin, scopes }) => (
      <>
        <P>
          Authenticate with an API key in the <C>Authorization</C> header using the Bearer scheme. Keys look like <C>cdn_live_…</C> (production) or <C>cdn_test_…</C>.
        </P>
        <CodeBlock language="shell" code={`curl ${origin}/api/v1/me \\\n  -H "Authorization: Bearer $CDN_API_KEY"`} />
        <H>Creating a key</H>
        <P>
          Staff with the <C>api_keys.create</C> permission create keys under <strong>API Keys</strong>. The full secret is displayed exactly once — only a keyed hash is stored, so it can never be retrieved again. Store it in a secrets manager and never
          embed it in client-side code.
        </P>
        <H>Scopes</H>
        <div className="mb-3 overflow-hidden rounded-md border">
          <table className="w-full text-[13px]">
            <tbody>
              {Object.entries(scopes).map(([s, d]) => (
                <tr key={s} className="border-b last:border-0">
                  <td className="w-44 px-3 py-1.5 font-mono text-xs">{s}</td>
                  <td className="px-3 py-1.5 text-muted-foreground">{d}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <P>Keys can additionally be restricted to IP addresses / CIDR ranges and to specific endpoint patterns, carry their own rate limit, and expire. Administrative endpoints (API keys, users, roles, settings…) require a staff session and cannot be called with an API key.</P>
      </>
    ),
  },
  {
    id: 'quick-start',
    title: 'Quick Start',
    text: 'quick start upload a file get url download curl',
    render: ({ origin }) => (
      <>
        <P>1. Create an API key with the <C>files:upload</C> and <C>files:read</C> scopes. 2. Upload a file:</P>
        <CodeBlock language="shell" code={`curl -X POST ${origin}/api/v1/files \\\n  -H "Authorization: Bearer $CDN_API_KEY" \\\n  -F "visibility=PUBLIC" \\\n  -F "file=@image.png"`} />
        <P>3. The response contains the file id and its CDN URL:</P>
        <CodeBlock language="json" code={`{\n  "id": "file_01J9Z8Q4X5K3W2V1T0S9R8Q7P6",\n  "name": "image.png",\n  "size": 384920,\n  "mime_type": "image/png",\n  "url": "${origin}/files/file_01J9Z8Q4X5K3W2V1T0S9R8Q7P6"\n}`} />
        <P>4. Public files can be embedded directly. For private files create a signed URL or download through the API with your key.</P>
      </>
    ),
  },
  {
    id: 'files',
    title: 'Files',
    text: 'files visibility public private authenticated signed url only range etag cache control content disposition head',
    render: () => (
      <>
        <P>Every file has a visibility level:</P>
        <ul className="mb-3 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          <li><C>PUBLIC</C> — served to anyone and cacheable by CDNs.</li>
          <li><C>AUTHENTICATED</C> — any valid API key, or a signed URL.</li>
          <li><C>PRIVATE</C> — API keys with <C>files:read</C>, or a signed URL.</li>
          <li><C>SIGNED_URL_ONLY</C> — only through an expiring signed URL.</li>
        </ul>
        <P>
          Delivery supports <C>HEAD</C>, <C>Range</C> requests (206) for video/audio and large files, <C>ETag</C> (the SHA-256), <C>Last-Modified</C>, <C>If-None-Match</C>/<C>If-Modified-Since</C> (304) and per-file <C>Cache-Control</C>. HTML, SVG, XML
          and other active content is always served as an attachment with a sandbox CSP so it cannot execute on your domain.
        </P>
      </>
    ),
  },
  {
    id: 'uploads',
    title: 'Uploads',
    text: 'upload multipart chunked resumable large file init chunk complete sha256 checksum',
    render: ({ origin }) => (
      <>
        <P>
          Small and medium files: <C>POST /api/v1/files</C> with <C>multipart/form-data</C>. Send option fields (<C>folder_id</C>, <C>visibility</C>, <C>sha256</C>…) <strong>before</strong> the <C>file</C> part, or as query parameters.
        </P>
        <P>Large files use the resumable chunk API. Chunks may be sent in any order and retried; on completion the server verifies the size and optional SHA-256.</P>
        <CodeBlock
          language="javascript"
          code={`const file = /* File or Blob */;\nconst headers = { Authorization: \`Bearer \${CDN_API_KEY}\` };\nconst init = await fetch('${origin}/api/v1/uploads/init', {\n  method: 'POST',\n  headers: { ...headers, 'Content-Type': 'application/json' },\n  body: JSON.stringify({ filename: file.name, size: file.size }),\n}).then((r) => r.json());\n\nfor (let i = 0; i < init.total_chunks; i++) {\n  const chunk = file.slice(i * init.chunk_size, (i + 1) * init.chunk_size);\n  await fetch(\`${origin}/api/v1/uploads/\${init.id}/chunk?index=\${i}\`, {\n    method: 'POST',\n    headers: { ...headers, 'Content-Type': 'application/octet-stream' },\n    body: chunk,\n  });\n}\n\nconst created = await fetch(\`${origin}/api/v1/uploads/\${init.id}/complete\`, { method: 'POST', headers }).then((r) => r.json());`}
        />
        <P>The real content type is detected from the file contents; names, extensions and browser-provided types are never trusted. Blocked extensions, allowed MIME types, size limits and quotas are configured by administrators.</P>
      </>
    ),
  },
  {
    id: 'folders',
    title: 'Folders',
    text: 'folders nested path friendly url visibility inheritance',
    render: () => (
      <P>
        Folders nest arbitrarily and define friendly URLs (<C>/p/images/icons/logo.png</C>). A folder may set a default visibility that new files inherit (walking up the tree). Deleting a non-empty folder requires <C>recursive=true</C>.
      </P>
    ),
  },
  {
    id: 'signed-urls',
    title: 'Signed URLs',
    text: 'signed url expires hmac signature expires_in disposition',
    render: ({ origin }) => (
      <>
        <P>Signed URLs grant temporary read access to a single file without credentials. They are signed with HMAC-SHA256 over the file id, expiry and disposition — changing any of them invalidates the signature.</P>
        <CodeBlock language="shell" code={`curl -X POST ${origin}/api/v1/files/file_01J…/signed-url \\\n  -H "Authorization: Bearer $CDN_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"expires_in": 300}'`} />
        <CodeBlock language="json" code={`{\n  "url": "${origin}/files/file_01J…?expires=1767225600&kv=1&disposition=inline&sig=…",\n  "expires_at": "2026-01-01T00:00:00.000Z",\n  "expires_in": 300\n}`} />
      </>
    ),
  },
  {
    id: 'api-keys',
    title: 'API Keys',
    text: 'api key management rotate revoke staff session',
    render: () => <P>API key management endpoints require a staff session with the matching permission (<C>api_keys.*</C>). Rotation issues a new secret with identical settings and can keep the old key valid for a grace period.</P>,
  },
  {
    id: 'analytics',
    title: 'Analytics',
    text: 'analytics bandwidth requests downloads period custom range',
    render: () => (
      <P>
        Analytics endpoints accept <C>period=24h|7d|30d|90d</C> or <C>period=custom&amp;from=…&amp;to=…</C> (ISO 8601). Ranges up to 3 days are bucketed hourly, longer ranges daily (UTC). They require <C>analytics:read</C>.
      </P>
    ),
  },
  {
    id: 'webhooks',
    title: 'Webhooks',
    text: 'webhooks events signature hmac sha256 retry file.uploaded file.deleted',
    render: () => (
      <>
        <P>
          Webhooks deliver <C>file.uploaded</C>, <C>file.updated</C>, <C>file.deleted</C>, <C>upload.failed</C>, <C>api_key.created</C> and <C>api_key.revoked</C> events as JSON <C>POST</C> requests. Failed deliveries are retried with exponential backoff (8
          attempts).
        </P>
        <P>
          Each request carries <C>X-CDN-Webhook-Id</C>, <C>X-CDN-Webhook-Timestamp</C>, <C>X-CDN-Event</C> and <C>X-CDN-Signature: t=&lt;ts&gt;,v1=&lt;hex&gt;</C> where the signature is HMAC-SHA256 of <C>{'"<ts>.<delivery id>.<raw body>"'}</C> with your webhook secret.
          Verify it and reject timestamps older than five minutes:
        </P>
        <CodeBlock
          language="javascript"
          code={`import crypto from 'node:crypto';\n\nfunction verify(req, rawBody, secret) {\n  const id = req.headers['x-cdn-webhook-id'];\n  const { t, v1 } = Object.fromEntries(req.headers['x-cdn-signature'].split(',').map((p) => p.split('=')));\n  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;\n  const expected = crypto.createHmac('sha256', secret).update(\`\${t}.\${id}.\${rawBody}\`).digest('hex');\n  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1));\n}`}
        />
      </>
    ),
  },
  {
    id: 'errors',
    title: 'Errors',
    text: 'errors codes json shape request_id status',
    render: ({ errors }) => (
      <>
        <P>Errors always have the same shape:</P>
        <CodeBlock language="json" code={`{\n  "error": {\n    "code": "file_not_found",\n    "message": "The requested file could not be found.",\n    "request_id": "req_01J…"\n  }\n}`} />
        <div className="overflow-hidden rounded-md border">
          <table className="w-full text-[13px]">
            <thead className="bg-subtle text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-1.5">Code</th>
                <th className="px-3 py-1.5">HTTP</th>
                <th className="px-3 py-1.5">Message</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(errors).map(([code, e]) => (
                <tr key={code} className="border-t">
                  <td className="px-3 py-1.5 font-mono text-xs">{code}</td>
                  <td className="px-3 py-1.5 tabular">{e.status}</td>
                  <td className="px-3 py-1.5 text-muted-foreground">{e.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>
    ),
  },
  {
    id: 'rate-limits',
    title: 'Rate Limits',
    text: 'rate limits 429 headers x-ratelimit retry-after pagination',
    render: () => (
      <>
        <P>Requests are limited globally, per IP, per API key (requests per minute, configurable per key) and per sensitive route. Every response includes:</P>
        <CodeBlock language="http" code={`X-RateLimit-Limit: 600\nX-RateLimit-Remaining: 598\nX-RateLimit-Reset: 1767225660`} />
        <P>
          When a limit is exceeded the API returns <C>429</C> with <C>rate_limited</C> and a <C>Retry-After</C> header.
        </P>
        <H>Pagination</H>
        <P>
          List endpoints accept <C>?page=1&amp;limit=50</C> and return a <C>pagination</C> object with <C>page</C>, <C>limit</C>, <C>total</C>, <C>total_pages</C> and <C>has_more</C>.
        </P>
      </>
    ),
  },
];
