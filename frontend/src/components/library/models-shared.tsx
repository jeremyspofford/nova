import { useState, useEffect } from 'react';
import {
  AgentInfo, ModelBudget, ModelRecommendation, ProbeResult, RecommendationsResponse, getAgents, getModelBudget, getRecommendations, patchAgent, patchSettings, testModel, StackMode,
} from '../../api';
import { agentDisplayName } from '../../names';
import { fmtTime } from '../../time';

export function probeLine(p: ProbeResult | 'running' | undefined) {
  if (!p) return null;
  if (p === 'running') return <span className="text-amber-400">probing… (local models can take a minute)</span>;
  if (p.error) return <span className="text-red-400">✗ {p.error}</span>;
  if (!p.tool_call_ok) return <span className="text-red-400">✗ tool call failed the mechanical check</span>;
  if (p.agentic_ok === false) {
    return (
      <span className="text-amber-400">
        ⚠ calls tools when forced, but NARRATES in agentic context — dispatches
        it describes won't actually happen · {p.tok_s != null && `${p.tok_s} tok/s · `}TTFT {p.ttft_ms} ms
      </span>
    );
  }
  return (
    <span className="text-emerald-400">
      ✓ tool call{p.agentic_ok ? ' + agentic judgment' : ''} verified ·{' '}
      {p.tok_s != null && `${p.tok_s} tok/s · `}
      TTFT {p.ttft_ms} ms · {p.gpu_active ? `GPU (${p.vram_gb ?? '?'} GB VRAM)` : p.gpu_active === false ? 'CPU' : 'cloud'}
    </span>
  );
}

const BAR_COLORS = ['bg-teal-600', 'bg-sky-600', 'bg-violet-600', 'bg-amber-600',
  'bg-rose-600', 'bg-lime-600'];

/** One stacked memory bar: distinct local models as segments vs the pool
 *  total. Many agents on one model = one segment (one load in Ollama). */
function MemoryBar({ label, used, total, over, items }: {
  label: string; used: number; total: number | null; over: boolean;
  items: { model: string; gb: number | null; source: string; pinned: boolean; agents: string[] }[];
}) {
  if (!items.length) return null;
  const denom = total && total > 0 ? Math.max(total, used) : Math.max(used, 1);
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-[11px] text-stone-400">
        <span>{label}</span>
        <span className={over ? 'text-red-400' : ''}>
          {used} / {total ?? '?'} GB{over && total != null ? ` — over by ${Math.round((used - total) * 10) / 10} GB` : ''}
        </span>
      </div>
      <div className="h-2.5 rounded bg-stone-800 overflow-hidden flex">
        {items.map((it, i) => (
          <div
            key={it.model}
            title={`${it.model} — ${it.gb ?? '?'} GB (${it.source})`}
            className={`${BAR_COLORS[i % BAR_COLORS.length]} ${it.source !== 'probe' ? 'opacity-60' : ''} h-full`}
            style={{ width: `${((it.gb ?? 0) / denom) * 100}%` }}
          />
        ))}
        {total != null && used < total && <div className="flex-1" />}
      </div>
      <div className="space-y-0.5">
        {items.map((it, i) => (
          <div key={it.model} className="flex items-center gap-1.5 text-[11px]">
            <span className={`w-2 h-2 rounded-sm shrink-0 ${BAR_COLORS[i % BAR_COLORS.length]}`} />
            <span className="font-mono text-stone-300 truncate">{it.model}</span>
            <span className="text-stone-500 shrink-0">
              {it.gb != null ? `${it.gb} GB` : '? GB'}
              {it.source === 'estimate' ? ' est.' : it.source === 'unknown' ? ' — probe it' : ''}
              {it.pinned ? ' · 📌 pinned' : ''}
            </span>
            <span className="text-stone-600 truncate">· {it.agents.join(', ')}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Both pools of a budget, plus the cloud models listed at zero. */
function BudgetBars({ budget }: { budget: ModelBudget }) {
  const vramItems = budget.items.filter(i => i.pool === 'vram');
  const ramItems = budget.items.filter(i => i.pool === 'ram');
  const cloudItems = budget.items.filter(i => i.pool === 'cloud');
  return (
    <div className="space-y-2">
      <MemoryBar label="VRAM if all load at once" used={budget.vram_used_gb}
        total={budget.vram_total_gb} over={budget.vram_over} items={vramItems} />
      <MemoryBar label="RAM if all load at once (OS overhead not included)"
        used={budget.ram_used_gb} total={budget.ram_total_gb}
        over={budget.ram_over} items={ramItems} />
      {cloudItems.length > 0 && (
        <div className="text-[11px] text-stone-600">
          cloud (0 GB local): {cloudItems.map(i => `${i.model} (${i.agents.length})`).join(' · ')}
        </div>
      )}
      {(budget.vram_over || budget.ram_over) && (
        <div className="text-[11px] text-amber-400/90">
          Over budget doesn't crash — Ollama evicts or spills to CPU, which
          shows up as multi-second reloads on every agent switch.
        </div>
      )}
    </div>
  );
}

/** Concurrent-load card for the CURRENT assignments. In Nova concurrency is
 *  the common case: a dispatch turn runs main's model and the sub-agent's
 *  within one request. */
export function ConcurrentLoad() {
  const [budget, setBudget] = useState<ModelBudget | null>(null);
  const load = () => getModelBudget().then(setBudget).catch(() => setBudget(null));
  useEffect(() => {
    load();
    const onChange = () => load();
    window.addEventListener('nova:setting-changed', onChange);
    return () => window.removeEventListener('nova:setting-changed', onChange);
  }, []);

  if (!budget) return null;
  return (
    <div className="rounded-lg border border-stone-700 bg-stone-800/50 p-3 space-y-2">
      <div className="flex items-center justify-between gap-4">
        <div className="text-sm text-stone-200">Concurrent load — current assignments</div>
        <button onClick={load}
          className="text-xs px-2 py-0.5 rounded border border-stone-600 text-stone-400 hover:text-stone-200">
          refresh
        </button>
      </div>
      <BudgetBars budget={budget} />
    </div>
  );
}

/** Detect & suggest — hardware-sized, per-agent model recommendations with
 *  a one-click probe. Detection runs on demand and is timestamped; nothing
 *  is cached or pulled behind the operator's back. */
export function DetectSuggest() {
  const [recs, setRecs] = useState<RecommendationsResponse | null>(null);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState('');
  const [probes, setProbes] = useState<Record<string, ProbeResult | 'running'>>({});
  const [applied, setApplied] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<StackMode>('hybrid');

  async function detect(m: StackMode = mode) {
    setRunning(true);
    setStatus('');
    setApplied(new Set());
    try {
      const [r, a] = await Promise.all([getRecommendations(m), getAgents()]);
      setRecs(r);
      setAgents(a);
    } catch (e) { setStatus(String(e)); }
    setRunning(false);
  }

  // switching the stack strategy re-runs the whole recommendation set in place
  function changeMode(m: StackMode) {
    setMode(m);
    if (recs) detect(m);
  }

  async function apply(rec: ModelRecommendation) {
    if (!rec.suggested_model) return;
    try {
      if (rec.agent === 'compaction (setting)') {
        await patchSettings({ 'compaction.model': rec.suggested_model });
      } else {
        const agent = agents.find(a => a.name === rec.agent);
        if (!agent) throw new Error(`agent ${rec.agent} not found`);
        await patchAgent(agent.id, { model: rec.suggested_model });
      }
      setApplied(prev => new Set(prev).add(rec.agent));
    } catch (e) { setStatus(String(e)); }
  }

  async function applyAll() {
    if (!recs) return;
    for (const r of recs.recommendations) {
      if (r.status === 'switch' && !applied.has(r.agent)) await apply(r);
    }
  }

  async function probe(model: string) {
    setProbes(p => ({ ...p, [model]: 'running' }));
    try {
      const res = await testModel(model);
      setProbes(p => ({ ...p, [model]: res }));
    } catch (e) {
      setProbes(p => ({
        ...p,
        [model]: { model, ok: false, error: String(e) } as ProbeResult,
      }));
    }
  }

  const hw = recs?.hardware;
  const switches = recs?.recommendations.filter(r => r.status === 'switch') ?? [];

  return (
    <div className="rounded-lg border border-stone-700 bg-stone-800/50 p-3 space-y-2">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-sm text-stone-200">Detect &amp; suggest</div>
          <div className="text-xs text-stone-500">
            Size this machine and suggest a model per agent from the curated
            table below. Suggestions are advice — test them before trusting them.
          </div>
        </div>
        <button
          onClick={() => detect()}
          disabled={running}
          className="shrink-0 text-xs bg-teal-700 hover:bg-teal-600 disabled:bg-stone-700 text-white rounded px-3 py-1"
        >
          {running ? 'detecting…' : recs ? 'refresh' : 'detect & suggest'}
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-stone-700/60 pt-2">
        <span className="text-xs text-stone-400">stack</span>
        <div className="inline-flex rounded border border-stone-700 overflow-hidden">
          {(['local', 'hybrid', 'cloud'] as StackMode[]).map(m => (
            <button key={m} onClick={() => changeMode(m)} disabled={running}
              className={`text-xs px-2.5 py-0.5 capitalize disabled:opacity-50 ${mode === m
                ? 'bg-teal-700/70 text-teal-100' : 'text-stone-400 hover:text-stone-200'}`}>
              {m}
            </button>
          ))}
        </div>
        <span className="text-[11px] text-stone-500">
          {mode === 'local' ? 'self-hosted only'
            : mode === 'cloud' ? 'prefer cloud providers'
            : 'best of local + cloud'}
        </span>
      </div>
      {recs?.mode_note && (
        <div className="text-[11px] text-amber-400/90">{recs.mode_note}</div>
      )}

      {hw && (
        <div className="text-xs font-mono text-stone-400 border-t border-stone-700/60 pt-2">
          {hw.ram_gb ?? '?'} GB RAM
          {hw.memory_override_gb ? ` (sizing vs ${hw.sizing_ram_gb} GB — operator override)` : ''} ·{' '}
          {hw.cpu_cores ?? '?'} cores ·
          {hw.gpu_name
            ? ` ${hw.gpu_name} · ${hw.vram_total_gb} GB VRAM`
            : hw.unified_gpu
            ? ' unified-memory GPU (observed)'
            : hw.nvidia_runtime
            ? ` NVIDIA runtime ✓ · VRAM ${hw.vram_observed_gb != null ? `${hw.vram_observed_gb} GB observed` : 'unmeasured'}`
            : hw.nvidia_runtime === false ? ' no GPU runtime' : ' GPU unknown'} ·
          detected {fmtTime(hw.detected_at)}
          {!recs?.cloud_available && <span className="text-stone-500"> · no cloud key — local only</span>}
        </div>
      )}
      {hw?.memory_note && (
        <div className="text-[11px] text-stone-500">{hw.memory_note}</div>
      )}
      {hw?.nvidia_runtime && hw.vram_total_gb == null && (
        <div className="text-xs text-amber-400/90">
          GPU runtime detected, but the bundled Ollama isn't exposing a GPU —
          it may be stopped, or running without the GPU override
          (docker-compose.gpu.yml, merged automatically by the sidecar).
          Restart it with the toggle above, then re-detect.
        </div>
      )}
      {recs?.catalog_freshness?.stale && (
        <div className="text-xs text-amber-400/90">
          The model catalog's newest entry is {recs.catalog_freshness.age_days} days
          old — models move fast, so these suggestions may trail the frontier.
          Ask the model-manager (chat: "any newer models I should run?") to check
          for current releases and propose additions.
        </div>
      )}

      {recs && (
        <div className="space-y-2">
          {recs.recommendations.map(r => (
            <div key={r.agent} className="rounded border border-stone-700/60 bg-stone-900/40 px-2.5 py-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-xs text-stone-100">{agentDisplayName(r.agent)}</span>
                  <span className="text-[10px] px-1 rounded bg-stone-700 text-stone-400">{r.profile}</span>
                  {r.current_valid === false && (
                    <span
                      className="text-[10px] px-1.5 py-0.5 rounded border bg-red-950/50 text-red-300 border-red-900"
                      title="Pin guard: the current model is not in the live catalog — requests with it will fail."
                    >
                      current model missing
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {r.status === 'keep' ? (
                    <span className="text-[10px] px-1.5 py-0.5 rounded border border-emerald-800 text-emerald-400">✓ keep current</span>
                  ) : r.status === 'switch' && r.suggested_model ? (
                    <>
                      <button
                        onClick={() => probe(r.suggested_model!)}
                        disabled={probes[r.suggested_model] === 'running'}
                        className="text-xs px-2 py-0.5 rounded border border-stone-600 text-stone-400 hover:text-stone-200 disabled:opacity-50"
                      >
                        test
                      </button>
                      {applied.has(r.agent) ? (
                        <span className="text-[10px] px-1.5 py-0.5 rounded border border-emerald-800 text-emerald-400">✓ applied</span>
                      ) : (
                        <button
                          onClick={() => apply(r)}
                          className="text-xs px-2 py-0.5 rounded bg-teal-700 hover:bg-teal-600 text-white"
                        >
                          apply
                        </button>
                      )}
                    </>
                  ) : (
                    <span className="text-[10px] text-stone-500">no fit</span>
                  )}
                </div>
              </div>
              <div className="mt-1 text-xs font-mono text-stone-400 truncate">
                {r.current_model}
                {r.status === 'switch' && r.suggested_model && (
                  <> <span className="text-stone-600">→</span> <span className="text-teal-300">{r.suggested_model}</span></>
                )}
              </div>
              <div className="mt-0.5 text-xs text-stone-500">{r.reason}</div>
              {r.alternates.length > 0 && (
                <div className="mt-0.5 text-[11px] text-stone-600">
                  alternates: {r.alternates.map(a => `${a.model} (${a.note})`).join(' · ')}
                </div>
              )}
              {r.suggested_model && probes[r.suggested_model] && (
                <div className="mt-1 text-xs font-mono">{probeLine(probes[r.suggested_model])}</div>
              )}
            </div>
          ))}
          <div className="rounded border border-stone-700/60 bg-stone-900/40 px-2.5 py-2">
            <div className="text-[11px] text-stone-400 mb-1.5">If all SUGGESTED models load at once:</div>
            <BudgetBars budget={recs.budget} />
          </div>
          {switches.length > 1 && (
            <button
              onClick={applyAll}
              className="w-full text-xs bg-teal-800/60 hover:bg-teal-700 text-teal-100 rounded py-1.5"
            >
              apply all {switches.filter(r => !applied.has(r.agent)).length} suggestions
            </button>
          )}
        </div>
      )}
      {status && <div className="text-xs text-red-400">{status}</div>}
    </div>
  );
}
