// Approval card (docs/04 §2.6, docs/12 §4.1, FR-100, FR-189): what the agent wants to do, why,
// whether the user asked for it (intent provenance), the confirmation tier, risk and the rule
// that triggered it, and a button for exactly the decisions the Hub offers. "Always allow" opens
// a scope chooser built from the suggested scopes (a prefix rule shows its pattern and examples
// before it is added); "Deny and continue" takes an optional reason for the agent; "Hand off"
// leaves the step to the user until they mark it done. The first answer wins (FR-188): a 409
// means another client answered, and the card quietly shows that outcome. Focus lands on the
// heading, never on an Allow button, so Enter alone never approves. M7.5: a Hub-only card
// (`answerIn: 'hub'`: firmware, boot, out-of-band) says it can be answered only in Nova; a card
// about a device (`scope: device:<id>`) links to it; on those cards no run continues after a
// denial, so they offer a plain "Deny" without a reason for an agent.
import { useEffect, useId, useRef, useState } from 'react';
import type { ApprovalDecisionKind, ApprovalView, DecideApprovalRequest } from '@nova/shared';
import { Button, Icon, Spinner, StatusChip } from '@nova/ui';
import { ApiError, errorMessage } from '../api.ts';
import { HUB_ONLY_TEXT, approvalDevice } from '../firmware/format.ts';
import { useAnnounce, useServices } from '../services.tsx';
import { followLink } from '../work/nav.tsx';
import { awaitsUser, type ClientApproval } from './thread-state.ts';

type Decision = Exclude<ApprovalDecisionKind, 'timeout'>;
type Scope = ApprovalView['alwaysScopes'][number];
type AlwaysScope = NonNullable<DecideApprovalRequest['alwaysScope']>;

/** Button order on the card (docs/04 §2.6). */
const ORDER: readonly Decision[] = [
  'allow_once',
  'allow_session',
  'allow_always',
  'deny_continue',
  'deny_stop',
  'handoff',
];

const BUTTON_TEXT: Record<Decision, string> = {
  allow_once: 'Allow once',
  allow_session: 'Allow for this session',
  allow_always: 'Always allow…',
  deny_continue: 'Deny and continue…',
  deny_stop: 'Deny and stop',
  handoff: 'Hand off',
};

export const DECISION_TEXT: Record<ApprovalDecisionKind, string> = {
  allow_once: 'Allowed once',
  allow_session: 'Allowed for this session',
  allow_always: 'Always allowed',
  deny_continue: 'Denied',
  deny_stop: 'Denied and stopped',
  handoff: 'Handed off',
  timeout: 'Expired: nobody answered in time',
};

const TIER_TEXT: Record<ApprovalView['tier'], string> = {
  pre_approvable: 'Pre-approvable',
  confirm_at_action: 'Asked every time; cannot be pre-approved',
  handoff_required: 'You need to do this step',
};

const RISK_TEXT: Record<NonNullable<ApprovalView['risk']>, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

/** A suggested scope as the decision body takes it (the label is only for the chooser). */
export function toAlwaysScope(s: Scope): AlwaysScope {
  switch (s.kind) {
    case 'tool':
      return { kind: 'tool', tool: s.tool };
    case 'prefix_rule':
      return { kind: 'prefix_rule', rule: s.rule };
    case 'host':
      return { kind: 'host', host: s.host };
  }
}

/** A command prefix as text: alternatives in braces, e.g. `npm {test|run}`. */
export function patternText(pattern: (string | string[])[]): string {
  return pattern.map((p) => (Array.isArray(p) ? `{${p.join('|')}}` : p)).join(' ');
}

export function expiryText(expiresAt: string, now: number): string {
  const ms = Date.parse(expiresAt) - now;
  if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return 'Expired';
  const min = Math.ceil(ms / 60_000);
  if (min < 60) return `Expires in ${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `Expires in ${h} h ${m} min` : `Expires in ${h} h`;
}

function outcomeText(a: ClientApproval): string {
  if (a.handoffDone) return 'Handed off, marked done';
  if (a.status === 'expired') return DECISION_TEXT.timeout;
  if (a.status === 'cancelled') return 'Cancelled';
  return a.decision ? DECISION_TEXT[a.decision] : 'Answered';
}

function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

export interface ApprovalCardProps {
  approval: ClientApproval;
  /** A fresher view of this approval (after a decision, or a refresh after a 409). */
  onChange: (view: ClientApproval) => void;
  /** Increments when the card should take focus: it just appeared, or a link named it. */
  focusKey?: number;
}

type Mode = 'choose' | 'always' | 'deny';

export function ApprovalCard({ approval: a, onChange, focusKey = 0 }: ApprovalCardProps) {
  const { api } = useServices();
  const announce = useAnnounce();
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const [mode, setMode] = useState<Mode>('choose');
  const [scopeIdx, setScopeIdx] = useState(0);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** A 409 told us someone else answered, even if the refresh failed. */
  const [taken, setTaken] = useState(false);
  const focusAfter = useRef<string | null>(null);
  const now = useNow(30_000);
  const settled = !awaitsUser(a) || taken;
  const outcome = settled ? outcomeText(a) : '';
  // Another client answered (FR-188): say so once, since the card's buttons just went away.
  const elsewhere = settled && !a.answeredHere && !busy && (taken || a.status === 'decided');
  useEffect(() => {
    if (elsewhere) announce(`Approval answered on another device: ${outcome}.`);
  }, [announce, elsewhere, outcome]);

  useEffect(() => {
    if (!focusKey) return;
    const el = heading.current;
    el?.scrollIntoView?.({ block: 'center' });
    el?.focus();
  }, [focusKey]);

  // Moving between the buttons and a sub-form keeps focus on the matching control.
  useEffect(() => {
    const target = focusAfter.current;
    if (!target) return;
    focusAfter.current = null;
    root.current?.querySelector<HTMLElement>(target)?.focus();
  }, [mode]);

  const switchMode = (next: Mode, focus: string) => {
    focusAfter.current = focus;
    setError(null);
    setMode(next);
  };

  const decide = async (decision: Decision, extra: Partial<DecideApprovalRequest> = {}) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const view = await api.decideApproval({ approvalId: a.id, decision, ...extra });
      onChange({ ...view, answeredHere: true });
      setMode('choose');
      announce(
        decision === 'handoff'
          ? 'Handed off. Do the step, then mark it done.'
          : `${DECISION_TEXT[decision]}.`,
      );
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Another client answered first (FR-188): show its outcome, without an error.
        setTaken(true);
        api.getApproval(a.id).then(onChange, () => undefined);
      } else {
        setError(`Your answer was not sent: ${errorMessage(err)}`);
      }
    } finally {
      setBusy(false);
    }
  };

  const markDone = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const view = await api.handoffDone(a.id);
      onChange({ ...view, answeredHere: true, handoffDone: true });
      announce('Marked done. The run continues.');
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        onChange({ ...a, status: 'decided', handoffDone: true });
      } else {
        setError(`Could not mark it done: ${errorMessage(err)}`);
      }
    } finally {
      setBusy(false);
    }
  };

  if (settled) {
    return (
      <p className="approval-outcome" data-outcome={a.decision ?? a.status}>
        <Icon name="shield" /> Approval: {outcome}
        {elsewhere ? <span className="muted"> (answered on another device)</span> : null}
      </p>
    );
  }

  const handingOff = a.decision === 'handoff';
  const options = ORDER.filter(
    (o) => a.options.includes(o) && (o !== 'allow_always' || a.alwaysScopes.length > 0),
  );
  const scope = a.alwaysScopes[Math.min(scopeIdx, a.alwaysScopes.length - 1)];
  const hubOnly = a.answerIn === 'hub';
  const device = approvalDevice(a);
  const devicePath = device ? `/devices/${encodeURIComponent(device.id)}` : null;
  // A device's own card: no run waits on it, so a denial needs no reason for an agent.
  const plainDeny = hubOnly || device !== null;
  const title = handingOff
    ? 'Your step'
    : a.tier === 'handoff_required'
      ? 'You need to do this step'
      : 'Approval needed';

  return (
    <div
      ref={root}
      id={`approval-${a.id}`}
      className="approval"
      role="group"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-action`}
      data-tier={a.tier}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || mode === 'choose') return;
        e.preventDefault();
        e.stopPropagation();
        switchMode(
          'choose',
          `[data-decision="${mode === 'always' ? 'allow_always' : 'deny_continue'}"]`,
        );
      }}
    >
      <div className="approval-head">
        <h3 id={`${id}-title`} ref={heading} tabIndex={-1} className="approval-title">
          <Icon name="shield" /> {title}
        </h3>
        <StatusChip status="needs_input" />
      </div>
      <dl className="approval-facts">
        <div>
          <dt>Action</dt>
          <dd id={`${id}-action`}>{a.action}</dd>
        </div>
        {device && devicePath ? (
          <div>
            <dt>Where</dt>
            <dd>
              <a href={devicePath} onClick={(e) => followLink(e, devicePath)}>
                On {device.name ?? 'a device'}
              </a>
            </dd>
          </div>
        ) : null}
        {a.tool || a.argsPreview ? (
          <div>
            <dt>Target</dt>
            <dd>
              {a.tool ? <code>{a.tool}</code> : null}
              {a.argsPreview ? (
                <pre className="approval-args" tabIndex={0} aria-label="Arguments">
                  {a.argsPreview}
                </pre>
              ) : null}
            </dd>
          </div>
        ) : null}
        <div>
          <dt>Why</dt>
          <dd>{a.reason}</dd>
        </div>
        <div>
          <dt>Asked</dt>
          <dd data-provenance={a.userAsked ? 'user' : 'other'}>
            {a.userAsked ? (
              'You asked for this'
            ) : (
              <>
                <Icon name="alert" /> Not from your message. It came from a tool, page or file,
                which cannot authorize actions.
              </>
            )}
          </dd>
        </div>
        <div>
          <dt>Tier</dt>
          <dd>{TIER_TEXT[a.tier]}</dd>
        </div>
        {a.risk ? (
          <div>
            <dt>Risk</dt>
            <dd data-risk={a.risk}>{RISK_TEXT[a.risk]}</dd>
          </div>
        ) : null}
        <div>
          <dt>Rule</dt>
          <dd>{a.ruleId ? <code>{a.ruleId}</code> : 'Tool default'}</dd>
        </div>
      </dl>
      {hubOnly ? (
        <p className="muted approval-note" data-answer-in="hub">
          <Icon name="shield" /> {HUB_ONLY_TEXT}
        </p>
      ) : null}

      {handingOff ? (
        <div className="approval-actions">
          <p className="approval-note">
            Do this step yourself. When you finish, mark it done and the run continues.
          </p>
          <Button variant="primary" onClick={() => void markDone()} disabled={busy}>
            {busy ? <Spinner /> : <Icon name="check" />}
            Mark done
          </Button>
        </div>
      ) : mode === 'always' && scope ? (
        <form
          className="approval-form"
          aria-label="Always allow"
          onSubmit={(e) => {
            e.preventDefault();
            void decide('allow_always', { alwaysScope: toAlwaysScope(scope) });
          }}
        >
          <fieldset className="approval-scopes">
            <legend>Always allow</legend>
            {a.alwaysScopes.map((s, i) => (
              <label key={`${s.kind}-${i}`} className="approval-scope">
                <input
                  type="radio"
                  name={`${id}-scope`}
                  checked={i === scopeIdx}
                  onChange={() => setScopeIdx(i)}
                />
                <span>{s.label}</span>
              </label>
            ))}
          </fieldset>
          {scope.kind === 'prefix_rule' ? (
            <div className="approval-rule" aria-label="Rule to add" role="group">
              <p>
                Rule: commands starting with <code>{patternText(scope.rule.pattern)}</code>
              </p>
              {scope.rule.matchExamples.length ? (
                <p>
                  Matches:{' '}
                  {scope.rule.matchExamples.map((x, i) => (
                    <code key={i}>{x}</code>
                  ))}
                </p>
              ) : null}
              {scope.rule.notMatchExamples.length ? (
                <p>
                  Does not match:{' '}
                  {scope.rule.notMatchExamples.map((x, i) => (
                    <code key={i}>{x}</code>
                  ))}
                </p>
              ) : null}
            </div>
          ) : null}
          <p className="muted approval-note">
            Remembered until you revoke it in Settings, Permissions.
          </p>
          <div className="approval-actions">
            <Button type="submit" disabled={busy}>
              {busy ? <Spinner /> : null}
              Always allow
            </Button>
            <Button
              onClick={() => switchMode('choose', '[data-decision="allow_always"]')}
              disabled={busy}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : mode === 'deny' ? (
        <form
          className="approval-form"
          aria-label="Deny and continue"
          onSubmit={(e) => {
            e.preventDefault();
            const why = reason.trim();
            void decide('deny_continue', why ? { reason: why } : {});
          }}
        >
          <label htmlFor={`${id}-reason`} className="nv-field-label">
            Reason (optional)
          </label>
          <textarea
            id={`${id}-reason`}
            className="nv-input approval-reason"
            rows={2}
            maxLength={2000}
            value={reason}
            aria-describedby={`${id}-reason-hint`}
            onChange={(e) => setReason(e.target.value)}
          />
          <span id={`${id}-reason-hint`} className="nv-field-hint">
            Returned to the agent as the tool result; the run continues.
          </span>
          <div className="approval-actions">
            <Button type="submit" variant="danger" disabled={busy}>
              {busy ? <Spinner /> : null}
              Deny and continue
            </Button>
            <Button
              onClick={() => switchMode('choose', '[data-decision="deny_continue"]')}
              disabled={busy}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="approval-actions" role="group" aria-label="Decision">
          {options.map((o) => (
            <Button
              key={o}
              data-decision={o}
              variant={
                o === 'deny_stop' || (o === 'deny_continue' && plainDeny) ? 'danger' : 'default'
              }
              disabled={busy}
              onClick={() => {
                if (o === 'allow_always') switchMode('always', 'input[type="radio"]:checked');
                else if (o === 'deny_continue' && !plainDeny) switchMode('deny', 'textarea');
                else void decide(o);
              }}
            >
              {o === 'deny_continue' && plainDeny ? 'Deny' : BUTTON_TEXT[o]}
            </Button>
          ))}
          {busy ? <Spinner label="Sending your answer" /> : null}
        </div>
      )}
      {error ? (
        <p className="approval-error" role="alert">
          <Icon name="alert" /> {error}
        </p>
      ) : null}
      <p className="muted approval-expiry">{expiryText(a.expiresAt, now)}</p>
    </div>
  );
}
