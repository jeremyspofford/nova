// One Network Setup run (FR-136; docs/22 §6 steps 2-8): its steps in order, each with what it
// does (the exact text the owner confirms), the commands it runs and how they are undone, what it
// could cut, and its checks. The next step is applied with a one-time consent (the Hub answers 403
// `consent_required` with the exact description when it needs one); a step that fails its checks
// is rolled back automatically and says so; the owner can verify, roll back the last step or the
// whole run. A full page (`/network/setup?run=<id>`), never a modal.
import { useId, useState } from 'react';
import { defineMessages, fmt, messageFor } from '@nova/i18n';
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
  runName,
  runStatusChip,
  sectionInfo,
  setupRunPath,
  stepKindLabel,
  stepProviderLabel,
  stepStatusChip,
  transportsText,
  undoableSteps,
} from './format.ts';
import { Chip, ConfirmDialog, CopyButton, LoadError, useLoad } from './parts.tsx';
import { HostChanges, HostChangesNeeded } from './HostChanges.tsx';

const S = defineMessages('netsurface.run', {
  output: { wireguardPublicKey: 'The Hub’s WireGuard public key (add it to each peer)' },
  copy: {
    key: 'Copy public key',
    keyCopied: 'Public key copied.',
    keyFailed: 'Could not copy. Select the public key and copy it yourself.',
    value: 'Copy value',
    valueCopied: 'Value copied.',
    valueFailed: 'Could not copy. Select the value and copy it yourself.',
  },
  outcome: {
    verified: '{title}: done, and it passed its checks.',
    skipped: '{title}: already in place.',
    autoRolledBack:
      '{title} did not pass its checks, so Nova rolled it back. Nothing it changed is left behind.',
    autoRolledBackWhy:
      '{title} did not pass its checks, so Nova rolled it back: {error}. Nothing it changed is left behind.',
    rolledBack: '{title} was rolled back.',
    rollbackFailed:
      '{title} did not pass its checks and Nova could not undo it. Roll it back again, or fix it by hand.',
    rollbackFailedWhy:
      '{title} did not pass its checks and Nova could not undo it: {error}. Roll it back again, or fix it by hand.',
    failed: '{title} failed. What it ran was undone.',
    failedWhy: '{title} failed: {error}. What it ran was undone.',
    applied: '{title} is applied and still being checked.',
    other: '{title}: {status}.',
  },
  gone: 'This setup run is not on this Hub.',
  backToSetup: 'Back to setup',
  loadFailed: 'Could not load the setup run.',
  loading: 'Loading the setup run',
  refreshFailed: 'Could not refresh the setup run.',
  applyFailed: 'Could not apply the step.',
  allPassed: 'Every check passed.',
  somePassed: 'Some checks did not pass.',
  checkFailed: 'Could not check the run.',
  checkAll: 'Check everything',
  rollBackRun: 'Roll back the whole run',
  planned: 'planned {when}',
  updated: 'updated {when}',
  outputs: 'What you need from this run',
  options: 'Options',
  steps: 'Steps',
  breadcrumb: 'Breadcrumb',
  consent: {
    titleOf: 'Allow: {title}?',
    title: 'Allow this step?',
    description: 'Nova runs this on the Hub. Read what it does before you allow it.',
    confirm: 'Allow and apply',
    changed: 'The step changed since this page loaded. Read it again and allow it.',
    what: 'What you allow',
    cuts: '{n, plural, one {It could cut the {paths} path to the Hub.} other {It could cut the {paths} paths to the Hub.}} Nova refuses it when no other path you could use passes its test.',
    remembers:
      'Nova remembers your answer for this kind of change ({kind}) with {provider}. You can revoke it under Setup.',
  },
  rollback: {
    runTitle: 'Roll back the whole run?',
    stepTitle: 'Roll back this step?',
    runText: 'Nova undoes every applied step, newest first, and the previous settings come back.',
    stepText: 'Nova undoes “{title}” and the previous settings come back.',
    confirm: 'Roll back',
    couldNotUndo: 'Nova could not undo {titles}. Try again, or fix it by hand.',
    done: 'Rolled back.',
    cuts: '{n, plural, one {Undoing could cut the {paths} path.} other {Undoing could cut the {paths} paths.}} Nova refuses when no other path you could use passes its test.',
    commands: 'Commands it runs',
  },
  checks: 'Checks',
  check: '{name}: {ok, select, yes {passed} other {failed}}',
  checkDetail: '{name}: {ok, select, yes {passed} other {failed}} ({detail})',
  step: {
    test: 'Run the test',
    apply: 'Apply',
    tryAgain: 'Try again',
    changesComputer: 'Changes this computer',
    with: 'with {provider}',
    applied: 'applied {when}',
    checked: 'checked {when}',
    rolledBack: 'rolled back {when}',
    manual: 'Nova cannot do this one: do it by hand as described.',
    cuts: '{n, plural, one {Could cut the {paths} path to the Hub.} other {Could cut the {paths} paths to the Hub.}}',
    allowedBefore: 'You allowed this kind of change before.',
    asks: 'Nova asks you to allow it before it runs.',
    commands: 'Commands',
    commandsItRuns: 'Commands it runs',
    undoneBy: 'How it is undone',
    undoCommands: 'Undo commands',
    autoRolledBack: 'Rolled back automatically: {error}',
    check: 'Check this step',
    rollBack: 'Roll back this step',
    rollBackAgain: 'Roll back again',
  },
});

/** What a run's output is, in words; one the Hub adds later keeps its name. */
const outputLabel = (k: string): string => messageFor(S.output, k) ?? k;

interface Notice {
  tone: 'ok' | 'warn' | 'bad';
  text: string;
}

/** What happened to an applied step, in words. */
export function outcomeNotice(step: NetworkSetupStepView): Notice {
  const title = step.title;
  const error = step.error;
  const o = S.outcome;
  switch (step.status) {
    case 'verified':
      return { tone: 'ok', text: o.verified({ title }) };
    case 'skipped':
      return { tone: 'ok', text: o.skipped({ title }) };
    case 'rolled_back':
      return {
        tone: 'warn',
        text: !step.autoRolledBack
          ? o.rolledBack({ title })
          : error
            ? o.autoRolledBackWhy({ title, error })
            : o.autoRolledBack({ title }),
      };
    case 'rollback_failed':
      return {
        tone: 'bad',
        text: error ? o.rollbackFailedWhy({ title, error }) : o.rollbackFailed({ title }),
      };
    case 'failed':
      return { tone: 'bad', text: error ? o.failedWhy({ title, error }) : o.failed({ title }) };
    case 'applied':
      return { tone: 'warn', text: o.applied({ title }) };
    default:
      return { tone: 'warn', text: o.other({ title, status: step.status.replace(/_/g, ' ') }) };
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
            <p>{S.gone}</p>
            <Button onClick={() => navigate(setupRunPath(null))}>{S.backToSetup}</Button>
          </div>
        ) : run.error ? (
          <LoadError error={run.error} fallback={S.loadFailed} onRetry={run.reload} />
        ) : (
          <Spinner label={S.loading} />
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
        [step.id]: netErrorMessage(err, S.applyFailed),
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
      announce(v.ok ? S.allPassed : S.somePassed);
    } catch (err) {
      toast.show(netErrorMessage(err, S.checkFailed), { tone: 'error' });
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
        <LoadError error={run.error} fallback={S.refreshFailed} onRetry={run.reload} />
      ) : null}
      <header className="ws-section-header net-first">
        <div className="net-title">
          <h2>{runName(r.provider)}</h2>
          <Chip spec={runStatusChip(r.status)} />
        </div>
        <div className="row">
          <Button onClick={() => void verify()} disabled={verifying}>
            {verifying ? <Spinner /> : <Icon name="check" />} {S.checkAll}
          </Button>
          {undoable.length ? (
            undoNeedsHost(undoable) ? null : (
              <Button variant="danger" onClick={() => setRollback('run')}>
                <Icon name="undo" /> {S.rollBackRun}
              </Button>
            )
          ) : null}
        </div>
      </header>
      <p className="muted ws-flush ws-row-meta">
        <span>{progressText(r)}</span>
        <span>{S.planned({ when: formatWhen(r.createdAt) })}</span>
        {r.updatedAt !== r.createdAt ? (
          <span>{S.updated({ when: formatWhen(r.updatedAt) })}</span>
        ) : null}
      </p>
      {r.error ? (
        <p className="net-why" role="note">
          {r.error}
        </p>
      ) : null}
      {undoable.length && undoNeedsHost(undoable) ? <HostChangesNeeded action="rollBack" /> : null}
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
            <p>{verified.ok ? S.allPassed : S.somePassed}</p>
            {verified.checks.length ? <Checks checks={verified.checks} /> : null}
          </div>
        </div>
      ) : null}
      {outputs.length ? (
        <section className="ws-card" aria-label={S.outputs}>
          {outputs.map(([k, v]) => (
            <div key={k} className="net-output">
              <span className="nv-field-label">{outputLabel(k)}</span>
              <div className="row">
                <code className="ws-code-inline net-break">{v}</code>
                <CopyButton
                  value={v}
                  text={
                    k === 'wireguardPublicKey'
                      ? { copy: S.copy.key, copied: S.copy.keyCopied, failed: S.copy.keyFailed }
                      : {
                          copy: S.copy.value,
                          copied: S.copy.valueCopied,
                          failed: S.copy.valueFailed,
                        }
                  }
                />
              </div>
            </div>
          ))}
        </section>
      ) : null}
      {options.length ? (
        <details className="ws-advanced">
          <summary>{S.options}</summary>
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
      <ol className="net-steps" aria-label={S.steps}>
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
        title={consent ? S.consent.titleOf({ title: consent.step.title }) : S.consent.title}
        description={S.consent.description}
        confirmLabel={S.consent.confirm}
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
              throw new Error(S.consent.changed, { cause: err });
            }
            throw err;
          } finally {
            setBusy(null);
          }
        }}
      >
        {consent ? (
          <div className="stack net-tight">
            <blockquote className="net-consent" aria-label={S.consent.what} dir="auto">
              {consent.description}
            </blockquote>
            {consent.step.affects.length ? (
              <p className="net-cuts">
                <Icon name="alert" />{' '}
                {S.consent.cuts({
                  n: consent.step.affects.length,
                  paths: transportsText(consent.step.affects) ?? '',
                })}
              </p>
            ) : null}
            <p className="muted ws-flush net-small">
              {S.consent.remembers({
                kind: stepKindLabel(consent.step.kind),
                provider: stepProviderLabel(consent.step.provider),
              })}
            </p>
          </div>
        ) : null}
      </ConfirmDialog>
      <ConfirmDialog
        open={rollback !== null}
        title={rollback === 'run' ? S.rollback.runTitle : S.rollback.stepTitle}
        description={
          rollback === 'run'
            ? S.rollback.runText
            : lastUndoable
              ? S.rollback.stepText({ title: lastUndoable.title })
              : undefined
        }
        confirmLabel={S.rollback.confirm}
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
                text: S.rollback.couldNotUndo({ titles: fmt.list(failed.map((s) => s.title)) }),
              }
            : { tone: 'ok', text: S.rollback.done };
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
    <nav aria-label={S.breadcrumb} className="ws-breadcrumb">
      <a href={path} onClick={(e) => followLink(e, path)}>
        <Icon name="back" /> {sectionInfo('setup').label}
      </a>
    </nav>
  );
}

function Checks({ checks }: { checks: NetworkSetupCheckView[] }) {
  return (
    <ul className="net-checks" aria-label={S.checks}>
      {checks.map((c, i) => (
        <li key={`${i}-${c.name}`} data-ok={c.ok || undefined}>
          <Icon name={c.ok ? 'check' : 'alert'} />
          <span>
            {c.detail
              ? S.checkDetail({ name: c.name, ok: c.ok ? 'yes' : 'no', detail: c.detail })
              : S.check({ name: c.name, ok: c.ok ? 'yes' : 'no' })}
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
          <Icon name="alert" />{' '}
          {S.rollback.cuts({ n: cuts.length, paths: transportsText(cuts) ?? '' })}
        </p>
      ) : null}
      {commands.length ? (
        <details className="ws-advanced">
          <summary>{S.rollback.commands}</summary>
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
  const applyLabel = check ? S.step.test : s.status === 'pending' ? S.step.apply : S.step.tryAgain;
  return (
    <li className="net-step" data-status={s.status} aria-labelledby={headingId}>
      <div className="net-step-head">
        <span className="net-step-index" aria-hidden="true">
          {s.index + 1}
        </span>
        <h3 id={headingId}>{s.title}</h3>
        <Chip spec={stepStatusChip(s.status)} />
        {s.systemChange ? (
          <Chip spec={{ text: S.step.changesComputer, tone: 'neutral', icon: 'terminal' }} />
        ) : null}
      </div>
      <span className="muted ws-row-meta net-small">
        <span>{stepKindLabel(s.kind)}</span>
        <span>{S.step.with({ provider: stepProviderLabel(s.provider) })}</span>
        {s.appliedAt ? <span>{S.step.applied({ when: formatWhen(s.appliedAt) })}</span> : null}
        {s.verifiedAt ? <span>{S.step.checked({ when: formatWhen(s.verifiedAt) })}</span> : null}
        {s.rolledBackAt ? (
          <span>{S.step.rolledBack({ when: formatWhen(s.rolledBackAt) })}</span>
        ) : null}
      </span>
      <p className="net-step-desc" dir="auto">
        {s.description}
      </p>
      {s.status === 'manual' ? <p className="muted ws-flush">{S.step.manual}</p> : null}
      {s.affects.length ? (
        <p className="net-cuts">
          <Icon name="alert" />{' '}
          {S.step.cuts({ n: s.affects.length, paths: transportsText(s.affects) ?? '' })}
        </p>
      ) : null}
      {s.consent.required && (s.consent.remembered || canApply(s)) ? (
        <p className="muted ws-flush net-small">
          {s.consent.remembered ? S.step.allowedBefore : S.step.asks}
        </p>
      ) : null}
      {s.commands.length || s.undoCommands.length ? (
        <details className="ws-advanced">
          <summary>{S.step.commands}</summary>
          {s.commands.length ? (
            <pre role="group" className="ws-log" aria-label={S.step.commandsItRuns} dir="ltr">
              {s.commands.map(commandText).join('\n')}
            </pre>
          ) : null}
          {s.undoCommands.length ? (
            <>
              <h4 className="net-small">{S.step.undoneBy}</h4>
              <pre role="group" className="ws-log" aria-label={S.step.undoCommands} dir="ltr">
                {s.undoCommands.map(commandText).join('\n')}
              </pre>
            </>
          ) : null}
        </details>
      ) : null}
      {s.checks.length ? <Checks checks={s.checks} /> : null}
      {s.error && s.status !== 'verified' ? (
        <p className="net-why">
          {s.autoRolledBack ? S.step.autoRolledBack({ error: s.error }) : s.error}
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
            {S.step.check}
          </Button>
          {isLastUndoable && !(s.systemChange && hostOff) ? (
            <Button variant="danger" onClick={onRollBack}>
              <Icon name="undo" /> {S.step.rollBack}
            </Button>
          ) : null}
        </div>
      ) : s.status === 'rollback_failed' && isLastUndoable ? (
        s.systemChange && hostOff ? (
          <HostChangesNeeded action="rollBackStep" />
        ) : (
          <div className="row">
            <Button variant="danger" onClick={onRollBack}>
              <Icon name="undo" /> {S.step.rollBackAgain}
            </Button>
          </div>
        )
      ) : null}
    </li>
  );
}
