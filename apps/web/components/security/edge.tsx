'use client';
import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FlaskConical, Plus, ShieldBan, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { ZoneDTO } from '@/lib/types';
import { formatDate, formatNumber, timeAgo } from '@/lib/utils';
import { Button } from '../ui/button';
import { Field, Input, NativeSelect, Switch } from '../ui/form';
import { Badge, EmptyState, Panel, Section, Skeleton } from '../ui/misc';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '../ui/dialog';
import { Table, TD, TH, THead, TR } from '../ui/table';

type Field = 'ip' | 'country' | 'asn' | 'path' | 'method' | 'host' | 'user_agent' | 'referer' | 'requests_per_minute';
type Op = 'eq' | 'neq' | 'in' | 'not_in' | 'contains' | 'not_contains' | 'starts_with' | 'matches' | 'gt' | 'lt' | 'in_cidr' | 'not_in_cidr';
interface Condition {
  field: Field;
  op: Op;
  value: string | number | string[];
}
interface Rule {
  id: string;
  zone_id: string | null;
  name: string;
  conditions: Condition[];
  action: 'ALLOW' | 'BLOCK' | 'CHALLENGE' | 'BAN' | 'LOG';
  ban_minutes: number | null;
  priority: number;
  enabled: boolean;
  hits: number;
  last_hit_at: string | null;
}
interface Ban {
  id: string;
  cidr: string;
  reason: string;
  source: string;
  expires_at: string | null;
  created_at: string;
}

const FIELD_LABEL: Record<Field, string> = {
  ip: 'IP address',
  country: 'Country',
  asn: 'ASN',
  path: 'Path',
  method: 'Method',
  host: 'Host',
  user_agent: 'User agent',
  referer: 'Referer',
  requests_per_minute: 'Requests / minute (per IP)',
};
const OP_LABEL: Record<Op, string> = {
  eq: 'equals',
  neq: 'does not equal',
  in: 'is one of',
  not_in: 'is not one of',
  contains: 'contains',
  not_contains: 'does not contain',
  starts_with: 'starts with',
  matches: 'matches regex',
  gt: 'is greater than',
  lt: 'is less than',
  in_cidr: 'is in network',
  not_in_cidr: 'is not in network',
};
const OPS_FOR: Record<Field, Op[]> = {
  ip: ['eq', 'neq', 'in_cidr', 'not_in_cidr'],
  country: ['eq', 'neq', 'in', 'not_in'],
  asn: ['eq', 'neq', 'in', 'not_in'],
  path: ['eq', 'starts_with', 'contains', 'not_contains', 'matches'],
  method: ['eq', 'neq', 'in'],
  host: ['eq', 'neq', 'in', 'contains'],
  user_agent: ['contains', 'not_contains', 'matches', 'eq'],
  referer: ['contains', 'not_contains', 'starts_with', 'eq'],
  requests_per_minute: ['gt', 'lt'],
};
const ACTION_TONE = { ALLOW: 'success', BLOCK: 'danger', CHALLENGE: 'warning', BAN: 'danger', LOG: 'neutral' } as const;

export function describeCondition(c: Condition): string {
  return `${FIELD_LABEL[c.field]} ${OP_LABEL[c.op]} ${Array.isArray(c.value) ? c.value.join(', ') : c.value}`;
}

function RuleDialog({ open, onOpenChange, rule, zones }: { open: boolean; onOpenChange: (o: boolean) => void; rule: Rule | null; zones: ZoneDTO[] }) {
  const qc = useQueryClient();
  const [name, setName] = React.useState('');
  const [zoneId, setZoneId] = React.useState('');
  const [conditions, setConditions] = React.useState<{ field: Field; op: Op; value: string }[]>([]);
  const [action, setAction] = React.useState<Rule['action']>('BLOCK');
  const [banMinutes, setBanMinutes] = React.useState('60');
  const [priority, setPriority] = React.useState('100');
  React.useEffect(() => {
    if (open) {
      setName(rule?.name ?? '');
      setZoneId(rule?.zone_id ?? '');
      setConditions(rule?.conditions.map((c) => ({ ...c, value: Array.isArray(c.value) ? c.value.join(', ') : String(c.value) })) ?? [{ field: 'country', op: 'eq', value: '' }]);
      setAction(rule?.action ?? 'BLOCK');
      setBanMinutes(String(rule?.ban_minutes ?? 60));
      setPriority(String(rule?.priority ?? 100));
    }
  }, [open, rule]);
  const update = (i: number, patch: Partial<{ field: Field; op: Op; value: string }>) =>
    setConditions((list) => list.map((c, j) => (j === i ? { ...c, ...patch, ...(patch.field ? { op: OPS_FOR[patch.field][0]! } : {}) } : c)));
  const toBody = () => ({
    name,
    conditions: conditions.map((c) => ({
      field: c.field,
      op: c.op,
      value: c.op === 'in' || c.op === 'not_in' ? c.value.split(',').map((v) => v.trim()).filter(Boolean) : c.field === 'requests_per_minute' || (c.field === 'asn' && (c.op === 'eq' || c.op === 'neq')) ? Number(c.value) : c.value,
    })),
    action,
    ban_minutes: action === 'BAN' ? Number(banMinutes) : null,
    priority: Number(priority),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl">
        <DialogHeader title={rule ? 'Edit security rule' : 'New security rule'} description="When every condition matches a delivery request, the action is applied. Rules run by priority (lowest first); zone rules run before global rules." />
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              if (rule) await api(`/security/rules/${rule.id}`, { method: 'PATCH', body: toBody() });
              else await api('/security/rules', { body: { ...toBody(), zone_id: zoneId || null } });
              toast.success('Security rule saved');
              void qc.invalidateQueries({ queryKey: ['security-rules'] });
              onOpenChange(false);
            } catch (err) {
              toast.error(errorMessage(err));
            }
          }}
        >
          <DialogBody>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Name">
                <Input value={name} onChange={(e) => setName(e.target.value)} required placeholder="Throttle scrapers" />
              </Field>
              <Field label="Applies to">
                <NativeSelect className="w-full" value={zoneId} disabled={Boolean(rule)} onChange={(e) => setZoneId(e.target.value)}>
                  <option value="">All delivery traffic</option>
                  {zones.map((z) => (
                    <option key={z.id} value={z.id}>
                      Zone: {z.name}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Field label="Priority">
                <Input type="number" min={0} max={10000} value={priority} onChange={(e) => setPriority(e.target.value)} />
              </Field>
            </div>
            <div className="space-y-2">
              <p className="text-[13px] font-medium">When</p>
              {conditions.map((c, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2">
                  <span className="w-8 text-xs text-muted-foreground">{i === 0 ? 'IF' : 'AND'}</span>
                  <NativeSelect value={c.field} onChange={(e) => update(i, { field: e.target.value as Field })} aria-label="Field">
                    {(Object.keys(FIELD_LABEL) as Field[]).map((f) => (
                      <option key={f} value={f}>
                        {FIELD_LABEL[f]}
                      </option>
                    ))}
                  </NativeSelect>
                  <NativeSelect value={c.op} onChange={(e) => update(i, { op: e.target.value as Op })} aria-label="Operator">
                    {OPS_FOR[c.field].map((o) => (
                      <option key={o} value={o}>
                        {OP_LABEL[o]}
                      </option>
                    ))}
                  </NativeSelect>
                  <Input className="min-w-[160px] flex-1" value={c.value} onChange={(e) => update(i, { value: e.target.value })} required placeholder={c.field === 'country' ? 'CN' : c.field === 'ip' ? '203.0.113.0/24' : c.op === 'in' || c.op === 'not_in' ? 'a, b, c' : ''} aria-label="Value" />
                  {conditions.length > 1 && (
                    <Button type="button" size="icon" variant="ghost" className="h-8 w-8" aria-label="Remove condition" onClick={() => setConditions((l) => l.filter((_, j) => j !== i))}>
                      <X />
                    </Button>
                  )}
                </div>
              ))}
              {conditions.length < 10 && (
                <Button type="button" size="xs" variant="secondary" onClick={() => setConditions((l) => [...l, { field: 'requests_per_minute', op: 'gt', value: '500' }])}>
                  <Plus /> Condition
                </Button>
              )}
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Then">
                <NativeSelect value={action} onChange={(e) => setAction(e.target.value as Rule['action'])}>
                  <option value="BLOCK">Block (403)</option>
                  <option value="CHALLENGE">Challenge (browser check)</option>
                  <option value="BAN">Ban the IP</option>
                  <option value="ALLOW">Allow (skip later rules)</option>
                  <option value="LOG">Log only (count hits)</option>
                </NativeSelect>
              </Field>
              {action === 'BAN' && (
                <Field label="Ban for (minutes)">
                  <Input type="number" min={1} value={banMinutes} onChange={(e) => setBanMinutes(e.target.value)} className="w-32" />
                </Field>
              )}
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit">Save rule</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TestPanel({ zones }: { zones: ZoneDTO[] }) {
  const [zoneId, setZoneId] = React.useState('');
  const [ip, setIp] = React.useState('203.0.113.10');
  const [country, setCountry] = React.useState('');
  const [ua, setUa] = React.useState('Mozilla/5.0');
  const [referer, setReferer] = React.useState('');
  const [rpm, setRpm] = React.useState('1');
  const [result, setResult] = React.useState<{ outcome: string; reason: string } | null>(null);
  return (
    <Panel className="space-y-3 p-4">
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Field label="Zone">
          <NativeSelect className="w-full" value={zoneId} onChange={(e) => setZoneId(e.target.value)}>
            <option value="">None</option>
            {zones.map((z) => (
              <option key={z.id} value={z.id}>
                {z.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field label="IP">
          <Input value={ip} onChange={(e) => setIp(e.target.value)} />
        </Field>
        <Field label="Country">
          <Input value={country} onChange={(e) => setCountry(e.target.value.toUpperCase())} maxLength={2} placeholder="AU" />
        </Field>
        <Field label="User agent">
          <Input value={ua} onChange={(e) => setUa(e.target.value)} />
        </Field>
        <Field label="Referer">
          <Input value={referer} onChange={(e) => setReferer(e.target.value)} />
        </Field>
        <Field label="Req / min">
          <Input type="number" min={0} value={rpm} onChange={(e) => setRpm(e.target.value)} />
        </Field>
      </div>
      <div className="flex items-center gap-3">
        <Button
          size="sm"
          variant="secondary"
          onClick={async () => {
            try {
              setResult(await api('/security/rules/test', { body: { zone_id: zoneId || null, ip, country: country || null, user_agent: ua, referer, requests_per_minute: Number(rpm) } }));
            } catch (err) {
              toast.error(errorMessage(err));
            }
          }}
        >
          <FlaskConical /> Test
        </Button>
        {result && (
          <span className="flex items-center gap-2 text-[13px]">
            <Badge tone={result.outcome === 'allow' ? 'success' : result.outcome === 'challenge' ? 'warning' : 'danger'}>{result.outcome}</Badge>
            {result.reason}
          </span>
        )}
      </div>
    </Panel>
  );
}

export function EdgeSecurity() {
  const { can } = useSession();
  const qc = useQueryClient();
  const manage = can('security.manage');
  const rules = useQuery({ queryKey: ['security-rules'], queryFn: () => api<{ data: Rule[] }>('/security/rules') });
  const bans = useQuery({ queryKey: ['ip-bans'], queryFn: () => api<{ data: Ban[] }>('/security/bans'), refetchInterval: 30_000 });
  const zones = useQuery({ queryKey: ['zones'], queryFn: () => api<{ data: ZoneDTO[] }>('/zones'), enabled: can('zones.view') });
  const [dialog, setDialog] = React.useState<{ open: boolean; rule: Rule | null }>({ open: false, rule: null });
  const [banCidr, setBanCidr] = React.useState('');
  const [banReason, setBanReason] = React.useState('');
  const [banMinutes, setBanMinutes] = React.useState('1440');
  const zoneName = (id: string | null) => (id ? (zones.data?.data.find((z) => z.id === id)?.name ?? id) : 'Global');
  return (
    <>
      <Section
        title="Security rules"
        description="WAF-style rules for CDN delivery: block, challenge or ban by country, network, path, user agent, referer or request rate."
        actions={
          manage && (
            <Button size="sm" onClick={() => setDialog({ open: true, rule: null })}>
              <Plus /> New rule
            </Button>
          )
        }
      >
        <Panel>
          {!rules.data ? (
            <Skeleton className="m-3 h-20" />
          ) : rules.data.data.length === 0 ? (
            <EmptyState icon={ShieldBan} title="No security rules" description="Example: challenge clients from one country making more than 500 requests per minute." />
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH className="w-14">Prio</TH>
                  <TH>Rule</TH>
                  <TH>Scope</TH>
                  <TH>Action</TH>
                  <TH className="text-right">Hits</TH>
                  <TH>Enabled</TH>
                  <TH className="w-20" />
                </tr>
              </THead>
              <tbody>
                {rules.data.data.map((r) => (
                  <TR key={r.id}>
                    <TD className="tabular text-muted-foreground">{r.priority}</TD>
                    <TD>
                      <div className="font-medium">{r.name}</div>
                      <div className="text-xs text-muted-foreground">{r.conditions.map(describeCondition).join(' AND ')}</div>
                    </TD>
                    <TD className="text-xs">{zoneName(r.zone_id)}</TD>
                    <TD>
                      <Badge tone={ACTION_TONE[r.action]}>
                        {r.action}
                        {r.action === 'BAN' && r.ban_minutes ? ` ${r.ban_minutes}m` : ''}
                      </Badge>
                    </TD>
                    <TD className="text-right tabular text-xs">
                      {formatNumber(r.hits)}
                      {r.last_hit_at && <div className="text-[11px] text-muted-foreground">{timeAgo(r.last_hit_at)}</div>}
                    </TD>
                    <TD>
                      <Switch
                        disabled={!manage}
                        checked={r.enabled}
                        onCheckedChange={async (v) => {
                          await api(`/security/rules/${r.id}`, { method: 'PATCH', body: { enabled: v } }).catch((e) => toast.error(errorMessage(e)));
                          void qc.invalidateQueries({ queryKey: ['security-rules'] });
                        }}
                      />
                    </TD>
                    <TD>
                      {manage && (
                        <div className="flex justify-end gap-1">
                          <Button size="xs" variant="ghost" onClick={() => setDialog({ open: true, rule: r })}>
                            Edit
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7 text-destructive"
                            aria-label="Delete rule"
                            onClick={async () => {
                              await api(`/security/rules/${r.id}`, { method: 'DELETE' }).catch((e) => toast.error(errorMessage(e)));
                              void qc.invalidateQueries({ queryKey: ['security-rules'] });
                            }}
                          >
                            <Trash2 />
                          </Button>
                        </div>
                      )}
                    </TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          )}
        </Panel>
      </Section>
      <Section title="Test rules" description="Dry-run zone restrictions and rules for a hypothetical request. Nothing is recorded.">
        <TestPanel zones={zones.data?.data ?? []} />
      </Section>
      <Section title="IP bans" description="Banned IPs and networks are refused everywhere — dashboard, API and delivery. Rules and API-key abuse detection add temporary bans automatically.">
        <Panel>
          {manage && (
            <form
              className="flex flex-wrap items-end gap-2 border-b p-3"
              onSubmit={async (e) => {
                e.preventDefault();
                try {
                  await api('/security/bans', { body: { cidr: banCidr.trim(), reason: banReason.trim() || 'Manual ban', minutes: banMinutes ? Number(banMinutes) : null } });
                  toast.success(`${banCidr} banned`);
                  setBanCidr('');
                  setBanReason('');
                  void qc.invalidateQueries({ queryKey: ['ip-bans'] });
                } catch (err) {
                  toast.error(errorMessage(err));
                }
              }}
            >
              <Field label="IP or CIDR">
                <Input value={banCidr} onChange={(e) => setBanCidr(e.target.value)} required placeholder="198.51.100.0/24" className="w-48" />
              </Field>
              <Field label="Reason">
                <Input value={banReason} onChange={(e) => setBanReason(e.target.value)} placeholder="Scraping" className="w-56" />
              </Field>
              <Field label="Duration">
                <NativeSelect value={banMinutes} onChange={(e) => setBanMinutes(e.target.value)}>
                  <option value="60">1 hour</option>
                  <option value="1440">1 day</option>
                  <option value="10080">7 days</option>
                  <option value="43200">30 days</option>
                  <option value="">Permanent</option>
                </NativeSelect>
              </Field>
              <Button type="submit" variant="destructive">
                <ShieldBan /> Ban
              </Button>
            </form>
          )}
          {!bans.data ? (
            <Skeleton className="m-3 h-16" />
          ) : bans.data.data.length === 0 ? (
            <p className="px-4 py-6 text-center text-[13px] text-muted-foreground">No active bans.</p>
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>IP / network</TH>
                  <TH>Reason</TH>
                  <TH>Source</TH>
                  <TH>Expires</TH>
                  <TH className="w-20" />
                </tr>
              </THead>
              <tbody>
                {bans.data.data.map((b) => (
                  <TR key={b.id}>
                    <TD className="font-mono text-xs">{b.cidr}</TD>
                    <TD className="text-xs">{b.reason}</TD>
                    <TD>
                      <Badge tone={b.source === 'manual' ? 'neutral' : 'warning'}>{b.source}</Badge>
                    </TD>
                    <TD className="whitespace-nowrap text-xs text-muted-foreground">{b.expires_at ? formatDate(b.expires_at) : 'Never'}</TD>
                    <TD>
                      {manage && (
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={async () => {
                            await api(`/security/bans/${b.id}`, { method: 'DELETE' }).catch((e) => toast.error(errorMessage(e)));
                            void qc.invalidateQueries({ queryKey: ['ip-bans'] });
                          }}
                        >
                          Lift
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
      <RuleDialog open={dialog.open} rule={dialog.rule} zones={zones.data?.data ?? []} onOpenChange={(o) => setDialog((s) => ({ ...s, open: o }))} />
    </>
  );
}
