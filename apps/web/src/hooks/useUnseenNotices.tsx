import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { listNotices as apiListNotices } from '../lib/api'

/**
 * How many notices the owner has not read — the number on the Inbox nav
 * badge (S11).
 *
 * The count is ALWAYS the server's `unseen_count`, which core computes over
 * every row (notices.unseen_count). It is never derived here from the page of
 * notices that happens to have been fetched: that number would silently cap
 * at the page size and read as a fact.
 *
 * `count` is null until a read has actually landed, and the badge renders
 * nothing for null. An unknown count is not zero — a nav item quietly showing
 * no badge because core is down would say "nothing is waiting", which is a
 * success claim nobody checked. `error` carries the read's stated reason so
 * the nav item can say the count is unreadable rather than imply a clean
 * inbox, and a failed poll KEEPS the last known count (a blip is not news)
 * while the error stands until a read succeeds again — the Agents roster's
 * idiom.
 *
 * The provider is mounted once by AppLayout, so the whole shell shares one
 * poll, and the Inbox page can push a fresh read through `refresh` the moment
 * it marks something seen instead of leaving the badge stale for a poll.
 */

export interface UnseenNotices {
  /** The server's count, or null when it has not been read yet. Never 0
   * standing in for "unknown". */
  count: number | null
  /** Why the last read failed, in core's words; null while reads succeed. */
  error: string | null
  /** Read it again now — what the Inbox page calls after a write. */
  refresh: () => void
}

/** Never tighter: this poll runs on every page of the app, and the badge is
 * a count of things that arrive hourly at most. */
export const UNSEEN_POLL_MS = 30_000

/** What a component outside the provider sees: nothing known, and a refresh
 * that does nothing. A bare-rendered Sidebar in a test is exactly this, and
 * it must render no badge rather than throw. */
const NOTHING_KNOWN: UnseenNotices = { count: null, error: null, refresh: () => {} }

const UnseenNoticesCtx = createContext<UnseenNotices>(NOTHING_KNOWN)

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function UnseenNoticesProvider({
  children,
  listNotices = apiListNotices,
  pollMs = UNSEEN_POLL_MS,
}: {
  children: ReactNode
  /** The dependency-injection seam every page uses; production takes the
   * default. */
  listNotices?: typeof apiListNotices
  pollMs?: number
}) {
  const [count, setCount] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Whether this provider is still mounted, so a read that lands after an
  // unmount writes nothing.
  const live = useRef(true)

  const read = useCallback(async () => {
    try {
      const listing = await listNotices()
      if (!live.current) return
      setCount(listing.unseen_count)
      setError(null)
    } catch (err) {
      if (!live.current) return
      // The last known count stays: a failed poll is a failed poll, not a
      // reason to claim the inbox emptied.
      setError(reasonOf(err))
    }
  }, [listNotices])

  useEffect(() => {
    live.current = true
    void read()
    const id = setInterval(() => void read(), pollMs)
    return () => {
      live.current = false
      clearInterval(id)
    }
  }, [read, pollMs])

  const refresh = useCallback(() => {
    void read()
  }, [read])

  return (
    <UnseenNoticesCtx.Provider value={{ count, error, refresh }}>
      {children}
    </UnseenNoticesCtx.Provider>
  )
}

export function useUnseenNotices(): UnseenNotices {
  return useContext(UnseenNoticesCtx)
}
