import clsx from 'clsx'

type RadioOption = {
  value: string
  label: string
  description?: string
}

type RadioGroupProps = {
  options: RadioOption[]
  value?: string
  onChange?: (value: string) => void
  name: string
  disabled?: boolean
  className?: string
}

export function RadioGroup({
  options,
  value,
  onChange,
  name,
  disabled = false,
  className,
}: RadioGroupProps) {
  return (
    <div role="radiogroup" className={clsx('flex flex-col gap-2', className)}>
      {options.map((option) => (
        <label
          key={option.value}
          className={clsx(
            'inline-flex gap-2.5 select-none',
            disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
          )}
        >
          <span className="relative mt-0.5 flex-shrink-0">
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange?.(option.value)}
              disabled={disabled}
              className="sr-only peer"
            />
            <span
              className={clsx(
                'block h-4 w-4 rounded-full border-2 transition-colors duration-fast',
                'peer-focus-visible:ring-2 peer-focus-visible:ring-accent-500/40',
                value === option.value
                  ? 'border-accent'
                  : 'border-border',
              )}
            >
              {value === option.value && (
                <span className="block h-full w-full rounded-full bg-accent scale-[0.5]" />
              )}
            </span>
          </span>
          <span className="flex flex-col">
            <span className="text-compact text-content-primary leading-tight">{option.label}</span>
            {option.description && (
              <span className="text-caption text-content-tertiary mt-0.5">{option.description}</span>
            )}
          </span>
        </label>
      ))}
    </div>
  )
}
