'use client';
import * as React from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Layers, Network, Plus, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';
import { formatBytes, formatNumber } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Field, Input, NativeSelect } from '@/components/ui/form';
import { Badge, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, EmptyState, ErrorState, PageHeader, Panel, Section, Skeleton } from '@/components/ui/misc';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { Table, TD, TH, THead, TR } from '@/components/ui/table';
import { Stat, StatGrid, StatusDot } from '@/components/ui/stat';
import { useConfirm, useStepUp } from '@/components/confirm';

type Level = 'RAID0' | 'RAID1' | 'RAID5' | 'RAID6' | 'RAID10';

interface StorageNode {
  id: string;
  name: string;
  kind: 'REMOTE' | 'LOCAL';
  url: string | null;
  path: string | null;
  region: string;
  enabled: boolean;
  status: 'online' | 'offline' | 'unknown' | 'disabled';
  total_bytes: number | null;
  free_bytes: number | null;
  used_bytes: number | null;
  latency_ms: number | null;
  agent_version: string | null;
  last_seen_at: string | null;
  last_error: string | null;
  pools: { pool_id: string; position: number }[];
}

interface Rebuild {
  running: boolean;
  reason: string;
  verify: boolean;
  started_at: string;
  finished_at: string | null;
  scanned: number;
  repaired: number;
  failed: number;
  last_error: string | null;
}

interface Pool {
  id: string;
  name: string;
  level: Level;
  level_description: string;
  status: 'healthy' | 'degraded' | 'failed' | 'unknown';
  provider_id: string;
  is_default: boolean;
  chunk_size: number;
  data_nodes: number;
  parity_nodes: number;
  fault_tolerance: number;
  usable_bytes: number | null;
  free_bytes: number | null;
  raw_bytes: number | null;
  stored_bytes: number;
  file_count: number;
  members: { position: number; node: StorageNode }[];
  rebuild: Rebuild | null;
}

const LEVELS: { level: Level; label: string; min: number; even?: boolean; blurb: string }[] = [
  { level: 'RAID0', label: 'RAID 0 — stripe', min: 1, blurb: 'All space, fastest. No redundancy: losing any node loses data.' },
  { level: 'RAID1', label: 'RAID 1 — mirror', min: 2, blurb: 'Every node holds a full copy. Space of one node.' },
  { level: 'RAID5', label: 'RAID 5 — single parity', min: 3, blurb: 'Survives one node failing. Space of all but one node.' },
  { level: 'RAID6', label: 'RAID 6 — double parity', min: 4, blurb: 'Survives two nodes failing. Space of all but two nodes.' },
  { level: 'RAID10', label: 'RAID 10 — striped mirrors', min: 4, even: true, blurb: 'Mirrored pairs, striped. Survives one failure per pair. Half the space.' },
];

const dataNodes = (level: Level, n: number) => ({ RAID0: n, RAID1: 1, RAID5: n - 1, RAID6: n - 2, RAID10: Math.floor(n / 2) })[level];
const tolerance = (level: Level, n: number) => ({ RAID0: 0, RAID1: Math.max(0, n - 1), RAID5: 1, RAID6: 2, RAID10: 1 })[level];

function nodeTone(s: StorageNode['status']) {
  return s === 'online' ? 'ok' : s === 'offline' ? 'fail' : 'idle';
}
function poolTone(s: Pool['status']): 'success' | 'warning' | 'danger' | 'neutral' {
  return s === 'healthy' ? 'success' : s === 'degraded' ? 'warning' : s === 'failed' ? 'danger' : 'neutral';
}

function DiskBar({ total, free }: { total: number | null; free: number | null }) {
  if (total === null || free === null || total === 0) return <span className="text-xs text-muted-foreground">Unknown</span>;
  const pct = Math.min(100, Math.round(((total - free) / total) * 100));
  return (
    <div className="min-w-[140px]">
      <div className="flex justify-between text-xs tabular text-muted-foreground">
        <span>{formatBytes(total - free)} used</span>
        <span>{formatBytes(free)} free</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded bg-muted" role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Disk usage">
        <div className={pct > 90 ? 'h-full bg-destructive' : pct > 75 ? 'h-full bg-warning' : 'h-full bg-[var(--series-1)]'} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// ─── Add / edit node ─────────────────────────────────────────────────────────

function NodeDialog({ node, open, onOpenChange }: { node: StorageNode | null; open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const stepUp = useStepUp();
  const [name, setName] = React.useState('');
  const [kind, setKind] = React.useState<'REMOTE' | 'LOCAL'>('REMOTE');
  const [url, setUrl] = React.useState('');
  const [token, setToken] = React.useState('');
  const [path, setPath] = React.useState('');
  const [region, setRegion] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setName(node?.name ?? '');
      setKind(node?.kind ?? 'REMOTE');
      setUrl(node?.url ?? '');
      setToken('');
      setPath(node?.path ?? '');
      setRegion(node?.region ?? '');
    }
  }, [open, node]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader
          title={node ? `Edit ${node.name}` : 'Add storage node'}
          description="A node is another server running the CDNPanel storage agent, or a directory on this server. It is contacted and write-tested before it is saved."
        />
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            void stepUp(
              async () => {
                if (node) {
                  await api(`/storage/nodes/${node.id}`, { method: 'PATCH', body: { name, region, ...(node.kind === 'REMOTE' && url !== node.url ? { url } : {}), ...(token ? { token } : {}) } });
                } else {
                  await api('/storage/nodes', { body: kind === 'REMOTE' ? { name, kind, url, token, region } : { name, kind, path, region } });
                }
                void qc.invalidateQueries({ queryKey: ['storage-nodes'] });
                onOpenChange(false);
              },
              { title: 'Confirm storage change', successMessage: node ? 'Node updated' : 'Node added' },
            ).finally(() => setBusy(false));
          }}
        >
          <DialogBody>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name">
                <Input value={name} onChange={(e) => setName(e.target.value)} required placeholder="sydney-1" />
              </Field>
              <Field label="Type">
                <NativeSelect className="w-full" value={kind} disabled={Boolean(node)} onChange={(e) => setKind(e.target.value as 'REMOTE' | 'LOCAL')}>
                  <option value="REMOTE">Remote server (node agent)</option>
                  <option value="LOCAL">Directory on this server</option>
                </NativeSelect>
              </Field>
            </div>
            {kind === 'REMOTE' ? (
              <>
                <Field label="Agent URL" hint="Where the node agent listens. Use HTTPS or a private network (Tailscale, WireGuard) — shards travel over this link.">
                  <Input type="url" value={url} onChange={(e) => setUrl(e.target.value)} required placeholder="http://100.71.249.127:8874" />
                </Field>
                <Field label={node ? 'New token (leave empty to keep)' : 'Node token'} hint="The NODE_TOKEN set on the node. Stored encrypted; never shown again.">
                  <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} required={!node} minLength={32} autoComplete="new-password" />
                </Field>
                {!node && (
                  <p className="rounded-md bg-muted p-3 text-xs text-muted-foreground">
                    On the new server: copy <code>deploy/node/</code>, set <code>NODE_TOKEN</code> (<code>openssl rand -base64 48</code>) in its <code>.env</code>, then run <code>docker compose up -d</code>. See the{' '}
                    <Link className="underline" href="/dashboard/docs">
                      docs
                    </Link>
                    .
                  </p>
                )}
              </>
            ) : (
              <Field label="Directory" hint="Relative paths are resolved inside the allowed base directory (next to the main storage folder).">
                <Input value={path} onChange={(e) => setPath(e.target.value)} required disabled={Boolean(node)} placeholder="node-local" />
              </Field>
            )}
            <Field label="Region label (optional)">
              <Input value={region} onChange={(e) => setRegion(e.target.value)} placeholder="au-sydney" className="w-60" />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={busy}>
              {node ? 'Save' : 'Test & add node'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Create pool ─────────────────────────────────────────────────────────────

function PoolDialog({ open, onOpenChange, nodes }: { open: boolean; onOpenChange: (o: boolean) => void; nodes: StorageNode[] }) {
  const qc = useQueryClient();
  const stepUp = useStepUp();
  const [name, setName] = React.useState('');
  const [level, setLevel] = React.useState<Level>('RAID5');
  const [selected, setSelected] = React.useState<string[]>([]);
  const [chunkKb, setChunkKb] = React.useState('1024');
  const [busy, setBusy] = React.useState(false);
  const free = nodes.filter((n) => n.pools.length === 0 && n.enabled);

  React.useEffect(() => {
    if (open) {
      setName('');
      setLevel('RAID5');
      setSelected([]);
      setChunkKb('1024');
    }
  }, [open]);

  const info = LEVELS.find((l) => l.level === level)!;
  const n = selected.length;
  const chosen = selected.map((id) => nodes.find((x) => x.id === id)!).filter(Boolean);
  const sizes = chosen.map((x) => x.total_bytes);
  const usable = n && sizes.every((s) => s !== null) ? Math.min(...(sizes as number[])) * dataNodes(level, n) : null;
  const raw = sizes.every((s) => s !== null) ? (sizes as number[]).reduce((a, b) => a + b, 0) : null;
  const problem = n < info.min ? `${info.label.split(' —')[0]} needs at least ${info.min} nodes.` : info.even && n % 2 ? 'RAID 10 needs an even number of nodes.' : null;
  const move = (i: number, d: -1 | 1) => setSelected((s) => {
    const j = i + d;
    if (j < 0 || j >= s.length) return s;
    const c = [...s];
    [c[i], c[j]] = [c[j]!, c[i]!];
    return c;
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader title="Create RAID pool" description="Combine nodes into one storage provider. Files are split into chunks across the nodes with mirroring or parity, so the pool keeps working when a node goes offline." />
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            void stepUp(
              async () => {
                await api('/storage/pools', { body: { name, level, node_ids: selected, chunk_size_kb: Number(chunkKb) } });
                void qc.invalidateQueries({ queryKey: ['storage-nodes'] });
                void qc.invalidateQueries({ queryKey: ['storage'] });
                onOpenChange(false);
              },
              { title: 'Confirm storage change', successMessage: 'Pool created' },
            ).finally(() => setBusy(false));
          }}
        >
          <DialogBody>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name">
                <Input value={name} onChange={(e) => setName(e.target.value)} required placeholder="main-raid" />
              </Field>
              <Field label="RAID level">
                <NativeSelect className="w-full" value={level} onChange={(e) => setLevel(e.target.value as Level)}>
                  {LEVELS.map((l) => (
                    <option key={l.level} value={l.level}>
                      {l.label}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            </div>
            <p className="text-xs text-muted-foreground">{info.blurb}</p>
            <Field label="Nodes" hint={level === 'RAID10' ? 'Order matters: nodes 1+2, 3+4, … form mirrored pairs. Put the two halves of a pair on different servers.' : 'Only online nodes that are not already in a pool can be used.'}>
              {free.length === 0 ? (
                <p className="text-sm text-muted-foreground">No free nodes. Add nodes first.</p>
              ) : (
                <div className="space-y-1.5">
                  {free.map((node) => {
                    const idx = selected.indexOf(node.id);
                    return (
                      <div key={node.id} className="flex items-center gap-2 rounded-md border px-2 py-1.5">
                        <input
                          type="checkbox"
                          aria-label={`Use ${node.name}`}
                          checked={idx >= 0}
                          disabled={node.status !== 'online'}
                          onChange={(e) => setSelected((s) => (e.target.checked ? [...s, node.id] : s.filter((x) => x !== node.id)))}
                        />
                        <span className="w-6 text-xs tabular text-muted-foreground">{idx >= 0 ? `#${idx + 1}` : ''}</span>
                        <span className="flex-1 truncate text-sm">
                          {node.name} <span className="text-xs text-muted-foreground">{node.total_bytes !== null ? formatBytes(node.total_bytes) : ''}</span>
                        </span>
                        <StatusDot status={nodeTone(node.status)} label={<span className="text-xs text-muted-foreground">{node.status}</span>} />
                        {idx >= 0 && (
                          <>
                            <Button type="button" size="xs" variant="ghost" aria-label="Move up" onClick={() => move(idx, -1)}>
                              <ArrowUp className="h-3 w-3" />
                            </Button>
                            <Button type="button" size="xs" variant="ghost" aria-label="Move down" onClick={() => move(idx, 1)}>
                              <ArrowDown className="h-3 w-3" />
                            </Button>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </Field>
            <StatGrid>
              <Stat label="Usable space" value={usable === null ? '—' : formatBytes(usable)} sub={raw !== null && n ? `of ${formatBytes(raw)} raw` : undefined} />
              <Stat label="Survives" value={n ? `${tolerance(level, n)} node failure${tolerance(level, n) === 1 ? '' : 's'}` : '—'} />
              <Stat label="Data / parity" value={n ? `${dataNodes(level, n)} / ${level === 'RAID5' ? 1 : level === 'RAID6' ? 2 : 0}` : '—'} sub={level === 'RAID1' || level === 'RAID10' ? 'mirrored' : undefined} />
            </StatGrid>
            {chosen.length > 1 && new Set(sizes).size > 1 && <p className="text-xs text-muted-foreground">Like hardware RAID, every node contributes as much space as the smallest selected node.</p>}
            <Field label="Chunk size" hint="Larger chunks mean fewer requests per node for big files; small files automatically use smaller chunks.">
              <NativeSelect value={chunkKb} onChange={(e) => setChunkKb(e.target.value)}>
                {['256', '512', '1024', '4096'].map((v) => (
                  <option key={v} value={v}>
                    {Number(v) >= 1024 ? `${Number(v) / 1024} MiB` : `${v} KiB`}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            {problem && n > 0 && <p className="text-sm text-destructive">{problem}</p>}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={busy} disabled={Boolean(problem) || !name}>
              Create pool
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Replace a member ────────────────────────────────────────────────────────

function ReplaceDialog({ target, onClose, nodes }: { target: { pool: Pool; position: number } | null; onClose: () => void; nodes: StorageNode[] }) {
  const qc = useQueryClient();
  const stepUp = useStepUp();
  const [nodeId, setNodeId] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const free = nodes.filter((n) => n.pools.length === 0 && n.enabled && n.status === 'online');
  React.useEffect(() => setNodeId(free[0]?.id ?? ''), [target]);
  const current = target?.pool.members.find((m) => m.position === target.position)?.node;
  return (
    <Dialog open={Boolean(target)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader title={`Replace slot ${(target?.position ?? 0) + 1}${current ? ` (${current.name})` : ''}`} description="The new node takes over this slot and is rebuilt from the other nodes in the background. The pool keeps serving files while it rebuilds." />
        <DialogBody>
          {free.length === 0 ? (
            <p className="text-sm text-muted-foreground">Add an online node that is not in a pool first.</p>
          ) : (
            <Field label="Replacement node">
              <NativeSelect className="w-full" value={nodeId} onChange={(e) => setNodeId(e.target.value)}>
                {free.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.name} {n.total_bytes !== null ? `(${formatBytes(n.total_bytes)})` : ''}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={busy}
            disabled={!nodeId}
            onClick={() => {
              if (!target) return;
              setBusy(true);
              void stepUp(
                async () => {
                  await api(`/storage/pools/${target.pool.id}/members/${target.position}/replace`, { body: { node_id: nodeId } });
                  void qc.invalidateQueries({ queryKey: ['storage-nodes'] });
                  onClose();
                },
                { title: 'Confirm node replacement', successMessage: 'Node replaced — rebuild started' },
              ).finally(() => setBusy(false));
            }}
          >
            Replace & rebuild
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Pool card ───────────────────────────────────────────────────────────────

function PoolCard({ pool, onReplace }: { pool: Pool; onReplace: (position: number) => void }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const r = pool.rebuild;
  const usedPct = pool.usable_bytes && pool.free_bytes !== null ? Math.min(100, Math.round(((pool.usable_bytes - pool.free_bytes) / pool.usable_bytes) * 100)) : null;
  const repair = async (verify: boolean) => {
    try {
      await api(`/storage/pools/${pool.id}/repair`, { body: { verify } });
      toast.success(verify ? 'Full scrub queued' : 'Repair queued');
      void qc.invalidateQueries({ queryKey: ['storage-nodes'] });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  return (
    <Panel className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold">{pool.name}</h3>
            <Badge tone="outline">{pool.level.replace('RAID', 'RAID ')}</Badge>
            <Badge tone={poolTone(pool.status)}>{pool.status}</Badge>
            {pool.is_default && <Badge tone="info">Default for uploads</Badge>}
          </div>
          <p className="mt-1 max-w-2xl text-xs text-muted-foreground">{pool.level_description}</p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline">
              Manage
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onSelect={() => void repair(false)}>Repair degraded objects</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void repair(true)}>Full scrub (verify every shard)</DropdownMenuItem>
            {!pool.is_default && (
              <DropdownMenuItem
                onSelect={() =>
                  confirm({
                    title: `Store new uploads on ${pool.name}?`,
                    description: 'New uploads go to this pool. Existing files stay where they are. You can also point individual zones at the pool.',
                    requireReauth: true,
                    confirmLabel: 'Make default',
                    successMessage: 'Default provider changed',
                    action: async () => {
                      await api(`/storage/providers/${pool.provider_id}`, { method: 'PATCH', body: { is_default: true } });
                      void qc.invalidateQueries({ queryKey: ['storage-nodes'] });
                      void qc.invalidateQueries({ queryKey: ['storage'] });
                    },
                  })
                }
              >
                Make default for uploads
              </DropdownMenuItem>
            )}
            {!pool.is_default && pool.file_count === 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  destructive
                  onSelect={() =>
                    confirm({
                      title: `Delete ${pool.name}?`,
                      description: 'The pool is empty. Its nodes are released and can be reused.',
                      destructive: true,
                      requireReauth: true,
                      confirmLabel: 'Delete pool',
                      successMessage: 'Pool deleted',
                      action: async () => {
                        await api(`/storage/pools/${pool.id}`, { method: 'DELETE' });
                        void qc.invalidateQueries({ queryKey: ['storage-nodes'] });
                        void qc.invalidateQueries({ queryKey: ['storage'] });
                      },
                    })
                  }
                >
                  Delete pool
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <StatGrid className="mt-4">
        <Stat label="Usable space" value={pool.usable_bytes === null ? 'Unknown' : formatBytes(pool.usable_bytes)} sub={pool.raw_bytes !== null ? `${formatBytes(pool.raw_bytes)} raw across ${pool.members.length} nodes` : undefined} />
        <Stat label="Free" value={pool.free_bytes === null ? 'Unknown' : formatBytes(pool.free_bytes)} sub={usedPct !== null ? `${usedPct}% used` : undefined} />
        <Stat label="Stored by the CDN" value={formatBytes(pool.stored_bytes)} sub={`${formatNumber(pool.file_count)} files`} />
        <Stat label="Fault tolerance" value={`${pool.fault_tolerance} node${pool.fault_tolerance === 1 ? '' : 's'}`} sub={`${pool.data_nodes} data · ${pool.parity_nodes} parity · ${formatBytes(pool.chunk_size)} chunks`} />
      </StatGrid>

      {r && (
        <div className="mt-4 rounded-md border p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            {r.running ? <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" /> : null}
            <span className="font-medium">{r.running ? (r.verify ? 'Scrubbing' : 'Rebuilding') : r.verify ? 'Last scrub' : 'Last repair'}</span>
            <span className="text-muted-foreground">({r.reason})</span>
            <span className="tabular text-muted-foreground">
              {formatNumber(r.scanned)} checked · {formatNumber(r.repaired)} repaired{r.failed ? ` · ${formatNumber(r.failed)} failed` : ''}
            </span>
            <span className="ml-auto text-xs text-muted-foreground">{new Date(r.finished_at ?? r.started_at).toLocaleString()}</span>
          </div>
          {r.last_error && <p className="mt-1 truncate font-mono text-xs text-destructive">{r.last_error}</p>}
        </div>
      )}

      <Table className="mt-4">
        <THead>
          <tr>
            <TH className="w-14">Slot</TH>
            <TH>Node</TH>
            <TH>Status</TH>
            <TH>Disk</TH>
            <TH className="w-10" />
          </tr>
        </THead>
        <tbody>
          {pool.members.map((m) => (
            <TR key={m.position}>
              <TD className="tabular text-muted-foreground">
                #{m.position + 1}
                {pool.level === 'RAID10' && <span className="ml-1 text-[11px]">pair {Math.floor(m.position / 2) + 1}</span>}
              </TD>
              <TD className="font-medium">
                {m.node.name}
                <div className="max-w-[260px] truncate font-mono text-xs font-normal text-muted-foreground">{m.node.url ?? m.node.path}</div>
              </TD>
              <TD>
                <StatusDot status={nodeTone(m.node.status)} label={<span className="text-xs">{m.node.status}{m.node.latency_ms !== null && m.node.status === 'online' ? ` · ${m.node.latency_ms} ms` : ''}</span>} />
                {m.node.status === 'offline' && m.node.last_error && <div className="max-w-[240px] truncate text-xs text-muted-foreground">{m.node.last_error}</div>}
              </TD>
              <TD>
                <DiskBar total={m.node.total_bytes} free={m.node.free_bytes} />
              </TD>
              <TD>
                {pool.level !== 'RAID0' && (
                  <Button size="xs" variant="ghost" onClick={() => onReplace(m.position)}>
                    Replace
                  </Button>
                )}
              </TD>
            </TR>
          ))}
        </tbody>
      </Table>
    </Panel>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function NodesPage() {
  const { can } = useSession();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const stepUp = useStepUp();
  const [nodeDialog, setNodeDialog] = React.useState<{ open: boolean; node: StorageNode | null }>({ open: false, node: null });
  const [poolOpen, setPoolOpen] = React.useState(false);
  const [replace, setReplace] = React.useState<{ pool: Pool; position: number } | null>(null);
  const allowed = can('storage.manage');

  const q = useQuery({
    queryKey: ['storage-nodes'],
    enabled: allowed,
    queryFn: async () => {
      const [nodes, pools] = await Promise.all([api<{ data: StorageNode[] }>('/storage/nodes'), api<{ data: Pool[] }>('/storage/pools')]);
      return { nodes: nodes.data, pools: pools.data };
    },
    // Rebuild progress and node status refresh on their own.
    refetchInterval: (query) => (query.state.data?.pools.some((p) => p.rebuild?.running) ? 3000 : 30_000),
  });

  if (!allowed) return <EmptyState icon={Network} title="You do not have access to storage nodes" />;
  const d = q.data;
  const poolName = (id: string) => d?.pools.find((p) => p.id === id)?.name ?? 'pool';
  const online = d?.nodes.filter((n) => n.status === 'online').length ?? 0;
  const raw = d?.nodes.reduce((a, n) => a + (n.total_bytes ?? 0), 0) ?? 0;
  const usable = d?.pools.reduce((a, p) => a + (p.usable_bytes ?? 0), 0) ?? 0;

  return (
    <>
      <PageHeader
        title="Nodes & RAID"
        description="Add more servers to grow storage, then combine them into RAID pools for speed, capacity or redundancy."
        actions={
          <>
            <Button variant="outline" onClick={() => setPoolOpen(true)} disabled={!d || d.nodes.length === 0}>
              <Layers className="h-4 w-4" /> Create pool
            </Button>
            <Button onClick={() => setNodeDialog({ open: true, node: null })}>
              <Plus className="h-4 w-4" /> Add node
            </Button>
          </>
        }
      />
      {q.isLoading ? (
        <Skeleton className="h-64" />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : d ? (
        <>
          <StatGrid>
            <Stat label="Nodes online" value={`${online} / ${d.nodes.length}`} />
            <Stat label="Raw disk across nodes" value={formatBytes(raw)} />
            <Stat label="Usable in pools" value={formatBytes(usable)} sub={`${d.pools.length} pool${d.pools.length === 1 ? '' : 's'}`} />
            <Stat label="Degraded pools" value={d.pools.filter((p) => p.status !== 'healthy').length} />
          </StatGrid>

          <Section title="Pools" description="A pool is a storage provider. Make it the default, or select it on a zone, to store files on it.">
            {d.pools.length === 0 ? (
              <Panel>
                <EmptyState icon={Layers} title="No pools yet" description="Add at least one node, then create a pool. RAID 5 with three nodes is a good start." />
              </Panel>
            ) : (
              <div className="space-y-4">
                {d.pools.map((p) => (
                  <PoolCard key={p.id} pool={p} onReplace={(position) => setReplace({ pool: p, position })} />
                ))}
              </div>
            )}
          </Section>

          <Section title="Nodes">
            <Panel>
              {d.nodes.length === 0 ? (
                <EmptyState icon={Network} title="No nodes yet" description="Run the storage node agent on another server and add it here." />
              ) : (
                <Table>
                  <THead>
                    <tr>
                      <TH>Name</TH>
                      <TH>Address</TH>
                      <TH>Status</TH>
                      <TH>Disk</TH>
                      <TH>Pool</TH>
                      <TH className="w-10" />
                    </tr>
                  </THead>
                  <tbody>
                    {d.nodes.map((n) => (
                      <TR key={n.id}>
                        <TD className="font-medium">
                          {n.name}
                          {n.region && <span className="ml-2 text-xs text-muted-foreground">{n.region}</span>}
                        </TD>
                        <TD className="max-w-[260px] truncate font-mono text-xs text-muted-foreground">{n.kind === 'LOCAL' ? `local: ${n.path}` : n.url}</TD>
                        <TD>
                          <StatusDot status={nodeTone(n.status)} label={<span className="text-xs">{n.status}{n.status === 'online' && n.latency_ms !== null ? ` · ${n.latency_ms} ms` : ''}</span>} />
                          {n.status === 'offline' && n.last_error && <div className="max-w-[240px] truncate text-xs text-muted-foreground">{n.last_error}</div>}
                        </TD>
                        <TD>
                          <DiskBar total={n.total_bytes} free={n.free_bytes} />
                        </TD>
                        <TD className="text-sm">{n.pools.length ? `${poolName(n.pools[0]!.pool_id)} · slot ${n.pools[0]!.position + 1}` : <span className="text-muted-foreground">Unassigned</span>}</TD>
                        <TD>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button size="xs" variant="ghost">
                                Manage
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent>
                              <DropdownMenuItem
                                onSelect={async () => {
                                  try {
                                    const r = await api<StorageNode>(`/storage/nodes/${n.id}/test`, { method: 'POST' });
                                    if (r.status === 'online') toast.success(`${n.name} is online`);
                                    else toast.error(`${n.name} is offline: ${r.last_error ?? 'unreachable'}`);
                                    void qc.invalidateQueries({ queryKey: ['storage-nodes'] });
                                  } catch (e) {
                                    toast.error(errorMessage(e));
                                  }
                                }}
                              >
                                Test now
                              </DropdownMenuItem>
                              <DropdownMenuItem onSelect={() => setNodeDialog({ open: true, node: n })}>Edit</DropdownMenuItem>
                              <DropdownMenuItem
                                onSelect={() =>
                                  void stepUp(
                                    async () => {
                                      await api(`/storage/nodes/${n.id}`, { method: 'PATCH', body: { enabled: !n.enabled } });
                                      void qc.invalidateQueries({ queryKey: ['storage-nodes'] });
                                    },
                                    { successMessage: n.enabled ? 'Node disabled (treated as offline)' : 'Node enabled' },
                                  )
                                }
                              >
                                {n.enabled ? 'Disable (maintenance)' : 'Enable'}
                              </DropdownMenuItem>
                              {n.pools.length === 0 && (
                                <>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem
                                    destructive
                                    onSelect={() =>
                                      confirm({
                                        title: `Remove ${n.name}?`,
                                        description: 'The node is forgotten by the panel. Data on its disk is not deleted.',
                                        destructive: true,
                                        requireReauth: true,
                                        confirmLabel: 'Remove node',
                                        successMessage: 'Node removed',
                                        action: async () => {
                                          await api(`/storage/nodes/${n.id}`, { method: 'DELETE' });
                                          void qc.invalidateQueries({ queryKey: ['storage-nodes'] });
                                        },
                                      })
                                    }
                                  >
                                    Remove
                                  </DropdownMenuItem>
                                </>
                              )}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TD>
                      </TR>
                    ))}
                  </tbody>
                </Table>
              )}
            </Panel>
          </Section>
        </>
      ) : null}
      <NodeDialog open={nodeDialog.open} node={nodeDialog.node} onOpenChange={(o) => setNodeDialog((s) => ({ ...s, open: o }))} />
      <PoolDialog open={poolOpen} onOpenChange={setPoolOpen} nodes={d?.nodes ?? []} />
      <ReplaceDialog target={replace} onClose={() => setReplace(null)} nodes={d?.nodes ?? []} />
    </>
  );
}
