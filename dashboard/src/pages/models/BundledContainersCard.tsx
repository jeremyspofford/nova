import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Play, Square } from "lucide-react";
import { Button, Badge, StatusDot, Card } from "../../components/ui";
import {
  getBundledBackends,
  startBundledBackend,
  stopBundledBackend,
  type BundledBackend,
} from "../../api-recovery";

const BUNDLED_LABELS: Record<string, { label: string; description: string }> = {
  ollama:   { label: "Ollama",    description: "Easiest — pull models by name, CPU or GPU" },
  llamacpp: { label: "llama.cpp", description: "GGUF models from a local folder, CPU or GPU" },
  vllm:     { label: "vLLM",      description: "Production GPU serving (HuggingFace models)" },
  sglang:   { label: "SGLang",    description: "High-throughput GPU serving" },
};

/** Bundled inference containers Nova can run itself. Several can be warm at
 *  once; the "active" one is what the gateway routes local inference to.
 *  Shared by the Models page and Settings → Local Inference. */
export function BundledContainersCard({ hasGpu }: { hasGpu: boolean }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const { data: bundled } = useQuery<BundledBackend[]>({
    queryKey: ["bundled-backends"],
    queryFn: getBundledBackends,
    staleTime: 5_000,
    refetchInterval: 10_000,
    retry: 1,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["bundled-backends"] });
    queryClient.invalidateQueries({ queryKey: ["inference-backend-status"] });
    queryClient.invalidateQueries({ queryKey: ["backend-status"] });
  };

  const start = useMutation({
    mutationFn: startBundledBackend,
    onMutate: () => setError(null),
    onError: (e) => setError(e instanceof Error ? e.message : "Start failed"),
    onSettled: invalidate,
  });
  const stop = useMutation({
    mutationFn: stopBundledBackend,
    onMutate: () => setError(null),
    onError: (e) => setError(e instanceof Error ? e.message : "Stop failed"),
    onSettled: invalidate,
  });

  if (!bundled) return null;

  return (
    <div>
      <label className="block text-compact font-medium text-content-secondary mb-2">
        Bundled containers
      </label>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {bundled.map((b) => {
          const meta = BUNDLED_LABELS[b.backend] ?? { label: b.backend, description: "" };
          const running = b.container_status === "running";
          const gpuLocked = b.gpu_required && !hasGpu;
          const busy =
            (start.isPending && start.variables === b.backend) ||
            (stop.isPending && stop.variables === b.backend);
          return (
            <Card key={b.backend} variant="default" className="p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <StatusDot
                    status={b.healthy ? "success" : running ? "warning" : "neutral"}
                    pulse={running && !b.healthy}
                  />
                  <span className="text-compact font-medium text-content-primary">{meta.label}</span>
                  {b.active && <Badge color="accent" size="sm">active</Badge>}
                  {gpuLocked && <Badge color="neutral" size="sm">needs GPU</Badge>}
                </div>
                {running ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => stop.mutate(b.backend)}
                    loading={busy}
                    icon={<Square size={14} />}
                    title="Stop container"
                  />
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => start.mutate(b.backend)}
                    loading={busy}
                    disabled={gpuLocked}
                    icon={<Play size={14} />}
                    title={gpuLocked ? "Requires an NVIDIA GPU" : "Start container"}
                  />
                )}
              </div>
              <p className="mt-1 text-caption text-content-tertiary">{meta.description}</p>
              {running && (
                <p className="mt-0.5 text-caption font-mono text-content-tertiary">{b.base_url}</p>
              )}
            </Card>
          );
        })}
      </div>
      {error && (
        <p className="mt-2 text-caption text-danger">{error}</p>
      )}
      <p className="mt-1.5 text-caption text-content-tertiary">
        Several containers can run at once — starting one routes Nova's local
        inference to it. First start pulls the image (vLLM/SGLang are ~10 GB).
      </p>
    </div>
  );
}
