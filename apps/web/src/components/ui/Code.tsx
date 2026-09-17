import { useState, useCallback } from 'react'
import clsx from 'clsx'
import { Check, Copy } from 'lucide-react'

export function Code({
  inline = true,
  copyable,
  className,
  children,
}: {
  inline?: boolean
  copyable?: boolean
  className?: string
  children: React.ReactNode
}) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(() => {
    const text = typeof children === 'string' ? children : ''
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }, [children])

  if (inline) {
    return (
      <code
        className={clsx(
          'font-mono text-mono-sm bg-surface-elevated px-1 py-0.5 rounded-xs',
          className,
        )}
      >
        {children}
      </code>
    )
  }

  return (
    <div className={clsx('relative', className)}>
      <pre
        className="bg-neutral-900 dark:bg-neutral-950 text-neutral-200 p-4 rounded-lg font-mono text-mono-sm overflow-x-auto"
      >
        <code>{children}</code>
      </pre>
      {copyable && (
        <button
          type="button"
          onClick={handleCopy}
          className="absolute top-2 right-2 p-1.5 rounded-md bg-neutral-800 hover:bg-neutral-700 text-neutral-400 hover:text-neutral-200 transition-colors"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      )}
    </div>
  )
}
