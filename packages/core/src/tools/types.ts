// M3 seams between the tool runtime, the policy gate, MCP, the sandbox and audit (docs/08 §1,
// docs/09 §2, docs/12 §2-§4). Lead-owned: the agents building each side code to these types.
import type {
  ConfirmationTier,
  MentionKind,
  PolicyPreview,
  ToolDescriptor,
  ToolSource,
} from '@nova/shared';
import type { ContentPart } from '@nova/providers';
import type { Logger } from '@nova/telemetry';

/** docs/08 §1.2. Results go back to the model labelled untrusted (FR-103). */
export type ToolResult =
  | { ok: true; content: ContentPart[]; meta?: Record<string, unknown> }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

/** Where an instruction or a piece of context came from (docs/12 §2, FR-189). */
export type Origin =
  | 'user'
  | 'tool'
  | 'page'
  | 'file'
  | 'email'
  | 'channel'
  | 'mcp'
  | 'plugin'
  | 'memory'
  | 'capture'
  | 'external_agent'
  | 'system';

export interface Provenance {
  /** The authenticated user typed (or dictated) the instruction behind this call. */
  userInstruction?: { messageId: string; accountId: string };
  /** Untrusted origins that shaped the arguments (tool results, pages, files, …). */
  taint: Origin[];
}

/** One filesystem root the turn may use, with the access its permission profile grants. */
export interface ToolRoot {
  path: string;
  access: 'read' | 'write';
  label: string;
}

export interface ToolContext {
  accountId: string;
  threadId: string;
  turnId: string;
  callId: string;
  /** The assistant message the call belongs to (artifacts attach to it). */
  messageId?: string;
  projectId: string | null;
  origin: 'model' | 'ui' | 'hook' | 'mcp_client';
  /** The permission profile in force (FR-190) and its hash, recorded with every decision. */
  profile: { id: string; hash: string };
  roots: ToolRoot[];
  sandbox: SandboxClient;
  signal: AbortSignal;
  log: Logger;
  /** Report incremental output (ephemeral `tool.call.progress`). */
  progress?: (chunk: string) => void;
}

export interface ToolDefinition {
  descriptor: ToolDescriptor;
  handler: (args: unknown, ctx: ToolContext) => Promise<ToolResult>;
}

/** A provider of tools other than the built-ins: MCP servers (FR-042), plugins (M4). */
/** The thread a listing is for (M5): run, code and request tools belong to some modes only. */
export interface ToolListScope {
  threadId: string | null;
  mode: 'chat' | 'work' | 'code' | 'agent';
}

export interface ToolSourceProvider {
  readonly source: ToolSource;
  /**
   * Tools available to this account now; never throws (an unhealthy server lists nothing).
   * With `scope`, the listing is for one turn of that thread: a source may leave out tools
   * that do not apply there. Without it (catalogs, direct invocation), list them all.
   */
  list(accountId: string, scope?: ToolListScope): Promise<ToolDefinition[]>;
}

// ---- the policy gate (FR-099, FR-100, FR-189) --------------------------------------------------

export interface GateRequest {
  accountId: string;
  threadId: string;
  turnId: string;
  callId: string;
  projectId: string | null;
  mode: 'chat' | 'work' | 'code' | 'agent';
  tool: ToolDescriptor;
  args: unknown;
  /** Redacted, truncated arguments for the approval card and audit. */
  argsPreview: string;
  provenance: Provenance;
  resource?: { kind: 'path' | 'host' | 'account'; value: string };
  profile: { id: string; hash: string };
  /** Who issued the call; UI invocations are audited as the user. Default `model`. */
  origin?: ToolContext['origin'];
  /** The roots the tool runs with, so the gate checks exactly those. */
  roots?: ToolRoot[];
}

/** What the runtime does with a call once the gate has decided (including any approval). */
export type GateOutcome =
  | { effect: 'allow'; reason: string; tier: ConfirmationTier; approvalId?: string }
  | {
      effect: 'deny';
      reason: string;
      tier: ConfirmationTier;
      approvalId?: string;
      /** Deny and stop: the turn ends and child work stops until the user's next message. */
      stop: boolean;
      /** The approval expired unanswered (recorded as `timeout`, never an allow). */
      timeout?: boolean;
    }
  | {
      effect: 'handoff';
      reason: string;
      tier: ConfirmationTier;
      approvalId: string;
      /** The user's note when they marked the handed-off step done. */
      note?: string;
    };

export interface ToolGate {
  /**
   * Evaluate the call; when the decision is `ask`, create an approval, wait for the user (or the
   * timeout) and return the resolved outcome. Aborting the signal cancels a pending approval.
   */
  check(req: GateRequest, signal: AbortSignal): Promise<GateOutcome>;
  /** What the engine would decide, with no approval and no side effects (FR-048 preview). */
  preview(req: Omit<GateRequest, 'callId' | 'turnId' | 'argsPreview'>): Promise<PolicyPreview>;
}

/** Allows everything; for tests and for turns that carry no tools. Never used by the Hub. */
export const allowAllGate: ToolGate = {
  check: () =>
    Promise.resolve({ effect: 'allow', reason: 'test gate', tier: 'pre_approvable' as const }),
  preview: () =>
    Promise.resolve({
      effect: 'allow',
      tier: 'pre_approvable' as const,
      reason: 'test gate',
      source: 'fallback',
      ruleId: null,
    }),
};

// ---- sandbox (FR-190; FR-107 completes it in M6) -----------------------------------------------

export interface ExecRequest {
  cmd: string;
  cwd: string;
  roots: ToolRoot[];
  network: 'off' | 'allowlist' | 'limited';
  env?: Record<string, string>;
  /** Wait this long before returning a running session (FR-184). */
  yieldMs: number;
  signal: AbortSignal;
  /** The turn that owns the session (killed when the turn ends). */
  turnId?: string;
  /**
   * Nova's own Git invocation (FR-211, docs/12 §7.2): `.git` is writable except its config,
   * hooks and info. Never taken from a tool's arguments.
   */
  gitWrite?: boolean;
}

export type ExecResult =
  | { status: 'exited'; exitCode: number; output: string }
  | {
      status: 'running';
      sessionId: string;
      output: string;
      /** A port published with `publish` (dev servers): reachable at 127.0.0.1:hostPort. */
      published?: { port: number; hostPort: number };
    };

export interface SandboxClient {
  readonly substrate: 'os_sandbox' | 'container' | 'micro_vm' | 'cloud' | null;
  /** Whether commands can run at all; when false exec tools fail closed. */
  available(): Promise<{ ok: boolean; detail: string }>;
  exec(req: ExecRequest): Promise<ExecResult>;
  poll(sessionId: string, yieldMs: number, signal: AbortSignal): Promise<ExecResult>;
  write(
    sessionId: string,
    input: { text?: string; closeStdin?: boolean; signal?: 'interrupt' | 'terminate' },
  ): Promise<void>;
  /** Kill every session of a turn (cancel, end of turn). */
  killTurn(turnId: string): Promise<void>;
}

// ---- audit and notifications (FR-104 partial, FR-013) ------------------------------------------

export interface AuditRecord {
  accountId: string;
  actor: string;
  kind:
    | 'tool_call'
    | 'approval'
    | 'policy'
    | 'auth'
    | 'secret'
    | 'settings'
    | 'mcp'
    | 'node'
    | 'fs'
    | 'network'
    | 'hook'
    | 'plugin'
    | 'terminal'
    | 'run'
    | 'schedule'
    | 'review'
    | 'request'
    | 'code'
    | 'agent'
    | 'channel'
    | 'computer'
    | 'browser'
    | 'screen'
    | 'device'
    | 'space';
  action: string;
  resource?: string | null;
  /** SHA-256 of the canonical inputs; inputs themselves are never stored here. */
  inputHash?: string | null;
  decision?: string | null;
  result?: string | null;
  threadId?: string | null;
  turnId?: string | null;
  detail?: Record<string, unknown>;
}

export interface AuditSink {
  append(rec: AuditRecord): Promise<void>;
}

export const noopAudit: AuditSink = { append: () => Promise.resolve() };

export interface NotificationInput {
  accountId: string;
  kind: 'approval' | 'completion' | 'error' | 'attention' | 'system';
  /** Also show it as an OS notification when a client can (a schedule's `os` target). */
  os?: boolean;
  title: string;
  body?: string;
  href?: string;
  /** Collapse repeats for the same thing, e.g. `approval:<id>`. */
  dedupeKey?: string;
}

export interface Notifier {
  notify(n: NotificationInput): Promise<void>;
}

export const noopNotifier: Notifier = { notify: () => Promise.resolve() };

// ---- mentions (FR-022) ---------------------------------------------------------------------------

/** A mention resolved into a context item the model sees (labelled with its origin). */
export interface ResolvedMention {
  kind: MentionKind;
  ref: string;
  label: string;
  /** Text added to the context, or null when the mention only loads tools. */
  text: string | null;
  /** Tool names that must not be deferred this turn (FR-196). */
  tools: string[];
}
