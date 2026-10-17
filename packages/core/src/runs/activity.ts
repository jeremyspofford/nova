// A run's activity (FR-057): the run thread's own trace (turns, tool calls, approvals, policy
// decisions, built by ops/activity.ts) merged with the run's events (plan, steps, status changes,
// budget pauses and extensions, sub-agents, the goal and the result), oldest first. Event ids are
// UUIDv7, so ordering by id is ordering by time.
import type { ActivityItemView, EventEnvelope } from '@nova/shared';
import { buildActivity } from '../ops/activity.ts';

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const words = (v: unknown): string => (str(v) ?? '').replace(/_/g, ' ');

function notice(
  e: EventEnvelope,
  title: string,
  detail: string | null = null,
  status: string | null = null,
): ActivityItemView {
  return {
    id: e.id,
    ts: e.ts,
    kind: 'notice',
    title,
    detail,
    status,
    callId: null,
    turnId: str(e.payload.turnId) ?? e.correlation?.turnId ?? null,
  };
}

function stepCount(v: unknown): number {
  return Array.isArray(v) ? v.length : 0;
}

/** One run or goal event as an activity item; null for events that are not the run's. */
export function runEventItem(e: EventEnvelope): ActivityItemView | null {
  const p = e.payload;
  switch (e.name) {
    case 'run.created':
      return notice(e, 'Run created', str(p.objective));
    case 'run.plan.proposed':
      return notice(e, `Plan proposed (${stepCount(p.steps)} steps)`);
    case 'run.plan.amended':
      return notice(e, `Plan changed (${stepCount(p.steps)} steps)`, str(p.reason));
    case 'run.step.started':
      return notice(e, `Step started: ${str(p.title) ?? ''}`.trim(), null, 'running');
    case 'run.step.completed':
      return notice(e, `Step ${words(p.status) || 'finished'}`, str(p.detail), str(p.status));
    case 'run.status.changed': {
      const reason = str(p.pauseReason);
      return notice(
        e,
        `Run ${words(p.to)}`,
        reason ? `reason: ${reason.replace(/_/g, ' ')}` : null,
        str(p.to),
      );
    }
    case 'run.budget.reached':
      return notice(e, `Budget reached: ${words(p.bound)}`, str(p.summary), 'paused');
    case 'run.budget.extended':
      return notice(e, 'Budget extended');
    case 'run.subagent.spawned':
      return notice(e, `Sub-agent started: ${str(p.role) ?? 'sub-agent'}`, null, 'running');
    case 'run.subagent.completed':
      return notice(e, `Sub-agent ${words(p.status) || 'finished'}`, null, str(p.status));
    case 'run.completed':
      return notice(e, `Run ${words(p.status)}`, str(p.resultSummary), str(p.status));
    case 'goal.created':
      return notice(e, 'Goal set', str(p.objective));
    case 'goal.status.changed':
      return notice(e, `Goal ${words(p.to)}`, str(p.reason), str(p.to));
    default:
      return null;
  }
}

/** The thread's trace and the run's events, oldest first. */
export function runActivity(events: readonly EventEnvelope[]): ActivityItemView[] {
  const items = buildActivity(events);
  for (const e of events) {
    const it = runEventItem(e);
    if (it) items.push(it);
  }
  return items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
