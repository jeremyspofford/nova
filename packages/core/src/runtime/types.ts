// M5 seams of the agent runtime (docs/09, docs/10, ADR-076). One runtime and one policy engine
// for every mode: Work runs, Code sessions, schedules and goals start and shape turns of the same
// chat loop (ChatService) through these interfaces. Lead-owned: request changes, never edit.
import type { ApprovalPolicyKind } from '@nova/policy';
import type {
  PermissionMode,
  RunAutonomy,
  RunOrigin,
  ExpectedOutput,
  ReviewVerdict,
  ServerRequestKind,
} from '@nova/shared';
import type { ToolDescriptor } from '@nova/shared';
import type { Origin, ToolRoot } from '../tools/types.ts';

// ---- starting turns (docs/09 §2) ---------------------------------------------------------------

/** What started a turn (docs/09 §2 "Turn records"). */
export type TurnTrigger = 'user' | 'schedule' | 'goal' | 'hook' | 'event' | 'channel';

/** Why a turn ended (turn.stop_reason). */
export type TurnStopReason =
  'end' | 'budget' | 'backstop' | 'cancelled' | 'approval_timeout' | 'location_lost' | 'error';

/**
 * Start a turn the user did not type in the composer: a Work run's first turn, a schedule fire,
 * a goal continuation, a sub-agent's task. The text is stored as a user-role message labelled
 * with `authorKind`, shown with that label in the thread.
 */
export interface StartTurnInput {
  accountId: string;
  threadId: string;
  text: string;
  trigger: TurnTrigger;
  /** The schedule, goal, run or parent-run id behind it (turn.trigger_ref). */
  triggerRef?: string | null;
  /** The run the turn belongs to (turn.run_id) and its goal (turn.goal_id). */
  runId?: string | null;
  goalId?: string | null;
  /**
   * Whose words `text` carries (FR-189). `user`: the signed-in user typed it in a Nova client
   * (a run objective, a schedule's instructions, a redirect); `source` says where, for the
   * audit trail (`run:<id>`, `schedule:<id>`). `none`: anything else (a goal continuation, a
   * sub-agent task the model wrote, an agent-made schedule); the turn is tainted with `origin`.
   */
  authority: { kind: 'user'; source: string } | { kind: 'none'; origin: Origin };
  authorKind: 'user' | 'run' | 'schedule' | 'goal' | 'subagent' | 'system';
  model?: string;
  /** Files attached to the text (attachment ids of the thread). */
  attachmentIds?: string[];
}

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface TurnOutcome {
  turnId: string;
  status: 'completed' | 'interrupted' | 'failed';
  stop: TurnStopReason;
  /** The final reply's text (the last assistant message of the turn). */
  replyText: string;
  steps: number;
  usage: TurnUsage;
  /** Wall-clock time the turn ran, approval and user-input waits excluded. */
  activeMs: number;
  /** The bound that ended it, when `stop` is `budget`. */
  bound?: BoundHit;
  error?: { code: string; message: string };
}

export interface StartedTurn {
  turnId: string;
  messageId: string;
  /** Settles when the turn (and any hook continuation chain) has ended. */
  done: Promise<TurnOutcome>;
}

/** Implemented by the ChatService (the loop agent); used by runs, schedules, goals, sub-agents. */
export interface TurnStarter {
  startTurn(input: StartTurnInput): Promise<StartedTurn>;
  /** Cancel the running turn of a thread, if any (a run's cancel or pause). */
  cancel(accountId: string, threadId: string): Promise<void>;
}

// ---- shaping turns (per mode) ------------------------------------------------------------------

/** A run budget that was reached (FR-182). */
export interface BoundHit {
  bound: 'time' | 'tokens' | 'cost';
  used: number;
  limit: number;
}

/** Checked by the loop before each model step; usage is recorded after each step. */
export interface TurnBounds {
  check(): BoundHit | null;
  record(step: TurnUsage & { activeMs: number }): void;
}

/** One block of context a mode adds to a turn (docs/09 §11). */
export interface ContextBlock {
  /** Heading shown to the model, e.g. "Run objective", "Plan", "Goal", "Environment". */
  label: string;
  text: string;
  /**
   * Trusted blocks come from the user or from Nova itself (the objective the user typed, the
   * approved plan, the environment). Untrusted ones are wrapped as untrusted data.
   */
  trusted: boolean;
  /** Where an untrusted block came from; it taints the turn with this origin (default `tool`). */
  origin?: Origin;
}

export interface TurnAddition {
  /** The run (and goal) the turn belongs to: recorded on the turn and its usage (docs/06). */
  runId?: string | null;
  goalId?: string | null;
  context?: ContextBlock[];
  bounds?: TurnBounds;
  /** Called once when the turn ends (after its hook continuations). */
  onEnd?(outcome: TurnOutcome): Promise<void>;
}

/**
 * A mode's contribution to each turn on its threads (Work runs, Code sessions, goals). The loop
 * asks every extension when a turn starts; each returns null for threads it does not own.
 */
export interface TurnExtension {
  forTurn(input: {
    accountId: string;
    threadId: string;
    turnId: string;
    mode: 'chat' | 'work' | 'code' | 'agent';
    trigger: TurnTrigger;
    projectId: string | null;
  }): Promise<TurnAddition | null>;
}

// ---- runs (FR-051, FR-059, FR-186) ---------------------------------------------------------------

export interface CreateRunInput {
  accountId: string;
  objective: string;
  title?: string;
  projectId?: string | null;
  origin: RunOrigin;
  /** The chat, schedule, trigger or parent run behind it. */
  originRef?: string | null;
  parentRunId?: string | null;
  autonomy?: RunAutonomy;
  budgets?: { timeSeconds?: number; tokens?: number; costUsd?: number | null };
  expectedOutput?: ExpectedOutput | null;
  /** As StartTurnInput.authority: a user-typed objective carries the user's authority. */
  authority: StartTurnInput['authority'];
  /** `planning`: wait for the user to accept (chat escalation `propose`); else start. */
  start: boolean;
  model?: string;
}

/** Implemented by the runs area; used by the scheduler, chat escalation and delegation. */
export interface RunStarter {
  createRun(input: CreateRunInput): Promise<{ runId: string; threadId: string }>;
  /** Settles when the run reaches a final status (done, output_missing, failed, cancelled). */
  whenFinished(accountId: string, runId: string): Promise<RunFinish>;
}

export interface RunFinish {
  runId: string;
  status: 'done' | 'output_missing' | 'failed' | 'cancelled';
  summary: string | null;
  artifactIds: string[];
}

// ---- per-thread policy (Code sessions, FR-063, FR-190) -------------------------------------------

/**
 * What a thread's mode sets for the gate and the tool runtime: the permission mode's approval
 * policy and profile, and the session's roots. Null fields fall back to the settings.
 */
export interface ThreadPolicy {
  approvalPolicy: ApprovalPolicyKind | null;
  profileId: string | null;
  /** The session's folder (and worktree) as roots; replaces the settings' roots when set. */
  roots: ToolRoot[] | null;
  /** For display and audit (PolicyContext.preset.permissionMode). */
  permissionMode: PermissionMode | null;
  /** File edits inside writable roots are allowed and captured as diffs (Accept edits). */
  autoAcceptEdits: boolean;
}

export interface ThreadPolicySource {
  forThread(accountId: string, threadId: string): Promise<ThreadPolicy | null>;
}

// ---- auto-review (FR-085, ADR-061) ---------------------------------------------------------------

export interface ReviewInput {
  accountId: string;
  threadId: string;
  runId: string | null;
  tool: ToolDescriptor;
  /** Redacted arguments. */
  args: unknown;
  /** What the engine decided before the reviewer (always `allow` with `review: true`). */
  decision: { reason: string; tier: string; effects: string[] };
  /** The user's typed instructions for the run, newest last (FR-189). */
  instructions: string[];
  /** A bounded summary of the run so far; untrusted content stays delimited. */
  summary: string;
  signal: AbortSignal;
}

/** Runs after the deterministic engine and can only tighten (FR-085). Fails closed to deny. */
export interface Reviewer {
  review(
    input: ReviewInput,
  ): Promise<ReviewVerdict & { attempts: number; failed: boolean; model?: string | null }>;
}

// ---- server-to-client requests (FR-188) ----------------------------------------------------------

export interface AskInput {
  accountId: string;
  kind: Exclude<ServerRequestKind, 'approval'>;
  correlation: { threadId?: string; turnId?: string; runId?: string; callId?: string };
  payload: Record<string, unknown>;
  timeoutMs: number;
  targetDeviceId?: string | null;
}

export type AskResult =
  | { status: 'resolved'; result: unknown; by: string }
  | { status: 'expired' }
  | { status: 'cancelled' };

/** Ask connected clients; one resolution, the first valid answer wins (FR-188). */
export interface RequestBroker {
  ask(input: AskInput, signal: AbortSignal): Promise<AskResult>;
}

// ---- thread status (FR-215) ----------------------------------------------------------------------

/** What a mode knows about blocked work, for the derived thread status. */
export interface ThreadStatusSource {
  /** Threads that are blocked, with a short reason ("Budget reached", "Goal blocked"). */
  blocked(accountId: string, threadIds: string[]): Promise<Map<string, string>>;
  /** Child threads (sub-agents) whose status counts toward the parent's. */
  children(accountId: string, threadId: string): Promise<string[]>;
}
