import { useEffect, useState } from 'react';
import {
  AgentInfo, Automation, BundledInferenceStatus, ModelInfo, Rule, SettingDef,
  createAutomation, createRule, deleteAutomation, deleteRule, getAgents,
  getAutomations, getBundledInference, getModels, getRules, getSettings,
  patchAgent, patchAutomation, patchRule, patchSettings, pullModel,
  setBundledInference,
} from '../api';
import { THEMES } from '../brain/theme';
import { ThemePreview } from './ThemePreview';

type Tab = 'settings' | 'agents' | 'automations' | 'rules';

export function SettingsOverlay({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('settings');

  return (
    <div className="absolute inset-0 z-30 flex items-start justify-center pt-16 bg-black/40" onClick={onClose}>
      <div
        className="w-[46rem] max-w-[calc(100vw-26rem)] max-h-[82vh] flex flex-col rounded-xl bg-stone-900/95 backdrop-blur border border-stone-700 shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <header className="px-4 py-3 border-b border-stone-700 flex items-center justify-between">
          <div className="flex gap-1 text-sm">
            {(['settings', 'agents', 'automations', 'rules'] as Tab[]).map(t => (
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
          <button onClick={onClose} className="text-stone-500 hover:text-stone-200 text-lg px-1" aria-label="Close">×</button>
        </header>
        <div className="flex-1 overflow-y-auto nice-scroll p-4">
          {tab === 'settings' ? <SettingsTab />
            : tab === 'agents' ? <AgentsTab />
            : tab === 'automations' ? <AutomationsTab />
            : <RulesTab />}
        </div>
      </div>
    </div>
  );
}

function SettingsTab() {
  const [defs, setDefs] = useState<SettingDef[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [status, setStatus] = useState<string>('');

  useEffect(() => {
    getSettings().then(setDefs).catch(e => setStatus(String(e)));
    getModels().then(setModels).catch(() => {});
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

  const sections = [...new Set(defs.map(d => d.section))];
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

/** Per-agent model + status — every agent has its OWN model. */
function AgentsTab() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [allModel, setAllModel] = useState('');
  const [status, setStatus] = useState('');

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
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-sm text-stone-100">{a.name}</span>
              {a.is_system && <span className="text-[10px] px-1 rounded bg-stone-700 text-stone-400">system</span>}
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              {modelSelect(a.model, v => setModel(a, v))}
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
        </div>
      ))}
      {status && <div className="text-xs text-amber-400">{status}</div>}
    </div>
  );
}

function AutomationsTab() {
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
      {rows.map(a => (
        <div key={a.id} className="rounded-lg border border-stone-700 bg-stone-800/50 p-3">
          {editing?.id === a.id ? (
            <form onSubmit={saveEdit} className="space-y-2">
              <div className="text-sm text-stone-100">{a.name}</div>
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
                  {agents.map(n => <option key={n} value={n}>{n}</option>)}
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
                  <span className="text-sm text-stone-100 truncate">{a.name}</span>
                  {a.is_system && <span className="text-[10px] px-1 rounded bg-stone-700 text-stone-400">system</span>}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    onClick={() => startEdit(a)}
                    className="text-xs px-2 py-0.5 rounded border border-stone-600 text-stone-400 hover:text-stone-200"
                  >
                    edit
                  </button>
                  {!a.is_system && (
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
                {a.agent_name} · every {a.interval_minutes >= 60 ? `${Math.round(a.interval_minutes / 60)}h` : `${a.interval_minutes}m`}
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

      {creating ? (
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
              {agents.map(a => <option key={a} value={a}>{a}</option>)}
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
      ) : (
        <button
          onClick={() => setCreating(true)}
          className="w-full text-xs text-stone-400 hover:text-teal-300 border border-dashed border-stone-700 hover:border-teal-800 rounded-lg py-2"
        >
          + new automation
        </button>
      )}
      {status && <div className="text-xs text-red-400">{status}</div>}
    </div>
  );
}

function RulesTab() {
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
              <div className="text-sm text-stone-100">{r.name}</div>
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
                  <span className="text-sm text-stone-100 truncate">{r.name}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded border ${
                    r.action === 'block'
                      ? 'bg-red-950/50 text-red-300 border-red-900'
                      : 'bg-amber-950/50 text-amber-300 border-amber-900'
                  }`}>{r.action}</span>
                  {r.is_system && <span className="text-[10px] px-1 rounded bg-stone-700 text-stone-400">system</span>}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button onClick={() => startEdit(r)}
                    className="text-xs px-2 py-0.5 rounded border border-stone-600 text-stone-400 hover:text-stone-200">
                    edit
                  </button>
                  {!r.is_system && (
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

      {creating ? (
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
      ) : (
        <button onClick={() => setCreating(true)}
          className="w-full text-xs text-stone-400 hover:text-teal-300 border border-dashed border-stone-700 hover:border-teal-800 rounded-lg py-2">
          + new rule
        </button>
      )}
      {status && <div className="text-xs text-red-400">{status}</div>}
    </div>
  );
}
