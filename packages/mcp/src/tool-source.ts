// MCP tools as a tool source for the Hub's tool runtime (docs/08 §1, §8): `mcp:<server>.<tool>`,
// deferrable (FR-196), filtered by each server's tool lists. Structurally a `ToolSourceProvider`
// from @nova/core (this package does not depend on core).
import type { ToolDescriptor } from '@nova/shared';
import type { McpToolResult } from './content.ts';
import type { McpManager } from './manager.ts';

/** What the handler reads from the runtime's ToolContext. */
export interface McpCallContext {
  signal: AbortSignal;
  progress?: (chunk: string) => void;
}

export interface McpToolDefinition {
  descriptor: ToolDescriptor;
  handler: (args: unknown, ctx: McpCallContext) => Promise<McpToolResult>;
}

export class McpToolSource {
  readonly source = 'mcp' as const;
  readonly #manager: McpManager;

  constructor(manager: McpManager) {
    this.#manager = manager;
  }

  /** Tools of this account's connected servers; never throws (an unhealthy server lists none). */
  list(accountId: string): Promise<McpToolDefinition[]> {
    try {
      return Promise.resolve(
        this.#manager.exposedTools(accountId).map((t) => ({
          descriptor: t.descriptor,
          handler: (args: unknown, ctx: McpCallContext) =>
            this.#manager.callTool(t.serverId, t.original, args, {
              signal: ctx.signal,
              ...(ctx.progress ? { onProgress: ctx.progress } : {}),
            }),
        })),
      );
    } catch {
      return Promise.resolve([]);
    }
  }
}
