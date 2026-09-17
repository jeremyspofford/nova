import clsx from 'clsx'
import type { SemanticColor } from '../../lib/design-tokens'

const colorStyles: Record<SemanticColor, string> = {
  neutral: 'bg-neutral-200/60 text-neutral-700 dark:bg-neutral-700/60 dark:text-neutral-300',
  // status text takes the mode's step through the tokens (index.css), so a
  // badge never has to know which ground it sits on
  accent: 'bg-accent-dim text-accent',
  success: 'bg-success-dim text-success',
  warning: 'bg-warning-dim text-warning',
  danger: 'bg-danger-dim text-danger',
  info: 'bg-info-dim text-info',
}

const dotColors: Record<SemanticColor, string> = {
  neutral: 'bg-neutral-700 dark:bg-neutral-300',
  accent: 'bg-accent-700 dark:bg-accent-400',
  success: 'bg-emerald-700 dark:bg-emerald-400',
  warning: 'bg-amber-700 dark:bg-amber-400',
  danger: 'bg-red-700 dark:bg-red-400',
  info: 'bg-blue-700 dark:bg-blue-400',
}

const sizeStyles = {
  sm: 'h-5 px-1.5 text-micro',
  md: 'h-6 px-2 text-caption',
}

export function Badge({
  color = 'neutral',
  size = 'md',
  dot,
  className,
  children,
}: {
  color?: SemanticColor
  size?: 'sm' | 'md'
  dot?: boolean
  className?: string
  children: React.ReactNode
}) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 rounded-xs font-medium',
        colorStyles[color],
        sizeStyles[size],
        className,
      )}
    >
      {dot && (
        <span className={clsx('inline-block h-1.5 w-1.5 rounded-full shadow-[0_0_4px_currentColor]', dotColors[color])} />
      )}
      {children}
    </span>
  )
}
