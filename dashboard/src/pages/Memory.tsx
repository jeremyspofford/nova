import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../api";

interface Memory {
  id: string;
  content: string;
  source_kind: string;
  kind: string;
  importance: number;
  used_count: number;
  tags: string[];
  created_at: string;
  salience?: number;
}

interface ProfileEntry {
  id: string;
  content: string;
  kind: string;
  importance: number;
}

interface MemoryStats {
  total_rows: number;
  table_size_bytes: number;
  embedding_coverage_pct: number;
  degraded: boolean;
}

interface SearchResponse {
  results: Memory[];
  degraded: boolean;
}

const KIND_STYLES: Record<string, string> = {
  fact: "bg-sky-900/60 text-sky-300",
  preference: "bg-violet-900/60 text-violet-300",
  event: "bg-stone-700 text-stone-300",
  insight: "bg-amber-900/60 text-amber-300",
};

export function Memory() {
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [query, setQuery] = useState("");

  const { data: stats } = useQuery<MemoryStats>({
    queryKey: ["memory-stats"],
    queryFn: () => apiFetch("/api/v1/memories/stats"),
  });

  const { data: profile = [] } = useQuery<ProfileEntry[]>({
    queryKey: ["memory-profile"],
    queryFn: async () => {
      const r = await apiFetch<{ profile: ProfileEntry[] }>("/api/v1/memories/profile");
      return r.profile;
    },
  });

  const { data: memories = [] } = useQuery<Memory[]>({
    queryKey: ["memories", sourceFilter, query],
    queryFn: async () => {
      const r = await apiFetch<SearchResponse>("/api/v1/memories/search", {
        method: "POST",
        body: JSON.stringify({
          query,
          source_kinds: sourceFilter === "all" ? undefined : [sourceFilter],
          limit: 50,
        }),
      });
      return r.results;
    },
  });

  const formatSize = (b?: number) =>
    b ? `${(b / 1_048_576).toFixed(1)}MB` : "—";

  return (
    <div className="flex flex-col h-full">
      <div className="sticky top-0 bg-stone-950 border-b border-stone-800 px-6 py-4">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold">Memory</h1>
          <span className="text-xs text-stone-500">
            {stats?.total_rows?.toLocaleString()} memories · {formatSize(stats?.table_size_bytes)}
          </span>
        </div>
        {stats?.degraded && (
          <p className="mt-1 text-xs text-amber-400">
            Embeddings degraded — keyword search only
          </p>
        )}
      </div>

      <div className="flex-1 overflow-auto px-6 py-4">
        {profile.length > 0 && (
          <div className="mb-5">
            <h2 className="text-xs uppercase tracking-wide text-stone-500 mb-2">
              What Nova knows about you
            </h2>
            <div className="flex flex-wrap gap-2">
              {profile.map((p) => (
                <span
                  key={p.id}
                  className="text-xs bg-stone-800 border border-stone-700 rounded-full px-3 py-1 text-stone-300"
                  title={`${p.kind} · importance ${(p.importance * 100).toFixed(0)}%`}
                >
                  {p.content}
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="flex gap-2 mb-4">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search memories…"
            className="flex-1 text-sm bg-stone-800 border border-stone-700 rounded-lg px-3 py-1.5 placeholder:text-stone-600"
          />
          <select
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
            className="text-sm bg-stone-800 border border-stone-700 rounded-lg px-3 py-1.5"
          >
            {["all", "chat", "task_output"].map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
        </div>

        <div className="space-y-2">
          {memories.map((m) => (
            <div key={m.id} className="bg-stone-800/50 rounded-xl p-4 text-sm">
              <p className="text-stone-200 line-clamp-2">{m.content}</p>
              <div className="flex items-center gap-3 mt-2 text-xs text-stone-500">
                <span
                  className={`px-1.5 py-0.5 rounded ${KIND_STYLES[m.kind] ?? "bg-stone-700 text-stone-300"}`}
                >
                  {m.kind}
                </span>
                <span title="importance">{(m.importance * 100).toFixed(0)}%</span>
                {m.used_count > 0 && (
                  <span title="times recalled">{m.used_count}× recalled</span>
                )}
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
          {memories.length === 0 && (
            <p className="text-sm text-stone-600 py-8 text-center">
              No memories yet — they accumulate as you talk to Nova.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
