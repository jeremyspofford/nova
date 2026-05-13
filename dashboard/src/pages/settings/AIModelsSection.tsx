import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getLLMProviders, patchLLMConfig } from "../../api";

const STRATEGY_LABELS: Record<string, string> = {
  "local-first": "Local-first (local AI, falls back to cloud)",
  "local-only": "Local only",
  "cloud-first": "Cloud-first (cloud, falls back to local)",
  "cloud-only": "Cloud only",
};

const STRATEGIES = ["local-first", "local-only", "cloud-first", "cloud-only"] as const;

export function AIModelsSection() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["llm-providers"],
    queryFn: getLLMProviders,
    staleTime: 30_000,
    retry: 1,
  });

  const strategyMut = useMutation({
    mutationFn: (strategy: string) => patchLLMConfig({ routing_strategy: strategy }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["llm-providers"] }),
  });

  if (isLoading) {
    return <p className="text-sm text-stone-400">Loading model info...</p>;
  }

  if (error || !data) {
    return (
      <div className="text-sm text-amber-400">
        Could not reach LLM gateway. Check that services are running.
      </div>
    );
  }

  const activeProviders = data.providers.filter((p) => p.available);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-sm font-medium text-stone-300 mb-2">Routing Strategy</h2>
        <div className="flex flex-wrap gap-2">
          {STRATEGIES.map((s) => (
            <button
              key={s}
              onClick={() => strategyMut.mutate(s)}
              disabled={strategyMut.isPending}
              className={`px-3 py-1.5 rounded-lg text-sm transition-colors ${
                data.routing_strategy === s
                  ? "bg-teal-700 text-teal-100 font-medium"
                  : "bg-stone-800 text-stone-400 hover:text-stone-200 hover:bg-stone-700"
              }`}
            >
              {STRATEGY_LABELS[s]}
            </button>
          ))}
        </div>
        {strategyMut.isError && (
          <p className="mt-2 text-xs text-red-400">{(strategyMut.error as Error).message}</p>
        )}
      </div>

      <div>
        <h2 className="text-sm font-medium text-stone-300 mb-3">Available Providers</h2>
        {activeProviders.length === 0 ? (
          <p className="text-sm text-stone-500 italic">
            No providers available. Configure an API key in Secrets, or ensure local inference is
            running.
          </p>
        ) : (
          <div className="space-y-2">
            {activeProviders.map((p) => (
              <div
                key={p.name}
                className="flex items-center justify-between rounded-lg border border-stone-700 bg-stone-900/50 px-4 py-3"
              >
                <div>
                  <div className="flex items-center gap-2">
                    <span
                      className={`inline-block w-2 h-2 rounded-full ${
                        p.local ? "bg-teal-400" : "bg-blue-400"
                      }`}
                    />
                    <span className="text-sm font-medium text-stone-100 capitalize">{p.name}</span>
                    <span className="text-xs text-stone-500">{p.local ? "local" : "cloud"}</span>
                  </div>
                  <p className="mt-0.5 ml-4 text-xs font-mono text-stone-400">{p.model}</p>
                </div>
                {p.local && p.url && (
                  <span className="text-xs font-mono text-stone-600 truncate max-w-[200px]">
                    {p.url}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
