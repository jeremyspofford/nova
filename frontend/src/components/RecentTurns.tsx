import { useEffect, useState } from 'react';
import { TraceFilters, TraceListItem, getTraces } from '../api';
import { TurnInspector } from '../chat/TurnInspector';
import { fmtDateTime } from '../time';
import { fmtTokens } from '../observability';

/** Settings → Observability: the last N turn traces across ALL sources —
 *  eval runs, chat turns, automation runs, compaction passes, heartbeat
 *  ticks. Neither evals nor automations have a chat message to click, so this
 *  list is their only door into the Turn Inspector (which each row opens).
 *
 *  Unfiltered, eval outnumbers everything else about four to one (1625 eval
 *  against 392 chat, 128 automation, 16 compaction), so most of a 50-row page
 *  is eval — which is why the badge names it in its own colour AND why the
 *  source chips exist: "show me the heartbeat turns" used to mean scrolling
 *  past two screens of replays. */

const SOURCE_STYLE: Record<TraceListItem['source'], string> = {
  eval: 'border-violet-700 text-violet-400',
  chat: 'border-teal-800 text-teal-400',
  automation: 'border-amber-800 text-amber-400',
  compaction: 'border-stone-600 text-stone-400',
  heartbeat: 'border-sky-800 text-sky-400',
};

/** The `source` union is hand-written against a CHECK constraint in migration
 *  050, so it drifts the day a sixth source is added — and a miss is loud, not
 *  quiet: the class string became the literal "undefined" and Tailwind's
 *  preflight then drew a near-white border, the most conspicuous badge in a
 *  list of muted ones. */
const sourceStyle = (s: TraceListItem['source']): string =>
  SOURCE_STYLE[s] ?? 'border-stone-600 text-stone-400';

const SOURCES = Object.keys(SOURCE_STYLE) as TraceListItem['source'][];
const STATUSES = ['ok', 'error', 'cancelled'] as const;
const TRACE_WINDOWS = ['1h', '6h', '24h', '7d'] as const;

const fmtSecs = (s: number | null): string =>
  s === null ? '…' : s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`;

function Chip({ on, label, onClick }: {
  on: boolean; label: string; onClick: () => void;
}) {
  return (
    <button onClick={onClick}
      className={`px-1.5 py-0.5 rounded text-[10px] ${
        on ? 'bg-teal-700/50 text-teal-200' : 'text-stone-500 hover:text-stone-300'}`}>
      {label}
    </button>
  );
}

export function RecentTurns() {
  const [traces, setTraces] = useState<TraceListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [inspectId, setInspectId] = useState<string | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [status, setStatus] = useState<TraceFilters['status']>(null);
  const [window, setWindow] = useState<TraceFilters['window']>(null);

  const load = (f: TraceFilters) => {
    getTraces({ limit: 50, ...f }).then(t => { setTraces(t); setError(null); })
      .catch(e => setError(String(e)));
  };
  useEffect(() => {
    if (open) load({ source, status, window });
  }, [open, source, status, window]);

  return (
    <div className="rounded-lg border border-stone-700/70 bg-stone-800/40">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-3 py-2 text-left"
      >
        <span>
          <span className="text-sm text-stone-200">Recent turns</span>
          <span className="block text-xs text-stone-500">
            Every traced turn — eval runs, chat, automations, compaction,
            heartbeat — with its timings and tokens; click one to inspect.
          </span>
        </span>
        <span className="text-stone-500 text-xs shrink-0 ml-3">{open ? 'hide' : 'show'}</span>
      </button>

      {open && (
        <div className="border-t border-stone-700/70 px-3 py-2 space-y-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="flex items-center gap-0.5">
              <Chip on={source === null} label="all" onClick={() => setSource(null)} />
              {SOURCES.map(s => (
                <Chip key={s} on={source === s} label={s}
                  onClick={() => setSource(cur => (cur === s ? null : s))} />
              ))}
            </span>
            <span className="flex items-center gap-0.5">
              {STATUSES.map(s => (
                <Chip key={s} on={status === s} label={s}
                  onClick={() => setStatus(cur => (cur === s ? null : s))} />
              ))}
            </span>
            <span className="flex items-center gap-0.5">
              {TRACE_WINDOWS.map(w => (
                <Chip key={w} on={window === w} label={w}
                  onClick={() => setWindow(cur => (cur === w ? null : w))} />
              ))}
            </span>
            <button onClick={() => load({ source, status, window })}
              className="ml-auto text-[11px] text-stone-500 hover:text-teal-400">
              refresh
            </button>
          </div>
          {error && <div className="text-xs text-red-400">{error}</div>}
          {traces && traces.length === 0 && (
            <div className="text-xs text-stone-500 pb-1">
              No traces{source || status || window ? ' match these filters' : ' yet'}.
            </div>
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
                {/* 0 tokens with llm calls means the spans carried no usage
                    figures — that turn shows nothing rather than "0 tok",
                    because a zero here would read as free. */}
                {t.tokens > 0 && (
                  <span className="shrink-0 text-[10px] font-mono text-stone-500"
                    title={`${t.prompt_tokens.toLocaleString()} prompt + ${t.completion_tokens.toLocaleString()} completion over ${t.llm_calls} llm call${t.llm_calls === 1 ? '' : 's'}`}>
                    {fmtTokens(t.tokens)} tok
                  </span>
                )}
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
