import { forwardRef } from 'react'
import clsx from 'clsx'

type SelectItem = {
  value: string
  label: string
}

type SelectProps = Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'onChange'> & {
  label?: string
  description?: string
  error?: string
  items?: SelectItem[]
  onChange?: (e: React.ChangeEvent<HTMLSelectElement>) => void
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ label, description, error, items, className, id, children, ...rest }, ref) => {
    const selectId =
      id || (label ? `select-${label.toLowerCase().replace(/\s+/g, '-')}` : undefined)

    return (
      <div className={clsx('w-full', className)}>
        {label && (
          <label
            htmlFor={selectId}
            className="mb-1.5 block text-caption font-medium text-content-secondary"
          >
            {label}
          </label>
        )}
        <select
          ref={ref}
          id={selectId}
          className={clsx(
            'h-9 w-full rounded-sm border bg-surface-input px-3 text-compact text-content-primary',
            'outline-none transition-colors duration-fast appearance-none',
            'bg-[length:16px_16px] bg-[position:right_8px_center] bg-no-repeat',
            'bg-[url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2216%22%20height%3D%2216%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22%23999%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpath%20d%3D%22m6%209%206%206%206-6%22%2F%3E%3C%2Fsvg%3E")]',
            'pr-8',
            error
              ? 'border-danger ring-2 ring-danger/40'
              : 'border-border focus:border-border-focus focus:ring-2 focus:ring-accent-500/40',
            'disabled:opacity-50 disabled:cursor-not-allowed',
          )}
          aria-invalid={error ? true : undefined}
          aria-describedby={
            error ? `${selectId}-error` : description ? `${selectId}-desc` : undefined
          }
          {...rest}
        >
          {items
            ? items.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))
            : children}
        </select>
        {error ? (
          <p id={`${selectId}-error`} className="mt-1 text-caption text-danger">
            {error}
          </p>
        ) : description ? (
          <p id={`${selectId}-desc`} className="mt-1 text-caption text-content-tertiary">
            {description}
          </p>
        ) : null}
      </div>
    )
  },
)
Select.displayName = 'Select'
