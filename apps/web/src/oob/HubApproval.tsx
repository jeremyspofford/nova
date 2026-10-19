// An approval card shown where its action is asked for (out-of-band actions, BIOS plans,
// decommissioning a device): the existing card (src/chat/ApprovalCard.tsx), which says when it is
// Hub-only (`answerIn: 'hub'`: answered only by the signed-in owner in Nova, never from a channel,
// a link or a hook; docs/23 §6.3), with the way to the Approvals page. It stays current with `approval.decided` and
// `approval.cancelled`, and calls `onSettled` once it no longer waits, so the caller can reload
// what the decision changed.
import { useEffect, useState } from 'react';
import { Icon, Spinner } from '@nova/ui';
import { ApprovalCard } from '../chat/ApprovalCard.tsx';
import { awaitsUser, type ClientApproval } from '../chat/thread-state.ts';
import { useHubStream } from '../hub-events.ts';
import { useServices } from '../services.tsx';
import { followLink } from '../work/nav.tsx';
import { oobErrorMessage } from './format.ts';

const APPROVAL_CHANGES = ['approval.decided', 'approval.cancelled'] as const;
/** The Approvals page (src/dispatch/ApprovalsPage.tsx), focused on one card. */
const approvalsPath = (id: string) => `/approvals?focus=${encodeURIComponent(id)}`;

/**
 * Where a card may be answered, besides here. A Hub-only card says so itself
 * (src/chat/ApprovalCard.tsx), so only the way to the Approvals page is added.
 */
export function answerWhereText(a: Pick<ClientApproval, 'answerIn'>): string {
  return a.answerIn === 'hub'
    ? 'It also waits on the Approvals page.'
    : 'Answer it here or on the Approvals page.';
}

export function InlineApproval({
  approvalId,
  onSettled,
}: {
  approvalId: string;
  onSettled?: () => void;
}) {
  const { api } = useServices();
  const [approval, setApproval] = useState<ClientApproval | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    api.getApproval(approvalId).then(
      (a) => {
        if (!alive) return;
        setApproval((prev) => ({ ...prev, ...a }));
        setError(null);
      },
      (err: unknown) => alive && setError(err),
    );
    return () => {
      alive = false;
    };
  }, [api, approvalId, attempt]);
  useHubStream(APPROVAL_CHANGES, (env) => {
    if (env.payload.approvalId === approvalId) setAttempt((n) => n + 1);
  });

  if (error && !approval)
    return (
      <p role="alert" className="nv-field-error">
        {oobErrorMessage(error, 'Could not load the approval.')}
      </p>
    );
  if (!approval) return <Spinner label="Loading the approval" />;
  const waiting = awaitsUser(approval);
  return (
    <div className="oob-approval">
      {waiting ? (
        <p className="muted ws-flush oob-approval-where">
          <Icon name="shield" /> {answerWhereText(approval)}{' '}
          <a
            href={approvalsPath(approval.id)}
            onClick={(e) => followLink(e, approvalsPath(approval.id))}
          >
            Open in Approvals
          </a>
        </p>
      ) : null}
      <ApprovalCard
        approval={approval}
        onChange={(next) => {
          setApproval(next);
          if (!awaitsUser(next)) onSettled?.();
        }}
      />
    </div>
  );
}
