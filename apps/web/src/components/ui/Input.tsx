import { forwardRef } from 'react'
import clsx from 'clsx'

type InputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'prefix'> & {
  label?: string
  description?: string
  error?: string
  prefix?: React.ReactNode
  suffix?: React.ReactNode
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, description, error, prefix, suffix, className, id, ...rest }, ref) => {
    const inputId = id || (label ? `input-${label.toLowerCase().replace(/\s+/g, '-')}` : undefined)

    return (
      <div className="w-full">
        {label && (
          <label
            htmlFor={inputId}
            className="mb-1.5 block text-caption font-medium text-content-secondary"
          >
            {label}
          </label>
        )}
        <div className="relative">
          {prefix && (
            <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-2.5 text-content-tertiary">
              {prefix}
            </span>
          )}
          <input
            ref={ref}
            id={inputId}
            className={clsx(
              'h-9 w-full rounded-sm border bg-surface-input px-3 text-compact text-content-primary',
              'placeholder:text-content-tertiary',
              'outline-none transition-colors duration-fast',
              error
                ? 'border-danger ring-2 ring-danger/40'
                : 'border-border focus:border-border-focus focus:ring-2 focus:ring-accent-500/40',
              'disabled:opacity-50 disabled:cursor-not-allowed',
              prefix && 'pl-8',
              suffix && 'pr-8',
              className,
            )}
            aria-invalid={error ? true : undefined}
            aria-describedby={
              error ? `${inputId}-error` : description ? `${inputId}-desc` : undefined
            }
            {...rest}
          />
          {suffix && (
            <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2.5 text-content-tertiary">
              {suffix}
            </span>
          )}
        </div>
        {error ? (
          <p id={`${inputId}-error`} className="mt-1 text-caption text-danger">
            {error}
          </p>
        ) : description ? (
          <p id={`${inputId}-desc`} className="mt-1 text-caption text-content-tertiary">
            {description}
          </p>
        ) : null}
      </div>
    )
  },
)
Input.displayName = 'Input'
