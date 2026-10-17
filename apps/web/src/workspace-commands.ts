// Navigation commands for projects (FR-003, FR-034). Memory, Models and Devices are settings
// sections, reached by the shell's "Open … settings" commands. The shell registers these once.
import type { Command, CommandRegistry } from './commands.ts';
import { navigate as routerNavigate, projectPath } from './router.ts';

/** Opening this path shows the projects list with the New project dialog open. */
export const NEW_PROJECT_PATH = '/projects?new=1';

export interface WorkspaceCommandDeps {
  /** Defaults to the History API router. */
  navigate?: (path: string) => void;
}

export function workspaceCommands(deps: WorkspaceCommandDeps = {}): Command[] {
  const go = deps.navigate ?? ((path: string) => routerNavigate(path));
  return [
    {
      id: 'projects.open',
      title: 'Go to Projects',
      category: 'Navigation',
      run: () => go(projectPath(null)),
    },
    {
      id: 'projects.new',
      title: 'New project',
      category: 'Projects',
      run: () => go(NEW_PROJECT_PATH),
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
