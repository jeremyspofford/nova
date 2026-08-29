import type { SemanticColor } from '../../lib/design-tokens'

/**
 * Pure presentation logic for the Activity page — kept apart from the page
 * component so the two properties self-review keeps coming back to (an
 * honest status mapping, and both args_redacted shapes) are each one
 * function a test can pin down without rendering anything.
 */

/** turns.status: 'ok' | 'error' | 'interrupted' | NULL. NULL is not a
 * fourth string the backend sends — it is the *absence* of one, so it
 * arrives here as the JSON `null` a fetch gives back, never a stand-in
 * string a caller could confuse with a real status. It maps to
 * "unfinished", pulsing, because an abandoned turn must look abandoned —
 * never quietly coerced into looking like it resolved either way. */
export function statusBadge(status: string | null): {
  label: string
  color: SemanticColor
  pulse: boolean
} {
  if (status === null) return { label: 'unfinished', color: 'neutral', pulse: true }
  if (status === 'ok') return { label: 'ok', color: 'success', pulse: false }
  if (status === 'error') return { label: 'error', color: 'danger', pulse: false }
  if (status === 'interrupted') return { label: 'interrupted', color: 'warning', pulse: false }
  // The backend's CHECK constraint means this never actually happens, but
  // a real value earns its own label — relabeling it "unfinished" would
  // misrepresent a status that DID arrive as one that never did.
  return { label: status, color: 'neutral', pulse: false }
}

export type ArgsView = { kind: 'kv'; lines: string[] } | { kind: 'raw'; text: string } | { kind: 'none' }

/**
 * meta.args_redacted's KNOWN QUIRK (chat.py): an object normally, or a
 * clipped STRING once the call's arguments were oversized or unparseable
 * for `_bounded()` to keep as a record. Both are real, both are shown —
 * neither is coerced into looking like the other.
 */
export function viewArgs(value: unknown): ArgsView {
  if (value === undefined) return { kind: 'none' }
  if (typeof value === 'string') return { kind: 'raw', text: value }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) return { kind: 'raw', text: '{}' }
    return {
      kind: 'kv',
      lines: entries.map(([key, v]) => `${key}: ${typeof v === 'string' ? v : JSON.stringify(v)}`),
    }
  }
  // Neither shape the contract promises (a bare number, an array, null) —
  // still shown, verbatim, rather than dropped.
  return { kind: 'raw', text: JSON.stringify(value) }
}

/** A span's duration_ms is either a real measurement or absent (never a
 * fake zero) — null stays null all the way to the caller, who renders it
 * as absent rather than "0ms". */
export function formatMs(ms: number | null): string | null {
  if (ms === null) return null
  if (ms < 1000) return `${ms}ms`
  const seconds = ms / 1000
  const rounded = Math.round(seconds * 10) / 10
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}s`
}

const MINUTE = 60
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WEEK = 7 * DAY

/** started_at as "how long ago", falling back to a calendar date once the
 * turn is old enough that "N days ago" stops being useful at a glance. */
export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso)
  const diffSec = Math.round((now.getTime() - then.getTime()) / 1000)

  if (diffSec < 5) return 'just now'
  if (diffSec < MINUTE) return `${diffSec}s ago`
  if (diffSec < HOUR) return `${Math.round(diffSec / MINUTE)}m ago`
  if (diffSec < DAY) return `${Math.round(diffSec / HOUR)}h ago`
  if (diffSec < WEEK) return `${Math.round(diffSec / DAY)}d ago`
  return then.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: then.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
  })
}
