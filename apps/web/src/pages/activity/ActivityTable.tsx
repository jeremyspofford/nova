import { useCallback, useEffect, useRef, useState } from 'react'
import { Bot, ChevronDown, ChevronRight } from 'lucide-react'
import clsx from 'clsx'
import { Badge, Code, Skeleton } from '../../components/ui'
import {
  getActivityTurn as apiGetActivityTurn,
  type ActivitySpan,
  type ActivityTurn,
  type ActivityTurnDetail,
} from '../../lib/api'
import {
  formatMs,
  formatRelativeTime,
  isWorkspacePathTool,
  statusBadge,
  viewArgs,
  workspacePathFrom,
} from './activityFormat'
import { agentRole } from '../agents/agentsFormat'

/**
 * The turn table with its in-place drill-in — the Activity page's rows,
 * extracted (S12) so an agent's Traces tab shows EXACTLY the same rows and
 * the same expand-to-spans drill-in rather than a second rendering that
 * could drift. The caller owns the list (fetching, paging); this owns which
 * row is open and the spans fetched for it.
 *
 * Everything here is only ever what the API returned: an absent field
 * renders as an em dash, never a fabricated zero, and a NULL status renders
 * as "unfinished" rather than being guessed at as ok or error.
 */

type DetailState =
  | { status: 'loading' }
  | { status: 'error'; reason: string }
  | { status: 'ready'; detail: ActivityTurnDetail }

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

const HEADINGS = ['Time', 'Kind', 'Model', 'Status', 'Duration', 'Tools']

export function ActivityTable({
  turns,
  getActivityTurn = apiGetActivityTurn,
}: {
  turns: ActivityTurn[]
  /** The drill-in fetch — the DI seam, so a page's fake api reaches here. */
  getActivityTurn?: typeof apiGetActivityTurn
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [details, setDetails] = useState<Record<string, DetailState>>({})
  // Which ids a fetch has actually SETTLED for — a ref, not derived from
  // `details`, so the effect below does not depend on state IT writes
  // (depending on `details` would re-run the effect the moment it calls
  // setDetails(loading), whose cleanup would mark the in-flight fetch's
  // own closure stale before its promise ever resolves).
  //
  // Marked only from inside the live-gated `.then`/`.catch` below — i.e.
  // only when a result was actually committed to `details` — never at the
  // moment a fetch merely STARTS. An id marked at start time and never
  // unmarked is exactly the bug this once was: collapse (or switch to a
  // different row) before the fetch resolves flips `live` to false in the
  // cleanup, the eventual settle becomes a no-op, and re-expanding would
  // see the id already "requested" and never ask again — a row stuck on
  // the loading Skeleton forever, no error, no retry. Marking on settle
  // instead means an abandoned fetch simply leaves no mark, so a later
  // re-expand is indistinguishable from a first expand and tries again.
  const settledRef = useRef<Set<string>>(new Set())

  // A turn's spans are fetched once per id that actually SETTLES — see
  // settledRef above. Collapsing and re-expanding a row whose fetch
  // already landed reuses the cached `details` entry; re-expanding one
  // that never got the chance to land (abandoned mid-flight) retries.
  useEffect(() => {
    if (expandedId === null || settledRef.current.has(expandedId)) return
    const id = expandedId
    let live = true
    setDetails(prev => ({ ...prev, [id]: { status: 'loading' } }))
    getActivityTurn(id)
      .then(detail => {
        if (live) {
          settledRef.current.add(id)
          setDetails(prev => ({ ...prev, [id]: { status: 'ready', detail } }))
        }
      })
      .catch(err => {
        if (live) {
          settledRef.current.add(id)
          setDetails(prev => ({ ...prev, [id]: { status: 'error', reason: reasonOf(err) } }))
        }
      })
    return () => {
      live = false
    }
  }, [getActivityTurn, expandedId])

  const toggle = useCallback((id: string) => {
    setExpandedId(prev => (prev === id ? null : id))
  }, [])

  return (
    <div className="overflow-x-auto rounded-lg border border-border glass-card dark:border-white/[0.08]">
      <table className="w-full text-compact">
        <thead>
          <tr className="bg-surface-elevated">
            {HEADINGS.map(heading => (
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
          {turns.map(t => (
            <ActivityRow
              key={t.id}
              turn={t}
              expanded={expandedId === t.id}
              detail={details[t.id]}
              onToggle={() => toggle(t.id)}
            />
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** The agent badge (S12): the NAME core derived from the turn's agent_id —
 * absent for Nova's own turns and for a since-deleted agent's, so it never
 * names an agent that is not there. */
export function AgentBadge({ name, role }: { name: string; role?: string | null }) {
  return (
    <span data-testid="agent-badge" title={agentRole(role) ?? undefined}>
      <Badge size="sm" color="info">
        <Bot size={10} />
        {name}
      </Badge>
    </span>
  )
}

function ActivityRow({
  turn,
  expanded,
  detail,
  onToggle,
}: {
  turn: ActivityTurn
  expanded: boolean
  detail: DetailState | undefined
  onToggle: () => void
}) {
  const badge = statusBadge(turn.status)
  const duration = formatMs(turn.duration_ms)
  const role = agentRole(turn.role)

  return (
    <>
      <tr
        data-testid={`activity-row-${turn.id}`}
        onClick={onToggle}
        className="cursor-pointer hover:bg-surface-card-hover transition-colors"
      >
        <td className="px-4 py-2.5 text-micro text-content-tertiary whitespace-nowrap">
          <span className="inline-flex items-center gap-1">
            {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
            {formatRelativeTime(turn.started_at)}
          </span>
        </td>
        <td className="px-4 py-2.5 font-mono text-caption text-content-secondary whitespace-nowrap">
          <span className="inline-flex items-center gap-1.5">
            {turn.kind}
            {turn.agent && <AgentBadge name={turn.agent} role={turn.role} />}
          </span>
        </td>
        <td className="px-4 py-2.5 font-mono text-caption text-content-secondary truncate max-w-[220px]">
          {turn.model ?? <span className="text-content-tertiary">—</span>}
        </td>
        <td className="px-4 py-2.5 whitespace-nowrap">
          <Badge
            color={badge.color}
            size="sm"
            className={badge.pulse ? 'animate-pulse' : undefined}
          >
            {badge.label}
          </Badge>
        </td>
        <td className="px-4 py-2.5 font-mono text-caption text-content-secondary whitespace-nowrap">
          {duration ?? <span className="text-content-tertiary">—</span>}
        </td>
        <td className="px-4 py-2.5 whitespace-nowrap">
          {turn.tool_call_count > 0 && (
            <span data-testid="tool-count-badge">
              <Badge size="sm" color="accent">
                {turn.tool_call_count}
              </Badge>
            </span>
          )}
        </td>
      </tr>
      {expanded && (
        <tr data-testid={`activity-detail-${turn.id}`} className="bg-surface-elevated/40">
          <td colSpan={6} className="px-6 py-4">
            {/* S12: which routing role the rounds walked — stated only for an
                agent's derived role; a built-in role is the kind's own. */}
            {role && (
              <p className="mb-3 text-caption text-content-tertiary" data-testid="turn-role">
                routed as <span className="font-mono text-content-secondary">{role}</span>
              </p>
            )}
            {detail?.status === 'loading' && <Skeleton lines={3} />}
            {detail?.status === 'error' && (
              <p className="text-compact text-danger">Could not load this turn: {detail.reason}</p>
            )}
            {detail?.status === 'ready' && (
              <div className="space-y-3">
                {detail.detail.spans.length === 0 ? (
                  <p className="text-caption text-content-tertiary italic">
                    No spans were recorded for this turn.
                  </p>
                ) : (
                  detail.detail.spans.map((span, i) => <SpanDetail key={i} span={span} />)
                )}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  )
}

function SpanDetail({ span }: { span: ActivitySpan }) {
  const duration = formatMs(span.duration_ms)

  if (span.kind === 'llm_call') {
    const round = span.meta.round
    const model = span.meta.model
    const promptTokens = span.meta.prompt_tokens
    const completionTokens = span.meta.completion_tokens
    const cacheRead = span.meta.cache_read_tokens
    const cost = span.meta.cost_usd
    const basis = span.meta.cost_basis
    const purpose = span.meta.purpose
    const local = span.meta.local === true
    const metered = span.meta.metered
    const unrecorded = span.meta.usage_recorded === false
    const error = typeof span.meta.error === 'string' ? span.meta.error : null
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption" data-testid="llm-call-span">
        <Badge size="sm">llm_call</Badge>
        {typeof purpose === 'string' && purpose !== 'chat' && <Badge size="sm" color="neutral">{purpose}</Badge>}
        {typeof round === 'number' && <span>Round {round}</span>}
        {typeof model === 'string' && model && (
          <span className="font-mono text-content-secondary">{model}</span>
        )}
        {typeof promptTokens === 'number' && typeof completionTokens === 'number' && (
          <span className="font-mono text-content-tertiary">
            {promptTokens} in / {completionTokens} out
            {typeof cacheRead === 'number' && cacheRead > 0 ? ` (${cacheRead} cached)` : ''}
          </span>
        )}
        {/* S10: the cost as the gateway's ledger recorded it, with its basis;
            a local round is GPU time, an unmetered one has no dollars. */}
        {typeof cost === 'number' ? (
          <span className="font-mono text-content-secondary" title={typeof basis === 'string' ? basis : undefined}>
            ${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}
            {typeof basis === 'string' ? ` (${basis})` : ''}
          </span>
        ) : local ? (
          <span className="text-content-tertiary">local — GPU time, not money</span>
        ) : metered === false ? (
          <span className="text-content-tertiary">unmetered — no counts stated</span>
        ) : null}
        {unrecorded && <span className="text-warning">not recorded in the ledger</span>}
        {duration && <span className="font-mono text-content-tertiary">{duration}</span>}
        {error && <span className="text-danger">{error}</span>}
      </div>
    )
  }

  if (span.kind === 'tool') {
    // Two states only: the call ran (ok) or it did not (error). There is no
    // third "waiting on someone" state — nothing a tool call does waits on
    // the operator, so a span with ok=false is a call that failed, full stop.
    const ok = span.meta.ok === true
    const failed = span.meta.ok === false
    const args = viewArgs(span.meta.args_redacted)
    const resultHead = typeof span.meta.result_head === 'string' ? span.meta.result_head : null
    // Only the two file-scoped workspace tools carry a path worth opening,
    // and only the object shape of args_redacted actually has one — the
    // clipped-string shape (oversized/unparseable calls) has nothing to
    // extract, so this is null there and no link renders. A plain <a>
    // rather than a router <Link>: this drill-in has no Router context in
    // its own tests, and a same-origin navigation to another route works
    // fine as a normal anchor.
    const workspacePath = isWorkspacePathTool(span.name)
      ? workspacePathFrom(span.meta.args_redacted)
      : null
    return (
      <div className="space-y-1.5 text-caption">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono text-content-primary">{span.name}</span>
          {workspacePath && (
            <a
              href={`/files?path=${encodeURIComponent(workspacePath)}`}
              className="font-mono text-micro text-accent hover:underline"
            >
              {workspacePath}
            </a>
          )}
          {ok && (
            <Badge color="success" size="sm">
              ok
            </Badge>
          )}
          {failed && (
            <Badge color="danger" size="sm">
              error
            </Badge>
          )}
          {duration && <span className="font-mono text-content-tertiary">{duration}</span>}
        </div>
        {args.kind === 'kv' && (
          <div className="font-mono text-micro text-content-secondary space-y-0.5 pl-0.5">
            {args.lines.map((line, i) => (
              <div key={i}>{line}</div>
            ))}
          </div>
        )}
        {args.kind === 'raw' && (
          <Code inline={false} className="text-micro">
            {args.text}
          </Code>
        )}
        {resultHead && (
          <Code inline={false} className={clsx('text-micro', failed && 'border border-danger/30')}>
            {resultHead}
          </Code>
        )}
      </div>
    )
  }

  // memory_recall / memory_ingest / anything future — a generic fallback
  // rather than silently dropping a span kind this page does not know
  // about yet.
  return (
    <div className="flex items-center gap-2 text-caption">
      <Badge size="sm">{span.kind}</Badge>
      {span.name && <span className="font-mono text-content-secondary">{span.name}</span>}
      {duration && <span className="font-mono text-content-tertiary">{duration}</span>}
    </div>
  )
}
