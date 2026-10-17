// Devices (docs/04 §9, docs/23; FR-140, FR-132, FR-141..FR-150, FR-210, FR-081): every device of
// this Hub in one list, whatever it runs (browsers and the app, computers running `novad`,
// compute nodes), with its role, status, platform, last contact and how it is reached; requests
// to join wait at the top for approval. /devices/add adds a device; /devices/:id is one device's
// page. The models and load of compute nodes stay in Settings → Devices, linked from here.
import { useState } from 'react';
import type { DeviceSummaryView, DeviceView } from '@nova/shared';
import { Button, EmptyState, Icon, Spinner, useToast } from '@nova/ui';
import { formatWhen, plural, useInterval } from '../settings/common.ts';
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
import '../workspace.css';
import '../work/work.css';
import './devices.css';

export function DevicesView({ deviceId }: { deviceId: string | null }) {
  return (
    <DeviceEventsProvider>
      {deviceId === ADD_DEVICE_ID ? (
        <AddDevicePage />
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
  return d.lastSeenAt ? `last heartbeat ${formatWhen(d.lastSeenAt, now)}` : 'no heartbeat yet';
}

/** novad devices report heartbeats; everything else is "last seen". */
export function seenText(
  d: Pick<DeviceSummaryView, 'lastSeenAt'>,
  novad: Pick<DeviceView, 'lastSeenAt'> | null,
  now: number,
): string {
  if (novad) return heartbeatText(novad, now);
  return d.lastSeenAt ? `last seen ${formatWhen(d.lastSeenAt, now)}` : 'not seen yet';
}

/** How the Hub reaches it, or how it reaches the Hub (FR-140). */
export function reachText(d: DeviceSummaryView, novad: DeviceView | null): string | null {
  if (d.status === 'revoked') return null;
  if (isSessionDevice(d))
    return d.sessions ? `Signed in (${plural(d.sessions, 'session')})` : 'Signed out';
  if (novad?.endpoint && d.status === 'active') return `Reached at ${novad.endpoint}`;
  if (d.status === 'unreachable') return 'Not reachable now';
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

  const reload = useDebounced(list.reload, 150);
  useDeviceEvents(DEVICE_ROW_EVENTS, reload);

  const nameOf = (id: string) => list.data?.all.find((x) => x.id === id)?.name ?? null;
  const wake = async (d: DeviceSummaryView) => {
    setWaking(d.id);
    try {
      const w = await api.wakeDevice(d.id);
      toast.show(wakeSentText(d.name, w, nameOf), { tone: 'success' });
    } catch (err) {
      toast.show(deviceErrorMessage(err, `Could not wake ${d.name}.`), { tone: 'error' });
    } finally {
      setWaking(null);
    }
  };

  const items = list.data ? sortDevices(list.data.all) : null;
  const novad = list.data?.novad ?? null;
  return (
    <div className="ws-page devices-page">
      <header className="ws-page-header">
        <h1>Devices</h1>
        <Button variant="primary" onClick={() => navigate(DEVICES_ADD_PATH)}>
          <Icon name="plus" /> Add device
        </Button>
      </header>
      <p className="muted ws-flush">
        Everything that uses this Hub: browsers and phones, computers running novad, and compute
        nodes. Open one to change its scopes, wake it or revoke it. The models and load of compute
        nodes are in{' '}
        <a href="/settings/devices" onClick={(e) => followLink(e, '/settings/devices')}>
          Settings → Devices
        </a>
        .
      </p>
      <PendingRequests onChange={reload} />
      {list.error ? (
        <LoadError error={list.error} fallback="Could not load devices." onRetry={list.reload} />
      ) : null}
      {list.data?.novadError ? (
        <LoadError
          error={list.data.novadError}
          fallback="Could not load what the novad devices report."
          onRetry={list.reload}
        />
      ) : null}
      {list.loading ? <Spinner label="Loading devices" /> : null}
      {items?.length === 0 ? (
        <EmptyState
          title="No devices yet"
          description="Add a phone, a browser or a computer with a QR code or a short code. Computers can then share folders with agents, run modules and wake on request."
          icon="server"
          level={2}
          action={<Button onClick={() => navigate(DEVICES_ADD_PATH)}>Add a device</Button>}
        />
      ) : null}
      {items?.length ? (
        <ul className="ws-list" aria-label="Devices">
          {items.map((d) => {
            const n = novad?.get(d.id) ?? null;
            const wakeable = n !== null && n.wake.wakeable && d.status === 'unreachable';
            const reach = reachText(d, n);
            return (
              <li key={d.id} className="ws-list-row devices-row" aria-label={d.name}>
                <div className="devices-row-main">
                  <div className="devices-row-head">
                    <a
                      href={devicePath(d.id)}
                      className="ws-card-link"
                      onClick={(e) => followLink(e, devicePath(d.id))}
                    >
                      {d.name}
                    </a>
                    <DeviceStatusChip status={d.status} />
                    {n?.updateRequired && d.status !== 'revoked' ? <UpdateRequiredChip /> : null}
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
                      {n && !n.routingEligible ? <span>Kept out of agent work</span> : null}
                      {n?.configPending ? <span>Changes waiting for the device</span> : null}
                      {reach ? <span>{reach}</span> : null}
                      {d.scopes.length ? <span>Scopes: {scopesText(d.scopes)}</span> : null}
                    </span>
                  ) : null}
                </div>
                {wakeable ? (
                  <Button
                    onClick={() => void wake(d)}
                    disabled={waking === d.id}
                    aria-label={`Wake ${d.name}`}
                  >
                    {waking === d.id ? <Spinner /> : null} Wake
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
