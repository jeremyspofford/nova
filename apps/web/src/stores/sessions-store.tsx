import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import {
  createSession as apiCreateSession,
  deleteSession as apiDeleteSession,
  listSessions as apiListSessions,
  makeSessionMain as apiMakeSessionMain,
  renameSession as apiRenameSession,
  setSessionArchived as apiSetSessionArchived,
  type ChatSession,
  type DeletedSession,
} from '../lib/api'
import { readLocal, writeLocal } from '../lib/storage'
import { useIsMobile } from '../hooks/useIsMobile'
import { MAIN_SLOT, useChatSlots } from './chat-store'
import type { ChatLocation } from '../pages/chat/ChatPage'
import {
  closeMain,
  insertPane,
  MAX_PANES,
  removePane,
  resize as resizeLayout,
  sanitize,
  setLocation,
  type DropZone,
  type Layout,
  type Pane,
} from '../pages/chat/paneLayout'

/**
 * Chat sessions (owner, 2026-10-07): the list in the sidebar and the split
 * view on /chat, in one place because each acts on the other — deleting a
 * session closes the panes showing it, opening one from the sidebar fills
 * the focused pane, dragging one onto a pane splits it.
 *
 * The LIST is core's, read on mount, every POLL_MS, and after every action
 * here; nothing in it is remembered or guessed client-side ("main", "busy"
 * and the label are all derived by core). The LAYOUT is this browser's
 * (localStorage), and only for the side panes — the main pane's location is
 * the URL, so a reload, a link or the phone lands exactly where it did
 * before this existed.
 */

const LAYOUT_KEY = 'nova-chat-panes'
const POLL_MS = 15_000

export interface SessionsApi {
  listSessions: typeof apiListSessions
  createSession: typeof apiCreateSession
  renameSession: typeof apiRenameSession
  setSessionArchived: typeof apiSetSessionArchived
  makeSessionMain: typeof apiMakeSessionMain
  deleteSession: typeof apiDeleteSession
}

const DEFAULT_API: SessionsApi = {
  listSessions: apiListSessions,
  createSession: apiCreateSession,
  renameSession: apiRenameSession,
  setSessionArchived: apiSetSessionArchived,
  makeSessionMain: apiMakeSessionMain,
  deleteSession: apiDeleteSession,
}

export interface ShownPane extends Pane {
  /** The session this pane actually shows — `sessionId`, or the main one
   *  when it names none. Null only before the list has loaded. */
  effectiveSessionId: string | null
}

export interface SessionsStore {
  sessions: ChatSession[]
  /** Null until asked for (the archive is read on demand). */
  archived: ChatSession[] | null
  /** Why the list could not be read, or null. Never a silent empty list. */
  error: string | null
  mainId: string | null
  refresh: () => Promise<void>
  loadArchived: () => Promise<void>
  label: (sessionId: string | null) => string

  panes: ShownPane[]
  weights: Record<string, number>
  focused: string
  focus: (paneId: string) => void
  /** Open in the focused pane, or focus the pane already showing it. */
  openSession: (sessionId: string) => void
  /** Open the session `step` places down the sidebar list from the focused
   *  pane's (wrapping) — Ctrl+Tab is +1, Ctrl+Shift+Tab is -1. */
  cycleSession: (step: number) => void
  /** Open in a new pane beside the focused one. False at the cap. */
  openInSplit: (sessionId: string) => boolean
  dropSession: (sessionId: string, paneId: string, zone: DropZone) => void
  navigatePane: (paneId: string, next: ChatLocation) => void
  closePane: (paneId: string) => void
  resizePanes: (leftPaneId: string, fraction: number) => void
  canSplit: boolean
  dragging: string | null
  setDragging: (sessionId: string | null) => void

  newSession: (opts?: { split?: boolean }) => Promise<void>
  rename: (sessionId: string, title: string | null) => Promise<void>
  archive: (sessionId: string) => Promise<void>
  unarchive: (sessionId: string) => Promise<void>
  makeMain: (sessionId: string) => Promise<void>
  remove: (sessionId: string) => Promise<DeletedSession>
}

const SessionsContext = createContext<SessionsStore | null>(null)

let paneSeq = 0
const newPaneId = () => `pane-${Date.now().toString(36)}-${++paneSeq}`

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

export function SessionsProvider({
  children,
  personId = null,
  api = DEFAULT_API,
  pollMs = POLL_MS,
}: {
  children: ReactNode
  /** Whose layout this is — a browser shared by two people keeps two. */
  personId?: string | null
  api?: SessionsApi
  pollMs?: number
}) {
  const navigate = useNavigate()
  const routerLocation = useLocation()
  const [search] = useSearchParams()
  const isMobile = useIsMobile()
  const { releaseSlot, streamingSlots } = useChatSlots()

  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [archived, setArchived] = useState<ChatSession[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const layoutKey = `${LAYOUT_KEY}:${personId ?? 'nobody'}`
  const [layout, setLayout] = useState<Layout>(() => sanitize(readLocal(layoutKey, null)))
  const [dragging, setDragging] = useState<string | null>(null)

  useEffect(() => writeLocal(layoutKey, layout), [layoutKey, layout])

  const onChat = routerLocation.pathname === '/chat'
  const mainLocation: ChatLocation = {
    sessionId: onChat ? search.get('session') : null,
    threadId: onChat ? search.get('thread') : null,
  }
  const mainId = sessions.find(s => s.main)?.id ?? null

  const archivedRef = useRef(archived)
  archivedRef.current = archived

  const refresh = useCallback(async () => {
    try {
      const live = await api.listSessions(false)
      setSessions(live)
      setError(null)
      if (archivedRef.current !== null) setArchived(await api.listSessions(true))
    } catch (err) {
      setError(`sessions could not be read — ${errorText(err)}`)
    }
  }, [api])

  const loadArchived = useCallback(async () => {
    try {
      setArchived(await api.listSessions(true))
    } catch (err) {
      setError(`archived sessions could not be read — ${errorText(err)}`)
    }
  }, [api])

  useEffect(() => {
    void refresh()
    const id = setInterval(() => void refresh(), pollMs)
    return () => clearInterval(id)
  }, [refresh, pollMs])

  // A turn ending is when a label (first line) and "busy" change, so read
  // the list then instead of waiting for the next tick.
  const streamingKey = streamingSlots.join(',')
  const previousStreaming = useRef(streamingKey)
  useEffect(() => {
    if (previousStreaming.current !== streamingKey) void refresh()
    previousStreaming.current = streamingKey
  }, [streamingKey, refresh])

  /** The main pane's URL. The main session is `/chat` with no parameter. */
  const goMain = useCallback(
    (next: ChatLocation, replace = false) => {
      const params = new URLSearchParams()
      if (next.sessionId && next.sessionId !== mainId) params.set('session', next.sessionId)
      if (next.threadId) params.set('thread', next.threadId)
      const query = params.toString()
      navigate(query ? `/chat?${query}` : '/chat', { replace })
    },
    [navigate, mainId],
  )

  // On the phone there is one pane: the side panes are kept (they come back
  // on a wide screen) but never shown.
  const panes: ShownPane[] = useMemo(() => {
    const order = isMobile ? [MAIN_SLOT] : layout.order
    return order.map(id => {
      const loc = id === MAIN_SLOT ? mainLocation : layout.extra[id]
      return {
        id,
        sessionId: loc.sessionId,
        threadId: loc.threadId,
        effectiveSessionId: loc.sessionId ?? mainId,
      }
    })
    // mainLocation is rebuilt every render from `search`; its parts are the
    // dependencies.
  }, [isMobile, layout, mainLocation.sessionId, mainLocation.threadId, mainId])

  const focused = isMobile ? MAIN_SLOT : layout.focused

  const focus = useCallback((paneId: string) => {
    setLayout(l => (l.focused === paneId || !l.order.includes(paneId) ? l : { ...l, focused: paneId }))
  }, [])

  const paneShowing = useCallback(
    (sessionId: string) => panes.find(p => p.effectiveSessionId === sessionId),
    [panes],
  )

  const navigatePane = useCallback(
    (paneId: string, next: ChatLocation) => {
      if (paneId === MAIN_SLOT) goMain(next)
      else setLayout(l => setLocation(l, paneId, next))
    },
    [goMain],
  )

  const openSession = useCallback(
    (sessionId: string) => {
      const showing = paneShowing(sessionId)
      if (showing) {
        focus(showing.id)
        // Off /chat the main pane reads as the main session, so plain /chat
        // is exactly the layout the lookup above was made against.
        if (!onChat) navigate('/chat')
        return
      }
      const target = onChat && focused in layout.extra ? focused : MAIN_SLOT
      if (target === MAIN_SLOT) {
        goMain({ sessionId, threadId: null })
        focus(MAIN_SLOT)
      } else {
        navigatePane(target, { sessionId, threadId: null })
      }
    },
    [paneShowing, focus, onChat, navigate, focused, layout.extra, goMain, navigatePane],
  )

  const cycleSession = useCallback(
    (step: number) => {
      if (sessions.length === 0) return
      const current = panes.find(p => p.id === focused)?.effectiveSessionId
      const at = sessions.findIndex(s => s.id === current)
      // From a session not in the list (archived, or not loaded yet) the
      // first step lands on the first or last row rather than skipping one.
      const from = at === -1 ? (step > 0 ? -1 : 0) : at
      const n = sessions.length
      openSession(sessions[(((from + step) % n) + n) % n].id)
    },
    [sessions, panes, focused, openSession],
  )

  // Ctrl+Tab / Ctrl+Shift+Tab, the browser-tab gesture, plus Alt+Down /
  // Alt+Up (Slack's) because an ordinary browser tab never sees Ctrl+Tab —
  // the browser keeps it for its own tabs. The installed app's window gets
  // it. Listening here, not in the sidebar, so it works with the sidebar
  // closed and on every page.
  const cycleRef = useRef(cycleSession)
  cycleRef.current = cycleSession
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey) return
      let step = 0
      if (e.key === 'Tab' && e.ctrlKey && !e.altKey) step = e.shiftKey ? -1 : 1
      else if (e.altKey && !e.ctrlKey && !e.shiftKey && e.key === 'ArrowDown') step = 1
      else if (e.altKey && !e.ctrlKey && !e.shiftKey && e.key === 'ArrowUp') step = -1
      if (step === 0) return
      e.preventDefault()
      cycleRef.current(step)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const canSplit = !isMobile && layout.order.length < MAX_PANES

  const openInSplit = useCallback(
    (sessionId: string) => {
      if (!canSplit) {
        openSession(sessionId)
        return false
      }
      const pane: Pane = { id: newPaneId(), sessionId, threadId: null }
      setLayout(l => insertPane(l, pane, l.focused, 'right'))
      if (!onChat) navigate('/chat')
      return true
    },
    [canSplit, openSession, onChat, navigate],
  )

  const dropSession = useCallback(
    (sessionId: string, paneId: string, zone: DropZone) => {
      setDragging(null)
      if (zone === 'center' || !canSplit) {
        const showing = paneShowing(sessionId)
        if (showing) {
          focus(showing.id)
          return
        }
        navigatePane(paneId, { sessionId, threadId: null })
        focus(paneId)
        return
      }
      const pane: Pane = { id: newPaneId(), sessionId, threadId: null }
      setLayout(l => insertPane(l, pane, paneId, zone))
    },
    [canSplit, paneShowing, focus, navigatePane],
  )

  const closePane = useCallback(
    (paneId: string) => {
      if (paneId !== MAIN_SLOT) {
        setLayout(l => removePane(l, paneId))
        releaseSlot(paneId)
        return
      }
      const closed = closeMain(layout)
      if (!closed) return
      setLayout(closed.layout)
      releaseSlot(closed.removed)
      goMain(closed.location)
    },
    [layout, releaseSlot, goMain],
  )

  const resizePanes = useCallback((leftPaneId: string, fraction: number) => {
    setLayout(l => resizeLayout(l, leftPaneId, fraction))
  }, [])

  /** Every pane showing this session closes — the main one last, since
   *  closing it pulls a side pane's location into the URL. */
  const closeShowing = useCallback(
    (sessionId: string) => {
      let next = layout
      const released: string[] = []
      for (const id of [...next.order]) {
        if (id === MAIN_SLOT) continue
        const pane = next.extra[id]
        if ((pane.sessionId ?? mainId) === sessionId) {
          next = removePane(next, id)
          released.push(id)
        }
      }
      if ((mainLocation.sessionId ?? mainId) === sessionId && onChat) {
        const closed = closeMain(next)
        if (closed) {
          next = closed.layout
          released.push(closed.removed)
          goMain(closed.location, true)
        } else {
          goMain({ sessionId: null, threadId: null }, true)
        }
      }
      setLayout(next)
      released.forEach(releaseSlot)
    },
    [layout, mainId, mainLocation.sessionId, onChat, goMain, releaseSlot],
  )

  /** Before the main session moves, pin every pane showing "the main one"
   *  to the session it is actually showing — or it would jump to the new
   *  main under his eyes. */
  const pinMain = useCallback(() => {
    if (!mainId) return
    setLayout(l => {
      let next = l
      for (const id of l.order) {
        const pane = l.extra[id]
        if (pane && pane.sessionId === null) next = setLocation(next, id, { ...pane, sessionId: mainId })
      }
      return next
    })
    if (onChat && mainLocation.sessionId === null) {
      const params = new URLSearchParams()
      params.set('session', mainId)
      if (mainLocation.threadId) params.set('thread', mainLocation.threadId)
      navigate(`/chat?${params}`, { replace: true })
    }
  }, [mainId, onChat, mainLocation.sessionId, mainLocation.threadId, navigate])

  const newSession = useCallback(
    async (opts: { split?: boolean } = {}) => {
      const created = await api.createSession()
      setSessions(list => [created, ...list.filter(s => s.id !== created.id)])
      if (opts.split && canSplit) openInSplit(created.id)
      else openSession(created.id)
      void refresh()
    },
    [api, canSplit, openInSplit, openSession, refresh],
  )

  const rename = useCallback(
    async (sessionId: string, title: string | null) => {
      await api.renameSession(sessionId, title)
      await refresh()
    },
    [api, refresh],
  )

  const archive = useCallback(
    async (sessionId: string) => {
      await api.setSessionArchived(sessionId, true)
      closeShowing(sessionId)
      await refresh()
    },
    [api, closeShowing, refresh],
  )

  const unarchive = useCallback(
    async (sessionId: string) => {
      await api.setSessionArchived(sessionId, false)
      await refresh()
      await loadArchived()
    },
    [api, refresh, loadArchived],
  )

  const makeMain = useCallback(
    async (sessionId: string) => {
      pinMain()
      await api.makeSessionMain(sessionId)
      await refresh()
    },
    [api, pinMain, refresh],
  )

  const remove = useCallback(
    async (sessionId: string) => {
      const result = await api.deleteSession(sessionId)
      closeShowing(sessionId)
      setArchived(list => (list ? list.filter(s => s.id !== sessionId) : list))
      await refresh()
      return result
    },
    [api, closeShowing, refresh],
  )

  const label = useCallback(
    (sessionId: string | null) => {
      const id = sessionId ?? mainId
      const found =
        sessions.find(s => s.id === id) ?? archived?.find(s => s.id === id) ?? null
      return found?.label ?? (sessionId === null ? 'Main session' : 'Session')
    },
    [sessions, archived, mainId],
  )

  const value: SessionsStore = {
    sessions,
    archived,
    error,
    mainId,
    refresh,
    loadArchived,
    label,
    panes,
    weights: layout.weights,
    focused,
    focus,
    openSession,
    cycleSession,
    openInSplit,
    dropSession,
    navigatePane,
    closePane,
    resizePanes,
    canSplit,
    dragging,
    setDragging,
    newSession,
    rename,
    archive,
    unarchive,
    makeMain,
    remove,
  }

  return <SessionsContext.Provider value={value}>{children}</SessionsContext.Provider>
}

/** The sessions store, or null outside a SessionsProvider (a page rendered
 *  alone in a test has no sessions to show, and says nothing about them). */
export function useSessions(): SessionsStore | null {
  return useContext(SessionsContext)
}

/** The drag payload's type: a session id, readable by any drop target. */
export const SESSION_DRAG_TYPE = 'application/x-nova-session'
