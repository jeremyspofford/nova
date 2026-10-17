// One device's page (docs/04 §9, docs/23): its status, version and heartbeat, then tabs for
// capabilities and Hub overrides (FR-142, FR-148), modules and services (FR-141, FR-145), power
// and Wake-on-LAN (FR-144), updates (FR-148), per-device policy (FR-150), files with grants,
// access requests and staged writes (FR-210), the agents using it as their computer (FR-081) and
// its local MCP servers. Rename and Revoke sit in the header; Revoke asks first.
import { useEffect, useRef, useState } from 'react';
import type { DeviceView } from '@nova/shared';
import { Button, Dialog, Icon, Spinner, Tabs, TextField, useToast } from '@nova/ui';
import { ApiError } from '../api.ts';
import { formatWhen } from '../settings/common.ts';
import { navigate, useLocation } from '../router.ts';
import { useDebounced } from '../work/events.ts';
import { followLink } from '../work/nav.tsx';
import { useDevicesApi } from './api.ts';
import { CapabilitiesPanel } from './Capabilities.tsx';
import { DeviceAgentsPanel } from './Connections.tsx';
import { DEVICE_ROW_EVENTS, eventDeviceId, useDeviceEvents } from './events.ts';
import { FilesPanel } from './Files.tsx';
import {
  DEVICES_PATH,
  DEVICE_TABS,
  deviceErrorMessage,
  devicePath,
  rolesText,
  tabFrom,
  type DeviceTab,
} from './format.ts';
import { McpPanel } from './Mcp.tsx';
import { ModulesPanel } from './Modules.tsx';
import {
  ConfirmDialog,
  DeviceStatusChip,
  LoadError,
  UpdateRequiredChip,
  useLoad,
} from './parts.tsx';
import { PolicyPanel } from './Policy.tsx';
import { PowerPanel } from './Power.tsx';
import { UpdatesPanel } from './Updates.tsx';

const TAB_LABEL: Record<DeviceTab, string> = {
  capabilities: 'Capabilities',
  modules: 'Modules',
  power: 'Power',
  updates: 'Updates',
  policy: 'Policy',
  files: 'Files',
  agents: 'Agents',
  mcp: 'MCP',
};

/** What a device panel gets: the device as last loaded, and a way to replace it. */
export interface PanelProps {
  device: DeviceView;
  onDevice: (d: DeviceView) => void;
  /** Load the device again (after an action that changes it). */
  reload: () => void;
}

export function DevicePage({ deviceId }: { deviceId: string }) {
  const api = useDevicesApi();
  const toast = useToast();
  const loc = useLocation();
  const tab = tabFrom(loc.includes('?') ? loc.slice(loc.indexOf('?')) : '');
  const dev = useLoad(() => api.getNovadDevice(deviceId), deviceId);
  const [renaming, setRenaming] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [waking, setWaking] = useState(false);
  const reload = useDebounced(dev.reload, 150);
  useDeviceEvents(DEVICE_ROW_EVENTS, (env) => {
    if (eventDeviceId(env) === deviceId) reload();
  });

  const d = dev.data;
  const gone = dev.error instanceof ApiError && dev.error.status === 404;

  if (!d) {
    return (
      <div className="ws-page devices-page">
        <Breadcrumb />
        {gone ? (
          <div role="alert" className="ws-error">
            <p>This device is not on this Hub.</p>
            <Button onClick={() => navigate(DEVICES_PATH)}>Back to devices</Button>
          </div>
        ) : dev.error ? (
          <LoadError error={dev.error} fallback="Could not load the device." onRetry={dev.reload} />
        ) : (
          <Spinner label="Loading the device" />
        )}
      </div>
    );
  }

  const setDevice = (next: DeviceView) => dev.setData(() => next);
  const wake = async () => {
    setWaking(true);
    try {
      const w = await api.wakeDevice(d.id);
      toast.show(`Wake signal sent to ${d.name} (${w.mac}).`, { tone: 'success' });
    } catch (err) {
      toast.show(deviceErrorMessage(err, `Could not wake ${d.name}.`), { tone: 'error' });
    } finally {
      setWaking(false);
    }
  };
  const props: PanelProps = { device: d, onDevice: setDevice, reload: dev.reload };
  const panels: Record<DeviceTab, React.ReactNode> = {
    capabilities: <CapabilitiesPanel {...props} />,
    modules: <ModulesPanel {...props} />,
    power: <PowerPanel {...props} />,
    updates: <UpdatesPanel {...props} />,
    policy: <PolicyPanel {...props} />,
    files: <FilesPanel {...props} />,
    agents: <DeviceAgentsPanel {...props} />,
    mcp: <McpPanel {...props} />,
  };
  const revoked = d.status === 'revoked';

  return (
    <div className="ws-page devices-page">
      <Breadcrumb />
      <header className="ws-page-header">
        <div className="devices-title">
          <h1>{d.name}</h1>
          <DeviceStatusChip status={d.status} />
          {d.updateRequired && !revoked ? <UpdateRequiredChip /> : null}
        </div>
        {!revoked ? (
          <div className="row">
            {d.wake.wakeable && d.status !== 'active' ? (
              <Button onClick={() => void wake()} disabled={waking}>
                {waking ? <Spinner /> : null} Wake
              </Button>
            ) : null}
            <Button onClick={() => setRenaming(true)}>
              <Icon name="edit" /> Rename
            </Button>
            <Button variant="danger" onClick={() => setRevoking(true)}>
              Revoke
            </Button>
          </div>
        ) : null}
      </header>
      {dev.error ? (
        <LoadError
          error={dev.error}
          fallback="Could not refresh the device."
          onRetry={dev.reload}
        />
      ) : null}
      <dl className="devices-facts">
        <div>
          <dt>Role</dt>
          <dd>{rolesText(d.roles)}</dd>
        </div>
        <div>
          <dt>Version</dt>
          <dd>{d.novadVersion ? `novad ${d.novadVersion}` : 'Unknown'}</dd>
        </div>
        <div>
          <dt>Platform</dt>
          <dd>{d.platform ?? 'Unknown'}</dd>
        </div>
        <div>
          <dt>Last heartbeat</dt>
          <dd>{formatWhen(d.lastSeenAt)}</dd>
        </div>
        <div>
          <dt>Address</dt>
          <dd>{d.endpoint ? <code className="ws-code-inline">{d.endpoint}</code> : 'Unknown'}</dd>
        </div>
        <div>
          <dt>Added</dt>
          <dd>{formatWhen(d.createdAt)}</dd>
        </div>
      </dl>
      {revoked ? (
        <p className="devices-note" role="status">
          <Icon name="stop" /> This device was revoked: it can no longer reach this Hub. To use it
          again, add it with a new command.
        </p>
      ) : d.configPending ? (
        <p className="devices-note" role="status">
          <Icon name="clock" /> Your latest changes reach the device when it next checks in.
        </p>
      ) : null}
      <Tabs
        label="Device sections"
        className="devices-tabs"
        value={tab}
        onChange={(id) => navigate(devicePath(d.id, id as DeviceTab), { replace: true })}
        items={DEVICE_TABS.map((t) => ({ id: t, label: TAB_LABEL[t], panel: panels[t] }))}
      />
      {renaming ? (
        <RenameDialog device={d} onClose={() => setRenaming(false)} onSaved={setDevice} />
      ) : null}
      <ConfirmDialog
        open={revoking}
        title={`Revoke ${d.name}?`}
        description="Its credential stops working at once, agents using it as their computer are disconnected, and every folder it shared is closed. To use it again, add it with a new command."
        confirmLabel="Revoke"
        danger
        onClose={() => setRevoking(false)}
        onConfirm={async () => {
          await api.revokeNovadDevice(d.id);
          setRevoking(false);
          setDevice({ ...d, status: 'revoked' });
          toast.show(`${d.name} revoked.`, { tone: 'success' });
        }}
      />
    </div>
  );
}

function Breadcrumb() {
  return (
    <nav aria-label="Breadcrumb" className="ws-breadcrumb">
      <a href={DEVICES_PATH} onClick={(e) => followLink(e, DEVICES_PATH)}>
        <Icon name="back" /> Devices
      </a>
    </nav>
  );
}

function RenameDialog({
  device,
  onClose,
  onSaved,
}: {
  device: DeviceView;
  onClose: () => void;
  onSaved: (d: DeviceView) => void;
}) {
  const api = useDevicesApi();
  const ref = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(device.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => ref.current?.select(), []);
  const save = async () => {
    const next = name.trim();
    if (!next || busy) return;
    setBusy(true);
    setError(null);
    try {
      onSaved(await api.updateNovadDevice(device.id, { name: next }));
      onClose();
    } catch (err) {
      setError(deviceErrorMessage(err, 'Could not rename the device.'));
      setBusy(false);
    }
  };
  return (
    <Dialog open title="Rename device" onClose={onClose} initialFocusRef={ref}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <TextField
          ref={ref}
          label="Name"
          value={name}
          maxLength={100}
          onChange={(e) => setName(e.target.value)}
          error={error ?? undefined}
        />
        <div className="nv-dialog-footer">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!name.trim() || busy}>
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
