// A Hub-only approval card answered in place (docs/23 §6.3, docs/04 §2.6; ADR-096): firmware and
// boot changes open an approval card (`answerIn: 'hub'`, confirm-at-action, risk high) that only
// the signed-in owner may answer, in Nova: here or on the Approvals page; a chat channel, an email
// link or another agent cannot. The card says so, shows what it approves (the caller puts the diff
// next to it), and offers exactly "Allow once" and "Deny". The first answer wins: a 409 means it
// was answered elsewhere and the card shows that outcome. Focus lands on its heading when it
// appears, never on Allow, so Enter alone never approves.
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { ApprovalView } from '@nova/shared';
import { defineMessages, messageFor } from '@nova/i18n';
import { Button, Icon, Spinner } from '@nova/ui';
import { ApiError } from '../api.ts';
import { expiryText } from '../chat/ApprovalCard.tsx';
import { APPROVALS_PATH } from '../dispatch/ApprovalsPage.tsx';
import { useHubStream } from '../hub-events.ts';
import { rich } from '../i18n/rich.tsx';
import { useAnnounce, useServices } from '../services.tsx';
import { useInterval } from '../settings/common.ts';
import { followLink } from '../work/nav.tsx';
import { firmwareErrorMessage, hubOnlyText } from './format.ts';
import './firmware.css';

export const HUB_ONLY_APPROVAL_TEXT = defineMessages('firmware.hubOnly', {
  /** An answered card's outcome, by decision. */
  outcome: {
    allow_once: 'Allowed once',
    allow_session: 'Allowed',
    allow_always: 'Allowed',
    deny_continue: 'Denied',
    deny_stop: 'Denied',
  },
  expired: 'Expired: nobody answered in time',
  cancelled: 'Cancelled',
  answered: 'Answered',
  /** The heading of an answered card; `outcome` is one of the words above. */
  answeredTitle: 'Approval: {outcome}',
  decided: '{decision, select, allow_once {Allowed once.} other {Denied.}}',
  answeredHere: 'Answered here.',
  answeredInNova: 'Answered in Nova.',
  decision: 'Decision',
  allowOnce: 'Allow once',
  deny: 'Deny',
  sending: 'Sending your answer',
  loading: 'Loading the approval',
  loadFailed: 'Could not load the approval.',
  retry: 'Retry',
  openInApprovals: 'Open in Approvals',
  /** When the card expires, then the link to the Approvals page. */
  expiresLine: '{expiry}. {link}',
  notSent: 'Your answer was not sent: {reason}',
  notSentRetry: 'Your answer was not sent: try again.',
});

const S = HUB_ONLY_APPROVAL_TEXT;

export { hubOnlyText };

function outcomeOf(a: ApprovalView): string {
  if (a.status === 'expired') return S.expired;
  if (a.status === 'cancelled') return S.cancelled;
  return (a.decision && messageFor(S.outcome, a.decision)) || S.answered;
}

export function approvalLink(approvalId: string): string {
  return `${APPROVALS_PATH}?focus=${encodeURIComponent(approvalId)}`;
}

export function HubOnlyApproval({
  approvalId,
  title,
  children,
  onDecided,
  focusOnShow = false,
}: {
  approvalId: string;
  /** What is approved, e.g. "Approve this firmware change on Desk PC". */
  title: string;
  /** What will change (the diff or the action), shown on the card. */
  children?: ReactNode;
  /** The card was answered (here or elsewhere): the caller reloads what it shows. */
  onDecided?: (a: ApprovalView) => void;
  /** Move focus to the card's heading when it appears (the owner just asked for it). */
  focusOnShow?: boolean;
}) {
  const { api } = useServices();
  const announce = useAnnounce();
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [a, setA] = useState<ApprovalView | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [here, setHere] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const decidedRef = useRef(onDecided);
  useEffect(() => {
    decidedRef.current = onDecided;
  });
  useInterval(() => setNow(Date.now()), 30_000);

  useEffect(() => {
    let alive = true;
    api.getApproval(approvalId).then(
      (view) => {
        if (!alive) return;
        setA(view);
        setLoadError(null);
      },
      (err: unknown) => alive && setLoadError(err),
    );
    return () => {
      alive = false;
    };
  }, [api, approvalId, attempt]);

  useHubStream(['approval.decided', 'approval.cancelled'], (env) => {
    if (env.payload.approvalId === approvalId) setAttempt((n) => n + 1);
  });

  const pending = a?.status === 'pending';
  // The card the owner just asked for appeared: focus its heading (never a button).
  useEffect(() => {
    if (pending && focusOnShow) heading.current?.focus();
  }, [pending, focusOnShow]);

  const decide = async (decision: 'allow_once' | 'deny_continue') => {
    if (busy || !a) return;
    setBusy(true);
    setError(null);
    try {
      const view = await api.decideApproval({ approvalId: a.id, decision });
      setA(view);
      setHere(true);
      announce(S.decided({ decision }));
      decidedRef.current?.(view);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Answered first somewhere else (FR-188): show that outcome, without an error.
        api.getApproval(a.id).then(
          (view) => {
            setA(view);
            decidedRef.current?.(view);
          },
          () => undefined,
        );
      } else {
        const reason = firmwareErrorMessage(err, '');
        setError(reason ? S.notSent({ reason }) : S.notSentRetry);
      }
    } finally {
      setBusy(false);
    }
  };

  if (!a) {
    return (
      <div className="fw-approval">
        {loadError ? (
          <>
            <p role="alert">
              <Icon name="alert" /> {firmwareErrorMessage(loadError, S.loadFailed)}
            </p>
            <div className="row">
              <Button onClick={() => setAttempt((n) => n + 1)}>{S.retry}</Button>
              <a
                href={approvalLink(approvalId)}
                onClick={(e) => followLink(e, approvalLink(approvalId))}
              >
                {S.openInApprovals}
              </a>
            </div>
          </>
        ) : (
          <Spinner label={S.loading} />
        )}
      </div>
    );
  }

  return (
    <div
      className="fw-approval"
      role="group"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-only`}
      data-answer-in={a.answerIn ?? undefined}
    >
      <h3 id={`${id}-title`} ref={heading} tabIndex={-1}>
        <Icon name="shield" /> {pending ? title : S.answeredTitle({ outcome: outcomeOf(a) })}
      </h3>
      {pending ? (
        <p id={`${id}-only`} className="muted">
          {hubOnlyText()}
        </p>
      ) : (
        <p id={`${id}-only`} className="muted">
          {here ? S.answeredHere : S.answeredInNova}
        </p>
      )}
      {children}
      {pending ? (
        <>
          {/* What the Hub says the card approves: its own words (D9). */}
          <p className="muted" dir="auto">
            {a.action}
          </p>
          <div className="row" role="group" aria-label={S.decision}>
            <Button disabled={busy} onClick={() => void decide('allow_once')}>
              {S.allowOnce}
            </Button>
            <Button variant="danger" disabled={busy} onClick={() => void decide('deny_continue')}>
              {S.deny}
            </Button>
            {busy ? <Spinner label={S.sending} /> : null}
          </div>
          <p className="muted">
            {rich(S.expiresLine, {
              expiry: expiryText(a.expiresAt, now),
              link: (
                <a href={approvalLink(a.id)} onClick={(e) => followLink(e, approvalLink(a.id))}>
                  {S.openInApprovals}
                </a>
              ),
            })}
          </p>
        </>
      ) : null}
      {error ? (
        <p role="alert" className="nv-field-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
