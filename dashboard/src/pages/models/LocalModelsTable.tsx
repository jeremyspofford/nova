/**
 * LocalModelsTable — the shared "on disk / in memory" view every local
 * inference backend renders. Ollama and LM Studio normalise their model
 * lists into LocalModelRow[] and hand them here, so both read identically:
 * each row shows size, a loaded/on-disk state, and Load/Unload (+ Delete
 * where the backend supports removing from disk). The differences between
 * backends live only in how you ACQUIRE models, not how they're shown.
 */
import { Loader2, Trash2 } from 'lucide-react'
import { Badge, Button } from '../../components/ui'
import { formatBytes } from '../../lib/format'

export interface LocalModelRow {
  id: string              // stable key used for load/unload/delete
  name: string
  sizeBytes: number
  params?: string | null  // "7B"
  quant?: string | null   // "Q4_K_M"
  context?: string | null // "128K"
  caps?: string[]         // ['vision','tools']
  loaded: boolean
  required?: boolean      // Nova depends on it — no delete
}

interface Props {
  rows: LocalModelRow[]
  onLoad?: (id: string) => void
  onUnload?: (id: string) => void
  onDelete?: (id: string) => void
  busyIds: Set<string>
  emptyText: string
}

export function localCounts(rows: LocalModelRow[]) {
  return { onDisk: rows.length, inMemory: rows.filter(r => r.loaded).length }
}

export function LocalModelsTable({ rows, onLoad, onUnload, onDelete, busyIds, emptyText }: Props) {
  if (rows.length === 0) {
    return (
      <div className="px-4 py-6 text-compact text-content-tertiary text-center">{emptyText}</div>
    )
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-compact">
        <thead>
          <tr className="text-caption text-content-tertiary border-b border-border-subtle">
            <th className="text-left px-4 py-2 font-medium">Model</th>
            <th className="hidden md:table-cell text-left px-4 py-2 font-medium">Size</th>
            <th className="text-left px-4 py-2 font-medium">State</th>
            <th className="text-right px-4 py-2 font-medium">Memory</th>
            {onDelete && <th className="w-10" />}
          </tr>
        </thead>
        <tbody>
          {rows.map(m => {
            const busy = busyIds.has(m.id)
            return (
              <tr key={m.id} className="border-b border-border-subtle last:border-0 hover:bg-surface-card-hover transition-colors">
                <td className="px-4 py-2.5">
                  <div className="font-mono text-content-primary">{m.name}</div>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5 text-micro text-content-tertiary font-mono">
                    {m.params && <span>{m.params}</span>}
                    {m.quant && <span>{m.quant}</span>}
                    {m.context && <span>{m.context} ctx</span>}
                    {m.caps?.map(c => <span key={c} className="text-accent-muted">{c}</span>)}
                    {m.required && <Badge color="warning" size="sm">required</Badge>}
                  </div>
                </td>
                <td className="hidden md:table-cell px-4 py-2.5 text-content-secondary font-mono tabular-nums">
                  {m.sizeBytes ? formatBytes(m.sizeBytes) : '--'}
                </td>
                <td className="px-4 py-2.5">
                  {m.loaded
                    ? <Badge color="success" size="sm" dot>in memory</Badge>
                    : <span className="text-caption text-content-tertiary">on disk</span>}
                </td>
                <td className="px-4 py-2.5 text-right">
                  {m.loaded
                    ? (onUnload && (
                        <Button variant="ghost" size="sm" disabled={busy}
                          icon={busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : undefined}
                          onClick={() => onUnload(m.id)}>
                          Unload
                        </Button>
                      ))
                    : (onLoad && (
                        <Button variant="ghost" size="sm" disabled={busy} className="text-accent"
                          icon={busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : undefined}
                          onClick={() => onLoad(m.id)}>
                          Load
                        </Button>
                      ))}
                </td>
                {onDelete && (
                  <td className="px-2 py-2.5">
                    <Button
                      variant="ghost" size="sm"
                      icon={<Trash2 className="h-4 w-4" />}
                      onClick={() => onDelete(m.id)}
                      disabled={busy || m.required}
                      title={m.required ? 'Required by Nova' : 'Delete from disk'}
                    />
                  </td>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
