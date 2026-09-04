import { useCallback, useEffect, useState } from 'react'
import { ScrollText } from 'lucide-react'
import { PageHeader } from '../../components/layout/PageHeader'
import { Badge, Button, EmptyState, Skeleton } from '../../components/ui'
import {
  getGovernanceEvents as apiGetGovernanceEvents,
  GOVERNANCE_PAGE_SIZE,
  type GovernanceEvent,
} from '../../lib/api'

/**
 * The operator-visible governance ledger: a record of what happened — a
 * device enrolled, a device revoked, a replayed device audit chain that did
 * not join up — newest-first, verbatim off governance.py's ledger
 * (services/core/app/governance_api.py). Nothing in v4 decides whether Nova
 * may act (owner ruling 2026-09-03), so nothing here is a decision: this page
 * reads only, and the table it reads is the audit, never an authority.
 *
 * Pagination mirrors ActivityPage's: "load more" pages strictly older than
 * the last row's id (the server's cursor, not a client-side offset), and a
 * page shorter than the page size means there is nothing further.
 *
 * `api` is the same dependency-injection seam as ActivityPage's: production
 * uses the real client, tests inject a fake.
 */
interface GovernanceApi {
  getGovernanceEvents: typeof apiGetGovernanceEvents
}

const DEFAULT_API: GovernanceApi = { getGovernanceEvents: apiGetGovernanceEvents }

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// The kinds core writes (services/core/app/governance.py). Anything else —
// a kind a future slice adds before this map learns it — renders neutral
// rather than being hidden or crashing the page.
const KIND_COLOR: Record<string, 'success' | 'danger' | 'accent' | 'neutral'> = {
  'device.enrolled': 'success',
  'device.revoked': 'danger',
  'device.audit_break': 'danger',
}

export function GovernancePage({
  api = DEFAULT_API,
  pageSize = GOVERNANCE_PAGE_SIZE,
}: {
  api?: GovernanceApi
  /** Exposed so a test can exercise the "maybe more" boundary without 50
   * fake rows; production always uses the real page size. */
  pageSize?: number
} = {}) {
  const [events, setEvents] = useState<GovernanceEvent[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [exhausted, setExhausted] = useState(false)

  useEffect(() => {
    let live = true
    setError(null)
    api
      .getGovernanceEvents({ limit: pageSize })
      .then(rows => {
        if (!live) return
        setEvents(rows)
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
    if (!events || events.length === 0) return
    const before = events[events.length - 1].id
    setLoadingMore(true)
    setError(null)
    api
      .getGovernanceEvents({ limit: pageSize, before })
      .then(next => {
        setEvents(prev => [...(prev ?? []), ...next])
        setExhausted(next.length < pageSize)
      })
      .catch(err => setError(reasonOf(err)))
      .finally(() => setLoadingMore(false))
  }, [api, events, pageSize])

  return (
    <div>
      <PageHeader
        title="Governance"
        description="What happened to this instance's devices — every pairing, revoke, and audit-chain break — newest first."
      />

      {error && (
        <div
          role="alert"
          className="mb-6 rounded-sm border border-danger/30 bg-danger-dim px-4 py-3 text-compact text-danger"
        >
          Could not load the governance ledger: {error}
        </div>
      )}

      {events === null ? (
        !error && (
          <div data-testid="governance-skeleton">
            <Skeleton lines={6} />
          </div>
        )
      ) : events.length === 0 ? (
        <EmptyState
          icon={ScrollText}
          title="Nothing recorded yet"
          description="Every device pairing, revoke, and audit-chain break will appear here."
        />
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border border-border glass-card dark:border-white/[0.08]">
            <table className="w-full text-compact">
              <thead>
                <tr className="bg-surface-elevated">
                  {['Time', 'Event', 'Actor'].map(heading => (
                    <th
                      key={heading}
                      className="px-4 py-3 text-left text-caption font-medium text-content-tertiary uppercase tracking-wider sticky top-0 bg-surface-elevated"
                    >
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {events.map(event => (
                  <tr key={event.id} data-testid={`governance-row-${event.id}`}>
                    <td className="px-4 py-2.5 text-micro text-content-tertiary whitespace-nowrap">
                      {new Date(event.created_at).toLocaleString()}
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      <Badge size="sm" color={KIND_COLOR[event.kind] ?? 'neutral'}>
                        {event.kind}
                      </Badge>
                    </td>
                    <td className="px-4 py-2.5 font-mono text-caption text-content-secondary truncate max-w-[220px]">
                      {event.actor ?? <span className="text-content-tertiary">—</span>}
                    </td>
                  </tr>
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
    </div>
  )
}
