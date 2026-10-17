// The signed-in app (FR-001, FR-002, FR-003, FR-004, FR-010, FR-015): sidebar, main area and a
// collapsible inspector; the four modes stay mounted so each keeps its state; global commands and
// their key bindings; live appearance; and the first-run redirect to onboarding. For chats it adds
// the side chat and branches panels (FR-026, FR-033), compare (/chat/<id>?compare=<id2>), find
// (FR-025) and temporary chats, which are deleted when left (FR-027). M4: each mode's main area
// is a pane layout (FR-005) with a bottom panel for terminals (FR-006), saved per mode; the
// Inspector's Files tab browses the chat's folders and opens files in editor and preview panes
// (FR-039).
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Button, EmptyState, Icon, IconButton, Menu, Tabs, type MenuItem } from '@nova/ui';
import {
  applyAppearance,
  resolveAppearance,
  toggledTheme,
  writeCachedTheme,
} from '../appearance.ts';
import { ActivityPanel } from '../chat/ActivityPanel.tsx';
import { ArtifactsPanel } from '../chat/Artifacts.tsx';
import { BranchesPanel } from '../chat/BranchesPanel.tsx';
import { ChatView, type ChatControls, type ChatPanel } from '../chat/ChatView.tsx';
import { CompareView } from '../chat/CompareView.tsx';
import { SideChat } from '../chat/SideChat.tsx';
import { useTemporaryChats } from '../chat/temporary.tsx';
import { CommandPalette, Picker, type PickerOption } from '../CommandPalette.tsx';
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
  useLocation,
  useRoute,
  type Mode,
} from '../router.ts';
import { deepLinkPath } from '../deeplinks.ts';
import { NotificationsBell } from '../notifications/Bell.tsx';
import { AppsView, ThreadApps } from '../apps/AppsView.tsx';
import { APPS_MOVED_EVENT } from '../apps/McpAppFrame.tsx';
import { CodeView } from '../code/CodeView.tsx';
import { WorkView } from '../work/WorkView.tsx';
import { LibraryView } from '../library/LibraryView.tsx';
import { PetOverlay } from '../pets/PetOverlay.tsx';
import { SitesView } from '../spaces/SitesView.tsx';
import { SpacesView } from '../spaces/SpacesView.tsx';
import { ProjectsView } from '../projects/ProjectsView.tsx';
import { useServices } from '../services.tsx';
import { useSettings } from '../settings.tsx';
import { SECTION_LABELS, SettingsView } from '../settings/SettingsView.tsx';
import { registerWorkspaceCommands } from '../workspace-commands.ts';
import { FileBrowser } from '../files/FileBrowser.tsx';
import {
  ADDABLE_KINDS,
  closePane,
  findPane,
  leaves,
  movePane,
  openInPane,
  setBottom,
  splitPane,
  toggleMaximize,
  updatePane,
  type AddableKind,
  type FileRef,
} from '../layout/model.ts';
import { KIND_LABEL, PaneContent, paneInfo } from '../layout/panes.tsx';
import { PaneWorkspace, resetKeepingBottom } from '../layout/PaneWorkspace.tsx';
import { useLayouts } from '../layout/useLayouts.ts';
import { useThreads } from '../stores.tsx';
import { TerminalPanel } from '../terminal/TerminalPanel.tsx';
import { MODE_INFO, Sidebar } from './Sidebar.tsx';

export interface WorkspaceProps {
  displayName: string | null;
  onDisplayName: (name: string | null) => void;
  onSignOut: () => void;
  announceEveryMs?: number;
}

const MODE_EMPTY: Record<'agents', { title: string; description: string }> = {
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
  const { api, registry } = useServices();
  const settings = useSettings();
  const route = useRoute();
  const location = useLocation();
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
  // Chat extras carried in the query string: a temporary new chat, and a compare partner.
  const query = new URLSearchParams(
    location.includes('?') ? location.slice(location.indexOf('?')) : '',
  );
  const newTemporary = !!chatRoute && chatRoute.threadId === null && query.get('temporary') === '1';
  const compareWith = chatRoute?.threadId ? query.get('compare') : null;
  const approvalLink = chatRoute?.threadId ? query.get('approval') : null;

  // ---- layout ------------------------------------------------------------------------------------
  const [sidebarToggle, setSidebarToggle] = useState<{ layout: string; open: boolean } | null>(
    null,
  );
  const sidebarOpen =
    sidebarToggle && sidebarToggle.layout === layout ? sidebarToggle.open : layout === 'wide';
  const [inspectorToggle, setInspectorToggle] = useState<{ fits: boolean; open: boolean } | null>(
    null,
  );
  // The inspector belongs to the modes; Settings and Setup use the full width. On phones it
  // only opens on request (a side chat or branches command) and then fills the screen.
  const inspectorOpen =
    mode !== null &&
    (inspectorToggle && inspectorToggle.fits === inspectorFits
      ? inspectorToggle.open
      : inspectorFits && layout !== 'phone');
  const [searchOpen, setSearchOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [inspectorTab, setInspectorTab] = useState('artifacts');
  const chatControls = useRef<ChatControls | null>(null);
  const [streamingThreadId, setStreamingThreadId] = useState<string | null>(null);
  // The side chat of the open chat; it is dropped when another chat opens (FR-026).
  const [side, setSide] = useState<{ parent: string; id: string } | null>(null);
  const sideId = side && side.parent === chatThreadId ? side.id : null;
  // The artifact open in the Artifacts panel, for the chat it belongs to (FR-038).
  const [artifact, setArtifact] = useState<{ thread: string | null; id: string } | null>(null);
  const artifactId = artifact && artifact.thread === chatThreadId ? artifact.id : null;
  const temporaryChats = useTemporaryChats(chatThreadId);
  const reportTemporary = temporaryChats.report;

  // ---- MCP Apps (FR-198): the chat's apps outlive the Inspector tab; "Open app…" lists the rest ---
  const [appsHost] = useState(() => {
    const el = document.createElement('div');
    el.className = 'apps-host';
    return el;
  });
  const appsPark = useRef<HTMLDivElement>(null);
  const parkApps = useCallback(() => {
    if (appsPark.current) moveApps(appsPark.current, appsHost);
  }, [appsHost]);
  // The apps start once the Apps tab is first opened, and then stay.
  const [appsUsed, setAppsUsed] = useState(false);
  if (inspectorTab === 'apps' && !appsUsed) setAppsUsed(true);
  const [appPicker, setAppPicker] = useState<PickerOption[] | null | 'closed'>('closed');
  const openAppPicker = useCallback(() => {
    setAppPicker(null);
    api.uiEntryPoints('global').then(
      ({ items }) =>
        setAppPicker((p) =>
          p === 'closed' ? p : items.map((e) => ({ id: e.id, label: e.title })),
        ),
      () => setAppPicker((p) => (p === 'closed' ? p : [])),
    );
  }, [api]);

  // ---- panes and the bottom panel (FR-005, FR-006) --------------------------------------------------
  const threads = useThreads();
  const { layouts, update: updateLayout } = useLayouts();
  /** The mode pane commands act on: the visible one, or the last one from Settings and pages. */
  const target: Mode = mode ?? lastMode;
  const [paneFocus, setPaneFocus] = useState<{ mode: Mode; id: string; n: number } | null>(null);
  const focusPane = useCallback(
    (m: Mode, id: string) => setPaneFocus((f) => ({ mode: m, id, n: (f?.n ?? 0) + 1 })),
    [],
  );
  const [terminalAsks, setTerminalAsks] = useState<{
    focus: Record<Mode, number>;
    create: Record<Mode, number>;
  }>({
    focus: { chat: 0, work: 0, code: 0, agents: 0 },
    create: { chat: 0, work: 0, code: 0, agents: 0 },
  });
  const askTerminal = useCallback(
    (m: Mode, kind: 'focus' | 'create') =>
      setTerminalAsks((t) => ({ ...t, [kind]: { ...t[kind], [m]: t[kind][m] + 1 } })),
    [],
  );
  /** Where focus goes back to when the bottom panel closes. */
  const returnFocus = useRef<HTMLElement | null>(null);
  const chatProjectId = chatThreadId
    ? (threads.threads.find((t) => t.id === chatThreadId)?.projectId ?? null)
    : null;

  const openFile = useCallback(
    (m: Mode, file: FileRef, where: 'editor' | 'preview') => {
      // Pane ids come from the layout, so the id computed now is the one the update creates.
      const paneId = openInPane(layouts[m], where, file).paneId;
      updateLayout(m, (l) => openInPane(l, where, file).layout);
      if (paneId) focusPane(m, paneId);
      if (layout === 'phone') setInspectorToggle({ fits: inspectorFits, open: false });
    },
    [focusPane, inspectorFits, layout, layouts, updateLayout],
  );

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
      reportTemporary(c);
    },
    [chatThreadId, reportTemporary],
  );

  // Opening a panel by command moves focus into it once it has rendered.
  const [panelFocus, setPanelFocus] = useState<{ panel: ChatPanel; n: number } | null>(null);
  const openPanel = useCallback(
    (panel: ChatPanel) => {
      setInspectorTab(panel);
      setInspectorToggle({ fits: inspectorFits, open: true });
      setPanelFocus((p) => ({ panel, n: (p?.n ?? 0) + 1 }));
    },
    [inspectorFits],
  );
  const openArtifact = useCallback(
    (id: string) => {
      setArtifact({ thread: chatThreadId, id });
      openPanel('artifacts');
    },
    [chatThreadId, openPanel],
  );
  useEffect(() => {
    if (!panelFocus) return;
    const find = () =>
      panelFocus.panel === 'side'
        ? document.getElementById('side-chat-input')
        : panelFocus.panel === 'artifacts'
          ? document.querySelector<HTMLElement>('#inspector .artifact-viewer-title')
          : document.querySelector<HTMLElement>('#inspector [role="tree"] [tabindex="0"]');
    const tab = () =>
      document.querySelector<HTMLElement>('#inspector [role="tab"][aria-selected="true"]');
    // An opened artifact or the file tree renders once it loads; wait briefly before settling on
    // the tab.
    let tries = panelFocus.panel === 'artifacts' || panelFocus.panel === 'files' ? 20 : 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const attempt = () => {
      const target = find();
      if (target) target.focus();
      else if (tries-- > 0) timer = setTimeout(attempt, 50);
      else tab()?.focus();
    };
    if (!find()) tab()?.focus();
    attempt();
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [panelFocus]);

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

  // ---- deep links (FR-007): /open?url=<link> replaces itself with the route the link names --------
  const openTarget = route.name === 'open' ? route.target : null;
  useEffect(() => {
    if (openTarget === null) return;
    navigate(deepLinkPath(openTarget) ?? '/chat', { replace: true });
  }, [openTarget]);

  // ---- approval links (FR-100): /approvals/<id> opens the chat that waits on it, at the card ----------
  const approvalOnly = /^\/approvals\/([^/?#]+)/.exec(location)?.[1] ?? null;
  useEffect(() => {
    if (!approvalOnly) return;
    let alive = true;
    const go = (path: string) => {
      if (alive) navigate(path, { replace: true });
    };
    let id: string;
    try {
      id = decodeURIComponent(approvalOnly);
    } catch {
      go('/chat');
      return;
    }
    api.getApproval(id).then(
      (v) =>
        go(v.threadId ? `${chatPath(v.threadId)}?approval=${encodeURIComponent(v.id)}` : '/chat'),
      () => go('/chat'),
    );
    return () => {
      alive = false;
    };
  }, [api, approvalOnly]);

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
  const newTemporaryChat = useCallback(() => {
    navigate('/chat?temporary=1');
    closeOverlaySidebar();
    queueMicrotask(() => chatControls.current?.focusComposer());
  }, [closeOverlaySidebar]);

  // Pane and panel actions; from Settings or a page they first return to the last mode.
  const enter = (): Mode => {
    if (mode === null) switchMode(target);
    return target;
  };
  const addPane = (m: Mode, kind: AddableKind | 'empty', direction: 'row' | 'column' = 'row') => {
    const l = layouts[m];
    const paneId = splitPane(l, l.active, direction, kind).paneId;
    updateLayout(m, (x) => splitPane(x, x.active, direction, kind).layout);
    if (paneId) focusPane(m, paneId);
  };
  const showPane = (m: Mode, kind: AddableKind) => {
    const existing = leaves(layouts[m].root).find((p) => p.kind === kind);
    if (!existing) return addPane(m, kind);
    updateLayout(m, (l) => ({
      ...l,
      active: existing.id,
      maximized: l.maximized && l.maximized !== existing.id ? null : l.maximized,
    }));
    focusPane(m, existing.id);
  };
  const restoreFocus = () => {
    const back = returnFocus.current;
    returnFocus.current = null;
    queueMicrotask(() => {
      if (back?.isConnected && !back.closest('[hidden]')) back.focus();
      else document.getElementById('main')?.focus();
    });
  };
  const openBottom = (m: Mode, ask: 'focus' | 'create') => {
    const el = document.activeElement;
    if (!el?.closest('.bottom-panel'))
      returnFocus.current = el instanceof HTMLElement && el !== document.body ? el : null;
    updateLayout(m, (l) => setBottom(l, { open: true }));
    askTerminal(m, ask);
  };
  const closeBottom = (m: Mode) => {
    const inside = !!document.activeElement?.closest('.bottom-panel');
    updateLayout(m, (l) => setBottom(l, { open: false }));
    if (inside) restoreFocus();
    else returnFocus.current = null;
  };
  const togglePanel = (m: Mode) => {
    if (layouts[m].bottom.open) closeBottom(m);
    else openBottom(m, 'focus');
  };
  const toggleTerminal = (m: Mode) => {
    const el = document.activeElement;
    if (el?.closest('.terminal-panel')) {
      // From a terminal the key leaves it: the bottom panel closes, a terminal pane hands back.
      if (el.closest('.bottom-panel')) closeBottom(m);
      else focusPane(m, 'main');
      return;
    }
    openBottom(m, 'focus');
  };
  const resetLayout = (m: Mode) => {
    updateLayout(m, resetKeepingBottom);
    focusPane(m, 'main');
  };
  const closeActive = (m: Mode) => {
    const l = layouts[m];
    const next = closePane(l, l.active);
    if (next === l) return;
    updateLayout(m, (x) => closePane(x, x.active));
    focusPane(m, next.active);
  };
  const layoutItems = (m: Mode): MenuItem[] => {
    const l = layouts[m];
    const many = leaves(l.root).length > 1;
    const active = findPane(l, l.active);
    return [
      { id: 'split-right', label: 'Split right', onSelect: () => addPane(m, 'empty', 'row') },
      { id: 'split-down', label: 'Split down', onSelect: () => addPane(m, 'empty', 'column') },
      ...ADDABLE_KINDS.map((k) => ({
        id: `add-${k}`,
        label: `Add ${KIND_LABEL[k].toLowerCase()} pane`,
        onSelect: () => addPane(m, k),
      })),
      ...(many
        ? [
            {
              id: 'maximize',
              label: l.maximized ? 'Restore pane sizes' : 'Maximize the active pane',
              onSelect: () => updateLayout(m, (x) => toggleMaximize(x, l.maximized ?? x.active)),
            },
            ...(active && active.kind !== 'main'
              ? [{ id: 'close', label: 'Close the active pane', onSelect: () => closeActive(m) }]
              : []),
          ]
        : []),
      { id: 'reset', label: 'Reset layout', onSelect: () => resetLayout(m) },
    ];
  };

  const noop = (): void => undefined;
  interface Actions {
    switchMode: (m: Mode) => void;
    newChat: () => void;
    newTemporaryChat: () => void;
    openPanel: (panel: ChatPanel) => void;
    toggleSidebar: () => void;
    openSearch: () => void;
    toggleTheme: () => void;
    toggleInspector: () => void;
    togglePanel: () => void;
    toggleTerminal: () => void;
    newTerminal: () => void;
    split: (direction: 'row' | 'column') => void;
    addPane: (kind: AddableKind) => void;
    showPane: (kind: AddableKind) => void;
    maximize: () => void;
    closePane: () => void;
    movePane: (by: -1 | 1) => void;
    resetLayout: () => void;
    openAppPicker: () => void;
  }
  const actions = useRef<Actions>({
    switchMode,
    newChat,
    newTemporaryChat,
    openPanel,
    toggleSidebar,
    openSearch: noop,
    toggleTheme: noop,
    toggleInspector: noop,
    togglePanel: noop,
    toggleTerminal: noop,
    newTerminal: noop,
    split: noop,
    addPane: noop,
    showPane: noop,
    maximize: noop,
    closePane: noop,
    movePane: noop,
    resetLayout: noop,
    openAppPicker: noop,
  });
  useEffect(() => {
    actions.current = {
      switchMode,
      newChat,
      newTemporaryChat,
      togglePanel: () => togglePanel(enter()),
      toggleTerminal: () => toggleTerminal(enter()),
      newTerminal: () => openBottom(enter(), 'create'),
      split: (direction) => addPane(enter(), 'empty', direction),
      addPane: (kind) => addPane(enter(), kind),
      showPane: (kind) => showPane(enter(), kind),
      maximize: () => {
        const m = enter();
        updateLayout(m, (l) => toggleMaximize(l, l.maximized ?? l.active));
      },
      closePane: () => closeActive(enter()),
      movePane: (by) => {
        const m = enter();
        updateLayout(m, (l) => movePane(l, l.active, by));
      },
      resetLayout: () => resetLayout(enter()),
      openAppPicker,
      openPanel: (panel) => {
        if (mode !== 'chat' && panel !== 'files') switchMode('chat');
        else if (mode === null) switchMode(target);
        openPanel(panel);
      },
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
      {
        id: 'chat.newTemporary',
        title: 'New temporary chat',
        category: 'Chat',
        run: () => a().newTemporaryChat(),
      },
      { id: 'chat.search', title: 'Search chats', category: 'Chat', run: () => a().openSearch() },
      {
        id: 'chat.find',
        title: 'Find in chat',
        category: 'Chat',
        binding: 'mod+f',
        when: 'mode == chat',
        run: () => chatControls.current?.openFind(),
      },
      {
        id: 'chat.sideChat',
        title: 'Ask in a side chat',
        category: 'Chat',
        run: () => a().openPanel('side'),
      },
      {
        id: 'chat.branches',
        title: 'Show branches',
        category: 'Chat',
        run: () => a().openPanel('branches'),
      },
      {
        id: 'chat.artifacts',
        title: 'Show artifacts',
        category: 'Chat',
        run: () => a().openPanel('artifacts'),
      },
      {
        id: 'chat.activity',
        title: 'Show activity',
        category: 'Chat',
        run: () => a().openPanel('activity'),
      },
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
      {
        id: 'apps.open',
        title: 'Open app…',
        category: 'Apps',
        run: () => a().openAppPicker(),
      },
      {
        id: 'library.open',
        title: 'Go to Library',
        category: 'Navigation',
        run: () => navigate('/library'),
      },
      {
        id: 'files.show',
        title: 'Show files',
        category: 'Files',
        run: () => a().openPanel('files'),
      },
      {
        id: 'panel.toggle',
        title: 'Toggle bottom panel',
        category: 'View',
        binding: 'mod+j',
        run: () => a().togglePanel(),
      },
      {
        id: 'terminal.toggle',
        title: 'Toggle terminal',
        category: 'Terminal',
        binding: 'ctrl+`',
        run: () => a().toggleTerminal(),
      },
      {
        id: 'terminal.new',
        title: 'New terminal',
        category: 'Terminal',
        run: () => a().newTerminal(),
      },
      {
        id: 'pane.splitRight',
        title: 'Split pane right',
        category: 'Layout',
        run: () => a().split('row'),
      },
      {
        id: 'pane.splitDown',
        title: 'Split pane down',
        category: 'Layout',
        run: () => a().split('column'),
      },
      ...(['editor', 'preview', 'terminal'] as const).map((k) => ({
        id: `pane.add.${k}`,
        title: `Add ${KIND_LABEL[k].toLowerCase()} pane`,
        category: 'Layout',
        run: () => a().addPane(k),
      })),
      {
        id: 'pane.diff',
        title: 'Show the diff pane',
        category: 'Layout',
        binding: 'mod+shift+d',
        run: () => a().showPane('diff'),
      },
      {
        id: 'pane.browser',
        title: 'Show the browser pane',
        category: 'Layout',
        binding: 'mod+shift+b',
        run: () => a().showPane('browser'),
      },
      {
        id: 'pane.maximize',
        title: 'Maximize or restore the active pane',
        category: 'Layout',
        run: () => a().maximize(),
      },
      {
        id: 'pane.close',
        title: 'Close the active pane',
        category: 'Layout',
        run: () => a().closePane(),
      },
      {
        id: 'pane.moveEarlier',
        title: 'Move the active pane earlier',
        category: 'Layout',
        run: () => a().movePane(-1),
      },
      {
        id: 'pane.moveLater',
        title: 'Move the active pane later',
        category: 'Layout',
        run: () => a().movePane(1),
      },
      {
        id: 'layout.reset',
        title: 'Reset layout',
        category: 'Layout',
        run: () => a().resetLayout(),
      },
    ];
    const offs = commands.map((c) => registry.register(c));
    const offWorkspace = registerWorkspaceCommands(registry);
    return () => {
      offs.forEach((off) => off());
      offWorkspace();
    };
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
  const panelKeys = registry.primaryBinding('panel.toggle');
  const workspaceFor = (m: Mode, main: ReactNode) => (
    <PaneWorkspace
      label={`${MODE_INFO[m].label} workspace`}
      layout={layouts[m]}
      onChange={(fn) => updateLayout(m, fn)}
      visible={visibleMode === m}
      phone={layout === 'phone'}
      info={(p) => paneInfo(p, { title: MODE_INFO[m].label, icon: MODE_INFO[m].icon })}
      renderPane={(pane, shown) => (
        <PaneContent
          pane={pane}
          shown={shown}
          viewKey={`${m}:${pane.id}`}
          main={main}
          threadId={m === 'chat' ? chatThreadId : null}
          mac={mac}
          onChoose={(kind) => {
            updateLayout(m, (l) => updatePane(l, pane.id, { kind }));
            focusPane(m, pane.id);
          }}
          onOpenFile={(f, where) => openFile(m, f, where)}
        />
      )}
      renderBottom={(shown) => (
        <TerminalPanel
          viewKey={`bottom:${m}`}
          visible={shown}
          threadId={m === 'chat' ? chatThreadId : null}
          focusSignal={terminalAsks.focus[m]}
          newSignal={terminalAsks.create[m]}
        />
      )}
      focus={paneFocus?.mode === m ? { id: paneFocus.id, n: paneFocus.n } : null}
      onCreated={(id) => focusPane(m, id)}
    />
  );
  const phoneMenu = layout === 'phone' && sidebarOpen;
  const title =
    route.name === 'settings'
      ? 'Settings'
      : route.name === 'onboarding'
        ? 'Setup'
        : route.name === 'projects'
          ? 'Projects'
          : route.name === 'library'
            ? 'Library'
            : route.name === 'spaces'
              ? 'Spaces'
              : route.name === 'sites'
                ? 'Sites'
                : route.name === 'apps'
                  ? 'Apps'
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
        <NotificationsBell />
        {mode !== null ? (
          <>
            <IconButton
              label="Toggle bottom panel"
              icon={<Icon name="panel" />}
              variant="ghost"
              aria-expanded={layouts[mode].bottom.open}
              aria-keyshortcuts={panelKeys ? ariaKeyShortcut(panelKeys, mac) : undefined}
              onClick={() => togglePanel(mode)}
            />
            <Menu label="Layout" trigger={<Icon name="split-right" />} items={layoutItems(mode)} />
          </>
        ) : null}
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
            {workspaceFor(
              'chat',
              <>
                {compareWith && chatThreadId ? (
                  <CompareView leftId={chatThreadId} rightId={compareWith} />
                ) : null}
                <div className="chat-pane" hidden={!!compareWith}>
                  <ChatView
                    key={chatThreadId ?? (newTemporary ? 'new-temporary' : 'new')}
                    threadId={chatThreadId}
                    messageId={chatRoute?.messageId ?? null}
                    active={visibleMode === 'chat' && !compareWith}
                    temporary={newTemporary}
                    announceEveryMs={announceEveryMs}
                    onControls={onControls}
                    onOpenPanel={openPanel}
                    approvalId={chatRoute?.threadId ? approvalLink : null}
                    onOpenArtifact={openArtifact}
                  />
                </div>
              </>,
            )}
          </div>
          {(['work', 'code', 'agents'] as const).map((m) => (
            <div key={m} className="mode-pane" hidden={visibleMode !== m} data-mode={m}>
              {workspaceFor(
                m,
                m === 'work' ? (
                  <WorkView id={route.name === 'mode' && route.mode === 'work' ? route.id : null} />
                ) : m === 'code' ? (
                  <CodeView id={route.name === 'mode' && route.mode === 'code' ? route.id : null} />
                ) : (
                  <EmptyState
                    title={MODE_EMPTY[m].title}
                    description={MODE_EMPTY[m].description}
                    icon={MODE_INFO[m].icon}
                    level={2}
                    action={<Button onClick={() => switchMode('chat')}>Go to Chat</Button>}
                  />
                ),
              )}
            </div>
          ))}
          {route.name === 'settings' ? (
            <SettingsView
              section={route.section}
              displayName={displayName}
              onDisplayName={onDisplayName}
            />
          ) : null}
          {route.name === 'projects' ? <ProjectsView projectId={route.projectId} /> : null}
          {route.name === 'library' ? <LibraryView /> : null}
          {route.name === 'spaces' ? (
            <SpacesView spaceId={route.spaceId} pageId={route.pageId} />
          ) : null}
          {route.name === 'sites' ? <SitesView siteId={route.siteId} /> : null}
          {route.name === 'apps' ? <AppsView entryId={route.entryId} /> : null}
          {route.name === 'onboarding' ? (
            <Onboarding displayName={displayName} onDisplayName={onDisplayName} />
          ) : null}
        </main>
        <aside id="inspector" className="inspector" aria-label="Inspector" hidden={!inspectorOpen}>
          {layout === 'phone' ? (
            <Button
              className="inspector-close"
              onClick={() => setInspectorToggle({ fits: inspectorFits, open: false })}
            >
              <Icon name="close" /> Close panel
            </Button>
          ) : null}
          <Tabs
            label="Inspector"
            value={inspectorTab}
            onChange={setInspectorTab}
            items={[
              {
                id: 'artifacts',
                label: 'Artifacts',
                panel: (
                  <ArtifactsPanel
                    key={chatThreadId ?? 'none'}
                    threadId={chatThreadId}
                    selectedId={artifactId}
                    onSelect={(id) => setArtifact(id ? { thread: chatThreadId, id } : null)}
                  />
                ),
              },
              {
                id: 'files',
                label: 'Files',
                panel: (
                  <FileBrowser
                    key={`${target}:${target === 'chat' ? (chatThreadId ?? 'none') : ''}`}
                    threadId={target === 'chat' ? chatThreadId : null}
                    projectId={target === 'chat' ? chatProjectId : null}
                    onOpen={(f, where) => openFile(target, f, where)}
                  />
                ),
              },
              { id: 'sources', label: 'Sources', panel: <InspectorEmpty what="Sources" /> },
              {
                id: 'activity',
                label: 'Activity',
                panel: <ActivityPanel key={chatThreadId ?? 'none'} threadId={chatThreadId} />,
              },
              {
                id: 'side',
                label: 'Side chat',
                panel: (
                  <SideChat
                    key={chatThreadId ?? 'none'}
                    parentId={chatThreadId}
                    sideId={sideId}
                    onSideId={(id) => {
                      if (chatThreadId) setSide({ parent: chatThreadId, id });
                    }}
                  />
                ),
              },
              {
                id: 'branches',
                label: 'Branches',
                panel: <BranchesPanel threadId={chatThreadId} />,
              },
              {
                id: 'apps',
                label: 'Apps',
                panel: <AppsSlot host={appsHost} onLeave={parkApps} shown={inspectorOpen} />,
              },
            ]}
          />
        </aside>
      </div>
      <CommandPalette
        registry={registry}
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
      />
      {temporaryChats.dialog}
      {appPicker !== 'closed' ? (
        <Picker
          label="Open app"
          placeholder="Search apps"
          options={appPicker}
          empty="No apps yet. Plugins and MCP servers can add them."
          onPick={(id) => navigate(`/apps/${encodeURIComponent(id)}`)}
          onClose={() => setAppPicker('closed')}
        />
      ) : null}
      {/* The open chat's apps live here, so switching Inspector tabs never closes them: the Apps
          tab shows them, and otherwise they wait out of sight while a picture-in-picture app
          stays on screen (FR-198). */}
      <div ref={appsPark} className="apps-park" />
      {appsUsed ? createPortal(<ThreadApps threadId={chatThreadId} />, appsHost) : null}
      <PetOverlay />
    </div>
  );
}

/** Shows the chat's apps in the Apps tab; when the tab or the Inspector closes they go back to the
 *  park, still running. */
function AppsSlot({
  host,
  onLeave,
  shown,
}: {
  host: HTMLElement;
  onLeave: () => void;
  shown: boolean;
}) {
  const slot = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = slot.current;
    if (!shown || !el) return;
    moveApps(el, host);
    return onLeave;
  }, [host, onLeave, shown]);
  return <div ref={slot} className="apps-slot" />;
}

/**
 * Move the apps host without reloading its frames where the browser can (`moveBefore`); elsewhere
 * a moved frame reloads, so the frames are told first and restart their app cleanly.
 */
function moveApps(target: HTMLElement, host: HTMLElement): void {
  if (host.parentElement === target) return;
  if (host.isConnected && target.isConnected && 'moveBefore' in target) {
    try {
      target.moveBefore(host, null);
      return;
    } catch {
      // Not movable here (another document or root): move it the old way.
    }
  }
  if (host.isConnected) host.dispatchEvent(new Event(APPS_MOVED_EVENT));
  target.appendChild(host);
}

function InspectorEmpty({ what }: { what: string }) {
  return <p className="muted">{what} for the open item appear here in a later milestone.</p>;
}
