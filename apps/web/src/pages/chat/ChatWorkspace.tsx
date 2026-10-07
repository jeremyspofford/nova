import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react'
import clsx from 'clsx'
import { Columns2, Home, X } from 'lucide-react'
import { ChatSlot, MAIN_SLOT, useChatStore } from '../../stores/chat-store'
import { SESSION_DRAG_TYPE, useSessions, type ShownPane } from '../../stores/sessions-store'
import { ChatPage, type ChatLocation } from './ChatPage'
import { MAX_PANES, type DropZone } from './paneLayout'

/**
 * /chat with chat sessions (2026-10-07): one or more panes side by side, each
 * its own session with its own turn. Drag a session from the sidebar onto a
 * pane — its left or right edge splits the view, its middle replaces what
 * that pane shows. Panes close from their header; the dividers between them
 * drag.
 *
 * Without a SessionsProvider (a test that renders the route alone) this is
 * exactly the old single ChatPage.
 */
export function ChatWorkspace({ initialModel }: { initialModel?: string }) {
  const sessions = useSessions()
  if (!sessions) return <ChatPage initialModel={initialModel} />
  const { panes, weights } = sessions
  const many = panes.length > 1
  return (
    <div className="flex h-full min-h-0 w-full" data-testid="chat-workspace" data-panes={panes.length}>
      {panes.map((pane, i) => (
        <PaneWithDivider
          key={pane.id}
          pane={pane}
          weight={weights[pane.id] ?? 1}
          many={many}
          divider={i < panes.length - 1}
          initialModel={initialModel}
        />
      ))}
    </div>
  )
}

function PaneWithDivider({
  pane,
  weight,
  many,
  divider,
  initialModel,
}: {
  pane: ShownPane
  weight: number
  many: boolean
  divider: boolean
  initialModel?: string
}) {
  const sessions = useSessions()!
  const rowRef = useRef<HTMLDivElement>(null)
  return (
    <>
      <div
        ref={rowRef}
        className="relative min-w-0 h-full"
        style={{ flex: `${weight} 1 0%` }}
        data-testid={`chat-pane-${pane.id}`}
        data-focused={String(sessions.focused === pane.id)}
        // Capture, so a click anywhere in the pane — the composer included —
        // focuses it before the click itself does anything.
        onPointerDownCapture={() => sessions.focus(pane.id)}
      >
        <ChatSlot id={pane.id}>
          <PaneBody pane={pane} many={many} initialModel={initialModel} />
        </ChatSlot>
        {sessions.dragging !== null && <DropZones pane={pane} />}
      </div>
      {divider && <Divider leftPaneId={pane.id} />}
    </>
  )
}

function PaneBody({
  pane,
  many,
  initialModel,
}: {
  pane: ShownPane
  many: boolean
  initialModel?: string
}) {
  const sessions = useSessions()!
  const { state } = useChatStore()
  const { navigatePane } = sessions
  const paneId = pane.id
  // Stable per pane: ChatPage's loader lists it as a dependency.
  const onNavigate = useCallback(
    (next: ChatLocation) => navigatePane(paneId, next),
    [navigatePane, paneId],
  )
  const mainEpoch = useMainEpoch(sessions.mainId)
  const main = pane.effectiveSessionId !== null && pane.effectiveSessionId === sessions.mainId
  const focused = many && sessions.focused === pane.id
  const header = (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      {focused && (
        <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
      )}
      <h1 className="truncate text-h3 text-content-primary" data-testid="pane-title">
        {sessions.label(pane.sessionId)}
      </h1>
      {main && (
        <span
          title="Where her digests and reminders set outside a chat land"
          className="inline-flex shrink-0 items-center gap-1 rounded-full bg-accent-dim px-2 py-0.5 text-micro text-accent"
        >
          <Home size={10} />
          main
        </span>
      )}
      {state.streaming && (
        <span className="text-caption text-content-tertiary shrink-0">responding…</span>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-1">
        {sessions.canSplit && pane.effectiveSessionId !== null && !many && (
          <span className="hidden lg:inline text-caption text-content-tertiary">
            drag a session here to split
          </span>
        )}
        {many && (
          <button
            type="button"
            data-testid={`close-pane-${pane.id}`}
            onClick={() => sessions.closePane(pane.id)}
            title="Close this pane — the session stays in the sidebar"
            aria-label="Close pane"
            className="rounded-md p-1.5 text-content-tertiary hover:bg-surface-card hover:text-content-primary"
          >
            <X size={15} />
          </button>
        )}
      </span>
    </div>
  )
  return (
    <ChatPage
      // A different session in this pane is a different page: its loader,
      // polls and scroll position all start over. A pane naming "the main
      // session" reloads when the main one moves (archived, or made main
      // elsewhere) — but not when the list first arrives, which would load
      // the same conversation twice.
      key={pane.sessionId ?? `main-${mainEpoch}`}
      initialModel={initialModel}
      location={pane.id === MAIN_SLOT ? undefined : { sessionId: pane.sessionId, threadId: pane.threadId }}
      onNavigate={pane.id === MAIN_SLOT ? undefined : onNavigate}
      header={header}
    />
  )
}

/** Counts how many times the main session has MOVED — not its first
 *  arrival — so a key built on it changes only when it should. */
function useMainEpoch(mainId: string | null): number {
  const seen = useRef<{ id: string | null; n: number }>({ id: mainId, n: 0 })
  if (mainId !== null && mainId !== seen.current.id) {
    seen.current = { id: mainId, n: seen.current.id === null ? seen.current.n : seen.current.n + 1 }
  }
  return seen.current.n
}

/** Where a dragged session can land on one pane. */
function DropZones({ pane }: { pane: ShownPane }) {
  const sessions = useSessions()!
  const [over, setOver] = useState<DropZone | null>(null)
  const zones: DropZone[] = sessions.canSplit ? ['left', 'center', 'right'] : ['center']

  const accept = (e: DragEvent) => {
    if (![...e.dataTransfer.types].includes(SESSION_DRAG_TYPE)) return false
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    return true
  }

  return (
    <div className="absolute inset-0 z-30 flex" data-testid={`drop-zones-${pane.id}`}>
      {zones.map(zone => (
        <div
          key={zone}
          data-testid={`drop-${zone}-${pane.id}`}
          onDragEnter={e => accept(e) && setOver(zone)}
          onDragOver={e => accept(e) && over !== zone && setOver(zone)}
          onDragLeave={() => setOver(o => (o === zone ? null : o))}
          onDrop={e => {
            if (!accept(e)) return
            const id = e.dataTransfer.getData(SESSION_DRAG_TYPE)
            setOver(null)
            if (id) sessions.dropSession(id, pane.id, zone)
          }}
          className={clsx(
            'h-full transition-colors duration-fast flex items-center justify-center',
            zone === 'center' ? 'flex-1' : 'w-1/4',
            over === zone
              ? 'bg-accent/15 outline outline-2 -outline-offset-4 outline-accent rounded-lg'
              : 'bg-surface-root/30',
          )}
        >
          {over === zone && (
            <span className="pointer-events-none rounded-md bg-surface-elevated px-2 py-1 text-caption text-content-primary shadow inline-flex items-center gap-1.5">
              {zone === 'center' ? (
                'Open here'
              ) : (
                <>
                  <Columns2 size={12} />
                  Split {zone}
                </>
              )}
            </span>
          )}
        </div>
      ))}
      {!sessions.canSplit && (
        <span className="pointer-events-none absolute top-3 left-1/2 -translate-x-1/2 rounded-md bg-surface-elevated px-2 py-1 text-caption text-content-tertiary shadow">
          {MAX_PANES} panes at most — drop to replace
        </span>
      )}
    </div>
  )
}

/** The draggable line between two panes. */
function Divider({ leftPaneId }: { leftPaneId: string }) {
  const sessions = useSessions()!
  const ref = useRef<HTMLButtonElement>(null)
  const drag = useRef<{ x: number; pair: number } | null>(null)
  const [active, setActive] = useState(false)

  useEffect(() => {
    if (!active) return
    const move = (e: PointerEvent) => {
      const d = drag.current
      if (!d || d.pair <= 0) return
      const dx = e.clientX - d.x
      if (Math.abs(dx) < 2) return
      sessions.resizePanes(leftPaneId, dx / d.pair)
      d.x = e.clientX
    }
    const up = () => {
      drag.current = null
      setActive(false)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [active, leftPaneId, sessions])

  return (
    <button
      ref={ref}
      type="button"
      aria-label="Resize panes"
      data-testid={`pane-divider-${leftPaneId}`}
      onPointerDown={e => {
        e.preventDefault()
        const el = ref.current
        const left = el?.previousElementSibling as HTMLElement | null
        const right = el?.nextElementSibling as HTMLElement | null
        const pair = (left?.offsetWidth ?? 0) + (right?.offsetWidth ?? 0)
        drag.current = { x: e.clientX, pair }
        setActive(true)
      }}
      onKeyDown={e => {
        if (e.key === 'ArrowLeft') sessions.resizePanes(leftPaneId, -0.05)
        if (e.key === 'ArrowRight') sessions.resizePanes(leftPaneId, 0.05)
      }}
      className="group relative z-20 w-px shrink-0 cursor-col-resize bg-border-subtle touch-none"
    >
      <span
        aria-hidden="true"
        className={clsx(
          'absolute inset-y-0 -left-1 w-2',
          active ? 'bg-accent/60' : 'group-hover:bg-accent/40',
        )}
      />
    </button>
  )
}
