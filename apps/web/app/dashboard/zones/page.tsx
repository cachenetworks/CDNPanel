'use client';
import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderPlus, Globe, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage, type Paginated } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { FolderDTO, ProjectDTO, ZoneDTO } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Field, Input, NativeSelect, Textarea } from '@/components/ui/form';
import { Badge, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, EmptyState, ErrorState, PageHeader, Panel, Skeleton } from '@/components/ui/misc';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { Table, TD, TH, THead, TR } from '@/components/ui/table';
import { StatusDot, formatTtl, healthTone } from '@/components/ui/stat';
import { useConfirm } from '@/components/confirm';

const STRATEGY_LABEL: Record<ZoneDTO['replication_strategy'], string> = {
  PRIMARY_ONLY: 'Primary only',
  MIRROR: 'Mirror',
  NEAREST: 'Nearest',
  FAILOVER: 'Failover',
};

function ProjectDialog({ open, onOpenChange, project }: { open: boolean; onOpenChange: (o: boolean) => void; project: ProjectDTO | null }) {
  const qc = useQueryClient();
  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    if (open) {
      setName(project?.name ?? '');
      setDescription(project?.description ?? '');
    }
  }, [open, project]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader title={project ? 'Edit project' : 'New project'} description="Projects group zones, API keys, service accounts and webhooks — e.g. one per product." />
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              if (project) await api(`/projects/${project.id}`, { method: 'PATCH', body: { name, description } });
              else await api('/projects', { body: { name, description } });
              toast.success(project ? 'Project updated' : 'Project created');
              void qc.invalidateQueries({ queryKey: ['projects'] });
              onOpenChange(false);
            } catch (err) {
              toast.error(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <DialogBody>
            <Field label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} autoFocus />
            </Field>
            <Field label="Description">
              <Textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={busy}>
              {project ? 'Save' : 'Create project'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ZoneDialog({ open, onOpenChange, projects, defaultProject }: { open: boolean; onOpenChange: (o: boolean) => void; projects: ProjectDTO[]; defaultProject?: string }) {
  const qc = useQueryClient();
  const router = useRouter();
  const [projectId, setProjectId] = React.useState('');
  const [name, setName] = React.useState('');
  const [folderMode, setFolderMode] = React.useState<'new' | 'existing'>('new');
  const [folderId, setFolderId] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const folders = useQuery({ queryKey: ['folders', 'all'], queryFn: () => api<Paginated<FolderDTO>>('/folders', { query: { all: 'true', limit: 500 } }), enabled: open });
  React.useEffect(() => {
    if (open) {
      setProjectId(defaultProject ?? projects[0]?.id ?? '');
      setName('');
      setFolderMode('new');
      setFolderId('');
    }
  }, [open, defaultProject, projects]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader title="New zone" description="A zone is a delivery configuration for one folder subtree: custom domains, cache rules, security, image optimisation and replication." />
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              const zone = await api<ZoneDTO>('/zones', { body: { project_id: projectId, name, ...(folderMode === 'existing' ? { root_folder_id: folderId } : {}) } });
              toast.success('Zone created');
              void qc.invalidateQueries({ queryKey: ['zones'] });
              void qc.invalidateQueries({ queryKey: ['projects'] });
              onOpenChange(false);
              router.push(`/dashboard/zones/${zone.id}?tab=domains`);
            } catch (err) {
              toast.error(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <DialogBody>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Project">
                <NativeSelect className="w-full" value={projectId} onChange={(e) => setProjectId(e.target.value)} required>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Field label="Zone name">
                <Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} placeholder="Sentinel assets" />
              </Field>
            </div>
            <Field label="Root folder" hint={folderMode === 'new' ? 'A new top-level folder named after the zone is created.' : 'Every file below this folder belongs to the zone.'}>
              <div className="flex gap-2">
                <NativeSelect value={folderMode} onChange={(e) => setFolderMode(e.target.value as 'new' | 'existing')}>
                  <option value="new">Create a new folder</option>
                  <option value="existing">Use an existing folder</option>
                </NativeSelect>
                {folderMode === 'existing' && (
                  <NativeSelect className="min-w-0 flex-1" value={folderId} onChange={(e) => setFolderId(e.target.value)} required>
                    <option value="">Select a folder…</option>
                    {folders.data?.data.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.path}
                      </option>
                    ))}
                  </NativeSelect>
                )}
              </div>
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={busy} disabled={!projectId}>
              Create zone
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function ZonesPage() {
  const { can } = useSession();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api<{ data: ProjectDTO[] }>('/projects') });
  const zones = useQuery({ queryKey: ['zones'], queryFn: () => api<{ data: ZoneDTO[] }>('/zones') });
  const [projectDialog, setProjectDialog] = React.useState<{ open: boolean; project: ProjectDTO | null }>({ open: false, project: null });
  const [zoneDialog, setZoneDialog] = React.useState<{ open: boolean; projectId?: string }>({ open: false });
  const manage = can('zones.manage');

  return (
    <>
      <PageHeader
        title="Zones & Domains"
        description="Projects own CDN zones. Each zone serves one folder subtree on its own hostnames with its own cache, security, image and replication settings."
        actions={
          manage && (
            <>
              <Button variant="secondary" onClick={() => setProjectDialog({ open: true, project: null })}>
                <FolderPlus /> New project
              </Button>
              <Button onClick={() => setZoneDialog({ open: true })} disabled={!projects.data?.data.length}>
                <Plus /> New zone
              </Button>
            </>
          )
        }
      />
      {(projects.isError || zones.isError) && <ErrorState error={projects.error ?? zones.error} onRetry={() => void zones.refetch()} />}
      {!projects.data || !zones.data ? (
        <Skeleton className="h-64" />
      ) : projects.data.data.length === 0 ? (
        <Panel>
          <EmptyState icon={Globe} title="No projects yet" description="Create a project, then add zones with custom domains." />
        </Panel>
      ) : (
        <div className="space-y-6">
          {projects.data.data.map((p) => {
            const list = zones.data!.data.filter((z) => z.project_id === p.id);
            return (
              <section key={p.id}>
                <div className="mb-2 flex items-end justify-between gap-3">
                  <div>
                    <h2 className="text-sm font-semibold">{p.name}</h2>
                    {p.description && <p className="text-[13px] text-muted-foreground">{p.description}</p>}
                  </div>
                  {manage && (
                    <div className="flex gap-1">
                      <Button size="xs" variant="secondary" onClick={() => setZoneDialog({ open: true, projectId: p.id })}>
                        <Plus /> Zone
                      </Button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button size="icon" variant="ghost" className="h-7 w-7" aria-label="Project actions">
                            <MoreHorizontal />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent>
                          <DropdownMenuItem onSelect={() => setProjectDialog({ open: true, project: p })}>
                            <Pencil /> Edit project
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            destructive
                            disabled={list.length > 0}
                            onSelect={() =>
                              confirm({
                                title: `Delete project ${p.name}?`,
                                description: 'API keys and service accounts bound to it become unrestricted; project webhooks are deleted.',
                                destructive: true,
                                requireReauth: true,
                                confirmLabel: 'Delete project',
                                successMessage: 'Project deleted',
                                action: async () => {
                                  await api(`/projects/${p.id}`, { method: 'DELETE' });
                                  void qc.invalidateQueries({ queryKey: ['projects'] });
                                },
                              })
                            }
                          >
                            <Trash2 /> Delete project
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  )}
                </div>
                <Panel>
                  {list.length === 0 ? (
                    <p className="px-4 py-6 text-center text-[13px] text-muted-foreground">No zones in this project yet.</p>
                  ) : (
                    <Table>
                      <THead>
                        <tr>
                          <TH>Zone</TH>
                          <TH>Root folder</TH>
                          <TH>Domains</TH>
                          <TH>Edge / browser TTL</TH>
                          <TH>Replication</TH>
                          <TH>Features</TH>
                        </tr>
                      </THead>
                      <tbody>
                        {list.map((z) => (
                          <TR key={z.id}>
                            <TD>
                              <Link href={`/dashboard/zones/${z.id}`} className="font-medium hover:underline">
                                {z.name}
                              </Link>
                              {!z.enabled && (
                                <Badge tone="warning" className="ml-2">
                                  Disabled
                                </Badge>
                              )}
                            </TD>
                            <TD className="font-mono text-xs text-muted-foreground">{z.root_folder?.path ?? '/'}</TD>
                            <TD>
                              {z.domains?.length ? (
                                <div className="flex flex-col gap-0.5">
                                  {z.domains.map((d) => (
                                    <StatusDot key={d.id} status={d.status === 'ACTIVE' ? healthTone(d.health_status) : d.status === 'PENDING' ? 'warn' : 'fail'} label={<span className="font-mono text-xs">{d.hostname}</span>} />
                                  ))}
                                </div>
                              ) : (
                                <span className="text-xs text-muted-foreground">None</span>
                              )}
                            </TD>
                            <TD className="tabular text-xs">
                              {formatTtl(z.edge_ttl)} / {formatTtl(z.browser_ttl)}
                            </TD>
                            <TD className="text-xs">
                              {STRATEGY_LABEL[z.replication_strategy]}
                              {z.replica_provider_ids.length > 0 && <span className="text-muted-foreground"> · {z.replica_provider_ids.length} replica(s)</span>}
                            </TD>
                            <TD>
                              <div className="flex flex-wrap gap-1">
                                {z.image_optimization && <Badge tone="info">Images</Badge>}
                                {z.video_processing && <Badge tone="info">Video</Badge>}
                                {(z.allowed_referrers.length > 0 || !z.allow_empty_referrer) && <Badge tone="outline">Hotlink</Badge>}
                                {(z.allowed_countries.length > 0 || z.blocked_countries.length > 0) && <Badge tone="outline">Geo</Badge>}
                                {z.cloudflare.token_configured && <Badge tone="outline">Cloudflare</Badge>}
                              </div>
                            </TD>
                          </TR>
                        ))}
                      </tbody>
                    </Table>
                  )}
                </Panel>
              </section>
            );
          })}
        </div>
      )}
      <ProjectDialog open={projectDialog.open} project={projectDialog.project} onOpenChange={(o) => setProjectDialog((s) => ({ ...s, open: o }))} />
      <ZoneDialog open={zoneDialog.open} defaultProject={zoneDialog.projectId} projects={projects.data?.data ?? []} onOpenChange={(o) => setZoneDialog((s) => ({ ...s, open: o }))} />
    </>
  );
}
