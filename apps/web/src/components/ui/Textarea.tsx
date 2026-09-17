import { forwardRef, useEffect, useRef, useCallback } from 'react'
import clsx from 'clsx'

type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label?: string
  description?: string
  error?: string
  showCount?: boolean
  autoResize?: boolean
  maxHeight?: number
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  (
    {
      label,
      description,
      error,
      showCount,
      maxLength,
      autoResize = true,
      maxHeight = 200,
      className,
      id,
      value,
      onChange,
      ...rest
    },
    ref,
  ) => {
    const internalRef = useRef<HTMLTextAreaElement | null>(null)
    const textareaId =
      id || (label ? `textarea-${label.toLowerCase().replace(/\s+/g, '-')}` : undefined)

    const setRef = useCallback(
      (el: HTMLTextAreaElement | null) => {
        internalRef.current = el
        if (typeof ref === 'function') ref(el)
        else if (ref) (ref as React.MutableRefObject<HTMLTextAreaElement | null>).current = el
      },
      [ref],
    )

    // Auto-resize
    useEffect(() => {
      const el = internalRef.current
      if (!el || !autoResize) return
      el.style.height = 'auto'
      el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`
    }, [value, autoResize, maxHeight])

    const currentLength = typeof value === 'string' ? value.length : 0

    return (
      <div className="w-full">
        {label && (
          <label
            htmlFor={textareaId}
            className="mb-1.5 block text-caption font-medium text-content-secondary"
          >
            {label}
          </label>
        )}
        <textarea
          ref={setRef}
          id={textareaId}
          value={value}
          onChange={onChange}
          maxLength={maxLength}
          className={clsx(
            'w-full rounded-sm border bg-surface-input px-3 py-2 text-compact text-content-primary',
            'placeholder:text-content-tertiary',
            'outline-none transition-colors duration-fast',
            autoResize ? 'resize-none overflow-hidden' : 'resize-y',
            error
              ? 'border-danger ring-2 ring-danger/40'
              : 'border-border focus:border-border-focus focus:ring-2 focus:ring-accent-500/40',
            'disabled:opacity-50 disabled:cursor-not-allowed',
            className,
          )}
          aria-invalid={error ? true : undefined}
          aria-describedby={
            error ? `${textareaId}-error` : description ? `${textareaId}-desc` : undefined
          }
          {...rest}
        />
        <div className="flex items-center justify-between mt-1">
          <div>
            {error ? (
              <p id={`${textareaId}-error`} className="text-caption text-danger">
                {error}
              </p>
            ) : description ? (
              <p id={`${textareaId}-desc`} className="text-caption text-content-tertiary">
                {description}
              </p>
            ) : null}
          </div>
          {showCount && maxLength != null && (
            <span
              className={clsx(
                'text-micro',
                currentLength >= maxLength ? 'text-danger' : 'text-content-tertiary',
              )}
            >
              {currentLength}/{maxLength}
            </span>
          )}
        </div>
      </div>
    )
  },
)
Textarea.displayName = 'Textarea'
