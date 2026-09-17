import { AlertTriangle, Check, Loader2, X } from 'lucide-react'
import { Button, ProgressBar } from '../../components/ui'
import type { PullState } from '../../lib/pullStream'
import { formatBytes } from '../../lib/pullStream'

/**
 * The one in-flight pull, shown above the table. One at a time is a
 * mechanical rule (ollama pulls one model at a time; a second start would
 * abort the first), so this is a single panel, not a per-row widget. Its
 * text is the reducer's state — never a claim the stream did not make.
 */
export function PullControl({ pull, onCancel, onDismiss }: { pull: PullState; onCancel: () => void; onDismiss: () => void }) {
  const active = !pull.done && !pull.error
  const pct = pull.total > 0 ? Math.min(100, Math.round((pull.completed / pull.total) * 100)) : undefined
  return (
    <div
      data-testid="pull-panel"
      className={`rounded-md border px-4 py-3 text-compact ${
        pull.error ? 'border-danger/30 bg-danger-dim' : 'border-line'
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        {active ? (
          <Loader2 size={14} className="animate-spin shrink-0" />
        ) : pull.error ? (
          <AlertTriangle size={14} className="shrink-0 text-danger" />
        ) : (
          <Check size={14} className="shrink-0 text-success" />
        )}
        <span className="font-mono">{pull.target}</span>
        <span className="text-content-tertiary">
          {pull.error ? pull.error : pull.done ? 'installed' : pull.status}
        </span>
        {pull.total > 0 && !pull.error && (
          <span className="text-caption text-content-tertiary">
            {formatBytes(pull.completed)} of {formatBytes(pull.total)}
          </span>
        )}
        <span className="ml-auto flex items-center gap-1">
          {active ? (
            <Button size="sm" variant="ghost" icon={<X size={12} />} onClick={onCancel}>
              Cancel
            </Button>
          ) : (
            <Button size="sm" variant="ghost" onClick={onDismiss}>
              Dismiss
            </Button>
          )}
        </span>
      </div>
      {pull.preflight && <p className="mt-1 text-caption text-content-tertiary">{pull.preflight}</p>}
      {active && <ProgressBar value={pct} variant={pct === undefined ? 'indeterminate' : 'determinate'} className="mt-2" />}
    </div>
  )
}
