import clsx from 'clsx'

const sizeStyles = {
  sm: 'h-1',
  md: 'h-2',
} as const

export function ProgressBar({
  value,
  variant = 'determinate',
  size = 'md',
  className,
}: {
  value?: number
  variant?: 'determinate' | 'indeterminate'
  size?: 'sm' | 'md'
  className?: string
}) {
  const clampedValue = value !== undefined ? Math.max(0, Math.min(100, value)) : 0

  return (
    <div
      className={clsx(
        'w-full bg-border-subtle rounded-full overflow-hidden',
        sizeStyles[size],
        className,
      )}
      role="progressbar"
      aria-valuenow={variant === 'determinate' ? clampedValue : undefined}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className={clsx(
          'h-full bg-accent rounded-full dark:shadow-[0_0_8px_rgb(var(--accent-500)/0.3)]',
          variant === 'indeterminate' && 'animate-shimmer bg-[length:200%_100%] bg-gradient-to-r from-accent via-accent-hover to-accent w-full',
        )}
        style={variant === 'determinate' ? { width: `${clampedValue}%`, transition: 'width 300ms ease' } : undefined}
      />
    </div>
  )
}
