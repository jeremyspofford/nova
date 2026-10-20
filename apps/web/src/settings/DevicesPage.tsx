// Settings → Devices (FR-126, FR-132, FR-140, docs/04 §9, docs/14 §7): the way into Devices
// (every device of the Hub) and Add a device, whether devices may be added with a code and how
// long an added browser stays signed in (FR-132), the rules that apply to every device (wakes per
// hour, minimum novad versions, FR-144, FR-148), then compute nodes that run models for this Hub
// (M2). "Add with a code" opens Add a device for a compute node; "Add compute node" creates a
// one-use enrollment token for scripted installs (creating it is the approval, ADR-089) and shows
// the command to run on the node; Revoke stops a node's credential at once. The node list
// refreshes every 5 s while the page is open. Each node links to its device page for its policy
// (quiet hours, routing), GPU memory and services (M7.5).
import { useEffect, useId, useRef, useState } from 'react';
import { defineMessages, fmt } from '@nova/i18n';
import { DEVICE_CAPABILITIES, type NodeEnrollToken, type NodeView } from '@nova/shared';
import { Button, Dialog, Icon, Spinner, TextField, useToast, type IconName } from '@nova/ui';
import { errorMessage } from '../api.ts';
import {
  CAPABILITY_LABEL,
  DEVICES_ADD_PATH,
  DEVICES_PATH,
  addDevicePath,
  devicePath,
} from '../devices/format.ts';
import { navigate } from '../router.ts';
import { followLink } from '../work/nav.tsx';
import { useServices } from '../services.tsx';
import { useSettings } from '../settings.tsx';
import { useModels } from '../stores.tsx';
import { formatWhen, useInterval } from './common.ts';
import { ManagedNote } from '../managed/ManagedNote.tsx';
import { SwitchField } from './controls.tsx';
import { embed } from './embed.tsx';
import '../workspace.css';
import '../devices/devices.css';

export const DEVICES_TEXT = defineMessages('settings.devices', {
  status: {
    active: 'Active',
    pending: 'Waiting for first contact',
    unreachable: 'Unreachable',
    revoked: 'Revoked',
  },
  vram: '{size} VRAM',
  loadFailed: 'Could not load compute nodes.',
  revoked: '{name} revoked. Its models are no longer offered.',
  revokeFailed: 'Could not revoke {name}: {error}',
  title: 'Devices',
  yourDevices: 'Your devices',
  yourDevicesHint:
    'Browsers, phones, computers running novad and compute nodes: their roles and scopes, what ' +
    'each one can do, its power and updates, the folders it shares and the agents that use it.',
  openDevices: 'Open Devices',
  addDevice: 'Add a device',
  nodes: 'Compute nodes',
  nodesHint:
    'Computers that run models for this Hub. A node only runs work this Hub sends it, and it ' +
    'never connects to your other devices.',
  nodesAddHint:
    'Add one with a code, like any device, or with a one-use token for scripted installs.',
  addWithCode: 'Add with a code',
  addNode: 'Add compute node',
  retry: 'Retry',
  loading: 'Loading compute nodes',
  none: 'No compute nodes yet.',
  gpus: '{n, plural, =0 {No GPU} one {# GPU} other {# GPUs}}',
  jobs: '{n, plural, one {up to # job at once} other {up to # jobs at once}}',
  models: '{n, plural, one {# model: {names}} other {# models: {names}}}',
  noModels: 'No models reported',
  load: '{running} running, {queued} queued',
  noLoad: 'Load not reported',
  lastSeen: 'last seen {when}',
  policyOf: 'Policy and services of {name}',
  policy: 'Policy and services',
  revoke: 'Revoke',
  revokeTitle: 'Revoke {name}?',
  revokeThis: 'Revoke this node?',
  revokeBody:
    'Its credential stops working at once and its models leave the model list. To use it ' +
    'again, enroll it with a new token.',
  cancel: 'Cancel',
  tokenFailed: 'Could not create a token.',
  copied: 'Command copied.',
  copyFailed: 'Could not copy. The command is selected; copy it with your keyboard.',
  addTitle: 'Add a compute node',
  addBody: 'Run this command on the computer you want to add. The token works once.',
  done: 'Done',
  tryAgain: 'Try again',
  creating: 'Creating a token',
  copy: 'Copy command',
  newToken: 'Create a new token',
  expired: 'This token has expired. Create a new one to add the node.',
  expiresIn:
    'Expires in {time}. Change --backend if the node’s model server is not Ollama on its default address.',
  appears: 'The node appears in the list once it registers. Close this when you are done.',
  saveFailed: 'Could not save: {error}',
  adding: 'Adding devices',
  addEnabled: 'Add devices with a code',
  addEnabledHint:
    'Off, new codes and requests to join are refused. Devices already added keep working.',
  sessionDays: 'Days an added browser or app stays signed in',
  sessionDaysHint: 'After this it must be added again. {min} to {max}.',
  wholeRange: 'Enter a whole number from {min} to {max}.',
  rules: 'Rules for every device',
  wakes: 'Wakes per hour, per device',
  wakesHint: 'How many Wake-on-LAN signals a device may get in an hour. {min} to {max}.',
  minVersions: 'Minimum novad versions',
  minVersionsHint:
    'Raise the novad version a device needs for a capability. A device below it loses only ' +
    'that capability and shows Update required. Leave blank to use the built-in minimum.',
  builtIn: 'Built-in',
  versionInvalid: 'Enter a version like 0.7.0.',
});
const S = DEVICES_TEXT;

export const NODE_POLL_MS = 5000;
/** The backend a fresh node talks to; Ollama's default address on that machine. */
export const DEFAULT_NODE_BACKEND = 'http://127.0.0.1:11434';

/** The exact command to run on the node being added. */
export function enrollCommand(hubOrigin: string, token: string): string {
  return `nova-compute enroll --hub ${hubOrigin} --token ${token} --backend ${DEFAULT_NODE_BACKEND}`;
}

const NODE_STATUS: Record<NodeView['status'], { icon: IconName | null; tone: string }> = {
  active: { icon: 'check', tone: 'ready' },
  pending: { icon: null, tone: 'running' },
  unreachable: { icon: 'alert', tone: 'needs_input' },
  revoked: { icon: 'stop', tone: 'blocked' },
};

function NodeStatusChip({ status }: { status: NodeView['status'] }) {
  const s = NODE_STATUS[status];
  return (
    <span className="nv-chip" data-status={s.tone}>
      {s.icon ? <Icon name={s.icon} /> : <Spinner />}
      <span>{S.status[status]}</span>
    </span>
  );
}

function formatVram(bytes: number | null): string | null {
  if (!bytes) return null;
  return S.vram({ size: fmt.bytes(bytes) });
}

export function DevicesPage() {
  const { api } = useServices();
  const models = useModels();
  const toast = useToast();
  const [nodes, setNodes] = useState<NodeView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [adding, setAdding] = useState(false);
  const [revoking, setRevoking] = useState<NodeView | null>(null);

  useEffect(() => {
    let alive = true;
    api.listNodes().then(
      ({ items }) => {
        if (!alive) return;
        setNodes(items);
        setError(null);
      },
      (err: unknown) => alive && setError(errorMessage(err, S.loadFailed)),
    );
    return () => {
      alive = false;
    };
  }, [api, version]);
  useInterval(() => setVersion((v) => v + 1), NODE_POLL_MS);

  const revoke = async (n: NodeView) => {
    setRevoking(null);
    try {
      await api.revokeNode(n.id);
      setNodes(
        (list) => list?.map((x) => (x.id === n.id ? { ...x, status: 'revoked' } : x)) ?? null,
      );
      toast.show(S.revoked({ name: n.name }), { tone: 'success' });
      void models.refresh();
    } catch (err) {
      toast.show(S.revokeFailed({ name: n.name, error: errorMessage(err) }), { tone: 'error' });
    }
  };

  return (
    <div className="settings-page">
      <h2>{S.title}</h2>
      <section className="settings-section" aria-labelledby="devices-novad">
        <h3 id="devices-novad">{S.yourDevices}</h3>
        <p className="muted">{S.yourDevicesHint}</p>
        <div className="row">
          <Button variant="primary" onClick={() => navigate(DEVICES_PATH)}>
            {S.openDevices}
          </Button>
          <Button onClick={() => navigate(DEVICES_ADD_PATH)}>
            <Icon name="plus" /> {S.addDevice}
          </Button>
        </div>
      </section>
      <AddDeviceRules />
      <DeviceRules />
      <section className="settings-section" aria-labelledby="devices-nodes">
        <h3 id="devices-nodes">{S.nodes}</h3>
        <p className="muted">{S.nodesHint}</p>
        <p className="muted">{S.nodesAddHint}</p>
        <div className="row">
          <Button variant="primary" onClick={() => navigate(addDevicePath('compute'))}>
            <Icon name="plus" /> {S.addWithCode}
          </Button>
          <Button onClick={() => setAdding(true)}>{S.addNode}</Button>
        </div>
        {error ? (
          <div role="alert" className="ws-error">
            <p>{error}</p>
            <Button onClick={() => setVersion((v) => v + 1)}>{S.retry}</Button>
          </div>
        ) : null}
        {nodes === null && !error ? <Spinner label={S.loading} /> : null}
        {nodes?.length === 0 ? <p className="muted">{S.none}</p> : null}
        {nodes?.length ? (
          <ul className="ws-list" aria-label={S.nodes}>
            {nodes.map((n) => {
              const caps = [
                S.gpus({ n: n.capabilities.gpus }),
                formatVram(n.capabilities.vramBytes),
                S.jobs({ n: n.capabilities.maxConcurrentJobs }),
              ].filter(Boolean);
              return (
                <li key={n.id} className="ws-list-row ws-node" aria-label={n.name}>
                  <div className="ws-source-main">
                    <strong>{n.name}</strong>
                    <NodeStatusChip status={n.status} />
                    <code className="ws-code-inline">{n.endpoint}</code>
                    <span className="muted ws-row-meta">{caps.join(' · ')}</span>
                    <span className="muted ws-row-meta">
                      {n.models.length
                        ? S.models({
                            n: n.models.length,
                            names: fmt.list(n.models, { type: 'unit' }),
                          })
                        : S.noModels}
                    </span>
                    <span className="muted ws-row-meta">
                      {n.load
                        ? S.load({ running: n.load.running, queued: n.load.queued })
                        : S.noLoad}
                      {' · '}
                      {S.lastSeen({ when: formatWhen(n.lastSeenAt) })}
                    </span>
                  </div>
                  {n.status !== 'revoked' ? (
                    <div className="row ws-row-actions">
                      <a
                        href={devicePath(n.id)}
                        aria-label={S.policyOf({ name: n.name })}
                        onClick={(e) => followLink(e, devicePath(n.id))}
                      >
                        {S.policy}
                      </a>
                      <Button variant="ghost" onClick={() => setRevoking(n)}>
                        {S.revoke}
                      </Button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}
      </section>
      <AddNodeDialog
        open={adding}
        onClose={() => {
          setAdding(false);
          setVersion((v) => v + 1);
        }}
      />
      <Dialog
        open={revoking !== null}
        title={revoking ? S.revokeTitle({ name: revoking.name }) : S.revokeThis}
        description={S.revokeBody}
        onClose={() => setRevoking(null)}
        footer={
          <>
            <Button onClick={() => setRevoking(null)}>{S.cancel}</Button>
            <Button variant="danger" onClick={() => revoking && void revoke(revoking)}>
              {S.revoke}
            </Button>
          </>
        }
      />
    </div>
  );
}

function AddNodeDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return open ? <AddNode onClose={onClose} /> : null;
}

/** "14:59", or "0:00" once expired. */
export function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function AddNode({ onClose }: { onClose: () => void }) {
  const { api } = useServices();
  const toast = useToast();
  const [token, setToken] = useState<NodeEnrollToken | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [attempt, setAttempt] = useState(0);
  const commandRef = useRef<HTMLElement>(null);

  useEffect(() => {
    let alive = true;
    api.createNodeEnrollToken().then(
      (t) => {
        if (!alive) return;
        setToken(t);
        setError(null);
        setNow(Date.now());
      },
      (err: unknown) => alive && setError(errorMessage(err, S.tokenFailed)),
    );
    return () => {
      alive = false;
    };
  }, [api, attempt]);

  const left = token ? Date.parse(token.expiresAt) - now : 0;
  const expired = token !== null && left <= 0;
  useInterval(() => setNow(Date.now()), 1000, token !== null && !expired);
  const command = token ? enrollCommand(window.location.origin, token.token) : '';

  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error('no clipboard');
      await navigator.clipboard.writeText(command);
      toast.show(S.copied, { tone: 'success' });
    } catch {
      // Select the text so the user can copy it by hand.
      const el = commandRef.current;
      const sel = window.getSelection();
      if (el && sel) {
        const range = document.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      toast.show(S.copyFailed, { tone: 'error' });
    }
  };

  return (
    <Dialog
      open
      title={S.addTitle}
      description={S.addBody}
      onClose={onClose}
      footer={
        <Button variant="primary" onClick={onClose}>
          {S.done}
        </Button>
      }
    >
      {error ? (
        <div role="alert" className="ws-error">
          <p>{error}</p>
          <Button onClick={() => setAttempt((a) => a + 1)}>{S.tryAgain}</Button>
        </div>
      ) : null}
      {!token && !error ? <Spinner label={S.creating} /> : null}
      {token ? (
        <div className="stack">
          <pre className="ws-command">
            <code ref={commandRef}>{command}</code>
          </pre>
          <div className="row">
            <Button onClick={() => void copy()} disabled={expired}>
              {S.copy}
            </Button>
            {expired ? (
              <Button variant="primary" onClick={() => setAttempt((a) => a + 1)}>
                {S.newToken}
              </Button>
            ) : null}
          </div>
          {expired ? (
            <p role="alert" className="nv-field-error">
              {S.expired}
            </p>
          ) : (
            <p className="muted">
              {embed(S.expiresIn, { time: <span role="timer">{formatCountdown(left)}</span> })}
            </p>
          )}
          <p className="muted">{S.appears}</p>
        </div>
      ) : null}
    </Dialog>
  );
}

const DAYS_MIN = 1;
const DAYS_MAX = 365;

/** Adding with a code (FR-132): on or off, and how long an added browser or app stays signed in. */
function AddDeviceRules() {
  const settings = useSettings();
  const toast = useToast();
  const enabled = settings.get('devices.add.enabled');
  const days = settings.get('devices.add.sessionDays');
  const fail = (err: unknown) =>
    toast.show(S.saveFailed({ error: errorMessage(err) }), { tone: 'error' });
  const [draft, setDraft] = useState<{ base: number; text: string } | null>(null);
  const text = draft && draft.base === days.value ? draft.text : String(days.value);
  const n = Number(text);
  const invalid = !/^\d+$/.test(text.trim()) || n < DAYS_MIN || n > DAYS_MAX;
  const commit = () => {
    if (invalid || n === days.value) return;
    setDraft(null);
    void settings.set('devices.add.sessionDays', n).catch(fail);
  };
  return (
    <section className="settings-section" aria-labelledby="devices-adding">
      <h3 id="devices-adding">{S.adding}</h3>
      <SwitchField
        label={S.addEnabled}
        description={S.addEnabledHint}
        checked={enabled.value}
        locked={enabled.locked}
        onChange={(v) => void settings.set('devices.add.enabled', v).catch(fail)}
      />
      <TextField
        label={S.sessionDays}
        hint={S.sessionDaysHint({ min: DAYS_MIN, max: DAYS_MAX })}
        locked={days.locked}
        setting="devices.add.sessionDays"
        type="number"
        className="ws-number"
        inputMode="numeric"
        min={DAYS_MIN}
        max={DAYS_MAX}
        step={1}
        value={text}
        error={invalid ? S.wholeRange({ min: DAYS_MIN, max: DAYS_MAX }) : undefined}
        onChange={(e) => setDraft({ base: days.value, text: e.target.value })}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
        }}
      />
    </section>
  );
}

const WAKES_MIN = 1;
const WAKES_MAX = 60;
const VERSION_RE = /^\d+(\.\d+){0,3}$/;

/** Rules for every novad device: wakes per hour (FR-144) and minimum versions (FR-148). */
function DeviceRules() {
  const settings = useSettings();
  const toast = useToast();
  const wakes = settings.get('devices.wakesPerHour');
  const mins = settings.get('devices.minNovadVersions');
  const fail = (err: unknown) =>
    toast.show(S.saveFailed({ error: errorMessage(err) }), { tone: 'error' });
  const [draft, setDraft] = useState<{ base: number; text: string } | null>(null);
  // A draft belongs to the value it was typed against; a new value from the Hub discards it.
  const text = draft && draft.base === wakes.value ? draft.text : String(wakes.value);
  const n = Number(text);
  const invalid = !/^\d+$/.test(text.trim()) || n < WAKES_MIN || n > WAKES_MAX;
  const commit = () => {
    if (invalid || n === wakes.value) return;
    setDraft(null);
    void settings.set('devices.wakesPerHour', n).catch(fail);
  };
  const setMin = (cap: (typeof DEVICE_CAPABILITIES)[number], v: string) => {
    const next = { ...mins.value };
    if (v) next[cap] = v;
    else delete next[cap];
    void settings.set('devices.minNovadVersions', next).catch(fail);
  };
  return (
    <section className="settings-section" aria-labelledby="devices-rules">
      <h3 id="devices-rules">{S.rules}</h3>
      <TextField
        label={S.wakes}
        hint={S.wakesHint({ min: WAKES_MIN, max: WAKES_MAX })}
        locked={wakes.locked}
        setting="devices.wakesPerHour"
        type="number"
        className="ws-number"
        inputMode="numeric"
        min={WAKES_MIN}
        max={WAKES_MAX}
        step={1}
        value={text}
        error={invalid ? S.wholeRange({ min: WAKES_MIN, max: WAKES_MAX }) : undefined}
        onChange={(e) => setDraft({ base: wakes.value, text: e.target.value })}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
        }}
      />
      <details className="ws-advanced">
        <summary>{S.minVersions}</summary>
        <p className="muted">{S.minVersionsHint}</p>
        {mins.locked ? (
          <ManagedNote as="p" id="devices-min-lock" setting="devices.minNovadVersions" />
        ) : null}
        <div className="devices-min-versions">
          {DEVICE_CAPABILITIES.map((c) => (
            <MinVersionField
              key={`${c}:${mins.value[c] ?? ''}`}
              label={CAPABILITY_LABEL[c]}
              value={mins.value[c] ?? ''}
              locked={mins.locked}
              onSave={(v) => setMin(c, v)}
            />
          ))}
        </div>
      </details>
    </section>
  );
}

/** A version saved on Enter or blur; blank removes the raise. */
function MinVersionField({
  label,
  value,
  locked,
  onSave,
}: {
  label: string;
  value: string;
  locked: boolean;
  onSave: (v: string) => void;
}) {
  const id = useId();
  const [text, setText] = useState(value);
  const t = text.trim();
  const invalid = Boolean(t) && !VERSION_RE.test(t);
  const commit = () => {
    if (invalid || t === value) return;
    onSave(t);
  };
  return (
    <TextField
      id={`mv${id}`}
      label={label}
      value={text}
      placeholder={S.builtIn}
      className="ws-number"
      disabled={locked}
      aria-describedby={locked ? 'devices-min-lock' : undefined}
      error={invalid ? S.versionInvalid : undefined}
      onChange={(e) => setText(e.target.value)}
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
