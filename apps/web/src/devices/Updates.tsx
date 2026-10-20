// Updates (FR-148; docs/23 §8): the device's channel, the novad build this Hub serves for it
// (M7.5, information only), what needs a newer novad, installing signed update bundles (checked
// here, verified again by the device, applied in order with novad last), the result of every
// update, and rolling a module back to its previous version. A failed health check rolls back on
// the device by itself.
import { useId, useRef, useState } from 'react';
import {
  DEVICE_UPDATE_CHANNELS,
  deviceUpdateBundleSchema,
  type DeviceModuleView,
  type DeviceUpdateBundle,
  type DeviceUpdateChannel,
  type DeviceUpdateView,
} from '@nova/shared';
import { Button, SelectField, Spinner, useToast } from '@nova/ui';
import { defineMessages } from '@nova/i18n';
import { formatWhen } from '../settings/common.ts';
import { useDevicesApi } from './api.ts';
import type { PanelProps } from './DevicePage.tsx';
import { useDeviceEvents, eventDeviceId } from './events.ts';
import {
  CAPABILITY_LABEL,
  UPDATE_STATUS_TEXT,
  capabilityBlocked,
  deviceErrorMessage,
  formatBytes,
  moduleLabel,
} from './format.ts';
import { AvailableBuild } from './ops.tsx';
import { ConfirmDialog, LoadError, Unavailable, useLoad } from './parts.tsx';

/** The Updates tab's words (FR-016). */
export const UPDATES_TEXT = defineMessages('devices.updates', {
  channels: {
    stable: 'Stable',
    beta: 'Beta',
    nightly: 'Nightly',
  },
  notJson: 'This file is not an update bundle (it is not JSON).',
  notBundle: 'This file is not a signed update bundle.',
  tooMany: '{n, plural, one {At most # bundle at a time.} other {At most # bundles at a time.}}',
  readFailed: 'Could not read the file.',
  channelSet: 'Update channel: {channel}.',
  channelFailed: 'Could not change the channel.',
  channel: 'Channel',
  channelLabel: 'Update channel',
  channelHelp: 'Stable gets tested releases; Beta and Nightly get them earlier.',
  install: 'Install an update',
  required: 'Update required.',
  has: 'This device has novad {version}. It keeps its other capabilities meanwhile.',
  hasUnknown:
    'This device has novad of an unknown version. It keeps its other capabilities meanwhile.',
  needs: '{capability} needs novad {version}',
  meets: 'novad {version} meets every capability’s minimum.',
  noVersion: 'The device has not reported its version.',
  intro:
    'Choose signed update bundles for this device. novad checks each signature, applies them in order and updates itself last; an update that fails its health check rolls back.',
  bundles: 'Update bundles (.json)',
  results: 'Results',
  rollBack: 'Roll back',
  canRollBack: 'Modules that can roll back',
  rollbackRow: '{module}: {from} → {to}',
  rollBackModule: 'Roll back {module}',
  rollBackTitle: 'Roll back {module}?',
  rollBackBare: 'Roll back?',
  rollBackTo: 'It goes back from version {from} to {to} and restarts.',
  rollBackPrevious: 'It goes back from version {from} to the previous one and restarts.',
  rolledBack: '{module} is back on version {version}.',
  history: 'History',
  historyFailed: 'Could not load the updates.',
  loading: 'Loading updates',
  none: 'No updates yet.',
  historyList: 'Update history',
  installTitle:
    '{n, plural, one {Install this update on {device}?} other {Install # updates on {device}?}}',
  installBody: 'The device verifies each one before applying it.',
  installConfirm: 'Install',
  installed: 'Update installed.',
  someFailed: 'Some updates did not apply. See the results.',
  novad: 'novad',
  bundle: '{target} {version} · {channel} · {size}',
  fromTo: '{from} → {to}',
});

const S = UPDATES_TEXT;

/** What an update is for: novad itself or a module. */
const targetText = (t: string) => (t === 'novad' ? S.novad : moduleLabel(t));

/** Bundles from the chosen files: one bundle per file, or `{bundles: […]}`. */
export function parseBundleFile(text: string): DeviceUpdateBundle[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(S.notJson);
  }
  const list: unknown[] =
    typeof raw === 'object' && raw !== null && 'bundles' in raw && Array.isArray(raw.bundles)
      ? raw.bundles
      : [raw];
  return list.map((b) => {
    const r = deviceUpdateBundleSchema.safeParse(b);
    if (!r.success) throw new Error(S.notBundle);
    return r.data;
  });
}

const tone = (s: DeviceUpdateView['status']) =>
  s === 'applied' ? 'ok' : s === 'staged' || s === 'rolled_back' ? 'warn' : 'bad';

export function UpdatesPanel({ device, onDevice, reload }: PanelProps) {
  const api = useDevicesApi();
  const toast = useToast();
  const base = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const history = useLoad(() => api.listDeviceUpdates(device.id).then((r) => r.items), device.id);
  const [channelBusy, setChannelBusy] = useState(false);
  const [bundles, setBundles] = useState<DeviceUpdateBundle[] | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [results, setResults] = useState<DeviceUpdateView[] | null>(null);
  const [rollingBack, setRollingBack] = useState<DeviceModuleView | null>(null);
  const blocked = capabilityBlocked(device, 'updates');
  const revoked = device.status === 'revoked';
  useDeviceEvents(['device.update.result'], (env) => {
    if (eventDeviceId(env) === device.id) history.reload();
  });

  const setChannel = async (channel: string) => {
    setChannelBusy(true);
    try {
      onDevice(
        await api.updateNovadDevice(device.id, { updateChannel: channel as DeviceUpdateChannel }),
      );
      toast.show(S.channelSet({ channel: S.channels[channel as DeviceUpdateChannel] }), {
        tone: 'success',
      });
    } catch (err) {
      toast.show(deviceErrorMessage(err, S.channelFailed), { tone: 'error' });
    } finally {
      setChannelBusy(false);
    }
  };

  const pick = async (files: FileList | null) => {
    setFileError(null);
    setResults(null);
    if (!files?.length) return;
    try {
      const all: DeviceUpdateBundle[] = [];
      for (const f of Array.from(files)) all.push(...parseBundleFile(await f.text()));
      if (all.length > 10) throw new Error(S.tooMany({ n: 10 }));
      setBundles(all);
    } catch (err) {
      setFileError(err instanceof Error ? err.message : S.readFailed);
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const needs = device.capabilities.filter((c) => c.reason === 'update_required');
  const rollbacks = device.modules.filter((m) => m.previousVersion);
  const items = history.data;

  return (
    <div className="stack">
      <section className="ws-section devices-flat" aria-labelledby={`${base}-ch`}>
        <h2 id={`${base}-ch`}>{S.channel}</h2>
        <SelectField
          className="devices-narrow"
          label={S.channelLabel}
          value={device.updateChannel}
          disabled={channelBusy || revoked}
          onChange={(v) => void setChannel(v)}
          hint={S.channelHelp}
          options={DEVICE_UPDATE_CHANNELS.map((c) => ({ value: c, label: S.channels[c] }))}
        />
      </section>

      <AvailableBuild device={device} />

      <section className="ws-section devices-flat" aria-labelledby={`${base}-new`}>
        <h2 id={`${base}-new`}>{S.install}</h2>
        {needs.length ? (
          <div className="devices-note" role="status">
            <p className="ws-flush">
              <strong>{S.required}</strong>{' '}
              {device.novadVersion ? S.has({ version: device.novadVersion }) : S.hasUnknown}
            </p>
            <ul>
              {needs.map((c) => (
                <li key={c.name}>
                  {S.needs({ capability: CAPABILITY_LABEL[c.name], version: c.minVersion })}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="muted ws-flush">
            {device.novadVersion ? S.meets({ version: device.novadVersion }) : S.noVersion}
          </p>
        )}
        <p className="muted ws-flush">{S.intro}</p>
        {blocked ? <Unavailable>{blocked}</Unavailable> : null}
        <div className="nv-field">
          <label className="nv-field-label" htmlFor={`${base}-file`}>
            {S.bundles}
          </label>
          <input
            ref={fileRef}
            id={`${base}-file`}
            type="file"
            accept=".json,application/json"
            multiple
            disabled={Boolean(blocked)}
            onChange={(e) => void pick(e.target.files)}
          />
        </div>
        {fileError ? (
          <p role="alert" className="nv-field-error">
            {fileError}
          </p>
        ) : null}
        {results ? (
          <div aria-live="polite">
            <h3>{S.results}</h3>
            <UpdateList items={results} label={S.results} />
          </div>
        ) : null}
      </section>

      {rollbacks.length ? (
        <section className="ws-section devices-flat" aria-labelledby={`${base}-rb`}>
          <h2 id={`${base}-rb`}>{S.rollBack}</h2>
          <ul className="ws-list" aria-label={S.canRollBack}>
            {rollbacks.map((m) => (
              <li key={m.name} className="ws-list-row">
                <span>
                  {S.rollbackRow({
                    module: moduleLabel(m.name),
                    from: m.version,
                    to: m.previousVersion ?? '',
                  })}
                </span>
                <Button
                  disabled={Boolean(capabilityBlocked(device, 'services'))}
                  onClick={() => setRollingBack(m)}
                  aria-label={S.rollBackModule({ module: moduleLabel(m.name) })}
                >
                  {S.rollBack}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="ws-section devices-flat" aria-labelledby={`${base}-hist`}>
        <h2 id={`${base}-hist`}>{S.history}</h2>
        {history.error ? (
          <LoadError error={history.error} fallback={S.historyFailed} onRetry={history.reload} />
        ) : null}
        {history.loading ? <Spinner label={S.loading} /> : null}
        {items?.length === 0 ? <p className="muted ws-flush">{S.none}</p> : null}
        {items?.length ? <UpdateList items={items} label={S.historyList} /> : null}
      </section>

      <ConfirmDialog
        open={bundles !== null}
        title={S.installTitle({ n: bundles?.length ?? 0, device: device.name })}
        description={S.installBody}
        confirmLabel={S.installConfirm}
        onClose={() => setBundles(null)}
        onConfirm={async () => {
          if (!bundles) return;
          const { items: out } = await api.pushDeviceUpdates(device.id, { bundles });
          setBundles(null);
          setResults(out);
          history.reload();
          reload();
          const ok = out.every((u) => u.status === 'applied' || u.status === 'staged');
          toast.show(ok ? S.installed : S.someFailed, { tone: ok ? 'success' : 'error' });
        }}
      >
        <ul className="devices-bundles">
          {(bundles ?? []).map((b, i) => (
            <li key={i}>
              {S.bundle({
                target: targetText(b.manifest.target),
                version: b.manifest.version,
                channel: S.channels[b.manifest.channel],
                size: formatBytes(b.manifest.size),
              })}
            </li>
          ))}
        </ul>
      </ConfirmDialog>
      <ConfirmDialog
        open={rollingBack !== null}
        title={
          rollingBack ? S.rollBackTitle({ module: moduleLabel(rollingBack.name) }) : S.rollBackBare
        }
        description={
          rollingBack
            ? rollingBack.previousVersion
              ? S.rollBackTo({ from: rollingBack.version, to: rollingBack.previousVersion })
              : S.rollBackPrevious({ from: rollingBack.version })
            : undefined
        }
        confirmLabel={S.rollBack}
        onClose={() => setRollingBack(null)}
        onConfirm={async () => {
          const m = rollingBack;
          if (!m) return;
          const { module } = await api.deviceModuleAction(device.id, m.name, 'rollback');
          setRollingBack(null);
          onDevice({
            ...device,
            modules: device.modules.map((x) => (x.name === module.name ? module : x)),
          });
          toast.show(S.rolledBack({ module: moduleLabel(m.name), version: module.version }), {
            tone: 'success',
          });
        }}
      />
    </div>
  );
}

function UpdateList({ items, label }: { items: DeviceUpdateView[]; label: string }) {
  return (
    <ul className="ws-list" aria-label={label}>
      {items.map((u) => (
        <li key={u.id} className="ws-list-row devices-update">
          <div className="devices-row-main">
            <div className="devices-row-head">
              <strong>{targetText(u.target)}</strong>
              <span>
                {u.fromVersion ? S.fromTo({ from: u.fromVersion, to: u.toVersion }) : u.toVersion}
              </span>
              <span className="ws-badge" data-tone={tone(u.status)}>
                {UPDATE_STATUS_TEXT[u.status] ?? u.status}
              </span>
            </div>
            <span className="muted ws-row-meta">
              <span>{S.channels[u.channel]}</span>
              <span>{formatWhen(u.createdAt)}</span>
            </span>
            {u.detail ? (
              <span className="muted ws-row-meta" dir="auto">
                {u.detail}
              </span>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}
