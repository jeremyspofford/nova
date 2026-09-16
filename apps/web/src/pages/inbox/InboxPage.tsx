import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { BellOff, BookPlus, Inbox, MessageSquare, Radar } from 'lucide-react'
import clsx from 'clsx'
import { PageHeader } from '../../components/layout/PageHeader'
import { Badge, Button, EmptyState, Skeleton } from '../../components/ui'
import {
  listNotices as apiListNotices,
  markNoticeSeen as apiMarkNoticeSeen,
  muteNotice as apiMuteNotice,
  listNoticeDigests as apiListNoticeDigests,
  talkAboutNotice as apiTalkAboutNotice,
  NOTICES_PAGE_SIZE,
  type Notice,
  type NoticeDigest,
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
  draftWords,
  readWords,
  sightingsWords,
  silenceWords,
  stateBadge,
  talkWords,
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
 * The two controls do different things, which they did not always: until
 * S25.1.3 marking a card seen ALSO dropped it out of every future digest,
 * so the quiet button and the silencing button were the same button and only
 * one of them said so. Seen now writes a receipt and nothing else; mute is
 * the one that silences, it says so, and what it silenced is one tab away
 * rather than gone.
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
  talkAboutNotice: typeof apiTalkAboutNotice
  listNoticeDigests: typeof apiListNoticeDigests
}

const DEFAULT_API: InboxApi = {
  listNotices: apiListNotices,
  markNoticeSeen: apiMarkNoticeSeen,
  muteNotice: apiMuteNotice,
  talkAboutNotice: apiTalkAboutNotice,
  listNoticeDigests: apiListNoticeDigests,
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
  // WHICH QUESTION the page is answering. `inbox` and `muted` are two halves
  // of one table — a mute is not a deletion, and this is the only place an
  // unmute can be clicked, so a silence he cannot find is a silence he
  // cannot lift (S25.1.2). `digests` is a different question entirely: not
  // "what is true" but "what was I told, and when" (S25 Q4).
  const [view, setView] = useState<'inbox' | 'muted' | 'digests'>('inbox')
  const [mutedCount, setMutedCount] = useState<number | null>(null)
  const [digests, setDigests] = useState<NoticeDigest[] | null>(null)
  const [notTold, setNotTold] = useState<Notice[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})
  const shell = useUnseenNotices()
  const navigate = useNavigate()
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
      // The digest view still reads the listing, for the counts on the tabs
      // beside it: a badge that only updates while you are looking at its
      // own tab is a badge that lies on the other two.
      const listing = await api.listNotices({ limit: pageSize, muted: view === 'muted' })
      if (!mounted.current) return
      setNotices(listing.notices)
      setUnseenCount(listing.unseen_count)
      // Counted by the server over every row, like the unread count beside
      // it — so the tab can say what the default view is withholding even
      // while the muted view is the one not on screen.
      setMutedCount(listing.muted_count)
      if (view === 'digests') {
        const told = await api.listNoticeDigests()
        if (!mounted.current) return
        setDigests(told.digests)
        setNotTold(told.not_told_yet)
      }
      setError(null)
    } catch (err) {
      // The last known list stays: a failed read is a failed read, never a
      // reason to render an empty inbox as if she had noticed nothing.
      if (mounted.current) setError(reasonOf(err))
    }
  }, [api, pageSize, view])

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

  /** Open the room off the message that told him, and go there (S25.2.4).
   *
   * NOT through `write`: that re-reads the listing after every call, and
   * this one navigates away — a re-read racing an unmount is a state update
   * on a page nobody is looking at. A refusal is stated on the row it
   * belongs to, in core's words, exactly as a failed write is.
   */
  const talk = useCallback(
    async (notice: Notice) => {
      setBusyId(notice.id)
      try {
        const room = await api.talkAboutNotice(notice.id)
        navigate(`/chat?thread=${encodeURIComponent(room.conversation_id)}`)
      } catch (err) {
        if (mounted.current) setRowErrors(prev => ({ ...prev, [notice.id]: reasonOf(err) }))
      } finally {
        if (mounted.current) setBusyId(null)
      }
    },
    [api, navigate],
  )

  return (
    <div>
      <PageHeader
        title="Inbox"
        description="What she noticed on her own — what each check found, what she did about it, and whether you were ever told."
      />

      {/* The three questions this page answers. The muted tab carries its
          count so it is legible as "there are silenced things over here"
          rather than an empty-looking option nobody clicks — rows behind an
          invisible filter are as gone as deleted ones (S25.1.2) — and it is
          absent entirely when nothing is silenced, because a tab that can
          only ever be empty is furniture. */}
      <div className="mb-4 flex gap-1" data-testid="inbox-tabs">
        {[
          { key: 'inbox' as const, label: 'Inbox' },
          { key: 'digests' as const, label: 'What you were told' },
          ...(mutedCount !== null && (mutedCount > 0 || view === 'muted')
            ? [{ key: 'muted' as const, label: `Muted (${mutedCount})` }]
            : []),
        ].map(tab => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setView(tab.key)}
            aria-pressed={view === tab.key}
            className={`rounded-sm px-3 py-1.5 text-compact transition-colors ${
              view === tab.key
                ? 'bg-surface-raised text-content-primary'
                : 'text-content-secondary hover:text-content-primary'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

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

      {view === 'digests' ? (
        <Digests
          digests={digests}
          notTold={notTold}
          busyId={busyId}
          rowErrors={rowErrors}
          onSeen={notice => void write(notice, () => api.markNoticeSeen(notice.id))}
          onMute={(notice, next) => void write(notice, () => api.muteNotice(notice.id, next))}
          onTalk={notice => void talk(notice)}
          onDraft={notice =>
            navigate(`/skills?from_notice=${encodeURIComponent(notice.id)}`)
          }
        />
      ) : notices === null ? (
        !error && (
          <div data-testid="inbox-skeleton">
            <Skeleton lines={4} />
          </div>
        )
      ) : notices.length === 0 ? (
        view === 'muted' ? (
          <EmptyState
            icon={Inbox}
            title="Nothing is muted"
            description="Muting something puts it here rather than deleting it, so you can always find what you silenced and let it speak again."
          />
        ) : (
          <EmptyState
            icon={Inbox}
            title="Nothing noticed yet"
            description="The watch beat writes here every time a check finds something. An empty inbox means the checks ran and found nothing to tell you."
          />
        )
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
              onTalk={() => void talk(notice)}
              // A draft needs a NAME, and the Skills page is what knows how
              // to ask for one — so this carries the notice there rather
              // than posting a skill called something this page invented.
              onDraft={() => navigate(`/skills?from_notice=${encodeURIComponent(notice.id)}`)}
            />
          ))}
          {/* A full page is probably not the whole record. Saying so beats a
              list that silently stops — the unread count above is over EVERY
              row, so the two numbers would otherwise disagree with no
              explanation. */}
          {notices.length >= pageSize && (
            <p className="pt-1 text-micro text-content-tertiary" data-testid="page-is-full">
              These are the {pageSize} most recent notices — older ones are not listed here.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * "What you were told, and when" (S25 Q4).
 *
 * One section per TELLING — the message that carried a group of notices —
 * newest first, with what is still waiting to be told underneath. The cards
 * are the same `NoticeCard` the other two views render, because a card that
 * says different things on two pages is two cards.
 *
 * A digest is not a stored thing: core derives the grouping from the
 * `delivered_message_id` each notice already carries. So this page cannot
 * show him a telling that did not happen, and cannot miss one that did.
 */
function Digests({
  digests,
  notTold,
  busyId,
  rowErrors,
  onSeen,
  onMute,
  onTalk,
  onDraft,
}: {
  digests: NoticeDigest[] | null
  notTold: Notice[]
  busyId: string | null
  rowErrors: Record<string, string>
  onSeen: (notice: Notice) => void
  onMute: (notice: Notice, next: boolean) => void
  onTalk: (notice: Notice) => void
  onDraft: (notice: Notice) => void
}) {
  if (digests === null) {
    return (
      <div data-testid="digests-skeleton">
        <Skeleton lines={4} />
      </div>
    )
  }

  const cards = (rows: Notice[]) =>
    rows.map(notice => (
      <NoticeCard
        key={notice.id}
        notice={notice}
        busy={busyId === notice.id}
        rowError={rowErrors[notice.id]}
        onSeen={() => onSeen(notice)}
        onMute={next => onMute(notice, next)}
        onTalk={() => onTalk(notice)}
        onDraft={() => onDraft(notice)}
      />
    ))

  return (
    <div className="space-y-8" data-testid="digest-list">
      {digests.length === 0 && notTold.length === 0 && (
        <EmptyState
          icon={Inbox}
          title="Nothing has been carried to you yet"
          description="When the digest or a push tells you about something, it shows up here as what you were told and when."
        />
      )}

      {digests.map(group => (
        <section key={group.message_id} data-testid={`digest-${group.message_id}`}>
          <h2 className="mb-2 text-compact text-content-secondary">
            <span title={formatAbsolute(group.delivered_at)}>
              Told {formatRelativeTime(group.delivered_at)}
            </span>
            <span className="text-content-tertiary">
              {' '}
              — {group.notices.length} {group.notices.length === 1 ? 'thing' : 'things'}
            </span>
          </h2>
          <div className="space-y-3">{cards(group.notices)}</div>
        </section>
      ))}

      {notTold.length > 0 && (
        <section data-testid="not-told-yet">
          {/* The same fact a disabled "talk about this" states on the card:
              no message has carried these, so there is no telling to file
              them under and no room to open off one. */}
          <h2 className="mb-2 text-compact text-content-secondary">
            Not told yet
            <span className="text-content-tertiary"> — still standing, nothing has carried it</span>
          </h2>
          <div className="space-y-3">{cards(notTold)}</div>
        </section>
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
  onTalk,
  onDraft,
}: {
  notice: Notice
  busy: boolean
  rowError: string | undefined
  onSeen: () => void
  onMute: (next: boolean) => void
  onTalk: () => void
  onDraft: () => void
}) {
  const state = stateBadge(notice.state)
  const live = livePill(notice)
  const acted = actedLine(notice)
  const sightings = sightingsWords(notice.repeats)
  const mute = muteWords(notice)
  const read = readWords(notice)
  const silence = silenceWords(notice)
  const talk = talkWords(notice)
  const draft = draftWords(notice)
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
          {/* S25.2.4. Disabled rather than hidden when there is no room: the
              reason is a fact about the world — nothing has carried this to
              him yet — and hiding it would leave him wondering why this card
              is different from the others. */}
          {/* S25.2.5. Only on a notice that actually carries a procedure —
              which is the same condition the backend accepts, read off the
              same facts, so this cannot offer a draft that would be
              refused. It navigates rather than posting: the draft needs a
              NAME, and the Skills page is what knows how to ask for one. */}
          {draft && (
            <Button
              size="sm"
              variant="ghost"
              icon={<BookPlus size={12} />}
              title={draft.title}
              onClick={onDraft}
              data-testid="draft-skill"
            >
              Write this down
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            icon={<MessageSquare size={12} />}
            title={talk.title}
            disabled={!talk.can || busy}
            onClick={onTalk}
            data-testid="talk-about"
          >
            Talk about this
          </Button>
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

      {silence && (
        <p className="mt-2 text-compact text-content-tertiary" data-testid="silence-line">
          {silence.text}
        </p>
      )}

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
            <li key={fact.key} title={fact.title}>
              {fact.key}:{' '}
              {fact.href === undefined ? (
                <span className="text-content-secondary">{fact.value}</span>
              ) : (
                <Link
                  to={fact.href}
                  className="text-accent underline decoration-dotted underline-offset-2 hover:decoration-solid"
                >
                  {fact.value}
                </Link>
              )}
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
