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
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-h1 text-content-primary">{title}</h1>
          {description && (
            <p className="text-body text-content-secondary mt-1">{description}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {helpEntries && helpEntries.length > 0 && <PageHelp entries={helpEntries} />}
          {actions}
        </div>
      </div>
    </div>
  )
}
