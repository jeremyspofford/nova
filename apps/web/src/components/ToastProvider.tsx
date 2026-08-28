import { createContext, useContext, useCallback, useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Toast } from './ui/Toast'
import type { ToastVariant } from './ui/Toast'

type ToastOptions = {
  variant: ToastVariant
  message: string
  action?: { label: string; onClick: () => void }
}

type ToastEntry = ToastOptions & { id: number }

type ToastContextValue = {
  addToast: (opts: ToastOptions) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within a ToastProvider')
  return ctx
}

const AUTO_DISMISS: Record<ToastVariant, number | null> = {
  success: 5000,
  info: 5000,
  warning: 8000,
  error: null,
}

const MAX_VISIBLE = 5

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([])
  const nextId = useRef(0)
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map())

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
    const timer = timers.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timers.current.delete(id)
    }
  }, [])

  const addToast = useCallback(
    (opts: ToastOptions) => {
      const id = nextId.current++
      setToasts((prev) => {
        const next = [...prev, { ...opts, id }]
        // Keep only the latest MAX_VISIBLE
        return next.slice(-MAX_VISIBLE)
      })
      const duration = AUTO_DISMISS[opts.variant]
      if (duration !== null) {
        const timer = setTimeout(() => dismiss(id), duration)
        timers.current.set(id, timer)
      }
    },
    [dismiss],
  )

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      timers.current.forEach((t) => clearTimeout(t))
    }
  }, [])

  return (
    <ToastContext.Provider value={{ addToast }}>
      {children}
      {createPortal(
        <div className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2 max-w-sm w-full pointer-events-none">
          {toasts.map((toast) => (
            <div key={toast.id} className="pointer-events-auto">
              <Toast
                variant={toast.variant}
                message={toast.message}
                action={toast.action}
                onDismiss={() => dismiss(toast.id)}
              />
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  )
}
