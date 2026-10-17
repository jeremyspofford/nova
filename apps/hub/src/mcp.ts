// MCP client servers: configuration, connections, health and their tools (FR-042, FR-043).
// Filled in by M3.
import type { AuditSink } from '@nova/core';
import type { HubContext, McpArea } from './hub-context.ts';

export function setupMcp(_ctx: HubContext & { audit: AuditSink }): Promise<McpArea> {
  return Promise.resolve({
    source: { source: 'mcp', list: () => Promise.resolve([]) },
    register: () => undefined,
    close: () => Promise.resolve(),
  });
}
