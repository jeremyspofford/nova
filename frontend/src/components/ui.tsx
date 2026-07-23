

/** One switch to rule all the tabs — a real toggle with a label that says
 *  what it controls, replacing the ambiguous "enabled" text chips. Disable
 *  is the ONLY off-switch for undeletable system entities, so this control
 *  must exist; it just has to explain itself. */
export function Toggle({ on, onChange, label, title }: {
  on: boolean; onChange: () => void; label: string; title: string;
}) {
  return (
    <span title={title} className="flex items-center gap-1.5 shrink-0 select-none">
      <span className={`text-[11px] ${on ? 'text-teal-300' : 'text-stone-500'}`}>{label}</span>
      <button
        type="button"
        onClick={onChange}
        aria-pressed={on}
        aria-label={label}
        className={`w-8 px-0.5 py-0.5 rounded-full transition ${on ? 'bg-teal-600' : 'bg-stone-700'}`}
      >
        <span className={`block w-3 h-3 rounded-full bg-white transition-transform ${on ? 'translate-x-4' : ''}`} />
      </button>
    </span>
  );
}

/** Reserved-height placeholders shown until a tab's data loads, so each panel
 *  renders once (no sparse-frame flash or layout shift on open). */
export function CardsSkeleton({ n = 4 }: { n?: number }) {
  return (
    <div className="space-y-2 animate-pulse" aria-hidden>
      {Array.from({ length: n }).map((_, i) => (
        <div key={i} className="h-14 rounded-lg border border-stone-800 bg-stone-800/30" />
      ))}
    </div>
  );
}
