import type { SemanticColor } from '../../lib/design-tokens'
import type { Notice, NoticeState } from '../../lib/api'
import { deliveryLines, type DeliveryLine } from '../schedules/schedulesFormat'

/**
 * Pure presentation logic for the Inbox — kept apart from the page, as
 * schedulesFormat.ts and agentsFormat.ts are, so each property the page has
 * to get right is one function a test can pin down without rendering
 * anything.
 *
 * Two rules run through the whole file, both from the house rules this slice
 * was built under:
 *
 * * **Nothing here authorizes anything.** Muting is a NOISE preference and
 *   `seen` is a read receipt (owner ruling 2026-09-03) — the words this file
 *   produces for those two buttons say exactly that, so the page cannot
 *   quietly grow an approve/deny vocabulary it has no right to.
 * * **Nothing here invents a fact.** A delivery that failed shows the
 *   server's reason; a notice she acted on with no words says it has none
 *   rather than filling the gap; an unknown state renders verbatim rather
 *   than being relabelled into one this file recognises.
 */

/**
 * `notices.state` → the badge that says whether he was told. Plain words
 * rather than the column's own, because "raised" is a database state and
 * "nobody has told you yet" is the fact it stands for. A state this map has
 * not met renders verbatim and neutral, never relabelled.
 */
export function stateBadge(state: NoticeState | string): { label: string; color: SemanticColor } {
  if (state === 'raised') return { label: 'not told yet', color: 'neutral' }
  if (state === 'delivered') return { label: 'told you', color: 'success' }
  if (state === 'failed') return { label: 'not delivered', color: 'danger' }
  if (state === 'seen') return { label: 'read', color: 'neutral' }
  if (state === 'muted') return { label: 'muted', color: 'warning' }
  return { label: state, color: 'neutral' }
}

/**
 * Whether the CONDITION is still true — orthogonal to `state`, which is
 * about the news. A cleared row is a check that RAN and stopped finding
 * these facts, which is the good outcome and is coloured as one; a live row
 * is a standing fault.
 */
export function livePill(notice: Pick<Notice, 'cleared_at'>): {
  live: boolean
  label: string
  color: SemanticColor
  title: string
} {
  if (notice.cleared_at === null) {
    return {
      live: true,
      label: 'still true',
      color: 'warning',
      title: 'a check has not yet stopped finding these facts',
    }
  }
  return {
    live: false,
    label: 'cleared',
    color: 'success',
    title: 'a check that ran stopped finding these facts',
  }
}

/**
 * Per-channel delivery verdicts, in the SAME three-verdict vocabulary the
 * Schedules page renders — `deliveryLines` is reused rather than reimplemented
 * because core builds one receipt shape for a firing and a notice alike (see
 * services/core/app/delivery.py), and two renderings of one fact drift.
 *
 * The one addition: a row in state `failed` must always say WHY, so when the
 * receipt carries no failed line of its own the stated reason is appended as
 * one. A receipt that is simply empty (nothing has been attempted yet) yields
 * no lines at all — the page states that absence itself rather than having a
 * line here pretend a rung reported.
 */
export function deliveryVerdicts(
  notice: Pick<Notice, 'delivery' | 'state' | 'failed_reason'>,
): DeliveryLine[] {
  const lines = deliveryLines(notice.delivery)
  const reason = notice.failed_reason?.trim()
  if (notice.state === 'failed' && reason && !lines.some(line => line.verdict === 'failed')) {
    lines.push({ channel: 'delivery', verdict: 'failed', text: reason })
  }
  return lines
}

/**
 * What she DID about it, and the turn that is the account of it. Derived from
 * the `acted` flag alone — core sets the flag, the note and the turn id in
 * one write and refuses a blank note, so a row that says she acted but
 * carries no words is a shape that should not exist and is shown as the gap
 * it is rather than papered over. `turnId` is null when the row names no
 * turn, and the page then renders no link rather than one that opens nothing.
 */
export function actedLine(
  notice: Pick<Notice, 'acted' | 'acted_note' | 'acted_turn_id'>,
): { text: string; turnId: string | null } | null {
  if (!notice.acted) return null
  const note = notice.acted_note?.trim()
  return {
    text: note
      ? note
      : 'she recorded acting on this but left no words — the trace is the only account',
    turnId: notice.acted_turn_id,
  }
}

/**
 * How many times the checks have returned these exact facts, said only when
 * it is more than once. A SIGHTING count, not a delivery count: it says the
 * world kept being this way, never that anybody was told again.
 */
export function sightingsWords(repeats: number): string | null {
  if (!Number.isFinite(repeats) || repeats <= 1) return null
  return `seen ${repeats} times by the checks`
}

/**
 * The mute button's words. A mute silences these exact facts until they
 * change — the row keeps standing and the checks keep folding onto it. It is
 * a noise preference and the title says so in the button itself, because
 * this page reads and silences and never authorizes.
 */
export function muteWords(notice: Pick<Notice, 'state'>): {
  muted: boolean
  label: string
  title: string
  /** What a click asks for — the value handed to muteNotice. */
  next: boolean
} {
  if (notice.state === 'muted') {
    return {
      muted: true,
      label: 'Unmute',
      title: 'let these facts speak again — the next digest may carry them',
      next: false,
    }
  }
  return {
    muted: false,
    label: 'Mute',
    title:
      'stop telling you about these exact facts until they change — a noise preference, never permission',
    next: true,
  }
}

/**
 * The read-receipt button's words. `seen_at` rather than the state is what
 * "read" means here, exactly as the server's unseen count reads it: marking a
 * failed delivery seen leaves it `failed` on purpose, because opening the row
 * does not make a push that never landed have landed.
 */
export function readWords(notice: Pick<Notice, 'seen_at'>): {
  read: boolean
  label: string
  title: string
} {
  if (notice.seen_at !== null) {
    return {
      read: true,
      label: 'Seen',
      title: 'you have opened this — a read receipt, nothing more',
    }
  }
  return {
    read: false,
    label: 'Mark seen',
    title: 'a read receipt, nothing more — it permits nothing and forbids nothing',
  }
}

/**
 * The derived facts the fingerprint was computed from, as display lines. This
 * is the evidence behind the title, so it is rendered in the order and the
 * words core returned: a value that is not a string is shown as its JSON
 * rather than being coerced into prose that could read as something it is
 * not. An empty facts object yields no lines.
 */
export function factLines(facts: Record<string, unknown>): { key: string; value: string }[] {
  return Object.entries(facts ?? {}).map(([key, value]) => ({
    key,
    // String() around the stringify because JSON.stringify(undefined) is not
    // a string, and a fact that came back as nothing should read as
    // "undefined" rather than crash the row it belongs to.
    value: typeof value === 'string' ? value : String(JSON.stringify(value)),
  }))
}
