// What the agents area needs from other areas (bound late) and what it offers them (docs/09 §8).
import type { CommandRule, PolicyRule } from '@nova/policy';
import type { RunAutonomy, ScheduleView } from '@nova/shared';
import type { CreateRunInput, RunFinish } from '../runtime/types.ts';
import type { AgentScheduleOptions, ScheduleInput, SchedulePatch } from '../scheduler/service.ts';
import type { Origin } from '../tools/types.ts';

/** Settings the agents area reads (docs/14 §1; the `agents.*` keys). */
export interface AgentSettings {
  defaultBudgets(): Promise<{ timeSeconds: number; tokens: number; costUsd: number | null }>;
  autonomy(): Promise<RunAutonomy>;
  proactive(): Promise<{ enabledByDefault: boolean; intervalMinutes: number }>;
  wakes(): Promise<{ minMinutes: number; horizonDays: number; perDay: number }>;
  /** `review.model`: an autonomous agent needs a reviewer, or every consequential action is denied. */
  reviewModel(): Promise<string | null>;
}

/** The scheduler as agents use it; the schedules area's ScheduleService satisfies it. */
export interface AgentScheduler {
  createForAgent(
    accountId: string,
    input: ScheduleInput,
    opts: AgentScheduleOptions,
  ): Promise<ScheduleView>;
  update(
    accountId: string,
    id: string,
    patch: SchedulePatch,
    opts?: { actor?: string; agentId?: string },
  ): Promise<ScheduleView>;
  remove(accountId: string, id: string, opts?: { actor?: string }): Promise<void>;
  listForAgent(accountId: string, agentId: string): Promise<ScheduleView[]>;
}

/**
 * Work runs as agents use them (FR-059, FR-083, FR-090): the runs area's RunStarter (which
 * records `agentId` on the run) and the RunService's controls, which pause, resume and cancel
 * an agent's background work with it.
 */
export interface AgentRuns {
  createRun(
    input: CreateRunInput & { agentId?: string | null },
  ): Promise<{ runId: string; threadId: string }>;
  whenFinished(accountId: string, runId: string): Promise<RunFinish>;
  pause?(accountId: string, runId: string): Promise<unknown>;
  resume?(accountId: string, runId: string): Promise<unknown>;
  cancel?(accountId: string, runId: string): Promise<unknown>;
}

/**
 * Quiet hours from the notification rules (the channels area, FR-060): the quiet window that
 * contains `at`, or null outside quiet hours.
 */
export type QuietHours = (
  accountId: string,
  at: Date,
) => Promise<{ start: string; end: string } | null>;

/**
 * What another area revokes when an agent is deleted (FR-090): its channel bindings, grants,
 * triggers, its computer. A hook that throws stops the delete before anything is removed.
 */
export type AgentDeleteHook = (accountId: string, agentId: string) => Promise<void>;

/** The agent's persistent computer (FR-080): the computers area's ComputerProvider.forAgent. */
export interface AgentComputers {
  forAgent(accountId: string, agentId: string): Promise<{ id: string }>;
}

/**
 * What the policy gate adds for a thread of an agent (FR-084): the agent's rules as engine rules
 * scoped to that thread (the gate always has the thread scope), its command prefix rules, and in
 * a proactive research thread a deny for every action that is not read-only (FR-082).
 */
export interface AgentThreadPolicy {
  agentId: string;
  threadKind: 'main' | 'proactive' | 'binding' | 'background';
  rules: PolicyRule[];
  commandRules: CommandRule[];
}

export interface AgentPolicySource {
  /** Null for a thread no agent owns. Throws only on a storage failure (the gate fails closed). */
  forThread(accountId: string, threadId: string): Promise<AgentThreadPolicy | null>;
}

/** A channel binding asking for its thread (FR-088, docs/13 §4, ADR-070). */
export interface AgentBinding {
  bindingId: string;
  /** `private`: the owner's own channel; `shared`: other people read it. */
  audience: 'private' | 'shared';
  /** Shown in the thread title, e.g. "Slack #general". */
  title?: string | null;
  /** A private binding may share the agent's main thread instead of its own. */
  sharePrimary?: boolean;
}

export interface AgentThreadLink {
  agentId: string;
  threadId: string;
  kind: 'main' | 'proactive' | 'binding' | 'background';
  audience: 'private' | 'shared';
  bindingRef: string | null;
  runId: string | null;
}

/** A counterpart the agent would engage: a channel identity, an address or a name. */
export interface ExternalCounterpart {
  id: string;
  name?: string | null;
  /** The channel says the identity is a bot or an app. */
  isBot?: boolean;
}

/**
 * The external-agent rule (FR-194) for the channels and browser areas. `inbound` classifies
 * content as it arrives; `check` runs before the agent delegates to or sends data to a
 * counterpart. Denials are audited (kind `agent`, cause `external_agent`).
 */
export interface ExternalAgentGuard {
  /**
   * Content arriving on a channel, an email, a page, a plugin or a capture. When it comes from
   * an external agent, `accept` is false: start no turn from it as an instruction, and wrap it
   * with `origin` (`external_agent`) wherever it is shown to a model.
   */
  inbound(input: {
    accountId: string;
    agentId?: string | null;
    threadId?: string | null;
    source: Extract<Origin, 'channel' | 'email' | 'page' | 'plugin' | 'mcp' | 'capture'>;
    text: string;
    sender?: ExternalCounterpart | null;
  }): Promise<
    | { external: false; accept: true }
    | {
        external: true;
        accept: false;
        counterpart: string;
        evidence: string;
        origin: 'external_agent';
        reason: string;
      }
  >;
  /**
   * Before delegating to or sending data to `counterpart`. Allowed when it is not an AI agent,
   * or when the user named it for the current task (in `namedAgents`, or in the user's own
   * message that started the thread's current turn).
   */
  check(input: {
    accountId: string;
    agentId?: string | null;
    threadId?: string | null;
    counterpart: ExternalCounterpart | string;
    action: 'delegate' | 'send_data';
    namedAgents?: string[];
  }): Promise<{ allowed: boolean; external: boolean; reason: string }>;
}
