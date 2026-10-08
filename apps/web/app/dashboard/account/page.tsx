'use client';
import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ShieldAlert } from 'lucide-react';
import { api, errorMessage, setCsrfToken } from '@/lib/api';
import { useSession } from '@/lib/session';
import { formatDate, timeAgo } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/form';
import { Badge, CopyButton, KeyValue, PageHeader, Panel, Section, Skeleton } from '@/components/ui/misc';
import { Table, TD, TH, THead, TR } from '@/components/ui/table';
import { useConfirm, useStepUp } from '@/components/confirm';
import { LinkedIdentities, Passkeys } from '@/components/account/identity';

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  return (
    <div className="space-y-3 rounded-md border border-[hsl(var(--warning)/0.4)] bg-[hsl(var(--warning)/0.06)] p-4">
      <p className="text-sm font-medium">Save these recovery codes now. Each works once; they will not be shown again.</p>
      <div className="grid grid-cols-2 gap-1 font-mono text-sm sm:grid-cols-5">
        {codes.map((c) => (
          <span key={c}>{c}</span>
        ))}
      </div>
      <div className="flex gap-2">
        <CopyButton value={codes.join('\n')} label="Recovery codes copied">
          Copy codes
        </CopyButton>
        <Button size="sm" onClick={onDone}>
          I saved them
        </Button>
      </div>
    </div>
  );
}

function TwoFactor() {
  const { session, refresh } = useSession();
  const confirm = useConfirm();
  const stepUp = useStepUp();
  const [setup, setSetup] = React.useState<{ secret: string; qr_data_url: string } | null>(null);
  const [code, setCode] = React.useState('');
  const [codes, setCodes] = React.useState<string[] | null>(null);
  const [busy, setBusy] = React.useState(false);

  if (codes) return <RecoveryCodes codes={codes} onDone={() => setCodes(null)} />;

  if (session.user.two_factor_enabled) {
    return (
      <div className="space-y-3">
        <p className="text-sm">
          <Badge tone="success">Enabled</Badge> <span className="ml-1 text-muted-foreground">Sign-ins require a code from your authenticator app.</span>
        </p>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              void stepUp(async () => {
                setCodes((await api<{ recovery_codes: string[] }>('/auth/2fa/recovery-codes', { method: 'POST' })).recovery_codes);
              })
            }
          >
            Regenerate recovery codes
          </Button>
          <Button
            size="sm"
            variant="secondary"
            className="text-destructive"
            onClick={() =>
              confirm({
                title: 'Disable two-factor authentication?',
                description: 'Your account will be protected by your password only.',
                destructive: true,
                requireReauth: true,
                confirmLabel: 'Disable 2FA',
                successMessage: 'Two-factor authentication disabled',
                action: async () => {
                  await api('/auth/2fa/disable', { method: 'POST' });
                  await refresh();
                },
              })
            }
          >
            Disable
          </Button>
        </div>
      </div>
    );
  }

  return setup ? (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          const res = await api<{ recovery_codes: string[] }>('/auth/2fa/enable', { body: { code } });
          setCodes(res.recovery_codes);
          setSetup(null);
          await refresh();
          toast.success('Two-factor authentication enabled');
        } catch (err) {
          toast.error(errorMessage(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <p className="text-sm text-muted-foreground">Scan the QR code with an authenticator app (1Password, Authy, Google Authenticator…), then enter the 6-digit code.</p>
      <div className="flex flex-wrap items-start gap-6">
        <img src={setup.qr_data_url} alt="Two-factor QR code" className="h-44 w-44 rounded border bg-white p-1" />
        <div className="space-y-3">
          <Field label="Or enter this key manually">
            <code className="block rounded bg-muted px-2 py-1 font-mono text-xs">{setup.secret}</code>
          </Field>
          <Field label="Verification code">
            <Input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} className="w-36" required />
          </Field>
          <Button type="submit" loading={busy} disabled={code.length !== 6}>
            Enable 2FA
          </Button>
        </div>
      </div>
    </form>
  ) : (
    <Button
      onClick={async () => {
        try {
          setSetup(await api('/auth/2fa/setup', { method: 'POST' }));
        } catch (err) {
          toast.error(errorMessage(err));
        }
      }}
    >
      Set up authenticator app
    </Button>
  );
}

function AccountInner() {
  const { session } = useSession();
  const params = useSearchParams();
  const router = useRouter();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [current, setCurrent] = React.useState('');
  const [next, setNext] = React.useState('');
  const [confirmPw, setConfirmPw] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const sessions = useQuery({
    queryKey: ['my-sessions'],
    queryFn: () => api<{ data: { id: string; ip: string | null; user_agent: string | null; current: boolean; last_seen_at: string; created_at: string; expires_at: string }[] }>('/auth/sessions'),
  });

  return (
    <>
      <PageHeader title="Account & security" />
      {(session.two_factor_enrollment_required || params.get('enroll')) && !session.user.two_factor_enabled && (
        <div className="mb-6 flex gap-3 rounded-md border border-[hsl(var(--warning)/0.4)] bg-[hsl(var(--warning)/0.08)] p-3 text-sm">
          <ShieldAlert className="h-4 w-4 shrink-0 text-warning" />
          Two-factor authentication is required for your account. Set it up below to continue using the dashboard.
        </div>
      )}
      <Section title="Profile">
        <Panel className="max-w-2xl p-4">
          <KeyValue
            items={[
              ['Name', session.user.name],
              ['Email', session.user.email],
              ['Roles', session.roles.join(', ') || '—'],
              ['Permissions', <span key="p" className="font-mono text-[11px] text-muted-foreground">{session.permissions.join(', ')}</span>],
            ]}
          />
        </Panel>
      </Section>
      <Section title="Two-factor authentication">
        <Panel className="max-w-2xl p-4">
          <TwoFactor />
        </Panel>
      </Section>
      <Passkeys />
      <LinkedIdentities linked={params.get('sso_linked')} error={params.get('sso_error')} />
      <Section title="Change password" description="Other sessions are signed out after a password change.">
        <Panel className="max-w-2xl p-4">
          <form
            className="space-y-4"
            onSubmit={async (e) => {
              e.preventDefault();
              if (next !== confirmPw) return toast.error('New passwords do not match');
              setBusy(true);
              try {
                await api('/auth/password', { body: { current_password: current, new_password: next } });
                toast.success('Password changed');
                setCurrent('');
                setNext('');
                setConfirmPw('');
                void sessions.refetch();
              } catch (err) {
                toast.error(errorMessage(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            <Field label="Current password">
              <Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="New password" hint="At least 12 characters, three character classes.">
                <Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required />
              </Field>
              <Field label="Confirm new password">
                <Input type="password" autoComplete="new-password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} required />
              </Field>
            </div>
            <Button type="submit" loading={busy}>
              Update password
            </Button>
          </form>
        </Panel>
      </Section>
      <Section
        title="Your sessions"
        actions={
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              confirm({
                title: 'Sign out of all devices?',
                description: 'Every session, including this one, will be ended.',
                confirmLabel: 'Sign out everywhere',
                destructive: true,
                action: async () => {
                  await api('/auth/logout-all', { method: 'POST' });
                  setCsrfToken(null);
                  qc.clear();
                  router.replace('/login');
                },
              })
            }
          >
            Sign out everywhere
          </Button>
        }
      >
        <Panel>
          {sessions.isLoading ? (
            <Skeleton className="m-3 h-24" />
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Device</TH>
                  <TH>IP</TH>
                  <TH>Last active</TH>
                  <TH>Expires</TH>
                  <TH className="w-24" />
                </tr>
              </THead>
              <tbody>
                {sessions.data?.data.map((s) => (
                  <TR key={s.id}>
                    <TD className="max-w-[320px] truncate text-muted-foreground" title={s.user_agent ?? ''}>
                      {s.current && <Badge tone="info" className="mr-1">This device</Badge>}
                      {s.user_agent ?? 'Unknown'}
                    </TD>
                    <TD className="font-mono text-xs">{s.ip ?? '—'}</TD>
                    <TD className="text-muted-foreground">{timeAgo(s.last_seen_at)}</TD>
                    <TD className="text-muted-foreground">{formatDate(s.expires_at)}</TD>
                    <TD>
                      {!s.current && (
                        <Button
                          size="xs"
                          variant="secondary"
                          onClick={async () => {
                            await api(`/auth/sessions/${s.id}`, { method: 'DELETE' });
                            toast.success('Session signed out');
                            void sessions.refetch();
                          }}
                        >
                          Sign out
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
    </>
  );
}

export default function AccountPage() {
  return (
    <React.Suspense fallback={<Skeleton className="h-96" />}>
      <AccountInner />
    </React.Suspense>
  );
}
