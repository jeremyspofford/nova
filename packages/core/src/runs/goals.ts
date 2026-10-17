// Goal rules the runtime enforces (FR-181, docs/09 §2.1, contracts/schemas/goal.json): who may set
// which status, the blocked rule (the same blocker on 3 consecutive goal turns) and budgets. Pure
// functions; the supervisor applies them.
import type { GoalStatus } from '@nova/shared';
import type { GoalRow, Usage } from './views.ts';

/** Consecutive goal turns with the same blocker before the agent may set `blocked`. */
export const BLOCKED_AFTER = 3;

/** A blocker key compared across turns: lower case, words only, at most 200 characters. */
export function normalizeBlockerKey(key: string): string {
  return key
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 200);
}

/** The blocker count after a goal turn reports `key` (once per turn). */
export function nextBlockerCount(
  g: Pick<GoalRow, 'blockerKey' | 'blockerCount' | 'blockerTurnId'>,
  key: string,
  turnId: string,
): number {
  if (g.blockerKey !== key) return 1;
  if (g.blockerTurnId === turnId) return g.blockerCount;
  return g.blockerCount + 1;
}

export type AgentStatusCheck = { ok: true } | { ok: false; message: string };

/**
 * May the agent move the goal to `to`? `userAsked` is true when the turn carries an instruction
 * the signed-in user typed (pausing needs the user's explicit request).
 */
export function checkAgentStatus(
  g: Pick<GoalRow, 'status' | 'blockerCount'>,
  to: GoalStatus,
  opts: { userAsked: boolean; hasSummary: boolean },
): AgentStatusCheck {
  if (g.status === to) return { ok: true };
  switch (to) {
    case 'usage_limited':
    case 'budget_limited':
      return { ok: false, message: `only Nova sets a goal to ${to}` };
    case 'active':
      return { ok: false, message: 'only the user can resume or reopen a goal' };
    case 'paused':
      return opts.userAsked
        ? { ok: true }
        : { ok: false, message: 'a goal is paused only when the user asks for it in this turn' };
    case 'blocked':
      return g.blockerCount >= BLOCKED_AFTER
        ? { ok: true }
        : {
            ok: false,
            message: `the same blocker must be reported with goal.update({blocker}) on ${BLOCKED_AFTER} consecutive goal turns before the goal can be blocked (now ${g.blockerCount})`,
          };
    case 'complete':
      return opts.hasSummary
        ? { ok: true }
        : { ok: false, message: 'completing a goal needs a progressNote summarizing the result' };
  }
}

/** User status changes through POST /goals/:id/{pause,resume,complete}. */
export function userTransition(
  from: GoalStatus,
  action: 'pause' | 'resume' | 'complete',
): GoalStatus | null {
  if (action === 'pause') return from === 'complete' || from === 'paused' ? null : 'paused';
  if (action === 'resume') return from === 'active' ? null : 'active';
  return from === 'complete' ? null : 'complete';
}

export interface GoalLimits {
  timeMs: number | null;
  tokens: number | null;
  costUsd: number | null;
}

export function goalLimits(g: GoalRow): GoalLimits {
  return {
    timeMs: g.timeBudgetS === null ? null : g.timeBudgetS * 1000,
    tokens: g.tokenBudget,
    costUsd: g.costBudgetUsd,
  };
}

/** The first goal budget that is used up, if any. */
export function goalHit(
  limits: GoalLimits,
  used: Usage,
): { bound: 'time' | 'tokens' | 'cost'; used: number; limit: number } | null {
  if (limits.timeMs !== null && used.timeMs >= limits.timeMs)
    return { bound: 'time', used: Math.floor(used.timeMs / 1000), limit: limits.timeMs / 1000 };
  if (limits.tokens !== null && used.tokens >= limits.tokens)
    return { bound: 'tokens', used: used.tokens, limit: limits.tokens };
  if (limits.costUsd !== null && used.costUsd >= limits.costUsd)
    return { bound: 'cost', used: used.costUsd, limit: limits.costUsd };
  return null;
}

/** "12 min, 400,000 tokens" — what is left of the tighter of the goal and run budgets. */
export function remainingText(
  run: { timeMs: number; tokens: number; costUsd: number | null },
  goal: GoalLimits | null,
  used: { run: Usage; goal: Usage | null },
): string {
  const left = (limit: number | null, u: number) =>
    limit === null ? null : Math.max(0, limit - u);
  const pick = (a: number | null, b: number | null) =>
    a === null ? b : b === null ? a : Math.min(a, b);
  const time = pick(
    left(run.timeMs, used.run.timeMs),
    goal && used.goal ? left(goal.timeMs, used.goal.timeMs) : null,
  );
  const tokens = pick(
    left(run.tokens, used.run.tokens),
    goal && used.goal ? left(goal.tokens, used.goal.tokens) : null,
  );
  const cost = pick(
    left(run.costUsd, used.run.costUsd),
    goal && used.goal ? left(goal.costUsd, used.goal.costUsd) : null,
  );
  const parts: string[] = [];
  if (time !== null) parts.push(`${Math.max(0, Math.round(time / 60_000))} min`);
  if (tokens !== null) parts.push(`${tokens.toLocaleString('en-US')} tokens`);
  if (cost !== null) parts.push(`$${cost.toFixed(2)}`);
  return parts.join(', ') || 'no limit';
}
