import { useCallback, useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, ShieldCheck, Sparkles } from 'lucide-react'
import { Badge, Button, EmptyState, ProgressBar, Section, Skeleton } from '../../components/ui'
import {
  getAutonomyState as apiGetAutonomyState,
  getGovernanceEvents as apiGetGovernanceEvents,
  revokeAutonomy as apiRevokeAutonomy,
  type AutonomyClass,
  type GovernanceEvent,
} from '../../lib/api'

/**
 * Settings -> Autonomy (S3-T3, Fix 2): every gateable action class, its
 * CURRENT disposition, and — for a class still earning it — its REAL stored
 * progress toward graduation (autonomy.state()'s consecutive_successes /
 * graduation_runs, never computed or guessed here). An earned-auto class
 * (earned=true) gets a Revoke button that demotes it back to consent — a
 * governance event, and the card returns on the class's next use, since
 * revoking flips the SAME action_classes.disposition row the kernel reads
 * (services/core/app/autonomy.py). A baseline-auto class (earned=false —
 * never gated, seeded auto by ruling S3-R1) shows neither a progress bar nor
 * a Revoke button: there is nothing this loop granted to take back.
 *
 * Clicking a row expands its recent governance-ledger decisions, fetched
 * on demand (not eagerly for every class) via GET /api/v1/governance
 * filtered to that action_class.
 *
 * `api` is the same dependency-injection seam as ModelsSection's: production
 * uses the real client, tests inject fakes.
 */
interface AutonomyApi {
  getAutonomyState: typeof apiGetAutonomyState
  revokeAutonomy: typeof apiRevokeAutonomy
  getGovernanceEvents: typeof apiGetGovernanceEvents
}

const DEFAULT_API: AutonomyApi = {
  getAutonomyState: apiGetAutonomyState,
  revokeAutonomy: apiRevokeAutonomy,
  getGovernanceEvents: apiGetGovernanceEvents,
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

type EventsState =
  | { status: 'loading' }
  | { status: 'error'; reason: string }
  | { status: 'ready'; events: GovernanceEvent[] }

export function AutonomySection({ api = DEFAULT_API }: { api?: AutonomyApi } = {}) {
  const [classes, setClasses] = useState<AutonomyClass[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [revokeError, setRevokeError] = useState<string | null>(null)
  const [revokingId, setRevokingId] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [events, setEvents] = useState<Record<string, EventsState>>({})

  useEffect(() => {
    let live = true
    api
      .getAutonomyState()
      .then(rows => {
        if (live) setClasses(rows)
      })
      .catch(err => {
        if (live) setLoadError(reasonOf(err))
      })
    return () => {
      live = false
    }
  }, [api])

  const toggle = useCallback(
    (actionClass: string) => {
      setExpanded(prev => (prev === actionClass ? null : actionClass))
      if (events[actionClass]) return
      setEvents(prev => ({ ...prev, [actionClass]: { status: 'loading' } }))
      api
        .getGovernanceEvents({ actionClass, limit: 5 })
        .then(rows => setEvents(prev => ({ ...prev, [actionClass]: { status: 'ready', events: rows } })))
        .catch(err =>
          setEvents(prev => ({ ...prev, [actionClass]: { status: 'error', reason: reasonOf(err) } })),
        )
    },
    [api, events],
  )

  const handleRevoke = useCallback(
    async (actionClass: string) => {
      setRevokingId(actionClass)
      setRevokeError(null)
      try {
        const updated = await api.revokeAutonomy(actionClass)
        setClasses(updated)
      } catch (err) {
        setRevokeError(reasonOf(err))
      } finally {
        setRevokingId(null)
      }
    },
    [api],
  )

  return (
    <Section
      icon={Sparkles}
      title="Autonomy"
      description="Which actions Nova can take without asking, earned by demonstrated reliability — and revocable any time."
    >
      {loadError && (
        <div
          role="alert"
          className="rounded-sm border border-danger/30 bg-danger-dim px-4 py-3 text-compact text-danger"
        >
          Could not load autonomy state: {loadError}
        </div>
      )}
      {revokeError && (
        <div
          role="alert"
          className="rounded-sm border border-danger/30 bg-danger-dim px-4 py-3 text-compact text-danger"
        >
          Could not revoke that class: {revokeError}
        </div>
      )}

      {classes === null ? (
        !loadError && (
          <div data-testid="autonomy-skeleton">
            <Skeleton lines={4} />
          </div>
        )
      ) : classes.length === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          title="No gateable classes"
          description="Nothing here is behind a consent or an earned promotion yet."
        />
      ) : (
        <div className="divide-y divide-border-subtle">
          {classes.map(entry => (
            <AutonomyRow
              key={entry.action_class}
              entry={entry}
              expanded={expanded === entry.action_class}
              eventsState={events[entry.action_class]}
              revoking={revokingId === entry.action_class}
              onToggle={() => toggle(entry.action_class)}
              onRevoke={() => handleRevoke(entry.action_class)}
            />
          ))}
        </div>
      )}
    </Section>
  )
}

const DISPOSITION_COLOR: Record<AutonomyClass['disposition'], 'success' | 'accent' | 'danger'> = {
  auto: 'success',
  consent: 'accent',
  deny: 'danger',
}

function AutonomyRow({
  entry,
  expanded,
  eventsState,
  revoking,
  onToggle,
  onRevoke,
}: {
  entry: AutonomyClass
  expanded: boolean
  eventsState: EventsState | undefined
  revoking: boolean
  onToggle: () => void
  onRevoke: () => void
}) {
  const showProgress = entry.disposition === 'consent'
  const showRevoke = entry.disposition === 'auto' && entry.earned

  return (
    <div className="py-3">
      {/* A <button> cannot nest another interactive element (the Revoke
          button below), so only the disclosure toggle itself is a <button> —
          the row is a plain flex container around it. */}
      <div className="flex w-full items-center gap-3">
        <button
          type="button"
          onClick={onToggle}
          className="flex flex-1 min-w-0 items-center gap-3 text-left"
        >
          {expanded ? (
            <ChevronDown size={14} className="shrink-0 text-content-tertiary" />
          ) : (
            <ChevronRight size={14} className="shrink-0 text-content-tertiary" />
          )}
          <span className="font-mono text-compact text-content-primary truncate">
            {entry.action_class}
          </span>
          <Badge size="sm" color={DISPOSITION_COLOR[entry.disposition]}>
            {entry.disposition}
          </Badge>
          {entry.earned && (
            <Badge size="sm" color="accent">
              earned
            </Badge>
          )}
        </button>
        {showProgress && (
          <span className="flex items-center gap-2 shrink-0">
            <span className="w-24">
              <ProgressBar
                size="sm"
                value={(entry.consecutive_successes / Math.max(1, entry.graduation_runs)) * 100}
              />
            </span>
            <span className="font-mono text-micro text-content-tertiary whitespace-nowrap">
              {entry.consecutive_successes} / {entry.graduation_runs} approved runs
            </span>
          </span>
        )}
        {showRevoke && (
          <Button size="sm" variant="secondary" loading={revoking} onClick={onRevoke}>
            Revoke
          </Button>
        )}
      </div>

      {expanded && (
        <div className="mt-2 pl-6">
          {eventsState?.status === 'loading' && <Skeleton lines={2} />}
          {eventsState?.status === 'error' && (
            <p className="text-caption text-danger">
              Could not load recent decisions: {eventsState.reason}
            </p>
          )}
          {eventsState?.status === 'ready' && eventsState.events.length === 0 && (
            <p className="text-caption text-content-tertiary italic">
              No decisions recorded for this class yet.
            </p>
          )}
          {eventsState?.status === 'ready' && eventsState.events.length > 0 && (
            <ul className="space-y-1">
              {eventsState.events.map(event => (
                <li
                  key={event.id}
                  className="flex items-center gap-2 text-caption text-content-secondary"
                >
                  <span className="font-mono text-content-primary">{event.kind}</span>
                  <span className="text-content-tertiary">
                    {new Date(event.created_at).toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
