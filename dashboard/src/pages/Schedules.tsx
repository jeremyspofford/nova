import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { apiFetch } from "../api";
import { ScheduleForm } from "../components/ScheduleForm";

interface TriggerBase {
  type: string;
  [k: string]: unknown;
}

interface Schedule {
  id: string;
  name: string;
  trigger: TriggerBase;
  enabled: boolean;
  last_fired?: string;
  fire_count: number;
}

function triggerSummary(trigger: TriggerBase): string {
  if (trigger.type === "cron") return `cron: ${trigger.expr as string}`;
  if (trigger.type === "interval") return `every ${trigger.every_seconds as number}s`;
  if (trigger.type === "once") return `once: ${trigger.at as string}`;
  return trigger.type;
}

export function Schedules() {
  const [showForm, setShowForm] = useState(false);
  const queryClient = useQueryClient();

  const { data: schedules = [] } = useQuery<Schedule[]>({
    queryKey: ["schedules"],
    queryFn: () => apiFetch("/api/v1/schedules"),
  });

  async function toggleEnabled(id: string, enabled: boolean) {
    await apiFetch(`/api/v1/schedules/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: !enabled }),
    });
    queryClient.invalidateQueries({ queryKey: ["schedules"] });
  }

  return (
    <div className="flex flex-col h-full">
      <div className="sticky top-0 bg-stone-950 border-b border-stone-800 px-6 py-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Schedules</h1>
        <button
          onClick={() => setShowForm(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-teal-700 hover:bg-teal-600 text-sm"
        >
          <Plus size={14} /> New
        </button>
      </div>

      <div className="flex-1 overflow-auto px-6 py-4 space-y-2">
        {schedules.map((s) => (
          <div
            key={s.id}
            className="flex items-center gap-3 bg-stone-800/50 rounded-xl px-4 py-3"
          >
            <button onClick={() => toggleEnabled(s.id, s.enabled)}>
              {s.enabled ? (
                <span className="w-3 h-3 rounded-full bg-teal-500 inline-block" />
              ) : (
                <span className="w-3 h-3 rounded-full border-2 border-stone-600 inline-block" />
              )}
            </button>
            <div className="flex-1 min-w-0">
              <span className="text-sm font-medium text-stone-200">{s.name}</span>
              <span className="ml-2 text-xs text-stone-500">{triggerSummary(s.trigger)}</span>
            </div>
            {s.last_fired && (
              <span className="text-xs text-stone-600">
                Fired {new Date(s.last_fired).toLocaleDateString()}
              </span>
            )}
          </div>
        ))}
      </div>

      {showForm && (
        <ScheduleForm
          onClose={() => setShowForm(false)}
          onCreated={() => {
            queryClient.invalidateQueries({ queryKey: ["schedules"] });
            setShowForm(false);
          }}
        />
      )}
    </div>
  );
}
