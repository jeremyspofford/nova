import { useState, useEffect, useRef, useCallback } from 'react'
import { Search, X } from 'lucide-react'
import clsx from 'clsx'

type SearchInputProps = {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  debounceMs?: number
  shortcutHint?: string
  className?: string
}

export function SearchInput({
  value,
  onChange,
  placeholder = 'Search...',
  debounceMs = 300,
  shortcutHint,
  className,
}: SearchInputProps) {
  const [local, setLocal] = useState(value)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isExternalUpdate = useRef(false)

  // Sync from external value changes
  useEffect(() => {
    isExternalUpdate.current = true
    setLocal(value)
  }, [value])

  const debouncedOnChange = useCallback(
    (val: string) => {
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => onChange(val), debounceMs)
    },
    [onChange, debounceMs],
  )

  // Cleanup timer
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value
    isExternalUpdate.current = false
    setLocal(val)
    debouncedOnChange(val)
  }

  const handleClear = () => {
    setLocal('')
    onChange('')
    if (timerRef.current) clearTimeout(timerRef.current)
  }

  return (
    <div className={clsx('relative', className)}>
      <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-content-tertiary pointer-events-none" />
      <input
        type="text"
        value={local}
        onChange={handleChange}
        placeholder={placeholder}
        className={clsx(
          'h-9 w-full rounded-sm border border-border bg-surface-input pl-8 text-compact text-content-primary',
          'placeholder:text-content-tertiary',
          'outline-none transition-colors duration-fast',
          'focus:border-border-focus focus:ring-2 focus:ring-accent-500/40',
          (local || shortcutHint) && 'pr-16',
        )}
      />
      <div className="absolute right-2.5 top-1/2 -translate-y-1/2 flex items-center gap-1.5">
        {local && (
          <button
            type="button"
            onClick={handleClear}
            className="text-content-tertiary hover:text-content-primary transition-colors duration-fast p-0.5"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
        {shortcutHint && !local && (
          <span className="text-micro text-content-tertiary border border-border rounded-xs px-1">
            {shortcutHint}
          </span>
        )}
      </div>
    </div>
  )
}
