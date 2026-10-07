import { z } from 'zod';
import { getPrisma, Prisma } from '@cdn/database';
import { AppError, isValidId, normalizeName, signFileUrl, InvalidNameError } from '@cdn/shared';
import { defineRoute, enforceReauth, pageQuery, paginate, type RouteDef } from '../http/route.js';
import { actorOf, apiKeyIdOf, userIdOf, type SessionAuth } from '../http/context.js';
import { env, getKeyring } from '../config/env.js';
import { audit } from '../lib/audit.js';
import { hiddenFolderIds, requireFolder } from '../lib/folders.js';
import { FILE_INCLUDE, serializeFile } from '../lib/serialize.js';
import { getSettings } from '../lib/settings.js';
import { emitWebhookEvent } from '../lib/webhooks.js';
import { copyFile, deleteFiles, requireFile } from '../services/files.js';
import { uniqueFileSlug } from '../services/ingest.js';
import { handleMultipartUpload } from '../services/multipart.js';
import { sendFile } from '../services/delivery.js';

const fileId = z.object({ id: z.string().min(1).max(64) });
const folderRef = z
  .string()
  .refine((v) => v === 'root' || isValidId('folder', v), 'must be a folder id or "root"');

export const FILE_EXAMPLE = {
  id: 'file_01J9Z8Q4X5K3W2V1T0S9R8Q7P6',
  object: 'file',
  name: 'image.png',
  slug: 'image.png',
  folder_id: 'fld_01J9Z8Q4X5K3W2V1T0S9R8Q7P6',
  folder_path: '/images',
  mime_type: 'image/png',
  extension: 'png',
  size: 384920,
  sha256: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
  visibility: 'PUBLIC',
  status: 'READY',
  status_reason: null,
  cache_control: null,
  force_download: false,
  width: 1200,
  height: 630,
  duration_seconds: null,
  metadata: {},
  storage_provider: { id: 'stp_01J9Z8Q4X5K3W2V1T0S9R8Q7P6', name: 'Primary (environment)', kind: 'LOCAL' },
  uploaded_by: null,
  uploaded_by_api_key: { id: 'key_01J9Z8Q4X5K3W2V1T0S9R8Q7P6', name: 'CI uploader', prefix: 'cdn_live_a82f' },
  download_count: 42,
  bandwidth_bytes: 16166640,
  last_accessed_at: '2026-01-01T12:00:00.000Z',
  scanned_at: null,
  created_at: '2026-01-01T10:00:00.000Z',
  updated_at: '2026-01-01T10:00:00.000Z',
  url: 'https://cdn.example.com/files/file_01J9Z8Q4X5K3W2V1T0S9R8Q7P6',
  api_url: 'https://cdn.example.com/api/v1/files/file_01J9Z8Q4X5K3W2V1T0S9R8Q7P6',
  download_url: 'https://cdn.example.com/api/v1/files/file_01J9Z8Q4X5K3W2V1T0S9R8Q7P6/download',
  path_url: 'https://cdn.example.com/p/images/image.png',
};

const TYPE_FILTERS: Record<string, Prisma.FileWhereInput> = {
  image: { mimeType: { startsWith: 'image/' } },
  video: { mimeType: { startsWith: 'video/' } },
  audio: { mimeType: { startsWith: 'audio/' } },
  document: {
    OR: [
      { mimeType: { startsWith: 'text/' } },
      { mimeType: { in: ['application/pdf', 'application/json', 'application/msword', 'application/rtf'] } },
      { mimeType: { startsWith: 'application/vnd.openxmlformats' } },
      { mimeType: { startsWith: 'application/vnd.oasis' } },
    ],
  },
  archive: {
    mimeType: { in: ['application/zip', 'application/x-tar', 'application/gzip', 'application/x-7z-compressed', 'application/x-rar-compressed', 'application/x-bzip2', 'application/x-xz', 'application/vnd.rar'] },
  },
};

const listQuery = pageQuery.extend({
  folder_id: folderRef.optional().describe('Restrict to a folder ("root" for top level). Omit to search all folders.'),
  recursive: z.enum(['true', 'false']).optional().describe('With folder_id, include files in sub-folders.'),
  q: z.string().max(200).optional().describe('Search by file name (case-insensitive) or exact file id / SHA-256.'),
  mime: z.string().max(100).optional().describe('MIME type or prefix, e.g. "image/" or "application/pdf".'),
  type: z.enum(['image', 'video', 'audio', 'document', 'archive', 'other']).optional(),
  visibility: z.enum(['PUBLIC', 'PRIVATE', 'AUTHENTICATED', 'SIGNED_URL_ONLY']).optional(),
  status: z.enum(['UPLOADING', 'PROCESSING', 'SCANNING', 'READY', 'QUARANTINED', 'FAILED']).optional(),
  uploaded_by: z.string().max(64).optional().describe('Uploader user id or API key id.'),
  created_after: z.coerce.date().optional(),
  created_before: z.coerce.date().optional(),
  min_size: z.coerce.number().int().min(0).optional(),
  max_size: z.coerce.number().int().min(0).optional(),
  sort: z.enum(['created_at', 'name', 'size', 'downloads', 'bandwidth']).default('created_at'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

export const fileRoutes: RouteDef<any, any, any>[] = [
  defineRoute({
    method: 'GET',
    url: '/api/v1/files',
    tag: 'Files',
    summary: 'List and search files',
    description: 'Returns a paginated list of files. Supports search by name / id / checksum and filtering by folder, type, MIME, visibility, uploader, date and size.',
    auth: 'any',
    permission: 'files.view',
    scope: 'files:read',
    query: listQuery,
    responses: { 200: { description: 'Paginated files', example: { data: [FILE_EXAMPLE], pagination: { page: 1, limit: 50, total: 1, total_pages: 1, has_more: false } } } },
    errors: ['unauthenticated', 'insufficient_scope', 'forbidden', 'validation_failed'],
    async handler({ req, query }) {
      const prisma = getPrisma();
      const and: Prisma.FileWhereInput[] = [];
      if (query.folder_id) {
        if (query.folder_id === 'root') {
          if (query.recursive !== 'true') and.push({ folderId: null });
        } else {
          const folder = await requireFolder(req, query.folder_id);
          if (query.recursive === 'true') {
            and.push({ OR: [{ folderId: folder.id }, { folder: { path: { startsWith: `${folder.path}/` } } }] });
          } else and.push({ folderId: folder.id });
        }
      }
      const hidden = await hiddenFolderIds(req);
      if (hidden.length > 0) and.push({ OR: [{ folderId: null }, { folderId: { notIn: hidden } }] });
      if (query.q) {
        const q = query.q.trim();
        and.push({
          OR: [
            { name: { contains: q, mode: 'insensitive' } },
            { id: q },
            ...(/^[a-f0-9]{64}$/i.test(q) ? [{ sha256: q.toLowerCase() }] : []),
          ],
        });
      }
      if (query.mime) and.push(query.mime.endsWith('/') ? { mimeType: { startsWith: query.mime } } : { mimeType: query.mime });
      if (query.type) {
        if (query.type === 'other') and.push({ NOT: { OR: Object.values(TYPE_FILTERS) } });
        else and.push(TYPE_FILTERS[query.type]!);
      }
      if (query.visibility) and.push({ visibility: query.visibility });
      if (query.status) and.push({ status: query.status });
      if (query.uploaded_by) and.push({ OR: [{ uploadedById: query.uploaded_by }, { uploadedByApiKeyId: query.uploaded_by }] });
      if (query.created_after) and.push({ createdAt: { gte: query.created_after } });
      if (query.created_before) and.push({ createdAt: { lte: query.created_before } });
      if (query.min_size !== undefined) and.push({ size: { gte: BigInt(query.min_size) } });
      if (query.max_size !== undefined) and.push({ size: { lte: BigInt(query.max_size) } });
      const where: Prisma.FileWhereInput = { AND: and };
      const sortField = { created_at: 'createdAt', name: 'name', size: 'size', downloads: 'downloadCount', bandwidth: 'bandwidthBytes' }[query.sort as string] as string;
      const settings = await getSettings();
      const limit = Math.min(query.limit, settings.api.pageSizeMax);
      const [total, rows] = await Promise.all([
        prisma.file.count({ where }),
        prisma.file.findMany({
          where,
          include: FILE_INCLUDE,
          orderBy: [{ [sortField]: query.order }, { id: query.order }],
          skip: (query.page - 1) * limit,
          take: limit,
        }),
      ]);
      return paginate(rows.map(serializeFile), total, query.page, limit);
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/files',
    tag: 'Files',
    summary: 'Upload a file',
    description:
      'Uploads a single file using `multipart/form-data`. Options may be sent as form fields **before** the `file` part, or as query parameters. The real content type is detected from the file contents; the file name, extension and browser `Content-Type` are not trusted. For files larger than ~100 MB prefer the chunked upload API.',
    auth: 'any',
    permission: 'files.upload',
    scope: 'files:upload',
    multipart: [
      { name: 'file', type: 'file', required: true, description: 'The file content.' },
      { name: 'folder_id', type: 'string', description: 'Destination folder id (omit or "root" for the top level).' },
      { name: 'visibility', type: 'string', enum: ['PUBLIC', 'PRIVATE', 'AUTHENTICATED', 'SIGNED_URL_ONLY'], description: 'Defaults to the folder visibility, then the configured default.' },
      { name: 'cache_control', type: 'string', description: 'Cache-Control override, e.g. "public, max-age=31536000, immutable".' },
      { name: 'force_download', type: 'boolean', description: 'Always serve with Content-Disposition: attachment.' },
      { name: 'metadata', type: 'string', description: 'JSON object of custom metadata (requires metadata:write for API keys).' },
      { name: 'sha256', type: 'string', description: 'Expected SHA-256 (hex). The upload is rejected if the content does not match.' },
    ],
    responses: { 201: { description: 'File created', example: FILE_EXAMPLE } },
    errors: ['file_too_large', 'unsupported_file_type', 'quota_exceeded', 'checksum_mismatch', 'folder_not_found', 'insufficient_scope', 'validation_failed'],
    async handler({ req, reply }) {
      const [result] = await handleMultipartUpload(req, { maxFiles: 1 });
      if (!result || !result.ok) throw new AppError('internal_error');
      reply.code(201);
      return result.file;
    },
  }),
  defineRoute({
    method: 'GET',
    url: '/api/v1/files/:id',
    tag: 'Files',
    summary: 'Get a file',
    auth: 'any',
    permission: 'files.view',
    scope: 'files:read',
    params: fileId,
    responses: { 200: { description: 'The file', example: FILE_EXAMPLE } },
    errors: ['file_not_found', 'invalid_id'],
    async handler({ req, params }) {
      await requireFile(req, params.id);
      const file = await getPrisma().file.findUniqueOrThrow({ where: { id: params.id }, include: FILE_INCLUDE });
      return serializeFile(file);
    },
  }),
  defineRoute({
    method: 'PATCH',
    url: '/api/v1/files/:id',
    tag: 'Files',
    summary: 'Update a file',
    description: 'Renames a file or changes its visibility, cache settings, download behaviour or custom metadata. Changing `metadata` with an API key requires the `metadata:write` scope.',
    auth: 'any',
    permission: 'files.edit',
    scope: 'files:update',
    params: fileId,
    body: z
      .object({
        name: z.string().min(1).max(255).optional(),
        visibility: z.enum(['PUBLIC', 'PRIVATE', 'AUTHENTICATED', 'SIGNED_URL_ONLY']).optional(),
        cache_control: z.string().max(200).regex(/^[\w\s,=-]+$/).nullable().optional(),
        force_download: z.boolean().optional(),
        metadata: z.record(z.unknown()).optional(),
      })
      .strict(),
    responses: { 200: { description: 'Updated file', example: FILE_EXAMPLE } },
    errors: ['file_not_found', 'validation_failed', 'insufficient_scope'],
    async handler({ req, params, body }) {
      const file = await requireFile(req, params.id);
      if (body.metadata !== undefined && req.auth?.type === 'api_key' && !req.auth.scopes.has('metadata:write')) {
        throw new AppError('insufficient_scope', 'Updating metadata requires the metadata:write scope.');
      }
      if (body.metadata !== undefined && JSON.stringify(body.metadata).length > 16 * 1024) {
        throw new AppError('validation_failed', 'metadata must be at most 16 KB.');
      }
      const data: Prisma.FileUpdateInput = {};
      if (body.name !== undefined) {
        try {
          data.name = normalizeName(body.name, 'file');
        } catch (err) {
          if (err instanceof InvalidNameError) throw new AppError('validation_failed', 'Invalid file name.');
          throw err;
        }
        data.slug = await uniqueFileSlug(file.folderId, data.name, file.id);
      }
      if (body.visibility !== undefined) data.visibility = body.visibility;
      if (body.cache_control !== undefined) data.cacheControl = body.cache_control;
      if (body.force_download !== undefined) data.forceDownload = body.force_download;
      if (body.metadata !== undefined) data.metadata = body.metadata as Prisma.InputJsonValue;
      const updated = await getPrisma().file.update({ where: { id: file.id }, data, include: FILE_INCLUDE });
      const action = body.name !== undefined && body.name !== file.name && Object.keys(body).length === 1 ? 'FILE_RENAME' : 'FILE_UPDATE';
      await audit(actorOf(req), action, { type: 'file', id: file.id }, { changes: { ...body, metadata: body.metadata ? '[updated]' : undefined }, previous_name: file.name });
      const serialized = serializeFile(updated);
      await emitWebhookEvent('file.updated', { file: serialized });
      return serialized;
    },
  }),
  defineRoute({
    method: 'DELETE',
    url: '/api/v1/files/:id',
    tag: 'Files',
    summary: 'Delete a file',
    description: 'Permanently deletes the file record and, once no other record references it, the stored object.',
    auth: 'any',
    permission: 'files.delete',
    scope: 'files:delete',
    params: fileId,
    responses: { 204: { description: 'Deleted' } },
    errors: ['file_not_found', 'invalid_id'],
    async handler({ req, params }) {
      const file = await requireFile(req, params.id);
      await deleteFiles([file]);
      await audit(actorOf(req), 'FILE_DELETE', { type: 'file', id: file.id }, { name: file.name, size: Number(file.size) });
      await emitWebhookEvent('file.deleted', { file: { id: file.id, name: file.name, folder_id: file.folderId } });
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/files/bulk-delete',
    tag: 'Files',
    summary: 'Delete many files',
    description: 'Deletes up to 500 files. Deleting more than 20 files at once requires a recent password re-authentication.',
    auth: 'session',
    permission: 'files.delete',
    body: z.object({ ids: z.array(z.string().max(64)).min(1).max(500) }),
    responses: { 200: { description: 'Deletion result', example: { deleted: 12, not_found: [] } } },
    errors: ['reauthentication_required', 'validation_failed'],
    async handler({ req, body, auth }) {
      if (body.ids.length > 20) await enforceReauth(auth as SessionAuth);
      const valid = body.ids.filter((id: string) => isValidId('file', id));
      const files = [];
      const notFound: string[] = body.ids.filter((id: string) => !isValidId('file', id));
      for (const id of valid) {
        try {
          files.push(await requireFile(req, id));
        } catch {
          notFound.push(id);
        }
      }
      await deleteFiles(files);
      await audit(actorOf(req), 'FILE_BULK_DELETE', { type: 'file' }, { count: files.length, ids: files.map((f) => f.id) });
      for (const f of files) await emitWebhookEvent('file.deleted', { file: { id: f.id, name: f.name, folder_id: f.folderId } });
      return { deleted: files.length, not_found: notFound };
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/files/:id/move',
    tag: 'Files',
    summary: 'Move a file',
    auth: 'any',
    permission: 'files.edit',
    scope: 'files:update',
    params: fileId,
    body: z.object({ folder_id: folderRef.nullable() }),
    responses: { 200: { description: 'Moved file', example: FILE_EXAMPLE } },
    errors: ['file_not_found', 'folder_not_found'],
    async handler({ req, params, body }) {
      const file = await requireFile(req, params.id);
      const target = body.folder_id && body.folder_id !== 'root' ? await requireFolder(req, body.folder_id) : null;
      const slug = await uniqueFileSlug(target?.id ?? null, file.name, file.id);
      const updated = await getPrisma().file.update({ where: { id: file.id }, data: { folderId: target?.id ?? null, slug }, include: FILE_INCLUDE });
      await audit(actorOf(req), 'FILE_MOVE', { type: 'file', id: file.id }, { from: file.folderId, to: target?.id ?? null });
      const serialized = serializeFile(updated);
      await emitWebhookEvent('file.updated', { file: serialized });
      return serialized;
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/files/:id/copy',
    tag: 'Files',
    summary: 'Copy a file',
    description: 'Creates a new file record with the same content. File content is immutable, so the stored object is shared.',
    auth: 'any',
    permission: ['files.edit', 'files.upload'],
    scope: ['files:update', 'files:upload'],
    params: fileId,
    body: z.object({ folder_id: folderRef.nullable().optional(), name: z.string().min(1).max(255).optional() }),
    responses: { 201: { description: 'The new copy', example: FILE_EXAMPLE } },
    errors: ['file_not_found', 'folder_not_found'],
    async handler({ req, reply, params, body }) {
      const file = await requireFile(req, params.id);
      const targetFolderId =
        body.folder_id === undefined ? file.folderId : body.folder_id && body.folder_id !== 'root' ? (await requireFolder(req, body.folder_id)).id : null;
      let name = file.name;
      if (body.name) {
        try {
          name = normalizeName(body.name, 'file');
        } catch {
          throw new AppError('validation_failed', 'Invalid file name.');
        }
      }
      const slug = await uniqueFileSlug(targetFolderId, name);
      const copy = await copyFile(file, { folderId: targetFolderId, name, slug, userId: userIdOf(req), apiKeyId: apiKeyIdOf(req) });
      const full = await getPrisma().file.findUniqueOrThrow({ where: { id: copy.id }, include: FILE_INCLUDE });
      await audit(actorOf(req), 'FILE_COPY', { type: 'file', id: copy.id }, { source: file.id, folder_id: targetFolderId });
      reply.code(201);
      return serializeFile(full);
    },
  }),
  defineRoute({
    method: 'GET',
    url: '/api/v1/files/:id/download',
    tag: 'Files',
    summary: 'Download a file',
    description:
      'Downloads the file content regardless of its visibility (authorised callers only). Supports `Range`, `If-None-Match` and `If-Modified-Since`. Responses are always `Cache-Control: private`.',
    auth: 'any',
    permission: 'files.download',
    scope: 'files:read',
    params: fileId,
    query: z.object({ disposition: z.enum(['inline', 'attachment']).default('attachment') }),
    responses: {
      200: { description: 'File content', contentType: 'application/octet-stream' },
      206: { description: 'Partial content (range request)', contentType: 'application/octet-stream' },
      304: { description: 'Not modified' },
    },
    errors: ['file_not_found', 'file_not_ready', 'range_not_satisfiable'],
    async handler({ req, reply, params, query }) {
      const file = await requireFile(req, params.id);
      if (file.status !== 'READY') throw new AppError('file_not_ready', `The file is ${file.status.toLowerCase()}.`);
      return sendFile(req, reply, file, { disposition: query.disposition, privateResponse: true });
    },
  }),
  defineRoute({
    method: 'GET',
    url: '/api/v1/files/:id/metadata',
    tag: 'Files',
    summary: 'Get file metadata',
    description: 'Technical metadata (type, size, checksum, dimensions, duration, scan state) plus custom metadata.',
    auth: 'any',
    permission: 'files.view',
    scope: 'metadata:read',
    params: fileId,
    responses: {
      200: {
        description: 'Metadata',
        example: {
          id: 'file_01J9Z8Q4X5K3W2V1T0S9R8Q7P6',
          name: 'clip.mp4',
          mime_type: 'video/mp4',
          size: 1048576,
          sha256: '9f86d0…',
          width: 1920,
          height: 1080,
          duration_seconds: 12.5,
          status: 'READY',
          scanned_at: null,
          custom: { campaign: 'spring' },
        },
      },
    },
    errors: ['file_not_found'],
    async handler({ req, params }) {
      const f = await requireFile(req, params.id);
      return {
        id: f.id,
        name: f.name,
        mime_type: f.mimeType,
        extension: f.extension,
        size: Number(f.size),
        sha256: f.sha256,
        width: f.width,
        height: f.height,
        duration_seconds: f.durationSeconds,
        status: f.status,
        status_reason: f.statusReason,
        scanned_at: f.scannedAt?.toISOString() ?? null,
        created_at: f.createdAt.toISOString(),
        custom: f.metadata,
      };
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/files/:id/signed-url',
    tag: 'Signed URLs',
    summary: 'Create a signed URL',
    description:
      'Returns a time-limited URL that grants read access to the file without other credentials. The URL is signed with HMAC-SHA256; altering the file id, expiry or disposition invalidates it.',
    auth: 'any',
    permission: 'files.download',
    scope: 'files:read',
    params: fileId,
    body: z.object({
      expires_in: z.number().int().min(10).optional().describe('Lifetime in seconds (default from settings).'),
      disposition: z.enum(['inline', 'attachment']).default('inline'),
    }),
    responses: {
      200: {
        description: 'Signed URL',
        example: {
          url: 'https://cdn.example.com/files/file_01J9Z8Q4X5K3W2V1T0S9R8Q7P6?expires=1767225600&kv=1&disposition=inline&sig=3q2-7w…',
          expires_at: '2026-01-01T00:00:00.000Z',
          expires_in: 300,
        },
      },
    },
    errors: ['file_not_found', 'file_not_ready', 'validation_failed'],
    async handler({ req, params, body }) {
      const file = await requireFile(req, params.id);
      if (file.status !== 'READY') throw new AppError('file_not_ready');
      const settings = await getSettings();
      const expiresIn = body.expires_in ?? settings.files.signedUrlDefaultExpiry;
      if (expiresIn > settings.files.signedUrlMaxExpiry) {
        throw new AppError('validation_failed', `expires_in must be at most ${settings.files.signedUrlMaxExpiry} seconds.`);
      }
      const signed = signFileUrl(getKeyring(), file.id, expiresIn, { disposition: body.disposition });
      await audit(actorOf(req), 'SIGNED_URL_CREATED', { type: 'file', id: file.id }, { expires_in: expiresIn });
      return { url: `${env().CDN_URL}/files/${file.id}?${signed.query}`, expires_at: new Date(signed.expires * 1000).toISOString(), expires_in: expiresIn };
    },
  }),
];
