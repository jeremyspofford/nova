// Files, terminals, the library and local project folders (FR-005/006 server side, FR-035,
// FR-039, FR-041). Filled in by M4.
import type { AuditSink, SandboxClient, ToolGate } from '@nova/core';
import type { HubArea, HubContext } from './hub-context.ts';

export function setupWorkspace(
  _ctx: HubContext & { audit: AuditSink; gate: ToolGate; sandbox: () => SandboxClient | null },
): Promise<HubArea> {
  return Promise.resolve({ register: () => undefined, close: () => Promise.resolve() });
}
