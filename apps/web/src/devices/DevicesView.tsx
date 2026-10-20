// Devices (docs/04 §9, docs/23; FR-140, FR-132, FR-141..FR-150, FR-210, FR-081): every device of
// this Hub in one list, whatever it runs (browsers and the app, computers running `novad`,
// compute nodes), with its role, status, platform, last contact and how it is reached; requests
// to join wait at the top for approval. /devices/add adds a device; /devices/:id is one device's
// page. The models and load of compute nodes stay in Settings → Devices, linked from here. Since
// M7 each computer and compute node also shows what the Hub saw of its certificate over HTTPS,
// with a "Device certificates" section (FR-126). M7.5 adds the way into out-of-band management
// (/devices/oob, FR-147).
import { useState } from 'react';
import type { DeviceSummaryView, DeviceView } from '@nova/shared';
import { Button, EmptyState, Icon, Spinner, useToast } from '@nova/ui';
import { defineMessages } from '@nova/i18n';
import { rich } from '../i18n/rich.tsx';
import { formatWhen, useInterval } from '../settings/common.ts';
import { useDebounced } from '../work/events.ts';
import { followLink } from '../work/nav.tsx';
import { navigate } from '../router.ts';
import { AddDevicePage } from './AddDevice.tsx';
import { useDevicesApi } from './api.ts';
import { DevicePage } from './DevicePage.tsx';
import { DEVICE_ROW_EVENTS, DeviceEventsProvider, useDeviceEvents } from './events.ts';
import {
  ADD_DEVICE_ID,
  DEVICES_ADD_PATH,
  capabilitySummary,
  deviceErrorMessage,
  devicePath,
  isSessionDevice,
  rolesText,
  runsText,
  scopesText,
  wakeSentText,
} from './format.ts';
import { DeviceStatusChip, LoadError, UpdateRequiredChip, useLoad } from './parts.tsx';
import { PendingRequests } from './Requests.tsx';
import { DeviceTlsChip, DeviceTlsSection, useDeviceTls } from './Tls.tsx';
import { OOB_ID } from '../oob/format.ts';
import { OobEntry, OobPage } from '../oob/OobPage.tsx';
import '../workspace.css';
import '../work/work.css';
import './devices.css';

export const LIST_TEXT = defineMessages('devices.list', {
  title: 'Devices',
  add: 'Add device',
  intro:
    'Everything that uses this Hub: browsers and phones, computers running novad, and compute nodes. Open one to change its scopes, wake it or revoke it. The models and load of compute nodes are in {link}.',
  settingsDevices: 'Settings → Devices',
  loadFailed: 'Could not load devices.',
  novadFailed: 'Could not load what the novad devices report.',
  loading: 'Loading devices',
  emptyTitle: 'No devices yet',
  emptyHelp:
    'Add a phone, a browser or a computer with a QR code or a short code. Computers can then share folders with agents, run modules and wake on request.',
  addFirst: 'Add a device',
  keptOut: 'Kept out of agent work',
  changesWaiting: 'Changes waiting for the device',
  scopes: 'Scopes: {scopes}',
  wake: 'Wake',
  wakeName: 'Wake {name}',
  wakeFailed: 'Could not wake {name}.',
  heartbeat: 'last heartbeat {when}',
  noHeartbeat: 'no heartbeat yet',
  seen: 'last seen {when}',
  notSeen: 'not seen yet',
  signedIn: '{n, plural, one {Signed in (# session)} other {Signed in (# sessions)}}',
  signedOut: 'Signed out',
  reachedAt: 'Reached at {endpoint}',
  notReachable: 'Not reachable now',
});
const S = LIST_TEXT;

export function DevicesView({ deviceId }: { deviceId: string | null }) {
  return (
    <DeviceEventsProvider>
      {deviceId === ADD_DEVICE_ID ? (
        <AddDevicePage />
      ) : deviceId === OOB_ID ? (
        <OobPage />
      ) : deviceId ? (
        <DevicePage key={deviceId} deviceId={deviceId} />
      ) : (
        <DeviceList />
      )}
    </DeviceEventsProvider>
  );
}

/** Live devices first, revoked ones last; the Hub's order (oldest first) otherwise. */
export function sortDevices<T extends { status: string }>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => Number(a.status === 'revoked') - Number(b.status === 'revoked'));
}

/** "last heartbeat 5 min ago" or "no heartbeat yet". */
export function heartbeatText(d: Pick<DeviceView, 'lastSeenAt'>, now: number): string {
  return d.lastSeenAt ? S.heartbeat({ when: formatWhen(d.lastSeenAt, now) }) : S.noHeartbeat;
}

/** novad devices report heartbeats; everything else is "last seen". */
export function seenText(
  d: Pick<DeviceSummaryView, 'lastSeenAt'>,
  novad: Pick<DeviceView, 'lastSeenAt'> | null,
  now: number,
): string {
  if (novad) return heartbeatText(novad, now);
  return d.lastSeenAt ? S.seen({ when: formatWhen(d.lastSeenAt, now) }) : S.notSeen;
}

/** How the Hub reaches it, or how it reaches the Hub (FR-140). */
export function reachText(d: DeviceSummaryView, novad: DeviceView | null): string | null {
  if (d.status === 'revoked') return null;
  if (isSessionDevice(d)) return d.sessions ? S.signedIn({ n: d.sessions }) : S.signedOut;
  if (novad?.endpoint && d.status === 'active') return S.reachedAt({ endpoint: novad.endpoint });
  if (d.status === 'unreachable') return S.notReachable;
  return null;
}

export const HEARTBEAT_TICK_MS = 30_000;

interface ListData {
  all: DeviceSummaryView[];
  /** novad details by device id; null when they could not be loaded. */
  novad: Map<string, DeviceView> | null;
  novadError: unknown;
}

function DeviceList() {
  const api = useDevicesApi();
  const toast = useToast();
  const list = useLoad<ListData>(async () => {
    const [all, novad] = await Promise.all([
      api.listAllDevices(),
      api.listNovadDevices().then(
        (r) => ({ items: r.items, error: null as unknown }),
        (error: unknown) => ({ items: null, error }),
      ),
    ]);
    return {
      all: all.items,
      novad: novad.items ? new Map(novad.items.map((d) => [d.id, d])) : null,
      novadError: novad.error,
    };
  }, 'devices');
  const [now, setNow] = useState(() => Date.now());
  const [waking, setWaking] = useState<string | null>(null);
  useInterval(() => setNow(Date.now()), HEARTBEAT_TICK_MS);
  const tls = useDeviceTls();
  const tlsOf = new Map((tls?.data?.items ?? []).map((v) => [v.deviceId, v]));

  const reload = useDebounced(list.reload, 150);
  useDeviceEvents(DEVICE_ROW_EVENTS, reload);

  const nameOf = (id: string) => list.data?.all.find((x) => x.id === id)?.name ?? null;
  const wake = async (d: DeviceSummaryView) => {
    setWaking(d.id);
    try {
      const w = await api.wakeDevice(d.id);
      toast.show(wakeSentText(d.name, w, nameOf), { tone: 'success' });
    } catch (err) {
      toast.show(deviceErrorMessage(err, S.wakeFailed({ name: d.name })), { tone: 'error' });
    } finally {
      setWaking(null);
    }
  };

  const items = list.data ? sortDevices(list.data.all) : null;
  const novad = list.data?.novad ?? null;
  return (
    <div className="ws-page devices-page">
      <header className="ws-page-header">
        <h1>{S.title}</h1>
        <Button variant="primary" onClick={() => navigate(DEVICES_ADD_PATH)}>
          <Icon name="plus" /> {S.add}
        </Button>
      </header>
      <p className="muted ws-flush">
        {rich(S.intro, {
          link: (
            <a href="/settings/devices" onClick={(e) => followLink(e, '/settings/devices')}>
              {S.settingsDevices}
            </a>
          ),
        })}
      </p>
      <PendingRequests onChange={reload} />
      {list.error ? (
        <LoadError error={list.error} fallback={S.loadFailed} onRetry={list.reload} />
      ) : null}
      {list.data?.novadError ? (
        <LoadError error={list.data.novadError} fallback={S.novadFailed} onRetry={list.reload} />
      ) : null}
      {list.loading ? <Spinner label={S.loading} /> : null}
      {items?.length === 0 ? (
        <EmptyState
          title={S.emptyTitle}
          description={S.emptyHelp}
          icon="server"
          level={2}
          action={<Button onClick={() => navigate(DEVICES_ADD_PATH)}>{S.addFirst}</Button>}
        />
      ) : null}
      {items?.length ? (
        <ul className="ws-list" aria-label={S.title}>
          {items.map((d) => {
            const n = novad?.get(d.id) ?? null;
            const wakeable = n !== null && n.wake.wakeable && d.status === 'unreachable';
            const reach = reachText(d, n);
            const cert = tlsOf.get(d.id);
            return (
              <li key={d.id} className="ws-list-row devices-row" aria-label={d.name}>
                <div className="devices-row-main">
                  <div className="devices-row-head">
                    <a
                      href={devicePath(d.id)}
                      className="ws-card-link"
                      onClick={(e) => followLink(e, devicePath(d.id))}
                      dir="auto"
                    >
                      {d.name}
                    </a>
                    <DeviceStatusChip status={d.status} />
                    {n?.updateRequired && d.status !== 'revoked' ? <UpdateRequiredChip /> : null}
                    {cert && d.status !== 'revoked' ? <DeviceTlsChip view={cert} /> : null}
                  </div>
                  <span className="muted ws-row-meta">
                    <span>{rolesText(d.roles)}</span>
                    <span>{runsText(d, n)}</span>
                    {d.platform ? <span>{d.platform}</span> : null}
                    <span>{seenText(d, n, now)}</span>
                  </span>
                  {d.status !== 'revoked' ? (
                    <span className="muted ws-row-meta">
                      {n ? <span>{capabilitySummary(n)}</span> : null}
                      {n && !n.routingEligible ? <span>{S.keptOut}</span> : null}
                      {n?.configPending ? <span>{S.changesWaiting}</span> : null}
                      {reach ? <span>{reach}</span> : null}
                      {d.scopes.length ? (
                        <span>{S.scopes({ scopes: scopesText(d.scopes) })}</span>
                      ) : null}
                    </span>
                  ) : null}
                </div>
                {wakeable ? (
                  <Button
                    onClick={() => void wake(d)}
                    disabled={waking === d.id}
                    aria-label={S.wakeName({ name: d.name })}
                  >
                    {waking === d.id ? <Spinner /> : null} {S.wake}
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {tls ? <DeviceTlsSection tls={tls} /> : null}
      <OobEntry />
    </div>
  );
}
