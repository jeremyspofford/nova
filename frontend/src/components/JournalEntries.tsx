import { useEffect, useState } from 'react';
import { JournalEntry, forgetJournalEntry, getJournalEntries } from '../api';
import { Markdown } from './Markdown';

/** A day's journal, entry by entry, each one forgettable.
 *
 *  This is the operator's only path to removing a turn. `delete_memory_item`
 *  refuses journals — a model that can erase its own history can cover a
 *  mistake — so there is no agent-facing route and never will be, and an
 *  API without this surface would leave "forget that document" true in
 *  principle and unreachable in practice.
 *
 *  It replaces the raw markdown body for journals rather than sitting beside
 *  it: showing the same text twice, once removable and once not, is exactly
 *  the kind of ambiguity that gets the wrong thing deleted.
 */

const TOMBSTONE = /^>\s*\[removed by the operator/m;

export function JournalEntries({ date, onChanged }: {
  date: string;
  onChanged?: () => void;
}) {
  const [entries, setEntries] = useState<JournalEntry[] | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  async function load() {
    try {
      setEntries((await getJournalEntries(date)).entries);
      setErr('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setEntries([]);
    }
  }
  useEffect(() => { void load(); setConfirming(null); }, [date]);

  async function forget(entry: JournalEntry) {
    setBusy(entry.sha256);
    try {
      await forgetJournalEntry(date, entry.sha256, reason);
      setConfirming(null);
      setReason('');
      await load();
      onChanged?.();          // the body on screen is now stale
    } catch (e) {
      // a 409 means the day moved on under us — reload rather than retry,
      // because the hash it was addressed by no longer means anything
      setErr(e instanceof Error ? e.message : String(e));
      await load();
    }
    setBusy(null);
  }

  if (entries === null) return <div className="text-xs text-stone-500">Reading the day…</div>;

  return (
    <div className="space-y-2">
      {err && <div className="text-xs text-red-400">{err}</div>}
      <div className="text-[11px] text-stone-500">
        {entries.length} {entries.length === 1 ? 'entry' : 'entries'}. Forgetting
        one removes its text from this file and from what Nova can retrieve —
        she will not be able to recall it. A note is left in its place saying
        something was removed.
      </div>

      {entries.map(e => {
        const gone = TOMBSTONE.test(e.text);
        return (
          <div key={e.sha256}
            className={`rounded border px-2.5 py-2 ${gone
              ? 'border-stone-800 bg-stone-900/40'
              : 'border-stone-700/60 bg-stone-900/40'}`}>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-xs text-stone-400">{e.stamp}</span>
                <span className="text-[10px] font-mono text-stone-600"
                  title="Content hash — entries are addressed by this, not by their timestamp, because a day routinely repeats a timestamp.">
                  {e.sha256.slice(0, 8)}
                </span>
                {gone && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded border border-stone-700 text-stone-500">
                    forgotten
                  </span>
                )}
              </div>
              {!gone && (
                <button
                  onClick={() => setConfirming(confirming === e.sha256 ? null : e.sha256)}
                  disabled={busy === e.sha256}
                  className="text-xs px-2 py-0.5 rounded border border-stone-600 text-stone-500 hover:text-red-400 hover:border-red-800 disabled:opacity-40 shrink-0"
                >
                  forget
                </button>
              )}
            </div>

            <div className="mt-1 text-xs text-stone-400 [overflow-wrap:anywhere]">
              <Markdown>{e.text.replace(/^## .*$/m, '').trim()}</Markdown>
            </div>

            {confirming === e.sha256 && (
              <div className="mt-2 pt-2 border-t border-stone-800 space-y-1.5">
                <div className="text-[11px] text-amber-400/90">
                  This removes the text above from Nova&apos;s memory and from
                  the file on disk. It cannot be undone.
                </div>
                <input
                  value={reason}
                  onChange={ev => setReason(ev.target.value)}
                  placeholder="why (optional — it is written into the note left behind)"
                  className="w-full bg-stone-800 border border-stone-700 rounded px-2 py-1 text-xs text-stone-300"
                />
                <div className="flex gap-2 justify-end">
                  <button onClick={() => { setConfirming(null); setReason(''); }}
                    className="text-xs text-stone-400 px-2">cancel</button>
                  <button onClick={() => void forget(e)} disabled={busy === e.sha256}
                    className="text-xs bg-red-800 hover:bg-red-700 disabled:opacity-50 text-white rounded px-3 py-1">
                    {busy === e.sha256 ? 'forgetting…' : 'forget this entry'}
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
