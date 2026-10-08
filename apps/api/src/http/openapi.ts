import { zodToJsonSchema } from 'zod-to-json-schema';
import { z, type ZodTypeAny } from 'zod';
import { API_SCOPES, ERROR_CATALOG, PERMISSIONS, type ErrorCode } from '@cdn/shared';
import { env } from '../config/env.js';
import type { RouteDef } from './route.js';
import { ALL_ROUTES } from '../routes/index.js';

type JsonSchema = Record<string, unknown>;

function toSchema(schema: ZodTypeAny): JsonSchema {
  const out = zodToJsonSchema(schema, { target: 'openApi3', $refStrategy: 'none' }) as JsonSchema;
  delete out.$schema;
  return out;
}

function unwrapObject(schema: ZodTypeAny | undefined): z.ZodObject<z.ZodRawShape> | null {
  let s: ZodTypeAny | undefined = schema;
  while (s) {
    if (s instanceof z.ZodObject) return s;
    if (s instanceof z.ZodEffects) s = s.innerType();
    else if (s instanceof z.ZodDefault || s instanceof z.ZodOptional) s = s._def.innerType;
    else return null;
  }
  return null;
}

function parametersFor(schema: ZodTypeAny | undefined, location: 'path' | 'query') {
  const obj = unwrapObject(schema);
  if (!obj) return [];
  return Object.entries(obj.shape).map(([name, field]) => {
    const json = toSchema(field as ZodTypeAny);
    const description = (field as ZodTypeAny).description ?? (json.description as string | undefined);
    delete json.description;
    return {
      name,
      in: location,
      required: location === 'path' ? true : !(field as ZodTypeAny).isOptional(),
      ...(description ? { description } : {}),
      schema: json,
    };
  });
}

/** Builds a representative example value from a JSON schema (used for docs + code samples). */
function exampleFromSchema(schema: JsonSchema | undefined, depth = 0): unknown {
  if (!schema || depth > 4) return undefined;
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if (schema.const !== undefined) return schema.const;
  const anyOf = (schema.anyOf ?? schema.oneOf) as JsonSchema[] | undefined;
  if (anyOf?.length) return exampleFromSchema(anyOf.find((s) => s.type !== 'null') ?? anyOf[0], depth + 1);
  const type = Array.isArray(schema.type) ? (schema.type as string[]).find((t) => t !== 'null') : (schema.type as string | undefined);
  switch (type) {
    case 'object': {
      const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(props)) {
        const ex = exampleFromSchema(v, depth + 1);
        if (ex !== undefined) out[k] = ex;
      }
      return out;
    }
    case 'array': {
      const item = exampleFromSchema(schema.items as JsonSchema, depth + 1);
      return item === undefined ? [] : [item];
    }
    case 'string':
      if (schema.format === 'date-time') return '2026-12-31T23:59:59.000Z';
      if (schema.format === 'email') return 'user@example.com';
      if (schema.format === 'uri') return 'https://hooks.example.com/cdn';
      return 'string';
    case 'integer':
    case 'number':
      return typeof schema.minimum === 'number' ? schema.minimum : 1;
    case 'boolean':
      return false;
    default:
      return undefined;
  }
}

function errorExample(code: ErrorCode) {
  return { error: { code, message: ERROR_CATALOG[code].message, request_id: 'req_01J9Z8Q4X5K3W2V1T0S9R8Q7P6' } };
}

function openApiPath(url: string): string {
  if (url === '/p/*') return '/p/{path}';
  return url.replace(/:([A-Za-z_]+)/g, '{$1}');
}

function exampleUrl(base: string, url: string): string {
  return `${base}${url
    .replace('/p/*', '/p/assets/logo.png')
    .replace(':id', '{id}'.replace('{id}', url.includes('/files/') ? 'file_01J9Z8Q4X5K3W2V1T0S9R8Q7P6' : url.includes('/folders/') ? 'fld_01J9Z8Q4X5K3W2V1T0S9R8Q7P6' : url.includes('/uploads/') ? 'upl_01J9Z8Q4X5K3W2V1T0S9R8Q7P6' : url.includes('/api-keys/') ? 'key_01J9Z8Q4X5K3W2V1T0S9R8Q7P6' : 'ID'))
    .replace(/:([A-Za-z_]+)/g, '{$1}')}`;
}

/** curl / JavaScript / Node.js / Python samples for every endpoint. */
function codeSamples(def: RouteDef, body: unknown): { lang: string; label: string; source: string }[] {
  const e = env();
  const base = def.tag === 'Delivery' ? e.CDN_URL : e.API_URL;
  const url = exampleUrl(base, def.url);
  const auth = def.auth !== 'public';
  const jsonBody = body !== undefined && def.method !== 'GET' && def.method !== 'DELETE' ? JSON.stringify(body, null, 2) : null;
  const curl: string[] = [`curl -X ${def.method} "${url}"`];
  if (auth) curl.push(`  -H "Authorization: Bearer $CDN_API_KEY"`);
  if (def.multipart) {
    curl.push(`  -F "file=@image.png"`);
    for (const f of def.multipart.filter((m) => m.type !== 'file' && m.name === 'folder_id')) curl.push(`  -F "${f.name}=fld_01J9Z8Q4X5K3W2V1T0S9R8Q7P6"`);
  } else if (def.rawBody) {
    curl.push(`  -H "Content-Type: application/octet-stream"`, `  --data-binary @chunk.bin`);
  } else if (jsonBody) {
    curl.push(`  -H "Content-Type: application/json"`, `  -d '${JSON.stringify(body)}'`);
  }

  const headers = auth ? `{ Authorization: \`Bearer \${CDN_API_KEY}\`${jsonBody ? ", 'Content-Type': 'application/json'" : ''} }` : jsonBody ? "{ 'Content-Type': 'application/json' }" : '{}';
  let js: string;
  let node: string;
  let py: string;
  if (def.multipart) {
    js = `const form = new FormData();\nform.append('folder_id', 'fld_01J9Z8Q4X5K3W2V1T0S9R8Q7P6');\nform.append('file', fileInput.files[0]);\n\nconst res = await fetch('${url}', {\n  method: '${def.method}',\n  headers: { Authorization: \`Bearer \${CDN_API_KEY}\` },\n  body: form,\n});\nconst data = await res.json();`;
    node = `import { openAsBlob } from 'node:fs';\n\nconst form = new FormData();\nform.append('file', await openAsBlob('./image.png'), 'image.png');\n\nconst res = await fetch('${url}', {\n  method: '${def.method}',\n  headers: { Authorization: \`Bearer \${process.env.CDN_API_KEY}\` },\n  body: form,\n});\nif (!res.ok) throw new Error((await res.json()).error.message);\nconsole.log(await res.json());`;
    py = `import os, requests\n\nwith open("image.png", "rb") as fh:\n    res = requests.${def.method.toLowerCase()}(\n        "${url}",\n        headers={"Authorization": f"Bearer {os.environ['CDN_API_KEY']}"},\n        files={"file": ("image.png", fh)},\n    )\nres.raise_for_status()\nprint(res.json())`;
  } else if (def.rawBody) {
    js = `const res = await fetch('${url}', {\n  method: 'POST',\n  headers: { Authorization: \`Bearer \${CDN_API_KEY}\`, 'Content-Type': 'application/octet-stream' },\n  body: file.slice(start, end),\n});`;
    node = `import { readFile } from 'node:fs/promises';\n\nconst chunk = await readFile('./chunk.bin');\nconst res = await fetch('${url}', {\n  method: 'POST',\n  headers: { Authorization: \`Bearer \${process.env.CDN_API_KEY}\`, 'Content-Type': 'application/octet-stream' },\n  body: chunk,\n});\nconsole.log(await res.json());`;
    py = `import os, requests\n\nwith open("chunk.bin", "rb") as fh:\n    res = requests.post(\n        "${url}",\n        headers={"Authorization": f"Bearer {os.environ['CDN_API_KEY']}", "Content-Type": "application/octet-stream"},\n        data=fh,\n    )\nprint(res.json())`;
  } else {
    const fetchBody = jsonBody ? `,\n  body: JSON.stringify(${jsonBody.replace(/\n/g, '\n  ')})` : '';
    js = `const res = await fetch('${url}', {\n  method: '${def.method}',\n  headers: ${headers}${fetchBody},\n});\nconst data = ${def.method === 'DELETE' ? 'res.status === 204 ? null : ' : ''}await res.json();`;
    node = `const res = await fetch('${url}', {\n  method: '${def.method}',\n  headers: ${headers.replace('${CDN_API_KEY}', '${process.env.CDN_API_KEY}')}${fetchBody},\n});\nif (!res.ok) {\n  const { error } = await res.json();\n  throw new Error(\`\${error.code}: \${error.message}\`);\n}\n${def.method === 'DELETE' ? '' : 'console.log(await res.json());'}`;
    const pyJson = jsonBody ? `,\n    json=${JSON.stringify(body, null, 4).replace(/\n/g, '\n    ').replace(/\btrue\b/g, 'True').replace(/\bfalse\b/g, 'False').replace(/\bnull\b/g, 'None')}` : '';
    py = `import os, requests\n\nres = requests.${def.method.toLowerCase()}(\n    "${url}"${auth ? `,\n    headers={"Authorization": f"Bearer {os.environ['CDN_API_KEY']}"}` : ''}${pyJson},\n)\nres.raise_for_status()${def.method === 'DELETE' ? '' : '\nprint(res.json())'}`;
  }
  return [
    { lang: 'shell', label: 'curl', source: curl.join(' \\\n') },
    { lang: 'javascript', label: 'JavaScript', source: js },
    { lang: 'javascript', label: 'Node.js', source: node },
    { lang: 'python', label: 'Python', source: py },
  ];
}

const TAG_DESCRIPTIONS: Record<string, string> = {
  Account: 'Identify the authenticated principal.',
  Authentication: 'Staff sign-in, sessions, step-up re-authentication and two-factor authentication. Cookie based; used by the dashboard.',
  Files: 'List, search, inspect, update, move, copy, download and delete files.',
  Uploads: 'Multipart and chunked / resumable uploads.',
  Folders: 'Nested folders with default visibility and role restrictions.',
  'Signed URLs': 'Time-limited, HMAC-signed links to files.',
  Analytics: 'Requests, bandwidth, downloads, errors and breakdowns.',
  'API Keys': 'Administrative API key management (staff session required).',
  Users: 'Staff account management (staff session required).',
  Roles: 'Role-based access control (staff session required).',
  Security: 'Security events and session control (staff session required).',
  'Audit Logs': 'Immutable audit trail (staff session required).',
  Settings: 'Runtime settings (staff session required).',
  Storage: 'Storage statistics and providers (staff session required).',
  Webhooks: 'Signed event notifications (staff session required).',
  Dashboard: 'Dashboard aggregates (staff session required).',
  Delivery: 'CDN file delivery endpoints served from the CDN origin.',
  Health: 'Liveness and readiness probes.',
  Zones: 'Projects, CDN zones, custom domains and replication.',
  Cache: 'Cache rules, purges, pre-warming and cache statistics.',
  Images: 'On-the-fly image optimisation with signed transformation URLs.',
  Media: 'Video / audio renditions: thumbnails, previews, MP4, HLS / DASH, waveforms.',
  Shares: 'Human-friendly share links with passwords, expiry and download limits.',
  Versions: 'File revisions, rollback and the recycle bin.',
  Lifecycle: 'Automatic expiry, archiving and storage tiering rules.',
  'Edge Security': 'WAF-style security rules, IP bans and signed access cookies.',
  'Single Sign-On': 'Passkeys (WebAuthn) and OIDC / Google / GitHub / Discord sign-in.',
  Usage: 'Usage metering, quotas and cost estimates.',
  'Service Accounts': 'Machine identities and API key templates.',
  Operations: 'Operational metrics, background job queues and the asset inspector.',
};

export function buildOpenApiDocument(routes: RouteDef[] = ALL_ROUTES as RouteDef[]) {
  const e = env();
  const paths: Record<string, Record<string, unknown>> = {};
  for (const def of routes) {
    if (def.hidden) continue;
    const p = openApiPath(def.url);
    const method = def.method.toLowerCase();
    const parameters = [...parametersFor(def.params, 'path'), ...parametersFor(def.query, 'query')];
    if (def.url === '/p/*') parameters.unshift({ name: 'path', in: 'path', required: true, description: 'Folder path and file slug, e.g. assets/logo.png', schema: { type: 'string' } });

    const bodySchema = def.body ? toSchema(def.body) : undefined;
    const bodyExample = def.bodyExample ?? (bodySchema ? exampleFromSchema(bodySchema) : undefined);
    let requestBody: unknown;
    if (def.multipart) {
      requestBody = {
        required: true,
        content: {
          'multipart/form-data': {
            schema: {
              type: 'object',
              required: def.multipart.filter((m) => m.required).map((m) => m.name),
              properties: Object.fromEntries(
                def.multipart.map((m) => [
                  m.name,
                  { type: m.type === 'file' ? 'string' : m.type, ...(m.type === 'file' ? { format: 'binary' } : {}), description: m.description, ...(m.enum ? { enum: m.enum } : {}) },
                ]),
              ),
            },
          },
        },
      };
    } else if (def.rawBody) {
      requestBody = { required: true, description: def.rawBody.description, content: { [def.rawBody.contentType]: { schema: { type: 'string', format: 'binary' } } } };
    } else if (bodySchema) {
      requestBody = { required: true, content: { 'application/json': { schema: bodySchema, example: bodyExample } } };
    }

    const responses: Record<string, unknown> = {};
    for (const [status, r] of Object.entries(def.responses ?? { 200: { description: 'Success' } })) {
      const ct = r.contentType ?? 'application/json';
      responses[status] = {
        description: r.description,
        ...(status === '204' || status === '304' ? {} : { content: { [ct]: r.example !== undefined ? { example: r.example } : { schema: ct === 'application/json' ? { type: 'object' } : { type: 'string', format: 'binary' } } } }),
      };
    }
    const errors = new Set<ErrorCode>(def.errors ?? []);
    if (def.auth !== 'public') errors.add('unauthenticated');
    if (def.auth === 'any') ['invalid_api_key', 'api_key_revoked', 'api_key_expired', 'insufficient_scope'].forEach((c) => errors.add(c as ErrorCode));
    if (def.permission) errors.add('forbidden');
    if (def.auth === 'session' && def.method !== 'GET') errors.add('csrf_failed');
    errors.add('rate_limited');
    const byStatus = new Map<number, ErrorCode[]>();
    for (const code of errors) {
      const st = ERROR_CATALOG[code].status;
      byStatus.set(st, [...(byStatus.get(st) ?? []), code]);
    }
    for (const [st, codes] of byStatus) {
      if (responses[st]) continue;
      responses[st] = {
        description: `Error: ${codes.join(', ')}`,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/Error' },
            examples: Object.fromEntries(codes.map((c) => [c, { value: errorExample(c) }])),
          },
        },
      };
    }

    const perms = def.permission ? (Array.isArray(def.permission) ? def.permission : [def.permission]) : [];
    const scopes = def.scope ? (Array.isArray(def.scope) ? def.scope : [def.scope]) : [];
    const security =
      def.auth === 'public'
        ? []
        : def.auth === 'session'
          ? [{ cookieAuth: [] }]
          : [{ bearerAuth: scopes }, { cookieAuth: [] }];

    paths[p] ??= {};
    paths[p][method] = {
      operationId: `${method}_${p.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '')}`,
      tags: [def.tag],
      summary: def.summary,
      description: def.description ?? def.summary,
      security,
      parameters,
      ...(requestBody ? { requestBody } : {}),
      responses,
      'x-auth-mode': def.auth,
      'x-required-permissions': perms,
      'x-required-scopes': scopes,
      ...(def.requireReauth ? { 'x-requires-reauthentication': true } : {}),
      ...(def.rateLimit ? { 'x-rate-limit': { max: def.rateLimit.max, window_seconds: def.rateLimit.windowSeconds } } : {}),
      'x-codeSamples': codeSamples(def, bodyExample),
    };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'CDN Platform API',
      version: '1.0.0',
      description:
        'REST API for the self-hosted CDN. Authenticate with `Authorization: Bearer <API key>`. All errors use the shape `{ "error": { "code", "message", "request_id" } }`. Every response carries an `X-Request-Id` header.',
    },
    servers: [
      { url: e.API_URL, description: 'API' },
      ...(e.CDN_URL !== e.API_URL ? [{ url: e.CDN_URL, description: 'CDN delivery origin' }] : []),
    ],
    tags: Object.entries(TAG_DESCRIPTIONS).map(([name, description]) => ({ name, description })),
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'cdn_live_… / cdn_test_…', description: 'API key passed as a bearer token.' },
        cookieAuth: { type: 'apiKey', in: 'cookie', name: e.cookieSecure ? '__Host-cdn_session' : 'cdn_session', description: 'Staff dashboard session (requires X-CSRF-Token on state-changing requests).' },
      },
      schemas: {
        Error: {
          type: 'object',
          required: ['error'],
          properties: {
            error: {
              type: 'object',
              required: ['code', 'message'],
              properties: {
                code: { type: 'string', enum: Object.keys(ERROR_CATALOG) },
                message: { type: 'string' },
                request_id: { type: 'string' },
                details: {},
              },
            },
          },
        },
        Pagination: {
          type: 'object',
          properties: { page: { type: 'integer' }, limit: { type: 'integer' }, total: { type: 'integer' }, total_pages: { type: 'integer' }, has_more: { type: 'boolean' } },
        },
      },
    },
    'x-scopes': API_SCOPES,
    'x-permissions': PERMISSIONS,
    'x-errors': Object.fromEntries(Object.entries(ERROR_CATALOG).map(([k, v]) => [k, v])),
    'x-rate-limits': {
      headers: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset', 'Retry-After'],
      description: 'Limits apply globally, per IP, per API key (requests/minute, configurable per key) and per route.',
    },
  };
}
