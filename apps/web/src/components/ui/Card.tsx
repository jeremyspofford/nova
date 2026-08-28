import clsx from 'clsx'

type CardVariant = 'default' | 'hoverable' | 'outlined'

type CardProps = {
  variant?: CardVariant
  header?: { title: string; action?: React.ReactNode }
  footer?: React.ReactNode
  children: React.ReactNode
  className?: string
  glow?: boolean
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'className'>

const VARIANTS: Record<CardVariant, string> = {
  default: 'bg-surface-card border border-border-subtle rounded-lg glass-card dark:border-white/[0.08]',
  hoverable:
    'bg-surface-card border border-border-subtle rounded-lg glass-card dark:border-white/[0.08] hover:border-border hover:bg-surface-card-hover transition-colors cursor-pointer dark:hover:border-white/[0.12] dark:hover:shadow-glow',
  outlined: 'bg-surface-card border border-border rounded-lg glass-card dark:border-white/[0.10]',
}

export function Card({
  variant = 'default',
  header,
  footer,
  children,
  className,
  glow,
  ...rest
}: CardProps) {
  return (
    <div className={clsx(VARIANTS[variant], glow && 'card-glow', className)} {...rest}>
      {header && (
        <div className="flex justify-between items-center px-5 py-3 border-b border-border-subtle">
          <span className="text-compact font-semibold text-content-primary">{header.title}</span>
          {header.action && (
            <span className="text-caption text-accent-muted hover:text-accent cursor-pointer">
              {header.action}
            </span>
          )}
        </div>
      )}
      <div>{children}</div>
      {footer && (
        <div className="px-5 py-3 border-t border-border-subtle flex justify-end gap-2">
          {footer}
        </div>
      )}
    </div>
  )
}
