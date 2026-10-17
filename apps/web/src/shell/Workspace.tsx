// The signed-in app (FR-001, FR-002, FR-003, FR-004, FR-010, FR-015): sidebar, main area and a
// collapsible inspector; the four modes stay mounted so each keeps its state; global commands and
// their key bindings; live appearance; and the first-run redirect to onboarding.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Button, EmptyState, Icon, IconButton, Menu, Tabs } from '@nova/ui';
import {
  applyAppearance,
  resolveAppearance,
  toggledTheme,
  writeCachedTheme,
} from '../appearance.ts';
import { ChatView, type ChatControls } from '../chat/ChatView.tsx';
import { CommandPalette } from '../CommandPalette.tsx';
import type { Command } from '../commands.ts';
import { isEditable, useLayout, useMediaQuery } from '../hooks.ts';
import { ariaKeyShortcut, eventToBinding, typesCharacter, type WhenContext } from '../keys.ts';
import { Onboarding } from '../onboarding/Onboarding.tsx';
import {
  MODES,
  SETTINGS_SECTIONS,
  chatPath,
  navigate,
  routeMode,
  useRoute,
  type Mode,
} from '../router.ts';
import { useServices } from '../services.tsx';
import { useSettings } from '../settings.tsx';
import { SECTION_LABELS, SettingsView } from '../settings/SettingsView.tsx';
import { MODE_INFO, Sidebar } from './Sidebar.tsx';

export interface WorkspaceProps {
  displayName: string | null;
  onDisplayName: (name: string | null) => void;
  onSignOut: () => void;
  announceEveryMs?: number;
}

const MODE_EMPTY: Record<Exclude<Mode, 'chat'>, { title: string; description: string }> = {
  work: {
    title: 'Work runs arrive in a later milestone',
    description:
      'Work mode will delegate multi-step tasks with a plan, budgets and approvals. Until then, use Chat.',
  },
  code: {
    title: 'Code sessions arrive in a later milestone',
    description:
      'Code mode will pair a coding agent with diffs, a terminal and a browser. Until then, use Chat.',
  },
  agents: {
    title: 'Always-on agents arrive in a later milestone',
    description:
      'Agents mode will run agents with goals, schedules and channels. Until then, use Chat.',
  },
};

export function Workspace({
  displayName,
  onDisplayName,
  onSignOut,
  announceEveryMs,
}: WorkspaceProps) {
  const { registry } = useServices();
  const settings = useSettings();
  const route = useRoute();
  const { layout, inspectorFits } = useLayout();
  const prefersDark = useMediaQuery('(prefers-color-scheme: dark)', true);
  useSyncExternalStore(
    (fn) => registry.subscribe(fn),
    () => registry.version(),
  );

  // ---- per-mode memory -------------------------------------------------------------------------
  const mode = routeMode(route);
  const [lastChatPath, setLastChatPath] = useState('/chat');
  const [lastMode, setLastMode] = useState<Mode>('chat');
  const chatRoute = route.name === 'chat' ? route : null;
  const currentChatPath = chatRoute ? chatPath(chatRoute.threadId) : null;
  if (currentChatPath && currentChatPath !== lastChatPath) setLastChatPath(currentChatPath);
  if (mode && mode !== lastMode) setLastMode(mode);
  const chatThreadId = chatRoute
    ? chatRoute.threadId
    : lastChatPath === '/chat'
      ? null
      : decodeURIComponent(lastChatPath.slice('/chat/'.length));
  const visibleMode: Mode | null = mode;

  // ---- layout ------------------------------------------------------------------------------------
  const [sidebarToggle, setSidebarToggle] = useState<{ layout: string; open: boolean } | null>(
    null,
  );
  const sidebarOpen =
    sidebarToggle && sidebarToggle.layout === layout ? sidebarToggle.open : layout === 'wide';
  const [inspectorToggle, setInspectorToggle] = useState<{ fits: boolean; open: boolean } | null>(
    null,
  );
  // The inspector belongs to the modes; Settings and Setup use the full width.
  const inspectorOpen =
    layout !== 'phone' &&
    mode !== null &&
    (inspectorToggle && inspectorToggle.fits === inspectorFits
      ? inspectorToggle.open
      : inspectorFits);
  const [searchOpen, setSearchOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [inspectorTab, setInspectorTab] = useState('artifacts');
  const chatControls = useRef<ChatControls | null>(null);
  const [streamingThreadId, setStreamingThreadId] = useState<string | null>(null);

  const toggleSidebar = useCallback(
    () => setSidebarToggle({ layout, open: !sidebarOpen }),
    [layout, sidebarOpen],
  );
  const closeOverlaySidebar = useCallback(() => {
    if (layout !== 'wide') setSidebarToggle({ layout, open: false });
  }, [layout]);

  const onControls = useCallback(
    (c: ChatControls | null) => {
      chatControls.current = c;
      setStreamingThreadId(c?.streaming ? chatThreadId : null);
    },
    [chatThreadId],
  );

  // ---- appearance (FR-010) ---------------------------------------------------------------------
  const appearance = {
    theme: settings.get('appearance.theme').value,
    accent: settings.get('appearance.accent').value,
    background: settings.get('appearance.background').value,
    foreground: settings.get('appearance.foreground').value,
    uiFont: settings.get('appearance.uiFont').value,
    codeFont: settings.get('appearance.codeFont').value,
    fontScale: settings.get('appearance.fontScale').value,
    reducedMotion: settings.get('appearance.reducedMotion').value,
  };
  // A string key, because the object changes identity on every render.
  const appearanceKey = JSON.stringify(appearance);
  useEffect(() => {
    const a = JSON.parse(appearanceKey) as typeof appearance;
    applyAppearance(resolveAppearance(a, prefersDark), document.documentElement);
    writeCachedTheme(a.theme);
  }, [appearanceKey, prefersDark]);

  // ---- user key bindings (FR-004) -----------------------------------------------------------------
  const userBindings = settings.get('keyboard.bindings').value;
  useEffect(() => {
    registry.setUserBindings(userBindings);
  }, [registry, userBindings]);

  // ---- onboarding redirect (FR-014) ----------------------------------------------------------------
  const onboarding = settings.get('onboarding.state').value;
  const redirected = useRef(false);
  useEffect(() => {
    if (redirected.current) return;
    redirected.current = true;
    if (!onboarding.completed && !onboarding.skipped && route.name !== 'onboarding')
      navigate('/onboarding', { replace: true });
  }, [onboarding.completed, onboarding.skipped, route.name]);

  // ---- commands (FR-003) ---------------------------------------------------------------------------
  const switchMode = useCallback(
    (m: Mode) => {
      if (m === 'chat') navigate(lastChatPath);
      else navigate(`/${m}`);
    },
    [lastChatPath],
  );
  const newChat = useCallback(() => {
    navigate(chatPath(null));
    closeOverlaySidebar();
    queueMicrotask(() => chatControls.current?.focusComposer());
  }, [closeOverlaySidebar]);

  const noop = (): void => undefined;
  const actions = useRef<{
    switchMode: (m: Mode) => void;
    newChat: () => void;
    toggleSidebar: () => void;
    openSearch: () => void;
    toggleTheme: () => void;
    toggleInspector: () => void;
  }>({
    switchMode,
    newChat,
    toggleSidebar,
    openSearch: noop,
    toggleTheme: noop,
    toggleInspector: noop,
  });
  useEffect(() => {
    actions.current = {
      switchMode,
      newChat,
      toggleSidebar,
      openSearch: () => {
        setSearchOpen(true);
        setSidebarToggle({ layout, open: true });
      },
      toggleTheme: () => {
        const next = toggledTheme(appearance.theme, prefersDark);
        settings.set('appearance.theme', next).catch(() => undefined);
      },
      toggleInspector: () => setInspectorToggle({ fits: inspectorFits, open: !inspectorOpen }),
    };
  });

  useEffect(() => {
    const a = () => actions.current;
    const commands: Command[] = [
      {
        id: 'palette.open',
        title: 'Show command palette',
        category: 'General',
        binding: ['mod+k', 'mod+shift+p'],
        run: () => setPaletteOpen((o) => !o),
      },
      {
        id: 'chat.new',
        title: 'New chat',
        category: 'Chat',
        binding: 'mod+n',
        run: () => a().newChat(),
      },
      { id: 'chat.search', title: 'Search chats', category: 'Chat', run: () => a().openSearch() },
      {
        id: 'chat.stop',
        title: 'Stop generation',
        category: 'Chat',
        binding: 'escape',
        when: 'streaming',
        run: () => chatControls.current?.stop(),
      },
      {
        id: 'chat.focusComposer',
        title: 'Focus the message box',
        category: 'Chat',
        when: 'mode == chat',
        run: () => chatControls.current?.focusComposer(),
      },
      ...MODES.map((m, i) => ({
        id: MODE_INFO[m].command,
        title: `Switch to ${MODE_INFO[m].label}`,
        category: 'Modes',
        binding: `mod+${i + 1}`,
        run: () => a().switchMode(m),
      })),
      {
        id: 'settings.open',
        title: 'Open settings',
        category: 'Settings',
        binding: 'mod+,',
        run: () => navigate('/settings/general'),
      },
      ...SETTINGS_SECTIONS.map((s) => ({
        id: `settings.${s}`,
        title: `Open ${SECTION_LABELS[s]} settings`,
        category: 'Settings',
        run: () => navigate(`/settings/${s}`),
      })),
      {
        id: 'view.toggleTheme',
        title: 'Toggle light and dark theme',
        category: 'View',
        run: () => a().toggleTheme(),
      },
      {
        id: 'view.toggleSidebar',
        title: 'Toggle sidebar',
        category: 'View',
        binding: 'mod+b',
        run: () => a().toggleSidebar(),
      },
      {
        id: 'view.toggleInspector',
        title: 'Toggle inspector',
        category: 'View',
        run: () => a().toggleInspector(),
      },
      {
        id: 'nav.back',
        title: 'Go back',
        category: 'Navigation',
        binding: 'mod+[',
        run: () => history.back(),
      },
      {
        id: 'nav.forward',
        title: 'Go forward',
        category: 'Navigation',
        binding: 'mod+]',
        run: () => history.forward(),
      },
      {
        id: 'onboarding.open',
        title: 'Open the setup guide',
        category: 'General',
        run: () => navigate('/onboarding'),
      },
    ];
    const offs = commands.map((c) => registry.register(c));
    return () => offs.forEach((off) => off());
  }, [registry]);

  // ---- global key handler (FR-004) -----------------------------------------------------------------
  const ctxRef = useRef<() => WhenContext>(() => ({}));
  useEffect(() => {
    ctxRef.current = () => {
      const active = document.activeElement;
      return {
        mode: mode ?? (route.name === 'settings' ? 'settings' : route.name),
        streaming: route.name === 'chat' && (chatControls.current?.streaming ?? false),
        dialogOpen: document.querySelector('[aria-modal="true"]') !== null,
        inputFocus: isEditable(active),
        chatFocus: !!active?.closest('[data-chat-view]'),
        composerFocus: active?.id === 'composer-input',
      };
    };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const ctx = ctxRef.current();
      const cmd = registry.match(e, ctx);
      if (!cmd) return;
      // While a dialog is open only the palette toggle passes; the dialog owns the keyboard.
      if (ctx.dialogOpen && cmd.id !== 'palette.open') return;
      // A key that types a character belongs to the focused text field, not to a command.
      const combo = eventToBinding(e, registry.platform.mac);
      if (combo && typesCharacter(combo) && ctx.inputFocus) return;
      e.preventDefault();
      cmd.run();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [registry]);

  // ---- render --------------------------------------------------------------------------------------
  const mac = registry.platform.mac;
  const paletteKeys = registry.primaryBinding('palette.open');
  const sidebarKeys = registry.primaryBinding('view.toggleSidebar');
  const phoneMenu = layout === 'phone' && sidebarOpen;
  const title =
    route.name === 'settings'
      ? 'Settings'
      : route.name === 'onboarding'
        ? 'Setup'
        : MODE_INFO[mode ?? lastMode].label;

  return (
    <div
      className="app"
      data-layout={layout}
      data-sidebar={sidebarOpen ? 'open' : 'closed'}
      data-inspector={inspectorOpen ? 'open' : 'closed'}
    >
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <IconButton
          label={layout === 'phone' ? (sidebarOpen ? 'Close menu' : 'Open menu') : 'Toggle sidebar'}
          icon={<Icon name={layout === 'phone' ? (sidebarOpen ? 'close' : 'menu') : 'sidebar'} />}
          variant="ghost"
          aria-expanded={sidebarOpen}
          aria-controls="sidebar"
          aria-keyshortcuts={sidebarKeys ? ariaKeyShortcut(sidebarKeys, mac) : undefined}
          onClick={toggleSidebar}
        />
        <span className="brand">Nova</span>
        <span className="topbar-title">{title}</span>
        <span className="topbar-spacer" />
        <Button
          variant="ghost"
          onClick={() => setPaletteOpen(true)}
          aria-keyshortcuts={paletteKeys ? ariaKeyShortcut(paletteKeys, mac) : undefined}
        >
          Commands
        </Button>
        {layout !== 'phone' && mode !== null ? (
          <IconButton
            label="Toggle inspector"
            icon={<Icon name="inspector" />}
            variant="ghost"
            aria-expanded={inspectorOpen}
            aria-controls="inspector"
            onClick={() => setInspectorToggle({ fits: inspectorFits, open: !inspectorOpen })}
          />
        ) : null}
        <Menu
          label={displayName ? `Account: ${displayName}` : 'Account'}
          trigger={
            <span className="account-initial">
              {(displayName ?? 'N').slice(0, 1).toUpperCase()}
            </span>
          }
          items={[
            { id: 'settings', label: 'Settings', onSelect: () => navigate('/settings/general') },
            { id: 'setup', label: 'Setup guide', onSelect: () => navigate('/onboarding') },
            { id: 'signout', label: 'Sign out', onSelect: onSignOut },
          ]}
        />
      </header>
      <div className="body">
        <Sidebar
          id="sidebar"
          hidden={!sidebarOpen}
          mode={mode}
          selectedThreadId={chatThreadId}
          streamingThreadId={streamingThreadId}
          settingsOpen={route.name === 'settings'}
          searchOpen={searchOpen}
          onSearchOpen={setSearchOpen}
          onNewChat={newChat}
          onSwitchMode={switchMode}
          onNavigated={closeOverlaySidebar}
        />
        <main id="main" className="main" tabIndex={-1} hidden={phoneMenu}>
          <div className="mode-pane" hidden={visibleMode !== 'chat'} data-mode="chat">
            <ChatView
              key={chatThreadId ?? 'new'}
              threadId={chatThreadId}
              messageId={chatRoute?.messageId ?? null}
              active={visibleMode === 'chat'}
              announceEveryMs={announceEveryMs}
              onControls={onControls}
            />
          </div>
          {(['work', 'code', 'agents'] as const).map((m) => (
            <div key={m} className="mode-pane" hidden={visibleMode !== m} data-mode={m}>
              <EmptyState
                title={MODE_EMPTY[m].title}
                description={MODE_EMPTY[m].description}
                icon={MODE_INFO[m].icon}
                level={2}
                action={<Button onClick={() => switchMode('chat')}>Go to Chat</Button>}
              />
            </div>
          ))}
          {route.name === 'settings' ? (
            <SettingsView
              section={route.section}
              displayName={displayName}
              onDisplayName={onDisplayName}
            />
          ) : null}
          {route.name === 'onboarding' ? (
            <Onboarding displayName={displayName} onDisplayName={onDisplayName} />
          ) : null}
        </main>
        <aside id="inspector" className="inspector" aria-label="Inspector" hidden={!inspectorOpen}>
          <Tabs
            label="Inspector"
            value={inspectorTab}
            onChange={setInspectorTab}
            items={[
              { id: 'artifacts', label: 'Artifacts', panel: <InspectorEmpty what="Artifacts" /> },
              { id: 'files', label: 'Files', panel: <InspectorEmpty what="Files" /> },
              { id: 'sources', label: 'Sources', panel: <InspectorEmpty what="Sources" /> },
            ]}
          />
        </aside>
      </div>
      <CommandPalette
        registry={registry}
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
      />
    </div>
  );
}

function InspectorEmpty({ what }: { what: string }) {
  return <p className="muted">{what} for the open item appear here in a later milestone.</p>;
}
