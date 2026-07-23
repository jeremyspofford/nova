import { useEffect, useState } from 'react';
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { Brain } from '../pages/Brain';
import { SettingsPage } from '../components/settings/SettingsPage';
import { LibraryPage } from '../components/library/LibraryPage';
import { ObservabilityOverlay } from '../components/ObservabilityOverlay';
import { ActivityPage } from '../components/IngestionPanel';
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
    <div className="flex w-full h-screen overflow-hidden bg-stone-950">
      <Rail />
      <div className="relative flex-1 min-w-0 h-full">
        <Brain />
        <Routes>
          <Route path="/" element={null} />
          <Route path="/chat" element={isMobile ? null : <Navigate to="/" replace />} />
          <Route path="/settings/:section?" element={<SettingsPage onClose={home} />} />
          <Route path="/library/:kind?" element={<LibraryPage onClose={home} />} />
          <Route path="/observability" element={<ObservabilityOverlay onClose={home} />} />
          <Route path="/activity" element={<ActivityPage onClose={home} />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
    </div>
  );
}
