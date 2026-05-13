import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../../api";
import { Link } from "@tanstack/react-router";
import { Calendar } from "lucide-react";

interface ScheduleSummary {
  id: string;
  enabled: boolean;
}

export function SchedulerSection() {
  const { data: schedules = [] } = useQuery<ScheduleSummary[]>({
    queryKey: ["schedules"],
    queryFn: () => apiFetch("/api/v1/schedules"),
    staleTime: 15_000,
    retry: 1,
  });

  const enabled = schedules.filter((s) => s.enabled).length;
  const total = schedules.length;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-sm font-medium text-stone-300 mb-1">Scheduled Tasks</h2>
        <p className="text-sm text-stone-400">
          Schedules run prompts automatically on a cron expression, interval, or one-shot time.
          Webhook-type schedules can be triggered by external systems.
        </p>
      </div>

      <div className="flex items-center gap-6">
        <div className="rounded-lg border border-stone-700 bg-stone-900/50 px-5 py-4 text-center min-w-[96px]">
          <p className="text-2xl font-bold text-teal-400 font-mono">{enabled}</p>
          <p className="text-xs text-stone-500 mt-0.5">active</p>
        </div>
        <div className="rounded-lg border border-stone-700 bg-stone-900/50 px-5 py-4 text-center min-w-[96px]">
          <p className="text-2xl font-bold text-stone-300 font-mono">{total}</p>
          <p className="text-xs text-stone-500 mt-0.5">total</p>
        </div>
      </div>

      <Link
        to="/schedules"
        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-teal-700 hover:bg-teal-600 text-sm text-white transition-colors"
      >
        <Calendar size={14} />
        Manage Schedules
      </Link>
    </div>
  );
}
