import { useState, useRef, useEffect, useCallback, useMemo, useLayoutEffect, Fragment } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, Check } from 'lucide-react'
import clsx from 'clsx'

type ModelItem = {
  id: string
  provider?: string
}

type ModelGroup = {
  provider: string
  models: ModelItem[]
}

type ModelPickerProps = {
  value: string
  onChange: (value: string) => void
  models: ModelItem[]
  showAuto?: boolean
  className?: string
  buttonClassName?: string
}

const GAP = 4
const MAX_DROPDOWN_HEIGHT = 240 // matches max-h-60
const MAX_DROPDOWN_WIDTH = 448 // matches max-w-[28rem]

export function ModelPicker({
  value,
  onChange,
  models,
  showAuto = false,
  className,
  buttonClassName,
}: ModelPickerProps) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLDivElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number; minWidth: number } | null>(null)

  const groups = useMemo<ModelGroup[]>(() => {
    const map = new Map<string, ModelItem[]>()
    for (const m of models) {
      const key = m.provider ?? ''
      const list = map.get(key)
      if (list) list.push(m)
      else map.set(key, [m])
    }
    return Array.from(map, ([provider, items]) => ({ provider, models: items }))
  }, [models])

  const hasGroups = groups.some(g => g.provider !== '')

  const computePos = useCallback(() => {
    if (!triggerRef.current) return
    const trigger = triggerRef.current.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    // Clamp horizontally assuming dropdown will take the max width that fits
    // the viewport (CSS caps at MAX_DROPDOWN_WIDTH on desktop, viewport-8px on
    // narrower screens).
    const spaceBelow = vh - trigger.bottom - GAP
    const spaceAbove = trigger.top - GAP
    const flipUp = spaceBelow < MAX_DROPDOWN_HEIGHT && spaceAbove > spaceBelow
    const effectiveWidth = Math.min(MAX_DROPDOWN_WIDTH, vw - 2 * GAP)
    const maxLeft = vw - effectiveWidth - GAP
    let left = Math.min(trigger.left, maxLeft)
    left = Math.max(GAP, left)
    // Anchor bottom-up when flipping, top-down otherwise. CSS handles the
    // rest regardless of actual dropdown height.
    if (flipUp) {
      setPos({ bottom: vh - trigger.top + GAP, left, minWidth: trigger.width })
    } else {
      setPos({ top: trigger.bottom + GAP, left, minWidth: trigger.width })
    }
  }, [])

  useLayoutEffect(() => {
    if (!open) return
    // First pass: estimate position so dropdown can render
    computePos()
    // Second pass: once dropdown is in DOM, re-measure with its actual size
    const raf = requestAnimationFrame(() => computePos())
    const onScroll = () => computePos()
    const onResize = () => computePos()
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
    }
  }, [open, computePos])

  const handleClickOutside = useCallback((e: MouseEvent) => {
    const t = e.target as Node
    if (triggerRef.current?.contains(t)) return
    if (dropdownRef.current?.contains(t)) return
    setOpen(false)
  }, [])

  useEffect(() => {
    if (open) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [open, handleClickOutside])

  const selected = value || (showAuto ? 'auto' : '')
  const displayLabel =
    value === 'auto' || (!value && showAuto)
      ? 'Auto'
      : models.find((m) => m.id === value)?.id || value || 'Select model...'

  const handleSelect = (id: string) => {
    onChange(id)
    setOpen(false)
  }

  return (
    <div ref={triggerRef} className={clsx('relative', className)}>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className={clsx(
          buttonClassName ?? 'flex items-center justify-between gap-2 w-full h-9 rounded-sm border border-border bg-surface-input px-3 text-compact text-content-primary',
          'outline-none transition-colors duration-fast',
          'focus:border-border-focus focus:ring-2 focus:ring-accent-500/40',
          'hover:bg-surface-card-hover',
        )}
      >
        <span className="truncate">{displayLabel}</span>
        <ChevronDown
          className={clsx(
            'w-3.5 h-3.5 text-content-tertiary shrink-0 transition-transform duration-fast',
            open && 'rotate-180',
          )}
        />
      </button>

      {open && typeof document !== 'undefined' && createPortal(
        <div
          ref={dropdownRef}
          style={{
            position: 'fixed',
            top: pos?.top,
            bottom: pos?.bottom,
            left: pos?.left ?? -9999,
            minWidth: pos?.minWidth,
            visibility: pos ? 'visible' : 'hidden',
          }}
          className="z-[60] w-max max-w-[calc(100vw-8px)] sm:max-w-[28rem] bg-surface-card border border-border rounded-lg shadow-lg py-1 max-h-60 overflow-y-auto custom-scrollbar animate-fade-in glass-overlay dark:border-white/[0.10]"
        >
          {showAuto && (
            <button
              type="button"
              onClick={() => handleSelect('auto')}
              className={clsx(
                'flex items-center justify-between w-full px-3 py-1.5 text-compact text-left hover:bg-surface-card-hover transition-colors duration-fast',
                (selected === 'auto' || (!value && showAuto)) && 'text-accent',
              )}
            >
              <span>Auto</span>
              {(selected === 'auto' || (!value && showAuto)) && (
                <Check className="w-3.5 h-3.5" />
              )}
            </button>
          )}
          {groups.map((group) => (
            <Fragment key={group.provider}>
              {hasGroups && group.provider && (
                <div className="px-3 pt-2.5 pb-1 text-micro font-semibold uppercase tracking-wide text-content-tertiary select-none">
                  {group.provider}
                </div>
              )}
              {group.models.map((model) => (
                <button
                  key={model.id}
                  type="button"
                  onClick={() => handleSelect(model.id)}
                  className={clsx(
                    'flex items-center justify-between w-full py-1.5 text-compact text-left hover:bg-surface-card-hover transition-colors duration-fast',
                    hasGroups ? 'pl-5 pr-3' : 'px-3',
                    value === model.id && 'text-accent',
                  )}
                >
                  <span className="truncate">{model.id}</span>
                  {value === model.id && <Check className="w-3.5 h-3.5 shrink-0" />}
                </button>
              ))}
            </Fragment>
          ))}
        </div>,
        document.body,
      )}
    </div>
  )
}
