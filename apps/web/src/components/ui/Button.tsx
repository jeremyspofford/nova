import { forwardRef } from 'react'
import { Loader2 } from 'lucide-react'
import clsx from 'clsx'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline'
export type ButtonSize = 'sm' | 'md' | 'lg'

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-accent text-neutral-950 hover:bg-accent-hover active:bg-accent-400 dark:shadow-[0_0_20px_rgb(var(--accent-500)/0.2)] dark:hover:shadow-[0_0_28px_rgb(var(--accent-500)/0.3)]',
  secondary:
    'bg-surface-elevated border border-border text-content-primary hover:bg-surface-card-hover active:bg-surface-card',
  ghost:
    'text-content-secondary hover:bg-surface-elevated hover:text-content-primary active:bg-surface-card',
  danger:
    'bg-danger text-white hover:brightness-110 active:brightness-90',
  outline:
    'border border-border text-content-primary hover:bg-surface-elevated active:bg-surface-card',
}

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-7 px-2.5 gap-1 text-caption rounded-sm',
  md: 'h-9 px-3.5 gap-1.5 text-compact rounded-sm',
  lg: 'h-11 px-5 gap-2 text-body rounded-md',
}

const ICON_SIZES: Record<ButtonSize, number> = {
  sm: 12,
  md: 14,
  lg: 16,
}

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
  icon?: React.ReactNode
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = 'primary',
      size = 'md',
      loading,
      icon,
      className,
      children,
      disabled,
      ...rest
    },
    ref,
  ) => (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={clsx(
        'inline-flex items-center justify-center font-medium transition-all duration-fast',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/40',
        'disabled:opacity-50 disabled:pointer-events-none',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {loading ? (
        <Loader2 size={ICON_SIZES[size]} className="animate-spin" />
      ) : icon ? (
        <span className="shrink-0">{icon}</span>
      ) : null}
      {children}
    </button>
  ),
)
Button.displayName = 'Button'
