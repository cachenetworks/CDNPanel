import type { FastifyInstance } from 'fastify';
import { registerRoutes } from '../http/route.js';
import { healthRoutes } from './health.js';
import { authRoutes } from './auth.js';
import { meRoutes } from './me.js';
import { fileRoutes } from './files.js';
import { folderRoutes } from './folders.js';
import { uploadRoutes } from './uploads.js';
import { apiKeyRoutes } from './apiKeys.js';
import { analyticsRoutes } from './analytics.js';
import { aiRoutes } from './ai.js';
import { userRoutes } from './users.js';
import { roleRoutes } from './roles.js';
import { securityRoutes } from './security.js';
import { settingsRoutes } from './settings.js';
import { storageRoutes } from './storage.js';
import { nodeRoutes } from './nodes.js';
import { webhookRoutes } from './webhooks.js';
import { deliveryRoutes } from './delivery.js';
import { zoneRoutes } from './zones.js';
import { cacheRoutes } from './cache.js';
import { imageRoutes } from './images.js';
import { mediaRoutes } from './media.js';
import { shareRoutes } from './shares.js';
import { versionRoutes } from './versions.js';
import { edgeSecurityRoutes } from './edgeSecurity.js';
import { identityRoutes } from './identity.js';
import { usageRoutes } from './usage.js';
import { platformRoutes } from './platform.js';
import { opsRoutes } from './ops.js';

/**
 * All v1 routes. A future /api/v2 can register its own route set alongside this one;
 * shared services stay version-agnostic.
 */
export const ALL_ROUTES = [
  ...healthRoutes,
  ...meRoutes,
  ...authRoutes,
  ...fileRoutes,
  ...uploadRoutes,
  ...folderRoutes,
  ...apiKeyRoutes,
  ...analyticsRoutes,
  ...aiRoutes,
  ...userRoutes,
  ...roleRoutes,
  ...securityRoutes,
  ...settingsRoutes,
  ...storageRoutes,
  ...nodeRoutes,
  ...webhookRoutes,
  ...zoneRoutes,
  ...cacheRoutes,
  ...imageRoutes,
  ...mediaRoutes,
  ...shareRoutes,
  ...versionRoutes,
  ...edgeSecurityRoutes,
  ...identityRoutes,
  ...usageRoutes,
  ...platformRoutes,
  ...opsRoutes,
  ...deliveryRoutes,
];

export async function registerAllRoutes(app: FastifyInstance): Promise<void> {
  registerRoutes(app, ALL_ROUTES);
}
