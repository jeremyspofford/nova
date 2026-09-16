import type { SemanticColor } from '../../lib/design-tokens'
import type { Notice, NoticeState } from '../../lib/api'
import { deliveryLines, type DeliveryLine } from '../schedules/schedulesFormat'
import { formatRelativeTime } from '../activity/activityFormat'

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
 *   quietly grow an approve/deny vocabulary it has no right to. Since
 *   S25.1.3 the read receipt is ALSO the whole of what marking seen does:
 *   it used to quietly drop the row from the digest as well, which is a
 *   second meaning the button never said out loud.
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
  // No `seen` branch: there is no such state any more (S25.1.3). Whether he
  // has read something is `seen_at`, which `readWords` renders — this badge
  // is only ever about whether he was TOLD.
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
export function muteWords(notice: Pick<Notice, 'silenced'>): {
  muted: boolean
  label: string
  title: string
  /** What a click asks for — the value handed to muteNotice. */
  next: boolean
} {
  // `silenced`, not the state or the `muted_at` stamp: clearing a condition
  // forgets its mute and leaves the stamp behind, and offering to "Unmute" a
  // silence that is already over is a button that does nothing (S25.1).
  if (notice.silenced) {
    return {
      muted: true,
      label: 'Unmute',
      title: 'let this speak again — the next digest may carry it',
      next: false,
    }
  }
  return {
    muted: false,
    label: 'Mute',
    title:
      'stop telling you about this until it clears — a noise preference, never permission',
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
 * Fact key → where that subject lives, and the ONE place the mapping is
 * written (S25.2.2).
 *
 * The temptation was a per-check mapping: `work_paused_timers` knows it
 * emits a timer, so let it say so. That is a list somebody has to maintain,
 * and the day a new check emits `timer_id` it renders as grey text with
 * nothing to say why. Keyed on the FACT instead, every check that names a
 * timer links to it the day it lands, with no edit here.
 *
 * Every route in here is one that actually DOES something with the value —
 * `/schedules?timer=` opens that timer's row, `/activity?turn=` opens that
 * turn's spans, `/agents/<name>` is a page about that agent. A link to a
 * parameter no page reads is a promise the destination does not keep, so a
 * subject whose page cannot yet receive it stays text (see
 * UNLINKED_SUBJECTS).
 */
export const SUBJECT_ROUTES: Record<string, (value: string) => string> = {
  timer_id: id => `/schedules?timer=${encodeURIComponent(id)}`,
  turn_id: id => `/activity?turn=${encodeURIComponent(id)}`,
  agent: name => `/agents/${encodeURIComponent(name)}`,
}

/**
 * The subjects that are DELIBERATELY not links, each with the reason. A new
 * `*_id` fact is one or the other — the core-side guard
 * (tests/test_checks_prose.py) fails on a third option, so a subject cannot
 * become quietly unlinkable by nobody noticing it.
 */
export const UNLINKED_SUBJECTS: Record<string, string> = {
  // A span is a row inside a turn, and the Turn Inspector is already reached
  // by `turn_id` on the same card. Two links to the same place is noise.
  span_id: 'the turn it belongs to is already linked',
  // No page shows one chat message on its own. The thread S24 opens against
  // a notice is the surface that will, and it is reached by its own button.
  message_id: 'no page addresses a single message yet',
  // The review check's own row id, meaningful to the check and to nobody
  // else — it identifies evidence, not a subject he can go and look at.
  row_id: 'identifies evidence, not a place',
}

/**
 * Where a fact's value can be followed, or null if it is just a value.
 *
 * An empty or non-string value never becomes a link: a route built from
 * nothing lands on a page that cannot find what it was asked for, which is
 * worse than plain text.
 */
export function subjectLink(key: string, value: unknown): string | null {
  const route = SUBJECT_ROUTES[key]
  if (route === undefined || typeof value !== 'string' || value.trim() === '') return null
  return route(value)
}

/**
 * Who asked for the silence — or null when nothing is silenced (S25 Q2).
 *
 * A mute SHE made and a mute HE made are different facts, and a silence he
 * did not ask for must not be indistinguishable from one he did: that is
 * how a noise preference quietly becomes something that happened to him.
 * `muted_by` is his person id, or null meaning hers.
 */
export function silenceWords(
  notice: Pick<Notice, 'silenced' | 'muted_by'>,
): { text: string; mine: boolean } | null {
  if (!notice.silenced) return null
  if (notice.muted_by === null) {
    return { text: 'Nova silenced this — it is not being reported to you', mine: false }
  }
  return { text: 'You silenced this', mine: true }
}

/**
 * Whether there is a room to talk in, and what to say when there is not
 * (S25.2.4).
 *
 * A room hangs off the MESSAGE that delivered the notice, so a notice
 * nobody was told about has nowhere to talk — and so does one delivered by
 * a device push alone, which has a `delivered_at` and no chat row. Both are
 * facts about the world rather than decisions about him, which is what
 * makes this the one place a disabled control is honest: the reason names
 * what has not happened yet, never what he may not do.
 */
export function talkWords(notice: Pick<Notice, 'delivered_message_id'>): {
  can: boolean
  title: string
} {
  if (notice.delivered_message_id === null) {
    return {
      can: false,
      title: 'nothing has carried this to you yet, so there is no message to talk under',
    }
  }
  return { can: true, title: 'open the thread on the message that told you' }
}

/**
 * Whether a skill can be drafted from this notice, and the words for it
 * (S25.2.5).
 *
 * DERIVED FROM THE FACTS, not from the check's name. `POST /api/v1/skills
 * {from_notice}` composes a draft by reading `facts.steps` and resolving the
 * turns that walked that procedure NOW — so a notice carrying a list of
 * steps is exactly a notice the backend would accept, and any check that
 * starts emitting `steps` gets the button the day it does. Keying on
 * `skills_repeated_procedure` would have been a second list to maintain,
 * and one that goes wrong silently: the button would be missing rather
 * than broken.
 */
export function draftWords(notice: Pick<Notice, 'facts'>): { can: boolean; title: string } | null {
  const steps = (notice.facts ?? {}).steps
  const usable = Array.isArray(steps) && steps.length > 0 && steps.every(s => typeof s === 'string')
  if (!usable) return null
  return {
    can: true,
    title: `write these ${(steps as string[]).length} steps down as a skill you can run again`,
  }
}

/** A full ISO-8601 instant, which is the only fact shape this file is willing
 * to re-word. A plain `2026-09-11` (the spend check's `day`) and a
 * `2026-09` (its `month`) are deliberately NOT matched: they are already the
 * answer to "which day", and "3 days ago" would be a worse version of it. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/

/**
 * The derived facts the fingerprint was computed from, as display lines. This
 * is the evidence behind the title, so it is rendered in the order and the
 * words core returned: a value that is not a string is shown as its JSON
 * rather than being coerced into prose that could read as something it is
 * not. An empty facts object yields no lines.
 *
 * ONE exception, and it is the other half of S25.2.1. A card's SENTENCE is
 * composed once, when the check first found the condition, and never
 * rewritten — so it can only carry a time that stays true ("since Friday 11
 * September 2026"; see services/core/app/checks/prose.py). The moving
 * version of the same fact — "3d ago" — belongs here, where it is computed
 * at render time against the clock in front of him and is therefore right
 * every time he looks. The exact instant stays on the line as its `title`,
 * because a relative time with no absolute behind it cannot be checked.
 */
export function factLines(
  facts: Record<string, unknown>,
  now: Date = new Date(),
): { key: string; value: string; title?: string; href?: string }[] {
  return Object.entries(facts ?? {}).map(([key, value]) => {
    // A subject the owner can go and look at (S25.2.2). The VALUE is still
    // rendered as core wrote it — a link changes where a click goes, never
    // what the evidence says.
    const href = subjectLink(key, value) ?? undefined
    if (href !== undefined) return { key, value: String(value), href }
    if (typeof value === 'string' && ISO_INSTANT.test(value)) {
      const when = new Date(value)
      // An unparseable string that merely LOOKS like a timestamp is shown
      // verbatim: a fact this page cannot read is still core's fact, and
      // "Invalid Date" would be this page inventing one.
      if (!Number.isNaN(when.getTime())) {
        return { key, value: formatRelativeTime(value, now), title: value }
      }
    }
    return {
      key,
      // String() around the stringify because JSON.stringify(undefined) is not
      // a string, and a fact that came back as nothing should read as
      // "undefined" rather than crash the row it belongs to.
      value: typeof value === 'string' ? value : String(JSON.stringify(value)),
    }
  })
}
