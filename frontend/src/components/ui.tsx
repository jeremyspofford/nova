import { ReactNode } from 'react';
import { GUTTER, useShellInsets } from '../shell/insets';
import { useIsMobile } from '../shell/useIsMobile';

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
        ? 'z-30 items-start bg-black/40'
        : 'z-20 items-center bg-black/50'}`}
      style={{
        paddingLeft: left + GUTTER,
        paddingRight: right + GUTTER,
        // top-anchored surfaces start below a notch/island as well as below
        // the canvas chrome — on the phone `pt-16` alone put the tab row
        // under the status bar (env() is 0 on desktop, so this is 4rem there)
        ...(variant === 'page'
          ? {
              paddingTop: 'calc(4rem + var(--nova-safe-top))',
              paddingBottom: 'calc(1rem + var(--nova-safe-bottom))',
            }
          : {}),
      }}
      onClick={onClose}
    >
      {children}
    </div>
  );
}

/** The back chevron every phone page carries. A standalone PWA has no
 *  browser back button and iOS gives it no edge-swipe, so this is the ONLY
 *  way out of a page — it is never decorative. */
export function BackButton({ onClick, label = 'Back' }: {
  onClick: () => void; label?: string;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      className="w-10 h-10 shrink-0 -ml-1 flex items-center justify-center text-stone-300 active:text-teal-300"
    >
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M15 18l-6-6 6-6" />
      </svg>
    </button>
  );
}

/** A routed surface — Settings, the Library, Activity, the board.
 *
 *  On a desktop it is what it always was: a card floating on a scrim, sized
 *  to the clear band between the side panels. On a phone it is a PAGE —
 *  no scrim, no rounded card, no gutter, no × in a corner. A dialog on a
 *  393px screen already occupies the whole screen; dressing it as a
 *  floating window only spends edges on shadow and forces every table
 *  inside it through a narrower column than the device has.
 *
 *  The phone header is a back chevron and a title, in that order, because
 *  these surfaces are now a stack you walk out of rather than modals you
 *  dismiss. `actions` is for the one control a page needs at the top right;
 *  everything else belongs in the body. */
export function Surface({ title, width = 'w-[46rem]', onBack, header, actions, bodyClass = '', children }: {
  /** phone header title (desktop draws `header` instead) */
  title: string;
  /** desktop card width classes, e.g. `w-[46rem]` */
  width?: string;
  onBack: () => void;
  /** the desktop card's own header row */
  header?: ReactNode;
  /** phone-only header controls, right-aligned */
  actions?: ReactNode;
  /** everything after `flex-1 min-h-0` on the body — padding and overflow
   *  stay with the page, which is the only thing that knows if it scrolls */
  bodyClass?: string;
  children: ReactNode;
}) {
  const mobile = useIsMobile();

  if (mobile) {
    return (
      <div
        className="fixed inset-0 z-40 bg-stone-950 flex flex-col"
        style={{
          paddingTop: 'var(--nova-safe-top)',
          paddingBottom: 'var(--nova-safe-bottom)',
        }}
        role="region"
        aria-label={title}
      >
        <header className="shrink-0 px-2 py-1 flex items-center gap-1 border-b border-stone-800">
          <BackButton onClick={onBack} />
          <h2 className="text-[15px] font-medium text-stone-100 truncate">{title}</h2>
          <span className="flex-1" />
          {actions}
        </header>
        <div className={`flex-1 min-h-0 ${bodyClass}`}>{children}</div>
      </div>
    );
  }

  return (
    <OverlayScrim onClose={onBack}>
      <div
        className={`${width} max-w-full max-h-full flex flex-col rounded-xl bg-stone-900/95 backdrop-blur border border-stone-700 shadow-2xl`}
        onClick={e => e.stopPropagation()}
      >
        {header}
        <div className={`flex-1 min-h-0 ${bodyClass}`}>{children}</div>
      </div>
    </OverlayScrim>
  );
}

/** The phone's list-of-destinations: Library sections, Settings sections.
 *  A row is a whole tap target with a chevron, not a tab in a strip that
 *  scrolls sideways — nine tabs in a 393px strip hide six of themselves. */
export function NavList({ children }: { children: ReactNode }) {
  return <div className="divide-y divide-stone-800/80">{children}</div>;
}

export function NavRow({ label, note, onClick }: {
  label: string; note?: string; onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full px-4 py-3.5 flex items-center gap-3 text-left active:bg-stone-900"
    >
      <span className="flex-1 min-w-0">
        <span className="block text-[15px] text-stone-100 truncate">{label}</span>
        {note && <span className="block text-xs text-stone-500 truncate mt-0.5">{note}</span>}
      </span>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
        className="shrink-0 text-stone-600" aria-hidden="true">
        <path d="M9 18l6-6-6-6" />
      </svg>
    </button>
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
