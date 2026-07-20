import { useEffect, useMemo, useState } from 'react';
import { getTrace, TraceDetail, TraceSpan } from '../api';
import { agentDisplayName, displayName } from '../names';

/** Right-side drawer showing one turn's ledger: a waterfall of spans
 *  (prompt build, memory retrieval, LLM rounds, tools, dispatch subtrees)
 *  with durations, token counts, and expandable detail. Opened from the
 *  duration chip under an assistant message. */

const KIND_STYLE: Record<TraceSpan['kind'], { bar: string; label: string; text: string }> = {
  stage:    { bar: 'bg-stone-500',  label: 'stage',    text: 'text-stone-400' },
  llm_call: { bar: 'bg-teal-500',   label: 'llm',      text: 'text-teal-400' },
  tool:     { bar: 'bg-amber-500',  label: 'tool',     text: 'text-amber-400' },
  dispatch: { bar: 'bg-purple-500', label: 'dispatch', text: 'text-purple-400' },
};

const ms = (from: string, to: string | null): number | null =>
  to === null ? null : Date.parse(to) - Date.parse(from);

const fmtMs = (v: number | null): string =>
  v === null ? '…' : v < 1000 ? `${Math.round(v)}ms` : `${(v / 1000).toFixed(2)}s`;

function spanTitle(s: TraceSpan): string {
  if (s.kind === 'dispatch') return `dispatch → ${agentDisplayName(s.name)}`;
  if (s.kind === 'tool') return displayName(s.name);
  if (s.kind === 'llm_call') {
    const round = s.detail.round;
    return `${s.name}${typeof round === 'number' ? ` · round ${round}` : ''}`;
  }
  return s.name.replace(/_/g, ' ');
}

export function TurnInspector({ traceId, onClose }: { traceId: string; onClose: () => void }) {
  const [data, setData] = useState<TraceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    setError(null);
    getTrace(traceId).then(setData).catch(e => setError(String(e)));
  }, [traceId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // depth per span (dispatch subtrees indent) + waterfall geometry
  const rows = useMemo(() => {
    if (!data) return [];
    const t0 = Date.parse(data.trace.started_at);
    const tEnd = data.trace.finished_at
      ? Date.parse(data.trace.finished_at)
      : Math.max(t0 + 1, ...data.spans.map(s => Date.parse(s.finished_at ?? s.started_at)));
    const total = Math.max(1, tEnd - t0);
    const depth = new Map<string, number>();
    for (const s of data.spans) {
      depth.set(s.id, s.parent_span_id ? (depth.get(s.parent_span_id) ?? 0) + 1 : 0);
    }
    return data.spans.map(s => {
      const start = Date.parse(s.started_at);
      const dur = ms(s.started_at, s.finished_at);
      return {
        span: s,
        depth: depth.get(s.id) ?? 0,
        dur,
        left: Math.min(99, ((start - t0) / total) * 100),
        width: Math.max(1, ((dur ?? 0) / total) * 100),
      };
    });
  }, [data]);

  const totalMs = data ? ms(data.trace.started_at, data.trace.finished_at) : null;
  const tokens = useMemo(() => {
    let inTok = 0, outTok = 0, seen = false;
    for (const s of data?.spans ?? []) {
      if (s.kind !== 'llm_call') continue;
      if (typeof s.detail.prompt_tokens === 'number') { inTok += s.detail.prompt_tokens; seen = true; }
      if (typeof s.detail.completion_tokens === 'number') { outTok += s.detail.completion_tokens; seen = true; }
    }
    return seen ? { inTok, outTok } : null;
  }, [data]);

  return (
    <>
      {/* backdrop — click closes */}
      <div className="fixed inset-0 z-40 bg-black/40" onClick={onClose} />
      <aside
        className="fixed top-0 right-0 bottom-0 z-50 w-[min(34rem,92vw)] bg-stone-900 border-l border-stone-700 shadow-2xl flex flex-col"
        role="dialog"
        aria-label="Turn inspector"
      >
        <header className="px-4 py-3 border-b border-stone-700 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-stone-200">Turn inspector</div>
            {data && (
              <div className="text-[11px] text-stone-500 font-mono mt-0.5 truncate">
                {data.trace.source}
                {data.trace.automation ? ` · ${data.trace.automation}` : ''}
                {data.trace.model ? ` · ${data.trace.model}` : ''}
              </div>
            )}
          </div>
          <button
            onClick={onClose}
            className="shrink-0 text-stone-500 hover:text-stone-200 text-sm px-1.5 py-0.5 rounded border border-stone-700"
            aria-label="Close inspector"
          >
            Close
          </button>
        </header>

        <div className="flex-1 overflow-y-auto nice-scroll p-4 space-y-3">
          {error && (
            <div className="text-xs text-red-400 bg-red-950/40 border border-red-900 rounded px-3 py-2">
              {error}
            </div>
          )}
          {!data && !error && <div className="text-xs text-stone-500">Loading trace…</div>}

          {data && (
            <>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-stone-400">
                <span>total <b className="text-stone-200">{fmtMs(totalMs)}</b></span>
                {tokens && (
                  <span>tokens <b className="text-stone-200">{tokens.inTok.toLocaleString()} in
                    / {tokens.outTok.toLocaleString()} out</b></span>
                )}
                <span>status <b className={data.trace.status === 'ok' ? 'text-teal-400' : 'text-red-400'}>
                  {data.trace.status}</b></span>
              </div>
              {data.trace.error && (
                <div className="text-xs text-red-400 bg-red-950/40 border border-red-900 rounded px-3 py-2 break-words">
                  {data.trace.error}
                </div>
              )}

              <div className="space-y-2">
                {rows.map(({ span, depth, dur, left, width }) => {
                  const st = KIND_STYLE[span.kind];
                  const hasDetail = Object.keys(span.detail).length > 0;
                  return (
                    <div key={span.id} style={{ marginLeft: depth * 14 }}>
                      <div className="flex items-baseline justify-between gap-2 text-xs">
                        <span className="min-w-0 truncate">
                          <span className={`${st.text} font-mono text-[10px] mr-1.5`}>{st.label}</span>
                          <span className={span.status === 'ok' ? 'text-stone-300' : 'text-red-400'}>
                            {spanTitle(span)}
                          </span>
                        </span>
                        <span className="shrink-0 font-mono text-[11px] text-stone-500">{fmtMs(dur)}</span>
                      </div>
                      <div className="relative h-1.5 mt-1 rounded bg-stone-800 overflow-hidden">
                        <div
                          className={`absolute top-0 bottom-0 rounded ${span.status === 'ok' ? st.bar : 'bg-red-500'}`}
                          style={{ left: `${left}%`, width: `${width}%` }}
                        />
                      </div>
                      {hasDetail && (
                        <details className="mt-1">
                          <summary className="text-[10px] text-stone-600 hover:text-stone-400 cursor-pointer select-none">
                            detail
                          </summary>
                          <pre className="mt-1 text-[10px] text-stone-400 bg-stone-950/60 border border-stone-800 rounded p-2 overflow-x-auto whitespace-pre-wrap break-words">
                            {JSON.stringify(span.detail, null, 2)}
                          </pre>
                        </details>
                      )}
                    </div>
                  );
                })}
                {rows.length === 0 && (
                  <div className="text-xs text-stone-500">No spans recorded for this turn.</div>
                )}
              </div>
            </>
          )}
        </div>
      </aside>
    </>
  );
}
