import { useRef, useEffect } from 'react'
import clsx from 'clsx'

type CheckboxProps = {
  checked?: boolean
  indeterminate?: boolean
  onChange?: (checked: boolean) => void
  label?: string
  description?: string
  disabled?: boolean
  className?: string
  id?: string
}

export function Checkbox({
  checked = false,
  indeterminate = false,
  onChange,
  label,
  description,
  disabled = false,
  className,
  id,
}: CheckboxProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const checkboxId = id || (label ? `checkbox-${label.toLowerCase().replace(/\s+/g, '-')}` : undefined)

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.indeterminate = indeterminate
    }
  }, [indeterminate])

  const filled = checked || indeterminate

  return (
    <label
      htmlFor={checkboxId}
      className={clsx(
        'inline-flex gap-2.5 select-none',
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
        className,
      )}
    >
      <span className="relative mt-0.5 flex-shrink-0">
        <input
          ref={inputRef}
          id={checkboxId}
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange?.(e.target.checked)}
          disabled={disabled}
          className="sr-only peer"
        />
        <span
          className={clsx(
            'block h-4 w-4 rounded-xs border transition-colors duration-fast',
            'peer-focus-visible:ring-2 peer-focus-visible:ring-accent-500/40',
            filled
              ? 'bg-accent border-accent'
              : 'bg-surface-input border-border',
          )}
        >
          {filled && (
            <svg
              className="h-4 w-4 text-neutral-950"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              {indeterminate
                ? <path d="M4 8h8" />
                : <path d="M4 8l3 3 5-5" />
              }
            </svg>
          )}
        </span>
      </span>
      {(label || description) && (
        <span className="flex flex-col">
          {label && (
            <span className="text-compact text-content-primary leading-tight">{label}</span>
          )}
          {description && (
            <span className="text-caption text-content-tertiary mt-0.5">{description}</span>
          )}
        </span>
      )}
    </label>
  )
}
