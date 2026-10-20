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
import { Button, Icon, IconButton, Menu, Tabs, type MenuItem } from '@nova/ui';
import { toggledTheme } from '../appearance.ts';
import { setLookByHand, useApplyAppearance } from '../use-appearance.ts';
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
import { AppsView, SHOW_APPS_COMMAND, ThreadApps } from '../apps/AppsView.tsx';
import { ExtensionStatusBar, useExtensionShell } from '../extensions/shell.tsx';
import { MarketplacePage } from '../market/MarketplacePage.tsx';
import { AuthorizePage } from '../appauth/AuthorizePage.tsx';
import { APPS_MOVED_EVENT } from '../apps/McpAppFrame.tsx';
import { CodeView } from '../code/CodeView.tsx';
import { WorkView } from '../work/WorkView.tsx';
import { AgentsView } from '../agents/AgentsView.tsx';
import { BrowserPanel } from '../browser/BrowserPanel.tsx';
import { ComputersView } from '../computers/ComputersView.tsx';
import { computerPath } from '../computers/format.ts';
import { DevicesView } from '../devices/DevicesView.tsx';
import { NetworkSurface } from '../netsurface/NetworkSurface.tsx';
import { OfflineBanner } from '../offline/OfflineBanner.tsx';
import { ApprovalsPage } from '../dispatch/ApprovalsPage.tsx';
import { TeamSurface } from '../team/TeamSurface.tsx';
import { MemberGate } from '../team/role.tsx';
import { connectionMenuItem, useHubPath } from '../relaytransport/path.ts';
import { useShellCommands } from '../shellbridge/OpenInWindow.tsx';
import { ControlIndicator } from '../screen/ControlIndicator.tsx';
import { ScreenPanel } from '../screen/ScreenPanel.tsx';
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
import { PaneContent, paneInfo } from '../layout/panes.tsx';
import { PaneWorkspace, resetKeepingBottom } from '../layout/PaneWorkspace.tsx';
import { useLayouts } from '../layout/useLayouts.ts';
import { useThreads } from '../stores.tsx';
import { TerminalPanel } from '../terminal/TerminalPanel.tsx';
import { MODE_INFO, Sidebar } from './Sidebar.tsx';
import { messageFor } from '@nova/i18n';
import { CATEGORY } from '../commands.ts';
import { COMMAND_TEXT, MODE_TEXT, SHELL_TEXT } from './strings.ts';

export interface WorkspaceProps {
  displayName: string | null;
  onDisplayName: (name: string | null) => void;
  onSignOut: () => void;
  announceEveryMs?: number;
}

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

  // ---- appearance (FR-010, FR-011: a saved theme applies token for token) -------------------------
  const appearance = useApplyAppearance(prefersDark);

  // ---- user key bindings (FR-004) -----------------------------------------------------------------
  const userBindings = settings.get('keyboard.bindings').value;
  useEffect(() => {
    registry.setUserBindings(userBindings);
  }, [registry, userBindings]);

  // ---- onboarding redirect (FR-014) ----------------------------------------------------------------
  const onboarding = settings.get('onboarding.state').value;
  const redirected = useRef(false);
  // Restoring an export instead of setting up (onboarding's first screen links to Settings →
  // Data): the import restarts the Hub and the imported settings decide whether setup is done.
  const restoring = route.name === 'settings' && route.section === 'data';
  useEffect(() => {
    if (redirected.current) return;
    redirected.current = true;
    // An app's consent request (/authorize) survives a fresh Hub: setup can wait (FR-222).
    if (
      !onboarding.completed &&
      !onboarding.skipped &&
      route.name !== 'onboarding' &&
      route.name !== 'authorize' &&
      !restoring
    )
      navigate('/onboarding', { replace: true });
  }, [onboarding.completed, onboarding.skipped, route.name, restoring]);

  // ---- deep links (FR-007): /open?url=<link> replaces itself with the route the link names --------
  const openTarget = route.name === 'open' ? route.target : null;
  useEffect(() => {
    if (openTarget === null) return;
    navigate(deepLinkPath(openTarget) ?? '/chat', { replace: true });
  }, [openTarget]);

  // How this device reaches the Hub (FR-137) and the desktop app's commands (FR-009), M7.
  const hubPath = useHubPath();
  useShellCommands();
  // Extension commands, menus, status items, themes and shortcuts (FR-117, M8).
  useExtensionShell();

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
    // Without a thread (or when it cannot be read) the approvals page shows it first (M7).
    const focus = `/approvals?focus=${encodeURIComponent(id)}`;
    api.getApproval(id).then(
      (v) =>
        go(v.threadId ? `${chatPath(v.threadId)}?approval=${encodeURIComponent(v.id)}` : focus),
      () => go(focus),
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
      {
        id: 'split-right',
        label: SHELL_TEXT.pane.splitRight,
        onSelect: () => addPane(m, 'empty', 'row'),
      },
      {
        id: 'split-down',
        label: SHELL_TEXT.pane.splitDown,
        onSelect: () => addPane(m, 'empty', 'column'),
      },
      ...ADDABLE_KINDS.map((k) => ({
        id: `add-${k}`,
        label: SHELL_TEXT.pane.add({ kind: k }),
        onSelect: () => addPane(m, k),
      })),
      ...(many
        ? [
            {
              id: 'maximize',
              label: l.maximized ? SHELL_TEXT.pane.restore : SHELL_TEXT.pane.maximize,
              onSelect: () => updateLayout(m, (x) => toggleMaximize(x, l.maximized ?? x.active)),
            },
            ...(active && active.kind !== 'main'
              ? [{ id: 'close', label: SHELL_TEXT.pane.close, onSelect: () => closeActive(m) }]
              : []),
          ]
        : []),
      { id: 'reset', label: SHELL_TEXT.pane.reset, onSelect: () => resetLayout(m) },
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
        // A theme toggled by hand stops a saved theme (docs/14 §2.2).
        setLookByHand(settings, 'appearance.theme', next).catch(() => undefined);
      },
      toggleInspector: () => setInspectorToggle({ fits: inspectorFits, open: !inspectorOpen }),
    };
  });

  useEffect(() => {
    const a = () => actions.current;
    const commands: Command[] = [
      {
        id: 'palette.open',
        title: COMMAND_TEXT.palette,
        category: CATEGORY.general,
        binding: ['mod+k', 'mod+shift+p'],
        run: () => setPaletteOpen((o) => !o),
      },
      {
        id: 'chat.new',
        title: COMMAND_TEXT.newChat,
        category: CATEGORY.chat,
        binding: 'mod+n',
        run: () => a().newChat(),
      },
      {
        id: 'chat.newTemporary',
        title: COMMAND_TEXT.newTemporaryChat,
        category: CATEGORY.chat,
        run: () => a().newTemporaryChat(),
      },
      {
        id: 'chat.search',
        title: COMMAND_TEXT.searchChats,
        category: CATEGORY.chat,
        run: () => a().openSearch(),
      },
      {
        id: 'chat.find',
        title: COMMAND_TEXT.find,
        category: CATEGORY.chat,
        binding: 'mod+f',
        when: 'mode == chat',
        run: () => chatControls.current?.openFind(),
      },
      {
        id: 'chat.sideChat',
        title: COMMAND_TEXT.sideChat,
        category: CATEGORY.chat,
        run: () => a().openPanel('side'),
      },
      {
        id: 'chat.branches',
        title: COMMAND_TEXT.branches,
        category: CATEGORY.chat,
        run: () => a().openPanel('branches'),
      },
      {
        id: 'chat.artifacts',
        title: COMMAND_TEXT.artifacts,
        category: CATEGORY.chat,
        run: () => a().openPanel('artifacts'),
      },
      {
        id: 'chat.activity',
        title: COMMAND_TEXT.activity,
        category: CATEGORY.chat,
        run: () => a().openPanel('activity'),
      },
      {
        id: 'chat.stop',
        title: COMMAND_TEXT.stop,
        category: CATEGORY.chat,
        binding: 'escape',
        when: 'streaming',
        run: () => chatControls.current?.stop(),
      },
      {
        id: 'chat.focusComposer',
        title: COMMAND_TEXT.focusComposer,
        category: CATEGORY.chat,
        when: 'mode == chat',
        run: () => chatControls.current?.focusComposer(),
      },
      ...MODES.map((m, i) => ({
        id: MODE_INFO[m].command,
        title: MODE_TEXT[m].switchTo,
        category: CATEGORY.modes,
        binding: `mod+${i + 1}`,
        run: () => a().switchMode(m),
      })),
      {
        id: 'settings.open',
        title: COMMAND_TEXT.openSettings,
        category: CATEGORY.settings,
        binding: 'mod+,',
        run: () => navigate('/settings/general'),
      },
      ...SETTINGS_SECTIONS.map((s) => ({
        id: `settings.${s}`,
        title: COMMAND_TEXT.openSection({ section: SECTION_LABELS[s] }),
        category: CATEGORY.settings,
        run: () => navigate(`/settings/${s}`),
      })),
      {
        id: 'view.toggleTheme',
        title: COMMAND_TEXT.toggleTheme,
        category: CATEGORY.view,
        run: () => a().toggleTheme(),
      },
      {
        id: 'view.toggleSidebar',
        title: COMMAND_TEXT.toggleSidebar,
        category: CATEGORY.view,
        binding: 'mod+b',
        run: () => a().toggleSidebar(),
      },
      {
        id: 'view.toggleInspector',
        title: COMMAND_TEXT.toggleInspector,
        category: CATEGORY.view,
        run: () => a().toggleInspector(),
      },
      {
        id: 'nav.back',
        title: COMMAND_TEXT.back,
        category: CATEGORY.navigation,
        binding: 'mod+[',
        run: () => history.back(),
      },
      {
        id: 'nav.forward',
        title: COMMAND_TEXT.forward,
        category: CATEGORY.navigation,
        binding: 'mod+]',
        run: () => history.forward(),
      },
      {
        id: 'onboarding.open',
        title: COMMAND_TEXT.setupGuide,
        category: CATEGORY.general,
        run: () => navigate('/onboarding'),
      },
      {
        id: 'apps.open',
        title: COMMAND_TEXT.openApp,
        category: CATEGORY.apps,
        run: () => a().openAppPicker(),
      },
      {
        id: SHOW_APPS_COMMAND,
        title: COMMAND_TEXT.chatApps,
        category: CATEGORY.apps,
        run: () => a().openPanel('apps'),
      },
      {
        id: 'library.open',
        title: COMMAND_TEXT.library,
        category: CATEGORY.navigation,
        run: () => navigate('/library'),
      },
      {
        id: 'files.show',
        title: COMMAND_TEXT.files,
        category: CATEGORY.files,
        run: () => a().openPanel('files'),
      },
      {
        id: 'panel.toggle',
        title: COMMAND_TEXT.togglePanel,
        category: CATEGORY.view,
        binding: 'mod+j',
        run: () => a().togglePanel(),
      },
      {
        id: 'terminal.toggle',
        title: COMMAND_TEXT.toggleTerminal,
        category: CATEGORY.terminal,
        binding: 'ctrl+`',
        run: () => a().toggleTerminal(),
      },
      {
        id: 'terminal.new',
        title: COMMAND_TEXT.newTerminal,
        category: CATEGORY.terminal,
        run: () => a().newTerminal(),
      },
      {
        id: 'pane.splitRight',
        title: COMMAND_TEXT.splitRight,
        category: CATEGORY.layout,
        run: () => a().split('row'),
      },
      {
        id: 'pane.splitDown',
        title: COMMAND_TEXT.splitDown,
        category: CATEGORY.layout,
        run: () => a().split('column'),
      },
      ...(['editor', 'preview', 'terminal'] as const).map((k) => ({
        id: `pane.add.${k}`,
        title: SHELL_TEXT.pane.add({ kind: k }),
        category: CATEGORY.layout,
        run: () => a().addPane(k),
      })),
      {
        id: 'pane.diff',
        title: COMMAND_TEXT.diffPane,
        category: CATEGORY.layout,
        binding: 'mod+shift+d',
        run: () => a().showPane('diff'),
      },
      {
        id: 'pane.browser',
        title: COMMAND_TEXT.browserPane,
        category: CATEGORY.layout,
        binding: 'mod+shift+b',
        run: () => a().showPane('browser'),
      },
      {
        id: 'pane.maximize',
        title: COMMAND_TEXT.maximize,
        category: CATEGORY.layout,
        run: () => a().maximize(),
      },
      {
        id: 'pane.close',
        title: COMMAND_TEXT.closePane,
        category: CATEGORY.layout,
        run: () => a().closePane(),
      },
      {
        id: 'pane.moveEarlier',
        title: COMMAND_TEXT.moveEarlier,
        category: CATEGORY.layout,
        run: () => a().movePane(-1),
      },
      {
        id: 'pane.moveLater',
        title: COMMAND_TEXT.moveLater,
        category: CATEGORY.layout,
        run: () => a().movePane(1),
      },
      {
        id: 'layout.reset',
        title: COMMAND_TEXT.resetLayout,
        category: CATEGORY.layout,
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
      label={MODE_TEXT[m].workspace}
      layout={layouts[m]}
      onChange={(fn) => updateLayout(m, fn)}
      visible={visibleMode === m}
      phone={layout === 'phone'}
      info={(p) => paneInfo(p, { title: MODE_TEXT[m].label, icon: MODE_INFO[m].icon })}
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
  const title = messageFor(SHELL_TEXT.page, route.name) ?? MODE_TEXT[mode ?? lastMode].label;
  // The browser tab and the window list name the page that is open (WCAG 2.4.2).
  const documentTitle = SHELL_TEXT.documentTitle({ page: title });
  useEffect(() => {
    document.title = documentTitle;
  }, [documentTitle]);

  return (
    <div
      className="app"
      data-layout={layout}
      data-sidebar={sidebarOpen ? 'open' : 'closed'}
      data-inspector={inspectorOpen ? 'open' : 'closed'}
    >
      <a className="skip-link" href="#main">
        {SHELL_TEXT.skipToContent}
      </a>
      <header className="topbar">
        <IconButton
          label={
            layout === 'phone'
              ? sidebarOpen
                ? SHELL_TEXT.closeMenu
                : SHELL_TEXT.openMenu
              : SHELL_TEXT.toggleSidebar
          }
          icon={<Icon name={layout === 'phone' ? (sidebarOpen ? 'close' : 'menu') : 'sidebar'} />}
          variant="ghost"
          aria-expanded={sidebarOpen}
          aria-controls="sidebar"
          aria-keyshortcuts={sidebarKeys ? ariaKeyShortcut(sidebarKeys, mac) : undefined}
          onClick={toggleSidebar}
        />
        <span className="brand">Nova</span>
        <span className="topbar-title" dir="auto">
          {title}
        </span>
        <span className="topbar-spacer" />
        <Button
          variant="ghost"
          onClick={() => setPaletteOpen(true)}
          aria-keyshortcuts={paletteKeys ? ariaKeyShortcut(paletteKeys, mac) : undefined}
        >
          {SHELL_TEXT.commands}
        </Button>
        <NotificationsBell />
        {mode !== null ? (
          <>
            <IconButton
              label={SHELL_TEXT.toggleBottomPanel}
              icon={<Icon name="panel" />}
              variant="ghost"
              aria-expanded={layouts[mode].bottom.open}
              aria-keyshortcuts={panelKeys ? ariaKeyShortcut(panelKeys, mac) : undefined}
              onClick={() => togglePanel(mode)}
            />
            <Menu
              label={SHELL_TEXT.layout}
              trigger={<Icon name="split-right" />}
              items={layoutItems(mode)}
            />
          </>
        ) : null}
        {layout !== 'phone' && mode !== null ? (
          <IconButton
            label={SHELL_TEXT.toggleInspector}
            icon={<Icon name="inspector" />}
            variant="ghost"
            aria-expanded={inspectorOpen}
            aria-controls="inspector"
            onClick={() => setInspectorToggle({ fits: inspectorFits, open: !inspectorOpen })}
          />
        ) : null}
        <Menu
          label={displayName ? SHELL_TEXT.accountOf({ name: displayName }) : SHELL_TEXT.account}
          trigger={
            <span className="account-initial">
              {(displayName ?? 'N').slice(0, 1).toUpperCase()}
            </span>
          }
          items={[
            // How this device reaches the Hub: directly, over the Mesh, or through the Relay.
            connectionMenuItem(hubPath, () => navigate('/network')),
            {
              id: 'settings',
              label: SHELL_TEXT.settings,
              onSelect: () => navigate('/settings/general'),
            },
            {
              id: 'approvals',
              label: SHELL_TEXT.approvals,
              onSelect: () => navigate('/approvals'),
            },
            {
              id: 'setup',
              label: SHELL_TEXT.setupGuide,
              onSelect: () => navigate('/onboarding'),
            },
            { id: 'signout', label: SHELL_TEXT.signOut, onSelect: onSignOut },
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
          <OfflineBanner />
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
                  <MemberGate ownerOnly what={SHELL_TEXT.owned.code}>
                    <CodeView
                      id={route.name === 'mode' && route.mode === 'code' ? route.id : null}
                    />
                  </MemberGate>
                ) : (
                  <AgentsView
                    id={route.name === 'mode' && route.mode === 'agents' ? route.id : null}
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
          {route.name === 'library' ? (
            <MemberGate ownerOnly what={SHELL_TEXT.owned.library}>
              <LibraryView />
            </MemberGate>
          ) : null}
          {route.name === 'spaces' ? (
            <SpacesView spaceId={route.spaceId} pageId={route.pageId} />
          ) : null}
          {route.name === 'sites' ? <SitesView siteId={route.siteId} /> : null}
          {route.name === 'apps' ? <AppsView entryId={route.entryId} /> : null}
          {route.name === 'devices' ? (
            <MemberGate ownerOnly what={SHELL_TEXT.owned.devices}>
              <DevicesView deviceId={route.deviceId} />
            </MemberGate>
          ) : null}
          {route.name === 'network' ? (
            <MemberGate ownerOnly what={SHELL_TEXT.owned.network}>
              <NetworkSurface section={route.section} />
            </MemberGate>
          ) : null}
          {route.name === 'approvals' ? <ApprovalsPage /> : null}
          {route.name === 'team' ? <TeamSurface section={route.section} id={route.id} /> : null}
          {route.name === 'computers' ? (
            <ComputersView
              computerId={route.computerId}
              browserPanel={(c) => <BrowserPanel computerId={c.id} />}
              screenPanel={(c) => <ScreenPanel computerId={c.id} />}
            />
          ) : null}
          {route.name === 'onboarding' ? (
            <Onboarding displayName={displayName} onDisplayName={onDisplayName} />
          ) : null}
          {route.name === 'marketplace' ? <MarketplacePage tab={route.tab} /> : null}
          {route.name === 'authorize' ? <AuthorizePage query={route.query} /> : null}
          <ExtensionStatusBar />
        </main>
        <aside
          id="inspector"
          className="inspector"
          aria-label={SHELL_TEXT.inspector}
          hidden={!inspectorOpen}
        >
          {layout === 'phone' ? (
            <Button
              className="inspector-close"
              onClick={() => setInspectorToggle({ fits: inspectorFits, open: false })}
            >
              <Icon name="close" /> {SHELL_TEXT.closePanel}
            </Button>
          ) : null}
          <Tabs
            label={SHELL_TEXT.inspector}
            value={inspectorTab}
            onChange={setInspectorTab}
            items={[
              {
                id: 'artifacts',
                label: SHELL_TEXT.tabs.artifacts,
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
                label: SHELL_TEXT.tabs.files,
                panel: (
                  <FileBrowser
                    key={`${target}:${target === 'chat' ? (chatThreadId ?? 'none') : ''}`}
                    threadId={target === 'chat' ? chatThreadId : null}
                    projectId={target === 'chat' ? chatProjectId : null}
                    onOpen={(f, where) => openFile(target, f, where)}
                  />
                ),
              },
              { id: 'sources', label: SHELL_TEXT.tabs.sources, panel: <SourcesLater /> },
              {
                id: 'activity',
                label: SHELL_TEXT.tabs.activity,
                panel: <ActivityPanel key={chatThreadId ?? 'none'} threadId={chatThreadId} />,
              },
              {
                id: 'side',
                label: SHELL_TEXT.tabs.side,
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
                label: SHELL_TEXT.tabs.branches,
                panel: <BranchesPanel threadId={chatThreadId} />,
              },
              {
                id: 'apps',
                label: SHELL_TEXT.tabs.apps,
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
          label={SHELL_TEXT.openApp}
          placeholder={SHELL_TEXT.searchApps}
          options={appPicker}
          empty={SHELL_TEXT.noApps}
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
      {/* While Nova controls a computer: the indicator, Stop, and the kill key anywhere (FR-207). */}
      <ControlIndicator onOpenComputer={(id) => navigate(computerPath(id))} />
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

function SourcesLater() {
  return <p className="muted">{SHELL_TEXT.sourcesLater}</p>;
}
