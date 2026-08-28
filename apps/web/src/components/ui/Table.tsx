import { useState, useCallback, type ReactNode } from 'react'
import clsx from 'clsx'
import { ChevronUp, ChevronDown } from 'lucide-react'

export interface TableColumn<T> {
  key: string
  header: string
  sortable?: boolean
  width?: string
  render?: (row: T) => ReactNode
}

export function Table<T extends Record<string, unknown>>({
  columns,
  data,
  onSort,
  onRowClick,
  emptyMessage = 'No data available',
  className,
}: {
  columns: TableColumn<T>[]
  data: T[]
  onSort?: (key: string, direction: 'asc' | 'desc') => void
  onRowClick?: (row: T) => void
  emptyMessage?: string
  className?: string
}) {
  const [sortKey, setSortKey] = useState<string | null>(null)
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc')

  const handleSort = useCallback(
    (key: string) => {
      const newDir = sortKey === key && sortDirection === 'asc' ? 'desc' : 'asc'
      setSortKey(key)
      setSortDirection(newDir)
      onSort?.(key, newDir)
    },
    [sortKey, sortDirection, onSort],
  )

  return (
    <div className={clsx('overflow-x-auto rounded-lg border border-border glass-card dark:border-white/[0.08]', className)}>
      <table className="w-full text-compact">
        <thead>
          <tr className="bg-surface-elevated">
            {columns.map((col) => (
              <th
                key={col.key}
                className={clsx(
                  'px-4 py-3 text-left text-caption font-medium text-content-tertiary uppercase tracking-wider',
                  'sticky top-0 bg-surface-elevated',
                  col.sortable && 'cursor-pointer select-none hover:text-content-secondary',
                )}
                style={col.width ? { width: col.width } : undefined}
                onClick={col.sortable ? () => handleSort(col.key) : undefined}
              >
                <span className="inline-flex items-center gap-1">
                  {col.header}
                  {col.sortable && sortKey === col.key && (
                    sortDirection === 'asc' ? (
                      <ChevronUp size={14} />
                    ) : (
                      <ChevronDown size={14} />
                    )
                  )}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border-subtle">
          {data.length === 0 ? (
            <tr>
              <td
                colSpan={columns.length}
                className="px-4 py-12 text-center text-content-tertiary text-compact"
              >
                {emptyMessage}
              </td>
            </tr>
          ) : (
            data.map((row, rowIdx) => (
              <tr
                key={rowIdx}
                className={clsx(
                  'transition-colors',
                  onRowClick && 'cursor-pointer',
                  'hover:bg-surface-card-hover',
                )}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
              >
                {columns.map((col) => (
                  <td key={col.key} className="px-4 py-3 text-content-primary">
                    {col.render
                      ? col.render(row)
                      : (row[col.key] as ReactNode)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}
