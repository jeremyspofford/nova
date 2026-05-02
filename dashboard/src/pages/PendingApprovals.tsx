import { useQuery } from '@tanstack/react-query'
import { ShieldCheck, Inbox } from 'lucide-react'
import { listApprovals } from '../api'
import { ApprovalCard } from '../components/ApprovalCard'
import { PageHeader } from '../components/layout/PageHeader'
import { EmptyState, Skeleton } from '../components/ui'

export function PendingApprovals() {
  const { data: approvals = [], isLoading, error } = useQuery({
    queryKey: ['approvals'],
    queryFn: listApprovals,
    staleTime: 5_000,
    refetchInterval: 10_000,
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

      {approvals.length === 0 && !isLoading && (
        <p className="mt-6 text-caption text-content-tertiary flex items-center gap-2">
          <Inbox size={12} /> Auto-refreshing every 10 seconds.
        </p>
      )}
    </div>
  )
}
