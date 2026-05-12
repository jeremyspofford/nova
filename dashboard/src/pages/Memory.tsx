import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../api";

interface Memory {
  id: string;
  content_preview: string;
  source_kind: string;
  tags: string[];
  created_at: string;
}

interface MemoryStats {
  count: number;
  size_bytes: number;
  advisory?: string;
}

export function Memory() {
  const [sourceFilter, setSourceFilter] = useState<string>("all");

  const { data: stats } = useQuery<MemoryStats>({
    queryKey: ["memory-stats"],
    queryFn: () => apiFetch("/api/v1/memories/stats"),
  });

  const { data: memories = [] } = useQuery<Memory[]>({
    queryKey: ["memories", sourceFilter],
    queryFn: () =>
      apiFetch(
        `/api/v1/memories?source_kind=${sourceFilter === "all" ? "" : sourceFilter}&limit=50`
      ),
  });

  const formatSize = (b?: number) =>
    b ? `${(b / 1_048_576).toFixed(1)}MB` : "—";

  return (
    <div className="flex flex-col h-full">
      <div className="sticky top-0 bg-stone-950 border-b border-stone-800 px-6 py-4">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold">Memory</h1>
          <span className="text-xs text-stone-500">
            {stats?.count?.toLocaleString()} memories · {formatSize(stats?.size_bytes)}
          </span>
        </div>
        {stats?.advisory && (
          <p className="mt-1 text-xs text-amber-400">{stats.advisory}</p>
        )}
      </div>

      <div className="flex-1 overflow-auto px-6 py-4">
        <select
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value)}
          className="mb-4 text-sm bg-stone-800 border border-stone-700 rounded-lg px-3 py-1.5"
        >
          {["all", "chat", "task_output", "knowledge_crawl", "intel_feed"].map((k) => (
            <option key={k} value={k}>{k}</option>
          ))}
        </select>

        <div className="space-y-2">
          {memories.map((m) => (
            <div key={m.id} className="bg-stone-800/50 rounded-xl p-4 text-sm">
              <p className="text-stone-200 line-clamp-2">{m.content_preview}</p>
              <div className="flex items-center gap-3 mt-2 text-xs text-stone-500">
                <span>{m.source_kind}</span>
                {m.tags.slice(0, 3).map((t) => (
                  <span key={t} className="bg-stone-700 px-1.5 py-0.5 rounded">{t}</span>
                ))}
                <span className="ml-auto">
                  {new Date(m.created_at).toLocaleDateString()}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
