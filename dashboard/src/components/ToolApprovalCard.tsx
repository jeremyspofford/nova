import { Shield, ShieldAlert, Check, X } from "lucide-react";
import { apiFetch } from "../api";

interface ApprovalProps {
  toolCallId: string;
  name: string;
  tier: string;
  args: Record<string, unknown>;
  diff?: string;
  onResolved: (toolCallId: string) => void;
}

const TIER_STYLES: Record<string, string> = {
  MUTATE:   "border-amber-500/40 bg-amber-500/10",
  DESTRUCT: "border-red-500/40 bg-red-500/10",
};

export function ToolApprovalCard({ toolCallId, name, tier, args, diff, onResolved }: ApprovalProps) {
  async function resolve(action: string, scope?: string) {
    await apiFetch(`/api/v1/approvals/${toolCallId}/resolve`, {
      method: "POST",
      body: JSON.stringify({ action, scope }),
    });
    onResolved(toolCallId);
  }

  const borderClass = TIER_STYLES[tier] ?? "border-stone-700 bg-stone-800/40";
  const isDestruct = tier === "DESTRUCT";

  return (
    <div className={`rounded-xl border p-4 my-2 max-w-xl ${borderClass}`}>
      <div className="flex items-center gap-2 mb-2">
        {isDestruct ? (
          <ShieldAlert size={16} className="text-red-400" />
        ) : (
          <Shield size={16} className="text-amber-400" />
        )}
        <span className="font-mono text-sm font-semibold">{name}</span>
        <span
          className={`text-xs px-1.5 py-0.5 rounded ${
            isDestruct ? "bg-red-500/20 text-red-300" : "bg-amber-500/20 text-amber-300"
          }`}
        >
          {tier}
        </span>
      </div>

      <pre className="text-xs text-stone-300 bg-stone-900/60 rounded p-2 mb-3 overflow-auto max-h-32">
        {JSON.stringify(args, null, 2)}
      </pre>

      {diff && (
        <pre className="text-xs font-mono bg-stone-900/80 rounded p-2 mb-3 overflow-auto max-h-40 whitespace-pre-wrap">
          {diff}
        </pre>
      )}

      <div className="flex gap-2 flex-wrap">
        <button
          onClick={() => resolve("grant", "once")}
          className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-teal-600 hover:bg-teal-500 text-sm text-white"
        >
          <Check size={14} /> Approve once
        </button>
        {!isDestruct && (
          <button
            onClick={() => resolve("grant", "task")}
            className="px-3 py-1.5 rounded-lg bg-stone-700 hover:bg-stone-600 text-sm"
          >
            Approve for task
          </button>
        )}
        <button
          onClick={() => resolve("deny")}
          className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-stone-800 hover:bg-red-900/40 text-sm text-stone-400 hover:text-red-300"
        >
          <X size={14} /> Deny
        </button>
      </div>
    </div>
  );
}
