import { CheckCircle, XCircle, AlertTriangle, Info, X } from 'lucide-react'
import clsx from 'clsx'

export type ToastVariant = 'success' | 'error' | 'warning' | 'info'

type ToastProps = {
  variant: ToastVariant
  message: string
  action?: { label: string; onClick: () => void }
  onDismiss: () => void
}

const ICONS: Record<ToastVariant, React.ElementType> = {
  success: CheckCircle,
  error: XCircle,
  warning: AlertTriangle,
  info: Info,
}

const ICON_COLORS: Record<ToastVariant, string> = {
  success: 'text-success',
  error: 'text-danger',
  warning: 'text-warning',
  info: 'text-info',
}

export function Toast({ variant, message, action, onDismiss }: ToastProps) {
  const Icon = ICONS[variant]

  return (
    <div
      className={clsx(
        'flex items-center gap-3 bg-surface-card border border-border rounded-lg shadow-md px-4 py-3 glass-overlay dark:border-white/[0.10]',
        'animate-fade-in',
      )}
    >
      <Icon className={clsx('w-5 h-5 shrink-0', ICON_COLORS[variant])} />
      <span className="text-compact text-content-primary flex-1">{message}</span>
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className="text-compact font-medium text-accent hover:text-accent-hover transition-colors duration-fast whitespace-nowrap"
        >
          {action.label}
        </button>
      )}
      <button
        type="button"
        onClick={onDismiss}
        className="text-content-tertiary hover:text-content-primary transition-colors duration-fast p-0.5 shrink-0"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}
