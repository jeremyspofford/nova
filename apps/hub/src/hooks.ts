// Lifecycle hooks: discovery, trust by content hash, running them (FR-197). Filled in by M4.
import { noHooks, type AuditSink, type HookDispatcher, type SandboxClient } from '@nova/core';
import type { McpManager } from '@nova/mcp';
import type { HubArea, HubContext } from './hub-context.ts';

export interface HooksArea extends HubArea {
  dispatcher: HookDispatcher;
  /** Hooks of type `command` run in the tools' sandbox (wired after the tools area exists). */
  useSandbox(sandbox: SandboxClient): void;
  /** Hooks of type `mcp_tool` call through the MCP manager. */
  useMcp(manager: McpManager): void;
}

export function setupHooks(_ctx: HubContext & { audit: AuditSink }): Promise<HooksArea> {
  return Promise.resolve({
    dispatcher: noHooks,
    useSandbox: () => undefined,
    useMcp: () => undefined,
    register: () => undefined,
    close: () => Promise.resolve(),
  });
}
