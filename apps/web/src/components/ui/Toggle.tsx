import clsx from 'clsx'

type ToggleSize = 'sm' | 'md'

type ToggleProps = {
  checked?: boolean
  onChange?: (checked: boolean) => void
  label?: string
  size?: ToggleSize
  disabled?: boolean
  className?: string
  id?: string
}

const TRACK_SIZES: Record<ToggleSize, string> = {
  sm: 'h-4 w-7',
  md: 'h-5 w-9',
}

const KNOB_SIZES: Record<ToggleSize, string> = {
  sm: 'h-3 w-3',
  md: 'h-3.5 w-3.5',
}

const KNOB_TRANSLATE: Record<ToggleSize, string> = {
  sm: 'translate-x-3',
  md: 'translate-x-4',
}

export function Toggle({
  checked = false,
  onChange,
  label,
  size = 'md',
  disabled = false,
  className,
  id,
}: ToggleProps) {
  const toggleId = id || (label ? `toggle-${label.toLowerCase().replace(/\s+/g, '-')}` : undefined)

  return (
    <label
      htmlFor={toggleId}
      className={clsx(
        'inline-flex items-center gap-2.5 select-none',
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
        className,
      )}
    >
      <span className="relative flex-shrink-0">
        <input
          id={toggleId}
          type="checkbox"
          role="switch"
          checked={checked}
          onChange={(e) => onChange?.(e.target.checked)}
          disabled={disabled}
          className="sr-only peer"
        />
        <span
          className={clsx(
            'block rounded-full transition-colors duration-fast',
            'peer-focus-visible:ring-2 peer-focus-visible:ring-accent-500/40',
            TRACK_SIZES[size],
            checked ? 'bg-accent' : 'bg-neutral-300 dark:bg-neutral-600',
          )}
        />
        <span
          className={clsx(
            'absolute top-0.5 left-0.5 rounded-full bg-white shadow-sm transition-transform duration-fast',
            KNOB_SIZES[size],
            checked && KNOB_TRANSLATE[size],
          )}
        />
      </span>
      {label && (
        <span className="text-compact text-content-primary">{label}</span>
      )}
    </label>
  )
}
