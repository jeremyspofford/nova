import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronRight,
  Columns2,
  Home,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react'
import type { ChatSession } from '../../lib/api'
import { SESSION_DRAG_TYPE, useSessions } from '../../stores/sessions-store'
import { useToast } from '../ToastProvider'
import { ConfirmDialog } from '../ui/ConfirmDialog'

/**
 * The sessions section of the sidebar (and of the phone's drawer): every chat
 * session he has, newest activity first, each one openable, draggable onto
 * the chat to split it, and renamable, archivable and deletable from its
 * menu. The archive folds open below.
 *
 * Every action waits for core and the list is re-read after it — a row
 * never claims a rename, archive or delete that core did not confirm. A
 * failure is said in a toast with core's own reason.
 */
export function SessionsList(props: { onNavigate?: () => void; touch?: boolean }) {
  // Outside a SessionsProvider (a layout rendered alone) there is no list,
  // and nothing is drawn rather than an empty one that reads as "none".
  return useSessions() ? <SessionsListBody {...props} /> : null
}

function SessionsListBody({ onNavigate, touch = false }: { onNavigate?: () => void; touch?: boolean }) {
  const sessions = useSessions()!
  const { addToast } = useToast()
  const [showArchived, setShowArchived] = useState(false)
  const [confirming, setConfirming] = useState<ChatSession | null>(null)

  const fail = (what: string) => (err: unknown) =>
    addToast({
      variant: 'error',
      message: `Could not ${what}: ${err instanceof Error ? err.message : String(err)}`,
    })

  const openIds = new Set(sessions.panes.map(p => p.effectiveSessionId))
  const focusedId = sessions.panes.find(p => p.id === sessions.focused)?.effectiveSessionId

  const toggleArchived = () => {
    const next = !showArchived
    setShowArchived(next)
    if (next) void sessions.loadArchived()
  }

  const confirmDelete = async () => {
    const target = confirming
    setConfirming(null)
    if (!target) return
    try {
      const result = await sessions.remove(target.id)
      const parts = [`Deleted “${target.label}” — ${result.messages} message${result.messages === 1 ? '' : 's'}`]
      if (result.timers_unlinked > 0) {
        parts.push(
          `${result.timers_unlinked} reminder${result.timers_unlinked === 1 ? '' : 's'} set there will still fire but have no chat to land in`,
        )
      }
      addToast({ variant: result.timers_unlinked > 0 ? 'warning' : 'success', message: parts.join('; ') })
    } catch (err) {
      fail('delete the session')(err)
    }
  }

  return (
    <div data-testid="sessions-list">
      <div className="flex items-center justify-between px-2.5 mb-1">
        <span className="text-micro font-semibold uppercase tracking-wider text-content-tertiary">
          Sessions
        </span>
        <button
          type="button"
          data-testid="new-session"
          title="New session"
          aria-label="New session"
          onClick={() => {
            void sessions.newSession().then(onNavigate, fail('start a session'))
          }}
          className="rounded-md p-1 text-content-tertiary hover:bg-surface-card hover:text-content-primary"
        >
          <Plus size={14} />
        </button>
      </div>

      {sessions.error && (
        <p role="alert" className="px-2.5 py-1 text-caption text-danger">
          {sessions.error}
        </p>
      )}

      <ul className="space-y-0.5">
        {sessions.sessions.map(session => (
          <SessionRow
            key={session.id}
            session={session}
            open={openIds.has(session.id)}
            focused={focusedId === session.id}
            touch={touch}
            onOpen={() => {
              sessions.openSession(session.id)
              onNavigate?.()
            }}
            onDelete={() => setConfirming(session)}
            fail={fail}
          />
        ))}
      </ul>

      <button
        type="button"
        data-testid="toggle-archived"
        onClick={toggleArchived}
        aria-expanded={showArchived}
        className="mt-2 flex w-full items-center gap-1 rounded-md px-2.5 py-1 text-caption text-content-tertiary hover:text-content-primary"
      >
        {showArchived ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        Archived
        {sessions.archived !== null && ` (${sessions.archived.length})`}
      </button>
      {showArchived && (
        <ul className="space-y-0.5" data-testid="archived-list">
          {sessions.archived === null && (
            <li className="px-2.5 py-1 text-caption text-content-tertiary">Reading…</li>
          )}
          {sessions.archived?.length === 0 && (
            <li className="px-2.5 py-1 text-caption text-content-tertiary">Nothing archived.</li>
          )}
          {sessions.archived?.map(session => (
            <li
              key={session.id}
              data-testid={`archived-${session.id}`}
              className="group flex items-center gap-1 rounded-md px-2.5 py-1.5 text-compact text-content-tertiary hover:bg-surface-card"
            >
              <span className="min-w-0 flex-1 truncate" title={session.label}>
                {session.label}
              </span>
              <button
                type="button"
                data-testid={`unarchive-${session.id}`}
                title="Unarchive"
                aria-label={`Unarchive ${session.label}`}
                onClick={() => void sessions.unarchive(session.id).catch(fail('unarchive the session'))}
                className="rounded p-1 hover:text-content-primary"
              >
                <ArchiveRestore size={13} />
              </button>
              <button
                type="button"
                data-testid={`delete-archived-${session.id}`}
                title="Delete"
                aria-label={`Delete ${session.label}`}
                onClick={() => setConfirming(session)}
                className="rounded p-1 hover:text-danger"
              >
                <Trash2 size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        title="Delete this session?"
        description={
          confirming
            ? `“${confirming.label}” and its ${confirming.message_count} message${
                confirming.message_count === 1 ? '' : 's'
              }, side rooms and attachments are removed. What she did stays in Activity, and what she learned stays in memory. This cannot be undone.`
            : ''
        }
        confirmLabel="Delete"
        destructive
        onConfirm={() => void confirmDelete()}
      />
    </div>
  )
}

function SessionRow({
  session,
  open,
  focused,
  touch,
  onOpen,
  onDelete,
  fail,
}: {
  session: ChatSession
  open: boolean
  focused: boolean
  touch: boolean
  onOpen: () => void
  onDelete: () => void
  fail: (what: string) => (err: unknown) => void
}) {
  const sessions = useSessions()!
  const [menu, setMenu] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(session.title ?? '')
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menu) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(false)
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(false)
    }
    window.addEventListener('keydown', onKey)
    const id = setTimeout(() => window.addEventListener('mousedown', onDown))
    return () => {
      clearTimeout(id)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onDown)
    }
  }, [menu])

  const saveRename = () => {
    setRenaming(false)
    const title = draft.trim()
    if (title === (session.title ?? '')) return
    void sessions.rename(session.id, title || null).catch(fail('rename the session'))
  }

  if (renaming) {
    return (
      <li className="px-1">
        <input
          autoFocus
          data-testid={`rename-input-${session.id}`}
          value={draft}
          placeholder={session.label}
          onChange={e => setDraft(e.target.value)}
          onBlur={saveRename}
          onKeyDown={e => {
            if (e.key === 'Enter') saveRename()
            if (e.key === 'Escape') {
              setDraft(session.title ?? '')
              setRenaming(false)
            }
          }}
          className="w-full rounded-md border border-accent bg-surface-card px-2 py-1.5 text-compact text-content-primary outline-none"
        />
      </li>
    )
  }

  const item = (
    label: string,
    icon: React.ReactNode,
    onClick: () => void,
    testid: string,
    danger = false,
  ) => (
    <button
      type="button"
      data-testid={testid}
      onClick={() => {
        setMenu(false)
        onClick()
      }}
      className={clsx(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-compact',
        danger ? 'text-danger hover:bg-danger-dim' : 'text-content-secondary hover:bg-surface-card-hover hover:text-content-primary',
      )}
    >
      {icon}
      {label}
    </button>
  )

  return (
    <li
      data-testid={`session-${session.id}`}
      data-open={String(open)}
      // Raised while its menu is open: the menu's anchor is translated, which
      // makes it a stacking context, so without this the NEXT row paints
      // over the menu and takes its clicks.
      className={clsx('group relative', menu && 'z-50')}
      draggable={!touch}
      onDragStart={e => {
        e.dataTransfer.setData(SESSION_DRAG_TYPE, session.id)
        e.dataTransfer.setData('text/plain', session.label)
        e.dataTransfer.effectAllowed = 'move'
        sessions.setDragging(session.id)
      }}
      onDragEnd={() => sessions.setDragging(null)}
    >
      <button
        type="button"
        onClick={onOpen}
        title={touch ? session.label : `${session.label}\nDrag onto the chat to open it side by side`}
        className={clsx(
          'flex w-full items-center gap-2 rounded-md py-1.5 pl-2.5 pr-8 text-left text-compact transition-colors duration-fast',
          focused
            ? 'bg-accent-dim text-accent'
            : open
              ? 'bg-surface-card text-content-primary'
              : 'text-content-secondary hover:bg-surface-card hover:text-content-primary',
        )}
      >
        {session.busy ? (
          <span
            title="Nova is working in this session"
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent animate-pulse"
          />
        ) : session.main ? (
          <span title="Main session: where digests and outside reminders land">
            <Home size={12} className="shrink-0 opacity-70" />
          </span>
        ) : (
          <span className="h-1.5 w-1.5 shrink-0" />
        )}
        <span className="truncate">{session.label}</span>
      </button>
      <div ref={menuRef} className="absolute right-1 top-1/2 -translate-y-1/2">
        <button
          type="button"
          data-testid={`session-menu-${session.id}`}
          aria-label={`Actions for ${session.label}`}
          aria-expanded={menu}
          onClick={() => setMenu(v => !v)}
          className={clsx(
            'rounded p-1 text-content-tertiary hover:text-content-primary',
            menu || touch ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus:opacity-100',
          )}
        >
          <MoreHorizontal size={14} />
        </button>
        {menu && (
          <div
            role="menu"
            className="absolute right-0 top-full z-50 mt-1 w-48 rounded-lg border border-border bg-surface-card p-1 shadow-lg glass-overlay dark:border-white/[0.10]"
          >
            {sessions.canSplit &&
              !open &&
              item('Open in split view', <Columns2 size={13} />, () => sessions.openInSplit(session.id), `split-${session.id}`)}
            {item('Rename', <Pencil size={13} />, () => {
              setDraft(session.title ?? '')
              setRenaming(true)
            }, `rename-${session.id}`)}
            {!session.main &&
              item(
                'Make main',
                <Home size={13} />,
                () => void sessions.makeMain(session.id).catch(fail('make it the main session')),
                `make-main-${session.id}`,
              )}
            {item(
              'Archive',
              <Archive size={13} />,
              () => void sessions.archive(session.id).catch(fail('archive the session')),
              `archive-${session.id}`,
            )}
            {item('Delete', <Trash2 size={13} />, onDelete, `delete-${session.id}`, true)}
          </div>
        )}
      </div>
    </li>
  )
}
