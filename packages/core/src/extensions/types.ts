// M4 seams between plugins and skills, hooks, the agent loop and the policy gate (docs/08 §3-§4,
// docs/12 §2.3 step 7). Lead-owned: the agents building each side code to these types.
import type { HookEvent, PolicyEffect, ToolDescriptor } from '@nova/shared';
import type { ToolSourceProvider } from '../tools/types.ts';

// ---- skills (FR-046) ------------------------------------------------------------------------

export interface ResolvedSkill {
  skillId: string;
  name: string;
  /** The SKILL.md body, loaded on use. */
  body: string;
  /** Tools the skill needs: never deferred while it is active (FR-196). */
  allowedTools: string[];
  /** Files next to SKILL.md, relative to its folder. */
  files: string[];
}

export interface SkillCatalogProvider {
  /**
   * The catalog section for a chat: names and descriptions only, within 2 % of the context window
   * (at most 10,000 tokens); null when there are no skills.
   */
  catalogSection(
    accountId: string,
    projectId: string | null,
    contextTokens: number,
  ): Promise<string | null>;
  /** A skill by name after precedence (managed > project > user > plugin > built-in). */
  resolve(accountId: string, projectId: string | null, name: string): Promise<ResolvedSkill | null>;
  /** `skill.load` and any skill-provided tools. */
  tools: ToolSourceProvider;
}

// ---- plugins (FR-045) -----------------------------------------------------------------------

export type ActionClass = 'read' | 'write' | 'send' | 'delete' | 'execute';

/** A plugin's confirmed permissions (contracts/schemas/plugin-manifest.json `permissions`). */
export interface PluginPermissions {
  pluginId: string;
  /** Hosts its tools may reach; anything else is denied (FR-045). */
  network: string[];
  fs: string[];
  tools: Record<string, { action: ActionClass; default?: 'allow' | 'ask' | 'deny' }>;
  actionDefaults: Partial<Record<ActionClass, 'allow' | 'ask' | 'deny'>>;
  /** Its hooks may answer an `ask` from a user rule or tool default (FR-197). */
  hooksAnswerAsks: boolean;
}

export interface PluginPermissionSource {
  /** The permissions of the plugin that owns a tool (by `pluginId` or MCP `serverId`); null if none. */
  forTool(accountId: string, tool: ToolDescriptor): Promise<PluginPermissions | null>;
}

// ---- hooks (FR-197) -------------------------------------------------------------------------

export interface HookInput {
  accountId: string;
  threadId: string;
  turnId: string | null;
  projectId: string | null;
  /** tool.pre, tool.post, permission.request. */
  tool?: ToolDescriptor;
  args?: unknown;
  /** tool.post: the redacted result text. */
  result?: string;
  /** permission.request: the engine's decision so far. */
  decision?: { effect: PolicyEffect; reason: string; source: string };
  /** prompt.submit: the user's text. */
  prompt?: string;
  /** stop: the final reply text. */
  reply?: string;
  /** The tool call a tool event is about. */
  callId?: string;
  /** What the event is about: the start reason, the compaction trigger or a sub-agent role. */
  subject?: string;
  runId?: string;
  /** The working directory: the turn's first root. */
  cwd?: string;
}

export interface HookOutcome {
  /** tool.pre: refuse the call with this reason (tighten only). */
  block?: { reason: string; hookId: string };
  /** Context the hooks add (labelled with the hook as its origin). */
  context: { text: string; hookId: string }[];
  /** permission.request: a stricter effect, or `allow` only for an eligible `ask`. */
  decision?: { effect: PolicyEffect; reason: string; hookId: string };
  /** stop: request one continuation with this prompt (within the run budget). */
  continueWith?: { prompt: string; hookId: string };
}

export interface HookDispatcher {
  /** Run the trusted, enabled hooks for an event; untrusted or changed hooks are skipped. */
  dispatch(event: HookEvent, input: HookInput, signal: AbortSignal): Promise<HookOutcome>;
}

export const noHooks: HookDispatcher = {
  dispatch: () => Promise.resolve({ context: [] }),
};
