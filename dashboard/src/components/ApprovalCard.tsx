import { useState, useMemo } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ShieldAlert, Check, X, Bookmark, Loader2,
  AlertTriangle, ChevronDown, ChevronRight, HandHelping,
} from 'lucide-react'
import { decideApproval, type Approval } from '../api'
import { Button, Badge, Toast } from './ui'

const BLAST_BADGE: Record<Approval['blast_radius'], { label: string; color: 'info' | 'warning' | 'danger' }> = {
  read: { label: 'READ', color: 'info' },
  propose: { label: 'PROPOSE', color: 'info' },
  mutate: { label: 'MUTATE', color: 'warning' },
  destruct: { label: 'DESTRUCT', color: 'danger' },
}

function relativeTime(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now()
  const abs = Math.abs(ms)
  const sign = ms < 0 ? 'ago' : 'from now'
  if (abs < 60_000) return `<1 min ${sign}`
  const m = Math.floor(abs / 60_000)
  if (m < 60) return `${m} min ${sign}`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${sign}`
  const d = Math.floor(h / 24)
  return `${d}d ${sign}`
}

export function ApprovalCard({ approval }: { approval: Approval }) {
  const qc = useQueryClient()
  const [showArgs, setShowArgs] = useState(false)
  const [rememberOpen, setRememberOpen] = useState(false)
  const [rememberGlob, setRememberGlob] = useState('*')
  const [replyText, setReplyText] = useState('')
  const [toast, setToast] = useState<{ variant: 'success' | 'error'; message: string } | null>(null)

  // Checkpoint rows: a parked task asking the operator for input, not a
  // pended tool call. Reason/instructions live in args_redacted; the reply
  // is injected back into the task as the tool's result.
  const isCheckpoint = approval.kind === 'checkpoint'
  const checkpointReason = isCheckpoint ? String(approval.args_redacted?.reason ?? '') : ''
  const checkpointInstructions = isCheckpoint ? String(approval.args_redacted?.instructions ?? '') : ''
  const checkpointContext = isCheckpoint ? String(approval.args_redacted?.context ?? '') : ''

  const blast = BLAST_BADGE[approval.blast_radius]
  const argsPretty = useMemo(() => {
    try {
      return JSON.stringify(approval.args_redacted, null, 2)
    } catch {
      return String(approval.args_redacted)
    }
  }, [approval.args_redacted])

  const decide = useMutation({
    mutationFn: (payload: Parameters<typeof decideApproval>[1]) =>
      decideApproval(approval.id, payload),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['approvals'] })
      qc.invalidateQueries({ queryKey: ['approvals-count'] })
      setRememberOpen(false)
      setToast({
        variant: 'success',
        message: isCheckpoint
          ? (vars.decision === 'approve' ? 'Response sent — task resuming.' : 'Checkpoint declined — task resuming to wrap up.')
          : vars.decision === 'approve'
            ? `Approved ${approval.tool_name}${vars.remember ? ' (rule saved)' : ''}.`
            : `Rejected ${approval.tool_name}.`,
      })
    },
    onError: (e: Error) => setToast({ variant: 'error', message: e.message }),
  })

  return (
    <div className="rounded-lg border border-border-subtle bg-surface-card p-4">
      {/* Header */}
      <div className="flex items-start gap-3 flex-wrap">
        {isCheckpoint
          ? <HandHelping size={18} className="text-teal-500" />
          : <ShieldAlert size={18} className={blast.color === 'danger' ? 'text-danger' : 'text-amber-500'} />}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-compact font-semibold text-content-primary font-mono">
              {isCheckpoint ? (checkpointReason || 'Nova needs your input') : approval.tool_name}
            </p>
            {isCheckpoint
              ? <Badge color="info" size="sm">CHECKPOINT</Badge>
              : <Badge color={blast.color} size="sm">{blast.label}</Badge>}
            <span className="text-micro text-content-tertiary uppercase tracking-wider">
              {isCheckpoint ? 'task parked' : approval.tool_kind.replace('_', ' ')}
            </span>
          </div>
          <div className="flex items-center gap-3 mt-1 flex-wrap text-micro text-content-tertiary">
            <span>Requested by <span className="font-mono text-content-secondary">{approval.requested_by}</span></span>
            <span>·</span>
            <span>Created {relativeTime(approval.created_at)}</span>
            <span>·</span>
            <span className={Date.parse(approval.expires_at) - Date.now() < 60 * 60_000 ? 'text-danger' : ''}>
              Expires {relativeTime(approval.expires_at)}
            </span>
            {approval.task_id && (
              <>
                <span>·</span>
                <span>Task <span className="font-mono">{approval.task_id.slice(0, 8)}</span></span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Checkpoint: what the operator should do + optional reply */}
      {isCheckpoint && (
        <div className="mt-3 space-y-3">
          <div className="rounded-md border border-border-subtle bg-surface-elevated p-3">
            <p className="text-compact text-content-primary whitespace-pre-wrap">{checkpointInstructions}</p>
            {checkpointContext && (
              <p className="text-caption text-content-tertiary mt-2 whitespace-pre-wrap">{checkpointContext}</p>
            )}
          </div>
          <div>
            <label className="text-caption text-content-secondary block mb-1">
              Reply to Nova <span className="text-content-tertiary">(optional — verification code, instructions, …)</span>
            </label>
            <textarea
              value={replyText}
              onChange={e => setReplyText(e.target.value)}
              rows={2}
              placeholder="e.g. the code is 493201"
              className="w-full rounded-md border border-border-subtle bg-surface-input px-3 py-2 text-compact text-content-primary"
            />
          </div>
        </div>
      )}

      {/* Diff preview */}
      {approval.diff_preview && (
        <div className="mt-3 rounded-md border border-border-subtle bg-surface-elevated p-3 max-h-72 overflow-auto">
          <pre className="text-micro font-mono text-content-secondary whitespace-pre-wrap">
            {approval.diff_preview}
          </pre>
        </div>
      )}

      {/* Args (collapsed) */}
      <div className="mt-3">
        <button
          onClick={() => setShowArgs(s => !s)}
          className="flex items-center gap-1.5 text-caption text-content-secondary hover:text-content-primary"
        >
          {showArgs ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          Arguments {!showArgs && <span className="text-content-tertiary">({Object.keys(approval.args_redacted ?? {}).length} keys)</span>}
        </button>
        {showArgs && (
          <pre className="mt-2 rounded-md bg-surface-elevated p-3 text-micro font-mono text-content-secondary overflow-auto max-h-72 whitespace-pre-wrap">
            {argsPretty}
          </pre>
        )}
      </div>

      {/* Approve & Remember scope panel */}
      {rememberOpen && (
        <div className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 space-y-2">
          <div className="flex items-start gap-2">
            <AlertTriangle size={14} className="text-amber-500 mt-0.5 shrink-0" />
            <div className="flex-1">
              <p className="text-compact text-content-primary">Save an auto-approve rule</p>
              <p className="text-caption text-content-tertiary mt-1">
                Future calls to <code className="bg-surface-elevated px-1 rounded">{approval.tool_name}</code> matching this scope will be approved automatically.
              </p>
            </div>
          </div>
          <div>
            <label className="text-caption text-content-secondary block mb-1">Target glob</label>
            <input
              type="text"
              value={rememberGlob}
              onChange={e => setRememberGlob(e.target.value)}
              placeholder="repos/owner/repo/*"
              className="w-full rounded-md border border-border-subtle bg-surface-input px-3 py-2 text-compact font-mono text-content-primary"
            />
            <p className="text-micro text-content-tertiary mt-1">
              Use <code>*</code> for any target. Wildcard glob — e.g. <code>repos/jeremyspofford/*</code>.
            </p>
          </div>
          <div className="flex items-center gap-2 pt-1">
            <Button
              size="sm"
              onClick={() => decide.mutate({
                decision: 'approve',
                remember: true,
                rule_scope: { target_glob: rememberGlob.trim() || '*' },
              })}
              disabled={decide.isPending}
              loading={decide.isPending}
              icon={<Check size={12} />}
            >
              Approve and save rule
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setRememberOpen(false)}
              disabled={decide.isPending}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* Action row */}
      <div className="mt-4 flex items-center gap-2 flex-wrap">
        <Button
          onClick={() => decide.mutate({
            decision: 'approve',
            ...(isCheckpoint && replyText.trim() ? { response_text: replyText.trim() } : {}),
          })}
          disabled={decide.isPending || rememberOpen}
          loading={decide.isPending && (decide.variables as any)?.decision === 'approve' && !(decide.variables as any)?.remember}
          icon={<Check size={14} />}
        >
          {isCheckpoint ? 'Send and continue' : 'Approve'}
        </Button>
        <Button
          variant="danger"
          onClick={() => decide.mutate({
            decision: 'reject',
            ...(isCheckpoint && replyText.trim() ? { response_text: replyText.trim() } : {}),
          })}
          disabled={decide.isPending || rememberOpen}
          loading={decide.isPending && (decide.variables as any)?.decision === 'reject'}
          icon={<X size={14} />}
        >
          {isCheckpoint ? 'Decline' : 'Reject'}
        </Button>
        {!isCheckpoint && (
          <Button
            variant="outline"
            onClick={() => setRememberOpen(true)}
            disabled={decide.isPending || rememberOpen}
            icon={<Bookmark size={14} />}
          >
            Approve and remember
          </Button>
        )}
      </div>

      {decide.isError && (
        <p className="mt-2 text-caption text-danger">{(decide.error as Error).message}</p>
      )}

      {toast && (
        <Toast variant={toast.variant} message={toast.message} onDismiss={() => setToast(null)} />
      )}
    </div>
  )
}
