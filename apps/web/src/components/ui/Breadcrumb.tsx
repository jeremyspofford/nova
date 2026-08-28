import { Link } from 'react-router-dom'
import clsx from 'clsx'

type BreadcrumbItem = {
  label: string
  to?: string
}

type BreadcrumbProps = {
  items: BreadcrumbItem[]
  className?: string
}

export function Breadcrumb({ items, className }: BreadcrumbProps) {
  return (
    <nav aria-label="Breadcrumb" className={clsx('flex items-center gap-1.5 text-caption', className)}>
      {items.map((item, i) => {
        const isLast = i === items.length - 1
        return (
          <span key={i} className="inline-flex items-center gap-1.5">
            {i > 0 && <span className="text-content-tertiary">/</span>}
            {isLast || !item.to ? (
              <span
                className={clsx(
                  isLast ? 'text-content-primary' : 'text-content-tertiary',
                )}
              >
                {item.label}
              </span>
            ) : (
              <Link
                to={item.to}
                className="text-content-tertiary hover:text-content-primary transition-colors duration-fast"
              >
                {item.label}
              </Link>
            )}
          </span>
        )
      })}
    </nav>
  )
}
