import type { FastifyRequest } from 'fastify';
import type { MultipartFile } from '@fastify/multipart';
import { z } from 'zod';
import { AppError, isValidId } from '@cdn/shared';
import { requireFolder } from '../lib/folders.js';
import { actorOf, apiKeyIdOf, userIdOf } from '../http/context.js';
import { ingestFile } from './ingest.js';
import type { serializeFile } from '../lib/serialize.js';
import { emitWebhookEvent } from '../lib/webhooks.js';

/**
 * Upload options can be supplied as multipart fields (placed BEFORE the file part) or as
 * query-string parameters.
 */
export const UploadOptionsSchema = z.object({
  folder_id: z
    .string()
    .refine((v) => v === '' || v === 'root' || isValidId('folder', v), 'invalid folder id')
    .optional(),
  visibility: z.enum(['PUBLIC', 'PRIVATE', 'AUTHENTICATED', 'SIGNED_URL_ONLY']).optional(),
  cache_control: z.string().max(200).regex(/^[\w\s,=-]+$/, 'invalid Cache-Control value').optional(),
  force_download: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  metadata: z
    .string()
    .max(16 * 1024)
    .transform((v, ctx) => {
      try {
        const parsed = JSON.parse(v) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
        return parsed as Record<string, unknown>;
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'metadata must be a JSON object' });
        return z.NEVER;
      }
    })
    .optional(),
  sha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
});
export type UploadOptions = z.infer<typeof UploadOptionsSchema>;

function parseOptions(raw: Record<string, string>): UploadOptions {
  const res = UploadOptionsSchema.safeParse(raw);
  if (!res.success) {
    throw new AppError('validation_failed', undefined, res.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  return res.data;
}

export type UploadResult = { ok: true; file: ReturnType<typeof serializeFile> } | { ok: false; filename: string; error: { code: string; message: string } };

/** Streams every file part of a multipart request through the ingest pipeline. */
export async function handleMultipartUpload(req: FastifyRequest, opts: { maxFiles: number }): Promise<UploadResult[]> {
  if (!req.isMultipart()) throw new AppError('bad_request', 'Expected a multipart/form-data request with a "file" field.');
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.query as Record<string, unknown>)) if (typeof v === 'string') fields[k] = v;
  const results: UploadResult[] = [];
  let resolvedFolder: { key: string; id: string | null } | null = null;
  let fileCount = 0;

  for await (const part of req.parts()) {
    if (part.type === 'field') {
      if (typeof part.value === 'string') fields[part.fieldname] = part.value;
      continue;
    }
    const filePart = part as MultipartFile;
    fileCount++;
    if (fileCount > opts.maxFiles) {
      filePart.file.resume();
      throw new AppError('bad_request', `At most ${opts.maxFiles} file(s) may be uploaded per request.`);
    }
    const options = parseOptions(fields);
    if (options.metadata && req.auth?.type === 'api_key' && !req.auth.scopes.has('metadata:write')) {
      filePart.file.resume();
      throw new AppError('insufficient_scope', 'Setting metadata requires the metadata:write scope.');
    }
    const folderKey = options.folder_id ?? '';
    if (!resolvedFolder || resolvedFolder.key !== folderKey) {
      const id: string | null = folderKey && folderKey !== 'root' ? (await requireFolder(req, folderKey)).id : null;
      resolvedFolder = { key: folderKey, id };
    }
    try {
      const file = await ingestFile({
        stream: filePart.file,
        filename: filePart.filename || 'upload',
        folderId: resolvedFolder.id,
        visibility: options.visibility,
        cacheControl: options.cache_control ?? null,
        forceDownload: options.force_download,
        metadata: options.metadata,
        expectedSha256: options.sha256 ?? null,
        userId: userIdOf(req),
        apiKeyId: apiKeyIdOf(req),
        actor: actorOf(req),
      });
      results.push({ ok: true, file });
    } catch (err) {
      filePart.file.resume();
      const code = err instanceof AppError ? err.code : 'internal_error';
      await emitWebhookEvent('upload.failed', { filename: filePart.filename, error: { code } });
      if (opts.maxFiles === 1 || !(err instanceof AppError) || err.status >= 500) throw err;
      results.push({ ok: false, filename: filePart.filename, error: { code: err.code, message: err.message } });
    }
  }
  if (fileCount === 0) throw new AppError('validation_failed', 'No file was provided. Send the file in a multipart field named "file".');
  return results;
}
