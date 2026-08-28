import clsx from 'clsx'

type SliderProps = {
  min?: number
  max?: number
  step?: number
  value?: number
  onChange?: (value: number) => void
  label?: string
  disabled?: boolean
  className?: string
  id?: string
}

export function Slider({
  min = 0,
  max = 100,
  step = 1,
  value = 0,
  onChange,
  label,
  disabled = false,
  className,
  id,
}: SliderProps) {
  const sliderId = id || (label ? `slider-${label.toLowerCase().replace(/\s+/g, '-')}` : undefined)
  const percentage = ((value - min) / (max - min)) * 100

  return (
    <div className={clsx('w-full', className)}>
      {label && (
        <div className="flex items-center justify-between mb-1.5">
          <label htmlFor={sliderId} className="text-caption font-medium text-content-secondary">
            {label}
          </label>
          <span className="text-caption font-mono text-content-tertiary">{value}</span>
        </div>
      )}
      <input
        id={sliderId}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange?.(Number(e.target.value))}
        disabled={disabled}
        className={clsx(
          'w-full h-1.5 rounded-full appearance-none cursor-pointer outline-none',
          'focus-visible:ring-2 focus-visible:ring-accent-500/40 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-root',
          'disabled:opacity-50 disabled:cursor-not-allowed',
          '[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4',
          '[&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-accent [&::-webkit-slider-thumb]:shadow-sm',
          '[&::-webkit-slider-thumb]:transition-transform [&::-webkit-slider-thumb]:duration-fast',
          '[&::-webkit-slider-thumb]:hover:scale-110',
          '[&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:border-0',
          '[&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-accent [&::-moz-range-thumb]:shadow-sm',
        )}
        style={{
          background: `linear-gradient(to right, rgb(var(--accent-500)) ${percentage}%, rgb(var(--neutral-300)) ${percentage}%)`,
        }}
      />
      {!label && (
        <div className="flex justify-end mt-1">
          <span className="text-caption font-mono text-content-tertiary">{value}</span>
        </div>
      )}
    </div>
  )
}
