import clsx from 'clsx'

const sizeMap = {
  xs: 'h-6 w-6 text-micro',
  sm: 'h-8 w-8 text-caption',
  md: 'h-10 w-10 text-compact',
  lg: 'h-12 w-12 text-body',
} as const

const statusColors = {
  online: 'bg-emerald-400',
  offline: 'bg-neutral-400',
  busy: 'bg-amber-400',
} as const

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return name.slice(0, 2).toUpperCase()
}

export function Avatar({
  src,
  name,
  size = 'md',
  status,
  className,
}: {
  src?: string
  name: string
  size?: 'xs' | 'sm' | 'md' | 'lg'
  status?: 'online' | 'offline' | 'busy'
  className?: string
}) {
  const roundedCls = size === 'xs' ? 'rounded-md' : 'rounded-lg'

  return (
    <div className={clsx('relative inline-flex shrink-0', className)}>
      {src ? (
        <img
          src={src}
          alt={name}
          className={clsx(
            'object-cover',
            sizeMap[size],
            roundedCls,
          )}
        />
      ) : (
        <div
          className={clsx(
            'inline-flex items-center justify-center bg-gradient-to-br from-indigo-500 to-purple-600 text-white font-medium',
            sizeMap[size],
            roundedCls,
          )}
        >
          {getInitials(name)}
        </div>
      )}
      {status && (
        <span
          className={clsx(
            'absolute bottom-0 right-0 block rounded-full ring-2 ring-surface-card',
            statusColors[status],
            size === 'xs' || size === 'sm' ? 'h-2 w-2' : 'h-2.5 w-2.5',
          )}
        />
      )}
    </div>
  )
}
