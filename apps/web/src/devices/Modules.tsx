// Modules and services (FR-141, FR-145; docs/23 §1, §4, §10): each signed module the supervisor
// runs, with its state, restarts and a crash loop said plainly, and Start, Stop, Restart and Roll
// back; then the device's managed services, by name, with Status, Start, Stop and Restart. Both
// need the device online with its management module; the reason shows when they cannot run.
import { useId, useState } from 'react';
import {
  DEVICE_MODULES,
  type DeviceModuleName,
  type DeviceModuleView,
  type DeviceView,
} from '@nova/shared';
import { Button, Spinner, TextField, useToast } from '@nova/ui';
import { formatWhen, plural } from '../settings/common.ts';
import { useDevicesApi, type DeviceServiceResult } from './api.ts';
import type { PanelProps } from './DevicePage.tsx';
import {
  MODULE_PURPOSE,
  MODULE_STATE,
  capabilityBlocked,
  crashLooped,
  deviceErrorMessage,
  moduleLabel,
} from './format.ts';
import { Chip, ConfirmDialog, Unavailable } from './parts.tsx';

type ModuleAction = 'start' | 'stop' | 'restart' | 'rollback';

/** Why the policy keeps a module from starting, or null. */
function notAllowed(d: DeviceView, name: string): string | null {
  const allowed = d.policy.allowedModules;
  return allowed && !allowed.includes(name as DeviceModuleName)
    ? 'Not allowed by this device’s policy'
    : null;
}

export function ModulesPanel({ device, onDevice, reload }: PanelProps) {
  return (
    <div className="stack">
      <ModuleList device={device} onDevice={onDevice} reload={reload} />
      <Services device={device} />
    </div>
  );
}

function ModuleList({ device, onDevice, reload }: PanelProps) {
  const api = useDevicesApi();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [rollingBack, setRollingBack] = useState<DeviceModuleView | null>(null);
  const blocked = capabilityBlocked(device, 'services');

  const act = async (m: DeviceModuleView, action: ModuleAction) => {
    setBusy(`${m.name}:${action}`);
    try {
      const { module } = await api.deviceModuleAction(device.id, m.name, action);
      onDevice({
        ...device,
        modules: device.modules.map((x) => (x.name === module.name ? module : x)),
      });
      toast.show(`${moduleLabel(m.name)}: ${MODULE_STATE[module.state].text.toLowerCase()}.`, {
        tone: 'success',
      });
    } catch (err) {
      toast.show(deviceErrorMessage(err, `Could not ${action} ${moduleLabel(m.name)}.`), {
        tone: 'error',
      });
      reload();
    } finally {
      setBusy(null);
    }
  };

  const declared = device.capability?.modules;
  const installed: unknown[] = Array.isArray(declared) ? declared : [];
  const missing = DEVICE_MODULES.filter(
    (n) => !device.modules.some((m) => m.name === n) && !installed.includes(n),
  );
  return (
    <section className="ws-section devices-flat" aria-labelledby="modules-h">
      <h2 id="modules-h">Modules</h2>
      <p className="muted ws-flush">
        novad runs each module on its own, sandboxed. A module that keeps crashing is stopped until
        you start it again.
      </p>
      {blocked ? <Unavailable>{blocked}</Unavailable> : null}
      {device.modules.length ? (
        <ul className="ws-list" aria-label="Modules">
          {[...device.modules]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((m) => {
              const s = MODULE_STATE[m.state];
              const looped = crashLooped(m);
              const disallowed = notAllowed(device, m.name);
              const running = m.state === 'running' || m.state === 'backoff';
              const off = Boolean(blocked) || busy !== null;
              return (
                <li
                  key={m.name}
                  className="ws-list-row devices-module"
                  aria-label={moduleLabel(m.name)}
                >
                  <div className="devices-row-main">
                    <div className="devices-row-head">
                      <strong>{moduleLabel(m.name)}</strong>
                      <Chip
                        tone={looped ? 'blocked' : s.tone}
                        icon={looped ? 'alert' : s.icon}
                        text={looped ? 'Stopped after repeated crashes' : s.text}
                      />
                    </div>
                    <span className="muted ws-row-meta">
                      <span>{MODULE_PURPOSE[m.name as DeviceModuleName] ?? 'Module'}</span>
                      <span>Version {m.version || 'unknown'}</span>
                      <span>{plural(m.restarts, 'restart')}</span>
                      {m.startedAt && m.state === 'running' ? (
                        <span>Started {formatWhen(m.startedAt)}</span>
                      ) : null}
                    </span>
                    {m.lastExit ? (
                      <span className="muted ws-row-meta">Last exit: {m.lastExit}</span>
                    ) : null}
                    {m.disabledReason && !looped ? (
                      <span className="muted ws-row-meta">Disabled: {m.disabledReason}</span>
                    ) : null}
                    {disallowed ? <span className="muted ws-row-meta">{disallowed}</span> : null}
                  </div>
                  <div className="row ws-row-actions">
                    {running ? (
                      <>
                        <Button
                          disabled={off || Boolean(disallowed)}
                          title={disallowed ?? undefined}
                          onClick={() => void act(m, 'restart')}
                          aria-label={`Restart ${moduleLabel(m.name)}`}
                        >
                          {busy === `${m.name}:restart` ? <Spinner /> : null} Restart
                        </Button>
                        <Button
                          disabled={off}
                          onClick={() => void act(m, 'stop')}
                          aria-label={`Stop ${moduleLabel(m.name)}`}
                        >
                          {busy === `${m.name}:stop` ? <Spinner /> : null} Stop
                        </Button>
                      </>
                    ) : (
                      <Button
                        disabled={off || Boolean(disallowed)}
                        title={disallowed ?? undefined}
                        onClick={() => void act(m, 'start')}
                        aria-label={`Start ${moduleLabel(m.name)}`}
                      >
                        {busy === `${m.name}:start` ? <Spinner /> : null} Start
                      </Button>
                    )}
                    {m.previousVersion ? (
                      <Button
                        variant="ghost"
                        disabled={off}
                        onClick={() => setRollingBack(m)}
                        aria-label={`Roll back ${moduleLabel(m.name)}`}
                      >
                        Roll back
                      </Button>
                    ) : null}
                  </div>
                </li>
              );
            })}
        </ul>
      ) : (
        <p className="muted ws-flush">The device has not reported its modules yet.</p>
      )}
      {missing.length && device.modules.length ? (
        <p className="muted ws-flush">
          Not installed: {missing.map((n) => moduleLabel(n)).join(', ')}. Install them with novad on
          the device.
        </p>
      ) : null}
      <ConfirmDialog
        open={rollingBack !== null}
        title={rollingBack ? `Roll back ${moduleLabel(rollingBack.name)}?` : 'Roll back?'}
        description={
          rollingBack
            ? `It goes back from version ${rollingBack.version} to ${rollingBack.previousVersion ?? 'the previous one'} and restarts.`
            : undefined
        }
        confirmLabel="Roll back"
        onClose={() => setRollingBack(null)}
        onConfirm={async () => {
          const m = rollingBack;
          if (!m) return;
          const { module } = await api.deviceModuleAction(device.id, m.name, 'rollback');
          setRollingBack(null);
          onDevice({
            ...device,
            modules: device.modules.map((x) => (x.name === module.name ? module : x)),
          });
          toast.show(`${moduleLabel(m.name)} is back on version ${module.version}.`, {
            tone: 'success',
          });
        }}
      />
    </section>
  );
}

/** Service names worth offering: the device's compute backends and its modules. */
export function serviceSuggestions(d: DeviceView): string[] {
  const services = d.capability?.services;
  const backends =
    typeof services === 'object' && services !== null && 'computeBackends' in services
      ? (services as { computeBackends?: unknown }).computeBackends
      : null;
  const names = Array.isArray(backends) ? backends.filter((x) => typeof x === 'string') : [];
  return [...new Set(['compute', ...names])];
}

const SERVICE_ACTION_LABEL = {
  status: 'Status',
  start: 'Start',
  stop: 'Stop',
  restart: 'Restart',
} as const;

const SERVICE_NAME = /^[A-Za-z0-9@._:-]{1,100}$/;

function Services({ device }: { device: DeviceView }) {
  const api = useDevicesApi();
  const base = useId();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ name: string; service: DeviceServiceResult } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const blocked = capabilityBlocked(device, 'services');
  const trimmed = name.trim();
  const bad = trimmed && !SERVICE_NAME.test(trimmed);

  const act = async (action: 'start' | 'stop' | 'restart' | 'status') => {
    if (!trimmed || bad) return;
    setBusy(action);
    setError(null);
    try {
      const { service } = await api.deviceServiceAction(device.id, trimmed, action);
      setResult({ name: trimmed, service });
    } catch (err) {
      setResult(null);
      setError(deviceErrorMessage(err, `Could not ${action} ${trimmed}.`));
    } finally {
      setBusy(null);
    }
  };

  const state = result ? result.service.state : null;
  return (
    <section className="ws-section devices-flat" aria-labelledby="services-h">
      <h2 id="services-h">Services</h2>
      <p className="muted ws-flush">
        Start, stop or restart a service novad manages on this device, such as its model server.
      </p>
      {blocked ? <Unavailable>{blocked}</Unavailable> : null}
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          void act('status');
        }}
      >
        <TextField
          label="Service"
          value={name}
          list={`${base}-names`}
          autoComplete="off"
          disabled={Boolean(blocked)}
          error={bad ? 'Letters, digits and . _ : @ - only.' : undefined}
          onChange={(e) => setName(e.target.value)}
        />
        <datalist id={`${base}-names`}>
          {serviceSuggestions(device).map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
        {(['status', 'start', 'stop', 'restart'] as const).map((a) => (
          <Button
            key={a}
            type={a === 'status' ? 'submit' : 'button'}
            disabled={Boolean(blocked) || !trimmed || Boolean(bad) || busy !== null}
            onClick={a === 'status' ? undefined : () => void act(a)}
          >
            {busy === a ? <Spinner /> : null} {SERVICE_ACTION_LABEL[a]}
          </Button>
        ))}
      </form>
      <div aria-live="polite">
        {result ? (
          <p className="ws-flush">
            <strong>{result.name}</strong>:{' '}
            {typeof state === 'string' ? state : 'no state reported'}
            {typeof result.service.kind === 'string' ? ` (${result.service.kind})` : ''}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="nv-field-error">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
