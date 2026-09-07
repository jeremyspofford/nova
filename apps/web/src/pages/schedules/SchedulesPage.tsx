import { useCallback, useEffect, useRef, useState } from 'react'
import { CalendarClock, ChevronDown, ChevronRight, Pause, Play, RefreshCw, Trash2, Zap } from 'lucide-react'
import clsx from 'clsx'
import { PageHeader } from '../../components/layout/PageHeader'
import { Badge, Button, ConfirmDialog, EmptyState, Skeleton } from '../../components/ui'
import {
  deleteTimer as apiDeleteTimer,
  fireTimer as apiFireTimer,
  listTimerFirings as apiListTimerFirings,
  listTimers as apiListTimers,
  pauseTimer as apiPauseTimer,
  resumeTimer as apiResumeTimer,
  TIMERS_PAGE_SIZE,
  type Timer,
  type TimerFiring,
} from '../../lib/api'
import { formatMs, formatRelativeTime } from '../activity/activityFormat'
import {
  deliveryLines,
  firingDurationMs,
  firingStatusBadge,
  formatAbsolute,
  formatNextFire,
  kindBadge,
  lastOutcome,
  payloadSummary,
  timerState,
} from './schedulesFormat'

/**
 * Schedules (S9): every timer this person owns plus every system job, with
 * what will fire, when (the browser's local time), and what each firing
 * actually did — read straight off timers / timer_firings via
 * services/core/app/timers_api.py. Everything here is only ever what the API
 * returned: a timer that has never fired shows an em dash, never "ok"; a
 * device that was offline is listed as offline, per channel, from that
 * channel's own result; the words for a schedule are core's `describe()`
 * (`schedule_words`), the SAME words her chat confirmation used, so the two
 * cannot disagree — this page never recomputes a recurrence.
 *
 * Creation stays conversational in S9 ("remind me in two minutes…" in chat);
 * the page pauses, resumes, runs now and deletes. "Run now" is not a request
 * — core sets next_fire_at = now() and runs one scheduler tick inline, so what
 * comes back is the firing row that tick produced, and the list is re-read
 * after it. Nothing here asks anyone for approval (owner ruling 2026-09-03):
 * every control does the thing and shows core's stated result or its stated
 * refusal.
 *
 * A job row (`kind: 'job'`, created_via 'system') gets Pause/Resume/Run now
 * but no Delete: `timers.ensure_jobs` re-seeds any missing JOBS row at core
 * startup, so a deleted job would come back on the next restart — a Delete
 * that only lasts until then is a lie, and Pause is the control that means
 * what it says.
 *
 * Pagination mirrors ActivityPage's: "load more" pages strictly older than
 * the last row's id (the server's cursor), and a page shorter than the page
 * size means there is nothing further. A light poll (default 15 s) re-reads
 * the first page and the expanded row's firings while mounted, so a fired
 * reminder's outcome, or a paused timer's next fire passing WITHOUT a firing
 * row appearing, is seen with no operator action.
 *
 * `api` is the same dependency-injection seam ActivityPage uses; `pageSize`
 * and `pollMs` are exposed so a test can drive both without 50 fake rows or
 * waiting seconds.
 */
interface SchedulesApi {
  listTimers: typeof apiListTimers
  listTimerFirings: typeof apiListTimerFirings
  pauseTimer: typeof apiPauseTimer
  resumeTimer: typeof apiResumeTimer
  fireTimer: typeof apiFireTimer
  deleteTimer: typeof apiDeleteTimer
}

const DEFAULT_API: SchedulesApi = {
  listTimers: apiListTimers,
  listTimerFirings: apiListTimerFirings,
  pauseTimer: apiPauseTimer,
  resumeTimer: apiResumeTimer,
  fireTimer: apiFireTimer,
  deleteTimer: apiDeleteTimer,
}

const POLL_INTERVAL_MS = 15_000

/** What the row will say it was paused for when the owner pauses it here —
 * core records a reason either way (paused_reason is NOT NULL with paused_at). */
const PAUSED_FROM_PAGE = 'paused from the Schedules page'

type FiringsState =
  | { status: 'loading' }
  | { status: 'error'; reason: string }
  | {
      status: 'ready'
      firings: TimerFiring[]
      exhausted: boolean
      loadingMore: boolean
      /** The poll's last re-read of these firings failed: the history shown
       * is what was last known, and this is why it may be behind. Cleared by
       * the next read that succeeds. */
      staleReason?: string
    }

type RowAction = 'pause' | 'resume' | 'fire' | 'delete'

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function SchedulesPage({
  api = DEFAULT_API,
  pageSize = TIMERS_PAGE_SIZE,
  pollMs = POLL_INTERVAL_MS,
}: {
  api?: SchedulesApi
  /** Exposed so a test can exercise the "maybe more" boundary without 50
   * fake rows; production always uses the real page size. */
  pageSize?: number
  pollMs?: number
} = {}) {
  const [timers, setTimers] = useState<Timer[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [exhausted, setExhausted] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [firings, setFirings] = useState<Record<string, FiringsState>>({})
  // Per-row: which action is in flight, its stated failure, and the last
  // "Run now" result — the firing row core answered with, in its own words.
  const [busy, setBusy] = useState<Record<string, RowAction>>({})
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})
  const [ranNow, setRanNow] = useState<Record<string, TimerFiring>>({})
  const [pendingDelete, setPendingDelete] = useState<Timer | null>(null)
  // The list as currently shown, readable inside async callbacks without
  // re-subscribing them — the same idiom as ChatPage's streamingRef.
  const timersRef = useRef(timers)
  timersRef.current = timers
  // Which ids a firings fetch has actually SETTLED for — Activity's idiom
  // (see ActivityPage's settledRef): marked only when a result was committed,
  // never when a fetch merely started, so a row collapsed mid-fetch retries
  // on re-expand instead of hanging on the Skeleton forever.
  const settledRef = useRef<Set<string>>(new Set())

  /** A fresh first page folded into what is shown: the first page is
   * replaced; rows the operator paged in beyond it are kept (a row that moved
   * into the first page is not shown twice). `exhausted` moves only when the
   * list was a single page — a paged list's boundary belongs to its last page. */
  const applyFirstPage = useCallback(
    (fresh: Timer[]) => {
      const prev = timersRef.current
      if (prev === null || prev.length <= pageSize) {
        setExhausted(fresh.length < pageSize)
        setTimers(fresh)
        return
      }
      const freshIds = new Set(fresh.map(t => t.id))
      const beyond = prev.slice(pageSize).filter(t => !freshIds.has(t.id))
      setTimers([...fresh, ...beyond])
    },
    [pageSize],
  )

  const refresh = useCallback(async () => {
    try {
      applyFirstPage(await api.listTimers({ limit: pageSize }))
      setError(null)
    } catch (err) {
      setError(reasonOf(err))
    }
  }, [api, pageSize, applyFirstPage])

  useEffect(() => {
    let live = true
    setError(null)
    api
      .listTimers({ limit: pageSize })
      .then(rows => {
        if (!live) return
        setTimers(rows)
        setExhausted(rows.length < pageSize)
      })
      .catch(err => {
        if (live) setError(reasonOf(err))
      })
    return () => {
      live = false
    }
  }, [api, pageSize])

  // The light poll: the first page, and the expanded row's firings. A poll
  // failure keeps the last known list rather than wiping it — a transient
  // blip is not "no schedules" — but is not hidden either: the banner states
  // it until a read succeeds again.
  useEffect(() => {
    let live = true
    const id = setInterval(() => {
      api
        .listTimers({ limit: pageSize })
        .then(rows => {
          if (!live) return
          applyFirstPage(rows)
          setError(null)
        })
        .catch(err => {
          if (live) setError(reasonOf(err))
        })
      if (expandedId !== null) {
        const timerId = expandedId
        api
          .listTimerFirings(timerId, { limit: pageSize })
          .then(rows => {
            if (!live) return
            settledRef.current.add(timerId)
            setFirings(prev => {
              const current = prev[timerId]
              // Only a first page is re-read; anything paged in beyond it is kept.
              const beyond =
                current?.status === 'ready' ? current.firings.slice(pageSize) : []
              const ids = new Set(rows.map(f => f.id))
              return {
                ...prev,
                [timerId]: {
                  status: 'ready',
                  firings: [...rows, ...beyond.filter(f => !ids.has(f.id))],
                  exhausted:
                    current?.status === 'ready' && current.firings.length > pageSize
                      ? current.exhausted
                      : rows.length < pageSize,
                  loadingMore: false,
                },
              }
            })
          })
          .catch(err => {
            // The history shown stays (a blip is not "no firings"), but the
            // row says its history may be behind and why — a row deleted
            // elsewhere reads as a 404 here, not as a list that quietly stops.
            if (!live) return
            setFirings(prev => {
              const current = prev[timerId]
              return current?.status === 'ready'
                ? { ...prev, [timerId]: { ...current, staleReason: reasonOf(err) } }
                : prev
            })
          })
      }
    }, pollMs)
    return () => {
      live = false
      clearInterval(id)
    }
  }, [api, pageSize, pollMs, expandedId, applyFirstPage])

  const loadMore = useCallback(() => {
    if (!timers || timers.length === 0) return
    const before = timers[timers.length - 1].id
    setLoadingMore(true)
    setError(null)
    api
      .listTimers({ limit: pageSize, before })
      .then(next => {
        setTimers(prev => [...(prev ?? []), ...next])
        setExhausted(next.length < pageSize)
      })
      .catch(err => setError(reasonOf(err)))
      .finally(() => setLoadingMore(false))
  }, [api, timers, pageSize])

  // A timer's firings are fetched once per id that actually SETTLES.
  useEffect(() => {
    if (expandedId === null || settledRef.current.has(expandedId)) return
    const id = expandedId
    let live = true
    setFirings(prev => ({ ...prev, [id]: { status: 'loading' } }))
    api
      .listTimerFirings(id, { limit: pageSize })
      .then(rows => {
        if (live) {
          settledRef.current.add(id)
          setFirings(prev => ({
            ...prev,
            [id]: {
              status: 'ready',
              firings: rows,
              exhausted: rows.length < pageSize,
              loadingMore: false,
            },
          }))
        }
      })
      .catch(err => {
        if (live) {
          settledRef.current.add(id)
          setFirings(prev => ({ ...prev, [id]: { status: 'error', reason: reasonOf(err) } }))
        }
      })
    return () => {
      live = false
    }
  }, [api, expandedId, pageSize])

  const loadMoreFirings = useCallback(
    (timerId: string) => {
      const current = firings[timerId]
      if (current?.status !== 'ready' || current.firings.length === 0) return
      const before = current.firings[current.firings.length - 1].id
      setFirings(prev => {
        const row = prev[timerId]
        return row?.status === 'ready' ? { ...prev, [timerId]: { ...row, loadingMore: true } } : prev
      })
      api
        .listTimerFirings(timerId, { limit: pageSize, before })
        .then(next => {
          setFirings(prev => {
            const row = prev[timerId]
            if (row?.status !== 'ready') return prev
            return {
              ...prev,
              [timerId]: {
                status: 'ready',
                firings: [...row.firings, ...next],
                exhausted: next.length < pageSize,
                loadingMore: false,
              },
            }
          })
        })
        .catch(err => {
          setFirings(prev => ({ ...prev, [timerId]: { status: 'error', reason: reasonOf(err) } }))
        })
    },
    [api, firings, pageSize],
  )

  const toggle = useCallback((id: string) => {
    setExpandedId(prev => (prev === id ? null : id))
  }, [])

  const replaceRow = useCallback((updated: Timer) => {
    setTimers(prev => (prev ? prev.map(t => (t.id === updated.id ? updated : t)) : prev))
  }, [])

  /** Run one row action: mark it busy, do it, keep core's stated failure on
   * the row if it refused. Never a success that was not checked — each
   * action's effect on screen is core's own answer (the row it returned, the
   * firing it returned, or the list re-read after a delete). */
  const runAction = useCallback(
    async (timer: Timer, action: RowAction, run: () => Promise<void>) => {
      setBusy(prev => ({ ...prev, [timer.id]: action }))
      setRowErrors(prev => {
        const next = { ...prev }
        delete next[timer.id]
        return next
      })
      try {
        await run()
      } catch (err) {
        setRowErrors(prev => ({ ...prev, [timer.id]: `Could not ${action}: ${reasonOf(err)}` }))
      } finally {
        setBusy(prev => {
          const next = { ...prev }
          delete next[timer.id]
          return next
        })
      }
    },
    [],
  )

  const pause = useCallback(
    (timer: Timer) =>
      runAction(timer, 'pause', async () => replaceRow(await api.pauseTimer(timer.id, PAUSED_FROM_PAGE))),
    [api, replaceRow, runAction],
  )

  const resume = useCallback(
    (timer: Timer) =>
      runAction(timer, 'resume', async () => replaceRow(await api.resumeTimer(timer.id))),
    [api, replaceRow, runAction],
  )

  const fire = useCallback(
    (timer: Timer) =>
      runAction(timer, 'fire', async () => {
        const firing = await api.fireTimer(timer.id)
        setRanNow(prev => ({ ...prev, [timer.id]: firing }))
        // The tick ran inline: the row's next fire and last outcome have
        // moved, and the expanded history has a new entry. Re-read both.
        await refresh()
        if (expandedId === timer.id) {
          settledRef.current.delete(timer.id)
          const rows = await api.listTimerFirings(timer.id, { limit: pageSize })
          settledRef.current.add(timer.id)
          setFirings(prev => ({
            ...prev,
            [timer.id]: {
              status: 'ready',
              firings: rows,
              exhausted: rows.length < pageSize,
              loadingMore: false,
            },
          }))
        }
      }),
    [api, expandedId, pageSize, refresh, runAction],
  )

  const remove = useCallback(
    (timer: Timer) => {
      setPendingDelete(null)
      return runAction(timer, 'delete', async () => {
        await api.deleteTimer(timer.id)
        setTimers(prev => (prev ? prev.filter(t => t.id !== timer.id) : prev))
        setExpandedId(prev => (prev === timer.id ? null : prev))
      })
    },
    [api, runAction],
  )

  return (
    <div>
      <PageHeader
        title="Schedules"
        description="Reminders, scheduled turns and housekeeping jobs — what will fire, when, and what each firing actually did."
        actions={
          <Button size="sm" variant="ghost" icon={<RefreshCw size={12} />} onClick={() => void refresh()}>
            Refresh
          </Button>
        }
      />

      {error && (
        <div
          role="alert"
          className="mb-6 rounded-sm border border-danger/30 bg-danger-dim px-4 py-3 text-compact text-danger"
        >
          Could not load schedules: {error}
        </div>
      )}

      {timers === null ? (
        !error && (
          <div data-testid="schedules-skeleton">
            <Skeleton lines={6} />
          </div>
        )
      ) : timers.length === 0 ? (
        <EmptyState
          icon={CalendarClock}
          title="No schedules yet"
          description="Ask in chat — “remind me in twenty minutes to stretch”, or “every day at 7, tell me what is on my calendar” — and the timer appears here."
        />
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border border-border glass-card dark:border-white/[0.08]">
            <table className="w-full text-compact">
              <thead>
                <tr className="bg-surface-elevated">
                  {['Kind', 'Schedule', 'Next fire', 'Status', 'Last outcome', ''].map((heading, i) => (
                    <th
                      key={i}
                      className="px-4 py-3 text-left text-caption font-medium text-content-tertiary uppercase tracking-wider sticky top-0 bg-surface-elevated"
                    >
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {timers.map(timer => (
                  <ScheduleRow
                    key={timer.id}
                    timer={timer}
                    expanded={expandedId === timer.id}
                    firings={firings[timer.id]}
                    busy={busy[timer.id]}
                    rowError={rowErrors[timer.id]}
                    ranNow={ranNow[timer.id]}
                    onToggle={() => toggle(timer.id)}
                    onPause={() => void pause(timer)}
                    onResume={() => void resume(timer)}
                    onFire={() => void fire(timer)}
                    onDelete={() => setPendingDelete(timer)}
                    onLoadMoreFirings={() => loadMoreFirings(timer.id)}
                  />
                ))}
              </tbody>
            </table>
          </div>

          {!exhausted && (
            <div className="flex justify-center mt-4">
              <Button variant="secondary" size="sm" loading={loadingMore} onClick={loadMore}>
                Load more
              </Button>
            </div>
          )}
        </>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        title={`Delete “${pendingDelete?.title ?? ''}”?`}
        description="The timer and its firing history are removed. Nothing it already delivered is touched."
        confirmLabel="Delete schedule"
        destructive
        onConfirm={() => pendingDelete && void remove(pendingDelete)}
      />
    </div>
  )
}

function ScheduleRow({
  timer,
  expanded,
  firings,
  busy,
  rowError,
  ranNow,
  onToggle,
  onPause,
  onResume,
  onFire,
  onDelete,
  onLoadMoreFirings,
}: {
  timer: Timer
  expanded: boolean
  firings: FiringsState | undefined
  busy: RowAction | undefined
  rowError: string | undefined
  ranNow: TimerFiring | undefined
  onToggle: () => void
  onPause: () => void
  onResume: () => void
  onFire: () => void
  onDelete: () => void
  onLoadMoreFirings: () => void
}) {
  const kind = kindBadge(timer.kind)
  const state = timerState(timer)
  const next = timer.next_fire_at === null ? null : formatNextFire(timer.next_fire_at)
  const outcome = lastOutcome(timer.last_firing)
  const summary = payloadSummary(timer)

  return (
    <>
      <tr
        data-testid={`schedules-row-${timer.id}`}
        onClick={onToggle}
        className="cursor-pointer hover:bg-surface-card-hover transition-colors align-top"
      >
        <td className="px-4 py-2.5 whitespace-nowrap">
          <span className="inline-flex items-center gap-1.5">
            {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
            <Badge size="sm" color={kind.color}>
              {kind.label}
            </Badge>
          </span>
        </td>
        <td className="px-4 py-2.5 min-w-[220px]">
          <div className="text-content-primary font-medium">{timer.title}</div>
          {/* core's describe() words, verbatim — never recomputed here. */}
          <div className="text-caption text-content-tertiary" data-testid="schedule-words">
            {timer.schedule_words}
          </div>
        </td>
        <td className="px-4 py-2.5 whitespace-nowrap">
          {state.state === 'paused' ? (
            <span className="text-content-tertiary" title={timer.paused_reason ?? undefined}>
              paused
            </span>
          ) : next === null ? (
            <span className="text-content-tertiary">—</span>
          ) : (
            <span title={next.absolute}>
              <span className="text-content-primary">{next.relative}</span>
              <span className="block text-micro text-content-tertiary">{next.absolute}</span>
            </span>
          )}
        </td>
        <td className="px-4 py-2.5 whitespace-nowrap">
          <Badge size="sm" color={state.color}>
            {state.label}
          </Badge>
          {timer.consecutive_failures > 0 && (
            <span className="ml-2 text-micro text-danger" data-testid="consecutive-failures">
              {timer.consecutive_failures} failure{timer.consecutive_failures === 1 ? '' : 's'} in a row
            </span>
          )}
        </td>
        <td className="px-4 py-2.5 whitespace-nowrap">
          {outcome === null ? (
            <span className="text-content-tertiary" title="never fired">
              —
            </span>
          ) : (
            <span className="inline-flex items-center gap-2" title={outcome.detail ?? undefined}>
              <Badge size="sm" color={outcome.color} className={outcome.pulse ? 'animate-pulse' : undefined}>
                {outcome.label}
              </Badge>
              {timer.last_firing?.ended_at && (
                <span className="text-micro text-content-tertiary">
                  {formatRelativeTime(timer.last_firing.ended_at)}
                </span>
              )}
            </span>
          )}
        </td>
        {/* Actions never toggle the row. */}
        <td className="px-4 py-2.5 whitespace-nowrap text-right" onClick={e => e.stopPropagation()}>
          <span className="inline-flex items-center gap-1.5">
            {state.state === 'paused' ? (
              <Button
                size="sm"
                variant="secondary"
                icon={<Play size={12} />}
                loading={busy === 'resume'}
                disabled={busy !== undefined}
                onClick={onResume}
              >
                Resume
              </Button>
            ) : (
              <Button
                size="sm"
                variant="secondary"
                icon={<Pause size={12} />}
                loading={busy === 'pause'}
                disabled={busy !== undefined || state.state === 'finished'}
                onClick={onPause}
              >
                Pause
              </Button>
            )}
            <Button
              size="sm"
              variant="secondary"
              icon={<Zap size={12} />}
              loading={busy === 'fire'}
              // A paused row cannot be run: the claim never picks a paused row
              // up, so core refuses fire_now outright (409). Stating that up
              // front mirrors the server's fact — it is not a gate.
              disabled={busy !== undefined || state.state === 'paused'}
              onClick={onFire}
              title={
                state.state === 'paused'
                  ? 'Paused — resume it to run it'
                  : 'Set the next fire to now and run one scheduler tick — the firing goes through the same claim and history as a scheduled one'
              }
            >
              Run now
            </Button>
            {timer.kind !== 'job' && (
              <Button
                size="sm"
                variant="ghost"
                icon={<Trash2 size={12} />}
                loading={busy === 'delete'}
                disabled={busy !== undefined}
                onClick={onDelete}
              >
                Delete
              </Button>
            )}
          </span>
        </td>
      </tr>
      {(rowError || ranNow) && (
        <tr className="bg-surface-elevated/40" data-testid={`schedules-note-${timer.id}`}>
          <td colSpan={6} className="px-6 py-2 text-caption">
            {rowError && <p className="text-danger">{rowError}</p>}
            {ranNow && <RanNowLine firing={ranNow} />}
          </td>
        </tr>
      )}
      {expanded && (
        <tr data-testid={`schedules-detail-${timer.id}`} className="bg-surface-elevated/40">
          <td colSpan={6} className="px-6 py-4">
            <div className="space-y-4">
              <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-caption">
                <dt className="text-content-tertiary">Schedule</dt>
                <dd className="text-content-secondary">
                  {timer.schedule_words}
                  <span className="text-content-tertiary"> · {timer.timezone}</span>
                </dd>
                {summary && (
                  <>
                    <dt className="text-content-tertiary">
                      {timer.kind === 'reminder' ? 'Reminder' : timer.kind === 'scheduled' ? 'Instruction' : 'Job'}
                    </dt>
                    <dd className="text-content-secondary break-words">{summary}</dd>
                  </>
                )}
                <dt className="text-content-tertiary">Created</dt>
                <dd className="text-content-secondary">
                  via {timer.created_via}, {formatAbsolute(timer.created_at)}
                </dd>
                {timer.paused_at !== null && (
                  <>
                    <dt className="text-content-tertiary">Paused</dt>
                    <dd className="text-warning" data-testid="paused-reason">
                      {timer.paused_reason ?? 'no reason recorded'}
                      <span className="text-content-tertiary"> · {formatAbsolute(timer.paused_at)}</span>
                    </dd>
                  </>
                )}
              </dl>

              <div>
                <h3 className="text-caption font-medium uppercase tracking-wider text-content-tertiary mb-2">
                  Firings
                </h3>
                {(firings === undefined || firings.status === 'loading') && <Skeleton lines={3} />}
                {firings?.status === 'error' && (
                  <p className="text-compact text-danger">Could not load firings: {firings.reason}</p>
                )}
                {firings?.status === 'ready' && firings.staleReason !== undefined && (
                  <p className="text-caption text-warning" data-testid="firings-stale">
                    Could not refresh firings: {firings.staleReason}
                  </p>
                )}
                {firings?.status === 'ready' &&
                  (firings.firings.length === 0 ? (
                    <p className="text-caption text-content-tertiary italic">No firings yet.</p>
                  ) : (
                    <div className="space-y-3">
                      {firings.firings.map(firing => (
                        <FiringDetail key={firing.id} firing={firing} />
                      ))}
                      {!firings.exhausted && (
                        <Button
                          variant="secondary"
                          size="sm"
                          loading={firings.loadingMore}
                          onClick={onLoadMoreFirings}
                        >
                          Load more firings
                        </Button>
                      )}
                    </div>
                  ))}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

/** The firing "Run now" produced, in core's words — the tick's own result
 * row, never an acknowledgement dressed as success. */
function RanNowLine({ firing }: { firing: TimerFiring }) {
  const badge = firingStatusBadge(firing.status)
  return (
    <p className="inline-flex items-center gap-2 text-content-secondary" data-testid="ran-now">
      Ran now:
      <Badge size="sm" color={badge.color} className={badge.pulse ? 'animate-pulse' : undefined}>
        {badge.label}
      </Badge>
      {firing.reason && <span className="text-danger">{firing.reason}</span>}
    </p>
  )
}

function FiringDetail({ firing }: { firing: TimerFiring }) {
  const badge = firingStatusBadge(firing.status)
  const duration = formatMs(firingDurationMs(firing))
  const lines = deliveryLines(firing.delivery)
  return (
    <div className="space-y-1 text-caption" data-testid={`schedules-firing-${firing.id}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Badge size="sm" color={badge.color} className={badge.pulse ? 'animate-pulse' : undefined}>
          {badge.label}
        </Badge>
        <span className="text-content-secondary">scheduled for {formatAbsolute(firing.scheduled_for)}</span>
        <span className="text-content-tertiary">started {formatRelativeTime(firing.started_at)}</span>
        {duration && <span className="font-mono text-content-tertiary">{duration}</span>}
        {firing.turn_id && (
          <span className="font-mono text-micro text-content-tertiary" title={`turn ${firing.turn_id} — its spans are on the Activity page`}>
            turn {firing.turn_id.slice(0, 8)}
          </span>
        )}
      </div>
      {firing.reason && <p className="text-danger">{firing.reason}</p>}
      {lines.length > 0 && (
        <ul className="space-y-0.5 pl-0.5" data-testid="delivery-lines">
          {lines.map((line, i) => (
            <li
              key={i}
              className={clsx(
                'font-mono text-micro',
                line.verdict === 'ok' && 'text-success',
                line.verdict === 'failed' && 'text-danger',
                line.verdict === 'stated' && 'text-content-tertiary',
              )}
            >
              {line.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
