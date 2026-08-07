import { useEffect, useState } from 'react';
import { Goal, createGoal, deleteGoal, getGoals, patchGoal } from '../../api';
import { fmtDateTime } from '../../time';
import { CardsSkeleton } from '../ui';

/** Goals — what Nova is working towards, and what it lets her do.
 *
 *  ROADMAP #34 phase I2. Goals have existed since 2026-07-29 with NO UI AT
 *  ALL: Jeremy approved a card in chat and then had no way to see what was
 *  active, what it authorised, how much of its budget was left, or when it
 *  expired. That is exactly what bit him on 2026-08-06 — a goal sat at 3/3
 *  actions, every further attempt was refused, and the only visible symptom
 *  was Nova saying she was blocked.
 *
 *  TWO KINDS IN ONE LIST, and the difference is the first thing on the card.
 *  A goal with no verbs is a tracked intention — an approved idea, or one he
 *  typed — and authorises nothing. A goal WITH verbs is a standing
 *  pre-approval being drawn down, and the budget and expiry are the whole
 *  point of showing it.
 *
 *  NOTHING HERE GRANTS ANYTHING. There is no control for `approved_verbs`,
 *  `max_actions` or `expires_at`, and `active` is not a status he can pick:
 *  those are the authorisation, and widening a standing grant belongs on an
 *  approval card, not in a text field. The backend refuses them too — this is
 *  the second layer, not the only one.
 */
const SETTABLE = ['proposed', 'paused', 'done', 'abandoned'] as const;

function Verbs({ goal }: { goal: Goal }) {
  if (!goal.authorises) {
    return (
      <span className="text-[11px] px-1.5 py-0.5 rounded bg-stone-800 text-stone-400">
        tracked — authorises nothing
      </span>
    );
  }
  const spent = goal.actions_used >= goal.max_actions;
  const expired = !!goal.expires_at && new Date(goal.expires_at) < new Date();
  return (
    <span className="flex flex-wrap items-center gap-1">
      {goal.approved_verbs.map(v => (
        <code key={v} className="text-[11px] px-1.5 py-0.5 rounded bg-amber-900/40 text-amber-200">
          {v}
        </code>
      ))}
      {/* The two numbers that explain a refusal. Without them "she says she's
          blocked" has no visible cause anywhere in the app. */}
      <span className={`text-[11px] ${spent ? 'text-red-400' : 'text-stone-400'}`}>
        {goal.actions_used}/{goal.max_actions} actions{spent && ' — spent'}
      </span>
      {goal.expires_at && (
        <span className={`text-[11px] ${expired ? 'text-red-400' : 'text-stone-500'}`}>
          {expired ? 'expired' : 'expires'} {fmtDateTime(goal.expires_at)}
        </span>
      )}
    </span>
  );
}

export function GoalsTab() {
  const [rows, setRows] = useState<Goal[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState('');
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ title: '', description: '' });
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState({ title: '', description: '' });

  const load = () => getGoals().then(setRows).catch(e => setStatus(String(e)))
    .finally(() => setLoaded(true));
  useEffect(() => { load(); }, []);

  async function save(id: string, patch: Partial<Goal>) {
    try {
      await patchGoal(id, patch);
      setEditing(null);
      load();
    } catch (err) { setStatus(String(err)); }
  }

  async function remove(g: Goal) {
    if (!window.confirm(`Delete goal "${g.title}"? This cannot be undone.`)) return;
    try { await deleteGoal(g.id); load(); } catch (err) { setStatus(String(err)); }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      await createGoal(form);
      setCreating(false);
      setForm({ title: '', description: '' });
      load();
    } catch (err) { setStatus(String(err)); }
  }

  if (!loaded) return <CardsSkeleton />;

  // Open work first; finished and abandoned goals sink. Sorting here rather
  // than in SQL so "what am I doing" is the top of the list whatever order
  // the rows arrived in.
  const rank = (s: string) => (s === 'active' ? 0 : s === 'proposed' ? 1
    : s === 'paused' ? 2 : 3);
  const sorted = [...rows].sort((a, b) => rank(a.status) - rank(b.status));

  return (
    <div className="space-y-3">
      {status && <div className="text-xs text-red-400">{status}</div>}

      {sorted.map(g => (
        <div key={g.id} className="rounded-lg border border-stone-800 bg-stone-900/40 p-3">
          {editing === g.id ? (
            <div className="space-y-2">
              <input
                className="w-full bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200"
                value={draft.title}
                onChange={e => setDraft({ ...draft, title: e.target.value })} />
              <textarea
                rows={6}
                className="w-full bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200 font-mono"
                placeholder="What done looks like. A markdown checklist works well."
                value={draft.description}
                onChange={e => setDraft({ ...draft, description: e.target.value })} />
              <div className="flex gap-2 justify-end">
                <button onClick={() => setEditing(null)}
                  className="text-xs text-stone-400 px-2">cancel</button>
                <button onClick={() => save(g.id, draft)}
                  className="text-xs bg-teal-700 hover:bg-teal-600 text-white rounded px-3 py-1">save</button>
              </div>
            </div>
          ) : (
            <>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-sm text-stone-200">{g.title}</div>
                  <div className="mt-1"><Verbs goal={g} /></div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <select
                    value={SETTABLE.includes(g.status as never) ? g.status : ''}
                    onChange={e => save(g.id, { status: e.target.value })}
                    className="bg-stone-800 border border-stone-700 rounded px-1 py-0.5 text-xs text-stone-300"
                    title={g.status === 'active'
                      ? 'Active is reached by approving the goal, not by setting it here'
                      : 'Status'}
                  >
                    {/* `active` shows when it IS active, and cannot be chosen:
                        granting a goal's verbs happens on an approval card. */}
                    {g.status === 'active' && <option value="">active</option>}
                    {SETTABLE.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                  <button
                    onClick={() => { setEditing(g.id); setDraft({ title: g.title, description: g.description }); }}
                    className="text-xs text-stone-400 hover:text-teal-300">edit</button>
                  <button onClick={() => remove(g)}
                    className="text-xs text-stone-500 hover:text-red-400">delete</button>
                </div>
              </div>
              {/* WHAT CAME OF IT. A goal with no work under it looks the
                  same as one that was quietly abandoned, and the difference
                  is the only thing worth knowing weeks later. */}
              {!!g.sessions?.length && (
                <div className="mt-2 space-y-1">
                  {g.sessions.map(s => (
                    <div key={s.session_id} className="flex items-center gap-2 text-[11px]">
                      <span className="text-stone-500">{s.branch || 'no branch'}</span>
                      <span className={s.state === 'done' ? 'text-stone-400' : 'text-amber-400'}>{s.state}</span>
                      {s.sandbox && (
                        <span className={s.sandbox === 'ok' ? 'text-teal-400' : 'text-red-400'}>
                          sandbox {s.sandbox}
                        </span>
                      )}
                      {s.review && (
                        <span className={s.review === 'pass' ? 'text-teal-400' : 'text-amber-400'}>
                          review {s.review}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {g.description && (
                <pre className="mt-2 text-xs text-stone-400 whitespace-pre-wrap font-sans">{g.description}</pre>
              )}
              <div className="mt-2 text-[11px] text-stone-600">
                {g.created_by || g.proposed_by || 'unknown'} · {fmtDateTime(g.created_at)}
                {g.source_recommendation_id && ' · from an approved idea'}
              </div>
            </>
          )}
        </div>
      ))}

      {sorted.length === 0 && (
        <div className="text-xs text-stone-500">
          No goals yet. Approve an idea from the inbox, or write one down here.
        </div>
      )}

      {creating ? (
        <form onSubmit={submit} className="rounded-lg border border-stone-800 p-3 space-y-2">
          <input autoFocus required placeholder="What are you trying to get to?"
            className="w-full bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200"
            value={form.title}
            onChange={e => setForm({ ...form, title: e.target.value })} />
          <textarea rows={4} placeholder="Notes, or a checklist."
            className="w-full bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200 font-mono"
            value={form.description}
            onChange={e => setForm({ ...form, description: e.target.value })} />
          <div className="flex gap-2 justify-end">
            <button type="button" onClick={() => setCreating(false)}
              className="text-xs text-stone-400 px-2">cancel</button>
            <button type="submit"
              className="text-xs bg-teal-700 hover:bg-teal-600 text-white rounded px-3 py-1">create</button>
          </div>
        </form>
      ) : (
        <button onClick={() => setCreating(true)}
          className="w-full text-xs text-stone-400 hover:text-teal-300 border border-dashed border-stone-700 hover:border-teal-800 rounded-lg py-2">
          + goal
        </button>
      )}
    </div>
  );
}
