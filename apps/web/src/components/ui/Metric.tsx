import clsx from 'clsx'
import { Tooltip } from './Tooltip'

export function Metric({
  label,
  value,
  icon,
  change,
  tooltip,
  className,
}: {
  label: string
  value: string | number
  icon?: React.ReactNode
  change?: { value: string; direction: 'up' | 'down' }
  tooltip?: string
  className?: string
}) {
  const labelContent = (
    <span className="text-caption font-medium text-content-tertiary uppercase tracking-wider inline-flex items-center gap-1.5">
      {icon}
      {label}
    </span>
  )

  return (
    <div className={clsx('flex flex-col gap-1', className)}>
      {tooltip ? <Tooltip content={tooltip} side="bottom">{labelContent}</Tooltip> : labelContent}
      <span className="text-display font-mono text-content-primary dark:drop-shadow-[0_0_8px_rgb(var(--accent-500)/0.15)]">{value}</span>
      {change && (
        <span
          className={clsx(
            'text-caption',
            change.direction === 'up' ? 'text-success' : 'text-danger',
          )}
        >
          {change.direction === 'up' ? '\u2191' : '\u2193'} {change.value}
        </span>
      )}
    </div>
  )
}
