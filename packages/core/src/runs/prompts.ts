// The words Nova adds to run turns (docs/09 §2-§4, §13): how-to-run instructions per autonomy
// level, the deep research template (FR-220), continuation texts and generated progress notes.
// These come from Nova itself, so they go to the model as trusted context; anything the model or
// a page wrote stays in untrusted blocks (FR-189).
import type { RunAutonomy, RunPlanStep } from '@nova/shared';

/** Tools a researcher sub-agent may use: read-only web and file tools (FR-220). */
export const RESEARCH_TOOLS = ['web.search', 'web.fetch', 'fs.read', 'fs.list', 'fs.search'];

/** Tool names that only read; a child limited to these gets the read-only profile. */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  ...RESEARCH_TOOLS,
  'tool.search',
  'goal.get',
  'task.list',
]);

export function howToRun(autonomy: RunAutonomy, planning: boolean): string {
  const tail =
    'Mark steps with plan.update as you go. When the objective is met, call run.complete with a ' +
    'short summary, the ids of any artifacts you saved and the evidence that the work is done. ' +
    'Budgets and approvals are enforced by Nova; do not try to work around them.';
  if (planning)
    return (
      'This is a Work run that asks the user first. In this turn, only propose a plan: call ' +
      'plan.set with the ordered steps (a short title each, and a detail when it helps), then ' +
      'stop and say the plan is ready. Do not carry out any step yet; the user approves the plan ' +
      'before the work starts.'
    );
  if (autonomy === 'autonomous')
    return `This is a Work run. Carry out the objective with your tools until it is done. ${tail}`;
  return (
    'This is a Work run. First record a short plan with plan.set (ordered steps, a title each), ' +
    `then carry it out with your tools. ${tail}`
  );
}

export const DEEP_RESEARCH =
  'This is a deep research run. 1. Split the question into 3 to 6 sub-questions and record them ' +
  'with plan.set, one step each. 2. For each sub-question call task.spawn with role ' +
  `"researcher", the sub-question as the objective and tools ${JSON.stringify(RESEARCH_TOOLS)}. ` +
  '3. Call task.wait until every researcher has finished, and mark each step with plan.update. ' +
  '4. Write a report that answers the question, links every claim to its source with a ' +
  'bracketed number such as [1], and ends with a numbered list of sources (title and URL or ' +
  'path). Save it with artifact.create (kind "markdown"). 5. Call run.complete with a short ' +
  "summary and the report's artifact id. The run succeeds only when the report is saved.";

export function subagentBrief(role: string): string {
  return (
    `You are a ${role} sub-agent of a Work run. Do only the task you were given, with the tools ` +
    'you have, and end with a concise result: your final reply is returned to the run that ' +
    'started you. You cannot start sub-agents yourself.'
  );
}

export function continueText(progress: string | null): string {
  const base = 'Continue the run from where it stopped, following the plan.';
  return progress ? `${base}\n\nLast progress: ${clipText(progress, 2000)}` : base;
}

export const START_TEXT = 'The plan is approved. Carry it out now.';

export const CHILDREN_DONE_TEXT =
  'Your sub-agents have finished. Collect their results with task.list, then finish the run.';

export function goalContinuationText(input: {
  objective: string;
  remaining: string;
  progress: string | null;
}): string {
  const lines = [
    'Continue working toward the goal.',
    `Remaining budget: ${input.remaining}.`,
    input.progress ? `Last progress note: ${clipText(input.progress, 2000)}` : null,
    'Record progress with goal.update. When the goal is met, call goal.update with status ' +
      '"complete" and a progressNote summarizing the result. If you cannot progress, report the ' +
      'blocker with goal.update({blocker}).',
  ];
  return lines.filter((l): l is string => l !== null).join('\n');
}

/** A progress note written without a model call (docs/09 §2, FR-182). */
export function progressSummary(input: {
  steps: number;
  plan: RunPlanStep[];
  reason: string;
}): string {
  const done = input.plan.filter((s) => s.status === 'done').length;
  const next = input.plan.find((s) => s.status === 'running' || s.status === 'pending');
  const parts = [`Paused (${input.reason}) after ${input.steps} model steps.`];
  if (input.plan.length) parts.push(`Plan: ${done} of ${input.plan.length} steps done.`);
  if (next) parts.push(`Next: ${next.title}.`);
  return parts.join(' ');
}

export function formatPlan(plan: RunPlanStep[]): string {
  return plan
    .map((s) => {
      const detail = s.detail ? ` — ${clipText(s.detail, 300)}` : '';
      return `- idx ${s.idx} [${s.status}] ${s.title}${detail}`;
    })
    .join('\n');
}

export function clipText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Human words for a pause reason (the derived status and notifications). */
export const PAUSE_WORDS: Record<string, string> = {
  user: 'Paused',
  budget_time: 'Budget reached',
  budget_tokens: 'Budget reached',
  budget_cost: 'Budget reached',
  backstop: 'Step limit reached',
  usage_limit: 'Usage limit reached',
  approval_timeout: 'Approval timed out',
  review_breaker: 'Stopped by review',
  safety: 'Paused for safety',
  error: 'Error',
};
