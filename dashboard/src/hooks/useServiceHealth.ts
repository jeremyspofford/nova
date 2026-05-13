import { useQuery } from "@tanstack/react-query";

const SERVICES = [
  { name: "agent-core",    url: "/api/health/ready" },
  { name: "llm-gateway",  url: "/v1/health/ready" },
  { name: "memory",        url: "/memory-api/health/ready" },
  { name: "voice-gateway", url: "/voice-api/health/ready" },
];

export type HealthStatus = "ok" | "degraded" | "critical";

async function checkAll(): Promise<{ name: string; ok: boolean }[]> {
  const results = await Promise.allSettled(
    SERVICES.map(async (s) => {
      const res = await fetch(s.url, { signal: AbortSignal.timeout(2000) });
      return { name: s.name, ok: res.ok };
    })
  );
  return results.map((r, i) => ({
    name: SERVICES[i].name,
    ok: r.status === "fulfilled" && r.value.ok,
  }));
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
  if (downCount >= 2) return "critical";
  return "degraded";
}
