// Power and Wake-on-LAN (FR-144, FR-138; docs/23 §5.3, docs/22 §7): the device's power state as
// it reports it, Wake for a device that reports Wake-on-LAN (sent through a Wake helper on its
// network, or by the Hub when it is on that network; rate-limited by `devices.wakesPerHour`), the
// steps to turn Wake-on-LAN on (shown first; applied only when the user asks, and novad may need
// elevation), and Sleep, Restart and Shut down, each confirmed first.
import { useState } from 'react';
import { Button, Spinner, useToast } from '@nova/ui';
import { useSetting } from '../settings.tsx';
import { plural } from '../settings/common.ts';
import { followLink } from '../work/nav.tsx';
import { useDevicesApi, type DevicePowerResult } from './api.ts';
import type { PanelProps } from './DevicePage.tsx';
import { addDevicePath, capabilityBlocked, deviceErrorMessage, wakeSentText } from './format.ts';
import { ConfirmDialog, LoadError, Unavailable, useLoad } from './parts.tsx';

type PowerAction = 'sleep' | 'restart' | 'shutdown';

const POWER_TEXT: Record<PowerAction, { label: string; title: string; description: string }> = {
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
};

const AFTER_LOSS: Record<string, string> = {
  on: 'Turns back on',
  off: 'Stays off',
  last: 'Returns to its last state',
  unknown: 'Unknown',
};

/** One planned step as text: a command's arguments, or the step's own words. */
export function planStepText(step: unknown): string {
  if (typeof step === 'string') return step;
  if (typeof step !== 'object' || step === null) return '';
  const s = step as Record<string, unknown>;
  if (Array.isArray(s.argv)) return s.argv.map(String).join(' ');
  if (typeof s.description === 'string') return s.description;
  return JSON.stringify(step);
}

const yesNo = (v: unknown) => (v === true ? 'Yes' : v === false ? 'No' : 'Unknown');

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
      toast.show(deviceErrorMessage(err, 'Could not send the wake signal.'), { tone: 'error' });
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
      setPlanError(deviceErrorMessage(err, 'Could not get the steps.'));
    } finally {
      setPlanBusy(false);
    }
  };

  return (
    <div className="stack">
      <section className="ws-section devices-flat" aria-labelledby="power-h">
        <h2 id="power-h">Power</h2>
        {blocked && !revoked ? (
          <Unavailable>{blocked} Showing what it last reported.</Unavailable>
        ) : null}
        {power.error ? (
          <LoadError
            error={power.error}
            fallback="Could not read the power state."
            onRetry={power.reload}
          />
        ) : null}
        {power.loading ? <Spinner label="Reading the power state" /> : null}
        <dl className="devices-facts">
          <div>
            <dt>Wake-on-LAN</dt>
            <dd>{wakeable ? 'On' : 'Off or not supported'}</dd>
          </div>
          <div>
            <dt>Network addresses</dt>
            <dd>{macs.length ? macs.join(', ') : 'None reported'}</dd>
          </div>
          {power.data ? (
            <>
              <div>
                <dt>On mains power</dt>
                <dd>{yesNo(p.ac)}</dd>
              </div>
              <div>
                <dt>After a power cut</dt>
                <dd>
                  {typeof p.afterPowerLoss === 'string'
                    ? (AFTER_LOSS[p.afterPowerLoss] ?? p.afterPowerLoss)
                    : 'Unknown'}
                </dd>
              </div>
            </>
          ) : null}
        </dl>
        <p className="muted ws-flush">
          Changing what happens after a power cut needs firmware settings, which this version cannot
          change.
        </p>
      </section>

      <section className="ws-section devices-flat" aria-labelledby="wake-h">
        <h2 id="wake-h">Wake</h2>
        {revoked ? (
          <p className="muted ws-flush">This device was revoked.</p>
        ) : wakeable ? (
          <>
            <p className="muted ws-flush">
              Sends a Wake-on-LAN signal through a Wake helper on the device&apos;s network, or from
              the Hub when it is on that network.
              {device.status === 'active' ? ' The device is online now.' : ''} At most{' '}
              {plural(limit, 'wake')} an hour for a device;{' '}
              <a href="/settings/devices" onClick={(e) => followLink(e, '/settings/devices')}>
                change the limit in Settings
              </a>
              .
            </p>
            <div className="row">
              <Button variant="primary" onClick={() => void wake()} disabled={waking}>
                {waking ? <Spinner /> : null} Wake {device.name}
              </Button>
            </div>
            <p className="muted ws-flush">
              No Wake helper on its network yet?{' '}
              <a
                href={addDevicePath('wake-helper')}
                onClick={(e) => followLink(e, addDevicePath('wake-helper'))}
              >
                Add one
              </a>
              : an always-on device there, such as a NAS or a mini PC.
            </p>
          </>
        ) : (
          <p className="muted ws-flush">
            This device does not report Wake-on-LAN, so it cannot be woken from here.
          </p>
        )}
        {!revoked && !blocked ? (
          <div className="stack devices-wol">
            <h3>Turn on Wake-on-LAN</h3>
            <p className="muted ws-flush">
              See the steps first. novad applies them only when you ask, and some need it to run
              with elevated rights.
            </p>
            <div className="row">
              <Button onClick={() => void showPlan()} disabled={planBusy}>
                {planBusy ? <Spinner /> : null} Show the steps
              </Button>
              {plan ? <Button onClick={() => setEnabling(true)}>Apply on the device</Button> : null}
            </div>
            {planError ? (
              <p role="alert" className="nv-field-error">
                {planError}
              </p>
            ) : null}
            {plan ? (
              <div aria-live="polite">
                {plan.steps.length ? (
                  <pre className="ws-command" aria-label="Steps">
                    {plan.steps.join('\n')}
                  </pre>
                ) : (
                  <p className="ws-flush">Nothing to change: Wake-on-LAN is already on.</p>
                )}
                {plan.elevation ? (
                  <p className="muted ws-flush">These steps need administrator rights.</p>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </section>

      <section className="ws-section devices-flat" aria-labelledby="power-actions-h">
        <h2 id="power-actions-h">Sleep, restart or shut down</h2>
        {blocked ? <Unavailable>{blocked}</Unavailable> : null}
        <div className="row">
          {(['sleep', 'restart', 'shutdown'] as const).map((a) => (
            <Button key={a} disabled={Boolean(blocked)} onClick={() => setAsking(a)}>
              {POWER_TEXT[a].label}
            </Button>
          ))}
        </div>
      </section>

      <ConfirmDialog
        open={enabling}
        title="Turn on Wake-on-LAN?"
        description="novad runs the steps shown on the device."
        confirmLabel="Apply"
        onClose={() => setEnabling(false)}
        onConfirm={async () => {
          const r = await api.devicePowerAction(device.id, { action: 'wol-enable', apply: true });
          setEnabling(false);
          if (r.applied === true) {
            toast.show('Wake-on-LAN is on.', { tone: 'success' });
            power.reload();
          } else {
            toast.show('The device did not apply the steps. Run them on the device yourself.', {
              tone: 'error',
            });
          }
        }}
      />
      <ConfirmDialog
        open={asking !== null}
        title={asking ? POWER_TEXT[asking].title : ''}
        description={asking ? POWER_TEXT[asking].description : undefined}
        confirmLabel={asking ? POWER_TEXT[asking].label : 'Confirm'}
        danger
        onClose={() => setAsking(null)}
        onConfirm={async () => {
          const a = asking;
          if (!a) return;
          await api.devicePowerAction(device.id, { action: a });
          setAsking(null);
          toast.show(`${POWER_TEXT[a].label}: sent to ${device.name}.`, { tone: 'success' });
        }}
      />
    </div>
  );
}
