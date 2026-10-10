import { Readable } from 'node:stream';
import { z } from 'zod';
import type { File } from '@cdn/database';
import { getPrisma } from '@cdn/database';
import { AppError } from '@cdn/shared';
import { defineRoute, type RouteDef } from '../http/route.js';
import { actorOf, apiKeyIdOf, userIdOf } from '../http/context.js';
import { FILE_INCLUDE, serializeFile } from '../lib/serialize.js';
import { emitWebhookEvent } from '../lib/webhooks.js';
import { zoneForFolder } from '../lib/zones.js';
import { requireFile } from '../services/files.js';
import { replaceFileContent } from '../services/ingest.js';
import { openFileStream } from '../services/replication.js';
import { MAX_EDITABLE_BYTES, decodeText, isEditableType } from '../lib/textFiles.js';

function assertEditable(file: File): void {
  if (file.status !== 'READY') throw new AppError('file_not_ready', `The file is ${file.status.toLowerCase()}.`);
  if (!isEditableType(file)) throw new AppError('validation_failed', 'Only text files can be edited in the browser.');
  if (Number(file.size) > MAX_EDITABLE_BYTES) throw new AppError('validation_failed', `Files over ${MAX_EDITABLE_BYTES / 1024 / 1024} MB cannot be edited in the browser.`);
}

const fileParams = z.object({ id: z.string().max(64) });

export const editorRoutes: RouteDef<any, any, any>[] = [
  defineRoute({
    method: 'GET',
    url: '/api/v1/files/:id/text',
    tag: 'Files',
    summary: 'Open a text file for editing',
    description: `Returns the content of a text file (UTF-8, up to ${MAX_EDITABLE_BYTES / 1024 / 1024} MB) together with its current \`version\`, which must be sent back when saving.`,
    auth: 'any',
    permission: 'files.view',
    scope: 'files:read',
    params: fileParams,
    responses: { 200: { description: 'Text content' } },
    errors: ['file_not_found', 'file_not_ready', 'validation_failed'],
    async handler({ req, params }) {
      const file = await requireFile(req, params.id);
      assertEditable(file);
      const { stream } = await openFileStream(file, null);
      const parts: Buffer[] = [];
      let size = 0;
      for await (const c of stream) {
        const b = Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array);
        size += b.length;
        if (size > MAX_EDITABLE_BYTES) {
          stream.destroy();
          throw new AppError('validation_failed', 'The file is too large to edit in the browser.');
        }
        parts.push(b);
      }
      const content = decodeText(Buffer.concat(parts));
      if (content === null) throw new AppError('validation_failed', 'This file is not valid UTF-8 text, so it cannot be edited in the browser.');
      return { id: file.id, name: file.name, mime_type: file.mimeType, extension: file.extension, version: file.version, sha256: file.sha256, size: Number(file.size), content, max_bytes: MAX_EDITABLE_BYTES };
    },
  }),
  defineRoute({
    method: 'PUT',
    url: '/api/v1/files/:id/text',
    tag: 'Files',
    summary: 'Save an edited text file',
    description:
      'Saves new text content as a new revision: the file keeps its id and URLs, the previous content stays in the revision history, and edge caches are purged. `base_version` must be the version that was opened; if the file changed in the meantime the save is rejected with `conflict`.',
    auth: 'any',
    permission: ['files.edit', 'files.upload'],
    scope: ['files:update', 'files:upload'],
    params: fileParams,
    body: z.object({ content: z.string(), base_version: z.number().int().min(1) }),
    bodyLimit: MAX_EDITABLE_BYTES * 2 + 64 * 1024,
    responses: { 200: { description: 'Updated file' } },
    errors: ['file_not_found', 'file_not_ready', 'validation_failed', 'conflict', 'quota_exceeded'],
    async handler({ req, params, body }) {
      const file = await requireFile(req, params.id);
      assertEditable(file);
      if (file.version !== body.base_version) {
        throw new AppError('conflict', `This file was changed after you opened it (now version ${file.version}). Reload it to see the latest content.`);
      }
      const buf = Buffer.from(body.content, 'utf8');
      if (buf.length > MAX_EDITABLE_BYTES) throw new AppError('validation_failed', `Edited content is over ${MAX_EDITABLE_BYTES / 1024 / 1024} MB.`);
      await replaceFileContent(file, {
        stream: Readable.from([buf]),
        filename: file.name,
        declaredSize: buf.length,
        userId: userIdOf(req),
        apiKeyId: apiKeyIdOf(req),
        actor: actorOf(req),
      });
      const full = await getPrisma().file.findUniqueOrThrow({ where: { id: file.id }, include: FILE_INCLUDE });
      const zone = await zoneForFolder(file.folderId);
      await emitWebhookEvent('file.version_created', { file: serializeFile(full), previous_version: file.version }, { projectId: zone?.projectId });
      return serializeFile(full);
    },
  }),
];
