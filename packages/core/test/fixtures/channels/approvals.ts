// An in-memory approvals flow for the M7 channel tests: approvals the test adds to a thread, and
// the decisions channels make (button presses, signed email links), recorded with who decided.
import { NovaError, uuidv7, type ApprovalView } from '@nova/shared';
import type { ApprovalRequests } from '../../../src/index.ts';

export class FakeApprovals implements ApprovalRequests {
  readonly items = new Map<string, ApprovalView>();
  readonly decided: { id: string; decision: string; by: string }[] = [];

  add(threadId: string, over: Partial<ApprovalView> = {}): ApprovalView {
    const now = new Date();
    const a: ApprovalView = {
      id: uuidv7(),
      threadId,
      turnId: null,
      callId: null,
      action: 'Post the weekly update to status.example',
      tool: 'web.post',
      argsPreview: null,
      reason: 'A rule asks first',
      tier: 'pre_approvable',
      risk: 'medium',
      userAsked: false,
      ruleId: null,
      options: ['allow_once', 'allow_session', 'deny_continue', 'deny_stop', 'handoff'],
      alwaysScopes: [],
      status: 'pending',
      decision: null,
      decidedBy: null,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
      decidedAt: null,
      ...over,
    };
    this.items.set(a.id, a);
    return a;
  }

  pending(_accountId: string, threadId?: string): Promise<ApprovalView[]> {
    return Promise.resolve(
      [...this.items.values()].filter(
        (a) => a.status === 'pending' && (!threadId || a.threadId === threadId),
      ),
    );
  }

  get(_accountId: string, id: string): Promise<ApprovalView> {
    const a = this.items.get(id);
    return a ? Promise.resolve(a) : Promise.reject(new NovaError('not_found', 'no approval'));
  }

  decide(
    _accountId: string,
    body: { approvalId: string; decision: string },
    by: string,
  ): Promise<ApprovalView> {
    const a = this.items.get(body.approvalId);
    if (!a || a.status !== 'pending')
      return Promise.reject(new NovaError('conflict', 'already decided'));
    const next: ApprovalView = {
      ...a,
      status: 'decided',
      decision: body.decision as ApprovalView['decision'],
      decidedBy: by,
      decidedAt: new Date().toISOString(),
    };
    this.items.set(a.id, next);
    this.decided.push({ id: a.id, decision: body.decision, by });
    return Promise.resolve(next);
  }
}
