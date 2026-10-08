#!/usr/bin/env node
/**
 * cdnctl — command-line client for CDNPanel.
 *
 * Credentials: CDN_URL + CDN_API_KEY environment variables, or `cdnctl login` (stored in
 * ~/.config/cdnctl/config.json with 0600 permissions).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { CdnApiError, CdnClient } from '@cachenetworks/cdnpanel-sdk';

const HELP = `cdnctl — CDNPanel command-line client

Usage: cdnctl <command> [options]

  login --url <url> --key <api key>        Save credentials
  whoami                                   Show the authenticated API key
  files list [--folder <id>] [--q <text>] [--tag <tag>] [--limit n]
  files get <file id>
  files rm <file id...> [--permanent]      Move to the recycle bin (or delete)
  files restore <file id>
  upload <path...> [--folder <id>] [--public] [--tags a,b] [--expires-days n]
  signed-url <file id> [--expires <seconds>] [--download]
  image-url <file id> [--w n] [--h n] [--format webp|avif|auto] [--q n] [--fit cover]
  share <file id> [--password p] [--expires <seconds>] [--once] [--max n]
  purge <url|file|folder|tag|zone|everything> [targets...] [--zone <id>]
  prewarm [--top n] [--zone <id>] [url...]
  zones list
  zones get <zone id>
  zones create <project id> <name>
  zones domain-add <zone id> <hostname>
  zones verify <domain id>
  usage [--zone <id> | --project <id>]
  versions <file id>
  versions upload <file id> <path>

Global options: --json (raw JSON output), --url, --key
`;

interface Config {
  url?: string;
  key?: string;
}

const configPath = path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'cdnctl', 'config.json');

function loadConfig(): Config {
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8')) as Config;
  } catch {
    return {};
  }
}

function die(msg: string, code = 1): never {
  process.stderr.write(`cdnctl: ${msg}\n`);
  process.exit(code);
}

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    json: { type: 'boolean' },
    url: { type: 'string' },
    key: { type: 'string' },
    folder: { type: 'string' },
    q: { type: 'string' },
    tag: { type: 'string' },
    tags: { type: 'string' },
    limit: { type: 'string' },
    permanent: { type: 'boolean' },
    public: { type: 'boolean' },
    expires: { type: 'string' },
    'expires-days': { type: 'string' },
    download: { type: 'boolean' },
    w: { type: 'string' },
    h: { type: 'string' },
    format: { type: 'string' },
    fit: { type: 'string' },
    password: { type: 'string' },
    once: { type: 'boolean' },
    max: { type: 'string' },
    zone: { type: 'string' },
    project: { type: 'string' },
    top: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

function client(): CdnClient {
  const cfg = loadConfig();
  const url = opts.url ?? process.env.CDN_URL ?? cfg.url;
  const key = opts.key ?? process.env.CDN_API_KEY ?? cfg.key;
  if (!url || !key) die('not configured: run `cdnctl login --url <url> --key <api key>` or set CDN_URL and CDN_API_KEY');
  return new CdnClient({ baseUrl: url, apiKey: key, userAgent: 'cdnctl/2.0' });
}

function out(data: unknown, table?: () => void): void {
  if (opts.json || !table) process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  else table();
}

function formatBytes(n: number): string {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1);
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}

function printTable(rows: string[][]): void {
  if (rows.length === 0) return;
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length)));
  for (const r of rows) process.stdout.write(`${r.map((c, i) => c.padEnd(widths[i]!)).join('  ').trimEnd()}\n`);
}

async function main(): Promise<void> {
  const [cmd, sub, ...rest] = positionals;
  if (!cmd || opts.help) {
    process.stdout.write(HELP);
    return;
  }
  if (cmd === 'login') {
    if (!opts.url || !opts.key) die('login requires --url and --key');
    const me = await new CdnClient({ baseUrl: opts.url, apiKey: opts.key }).identifyTheCaller();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ url: opts.url, key: opts.key }, null, 2), { mode: 0o600 });
    process.stdout.write(`Saved credentials for ${me.api_key?.name ?? 'API key'} to ${configPath}\n`);
    return;
  }
  const cdn = client();
  switch (cmd) {
    case 'whoami':
      return out(await cdn.identifyTheCaller());
    case 'files': {
      if (sub === 'list' || !sub) {
        const res = await cdn.listAndSearchFiles({ query: { folder_id: opts.folder, q: opts.q, tag: opts.tag, limit: opts.limit ?? 50 } });
        return out(res, () => printTable([['ID', 'NAME', 'SIZE', 'VISIBILITY', 'CREATED'], ...res.data.map((f: any) => [f.id, f.name, formatBytes(f.size), f.visibility, f.created_at.slice(0, 10)])]));
      }
      if (sub === 'get') return out(await cdn.getAFile(rest[0] ?? die('file id required')));
      if (sub === 'rm') {
        for (const id of rest) await cdn.deleteAFile(id, { query: { permanent: opts.permanent ? 'true' : 'false' } });
        process.stdout.write(`${opts.permanent ? 'Deleted' : 'Moved to the recycle bin'}: ${rest.length} file(s)\n`);
        return;
      }
      if (sub === 'restore') return out(await cdn.restoreAFileFromTheRecycleBin(rest[0] ?? die('file id required'), { body: {} }));
      return die(`unknown files command: ${sub}`);
    }
    case 'upload': {
      const files = [sub, ...rest].filter((x): x is string => Boolean(x));
      if (!files.length) die('upload requires at least one path');
      for (const p of files) {
        const data = new Blob([fs.readFileSync(p)]);
        let last = 0;
        const f = await cdn.uploadFile(data, path.basename(p), {
          folderId: opts.folder,
          visibility: opts.public ? 'PUBLIC' : undefined,
          cacheTags: opts.tags?.split(',').map((t) => t.trim()).filter(Boolean),
          expiresInDays: opts['expires-days'] ? Number(opts['expires-days']) : undefined,
          onProgress: (u, t) => {
            const pct = Math.floor((u / t) * 100);
            if (process.stderr.isTTY && pct !== last) process.stderr.write(`\r${path.basename(p)} ${pct}%`);
            last = pct;
          },
        });
        if (process.stderr.isTTY) process.stderr.write('\r\x1b[K');
        out(f, () => process.stdout.write(`${f.id}  ${f.url}\n`));
      }
      return;
    }
    case 'signed-url': {
      const res = await cdn.createASignedUrl(sub ?? die('file id required'), { body: { expires_in: opts.expires ? Number(opts.expires) : undefined, disposition: opts.download ? 'attachment' : 'inline' } });
      return out(res, () => process.stdout.write(`${res.url}\n`));
    }
    case 'image-url': {
      const params: Record<string, string | number> = {};
      for (const k of ['w', 'h', 'format', 'q', 'fit'] as const) if (opts[k]) params[k] = /^\d+$/.test(opts[k]!) ? Number(opts[k]) : opts[k]!;
      const res = await cdn.signAnImageTransformationUrl({ body: { file_id: sub ?? die('file id required'), params } });
      return out(res, () => process.stdout.write(`${res.url}\n`));
    }
    case 'share': {
      const res = await cdn.createAShareLink(sub ?? die('file id required'), {
        body: {
          ...(opts.password ? { password: opts.password } : {}),
          ...(opts.expires ? { expires_in: Number(opts.expires) } : {}),
          ...(opts.max ? { max_downloads: Number(opts.max) } : {}),
          one_time: Boolean(opts.once),
        },
      });
      return out(res, () => process.stdout.write(`${res.url}\n`));
    }
    case 'purge': {
      const type = sub ?? die('purge type required (url, file, folder, tag, zone, everything)');
      const res = await cdn.purgeTheCdnCache({ body: { type, targets: rest, ...(opts.zone ? { zone_id: opts.zone } : {}) } });
      return out(res, () => process.stdout.write(`Purge ${res.id} queued (${type}${rest.length ? `: ${rest.length} target(s)` : ''})\n`));
    }
    case 'prewarm': {
      const urls = [sub, ...rest].filter((x): x is string => Boolean(x));
      const res = await cdn.preWarmTheEdgeCache({ body: { ...(urls.length ? { urls } : { top: Number(opts.top ?? 50) }), ...(opts.zone ? { zone_id: opts.zone } : {}) } });
      return out(res, () => process.stdout.write(`Pre-warming ${res.urls} URL(s)\n`));
    }
    case 'zones': {
      if (sub === 'list' || !sub) {
        const res = await cdn.listZones();
        return out(res, () =>
          printTable([['ID', 'NAME', 'ROOT', 'DOMAINS'], ...res.data.map((z: any) => [z.id, z.name, z.root_folder?.path ?? '/', (z.domains ?? []).map((d: any) => `${d.hostname}${d.status === 'ACTIVE' ? '' : ` (${d.status.toLowerCase()})`}`).join(', ')])]),
        );
      }
      if (sub === 'get') return out(await cdn.getAZone(rest[0] ?? die('zone id required')));
      if (sub === 'create') return out(await cdn.createAZone({ body: { project_id: rest[0] ?? die('project id required'), name: rest[1] ?? die('zone name required') } }));
      if (sub === 'domain-add') {
        const d = await cdn.addACustomDomain(rest[0] ?? die('zone id required'), { body: { hostname: rest[1] ?? die('hostname required') } });
        return out(d, () => process.stdout.write(`Added ${d.hostname} (${d.id}). Create these DNS records, then run \`cdnctl zones verify ${d.id}\`:\n  TXT   ${d.verification.txt.name}  ${d.verification.txt.value}\n  CNAME ${d.verification.cname.name}  ${d.verification.cname.target}\n`));
      }
      if (sub === 'verify') {
        const r = await cdn.verifyADomain(rest[0] ?? die('domain id required'));
        return out(r, () => process.stdout.write(`${r.domain.hostname}: ${r.domain.status} · TLS ${r.domain.tls_status} · health ${r.domain.health_status}${r.domain.last_error ? `\n  ${r.domain.last_error}` : ''}\n`));
      }
      return die(`unknown zones command: ${sub}`);
    }
    case 'usage': {
      const query = opts.zone ? { scope_type: 'zone', scope_id: opts.zone } : opts.project ? { scope_type: 'project', scope_id: opts.project } : { scope_type: 'global' };
      const res = await cdn.usageForAScope({ query });
      return out(res, () =>
        printTable([
          ['METRIC', 'VALUE'],
          ['storage', formatBytes(res.usage.storage_bytes)],
          ['egress', formatBytes(res.usage.egress_bytes)],
          ['requests', String(res.usage.requests)],
          ['transforms', String(res.usage.transforms)],
          ['uploaded', formatBytes(res.usage.upload_bytes)],
          ['est. cost', `${res.cost.total} ${res.cost.currency}`],
        ]),
      );
    }
    case 'versions': {
      if (sub === 'upload') {
        const form = new FormData();
        form.append('file', new Blob([fs.readFileSync(rest[1] ?? die('path required'))]), path.basename(rest[1]!));
        return out(await cdn.uploadANewRevision(rest[0] ?? die('file id required'), { form }));
      }
      const res = await cdn.listFileRevisions(sub ?? die('file id required'));
      return out(res, () => printTable([['VERSION', 'NAME', 'SIZE', 'UPLOADED'], [`v${res.current_version} (current)`, '', '', ''], ...res.data.map((v: any) => [`v${v.version}`, v.name, formatBytes(v.size), v.uploaded_at.slice(0, 19)])]));
    }
    default:
      die(`unknown command: ${cmd}\n\n${HELP}`);
  }
}

main().catch((err) => {
  if (err instanceof CdnApiError) die(`${err.code}: ${err.message}${err.requestId ? ` (request ${err.requestId})` : ''}`, 2);
  die((err as Error).message);
});
