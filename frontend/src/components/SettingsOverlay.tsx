import { useEffect, useState } from 'react';
import {
  AgentInfo, Automation, BundledInferenceStatus, CuratedModel, DbToolInfo,
  ModelInfo, ModelRecommendation, ProbeResult, RecommendationsResponse, Rule,
  SettingDef, ToolsCatalog, createAgent, createAutomation, createCuratedModel,
  createRule, createTool, deleteAgent, deleteAutomation, deleteCuratedModel,
  deleteRule, deleteTool, getAgents, getAutomations, getBundledInference,
  getCuratedModels, getModels, getRecommendations, getRules, getSettings,
  getTools, patchAgent, patchAutomation, patchCuratedModel, patchRule,
  patchSettings, patchTool, pullModel, setBundledInference, testModel,
} from '../api';
import { THEMES } from '../brain/theme';
import { displayName } from '../names';
import { ThemePreview } from './ThemePreview';

type Tab = 'settings' | 'agents' | 'automations' | 'rules' | 'tools';

export function SettingsOverlay({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('settings');

  // ui.edit_mode gates manual create/edit/delete across the tabs (the API
  // enforces it too — hiding buttons is UX, not the security boundary)
  const [editMode, setEditMode] = useState(false);
  useEffect(() => {
    getSettings().then(defs =>
      setEditMode(Boolean(defs.find(d => d.key === 'ui.edit_mode')?.value))
    ).catch(() => {});
    const onChange = (e: Event) => {
      const { key, value } = (e as CustomEvent).detail as { key: string; value: unknown };
      if (key === 'ui.edit_mode') setEditMode(Boolean(value));
    };
    window.addEventListener('nova:setting-changed', onChange);
    return () => window.removeEventListener('nova:setting-changed', onChange);
  }, []);

  return (
    <div className="absolute inset-0 z-30 flex items-start justify-center pt-16 bg-black/40" onClick={onClose}>
      <div
        className="w-[46rem] max-w-[calc(100vw-26rem)] max-h-[82vh] flex flex-col rounded-xl bg-stone-900/95 backdrop-blur border border-stone-700 shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <header className="px-4 py-3 border-b border-stone-700 flex items-center justify-between">
          <div className="flex gap-1 text-sm">
            {(['settings', 'agents', 'automations', 'rules', 'tools'] as Tab[]).map(t => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-3 py-1.5 rounded capitalize ${
                  tab === t ? 'bg-teal-700/50 text-teal-200' : 'text-stone-400 hover:text-stone-200'
                }`}
              >
                {t}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            {/* status badge only — the switch itself lives in Settings → Operator */}
            <span
              title="Whether manual create/edit/delete is allowed in these tabs. Change it under Settings → Operator → Edit mode."
              className={`text-xs px-2.5 py-1 rounded-full border select-none ${
                editMode
                  ? 'border-amber-600 text-amber-300 bg-amber-900/30'
                  : 'border-stone-600 text-stone-500'
              }`}
            >
              {editMode ? '✏️ edit mode' : '🔒 view only'}
            </span>
            <button onClick={onClose} className="text-stone-500 hover:text-stone-200 text-lg px-1" aria-label="Close">×</button>
          </div>
        </header>
        <div className="flex-1 overflow-y-auto nice-scroll p-4">
          {tab === 'settings' ? <SettingsTab exclude={['Automations']} editMode={editMode} />
            : tab === 'agents' ? <AgentsTab editMode={editMode} />
            : tab === 'automations' ? <AutomationsTab editMode={editMode} />
            : tab === 'rules' ? <RulesTab editMode={editMode} />
            : <ToolsTab editMode={editMode} />}
        </div>
      </div>
    </div>
  );
}

/** Shown wherever create/edit/delete affordances are hidden. */
function EditModeHint() {
  return (
    <p className="text-xs text-stone-500">
      🔒 View mode: you can enable/disable, but not create, edit, or delete.
      Turn on <b className="text-stone-400">Settings → Operator → Edit mode</b> to change that.
    </p>
  );
}

function SettingsTab({ only, exclude, editMode = false }:
    { only?: string[]; exclude?: string[]; editMode?: boolean }) {
  const [defs, setDefs] = useState<SettingDef[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [status, setStatus] = useState<string>('');

  useEffect(() => {
    getSettings().then(setDefs).catch(e => setStatus(String(e)));
    getModels().then(setModels).catch(() => {});
    // stay in sync when a setting is changed elsewhere (e.g. the header chip)
    const onExternal = (e: Event) => {
      const { key, value } = (e as CustomEvent).detail as { key: string; value: unknown };
      setDefs(prev => prev.map(d => d.key === key ? { ...d, value } : d));
    };
    window.addEventListener('nova:setting-changed', onExternal);
    return () => window.removeEventListener('nova:setting-changed', onExternal);
  }, []);

  async function save(key: string, value: unknown) {
    try {
      await patchSettings({ [key]: value });
      setDefs(prev => prev.map(d => d.key === key ? { ...d, value } : d));
      // Brain (and anything else) reacts live without a page reload
      window.dispatchEvent(new CustomEvent('nova:setting-changed', { detail: { key, value } }));
      setStatus(`Saved ${key}`);
      setTimeout(() => setStatus(''), 1500);
    } catch (e) {
      setStatus(String(e));
    }
  }

  function field(d: SettingDef) {
    if (d.key === 'brain.view') {
      return (
        <div className="flex gap-3">
          {Object.keys(THEMES).map(k => (
            <ThemePreview key={k} themeKey={k} selected={d.value === k}
              onSelect={() => save(d.key, k)} />
          ))}
        </div>
      );
    }
    if (d.type === 'boolean') {
      return (
        <button
          onClick={() => save(d.key, !d.value)}
          className={`shrink-0 w-10 px-0.5 py-0.5 rounded-full transition ${
            d.value ? 'bg-teal-600' : 'bg-stone-700'
          }`}
          aria-label={d.label}
        >
          <span className={`block w-4 h-4 rounded-full bg-white transition-transform ${
            d.value ? 'translate-x-5' : ''
          }`} />
        </button>
      );
    }
    if (d.type === 'enum') {
      return (
        <select
          value={String(d.value)}
          onChange={e => save(d.key, e.target.value)}
          className="shrink-0 bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200"
        >
          {(d.options ?? []).map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      );
    }
    if (d.type === 'model') {
      const scoped = d.model_scope === 'ollama'
        ? models.filter(m => m.provider === 'ollama')
        : models;
      return (
        <select
          value={String(d.value)}
          onChange={e => save(d.key, e.target.value)}
          className="shrink-0 max-w-[16rem] bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200"
        >
          {d.allow_empty && <option value="">(agent's model)</option>}
          {scoped.map(m => (
            <option key={m.id} value={d.model_scope === 'ollama' ? m.name : m.id}>
              {m.name}
            </option>
          ))}
          {/* keep the stored value selectable even if not currently listed */}
          {!!d.value && !scoped.some(m =>
            (d.model_scope === 'ollama' ? m.name : m.id) === d.value) && (
            <option value={String(d.value)}>{String(d.value)} (not detected)</option>
          )}
        </select>
      );
    }
    if (d.type === 'number' && d.min != null && d.max != null && d.max - d.min <= 20) {
      return (
        <span className="shrink-0 flex items-center gap-2">
          <input
            type="range" min={d.min} max={d.max}
            step={(d.max - d.min) / 20}
            value={Number(d.value)}
            onChange={e => save(d.key, Number(e.target.value))}
            className="w-28 accent-teal-500"
          />
          <span className="text-xs font-mono text-stone-400 w-8 text-right">{Number(d.value).toFixed(1)}</span>
        </span>
      );
    }
    return (
      <input
        className="shrink-0 w-40 bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200 text-right focus:outline-none focus:ring-1 focus:ring-teal-500"
        defaultValue={String(d.value)}
        onBlur={e => {
          const raw = e.target.value.trim();
          const v = d.type === 'number' ? Number(raw) : raw;
          if (v !== d.value) save(d.key, v);
        }}
      />
    );
  }

  const sections = [...new Set(defs.map(d => d.section))]
    .filter(s => (!only || only.includes(s)) && !(exclude ?? []).includes(s));
  return (
    <div className="space-y-5">
      {sections.map(section => (
        <section key={section}>
          <h3 className="text-xs uppercase tracking-wide text-stone-500 mb-2">{section}</h3>
          <div className="space-y-3">
            {section === 'Inference' && (
              <BundledInference onChanged={() => getModels().then(setModels)} />
            )}
            {defs.filter(d => d.section === section).map(d => (
              <div key={d.key}
                className={d.key === 'brain.view'
                  ? 'space-y-2'
                  : 'flex items-start justify-between gap-4'}>
                <div className="min-w-0">
                  <div className="text-sm text-stone-200">{d.label}</div>
                  <div className="text-xs text-stone-500">{d.description}</div>
                </div>
                {field(d)}
              </div>
            ))}
            {section === 'Inference' && <PullModel onPulled={() => getModels().then(setModels)} />}
            {section === 'Inference' && <DetectSuggest />}
            {section === 'Inference' && <CuratedTable editMode={editMode} />}
          </div>
        </section>
      ))}
      {status && <div className="text-xs text-teal-400">{status}</div>}
    </div>
  );
}

/** Start/stop the bundled Ollama container via the inference-control
 *  sidecar. Hidden entirely when the sidecar isn't running. */
function BundledInference({ onChanged }: { onChanged: () => void }) {
  const [st, setSt] = useState<BundledInferenceStatus | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    const load = () => getBundledInference().then(setSt).catch(() => setSt(null));
    load();
    const iv = setInterval(load, 4000);
    return () => clearInterval(iv);
  }, []);

  if (!st?.available) return null;

  const busy = !!st.op;
  const [dot, text] =
    st.op === 'start' ? ['bg-amber-400 animate-pulse', 'starting…'] :
    st.op === 'stop' ? ['bg-amber-400 animate-pulse', 'stopping…'] :
    st.running && st.api_ok ? ['bg-emerald-400', 'running'] :
    st.running ? ['bg-amber-400', 'running — API warming up'] :
    st.present ? ['bg-stone-500', 'stopped'] :
    ['bg-stone-500', 'not installed'];

  async function toggle() {
    if (!st || busy) return;
    setErr('');
    const action = st.running ? 'stop' : 'start';
    try {
      await setBundledInference(action);
      setSt({ ...st, op: action });
      onChanged();
    } catch (e) {
      setErr(String(e));
    }
  }

  return (
    <div className="rounded-lg border border-stone-700 bg-stone-800/50 p-3">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-sm text-stone-200 flex items-center gap-2">
            Bundled Ollama
            <span className={`w-2 h-2 rounded-full ${dot}`} />
            <span className="text-xs text-stone-400">{text}</span>
          </div>
          <div className="text-xs text-stone-500">
            The local-inference container. Stop it to free RAM/VRAM — pulled
            models persist across stops.
            {!st.present && ' First start downloads the Ollama image (~1 GB).'}
          </div>
        </div>
        <button
          onClick={toggle}
          disabled={busy}
          className={`shrink-0 text-xs rounded px-3 py-1 text-white disabled:bg-stone-700 ${
            st.running ? 'bg-stone-600 hover:bg-stone-500' : 'bg-teal-700 hover:bg-teal-600'
          }`}
        >
          {busy ? 'working…' : st.running ? 'stop' : 'start'}
        </button>
      </div>
      {(err || st.error) && (
        <div className="mt-1.5 text-xs text-red-400">{err || st.error}</div>
      )}
    </div>
  );
}

/** Pull a new Ollama model from inside Nova (streams progress from /api/pull). */
function PullModel({ onPulled }: { onPulled: () => void }) {
  const [name, setName] = useState('');
  const [progress, setProgress] = useState('');
  const [pulling, setPulling] = useState(false);

  async function pull(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || pulling) return;
    setPulling(true);
    setProgress('starting…');
    try {
      for await (const ev of pullModel(name.trim())) {
        if (typeof ev.error === 'string') {
          setProgress(`✗ ${ev.error}`);
          setPulling(false);
          return;
        }
        const status = String(ev.status ?? '');
        if (typeof ev.total === 'number' && typeof ev.completed === 'number' && ev.total > 0) {
          setProgress(`${status} — ${Math.round((ev.completed / ev.total) * 100)}%`);
        } else if (status) {
          setProgress(status);
        }
      }
      setProgress(`✓ ${name.trim()} ready`);
      onPulled();
    } catch (err) {
      setProgress(`✗ ${err}`);
    } finally {
      setPulling(false);
    }
  }

  return (
    <form onSubmit={pull} className="mt-1 rounded-lg border border-dashed border-stone-700 p-3 space-y-2">
      <div className="text-sm text-stone-200">Pull a new local model</div>
      <div className="text-xs text-stone-500">
        Any model from the Ollama library (e.g. <code className="font-mono">qwen2.5:7b</code>,{' '}
        <code className="font-mono">llama3.2:3b</code>). Downloads into the bundled service.
      </div>
      <div className="flex gap-2">
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="model:tag"
          disabled={pulling}
          className="flex-1 bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm font-mono text-stone-200 disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={pulling || !name.trim()}
          className="text-xs bg-teal-700 hover:bg-teal-600 disabled:bg-stone-700 text-white rounded px-3 py-1"
        >
          {pulling ? 'pulling…' : 'pull'}
        </button>
      </div>
      {progress && <div className="text-xs font-mono text-stone-400">{progress}</div>}
    </form>
  );
}

function probeLine(p: ProbeResult | 'running' | undefined) {
  if (!p) return null;
  if (p === 'running') return <span className="text-amber-400">probing… (local models can take a minute)</span>;
  if (p.error) return <span className="text-red-400">✗ {p.error}</span>;
  if (!p.tool_call_ok) return <span className="text-red-400">✗ tool call failed the mechanical check</span>;
  return (
    <span className="text-emerald-400">
      ✓ tool call verified · {p.tok_s != null && `${p.tok_s} tok/s · `}
      TTFT {p.ttft_ms} ms · {p.gpu_active ? `GPU (${p.vram_gb ?? '?'} GB VRAM)` : p.gpu_active === false ? 'CPU' : 'cloud'}
    </span>
  );
}

/** Detect & suggest — hardware-sized, per-agent model recommendations with
 *  a one-click probe. Detection runs on demand and is timestamped; nothing
 *  is cached or pulled behind the operator's back. */
function DetectSuggest() {
  const [recs, setRecs] = useState<RecommendationsResponse | null>(null);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState('');
  const [probes, setProbes] = useState<Record<string, ProbeResult | 'running'>>({});
  const [applied, setApplied] = useState<Set<string>>(new Set());

  async function detect() {
    setRunning(true);
    setStatus('');
    setApplied(new Set());
    try {
      const [r, a] = await Promise.all([getRecommendations(), getAgents()]);
      setRecs(r);
      setAgents(a);
    } catch (e) { setStatus(String(e)); }
    setRunning(false);
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
          onClick={detect}
          disabled={running}
          className="shrink-0 text-xs bg-teal-700 hover:bg-teal-600 disabled:bg-stone-700 text-white rounded px-3 py-1"
        >
          {running ? 'detecting…' : recs ? 'refresh' : 'detect & suggest'}
        </button>
      </div>

      {hw && (
        <div className="text-xs font-mono text-stone-400 border-t border-stone-700/60 pt-2">
          {hw.ram_gb ?? '?'} GB RAM · {hw.cpu_cores ?? '?'} cores ·
          {hw.gpu_name
            ? ` ${hw.gpu_name} · ${hw.vram_total_gb} GB VRAM`
            : hw.nvidia_runtime
            ? ` NVIDIA runtime ✓ · VRAM ${hw.vram_observed_gb != null ? `${hw.vram_observed_gb} GB observed` : 'unmeasured'}`
            : hw.nvidia_runtime === false ? ' no GPU runtime' : ' GPU unknown'} ·
          detected {new Date(hw.detected_at).toLocaleTimeString()}
          {!recs?.cloud_available && <span className="text-stone-500"> · no cloud key — local only</span>}
        </div>
      )}
      {hw?.nvidia_runtime && hw.vram_total_gb == null && (
        <div className="text-xs text-amber-400/90">
          GPU runtime detected, but the bundled Ollama isn't exposing a GPU —
          it may be stopped, or running without the GPU override
          (docker-compose.gpu.yml, merged automatically by the sidecar).
          Restart it with the toggle above, then re-detect.
        </div>
      )}

      {recs && (
        <div className="space-y-2">
          {recs.recommendations.map(r => (
            <div key={r.agent} className="rounded border border-stone-700/60 bg-stone-900/40 px-2.5 py-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-xs text-stone-100">{displayName(r.agent)}</span>
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

/** The curated model table behind recommendations — seeded knowledge,
 *  operator-editable (system rows toggle-only, like rules/tools). */
function CuratedTable({ editMode }: { editMode: boolean }) {
  const [rows, setRows] = useState<CuratedModel[]>([]);
  const [status, setStatus] = useState('');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<CuratedModel | null>(null);
  const emptyForm = {
    model: '', provider: 'ollama', min_ram_gb: '', min_vram_gb: '',
    tool_tier: 'B', speed: 'medium', roles: '', notes: '',
  };
  const [form, setForm] = useState(emptyForm);

  const load = () => getCuratedModels().then(setRows).catch(e => setStatus(String(e)));
  useEffect(() => { load(); }, []);

  async function toggle(m: CuratedModel) {
    try { await patchCuratedModel(m.id, { enabled: !m.enabled }); load(); }
    catch (e) { setStatus(String(e)); }
  }

  async function remove(m: CuratedModel) {
    if (!window.confirm(`Remove "${m.model}" from the curated table?`)) return;
    try { await deleteCuratedModel(m.id); load(); } catch (e) { setStatus(String(e)); }
  }

  const parseRoles = (s: string) => s.split(',').map(r => r.trim()).filter(Boolean);
  const numOrNull = (s: string) => (s.trim() === '' ? null : Number(s));

  function startEdit(m: CuratedModel) {
    setEditing(m);
    setForm({
      model: m.model, provider: m.provider,
      min_ram_gb: m.min_ram_gb == null ? '' : String(m.min_ram_gb),
      min_vram_gb: m.min_vram_gb == null ? '' : String(m.min_vram_gb),
      tool_tier: m.tool_tier, speed: m.speed,
      roles: m.roles.join(', '), notes: m.notes,
    });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const fields = {
      min_ram_gb: numOrNull(form.min_ram_gb),
      min_vram_gb: numOrNull(form.min_vram_gb),
      tool_tier: form.tool_tier, speed: form.speed,
      roles: parseRoles(form.roles), notes: form.notes,
    };
    try {
      if (editing) {
        await patchCuratedModel(editing.id, fields);
        setEditing(null);
      } else {
        await createCuratedModel({ model: form.model, provider: form.provider as CuratedModel['provider'], ...fields } as Partial<CuratedModel>);
        setCreating(false);
      }
      setForm(emptyForm);
      setStatus('');
      load();
    } catch (err) { setStatus(String(err)); }
  }

  const formFields = (
    <>
      <div className="flex gap-2">
        <input placeholder="min RAM GB (CPU)" value={form.min_ram_gb}
          onChange={e => setForm({ ...form, min_ram_gb: e.target.value })}
          className="w-32 bg-stone-800 border border-stone-700 rounded px-2 py-1 text-xs text-stone-200" />
        <input placeholder="min VRAM GB (GPU)" value={form.min_vram_gb}
          onChange={e => setForm({ ...form, min_vram_gb: e.target.value })}
          className="w-32 bg-stone-800 border border-stone-700 rounded px-2 py-1 text-xs text-stone-200" />
        <select value={form.tool_tier} onChange={e => setForm({ ...form, tool_tier: e.target.value })}
          className="bg-stone-800 border border-stone-700 rounded px-2 py-1 text-xs text-stone-200" title="tool tier">
          {['A', 'B', 'C'].map(t => <option key={t} value={t}>tier {t}</option>)}
        </select>
        <select value={form.speed} onChange={e => setForm({ ...form, speed: e.target.value })}
          className="bg-stone-800 border border-stone-700 rounded px-2 py-1 text-xs text-stone-200" title="speed class">
          {['fast', 'medium', 'slow'].map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      <input placeholder="roles (comma-sep: chat, tools, guard, compaction)" value={form.roles}
        onChange={e => setForm({ ...form, roles: e.target.value })}
        className="w-full bg-stone-800 border border-stone-700 rounded px-2 py-1 text-xs font-mono text-stone-200" />
      <input placeholder="notes" value={form.notes}
        onChange={e => setForm({ ...form, notes: e.target.value })}
        className="w-full bg-stone-800 border border-stone-700 rounded px-2 py-1 text-xs text-stone-200" />
    </>
  );

  return (
    <details className="rounded-lg border border-stone-700 bg-stone-800/30">
      <summary className="px-3 py-2 text-sm text-stone-300 cursor-pointer select-none">
        Curated model table ({rows.length}) — the knowledge behind suggestions
      </summary>
      <div className="px-3 pb-3 space-y-2">
        <p className="text-xs text-stone-500">
          Rough requirements per model; the probe is the truth. Seeded rows can
          be toggled off but not rewritten; add your own rows for anything missing.
        </p>
        {rows.map(m => (
          <div key={m.id} className="rounded border border-stone-700/60 bg-stone-900/40 px-2.5 py-2">
            {editing?.id === m.id ? (
              <form onSubmit={submit} className="space-y-2">
                <div className="text-xs font-mono text-stone-100">{m.model}</div>
                {formFields}
                <div className="flex gap-2 justify-end">
                  <button type="button" onClick={() => { setEditing(null); setForm(emptyForm); }} className="text-xs text-stone-400 px-2">cancel</button>
                  <button type="submit" className="text-xs bg-teal-700 hover:bg-teal-600 text-white rounded px-3 py-1">save</button>
                </div>
              </form>
            ) : (
              <>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-xs font-mono text-stone-100 truncate">{m.model}</span>
                    <span className="text-[10px] px-1 rounded bg-stone-700 text-stone-400">tier {m.tool_tier}</span>
                    {m.is_system && <span className="text-[10px] px-1 rounded bg-stone-700 text-stone-400">seed</span>}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {editMode && !m.is_system && (
                      <>
                        <button onClick={() => startEdit(m)}
                          className="text-xs px-2 py-0.5 rounded border border-stone-600 text-stone-400 hover:text-stone-200">
                          edit
                        </button>
                        <button onClick={() => remove(m)}
                          className="text-xs px-2 py-0.5 rounded border border-stone-600 text-stone-500 hover:text-red-400 hover:border-red-800">
                          delete
                        </button>
                      </>
                    )}
                    <button onClick={() => toggle(m)}
                      className={`text-xs px-2 py-0.5 rounded border ${
                        m.enabled ? 'border-teal-700 text-teal-300 bg-teal-900/30' : 'border-stone-600 text-stone-500'
                      }`}>
                      {m.enabled ? 'enabled' : 'disabled'}
                    </button>
                  </div>
                </div>
                <div className="mt-0.5 text-[11px] text-stone-500">
                  {m.speed} · {m.roles.join('/') || 'no roles'}
                  {m.min_ram_gb != null && ` · ${m.min_ram_gb} GB RAM`}
                  {m.min_vram_gb != null && ` · ${m.min_vram_gb} GB VRAM`}
                </div>
                {m.notes && <div className="mt-0.5 text-[11px] text-stone-600 line-clamp-2">{m.notes}</div>}
                {m.last_probe && (
                  <div className="mt-0.5 text-[11px] font-mono">{probeLine(m.last_probe)}
                    {m.probed_at && <span className="text-stone-600"> · {new Date(m.probed_at).toLocaleString()}</span>}
                  </div>
                )}
              </>
            )}
          </div>
        ))}

        {editMode && creating ? (
          <form onSubmit={submit} className="rounded border border-teal-800 bg-stone-900/40 px-2.5 py-2 space-y-2">
            <div className="flex gap-2">
              <input required placeholder="model, e.g. ollama:gemma3:12b" value={form.model}
                onChange={e => setForm({ ...form, model: e.target.value })}
                className="flex-1 bg-stone-800 border border-stone-700 rounded px-2 py-1 text-xs font-mono text-stone-200" />
              <select value={form.provider} onChange={e => setForm({ ...form, provider: e.target.value })}
                className="bg-stone-800 border border-stone-700 rounded px-2 py-1 text-xs text-stone-200">
                <option value="ollama">ollama</option>
                <option value="openrouter">openrouter</option>
              </select>
            </div>
            {formFields}
            <div className="flex gap-2 justify-end">
              <button type="button" onClick={() => { setCreating(false); setForm(emptyForm); }} className="text-xs text-stone-400 px-2">cancel</button>
              <button type="submit" className="text-xs bg-teal-700 hover:bg-teal-600 text-white rounded px-3 py-1">add</button>
            </div>
          </form>
        ) : editMode ? (
          <button onClick={() => { setForm(emptyForm); setCreating(true); }}
            className="w-full text-xs text-stone-400 hover:text-teal-300 border border-dashed border-stone-700 hover:border-teal-800 rounded py-1.5">
            + add a model
          </button>
        ) : (
          <p className="text-[11px] text-stone-600">
            🔒 Enable/disable is always available; adding or editing rows needs
            Settings → Operator → Edit mode.
          </p>
        )}
        {status && <div className="text-xs text-red-400">{status}</div>}
      </div>
    </details>
  );
}

/** Per-agent model + status — every agent has its OWN model. */
function AgentsTab({ editMode }: { editMode: boolean }) {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [allModel, setAllModel] = useState('');
  const [status, setStatus] = useState('');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<AgentInfo | null>(null);
  const emptyForm = {
    name: '', description: '', system_prompt: '', model: '',
    allowed_tools: '', routing_keywords: '',
  };
  const [form, setForm] = useState(emptyForm);

  const load = () => getAgents().then(setAgents).catch(e => setStatus(String(e)));
  useEffect(() => {
    load();
    getModels().then(setModels).catch(() => {});
  }, []);

  async function setModel(a: AgentInfo, model: string) {
    try {
      await patchAgent(a.id, { model });
      setAgents(prev => prev.map(x => x.id === a.id ? { ...x, model } : x));
    } catch (e) { setStatus(String(e)); }
  }

  async function setAll() {
    if (!allModel) return;
    try {
      await Promise.all(agents.map(a => patchAgent(a.id, { model: allModel })));
      setStatus(`All agents set to ${allModel}`);
      setTimeout(() => setStatus(''), 2000);
      load();
    } catch (e) { setStatus(String(e)); }
  }

  async function toggle(a: AgentInfo) {
    if (a.name === 'main' && a.enabled) {
      setStatus('main cannot be disabled — it is the chat itself');
      return;
    }
    try {
      await patchAgent(a.id, { enabled: !a.enabled });
      load();
    } catch (e) { setStatus(String(e)); }
  }

  // comma-separated → list; empty = null (null allowed_tools = all builtins)
  const parseList = (s: string): string[] | null => {
    const items = s.split(',').map(t => t.trim()).filter(Boolean);
    return items.length ? items : null;
  };

  function startEdit(a: AgentInfo) {
    setEditing(a);
    setForm({
      name: a.name, description: a.description, system_prompt: a.system_prompt,
      model: a.model,
      allowed_tools: a.allowed_tools?.join(', ') ?? '',
      routing_keywords: a.routing_keywords?.join(', ') ?? '',
    });
  }

  async function saveEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editing) return;
    try {
      await patchAgent(editing.id, {
        description: form.description,
        system_prompt: form.system_prompt,
        allowed_tools: parseList(form.allowed_tools),
        routing_keywords: parseList(form.routing_keywords),
      });
      setEditing(null);
      setStatus('');
      load();
    } catch (err) { setStatus(String(err)); }
  }

  async function submitCreate(e: React.FormEvent) {
    e.preventDefault();
    try {
      await createAgent({
        name: form.name, description: form.description,
        system_prompt: form.system_prompt, model: form.model,
        allowed_tools: parseList(form.allowed_tools),
        routing_keywords: parseList(form.routing_keywords),
      });
      setCreating(false);
      setForm(emptyForm);
      setStatus('');
      load();
    } catch (err) { setStatus(String(err)); }
  }

  async function remove(a: AgentInfo) {
    if (!window.confirm(`Delete agent "${displayName(a.name)}"? This cannot be undone.`)) return;
    try { await deleteAgent(a.id); load(); } catch (err) { setStatus(String(err)); }
  }

  const agentFields = (
    <>
      <input
        placeholder="description"
        value={form.description}
        onChange={e => setForm({ ...form, description: e.target.value })}
        className="w-full bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200"
      />
      <textarea
        required placeholder="system prompt…"
        value={form.system_prompt}
        onChange={e => setForm({ ...form, system_prompt: e.target.value })}
        rows={6}
        className="w-full bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm font-mono text-stone-200"
      />
      <div className="flex gap-2">
        <input
          placeholder="allowed tools (comma-sep, empty = all builtins)"
          value={form.allowed_tools}
          onChange={e => setForm({ ...form, allowed_tools: e.target.value })}
          className="flex-1 bg-stone-800 border border-stone-700 rounded px-2 py-1 text-xs font-mono text-stone-200"
        />
        <input
          placeholder="routing keywords (comma-sep)"
          value={form.routing_keywords}
          onChange={e => setForm({ ...form, routing_keywords: e.target.value })}
          className="flex-1 bg-stone-800 border border-stone-700 rounded px-2 py-1 text-xs font-mono text-stone-200"
        />
      </div>
    </>
  );

  const modelSelect = (value: string, onChange: (v: string) => void, placeholder?: string) => (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className="max-w-[14rem] bg-stone-800 border border-stone-700 rounded px-1.5 py-1 text-xs text-stone-300"
    >
      {placeholder && <option value="">{placeholder}</option>}
      {models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
      {!!value && !models.some(m => m.id === value) && (
        <option value={value}>{value} (not detected)</option>
      )}
    </select>
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 rounded-lg border border-stone-700 bg-stone-800/50 p-3">
        <div className="text-sm text-stone-300">Set <b>all</b> agents to</div>
        <div className="flex items-center gap-2">
          {modelSelect(allModel, setAllModel, 'choose a model…')}
          <button
            onClick={setAll}
            disabled={!allModel}
            className="text-xs bg-teal-700 hover:bg-teal-600 disabled:bg-stone-700 text-white rounded px-3 py-1"
          >
            apply
          </button>
        </div>
      </div>

      {agents.map(a => (
        <div key={a.id} className="rounded-lg border border-stone-700 bg-stone-800/50 p-3">
          {editing?.id === a.id ? (
            <form onSubmit={saveEdit} className="space-y-2">
              <div className="text-sm text-stone-100">{displayName(a.name)}</div>
              {agentFields}
              <div className="flex gap-2 justify-end">
                <button type="button" onClick={() => setEditing(null)} className="text-xs text-stone-400 px-2">cancel</button>
                <button type="submit" className="text-xs bg-teal-700 hover:bg-teal-600 text-white rounded px-3 py-1">save</button>
              </div>
            </form>
          ) : (
            <>
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-sm text-stone-100">{displayName(a.name)}</span>
                  {a.is_system && <span className="text-[10px] px-1 rounded bg-stone-700 text-stone-400">system</span>}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {modelSelect(a.model, v => setModel(a, v))}
                  {editMode && (
                    <button
                      onClick={() => startEdit(a)}
                      className="text-xs px-2 py-0.5 rounded border border-stone-600 text-stone-400 hover:text-stone-200"
                    >
                      edit
                    </button>
                  )}
                  {editMode && !a.is_system && (
                    <button
                      onClick={() => remove(a)}
                      className="text-xs px-2 py-0.5 rounded border border-stone-600 text-stone-500 hover:text-red-400 hover:border-red-800"
                    >
                      delete
                    </button>
                  )}
                  <button
                    onClick={() => toggle(a)}
                    className={`text-xs px-2 py-0.5 rounded border ${
                      a.enabled ? 'border-teal-700 text-teal-300 bg-teal-900/30' : 'border-stone-600 text-stone-500'
                    }`}
                  >
                    {a.enabled ? 'enabled' : 'disabled'}
                  </button>
                </div>
              </div>
              <div className="mt-1 text-xs text-stone-500 line-clamp-2">{a.description}</div>
            </>
          )}
        </div>
      ))}

      {editMode && creating ? (
        <form onSubmit={submitCreate} className="rounded-lg border border-teal-800 bg-stone-800/50 p-3 space-y-2">
          <div className="flex gap-2">
            <input
              required placeholder="name (kebab-case)"
              value={form.name}
              onChange={e => setForm({ ...form, name: e.target.value })}
              className="flex-1 bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200"
            />
            {modelSelect(form.model, v => setForm({ ...form, model: v }), 'model…')}
          </div>
          {agentFields}
          <div className="flex gap-2 justify-end">
            <button type="button" onClick={() => { setCreating(false); setForm(emptyForm); }} className="text-xs text-stone-400 px-2">cancel</button>
            <button type="submit" className="text-xs bg-teal-700 hover:bg-teal-600 text-white rounded px-3 py-1">create</button>
          </div>
        </form>
      ) : editMode ? (
        <button
          onClick={() => { setForm(emptyForm); setCreating(true); }}
          className="w-full text-xs text-stone-400 hover:text-teal-300 border border-dashed border-stone-700 hover:border-teal-800 rounded-lg py-2"
        >
          + new agent
        </button>
      ) : <EditModeHint />}
      {status && <div className="text-xs text-amber-400">{status}</div>}
    </div>
  );
}

function AutomationsTab({ editMode }: { editMode: boolean }) {
  const [rows, setRows] = useState<Automation[]>([]);
  const [agents, setAgents] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [status, setStatus] = useState('');
  const [form, setForm] = useState({ name: '', instruction: '', agent_name: '', interval_minutes: 60 });

  const load = () => getAutomations().then(setRows).catch(e => setStatus(String(e)));
  useEffect(() => {
    load();
    getAgents().then(a => setAgents(a.filter(x => x.enabled).map(x => x.name))).catch(() => {});
    const iv = setInterval(load, 15000);
    return () => clearInterval(iv);
  }, []);

  const [editing, setEditing] = useState<Automation | null>(null);
  const [editForm, setEditForm] = useState({ description: '', instruction: '', agent_name: '', interval_minutes: 60 });

  async function toggle(a: Automation) {
    await patchAutomation(a.id, { enabled: !a.enabled });
    load();
  }

  function startEdit(a: Automation) {
    setEditing(a);
    setEditForm({
      description: a.description,
      instruction: a.instruction,
      agent_name: a.agent_name,
      interval_minutes: a.interval_minutes,
    });
  }

  async function saveEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editing) return;
    try {
      await patchAutomation(editing.id, editForm);
      setEditing(null);
      load();
    } catch (err) {
      setStatus(String(err));
    }
  }

  async function remove(a: Automation) {
    if (!window.confirm(`Delete automation "${a.name}"? This cannot be undone.`)) return;
    try {
      await deleteAutomation(a.id);
      load();
    } catch (err) {
      setStatus(String(err));
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      await createAutomation(form);
      setCreating(false);
      setForm({ name: '', instruction: '', agent_name: '', interval_minutes: 60 });
      load();
    } catch (err) {
      setStatus(String(err));
    }
  }

  return (
    <div className="space-y-3">
      {/* subsystem settings live with the subsystem, not in the Settings tab */}
      <div className="rounded-lg border border-stone-700 bg-stone-800/30 p-3">
        <SettingsTab only={['Automations']} />
      </div>

      {rows.map(a => (
        <div key={a.id} className="rounded-lg border border-stone-700 bg-stone-800/50 p-3">
          {editing?.id === a.id ? (
            <form onSubmit={saveEdit} className="space-y-2">
              <div className="text-sm text-stone-100">{displayName(a.name)}</div>
              <textarea
                required
                value={editForm.instruction}
                onChange={e => setEditForm({ ...editForm, instruction: e.target.value })}
                rows={4}
                className="w-full bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200"
              />
              <div className="flex gap-2">
                <select
                  value={editForm.agent_name}
                  onChange={e => setEditForm({ ...editForm, agent_name: e.target.value })}
                  className="flex-1 bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200"
                >
                  {agents.map(n => <option key={n} value={n}>{displayName(n)}</option>)}
                </select>
                <input
                  type="number" min={5}
                  value={editForm.interval_minutes}
                  onChange={e => setEditForm({ ...editForm, interval_minutes: parseInt(e.target.value || '60') })}
                  className="w-24 bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200"
                  title="Interval (minutes)"
                />
              </div>
              <div className="flex gap-2 justify-end">
                <button type="button" onClick={() => setEditing(null)} className="text-xs text-stone-400 px-2">cancel</button>
                <button type="submit" className="text-xs bg-teal-700 hover:bg-teal-600 text-white rounded px-3 py-1">save</button>
              </div>
            </form>
          ) : (
            <>
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-sm text-stone-100 truncate">{displayName(a.name)}</span>
                  {a.is_system && <span className="text-[10px] px-1 rounded bg-stone-700 text-stone-400">system</span>}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {editMode && (
                    <button
                      onClick={() => startEdit(a)}
                      className="text-xs px-2 py-0.5 rounded border border-stone-600 text-stone-400 hover:text-stone-200"
                    >
                      edit
                    </button>
                  )}
                  {editMode && !a.is_system && (
                    <button
                      onClick={() => remove(a)}
                      className="text-xs px-2 py-0.5 rounded border border-stone-600 text-stone-500 hover:text-red-400 hover:border-red-800"
                    >
                      delete
                    </button>
                  )}
                  <button
                    onClick={() => toggle(a)}
                    className={`text-xs px-2 py-0.5 rounded border ${
                      a.enabled
                        ? 'border-teal-700 text-teal-300 bg-teal-900/30'
                        : 'border-stone-600 text-stone-500'
                    }`}
                  >
                    {a.enabled ? 'enabled' : 'disabled'}
                  </button>
                </div>
              </div>
              <div className="mt-1 text-xs text-stone-500">
                {displayName(a.agent_name)} · every {a.interval_minutes >= 60 ? `${Math.round(a.interval_minutes / 60)}h` : `${a.interval_minutes}m`}
                {a.last_status && (
                  <span className={a.last_status === 'ok' ? ' text-emerald-500' : ' text-red-400'}>
                    {' '}· last: {a.last_status}
                  </span>
                )}
                {a.consecutive_failures > 0 && (
                  <span className="text-amber-400"> · {a.consecutive_failures} fails</span>
                )}
              </div>
              {a.last_summary && (
                <div className="mt-1.5 text-xs text-stone-400 line-clamp-2">{a.last_summary}</div>
              )}
            </>
          )}
        </div>
      ))}

      {editMode && creating ? (
        <form onSubmit={submit} className="rounded-lg border border-teal-800 bg-stone-800/50 p-3 space-y-2">
          <input
            required placeholder="name (kebab-case)"
            value={form.name}
            onChange={e => setForm({ ...form, name: e.target.value })}
            className="w-full bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200"
          />
          <textarea
            required placeholder="Instruction the agent runs each time…"
            value={form.instruction}
            onChange={e => setForm({ ...form, instruction: e.target.value })}
            rows={3}
            className="w-full bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200"
          />
          <div className="flex gap-2">
            <select
              required
              value={form.agent_name}
              onChange={e => setForm({ ...form, agent_name: e.target.value })}
              className="flex-1 bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200"
            >
              <option value="">agent…</option>
              {agents.map(a => <option key={a} value={a}>{displayName(a)}</option>)}
            </select>
            <input
              type="number" min={5}
              value={form.interval_minutes}
              onChange={e => setForm({ ...form, interval_minutes: parseInt(e.target.value || '60') })}
              className="w-24 bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200"
              title="Interval (minutes)"
            />
          </div>
          <div className="flex gap-2 justify-end">
            <button type="button" onClick={() => setCreating(false)} className="text-xs text-stone-400 px-2">cancel</button>
            <button type="submit" className="text-xs bg-teal-700 hover:bg-teal-600 text-white rounded px-3 py-1">create</button>
          </div>
        </form>
      ) : editMode ? (
        <button
          onClick={() => setCreating(true)}
          className="w-full text-xs text-stone-400 hover:text-teal-300 border border-dashed border-stone-700 hover:border-teal-800 rounded-lg py-2"
        >
          + new automation
        </button>
      ) : <EditModeHint />}
      {status && <div className="text-xs text-red-400">{status}</div>}
    </div>
  );
}

function RulesTab({ editMode }: { editMode: boolean }) {
  const [rows, setRows] = useState<Rule[]>([]);
  const [creating, setCreating] = useState(false);
  const [status, setStatus] = useState('');
  const [form, setForm] = useState({ name: '', pattern: '', action: 'block', description: '', target_tools: '' });

  const load = () => getRules().then(setRows).catch(e => setStatus(String(e)));
  useEffect(() => { load(); }, []);

  async function toggle(r: Rule) {
    try {
      await patchRule(r.id, { enabled: !r.enabled });
      load();
    } catch (e) { setStatus(String(e)); }
  }

  async function remove(r: Rule) {
    if (!window.confirm(`Delete rule "${r.name}"?`)) return;
    try { await deleteRule(r.id); load(); } catch (e) { setStatus(String(e)); }
  }

  const [editing, setEditing] = useState<Rule | null>(null);
  const [editForm, setEditForm] = useState({ description: '', pattern: '', action: 'block', target_tools: '' });

  function startEdit(r: Rule) {
    setEditing(r);
    setEditForm({
      description: r.description,
      pattern: r.pattern,
      action: r.action,
      target_tools: r.target_tools?.join(', ') ?? '',
    });
  }

  async function saveEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editing) return;
    try {
      const tools = editForm.target_tools.split(',').map(s => s.trim()).filter(Boolean);
      await patchRule(editing.id, {
        description: editForm.description,
        pattern: editForm.pattern,
        action: editForm.action,
        target_tools: tools.length ? tools : null,
      });
      setEditing(null);
      setStatus('');
      load();
    } catch (err) { setStatus(String(err)); }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      const tools = form.target_tools.split(',').map(s => s.trim()).filter(Boolean);
      await createRule({
        name: form.name, pattern: form.pattern, action: form.action,
        description: form.description,
        target_tools: tools.length ? tools : null,
      });
      setCreating(false);
      setForm({ name: '', pattern: '', action: 'block', description: '', target_tools: '' });
      setStatus('');
      load();
    } catch (err) { setStatus(String(err)); }
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-stone-500">
        Rules check every tool call before it executes — block stops the call, warn logs it.
        System protections can be toggled but never deleted.
      </p>
      {rows.map(r => (
        <div key={r.id} className="rounded-lg border border-stone-700 bg-stone-800/50 p-3">
          {editing?.id === r.id ? (
            <form onSubmit={saveEdit} className="space-y-2">
              <div className="text-sm text-stone-100">{displayName(r.name)}</div>
              <input required placeholder="regex pattern" value={editForm.pattern}
                onChange={e => setEditForm({ ...editForm, pattern: e.target.value })}
                className="w-full bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm font-mono text-stone-200" />
              <input placeholder="description" value={editForm.description}
                onChange={e => setEditForm({ ...editForm, description: e.target.value })}
                className="w-full bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200" />
              <div className="flex gap-2">
                <select value={editForm.action}
                  onChange={e => setEditForm({ ...editForm, action: e.target.value })}
                  className="bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200">
                  <option value="block">block</option>
                  <option value="warn">warn</option>
                </select>
                <input placeholder="target tools (comma-sep, empty = all)" value={editForm.target_tools}
                  onChange={e => setEditForm({ ...editForm, target_tools: e.target.value })}
                  className="flex-1 bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200" />
              </div>
              <div className="flex gap-2 justify-end">
                <button type="button" onClick={() => setEditing(null)} className="text-xs text-stone-400 px-2">cancel</button>
                <button type="submit" className="text-xs bg-teal-700 hover:bg-teal-600 text-white rounded px-3 py-1">save</button>
              </div>
            </form>
          ) : (
            <>
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-sm text-stone-100 truncate">{displayName(r.name)}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded border ${
                    r.action === 'block'
                      ? 'bg-red-950/50 text-red-300 border-red-900'
                      : 'bg-amber-950/50 text-amber-300 border-amber-900'
                  }`}>{r.action}</span>
                  {r.is_system && <span className="text-[10px] px-1 rounded bg-stone-700 text-stone-400">system</span>}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {editMode && (
                    <button onClick={() => startEdit(r)}
                      className="text-xs px-2 py-0.5 rounded border border-stone-600 text-stone-400 hover:text-stone-200">
                      edit
                    </button>
                  )}
                  {editMode && !r.is_system && (
                    <button onClick={() => remove(r)}
                      className="text-xs px-2 py-0.5 rounded border border-stone-600 text-stone-500 hover:text-red-400 hover:border-red-800">
                      delete
                    </button>
                  )}
                  <button onClick={() => toggle(r)}
                    className={`text-xs px-2 py-0.5 rounded border ${
                      r.enabled ? 'border-teal-700 text-teal-300 bg-teal-900/30' : 'border-stone-600 text-stone-500'
                    }`}>
                    {r.enabled ? 'enabled' : 'disabled'}
                  </button>
                </div>
              </div>
              {r.description && <div className="mt-1 text-xs text-stone-400">{r.description}</div>}
              <div className="mt-1 text-xs text-stone-500 font-mono truncate">
                /{r.pattern}/ · {r.target_tools?.join(', ') ?? 'all tools'}
                {r.hit_count > 0 && <span className="text-amber-400"> · {r.hit_count} hits</span>}
              </div>
            </>
          )}
        </div>
      ))}

      {editMode && creating ? (
        <form onSubmit={submit} className="rounded-lg border border-teal-800 bg-stone-800/50 p-3 space-y-2">
          <input required placeholder="name (kebab-case)" value={form.name}
            onChange={e => setForm({ ...form, name: e.target.value })}
            className="w-full bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200" />
          <input required placeholder="regex pattern (matched against tool name + args)" value={form.pattern}
            onChange={e => setForm({ ...form, pattern: e.target.value })}
            className="w-full bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm font-mono text-stone-200" />
          <input placeholder="description — what does this protect against?" value={form.description}
            onChange={e => setForm({ ...form, description: e.target.value })}
            className="w-full bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200" />
          <div className="flex gap-2">
            <select value={form.action} onChange={e => setForm({ ...form, action: e.target.value })}
              className="bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200">
              <option value="block">block</option>
              <option value="warn">warn</option>
            </select>
            <input placeholder="target tools (comma-sep, empty = all)" value={form.target_tools}
              onChange={e => setForm({ ...form, target_tools: e.target.value })}
              className="flex-1 bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200" />
          </div>
          <div className="flex gap-2 justify-end">
            <button type="button" onClick={() => setCreating(false)} className="text-xs text-stone-400 px-2">cancel</button>
            <button type="submit" className="text-xs bg-teal-700 hover:bg-teal-600 text-white rounded px-3 py-1">create</button>
          </div>
        </form>
      ) : editMode ? (
        <button onClick={() => setCreating(true)}
          className="w-full text-xs text-stone-400 hover:text-teal-300 border border-dashed border-stone-700 hover:border-teal-800 rounded-lg py-2">
          + new rule
        </button>
      ) : <EditModeHint />}
      {status && <div className="text-xs text-red-400">{status}</div>}
    </div>
  );
}

/** DB-created HTTP tools (toggleable, creatable in edit mode) + read-only builtins. */
function ToolsTab({ editMode }: { editMode: boolean }) {
  const [catalog, setCatalog] = useState<ToolsCatalog | null>(null);
  const [creating, setCreating] = useState(false);
  const [status, setStatus] = useState('');
  const [form, setForm] = useState({ name: '', description: '', method: 'GET', url_template: '' });

  const load = () => getTools().then(setCatalog).catch(e => setStatus(String(e)));
  useEffect(() => { load(); }, []);

  async function toggle(t: DbToolInfo) {
    try { await patchTool(t.id, !t.enabled); load(); } catch (e) { setStatus(String(e)); }
  }

  async function remove(t: DbToolInfo) {
    if (!window.confirm(`Delete tool "${displayName(t.name)}"? This cannot be undone.`)) return;
    try { await deleteTool(t.id); load(); } catch (e) { setStatus(String(e)); }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      await createTool(form);
      setCreating(false);
      setForm({ name: '', description: '', method: 'GET', url_template: '' });
      setStatus('');
      load();
    } catch (err) { setStatus(String(err)); }
  }

  if (!catalog) return <div className="text-xs text-stone-500">loading…</div>;

  return (
    <div className="space-y-3">
      <p className="text-xs text-stone-500">
        Created tools are declarative HTTP calls against operator-allowlisted hosts
        ({catalog.allowed_hosts.join(', ') || 'none yet'}). Builtins are code and
        always present; which agent may use what lives on each agent's grants.
      </p>

      {catalog.db_tools.map(t => (
        <div key={t.id} className="rounded-lg border border-stone-700 bg-stone-800/50 p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-sm text-stone-100 truncate">{displayName(t.name)}</span>
              <span className="text-[10px] px-1 rounded bg-stone-700 text-stone-400">{t.execution_type}</span>
              {t.is_system && <span className="text-[10px] px-1 rounded bg-stone-700 text-stone-400">system</span>}
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              {editMode && !t.is_system && (
                <button
                  onClick={() => remove(t)}
                  className="text-xs px-2 py-0.5 rounded border border-stone-600 text-stone-500 hover:text-red-400 hover:border-red-800"
                >
                  delete
                </button>
              )}
              <button
                onClick={() => toggle(t)}
                className={`text-xs px-2 py-0.5 rounded border ${
                  t.enabled ? 'border-teal-700 text-teal-300 bg-teal-900/30' : 'border-stone-600 text-stone-500'
                }`}
              >
                {t.enabled ? 'enabled' : 'disabled'}
              </button>
            </div>
          </div>
          {t.description && <div className="mt-1 text-xs text-stone-400 line-clamp-2">{t.description}</div>}
          {t.url_template && (
            <div className="mt-1 text-xs text-stone-500 font-mono truncate">
              {t.method} {t.url_template}
            </div>
          )}
        </div>
      ))}
      {catalog.db_tools.length === 0 && (
        <div className="text-xs text-stone-500 italic">No created tools yet.</div>
      )}

      {editMode && creating ? (
        <form onSubmit={submit} className="rounded-lg border border-teal-800 bg-stone-800/50 p-3 space-y-2">
          <input
            required placeholder="name (kebab-case)"
            value={form.name}
            onChange={e => setForm({ ...form, name: e.target.value })}
            className="w-full bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200"
          />
          <input
            required placeholder="description — when should an agent reach for this?"
            value={form.description}
            onChange={e => setForm({ ...form, description: e.target.value })}
            className="w-full bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200"
          />
          <div className="flex gap-2">
            <select
              value={form.method}
              onChange={e => setForm({ ...form, method: e.target.value })}
              className="bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200"
            >
              <option value="GET">GET</option>
              <option value="POST">POST</option>
            </select>
            <input
              required placeholder="url template, e.g. https://api.example.com/{q}"
              value={form.url_template}
              onChange={e => setForm({ ...form, url_template: e.target.value })}
              className="flex-1 bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm font-mono text-stone-200"
            />
          </div>
          <div className="flex gap-2 justify-end">
            <button type="button" onClick={() => setCreating(false)} className="text-xs text-stone-400 px-2">cancel</button>
            <button type="submit" className="text-xs bg-teal-700 hover:bg-teal-600 text-white rounded px-3 py-1">create</button>
          </div>
        </form>
      ) : editMode ? (
        <button
          onClick={() => setCreating(true)}
          className="w-full text-xs text-stone-400 hover:text-teal-300 border border-dashed border-stone-700 hover:border-teal-800 rounded-lg py-2"
        >
          + new tool
        </button>
      ) : <EditModeHint />}

      <details className="rounded-lg border border-stone-700 bg-stone-800/30">
        <summary className="px-3 py-2 text-sm text-stone-300 cursor-pointer select-none">
          Builtins ({catalog.builtins.length}) — read-only
        </summary>
        <div className="px-3 pb-2 space-y-1.5">
          {catalog.builtins.map(b => (
            <div key={b.name} className="text-xs">
              <span className="text-stone-200">{displayName(b.name)}</span>
              <span className="text-stone-500"> — {b.description}</span>
            </div>
          ))}
        </div>
      </details>
      {status && <div className="text-xs text-red-400">{status}</div>}
    </div>
  );
}
