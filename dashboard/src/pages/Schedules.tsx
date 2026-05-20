import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, Pencil } from "lucide-react";
import { apiFetch } from "../api";
import { ScheduleForm } from "../components/ScheduleForm";

interface TriggerBase {
  type: string;
  expr?: string;
  every_seconds?: number;
  at?: string;
  [k: string]: unknown;
}

interface Schedule {
  id: string;
  name: string;
  prompt: string;
  trigger: TriggerBase;
  enabled: boolean;
  last_fired?: string;
  next_fire?: string;
  fire_count: number;
  created_at: string;
}

function triggerSummary(trigger: TriggerBase): string {
  if (trigger.type === "cron") return `cron: ${trigger.expr}`;
  if (trigger.type === "interval") return `every ${trigger.every_seconds}s`;
  if (trigger.type === "once") return `once: ${trigger.at}`;
  if (trigger.type === "webhook") return "webhook";
  if (trigger.type === "fs_watch") return "file watch";
  if (trigger.type === "task_complete") return "on task complete";
  return trigger.type;
}

function fmtTime(iso?: string): string {
  if (!iso) return "never";
  const d = new Date(iso);
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yestStart = new Date(todayStart.getTime() - 86400000);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (d >= todayStart) return `today at ${time}`;
  if (d >= yestStart) return `yesterday at ${time}`;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} at ${time}`;
}

export function Schedules() {
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Schedule | null>(null);
  const queryClient = useQueryClient();

  const { data: schedules = [] } = useQuery<Schedule[]>({
    queryKey: ["schedules"],
    queryFn: () => apiFetch("/api/v1/schedules"),
    refetchInterval: 15000,
  });

  async function toggleEnabled(id: string, enabled: boolean) {
    await apiFetch(`/api/v1/schedules/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: !enabled }),
    });
    queryClient.invalidateQueries({ queryKey: ["schedules"] });
  }

  async function deleteSchedule(id: string) {
    await apiFetch(`/api/v1/schedules/${id}`, { method: "DELETE" });
    queryClient.invalidateQueries({ queryKey: ["schedules"] });
  }

  function refresh() {
    queryClient.invalidateQueries({ queryKey: ["schedules"] });
    setShowForm(false);
    setEditing(null);
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

      <div className="flex-1 overflow-auto px-6 py-4 space-y-3">
        {schedules.length === 0 && (
          <p className="text-stone-500 text-sm">No schedules yet.</p>
        )}
        {schedules.map((s) => (
          <div
            key={s.id}
            className="bg-stone-900 border border-stone-800 rounded-xl px-4 py-4 space-y-3"
          >
            {/* Header row */}
            <div className="flex items-start gap-3">
              <button
                onClick={() => toggleEnabled(s.id, s.enabled)}
                title={s.enabled ? "Disable" : "Enable"}
                className="mt-0.5 shrink-0"
              >
                <span
                  className={`w-2.5 h-2.5 rounded-full inline-block ${
                    s.enabled ? "bg-teal-500" : "border-2 border-stone-600"
                  }`}
                />
              </button>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-stone-100">{s.name}</span>
                  <span className="text-xs text-stone-500 font-mono">{triggerSummary(s.trigger)}</span>
                </div>
                <p className="text-xs text-stone-400 mt-1 line-clamp-2">{s.prompt}</p>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  onClick={() => setEditing(s)}
                  title="Edit"
                  className="p-1.5 rounded-lg text-stone-500 hover:text-stone-300 hover:bg-stone-800"
                >
                  <Pencil size={13} />
                </button>
                <button
                  onClick={() => deleteSchedule(s.id)}
                  title="Delete"
                  className="p-1.5 rounded-lg text-stone-500 hover:text-red-400 hover:bg-stone-800"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>

            {/* Stats row */}
            <div className="flex items-center gap-4 text-xs text-stone-500 pl-5">
              <span>
                <span className="text-stone-400">{s.fire_count}</span> run{s.fire_count !== 1 ? "s" : ""}
              </span>
              <span>last: <span className="text-stone-400">{fmtTime(s.last_fired)}</span></span>
              {s.enabled && s.next_fire && (
                <span>next: <span className="text-stone-400">{fmtTime(s.next_fire)}</span></span>
              )}
              {!s.enabled && (
                <span className="text-stone-600 italic">disabled</span>
              )}
            </div>
          </div>
        ))}
      </div>

      {(showForm || editing) && (
        <ScheduleForm
          initial={editing ?? undefined}
          onClose={() => { setShowForm(false); setEditing(null); }}
          onCreated={refresh}
        />
      )}
    </div>
  );
}
