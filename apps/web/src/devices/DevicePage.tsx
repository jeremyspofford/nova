// One device's page (docs/04 §9, docs/23; FR-140): its status, what it runs, its role and the
// scopes it was given (FR-132; editable), Wake through a Wake helper or the Hub (FR-138), and
// Revoke, which asks first and says what it does (docs/22 §4.5). A device running novad also has
// tabs for capabilities and Hub overrides (FR-142, FR-148), modules and services (FR-141,
// FR-145), power and Wake-on-LAN (FR-144), updates (FR-148), per-device policy (FR-150), files
// with grants, access requests and staged writes (FR-210), the agents using it as their computer
// (FR-081) and its local MCP servers. A browser or the app has its sessions instead. M7.5: the
// browser bridge to the user's own browser on a novad computer (FR-096), and Firmware (FR-146)
// and Boot (FR-143) tabs; the management channel (mutual TLS or plain HTTP) and Decommission
// with its approval and outcome (ADR-096 D1, D9); an Out-of-band tab when a BMC is linked
// (FR-147, /devices/<id>/oob[/<endpointId>]); and a compute node's policy, GPU memory and
// services (FR-126, FR-150).
import { useEffect, useId, useRef, useState } from 'react';
import type { DeviceDecommissionView, DeviceSummaryView, DeviceView } from '@nova/shared';
import { Button, Dialog, Icon, Spinner, Tabs, TextField, useToast } from '@nova/ui';
import { ApiError } from '../api.ts';
import { BrowserBridgeSection } from '../browserdevice/BridgeSection.tsx';
import { pageNav, thisDeviceId } from '../join/store.ts';
import { formatWhen, plural } from '../settings/common.ts';
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
  SCOPE_TEXT,
  deviceErrorMessage,
  devicePath,
  isSessionDevice,
  rolesText,
  runsText,
  scopeChoices,
  scopeLabel,
  tabFrom,
  wakeSentText,
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
import { DeviceTlsFact } from './Tls.tsx';
import { DecommissionButton, DecommissionStatus } from './Decommission.tsx';
import { NodePanel } from './NodePanel.tsx';
import { ManagementFact } from './ops.tsx';
import { OOB_TAB, openDeviceOobTab, useDeviceOobTab } from '../oob/OobPage.tsx';
import { UpdatesPanel } from './Updates.tsx';
import { BootPanel } from '../boot/BootPanel.tsx';
import { FirmwarePanel } from '../firmware/FirmwarePanel.tsx';

/**
 * M7.5 tabs after the M6 ones (FR-146, FR-143): `?tab=firmware`, `?tab=boot`, or the path
 * `/devices/<id>/boot` the boot area's notifications link to.
 */
const M75_TABS = ['firmware', 'boot'] as const;
type PageTab = DeviceTab | (typeof M75_TABS)[number];
const PAGE_TABS: readonly PageTab[] = [...DEVICE_TABS, ...M75_TABS];
const isM75Tab = (t: string | undefined): t is (typeof M75_TABS)[number] =>
  (M75_TABS as readonly (string | undefined)[]).includes(t);

function pageTabFrom(loc: string): PageTab {
  const q = loc.indexOf('?');
  const search = q < 0 ? '' : loc.slice(q);
  const named = new URLSearchParams(search).get('tab') ?? undefined;
  if (isM75Tab(named)) return named;
  const sub = (q < 0 ? loc : loc.slice(0, q)).split('/').filter(Boolean)[2];
  if (!named && isM75Tab(sub)) return sub;
  return tabFrom(search);
}

function pageTabPath(id: string, tab: PageTab): string {
  return isM75Tab(tab) ? `${devicePath(id)}?tab=${tab}` : devicePath(id, tab);
}

const TAB_LABEL: Record<PageTab, string> = {
  firmware: 'Firmware',
  boot: 'Boot',
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
  /** Another device's name by id (a Wake helper), when known. */
  deviceName?: (id: string) => string | null;
}

/** What revoking does, in words (docs/22 §4.5). */
export function revokeText(opts: { novad: boolean; session: boolean; self: boolean }): string {
  const parts = [
    opts.session
      ? 'Its sessions end at once and its key is blocked.'
      : 'Its credential stops working at once and its key is blocked.',
  ];
  if (opts.novad)
    parts.push(
      'Agents using it as their computer are disconnected, and every folder it shared is closed.',
    );
  parts.push('To use it again, add it with a new code.');
  if (opts.self) parts.push('This is the device you are using: you will be signed out here.');
  return parts.join(' ');
}

export function DevicePage({ deviceId }: { deviceId: string }) {
  const api = useDevicesApi();
  const toast = useToast();
  const loc = useLocation();
  const tab = pageTabFrom(loc);
  // novad details, or null for a device that does not run novad (a 404 there).
  const dev = useLoad<DeviceView | null>(
    () =>
      api.getNovadDevice(deviceId).catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }),
    deviceId,
  );
  const all = useLoad(() => api.listAllDevices().then((r) => r.items), `all:${deviceId}`);
  const [renaming, setRenaming] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [editing, setEditing] = useState(false);
  const [waking, setWaking] = useState(false);
  // M7.5: a decommission asked here (D9), and the Out-of-band tab when a BMC is linked (FR-147).
  const [decommission, setDecommission] = useState<DeviceDecommissionView | null>(null);
  const oob = useDeviceOobTab(
    deviceId,
    dev.data?.name ?? all.data?.find((x) => x.id === deviceId)?.name ?? '',
  );
  const reloadDev = useDebounced(dev.reload, 150);
  const reloadAll = useDebounced(all.reload, 150);
  useDeviceEvents(DEVICE_ROW_EVENTS, (env) => {
    if (eventDeviceId(env) !== deviceId) return;
    reloadDev();
    reloadAll();
  });

  const d = dev.data;
  const s = all.data?.find((x) => x.id === deviceId) ?? null;
  const nameOf = (id: string) => all.data?.find((x) => x.id === id)?.name ?? null;
  const loading = (dev.loading && !dev.error) || (all.loading && !all.error);

  if (!d && !s) {
    const gone = !loading && !dev.error && dev.data === null && all.data !== null;
    return (
      <div className="ws-page devices-page">
        <Breadcrumb />
        {gone ? (
          <div role="alert" className="ws-error">
            <p>This device is not on this Hub.</p>
            <Button onClick={() => navigate(DEVICES_PATH)}>Back to devices</Button>
          </div>
        ) : dev.error || (all.error && !loading) ? (
          <LoadError
            error={dev.error ?? all.error}
            fallback="Could not load the device."
            onRetry={() => {
              dev.reload();
              all.reload();
            }}
          />
        ) : (
          <Spinner label="Loading the device" />
        )}
      </div>
    );
  }

  const name = d?.name ?? s?.name ?? '';
  const status = d?.status ?? s?.status ?? 'pending';
  const roles = d?.roles ?? s?.roles ?? [];
  const revoked = status === 'revoked';
  const session = s ? isSessionDevice(s) : false;
  const self = thisDeviceId() === deviceId;

  const setDevice = (next: DeviceView) => dev.setData(() => next);
  const wake = async () => {
    if (!d) return;
    setWaking(true);
    try {
      const w = await api.wakeDevice(d.id);
      toast.show(wakeSentText(d.name, w, nameOf), { tone: 'success' });
    } catch (err) {
      toast.show(deviceErrorMessage(err, `Could not wake ${d.name}.`), { tone: 'error' });
    } finally {
      setWaking(false);
    }
  };
  const props: PanelProps | null = d
    ? { device: d, onDevice: setDevice, reload: dev.reload, deviceName: nameOf }
    : null;
  const panels: Record<PageTab, React.ReactNode> | null = props
    ? {
        firmware: <FirmwarePanel {...props} />,
        boot: <BootPanel {...props} />,
        capabilities: <CapabilitiesPanel {...props} />,
        modules: <ModulesPanel {...props} />,
        power: <PowerPanel {...props} />,
        updates: <UpdatesPanel {...props} />,
        policy: <PolicyPanel {...props} />,
        files: <FilesPanel {...props} />,
        agents: <DeviceAgentsPanel {...props} />,
        mcp: <McpPanel {...props} />,
      }
    : null;

  return (
    <div className="ws-page devices-page">
      <Breadcrumb />
      <header className="ws-page-header">
        <div className="devices-title">
          <h1>{name}</h1>
          <DeviceStatusChip status={status} />
          {d?.updateRequired && !revoked ? <UpdateRequiredChip /> : null}
          {self && !revoked ? <span className="ws-badge">This device</span> : null}
        </div>
        {!revoked ? (
          <div className="row">
            {d?.wake.wakeable && d.status !== 'active' ? (
              <Button onClick={() => void wake()} disabled={waking}>
                {waking ? <Spinner /> : null} Wake
              </Button>
            ) : null}
            {d ? (
              <Button onClick={() => setRenaming(true)}>
                <Icon name="edit" /> Rename
              </Button>
            ) : null}
            {d ? <DecommissionButton device={d} onRequested={setDecommission} /> : null}
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
          <dd>{rolesText(roles)}</dd>
        </div>
        <div>
          <dt>Runs</dt>
          <dd>{s ? runsText(s, d) : d?.novadVersion ? `novad ${d.novadVersion}` : 'novad'}</dd>
        </div>
        <div>
          <dt>Platform</dt>
          <dd>{d?.platform ?? s?.platform ?? 'Unknown'}</dd>
        </div>
        <div>
          <dt>{d ? 'Last heartbeat' : 'Last seen'}</dt>
          <dd>{formatWhen(d?.lastSeenAt ?? s?.lastSeenAt ?? null)}</dd>
        </div>
        {d ? (
          <div>
            <dt>Address</dt>
            <dd>{d.endpoint ? <code className="ws-code-inline">{d.endpoint}</code> : 'Unknown'}</dd>
          </div>
        ) : null}
        {d || s?.kind === 'compute' ? <DeviceTlsFact deviceId={deviceId} /> : null}
        {d ? <ManagementFact deviceId={deviceId} /> : null}
        {session && s ? (
          <div>
            <dt>Sessions</dt>
            <dd>{s.sessions ? plural(s.sessions, 'live session') : 'Signed out'}</dd>
          </div>
        ) : null}
        <div>
          <dt>Added</dt>
          <dd>{formatWhen(d?.createdAt ?? s?.createdAt ?? null)}</dd>
        </div>
        {s ? (
          <div>
            <dt>Key</dt>
            <dd>
              <code className="ws-code-inline" title={s.fingerprint}>
                {s.fingerprint.slice(0, 16)}…
              </code>
            </dd>
          </div>
        ) : null}
      </dl>
      {revoked ? (
        <p className="devices-note" role="status">
          <Icon name="stop" /> This device was revoked: it can no longer reach this Hub. To use it
          again, add it with a new code.
        </p>
      ) : d?.configPending ? (
        <p className="devices-note" role="status">
          <Icon name="clock" /> Your latest changes reach the device when it next checks in.
        </p>
      ) : null}
      {d ? (
        <DecommissionStatus
          deviceId={deviceId}
          latest={decommission}
          onChanged={() => {
            dev.reload();
            all.reload();
          }}
        />
      ) : null}
      {s ? (
        <ScopesSection device={s} revoked={revoked} onEdit={() => setEditing(true)} />
      ) : all.error ? (
        <LoadError
          error={all.error}
          fallback="Could not load the device's scopes."
          onRetry={all.reload}
        />
      ) : null}
      {!d && s?.kind === 'compute' && !s.addedAs ? (
        <p className="muted ws-flush">
          Its models and load are in{' '}
          <a href="/settings/devices" onClick={(e) => followLink(e, '/settings/devices')}>
            Settings → Devices
          </a>
          .
        </p>
      ) : null}
      {/* M7.5 (FR-126, FR-150): a compute node's policy, GPU memory and services. */}
      {!d && s?.kind === 'compute' ? <NodePanel deviceId={deviceId} /> : null}
      {/* M7.5 (FR-096): the extension bridge to the user's own browser on this computer. */}
      {d && !revoked ? <BrowserBridgeSection device={d} /> : null}
      {d && panels ? (
        <Tabs
          label="Device sections"
          className="devices-tabs"
          value={oob.active ? OOB_TAB : tab}
          onChange={(id) =>
            id === OOB_TAB
              ? openDeviceOobTab(d.id)
              : navigate(pageTabPath(d.id, id as PageTab), { replace: true })
          }
          items={[
            ...PAGE_TABS.map((t) => ({ id: t, label: TAB_LABEL[t], panel: panels[t] })),
            ...(oob.item ? [oob.item] : []),
          ]}
        />
      ) : null}
      {renaming && d ? (
        <RenameDialog device={d} onClose={() => setRenaming(false)} onSaved={setDevice} />
      ) : null}
      {editing && s ? (
        <ScopesDialog
          device={s}
          onClose={() => setEditing(false)}
          onSaved={(next) => {
            all.setData((cur) => cur?.map((x) => (x.id === next.id ? next : x)) ?? null);
            setEditing(false);
            toast.show(`Scopes of ${next.name} saved.`, { tone: 'success' });
          }}
        />
      ) : null}
      <ConfirmDialog
        open={revoking}
        title={`Revoke ${name}?`}
        description={revokeText({ novad: d !== null, session, self })}
        confirmLabel="Revoke"
        danger
        onClose={() => setRevoking(false)}
        onConfirm={async () => {
          await api.revokeDevice(deviceId);
          setRevoking(false);
          if (self) {
            pageNav.assign('/');
            return;
          }
          if (d) setDevice({ ...d, status: 'revoked' });
          all.setData(
            (cur) =>
              cur?.map((x) => (x.id === deviceId ? { ...x, status: 'revoked' as const } : x)) ??
              null,
          );
          toast.show(`${name} revoked.`, { tone: 'success' });
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

/** The scopes the device was given (docs/22 §4.2), with Edit. */
function ScopesSection({
  device,
  revoked,
  onEdit,
}: {
  device: DeviceSummaryView;
  revoked: boolean;
  onEdit: () => void;
}) {
  return (
    <section className="ws-section devices-flat" aria-labelledby="device-scopes-h">
      <div className="ws-section-header">
        <h2 id="device-scopes-h">Scopes</h2>
        {!revoked ? <Button onClick={onEdit}>Edit scopes</Button> : null}
      </div>
      {device.scopes.length ? (
        <ul className="devices-scopes" aria-label="Scopes">
          {device.scopes.map((sc) => (
            <li key={sc}>
              <strong>{scopeLabel(sc)}</strong>
              {SCOPE_TEXT[sc] ? <span className="muted"> {SCOPE_TEXT[sc].help}</span> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted ws-flush">
          No extra scopes: it uses Nova as its role allows, and nothing else.
        </p>
      )}
    </section>
  );
}

function ScopesDialog({
  device,
  onClose,
  onSaved,
}: {
  device: DeviceSummaryView;
  onClose: () => void;
  onSaved: (d: DeviceSummaryView) => void;
}) {
  const api = useDevicesApi();
  const id = useId();
  const [choices] = useState(() => scopeChoices(device.roles, device.scopes));
  const [picked, setPicked] = useState<string[]>(device.scopes);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      onSaved(
        await api.setDeviceScopes(
          device.id,
          choices.filter((c) => picked.includes(c)),
        ),
      );
    } catch (err) {
      setError(deviceErrorMessage(err, 'Could not save the scopes.'));
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      title={`Scopes of ${device.name}`}
      description="What this device may do besides its role. Folders, the browser and the screen still ask before each use."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy} onClick={() => void save()}>
            {busy ? <Spinner /> : null} Save
          </Button>
        </>
      }
    >
      {choices.length ? (
        <fieldset className="ws-fieldset devices-roles">
          <legend>Scopes</legend>
          {choices.map((sc) => (
            <label key={sc} className="nv-radio">
              <input
                type="checkbox"
                checked={picked.includes(sc)}
                aria-labelledby={`${id}-${sc}-label`}
                aria-describedby={SCOPE_TEXT[sc] ? `${id}-${sc}` : undefined}
                onChange={(e) =>
                  setPicked((cur) =>
                    e.target.checked ? [...cur, sc] : cur.filter((x) => x !== sc),
                  )
                }
              />
              <span className="nv-radio-text">
                <span id={`${id}-${sc}-label`}>{scopeLabel(sc)}</span>
                {SCOPE_TEXT[sc] ? (
                  <span id={`${id}-${sc}`} className="nv-field-hint">
                    {SCOPE_TEXT[sc].help}
                  </span>
                ) : null}
              </span>
            </label>
          ))}
        </fieldset>
      ) : (
        <p className="muted">This device’s role has no scopes to choose.</p>
      )}
      {error ? (
        <p role="alert" className="nv-field-error">
          {error}
        </p>
      ) : null}
    </Dialog>
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
