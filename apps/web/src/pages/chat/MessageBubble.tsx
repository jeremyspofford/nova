import { memo, useState, type ReactNode } from 'react'
import { Link, useInRouterContext } from 'react-router-dom'
import {
  AlertTriangle,
  BellRing,
  Bot,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronRight,
  Cpu,
  Loader2,
  Unplug,
} from 'lucide-react'
import { Badge } from '../../components/ui'
import { Markdown } from '../../components/Markdown'
import type { Delegation } from '../../lib/api'
import { DELEGATE_TOOL, type ErrorRow, type LiveDelegation, type MessageRow } from './chatReducer'

/**
 * The tool loop's transient progress line — {"activity":{tool,status,
 * reason?}} frames (chat.py, forward-compat'd by streamChat.ts) turned
 * into a subtle, in-place indicator on the bubble that is still streaming.
 * It is never the durable record: nothing here is persisted, and the
 * Activity page (task 3's other half) is where a tool call's actual result
 * lives after the fact. 'ok' never reaches this component at all — the
 * reducer clears the marker back to null the moment a call resolves
 * cleanly.
 *
 * An 'error' status here is a call that FINISHED with a stated failure —
 * dispatch() never lets an executor throw past it (app/tools/__init__.py).
 * "did not finish" was a claim this line could not back: the owner's walk
 * 2026-09-02 hit a `device_run tree` refusal ("executable file not found in
 * $PATH") that the model then adapted around and succeeded past, while this
 * line still said the tool never finished. So: show the tool's own stated
 * reason when the frame carries one, and fall back to the honest, unspecific
 * "failed" — never "did not finish", which claims a cut-off this status
 * never represents (a genuinely interrupted stream is the separate
 * `row.interrupted` case below, driven by the `interrupted` StreamEvent).
 */
function ActivityLine({ activity }: { activity: NonNullable<MessageRow['activity']> }) {
  const failed = activity.status === 'error'
  return (
    <p
      data-testid="activity-line"
      className={`mt-1.5 inline-flex items-center gap-1.5 text-caption ${
        failed ? 'text-danger' : 'text-content-tertiary'
      }`}
    >
      {failed ? (
        <AlertTriangle size={12} className="shrink-0" />
      ) : (
        <Loader2 size={12} className="shrink-0 animate-spin" />
      )}
      {failed
        ? activity.reason
          ? `${activity.tool}: ${activity.reason}`
          : `${activity.tool} failed`
        : activity.status === 'progress' && activity.detail
          ? `using ${activity.tool}… ${activity.detail}`
          : `using ${activity.tool}…`}
    </p>
  )
}

/**
 * The label an assistant row earns when a timer firing wrote it (S9): a
 * `reminder` (code delivered his own words — no model) or a `scheduled` turn
 * (an instruction she ran while nobody was watching). Keyed by `turns.kind`
 * as GET .../messages derived it onto the row — never a stored flag, never
 * inferred from the text, so a reply that merely SAYS "Reminder:" earns
 * nothing, and a kind this map has not met ('chat', 'job', anything future)
 * shows nothing rather than a guess.
 */
const TURN_KIND_LABEL: Record<string, { label: string; Icon: typeof BellRing }> = {
  reminder: { label: 'Reminder', Icon: BellRing },
  scheduled: { label: 'Scheduled', Icon: CalendarClock },
}

function TurnKindLabel({ kind }: { kind: string }) {
  const entry = TURN_KIND_LABEL[kind]
  if (!entry) return null
  return (
    <p
      data-testid="turn-kind-label"
      title={`this row was written by a ${kind} timer firing — see Schedules`}
      className="mb-1 inline-flex items-center gap-1 text-micro font-medium uppercase tracking-wider text-accent"
    >
      <entry.Icon size={11} className="shrink-0" />
      {entry.label}
    </p>
  )
}

/**
 * A link to an agent's page. A Link needs a Router; this bubble is also
 * rendered bare in its own tests, where a plain anchor is the honest
 * fallback (the ModelsSection idiom).
 */
function AgentLink({
  name,
  title,
  className,
  testId,
  children,
}: {
  name: string
  title: string
  className: string
  testId?: string
  children: ReactNode
}) {
  const inRouter = useInRouterContext()
  const to = `/agents/${encodeURIComponent(name)}`
  return inRouter ? (
    <Link to={to} title={title} className={className} data-testid={testId}>
      {children}
    </Link>
  ) : (
    <a href={to} title={title} className={className} data-testid={testId}>
      {children}
    </a>
  )
}

/**
 * The label an assistant row earns when an AGENT wrote it (S12): an
 * `@coder …` message runs the whole turn as the agent, and the row says so.
 * Keyed by `row.agent` — the meta frame's `agent` live, the turn's
 * `agent_id` joined to its name on a fetched row — never read off the
 * text, so a reply that merely says "coder here" earns nothing. Sits beside
 * TurnKindLabel; an agent's scheduled turn earns both.
 */
function AgentLabel({ name }: { name: string }) {
  return (
    <p
      data-testid="agent-label"
      className="mb-1 inline-flex items-center text-micro font-medium uppercase tracking-wider text-accent"
    >
      <AgentLink
        name={name}
        title={`this reply was written by the agent ${name} — see /agents/${name}`}
        className="inline-flex items-center gap-1 hover:underline"
      >
        <Bot size={11} className="shrink-0" />
        {name}
      </AgentLink>
    </p>
  )
}

/** One relayed step's icon, in the activity marker's visual language: a
 * spinner only for the step still running, a check or a warning for one
 * the child stated a result for, a plain dot for anything else. */
function StepIcon({ status, spinning }: { status: string; spinning: boolean }) {
  if (status === 'error') return <AlertTriangle size={11} className="shrink-0" />
  if (status === 'ok') return <Check size={11} className="shrink-0" />
  if (spinning) return <Loader2 size={11} className="shrink-0 animate-spin" />
  return <span aria-hidden="true" className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-60" />
}

/**
 * A delegation as this store watched it (S12): one collapsed line — "coder
 * is working… (n steps)" — that expands to the child turn's steps as the
 * relay stated them. Finalised by the delegate tool's OWN ok/error frame,
 * never by the child's prose; 'interrupted' is the store's finding that the
 * turn ended with no result stated (see chatReducer's LiveDelegation).
 * `count` includes the steps the row stopped keeping past the cap, so a
 * long delegation still says how long it was.
 */
function DelegationLine({ delegation }: { delegation: LiveDelegation }) {
  const [expanded, setExpanded] = useState(false)
  const who = delegation.agent ?? 'an agent'
  const count = delegation.steps.length + delegation.dropped
  const working = delegation.status === 'working'
  const failed = delegation.status === 'error' || delegation.status === 'interrupted'
  const headline = working
    ? `${who} is working… (${count} ${count === 1 ? 'step' : 'steps'})`
    : delegation.status === 'ok'
      ? `${who} finished`
      : delegation.status === 'error'
        ? `${who} did not finish`
        : `${who} — cut off before a result was stated`
  const last = delegation.steps.length - 1
  return (
    <div data-testid="delegation-line" data-status={delegation.status} className="mt-1.5 text-caption">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(open => !open)}
        className={`inline-flex items-center gap-1.5 transition-colors duration-fast hover:text-content-secondary ${
          failed ? 'text-danger' : 'text-content-tertiary'
        }`}
      >
        {expanded ? (
          <ChevronDown size={12} className="shrink-0" />
        ) : (
          <ChevronRight size={12} className="shrink-0" />
        )}
        {working ? (
          <Loader2 size={12} className="shrink-0 animate-spin" />
        ) : failed ? (
          <AlertTriangle size={12} className="shrink-0" />
        ) : (
          <Check size={12} className="shrink-0" />
        )}
        <span data-testid="delegation-headline">{headline}</span>
      </button>
      {expanded && (
        <ul data-testid="delegation-steps" className="mt-1 ml-5 space-y-0.5">
          {count === 0 && (
            <li className="italic text-content-tertiary">
              {working ? 'no steps reported yet' : 'no steps were reported'}
            </li>
          )}
          {delegation.steps.map((s, i) => (
            <li
              key={i}
              data-testid="delegation-step"
              className={`flex items-center gap-1.5 ${
                s.status === 'error' ? 'text-danger' : 'text-content-tertiary'
              }`}
            >
              <StepIcon
                status={s.status}
                spinning={working && i === last && delegation.dropped === 0}
              />
              <span className="font-mono">{s.step}</span>
              <span> · {s.status}</span>
            </li>
          ))}
          {delegation.dropped > 0 && (
            <li data-testid="delegation-more" className="text-content-tertiary">
              and {delegation.dropped} more
            </li>
          )}
        </ul>
      )}
    </div>
  )
}

const DELEGATION_CHIP_COLOR = { ok: 'success', error: 'danger', interrupted: 'warning' } as const

/**
 * A delegation as the ledger recorded it (S12) — what a reloaded page
 * shows in place of the live line. `status` and the file count are derived
 * from the child turn's spans (services/core), never from the agent's own
 * report; the chip links to the agent's page, where the trace is.
 */
function DelegationChip({ delegation }: { delegation: Delegation }) {
  const n = delegation.files.length
  return (
    <AgentLink
      name={delegation.agent}
      testId="delegation-chip"
      title={`Nova delegated to ${delegation.agent} — child turn ${delegation.agent_turn_id}, see /agents/${delegation.agent}`}
      className="inline-flex transition-opacity duration-fast hover:opacity-80"
    >
      <Badge size="sm" color={DELEGATION_CHIP_COLOR[delegation.status] ?? 'neutral'}>
        <Bot size={10} className="shrink-0" />
        {`${delegation.agent} · ${delegation.status} · ${n} ${n === 1 ? 'file' : 'files'}`}
      </Badge>
    </AgentLink>
  )
}

function LoadingDots() {
  return (
    <span className="inline-flex items-center gap-1 py-1" aria-label="waiting for the model">
      <span className="h-1.5 w-1.5 rounded-full bg-accent animate-bounce [animation-delay:-0.3s]" />
      <span className="h-1.5 w-1.5 rounded-full bg-accent animate-bounce [animation-delay:-0.15s]" />
      <span className="h-1.5 w-1.5 rounded-full bg-accent animate-bounce" />
    </span>
  )
}

export const MessageBubble = memo(function MessageBubble({ row }: { row: MessageRow }) {
  if (row.role === 'user') {
    return (
      <div className="flex justify-end" data-testid="message-user">
        <div className="max-w-[85%] md:max-w-[75%]">
          <div className="glass-card bg-surface-elevated border border-border dark:border-white/[0.08] text-content-primary whitespace-pre-wrap rounded-tl-2xl rounded-tr-sm rounded-br-2xl rounded-bl-2xl px-4 py-3 text-body leading-relaxed">
            {row.text}
          </div>
        </div>
      </div>
    )
  }

  // The avatar is the writer's initial: the agent's when one wrote the row
  // (S12), Nova's N otherwise.
  const initial = row.agent ? row.agent.charAt(0).toUpperCase() : 'N'
  // Every delegation this store watched on this row, oldest first, the one
  // in flight last. One list (not done + current separately) so a line's
  // expanded state survives the moment its delegation closes and a new one
  // opens after it.
  const delegationLines = row.delegation
    ? [...row.delegationsDone, row.delegation]
    : row.delegationsDone
  // While a delegation works, its own line already says what the delegate
  // tool's marker would ("using delegate_to_agent… coder is working…") —
  // one line, not two. An error marker still shows: it carries the reason.
  const hideActivity =
    row.activity?.tool === DELEGATE_TOOL && row.delegation?.status === 'working'

  return (
    <div className="flex gap-3 items-start" data-testid="message-assistant">
      <div className="shrink-0 mt-0.5">
        <div
          data-testid="assistant-avatar"
          title={row.agent ? `agent ${row.agent}` : 'Nova'}
          className="h-6 w-6 rounded-full flex items-center justify-center text-[10px] font-semibold select-none bg-accent-dim text-accent"
        >
          {initial}
        </div>
      </div>
      <div className="flex-1 min-w-0 pb-1">
        {(row.turnKind !== null || row.agent !== null) && (
          <div className="flex flex-wrap items-center gap-x-2">
            {row.turnKind !== null && <TurnKindLabel kind={row.turnKind} />}
            {row.agent !== null && <AgentLabel name={row.agent} />}
          </div>
        )}
        {/* Her replies are GitHub-flavoured markdown (components/Markdown.tsx:
            sanitised, raw HTML shown as text, never executed). The user's own
            bubble above stays plain pre-wrap text — what the owner typed is
            not markdown and must not be re-interpreted. `break-words` is what
            keeps a long unbroken token (a URL, a hash) from widening the
            column. */}
        <div className="text-body leading-relaxed text-content-primary break-words">
          {row.text ? (
            <Markdown text={row.text} />
          ) : row.streaming && !row.activity ? (
            <LoadingDots />
          ) : null}
        </div>
        {delegationLines.map((delegation, i) => (
          <DelegationLine key={i} delegation={delegation} />
        ))}
        {row.delegations.length > 0 && (
          <p data-testid="delegation-chips" className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {row.delegations.map(delegation => (
              <DelegationChip key={delegation.agent_turn_id} delegation={delegation} />
            ))}
          </p>
        )}
        {row.activity && !hideActivity && <ActivityLine activity={row.activity} />}
        {/* Who answered — `provider:model` as the gateway stated it on this
            turn's trace (S10-pre). Absent, never invented, when the turn is
            still streaming its first round or the server stated none. */}
        {row.servedBy && (
          <p
            data-testid="served-by"
            title="the provider and model that produced this reply, as recorded on the turn's trace"
            className="mt-1.5 inline-flex items-center gap-1.5 text-micro text-content-tertiary font-mono"
          >
            <Cpu size={11} className="shrink-0" />
            {row.servedBy}
            {typeof row.cost === 'number' && (
              <span data-testid="turn-cost" title="this turn's cost as the gateway's ledger recorded it (S10)">
                · ${row.cost < 0.01 ? row.cost.toFixed(4) : row.cost.toFixed(2)}
              </span>
            )}
          </p>
        )}
        {/* The gateway served this turn from a fallback link (S10-2, rail 20:
            no silent fallback) — the reason is the gateway's own sentence. */}
        {row.routeReason && (
          <p
            data-testid="route-fallback"
            className="mt-1 inline-flex items-start gap-1.5 text-micro text-warning"
            title="why this reply came from a different model than the first choice, as the gateway stated it"
          >
            <AlertTriangle size={11} className="mt-0.5 shrink-0" />
            <span>{row.routeReason}</span>
          </p>
        )}
        {/* A cut-off turn keeps whatever really arrived and says it was cut
            off — the alternative is a truncated answer that reads complete. */}
        {row.interrupted && (
          <p className="mt-1.5 inline-flex items-center gap-1.5 text-caption text-warning">
            <Unplug size={12} className="shrink-0" />
            Interrupted — the connection dropped before this reply finished.
          </p>
        )}
      </div>
    </div>
  )
})

/**
 * A failed turn. Deliberately not an assistant bubble: an error rendered as
 * speech is the model appearing to say something it never said.
 */
export function ErrorBubble({ row }: { row: ErrorRow }) {
  return (
    <div
      role="alert"
      data-testid="message-error"
      className="flex items-start gap-2 rounded-sm border border-danger/30 bg-danger-dim px-4 py-3 text-compact text-danger"
    >
      <AlertTriangle size={15} className="shrink-0 mt-0.5" />
      <span className="min-w-0 break-words">{row.reason}</span>
    </div>
  )
}
