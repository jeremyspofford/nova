import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ActionFacets, ActionLog as ActionLogData, ActionRow,
  getActionFacets, getActionLog,
} from '../api';
import { TurnInspector } from '../chat/TurnInspector';
import { CardsSkeleton, Surface } from './ui';

/** THE ACTION LOG — /activity.
 *
 *  Jeremy, 2026-08-07: "Activity page doesn't help me at all and the
 *  observability page doesn't help me on what's she's doing either. She
 *  cannot be silent on her actions."
 *
 *  He was right about both. The old /activity was the media INGEST QUEUE and
 *  nothing else; Observability is CPU/RAM meters plus a turn/cost rollup whose
 *  one behavioural widget lists TRACES (`eval · glm-5.2 · 12.4s · 3 tools`).
 *  Neither could show a refusal at all: `turn_traces.status` is 'ok' for a
 *  turn whose every write was refused, because the refusal lives one level
 *  down in a span's `detail.error`, behind a click into a one-turn-at-a-time
 *  inspector.
 *
 *  So this page is chronological and ACTION-shaped, not turn-shaped, and it
 *  opens on the refusals and failures. Every row: when, who, what in plain
 *  language, the arguments that mattered, the outcome and why, and a link to
 *  the full trace where there is one.
 *
 *  Nothing here is a second source of truth — the backend read model derives
 *  every row from records the system already writes (see activity_log.py).
 *  The ingestion queue this route used to be still exists, one click away,
 *  because retry/dismiss belong to that queue and not to a log. */

const POLL_MS = 5000;
const PAGE = 150;

/** Colour and word per outcome. UNKNOWN OUTCOMES ARE EXPECTED: the backend
 *  derives them and can grow one without a frontend release, so every lookup
 *  goes through `tone()`. RecentTurns learned this the loud way — a missing
 *  key produced the literal class string "undefined" and Tailwind's preflight
 *  drew the most conspicuous badge on the page. */
const TONE: Record<string, { chip: string; dot: string; word: string }> = {
  ok:      { chip: 'border-stone-700 text-stone-400',     dot: 'bg-emerald-500', word: 'done' },
  refused: { chip: 'border-amber-700 text-amber-300',     dot: 'bg-amber-400',   word: 'refused' },
  failed:  { chip: 'border-red-800 text-red-300',         dot: 'bg-red-500',     word: 'failed' },
  stalled: { chip: 'border-orange-800 text-orange-300',   dot: 'bg-orange-400',  word: 'stalled' },
  running: { chip: 'border-teal-800 text-teal-300',       dot: 'bg-teal-400',    word: 'running' },
  waiting: { chip: 'border-violet-800 text-violet-300',   dot: 'bg-violet-400',  word: 'waiting' },
  skipped: { chip: 'border-stone-700 text-stone-500',     dot: 'bg-stone-600',   word: 'skipped' },
};
const FALLBACK = { chip: 'border-stone-600 text-stone-400', dot: 'bg-stone-500', word: '' };
const tone = (o: string) => TONE[o] ?? { ...FALLBACK, word: o };

/** What each source of rows is, in his words rather than the table's. */
const KIND_LABEL: Record<string, string> = {
  tool: 'tool call',
  config: 'config change',
  coding: 'coding',
  automation: 'scheduled',
  action: 'approved plan',
  consent: 'your decision',
  ingest: 'ingestion',
  meta: 'log problem',
};
const kindLabel = (k: string) => KIND_LABEL[k] ?? k;

function ago(iso: string | null): string {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

function clock(iso: string | null): string {
  if (!iso) return '--:--';
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function dayOf(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const today = new Date();
  const yday = new Date(Date.now() - 86400_000);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, today)) return 'Today';
  if (same(d, yday)) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

/** How many refusals/failures/stalls happened in the last hour.
 *
 *  The rail badge drinks from this. It used to be the INGEST failure count,
 *  which put a red dot on a page about refusals for a reason that had nothing
 *  to do with them — and, worse, left the dot dark on an hour in which three
 *  writes were refused. A badge that is silent about the thing its page is
 *  for is the same defect as the page was.
 *
 *  `counts` is a whole-window aggregate on the backend, not a tally of the
 *  rows it returned, so this asks for ONE row and still gets the true number.
 *  It used to ask for 50 and believe them: with the counts computed off a
 *  capped page, the badge under-reported by 4x on a busy window.
 *
 *  Slow poll: this is an at-a-glance signal, not the log itself. */
export function useActionProblems(intervalMs = 20000): number | null {
  const [n, setN] = useState<number | null>(null);
  useEffect(() => {
    let on = true;
    const tick = () => getActionLog({ window: '1h', outcome: 'problems', limit: 1 })
      .then(d => {
        if (!on) return;
        const keys = d.problem_outcomes ?? ['refused', 'failed', 'stalled'];
        setN(keys.reduce((a, k) => a + (d.counts[k] ?? 0), 0));
      })
      // Stay null, never 0: "the endpoint is unreachable" and "nothing went
      // wrong" must not render as the same calm rail.
      .catch(() => { if (on) setN(null); });
    tick();
    const id = setInterval(tick, intervalMs);
    return () => { on = false; clearInterval(id); };
  }, [intervalMs]);
  return n;
}

function Chip({ on, onClick, children, title }: {
  on: boolean; onClick: () => void; children: React.ReactNode; title?: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`px-2 py-1 rounded-full border text-[11px] whitespace-nowrap ${
        on ? 'border-teal-600 bg-teal-900/40 text-teal-200'
           : 'border-stone-700 text-stone-400 hover:border-stone-500 hover:text-stone-200'}`}
    >
      {children}
    </button>
  );
}

function Row({ row, onTrace }: { row: ActionRow; onTrace: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const t = tone(row.outcome);
  // A long reason is worth expanding; a short one is already fully shown, and
  // a disclosure arrow that reveals nothing is worse than none.
  const more = (row.reason_full ?? '').length > (row.reason ?? '').length;

  return (
    <div className="px-3 py-2 border-b border-stone-800/60 hover:bg-stone-800/30">
      <div className="flex items-start gap-2.5">
        <span
          className={`mt-[7px] w-2 h-2 rounded-full shrink-0 ${t.dot} ${
            row.outcome === 'running' ? 'animate-pulse' : ''}`}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="font-mono text-[11px] text-stone-600 tabular-nums shrink-0">
              {clock(row.at)}
            </span>
            <span className="text-[11px] text-teal-400/90 shrink-0">{row.actor}</span>
            <span
              className={`shrink-0 px-1.5 py-px rounded border text-[10px] uppercase tracking-wide ${t.chip}`}
            >
              {t.word || row.outcome}
            </span>
            <span className="text-sm text-stone-200 break-words">{row.title}</span>
            {row.graded && (
              <span
                className="shrink-0 text-[10px] px-1.5 py-px rounded border border-violet-800 text-violet-400"
                title="A graded eval replay, not real work — scored, and mostly not executed."
              >graded</span>
            )}
          </div>

          {row.detail && (
            <div className="mt-0.5 font-mono text-[11px] text-stone-500 break-all">
              {row.detail}
            </div>
          )}

          {row.reason && (
            <div
              className={`mt-0.5 text-[11px] break-words ${
                row.outcome === 'refused' ? 'text-amber-400/90'
                : row.outcome === 'failed' || row.outcome === 'stalled' ? 'text-red-400/85'
                : 'text-stone-500'}`}
            >
              {open ? row.reason_full : row.reason}
              {more && (
                <button
                  onClick={() => setOpen(o => !o)}
                  className="ml-1.5 text-stone-500 hover:text-stone-300 underline"
                >{open ? 'less' : 'more'}</button>
              )}
            </div>
          )}

          {row.tainted_turn && (
            <div className="mt-0.5 text-[11px] text-stone-600">
              this call brought outside text into the turn — the containment
              fence disarmed her system-changing tools from here on
            </div>
          )}
        </div>

        <div className="shrink-0 flex items-center gap-2 pt-0.5">
          <span className="text-[10px] text-stone-600 hidden sm:inline">
            {kindLabel(row.kind)}
          </span>
          <span className="text-[10px] text-stone-600 tabular-nums w-8 text-right">
            {ago(row.at)}
          </span>
          {row.trace_id ? (
            <button
              onClick={() => onTrace(row.trace_id!)}
              className="text-[10px] px-1.5 py-0.5 rounded border border-stone-700 text-stone-500 hover:border-teal-700 hover:text-teal-300"
              title="Open the full turn in the Turn Inspector"
            >trace</button>
          ) : (
            <span className="w-[38px]" aria-hidden />
          )}
        </div>
      </div>
    </div>
  );
}

export function ActionLogPage({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [win, setWin] = useState('24h');
  // Opens on the problems. Everything she DID is one click away; everything
  // she was REFUSED is the reason this page exists, and burying it under 200
  // successful search_memory calls is how the old surfaces failed.
  const [outcome, setOutcome] = useState<string | null>('problems');
  const [agent, setAgent] = useState<string | null>(null);
  const [graded, setGraded] = useState(false);
  // How far back into the window this page starts. The list used to stop at
  // `limit` with no way to reach the rest — 383 rows matched, 150 rendered,
  // and the page called itself complete.
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<ActionLogData | null>(null);
  const [facets, setFacets] = useState<ActionFacets | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [inspect, setInspect] = useState<string | null>(null);
  const [live, setLive] = useState(true);
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const d = await getActionLog({
        window: win, outcome, agent, graded, limit: PAGE, offset,
      });
      if (alive.current) { setData(d); setErr(null); }
    } catch (e) {
      if (alive.current) setErr(String(e instanceof Error ? e.message : e));
    }
  }, [win, outcome, agent, graded, offset]);

  // Any change of filter is a new question — page 4 of the old one is not an
  // answer to it, and an offset that outlives its filter is how a pager shows
  // an empty page and reads as "nothing here".
  useEffect(() => { setOffset(0); }, [win, outcome, agent, graded]);

  useEffect(() => {
    alive.current = true;
    load();
    return () => { alive.current = false; };
  }, [load]);

  // Live, newest first (requirement 5). Pausable, because reading a row that
  // jumps under the cursor is how a log becomes unreadable — and an inspector
  // open over the page means he is reading, so the poll waits. Paged-back
  // views do not poll at all: new rows arriving at the head would shift every
  // older page under him.
  useEffect(() => {
    if (!live || inspect || offset > 0) return;
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [live, inspect, offset, load]);

  useEffect(() => {
    getActionFacets(win, graded).then(setFacets).catch(() => setFacets(null));
  }, [win, graded]);

  const rows = data?.rows ?? [];
  const grouped = useMemo(() => {
    const out: { day: string; rows: ActionRow[] }[] = [];
    for (const r of rows) {
      const day = dayOf(r.at);
      if (!out.length || out[out.length - 1].day !== day) out.push({ day, rows: [] });
      out[out.length - 1].rows.push(r);
    }
    return out;
  }, [rows]);

  const counts = data?.counts ?? {};
  const problems = (data?.problem_outcomes ?? ['refused', 'failed', 'stalled'])
    .reduce((n, k) => n + (counts[k] ?? 0), 0);

  // Where this page sits inside the window. `matched` is a whole-window
  // aggregate backend-side, so these numbers do not move with the page size.
  const from = (data?.returned ?? 0) ? (data!.offset + 1) : 0;
  const to = (data?.offset ?? 0) + (data?.returned ?? 0);
  const hasOlder = !!data && to < data.matched;
  const hasNewer = (data?.offset ?? 0) > 0;
  const unreadable = data?.unreadable_sources ?? [];

  return (
    <Surface
      title="Action log"
      width="w-[58rem]"
      onBack={onClose}
      bodyClass="flex flex-col"
      actions={
        <button
          onClick={() => setLive(v => !v)}
          className={`text-[11px] px-2 py-1 rounded border ${
            live ? 'border-teal-700 text-teal-300' : 'border-stone-700 text-stone-500'}`}
        >{live ? 'live' : 'paused'}</button>
      }
      header={
        <header className="px-5 py-3.5 border-b border-stone-700 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-stone-100 font-semibold leading-snug">Action log</h2>
            <p className="text-xs text-stone-500 mt-0.5">
              Everything she did — and everything she was refused — newest first.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => setLive(v => !v)}
              className={`text-[11px] px-2 py-1 rounded border ${
                live ? 'border-teal-700 text-teal-300' : 'border-stone-700 text-stone-500'}`}
              title={live ? 'Updating every few seconds' : 'Paused — click to resume'}
            >{live ? '● live' : 'paused'}</button>
            <button
              onClick={onClose}
              className="text-stone-500 hover:text-stone-200 text-lg leading-none px-1"
              aria-label="Close"
            >×</button>
          </div>
        </header>
      }
    >
      {/* filters — time, outcome, agent (requirement 6) */}
      <div className="px-4 py-2.5 border-b border-stone-800 space-y-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {(facets?.windows ?? ['1h', '6h', '24h', '7d', '30d']).map(w => (
            <Chip key={w} on={w === win} onClick={() => setWin(w)}>{w}</Chip>
          ))}
          <span className="w-px h-4 bg-stone-800 mx-1" />
          <Chip on={outcome === 'problems'} onClick={() => setOutcome('problems')}
            title="Refusals, failures and stalled work — what needs you">
            problems{problems ? ` ${problems}` : ''}
          </Chip>
          <Chip on={outcome === 'refused'} onClick={() => setOutcome('refused')}
            title="Only the things a gate said no to">refused</Chip>
          <Chip on={outcome === 'failed'} onClick={() => setOutcome('failed')}
            title="Only the things that tried and broke">failed</Chip>
          <Chip on={outcome === null} onClick={() => setOutcome(null)}>everything</Chip>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <Chip on={agent === null} onClick={() => setAgent(null)}>all actors</Chip>
          {(facets?.agents ?? []).slice(0, 10).map(a => (
            <Chip key={a.name} on={agent === a.name} onClick={() => setAgent(a.name)}>
              {a.name} <span className="text-stone-600 tabular-nums">{a.count}</span>
            </Chip>
          ))}
          {/* Named, not hidden. Graded eval replays are four in five tool
              spans on a busy install; the page sets them aside by default and
              says how many, which is a stated choice rather than a silence. */}
          {(facets?.graded_excluded ?? 0) > 0 && (
            <Chip on={graded} onClick={() => setGraded(g => !g)}
              title="Graded eval replays are scored, mostly not executed — set aside by default">
              {graded ? 'hiding nothing' : `+${facets?.graded_excluded} graded`}
            </Chip>
          )}
        </div>
      </div>

      {/* honesty bar: what this page is NOT showing.
          A crash and a page cap are said separately and in that order. They
          were one sentence, and it named a crashed source as having "hit the
          page cap … narrow the window" — advice that could never fix it. */}
      {data && !data.complete && (
        <div className="px-4 py-1.5 text-[11px] text-amber-400/90 bg-amber-950/20 border-b border-amber-900/40 space-y-0.5">
          {unreadable.length > 0 && (
            <div className="text-red-300">
              Could not read {unreadable.join(', ')} — those rows are MISSING
              from this page, not absent. See the notice at the top and the
              backend log.
            </div>
          )}
          <div>
            Showing {from}–{to} of {data.matched} in this window
            {data.counts_complete ? '' : ' (at least — a source could not be counted)'}.
            {hasOlder && ' Older entries inside the window are on the next page.'}
            {data.capped_sources.length > 0 && (
              <> {data.capped_sources.join(', ')} also hit the per-source
                fetch ceiling; filtering by actor or outcome reaches further
                back into those.</>
            )}
          </div>
        </div>
      )}
      {err && (
        <div className="px-4 py-1.5 text-[11px] text-red-300 bg-red-950/30 border-b border-red-900/50">
          {err}
        </div>
      )}

      <div className="flex-1 overflow-y-auto nice-scroll">
        {!data ? (
          <div className="px-5 py-4"><CardsSkeleton n={3} /></div>
        ) : rows.length === 0 ? (
          <div className="px-5 py-10 text-center text-sm text-stone-500">
            {/* A paged-back view can empty out under a live filter change.
                "Nothing was refused" would be a lie about the window rather
                than about this page, so the way back is offered first. */}
            {hasNewer ? (
              <>This page is past the end of what matched — {data.matched} row(s)
                in the last {win}.<br />
                <button onClick={() => setOffset(0)}
                  className="text-teal-400 hover:underline mt-1">
                  Back to the newest
                </button></>
            ) : outcome === 'problems' ? (
              <>Nothing was refused or failed in the last {win}.<br />
                <button onClick={() => setOutcome(null)}
                  className="text-teal-400 hover:underline mt-1">
                  Show everything she did
                </button></>
            ) : (
              <>No recorded activity in the last {win}.</>
            )}
          </div>
        ) : (
          <>
            {grouped.map(g => (
              <div key={g.day}>
                <div className="sticky top-0 z-10 px-4 py-1 bg-stone-900/95 backdrop-blur border-b border-stone-800 text-[10px] uppercase tracking-wide text-stone-500">
                  {g.day}
                </div>
                {g.rows.map(r => <Row key={r.id} row={r} onTrace={setInspect} />)}
              </div>
            ))}
            {/* The way to the rows the page is not showing. Without it the
                banner above stated a shortfall the operator could do nothing
                about — and before the banner was honest, the list simply
                stopped and looked like the end of the window. */}
            {(hasOlder || hasNewer) && (
              <div className="px-4 py-3 flex items-center justify-center gap-3 text-[11px]">
                <button
                  disabled={!hasNewer}
                  onClick={() => setOffset(o => Math.max(0, o - PAGE))}
                  className="px-2 py-1 rounded border border-stone-700 text-stone-400 hover:border-teal-700 hover:text-teal-300 disabled:opacity-30 disabled:hover:border-stone-700 disabled:hover:text-stone-400"
                >← newer</button>
                <span className="text-stone-600 tabular-nums">
                  {from}–{to} of {data?.matched ?? 0}
                </span>
                <button
                  disabled={!hasOlder}
                  onClick={() => setOffset(o => o + PAGE)}
                  className="px-2 py-1 rounded border border-stone-700 text-stone-400 hover:border-teal-700 hover:text-teal-300 disabled:opacity-30 disabled:hover:border-stone-700 disabled:hover:text-stone-400"
                >older →</button>
              </div>
            )}
          </>
        )}
      </div>

      <div className="px-4 py-2 border-t border-stone-800 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-stone-500">
        {/* Whole-window totals, not a tally of the rows above — they used to
            be the latter, and reported 4 refusals in a week that had 15. */}
        <span className="text-stone-600">last {data?.window ?? win}:</span>
        {Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, n]) => (
          <span key={k} className="inline-flex items-center gap-1">
            <span className={`w-1.5 h-1.5 rounded-full ${tone(k).dot}`} />
            <span className="tabular-nums text-stone-400">{n}</span> {tone(k).word || k}
          </span>
        ))}
        {data && !data.counts_complete && (
          <span className="text-amber-400/90">
            at least — {(data.unreadable_sources ?? []).join(', ') || 'a source'} could
            not be counted
          </span>
        )}
        <button
          onClick={() => navigate('/activity/ingest')}
          className="ml-auto text-stone-500 hover:text-teal-300"
          title="The media ingest queue, where retry and dismiss live"
        >Ingestion queue →</button>
      </div>

      {inspect && (
        <TurnInspector traceId={inspect} onClose={() => setInspect(null)} />
      )}
    </Surface>
  );
}
