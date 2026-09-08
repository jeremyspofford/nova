import type { SpendReport } from '../../lib/api'

/**
 * Pure formatting for the Spend page. Every dollar figure on the page came
 * from a ledger row that carried its basis; these helpers only choose how to
 * show a number, never whether to invent one: a null stays "not stated".
 */
export const BASIS_WORDS: Record<string, string> = {
  'provider-reported': 'reported by the provider',
  'listing-price': "from the provider's listing",
  'curated-price': 'from the dated price list',
  'owner-price': 'the price you entered',
}

export function usd(value: number | null | undefined, digits = 2): string {
  if (typeof value !== 'number') return 'not stated'
  if (value > 0 && value < 0.01 && digits === 2) return `$${value.toFixed(4)}`
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
}

export function gpuMinutes(seconds: number | null | undefined): string {
  if (typeof seconds !== 'number') return 'not stated'
  return `${(seconds / 60).toFixed(1)} min`
}

export function tokens(n: number | null | undefined): string {
  if (typeof n !== 'number') return '—'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

/** Percent of a cap used, clamped; null when there is no cap. */
export function capPercent(spent: number | null | undefined, cap: number | null | undefined): number | null {
  if (typeof cap !== 'number' || cap <= 0) return null
  return Math.max(0, Math.min(100, Math.round(((spent ?? 0) / cap) * 100)))
}

export interface DayBar {
  day: string
  usd: number
  calls: number
  gpu_seconds: number
  /** The day's models, each with its share — the segments of a stacked bar. */
  models: { key: string; local: boolean; usd: number; calls: number; gpu_seconds: number }[]
}

/** The by-day rows padded so every day of the window has a bar (a day with
 * no calls is a zero-height bar, which IS a fact: nothing was spent). */
export function dayBars(report: SpendReport): DayBar[] {
  const by = new Map(report.by_day.map(d => [d.day, d]))
  const out: DayBar[] = []
  const start = new Date(report.since.slice(0, 10) + 'T00:00:00Z')
  const end = new Date(report.until.slice(0, 10) + 'T00:00:00Z')
  for (let t = start.getTime(); t <= end.getTime(); t += 86_400_000) {
    const day = new Date(t).toISOString().slice(0, 10)
    const row = by.get(day)
    out.push({
      day,
      usd: row?.usd ?? 0,
      calls: row?.calls ?? 0,
      gpu_seconds: row?.gpu_seconds ?? 0,
      models: (row?.models ?? []).map(m => ({ key: m.key, local: m.local, usd: m.usd ?? 0, calls: m.calls, gpu_seconds: m.gpu_seconds })),
    })
  }
  return out
}

/** One colour per model for the whole window, assigned by how much the
 * model was used (most first) so the key reads top-down like the bars.
 * The palette is the app's own semantic classes; past eight models the
 * colours repeat and the key says so. */
export const MODEL_PALETTE = [
  'bg-accent',
  'bg-info',
  'bg-success',
  'bg-warning',
  'bg-violet-500',
  'bg-pink-500',
  'bg-teal-500',
  'bg-orange-500',
]

export type ChartMeasure = 'usd' | 'calls'

export function modelKey(bars: DayBar[], measure: ChartMeasure): { key: string; local: boolean; total: number; colour: string }[] {
  const totals = new Map<string, { local: boolean; total: number }>()
  for (const bar of bars) {
    for (const m of bar.models) {
      const entry = totals.get(m.key) ?? { local: m.local, total: 0 }
      entry.total += measure === 'usd' ? m.usd : m.calls
      totals.set(m.key, entry)
    }
  }
  return Array.from(totals, ([key, v]) => ({ key, local: v.local, total: v.total }))
    .sort((a, b) => b.total - a.total || a.key.localeCompare(b.key))
    .map((entry, i) => ({ ...entry, colour: MODEL_PALETTE[i % MODEL_PALETTE.length] }))
}

export const PURPOSE_LABEL: Record<string, string> = {
  chat: 'Chat',
  scheduled: 'Scheduled tasks',
  judge: 'Quality judging',
  redirect: 'Honesty redirects',
  eval: 'Quality suite',
  probe: 'Probes',
  verify: 'Key checks',
  reminder: 'Reminders',
  job: 'Jobs',
  unattributed: 'Unattributed',
}

export function purposeLabel(key: string | null): string {
  if (!key) return 'Unattributed'
  return PURPOSE_LABEL[key] ?? key
}
