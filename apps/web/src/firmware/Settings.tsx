// Settings → Devices → "Firmware and boot" (FR-146, FR-143; docs/14, docs/23 §5.2, §6; ADR-096
// D3): the Hub-wide switches for changes below the operating system, all off by default and
// owner-only. Turning a dangerous one on asks first and says what it allows: the firmware toggles
// go through `PUT /api/v1/devices/firmware/policy` and low-level boot and network boot through the
// settings store (`PATCH /api/v1/settings`), each with `{confirm: true}` after its dialog: the Hub
// refuses turning any of them on without it. Turning any off never asks. Managed policy can lock
// each one.
import { useId, useState, type ReactNode } from 'react';
import type { FirmwarePolicyView, SettingKey } from '@nova/shared';
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

/** What each switch allows, shown before it turns on (docs/04 §7: what and why, first). */
export const CONSENT: Record<Consent['key'], Omit<Consent, 'key'>> = {
  'devices.firmware.allowChanges': {
    title: 'Allow BIOS and firmware changes on devices?',
    body: (
      <>
        <p>
          You can then change Wake-on-LAN, what happens after a power cut, boot order,
          virtualization, Secure Boot, the TPM and the fan profile on supported devices running
          novad.
        </p>
        <p>
          It is off by default because a wrong firmware setting can keep a machine from starting.
          Every change is still a dry run first, shows exactly what changes, keeps a snapshot, needs
          your approval here in Nova, and can be rolled back. Nova never changes firmware by itself,
          and every change is in the audit log.
        </p>
      </>
    ),
    confirm: 'Allow firmware changes',
  },
  'devices.firmware.allowSecurityDegrading': {
    title: 'Allow firmware changes that weaken security?',
    body: (
      <>
        <p>
          This lets a firmware change turn Secure Boot or the TPM off. Without it, such changes are
          refused even when you approve them.
        </p>
        <p>
          Leave it off unless a machine needs one of these off. Each such change still needs its own
          approval, and its diff marks what weakens security.
        </p>
      </>
    ),
    confirm: 'Allow these changes',
  },
  'devices.boot.allowLowLevel': {
    title: 'Allow low-level boot changes on devices?',
    body: (
      <>
        <p>
          You can then boot a device once into another bootloader entry, with a watchdog that sends
          it back to its default entry if it does not come back, and make a confirmed entry the
          default.
        </p>
        <p>
          It is off by default because a machine booted into a broken entry can stay unreachable
          until someone is in front of it. Each change needs your approval here in Nova.
        </p>
      </>
    ),
    confirm: 'Allow boot changes',
  },
  'devices.pxe.enabled': {
    title: 'Serve network boot from this Hub?',
    body: (
      <>
        <p>
          The Hub then serves an iPXE menu and the files in its boot-images folder to any machine
          that presents a device’s boot token, without signing in. Each fetch is rate-limited and
          recorded in the audit log.
        </p>
        <p>
          It is off by default because those images are readable by anyone holding a token. Nova
          runs no DHCP or TFTP server: you point your own DHCP server at the iPXE address.
        </p>
      </>
    ),
    confirm: 'Turn on network boot',
  },
};

export function FirmwareBootSettings() {
  return (
    <MemberGate ownerOnly what="Firmware and boot">
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
    announce(`${LABEL[key]}: ${on ? 'on' : 'off'}.`);
  };

  const saveWatchdog = (
    key: 'devices.firmware.watchdogSeconds' | 'devices.boot.watchdogSeconds',
    seconds: number,
    what: 'Firmware' | 'Boot',
  ) => {
    setBusy(key);
    settings
      .set(key, seconds)
      .then(() => announce(`${what} watchdog saved.`))
      .catch((err: unknown) =>
        toast.show(firmwareErrorMessage(err, 'Could not save the watchdog.'), { tone: 'error' }),
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
        toast.show(firmwareErrorMessage(err, 'Could not turn it off.'), { tone: 'error' }),
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
      <h2 id={headingId}>Firmware and boot</h2>
      <p className="muted ws-flush">
        Changes below the operating system of devices running novad. All are off by default, apply
        to the whole Hub and are recorded in the audit log. Nova never makes these changes by
        itself.
      </p>
      {policy.error ? (
        <LoadError
          error={policy.error}
          fallback="Could not read the firmware switches."
          onRetry={policy.reload}
        />
      ) : null}
      {policy.loading ? <Spinner label="Reading the firmware switches" /> : null}
      {p ? (
        <>
          <SwitchField
            label={LABEL['devices.firmware.allowChanges']}
            description={
              p.allowChanges
                ? 'On: you can plan firmware changes on supported devices; each needs your approval and can be rolled back.'
                : 'Off: devices refuse firmware changes. Reading their settings still works.'
            }
            checked={p.allowChanges}
            locked={fwLock}
            disabled={busy !== null}
            onChange={(next) => flip('devices.firmware.allowChanges', next)}
          />
          <SwitchField
            label={LABEL['devices.firmware.allowSecurityDegrading']}
            description={
              p.allowSecurityDegrading
                ? 'On: a firmware change may turn Secure Boot or the TPM off, after your approval.'
                : 'Off: changes that turn Secure Boot or the TPM off are refused, even when approved.'
            }
            checked={p.allowSecurityDegrading}
            locked={sdLock}
            disabled={busy !== null}
            onChange={(next) => flip('devices.firmware.allowSecurityDegrading', next)}
          />
        </>
      ) : null}
      <SwitchField
        label={LABEL['devices.boot.allowLowLevel']}
        description={
          lowLevel.value
            ? 'On: you can try a boot profile once on a device and make a confirmed one the default, each after your approval.'
            : 'Off: devices refuse boot trials and new defaults. Clearing a pending one-shot always works.'
        }
        checked={lowLevel.value}
        locked={lowLevel.locked}
        disabled={busy !== null}
        onChange={(next) => flip('devices.boot.allowLowLevel', next)}
      />
      <SelectField
        className="devices-narrow"
        label="Firmware watchdog"
        value={String(fwWatchdog.value)}
        locked={fwWatchdog.locked}
        options={watchdogOptions(fwWatchdog.value)}
        hint="For firmware changes applied with a restart: how long the device has to come back before its watchdog restores the previous settings."
        onChange={(v) => saveWatchdog('devices.firmware.watchdogSeconds', Number(v), 'Firmware')}
      />
      <SelectField
        className="devices-narrow"
        label="Boot watchdog"
        value={String(watchdog.value)}
        locked={watchdog.locked}
        options={watchdogOptions(watchdog.value)}
        hint="How long a device has to come back on an entry it tries before it returns to its default entry. The Hub reports the trial failed 2 minutes later."
        onChange={(v) => saveWatchdog('devices.boot.watchdogSeconds', Number(v), 'Boot')}
      />
      <SwitchField
        label={LABEL['devices.pxe.enabled']}
        description={
          pxe.value
            ? 'On: the Hub serves the iPXE menu and its boot images to devices holding a boot token.'
            : 'Off: the network boot addresses answer “not found”.'
        }
        checked={pxe.value}
        locked={pxe.locked}
        disabled={busy !== null}
        onChange={(next) => flip('devices.pxe.enabled', next)}
      />
      <ConfirmDialog
        open={consent !== null}
        title={consent?.title ?? ''}
        description={consent?.body}
        confirmLabel={consent?.confirm ?? 'Turn on'}
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

const LABEL: Record<Consent['key'], string> = {
  'devices.firmware.allowChanges': 'Allow BIOS/firmware changes',
  'devices.firmware.allowSecurityDegrading': 'Allow changes that weaken security',
  'devices.boot.allowLowLevel': 'Allow low-level boot changes',
  'devices.pxe.enabled': 'Network boot (PXE)',
};

/** The keys this section owns (for the settings search and tests). */
export const FIRMWARE_BOOT_SETTING_KEYS: readonly SettingKey[] = [
  'devices.firmware.allowChanges',
  'devices.firmware.allowSecurityDegrading',
  'devices.firmware.watchdogSeconds',
  'devices.boot.allowLowLevel',
  'devices.boot.watchdogSeconds',
  'devices.pxe.enabled',
];
