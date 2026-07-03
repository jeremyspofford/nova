import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Cpu, Play, Square, RefreshCw, Wifi, AlertCircle, Lightbulb, CheckCircle2, ArrowRight, Eye, EyeOff } from "lucide-react";
import { Section, Button, Toggle, Badge, StatusDot, Card } from "../../components/ui";
import { ConfigField, useConfigValue, type ConfigSectionProps } from "./shared";
import { recoveryFetch } from "../../api-recovery";
import {
  getRecommendation,
  getBundledBackends,
  startBundledBackend,
  stopBundledBackend,
  type InferenceRecommendation,
  type BundledBackend,
} from "../../api-recovery";
import { getLMStudioStatus } from "../../api";

interface HardwareInfo {
  gpus: Array<{ vendor: string; model: string; vram_gb: number; index: number }>;
  docker_gpu_runtime: string;
  cpu_cores: number;
  ram_gb: number;
  disk_free_gb: number;
  detected_at: string;
  recommended_backend: string;
}

interface BackendStatus {
  backend: string;
  state: string;
  container_status: unknown;
  error?: string;
  switch_progress?: { step: string; detail: string };
}

const BACKENDS = [
  { value: "ollama", label: "Ollama", description: "Easy mode / CPU fallback" },
  { value: "llamacpp", label: "llama.cpp", description: "GGUF models, CPU or GPU" },
  { value: "vllm", label: "vLLM", description: "Production GPU inference (NVIDIA/AMD)" },
  { value: "sglang", label: "SGLang", description: "High-throughput GPU inference" },
  { value: "lmstudio", label: "LM Studio", description: "Desktop OpenAI-compatible server on your host" },
  { value: "custom", label: "Custom", description: "User-managed OpenAI-compatible server" },
  { value: "none", label: "None", description: "Cloud providers only" },
] as const;

const STATE_LABELS: Record<string, { label: string; status: 'success' | 'neutral' | 'warning' | 'danger' }> = {
  ready:    { label: "Running",      status: "success" },
  stopped:  { label: "Stopped",      status: "neutral" },
  starting: { label: "Starting...",  status: "warning" },
  draining: { label: "Draining...",  status: "warning" },
  error:    { label: "Error",        status: "danger" },
};

const BUNDLED_LABELS: Record<string, { label: string; description: string }> = {
  ollama:   { label: "Ollama",    description: "Easiest — pull models by name, CPU or GPU" },
  llamacpp: { label: "llama.cpp", description: "GGUF models from a local folder, CPU or GPU" },
  vllm:     { label: "vLLM",      description: "Production GPU serving (HuggingFace models)" },
  sglang:   { label: "SGLang",    description: "High-throughput GPU serving" },
};

/** Bundled inference containers Nova can run itself. Several can be warm at
 *  once; the "active" one is what the gateway routes local inference to. */
function BundledContainersCard({ hasGpu }: { hasGpu: boolean }) {
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
    <div className="mb-4">
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

function LMStudioCard({ entries, onSave, saving }: ConfigSectionProps) {
  const queryClient = useQueryClient();
  const lmstudioUrl = useConfigValue(entries, "inference.lmstudio_url", "http://host.docker.internal:1234");
  const lmstudioKey = useConfigValue(entries, "inference.lmstudio_api_key", "");
  const [urlDraft, setUrlDraft] = useState(lmstudioUrl);
  const [keyDraft, setKeyDraft] = useState(lmstudioKey);
  const [urlDirty, setUrlDirty] = useState(false);
  const [keyDirty, setKeyDirty] = useState(false);
  const [showKey, setShowKey] = useState(false);

  useEffect(() => { setUrlDraft(lmstudioUrl); setUrlDirty(false); }, [lmstudioUrl]);
  useEffect(() => { setKeyDraft(lmstudioKey); setKeyDirty(false); }, [lmstudioKey]);

  const { data: lmStatus, refetch, isFetching } = useQuery({
    queryKey: ["lmstudio-status"],
    queryFn: getLMStudioStatus,
    staleTime: 10_000,
    refetchInterval: 15_000,
    retry: 1,
  });

  const handleSaveUrl = () => { onSave("inference.lmstudio_url", JSON.stringify(urlDraft)); setUrlDirty(false); };
  const handleSaveKey = () => { onSave("inference.lmstudio_api_key", JSON.stringify(keyDraft)); setKeyDirty(false); };
  const handleTest = async () => {
    await refetch();
    // Refresh the model catalog so LM Studio's loaded models appear in pickers.
    queryClient.invalidateQueries({ queryKey: ["model-catalog"] });
  };

  return (
    <div className="mt-4 space-y-3">
      {/* Server URL */}
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <label className="text-caption font-medium text-content-secondary">Server URL</label>
          {urlDirty && (
            <Button size="sm" onClick={handleSaveUrl} loading={saving}>Save</Button>
          )}
        </div>
        <input
          type="text"
          value={urlDraft}
          onChange={e => { setUrlDraft(e.target.value); setUrlDirty(e.target.value !== lmstudioUrl); }}
          placeholder="http://host.docker.internal:1234"
          className="h-9 w-full rounded-sm border border-border bg-surface-input px-3 text-compact text-content-primary placeholder:text-content-tertiary outline-none focus:border-border-focus focus:ring-2 focus:ring-accent-500/40 transition-colors font-mono"
        />
        <p className="mt-1 text-caption text-content-tertiary">
          LM Studio&rsquo;s local server URL. The default points at a host-colocated LM Studio (the Windows/macOS app, or a host install). For a remote LM Studio box, use its LAN IP.
        </p>
      </div>

      {/* API key (optional) */}
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <label className="text-caption font-medium text-content-secondary">API Key (optional)</label>
          {keyDirty && (
            <Button size="sm" onClick={handleSaveKey} loading={saving}>Save</Button>
          )}
        </div>
        <div className="relative">
          <input
            type={showKey ? "text" : "password"}
            value={keyDraft}
            onChange={e => { setKeyDraft(e.target.value); setKeyDirty(e.target.value !== lmstudioKey); }}
            placeholder="Only if you enabled server auth in LM Studio"
            className="h-9 w-full rounded-sm border border-border bg-surface-input px-3 pr-8 text-compact text-content-primary placeholder:text-content-tertiary outline-none focus:border-border-focus focus:ring-2 focus:ring-accent-500/40 transition-colors font-mono"
          />
          <button
            type="button"
            onClick={() => setShowKey(!showKey)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-content-tertiary hover:text-content-primary transition-colors"
          >
            {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
      </div>

      {/* Connection + loaded models */}
      <div className="flex items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={handleTest}
          loading={isFetching}
          icon={<RefreshCw size={14} />}
        >
          Test Connection
        </Button>
        {lmStatus && (
          <span className={`text-compact ${lmStatus.healthy ? "text-success" : "text-danger"}`}>
            {lmStatus.healthy
              ? `Connected \u2014 ${lmStatus.model_count} model${lmStatus.model_count === 1 ? "" : "s"} loaded`
              : "Not reachable"}
          </span>
        )}
      </div>
      {lmStatus?.healthy && lmStatus.models.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {lmStatus.models.map(m => (
            <Badge key={m} color="neutral" size="sm" className="font-mono">{m}</Badge>
          ))}
        </div>
      )}
      {lmStatus && !lmStatus.healthy && (
        <div className="rounded-sm bg-surface-elevated p-2.5 text-caption text-content-tertiary space-y-1">
          <p>Start LM Studio &rarr; <span className="text-content-secondary">Developer</span> tab &rarr; <span className="text-content-secondary">Start Server</span> on port 1234, then load a model.</p>
          <p>
            Download LM Studio at{" "}
            <a href="https://lmstudio.ai" target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">lmstudio.ai</a>
          </p>
        </div>
      )}

      {/* Embeddings guidance */}
      <div className="rounded-sm border border-amber-200 dark:border-amber-800 bg-warning-dim p-2.5 text-caption space-y-1">
        <p className="font-medium text-amber-800 dark:text-amber-300">Embeddings are separate from chat</p>
        <p className="text-amber-700 dark:text-amber-400">
          Nova uses its own embedding model for memory (see <span className="font-medium">Embedding Model</span> in LLM Routing). Keep embeddings on a different local server than your chat model &mdash; running both on one single-model server (LM Studio <em>or</em> Ollama) evicts the chat model on every embed call.
        </p>
        <p className="text-amber-700 dark:text-amber-400">
          To use LM Studio for embeddings, pick it as the embedding provider below &mdash; ideally a 768-dim model (e.g. nomic-embed-text) to match existing memories.
        </p>
      </div>
    </div>
  );
}

export function LocalInferenceSection({ entries, onSave, saving, inline }: ConfigSectionProps & { inline?: boolean }) {
  const queryClient = useQueryClient();
  const [selectedBackend, setSelectedBackend] = useState<string>("");
  const [showRemote, setShowRemote] = useState(false);

  const configBackend = useConfigValue(entries, "inference.backend", "ollama");
  const remoteUrl = useConfigValue(entries, "inference.url", "");
  const wolMac = useConfigValue(entries, "llm.wol_mac", "");
  const customUrl = useConfigValue(entries, "inference.custom_url", "");
  const customAuth = useConfigValue(entries, "inference.custom_auth_header", "");
  const keepAlive = useConfigValue(entries, "inference.keep_alive", "30m");
  const [testingConnection, setTestingConnection] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  // Track backend switching for confirmation banner
  const [switchInfo, setSwitchInfo] = useState<{ from: string; to: string } | null>(null);
  const [switchConfirmed, setSwitchConfirmed] = useState(false);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout>>();

  const { data: recommendation } = useQuery<InferenceRecommendation>({
    queryKey: ["inference-recommendation"],
    queryFn: getRecommendation,
    staleTime: 60_000,
    retry: 1,
  });

  const { data: hardware } = useQuery<HardwareInfo>({
    queryKey: ["inference-hardware"],
    queryFn: () => recoveryFetch<HardwareInfo>("/api/v1/recovery/inference/hardware"),
    staleTime: 60_000,
    retry: 1,
  });

  const { data: status, refetch: refetchStatus } = useQuery<BackendStatus>({
    queryKey: ["inference-backend-status"],
    queryFn: () => recoveryFetch<BackendStatus>("/api/v1/recovery/inference/backend"),
    staleTime: 5_000,
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      return state === "starting" || state === "draining" ? 2_000 : 10_000;
    },
    retry: 1,
  });

  const startBackend = useMutation({
    mutationFn: (backend: string) =>
      recoveryFetch(`/api/v1/recovery/inference/backend/${backend}/start`, { method: "POST" }),
    onMutate: (backend) => {
      queryClient.setQueryData<BackendStatus>(["inference-backend-status"], (old) =>
        old ? { ...old, backend, state: "starting" } : { backend, state: "starting", container_status: null },
      );
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["inference-backend-status"] });
    },
  });

  const stopBackend = useMutation({
    mutationFn: () =>
      recoveryFetch("/api/v1/recovery/inference/backend/stop", { method: "POST" }),
    onMutate: () => {
      queryClient.setQueryData<BackendStatus>(["inference-backend-status"], (old) =>
        old ? { ...old, state: "draining" } : undefined,
      );
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["inference-backend-status"] });
    },
  });

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (configBackend && !selectedBackend) {
      setSelectedBackend(configBackend);
    }
  }, [configBackend]);

  // Detect when a backend switch completes (state becomes "ready" while we're tracking a switch)
  useEffect(() => {
    if (switchInfo && status?.state === "ready" && status.backend === switchInfo.to) {
      setSwitchConfirmed(true);
      // Auto-dismiss after 8 seconds
      confirmTimerRef.current = setTimeout(() => {
        setSwitchConfirmed(false);
        setSwitchInfo(null);
      }, 8_000);
    }
    return () => { if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current); };
  }, [switchInfo, status?.state, status?.backend]);

  const currentState = status?.state || "stopped";
  const stateInfo = STATE_LABELS[currentState] || STATE_LABELS.stopped;
  const isTransitioning = currentState === "starting" || currentState === "draining";
  const hasGpu = hardware?.gpus && hardware.gpus.length > 0;
  const primaryGpu = hardware?.gpus?.[0];

  /** Switch backend: save config + start the new backend (recovery controller stops the old one) */
  const handleSwitchBackend = (backend: string) => {
    const currentBackend = status?.backend || configBackend;
    if (backend === currentBackend && currentState === "ready") return; // already active

    setSelectedBackend(backend);
    onSave("inference.backend", backend);

    // Clear any previous confirmation
    setSwitchConfirmed(false);
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);

    if (backend === "none" || backend === "custom") {
      // No Nova-managed container to start — just save config
      setSwitchInfo(null);
      return;
    }

    // LM Studio is config-only (no container), but selecting it still goes
    // through start_backend so recovery can stop any running container backend
    // we're switching away from and mark state ready.
    if (currentBackend && currentBackend !== backend) {
      setSwitchInfo({ from: currentBackend, to: backend });
    } else {
      setSwitchInfo(null); // restarting same backend, no switch banner needed
    }
    startBackend.mutate(backend);
  };

  const content = (
    <>
      {/* Recommendation Banner */}
      {recommendation && status && recommendation.backend !== status.backend && status.backend !== "none" && (
        <div className="mb-4 p-3 bg-warning-dim border border-amber-200 dark:border-amber-800 rounded-sm text-compact flex items-start gap-2">
          <Lightbulb className="w-4 h-4 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
          <div>
            <span className="font-medium text-amber-800 dark:text-amber-300">Recommendation:</span>{" "}
            <span className="text-amber-700 dark:text-amber-400">{recommendation.reason}</span>
            <span className="text-amber-600 dark:text-amber-500 ml-1">
              Consider switching to <strong>{recommendation.backend}</strong>
              {recommendation.model && <> with <code className="text-caption">{recommendation.model}</code></>}.
            </span>
          </div>
        </div>
      )}

      {/* Hardware Info */}
      {hardware && (
        <Card variant="default" className="p-3 mb-4">
          {hasGpu ? (
            <div className="flex items-center gap-2 text-compact">
              <Badge color="success" size="sm">GPU Detected</Badge>
              <span className="text-content-secondary">
                {primaryGpu?.model} ({primaryGpu?.vram_gb}GB VRAM)
                {hardware.gpus.length > 1 && ` + ${hardware.gpus.length - 1} more`}
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-compact text-content-tertiary">
              <AlertCircle className="w-4 h-4" />
              <span>No GPU detected. Ollama (CPU) or cloud providers recommended.</span>
            </div>
          )}
          {hardware.recommended_backend && (
            <div className="mt-1 text-caption text-content-tertiary">
              Recommended: <span className="text-accent">{hardware.recommended_backend}</span>
            </div>
          )}
        </Card>
      )}

      {/* Switch Confirmation Banner */}
      {switchConfirmed && switchInfo && (
        <div className="mb-4 p-3 bg-success/10 border border-emerald-300 dark:border-emerald-700 rounded-sm text-compact flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-success flex-shrink-0" />
          <span className="text-emerald-800 dark:text-emerald-300">
            Switched from <strong>{BACKENDS.find(b => b.value === switchInfo.from)?.label || switchInfo.from}</strong>
            <ArrowRight className="w-3 h-3 inline mx-1" />
            <strong>{BACKENDS.find(b => b.value === switchInfo.to)?.label || switchInfo.to}</strong>
            {" "}&mdash; backend is running.
          </span>
          <button
            className="ml-auto text-emerald-600 dark:text-emerald-400 hover:text-emerald-800 dark:hover:text-emerald-200 text-caption"
            onClick={() => { setSwitchConfirmed(false); setSwitchInfo(null); }}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* In-progress Switch Banner */}
      {switchInfo && !switchConfirmed && isTransitioning && (
        <div className="mb-4 p-3 bg-surface-elevated border border-border-subtle rounded-sm text-compact flex items-center gap-2">
          <RefreshCw className="w-4 h-4 text-accent animate-spin flex-shrink-0" />
          <span className="text-content-secondary">
            Switching from <strong>{BACKENDS.find(b => b.value === switchInfo.from)?.label || switchInfo.from}</strong>
            {" "}to <strong>{BACKENDS.find(b => b.value === switchInfo.to)?.label || switchInfo.to}</strong>...
          </span>
          {/* Escape hatch: a stuck start (e.g. SGLang on a GPU-less host) traps
              the user here. Cancelling stops the in-flight start + container. */}
          {currentState === "starting" && (
            <button
              className="ml-auto text-content-tertiary hover:text-danger text-caption"
              onClick={() => stopBackend.mutate()}
              disabled={stopBackend.isPending}
            >
              Cancel
            </button>
          )}
        </div>
      )}

      {/* Bundled containers Nova can run itself */}
      <BundledContainersCard hasGpu={!!hasGpu} />

      {/* Backend Selector */}
      <div className="space-y-3">
        <label className="block text-compact font-medium text-content-secondary">Active backend</label>
        <div className="flex flex-wrap gap-2">
          {BACKENDS.map((b) => (
            <Button
              key={b.value}
              variant={(status?.backend || configBackend) === b.value ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => handleSwitchBackend(b.value)}
              disabled={currentState === "draining"}
            >
              {b.label}
            </Button>
          ))}
        </div>
      </div>

      {/* Status */}
      {status && status.backend !== "none" && (
        <Card variant="default" className="mt-4 p-3 space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <StatusDot status={stateInfo.status} pulse={isTransitioning} />
              <span className="text-compact font-medium text-content-primary">{stateInfo.label}</span>
              <Badge color="neutral" size="sm">{status.backend}</Badge>
            </div>
            <div className="flex gap-2">
              {status.backend !== "lmstudio" && currentState === "ready" && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => stopBackend.mutate()}
                  loading={stopBackend.isPending}
                  icon={<Square size={14} />}
                />
              )}
              {status.backend !== "lmstudio" && (currentState === "stopped" || currentState === "error") && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => startBackend.mutate(status.backend)}
                  loading={startBackend.isPending}
                  icon={<Play size={14} />}
                />
              )}
              {status.backend !== "lmstudio" && currentState === "starting" && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => stopBackend.mutate()}
                  loading={stopBackend.isPending}
                  icon={<Square size={14} />}
                  title="Cancel this start"
                />
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => refetchStatus()}
                icon={<RefreshCw size={14} />}
              />
            </div>
          </div>
          {currentState === "error" && status.error && (
            <div className="rounded-sm bg-danger-dim p-2 text-caption text-danger">
              {status.error}
            </div>
          )}
        </Card>
      )}

      {/* Custom Backend Config */}
      {(status?.backend || configBackend) === "custom" && (
        <div className="mt-4 space-y-3">
          <ConfigField
            label="Server URL"
            configKey="inference.custom_url"
            value={customUrl}
            onSave={onSave}
            saving={saving}
            placeholder="http://192.168.1.50:8000"
            description="URL of your OpenAI-compatible inference server"
          />
          <ConfigField
            label="Auth Header"
            configKey="inference.custom_auth_header"
            value={customAuth}
            onSave={onSave}
            saving={saving}
            placeholder="Bearer sk-..."
            description="Optional Authorization header value"
          />
          <Button
            size="sm"
            onClick={async () => {
              if (!customUrl) return;
              setTestingConnection(true);
              setTestResult(null);
              try {
                const headers: Record<string, string> = {};
                if (customAuth) headers["Authorization"] = customAuth;
                const r = await fetch(customUrl.replace(/\/$/, "") + "/health", {
                  headers,
                  signal: AbortSignal.timeout(5000),
                });
                setTestResult(r.ok
                  ? { ok: true, message: `Connected (HTTP ${r.status})` }
                  : { ok: false, message: `Server returned HTTP ${r.status}` });
              } catch (e) {
                setTestResult({ ok: false, message: e instanceof Error ? e.message : "Connection failed" });
              } finally {
                setTestingConnection(false);
              }
            }}
            disabled={!customUrl}
            loading={testingConnection}
          >
            Test Connection
          </Button>
          {testResult && (
            <p className={`text-compact ${testResult.ok ? "text-success" : "text-danger"}`}>
              {testResult.message}
            </p>
          )}
        </div>
      )}

      {/* LM Studio config — host-side desktop app */}
      {(status?.backend || configBackend) === "lmstudio" && (
        <LMStudioCard entries={entries} onSave={onSave} saving={saving} />
      )}

      {/* vLLM / SGLang run on your own server — you choose the model when you
          launch it (e.g. `vllm serve <model>`). Nova connects by URL and does
          not start, stop, or swap models on it. */}
      {["vllm", "sglang"].includes((status?.backend || configBackend).replace(/"/g, '')) && (
        <p className="mt-3 text-caption text-content-tertiary">
          The model is set when you launch {(status?.backend || configBackend).replace(/"/g, '')} on
          your server (e.g. <code className="font-mono">vllm serve &lt;model&gt;</code>). Set its
          URL below — Nova connects to it and never restarts or swaps its model.
        </p>
      )}

      {/* Remote Backend Toggle */}
      <div className="mt-4 pt-4 border-t border-border-subtle">
        <div className="flex items-center gap-2 text-compact text-content-tertiary">
          <Toggle
            checked={showRemote}
            onChange={setShowRemote}
            size="sm"
          />
          <Wifi className="w-4 h-4" />
          <span>Point at an external Ollama / vLLM / SGLang / llama.cpp server</span>
        </div>
        {!showRemote && (
          <p className="mt-1 text-caption text-content-tertiary">
            Toggle on to point Nova at a server you run yourself (host machine,
            another LAN box, a cloud VM) instead of a bundled container.
          </p>
        )}

        {showRemote && (
          <div className="mt-3 space-y-3">
            <ConfigField
              label="External URL"
              configKey="inference.url"
              value={remoteUrl}
              onSave={onSave}
              saving={saving}
              placeholder="http://192.168.12.10:11434"
              description="Base URL of the external Ollama / vLLM / SGLang server. Leave blank to use the bundled service."
            />
            {remoteUrl && (
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={async () => {
                    setTestingConnection(true);
                    setTestResult(null);
                    try {
                      const r = await fetch(remoteUrl.replace(/^"|"$/g, '').replace(/\/$/, "") + "/api/tags", {
                        signal: AbortSignal.timeout(5000),
                      });
                      if (r.ok) {
                        const data = await r.json().catch(() => ({}));
                        const count = Array.isArray(data?.models) ? data.models.length : 0;
                        setTestResult({ ok: true, message: `Connected — ${count} model${count === 1 ? '' : 's'} available` });
                      } else {
                        setTestResult({ ok: false, message: `Server returned HTTP ${r.status}` });
                      }
                    } catch (e) {
                      setTestResult({ ok: false, message: e instanceof Error ? e.message : "Connection failed" });
                    } finally {
                      setTestingConnection(false);
                    }
                  }}
                  loading={testingConnection}
                >
                  Test Connection
                </Button>
                {testResult && (
                  <p className={`text-compact ${testResult.ok ? "text-success" : "text-danger"}`}>
                    {testResult.message}
                  </p>
                )}
              </div>
            )}
            <ConfigField
              label="WoL MAC Address (optional)"
              configKey="llm.wol_mac"
              value={wolMac}
              onSave={onSave}
              saving={saving}
              placeholder="aa:bb:cc:dd:ee:ff"
              description="If set, Nova will send Wake-on-LAN to this MAC before retrying when the external server is unreachable."
            />
          </div>
        )}
      </div>

      {/* No GPU + No Remote guidance */}
      {!hasGpu && !showRemote && status?.backend !== "ollama" && (
        <div className="mt-3 p-3 bg-surface-elevated rounded-sm text-compact text-content-tertiary">
          No GPU detected and no remote server configured. Consider using Ollama (CPU) or configure cloud providers below.
        </div>
      )}

      {/* Ollama tuning — keep-alive controls model resident time */}
      <div className="mt-4 pt-4 border-t border-border-subtle">
        <ConfigField
          label="Ollama Keep-Alive"
          configKey="inference.keep_alive"
          value={keepAlive}
          onSave={onSave}
          saving={saving}
          placeholder="30m"
          description={'How long Ollama keeps a model loaded after the last request. Examples: "5m", "30m", "1h", "-1" for forever, "0" to unload immediately. Longer = fewer reload pauses, more RAM held.'}
        />
      </div>
    </>
  );

  if (inline) return content;

  return (
    <Section id="local-inference" icon={Cpu} title="Local Inference" description="Manage your local AI inference backend">
      {content}
    </Section>
  );
}
