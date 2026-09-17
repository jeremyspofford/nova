import { useCallback, useEffect, useState } from 'react'
import { ScrollText } from 'lucide-react'
import { PageHeader } from '../../components/layout/PageHeader'
import { Button, EmptyState, Skeleton } from '../../components/ui'
import {
  getActivity as apiGetActivity,
  getActivityTurn as apiGetActivityTurn,
  ACTIVITY_PAGE_SIZE,
  type ActivityTurn,
} from '../../lib/api'
import { ActivityTable } from './ActivityTable'

/**
 * The operator's window into what Nova actually did — a read-only view
 * over the turn ledger (services/core/app/activity.py). Everything here is
 * only ever what the API actually returned: an absent field renders as an
 * em dash, never a fabricated zero, and a NULL status renders as
 * "unfinished" rather than being guessed at as ok or error — the ledger's
 * whole point is that an abandoned turn looks abandoned here too.
 *
 * This page owns the LIST (the first page, older pages by cursor); the rows
 * and the expand-to-spans drill-in are ActivityTable's (S12), shared with an
 * agent's Traces tab so the two cannot drift. An agent's turn (kind `agent`)
 * is listed here like any other, badged with the agent's name.
 *
 * `api` is a dependency-injection seam, the same idiom as ChatProvider's
 * `fetchImpl`: production always uses the real client (the default
 * below); tests swap in a fake without reaching for module mocking.
 */
interface ActivityApi {
  getActivity: typeof apiGetActivity
  getActivityTurn: typeof apiGetActivityTurn
}

const DEFAULT_API: ActivityApi = {
  getActivity: apiGetActivity,
  getActivityTurn: apiGetActivityTurn,
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function ActivityPage({
  api = DEFAULT_API,
  pageSize = ACTIVITY_PAGE_SIZE,
  initialTurnId = null,
}: {
  api?: ActivityApi
  /** Exposed so a test can exercise the "maybe more" boundary without 50
   * fake rows; production always uses the real page size. */
  pageSize?: number
  /** S11: `?turn=<id>` off the URL — one turn somebody linked to (the
   * Inbox's "open the trace"). Its row opens on arrival; if it is not in the
   * page that loaded, that is STATED rather than left as a link that
   * appeared to do nothing. */
  initialTurnId?: string | null
} = {}) {
  const [turns, setTurns] = useState<ActivityTurn[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [exhausted, setExhausted] = useState(false)

  useEffect(() => {
    let live = true
    setError(null)
    api
      .getActivity({ limit: pageSize })
      .then(rows => {
        if (!live) return
        setTurns(rows)
        setExhausted(rows.length < pageSize)
      })
      .catch(err => {
        if (live) setError(reasonOf(err))
      })
    return () => {
      live = false
    }
  }, [api, pageSize])

  const loadMore = useCallback(() => {
    if (!turns || turns.length === 0) return
    const before = turns[turns.length - 1].id
    setLoadingMore(true)
    setError(null)
    api
      .getActivity({ limit: pageSize, before })
      .then(next => {
        setTurns(prev => [...(prev ?? []), ...next])
        setExhausted(next.length < pageSize)
      })
      .catch(err => setError(reasonOf(err)))
      .finally(() => setLoadingMore(false))
  }, [api, turns, pageSize])

  return (
    <div>
      <PageHeader
        title="Activity"
        description="Every chat turn and tool call, read straight from the trace ledger."
      />

      {error && (
        <div
          role="alert"
          className="mb-6 rounded-sm border border-danger/30 bg-danger-dim px-4 py-3 text-compact text-danger"
        >
          Could not load activity: {error}
        </div>
      )}

      {/* A link that named a turn this page has not loaded says so. Silence
          there reads as "that trace does not exist", which is a claim nobody
          checked — the row may simply be older than this page. */}
      {initialTurnId !== null && turns !== null && !turns.some(t => t.id === initialTurnId) && (
        <p
          role="status"
          data-testid="linked-turn-missing"
          className="mb-6 rounded-sm border border-border bg-surface-elevated px-4 py-3 text-compact text-content-secondary"
        >
          Turn {initialTurnId} is not among the turns loaded here.{' '}
          {exhausted
            ? 'This is the whole ledger, so no turn with that id is in it.'
            : 'Load more to reach it.'}
        </p>
      )}

      {turns === null ? (
        !error && <Skeleton lines={6} />
      ) : turns.length === 0 ? (
        <EmptyState
          icon={ScrollText}
          title="Nothing yet"
          description="Every chat turn and tool call will appear here."
        />
      ) : (
        <>
          <ActivityTable
            turns={turns}
            getActivityTurn={api.getActivityTurn}
            initialExpandedId={initialTurnId}
          />

          {!exhausted && (
            <div className="flex justify-center mt-4">
              <Button variant="secondary" size="sm" loading={loadingMore} onClick={loadMore}>
                Load more
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
