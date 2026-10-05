import type { ReactNode } from 'react'
import { PageHelp } from '../ui/PageHelp'

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
  return (
    <div className="space-y-0 mb-8">
      {/* On a phone the actions sit under the title: side by side, they
          squeezed the description into a one-word column and pushed the last
          action off the screen (Models, 2026-10-05). */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-h1 text-content-primary">{title}</h1>
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
