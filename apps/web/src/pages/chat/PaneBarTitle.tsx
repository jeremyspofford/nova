import { useContext } from 'react'
import { createPortal } from 'react-dom'
import { Home } from 'lucide-react'
import clsx from 'clsx'
import { MobileTitleSlot } from '../../components/layout/PageHeader'

/**
 * A pane's title: the session's name, or — for the main session — the main
 * tag ALONE (owner, 2026-10-15). The main chat is "main"; the name it was
 * given before it became main is legacy and is not drawn beside the tag.
 * One component for the desktop pane header and the phone's top bar, so the
 * two cannot name the main session two ways.
 */
export function PaneTitle({ label, main, className }: { label: string; main: boolean; className?: string }) {
  if (main) {
    return (
      <h1 className="shrink-0" data-testid="pane-title">
        <span
          data-testid="main-tag"
          title="The main session: where her digests and reminders set outside a chat land"
          className="inline-flex items-center gap-1 rounded-full bg-accent-dim px-2 py-0.5 text-micro text-accent"
        >
          <Home size={10} aria-hidden="true" />
          main
        </span>
      </h1>
    )
  }
  return (
    <h1 className={clsx('min-w-0 truncate text-h3 text-content-primary', className)} data-testid="pane-title">
      {label}
    </h1>
  )
}

/**
 * The session's title in the phone/tablet top bar (2026-10-11). Below lg the
 * chat hides its own pane header, so the bar beside the menu button was
 * empty on the one page used most. Only the pane in front draws here — two
 * panes portalling into one bar would read as one long title. With no bar
 * (desktop) it draws nothing: the pane header carries the title there.
 */
export function PaneBarTitle({ label, main, show }: { label: string; main: boolean; show: boolean }) {
  const slot = useContext(MobileTitleSlot)
  if (!slot || !show) return null
  return createPortal(
    <span className="flex min-w-0 items-center gap-2">
      <PaneTitle label={label} main={main} />
    </span>,
    slot,
  )
}
