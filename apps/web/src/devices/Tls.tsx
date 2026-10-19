// Device certificates (FR-126, docs/22 §5 and §9): over HTTPS, computers running novad and
// compute nodes present a device certificate from the Hub's local CA (mutual TLS). The Hub
// reports what it saw on each device's last HTTPS call: verified, none (accepted while
// `devices.tls.allowWithoutCertificate` is on) or refused with the reason. The Devices list shows
// a chip per device and a "Device certificates" section with the switch that requires them; a
// device's page shows its own state. Rebuilt by the Hub from each heartbeat after it starts, and
// live through `device.tls.changed`.
import { useId, useState } from 'react';
import type { DeviceTlsSummaryView, DeviceTlsView } from '@nova/shared';
import { Icon, Spinner, useToast, type IconName } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { useSettings } from '../settings.tsx';
import { formatWhen } from '../settings/common.ts';
import { SwitchField } from '../settings/controls.tsx';
import { useDebounced } from '../work/events.ts';
import { followLink } from '../work/nav.tsx';
import { useDeviceTlsApi } from './api-m7.ts';
import { useDeviceEvents } from './events.ts';
import { devicePath, type ChipTone } from './format.ts';
import { Chip, ConfirmDialog, LoadError, useLoad, type Loaded } from './parts.tsx';

/** Events after which the certificate summary may have changed. */
export const TLS_EVENTS: readonly string[] = [
  'device.tls.changed',
  'device.registered',
  'device.status.changed',
];

const SETTING = 'devices.tls.allowWithoutCertificate';

const REASON_TEXT: Record<string, string> = {
  certificate_required: 'it presented none, and one is required',
  certificate_mismatch: 'it presented another device’s certificate',
  certificate_revoked: 'its certificate was revoked',
  certificate_expired: 'its certificate expired',
  certificate_not_yet_valid: 'its certificate is not valid yet',
  certificate_unknown_issuer: 'its certificate was not issued by this Hub',
  certificate_unknown_serial: 'this Hub never issued that certificate',
  certificate_malformed: 'its certificate could not be read',
  certificate_bad_signature: 'its certificate’s signature does not match',
  certificate_no_ca: 'this Hub has no local CA to check it with',
};

/** Why a certificate was refused, in plain words. */
export function tlsReasonText(reason: string | null): string {
  if (!reason) return 'it was refused';
  return REASON_TEXT[reason] ?? reason.replace(/^certificate_/, '').replace(/_/g, ' ');
}

export function tlsChip(v: Pick<DeviceTlsView, 'certificate'>): {
  text: string;
  tone: ChipTone;
  icon: IconName;
} {
  if (v.certificate === 'verified')
    return { text: 'Certificate verified', tone: 'ready', icon: 'shield' };
  if (v.certificate === 'missing')
    return { text: 'No certificate', tone: 'needs_input', icon: 'alert' };
  return { text: 'Certificate refused', tone: 'blocked', icon: 'stop' };
}

export function DeviceTlsChip({ view }: { view: DeviceTlsView }) {
  const c = tlsChip(view);
  return <Chip tone={c.tone} icon={c.icon} text={c.text} />;
}

/** The summary, live; null when this client has no such call. */
export function useDeviceTls(): Loaded<DeviceTlsSummaryView> | null {
  const api = useDeviceTlsApi();
  const load = useLoad<DeviceTlsSummaryView>(
    () => (api ? api.getDeviceTls() : Promise.reject(new Error('unavailable'))),
    'device-tls',
  );
  const reload = useDebounced(load.reload, 200);
  useDeviceEvents(TLS_EVENTS, () => reload());
  return api ? load : null;
}

const KIND_TEXT: Record<DeviceTlsView['kind'], string> = {
  novad: 'Computer running novad',
  compute: 'Compute node',
};

/** "Device certificates" on the Devices list: the requirement switch, problems and each device. */
export function DeviceTlsSection({ tls }: { tls: Loaded<DeviceTlsSummaryView> }) {
  const settings = useSettings();
  const toast = useToast();
  const headingId = useId();
  const entry = settings.get(SETTING);
  const [asking, setAsking] = useState(false);
  const data = tls.data;
  const required = !entry.value;
  const missing = data?.items.filter((v) => v.certificate === 'missing') ?? [];

  const write = async (allowWithout: boolean) => {
    await settings.set(SETTING, allowWithout);
    tls.reload();
    toast.show(
      allowWithout
        ? 'Devices without a certificate are accepted over HTTPS again.'
        : 'Devices now need a certificate over HTTPS.',
      { tone: 'success' },
    );
  };

  return (
    <section className="ws-section devices-tls" aria-labelledby={headingId}>
      <h2 id={headingId}>Device certificates</h2>
      <p className="muted ws-flush">
        Over HTTPS, computers running novad and compute nodes prove who they are with a certificate
        from this Hub, on top of their key. Nothing is checked over plain HTTP. The list fills as
        devices check in after the Hub starts.
      </p>
      <SwitchField
        label="Require a device certificate over HTTPS"
        description="Off: a device without one is still accepted and listed below as a problem. Devices added before certificates existed need to be added again to get one."
        checked={required}
        locked={entry.locked}
        onChange={(next) => {
          if (next) setAsking(true);
          else
            void write(true).catch((err: unknown) =>
              toast.show(`Could not save: ${errorMessage(err)}`, { tone: 'error' }),
            );
        }}
      />
      {tls.error ? (
        <LoadError
          error={tls.error}
          fallback="Could not load the device certificates."
          onRetry={tls.reload}
        />
      ) : null}
      {tls.loading ? <Spinner label="Loading device certificates" /> : null}
      {data?.problems.length ? (
        <div className="contrast-warning" role="status" aria-label="Certificate problems">
          <Icon name="alert" />
          <ul>
            {data.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {data && data.items.length === 0 ? (
        <p className="muted ws-flush">No device has reached the Hub over HTTPS since it started.</p>
      ) : null}
      {data?.items.length ? (
        <ul className="ws-list" aria-label="Devices seen over HTTPS">
          {data.items.map((v) => {
            const name = v.name ?? 'Unnamed device';
            return (
              <li key={v.deviceId} className="ws-list-row devices-row" aria-label={name}>
                <div className="devices-row-main">
                  <div className="devices-row-head">
                    <a
                      href={devicePath(v.deviceId)}
                      className="ws-card-link"
                      onClick={(e) => followLink(e, devicePath(v.deviceId))}
                    >
                      {name}
                    </a>
                    <DeviceTlsChip view={v} />
                  </div>
                  <span className="muted ws-row-meta">
                    <span>{KIND_TEXT[v.kind]}</span>
                    <span>last HTTPS contact {formatWhen(v.lastHttpsAt)}</span>
                    {v.serial ? (
                      <span>
                        serial <code className="ws-code-inline">{v.serial.slice(0, 16)}</code>
                      </span>
                    ) : null}
                  </span>
                  {v.certificate === 'refused' ? (
                    <span className="ws-warning">Refused: {tlsReasonText(v.reason)}.</span>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
      <ConfirmDialog
        open={asking}
        title="Require a device certificate?"
        description={
          missing.length
            ? `${missing.length === 1 ? 'This device reaches' : 'These devices reach'} the Hub over HTTPS without one and will be refused until added again: ${missing
                .map((v) => v.name ?? v.deviceId)
                .join(', ')}.`
            : 'Over HTTPS, a computer running novad or a compute node without a certificate from this Hub is refused.'
        }
        confirmLabel="Require certificates"
        danger={missing.length > 0}
        onClose={() => setAsking(false)}
        onConfirm={async () => {
          await write(false);
          setAsking(false);
        }}
      />
    </section>
  );
}

/** A device page's "Certificate" fact: what the Hub saw on its last HTTPS call. */
export function DeviceTlsFact({ deviceId }: { deviceId: string }) {
  const tls = useDeviceTls();
  if (!tls?.data) return null;
  const v = tls.data.items.find((x) => x.deviceId === deviceId);
  return (
    <div>
      <dt>Certificate</dt>
      <dd>
        {v ? (
          <span className="devices-tls-fact">
            <DeviceTlsChip view={v} />
            <span className="muted">
              {v.certificate === 'refused'
                ? `${tlsReasonText(v.reason)}, ${formatWhen(v.lastHttpsAt)}`
                : formatWhen(v.lastHttpsAt)}
            </span>
          </span>
        ) : (
          <span className="muted">Not seen over HTTPS</span>
        )}
      </dd>
    </div>
  );
}
