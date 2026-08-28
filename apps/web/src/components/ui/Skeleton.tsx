import clsx from 'clsx'

type SkeletonVariant = 'text' | 'rect' | 'circle'

type SkeletonProps = {
  variant?: SkeletonVariant
  width?: string
  height?: string
  lines?: number
  className?: string
}

export function Skeleton({
  variant = 'text',
  width,
  height,
  lines = 1,
  className,
}: SkeletonProps) {
  if (variant === 'circle') {
    return (
      <div
        className={clsx('skeleton rounded-full', className)}
        style={{ width: width || '40px', height: height || width || '40px' }}
      />
    )
  }

  if (variant === 'rect') {
    return (
      <div
        className={clsx('skeleton rounded-lg', className)}
        style={{ width: width || '100%', height: height || '96px' }}
      />
    )
  }

  // text variant
  if (lines === 1) {
    return (
      <div
        className={clsx('skeleton h-4 rounded-xs', className)}
        style={{ width: width || '100%' }}
      />
    )
  }

  return (
    <div className={clsx('flex flex-col gap-2', className)}>
      {Array.from({ length: lines }).map((_, i) => (
        <div
          key={i}
          className="skeleton h-4 rounded-xs"
          style={{ width: i === lines - 1 ? '60%' : width || '100%' }}
        />
      ))}
    </div>
  )
}
