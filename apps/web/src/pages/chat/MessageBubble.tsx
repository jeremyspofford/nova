import { memo } from 'react'
import { AlertTriangle, BellRing, CalendarClock, Cpu, Loader2, Unplug } from 'lucide-react'
import { Markdown } from '../../components/Markdown'
import type { ErrorRow, MessageRow } from './chatReducer'

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

  return (
    <div className="flex gap-3 items-start" data-testid="message-assistant">
      <div className="shrink-0 mt-0.5">
        <div className="h-6 w-6 rounded-full flex items-center justify-center text-[10px] font-semibold select-none bg-accent-dim text-accent">
          N
        </div>
      </div>
      <div className="flex-1 min-w-0 pb-1">
        {row.turnKind !== null && <TurnKindLabel kind={row.turnKind} />}
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
        {row.activity && <ActivityLine activity={row.activity} />}
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
