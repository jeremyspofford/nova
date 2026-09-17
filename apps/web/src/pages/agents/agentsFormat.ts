import type { SemanticColor } from '../../lib/design-tokens'
import type { AgentDeleted, AgentState, AgentTimerRef, StoredMessage } from '../../lib/api'
import { usd } from '../spend/spendFormat'

/**
 * Pure presentation logic for the Agents pages — kept apart from the
 * components, as activityFormat.ts is, so each property the pages must get
 * right (a state that is only ever the server's derived fact, a spend figure
 * that is never a guessed 0, a delete confirmation that names what it will
 * pause) is one function a test can pin down without rendering anything.
 */

/** `state` is DERIVED server-side from the process-local DOING map (see
 * agents_api.py): working means an open turn THIS process is running right
 * now. The pill says what it is doing when the map has a word for it, and
 * pulses — a working agent should look alive. Idle is idle, no pulse. */
export function statePill(state: AgentState): { label: string; color: SemanticColor; pulse: boolean } {
  if (!state.working) return { label: 'idle', color: 'neutral', pulse: false }
  return {
    label: state.doing ? `working · ${state.doing}` : 'working',
    color: 'accent',
    pulse: true,
  }
}

/**
 * The month's spend for the agent's role, as the gateway's ledger states it.
 * A number is money (a real 0 is "$0.00" — the agent ran nothing this month);
 * null is a ledger that could not be read, said as "unreadable" with the
 * server's reason as the title — never shown as 0, because 0 is a fact and
 * unknown is not.
 */
export function spendWords(
  spent: number | null,
  note: string | null,
): { text: string; unreadable: boolean; title: string | undefined } {
  if (typeof spent === 'number') return { text: usd(spent), unreadable: false, title: undefined }
  return { text: 'spend unreadable', unreadable: true, title: note ?? undefined }
}

/** The monthly cap as words: a figure per month, or uncapped. */
export function capWords(cap: number | null): string {
  return cap === null ? 'uncapped' : `${usd(cap)} / month`
}

/**
 * The delete confirmation's text, derived from the timers the server says
 * are bound to the agent — so the dialog names exactly what a delete will
 * pause, by title, and says plainly when nothing is bound. What stays
 * (folder, notes, log) is stated every time: a delete is not a purge.
 */
export function deleteDescription(name: string, timers: AgentTimerRef[]): string {
  const stays = 'Its folder, notes and log stay.'
  if (timers.length === 0) return `Delete ${name}? No timers are bound to it. ${stays}`
  const noun = timers.length === 1 ? 'scheduled timer' : 'scheduled timers'
  const titles = timers.map(t => t.title).join(', ')
  return `Delete ${name}? This will pause ${timers.length} ${noun}: ${titles}. ${stays}`
}

/**
 * The one-line summary shown on the roster after a delete, composed from the
 * server's structured answer: which timers it paused (by title) and its own
 * `remains` sentence about what was left in place. Nothing here is invented
 * — an empty paused list reads "no timers were bound to it", never "paused
 * 0 timers" dressed as an action.
 */
export function deletedSummary(result: AgentDeleted): string {
  const paused =
    result.paused_timers.length === 0
      ? 'no timers were bound to it'
      : `paused ${result.paused_timers.length} ${
          result.paused_timers.length === 1 ? 'timer' : 'timers'
        } (${result.paused_timers.map(t => t.title).join(', ')})`
  return `Deleted ${result.deleted} — ${paused}; ${result.remains}.`
}

/** One delegation as the log conversation records it: the brief Nova handed
 * the agent (the user row) and the report(s) it wrote back (the assistant
 * rows that follow). `brief` is null only for a report with no brief before
 * it — a row shape the log should never hold, shown rather than dropped. */
export interface LogPair {
  brief: StoredMessage | null
  reports: StoredMessage[]
}

/**
 * The log's rows, oldest first, folded into brief → report pairs: a user row
 * opens a pair, every assistant row attaches to the pair that is open. A
 * brief that never got a report (the delegation is still running, or it
 * failed before a reply) keeps an EMPTY reports list — visible as such.
 */
export function logPairs(messages: StoredMessage[]): LogPair[] {
  const pairs: LogPair[] = []
  for (const message of messages) {
    if (message.role === 'user') {
      pairs.push({ brief: message, reports: [] })
      continue
    }
    const open = pairs[pairs.length - 1]
    if (open === undefined) {
      pairs.push({ brief: null, reports: [message] })
    } else {
      open.reports.push(message)
    }
  }
  return pairs
}

/** The routing role an agent's turn walked, when it was an agent's — the
 * Activity page shows it only for `agent_<name>` roles (a built-in role is
 * the kind's own and already said by the kind column). */
export function agentRole(role: string | null | undefined): string | null {
  return typeof role === 'string' && role.startsWith('agent_') ? role : null
}
