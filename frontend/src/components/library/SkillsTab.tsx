import { useState, useEffect } from 'react';
import {
  SkillInfo, createSkill, deleteSkill, getMemoryItem, getSkills, updateSkill,
} from '../../api';
import { Markdown } from '../Markdown';
import { CardsSkeleton } from '../ui';

/** Skills — markdown behaviors Nova retrieves by relevance and follows.
 *  Written from chat by skill-manager; viewable and editable here too
 *  (the memory index rescans on every write). */
export function SkillsTab() {
  const [rows, setRows] = useState<SkillInfo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState('');
  const [expanded, setExpanded] = useState<Record<string, string | null>>({});
  const [editing, setEditing] = useState<SkillInfo | null>(null);
  const [creating, setCreating] = useState(false);
  const emptyForm = { title: '', description: '', content: '' };
  const [form, setForm] = useState(emptyForm);

  const load = () => getSkills().then(setRows).catch(e => setStatus(String(e)))
    .finally(() => setLoaded(true));
  useEffect(() => { load(); }, []);

  async function toggleExpand(id: string) {
    if (expanded[id] !== undefined) {
      setExpanded(prev => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      return;
    }
    setExpanded(prev => ({ ...prev, [id]: null }));
    try {
      const item = await getMemoryItem(id);
      setExpanded(prev => ({ ...prev, [id]: item.content }));
    } catch (e) { setStatus(String(e)); }
  }

  async function startEdit(s: SkillInfo) {
    try {
      const item = await getMemoryItem(s.id);
      setEditing(s);
      setForm({ title: s.title, description: s.description, content: item.content });
    } catch (e) { setStatus(String(e)); }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      if (editing) {
        await updateSkill(editing.id, form);
        setEditing(null);
      } else {
        await createSkill(form);
        setCreating(false);
      }
      setForm(emptyForm);
      setExpanded({});
      setStatus('');
      load();
    } catch (err) { setStatus(String(err)); }
  }

  async function remove(s: SkillInfo) {
    if (!window.confirm(`Delete skill "${s.title}"? This cannot be undone.`)) return;
    try { await deleteSkill(s.id); load(); } catch (e) { setStatus(String(e)); }
  }

  const formFields = (
    <>
      <input required placeholder="title" value={form.title}
        onChange={e => setForm({ ...form, title: e.target.value })}
        className="w-full bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200" />
      <input placeholder="description — when should Nova reach for this skill?" value={form.description}
        onChange={e => setForm({ ...form, description: e.target.value })}
        className="w-full bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200" />
      <textarea required placeholder="the skill itself, markdown…" value={form.content}
        onChange={e => setForm({ ...form, content: e.target.value })}
        rows={8}
        className="w-full bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm font-mono text-stone-200" />
    </>
  );

  if (!loaded) return <CardsSkeleton n={3} />;
  return (
    <div className="space-y-3">
      <p className="text-xs text-stone-500">
        Skills are markdown behaviors, retrieved by relevance and injected into
        agent prompts. Nova writes them from chat (skill-manager); files live
        in <code className="font-mono">data/memory/skills/</code> and are safe
        to edit by hand too.
      </p>

      {rows.map(s => (
        <div key={s.id} className="rounded-lg border border-stone-700 bg-stone-800/50 p-3">
          {editing?.id === s.id ? (
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
                  <span className="text-sm text-stone-100 truncate">{s.title}</span>
                  {s.category && <span className="text-[10px] px-1 rounded bg-stone-700 text-stone-400">{s.category}</span>}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {(
                    <>
                      <button onClick={() => startEdit(s)}
                        className="text-xs px-2 py-0.5 rounded border border-stone-600 text-stone-400 hover:text-stone-200">
                        edit
                      </button>
                      <button onClick={() => remove(s)}
                        className="text-xs px-2 py-0.5 rounded border border-stone-600 text-stone-500 hover:text-red-400 hover:border-red-800">
                        delete
                      </button>
                    </>
                  )}
                  <button onClick={() => toggleExpand(s.id)}
                    className="text-xs px-2 py-0.5 rounded border border-stone-600 text-stone-400 hover:text-stone-200">
                    {expanded[s.id] !== undefined ? 'hide' : 'view'}
                  </button>
                </div>
              </div>
              {s.description && <div className="mt-1 text-xs text-stone-400">{s.description}</div>}
              {s.updated && <div className="mt-0.5 text-[11px] text-stone-600">updated {s.updated} · {s.id}</div>}
              {expanded[s.id] !== undefined && (
                <div className="mt-2 border-t border-stone-700/60 pt-2 text-sm text-stone-300">
                  {expanded[s.id] === null
                    ? <span className="text-xs text-stone-500">loading…</span>
                    : <Markdown>{expanded[s.id]!}</Markdown>}
                </div>
              )}
            </>
          )}
        </div>
      ))}
      {rows.length === 0 && (
        <div className="text-xs text-stone-500 italic">
          No skills yet — ask Nova to learn one, or create it here.
        </div>
      )}

      {creating ? (
        <form onSubmit={submit} className="rounded-lg border border-teal-800 bg-stone-800/50 p-3 space-y-2">
          {formFields}
          <div className="flex gap-2 justify-end">
            <button type="button" onClick={() => { setCreating(false); setForm(emptyForm); }} className="text-xs text-stone-400 px-2">cancel</button>
            <button type="submit" className="text-xs bg-teal-700 hover:bg-teal-600 text-white rounded px-3 py-1">create</button>
          </div>
        </form>
      ) : (
        <button onClick={() => { setForm(emptyForm); setCreating(true); }}
          className="w-full text-xs text-stone-400 hover:text-teal-300 border border-dashed border-stone-700 hover:border-teal-800 rounded-lg py-2">
          + new skill
        </button>
      )}
      {status && <div className="text-xs text-red-400">{status}</div>}
    </div>
  );
}
