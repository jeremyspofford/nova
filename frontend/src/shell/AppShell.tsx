import { useEffect, useState } from 'react';
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { Brain } from '../pages/Brain';
import { SettingsPage } from '../components/settings/SettingsPage';
import { LibraryPage } from '../components/library/LibraryPage';
import { ObservabilityOverlay } from '../components/ObservabilityOverlay';
import { ActivityPage } from '../components/IngestionPanel';
import { Rail } from './Rail';
import { MobileNav } from './MobileNav';

/** The app frame: utility rail (desktop) / bottom tabs (phone) + the
 *  canvas. Brain (canvas + docked chat) is mounted permanently OUTSIDE the
 *  route switch — navigation must never tear down the WebGL renderer.
 *  Routed surfaces render over it, inside the content area, so the chrome
 *  stays reachable. */
export function AppShell() {
  const navigate = useNavigate();
  const home = () => navigate('/');
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768);

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
      {/* on phones the content area ends above the tab bar (plus the home
          indicator inset), so composers and cards never hide behind it */}
      <div className="relative flex-1 min-w-0 h-[calc(100%_-_3.25rem_-_env(safe-area-inset-bottom))] md:h-full">
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
      <MobileNav />
    </div>
  );
}
