/**
 * Turning a stream of arbitrary chunks into whole lines.
 *
 * Both streams the browser reads — the SSE chat turn and the newline-delimited
 * model pull — hit the same hazard: a chunk boundary lands in the middle of a
 * line, and a naive `split('\n')` per chunk silently loses or halves it. The
 * two framings on top differ, but the buffering underneath is identical, so it
 * lives here once and is tested once.
 *
 * Lines come back verbatim apart from a CRLF's carriage return. Blank lines
 * are returned rather than dropped: SSE ignores them, the pull stream skips
 * them, and that is the caller's decision to make, not this one's.
 */
export interface LineBuffer {
  /** The lines this chunk completed. An unfinished tail is held for the next. */
  push(chunk: string): string[]
  /** The trailing line, if the stream ended without a final newline. */
  flush(): string[]
}

export function createLineBuffer(): LineBuffer {
  let held = ''

  const strip = (line: string) => (line.endsWith('\r') ? line.slice(0, -1) : line)

  return {
    push(chunk: string): string[] {
      held += chunk
      const parts = held.split('\n')
      // The last element is either '' (the chunk ended on a newline) or a
      // partial line; either way it belongs to the next chunk.
      held = parts.pop() ?? ''
      return parts.map(strip)
    },
    flush(): string[] {
      const tail = held
      held = ''
      return tail === '' ? [] : [strip(tail)]
    },
  }
}
