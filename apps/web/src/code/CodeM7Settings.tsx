// The M7 parts of Settings → Code (docs/10 §2, §9, §15): SSH environments on or off (a security
// setting: it runs this machine's ssh client and installs Nova's helper on hosts, so turning it on
// asks first), what a handoff does with the changes it leaves behind (FR-213), and how many
// attempts Best of N runs with what budget each (FR-212). Cloud environments and flagged features
// have their own sections, linked here.
import { useId, useState } from 'react';
import { Button, RadioGroup, SelectField, TextField, useToast } from '@nova/ui';
import { ConfirmAction, InAppLink } from '../cloud/parts.tsx';
import { CLOUD_SETTINGS_PATH } from '../cloud/format.ts';
import { EXPERIMENTAL_LABEL, EXPERIMENTAL_PATH } from '../flagged/format.ts';
import { errorMessage } from '../api.ts';
import { SwitchField } from '../settings/controls.tsx';
import { useSettings } from '../settings.tsx';
import { MAX_CODE_ATTEMPTS } from '@nova/shared';
import { parseBudgets, type BudgetDraft } from './NewSessionDialog.tsx';

export function CodeM7Settings() {
  return (
    <>
      <SshSection />
      <HandoffSection />
      <AttemptsSection />
      <MoreLinks />
    </>
  );
}

function SshSection() {
  const settings = useSettings();
  const toast = useToast();
  const id = useId();
  const entry = settings.get('code.ssh.enabled');
  const [asking, setAsking] = useState(false);
  return (
    <section className="settings-section" aria-labelledby={id}>
      <h3 id={id}>SSH environments</h3>
      <SwitchField
        label="Connect to SSH environments"
        description="Nova uses this computer’s ssh client with the key or password kept in the vault, and installs its helper under ~/.nova/remote on each host. A host’s key is pinned the first time; a different key later is refused."
        checked={entry.value}
        locked={entry.locked}
        onChange={(next) => {
          if (next) setAsking(true);
          else
            void settings
              .set('code.ssh.enabled', false)
              .catch((err: unknown) =>
                toast.show(`Could not save: ${errorMessage(err)}`, { tone: 'error' }),
              );
        }}
      />
      <ConfirmAction
        open={asking}
        title="Connect to SSH environments?"
        description="Nova will sign in to the hosts of your SSH environments and install its helper there. Sessions on those hosts run commands as the user you set up."
        confirmLabel="Turn on"
        errorText={(err) => errorMessage(err, 'Could not save.')}
        onClose={() => setAsking(false)}
        onConfirm={async () => {
          await settings.set('code.ssh.enabled', true);
          setAsking(false);
        }}
      />
    </section>
  );
}

function HandoffSection() {
  const settings = useSettings();
  const toast = useToast();
  const id = useId();
  const entry = settings.get('code.handoffSource');
  return (
    <section className="settings-section" aria-labelledby={id}>
      <h3 id={id}>Handing off sessions</h3>
      <RadioGroup
        legend="After a session moves, the changes it left behind"
        name={`${id}-src`}
        value={entry.value}
        locked={entry.locked}
        onChange={(v) =>
          void settings
            .set('code.handoffSource', v as 'keep' | 'clean')
            .catch((err: unknown) =>
              toast.show(`Could not save: ${errorMessage(err)}`, { tone: 'error' }),
            )
        }
        options={[
          { value: 'keep', label: 'Keep them', description: 'The old folder stays as it was.' },
          {
            value: 'clean',
            label: 'Clean them up',
            description: 'Only after the new place confirmed it has the same state.',
          },
        ]}
        hint="Each handoff can choose differently."
      />
    </section>
  );
}

function AttemptsSection() {
  const settings = useSettings();
  const toast = useToast();
  const id = useId();
  const entry = settings.get('code.attempts');
  const v = entry.value;
  const initial: BudgetDraft = {
    minutes: v.budgets.timeSeconds ? String(Math.round(v.budgets.timeSeconds / 60)) : '',
    tokens: v.budgets.tokens ? String(v.budgets.tokens) : '',
    cost: v.budgets.costUsd ? String(v.budgets.costUsd) : '',
  };
  const [count, setCount] = useState<string | null>(null);
  const [draft, setDraft] = useState<BudgetDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const d = draft ?? initial;
  const n = count ?? String(v.count);
  const save = async () => {
    const parsed = parseBudgets(d);
    if ('error' in parsed) {
      setError(parsed.error);
      return;
    }
    const b = parsed.budgets ?? {};
    try {
      await settings.set('code.attempts', {
        count: Number(n),
        budgets: {
          timeSeconds: b.timeSeconds ?? null,
          tokens: b.tokens ?? null,
          costUsd: b.costUsd ?? null,
        },
      });
      setDraft(null);
      setCount(null);
      setError(null);
      toast.show('Saved.', { tone: 'success' });
    } catch (err) {
      setError(errorMessage(err, 'Could not save.'));
    }
  };
  return (
    <section className="settings-section" aria-labelledby={id}>
      <h3 id={id}>Best of N</h3>
      <p className="muted">
        How many attempts a task runs by default, and the budget of each. You can change both when
        you start one.
      </p>
      <form
        className="stack"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <SelectField
          label="Attempts"
          value={n}
          locked={entry.locked}
          onChange={(x) => setCount(x)}
          options={Array.from({ length: MAX_CODE_ATTEMPTS - 1 }, (_, i) => ({
            value: String(i + 2),
            label: String(i + 2),
          }))}
        />
        <div className="cl-field-row">
          <TextField
            label="Time per attempt (minutes)"
            type="number"
            inputMode="numeric"
            className="ws-number"
            value={d.minutes}
            disabled={entry.locked}
            onChange={(e) => setDraft({ ...d, minutes: e.target.value })}
          />
          <TextField
            label="Tokens per attempt"
            type="number"
            inputMode="numeric"
            className="ws-number"
            value={d.tokens}
            disabled={entry.locked}
            onChange={(e) => setDraft({ ...d, tokens: e.target.value })}
          />
          <TextField
            label="Cost per attempt (US dollars)"
            type="number"
            inputMode="decimal"
            className="ws-number"
            value={d.cost}
            disabled={entry.locked}
            onChange={(e) => setDraft({ ...d, cost: e.target.value })}
          />
        </div>
        {error ? (
          <p className="nv-field-error" role="alert">
            {error}
          </p>
        ) : null}
        {entry.locked ? null : (
          <div>
            <Button type="submit" disabled={draft === null && count === null}>
              Save
            </Button>
          </div>
        )}
      </form>
    </section>
  );
}

function MoreLinks() {
  const id = useId();
  return (
    <section className="settings-section" aria-labelledby={id}>
      <h3 id={id}>Cloud and external agents</h3>
      <p className="muted">
        Cloud environments are set up in{' '}
        <InAppLink to={CLOUD_SETTINGS_PATH}>Settings → Cloud runner</InAppLink>. Delegating to
        external coding agents is in{' '}
        <InAppLink to={EXPERIMENTAL_PATH}>{EXPERIMENTAL_LABEL}</InAppLink>.
      </p>
    </section>
  );
}
