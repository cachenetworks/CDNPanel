import { describe, expect, it } from 'vitest';
import { anonymizeIp, ipMatchesAny, isValidIpOrCidr } from './ip.js';
import { checkPasswordPolicy, hashPassword, verifyPassword } from './password.js';
import { sanitizeMetadata } from './audit.js';
import { redactUrl } from './logger.js';
import { sniffContent } from './sniff.js';
import { contentDisposition, parseRange } from '../services/delivery.js';

describe('ip helpers', () => {
  it('matches IPs and CIDRs (incl. IPv4-mapped IPv6)', () => {
    expect(ipMatchesAny('203.0.113.7', ['203.0.113.0/24'])).toBe(true);
    expect(ipMatchesAny('::ffff:203.0.113.7', ['203.0.113.0/24'])).toBe(true);
    expect(ipMatchesAny('198.51.100.1', ['203.0.113.0/24', '10.0.0.1'])).toBe(false);
    expect(ipMatchesAny('2001:db8::1', ['2001:db8::/32'])).toBe(true);
    expect(ipMatchesAny('garbage', ['0.0.0.0/0'])).toBe(false);
  });
  it('validates entries', () => {
    expect(isValidIpOrCidr('10.0.0.0/8')).toBe(true);
    expect(isValidIpOrCidr('10.0.0.0/99')).toBe(false);
    expect(isValidIpOrCidr('example.com')).toBe(false);
  });
  it('anonymizes', () => {
    expect(anonymizeIp('203.0.113.77')).toBe('203.0.113.0');
    expect(anonymizeIp('2001:db8:abcd:1234::1')).toBe('2001:db8:abcd::');
  });
});

describe('passwords', () => {
  it('hashes with Argon2id and verifies', async () => {
    const hash = await hashPassword('Correct-Horse-9');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(hash, 'Correct-Horse-9')).toBe(true);
    expect(await verifyPassword(hash, 'wrong')).toBe(false);
    expect(await verifyPassword(null, 'anything')).toBe(false);
  });
  it('enforces the policy', () => {
    expect(checkPasswordPolicy('short').ok).toBe(false);
    expect(checkPasswordPolicy('alllowercaseletters').ok).toBe(false);
    expect(checkPasswordPolicy('Str0ng-Enough-Pass').ok).toBe(true);
  });
});

describe('log/audit redaction', () => {
  it('removes credentials from audit metadata', () => {
    const out = sanitizeMetadata({ password: 'x', nested: { apiKey: 'y', ok: 1 }, token: 'z', raw: 'cdn_live_' + 'a'.repeat(32) }) as Record<string, unknown>;
    expect(out.password).toBe('[REDACTED]');
    expect((out.nested as Record<string, unknown>).apiKey).toBe('[REDACTED]');
    expect((out.nested as Record<string, unknown>).ok).toBe(1);
    expect(out.token).toBe('[REDACTED]');
    expect(out.raw).toBe('[REDACTED]');
  });
  it('redacts signatures from URLs', () => {
    expect(redactUrl('/files/x?expires=1&sig=abc&kv=1')).toBe('/files/x?expires=1&sig=[REDACTED]&kv=1');
  });
});

describe('content sniffing', () => {
  it('detects PNG from magic bytes regardless of name', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000100000000808060000001ff3ff61', 'hex');
    const r = await sniffContent(png, 'totally-a.txt');
    expect(r.mime).toBe('image/png');
    expect(r.width).toBe(16);
  });
  it('detects HTML disguised as an image', async () => {
    expect((await sniffContent(Buffer.from('<!DOCTYPE html><script>alert(1)</script>'), 'cat.png')).mime).toBe('text/html');
  });
  it('detects SVG', async () => {
    expect((await sniffContent(Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'a.svg')).mime).toBe('image/svg+xml');
  });
  it('never trusts a .html extension on plain text', async () => {
    expect((await sniffContent(Buffer.from('just text'), 'a.html')).mime).toBe('text/plain');
  });
  it('falls back to octet-stream for unknown binary', async () => {
    expect((await sniffContent(Buffer.from([0, 1, 2, 3, 0, 255]), 'x.bin')).mime).toBe('application/octet-stream');
  });
});

describe('range parsing', () => {
  it('parses ranges', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=900-', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange('bytes=0-5000', 1000)).toEqual({ start: 0, end: 999 });
  });
  it('detects unsatisfiable / ignores multi-range', () => {
    expect(parseRange('bytes=1000-', 1000)).toBe('unsatisfiable');
    expect(parseRange('bytes=5-1', 1000)).toBe('unsatisfiable');
    expect(parseRange('bytes=0-1,5-6', 1000)).toBeNull();
    expect(parseRange(undefined, 1000)).toBeNull();
  });
  it('encodes Content-Disposition safely', () => {
    expect(contentDisposition('attachment', 'ré"sumé.pdf')).toBe(`attachment; filename="r__sum_.pdf"; filename*=UTF-8''r%C3%A9%22sum%C3%A9.pdf`);
  });
});
