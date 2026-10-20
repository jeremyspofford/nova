// Settings → Experimental (docs/17 §M7: flagged features, off by default) at
// /settings/experimental: scripted tool calls (FR-202) with their limits, and external coding
// agents (FR-203) with their adapters (add, check in a Code session's sandbox, turn off, edit,
// remove). Both are security settings: global only, managed policy can lock them, and turning one
// on asks first. Where each shows up once it is on: script runs in a Code session's Scripts tab and
// all of the account's here, a page at a time; delegations in a Code session's Agents tab.
import { useEffect, useId, useState } from 'react';
import { defineMessages, fmt } from '@nova/i18n';
import type { AgentAdapterView, CodeSessionView } from '@nova/shared';
import {
  Button,
  Dialog,
  EmptyState,
  Icon,
  SelectField,
  Spinner,
  TextField,
  useToast,
} from '@nova/ui';
import { useAnnounce, useServices } from '../services.tsx';
import { formatWhen } from '../settings/common.ts';
import { SwitchField } from '../settings/controls.tsx';
import { useSettings } from '../settings.tsx';
import { Badge } from '../code/parts.tsx';
import { sessionTitle } from '../code/labels.ts';
import { ConfirmAction, useLoad } from '../cloud/parts.tsx';
import { AdapterDialog } from './AdapterDialog.tsx';
import { useFlaggedApi } from './api.ts';
import { FLAGGED_TEXT, failureText, flaggedErrorMessage } from './format.ts';
import { AllScriptRuns } from './ScriptRuns.tsx';
import '../workspace.css';
import './flagged.css';

/** Settings → Experimental. `{name}` is an adapter's name (data). */
export const EXPERIMENTAL_TEXT = defineMessages('flagged.experimental', {
  title: 'Experimental',
  intro:
    'Features that are still being tried out. They are off until you turn them on, and your ' +
    'organization can keep them off.',
  /** A toast: "Could not save: <why>". */
  saveFailedBecause: 'Could not save: {reason}',
  saveFailed: 'Could not save.',
  turnOn: 'Turn on',
  turnOff: 'Turn off',
  /** Why the script limits cannot be saved. */
  limits: {
    seconds: 'Set the time limit from {min} to {max} seconds.',
    memory: 'Set the memory limit from {min} to {max} MB.',
    calls: 'Allow from {min} to {max} tool calls per script.',
    log: 'Keep from {min} to {max} characters of console output.',
  },
  scripts: {
    heading: 'Scripted tool calls',
    label: 'Let the model call tools from a short script',
    description:
      'Offers script.run: JavaScript in an isolated engine without network or files, whose ' +
      'tool calls each pass your policy and are audited like direct calls.',
    confirmTitle: 'Turn on scripted tool calls?',
    confirmText:
      'The model can then write short scripts that call several tools in a row. Each call ' +
      'still asks or is denied as your rules say; nothing a script calls skips the policy.',
    where:
      'Script runs and each call they made show in a Code session’s Scripts tab, and all of ' +
      'them below.',
    seconds: 'Time limit (seconds)',
    memory: 'Memory (MB)',
    calls: 'Tool calls per script',
    log: 'Console output kept (characters)',
    managed: 'Your organization manages these limits.',
    save: 'Save limits',
    saved: 'Limits saved.',
    saveFailed: 'Could not save the limits.',
    runs: 'Script runs',
  },
  agents: {
    heading: 'External coding agents',
    label: 'Let Code sessions delegate to external agents',
    description:
      'Agents that speak the Agent Client Protocol work in a session’s sandbox. Nova decides ' +
      'every permission request they make, and their changes show in the Diff.',
    confirmTitle: 'Turn on external coding agents?',
    confirmText:
      'Programs you add as adapters can then run in Code sessions’ sandboxes. Every file ' +
      'change and command they ask for goes through your policy.',
    off: 'Turn this on to add adapters.',
  },
  adapters: {
    heading: 'Adapters',
    add: 'Add adapter',
    loadFailed: 'Could not load the adapters.',
    loading: 'Loading the adapters',
    empty: 'No adapters yet',
    emptyHint:
      'Add the program of an external coding agent. Then delegate to it from a Code session’s ' +
      'Agents tab.',
    list: 'Agent adapters',
    on: 'On',
    off: 'Off',
    checkPassed: 'Check passed',
    checkFailed: 'Check failed',
    /** `{names}` lists the names of the adapter's secret variables. */
    secrets: 'Secrets: {names}',
    noSecrets: 'No secrets',
    /** `{hosts}` lists host names. */
    reaches: 'Reaches {hosts}',
    noNetwork: 'No network',
    /** "Checked 5 minutes ago". */
    checked: 'Checked {when}',
    /** The agent's name and version as it reported them. */
    answersAs: 'Answers as {agent}',
    check: 'Check…',
    edit: 'Edit…',
    remove: 'Remove…',
    /** Said to screen readers after turning an adapter on or off. */
    toggled: '{state, select, on {{name} is on.} other {{name} is off.}}',
    /** A toast: "Could not change Coder: <why>". */
    changeFailed: 'Could not change {name}: {reason}',
    added: 'Added {name}.',
    saved: 'Saved {name}.',
    removeTitle: 'Remove {name}?',
    removeBody:
      'Its secrets leave the vault, and an agent it runs now is stopped. Past delegations keep ' +
      'their history.',
    removeConfirm: 'Remove',
    removeFailed: 'Could not remove the adapter.',
    removed: 'Removed {name}.',
  },
  check: {
    title: 'Check {name}',
    description:
      'The agent starts in a Code session’s sandbox and only says hello. It does no work.',
    check: 'Check',
    loading: 'Loading the sessions',
    loadingText: 'Loading sessions…',
    session: 'In the sandbox of',
    noSession: 'Start a Code session first: the check runs in a session’s sandbox.',
    /** `{version}` is the protocol version the agent named, or the word "unknown". */
    answered: 'The agent answered, protocol version {version}.',
    /** `{agent}` is the agent's name and version as it reported them. */
    answeredAs: 'The agent answered as {agent}, protocol version {version}.',
    unknownVersion: 'unknown',
    noAnswer: 'The agent did not answer.',
    failed: 'Could not check the adapter.',
  },
});

/** An agent's name with its version, as it reported them. */
function agentLabel(agent: { name: string | null; version?: string | null }): string {
  const name = agent.name ?? '';
  return agent.version ? `${name} ${agent.version}` : name;
}

/** Host or variable names joined as a short list. */
function names(list: readonly string[]): string {
  return fmt.list(list, { type: 'unit', style: 'short' });
}

export function ExperimentalSettings() {
  const S = EXPERIMENTAL_TEXT;
  return (
    <div className="settings-page">
      <h2>{S.title}</h2>
      <p className="muted">{S.intro}</p>
      <ScriptsSection />
      <AgentsSection />
    </div>
  );
}

/** A security switch that asks before turning on (turning off needs no confirmation). */
function GuardedSwitch({
  label,
  description,
  settingKey,
  confirmTitle,
  confirmText,
}: {
  label: string;
  description: string;
  settingKey: 'scripts.enabled' | 'externalAgents.enabled';
  confirmTitle: string;
  confirmText: string;
}) {
  const settings = useSettings();
  const toast = useToast();
  const entry = settings.get(settingKey);
  const [asking, setAsking] = useState(false);
  return (
    <>
      <SwitchField
        label={label}
        description={description}
        checked={entry.value}
        locked={entry.locked}
        onChange={(next) => {
          if (next) setAsking(true);
          else
            void settings.set(settingKey, false).catch((err: unknown) =>
              toast.show(
                EXPERIMENTAL_TEXT.saveFailedBecause({
                  reason: flaggedErrorMessage(err, 'agents'),
                }),
                { tone: 'error' },
              ),
            );
        }}
      />
      <ConfirmAction
        open={asking}
        title={confirmTitle}
        description={confirmText}
        confirmLabel={EXPERIMENTAL_TEXT.turnOn}
        errorText={(err) => flaggedErrorMessage(err, 'agents', EXPERIMENTAL_TEXT.saveFailed)}
        onClose={() => setAsking(false)}
        onConfirm={async () => {
          await settings.set(settingKey, true);
          setAsking(false);
        }}
      />
    </>
  );
}

// ---- scripted tool calls (FR-202) --------------------------------------------------------------

interface LimitsDraft {
  seconds: string;
  memory: string;
  calls: string;
  log: string;
}

/** The limits setting from the form, or the first problem with it. */
export function parseLimits(
  d: LimitsDraft,
):
  | { limits: { cpuMs: number; memoryMb: number; maxCalls: number; logChars: number } }
  | { error: string } {
  const n = (s: string) => (/^\d+(\.\d+)?$/.test(s.trim()) ? Number(s) : NaN);
  const seconds = n(d.seconds);
  const memory = n(d.memory);
  const calls = n(d.calls);
  const log = n(d.log);
  const L = EXPERIMENTAL_TEXT.limits;
  if (!(seconds >= 0.1 && seconds <= 30)) return { error: L.seconds({ min: 0.1, max: 30 }) };
  if (!Number.isInteger(memory) || memory < 8 || memory > 128)
    return { error: L.memory({ min: 8, max: 128 }) };
  if (!Number.isInteger(calls) || calls < 1 || calls > 100)
    return { error: L.calls({ min: 1, max: 100 }) };
  if (!Number.isInteger(log) || log < 1000 || log > 100_000)
    return { error: L.log({ min: 1000, max: 100_000 }) };
  return {
    limits: { cpuMs: Math.round(seconds * 1000), memoryMb: memory, maxCalls: calls, logChars: log },
  };
}

function ScriptsSection() {
  const settings = useSettings();
  const toast = useToast();
  const headingId = useId();
  const on = settings.get('scripts.enabled').value;
  const S = EXPERIMENTAL_TEXT.scripts;
  const limits = settings.get('scripts.limits');
  const v = limits.value;
  const initial: LimitsDraft = {
    seconds: String(v.cpuMs / 1000),
    memory: String(v.memoryMb),
    calls: String(v.maxCalls),
    log: String(v.logChars),
  };
  const [draft, setDraft] = useState<LimitsDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const d = draft ?? initial;
  const set = (k: keyof LimitsDraft, s: string) => {
    setDraft({ ...d, [k]: s });
    setError(null);
  };
  const save = async () => {
    const parsed = parseLimits(d);
    if ('error' in parsed) {
      setError(parsed.error);
      return;
    }
    try {
      await settings.set('scripts.limits', parsed.limits);
      setDraft(null);
      toast.show(S.saved, { tone: 'success' });
    } catch (err) {
      setError(flaggedErrorMessage(err, 'scripts', S.saveFailed));
    }
  };
  return (
    <section className="settings-section" aria-labelledby={headingId}>
      <h3 id={headingId}>{S.heading}</h3>
      <GuardedSwitch
        label={S.label}
        description={S.description}
        settingKey="scripts.enabled"
        confirmTitle={S.confirmTitle}
        confirmText={S.confirmText}
      />
      {on ? (
        <>
          <p className="muted cl-small">{S.where}</p>
          <form
            className="stack"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <div className="cl-field-row">
              <TextField
                label={S.seconds}
                type="number"
                inputMode="decimal"
                className="ws-number"
                value={d.seconds}
                disabled={limits.locked}
                onChange={(e) => set('seconds', e.target.value)}
              />
              <TextField
                label={S.memory}
                type="number"
                inputMode="numeric"
                className="ws-number"
                value={d.memory}
                disabled={limits.locked}
                onChange={(e) => set('memory', e.target.value)}
              />
              <TextField
                label={S.calls}
                type="number"
                inputMode="numeric"
                className="ws-number"
                value={d.calls}
                disabled={limits.locked}
                onChange={(e) => set('calls', e.target.value)}
              />
              <TextField
                label={S.log}
                type="number"
                inputMode="numeric"
                className="ws-number"
                value={d.log}
                disabled={limits.locked}
                onChange={(e) => set('log', e.target.value)}
              />
            </div>
            {error ? (
              <p className="nv-field-error" role="alert">
                {error}
              </p>
            ) : null}
            {limits.locked ? (
              <p className="nv-field-hint">{S.managed}</p>
            ) : (
              <div>
                <Button type="submit" disabled={draft === null}>
                  {S.save}
                </Button>
              </div>
            )}
          </form>
          <h4 className="ws-subhead">{S.runs}</h4>
          <AllScriptRuns />
        </>
      ) : null}
    </section>
  );
}

// ---- external coding agents (FR-203) -----------------------------------------------------------

function AgentsSection() {
  const settings = useSettings();
  const headingId = useId();
  const on = settings.get('externalAgents.enabled').value;
  const S = EXPERIMENTAL_TEXT.agents;
  return (
    <section className="settings-section" aria-labelledby={headingId}>
      <h3 id={headingId}>{S.heading}</h3>
      <GuardedSwitch
        label={S.label}
        description={S.description}
        settingKey="externalAgents.enabled"
        confirmTitle={S.confirmTitle}
        confirmText={S.confirmText}
      />
      {on ? <Adapters /> : <p className="muted cl-small">{S.off}</p>}
    </section>
  );
}

function Adapters() {
  const api = useFlaggedApi();
  const toast = useToast();
  const announce = useAnnounce();
  const list = useLoad(() => api.listAgentAdapters().then((r) => r.items), 'adapters');
  const [editing, setEditing] = useState<{ adapter: AgentAdapterView | null } | null>(null);
  const [checking, setChecking] = useState<AgentAdapterView | null>(null);
  const [removing, setRemoving] = useState<AgentAdapterView | null>(null);
  const items = list.data;
  const S = EXPERIMENTAL_TEXT.adapters;
  const replace = (a: AgentAdapterView) =>
    list.setData((prev) =>
      prev?.some((x) => x.id === a.id)
        ? prev.map((x) => (x.id === a.id ? a : x))
        : [...(prev ?? []), a],
    );

  const toggle = async (a: AgentAdapterView) => {
    try {
      const next = await api.updateAgentAdapter(a.id, { enabled: !a.enabled });
      replace(next);
      announce(S.toggled({ name: next.name, state: next.enabled ? 'on' : 'off' }));
    } catch (err) {
      toast.show(S.changeFailed({ name: a.name, reason: flaggedErrorMessage(err, 'agents') }), {
        tone: 'error',
      });
    }
  };

  return (
    <div className="stack">
      <div className="ws-section-header">
        <h4 className="ws-subhead">{S.heading}</h4>
        <Button onClick={() => setEditing({ adapter: null })}>
          <Icon name="plus" /> {S.add}
        </Button>
      </div>
      {list.error && !items ? (
        <div className="ws-error" role="alert">
          <p>{flaggedErrorMessage(list.error, 'agents', S.loadFailed)}</p>
          <Button onClick={list.reload}>{FLAGGED_TEXT.retry}</Button>
        </div>
      ) : null}
      {list.loading ? <Spinner label={S.loading} /> : null}
      {items?.length === 0 ? (
        <EmptyState level={3} title={S.empty} description={S.emptyHint} icon="agents" />
      ) : null}
      {items?.length ? (
        <ul className="ws-list" aria-label={S.list}>
          {items.map((a) => (
            <li key={a.id} className="ws-list-row" aria-label={a.name}>
              <span className="cl-row-main">
                <span className="cl-row-title">
                  <span className="cl-strong" dir="auto">
                    {a.name}
                  </span>
                  <Badge tone={a.enabled ? 'ok' : 'muted'} icon={a.enabled ? 'check' : 'slash'}>
                    {a.enabled ? S.on : S.off}
                  </Badge>
                  {a.lastCheck ? (
                    <Badge
                      tone={a.lastCheck.ok ? 'ok' : 'danger'}
                      icon={a.lastCheck.ok ? 'check' : 'alert'}
                    >
                      {a.lastCheck.ok ? S.checkPassed : S.checkFailed}
                    </Badge>
                  ) : null}
                </span>
                <code className="ws-code-inline cl-break cl-small" dir="ltr">
                  {[a.command, ...a.args].join(' ')}
                </code>
                <span className="muted ws-row-meta">
                  <span>
                    {Object.keys(a.env).length
                      ? S.secrets({ names: names(Object.keys(a.env)) })
                      : S.noSecrets}
                  </span>
                  <span>
                    {a.network.length ? S.reaches({ hosts: names(a.network) }) : S.noNetwork}
                  </span>
                  {a.lastCheck ? (
                    <span>{S.checked({ when: formatWhen(a.lastCheck.at) })}</span>
                  ) : null}
                </span>
                {a.lastCheck?.ok && a.lastCheck.agent?.name ? (
                  <span className="muted cl-small">
                    {S.answersAs({ agent: agentLabel(a.lastCheck.agent) })}
                  </span>
                ) : null}
                {a.lastCheck && !a.lastCheck.ok && a.lastCheck.reason ? (
                  <span className="fl-why">{failureText(a.lastCheck.reason)}</span>
                ) : null}
              </span>
              <span className="ws-row-actions cl-actions">
                <Button onClick={() => setChecking(a)}>
                  <Icon name="refresh" /> {S.check}
                </Button>
                <Button onClick={() => void toggle(a)}>
                  {a.enabled ? EXPERIMENTAL_TEXT.turnOff : EXPERIMENTAL_TEXT.turnOn}
                </Button>
                <Button onClick={() => setEditing({ adapter: a })}>
                  <Icon name="edit" /> {S.edit}
                </Button>
                <Button variant="danger" onClick={() => setRemoving(a)}>
                  <Icon name="trash" /> {S.remove}
                </Button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <AdapterDialog
        open={editing !== null}
        editing={editing?.adapter ?? null}
        onClose={() => setEditing(null)}
        onSaved={(a, created) => {
          setEditing(null);
          replace(a);
          toast.show(created ? S.added({ name: a.name }) : S.saved({ name: a.name }), {
            tone: 'success',
          });
        }}
      />
      <CheckDialog
        adapter={checking}
        onClose={() => setChecking(null)}
        onChecked={(a) => replace(a)}
      />
      <ConfirmAction
        open={removing !== null}
        title={S.removeTitle({ name: removing?.name ?? '' })}
        description={S.removeBody}
        confirmLabel={S.removeConfirm}
        danger
        errorText={(err) => flaggedErrorMessage(err, 'agents', S.removeFailed)}
        onClose={() => setRemoving(null)}
        onConfirm={async () => {
          if (!removing) return;
          const gone = removing;
          await api.deleteAgentAdapter(gone.id);
          setRemoving(null);
          list.setData((prev) => prev?.filter((x) => x.id !== gone.id) ?? null);
          announce(S.removed({ name: gone.name }));
        }}
      />
    </div>
  );
}

/** Check an adapter: start its agent in a Code session's sandbox and run the handshake only. */
function CheckDialog({
  adapter,
  onClose,
  onChecked,
}: {
  adapter: AgentAdapterView | null;
  onClose: () => void;
  onChecked: (a: AgentAdapterView) => void;
}) {
  if (!adapter) return null;
  return <CheckForm adapter={adapter} onClose={onClose} onChecked={onChecked} />;
}

function CheckForm({
  adapter,
  onClose,
  onChecked,
}: {
  adapter: AgentAdapterView;
  onClose: () => void;
  onChecked: (a: AgentAdapterView) => void;
}) {
  const api = useFlaggedApi();
  const { api: hub } = useServices();
  const [sessions, setSessions] = useState<CodeSessionView[] | null>(null);
  const [sessionId, setSessionId] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [ok, setOk] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    hub.listCodeSessions().then(
      ({ items }) => alive && setSessions(items),
      () => alive && setSessions([]),
    );
    return () => {
      alive = false;
    };
  }, [hub]);
  const chosen = sessionId || sessions?.[0]?.id || '';
  const S = EXPERIMENTAL_TEXT.check;
  const check = async () => {
    if (!chosen) return;
    setBusy(true);
    setResult(null);
    try {
      const c = await api.checkAgentAdapter(adapter.id, chosen);
      setOk(c.ok);
      const version = c.protocolVersion ?? S.unknownVersion;
      setResult(
        c.ok
          ? c.agent?.name
            ? S.answeredAs({ agent: agentLabel(c.agent), version })
            : S.answered({ version })
          : (failureText(c.reason) ?? S.noAnswer),
      );
      onChecked({ ...adapter, lastCheck: c });
    } catch (err) {
      setOk(false);
      setResult(flaggedErrorMessage(err, 'agents', S.failed));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      title={S.title({ name: adapter.name })}
      description={S.description}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{FLAGGED_TEXT.close}</Button>
          <Button variant="primary" disabled={busy || !chosen} onClick={() => void check()}>
            {busy ? <Spinner /> : null} {S.check}
          </Button>
        </>
      }
    >
      {sessions === null ? (
        <p className="muted">
          <Spinner label={S.loading} /> {S.loadingText}
        </p>
      ) : sessions.length ? (
        <SelectField
          label={S.session}
          value={chosen}
          onChange={setSessionId}
          options={sessions.map((s) => ({ value: s.id, label: sessionTitle(s) }))}
        />
      ) : (
        <p>{S.noSession}</p>
      )}
      {result ? (
        <p className="cl-notice" data-tone={ok ? 'ok' : 'danger'} role="status">
          <Icon name={ok ? 'check' : 'alert'} />
          <span>{result}</span>
        </p>
      ) : null}
    </Dialog>
  );
}
