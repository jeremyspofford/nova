import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ICONS } from './Rail';
import { useIngestSummary } from '../components/IngestionPanel';
import { getSettings } from '../api';

/** Phone navigation: four thumb tabs replacing the floating chrome. The
 *  second tab is the orb — the universe canvas, labeled with the
 *  assistant's configured name, deliberately not a "Brain" page. */
export function MobileNav() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { summary } = useIngestSummary(false);
  const [assistant, setAssistant] = useState('Nova');

  useEffect(() => {
    getSettings().then(defs => {
      const v = defs.find(d => d.key === 'nova.assistant_name')?.value;
      if (typeof v === 'string' && v.trim()) setAssistant(v.trim());
    }).catch(() => {});
  }, []);

  const counts = summary?.counts ?? {};
  const running = (counts.running ?? 0) + (counts.queued ?? 0);
  const failed = counts.failed ?? 0;
  const badge = running > 0 ? 'bg-teal-400 animate-pulse' : failed > 0 ? 'bg-red-500' : null;

  const tabs = [
    { label: 'Chat', to: '/chat', icon: ICONS.chat,
      on: pathname === '/chat' },
    { label: assistant, to: '/',
      icon: <span className="block w-[18px] h-[18px] rounded-full bg-gradient-to-br from-amber-100 via-amber-300 to-teal-400" />,
      on: pathname === '/' },
    { label: 'Activity', to: '/activity', icon: ICONS.activity,
      on: pathname.startsWith('/activity') || pathname.startsWith('/observability'),
      badge },
    { label: 'Settings', to: '/settings', icon: ICONS.settings,
      on: pathname.startsWith('/settings') || pathname.startsWith('/library') },
  ];

  return (
    <nav className="md:hidden fixed bottom-0 left-0 right-0 z-40 flex bg-stone-950/95 backdrop-blur border-t border-stone-800 pb-[env(safe-area-inset-bottom)]">
      {tabs.map(t => (
        <button
          key={t.to}
          onClick={() => navigate(t.to)}
          aria-label={t.label}
          className={`flex-1 flex flex-col items-center gap-1 pt-2 pb-1.5 text-[10px] ${
            t.on ? 'text-teal-300' : 'text-stone-500'}`}
        >
          <span className="relative">
            {t.icon}
            {t.badge && (
              <span className={`absolute -top-0.5 -right-1 w-2 h-2 rounded-full ${t.badge}`} />
            )}
          </span>
          <span className="truncate max-w-[5rem]">{t.label}</span>
        </button>
      ))}
    </nav>
  );
}
