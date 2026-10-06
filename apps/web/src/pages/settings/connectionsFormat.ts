import type { McpServer } from '../../lib/api'
import { formatRelativeTime } from '../activity/activityFormat'

export type HeaderRow = { name: string; value: string }

/** Who added a server, in the owner's words. */
export function addedByLabel(server: McpServer): string {
  return server.added_by === 'nova' ? 'added by Nova' : 'added by you'
}

/** The last thing known about a server, with its time. A failure newer than
 *  the last success is what `failing` means, and it wins. */
export function statusLine(server: McpServer, now: Date = new Date()): string {
  if (server.failing && server.last_error_at) {
    return `last call failed ${formatRelativeTime(server.last_error_at, now)}: ${server.last_error ?? 'no reason recorded'}`
  }
  if (server.last_ok_at) return `answered ${formatRelativeTime(server.last_ok_at, now)}`
  return 'not called yet'
}

/** The add form's header rows as the object the route takes: names trimmed,
 *  empty names dropped. */
export function headersFromRows(rows: HeaderRow[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const row of rows) {
    const name = row.name.trim()
    if (name) out[name] = row.value
  }
  return out
}
