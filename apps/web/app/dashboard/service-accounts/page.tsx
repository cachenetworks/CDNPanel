'use client';
import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, KeyRound, LayoutTemplate, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { API_SCOPES, type ApiScope } from '@cdn/shared/permissions';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { ProjectDTO } from '@/lib/types';
import { formatDate } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, Input, NativeSelect, Switch, Textarea } from '@/components/ui/form';
import { Badge, EmptyState, PageHeader, Panel, Section, Skeleton } from '@/components/ui/misc';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { Table, TD, TH, THead, TR } from '@/components/ui/table';
import { ListInput } from '@/components/ui/stat';
import { CreateKeyDialog } from '@/components/api-keys/create-key';
import { useConfirm } from '@/components/confirm';

interface ServiceAccount {
  id: string;
  name: string;
  description: string;
  project: { id: string; name: string } | null;
  enabled: boolean;
  api_key_count?: number;
  created_at: string;
}
interface Template {
  id: string;
  name: string;
  description: string;
  scopes: string[];
  rate_limit: number | null;
  ip_restrictions: string[];
  allowed_endpoints: string[];
  expires_in_days: number | null;
  environment: string;
}

function AccountDialog({ open, onOpenChange, projects }: { open: boolean; onOpenChange: (o: boolean) => void; projects: ProjectDTO[] }) {
  const qc = useQueryClient();
  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [projectId, setProjectId] = React.useState('');
  React.useEffect(() => {
    if (open) {
      setName('');
      setDescription('');
      setProjectId('');
    }
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader title="New service account" description="A machine identity for CI pipelines, bots and services. Its API keys are listed under it and can be disabled together." />
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await api('/service-accounts', { body: { name, description, project_id: projectId || null } });
              toast.success('Service account created');
              void qc.invalidateQueries({ queryKey: ['service-accounts'] });
              onOpenChange(false);
            } catch (err) {
              toast.error(errorMessage(err));
            }
          }}
        >
          <DialogBody>
            <Field label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} required placeholder="github-actions" />
            </Field>
            <Field label="Description">
              <Textarea value={description} onChange={(e) => setDescription(e.target.value)} />
            </Field>
            <Field label="Project scope" hint="Keys owned by the account are confined to the project's zones.">
              <NativeSelect className="w-full" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                <option value="">All files</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit">Create</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TemplateDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [scopes, setScopes] = React.useState<ApiScope[]>(['files:read']);
  const [rateLimit, setRateLimit] = React.useState('');
  const [ips, setIps] = React.useState<string[]>([]);
  const [days, setDays] = React.useState('');
  React.useEffect(() => {
    if (open) {
      setName('');
      setDescription('');
      setScopes(['files:read']);
      setRateLimit('');
      setIps([]);
      setDays('');
    }
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader title="New API key template" description="Templates pre-fill the key wizard so keys for the same purpose are configured consistently." />
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await api('/api-key-templates', { body: { name, description, scopes, rate_limit: rateLimit ? Number(rateLimit) : null, ip_restrictions: ips, expires_in_days: days ? Number(days) : null } });
              toast.success('Template created');
              void qc.invalidateQueries({ queryKey: ['api-key-templates'] });
              onOpenChange(false);
            } catch (err) {
              toast.error(errorMessage(err));
            }
          }}
        >
          <DialogBody>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name">
                <Input value={name} onChange={(e) => setName(e.target.value)} required placeholder="CI uploader" />
              </Field>
              <Field label="Description">
                <Input value={description} onChange={(e) => setDescription(e.target.value)} />
              </Field>
              <Field label="Rate limit" hint="Requests per minute; empty uses the default.">
                <Input type="number" min={1} value={rateLimit} onChange={(e) => setRateLimit(e.target.value)} />
              </Field>
              <Field label="Lifetime" hint="Days; empty for no expiry.">
                <Input type="number" min={1} value={days} onChange={(e) => setDays(e.target.value)} />
              </Field>
            </div>
            <Field label="IP restrictions">
              <ListInput value={ips} onChange={setIps} placeholder="203.0.113.0/24" />
            </Field>
            <div className="grid gap-1 rounded-md border p-2 sm:grid-cols-2">
              {(Object.keys(API_SCOPES) as ApiScope[]).map((s) => (
                <label key={s} className="flex items-center gap-2 px-1 py-1 text-[13px]">
                  <Checkbox checked={scopes.includes(s)} onCheckedChange={(c) => setScopes((prev) => (c === true ? [...prev, s] : prev.filter((x) => x !== s)))} />
                  <span className="font-mono text-xs">{s}</span>
                </label>
              ))}
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={scopes.length === 0}>
              Create template
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function ServiceAccountsPage() {
  const { can } = useSession();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const accounts = useQuery({ queryKey: ['service-accounts'], queryFn: () => api<{ data: ServiceAccount[] }>('/service-accounts') });
  const templates = useQuery({ queryKey: ['api-key-templates'], queryFn: () => api<{ data: Template[] }>('/api-key-templates') });
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api<{ data: ProjectDTO[] }>('/projects'), enabled: can('zones.view') });
  const [accountDialog, setAccountDialog] = React.useState(false);
  const [templateDialog, setTemplateDialog] = React.useState(false);
  const [keyFor, setKeyFor] = React.useState<string | null>(null);
  const create = can('api_keys.create');
  return (
    <>
      <PageHeader
        title="Service Accounts"
        description="Machine identities and reusable key templates. The cdnctl CLI and the generated SDKs authenticate with service-account keys."
        actions={
          create && (
            <Button onClick={() => setAccountDialog(true)}>
              <Plus /> New service account
            </Button>
          )
        }
      />
      <Section title="Service accounts">
        <Panel>
          {!accounts.data ? (
            <Skeleton className="m-3 h-24" />
          ) : accounts.data.data.length === 0 ? (
            <EmptyState icon={Bot} title="No service accounts" description="Create one per pipeline or service so its keys can be audited and disabled together." />
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Name</TH>
                  <TH>Project</TH>
                  <TH className="text-right">API keys</TH>
                  <TH>Created</TH>
                  <TH>Enabled</TH>
                  <TH className="w-40" />
                </tr>
              </THead>
              <tbody>
                {accounts.data.data.map((a) => (
                  <TR key={a.id}>
                    <TD>
                      <div className="font-medium">{a.name}</div>
                      {a.description && <div className="text-xs text-muted-foreground">{a.description}</div>}
                    </TD>
                    <TD className="text-xs">{a.project?.name ?? <span className="text-muted-foreground">All files</span>}</TD>
                    <TD className="text-right tabular">{a.api_key_count ?? 0}</TD>
                    <TD className="text-muted-foreground">{formatDate(a.created_at, false)}</TD>
                    <TD>
                      <Switch
                        disabled={!can('api_keys.revoke')}
                        checked={a.enabled}
                        onCheckedChange={async (v) => {
                          await api(`/service-accounts/${a.id}`, { method: 'PATCH', body: { enabled: v } }).catch((e) => toast.error(errorMessage(e)));
                          void qc.invalidateQueries({ queryKey: ['service-accounts'] });
                        }}
                      />
                    </TD>
                    <TD>
                      <div className="flex justify-end gap-1">
                        {create && (
                          <Button size="xs" variant="secondary" onClick={() => setKeyFor(a.id)}>
                            <KeyRound /> New key
                          </Button>
                        )}
                        {can('api_keys.revoke') && (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7 text-destructive"
                            aria-label={`Delete ${a.name}`}
                            onClick={() =>
                              confirm({
                                title: `Delete ${a.name}?`,
                                description: `Its ${a.api_key_count ?? 0} API key(s) are deleted and stop working immediately.`,
                                destructive: true,
                                requireReauth: true,
                                confirmLabel: 'Delete service account',
                                successMessage: 'Service account deleted',
                                action: async () => {
                                  await api(`/service-accounts/${a.id}`, { method: 'DELETE' });
                                  void qc.invalidateQueries({ queryKey: ['service-accounts'] });
                                  void qc.invalidateQueries({ queryKey: ['api-keys'] });
                                },
                              })
                            }
                          >
                            <Trash2 />
                          </Button>
                        )}
                      </div>
                    </TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          )}
        </Panel>
      </Section>
      <Section
        title="API key templates"
        actions={
          create && (
            <Button size="sm" variant="secondary" onClick={() => setTemplateDialog(true)}>
              <Plus /> New template
            </Button>
          )
        }
      >
        <Panel>
          {!templates.data ? (
            <Skeleton className="m-3 h-20" />
          ) : templates.data.data.length === 0 ? (
            <EmptyState icon={LayoutTemplate} title="No templates" />
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Template</TH>
                  <TH>Scopes</TH>
                  <TH>Limits</TH>
                  <TH className="w-10" />
                </tr>
              </THead>
              <tbody>
                {templates.data.data.map((t) => (
                  <TR key={t.id}>
                    <TD>
                      <div className="font-medium">{t.name}</div>
                      {t.description && <div className="text-xs text-muted-foreground">{t.description}</div>}
                    </TD>
                    <TD className="font-mono text-[11px] text-muted-foreground">{t.scopes.join(', ')}</TD>
                    <TD className="text-xs">
                      {[t.rate_limit ? `${t.rate_limit}/min` : null, t.expires_in_days ? `${t.expires_in_days}d lifetime` : null, t.ip_restrictions.length ? `${t.ip_restrictions.length} IP rule(s)` : null].filter(Boolean).join(' · ') || '—'}
                      {t.environment === 'test' && <Badge className="ml-1">test</Badge>}
                    </TD>
                    <TD>
                      {create && (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          aria-label="Delete template"
                          onClick={async () => {
                            await api(`/api-key-templates/${t.id}`, { method: 'DELETE' }).catch((e) => toast.error(errorMessage(e)));
                            void qc.invalidateQueries({ queryKey: ['api-key-templates'] });
                          }}
                        >
                          <Trash2 />
                        </Button>
                      )}
                    </TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          )}
        </Panel>
      </Section>
      <AccountDialog open={accountDialog} onOpenChange={setAccountDialog} projects={projects.data?.data ?? []} />
      <TemplateDialog open={templateDialog} onOpenChange={setTemplateDialog} />
      <CreateKeyDialog
        open={Boolean(keyFor)}
        defaultServiceAccount={keyFor ?? undefined}
        onOpenChange={(o) => {
          if (!o) {
            setKeyFor(null);
            void qc.invalidateQueries({ queryKey: ['service-accounts'] });
          }
        }}
      />
    </>
  );
}
