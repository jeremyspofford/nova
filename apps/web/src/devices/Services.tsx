// Managed services (FR-145; docs/23 §1): the services the device's owner declared in novad's
// config, as novad lists them (a module or a systemd unit, with its state), each with Status,
// Start, Stop and Restart. An older novad cannot list them: the section says so and the by-name
// form below it still works. Needs the device online with its management module.
import { useId, useState } from 'react';
import type { DeviceServiceView, DeviceView } from '@nova/shared';
import { Button, Spinner, useToast } from '@nova/ui';
import { useHubStream } from '../hub-events.ts';
import { useDebounced } from '../work/events.ts';
import { useDevicesApi } from './api.ts';
import { useDeviceOpsApi } from './api-m75.ts';
import { capabilityBlocked, errorReason, moduleLabel, type ChipTone } from './format.ts';
import { opsErrorMessage } from './ops.tsx';
import { Chip, LoadError, Unavailable, useLoad } from './parts.tsx';

type ServiceAction = 'status' | 'start' | 'stop' | 'restart';

const ACTION_LABEL: Record<ServiceAction, string> = {
  status: 'Status',
  start: 'Start',
  stop: 'Stop',
  restart: 'Restart',
};

/** A service state as a chip: running, stopped, failed, or what the device said. */
export function serviceChip(state: string | null): {
  text: string;
  tone: ChipTone;
  icon: 'check' | 'stop' | 'alert' | 'clock';
} {
  switch (state) {
    case 'running':
    case 'active':
      return { text: 'Running', tone: 'ready', icon: 'check' };
    case 'stopped':
    case 'inactive':
    case 'dead':
      return { text: 'Stopped', tone: 'neutral', icon: 'stop' };
    case 'failed':
    case 'crash_loop':
      return { text: 'Failed', tone: 'blocked', icon: 'alert' };
    case null:
      return { text: 'State unknown', tone: 'neutral', icon: 'clock' };
    default:
      return {
        text: state.charAt(0).toUpperCase() + state.slice(1).replace(/_/g, ' '),
        tone: 'neutral',
        icon: 'clock',
      };
  }
}

/** "Module storage" or "systemd unit ollama.service". */
export function serviceKindText(s: DeviceServiceView): string {
  if (s.kind === 'systemd') return s.unit ? `systemd unit ${s.unit}` : 'systemd unit';
  return s.module ? `${moduleLabel(s.module)} module` : 'Module';
}

export function ServiceList({ device }: { device: DeviceView }) {
  const ops = useDeviceOpsApi();
  const api = useDevicesApi();
  const toast = useToast();
  const base = useId();
  const blocked = capabilityBlocked(device, 'services');
  const list = useLoad<DeviceServiceView[] | null>(
    () =>
      ops && !blocked
        ? ops.listDeviceServices(device.id).then((r) => r.items)
        : Promise.resolve(null),
    `services:${device.id}:${blocked ?? ''}`,
  );
  const reload = useDebounced(list.reload, 200);
  useHubStream(['device.service.changed'], (env) => {
    if (env.payload.deviceId === device.id) reload();
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!ops) return null;

  const act = async (s: DeviceServiceView, action: ServiceAction) => {
    setBusy(`${s.name}:${action}`);
    setError(null);
    try {
      const { service } = await api.deviceServiceAction(device.id, s.name, action);
      const state = typeof service.state === 'string' ? service.state : null;
      list.setData((cur) => cur?.map((x) => (x.name === s.name ? { ...x, state } : x)) ?? cur);
      toast.show(`${s.name}: ${serviceChip(state).text.toLowerCase()}.`, { tone: 'success' });
    } catch (err) {
      setError(opsErrorMessage(err, `Could not ${action} ${s.name}.`));
      reload();
    } finally {
      setBusy(null);
    }
  };

  const updateRequired = errorReason(list.error) === 'update_required';
  return (
    <section className="ws-section devices-flat" aria-labelledby={`${base}-h`}>
      <h2 id={`${base}-h`}>Managed services</h2>
      <p className="muted ws-flush">
        The services declared in novad’s configuration on this device.
      </p>
      {blocked ? <Unavailable>{blocked}</Unavailable> : null}
      {updateRequired ? (
        <Unavailable>
          This device’s novad cannot list its services yet. Update novad on it; meanwhile you can
          still act on a service by its name below.
        </Unavailable>
      ) : list.error ? (
        <LoadError
          error={list.error}
          fallback="Could not load the services."
          onRetry={list.reload}
        />
      ) : null}
      {list.loading ? <Spinner label="Loading the services" /> : null}
      {list.data?.length === 0 ? (
        <p className="muted ws-flush">novad’s configuration declares no services.</p>
      ) : null}
      {list.data?.length ? (
        <ul className="ws-list" aria-label="Managed services">
          {list.data.map((s) => {
            const chip = serviceChip(s.state);
            const off = Boolean(blocked) || busy !== null;
            return (
              <li key={s.name} className="ws-list-row devices-module" aria-label={s.name}>
                <div className="devices-row-main">
                  <div className="devices-row-head">
                    <strong>{s.name}</strong>
                    <Chip tone={chip.tone} icon={chip.icon} text={chip.text} />
                  </div>
                  <span className="muted ws-row-meta">{serviceKindText(s)}</span>
                </div>
                <div className="row ws-row-actions">
                  {(['status', 'start', 'stop', 'restart'] as const).map((a) => (
                    <Button
                      key={a}
                      disabled={off}
                      aria-label={`${ACTION_LABEL[a]} ${s.name}`}
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
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
