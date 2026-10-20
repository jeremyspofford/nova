// Navigation commands for projects (FR-003, FR-034), the notification center (FR-013), the import
// wizard (FR-200, docs/04 §2.11) and plugins (FR-045). Memory, Models, Devices, Tools & MCP,
// Permissions, Notifications and Diagnostics are settings sections, reached by the shell's
// "Open … settings" commands. The shell registers these once.
import { defineMessages } from '@nova/i18n';
import { CATEGORY, type Command, type CommandRegistry } from './commands.ts';
import { navigate as routerNavigate, projectPath } from './router.ts';

/** Opening this path shows the projects list with the New project dialog open. */
export const NEW_PROJECT_PATH = '/projects?new=1';

/** Window event the notifications bell listens for to open its panel. */
export const OPEN_NOTIFICATIONS_EVENT = 'nova:open-notifications';

export function openNotifications(): void {
  window.dispatchEvent(new Event(OPEN_NOTIFICATIONS_EVENT));
}

export interface WorkspaceCommandDeps {
  /** Defaults to the History API router. */
  navigate?: (path: string) => void;
  /** Defaults to opening the bell panel in the top bar. */
  showNotifications?: () => void;
}

const TEXT = defineMessages('workspaceCommands', {
  projects: 'Go to Projects',
  newProject: 'New project',
  import: 'Import from another assistant',
  plugins: 'Browse and install plugins',
  notifications: 'Show notifications',
});

export function workspaceCommands(deps: WorkspaceCommandDeps = {}): Command[] {
  const go = deps.navigate ?? ((path: string) => routerNavigate(path));
  const show = deps.showNotifications ?? openNotifications;
  return [
    {
      id: 'projects.open',
      title: TEXT.projects,
      category: CATEGORY.navigation,
      run: () => go(projectPath(null)),
    },
    {
      id: 'projects.new',
      title: TEXT.newProject,
      category: CATEGORY.projects,
      run: () => go(NEW_PROJECT_PATH),
    },
    {
      id: 'import.open',
      title: TEXT.import,
      category: CATEGORY.general,
      run: () => go('/settings/import'),
    },
    {
      id: 'plugins.browse',
      title: TEXT.plugins,
      category: CATEGORY.settings,
      run: () => go('/settings/plugins'),
    },
    {
      id: 'notifications.open',
      title: TEXT.notifications,
      category: CATEGORY.general,
      run: show,
    },
  ];
}

/** Register the workspace commands; returns a function that unregisters them. */
export function registerWorkspaceCommands(
  registry: CommandRegistry,
  deps: WorkspaceCommandDeps = {},
): () => void {
  const offs = workspaceCommands(deps).map((c) => registry.register(c));
  return () => offs.forEach((off) => off());
}
