'use client';
import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Fingerprint, Link2, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { startRegistration, browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { api, errorMessage } from '@/lib/api';
import { formatDate, timeAgo } from '@/lib/utils';
import { Button } from '../ui/button';
import { Input } from '../ui/form';
import { Badge, Panel, Section, Skeleton } from '../ui/misc';
import { useConfirm, useStepUp } from '../confirm';

interface Passkey {
  id: string;
  name: string;
  device_type: string | null;
  backed_up: boolean;
  last_used_at: string | null;
  created_at: string;
}
interface Identity {
  id: string;
  provider: { slug: string; name: string; kind: string };
  email: string | null;
  last_login_at: string | null;
}

export function Passkeys() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const stepUp = useStepUp();
  const [name, setName] = React.useState('');
  const [supported, setSupported] = React.useState(true);
  React.useEffect(() => setSupported(browserSupportsWebAuthn()), []);
  const q = useQuery({ queryKey: ['passkeys'], queryFn: () => api<{ data: Passkey[] }>('/auth/passkeys') });
  const register = () =>
    stepUp(
      async () => {
        const options = await api<Parameters<typeof startRegistration>[0]['optionsJSON']>('/auth/passkeys/register/options', { method: 'POST' });
        let response;
        try {
          response = await startRegistration({ optionsJSON: options });
        } catch (err) {
          throw new Error((err as Error).name === 'NotAllowedError' ? 'Passkey registration was cancelled.' : errorMessage(err));
        }
        await api('/auth/passkeys/register/verify', { body: { name: name.trim() || 'Passkey', response } });
        setName('');
        void qc.invalidateQueries({ queryKey: ['passkeys'] });
      },
      { title: 'Confirm your password to add a passkey', successMessage: 'Passkey added' },
    );
  return (
    <Section title="Passkeys" description="Sign in with Face ID, Touch ID, Windows Hello or a security key — phishing-resistant and counts as two-factor authentication.">
      <Panel className="max-w-2xl">
        {!q.data ? (
          <Skeleton className="m-3 h-16" />
        ) : (
          <div className="divide-y">
            {q.data.data.map((p) => (
              <div key={p.id} className="flex items-center gap-3 px-4 py-3">
                <Fingerprint className="h-4 w-4 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium">{p.name}</div>
                  <div className="text-xs text-muted-foreground">
                    Added {formatDate(p.created_at, false)} · last used {timeAgo(p.last_used_at)}
                    {p.backed_up && ' · synced'}
                  </div>
                </div>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
                  aria-label={`Remove ${p.name}`}
                  onClick={() =>
                    confirm({
                      title: `Remove passkey “${p.name}”?`,
                      destructive: true,
                      requireReauth: true,
                      confirmLabel: 'Remove passkey',
                      successMessage: 'Passkey removed',
                      action: async () => {
                        await api(`/auth/passkeys/${p.id}`, { method: 'DELETE' });
                        void qc.invalidateQueries({ queryKey: ['passkeys'] });
                      },
                    })
                  }
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
            <div className="flex flex-wrap items-center gap-2 px-4 py-3">
              <Input className="max-w-xs" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name, e.g. MacBook Touch ID" maxLength={60} />
              <Button size="sm" onClick={register} disabled={!supported}>
                <Fingerprint /> Add a passkey
              </Button>
              {!supported && <span className="text-xs text-muted-foreground">This browser does not support passkeys.</span>}
            </div>
          </div>
        )}
      </Panel>
    </Section>
  );
}

export function LinkedIdentities({ linked, error }: { linked?: string | null; error?: string | null }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const providers = useQuery({ queryKey: ['sso-public'], queryFn: () => api<{ providers: { slug: string; name: string; kind: string; start_url: string }[] }>('/auth/sso/providers') });
  const ids = useQuery({ queryKey: ['identities'], queryFn: () => api<{ data: Identity[] }>('/auth/identities') });
  React.useEffect(() => {
    if (linked) toast.success(`${linked} linked to your account`);
    if (error) toast.error(error === 'already_linked' ? 'That identity is already linked to another account.' : `Linking failed: ${error}`);
  }, [linked, error]);
  if (!providers.data?.providers.length) return null;
  return (
    <Section title="Single sign-on" description="Link identities to sign in with your organisation’s provider.">
      <Panel className="max-w-2xl divide-y">
        {providers.data.providers.map((p) => {
          const link = ids.data?.data.find((i) => i.provider.slug === p.slug);
          return (
            <div key={p.slug} className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium">
                  {p.name} <Badge tone="outline">{p.kind}</Badge>
                </div>
                {link && (
                  <div className="text-xs text-muted-foreground">
                    {link.email ?? 'Linked'} · last sign-in {timeAgo(link.last_login_at)}
                  </div>
                )}
              </div>
              {link ? (
                <Button
                  size="xs"
                  variant="secondary"
                  onClick={() =>
                    confirm({
                      title: `Unlink ${p.name}?`,
                      requireReauth: true,
                      confirmLabel: 'Unlink',
                      successMessage: 'Identity unlinked',
                      action: async () => {
                        await api(`/auth/identities/${link.id}`, { method: 'DELETE' });
                        void qc.invalidateQueries({ queryKey: ['identities'] });
                      },
                    })
                  }
                >
                  Unlink
                </Button>
              ) : (
                <Button size="xs" variant="secondary" asChild>
                  <a href={`${p.start_url}?link=1`}>
                    <Link2 /> Link
                  </a>
                </Button>
              )}
            </div>
          );
        })}
      </Panel>
    </Section>
  );
}
