// Settings → Agents (FR-079, FR-082, FR-182, FR-194, FR-206; docs/09 §8, docs/14): what a new
// agent starts with (autonomy, budgets, proactive research and how often it may run), the limits on
// wake-ups agents set for themselves (a security setting: global, and managed policy can lock it),
// and the external agents the user has named. `ExternalAgentsSection` can also stand alone, e.g.
// under Permissions.
import { useEffect, useId, useState } from 'react';
import { defineMessages } from '@nova/i18n';
import type { ExternalAgentView, RunAutonomy } from '@nova/shared';
import { Button, Dialog, Icon, SelectField, Spinner, TextField, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { useSettings } from '../settings.tsx';
import { SwitchField } from '../settings/controls.tsx';
import { ManagedNote } from '../managed/ManagedNote.tsx';
import { formatWhen } from '../settings/common.ts';
import { useAgentsApi } from './api.ts';
import {
  BudgetFields,
  budgetDraft,
  FIELDS_TEXT,
  parseBudgets,
  type BudgetDraft,
} from './fields.tsx';
import { AGENT_AUTONOMY_TEXT, AGENTS_TEXT } from './format.ts';
import '../workspace.css';
import './agents.css';

export const SETTINGS_TEXT = defineMessages('agents.settings', {
  saveFailed: 'Could not save: {reason}',
  budgetsSaved: 'Default budgets saved.',
  newAgents: 'New agents',
  newAgentsIntro: 'What a new agent starts with. Each agent can change it later.',
  autonomy: 'Autonomy',
  /** An autonomy level that cannot be chosen yet: "Autonomous (needs a reviewer model)". */
  needsReviewer: '{level} (needs a reviewer model)',
  saveBudgets: 'Save budgets',
  proactive: 'Proactive research for new agents',
  proactiveHint:
    'While idle, an agent reads your connected sources with read-only tools and brings you ' +
    'suggestions. It never acts on its own findings.',
  interval: 'Research at most every (minutes)',
  intervalHint: 'Applies to every agent with proactive research on. 60 is once an hour.',
  wakes: 'Wake-ups agents set',
  wakesIntro:
    'An agent can schedule its own next wake-up. These wake-ups show in Work, Scheduled, ' +
    'where you can change or cancel them, and they respect quiet hours.',
  wakesSaved: 'Wake-up limits saved.',
  limits: 'Limits',
  managed: 'Managed by your organization',
  soonest: 'Soonest (minutes ahead)',
  furthest: 'Furthest (days ahead)',
  perDay: 'Most per agent per day',
  soonestError:
    'The soonest wake-up is from {min} to {max, plural, one {# minute} other {# minutes}} ahead.',
  furthestError:
    'The furthest wake-up is from {min} to {max, plural, one {# day} other {# days}} ahead.',
  perDayError:
    'An agent can set from {min} to {max, plural, one {# wake-up} other {# wake-ups}} a day.',
  saveLimits: 'Save limits',
});

export const EXTERNAL_TEXT = defineMessages('agents.external', {
  loadFailed: 'Could not load external agents.',
  added: 'Added “{address}”.',
  addFailed: 'Could not add it.',
  heading: 'External agents',
  intro:
    'Messages, pages and files written by other AI agents are treated as untrusted. Your ' +
    'agents never take tasks from, hand work to, or send data to another agent unless you name ' +
    "it for the task at hand. Add the addresses or names of agents you know, such as a vendor's " +
    'billing bot, so they are recognized.',
  form: 'Add an external agent',
  address: 'Address or name',
  addressPlaceholder: 'billing-bot@vendor.com or Billing Agent',
  label: 'Label (optional)',
  loading: 'Loading external agents',
  empty: 'None yet.',
  list: 'External agents',
  addedAt: 'Added {when}',
  removeOf: 'Remove {name}',
  removeTitle: 'Remove this external agent?',
  removeBody: 'It is no longer recognized by name. Content from it is still treated as untrusted.',
  removed: 'Removed.',
  removeFailed: 'Could not remove it: {reason}',
});

export function AgentsSettings() {
  return (
    <div className="settings-page">
      <h2>{AGENTS_TEXT.agents}</h2>
      <NewAgentDefaults />
      <WakeLimits />
      <ExternalAgentsSection />
    </div>
  );
}

function NewAgentDefaults() {
  const settings = useSettings();
  const toast = useToast();
  const autonomy = settings.get('agents.autonomy');
  const budgets = settings.get('agents.defaultBudgets');
  const proactive = settings.get('agents.proactive');
  const reviewer = settings.get('review.model').value;
  const [draft, setDraft] = useState<BudgetDraft>(() => budgetDraft(budgets.value));
  const [errors, setErrors] = useState<Partial<Record<keyof BudgetDraft, string>>>({});
  const [every, setEvery] = useState(String(proactive.value.intervalMinutes));
  const [intervalError, setIntervalError] = useState<string | undefined>();

  const fail = (err: unknown) =>
    toast.show(SETTINGS_TEXT.saveFailed({ reason: errorMessage(err) }), { tone: 'error' });
  const parsed = parseBudgets(draft);
  // Any edit enables Save, so a value out of range is explained rather than ignored.
  const saved = budgetDraft(budgets.value);
  const budgetsChanged =
    draft.minutes.trim() !== saved.minutes ||
    draft.tokens.trim() !== saved.tokens ||
    draft.cost.trim() !== saved.cost;

  const saveBudgets = () => {
    if ('errors' in parsed) {
      setErrors(parsed.errors);
      return;
    }
    setErrors({});
    settings
      .set('agents.defaultBudgets', parsed.budgets)
      .then(() => toast.show(SETTINGS_TEXT.budgetsSaved, { tone: 'success' }), fail);
  };
  const saveInterval = () => {
    const m = Number(every);
    if (!/^\d+$/.test(every.trim()) || m < 15 || m > 10_080) {
      setIntervalError(FIELDS_TEXT.minutesError({ min: 15, max: 10_080, days: 7 }));
      return;
    }
    setIntervalError(undefined);
    if (m === proactive.value.intervalMinutes) return;
    settings.set('agents.proactive', { ...proactive.value, intervalMinutes: m }).catch(fail);
  };

  return (
    <section className="settings-section" aria-labelledby="agents-defaults">
      <h3 id="agents-defaults">{SETTINGS_TEXT.newAgents}</h3>
      <p className="muted ws-flush">{SETTINGS_TEXT.newAgentsIntro}</p>
      <SelectField
        label={SETTINGS_TEXT.autonomy}
        value={autonomy.value}
        locked={autonomy.locked}
        onChange={(v) => void settings.set('agents.autonomy', v as RunAutonomy).catch(fail)}
        options={(Object.keys(AGENT_AUTONOMY_TEXT) as RunAutonomy[]).map((a) => ({
          value: a,
          label:
            a === 'autonomous' && !reviewer
              ? SETTINGS_TEXT.needsReviewer({ level: AGENT_AUTONOMY_TEXT[a].label })
              : AGENT_AUTONOMY_TEXT[a].label,
          disabled: a === 'autonomous' && !reviewer && autonomy.value !== a,
        }))}
        hint={AGENT_AUTONOMY_TEXT[autonomy.value].description}
      />
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          saveBudgets();
        }}
      >
        <BudgetFields
          value={draft}
          onChange={(d) => {
            setDraft(d);
            setErrors({});
          }}
          errors={errors}
          disabled={budgets.locked}
        />
        <div className="ws-toolbar">
          <Button type="submit" disabled={budgets.locked || !budgetsChanged}>
            {SETTINGS_TEXT.saveBudgets}
          </Button>
        </div>
      </form>
      <SwitchField
        label={SETTINGS_TEXT.proactive}
        description={SETTINGS_TEXT.proactiveHint}
        checked={proactive.value.enabledByDefault}
        locked={proactive.locked}
        onChange={(v) =>
          void settings
            .set('agents.proactive', { ...proactive.value, enabledByDefault: v })
            .catch(fail)
        }
      />
      <div className="ws-toolbar">
        <TextField
          label={SETTINGS_TEXT.interval}
          inputMode="numeric"
          className="ws-number"
          value={every}
          disabled={proactive.locked}
          hint={SETTINGS_TEXT.intervalHint}
          error={intervalError}
          onChange={(e) => setEvery(e.target.value)}
          onBlur={saveInterval}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              saveInterval();
            }
          }}
        />
      </div>
    </section>
  );
}

function WakeLimits() {
  const settings = useSettings();
  const toast = useToast();
  const wakes = settings.get('agents.wakes');
  const [min, setMin] = useState(String(wakes.value.minMinutes));
  const [horizon, setHorizon] = useState(String(wakes.value.horizonDays));
  const [perDay, setPerDay] = useState(String(wakes.value.perDay));
  const [error, setError] = useState<string | null>(null);

  const parsed = ((): { ok: typeof wakes.value } | { error: string } => {
    const a = Number(min);
    const b = Number(horizon);
    const c = Number(perDay);
    if (!/^\d+$/.test(min.trim()) || a < 5 || a > 1440)
      return { error: SETTINGS_TEXT.soonestError({ min: 5, max: 1440 }) };
    if (!/^\d+$/.test(horizon.trim()) || b < 1 || b > 30)
      return { error: SETTINGS_TEXT.furthestError({ min: 1, max: 30 }) };
    if (!/^\d+$/.test(perDay.trim()) || c > 24)
      return { error: SETTINGS_TEXT.perDayError({ min: 0, max: 24 }) };
    return { ok: { minMinutes: a, horizonDays: b, perDay: c } };
  })();
  // Any edit enables Save, so a value out of range is explained rather than ignored.
  const changed =
    min.trim() !== String(wakes.value.minMinutes) ||
    horizon.trim() !== String(wakes.value.horizonDays) ||
    perDay.trim() !== String(wakes.value.perDay);

  return (
    <section className="settings-section" aria-labelledby="agents-wakes">
      <h3 id="agents-wakes">{SETTINGS_TEXT.wakes}</h3>
      <p className="muted ws-flush">{SETTINGS_TEXT.wakesIntro}</p>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if ('error' in parsed) {
            setError(parsed.error);
            return;
          }
          setError(null);
          settings.set('agents.wakes', parsed.ok).then(
            () => toast.show(SETTINGS_TEXT.wakesSaved, { tone: 'success' }),
            (err: unknown) =>
              toast.show(SETTINGS_TEXT.saveFailed({ reason: errorMessage(err) }), {
                tone: 'error',
              }),
          );
        }}
      >
        <fieldset
          className="ws-fieldset"
          disabled={wakes.locked}
          aria-describedby={wakes.locked ? 'agents-wakes-lock' : undefined}
        >
          <legend>{SETTINGS_TEXT.limits}</legend>
          {wakes.locked ? (
            <ManagedNote as="p" id="agents-wakes-lock" setting="agents.wakes" />
          ) : null}
          <div className="agent-budget-fields">
            <TextField
              label={SETTINGS_TEXT.soonest}
              inputMode="numeric"
              className="ws-number"
              value={min}
              onChange={(e) => setMin(e.target.value)}
            />
            <TextField
              label={SETTINGS_TEXT.furthest}
              inputMode="numeric"
              className="ws-number"
              value={horizon}
              onChange={(e) => setHorizon(e.target.value)}
            />
            <TextField
              label={SETTINGS_TEXT.perDay}
              inputMode="numeric"
              className="ws-number"
              value={perDay}
              onChange={(e) => setPerDay(e.target.value)}
            />
          </div>
        </fieldset>
        {error ? (
          <p className="nv-field-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="ws-toolbar">
          <Button type="submit" disabled={wakes.locked || !changed}>
            {SETTINGS_TEXT.saveLimits}
          </Button>
        </div>
      </form>
    </section>
  );
}

/**
 * External agents (FR-194): other AI agents the user has named. Content from other agents is
 * untrusted; a Nova agent works with an external agent only when the user names it for the task
 * at hand. This list records the addresses and names the user has identified as agents.
 */
export function ExternalAgentsSection() {
  const api = useAgentsApi();
  const toast = useToast();
  const id = `ext${useId()}`;
  const [items, setItems] = useState<ExternalAgentView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [address, setAddress] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [removing, setRemoving] = useState<ExternalAgentView | null>(null);

  useEffect(() => {
    let alive = true;
    api.listExternalAgents().then(
      ({ items: list }) => {
        if (!alive) return;
        setItems(list);
        setError(null);
      },
      (err: unknown) => alive && setError(errorMessage(err, EXTERNAL_TEXT.loadFailed)),
    );
    return () => {
      alive = false;
    };
  }, [api, version]);

  const add = async () => {
    if (!address.trim() || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const e = await api.addExternalAgent({
        address: address.trim(),
        ...(label.trim() ? { label: label.trim() } : {}),
      });
      setItems((list) => (list?.some((x) => x.id === e.id) ? list : [...(list ?? []), e]));
      setAddress('');
      setLabel('');
      toast.show(EXTERNAL_TEXT.added({ address: e.address }), { tone: 'success' });
    } catch (err) {
      setFailure(errorMessage(err, EXTERNAL_TEXT.addFailed));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-section" aria-labelledby={`${id}-h`}>
      <h3 id={`${id}-h`}>{EXTERNAL_TEXT.heading}</h3>
      <p className="muted ws-flush">{EXTERNAL_TEXT.intro}</p>
      <form
        className="ws-toolbar agent-external-form"
        aria-label={EXTERNAL_TEXT.form}
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <TextField
          label={EXTERNAL_TEXT.address}
          value={address}
          maxLength={300}
          autoComplete="off"
          spellCheck={false}
          placeholder={EXTERNAL_TEXT.addressPlaceholder}
          onChange={(e) => setAddress(e.target.value)}
        />
        <TextField
          label={EXTERNAL_TEXT.label}
          value={label}
          maxLength={200}
          autoComplete="off"
          onChange={(e) => setLabel(e.target.value)}
        />
        <Button type="submit" disabled={busy || !address.trim()}>
          {busy ? <Spinner /> : <Icon name="plus" />} {AGENTS_TEXT.add}
        </Button>
      </form>
      {failure ? (
        <p className="nv-field-error" role="alert">
          {failure}
        </p>
      ) : null}
      {error ? (
        <div className="ws-error" role="alert">
          <p>{error}</p>
          <Button onClick={() => setVersion((v) => v + 1)}>{AGENTS_TEXT.retry}</Button>
        </div>
      ) : items === null ? (
        <Spinner label={EXTERNAL_TEXT.loading} />
      ) : items.length === 0 ? (
        <p className="muted">{EXTERNAL_TEXT.empty}</p>
      ) : (
        <ul className="ws-list" aria-label={EXTERNAL_TEXT.list}>
          {items.map((e) => (
            <li key={e.id} className="ws-list-row" aria-label={e.label ?? e.address}>
              <div className="work-row-main">
                <span className="ws-card-link" dir="auto">
                  {e.label ?? e.address}
                </span>
                <span className="muted ws-row-meta">
                  {e.label ? <code dir="ltr">{e.address}</code> : null}
                  <span>{EXTERNAL_TEXT.addedAt({ when: formatWhen(e.createdAt) })}</span>
                </span>
              </div>
              <Button
                variant="danger"
                aria-label={EXTERNAL_TEXT.removeOf({ name: e.label ?? e.address })}
                onClick={() => setRemoving(e)}
              >
                {AGENTS_TEXT.remove}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Dialog
        open={removing !== null}
        title={EXTERNAL_TEXT.removeTitle}
        description={EXTERNAL_TEXT.removeBody}
        onClose={() => setRemoving(null)}
        footer={
          <>
            <Button onClick={() => setRemoving(null)}>{AGENTS_TEXT.cancel}</Button>
            <Button
              variant="danger"
              onClick={() => {
                const e = removing;
                setRemoving(null);
                if (!e) return;
                api.removeExternalAgent(e.id).then(
                  () => {
                    setItems((list) => list?.filter((x) => x.id !== e.id) ?? null);
                    toast.show(EXTERNAL_TEXT.removed, { tone: 'success' });
                  },
                  (err: unknown) =>
                    toast.show(EXTERNAL_TEXT.removeFailed({ reason: errorMessage(err) }), {
                      tone: 'error',
                    }),
                );
              }}
            >
              {AGENTS_TEXT.remove}
            </Button>
          </>
        }
      />
    </section>
  );
}
