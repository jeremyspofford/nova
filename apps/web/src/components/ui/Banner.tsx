import type { HTMLAttributes } from 'react'
import clsx from 'clsx'

type Tone = 'danger' | 'warning' | 'info' | 'success'

const TONES: Record<Tone, string> = {
  danger: 'border-danger/30 bg-danger-dim text-danger',
  warning: 'border-warning/30 bg-warning-dim text-content-primary',
  info: 'border-info/30 bg-info-dim text-content-secondary',
  success: 'border-success/30 bg-success-dim text-content-primary',
}

/**
 * The one tinted, bordered message box (UI review R10 leftover, 2026-10-11)
 * — it had been pasted 33 times in five slightly different versions. An
 * error is an `alert` (read out at once); a warning or a note is a
 * `status`. `size="sm"` is the inline version inside a card. The page keeps
 * its own layout classes (margins, flex) through `className`. `success` is
 * the tip in her `callout` block (S54a), which passes `role="note"`: an
 * aside in a reply is neither an alert nor a live status.
 */
export function Banner({
  tone = 'danger',
  size = 'md',
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { tone?: Tone; size?: 'sm' | 'md' }) {
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      {...rest}
      className={clsx(
        'rounded-sm border',
        TONES[tone],
        size === 'sm' ? 'px-3 py-2 text-caption' : 'px-4 py-3 text-compact',
        className,
      )}
    >
      {children}
    </div>
  )
}
