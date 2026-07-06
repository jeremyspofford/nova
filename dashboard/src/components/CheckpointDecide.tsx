import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Loader2, X } from 'lucide-react'
import { decideApproval, getApproval } from '../api'
import { Button } from './ui'

/**
 * The operator's side of a human checkpoint: what Nova asked for, an optional
 * screenshot of the page it's stuck on, a reply box, and Continue/Decline.
 *
 * Fetches the approval detail itself (the list endpoint strips screenshots),
 * so it drops into both the Pending Approvals card and the task detail sheet
 * with just an id.
 */
export function CheckpointDecide({
  approvalId,
  onDecided,
}: {
  approvalId: string
  onDecided?: (decision: 'approve' | 'reject') => void
}) {
  const qc = useQueryClient()
  const [replyText, setReplyText] = useState('')

  const { data: approval, isLoading } = useQuery({
    queryKey: ['approval', approvalId],
    queryFn: () => getApproval(approvalId),
  })

  const decide = useMutation({
    mutationFn: (decision: 'approve' | 'reject') =>
      decideApproval(approvalId, {
        decision,
        ...(replyText.trim() ? { response_text: replyText.trim() } : {}),
      }),
    onSuccess: (_data, decision) => {
      qc.invalidateQueries({ queryKey: ['approvals'] })
      qc.invalidateQueries({ queryKey: ['approvals-count'] })
      qc.invalidateQueries({ queryKey: ['pipeline-tasks'] })
      onDecided?.(decision)
    },
  })

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-3 text-caption text-content-tertiary">
        <Loader2 size={14} className="animate-spin" /> Loading checkpoint…
      </div>
    )
  }
  if (!approval) {
    return (
      <p className="py-3 text-caption text-content-tertiary">
        Checkpoint not found — it may have been decided or expired.
      </p>
    )
  }

  const instructions = String(approval.args_redacted?.instructions ?? '')
  const context = String(approval.args_redacted?.context ?? '')

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-border-subtle bg-surface-elevated p-3">
        <p className="text-compact text-content-primary whitespace-pre-wrap">{instructions}</p>
        {context && (
          <p className="text-caption text-content-tertiary mt-2 whitespace-pre-wrap">{context}</p>
        )}
      </div>

      {approval.screenshot_b64 && (
        <div className="rounded-md border border-border-subtle overflow-hidden">
          <p className="px-3 py-1.5 text-micro text-content-tertiary uppercase tracking-wider bg-surface-elevated">
            What Nova sees
          </p>
          <img
            src={`data:image/png;base64,${approval.screenshot_b64}`}
            alt="Page Nova is parked on"
            className="w-full max-h-96 object-contain bg-surface-elevated"
          />
        </div>
      )}

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

      <div className="flex items-center gap-2 flex-wrap">
        <Button
          onClick={() => decide.mutate('approve')}
          disabled={decide.isPending}
          loading={decide.isPending && decide.variables === 'approve'}
          icon={<Check size={14} />}
        >
          Send and continue
        </Button>
        <Button
          variant="danger"
          onClick={() => decide.mutate('reject')}
          disabled={decide.isPending}
          loading={decide.isPending && decide.variables === 'reject'}
          icon={<X size={14} />}
        >
          Decline
        </Button>
      </div>

      {decide.isError && (
        <p className="text-caption text-danger">{(decide.error as Error).message}</p>
      )}
    </div>
  )
}
