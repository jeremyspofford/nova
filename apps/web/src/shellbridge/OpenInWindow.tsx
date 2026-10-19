// "Open in new window" (FR-009): inside the desktop app any thread or panel with an app route can
// get a window of its own. The button and the palette command exist only in the app; a browser tab
// already has its own windows and tabs, so they never show there. The shell checks the path again
// and opens only app routes on the Hub's origin.
import { useEffect } from 'react';
import { Button, Icon, useToast } from '@nova/ui';
import type { Command } from '../commands.ts';
import { useServices } from '../services.tsx';
import {
  currentPath,
  isWindowPath,
  shellErrorMessage,
  useShell,
  type ShellBridge,
} from './bridge.ts';

export const OPEN_WINDOW_COMMAND = 'window.openCurrent';

const REFUSED = 'This view cannot open in a window of its own.';

/** Open `path` in a window of its own; the outcome in words for a toast, or null when it opened. */
export async function openInWindow(shell: ShellBridge, path: string): Promise<string | null> {
  if (!isWindowPath(path)) return REFUSED;
  try {
    return (await shell.openWindow(path)) ? null : REFUSED;
  } catch (err) {
    return shellErrorMessage(err, 'The desktop app could not open the window.');
  }
}

/**
 * A button that opens `path` in a new window of the desktop app. Renders nothing in a browser tab
 * or for a path that is not an app route.
 */
export function OpenInWindowButton({
  path,
  what,
  label = 'Open in new window',
  compact = false,
}: {
  path: string;
  /** What opens, for the accessible name ("Open Trip planning in a new window"). */
  what?: string;
  label?: string;
  /** Icon only, with the label as its accessible name and tooltip. */
  compact?: boolean;
}) {
  const shell = useShell();
  const toast = useToast();
  if (!shell || !isWindowPath(path)) return null;
  const name = what ? `Open ${what} in a new window` : label;
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
      {compact ? null : ` ${label}`}
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
    title: 'Open this view in a new window',
    category: 'View',
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
