import { useState, useEffect, useRef } from 'react';
import {
  CoderSession, CoderWorkspace, addCoderWorkspace, coderStatus,
  deleteCoderWorkspace, getCoderSessions, getCoderWorkspaces,
  killCoderSession, startCoderSession,
} from '../../api';
import { CardsSkeleton } from '../ui';

/** Coding delegation — the repos Nova may work on, and what she has run.
 *
 *  The deliverable of a session is a BRANCH AND A DIFF, never a merge: this
 *  surface deliberately has no "apply" button, because the operator merging is
 *  the gate (docs/plans/acp-coding-delegation.md).
 *
 *  Sessions run for minutes, so the list polls while any row is live rather
 *  than making the operator refresh to find out. */

const LIVE = new Set(['starting', 'running']);

function stateClass(s: string) {
  if (s === 'done') return 'bg-teal-950/50 text-teal-300 border-teal-900';
  if (s === 'killed') return 'bg-amber-950/50 text-amber-300 border-amber-900';
  if (s === 'failed') return 'bg-red-950/50 text-red-300 border-red-900';
  return 'bg-stone-800 text-stone-300 border-stone-700';
}

export function CodingTab() {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [spaces, setSpaces] = useState<CoderWorkspace[]>([]);
  const [sessions, setSessions] = useState<CoderSession[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState('');
  const [form, setForm] = useState({ name: '', git_url: '' });
  const [task, setTask] = useState({ workspace: '', text: '' });
  const [busy, setBusy] = useState(false);
  const timer = useRef<number | null>(null);

  const load = async () => {
    try {
      const [st, ws, ss] = await Promise.all([
        coderStatus(), getCoderWorkspaces(), getCoderSessions(),
      ]);
      setConfigured(st.configured);
      setSpaces(ws);
      setSessions(ss);
      if (!task.workspace && ws.length) setTask(t => ({ ...t, workspace: ws[0].name }));
    } catch (e) { setStatus(String(e)); } finally { setLoaded(true); }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  // Poll only while something is actually running — a coding session takes
  // minutes, and a list that goes stale mid-run reads as a hung session.
  useEffect(() => {
    const live = sessions.some(s => LIVE.has(s.state));
    if (timer.current) { window.clearInterval(timer.current); timer.current = null; }
    if (live) timer.current = window.setInterval(load, 5000);
    return () => { if (timer.current) window.clearInterval(timer.current); };
    /* eslint-disable-next-line */
  }, [sessions]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim() || !form.git_url.trim()) return;
    setBusy(true);
    try {
      await addCoderWorkspace(form);
      setForm({ name: '', git_url: '' });
      setStatus('');
      await load();
    } catch (e) { setStatus(String(e)); } finally { setBusy(false); }
  }

  async function start(e: React.FormEvent) {
    e.preventDefault();
    if (!task.workspace || !task.text.trim()) return;
    setBusy(true);
    try {
      await startCoderSession({ workspace: task.workspace, task: task.text });
      setTask(t => ({ ...t, text: '' }));
      setStatus('');
      await load();
    } catch (e) { setStatus(String(e)); } finally { setBusy(false); }
  }

  if (!loaded) return <CardsSkeleton />;

  if (configured === false) {
    return (
      <div className="text-sm text-stone-400 space-y-2">
        <p className="text-stone-300">Coding delegation is not running.</p>
        <p>
          It is an optional sidecar. Set <code className="text-stone-300">NOVA_CODER_TOKEN</code> and{' '}
          <code className="text-stone-300">CODER_API_KEY</code> in <code className="text-stone-300">.env</code>, then start it:
        </p>
        <pre className="bg-stone-950/60 border border-stone-800 rounded p-2 text-xs overflow-x-auto">
docker compose --profile coder up -d coder</pre>
        <p className="text-stone-500">
          The agent runs in its own container against a private clone — it never
          touches your working copy, and nothing merges without you.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {status && <div className="text-xs text-red-400">{status}</div>}

      {/* ── repos ─────────────────────────────────────────────────────── */}
      <section className="space-y-2">
        <h3 className="text-sm text-stone-200">Repositories</h3>
        <p className="text-xs text-stone-500">
          Cloned fresh from the remote for each session, so only committed work
          is visible and nothing gitignored (your <code>.env</code>) ever crosses.
        </p>
        {spaces.map(w => (
          <div key={w.id} className="flex items-center justify-between gap-2 rounded border border-stone-800 bg-stone-900/60 px-3 py-2">
            <div className="min-w-0">
              <div className="text-sm text-stone-100">{w.name}</div>
              <div className="text-xs text-stone-500 truncate font-mono">{w.git_url}</div>
            </div>
            <button
              onClick={async () => {
                if (!window.confirm(`Remove "${w.name}"?`)) return;
                try { await deleteCoderWorkspace(w.name); load(); }
                catch (e) { setStatus(String(e)); }
              }}
              className="text-xs px-2 py-0.5 rounded border border-stone-600 text-stone-500 hover:text-red-400 hover:border-red-800 shrink-0"
            >remove</button>
          </div>
        ))}
        <form onSubmit={add} className="flex gap-2">
          <input
            value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
            placeholder="name" aria-label="Repository name"
            className="w-32 bg-stone-950 border border-stone-700 rounded px-2 py-1 text-sm text-stone-100"
          />
          <input
            value={form.git_url} onChange={e => setForm({ ...form, git_url: e.target.value })}
            placeholder="https://github.com/you/repo.git" aria-label="Git URL"
            className="flex-1 min-w-0 bg-stone-950 border border-stone-700 rounded px-2 py-1 text-sm text-stone-100 font-mono"
          />
          <button disabled={busy} className="text-xs bg-teal-700 hover:bg-teal-600 disabled:opacity-50 text-white rounded px-3">add</button>
        </form>
      </section>

      {/* ── start ─────────────────────────────────────────────────────── */}
      {spaces.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm text-stone-200">Delegate a task</h3>
          <form onSubmit={start} className="space-y-2">
            <select
              value={task.workspace} onChange={e => setTask({ ...task, workspace: e.target.value })}
              aria-label="Repository"
              className="bg-stone-950 border border-stone-700 rounded px-2 py-1 text-sm text-stone-100"
            >
              {spaces.filter(w => w.enabled).map(w => <option key={w.id} value={w.name}>{w.name}</option>)}
            </select>
            <textarea
              value={task.text} onChange={e => setTask({ ...task, text: e.target.value })}
              rows={3} placeholder="What should it change? Be specific about files."
              aria-label="Task"
              className="w-full bg-stone-950 border border-stone-700 rounded px-2 py-1 text-sm text-stone-100"
            />
            <div className="flex items-center gap-3">
              <button disabled={busy} className="text-xs bg-teal-700 hover:bg-teal-600 disabled:opacity-50 text-white rounded px-3 py-1">
                start
              </button>
              <span className="text-xs text-stone-500">
                Runs for minutes. Produces a branch and a diff — never a merge.
              </span>
            </div>
          </form>
        </section>
      )}

      {/* ── sessions ──────────────────────────────────────────────────── */}
      <section className="space-y-2">
        <h3 className="text-sm text-stone-200">Sessions</h3>
        {sessions.length === 0 && <div className="text-xs text-stone-500">Nothing run yet.</div>}
        {sessions.map(s => (
          <div key={s.session_id} className="rounded border border-stone-800 bg-stone-900/60 px-3 py-2 space-y-1">
            <div className="flex items-center justify-between gap-2">
              <span className={`text-[10px] px-1.5 py-0.5 rounded border shrink-0 ${stateClass(s.state)}`}>
                {s.state}
              </span>
              <span className="text-xs text-stone-500 truncate flex-1">{s.workspace}</span>
              {LIVE.has(s.state) && (
                <button
                  onClick={async () => {
                    try { await killCoderSession(s.session_id); load(); }
                    catch (e) { setStatus(String(e)); }
                  }}
                  className="text-xs px-2 py-0.5 rounded border border-stone-600 text-stone-400 hover:text-red-400 hover:border-red-800 shrink-0"
                >stop</button>
              )}
            </div>
            <div className="text-sm text-stone-200">{s.task}</div>
            {s.branch && <div className="text-xs text-stone-500 font-mono">{s.branch}</div>}
            {s.diffstat && (
              <pre className="text-xs text-teal-300/80 whitespace-pre-wrap">{s.diffstat}</pre>
            )}
            {s.error && <div className="text-xs text-amber-400">{s.error}</div>}
          </div>
        ))}
      </section>
    </div>
  );
}
