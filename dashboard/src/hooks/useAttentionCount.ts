import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../api";

export function useAttentionCount() {
  return useQuery({
    queryKey: ["attention-count"],
    queryFn: async () => {
      const tasks = await apiFetch<any[]>(
        "/api/v1/pipeline/tasks?status=clarification_needed,pending_human_review,waiting_human&limit=100"
      );
      return Array.isArray(tasks) ? tasks.length : 0;
    },
    refetchInterval: 5000,
  });
}
