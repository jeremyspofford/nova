// Settings → Code (FR-063, FR-085, FR-195; docs/10 §3, docs/12 §2.1): the permission mode new
// Code sessions start in, whether Bypass may be used at all, and the reviewer model that Auto
// mode and auto-review need. Bypass and the reviewer are security settings: global only, and
// managed policy can lock them.
//
// M6 (docs/10 §2, §7-§9, docs/09 §2): links to the saved environments and the worktree registry,
// the Git hosts sessions push to and open pull requests on (FR-070; tokens are write-only),
// auto-verify (FR-068: on or off, the commands, their timeout and how many failed runs go back
// to the agent), default budgets for new sessions, CI polling and feedback, and what happens to
// a worktree when its session is archived (FR-073).
import { useId, useState } from 'react';
import { defineMessages } from '@nova/i18n';
import { Icon, SelectField, TextField, useToast } from '@nova/ui';
import type { PermissionMode } from '@nova/shared';
import { errorMessage } from '../api.ts';
import { AppLink, ENVIRONMENTS_PATH, WORKTREES_PATH } from '../code/CodeNav.tsx';
import { GitHostsSection } from '../code/GitHosts.tsx';
import { MODE_DESCRIPTION, MODE_LABEL } from '../code/modes.ts';
import { modelGroups } from '../providers/model-groups.ts';
import { useSettings } from '../settings.tsx';
import { useModels } from '../stores.tsx';
import { ManagedNote } from '../managed/ManagedNote.tsx';
import { SwitchField } from './controls.tsx';
import '../workspace.css';
import { CodeM7Settings } from '../code/CodeM7Settings.tsx';

export const CODE_TEXT = defineMessages('settings.code', {
  saveFailed: 'Could not save: {error}',
  title: 'Code',
  mode: 'Permission mode for new sessions',
  /** A mode that cannot be chosen yet, with the reason. */
  modeUnavailable:
    '{reason, select, reviewer {{mode} (needs a reviewer model, chosen below)} other {{mode} (needs Allow Bypass, below)}}',
  modeHint:
    '{description} A folder keeps the mode you last used in it. Plan is picked per session.',
  modeProblem:
    '{reason, select, reviewer {{mode} needs a reviewer model, chosen below. Until then new sessions start in {manual}.} other {{mode} needs Allow Bypass, below. Until then new sessions start in {manual}.}}',
  reviewer: 'Reviewer model',
  noReviewer: 'None (Auto mode is unavailable)',
  reviewerHint:
    'Auto mode sends every consequential action to this model, which can only make the ' +
    'decision stricter. Pick a different model than the one doing the work.',
  allowBypass: 'Allow Bypass mode',
  allowBypassHint:
    'Lets a session stop asking where a tool default would ask. Your own rules, managed policy ' +
    'and confirmation steps (purchases, credentials, deleting outside the project) still ask. ' +
    'Only sessions on a VM or container environment can use it.',
  bypassWarning:
    'With Bypass, the agent can change and run things without asking you first. Use it only in ' +
    'an isolated environment you can throw away.',
  environments: 'Environments and worktrees',
  environmentsHint:
    'Code sessions run on the Hub, in a container image, on an SSH host, in a WSL distro or on ' +
    'a device with the Nova device agent.',
  manageEnvironments: 'Manage environments',
  manageWorktrees: 'Manage worktrees',
  autoVerify: 'Auto-verify',
  runChecks: 'Run the checks after edits',
  runChecksHint:
    "After a turn edits files, the project's build and test checks run in the sandbox and the " +
    'session shows pass or fail with logs.',
  checkTimeout: 'Stop a check after (seconds)',
  feedbackTurns: 'Failed checks sent back to the agent in a row',
  feedbackNone: 'None: only report them',
  feedbackOnce: 'Once',
  feedbackTwice: 'Twice',
  feedbackThrice: 'Three times',
  feedbackHint:
    'After this many failed automatic runs in a row, the session stops sending them and waits ' +
    'for you.',
  tooManyCommands: 'Use at most {max} commands.',
  commandTooLong: 'Each command can be up to {max} characters.',
  commands: 'Check commands',
  commandsHint:
    'One command per line, run in the session folder. Leave empty to use the project’s own ' +
    'build and test commands.',
  budgets: 'Budgets for new sessions',
  budgetsHint:
    'A session stops at a limit and asks you to extend it. Leave a field empty for no limit; a ' +
    'new session can set its own.',
  timeLimit: 'Time limit (minutes)',
  tokenLimit: 'Token limit',
  costLimit: 'Cost limit (US dollars)',
  poll: '{unit, select, second {{n, plural, one {# second} other {# seconds}}} minute {{n, plural, one {# minute} other {# minutes}}} other {{n, plural, one {# hour} other {# hours}}}}',
  pullRequests: 'Pull requests',
  pollLabel: 'Check CI of open pull requests every',
  ciFeedback: 'Send failed CI checks to the agent',
  ciFeedbackHint:
    "When a session's pull request fails its checks, the failures go to the agent as a turn " +
    'so it can propose a fix.',
  worktrees: 'Worktrees',
  whenArchived: 'When a session is archived',
  removeClean: 'Remove its worktree if it has no uncommitted changes',
  keep: 'Keep its worktree',
  worktreeHint: 'A worktree with uncommitted changes is always kept; its lease is released.',
  noLimit: 'No limit',
  wholeRange: 'Enter a whole number from {min} to {max}.',
  wholeRangeOrEmpty: 'Enter a whole number from {min} to {max}, or leave it empty.',
  numberRange: 'Enter a number from {min} to {max}.',
  numberRangeOrEmpty: 'Enter a number from {min} to {max}, or leave it empty.',
});
const S = CODE_TEXT;

/** Modes a new session can start in; Plan is chosen per session (docs/10 §3). */
const DEFAULT_MODES = ['manual', 'accept_edits', 'auto', 'bypass'] as const;
type DefaultMode = (typeof DEFAULT_MODES)[number];

export function CodePage() {
  const settings = useSettings();
  const toast = useToast();
  const { models } = useModels();
  const mode = settings.get('code.permissionMode');
  const bypass = settings.get('code.allowBypass');
  const reviewer = settings.get('review.model');

  const fail = (err: unknown) =>
    toast.show(S.saveFailed({ error: errorMessage(err) }), { tone: 'error' });

  // The default is chosen before any environment exists, so Bypass is judged on the setting.
  const why = (m: PermissionMode): 'reviewer' | 'bypass' | null => {
    if (m === 'auto' && !reviewer.value) return 'reviewer';
    if (m === 'bypass' && !bypass.value) return 'bypass';
    return null;
  };
  const modeProblem = why(mode.value);

  return (
    <div className="settings-page">
      <h2>{S.title}</h2>
      <section className="settings-section">
        <SelectField
          label={S.mode}
          value={mode.value}
          locked={mode.locked}
          onChange={(v) => void settings.set('code.permissionMode', v as DefaultMode).catch(fail)}
          options={DEFAULT_MODES.map((m) => {
            const reason = why(m);
            return {
              value: m,
              label: reason ? S.modeUnavailable({ reason, mode: MODE_LABEL[m] }) : MODE_LABEL[m],
              disabled: reason !== null && m !== mode.value,
            };
          })}
          hint={S.modeHint({ description: MODE_DESCRIPTION[mode.value] })}
        />
        {modeProblem ? (
          <p className="ws-warning" role="note">
            <Icon name="alert" />{' '}
            {S.modeProblem({
              reason: modeProblem,
              mode: MODE_LABEL[mode.value],
              manual: MODE_LABEL.manual,
            })}
          </p>
        ) : null}
      </section>
      <section className="settings-section">
        <SelectField
          label={S.reviewer}
          value={reviewer.value ?? ''}
          locked={reviewer.locked}
          onChange={(v) => void settings.set('review.model', v || null).catch(fail)}
          options={[{ value: '', label: S.noReviewer }]}
          groups={modelGroups(models)}
          hint={S.reviewerHint}
        />
      </section>
      <section className="settings-section">
        <SwitchField
          label={S.allowBypass}
          description={S.allowBypassHint}
          checked={bypass.value}
          locked={bypass.locked}
          onChange={(v) => void settings.set('code.allowBypass', v).catch(fail)}
        />
        {bypass.value ? (
          <p className="ws-warning" role="note">
            <Icon name="alert" /> {S.bypassWarning}
          </p>
        ) : null}
      </section>
      <EnvironmentsLinks />
      <GitHostsSection />
      <AutoVerifySection onError={fail} />
      <BudgetsSection onError={fail} />
      <PullRequestsSection onError={fail} />
      <WorktreeSection onError={fail} />
      <CodeM7Settings />
    </div>
  );
}

function EnvironmentsLinks() {
  const id = useId();
  return (
    <section className="settings-section" aria-labelledby={id}>
      <h3 id={id}>{S.environments}</h3>
      <p className="muted">{S.environmentsHint}</p>
      <p className="code-links">
        <AppLink to={ENVIRONMENTS_PATH}>{S.manageEnvironments}</AppLink>
        <AppLink to={WORKTREES_PATH}>{S.manageWorktrees}</AppLink>
      </p>
    </section>
  );
}

// ---- auto-verify (FR-068) -----------------------------------------------------------------------

function AutoVerifySection({ onError }: { onError: (err: unknown) => void }) {
  const settings = useSettings();
  const id = useId();
  const entry = settings.get('code.autoVerify');
  const v = entry.value;
  const save = (next: Partial<typeof v>) =>
    void settings.set('code.autoVerify', { ...v, ...next }).catch(onError);

  return (
    <section className="settings-section" aria-labelledby={id}>
      <h3 id={id}>{S.autoVerify}</h3>
      <SwitchField
        label={S.runChecks}
        description={S.runChecksHint}
        checked={v.enabled}
        locked={entry.locked}
        onChange={(enabled) => save({ enabled })}
      />
      <CommandsField
        value={v.commands}
        locked={entry.locked}
        onSave={(commands) => save({ commands })}
      />
      <NumberSetting
        label={S.checkTimeout}
        value={v.timeoutSeconds}
        min={30}
        max={3600}
        locked={entry.locked}
        onSave={(n) => {
          if (n !== null) save({ timeoutSeconds: n });
        }}
      />
      <SelectField
        label={S.feedbackTurns}
        value={String(v.feedbackTurns)}
        locked={entry.locked}
        onChange={(n) => save({ feedbackTurns: Number(n) })}
        options={[
          { value: '0', label: S.feedbackNone },
          { value: '1', label: S.feedbackOnce },
          { value: '2', label: S.feedbackTwice },
          { value: '3', label: S.feedbackThrice },
        ]}
        hint={S.feedbackHint}
      />
    </section>
  );
}

const MAX_COMMANDS = 10;
/** Example check commands: code, the same in every language. */
const COMMANDS_EXAMPLE = 'npm run build\nnpm test';

/** One command per line, saved on blur; empty detects the build and test commands. */
function CommandsField({
  value,
  locked,
  onSave,
}: {
  value: string[];
  locked: boolean;
  onSave: (commands: string[]) => void;
}) {
  const id = `cmds${useId()}`;
  const shown = value.join('\n');
  const [draft, setDraft] = useState<{ base: string; text: string } | null>(null);
  const text = draft && draft.base === shown ? draft.text : shown;
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const problem =
    lines.length > MAX_COMMANDS
      ? S.tooManyCommands({ max: MAX_COMMANDS })
      : lines.some((l) => l.length > 500)
        ? S.commandTooLong({ max: 500 })
        : null;
  const commit = () => {
    if (problem || lines.join('\n') === shown) return;
    setDraft(null);
    onSave(lines);
  };
  const describedBy = [`${id}-hint`, problem ? `${id}-err` : null, locked ? `${id}-lock` : null]
    .filter(Boolean)
    .join(' ');
  return (
    <div className="nv-field">
      <label className="nv-field-label" htmlFor={id}>
        {S.commands}
      </label>
      <textarea
        id={id}
        className="nv-input ws-textarea code-mono"
        rows={3}
        spellCheck={false}
        value={text}
        disabled={locked}
        placeholder={COMMANDS_EXAMPLE}
        aria-invalid={problem ? true : undefined}
        aria-describedby={describedBy}
        onChange={(e) => setDraft({ base: shown, text: e.target.value })}
        onBlur={commit}
      />
      {locked ? <ManagedNote id={`${id}-lock`} setting="code.autoVerify" /> : null}
      <span id={`${id}-hint`} className="nv-field-hint">
        {S.commandsHint}
      </span>
      {problem ? (
        <span id={`${id}-err`} className="nv-field-error" role="alert">
          {problem}
        </span>
      ) : null}
    </div>
  );
}

// ---- budgets (docs/09 §2) -----------------------------------------------------------------------

function BudgetsSection({ onError }: { onError: (err: unknown) => void }) {
  const settings = useSettings();
  const id = useId();
  const entry = settings.get('code.budgets');
  const b = entry.value;
  const save = (next: Partial<typeof b>) =>
    void settings.set('code.budgets', { ...b, ...next }).catch(onError);
  return (
    <section className="settings-section" aria-labelledby={id}>
      <h3 id={id}>{S.budgets}</h3>
      <p className="muted">{S.budgetsHint}</p>
      <div className="code-form-row">
        <NumberSetting
          label={S.timeLimit}
          value={b.timeSeconds === null ? null : Math.round(b.timeSeconds / 60)}
          min={1}
          max={7 * 24 * 60}
          nullable
          locked={entry.locked}
          onSave={(n) => save({ timeSeconds: n === null ? null : n * 60 })}
        />
        <NumberSetting
          label={S.tokenLimit}
          value={b.tokens}
          min={1_000}
          max={1_000_000_000}
          nullable
          locked={entry.locked}
          onSave={(n) => save({ tokens: n })}
        />
        <NumberSetting
          label={S.costLimit}
          value={b.costUsd}
          min={0.01}
          max={100_000}
          decimals
          nullable
          locked={entry.locked}
          onSave={(n) => save({ costUsd: n })}
        />
      </div>
    </section>
  );
}

// ---- pull requests and CI (FR-070) --------------------------------------------------------------

const POLL_CHOICES = [15, 30, 60, 120, 300, 600, 1800, 3600];

function pollLabel(s: number): string {
  return s < 60
    ? S.poll({ unit: 'second', n: s })
    : s < 3600
      ? S.poll({ unit: 'minute', n: s / 60 })
      : S.poll({ unit: 'hour', n: s / 3600 });
}

function PullRequestsSection({ onError }: { onError: (err: unknown) => void }) {
  const settings = useSettings();
  const id = useId();
  const poll = settings.get('code.ciPollSeconds');
  const feedback = settings.get('code.ciFeedback');
  const choices = POLL_CHOICES.includes(poll.value) ? POLL_CHOICES : [...POLL_CHOICES, poll.value];
  return (
    <section className="settings-section" aria-labelledby={id}>
      <h3 id={id}>{S.pullRequests}</h3>
      <SelectField
        label={S.pollLabel}
        value={String(poll.value)}
        locked={poll.locked}
        onChange={(v) => void settings.set('code.ciPollSeconds', Number(v)).catch(onError)}
        options={[...choices]
          .sort((a, b) => a - b)
          .map((s) => ({ value: String(s), label: pollLabel(s) }))}
      />
      <SwitchField
        label={S.ciFeedback}
        description={S.ciFeedbackHint}
        checked={feedback.value}
        locked={feedback.locked}
        onChange={(v) => void settings.set('code.ciFeedback', v).catch(onError)}
      />
    </section>
  );
}

// ---- worktrees (FR-073) -------------------------------------------------------------------------

function WorktreeSection({ onError }: { onError: (err: unknown) => void }) {
  const settings = useSettings();
  const id = useId();
  const cleanup = settings.get('code.worktreeCleanup');
  return (
    <section className="settings-section" aria-labelledby={id}>
      <h3 id={id}>{S.worktrees}</h3>
      <SelectField
        label={S.whenArchived}
        value={cleanup.value}
        locked={cleanup.locked}
        onChange={(v) =>
          void settings.set('code.worktreeCleanup', v as 'remove_clean' | 'keep').catch(onError)
        }
        options={[
          { value: 'remove_clean', label: S.removeClean },
          { value: 'keep', label: S.keep },
        ]}
        hint={S.worktreeHint}
      />
    </section>
  );
}

// ---- a number setting saved on Enter or blur ----------------------------------------------------

function rangeError(o: { min: number; max: number; decimals?: boolean; nullable?: boolean }) {
  const { min, max } = o;
  if (o.decimals)
    return o.nullable ? S.numberRangeOrEmpty({ min, max }) : S.numberRange({ min, max });
  return o.nullable ? S.wholeRangeOrEmpty({ min, max }) : S.wholeRange({ min, max });
}

function NumberSetting({
  label,
  value,
  min,
  max,
  decimals,
  nullable,
  locked,
  onSave,
}: {
  label: string;
  value: number | null;
  min: number;
  max: number;
  decimals?: boolean;
  /** Empty means no limit. */
  nullable?: boolean;
  locked: boolean;
  onSave: (n: number | null) => void;
}) {
  const shown = value === null ? '' : String(value);
  const [draft, setDraft] = useState<{ base: string; text: string } | null>(null);
  // A draft belongs to the value it was typed against; a new value from the Hub discards it.
  const text = draft && draft.base === shown ? draft.text : shown;
  const blank = text.trim() === '';
  const n = Number(text);
  const invalid = blank
    ? !nullable
    : !Number.isFinite(n) || n < min || n > max || (!decimals && !Number.isInteger(n));
  const commit = () => {
    if (invalid || text === shown) return;
    setDraft(null);
    onSave(blank ? null : n);
  };
  return (
    <TextField
      label={label}
      type="number"
      inputMode={decimals ? 'decimal' : 'numeric'}
      className="ws-number"
      min={min}
      max={max}
      step={decimals ? 0.01 : 1}
      value={text}
      placeholder={nullable ? S.noLimit : undefined}
      locked={locked}
      error={invalid ? rangeError({ min, max, decimals, nullable }) : undefined}
      onChange={(e) => setDraft({ base: shown, text: e.target.value })}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        }
      }}
    />
  );
}
