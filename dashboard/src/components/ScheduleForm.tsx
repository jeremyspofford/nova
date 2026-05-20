import { useState } from "react";
import { X } from "lucide-react";
import { apiFetch } from "../api";

const TRIGGER_TYPES = ["cron", "once", "interval", "webhook", "fs_watch", "task_complete"] as const;
type TriggerType = (typeof TRIGGER_TYPES)[number];

interface TriggerBase { type: string; [k: string]: unknown; }

interface ScheduleInitial {
  id: string;
  name: string;
  prompt: string;
  trigger: TriggerBase;
  enabled: boolean;
}

interface Props {
  initial?: ScheduleInitial;
  onClose: () => void;
  onCreated: () => void;
}

function triggerType(t: TriggerBase): TriggerType {
  return TRIGGER_TYPES.includes(t.type as TriggerType) ? (t.type as TriggerType) : "cron";
}

export function ScheduleForm({ initial, onClose, onCreated }: Props) {
  const editing = !!initial;

  const [name, setName] = useState(initial?.name ?? "");
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [trigType, setTrigType] = useState<TriggerType>(
    initial ? triggerType(initial.trigger) : "cron"
  );
  const [cronExpr, setCronExpr] = useState(
    (initial?.trigger?.expr as string) ?? "0 9 * * *"
  );
  const [intervalSecs, setIntervalSecs] = useState(
    String(initial?.trigger?.every_seconds ?? 3600)
  );
  const [onceAt, setOnceAt] = useState((initial?.trigger?.at as string) ?? "");
  const [fsPath, setFsPath] = useState((initial?.trigger?.path as string) ?? "");
  const [fsPattern, setFsPattern] = useState((initial?.trigger?.pattern as string) ?? "*");
  const [error, setError] = useState("");

  function buildTrigger() {
    switch (trigType) {
      case "cron":     return { type: "cron", expr: cronExpr };
      case "interval": return { type: "interval", every_seconds: parseInt(intervalSecs, 10) };
      case "once":     return { type: "once", at: onceAt };
      case "webhook":  return { type: "webhook", token: (initial?.trigger?.token as string) ?? "" };
      case "fs_watch": return { type: "fs_watch", path: fsPath, pattern: fsPattern, on: ["created", "modified"] };
      default:         return { type: trigType };
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    try {
      if (editing) {
        await apiFetch(`/api/v1/schedules/${initial!.id}`, {
          method: "PATCH",
          body: JSON.stringify({ name, prompt, trigger: buildTrigger() }),
        });
      } else {
        await apiFetch("/api/v1/schedules", {
          method: "POST",
          body: JSON.stringify({ name, prompt, trigger: buildTrigger() }),
        });
      }
      onCreated();
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <form
        onSubmit={handleSubmit}
        className="bg-stone-900 border border-stone-700 rounded-2xl p-6 w-full max-w-md"
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold">{editing ? "Edit Schedule" : "New Schedule"}</h2>
          <button type="button" onClick={onClose}>
            <X size={18} className="text-stone-400" />
          </button>
        </div>

        <div className="space-y-3">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name"
            required
            className="w-full bg-stone-800 border border-stone-700 rounded-lg px-3 py-2 text-sm"
          />
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Task prompt"
            required
            rows={3}
            className="w-full bg-stone-800 border border-stone-700 rounded-lg px-3 py-2 text-sm resize-none"
          />

          <select
            value={trigType}
            onChange={(e) => setTrigType(e.target.value as TriggerType)}
            className="w-full bg-stone-800 border border-stone-700 rounded-lg px-3 py-2 text-sm"
          >
            {TRIGGER_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>

          {trigType === "cron" && (
            <input
              value={cronExpr}
              onChange={(e) => setCronExpr(e.target.value)}
              placeholder="0 9 * * *"
              className="w-full bg-stone-800 border border-stone-700 rounded-lg px-3 py-2 text-sm font-mono"
            />
          )}
          {trigType === "interval" && (
            <input
              type="number"
              value={intervalSecs}
              onChange={(e) => setIntervalSecs(e.target.value)}
              placeholder="Interval (seconds)"
              className="w-full bg-stone-800 border border-stone-700 rounded-lg px-3 py-2 text-sm"
            />
          )}
          {trigType === "once" && (
            <input
              type="datetime-local"
              value={onceAt}
              onChange={(e) => setOnceAt(e.target.value)}
              className="w-full bg-stone-800 border border-stone-700 rounded-lg px-3 py-2 text-sm"
            />
          )}
          {trigType === "fs_watch" && (
            <>
              <input
                value={fsPath}
                onChange={(e) => setFsPath(e.target.value)}
                placeholder="Watch path (e.g. /home/user/inbox/)"
                className="w-full bg-stone-800 border border-stone-700 rounded-lg px-3 py-2 text-sm"
              />
              <input
                value={fsPattern}
                onChange={(e) => setFsPattern(e.target.value)}
                placeholder="File pattern (e.g. *.pdf)"
                className="w-full bg-stone-800 border border-stone-700 rounded-lg px-3 py-2 text-sm"
              />
            </>
          )}
        </div>

        {error && <p className="mt-3 text-xs text-red-400">{error}</p>}

        <div className="flex justify-end gap-2 mt-5">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm text-stone-400 hover:text-stone-200"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="px-4 py-2 rounded-lg bg-teal-700 hover:bg-teal-600 text-sm"
          >
            {editing ? "Save" : "Create"}
          </button>
        </div>
      </form>
    </div>
  );
}
