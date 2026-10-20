// Extension contributions in the shell (FR-117; docs/14 §4.1): running extensions' commands join
// the command palette (and Settings → Keyboard, where a shortcut is bound only when the user picks
// one), their status items sit in a status bar, and their context menu items join the menus of
// chats, messages, files and the composer. Every run goes to the Hub, which runs the extension's
// handler in its sandbox (`POST /extensions/:id/commands/:command/run`); its outcome is announced
// and shown as a toast. Nothing here applies a theme or binds a key. Items placed in the sidebar
// (`where: 'sidebar'`) sit in a menu at the foot of the sidebar, above Settings.
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { defineMessages } from '@nova/i18n';
import type { ExtensionCommandResult } from '@nova/shared';
import { Icon, Menu, useToast, type MenuItem } from '@nova/ui';
import { CATEGORY } from '../commands.ts';
import { navigate } from '../router.ts';
import { useAnnounce, useServices } from '../services.tsx';
import { MARKET_PATH } from '../market/format.ts';
import { useExtensionsApi, type ExtensionsApi } from './api-m8.ts';
import { CommandResultDialog, showCommandResult } from './CommandResult.tsx';
import {
  EXTENSIONS_PATH,
  commandErrorText,
  commandResultText,
  extensionCommandKey,
  extensionErrorMessage,
} from './format.ts';
import { extensionName, useExtensionContributions, type ContributionsState } from './store.ts';
import './extensions.css';

// Titles, menu item names and status texts come from the extensions themselves (data); only the
// words around them are messages.
export const SHELL_TEXT = defineMessages('extensions.shell', {
  openMarket: 'Open the marketplace',
  manage: 'Manage extensions',
  /** A contributed command finished without saying anything. */
  done: '{title}: done.',
  /** A contributed command finished with `text`, in its own words. */
  result: '{title}: {text}',
  /** A contributed command returned more than one line can show: the dialog has it. */
  finished: '{title} finished.',
  showResult: 'Show the result',
  couldNotRun: '{title} could not run.',
  from: 'From {name}',
  statusBar: 'Extension status',
  statusFrom: '{text} (from {name})',
  sidebarMenu: 'From extensions',
});

/** Where a context menu item of an extension can appear (docs/14 §4.1 "Context menus"). */
export type MenuPlace = 'thread' | 'message' | 'file' | 'composer' | 'sidebar';

type Run = (api: ExtensionsApi) => Promise<ExtensionCommandResult>;

/** Run something an extension contributed and say how it went (toast and live region). */
export function useRunContributed(): (title: string, run: Run) => void {
  const api = useExtensionsApi();
  const toast = useToast();
  const announce = useAnnounce();
  return (title, run) => {
    if (!api) return;
    run(api).then(
      (r) => {
        if (r.ok) {
          // What it returned, in its own words: one line in the toast, the whole in a dialog.
          const { line, full } = commandResultText(r.result);
          const text = line
            ? SHELL_TEXT.result({ title, text: line })
            : full
              ? SHELL_TEXT.finished({ title })
              : SHELL_TEXT.done({ title });
          toast.show(text, {
            tone: 'success',
            ...(full
              ? {
                  action: {
                    label: SHELL_TEXT.showResult,
                    onClick: () => showCommandResult(title, full),
                  },
                }
              : {}),
          });
          announce(text);
        } else {
          const text = commandErrorText(title, r.error);
          toast.show(text, { tone: 'error' });
          announce(text);
        }
      },
      (err: unknown) => {
        const text = extensionErrorMessage(err, SHELL_TEXT.couldNotRun({ title }));
        toast.show(text, { tone: 'error' });
        announce(text);
      },
    );
  };
}

/**
 * Register running extensions' commands in the command registry (the palette lists them under the
 * extension's name; Settings → Keyboard can bind them), plus "Open the marketplace" and "Manage
 * extensions". The shell calls this once.
 */
export function useExtensionShell(): void {
  const { registry } = useServices();
  const state = useExtensionContributions();
  const runContributed = useRunContributed();
  const run = useLatest(runContributed);
  const { commands, keybindings } = state.contributions;
  const list = useMemo(
    () =>
      commands.map((c) => ({
        key: extensionCommandKey(c.extensionId, c.id),
        extensionId: c.extensionId,
        commandId: c.id,
        title: c.title,
        category: extensionName(state, c.extensionId),
        when:
          keybindings.find((k) => k.command === `ext:${c.extensionId}/${c.id}`)?.when ?? undefined,
      })),
    [commands, keybindings, state],
  );
  const signature = JSON.stringify(list);

  // Titles are read here, when the commands register; the shell remounts on a language change.
  useEffect(() => {
    const offs = [
      registry.register({
        id: 'marketplace.open',
        title: SHELL_TEXT.openMarket,
        category: CATEGORY.navigation,
        run: () => navigate(MARKET_PATH),
      }),
      registry.register({
        id: 'extensions.manage',
        title: SHELL_TEXT.manage,
        category: CATEGORY.settings,
        run: () => navigate(EXTENSIONS_PATH),
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [registry]);

  useEffect(() => {
    const items = JSON.parse(signature) as typeof list;
    const offs: (() => void)[] = [];
    for (const c of items) {
      // Two extensions cannot share a key (it names the extension), but stay safe on a repeat.
      if (registry.get(c.key)) continue;
      offs.push(
        registry.register({
          id: c.key,
          title: c.title,
          category: c.category,
          ...(c.when ? { when: c.when } : {}),
          run: () =>
            run.current(c.title, (api) => api.runExtensionCommand(c.extensionId, c.commandId)),
        }),
      );
    }
    return () => offs.forEach((off) => off());
  }, [registry, signature, run]);
}

/** A ref that always holds the latest value (for callbacks registered once). */
function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}

/** Context menu items extensions add at `place` (for a list that builds a menu per row). */
export function menuItemsFor(
  state: ContributionsState,
  place: MenuPlace,
  args: Record<string, unknown>,
  run: (title: string, go: Run) => void,
): MenuItem[] {
  return state.contributions.menus
    .filter((m) => m.where === place)
    .flatMap((m) =>
      m.items.map((it) => ({
        id: `ext:${m.extensionId}:${it.id}`,
        label: it.title,
        description: SHELL_TEXT.from({ name: extensionName(state, m.extensionId) }),
        onSelect: () =>
          run(it.title, (api) => api.runExtensionCommand(m.extensionId, it.command, args)),
      })),
    );
}

/**
 * Context menu items extensions add at `place`, ready for a @nova/ui Menu. `args` go to the
 * command handler (the chat, message or file the menu is for).
 */
export function useExtensionMenuItems(place: MenuPlace, args: Record<string, unknown>): MenuItem[] {
  const state = useExtensionContributions();
  const run = useRunContributed();
  return menuItemsFor(state, place, args, run);
}

/**
 * The sidebar's menu of the items running extensions place there; nothing when there are none (a
 * member's shell gets no contributions). It opens upward, from the foot of the sidebar.
 */
export function SidebarExtensionMenu() {
  const items = useExtensionMenuItems('sidebar', {});
  if (items.length === 0) return null;
  return (
    <Menu
      label={SHELL_TEXT.sidebarMenu}
      trigger={
        <>
          <Icon name="more" />
          <span className="mode-label">{SHELL_TEXT.sidebarMenu}</span>
        </>
      }
      items={items}
      className="ext-sidebar-menu"
      triggerProps={{ className: 'nv-btn mode-link ext-sidebar-trigger' }}
    />
  );
}

/**
 * The status bar: running extensions' status items. A clickable one (it has a command, or the
 * extension's own click handler) is a button; the Hub runs what the click does. It also holds the
 * dialog of a command's whole result (the workspace always renders it).
 */
export function ExtensionStatusBar() {
  return (
    <>
      <StatusItems />
      <CommandResultDialog />
    </>
  );
}

function StatusItems() {
  const state = useExtensionContributions();
  const run = useRunContributed();
  const items = state.contributions.statusItems;
  if (items.length === 0) return null;
  return (
    <div className="ext-statusbar" role="group" aria-label={SHELL_TEXT.statusBar}>
      {items.map((s) => {
        const name = extensionName(state, s.extensionId);
        const label = SHELL_TEXT.statusFrom({ text: s.text, name });
        return s.clickable || s.command ? (
          <button
            key={`${s.extensionId}:${s.id}`}
            type="button"
            className="nv-btn ext-status-item"
            data-variant="ghost"
            title={label}
            aria-label={label}
            onClick={() => run(s.text, (api) => api.clickExtensionStatus(s.extensionId, s.id))}
          >
            {s.text}
          </button>
        ) : (
          <span
            role="group"
            key={`${s.extensionId}:${s.id}`}
            className="ext-status-item"
            title={label}
            aria-label={label}
          >
            {s.text}
          </span>
        );
      })}
    </div>
  );
}
