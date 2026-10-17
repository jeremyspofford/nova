// MCP Apps: entry points and `ui://` resources served to sandboxed iframes (FR-198). Filled in by M4.
import type { HubArea, HubContext } from './hub-context.ts';
import type { HubMcpArea } from './mcp.ts';

export function setupMcpApps(_ctx: HubContext & { mcp: HubMcpArea }): Promise<HubArea> {
  return Promise.resolve({ register: () => undefined, close: () => Promise.resolve() });
}
