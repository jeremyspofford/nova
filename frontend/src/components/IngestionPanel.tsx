import { useCallback, useEffect, useRef, useState } from 'react';
import { getIngestSummary, retryIngestJob, IngestJob, IngestStatus, IngestSummary } from '../api';

/** Ingestion activity — the operator's live, per-item view of Nova's durable
 *  background ingest queue (migration 041). Following a source no longer blocks
 *  a chat turn; the work runs in ingest_worker and lands here. This is the
 *  detailed audit trail the turn-ledger couldn't give: what's queued, what's
 *  ingesting now, what finished, and what failed (with a Retry).
 *
 *  Self-contained: it owns the toolbar button AND the panel, and polls on its
 *  own — slowly for the badge, faster while open for live progress. */

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

function ago(iso: string | null): string {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function IngestionActivity() {
  const [summary, setSummary] = useState<IngestSummary | null>(null);
  const [open, setOpen] = useState(false);
  const [retrying, setRetrying] = useState<Set<string>>(new Set());
  const openRef = useRef(open);
  openRef.current = open;

  const load = useCallback(async () => {
    try {
      setSummary(await getIngestSummary());
    } catch {
      /* endpoint missing / offline — stay quiet, try again next tick */
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, open ? POLL_OPEN_MS : POLL_IDLE_MS);
    return () => clearInterval(id);
  }, [load, open]);

  const counts = summary?.counts ?? {};
  const active = (counts.running ?? 0) + (counts.queued ?? 0);
  const failed = counts.failed ?? 0;

  const retry = async (job: IngestJob) => {
    setRetrying(s => new Set(s).add(job.id));
    try {
      await retryIngestJob(job.id);
      await load();
    } catch { /* leave it failed; the row still shows the error */ }
    finally {
      setRetrying(s => { const n = new Set(s); n.delete(job.id); return n; });
    }
  };

  const jobs = [...(summary?.jobs ?? [])].sort(
    (a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status]);

  return (
    <>
      <button
        onClick={() => setOpen(o => !o)}
        className={`relative px-2.5 py-2 rounded-lg bg-stone-900/80 backdrop-blur border text-sm leading-none flex items-center gap-1.5 ${
          open ? 'border-teal-700 text-teal-300'
          : active ? 'border-teal-800 text-teal-300'
          : failed ? 'border-red-900 text-red-300'
          : 'border-stone-700 text-stone-400 hover:text-teal-300'}`}
        title="Ingestion activity — Nova's background learning queue"
        aria-label="Ingestion activity"
      >
        {/* down-into-tray glyph: pulling sources into memory */}
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 3v12" />
          <path d="m7 10 5 5 5-5" />
          <path d="M5 21h14" />
        </svg>
        {active > 0 && (
          <>
            <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-teal-400 animate-ping" />
            <span className="tabular-nums text-xs">{active}</span>
          </>
        )}
        {active === 0 && failed > 0 && (
          <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-red-500" />
        )}
      </button>

      {open && (
        <div
          className="absolute inset-0 z-30 flex items-center justify-center bg-black/50"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-[34rem] max-w-[calc(100vw-1rem)] max-h-[80vh] flex flex-col rounded-xl bg-stone-900/95 backdrop-blur border border-stone-700 shadow-2xl"
            onClick={e => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <header className="px-5 py-3.5 border-b border-stone-700 flex items-start justify-between gap-3">
              <div>
                <h2 className="text-stone-100 font-semibold leading-snug">Ingestion</h2>
                <p className="text-xs text-stone-500 mt-0.5">
                  Nova's background learning queue — follows and ingests run here, off the chat.
                </p>
              </div>
              <button
                onClick={() => setOpen(false)}
                className="text-stone-500 hover:text-stone-200 text-lg leading-none px-1"
                aria-label="Close"
              >×</button>
            </header>

            <div className="px-5 py-2.5 border-b border-stone-800 flex flex-wrap gap-x-4 gap-y-1 text-xs">
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
            </div>

            <div className="flex-1 overflow-y-auto nice-scroll px-2 py-2">
              {jobs.length === 0 ? (
                <div className="px-3 py-8 text-center text-sm text-stone-500">
                  No ingestion activity yet.<br />
                  Ask Nova to follow a channel or ingest a video, and progress shows here.
                </div>
              ) : jobs.map(job => (
                <div key={job.id} className="px-3 py-2 rounded-lg hover:bg-stone-800/40 flex items-start gap-2.5">
                  <span className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${STATUS_DOT[job.status]} ${job.status === 'running' ? 'animate-pulse' : ''}`} />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-stone-200 truncate" title={job.title ?? job.url}>
                      {job.title ?? job.url}
                    </div>
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
                  {(job.status === 'failed' || job.status === 'skipped') && (
                    <button
                      onClick={() => retry(job)}
                      disabled={retrying.has(job.id)}
                      className="shrink-0 text-xs px-2 py-0.5 rounded border border-stone-700 text-stone-300 hover:border-teal-600 hover:text-teal-200 disabled:opacity-50"
                    >
                      {retrying.has(job.id) ? '…' : 'Retry'}
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
