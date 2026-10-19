// A compute node on its device page (FR-126, FR-150; M7.5): whether it is quiet now, its load and
// each GPU's memory as its last heartbeat reported them, the owner's policy for it (whether model
// work may be routed to it, and quiet hours in a time zone, during which it takes no new jobs and
// routing skips it), and its managed services: `jobs` (its job API) and, when the node manages
// one, the model server (`backend`), each with Status, Start, Stop and Restart. A policy change
// reaches the node with its next heartbeat.
import { useId, useMemo, useState } from 'react';
import type {
  NodeDetailView,
  NodeGpuVram,
  NodePolicy,
  NodeServiceAction,
  NodeServiceView,
} from '@nova/shared';
import { Button, Icon, SelectField, Spinner, TextField, useToast } from '@nova/ui';
import { useHubStream } from '../hub-events.ts';
import { formatWhen } from '../settings/common.ts';
import { SwitchField } from '../settings/controls.tsx';
import { useDebounced } from '../work/events.ts';
import { useDeviceOpsApi, type DeviceOpsApi } from './api-m75.ts';
import { errorReason, formatBytes, parseQuietHours } from './format.ts';
import { opsErrorMessage } from './ops.tsx';
import { Chip, LoadError, Unavailable, useLoad } from './parts.tsx';
import { serviceChip } from './Services.tsx';

const NODE_EVENTS = ['node.policy.changed', 'node.service.changed', 'device.status.changed'];

const SERVICE_TEXT: Record<NodeServiceView['name'], { label: string; help: string }> = {
  jobs: {
    label: 'Job API',
    help: 'Takes work from this Hub. Stopped, the node takes no new jobs and routing skips it.',
  },
  backend: {
    label: 'Model server',
    help: 'The model server the node runs its models with.',
  },
};

const ACTION_LABEL: Record<NodeServiceAction, string> = {
  status: 'Status',
  start: 'Start',
  stop: 'Stop',
  restart: 'Restart',
};

/** "GPU 0, NVIDIA RTX 4070: 3.2 GB of 12 GB in use". */
export function vramText(g: NodeGpuVram): string {
  const name = [g.vendor, g.name].filter(Boolean).join(' ');
  const head = `GPU ${g.index}${name ? `, ${name}` : ''}`;
  if (g.totalBytes === null) return `${head}: memory not reported`;
  if (g.usedBytes === null) return `${head}: ${formatBytes(g.totalBytes)}`;
  return `${head}: ${formatBytes(g.usedBytes)} of ${formatBytes(g.totalBytes)} in use`;
}

/** Every IANA time zone the browser knows, or null when it cannot list them. */
function timeZones(): string[] | null {
  const intl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
  try {
    return intl.supportedValuesOf ? intl.supportedValuesOf('timeZone') : null;
  } catch {
    return null;
  }
}

export function NodePanel({ deviceId }: { deviceId: string }) {
  const api = useDeviceOpsApi();
  const node = useLoad<NodeDetailView>(
    () => (api ? api.getNodeDetail(deviceId) : Promise.reject(new Error('unavailable'))),
    `node:${deviceId}`,
  );
  const reload = useDebounced(node.reload, 200);
  useHubStream(NODE_EVENTS, (env) => {
    if (env.payload.nodeId === deviceId || env.payload.deviceId === deviceId) reload();
  });
  if (!api) return null;
  const n = node.data;
  return (
    <div className="stack devices-node">
      {node.error && !n ? (
        <LoadError
          error={node.error}
          fallback="Could not load the compute node."
          onRetry={node.reload}
        />
      ) : null}
      {node.loading ? <Spinner label="Loading the compute node" /> : null}
      {n ? (
        <>
          <NodeState node={n} />
          <NodePolicyForm
            key={`${n.policy.revision}`}
            api={api}
            node={n}
            onSaved={(policy) => node.setData((cur) => (cur ? { ...cur, policy } : cur))}
          />
          <NodeServices api={api} node={n} />
        </>
      ) : null}
    </div>
  );
}

function NodeState({ node: n }: { node: NodeDetailView }) {
  const base = useId();
  return (
    <section className="ws-section devices-flat" aria-labelledby={`${base}-h`}>
      <div className="devices-row-head">
        <h2 id={`${base}-h`}>Compute node</h2>
        {n.status === 'revoked' ? null : n.quietNow ? (
          <Chip tone="needs_input" icon="clock" text="Quiet now: no new jobs" />
        ) : !n.policy.routingEligible ? (
          <Chip tone="neutral" icon="stop" text="Kept out of routing" />
        ) : (
          <Chip tone="ready" icon="check" text="Takes jobs" />
        )}
      </div>
      <dl className="devices-facts">
        <div>
          <dt>Load</dt>
          <dd>{n.load ? `${n.load.running} running, ${n.load.queued} queued` : 'Not reported'}</dd>
        </div>
        <div>
          <dt>Last heartbeat</dt>
          <dd>{formatWhen(n.lastSeenAt)}</dd>
        </div>
        {n.reportedQuiet !== null ? (
          <div>
            <dt>The node says</dt>
            <dd>{n.reportedQuiet ? 'It is in its quiet hours' : 'It takes jobs'}</dd>
          </div>
        ) : null}
        <div>
          <dt>GPU memory</dt>
          <dd>
            {n.vram?.length ? (
              <ul className="devices-vram" aria-label="GPU memory">
                {n.vram.map((g) => (
                  <li key={g.index}>
                    {vramText(g)}
                    {g.totalBytes && g.usedBytes !== null ? (
                      <meter
                        min={0}
                        max={g.totalBytes}
                        value={g.usedBytes}
                        aria-label={`GPU ${g.index} memory in use`}
                      />
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : n.vram ? (
              'No GPU'
            ) : (
              <span className="muted">Not reported yet</span>
            )}
          </dd>
        </div>
      </dl>
    </section>
  );
}

function NodePolicyForm({
  api,
  node,
  onSaved,
}: {
  api: DeviceOpsApi;
  node: NodeDetailView;
  onSaved: (p: NodePolicy) => void;
}) {
  const toast = useToast();
  const base = useId();
  const zones = useMemo(() => timeZones(), []);
  const p = node.policy;
  const [routing, setRouting] = useState(p.routingEligible);
  const [quiet, setQuiet] = useState(p.quietHours.join(', '));
  const [zone, setZone] = useState(p.timeZone ?? '');
  const [quietError, setQuietError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const revoked = node.status === 'revoked';
  const dirty =
    routing !== p.routingEligible ||
    quiet.trim() !== p.quietHours.join(', ') ||
    (zone || null) !== p.timeZone;

  const save = async () => {
    const q = parseQuietHours(quiet);
    if ('bad' in q) {
      setQuietError(`“${q.bad}” is not a time range like 22:00-07:00.`);
      return;
    }
    setQuietError(null);
    setBusy(true);
    setError(null);
    try {
      const next = await api.setNodePolicy(node.id, {
        routingEligible: routing,
        quietHours: q.ranges,
        timeZone: zone || null,
      });
      onSaved(next);
      toast.show('Policy saved. The node takes it with its next heartbeat.', { tone: 'success' });
    } catch (err) {
      setError(opsErrorMessage(err, 'Could not save the policy.'));
      setBusy(false);
    }
  };

  return (
    <form
      className="ws-section devices-flat stack"
      aria-labelledby={`${base}-h`}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h2 id={`${base}-h`}>Policy</h2>
      <SwitchField
        label="Send model work to this node"
        description="Off keeps it out of routing: its models are not offered and it gets no jobs."
        checked={routing}
        disabled={revoked}
        onChange={setRouting}
      />
      <div className="devices-fields">
        <TextField
          label="Quiet hours"
          value={quiet}
          placeholder="22:00-07:00"
          disabled={revoked}
          hint="The node takes no new jobs then and routing skips it; running jobs finish. Like 22:00-07:00; separate several with commas."
          error={quietError ?? undefined}
          onChange={(e) => setQuiet(e.target.value)}
        />
        {zones ? (
          <SelectField
            label="Time zone"
            value={zone}
            disabled={revoked}
            onChange={setZone}
            hint="The quiet hours are read in this zone."
            options={[
              { value: '', label: 'The node’s own time zone' },
              ...(zone && !zones.includes(zone) ? [{ value: zone, label: zone }] : []),
              ...zones.map((z) => ({ value: z, label: z.replace(/_/g, ' ') })),
            ]}
          />
        ) : (
          <TextField
            label="Time zone"
            value={zone}
            disabled={revoked}
            placeholder="Europe/Lisbon"
            hint="An IANA time zone; blank for the node's own."
            onChange={(e) => setZone(e.target.value.trim())}
          />
        )}
      </div>
      {error ? (
        <p role="alert" className="nv-field-error">
          {error}
        </p>
      ) : null}
      <div className="row">
        <Button type="submit" variant="primary" disabled={!dirty || busy || revoked}>
          {busy ? <Spinner /> : null} Save policy
        </Button>
        <span className="muted">Change {p.revision}</span>
      </div>
    </form>
  );
}

function NodeServices({ api, node }: { api: DeviceOpsApi; node: NodeDetailView }) {
  const toast = useToast();
  const base = useId();
  const offline =
    node.status === 'revoked'
      ? 'This node was revoked.'
      : node.status !== 'active'
        ? 'The node is offline.'
        : null;
  const list = useLoad<NodeServiceView[] | null>(
    () => (offline ? Promise.resolve(null) : api.listNodeServices(node.id).then((r) => r.items)),
    `node-services:${node.id}:${offline ?? ''}`,
  );
  const reload = useDebounced(list.reload, 200);
  useHubStream(['node.service.changed'], (env) => {
    if (env.payload.nodeId === node.id) reload();
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const act = async (s: NodeServiceView, action: NodeServiceAction) => {
    setBusy(`${s.name}:${action}`);
    setError(null);
    try {
      const { service } = await api.nodeServiceAction(node.id, s.name, action);
      list.setData((cur) => cur?.map((x) => (x.name === service.name ? service : x)) ?? cur);
      toast.show(
        `${SERVICE_TEXT[s.name].label}: ${serviceChip(service.state).text.toLowerCase()}.`,
        {
          tone: 'success',
        },
      );
    } catch (err) {
      setError(
        opsErrorMessage(
          err,
          `Could not ${action} the ${SERVICE_TEXT[s.name].label.toLowerCase()}.`,
        ),
      );
      reload();
    } finally {
      setBusy(null);
    }
  };

  const updateRequired = errorReason(list.error) === 'update_required';
  return (
    <section className="ws-section devices-flat" aria-labelledby={`${base}-h`}>
      <h2 id={`${base}-h`}>Services</h2>
      {offline ? <Unavailable>{offline}</Unavailable> : null}
      {updateRequired ? (
        <Unavailable>
          This node’s nova-compute cannot list its services yet. Update it on the node.
        </Unavailable>
      ) : list.error ? (
        <LoadError
          error={list.error}
          fallback="Could not load the node’s services."
          onRetry={list.reload}
        />
      ) : null}
      {list.loading ? <Spinner label="Loading the node’s services" /> : null}
      {list.data?.length ? (
        <ul className="ws-list" aria-label="Node services">
          {list.data.map((s) => {
            const chip = serviceChip(s.state === 'unknown' ? null : s.state);
            return (
              <li
                key={s.name}
                className="ws-list-row devices-module"
                aria-label={SERVICE_TEXT[s.name].label}
              >
                <div className="devices-row-main">
                  <div className="devices-row-head">
                    <strong>{SERVICE_TEXT[s.name].label}</strong>
                    <Chip tone={chip.tone} icon={chip.icon} text={chip.text} />
                  </div>
                  <span className="muted ws-row-meta">
                    <span>{SERVICE_TEXT[s.name].help}</span>
                    {s.unit ? <span>systemd unit {s.unit}</span> : null}
                  </span>
                </div>
                <div className="row ws-row-actions">
                  {(['status', 'start', 'stop', 'restart'] as const).map((a) => (
                    <Button
                      key={a}
                      disabled={busy !== null}
                      aria-label={`${ACTION_LABEL[a]} ${SERVICE_TEXT[s.name].label}`}
                      onClick={() => void act(s, a)}
                    >
                      {busy === `${s.name}:${a}` ? <Spinner /> : null} {ACTION_LABEL[a]}
                    </Button>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
      <div aria-live="polite">
        {error ? (
          <p role="alert" className="nv-field-error">
            <Icon name="alert" /> {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
