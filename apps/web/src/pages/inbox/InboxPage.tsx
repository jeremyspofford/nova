import { useCallback, useEffect, useRef, useState } from 'react'
import { BellOff, Inbox, Radar } from 'lucide-react'
import clsx from 'clsx'
import { PageHeader } from '../../components/layout/PageHeader'
import { Badge, Button, EmptyState, Skeleton } from '../../components/ui'
import {
  listNotices as apiListNotices,
  markNoticeSeen as apiMarkNoticeSeen,
  muteNotice as apiMuteNotice,
  NOTICES_PAGE_SIZE,
  type Notice,
} from '../../lib/api'
import { useUnseenNotices } from '../../hooks/useUnseenNotices'
import { formatRelativeTime } from '../activity/activityFormat'
import { formatAbsolute } from '../schedules/schedulesFormat'
import {
  actedLine,
  deliveryVerdicts,
  factLines,
  livePill,
  muteWords,
  readWords,
  sightingsWords,
  stateBadge,
} from './inboxFormat'

/**
 * The Inbox (S11): everything she noticed while nobody was watching.
 *
 * One row per notice, straight off GET /api/v1/notices — what a check found,
 * the derived facts the fingerprint was computed from, what she DID about it
 * with the trace that is the account of that claim, when it was first and
 * last seen, how many sightings, whether the condition is still true, and
 * whether he was actually told. Nothing on this page is computed from her
 * words: every fact is core's, rendered as returned.
 *
 * WHAT THIS PAGE IS NOT: an approval queue. Its only two controls are a read
 * receipt (seen) and a noise preference (mute) — neither permits or forbids
 * anything, and there is deliberately no approve, no deny, no dismiss-as-
 * permission (owner ruling 2026-09-03, tests/test_no_approvals.py). She has
 * already acted by the time a row exists; this is where she accounts for it.
 *
 * Both writes re-read the listing rather than patching the row locally, so
 * what is shown is the server's state — a mute the server refused can never
 * look like it took. They also push a fresh read through the shell's unseen
 * count, so the nav badge follows the page instead of waiting for its poll.
 *
 * `api` is the dependency-injection seam every page uses; `pollMs` is exposed
 * so a test can drive the poll without waiting seconds.
 */
interface InboxApi {
  listNotices: typeof apiListNotices
  markNoticeSeen: typeof apiMarkNoticeSeen
  muteNotice: typeof apiMuteNotice
}

const DEFAULT_API: InboxApi = {
  listNotices: apiListNotices,
  markNoticeSeen: apiMarkNoticeSeen,
  muteNotice: apiMuteNotice,
}

/** Never tighter: the watch beat runs hourly, so this is about seeing a
 * notice arrive without a reload, not about being live. */
export const INBOX_POLL_MS = 30_000

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function InboxPage({
  api = DEFAULT_API,
  pollMs = INBOX_POLL_MS,
  pageSize = NOTICES_PAGE_SIZE,
}: {
  api?: InboxApi
  pollMs?: number
  /** How many notices one read asks for. Exposed so a test can reach the
   * "there are older ones" boundary without 50 fake rows. */
  pageSize?: number
} = {}) {
  const [notices, setNotices] = useState<Notice[] | null>(null)
  const [unseenCount, setUnseenCount] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})
  const shell = useUnseenNotices()
  // Whether this page is still on screen. Declared before the effects that
  // read it so a remount sets it back to true first.
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const read = useCallback(async () => {
    try {
      const listing = await api.listNotices({ limit: pageSize })
      if (!mounted.current) return
      setNotices(listing.notices)
      setUnseenCount(listing.unseen_count)
      setError(null)
    } catch (err) {
      // The last known list stays: a failed read is a failed read, never a
      // reason to render an empty inbox as if she had noticed nothing.
      if (mounted.current) setError(reasonOf(err))
    }
  }, [api, pageSize])

  useEffect(() => {
    void read()
    const id = setInterval(() => void read(), pollMs)
    return () => clearInterval(id)
  }, [read, pollMs])

  /** One write, then the server's own answer: the listing is re-read and the
   * shell's badge is refreshed. A refusal is stated on the row it belongs to,
   * in core's words, and the list is left exactly as it was. */
  const write = useCallback(
    async (notice: Notice, action: () => Promise<void>) => {
      setBusyId(notice.id)
      setRowErrors(prev => {
        const next = { ...prev }
        delete next[notice.id]
        return next
      })
      try {
        await action()
        await read()
        shell.refresh()
      } catch (err) {
        if (mounted.current) setRowErrors(prev => ({ ...prev, [notice.id]: reasonOf(err) }))
      } finally {
        if (mounted.current) setBusyId(null)
      }
    },
    [read, shell],
  )

  return (
    <div>
      <PageHeader
        title="Inbox"
        description="What she noticed on her own — what each check found, what she did about it, and whether you were ever told."
      />

      {/* The server's count, over every row — not a count of what this page
          happens to be holding. Left off entirely when there is nothing to
          list, where the empty state already says it. */}
      {unseenCount !== null && notices !== null && notices.length > 0 && (
        <p className="mb-6 text-compact text-content-secondary" data-testid="unseen-count">
          {unseenCount === 0
            ? 'Nothing here is unread.'
            : `${unseenCount} unread — counted by the server, not by this page.`}
        </p>
      )}

      {error && (
        <div
          role="alert"
          className="mb-6 rounded-sm border border-danger/30 bg-danger-dim px-4 py-3 text-compact text-danger"
        >
          Could not load the inbox: {error}
        </div>
      )}

      {notices === null ? (
        !error && (
          <div data-testid="inbox-skeleton">
            <Skeleton lines={4} />
          </div>
        )
      ) : notices.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="Nothing noticed yet"
          description="The watch beat writes here every time a check finds something. An empty inbox means the checks ran and found nothing to tell you."
        />
      ) : (
        <div className="space-y-3" data-testid="inbox-list">
          {notices.map(notice => (
            <NoticeCard
              key={notice.id}
              notice={notice}
              busy={busyId === notice.id}
              rowError={rowErrors[notice.id]}
              onSeen={() => void write(notice, () => api.markNoticeSeen(notice.id))}
              onMute={next => void write(notice, () => api.muteNotice(notice.id, next))}
            />
          ))}
          {/* A full page is probably not the whole record. Saying so beats a
              list that silently stops — the unread count above is over EVERY
              row, so the two numbers would otherwise disagree with no
              explanation. */}
          {notices.length >= pageSize && (
            <p className="pt-1 text-micro text-content-tertiary" data-testid="page-is-full">
              These are the {pageSize} most recently seen notices — older ones are not listed here.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function NoticeCard({
  notice,
  busy,
  rowError,
  onSeen,
  onMute,
}: {
  notice: Notice
  busy: boolean
  rowError: string | undefined
  onSeen: () => void
  onMute: (next: boolean) => void
}) {
  const state = stateBadge(notice.state)
  const live = livePill(notice)
  const acted = actedLine(notice)
  const sightings = sightingsWords(notice.repeats)
  const mute = muteWords(notice)
  const read = readWords(notice)
  const lines = deliveryVerdicts(notice)
  const facts = factLines(notice.facts)

  return (
    <div
      data-testid={`notice-row-${notice.id}`}
      className="rounded-lg border border-border glass-card dark:border-white/[0.08] px-4 py-3"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {notice.urgent && (
              <span data-testid="urgent-badge" title="the check itself declares this urgent — nothing she wrote can promote a finding">
                <Badge size="sm" color="danger">
                  urgent
                </Badge>
              </span>
            )}
            <span className="text-content-primary font-medium">{notice.title}</span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-micro text-content-tertiary">
            <span className="font-mono" title="the check that found it">
              {notice.check_name}
            </span>
            <span data-testid="live-pill" title={live.title}>
              <Badge size="sm" color={live.color}>
                {live.label}
              </Badge>
            </span>
            <span data-testid="state-badge">
              <Badge size="sm" color={state.color}>
                {state.label}
              </Badge>
            </span>
            {sightings && (
              <span data-testid="sightings" title="how many times a check returned these exact facts">
                {sightings}
              </span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            size="sm"
            variant="secondary"
            title={read.title}
            disabled={read.read || busy}
            onClick={onSeen}
          >
            {read.label}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={<BellOff size={12} />}
            title={mute.title}
            loading={busy}
            disabled={busy}
            onClick={() => onMute(mute.next)}
          >
            {mute.label}
          </Button>
        </div>
      </div>

      {acted && (
        <p className="mt-2 text-compact text-content-secondary" data-testid="acted-line">
          <span className="text-content-tertiary">She did: </span>
          {acted.text}
          {acted.turnId && (
            // A plain anchor rather than a router Link: this card is rendered
            // bare in its own tests, and a same-origin navigation works as one.
            <a
              href={`/activity?turn=${encodeURIComponent(acted.turnId)}`}
              className="ml-2 font-mono text-micro text-accent hover:underline"
              data-testid="acted-trace-link"
              title={`turn ${acted.turnId} — the trace is the account of what she says she did`}
            >
              open the trace
            </a>
          )}
        </p>
      )}

      {facts.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-micro text-content-tertiary" data-testid="notice-facts">
          {facts.map(fact => (
            <li key={fact.key}>
              {fact.key}: <span className="text-content-secondary">{fact.value}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-2 flex flex-wrap gap-x-3 text-micro text-content-tertiary">
        <span title={formatAbsolute(notice.first_seen_at)}>
          first seen {formatRelativeTime(notice.first_seen_at)}
        </span>
        <span title={formatAbsolute(notice.last_seen_at)}>
          last seen {formatRelativeTime(notice.last_seen_at)}
        </span>
        {notice.cleared_at && (
          <span title={formatAbsolute(notice.cleared_at)} data-testid="cleared-at">
            cleared {formatRelativeTime(notice.cleared_at)}
          </span>
        )}
      </div>

      {lines.length > 0 ? (
        <ul className="mt-2 space-y-0.5" data-testid="delivery-lines">
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
      ) : (
        <p className="mt-2 inline-flex items-center gap-1.5 text-micro text-content-tertiary" data-testid="no-delivery-yet">
          <Radar size={11} />
          no channel has reported on this yet
        </p>
      )}

      {rowError && (
        <p role="alert" className="mt-2 text-micro text-danger">
          {rowError}
        </p>
      )}
    </div>
  )
}
