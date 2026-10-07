'use client';
import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { api, errorMessage, setCsrfToken } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, Input, Label } from '@/components/ui/form';

interface LoginResponse {
  mfa_required?: boolean;
  mfa_token?: string;
  csrf_token?: string;
}

function safeNext(next: string | null): string {
  // Only allow same-site relative redirects (prevents open redirects).
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard';
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const qc = useQueryClient();
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [remember, setRemember] = React.useState(false);
  const [mfaToken, setMfaToken] = React.useState<string | null>(null);
  const [code, setCode] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const finish = (res: LoginResponse) => {
    if (res.csrf_token) setCsrfToken(res.csrf_token);
    qc.removeQueries({ queryKey: ['session'] });
    router.replace(safeNext(params.get('next')));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mfaToken) {
        finish(await api<LoginResponse>('/auth/login/mfa', { body: { mfa_token: mfaToken, code }, silent: true }));
      } else {
        const res = await api<LoginResponse>('/auth/login', { body: { email, password, remember_me: remember }, silent: true });
        if (res.mfa_required && res.mfa_token) {
          setMfaToken(res.mfa_token);
          setPassword('');
        } else finish(res);
      }
    } catch (err) {
      setError(errorMessage(err));
      if (mfaToken) setCode('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      {!mfaToken ? (
        <>
          <Field label="Email" htmlFor="email">
            <Input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          </Field>
          <Field label="Password" htmlFor="password">
            <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <div className="flex items-center gap-2">
            <Checkbox id="remember" checked={remember} onCheckedChange={(v) => setRemember(v === true)} />
            <Label htmlFor="remember" className="font-normal">
              Keep me signed in on this device
            </Label>
          </div>
        </>
      ) : (
        <Field label="Two-factor code" htmlFor="code" hint="Enter the 6-digit code from your authenticator app, or a recovery code.">
          <Input id="code" autoComplete="one-time-code" inputMode="text" required value={code} onChange={(e) => setCode(e.target.value)} autoFocus placeholder="123456" />
        </Field>
      )}
      {error && <p className="rounded-md bg-[hsl(var(--destructive)/0.08)] px-3 py-2 text-sm text-destructive">{error}</p>}
      <Button type="submit" className="w-full" loading={busy}>
        {mfaToken ? 'Verify' : 'Sign in'}
      </Button>
      {mfaToken && (
        <button type="button" className="w-full text-center text-xs text-muted-foreground hover:underline" onClick={() => setMfaToken(null)}>
          Use a different account
        </button>
      )}
    </form>
  );
}

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-subtle px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded bg-primary text-xs font-bold text-primary-foreground">C</div>
          <span className="font-semibold">CDN Console</span>
        </div>
        <div className="rounded-lg border bg-background p-6 shadow-sm">
          <h1 className="mb-1 text-lg font-semibold">Sign in</h1>
          <p className="mb-5 text-sm text-muted-foreground">Staff access only.</p>
          <React.Suspense>
            <LoginForm />
          </React.Suspense>
        </div>
      </div>
    </div>
  );
}
