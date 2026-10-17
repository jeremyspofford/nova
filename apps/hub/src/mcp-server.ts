// Nova's own MCP server for external clients and their per-client tokens (FR-044, FR-192).
// Filled in by M4.
import type { AuditSink, ToolGate } from '@nova/core';
import type { HubArea, HubContext } from './hub-context.ts';
import type { ToolsArea } from './tools.ts';

export function setupMcpServer(
  _ctx: HubContext & { audit: AuditSink; gate: ToolGate; tools: ToolsArea },
): Promise<HubArea> {
  return Promise.resolve({ register: () => undefined, close: () => Promise.resolve() });
}
