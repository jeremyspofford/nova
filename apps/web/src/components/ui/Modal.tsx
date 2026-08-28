import { useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import clsx from 'clsx'

type ModalSize = 'sm' | 'md' | 'lg' | 'xl'

type ModalProps = {
  open: boolean
  onClose: () => void
  size?: ModalSize
  title?: string
  children: React.ReactNode
  footer?: React.ReactNode
}

const SIZES: Record<ModalSize, string> = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
}

export function Modal({ open, onClose, size = 'md', title, children, footer }: ModalProps) {
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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-fade-in"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />

      {/* Content */}
      <div
        className={clsx(
          'relative w-full bg-surface-card rounded-xl border border-border-subtle shadow-lg glass-overlay dark:border-white/[0.12]',
          'transform transition-transform',
          SIZES[size],
        )}
        style={{ animation: 'scaleIn 150ms ease' }}
      >
        {title && (
          <div className="flex justify-between items-center px-6 py-4 border-b border-border-subtle">
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
        <div className="px-6 py-4 max-h-[70vh] overflow-y-auto">{children}</div>
        {footer && (
          <div className="px-6 py-4 border-t border-border-subtle flex justify-end gap-2">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
