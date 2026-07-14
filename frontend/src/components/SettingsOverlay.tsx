import { useEffect, useState } from 'react';
import {
  Automation, SettingDef, createAutomation, getAgents, getAutomations,
  getSettings, patchAutomation, patchSettings,
} from '../api';

type Tab = 'settings' | 'automations';

export function SettingsOverlay({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('settings');

  return (
    <div className="absolute inset-0 z-30 flex items-start justify-center pt-16 bg-black/40" onClick={onClose}>
      <div
        className="w-[36rem] max-w-[calc(100vw-26rem)] max-h-[80vh] flex flex-col rounded-xl bg-stone-900/95 backdrop-blur border border-stone-700 shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <header className="px-4 py-3 border-b border-stone-700 flex items-center justify-between">
          <div className="flex gap-1 text-sm">
            {(['settings', 'automations'] as Tab[]).map(t => (
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
          {tab === 'settings' ? <SettingsTab /> : <AutomationsTab />}
        </div>
      </div>
    </div>
  );
}

function SettingsTab() {
  const [defs, setDefs] = useState<SettingDef[]>([]);
  const [status, setStatus] = useState<string>('');

  useEffect(() => { getSettings().then(setDefs).catch(e => setStatus(String(e))); }, []);

  async function save(key: string, value: unknown) {
    try {
      await patchSettings({ [key]: value });
      setDefs(prev => prev.map(d => d.key === key ? { ...d, value } : d));
      setStatus(`Saved ${key}`);
      setTimeout(() => setStatus(''), 1500);
    } catch (e) {
      setStatus(String(e));
    }
  }

  const sections = [...new Set(defs.map(d => d.section))];
  return (
    <div className="space-y-5">
      {sections.map(section => (
        <section key={section}>
          <h3 className="text-xs uppercase tracking-wide text-stone-500 mb-2">{section}</h3>
          <div className="space-y-3">
            {defs.filter(d => d.section === section).map(d => (
              <div key={d.key} className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-sm text-stone-200">{d.label}</div>
                  <div className="text-xs text-stone-500">{d.description}</div>
                </div>
                {d.type === 'boolean' ? (
                  <button
                    onClick={() => save(d.key, !d.value)}
                    className={`shrink-0 w-10 h-5.5 px-0.5 py-0.5 rounded-full transition ${
                      d.value ? 'bg-teal-600' : 'bg-stone-700'
                    }`}
                    aria-label={d.label}
                  >
                    <span className={`block w-4 h-4 rounded-full bg-white transition-transform ${
                      d.value ? 'translate-x-5' : ''
                    }`} />
                  </button>
                ) : (
                  <input
                    className="shrink-0 w-28 bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200 text-right focus:outline-none focus:ring-1 focus:ring-teal-500"
                    defaultValue={String(d.value)}
                    onBlur={e => {
                      const raw = e.target.value.trim();
                      const v = d.type === 'number' ? Number(raw) : raw;
                      if (v !== d.value) save(d.key, v);
                    }}
                  />
                )}
              </div>
            ))}
          </div>
        </section>
      ))}
      {status && <div className="text-xs text-teal-400">{status}</div>}
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

  async function toggle(a: Automation) {
    await patchAutomation(a.id, { enabled: !a.enabled });
    load();
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
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-sm text-stone-100 truncate">{a.name}</span>
              {a.is_system && <span className="text-[10px] px-1 rounded bg-stone-700 text-stone-400">system</span>}
            </div>
            <button
              onClick={() => toggle(a)}
              className={`shrink-0 text-xs px-2 py-0.5 rounded border ${
                a.enabled
                  ? 'border-teal-700 text-teal-300 bg-teal-900/30'
                  : 'border-stone-600 text-stone-500'
              }`}
            >
              {a.enabled ? 'enabled' : 'disabled'}
            </button>
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
