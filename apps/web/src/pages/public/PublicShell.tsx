import clsx from 'clsx'
import { useTheme } from '../../stores/theme-store'
import { appIcon, appIconHref } from '../../lib/app-icon'

/**
 * The frame of a page a scanned setup QR code opens, before anyone signs in
 * (S47): the brand mark and one card, like the sign-in page. The document never
 * scrolls (index.css), so this is a fixed box that scrolls itself — a phone's
 * steps can be taller than its screen — padded by the safe-area insets, never
 * sized from a height.
 */
export function PublicShell({ title, children }: { title: string; children: React.ReactNode }) {
  const { brandIcon, mode, preset, customAccent } = useTheme()
  return (
    <div
      data-testid="public-shell"
      className="fixed inset-0 overflow-y-auto bg-surface-root px-4 pb-[calc(2.5rem+var(--nova-safe-bottom,0px))] pt-[calc(2.5rem+var(--nova-safe-top,0px))] dark:bg-transparent"
    >
      <div className="mx-auto w-full max-w-md">
        <div className="mb-6 flex flex-col items-center gap-3">
          <img
            src={appIconHref(brandIcon, mode, preset, customAccent)}
            alt=""
            aria-hidden="true"
            className={clsx('h-10 w-10', appIcon(brandIcon).filled && 'rounded-lg shadow-md')}
          />
          <h1 className="text-center text-xl font-semibold text-content-primary">{title}</h1>
        </div>
        <div className="glass-card space-y-4 rounded-lg border border-border bg-surface-card p-6 text-compact text-content-secondary shadow-sm dark:border-white/[0.08]">
          {children}
        </div>
      </div>
    </div>
  )
}
