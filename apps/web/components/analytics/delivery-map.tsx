'use client';
import * as React from 'react';
import { geoCentroid, geoInterpolate, geoNaturalEarth1, geoPath } from 'd3-geo';
import { feature } from 'topojson-client';
import type { Topology, GeometryCollection } from 'topojson-specification';
import type { Feature, FeatureCollection, Geometry } from 'geojson';
import countries from 'i18n-iso-countries';
import en from 'i18n-iso-countries/langs/en.json';
import world from 'world-atlas/countries-110m.json';
import { formatBytes, formatNumber } from '@/lib/utils';

export interface GeoData {
  countries: { country: string; requests: number; bytes: number; hit_ratio: number; p50_ms: number }[];
  origins: { id: string; name: string; kind: string; region: string; country: string | null; health: string }[];
  flows: { from: string; to: string; requests: number; bytes: number }[];
}

type CountryFeature = Feature<Geometry, { name: string }>;

countries.registerLocale(en);

const W = 960;
const H = 480;
const topo = world as unknown as Topology<{ countries: GeometryCollection<{ name: string }> }>;
const LAND = (feature(topo, topo.objects.countries) as FeatureCollection<Geometry, { name: string }>).features as CountryFeature[];
const projection = geoNaturalEarth1().fitSize([W, H], { type: 'Sphere' });
const path = geoPath(projection);
const byNumeric = new Map(LAND.map((f) => [String(f.id).padStart(3, '0'), f]));

function featureFor(alpha2: string): CountryFeature | undefined {
  const n = countries.alpha2ToNumeric(alpha2);
  return n ? byNumeric.get(n) : undefined;
}

function centroid(alpha2: string): [number, number] | null {
  const f = featureFor(alpha2);
  return f ? (geoCentroid(f) as [number, number]) : null;
}

/** Great-circle arc between two lon/lat points as an SVG path. */
function arc(a: [number, number], b: [number, number]): string {
  const interp = geoInterpolate(a, b);
  const pts = Array.from({ length: 33 }, (_, i) => projection(interp(i / 32)));
  return pts.filter((p): p is [number, number] => Boolean(p)).map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
}

/**
 * Interactive delivery map: countries shaded by request volume (one sequential hue),
 * origins as markers and animated great-circle flows from origin providers to visitors.
 */
export function DeliveryMap({ data }: { data: GeoData }) {
  const [hover, setHover] = React.useState<{ code: string; x: number; y: number } | null>(null);
  const stats = new Map(data.countries.map((c) => [c.country, c]));
  const max = Math.max(1, ...data.countries.map((c) => c.requests));
  const totalFlow = Math.max(1, ...data.flows.map((f) => f.requests));
  const origins = data.origins.filter((o) => o.country && centroid(o.country));
  const originPos = new Map(origins.map((o) => [o.id, centroid(o.country!)!]));
  const flows = data.flows.filter((f) => f.to !== 'XX' && originPos.has(f.from) && centroid(f.to)).slice(0, 60);
  const hovered = hover ? stats.get(hover.code) : null;

  return (
    <div className="relative">
      <style>{`@keyframes cdn-flow { to { stroke-dashoffset: -24; } } .cdn-flow { animation: cdn-flow 1.2s linear infinite; } @media (prefers-reduced-motion: reduce) { .cdn-flow { animation: none; } }`}</style>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="World map of delivery requests by visitor country">
        <path d={path({ type: 'Sphere' }) ?? ''} fill="hsl(var(--muted) / 0.35)" />
        {LAND.map((f) => {
          const code = countries.numericToAlpha2(String(f.id).padStart(3, '0')) ?? '';
          const s = stats.get(code);
          const t = s ? 0.18 + 0.82 * Math.sqrt(s.requests / max) : 0;
          return (
            <path
              key={String(f.id)}
              d={path(f) ?? ''}
              fill={s ? 'var(--series-1)' : 'hsl(var(--muted))'}
              fillOpacity={s ? t : 1}
              stroke="hsl(var(--background))"
              strokeWidth={0.6}
              onMouseMove={(e) => {
                const r = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
                setHover({ code, x: e.clientX - r.left, y: e.clientY - r.top });
              }}
              onMouseLeave={() => setHover(null)}
            />
          );
        })}
        {flows.map((f, i) => (
          <path
            key={i}
            d={arc(originPos.get(f.from)!, centroid(f.to)!)}
            fill="none"
            stroke="var(--series-2)"
            strokeOpacity={0.75}
            strokeWidth={1 + 3 * (f.requests / totalFlow)}
            strokeDasharray="4 8"
            strokeLinecap="round"
            className="cdn-flow"
            pointerEvents="none"
          />
        ))}
        {origins.map((o) => {
          const p = projection(originPos.get(o.id)!);
          if (!p) return null;
          return (
            <g key={o.id} transform={`translate(${p[0]},${p[1]})`}>
              <circle r={7} fill="hsl(var(--background))" />
              <circle r={5} fill={o.health === 'unhealthy' ? 'hsl(var(--destructive))' : 'var(--series-2)'} />
              <text y={-10} textAnchor="middle" fontSize={11} fill="hsl(var(--foreground))" paintOrder="stroke" stroke="hsl(var(--background))" strokeWidth={3}>
                {o.name}
              </text>
            </g>
          );
        })}
      </svg>
      {hover && (
        <div className="pointer-events-none absolute z-10 rounded-md border bg-popover px-2.5 py-1.5 text-xs shadow-md" style={{ left: Math.min(hover.x + 12, 9999), top: hover.y + 12 }}>
          <div className="font-medium text-foreground">{countries.getName(hover.code, 'en') ?? hover.code}</div>
          {hovered ? (
            <div className="tabular text-muted-foreground">
              {formatNumber(hovered.requests)} requests · {formatBytes(hovered.bytes)} · {(hovered.hit_ratio * 100).toFixed(0)}% origin hits · p50 {hovered.p50_ms} ms
            </div>
          ) : (
            <div className="text-muted-foreground">No traffic</div>
          )}
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-10 rounded-sm" style={{ background: 'linear-gradient(90deg, color-mix(in srgb, var(--series-1) 18%, transparent), var(--series-1))' }} /> Requests (low → high)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: 'var(--series-2)' }} /> Storage origin (set “served countries” on a provider to place it)
        </span>
      </div>
    </div>
  );
}

export function countryName(code: string): string {
  return code === 'XX' ? 'Unknown' : (countries.getName(code, 'en') ?? code);
}
