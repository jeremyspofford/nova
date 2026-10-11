import { createContext, useContext, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { PageHelp } from '../ui/PageHelp'

/**
 * True inside a shell that already carries the screen's title — Settings,
 * since 2026-10-08, which draws "Settings" above its own nav and renders
 * Agents, Skills, the catalog and the rest beside it. A page there is a
 * section of that screen: its title becomes an h2, a step smaller, so the
 * screen has one h1 and one largest title rather than two competing ones.
 * The same page rendered on its own is unchanged.
 */
export const InShellContext = createContext(false)

/**
 * The phone's top bar (AppLayout), or null off a phone. On a phone the page
 * title goes UP into the bar beside the menu button, and the description is
 * dropped: a 24px title, a sentence about it and the 3rem row the button
 * sat alone in used to take ~170px before any content (2026-10-11 spike —
 * a markdown file's text started at y=357 of 852).
 */
export const MobileTitleSlot = createContext<HTMLElement | null>(null)

/** A screen title that is not a PageHeader (the Settings list): in the
 *  phone's top bar when there is one, in the page otherwise. */
export function ScreenTitle({ children, className }: { children: string; className: string }) {
  const slot = useContext(MobileTitleSlot)
  if (slot) {
    return createPortal(<h1 className="min-w-0 truncate text-h3 text-content-primary">{children}</h1>, slot)
  }
  return <h1 className={className}>{children}</h1>
}

export function PageHeader({
  title,
  description,
  actions,
  helpEntries,
}: {
  title: string
  description?: string
  actions?: ReactNode
  helpEntries?: { term: string; definition: string }[]
}) {
  const inShell = useContext(InShellContext)
  const slot = useContext(MobileTitleSlot)
  const hasActions = Boolean(actions) || (helpEntries?.length ?? 0) > 0
  // In Settings' shell too: on a phone the shell shows its list OR one page,
  // never both, so the bar carries exactly one title either way.
  if (slot) {
    return (
      <>
        {createPortal(<h1 className="min-w-0 truncate text-h3 text-content-primary">{title}</h1>, slot)}
        {hasActions && (
          <div className="mb-4 flex flex-wrap items-center gap-2">
            {helpEntries && helpEntries.length > 0 && <PageHelp entries={helpEntries} />}
            {actions}
          </div>
        )}
      </>
    )
  }
  return (
    <div className={inShell ? 'space-y-0 mb-6' : 'space-y-0 mb-8'}>
      {/* On a phone the actions sit under the title: side by side, they
          squeezed the description into a one-word column and pushed the last
          action off the screen (Models, 2026-10-05). */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          {inShell ? (
            <h2 className="text-h2 text-content-primary">{title}</h2>
          ) : (
            <h1 className="text-h1 text-content-primary">{title}</h1>
          )}
          {description && (
            <p className="text-body text-content-secondary mt-1">{description}</p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:shrink-0 sm:justify-end">
          {helpEntries && helpEntries.length > 0 && <PageHelp entries={helpEntries} />}
          {actions}
        </div>
      </div>
    </div>
  )
}
