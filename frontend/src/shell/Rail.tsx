import { ReactNode, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useIngestSummary } from '../components/IngestionPanel';

/** The utility rail. The canvas is the app — these items open utility
 *  surfaces over it, and the Nova mark always leads back home. Collapsed
 *  to a 60px icon strip by default; expansion is a per-device preference.
 *  Desktop only: phones keep their toolbar until the bottom-tab pass. */

const EXPAND_KEY = 'nova.rail.expanded';
const CHAT_KEY = 'nova.chat.open';

const STROKE = {
  fill: 'none' as const, stroke: 'currentColor', strokeWidth: 2,
  strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
  width: 18, height: 18, viewBox: '0 0 24 24', 'aria-hidden': true as const,
};

export const ICONS = {
  library: (
    <svg {...STROKE}>
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  ),
  activity: (
    <svg {...STROKE}>
      <path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" />
    </svg>
  ),
  observability: (
    <svg {...STROKE} strokeWidth={2.2}>
      <path d="M3 12h4l2 6 4-14 2 8h6" />
    </svg>
  ),
  chat: (
    <svg {...STROKE}>
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </svg>
  ),
  settings: (
    <svg {...STROKE}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
  collapse: <svg {...STROKE}><path d="m11 17-5-5 5-5" /><path d="m18 17-5-5 5-5" /></svg>,
  expand: <svg {...STROKE}><path d="m13 17 5-5-5-5" /><path d="m6 17 5-5-5-5" /></svg>,
};

function RailItem({ icon, label, expanded, active, onClick, badge }: {
  icon: ReactNode; label: string; expanded: boolean;
  active?: boolean; onClick: () => void; badge?: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={expanded ? undefined : label}
      aria-label={label}
      className={`relative flex items-center gap-3 mx-2 px-2.5 py-2.5 rounded-lg text-sm leading-none ${
        expanded ? '' : 'justify-center'} ${
        active ? 'text-teal-300 bg-stone-800/70'
        : 'text-stone-400 hover:text-teal-300 hover:bg-stone-800/40'}`}
    >
      {active && (
        <span className="absolute -left-2 top-1/2 -translate-y-1/2 w-[3px] h-4 rounded-r-full bg-teal-400" />
      )}
      <span className="relative shrink-0">{icon}{badge}</span>
      {expanded && <span className="truncate">{label}</span>}
    </button>
  );
}

export function Rail() {
  const [expanded, setExpanded] = useState(() => localStorage.getItem(EXPAND_KEY) === '1');
  const [chatOpen, setChatOpen] = useState(() => localStorage.getItem(CHAT_KEY) !== '0');
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { summary } = useIngestSummary(false);

  const counts = summary?.counts ?? {};
  const ingestActive = (counts.running ?? 0) + (counts.queued ?? 0);
  const ingestFailed = counts.failed ?? 0;
  const ingestBadge = ingestActive > 0 ? (
    <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-teal-400 animate-ping" />
  ) : ingestFailed > 0 ? (
    <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-red-500" />
  ) : undefined;

  const at = (p: string) => pathname === p || pathname.startsWith(p + '/');
  // clicking the open surface's item closes it — back to the canvas
  const go = (p: string) => navigate(at(p) ? '/' : p);

  // side effects stay out of the state updaters — dispatching from inside
  // one re-renders Brain mid-render and React flags it
  const toggleExpand = () => {
    const next = !expanded;
    setExpanded(next);
    localStorage.setItem(EXPAND_KEY, next ? '1' : '0');
  };

  const toggleChat = () => {
    const next = !chatOpen;
    setChatOpen(next);
    localStorage.setItem(CHAT_KEY, next ? '1' : '0');
    window.dispatchEvent(new CustomEvent('nova:toggle-chat', { detail: { open: next } }));
  };

  return (
    <aside
      className={`hidden md:flex flex-col shrink-0 h-full py-3 bg-stone-950 border-r border-stone-800/80 transition-[width] duration-200 ${
        expanded ? 'w-60' : 'w-[60px]'}`}
    >
      <button
        onClick={() => navigate('/')}
        title="Back to the universe"
        aria-label="Back to the universe"
        className={`flex items-center gap-3 mx-2 px-2 py-1.5 rounded-lg hover:bg-stone-800/40 ${
          expanded ? '' : 'justify-center'}`}
      >
        <span className="w-7 h-7 shrink-0 rounded-full bg-gradient-to-br from-amber-100 via-amber-300 to-teal-400 shadow-[0_0_14px_rgba(45,212,191,0.45)]" />
        {expanded && <span className="text-stone-200 font-semibold text-sm">Nova</span>}
      </button>

      <nav className="flex-1 flex flex-col gap-1 mt-4">
        <RailItem icon={ICONS.library} label="Library" expanded={expanded}
          active={at('/library')} onClick={() => go('/library')} />
        <RailItem icon={ICONS.activity} label="Activity" expanded={expanded}
          active={at('/activity')} onClick={() => go('/activity')} badge={ingestBadge} />
        <RailItem icon={ICONS.observability} label="Observability" expanded={expanded}
          active={at('/observability')} onClick={() => go('/observability')} />
      </nav>

      <div className="flex flex-col gap-1">
        <RailItem icon={ICONS.chat} label={chatOpen ? 'Hide chat' : 'Show chat'}
          expanded={expanded} active={chatOpen} onClick={toggleChat} />
        <RailItem icon={ICONS.settings} label="Settings" expanded={expanded}
          active={at('/settings')} onClick={() => go('/settings')} />
        <RailItem icon={expanded ? ICONS.collapse : ICONS.expand}
          label={expanded ? 'Collapse' : 'Expand'} expanded={expanded}
          onClick={toggleExpand} />
      </div>
    </aside>
  );
}
