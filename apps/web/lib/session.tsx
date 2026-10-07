'use client';
import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter, usePathname } from 'next/navigation';
import type { Permission } from '@cdn/shared/permissions';
import { api, onAuthError, setCsrfToken } from './api';

export interface SessionData {
  user: { id: string; email: string; name: string; two_factor_enabled: boolean };
  roles: string[];
  permissions: Permission[];
  csrf_token: string;
  session_id: string;
  two_factor_enrollment_required: boolean;
  site_name: string;
}

interface SessionContextValue {
  session: SessionData;
  can: (...perms: Permission[]) => boolean;
  refresh: () => Promise<void>;
}

const SessionContext = React.createContext<SessionContextValue | null>(null);

export function useSession(): SessionContextValue {
  const ctx = React.useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside SessionProvider');
  return ctx;
}

/** Loads the staff session; redirects to /login when signed out. */
export function SessionProvider({ children, fallback }: { children: React.ReactNode; fallback: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const qc = useQueryClient();
  const { data, error, isLoading } = useQuery({
    queryKey: ['session'],
    queryFn: async () => {
      const s = await api<SessionData>('/auth/session', { silent: true });
      setCsrfToken(s.csrf_token);
      return s;
    },
    staleTime: 60_000,
    retry: false,
  });

  React.useEffect(() => {
    return onAuthError(() => {
      setCsrfToken(null);
      qc.clear();
      router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    });
  }, [qc, router, pathname]);

  React.useEffect(() => {
    if (error) router.replace(`/login?next=${encodeURIComponent(pathname)}`);
  }, [error, router, pathname]);

  React.useEffect(() => {
    if (data?.two_factor_enrollment_required && pathname !== '/dashboard/account') router.replace('/dashboard/account?enroll=1');
  }, [data, pathname, router]);

  const value = React.useMemo<SessionContextValue | null>(() => {
    if (!data) return null;
    const set = new Set(data.permissions);
    return {
      session: data,
      can: (...perms) => perms.every((p) => set.has(p)),
      refresh: async () => {
        await qc.invalidateQueries({ queryKey: ['session'] });
      },
    };
  }, [data, qc]);

  if (isLoading || !value) return <>{fallback}</>;
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
