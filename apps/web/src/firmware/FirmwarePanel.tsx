// A device's Firmware tab (FR-146; docs/23 §6; ADR-042, ADR-096 D3-D4): whether Nova can change
// this machine's firmware settings (or the plain reason it cannot, with the hardware support
// matrix), its platform facts, the allowlisted settings with their values and which are
// read-only, the firmware updates fwupd lists (read-only), and the write-only BIOS admin password.
// With "Allow BIOS/firmware changes" on, the owner plans a change (a dry run with a snapshot; the
// diff marks security-degrading rows), asks for approval on a Hub-only card, applies it (with an
// optional restart guarded by the device's watchdog), and rolls back any applied change behind its
// own approval. With the toggle off, the tab explains what the toggle does and links to it. Every
// change and its watchdog outcome is in the history, with values before and after. Owner-only.
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  FIRMWARE_KEYS,
  type FirmwareChangeInput,
  type FirmwareChangeView,
  type FirmwareHistoryView,
  type FirmwarePolicyView,
  type FirmwareSettingView,
  type FirmwareSupportEntry,
  type FirmwareValue,
} from '@nova/shared';
import { Button, Icon, SelectField, Spinner, TextField, useToast } from '@nova/ui';
import type { PanelProps } from '../devices/DevicePage.tsx';
import { Chip, ConfirmDialog, LoadError, useLoad } from '../devices/parts.tsx';
import { useHubStream } from '../hub-events.ts';
import { useAnnounce } from '../services.tsx';
import { useSetting } from '../settings.tsx';
import { focusMoved, formatWhen, moveItem, useInterval } from '../settings/common.ts';
import { MemberGate } from '../team/role.tsx';
import { useDebounced } from '../work/events.ts';
import { followLink } from '../work/nav.tsx';
import { useFirmwareApi, type FirmwareRead } from './api-m75.ts';
import { ChangeCard } from './FirmwareChange.tsx';
import {
  FIRMWARE_SETTINGS_PATH,
  methodText,
  OPEN_STATUSES,
  firmwareErrorMessage,
  inPlainWords,
  keyLabel,
  sameValue,
  supportReasonText,
  valueText,
  weakensSecurity,
} from './format.ts';
import './firmware.css';

/** The events that change what the tab shows (contracts/events.md). */
export const FIRMWARE_EVENTS = [
  'device.firmware.changed',
  'approval.decided',
  'approval.requested',
  'settings.changed',
] as const;

export function FirmwarePanel(props: PanelProps) {
  return (
    <MemberGate ownerOnly what="Device firmware">
      <FirmwareBody {...props} />
    </MemberGate>
  );
}

function FirmwareBody({ device }: PanelProps) {
  const api = useFirmwareApi();
  const toast = useToast();
  const announce = useAnnounce();
  const base = useId();
  const revoked = device.status === 'revoked';
  const read = useLoad<FirmwareRead | null>(
    () => (revoked ? Promise.resolve(null) : api.readFirmware(device.id)),
    `${device.id}:${revoked}`,
  );
  const history = useLoad<FirmwareHistoryView | null>(
    () => (revoked ? Promise.resolve(null) : api.getFirmwareHistory(device.id)),
    `h:${device.id}:${revoked}`,
  );
  const [refreshing, setRefreshing] = useState(false);
  const [focusApproval, setFocusApproval] = useState(false);
  const [rollingBack, setRollingBack] = useState<FirmwareChangeView | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // The toggle as the settings store has it, until (or when) the device cannot be read.
  const storeOn = useSetting('devices.firmware.allowChanges').value;

  const reloadHistory = useDebounced(history.reload, 150);
  const reloadRead = useDebounced(read.reload, 150);
  useHubStream(FIRMWARE_EVENTS, (env) => {
    if (env.name === 'device.firmware.changed') {
      if (env.payload.deviceId !== device.id) return;
      reloadHistory();
      // An applied, rolled-back or reverted change moved the values on the device.
      if (
        ['applied', 'rolled_back', 'reverted', 'revert_failed'].includes(String(env.payload.status))
      )
        reloadRead();
      return;
    }
    if (env.name === 'settings.changed') {
      const key = typeof env.payload.key === 'string' ? env.payload.key : '';
      if (key.startsWith('devices.firmware.')) reloadRead();
      return;
    }
    reloadHistory();
  });

  const changes = history.data?.changes ?? [];
  const current = changes.find((c) => OPEN_STATUSES.includes(c.status)) ?? null;
  const ticking = changes.some((c) => c.watchdog?.state === 'pending');
  useInterval(() => setNow(Date.now()), 1000, ticking);

  if (revoked) {
    return (
      <section className="ws-section devices-flat" aria-labelledby={`${base}-h`}>
        <h2 id={`${base}-h`}>Firmware</h2>
        <p className="muted ws-flush">This device was revoked: its firmware cannot be read.</p>
      </section>
    );
  }

  const fw = read.data;
  const policy: FirmwarePolicyView | null = fw?.policy ?? null;
  const on = policy ? policy.allowChanges : storeOn;
  const supported = fw?.supported === true;
  // What the device reports now, for a change its watchdog could not revert.
  const held = fw ? Object.fromEntries(fw.settings.map((s) => [s.key, s.value])) : null;
  const snapshotTaken = (id: string | null) =>
    history.data?.snapshots.find((s) => s.id === id)?.takenAt ?? null;

  const refresh = async () => {
    setRefreshing(true);
    try {
      const v = await api.readFirmware(device.id, { fresh: true });
      read.setData(() => v);
      announce('Firmware settings read again.');
    } catch (err) {
      toast.show(firmwareErrorMessage(err, 'Could not read the firmware settings.'), {
        tone: 'error',
      });
    } finally {
      setRefreshing(false);
    }
  };

  const upsert = (c: FirmwareChangeView) =>
    history.setData((h) => ({
      changes: [c, ...(h?.changes ?? []).filter((x) => x.id !== c.id)],
      snapshots: h?.snapshots ?? [],
    }));

  const onChanged = (c: FirmwareChangeView, how: 'asked' | 'applied' | 'other') => {
    upsert(c);
    setFocusApproval(how === 'asked');
    history.reload();
    if (how === 'applied') read.reload();
  };

  return (
    <div className="stack">
      <section className="ws-section devices-flat" aria-labelledby={`${base}-h`}>
        <div className="ws-section-header">
          <h2 id={`${base}-h`}>Firmware</h2>
          <Button onClick={() => void refresh()} disabled={refreshing}>
            {refreshing ? <Spinner /> : <Icon name="refresh" />} Read again
          </Button>
        </div>
        {!on && !read.loading ? <OffNote /> : null}
        {read.error ? (
          <LoadError
            error={read.error}
            fallback="Could not read the firmware settings."
            onRetry={read.reload}
          />
        ) : null}
        {read.loading ? <Spinner label="Reading the firmware settings" /> : null}
        {fw ? <SupportFacts fw={fw} /> : null}
      </section>

      {fw ? (
        <section className="ws-section devices-flat" aria-labelledby={`${base}-s`}>
          <h2 id={`${base}-s`}>Settings</h2>
          <SettingsTable settings={fw.settings} />
        </section>
      ) : null}

      {fw && supported && on ? (
        <PlanForm
          deviceId={device.id}
          deviceName={device.name}
          settings={fw.settings}
          policy={fw.policy}
          onPlanned={(c) => {
            upsert(c);
            history.reload();
            announce('Planned. Check the diff, then ask for approval.');
          }}
        />
      ) : null}

      {current ? (
        <section className="ws-section devices-flat" aria-labelledby={`${base}-c`}>
          <h2 id={`${base}-c`}>Current change</h2>
          <ChangeCard
            change={current}
            device={device}
            policy={policy}
            current
            now={now}
            focusApproval={focusApproval}
            noWatchdog={fw?.adminPasswordSet === true}
            held={held}
            onChanged={onChanged}
            onReload={history.reload}
          />
        </section>
      ) : null}

      {fw ? (
        <BiosPassword
          deviceId={device.id}
          deviceName={device.name}
          machineHasOne={fw.adminPasswordSet}
          stored={fw.adminPasswordStored}
          onStored={(stored) =>
            read.setData((v) => (v ? { ...v, adminPasswordStored: stored } : v))
          }
        />
      ) : null}

      {fw ? (
        <section className="ws-section devices-flat" aria-labelledby={`${base}-u`}>
          <h2 id={`${base}-u`}>Firmware updates</h2>
          <p className="muted ws-flush">
            As listed by fwupd on the device. Nova shows them but does not install firmware updates.
          </p>
          {fw.updates.length ? (
            <ul className="ws-list" aria-label="Firmware updates">
              {fw.updates.map((u, i) => (
                <li key={`${u.device}-${i}`} className="ws-list-row">
                  <span>
                    <strong>{u.device}</strong> {u.version}
                    {u.summary ? <span className="muted"> {u.summary}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="ws-flush">No firmware updates listed.</p>
          )}
        </section>
      ) : null}

      <section className="ws-section devices-flat" aria-labelledby={`${base}-hist`}>
        <h2 id={`${base}-hist`}>History</h2>
        {history.error ? (
          <LoadError
            error={history.error}
            fallback="Could not load the firmware history."
            onRetry={history.reload}
          />
        ) : null}
        {history.loading ? <Spinner label="Loading the history" /> : null}
        {history.data && !changes.length ? (
          <p className="muted ws-flush">No firmware changes yet.</p>
        ) : null}
        {changes.length ? (
          <ul className="fw-list" aria-label="Firmware changes">
            {changes
              .filter((c) => c.id !== current?.id)
              .map((c) => (
                <li key={c.id}>
                  <ChangeCard
                    change={c}
                    device={device}
                    policy={policy}
                    current={false}
                    now={now}
                    snapshotTakenAt={snapshotTaken(c.snapshotId)}
                    held={held}
                    onChanged={onChanged}
                    onReload={history.reload}
                    onRollback={setRollingBack}
                  />
                </li>
              ))}
          </ul>
        ) : null}
      </section>

      <ConfirmDialog
        open={rollingBack !== null}
        title={`Roll back this firmware change on ${device.name}?`}
        description={`Nova plans restoring the settings from before this change${
          rollingBack && snapshotTaken(rollingBack.snapshotId)
            ? ` (its snapshot of ${formatWhen(snapshotTaken(rollingBack.snapshotId))})`
            : ''
        } and asks for your approval on that diff. Nothing changes on ${device.name} until you approve and apply it.`}
        confirmLabel="Plan the rollback"
        onClose={() => setRollingBack(null)}
        onConfirm={async () => {
          if (!rollingBack?.snapshotId) return;
          const view = await inPlainWords(
            api.rollbackFirmwareSnapshot(device.id, rollingBack.snapshotId),
          );
          setRollingBack(null);
          onChanged(view, 'asked');
          announce('Rollback planned. Approve it, then apply it.');
        }}
      >
        {rollingBack ? (
          <ul aria-label="Settings to restore">
            {rollingBack.diff.map((e) => (
              <li key={e.key}>
                {keyLabel(e.key)}: back to {valueText(e.from)}
              </li>
            ))}
          </ul>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}

/** The toggle is off: what it does, and where to turn it on. */
function OffNote() {
  return (
    <div className="ws-callout" role="note">
      <Icon name="shield" />
      <div className="stack">
        <p>
          <strong>BIOS and firmware changes are off.</strong> They are off by default: a wrong
          firmware setting can keep a machine from starting, or weaken its security.
        </p>
        <p>
          Turned on, you can change the settings below on supported machines. Each change is a dry
          run first, shows exactly what will change, keeps a snapshot, needs your approval here in
          Nova, and can be rolled back. Nova never changes firmware by itself. Reading the settings
          works either way.
        </p>
        <p>
          <a href={FIRMWARE_SETTINGS_PATH} onClick={(e) => followLink(e, FIRMWARE_SETTINGS_PATH)}>
            Turn it on in Settings → Devices
          </a>
        </p>
      </div>
    </div>
  );
}

function SupportFacts({ fw }: { fw: FirmwareRead }) {
  const p = fw.platform;
  return (
    <div className="stack">
      <p className="row">
        {fw.supported ? (
          <Chip tone="ready" icon="check" text="Supported" />
        ) : (
          <Chip tone="blocked" icon="stop" text="Not supported" />
        )}
        {fw.supported ? (
          <span className="muted">
            Nova can change the allowlisted settings below
            {fw.support ? ` (${fw.support.label})` : ''}.
          </span>
        ) : (
          <span>{supportReasonText(fw.reason)}</span>
        )}
      </p>
      <SupportMatrix />
      <dl className="devices-facts" aria-label="Platform">
        <div>
          <dt>Machine</dt>
          <dd>{p ? `${p.vendor} ${p.product}`.trim() || 'Unknown' : 'Not reported'}</dd>
        </div>
        <div>
          <dt>Firmware</dt>
          <dd>
            {p
              ? `${p.biosVendor} ${p.biosVersion}`.trim() +
                (p.biosDate ? ` (${p.biosDate})` : '') +
                (p.uefi ? ', UEFI' : ', legacy BIOS')
              : 'Not reported'}
          </dd>
        </div>
        <div>
          <dt>Reached through</dt>
          <dd>
            {methodText(fw.method)}
            {fw.support?.driver ? ` (${fw.support.driver})` : ''}
          </dd>
        </div>
        <div>
          <dt>Read</dt>
          <dd>
            {formatWhen(fw.readAt)}
            {fw.cached ? ' (kept for a minute)' : ''}
          </dd>
        </div>
      </dl>
    </div>
  );
}

/** The hardware support matrix, loaded when opened. */
function SupportMatrix() {
  const api = useFirmwareApi();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<FirmwareSupportEntry[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (!open || items) return;
    let alive = true;
    api.getFirmwareSupport().then(
      (r) => alive && setItems(r.items),
      (err: unknown) => alive && setError(err),
    );
    return () => {
      alive = false;
    };
  }, [api, open, items]);
  return (
    <details onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>Hardware support matrix</summary>
      {error ? (
        <p role="alert">{firmwareErrorMessage(error, 'Could not load the support matrix.')}</p>
      ) : null}
      {open && !items && !error ? <Spinner label="Loading the support matrix" /> : null}
      {items ? (
        <div className="fw-table-wrap">
          <table className="ws-table">
            <caption>Which machines Nova can change firmware settings on (Linux only)</caption>
            <thead>
              <tr>
                <th scope="col">Maker</th>
                <th scope="col">Supported</th>
                <th scope="col">Settings</th>
                <th scope="col">Notes</th>
              </tr>
            </thead>
            <tbody>
              {items.map((e) => (
                <tr key={e.vendor}>
                  <th scope="row">{e.label}</th>
                  <td>{e.supported ? 'Yes' : `No: ${supportReasonText(e.reason)}`}</td>
                  <td>
                    {Object.keys(e.keys).length
                      ? Object.keys(e.keys).map(keyLabel).join(', ')
                      : 'None'}
                  </td>
                  <td>{e.notes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </details>
  );
}

/** Values of a setting that weaken security (the device's list, and the Hub's own rule). */
function degradingOf(s: FirmwareSettingView): string[] {
  const all = new Set(s.securityDegrading);
  for (const v of s.allowed ?? []) if (weakensSecurity(s.key, v, s.securityDegrading)) all.add(v);
  return [...all];
}

function SettingsTable({ settings }: { settings: FirmwareSettingView[] }) {
  if (!settings.length) return <p className="muted ws-flush">The device reports no settings.</p>;
  return (
    <div className="fw-table-wrap">
      <table className="ws-table">
        <caption>The settings Nova may change (an allowlist); it never touches others</caption>
        <thead>
          <tr>
            <th scope="col">Setting</th>
            <th scope="col">Value</th>
            <th scope="col">Can be</th>
            <th scope="col">Notes</th>
          </tr>
        </thead>
        <tbody>
          {settings.map((s) => {
            const bad = degradingOf(s);
            return (
              <tr key={s.key}>
                <th scope="row">
                  {keyLabel(s.key)}
                  <span className="muted ws-row-meta"> {s.vendorKey}</span>
                </th>
                <td>{valueText(s.value)}</td>
                <td>
                  {s.type === 'order'
                    ? 'Any order of the same entries'
                    : s.allowed?.length
                      ? s.allowed.join(', ')
                      : s.type === 'int'
                        ? 'A whole number'
                        : 'Text'}
                </td>
                <td>
                  {s.readOnly ? (
                    <span>
                      <Icon name="stop" /> Read-only
                    </span>
                  ) : null}
                  {bad.length ? (
                    <span className="fw-degrading">
                      <Icon name="alert" /> Weakens security when {bad.join(' or ')}
                    </span>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** The new value chosen for each setting ('' keeps it); the boot order as a list. */
type Choices = Record<string, string>;

function PlanForm({
  deviceId,
  deviceName,
  settings,
  policy,
  onPlanned,
}: {
  deviceId: string;
  deviceName: string;
  settings: FirmwareSettingView[];
  policy: FirmwarePolicyView;
  onPlanned: (c: FirmwareChangeView) => void;
}) {
  const api = useFirmwareApi();
  const base = useId();
  const writable = useMemo(
    () =>
      settings.filter((s) => !s.readOnly && (FIRMWARE_KEYS as readonly string[]).includes(s.key)),
    [settings],
  );
  const [choices, setChoices] = useState<Choices>({});
  const [order, setOrder] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);

  const changes = (): FirmwareChangeInput[] | string => {
    const out: FirmwareChangeInput[] = [];
    for (const s of writable) {
      const key = s.key as FirmwareChangeInput['key'];
      if (s.type === 'order') {
        if (order && !sameValue(order, s.value)) out.push({ key, value: order });
        continue;
      }
      const raw = (choices[s.key] ?? '').trim();
      if (!raw) continue;
      let value: FirmwareValue = raw;
      if (s.type === 'int') {
        if (!/^-?\d+$/.test(raw)) return `${keyLabel(s.key)} must be a whole number.`;
        value = Number(raw);
      }
      if (!sameValue(value, s.value)) out.push({ key, value });
    }
    return out;
  };

  const chosenBad = writable.filter((s) => {
    if (s.type === 'order') return false;
    const raw = (choices[s.key] ?? '').trim();
    return raw !== '' && weakensSecurity(s.key, raw, s.securityDegrading);
  });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const list = changes();
    if (typeof list === 'string' || !list.length) {
      setError(typeof list === 'string' ? list : 'Choose at least one new value.');
      errorRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const c = await api.planFirmware(deviceId, list);
      setChoices({});
      setOrder(null);
      onPlanned(c);
    } catch (err) {
      setError(firmwareErrorMessage(err, 'Could not plan the change.'));
    } finally {
      setBusy(false);
    }
  };

  if (!writable.length)
    return (
      <section className="ws-section devices-flat" aria-labelledby={`${base}-h`}>
        <h2 id={`${base}-h`}>Plan a change</h2>
        <p className="muted ws-flush">Every setting on this machine is read-only.</p>
      </section>
    );

  return (
    <section className="ws-section devices-flat" aria-labelledby={`${base}-h`}>
      <h2 id={`${base}-h`}>Plan a change</h2>
      <p className="muted ws-flush">
        Planning is a dry run: novad works out the diff and keeps a snapshot of the current values.
        Nothing changes on {deviceName} until you approve and apply the plan.
      </p>
      <form className="stack" onSubmit={(e) => void submit(e)} aria-labelledby={`${base}-h`}>
        <div className="fw-plan-grid">
          {writable.map((s) =>
            s.type === 'order' ? (
              <OrderField
                key={s.key}
                setting={s}
                value={order ?? (Array.isArray(s.value) ? s.value : [])}
                onChange={setOrder}
              />
            ) : s.type === 'enum' && s.allowed?.length ? (
              <SelectField
                key={s.key}
                label={keyLabel(s.key)}
                value={choices[s.key] ?? ''}
                onChange={(v) => setChoices((c) => ({ ...c, [s.key]: v }))}
                options={[
                  { value: '', label: `No change (now ${valueText(s.value)})` },
                  ...s.allowed
                    .filter((v) => v !== s.value)
                    .map((v) => ({
                      value: v,
                      label: weakensSecurity(s.key, v, s.securityDegrading)
                        ? `${v} (weakens security)`
                        : v,
                    })),
                ]}
              />
            ) : (
              <TextField
                key={s.key}
                label={keyLabel(s.key)}
                value={choices[s.key] ?? ''}
                inputMode={s.type === 'int' ? 'numeric' : undefined}
                placeholder={valueText(s.value)}
                hint={`Now ${valueText(s.value)}. Leave empty to keep it.`}
                onChange={(e) => setChoices((c) => ({ ...c, [s.key]: e.target.value }))}
              />
            ),
          )}
        </div>
        {chosenBad.length ? (
          <div className="ws-callout" role="note">
            <Icon name="alert" />
            <p>
              <strong>This weakens security:</strong>{' '}
              {chosenBad.map((s) => `${keyLabel(s.key)} ${choices[s.key]}`).join(', ')}. Changes
              like this are blocked unless “Allow changes that weaken security” is on (it is{' '}
              {policy.allowSecurityDegrading ? 'on' : 'off'}).
            </p>
          </div>
        ) : null}
        <div className="row">
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? <Spinner /> : null} Plan the change
          </Button>
        </div>
        {error ? (
          <p role="alert" tabIndex={-1} ref={errorRef} className="nv-field-error">
            {error}
          </p>
        ) : null}
      </form>
    </section>
  );
}

/** The boot order: the same entries, moved up or down (never added or removed). */
function OrderField({
  setting,
  value,
  onChange,
}: {
  setting: FirmwareSettingView;
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const id = useId();
  const listRef = useRef<HTMLOListElement>(null);
  const changed = !sameValue(value, setting.value);
  const move = (i: number, dir: 'up' | 'down') => {
    const entry = value[i];
    if (entry === undefined) return;
    onChange(moveItem(value, i, dir === 'up' ? -1 : 1));
    focusMoved(listRef.current, entry, dir);
  };
  return (
    <fieldset className="ws-fieldset">
      <legend>{keyLabel(setting.key)}</legend>
      <p id={`${id}-hint`} className="nv-field-hint">
        Move entries up or down; the first is tried first. {changed ? 'Changed.' : 'No change.'}
      </p>
      <ol ref={listRef} className="fw-order" aria-describedby={`${id}-hint`}>
        {value.map((entry, i) => (
          <li key={entry} data-move-key={entry}>
            <span>
              {i + 1}. {entry}
            </span>
            <Button
              variant="ghost"
              data-move="up"
              aria-label={`Move ${entry} up`}
              disabled={i === 0}
              onClick={() => move(i, 'up')}
            >
              Up
            </Button>
            <Button
              variant="ghost"
              data-move="down"
              aria-label={`Move ${entry} down`}
              disabled={i === value.length - 1}
              onClick={() => move(i, 'down')}
            >
              Down
            </Button>
          </li>
        ))}
      </ol>
      {changed ? (
        <Button
          variant="ghost"
          onClick={() => onChange(Array.isArray(setting.value) ? setting.value : [])}
        >
          Keep the current order
        </Button>
      ) : null}
    </fieldset>
  );
}

/** The BIOS admin password: written to the Hub's vault, never shown or read back. */
function BiosPassword({
  deviceId,
  deviceName,
  machineHasOne,
  stored,
  onStored,
}: {
  deviceId: string;
  deviceName: string;
  machineHasOne: boolean;
  stored: boolean;
  onStored: (stored: boolean) => void;
}) {
  const api = useFirmwareApi();
  const toast = useToast();
  const base = useId();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.setBiosPassword(deviceId, password);
      setPassword('');
      onStored(r.stored);
      toast.show('BIOS admin password stored.', { tone: 'success' });
    } catch (err) {
      setError(firmwareErrorMessage(err, 'Could not store the password.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="ws-section devices-flat" aria-labelledby={`${base}-h`}>
      <h2 id={`${base}-h`}>BIOS admin password</h2>
      <p className="ws-flush">
        {machineHasOne
          ? `${deviceName} has a BIOS admin password: Nova needs it to apply changes.`
          : `${deviceName} reports no BIOS admin password.`}{' '}
        {stored ? (
          <strong>Stored in the Hub’s vault.</strong>
        ) : machineHasOne ? (
          <strong>Not stored yet.</strong>
        ) : (
          'None stored.'
        )}
      </p>
      <p className="muted ws-flush">
        It is kept in the Hub’s vault, sent to the device only with an approved change, and never
        shown again, here or anywhere.
      </p>
      <form className="row" onSubmit={(e) => void save(e)}>
        <TextField
          label={stored ? 'Replace the BIOS admin password' : 'BIOS admin password'}
          type="password"
          autoComplete="new-password"
          value={password}
          maxLength={256}
          onChange={(e) => setPassword(e.target.value)}
          error={error ?? undefined}
        />
        <Button type="submit" disabled={!password || busy}>
          {busy ? <Spinner /> : null} Store
        </Button>
        {stored ? (
          <Button variant="danger" onClick={() => setClearing(true)}>
            Remove…
          </Button>
        ) : null}
      </form>
      <ConfirmDialog
        open={clearing}
        title={`Remove the BIOS admin password of ${deviceName}?`}
        description={
          machineHasOne
            ? 'Nova forgets it. Changes to this machine are refused until you store it again. The password on the machine itself stays as it is.'
            : 'Nova forgets it. The machine itself is not changed.'
        }
        confirmLabel="Remove"
        danger
        onClose={() => setClearing(false)}
        onConfirm={async () => {
          const r = await inPlainWords(api.clearBiosPassword(deviceId));
          setClearing(false);
          onStored(r.stored);
          toast.show('BIOS admin password removed.', { tone: 'success' });
        }}
      />
    </section>
  );
}
