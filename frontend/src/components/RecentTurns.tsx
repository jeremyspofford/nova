import { useEffect, useState } from 'react';
import { getTraces, TraceListItem } from '../api';
import { TurnInspector } from '../chat/TurnInspector';
import { fmtDateTime } from '../time';

/** Settings → Observability: the last N turn traces across ALL sources —
 *  eval runs, chat turns, automation runs, compaction passes. Neither evals
 *  nor automations have a chat message to click, so this list is their only
 *  door into the Turn Inspector (which each row opens).
 *
 *  The endpoint applies no source filter, and eval outnumbers everything else
 *  about four to one (1625 eval against 392 chat, 128 automation, 16
 *  compaction), so most of a 50-row page is eval — which is precisely why the
 *  badge has to name it in its own colour. */

const SOURCE_STYLE: Record<TraceListItem['source'], string> = {
  eval: 'border-violet-700 text-violet-400',
  chat: 'border-teal-800 text-teal-400',
  automation: 'border-amber-800 text-amber-400',
  compaction: 'border-stone-600 text-stone-400',
};

/** The `source` union is hand-written against a CHECK constraint in migration
 *  050, so it drifts the day a fifth source is added — and a miss is loud, not
 *  quiet: the class string became the literal "undefined" and Tailwind's
 *  preflight then drew a near-white border, the most conspicuous badge in a
 *  list of muted ones. */
const sourceStyle = (s: TraceListItem['source']): string =>
  SOURCE_STYLE[s] ?? 'border-stone-600 text-stone-400';

const fmtSecs = (s: number | null): string =>
  s === null ? '…' : s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`;

export function RecentTurns() {
  const [traces, setTraces] = useState<TraceListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [inspectId, setInspectId] = useState<string | null>(null);

  const load = () => {
    getTraces(50).then(t => { setTraces(t); setError(null); })
      .catch(e => setError(String(e)));
  };
  useEffect(() => { if (open) load(); }, [open]);

  return (
    <div className="rounded-lg border border-stone-700/70 bg-stone-800/40">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-3 py-2 text-left"
      >
        <span>
          <span className="text-sm text-stone-200">Recent turns</span>
          <span className="block text-xs text-stone-500">
            Every traced turn — eval runs, chat, automations, compaction —
            with its timings; click one to inspect.
          </span>
        </span>
        <span className="text-stone-500 text-xs shrink-0 ml-3">{open ? 'hide' : 'show'}</span>
      </button>

      {open && (
        <div className="border-t border-stone-700/70 px-3 py-2 space-y-1">
          <div className="flex justify-end">
            <button onClick={load} className="text-[11px] text-stone-500 hover:text-teal-400">
              refresh
            </button>
          </div>
          {error && <div className="text-xs text-red-400">{error}</div>}
          {traces && traces.length === 0 && (
            <div className="text-xs text-stone-500 pb-1">No traces yet.</div>
          )}
          {!traces && !error && <div className="text-xs text-stone-500 pb-1">Loading…</div>}
          <div className="max-h-72 overflow-y-auto nice-scroll -mx-1">
            {(traces ?? []).map(t => (
              <button
                key={t.id}
                onClick={() => setInspectId(t.id)}
                className="w-full flex items-center gap-2 px-1 py-1 rounded text-left hover:bg-stone-700/40"
                title="Open in the Turn Inspector"
              >
                <span className={`shrink-0 w-24 text-center text-[10px] font-mono px-1 py-0.5 rounded border ${sourceStyle(t.source)}`}>
                  {t.source}
                </span>
                <span className="flex-1 min-w-0 truncate text-xs text-stone-300">
                  {t.automation ?? t.model ?? '—'}
                </span>
                <span className={`shrink-0 text-[10px] font-mono ${
                  t.status === 'ok' ? 'text-stone-500' : 'text-red-400'}`}>
                  {t.status === 'ok' ? '' : `${t.status} · `}
                  {fmtSecs(t.secs)}
                  {t.tools ? ` · ${t.tools} tool${t.tools > 1 ? 's' : ''}` : ''}
                </span>
                <span className="shrink-0 w-36 text-right text-[10px] font-mono text-stone-600">
                  {fmtDateTime(t.started_at)}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {inspectId && (
        <TurnInspector traceId={inspectId} onClose={() => setInspectId(null)} />
      )}
    </div>
  );
}
