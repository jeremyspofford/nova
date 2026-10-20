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
import { defineMessages } from '@nova/i18n';
import { useHubStream } from '../hub-events.ts';
import { formatWhen } from '../settings/common.ts';
import { SwitchField } from '../settings/controls.tsx';
import { useDebounced } from '../work/events.ts';
import { useDeviceOpsApi, type DeviceOpsApi } from './api-m75.ts';
import { errorReason, formatBytes, parseQuietHours } from './format.ts';
import { opsErrorMessage } from './ops.tsx';
import { Chip, LoadError, Unavailable, useLoad } from './parts.tsx';
import { SERVICES_TEXT, serviceChip, serviceNowText } from './Services.tsx';

/** A compute node's words (FR-016): its state, policy and services. */
export const NODE_TEXT = defineMessages('devices.node', {
  loadFailed: 'Could not load the compute node.',
  loading: 'Loading the compute node',
  title: 'Compute node',
  quietNow: 'Quiet now: no new jobs',
  keptOut: 'Kept out of routing',
  takesJobs: 'Takes jobs',
  load: 'Load',
  loadValue: '{running} running, {queued} queued',
  notReported: 'Not reported',
  heartbeat: 'Last heartbeat',
  nodeSays: 'The node says',
  inQuietHours: 'It is in its quiet hours',
  itTakesJobs: 'It takes jobs',
  gpuMemory: 'GPU memory',
  meter: 'GPU {index} memory in use',
  noGpu: 'No GPU',
  notReportedYet: 'Not reported yet',
  gpu: 'GPU {index}',
  gpuNamed: 'GPU {index}, {name}',
  vram: {
    none: '{gpu}: memory not reported',
    total: '{gpu}: {total}',
    used: '{gpu}: {used} of {total} in use',
  },
  policy: {
    title: 'Policy',
    routing: 'Send model work to this node',
    routingHelp: 'Off keeps it out of routing: its models are not offered and it gets no jobs.',
    quiet: 'Quiet hours',
    quietHelp:
      'The node takes no new jobs then and routing skips it; running jobs finish. Like 22:00-07:00; separate several with commas.',
    badRange: '“{text}” is not a time range like 22:00-07:00.',
    zone: 'Time zone',
    zoneHelp: 'The quiet hours are read in this zone.',
    ownZone: 'The node’s own time zone',
    zoneExample: 'Europe/Lisbon',
    zoneFreeHelp: 'An IANA time zone; blank for the node’s own.',
    saved: 'Policy saved. The node takes it with its next heartbeat.',
    saveFailed: 'Could not save the policy.',
    save: 'Save policy',
    revision: 'Change {n}',
  },
  services: {
    title: 'Services',
    revoked: 'This node was revoked.',
    offline: 'The node is offline.',
    old: 'This node’s nova-compute cannot list its services yet. Update it on the node.',
    loadFailed: 'Could not load the node’s services.',
    loading: 'Loading the node’s services',
    list: 'Node services',
    jobs: {
      label: 'Job API',
      help: 'Takes work from this Hub. Stopped, the node takes no new jobs and routing skips it.',
    },
    backend: {
      label: 'Model server',
      help: 'The model server the node runs its models with.',
    },
    failed:
      '{service, select, jobs {{action, select, start {Could not start the job API.} stop {Could not stop the job API.} restart {Could not restart the job API.} other {Could not get the status of the job API.}}} other {{action, select, start {Could not start the model server.} stop {Could not stop the model server.} restart {Could not restart the model server.} other {Could not get the status of the model server.}}}}',
  },
});

const S = NODE_TEXT;

const NODE_EVENTS = ['node.policy.changed', 'node.service.changed', 'device.status.changed'];

/** A node service's name and help, read at render time. */
function serviceText(name: NodeServiceView['name']): { label: string; help: string } {
  return name === 'jobs' ? S.services.jobs : S.services.backend;
}

/** "GPU 0, NVIDIA RTX 4070: 3.2 GB of 12 GB in use". */
export function vramText(g: NodeGpuVram): string {
  const name = [g.vendor, g.name].filter(Boolean).join(' ');
  const gpu = name ? S.gpuNamed({ index: g.index, name }) : S.gpu({ index: g.index });
  if (g.totalBytes === null) return S.vram.none({ gpu });
  if (g.usedBytes === null) return S.vram.total({ gpu, total: formatBytes(g.totalBytes) });
  return S.vram.used({
    gpu,
    used: formatBytes(g.usedBytes),
    total: formatBytes(g.totalBytes),
  });
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
        <LoadError error={node.error} fallback={S.loadFailed} onRetry={node.reload} />
      ) : null}
      {node.loading ? <Spinner label={S.loading} /> : null}
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
        <h2 id={`${base}-h`}>{S.title}</h2>
        {n.status === 'revoked' ? null : n.quietNow ? (
          <Chip tone="needs_input" icon="clock" text={S.quietNow} />
        ) : !n.policy.routingEligible ? (
          <Chip tone="neutral" icon="stop" text={S.keptOut} />
        ) : (
          <Chip tone="ready" icon="check" text={S.takesJobs} />
        )}
      </div>
      <dl className="devices-facts">
        <div>
          <dt>{S.load}</dt>
          <dd>
            {n.load
              ? S.loadValue({ running: n.load.running, queued: n.load.queued })
              : S.notReported}
          </dd>
        </div>
        <div>
          <dt>{S.heartbeat}</dt>
          <dd>{formatWhen(n.lastSeenAt)}</dd>
        </div>
        {n.reportedQuiet !== null ? (
          <div>
            <dt>{S.nodeSays}</dt>
            <dd>{n.reportedQuiet ? S.inQuietHours : S.itTakesJobs}</dd>
          </div>
        ) : null}
        <div>
          <dt>{S.gpuMemory}</dt>
          <dd>
            {n.vram?.length ? (
              <ul className="devices-vram" aria-label={S.gpuMemory}>
                {n.vram.map((g) => (
                  <li key={g.index}>
                    {vramText(g)}
                    {g.totalBytes && g.usedBytes !== null ? (
                      <meter
                        min={0}
                        max={g.totalBytes}
                        value={g.usedBytes}
                        aria-label={S.meter({ index: g.index })}
                      />
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : n.vram ? (
              S.noGpu
            ) : (
              <span className="muted">{S.notReportedYet}</span>
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
  const P = S.policy;
  const dirty =
    routing !== p.routingEligible ||
    quiet.trim() !== p.quietHours.join(', ') ||
    (zone || null) !== p.timeZone;

  const save = async () => {
    const q = parseQuietHours(quiet);
    if ('bad' in q) {
      setQuietError(P.badRange({ text: q.bad }));
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
      toast.show(P.saved, { tone: 'success' });
    } catch (err) {
      setError(opsErrorMessage(err, P.saveFailed));
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
      <h2 id={`${base}-h`}>{P.title}</h2>
      <SwitchField
        label={P.routing}
        description={P.routingHelp}
        checked={routing}
        disabled={revoked}
        onChange={setRouting}
      />
      <div className="devices-fields">
        <TextField
          label={P.quiet}
          value={quiet}
          placeholder="22:00-07:00"
          dir="ltr"
          disabled={revoked}
          hint={P.quietHelp}
          error={quietError ?? undefined}
          onChange={(e) => setQuiet(e.target.value)}
        />
        {zones ? (
          <SelectField
            label={P.zone}
            value={zone}
            disabled={revoked}
            onChange={setZone}
            hint={P.zoneHelp}
            options={[
              { value: '', label: P.ownZone },
              ...(zone && !zones.includes(zone) ? [{ value: zone, label: zone }] : []),
              ...zones.map((z) => ({ value: z, label: z.replace(/_/g, ' ') })),
            ]}
          />
        ) : (
          <TextField
            label={P.zone}
            value={zone}
            disabled={revoked}
            placeholder={P.zoneExample}
            hint={P.zoneFreeHelp}
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
          {busy ? <Spinner /> : null} {P.save}
        </Button>
        <span className="muted">{P.revision({ n: p.revision })}</span>
      </div>
    </form>
  );
}

function NodeServices({ api, node }: { api: DeviceOpsApi; node: NodeDetailView }) {
  const toast = useToast();
  const base = useId();
  const V = S.services;
  const offline =
    node.status === 'revoked' ? V.revoked : node.status !== 'active' ? V.offline : null;
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
      const state = service.state === 'unknown' ? null : service.state;
      toast.show(serviceNowText(serviceText(s.name).label, state), { tone: 'success' });
    } catch (err) {
      setError(opsErrorMessage(err, V.failed({ service: s.name, action })));
      reload();
    } finally {
      setBusy(null);
    }
  };

  const updateRequired = errorReason(list.error) === 'update_required';
  return (
    <section className="ws-section devices-flat" aria-labelledby={`${base}-h`}>
      <h2 id={`${base}-h`}>{V.title}</h2>
      {offline ? <Unavailable>{offline}</Unavailable> : null}
      {updateRequired ? (
        <Unavailable>{V.old}</Unavailable>
      ) : list.error ? (
        <LoadError error={list.error} fallback={V.loadFailed} onRetry={list.reload} />
      ) : null}
      {list.loading ? <Spinner label={V.loading} /> : null}
      {list.data?.length ? (
        <ul className="ws-list" aria-label={V.list}>
          {list.data.map((s) => {
            const chip = serviceChip(s.state === 'unknown' ? null : s.state);
            const t = serviceText(s.name);
            return (
              <li key={s.name} className="ws-list-row devices-module" aria-label={t.label}>
                <div className="devices-row-main">
                  <div className="devices-row-head">
                    <strong>{t.label}</strong>
                    <Chip tone={chip.tone} icon={chip.icon} text={chip.text} />
                  </div>
                  <span className="muted ws-row-meta">
                    <span>{t.help}</span>
                    {s.unit ? <span>{SERVICES_TEXT.systemdUnit({ unit: s.unit })}</span> : null}
                  </span>
                </div>
                <div className="row ws-row-actions">
                  {(['status', 'start', 'stop', 'restart'] as const).map((a) => (
                    <Button
                      key={a}
                      disabled={busy !== null}
                      aria-label={SERVICES_TEXT.actionOn({ action: a, name: t.label })}
                      onClick={() => void act(s, a)}
                    >
                      {busy === `${s.name}:${a}` ? <Spinner /> : null} {SERVICES_TEXT.actions[a]}
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
