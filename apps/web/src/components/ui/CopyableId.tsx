import { useState, useCallback } from 'react'
import clsx from 'clsx'
import { Check, Copy } from 'lucide-react'

export function CopyableId({
  id,
  truncate = 8,
  className,
}: {
  id: string
  truncate?: number
  className?: string
}) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(id).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }, [id])

  const display = id.length > truncate ? id.slice(0, truncate) + '\u2026' : id

  return (
    <button
      type="button"
      onClick={handleCopy}
      title={id}
      className={clsx(
        'inline-flex items-center gap-1 font-mono text-mono-sm bg-surface-elevated px-1.5 py-0.5 rounded-xs',
        'text-content-secondary hover:text-content-primary transition-colors cursor-pointer',
        className,
      )}
    >
      <span>{display}</span>
      {copied ? (
        <Check size={12} className="text-success shrink-0" />
      ) : (
        <Copy size={12} className="opacity-50 shrink-0" />
      )}
    </button>
  )
}
