import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Cloud, Download, HardDrive, Loader2, Trash2, TriangleAlert } from "lucide-react";
import { apiFetch } from "../api";

interface Scores {
  agent: number;
  reasoning: number;
  coding: number;
  speed: number;
}

interface ModelEntry {
  ollama_id: string | null;
  api_id?: string;
  name: string;
  category: string;
  roles: string[];
  size_gb: number;
  capabilities: { tools: boolean | null; vision: boolean };
  scores: Scores | null;
  required?: boolean;
  cloud: boolean;
  provider: string | null;
  description: string;
  installed?: boolean;
  fits?: boolean | null;
  slow_on_cpu?: boolean;
  deny_reason?: string | null;
  available?: boolean;
}

interface RecommendedResponse {
  manifest_source: string;
  manifest_updated: string;
  hardware_source: string;
  local: ModelEntry[];
  cloud: ModelEntry[];
}

interface HardwareProfile {
  source: "detected" | "declared" | "unknown";
  gpus: { name?: string; vram_gb: number }[];
  ram_gb: number | null;
  inference_url: string;
  backend: string;
  observed?: { gpu_in_use: boolean | null; models_loaded: number | null };
}

interface PulledModel {
  name: string;
  size_bytes: number;
  digest: string;
  modified_at: string;
}

interface PullProgress {
  status: string;
  pct: number | null;
}

const CATEGORIES = ["all", "general", "reasoning", "code", "vision", "embedding"];

const SOURCE_BADGE: Record<string, string> = {
  detected: "bg-emerald-900/60 text-emerald-300",
  declared: "bg-sky-900/60 text-sky-300",
  unknown: "bg-amber-900/60 text-amber-300",
};

function Gauge({ scores }: { scores: Scores | null }) {
  if (!scores) return null;
  const rows: [string, number, boolean][] = [
    ["Agent", scores.agent, true],
    ["Reason", scores.reasoning, false],
    ["Code", scores.coding, false],
    ["Speed", scores.speed, false],
  ];
  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-1 mt-2">
      {rows.map(([label, value, accent]) => (
        <div key={label} className="flex items-center gap-1.5" title={`${label}: ${value}/5`}>
          <span className={`text-[10px] w-10 font-mono ${accent ? "text-teal-400" : "text-stone-500"}`}>
            {label}
          </span>
          <div className="flex gap-0.5">
            {[0, 1, 2, 3, 4].map((i) => (
              <span
                key={i}
                className={`w-2 h-1.5 rounded-sm ${
                  i < value ? (accent ? "bg-teal-400" : "bg-stone-400") : "bg-stone-700/70"
                }`}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function SizeBadge({ gb }: { gb: number }) {
  const color =
    gb <= 2 ? "bg-emerald-900/60 text-emerald-300"
    : gb <= 5 ? "bg-teal-900/60 text-teal-300"
    : gb <= 10 ? "bg-amber-900/60 text-amber-300"
    : "bg-red-900/50 text-red-300";
  return (
    <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${color}`}>
      {gb < 1 ? `${Math.round(gb * 1000)} MB` : `${gb} GB`}
    </span>
  );
}

export function Models() {
  const qc = useQueryClient();
  const [category, setCategory] = useState("all");
  const [fitsOnly, setFitsOnly] = useState(true);
  const [pulls, setPulls] = useState<Record<string, PullProgress>>({});
  const [declaring, setDeclaring] = useState(false);
  const [declVram, setDeclVram] = useState("");
  const [declRam, setDeclRam] = useState("");

  const { data: rec } = useQuery<RecommendedResponse>({
    queryKey: ["models-recommended"],
    queryFn: () => apiFetch("/api/v1/llm/models/recommended"),
  });
  const { data: hw } = useQuery<HardwareProfile>({
    queryKey: ["llm-hardware"],
    queryFn: () => apiFetch("/api/v1/llm/hardware"),
  });
  const { data: pulled = [] } = useQuery<PulledModel[]>({
    queryKey: ["models-pulled"],
    queryFn: () => apiFetch("/api/v1/llm/models/pulled"),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["models-recommended"] });
    qc.invalidateQueries({ queryKey: ["models-pulled"] });
  };

  const deleteMutation = useMutation({
    mutationFn: (name: string) =>
      apiFetch(`/api/v1/llm/models/${encodeURIComponent(name)}`, { method: "DELETE" }),
    onSettled: refresh,
  });

  const declareMutation = useMutation({
    mutationFn: () =>
      apiFetch("/api/v1/llm/hardware", {
        method: "PUT",
        body: JSON.stringify({
          gpus: declVram ? [{ vram_gb: Number(declVram) }] : [],
          ram_gb: declRam ? Number(declRam) : null,
        }),
      }),
    onSettled: () => {
      setDeclaring(false);
      qc.invalidateQueries({ queryKey: ["llm-hardware"] });
      qc.invalidateQueries({ queryKey: ["models-recommended"] });
    },
  });

  async function pull(model: string) {
    setPulls((p) => ({ ...p, [model]: { status: "starting", pct: null } }));
    try {
      const secret = localStorage.getItem("adminSecret");
      const res = await fetch("/api/v1/llm/models/pull", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(secret ? { "X-Admin-Secret": secret } : {}),
        },
        body: JSON.stringify({ model }),
      });
      if (!res.ok || !res.body) throw new Error(`${res.status} ${res.statusText}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const evt = JSON.parse(line.slice(6));
          if (evt.error) throw new Error(evt.error);
          const pct =
            evt.total && evt.completed ? Math.round((evt.completed / evt.total) * 100) : null;
          setPulls((p) => ({ ...p, [model]: { status: evt.status ?? "…", pct } }));
        }
      }
    } catch (e) {
      setPulls((p) => ({ ...p, [model]: { status: `failed: ${e}`, pct: null } }));
      return;
    } finally {
      setTimeout(() => {
        setPulls((p) => {
          const { [model]: _gone, ...rest } = p;
          return rest;
        });
        refresh();
      }, 1200);
    }
  }

  const localModels = useMemo(() => {
    const all = rec?.local ?? [];
    return all
      .filter((m) => category === "all" || m.category === category)
      .filter((m) => !fitsOnly || m.fits !== false);
  }, [rec, category, fitsOnly]);

  const cloudByProvider = useMemo(() => {
    const groups: Record<string, ModelEntry[]> = {};
    for (const m of rec?.cloud ?? []) {
      const key = m.provider ?? "other";
      (groups[key] ??= []).push(m);
    }
    return groups;
  }, [rec]);

  const totalVram = (hw?.gpus ?? []).reduce((s, g) => s + (g.vram_gb || 0), 0);
  const hwKnown = hw?.source !== "unknown";

  return (
    <div className="flex flex-col h-full">
      <div className="sticky top-0 z-10 bg-stone-950 border-b border-stone-800 px-6 py-4">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold">Models</h1>
          {rec && (
            <span className="text-xs font-mono text-stone-500" title="recommended-list source">
              manifest: {rec.manifest_source} · {rec.manifest_updated}
            </span>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-auto px-6 py-4 pb-20 md:pb-4">
        {/* Inference host */}
        <div className="bg-stone-800/50 rounded-xl p-4 mb-6">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <HardDrive className="h-4 w-4 text-stone-400" />
            <span className="font-mono text-xs text-stone-300">{hw?.inference_url}</span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded ${SOURCE_BADGE[hw?.source ?? "unknown"]}`}>
              {hw?.source ?? "…"}
            </span>
            {hwKnown && (
              <span className="text-xs text-stone-400 font-mono">
                {totalVram > 0 ? `GPU ${totalVram} GB VRAM` : "CPU-only"}
                {hw?.ram_gb ? ` · ${hw.ram_gb} GB RAM` : ""}
              </span>
            )}
            {hw?.observed?.gpu_in_use === false && totalVram > 0 && (
              <span className="text-xs text-amber-400" title="Models are loaded but not using the GPU">
                ⚠ inference running on CPU
              </span>
            )}
            <button
              onClick={() => setDeclaring((d) => !d)}
              className="ml-auto text-xs text-teal-400 hover:underline"
            >
              {hwKnown ? "Edit specs" : "Declare specs"}
            </button>
          </div>
          {!hwKnown && !declaring && (
            <p className="mt-2 text-xs text-amber-400">
              Hardware unknown — recommendations aren't filtered. Declare your inference host's
              specs to see what fits.
            </p>
          )}
          {declaring && (
            <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
              <input
                value={declVram}
                onChange={(e) => setDeclVram(e.target.value)}
                placeholder="GPU VRAM (GB, blank = none)"
                className="w-56 text-xs bg-stone-800 border border-stone-700 rounded-lg px-3 py-1.5 placeholder:text-stone-600"
              />
              <input
                value={declRam}
                onChange={(e) => setDeclRam(e.target.value)}
                placeholder="RAM (GB)"
                className="w-32 text-xs bg-stone-800 border border-stone-700 rounded-lg px-3 py-1.5 placeholder:text-stone-600"
              />
              <button
                onClick={() => declareMutation.mutate()}
                className="text-xs bg-teal-600 hover:bg-teal-500 rounded-lg px-3 py-1.5"
              >
                Save
              </button>
            </div>
          )}
        </div>

        {/* Installed */}
        {pulled.length > 0 && (
          <div className="mb-6">
            <h2 className="text-xs uppercase tracking-wide text-stone-500 mb-2">
              Installed ({pulled.length})
            </h2>
            <div className="space-y-1">
              {pulled.map((m) => (
                <div
                  key={m.name}
                  className="flex items-center gap-3 bg-stone-800/50 rounded-lg px-3 py-2 text-sm"
                >
                  <span className="font-mono text-xs text-stone-200">{m.name}</span>
                  <span className="font-mono text-[10px] text-stone-500">
                    {(m.size_bytes / 1_073_741_824).toFixed(1)} GB · {m.digest}
                  </span>
                  <button
                    onClick={() => deleteMutation.mutate(m.name)}
                    className="ml-auto text-stone-500 hover:text-red-400"
                    title={`Delete ${m.name}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Recommended local */}
        <div className="mb-6">
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <h2 className="text-xs uppercase tracking-wide text-stone-500">Local models</h2>
            <div className="flex gap-1 ml-2">
              {CATEGORIES.map((c) => (
                <button
                  key={c}
                  onClick={() => setCategory(c)}
                  className={`text-[11px] px-2 py-0.5 rounded-full border ${
                    category === c
                      ? "border-teal-500 text-teal-300 bg-teal-900/30"
                      : "border-stone-700 text-stone-400 hover:border-stone-500"
                  }`}
                >
                  {c}
                </button>
              ))}
            </div>
            <label className="ml-auto flex items-center gap-1.5 text-xs text-stone-400 cursor-pointer">
              <input
                type="checkbox"
                checked={fitsOnly}
                onChange={(e) => setFitsOnly(e.target.checked)}
                className="accent-teal-500"
              />
              fits my hardware
            </label>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            {localModels.map((m) => {
              const prog = m.ollama_id ? pulls[m.ollama_id] : undefined;
              return (
                <div
                  key={m.ollama_id ?? m.name}
                  className={`rounded-xl border p-3 text-sm ${
                    m.installed
                      ? "border-teal-800 bg-teal-950/30"
                      : m.fits === false
                        ? "border-stone-800 bg-stone-900/40 opacity-50"
                        : "border-stone-800 bg-stone-800/50"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-stone-100">{m.name}</span>
                    {m.installed && <Check className="h-3.5 w-3.5 text-emerald-400 ml-auto" />}
                  </div>
                  <p className="font-mono text-[10px] text-stone-500">{m.ollama_id}</p>
                  <p className="mt-1 text-xs text-stone-400 leading-snug line-clamp-2">
                    {m.description}
                  </p>
                  <Gauge scores={m.scores} />
                  {m.deny_reason && (
                    <p className="mt-2 flex items-start gap-1 text-[11px] text-amber-400">
                      <TriangleAlert className="h-3 w-3 mt-0.5 shrink-0" />
                      {m.deny_reason}
                    </p>
                  )}
                  {m.slow_on_cpu && !m.deny_reason && (
                    <p className="mt-2 text-[11px] text-amber-400/80">Will be slow on CPU</p>
                  )}
                  <div className="mt-2 flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <SizeBadge gb={m.size_gb} />
                      <span className="text-[10px] text-stone-500">{m.category}</span>
                    </div>
                    {prog ? (
                      <span className="flex items-center gap-1.5 text-[11px] text-teal-300 font-mono">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        {prog.pct !== null ? `${prog.pct}%` : prog.status.slice(0, 18)}
                      </span>
                    ) : m.installed ? (
                      <button
                        onClick={() => m.ollama_id && deleteMutation.mutate(m.ollama_id)}
                        className="text-stone-500 hover:text-red-400"
                        title="Delete"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    ) : (
                      <button
                        onClick={() => m.ollama_id && pull(m.ollama_id)}
                        className="flex items-center gap-1 text-[11px] text-teal-400 hover:text-teal-300"
                        title={`Pull ${m.ollama_id}`}
                      >
                        <Download className="h-3 w-3" /> pull
                      </button>
                    )}
                  </div>
                  {prog?.pct !== null && prog?.pct !== undefined && (
                    <div className="mt-2 h-1 rounded bg-stone-700 overflow-hidden">
                      <div
                        className="h-full bg-teal-500 transition-all"
                        style={{ width: `${prog.pct}%` }}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {localModels.length === 0 && (
            <p className="text-sm text-stone-600 py-6 text-center">
              Nothing matches — relax the filters.
            </p>
          )}
        </div>

        {/* Cloud / frontier */}
        <div>
          <h2 className="text-xs uppercase tracking-wide text-stone-500 mb-3 flex items-center gap-2">
            <Cloud className="h-3.5 w-3.5" /> Cloud / frontier models
          </h2>
          <div className="space-y-4">
            {Object.entries(cloudByProvider).map(([provider, models]) => (
              <div key={provider}>
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-xs font-mono text-stone-400">{provider}</span>
                  {models[0]?.available ? (
                    <span className="text-[10px] text-emerald-400">● configured</span>
                  ) : (
                    <span className="text-[10px] text-stone-600">
                      ○ no API key — add one in Settings → Secrets
                    </span>
                  )}
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                  {models.map((m) => (
                    <div
                      key={m.api_id ?? m.ollama_id ?? m.name}
                      className={`rounded-xl border border-stone-800 p-3 text-sm ${
                        m.available ? "bg-stone-800/50" : "bg-stone-900/40 opacity-60"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-stone-100">{m.name}</span>
                        <Cloud className="h-3 w-3 text-sky-400 ml-auto shrink-0" />
                      </div>
                      <p className="font-mono text-[10px] text-stone-500">
                        {m.api_id ?? m.ollama_id}
                      </p>
                      <p className="mt-1 text-xs text-stone-400 leading-snug line-clamp-2">
                        {m.description}
                      </p>
                      <Gauge scores={m.scores} />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
