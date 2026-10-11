import { useContext } from 'react'
import { createPortal } from 'react-dom'
import { Home } from 'lucide-react'
import { MobileTitleSlot } from '../../components/layout/PageHeader'

/**
 * The session's name in the phone/tablet top bar (2026-10-11). Below lg the
 * chat hides its own pane header, so the bar beside the menu button was
 * empty on the one page used most. Only the pane in front draws here — two
 * panes portalling into one bar would read as one long title. With no bar
 * (desktop) it draws nothing: the pane header carries the name there.
 */
export function PaneBarTitle({ label, main, show }: { label: string; main: boolean; show: boolean }) {
  const slot = useContext(MobileTitleSlot)
  if (!slot || !show) return null
  return createPortal(
    <span className="flex min-w-0 items-center gap-2">
      <h1 className="min-w-0 truncate text-h3 text-content-primary">{label}</h1>
      {main && (
        <span title="The main session: where digests and reminders land" className="shrink-0 text-accent">
          <Home size={14} aria-hidden="true" />
        </span>
      )}
    </span>,
    slot,
  )
}
