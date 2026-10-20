// Modules and services (FR-141, FR-145; docs/23 §1, §4, §10): each signed module the supervisor
// runs, with its state, restarts and a crash loop said plainly, and Start, Stop, Restart and Roll
// back; then the managed services novad lists (M7.5, Services.tsx), and any service by name, with
// Status, Start, Stop and Restart. Both need the device online with its management module; the
// reason shows when they cannot run.
import { useId, useState } from 'react';
import {
  DEVICE_MODULES,
  type DeviceModuleName,
  type DeviceModuleView,
  type DeviceView,
} from '@nova/shared';
import { Button, Spinner, TextField, useToast } from '@nova/ui';
import { defineMessages } from '@nova/i18n';
import { rich } from '../i18n/rich.tsx';
import { formatWhen } from '../settings/common.ts';
import { useDevicesApi, type DeviceServiceResult } from './api.ts';
import type { PanelProps } from './DevicePage.tsx';
import {
  MODULE_PURPOSE,
  MODULE_STATE,
  capabilityBlocked,
  crashLooped,
  deviceErrorMessage,
  listText,
  moduleLabel,
} from './format.ts';
import { Chip, ConfirmDialog, Unavailable } from './parts.tsx';
import { ServiceList } from './Services.tsx';

/** The Modules tab's words (FR-016): the supervisor's modules and services by name. */
export const MODULES_TEXT = defineMessages('devices.modules', {
  title: 'Modules',
  intro:
    'novad runs each module on its own, sandboxed. A module that keeps crashing is stopped until you start it again.',
  notAllowed: 'Not allowed by this device’s policy',
  /** A module's new state, after an action. */
  nowState:
    '{module}: {state, select, running {running.} stopped {stopped.} backoff {restarting after a crash.} disabled {disabled.} other {{state}.}}',
  actionFailed:
    '{action, select, start {Could not start {module}.} stop {Could not stop {module}.} restart {Could not restart {module}.} other {Could not roll back {module}.}}',
  crashLoop: 'Stopped after repeated crashes',
  module: 'Module',
  version: 'Version {version}',
  versionUnknown: 'Version unknown',
  restarts: '{n, plural, one {# restart} other {# restarts}}',
  started: 'Started {when}',
  lastExit: 'Last exit: {exit}',
  disabled: 'Disabled: {reason}',
  restart: 'Restart',
  restartModule: 'Restart {module}',
  stop: 'Stop',
  stopModule: 'Stop {module}',
  start: 'Start',
  startModule: 'Start {module}',
  rollBack: 'Roll back',
  rollBackModule: 'Roll back {module}',
  rollBackTitle: 'Roll back {module}?',
  rollBackBare: 'Roll back?',
  rollBackTo: 'It goes back from version {from} to {to} and restarts.',
  rollBackPrevious: 'It goes back from version {from} to the previous one and restarts.',
  rolledBack: '{module} is back on version {version}.',
  none: 'The device has not reported its modules yet.',
  notInstalled: 'Not installed: {modules}. Install them with novad on the device.',
  services: {
    title: 'Services',
    intro:
      'Start, stop or restart a service novad manages on this device, such as its model server.',
    field: 'Service',
    badName: 'Letters, digits and . _ : @ - only.',
    actions: {
      status: 'Status',
      start: 'Start',
      stop: 'Stop',
      restart: 'Restart',
    },
    failed:
      '{action, select, start {Could not start {name}.} stop {Could not stop {name}.} restart {Could not restart {name}.} other {Could not get the status of {name}.}}',
    /** The device's own words for the state and kind are shown as they are. */
    result: '{name}: {state}',
    resultKind: '{name}: {state} ({kind})',
    noState: 'no state reported',
  },
});

const S = MODULES_TEXT;

type ModuleAction = 'start' | 'stop' | 'restart' | 'rollback';

/** Why the policy keeps a module from starting, or null. */
function notAllowed(d: DeviceView, name: string): string | null {
  const allowed = d.policy.allowedModules;
  return allowed && !allowed.includes(name as DeviceModuleName) ? S.notAllowed : null;
}

export function ModulesPanel({ device, onDevice, reload }: PanelProps) {
  return (
    <div className="stack">
      <ModuleList device={device} onDevice={onDevice} reload={reload} />
      <ServiceList device={device} />
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
      toast.show(S.nowState({ module: moduleLabel(m.name), state: module.state }), {
        tone: 'success',
      });
    } catch (err) {
      toast.show(deviceErrorMessage(err, S.actionFailed({ action, module: moduleLabel(m.name) })), {
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
      <h2 id="modules-h">{S.title}</h2>
      <p className="muted ws-flush">{S.intro}</p>
      {blocked ? <Unavailable>{blocked}</Unavailable> : null}
      {device.modules.length ? (
        <ul className="ws-list" aria-label={S.title}>
          {[...device.modules]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((m) => {
              const s = MODULE_STATE[m.state];
              const looped = crashLooped(m);
              const disallowed = notAllowed(device, m.name);
              const running = m.state === 'running' || m.state === 'backoff';
              const off = Boolean(blocked) || busy !== null;
              const module = moduleLabel(m.name);
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
                        text={looped ? S.crashLoop : s.text}
                      />
                    </div>
                    <span className="muted ws-row-meta">
                      <span>{MODULE_PURPOSE[m.name as DeviceModuleName] ?? S.module}</span>
                      <span>
                        {m.version ? S.version({ version: m.version }) : S.versionUnknown}
                      </span>
                      <span>{S.restarts({ n: m.restarts })}</span>
                      {m.startedAt && m.state === 'running' ? (
                        <span>{S.started({ when: formatWhen(m.startedAt) })}</span>
                      ) : null}
                    </span>
                    {m.lastExit ? (
                      <span className="muted ws-row-meta">{S.lastExit({ exit: m.lastExit })}</span>
                    ) : null}
                    {m.disabledReason && !looped ? (
                      <span className="muted ws-row-meta">
                        {S.disabled({ reason: m.disabledReason })}
                      </span>
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
                          aria-label={S.restartModule({ module })}
                        >
                          {busy === `${m.name}:restart` ? <Spinner /> : null} {S.restart}
                        </Button>
                        <Button
                          disabled={off}
                          onClick={() => void act(m, 'stop')}
                          aria-label={S.stopModule({ module })}
                        >
                          {busy === `${m.name}:stop` ? <Spinner /> : null} {S.stop}
                        </Button>
                      </>
                    ) : (
                      <Button
                        disabled={off || Boolean(disallowed)}
                        title={disallowed ?? undefined}
                        onClick={() => void act(m, 'start')}
                        aria-label={S.startModule({ module })}
                      >
                        {busy === `${m.name}:start` ? <Spinner /> : null} {S.start}
                      </Button>
                    )}
                    {m.previousVersion ? (
                      <Button
                        variant="ghost"
                        disabled={off}
                        onClick={() => setRollingBack(m)}
                        aria-label={S.rollBackModule({ module })}
                      >
                        {S.rollBack}
                      </Button>
                    ) : null}
                  </div>
                </li>
              );
            })}
        </ul>
      ) : (
        <p className="muted ws-flush">{S.none}</p>
      )}
      {missing.length && device.modules.length ? (
        <p className="muted ws-flush">
          {S.notInstalled({ modules: listText(missing.map((n) => moduleLabel(n))) })}
        </p>
      ) : null}
      <ConfirmDialog
        open={rollingBack !== null}
        title={
          rollingBack ? S.rollBackTitle({ module: moduleLabel(rollingBack.name) }) : S.rollBackBare
        }
        description={
          rollingBack
            ? rollingBack.previousVersion
              ? S.rollBackTo({ from: rollingBack.version, to: rollingBack.previousVersion })
              : S.rollBackPrevious({ from: rollingBack.version })
            : undefined
        }
        confirmLabel={S.rollBack}
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
          toast.show(S.rolledBack({ module: moduleLabel(m.name), version: module.version }), {
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
      setError(deviceErrorMessage(err, S.services.failed({ action, name: trimmed })));
    } finally {
      setBusy(null);
    }
  };

  const state = result ? result.service.state : null;
  const kind = result ? result.service.kind : null;
  const V = S.services;
  return (
    <section className="ws-section devices-flat" aria-labelledby="services-h">
      <h2 id="services-h">{V.title}</h2>
      <p className="muted ws-flush">{V.intro}</p>
      {blocked ? <Unavailable>{blocked}</Unavailable> : null}
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          void act('status');
        }}
      >
        <TextField
          label={V.field}
          value={name}
          list={`${base}-names`}
          autoComplete="off"
          disabled={Boolean(blocked)}
          error={bad ? V.badName : undefined}
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
            {busy === a ? <Spinner /> : null} {V.actions[a]}
          </Button>
        ))}
      </form>
      <div aria-live="polite">
        {result ? (
          <p className="ws-flush">
            {typeof kind === 'string'
              ? rich(V.resultKind, {
                  name: <strong>{result.name}</strong>,
                  state: typeof state === 'string' ? state : V.noState,
                  kind,
                })
              : rich(V.result, {
                  name: <strong>{result.name}</strong>,
                  state: typeof state === 'string' ? state : V.noState,
                })}
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
