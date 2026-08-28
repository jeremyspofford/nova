import { useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import clsx from 'clsx'

type SheetWidth = 'default' | 'wide' | 'half'

type SheetProps = {
  open: boolean
  onClose: () => void
  width?: SheetWidth
  title?: string
  children: React.ReactNode
}

const WIDTHS: Record<SheetWidth, string> = {
  default: 'w-[360px]',
  wide: 'w-[480px]',
  half: 'w-1/2',
}

export function Sheet({ open, onClose, width = 'default', title, children }: SheetProps) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    },
    [onClose],
  )

  useEffect(() => {
    if (open) {
      document.addEventListener('keydown', handleKeyDown)
      document.body.style.overflow = 'hidden'
      return () => {
        document.removeEventListener('keydown', handleKeyDown)
        document.body.style.overflow = ''
      }
    }
  }, [open, handleKeyDown])

  if (!open) return null

  return createPortal(
    <div className="fixed inset-0 z-50 animate-fade-in">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />

      {/* Panel */}
      <div
        className={clsx(
          'fixed right-0 top-0 bottom-0 flex flex-col',
          'bg-surface-card border-l border-border-subtle shadow-lg glass-overlay dark:border-white/[0.10]',
          'animate-slide-in-right',
          WIDTHS[width],
        )}
      >
        {title && (
          <div className="flex justify-between items-center px-5 py-4 border-b border-border-subtle shrink-0">
            <h2 className="text-h3 text-content-primary">{title}</h2>
            <button
              type="button"
              onClick={onClose}
              className="text-content-tertiary hover:text-content-primary transition-colors duration-fast p-1 rounded-sm hover:bg-surface-elevated"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}
        <div className="overflow-y-auto flex-1">{children}</div>
      </div>
    </div>,
    document.body,
  )
}
