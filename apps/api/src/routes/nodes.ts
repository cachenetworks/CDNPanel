import { z } from 'zod';
import { getPrisma, type StorageNode } from '@cdn/database';
import { RAID_LEVELS, raidGeometry, raidUsableBytes, validateRaidLayout, type RaidLevel } from '@cdn/storage';
import { AppError, isValidId, newId } from '@cdn/shared';
import { defineRoute, type RouteDef } from '../http/route.js';
import { actorOf } from '../http/context.js';
import { audit } from '../lib/audit.js';
import { enqueuePoolRepair } from '../lib/queue.js';
import { encryptProviderConfig } from '../lib/storageRegistry.js';
import {
  encryptNodeToken,
  loadPool,
  nodeDriver,
  poolConfig,
  poolFreeBytes,
  poolUsableBytes,
  probeNode,
  resolveLocalNodePath,
  syncPoolProvider,
  type RebuildState,
} from '../services/storageNodes.js';

const nodeParams = z.object({ id: z.string().refine((v) => isValidId('storageNode', v), 'invalid node id') });
const poolParams = z.object({ id: z.string().refine((v) => isValidId('storagePool', v), 'invalid pool id') });
const num = (v: bigint | null) => (v === null ? null : Number(v));

const LEVEL_INFO: Record<RaidLevel, string> = {
  RAID0: 'Striping across every node. Fastest and uses all space, but losing any node loses the data.',
  RAID1: 'Every node holds a full copy. Survives all but one node failing; usable space is one node.',
  RAID5: 'Striping with rotating parity. Survives one node failing; usable space is all but one node.',
  RAID6: 'Striping with double parity. Survives two nodes failing; usable space is all but two nodes.',
  RAID10: 'Mirrored pairs, striped. Survives one failure per pair; usable space is half the nodes.',
};

function serializeNode(n: StorageNode & { memberships?: { poolId: string; position: number }[] }) {
  return {
    id: n.id,
    object: 'storage_node' as const,
    name: n.name,
    kind: n.kind,
    url: n.kind === 'REMOTE' ? n.url : null,
    path: n.kind === 'LOCAL' ? n.path : null,
    region: n.region,
    enabled: n.enabled,
    status: n.enabled ? n.status : 'disabled',
    total_bytes: num(n.totalBytes),
    free_bytes: num(n.freeBytes),
    used_bytes: n.totalBytes !== null && n.freeBytes !== null ? Number(n.totalBytes - n.freeBytes) : null,
    latency_ms: n.latencyMs,
    agent_version: n.version,
    last_seen_at: n.lastSeenAt,
    last_error: n.lastError,
    pools: (n.memberships ?? []).map((m) => ({ pool_id: m.poolId, position: m.position })),
    created_at: n.createdAt,
  };
}

async function serializePool(poolId: string) {
  const prisma = getPrisma();
  const pool = await loadPool(poolId);
  const g = raidGeometry(pool.level as RaidLevel, pool.members.length);
  const usage = await prisma.file.aggregate({ where: { storageProviderId: pool.providerId }, _sum: { size: true }, _count: { _all: true } });
  const provider = await prisma.storageProvider.findUnique({ where: { id: pool.providerId } });
  return {
    id: pool.id,
    object: 'storage_pool' as const,
    name: pool.name,
    level: pool.level,
    level_description: LEVEL_INFO[pool.level as RaidLevel],
    status: pool.status,
    provider_id: pool.providerId,
    is_default: provider?.isDefault ?? false,
    chunk_size: pool.chunkSize,
    data_nodes: g.data,
    parity_nodes: g.parity,
    fault_tolerance: g.tolerance,
    usable_bytes: num(poolUsableBytes(pool)),
    free_bytes: poolFreeBytes(pool),
    raw_bytes: pool.members.every((m) => m.node.totalBytes !== null) ? pool.members.reduce((a, m) => a + Number(m.node.totalBytes), 0) : null,
    stored_bytes: Number(usage._sum.size ?? 0),
    file_count: usage._count._all,
    members: pool.members.map((m) => ({ position: m.position, node: serializeNode(m.node) })),
    rebuild: (pool.rebuildState as RebuildState | null) ?? null,
    created_at: pool.createdAt,
  };
}

async function assertNodesAvailable(nodeIds: string[], allowPoolId?: string) {
  const prisma = getPrisma();
  if (new Set(nodeIds).size !== nodeIds.length) throw new AppError('validation_failed', 'A node can only appear once in a pool.');
  const nodes = await prisma.storageNode.findMany({ where: { id: { in: nodeIds } }, include: { memberships: true } });
  for (const id of nodeIds) {
    const n = nodes.find((x) => x.id === id);
    if (!n) throw new AppError('not_found', `Storage node ${id} not found.`);
    if (!n.enabled) throw new AppError('validation_failed', `${n.name} is disabled.`);
    if (n.status !== 'online') throw new AppError('validation_failed', `${n.name} is not online. Test it first.`);
    if (n.memberships.some((m) => m.poolId !== allowPoolId)) throw new AppError('conflict', `${n.name} already belongs to a pool.`);
  }
  return nodeIds.map((id) => nodes.find((n) => n.id === id)!);
}

async function refreshNode(node: StorageNode) {
  const probe = await probeNode(nodeDriver(node));
  return getPrisma().storageNode.update({
    where: { id: node.id },
    data: {
      status: probe.online ? 'online' : 'offline',
      latencyMs: probe.latencyMs,
      lastError: probe.error,
      ...(probe.online ? { lastSeenAt: new Date(), totalBytes: probe.total === null ? null : BigInt(probe.total), freeBytes: probe.free === null ? null : BigInt(probe.free), version: probe.version } : {}),
    },
    include: { memberships: true },
  });
}

const nodeBody = z.object({
  name: z.string().trim().min(1).max(80),
  kind: z.enum(['REMOTE', 'LOCAL']).default('REMOTE'),
  url: z.string().url().max(500).optional(),
  token: z.string().min(32).max(512).optional(),
  path: z.string().trim().min(1).max(500).optional(),
  region: z.string().trim().max(60).default(''),
});

export const nodeRoutes: RouteDef<any, any, any>[] = [
  defineRoute({
    method: 'GET',
    url: '/api/v1/storage/nodes',
    tag: 'Storage',
    summary: 'List storage nodes',
    description: 'Servers (and local directories) that lend their disk to the CDN, with live status and disk space.',
    auth: 'session',
    permission: 'storage.manage',
    responses: { 200: { description: 'Storage nodes' } },
    async handler() {
      const nodes = await getPrisma().storageNode.findMany({ include: { memberships: true }, orderBy: { createdAt: 'asc' } });
      return { data: nodes.map(serializeNode) };
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/storage/nodes',
    tag: 'Storage',
    summary: 'Add a storage node',
    description:
      'Registers a server running the storage node agent (`REMOTE`: its URL and NODE_TOKEN) or a directory on this server (`LOCAL`). The node is contacted and must pass a write test. Requires re-authentication.',
    auth: 'session',
    permission: 'storage.manage',
    requireReauth: true,
    body: nodeBody,
    responses: { 201: { description: 'Created node' } },
    errors: ['conflict', 'validation_failed'],
    async handler({ req, reply, body }) {
      const prisma = getPrisma();
      if (await prisma.storageNode.findUnique({ where: { name: body.name } })) throw new AppError('conflict', 'A node with that name already exists.');
      const id = newId('storageNode');
      let data;
      if (body.kind === 'REMOTE') {
        if (!body.url || !body.token) throw new AppError('validation_failed', 'Remote nodes need the agent URL and its token.');
        const url = body.url.replace(/\/+$/, '');
        if (await prisma.storageNode.findFirst({ where: { url } })) throw new AppError('conflict', 'That node URL is already registered.');
        data = { url, tokenEnc: encryptNodeToken(id, body.token) };
      } else {
        if (!body.path) throw new AppError('validation_failed', 'Local nodes need a directory.');
        const path = resolveLocalNodePath(body.path);
        if (await prisma.storageNode.findFirst({ where: { path } })) throw new AppError('conflict', 'That directory is already a node.');
        data = { path };
      }
      const probe = await probeNode(nodeDriver({ id, kind: body.kind, url: data.url ?? '', path: data.path ?? '', token: body.token }));
      if (!probe.online) throw new AppError('validation_failed', `Could not use the node: ${probe.error}`);
      const node = await prisma.storageNode.create({
        data: {
          id,
          name: body.name,
          kind: body.kind,
          region: body.region,
          ...data,
          status: 'online',
          latencyMs: probe.latencyMs,
          lastSeenAt: new Date(),
          totalBytes: probe.total === null ? null : BigInt(probe.total),
          freeBytes: probe.free === null ? null : BigInt(probe.free),
          version: probe.version,
        },
        include: { memberships: true },
      });
      await audit(actorOf(req), 'STORAGE_NODE_CREATED', { type: 'storage_node', id }, { name: body.name, kind: body.kind, url: data.url, path: data.path });
      reply.code(201);
      return serializeNode(node);
    },
  }),
  defineRoute({
    method: 'PATCH',
    url: '/api/v1/storage/nodes/:id',
    tag: 'Storage',
    summary: 'Update a storage node',
    description: 'Rename, move (new URL), rotate its token, or enable/disable it. Pools using the node pick up the change immediately. Requires re-authentication.',
    auth: 'session',
    permission: 'storage.manage',
    requireReauth: true,
    params: nodeParams,
    body: z.object({ name: z.string().trim().min(1).max(80).optional(), url: z.string().url().max(500).optional(), token: z.string().min(32).max(512).optional(), region: z.string().trim().max(60).optional(), enabled: z.boolean().optional() }),
    responses: { 200: { description: 'Updated node' } },
    errors: ['not_found', 'conflict', 'validation_failed'],
    async handler({ req, params, body }) {
      const prisma = getPrisma();
      const node = await prisma.storageNode.findUnique({ where: { id: params.id }, include: { memberships: true } });
      if (!node) throw new AppError('not_found', 'Storage node not found.');
      if ((body.url || body.token) && node.kind !== 'REMOTE') throw new AppError('validation_failed', 'Only remote nodes have a URL and token.');
      if (body.name && body.name !== node.name && (await prisma.storageNode.findUnique({ where: { name: body.name } }))) throw new AppError('conflict', 'A node with that name already exists.');
      const url = body.url?.replace(/\/+$/, '');
      if (url || body.token) {
        const probe = await probeNode(nodeDriver({ ...node, url: url ?? node.url, token: body.token }));
        if (!probe.online) throw new AppError('validation_failed', `Could not use the node with the new settings: ${probe.error}`);
      }
      const updated = await prisma.storageNode.update({
        where: { id: node.id },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.region !== undefined ? { region: body.region } : {}),
          ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
          ...(url ? { url } : {}),
          ...(body.token ? { tokenEnc: encryptNodeToken(node.id, body.token) } : {}),
        },
        include: { memberships: true },
      });
      const refreshed = body.enabled === false ? updated : await refreshNode(updated);
      for (const m of node.memberships) await syncPoolProvider(m.poolId);
      await audit(actorOf(req), 'STORAGE_NODE_UPDATED', { type: 'storage_node', id: node.id }, { ...body, token: body.token ? '[rotated]' : undefined });
      return serializeNode(refreshed);
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/storage/nodes/:id/test',
    tag: 'Storage',
    summary: 'Test a storage node',
    description: 'Contacts the node now: reachability, a write test and disk space.',
    auth: 'session',
    permission: 'storage.manage',
    params: nodeParams,
    responses: { 200: { description: 'Node after the test' } },
    errors: ['not_found'],
    async handler({ params }) {
      const node = await getPrisma().storageNode.findUnique({ where: { id: params.id } });
      if (!node) throw new AppError('not_found', 'Storage node not found.');
      const refreshed = await refreshNode(node);
      for (const m of refreshed.memberships) await syncPoolProvider(m.poolId);
      return serializeNode(refreshed);
    },
  }),
  defineRoute({
    method: 'DELETE',
    url: '/api/v1/storage/nodes/:id',
    tag: 'Storage',
    summary: 'Remove a storage node',
    description: 'Forgets a node. Nodes that are part of a pool must be replaced in the pool first. Data on the node is not touched. Requires re-authentication.',
    auth: 'session',
    permission: 'storage.manage',
    requireReauth: true,
    params: nodeParams,
    responses: { 204: { description: 'Removed' } },
    errors: ['not_found', 'conflict'],
    async handler({ req, params }) {
      const prisma = getPrisma();
      const node = await prisma.storageNode.findUnique({ where: { id: params.id }, include: { memberships: true } });
      if (!node) throw new AppError('not_found', 'Storage node not found.');
      if (node.memberships.length) throw new AppError('conflict', 'This node is part of a pool. Replace it in the pool first.');
      await prisma.storageNode.delete({ where: { id: node.id } });
      await audit(actorOf(req), 'STORAGE_NODE_DELETED', { type: 'storage_node', id: node.id }, { name: node.name });
    },
  }),

  // ─── Pools ────────────────────────────────────────────────────────────────

  defineRoute({
    method: 'GET',
    url: '/api/v1/storage/pools',
    tag: 'Storage',
    summary: 'List RAID pools',
    description: 'Pools combine storage nodes into one storage provider using RAID 0, 1, 5, 6 or 10.',
    auth: 'session',
    permission: 'storage.manage',
    responses: { 200: { description: 'Pools' } },
    async handler() {
      const pools = await getPrisma().storagePool.findMany({ orderBy: { createdAt: 'asc' }, select: { id: true } });
      return { data: await Promise.all(pools.map((p) => serializePool(p.id))), levels: RAID_LEVELS.map((l) => ({ level: l, description: LEVEL_INFO[l], min_nodes: raidGeometry(l, 2).minMembers })) };
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/storage/pools',
    tag: 'Storage',
    summary: 'Create a RAID pool',
    description:
      'Combines online, unassigned nodes into a pool. The pool becomes a storage provider: make it the default, or point zones at it, to store files on it. Node order sets the RAID slots (for RAID10, consecutive nodes form mirrored pairs). Requires re-authentication.',
    auth: 'session',
    permission: 'storage.manage',
    requireReauth: true,
    body: z.object({
      name: z.string().trim().min(1).max(80),
      level: z.enum(['RAID0', 'RAID1', 'RAID5', 'RAID6', 'RAID10']),
      node_ids: z.array(z.string().refine((v) => isValidId('storageNode', v), 'invalid node id')).min(1).max(32),
      chunk_size_kb: z.number().int().min(64).max(16_384).refine((v) => v % 4 === 0, 'must be a multiple of 4').default(1024),
    }),
    responses: { 201: { description: 'Created pool' } },
    errors: ['conflict', 'validation_failed', 'not_found'],
    async handler({ req, reply, body }) {
      const prisma = getPrisma();
      const problem = validateRaidLayout(body.level, body.node_ids.length);
      if (problem) throw new AppError('validation_failed', problem);
      if (await prisma.storagePool.findUnique({ where: { name: body.name } })) throw new AppError('conflict', 'A pool with that name already exists.');
      if (await prisma.storageProvider.findUnique({ where: { name: body.name } })) throw new AppError('conflict', 'A storage provider with that name already exists.');
      const nodes = await assertNodesAvailable(body.node_ids);
      const poolId = newId('storagePool');
      const providerId = newId('storageProvider');
      const chunkSize = body.chunk_size_kb * 1024;
      const draft = {
        id: poolId,
        name: body.name,
        level: body.level,
        chunkSize,
        providerId,
        status: 'healthy',
        rebuildState: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        members: nodes.map((node, position) => ({ id: '', poolId, nodeId: node.id, position, addedAt: new Date(), node })),
      };
      await prisma.$transaction(async (tx) => {
        await tx.storageProvider.create({
          data: {
            id: providerId,
            name: body.name,
            kind: 'POOL',
            configEnc: encryptProviderConfig(providerId, { kind: 'POOL', pool: poolConfig(draft as never) }),
            publicInfo: { pool_id: poolId, level: body.level, nodes: String(nodes.length) },
          },
        });
        await tx.storagePool.create({ data: { id: poolId, name: body.name, level: body.level, chunkSize, providerId, status: 'healthy' } });
        await tx.storagePoolMember.createMany({ data: nodes.map((n, position) => ({ id: newId('poolMember'), poolId, nodeId: n.id, position })) });
      });
      await syncPoolProvider(poolId);
      await audit(actorOf(req), 'STORAGE_POOL_CREATED', { type: 'storage_pool', id: poolId }, { name: body.name, level: body.level, nodes: body.node_ids });
      reply.code(201);
      return serializePool(poolId);
    },
  }),
  defineRoute({
    method: 'GET',
    url: '/api/v1/storage/pools/:id',
    tag: 'Storage',
    summary: 'Get a RAID pool',
    description: 'Pool health, capacity, members and rebuild progress.',
    auth: 'session',
    permission: 'storage.manage',
    params: poolParams,
    responses: { 200: { description: 'Pool' } },
    errors: ['not_found'],
    async handler({ params }) {
      return serializePool(params.id);
    },
  }),
  defineRoute({
    method: 'PATCH',
    url: '/api/v1/storage/pools/:id',
    tag: 'Storage',
    summary: 'Rename a RAID pool',
    description: 'Renames the pool and its storage provider.',
    auth: 'session',
    permission: 'storage.manage',
    params: poolParams,
    body: z.object({ name: z.string().trim().min(1).max(80) }),
    responses: { 200: { description: 'Pool' } },
    errors: ['not_found', 'conflict'],
    async handler({ req, params, body }) {
      const prisma = getPrisma();
      const pool = await loadPool(params.id);
      if (body.name !== pool.name && ((await prisma.storagePool.findUnique({ where: { name: body.name } })) || (await prisma.storageProvider.findUnique({ where: { name: body.name } })))) {
        throw new AppError('conflict', 'That name is already in use.');
      }
      await prisma.$transaction([prisma.storagePool.update({ where: { id: pool.id }, data: { name: body.name } }), prisma.storageProvider.update({ where: { id: pool.providerId }, data: { name: body.name } })]);
      await audit(actorOf(req), 'STORAGE_POOL_UPDATED', { type: 'storage_pool', id: pool.id }, { name: body.name });
      return serializePool(pool.id);
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/storage/pools/:id/members',
    tag: 'Storage',
    summary: 'Add nodes to a RAID pool',
    description:
      'Grows a pool with more online, unassigned nodes, optionally switching to another RAID level (e.g. a one-node pool plus a second node becomes RAID 1). New uploads use the new layout immediately; existing files stay readable and are moved onto it in the background. Requires re-authentication.',
    auth: 'session',
    permission: 'storage.manage',
    requireReauth: true,
    params: poolParams,
    body: z.object({
      node_ids: z.array(z.string().refine((v) => isValidId('storageNode', v), 'invalid node id')).min(1).max(31),
      level: z.enum(['RAID0', 'RAID1', 'RAID5', 'RAID6', 'RAID10']).optional(),
    }),
    responses: { 200: { description: 'Pool (reshape queued)' } },
    errors: ['not_found', 'conflict', 'validation_failed'],
    async handler({ req, params, body }) {
      const prisma = getPrisma();
      const pool = await loadPool(params.id);
      const level = (body.level ?? pool.level) as RaidLevel;
      const n = pool.members.length + body.node_ids.length;
      const problem = validateRaidLayout(level, n);
      if (problem) throw new AppError('validation_failed', problem);
      // Every existing file is re-read during the reshape, so the current nodes must all be reachable.
      if (pool.status !== 'healthy') throw new AppError('conflict', 'Bring every node in the pool back online before expanding it.');
      if ((pool.rebuildState as RebuildState | null)?.running) throw new AppError('conflict', 'A rebuild is already running on this pool. Try again when it finishes.');
      const added = await assertNodesAvailable(body.node_ids);
      if (pool.members.some((m) => body.node_ids.includes(m.nodeId))) throw new AppError('validation_failed', 'That node is already in this pool.');
      // The new layout must still hold what the pool stores today.
      const sizes = [...pool.members.map((m) => m.node.totalBytes), ...added.map((x) => x.totalBytes)];
      if (sizes.every((v) => v !== null)) {
        const usable = raidUsableBytes(level, sizes.map(Number));
        const stored = Number((await prisma.file.aggregate({ where: { storageProviderId: pool.providerId }, _sum: { size: true } }))._sum.size ?? 0);
        if (usable < stored) throw new AppError('validation_failed', `${level} over ${n} nodes would hold ${Math.floor(usable / 1e9)} GB, less than the ${Math.ceil(stored / 1e9)} GB already stored.`);
      }
      await prisma.$transaction([
        prisma.storagePoolMember.createMany({ data: added.map((node, i) => ({ id: newId('poolMember'), poolId: pool.id, nodeId: node.id, position: pool.members.length + i })) }),
        prisma.storagePool.update({ where: { id: pool.id }, data: { level } }),
        prisma.storageProvider.update({ where: { id: pool.providerId }, data: { publicInfo: { pool_id: pool.id, level, nodes: String(n) } } }),
      ]);
      await syncPoolProvider(pool.id);
      await enqueuePoolRepair({ poolId: pool.id, reason: `expanded to ${n} nodes${level !== pool.level ? ` (${pool.level} → ${level})` : ''}` });
      await audit(actorOf(req), 'STORAGE_POOL_EXPANDED', { type: 'storage_pool', id: pool.id }, { added: body.node_ids, from_level: pool.level, to_level: level, nodes: n });
      return serializePool(pool.id);
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/storage/pools/:id/members/:position/replace',
    tag: 'Storage',
    summary: 'Replace a node in a RAID pool',
    description:
      'Swaps the node in a slot for another online, unassigned node (e.g. a failed server), then rebuilds that slot from the remaining nodes in the background. The old node is released from the pool. Requires re-authentication.',
    auth: 'session',
    permission: 'storage.manage',
    requireReauth: true,
    params: z.object({ id: poolParams.shape.id, position: z.coerce.number().int().min(0).max(31) }),
    body: z.object({ node_id: z.string().refine((v) => isValidId('storageNode', v), 'invalid node id') }),
    responses: { 200: { description: 'Pool (rebuild queued)' } },
    errors: ['not_found', 'conflict', 'validation_failed'],
    async handler({ req, params, body }) {
      const prisma = getPrisma();
      const pool = await loadPool(params.id);
      const member = pool.members.find((m) => m.position === params.position);
      if (!member) throw new AppError('not_found', 'That slot does not exist in the pool.');
      if (member.nodeId === body.node_id) throw new AppError('validation_failed', 'That node is already in this slot.');
      await assertNodesAvailable([body.node_id]);
      // Losing another node while this slot is rebuilt must stay within tolerance.
      const others = pool.members.filter((m) => m.position !== params.position);
      const offline = others.filter((m) => !m.node.enabled || m.node.status === 'offline').length;
      if (offline + 1 > raidGeometry(pool.level as RaidLevel, pool.members.length).tolerance && pool.level !== 'RAID0') {
        throw new AppError('conflict', 'Too many other nodes are offline to rebuild this slot safely.');
      }
      if (pool.level === 'RAID0') throw new AppError('conflict', 'RAID0 has no redundancy, so a slot cannot be rebuilt. Move the files to another provider instead.');
      await prisma.storagePoolMember.update({ where: { id: member.id }, data: { nodeId: body.node_id, addedAt: new Date() } });
      await syncPoolProvider(pool.id);
      await enqueuePoolRepair({ poolId: pool.id, positions: [params.position], reason: `slot ${params.position + 1} replaced` });
      await audit(actorOf(req), 'STORAGE_POOL_MEMBER_REPLACED', { type: 'storage_pool', id: pool.id }, { position: params.position, old_node_id: member.nodeId, new_node_id: body.node_id });
      return serializePool(pool.id);
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/storage/pools/:id/repair',
    tag: 'Storage',
    summary: 'Rebuild or scrub a RAID pool',
    description: 'Queues a background pass that restores full redundancy. With `verify`, every shard on every node is also checked (slower; a full scrub).',
    auth: 'session',
    permission: 'storage.manage',
    params: poolParams,
    body: z.object({ verify: z.boolean().default(false) }),
    responses: { 202: { description: 'Queued' } },
    errors: ['not_found'],
    async handler({ req, reply, params, body }) {
      const pool = await loadPool(params.id);
      await enqueuePoolRepair({ poolId: pool.id, verify: body.verify, reason: body.verify ? 'manual scrub' : 'manual repair' });
      await audit(actorOf(req), 'STORAGE_POOL_REPAIR_STARTED', { type: 'storage_pool', id: pool.id }, { verify: body.verify });
      reply.code(202);
      return { queued: true };
    },
  }),
  defineRoute({
    method: 'DELETE',
    url: '/api/v1/storage/pools/:id',
    tag: 'Storage',
    summary: 'Delete a RAID pool',
    description: 'Removes an empty pool and its storage provider, releasing its nodes. Pools that still hold files, or are the default provider, cannot be deleted. Requires re-authentication.',
    auth: 'session',
    permission: 'storage.manage',
    requireReauth: true,
    params: poolParams,
    responses: { 204: { description: 'Deleted' } },
    errors: ['not_found', 'conflict'],
    async handler({ req, params }) {
      const prisma = getPrisma();
      const pool = await loadPool(params.id);
      const provider = await prisma.storageProvider.findUnique({ where: { id: pool.providerId } });
      if (provider?.isDefault) throw new AppError('conflict', 'This pool is the default storage provider. Choose another default first.');
      const [files, versions, replicas, zones] = await Promise.all([
        prisma.file.count({ where: { storageProviderId: pool.providerId } }),
        prisma.fileVersion.count({ where: { storageProviderId: pool.providerId } }),
        prisma.fileReplica.count({ where: { storageProviderId: pool.providerId } }),
        prisma.zone.count({ where: { storageProviderId: pool.providerId } }),
      ]);
      if (files + versions + replicas + zones > 0) throw new AppError('conflict', `The pool still holds ${files} file(s), ${versions} revision(s) and ${replicas} replica(s) and is used by ${zones} zone(s). Move them first.`);
      await prisma.upload.deleteMany({ where: { storageProviderId: pool.providerId } });
      await prisma.storageProvider.delete({ where: { id: pool.providerId } });
      await audit(actorOf(req), 'STORAGE_POOL_DELETED', { type: 'storage_pool', id: pool.id }, { name: pool.name });
    },
  }),
];
