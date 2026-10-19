// Settings → Experimental (docs/17 §M7: flagged features, off by default) at
// /settings/experimental: scripted tool calls (FR-202) with their limits, and external coding
// agents (FR-203) with their adapters (add, check in a Code session's sandbox, turn off, edit,
// remove). Both are security settings: global only, managed policy can lock them, and turning one
// on asks first. Where each shows up once it is on: script runs in a Code session's Scripts tab and
// all of the account's here, a page at a time; delegations in a Code session's Agents tab.
import { useEffect, useId, useState } from 'react';
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
import { failureText, flaggedErrorMessage } from './format.ts';
import { AllScriptRuns } from './ScriptRuns.tsx';
import '../workspace.css';
import './flagged.css';

export function ExperimentalSettings() {
  return (
    <div className="settings-page">
      <h2>Experimental</h2>
      <p className="muted">
        Features that are still being tried out. They are off until you turn them on, and your
        organization can keep them off.
      </p>
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
              toast.show(`Could not save: ${flaggedErrorMessage(err, 'agents')}`, {
                tone: 'error',
              }),
            );
        }}
      />
      <ConfirmAction
        open={asking}
        title={confirmTitle}
        description={confirmText}
        confirmLabel="Turn on"
        errorText={(err) => flaggedErrorMessage(err, 'agents', 'Could not save.')}
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
  if (!(seconds >= 0.1 && seconds <= 30))
    return { error: 'Set the time limit from 0.1 to 30 seconds.' };
  if (!Number.isInteger(memory) || memory < 8 || memory > 128)
    return { error: 'Set the memory limit from 8 to 128 MB.' };
  if (!Number.isInteger(calls) || calls < 1 || calls > 100)
    return { error: 'Allow from 1 to 100 tool calls per script.' };
  if (!Number.isInteger(log) || log < 1000 || log > 100_000)
    return { error: 'Keep from 1,000 to 100,000 characters of console output.' };
  return {
    limits: { cpuMs: Math.round(seconds * 1000), memoryMb: memory, maxCalls: calls, logChars: log },
  };
}

function ScriptsSection() {
  const settings = useSettings();
  const toast = useToast();
  const headingId = useId();
  const on = settings.get('scripts.enabled').value;
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
      toast.show('Limits saved.', { tone: 'success' });
    } catch (err) {
      setError(flaggedErrorMessage(err, 'scripts', 'Could not save the limits.'));
    }
  };
  return (
    <section className="settings-section" aria-labelledby={headingId}>
      <h3 id={headingId}>Scripted tool calls</h3>
      <GuardedSwitch
        label="Let the model call tools from a short script"
        description="Offers script.run: JavaScript in an isolated engine without network or files, whose tool calls each pass your policy and are audited like direct calls."
        settingKey="scripts.enabled"
        confirmTitle="Turn on scripted tool calls?"
        confirmText="The model can then write short scripts that call several tools in a row. Each call still asks or is denied as your rules say; nothing a script calls skips the policy."
      />
      {on ? (
        <>
          <p className="muted cl-small">
            Script runs and each call they made show in a Code session’s Scripts tab, and all of
            them below.
          </p>
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
                label="Time limit (seconds)"
                type="number"
                inputMode="decimal"
                className="ws-number"
                value={d.seconds}
                disabled={limits.locked}
                onChange={(e) => set('seconds', e.target.value)}
              />
              <TextField
                label="Memory (MB)"
                type="number"
                inputMode="numeric"
                className="ws-number"
                value={d.memory}
                disabled={limits.locked}
                onChange={(e) => set('memory', e.target.value)}
              />
              <TextField
                label="Tool calls per script"
                type="number"
                inputMode="numeric"
                className="ws-number"
                value={d.calls}
                disabled={limits.locked}
                onChange={(e) => set('calls', e.target.value)}
              />
              <TextField
                label="Console output kept (characters)"
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
              <p className="nv-field-hint">Your organization manages these limits.</p>
            ) : (
              <div>
                <Button type="submit" disabled={draft === null}>
                  Save limits
                </Button>
              </div>
            )}
          </form>
          <h4 className="ws-subhead">Script runs</h4>
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
  return (
    <section className="settings-section" aria-labelledby={headingId}>
      <h3 id={headingId}>External coding agents</h3>
      <GuardedSwitch
        label="Let Code sessions delegate to external agents"
        description="Agents that speak the Agent Client Protocol work in a session’s sandbox. Nova decides every permission request they make, and their changes show in the Diff."
        settingKey="externalAgents.enabled"
        confirmTitle="Turn on external coding agents?"
        confirmText="Programs you add as adapters can then run in Code sessions’ sandboxes. Every file change and command they ask for goes through your policy."
      />
      {on ? <Adapters /> : <p className="muted cl-small">Turn this on to add adapters.</p>}
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
      announce(`${next.name} is ${next.enabled ? 'on' : 'off'}.`);
    } catch (err) {
      toast.show(`Could not change ${a.name}: ${flaggedErrorMessage(err, 'agents')}`, {
        tone: 'error',
      });
    }
  };

  return (
    <div className="stack">
      <div className="ws-section-header">
        <h4 className="ws-subhead">Adapters</h4>
        <Button onClick={() => setEditing({ adapter: null })}>
          <Icon name="plus" /> Add adapter
        </Button>
      </div>
      {list.error && !items ? (
        <div className="ws-error" role="alert">
          <p>{flaggedErrorMessage(list.error, 'agents', 'Could not load the adapters.')}</p>
          <Button onClick={list.reload}>Retry</Button>
        </div>
      ) : null}
      {list.loading ? <Spinner label="Loading the adapters" /> : null}
      {items?.length === 0 ? (
        <EmptyState
          level={3}
          title="No adapters yet"
          description="Add the program of an external coding agent. Then delegate to it from a Code session’s Agents tab."
          icon="agents"
        />
      ) : null}
      {items?.length ? (
        <ul className="ws-list" aria-label="Agent adapters">
          {items.map((a) => (
            <li key={a.id} className="ws-list-row" aria-label={a.name}>
              <span className="cl-row-main">
                <span className="cl-row-title">
                  <span className="cl-strong">{a.name}</span>
                  <Badge tone={a.enabled ? 'ok' : 'muted'} icon={a.enabled ? 'check' : 'slash'}>
                    {a.enabled ? 'On' : 'Off'}
                  </Badge>
                  {a.lastCheck ? (
                    <Badge
                      tone={a.lastCheck.ok ? 'ok' : 'danger'}
                      icon={a.lastCheck.ok ? 'check' : 'alert'}
                    >
                      {a.lastCheck.ok ? 'Check passed' : 'Check failed'}
                    </Badge>
                  ) : null}
                </span>
                <code className="ws-code-inline cl-break cl-small">
                  {[a.command, ...a.args].join(' ')}
                </code>
                <span className="muted ws-row-meta">
                  <span>
                    {Object.keys(a.env).length
                      ? `Secrets: ${Object.keys(a.env).join(', ')}`
                      : 'No secrets'}
                  </span>
                  <span>{a.network.length ? `Reaches ${a.network.join(', ')}` : 'No network'}</span>
                  {a.lastCheck ? <span>Checked {formatWhen(a.lastCheck.at)}</span> : null}
                </span>
                {a.lastCheck?.ok && a.lastCheck.agent?.name ? (
                  <span className="muted cl-small">
                    Answers as {a.lastCheck.agent.name}
                    {a.lastCheck.agent.version ? ` ${a.lastCheck.agent.version}` : ''}
                  </span>
                ) : null}
                {a.lastCheck && !a.lastCheck.ok && a.lastCheck.reason ? (
                  <span className="fl-why">{failureText(a.lastCheck.reason)}</span>
                ) : null}
              </span>
              <span className="ws-row-actions cl-actions">
                <Button onClick={() => setChecking(a)}>
                  <Icon name="refresh" /> Check…
                </Button>
                <Button onClick={() => void toggle(a)}>{a.enabled ? 'Turn off' : 'Turn on'}</Button>
                <Button onClick={() => setEditing({ adapter: a })}>
                  <Icon name="edit" /> Edit…
                </Button>
                <Button variant="danger" onClick={() => setRemoving(a)}>
                  <Icon name="trash" /> Remove…
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
          toast.show(created ? `Added ${a.name}.` : `Saved ${a.name}.`, { tone: 'success' });
        }}
      />
      <CheckDialog
        adapter={checking}
        onClose={() => setChecking(null)}
        onChecked={(a) => replace(a)}
      />
      <ConfirmAction
        open={removing !== null}
        title={`Remove ${removing?.name ?? 'this adapter'}?`}
        description="Its secrets leave the vault, and an agent it runs now is stopped. Past delegations keep their history."
        confirmLabel="Remove"
        danger
        errorText={(err) => flaggedErrorMessage(err, 'agents', 'Could not remove the adapter.')}
        onClose={() => setRemoving(null)}
        onConfirm={async () => {
          if (!removing) return;
          const gone = removing;
          await api.deleteAgentAdapter(gone.id);
          setRemoving(null);
          list.setData((prev) => prev?.filter((x) => x.id !== gone.id) ?? null);
          announce(`Removed ${gone.name}.`);
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
  const check = async () => {
    if (!chosen) return;
    setBusy(true);
    setResult(null);
    try {
      const c = await api.checkAgentAdapter(adapter.id, chosen);
      setOk(c.ok);
      setResult(
        c.ok
          ? `The agent answered${c.agent?.name ? ` as ${c.agent.name}${c.agent.version ? ` ${c.agent.version}` : ''}` : ''}, protocol version ${c.protocolVersion ?? 'unknown'}.`
          : (failureText(c.reason) ?? 'The agent did not answer.'),
      );
      onChecked({ ...adapter, lastCheck: c });
    } catch (err) {
      setOk(false);
      setResult(flaggedErrorMessage(err, 'agents', 'Could not check the adapter.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      title={`Check ${adapter.name}`}
      description="The agent starts in a Code session’s sandbox and only says hello. It does no work."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button variant="primary" disabled={busy || !chosen} onClick={() => void check()}>
            {busy ? <Spinner /> : null} Check
          </Button>
        </>
      }
    >
      {sessions === null ? (
        <p className="muted">
          <Spinner label="Loading the sessions" /> Loading sessions…
        </p>
      ) : sessions.length ? (
        <SelectField
          label="In the sandbox of"
          value={chosen}
          onChange={setSessionId}
          options={sessions.map((s) => ({ value: s.id, label: sessionTitle(s) }))}
        />
      ) : (
        <p>Start a Code session first: the check runs in a session’s sandbox.</p>
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
