import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, History, Inbox, ShieldCheck } from 'lucide-react'
import { listApprovals, listRecentApprovals, type ApprovalStatus } from '../api'
import { ApprovalCard } from '../components/ApprovalCard'
import { PageHeader } from '../components/layout/PageHeader'
import { Badge, EmptyState, Skeleton } from '../components/ui'

const STATUS_LABEL: Record<ApprovalStatus, string> = {
  pending: 'pending',
  approved: 'approved',
  rejected: 'rejected',
  timeout: 'expired unanswered',
  superseded: 'superseded',
}

const STATUS_COLOR: Record<ApprovalStatus, 'success' | 'warning' | 'danger' | 'info' | 'neutral'> = {
  pending: 'warning',
  approved: 'success',
  rejected: 'neutral',
  timeout: 'danger',
  superseded: 'neutral',
}

function fmt(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

export function PendingApprovals() {
  const [showRecent, setShowRecent] = useState(false)

  const { data: approvals = [], isLoading, error } = useQuery({
    queryKey: ['approvals'],
    queryFn: listApprovals,
    staleTime: 5_000,
    refetchInterval: 10_000,
  })

  const { data: recent = [] } = useQuery({
    queryKey: ['approvals-recent'],
    queryFn: () => listRecentApprovals(20),
    staleTime: 30_000,
  })

  return (
    <div className="px-4 py-6 sm:px-6">
      <PageHeader
        title={`Pending Approvals${approvals.length > 0 ? ` · ${approvals.length}` : ''}`}
        description="Capability calls (MUTATE / DESTRUCT) waiting for human review. Approve, reject, or save a rule to auto-approve future calls in scope."
      />

      {error && (
        <p className="mt-4 text-compact text-danger">{(error as Error).message}</p>
      )}

      {isLoading ? (
        <Skeleton lines={6} />
      ) : approvals.length === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          title="No pending approvals"
          description="Nova will notify here when an agent or drive needs human consent for a MUTATE or DESTRUCT capability call."
        />
      ) : (
        <div className="space-y-4">
          {approvals.map(a => (
            <ApprovalCard key={a.id} approval={a} />
          ))}
        </div>
      )}

      {recent.length > 0 && (
        <div className="mt-8">
          <button
            onClick={() => setShowRecent(v => !v)}
            className="flex items-center gap-2 text-compact font-semibold text-content-secondary transition-colors hover:text-content-primary"
          >
            {showRecent
              ? <ChevronDown className="h-4 w-4" />
              : <ChevronRight className="h-4 w-4" />}
            <History className="h-4 w-4" />
            Recently decided · {recent.length}
          </button>
          {showRecent && (
            <div className="mt-3 divide-y divide-border-subtle rounded-lg border border-border-subtle">
              {recent.map(r => (
                <div key={r.id} className="flex items-center gap-3 px-4 py-2.5">
                  <span className="min-w-0 flex-1 truncate font-mono text-mono text-content-primary">
                    {r.tool_name}
                  </span>
                  <span className="hidden shrink-0 text-caption text-content-tertiary sm:block">
                    {r.kind === 'checkpoint' ? 'checkpoint' : r.blast_radius}
                  </span>
                  <Badge color={STATUS_COLOR[r.status] ?? 'neutral'}>
                    {STATUS_LABEL[r.status] ?? r.status}
                  </Badge>
                  <span className="shrink-0 text-caption tabular-nums text-content-tertiary">
                    {fmt(r.decided_at ?? r.created_at)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {approvals.length === 0 && !isLoading && (
        <p className="mt-6 text-caption text-content-tertiary flex items-center gap-2">
          <Inbox size={12} /> Auto-refreshing every 10 seconds.
        </p>
      )}
    </div>
  )
}
