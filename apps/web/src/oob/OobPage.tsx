// Out-of-band management (FR-147; docs/23 §7; ADR-096 D6), under Devices: /devices/oob shows
// whether it is on (off by default; turning it on asks for consent and says what it allows), the
// BMCs the owner registered with their kind, address, device, pinned certificate and last check,
// and Add a BMC; /devices/oob/<endpointId> is one BMC with its actions. A device with a linked BMC
// gets an "Out-of-band" tab (/devices/<id>/oob[/<endpointId>]); `?action=power.cycle` there, the
// link of a failed-boot alert, opens that action's confirmation. Owner only: a member gets the
// owner-only notice. The page leaves the router alone: /devices/oob parses as the devices route
// with the id `oob` (like /devices/add) and the rest is read from the location.
import { useState } from 'react';
import type { OobAction, OobEndpointView } from '@nova/shared';
import { Button, EmptyState, Icon, Spinner, useToast, type TabItem } from '@nova/ui';
import { defineMessages } from '@nova/i18n';
import { navigate, useLocation } from '../router.ts';
import { MemberGate } from '../team/role.tsx';
import { followLink } from '../work/nav.tsx';
import { DEVICES_PATH, devicePath } from '../devices/format.ts';
import { LoadError, PARTS_TEXT, useLoad } from '../devices/parts.tsx';
import { useDevicesApi } from '../devices/api.ts';
import { useOobApi, type OobApi } from './api-m75.ts';
import { EndpointView } from './Endpoint.tsx';
import { EndpointDialog } from './EndpointForm.tsx';
import {
  KIND_LABEL,
  OOB_PATH,
  OOB_TEXT,
  addressText,
  deviceOobPath,
  oobEndpointPath,
  oobErrorMessage,
  parseOobLocation,
} from './format.ts';
import {
  KindChip,
  LastCheck,
  OobSwitch,
  PinText,
  Section,
  useOobEndpoints,
  useOobLoad,
  useOobStatus,
} from './parts.tsx';
import './oob.css';

export const OOB_PAGE_TEXT = defineMessages('oob.page', {
  breadcrumb: 'Breadcrumb',
  devices: 'Devices',
  noClient: 'This version of the app cannot manage BMCs.',
  addOff: 'Turn out-of-band management on first',
  add: 'Add a BMC',
  intro:
    'Reach a computer through its BMC, the management controller built into servers and many business computers, over Redfish or IPMI: power it on or off, read its sensors, choose its next boot device or change BIOS settings, even when its operating system is down. Intel AMT is not available in this version.',
  loadFailed: 'Could not load out-of-band management.',
  loading: 'Loading out-of-band management',
  bmcs: 'BMCs',
  listFailed: 'Could not load the BMCs.',
  listLoading: 'Loading the BMCs',
  empty: 'No BMCs yet',
  emptyOn: 'Add the address and credentials of a machine’s BMC to manage it here.',
  emptyOff: 'Turn out-of-band management on, then add a machine’s BMC.',
  added: '{name} added.',
  manages: 'Manages {device}',
  linked: 'Linked to a device',
  notLinked: 'No device linked',
  noCredentials: 'Credentials missing',
  endpointFailed: 'Could not load the BMC.',
  back: 'Back to out-of-band management',
  endpointLoading: 'Loading the BMC',
  open: 'Open out-of-band management',
  stateOn: 'On, {n, plural, one {# BMC} other {# BMCs}}.',
  stateOff: 'Off.',
  about:
    'Power, sensors, the next boot device and BIOS settings through a machine’s BMC (Redfish or IPMI), even when its operating system is down.',
  tab: 'Out-of-band',
  unlinked: 'That BMC is not linked to this device any more.',
  noneLinked: 'No BMC is linked to this device.',
  reachable: '{device} can be reached through its BMC, below the operating system.',
  all: 'All BMCs',
  ofDevice: 'BMCs of this device',
  /** A BMC of the device: its name and kind ("Rack BMC (Redfish)"). */
  choice: '{name} ({kind})',
});

const S = OOB_PAGE_TEXT;

/** The device names by id, for showing which machine a BMC belongs to. */
function useDeviceNames(): (id: string | null) => string | null {
  const api = useDevicesApi() as Partial<ReturnType<typeof useDevicesApi>>;
  const all = useLoad(
    () =>
      typeof api.listAllDevices === 'function'
        ? api.listAllDevices().then((r) => r.items)
        : Promise.resolve([]),
    'oob-device-names',
  );
  return (id) => (id ? (all.data?.find((d) => d.id === id)?.name ?? null) : null);
}

function Breadcrumb({ endpoint }: { endpoint?: boolean }) {
  return (
    <nav aria-label={S.breadcrumb} className="ws-breadcrumb">
      <a href={DEVICES_PATH} onClick={(e) => followLink(e, DEVICES_PATH)}>
        <Icon name="back" /> {S.devices}
      </a>
      {endpoint ? (
        <>
          {' / '}
          <a href={OOB_PATH} onClick={(e) => followLink(e, OOB_PATH)}>
            {OOB_TEXT.title}
          </a>
        </>
      ) : null}
    </nav>
  );
}

/** /devices/oob and /devices/oob/<endpointId>. */
export function OobPage() {
  const loc = useLocation();
  const where = parseOobLocation(loc);
  const api = useOobApi();
  return (
    <MemberGate ownerOnly what={OOB_TEXT.title}>
      <div className="ws-page devices-page oob-page">
        <Breadcrumb endpoint={Boolean(where?.endpointId)} />
        {!api ? (
          <p className="muted">{S.noClient}</p>
        ) : where?.endpointId ? (
          <EndpointPage
            key={where.endpointId}
            api={api}
            endpointId={where.endpointId}
            action={where.action}
          />
        ) : (
          <Overview api={api} />
        )}
      </div>
    </MemberGate>
  );
}

function Overview({ api }: { api: OobApi }) {
  const toast = useToast();
  const status = useOobStatus(api);
  const list = useOobEndpoints(api);
  const nameOf = useDeviceNames();
  const [adding, setAdding] = useState(false);
  const on = status.data?.enabled === true;
  return (
    <>
      <header className="ws-page-header">
        <h1>{OOB_TEXT.title}</h1>
        <Button
          variant="primary"
          disabled={!on}
          title={on ? undefined : S.addOff}
          onClick={() => setAdding(true)}
        >
          <Icon name="plus" /> {S.add}
        </Button>
      </header>
      <p className="muted ws-flush">{S.intro}</p>
      {status.error ? (
        <LoadError error={status.error} fallback={S.loadFailed} onRetry={status.reload} />
      ) : null}
      {status.data ? (
        <OobSwitch api={api} status={status.data} onChange={(s) => status.setData(() => s)} />
      ) : status.loading ? (
        <Spinner label={S.loading} />
      ) : null}
      <Section id="oob-endpoints-h" title={S.bmcs}>
        {list.error ? (
          <p role="alert" className="ws-error">
            {oobErrorMessage(list.error, S.listFailed)}{' '}
            <Button onClick={list.reload}>{PARTS_TEXT.retry}</Button>
          </p>
        ) : null}
        {list.loading ? <Spinner label={S.listLoading} /> : null}
        {list.data?.length === 0 ? (
          <EmptyState
            title={S.empty}
            description={on ? S.emptyOn : S.emptyOff}
            icon="server"
            level={3}
          />
        ) : null}
        {list.data?.length ? (
          <ul className="ws-list" aria-label={S.bmcs}>
            {list.data.map((ep) => (
              <EndpointRow key={ep.id} ep={ep} deviceName={nameOf(ep.deviceId)} />
            ))}
          </ul>
        ) : null}
      </Section>
      {adding ? (
        <EndpointDialog
          api={api}
          endpoint={null}
          onClose={() => setAdding(false)}
          onSaved={(ep) => {
            setAdding(false);
            list.setData((cur) => [...(cur ?? []), ep]);
            toast.show(S.added({ name: ep.name }), { tone: 'success' });
            navigate(oobEndpointPath(ep.id));
          }}
        />
      ) : null}
    </>
  );
}

function EndpointRow({ ep, deviceName }: { ep: OobEndpointView; deviceName: string | null }) {
  const path = oobEndpointPath(ep.id);
  return (
    <li className="ws-list-row devices-row" aria-label={ep.name}>
      <div className="devices-row-main">
        <div className="devices-row-head">
          <a href={path} className="ws-card-link" dir="auto" onClick={(e) => followLink(e, path)}>
            {ep.name}
          </a>
          <KindChip kind={ep.kind} />
          {ep.kind !== 'amt' ? <LastCheck ep={ep} /> : null}
        </div>
        <span className="muted ws-row-meta">
          <span>{addressText(ep)}</span>
          <span>
            {deviceName ? S.manages({ device: deviceName }) : ep.deviceId ? S.linked : S.notLinked}
          </span>
          {ep.kind === 'redfish' ? (
            <span>
              <PinText ep={ep} />
            </span>
          ) : null}
          {!ep.hasCredentials ? <span>{S.noCredentials}</span> : null}
        </span>
      </div>
    </li>
  );
}

function EndpointPage({
  api,
  endpointId,
  action,
}: {
  api: OobApi;
  endpointId: string;
  action: OobAction | null;
}) {
  const status = useOobStatus(api);
  const nameOf = useDeviceNames();
  const ep = useOobLoad(
    () => api.getOobEndpoint(endpointId),
    `oob-endpoint:${endpointId}`,
    (p, name) => name === 'device.oob.endpoint.changed' && p.endpointId === endpointId,
  );
  if (ep.error && !ep.data)
    return (
      <div role="alert" className="ws-error">
        <p>{oobErrorMessage(ep.error, S.endpointFailed)}</p>
        <Button onClick={() => navigate(OOB_PATH)}>{S.back}</Button>
      </div>
    );
  if (!ep.data) return <Spinner label={S.endpointLoading} />;
  return (
    <EndpointView
      api={api}
      endpoint={ep.data}
      status={status.data}
      deviceName={nameOf(ep.data.deviceId)}
      initialAction={action}
      onEndpoint={(next) => ep.setData(() => next)}
      onDeleted={() => navigate(OOB_PATH)}
    />
  );
}

// ---- the way in from the Devices list -------------------------------------------------------

/** The Devices list's "Out-of-band management" section: on or off, how many BMCs, and Open. */
export function OobEntry() {
  const api = useOobApi();
  const status = useOobLoad(
    () => (api ? api.getOobStatus() : Promise.resolve(null)),
    'oob-entry',
    (_p, name) => name === 'settings.changed' || name === 'device.oob.endpoint.changed',
  );
  if (!api) return null;
  const s = status.data;
  return (
    <section className="ws-section" aria-labelledby="oob-entry-h">
      <div className="ws-section-header">
        <h2 id="oob-entry-h">{OOB_TEXT.title}</h2>
        <a href={OOB_PATH} onClick={(e) => followLink(e, OOB_PATH)}>
          {S.open}
        </a>
      </div>
      <p className="muted ws-flush">
        {s ? `${s.enabled ? S.stateOn({ n: s.endpoints }) : S.stateOff} ` : ''}
        {S.about}
      </p>
    </section>
  );
}

// ---- a device's "Out-of-band" tab ------------------------------------------------------------

export const OOB_TAB = 'oob';

/**
 * The device page's "Out-of-band" tab: present when a BMC is linked to the device (or the
 * location asks for it), current with the area's events. `active` says whether the location
 * names it: /devices/<id>/oob[/<endpointId>] or `?tab=oob`.
 */
export function useDeviceOobTab(
  deviceId: string,
  deviceName: string,
): { item: TabItem | null; active: boolean } {
  const api = useOobApi();
  const loc = useLocation();
  const where = parseOobLocation(loc);
  const asked =
    where?.deviceId === deviceId ||
    new URLSearchParams(loc.includes('?') ? loc.slice(loc.indexOf('?')) : '').get('tab') ===
      OOB_TAB;
  const list = useOobLoad(
    () => (api ? api.listOobEndpoints().then((r) => r.items) : Promise.resolve([])),
    `oob-links:${deviceId}`,
    (p, name) =>
      name === 'device.oob.endpoint.changed' ||
      name === 'settings.changed' ||
      p.deviceId === deviceId,
  );
  if (!api) return { item: null, active: false };
  const linked = (list.data ?? []).filter((e) => e.deviceId === deviceId);
  if (!linked.length && !asked) return { item: null, active: false };
  return {
    active: asked,
    item: {
      id: OOB_TAB,
      label: S.tab,
      panel: (
        <DeviceOobPanel
          api={api}
          deviceId={deviceId}
          deviceName={deviceName}
          linked={linked}
          loading={list.loading}
          error={list.error}
          retry={list.reload}
          endpointId={where?.deviceId === deviceId ? where.endpointId : null}
          action={where?.deviceId === deviceId ? where.action : null}
        />
      ),
    },
  };
}

/** Navigate to a device's out-of-band tab (from its tab bar). */
export function openDeviceOobTab(deviceId: string): void {
  navigate(deviceOobPath(deviceId), { replace: true });
}

function DeviceOobPanel({
  api,
  deviceId,
  deviceName,
  linked,
  loading,
  error,
  retry,
  endpointId,
  action,
}: {
  api: OobApi;
  deviceId: string;
  deviceName: string;
  linked: OobEndpointView[];
  loading: boolean;
  error: unknown;
  retry: () => void;
  endpointId: string | null;
  action: OobAction | null;
}) {
  const status = useOobStatus(api);
  const [overrides, setOverrides] = useState<Record<string, OobEndpointView>>({});
  if (error && !linked.length)
    return <LoadError error={error} fallback={S.listFailed} onRetry={retry} />;
  if (loading && !linked.length) return <Spinner label={S.listLoading} />;
  const chosen = linked.find((e) => e.id === endpointId) ?? linked[0] ?? null;
  if (!chosen)
    return (
      <div className="stack">
        <p className="muted ws-flush">
          {endpointId ? S.unlinked : S.noneLinked}{' '}
          <a href={OOB_PATH} onClick={(e) => followLink(e, OOB_PATH)}>
            {OOB_TEXT.title}
          </a>
        </p>
      </div>
    );
  const ep = overrides[chosen.id] ?? chosen;
  return (
    <div className="stack">
      <p className="muted ws-flush">
        {S.reachable({ device: deviceName })}{' '}
        <a href={OOB_PATH} onClick={(e) => followLink(e, OOB_PATH)}>
          {S.all}
        </a>
      </p>
      {linked.length > 1 ? (
        <nav aria-label={S.ofDevice} className="row">
          {linked.map((e) => (
            <Button
              key={e.id}
              variant={e.id === ep.id ? 'primary' : 'default'}
              aria-current={e.id === ep.id ? 'true' : undefined}
              onClick={() => navigate(deviceOobPath(deviceId, e.id), { replace: true })}
            >
              {S.choice({ name: e.name, kind: KIND_LABEL[e.kind] })}
            </Button>
          ))}
        </nav>
      ) : null}
      <EndpointView
        key={ep.id}
        api={api}
        endpoint={ep}
        status={status.data}
        deviceName={deviceName}
        initialAction={endpointId === ep.id || !endpointId ? action : null}
        level={2}
        onEndpoint={(next) => setOverrides((o) => ({ ...o, [next.id]: next }))}
        onDeleted={() => navigate(devicePath(deviceId), { replace: true })}
      />
    </div>
  );
}
