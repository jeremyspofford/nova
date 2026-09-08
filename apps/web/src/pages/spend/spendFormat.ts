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

/** The by-day rows padded so every day of the window has a bar (a day with
 * no calls is a zero-height bar, which IS a fact: nothing was spent). */
export function dayBars(report: SpendReport): { day: string; usd: number; calls: number; gpu_seconds: number }[] {
  const by = new Map(report.by_day.map(d => [d.day, d]))
  const out: { day: string; usd: number; calls: number; gpu_seconds: number }[] = []
  const start = new Date(report.since.slice(0, 10) + 'T00:00:00Z')
  const end = new Date(report.until.slice(0, 10) + 'T00:00:00Z')
  for (let t = start.getTime(); t <= end.getTime(); t += 86_400_000) {
    const day = new Date(t).toISOString().slice(0, 10)
    const row = by.get(day)
    out.push({ day, usd: row?.usd ?? 0, calls: row?.calls ?? 0, gpu_seconds: row?.gpu_seconds ?? 0 })
  }
  return out
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
