import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import { getPrisma, type Quota } from '@cdn/database';
import { AppError, isValidId, newId } from '@cdn/shared';
import { defineRoute, type RouteDef } from '../http/route.js';
import { actorOf } from '../http/context.js';
import { audit } from '../lib/audit.js';
import { getZones } from '../lib/zones.js';
import { costEstimate, invalidateQuotas, metricValue, METRICS, monthStart, SCOPE_TYPES, usageFor, type Metric, type Scope, type ScopeType } from '../services/usage.js';

function serializeQuota(q: Quota, used?: number) {
  const limit = Number(q.limit);
  return {
    id: q.id,
    object: 'quota' as const,
    scope_type: q.scopeType,
    scope_id: q.scopeId,
    metric: q.metric,
    limit,
    hard: q.hard,
    thresholds: q.thresholds,
    alerted_percent: q.alertedPercent,
    period_start: q.periodStart.toISOString(),
    used: used ?? null,
    percent: used !== undefined && limit > 0 ? Math.round((used / limit) * 1000) / 10 : null,
  };
}

/** Project-bound API keys may only read their own project's usage. */
function assertScopeAllowed(req: FastifyRequest, scope: Scope, zoneProject?: string): void {
  if (req.auth?.type !== 'api_key' || !req.auth.apiKey.projectId) return;
  const own = req.auth.apiKey.projectId;
  const ok = (scope.type === 'project' && scope.id === own) || (scope.type === 'zone' && zoneProject === own) || (scope.type === 'api_key' && scope.id === req.auth.apiKey.id);
  if (!ok) throw new AppError('forbidden', 'This API key can only read usage for its own project.');
}

export const usageRoutes: RouteDef<any, any, any>[] = [
  defineRoute({
    method: 'GET',
    url: '/api/v1/usage',
    tag: 'Usage',
    summary: 'Usage for a scope',
    description:
      'Month-to-date usage (UTC) for the platform, a project, a zone or an API key: storage, egress, requests, image transformations, uploads and transformation CPU time, with quotas and a cost estimate based on each storage provider’s configured prices.',
    auth: 'any',
    permission: 'usage.view',
    scope: 'usage:read',
    query: z.object({ scope_type: z.enum(SCOPE_TYPES).default('global'), scope_id: z.string().max(64).default('') }),
    responses: {
      200: {
        description: 'Usage',
        example: {
          scope: { type: 'project', id: 'prj_…' },
          period_start: '2026-10-01T00:00:00.000Z',
          usage: { storage_bytes: 52428800000, egress_bytes: 90194313216, requests: 1834201, transforms: 12093, upload_bytes: 1073741824, cpu_ms: 402911 },
          quotas: [],
          cost: { currency: 'USD', total: 1.21, lines: [] },
        },
      },
    },
    async handler({ req, query }) {
      const scope: Scope = { type: query.scope_type as ScopeType, id: query.scope_type === 'global' ? '' : query.scope_id };
      const reg = await getZones();
      assertScopeAllowed(req, scope, scope.type === 'zone' ? reg.byId.get(scope.id)?.projectId : undefined);
      const since = monthStart();
      const [usage, quotas, cost] = await Promise.all([usageFor(scope, since), getPrisma().quota.findMany({ where: { scopeType: scope.type, scopeId: scope.id } }), costEstimate(scope, since)]);
      return {
        scope,
        period_start: since.toISOString(),
        usage,
        quotas: quotas.map((q) => serializeQuota(q, usage[q.metric as Metric])),
        cost,
      };
    },
  }),
  defineRoute({
    method: 'GET',
    url: '/api/v1/usage/overview',
    tag: 'Usage',
    summary: 'Usage by project and zone',
    auth: 'session',
    permission: 'usage.view',
    async handler() {
      const since = monthStart();
      const reg = await getZones();
      const projects = await getPrisma().project.findMany({ orderBy: { name: 'asc' } });
      const [global, projectRows, zoneRows] = await Promise.all([
        usageFor({ type: 'global', id: '' }, since),
        Promise.all(projects.map(async (p) => ({ id: p.id, name: p.name, usage: await usageFor({ type: 'project', id: p.id }, since), cost: (await costEstimate({ type: 'project', id: p.id }, since)).total }))),
        Promise.all(reg.zones.map(async (z) => ({ id: z.id, name: z.name, project_id: z.projectId, usage: await usageFor({ type: 'zone', id: z.id }, since) }))),
      ]);
      const quotas = await getPrisma().quota.findMany();
      const withUsage = await Promise.all(quotas.map(async (q) => serializeQuota(q, await metricValue({ type: q.scopeType as ScopeType, id: q.scopeId }, q.metric as Metric, since))));
      const cost = await costEstimate({ type: 'global', id: '' }, since);
      return { period_start: since.toISOString(), global, projects: projectRows, zones: zoneRows, quotas: withUsage, cost };
    },
  }),
  defineRoute({
    method: 'GET',
    url: '/api/v1/quotas',
    tag: 'Usage',
    summary: 'List quotas',
    auth: 'session',
    permission: 'usage.view',
    async handler() {
      const since = monthStart();
      const rows = await getPrisma().quota.findMany({ orderBy: [{ scopeType: 'asc' }, { metric: 'asc' }] });
      return { data: await Promise.all(rows.map(async (q) => serializeQuota(q, await metricValue({ type: q.scopeType as ScopeType, id: q.scopeId }, q.metric as Metric, since)))) };
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/quotas',
    tag: 'Usage',
    summary: 'Create or replace a quota',
    description:
      'Sets a monthly limit for a metric on a scope. Alerts (`quota.threshold` webhooks + audit log) fire as usage crosses each threshold percentage. Hard limits block further delivery (egress / requests / transforms) or uploads (storage / upload bytes) with `quota_exceeded`.',
    auth: 'session',
    permission: 'quotas.manage',
    body: z.object({
      scope_type: z.enum(SCOPE_TYPES),
      scope_id: z.string().max(64).default(''),
      metric: z.enum(METRICS),
      limit: z.number().int().positive(),
      hard: z.boolean().default(false),
      thresholds: z.array(z.number().int().min(1).max(1000)).max(10).default([50, 75, 90, 100]),
    }),
    responses: { 201: { description: 'Quota' } },
    errors: ['validation_failed', 'project_not_found', 'zone_not_found', 'api_key_not_found'],
    async handler({ req, reply, body }) {
      const prisma = getPrisma();
      const scopeId = body.scope_type === 'global' ? '' : body.scope_id;
      if (body.scope_type === 'project' && !(await prisma.project.findUnique({ where: { id: scopeId } }))) throw new AppError('project_not_found');
      if (body.scope_type === 'zone' && !(await prisma.zone.findUnique({ where: { id: scopeId } }))) throw new AppError('zone_not_found');
      if (body.scope_type === 'api_key' && (!isValidId('apiKey', scopeId) || !(await prisma.apiKey.findUnique({ where: { id: scopeId } })))) throw new AppError('api_key_not_found');
      const thresholds = [...new Set(body.thresholds)].sort((a, b) => a - b);
      const q = await prisma.quota.upsert({
        where: { scopeType_scopeId_metric: { scopeType: body.scope_type, scopeId, metric: body.metric } },
        create: { id: newId('quota'), scopeType: body.scope_type, scopeId, metric: body.metric, limit: BigInt(body.limit), hard: body.hard, thresholds, periodStart: monthStart() },
        update: { limit: BigInt(body.limit), hard: body.hard, thresholds, alertedPercent: 0 },
      });
      invalidateQuotas();
      await audit(actorOf(req), 'QUOTA_CREATE', { type: 'quota', id: q.id }, { ...body, scope_id: scopeId });
      reply.code(201);
      return serializeQuota(q);
    },
  }),
  defineRoute({
    method: 'DELETE',
    url: '/api/v1/quotas/:id',
    tag: 'Usage',
    summary: 'Delete a quota',
    auth: 'session',
    permission: 'quotas.manage',
    params: z.object({ id: z.string() }),
    errors: ['not_found'],
    async handler({ req, params }) {
      const q = await getPrisma().quota.findUnique({ where: { id: params.id } });
      if (!q) throw new AppError('not_found');
      await getPrisma().quota.delete({ where: { id: q.id } });
      invalidateQuotas();
      await audit(actorOf(req), 'QUOTA_DELETE', { type: 'quota', id: q.id }, { metric: q.metric, scope: `${q.scopeType}:${q.scopeId}` });
    },
  }),
];
