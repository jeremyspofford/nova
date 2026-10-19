// Per-thread tool limits the gate enforces on top of the policy (FR-053, FR-217, FR-045): a
// sub-agent's tool allow-list, a shared thread's exclusion of private connectors, the plugins
// connected to an agent. A limit only narrows: every source that knows the thread applies, a tool
// any of them refuses is denied outright (and so hidden from the turn's listing), and a source that
// fails denies (fail closed). A limited call is never pre-approvable or persistable.
import type { ToolDescriptor } from '@nova/shared';

export interface ThreadToolLimits {
  /** Only these tools: exact names or `prefix.*`. Null or absent: no list. */
  allow?: readonly string[] | null;
  /** Never these tools: exact names or `prefix.*`. */
  deny?: readonly string[] | null;
  /** Only tools of these sources (`builtin`, `mcp`, `plugin`, `browser`, ...). */
  sources?: readonly string[] | null;
  /**
   * Only tools of these plugins: a tool a plugin owns (its own tools, its MCP servers' tools) is
   * refused unless its plugin is listed. Null or absent: any enabled plugin.
   */
  plugins?: readonly string[] | null;
  /** Why, shown in the denial ("not in this sub-agent's tool list"). */
  reason: string;
}

export interface ToolLimitSource {
  /** The limits of a thread; null when this source does not limit it. */
  forThread(accountId: string, threadId: string): Promise<ThreadToolLimits | null>;
}

function matches(patterns: readonly string[], name: string): boolean {
  return patterns.some((p) => (p.endsWith('.*') ? name.startsWith(p.slice(0, -1)) : p === name));
}

/**
 * Why a tool is outside the limits, or null when it is inside. `pluginId` is the plugin that owns
 * the tool (the gate resolves it for MCP servers a plugin installed).
 */
export function limitDenial(
  limits: ThreadToolLimits,
  tool: Pick<ToolDescriptor, 'name' | 'source'>,
  pluginId: string | null,
): string | null {
  if (limits.allow && !matches(limits.allow, tool.name)) return limits.reason;
  if (limits.deny && matches(limits.deny, tool.name)) return limits.reason;
  if (limits.sources && !limits.sources.includes(tool.source)) return limits.reason;
  if (limits.plugins && pluginId && !limits.plugins.includes(pluginId)) return limits.reason;
  return null;
}
