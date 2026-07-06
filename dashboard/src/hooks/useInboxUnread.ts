import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '../api'

/** Polls the inbox unread count for sidebar/mobile badging.
 * Same cadence as useApprovalsCount so cache hits cross-component. */
export function useInboxUnread() {
  return useQuery({
    queryKey: ['inbox-unread'],
    queryFn: async () => {
      const res = await apiFetch<{ unread: number }>('/api/v1/notify/inbox?limit=1')
      return res.unread ?? 0
    },
    refetchInterval: 10_000,
    staleTime: 5_000,
  })
}
