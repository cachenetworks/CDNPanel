import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { PassThrough, Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import { getPrisma, type Upload } from '@cdn/database';
import { AppError, isValidId, newId } from '@cdn/shared';
import { defineRoute, type RouteDef } from '../http/route.js';
import { actorOf, apiKeyIdOf, userIdOf } from '../http/context.js';
import { env } from '../config/env.js';
import { getSettings } from '../lib/settings.js';
import { requireFolder } from '../lib/folders.js';
import { uploadProvider } from '../lib/storageRegistry.js';
import { emitWebhookEvent } from '../lib/webhooks.js';
import { assertUploadAllowed, ingestFile } from '../services/ingest.js';
import { handleMultipartUpload } from '../services/multipart.js';
import { FILE_EXAMPLE } from './files.js';

const uploadParams = z.object({ id: z.string().max(64) });

export function uploadTmpDir(uploadId: string): string {
  if (!isValidId('upload', uploadId)) throw new AppError('invalid_id');
  const root = path.resolve(env().UPLOAD_TMP_PATH);
  const dir = path.resolve(root, uploadId);
  if (path.dirname(dir) !== root) throw new AppError('invalid_id');
  return dir;
}

function serializeUpload(u: Upload) {
  return {
    id: u.id,
    object: 'upload' as const,
    filename: u.filename,
    status: u.status,
    total_size: Number(u.totalSize),
    chunk_size: u.chunkSize,
    total_chunks: u.totalChunks,
    received_chunks: [...u.receivedChunks].sort((a, b) => a - b),
    received_bytes: Number(u.receivedBytes),
    file_id: u.fileId,
    error: u.error,
    expires_at: u.expiresAt.toISOString(),
    created_at: u.createdAt.toISOString(),
  };
}

const UPLOAD_EXAMPLE = {
  id: 'upl_01J9Z8Q4X5K3W2V1T0S9R8Q7P6',
  object: 'upload',
  filename: 'release.zip',
  status: 'PENDING',
  total_size: 52428800,
  chunk_size: 16777216,
  total_chunks: 4,
  received_chunks: [0, 1],
  received_bytes: 33554432,
  file_id: null,
  error: null,
  expires_at: '2026-01-02T10:00:00.000Z',
  created_at: '2026-01-01T10:00:00.000Z',
};

/** Loads an upload session owned by the caller. */
async function requireUpload(req: FastifyRequest, id: string): Promise<Upload> {
  if (!isValidId('upload', id)) throw new AppError('invalid_id', 'The upload id is malformed.');
  const upload = await getPrisma().upload.findUnique({ where: { id } });
  const ownerOk = upload && (upload.userId ? upload.userId === userIdOf(req) : upload.apiKeyId === apiKeyIdOf(req));
  if (!upload || !ownerOk) throw new AppError('upload_not_found');
  return upload;
}

function assertPending(u: Upload) {
  if (u.status !== 'PENDING') throw new AppError('conflict', `The upload is ${u.status.toLowerCase()}.`);
  if (u.expiresAt.getTime() < Date.now()) throw new AppError('conflict', 'The upload session has expired.');
}

export const uploadRoutes: RouteDef<any, any, any>[] = [
  defineRoute({
    method: 'POST',
    url: '/api/v1/uploads',
    tag: 'Uploads',
    summary: 'Upload one or more files',
    description:
      'Multipart upload of up to 20 files in one request (each part named `file`). Options apply to all files and must be sent before the file parts (or as query parameters). Each file succeeds or fails independently.',
    auth: 'any',
    permission: 'files.upload',
    scope: 'files:upload',
    multipart: [
      { name: 'file', type: 'file', required: true, description: 'One or more file parts.' },
      { name: 'folder_id', type: 'string', description: 'Destination folder id.' },
      { name: 'visibility', type: 'string', enum: ['PUBLIC', 'PRIVATE', 'AUTHENTICATED', 'SIGNED_URL_ONLY'], description: 'Visibility for all files.' },
    ],
    responses: {
      201: {
        description: 'Per-file results',
        example: { data: [{ ok: true, file: FILE_EXAMPLE }, { ok: false, filename: 'tool.exe', error: { code: 'unsupported_file_type', message: 'Files with the .exe extension are not allowed.' } }] },
      },
    },
    errors: ['file_too_large', 'unsupported_file_type', 'quota_exceeded', 'folder_not_found'],
    async handler({ req, reply }) {
      const results = await handleMultipartUpload(req, { maxFiles: 20 });
      reply.code(201);
      return { data: results };
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/uploads/init',
    tag: 'Uploads',
    summary: 'Start a chunked (resumable) upload',
    description:
      'Creates an upload session for large files. Send each chunk with `POST /api/v1/uploads/{id}/chunk?index=N` (raw bytes, `Content-Type: application/octet-stream`); every chunk except the last must be exactly `chunk_size` bytes. Chunks can be sent in any order and retried. Finish with `POST /api/v1/uploads/{id}/complete`.',
    auth: 'any',
    permission: 'files.upload',
    scope: 'files:upload',
    body: z.object({
      filename: z.string().min(1).max(255),
      size: z.number().int().min(0),
      folder_id: z.string().refine((v) => v === 'root' || isValidId('folder', v), 'invalid folder id').nullable().optional(),
      visibility: z.enum(['PUBLIC', 'PRIVATE', 'AUTHENTICATED', 'SIGNED_URL_ONLY']).optional(),
      sha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional().describe('Expected SHA-256 of the whole file; verified on completion.'),
      chunk_size: z.number().int().min(1024 * 1024).max(100 * 1024 * 1024).optional(),
    }),
    responses: { 201: { description: 'Upload session', example: UPLOAD_EXAMPLE } },
    errors: ['file_too_large', 'quota_exceeded', 'unsupported_file_type', 'folder_not_found'],
    async handler({ req, reply, body }) {
      const settings = await getSettings();
      const { name } = await assertUploadAllowed(body.filename, body.size);
      const folder = body.folder_id && body.folder_id !== 'root' ? await requireFolder(req, body.folder_id) : null;
      const provider = await uploadProvider(settings.uploads.storageProviderId);
      const chunkSize = body.chunk_size ?? settings.uploads.chunkSize;
      const totalChunks = Math.max(1, Math.ceil(body.size / chunkSize));
      if (totalChunks > 10_000) throw new AppError('validation_failed', 'Too many chunks; increase chunk_size.');
      const upload = await getPrisma().upload.create({
        data: {
          id: newId('upload'),
          filename: name,
          totalSize: BigInt(body.size),
          chunkSize,
          totalChunks,
          expectedSha256: body.sha256?.toLowerCase() ?? null,
          folderId: folder?.id ?? null,
          visibility: body.visibility ?? null,
          storageProviderId: provider.id,
          userId: userIdOf(req),
          apiKeyId: apiKeyIdOf(req),
          expiresAt: new Date(Date.now() + settings.uploads.uploadSessionTtlHours * 3_600_000),
        },
      });
      await fs.mkdir(uploadTmpDir(upload.id), { recursive: true });
      reply.code(201);
      return serializeUpload(upload);
    },
  }),
  defineRoute({
    method: 'GET',
    url: '/api/v1/uploads/:id',
    tag: 'Uploads',
    summary: 'Get upload status',
    description: 'Returns the upload session including which chunks have been received — use it to resume an interrupted upload.',
    auth: 'any',
    permission: 'files.upload',
    scope: 'files:upload',
    params: uploadParams,
    responses: { 200: { description: 'Upload session', example: UPLOAD_EXAMPLE } },
    errors: ['upload_not_found'],
    async handler({ req, params }) {
      return serializeUpload(await requireUpload(req, params.id));
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/uploads/:id/chunk',
    tag: 'Uploads',
    summary: 'Upload a chunk',
    description: 'Request body is the raw chunk bytes with `Content-Type: application/octet-stream`. Re-sending an already received chunk overwrites it.',
    auth: 'any',
    permission: 'files.upload',
    scope: 'files:upload',
    params: uploadParams,
    query: z.object({ index: z.coerce.number().int().min(0) }),
    rawBody: { contentType: 'application/octet-stream', description: 'Chunk bytes' },
    bodyLimit: 101 * 1024 * 1024,
    responses: { 200: { description: 'Updated upload session', example: UPLOAD_EXAMPLE } },
    errors: ['upload_not_found', 'conflict', 'validation_failed'],
    async handler({ req, params, query }) {
      const upload = await requireUpload(req, params.id);
      assertPending(upload);
      if (query.index >= upload.totalChunks) throw new AppError('validation_failed', `index must be between 0 and ${upload.totalChunks - 1}.`);
      const total = Number(upload.totalSize);
      const expected = query.index === upload.totalChunks - 1 ? total - upload.chunkSize * (upload.totalChunks - 1) : upload.chunkSize;
      const body = req.body;
      if (!(body instanceof Readable)) throw new AppError('bad_request', 'Send the chunk as application/octet-stream.');
      const dir = uploadTmpDir(upload.id);
      await fs.mkdir(dir, { recursive: true });
      const partPath = path.join(dir, `${query.index}.part`);
      const tmpPath = `${partPath}.${newId('request')}`;
      let received = 0;
      const counter = new Transform({
        transform(chunk: Buffer, _e, cb) {
          received += chunk.length;
          if (received > expected) cb(new AppError('validation_failed', `Chunk ${query.index} must be exactly ${expected} bytes.`));
          else cb(null, chunk);
        },
      });
      try {
        await pipeline(body, counter, createWriteStream(tmpPath));
      } catch (err) {
        await fs.rm(tmpPath, { force: true });
        throw err instanceof AppError ? err : new AppError('bad_request', 'The chunk upload was interrupted.');
      }
      if (received !== expected) {
        await fs.rm(tmpPath, { force: true });
        throw new AppError('validation_failed', `Chunk ${query.index} must be exactly ${expected} bytes (received ${received}).`);
      }
      await fs.rename(tmpPath, partPath);
      const prisma = getPrisma();
      await prisma.$executeRaw`UPDATE "Upload" SET "receivedChunks" = array_append("receivedChunks", ${query.index}), "receivedBytes" = "receivedBytes" + ${BigInt(received)}, "updatedAt" = (now() AT TIME ZONE 'UTC') WHERE "id" = ${upload.id} AND NOT (${query.index} = ANY("receivedChunks"))`;
      return serializeUpload(await prisma.upload.findUniqueOrThrow({ where: { id: upload.id } }));
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/uploads/:id/complete',
    tag: 'Uploads',
    summary: 'Complete a chunked upload',
    description: 'Assembles the chunks, verifies size and checksum, validates the content and creates the file.',
    auth: 'any',
    permission: 'files.upload',
    scope: 'files:upload',
    params: uploadParams,
    responses: { 201: { description: 'Created file', example: FILE_EXAMPLE } },
    errors: ['upload_not_found', 'conflict', 'checksum_mismatch', 'unsupported_file_type', 'quota_exceeded'],
    async handler({ req, reply, params }) {
      const prisma = getPrisma();
      const upload = await requireUpload(req, params.id);
      assertPending(upload);
      const missing = Array.from({ length: upload.totalChunks }, (_, i) => i).filter((i) => !upload.receivedChunks.includes(i));
      if (missing.length > 0) throw new AppError('conflict', `Missing chunks: ${missing.slice(0, 20).join(', ')}${missing.length > 20 ? '…' : ''}`, { missing_chunks: missing });
      const claimed = await prisma.upload.updateMany({ where: { id: upload.id, status: 'PENDING' }, data: { status: 'COMPLETING' } });
      if (claimed.count !== 1) throw new AppError('conflict', 'The upload is already being completed.');
      const dir = uploadTmpDir(upload.id);
      const combined = new PassThrough();
      // Concatenate chunk files sequentially into a single stream.
      void (async () => {
        try {
          for (let i = 0; i < upload.totalChunks; i++) {
            await pipeline(createReadStream(path.join(dir, `${i}.part`)), combined, { end: false });
          }
          combined.end();
        } catch (err) {
          combined.destroy(err as Error);
        }
      })();
      try {
        const file = await ingestFile({
          stream: combined,
          filename: upload.filename,
          declaredSize: Number(upload.totalSize),
          folderId: upload.folderId,
          visibility: upload.visibility ?? undefined,
          expectedSha256: upload.expectedSha256,
          userId: userIdOf(req),
          apiKeyId: apiKeyIdOf(req),
          actor: actorOf(req),
          storageProviderId: upload.storageProviderId,
        });
        await prisma.upload.update({ where: { id: upload.id }, data: { status: 'COMPLETED', fileId: file.id } });
        await fs.rm(dir, { recursive: true, force: true });
        reply.code(201);
        return file;
      } catch (err) {
        const code = err instanceof AppError ? err.code : 'internal_error';
        await prisma.upload.update({ where: { id: upload.id }, data: { status: 'FAILED', error: code } });
        await fs.rm(dir, { recursive: true, force: true });
        await emitWebhookEvent('upload.failed', { upload_id: upload.id, filename: upload.filename, error: { code } });
        throw err;
      }
    },
  }),
  defineRoute({
    method: 'DELETE',
    url: '/api/v1/uploads/:id',
    tag: 'Uploads',
    summary: 'Abort a chunked upload',
    auth: 'any',
    permission: 'files.upload',
    scope: 'files:upload',
    params: uploadParams,
    responses: { 204: { description: 'Aborted' } },
    errors: ['upload_not_found', 'conflict'],
    async handler({ req, params }) {
      const upload = await requireUpload(req, params.id);
      if (upload.status === 'COMPLETED' || upload.status === 'COMPLETING') throw new AppError('conflict', 'The upload has already completed.');
      await getPrisma().upload.update({ where: { id: upload.id }, data: { status: 'ABORTED' } });
      await fs.rm(uploadTmpDir(upload.id), { recursive: true, force: true });
    },
  }),
];
