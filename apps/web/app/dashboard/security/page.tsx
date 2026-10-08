'use client';
import * as React from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Paginated } from '@/lib/api';
import { useSession } from '@/lib/session';
import { formatDate, timeAgo } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/form';
import { Badge, EmptyState, ErrorState, PageHeader, Pagination, Panel, Section, Skeleton } from '@/components/ui/misc';
import { Table, TD, TH, THead, TR } from '@/components/ui/table';
import { useConfirm } from '@/components/confirm';
import { EdgeSecurity } from '@/components/security/edge';

interface Summary {
  last_24h: Record<string, number>;
  suspicious_ips: { ip: string; events: number }[];
  suspicious_api_keys: { id: string; name: string; prefix: string; events: number }[];
  expired_api_keys: { id: string; name: string; prefix: string; expires_at: string | null }[];
  revoked_api_keys: { id: string; name: string; prefix: string; revoked_at: string | null; revoked_reason: string | null }[];
  active_sessions: { id: string; user: { id: string; name: string; email: string }; ip: string | null; user_agent: string | null; last_seen_at: string; created_at: string; expires_at: string }[];
  recent_login_ips: { ip: string | null; user: string | null; logins: number; last_seen_at: string | null }[];
}
interface SecurityEvent {
  id: string;
  timestamp: string;
  type: string;
  severity: 'info' | 'warning' | 'critical';
  ip: string | null;
  user_id: string | null;
  api_key_id: string | null;
  details: Record<string, unknown>;
}

const LABELS: Record<string, string> = {
  failed_logins: 'Failed logins',
  account_lockouts: 'Account lockouts',
  rate_limited: 'Rate-limit events',
  invalid_api_keys: 'Invalid / expired / revoked key use',
  blocked_ips: 'Blocked IPs (key restrictions)',
  csrf_failures: 'CSRF failures',
  invalid_signed_urls: 'Invalid signed URLs',
  permission_denied: 'Permission denied',
};

function shortUa(ua: string | null) {
  if (!ua) return '—';
  const browser = /Firefox\/[\d]+|Edg\/[\d]+|Chrome\/[\d]+|Safari\/[\d]+/.exec(ua)?.[0] ?? 'Unknown';
  const os = /Windows|Mac OS X|Linux|Android|iPhone|iPad/.exec(ua)?.[0] ?? '';
  return `${browser.replace('/', ' ')}${os ? ` · ${os}` : ''}`;
}

export default function SecurityPage() {
  const { can, session } = useSession();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [type, setType] = React.useState('');
  const [page, setPage] = React.useState(1);
  const summary = useQuery({ queryKey: ['security-summary'], queryFn: () => api<Summary>('/security/summary'), refetchInterval: 60_000 });
  const events = useQuery({
    queryKey: ['security-events', type, page],
    queryFn: () => api<Paginated<SecurityEvent>>('/security/events', { query: { type: type || undefined, page, limit: 25 } }),
    placeholderData: keepPreviousData,
  });
  const s = summary.data;

  return (
    <>
      <PageHeader title="Security" description="Edge security rules and IP bans, authentication failures, suspicious API usage and active staff sessions." />
      <EdgeSecurity />
      {summary.isError && <ErrorState error={summary.error} onRetry={() => summary.refetch()} />}
      <div className="mb-8 grid grid-cols-2 divide-x divide-y rounded-lg border md:grid-cols-4">
        {Object.entries(LABELS).map(([k, label]) => (
          <div key={k} className="px-4 py-3">
            <div className="text-xs text-muted-foreground">{label}</div>
            {s ? <div className="mt-1 text-lg font-semibold tabular">{s.last_24h[k] ?? 0}</div> : <Skeleton className="mt-1 h-6 w-10" />}
            <div className="text-[11px] text-muted-foreground">last 24 hours</div>
          </div>
        ))}
      </div>

      <Section title="Active staff sessions" description="Sign out any device. Revoking a session takes effect on its next request.">
        <Panel>
          {!s ? (
            <Skeleton className="m-3 h-32" />
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>User</TH>
                  <TH>IP</TH>
                  <TH>Device</TH>
                  <TH>Last seen</TH>
                  <TH>Signed in</TH>
                  <TH className="w-24" />
                </tr>
              </THead>
              <tbody>
                {s.active_sessions.map((x) => (
                  <TR key={x.id}>
                    <TD>
                      {x.user.name} <span className="text-xs text-muted-foreground">{x.user.email}</span>
                      {x.id === session.session_id && <Badge tone="info" className="ml-1">This session</Badge>}
                    </TD>
                    <TD className="font-mono text-xs">{x.ip ?? '—'}</TD>
                    <TD className="text-muted-foreground" title={x.user_agent ?? ''}>
                      {shortUa(x.user_agent)}
                    </TD>
                    <TD className="text-muted-foreground">{timeAgo(x.last_seen_at)}</TD>
                    <TD className="text-muted-foreground">{formatDate(x.created_at)}</TD>
                    <TD>
                      {can('users.disable') && x.id !== session.session_id && (
                        <Button
                          size="xs"
                          variant="secondary"
                          onClick={() =>
                            confirm({
                              title: `Revoke ${x.user.name}'s session?`,
                              description: `${x.ip ?? 'Unknown IP'} · ${shortUa(x.user_agent)}`,
                              destructive: true,
                              confirmLabel: 'Revoke',
                              successMessage: 'Session revoked',
                              action: async () => {
                                await api(`/security/sessions/${x.id}`, { method: 'DELETE' });
                                void qc.invalidateQueries({ queryKey: ['security-summary'] });
                              },
                            })
                          }
                        >
                          Revoke
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

      {s && (
        <div className="grid gap-8 lg:grid-cols-2">
          <Section title="Suspicious IPs (7 days)">
            <Panel>
              {s.suspicious_ips.length === 0 ? (
                <EmptyState title="Nothing suspicious" />
              ) : (
                <Table>
                  <tbody>
                    {s.suspicious_ips.map((x) => (
                      <TR key={x.ip}>
                        <TD className="font-mono text-xs">{x.ip}</TD>
                        <TD className="text-right tabular">{x.events} events</TD>
                      </TR>
                    ))}
                  </tbody>
                </Table>
              )}
            </Panel>
          </Section>
          <Section title="Suspicious API key usage (7 days)">
            <Panel>
              {s.suspicious_api_keys.length === 0 ? (
                <EmptyState title="Nothing suspicious" />
              ) : (
                <Table>
                  <tbody>
                    {s.suspicious_api_keys.map((x) => (
                      <TR key={x.id}>
                        <TD>
                          {x.name} <span className="font-mono text-xs text-muted-foreground">{x.prefix}</span>
                        </TD>
                        <TD className="text-right tabular">{x.events} events</TD>
                      </TR>
                    ))}
                  </tbody>
                </Table>
              )}
            </Panel>
          </Section>
          <Section title="Expired API keys">
            <Panel>
              {s.expired_api_keys.length === 0 ? (
                <EmptyState title="No expired keys" />
              ) : (
                <Table>
                  <tbody>
                    {s.expired_api_keys.map((k) => (
                      <TR key={k.id}>
                        <TD>
                          {k.name} <span className="font-mono text-xs text-muted-foreground">{k.prefix}</span>
                        </TD>
                        <TD className="text-right text-muted-foreground">{formatDate(k.expires_at)}</TD>
                      </TR>
                    ))}
                  </tbody>
                </Table>
              )}
            </Panel>
          </Section>
          <Section title="Recently revoked keys (30 days)">
            <Panel>
              {s.revoked_api_keys.length === 0 ? (
                <EmptyState title="No revoked keys" />
              ) : (
                <Table>
                  <tbody>
                    {s.revoked_api_keys.map((k) => (
                      <TR key={k.id}>
                        <TD>
                          {k.name} <span className="font-mono text-xs text-muted-foreground">{k.prefix}</span>
                        </TD>
                        <TD className="text-muted-foreground">{k.revoked_reason ?? ''}</TD>
                        <TD className="text-right text-muted-foreground">{formatDate(k.revoked_at)}</TD>
                      </TR>
                    ))}
                  </tbody>
                </Table>
              )}
            </Panel>
          </Section>
          <Section title="Recent login IP addresses (30 days)" className="lg:col-span-2">
            <Panel>
              {s.recent_login_ips.length === 0 ? (
                <EmptyState title="No logins recorded" />
              ) : (
                <Table>
                  <THead>
                    <tr>
                      <TH>IP</TH>
                      <TH>User</TH>
                      <TH className="text-right">Logins</TH>
                      <TH>Last seen</TH>
                    </tr>
                  </THead>
                  <tbody>
                    {s.recent_login_ips.map((x, i) => (
                      <TR key={i}>
                        <TD className="font-mono text-xs">{x.ip}</TD>
                        <TD>{x.user}</TD>
                        <TD className="text-right tabular">{x.logins}</TD>
                        <TD className="text-muted-foreground">{timeAgo(x.last_seen_at)}</TD>
                      </TR>
                    ))}
                  </tbody>
                </Table>
              )}
            </Panel>
          </Section>
        </div>
      )}

      <Section
        title="Security events"
        actions={
          <NativeSelect className="h-8 text-xs" value={type} onChange={(e) => (setType(e.target.value), setPage(1))} aria-label="Event type">
            <option value="">All types</option>
            {['LOGIN_FAILED', 'ACCOUNT_LOCKED', 'MFA_FAILED', 'RATE_LIMITED', 'INVALID_API_KEY', 'EXPIRED_API_KEY', 'REVOKED_API_KEY', 'API_KEY_IP_BLOCKED', 'API_KEY_ENDPOINT_BLOCKED', 'API_KEY_SCOPE_DENIED', 'CSRF_FAILED', 'SIGNED_URL_INVALID', 'PERMISSION_DENIED', 'MALWARE_DETECTED'].map((t) => (
              <option key={t}>{t}</option>
            ))}
          </NativeSelect>
        }
      >
        <Panel>
          {events.isLoading ? (
            <Skeleton className="m-3 h-40" />
          ) : !events.data?.data.length ? (
            <EmptyState title="No security events" />
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Time</TH>
                  <TH>Type</TH>
                  <TH>Severity</TH>
                  <TH>IP</TH>
                  <TH>Details</TH>
                </tr>
              </THead>
              <tbody>
                {events.data.data.map((e) => (
                  <TR key={e.id}>
                    <TD className="whitespace-nowrap text-muted-foreground">{formatDate(e.timestamp)}</TD>
                    <TD className="font-mono text-xs">{e.type}</TD>
                    <TD>
                      <Badge tone={e.severity === 'critical' ? 'danger' : e.severity === 'warning' ? 'warning' : 'neutral'}>{e.severity}</Badge>
                    </TD>
                    <TD className="font-mono text-xs">{e.ip ?? '—'}</TD>
                    <TD className="max-w-[360px] truncate font-mono text-[11px] text-muted-foreground" title={JSON.stringify(e.details)}>
                      {JSON.stringify(e.details)}
                    </TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          )}
          {events.data && <Pagination page={page} totalPages={events.data.pagination.total_pages} total={events.data.pagination.total} onPage={setPage} />}
        </Panel>
      </Section>
    </>
  );
}
