/**
 * A fact, formatted for a person (verification report item 5, T14). Inbox
 * facts reached the screen as `snake_key: value` in mono, with whole UUIDs
 * and JSON arrays. This turns a key into words and a value into a short
 * reading, and keeps the raw value in `full` whenever the reading differs,
 * so a title or a "Details" disclosure can still show exactly what core
 * wrote. Timestamps go through humanText's formatStamp, not a second
 * formatter.
 */
import { formatStamp } from './humanText'

export interface FactValue {
  /** What the card shows. */
  text: string
  /** The raw value (a string verbatim, anything else as its JSON), present
   *  whenever `text` is not that raw value. */
  full?: string
}

export interface FormattedFact extends FactValue {
  key: string
  label: string
}

// Verification 2-7, T30: a key segment on this list is written in capitals,
// and its plural keeps a lowercase "s" ("turn_ids" -> "Turn IDs"). A segment
// is matched whole and case-blind, never inside a longer word ("idle_since",
// "gbit_rate" and "apiary" stay words).
const ACRONYMS = new Set([
  'id', 'url', 'uri', 'api', 'uuid', 'ip', 'cpu', 'gpu', 'ram', 'vram',
  'kb', 'mb', 'gb', 'tb', 'http', 'https', 'ssh', 'dns', 'tls', 'pid',
  'json', 'html', 'llm',
])
// Units that read as units, not as words: "used_pct" -> "Used %", and "ms"
// stays lowercase even as the first word ("ms_waited" -> "ms waited").
const UNITS: Record<string, string> = { pct: '%', ms: 'ms' }
const LIST_CAP = 5
const FLAT_OBJECT_CAP = 3

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HEX_TOKEN = /^[0-9a-f]{16,}$/i
// The whole string is an ISO date, optionally with a time, fraction and zone
// (humanText's STAMP, anchored: a sentence that merely contains a date stays
// a sentence).
const WHOLE_STAMP = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/

/** One key segment as written: a unit, an acronym (or its plural), or a
 *  lowercase word. `fixed` marks the first two, which a label never
 *  re-capitalises. */
function segmentWord(segment: string): { word: string; fixed: boolean } {
  const lower = segment.toLowerCase()
  if (lower in UNITS) return { word: UNITS[lower], fixed: true }
  if (ACRONYMS.has(lower)) return { word: lower.toUpperCase(), fixed: true }
  if (lower.endsWith('s') && ACRONYMS.has(lower.slice(0, -1))) {
    return { word: `${lower.slice(0, -1).toUpperCase()}s`, fixed: true }
  }
  return { word: lower, fixed: false }
}

/** A key's words: lower case, except the acronyms (capitals) and units. */
function keySegments(key: string): { word: string; fixed: boolean }[] {
  return key.split('_').filter(Boolean).map(segmentWord)
}

function keyWords(key: string): string[] {
  return keySegments(key).map(s => s.word)
}

/** "last_error" -> "Last error"; "timer_id" -> "Timer ID"; "free_gb" ->
 *  "Free GB"; "used_pct" -> "Used %"; "ms_waited" -> "ms waited". */
export function factLabel(key: string): string {
  const segments = keySegments(key)
  if (segments.length === 0) return key
  const [first, ...rest] = segments
  const head = first.fixed ? first.word : first.word.charAt(0).toUpperCase() + first.word.slice(1)
  return [head, ...rest.map(s => s.word)].join(' ')
}

/** The raw value as core wrote it: a string verbatim, anything else as JSON. */
function rawOf(value: unknown): string {
  return typeof value === 'string' ? value : String(JSON.stringify(value))
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The short reading of a value, without the raw. */
function reading(value: unknown): string {
  if (value === null || value === undefined) return 'none'
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if (typeof value === 'number' || typeof value === 'bigint') return String(value)
  if (typeof value === 'string') {
    if (UUID.test(value) || HEX_TOKEN.test(value)) return `${value.slice(0, 8)}…`
    if (WHOLE_STAMP.test(value)) return formatStamp(value)
    return value
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return 'none'
    const shown = value.slice(0, LIST_CAP).map(reading).join(', ')
    const more = value.length - LIST_CAP
    return more > 0 ? `${shown} and ${more} more` : shown
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value)
    if (entries.length === 0) return 'none'
    const flat = entries.every(([, v]) => typeof v !== 'object' || v === null)
    if (!flat || entries.length > FLAT_OBJECT_CAP) {
      return `${entries.length} ${entries.length === 1 ? 'field' : 'fields'}`
    }
    return entries.map(([k, v]) => `${keyWords(k).join(' ')} ${reading(v)}`).join(', ')
  }
  return String(value)
}

/** One fact value as a short reading, raw value kept in `full`. */
export function factValue(value: unknown): FactValue {
  const text = reading(value)
  const raw = rawOf(value)
  return text === raw ? { text } : { text, full: raw }
}

/** Key and value together, in the shape a card renders. */
export function formatFact(key: string, value: unknown): FormattedFact {
  return { key, label: factLabel(key), ...factValue(value) }
}
