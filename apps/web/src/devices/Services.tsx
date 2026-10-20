// Managed services (FR-145; docs/23 §1): the services the device's owner declared in novad's
// config, as novad lists them (a module or a systemd unit, with its state), each with Status,
// Start, Stop and Restart. An older novad cannot list them: the section says so and the by-name
// form below it still works. Needs the device online with its management module.
import { useId, useState } from 'react';
import type { DeviceServiceView, DeviceView } from '@nova/shared';
import { Button, Spinner, useToast } from '@nova/ui';
import { defineMessages } from '@nova/i18n';
import { useHubStream } from '../hub-events.ts';
import { useDebounced } from '../work/events.ts';
import { useDevicesApi } from './api.ts';
import { useDeviceOpsApi } from './api-m75.ts';
import { capabilityBlocked, errorReason, moduleLabel, type ChipTone } from './format.ts';
import { opsErrorMessage } from './ops.tsx';
import { Chip, LoadError, Unavailable, useLoad } from './parts.tsx';

/** Managed services' words (FR-016), also used by a compute node's services. */
export const SERVICES_TEXT = defineMessages('devices.services', {
  states: {
    running: 'Running',
    stopped: 'Stopped',
    failed: 'Failed',
    activating: 'Activating',
    deactivating: 'Stopping',
    reloading: 'Reloading',
    unknown: 'State unknown',
  },
  /** A service's new state, after an action; `other` shows the device's own word. */
  nowState:
    '{name}: {state, select, running {running.} stopped {stopped.} failed {failed.} activating {activating.} deactivating {stopping.} reloading {reloading.} unknown {state unknown.} other {{raw}.}}',
  systemdUnit: 'systemd unit {unit}',
  systemd: 'systemd unit',
  moduleOf: '{module} module',
  module: 'Module',
  actions: {
    status: 'Status',
    start: 'Start',
    stop: 'Stop',
    restart: 'Restart',
  },
  actionOn:
    '{action, select, status {Status {name}} start {Start {name}} stop {Stop {name}} other {Restart {name}}}',
  actionFailed:
    '{action, select, start {Could not start {name}.} stop {Could not stop {name}.} restart {Could not restart {name}.} other {Could not get the status of {name}.}}',
  title: 'Managed services',
  intro: 'The services declared in novad’s configuration on this device.',
  oldNovad:
    'This device’s novad cannot list its services yet. Update novad on it; meanwhile you can still act on a service by its name below.',
  loadFailed: 'Could not load the services.',
  loading: 'Loading the services',
  none: 'novad’s configuration declares no services.',
});

const S = SERVICES_TEXT;

type ServiceAction = 'status' | 'start' | 'stop' | 'restart';

type StateKey = keyof typeof S.states;

/** The state's key in `S.states`, or null for a word Nova does not know. */
function stateKey(state: string | null): StateKey | null {
  switch (state) {
    case 'running':
    case 'active':
      return 'running';
    case 'stopped':
    case 'inactive':
    case 'dead':
      return 'stopped';
    case 'failed':
    case 'crash_loop':
      return 'failed';
    case 'activating':
    case 'deactivating':
    case 'reloading':
      return state;
    case null:
      return 'unknown';
    default:
      return null;
  }
}

const STATE_LOOK: Record<StateKey, { tone: ChipTone; icon: 'check' | 'stop' | 'alert' | 'clock' }> =
  {
    running: { tone: 'ready', icon: 'check' },
    stopped: { tone: 'neutral', icon: 'stop' },
    failed: { tone: 'blocked', icon: 'alert' },
    activating: { tone: 'neutral', icon: 'clock' },
    deactivating: { tone: 'neutral', icon: 'clock' },
    reloading: { tone: 'neutral', icon: 'clock' },
    unknown: { tone: 'neutral', icon: 'clock' },
  };

/** A service state as a chip: running, stopped, failed, or what the device said. */
export function serviceChip(state: string | null): {
  text: string;
  tone: ChipTone;
  icon: 'check' | 'stop' | 'alert' | 'clock';
} {
  const key = stateKey(state);
  if (key) return { text: S.states[key], ...STATE_LOOK[key] };
  // A state Nova has no words for: the device's own word, tidied.
  const raw = state ?? '';
  return {
    text: raw.charAt(0).toUpperCase() + raw.slice(1).replace(/_/g, ' '),
    tone: 'neutral',
    icon: 'clock',
  };
}

/** "ollama.service: running." after an action. */
export function serviceNowText(name: string, state: string | null): string {
  return S.nowState({ name, state: stateKey(state) ?? 'other', raw: state ?? '' });
}

/** "Storage module" or "systemd unit ollama.service". */
export function serviceKindText(s: DeviceServiceView): string {
  if (s.kind === 'systemd') return s.unit ? S.systemdUnit({ unit: s.unit }) : S.systemd;
  return s.module ? S.moduleOf({ module: moduleLabel(s.module) }) : S.module;
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
      toast.show(serviceNowText(s.name, state), { tone: 'success' });
    } catch (err) {
      setError(opsErrorMessage(err, S.actionFailed({ action, name: s.name })));
      reload();
    } finally {
      setBusy(null);
    }
  };

  const updateRequired = errorReason(list.error) === 'update_required';
  return (
    <section className="ws-section devices-flat" aria-labelledby={`${base}-h`}>
      <h2 id={`${base}-h`}>{S.title}</h2>
      <p className="muted ws-flush">{S.intro}</p>
      {blocked ? <Unavailable>{blocked}</Unavailable> : null}
      {updateRequired ? (
        <Unavailable>{S.oldNovad}</Unavailable>
      ) : list.error ? (
        <LoadError error={list.error} fallback={S.loadFailed} onRetry={list.reload} />
      ) : null}
      {list.loading ? <Spinner label={S.loading} /> : null}
      {list.data?.length === 0 ? <p className="muted ws-flush">{S.none}</p> : null}
      {list.data?.length ? (
        <ul className="ws-list" aria-label={S.title}>
          {list.data.map((s) => {
            const chip = serviceChip(s.state);
            const off = Boolean(blocked) || busy !== null;
            return (
              <li key={s.name} className="ws-list-row devices-module" aria-label={s.name}>
                <div className="devices-row-main">
                  <div className="devices-row-head">
                    <strong dir="ltr">{s.name}</strong>
                    <Chip tone={chip.tone} icon={chip.icon} text={chip.text} />
                  </div>
                  <span className="muted ws-row-meta">{serviceKindText(s)}</span>
                </div>
                <div className="row ws-row-actions">
                  {(['status', 'start', 'stop', 'restart'] as const).map((a) => (
                    <Button
                      key={a}
                      disabled={off}
                      aria-label={S.actionOn({ action: a, name: s.name })}
                      onClick={() => void act(s, a)}
                    >
                      {busy === `${s.name}:${a}` ? <Spinner /> : null} {S.actions[a]}
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
