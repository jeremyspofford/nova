import type { Machine } from '../../lib/api'
import type { SemanticColor } from '../../lib/design-tokens'

/** How a machine's state reads on its tile: the gateway's four states in
 * words, and any other state in the gateway's own word rather than hidden —
 * with the gateway's reason beside it when it gave one. */
export function machineStateLabel(m: Pick<Machine, 'state' | 'reason'>): { text: string; color: SemanticColor } {
  switch (m.state) {
    case 'ready':
      return { text: 'ready', color: 'success' }
    case 'switched_off':
      return { text: 'not running chat models', color: 'neutral' }
    case 'unreachable':
      return { text: m.reason ? `not answering — ${m.reason}` : 'not answering', color: 'danger' }
    case 'unobserved':
      return { text: 'not checked yet', color: 'neutral' }
    default:
      return { text: m.reason ? `${m.state} — ${m.reason}` : m.state, color: 'neutral' }
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
