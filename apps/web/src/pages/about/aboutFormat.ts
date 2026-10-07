import type { SemanticColor } from '../../lib/design-tokens'
import type { AboutAgent, AboutBuild, AboutModelMachine, AboutService, AboutUpdateAttempt, AboutUpdates } from '../../lib/api'

/** The update check's one-line verdict and its colour. "unknown" is never
 *  drawn as up to date: a check that could not run says why instead. */
export function updateHeadline(u: AboutUpdates, branch: string | null): { text: string; color: SemanticColor } {
  const on = branch ?? 'the default branch'
  switch (u.state) {
    case 'up_to_date':
      return { text: `Up to date with ${on}`, color: 'success' }
    case 'available':
      return { text: `${u.behind_by} new ${plural(u.behind_by ?? 0, 'commit')} on ${on}`, color: 'warning' }
    case 'local_ahead':
      return {
        text: `Running ${u.ahead_by} ${plural(u.ahead_by ?? 0, 'commit')} ${on} does not have — nothing to pull`,
        color: 'info',
      }
    case 'diverged':
      return {
        text: `Diverged: ${u.behind_by} to pull, ${u.ahead_by} here that ${on} does not have`,
        color: 'warning',
      }
    default:
      return { text: 'Could not check for updates', color: 'neutral' }
  }
}

/** What to call this build, most specific first. */
export function buildLabel(b: AboutBuild): string {
  if (!b.commit) return 'Unknown build'
  return b.version ?? b.short ?? b.commit
}

export function agentState(a: AboutAgent): { text: string; color: SemanticColor } {
  if (a.connected) return { text: 'Connected', color: 'success' }
  return { text: 'Not connected', color: 'neutral' }
}

/** The gateway's own four states (gateway engines.STATES), in words. */
export function machineState(m: AboutModelMachine): { text: string; color: SemanticColor } {
  switch (m.state) {
    case 'ready':
      return { text: 'Ready', color: 'success' }
    case 'unreachable':
      return { text: 'Unreachable', color: 'danger' }
    case 'switched_off':
      return { text: 'Switched off', color: 'neutral' }
    case 'unobserved':
      return { text: 'Not checked yet', color: 'neutral' }
    default:
      return { text: m.state ?? 'Unknown', color: 'neutral' }
  }
}

export function serviceColor(s: AboutService): SemanticColor {
  return s.state === 'up' ? 'success' : 'danger'
}

export function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`
}

/** The latest update attempt's state. `sent` is "started", never "updating
 *  succeeded": only the installer's report to the new core confirms it. */
export function attemptState(a: AboutUpdateAttempt): { text: string; color: SemanticColor } {
  const span = `${a.from_commit.slice(0, 7)} → ${(a.to_commit ?? '?').slice(0, 7)}`
  switch (a.outcome) {
    case 'sent':
      return { text: `Updating ${span} — started, not yet reported back`, color: 'info' }
    case 'confirmed':
      return { text: `Updated ${span}`, color: 'success' }
    case 'failed':
      return { text: `Update ${span} failed`, color: 'danger' }
    case 'refused':
      return { text: `Update ${span} did not start`, color: 'warning' }
    case 'up_to_date':
      return { text: 'Last update: nothing to install', color: 'neutral' }
    case 'not_confirmed':
      return { text: `Update ${span} was never confirmed`, color: 'warning' }
  }
}

/** Whether an update can be started from the page right now: something to
 *  pull and nothing already in flight. The server still decides; this only
 *  keeps a button from offering what it would refuse on its face. */
export function canStartUpdate(u: AboutUpdates, last: AboutUpdateAttempt | null): boolean {
  return u.state === 'available' && last?.outcome !== 'sent'
}
