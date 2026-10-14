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

/** The only two tools whose `path` argument names a file actually inside
 * the workspace viewer (Files, apps/web/src/pages/files) — workspace_
 * list_files takes an optional `path` too, but it names a directory to
 * scope a listing by, not a single file to open, so it is deliberately
 * excluded here. */
const WORKSPACE_PATH_TOOLS = new Set(['workspace_write_file', 'workspace_read_file'])

export function isWorkspacePathTool(name: string | null): boolean {
  return name !== null && WORKSPACE_PATH_TOOLS.has(name)
}

/**
 * meta.args_redacted's `path` field, when it is extractable — reads on the
 * SAME polymorphic value viewArgs does (see its docstring for why the
 * shape varies), but answers a narrower question: is there a path here to
 * link to at all. The clipped-string shape (oversized/unparseable calls)
 * carries no such field by construction, so a span in that shape simply
 * has nothing to link — this returns null rather than guessing.
 */
export function workspacePathFrom(argsRedacted: unknown): string | null {
  if (argsRedacted === null || typeof argsRedacted !== 'object' || Array.isArray(argsRedacted)) {
    return null
  }
  const path = (argsRedacted as Record<string, unknown>).path
  return typeof path === 'string' && path.trim() !== '' ? path : null
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

/** "github · get_job_logs" for an mcp_call span — the server and the tool it
 * ran, from the call's own arguments (S37a). Null for any other span, and for
 * arguments clipped to a string. */
export function mcpCallLabel(name: string | null, argsRedacted: unknown): string | null {
  if (name !== 'mcp_call' || argsRedacted === null || typeof argsRedacted !== 'object' || Array.isArray(argsRedacted)) {
    return null
  }
  const args = argsRedacted as Record<string, unknown>
  return typeof args.server === 'string' && typeof args.tool === 'string' ? `${args.server} · ${args.tool}` : null
}

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

/** A FUTURE time as "how long from now" ("in 4h"), for a stamp that is
 * meant to be ahead, like a credit wall's walled_until (epic wall-probe T10).
 * Under 5 seconds ahead, or already past, it is "now". Kept apart from
 * formatRelativeTime, whose callers all show past events: there a stamp ahead
 * of the browser clock is clock skew and must keep reading "just now". */
export function formatTimeUntil(iso: string, now: Date = new Date()): string {
  const aheadSec = Math.round((new Date(iso).getTime() - now.getTime()) / 1000)

  if (aheadSec < 5) return 'now'
  if (aheadSec < MINUTE) return `in ${aheadSec}s`
  if (aheadSec < HOUR) return `in ${Math.round(aheadSec / MINUTE)}m`
  if (aheadSec < DAY) return `in ${Math.round(aheadSec / HOUR)}h`
  return `in ${Math.round(aheadSec / DAY)}d`
}

/** A value as one line of text: a string as itself, anything else as JSON
 * (never the empty string `JSON.stringify(undefined)` would give). */
function factValue(v: unknown): string {
  return typeof v === 'string' ? v : (JSON.stringify(v) ?? String(v))
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** One fact as `key: value · key: value`; an empty object as `{}`. */
function factPairs(fact: Record<string, unknown>): string {
  const entries = Object.entries(fact)
  if (entries.length === 0) return '{}'
  return entries.map(([key, v]) => `${key}: ${factValue(v)}`).join(' · ')
}

function viewFact(fact: unknown): string {
  if (!isPlainObject(fact)) return JSON.stringify(fact) ?? String(fact)
  const { run, file, target } = fact
  // A run fact (devices.py device_run): the command as the guards read it
  // (`target`, argv joined), its exit code — a missing one is `none`, never
  // a made-up 0 — the device, and the cwd when one was given.
  if (isPlainObject(run)) {
    const exit = run.exit_code === null || run.exit_code === undefined ? 'none' : factValue(run.exit_code)
    const parts = [`run: ${factValue(target)}`, `exit_code ${exit}`]
    if (run.device !== null && run.device !== undefined) parts.push(`device ${factValue(run.device)}`)
    if (run.cwd !== null && run.cwd !== undefined) parts.push(`cwd ${factValue(run.cwd)}`)
    return parts.join(' · ')
  }
  // A file fact (device_read_file / device_write_file): the op and the path.
  if (isPlainObject(file)) {
    const line = `file ${factValue(file.op)}: ${factValue(target)}`
    return file.device !== null && file.device !== undefined ? `${line} · device ${factValue(file.device)}` : line
  }
  // Everything else (connectivity, outside_worktree, a shape added later,
  // or a run/file key that is not an object) as key: value pairs.
  return factPairs(fact)
}

/**
 * A tool span's meta.facts as display lines (S29 T8), one per fact, in the
 * order they were filed. The payload is chat._run_tool's list exactly as
 * stored; a shape outside that contract (a bare string, an object, a
 * non-object item) is shown verbatim as JSON, never dropped and never
 * thrown on. Absent or empty facts render nothing.
 */
export function viewFacts(facts: unknown): string[] {
  if (facts === undefined || facts === null) return []
  if (!Array.isArray(facts)) return [JSON.stringify(facts) ?? String(facts)]
  return facts.map(viewFact)
}

/** Span kinds whose words are not just the key with its underscores
 * spaced: `llm_call` is a model call, `distil` the notes distilled, a roster
 * the list a turn was handed. Every other kind — known today or added later
 * — reads as its own key in sentence case (sentenceWords), so a kind core
 * starts writing tomorrow is never dropped and never shown as a raw key. */
const SPAN_WORDS: Record<string, string> = {
  llm_call: 'Model call',
  tool: 'Tool call',
  memory_recall: 'Memory recall',
  memory_ingest: 'Memory saved',
  agent_names: 'Agent names',
  agent_cap: 'Agent spend cap',
  agent_roster: 'Agents offered',
  skills_roster: 'Skills offered',
  mcp_roster: 'MCP servers offered',
  model_swap: 'Model switched',
  distil: 'Notes distilled',
  background_wake: 'Background wake',
}

/** `future_thing` -> "Future thing": underscores to spaces, first letter up. */
function sentenceWords(key: string): string {
  const words = key.replace(/_+/g, ' ').trim()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Span'
}

/** T20 (verification 2-7): a span's kind (and, for a guard, its name) as
 * words a reader knows — "Model call", "Guard: delegation claim" — with a
 * sentence-cased fallback for a kind this page has never seen. Only a
 * guard's name joins its label: a guard's name is a snake key
 * (guards.py), every other span's name is already readable or a tool's own
 * identifier, shown beside the label as it is. */
export function spanLabel(kind: string, name: string | null, meta?: Record<string, unknown>): string {
  if (kind === 'guard') {
    const words = (name ?? '').replace(/_+/g, ' ').trim()
    const head = meta && guardRaised(meta) ? 'Guard crashed' : 'Guard'
    return words ? `${head}: ${words}` : head
  }
  return SPAN_WORDS[kind] ?? sentenceWords(kind)
}

/** T11 C6 (verification 2-7): a guard span is a CRASH only when it carries
 * the raised marker as exactly `true` — the web twin of core's
 * traces.guard_raised (`meta.get(GUARD_RAISED) is True`). meta.error alone
 * is not the marker: a guard that FIRED and whose redirect then failed
 * carries meta.error too, and it is still a fire. */
export function guardRaised(meta: Record<string, unknown>): boolean {
  return meta.raised === true
}
