import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle, XCircle, Clock, Loader2 } from "lucide-react";
import { apiFetch } from "../api";
import { TaskDetail } from "../components/TaskDetail";

interface Task {
  id: string;
  prompt: string;
  status: "pending" | "running" | "completed" | "failed";
  source: string;
  created_at: string;
  duration_ms?: number;
}

const STATUS_ICON = {
  completed: <CheckCircle size={14} className="text-emerald-400" />,
  failed:    <XCircle    size={14} className="text-red-400" />,
  running:   <Loader2    size={14} className="text-amber-400 animate-spin" />,
  pending:   <Clock      size={14} className="text-stone-500" />,
};

export function Tasks() {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data: tasks = [] } = useQuery({
    queryKey: ["tasks"],
    queryFn: () => apiFetch<Task[]>("/api/v1/tasks"),
  });

  function formatDuration(ms?: number): string {
    if (!ms) return "—";
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  }

  return (
    <div className="flex h-full">
      <div className="flex-1 overflow-auto">
        <div className="sticky top-0 bg-stone-950 border-b border-stone-800 px-6 py-4 flex items-center justify-between">
          <h1 className="text-lg font-semibold">Tasks</h1>
        </div>

        <table className="w-full text-sm">
          <thead>
            <tr className="text-stone-500 text-xs border-b border-stone-800">
              <th className="px-6 py-3 text-left font-medium">Status</th>
              <th className="px-3 py-3 text-left font-medium">Task</th>
              <th className="px-3 py-3 text-left font-medium">Source</th>
              <th className="px-3 py-3 text-left font-medium">Duration</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-800/60">
            {tasks.map((task) => (
              <tr
                key={task.id}
                onClick={() => setSelectedId(task.id)}
                className="hover:bg-stone-800/40 cursor-pointer transition-colors"
              >
                <td className="px-6 py-3">
                  <div className="flex items-center gap-1.5">
                    {STATUS_ICON[task.status] ?? STATUS_ICON.pending}
                    <span className="text-stone-400 text-xs">{task.status}</span>
                  </div>
                </td>
                <td className="px-3 py-3 text-stone-200 max-w-xs truncate">{task.prompt}</td>
                <td className="px-3 py-3 text-stone-500">{task.source}</td>
                <td className="px-3 py-3 text-stone-500">{formatDuration(task.duration_ms)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selectedId && (
        <TaskDetail taskId={selectedId} onClose={() => setSelectedId(null)} />
      )}
    </div>
  );
}
