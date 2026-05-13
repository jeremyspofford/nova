import { useState } from "react";
import { ExtensionsSection } from "./settings/ExtensionsSection";
import { SecretsSection } from "./settings/SecretsSection";

const TABS = ["AI & Models", "Secrets", "Extensions", "Voice", "Scheduler", "System", "Recovery"] as const;
type Tab = (typeof TABS)[number];

export function Settings() {
  const [tab, setTab] = useState<Tab>("AI & Models");

  return (
    <div className="flex flex-col h-full">
      <div className="sticky top-0 bg-stone-950 border-b border-stone-800 px-6 pt-4">
        <h1 className="text-lg font-semibold mb-3">Settings</h1>
        <div className="flex gap-1 overflow-x-auto pb-0 -mb-px">
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2 text-sm whitespace-nowrap border-b-2 transition-colors ${
                tab === t
                  ? "border-teal-500 text-teal-300"
                  : "border-transparent text-stone-500 hover:text-stone-300"
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-auto px-6 py-6">
        <SettingsTab tab={tab} />
      </div>
    </div>
  );
}

function SettingsTab({ tab }: { tab: Tab }) {
  switch (tab) {
    case "AI & Models":
      return (
        <div className="text-stone-400 text-sm">
          AI &amp; Models settings — coming soon
        </div>
      );
    case "Secrets":
      return <SecretsSection />;
    case "Extensions":
      return <ExtensionsSection />;
    case "Recovery":
      return (
        <a href="/recovery" className="text-teal-400 underline text-sm">
          Open Recovery service UI →
        </a>
      );
    default:
      return <div className="text-stone-500 text-sm">{tab} — coming soon</div>;
  }
}
