// Profile, usage insights, provider account switching and import from other assistants
// (FR-113, FR-114, FR-115, FR-200). Filled in by M4.
import type { AuditSink } from '@nova/core';
import type { HubArea, HubContext } from './hub-context.ts';
import type { HubMcpArea } from './mcp.ts';
import type { PluginsArea } from './plugins.ts';

export function setupProfile(
  _ctx: HubContext & { audit: AuditSink; mcp: HubMcpArea; plugins: PluginsArea },
): Promise<HubArea> {
  return Promise.resolve({ register: () => undefined, close: () => Promise.resolve() });
}
