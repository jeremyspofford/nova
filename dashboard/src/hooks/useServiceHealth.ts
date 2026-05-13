import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../api";

export type HealthStatus = "ok" | "degraded" | "critical";

interface ServiceCheck {
  name: string;
  ok: boolean;
}

async function checkAll(): Promise<ServiceCheck[]> {
  // Agent-core is the gateway for all services from the browser.
  // /api/health/ready — agent-core + DB
  // /api/v1/llm/providers — llm-gateway reachability (non-empty providers list)
  const results = await Promise.allSettled([
    fetch("/api/health/ready", { signal: AbortSignal.timeout(3000) })
      .then((r) => ({ name: "agent-core", ok: r.ok })),
    apiFetch<{ providers: unknown[] }>("/api/v1/llm/providers")
      .then((d) => ({ name: "llm-gateway", ok: d.providers.length > 0 }))
      .catch(() => ({ name: "llm-gateway", ok: false })),
  ]);
  return results.map((r) =>
    r.status === "fulfilled" ? r.value : { name: "unknown", ok: false }
  );
}

export function useServiceHealth() {
  return useQuery({
    queryKey: ["service-health"],
    queryFn: checkAll,
    refetchInterval: 30_000,
    staleTime: 25_000,
  });
}

export function deriveStatus(services: { ok: boolean }[]): HealthStatus {
  const downCount = services.filter((s) => !s.ok).length;
  if (downCount === 0) return "ok";
  if (downCount >= services.length) return "critical";
  return "degraded";
}
