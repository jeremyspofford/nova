// Settings → Devices → "Firmware and boot" (FR-146, FR-143; docs/14, docs/23 §5.2, §6; ADR-096
// D3): the Hub-wide switches for changes below the operating system, all off by default and
// owner-only. Turning a dangerous one on asks first and says what it allows: the firmware toggles
// go through `PUT /api/v1/devices/firmware/policy` and low-level boot and network boot through the
// settings store (`PATCH /api/v1/settings`), each with `{confirm: true}` after its dialog: the Hub
// refuses turning any of them on without it. Turning any off never asks. Managed policy can lock
// each one.
import { useId, useState, type ReactNode } from 'react';
import type { FirmwarePolicyView, SettingKey } from '@nova/shared';
import { defineMessages } from '@nova/i18n';
import { SelectField, Spinner, useToast } from '@nova/ui';
import { watchdogOptions } from '../boot/format.ts';
import { ConfirmDialog, LoadError, useLoad } from '../devices/parts.tsx';
import { useHubStream } from '../hub-events.ts';
import { useAnnounce } from '../services.tsx';
import { SwitchField } from '../settings/controls.tsx';
import { useSettings } from '../settings.tsx';
import { MemberGate } from '../team/role.tsx';
import { useFirmwareApi } from './api-m75.ts';
import { FIRMWARE_SETTINGS_ANCHOR, firmwareErrorMessage, inPlainWords } from './format.ts';
import './firmware.css';

type Consent = {
  key:
    | 'devices.firmware.allowChanges'
    | 'devices.firmware.allowSecurityDegrading'
    | 'devices.boot.allowLowLevel'
    | 'devices.pxe.enabled';
  title: string;
  body: ReactNode;
  confirm: string;
};

export const FIRMWARE_SETTINGS_TEXT = defineMessages('firmware.settings', {
  /** What the owner-only notice names. */
  ownerOnlyWhat: 'Firmware and boot',
  title: 'Firmware and boot',
  intro:
    'Changes below the operating system of devices running novad. All are off by default, apply to the whole Hub and are recorded in the audit log. Nova never makes these changes by itself.',
  readFailed: 'Could not read the firmware switches.',
  reading: 'Reading the firmware switches',
  labels: {
    allowChanges: 'Allow BIOS/firmware changes',
    allowSecurityDegrading: 'Allow changes that weaken security',
    allowLowLevel: 'Allow low-level boot changes',
    pxe: 'Network boot (PXE)',
  },
  /** Announced after a switch changes; `label` is one of the labels above. */
  switched: '{label}: {state, select, on {on} other {off}}.',
  watchdogSaved: '{what, select, firmware {Firmware watchdog saved.} other {Boot watchdog saved.}}',
  watchdogFailed: 'Could not save the watchdog.',
  offFailed: 'Could not turn it off.',
  states: {
    allowChangesOn:
      'On: you can plan firmware changes on supported devices; each needs your approval and can be rolled back.',
    allowChangesOff: 'Off: devices refuse firmware changes. Reading their settings still works.',
    allowSecurityDegradingOn:
      'On: a firmware change may turn Secure Boot or the TPM off, after your approval.',
    allowSecurityDegradingOff:
      'Off: changes that turn Secure Boot or the TPM off are refused, even when approved.',
    allowLowLevelOn:
      'On: you can try a boot profile once on a device and make a confirmed one the default, each after your approval.',
    allowLowLevelOff:
      'Off: devices refuse boot trials and new defaults. Clearing a pending one-shot always works.',
    pxeOn: 'On: the Hub serves the iPXE menu and its boot images to devices holding a boot token.',
    pxeOff: 'Off: the network boot addresses answer “not found”.',
  },
  firmwareWatchdog: 'Firmware watchdog',
  firmwareWatchdogHint:
    'For firmware changes applied with a restart: how long the device has to come back before its watchdog restores the previous settings.',
  bootWatchdog: 'Boot watchdog',
  bootWatchdogHint:
    'How long a device has to come back on an entry it tries before it returns to its default entry. The Hub reports the trial failed 2 minutes later.',
  turnOn: 'Turn on',
  /** What each switch allows, shown before it turns on: what, then why it is off by default. */
  consent: {
    allowChanges: {
      title: 'Allow BIOS and firmware changes on devices?',
      what: 'You can then change Wake-on-LAN, what happens after a power cut, boot order, virtualization, Secure Boot, the TPM and the fan profile on supported devices running novad.',
      why: 'It is off by default because a wrong firmware setting can keep a machine from starting. Every change is still a dry run first, shows exactly what changes, keeps a snapshot, needs your approval here in Nova, and can be rolled back. Nova never changes firmware by itself, and every change is in the audit log.',
      confirm: 'Allow firmware changes',
    },
    allowSecurityDegrading: {
      title: 'Allow firmware changes that weaken security?',
      what: 'This lets a firmware change turn Secure Boot or the TPM off. Without it, such changes are refused even when you approve them.',
      why: 'Leave it off unless a machine needs one of these off. Each such change still needs its own approval, and its diff marks what weakens security.',
      confirm: 'Allow these changes',
    },
    allowLowLevel: {
      title: 'Allow low-level boot changes on devices?',
      what: 'You can then boot a device once into another bootloader entry, with a watchdog that sends it back to its default entry if it does not come back, and make a confirmed entry the default.',
      why: 'It is off by default because a machine booted into a broken entry can stay unreachable until someone is in front of it. Each change needs your approval here in Nova.',
      confirm: 'Allow boot changes',
    },
    pxe: {
      title: 'Serve network boot from this Hub?',
      what: 'The Hub then serves an iPXE menu and the files in its boot-images folder to any machine that presents a device’s boot token, without signing in. Each fetch is rate-limited and recorded in the audit log.',
      why: 'It is off by default because those images are readable by anyone holding a token. Nova runs no DHCP or TFTP server: you point your own DHCP server at the iPXE address.',
      confirm: 'Turn on network boot',
    },
  },
});

const S = FIRMWARE_SETTINGS_TEXT;

/** Each switch's short name in the messages above. */
const SWITCH_ID = {
  'devices.firmware.allowChanges': 'allowChanges',
  'devices.firmware.allowSecurityDegrading': 'allowSecurityDegrading',
  'devices.boot.allowLowLevel': 'allowLowLevel',
  'devices.pxe.enabled': 'pxe',
} as const satisfies Record<Consent['key'], keyof typeof S.labels>;

/** A switch's words, read in the active locale when shown. */
function consentFor(key: Consent['key']): Omit<Consent, 'key'> {
  const words = () => S.consent[SWITCH_ID[key]];
  return {
    get title() {
      return words().title;
    },
    get body() {
      return (
        <>
          <p>{words().what}</p>
          <p>{words().why}</p>
        </>
      );
    },
    get confirm() {
      return words().confirm;
    },
  };
}

/** What each switch allows, shown before it turns on (docs/04 §7: what and why, first). */
export const CONSENT: Record<Consent['key'], Omit<Consent, 'key'>> = {
  'devices.firmware.allowChanges': consentFor('devices.firmware.allowChanges'),
  'devices.firmware.allowSecurityDegrading': consentFor('devices.firmware.allowSecurityDegrading'),
  'devices.boot.allowLowLevel': consentFor('devices.boot.allowLowLevel'),
  'devices.pxe.enabled': consentFor('devices.pxe.enabled'),
};

/** A switch's label. */
function label(key: Consent['key']): string {
  return S.labels[SWITCH_ID[key]];
}

export function FirmwareBootSettings() {
  return (
    <MemberGate ownerOnly what={S.ownerOnlyWhat}>
      <FirmwareBootBody />
    </MemberGate>
  );
}

function FirmwareBootBody() {
  const api = useFirmwareApi();
  const settings = useSettings();
  const toast = useToast();
  const announce = useAnnounce();
  const headingId = useId();
  const policy = useLoad<FirmwarePolicyView>(() => api.getFirmwarePolicy(), 'firmware-policy');
  const [asking, setAsking] = useState<Consent['key'] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useHubStream(['settings.changed'], (env) => {
    const key = typeof env.payload.key === 'string' ? env.payload.key : '';
    if (key.startsWith('devices.firmware.')) policy.reload();
  });

  const lowLevel = settings.get('devices.boot.allowLowLevel');
  const watchdog = settings.get('devices.boot.watchdogSeconds');
  const fwWatchdog = settings.get('devices.firmware.watchdogSeconds');
  const pxe = settings.get('devices.pxe.enabled');
  const fwLock = settings.get('devices.firmware.allowChanges').locked;
  const sdLock = settings.get('devices.firmware.allowSecurityDegrading').locked;

  /** Write one switch; `confirmed` only after its dialog. */
  const write = async (key: Consent['key'], on: boolean, confirmed: boolean) => {
    if (
      key === 'devices.firmware.allowChanges' ||
      key === 'devices.firmware.allowSecurityDegrading'
    ) {
      const field =
        key === 'devices.firmware.allowChanges' ? 'allowChanges' : 'allowSecurityDegrading';
      const view = await api.setFirmwarePolicy({
        [field]: on,
        ...(on && confirmed ? { confirm: true } : {}),
      });
      policy.setData(() => view);
    } else {
      await settings.set(key, on, on && confirmed ? { confirm: true } : {});
    }
    announce(S.switched({ label: label(key), state: on ? 'on' : 'off' }));
  };

  const saveWatchdog = (
    key: 'devices.firmware.watchdogSeconds' | 'devices.boot.watchdogSeconds',
    seconds: number,
    what: 'firmware' | 'boot',
  ) => {
    setBusy(key);
    settings
      .set(key, seconds)
      .then(() => announce(S.watchdogSaved({ what })))
      .catch((err: unknown) =>
        toast.show(firmwareErrorMessage(err, S.watchdogFailed), { tone: 'error' }),
      )
      .finally(() => setBusy(null));
  };

  const flip = (key: Consent['key'], next: boolean) => {
    if (next) {
      setAsking(key);
      return;
    }
    setBusy(key);
    write(key, false, false)
      .catch((err: unknown) =>
        toast.show(firmwareErrorMessage(err, S.offFailed), { tone: 'error' }),
      )
      .finally(() => setBusy(null));
  };

  const consent = asking ? CONSENT[asking] : null;
  const p = policy.data;

  return (
    <section
      className="ws-section"
      aria-labelledby={headingId}
      id={FIRMWARE_SETTINGS_ANCHOR}
      data-anchor={FIRMWARE_SETTINGS_ANCHOR}
    >
      <h2 id={headingId}>{S.title}</h2>
      <p className="muted ws-flush">{S.intro}</p>
      {policy.error ? (
        <LoadError error={policy.error} fallback={S.readFailed} onRetry={policy.reload} />
      ) : null}
      {policy.loading ? <Spinner label={S.reading} /> : null}
      {p ? (
        <>
          <SwitchField
            label={label('devices.firmware.allowChanges')}
            description={p.allowChanges ? S.states.allowChangesOn : S.states.allowChangesOff}
            checked={p.allowChanges}
            locked={fwLock}
            disabled={busy !== null}
            onChange={(next) => flip('devices.firmware.allowChanges', next)}
          />
          <SwitchField
            label={label('devices.firmware.allowSecurityDegrading')}
            description={
              p.allowSecurityDegrading
                ? S.states.allowSecurityDegradingOn
                : S.states.allowSecurityDegradingOff
            }
            checked={p.allowSecurityDegrading}
            locked={sdLock}
            disabled={busy !== null}
            onChange={(next) => flip('devices.firmware.allowSecurityDegrading', next)}
          />
        </>
      ) : null}
      <SwitchField
        label={label('devices.boot.allowLowLevel')}
        description={lowLevel.value ? S.states.allowLowLevelOn : S.states.allowLowLevelOff}
        checked={lowLevel.value}
        locked={lowLevel.locked}
        disabled={busy !== null}
        onChange={(next) => flip('devices.boot.allowLowLevel', next)}
      />
      <SelectField
        className="devices-narrow"
        label={S.firmwareWatchdog}
        value={String(fwWatchdog.value)}
        locked={fwWatchdog.locked}
        options={watchdogOptions(fwWatchdog.value)}
        hint={S.firmwareWatchdogHint}
        onChange={(v) => saveWatchdog('devices.firmware.watchdogSeconds', Number(v), 'firmware')}
      />
      <SelectField
        className="devices-narrow"
        label={S.bootWatchdog}
        value={String(watchdog.value)}
        locked={watchdog.locked}
        options={watchdogOptions(watchdog.value)}
        hint={S.bootWatchdogHint}
        onChange={(v) => saveWatchdog('devices.boot.watchdogSeconds', Number(v), 'boot')}
      />
      <SwitchField
        label={label('devices.pxe.enabled')}
        description={pxe.value ? S.states.pxeOn : S.states.pxeOff}
        checked={pxe.value}
        locked={pxe.locked}
        disabled={busy !== null}
        onChange={(next) => flip('devices.pxe.enabled', next)}
      />
      <ConfirmDialog
        open={consent !== null}
        title={consent?.title ?? ''}
        description={consent?.body}
        confirmLabel={consent?.confirm ?? S.turnOn}
        danger
        onClose={() => setAsking(null)}
        onConfirm={async () => {
          if (!asking) return;
          await inPlainWords(write(asking, true, true));
          setAsking(null);
        }}
      />
    </section>
  );
}

/** The keys this section owns (for the settings search and tests). */
export const FIRMWARE_BOOT_SETTING_KEYS: readonly SettingKey[] = [
  'devices.firmware.allowChanges',
  'devices.firmware.allowSecurityDegrading',
  'devices.firmware.watchdogSeconds',
  'devices.boot.allowLowLevel',
  'devices.boot.watchdogSeconds',
  'devices.pxe.enabled',
];
