import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import clsx from 'clsx'
import { Card } from './Card'

type SectionProps = {
  icon: React.ElementType
  title: string
  description: React.ReactNode
  children: React.ReactNode
  id?: string
  collapsible?: boolean
  defaultOpen?: boolean
}

export function Section({
  icon: Icon,
  title,
  description,
  children,
  id,
  collapsible = false,
  defaultOpen = true,
}: SectionProps) {
  const [open, setOpen] = useState(defaultOpen)

  const headerContent = (
    <div className="flex items-center gap-2 flex-1">
      <Icon className="w-5 h-5 text-accent shrink-0" />
      <div>
        <h2 className="text-compact font-semibold text-content-primary">{title}</h2>
        <p className="text-caption text-content-secondary mt-0.5">{description}</p>
      </div>
    </div>
  )

  return (
    <Card variant="default" className="overflow-hidden" id={id}>
      {collapsible ? (
        <button
          type="button"
          className="flex justify-between items-center w-full px-5 py-3 border-b border-border-subtle text-left"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          {headerContent}
          <ChevronDown
            className={clsx(
              'w-4 h-4 text-content-tertiary transition-transform duration-normal shrink-0 ml-2',
              open && 'rotate-180',
            )}
          />
        </button>
      ) : (
        <div className="px-5 py-3 border-b border-border-subtle">{headerContent}</div>
      )}
      <div
        className={clsx(
          'grid transition-[grid-template-rows] duration-normal',
          open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
        )}
      >
        <div className="overflow-hidden">
          <div className="px-5 py-4 space-y-4">{children}</div>
        </div>
      </div>
    </Card>
  )
}
