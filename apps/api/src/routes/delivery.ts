import { z } from 'zod';
import { getPrisma } from '@cdn/database';
import { AppError, isValidId } from '@cdn/shared';
import { defineRoute, type RouteDef } from '../http/route.js';
import { getSettings } from '../lib/settings.js';
import { authorizeDelivery, sendFile } from '../services/delivery.js';

const deliveryQuery = z.object({
  expires: z.string().optional().describe('Signed URL expiry (unix seconds).'),
  kv: z.string().optional().describe('Signing key version.'),
  disposition: z.enum(['inline', 'attachment']).optional(),
  sig: z.string().optional().describe('Signed URL signature.'),
  download: z.enum(['1', 'true']).optional().describe('Serve as an attachment.'),
});

export const deliveryRoutes: RouteDef<any, any, any>[] = [
  defineRoute({
    method: 'GET',
    url: '/files/:id',
    tag: 'Delivery',
    summary: 'Serve a file (CDN)',
    description:
      'Public CDN delivery endpoint (also answers `HEAD`). Public files are served to anyone. Private / authenticated files require an `Authorization: Bearer` API key or a valid signed URL; `SIGNED_URL_ONLY` files require a signed URL. Supports `Range` (206), `If-None-Match` / `If-Modified-Since` (304), `If-Range`, `ETag` (SHA-256), `Last-Modified`, per-file `Cache-Control` and `Content-Disposition`.',
    auth: 'public',
    params: z.object({ id: z.string().max(64) }),
    query: deliveryQuery,
    responses: {
      200: { description: 'File content', contentType: 'application/octet-stream' },
      206: { description: 'Partial content', contentType: 'application/octet-stream' },
      304: { description: 'Not modified' },
    },
    errors: ['file_not_found', 'invalid_id', 'unauthenticated', 'invalid_signature', 'signature_expired', 'range_not_satisfiable', 'rate_limited'],
    async handler({ req, reply, params, query }) {
      if (!isValidId('file', params.id)) throw new AppError('invalid_id', 'The file id is malformed.');
      const file = await getPrisma().file.findUnique({ where: { id: params.id } });
      if (!file || file.status !== 'READY') throw new AppError('file_not_found');
      const { signedDisposition } = authorizeDelivery(req, file);
      const disposition = query.download ? 'attachment' : (signedDisposition ?? 'inline');
      return sendFile(req, reply, file, { disposition });
    },
  }),
  defineRoute({
    method: 'GET',
    url: '/p/*',
    tag: 'Delivery',
    summary: 'Serve a file by friendly path',
    description:
      'Friendly URLs such as `https://cdn.example.com/p/assets/logo.png` resolve the folder path and file slug. Only enabled when "friendly paths" is on in settings. Visibility rules are identical to `/files/{id}`.',
    auth: 'public',
    query: deliveryQuery,
    responses: { 200: { description: 'File content', contentType: 'application/octet-stream' } },
    errors: ['file_not_found', 'unauthenticated', 'invalid_signature'],
    async handler({ req, reply, query }) {
      const settings = await getSettings();
      const raw = (req.params as { '*': string })['*'] ?? '';
      if (!settings.files.enableFriendlyPaths || !raw) throw new AppError('not_found');
      let segments: string[];
      try {
        segments = raw.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
      } catch {
        throw new AppError('not_found');
      }
      if (segments.length === 0 || segments.length > 32) throw new AppError('not_found');
      if (segments.some((s) => s === '.' || s === '..' || s.includes('\0') || s.length > 255)) throw new AppError('not_found');
      const slug = segments.pop()!;
      const prisma = getPrisma();
      let folderId: string | null = null;
      if (segments.length > 0) {
        const folder = await prisma.folder.findUnique({ where: { path: `/${segments.join('/')}` } });
        if (!folder) throw new AppError('file_not_found');
        folderId = folder.id;
      }
      const file = await prisma.file.findFirst({ where: { folderId, slug, status: 'READY' }, orderBy: { createdAt: 'desc' } });
      if (!file) throw new AppError('file_not_found');
      const { signedDisposition } = authorizeDelivery(req, file);
      return sendFile(req, reply, file, { disposition: query.download ? 'attachment' : (signedDisposition ?? 'inline') });
    },
  }),
];
