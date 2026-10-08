import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomBytes } from 'node:crypto';
import { safeResolve } from './keys.js';
import { StorageError, type ByteRange, type CapacityInfo, type ObjectInfo, type PutOptions, type StorageDriver } from './types.js';

export interface LocalStorageConfig {
  root: string;
}

export class LocalStorageDriver implements StorageDriver {
  readonly kind = 'LOCAL' as const;
  private readonly root: string;
  private realRoot: string | null = null;

  constructor(config: LocalStorageConfig) {
    if (!config.root) throw new StorageError('Local storage root is required');
    this.root = path.resolve(config.root);
  }

  private async ensureRoot(): Promise<string> {
    if (!this.realRoot) {
      await fs.mkdir(this.root, { recursive: true });
      this.realRoot = await fs.realpath(this.root);
    }
    return this.realRoot;
  }

  /** Resolves and additionally verifies, via realpath, that no symlink escapes the root. */
  private async resolveChecked(key: string, mustExist: boolean): Promise<string> {
    const realRoot = await this.ensureRoot();
    const target = safeResolve(realRoot, key);
    const dir = path.dirname(target);
    try {
      const realDir = await fs.realpath(dir);
      const rel = path.relative(realRoot, realDir);
      if (rel.startsWith('..') || path.isAbsolute(rel)) throw new StorageError('Storage path escapes the storage root');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT' || mustExist) {
        if (err instanceof StorageError) throw err;
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new StorageError('Object not found', err);
        throw err;
      }
    }
    return target;
  }

  resolvePath(key: string): string {
    return safeResolve(this.root, key);
  }

  async put(key: string, body: Readable | Buffer, _opts: PutOptions): Promise<void> {
    const target = await this.resolveChecked(key, false);
    await fs.mkdir(path.dirname(target), { recursive: true });
    // Write to a temp file and atomically rename, so readers never see partial objects.
    const tmp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await pipeline(Buffer.isBuffer(body) ? Readable.from([body]) : body, createWriteStream(tmp, { flags: 'wx', mode: 0o644 }));
      await fs.rename(tmp, target);
    } catch (err) {
      await fs.rm(tmp, { force: true });
      throw new StorageError('Failed to write object', err);
    }
  }

  async get(key: string, range?: ByteRange): Promise<Readable> {
    const target = await this.resolveChecked(key, true);
    await fs.access(target).catch((err: unknown) => {
      throw new StorageError('Object not found', err);
    });
    return createReadStream(target, range ? { start: range.start, end: range.end } : undefined);
  }

  async head(key: string): Promise<ObjectInfo | null> {
    try {
      const target = await this.resolveChecked(key, true);
      const st = await fs.stat(target);
      return { size: st.size, lastModified: st.mtime };
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    const target = await this.resolveChecked(key, false);
    await fs.rm(target, { force: true });
  }

  async copy(sourceKey: string, destKey: string): Promise<void> {
    const src = await this.resolveChecked(sourceKey, true);
    const dst = await this.resolveChecked(destKey, false);
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.copyFile(src, dst);
  }

  async healthCheck(): Promise<void> {
    const root = await this.ensureRoot();
    const probe = path.join(root, `.healthcheck-${randomBytes(4).toString('hex')}`);
    await fs.writeFile(probe, 'ok');
    await fs.rm(probe, { force: true });
  }

  async *listKeys(prefix = ''): AsyncIterable<string> {
    const root = await this.ensureRoot();
    // Start from the deepest directory the prefix names, then filter by the full prefix.
    const slash = prefix.lastIndexOf('/');
    const startRel = slash >= 0 ? prefix.slice(0, slash) : '';
    const stack = [startRel];
    while (stack.length) {
      const rel = stack.pop()!;
      let entries;
      try {
        entries = await fs.readdir(rel ? safeResolve(root, rel) : root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const key = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) stack.push(key);
        else if (entry.isFile() && key.startsWith(prefix) && !entry.name.endsWith('.tmp') && !entry.name.startsWith('.healthcheck-')) yield key;
      }
    }
  }

  async capacity(): Promise<CapacityInfo> {
    try {
      const root = await this.ensureRoot();
      const st = await fs.statfs(root);
      return { available: st.bavail * st.bsize, total: st.blocks * st.bsize };
    } catch {
      return { available: null, total: null };
    }
  }
}
