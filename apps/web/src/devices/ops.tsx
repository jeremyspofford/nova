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
import { defineMessages, messageFor } from '@nova/i18n';
import { ApiError } from '../api.ts';
import { rich } from '../i18n/rich.tsx';
import { useHubStream } from '../hub-events.ts';
import { formatWhen } from '../settings/common.ts';
import { useDebounced } from '../work/events.ts';
import { useDeviceOpsApi } from './api-m75.ts';
import { deviceErrorMessage, deviceUnreachable, formatBytes } from './format.ts';
import { Chip, LoadError, Unavailable, useLoad } from './parts.tsx';
import './ops.css';

// ---- words ---------------------------------------------------------------------------------------

export const OPS_TEXT = defineMessages('devices.ops', {
  /** Why a call on the management channel was refused: a clause, shown after a colon. */
  tlsFailures: {
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
  },
  errors: {
    decommissionPending: 'A decommission of this device is already waiting for your approval.',
    tlsFailed: 'The Hub could not reach the device securely: {reason}.',
    secureFailed: 'the secure connection failed',
    jobToken: 'The node refused the Hub’s job token. Add the node again.',
    ownerOnly: 'Only the owner of this Hub can do that.',
  },
  management: 'Management',
  chip: {
    refused: 'Channel refused',
    mutualTls: 'Mutual TLS',
    plainHttp: 'Plain HTTP',
    noAddress: 'No address yet',
  },
  channel: {
    refused: 'Refused {when}: {reason}.',
    mutual: 'The Hub and the device check each other’s certificates on every call.',
    noClient:
      'The Hub has no client certificate yet, so it cannot reach the device. Check the trust settings.',
    plain:
      'Calls are not encrypted. Add the device again with the Hub’s local CA to use mutual TLS.',
    none: 'The device has not told the Hub where to reach it.',
  },
  renewal: {
    offeredUntil:
      'Certificate renewal offered; the device switches at its next check-in (its old certificate is accepted until {when}).',
    offered: 'Certificate renewal offered; the device switches at its next check-in.',
    renewedChannel: 'Certificate renewed for the encrypted management channel; valid until {when}.',
    renewed: 'Certificate renewed; valid until {when}.',
    legacy:
      'This device has an older kind of certificate; the Hub offers a new one at its next check-in.',
  },
  platforms: {
    linux: 'Linux',
    darwin: 'macOS',
    windows: 'Windows',
  },
  /** A platform, in a sentence: "Linux x86_64". */
  platform: '{os} {arch}',
  itsPlatform: 'its platform',
  /** The version the device has, in a sentence. */
  current: 'novad {version}',
  unknownVersion: 'an unknown version',
  available: {
    newer: 'This Hub serves novad {version} for {platform}; the device has {current}.',
    upToDate: 'The device has {current}, the build this Hub serves for {platform}.',
    noBuilds: 'This Hub serves no novad builds.',
    noBuildFor: 'This Hub serves no novad build for {platform}.',
    unknownPlatform:
      'The device has not said which platform it runs on, so no build can be matched.',
    unknownVersion:
      'This Hub serves novad {version} for {platform}, but the device’s version is unknown.',
  },
  availableBuild: 'Available build',
  checkFailed: 'Could not check for a newer novad.',
  checking: 'Checking for a newer novad',
  sha: 'SHA-256 {hash}',
  notInstalled:
    'The Hub does not install it by itself: install it on the device as a signed update bundle below.',
  sections: {
    models: 'Models',
    computePolicy: 'Compute',
    scheduling: 'Scheduling',
    limits: 'Limits',
    power: 'Power',
    locale: 'Locale',
    data: 'Data',
  },
  sent: 'Sent. The device has not confirmed it yet.',
  hasIt: 'The device has it now.',
  pushFailed: 'Could not push the changes.',
  onDevice: 'On the device',
  pushNow: 'Push now',
  pushHelp:
    'The device takes your overrides and policy with its next heartbeat. Push now sends them at once.',
  loadFailed: 'Could not load what the device has.',
  loading: 'Loading what the device has',
  waiting: 'Waiting for the device: change {revision}, it has {pushed}',
  latest: 'The device has the latest (change {revision})',
  inForce: 'In force on the device',
  inForceHelp:
    'From the device’s last signed capability document: its own settings with yours applied.',
});
const S = OPS_TEXT;

export const TLS_FAILURE_TEXT: Readonly<Record<DeviceTlsFailure, string>> = S.tlsFailures;

/** A device-operations refusal in plain words (the M6 words for the rest). */
export function opsErrorMessage(err: unknown, fallback?: string): string {
  if (err instanceof ApiError) {
    const d = err.body.details ?? {};
    switch (d.reason) {
      case 'decommission_pending':
        return S.errors.decommissionPending;
      case 'device_tls_failed': {
        const tls = typeof d.tls === 'string' ? messageFor(S.tlsFailures, d.tls) : undefined;
        return S.errors.tlsFailed({ reason: tls ?? S.errors.secureFailed });
      }
      case 'job_token_rejected':
        return S.errors.jobToken;
      case 'owner_only':
        return S.errors.ownerOnly;
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
      <dt>{S.management}</dt>
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
    return <Chip tone="blocked" icon="stop" text={S.chip.refused} />;
  if (view.channel === 'mutual_tls')
    return <Chip tone="ready" icon="shield" text={S.chip.mutualTls} />;
  if (view.channel === 'plain_http')
    return <Chip tone="needs_input" icon="alert" text={S.chip.plainHttp} />;
  return <Chip tone="neutral" icon="clock" text={S.chip.noAddress} />;
}

/** What the channel means, in a sentence. */
export function channelText(v: DeviceManagementTlsView, hubClient: boolean): string {
  const failure = v.lastCall && !v.lastCall.ok ? v.lastCall.failure : null;
  if (failure)
    return S.channel.refused({
      when: formatWhen(v.lastCall?.at ?? null),
      reason: TLS_FAILURE_TEXT[failure],
    });
  if (v.channel === 'mutual_tls') return hubClient ? S.channel.mutual : S.channel.noClient;
  if (v.channel === 'plain_http') return S.channel.plain;
  return S.channel.none;
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
      ? S.renewal.offeredUntil({ when: formatWhen(v.legacyGraceEndsAt) })
      : S.renewal.offered;
  if (r.state === 'presented')
    return r.reason === 'missing_server_auth'
      ? S.renewal.renewedChannel({ when: formatWhen(r.notAfter) })
      : S.renewal.renewed({ when: formatWhen(r.notAfter) });
  if (v.legacyCertificate) return S.renewal.legacy;
  return null;
}

// ---- the novad build the Hub serves (FR-148) ------------------------------------------------------

export function availableText(v: DeviceAvailableUpdateView): string {
  const platform = v.platform
    ? S.platform({
        os: messageFor(S.platforms, v.platform.os) ?? v.platform.os,
        arch: v.platform.arch,
      })
    : S.itsPlatform;
  const current = v.current.novad ? S.current({ version: v.current.novad }) : S.unknownVersion;
  const version = v.novad?.version ?? '';
  switch (v.reason) {
    case 'newer_available':
      return S.available.newer({ version, platform, current });
    case 'up_to_date':
      return S.available.upToDate({ current, platform });
    case 'no_builds':
      return S.available.noBuilds;
    case 'no_build_for_platform':
      return S.available.noBuildFor({ platform });
    case 'unknown_platform':
      return S.available.unknownPlatform;
    case 'unknown_version':
      return S.available.unknownVersion({ version, platform });
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
      <h2 id={`${base}-h`}>{S.availableBuild}</h2>
      {avail.error ? (
        <LoadError error={avail.error} fallback={S.checkFailed} onRetry={avail.reload} />
      ) : null}
      {avail.loading ? <Spinner label={S.checking} /> : null}
      {v ? (
        <div className={v.newer ? 'devices-note' : undefined} role="status">
          <p className="ws-flush">
            {v.newer ? <Icon name="download" /> : null} {availableText(v)}
          </p>
          {v.novad ? (
            <p className="muted ws-flush">
              {v.novad.file} · {formatBytes(v.novad.size)} ·{' '}
              {rich(S.sha, {
                hash: (
                  <code className="ws-code-inline" title={v.novad.sha256}>
                    {v.novad.sha256.slice(0, 16)}…
                  </code>
                ),
              })}
            </p>
          ) : null}
          {v.newer ? <p className="muted ws-flush">{S.notInstalled}</p> : null}
        </div>
      ) : null}
    </section>
  );
}

// ---- overrides and policy on the device (FR-142, FR-150) --------------------------------------------

const SECTION_LABEL: Readonly<Record<string, string | undefined>> = S.sections;

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
      toast.show(next.configPending ? S.sent : S.hasIt, { tone: 'success' });
    } catch (err) {
      setError(opsErrorMessage(err, S.pushFailed));
    } finally {
      setBusy(false);
    }
  };
  const sections = v ? Object.entries(v.effective) : [];
  return (
    <section className="ws-section devices-flat" aria-labelledby={`${base}-h`}>
      <div className="ws-section-header">
        <h2 id={`${base}-h`}>{S.onDevice}</h2>
        <Button disabled={busy || Boolean(offline) || !v} onClick={() => void push()}>
          {busy ? <Spinner /> : <Icon name="send" />} {S.pushNow}
        </Button>
      </div>
      <p className="muted ws-flush">{S.pushHelp}</p>
      {offline ? <Unavailable>{offline}</Unavailable> : null}
      {view.error ? (
        <LoadError error={view.error} fallback={S.loadFailed} onRetry={view.reload} />
      ) : null}
      {view.loading ? <Spinner label={S.loading} /> : null}
      {v ? (
        <p className="ws-flush" aria-live="polite">
          {v.configPending ? (
            <Chip
              tone="needs_input"
              icon="clock"
              text={S.waiting({ revision: v.configRevision, pushed: v.pushedRevision })}
            />
          ) : (
            <Chip tone="ready" icon="check" text={S.latest({ revision: v.configRevision })} />
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
          <summary>{S.inForce}</summary>
          <p className="muted">{S.inForceHelp}</p>
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
