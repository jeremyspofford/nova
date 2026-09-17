import clsx from 'clsx'

interface AudioLevelIndicatorProps {
  /** Audio level 0–1 */
  level: number
  /** Number of bars to render */
  bars?: number
  /** Extra class on the wrapper */
  className?: string
}

/**
 * Animated equalizer-style bars that respond to mic audio level.
 * Each bar gets a slightly different threshold so they stagger naturally.
 */
export function AudioLevelIndicator({ level, bars = 4, className }: AudioLevelIndicatorProps) {
  return (
    <div className={clsx('flex items-center gap-[2px]', className)}>
      {Array.from({ length: bars }, (_, i) => {
        // Stagger thresholds: first bar activates at low levels, last at high
        const threshold = (i + 1) / (bars + 1)
        const active = level > threshold * 0.5
        // Scale height with level, min 20% when active
        const heightPct = active ? Math.max(20, Math.min(100, level * 100 + (bars - i) * 8)) : 20
        return (
          <div
            key={i}
            className={clsx(
              'w-[3px] rounded-full transition-all duration-75',
              active ? 'bg-red-400' : 'bg-stone-600',
            )}
            style={{ height: `${heightPct}%`, maxHeight: '100%' }}
          />
        )
      })}
    </div>
  )
}
