import type { ReactNode } from 'react'

/**
 * Machine text, formatted at the edge (UI review R12, 2026-10-11). The
 * server's sentences stay the server's — these only change how a timestamp
 * or an error READS, and the raw value is always one hover away (`title`),
 * never dropped. Nothing here guesses: an error that matches no known cause
 * is shortened, not renamed.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// An ISO date, optionally with a time, fraction and zone. Word-bounded so a
// version string or an id with digits in it is not taken for a date.
const STAMP = /\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g

/** "12 Oct, 12:10 PM" for a time; "11 Sep" for a date; the year only when
 *  it is not this one. Local time, because the reader is local. */
export function formatStamp(raw: string, now = new Date()): string {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw)
  if (dateOnly) {
    const [y, m, d] = raw.split('-').map(Number)
    return `${d} ${MONTHS[m - 1]}${y !== now.getFullYear() ? ` ${y}` : ''}`
  }
  const t = new Date(raw)
  if (Number.isNaN(t.getTime())) return raw
  const year = t.getFullYear() !== now.getFullYear() ? ` ${t.getFullYear()}` : ''
  const time = t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return `${t.getDate()} ${MONTHS[t.getMonth()]}${year}, ${time}`
}

/** A server sentence with each timestamp inside it made readable. */
export function HumanText({ text, now }: { text: string; now?: Date }) {
  const parts: ReactNode[] = []
  let last = 0
  for (const m of text.matchAll(STAMP)) {
    const i = m.index ?? 0
    if (i > last) parts.push(text.slice(last, i))
    parts.push(
      <time key={i} dateTime={m[0]} title={m[0]}>
        {formatStamp(m[0], now)}
      </time>,
    )
    last = i + m[0].length
  }
  if (last === 0) return <>{text}</>
  if (last < text.length) parts.push(text.slice(last))
  return <>{parts}</>
}

/** The cause of a refusal in a word or two; anything unrecognised is cut to
 *  a clause, never renamed into a cause it might not be. */
export function shortReason(raw: string): string {
  if (/could not reach|connect(?:ion)? ?(?:timeout|error|refused)|connecttimeout|timed out|unreachable/i.test(raw)) return 'unreachable'
  if (/\b402\b|insufficient credits|out of credits/i.test(raw)) return 'out of credits'
  if (/invalid x-api-key|invalid api key|\b401\b|unauthori[sz]ed/i.test(raw)) return 'key rejected'
  if (/\b429\b|rate.?limit/i.test(raw)) return 'rate limited'
  const clean = raw.replace(/\s+/g, ' ').trim()
  return clean.length > 40 ? `${clean.slice(0, 39).trimEnd()}…` : clean
}

export interface Refusal {
  at: string
  provider: string
  model: string
  status: number | null
  purpose: string | null
  error: string | null
}

export interface RefusalGroup {
  provider: string
  reason: string
  purpose: string | null
  count: number
  models: string[]
  latest: string
  /** One full message from the group, for the hover. */
  raw: string
}

/** Refusals folded by provider, cause and purpose: twenty "could not reach
 *  dell" lines are one line saying 20. Newest group first. */
export function groupRefusals(rows: Refusal[]): RefusalGroup[] {
  const groups = new Map<string, RefusalGroup>()
  for (const r of rows) {
    const reason = r.error ? shortReason(r.error) : `status ${r.status ?? '?'}`
    const key = `${r.provider}\u0000${reason}\u0000${r.purpose ?? ''}`
    const g = groups.get(key)
    if (!g) {
      groups.set(key, { provider: r.provider, reason, purpose: r.purpose, count: 1, models: [r.model], latest: r.at, raw: r.error ?? '' })
      continue
    }
    g.count++
    if (!g.models.includes(r.model)) g.models.push(r.model)
    if (r.at > g.latest) {
      g.latest = r.at
      g.raw = r.error ?? g.raw
    }
  }
  return [...groups.values()].sort((a, b) => (a.latest < b.latest ? 1 : a.latest > b.latest ? -1 : 0))
}
