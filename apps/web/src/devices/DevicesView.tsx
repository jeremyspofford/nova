// Devices (docs/04 §9, docs/23; FR-141..FR-150, FR-210, FR-081): computers running `novad`.
// /devices lists every device with its role, status, version, last heartbeat and what it can do;
// /devices/add enrolls a new one; /devices/:id is one device's page. Compute nodes that only run
// models (M2) stay in Settings → Devices, linked from here.
import { useState } from 'react';
import type { DeviceView } from '@nova/shared';
import { Button, EmptyState, Icon, Spinner, useToast } from '@nova/ui';
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
  rolesText,
} from './format.ts';
import { DeviceStatusChip, LoadError, UpdateRequiredChip, useLoad } from './parts.tsx';
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
export function sortDevices(list: readonly DeviceView[]): DeviceView[] {
  return [...list].sort((a, b) => Number(a.status === 'revoked') - Number(b.status === 'revoked'));
}

/** "last heartbeat 5 min ago" or "no heartbeat yet". */
export function heartbeatText(d: Pick<DeviceView, 'lastSeenAt'>, now: number): string {
  return d.lastSeenAt ? `last heartbeat ${formatWhen(d.lastSeenAt, now)}` : 'no heartbeat yet';
}

export const HEARTBEAT_TICK_MS = 30_000;

function DeviceList() {
  const api = useDevicesApi();
  const toast = useToast();
  const list = useLoad(() => api.listNovadDevices().then((r) => r.items), 'devices');
  const [now, setNow] = useState(() => Date.now());
  const [waking, setWaking] = useState<string | null>(null);
  useInterval(() => setNow(Date.now()), HEARTBEAT_TICK_MS);

  const reload = useDebounced(list.reload, 150);
  useDeviceEvents(DEVICE_ROW_EVENTS, reload);

  const wake = async (d: DeviceView) => {
    setWaking(d.id);
    try {
      const w = await api.wakeDevice(d.id);
      toast.show(`Wake signal sent to ${d.name} (${w.mac}).`, { tone: 'success' });
    } catch (err) {
      toast.show(deviceErrorMessage(err, `Could not wake ${d.name}.`), { tone: 'error' });
    } finally {
      setWaking(null);
    }
  };

  const items = list.data ? sortDevices(list.data) : null;
  return (
    <div className="ws-page devices-page">
      <header className="ws-page-header">
        <h1>Devices</h1>
        <Button variant="primary" onClick={() => navigate(DEVICES_ADD_PATH)}>
          <Icon name="plus" /> Add device
        </Button>
      </header>
      <p className="muted ws-flush">
        Computers running novad: what each one can do, its modules, power, updates, and the folders
        it shares. Compute nodes that only run models are in{' '}
        <a href="/settings/devices" onClick={(e) => followLink(e, '/settings/devices')}>
          Settings → Devices
        </a>
        .
      </p>
      {list.error ? (
        <LoadError error={list.error} fallback="Could not load devices." onRetry={list.reload} />
      ) : null}
      {list.loading ? <Spinner label="Loading devices" /> : null}
      {items?.length === 0 ? (
        <EmptyState
          title="No devices yet"
          description="Add a computer by running one command on it. It can then share folders with agents, run modules and wake on request."
          icon="server"
          level={2}
          action={<Button onClick={() => navigate(DEVICES_ADD_PATH)}>Add a device</Button>}
        />
      ) : null}
      {items?.length ? (
        <ul className="ws-list" aria-label="Devices">
          {items.map((d) => {
            const wakeable = d.wake.wakeable && d.status === 'unreachable';
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
                    {d.updateRequired && d.status !== 'revoked' ? <UpdateRequiredChip /> : null}
                  </div>
                  <span className="muted ws-row-meta">
                    <span>{rolesText(d.roles)}</span>
                    <span>{d.novadVersion ? `novad ${d.novadVersion}` : 'Version unknown'}</span>
                    {d.platform ? <span>{d.platform}</span> : null}
                    <span>{heartbeatText(d, now)}</span>
                  </span>
                  {d.status !== 'revoked' ? (
                    <span className="muted ws-row-meta">
                      <span>{capabilitySummary(d)}</span>
                      {!d.routingEligible ? <span>Kept out of agent work</span> : null}
                      {d.configPending ? <span>Changes waiting for the device</span> : null}
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
