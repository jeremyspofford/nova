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
import { Icon, SelectField, TextField, useToast } from '@nova/ui';
import type { PermissionMode } from '@nova/shared';
import { errorMessage } from '../api.ts';
import { AppLink, ENVIRONMENTS_PATH, WORKTREES_PATH } from '../code/CodeNav.tsx';
import { GitHostsSection } from '../code/GitHosts.tsx';
import { MODE_DESCRIPTION, MODE_LABEL } from '../code/modes.ts';
import { modelGroups } from '../providers/model-groups.ts';
import { useSettings } from '../settings.tsx';
import { useModels } from '../stores.tsx';
import { MANAGED } from './common.ts';
import { SwitchField } from './controls.tsx';
import '../workspace.css';

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
    toast.show(`Could not save: ${errorMessage(err)}`, { tone: 'error' });

  // The default is chosen before any environment exists, so Bypass is judged on the setting.
  const why = (m: PermissionMode): string | null => {
    if (m === 'auto' && !reviewer.value) return 'needs a reviewer model, chosen below';
    if (m === 'bypass' && !bypass.value) return 'needs Allow Bypass, below';
    return null;
  };
  const modeProblem = why(mode.value);

  return (
    <div className="settings-page">
      <h2>Code</h2>
      <section className="settings-section">
        <SelectField
          label="Permission mode for new sessions"
          value={mode.value}
          locked={mode.locked}
          onChange={(v) => void settings.set('code.permissionMode', v as DefaultMode).catch(fail)}
          options={DEFAULT_MODES.map((m) => {
            const reason = why(m);
            return {
              value: m,
              label: reason ? `${MODE_LABEL[m]} (${reason})` : MODE_LABEL[m],
              disabled: reason !== null && m !== mode.value,
            };
          })}
          hint={`${MODE_DESCRIPTION[mode.value]} A folder keeps the mode you last used in it. Plan is picked per session.`}
        />
        {modeProblem ? (
          <p className="ws-warning" role="note">
            <Icon name="alert" /> {MODE_LABEL[mode.value]} {modeProblem}. Until then new sessions
            start in Manual.
          </p>
        ) : null}
      </section>
      <section className="settings-section">
        <SelectField
          label="Reviewer model"
          value={reviewer.value ?? ''}
          locked={reviewer.locked}
          onChange={(v) => void settings.set('review.model', v || null).catch(fail)}
          options={[{ value: '', label: 'None (Auto mode is unavailable)' }]}
          groups={modelGroups(models)}
          hint="Auto mode sends every consequential action to this model, which can only make the decision stricter. Pick a different model than the one doing the work."
        />
      </section>
      <section className="settings-section">
        <SwitchField
          label="Allow Bypass mode"
          description="Lets a session stop asking where a tool default would ask. Your own rules, managed policy and confirmation steps (purchases, credentials, deleting outside the project) still ask. Only sessions on a VM or container environment can use it."
          checked={bypass.value}
          locked={bypass.locked}
          onChange={(v) => void settings.set('code.allowBypass', v).catch(fail)}
        />
        {bypass.value ? (
          <p className="ws-warning" role="note">
            <Icon name="alert" /> With Bypass, the agent can change and run things without asking
            you first. Use it only in an isolated environment you can throw away.
          </p>
        ) : null}
      </section>
      <EnvironmentsLinks />
      <GitHostsSection />
      <AutoVerifySection onError={fail} />
      <BudgetsSection onError={fail} />
      <PullRequestsSection onError={fail} />
      <WorktreeSection onError={fail} />
    </div>
  );
}

function EnvironmentsLinks() {
  const id = useId();
  return (
    <section className="settings-section" aria-labelledby={id}>
      <h3 id={id}>Environments and worktrees</h3>
      <p className="muted">
        Code sessions run on the Hub, in a container image, on an SSH host, in a WSL distro or on a
        device with the Nova device agent.
      </p>
      <p className="code-links">
        <AppLink to={ENVIRONMENTS_PATH}>Manage environments</AppLink>
        <AppLink to={WORKTREES_PATH}>Manage worktrees</AppLink>
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
      <h3 id={id}>Auto-verify</h3>
      <SwitchField
        label="Run the checks after edits"
        description="After a turn edits files, the project's build and test checks run in the sandbox and the session shows pass or fail with logs."
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
        label="Stop a check after (seconds)"
        value={v.timeoutSeconds}
        min={30}
        max={3600}
        locked={entry.locked}
        onSave={(n) => {
          if (n !== null) save({ timeoutSeconds: n });
        }}
      />
      <SelectField
        label="Failed checks sent back to the agent in a row"
        value={String(v.feedbackTurns)}
        locked={entry.locked}
        onChange={(n) => save({ feedbackTurns: Number(n) })}
        options={[
          { value: '0', label: 'None: only report them' },
          { value: '1', label: 'Once' },
          { value: '2', label: 'Twice' },
          { value: '3', label: 'Three times' },
        ]}
        hint="After this many failed automatic runs in a row, the session stops sending them and waits for you."
      />
    </section>
  );
}

const MAX_COMMANDS = 10;

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
      ? `Use at most ${MAX_COMMANDS} commands.`
      : lines.some((l) => l.length > 500)
        ? 'Each command can be up to 500 characters.'
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
        Check commands
      </label>
      <textarea
        id={id}
        className="nv-input ws-textarea code-mono"
        rows={3}
        spellCheck={false}
        value={text}
        disabled={locked}
        placeholder={'npm run build\nnpm test'}
        aria-invalid={problem ? true : undefined}
        aria-describedby={describedBy}
        onChange={(e) => setDraft({ base: shown, text: e.target.value })}
        onBlur={commit}
      />
      {locked ? (
        <span id={`${id}-lock`} className="nv-field-hint nv-field-lock">
          {MANAGED}
        </span>
      ) : null}
      <span id={`${id}-hint`} className="nv-field-hint">
        One command per line, run in the session folder. Leave empty to use the project’s own build
        and test commands.
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
      <h3 id={id}>Budgets for new sessions</h3>
      <p className="muted">
        A session stops at a limit and asks you to extend it. Leave a field empty for no limit; a
        new session can set its own.
      </p>
      <div className="code-form-row">
        <NumberSetting
          label="Time limit (minutes)"
          value={b.timeSeconds === null ? null : Math.round(b.timeSeconds / 60)}
          min={1}
          max={7 * 24 * 60}
          nullable
          locked={entry.locked}
          onSave={(n) => save({ timeSeconds: n === null ? null : n * 60 })}
        />
        <NumberSetting
          label="Token limit"
          value={b.tokens}
          min={1_000}
          max={1_000_000_000}
          nullable
          locked={entry.locked}
          onSave={(n) => save({ tokens: n })}
        />
        <NumberSetting
          label="Cost limit (US dollars)"
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
    ? `${s} seconds`
    : s === 60
      ? '1 minute'
      : s < 3600
        ? `${s / 60} minutes`
        : '1 hour';
}

function PullRequestsSection({ onError }: { onError: (err: unknown) => void }) {
  const settings = useSettings();
  const id = useId();
  const poll = settings.get('code.ciPollSeconds');
  const feedback = settings.get('code.ciFeedback');
  const choices = POLL_CHOICES.includes(poll.value) ? POLL_CHOICES : [...POLL_CHOICES, poll.value];
  return (
    <section className="settings-section" aria-labelledby={id}>
      <h3 id={id}>Pull requests</h3>
      <SelectField
        label="Check CI of open pull requests every"
        value={String(poll.value)}
        locked={poll.locked}
        onChange={(v) => void settings.set('code.ciPollSeconds', Number(v)).catch(onError)}
        options={[...choices]
          .sort((a, b) => a - b)
          .map((s) => ({ value: String(s), label: pollLabel(s) }))}
      />
      <SwitchField
        label="Send failed CI checks to the agent"
        description="When a session's pull request fails its checks, the failures go to the agent as a turn so it can propose a fix."
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
      <h3 id={id}>Worktrees</h3>
      <SelectField
        label="When a session is archived"
        value={cleanup.value}
        locked={cleanup.locked}
        onChange={(v) =>
          void settings.set('code.worktreeCleanup', v as 'remove_clean' | 'keep').catch(onError)
        }
        options={[
          { value: 'remove_clean', label: 'Remove its worktree if it has no uncommitted changes' },
          { value: 'keep', label: 'Keep its worktree' },
        ]}
        hint="A worktree with uncommitted changes is always kept; its lease is released."
      />
    </section>
  );
}

// ---- a number setting saved on Enter or blur ----------------------------------------------------

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
      placeholder={nullable ? 'No limit' : undefined}
      disabled={locked}
      hint={locked ? MANAGED : undefined}
      error={
        invalid
          ? `Enter ${decimals ? 'a number' : 'a whole number'} from ${min.toLocaleString('en-US')} to ${max.toLocaleString('en-US')}${nullable ? ', or leave it empty' : ''}.`
          : undefined
      }
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
