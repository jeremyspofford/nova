// Rows of the runs tables (migration 0016) and their API views (packages/shared RunView, GoalView,
// SubagentView). Usage shown live comes from the supervisor's meters when a run is active.
import type {
  ExpectedOutput,
  GoalView,
  RunPlanStep,
  RunView,
  StatusView,
  SubagentView,
} from '@nova/shared';
import type { schema } from '@nova/storage';

export type RunRow = typeof schema.run.$inferSelect;
export type GoalRow = typeof schema.goal.$inferSelect;
export type RunStepRow = typeof schema.runStep.$inferSelect;
export type SubagentRow = typeof schema.subagent.$inferSelect;

export const FINAL_STATUSES: ReadonlySet<RunRow['status']> = new Set([
  'done',
  'output_missing',
  'failed',
  'cancelled',
]);

export function isFinal(status: RunRow['status']): boolean {
  return FINAL_STATUSES.has(status);
}

export interface Usage {
  timeMs: number;
  tokens: number;
  costUsd: number;
}

export interface RunResult {
  summary: string;
  artifactIds: string[];
  evidence: string[];
}

export function parseJson<T>(text: string | null): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export function toStepView(r: RunStepRow): RunPlanStep {
  return {
    idx: r.idx,
    title: r.title,
    status: r.status,
    detail: parseJson<string>(r.detailJson),
    startedAt: r.startedAt,
    endedAt: r.endedAt,
  };
}

export function toRunView(input: {
  row: RunRow;
  steps: RunStepRow[];
  goalId: string | null;
  derived: StatusView;
  used?: Usage | null;
  /** The cloud environment of a cloud Work run (M7). */
  environmentId?: string | null;
}): RunView {
  const r = input.row;
  const used = input.used ?? { timeMs: r.timeUsedMs, tokens: r.tokensUsed, costUsd: r.costUsedUsd };
  const result = parseJson<RunResult>(r.resultJson);
  return {
    id: r.id,
    title: r.title,
    objective: r.objective,
    threadId: r.threadId,
    projectId: r.projectId,
    parentRunId: r.parentRunId,
    origin: r.origin,
    originRef: r.originRef,
    status: r.status,
    pauseReason: r.status === 'paused' ? r.pauseReason : null,
    autonomy: r.autonomy,
    plan: input.steps.length ? input.steps.map(toStepView) : null,
    planApproved: r.planApproved,
    budgets: { timeSeconds: r.timeBudgetS, tokens: r.tokenBudget, costUsd: r.costBudgetUsd },
    used: {
      timeSeconds: Math.floor(used.timeMs / 1000),
      tokens: used.tokens,
      costUsd: roundCost(used.costUsd),
    },
    expectedOutput: parseJson<ExpectedOutput>(r.expectedOutputJson),
    outputVerifiedAt: r.outputVerifiedAt,
    result: result
      ? { summary: result.summary, artifactIds: result.artifactIds, evidence: result.evidence }
      : null,
    goalId: input.goalId,
    derived: input.derived,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    endedAt: r.endedAt,
    environmentId: input.environmentId ?? null,
  };
}

export function toGoalView(g: GoalRow, used?: Usage | null): GoalView {
  const u = used ?? { timeMs: g.timeUsedMs, tokens: g.tokensUsed, costUsd: g.costUsedUsd };
  const budgets: GoalView['budgets'] = {};
  if (g.timeBudgetS !== null) budgets.timeSeconds = g.timeBudgetS;
  if (g.tokenBudget !== null) budgets.tokens = g.tokenBudget;
  if (g.costBudgetUsd !== null) budgets.costUsd = g.costBudgetUsd;
  return {
    id: g.id,
    runId: g.runId,
    agentId: g.agentId,
    threadId: g.threadId,
    objective: g.objective,
    status: g.status,
    statusSetBy: g.statusSetBy,
    statusReason: g.statusReason,
    progressNote: g.progressNote,
    completionSummary: g.completionSummary,
    budgets,
    usage: {
      timeSeconds: Math.floor(u.timeMs / 1000),
      tokens: u.tokens,
      costUsd: roundCost(u.costUsd),
    },
    blocker: g.blockerKey
      ? { key: g.blockerKey, description: g.blockerDescription, count: g.blockerCount }
      : null,
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
    completedAt: g.completedAt,
  };
}

export function toSubagentView(s: SubagentRow): SubagentView {
  const result = parseJson<{ summary?: unknown }>(s.resultJson);
  return {
    id: s.id,
    runId: s.runId,
    threadId: s.threadId,
    role: s.role,
    objective: s.objective,
    status: s.status,
    result: typeof result?.summary === 'string' ? result.summary : null,
    createdAt: s.createdAt,
    endedAt: s.endedAt,
  };
}

export function roundCost(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}
