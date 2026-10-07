import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalStorageDriver, StorageKeyError, assertSafeKey, objectKeyForFile, safeResolve } from './index.js';

describe('storage keys', () => {
  it('builds sharded keys from file ids', () => {
    expect(objectKeyForFile('file_01J9Z8Q4X5K3W2V1T0S9R8Q7P6')).toBe('objects/q7/p6/file_01J9Z8Q4X5K3W2V1T0S9R8Q7P6');
  });
  it.each(['../etc/passwd', 'objects/../../x', '/etc/passwd', 'a\\b', 'a//b', 'a/./b', 'a\0b', '', 'C:/Windows', '..'])('rejects unsafe key %j', (key) => {
    expect(() => assertSafeKey(key)).toThrow(StorageKeyError);
  });
  it('safeResolve never escapes the root', () => {
    const root = path.resolve('/srv/storage');
    expect(safeResolve(root, 'objects/ab/cd/file_x')).toBe(path.join(root, 'objects', 'ab', 'cd', 'file_x'));
    expect(() => safeResolve(root, '../outside')).toThrow();
  });
});

describe('LocalStorageDriver', () => {
  let root: string;
  let driver: LocalStorageDriver;
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'cdn-storage-'));
    driver = new LocalStorageDriver({ root });
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('writes, reads ranges, copies and deletes', async () => {
    await driver.put('objects/aa/bb/one', Readable.from([Buffer.from('hello world')]), { contentType: 'text/plain' });
    expect((await driver.head('objects/aa/bb/one'))?.size).toBe(11);
    const chunks: Buffer[] = [];
    for await (const c of await driver.get('objects/aa/bb/one', { start: 6, end: 10 })) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('world');
    await driver.copy('objects/aa/bb/one', 'objects/aa/bb/two');
    expect((await driver.head('objects/aa/bb/two'))?.size).toBe(11);
    await driver.delete('objects/aa/bb/one');
    expect(await driver.head('objects/aa/bb/one')).toBeNull();
  });

  it('refuses traversal keys', async () => {
    await expect(driver.put('../escape', Buffer.from('x'), { contentType: 'text/plain' })).rejects.toThrow();
    await expect(driver.get('objects/../../etc/passwd')).rejects.toThrow();
  });

  it('refuses to follow a symlink out of the root', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'cdn-outside-'));
    try {
      await fs.symlink(outside, path.join(root, 'link'), 'junction');
    } catch {
      return; // symlinks not permitted on this platform
    }
    await expect(driver.put('link/evil', Buffer.from('x'), { contentType: 'text/plain' })).rejects.toThrow();
    await fs.rm(outside, { recursive: true, force: true });
  });

  it('passes a health check', async () => {
    await expect(driver.healthCheck()).resolves.toBeUndefined();
  });
});
