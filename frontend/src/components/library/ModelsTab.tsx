import { useState, useEffect } from 'react';
import {
  CuratedModel, ModelInfo, createCuratedModel, deleteCuratedModel, getCuratedModels, getModels, patchCuratedModel, pullModel, uninstallModel, Provider, ProviderPreset, createProvider, deleteProvider, getProviders, getProviderPresets, patchProvider, testProvider, USE_CASES,
} from '../../api';
import { fmtDateTime } from '../../time';
import { Toggle } from '../ui';
import { probeLine } from './models-shared';
import { SettingsTab } from '../settings/SettingsTab';

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

/** The curated model table behind recommendations — seeded knowledge,
 *  operator-editable (system rows toggle-only, like rules/tools). */
function CuratedTable() {
  const [rows, setRows] = useState<CuratedModel[]>([]);
  const [status, setStatus] = useState('');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<CuratedModel | null>(null);
  const [installed, setInstalled] = useState<Set<string>>(new Set());
  const [pulls, setPulls] = useState<Record<string, string>>({});
  const [useCaseFilter, setUseCaseFilter] = useState('');       // '' = any
  const [locFilter, setLocFilter] = useState<'all' | 'local' | 'cloud'>('all');
  const emptyForm = {
    model: '', provider: 'ollama', min_ram_gb: '', min_vram_gb: '',
    tool_tier: 'B', speed: 'medium', roles: '', use_cases: [] as string[], notes: '',
  };
  const [form, setForm] = useState(emptyForm);

  const load = () => getCuratedModels().then(setRows).catch(e => setStatus(String(e)));
  const loadInstalled = () => getModels()
    .then(ms => setInstalled(new Set(ms.filter(m => m.provider === 'ollama').map(m => m.id))))
    .catch(() => {});
  useEffect(() => { load(); loadInstalled(); }, []);

  async function uninstallRow(m: CuratedModel) {
    const name = m.model.startsWith('ollama:') ? m.model.slice(7) : m.model;
    if (!window.confirm(`Uninstall "${name}"? The download is gone from disk; you can pull it again later.`)) return;
    try {
      await uninstallModel(name);
      setPulls(p => {
        const next = { ...p };
        delete next[m.model];
        return next;
      });
      loadInstalled();
    } catch (e) { setStatus(String(e)); }
  }

  async function pullRow(m: CuratedModel) {
    const name = m.model.startsWith('ollama:') ? m.model.slice(7) : m.model;
    setPulls(p => ({ ...p, [m.model]: 'starting…' }));
    try {
      for await (const ev of pullModel(name)) {
        if (typeof ev.error === 'string') {
          setPulls(p => ({ ...p, [m.model]: `✗ ${ev.error}` }));
          return;
        }
        const st = String(ev.status ?? '');
        if (typeof ev.total === 'number' && typeof ev.completed === 'number' && ev.total > 0) {
          const pct = Math.round((ev.completed / ev.total) * 100);
          setPulls(p => ({ ...p, [m.model]: `${st} — ${pct}%` }));
        } else if (st) {
          setPulls(p => ({ ...p, [m.model]: st }));
        }
      }
      setPulls(p => ({ ...p, [m.model]: '✓ installed' }));
      loadInstalled();
    } catch (err) {
      setPulls(p => ({ ...p, [m.model]: `✗ ${err}` }));
    }
  }

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
      roles: m.roles.join(', '), use_cases: m.use_cases, notes: m.notes,
    });
  }

  const toggleUseCase = (u: string) => setForm(f => ({
    ...f,
    use_cases: f.use_cases.includes(u)
      ? f.use_cases.filter(x => x !== u)
      : [...f.use_cases, u],
  }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const fields = {
      min_ram_gb: numOrNull(form.min_ram_gb),
      min_vram_gb: numOrNull(form.min_vram_gb),
      tool_tier: form.tool_tier, speed: form.speed,
      roles: parseRoles(form.roles), use_cases: form.use_cases, notes: form.notes,
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
      <div>
        <div className="text-[11px] text-stone-500 mb-1">good for (use-cases)</div>
        <div className="flex flex-wrap gap-1">
          {USE_CASES.map(u => (
            <button key={u} type="button" onClick={() => toggleUseCase(u)}
              className={`text-[11px] px-1.5 py-0.5 rounded border ${form.use_cases.includes(u)
                ? 'bg-teal-800/60 border-teal-700 text-teal-100'
                : 'bg-stone-800 border-stone-700 text-stone-400 hover:text-stone-200'}`}>
              {u}
            </button>
          ))}
        </div>
      </div>
      <input placeholder="notes" value={form.notes}
        onChange={e => setForm({ ...form, notes: e.target.value })}
        className="w-full bg-stone-800 border border-stone-700 rounded px-2 py-1 text-xs text-stone-200" />
    </>
  );

  const isLocal = (m: CuratedModel) => m.provider === 'ollama';
  // Only offer use-case options that some row actually carries.
  const useCaseOptions = USE_CASES.filter(u => rows.some(m => m.use_cases.includes(u)));
  const visible = rows.filter(m =>
    (locFilter === 'all'
      || (locFilter === 'local' && isLocal(m))
      || (locFilter === 'cloud' && !isLocal(m)))
    && (!useCaseFilter || m.use_cases.includes(useCaseFilter)));

  return (
    <details className="rounded-lg border border-stone-700 bg-stone-800/30">
      <summary className="px-3 py-2 text-sm text-stone-300 cursor-pointer select-none">
        Curated model table ({rows.length}) — the knowledge behind suggestions
      </summary>
      <div className="px-3 pb-3 space-y-2">
        <p className="text-xs text-stone-500">
          Rough requirements per model; the probe is the truth. <b>Approved</b> =
          feeds suggestions and the model dropdowns; switching it off vetoes the
          model but never deletes the row — flip it back anytime. Seeded rows
          can be toggled but not rewritten; add your own for anything missing.
        </p>
        <div className="flex flex-wrap items-center gap-2 border-y border-stone-700/60 py-2">
          <span className="text-[11px] text-stone-500">filter</span>
          <div className="inline-flex rounded border border-stone-700 overflow-hidden">
            {(['all', 'local', 'cloud'] as const).map(loc => (
              <button key={loc} onClick={() => setLocFilter(loc)}
                className={`text-[11px] px-2 py-0.5 ${locFilter === loc
                  ? 'bg-teal-800/70 text-teal-100' : 'text-stone-400 hover:text-stone-200'}`}>
                {loc}
              </button>
            ))}
          </div>
          <select value={useCaseFilter} onChange={e => setUseCaseFilter(e.target.value)}
            className="bg-stone-800 border border-stone-700 rounded px-2 py-0.5 text-[11px] text-stone-300"
            title="best for use-case">
            <option value="">any use-case</option>
            {useCaseOptions.map(u => <option key={u} value={u}>{u}</option>)}
          </select>
          {(useCaseFilter || locFilter !== 'all') && (
            <button onClick={() => { setUseCaseFilter(''); setLocFilter('all'); }}
              className="text-[11px] text-stone-500 hover:text-stone-300 underline">
              clear
            </button>
          )}
          <span className="text-[11px] text-stone-600 ml-auto">
            {visible.length} of {rows.length}
          </span>
        </div>
        {visible.length === 0 && rows.length > 0 && (
          <div className="text-[11px] text-stone-500 py-2 text-center">
            no models match this filter.
          </div>
        )}
        {visible.map(m => (
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
                    {m.provider === 'ollama' && (
                      installed.has(m.model) ? (
                        <>
                          <span className="text-[10px] px-1.5 py-0.5 rounded border border-emerald-800 text-emerald-400">✓ installed</span>
                          <button onClick={() => uninstallRow(m)}
                            title="Free the disk space — refuses while an agent or setting still uses this model."
                            className="text-xs px-2 py-0.5 rounded border border-stone-600 text-stone-500 hover:text-red-400 hover:border-red-800">
                            uninstall
                          </button>
                        </>
                      ) : (
                        <button onClick={() => pullRow(m)}
                          disabled={pulls[m.model] !== undefined && !pulls[m.model].startsWith('✗')}
                          className="text-xs px-2 py-0.5 rounded bg-teal-700 hover:bg-teal-600 disabled:bg-stone-700 text-white">
                          pull
                        </button>
                      )
                    )}
                    {!m.is_system && (
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
                    <Toggle on={m.enabled} onChange={() => toggle(m)} label="approved"
                      title="Approved rows feed suggestions and the model dropdowns; switch off to veto a model without deleting it." />
                  </div>
                </div>
                <div className="mt-0.5 text-[11px] text-stone-500">
                  <span className={isLocal(m) ? 'text-sky-400/80' : 'text-violet-400/80'}>
                    {isLocal(m) ? 'local' : 'cloud'}
                  </span>
                  {' · '}{m.speed} · {m.roles.join('/') || 'no roles'}
                  {m.min_ram_gb != null && ` · ${m.min_ram_gb} GB RAM`}
                  {m.min_vram_gb != null && ` · ${m.min_vram_gb} GB VRAM`}
                </div>
                {m.use_cases.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {m.use_cases.map(u => (
                      <button key={u} onClick={() => setUseCaseFilter(u)}
                        title={`filter to "${u}"`}
                        className={`text-[10px] px-1.5 py-0.5 rounded border ${useCaseFilter === u
                          ? 'bg-teal-800/60 border-teal-700 text-teal-100'
                          : 'bg-stone-800/60 border-stone-700 text-stone-400 hover:text-stone-200'}`}>
                        {u}
                      </button>
                    ))}
                  </div>
                )}
                {m.notes && <div className="mt-0.5 text-[11px] text-stone-600 line-clamp-2">{m.notes}</div>}
                {pulls[m.model] && (
                  <div className="mt-0.5 text-[11px] font-mono text-stone-400">{pulls[m.model]}</div>
                )}
                {m.last_probe && (
                  <div className="mt-0.5 text-[11px] font-mono">{probeLine(m.last_probe)}
                    {m.probed_at && <span className="text-stone-600"> · {fmtDateTime(m.probed_at)}</span>}
                  </div>
                )}
              </>
            )}
          </div>
        ))}

        {creating ? (
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
        ) : (
          <button onClick={() => { setForm(emptyForm); setCreating(true); }}
            className="w-full text-xs text-stone-400 hover:text-teal-300 border border-dashed border-stone-700 hover:border-teal-800 rounded py-1.5">
            + add a model
          </button>
        )}
        {status && <div className="text-xs text-red-400">{status}</div>}
      </div>
    </details>
  );
}

/** Model inventory & governance: keep-warm, pulls, the curated (approved)
 *  table that feeds dropdowns and recommendations, and the full catalog of
 *  authenticated providers. Machine infra stays in Settings → Inference;
 *  per-agent assignment lives in Agents. */
export function ModelsTab() {
  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-stone-700 bg-stone-800/30 p-3">
        <SettingsTab only={['Models']} />
      </div>
      <PullModel onPulled={() => {}} />
      <ProvidersPanel />
      <CuratedTable />
      <FullCatalog />
    </div>
  );
}

/** LLM providers — bring your own key / endpoint. Any OpenAI-compatible
 *  provider (OpenAI, Anthropic, Gemini, Groq, HuggingFace, a local LM Studio /
 *  vLLM server, or a custom URL) can be added here; its models then show up in
 *  the Full catalog below, ready to approve. Keys are stored server-side and
 *  never sent back — the UI only ever sees "key set" + the last 4 chars. */
function ProvidersPanel() {
  const [providers, setProviders] = useState<Provider[] | null>(null);
  const [presets, setPresets] = useState<ProviderPreset[]>([]);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Provider | null>(null);
  const [status, setStatus] = useState('');
  const [tests, setTests] = useState<Record<string, string>>({});
  const emptyForm = {
    slug: '', label: '', base_url: '', api_key: '',
    needs_key: true, catalog_path: '/models',
  };
  const [form, setForm] = useState(emptyForm);

  const load = () => getProviders().then(setProviders).catch(e => setStatus(String(e)));
  useEffect(() => {
    load();
    getProviderPresets().then(setPresets).catch(() => {});
    const t = setInterval(load, 30000);  // keep the reachability dots fresh
    return () => clearInterval(t);
  }, []);

  function applyPreset(slug: string) {
    const p = presets.find(x => x.slug === slug);
    if (!p) return;
    const custom = p.slug === 'custom';
    setForm({
      slug: custom ? '' : p.slug,
      label: custom ? '' : p.label,
      base_url: p.base_url, api_key: '',
      needs_key: p.needs_key, catalog_path: '/models',
    });
  }

  function startAdd() { setEditing(null); setForm(emptyForm); setAdding(true); }
  function startEdit(p: Provider) {
    setAdding(false);
    setEditing(p);
    setForm({
      slug: p.slug, label: p.label, base_url: p.base_url, api_key: '',
      needs_key: p.needs_key, catalog_path: p.catalog_path,
    });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      if (editing) {
        const body: Record<string, unknown> = {
          label: form.label, base_url: form.base_url,
          needs_key: form.needs_key, catalog_path: form.catalog_path,
        };
        if (form.api_key) body.api_key = form.api_key;  // blank = keep current key
        await patchProvider(editing.id, body);
        setEditing(null);
      } else {
        await createProvider({
          slug: form.slug, label: form.label, base_url: form.base_url,
          api_key: form.api_key || undefined,
          needs_key: form.needs_key, catalog_path: form.catalog_path,
        });
        setAdding(false);
      }
      setForm(emptyForm);
      setStatus('');
      load();
    } catch (err) { setStatus(String(err)); }
  }

  async function toggle(p: Provider) {
    try { await patchProvider(p.id, { enabled: !p.enabled }); load(); }
    catch (e) { setStatus(String(e)); }
  }

  async function remove(p: Provider) {
    if (!window.confirm(`Remove provider "${p.label}"? Models assigned to it will fall back to local until reassigned.`)) return;
    try { await deleteProvider(p.id); load(); } catch (e) { setStatus(String(e)); }
  }

  async function test(p: Provider) {
    setTests(t => ({ ...t, [p.id]: 'testing…' }));
    try {
      const r = await testProvider(p.id);
      const msg = r.ok === true
        ? `✓ reachable${r.model_count != null ? ` — ${r.model_count} models` : ''}`
        : r.ok === null ? `— ${r.error}` : `✗ ${r.error}`;
      setTests(t => ({ ...t, [p.id]: msg }));
    } catch (e) { setTests(t => ({ ...t, [p.id]: `✗ ${e}` })); }
  }

  const formFields = (
    <>
      <div className="flex gap-2">
        <input required placeholder="slug (model-id prefix, e.g. openai)"
          value={form.slug} disabled={!!editing}
          onChange={e => setForm({ ...form, slug: e.target.value })}
          className="w-40 bg-stone-800 border border-stone-700 rounded px-2 py-1 text-xs font-mono text-stone-200 disabled:opacity-50" />
        <input required placeholder="label (e.g. OpenAI)" value={form.label}
          onChange={e => setForm({ ...form, label: e.target.value })}
          className="flex-1 bg-stone-800 border border-stone-700 rounded px-2 py-1 text-xs text-stone-200" />
      </div>
      <input required placeholder="base URL (…/v1)" value={form.base_url}
        onChange={e => setForm({ ...form, base_url: e.target.value })}
        className="w-full bg-stone-800 border border-stone-700 rounded px-2 py-1 text-xs font-mono text-stone-200" />
      <input type="password" autoComplete="off"
        placeholder={editing?.key_set ? `API key (set …${editing.key_hint}; blank keeps it)` : 'API key'}
        value={form.api_key}
        onChange={e => setForm({ ...form, api_key: e.target.value })}
        className="w-full bg-stone-800 border border-stone-700 rounded px-2 py-1 text-xs font-mono text-stone-200" />
      <div className="flex items-center gap-3">
        <input placeholder="catalog path (/models, blank = can't list)"
          value={form.catalog_path}
          onChange={e => setForm({ ...form, catalog_path: e.target.value })}
          className="flex-1 bg-stone-800 border border-stone-700 rounded px-2 py-1 text-xs font-mono text-stone-200" />
        <label className="flex items-center gap-1.5 text-[11px] text-stone-400 select-none whitespace-nowrap">
          <input type="checkbox" checked={form.needs_key}
            onChange={e => setForm({ ...form, needs_key: e.target.checked })}
            className="accent-teal-600" />
          requires a key
        </label>
      </div>
    </>
  );

  return (
    <details className="rounded-lg border border-stone-700 bg-stone-800/30">
      <summary className="px-3 py-2 text-sm text-stone-300 cursor-pointer select-none">
        Providers{providers ? ` (${providers.length})` : ''} — bring your own key / endpoint
      </summary>
      <div className="px-3 pb-3 space-y-2">
        <p className="text-xs text-stone-500">
          Add any OpenAI-compatible provider — OpenAI, Anthropic, Gemini, Groq,
          HuggingFace, a local LM Studio / vLLM server, or a custom URL — with
          its own key. Its models then appear in the Full catalog below to
          approve. Keys are stored server-side and never shown again.
        </p>
        {providers === null ? (
          <div className="text-xs text-stone-500">loading…</div>
        ) : providers.map(p => (
          <div key={p.id} className="rounded border border-stone-700/60 bg-stone-900/40 px-2.5 py-2">
            {editing?.id === p.id ? (
              <form onSubmit={submit} className="space-y-2">
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
                    <span className="text-xs text-stone-100 truncate">{p.label}</span>
                    <span className="text-[10px] font-mono px-1 rounded bg-stone-700 text-stone-400">{p.slug}</span>
                    {p.is_system && <span className="text-[10px] px-1 rounded bg-stone-700 text-stone-400">seed</span>}
                    {!p.configured ? (
                      <span className="text-[10px] px-1 rounded border border-amber-800 text-amber-400">no key</span>
                    ) : p.last_ok === false ? (
                      <span title={p.last_error ?? 'unreachable'}
                        className="flex items-center gap-1 text-[10px] text-red-400 shrink-0">
                        <span className="w-1.5 h-1.5 rounded-full bg-red-500" />unreachable
                      </span>
                    ) : p.last_ok === true ? (
                      <span title={p.last_checked_at ? `reachable · checked ${fmtDateTime(p.last_checked_at)}` : 'reachable'}
                        className="flex items-center gap-1 text-[10px] text-emerald-400 shrink-0">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />reachable
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 text-[10px] text-stone-500 shrink-0">
                        <span className="w-1.5 h-1.5 rounded-full bg-stone-500 animate-pulse" />checking…
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button onClick={() => test(p)}
                      className="text-xs px-2 py-0.5 rounded border border-stone-600 text-stone-400 hover:text-teal-300">test</button>
                    <button onClick={() => startEdit(p)}
                      className="text-xs px-2 py-0.5 rounded border border-stone-600 text-stone-400 hover:text-stone-200">edit</button>
                    {!p.is_system && (
                      <button onClick={() => remove(p)}
                        className="text-xs px-2 py-0.5 rounded border border-stone-600 text-stone-500 hover:text-red-400 hover:border-red-800">delete</button>
                    )}
                    <Toggle on={p.enabled} onChange={() => toggle(p)} label="enabled"
                      title="Disabled providers contribute no models and their assigned agents fall back to local." />
                  </div>
                </div>
                <div className="mt-0.5 text-[11px] font-mono text-stone-500 truncate">
                  {p.base_url}{p.key_set && ` · key …${p.key_hint}`}
                </div>
                {p.configured && p.last_ok === false && p.last_error && (
                  <div className="mt-0.5 text-[11px] text-red-400/90 truncate" title={p.last_error}>
                    ✗ {p.last_error}
                  </div>
                )}
                {tests[p.id] && <div className="mt-0.5 text-[11px] font-mono text-stone-400">{tests[p.id]}</div>}
              </>
            )}
          </div>
        ))}

        {adding ? (
          <form onSubmit={submit} className="rounded border border-teal-800 bg-stone-900/40 px-2.5 py-2 space-y-2">
            <select defaultValue="" onChange={e => applyPreset(e.target.value)}
              className="w-full bg-stone-800 border border-stone-700 rounded px-2 py-1 text-xs text-stone-200">
              <option value="" disabled>start from a preset…</option>
              {presets.map(p => <option key={p.slug} value={p.slug}>{p.label}</option>)}
            </select>
            {formFields}
            <div className="flex gap-2 justify-end">
              <button type="button" onClick={() => { setAdding(false); setForm(emptyForm); }} className="text-xs text-stone-400 px-2">cancel</button>
              <button type="submit" className="text-xs bg-teal-700 hover:bg-teal-600 text-white rounded px-3 py-1">add</button>
            </div>
          </form>
        ) : (
          <button onClick={startAdd}
            className="w-full text-xs text-stone-400 hover:text-teal-300 border border-dashed border-stone-700 hover:border-teal-800 rounded py-1.5">
            + add a provider
          </button>
        )}
        {status && <div className="text-xs text-red-400">{status}</div>}
      </div>
    </details>
  );
}

// Format a context window: 1000000 → "1M", 128000 → "128K".
function fmtCtx(n?: number): string | null {
  if (!n) return null;
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return `${n}`;
}

// Description keywords that stand in for a use-case when there's no curated row.
// Grounded in the PROVIDER'S OWN description text — a claim we surface, not one
// we invent. vision/long-context come from hard metadata instead.
const _USE_CASE_KEYWORDS: Record<string, string[]> = {
  coding: ['coding', 'code', 'programming', 'software', 'developer'],
  reasoning: ['reasoning', 'reason', 'math', 'logic', 'stem'],
  writing: ['writing', 'write', 'creative', 'prose', 'storytelling'],
  'agentic-tools': ['agent', 'tool', 'function call', 'function-call', 'tool use'],
  chat: ['chat', 'conversation', 'assistant', 'dialogue'],
  multilingual: ['multilingual', 'languages', 'translation'],
  summarization: ['summar'],
};

/** The use-case tags for a catalog model. If a curated row exists, those
 *  editorial tags are authoritative (`vetted`). Otherwise infer from provider
 *  facts (vision←modality, long-context←window) and description keywords —
 *  clearly styled as inferred, with the description shown so matches explain
 *  themselves. */
function catalogTags(m: ModelInfo, row?: CuratedModel): { tag: string; vetted: boolean }[] {
  if (row && row.use_cases.length) return row.use_cases.map(t => ({ tag: t, vetted: true }));
  const out: { tag: string; vetted: boolean }[] = [];
  if (m.vision) out.push({ tag: 'vision', vetted: false });
  if ((m.context_length ?? 0) >= 200_000) out.push({ tag: 'long-context', vetted: false });
  const d = (m.description ?? '').toLowerCase();
  if (d) {
    for (const [tag, words] of Object.entries(_USE_CASE_KEYWORDS)) {
      if (out.some(t => t.tag === tag)) continue;
      if (words.some(w => d.includes(w))) out.push({ tag, vetted: false });
    }
  }
  return out;
}

/** Everything the configured credentials can reach; installed local models
 *  can be uninstalled from here (covers pulls that aren't in the curated
 *  table). Any cloud model can be approved straight from here in one click —
 *  approval just creates (or re-enables) its curated row, which is what puts
 *  it in the agent + chat dropdowns. Cloud rows carry the provider's own
 *  "good for" facts (description, context, vision, price) so a bare id isn't
 *  the only thing to go on. */
function FullCatalog() {
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [curated, setCurated] = useState<CuratedModel[]>([]);
  const [filter, setFilter] = useState('');
  const [locFilter, setLocFilter] = useState<'all' | 'local' | 'cloud'>('all');
  const [useCaseFilter, setUseCaseFilter] = useState('');
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [status, setStatus] = useState('');

  const loadCurated = () => getCuratedModels().then(setCurated).catch(() => {});
  // curated row (if any) for a catalog model id — approval state lives here
  const rowFor = (id: string) => curated.find(c => c.model === id);

  async function uninstall(m: ModelInfo) {
    if (!window.confirm(`Uninstall "${m.name}"? You can pull it again later.`)) return;
    try {
      await uninstallModel(m.name);
      setStatus(`✓ ${m.name} uninstalled`);
      getModels(true).then(setModels).catch(() => {});
    } catch (e) { setStatus(String(e)); }
  }

  async function setApproved(m: ModelInfo, approved: boolean) {
    setBusy(b => ({ ...b, [m.id]: true }));
    try {
      const row = rowFor(m.id);
      if (approved) {
        // re-enable an existing row, or create a fresh (bare) one — metadata
        // like tier/roles can be filled in later from the curated table; it
        // isn't needed just to make the model assignable.
        if (row) await patchCuratedModel(row.id, { enabled: true });
        else await createCuratedModel({ model: m.id, provider: m.provider as CuratedModel['provider'] });
      } else if (row) {
        // seeded rows can't be deleted — veto by disabling; user rows are removed
        if (row.is_system) await patchCuratedModel(row.id, { enabled: false });
        else await deleteCuratedModel(row.id);
      }
      setStatus('');
      await loadCurated();
    } catch (e) { setStatus(String(e)); }
    finally { setBusy(b => ({ ...b, [m.id]: false })); }
  }

  const q = filter.trim().toLowerCase();
  const shown = (models ?? []).filter(m => {
    const local = m.provider === 'ollama';
    if (locFilter === 'local' && !local) return false;
    if (locFilter === 'cloud' && local) return false;
    if (useCaseFilter &&
        !catalogTags(m, rowFor(m.id)).some(t => t.tag === useCaseFilter)) return false;
    if (q && !m.id.toLowerCase().includes(q) &&
        !(m.description ?? '').toLowerCase().includes(q)) return false;
    return true;
  });
  const hasCloud = (models ?? []).some(m => m.provider !== 'ollama');

  return (
    <details
      className="rounded-lg border border-stone-700 bg-stone-800/30"
      onToggle={e => {
        if ((e.target as HTMLDetailsElement).open && models === null) {
          getModels(true).then(setModels).catch(() => setModels([]));
          loadCurated();
        }
      }}
    >
      <summary className="px-3 py-2 text-sm text-stone-300 cursor-pointer select-none">
        Full catalog — authenticated providers{models ? ` (${models.length})` : ''}
      </summary>
      <div className="px-3 pb-3">
        <p className="text-xs text-stone-500 mb-1.5">
          Everything your credentials can reach. Providers without credentials
          are absent by design. Flip <b>approved</b> on any cloud model to put
          it in the agent and chat dropdowns — no need to type it into the
          curated table by hand.
        </p>
        {models && models.length > 0 && (
          <div className="mb-2 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] text-stone-500">filter</span>
              <div className="inline-flex rounded border border-stone-700 overflow-hidden">
                {(['all', 'local', 'cloud'] as const).map(loc => (
                  <button key={loc} onClick={() => setLocFilter(loc)}
                    className={`text-[11px] px-2 py-0.5 ${locFilter === loc
                      ? 'bg-teal-800/70 text-teal-100' : 'text-stone-400 hover:text-stone-200'}`}>
                    {loc}
                  </button>
                ))}
              </div>
              <select value={useCaseFilter} onChange={e => setUseCaseFilter(e.target.value)}
                className="bg-stone-800 border border-stone-700 rounded px-2 py-0.5 text-[11px] text-stone-300"
                title="best for use-case">
                <option value="">any use-case</option>
                {USE_CASES.map(u => <option key={u} value={u}>{u}</option>)}
              </select>
              {(useCaseFilter || locFilter !== 'all' || filter) && (
                <button onClick={() => { setUseCaseFilter(''); setLocFilter('all'); setFilter(''); }}
                  className="text-[11px] text-stone-500 hover:text-stone-300 underline">clear</button>
              )}
              <span className="text-[11px] text-stone-600 ml-auto">{shown.length} of {models.length}</span>
            </div>
            <input placeholder="search id or description…" value={filter}
              onChange={e => setFilter(e.target.value)}
              className="w-full bg-stone-800 border border-stone-700 rounded px-2 py-1 text-xs font-mono text-stone-200" />
            {useCaseFilter && hasCloud && (
              <div className="text-[10px] text-stone-600">
                cloud tags marked <span className="font-mono">?</span> are inferred from each provider's
                description &amp; metadata (shown per row); curated models use their vetted tags.
              </div>
            )}
          </div>
        )}
        <div className="max-h-80 overflow-y-auto nice-scroll space-y-1">
          {models === null ? (
            <div className="text-xs text-stone-500">loading…</div>
          ) : models.length === 0 ? (
            <div className="text-xs text-stone-500 italic">
              nothing reachable — no local models installed and no cloud credentials
            </div>
          ) : shown.length === 0 ? (
            <div className="text-xs text-stone-500 italic">no models match the current filter</div>
          ) : (
            shown.map(m => {
              const row = rowFor(m.id);
              const approved = !!row?.enabled;
              const tags = catalogTags(m, row);
              const ctx = fmtCtx(m.context_length);
              return (
                <div key={m.id} className="rounded border border-stone-800 bg-stone-900/30 px-2 py-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-mono text-stone-300 truncate">{m.id}</span>
                    {m.provider === 'ollama' ? (
                      <button onClick={() => uninstall(m)}
                        className="text-[10px] px-1.5 rounded border border-stone-700 text-stone-500 hover:text-red-400 hover:border-red-800 shrink-0">
                        uninstall
                      </button>
                    ) : (
                      <span className={busy[m.id] ? 'opacity-50 pointer-events-none' : ''}>
                        <Toggle on={approved} onChange={() => setApproved(m, !approved)} label="approved"
                          title="Approved cloud models appear in the agent + chat model dropdowns. Off vetoes the model without losing any curated metadata." />
                      </span>
                    )}
                  </div>
                  {(ctx || m.vision || m.price_in != null) && (
                    <div className="mt-0.5 flex flex-wrap gap-x-2 text-[10px] text-stone-500">
                      {ctx && <span>{ctx} ctx</span>}
                      {m.vision && <span className="text-violet-400/80">vision</span>}
                      {m.price_in != null && (
                        <span>${m.price_in}/${m.price_out ?? '?'} per M</span>
                      )}
                    </div>
                  )}
                  {tags.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {tags.map(({ tag, vetted }) => (
                        <button key={tag} onClick={() => setUseCaseFilter(tag)}
                          title={vetted ? 'curated tag' : "inferred from the provider's description / metadata"}
                          className={`text-[10px] px-1.5 py-0.5 rounded border ${useCaseFilter === tag
                            ? 'bg-teal-800/60 border-teal-700 text-teal-100'
                            : vetted ? 'bg-stone-800/60 border-stone-700 text-stone-300 hover:text-stone-100'
                              : 'border-dashed border-stone-700 text-stone-500 hover:text-stone-300'}`}>
                          {tag}{vetted ? '' : ' ?'}
                        </button>
                      ))}
                    </div>
                  )}
                  {m.description && (
                    <div className="mt-0.5 text-[10px] text-stone-600 line-clamp-2" title={m.description}>
                      {m.description}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
        {status && <div className="mt-1 text-xs text-amber-400">{status}</div>}
      </div>
    </details>
  );
}
