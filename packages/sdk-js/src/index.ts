import { CdnClient as GeneratedClient } from './generated.js';

export { CdnApiError, type CdnClientOptions, type RequestOptions } from './core.js';
export { OPERATIONS } from './generated.js';

export interface UploadOptions {
  folderId?: string;
  visibility?: 'PUBLIC' | 'PRIVATE' | 'AUTHENTICATED' | 'SIGNED_URL_ONLY';
  cacheTags?: string[];
  expiresInDays?: number;
  /** Files larger than this use the resumable chunked upload API (default 64 MB). */
  chunkThreshold?: number;
  onProgress?: (uploaded: number, total: number) => void;
  signal?: AbortSignal;
}

/**
 * CDNPanel API client: all generated endpoint methods plus high-level helpers.
 *
 *   const cdn = new CdnClient({ baseUrl: 'https://cdn.example.com', apiKey: process.env.CDN_API_KEY! });
 *   const file = await cdn.uploadFile(new Blob([data]), 'logo.png', { visibility: 'PUBLIC' });
 */
export class CdnClient extends GeneratedClient {
  /** Uploads a file, switching to resumable chunked uploads for large files. */
  async uploadFile(data: Blob, filename: string, opts: UploadOptions = {}): Promise<any> {
    const threshold = opts.chunkThreshold ?? 64 * 1024 * 1024;
    if (data.size <= threshold) {
      const form = new FormData();
      if (opts.folderId) form.append('folder_id', opts.folderId);
      if (opts.visibility) form.append('visibility', opts.visibility);
      if (opts.cacheTags?.length) form.append('cache_tags', opts.cacheTags.join(','));
      if (opts.expiresInDays) form.append('expires_in_days', String(opts.expiresInDays));
      form.append('file', data, filename);
      const file = await this.uploadAFile({ form, signal: opts.signal });
      opts.onProgress?.(data.size, data.size);
      return file;
    }
    const session = await this.startAChunkedResumableUpload({
      body: { filename, size: data.size, folder_id: opts.folderId ?? null, ...(opts.visibility ? { visibility: opts.visibility } : {}) },
      signal: opts.signal,
    });
    let uploaded = 0;
    for (let i = 0; i < session.total_chunks; i++) {
      const chunk = data.slice(i * session.chunk_size, Math.min(data.size, (i + 1) * session.chunk_size));
      await this.uploadAChunk(session.id, { query: { index: i }, data: chunk, signal: opts.signal });
      uploaded += chunk.size;
      opts.onProgress?.(uploaded, data.size);
    }
    const file = await this.completeAChunkedUpload(session.id, { signal: opts.signal });
    if (opts.cacheTags?.length || opts.expiresInDays) {
      return this.updateAFile(file.id, {
        body: { ...(opts.cacheTags?.length ? { cache_tags: opts.cacheTags } : {}), ...(opts.expiresInDays ? { expires_at: new Date(Date.now() + opts.expiresInDays * 86_400_000).toISOString() } : {}) },
      });
    }
    return file;
  }
}
