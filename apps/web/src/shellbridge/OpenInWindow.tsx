// "Open in new window" (FR-009): inside the desktop app any thread or panel with an app route can
// get a window of its own. The button and the palette command exist only in the app; a browser tab
// already has its own windows and tabs, so they never show there. The shell checks the path again
// and opens only app routes on the Hub's origin.
import { useEffect } from 'react';
import { defineMessages } from '@nova/i18n';
import { Button, Icon, useToast } from '@nova/ui';
import { CATEGORY, type Command } from '../commands.ts';
import { useServices } from '../services.tsx';
import {
  currentPath,
  isWindowPath,
  shellErrorMessage,
  useShell,
  type ShellBridge,
} from './bridge.ts';

export const OPEN_WINDOW_COMMAND = 'window.openCurrent';

export const OPEN_WINDOW_TEXT = defineMessages('shellbridge.window', {
  open: 'Open in new window',
  /** `{what}` is the name of what opens: a thread title, an agent's name. */
  openWhat: 'Open {what} in a new window',
  command: 'Open this view in a new window',
  refused: 'This view cannot open in a window of its own.',
  failed: 'The desktop app could not open the window.',
});

/** Open `path` in a window of its own; the outcome in words for a toast, or null when it opened. */
export async function openInWindow(shell: ShellBridge, path: string): Promise<string | null> {
  if (!isWindowPath(path)) return OPEN_WINDOW_TEXT.refused;
  try {
    return (await shell.openWindow(path)) ? null : OPEN_WINDOW_TEXT.refused;
  } catch (err) {
    return shellErrorMessage(err, OPEN_WINDOW_TEXT.failed);
  }
}

/**
 * A button that opens `path` in a new window of the desktop app. Renders nothing in a browser tab
 * or for a path that is not an app route.
 */
export function OpenInWindowButton({
  path,
  what,
  label,
  compact = false,
}: {
  path: string;
  /** What opens, for the accessible name ("Open Trip planning in a new window"). */
  what?: string;
  /** The button's text; "Open in new window" by default. */
  label?: string;
  /** Icon only, with the label as its accessible name and tooltip. */
  compact?: boolean;
}) {
  const shell = useShell();
  const toast = useToast();
  if (!shell || !isWindowPath(path)) return null;
  const text = label ?? OPEN_WINDOW_TEXT.open;
  const name = what ? OPEN_WINDOW_TEXT.openWhat({ what }) : text;
  return (
    <Button
      variant="ghost"
      aria-label={name}
      title={compact ? name : undefined}
      onClick={() => {
        void openInWindow(shell, path).then((problem) => {
          if (problem) toast.show(problem, { tone: 'error' });
        });
      }}
    >
      <Icon name="external" />
      {compact ? null : ` ${text}`}
    </Button>
  );
}

/** The palette command that opens the current view in a new window (desktop app only). */
export function openWindowCommand(
  shell: ShellBridge,
  deps: { path?: () => string; report: (problem: string) => void },
): Command {
  const path = deps.path ?? currentPath;
  return {
    id: OPEN_WINDOW_COMMAND,
    title: OPEN_WINDOW_TEXT.command,
    category: CATEGORY.view,
    run: () => {
      void openInWindow(shell, path()).then((problem) => {
        if (problem) deps.report(problem);
      });
    },
  };
}

/**
 * Registers "Open this view in a new window" while mounted inside the desktop app; does nothing in
 * a browser tab. The shell mounts it once.
 */
export function useShellCommands(): void {
  const shell = useShell();
  const { registry } = useServices();
  const toast = useToast();
  useEffect(() => {
    if (!shell) return;
    return registry.register(
      openWindowCommand(shell, { report: (problem) => toast.show(problem, { tone: 'error' }) }),
    );
  }, [shell, registry, toast]);
}
