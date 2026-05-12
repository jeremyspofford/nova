import { X } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../api";

interface Event {
  id: string;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: string;
}

export function TaskDetail({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const { data: events = [] } = useQuery({
    queryKey: ["task-events", taskId],
    queryFn: () => apiFetch<Event[]>(`/api/v1/tasks/${taskId}/events`),
  });

  return (
    <div className="w-96 border-l border-stone-800 flex flex-col h-full bg-stone-900/50">
      <div className="flex items-center justify-between px-4 py-3 border-b border-stone-800">
        <span className="text-sm font-medium">Audit trail</span>
        <button onClick={onClose} className="text-stone-500 hover:text-stone-300">
          <X size={16} />
        </button>
      </div>
      <div className="flex-1 overflow-auto p-4 space-y-2">
        {events.map((ev) => (
          <div key={ev.id} className="text-xs">
            <span className="text-stone-500 font-mono">
              {new Date(ev.occurred_at).toLocaleTimeString()}
            </span>
            <span className="ml-2 text-teal-300">{ev.event_type}</span>
            {Object.keys(ev.payload).length > 0 && (
              <pre className="mt-1 text-stone-400 bg-stone-800/60 rounded p-1.5 overflow-auto">
                {JSON.stringify(ev.payload, null, 2)}
              </pre>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
