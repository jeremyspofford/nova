import { useState, useRef, useEffect, useCallback } from 'react'
import clsx from 'clsx'

type PopoverAlign = 'start' | 'center' | 'end'

type PopoverProps = {
  trigger: React.ReactNode
  children: React.ReactNode
  align?: PopoverAlign
  className?: string
}

const ALIGN: Record<PopoverAlign, string> = {
  start: 'left-0',
  center: 'left-1/2 -translate-x-1/2',
  end: 'right-0',
}

export function Popover({ trigger, children, align = 'start', className }: PopoverProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const handleClickOutside = useCallback(
    (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    },
    [],
  )

  useEffect(() => {
    if (open) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [open, handleClickOutside])

  return (
    <div ref={ref} className={clsx('relative inline-flex', className)}>
      <div onClick={() => setOpen((v) => !v)} className="cursor-pointer">
        {trigger}
      </div>
      {open && (
        <div
          className={clsx(
            'absolute top-full mt-1 z-40',
            'bg-surface-card border border-border rounded-lg shadow-lg p-2 glass-overlay dark:border-white/[0.10]',
            'animate-fade-in',
            ALIGN[align],
          )}
        >
          {children}
        </div>
      )}
    </div>
  )
}
