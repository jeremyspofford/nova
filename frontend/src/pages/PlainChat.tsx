import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ChatPanel } from '../chat/ChatPanel';

/** The app without the app: full-width chat, no canvas, no WebGL.
 *
 *  Jeremy, 2026-08-06: "I want a view in the nova application that is not nova
 *  at all. What I would see would be full screen chat with the side bar, and
 *  if I clicked on a sidebar item, like library, it would open that in the
 *  nova view field."
 *
 *  A SECOND SHELL, not a mode inside `Brain`. The canvas is not a decoration
 *  that can be switched off there — it owns the layout, the insets, the atlas
 *  and a live WebGL renderer that must survive navigation, and threading a
 *  "pretend none of that exists" flag through it would leave the renderer
 *  running behind a view whose whole point is that it is not running. Here the
 *  canvas is never created.
 *
 *  Nothing else changes: `AppShell` still renders the rail beside this and
 *  still renders Library, Settings and the rest over it, because routed
 *  surfaces were always drawn into the content area rather than into the
 *  canvas. That is why this file is small — clicking Library already opened it
 *  "in the nova view field"; what was missing was a field that is not Nova.
 *
 *  THIS IS NOT THE DEFAULT AND MUST NOT BECOME IT. "The universe canvas IS the
 *  app, never a nav item or tab" is a standing decision; this is the plain
 *  alternative for when he wants to work rather than look.
 */
export function PlainChat() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const rootRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(() => window.innerWidth);
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768);

  // THE CONTENT AREA, NOT THE WINDOW — the same measurement Brain makes, and
  // for the same reason. Handed window.innerWidth, the chat laid itself out
  // 240px wider than the space it was in and every message ran under the rail
  // with its left edge clipped off. A ResizeObserver rather than a resize
  // listener, because the rail collapsing changes this width without the
  // window changing at all.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const measure = () => {
      setWidth(el.clientWidth || window.innerWidth);
      setIsMobile(window.innerWidth < 768);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // A routed surface is drawn OVER this by AppShell. Chat keeps rendering
  // underneath so its transcript, its in-flight turn and its websocket all
  // survive a trip to Library — the same reason Brain stays mounted.
  const covered = pathname !== '/' && pathname !== '/chat';

  return (
    <div ref={rootRef} className="absolute inset-0 overflow-hidden bg-stone-950"
         aria-hidden={covered || undefined}>
      <ChatPanel
        // The full content area. `mobile` is what makes ChatPanel full-bleed
        // with no docked-panel chrome, which is exactly the shape wanted here
        // — on a phone this shell and the default one already look the same.
        width={width}
        // Not resizable here: there is no second panel to take the space
        // from, so a drag handle would be a control with nothing to control.
        onWidthChange={() => {}}
        mobile={isMobile}
        settingsOpen={pathname.startsWith('/settings')}
        onShowBrain={() => navigate('/')}
      />
    </div>
  );
}
