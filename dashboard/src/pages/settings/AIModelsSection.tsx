import { useQuery } from "@tanstack/react-query";
import { getLLMProviders } from "../../api";

const STRATEGY_LABELS: Record<string, string> = {
  "local-first": "Local-first (uses local AI, falls back to cloud)",
  "local-only": "Local only",
  "cloud-first": "Cloud-first (uses cloud, falls back to local)",
  "cloud-only": "Cloud only",
};

export function AIModelsSection() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["llm-providers"],
    queryFn: getLLMProviders,
    staleTime: 30_000,
    retry: 1,
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
        <h2 className="text-sm font-medium text-stone-300 mb-1">Routing Strategy</h2>
        <p className="text-sm text-stone-100">
          {STRATEGY_LABELS[data.routing_strategy] ?? data.routing_strategy}
        </p>
      </div>

      <div>
        <h2 className="text-sm font-medium text-stone-300 mb-3">Available Providers</h2>
        {activeProviders.length === 0 ? (
          <p className="text-sm text-stone-500 italic">
            No providers available. Configure an API key in Secrets, or ensure local inference is running.
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
                    <span className="text-sm font-medium text-stone-100 capitalize">
                      {p.name}
                    </span>
                    <span className="text-xs text-stone-500">
                      {p.local ? "local" : "cloud"}
                    </span>
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

      <p className="text-xs text-stone-500">
        To change models or routing, go to{" "}
        <a href="/recovery" className="text-teal-400 hover:underline">
          Settings → System
        </a>{" "}
        or configure API keys in the Secrets tab.
      </p>
    </div>
  );
}
