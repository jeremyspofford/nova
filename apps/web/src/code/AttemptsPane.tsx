// Best of N (FR-212; docs/10 §9): run one task as 2 to 4 attempts, each its own session in its own
// worktree with its own budget and, optionally, its own model. Compare them side by side: the
// files each changed, its patch, its test results and what it cost. Apply one (merged into this
// session; the others are stopped and their worktrees removed) or discard them all; both ask
// first. A conflicting apply writes nothing and offers conflict markers instead.
import { useId, useState, type CSSProperties } from 'react';
import type {
  CodeAttemptSetView,
  CodeAttemptView,
  CodeMergeView,
  CodeSessionView,
} from '@nova/shared';
import { MAX_CODE_ATTEMPTS } from '@nova/shared';
import { defineMessages, fmt } from '@nova/i18n';
import { Button, Dialog, EmptyState, Icon, SelectField, Spinner, TextField } from '@nova/ui';
import { useHubStream } from '../hub-events.ts';
import { modelGroups } from '../providers/model-groups.ts';
import { useAnnounce } from '../services.tsx';
import { formatWhen } from '../settings/common.ts';
import { useSettings } from '../settings.tsx';
import { modelLabel, useModels } from '../stores.tsx';
import { ConfirmAction, TextBlock, useLoad } from '../cloud/parts.tsx';
import { TextArea } from '../cloud/CloudEnvironmentDialog.tsx';
import { useCodeM7Api } from './api-m7.ts';
import { AppLink } from './CodeNav.tsx';
import { sessionPath } from './labels.ts';
import {
  VERIFY_ICON,
  VERIFY_TEXT,
  VERIFY_TONE,
  errorReason,
  formatCost,
  formatSpan,
  formatTokens,
} from './m6-format.ts';
import { ATTEMPT_STATUS, SET_STATUS, codeM7ErrorMessage, conflictPaths } from './m7-format.ts';
import { parseBudgets, type BudgetDraft } from './NewSessionDialog.tsx';
import { Badge } from './parts.tsx';

export const ATTEMPTS_TEXT = defineMessages('code.attempts', {
  intro:
    'Run one task as several attempts in separate worktrees, compare what each did, and keep the best.',
  bestOfN: 'Best of N…',
  loadFailed: 'Could not load the attempts.',
  retry: 'Retry',
  loading: 'Loading the attempts',
  emptyTitle: 'No attempts yet',
  emptyBody:
    'Best of N runs the same task 2 to 4 times, each with its own budget, so you can compare and keep one.',
  sets: 'Attempt sets',
  count: '{n, plural, one {# attempt} other {# attempts}}',
  from: 'From {commit}',
  appliedConflicts: 'Applied with conflicts to resolve in the Merges tab.',
  applied: 'Attempt applied.',
  started: '{n, plural, one {Started # attempt.} other {Started # attempts.}}',
  conflicts: 'Attempt {n} conflicts with this session’s files, so nothing was written.',
  conflictsIn: 'Attempt {n} conflicts with this session’s files ({paths}), so nothing was written.',
  withMarkers: 'Apply with conflict markers',
  sideBySide: 'Attempts side by side',
  sessionModel: 'The session’s model',
  sessionModelIs: 'The session’s model ({model})',
  discardAll: 'Discard all…',
  applyTitle: 'Apply attempt {n}?',
  applyBody:
    'Its changes are merged into this session. The other attempts stop, and their sessions and worktrees are removed.',
  apply: 'Apply',
  applyFailed: 'Could not apply the attempt.',
  discardTitle: 'Discard every attempt?',
  discardBody:
    'They stop, and their sessions and worktrees are removed. This session stays as it is.',
  discardConfirm: 'Discard all',
  discardFailed: 'Could not discard the attempts.',
  attempt: 'Attempt {n}',
  model: 'Model',
  files: 'Files',
  fileCount: '{n, plural, one {# file} other {# files}}',
  addedLines: '{n, plural, one {# added line} other {# added lines}}',
  removedLines: '{n, plural, one {# removed line} other {# removed lines}}',
  tests: 'Tests',
  notRun: 'Not run yet',
  cost: 'Cost',
  costLine: '{cost}, {tokens} tokens, {time}',
  changedFiles: 'Files attempt {n} changed',
  binary: 'binary',
  noChanges: 'No changes yet.',
  lastReply: 'Its last reply',
  lastReplyOf: 'Attempt {n}’s last reply',
  patch: 'The patch',
  patchOf: 'Attempt {n}’s patch',
  patchCut: 'The patch is cut short here.',
  applyButton: 'Apply…',
  openSession: 'Open its session',
  describeTask: 'Describe the task every attempt works on.',
  startFailed: 'Could not start the attempts.',
  dialogTitle: 'Best of N',
  dialogBody:
    'Each attempt is its own session in its own worktree, starting from this session’s last commit.',
  task: 'The task',
  attempts: 'Attempts',
  modelEach: 'Model of each attempt',
  budgetEach: 'Budget of each attempt',
  minutes: 'Time (minutes)',
  tokens: 'Tokens',
  costUsd: 'Cost (US dollars)',
  budgetHint: 'Each attempt stops at its own limits. Empty means no limit.',
  cancel: 'Cancel',
  start: '{n, plural, one {Start # attempt} other {Start # attempts}}',
  pickModel: 'Pick a model for attempt {n} too, or leave every attempt on the session’s model.',
});

export function AttemptsPane({
  session,
  unavailable,
  startRequest = 0,
  onApplied,
}: {
  session: CodeSessionView;
  /** Why attempts cannot start here (a session on another machine, no repository). */
  unavailable: string | null;
  /** Bumped by the session header's Best of N…: opens the start dialog. */
  startRequest?: number;
  onApplied: (merge: CodeMergeView) => void;
}) {
  const m7 = useCodeM7Api();
  const announce = useAnnounce();
  const list = useLoad(
    () => m7.listAttempts(session.id).then((r) => r.items),
    `attempts:${session.id}`,
  );
  const [starting, setStarting] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  // A pane first mounted by Best of N… opens its dialog at once.
  const [seen, setSeen] = useState(0);
  if (startRequest !== seen) {
    setSeen(startRequest);
    if (!unavailable) setStarting(true);
  }
  useHubStream(
    ['code.attempts.updated', 'code.verify.completed'],
    (env) => {
      if (env.name === 'code.verify.completed' || env.payload.sessionId === session.id)
        list.reload();
    },
    list.reload,
  );
  const items = list.data;
  const shown = open ?? items?.[0]?.id ?? null;
  return (
    <div className="cm7-pane">
      <div className="cm7-pane-head">
        <p className="muted ws-flush">{ATTEMPTS_TEXT.intro}</p>
        <Button
          disabled={!!unavailable}
          title={unavailable ?? undefined}
          onClick={() => setStarting(true)}
        >
          <Icon name="split-right" /> {ATTEMPTS_TEXT.bestOfN}
        </Button>
      </div>
      {unavailable ? <p className="muted cl-small">{unavailable}</p> : null}
      {list.error && !items ? (
        <div className="ws-error" role="alert">
          <p>{codeM7ErrorMessage(list.error, ATTEMPTS_TEXT.loadFailed)}</p>
          <Button onClick={list.reload}>{ATTEMPTS_TEXT.retry}</Button>
        </div>
      ) : null}
      {list.loading ? <Spinner label={ATTEMPTS_TEXT.loading} /> : null}
      {items?.length === 0 ? (
        <EmptyState
          level={3}
          title={ATTEMPTS_TEXT.emptyTitle}
          description={ATTEMPTS_TEXT.emptyBody}
          icon="split-right"
        />
      ) : null}
      {items?.length ? (
        <ul className="cm7-list" aria-label={ATTEMPTS_TEXT.sets}>
          {items.map((set) => (
            <li key={set.id} className="cm7-row" aria-label={set.objective}>
              <span className="cm7-row-title">
                <button
                  type="button"
                  className="cl-link"
                  dir="auto"
                  aria-expanded={shown === set.id}
                  onClick={() => setOpen(shown === set.id ? '' : set.id)}
                >
                  {set.objective.length > 80 ? `${set.objective.slice(0, 80)}…` : set.objective}
                </button>
                <Badge tone={SET_STATUS[set.status].tone} icon={SET_STATUS[set.status].icon}>
                  {SET_STATUS[set.status].text}
                </Badge>
              </span>
              <span className="muted ws-row-meta">
                <span>{ATTEMPTS_TEXT.count({ n: set.attempts.length })}</span>
                <span>{ATTEMPTS_TEXT.from({ commit: set.baseSha.slice(0, 7) })}</span>
                <span>{formatWhen(set.createdAt)}</span>
              </span>
              {shown === set.id ? (
                <Compare
                  set={set}
                  onChanged={(next) =>
                    list.setData((prev) => prev?.map((x) => (x.id === next.id ? next : x)) ?? null)
                  }
                  onApplied={(next, merge) => {
                    list.setData((prev) => prev?.map((x) => (x.id === next.id ? next : x)) ?? null);
                    announce(
                      merge.status === 'conflicted'
                        ? ATTEMPTS_TEXT.appliedConflicts
                        : ATTEMPTS_TEXT.applied,
                    );
                    onApplied(merge);
                  }}
                />
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      <StartAttemptsDialog
        open={starting}
        session={session}
        onClose={() => setStarting(false)}
        onStarted={(set) => {
          setStarting(false);
          list.setData((prev) => [set, ...(prev ?? []).filter((x) => x.id !== set.id)]);
          setOpen(set.id);
          announce(ATTEMPTS_TEXT.started({ n: set.attempts.length }));
        }}
      />
    </div>
  );
}

function Compare({
  set,
  onChanged,
  onApplied,
}: {
  set: CodeAttemptSetView;
  onChanged: (set: CodeAttemptSetView) => void;
  onApplied: (set: CodeAttemptSetView, merge: CodeMergeView) => void;
}) {
  const m7 = useCodeM7Api();
  const { models } = useModels();
  const [applying, setApplying] = useState<CodeAttemptView | null>(null);
  const [refused, setRefused] = useState<{ attempt: CodeAttemptView; paths: string[] } | null>(
    null,
  );
  const [discarding, setDiscarding] = useState(false);
  const settled = set.status === 'applied' || set.status === 'discarded';

  const apply = async (a: CodeAttemptView, markers: boolean) => {
    try {
      const r = await m7.applyAttempt(set.id, {
        attemptId: a.id,
        ...(markers ? { onConflict: 'markers' as const } : {}),
      });
      setApplying(null);
      setRefused(null);
      onApplied(r.set, r.merge);
    } catch (err) {
      if (errorReason(err) === 'merge_conflict') {
        setApplying(null);
        setRefused({ attempt: a, paths: conflictPaths(err) });
        return;
      }
      throw err;
    }
  };

  return (
    <div className="cm7-detail">
      {refused ? (
        <div className="cl-notice" data-tone="warn" role="alert">
          <Icon name="alert" />
          <span>
            {refused.paths.length
              ? ATTEMPTS_TEXT.conflictsIn({
                  n: refused.attempt.index + 1,
                  paths: fmt.list(refused.paths, { type: 'unit', style: 'short' }),
                })
              : ATTEMPTS_TEXT.conflicts({ n: refused.attempt.index + 1 })}{' '}
            <Button onClick={() => void apply(refused.attempt, true).catch(() => undefined)}>
              {ATTEMPTS_TEXT.withMarkers}
            </Button>
          </span>
        </div>
      ) : null}
      <div
        className="cm7-compare"
        role="group"
        aria-label={ATTEMPTS_TEXT.sideBySide}
        style={{ '--cm7-n': set.attempts.length } as CSSProperties}
      >
        {set.attempts.map((a) => (
          <AttemptColumn
            key={a.id}
            a={a}
            model={a.model ? modelLabel(models, a.model) : ATTEMPTS_TEXT.sessionModel}
            chosen={set.appliedAttemptId === a.id}
            canApply={!settled && a.status !== 'discarded'}
            onApply={() => setApplying(a)}
          />
        ))}
      </div>
      {settled ? null : (
        <div className="cl-actions">
          <Button variant="danger" onClick={() => setDiscarding(true)}>
            <Icon name="trash" /> {ATTEMPTS_TEXT.discardAll}
          </Button>
        </div>
      )}
      <ConfirmAction
        open={applying !== null}
        title={ATTEMPTS_TEXT.applyTitle({ n: (applying?.index ?? 0) + 1 })}
        description={ATTEMPTS_TEXT.applyBody}
        confirmLabel={ATTEMPTS_TEXT.apply}
        errorText={(err) => codeM7ErrorMessage(err, ATTEMPTS_TEXT.applyFailed)}
        onClose={() => setApplying(null)}
        onConfirm={async () => {
          if (applying) await apply(applying, false);
        }}
      />
      <ConfirmAction
        open={discarding}
        title={ATTEMPTS_TEXT.discardTitle}
        description={ATTEMPTS_TEXT.discardBody}
        confirmLabel={ATTEMPTS_TEXT.discardConfirm}
        danger
        errorText={(err) => codeM7ErrorMessage(err, ATTEMPTS_TEXT.discardFailed)}
        onClose={() => setDiscarding(false)}
        onConfirm={async () => {
          const next = await m7.discardAttempts(set.id);
          setDiscarding(false);
          onChanged(next);
        }}
      />
    </div>
  );
}

function AttemptColumn({
  a,
  model,
  chosen,
  canApply,
  onApply,
}: {
  a: CodeAttemptView;
  model: string;
  chosen: boolean;
  canApply: boolean;
  onApply: () => void;
}) {
  const id = useId();
  const s = ATTEMPT_STATUS[a.status];
  const t = a.tests;
  return (
    <section className="cm7-attempt" aria-labelledby={id} data-chosen={chosen || undefined}>
      <h4 id={id} className="cm7-attempt-title">
        {ATTEMPTS_TEXT.attempt({ n: a.index + 1 })}
      </h4>
      <Badge tone={s.tone} icon={s.icon}>
        {s.text}
      </Badge>
      <dl className="cm7-attempt-facts">
        <div>
          <dt>{ATTEMPTS_TEXT.model}</dt>
          <dd>{model}</dd>
        </div>
        <div>
          <dt>{ATTEMPTS_TEXT.files}</dt>
          <dd>
            {ATTEMPTS_TEXT.fileCount({ n: a.files.length })},{' '}
            <span role="img" aria-label={ATTEMPTS_TEXT.addedLines({ n: a.additions })}>
              +{a.additions}
            </span>{' '}
            <span role="img" aria-label={ATTEMPTS_TEXT.removedLines({ n: a.deletions })}>
              −{a.deletions}
            </span>
          </dd>
        </div>
        <div>
          <dt>{ATTEMPTS_TEXT.tests}</dt>
          <dd>
            {t ? (
              <Badge tone={VERIFY_TONE[t.status]} icon={VERIFY_ICON[t.status]}>
                {VERIFY_TEXT[t.status]}
              </Badge>
            ) : (
              ATTEMPTS_TEXT.notRun
            )}
          </dd>
        </div>
        <div>
          <dt>{ATTEMPTS_TEXT.cost}</dt>
          <dd>
            {ATTEMPTS_TEXT.costLine({
              cost: formatCost(a.budget.used.costUsd),
              tokens: formatTokens(a.budget.used.tokens),
              time: formatSpan(a.budget.used.timeSeconds),
            })}
          </dd>
        </div>
      </dl>
      {a.files.length ? (
        <ul
          className="cm7-attempt-files"
          aria-label={ATTEMPTS_TEXT.changedFiles({ n: a.index + 1 })}
        >
          {a.files.map((f) => (
            <li key={f.path}>
              <code className="cl-break">{f.path}</code>{' '}
              <span className="muted cl-small">
                {f.binary ? ATTEMPTS_TEXT.binary : `+${f.additions} −${f.deletions}`}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted cl-small">{ATTEMPTS_TEXT.noChanges}</p>
      )}
      {a.reply ? (
        <details className="ws-advanced">
          <summary>{ATTEMPTS_TEXT.lastReply}</summary>
          <TextBlock text={a.reply} label={ATTEMPTS_TEXT.lastReplyOf({ n: a.index + 1 })} />
        </details>
      ) : null}
      {a.patch ? (
        <details className="ws-advanced">
          <summary>{ATTEMPTS_TEXT.patch}</summary>
          <TextBlock text={a.patch} label={ATTEMPTS_TEXT.patchOf({ n: a.index + 1 })} />
          {a.patchTruncated ? <p className="muted cl-small">{ATTEMPTS_TEXT.patchCut}</p> : null}
        </details>
      ) : null}
      <div className="cl-actions">
        {canApply ? (
          <Button variant="primary" onClick={onApply}>
            <Icon name="check" /> {ATTEMPTS_TEXT.applyButton}
          </Button>
        ) : null}
        {a.status !== 'discarded' && a.status !== 'applied' ? (
          <AppLink to={sessionPath(a.sessionId)}>{ATTEMPTS_TEXT.openSession}</AppLink>
        ) : null}
      </div>
    </section>
  );
}

function StartAttemptsDialog({
  open,
  session,
  onClose,
  onStarted,
}: {
  open: boolean;
  session: CodeSessionView;
  onClose: () => void;
  onStarted: (set: CodeAttemptSetView) => void;
}) {
  if (!open) return null;
  return <StartAttemptsForm session={session} onClose={onClose} onStarted={onStarted} />;
}

function StartAttemptsForm({
  session,
  onClose,
  onStarted,
}: {
  session: CodeSessionView;
  onClose: () => void;
  onStarted: (set: CodeAttemptSetView) => void;
}) {
  const m7 = useCodeM7Api();
  const settings = useSettings();
  const { models } = useModels();
  const id = `bn${useId()}`;
  const defaults = settings.get('code.attempts').value;
  const [objective, setObjective] = useState('');
  const [count, setCount] = useState(String(defaults.count));
  const [budget, setBudget] = useState<BudgetDraft>({
    minutes: defaults.budgets.timeSeconds
      ? String(Math.round(defaults.budgets.timeSeconds / 60))
      : '',
    tokens: defaults.budgets.tokens ? String(defaults.budgets.tokens) : '',
    cost: defaults.budgets.costUsd ? String(defaults.budgets.costUsd) : '',
  });
  const [picked, setPicked] = useState<string[]>([]);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const n = Number(count);
  const budgets = parseBudgets(budget);
  const problems: Record<string, string> = {};
  if (!objective.trim()) problems.objective = ATTEMPTS_TEXT.describeTask;
  if ('error' in budgets) problems.budget = budgets.error;
  const perAttempt = attemptModels(picked.slice(0, n), session.model);
  if ('error' in perAttempt) problems.models = perAttempt.error;
  const shown = tried ? problems : {};

  const submit = async () => {
    setTried(true);
    if (Object.keys(problems).length || busy || 'error' in budgets || 'error' in perAttempt) return;
    setBusy(true);
    setError(null);
    try {
      onStarted(
        await m7.startAttempts(session.id, {
          objective: objective.trim(),
          count: n,
          ...(budgets.budgets ? { budgets: budgets.budgets } : {}),
          ...(perAttempt.models.length ? { models: perAttempt.models } : {}),
        }),
      );
    } catch (err) {
      setError(codeM7ErrorMessage(err, ATTEMPTS_TEXT.startFailed));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={ATTEMPTS_TEXT.dialogTitle}
      description={ATTEMPTS_TEXT.dialogBody}
      onClose={onClose}
      className="ws-wide-dialog"
    >
      <form
        className="stack cm7-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <TextArea
          id={`${id}-objective`}
          label={ATTEMPTS_TEXT.task}
          value={objective}
          rows={4}
          error={shown.objective}
          onChange={setObjective}
        />
        <SelectField
          label={ATTEMPTS_TEXT.attempts}
          value={count}
          onChange={setCount}
          options={Array.from({ length: MAX_CODE_ATTEMPTS - 1 }, (_, i) => ({
            value: String(i + 2),
            label: fmt.number(i + 2),
          }))}
        />
        <fieldset className="ws-fieldset">
          <legend>{ATTEMPTS_TEXT.modelEach}</legend>
          {Array.from({ length: n }, (_, i) => (
            <SelectField
              key={i}
              label={ATTEMPTS_TEXT.attempt({ n: i + 1 })}
              value={picked[i] ?? ''}
              onChange={(v) =>
                setPicked((p) => {
                  const next = [...p];
                  next[i] = v;
                  return next;
                })
              }
              options={[
                {
                  value: '',
                  label: session.model
                    ? ATTEMPTS_TEXT.sessionModelIs({ model: modelLabel(models, session.model) })
                    : ATTEMPTS_TEXT.sessionModel,
                },
              ]}
              groups={modelGroups(models)}
            />
          ))}
          {shown.models ? (
            <p className="nv-field-error" role="alert">
              {shown.models}
            </p>
          ) : null}
        </fieldset>
        <fieldset className="ws-fieldset">
          <legend>{ATTEMPTS_TEXT.budgetEach}</legend>
          <div className="cl-field-row">
            <TextField
              label={ATTEMPTS_TEXT.minutes}
              type="number"
              inputMode="numeric"
              className="ws-number"
              min={1}
              value={budget.minutes}
              onChange={(e) => setBudget((b) => ({ ...b, minutes: e.target.value }))}
            />
            <TextField
              label={ATTEMPTS_TEXT.tokens}
              type="number"
              inputMode="numeric"
              className="ws-number"
              min={1000}
              value={budget.tokens}
              onChange={(e) => setBudget((b) => ({ ...b, tokens: e.target.value }))}
            />
            <TextField
              label={ATTEMPTS_TEXT.costUsd}
              type="number"
              inputMode="decimal"
              className="ws-number"
              min={0.01}
              step={0.01}
              value={budget.cost}
              onChange={(e) => setBudget((b) => ({ ...b, cost: e.target.value }))}
            />
          </div>
          {shown.budget ? (
            <p className="nv-field-error" role="alert">
              {shown.budget}
            </p>
          ) : (
            <p className="nv-field-hint">{ATTEMPTS_TEXT.budgetHint}</p>
          )}
        </fieldset>
        {error ? (
          <p className="nv-field-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="nv-dialog-footer">
          <Button onClick={onClose}>{ATTEMPTS_TEXT.cancel}</Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? <Spinner /> : null} {ATTEMPTS_TEXT.start({ n: Number.isFinite(n) ? n : 0 })}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * The models to send, by attempt: up to the last one picked, the session's model filling the
 * others. Without a session model an earlier attempt cannot be left on it.
 */
export function attemptModels(
  picked: readonly string[],
  sessionModel: string | null,
): { models: string[] } | { error: string } {
  let last = -1;
  picked.forEach((v, i) => {
    if (v) last = i;
  });
  const out: string[] = [];
  for (let i = 0; i <= last; i++) {
    const v = picked[i] || sessionModel;
    if (!v)
      return {
        error: ATTEMPTS_TEXT.pickModel({ n: i + 1 }),
      };
    out.push(v);
  }
  return { models: out };
}
