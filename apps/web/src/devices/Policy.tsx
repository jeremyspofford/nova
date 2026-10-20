// Per-device policy (FR-150): whether agents and models may be routed to the device, which
// modules it may run, quiet hours when background work waits, and resource caps for its modules.
// The Hub applies it at once and the device takes it when it next checks in; "On the device"
// (M7.5, ops.tsx) says whether it has, shows what is in force there, and pushes it now.
import { useId, useState } from 'react';
import {
  DEVICE_MODULES,
  devicePolicySchema,
  type DeviceModuleName,
  type DevicePolicy,
  type DeviceView,
} from '@nova/shared';
import { Button, TextField, useToast } from '@nova/ui';
import { defineMessages } from '@nova/i18n';
import { SwitchField } from '../settings/controls.tsx';
import { useDevicesApi } from './api.ts';
import type { PanelProps } from './DevicePage.tsx';
import { MODULE_PURPOSE, deviceErrorMessage, moduleLabel, parseQuietHours } from './format.ts';
import { OverridesSection } from './ops.tsx';

/** The Policy tab's words (FR-016). */
export const POLICY_TEXT = defineMessages('devices.policy', {
  badRange: '“{text}” is not a time range like 22:00-07:00.',
  wholeRange: 'Enter a whole number from {min} to {max}.',
  invalid: 'Invalid',
  saved: 'Policy saved.',
  savedPending: 'Policy saved. The device takes it when it next checks in.',
  saveFailed: 'Could not save the policy.',
  form: 'Device policy',
  routing: 'Routing',
  routingLabel: 'Use this device for agent work and models',
  routingHelp:
    'Off keeps it out of routing: agents cannot use it as their computer and its models are not offered.',
  modules: 'Allowed modules',
  everyModule: 'Every module installed on the device',
  noManagement:
    "Without the management module, the Hub cannot manage this device's modules, power or updates.",
  quiet: 'Quiet hours',
  quietHelp:
    "Background work for this device waits during these times, in the device's time zone. Like 22:00-07:00; separate several with commas.",
  limits: 'Resource limits',
  limitsIntro: 'For each module novad runs. Leave blank for no limit.',
  memory: 'Memory (MB)',
  cpu: 'CPU time (seconds)',
  openFiles: 'Open files',
  revoked: 'This device was revoked.',
  save: 'Save policy',
  discard: 'Discard changes',
});

const S = POLICY_TEXT;

const MIB = 1024 * 1024;

interface Draft {
  routingEligible: boolean;
  /** null: every installed module. */
  allowedModules: DeviceModuleName[] | null;
  quietHours: string;
  memoryMiB: string;
  cpuSeconds: string;
  openFiles: string;
}

export function policyDraft(p: DevicePolicy): Draft {
  const caps = p.resourceCaps ?? {};
  return {
    routingEligible: p.routingEligible !== false,
    allowedModules: p.allowedModules ?? null,
    quietHours: (p.quietHours ?? []).join(', '),
    memoryMiB: caps.memoryBytes ? String(Math.round(caps.memoryBytes / MIB)) : '',
    cpuSeconds: caps.cpuSeconds ? String(caps.cpuSeconds) : '',
    openFiles: caps.openFiles ? String(caps.openFiles) : '',
  };
}

/** The policy a draft stands for, or the problem with each bad field. */
export function policyFrom(
  d: Draft,
): { ok: true; value: DevicePolicy } | { ok: false; errors: Partial<Record<keyof Draft, string>> } {
  const errors: Partial<Record<keyof Draft, string>> = {};
  const q = parseQuietHours(d.quietHours);
  if ('bad' in q) errors.quietHours = S.badRange({ text: q.bad });
  const caps: Record<string, number> = {};
  const num = (key: 'memoryMiB' | 'cpuSeconds' | 'openFiles', min: number, max: number) => {
    const t = d[key].trim();
    if (!t) return;
    const n = Number(t);
    if (!Number.isInteger(n) || n < min || n > max) errors[key] = S.wholeRange({ min, max });
    else if (key === 'memoryMiB') caps.memoryBytes = n * MIB;
    else caps[key] = n;
  };
  num('memoryMiB', 64, 1_048_576);
  num('cpuSeconds', 1, 31_536_000);
  num('openFiles', 16, 1_048_576);
  if (Object.keys(errors).length) return { ok: false, errors };
  const parsed = devicePolicySchema.safeParse({
    routingEligible: d.routingEligible,
    allowedModules: d.allowedModules,
    quietHours: 'ranges' in q ? q.ranges : [],
    resourceCaps: caps,
  });
  if (!parsed.success)
    return { ok: false, errors: { quietHours: parsed.error.issues[0]?.message ?? S.invalid } };
  return { ok: true, value: parsed.data };
}

export function PolicyPanel({ device, onDevice }: PanelProps) {
  return (
    <div className="stack devices-policy">
      <PolicyForm key={JSON.stringify(device.policy)} device={device} onDevice={onDevice} />
      <OverridesSection device={device} />
    </div>
  );
}

function PolicyForm({
  device,
  onDevice,
}: {
  device: DeviceView;
  onDevice: (d: DeviceView) => void;
}) {
  const api = useDevicesApi();
  const toast = useToast();
  const base = useId();
  const initial = policyDraft(device.policy);
  const [draft, setDraft] = useState<Draft>(initial);
  const [errors, setErrors] = useState<Partial<Record<keyof Draft, string>>>({});
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const revoked = device.status === 'revoked';
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const allowed = draft.allowedModules;

  const save = async () => {
    const r = policyFrom(draft);
    if (!r.ok) {
      setErrors(r.errors);
      return;
    }
    setErrors({});
    setBusy(true);
    setSaveError(null);
    try {
      const next = await api.updateNovadDevice(device.id, { policy: r.value });
      toast.show(next.configPending ? S.savedPending : S.saved, { tone: 'success' });
      onDevice(next);
    } catch (err) {
      setSaveError(deviceErrorMessage(err, S.saveFailed));
      setBusy(false);
    }
  };

  return (
    <form
      className="stack"
      aria-label={S.form}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <section className="ws-section devices-flat" aria-labelledby={`${base}-route`}>
        <h2 id={`${base}-route`}>{S.routing}</h2>
        <SwitchField
          label={S.routingLabel}
          description={S.routingHelp}
          checked={draft.routingEligible}
          disabled={revoked}
          onChange={(v) => set({ routingEligible: v })}
        />
      </section>

      <section className="ws-section devices-flat" aria-labelledby={`${base}-mods`}>
        <h2 id={`${base}-mods`}>{S.modules}</h2>
        <fieldset className="nv-radios" disabled={revoked}>
          <legend className="nv-vh">{S.modules}</legend>
          <label className="nv-radio">
            <input
              type="checkbox"
              checked={allowed === null}
              onChange={(e) =>
                set({
                  allowedModules: e.target.checked
                    ? null
                    : DEVICE_MODULES.filter((m) => device.modules.some((x) => x.name === m)),
                })
              }
            />
            <span className="nv-radio-text">
              <span>{S.everyModule}</span>
            </span>
          </label>
          {allowed !== null
            ? DEVICE_MODULES.map((m) => (
                <label key={m} className="nv-radio devices-indent">
                  <input
                    type="checkbox"
                    checked={allowed.includes(m)}
                    aria-labelledby={`${base}-m-${m}-label`}
                    aria-describedby={`${base}-m-${m}`}
                    onChange={(e) =>
                      set({
                        allowedModules: e.target.checked
                          ? [...allowed, m]
                          : allowed.filter((x) => x !== m),
                      })
                    }
                  />
                  <span className="nv-radio-text">
                    <span id={`${base}-m-${m}-label`}>{moduleLabel(m)}</span>
                    <span id={`${base}-m-${m}`} className="nv-field-hint">
                      {MODULE_PURPOSE[m]}
                    </span>
                  </span>
                </label>
              ))
            : null}
        </fieldset>
        {allowed !== null && !allowed.includes('management') ? (
          <p className="ws-warning">{S.noManagement}</p>
        ) : null}
      </section>

      <section className="ws-section devices-flat" aria-labelledby={`${base}-quiet`}>
        <h2 id={`${base}-quiet`}>{S.quiet}</h2>
        <TextField
          label={S.quiet}
          value={draft.quietHours}
          disabled={revoked}
          placeholder="22:00-07:00"
          dir="ltr"
          hint={S.quietHelp}
          error={errors.quietHours}
          onChange={(e) => set({ quietHours: e.target.value })}
        />
      </section>

      <section className="ws-section devices-flat" aria-labelledby={`${base}-caps`}>
        <h2 id={`${base}-caps`}>{S.limits}</h2>
        <p className="muted ws-flush">{S.limitsIntro}</p>
        <div className="devices-fields">
          <TextField
            label={S.memory}
            value={draft.memoryMiB}
            inputMode="numeric"
            className="ws-number"
            disabled={revoked}
            error={errors.memoryMiB}
            onChange={(e) => set({ memoryMiB: e.target.value })}
          />
          <TextField
            label={S.cpu}
            value={draft.cpuSeconds}
            inputMode="numeric"
            className="ws-number"
            disabled={revoked}
            error={errors.cpuSeconds}
            onChange={(e) => set({ cpuSeconds: e.target.value })}
          />
          <TextField
            label={S.openFiles}
            value={draft.openFiles}
            inputMode="numeric"
            className="ws-number"
            disabled={revoked}
            error={errors.openFiles}
            onChange={(e) => set({ openFiles: e.target.value })}
          />
        </div>
      </section>

      {saveError ? (
        <p role="alert" className="nv-field-error">
          {saveError}
        </p>
      ) : null}
      {revoked ? <p className="muted ws-flush">{S.revoked}</p> : null}
      <div className="row">
        <Button type="submit" variant="primary" disabled={!dirty || busy || revoked}>
          {S.save}
        </Button>
        <Button
          disabled={!dirty || busy}
          onClick={() => {
            setDraft(initial);
            setErrors({});
          }}
        >
          {S.discard}
        </Button>
      </div>
    </form>
  );
}
