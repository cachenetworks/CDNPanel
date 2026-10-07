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
import { userRoutes } from './users.js';
import { roleRoutes } from './roles.js';
import { securityRoutes } from './security.js';
import { settingsRoutes } from './settings.js';
import { storageRoutes } from './storage.js';
import { webhookRoutes } from './webhooks.js';
import { deliveryRoutes } from './delivery.js';

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
  ...userRoutes,
  ...roleRoutes,
  ...securityRoutes,
  ...settingsRoutes,
  ...storageRoutes,
  ...webhookRoutes,
  ...deliveryRoutes,
];

export async function registerAllRoutes(app: FastifyInstance): Promise<void> {
  registerRoutes(app, ALL_ROUTES);
}
