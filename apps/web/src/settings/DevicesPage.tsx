// Settings → Devices (FR-126, FR-132, FR-140, docs/04 §9, docs/14 §7): the way into Devices
// (every device of the Hub) and Add a device, whether devices may be added with a code and how
// long an added browser stays signed in (FR-132), the rules that apply to every device (wakes per
// hour, minimum novad versions, FR-144, FR-148), then compute nodes that run models for this Hub
// (M2). "Add with a code" opens Add a device for a compute node; "Add compute node" creates a
// one-use enrollment token for scripted installs (creating it is the approval, ADR-089) and shows
// the command to run on the node; Revoke stops a node's credential at once. The node list
// refreshes every 5 s while the page is open.
import { useEffect, useId, useRef, useState } from 'react';
import { DEVICE_CAPABILITIES, type NodeEnrollToken, type NodeView } from '@nova/shared';
import { Button, Dialog, Icon, Spinner, TextField, useToast, type IconName } from '@nova/ui';
import { errorMessage } from '../api.ts';
import {
  CAPABILITY_LABEL,
  DEVICES_ADD_PATH,
  DEVICES_PATH,
  addDevicePath,
} from '../devices/format.ts';
import { navigate } from '../router.ts';
import { useServices } from '../services.tsx';
import { useSettings } from '../settings.tsx';
import { useModels } from '../stores.tsx';
import { MANAGED, formatWhen, plural, useInterval } from './common.ts';
import { SwitchField } from './controls.tsx';
import '../workspace.css';
import '../devices/devices.css';

export const NODE_POLL_MS = 5000;
/** The backend a fresh node talks to; Ollama's default address on that machine. */
export const DEFAULT_NODE_BACKEND = 'http://127.0.0.1:11434';

/** The exact command to run on the node being added. */
export function enrollCommand(hubOrigin: string, token: string): string {
  return `nova-compute enroll --hub ${hubOrigin} --token ${token} --backend ${DEFAULT_NODE_BACKEND}`;
}

const NODE_STATUS: Record<
  NodeView['status'],
  { text: string; icon: IconName | null; tone: string }
> = {
  active: { text: 'Active', icon: 'check', tone: 'ready' },
  pending: { text: 'Waiting for first contact', icon: null, tone: 'running' },
  unreachable: { text: 'Unreachable', icon: 'alert', tone: 'needs_input' },
  revoked: { text: 'Revoked', icon: 'stop', tone: 'blocked' },
};

function NodeStatusChip({ status }: { status: NodeView['status'] }) {
  const s = NODE_STATUS[status];
  return (
    <span className="nv-chip" data-status={s.tone}>
      {s.icon ? <Icon name={s.icon} /> : <Spinner />}
      <span>{s.text}</span>
    </span>
  );
}

function formatVram(bytes: number | null): string | null {
  if (!bytes) return null;
  return `${(bytes / 1024 ** 3).toFixed(bytes >= 10 * 1024 ** 3 ? 0 : 1)} GB VRAM`;
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
      (err: unknown) => alive && setError(errorMessage(err, 'Could not load compute nodes.')),
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
      toast.show(`${n.name} revoked. Its models are no longer offered.`, { tone: 'success' });
      void models.refresh();
    } catch (err) {
      toast.show(`Could not revoke ${n.name}: ${errorMessage(err)}`, { tone: 'error' });
    }
  };

  return (
    <div className="settings-page">
      <h2>Devices</h2>
      <section className="settings-section" aria-labelledby="devices-novad">
        <h3 id="devices-novad">Your devices</h3>
        <p className="muted">
          Browsers, phones, computers running novad and compute nodes: their roles and scopes, what
          each one can do, its power and updates, the folders it shares and the agents that use it.
        </p>
        <div className="row">
          <Button variant="primary" onClick={() => navigate(DEVICES_PATH)}>
            Open Devices
          </Button>
          <Button onClick={() => navigate(DEVICES_ADD_PATH)}>
            <Icon name="plus" /> Add a device
          </Button>
        </div>
      </section>
      <AddDeviceRules />
      <DeviceRules />
      <section className="settings-section" aria-labelledby="devices-nodes">
        <h3 id="devices-nodes">Compute nodes</h3>
        <p className="muted">
          Computers that run models for this Hub. A node only runs work this Hub sends it, and it
          never connects to your other devices.
        </p>
        <p className="muted">
          Add one with a code, like any device, or with a one-use token for scripted installs.
        </p>
        <div className="row">
          <Button variant="primary" onClick={() => navigate(addDevicePath('compute'))}>
            <Icon name="plus" /> Add with a code
          </Button>
          <Button onClick={() => setAdding(true)}>Add compute node</Button>
        </div>
        {error ? (
          <div role="alert" className="ws-error">
            <p>{error}</p>
            <Button onClick={() => setVersion((v) => v + 1)}>Retry</Button>
          </div>
        ) : null}
        {nodes === null && !error ? <Spinner label="Loading compute nodes" /> : null}
        {nodes?.length === 0 ? <p className="muted">No compute nodes yet.</p> : null}
        {nodes?.length ? (
          <ul className="ws-list" aria-label="Compute nodes">
            {nodes.map((n) => {
              const caps = [
                n.capabilities.gpus ? plural(n.capabilities.gpus, 'GPU') : 'No GPU',
                formatVram(n.capabilities.vramBytes),
                `up to ${plural(n.capabilities.maxConcurrentJobs, 'job')} at once`,
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
                        ? `${plural(n.models.length, 'model')}: ${n.models.join(', ')}`
                        : 'No models reported'}
                    </span>
                    <span className="muted ws-row-meta">
                      {n.load
                        ? `${n.load.running} running, ${n.load.queued} queued`
                        : 'Load not reported'}{' '}
                      · last seen {formatWhen(n.lastSeenAt)}
                    </span>
                  </div>
                  {n.status !== 'revoked' ? (
                    <Button variant="ghost" onClick={() => setRevoking(n)}>
                      Revoke
                    </Button>
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
        title={revoking ? `Revoke ${revoking.name}?` : 'Revoke this node?'}
        description="Its credential stops working at once and its models leave the model list. To use it again, enroll it with a new token."
        onClose={() => setRevoking(null)}
        footer={
          <>
            <Button onClick={() => setRevoking(null)}>Cancel</Button>
            <Button variant="danger" onClick={() => revoking && void revoke(revoking)}>
              Revoke
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
      (err: unknown) => alive && setError(errorMessage(err, 'Could not create a token.')),
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
      toast.show('Command copied.', { tone: 'success' });
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
      toast.show('Could not copy. The command is selected; copy it with your keyboard.', {
        tone: 'error',
      });
    }
  };

  return (
    <Dialog
      open
      title="Add a compute node"
      description="Run this command on the computer you want to add. The token works once."
      onClose={onClose}
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      {error ? (
        <div role="alert" className="ws-error">
          <p>{error}</p>
          <Button onClick={() => setAttempt((a) => a + 1)}>Try again</Button>
        </div>
      ) : null}
      {!token && !error ? <Spinner label="Creating a token" /> : null}
      {token ? (
        <div className="stack">
          <pre className="ws-command">
            <code ref={commandRef}>{command}</code>
          </pre>
          <div className="row">
            <Button onClick={() => void copy()} disabled={expired}>
              Copy command
            </Button>
            {expired ? (
              <Button variant="primary" onClick={() => setAttempt((a) => a + 1)}>
                Create a new token
              </Button>
            ) : null}
          </div>
          {expired ? (
            <p role="alert" className="nv-field-error">
              This token has expired. Create a new one to add the node.
            </p>
          ) : (
            <p className="muted">
              Expires in <span role="timer">{formatCountdown(left)}</span>. Change --backend if the
              node&apos;s model server is not Ollama on its default address.
            </p>
          )}
          <p className="muted">
            The node appears in the list once it registers. Close this when you are done.
          </p>
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
    toast.show(`Could not save: ${errorMessage(err)}`, { tone: 'error' });
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
      <h3 id="devices-adding">Adding devices</h3>
      <SwitchField
        label="Add devices with a code"
        description="Off, new codes and requests to join are refused. Devices already added keep working."
        checked={enabled.value}
        locked={enabled.locked}
        onChange={(v) => void settings.set('devices.add.enabled', v).catch(fail)}
      />
      <TextField
        label="Days an added browser or app stays signed in"
        hint={`${days.locked ? `${MANAGED}. ` : ''}After this it must be added again. ${DAYS_MIN} to ${DAYS_MAX}.`}
        type="number"
        className="ws-number"
        inputMode="numeric"
        min={DAYS_MIN}
        max={DAYS_MAX}
        step={1}
        value={text}
        disabled={days.locked}
        error={invalid ? `Enter a whole number from ${DAYS_MIN} to ${DAYS_MAX}.` : undefined}
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
    toast.show(`Could not save: ${errorMessage(err)}`, { tone: 'error' });
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
      <h3 id="devices-rules">Rules for every device</h3>
      <TextField
        label="Wakes per hour, per device"
        hint={`${wakes.locked ? `${MANAGED}. ` : ''}How many Wake-on-LAN signals a device may get in an hour. ${WAKES_MIN} to ${WAKES_MAX}.`}
        type="number"
        className="ws-number"
        inputMode="numeric"
        min={WAKES_MIN}
        max={WAKES_MAX}
        step={1}
        value={text}
        disabled={wakes.locked}
        error={invalid ? `Enter a whole number from ${WAKES_MIN} to ${WAKES_MAX}.` : undefined}
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
        <summary>Minimum novad versions</summary>
        <p className="muted">
          Raise the novad version a device needs for a capability. A device below it loses only that
          capability and shows Update required. Leave blank to use the built-in minimum.
          {mins.locked ? ` ${MANAGED}.` : ''}
        </p>
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
      placeholder="Built-in"
      className="ws-number"
      disabled={locked}
      error={invalid ? 'Enter a version like 0.7.0.' : undefined}
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
