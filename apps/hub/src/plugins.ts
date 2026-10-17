// Plugins, catalogs, skills and slash commands (FR-045, FR-046, FR-049 stub). Filled in by M4.
import type { AuditSink, PluginPermissionSource, SkillCatalogProvider } from '@nova/core';
import type { HubArea, HubContext } from './hub-context.ts';
import type { HubMcpArea } from './mcp.ts';

export interface PluginsArea extends HubArea {
  skills: SkillCatalogProvider;
  permissions: PluginPermissionSource;
}

export function setupPlugins(
  _ctx: HubContext & { audit: AuditSink; mcp: HubMcpArea },
): Promise<PluginsArea> {
  return Promise.resolve({
    skills: {
      catalogSection: () => Promise.resolve(null),
      resolve: () => Promise.resolve(null),
      tools: { source: 'plugin', list: () => Promise.resolve([]) },
    },
    permissions: { forTool: () => Promise.resolve(null) },
    register: () => undefined,
    close: () => Promise.resolve(),
  });
}
