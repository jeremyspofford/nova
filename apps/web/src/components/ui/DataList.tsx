import { useState, useCallback, type ReactNode } from 'react'
import clsx from 'clsx'
import { Check, Copy } from 'lucide-react'

interface DataListItem {
  label: string
  value: ReactNode
  copyable?: boolean
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }, [text])

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="ml-1.5 text-content-tertiary hover:text-content-secondary transition-colors cursor-pointer"
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
  )
}

export function DataList({
  items,
  className,
}: {
  items: DataListItem[]
  className?: string
}) {
  return (
    <dl className={clsx('divide-y divide-border-subtle', className)}>
      {items.map((item, i) => (
        <div key={i} className="flex items-center justify-between py-2.5 gap-4">
          <dt className="text-caption text-content-tertiary shrink-0">{item.label}</dt>
          <dd className="text-compact text-content-primary text-right flex items-center">
            {item.value}
            {item.copyable && typeof item.value === 'string' && (
              <CopyButton text={item.value} />
            )}
          </dd>
        </div>
      ))}
    </dl>
  )
}
