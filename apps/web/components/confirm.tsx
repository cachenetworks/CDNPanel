'use client';
import * as React from 'react';
import { toast } from 'sonner';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from './ui/dialog';
import { Button } from './ui/button';
import { Field, Input } from './ui/form';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';

export interface ConfirmOptions {
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
  /** User must type this text to enable the confirm button. */
  typeToConfirm?: string;
  /** Ask for the password up-front (step-up authentication). */
  requireReauth?: boolean;
  action: () => Promise<unknown>;
  successMessage?: string;
}

type Ctx = (opts: ConfirmOptions) => void;
const ConfirmContext = React.createContext<Ctx | null>(null);

export function useConfirm(): Ctx {
  const ctx = React.useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used within ConfirmProvider');
  return ctx;
}

/**
 * Confirmation dialog for dangerous actions. If the server answers `reauthentication_required`
 * (or `requireReauth` is set) the dialog asks for the password (+2FA code) and retries.
 */
export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const { session } = useSession();
  const [opts, setOpts] = React.useState<ConfirmOptions | null>(null);
  const [typed, setTyped] = React.useState('');
  const [needReauth, setNeedReauth] = React.useState(false);
  const [password, setPassword] = React.useState('');
  const [code, setCode] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const open = React.useCallback((o: ConfirmOptions) => {
    setOpts(o);
    setTyped('');
    setPassword('');
    setCode('');
    setError(null);
    setNeedReauth(Boolean(o.requireReauth));
  }, []);

  const close = () => {
    if (!busy) setOpts(null);
  };

  const run = async () => {
    if (!opts) return;
    setBusy(true);
    setError(null);
    try {
      if (needReauth) {
        await api('/auth/reauth', { body: { password, ...(code ? { code } : {}) } });
      }
      await opts.action();
      if (opts.successMessage) toast.success(opts.successMessage);
      setOpts(null);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'reauthentication_required') {
        setNeedReauth(true);
        setError('Please confirm your password to continue.');
      } else {
        setError(errorMessage(err));
      }
    } finally {
      setBusy(false);
      setPassword('');
      setCode('');
    }
  };

  const disabled = (opts?.typeToConfirm && typed !== opts.typeToConfirm) || (needReauth && !password);

  return (
    <ConfirmContext.Provider value={open}>
      {children}
      <Dialog open={Boolean(opts)} onOpenChange={(o) => !o && close()}>
        {opts && (
          <DialogContent size="sm">
            <DialogHeader title={opts.title} description={opts.description} />
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!disabled) void run();
              }}
            >
              <DialogBody>
                {opts.typeToConfirm && (
                  <Field label={`Type "${opts.typeToConfirm}" to confirm`}>
                    <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus autoComplete="off" />
                  </Field>
                )}
                {needReauth && (
                  <>
                    <Field label="Your password" hint="Sensitive actions require you to confirm your identity.">
                      <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" autoFocus={!opts.typeToConfirm} />
                    </Field>
                    {session.user.two_factor_enabled && (
                      <Field label="Authenticator code">
                        <Input inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" placeholder="123456" />
                      </Field>
                    )}
                  </>
                )}
                {error && <p className="text-sm text-destructive">{error}</p>}
                {!opts.typeToConfirm && !needReauth && !error && <p className="text-sm text-muted-foreground">This action cannot be undone.</p>}
              </DialogBody>
              <DialogFooter>
                <Button type="button" variant="secondary" onClick={close} disabled={busy}>
                  Cancel
                </Button>
                <Button type="submit" variant={opts.destructive ? 'destructive' : 'default'} loading={busy} disabled={Boolean(disabled)}>
                  {opts.confirmLabel ?? 'Confirm'}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        )}
      </Dialog>
    </ConfirmContext.Provider>
  );
}

/** Runs `action`; if the server requires step-up authentication, asks for the password and retries. */
export function useStepUp() {
  const confirm = useConfirm();
  return React.useCallback(
    async (action: () => Promise<unknown>, opts: { title?: string; successMessage?: string } = {}) => {
      try {
        await action();
        if (opts.successMessage) toast.success(opts.successMessage);
      } catch (err) {
        if (err instanceof ApiError && err.code === 'reauthentication_required') {
          confirm({ title: opts.title ?? 'Confirm your password', requireReauth: true, confirmLabel: 'Continue', action, successMessage: opts.successMessage });
          return;
        }
        toast.error(errorMessage(err));
      }
    },
    [confirm],
  );
}
