// Display helpers for Work runs, goals, sub-agents and schedules (docs/04 §1.1, §2.3, §2.3.1;
// docs/09 §2.1, §6). Pure functions, so the views and their tests share one wording. The words
// are messages and the amounts go through `fmt` (FR-016): read them at render time so they follow
// the active locale.
import { defineMessages, fmt } from '@nova/i18n';
import type {
  BudgetAmounts,
  DerivedStatus,
  GoalStatus,
  RunPauseReason,
  RunPlanStep,
  RunStatus,
  RunView,
  ScheduleOutcome,
  StatusView,
  SubagentView,
} from '@nova/shared';
import type { IconName } from '@nova/ui';

/** Words the Work screens share. */
export const WORK_TEXT = defineMessages('work', {
  work: 'Work',
  retry: 'Retry',
  cancel: 'Cancel',
  edit: 'Edit',
  delete: 'Delete',
  loading: 'Loading…',
  paused: 'Paused',
  titleOptional: 'Title (optional)',
  project: 'Project',
  noProject: 'No project',
  expectedOutput: 'Expected output',
  outputRef: 'Output name or path (optional)',
  /** A count of characters typed against the limit: "29 / 8,000 characters". */
  characters: '{n} / {max, plural, one {# character} other {# characters}}',
});

/** What a run or a schedule declares it delivers (FR-187). */
export const OUTPUT_KIND_TEXT = defineMessages('work.outputKinds', {
  none: 'None',
  artifact: 'An artifact',
  message: 'A delivered message',
  file: 'A file',
});

export const RUN_STATUS_TEXT = defineMessages('work.runStatus', {
  planning: 'Planning',
  running: 'Running',
  waiting_approval: 'Waiting for approval',
  paused: 'Paused',
  done: 'Done',
  output_missing: 'Output missing',
  failed: 'Failed',
  cancelled: 'Cancelled',
});

export const PAUSE_REASON_TEXT = defineMessages('work.pauseReason', {
  user: 'Paused by you',
  budget_time: 'Budget reached: time',
  budget_tokens: 'Budget reached: tokens',
  budget_cost: 'Budget reached: cost',
  backstop: 'Step limit reached',
  usage_limit: 'Usage limit',
  approval_timeout: 'Approval timed out',
  review_breaker: 'Stopped by auto-review',
  safety: 'Paused by safety monitoring',
  error: 'Paused after an error',
});

const FINAL: readonly RunStatus[] = ['done', 'output_missing', 'failed', 'cancelled'];

/** A run in a final status never runs again (docs/09 §2). */
export function isFinal(status: RunStatus): boolean {
  return FINAL.includes(status);
}

/** The run status as one line: "Paused: budget reached: time" reads as "Budget reached: time". */
export function runStatusLine(r: Pick<RunView, 'status' | 'pauseReason'>): string {
  if (r.status === 'paused' && r.pauseReason) return PAUSE_REASON_TEXT[r.pauseReason];
  return RUN_STATUS_TEXT[r.status];
}

/** The bound a budget pause hit (FR-182), or null for any other pause. */
export function budgetBound(
  reason: RunPauseReason | null,
): 'time' | 'tokens' | 'cost' | 'backstop' | null {
  switch (reason) {
    case 'budget_time':
      return 'time';
    case 'budget_tokens':
      return 'tokens';
    case 'budget_cost':
      return 'cost';
    case 'backstop':
      return 'backstop';
    default:
      return null;
  }
}

export const GOAL_STATUS_TEXT = defineMessages('work.goalStatus', {
  active: 'Active',
  paused: 'Paused',
  blocked: 'Blocked',
  usage_limited: 'Usage limit',
  budget_limited: 'Budget reached',
  complete: 'Complete',
});

export const GOAL_STATUS_ICON: Record<GoalStatus, IconName> = {
  active: 'forward',
  paused: 'clock',
  blocked: 'stop',
  usage_limited: 'clock',
  budget_limited: 'stop',
  complete: 'check',
};

export const STEP_TEXT = defineMessages('work.stepStatus', {
  pending: 'To do',
  running: 'In progress',
  done: 'Done',
  failed: 'Failed',
  skipped: 'Skipped',
});

export const STEP_ICON: Record<RunPlanStep['status'], IconName | null> = {
  pending: 'clock',
  running: null,
  done: 'check',
  failed: 'alert',
  skipped: 'forward',
};

export const SUBAGENT_TEXT = defineMessages('work.subagentStatus', {
  queued: 'Queued',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
});

export const SUBAGENT_ICON: Record<SubagentView['status'], IconName | null> = {
  queued: 'clock',
  running: null,
  done: 'check',
  failed: 'alert',
  cancelled: 'stop',
};

export const OUTCOME_TEXT = defineMessages('work.outcome', {
  done: 'Done',
  output_missing: 'Output missing',
  failed: 'Failed',
  cancelled: 'Cancelled',
  no_news: 'No news',
});

export const OUTCOME_ICON: Record<ScheduleOutcome, IconName> = {
  done: 'check',
  output_missing: 'alert',
  failed: 'alert',
  cancelled: 'stop',
  no_news: 'bell',
};

export const AUTONOMY_TEXT = defineMessages('work.autonomy', {
  ask_first: {
    label: 'Ask first',
    description: 'Shows the plan and waits for you to approve it before starting.',
  },
  standard: {
    label: 'Standard',
    description: 'Shows the plan and starts at once. You can edit it while the run works.',
  },
  autonomous: {
    label: 'Autonomous',
    description: 'Skips the plan. Actions still follow your permissions and approvals.',
  },
});

const RANK: Record<DerivedStatus, number> = { needs_input: 0, blocked: 1, running: 2, ready: 3 };

/** Precedence of a status: Needs input, Blocked, Running, Ready (docs/04 §1.1). */
export function statusRank(s: DerivedStatus): number {
  return RANK[s];
}

/** Needs input first, then Blocked, Running and Ready; most recent first within a group. */
export function sortByStatus<T extends { derived: StatusView; updatedAt: string }>(
  list: readonly T[],
): T[] {
  return [...list].sort(
    (a, b) =>
      statusRank(a.derived.status) - statusRank(b.derived.status) ||
      b.updatedAt.localeCompare(a.updatedAt),
  );
}

/** Amounts and progress in words. Formatted amounts arrive as placeholders. */
export const AMOUNT_TEXT = defineMessages('work.amounts', {
  /** Whole minutes of run time: "45 min". */
  minutes: '{n, plural, other {# min}}',
  days: '{n, plural, one {# day} other {# days}}',
  /** A token count in thousands: "12.4K". */
  thousands: '{n}K',
  /** A token count in millions: "0.5M", "2M". */
  millions: '{n}M',
  /** A formatted token count: "2M tokens", "800 tokens". */
  tokens: '{amount} tokens',
  /** A cost budget: "$5.00 limit". */
  costLimit: '{cost} limit',
  /** The cost budget when none is set: the provider's own spend cap applies (FR-116). */
  spendCap: 'provider spend cap',
  /** Run time used against its budget, in whole minutes: "12 / 60 min". */
  minutesOf: '{used} / {total} min',
  /** Tokens used against the budget: "0.3M / 2M tokens". */
  tokensOf: '{used} / {total} tokens',
  /** An amount used against its budget, both formatted: "$0.12 / $5.00". */
  of: '{used} / {total}',
  stepOf: 'Step {n} of {total}',
  stepsDone: '{done} of {total, plural, one {# step} other {# steps}} done',
  /** In the progress line after the status: "Running · step 2 of 3 · 12 min · 0.3M tokens". */
  stepInLine: 'step {n} of {total}',
  notScheduled: 'Not scheduled',
});

const trim = (n: number, digits: number) => Number(n.toFixed(digits));

/** Whole minutes, as the run header shows time ("42"). */
export function minutes(seconds: number): number {
  return Math.round(Math.max(0, seconds) / 60);
}

/** "45 min", "2 h", "1 h 30 min", "7 days". */
export function formatSpan(seconds: number): string {
  const m = minutes(seconds);
  if (m < 60) return AMOUNT_TEXT.minutes({ n: m });
  if (m % 1440 === 0) return AMOUNT_TEXT.days({ n: m / 1440 });
  return fmt.duration(m * 60_000);
}

/** "800", "12K", "0.5M", "2M". */
export function formatTokens(n: number): string {
  const v = Math.max(0, Math.round(n));
  if (v >= 100_000) return AMOUNT_TEXT.millions({ n: trim(v / 1_000_000, 2) });
  if (v >= 1_000) return AMOUNT_TEXT.thousands({ n: trim(v / 1_000, 1) });
  return fmt.number(v);
}

/** US dollars, as providers bill: "$1.80". */
export function formatCost(usd: number): string {
  return fmt.number(Math.max(0, usd), { style: 'currency', currency: 'USD' });
}

/** "60 min · 2M tokens · provider spend cap" (docs/04 §2.2.1). */
export function budgetLine(b: RunView['budgets']): string {
  return [
    formatSpan(b.timeSeconds),
    AMOUNT_TEXT.tokens({ amount: formatTokens(b.tokens) }),
    b.costUsd === null
      ? AMOUNT_TEXT.spendCap
      : AMOUNT_TEXT.costLimit({ cost: formatCost(b.costUsd) }),
  ].join(' · ');
}

/** "12 / 60 min · 0.3M / 2M tokens · $0.12": consumption against each budget. */
export function usageLine(used: RunView['used'], b: RunView['budgets']): string {
  return [
    AMOUNT_TEXT.minutesOf({ used: minutes(used.timeSeconds), total: minutes(b.timeSeconds) }),
    AMOUNT_TEXT.tokensOf({ used: formatTokens(used.tokens), total: formatTokens(b.tokens) }),
    b.costUsd === null
      ? formatCost(used.costUsd)
      : AMOUNT_TEXT.of({ used: formatCost(used.costUsd), total: formatCost(b.costUsd) }),
  ].join(' · ');
}

/** "Step 2 of 3", counting the running step, or the steps done when none runs. */
export function stepLine(plan: RunPlanStep[] | null): string | null {
  if (!plan?.length) return null;
  const running = plan.findIndex((s) => s.status === 'running');
  if (running >= 0) return AMOUNT_TEXT.stepOf({ n: running + 1, total: plan.length });
  const done = plan.filter((s) => s.status === 'done' || s.status === 'skipped').length;
  return AMOUNT_TEXT.stepsDone({ done, total: plan.length });
}

/** What the run card and the header announce: "Running · step 2 of 3 · 12 min · 0.3M tokens". */
export function progressLine(r: RunView): string {
  const running = r.plan?.findIndex((s) => s.status === 'running') ?? -1;
  const parts = [runStatusLine(r)];
  if (running >= 0 && r.plan)
    parts.push(AMOUNT_TEXT.stepInLine({ n: running + 1, total: r.plan.length }));
  parts.push(
    formatSpan(r.used.timeSeconds),
    AMOUNT_TEXT.tokens({ amount: formatTokens(r.used.tokens) }),
  );
  return parts.join(' · ');
}

/** Budget amounts as a short phrase, e.g. "30 min, 1M tokens". */
export function amountsText(a: BudgetAmounts): string {
  const parts: string[] = [];
  if (a.timeSeconds !== undefined) parts.push(formatSpan(a.timeSeconds));
  if (a.tokens !== undefined) parts.push(AMOUNT_TEXT.tokens({ amount: formatTokens(a.tokens) }));
  if (a.costUsd !== undefined) parts.push(formatCost(a.costUsd));
  return fmt.list(parts, { type: 'unit', style: 'short' });
}

/** A local date and time, e.g. "Oct 20, 2026, 9:00 AM". */
export function formatDateTime(iso: string | null): string {
  if (!iso) return AMOUNT_TEXT.notScheduled;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return fmt.dateTime(d, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Only web links are followed from evidence; anything else stays text. */
export function webLink(s: string): string | null {
  try {
    const u = new URL(s.trim());
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

export function runPath(id: string): string {
  return `/work/${encodeURIComponent(id)}`;
}

export const SCHEDULED_PATH = '/work/scheduled';
