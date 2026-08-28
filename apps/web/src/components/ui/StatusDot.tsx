import clsx from 'clsx'

const colorStyles = {
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  neutral: 'bg-neutral-400',
} as const

const sizeStyles = {
  sm: 'h-1.5 w-1.5',
  md: 'h-2 w-2',
  lg: 'h-2.5 w-2.5',
} as const

export function StatusDot({
  status,
  pulse,
  size = 'md',
  className,
}: {
  status: 'success' | 'warning' | 'danger' | 'neutral'
  pulse?: boolean
  size?: 'sm' | 'md' | 'lg'
  className?: string
}) {
  return (
    <span
      className={clsx(
        'inline-block rounded-full',
        colorStyles[status],
        sizeStyles[size],
        pulse && 'animate-pulse-slow',
        className,
      )}
    />
  )
}
