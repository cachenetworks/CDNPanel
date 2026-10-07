import type { RouteDef } from '../http/route.js';
import { defineRoute } from '../http/route.js';
import { getPrisma } from '@cdn/database';

export const meRoutes: RouteDef<any, any, any>[] = [
  defineRoute({
    method: 'GET',
    url: '/api/v1/me',
    tag: 'Account',
    summary: 'Identify the caller',
    description: 'Returns the authenticated principal: for API keys the key metadata and granted scopes; for staff sessions the user, roles and permissions. Useful for verifying a key works.',
    auth: 'any',
    allowAnyApiKey: true,
    allowDuringMfaEnrollment: true,
    responses: {
      200: {
        description: 'Principal',
        example: {
          type: 'api_key',
          api_key: { id: 'key_01J9Z8Q4X5K3W2V1T0S9R8Q7P6', name: 'CI uploader', prefix: 'cdn_live_a82f', environment: 'live' },
          scopes: ['files:read', 'files:upload'],
        },
      },
    },
    errors: ['unauthenticated', 'invalid_api_key', 'api_key_revoked', 'api_key_expired'],
    async handler({ auth }) {
      if (auth!.type === 'api_key') {
        const key = await getPrisma().apiKey.findUnique({ where: { id: auth!.apiKey.id }, select: { expiresAt: true, rateLimit: true } });
        return {
          type: 'api_key',
          api_key: {
            id: auth!.apiKey.id,
            name: auth!.apiKey.name,
            prefix: auth!.apiKey.prefix,
            environment: auth!.apiKey.environment.toLowerCase(),
            expires_at: key?.expiresAt?.toISOString() ?? null,
            rate_limit: key?.rateLimit ?? null,
          },
          scopes: [...auth!.scopes].sort(),
        };
      }
      return {
        type: 'user',
        user: { id: auth!.user.id, email: auth!.user.email, name: auth!.user.name, two_factor_enabled: auth!.user.totpEnabled },
        roles: auth!.roleNames,
        permissions: [...auth!.permissions].sort(),
      };
    },
  }),
];
