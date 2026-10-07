'use client';
import * as React from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { api, errorMessage } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/form';
import { Spinner } from '@/components/ui/misc';

function AcceptForm() {
  const params = useSearchParams();
  const token = params.get('token') ?? '';
  const info = useQuery({
    queryKey: ['token', token],
    queryFn: () => api<{ type: 'INVITE' | 'PASSWORD_RESET'; email: string; name: string }>(`/auth/token/${encodeURIComponent(token)}`, { silent: true }),
    enabled: token.length >= 20,
    retry: false,
  });
  const [password, setPassword] = React.useState('');
  const [confirm, setConfirm] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [done, setDone] = React.useState(false);

  if (!token || info.isError) return <p className="text-sm text-destructive">This link is invalid or has expired. Ask an administrator for a new one.</p>;
  if (info.isLoading) return <Spinner />;
  if (done)
    return (
      <div className="space-y-4">
        <p className="text-sm">Your password has been set.</p>
        <Button asChild className="w-full">
          <Link href="/login">Continue to sign in</Link>
        </Button>
      </div>
    );

  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        if (password !== confirm) return setError('Passwords do not match.');
        setBusy(true);
        try {
          await api('/auth/token/accept', { body: { token, password }, silent: true });
          setDone(true);
        } catch (err) {
          setError(errorMessage(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <p className="text-sm text-muted-foreground">
        {info.data?.type === 'INVITE' ? 'Welcome' : 'Reset password for'} <span className="font-medium text-foreground">{info.data?.email}</span>
      </p>
      <Field label="New password" hint="At least 12 characters with three of: lowercase, uppercase, digits, symbols.">
        <Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
      </Field>
      <Field label="Confirm password">
        <Input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
      </Field>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button type="submit" className="w-full" loading={busy}>
        Set password
      </Button>
    </form>
  );
}

export default function AcceptPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-subtle px-4">
      <div className="w-full max-w-sm rounded-lg border bg-background p-6 shadow-sm">
        <h1 className="mb-4 text-lg font-semibold">Set your password</h1>
        <React.Suspense>
          <AcceptForm />
        </React.Suspense>
      </div>
    </div>
  );
}
