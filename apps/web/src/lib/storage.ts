/** Browser-local storage, read and written as JSON, that never throws.
 *
 * Every caller in this app already wanted the same three things: a value if
 * one is there, the fallback if it is not, and the fallback again when the
 * browser refuses to answer at all — a private window, cleared site data, a
 * profile with storage blocked. Two callers inlined that try/catch separately
 * (`AppLayout`'s sidebar flag, `theme-store`'s palette) before this existed.
 *
 * A stored value is data the app wrote, but it is also data anyone can edit in
 * devtools, so a value that will not parse is treated exactly like an absent
 * one rather than crashing the render that read it.
 */

export function readLocal<T>(key: string, fallback: T): T {
  let raw: string | null
  try {
    raw = localStorage.getItem(key)
  } catch {
    return fallback
  }
  if (raw === null) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

/** Store `value`, or forget the key entirely when it is null. */
export function writeLocal(key: string, value: unknown): void {
  try {
    if (value === null) {
      localStorage.removeItem(key)
      return
    }
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* No storage, or no room in it. A convenience that cannot be saved is not
       an error worth failing a render over — the next read takes the
       fallback. */
  }
}
