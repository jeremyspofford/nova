import type { Machine } from '../../lib/api'
import type { SemanticColor } from '../../lib/design-tokens'

/** How a machine's state reads on its tile: the gateway's four states in
 * words, and any other state in the gateway's own word rather than hidden —
 * with the gateway's reason beside it when it gave one. `line` is true when
 * the label is a sentence (a reason, or what the switch does): a badge is
 * one fixed line and cannot wrap, so the tile gives a sentence its own line.
 *
 * `switched_off` says only what the gateway enforces: chat routing passes
 * over the machine (the role walk is the switch's only reader). It never
 * says the machine runs no models — a call outside any role is still served
 * there, and a model already loaded stays loaded. */
export function machineStateLabel(m: Pick<Machine, 'state' | 'reason'>): { text: string; color: SemanticColor; line: boolean } {
  switch (m.state) {
    case 'ready':
      return { text: 'ready', color: 'success', line: false }
    case 'switched_off':
      return { text: 'switched off — chat routing passes over it', color: 'neutral', line: true }
    case 'unreachable':
      return m.reason
        ? { text: `not answering — ${m.reason}`, color: 'danger', line: true }
        : { text: 'not answering', color: 'danger', line: false }
    case 'unobserved':
      return { text: 'not checked yet', color: 'neutral', line: false }
    default:
      return m.reason
        ? { text: `${m.state} — ${m.reason}`, color: 'neutral', line: true }
        : { text: m.state, color: 'neutral', line: false }
  }
}

export function lifecycleLabel(lifecycle: string): string {
  if (lifecycle === 'always_on') return 'always on'
  if (lifecycle === 'wake_on_lan') return 'wakes on LAN'
  return lifecycle
}

/** The sentence a tile shows when a write did not take: what was asked, and
 * what the machine reads back. Null when they agree. */
export function readBackMismatch(name: string, asked: boolean, stored: Pick<Machine, 'serving'>): string | null {
  if (stored.serving === asked) return null
  const word = (on: boolean) => (on ? 'on' : 'off')
  return `Asked to turn chat models ${word(asked)} on ${name}, but it reads back ${word(stored.serving)}.`
}
