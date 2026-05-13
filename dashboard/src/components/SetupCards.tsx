import { Cloud, Wifi, Mic, Sun, Check } from "lucide-react";

const CARDS = [
  { id: "cloud-ai",  icon: Cloud, title: "Connect cloud AI",    desc: "Better quality & speed" },
  { id: "tailscale", icon: Wifi,  title: "Remote access",       desc: "Use Nova from anywhere" },
  { id: "voice",     icon: Mic,   title: "Enable voice",        desc: "Talk to Nova hands-free" },
  { id: "briefing",  icon: Sun,   title: "Daily briefing",      desc: "Nova checks in each morning" },
] as const;

interface Props {
  completed: Set<string>;
  onStart: (cardId: string) => void;
  onDismiss: () => void;
}

export function SetupCards({ completed, onStart, onDismiss }: Props) {
  return (
    <div className="p-4 max-w-2xl">
      <div className="grid grid-cols-2 gap-3 mb-4">
        {CARDS.map(({ id, icon: Icon, title, desc }) => {
          const done = completed.has(id);
          return (
            <button
              key={id}
              onClick={() => !done && onStart(id)}
              className={`text-left p-4 rounded-xl border transition-colors ${
                done
                  ? "border-teal-700/50 bg-teal-900/20 cursor-default"
                  : "border-stone-700 bg-stone-800/60 hover:border-stone-600 hover:bg-stone-800"
              }`}
            >
              <div className="flex items-center justify-between mb-2">
                <Icon size={18} className={done ? "text-teal-400" : "text-stone-400"} />
                {done && <Check size={16} className="text-teal-400" />}
              </div>
              <div className="text-sm font-medium text-stone-200">{title}</div>
              <div className="text-xs text-stone-500 mt-0.5">{desc}</div>
            </button>
          );
        })}
      </div>
      <button
        onClick={onDismiss}
        className="text-xs text-stone-500 hover:text-stone-400 underline underline-offset-2"
      >
        Dismiss — I'll set up later
      </button>
    </div>
  );
}
