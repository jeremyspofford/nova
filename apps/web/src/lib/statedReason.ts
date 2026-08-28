/**
 * The reason a refusal gave, pulled out of whatever shape it arrived in.
 *
 * Nova's services answer every deliberate refusal as `{"error": reason}` —
 * that is the shape their StarletteHTTPException handler produces, and it is
 * what a 400/401/403/502 from core or the gateway looks like on the wire.
 * FastAPI's own request-validation failures bypass that handler and keep
 * `{"detail": [...]}`, and a proxy in the middle can answer with neither.
 *
 * All three have to end up as a sentence a person can act on, so this reads
 * `error`, then `detail`, then falls back to quoting the body. It never
 * invents a reason, and it never returns an empty string.
 */

const MAX_QUOTED_BODY = 300

function fromDetail(detail: unknown): string | null {
  if (typeof detail === 'string' && detail) return detail
  // 422s arrive as a list of field errors — join them rather than printing
  // "[object Object]".
  if (Array.isArray(detail)) {
    const parts = detail
      .map((d: { loc?: unknown[]; msg?: string }) =>
        [Array.isArray(d.loc) ? d.loc.slice(1).join('.') : '', d.msg].filter(Boolean).join(': '),
      )
      .filter(Boolean)
    if (parts.length) return parts.join('; ')
  }
  return null
}

export function statedReason(body: string, status: number): string {
  try {
    const parsed = JSON.parse(body)
    if (parsed !== null && typeof parsed === 'object') {
      const { error, detail } = parsed as { error?: unknown; detail?: unknown }
      if (typeof error === 'string' && error) return error
      const fromDetailField = fromDetail(detail)
      if (fromDetailField) return fromDetailField
    }
  } catch {
    /* not JSON — fall through to the raw body */
  }
  const trimmed = body.trim()
  return trimmed ? trimmed.slice(0, MAX_QUOTED_BODY) : `request failed with status ${status}`
}
