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
import { defineMessages } from '@nova/i18n';
import { ApiError } from '../api.ts';
import { rich } from '../i18n/rich.tsx';
import { BrowserBridgeSection } from '../browserdevice/BridgeSection.tsx';
import { pageNav, thisDeviceId } from '../join/store.ts';
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

export const PAGE_TEXT = defineMessages('devices.page', {
  tabs: {
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
  },
  sections: 'Device sections',
  revoke: {
    sessions: 'Its sessions end at once and its key is blocked.',
    credential: 'Its credential stops working at once and its key is blocked.',
    novad:
      'Agents using it as their computer are disconnected, and every folder it shared is closed.',
    again: 'To use it again, add it with a new code.',
    self: 'This is the device you are using: you will be signed out here.',
    title: 'Revoke {name}?',
    confirm: 'Revoke',
    done: '{name} revoked.',
  },
  notOnHub: 'This device is not on this Hub.',
  back: 'Back to devices',
  loadFailed: 'Could not load the device.',
  loading: 'Loading the device',
  refreshFailed: 'Could not refresh the device.',
  wakeFailed: 'Could not wake {name}.',
  thisDevice: 'This device',
  wake: 'Wake',
  rename: 'Rename',
  facts: {
    role: 'Role',
    runs: 'Runs',
    platform: 'Platform',
    lastHeartbeat: 'Last heartbeat',
    lastSeen: 'Last seen',
    address: 'Address',
    sessions: 'Sessions',
    added: 'Added',
    key: 'Key',
  },
  novad: 'novad',
  novadVersion: 'novad {version}',
  unknown: 'Unknown',
  liveSessions: '{n, plural, one {# live session} other {# live sessions}}',
  signedOut: 'Signed out',
  revoked:
    'This device was revoked: it can no longer reach this Hub. To use it again, add it with a new code.',
  configPending: 'Your latest changes reach the device when it next checks in.',
  scopesFailed: "Could not load the device's scopes.",
  modelsIn: 'Its models and load are in {link}.',
  settingsDevices: 'Settings → Devices',
  breadcrumb: 'Breadcrumb',
  devices: 'Devices',
  scopes: {
    title: 'Scopes',
    edit: 'Edit scopes',
    none: 'No extra scopes: it uses Nova as its role allows, and nothing else.',
    saved: 'Scopes of {name} saved.',
    dialogTitle: 'Scopes of {name}',
    dialogHelp:
      'What this device may do besides its role. Folders, the browser and the screen still ask before each use.',
    noChoices: 'This device’s role has no scopes to choose.',
    saveFailed: 'Could not save the scopes.',
  },
  cancel: 'Cancel',
  save: 'Save',
  renameTitle: 'Rename device',
  name: 'Name',
  renameFailed: 'Could not rename the device.',
});
const S = PAGE_TEXT;
const TAB_LABEL: Readonly<Record<PageTab, string>> = S.tabs;

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
  // Whole sentences, each its own message, shown one after the other.
  const parts = [opts.session ? S.revoke.sessions : S.revoke.credential];
  if (opts.novad) parts.push(S.revoke.novad);
  parts.push(S.revoke.again);
  if (opts.self) parts.push(S.revoke.self);
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
            <p>{S.notOnHub}</p>
            <Button onClick={() => navigate(DEVICES_PATH)}>{S.back}</Button>
          </div>
        ) : dev.error || (all.error && !loading) ? (
          <LoadError
            error={dev.error ?? all.error}
            fallback={S.loadFailed}
            onRetry={() => {
              dev.reload();
              all.reload();
            }}
          />
        ) : (
          <Spinner label={S.loading} />
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
      toast.show(deviceErrorMessage(err, S.wakeFailed({ name: d.name })), { tone: 'error' });
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
          <h1 dir="auto">{name}</h1>
          <DeviceStatusChip status={status} />
          {d?.updateRequired && !revoked ? <UpdateRequiredChip /> : null}
          {self && !revoked ? <span className="ws-badge">{S.thisDevice}</span> : null}
        </div>
        {!revoked ? (
          <div className="row">
            {d?.wake.wakeable && d.status !== 'active' ? (
              <Button onClick={() => void wake()} disabled={waking}>
                {waking ? <Spinner /> : null} {S.wake}
              </Button>
            ) : null}
            {d ? (
              <Button onClick={() => setRenaming(true)}>
                <Icon name="edit" /> {S.rename}
              </Button>
            ) : null}
            {d ? <DecommissionButton device={d} onRequested={setDecommission} /> : null}
            <Button variant="danger" onClick={() => setRevoking(true)}>
              {S.revoke.confirm}
            </Button>
          </div>
        ) : null}
      </header>
      {dev.error ? (
        <LoadError error={dev.error} fallback={S.refreshFailed} onRetry={dev.reload} />
      ) : null}
      <dl className="devices-facts">
        <div>
          <dt>{S.facts.role}</dt>
          <dd>{rolesText(roles)}</dd>
        </div>
        <div>
          <dt>{S.facts.runs}</dt>
          <dd>
            {s
              ? runsText(s, d)
              : d?.novadVersion
                ? S.novadVersion({ version: d.novadVersion })
                : S.novad}
          </dd>
        </div>
        <div>
          <dt>{S.facts.platform}</dt>
          <dd>{d?.platform ?? s?.platform ?? S.unknown}</dd>
        </div>
        <div>
          <dt>{d ? S.facts.lastHeartbeat : S.facts.lastSeen}</dt>
          <dd>{formatWhen(d?.lastSeenAt ?? s?.lastSeenAt ?? null)}</dd>
        </div>
        {d ? (
          <div>
            <dt>{S.facts.address}</dt>
            <dd>
              {d.endpoint ? (
                <code className="ws-code-inline" dir="ltr">
                  {d.endpoint}
                </code>
              ) : (
                S.unknown
              )}
            </dd>
          </div>
        ) : null}
        {d || s?.kind === 'compute' ? <DeviceTlsFact deviceId={deviceId} /> : null}
        {d ? <ManagementFact deviceId={deviceId} /> : null}
        {session && s ? (
          <div>
            <dt>{S.facts.sessions}</dt>
            <dd>{s.sessions ? S.liveSessions({ n: s.sessions }) : S.signedOut}</dd>
          </div>
        ) : null}
        <div>
          <dt>{S.facts.added}</dt>
          <dd>{formatWhen(d?.createdAt ?? s?.createdAt ?? null)}</dd>
        </div>
        {s ? (
          <div>
            <dt>{S.facts.key}</dt>
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
          <Icon name="stop" /> {S.revoked}
        </p>
      ) : d?.configPending ? (
        <p className="devices-note" role="status">
          <Icon name="clock" /> {S.configPending}
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
        <LoadError error={all.error} fallback={S.scopesFailed} onRetry={all.reload} />
      ) : null}
      {!d && s?.kind === 'compute' && !s.addedAs ? (
        <p className="muted ws-flush">
          {rich(S.modelsIn, {
            link: (
              <a href="/settings/devices" onClick={(e) => followLink(e, '/settings/devices')}>
                {S.settingsDevices}
              </a>
            ),
          })}
        </p>
      ) : null}
      {/* M7.5 (FR-126, FR-150): a compute node's policy, GPU memory and services. */}
      {!d && s?.kind === 'compute' ? <NodePanel deviceId={deviceId} /> : null}
      {/* M7.5 (FR-096): the extension bridge to the user's own browser on this computer. */}
      {d && !revoked ? <BrowserBridgeSection device={d} /> : null}
      {d && panels ? (
        <Tabs
          label={S.sections}
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
            toast.show(S.scopes.saved({ name: next.name }), { tone: 'success' });
          }}
        />
      ) : null}
      <ConfirmDialog
        open={revoking}
        title={S.revoke.title({ name })}
        description={revokeText({ novad: d !== null, session, self })}
        confirmLabel={S.revoke.confirm}
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
          toast.show(S.revoke.done({ name }), { tone: 'success' });
        }}
      />
    </div>
  );
}

function Breadcrumb() {
  return (
    <nav aria-label={S.breadcrumb} className="ws-breadcrumb">
      <a href={DEVICES_PATH} onClick={(e) => followLink(e, DEVICES_PATH)}>
        <Icon name="back" /> {S.devices}
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
        <h2 id="device-scopes-h">{S.scopes.title}</h2>
        {!revoked ? <Button onClick={onEdit}>{S.scopes.edit}</Button> : null}
      </div>
      {device.scopes.length ? (
        <ul className="devices-scopes" aria-label={S.scopes.title}>
          {device.scopes.map((sc) => (
            <li key={sc}>
              <strong>{scopeLabel(sc)}</strong>
              {SCOPE_TEXT[sc] ? <span className="muted"> {SCOPE_TEXT[sc].help}</span> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted ws-flush">{S.scopes.none}</p>
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
      setError(deviceErrorMessage(err, S.scopes.saveFailed));
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      title={S.scopes.dialogTitle({ name: device.name })}
      description={S.scopes.dialogHelp}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{S.cancel}</Button>
          <Button variant="primary" disabled={busy} onClick={() => void save()}>
            {busy ? <Spinner /> : null} {S.save}
          </Button>
        </>
      }
    >
      {choices.length ? (
        <fieldset className="ws-fieldset devices-roles">
          <legend>{S.scopes.title}</legend>
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
        <p className="muted">{S.scopes.noChoices}</p>
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
      setError(deviceErrorMessage(err, S.renameFailed));
      setBusy(false);
    }
  };
  return (
    <Dialog open title={S.renameTitle} onClose={onClose} initialFocusRef={ref}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <TextField
          ref={ref}
          label={S.name}
          value={name}
          maxLength={100}
          onChange={(e) => setName(e.target.value)}
          error={error ?? undefined}
        />
        <div className="nv-dialog-footer">
          <Button onClick={onClose}>{S.cancel}</Button>
          <Button type="submit" variant="primary" disabled={!name.trim() || busy}>
            {S.save}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
