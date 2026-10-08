'use client';
import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Plus, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import type { RoleDTO } from '@/lib/types';
import { Button } from '../ui/button';
import { Field, Input, Label, NativeSelect, Switch } from '../ui/form';
import { Badge, CopyButton, EmptyState, Panel, Skeleton } from '../ui/misc';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '../ui/dialog';
import { ListInput } from '../ui/stat';
import { useConfirm, useStepUp } from '../confirm';

interface Provider {
  id: string;
  name: string;
  slug: string;
  kind: 'OIDC' | 'GOOGLE' | 'GITHUB' | 'DISCORD';
  client_id: string;
  issuer: string | null;
  enabled: boolean;
  auto_provision: boolean;
  default_role_id: string | null;
  allowed_domains: string[];
  redirect_uri: string;
}

const KIND_HELP: Record<Provider['kind'], string> = {
  GOOGLE: 'Google Cloud console → APIs & Services → Credentials → OAuth client (Web application).',
  GITHUB: 'GitHub → Settings → Developer settings → OAuth Apps. Only verified primary emails are used.',
  DISCORD: 'Discord Developer Portal → Applications → OAuth2. Only verified emails are used.',
  OIDC: 'Any OpenID Connect provider (Authentik, Keycloak, Okta, Entra ID…). Enter the issuer URL; endpoints are discovered.',
};

function ProviderDialog({ open, onOpenChange, provider, roles }: { open: boolean; onOpenChange: (o: boolean) => void; provider: Provider | null; roles: RoleDTO[] }) {
  const qc = useQueryClient();
  const stepUp = useStepUp();
  const [name, setName] = React.useState('');
  const [kind, setKind] = React.useState<Provider['kind']>('GOOGLE');
  const [clientId, setClientId] = React.useState('');
  const [secret, setSecret] = React.useState('');
  const [issuer, setIssuer] = React.useState('');
  const [enabled, setEnabled] = React.useState(true);
  const [autoProvision, setAutoProvision] = React.useState(false);
  const [roleId, setRoleId] = React.useState('');
  const [domains, setDomains] = React.useState<string[]>([]);
  React.useEffect(() => {
    if (open) {
      setName(provider?.name ?? '');
      setKind(provider?.kind ?? 'GOOGLE');
      setClientId(provider?.client_id ?? '');
      setSecret('');
      setIssuer(provider?.issuer ?? '');
      setEnabled(provider?.enabled ?? true);
      setAutoProvision(provider?.auto_provision ?? false);
      setRoleId(provider?.default_role_id ?? roles.find((r) => r.name === 'Viewer')?.id ?? '');
      setDomains(provider?.allowed_domains ?? []);
    }
  }, [open, provider, roles]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader title={provider ? `Edit ${provider.name}` : 'Add sign-in provider'} description={KIND_HELP[kind]} />
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const body = {
              name,
              client_id: clientId,
              ...(secret ? { client_secret: secret } : {}),
              issuer: kind === 'OIDC' ? issuer : null,
              enabled,
              auto_provision: autoProvision,
              default_role_id: roleId || null,
              allowed_domains: domains,
            };
            void stepUp(
              async () => {
                if (provider) await api(`/sso/providers/${provider.id}`, { method: 'PATCH', body });
                else await api('/sso/providers', { body: { ...body, kind } });
                void qc.invalidateQueries({ queryKey: ['sso-providers'] });
                onOpenChange(false);
              },
              { title: 'Confirm sign-in provider change', successMessage: 'Provider saved' },
            );
          }}
        >
          <DialogBody>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Display name">
                <Input value={name} onChange={(e) => setName(e.target.value)} required placeholder="Google Workspace" />
              </Field>
              <Field label="Type">
                <NativeSelect className="w-full" value={kind} disabled={Boolean(provider)} onChange={(e) => setKind(e.target.value as Provider['kind'])}>
                  <option value="GOOGLE">Google</option>
                  <option value="GITHUB">GitHub</option>
                  <option value="DISCORD">Discord</option>
                  <option value="OIDC">OpenID Connect</option>
                </NativeSelect>
              </Field>
              {kind === 'OIDC' && (
                <Field label="Issuer URL">
                  <Input value={issuer} onChange={(e) => setIssuer(e.target.value)} required type="url" placeholder="https://auth.example.com/application/o/cdn/" />
                </Field>
              )}
              <Field label="Client ID">
                <Input value={clientId} onChange={(e) => setClientId(e.target.value)} required />
              </Field>
              <Field label="Client secret" hint={provider ? 'Leave empty to keep the stored secret.' : 'Stored encrypted.'}>
                <Input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} required={!provider} autoComplete="off" />
              </Field>
            </div>
            <Field label="Allowed email domains" hint="Empty allows any domain (existing staff are matched by verified email).">
              <ListInput value={domains} onChange={(v) => setDomains(v.map((d) => d.toLowerCase()))} placeholder="example.com" />
            </Field>
            <div className="flex items-center justify-between">
              <div>
                <Label>Create staff accounts automatically</Label>
                <p className="text-xs text-muted-foreground">Unknown users from allowed domains get an account with the default role.</p>
              </div>
              <Switch checked={autoProvision} onCheckedChange={setAutoProvision} />
            </div>
            {autoProvision && (
              <Field label="Default role">
                <NativeSelect className="w-full" value={roleId} onChange={(e) => setRoleId(e.target.value)} required>
                  {roles.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            )}
            <div className="flex items-center justify-between">
              <Label>Enabled</Label>
              <Switch checked={enabled} onCheckedChange={setEnabled} />
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit">Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function SsoSettings({ editable }: { editable: boolean }) {
  const confirm = useConfirm();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['sso-providers'], queryFn: () => api<{ data: Provider[] }>('/sso/providers') });
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api<{ data: RoleDTO[] }>('/roles'), enabled: editable });
  const [dialog, setDialog] = React.useState<{ open: boolean; provider: Provider | null }>({ open: false, provider: null });
  return (
    <div className="max-w-3xl space-y-4">
      <p className="text-[13px] text-muted-foreground">Staff can sign in with these providers or with passkeys (Account → Passkeys). Accounts with TOTP still complete the code after single sign-on.</p>
      {editable && (
        <Button size="sm" onClick={() => setDialog({ open: true, provider: null })}>
          <Plus /> Add provider
        </Button>
      )}
      {!q.data ? (
        <Skeleton className="h-32" />
      ) : q.data.data.length === 0 ? (
        <Panel>
          <EmptyState icon={KeyRound} title="No sign-in providers" description="Add Google, GitHub, Discord or any OpenID Connect provider." />
        </Panel>
      ) : (
        q.data.data.map((p) => (
          <Panel key={p.id} className="space-y-2 p-4">
            <div className="flex items-center gap-2">
              <span className="font-medium">{p.name}</span>
              <Badge tone="outline">{p.kind}</Badge>
              {!p.enabled && <Badge>Disabled</Badge>}
              {p.auto_provision && <Badge tone="info">Auto-provision</Badge>}
              <div className="flex-1" />
              {editable && (
                <>
                  <Button size="xs" variant="secondary" onClick={() => setDialog({ open: true, provider: p })}>
                    Edit
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    className="text-destructive"
                    aria-label={`Delete ${p.name}`}
                    onClick={() =>
                      confirm({
                        title: `Delete ${p.name}?`,
                        description: 'Linked identities are removed; staff keep their accounts.',
                        destructive: true,
                        requireReauth: true,
                        confirmLabel: 'Delete provider',
                        successMessage: 'Provider deleted',
                        action: async () => {
                          await api(`/sso/providers/${p.id}`, { method: 'DELETE' });
                          void qc.invalidateQueries({ queryKey: ['sso-providers'] });
                        },
                      })
                    }
                  >
                    <Trash2 />
                  </Button>
                </>
              )}
            </div>
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              Callback URL: <code className="truncate">{p.redirect_uri}</code>
              <CopyButton value={p.redirect_uri} label="Callback URL copied" />
            </div>
            {p.allowed_domains.length > 0 && <p className="text-xs text-muted-foreground">Domains: {p.allowed_domains.join(', ')}</p>}
          </Panel>
        ))
      )}
      <ProviderDialog open={dialog.open} provider={dialog.provider} roles={roles.data?.data ?? []} onOpenChange={(o) => setDialog((s) => ({ ...s, open: o }))} />
    </div>
  );
}
