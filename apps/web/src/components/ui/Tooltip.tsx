import { useState, useRef, useCallback, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'

type TooltipSide = 'top' | 'bottom' | 'left' | 'right'

type TooltipProps = {
  content: string
  side?: TooltipSide
  children: React.ReactNode
}

const GAP = 8

export function Tooltip({ content, side = 'top', children }: TooltipProps) {
  const triggerRef = useRef<HTMLSpanElement>(null)
  const tooltipRef = useRef<HTMLSpanElement>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [visible, setVisible] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  const show = useCallback(() => {
    timerRef.current = setTimeout(() => setVisible(true), 300)
  }, [])

  const hide = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    setVisible(false)
    setPos(null)
  }, [])

  useLayoutEffect(() => {
    if (!visible || !triggerRef.current || !tooltipRef.current) return
    const trigger = triggerRef.current.getBoundingClientRect()
    const tt = tooltipRef.current.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    let top = 0
    let left = 0
    switch (side) {
      case 'top':
        top = trigger.top - tt.height - GAP
        left = trigger.left + trigger.width / 2 - tt.width / 2
        break
      case 'bottom':
        top = trigger.bottom + GAP
        left = trigger.left + trigger.width / 2 - tt.width / 2
        break
      case 'left':
        top = trigger.top + trigger.height / 2 - tt.height / 2
        left = trigger.left - tt.width - GAP
        break
      case 'right':
        top = trigger.top + trigger.height / 2 - tt.height / 2
        left = trigger.right + GAP
        break
    }
    left = Math.max(GAP, Math.min(left, vw - tt.width - GAP))
    top = Math.max(GAP, Math.min(top, vh - tt.height - GAP))
    setPos({ top, left })
  }, [visible, side, content])

  return (
    <>
      <span
        ref={triggerRef}
        className="relative inline-flex"
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
      >
        {children}
      </span>
      {visible && typeof document !== 'undefined' && createPortal(
        <span
          ref={tooltipRef}
          role="tooltip"
          style={{
            position: 'fixed',
            top: pos?.top ?? -9999,
            left: pos?.left ?? -9999,
            visibility: pos ? 'visible' : 'hidden',
          }}
          className={clsx(
            'z-[60] max-w-xs whitespace-normal text-center',
            'bg-neutral-900/90 backdrop-blur-lg dark:border dark:border-white/[0.06] text-neutral-100 text-micro px-2 py-1 rounded-sm shadow-md',
            'pointer-events-none animate-fade-in',
          )}
        >
          {content}
        </span>,
        document.body
      )}
    </>
  )
}
