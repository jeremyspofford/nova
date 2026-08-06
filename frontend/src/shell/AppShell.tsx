import { useEffect, useState } from 'react';
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { Brain } from '../pages/Brain';
import { PlainChat } from '../pages/PlainChat';
import { PLAIN_EVENT, plainMode } from './plainMode';
import { SettingsPage } from '../components/settings/SettingsPage';
import { LibraryPage } from '../components/library/LibraryPage';
import { ObservabilityOverlay } from '../components/ObservabilityOverlay';
import { ActivityPage } from '../components/IngestionPanel';
import { VaultPage } from '../vault/VaultPage';
import { Rail } from './Rail';

/** The app frame: utility rail (desktop) + the canvas. Brain (canvas +
 *  docked chat) is mounted permanently OUTSIDE the route switch —
 *  navigation must never tear down the WebGL renderer. Routed surfaces
 *  render over it, inside the content area, so the chrome stays reachable.
 *
 *  Phones have no chrome at all: the app IS the chat (2026-07-23), other
 *  surfaces hang off the chat header's drawer, and closing one lands back
 *  in chat. */
export function AppShell() {
  const navigate = useNavigate();
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768);
  // Which backdrop the routed surfaces are drawn over. Not a route: see
  // shell/plainMode.ts for why the universe must not become a URL.
  const [plain, setPlain] = useState(plainMode);
  useEffect(() => {
    const onPlain = (e: Event) =>
      setPlain(Boolean((e as CustomEvent).detail?.on));
    window.addEventListener(PLAIN_EVENT, onPlain);
    return () => window.removeEventListener(PLAIN_EVENT, onPlain);
  }, []);
  const home = () => navigate(window.innerWidth < 768 ? '/chat' : '/');

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // phones land in chat — chat IS the app there, the canvas one tab away
  useEffect(() => {
    if (window.innerWidth < 768 && window.location.pathname === '/') {
      navigate('/chat', { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // cross-surface jumps (e.g. Settings → Observability) stay event-based so
  // deep components don't thread navigation props
  useEffect(() => {
    const open = () => navigate('/observability');
    window.addEventListener('nova:open-observability', open);
    return () => window.removeEventListener('nova:open-observability', open);
  }, [navigate]);

  return (
    /* 100dvh, not 100vh: on the phone 100vh is the height the viewport would
       have with the browser UI hidden, so the composer sat under Safari's
       toolbar and the page had somewhere to scroll to. */
    <div className="flex w-full h-[100dvh] overflow-hidden bg-stone-950">
      <Rail />
      <div className="relative flex-1 min-w-0 h-full">
        {/* Exactly one of these is mounted. Swapping rather than hiding is
            the point of plain mode: a hidden canvas is still a live WebGL
            context doing work for a view that is meant not to have one. */}
        {plain ? <PlainChat /> : <Brain />}
        <Routes>
          <Route path="/" element={null} />
          <Route path="/chat" element={isMobile ? null : <Navigate to="/" replace />} />
          <Route path="/settings/:section?" element={<SettingsPage onClose={home} />} />
          <Route path="/library/:kind?" element={<LibraryPage onClose={home} />} />
          {/* Two routes rather than `/vault/:root?/*`: RR 6.30 supports an
              optional segment and a splat, but not reliably together. */}
          <Route path="/vault" element={<VaultPage onClose={home} />} />
          <Route path="/vault/:root/*" element={<VaultPage onClose={home} />} />
          <Route path="/observability" element={<ObservabilityOverlay onClose={home} />} />
          <Route path="/activity" element={<ActivityPage onClose={home} />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
    </div>
  );
}
