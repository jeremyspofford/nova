// One Network Setup run (FR-136; docs/22 §6 steps 2-8): its steps in order, each with what it
// does (the exact text the owner confirms), the commands it runs and how they are undone, what it
// could cut, and its checks. The next step is applied with a one-time consent (the Hub answers 403
// `consent_required` with the exact description when it needs one); a step that fails its checks
// is rolled back automatically and says so; the owner can verify, roll back the last step or the
// whole run. A full page (`/network/setup?run=<id>`), never a modal.
import { useId, useState } from 'react';
import type { NetworkSetupCheckView, NetworkSetupStepView } from '@nova/shared';
import { Button, Icon, Spinner, useToast } from '@nova/ui';
import { ApiError } from '../api.ts';
import { formatWhen } from '../settings/common.ts';
import { useSettings } from '../settings.tsx';
import { navigate } from '../router.ts';
import { useAnnounce } from '../services.tsx';
import { followLink } from '../work/nav.tsx';
import { useDebounced } from '../work/events.ts';
import { useNetworkSurfaceApi, type SetupApplied } from './api.ts';
import { SETUP_EVENTS, eventRunId, useNetworkEvents } from './events.ts';
import {
  canApply,
  commandText,
  consentAsked,
  isCheckStep,
  netErrorMessage,
  nextStep,
  optionText,
  progressText,
  providerLabel,
  runStatusChip,
  setupRunPath,
  stepKindLabel,
  stepProviderLabel,
  stepStatusChip,
  transportsText,
  undoableSteps,
} from './format.ts';
import { Chip, ConfirmDialog, CopyButton, LoadError, useLoad } from './parts.tsx';
import { HostChanges, HostChangesNeeded } from './HostChanges.tsx';

const OUTPUT_LABEL: Record<string, string> = {
  wireguardPublicKey: 'The Hub’s WireGuard public key (add it to each peer)',
};

interface Notice {
  tone: 'ok' | 'warn' | 'bad';
  text: string;
}

/** What happened to an applied step, in words. */
export function outcomeNotice(step: NetworkSetupStepView): Notice {
  const why = step.error ? `: ${step.error}` : '';
  switch (step.status) {
    case 'verified':
      return { tone: 'ok', text: `${step.title}: done, and it passed its checks.` };
    case 'skipped':
      return { tone: 'ok', text: `${step.title}: already in place.` };
    case 'rolled_back':
      return {
        tone: 'warn',
        text: step.autoRolledBack
          ? `${step.title} did not pass its checks, so Nova rolled it back${why}. Nothing it changed is left behind.`
          : `${step.title} was rolled back.`,
      };
    case 'rollback_failed':
      return {
        tone: 'bad',
        text: `${step.title} did not pass its checks and Nova could not undo it${why}. Roll it back again, or fix it by hand.`,
      };
    case 'failed':
      return { tone: 'bad', text: `${step.title} failed${why}. What it ran was undone.` };
    case 'applied':
      return { tone: 'warn', text: `${step.title} is applied and still being checked.` };
    default:
      return { tone: 'warn', text: `${step.title}: ${step.status.replace(/_/g, ' ')}.` };
  }
}

export function SetupRun({ runId }: { runId: string }) {
  const api = useNetworkSurfaceApi();
  const toast = useToast();
  const announce = useAnnounce();
  const allow = useSettings().get('network.setup.allowSystemChanges');
  const run = useLoad(() => api.getNetworkSetupRun(runId), runId);
  const reload = useDebounced(run.reload, 150);
  useNetworkEvents(
    SETUP_EVENTS,
    (env) => {
      if (env.name !== 'network.setup.step' || eventRunId(env) === runId) reload();
    },
    reload,
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [stepErrors, setStepErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<Notice | null>(null);
  const [consent, setConsent] = useState<{
    step: NetworkSetupStepView;
    description: string;
  } | null>(null);
  const [rollback, setRollback] = useState<'step' | 'run' | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [verified, setVerified] = useState<{ ok: boolean; checks: NetworkSetupCheckView[] } | null>(
    null,
  );

  const r = run.data;
  const gone = run.error instanceof ApiError && run.error.status === 404;
  if (!r || gone) {
    return (
      <div className="stack net-section">
        <Back />
        {gone ? (
          <div role="alert" className="ws-error">
            <p>This setup run is not on this Hub.</p>
            <Button onClick={() => navigate(setupRunPath(null))}>Back to setup</Button>
          </div>
        ) : run.error ? (
          <LoadError
            error={run.error}
            fallback="Could not load the setup run."
            onRetry={run.reload}
          />
        ) : (
          <Spinner label="Loading the setup run" />
        )}
      </div>
    );
  }

  const done = (res: SetupApplied) => {
    run.setData(() => res.run);
    const n = outcomeNotice(res.step);
    setNotice(n);
    announce(n.text);
  };

  const send = (step: NetworkSetupStepView, given?: { stepId: string; description: string }) =>
    api.applyNetworkSetupStep(r.id, { stepId: step.id, ...(given ? { consent: given } : {}) });

  const apply = async (step: NetworkSetupStepView) => {
    if (step.consent.required && !step.consent.remembered) {
      setConsent({ step, description: step.description });
      return;
    }
    setBusy(step.id);
    setStepErrors((e) => ({ ...e, [step.id]: '' }));
    setNotice(null);
    try {
      done(await send(step));
    } catch (err) {
      const asked = consentAsked(err);
      if (asked) {
        // The Hub wants this exact text confirmed (it may differ from what the page shows).
        setConsent({ step, description: asked.description });
        return;
      }
      setStepErrors((e) => ({
        ...e,
        [step.id]: netErrorMessage(err, 'Could not apply the step.'),
      }));
    } finally {
      setBusy(null);
    }
  };

  const verify = async (stepId?: string) => {
    setVerifying(true);
    setVerified(null);
    try {
      const v = await api.verifyNetworkSetup(r.id, stepId);
      run.setData(() => v.run);
      setVerified({ ok: v.ok, checks: v.checks });
      announce(v.ok ? 'Every check passed.' : 'Some checks did not pass.');
    } catch (err) {
      toast.show(netErrorMessage(err, 'Could not check the run.'), { tone: 'error' });
    } finally {
      setVerifying(false);
    }
  };

  const steps = [...r.steps].sort((a, b) => a.index - b.index);
  const next = nextStep(r);
  const undoable = undoableSteps(r);
  const lastUndoable = undoable[0] ?? null;
  const undoNeedsHost = (list: NetworkSetupStepView[]) =>
    list.some((s) => s.systemChange) && !allow.value;
  const outputs = Object.entries(r.outputs);
  const options = Object.entries(r.options);

  return (
    <div className="stack net-section">
      <Back />
      {run.error ? (
        <LoadError
          error={run.error}
          fallback="Could not refresh the setup run."
          onRetry={run.reload}
        />
      ) : null}
      <header className="ws-section-header net-first">
        <div className="net-title">
          <h2>{providerLabel(r.provider)} setup</h2>
          <Chip spec={runStatusChip(r.status)} />
        </div>
        <div className="row">
          <Button onClick={() => void verify()} disabled={verifying}>
            {verifying ? <Spinner /> : <Icon name="check" />} Check everything
          </Button>
          {undoable.length ? (
            undoNeedsHost(undoable) ? null : (
              <Button variant="danger" onClick={() => setRollback('run')}>
                <Icon name="undo" /> Roll back the whole run
              </Button>
            )
          ) : null}
        </div>
      </header>
      <p className="muted ws-flush ws-row-meta">
        <span>{progressText(r)}</span>
        <span>planned {formatWhen(r.createdAt)}</span>
        {r.updatedAt !== r.createdAt ? <span>updated {formatWhen(r.updatedAt)}</span> : null}
      </p>
      {r.error ? (
        <p className="net-why" role="note">
          {r.error}
        </p>
      ) : null}
      {undoable.length && undoNeedsHost(undoable) ? (
        <HostChangesNeeded what="Rolling back" />
      ) : null}
      {notice ? (
        <div className="net-notice" data-tone={notice.tone} role="status">
          <Icon name={notice.tone === 'ok' ? 'check' : 'alert'} />
          <p>{notice.text}</p>
        </div>
      ) : null}
      {verified ? (
        <div className="net-notice" data-tone={verified.ok ? 'ok' : 'bad'} role="status">
          <Icon name={verified.ok ? 'check' : 'alert'} />
          <div>
            <p>{verified.ok ? 'Every check passed.' : 'Some checks did not pass.'}</p>
            {verified.checks.length ? <Checks checks={verified.checks} /> : null}
          </div>
        </div>
      ) : null}
      {outputs.length ? (
        <section className="ws-card" aria-label="What you need from this run">
          {outputs.map(([k, v]) => (
            <div key={k} className="net-output">
              <span className="nv-field-label">{OUTPUT_LABEL[k] ?? k}</span>
              <div className="row">
                <code className="ws-code-inline net-break">{v}</code>
                <CopyButton value={v} what={OUTPUT_LABEL[k] ? 'Public key' : 'Value'} />
              </div>
            </div>
          ))}
        </section>
      ) : null}
      {options.length ? (
        <details className="ws-advanced">
          <summary>Options</summary>
          <dl className="ws-dl">
            {options.map(([k, v]) => (
              <div key={k} className="net-contents">
                <dt>{k}</dt>
                <dd>{optionText(v)}</dd>
              </div>
            ))}
          </dl>
        </details>
      ) : null}
      <HostChanges />
      <ol className="net-steps" aria-label="Steps">
        {steps.map((s) => (
          <Step
            key={s.id}
            step={s}
            isNext={next?.id === s.id}
            isLastUndoable={lastUndoable?.id === s.id}
            hostOff={!allow.value}
            busy={busy === s.id}
            anyBusy={busy !== null}
            error={stepErrors[s.id] ?? ''}
            onApply={() => void apply(s)}
            onVerify={() => void verify(s.id)}
            verifying={verifying}
            onRollBack={() => setRollback('step')}
          />
        ))}
      </ol>
      <ConfirmDialog
        open={consent !== null}
        title={consent ? `Allow: ${consent.step.title}?` : 'Allow this step?'}
        description="Nova runs this on the Hub. Read what it does before you allow it."
        confirmLabel="Allow and apply"
        onClose={() => setConsent(null)}
        onConfirm={async () => {
          if (!consent) return;
          const { step, description } = consent;
          setBusy(step.id);
          try {
            const res = await send(step, { stepId: step.id, description });
            setConsent(null);
            done(res);
          } catch (err) {
            const asked = consentAsked(err);
            if (asked && asked.description !== description) {
              setConsent({ step, description: asked.description });
              throw new Error(
                'The step changed since this page loaded. Read it again and allow it.',
                { cause: err },
              );
            }
            throw err;
          } finally {
            setBusy(null);
          }
        }}
      >
        {consent ? (
          <div className="stack net-tight">
            <blockquote className="net-consent" aria-label="What you allow">
              {consent.description}
            </blockquote>
            {consent.step.affects.length ? (
              <p className="net-cuts">
                <Icon name="alert" /> It could cut the {transportsText(consent.step.affects)} path
                {consent.step.affects.length > 1 ? 's' : ''} to the Hub. Nova refuses it when no
                other path you could use passes its test.
              </p>
            ) : null}
            <p className="muted ws-flush net-small">
              Nova remembers this for {stepKindLabel(consent.step.kind).toLowerCase()} changes with{' '}
              {stepProviderLabel(consent.step.provider)}. You can revoke it under Setup.
            </p>
          </div>
        ) : null}
      </ConfirmDialog>
      <ConfirmDialog
        open={rollback !== null}
        title={rollback === 'run' ? 'Roll back the whole run?' : 'Roll back this step?'}
        description={
          rollback === 'run'
            ? 'Nova undoes every applied step, newest first, and the previous settings come back.'
            : lastUndoable
              ? `Nova undoes “${lastUndoable.title}” and the previous settings come back.`
              : undefined
        }
        confirmLabel="Roll back"
        danger
        onClose={() => setRollback(null)}
        onConfirm={async () => {
          const targets = rollback === 'run' ? undoable : lastUndoable ? [lastUndoable] : [];
          const next = await api.rollbackNetworkSetup(
            r.id,
            rollback === 'step' ? lastUndoable?.id : undefined,
          );
          setRollback(null);
          run.setData(() => next);
          const failed = next.steps.filter(
            (s) => targets.some((t) => t.id === s.id) && s.status === 'rollback_failed',
          );
          const n: Notice = failed.length
            ? {
                tone: 'bad',
                text: `Nova could not undo ${failed.map((s) => s.title).join(', ')}. Try again, or fix it by hand.`,
              }
            : { tone: 'ok', text: 'Rolled back.' };
          setNotice(n);
          announce(n.text);
        }}
      >
        <RollbackDetails
          steps={rollback === 'run' ? undoable : lastUndoable ? [lastUndoable] : []}
        />
      </ConfirmDialog>
    </div>
  );
}

function Back() {
  const path = setupRunPath(null);
  return (
    <nav aria-label="Breadcrumb" className="ws-breadcrumb">
      <a href={path} onClick={(e) => followLink(e, path)}>
        <Icon name="back" /> Setup
      </a>
    </nav>
  );
}

function Checks({ checks }: { checks: NetworkSetupCheckView[] }) {
  return (
    <ul className="net-checks" aria-label="Checks">
      {checks.map((c, i) => (
        <li key={`${i}-${c.name}`} data-ok={c.ok || undefined}>
          <Icon name={c.ok ? 'check' : 'alert'} />
          <span>
            {c.name}: {c.ok ? 'passed' : 'failed'}
            {c.detail ? ` (${c.detail})` : ''}
          </span>
        </li>
      ))}
    </ul>
  );
}

function RollbackDetails({ steps }: { steps: NetworkSetupStepView[] }) {
  const cuts = [...new Set(steps.flatMap((s) => s.undoAffects))];
  const commands = steps.flatMap((s) => s.undoCommands);
  return (
    <div className="stack net-tight">
      {steps.length > 1 ? (
        <ul className="ws-plain-list">
          {steps.map((s) => (
            <li key={s.id}>{s.title}</li>
          ))}
        </ul>
      ) : null}
      {cuts.length ? (
        <p className="net-cuts">
          <Icon name="alert" /> Undoing could cut the {transportsText(cuts)} path
          {cuts.length > 1 ? 's' : ''}. Nova refuses when no other path you could use passes its
          test.
        </p>
      ) : null}
      {commands.length ? (
        <details className="ws-advanced">
          <summary>Commands it runs</summary>
          <pre className="ws-log">{commands.map(commandText).join('\n')}</pre>
        </details>
      ) : null}
    </div>
  );
}

function Step({
  step: s,
  isNext,
  isLastUndoable,
  hostOff,
  busy,
  anyBusy,
  error,
  onApply,
  onVerify,
  verifying,
  onRollBack,
}: {
  step: NetworkSetupStepView;
  isNext: boolean;
  isLastUndoable: boolean;
  hostOff: boolean;
  busy: boolean;
  anyBusy: boolean;
  error: string;
  onApply: () => void;
  onVerify: () => void;
  verifying: boolean;
  onRollBack: () => void;
}) {
  const headingId = useId();
  const check = isCheckStep(s);
  const needsHost = s.systemChange && hostOff;
  const applyLabel = check ? 'Run the test' : s.status === 'pending' ? 'Apply' : 'Try again';
  return (
    <li className="net-step" data-status={s.status} aria-labelledby={headingId}>
      <div className="net-step-head">
        <span className="net-step-index" aria-hidden="true">
          {s.index + 1}
        </span>
        <h3 id={headingId}>{s.title}</h3>
        <Chip spec={stepStatusChip(s.status)} />
        {s.systemChange ? (
          <Chip spec={{ text: 'Changes this computer', tone: 'neutral', icon: 'terminal' }} />
        ) : null}
      </div>
      <span className="muted ws-row-meta net-small">
        <span>{stepKindLabel(s.kind)}</span>
        <span>with {stepProviderLabel(s.provider)}</span>
        {s.appliedAt ? <span>applied {formatWhen(s.appliedAt)}</span> : null}
        {s.verifiedAt ? <span>checked {formatWhen(s.verifiedAt)}</span> : null}
        {s.rolledBackAt ? <span>rolled back {formatWhen(s.rolledBackAt)}</span> : null}
      </span>
      <p className="net-step-desc">{s.description}</p>
      {s.status === 'manual' ? (
        <p className="muted ws-flush">Nova cannot do this one: do it by hand as described.</p>
      ) : null}
      {s.affects.length ? (
        <p className="net-cuts">
          <Icon name="alert" /> Could cut the {transportsText(s.affects)} path
          {s.affects.length > 1 ? 's' : ''} to the Hub.
        </p>
      ) : null}
      {s.consent.required && (s.consent.remembered || canApply(s)) ? (
        <p className="muted ws-flush net-small">
          {s.consent.remembered
            ? 'You allowed this kind of change before.'
            : 'Nova asks you to allow it before it runs.'}
        </p>
      ) : null}
      {s.commands.length || s.undoCommands.length ? (
        <details className="ws-advanced">
          <summary>Commands</summary>
          {s.commands.length ? (
            <pre className="ws-log" aria-label="Commands it runs">
              {s.commands.map(commandText).join('\n')}
            </pre>
          ) : null}
          {s.undoCommands.length ? (
            <>
              <h4 className="net-small">How it is undone</h4>
              <pre className="ws-log" aria-label="Undo commands">
                {s.undoCommands.map(commandText).join('\n')}
              </pre>
            </>
          ) : null}
        </details>
      ) : null}
      {s.checks.length ? <Checks checks={s.checks} /> : null}
      {s.error && s.status !== 'verified' ? (
        <p className="net-why">
          {s.autoRolledBack ? 'Rolled back automatically: ' : ''}
          {s.error}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="nv-field-error">
          {error}
        </p>
      ) : null}
      {isNext && canApply(s) ? (
        needsHost ? (
          <HostChangesNeeded />
        ) : (
          <div className="row">
            <Button variant="primary" onClick={onApply} disabled={anyBusy}>
              {busy ? <Spinner /> : null} {applyLabel}
            </Button>
          </div>
        )
      ) : null}
      {(s.status === 'applied' || s.status === 'verified') && !check ? (
        <div className="row">
          <Button variant="ghost" onClick={onVerify} disabled={verifying}>
            Check this step
          </Button>
          {isLastUndoable && !(s.systemChange && hostOff) ? (
            <Button variant="danger" onClick={onRollBack}>
              <Icon name="undo" /> Roll back this step
            </Button>
          ) : null}
        </div>
      ) : s.status === 'rollback_failed' && isLastUndoable ? (
        s.systemChange && hostOff ? (
          <HostChangesNeeded what="Rolling it back" />
        ) : (
          <div className="row">
            <Button variant="danger" onClick={onRollBack}>
              <Icon name="undo" /> Roll back again
            </Button>
          </div>
        )
      ) : null}
    </li>
  );
}
