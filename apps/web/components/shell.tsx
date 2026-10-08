'use client';
import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  Activity,
  BarChart3,
  Bot,
  BookOpen,
  CalendarClock,
  Coins,
  Globe,
  Recycle,
  ScanSearch,
  ServerCog,
  Share2,
  Zap,
  FolderTree,
  Files,
  HardDrive,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Menu,
  Moon,
  Settings,
  Shield,
  ShieldCheck,
  Sun,
  UploadCloud,
  UserCog,
  Users,
} from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import type { Permission } from '@cdn/shared/permissions';
import { cn } from '@/lib/utils';
import { api, setCsrfToken } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useUploads } from './uploads/upload-manager';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from './ui/misc';

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  perm?: Permission;
}

const NAV: { group?: string; items: NavItem[] }[] = [
  {
    items: [
      { href: '/dashboard', label: 'Overview', icon: LayoutDashboard },
      { href: '/dashboard/files', label: 'Files', icon: Files, perm: 'files.view' },
      { href: '/dashboard/folders', label: 'Folders', icon: FolderTree, perm: 'files.view' },
      { href: '/dashboard/uploads', label: 'Uploads', icon: UploadCloud, perm: 'files.upload' },
      { href: '/dashboard/trash', label: 'Recycle Bin', icon: Recycle, perm: 'files.view' },
    ],
  },
  {
    group: 'Delivery',
    items: [
      { href: '/dashboard/zones', label: 'Zones & Domains', icon: Globe, perm: 'zones.view' },
      { href: '/dashboard/cache', label: 'Cache', icon: Zap, perm: 'analytics.view' },
      { href: '/dashboard/shares', label: 'Share Links', icon: Share2, perm: 'shares.manage' },
      { href: '/dashboard/inspector', label: 'Asset Inspector', icon: ScanSearch, perm: 'files.view' },
    ],
  },
  {
    group: 'Developers',
    items: [
      { href: '/dashboard/api-keys', label: 'API Keys', icon: KeyRound, perm: 'api_keys.view' },
      { href: '/dashboard/service-accounts', label: 'Service Accounts', icon: Bot, perm: 'api_keys.view' },
      { href: '/dashboard/docs', label: 'API Documentation', icon: BookOpen },
    ],
  },
  {
    group: 'Monitoring',
    items: [
      { href: '/dashboard/analytics', label: 'Analytics', icon: BarChart3, perm: 'analytics.view' },
      { href: '/dashboard/usage', label: 'Usage & Costs', icon: Coins, perm: 'usage.view' },
      { href: '/dashboard/operations', label: 'Operations', icon: ServerCog, perm: 'ops.view' },
      { href: '/dashboard/activity', label: 'Activity Logs', icon: Activity, perm: 'logs.view' },
    ],
  },
  {
    group: 'Administration',
    items: [
      { href: '/dashboard/users', label: 'Users', icon: Users, perm: 'users.view' },
      { href: '/dashboard/roles', label: 'Roles', icon: ShieldCheck, perm: 'roles.view' },
      { href: '/dashboard/storage', label: 'Storage', icon: HardDrive, perm: 'files.view' },
      { href: '/dashboard/security', label: 'Security', icon: Shield, perm: 'logs.view' },
      { href: '/dashboard/lifecycle', label: 'Lifecycle Rules', icon: CalendarClock, perm: 'zones.view' },
      { href: '/dashboard/settings', label: 'Settings', icon: Settings, perm: 'settings.view' },
    ],
  },
];

function ThemeToggle() {
  const [dark, setDark] = React.useState(false);
  React.useEffect(() => setDark(document.documentElement.classList.contains('dark')), []);
  return (
    <button
      type="button"
      className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
      aria-label="Toggle theme"
      onClick={() => {
        const next = !dark;
        setDark(next);
        document.documentElement.classList.toggle('dark', next);
        try {
          localStorage.setItem('theme', next ? 'dark' : 'light');
        } catch {
          /* storage unavailable */
        }
      }}
    >
      {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  );
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const { session, can } = useSession();
  const { activeCount } = useUploads();
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 items-center gap-2 border-b px-4">
        <div className="flex h-6 w-6 items-center justify-center rounded bg-primary text-[11px] font-bold text-primary-foreground">C</div>
        <span className="truncate text-sm font-semibold">{session.site_name}</span>
      </div>
      <nav className="flex-1 overflow-y-auto px-2 py-3">
        {NAV.map((section, i) => {
          const items = section.items.filter((it) => !it.perm || can(it.perm));
          if (!items.length) return null;
          return (
            <div key={i} className="mb-4">
              {section.group && <p className="mb-1 px-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/80">{section.group}</p>}
              {items.map((it) => {
                const active = it.href === '/dashboard' ? pathname === it.href : pathname.startsWith(it.href);
                return (
                  <Link
                    key={it.href}
                    href={it.href}
                    onClick={onNavigate}
                    className={cn(
                      'flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
                      active && 'bg-accent font-medium text-foreground',
                    )}
                  >
                    <it.icon className="h-4 w-4" />
                    <span className="flex-1">{it.label}</span>
                    {it.href === '/dashboard/uploads' && activeCount > 0 && <span className="rounded bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground">{activeCount}</span>}
                  </Link>
                );
              })}
            </div>
          );
        })}
      </nav>
    </div>
  );
}

function UserMenu() {
  const { session } = useSession();
  const router = useRouter();
  const qc = useQueryClient();
  const initials = session.user.name
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-accent">
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-muted text-[11px] font-semibold">{initials}</span>
        <span className="hidden text-left sm:block">
          <span className="block text-[13px] font-medium leading-tight">{session.user.name}</span>
          <span className="block text-[11px] leading-tight text-muted-foreground">{session.roles.join(', ') || 'No role'}</span>
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <div className="px-2 py-1.5 text-xs text-muted-foreground">{session.user.email}</div>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => router.push('/dashboard/account')}>
          <UserCog /> Account & security
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={async () => {
            await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
            setCsrfToken(null);
            qc.clear();
            router.replace('/login');
          }}
        >
          <LogOut /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  const [mobileOpen, setMobileOpen] = React.useState(false);
  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-56 shrink-0 border-r bg-subtle lg:block">
        <Sidebar />
      </aside>
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-60 border-r bg-background">
            <Sidebar onNavigate={() => setMobileOpen(false)} />
          </aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-2 border-b bg-background/95 px-4 backdrop-blur lg:px-6">
          <button type="button" className="rounded-md p-1.5 hover:bg-accent lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Open navigation">
            <Menu className="h-5 w-5" />
          </button>
          <div className="flex-1" />
          <ThemeToggle />
          <UserMenu />
        </header>
        <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
