import { useQuery } from '@tanstack/react-query'
import { listApprovals } from '../api'

/** Polls the pending approvals queue and returns the count for sidebar badging.
 * Kept tiny — refresh cadence matches PendingApprovals page so cache hits cross-component. */
export function useApprovalsCount() {
  return useQuery({
    queryKey: ['approvals-count'],
    queryFn: async () => {
      const list = await listApprovals()
      return Array.isArray(list) ? list.length : 0
    },
    refetchInterval: 10_000,
    staleTime: 5_000,
  })
}
