import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

// Pure-logic tests for the 2.0 platform features. Modules that read configuration are imported
// after the environment is prepared.
process.env.APP_URL ??= 'https://panel.example.com';
process.env.CDN_URL ??= 'https://cdn.example.com';
process.env.API_URL ??= 'https://cdn.example.com';
process.env.DATABASE_URL ??= 'postgresql://unused';
process.env.REDIS_URL ??= 'redis://unused';
process.env.SESSION_SECRET ??= randomBytes(48).toString('base64url');
process.env.MASTER_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

type Mods = {
  glob: typeof import('./glob.js');
  cache: typeof import('../services/cachePolicy.js');
  edge: typeof import('../services/edgeSecurity.js');
  images: typeof import('../services/images.js');
  delivery: typeof import('../services/delivery.js');
  media: typeof import('../services/media.js');
  ingest: typeof import('../services/ingest.js');
  settings: typeof import('./settings.js');
};
let m: Mods;

beforeAll(async () => {
  m = {
    glob: await import('./glob.js'),
    cache: await import('../services/cachePolicy.js'),
    edge: await import('../services/edgeSecurity.js'),
    images: await import('../services/images.js'),
    delivery: await import('../services/delivery.js'),
    media: await import('../services/media.js'),
    ingest: await import('../services/ingest.js'),
    settings: await import('./settings.js'),
  };
});

describe('globMatch', () => {
  it('matches within and across segments', () => {
    expect(m.glob.globMatch('/images/*', '/images/logo.png')).toBe(true);
    expect(m.glob.globMatch('/images/*', '/images/icons/a.png')).toBe(false);
    expect(m.glob.globMatch('/images/**', '/images/icons/a.png')).toBe(true);
    expect(m.glob.globMatch('/v?/app.js', '/v2/app.js')).toBe(true);
  });
  it('matches bare patterns against the file name only', () => {
    expect(m.glob.globMatch('*.css', '/deep/path/site.CSS')).toBe(true);
    expect(m.glob.globMatch('*.css', '/styles.css/x.js')).toBe(false);
  });
  it('escapes regex metacharacters', () => {
    expect(m.glob.globMatch('/a+b/(x).js', '/a+b/(x).js')).toBe(true);
    expect(m.glob.globMatch('/a+b/(x).js', '/aab/x.js')).toBe(false);
  });
});

describe('cachePolicy', () => {
  const file = { id: 'file_X', folderId: 'fld_Y', cacheTags: ['release:v2'], cacheControl: null as string | null };
  const zone = {
    id: 'zon_1',
    slug: 'assets',
    projectId: 'prj_1',
    edgeTtl: 600,
    browserTtl: 60,
    rootFolder: { id: 'fld_root', path: '/assets' },
    cacheRules: [
      { id: 'r1', name: 'css', pattern: '*.css', edgeTtl: 30, browserTtl: 10, bypass: false, enabled: true, priority: 1 },
      { id: 'r2', name: 'live', pattern: '/live/**', edgeTtl: null, browserTtl: null, bypass: true, enabled: true, priority: 2 },
    ],
    domains: [],
  } as never;

  it('uses zone TTLs with separate browser and edge directives', () => {
    const p = m.cache.cachePolicy({ file, zone, relPath: '/img/logo.png', settings: m.settings.defaultSettings(), isPublic: true });
    expect(p.cacheControl).toBe('public, max-age=60');
    expect(p.cdnCacheControl).toBe('max-age=600');
    expect(p.tags).toEqual(['file:file_X', 'folder:fld_Y', 'zone:assets', 'project:prj_1', 'release:v2']);
  });
  it('applies the first matching rule', () => {
    const p = m.cache.cachePolicy({ file, zone, relPath: '/site.css', settings: m.settings.defaultSettings(), isPublic: true });
    expect(p.rule?.id).toBe('r1');
    expect(p.edgeTtl).toBe(30);
    const b = m.cache.cachePolicy({ file, zone, relPath: '/live/feed.json', settings: m.settings.defaultSettings(), isPublic: true });
    expect(b.bypass).toBe(true);
    expect(b.cdnCacheControl).toBe('no-store');
  });
  it('never caches private files and respects explicit file overrides', () => {
    const settings = m.settings.defaultSettings();
    expect(m.cache.cachePolicy({ file, zone, relPath: '/a', settings, isPublic: false }).cacheControl).toBe(settings.files.privateCacheControl);
    const o = m.cache.cachePolicy({ file: { ...file, cacheControl: 'public, max-age=5' }, zone, relPath: '/a', settings, isPublic: true });
    expect(o.source).toBe('file');
    expect(o.cdnCacheControl).toBeNull();
  });
  it('computes zone-relative paths', () => {
    expect(m.cache.zoneRelativePath('/assets/img', 'a.png', zone)).toBe('/img/a.png');
    expect(m.cache.zoneRelativePath('/other', 'a.png', zone)).toBe('/other/a.png');
  });
});

describe('security rule conditions', () => {
  const facts = { ip: '198.51.100.7', country: 'CN', asn: 4134, path: '/files/x', method: 'GET', host: 'cdn.example.com', user_agent: 'curl/8', referer: '', requests_per_minute: 600 };
  it('evaluates operators', () => {
    const c = m.edge.conditionMatches;
    expect(c({ field: 'country', op: 'eq', value: 'cn' }, facts)).toBe(true);
    expect(c({ field: 'country', op: 'in', value: ['US', 'CN'] }, facts)).toBe(true);
    expect(c({ field: 'requests_per_minute', op: 'gt', value: 500 }, facts)).toBe(true);
    expect(c({ field: 'ip', op: 'in_cidr', value: '198.51.100.0/24' }, facts)).toBe(true);
    expect(c({ field: 'ip', op: 'not_in_cidr', value: ['198.51.100.0/24'] }, facts)).toBe(false);
    expect(c({ field: 'user_agent', op: 'matches', value: '^curl/' }, facts)).toBe(true);
    expect(c({ field: 'asn', op: 'eq', value: 4134 }, facts)).toBe(true);
  });
  it('refuses catastrophic regular expressions', () => {
    expect(m.edge.conditionMatches({ field: 'path', op: 'matches', value: '(a+)+$' }, { ...facts, path: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!' })).toBe(false);
  });
  it('enforces zone geo and hotlink restrictions', () => {
    const zone = { allowedCountries: [], blockedCountries: ['CN'], blockedAsns: [], allowedReferrers: ['*.example.org'], allowEmptyReferrer: false, domains: [] } as never;
    expect(m.edge.zoneAccessCheck(zone, facts, 'panel.example.com').outcome).toBe('block');
    const ok = { ...facts, country: 'AU', referer: 'https://www.example.org/page' };
    expect(m.edge.zoneAccessCheck(zone, ok, 'panel.example.com').outcome).toBe('allow');
    expect(m.edge.zoneAccessCheck(zone, { ...ok, referer: 'https://evil.test/' }, 'panel.example.com').outcome).toBe('block');
    expect(m.edge.zoneAccessCheck(zone, { ...ok, referer: '' }, 'panel.example.com').outcome).toBe('block');
  });
});

describe('image transformations', () => {
  it('parses, canonicalises and signs parameters', () => {
    const settings = m.settings.defaultSettings();
    const p = m.images.parseTransform({ q: '80', w: '800', format: 'webp', fit: 'cover', ignored: 'x' }, settings);
    const canonical = m.images.canonicalTransform(p);
    expect(canonical).toBe('w=800&fit=cover&format=webp&q=80');
    const sig = m.images.signTransform('file_A', canonical);
    expect(m.images.verifyTransformSignature('file_A', canonical, sig)).toBe(true);
    expect(m.images.verifyTransformSignature('file_B', canonical, sig)).toBe(false);
    expect(m.images.verifyTransformSignature('file_A', 'w=801&fit=cover&format=webp&q=80', sig)).toBe(false);
  });
  it('rejects out-of-range and malformed values', () => {
    const settings = m.settings.defaultSettings();
    expect(() => m.images.parseTransform({ w: '999999' }, settings)).toThrow();
    expect(() => m.images.parseTransform({ fit: 'stretch' }, settings)).toThrow();
    expect(() => m.images.parseTransform({ crop: '1,2,3' }, settings)).toThrow();
    expect(() => m.images.parseTransform({ w: '2000', dpr: '4' }, settings)).toThrow();
  });
  it('negotiates auto formats from Accept', () => {
    expect(m.images.resolveFormat({ format: 'auto' }, 'image/jpeg', 'image/avif,image/webp')).toBe('avif');
    expect(m.images.resolveFormat({ format: 'auto' }, 'image/jpeg', 'image/webp')).toBe('webp');
    expect(m.images.resolveFormat({ format: 'auto' }, 'image/png', 'image/*')).toBe('png');
  });
  it('renders a real image with sharp', async () => {
    const sharp = (await import('sharp')).default;
    const src = await sharp({ create: { width: 64, height: 32, channels: 3, background: '#ff0000' } }).png().toBuffer();
    const p = m.images.parseTransform({ w: '16', format: 'webp' }, m.settings.defaultSettings());
    const out = await m.images.renderImage(src, p, 'webp', m.settings.defaultSettings());
    expect(out.width).toBe(16);
    expect(out.height).toBe(8);
    expect(out.data.subarray(8, 12).toString()).toBe('WEBP');
  });
});

describe('signed access cookies and media tokens', () => {
  it('grants access below the signed folder prefix only', () => {
    const { value } = m.delivery.signAccessCookie('/members', 60);
    expect(m.delivery.verifyAccessCookie(value, '/members')).toBe(true);
    expect(m.delivery.verifyAccessCookie(value, '/members/gallery')).toBe(true);
    expect(m.delivery.verifyAccessCookie(value, '/membersx')).toBe(false);
    expect(m.delivery.verifyAccessCookie(value, '/public')).toBe(false);
    const tampered = value.replace(/\.([^.]+)\.(\d+)\./, `.${Buffer.from('/').toString('base64url')}.$2.`);
    expect(m.delivery.verifyAccessCookie(tampered, '/public')).toBe(false);
  });
  it('rejects expired cookies', () => {
    const { value } = m.delivery.signAccessCookie('/a', -10);
    expect(m.delivery.verifyAccessCookie(value, '/a')).toBe(false);
  });
  it('binds media tokens to one file', () => {
    const t = m.media.mediaToken('file_A', 60);
    expect(m.media.verifyMediaToken('file_A', t)).toBe(true);
    expect(m.media.verifyMediaToken('file_B', t)).toBe(false);
    expect(m.media.verifyMediaToken('file_A', m.media.mediaToken('file_A', -5))).toBe(false);
  });
});

describe('helpers', () => {
  it('normalises cache tags', () => {
    expect(m.ingest.normalizeTags([' Release:V2 ', 'bad tag', 'project:sentinel', 'release:v2'])).toEqual(['release:v2', 'project:sentinel']);
  });
  it('selects applicable media renditions', () => {
    const video = { duration: 10, width: 1920, height: 1080, hasVideo: true, hasAudio: true, videoCodec: 'h264', audioCodec: 'aac', bitRate: null };
    expect(m.media.applicableKinds(['thumbnail', 'hls', 'waveform'], { ...video, hasAudio: false })).toEqual(['thumbnail', 'hls']);
    expect(m.media.applicableKinds(['thumbnail', 'audio'], { ...video, hasVideo: false })).toEqual(['audio']);
  });
});
