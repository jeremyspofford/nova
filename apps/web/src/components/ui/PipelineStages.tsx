import clsx from 'clsx'
import { PIPELINE_STAGES } from '../../lib/design-tokens'

type StageStatus = 'done' | 'active' | 'pending' | 'failed'

const statusStyles: Record<StageStatus, string> = {
  done: 'bg-accent',
  active: 'bg-accent animate-pulse-slow',
  pending: 'bg-border-subtle',
  failed: 'bg-danger',
}

export function PipelineStages({
  stages,
  compact,
  className,
}: {
  stages: StageStatus[]
  compact?: boolean
  className?: string
}) {
  return (
    <div className={clsx('inline-flex items-start gap-1', className)}>
      {stages.map((status, i) => (
        <div key={i} className={clsx('flex flex-col items-center', !compact && 'gap-1')}>
          <div
            className={clsx(
              'rounded-xs',
              statusStyles[status],
              compact ? 'w-6 h-1' : 'w-10 h-1.5',
            )}
          />
          {!compact && (
            <span className="text-micro text-content-tertiary capitalize">
              {PIPELINE_STAGES[i]?.replace('_', ' ') ?? `Stage ${i + 1}`}
            </span>
          )}
        </div>
      ))}
    </div>
  )
}
