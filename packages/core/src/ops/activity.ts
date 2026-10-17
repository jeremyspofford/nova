// A thread's activity trace (FR-104 partial; contracts/events.md: "Activity view renders
// persisted events filtered by correlation id"): turns, tool calls, approvals, policy decisions
// and a few notices, oldest first. Payload text is already redacted where it was produced.
import type { ActivityItemView, EventEnvelope } from '@nova/shared';

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);

function item(
  e: EventEnvelope,
  kind: ActivityItemView['kind'],
  title: string,
  rest: Partial<Pick<ActivityItemView, 'detail' | 'status' | 'callId' | 'turnId' | 'shots'>> = {},
): ActivityItemView {
  const p = e.payload;
  return {
    ...(rest.shots ? { shots: rest.shots } : {}),
    id: e.id,
    ts: e.ts,
    kind,
    title,
    detail: rest.detail ?? null,
    status: rest.status ?? null,
    callId: rest.callId ?? str(p.callId) ?? e.correlation?.callId ?? null,
    turnId: rest.turnId ?? str(p.turnId) ?? e.correlation?.turnId ?? null,
  };
}

/** Events in, activity items out (unknown events are skipped). */
export function buildActivity(events: readonly EventEnvelope[]): ActivityItemView[] {
  const tools = new Map<string, string>();
  const out: ActivityItemView[] = [];
  for (const e of events) {
    const p = e.payload;
    switch (e.name) {
      case 'turn.started':
        out.push(item(e, 'turn', 'Turn started', { status: 'running' }));
        break;
      case 'turn.completed': {
        const failed = p.status === 'failed';
        out.push(
          item(e, 'turn', failed ? 'Turn failed' : 'Turn completed', {
            status: str(p.status) ?? 'completed',
            detail: str(p.stopReason),
          }),
        );
        break;
      }
      case 'turn.interrupted':
        out.push(
          item(e, 'turn', 'Turn interrupted', {
            status: 'interrupted',
            detail: str(p.stopReason),
          }),
        );
        break;
      case 'tool.call.started': {
        const tool = str(p.tool) ?? 'tool';
        const callId = str(p.callId);
        if (callId) tools.set(callId, tool);
        out.push(item(e, 'tool_call', tool, { status: 'running', detail: str(p.argsPreview) }));
        break;
      }
      case 'tool.call.completed': {
        const callId = str(p.callId);
        const ms = num(p.durationMs);
        const tool = (callId && tools.get(callId)) ?? 'tool';
        const preview = str(p.resultPreview);
        out.push(
          item(e, 'tool_call', `${tool} ${str(p.status) ?? 'finished'}`, {
            status: str(p.status),
            detail: [preview, ms === null ? null : `${ms} ms`].filter(Boolean).join(' · ') || null,
          }),
        );
        break;
      }
      case 'approval.requested':
        out.push(
          item(e, 'approval', `Approval requested: ${str(p.action) ?? 'action'}`, {
            status: 'pending',
            detail: str(p.reason),
          }),
        );
        break;
      case 'approval.decided':
        out.push(
          item(e, 'approval', `Approval ${(str(p.decision) ?? 'decided').replace(/_/g, ' ')}`, {
            status: str(p.decision),
            detail: str(p.decidedBy) ? `by ${str(p.decidedBy)}` : null,
          }),
        );
        break;
      case 'policy.denied':
        out.push(
          item(e, 'policy', `Denied: ${str(p.tool) ?? 'tool'}`, {
            status: 'denied',
            detail: str(p.reason),
          }),
        );
        break;
      case 'policy.tier':
        out.push(
          item(
            e,
            'policy',
            `${str(p.action) ?? 'Action'}: ${(str(p.tier) ?? '').replace(/_/g, ' ')}`,
            {
              status: str(p.tier),
              detail: p.authorization === 'user_typed' ? 'you asked for this' : null,
            },
          ),
        );
        break;
      case 'chat.followup.queued':
        out.push(item(e, 'notice', 'Follow-up queued'));
        break;
      case 'chat.followup.started':
        out.push(item(e, 'notice', 'Queued follow-up started'));
        break;
      case 'chat.followup.cancelled':
        out.push(item(e, 'notice', 'Follow-up cancelled', { detail: str(p.error) }));
        break;
      case 'compaction.completed':
        out.push(item(e, 'notice', 'Context compacted'));
        break;
      // Computer use (FR-098): browser and screen actions with their screenshots.
      case 'browser.navigated': {
        const allowed = p.allowed !== false;
        out.push(
          item(
            e,
            'computer',
            `${allowed ? 'Browser opened' : 'Browser blocked'} ${str(p.url) ?? 'a page'}`,
            {
              status: allowed ? 'ok' : 'blocked',
            },
          ),
        );
        break;
      }
      case 'browser.action': {
        const id = str(p.actionId);
        const shot = (which: 'before' | 'after') =>
          id && p[which] === true ? `/api/v1/browser/actions/${id}/screenshots/${which}` : null;
        const what = [str(p.action) ?? 'action', str(p.target)].filter(Boolean).join(' ');
        out.push(
          item(e, 'computer', `Browser: ${what}`, {
            status: str(p.result),
            shots: id ? { before: shot('before'), after: shot('after') } : null,
          }),
        );
        break;
      }
      case 'screen.action': {
        const id = str(p.actionId);
        const computer = str(p.computerId);
        const base = id && computer ? `/api/v1/computers/${computer}/screen/actions/${id}` : null;
        const app = str(p.app);
        out.push(
          item(e, 'computer', `Screen: ${str(p.kind) ?? 'action'}${app ? ` in ${app}` : ''}`, {
            status: str(p.status),
            detail: str(p.error),
            shots: base ? { before: `${base}/before`, after: `${base}/after` } : null,
          }),
        );
        break;
      }
      default:
        break;
    }
  }
  return out;
}
