// Power and Wake-on-LAN (FR-144, FR-138; docs/23 §5.3, docs/22 §7): the device's power state as
// it reports it, Wake for a device that reports Wake-on-LAN (sent through a Wake helper on its
// network, or by the Hub when it is on that network; rate-limited by `devices.wakesPerHour`), the
// steps to turn Wake-on-LAN on (shown first; applied only when the user asks, and novad may need
// elevation), and Sleep, Restart and Shut down, each confirmed first. What happens after a power
// cut is read from the firmware (M7.5) and changed in the Firmware tab (FR-146).
import { useState } from 'react';
import { Button, Spinner, useToast } from '@nova/ui';
import { defineMessages, messageFor } from '@nova/i18n';
import { firmwareTabPath } from '../firmware/format.ts';
import { rich } from '../i18n/rich.tsx';
import { useSetting } from '../settings.tsx';
import { followLink } from '../work/nav.tsx';
import { useDevicesApi, type DevicePowerResult } from './api.ts';
import type { PanelProps } from './DevicePage.tsx';
import {
  addDevicePath,
  capabilityBlocked,
  deviceErrorMessage,
  listText,
  wakeSentText,
} from './format.ts';
import { ConfirmDialog, LoadError, Unavailable, useLoad } from './parts.tsx';

/** The Power tab's words (FR-016). */
export const POWER_TEXT = defineMessages('devices.power', {
  actions: {
    sleep: {
      label: 'Sleep',
      title: 'Put the device to sleep?',
      description: 'Work running on it pauses. Wake it from here if it reports Wake-on-LAN.',
    },
    restart: {
      label: 'Restart',
      title: 'Restart the device?',
      description: 'Anything open on it closes, and work running on it stops.',
    },
    shutdown: {
      label: 'Shut down',
      title: 'Shut down the device?',
      description:
        'Anything open on it closes and work on it stops. It comes back only when it is turned on, or woken if it supports Wake-on-LAN.',
    },
  },
  sent: '{action, select, sleep {Sleep: sent to {device}.} restart {Restart: sent to {device}.} other {Shut down: sent to {device}.}}',
  confirm: 'Confirm',
  afterLoss: {
    on: 'Turns back on',
    off: 'Stays off',
    last: 'Returns to its last state',
    unknown: 'Unknown',
  },
  yes: 'Yes',
  no: 'No',
  unknown: 'Unknown',
  wakeFailed: 'Could not send the wake signal.',
  stepsFailed: 'Could not get the steps.',
  title: 'Power',
  lastReported: '{why} Showing what it last reported.',
  readFailed: 'Could not read the power state.',
  reading: 'Reading the power state',
  wol: 'Wake-on-LAN',
  on: 'On',
  offOrUnsupported: 'Off or not supported',
  addresses: 'Network addresses',
  noneReported: 'None reported',
  mains: 'On mains power',
  afterCut: 'After a power cut',
  firmware:
    'What happens after a power cut, and Wake-on-LAN in the firmware, are firmware settings: {link}, with your approval and a snapshot to roll back to.',
  firmwareLink: 'change them in Firmware',
  wake: 'Wake',
  revoked: 'This device was revoked.',
  wakeHow:
    "Sends a Wake-on-LAN signal through a Wake helper on the device's network, or from the Hub when it is on that network.",
  onlineNow: 'The device is online now.',
  wakeLimit: 'At most {n, plural, one {# wake} other {# wakes}} an hour for a device; {link}.',
  limitLink: 'change the limit in Settings',
  wakeDevice: 'Wake {name}',
  noHelper:
    'No Wake helper on its network yet? {link}: an always-on device there, such as a NAS or a mini PC.',
  addHelper: 'Add one',
  notWakeable: 'This device does not report Wake-on-LAN, so it cannot be woken from here.',
  turnOn: 'Turn on Wake-on-LAN',
  stepsFirst:
    'See the steps first. novad applies them only when you ask, and some need it to run with elevated rights.',
  showSteps: 'Show the steps',
  apply: 'Apply on the device',
  steps: 'Steps',
  alreadyOn: 'Nothing to change: Wake-on-LAN is already on.',
  elevation: 'These steps need administrator rights.',
  powerActions: 'Sleep, restart or shut down',
  enableTitle: 'Turn on Wake-on-LAN?',
  enableBody: 'novad runs the steps shown on the device.',
  enableConfirm: 'Apply',
  enabled: 'Wake-on-LAN is on.',
  notApplied: 'The device did not apply the steps. Run them on the device yourself.',
});

const S = POWER_TEXT;

type PowerAction = 'sleep' | 'restart' | 'shutdown';

/** One planned step as text: a command's arguments, or the step's own words. */
export function planStepText(step: unknown): string {
  if (typeof step === 'string') return step;
  if (typeof step !== 'object' || step === null) return '';
  const s = step as Record<string, unknown>;
  if (Array.isArray(s.argv)) return s.argv.map(String).join(' ');
  if (typeof s.description === 'string') return s.description;
  return JSON.stringify(step);
}

const yesNo = (v: unknown) => (v === true ? S.yes : v === false ? S.no : S.unknown);

export function PowerPanel({ device, deviceName }: PanelProps) {
  const api = useDevicesApi();
  const toast = useToast();
  const limit = useSetting('devices.wakesPerHour').value;
  const blocked = capabilityBlocked(device, 'power');
  const revoked = device.status === 'revoked';
  const power = useLoad<DevicePowerResult | null>(
    () => (blocked ? Promise.resolve(null) : api.getDevicePower(device.id)),
    `${device.id}:${blocked ?? 'ok'}`,
  );
  const [waking, setWaking] = useState(false);
  const [plan, setPlan] = useState<{ steps: string[]; elevation: boolean } | null>(null);
  const [planBusy, setPlanBusy] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [enabling, setEnabling] = useState(false);
  const [asking, setAsking] = useState<PowerAction | null>(null);

  const p = power.data ?? {};
  const wakeable = power.data ? p.wakeable === true : device.wake.wakeable;
  const macs = Array.isArray(p.macs) ? p.macs.map(String) : device.wake.macs;

  const wake = async () => {
    setWaking(true);
    try {
      const w = await api.wakeDevice(device.id);
      toast.show(wakeSentText(device.name, w, deviceName), { tone: 'success' });
    } catch (err) {
      toast.show(deviceErrorMessage(err, S.wakeFailed), { tone: 'error' });
    } finally {
      setWaking(false);
    }
  };

  const showPlan = async () => {
    setPlanBusy(true);
    setPlanError(null);
    try {
      const r = await api.devicePowerAction(device.id, { action: 'wol-plan' });
      setPlan({
        steps: Array.isArray(r.plan) ? r.plan.map(planStepText).filter(Boolean) : [],
        elevation: r.needsElevation === true,
      });
    } catch (err) {
      setPlanError(deviceErrorMessage(err, S.stepsFailed));
    } finally {
      setPlanBusy(false);
    }
  };

  return (
    <div className="stack">
      <section className="ws-section devices-flat" aria-labelledby="power-h">
        <h2 id="power-h">{S.title}</h2>
        {blocked && !revoked ? <Unavailable>{S.lastReported({ why: blocked })}</Unavailable> : null}
        {power.error ? (
          <LoadError error={power.error} fallback={S.readFailed} onRetry={power.reload} />
        ) : null}
        {power.loading ? <Spinner label={S.reading} /> : null}
        <dl className="devices-facts">
          <div>
            <dt>{S.wol}</dt>
            <dd>{wakeable ? S.on : S.offOrUnsupported}</dd>
          </div>
          <div>
            <dt>{S.addresses}</dt>
            <dd dir="ltr">{macs.length ? listText(macs) : S.noneReported}</dd>
          </div>
          {power.data ? (
            <>
              <div>
                <dt>{S.mains}</dt>
                <dd>{yesNo(p.ac)}</dd>
              </div>
              <div>
                <dt>{S.afterCut}</dt>
                <dd>
                  {typeof p.afterPowerLoss === 'string'
                    ? (messageFor(S.afterLoss, p.afterPowerLoss) ?? p.afterPowerLoss)
                    : S.unknown}
                </dd>
              </div>
            </>
          ) : null}
        </dl>
        <p className="muted ws-flush">
          {rich(S.firmware, {
            link: (
              <a
                href={firmwareTabPath(device.id)}
                onClick={(e) => followLink(e, firmwareTabPath(device.id))}
              >
                {S.firmwareLink}
              </a>
            ),
          })}
        </p>
      </section>

      <section className="ws-section devices-flat" aria-labelledby="wake-h">
        <h2 id="wake-h">{S.wake}</h2>
        {revoked ? (
          <p className="muted ws-flush">{S.revoked}</p>
        ) : wakeable ? (
          <>
            <p className="muted ws-flush">
              {S.wakeHow} {device.status === 'active' ? `${S.onlineNow} ` : ''}
              {/* The count is a plural argument, so it goes in directly; only the link is rich. */}
              {rich((v: { link: string }) => S.wakeLimit({ n: limit, link: v.link }), {
                link: (
                  <a href="/settings/devices" onClick={(e) => followLink(e, '/settings/devices')}>
                    {S.limitLink}
                  </a>
                ),
              })}
            </p>
            <div className="row">
              <Button variant="primary" onClick={() => void wake()} disabled={waking}>
                {waking ? <Spinner /> : null} {S.wakeDevice({ name: device.name })}
              </Button>
            </div>
            <p className="muted ws-flush">
              {rich(S.noHelper, {
                link: (
                  <a
                    href={addDevicePath('wake-helper')}
                    onClick={(e) => followLink(e, addDevicePath('wake-helper'))}
                  >
                    {S.addHelper}
                  </a>
                ),
              })}
            </p>
          </>
        ) : (
          <p className="muted ws-flush">{S.notWakeable}</p>
        )}
        {!revoked && !blocked ? (
          <div className="stack devices-wol">
            <h3>{S.turnOn}</h3>
            <p className="muted ws-flush">{S.stepsFirst}</p>
            <div className="row">
              <Button onClick={() => void showPlan()} disabled={planBusy}>
                {planBusy ? <Spinner /> : null} {S.showSteps}
              </Button>
              {plan ? <Button onClick={() => setEnabling(true)}>{S.apply}</Button> : null}
            </div>
            {planError ? (
              <p role="alert" className="nv-field-error">
                {planError}
              </p>
            ) : null}
            {plan ? (
              <div aria-live="polite">
                {plan.steps.length ? (
                  <pre role="group" className="ws-command" aria-label={S.steps} dir="ltr">
                    {plan.steps.join('\n')}
                  </pre>
                ) : (
                  <p className="ws-flush">{S.alreadyOn}</p>
                )}
                {plan.elevation ? <p className="muted ws-flush">{S.elevation}</p> : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </section>

      <section className="ws-section devices-flat" aria-labelledby="power-actions-h">
        <h2 id="power-actions-h">{S.powerActions}</h2>
        {blocked ? <Unavailable>{blocked}</Unavailable> : null}
        <div className="row">
          {(['sleep', 'restart', 'shutdown'] as const).map((a) => (
            <Button key={a} disabled={Boolean(blocked)} onClick={() => setAsking(a)}>
              {S.actions[a].label}
            </Button>
          ))}
        </div>
      </section>

      <ConfirmDialog
        open={enabling}
        title={S.enableTitle}
        description={S.enableBody}
        confirmLabel={S.enableConfirm}
        onClose={() => setEnabling(false)}
        onConfirm={async () => {
          const r = await api.devicePowerAction(device.id, { action: 'wol-enable', apply: true });
          setEnabling(false);
          if (r.applied === true) {
            toast.show(S.enabled, { tone: 'success' });
            power.reload();
          } else {
            toast.show(S.notApplied, { tone: 'error' });
          }
        }}
      />
      <ConfirmDialog
        open={asking !== null}
        title={asking ? S.actions[asking].title : ''}
        description={asking ? S.actions[asking].description : undefined}
        confirmLabel={asking ? S.actions[asking].label : S.confirm}
        danger
        onClose={() => setAsking(null)}
        onConfirm={async () => {
          const a = asking;
          if (!a) return;
          await api.devicePowerAction(device.id, { action: a });
          setAsking(null);
          toast.show(S.sent({ action: a, device: device.name }), { tone: 'success' });
        }}
      />
    </div>
  );
}
