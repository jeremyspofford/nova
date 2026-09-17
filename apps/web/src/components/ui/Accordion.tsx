import { useState, useCallback } from 'react'
import { ChevronDown } from 'lucide-react'
import clsx from 'clsx'

type AccordionItem = {
  id: string
  title: string
  content: React.ReactNode
}

type AccordionProps = {
  items: AccordionItem[]
  multiple?: boolean
  defaultOpen?: string[]
  className?: string
}

export function Accordion({ items, multiple = false, defaultOpen = [], className }: AccordionProps) {
  const [openIds, setOpenIds] = useState<Set<string>>(new Set(defaultOpen))

  const toggle = useCallback(
    (id: string) => {
      setOpenIds((prev) => {
        const next = new Set(prev)
        if (next.has(id)) {
          next.delete(id)
        } else {
          if (!multiple) next.clear()
          next.add(id)
        }
        return next
      })
    },
    [multiple],
  )

  return (
    <div className={clsx('divide-y divide-border-subtle', className)}>
      {items.map((item) => {
        const isOpen = openIds.has(item.id)
        return (
          <div key={item.id}>
            <button
              type="button"
              className="flex w-full items-center justify-between px-4 py-3 text-left text-compact font-medium text-content-primary hover:bg-surface-card-hover transition-colors duration-fast"
              onClick={() => toggle(item.id)}
              aria-expanded={isOpen}
            >
              {item.title}
              <ChevronDown
                className={clsx(
                  'w-4 h-4 text-content-tertiary transition-transform duration-normal shrink-0 ml-2',
                  isOpen && 'rotate-180',
                )}
              />
            </button>
            <div
              className={clsx(
                'grid transition-[grid-template-rows] duration-normal',
                isOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
              )}
            >
              <div className="overflow-hidden">
                <div className="px-4 pb-3 text-compact text-content-secondary">{item.content}</div>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
