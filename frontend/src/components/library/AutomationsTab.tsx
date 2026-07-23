import { useState, useEffect } from 'react';
import {
  Automation, AutomationRun, createAutomation, deleteAutomation, getAgents, getAutomationRuns, getAutomations, patchAutomation,
} from '../../api';
import { agentDisplayName, displayName } from '../../names';
import { fmtDateTime } from '../../time';
import { Toggle, CardsSkeleton } from '../ui';
import { SettingsTab } from '../settings/SettingsTab';

export function AutomationsTab() {
  const [rows, setRows] = useState<Automation[]>([]);
  const [agents, setAgents] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [status, setStatus] = useState('');
  const [expandedInstr, setExpandedInstr] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [form, setForm] = useState({ name: '', instruction: '', agent_name: '', interval_minutes: 60 });

  const load = () => getAutomations().then(setRows).catch(e => setStatus(String(e)))
    .finally(() => setLoaded(true));
  useEffect(() => {
    load();
    getAgents().then(a => setAgents(a.filter(x => x.enabled).map(x => x.name))).catch(() => {});
    const iv = setInterval(load, 15000);
    return () => clearInterval(iv);
  }, []);

  const [editing, setEditing] = useState<Automation | null>(null);
  const [editForm, setEditForm] = useState({ description: '', instruction: '', agent_name: '', interval_minutes: 60, timeout_seconds: '' });

  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [runs, setRuns] = useState<AutomationRun[]>([]);

  async function toggleHistory(a: Automation) {
    if (historyFor === a.id) { setHistoryFor(null); return; }
    try {
      setRuns(await getAutomationRuns(a.id));
      setHistoryFor(a.id);
    } catch (err) {
      setStatus(String(err));
    }
  }

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
      timeout_seconds: a.timeout_seconds == null ? '' : String(a.timeout_seconds),
    });
  }

  async function saveEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editing) return;
    try {
      await patchAutomation(editing.id, {
        ...editForm,
        timeout_seconds: editForm.timeout_seconds === '' ? null : Number(editForm.timeout_seconds),
      });
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

  if (!loaded) return <CardsSkeleton n={4} />;
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
              <label className="block">
                <span className="text-[10px] uppercase tracking-wide text-stone-500">Note — your description (not sent to the agent)</span>
                <textarea
                  value={editForm.description}
                  onChange={e => setEditForm({ ...editForm, description: e.target.value })}
                  rows={3}
                  placeholder="a short note: what this automation is for"
                  className="w-full mt-0.5 resize-y bg-stone-800 border border-stone-700 rounded px-2 py-1.5 text-sm text-stone-200 leading-relaxed"
                />
              </label>
              <label className="block">
                <span className="text-[10px] uppercase tracking-wide text-stone-500">Instructions — the prompt Nova runs each time</span>
                <textarea
                  required
                  value={editForm.instruction}
                  onChange={e => setEditForm({ ...editForm, instruction: e.target.value })}
                  rows={8}
                  className="w-full mt-0.5 resize-y bg-stone-800 border border-stone-700 rounded px-2 py-1.5 text-sm text-stone-200 leading-relaxed"
                />
              </label>
              <div className="flex gap-2">
                <select
                  value={editForm.agent_name}
                  onChange={e => setEditForm({ ...editForm, agent_name: e.target.value })}
                  className="flex-1 bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200"
                >
                  {agents.map(n => <option key={n} value={n}>{agentDisplayName(n)}</option>)}
                </select>
                <input
                  type="number" min={5}
                  value={editForm.interval_minutes}
                  onChange={e => setEditForm({ ...editForm, interval_minutes: parseInt(e.target.value || '60') })}
                  className="w-24 bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200"
                  title="Interval (minutes)"
                />
                <input
                  type="number" min={30}
                  placeholder="timeout"
                  value={editForm.timeout_seconds}
                  onChange={e => setEditForm({ ...editForm, timeout_seconds: e.target.value })}
                  className="w-24 bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200"
                  title="Per-run timeout override in seconds — empty uses the global automations setting"
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
                  {(
                    <button
                      onClick={() => startEdit(a)}
                      className="text-xs px-2 py-0.5 rounded border border-stone-600 text-stone-400 hover:text-stone-200"
                    >
                      edit
                    </button>
                  )}
                  {!a.is_system && (
                    <button
                      onClick={() => remove(a)}
                      className="text-xs px-2 py-0.5 rounded border border-stone-600 text-stone-500 hover:text-red-400 hover:border-red-800"
                    >
                      delete
                    </button>
                  )}
                  <Toggle on={a.enabled} onChange={() => toggle(a)} label="active"
                    title="The kill switch — paused automations don't run until switched back on." />
                </div>
              </div>
              <div className="mt-1 text-xs text-stone-500">
                {agentDisplayName(a.agent_name)} · every {a.interval_minutes >= 60 ? `${Math.round(a.interval_minutes / 60)}h` : `${a.interval_minutes}m`}
                {a.timeout_seconds != null && <span> · timeout {a.timeout_seconds}s</span>}
                {a.last_status && (
                  <span className={a.last_status === 'ok' ? ' text-emerald-500' : ' text-red-400'}>
                    {' '}· last: {a.last_status}
                  </span>
                )}
                {a.consecutive_failures > 0 && (
                  <span className="text-amber-400"> · {a.consecutive_failures} fails</span>
                )}
                {a.last_run_at && (
                  <>
                    {' · '}
                    <button
                      onClick={() => toggleHistory(a)}
                      className="text-stone-500 hover:text-teal-300 underline decoration-dotted"
                    >
                      {historyFor === a.id ? 'hide runs' : 'runs'}
                    </button>
                  </>
                )}
              </div>
              {a.description && (
                <div className="mt-1.5">
                  <span className="text-[10px] uppercase tracking-wide text-stone-500">Note (yours)</span>
                  <div className="mt-0.5 text-xs text-stone-300">{a.description}</div>
                </div>
              )}
              {a.instruction && (
                <div className="mt-1.5">
                  <span className="text-[10px] uppercase tracking-wide text-stone-500">Instructions Nova runs</span>
                  <div className={`mt-0.5 text-xs text-stone-400 whitespace-pre-wrap [overflow-wrap:anywhere] ${
                    expandedInstr === a.id ? '' : 'line-clamp-3'}`}>{a.instruction}</div>
                  {a.instruction.length > 180 && (
                    <button onClick={() => setExpandedInstr(expandedInstr === a.id ? null : a.id)}
                      className="text-[11px] text-stone-500 hover:text-teal-300 mt-0.5">
                      {expandedInstr === a.id ? 'show less' : 'show full'}
                    </button>
                  )}
                </div>
              )}
              {a.last_summary && (
                <div className="mt-1.5 text-xs text-stone-400 line-clamp-2">
                  <span className="text-[10px] uppercase tracking-wide text-stone-500">Last run</span>{' '}
                  {a.last_summary}
                </div>
              )}
              {historyFor === a.id && (
                <div className="mt-2 border-t border-stone-700/60 pt-2 space-y-1.5">
                  {runs.length === 0 && (
                    <div className="text-xs text-stone-500">
                      No recorded runs yet — history starts with the next run.
                    </div>
                  )}
                  {runs.map(r => (
                    <div key={r.id} className="text-xs">
                      <span className={r.status === 'ok' ? 'text-emerald-500' : 'text-red-400'}>
                        {r.status}
                      </span>
                      <span className="text-stone-500">
                        {' '}· {fmtDateTime(r.started_at)} · {r.duration_seconds}s
                      </span>
                      {r.summary && (
                        <div className="text-stone-400 line-clamp-2">{r.summary}</div>
                      )}
                    </div>
                  ))}
                </div>
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
            required placeholder="Instructions the agent runs each time… (a note is auto-written for you)"
            value={form.instruction}
            onChange={e => setForm({ ...form, instruction: e.target.value })}
            rows={6}
            className="w-full resize-y bg-stone-800 border border-stone-700 rounded px-2 py-1.5 text-sm text-stone-200 leading-relaxed"
          />
          <div className="flex gap-2">
            <select
              required
              value={form.agent_name}
              onChange={e => setForm({ ...form, agent_name: e.target.value })}
              className="flex-1 bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200"
            >
              <option value="">agent…</option>
              {agents.map(a => <option key={a} value={a}>{agentDisplayName(a)}</option>)}
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
