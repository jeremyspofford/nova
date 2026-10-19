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

const CHANNEL_TEXT: Record<DeviceUpdateChannel, string> = {
  stable: 'Stable',
  beta: 'Beta',
  nightly: 'Nightly',
};

/** Bundles from the chosen files: one bundle per file, or `{bundles: […]}`. */
export function parseBundleFile(text: string): DeviceUpdateBundle[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('This file is not an update bundle (it is not JSON).');
  }
  const list: unknown[] =
    typeof raw === 'object' && raw !== null && 'bundles' in raw && Array.isArray(raw.bundles)
      ? raw.bundles
      : [raw];
  return list.map((b) => {
    const r = deviceUpdateBundleSchema.safeParse(b);
    if (!r.success) throw new Error('This file is not a signed update bundle.');
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
      toast.show(`Update channel: ${CHANNEL_TEXT[channel as DeviceUpdateChannel]}.`, {
        tone: 'success',
      });
    } catch (err) {
      toast.show(deviceErrorMessage(err, 'Could not change the channel.'), { tone: 'error' });
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
      if (all.length > 10) throw new Error('At most 10 bundles at a time.');
      setBundles(all);
    } catch (err) {
      setFileError(err instanceof Error ? err.message : 'Could not read the file.');
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
        <h2 id={`${base}-ch`}>Channel</h2>
        <SelectField
          className="devices-narrow"
          label="Update channel"
          value={device.updateChannel}
          disabled={channelBusy || revoked}
          onChange={(v) => void setChannel(v)}
          hint="Stable gets tested releases; Beta and Nightly get them earlier."
          options={DEVICE_UPDATE_CHANNELS.map((c) => ({ value: c, label: CHANNEL_TEXT[c] }))}
        />
      </section>

      <AvailableBuild device={device} />

      <section className="ws-section devices-flat" aria-labelledby={`${base}-new`}>
        <h2 id={`${base}-new`}>Install an update</h2>
        {needs.length ? (
          <div className="devices-note" role="status">
            <p className="ws-flush">
              <strong>Update required.</strong> This device has novad{' '}
              {device.novadVersion ?? 'of an unknown version'}. It keeps its other capabilities
              meanwhile.
            </p>
            <ul>
              {needs.map((c) => (
                <li key={c.name}>
                  {CAPABILITY_LABEL[c.name]} needs novad {c.minVersion}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="muted ws-flush">
            {device.novadVersion
              ? `novad ${device.novadVersion} meets every capability’s minimum.`
              : 'The device has not reported its version.'}
          </p>
        )}
        <p className="muted ws-flush">
          Choose signed update bundles for this device. novad checks each signature, applies them in
          order and updates itself last; an update that fails its health check rolls back.
        </p>
        {blocked ? <Unavailable>{blocked}</Unavailable> : null}
        <div className="nv-field">
          <label className="nv-field-label" htmlFor={`${base}-file`}>
            Update bundles (.json)
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
            <h3>Results</h3>
            <UpdateList items={results} label="Results" />
          </div>
        ) : null}
      </section>

      {rollbacks.length ? (
        <section className="ws-section devices-flat" aria-labelledby={`${base}-rb`}>
          <h2 id={`${base}-rb`}>Roll back</h2>
          <ul className="ws-list" aria-label="Modules that can roll back">
            {rollbacks.map((m) => (
              <li key={m.name} className="ws-list-row">
                <span>
                  {moduleLabel(m.name)}: {m.version} → {m.previousVersion}
                </span>
                <Button
                  disabled={Boolean(capabilityBlocked(device, 'services'))}
                  onClick={() => setRollingBack(m)}
                  aria-label={`Roll back ${moduleLabel(m.name)}`}
                >
                  Roll back
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="ws-section devices-flat" aria-labelledby={`${base}-hist`}>
        <h2 id={`${base}-hist`}>History</h2>
        {history.error ? (
          <LoadError
            error={history.error}
            fallback="Could not load the updates."
            onRetry={history.reload}
          />
        ) : null}
        {history.loading ? <Spinner label="Loading updates" /> : null}
        {items?.length === 0 ? <p className="muted ws-flush">No updates yet.</p> : null}
        {items?.length ? <UpdateList items={items} label="Update history" /> : null}
      </section>

      <ConfirmDialog
        open={bundles !== null}
        title={`Install ${bundles?.length === 1 ? 'this update' : `${bundles?.length ?? 0} updates`} on ${device.name}?`}
        description="The device verifies each one before applying it."
        confirmLabel="Install"
        onClose={() => setBundles(null)}
        onConfirm={async () => {
          if (!bundles) return;
          const { items: out } = await api.pushDeviceUpdates(device.id, { bundles });
          setBundles(null);
          setResults(out);
          history.reload();
          reload();
          const ok = out.every((u) => u.status === 'applied' || u.status === 'staged');
          toast.show(ok ? 'Update installed.' : 'Some updates did not apply. See the results.', {
            tone: ok ? 'success' : 'error',
          });
        }}
      >
        <ul className="devices-bundles">
          {(bundles ?? []).map((b, i) => (
            <li key={i}>
              {b.manifest.target === 'novad' ? 'novad' : moduleLabel(b.manifest.target)}{' '}
              {b.manifest.version} · {CHANNEL_TEXT[b.manifest.channel]} ·{' '}
              {formatBytes(b.manifest.size)}
            </li>
          ))}
        </ul>
      </ConfirmDialog>
      <ConfirmDialog
        open={rollingBack !== null}
        title={rollingBack ? `Roll back ${moduleLabel(rollingBack.name)}?` : 'Roll back?'}
        description={
          rollingBack
            ? `It goes back from version ${rollingBack.version} to ${rollingBack.previousVersion ?? 'the previous one'} and restarts.`
            : undefined
        }
        confirmLabel="Roll back"
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
          toast.show(`${moduleLabel(m.name)} is back on version ${module.version}.`, {
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
              <strong>{u.target === 'novad' ? 'novad' : moduleLabel(u.target)}</strong>
              <span>
                {u.fromVersion ? `${u.fromVersion} → ` : ''}
                {u.toVersion}
              </span>
              <span className="ws-badge" data-tone={tone(u.status)}>
                {UPDATE_STATUS_TEXT[u.status] ?? u.status}
              </span>
            </div>
            <span className="muted ws-row-meta">
              <span>{CHANNEL_TEXT[u.channel]}</span>
              <span>{formatWhen(u.createdAt)}</span>
            </span>
            {u.detail ? <span className="muted ws-row-meta">{u.detail}</span> : null}
          </div>
        </li>
      ))}
    </ul>
  );
}
