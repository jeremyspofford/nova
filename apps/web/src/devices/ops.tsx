// M7.5 device operations on a device's page (ADR-096 D1, D9; FR-142, FR-148, FR-150): how the
// Hub reaches the device's management endpoint (mutual TLS with the Hub's client certificate, or
// plain HTTP for a device added before certificates) and why the last call was refused; the novad
// build this Hub serves for the device (information only); and the owner's overrides and policy
// as the device has them, with "Push now" instead of waiting for its next heartbeat. Words for
// the M7.5 refusals live here too. Each part stays out of the page when the client lacks its call.
import { useId, useState } from 'react';
import type {
  DeviceAvailableUpdateView,
  DeviceManagementTlsView,
  DeviceTlsFailure,
  DeviceView,
} from '@nova/shared';
import { Button, Icon, Spinner, useToast } from '@nova/ui';
import { ApiError } from '../api.ts';
import { useHubStream } from '../hub-events.ts';
import { formatWhen } from '../settings/common.ts';
import { useDebounced } from '../work/events.ts';
import { useDeviceOpsApi } from './api-m75.ts';
import { deviceErrorMessage, deviceUnreachable, formatBytes } from './format.ts';
import { Chip, LoadError, Unavailable, useLoad } from './parts.tsx';
import './ops.css';

// ---- words ---------------------------------------------------------------------------------------

export const TLS_FAILURE_TEXT: Record<DeviceTlsFailure, string> = {
  no_ca: 'this Hub has no local CA to check the device with',
  no_client_certificate: 'the Hub has no client certificate for the management channel',
  untrusted_certificate: 'the device’s certificate was not issued by this Hub',
  expired: 'the device’s certificate expired',
  not_yet_valid: 'the device’s certificate is not valid yet',
  wrong_device: 'the device’s certificate names another device',
  key_mismatch: 'the device’s certificate carries another key than the one the Hub pinned',
  revoked: 'the device’s certificate was revoked',
  unknown_certificate: 'this Hub does not know the device’s certificate',
  unsupported_purpose:
    'the device still presents its old certificate; it installs the renewed one with its next heartbeat',
  handshake_failed:
    'the secure connection failed (the device may have refused the Hub’s certificate)',
};

/** A device-operations refusal in plain words (the M6 words for the rest). */
export function opsErrorMessage(err: unknown, fallback = 'Something went wrong.'): string {
  if (err instanceof ApiError) {
    const d = err.body.details ?? {};
    switch (d.reason) {
      case 'decommission_pending':
        return 'A decommission of this device is already waiting for your approval.';
      case 'device_tls_failed': {
        const tls = typeof d.tls === 'string' ? (d.tls as DeviceTlsFailure) : null;
        return `The Hub could not reach the device securely: ${
          tls && tls in TLS_FAILURE_TEXT ? TLS_FAILURE_TEXT[tls] : 'the secure connection failed'
        }.`;
      }
      case 'job_token_rejected':
        return 'The node refused the Hub’s job token. Add the node again.';
      case 'owner_only':
        return 'Only the owner of this Hub can do that.';
      default:
        break;
    }
  }
  return deviceErrorMessage(err, fallback);
}

const ENDPOINT_EVENTS = ['device.endpoint.changed', 'device.status.changed', 'device.tls.changed'];

// ---- the management channel (D1) ----------------------------------------------------------------

/** The device page's "Management" fact: mutual TLS or plain HTTP, and the last refusal. */
export function ManagementFact({ deviceId }: { deviceId: string }) {
  const api = useDeviceOpsApi();
  const tls = useLoad(
    () => (api ? api.getManagementTls() : Promise.reject(new Error('unavailable'))),
    'management-tls',
  );
  const reload = useDebounced(tls.reload, 200);
  useHubStream(ENDPOINT_EVENTS, (env) => {
    if (env.payload.deviceId === deviceId) reload();
  });
  if (!api || !tls.data) return null;
  const v = tls.data.items.find((x) => x.deviceId === deviceId);
  if (!v) return null;
  return (
    <div>
      <dt>Management</dt>
      <dd>
        <span className="devices-tls-fact">
          <ChannelChip view={v} />
          <span className="muted">{channelText(v, tls.data.hubClient !== null)}</span>
        </span>
        {renewalText(v) ? (
          <span className="muted devices-tls-renewal">{renewalText(v)}</span>
        ) : null}
      </dd>
    </div>
  );
}

export function ChannelChip({ view }: { view: DeviceManagementTlsView }) {
  if (view.lastCall && !view.lastCall.ok && view.lastCall.failure)
    return <Chip tone="blocked" icon="stop" text="Channel refused" />;
  if (view.channel === 'mutual_tls') return <Chip tone="ready" icon="shield" text="Mutual TLS" />;
  if (view.channel === 'plain_http')
    return <Chip tone="needs_input" icon="alert" text="Plain HTTP" />;
  return <Chip tone="neutral" icon="clock" text="No address yet" />;
}

/** What the channel means, in a sentence. */
export function channelText(v: DeviceManagementTlsView, hubClient: boolean): string {
  const failure = v.lastCall && !v.lastCall.ok ? v.lastCall.failure : null;
  if (failure)
    return `Refused ${formatWhen(v.lastCall?.at ?? null)}: ${TLS_FAILURE_TEXT[failure]}.`;
  if (v.channel === 'mutual_tls')
    return hubClient
      ? 'The Hub and the device check each other’s certificates on every call.'
      : 'The Hub has no client certificate yet, so it cannot reach the device. Check the trust settings.';
  if (v.channel === 'plain_http')
    return 'Calls are not encrypted. Add the device again with the Hub’s local CA to use mutual TLS.';
  return 'The device has not told the Hub where to reach it.';
}

/**
 * The device certificate's renewal in one plain line (D1), or null when there is nothing to say:
 * offered (with how long the old certificate is still accepted), in use, or due at the next
 * check-in for an old certificate not renewed yet.
 */
export function renewalText(v: DeviceManagementTlsView): string | null {
  const r = v.renewal;
  if (!r) return null;
  if (r.state === 'offered')
    return v.legacyGraceEndsAt
      ? `Certificate renewal offered; the device switches at its next check-in (its old certificate is accepted until ${formatWhen(v.legacyGraceEndsAt)}).`
      : 'Certificate renewal offered; the device switches at its next check-in.';
  if (r.state === 'presented')
    return `Certificate renewed${r.reason === 'missing_server_auth' ? ' for the encrypted management channel' : ''}; valid until ${formatWhen(r.notAfter)}.`;
  if (v.legacyCertificate)
    return 'This device has an older kind of certificate; the Hub offers a new one at its next check-in.';
  return null;
}

// ---- the novad build the Hub serves (FR-148) ------------------------------------------------------

const PLATFORM_TEXT: Record<string, string> = {
  linux: 'Linux',
  darwin: 'macOS',
  windows: 'Windows',
};

export function availableText(v: DeviceAvailableUpdateView): string {
  const platform = v.platform
    ? `${PLATFORM_TEXT[v.platform.os] ?? v.platform.os} ${v.platform.arch}`
    : 'its platform';
  const current = v.current.novad ? `novad ${v.current.novad}` : 'an unknown version';
  switch (v.reason) {
    case 'newer_available':
      return `This Hub serves novad ${v.novad?.version ?? ''} for ${platform}; the device has ${current}.`;
    case 'up_to_date':
      return `The device has ${current}, the build this Hub serves for ${platform}.`;
    case 'no_builds':
      return 'This Hub serves no novad builds.';
    case 'no_build_for_platform':
      return `This Hub serves no novad build for ${platform}.`;
    case 'unknown_platform':
      return 'The device has not said which platform it runs on, so no build can be matched.';
    case 'unknown_version':
      return `This Hub serves novad ${v.novad?.version ?? ''} for ${platform}, but the device’s version is unknown.`;
  }
}

/** The Updates tab's "Available build" section. */
export function AvailableBuild({ device }: { device: DeviceView }) {
  const api = useDeviceOpsApi();
  const base = useId();
  const avail = useLoad(
    () => (api ? api.getAvailableUpdate(device.id) : Promise.reject(new Error('unavailable'))),
    `available:${device.id}`,
  );
  const reload = useDebounced(avail.reload, 200);
  useHubStream(['device.update.result', 'device.capabilities.changed'], (env) => {
    if (env.payload.deviceId === device.id) reload();
  });
  if (!api || device.status === 'revoked') return null;
  const v = avail.data;
  return (
    <section className="ws-section devices-flat" aria-labelledby={`${base}-h`}>
      <h2 id={`${base}-h`}>Available build</h2>
      {avail.error ? (
        <LoadError
          error={avail.error}
          fallback="Could not check for a newer novad."
          onRetry={avail.reload}
        />
      ) : null}
      {avail.loading ? <Spinner label="Checking for a newer novad" /> : null}
      {v ? (
        <div className={v.newer ? 'devices-note' : undefined} role="status">
          <p className="ws-flush">
            {v.newer ? <Icon name="download" /> : null} {availableText(v)}
          </p>
          {v.novad ? (
            <p className="muted ws-flush">
              {v.novad.file} · {formatBytes(v.novad.size)} · SHA-256{' '}
              <code className="ws-code-inline" title={v.novad.sha256}>
                {v.novad.sha256.slice(0, 16)}…
              </code>
            </p>
          ) : null}
          {v.newer ? (
            <p className="muted ws-flush">
              The Hub does not install it by itself: install it on the device as a signed update
              bundle below.
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

// ---- overrides and policy on the device (FR-142, FR-150) --------------------------------------------

const SECTION_LABEL: Record<string, string> = {
  models: 'Models',
  computePolicy: 'Compute',
  scheduling: 'Scheduling',
  limits: 'Limits',
  power: 'Power',
  locale: 'Locale',
  data: 'Data',
};

/** The Policy tab's "On the device" section, with Push now. */
export function OverridesSection({ device }: { device: DeviceView }) {
  const api = useDeviceOpsApi();
  const toast = useToast();
  const base = useId();
  const view = useLoad(
    () => (api ? api.getDeviceOverrides(device.id) : Promise.reject(new Error('unavailable'))),
    `overrides:${device.id}:${device.configPending ? 1 : 0}`,
  );
  const reload = useDebounced(view.reload, 200);
  useHubStream(['device.overrides.changed', 'device.capabilities.changed'], (env) => {
    if (env.payload.deviceId === device.id) reload();
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!api || device.status === 'revoked') return null;
  const v = view.data;
  const offline = deviceUnreachable(device);
  const push = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await api.pushDeviceOverrides(device.id);
      view.setData(() => next);
      toast.show(
        next.configPending
          ? 'Sent. The device has not confirmed it yet.'
          : 'The device has it now.',
        { tone: 'success' },
      );
    } catch (err) {
      setError(opsErrorMessage(err, 'Could not push the changes.'));
    } finally {
      setBusy(false);
    }
  };
  const sections = v ? Object.entries(v.effective) : [];
  return (
    <section className="ws-section devices-flat" aria-labelledby={`${base}-h`}>
      <div className="ws-section-header">
        <h2 id={`${base}-h`}>On the device</h2>
        <Button disabled={busy || Boolean(offline) || !v} onClick={() => void push()}>
          {busy ? <Spinner /> : <Icon name="send" />} Push now
        </Button>
      </div>
      <p className="muted ws-flush">
        The device takes your overrides and policy with its next heartbeat. Push now sends them at
        once.
      </p>
      {offline ? <Unavailable>{offline}</Unavailable> : null}
      {view.error ? (
        <LoadError
          error={view.error}
          fallback="Could not load what the device has."
          onRetry={view.reload}
        />
      ) : null}
      {view.loading ? <Spinner label="Loading what the device has" /> : null}
      {v ? (
        <p className="ws-flush" aria-live="polite">
          {v.configPending ? (
            <Chip
              tone="needs_input"
              icon="clock"
              text={`Waiting for the device: change ${v.configRevision}, it has ${v.pushedRevision}`}
            />
          ) : (
            <Chip
              tone="ready"
              icon="check"
              text={`The device has the latest (change ${v.configRevision})`}
            />
          )}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="nv-field-error">
          {error}
        </p>
      ) : null}
      {sections.length ? (
        <details className="ws-advanced">
          <summary>In force on the device</summary>
          <p className="muted">
            From the device’s last signed capability document: its own settings with yours applied.
          </p>
          <dl className="devices-facts">
            {sections.map(([k, value]) => (
              <div key={k}>
                <dt>{SECTION_LABEL[k] ?? k}</dt>
                <dd>
                  <pre className="devices-json">{JSON.stringify(value, null, 2)}</pre>
                </dd>
              </div>
            ))}
          </dl>
        </details>
      ) : null}
    </section>
  );
}
