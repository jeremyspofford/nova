import { ReactNode, useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  getIngestSummary, retryIngestJob, dismissIngestJob, dismissFinishedIngestJobs,
  restoreIngestJob, getDismissedIngestJobs,
  IngestJob, IngestStatus, IngestSummary,
} from '../api';
import { CardsSkeleton, Surface } from './ui';

/** Ingestion activity — the operator's live, per-item view of Nova's durable
 *  background ingest queue (migration 041). Following a source no longer blocks
 *  a chat turn; the work runs in ingest_worker and lands here. This is the
 *  detailed audit trail the turn-ledger couldn't give: what's queued, what's
 *  ingesting now, what finished, and what failed (with a Retry).
 *
 *  Three pieces: useIngestSummary (shared polling — the rail badge and the
 *  dialog both drink from it), IngestionDialog (the /activity route), and
 *  IngestionActivity (the phone toolbar button, which navigates). */

const POLL_IDLE_MS = 8000;
const POLL_OPEN_MS = 2500;

const STATUS_DOT: Record<IngestStatus, string> = {
  running: 'bg-teal-400',
  queued: 'bg-stone-500',
  failed: 'bg-red-400',
  skipped: 'bg-stone-600',
  done: 'bg-emerald-400',
};

const STATUS_LABEL: Record<IngestStatus, string> = {
  running: 'ingesting', queued: 'queued', failed: 'failed',
  skipped: 'skipped', done: 'ingested',
};

// running/queued pinned to the top (live work), then failures needing
// attention, then the finished trail — newest-first within each (backend order).
const STATUS_RANK: Record<IngestStatus, number> = {
  running: 0, queued: 1, failed: 2, skipped: 3, done: 4,
};

/** What can be cleared off the page. The backend enforces the same set in the
 *  WHERE clause of ingest_jobs.dismiss — this only decides whether to draw the
 *  button. Live work (queued/running) is never dismissable: hiding a job that
 *  is still going to change state is how a queue silently stops. */
const TERMINAL: IngestStatus[] = ['done', 'failed', 'skipped'];
const isTerminal = (s: IngestStatus) => TERMINAL.includes(s);

function ago(iso: string | null): string {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function useIngestSummary(fast: boolean) {
  const [summary, setSummary] = useState<IngestSummary | null>(null);

  const reload = useCallback(async () => {
    try {
      setSummary(await getIngestSummary());
    } catch {
      /* endpoint missing / offline — stay quiet, try again next tick */
    }
  }, []);

  useEffect(() => {
    reload();
    const id = setInterval(reload, fast ? POLL_OPEN_MS : POLL_IDLE_MS);
    return () => clearInterval(id);
  }, [reload, fast]);

  return { summary, reload };
}

/** One row, shared by the live list and the cleared drawer. `actions` is what
 *  differs between them — Retry/Clear on the page, Restore in the drawer. */
function JobRow({ job, dimmed, actions }: {
  job: IngestJob; dimmed?: boolean; actions: ReactNode;
}) {
  const navigate = useNavigate();
  return (
    <div className={`px-3 py-2 rounded-lg hover:bg-stone-800/40 flex items-start gap-2.5 group ${dimmed ? 'opacity-55' : ''}`}>
      <span className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${STATUS_DOT[job.status]} ${job.status === 'running' ? 'animate-pulse' : ''}`} />
      <div className="min-w-0 flex-1">
        {job.result_item_id ? (
          <button
            onClick={() => navigate('/', { state: { openItem: job.result_item_id } })}
            className="block w-full text-left text-sm text-teal-300 hover:text-teal-200 hover:underline truncate"
            title={`Open note: ${job.title ?? job.url}`}
          >
            {job.title ?? job.url}
          </button>
        ) : (
          <div className="text-sm text-stone-200 truncate" title={job.title ?? job.url}>
            {job.title ?? job.url}
          </div>
        )}
        <div className="text-xs text-stone-500 flex flex-wrap items-center gap-x-2">
          <span className={job.status === 'failed' ? 'text-red-400' : job.status === 'running' ? 'text-teal-400' : ''}>
            {STATUS_LABEL[job.status]}
          </span>
          {job.enqueued_by && <span>· via {job.enqueued_by}</span>}
          {job.attempts > 1 && <span>· attempt {job.attempts}</span>}
          {(job.orphans ?? 0) > 0 && <span>· interrupted {job.orphans}×</span>}
          <span>· {ago(job.finished_at ?? job.started_at ?? job.enqueued_at)}</span>
        </div>
        {job.status === 'failed' && job.error && (
          <div className="text-xs text-red-400/80 mt-0.5 line-clamp-2">{job.error}</div>
        )}
      </div>
      <div className="shrink-0 flex items-center gap-1.5">{actions}</div>
    </div>
  );
}

/** The /activity page: Nova's background work, front and center — the
 *  ingest queue now; automation runs and other background trails can join
 *  as sections later. */
export function ActivityPage({ onClose }: { onClose: () => void }) {
  const { summary, reload } = useIngestSummary(true);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  // Optimistic hide. The 2.5s poll would get there on its own, but a row that
  // lingers after you click × reads as "the button didn't work" and invites a
  // second click on a job that is already gone.
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [showCleared, setShowCleared] = useState(false);
  const [cleared, setCleared] = useState<IngestJob[] | null>(null);

  const counts = summary?.counts ?? {};

  const mark = (id: string, on: boolean) =>
    setBusy(s => {
      const n = new Set(s);
      if (on) n.add(id); else n.delete(id);
      return n;
    });

  const loadCleared = useCallback(async () => {
    try { setCleared(await getDismissedIngestJobs()); }
    catch { setCleared([]); }
  }, []);

  // keep the drawer honest while it's open — dismissing on the page above
  // should land here, not wait for a reopen
  useEffect(() => {
    if (showCleared) loadCleared();
  }, [showCleared, loadCleared, summary?.dismissed]);

  // `hidden` covers the gap between the click and the server agreeing, and
  // NOTHING MORE. Once the reload comes back without a row, the server has
  // taken over and the id must go — it is subtracted from finishedCount below,
  // and an id left in here after the server already dropped it is counted
  // against the total twice, forever. That is not cosmetic: after clearing
  // everything once, `counts - hidden.size` stays pinned at 0 and the "Clear
  // finished" button never comes back for newly finished work until the
  // overlay is unmounted. Same-reference return when nothing changed, or this
  // effect re-renders itself.
  useEffect(() => {
    if (!summary) return;
    const live = new Set(summary.jobs.map(j => j.id));
    setHidden(h => {
      const kept = [...h].filter(id => live.has(id));
      return kept.length === h.size ? h : new Set(kept);
    });
  }, [summary]);

  const retry = async (job: IngestJob) => {
    mark(job.id, true);
    try {
      await retryIngestJob(job.id);
      setHidden(s => { const n = new Set(s); n.delete(job.id); return n; });
      await reload();
    } catch { /* leave it failed; the row still shows the error */ }
    finally { mark(job.id, false); }
  };

  const dismiss = async (job: IngestJob) => {
    mark(job.id, true);
    setHidden(s => new Set(s).add(job.id));
    try {
      await dismissIngestJob(job.id);
      await reload();
    } catch {
      setHidden(s => { const n = new Set(s); n.delete(job.id); return n; });
    } finally { mark(job.id, false); }
  };

  const restore = async (job: IngestJob) => {
    mark(job.id, true);
    try {
      await restoreIngestJob(job.id);
      setHidden(s => { const n = new Set(s); n.delete(job.id); return n; });
      setCleared(c => (c ?? []).filter(j => j.id !== job.id));
      await reload();
    } catch { /* the drawer reloads on the next poll tick */ }
    finally { mark(job.id, false); }
  };

  const clearFinished = async () => {
    mark('*', true);
    setHidden(new Set((summary?.jobs ?? []).filter(j => isTerminal(j.status)).map(j => j.id)));
    try {
      await dismissFinishedIngestJobs();
      await reload();
    } catch { setHidden(new Set()); }
    finally { mark('*', false); }
  };

  const jobs = [...(summary?.jobs ?? [])]
    .filter(j => !hidden.has(j.id))
    .sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status]);
  // From the COUNTS, not from `jobs` — the job list is capped at the 60 most
  // recent, and dismiss_finished() clears every finished row there is. Counting
  // the visible ones would promise 60 and quietly clear 300. Subtracting
  // `hidden` keeps it honest inside the optimistic window; the effect above is
  // what keeps that subtraction from outliving the window.
  const finishedCount = Math.max(
    0, TERMINAL.reduce((n, s) => n + (counts[s] ?? 0), 0) - hidden.size);
  const dismissedCount = summary?.dismissed ?? 0;

  return (
    <Surface
      title="Activity"
      width="w-[42rem]"
      onBack={onClose}
      /* the job list scrolls inside; the status bar and the cleared drawer
         sit above and below it */
      bodyClass="flex flex-col"
      header={
        <header className="px-5 py-3.5 border-b border-stone-700 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-stone-100 font-semibold leading-snug">Activity</h2>
            <p className="text-xs text-stone-500 mt-0.5">
              Nova's background learning queue — follows and ingests run here, off the chat.
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-stone-500 hover:text-stone-200 text-lg leading-none px-1 shrink-0"
            aria-label="Close"
          >×</button>
        </header>
      }
    >

        {/* no-zeros rule: skeleton until the first summary lands — "idle"
            is a loaded state, not a loading one */}
        {summary === null ? (
          <div className="px-5 py-4"><CardsSkeleton n={2} /></div>
        ) : (
        <>
        <div className="px-5 py-2.5 border-b border-stone-800 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          {(['running', 'queued', 'failed', 'skipped', 'done'] as IngestStatus[])
            .filter(s => (counts[s] ?? 0) > 0)
            .map(s => (
              <span key={s} className="inline-flex items-center gap-1.5 text-stone-400">
                <span className={`w-2 h-2 rounded-full ${STATUS_DOT[s]} ${s === 'running' ? 'animate-pulse' : ''}`} />
                <span className="tabular-nums text-stone-300">{counts[s]}</span> {STATUS_LABEL[s]}
              </span>
            ))}
          {Object.keys(counts).length === 0 && (
            <span className="text-stone-500">idle</span>
          )}
          {finishedCount > 0 && (
            <button
              onClick={clearFinished}
              disabled={busy.has('*')}
              className="ml-auto text-stone-400 hover:text-teal-300 disabled:opacity-50"
              title="Hide every finished row (done, failed and skipped). Queued and running work stays."
            >
              {busy.has('*') ? '…' : `Clear finished (${finishedCount})`}
            </button>
          )}
        </div>

        <div className="flex-1 overflow-y-auto nice-scroll px-2 py-2">
          {jobs.length === 0 ? (
            <div className="px-3 py-8 text-center text-sm text-stone-500">
              {dismissedCount > 0 ? (
                <>Nothing outstanding — the trail is cleared.</>
              ) : (
                <>
                  No ingestion activity yet.<br />
                  Ask Nova to follow a channel or ingest a video, and progress shows here.
                </>
              )}
            </div>
          ) : jobs.map(job => (
            <JobRow
              key={job.id}
              job={job}
              actions={<>
                {(job.status === 'failed' || job.status === 'skipped') && (
                  <button
                    onClick={() => retry(job)}
                    disabled={busy.has(job.id)}
                    className="text-xs px-2 py-0.5 rounded border border-stone-700 text-stone-300 hover:border-teal-600 hover:text-teal-200 disabled:opacity-50"
                  >
                    {busy.has(job.id) ? '…' : 'Retry'}
                  </button>
                )}
                {isTerminal(job.status) && (
                  <button
                    onClick={() => dismiss(job)}
                    disabled={busy.has(job.id)}
                    className="text-stone-600 hover:text-stone-200 text-base leading-none px-1 opacity-0 group-hover:opacity-100 focus:opacity-100 disabled:opacity-50"
                    title={job.status === 'failed'
                      ? 'Clear this off the page. It stays cleared — the followed-source poll will not queue it again.'
                      : 'Clear this off the page.'}
                    aria-label={`Clear ${job.title ?? job.url}`}
                  >×</button>
                )}
              </>}
            />
          ))}
        </div>

        {/* Cleared is HIDDEN, not deleted, and the operator can see that. It
            matters more than usual here: dismissing a failed item also stops
            the poll re-queueing it, so this drawer is the only way back. */}
        {dismissedCount > 0 && (
          <div className="border-t border-stone-800">
            <button
              onClick={() => setShowCleared(v => !v)}
              className="w-full px-5 py-2 text-left text-xs text-stone-500 hover:text-stone-300 flex items-center gap-1.5"
            >
              <span className={`transition-transform ${showCleared ? 'rotate-90' : ''}`}>›</span>
              {dismissedCount} cleared
              {showCleared && <span className="text-stone-600">— restore puts one back on the list</span>}
            </button>
            {showCleared && (
              <div className="max-h-48 overflow-y-auto nice-scroll px-2 pb-2">
                {cleared === null ? (
                  <div className="px-3 py-2 text-xs text-stone-600">loading…</div>
                ) : cleared.map(job => (
                  <JobRow
                    key={job.id}
                    job={job}
                    dimmed
                    actions={
                      <button
                        onClick={() => restore(job)}
                        disabled={busy.has(job.id)}
                        className="text-xs px-2 py-0.5 rounded border border-stone-700 text-stone-400 hover:border-teal-600 hover:text-teal-200 disabled:opacity-50"
                      >
                        {busy.has(job.id) ? '…' : 'Restore'}
                      </button>
                    }
                  />
                ))}
              </div>
            )}
          </div>
        )}
        </>
        )}
    </Surface>
  );
}
