import { ReactNode } from 'react';
import { GUTTER, useShellInsets } from '../shell/insets';

/** The scrim every centred overlay sits on, and the one thing they all used
 *  to get wrong: the side panels are overlays too, so the box is full-width
 *  and `justify-center` centres against a band the operator cannot see.
 *
 *  Padding by the published insets centres in the CLEAR band, while the
 *  scrim itself stays `inset-0` on purpose — it has to keep dimming the
 *  panels, and clicking over the chat has always closed the overlay. Shrink
 *  the box instead and those clicks fall through to a chat that is visually
 *  behind a modal but still takes typing. */
export function OverlayScrim({ onClose, variant = 'page', children }: {
  onClose: () => void;
  /** `page` — a routed surface, above the canvas chrome, top-anchored.
   *  `card` — the memory detail modal, level with the Atlas it covers. */
  variant?: 'page' | 'card';
  children: ReactNode;
}) {
  const { left, right } = useShellInsets();
  return (
    <div
      className={`absolute inset-0 flex justify-center ${variant === 'page'
        ? 'z-30 items-start pt-16 bg-black/40'
        : 'z-20 items-center bg-black/50'}`}
      style={{ paddingLeft: left + GUTTER, paddingRight: right + GUTTER }}
      onClick={onClose}
    >
      {children}
    </div>
  );
}

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


/** A byte count as the operator reads it. Shared because the Documents tab
 *  and the Files tab describe the same rows and had drifted into two
 *  byte-identical copies. */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** How the text of a stored document was obtained — the difference between a
 *  document and a READING of one, which the operator has to be able to see. */
export const SOURCE_NOTE: Record<string, string> = {
  mechanical: "read from the document's own text layer — exact",
  ocr: 'read by OCR from a scan or photo — may contain recognition errors',
  vision: 'described by a vision model — a reading, not the document itself',
};
