import { useEffect, useRef, useState } from 'react';
import {
  getObservabilitySummary, getSystemHealth, getSystemResources,
  ObservabilitySummary, ServiceHealth, SystemResources,
} from '../api';
import { RecentTurns } from './RecentTurns';
import { CardsSkeleton } from './ui';

/** The Observability board (docs/plans/observability-board.md, phase 1) — a
 *  dedicated top-level panel: service health, live resource gauges for this
 *  instance, and 24h turn/cost rollups over the turn ledger. Live-only for
 *  now; history + a fleet of instances arrive in phase 2. */

const POLL_MS = 4000;
const WINDOWS = ['1h', '6h', '24h', '7d'] as const;

function pct(used: number | null, total: number | null): number | null {
  if (used == null || total == null || total <= 0) return null;
  return Math.min(100, Math.round((used / total) * 100));
}

function barColor(p: number | null): string {
  if (p == null) return 'bg-stone-600';
  if (p >= 90) return 'bg-red-500';
  if (p >= 75) return 'bg-amber-500';
  return 'bg-teal-500';
}

function Meter({ label, value, detail }: { label: string; value: number | null; detail: string }) {
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-[11px]">
        <span className="text-stone-400">{label}</span>
        <span className="text-stone-300 font-mono">{detail}</span>
      </div>
      <div className="h-2.5 rounded bg-stone-800 overflow-hidden">
        <div className={`h-full ${barColor(value)} transition-[width] duration-500`}
          style={{ width: `${value ?? 0}%` }} />
      </div>
    </div>
  );
}

function StatTile({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-stone-700/70 bg-stone-800/40 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-stone-500">{label}</div>
      <div className={`text-lg font-mono ${tone ?? 'text-stone-200'}`}>{value}</div>
    </div>
  );
}

function HealthChip({ s }: { s: ServiceHealth }) {
  const muted = s.optional && !s.ok;
  const dot = s.ok ? 'bg-emerald-500' : muted ? 'bg-stone-600' : 'bg-red-500';
  const text = s.ok ? 'text-stone-300' : muted ? 'text-stone-500' : 'text-red-300';
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full border border-stone-700 bg-stone-800/50 text-[11px] ${text}`}
      title={s.detail ?? (s.optional && !s.ok ? 'optional service — not running' : s.ok ? `up · ${s.ms} ms` : 'down')}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
      {s.name}
      {s.ok && s.ms != null && <span className="text-stone-600 font-mono">{s.ms}ms</span>}
    </span>
  );
}

export function ObservabilityOverlay({ onClose }: { onClose: () => void }) {
  const [res, setRes] = useState<SystemResources | null>(null);
  const [health, setHealth] = useState<ServiceHealth[] | null>(null);
  const [summary, setSummary] = useState<ObservabilitySummary | null>(null);
  const [window, setWindow] = useState<(typeof WINDOWS)[number]>('24h');
  const [err, setErr] = useState<string | null>(null);
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    const tick = async () => {
      try {
        const [r, h] = await Promise.all([getSystemResources(), getSystemHealth()]);
        if (!live.current) return;
        setRes(r); setHealth(h.services); setErr(null);
      } catch (e) {
        if (live.current) setErr(String(e));
      }
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => { live.current = false; clearInterval(id); };
  }, []);

  useEffect(() => {
    getObservabilitySummary(window).then(setSummary).catch(e => setErr(String(e)));
  }, [window]);

  const inst = res?.instance;
  const gpus = res?.gpu?.gpus ?? [];
  const dk = res?.disk?.docker;
  // docker reports CPU per-core (100% = one full core, so a container can read
  // >100% on a multi-core box). Divide by cores to show share of the WHOLE
  // machine — consistent with the CPU gauge above, and never over 100%.
  const cores = res?.cpu.cores ?? null;

  return (
    <div className="absolute inset-0 z-30 flex items-start justify-center pt-16 bg-black/40" onClick={onClose}>
      <div
        className="w-[52rem] max-w-[calc(100vw-1rem)] md:max-w-[calc(100vw-26rem)] max-h-[82vh] flex flex-col rounded-xl bg-stone-900/95 backdrop-blur border border-stone-700 shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <header className="px-4 py-3 border-b border-stone-700 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm text-stone-200 font-medium">Observability</span>
            {inst && (
              <span className="inline-flex items-center gap-1.5 text-[11px] text-stone-500 truncate">
                · <span className="text-stone-400">{inst.label}</span>
                {inst.leader && (
                  <span className="px-1.5 py-0.5 rounded bg-teal-900/50 border border-teal-800 text-teal-300">leader</span>
                )}
                {res?.platform && <span className="text-stone-600 font-mono">{res.platform}</span>}
              </span>
            )}
          </div>
          <button onClick={onClose} className="text-stone-500 hover:text-stone-200 text-lg px-1" aria-label="Close">×</button>
        </header>

        <div className="flex-1 overflow-y-auto nice-scroll p-4 space-y-5">
          {err && (
            <div className="text-xs text-red-400 border border-red-900/60 bg-red-950/30 rounded px-3 py-2">
              {err}
            </div>
          )}

          {/* no-zeros rule: hold the whole board on a skeleton until the
              first tick lands, instead of painting sparse placeholders */}
          {!res && !err && <CardsSkeleton n={3} />}

          {res && <>
          {/* Health / topology strip */}
          <section>
            <h3 className="text-xs uppercase tracking-wide text-stone-500 mb-2">Service health</h3>
            <div className="flex flex-wrap gap-1.5">
              {health
                ? health.map(s => <HealthChip key={s.name} s={s} />)
                : <span className="text-xs text-stone-500">Probing…</span>}
            </div>
          </section>

          {/* Live resources */}
          <section>
            <h3 className="text-xs uppercase tracking-wide text-stone-500 mb-2">Resources</h3>
            {!res ? (
              <div className="text-xs text-stone-500">Reading…</div>
            ) : (
              <div className="grid md:grid-cols-2 gap-x-6 gap-y-3">
                <Meter label="CPU" value={res.cpu.pct}
                  detail={`${res.cpu.pct ?? '?'}%${res.cpu.load1 != null ? ` · load ${res.cpu.load1}` : ''}${res.cpu.cores ? ` · ${res.cpu.cores} cores` : ''}`} />
                <Meter label="Memory" value={pct(res.mem.used_gb, res.mem.total_gb)}
                  detail={`${res.mem.used_gb ?? '?'} / ${res.mem.total_gb ?? '?'} GB`} />
                {gpus.map((g, i) => (
                  <Meter key={i} label={`VRAM${gpus.length > 1 ? ` · ${g.name}` : ''}`}
                    value={pct(g.mem_used_gb, g.mem_total_gb)}
                    detail={`${g.mem_used_gb} / ${g.mem_total_gb} GB · ${g.util_pct}% · ${g.temp_c}°C`} />
                ))}
                {gpus.length === 0 && (
                  <div className="flex items-end text-[11px] text-stone-600">
                    {res.gpu ? 'No GPU active (CPU inference or ollama stopped)' : 'GPU stats unavailable'}
                  </div>
                )}
                <Meter label="Disk (root)" value={pct(res.disk.used_gb, res.disk.total_gb)}
                  detail={`${res.disk.used_gb ?? '?'} / ${res.disk.total_gb ?? '?'} GB`} />
                {dk && (
                  <div className="flex items-end text-[11px] text-stone-600 font-mono">
                    Docker: {dk.images_gb ?? 0}GB images · {dk.volumes_gb ?? 0}GB volumes · {dk.build_cache_gb ?? 0}GB cache
                  </div>
                )}
              </div>
            )}
          </section>

          {/* Containers */}
          {res && res.containers.length > 0 && (
            <section>
              <h3 className="text-xs uppercase tracking-wide text-stone-500 mb-2">Containers</h3>
              <div className="rounded-lg border border-stone-700/70 overflow-hidden">
                <table className="w-full text-[11px]">
                  <thead className="text-stone-500 bg-stone-800/40">
                    <tr>
                      <th className="text-left font-normal px-3 py-1.5">service</th>
                      <th className="text-left font-normal px-3 py-1.5">state</th>
                      <th className="text-right font-normal px-3 py-1.5"
                        title={cores ? `share of the whole machine (${cores} cores)` : 'cpu'}>cpu</th>
                      <th className="text-right font-normal px-3 py-1.5">mem</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono text-stone-300">
                    {res.containers.map(c => (
                      <tr key={c.name} className="border-t border-stone-800">
                        <td className="px-3 py-1 truncate">{c.service || c.name}</td>
                        <td className={`px-3 py-1 ${c.state === 'running' ? 'text-emerald-400' : 'text-stone-500'}`}>{c.state}</td>
                        <td className="px-3 py-1 text-right"
                          title={c.cpu_pct != null
                            ? `${(c.cpu_pct / 100).toFixed(2)} cores · ${c.cpu_pct}% of one core (docker stats)`
                            : undefined}>
                          {c.cpu_pct != null
                            ? `${cores ? (c.cpu_pct / cores).toFixed(1) : c.cpu_pct.toFixed(0)}%`
                            : '—'}
                        </td>
                        <td className="px-3 py-1 text-right">{c.mem_used_gb != null ? `${c.mem_used_gb} GB` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* Turns & cost */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs uppercase tracking-wide text-stone-500">Turns &amp; cost</h3>
              <div className="flex gap-1 text-[11px]">
                {WINDOWS.map(w => (
                  <button key={w} onClick={() => setWindow(w)}
                    className={`px-2 py-0.5 rounded ${w === window ? 'bg-teal-700/50 text-teal-200' : 'text-stone-500 hover:text-stone-300'}`}>
                    {w}
                  </button>
                ))}
              </div>
            </div>
            {!summary && <CardsSkeleton n={1} />}
            {summary && (
              <>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3">
                  <StatTile label="Turns" value={String(summary.turns)} />
                  <StatTile label="Error rate"
                    value={`${(summary.error_rate * 100).toFixed(1)}%`}
                    tone={summary.errors ? 'text-red-400' : 'text-stone-200'} />
                  <StatTile label="p50 / p95"
                    value={`${summary.p50_secs ?? '–'} / ${summary.p95_secs ?? '–'}s`} />
                  <StatTile label="Tokens" value={summary.tokens.total.toLocaleString()} />
                </div>
                <div className="flex items-center justify-between text-[11px] text-stone-500 mb-2">
                  <span>
                    est. cost <span className="text-stone-300 font-mono">${summary.est_cost.toFixed(4)}</span>
                    {summary.cost_partial && <span className="text-amber-500/80"> · some models unpriced</span>}
                  </span>
                  <span className="font-mono">
                    {Object.entries(summary.sources).map(([k, v]) => `${v} ${k}`).join(' · ')}
                  </span>
                </div>
                {summary.by_model.length > 0 && (
                  <div className="rounded-lg border border-stone-700/70 overflow-hidden mb-3">
                    <table className="w-full text-[11px]">
                      <thead className="text-stone-500 bg-stone-800/40">
                        <tr>
                          <th className="text-left font-normal px-3 py-1.5">model</th>
                          <th className="text-right font-normal px-3 py-1.5">turns</th>
                          <th className="text-right font-normal px-3 py-1.5">prompt</th>
                          <th className="text-right font-normal px-3 py-1.5">completion</th>
                          <th className="text-right font-normal px-3 py-1.5">est. cost</th>
                        </tr>
                      </thead>
                      <tbody className="font-mono text-stone-300">
                        {summary.by_model.map(m => (
                          <tr key={m.model} className="border-t border-stone-800">
                            <td className="px-3 py-1 truncate max-w-[16rem]" title={m.model}>{m.model}</td>
                            <td className="px-3 py-1 text-right">{m.turns}</td>
                            <td className="px-3 py-1 text-right">{m.prompt.toLocaleString()}</td>
                            <td className="px-3 py-1 text-right">{m.completion.toLocaleString()}</td>
                            <td className="px-3 py-1 text-right">
                              {m.priced ? `$${(m.est_cost ?? 0).toFixed(4)}` : <span className="text-stone-600">—</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
            <RecentTurns />
          </section>
          </>}
        </div>
      </div>
    </div>
  );
}
