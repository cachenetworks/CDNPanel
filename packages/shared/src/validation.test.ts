import { describe, expect, it } from 'vitest';
import {
  ALL_PERMISSIONS,
  DEFAULT_ROLES,
  endpointMatches,
  extensionOf,
  hasAllPermissions,
  isValidId,
  mimeMatches,
  newId,
  normalizeName,
  parseByteSize,
  slugifySegment,
  tryNormalizeName,
} from './index.js';

describe('normalizeName', () => {
  it('strips directory traversal', () => {
    expect(normalizeName('../../etc/passwd')).toBe('passwd');
    expect(normalizeName('..\\..\\windows\\win.ini')).toBe('win.ini');
    expect(normalizeName('/abs/path/file.txt')).toBe('file.txt');
  });
  it('removes null bytes and control characters', () => {
    expect(normalizeName('evil.php\u0000.png')).toBe('evil.php.png');
    expect(normalizeName('a\u0007b.txt')).toBe('ab.txt');
  });
  it('rejects names that are empty after normalisation', () => {
    expect(tryNormalizeName('..')).toBeNull();
    expect(tryNormalizeName('../')).toBeNull();
    expect(tryNormalizeName('   ')).toBeNull();
    expect(tryNormalizeName('...')).toBeNull();
  });
  it('neutralises reserved device names', () => {
    expect(normalizeName('CON.txt')).toBe('_CON.txt');
  });
  it('truncates very long names but keeps the extension', () => {
    const n = normalizeName('a'.repeat(400) + '.png');
    expect(n.length).toBeLessThanOrEqual(255);
    expect(n.endsWith('.png')).toBe(true);
  });
  it('removes characters invalid on filesystems', () => {
    expect(normalizeName('a<b>:c"d|e?f*.txt')).toBe('abcdef.txt');
  });
});

describe('helpers', () => {
  it('extensionOf', () => {
    expect(extensionOf('photo.JPG')).toBe('jpg');
    expect(extensionOf('.bashrc')).toBe('');
    expect(extensionOf('noext')).toBe('');
  });
  it('slugifySegment', () => {
    expect(slugifySegment('My Logo (Final).PNG')).toBe('my-logo-final.png');
    expect(slugifySegment('../..')).toBe('item');
  });
  it('mimeMatches wildcards', () => {
    expect(mimeMatches('image/*', 'image/png')).toBe(true);
    expect(mimeMatches('image/*', 'video/mp4')).toBe(false);
    expect(mimeMatches('application/pdf', 'application/pdf')).toBe(true);
  });
  it('parseByteSize', () => {
    expect(parseByteSize('5GB')).toBe(5 * 1024 ** 3);
    expect(parseByteSize('512mb')).toBe(512 * 1024 ** 2);
    expect(() => parseByteSize('lots')).toThrow();
  });
});

describe('ids', () => {
  it('generates and validates prefixed ULIDs', () => {
    const id = newId('file');
    expect(isValidId('file', id)).toBe(true);
    expect(isValidId('folder', id)).toBe(false);
  });
  it('rejects malformed ids', () => {
    for (const bad of ['file_', 'file_../../etc', "file_1' OR 1=1", 'file_01J9Z8Q4X5K3W2V1T0S9R8Q7P6/..', 'FILE_01J9Z8Q4X5K3W2V1T0S9R8Q7P6', 42, null]) {
      expect(isValidId('file', bad)).toBe(false);
    }
  });
});

describe('permissions', () => {
  it('Founder has every permission', () => {
    expect(DEFAULT_ROLES.find((r) => r.name === 'Founder')!.permissions).toEqual(ALL_PERMISSIONS);
  });
  it('Viewer cannot delete or manage', () => {
    const viewer = DEFAULT_ROLES.find((r) => r.name === 'Viewer')!.permissions;
    expect(hasAllPermissions(viewer, ['files.delete'])).toBe(false);
    expect(hasAllPermissions(viewer, ['files.view'])).toBe(true);
  });
  it('endpointMatches patterns', () => {
    expect(endpointMatches('GET /api/v1/files*', 'GET', '/api/v1/files/file_1')).toBe(true);
    expect(endpointMatches('GET /api/v1/files*', 'POST', '/api/v1/files')).toBe(false);
    expect(endpointMatches('* /api/v1/folders/*', 'DELETE', '/api/v1/folders/fld_1')).toBe(true);
    expect(endpointMatches('/api/v1/me', 'GET', '/api/v1/me')).toBe(true);
    expect(endpointMatches('GET /api/v1/me', 'GET', '/api/v1/meX')).toBe(false);
  });
});
