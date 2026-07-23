import { useState, useEffect } from 'react';
import {
  Rule, createRule, deleteRule, getRules, patchRule,
} from '../../api';
import { displayName } from '../../names';
import { Toggle, CardsSkeleton } from '../ui';

export function RulesTab() {
  const [rows, setRows] = useState<Rule[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [creating, setCreating] = useState(false);
  const [status, setStatus] = useState('');
  const [form, setForm] = useState({ name: '', pattern: '', action: 'block', description: '', target_tools: '' });

  const load = () => getRules().then(setRows).catch(e => setStatus(String(e)))
    .finally(() => setLoaded(true));
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

  if (!loaded) return <CardsSkeleton n={3} />;
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
                  {(
                    <button onClick={() => startEdit(r)}
                      className="text-xs px-2 py-0.5 rounded border border-stone-600 text-stone-400 hover:text-stone-200">
                      edit
                    </button>
                  )}
                  {!r.is_system && (
                    <button onClick={() => remove(r)}
                      className="text-xs px-2 py-0.5 rounded border border-stone-600 text-stone-500 hover:text-red-400 hover:border-red-800">
                      delete
                    </button>
                  )}
                  <Toggle on={r.enabled} onChange={() => toggle(r)} label="enforcing"
                    title="Switched-off rules don't check tool calls — the off switch for system protections, which can't be deleted." />
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
